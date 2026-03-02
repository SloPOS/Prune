# Phase 1 Plan (Transcript Delete -> Timeline Cut)

## Deliverable
A working prototype where deleting transcript text removes matching video sections and updates preview.

## Milestones

### M1 — STT + tokenization
- Pick primary STT engine (Whisper variant)
- Ensure word-level timestamps
- Persist transcript tokens as JSON

### M2 — Web editor foundation
- React app with split pane (video + transcript)
- Token-level selection/deletion
- Undo/redo support

### M3 — Cut engine
- Convert deleted token IDs to cut ranges
- Merge adjacent ranges, add configurable handles (e.g. ±80ms)
- Generate keep ranges and output timeline map

### M4 — Playback preview
- Render cut preview by seeking across keep ranges
- Show before/after duration + cut count

### M5 — Export
- Internal JSON export
- First Resolve-compatible interchange attempt (likely FCPXML)
- Round-trip test in DaVinci Resolve

## Risks
- STT timing drift on low-quality audio
- Hard cuts may sound abrupt without smart boundary treatment
- Resolve interchange nuances (format compatibility)
