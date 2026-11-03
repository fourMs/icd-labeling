#!/usr/bin/env python3
"""Local bridge between the ICD labelling site and an SFTP drive.

Browsers cannot speak SFTP, so each labeller runs this helper on their own
machine. It logs in over SSH with the labeller's own keys (or a password typed
into this terminal), and exposes a tiny HTTP API on 127.0.0.1 that only the
labelling site may use:

    GET  /api/info                 -> which remote folder is served, and the login name
    GET  /api/list?dir=<rel>       -> sub-folders and audio files in a folder
    GET  /api/audio?path=<rel>     -> bytes of one audio file (HTTP Range supported)
    POST /api/readv?path=<rel>     -> many small byte ranges of one file at once
    GET  /api/metadata             -> the dataset's metadata sheet (icd-metadata.csv on the drive)
    GET  /api/photo?path=<rel>     -> the photo with the same name as an audio file
    GET  /api/annotations          -> which recordings each annotator has notes for
    GET  /api/notes?path=<rel>     -> every annotator's note for one audio file
    GET  /api/note?path=<rel>&annotator=<name>  -> one annotator's note
    PUT  /api/note?path=<rel>&annotator=<name>  -> write it (with conflict check)

Notes live in <dataset>/annotations/<annotator>/<recording name>.md, one
folder per annotator; the annotator name defaults to the SSH login name.
The helper never creates, changes or removes anything outside annotations/:
the recordings, photos and Microphone folders are read-only to it, and every
write goes through WriteGuard, which enforces that.

Every API call must carry the random token printed at startup, and requests
from any origin other than the labelling site are refused.

Usage:
    pip install paramiko
    python3 sftp_bridge.py                  # ICD on the RITMO drive (login.uio.no)
    python3 sftp_bridge.py --user <name>    # skip the username question
    python3 sftp_bridge.py user@host:/path/to/dataset

Requires Python 3.9+ and paramiko.
"""

from __future__ import annotations

import argparse
import getpass
import hmac
import json
import mimetypes
import posixpath
import queue
import re
import secrets
import socket
import stat
import sys
import threading
import uuid
import webbrowser
from contextlib import contextmanager
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

try:
    import paramiko
except ImportError:  # pragma: no cover - friendly message for labellers
    sys.exit("This helper needs paramiko. Install it with:  pip install paramiko")

DEFAULT_SITE = "https://fourms.github.io/icd-labeling/"
DEFAULT_REMOTE = (
    "login.uio.no:/net/hypatia/uio/fs01/lh-div-ritmo/Research/Project/AMBIENT/Datasets/Intercontinental Database"
)
DEFAULT_PORT = 8765
AUDIO_EXTENSIONS = {".wav"}
NOTE_EXTENSION = ".md"
ANNOTATIONS_DIR = "annotations"  # next to the Microphone folders
ANNOTATOR_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
MAX_PHOTO_BYTES = 30 << 20
METADATA_FILE = "icd-metadata.csv"  # in the dataset root, read fresh on every request
MAX_NOTE_BYTES = 1_000_000
MAX_READV_BYTES = 64 << 20
MAX_READV_RANGES = 4096
CHUNK = 1 << 20


# --------------------------------------------------------------------------
# SSH / SFTP connection
# --------------------------------------------------------------------------


class AskHostKeyPolicy(paramiko.MissingHostKeyPolicy):
    """Like `ssh`: show the fingerprint of an unknown host and ask once."""

    def missing_host_key(self, client, hostname, key):
        fingerprint = key.fingerprint if hasattr(key, "fingerprint") else key.get_base64()
        print(f"\nThe authenticity of host '{hostname}' can't be established.")
        print(f"{key.get_name()} key fingerprint is {fingerprint}.")
        answer = input("Are you sure you want to continue connecting (yes/no)? ").strip().lower()
        if answer not in ("y", "yes"):
            raise paramiko.SSHException(f"Host key for {hostname} rejected")
        client.get_host_keys().add(hostname, key.get_name(), key)
        known_hosts = Path.home() / ".ssh" / "known_hosts"
        try:
            known_hosts.parent.mkdir(mode=0o700, exist_ok=True)
            with known_hosts.open("a") as fh:
                fh.write(f"{hostname} {key.get_name()} {key.get_base64()}\n")
            print(f"Added '{hostname}' to {known_hosts}.")
        except OSError as exc:
            print(f"(Could not save host key: {exc})")


class Remote:
    """One SSH transport shared by all requests. SFTP channels are pooled:
    each request borrows one for itself, so concurrent reads and note saves
    don't interfere, and reopening a channel per request is avoided."""

    def __init__(self, host, root, user=None, port=None, identity=None):
        cfg = self._ssh_config(host)
        self.alias = host
        self.hostname = cfg.get("hostname", host)
        self.user = user or cfg.get("user") or self._ask_user(host)
        self.port = int(port or cfg.get("port", 22))
        self.identity = [identity] if identity else cfg.get("identityfile")
        self.proxy_command = cfg.get("proxycommand")
        self.root = posixpath.normpath(root) if root else "."
        self._passphrase = None
        self._client = None
        self._idle = queue.SimpleQueue()
        self._lock = threading.RLock()  # connect() opens SFTP channels too

    @staticmethod
    def _ask_user(host):
        local = getpass.getuser()
        return input(f"Username on {host} [{local}]: ").strip() or local

    def _login_interactive(self, transport):
        """Password and/or one-time code typed into this terminal. Covers
        servers that require two-factor login (e.g. UiO)."""

        def answer(title, instructions, prompts):
            for line in (title, instructions):
                if line and line.strip():
                    print(line.strip())
            return [input(p) if echo else getpass.getpass(p) for p, echo in prompts]

        # Two-factor push approval plus typing a password easily takes longer
        # than paramiko's default 30 s.
        transport.auth_timeout = 300
        banner = transport.get_banner()
        if banner:
            print(banner.decode("utf-8", errors="replace").rstrip())
        print(f"Logging in to {self.hostname} as {self.user}.")
        for _ in range(3):
            if not transport.is_active():
                break
            try:
                transport.auth_interactive(self.user, answer)
            except paramiko.BadAuthenticationType as exc:
                if "password" not in exc.allowed_types:
                    raise
                transport.auth_password(self.user, getpass.getpass("Password: "))
            except paramiko.AuthenticationException as exc:
                print(f"Login failed: {exc}")
            if transport.is_authenticated():
                return
        raise paramiko.AuthenticationException(f"Could not log in to {self.hostname}")

    @staticmethod
    def _ssh_config(host):
        path = Path.home() / ".ssh" / "config"
        if not path.exists():
            return {}
        return paramiko.SSHConfig.from_path(str(path)).lookup(host)

    @property
    def label(self):
        return f"{self.user}@{self.alias}:{self.root}"

    def connect(self):
        client = paramiko.SSHClient()
        client.load_system_host_keys()
        client.set_missing_host_key_policy(AskHostKeyPolicy())
        sock = paramiko.ProxyCommand(self.proxy_command) if self.proxy_command else None
        try:
            # SSH keys and ssh-agent first, without prompting for anything.
            client.connect(
                self.hostname,
                port=self.port,
                username=self.user,
                passphrase=self._passphrase,
                key_filename=self.identity,
                allow_agent=True,
                look_for_keys=True,
                sock=sock,
                timeout=15,
            )
        except paramiko.PasswordRequiredException:
            self._passphrase = getpass.getpass("Passphrase for your SSH key: ")
            return self.connect()
        except paramiko.SSHException:
            transport = client.get_transport()
            if transport is None or not transport.is_active() or transport.is_authenticated():
                raise
            self._login_interactive(transport)
        client.get_transport().set_keepalive(30)
        self._client = client

        if self.root == ".":
            with self.sftp() as sftp:
                self.root = sftp.normalize(".")
        else:
            with self.sftp() as sftp:
                self.root = sftp.normalize(self.root)
                if not stat.S_ISDIR(sftp.stat(self.root).st_mode):
                    raise SystemExit(f"{self.root} is not a directory on {self.hostname}")

    def _open_sftp(self):
        with self._lock:
            transport = self._client.get_transport() if self._client else None
            if transport is None or not transport.is_active():
                print("SSH connection lost, reconnecting...")
                self.connect()
                transport = self._client.get_transport()
        return paramiko.SFTPClient.from_transport(transport)

    @contextmanager
    def sftp(self):
        client = None
        while client is None:
            try:
                client = self._idle.get_nowait()
                if client.get_channel().closed:
                    client = None
            except queue.Empty:
                client = self._open_sftp()
        try:
            yield client
        except BaseException:
            client.close()  # might be mid-transfer; don't reuse it
            raise
        self._idle.put(client)

    def resolve(self, rel):
        """Map a client-supplied relative path to an absolute remote path,
        refusing anything that would escape the dataset root."""
        rel = (rel or "").replace("\\", "/").lstrip("/")
        full = posixpath.normpath(posixpath.join(self.root, rel))
        root = self.root.rstrip("/") or "/"
        if full != root and not full.startswith(root.rstrip("/") + "/"):
            raise PermissionError("Path escapes the dataset root")
        return full


def audio_stem(name):
    """'clip.WAV' -> 'clip'; also 'clip.wav.WAV' -> 'clip' (Microphone 3 files)."""
    stem = posixpath.splitext(name)[0]
    return stem[:-4] if stem.lower().endswith(".wav") else stem


class WriteGuard:
    """The only way the helper writes to the drive. Every target must be a
    plain file or folder inside the annotations folder, reached without
    symlinks, so nothing can be added to or changed in the Microphone
    folders, whatever the request or the state of the drive."""

    def __init__(self, sftp, dataset_root):
        self.sftp = sftp
        self.root = posixpath.join(dataset_root, ANNOTATIONS_DIR)

    def _check(self, path, allow_root=False):
        path = posixpath.normpath(path)
        if not (path.startswith(self.root + "/") or (allow_root and path == self.root)):
            raise PermissionError("The helper only writes inside the annotations folder")
        # Every existing step from annotations/ down must be a real folder or
        # file, not a symlink that could lead into a Microphone folder.
        rel = posixpath.relpath(path, self.root)
        parts = [] if rel == "." else rel.split("/")
        steps = [self.root] + [posixpath.join(self.root, *parts[: i + 1]) for i in range(len(parts))]
        for step in steps:
            try:
                st = self.sftp.lstat(step)
            except FileNotFoundError:
                break
            if stat.S_ISLNK(st.st_mode or 0):
                raise PermissionError(f"Refusing to write through a symlink: {step}")
            if step != path and not stat.S_ISDIR(st.st_mode or 0):
                raise PermissionError(f"Not a folder: {step}")
        return path

    def mkdir(self, path):
        self.sftp.mkdir(self._check(path, allow_root=True))
        self.sftp.chmod(path, 0o2770)  # group-shared, like the dataset folders

    def write_atomic(self, path, data):
        """Write via a temporary file and a rename, so readers never see half a note."""
        path = self._check(path)
        tmp = self._check(posixpath.join(posixpath.dirname(path), f".{posixpath.basename(path)}.{uuid.uuid4().hex[:8]}.tmp"))
        with self.sftp.open(tmp, "wb") as fh:
            fh.write(data)
        self.sftp.chmod(tmp, 0o660)  # readable by the project group, whatever the umask
        try:
            self.sftp.posix_rename(tmp, path)
        except (IOError, paramiko.SSHException):
            # Server without the posix-rename extension.
            try:
                self.sftp.remove(self._check(path))
            except FileNotFoundError:
                pass
            self.sftp.rename(tmp, path)


def rel_is_root(rel):
    return posixpath.normpath((rel or "").strip("/") or ".") == "."


def valid_annotator(name):
    return bool(name) and ANNOTATOR_RE.fullmatch(name) is not None


# --------------------------------------------------------------------------
# HTTP API
# --------------------------------------------------------------------------


class ApiError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.payload = {"error": message, **extra}


class Handler(BaseHTTPRequestHandler):
    server_version = "ICDLabelBridge/1"
    # Set on the class by main().
    remote: Remote
    token: str
    allowed_origins: set
    site_dir: Path | None

    # -- plumbing ----------------------------------------------------------

    def log_message(self, fmt, *args):  # keep the terminal quiet
        if self.server.verbose:
            super().log_message(fmt, *args)

    def _origin_allowed(self, origin):
        if not origin:
            return True  # not a cross-origin browser request
        if origin in self.allowed_origins:
            return True
        parts = urlsplit(origin)
        return parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1")

    def _cors_headers(self):
        origin = self.headers.get("Origin")
        if origin and self._origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range")
            self.send_header("Vary", "Origin")

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _query(self):
        q = parse_qs(urlsplit(self.path).query)
        return {k: v[0] for k, v in q.items()}

    def _check_auth(self):
        if not self._origin_allowed(self.headers.get("Origin")):
            raise ApiError(HTTPStatus.FORBIDDEN, "Origin not allowed")
        auth = self.headers.get("Authorization", "")
        supplied = auth[7:] if auth.startswith("Bearer ") else ""
        if not hmac.compare_digest(supplied.encode(), self.token.encode()):
            raise ApiError(HTTPStatus.UNAUTHORIZED, "Missing or wrong token")

    def _dispatch(self, routes):
        route = urlsplit(self.path).path
        if not route.startswith("/api/"):
            if self.command == "GET" and self.site_dir:
                return self._serve_static(route)
            return self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
        handler = routes.get(route)
        try:
            if handler is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Unknown endpoint")
            self._check_auth()
            handler()
        except ApiError as exc:
            self._send_json(exc.status, exc.payload)
        except PermissionError as exc:
            self._send_json(HTTPStatus.FORBIDDEN, {"error": str(exc)})
        except FileNotFoundError:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "No such file"})
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser went away mid-download
        except Exception as exc:  # report, keep serving
            print(f"Error handling {self.command} {self.path}: {exc!r}")
            try:
                self._send_json(HTTPStatus.BAD_GATEWAY, {"error": str(exc) or type(exc).__name__})
            except OSError:
                pass

    def do_OPTIONS(self):
        origin = self.headers.get("Origin")
        if not self._origin_allowed(origin):
            self.send_response(HTTPStatus.FORBIDDEN)
            self.end_headers()
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Range")
        # Chrome's Private/Local Network Access: allow a public page to reach us.
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        self._dispatch({
            "/api/info": self.api_info,
            "/api/list": self.api_list,
            "/api/audio": self.api_audio,
            "/api/note": self.api_note_get,
            "/api/notes": self.api_notes,
            "/api/annotations": self.api_annotations,
            "/api/metadata": self.api_metadata,
            "/api/photo": self.api_photo,
        })

    def do_PUT(self):
        self._dispatch({"/api/note": self.api_note_put})

    def do_POST(self):
        self._dispatch({"/api/readv": self.api_readv})

    def _serve_static(self, route):
        rel = route.lstrip("/") or "index.html"
        path = (self.site_dir / rel).resolve()
        if path.is_dir():
            path = path / "index.html"
        inside = path == self.site_dir or self.site_dir in path.parents
        if not inside or not path.is_file():
            return self._send_json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
        body = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # -- endpoints ---------------------------------------------------------

    def api_info(self):
        self._send_json(HTTPStatus.OK, {"remote": self.remote.label, "user": self.remote.user, "version": 2})

    def api_list(self):
        rel = self._query().get("dir", "")
        full = self.remote.resolve(rel)
        with self.remote.sftp() as sftp:
            attrs = sftp.listdir_attr(full)
        entries = []
        for a in attrs:
            if a.filename.startswith("."):
                continue
            if stat.S_ISDIR(a.st_mode or 0):
                if not (rel_is_root(rel) and a.filename == ANNOTATIONS_DIR):
                    entries.append({"name": a.filename, "type": "dir"})
                continue
            if posixpath.splitext(a.filename)[1].lower() in AUDIO_EXTENSIONS:
                entries.append({"name": a.filename, "type": "audio", "size": a.st_size})
        entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
        rel_norm = posixpath.relpath(full, self.remote.root)
        self._send_json(HTTPStatus.OK, {"dir": "" if rel_norm == "." else rel_norm, "entries": entries})

    def _audio_path(self):
        full = self.remote.resolve(self._query().get("path", ""))
        if posixpath.splitext(full)[1].lower() not in AUDIO_EXTENSIONS:
            raise ApiError(HTTPStatus.BAD_REQUEST, "Not an audio file")
        return full

    def api_audio(self):
        full = self._audio_path()
        with self.remote.sftp() as sftp:
            size = sftp.stat(full).st_size
            start, end = 0, size - 1
            ranged = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
            if ranged and ranged.group(1):
                start = int(ranged.group(1))
                if ranged.group(2):
                    end = min(int(ranged.group(2)), size - 1)
            elif ranged and ranged.group(2):  # suffix range: last N bytes
                start = max(0, size - int(ranged.group(2)))
            if start > end:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self._cors_headers()
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            length = end - start + 1
            with sftp.open(full, "rb") as fh:
                self.send_response(HTTPStatus.PARTIAL_CONTENT if ranged else HTTPStatus.OK)
                self._cors_headers()
                self.send_header("Content-Type", mimetypes.guess_type(full)[0] or "application/octet-stream")
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                if ranged:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                # readv pipelines the SFTP requests instead of one round trip per 32 KB.
                blocks = [(off, min(CHUNK, end + 1 - off)) for off in range(start, end + 1, CHUNK)]
                for data in fh.readv(blocks):
                    self.wfile.write(data)

    def api_readv(self):
        """Many small ranges of one file in one round trip, concatenated in
        request order. Body: {"ranges": [[offset, length], ...]}."""
        full = self._audio_path()
        length = int(self.headers.get("Content-Length") or 0)
        try:
            ranges = [(int(o), int(n)) for o, n in json.loads(self.rfile.read(length))["ranges"]]
        except (ValueError, KeyError, TypeError):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Expected JSON {ranges: [[offset, length], ...]}")
        total = sum(n for _, n in ranges)
        if len(ranges) > MAX_READV_RANGES or total > MAX_READV_BYTES or any(o < 0 or n <= 0 for o, n in ranges):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Too many or invalid ranges")
        with self.remote.sftp() as sftp:
            size = sftp.stat(full).st_size
            if any(o + n > size for o, n in ranges):
                raise ApiError(HTTPStatus.BAD_REQUEST, "Range past end of file")
            with sftp.open(full, "rb") as fh:
                data = b"".join(fh.readv(ranges))
        self.send_response(HTTPStatus.OK)
        self._cors_headers()
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def api_metadata(self):
        with self.remote.sftp() as sftp:
            try:
                with sftp.open(posixpath.join(self.remote.root, METADATA_FILE), "rb") as fh:
                    text = fh.read().decode("utf-8-sig", errors="replace")
            except FileNotFoundError:
                raise ApiError(HTTPStatus.NOT_FOUND, f"No {METADATA_FILE} in the dataset folder")
        body = text.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self._cors_headers()
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def api_photo(self):
        full = self._audio_path()
        directory, name = posixpath.split(full)
        stem = audio_stem(name).lower()
        with self.remote.sftp() as sftp:
            # Names may differ in case only (e.g. "_cafe.WAV" / "_Cafe.jpeg").
            match = next(
                (n for n in sorted(sftp.listdir(directory))
                 if posixpath.splitext(n)[1].lower() in IMAGE_TYPES and posixpath.splitext(n)[0].lower() == stem),
                None,
            )
            if match is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "No photo for this recording")
            path = posixpath.join(directory, match)
            size = sftp.stat(path).st_size
            if size > MAX_PHOTO_BYTES:
                raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Photo too large")
            with sftp.open(path, "rb") as fh:
                fh.prefetch(size)
                data = fh.read()
        self.send_response(HTTPStatus.OK)
        self._cors_headers()
        self.send_header("Content-Type", IMAGE_TYPES[posixpath.splitext(match)[1].lower()])
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=3600")
        self.end_headers()
        self.wfile.write(data)

    # -- notes -------------------------------------------------------------

    @property
    def _annotations_root(self):
        return posixpath.join(self.remote.root, ANNOTATIONS_DIR)

    def _annotator(self):
        name = self._query().get("annotator", "")
        if not valid_annotator(name):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Annotator names use letters, digits, '.', '_' and '-'")
        return name

    def _note_name(self):
        return audio_stem(posixpath.basename(self._audio_path())) + NOTE_EXTENSION

    def _annotators(self, sftp):
        try:
            attrs = sftp.listdir_attr(self._annotations_root)
        except FileNotFoundError:
            return []
        return sorted(a.filename for a in attrs if stat.S_ISDIR(a.st_mode or 0) and valid_annotator(a.filename))

    @staticmethod
    def _read_note(sftp, path):
        try:
            st = sftp.stat(path)
        except FileNotFoundError:
            return None, None
        with sftp.open(path, "rb") as fh:
            return fh.read().decode("utf-8", errors="replace"), st.st_mtime

    def api_annotations(self):
        result = {}
        with self.remote.sftp() as sftp:
            for name in self._annotators(sftp):
                files = sftp.listdir(posixpath.join(self._annotations_root, name))
                result[name] = sorted(f[: -len(NOTE_EXTENSION)] for f in files
                                      if f.endswith(NOTE_EXTENSION) and not f.startswith("."))
        self._send_json(HTTPStatus.OK, {"annotators": result})

    def api_notes(self):
        note = self._note_name()
        notes = []
        with self.remote.sftp() as sftp:
            for name in self._annotators(sftp):
                text, mtime = self._read_note(sftp, posixpath.join(self._annotations_root, name, note))
                if text is not None:
                    notes.append({"annotator": name, "text": text, "mtime": mtime})
        self._send_json(HTTPStatus.OK, {"notes": notes})

    def api_note_get(self):
        path = posixpath.join(self._annotations_root, self._annotator(), self._note_name())
        with self.remote.sftp() as sftp:
            text, mtime = self._read_note(sftp, path)
        self._send_json(HTTPStatus.OK, {"exists": text is not None, "text": text or "", "mtime": mtime})

    def api_note_put(self):
        annotator = self._annotator()
        folder = posixpath.join(self._annotations_root, annotator)
        path = posixpath.join(folder, self._note_name())
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_NOTE_BYTES:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Note too large")
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            text = body["text"]
            base_mtime = body.get("base_mtime")
        except (ValueError, KeyError, TypeError):
            raise ApiError(HTTPStatus.BAD_REQUEST, "Expected JSON {text, base_mtime}")
        if not isinstance(text, str):
            raise ApiError(HTTPStatus.BAD_REQUEST, "text must be a string")

        with self.remote.sftp() as sftp:
            guard = WriteGuard(sftp, self.remote.root)
            for directory in (self._annotations_root, folder):
                try:
                    sftp.stat(directory)
                except FileNotFoundError:
                    guard.mkdir(directory)
                    print(f"Created {posixpath.relpath(directory, self.remote.root)}/")
            current, mtime = self._read_note(sftp, path)
            # Saved from elsewhere (e.g. another tab) since this note was opened.
            if current is not None and base_mtime != mtime and current != text:
                raise ApiError(HTTPStatus.CONFLICT, "Note changed on the drive", text=current, mtime=mtime)
            guard.write_atomic(path, text.encode("utf-8"))
            new_mtime = sftp.stat(path).st_mtime
        print(f"Saved {posixpath.relpath(path, self.remote.root)}")
        self._send_json(HTTPStatus.OK, {"mtime": new_mtime})


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def parse_remote(spec):
    if ":" not in spec:
        raise argparse.ArgumentTypeError("expected [user@]host:/path/to/dataset")
    host, path = spec.split(":", 1)
    user = None
    if "@" in host:
        user, host = host.rsplit("@", 1)
    return user, host, path


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument(
        "remote",
        nargs="?",
        type=parse_remote,
        default=parse_remote(DEFAULT_REMOTE),
        help=f"[user@]host:/path/to/dataset (default {DEFAULT_REMOTE}; hosts from ~/.ssh/config work)",
    )
    p.add_argument("-u", "--user", help="username on the SSH server (default: asked, or from ~/.ssh/config)")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"local HTTP port (default {DEFAULT_PORT})")
    p.add_argument("--ssh-port", type=int, help="SSH port (default from ~/.ssh/config, else 22)")
    p.add_argument("-i", "--identity", help="SSH private key file")
    p.add_argument("--site", default=DEFAULT_SITE, help=f"labelling site URL (default {DEFAULT_SITE})")
    p.add_argument("--serve", metavar="DIR", help="also serve the site from this folder (offline / development)")
    p.add_argument("--no-browser", action="store_true", help="don't open the site automatically")
    p.add_argument("-v", "--verbose", action="store_true", help="log every HTTP request")
    args = p.parse_args(argv)

    user, host, root = args.remote
    user = user or args.user
    remote = Remote(host, root, user=user, port=args.ssh_port, identity=args.identity)
    print(f"Connecting to {remote.hostname}:{remote.port} as {remote.user}...")
    try:
        remote.connect()
    except (paramiko.SSHException, socket.error) as exc:
        sys.exit(f"Could not connect: {exc}")
    print(f"Connected. Serving {remote.label}")

    site_origin = "{0.scheme}://{0.netloc}".format(urlsplit(args.site))
    Handler.remote = remote
    Handler.token = secrets.token_urlsafe(24)
    Handler.allowed_origins = {site_origin}
    Handler.site_dir = Path(args.serve).resolve() if args.serve else None

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        sys.exit(f"Could not listen on 127.0.0.1:{args.port} ({exc}). Is the helper already running? Try --port.")
    server.daemon_threads = True
    server.verbose = args.verbose

    bridge = f"http://127.0.0.1:{args.port}"
    site = bridge + "/" if Handler.site_dir else args.site
    url = f"{site}#bridge={quote(bridge, safe='')}&token={Handler.token}"
    print("\nOpen the labelling site with this link (it contains your session key):\n")
    print(f"    {url}\n")
    print("Keep this window open while labelling. Press Ctrl+C to stop.")
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
