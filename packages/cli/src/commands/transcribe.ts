import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import type { WordToken } from "@prune/core";
import { writeTranscriptToFile } from "../lib/transcript.js";
import { probeDurationSec } from "../lib/probe.js";
import { sanitizeBaseName } from "../lib/tokens.js";

export type TranscribeOptions = {
  model?: string;
  language?: string;
  device?: string;
};

export async function transcribeCommand(
  mediaPath: string,
  options: TranscribeOptions,
): Promise<void> {
  const absMedia = path.resolve(mediaPath);
  if (!fs.existsSync(absMedia)) {
    console.error(`Error: File not found: ${mediaPath}`);
    process.exit(1);
  }

  const baseName = sanitizeBaseName(path.basename(absMedia, path.extname(absMedia)));
  const outputDir = path.dirname(absMedia);
  const jsonPath = path.join(outputDir, `${baseName}.transcript.json`);
  const txtPath = path.join(outputDir, `${baseName}.transcript.txt`);

  const durationSec = probeDurationSec(absMedia) ?? 0;

  // Step 1: Extract audio to temp WAV
  const tmpWav = path.join(outputDir, `.${baseName}.tmp.wav`);
  console.log("Extracting audio...");
  const extract = spawnSync(
    "bash",
    [path.join(import.meta.dirname ?? ".", "../../../../scripts/extract-audio-wav.sh"), absMedia, tmpWav],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (extract.status !== 0) {
    console.error("Audio extraction failed:", extract.stderr);
    process.exit(1);
  }

  // Step 2: Run Whisper transcription
  console.log("Transcribing with Whisper...");
  const model = options.model ?? "small";
  const device = options.device ?? "cpu";
  const language = options.language ?? "en";

  const whisper = spawnSync(
    "python3",
    [
      path.join(import.meta.dirname ?? ".", "../../../../scripts/transcribe_whisper.py"),
      tmpWav,
      "--model", model,
      "--device", device,
      "--language", language,
      "--out", jsonPath,
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (whisper.status !== 0) {
    console.error("Transcription failed:", whisper.stderr);
    fs.unlinkSync(tmpWav);
    process.exit(1);
  }

  // Cleanup temp WAV
  fs.unlinkSync(tmpWav);

  // Step 3: Load JSON and write editable transcript
  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const tokens: WordToken[] = (raw.tokens ?? []).map((t: any, i: number) => ({
    id: String(t.id ?? `tok-${i + 1}`),
    text: String(t.text ?? ""),
    startSec: Number(t.startSec ?? t.start ?? 0),
    endSec: Number(t.endSec ?? t.end ?? 0),
  }));

  writeTranscriptToFile(txtPath, tokens, new Set(), {
    title: baseName,
    source: absMedia,
    durationSec: raw.durationSec ?? durationSec,
    language: raw.language ?? language,
  });

  console.log(`Created: ${jsonPath}`);
  console.log(`Created: ${txtPath}`);
  console.log(`${tokens.length} tokens, ${durationSec.toFixed(1)}s duration`);
}
