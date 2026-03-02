#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
from faster_whisper import WhisperModel


def main():
    p = argparse.ArgumentParser()
    p.add_argument("audio")
    p.add_argument("--model", default="small")
    p.add_argument("--device", default="cpu")
    p.add_argument("--compute-type", default="int8")
    p.add_argument("--language", default="en")
    p.add_argument("--beam-size", type=int, default=1)
    p.add_argument("--vad-filter", action="store_true")
    p.add_argument("--out", required=True)
    args = p.parse_args()

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments, info = model.transcribe(
        args.audio,
        language=args.language,
        word_timestamps=True,
        beam_size=max(1, int(args.beam_size)),
        vad_filter=bool(args.vad_filter),
    )

    tokens = []
    idx = 1
    for seg in segments:
      seg_start = 0.0 if seg.start is None else float(seg.start)
      seg_end = 0.0 if seg.end is None else float(seg.end)
      print(f"[{seg_start:08.3f} -> {seg_end:08.3f}]", flush=True)
      if not seg.words:
        continue
      for w in seg.words:
        if w.start is None or w.end is None:
          continue
        text = (w.word or "").strip()
        if not text:
          continue
        tokens.append({
          "id": f"w-{idx}",
          "text": text,
          "startSec": round(float(w.start), 6),
          "endSec": round(float(w.end), 6),
          "confidence": None if w.probability is None else float(w.probability),
        })
        idx += 1

    payload = {
      "audio": str(Path(args.audio).resolve()),
      "language": info.language,
      "durationSec": float(info.duration),
      "tokens": tokens,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2))
    print(f"wrote {out} ({len(tokens)} tokens)")


if __name__ == "__main__":
    main()
