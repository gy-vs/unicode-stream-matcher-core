/**
 * Incremental UTF-8 decoder implementing the WHATWG Encoding Standard
 * (https://encoding.spec.whatwg.org/#utf-8-decoder) byte-at-a-time semantics,
 * including maximal-subpart replacement on malformed input.
 *
 * Error policy is left to the caller via `onError`: strict mode throws,
 * replacement mode maps the subpart to U+FFFD. `byteLength` is the number of
 * original bytes consumed by the event (1..4 for a code point; 1..3 for an
 * error subpart), which lets callers maintain exact byte offsets.
 */
export class UTF8DecodeError extends Error {
	/** Absolute byte offset where the malformed subpart starts. */
	readonly byteOffset: number;
	/** Absolute byte offset of the byte that triggered the failure. */
	readonly invalidByteOffset: number;

	constructor(byteOffset: number, invalidByteOffset: number) {
		super(
			`Malformed UTF-8 byte sequence at byte offset ${invalidByteOffset} (subpart starts at ${byteOffset})`,
		);
		this.name = 'UTF8DecodeError';
		this.byteOffset = byteOffset;
		this.invalidByteOffset = invalidByteOffset;
	}
}

export interface CodePointHandler {
	onCodePoint(cp: number, byteLength: 1 | 2 | 3 | 4): void;
	onError(byteLength: number, startOffset: number, invalidOffset: number): void;
}

const CONT_LOWER = 0x80;
const CONT_UPPER = 0xbf;

export class IncrementalUTF8Decoder {
	private needed = 0;
	private seen = 0;
	private acc = 0;
	private lowerBoundary = CONT_LOWER;
	private upperBoundary = CONT_UPPER;
	private pendingStart = 0;

	/** Bytes of the in-flight partial sequence (0 when idle). */
	get pendingBytes(): number {
		return this.seen;
	}

	reset(): void {
		this.needed = 0;
		this.seen = 0;
		this.acc = 0;
	}

	write(bytes: Uint8Array, baseOffset: number, handler: CodePointHandler): void {
		const len = bytes.length;
		let i = 0;
		while (i < len) {
			if (this.needed === 0) {
				const b = bytes[i];
				if (b <= 0x7f) {
					handler.onCodePoint(b, 1);
					i += 1;
					continue;
				}
				this.lowerBoundary = CONT_LOWER;
				this.upperBoundary = CONT_UPPER;
				if (b >= 0xc2 && b <= 0xdf) {
					this.needed = 2;
					this.acc = b & 0x1f;
				} else if (b === 0xe0) {
					this.needed = 3;
					this.lowerBoundary = 0xa0;
					this.acc = b & 0x0f;
				} else if (b >= 0xe1 && b <= 0xec) {
					this.needed = 3;
					this.acc = b & 0x0f;
				} else if (b === 0xed) {
					this.needed = 3;
					this.upperBoundary = 0x9f;
					this.acc = b & 0x0f;
				} else if (b >= 0xee && b <= 0xef) {
					this.needed = 3;
					this.acc = b & 0x0f;
				} else if (b === 0xf0) {
					this.needed = 4;
					this.lowerBoundary = 0x90;
					this.acc = b & 0x07;
				} else if (b >= 0xf1 && b <= 0xf3) {
					this.needed = 4;
					this.acc = b & 0x07;
				} else if (b === 0xf4) {
					this.needed = 4;
					this.upperBoundary = 0x8f;
					this.acc = b & 0x07;
				} else {
					// Bare continuation (0x80..0xBF), overlong lead 0xC0/0xC1, or 0xF5..0xFF.
					handler.onError(1, baseOffset + i, baseOffset + i);
					i += 1;
					continue;
				}
				this.seen = 1;
				this.pendingStart = baseOffset + i;
				i += 1;
			}

			// Continue / start consuming continuation bytes.
			while (this.seen < this.needed) {
				if (i >= len) {
					// Chunk ended mid-sequence: state persists for the next write.
					return;
				}
				const b = bytes[i];
				const outOfRange = b < CONT_LOWER || b > CONT_UPPER;
				const outOfBoundary =
					this.seen === 1 && (b < this.lowerBoundary || b > this.upperBoundary);
				if (outOfRange || outOfBoundary) {
					// WHATWG: already-consumed lead bytes form the error subpart;
					// the offending byte is prepended (reprocessed as a fresh lead).
					const consumed = this.seen;
					const start = this.pendingStart;
					const invalid = baseOffset + i;
					this.reset();
					handler.onError(consumed, start, invalid);
					break; // re-enter outer loop with the same byte
				}
				this.acc = (this.acc << 6) | (b & 0x3f);
				this.seen += 1;
				i += 1;
			}

			if (this.needed === 0) {
				// Error path: state reset; offending byte will be reprocessed.
				continue;
			}

			const cp = this.acc;
			const seqLen = this.needed as 2 | 3 | 4;
			const seqStart = this.pendingStart;
			const lastByteOffset = baseOffset + i - 1;
			this.reset();
			// Surrogates and values outside Unicode scalar values cannot occur
			// thanks to the E0/ED/F0/F4 boundary rules above; this is defensive.
			if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
				handler.onError(seqLen, seqStart, lastByteOffset);
			} else {
				handler.onCodePoint(cp, seqLen);
			}
		}
	}

	/** Signal end of stream; a truncated sequence is one error subpart. */
	end(baseOffset: number, handler: CodePointHandler): void {
		if (this.needed !== 0) {
			const consumed = this.seen;
			const start = this.pendingStart;
			this.reset();
			// The truncation is "detected" at one past the last stream byte.
			handler.onError(consumed, start, baseOffset);
		}
	}
}
