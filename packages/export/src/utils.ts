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

const DEFAULT_FPS = 30;

export function fpsToInt(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) {
    return DEFAULT_FPS;
  }
  return Math.max(1, Math.round(fps));
}

function secondsToFramesWithFpsInt(sec: number, fpsInt: number): number {
  return Math.max(0, Math.round(sec * fpsInt));
}

export function secondsToFrames(sec: number, fps: number): number {
  return secondsToFramesWithFpsInt(sec, fpsToInt(fps));
}

function frameCountToNdfTimecode(totalFrames: number, fpsInt: number): string {
  const frames = Math.max(0, Math.round(totalFrames));
  const hh = Math.floor(frames / (fpsInt * 3600));
  const mm = Math.floor((frames % (fpsInt * 3600)) / (fpsInt * 60));
  const ss = Math.floor((frames % (fpsInt * 60)) / fpsInt);
  const ff = frames % fpsInt;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

function frameCountToDfTimecode(totalFrames: number, fpsInt: number): string {
  const framesPerHour = fpsInt * 60 * 60;
  const framesPer24Hours = framesPerHour * 24;
  const dropFrames = fpsInt === 60 ? 4 : 2;
  const framesPer10Minutes = (fpsInt * 60 * 10) - (dropFrames * 9);
  const framesPerMinute = (fpsInt * 60) - dropFrames;

  let frameNumber = Math.max(0, Math.round(totalFrames)) % framesPer24Hours;
  const d = Math.floor(frameNumber / framesPer10Minutes);
  const m = frameNumber % framesPer10Minutes;

  if (m > dropFrames) {
    frameNumber += (dropFrames * 9 * d) + (dropFrames * Math.floor((m - dropFrames) / framesPerMinute));
  } else {
    frameNumber += dropFrames * 9 * d;
  }

  const hh = Math.floor(frameNumber / framesPerHour);
  const mm = Math.floor((frameNumber % framesPerHour) / (fpsInt * 60));
  const ss = Math.floor((frameNumber % (fpsInt * 60)) / fpsInt);
  const ff = frameNumber % fpsInt;
  const pad = (n: number) => String(n).padStart(2, "0");

  return `${pad(hh)}:${pad(mm)}:${pad(ss)};${pad(ff)}`;
}

export function framesToTimecode(totalFrames: number, fps: number, options: { dropFrame?: boolean } = {}): string {
  const fpsInt = fpsToInt(fps);
  if (options.dropFrame && (fpsInt === 30 || fpsInt === 60)) {
    return frameCountToDfTimecode(totalFrames, fpsInt);
  }
  return frameCountToNdfTimecode(totalFrames, fpsInt);
}

export function createTimecodeFormatter(
  fps: number,
  options: { dropFrame?: boolean; maxCacheEntries?: number } = {},
): (totalFrames: number) => string {
  const fpsInt = fpsToInt(fps);
  const useDropFrame = Boolean(options.dropFrame && (fpsInt === 30 || fpsInt === 60));
  const requestedMaxCacheEntries = options.maxCacheEntries;
  const maxCacheEntries = typeof requestedMaxCacheEntries === "number" && Number.isFinite(requestedMaxCacheEntries)
    ? Math.max(0, Math.floor(requestedMaxCacheEntries))
    : 5000;
  const cache = new Map<number, string>();

  return (totalFrames: number): string => {
    const normalizedFrames = Math.max(0, Math.round(totalFrames));
    const cached = cache.get(normalizedFrames);
    if (cached) return cached;

    const timecode = useDropFrame
      ? frameCountToDfTimecode(normalizedFrames, fpsInt)
      : frameCountToNdfTimecode(normalizedFrames, fpsInt);

    if (maxCacheEntries > 0) {
      if (cache.size >= maxCacheEntries) cache.clear();
      cache.set(normalizedFrames, timecode);
    }
    return timecode;
  };
}

export function parseTimecodeToFrames(timecode: string, fpsInt: number): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/.exec(timecode);
  if (!match) return 0;

  const effectiveFps = fpsToInt(fpsInt);
  const [, hh, mm, ss, separator, ff] = match;
  const hours = Number(hh);
  const minutes = Number(mm);
  const seconds = Number(ss);
  const frames = Number(ff);

  const totalSeconds = ((hours * 60 + minutes) * 60) + seconds;
  const totalFrames = (totalSeconds * effectiveFps) + frames;

  if (separator === ";" && (effectiveFps === 30 || effectiveFps === 60)) {
    const dropFrames = effectiveFps === 30 ? 2 : 4;
    const totalMinutes = (hours * 60) + minutes;
    const droppedFrames = dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
    return Math.max(0, totalFrames - droppedFrames);
  }

  return totalFrames;
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

export function resolveSourceDurationSec(source: SourceMediaMetadata, keepRanges: KeepRange[]): number {
  if (typeof source.durationSec === "number") {
    return Math.max(0, source.durationSec);
  }

  const inferredDurationSec = Math.max(0, ...keepRanges.map((r) => r.sourceEndSec));
  return inferredDurationSec;
}

export interface FrameRate {
  fpsNum: number;
  fpsDen: number;
}

export interface TimecodeFormatInfo {
  dropFrame: boolean;
  displayFormat: "DF" | "NDF";
}

const NTSC_FRAME_RATES: Array<{ fps: number; rate: FrameRate }> = [
  { fps: 23.976, rate: { fpsNum: 24000, fpsDen: 1001 } },
  { fps: 29.97, rate: { fpsNum: 30000, fpsDen: 1001 } },
  { fps: 59.94, rate: { fpsNum: 60000, fpsDen: 1001 } },
];

export function normalizeFrameRate(fps: number): FrameRate {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS;
  const ntsc = NTSC_FRAME_RATES.find((r) => Math.abs(r.fps - safeFps) < 0.001);
  if (ntsc) return ntsc.rate;

  const rounded = Math.round(safeFps);
  if (Math.abs(rounded - safeFps) < 0.001 && rounded > 0) {
    return { fpsNum: rounded, fpsDen: 1 };
  }

  const scale = 1000;
  return { fpsNum: Math.round(safeFps * scale), fpsDen: scale };
}

export function isNtscFrameRate(fps: number): boolean {
  return normalizeFrameRate(fps).fpsDen !== 1;
}

export function inferTimecodeFormat(timecode: string): TimecodeFormatInfo {
  const dropFrame = /;\d{2}$/.test(String(timecode || "").trim());
  return {
    dropFrame,
    displayFormat: dropFrame ? "DF" : "NDF",
  };
}

export function secondsToRateFrames(sec: number, rate: FrameRate): number {
  return Math.max(0, Math.round((sec * rate.fpsNum) / rate.fpsDen));
}

export function rateFramesToFractionSeconds(frames: number, rate: FrameRate): string {
  const num = frames * rate.fpsDen;
  const den = rate.fpsNum;
  return `${num}/${den}s`;
}

export interface KeepRangeFrames {
  inFrames: number;
  outFrames: number;
  startFrames: number;
  endFrames: number;
}

function mapKeepRangesToFrameRanges(
  keepRanges: KeepRange[],
  frameMapper: (seconds: number) => number,
): KeepRangeFrames[] {
  return keepRanges.map((range) => {
    const inFrames = frameMapper(range.sourceStartSec);
    const outFrames = frameMapper(range.sourceEndSec);
    const startFrames = frameMapper(range.outputStartSec);
    const endFrames = startFrames + Math.max(0, outFrames - inFrames);
    return { inFrames, outFrames, startFrames, endFrames };
  });
}

export function keepRangesToFrameRanges(
  keepRanges: KeepRange[],
  fps: number,
  options: { alreadyNormalized?: boolean } = {},
): KeepRangeFrames[] {
  const ranges = options.alreadyNormalized ? keepRanges : normalizeKeepRanges(keepRanges);
  const fpsInt = fpsToInt(fps);
  return mapKeepRangesToFrameRanges(ranges, (seconds) => secondsToFramesWithFpsInt(seconds, fpsInt));
}

export function keepRangesToRateFrameRanges(
  keepRanges: KeepRange[],
  rate: FrameRate,
  options: { alreadyNormalized?: boolean } = {},
): KeepRangeFrames[] {
  const ranges = options.alreadyNormalized ? keepRanges : normalizeKeepRanges(keepRanges);
  return mapKeepRangesToFrameRanges(ranges, (seconds) => secondsToRateFrames(seconds, rate));
}

export function maxEndFrames(ranges: Array<{ endFrames: number }>): number {
  let max = 0;
  for (const range of ranges) {
    if (range.endFrames > max) max = range.endFrames;
  }
  return max;
}
