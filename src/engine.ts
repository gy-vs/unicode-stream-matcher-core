/**
 * Streaming multi-pattern search engine.
 *
 * Pipeline:
 *
 *   bytes -> incremental UTF-8 (strict / U+FFFD replace)
 *         -> per-code-point fold (lowercase -> NFD -> strip marks)
 *         -> grapheme cluster boundary gate (commit safety)
 *         -> Aho-Corasick on folded UTF-16 code units
 *
 * Commit rule ("只有确认不会再被后续组合字符改变的前缀才能提交"):
 * a folded unit is the live "tail" while its grapheme cluster is open. A match
 * that ends at the tail is withheld until the next cluster starts (or the
 * stream ends), because a following combining mark may still extend the
 * match's end offsets. Nothing older than the tail is ever buffered: the
 * automaton state is fixed-size and the start-offset ring holds exactly
 * maxPatternLength + 1 entries — independent of stream length for every
 * pattern set.
 */

import {
	IncrementalUTF8Decoder,
	UTF8DecodeError,
	type CodePointHandler,
} from './utf8.js';
import { foldCodePoint, foldPattern } from './fold.js';
import { GraphemeBoundaryTracker } from './grapheme.js';
import { AhoCorasick } from './ahoCorasick.js';

export type { UTF8DecodeError };

export interface Offsets {
	/** Zero-based byte offset in the original (raw) stream. */
	byte: number;
	/** Zero-based UTF-16 code-unit offset of the decoded stream. */
	utf16: number;
}

export interface StreamMatch {
	/** Index into the original patterns array. */
	pattern: number;
	start: Offsets;
	end: Offsets;
}

export type EmptyPatternPolicy = 'none' | 'start' | 'all';
export type InvalidUTF8Policy = 'strict' | 'replace';

export interface SearchOptions {
	/** Decoder behavior on malformed byte sequences. Default 'replace'. */
	onInvalid?: InvalidUTF8Policy;
	/**
	 * Where patterns that fold to an empty string (e.g. '' or combining marks)
	 * report zero-length matches: 'none' (never), 'start' (stream start only),
	 * 'all' (at every folded-unit boundary plus start and end). Default 'all'.
	 */
	emptyPatterns?: EmptyPatternPolicy;
}

interface Span {
	byteStart: number;
	byteEnd: number;
	u16Start: number;
	u16End: number;
}

interface HeldMatch {
	pattern: number;
	startSpan: Span;
	endSpan: Span;
}

export interface EngineStats {
	/** Bytes currently held by the incremental decoder (incomplete sequence). */
	decoderPendingBytes: number;
	/** Start-span slots in the offset ring (max folded pattern length + 1). */
	ringCapacity: number;
	/** Matches currently withheld pending cluster confirmation. */
	heldMatchCount: number;
	/** Aho-Corasick state count (depends only on patterns). */
	automatonStates: number;
	/** Total folded UTF-16 units consumed (grows with the stream; not a buffer). */
	foldedUnits: number;
	/** Total bytes consumed. */
	bytesConsumed: number;
}

export class SearchEngine {
	private readonly onInvalid: InvalidUTF8Policy;
	private readonly emptyPolicy: EmptyPatternPolicy;
	private readonly emptyPatternIndices: number[];
	private readonly wordLengths: number[];
	private readonly hasNonEmpty: boolean;
	private readonly ringCapacity: number;
	private readonly ac: AhoCorasick;

	private decoder = new IncrementalUTF8Decoder();
	private clusters = new GraphemeBoundaryTracker();
	private state = 0;
	private foldedPos = 0;
	private bytePos = 0;
	private u16Pos = 0;

	/** Circular start-span history, indexed by folded position mod capacity. */
	private ring: Span[] = [];
	/** The live tail span (mutated when trailing marks extend the cluster). */
	private tail: Span | null = null;
	private held: HeldMatch[] = [];
	private outputs: number[] = [];
	private started = false;
	private finished = false;
	/** Encoded position of the last emitted zero-width boundary (dedupe). */
	private lastEmptyBoundary: number | null = null;

	constructor(patterns: readonly string[], options: SearchOptions = {}) {
		this.onInvalid = options.onInvalid ?? 'replace';
		this.emptyPolicy = options.emptyPatterns ?? 'all';

		const nonEmpty: Array<{ index: number; word: string }> = [];
		this.emptyPatternIndices = [];
		this.wordLengths = new Array(patterns.length).fill(0);
		for (let i = 0; i < patterns.length; i++) {
			const word = foldPattern(patterns[i]);
			this.wordLengths[i] = word.length;
			if (word.length === 0) {
				this.emptyPatternIndices.push(i);
			} else {
				nonEmpty.push({ index: i, word });
			}
		}
		this.hasNonEmpty = nonEmpty.length > 0;
		this.ac = new AhoCorasick(nonEmpty);
		let maxLen = 0;
		for (const { word } of nonEmpty) maxLen = Math.max(maxLen, word.length);
		this.ringCapacity = maxLen + 1;
	}

	private onMatch: (m: StreamMatch) => void = () => {};

	/** Attach the match sink; must be called before `write`. */
	pipe(sink: (m: StreamMatch) => void): this {
		this.onMatch = sink;
		return this;
	}

	write(chunk: Uint8Array): void {
		if (this.finished) throw new Error('SearchEngine: write after end()');
		const handler: CodePointHandler = {
			onCodePoint: (cp, byteLength) => {
				this.bytePos += byteLength;
				this.consumeCodePoint(cp, byteLength);
			},
			onError: (byteLength, startOffset, invalidOffset) => {
				this.handleError(byteLength, startOffset, invalidOffset);
			},
		};
		this.decoder.write(chunk, this.bytePos, handler);
	}

	end(): void {
		if (this.finished) return;
		this.decoder.end(this.bytePos, {
			onCodePoint: (cp, byteLength) => {
				this.bytePos += byteLength;
				this.consumeCodePoint(cp, byteLength);
			},
			onError: (byteLength, startOffset, invalidOffset) => {
				this.handleError(byteLength, startOffset, invalidOffset);
			},
		});
		// Confirm the final open cluster and emit the end-boundary zero-width
		// matches (policy 'all'), deduplicated against prior emissions.
		this.commitTail(this.bytePos, this.u16Pos);
		if (!this.started) {
			// Empty stream: start and end coincide at 0.
			this.emitBoundary(0, 0);
		}
		this.finished = true;
	}

	get stats(): EngineStats {
		return {
			decoderPendingBytes: this.decoder.pendingBytes,
			ringCapacity: this.ringCapacity,
			heldMatchCount: this.held.length,
			automatonStates: this.ac.stateCount,
			foldedUnits: this.foldedPos,
			bytesConsumed: this.bytePos,
		};
	}

	private handleError(byteLength: number, startOffset: number, invalidOffset: number): void {
		if (this.onInvalid === 'strict') {
			throw new UTF8DecodeError(startOffset, invalidOffset);
		}
		// Replacement: the subpart becomes U+FFFD (the offending lead byte is
		// reprocessed by the decoder and accounted for independently).
		this.bytePos += byteLength;
		this.consumeCodePoint(0xfffd, byteLength as 1 | 2 | 3);
	}

	private consumeCodePoint(cp: number, byteLength: number): void {
		const startByte = this.bytePos - byteLength;
		const startU16 = this.u16Pos;
		const units = foldCodePoint(cp);
		const unitsForU16 = cp > 0xffff ? 2 : 1;
		this.u16Pos += unitsForU16;
		const endByte = this.bytePos;
		const endU16 = this.u16Pos;

		const newCluster = this.clusters.feed(cp);
		if (newCluster) {
			// Commit the previous tail before opening the new cluster. The
			// boundary sits at the previous tail's END (or at stream start when
			// the stream has produced no folded units yet).
			if (this.tail !== null) {
				this.commitTail(this.tail.byteEnd, this.tail.u16End);
			}
		}

		if (units.length === 0) {
			// Pure combining mark: it folds away, but while it stays inside the
			// open cluster it extends the live tail's end offsets.
			if (!newCluster && this.tail !== null) {
				this.tail.byteEnd = endByte;
				this.tail.u16End = endU16;
			}
			return;
		}

		if (!this.started) {
			this.started = true;
			// Zero-length matches at stream start (position 0).
			this.emitBoundary(0, 0);
		}

		for (let j = 0; j < units.length; j++) {
			// Additional units of one code point end no cluster, yet the previous
			// unit ceases to be the live tail and is confirmed.
			if (j > 0) {
				this.commitTail(this.tail!.byteEnd, this.tail!.u16End);
			}
			const span: Span = {
				byteStart: startByte,
				byteEnd: endByte,
				u16Start: startU16,
				u16End: endU16,
			};
			if (this.hasNonEmpty) {
				this.ring[this.foldedPos % this.ringCapacity] = span;
			}
			this.tail = span;

			if (this.hasNonEmpty) {
				this.outputs.length = 0;
				this.state = this.ac.step(
					this.state,
					units.charCodeAt(j),
					this.outputs,
				);
				const pos = this.foldedPos;
				const held: HeldMatch[] = [];
				for (const patternIndex of this.outputs) {
					const len = this.wordLengths[patternIndex];
					const startSpan =
						this.ring[(((pos - len + 1) % this.ringCapacity) + this.ringCapacity) % this.ringCapacity];
					held.push({
						pattern: patternIndex,
						startSpan,
						endSpan: span,
					});
				}
				// Held matches are exactly those ending at the tail. They stay
				// withheld until the tail is confirmed (next cluster or EOF); the
				// end span may still be extended by trailing combining marks.
				this.held = held;
			}

			this.foldedPos += 1;
		}
	}

	/**
	 * Commit the previously-withheld tail matches. Zero-length matches at the
	 * boundary are emitted afterwards, guaranteeing non-empty matches precede
	 * zero-length ones sharing the same position.
	 */
	/**
	 * Confirm the live tail: flush withheld non-empty matches (longest-first)
	 * and then emit zero-length matches at the boundary. Called when a new
	 * cluster starts, a multi-unit code point advances past the previous unit,
	 * or the stream ends.
	 */
	private commitTail(byte: number, u16: number): void {
		for (const m of this.held) {
			this.onMatch({
				pattern: m.pattern,
				start: { byte: m.startSpan.byteStart, utf16: m.startSpan.u16Start },
				end: { byte: m.endSpan.byteEnd, utf16: m.endSpan.u16End },
			});
		}
		this.held = [];
		this.emitBoundary(byte, u16);
	}

	/**
	 * Emit zero-length matches at a folded-unit boundary. Boundaries are reached
	 * through several internal paths (stream start, multi-unit gap, cluster
	 * boundary, EOF); the byte-position key guarantees exactly one emission.
	 */
	private emitBoundary(byte: number, u16: number): void {
		if (this.emptyPolicy === 'none') return;
		if (this.lastEmptyBoundary === byte) return;
		this.lastEmptyBoundary = byte;
		if (this.emptyPolicy === 'start' && byte !== 0) return;
		for (const patternIndex of this.emptyPatternIndices) {
			this.onMatch({
				pattern: patternIndex,
				start: { byte, utf16: u16 },
				end: { byte, utf16: u16 },
			});
		}
	}
}

/** Convenience: whole-buffer search using the exact same streaming core. */
export function searchBytes(
	bytes: Uint8Array,
	patterns: readonly string[],
	options?: SearchOptions,
): StreamMatch[] {
	const out: StreamMatch[] = [];
	const engine = new SearchEngine(patterns, options);
	engine.pipe((m) => out.push(m));
	engine.write(bytes);
	engine.end();
	return out;
}
