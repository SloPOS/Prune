import path from "node:path";
import fs from "node:fs";
import { parseTranscript, writeTranscriptToFile } from "../lib/transcript.js";
import { reconcileTranscript, loadTranscriptJson } from "../lib/reconcile.js";
import { buildPhraseMatches, FIXED_SMART_CLEANUP_PHRASES } from "../lib/fillers.js";
import { parseWavMono16, detectBreathCandidates, detectNoiseClickCandidates } from "../lib/analysis.js";
import { spawnSync } from "node:child_process";

export type CleanupOptions = {
  fillers?: boolean;
  silence?: number;
  breaths?: boolean;
  clicks?: boolean;
};

function extractAudioToWav(mediaPath: string, outputWav: string): void {
  spawnSync("ffmpeg", ["-y", "-i", mediaPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputWav], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

export async function cleanupCommand(txtPath: string, options: CleanupOptions): Promise<void> {
  const absTxt = path.resolve(txtPath);
  if (!fs.existsSync(absTxt)) {
    console.error(`Error: File not found: ${txtPath}`);
    process.exit(1);
  }

  const base = absTxt.replace(/\.transcript\.txt$/i, "");
  const jsonPath = `${base}.transcript.json`;
  if (!fs.existsSync(jsonPath)) {
    console.error(`Error: Canonical transcript not found: ${jsonPath}`);
    process.exit(1);
  }

  const { tokens, source } = loadTranscriptJson(jsonPath);
  const txtContent = fs.readFileSync(absTxt, "utf-8");
  const parsed = parseTranscript(txtContent);
  const result = reconcileTranscript(tokens, parsed.entries);

  // Start with existing deleted IDs (additive)
  const newDeletedIds = new Set(result.deletedIds);

  // Fillers detection
  if (options.fillers) {
    const matches = buildPhraseMatches(tokens);
    for (const m of matches) {
      for (const id of m.tokenIds) {
        newDeletedIds.add(id);
      }
    }
    console.log(`Marked ${matches.reduce((a, m) => a + m.count, 0)} filler tokens`);
  }

  // Silence detection (gaps between non-deleted tokens)
  if (options.silence !== undefined && options.silence > 0) {
    const sortedTokens = [...tokens].sort((a, b) => a.startSec - b.startSec);
    let gapsFound = 0;
    for (let i = 1; i < sortedTokens.length; i++) {
      const prev = sortedTokens[i - 1]!;
      const curr = sortedTokens[i]!;
      const gap = curr.startSec - prev.endSec;
      if (gap > options.silence) {
        // Mark tokens that bracket the gap? Or just report?
        // For now, we don't mark tokens for gaps — we could mark short tokens inside gaps
        gapsFound++;
      }
    }
    console.log(`Silence detection: ${options.silence}s threshold (gaps logged: ${gapsFound})`);
  }

  // Breath detection (requires audio)
  if (options.breaths && source && fs.existsSync(source)) {
    const tmpWav = path.join(path.dirname(absTxt), `.${path.basename(base)}.cleanup.wav`);
    extractAudioToWav(source, tmpWav);

    try {
      const { sampleRate, samples } = parseWavMono16(tmpWav);

      // Build speech gaps from non-deleted tokens
      const keptTokens = tokens.filter((t) => !newDeletedIds.has(t.id));
      const speechGaps: Array<{ startSec: number; endSec: number }> = [];
      if (keptTokens.length > 0) {
        const sorted = [...keptTokens].sort((a, b) => a.startSec - b.startSec);
        for (let i = 1; i < sorted.length; i++) {
          const prev = sorted[i - 1]!;
          const curr = sorted[i]!;
          if (curr.startSec > prev.endSec + 0.15) {
            speechGaps.push({ startSec: prev.endSec, endSec: curr.startSec });
          }
        }
      }

      const breaths = detectBreathCandidates(samples, sampleRate, speechGaps);
      let marked = 0;
      for (const b of breaths) {
        // Find tokens within breath range
        for (const t of tokens) {
          if (t.startSec >= b.startSec && t.endSec <= b.endSec) {
            if (!newDeletedIds.has(t.id)) {
              newDeletedIds.add(t.id);
              marked++;
            }
          }
        }
      }
      console.log(`Detected ${breaths.length} breath candidates, marked ${marked} tokens`);
    } finally {
      fs.unlinkSync(tmpWav);
    }
  }

  // Click detection
  if (options.clicks && source && fs.existsSync(source)) {
    const tmpWav = path.join(path.dirname(absTxt), `.${path.basename(base)}.cleanup.wav`);
    extractAudioToWav(source, tmpWav);

    try {
      const { sampleRate, samples } = parseWavMono16(tmpWav);
      const clicks = detectNoiseClickCandidates(samples, sampleRate);
      let marked = 0;
      for (const c of clicks) {
        for (const t of tokens) {
          if (t.startSec >= c.startSec && t.endSec <= c.endSec) {
            if (!newDeletedIds.has(t.id)) {
              newDeletedIds.add(t.id);
              marked++;
            }
          }
        }
      }
      console.log(`Detected ${clicks.length} click candidates, marked ${marked} tokens`);
    } finally {
      fs.unlinkSync(tmpWav);
    }
  }

  // Rewrite the .txt file with new deletions
  const header = parsed.header;
  writeTranscriptToFile(absTxt, tokens, newDeletedIds, {
    title: header.title,
    source: header.source,
    durationSec: header.durationSec,
    language: header.language,
  });

  console.log(`Updated: ${absTxt}`);
  console.log(`Total deleted: ${newDeletedIds.size} / ${tokens.length}`);
}
