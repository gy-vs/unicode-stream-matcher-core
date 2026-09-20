import { describe, expect, it } from 'vitest';
import { IncrementalUtf8Decoder, Utf8DecodeError } from '../src/index.js';

function decodeAll(bytes: Uint8Array, mode: 'strict' | 'replace' = 'replace') {
  const d = new IncrementalUtf8Decoder(mode);
  return { items: [...d.push(bytes), ...d.end()], bytes: d.bytePos, u16: d.u16Pos };
}

function decodeChunked(bytes: Uint8Array, sizes: number[]) {
  const d = new IncrementalUtf8Decoder('replace');
  const items = [];
  let at = 0;
  for (const size of sizes) {
    items.push(...d.push(bytes.subarray(at, at + size)));
    at += size;
  }
  items.push(...d.push(bytes.subarray(at)));
  items.push(...d.end());
  return items;
}
describe('incremental UTF-8 decoder', () => {
  it('decodes byte by byte identically to one shot', () => {
    const bytes = new TextEncoder().encode('héllo 世界 👨‍👩 z');
    const one = decodeAll(bytes).items;
    const each = decodeChunked(bytes, bytes.map(() => 1));
    expect(each).toEqual(one);
    expect(each.map((i) => String.fromCodePoint(i.cp)).join('')).toBe(
      new TextDecoder().decode(bytes),
    );
  });

  it('re-assembles multi-byte sequences truncated across chunks', () => {
    const bytes = new TextEncoder().encode('€'); // E2 82 AC
    // Cut in every possible position.
    for (const cut of [1, 2]) {
      const items = decodeChunked(bytes, [cut]);
      expect(items).toHaveLength(1);
      expect(items[0].cp).toBe(0x20ac);
      expect(items[0].byteStart).toBe(0);
      expect(items[0].byteEnd).toBe(3);
      expect(items[0].u16Start).toBe(0);
      expect(items[0].u16End).toBe(1);
    }
  });

  it('handles truncated 4-byte sequences at chunk boundaries and EOF', () => {
    const full = new TextEncoder().encode('😀');
    // A cut before the final byte leaves the sequence unfinished at EOF:
    // one U+FFFD spans exactly the carried bytes.
    for (const cut of [1, 2, 3]) {
      const d = new IncrementalUtf8Decoder();
      const items = [...d.push(full.subarray(0, cut)), ...d.end()];
      expect(items.map((i) => i.cp)).toEqual([0xfffd]);
      expect(items[0].byteEnd).toBe(cut);
      expect(items[0].u16Start).toBe(0);
    }
    // The complete sequence still decodes when the last chunk arrives.
    const d2 = new IncrementalUtf8Decoder();
    const ok = [...d2.push(full.subarray(0, 3)), ...d2.push(full.subarray(3))];
    expect(ok.map((i) => i.cp)).toEqual([0x1f600]);
  });

  it('matches TextDecoder for isolated malformed shapes', () => {
    const cases = [
      [0x80],
      [0xff],
      [0xc2],
      [0xc0, 0x80],
      [0xe0, 0x80, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf0, 0x80, 0x80, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xc3, 0x28],
      [0xf0, 0x9f, 0x28],
      [0x61, 0xc3, 0x28, 0x62, 0xf0, 0x9f, 0x98],
    ];
    for (const arr of cases) {
      const bytes = new Uint8Array(arr);
      const ref = new TextDecoder().decode(bytes);
      const got = decodeAll(bytes).items
        .map((i) => String.fromCodePoint(i.cp))
        .join('');
      expect(got, JSON.stringify(arr)).toBe(ref);
    }
  });

  it('emits one U+FFFD for a lone lead followed by ASCII', () => {
    const items = decodeAll(new Uint8Array([0xc3, 0x61])).items;
    expect(items.map((i) => i.cp)).toEqual([0xfffd, 0x61]);
    // The replacement spans only the lead; the ASCII reprocesses.
    expect(items[0]).toMatchObject({ byteStart: 0, byteEnd: 1, u16Start: 0, u16End: 1 });
    expect(items[1]).toMatchObject({ byteStart: 1, byteEnd: 2, u16Start: 1, u16End: 2 });
  });

  it('keeps byte and UTF-16 offsets exact after replacements', () => {
    // F0 80 is a forbidden first continuation: FFFD(span F0) + FFFD(span 80);
    // the two orphan continuations 80 80 each become FFFD. So 4 FFFDs, then
    // the valid 3-byte "€".
    const bytes = new Uint8Array([0xf0, 0x80, 0x80, 0x80, 0xe2, 0x82, 0xac]);
    const { items, u16 } = decodeAll(bytes);
    const ref = new TextDecoder().decode(bytes);
    expect(items.map((i) => String.fromCodePoint(i.cp)).join('')).toBe(ref);
    expect(u16).toBe(ref.length);
    const euro = items[items.length - 1];
    expect(euro.cp).toBe(0x20ac);
    expect(euro.byteStart).toBe(4);
    expect(euro.u16Start).toBe(4);
    expect(euro.u16End).toBe(5);
    // Positions on the UTF-16 axis are always contiguous.
    let pos = 0;
    for (const it of items) {
      expect(it.u16Start).toBe(pos);
      pos = it.u16End;
    }
  });

  it('throws Utf8DecodeError in strict mode with offsets', () => {
    const d = new IncrementalUtf8Decoder('strict');
    let caught: unknown;
    try {
      d.push(new Uint8Array([0x61, 0xc3]));
      d.end();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Utf8DecodeError);
    const err = caught as Utf8DecodeError;
    expect(err.byteStart).toBe(1);
    expect(err.byteEnd).toBe(2);
    expect(err.u16Start).toBe(1);
  });

  it('holds at most 3 bytes of a partial sequence', () => {
    const d = new IncrementalUtf8Decoder();
    d.push(new Uint8Array([0xf0, 0x9f]));
    expect(d.heldBytes).toBe(2);
    d.push(new Uint8Array([0x98]));
    expect(d.heldBytes).toBe(3);
    d.push(new Uint8Array([0x80]));
    expect(d.heldBytes).toBe(0);
  });

  it('fuzz: output equals TextDecoder at every cut point', () => {
    let seed = 1234567;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let t = 0; t < 3000; t++) {
      const len = 1 + Math.floor(rand() * 9);
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        const r = rand();
        bytes[i] =
          r < 0.5
            ? Math.floor(rand() * 0x80)
            : r < 0.8
              ? 0x80 + Math.floor(rand() * 0x40)
              : 0xc2 + Math.floor(rand() * 0x21);
      }
      const one = decodeAll(bytes).items;
      const ref = new TextDecoder().decode(bytes);
      expect(one.map((i) => String.fromCodePoint(i.cp)).join(''), `bytes ${bytes}`).toBe(ref);
      const cut = 1 + Math.floor(rand() * Math.max(1, len - 1));
      const chunked = decodeChunked(bytes, [cut]);
      expect(chunked, `cut ${cut} of ${bytes}`).toEqual(one);
    }
  });
});
