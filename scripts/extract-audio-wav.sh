#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <input-media> <output-wav>" >&2
  exit 1
fi

IN="$1"
OUT="$2"

ffmpeg -y -i "$IN" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$OUT"
