/**
 * Backpressured asynchronous pipeline on top of SearchEngine.
 *
 * Two surfaces share one implementation:
 *
 *  - `PatternSearchStream` is a push/pull channel: a producer `write()`s byte
 *    chunks (the returned promise applies backpressure while too many
 *    *committed* matches are queued), while a consumer reads matches via
 *    `for await`.
 *  - `searchStream(source, ...)` wraps an (a)sync iterable of chunks as a
 *    convenient async generator; it stops pulling from the source as soon as
 *    the consumer stops iterating (cancellation propagates upstream).
 *
 * Buffering is bounded: at most `highWaterMark` committed matches plus the
 * in-flight byte chunk, regardless of stream length.
 */

import {
	SearchEngine,
	type SearchOptions,
	type StreamMatch,
} from './engine.js';

export class StreamCancelledError extends Error {
	constructor(message = 'stream search cancelled') {
		super(message);
		this.name = 'StreamCancelledError';
	}
}

export interface StreamSearchOptions extends SearchOptions {
	/** Matches buffered before `write()` back-pressures the producer. Default 64. */
	highWaterMark?: number;
	/** Aborting the signal cancels pending writes and reads. */
	signal?: AbortSignal;
}

interface ChunkItem {
	kind: 'chunk';
	bytes: Uint8Array;
	resolve: () => void;
	reject: (e: Error) => void;
}
interface EndItem {
	kind: 'end';
	resolve: () => void;
	reject: (e: Error) => void;
}
type Item = ChunkItem | EndItem;

interface Reader {
	resolve: (r: IteratorResult<StreamMatch>) => void;
	reject: (e: Error) => void;
}

export class PatternSearchStream {
	private readonly engine: SearchEngine;
	private readonly hwm: number;
	private readonly signal: AbortSignal | undefined;

	private readonly inputs: Item[] = [];
	private readonly matches: StreamMatch[] = [];
	private ended = false;
	private cancelled = false;
	private failure: Error | null = null;
	private pumping = false;
	private reader: Reader | null = null;
	/**
	 * Chunks already processed while the committed match queue was at
	 * capacity; their `write()` promises stay pending until the consumer drains
	 * below the HWM. FIFO, and at most (HWM / matches-per-chunk + 1) deep —
	 * a cooperating producer awaiting write() stops pushing once backpressured.
	 */
	private blockedWriters: ChunkItem[] = [];

	constructor(patterns: readonly string[], options: StreamSearchOptions = {}) {
		this.engine = new SearchEngine(patterns, options);
		this.engine.pipe((m) => this.onMatch(m));
		this.hwm = Math.max(1, options.highWaterMark ?? 64);
		this.signal = options.signal;
		if (this.signal) {
			if (this.signal.aborted) {
				this.cancel(
					this.signal.reason instanceof Error
						? this.signal.reason
						: new StreamCancelledError('aborted before start'),
				);
			} else {
				this.signal.addEventListener(
					'abort',
					() => {
						const reason = this.signal?.reason;
						this.cancel(
							reason instanceof Error
								? reason
								: new StreamCancelledError('AbortSignal aborted'),
						);
					},
					{ once: true },
				);
			}
		}
	}

	private onMatch(m: StreamMatch): void {
		if (this.cancelled) return;
		if (this.reader) {
			const r = this.reader;
			this.reader = null;
			r.resolve({ value: m, done: false });
			return;
		}
		this.matches.push(m);
	}

	/**
	 * Enqueue work and return a promise for the writer. Internally the item is
	 * settled through a promise that is *always* observed; the returned promise
	 * is derived from it, so a producer awaiting write()/end() receives the
	 * result, while an eager pump failing before that await is attached never
	 * leaks an unhandled rejection (the consumer gets the error via the reader).
	 */
	private enqueue(item: { kind: 'chunk'; bytes: Uint8Array } | { kind: 'end' }): Promise<void> {
		const settlement = new Promise<void>((resolve, reject) => {
			this.inputs.push({ ...item, resolve, reject } as Item);
		});
		// Permanent internal observer.
		settlement.catch(() => {});
		this.pump();
		return settlement;
	}

	/**
	 * Enqueue a byte chunk. The promise resolves after the chunk has been
	 * processed and, under backpressure, once enough committed matches are
	 * drained that the buffer is below the high-water mark.
	 */
	write(bytes: Uint8Array): Promise<void> {
		if (this.cancelled) {
			return Promise.reject(this.failure ?? new StreamCancelledError());
		}
		return this.enqueue({ kind: 'chunk', bytes });
	}

	/** Signal end of input; resolves after the engine committed the tail. */
	end(): Promise<void> {
		if (this.cancelled) {
			return Promise.reject(this.failure ?? new StreamCancelledError());
		}
		return this.enqueue({ kind: 'end' });
	}

	/** Cancel processing; pending and future operations reject. */
	cancel(reason: Error = new StreamCancelledError()): void {
		if (this.cancelled) return;
		this.cancelled = true;
		this.failure = reason;
		for (const item of this.inputs.splice(0)) item.reject(reason);
		// These chunks were already processed; release their writers (the work
		// is moot once cancelled).
		for (const item of this.blockedWriters.splice(0)) item.resolve();
		if (this.reader) {
			const r = this.reader;
			this.reader = null;
			r.reject(reason);
		}
		this.matches.length = 0;
	}

	next(): Promise<IteratorResult<StreamMatch>> {
		const result = new Promise<IteratorResult<StreamMatch>>((resolve, reject) => {
			if (this.cancelled) {
				reject(this.failure ?? new StreamCancelledError());
				return;
			}
			const queued = this.matches.shift();
			if (queued !== undefined) {
				this.releaseWriters();
				resolve({ value: queued, done: false });
				return;
			}
			if (this.ended && this.inputs.length === 0) {
				resolve({ value: undefined, done: true });
				return;
			}
			this.reader = { resolve, reject };
			// Match may have been delivered via the direct-reader path; make
			// sure any newly blockable input still flows.
			this.pump();
		});
		// The consumer awaits this promise, but a failure arriving in the
		// microtask gap between yield and the next await must not be reported
		// unhandled; the internal observer is permanent and harmless.
		result.catch(() => {});
		return result;
	}

	[Symbol.asyncIterator](): this {
		return this;
	}

	/** Current buffered match count (for diagnostics/tests). */
	get bufferedMatches(): number {
		return this.matches.length;
	}

	/** True after cancellation, abort, or a pipeline failure. */
	get isCancelled(): boolean {
		return this.cancelled;
	}

	/** Record a pipeline failure and tear down pending operations. */
	fail(err: Error): void {
		if (this.cancelled) return;
		this.cancelled = true;
		this.failure = err;
		// Every queued item's settlement promise already carries an internal
		// rejection observer (attached in enqueue), so rejecting here cannot
		// surface as an unhandled rejection.
		for (const item of this.inputs.splice(0)) item.reject(err);
		for (const item of this.blockedWriters.splice(0)) item.resolve();
		if (this.reader) {
			const r = this.reader;
			this.reader = null;
			r.reject(err);
		}
		this.matches.length = 0;
	}

	/**
	 * Release FIFO-blocked writers while the committed queue has room. After a
	 * writer resumes it may enqueue more input, so restart the pump.
	 */
	private releaseWriters(): void {
		let woke = false;
		while (
			this.blockedWriters.length > 0 &&
			this.matches.length < this.hwm
		) {
			const item = this.blockedWriters.shift()!;
			item.resolve();
			woke = true;
		}
		if (woke) this.pump();
	}

	private pump(): void {
		if (this.pumping || this.cancelled) return;
		this.pumping = true;
		const run = (): void => {
			const running = this.runPump();
			// Observe the pump promise synchronously. runPump may reject if an
			// unexpected error escapes its inner handling; the consumer-facing
			// error path is via fail()/reader, so swallowing the pump rejection
			// here only prevents an unhandled-rejection report.
			running.catch((e) => this.suppress(e));
			running
				.finally(() => {
					this.pumping = false;
					if (
						!this.cancelled &&
						this.inputs.length > 0 &&
						!(this.inputs[0].kind === 'chunk' && this.matches.length >= this.hwm)
					) {
						this.pump();
					}
				})
				.catch((e) => this.suppress(e));
		};
		queueMicrotask(run);
	}

	private suppress(e: unknown): void {
		// Last-resort guard ensuring no pump-derived rejection is unobserved.
		void e;
	}

	private async runPump(): Promise<void> {
		for (;;) {
			if (this.cancelled) return;
			const item = this.inputs.shift();
			if (!item) return;
			try {
				if (item.kind === 'chunk') {
					this.engine.write(item.bytes);
				} else {
					this.engine.end();
					this.ended = true;
				}
			} catch (e) {
				const err = e instanceof Error ? e : new Error(String(e));
				try {
					item.reject(err);
					this.fail(err);
				} catch (e2) {
					// Defensive: teardown must never re-throw into the pump.
					this.cancelled = true;
					this.failure = e2 instanceof Error ? e2 : err;
				}
				return;
			}
			// Backpressure: a chunk whose processing leaves the committed queue
			// at capacity keeps its writer pending; releaseWriters() drains it in
			// FIFO order as the consumer reads. The end marker always resolves,
			// so the final withheld matches can be committed.
			if (
				item.kind === 'chunk' &&
				this.matches.length >= this.hwm &&
				this.reader === null
			) {
				this.blockedWriters.push(item);
			} else {
				item.resolve();
			}
			// A waiting reader takes a freshly committed match directly.
			if (this.reader) {
				const m = this.matches.shift();
				if (m !== undefined) {
					const r = this.reader;
					this.reader = null;
					r.resolve({ value: m, done: false });
				}
			}
			this.releaseWriters();
			// Reader waiting past end-of-input is released with `done`.
			if (this.ended && this.matches.length === 0 && this.reader !== null) {
				const r = this.reader;
				this.reader = null;
				r.resolve({ value: undefined, done: true });
				return;
			}
		}
	}
}

/**
 * Pull-based streaming search over an (a)sync iterable of byte chunks.
 *
 * The source is pulled lazily; `write()` backpressure stalls the producer
 * whenever the consumer is slow. Breaking out of iteration (or aborting
 * `signal`) cancels the pipeline and stops pulling from the source.
 */
export async function* searchStream(
	source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
	patterns: readonly string[],
	options: StreamSearchOptions = {},
): AsyncGenerator<StreamMatch, void, unknown> {
	const stream = new PatternSearchStream(patterns, options);

	let sourceError: Error | null = null;
	const pumpSource = async (): Promise<void> => {
		try {
			for await (const chunk of source) {
				await stream.write(chunk);
			}
			await stream.end();
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			if (!stream.isCancelled) {
				sourceError = err;
				stream.fail(err);
			}
		}
	};
	const pumping = pumpSource();
	// Ensure pumpSource's rejection (if any) is observed even if the consumer
	// never reaches the final await (e.g. abandoned generator).
	pumping.catch(() => {});

	try {
		for (;;) {
			const result = await stream.next();
			if (result.done) break;
			yield result.value;
		}
		await pumping;
		if (sourceError) throw sourceError;
	} finally {
		// A source failure already tore the stream down; only a consumer that
		// abandoned iteration needs explicit cancellation.
		if (!sourceError) stream.cancel(new StreamCancelledError('consumer cancelled'));
	}
}
