import { describe, expect, it } from 'vitest';
import {
  searchStream,
  searchBytes,
  SearchAbortedError,
} from '../src/index.js';

const enc = new TextEncoder();

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const m of it) out.push(m);
  return out;
}

async function* asyncChunks(chunks: Uint8Array[], opts: {
  onPull?: (n: number) => void;
  onCleanup?: () => void;
  delay?: () => Promise<void>;
} = {}) {
  try {
    for (let i = 0; i < chunks.length; i++) {
      opts.onPull?.(i);
      if (opts.delay) await opts.delay();
      yield chunks[i];
    }
  } finally {
    opts.onCleanup?.();
  }
}

function chunksOf(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.subarray(i, i + size));
  }
  return out;
}

describe('searchStream', () => {
  const text = 'Café café CAFÉ café café café';
  const bytes = enc.encode(text);
  const patterns = ['cafe', 'café'];

  it('matches the one-shot result over byte-at-a-time chunks', async () => {
    const got = await collect(searchStream(chunksOf(bytes, 1), patterns));
    expect(got).toEqual(searchBytes(bytes, patterns));
  });

  it('matches the one-shot result over random large chunks', async () => {
    const got = await collect(searchStream(chunksOf(bytes, 3), patterns, { mode: 'replace' }));
    expect(got).toEqual(searchBytes(bytes, patterns));
  });

  it('accepts sync iterables and raw Uint8Array', async () => {
    const a = await collect(searchStream([bytes.subarray(0, 5), bytes.subarray(5)], patterns));
    const b = await collect(searchStream(bytes, patterns));
    expect(a).toEqual(b);
    expect(a).toEqual(searchBytes(bytes, patterns));
  });

  it('applies backpressure: source is only pulled on demand', async () => {
    const pulls: number[] = [];
    const source = asyncChunks(chunksOf(bytes, 2), { onPull: (n) => pulls.push(n) });
    const it = searchStream(source, patterns);
    // Nothing pulled before the consumer asks.
    expect(pulls).toEqual([]);
    const first = await it.next();
    expect(first.done).toBe(false);
    // Exactly enough chunks to close the cluster of the first match ('café'
    // ends in chunk 3); no speculative read-ahead beyond the next chunk.
    expect(pulls.length).toBeGreaterThanOrEqual(1);
    expect(pulls.length).toBeLessThanOrEqual(4);
    await it.return();
  });

  it('stops pulling when the consumer breaks', async () => {
    let pulls = 0;
    let cleaned = false;
    async function* source() {
      try {
        while (true) {
          pulls++;
          yield enc.encode('café');
        }
      } finally {
        cleaned = true;
      }
    }
    let received = 0;
    for await (const m of searchStream(source(), ['cafe'])) {
      received++;
      if (received === 2) break;
    }
    expect(received).toBe(2);
    expect(cleaned).toBe(true);
    // A bounded number of pulls: one match per 5-byte chunk, no read-ahead.
    expect(pulls).toBeLessThanOrEqual(4);
  });

  it('aborts via AbortSignal and closes the source', async () => {
    let cleaned = false;
    const ac = new AbortController();
    const source = asyncChunks(
      [enc.encode('cafe cafe cafe cafe')],
      {
        delay: () => new Promise((r) => setTimeout(r, 20)),
        onCleanup: () => {
          cleaned = true;
        },
      },
    );
    const it = searchStream(source, ['cafe'], { signal: ac.signal });
    const first = await it.next();
    expect(first.value.pattern).toBe('cafe');
    ac.abort(new Error('stop'));
    await expect(it.next()).rejects.toBeInstanceOf(SearchAbortedError);
    expect(cleaned).toBe(true);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      collect(searchStream([bytes], patterns, { signal: ac.signal })),
    ).rejects.toBeInstanceOf(SearchAbortedError);
  });

  it('propagates strict-mode decode errors', async () => {
    const bad = new Uint8Array([0x61, 0xed, 0xa0, 0x80]);
    await expect(collect(searchStream([bad], ['a'], { mode: 'strict' }))).rejects.toThrow(
      /Malformed UTF-8/,
    );
  });
});
