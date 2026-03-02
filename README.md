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

## Immediate next steps

See `docs/PHASE-1-PLAN.md` and open issues in GitHub.
