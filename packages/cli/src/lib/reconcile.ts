import type { WordToken } from "@prune/core";
import fs from "node:fs";
import type { TranscriptEntry } from "./transcript.js";

export type ReconciliationResult = {
  deletedIds: Set<string>;
  matched: number;
  unmatched: number;
  deleted: number;
  summary: string;
};

const TIME_TOLERANCE_SEC = 0.05; // 50ms tolerance for timestamp matching

function findTokenByTimestamp(
  tokens: WordToken[],
  startSec: number,
  endSec: number,
  tolerance: number = TIME_TOLERANCE_SEC,
): WordToken | null {
  let best: WordToken | null = null;
  let bestDelta = Infinity;

  for (const t of tokens) {
    const delta = Math.abs(t.startSec - startSec) + Math.abs(t.endSec - endSec);
    if (delta < tolerance * 2 && delta < bestDelta) {
      best = t;
      bestDelta = delta;
    }
  }

  return best;
}

/**
 * Reconcile transcript entries against canonical tokens.
 *
 * Logic:
 * 1. Match each non-blank, non-comment entry to a token by timestamp
 * 2. Any token with no matching entry → deleted (line was removed)
 * 3. Any entry with strikethrough → deleted
 * 4. Return deletedIds set
 */
export function reconcileTranscript(
  tokens: WordToken[],
  entries: TranscriptEntry[],
): ReconciliationResult {
  const matchedTokenIds = new Set<string>();
  const deletedIds = new Set<string>();

  // Match entries to tokens
  for (const entry of entries) {
    if (entry.isComment || entry.isBlank) continue;
    if (entry.startSec < 0 || entry.endSec < 0) continue;

    const match = findTokenByTimestamp(tokens, entry.startSec, entry.endSec);
    if (match) {
      matchedTokenIds.add(match.id);
      if (entry.deleted) {
        deletedIds.add(match.id);
      }
    }
  }

  // Any token not matched → was deleted (line removed from file)
  for (const t of tokens) {
    if (!matchedTokenIds.has(t.id)) {
      deletedIds.add(t.id);
    }
  }

  const matched = matchedTokenIds.size;
  const unmatched = tokens.length - matched;
  const deleted = deletedIds.size;
  const kept = tokens.length - deleted;

  return {
    deletedIds,
    matched,
    unmatched,
    deleted,
    summary: `${tokens.length} tokens, ${deleted} deleted (${unmatched} by removal), ${kept} kept`,
  };
}

export function loadTranscriptJson(jsonPath: string): {
  tokens: WordToken[];
  source?: string;
  durationSec?: number;
  language?: string;
} {
  const raw = fs.readFileSync(jsonPath, "utf-8");
  const data = JSON.parse(raw);

  const tokens: WordToken[] = (data.tokens ?? []).map((t: any, index: number) => ({
    id: String(t.id ?? `tok-${index}`),
    text: String(t.text ?? ""),
    startSec: Number(t.startSec ?? t.start ?? 0),
    endSec: Number(t.endSec ?? t.end ?? 0),
  }));

  return {
    tokens,
    source: data.audio ?? data.source,
    durationSec: data.durationSec ?? data.duration,
    language: data.language,
  };
}
