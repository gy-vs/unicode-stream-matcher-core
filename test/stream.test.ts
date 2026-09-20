import { describe, expect, it } from 'vitest';
import {
	PatternSearchStream,
	searchStream,
	StreamCancelledError,
	UTF8DecodeError,
} from '../src/index.js';

const enc = new TextEncoder();

async function* byteChunks(bytes: Uint8Array, size = 1) {
	for (let i = 0; i < bytes.length; i += size) {
		yield bytes.subarray(i, i + size);
	}
}

async function collect(
	bytes: Uint8Array,
	patterns: string[],
	size: number,
	options?: ConstructorParameters<typeof PatternSearchStream>[1],
) {
	const out = [];
	for await (const m of searchStream(byteChunks(bytes, size), patterns, options)) {
		out.push(m);
	}
	return out;
}

describe('async streaming search', () => {
	it('byte-at-a-time equals one-shot', async () => {
		const text = 'Café café CAFÉ 😀 café';
		const bytes = enc.encode(text);
		const patterns = ['cafe', '😀'];
		const ref = collect; // baseline via engine
		const { searchBytes } = await import('../src/index.js');
		const baseline = searchBytes(bytes, patterns);
		for (const size of [1, 2, 3, 5]) {
			expect(await collect(bytes, patterns, size)).toEqual(baseline);
		}
		void ref;
	});

	it('splits multibyte sequences and combining marks across chunks', async () => {
		const data = new Uint8Array([
			...enc.encode('cafe'),
			0xcc, 0x81, // U+0301 split will occur naturally at size 1
			...enc.encode(' '),
			0xf0, 0x9f, 0x98, 0x80, // 😀
		]);
		const { searchBytes } = await import('../src/index.js');
		const baseline = searchBytes(data, ['cafe', '😀']);
		for (const size of [1, 2, 3, 4, 7]) {
			expect(await collect(data, ['cafe', '😀'], size)).toEqual(baseline);
		}
	});

	it('applies backpressure: write() stays pending while HWM is full', async () => {
		const s = new PatternSearchStream(['a'], { highWaterMark: 2 });
		let resolved = false;
		const p = s.write(enc.encode('aaaaa')).then(() => (resolved = true));
		await new Promise((r) => setTimeout(r, 5));
		expect(resolved).toBe(false);
		expect(s.bufferedMatches).toBeGreaterThanOrEqual(2);
		await s.end();
		const n = [];
		for await (const m of s) n.push(m);
		await p;
		expect(n).toHaveLength(5);
		expect(resolved).toBe(true);
	});

	it('keeps buffering bounded under backpressure on a long stream', async () => {
		const s = new PatternSearchStream(['a'], { highWaterMark: 4 });
		let peakBuffered = 0;
		const producer = (async () => {
			// 20KB of 'a'; each write is awaited so backpressure can apply
			for (let i = 0; i < 20_000; i++) {
				await s.write(enc.encode('a'));
				peakBuffered = Math.max(peakBuffered, s.bufferedMatches);
			}
			await s.end();
		})();
		let consumed = 0;
		// Slow consumer: read one match per few ms
		for await (const m of s) {
			consumed++;
			if (consumed % 97 === 0) await new Promise((r) => setTimeout(r, 0));
		}
		await producer;
		expect(consumed).toBe(20_000);
		expect(peakBuffered).toBeLessThanOrEqual(8);
	});

	it('consumer breaking iteration stops pulling from the source', async () => {
		let pulled = 0;
		async function* source() {
			for (let i = 0; i < 1000; i++) {
				pulled++;
				yield enc.encode(`aa${i}aa`);
			}
		}
		let got = 0;
		for await (const m of searchStream(source(), ['aa'])) {
			got++;
			if (got === 3) break;
		}
		await new Promise((r) => setTimeout(r, 30));
		// Bounded: producer may have a small amount in flight but never ran to 1000
		expect(pulled).toBeLessThan(50);
		expect(got).toBe(3);
	});

	it('AbortSignal aborts pending write and read', async () => {
		const ac = new AbortController();
		const s = new PatternSearchStream(['a'], {
			signal: ac.signal,
			highWaterMark: 1,
		});
		// fill the buffer so a write is pending
		const pendingWrite = s.write(enc.encode('aaaaaaaa'));
		ac.abort();
		await expect(pendingWrite).rejects.toThrow();
		await expect(s.next()).rejects.toThrow();
	});

	it('pre-aborted signal rejects immediately', async () => {
		const s = new PatternSearchStream(['a'], { signal: AbortSignal.abort() });
		await expect(s.write(enc.encode('a'))).rejects.toBeInstanceOf(Error);
		await expect(s.next()).rejects.toBeInstanceOf(Error);
	});

	it('explicit cancel() rejects future writes with StreamCancelledError', async () => {
		const s = new PatternSearchStream(['a']);
		s.cancel();
		await expect(s.write(enc.encode('a'))).rejects.toBeInstanceOf(StreamCancelledError);
	});

	it('strict decode error propagates through write and next', async () => {
		const s = new PatternSearchStream(['a'], { onInvalid: 'strict' });
		await expect(s.write(new Uint8Array([0x61, 0xff]))).rejects.toBeInstanceOf(
			UTF8DecodeError,
		);
		await expect(s.next()).rejects.toBeInstanceOf(UTF8DecodeError);
	});

	it('replacement mode streams replacement characters and keeps offsets', async () => {
		const s = new PatternSearchStream(['�'], { onInvalid: 'replace' });
		const out: any[] = [];
		const done = (async () => {
			for await (const m of s) out.push(m);
		})();
		await s.write(new Uint8Array([0x61, 0xff, 0xff, 0x62]));
		await s.end();
		await done;
		expect(out.map((m) => m.start.byte)).toEqual([1, 2]);
	});

	it('empty stream completes without matches or errors', async () => {
		const s = new PatternSearchStream(['a']);
		await s.end();
		const result = await s.next();
		expect(result.done).toBe(true);
	});

	it('accepts a sync iterable of chunks', async () => {
		const chunks = [enc.encode('ca'), enc.encode('fe '), enc.encode('CAFE')];
		const out: any[] = [];
		for await (const m of searchStream(chunks, ['cafe'])) out.push(m);
		expect(out).toHaveLength(2);
	});

	it('sync iterable source is lazily pulled (backpressure to start)', async () => {
		let started = false;
		const source = (function* () {
			started = true;
			yield enc.encode('a');
		})();
		const gen = searchStream(source, ['a']);
		// Not pulled until first next()
		expect(started).toBe(false);
		const first = await gen.next();
		expect(started).toBe(true);
		expect(first.value.pattern).toBe(0);
		expect((await gen.next()).done).toBe(true);
	});

	it('large random chunking: streamed results equal one-shot', async () => {
		const { searchBytes } = await import('../src/index.js');
		const alphabet = [
			'c', 'a', 'f', 'e', 'C', 'A', 'F', 'E', ' ', '́',
			'😀', '‍', '你', '好', '\r', '\n', '\t', 'x', 'z',
		];
		let seed = 20260920;
		const rand = () => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 4294967296;
		};
		const text = Array.from({ length: 3000 }, () =>
			alphabet[Math.floor(rand() * alphabet.length)],
		).join('');
		const bytes = enc.encode(text);
		const patterns = ['cafe', 'a', 'ca', '😀', '你好', '', 'x'];
		const baseline = searchBytes(bytes, patterns);
		for (let trial = 0; trial < 25; trial++) {
			const chunks: Uint8Array[] = [];
			let pos = 0;
			while (pos < bytes.length) {
				const size = 1 + Math.floor(rand() * 8);
				chunks.push(bytes.subarray(pos, pos + size));
				pos += size;
			}
			const out: any[] = [];
			for await (const m of searchStream(chunks, patterns)) out.push(m);
			expect(out, `trial ${trial}`).toEqual(baseline);
		}
	});

	it('pipeline failure (strict decode) rejects the iteration from a generator source', async () => {
		// Realistic failure path: an async generator yields well-formed then
		// malformed bytes; strict decoding fails and the error reaches the
		// consumer through next() without an unhandled rejection.
		async function* source() {
			yield enc.encode('a');
			yield new Uint8Array([0xff]);
		}
		const gen = searchStream(source(), ['a'], { onInvalid: 'strict' });
		const first = await gen.next();
		expect(first.value.pattern).toBe(0);
		await expect(gen.next()).rejects.toBeInstanceOf(UTF8DecodeError);
	});
});
