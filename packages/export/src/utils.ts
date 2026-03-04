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
