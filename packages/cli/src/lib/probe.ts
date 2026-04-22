import { spawnSync } from "node:child_process";
import path from "node:path";

export function pickRate(raw: string): number | undefined {
  const value = String(raw || "").trim();
  if (!value) return undefined;
  if (value.includes("/")) {
    const [a, b] = value.split("/").map(Number);
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) return a / b;
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function probeDurationSec(absInput: string): number | undefined {
  try {
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", absInput], {
      encoding: "utf-8",
    });
    const raw = (probe.stdout || "").trim();
    const duration = Number(raw);
    return Number.isFinite(duration) && duration > 0 ? duration : undefined;
  } catch {
    return undefined;
  }
}

export function probeFcpxmlMetadata(absInput: string): { fps: number; timecode: string; durationSec?: number } {
  const durationSec = probeDurationSec(absInput);
  try {
    const probe = spawnSync(
      "ffprobe",
      [
        "-v", "error",
        "-print_format", "json",
        "-show_entries",
        "stream=r_frame_rate,avg_frame_rate:format_tags=timecode",
        absInput,
      ],
      { encoding: "utf-8" },
    );

    const payload = JSON.parse(probe.stdout || "{}");
    const stream = Array.isArray(payload.streams)
      ? payload.streams.find((s: any) => pickRate(s?.avg_frame_rate) || pickRate(s?.r_frame_rate))
      : undefined;

    const fps =
      pickRate(stream?.avg_frame_rate) ||
      pickRate(stream?.r_frame_rate) ||
      30;

    const timecode = String(payload?.format?.tags?.timecode || "").trim() || "00:00:00:00";

    return { fps, timecode, durationSec };
  } catch {
    return { fps: 30, timecode: "00:00:00:00", durationSec };
  }
}

export function probeMediaDetails(absInput: string) {
  try {
    const probe = spawnSync("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_entries",
      "format=duration,bit_rate,format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,bit_rate",
      absInput,
    ], { encoding: "utf-8" });
    const payload = JSON.parse(probe.stdout || "{}");
    const streams = Array.isArray(payload.streams) ? payload.streams : [];
    const v = streams.find((s: any) => s.codec_type === "video") || {};
    const a = streams.find((s: any) => s.codec_type === "audio") || {};
    const ext = path.extname(absInput).replace(".", "").toLowerCase();
    const ffprobeFormat = String(payload?.format?.format_name || "unknown");
    const primaryFormat = ffprobeFormat.split(",")[0] || ffprobeFormat;
    const container = ["mp4", "mov", "webm"].includes(ext) ? ext : primaryFormat;
    return {
      container,
      durationSec: Number(payload?.format?.duration || 0) || 0,
      bitRate: Number(payload?.format?.bit_rate || 0) || 0,
      videoCodec: String(v.codec_name || "unknown"),
      width: Number(v.width || 0) || 0,
      height: Number(v.height || 0) || 0,
      fps: pickRate(v.avg_frame_rate) || pickRate(v.r_frame_rate) || 0,
      audioCodec: String(a.codec_name || "none"),
      audioSampleRate: Number(a.sample_rate || 0) || 0,
      audioChannels: Number(a.channels || 0) || 0,
      audioBitRate: Number(a.bit_rate || 0) || 0,
    };
  } catch {
    return null;
  }
}

export function inputHasAudio(absInput: string): boolean {
  try {
    const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", absInput], { encoding: "utf-8" });
    return Boolean((probe.stdout || "").trim());
  } catch {
    return false;
  }
}
