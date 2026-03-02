#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <input-media> [name]" >&2
  echo "  input-media: source video/audio file" >&2
  echo "  name: optional output base name (defaults to input file name without extension)" >&2
  echo "" >&2
  echo "Env overrides:" >&2
  echo "  WHISPER_MODEL (default: small)" >&2
  echo "  WHISPER_DEVICE (default: cpu)" >&2
  echo "  WHISPER_COMPUTE_TYPE (default: int8)" >&2
  echo "  WHISPER_LANGUAGE (default: en)" >&2
  echo "  AUDIO_DIR (default: data/audio)" >&2
  echo "  TRANSCRIPTS_DIR (default: data/transcripts)" >&2
  exit 1
fi

IN_MEDIA="$1"
NAME="${2:-$(basename "${IN_MEDIA%.*}")}"

AUDIO_DIR="${AUDIO_DIR:-data/audio}"
TRANSCRIPTS_DIR="${TRANSCRIPTS_DIR:-data/transcripts}"

MODEL="${WHISPER_MODEL:-small}"
DEVICE="${WHISPER_DEVICE:-cpu}"
COMPUTE_TYPE="${WHISPER_COMPUTE_TYPE:-int8}"
LANGUAGE="${WHISPER_LANGUAGE:-en}"

mkdir -p "$AUDIO_DIR" "$TRANSCRIPTS_DIR"

WAV_OUT="$AUDIO_DIR/$NAME.wav"
JSON_OUT="$TRANSCRIPTS_DIR/$NAME.json"

echo "[1/2] Extracting mono 16k WAV -> $WAV_OUT"
bash scripts/extract-audio-wav.sh "$IN_MEDIA" "$WAV_OUT"

echo "[2/2] Running Whisper transcription -> $JSON_OUT"
python3 scripts/transcribe_whisper.py "$WAV_OUT" \
  --model "$MODEL" \
  --device "$DEVICE" \
  --compute-type "$COMPUTE_TYPE" \
  --language "$LANGUAGE" \
  --out "$JSON_OUT"

echo "Done. Transcript JSON: $JSON_OUT"