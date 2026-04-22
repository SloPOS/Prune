import type { WordToken } from "@prune/core";
import fs from "node:fs";
import path from "node:path";

export type TranscriptEntry = {
  text: string;
  startSec: number;
  endSec: number;
  deleted: boolean;
  isComment: boolean;
  isBlank: boolean;
};

export type ParsedTranscript = {
  header: {
    title?: string;
    source?: string;
    durationSec?: number;
    tokenCount?: number;
    language?: string;
  };
  entries: TranscriptEntry[];
};

const TIMESTAMP_REGEX = /^\[(\d{1,2}):(\d{2})\.(\d{2,3})-(\d{1,2}):(\d{2})\.(\d{2,3})\]$/;

function parseTimestamp(ts: string): { startSec: number; endSec: number } | null {
  const m = ts.match(TIMESTAMP_REGEX);
  if (!m) return null;

  const startMin = Number(m[1]);
  const startSec = Number(m[2]);
  const startMs = Number(m[3].padEnd(3, "0"));
  const endMin = Number(m[4]);
  const endSec = Number(m[5]);
  const endMs = Number(m[6].padEnd(3, "0"));

  if (!Number.isFinite(startMin) || !Number.isFinite(startSec) || !Number.isFinite(startMs)) return null;
  if (!Number.isFinite(endMin) || !Number.isFinite(endSec) || !Number.isFinite(endMs)) return null;

  const start = startMin * 60 + startSec + startMs / 1000;
  const end = endMin * 60 + endSec + endMs / 1000;

  if (end <= start) return null;
  return { startSec: start, endSec: end };
}

function formatTimestamp(startSec: number, endSec: number): string {
  const pad2 = (n: number) => String(Math.floor(n)).padStart(2, "0");
  const fmt = (sec: number) => {
    const mm = Math.floor(sec / 60);
    const ss = sec % 60;
    const ms = Math.round((sec - Math.floor(sec)) * 100);
    return `${pad2(mm)}:${pad2(ss)}.${String(ms).padStart(2, "0")}`;
  };
  return `[${fmt(startSec)}-${fmt(endSec)}]`;
}

export function parseTranscript(content: string): ParsedTranscript {
  const lines = content.split(/\r?\n/);
  const header: ParsedTranscript["header"] = {};
  const entries: TranscriptEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Comment lines
    if (trimmed.startsWith("#")) {
      // Parse header metadata from comments
      const headerMatch = trimmed.match(/^#\s*Prune transcript:\s*(.+)$/i);
      if (headerMatch) header.title = headerMatch[1].trim();

      const sourceMatch = trimmed.match(/^#\s*Source:\s*(.+)$/i);
      if (sourceMatch) header.source = sourceMatch[1].trim();

      const durationMatch = trimmed.match(/^#\s*Duration:\s*([\d.]+)s/i);
      if (durationMatch) header.durationSec = Number(durationMatch[1]);

      const tokensMatch = trimmed.match(/^#\s*Tokens:\s*(\d+)/i);
      if (tokensMatch) header.tokenCount = Number(tokensMatch[1]);

      const langMatch = trimmed.match(/^#\s*Language:\s*(\w+)/i);
      if (langMatch) header.language = langMatch[1].trim();

      continue;
    }

    // Blank lines → paragraph breaks (preserved)
    if (trimmed === "") {
      entries.push({
        text: "",
        startSec: -1,
        endSec: -1,
        deleted: false,
        isComment: false,
        isBlank: true,
      });
      continue;
    }

    // Parse token line: text [MM:SS.ss-MM:SS.ss]
    // Handle strikethrough: ~~text~~ [timestamp] or text ~~[timestamp]~~ or variations
    let text = trimmed;
    let deleted = false;

    // Check for strikethrough around text
    const strikeMatch = text.match(/^~~(.+?)~~\s*(\[.+\])$/);
    if (strikeMatch) {
      text = strikeMatch[1].trim();
      deleted = true;
      const ts = parseTimestamp(strikeMatch[2]);
      if (ts) {
        entries.push({
          text,
          startSec: ts.startSec,
          endSec: ts.endSec,
          deleted,
          isComment: false,
          isBlank: false,
        });
      }
      continue;
    }

    // Check for strikethrough around entire line including timestamp
    const fullStrikeMatch = text.match(/^~~(.+?)~~$/);
    if (fullStrikeMatch) {
      const inner = fullStrikeMatch[1].trim();
      // Try to extract timestamp from the end
      const parts = inner.match(/^(.+?)\s*(\[.+\])$/);
      if (parts) {
        text = parts[1].trim();
        deleted = true;
        const ts = parseTimestamp(parts[2]);
        if (ts) {
          entries.push({
            text,
            startSec: ts.startSec,
            endSec: ts.endSec,
            deleted,
            isComment: false,
            isBlank: false,
          });
        }
      }
      continue;
    }

    // Regular line with timestamp
    const parts = text.match(/^(.+?)\s*(\[.+\])$/);
    if (parts) {
      text = parts[1].trim();
      const ts = parseTimestamp(parts[2]);
      if (ts) {
        entries.push({
          text,
          startSec: ts.startSec,
          endSec: ts.endSec,
          deleted,
          isComment: false,
          isBlank: false,
        });
      }
    }
  }

  return { header, entries };
}

export function writeTranscript(
  tokens: WordToken[],
  deletedIds: Set<string>,
  opts?: {
    title?: string;
    source?: string;
    durationSec?: number;
    language?: string;
    paragraphs?: Array<{ afterTokenIndex: number }>; // Insert blank line after these indices
  },
): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Prune transcript: ${opts?.title ?? "untitled"}`);
  lines.push(`# Source: ${opts?.source ?? "unknown"}`);
  lines.push(`# Duration: ${(opts?.durationSec ?? 0).toFixed(1)}s | Tokens: ${tokens.length}${opts?.language ? ` | Language: ${opts.language}` : ""}`);
  lines.push("#");
  lines.push("# Edit this file to cut your video:");
  lines.push("#   - Delete a line or wrap in ~~strikethrough~~ to remove that word");
  lines.push("#   - Lines starting with # are comments (ignored)");
  lines.push("#   - Blank lines are preserved as paragraph breaks");
  lines.push("#   - Do not edit timestamps — they are used for reconciliation");
  lines.push("#");

  const paragraphSet = new Set(opts?.paragraphs?.map((p) => p.afterTokenIndex) ?? []);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const deleted = deletedIds.has(t.id);
    const text = deleted ? `~~${t.text}~~` : t.text;
    const ts = formatTimestamp(t.startSec, t.endSec);
    lines.push(`${text.padEnd(16)} ${ts}`);

    if (paragraphSet.has(i)) {
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function writeTranscriptToFile(
  outputPath: string,
  tokens: WordToken[],
  deletedIds: Set<string>,
  opts?: Parameters<typeof writeTranscript>[2],
): void {
  const content = writeTranscript(tokens, deletedIds, opts);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, "utf-8");
}
