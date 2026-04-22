import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { cutRangesFromDeletedTokens, keepRangesFromCuts } from "@prune/core";
import { parseTranscript } from "../lib/transcript.js";
import { reconcileTranscript, loadTranscriptJson } from "../lib/reconcile.js";
import { probeMediaDetails, inputHasAudio } from "../lib/probe.js";
import { sanitizeBaseName } from "../lib/tokens.js";
import { ffmpegArgsForRanges, ffmpegHasEncoder, parseFfmpegTimeSec, type RenderOptions } from "../lib/ffmpeg.js";

export type RenderCodec = "h264" | "h265" | "prores" | "copy";

export type RenderOpts = {
  codec?: RenderCodec;
  container?: "mp4" | "mov" | "webm";
  resolution?: "source" | `${number}x${number}`;
  fps?: "source" | number;
};

function resolveEncoder(codec: RenderCodec): string {
  switch (codec) {
    case "h264":
      if (ffmpegHasEncoder("h264_videotoolbox")) return "h264_videotoolbox";
      if (ffmpegHasEncoder("libx264")) return "libx264";
      throw new Error("No H.264 encoder available");
    case "h265":
      if (ffmpegHasEncoder("hevc_videotoolbox")) return "hevc_videotoolbox";
      if (ffmpegHasEncoder("libx265")) return "libx265";
      throw new Error("No H.265 encoder available");
    case "prores":
      if (ffmpegHasEncoder("prores_ks")) return "prores_ks";
      throw new Error("No ProRes encoder available");
    case "copy":
      return "copy";
    default:
      throw new Error(`Unknown codec: ${codec}`);
  }
}

export async function renderCommand(txtPath: string, options: RenderOpts): Promise<void> {
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
  if (!source || !fs.existsSync(source)) {
    console.error(`Error: Source media not found: ${source}`);
    process.exit(1);
  }

  const txtContent = fs.readFileSync(absTxt, "utf-8");
  const parsed = parseTranscript(txtContent);
  const result = reconcileTranscript(tokens, parsed.entries);

  console.log(result.summary);

  if (durationSec === undefined || durationSec === 0) {
    console.error("Error: Cannot determine media duration");
    process.exit(1);
  }

  const cutRanges = cutRangesFromDeletedTokens(tokens, result.deletedIds, 0.08);
  const keepRanges = keepRangesFromCuts(durationSec, cutRanges);

  if (keepRanges.length === 0) {
    console.error("Error: No content to render (everything deleted)");
    process.exit(1);
  }

  const outputPath = path.join(
    path.dirname(absTxt),
    `${sanitizeBaseName(path.basename(base))}-edited.${options.container ?? "mp4"}`,
  );

  const mediaInfo = probeMediaDetails(source);
  const hasAudio = inputHasAudio(source);

  const encoder = resolveEncoder(options.codec ?? "h264");
  const container = options.container ?? "mp4";
  const fps =
    options.fps === "source" || options.fps === undefined
      ? mediaInfo?.fps || 30
      : options.fps;
  const width =
    options.resolution === "source" || options.resolution === undefined
      ? mediaInfo?.width
      : Number(options.resolution.split("x")[0]);
  const height =
    options.resolution === "source" || options.resolution === undefined
      ? mediaInfo?.height
      : Number(options.resolution.split("x")[1]);

  const ffmpegOpts: RenderOptions = {
    encoder,
    container,
    fps,
    width,
    height,
  };

  const args = ffmpegArgsForRanges(
    source,
    outputPath,
    keepRanges.map((k) => ({ startSec: k.sourceStartSec, endSec: k.sourceEndSec })),
    ffmpegOpts,
    hasAudio,
  );

  console.log(
    `Rendering to: ${outputPath}`,
  );
  console.log(
    `Keep ranges: ${keepRanges.length} (${keepRanges
      .reduce((a, r) => a + (r.sourceEndSec - r.sourceStartSec), 0)
      .toFixed(1)}s kept)`,
  );

  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "pipe"] });
    let lastProgress = "";

    proc.stderr?.on("data", (data) => {
      const text = String(data);
      const time = parseFfmpegTimeSec(text);
      if (time !== undefined) {
        const pct = Math.min(100, Math.round((time / durationSec) * 100));
        lastProgress = `${pct}% (${time.toFixed(1)}s / ${durationSec.toFixed(1)}s)`;
        process.stdout.write(`\r${lastProgress}`);
      }
    });

    proc.on("close", (code) => {
      process.stdout.write("\n");
      if (code === 0) {
        console.log(`Created: ${outputPath}`);
        resolve();
      } else {
        console.error(`FFmpeg exited with code ${code}`);
        reject(new Error(`Render failed with code ${code}`));
      }
    });

    proc.on("error", reject);
  });
}
