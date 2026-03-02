# Whisper Transcription Plan (v1)

## Goal
Produce word-level timestamps usable by transcript-delete cut engine.

## v1 Approach
- Extract mono 16k WAV with ffmpeg
- Run Whisper (local) to generate segments + words
- Normalize into `WordToken[]` JSON for app ingest

## Candidate local engines
1. `faster-whisper` (Python, CTranslate2)
2. `whisper.cpp` CLI

We'll start with `faster-whisper` for easier Python integration and word timestamps.

## Output schema
`data/transcripts/<clip>.words.json`

```json
{
  "source": "<video-path>",
  "durationSec": 0,
  "fps": "30000/1001",
  "tokens": [
    { "id": "w-1", "text": "hello", "startSec": 0.12, "endSec": 0.33 }
  ]
}
```
