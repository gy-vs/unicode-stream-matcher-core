/**
 * Streaming-friendly normalization used for both patterns and haystack:
 *
 *   code point -> NFD (canonical decomposition, reordered into canonical
 *   order) -> lowercase -> strip combining marks.
 *
 * The operation is applied independently to each source code point. That is
 * deliberately weaker than normalizing a whole string: `String.toLowerCase`
 * has no cross-code-point context mappings, and after NFD every combining
 * mark is stripped anyway, so per-code-point application yields the same
 * sequence as whole-text processing while letting every output unit carry
 * the exact source span it was derived from. Each emitted entry is one
 * UTF-16 code unit (astral folds may emit a surrogate pair sharing a span).
 */
export interface NormEntry {
  unit: string;
}

const MARK_RE = /\p{M}/u;

const cache = new Map<number, string>();

/**
 * Normalize one source code point to zero or more UTF-16 units.
 * Returns the empty string for code points removed entirely (combining
 * marks, e.g. the acute accent in "café" after decomposition).
 */
export function normalizeCodePoint(cp: number): string {
  let folded = cache.get(cp);
  if (folded !== undefined) return folded;

  const decomposed = String.fromCodePoint(cp).normalize('NFD');
  let out = '';
  // NFD is canonically ordered already. After stripping marks the remaining
  // starter(s) keep their relative order, so iterating the decomposition is
  // sufficient; per-code-point application matches whole-text processing
  // because toLowerCase has no cross-code-point mappings.
  for (const ch of decomposed) {
    if (MARK_RE.test(ch)) continue;
    out += ch.toLowerCase();
  }
  folded = out;
  cache.set(cp, folded);
  return folded;
}

/**
 * Normalize an entire pattern string (convenience used at pattern compile
 * time, where streaming spans do not matter).
 */
export function normalizePattern(pattern: string): string {
  let out = '';
  for (const ch of pattern) {
    out += normalizeCodePoint(ch.codePointAt(0)!);
  }
  return out;
}
