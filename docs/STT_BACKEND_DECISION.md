# STT Backend Decision (Intel i7-8700, CPU-only)

## TL;DR
**Recommendation: stay on `faster-whisper` CPU (`int8`) as the default backend for now.**

Reason: it already meets realtime+ throughput on this host, is integrated, and gives word-level timestamps in the schema we need. Moving to `whisper.cpp`/OpenVINO is possible, but not yet clearly worth migration risk for current phase.

---

## Host + test context
- CPU: Intel Core i7-8700 (6C/12T)
- Runtime: CPU only (no CUDA)
- Test audio: `data/audio/fr-end-of-year-2025.wav`
- Audio duration: **755.264s** (~12m35s)
- Command path: existing `scripts/transcribe_whisper.py`

## Measured baseline (`faster-whisper`, CPU/int8)

| Model | Elapsed (s) | Audio (s) | RTF (lower better) | Speed (x realtime) |
|---|---:|---:|---:|---:|
| tiny | 38.327 | 755.264 | 0.051 | 19.71x |
| base | 65.801 | 755.264 | 0.087 | 11.48x |

Notes:
- `small` run was started but not completed in this session (model pull/runtime delay).
- Even `base` is comfortably faster than realtime on this CPU.

---

## Practicality assessment

### 1) Stay on `faster-whisper` CPU
**Pros**
- Already integrated in repo (`scripts/transcribe_whisper.py` + runner shell script).
- Word timestamps available and already normalized to current JSON format.
- Strong throughput on i7-8700 with `int8`.
- Lowest migration cost and lowest break risk.

**Cons**
- Python + CTranslate2 dependency surface.
- Could still be slower than optimized `whisper.cpp` in some edge setups.

### 2) Move to `whisper.cpp`
**Pros**
- Excellent CPU inference efficiency potential.
- Single-binary operational model once set up.

**Risks / costs now**
- Need adapter to guarantee **word-level timestamps** mapped to current token schema.
- CLI output compatibility and option set vary by build/version.
- Requires migration/test harness before safe default switch.

### 3) Move to OpenVINO path
**Pros**
- Can improve Intel CPU inference in some deployments.

**Risks / costs now**
- Additional runtime/tooling complexity.
- Requires separate integration + compatibility testing for word timestamps/schema parity.
- No proof yet in this repo that net gain beats existing `faster-whisper` path enough to justify churn.

---

## Decision
For this host and current project stage:
1. **Keep `faster-whisper` as production/default backend.**
2. Add backend toggle plumbing in scripts now (safe/no-break), but keep non-default backends disabled until adapter parity + benchmark proof are done.
3. Revisit migration only after apples-to-apples benchmark suite exists.

---

## Benchmark runbook commands

### Current baseline (`faster-whisper`)
```bash
# tiny
.venv/bin/python scripts/transcribe_whisper.py data/audio/fr-end-of-year-2025.wav \
  --model tiny --device cpu --compute-type int8 --language en --out /tmp/stt-bench/tiny.json

# base
.venv/bin/python scripts/transcribe_whisper.py data/audio/fr-end-of-year-2025.wav \
  --model base --device cpu --compute-type int8 --language en --out /tmp/stt-bench/base.json
```

### Candidate `whisper.cpp` benchmark (when ready)
```bash
# Example only: update paths/options for your build
whisper-cli -m /path/to/ggml-base.en.bin -f data/audio/fr-end-of-year-2025.wav \
  -oj -of /tmp/stt-bench/whispercpp-base
```

### Candidate OpenVINO benchmark (when ready)
```bash
# Example only: run once OpenVINO STT path is integrated
# (either dedicated whisper/openvino runner or validated wrapper)
```

Use same audio input and compute:
- elapsed wall clock
- RTF = elapsed / audio_duration
- schema parity checks (token count, timestamp sanity, JSON compatibility)

---

## Migration plan (if later justified)
1. **Adapter first:** implement `whisper.cpp` -> current transcript JSON with word-level tokens.
2. **Parity tests:** compare token/timestamp validity against current `faster-whisper` outputs.
3. **Benchmark gate:** require >=20% speedup at equal or acceptable transcript quality.
4. **Gradual rollout:** keep `STT_BACKEND=faster-whisper` default; opt-in alternate backend via env.
5. **Switch default only after 3-5 real media files pass quality + stability checks.**
