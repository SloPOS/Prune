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
- `WHISPER_MODEL` (default `small`)
- `WHISPER_DEVICE` (default `cpu`)
- `WHISPER_COMPUTE_TYPE` (default `int8`)
- `WHISPER_LANGUAGE` (default `en`)
- `AUDIO_DIR` (default `data/audio`)
- `TRANSCRIPTS_DIR` (default `data/transcripts`)

## Immediate next steps

See `docs/PHASE-1-PLAN.md`.
