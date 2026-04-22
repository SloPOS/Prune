import { spawnSync } from "node:child_process";

export type RenderOptions = {
  encoder: string;
  container: "mp4" | "mov" | "webm";
  fps?: number;
  width?: number;
  height?: number;
};

export function ffmpegHasEncoder(name: string): boolean {
  try {
    const check = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf-8" });
    const text = `${check.stdout || ""}\n${check.stderr || ""}`;
    return text.includes(name);
  } catch {
    return false;
  }
}

export function parseFfmpegTimeSec(text: string): number | undefined {
  const m = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return undefined;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return undefined;
  return hh * 3600 + mm * 60 + ss;
}

export function ffmpegArgsForRanges(absInput: string, outputPath: string, keepRanges: { startSec: number; endSec: number }[], opts: RenderOptions, hasAudio: boolean): string[] {
  const trim = (n: number) => Number(n.toFixed(3));
  const size = opts.width && opts.height ? `${Math.max(2, Math.round(opts.width))}x${Math.max(2, Math.round(opts.height))}` : null;
  const audioCodec = opts.container === "webm" ? "libopus" : "aac";

  if (keepRanges.length === 1) {
    const r = keepRanges[0];
    const args = ["-y", "-hide_banner", "-i", absInput, "-ss", `${trim(r.startSec)}`, "-to", `${trim(r.endSec)}`, "-c:v", opts.encoder];
    if (opts.encoder === "libx264" || opts.encoder === "libx265") args.push("-preset", "veryfast");
    if (opts.fps && opts.fps > 0) args.push("-r", `${opts.fps}`);
    if (size) args.push("-s", size);
    if (hasAudio) args.push("-c:a", audioCodec);
    else args.push("-an");
    if (opts.container === "mp4" || opts.container === "mov") args.push("-movflags", "+faststart");
    args.push(outputPath);
    return args;
  }

  const filterParts: string[] = [];
  const concatInputs: string[] = [];
  keepRanges.forEach((r, i) => {
    const s = trim(r.startSec);
    const e = trim(r.endSec);
    filterParts.push(`[0:v]trim=start=${s}:end=${e},setpts=PTS-STARTPTS[v${i}]`);
    concatInputs.push(`[v${i}]`);
    if (hasAudio) {
      filterParts.push(`[0:a]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS[a${i}]`);
      concatInputs.push(`[a${i}]`);
    }
  });

  const videoConcatLabel = "vcat";
  filterParts.push(`${concatInputs.join("")}concat=n=${keepRanges.length}:v=1:a=${hasAudio ? 1 : 0}[${videoConcatLabel}]${hasAudio ? "[aout]" : ""}`);

  let videoOut = videoConcatLabel;
  if (size) {
    filterParts.push(`[${videoConcatLabel}]scale=${Math.max(2, Math.round(opts.width!))}:${Math.max(2, Math.round(opts.height!))}[vout]`);
    videoOut = "vout";
  }

  const args = ["-y", "-hide_banner", "-i", absInput, "-filter_complex", filterParts.join(";"), "-map", `[${videoOut}]`, "-c:v", opts.encoder];
  if (opts.encoder === "libx264" || opts.encoder === "libx265") args.push("-preset", "veryfast");
  if (opts.fps && opts.fps > 0) args.push("-r", `${opts.fps}`);
  if (hasAudio) {
    args.push("-map", "[aout]", "-c:a", audioCodec);
  } else {
    args.push("-an");
  }
  if (opts.container === "mp4" || opts.container === "mov") args.push("-movflags", "+faststart");
  args.push(outputPath);
  return args;
}
