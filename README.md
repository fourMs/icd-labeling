# ICD Labelling

A small website for listening to the first-order ambisonic (FOA) recordings of
the Intercontinental Database (ICD) on the RITMO drive and writing notes about them.

- **Site** (`site/`): static, hosted on GitHub Pages at
  <https://fourms.github.io/icd-labeling/>. It renders FOA (AmbiX: ACN order,
  SN3D) to binaural in real time with [Omnitone](https://github.com/GoogleChrome/omnitone),
  lets you turn your head with a dial, and shows where the sound energy comes from.
  Recordings (~11 min, ~380 MB each) are streamed in 2-second blocks, so playback
  starts right away and seeking is instant.
- **Helper** (`bridge/sftp_bridge.py`): browsers can't speak SFTP, so each
  labeller runs this on their own computer. It logs in to `login.uio.no` over
  SSH and gives the site access to the dataset folder through `127.0.0.1` only.

After connecting, choose a mode:

- **Annotate**: listen without context and write notes. Recordings appear only
  as "Recording #<sheet ID>", with a play button, a progress bar and volume.
  No file names, places, metadata, photos or spatial displays are shown.
- **Browse**: every recording with its metadata row, its photo (the image with
  the same name next to the WAV), a level overview, the head-turn dial and a
  direction-of-arrival meter. Notes are shown read-only.

Notes are saved on the drive in the `annotations` folder next to the
Microphone folders, one sub-folder per annotator, one markdown file per
recording (`clip.WAV` and `clip.wav.WAV` → `clip.md`):

```
Intercontinental Database/
  Microphone 1/20230617_1_Doha_FoodCourt.WAV
  annotations/
    jinyueg/20230617_1_Doha_FoodCourt.md
    ada/20230617_1_Doha_FoodCourt.md
```

```markdown
---
audio: "Microphone 1/20230617_1_Doha_FoodCourt.WAV"
id: 3
annotator: "jinyueg"
updated: 2026-11-03T10:05:21.426Z
---

Free-text notes from the annotator.
```

The annotator name defaults to the UiO login name. It can be changed in the
top bar (letters, digits, `.`, `_`, `-`), and it becomes the folder name. In
Annotate mode each annotator only sees and edits their own notes; Browse mode
shows everyone's.

## For labellers

1. Download `sftp_bridge.py` from the site (or this repo) and install its one dependency:

   ```bash
   pip install paramiko
   ```

2. Start it:

   ```bash
   python3 sftp_bridge.py --user your-uio-username
   ```

   It connects to `login.uio.no` and opens the ICD folder
   (`…/lh-div-ritmo/Research/Project/AMBIENT/Datasets/Intercontinental Database`).
   It asks for the Microsoft Authenticator approval or one-time code and your
   password in the terminal (or uses your SSH key/agent), then opens the site
   already connected. Keep the terminal open while you label.

3. Choose **Annotate**, pick a recording, listen on headphones, and write
   notes. Your UiO username is filled in as the annotator name.

| Key | Action |
| --- | --- |
| <kbd>Space</kbd> | Play / pause |
| <kbd>←</kbd> <kbd>→</kbd> | Seek 5 s |
| <kbd>Ctrl/⌘</kbd>+<kbd>S</kbd> | Save note |
| <kbd>Ctrl/⌘</kbd>+<kbd>Enter</kbd> | Save note and open the next file |

Unsaved notes are saved automatically when you switch recordings. If your note
for a recording was changed from another window while you had it open, you're
asked whether to replace it or merge the two texts.

**Browser:** use Chrome, Edge or Firefox. The first time, Chrome may ask to let
the site "access other apps and services on this device". Allow it, because
that's how the page reaches the helper.

Other folders or servers: `python3 sftp_bridge.py user@host:/path/to/folder`.
Hosts from `~/.ssh/config` work, including `ProxyCommand`.

## Metadata

The metadata sheet lives on the drive, in the dataset folder next to the
Microphone folders and `annotations/`:

```
Intercontinental Database/icd-metadata.csv
```

The site always reads it from there: the helper fetches it fresh on every
request, and the page re-reads it (with the recording list and annotations)
each time a mode is chosen, so edits on the drive show up on the next mode
switch. There is no local copy or override.

The sheet carries three columns that link each row to its recording: `File`
(path of the WAV), `Match` (how it was matched) and `Recorder clock` (the
date/time the recorder wrote into the WAV; the recorders kept Oslo time
abroad). [`tools/link_metadata.py`](tools/link_metadata.py) fills them in. It
works directly on the drive: it reads `icd-metadata.csv` and the WAVs there,
matches every WAV to its row by date and microphone, then by place name, and
writes the result back to the same file. Nothing is read from or written to
this computer.

```bash
python3 tools/link_metadata.py --user your-uio-username           # dry run: report only
python3 tools/link_metadata.py --user your-uio-username --write   # update icd-metadata.csv on the drive
```

Run it after adding recordings or rows. Edits to the other columns are kept,
and the version it replaces is saved as `icd-metadata.previous.csv`. The
metadata stays on the drive and is never part of the public Pages site.

## How it fits together

```
GitHub Pages site ──HTTP (token, origin-checked)──▶ sftp_bridge.py on 127.0.0.1:8765 ──SFTP──▶ login.uio.no
```

- New annotator folders are created group-readable and -writable (`2770`),
  and notes `660`, so the project group can read everyone's annotations.
- The helper only listens on `127.0.0.1`. It accepts requests only from the
  Pages origin (or `localhost`), and only with the random session token that it
  puts in the link it opens.
- Paths are resolved inside the dataset folder; nothing outside it can be read.
- The recordings, photos and Microphone folders are read-only to the helper.
  Every write goes through one guard (`WriteGuard`) that only allows plain
  files and folders inside `annotations/`, and refuses to write through
  symlinks, so nothing can be added to or changed in a Microphone folder.
- Notes are written to a temporary file and renamed into place, so a dropped
  connection never leaves a half-written note.

## Development

Run the site locally, served by the helper itself:

```bash
python3 bridge/sftp_bridge.py --serve site --user your-uio-username
```

The site is plain HTML/CSS/ES modules with no build step. Pushing to `main`
deploys it through `.github/workflows/pages.yml`. In the repo settings, set
**Pages → Source** to **GitHub Actions**.
