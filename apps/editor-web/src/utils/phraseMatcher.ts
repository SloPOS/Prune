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

type NormalizedToken = { id: string; normalized: string };
type TokenCorpus = {
  normalizedTokens: NormalizedToken[];
  ngramIndex: Map<string, number[]>;
  maxWords: number;
};

type PreparedPhrase = {
  phrase: string;
  normalizedPhrase: string;
  wordCount: number;
};

const corpusCache = new WeakMap<WordToken[], TokenCorpus>();

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/[’]/g, "'").replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
}

function normalizePhraseText(input: string): string {
  return normalizeText(input).split(" ").filter(Boolean).join(" ");
}

function normalizedWordCount(value: string): number {
  if (!value) return 0;
  let words = 1;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 32) words += 1;
  }
  return words;
}

function normalizeWordTokens(tokens: WordToken[]): NormalizedToken[] {
  return tokens
    .map((token) => ({ id: token.id, normalized: normalizeText(token.text) }))
    .filter((token) => token.normalized.length > 0);
}

function buildNgramIndex(normalizedTokens: NormalizedToken[], maxPhraseLength: number): Map<string, number[]> {
  const index = new Map<string, number[]>();

  for (let start = 0; start < normalizedTokens.length; start += 1) {
    let key = "";
    for (let size = 1; size <= maxPhraseLength && start + size <= normalizedTokens.length; size += 1) {
      const token = normalizedTokens[start + size - 1];
      if (!token) break;

      key = size === 1 ? token.normalized : `${key} ${token.normalized}`;
      const starts = index.get(key);
      if (starts) {
        starts.push(start);
      } else {
        index.set(key, [start]);
      }
    }
  }

  return index;
}

function preparePhrases(phrases: readonly string[]): PreparedPhrase[] {
  const prepared: PreparedPhrase[] = [];
  for (const phrase of phrases) {
    const normalizedPhrase = normalizePhraseText(phrase);
    if (!normalizedPhrase) continue;
    prepared.push({ phrase, normalizedPhrase, wordCount: normalizedWordCount(normalizedPhrase) });
  }
  return prepared;
}

const FIXED_PREPARED_PHRASES = preparePhrases(FIXED_SMART_CLEANUP_PHRASES);
const FIXED_PHRASE_MAX_WORDS = FIXED_PREPARED_PHRASES.reduce((max, phrase) => Math.max(max, phrase.wordCount), 1);

function getCorpus(tokens: WordToken[], maxWords = FIXED_PHRASE_MAX_WORDS): TokenCorpus {
  const cached = corpusCache.get(tokens);
  if (cached && cached.maxWords >= maxWords) return cached;

  const normalizedTokens = cached?.normalizedTokens ?? normalizeWordTokens(tokens);
  const ngramIndex = buildNgramIndex(normalizedTokens, maxWords);
  const corpus = { normalizedTokens, ngramIndex, maxWords };
  corpusCache.set(tokens, corpus);
  return corpus;
}

function findMatchingTokenIds(index: Map<string, number[]>, normalizedTokens: NormalizedToken[], normalizedPhrase: string, phraseWordCount: number): string[] {
  if (!normalizedPhrase || phraseWordCount <= 0) return [];

  const starts = index.get(normalizedPhrase);
  if (!starts || starts.length === 0) return [];

  const ids: string[] = [];
  for (const start of starts) {
    for (let offset = 0; offset < phraseWordCount; offset += 1) {
      const token = normalizedTokens[start + offset];
      if (token) ids.push(token.id);
    }
  }
  return ids;
}

export function buildPhraseMatches(tokens: WordToken[]): PhraseMatch[] {
  const { normalizedTokens, ngramIndex } = getCorpus(tokens, FIXED_PHRASE_MAX_WORDS);
  if (normalizedTokens.length === 0) return [];

  const results: PhraseMatch[] = [];
  for (const phrase of FIXED_PREPARED_PHRASES) {
    const tokenIds = findMatchingTokenIds(ngramIndex, normalizedTokens, phrase.normalizedPhrase, phrase.wordCount);
    if (tokenIds.length === 0) continue;

    const count = tokenIds.length / phrase.wordCount;
    if (count > 0) {
      results.push({
        phrase: phrase.phrase,
        normalizedPhrase: phrase.normalizedPhrase,
        tokenIds,
        count,
      });
    }
  }

  return results.sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase));
}

export function findPhraseTokenIds(tokens: WordToken[], phrase: string): string[] {
  const normalizedPhrase = normalizePhraseText(phrase);
  if (!normalizedPhrase) return [];

  const phraseWordCount = normalizedWordCount(normalizedPhrase);
  const { normalizedTokens, ngramIndex } = getCorpus(tokens, Math.max(FIXED_PHRASE_MAX_WORDS, phraseWordCount));
  return findMatchingTokenIds(ngramIndex, normalizedTokens, normalizedPhrase, phraseWordCount);
}
