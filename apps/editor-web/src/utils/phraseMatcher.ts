import type { WordToken } from "@prune/core";

export type PhraseMatch = {
  phrase: string;
  normalizedPhrase: string;
  tokenIds: string[];
  count: number;
};

const FIXED_SMART_CLEANUP_PHRASES = [
  "um", "uh", "ah", "er", "mm-hmm",
  "like", "basically", "actually", "literally", "seriously", "honestly", "obviously",
  "anyway", "well", "now",
  "right?", "you know?", "okay?", "make sense?", "you see?",
  "i mean", "at the end of the day", "to be honest with you", "for all intents and purposes", "as a matter of fact", "it is what it is",
  "go ahead", "gone ahead", "let's go ahead", "we're gonna", "we're going to",
] as const;

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/[’]/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
}

function normalizeWordTokens(tokens: WordToken[]): Array<{ id: string; normalized: string }> {
  return tokens
    .map((token) => ({ id: token.id, normalized: normalizeText(token.text) }))
    .filter((token) => token.normalized.length > 0);
}

function findMatchingTokenIds(
  normalizedTokens: Array<{ id: string; normalized: string }>,
  phraseParts: string[],
): string[] {
  if (phraseParts.length === 0 || normalizedTokens.length < phraseParts.length) return [];

  const ids: string[] = [];
  for (let i = 0; i <= normalizedTokens.length - phraseParts.length; i += 1) {
    let isMatch = true;
    for (let j = 0; j < phraseParts.length; j += 1) {
      if (normalizedTokens[i + j]!.normalized !== phraseParts[j]) {
        isMatch = false;
        break;
      }
    }
    if (isMatch) {
      for (let j = 0; j < phraseParts.length; j += 1) ids.push(normalizedTokens[i + j]!.id);
    }
  }
  return ids;
}

export function buildPhraseMatches(tokens: WordToken[]): PhraseMatch[] {
  const normalizedTokens = normalizeWordTokens(tokens);
  if (normalizedTokens.length === 0) return [];

  const fixedPhrases = FIXED_SMART_CLEANUP_PHRASES.map((phrase) => {
    const normalizedPhrase = normalizeText(phrase);
    return { phrase, normalizedPhrase, phraseParts: normalizedPhrase.split(" ").filter(Boolean) };
  }).filter((entry) => entry.normalizedPhrase.length > 0 && entry.phraseParts.length > 0);

  const results: PhraseMatch[] = [];
  for (const entry of fixedPhrases) {
    const tokenIds = findMatchingTokenIds(normalizedTokens, entry.phraseParts);
    const count = tokenIds.length / entry.phraseParts.length;
    if (count > 0) results.push({ phrase: entry.phrase, normalizedPhrase: entry.normalizedPhrase, tokenIds, count });
  }

  return results.sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase));
}

export function findPhraseTokenIds(tokens: WordToken[], phrase: string): string[] {
  const parts = normalizeText(phrase).split(" ").filter(Boolean);
  const normalizedTokens = normalizeWordTokens(tokens);
  return findMatchingTokenIds(normalizedTokens, parts);
}
