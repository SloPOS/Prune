import type { TimeRange, WordToken } from "@prune/core";

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".webm", ".m4v"];
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".aac", ".m4a", ".flac", ".ogg", ".opus"];

export function isVideoFile(name: string) {
  const lower = name.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isAudioFile(name: string) {
  const lower = name.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function sanitizeBaseName(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function normalizeTokens(input: unknown): WordToken[] {
  const asArray = Array.isArray(input)
    ? input
    : typeof input === "object" && input && Array.isArray((input as { tokens?: unknown[] }).tokens)
      ? (input as { tokens: unknown[] }).tokens
      : [];

  return asArray
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const token = item as Record<string, unknown>;
      const text = String(token.text ?? token.word ?? "").trim();
      const startSec = Number(token.startSec ?? token.start ?? token.start_time ?? token.startTime);
      const endSec = Number(token.endSec ?? token.end ?? token.end_time ?? token.endTime);
      if (!text || Number.isNaN(startSec) || Number.isNaN(endSec) || endSec <= startSec) return null;
      return { id: String(token.id ?? `tok-${index}`), text, startSec, endSec } satisfies WordToken;
    })
    .filter((t): t is WordToken => Boolean(t));
}

export function tokenAtTime(tokens: WordToken[], timeSec: number): number {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (timeSec >= t.startSec && timeSec <= t.endSec) return i;
  }
  return -1;
}

export function mergeTimeRanges(ranges: TimeRange[]): TimeRange[] {
  if (ranges.length === 0) return [];
  const sorted = ranges
    .filter((r) => Number.isFinite(r.startSec) && Number.isFinite(r.endSec) && r.endSec > r.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  if (sorted.length === 0) return [];
  const merged: TimeRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = merged[merged.length - 1]!;
    const curr = sorted[i]!;
    if (curr.startSec <= prev.endSec) prev.endSec = Math.max(prev.endSec, curr.endSec);
    else merged.push({ ...curr });
  }
  return merged;
}

export function buildScriptBody(tokens: WordToken[], deleted: Set<string>, includeDeleted = false): string {
  const filtered = includeDeleted ? tokens : tokens.filter((t) => !deleted.has(t.id));
  if (filtered.length === 0) return "";
  const punctNoLeadSpace = /^[,.;:!?)]$/;
  const openersNoTrailSpace = /^[(]$/;
  let out = "";
  for (const token of filtered) {
    const text = token.text.trim();
    if (!text) continue;
    if (!out) out = text;
    else if (punctNoLeadSpace.test(text)) out += text;
    else if (openersNoTrailSpace.test(out.slice(-1))) out += text;
    else out += ` ${text}`;
  }
  return out.replace(/\s+\n/g, "\n").trim();
}
