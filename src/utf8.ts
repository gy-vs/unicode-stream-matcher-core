import type { DecodeMode, DecodedItem } from './types.js';

/**
 * Raised in strict mode for malformed UTF-8. `byteStart`/`byteEnd` span the
 * bytes that triggered the error; `u16Start` is the UTF-16 offset at which a
 * U+FFFD would have been emitted in replace mode.
 */
export class Utf8DecodeError extends Error {
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly u16Start: number;

  constructor(message: string, byteStart: number, byteEnd: number, u16Start: number) {
    super(message);
    this.name = 'Utf8DecodeError';
    this.byteStart = byteStart;
    this.byteEnd = byteEnd;
    this.u16Start = u16Start;
  }
}

/**
 * Streaming UTF-8 decoder implementing the WHATWG Encoding standard
 * (https://encoding.spec.whatwg.org/#utf-8-decoder), faithful "three
 * continuations" structure:
 *
 *   index 1 validates the first continuation byte (per-lead lower bound);
 *   index 2 the second; index 3 the third.
 *
 * State is bounded to a single in-flight sequence (at most 3 carried bytes)
 * no matter how input is chunked. Each emitted {@link DecodedItem} carries
 * its exact raw-byte and UTF-16 offsets; in replace mode a U+FFFD spans the
 * consumed bad bytes, and end-of-stream of a truncated 4-byte sequence
 * emits the required *second* replacement for the orphaned continuation.
 */
export class IncrementalUtf8Decoder {
  private cp = 0;
  private index = 0; // 0 = expect a lead byte
  private bytesNeeded = 0;
  private seqStart = 0;
  private _bytePos = 0;
  private _u16Pos = 0;

  constructor(private readonly mode: DecodeMode = 'replace') {}

  get bytePos(): number {
    return this._bytePos;
  }

  get u16Pos(): number {
    return this._u16Pos;
  }

  /** Bytes carried over from previous chunks for an unfinished sequence. */
  get heldBytes(): number {
    return this.index;
  }

  private makeError(start: number, end: number): DecodedItem {
    if (this.mode === 'strict') {
      throw new Utf8DecodeError(
        `Malformed UTF-8 at byte offset ${start}`,
        start,
        end,
        this._u16Pos,
      );
    }
    const item: DecodedItem = {
      cp: 0xfffd,
      byteStart: start,
      byteEnd: end,
      u16Start: this._u16Pos,
      u16End: this._u16Pos + 1,
    };
    this._u16Pos += 1;
    return item;
  }

  private makeCp(cp: number, start: number, end: number): DecodedItem {
    const width = cp > 0xffff ? 2 : 1;
    const item: DecodedItem = {
      cp,
      byteStart: start,
      byteEnd: end,
      u16Start: this._u16Pos,
      u16End: this._u16Pos + width,
    };
    this._u16Pos += width;
    return item;
  }

  push(chunk: Uint8Array): DecodedItem[] {
    const out: DecodedItem[] = [];
    const base = this._bytePos;
    this._bytePos += chunk.length;
    let i = 0;

    while (i < chunk.length) {
      const pos = base + i;
      const byte = chunk[i];

      if (this.index === 0) {
        if (byte <= 0x7f) {
          out.push(this.makeCp(byte, pos, pos + 1));
          i++;
          continue;
        } else if (byte >= 0xc2 && byte <= 0xdf) {
          this.bytesNeeded = 2;
          this.index = 1;
          this.cp = byte - 0xc0;
        } else if (byte >= 0xe0 && byte <= 0xef) {
          this.bytesNeeded = 3;
          this.index = 1;
          this.cp = byte - 0xe0;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          this.bytesNeeded = 4;
          this.index = 1;
          this.cp = byte - 0xf0;
        } else {
          out.push(this.makeError(pos, pos + 1));
        }
        this.seqStart = pos;
        i++;
        continue;
      }

      // Continuation handling, parameterized by the position in the
      // sequence. "lowerBound/upperBound" encode the per-index validity
      // conditions without mutating `index` until the byte is accepted.
      const needsCheck = this.index === 1;
      let ok: boolean;
      let forbidden = false;
      if (needsCheck && this.bytesNeeded === 3) {
        if (this.cp === 0) {
          // E0: A0..BF only; 80..9F is a forbidden continuation; ASCII
          // reprocesses.
          ok = byte >= 0xa0 && byte <= 0xbf;
          forbidden = byte >= 0x80 && byte <= 0x9f;
        } else if (this.cp === 13) {
          // ED: 80..9F only; A0..BF would build a surrogate (forbidden).
          ok = byte >= 0x80 && byte <= 0x9f;
          forbidden = byte >= 0xa0 && byte <= 0xbf;
        } else {
          ok = byte >= 0x80 && byte <= 0xbf;
        }
      } else if (needsCheck && this.bytesNeeded === 4) {
        if (this.cp === 0) {
          // F0: 90..BF only; 80..8F forbidden.
          ok = byte >= 0x90 && byte <= 0xbf;
          forbidden = byte >= 0x80 && byte <= 0x8f;
        } else if (this.cp === 4) {
          // F4: 80..8F only; 90..BF forbidden (> U+10FFFF).
          ok = byte >= 0x80 && byte <= 0x8f;
          forbidden = byte >= 0x90 && byte <= 0xbf;
        } else {
          ok = byte >= 0x80 && byte <= 0xbf;
        }
      } else {
        ok = byte >= 0x80 && byte <= 0xbf;
      }

      if (!ok) {
        // First emit a replacement for the lead + accepted continuations.
        out.push(this.makeError(this.seqStart, pos));
        if (forbidden) {
          // The forbidden continuation byte is itself invalid: consume it
          // and emit a second U+FFFD (later bytes then stand alone).
          out.push(this.makeError(pos, pos + 1));
          i++;
        }
        // Otherwise the current byte is reprocessed (i stays put).
        this.index = 0;
        this.bytesNeeded = 0;
        continue;
      }

      this.cp = (this.cp << 6) | (byte - 0x80);
      this.index++;
      i++;
      if (this.index === this.bytesNeeded) {
        out.push(this.makeCp(this.cp, this.seqStart, pos + 1));
        this.index = 0;
        this.bytesNeeded = 0;
      }
    }
    return out;
  }

  end(): DecodedItem[] {
    if (this.index === 0) return [];
    const start = this.seqStart;
    const end = this._bytePos;
    this.index = 0;
    this.bytesNeeded = 0;
    // EOF: one U+FFFD spans every carried byte (lead + continuations).
    return [this.makeError(start, end)];
  }
}
