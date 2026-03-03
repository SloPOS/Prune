# @bit-cut/export

Draft exporters for NLE interchange formats.

## FCPXML v1 exporter (Resolve draft)

`exportFcpxmlV1(...)` builds a minimal FCPXML document that DaVinci Resolve can import as a rough cut timeline.

### API

```ts
import { exportFcpxmlV1 } from "@bit-cut/export";

const xml = exportFcpxmlV1(
  [
    { sourceStartSec: 0, sourceEndSec: 5, outputStartSec: 0 },
    { sourceStartSec: 8, sourceEndSec: 12.5, outputStartSec: 5 },
  ],
  {
    path: "/media/interview-a.mov",
    fps: 24,
    timecode: "01:00:00:00",
  },
  {
    projectName: "Interview Cut v1",
    eventName: "bit-cut-studio",
  },
);
```

### Inputs

- **keep ranges**: source in/out and stitched output offset
- **source metadata**:
  - `fps`
  - `timecode` (`HH:MM:SS:FF`, non-drop)
  - `path` (filesystem path or `file://` URL)
  - optional `durationSec`, `name`

### Notes / constraints

- This is intentionally a **minimal Resolve-importable draft** (single source media, single sequence, spine of `asset-clip`s).
- Timecode parsing is currently non-drop-frame.
- If `durationSec` is omitted, media duration is inferred from the max `sourceEndSec` in keep ranges.
- Common NTSC rates (`23.976`, `29.97`, `59.94`) are emitted as exact `1001`-based rational rates.

### Fixture

See `fixtures/fcpxml-v1-sample.fcpxml` for a reference output.

## Automated export validation (no NLE required)

You can verify exporter behavior with fixture-driven checks (no Resolve/Premiere install needed):

```bash
npm --workspace packages/export run validate:fixtures
npm --workspace packages/export run test:interop
# or from repo root
npm run test:exports
npm run test:interop
```

What this validates:

- keep-range boundary mapping in FCPXML (`offset`, `start`, `duration`)
- output continuity between stitched ranges (record out == next record in)
- frame/timecode formatting for EDL and frameDuration/tcStart formatting in FCPXML
- Premiere XML clip in/out/start/end frame mapping (when `exportPremiereXml` exists)

Fixture files live in `packages/export/fixtures/validation/*.json`.
If you change exporter logic, update/add fixtures to lock in expected behavior.

## Premiere XML exporter (xmeml)

`exportPremiereXml(...)` builds a Premiere-friendly XML (`xmeml` v5 style) timeline with a single source file and stitched clip items.

### API

```ts
import { exportPremiereXml } from "@bit-cut/export";

const xml = exportPremiereXml(
  [
    { sourceStartSec: 0, sourceEndSec: 5, outputStartSec: 0 },
    { sourceStartSec: 8, sourceEndSec: 12.5, outputStartSec: 5 },
  ],
  {
    path: "/media/interview-a.mov",
    fps: 24,
    timecode: "01:00:00:00",
  },
  {
    projectName: "Interview Cut v1",
    sequenceName: "Interview Cut v1",
  },
);
```

### Notes

- Uses `keepRanges` with explicit `outputStartSec` to preserve timeline stitching.
- Emits frame-based values using rounded integer fps.
- Produces a minimal sequence + master clip + file block for import workflows.

### Fixture

See `fixtures/premiere-xml-sample.xml` and `fixtures/premiere-xml-sample-input.json`.
