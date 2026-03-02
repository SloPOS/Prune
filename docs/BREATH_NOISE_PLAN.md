# Breath + Transient Noise Detection Plan (v1 suggest-only)

## Goal
Provide optional candidate cuts for:
- **Breaths** (inhalation-like short events in token gaps)
- **Transient noise clicks** (short high-peak spikes)

v1 is **suggest-only**: no automatic deletion. Users can apply per-item or apply all.

## Current v1 implementation

### UI
- New toggles in editor:
  - Detect breaths
  - Detect transient noise clicks
- `Run detection` button calls backend analysis endpoint.
- Candidate list shows:
  - Type (breath / noise click)
  - timestamp range
  - confidence label
  - reason/heuristic summary
- Each candidate has `Mark as cut` button.
- `Apply all as cuts` performs bulk mark.

### Backend endpoint
- `POST /api/analyze/suggest-cuts`
- Inputs:
  - `root`, `path`
  - `detectBreaths`, `detectNoiseClicks`
  - `tokenGaps` (from transcript token boundaries)
- Processing:
  - Reuses `scripts/extract-audio-wav.sh` for mono 16k PCM WAV extraction to `data/audio/*.analysis.wav`.
  - Parses WAV in-process and runs lightweight heuristics.
- Output:
  - `candidates[]` with `{ id, kind, startSec, endSec, confidence, score, reason }`
  - summary counts by candidate type.

## Heuristics

### Breath candidates
- Evaluated only around transcript token gaps.
- Gap filters: conservative range (`~0.2s` to `1.5s`).
- Windowed RMS scan inside each gap.
- Candidate accepted when:
  - RMS is above local baseline but not extreme (`rmsRatio` bounded)
  - peak is not too high (to avoid plosives/clicks)
- Low-confidence results are dropped.

### Noise click candidates
- Sample-level transient search for high absolute peaks.
- Requires strong local contrast (`peak / localMean` ratio threshold).
- Creates very short candidate windows (~20 ms total), merged if adjacent.
- Low-confidence results are dropped.

## Conservative defaults to reduce false positives
- Both detectors reject low-confidence candidates.
- Breath detector constrained to token gaps only.
- Click detector requires both high peak and high local contrast.
- UI language emphasizes optional/manual use.

## Known limitations
- Heuristics are signal-based only; no ML classifier.
- Breath detections depend on transcript timing quality.
- Click detector can miss low-level clicks after heavy compression/NR.
- No speaker/channel separation; single mono mix only.
- No scene/music awareness.

## Next-step upgrade path
1. Add configurable threshold presets (strict/balanced/aggressive).
2. Add mini waveform preview around each candidate.
3. Add exclude regions / lock segments.
4. Introduce spectral features (band energy, zero-crossing trends).
5. Add tiny ML ranking model for candidate rescoring.
6. Cache analysis artifacts per media hash to avoid repeated scans.
7. Optional auto-apply mode gated behind confidence + user confirmation.
