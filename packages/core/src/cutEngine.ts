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
  const raw: TimeRange[] = [];

  let runStart: WordToken | null = null;
  let runEnd: WordToken | null = null;
  let runLength = 0;

  const flushRun = () => {
    if (!runStart || !runEnd || runLength <= 0) return;
    raw.push({
      startSec: Math.max(0, runStart.startSec - padSec),
      endSec: runEnd.endSec + padSec,
    });
    runStart = null;
    runEnd = null;
    runLength = 0;
  };

  for (const token of tokens) {
    if (deletedTokenIds.has(token.id)) {
      if (!runStart) runStart = token;
      runEnd = token;
      runLength += 1;
    } else {
      flushRun();
    }
  }
  flushRun();

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
