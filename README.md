# bit-cut-studio

Private R&D repo for an AI-assisted video editor focused on **transcript-first editing**.

## Vision

Edit spoken-video content by editing text:
- run speech-to-text on source media
- show transcript + video side-by-side
- delete words/phrases/sections in transcript
- auto-generate timeline cuts from those deletions
- export cut decisions to NLEs (first target: **DaVinci Resolve** interchange)

## MVP (Phase 1)

1. Ingest video/audio
2. Transcribe with word-level timestamps
3. Render editable transcript in a web UI
4. On transcript deletion, compute precise cut list
5. Preview resulting stitched timeline
6. Export edit decision list (JSON + FCPXML/EDL candidate)

## Monorepo plan

- `apps/editor-web` – transcript/video editing UI (React)
- `packages/core` – timeline, transcript diff, cut engine
- `packages/stt` – transcription adapters (Whisper/local/remote)
- `packages/export` – Resolve/NLE interchange exporters
- `docs/` – architecture, product spec, tech decisions

## Run the prototype

Prerequisites:
- Node.js 20+
- ffmpeg + ffprobe in PATH
- Python 3.10+ (for Whisper)

```bash
npm install
npm run dev -w @bit-cut/editor-web
```

Then open the Vite URL. Click transcript words to mark them deleted and inspect generated cut/keep ranges.

## Whisper transcription runner

This repo includes a local Whisper runner (`scripts/transcribe_whisper.py`) plus npm helpers for extracting WAV audio and writing transcript JSON to `data/transcripts/`.

### 1) Install Python dependency

```bash
python3 -m venv .venv
source .venv/bin/activate
npm run transcribe:install
```

### 2) Extract audio only (manual)

```bash
npm run transcribe:extract -- data/source/my-video.mp4 data/audio/my-video.wav
```

### 3) Run Whisper on an existing WAV (manual)

```bash
npm run transcribe:whisper -- data/audio/my-video.wav --out data/transcripts/my-video.json
```

### 4) One-command flow (recommended)

```bash
npm run transcribe:media -- data/source/my-video.mp4
```

This will:
- extract mono 16k WAV to `data/audio/<name>.wav`
- run `scripts/transcribe_whisper.py`
- write transcript JSON to `data/transcripts/<name>.json`

You can optionally override model/runtime settings:

```bash
WHISPER_MODEL=medium WHISPER_LANGUAGE=en npm run transcribe:media -- data/source/my-video.mp4 episode-01
```

Supported env overrides:
- `STT_BACKEND` (default `faster-whisper`; `whisper-cpp`/`openvino` toggle path reserved, not wired yet)
- `WHISPER_MODEL` (default `small`)
- `WHISPER_DEVICE` (default `cpu`)
- `WHISPER_COMPUTE_TYPE` (default `int8`)
- `WHISPER_LANGUAGE` (default `en`)
- `AUDIO_DIR` (default `data/audio`)
- `TRANSCRIPTS_DIR` (default `data/transcripts`)

App filesystem env overrides (`.env`):
- `BITCUT_INBOX_ROOT` (default `<repo>/inbox`)
- `BITCUT_ARCHIVE_ROOT` (default `<repo>/data/archive`)
- `BITCUT_UPLOAD_SUBDIR` (default `incoming/uploads`, under archive root)
- `BITCUT_EXPORT_DIR` (default `<archive>/exports`)

## Media file API (safe listing)

Run:

```bash
npm run media-api
```

Default port: `3199` (`PORT` env var overrides).

Routes:
- `GET /health`
- `GET /api/roots`
- `GET /api/media?root=inbox|archive&dir=<relative>&recursive=0|1&limit=200`
- `POST /api/export/start`
- `GET /api/export/status?jobId=<uuid>`
- `POST /api/export/fcpxml/start`
- `POST /api/export/edl/start`
- `POST /api/export/premiere/start`
- `POST /api/export/after-effects-markers/start`
- `GET /api/export/after-effects-markers/download?jobId=<uuid>`
- `POST /api/export/aaf/start` (build AAF bridge package)
- `GET /api/export/aaf/download?jobId=<uuid>`

Behavior:
- only two configured roots are allowed (`inbox` and `archive`)
- defaults (if env vars are not set):
  - `inbox` => `<repo>/inbox`
  - `archive` => `<repo>/data/archive`
- path traversal is blocked by resolving + validating relative paths
- hidden files/dirs are skipped
- media extension allowlist is enforced
- transcript discovery checks, in order:
  - `<basename>.transcript.json`
  - `<basename>.json`

Export API request body (`POST /api/export/start`):
- `root`: `inbox` or `archive`
- `path`: media file path relative to root
- `outputName`: desired output filename (auto-sanitized, forced to `.mp4`)
- `keepRanges`: array of `{ sourceStartSec, sourceEndSec }` or `{ startSec, endSec }`
- `cuts`: optional fallback; keep ranges are computed if `keepRanges` is missing

Export behavior:
- output directory prefers `BITCUT_EXPORT_DIR` (or `<archive>/exports` by default)
- if that is unavailable, falls back to `data/exports/`
- encoder prefers `h264_qsv` when available and auto-retries with `libx264` on failure
- poll `GET /api/export/status?jobId=...` for status/logs/output path
- After Effects export currently writes a JSON marker scaffold intended for scripting/automation workflows (not direct `.aep` injection)
- AAF export generates a downloadable bridge zip (`*-aaf-bridge.zip`) containing `manifest.json`, `import_aaf.py`, and fallback timeline files (`timeline.fcpxml`, `timeline.edl`, `timeline-premiere.xml`)
- Bridge script creates binary `.aaf` via OpenTimelineIO (`opentimelineio` + `otio-aaf-adapter`), with explicit fallback imports if adapter support is unavailable on a given workstation/NLE build

## AAF bridge validation procedure

1. Export from UI: **Export AAF bridge package**.
2. Confirm browser downloads `*-aaf-bridge.zip`.
3. Unzip and run:
   - `python3 -m pip install opentimelineio otio-aaf-adapter`
   - `python3 import_aaf.py --manifest manifest.json --out timeline.aaf`
4. Import `timeline.aaf` into the target NLE.
5. If your environment cannot write/read AAF, import one of:
   - `timeline.fcpxml` (Resolve/FCP-compatible)
   - `timeline.edl` (CMX3600)
   - `timeline-premiere.xml` (Premiere XML)

## Immediate next steps

See `docs/PHASE-1-PLAN.md`.
