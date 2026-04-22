import type { WordToken } from "@prune/core";

export type PhraseMatch = {
  phrase: string;
  normalizedPhrase: string;
  tokenIds: string[];
  count: number;
};

export const FIXED_SMART_CLEANUP_PHRASES = [
  "um", "uh", "ah", "er", "mm-hmm",
  "like", "basically", "actually", "literally", "seriously", "honestly", "obviously",
  "anyway", "well", "now",
  "right?", "you know?", "okay?", "make sense?", "you see?",
  "i mean", "at the end of the day", "to be honest with you", "for all intents and purposes", "as a matter of fact", "it is what it is",
  "go ahead", "gone ahead", "let's go ahead", "we're gonna", "we're going to",
] as const;

export function normalizeText(input: string): string {
  return input.toLowerCase().replace(/[']/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
}

export function buildPhraseMatches(tokens: WordToken[]): PhraseMatch[] {
  if (tokens.length === 0) return [];
  const normalizedTokens = tokens.map((token) => ({ token, normalized: normalizeText(token.text) })).filter((t) => t.normalized.length > 0);
  if (normalizedTokens.length === 0) return [];

  const fixedPhrases = FIXED_SMART_CLEANUP_PHRASES.map((phrase) => {
    const normalizedPhrase = normalizeText(phrase);
    return { phrase, normalizedPhrase, phraseParts: normalizedPhrase.split(" ").filter(Boolean) };
  }).filter((entry) => entry.normalizedPhrase.length > 0 && entry.phraseParts.length > 0);

  const results: PhraseMatch[] = [];
  for (const entry of fixedPhrases) {
    const tokenIds: string[] = [];
    for (let i = 0; i <= normalizedTokens.length - entry.phraseParts.length; i += 1) {
      let isMatch = true;
      for (let j = 0; j < entry.phraseParts.length; j += 1) {
        if (normalizedTokens[i + j]!.normalized !== entry.phraseParts[j]) {
          isMatch = false;
          break;
        }
      }
      if (isMatch) {
        for (let j = 0; j < entry.phraseParts.length; j += 1) tokenIds.push(normalizedTokens[i + j]!.token.id);
      }
    }
    const count = tokenIds.length / entry.phraseParts.length;
    if (count > 0) results.push({ phrase: entry.phrase, normalizedPhrase: entry.normalizedPhrase, tokenIds, count });
  }

  return results.sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase));
}

export function findPhraseTokenIds(tokens: WordToken[], phrase: string): string[] {
  const normalizedPhrase = normalizeText(phrase);
  const parts = normalizedPhrase.split(" ").filter(Boolean);
  if (parts.length === 0) return [];

  const normalizedTokens = tokens.map((token) => ({ token, normalized: normalizeText(token.text) })).filter((t) => t.normalized.length > 0);
  const ids: string[] = [];
  for (let i = 0; i <= normalizedTokens.length - parts.length; i += 1) {
    let ok = true;
    for (let j = 0; j < parts.length; j += 1) {
      if (normalizedTokens[i + j]!.normalized !== parts[j]) {
        ok = false;
        break;
      }
    }
    if (ok) for (let j = 0; j < parts.length; j += 1) ids.push(normalizedTokens[i + j]!.token.id);
  }
  return ids;
}
