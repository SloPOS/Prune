import type { KeepRange, SourceMediaMetadata } from "./types.js";

export function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function pathToFileUrl(path: string): string {
  if (path.startsWith("file://")) return path;
  return `file://${encodeURI(path.replaceAll("\\", "/"))}`;
}

export function fpsToInt(fps: number): number {
  return Math.max(1, Math.round(fps));
}

export function secondsToFrames(sec: number, fps: number): number {
  return Math.max(0, Math.round(sec * fpsToInt(fps)));
}

export function framesToTimecode(totalFrames: number, fps: number): string {
  const fpsInt = fpsToInt(fps);
  const frames = Math.max(0, Math.round(totalFrames));
  const hh = Math.floor(frames / (fpsInt * 3600));
  const mm = Math.floor((frames % (fpsInt * 3600)) / (fpsInt * 60));
  const ss = Math.floor((frames % (fpsInt * 60)) / fpsInt);
  const ff = frames % fpsInt;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

export function parseTimecodeToFrames(timecode: string, fpsInt: number): number {
  const match = /^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/.exec(timecode);
  if (!match) return 0;

  const [, hh, mm, ss, ff] = match;
  return (((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * fpsInt) + Number(ff);
}

export function mediaNameFromSource(source: SourceMediaMetadata, fallback = "source-media"): string {
  return source.name ?? source.path.split("/").pop() ?? fallback;
}

export function validKeepRanges(keepRanges: KeepRange[]): KeepRange[] {
  return keepRanges.filter((r) => r.sourceEndSec > r.sourceStartSec);
}

export function normalizeKeepRanges(keepRanges: KeepRange[]): KeepRange[] {
  return validKeepRanges(keepRanges)
    .map((r) => ({
      sourceStartSec: Math.max(0, r.sourceStartSec),
      sourceEndSec: Math.max(0, r.sourceEndSec),
      outputStartSec: Math.max(0, r.outputStartSec),
    }))
    .sort((a, b) => (a.outputStartSec - b.outputStartSec) || (a.sourceStartSec - b.sourceStartSec));
}

export interface FrameKeepRange {
  inFrames: number;
  outFrames: number;
  startFrames: number;
  endFrames: number;
}

export function keepRangesToFrameRanges(
  keepRanges: KeepRange[],
  fps: number,
  options: { alreadyNormalized?: boolean } = {},
): FrameKeepRange[] {
  const ranges = options.alreadyNormalized ? keepRanges : normalizeKeepRanges(keepRanges);
  return ranges.map((range) => {
    const inFrames = secondsToFrames(range.sourceStartSec, fps);
    const outFrames = secondsToFrames(range.sourceEndSec, fps);
    const startFrames = secondsToFrames(range.outputStartSec, fps);
    const endFrames = startFrames + Math.max(0, outFrames - inFrames);
    return { inFrames, outFrames, startFrames, endFrames };
  });
}
