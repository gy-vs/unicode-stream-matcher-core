/**
 * A decoded code point with its position in the original stream.
 *
 * `byteStart` / `byteEnd` are offsets in the raw byte stream (end exclusive).
 * `u16Start` / `u16End` are offsets counted in UTF-16 code units (end
 * exclusive). A U+FFFD emitted in `replace` mode carries the span of the
 * malformed byte(s) it replaced (one code unit wide on the UTF-16 axis).
 */
export interface DecodedItem {
  cp: number;
  byteStart: number;
  byteEnd: number;
  u16Start: number;
  u16End: number;
}

/**
 * One UTF-16 code unit of normalized text, attributed to the source code
 * point it was derived from (NFD + case fold). Supplementary code points
 * occupy two units with an identical span; dropped combining marks never
 * appear here.
 */
export interface NormUnit extends DecodedItem {
  unit: string;
}

export interface ByteSpan {
  start: number;
  end: number;
}

export interface Utf16Span {
  start: number;
  end: number;
}

/** What to do with malformed UTF-8. */
export type DecodeMode = 'strict' | 'replace';

/**
 * Strategy for empty patterns (patterns whose normalized form is empty,
 * which includes the empty string and combining-mark-only patterns):
 *
 * - `throw`   (default): reject such patterns when the matcher is created.
 * - `match`:   report zero-width matches at every grapheme boundary and EOF.
 * - `ignore`:  silently drop such patterns.
 */
export type EmptyPatternPolicy = 'throw' | 'match' | 'ignore';

export interface StreamMatcherOptions {
  /** `replace` (default, U+FFFD substitution) or `strict` (throw). */
  mode?: DecodeMode;
  emptyPatterns?: EmptyPatternPolicy;
  /** Abort the running search; closing the consumer ends it as well. */
  signal?: AbortSignal;
}

/**
 * A reported occurrence. Offsets are in the *original* stream: byte offsets
 * index raw bytes and `u16*` index the lossy-decoded UTF-16 sequence. When
 * a match starts/ends inside a code point that produced several normalized
 * units (e.g. a decomposed or case-folded one), the span attributes to the
 * whole source code point. For empty patterns, `start === end`.
 */
export interface StreamMatch {
  patternIndex: number;
  pattern: string;
  byteStart: number;
  byteEnd: number;
  u16Start: number;
  u16End: number;
}

/** Internal live-state exposed for observability/buffer-bound assertions. */
export interface MatcherStats {
  bytes: number;
  u16: number;
  /** Bytes of the current, not-yet-committed grapheme cluster. */
  pendingBytes: number;
  /** High-water mark of {@link MatcherStats.pendingBytes}. */
  pendingBytesHighWater: number;
  /** Retained normalized history, in UTF-16 units (<= longest pattern). */
  historyUnits: number;
  /** Matches waiting for the current cluster to close. */
  pendingMatches: number;
  /** High-water mark of {@link MatcherStats.pendingMatches}. */
  pendingMatchesHighWater: number;
}
