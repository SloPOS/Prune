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
