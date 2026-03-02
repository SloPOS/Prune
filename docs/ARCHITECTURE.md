# Architecture (Draft)

## Core pipeline

1. **Media ingest**
   - Input: source media or proxy media
   - Extract audio waveform + metadata
2. **STT + alignment**
   - Generate segment + word-level timestamps
   - Normalized transcript token model
3. **Transcript editor**
   - Rich text view mapped to timed tokens
   - Selection/deletion actions produce operations on token IDs
4. **Cut engine**
   - Convert deleted tokens -> excluded time ranges
   - Merge ranges with configurable padding/fades
   - Compute keep ranges and final timeline map
5. **Preview renderer**
   - Play source with skip map (virtual timeline)
6. **Exporters**
   - JSON EDL (internal canonical)
   - FCPXML/EDL/AAF candidate for Resolve import

## Data model (canonical)

```ts
interface WordToken {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
  confidence?: number;
  speaker?: string;
}

interface CutRange {
  startSec: number;
  endSec: number;
  reason: "deleted-transcript" | "filler-word" | "silence";
}

interface KeepRange {
  sourceStartSec: number;
  sourceEndSec: number;
  outputStartSec: number;
}
```

## Proxy/full-res strategy

- Bind all edits to **source timecode**, not frame index in proxy file.
- Store project metadata:
  - source fps/timebase
  - proxy fps/timebase
  - start timecode offsets
- Export interchange from source timeline mapping.

If proxy and source are frame-accurate transcodes with shared timecode, edits transfer cleanly.
If not, include a calibration step and drift checks.
