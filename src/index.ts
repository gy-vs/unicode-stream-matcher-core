/**
 * Unicode multi-pattern search over asynchronous byte streams.
 *
 * Pipeline: incremental UTF-8 decoding -> bounded normalization fold ->
 * grapheme-cluster commit gate -> Aho-Corasick multi-pattern automaton, with
 * raw-byte and UTF-16 offsets, strict/replace malformed-input modes, empty
 * pattern policies, backpressure and cancellation.
 */

export {
	IncrementalUTF8Decoder,
	UTF8DecodeError,
} from './utf8.js';
export type { CodePointHandler } from './utf8.js';
export { foldCodePoint, foldPattern } from './fold.js';
export {
	GraphemeBoundaryTracker,
	classify,
} from './grapheme.js';
export type { GCB } from './grapheme.js';
export { AhoCorasick } from './ahoCorasick.js';
export type { PatternSpec } from './ahoCorasick.js';
export {
	SearchEngine,
	searchBytes,
} from './engine.js';
export type {
	Offsets,
	StreamMatch,
	SearchOptions,
	EmptyPatternPolicy,
	InvalidUTF8Policy,
	EngineStats,
} from './engine.js';
export {
	PatternSearchStream,
	searchStream,
	StreamCancelledError,
} from './stream.js';
export type { StreamSearchOptions } from './stream.js';

// ---- Backwards-compatible v1 helpers ---------------------------------------

export type Match = { start: number; end: number };

/** @deprecated legacy whole-string normalization retained for compatibility. */
export function normalizeText(value: string): string {
	return value
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLocaleLowerCase();
}

/** @deprecated legacy single-query helper; prefer {@link searchBytes}. */
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
