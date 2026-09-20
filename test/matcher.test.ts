import { describe, expect, it } from 'vitest';
import {
  searchBytes,
  searchText,
  UnicodeStreamMatcher,
  type StreamMatch,
} from '../src/index.js';

const enc = new TextEncoder();

function runChunks(
  bytes: Uint8Array,
  patterns: string[],
  sizes: number[],
  options: { mode?: 'strict' | 'replace'; emptyPatterns?: 'throw' | 'match' | 'ignore' } = {},
): StreamMatch[] {
  const m = new UnicodeStreamMatcher(patterns, options);
  const out: StreamMatch[] = [];
  let at = 0;
  for (const size of sizes) {
    out.push(...m.write(bytes.subarray(at, at + size)));
    at += size;
  }
  out.push(...m.write(bytes.subarray(at)));
  out.push(...m.end());
  return out;
}

function everyChunking(bytes: Uint8Array, patterns: string[], options = {}) {
  const oneShot = searchBytes(bytes, patterns, options);
  // All compositions of chunk sizes of 1..3 cover every cut pattern needed;
  // additionally test every single cut point.
  for (let cut = 1; cut < bytes.length; cut++) {
    expect(runChunks(bytes, patterns, [cut], options), `cut at ${cut}`).toEqual(oneShot);
  }
  let seed = 99;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return ((seed >>> 0) % 1000) / 1000;
  };
  for (let t = 0; t < 30; t++) {
    const sizes: number[] = [];
    let total = 0;
    while (total < bytes.length) {
      const s = 1 + Math.floor(rand() * 4);
      sizes.push(s);
      total += s;
    }
    expect(runChunks(bytes, patterns, sizes, options), `sizes ${sizes}`).toEqual(oneShot);
  }
  return oneShot;
}

describe('multi-pattern stream matching', () => {
  it('reports byte and UTF-16 offsets for an ASCII overlap set', () => {
    const text = 'abcabdababc';
    const matches = searchText(text, ['ab', 'abc', 'babc', 'bc']);
    // Ordered by (end, start, patternIndex).
    expect(matches.map((m) => [m.u16Start, m.u16End, m.pattern])).toEqual([
      [0, 2, 'ab'],
      [0, 3, 'abc'],
      [1, 3, 'bc'],
      [3, 5, 'ab'],
      [6, 8, 'ab'],
      [8, 10, 'ab'],
      [7, 11, 'babc'],
      [8, 11, 'abc'],
      [9, 11, 'bc'],
    ]);
    for (const m of matches) {
      // Pure ASCII: byte and UTF-16 axes coincide.
      expect(m.byteStart).toBe(m.u16Start);
      expect(m.byteEnd).toBe(m.u16End);
    }
  });

  it('byte offsets diverge from UTF-16 after multi-byte text', () => {
    const text = 'x café'; // x, space, c, a, f, é(2 bytes / 1 utf16)
    const matches = searchText(text, ['cafe']);
    expect(matches).toEqual([
      {
        patternIndex: 0,
        pattern: 'cafe',
        byteStart: 2,
        byteEnd: 7,
        u16Start: 2,
        u16End: 6,
      },
    ]);
  });

  it('matches composed and decomposed forms identically', () => {
    const composed = 'Caf\u00E9'; // precomposed U+00E9 (2 bytes)
    const decomposed = 'Cafe\u0301'; // e + combining acute U+0301 (3 bytes)
    const a = searchText(composed, ['cafe']);
    const b = searchText(decomposed, ['cafe']);
    // UTF-16 spans agree: both normalize to the same 4 units.
    expect(a.map((m) => [m.u16Start, m.u16End])).toEqual(
      b.map((m) => [m.u16Start, m.u16End]),
    );
    expect(a[0].u16Start).toBe(0);
    expect(a[0].u16End).toBe(4);
    // Raw byte spans differ because the accent is encoded differently.
    expect(a[0].byteEnd).toBe(5);
    expect(b[0].byteEnd).toBe(6);
  });

  it('works when a combining mark arrives in a later chunk than its base', () => {
    const decomposed = 'Cafe\u0301'; // e + combining acute
    const bytes = enc.encode(decomposed);
    // Split right between 'e' and U+0301.
    const cut = bytes.length - 2; // U+0301 = CC 81
    const got = runChunks(bytes, ['cafe'], [cut]);
    expect(got).toEqual(searchBytes(bytes, ['cafe']));
    // The match must not be committed until the cluster with the mark closes.
    const m = new UnicodeStreamMatcher(['cafe']);
    const first = m.write(bytes.subarray(0, cut));
    expect(first).toHaveLength(0);
    const rest = m.write(bytes.subarray(cut));
    const final = m.end();
    expect([...rest, ...final]).toHaveLength(1);
  });

  it('matches case-insensitively and across marks anywhere', () => {
    expect(searchText('CAFÉ!! café', ['cafe'])).toHaveLength(2);
    expect(searchText('caf́é', ['cafe'])).toHaveLength(1); // mark on another letter
  });

  it('holds a potential match prefix across chunks without reporting early', () => {
    const pattern = 'abcdef';
    const bytes = enc.encode(pattern);
    const m = new UnicodeStreamMatcher([pattern]);
    // Feed the prefix of the pattern only: nothing can be committed.
    const partial = m.write(bytes.subarray(0, 5));
    expect(partial).toEqual([]);
    // The completing suffix reports the single full-length occurrence.
    const done = [...m.write(bytes.subarray(5)), ...m.end()];
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ byteStart: 0, byteEnd: 6, u16Start: 0, u16End: 6 });
  });

  it('does not retroactively change a committed prefix when a mark arrives', () => {
    // 'cafe' then a space closes the cluster and commits; a later combining
    // mark on following text cannot alter the already reported occurrence.
    const m = new UnicodeStreamMatcher(['cafe']);
    const first = m.write(enc.encode('cafe '));
    expect(first).toHaveLength(1);
    const later = m.write(enc.encode('é')); // new cluster with its own mark
    expect(later).toEqual([]);
    expect(m.end()).toEqual([]);
  });

  it('a later mark on the matched base defers the match until cluster close', () => {
    // 'cafe' followed (without a boundary) by U+0301: the combining mark
    // joins the same grapheme cluster, so the match is held until that
    // cluster closes (here at EOF); the span covers base + mark bytes.
    const bytes = enc.encode('cafe');
    const mark = enc.encode('\u0301');
    const m = new UnicodeStreamMatcher(['cafe']);
    expect(m.write(bytes)).toEqual([]);
    expect(m.write(mark)).toEqual([]);
    const flushed = m.end();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({
      byteStart: 0,
      byteEnd: 6,
      u16Start: 0,
      u16End: 4,
    });
  });

  it('retains ZWJ text literally but commits the family as one cluster', () => {
    const man = '\u{1F468}';
    const woman = '\u{1F469}';
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    // Components are literal substrings of the (mark-stripped) normalized
    // text, so substring search does find them — at their true positions.
    expect(searchText('a' + family + 'b', [man]).map((m) => [m.u16Start, m.u16End])).toEqual([
      [1, 3],
    ]);
    expect(searchText('a' + family + 'b', [woman]).map((m) => [m.u16Start, m.u16End])).toEqual([
      [4, 6],
    ]);
    // The whole ZWJ sequence is a single match spanning all 18 bytes.
    const whole = searchText('a' + family + 'b', [family]);
    expect(whole).toHaveLength(1);
    expect(whole[0].byteStart).toBe(1);
    expect(whole[0].byteEnd).toBe(19);
    expect(whole[0].u16Start).toBe(1);
    expect(whole[0].u16End).toBe(9);
    // Crucially, nothing is committed halfway: writing up to and including
    // the ZWJ before the final child yields no match for the full family.
    const partial = enc.encode('a' + family + 'b');
    const m = new UnicodeStreamMatcher([family]);
    const before = m.write(partial.subarray(0, 14)); // through second ZWJ
    expect(before).toEqual([]);
    expect([...m.write(partial.subarray(14)), ...m.end()]).toHaveLength(1);
  });

  it('does not pair regional indicators across clusters', () => {
    // 🇦🇧 is one RI pair cluster; 🇨 begins a second, unpaired cluster.
    const text = '🇦🇧🇨';
    const pair = '🇦🇧';
    const matches = searchText(text, [pair]);
    expect(matches).toHaveLength(1);
    expect(matches[0].byteStart).toBe(0);
    expect(matches[0].byteEnd).toBe(8);
  });

  it('supports astral patterns with correct surrogate offsets', () => {
    const text = 'z😀z';
    const m = searchText(text, ['😀']);
    expect(m[0]).toMatchObject({
      byteStart: 1,
      byteEnd: 5,
      u16Start: 1,
      u16End: 3,
    });
  });

  it('reports all overlapping patterns in deterministic order', () => {
    const text = 'aaaa';
    const matches = searchText(text, ['a', 'aa', 'aaa']);
    const singles = matches.filter((m) => m.pattern === 'a');
    const doubles = matches.filter((m) => m.pattern === 'aa');
    const triples = matches.filter((m) => m.pattern === 'aaa');
    expect(singles).toHaveLength(4);
    expect(doubles).toHaveLength(3);
    expect(triples).toHaveLength(2);
    // Global end-position ordering.
    const ends = matches.map((m) => m.u16End);
    expect([...ends]).toEqual([...ends].sort((a, b) => a - b));
  });

  it('reports duplicate raw patterns as separate outputs at each position', () => {
    const matches = searchText('aa', ['a', 'a']);
    // Each occurrence reports both registration indices.
    expect(
      matches.map((m) => [m.u16Start, m.u16End, m.patternIndex]),
    ).toEqual([
      [0, 1, 0],
      [0, 1, 1],
      [1, 2, 0],
      [1, 2, 1],
    ]);
  });
});

describe('chunking invariance', () => {
  const corpus = [
    'Café café CAFÉ café café',
    'éééé café éééé',
    'aaaa aaaaaaaa aaaa',
    'abababab',
    'z😀z😁z👨‍👩‍👧z',
    '한글한글 한글',
    '🇦🇧🇨🇩🇪',
    'café café café',
  ];
  const patterns = [
    'cafe',
    'a',
    'aa',
    'aaaa',
    'é',
    '😀',
    '👨‍👩‍👧',
    '한글',
    '🇦🇧',
    'ab',
    'b',
    'CAFÉ',
  ];

  for (const text of corpus) {
    it(`invariance for ${JSON.stringify(text.slice(0, 12))}`, () => {
      everyChunking(enc.encode(text), patterns);
    });
  }

  it('with malformed bytes present (replace mode)', () => {
    const bytes = new Uint8Array([
      ...enc.encode('cafe'),
      0xf0,
      0x9f,
      ...enc.encode('cafe'),
      0xc3,
      0x28,
      ...enc.encode('x'),
    ]);
    const one = everyChunking(bytes, ['cafe', '�']);
    expect(one.filter((m) => m.pattern === 'cafe')).toHaveLength(2);
  });

  it('offsets stay exact after a replacement character', () => {
    // "a" + invalid lead C3 (U+FFFD) + "b😀"
    const bytes = new Uint8Array([0x61, 0xc3, 0x62, 0xf0, 0x9f, 0x98, 0x80]);
    const matches = searchBytes(bytes, ['b😀']);
    expect(matches).toEqual([
      {
        patternIndex: 0,
        pattern: 'b😀',
        byteStart: 2,
        byteEnd: 7,
        u16Start: 2, // a, U+FFFD, then b at 2
        u16End: 5, // b + astral surrogate pair = 3 units
      },
    ]);
  });
});

describe('empty pattern policy', () => {
  it('throws by default for empty or mark-only patterns', () => {
    expect(() => new UnicodeStreamMatcher([''])).toThrow(RangeError);
    expect(() => new UnicodeStreamMatcher(['́'])).toThrow(RangeError);
  });

  it('ignore drops them, still finding the others', () => {
    const m = new UnicodeStreamMatcher(['', 'cafe', '́'], { emptyPatterns: 'ignore' });
    const out = [...m.write(enc.encode('cafe cafe')), ...m.end()];
    expect(out).toHaveLength(2);
    expect(out.every((x) => x.pattern === 'cafe')).toBe(true);
  });

  it('match emits zero-width hits at the start, each boundary and EOF', () => {
    const m = new UnicodeStreamMatcher([''], { emptyPatterns: 'match' });
    const text = 'aé'; // clusters: 'a', 'é'
    const out = [...m.write(enc.encode(text)), ...m.end()];
    // positions: start (0), after 'a' (u16 1 / byte 1), after 'é' (u16 2 /
    // byte 3) — the last boundary is also EOF and is emitted once.
    expect(out.map((x) => [x.u16Start, x.u16End, x.byteStart, x.byteEnd])).toEqual([
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [2, 2, 3, 3],
    ]);
  });

  it('emits one boundary at position 0 for an empty stream', () => {
    const m = new UnicodeStreamMatcher([''], { emptyPatterns: 'match' });
    const out = m.end();
    expect(out.map((x) => x.u16Start)).toEqual([0]);
  });

  it('does not match between an emoji and its ZWJ continuation', () => {
    const m = new UnicodeStreamMatcher([''], { emptyPatterns: 'match' });
    const out = [...m.write(enc.encode('👨‍👩')), ...m.end()];
    // One whole cluster (2+1+2 = 5 UTF-16 units) => start + EOF only.
    expect(out.map((x) => x.u16Start)).toEqual([0, 5]);
  });
});

describe('strict vs replace decode errors', () => {
  it('strict throws through write and leaves offsets on the error', () => {
    const m = new UnicodeStreamMatcher(['a'], { mode: 'strict' });
    expect(() => m.write(new Uint8Array([0x61, 0xe0, 0x80, 0x80]))).toThrow(
      /Malformed UTF-8/,
    );
  });

  it('strict error is deterministic regardless of chunking', () => {
    const bytes = new Uint8Array([0x61, 0xed, 0xa0, 0x80, 0x62]);
    const explode = (sizes: number[]) => {
      const m = new UnicodeStreamMatcher(['a'], { mode: 'strict' });
      let at = 0;
      try {
        for (const s of sizes) {
          m.write(bytes.subarray(at, at + s));
          at += s;
        }
        m.write(bytes.subarray(at));
        m.end();
        return null;
      } catch (e) {
        return {
          name: (e as Error).name,
          bs: (e as any).byteStart,
          be: (e as any).byteEnd,
        };
      }
    };
    // ED followed by the forbidden first continuation A0: one FFFD spans the
    // lead alone (A0 then decodes separately). Identical at every cut.
    expect(explode([4])).toEqual(explode([1, 1, 1, 1, 1]));
    expect(explode([2])).toMatchObject({ name: 'Utf8DecodeError', bs: 1, be: 2 });
  });

  it('replace finds patterns spanning replacement and valid text', () => {
    const m = new UnicodeStreamMatcher(['ab'], { mode: 'replace' });
    // 'a', then bad continuation 80 (replaced), then 'b'
    const out = [
      ...m.write(new Uint8Array([0x61, 0x80, 0x62])),
      ...m.end(),
    ];
    expect(out).toEqual([]); // replacement sits between a and b
  });
});

describe('bounded buffering', () => {
  it('does not grow with stream length', () => {
    const m = new UnicodeStreamMatcher(['cafe']);
    const bytes = enc.encode('café'.repeat(20000));
    const step = 7;
    let seen = 0;
    let maxHwm = 0;
    for (let i = 0; i < bytes.length; i += step) {
      seen += m.write(bytes.subarray(i, i + step)).length;
      maxHwm = Math.max(maxHwm, m.getStats().pendingBytesHighWater);
    }
    seen += m.end().length;
    expect(seen).toBe(20000);
    // Open cluster is one 'café' = 5 bytes; history is bounded by pattern.
    expect(maxHwm).toBeLessThanOrEqual(5);
    expect(m.getStats().historyUnits).toBeLessThanOrEqual(4);
    expect(m.getStats().bytes).toBe(bytes.length);
  });

  it('decoder never accumulates across lone leads', () => {
    const m = new UnicodeStreamMatcher(['x']);
    for (let i = 0; i < 10000; i++) {
      m.write(new Uint8Array([0xe0])); // never completed, re-errors on next lead
    }
    // No assertion on match count; the point is it stays tiny and bounded.
    expect(m.getStats().pendingBytesHighWater).toBeLessThanOrEqual(3);
    m.end();
  });
});
