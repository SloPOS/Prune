export type FunSequenceItem = {
  id: string;
  tokenId: string;
};

export type FunModeState = {
  funModeLocked: boolean;
  funSequence: FunSequenceItem[];
  funFadeInSec: number;
  funFadeOutSec: number;
};

function coerceSeconds(value: unknown): number {
  return Math.max(0, Number(value || 0));
}

export function normalizeFunSequence(input: unknown, idPrefix = "fun"): FunSequenceItem[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const maybeItem = item as { id?: unknown; tokenId?: unknown };
      const tokenId = String(maybeItem.tokenId || "").trim();
      if (!tokenId) return null;
      const id = String(maybeItem.id || `${idPrefix}-${index}`);
      return { id, tokenId } satisfies FunSequenceItem;
    })
    .filter((item): item is FunSequenceItem => Boolean(item));
}

export function parseFunModeState(input: unknown, idPrefix = "fun"): FunModeState {
  if (!input || typeof input !== "object") {
    return { funModeLocked: false, funSequence: [], funFadeInSec: 0, funFadeOutSec: 0 };
  }

  const raw = input as {
    funModeLocked?: unknown;
    funSequence?: unknown;
    funFadeInSec?: unknown;
    funFadeOutSec?: unknown;
  };

  return {
    funModeLocked: Boolean(raw.funModeLocked),
    funSequence: normalizeFunSequence(raw.funSequence, idPrefix),
    funFadeInSec: coerceSeconds(raw.funFadeInSec),
    funFadeOutSec: coerceSeconds(raw.funFadeOutSec),
  };
}

export function stringifyFunModeState(state: FunModeState): string {
  return JSON.stringify({
    funModeLocked: state.funModeLocked,
    funSequence: state.funSequence,
    funFadeInSec: coerceSeconds(state.funFadeInSec),
    funFadeOutSec: coerceSeconds(state.funFadeOutSec),
  });
}
