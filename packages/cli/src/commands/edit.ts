import path from "node:path";
import fs from "node:fs";
import { exportFcpxmlV1, type KeepRange, type SourceMediaMetadata } from "@prune/export";
import { cutRangesFromDeletedTokens, keepRangesFromCuts } from "@prune/core";
import { parseTranscript } from "../lib/transcript.js";
import { reconcileTranscript, loadTranscriptJson } from "../lib/reconcile.js";
import { probeFcpxmlMetadata } from "../lib/probe.js";
import { sanitizeBaseName } from "../lib/tokens.js";

export type EditOptions = {
  outputDir?: string;
};

export async function editCommand(txtPath: string, options: EditOptions): Promise<void> {
  const absTxt = path.resolve(txtPath);
  if (!fs.existsSync(absTxt)) {
    console.error(`Error: File not found: ${txtPath}`);
    process.exit(1);
  }

  // Derive JSON path from .transcript.txt → .transcript.json
  const base = absTxt.replace(/\.transcript\.txt$/i, "");
  const jsonPath = `${base}.transcript.json`;
  if (!fs.existsSync(jsonPath)) {
    console.error(`Error: Canonical transcript not found: ${jsonPath}`);
    process.exit(1);
  }

  // Load and reconcile
  const { tokens, durationSec, source } = loadTranscriptJson(jsonPath);
  const txtContent = fs.readFileSync(absTxt, "utf-8");
  const parsed = parseTranscript(txtContent);
  const result = reconcileTranscript(tokens, parsed.entries);

  console.log(result.summary);

  // Build keep ranges
  const cutRanges = cutRangesFromDeletedTokens(tokens, result.deletedIds, 0.08);
  const keepRanges: KeepRange[] = durationSec
    ? keepRangesFromCuts(durationSec, cutRanges).map((k) => ({
        sourceStartSec: k.sourceStartSec,
        sourceEndSec: k.sourceEndSec,
        outputStartSec: k.outputStartSec,
      }))
    : [];

  // Write FCPXML export
  const mediaPath = source ?? "";
  const mediaMeta = mediaPath && fs.existsSync(mediaPath)
    ? probeFcpxmlMetadata(mediaPath)
    : { fps: 30, timecode: "00:00:00:00" };

  const sourceMeta: SourceMediaMetadata = {
    path: mediaPath,
    fps: mediaMeta.fps,
    timecode: mediaMeta.timecode,
    durationSec: durationSec ?? undefined,
    name: sanitizeBaseName(path.basename(mediaPath, path.extname(mediaPath))),
  };

  const outputDir = options.outputDir ? path.resolve(options.outputDir) : path.dirname(absTxt);
  fs.mkdirSync(outputDir, { recursive: true });

  const baseName = sanitizeBaseName(path.basename(base));
  const fcpxmlPath = path.join(outputDir, `${baseName}.fcpxml`);
  const fcpxml = exportFcpxmlV1(keepRanges, sourceMeta, {
    projectName: baseName,
    eventName: baseName,
    sequenceName: baseName,
  });
  fs.writeFileSync(fcpxmlPath, fcpxml, "utf-8");

  console.log(`Created: ${fcpxmlPath}`);
  console.log(`${keepRanges.length} keep ranges, ${cutRanges.length} cut ranges`);
}
