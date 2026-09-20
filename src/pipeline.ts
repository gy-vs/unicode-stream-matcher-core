import { UnicodeStreamMatcher } from './matcher.js';
import type {
  EmptyPatternPolicy,
  StreamMatch,
  StreamMatcherOptions,
} from './types.js';

/** Raised when a search is aborted via an AbortSignal. */
export class SearchAbortedError extends Error {
  readonly reason: unknown;

  constructor(reason?: unknown) {
    super('stream search aborted');
    this.name = 'SearchAbortedError';
    this.reason = reason;
  }
}

type ByteChunks =
  | Iterable<Uint8Array>
  | AsyncIterable<Uint8Array>
  | Uint8Array;

/**
 * Search `source` for all patterns over a pull-based, back-pressured
 * pipeline. Nothing is read from `source` until the consumer asks for the
 * next match, so a slow consumer applies backpressure all the way to the
 * producer; no chunk is ever buffered ahead of demand.
 *
 * Cancellation: break out of `for await`, or pass an {@link AbortSignal}.
 * Both stop pulling from `source` immediately (its `return` is invoked when
 * present) and release pipeline state.
 */
export async function* searchStream(
  source: ByteChunks,
  patterns: readonly string[],
  options: StreamMatcherOptions = {},
): AsyncGenerator<StreamMatch, void, unknown> {
  const matcher = new UnicodeStreamMatcher(patterns, {
    mode: options.mode,
    emptyPatterns: options.emptyPatterns,
  });
  const signal = options.signal;

  const throwIfAborted = () => {
    if (signal?.aborted) throw new SearchAbortedError(signal.reason);
  };
  throwIfAborted();

  // Races a pending source pull against abort so cancellation is prompt even
  // while the producer is blocked in `next()`.
  const abortPromise = signal
    ? new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(new SearchAbortedError(signal.reason));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      })
    : null;

  const iterable: ByteChunks =
    source instanceof Uint8Array ? [source] : source;

  const iterator: Iterator<Uint8Array> | AsyncIterator<Uint8Array> =
    (iterable as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== undefined
      ? (iterable as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]!()
      : (iterable as Iterable<Uint8Array>)[Symbol.iterator]();

  const pull = () => {
    const p = iterator.next();
    return abortPromise
      ? (Promise.race([p, abortPromise]) as Promise<IteratorResult<Uint8Array>>)
      : p;
  };

  try {
    let done = false;
    while (!done) {
      throwIfAborted();
      // Checked before every pull: this is the backpressure point. The
      // generator is suspended here while the consumer processes results.
      const next = await pull();
      throwIfAborted();
      const matches = next.done ? matcher.end() : matcher.write(next.value);
      if (next.done) done = true;
      for (const m of matches) {
        // Re-check after each yield so abort is prompt even when one chunk
        // contains several matches; the yield itself is the suspension.
        throwIfAborted();
        yield m;
      }
    }
  } finally {
    // Consumer cancellation (break/return) or abort: stop the upstream too.
    await iterator.return?.();
  }
}

/**
 * One-shot search over bytes. This drives the exact same incremental
 * pipeline as {@link searchStream} (one chunk), which is why every arbitrary
 * chunking of the same byte stream produces byte-for-byte identical output.
 */
export function searchBytes(
  data: Uint8Array,
  patterns: readonly string[],
  options: { mode?: 'strict' | 'replace'; emptyPatterns?: EmptyPatternPolicy } = {},
): StreamMatch[] {
  const matcher = new UnicodeStreamMatcher(patterns, options);
  const out = matcher.write(data);
  out.push(...matcher.end());
  return out;
}

/** One-shot search over a string; offsets address its UTF-8 / UTF-16 forms. */
export function searchText(
  text: string,
  patterns: readonly string[],
  options: { mode?: 'strict' | 'replace'; emptyPatterns?: EmptyPatternPolicy } = {},
): StreamMatch[] {
  return searchBytes(new TextEncoder().encode(text), patterns, options);
}
