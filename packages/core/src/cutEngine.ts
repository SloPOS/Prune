export interface WordToken {
  id: string;
  text: string;
  startSec: number;
  endSec: number;
}

export interface TimeRange {
  startSec: number;
  endSec: number;
}

export interface KeepRange {
  sourceStartSec: number;
  sourceEndSec: number;
  outputStartSec: number;
}

export function cutRangesFromDeletedTokens(
  tokens: WordToken[],
  deletedTokenIds: Set<string>,
  padSec = 0.08,
): TimeRange[] {
  const raw = tokens
    .filter((t) => deletedTokenIds.has(t.id))
    .map((t) => ({
      startSec: Math.max(0, t.startSec - padSec),
      endSec: t.endSec + padSec,
    }))
    .sort((a, b) => a.startSec - b.startSec);

  if (raw.length === 0) return [];

  const merged: TimeRange[] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = raw[i];
    if (curr.startSec <= prev.endSec) {
      prev.endSec = Math.max(prev.endSec, curr.endSec);
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

export function keepRangesFromCuts(durationSec: number, cuts: TimeRange[]): KeepRange[] {
  if (durationSec <= 0) return [];
  if (cuts.length === 0) return [{ sourceStartSec: 0, sourceEndSec: durationSec, outputStartSec: 0 }];

  const keep: KeepRange[] = [];
  let sourceCursor = 0;
  let outputCursor = 0;

  for (const cut of cuts) {
    if (cut.startSec > sourceCursor) {
      const len = cut.startSec - sourceCursor;
      keep.push({
        sourceStartSec: sourceCursor,
        sourceEndSec: cut.startSec,
        outputStartSec: outputCursor,
      });
      outputCursor += len;
    }
    sourceCursor = Math.max(sourceCursor, cut.endSec);
  }

  if (sourceCursor < durationSec) {
    keep.push({
      sourceStartSec: sourceCursor,
      sourceEndSec: durationSec,
      outputStartSec: outputCursor,
    });
  }

  return keep;
}
