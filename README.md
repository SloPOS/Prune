# Prune

<p align="center">
  <img src="docs/screenshots/prune-logo.jpg" alt="Prune logo" width="220" />
</p>

<p align="center"><strong>Rough cuts at the speed of text.</strong></p>
<p align="center">Designed by <strong>FauxRhino</strong> · Contact: <a href="mailto:Faux@fauxrhino.com">Faux@fauxrhino.com</a></p>

Transcript-first video editing for self-hosted workflows.

Prune lets you edit spoken content by editing words: remove words/phrases in transcript, generate precise timeline cuts, preview quickly, then export to media + NLE interchange formats.

---

## Screenshots

### Desktop editor
![Prune desktop editor](docs/screenshots/desktop-main.png)

### Mobile layout
![Prune mobile layout](docs/screenshots/mobile-home.png)

---

## Core features

- **Transcript-first editing**
  - click words to remove/restore
  - drag-range multi-select on desktop
  - range mode on mobile
- **Whisper STT built in**
  - preset modes (Fast / Balanced / Quality)
  - background progress + ETA
  - transcript auto-load after completion
- **Project persistence**
  - save/load/delete named project states
  - restores transcript + deleted tokens + trim settings
- **Smart cleanup & cut helpers**
  - fixed-phrase cleanup
  - word-gap shortener
  - suggest-only breath/noise detection
- **Cross-platform file flow**
  - server-side folder picker
  - local upload support
  - dedicated transcripts/projects/export directories
- **Responsive UI**
  - desktop split-pane editor
  - mobile tabbed layout (Media / Transcript / Tools / Export)
  - mobile tab-scoped popups (switch tabs without losing modal state)
  - mobile portrait-optimized settings cards + controls
- **Render without transcript**
  - video/audio render now supports full-range remux/re-encode workflows even when no transcript is loaded

---

## Export formats

### Media
- Edited video/audio render (`.mp4`)

### Interchange
- Resolve/FCPXML (`.fcpxml`)
- CMX3600 EDL (`.edl`)
- Premiere XML (`.xml`)
- After Effects markers JSON (`.json`)
- AAF bridge package (`.zip`) with OTIO conversion script + fallback timelines

### Subtitle/script
- `.srt`, `.vtt`, script `.txt`

---

## Download/cache behavior

- **Small sidecar exports** (XML/EDL/JSON/etc): immediate browser download, then server copy is removed.
- **Rendered media exports**: remain cached on server and respect configured retention window.

---

## Quick start

### Prereqs
- Node.js 20+
- ffmpeg + ffprobe in PATH
- Python 3.10+

### Install + run

```bash
npm install
npm run dev -w @prune/editor-web
```

Open the local Vite URL shown in terminal.

---

## Validation suites

Run export-focused automated checks:

```bash
npm run test:exports
npm run test:interop
```

These validate timeline parity/continuity across export formats and contract checks for download behavior.

---

## Project docs

- `docs/ARCHITECTURE.md`
- `docs/PHASE-1-PLAN.md`
- `docs/STT_BACKEND_DECISION.md`
- `docs/BREATH_NOISE_PLAN.md`
