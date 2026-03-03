# @prune/editor-web

React + Vite frontend for Prune.

## What this app does

- Loads media from configured server roots or local upload
- Runs Whisper transcription jobs
- Lets users remove transcript words to generate cuts
- Exports media + timeline interchange formats
- Supports desktop and mobile-first editing layouts

## Dev run

From repo root:

```bash
npm run dev -w @prune/editor-web
```

## Build

```bash
npm run build -w @prune/editor-web
```

## UX notes

- Desktop: resizable split view (video left, transcript/tools right)
- Mobile: bottom tab nav (`Media`, `Transcript`, `Tools`, `Export`)
- Transcript tips are collapsible (`ℹ️` toggle)
- Search opens in modal on transcript page
- Tab-scoped modal behavior on mobile (switching tabs hides tab-local popups and restores when returning)
- Settings popup optimized for portrait with boxed path sections and responsive controls
- Render video/audio supports no-transcript workflows (full-range keep fallback for remux/re-encode)

## Export UX behavior

- Sidecar outputs (XML/EDL/JSON/etc) trigger direct download
- Rendered media exports are cached server-side for later retrieval

## Key files

- `src/App.tsx` — main application logic + view state
- `src/styles.css` — shared desktop/mobile styles
- `vite.config.ts` — local API middleware + export/transcribe endpoints
