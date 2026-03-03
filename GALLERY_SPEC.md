# Gallery Feature Spec (Draft)

Status: deferred until after base publish stabilization.

## Entry points
- Desktop: add `Gallery` button to the right of `Clear Project`.
- Mobile: add `Gallery` item in hamburger menu.

## Core behavior
- Open a large modal/popup media library view.
- Show server-side files for:
  - uploaded originals
  - exported videos
  - optional: both together
- Top filter controls:
  - Originals / Exports / Both
  - checkbox: Show all files (not only video)

## Library UI
- Graphical list/grid with clickable thumbnails.
- Each item should display:
  - title / filename
  - upload/modified date
  - duration
- Thumbnail generation:
  - based on video content frame
  - prefer first non-black frame strategy (fallback first frame)
  - optional default capture around 30s for long clips
  - cache thumbnails server-side for performance

## Actions
- Per item:
  - open/load in editor
  - download
  - delete
- Bulk mode:
  - multi-select checkboxes
  - mass delete
  - bulk download (zip or sequential)

## Layout/UX
- Similar structure to existing file picker, but larger and library-first.
- Works on both desktop and mobile.
- Desktop: richer grid.
- Mobile: grid/list toggle with touch-friendly actions.

## Suggested additions (high value)
- Search by filename.
- Sort by date, name, duration, size.
- Pagination/infinite scroll for large libraries.
- "Used by saved project" indicator.
- Clear error/empty/loading states.
- Background thumbnail generation and cache warming.

## Backend notes
- Add gallery API endpoint(s) for listing metadata.
- Add thumbnail endpoint + cache directory (e.g., `/data/thumbs`).
- Reuse safe path validation and delete/download guards from existing APIs.
