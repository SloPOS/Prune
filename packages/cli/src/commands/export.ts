import path from "node:path";
import fs from "node:fs";
import {
  exportFcpxmlV1,
  exportEdlCmx3600,
  exportPremiereXml,
  type KeepRange,
  type SourceMediaMetadata,
} from "@prune/export";
import { cutRangesFromDeletedTokens, keepRangesFromCuts } from "@prune/core";
import { parseTranscript } from "../lib/transcript.js";
import { reconcileTranscript, loadTranscriptJson } from "../lib/reconcile.js";
import { probeFcpxmlMetadata } from "../lib/probe.js";
import { sanitizeBaseName, buildScriptBody } from "../lib/tokens.js";
import { normalizeSubtitleTokens, buildCaptionChunks, buildSrt, buildVtt } from "../lib/subtitles.js";

export type ExportFormat = "fcpxml" | "edl" | "xml" | "srt" | "vtt" | "aaf" | "txt" | "all";

export type ExportOptions = {
  format: ExportFormat | ExportFormat[];
  outputDir?: string;
};

export async function exportCommand(txtPath: string, options: ExportOptions): Promise<void> {
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

  const { tokens, durationSec, source } = loadTranscriptJson(jsonPath);
  const txtContent = fs.readFileSync(absTxt, "utf-8");
  const parsed = parseTranscript(txtContent);
  const result = reconcileTranscript(tokens, parsed.entries);

  console.log(result.summary);

  const cutRanges = cutRangesFromDeletedTokens(tokens, result.deletedIds, 0.08);
  const keepRanges: KeepRange[] = durationSec
    ? keepRangesFromCuts(durationSec, cutRanges).map((k) => ({
        sourceStartSec: k.sourceStartSec,
        sourceEndSec: k.sourceEndSec,
        outputStartSec: k.outputStartSec,
      }))
    : [];

  const mediaPath = source ?? "";
  const mediaMeta = mediaPath && fs.existsSync(mediaPath)
    ? probeFcpxmlMetadata(mediaPath)
    : { fps: 30, timecode: "00:00:00:00" };

  const sourceMeta: SourceMediaMetadata = {
    path: mediaPath,
    fps: mediaMeta.fps,
    timecode: mediaMeta.timecode,
    durationSec: durationSec ?? undefined,
    name: sanitizeBaseName(path.basename(mediaPath, path.extname(mediaPath)) || "edited"),
  };

  const outputDir = options.outputDir ? path.resolve(options.outputDir) : path.dirname(absTxt);
  fs.mkdirSync(outputDir, { recursive: true });

  const baseName = sanitizeBaseName(path.basename(base));
  const formats = Array.isArray(options.format) ? options.format : [options.format];
  const doAll = formats.includes("all");

  const toExport = new Set<ExportFormat>(doAll
    ? ["fcpxml", "edl", "xml", "srt", "vtt", "txt"]
    : formats);

  if (toExport.has("fcpxml")) {
    const out = path.join(outputDir, `${baseName}.fcpxml`);
    const content = exportFcpxmlV1(keepRanges, sourceMeta, { projectName: baseName, eventName: baseName, sequenceName: baseName });
    fs.writeFileSync(out, content, "utf-8");
    console.log(`Created: ${out}`);
  }

  if (toExport.has("edl")) {
    const out = path.join(outputDir, `${baseName}.edl`);
    const content = exportEdlCmx3600(keepRanges, sourceMeta, { title: baseName });
    fs.writeFileSync(out, content, "utf-8");
    console.log(`Created: ${out}`);
  }

  if (toExport.has("xml")) {
    const out = path.join(outputDir, `${baseName}-premiere.xml`);
    const content = exportPremiereXml(keepRanges, sourceMeta, { projectName: baseName, sequenceName: baseName });
    fs.writeFileSync(out, content, "utf-8");
    console.log(`Created: ${out}`);
  }

  if (toExport.has("txt")) {
    const out = path.join(outputDir, `${baseName}-script.txt`);
    const content = buildScriptBody(tokens, result.deletedIds, false);
    fs.writeFileSync(out, content, "utf-8");
    console.log(`Created: ${out}`);
  }

  // Subtitles
  const keptTokens = tokens.filter((t) => !result.deletedIds.has(t.id));
  const subtitleReady = normalizeSubtitleTokens(keptTokens);
  const captionChunks = buildCaptionChunks(subtitleReady);

  if (toExport.has("srt")) {
    const out = path.join(outputDir, `${baseName}.srt`);
    fs.writeFileSync(out, buildSrt(captionChunks), "utf-8");
    console.log(`Created: ${out}`);
  }

  if (toExport.has("vtt")) {
    const out = path.join(outputDir, `${baseName}.vtt`);
    fs.writeFileSync(out, buildVtt(captionChunks), "utf-8");
    console.log(`Created: ${out}`);
  }

  // AAF is special — it needs a zip, skip for now or implement if simple
  if (toExport.has("aaf")) {
    console.warn("AAF export not yet implemented in CLI");
  }
}
