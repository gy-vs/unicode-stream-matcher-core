// Legacy normalized full-string search (kept for backward compatibility).
export type Match = { start: number; end: number };

export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase();
}

export function findMatches(text: string, query: string): Match[] {
  const haystack = normalizeText(text);
  const needle = normalizeText(query);
  const out: Match[] = [];
  let at = 0;
  while (needle && (at = haystack.indexOf(needle, at)) >= 0) {
    out.push({ start: at, end: at + needle.length });
    at += Math.max(1, needle.length);
  }
  return out;
}

// Streaming multi-pattern Unicode search.
export { IncrementalUtf8Decoder, Utf8DecodeError } from './utf8.js';
export { GraphemeGrouper, classify } from './grapheme.js';
export { normalizeCodePoint, normalizePattern } from './normalize.js';
export { AhoCorasick } from './automaton.js';
export { UnicodeStreamMatcher } from './matcher.js';
export { searchBytes, searchStream, searchText, SearchAbortedError } from './pipeline.js';
export type {
  ByteSpan,
  DecodeMode,
  DecodedItem,
  EmptyPatternPolicy,
  MatcherStats,
  NormUnit,
  StreamMatch,
  StreamMatcherOptions,
  Utf16Span,
} from './types.js';
