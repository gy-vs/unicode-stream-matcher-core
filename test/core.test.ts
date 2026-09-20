import { describe, expect, it } from 'vitest';
import {
	IncrementalUTF8Decoder,
	UTF8DecodeError,
	SearchEngine,
	searchBytes,
	foldPattern,
	GraphemeBoundaryTracker,
} from '../src/index.js';

const enc = new TextEncoder();

/** Split bytes into chunks at every boundary given by `sizes` (cyclic). */
function splitChunks(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
	const out: Uint8Array[] = [];
	let i = 0;
	let k = 0;
	while (i < bytes.length) {
		const size = sizes[k % sizes.length];
		out.push(bytes.subarray(i, i + size));
		i += size;
		k += 1;
	}
	return out;
}

function searchChunks(
	chunks: Uint8Array[],
	patterns: readonly string[],
	options?: Parameters<typeof searchBytes>[2],
) {
	const engine = new SearchEngine(patterns, options);
	const out: ReturnType<typeof searchBytes> = [];
	engine.pipe((m) => out.push(m));
	for (const c of chunks) engine.write(c);
	engine.end();
	return out;
}

describe('incremental UTF-8 decoder', () => {
	const corpus = Buffer.concat([
		Buffer.from('héllo 你好 😀 café', 'utf8'),
		Buffer.from([0xff]),
		Buffer.from([0xc2]),
		Buffer.from([0xe1, 0x80]),
		Buffer.from([0xc0, 0x80]),
		Buffer.from([0xe0, 0x80, 0x80]),
		Buffer.from([0xed, 0xa0, 0x80]),
		Buffer.from([0xf0, 0x80, 0x80, 0x80]),
		Buffer.from([0xf4, 0x90, 0x80, 0x80]),
		Buffer.from([0x80, 0x81]),
		Buffer.from(' wörld', 'utf8'),
		Buffer.from([0x61, 0xf4]),
	]);

	function decode(bytes: Uint8Array, mode: 'strict' | 'replace') {
		const dec = new IncrementalUTF8Decoder();
		const cps: Array<[number, number]> = [];
		let err: UTF8DecodeError | null = null;
		const handler = {
			onCodePoint: (cp: number, len: number) => cps.push([cp, len]),
			onError: (len: number, start: number, invalid: number) => {
				if (mode === 'strict') throw new UTF8DecodeError(start, invalid);
				cps.push([0xfffd, len]);
			},
		};
		let offset = 0;
		try {
			dec.write(bytes, 0, handler);
			offset = bytes.length;
			dec.end(offset, handler);
		} catch (e) {
			err = e as UTF8DecodeError;
		}
		return { text: cps.map(([cp]) => String.fromCodePoint(cp)).join(''), err };
	}

	it('byte-at-a-time matches one-shot replacement decoding', () => {
		const ref = new TextDecoder('utf-8').decode(corpus);
		const plans = [
			[1],
			[2],
			[3],
			[1, 2, 3, 5],
			[4, 1],
			[7, 3, 1, 2],
		];
		for (const plan of plans) {
			const chunks = splitChunks(corpus, plan);
			const got = searchChunks(chunks, [], { onInvalid: 'replace' });
			// decode independently
			const dec = new IncrementalUTF8Decoder();
			let text = '';
			let off = 0;
			for (const c of chunks) {
				dec.write(c, off, {
					onCodePoint: (cp) => (text += String.fromCodePoint(cp)),
					onError: () => (text += '�'),
				});
				off += c.length;
			}
			dec.end(off, {
				onCodePoint: (cp) => (text += String.fromCodePoint(cp)),
				onError: () => (text += '�'),
			});
			expect(text, `plan ${plan}`).toBe(ref);
			expect(got.length).toBe(0);
		}
	});

	it('strict mode throws for malformed input under every chunking', () => {
		const refFailed = (() => {
			try {
				new TextDecoder('utf-8', { fatal: true }).decode(corpus);
				return false;
			} catch {
				return true;
			}
		})();
		for (const plan of [[1], [2], [3], [1, 4], [5, 1, 2]]) {
			expect(() => searchChunks(splitChunks(corpus, plan), ['x'], { onInvalid: 'strict' })).toThrow(
				UTF8DecodeError,
			);
			expect(refFailed).toBe(true);
		}
	});

	it('valid multibyte text decodes strictly under byte-at-a-time chunking', () => {
		const bytes = enc.encode('Café 😀 你好 ﬃ İ');
		expect(() => searchChunks(splitChunks(bytes, [1]), ['z'], { onInvalid: 'strict' })).not.toThrow();
	});
});

describe('normalization fold', () => {
	it('strips marks after NFD and lowercases', () => {
		expect(foldPattern('Café')).toBe('cafe');
		expect(foldPattern('CAFÉ')).toBe('cafe');
		expect(foldPattern('İSTANBUL')).toBe('istanbul');
	});
	it('combining-only patterns fold to empty', () => {
		expect(foldPattern('́')).toBe('');
	});
});

describe('grapheme boundary tracker', () => {
	const seg = new Intl.Segmenter('und', { granularity: 'grapheme' });
	function boundaries(cps: number[]) {
		const tr = new GraphemeBoundaryTracker();
		return cps.map((cp) => tr.feed(cp));
	}
	it('matches Intl.Segmenter on emoji ZWJ / RI / Hangul / CRLF', () => {
		const seqs = [
			[0x61, 0x301, 0x62],
			[0x0d, 0x0a, 0x61],
			[0x1f1fa, 0x1f1f8, 0x1f1eb, 0x1f1f7],
			[0x1f600, 0x200d, 0x1f4a4],
			[0x1f476, 0x1f3ff, 0x200d, 0x2640, 0xfe0f],
			[0x1100, 0x1161, 0x11a8],
			[0xac00, 0x11a8],
		];
		for (const cps of seqs) {
			const text = cps.map((c) => String.fromCodePoint(c)).join('');
			const segBreaks: boolean[] = [];
			let last = 0;
			for (const s of seg.segment(text)) {
				segBreaks.push(s.index !== last);
				last = s.index + s.segment.length;
			}
			// Compare code-point break vectors by mapping UTF-16 indexes
			const expected: boolean[] = [];
			let unit = 0;
			const points: boolean[] = [];
			for (const s of seg.segment(text)) points[s.index] = true;
			for (const cp of cps) {
				expected.push(points[unit] === true);
				unit += cp > 0xffff ? 2 : 1;
			}
			const got = boundaries(cps);
			// first code point is a boundary (GB1)
			got[0] = true;
			expect(got, cps.map((c) => c.toString(16)).join(' ')).toEqual(expected);
		}
	});
});

describe('offset correctness', () => {
	it('reports raw byte and UTF-16 offsets around emoji', () => {
		const m = searchBytes(enc.encode('😀😀hi'), ['hi', '😀']);
		const hi = m.find((x) => x.pattern === 0)!;
		expect(hi.start).toEqual({ byte: 8, utf16: 4 });
		expect(hi.end).toEqual({ byte: 10, utf16: 6 });
		const emojis = m.filter((x) => x.pattern === 1);
		expect(emojis[0].start).toEqual({ byte: 0, utf16: 0 });
		expect(emojis[0].end).toEqual({ byte: 4, utf16: 2 });
		expect(emojis[1].start).toEqual({ byte: 4, utf16: 2 });
	});

	it('extends match end over trailing combining marks until cluster closes', () => {
		// 'cafe' + U+0301 + 'x'  (one combining mark folds away but extends end)
		const data = new Uint8Array([
			...enc.encode('cafe'),
			0xcc, 0x81, // U+0301 COMBINING ACUTE ACCENT
			...enc.encode('x'),
		]);
		const m = searchBytes(data, ['cafe', 'cafex']);
		expect(m.find((x) => x.pattern === 0)!.end).toEqual({ byte: 6, utf16: 5 });
		expect(m.find((x) => x.pattern === 1)!.end).toEqual({ byte: 7, utf16: 6 });
	});

	it('does not extend across a grapheme boundary', () => {
		// Precomposed U+00E1 (2 bytes, folds NFD -> a + mark -> 'a'); then 'b'.
		const m = searchBytes(enc.encode('áb'), ['a', 'b']);
		expect(m[0].end).toEqual({ byte: 2, utf16: 1 });
		expect(m[1].start).toEqual({ byte: 2, utf16: 1 });
	});

	it('decomposed combining mark across chunk boundary attaches to open cluster', () => {
		// 'a' U+0301 'b' (a, cc 81, b) with the 2-byte mark split across chunks.
		const data = new Uint8Array([0x61, 0xcc, 0x81, 0x62]);
		const chunks = [data.subarray(0, 1), data.subarray(1, 2), data.subarray(2)];
		const m = searchChunks(chunks, ['a', 'b']);
		expect(m[0].end).toEqual({ byte: 3, utf16: 2 });
		expect(m[1].start).toEqual({ byte: 3, utf16: 2 });
	});

	it('emoji ZWJ sequence spans the full chain in both offsets', () => {
		const m = searchBytes(enc.encode('x😀‍💤y'), ['😀‍💤']);
		expect(m[0].start).toEqual({ byte: 1, utf16: 1 });
		expect(m[0].end).toEqual({ byte: 12, utf16: 6 });
	});

	it('offsets remain accurate after replacement characters', () => {
		const bytes = new Uint8Array([0x61, 0xff, 0x62, 0x63]); // a,bad,b,c
		const m = searchBytes(bytes, ['a�b', 'c', '�']);
		const joined = m.find((x) => x.pattern === 0)!;
		expect(joined.start).toEqual({ byte: 0, utf16: 0 });
		expect(joined.end).toEqual({ byte: 3, utf16: 3 });
		expect(m.find((x) => x.pattern === 1)!.start).toEqual({ byte: 3, utf16: 3 });
	});
});

describe('arbitrary chunking equals one-shot search', () => {
	const texts = [
		'Café café CAFÉ café',
		'aaaa aa aaa aaaa',
		'你好你好你好',
		'😀 😀‍💤 😀 🏳️‍🌈',
		'café café cafe',
		'🇺🇸🇫🇷🇺🇸',
		'İstanbul istanbul İSTANBUL',
		'x\r\ny\nz\tw',
	];
	const patternSets = [
		['cafe', 'a', 'aa', '你好', '😀', 'istanbul', 'x', ''],
		['aaaa', 'aaa', 'aa'],
	];

	function prng(seed: number) {
		let s = seed;
		return () => {
			s = (s + 0x6d2b79f5) | 0;
			let t = Math.imul(s ^ (s >>> 15), 1 | s);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	for (const text of texts) {
		for (let pi = 0; pi < patternSets.length; pi++) {
			it(`fuzz: ${JSON.stringify(text.slice(0, 12))} patterns#${pi}`, () => {
				const bytes = enc.encode(text);
				const patterns = patternSets[pi];
				const baseline = searchBytes(bytes, patterns);
				const r = prng(bytes.length * 31 + pi + 7);
				for (let trial = 0; trial < 30; trial++) {
					const chunks: Uint8Array[] = [];
					let pos = 0;
					while (pos < bytes.length) {
						const size = 1 + Math.floor(r() * 6);
						chunks.push(bytes.subarray(pos, pos + size));
						pos += size;
					}
					const got = searchChunks(chunks, patterns);
					expect(got, `trial ${trial}`).toEqual(baseline);
				}
			});
		}
	}

	it('also holds for malformed input under replacement mode', () => {
		const bytes = new Uint8Array([
			...enc.encode('cafe'),
			0xff, 0xc2, 0x61, ...enc.encode('cafe'), 0xe2, 0x82,
		]);
		const patterns = ['cafe', '�', 'a�', ''];
		const baseline = searchBytes(bytes, patterns, { onInvalid: 'replace' });
		for (const plan of [[1], [2], [3], [1, 2, 4]]) {
			expect(searchChunks(splitChunks(bytes, plan), patterns, { onInvalid: 'replace' })).toEqual(
				baseline,
			);
		}
	});
});

describe('empty pattern policies', () => {
	it('all: zero-length matches at start, each boundary, and end', () => {
		const m = searchBytes(enc.encode('ab'), ['']);
		expect(m.map((x) => [x.start.byte, x.end.byte])).toEqual([
			[0, 0],
			[1, 1],
			[2, 2],
		]);
	});
	it('start: only at stream start', () => {
		const m = searchBytes(enc.encode('ab'), [''], { emptyPatterns: 'start' });
		expect(m.map((x) => x.start.byte)).toEqual([0]);
	});
	it('none: never', () => {
		expect(searchBytes(enc.encode('ab'), [''], { emptyPatterns: 'none' })).toEqual([]);
	});
	it('empty stream emits one zero match for all/start, none for none', () => {
		expect(searchBytes(new Uint8Array(0), [''])).toHaveLength(1);
		expect(searchBytes(new Uint8Array(0), [''], { emptyPatterns: 'start' })).toHaveLength(1);
		expect(searchBytes(new Uint8Array(0), [''], { emptyPatterns: 'none' })).toHaveLength(0);
	});
});

describe('overlapping multi-pattern matches', () => {
	it('reports every overlap, longest-first at each end', () => {
		const m = searchBytes(enc.encode('aaa'), ['a', 'aa', 'aaa']);
		// At end 1: a@0; end 2: aa@0,a@1; end 3: aaa@0,aa@1,a@2
		expect(m.map((x) => [x.pattern, x.start.utf16, x.end.utf16])).toEqual([
			[0, 0, 1],
			[1, 0, 2],
			[0, 1, 2],
			[2, 0, 3],
			[1, 1, 3],
			[0, 2, 3],
		]);
	});
	it('multiple distinct patterns at the same span both reported', () => {
		const m = searchBytes(enc.encode('Café'), ['cafe', 'CAFE']);
		expect(m).toHaveLength(2);
	});
});

describe('buffered state stays bounded', () => {
	it('ring capacity depends on pattern length, never on stream length', async () => {
		const patterns = ['match'];
		const engine = new SearchEngine(patterns);
		engine.pipe(() => {});
		const big: string[] = [];
		const r = (() => {
			let s = 42;
			return () => {
				s = (s + 0x6d2b79f5) | 0;
				let t = Math.imul(s ^ (s >>> 15), 1 | s);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		})();
		// Feed 200KB one byte at a time, mostly marks.
		const alphabet = [0x61, 0xcc, 0x81, 0x6d, 0x20]; // a, combining acute, m, space
		let peakHeld = 0;
		const chunkBytes: number[] = [];
		for (let i = 0; i < 200_000; i++) chunkBytes.push(alphabet[Math.floor(r() * alphabet.length)]);
		const bytes = Uint8Array.from(chunkBytes);
		for (let i = 0; i < bytes.length; i++) {
			engine.write(bytes.subarray(i, i + 1));
			peakHeld = Math.max(peakHeld, engine.stats.heldMatchCount);
		}
		engine.end();
		expect(engine.stats.ringCapacity).toBe(6);
		expect(engine.stats.decoderPendingBytes).toBe(0);
		expect(peakHeld).toBeLessThanOrEqual(patterns.length);
		expect(engine.stats.bytesConsumed).toBe(200_000);
	});

	it('emoji/ZWJ/mark-only streams do not grow the held set', () => {
		const engine = new SearchEngine(['x']);
		let peak = 0;
		engine.pipe(() => {});
		// 1000 copies of U+0301 (cc 81), fed byte by byte
		const longMarks: number[] = [];
		for (let i = 0; i < 1000; i++) longMarks.push(0xcc, 0x81);
		const bytes = Uint8Array.from(longMarks);
		for (let i = 0; i < bytes.length; i++) {
			engine.write(bytes.subarray(i, i + 1));
			peak = Math.max(peak, engine.stats.heldMatchCount);
		}
		engine.end();
		expect(peak).toBe(0);
	});

	it('cross-chunk invalid continuation: E0 lead split from bad 0x80', () => {
		// WHATWG maximal-subpart: the offending 80 is *prepended* (not consumed),
		// so E0 alone is one error subpart followed by two bare continuations:
		// 'a' U+FFFD U+FFFD U+FFFD 'b' — regardless of chunk boundary placement.
		const bytes = new Uint8Array([0x61, 0xe0, 0x80, 0x80, 0x62]);
		const pattern = 'a���b';
		const baseline = searchBytes(bytes, [pattern]);
		expect(baseline).toHaveLength(1);
		expect(baseline[0].end).toEqual({ byte: 5, utf16: 5 });
		const chunked = searchChunks(
			[bytes.subarray(0, 2), bytes.subarray(2)],
			[pattern],
		);
		expect(chunked).toEqual(baseline);
	});

	it('truncated multibyte resumed correctly across chunks', () => {
		const bytes = enc.encode('a😀b');
		const baseline = searchBytes(bytes, ['😀']);
		// split the 4-byte emoji after 1, 2, 3 bytes
		for (const cut of [2, 3, 4]) {
			const chunks = [bytes.subarray(0, cut), bytes.subarray(cut)];
			expect(searchChunks(chunks, ['😀'])).toEqual(baseline);
		}
	});

	it('truncated multibyte at EOF replaces, byte-at-a-time', () => {
		const bytes = new Uint8Array([0x61, 0xf0, 0x9f]);
		const baseline = searchBytes(bytes, ['a�']);
		expect(searchChunks(splitChunks(bytes, [1]), ['a�'])).toEqual(baseline);
		expect(baseline[0].end).toEqual({ byte: 3, utf16: 2 });
	});

	it('long combining sequence keeps start-span slots valid (ring bound)', () => {
		// Pattern of 50 folded units; stream: 1000 marks then the pattern's text.
		const word = 'z'.repeat(50);
		const engine = new SearchEngine([word]);
		const marks: number[] = [];
		for (let i = 0; i < 1000; i++) marks.push(0xcc, 0x81);
		const bytes = Uint8Array.from([...marks, ...enc.encode(word)]);
		const out = searchBytes(bytes, [word]);
		expect(out).toHaveLength(1);
		// match starts at the first z, after all 2000 mark bytes
		expect(out[0].start.byte).toBe(2000);
		expect(engine.stats.ringCapacity).toBe(51);
	});

	it('adversarial pattern set: ring/held bound independent of stream length', () => {
		// Long pattern (100 units) + many patterns (50) on a 50KB random stream
		const patterns = ['q'.repeat(100), ...Array.from({ length: 49 }, (_, i) => `q${i}`)];
		const engine = new SearchEngine(patterns);
		let peakHeld = 0;
		engine.pipe(() => {});
		const bytes = enc.encode('q'.repeat(50_000));
		for (let i = 0; i < bytes.length; i++) {
			engine.write(bytes.subarray(i, i + 1));
			peakHeld = Math.max(peakHeld, engine.stats.heldMatchCount);
		}
		engine.end();
		expect(engine.stats.ringCapacity).toBe(101);
		// At any tail position at most the number of patterns can match
		expect(peakHeld).toBeLessThanOrEqual(patterns.length);
	});
});
