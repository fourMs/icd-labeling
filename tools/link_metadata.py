#!/usr/bin/env python3
"""Link the ICD recordings on the drive to rows of the metadata sheet.

Recordings are named  YYYYMMDD_<mic>_<City>_<Place>[n].WAV  (Microphone 3
files end in .wav.WAV). Each file is matched to the metadata row with the same
date and microphone; when a day has several recordings with one microphone,
the place in the file name is compared with the row's location and
description. Numbered places (Bedroom1, Bedroom2, ...) are assigned in
Database ID order, which follows recording time.

Everything is read from and written to the drive; nothing local is used.
The tool logs in like the helper (SSH key/agent, or password + one-time code
in the terminal), then:

  reads   icd-metadata.csv in the dataset folder (the sheet; any "File",
          "Match" and "Recorder clock" columns from an earlier run are
          recomputed),
  lists   every WAV in the dataset folder's sub-folders (not annotations/),
          with the BWF origination date/time the recorder wrote into it
          (its own clock, which stayed on Oslo time abroad),
  writes  icd-metadata.csv back with those three columns filled in, plus a
          row for any recording without metadata. The version it replaces is
          kept as icd-metadata.previous.csv.

Without --write it only reports what it would change.

Usage:
  python3 tools/link_metadata.py --user <uio-username>           # dry run
  python3 tools/link_metadata.py --user <uio-username> --write   # update the drive
"""

import argparse
import csv
import difflib
import io
import posixpath
import re
import socket
import stat
import struct
import sys
import unicodedata
import uuid
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bridge"))
import paramiko  # noqa: E402  (installed for the helper)
from sftp_bridge import (  # noqa: E402
    ANNOTATIONS_DIR, AUDIO_EXTENSIONS, DEFAULT_REMOTE, METADATA_FILE, Remote, parse_remote,
)

LINK_COLUMNS = ["File", "Match", "Recorder clock"]
ORPHAN = "no metadata row found"
PREVIOUS_FILE = "icd-metadata.previous.csv"

FILE_RE = re.compile(r"^(?P<date>\d{8})_(?P<mic>\d+)_(?P<city>[^_]+)_(?P<place>.+?)(?:\.wav)?\.wav$", re.I)


def norm(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return text.lower()


def words(text):
    """CamelCase and punctuation split, lower-cased: 'CoffeeShop' -> ['coffee', 'shop']."""
    text = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", text)
    return [w for w in re.split(r"[^a-z0-9]+", norm(text)) if len(w) > 1]


def similar(word, vocabulary):
    """Typo-tolerant membership ('coffeee' ~ 'coffee', 'restaurent' ~ 'restaurant')."""
    return any(word == v or (len(word) > 3 and difflib.SequenceMatcher(None, word, v).ratio() >= 0.8) for v in vocabulary)


def parse_file(path):
    name = path.rsplit("/", 1)[-1]
    m = FILE_RE.match(name)
    if not m:
        return None
    place = m["place"]
    index = re.search(r"(\d+)$", place)
    return {
        "path": path,
        "date": m["date"],
        "mic": str(int(m["mic"])),
        "city": m["city"],
        "place": place[: index.start()] if index else place,
        "index": int(index[1]) if index else None,
    }


def row_key(row):
    d = re.match(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", row["Date"].strip())
    mic = re.match(r"M?(\d+)", row["Microphone ID"].strip(), re.I)
    if not d or not mic:
        return None
    day, month, year = d.groups()
    return f"{year}{int(month):02d}{int(day):02d}", str(int(mic[1]))


def score(f, row):
    """How well a file's place name fits a row: location counts double."""
    place = words(f["place"])
    location = words(row["Location"])
    context = words(" ".join([row["City"], row["Description"], row["Interior sound sources"]]))
    return sum(2 if similar(w, location) else 1 if similar(w, context) else 0 for w in place)


def match_group(files, rows):
    """Pair files and rows recorded on one day with one microphone."""
    pairs = []
    files, rows = list(files), sorted(rows, key=lambda r: int(r["Database ID"]))
    if len(files) == 1 and len(rows) == 1:
        f, r = files[0], rows[0]
        how = "date+mic" if score(f, r) else "date+mic (place name differs)"
        return [(f, r, how)], [], []

    used_f, used_r = set(), set()

    # Unnumbered places first, best place score first, so that e.g.
    # "TrainStation" claims the station row before "Train1..3" are placed.
    options = sorted(
        ((score(f, r), f, r) for f in files if f["index"] is None for r in rows),
        key=lambda o: (-o[0], int(o[2]["Database ID"])),
    )
    for s, f, r in options:
        if s > 0 and id(f) not in used_f and id(r) not in used_r:
            pairs.append((f, r, "date+mic+place"))
            used_f.add(id(f))
            used_r.add(id(r))

    # Numbered places: the n-th remaining fitting row in recording order.
    numbered = defaultdict(list)
    for f in files:
        if f["index"] is not None:
            numbered[f["place"]].append(f)
    for group in numbered.values():
        candidates = [r for r in rows if id(r) not in used_r and score(group[0], r) > 0]
        for f in sorted(group, key=lambda f: f["index"]):
            if f["index"] <= len(candidates):
                r = candidates[f["index"] - 1]
                pairs.append((f, r, f"date+mic+place, #{f['index']} in recording order"))
                used_f.add(id(f))
        used_r.update(id(p[1]) for p in pairs)
    left_f = [f for f in files if id(f) not in used_f]
    left_r = [r for r in rows if id(r) not in used_r]
    if len(left_f) == 1 and len(left_r) == 1:
        pairs.append((left_f[0], left_r[0], "date+mic (only one left)"))
        left_f, left_r = [], []
    return pairs, left_f, left_r


# --------------------------------------------------------------------------
# Drive access
# --------------------------------------------------------------------------


def bext_timestamp(sftp, path):
    """The recorder's own origination date/time from a WAV's BWF bext chunk."""
    with sftp.open(path, "rb") as fh:
        head = fh.read(65536)
    pos = 12
    while pos + 8 <= len(head):
        cid, size = head[pos:pos + 4], struct.unpack("<I", head[pos + 4:pos + 8])[0]
        if cid == b"bext" and pos + 8 + 338 <= len(head):
            raw = head[pos + 8 + 320:pos + 8 + 338].decode("ascii", "replace")
            date, time = raw[:10], raw[10:].replace("-", ":").replace(".", ":")
            return f"{date} {time}".strip()
        if cid == b"data":
            break
        pos += 8 + size + (size & 1)
    return ""


def list_recordings(sftp, root):
    """Relative paths of the WAVs in the dataset folder and its sub-folders."""
    paths = []
    for entry in sftp.listdir_attr(root):
        name = entry.filename
        if name.startswith("."):
            continue
        if stat.S_ISDIR(entry.st_mode or 0):
            if name == ANNOTATIONS_DIR:
                continue
            for sub in sftp.listdir(posixpath.join(root, name)):
                if not sub.startswith(".") and posixpath.splitext(sub)[1].lower() in AUDIO_EXTENSIONS:
                    paths.append(f"{name}/{sub}")
        elif posixpath.splitext(name)[1].lower() in AUDIO_EXTENSIONS:
            paths.append(name)
    return sorted(paths)


def write_sheet(sftp, root, text):
    """Replace icd-metadata.csv atomically, keeping the old one as the previous version."""
    target = posixpath.join(root, METADATA_FILE)
    tmp = posixpath.join(root, f".{METADATA_FILE}.{uuid.uuid4().hex[:8]}.tmp")
    with sftp.open(tmp, "wb") as fh:
        fh.write(text.encode("utf-8"))
    sftp.chmod(tmp, 0o660)  # group-shared, like the rest of the dataset
    try:
        sftp.stat(target)
        sftp.posix_rename(target, posixpath.join(root, PREVIOUS_FILE))
    except FileNotFoundError:
        pass
    sftp.posix_rename(tmp, target)


# --------------------------------------------------------------------------
# Linking
# --------------------------------------------------------------------------


def link(sheet_text, paths, recorded):
    """The sheet with File/Match/Recorder clock filled in, plus a summary."""
    reader = csv.DictReader(io.StringIO(sheet_text))
    columns = [c for c in reader.fieldnames if c.strip() and c not in LINK_COLUMNS]
    rows, kept = [], []
    for r in reader:
        r = {c: (r.get(c) or "").strip() for c in reader.fieldnames if c}
        if r.get("Database ID"):
            rows.append(r)
        elif r.get("Match") != ORPHAN and any(r.get(c) for c in columns):
            kept.append(r)  # someone's row without an ID: keep it as it is

    files, orphan_files = [], []
    for path in paths:
        f = parse_file(path)
        (files if f else orphan_files).append(f or path)

    groups = defaultdict(lambda: ([], []))
    for f in files:
        groups[(f["date"], f["mic"])][0].append(f)
    for r in rows:
        groups[row_key(r)][1].append(r)

    linked = {}
    for gfiles, grows in groups.values():
        pairs, left_f, _ = match_group(gfiles, grows)
        for f, r, how in pairs:
            linked[r["Database ID"]] = (f["path"], how)
        orphan_files += [f["path"] for f in left_f]

    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=["Database ID", *LINK_COLUMNS] + [c for c in columns if c != "Database ID"],
                       extrasaction="ignore", lineterminator="\n")
    w.writeheader()
    changed = []
    for r in rows:
        path, how = linked.get(r["Database ID"], ("", "no recording found"))
        if r.get("File", "") != path:
            changed.append((r["Database ID"], r.get("File", ""), path))
        w.writerow({**r, "File": path, "Match": how, "Recorder clock": recorded.get(path, "")})
    for r in kept:
        w.writerow(r)
    for path in orphan_files:
        w.writerow({"File": path, "Match": ORPHAN, "Recorder clock": recorded.get(path, "")})
    return out.getvalue(), rows, linked, orphan_files, kept, changed


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("remote", nargs="?", type=parse_remote, default=parse_remote(DEFAULT_REMOTE),
                   help=f"[user@]host:/path/to/dataset (default {DEFAULT_REMOTE})")
    p.add_argument("-u", "--user", help="username on the SSH server")
    p.add_argument("--ssh-port", type=int, help="SSH port (default from ~/.ssh/config, else 22)")
    p.add_argument("-i", "--identity", help="SSH private key file")
    p.add_argument("--write", action="store_true", help=f"update {METADATA_FILE} on the drive (default: dry run)")
    args = p.parse_args(argv)

    user, host, root = args.remote
    remote = Remote(host, root, user=user or args.user, port=args.ssh_port, identity=args.identity)
    print(f"Connecting to {remote.hostname}:{remote.port} as {remote.user}...")
    try:
        remote.connect()
    except (paramiko.SSHException, socket.error) as exc:
        sys.exit(f"Could not connect: {exc}")

    with remote.sftp() as sftp:
        try:
            with sftp.open(posixpath.join(remote.root, METADATA_FILE), "rb") as fh:
                sheet = fh.read().decode("utf-8-sig")
        except FileNotFoundError:
            sys.exit(f"No {METADATA_FILE} in {remote.root}")
        paths = list_recordings(sftp, remote.root)
        print(f"Reading recorder timestamps from {len(paths)} recordings...")
        recorded = {path: bext_timestamp(sftp, posixpath.join(remote.root, path)) for path in paths}

        text, rows, linked, orphan_files, kept, changed = link(sheet, paths, recorded)
        print(f"{len(linked)} of {len(paths)} recordings linked to {len(rows)} metadata rows")
        for r in rows:
            if r["Database ID"] not in linked:
                print(f"  row {r['Database ID']:>3} ({r['Microphone ID']} {r['Date']} {r['City']}, {r['Location']}): no recording")
        for path in orphan_files:
            print(f"  {path}: no metadata row")
        if kept:
            print(f"  {len(kept)} row(s) without a Database ID kept unchanged")
        for row_id, old, new in changed:
            print(f"  row {row_id:>3}: File {old or '(none)'} -> {new or '(none)'}")

        if list(csv.reader(io.StringIO(text))) == list(csv.reader(io.StringIO(sheet))):
            print(f"{METADATA_FILE} is already up to date.")
        elif args.write:
            write_sheet(sftp, remote.root, text)
            print(f"Updated {METADATA_FILE} on the drive (previous version: {PREVIOUS_FILE}).")
        else:
            print(f"Dry run: {METADATA_FILE} would change. Run again with --write to update it.")


if __name__ == "__main__":
    sys.exit(main())
