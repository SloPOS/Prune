import path from "node:path";
import fs from "node:fs";
import { parseTranscript } from "../lib/transcript.js";
import { reconcileTranscript, loadTranscriptJson } from "../lib/reconcile.js";
import { buildScriptBody } from "../lib/tokens.js";

export type PreviewOptions = {
  timestamps?: boolean;
};

export async function previewCommand(txtPath: string, options: PreviewOptions): Promise<void> {
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

  const { tokens } = loadTranscriptJson(jsonPath);
  const txtContent = fs.readFileSync(absTxt, "utf-8");
  const parsed = parseTranscript(txtContent);
  const result = reconcileTranscript(tokens, parsed.entries);

  if (options.timestamps) {
    // Print with timestamps: [MM:SS] text
    for (const t of tokens) {
      if (!result.deletedIds.has(t.id)) {
        const mm = Math.floor(t.startSec / 60).toString().padStart(2, "0");
        const ss = Math.floor(t.startSec % 60).toString().padStart(2, "0");
        console.log(`[${mm}:${ss}] ${t.text}`);
      }
    }
  } else {
    // Print as flowing text
    const body = buildScriptBody(tokens, result.deletedIds, false);
    console.log(body);
  }
}
