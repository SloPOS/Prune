#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <media-file>" >&2
  exit 1
fi

FILE="$1"
ffprobe -v error -show_entries format=filename,duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,time_base,sample_rate,channels -of json "$FILE"
