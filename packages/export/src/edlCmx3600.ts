import type { KeepRange, SourceMediaMetadata } from "./types.js";
import { mediaNameFromSource, normalizeKeepRanges } from "./utils.js";

export interface EdlExportOptions {
  title?: string;
  reel?: string;
}

function cleanReel(value: string): string {
  const trimmed = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (trimmed || "AX").slice(0, 8);
}

function toTc(sec: number, fps: number): string {
  const fpsInt = Math.max(1, Math.round(fps));
  const totalFrames = Math.max(0, Math.round(sec * fpsInt));
  const hh = Math.floor(totalFrames / (fpsInt * 3600));
  const mm = Math.floor((totalFrames % (fpsInt * 3600)) / (fpsInt * 60));
  const ss = Math.floor((totalFrames % (fpsInt * 60)) / fpsInt);
  const ff = totalFrames % fpsInt;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

export function exportEdlCmx3600(
  keepRanges: KeepRange[],
  source: SourceMediaMetadata,
  options: EdlExportOptions = {},
): string {
  const title = (options.title || "PRUNE").replace(/[^A-Za-z0-9 _-]/g, "_").slice(0, 64);
  const clipName = mediaNameFromSource(source, "source");
  const reel = cleanReel(options.reel || source.name || source.path.split("/").pop() || "AX");
  const fps = source.fps;

  const lines: string[] = [];
  lines.push(`TITLE: ${title}`);
  lines.push("FCM: NON-DROP FRAME");
  lines.push("");

  normalizeKeepRanges(keepRanges).forEach((r, i) => {
    const recIn = r.outputStartSec;
    const recOut = r.outputStartSec + (r.sourceEndSec - r.sourceStartSec);
    const event = String(i + 1).padStart(3, "0");
    lines.push(
      `${event}  ${reel.padEnd(8, " ")} V     C        ${toTc(r.sourceStartSec, fps)} ${toTc(r.sourceEndSec, fps)} ${toTc(recIn, fps)} ${toTc(recOut, fps)}`,
    );
    lines.push(`* FROM CLIP NAME: ${clipName}`);
  });

  lines.push("");
  return lines.join("\n");
}
