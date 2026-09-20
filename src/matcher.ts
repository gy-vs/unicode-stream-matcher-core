import { AhoCorasick } from './automaton.js';
import { GraphemeGrouper } from './grapheme.js';
import { normalizeCodePoint, normalizePattern } from './normalize.js';
import type {
  DecodedItem,
  EmptyPatternPolicy,
  MatcherStats,
  NormUnit,
  StreamMatch,
} from './types.js';
import { IncrementalUtf8Decoder } from './utf8.js';

function compareMatch(a: StreamMatch, b: StreamMatch): number {
  // End-position order (earliest safe commit point), then start, then the
  // pattern's registration index.
  return a.u16End - b.u16End || a.u16Start - b.u16Start || a.patternIndex - b.patternIndex;
}

/**
 * Pulls the whole pipeline together:
 *
 *   bytes ─▶ incremental UTF-8 decoder ─▶ grapheme grouper ─▶ per-code-point
 *   NFD + case fold + strip marks ─▶ Aho-Corasick ─▶ committed matches
 *
 * Commit rule: a match is released only when the grapheme cluster containing
 * its ending unit closes (or at EOF). A following combining mark or ZWJ
 * continuation can therefore never alter an already-committed prefix.
 *
 * Bounded memory (independent of stream length):
 *  - decoder: at most 3 carried bytes;
 *  - grouper: the single open grapheme cluster;
 *  - automaton input history: `maxPatternLength` normalized UTF-16 units;
 *  - pending matches: occurrences ending inside the open cluster, at most
 *    clusterUnits * patternCount.
 *
 * Matches are ordered by `(u16End, u16Start, patternIndex)` — each match is
 * reported at the close of the cluster in which it ends. One-shot search
 * drives the same class, so arbitrary chunking yields identical output.
 */
export class UnicodeStreamMatcher {
  private readonly ac: AhoCorasick;
  private readonly maxLen: number;
  private readonly ring: NormUnit[];
  private readonly zeroWidth: number[] = [];
  private readonly decoder: IncrementalUtf8Decoder;
  private readonly grouper: GraphemeGrouper;
  private readonly queue: StreamMatch[] = [];

  private state = 0;
  private totalUnits = 0;
  private finished = false;
  private started = false;

  // Open-cluster span (for bounded-buffer observability).
  private open = false;
  private openByteStart = 0;
  private openByteEnd = 0;

  private statsData: MatcherStats = {
    bytes: 0,
    u16: 0,
    pendingBytes: 0,
    pendingBytesHighWater: 0,
    historyUnits: 0,
    pendingMatches: 0,
    pendingMatchesHighWater: 0,
  };

  constructor(
    readonly patterns: readonly string[],
    options: { mode?: 'strict' | 'replace'; emptyPatterns?: EmptyPatternPolicy } = {},
  ) {
    const policy: EmptyPatternPolicy = options.emptyPatterns ?? 'throw';
    const nonEmpty: { index: number; text: string }[] = [];
    patterns.forEach((pattern, index) => {
      const text = normalizePattern(pattern);
      if (text.length === 0) this.zeroWidth.push(index);
      else nonEmpty.push({ index, text });
    });
    if (this.zeroWidth.length > 0 && policy === 'throw') {
      throw new RangeError(
        `Empty/ignorable pattern(s) at index/indices ${this.zeroWidth.join(', ')} ` +
          `(use the emptyPatterns option to change this policy)`,
      );
    }
    if (policy === 'ignore') this.zeroWidth.length = 0;

    this.ac = new AhoCorasick(nonEmpty);
    this.maxLen = nonEmpty.length
      ? Math.max(...nonEmpty.map((p) => p.text.length))
      : 0;
    this.ring = new Array<NormUnit>(Math.max(1, this.maxLen));
    this.decoder = new IncrementalUtf8Decoder(options.mode ?? 'replace');
    this.grouper = new GraphemeGrouper((items) => this.closeCluster(items));
  }

  /** Feed one byte chunk; returns matches whose clusters just closed. */
  write(chunk: Uint8Array): StreamMatch[] {
    if (this.finished) throw new Error('matcher has already been ended');
    if (!this.started) {
      this.started = true;
      // Boundary at the start of text (GB1).
      this.emitZeroWidth(0, 0);
    }
    for (const item of this.decoder.push(chunk)) {
      this.grouper.feed(item);
      this.trackOpen(item);
    }
    this.syncPositions();
    return this.takeQueue();
  }

  /** Flush the open cluster and the EOF zero-width matches. */
  end(): StreamMatch[] {
    if (this.finished) return [];
    if (!this.started) {
      // Empty stream: a single boundary at position 0.
      this.emitZeroWidth(0, 0);
    }
    this.finished = true;
    for (const item of this.decoder.end()) {
      this.grouper.feed(item);
      this.trackOpen(item);
    }
    this.grouper.flush();
    this.open = false;
    // If any cluster existed, its close boundary (== EOF position) was
    // already emitted by closeCluster; otherwise the position-0 boundary
    // above covers the empty stream.
    this.syncPositions();
    this.statsData.pendingBytes = 0;
    this.statsData.pendingMatches = 0;
    return this.takeQueue();
  }

  getStats(): Readonly<MatcherStats> {
    return this.statsData;
  }

  private takeQueue(): StreamMatch[] {
    if (this.queue.length === 0) return [];
    const out = this.queue;
    const copy = out.slice();
    out.length = 0;
    return copy;
  }

  private trackOpen(item: DecodedItem): void {
    if (!this.open) {
      this.open = true;
      this.openByteStart = item.byteStart;
    }
    this.openByteEnd = item.byteEnd;
    const size = this.openByteEnd - this.openByteStart;
    this.statsData.pendingBytes = size;
    this.statsData.pendingBytesHighWater = Math.max(
      this.statsData.pendingBytesHighWater,
      size,
    );
  }

  private syncPositions(): void {
    this.statsData.bytes = this.decoder.bytePos;
    this.statsData.u16 = this.decoder.u16Pos;
    this.statsData.historyUnits = Math.min(this.totalUnits, this.maxLen);
  }

  private closeCluster(items: DecodedItem[]): void {
    const hits: StreamMatch[] = [];
    // Cluster boundary: the match end extends here whenever its ending
    // normalized unit comes from a source code point followed by more items
    // in this cluster (trailing combining marks contribute no units but are
    // part of the matched source span, matching precomposed equivalence).
    const boundaryItem = items[items.length - 1];
    for (const item of items) {
      const text = normalizeCodePoint(item.cp);
      // Index by UTF-16 code unit: astral folds contribute a surrogate
      // pair (for...of would hand back the whole code point instead).
      for (let k = 0; k < text.length; k++) {
        const unit = text[k];
        const norm: NormUnit = { ...item, unit };
        const g = this.totalUnits;
        this.ring[g % this.ring.length] = norm;
        this.totalUnits++;
        this.state = this.ac.go(this.state, unit);
        for (const hit of this.ac.outputAt(this.state)) {
          // Ring slot of the hit's first unit; % must be made non-negative.
          const slot = (((g - hit.length + 1) % this.ring.length) +
            this.ring.length) %
            this.ring.length;
          const startUnit = this.ring[slot];
          const isLastSource = item === boundaryItem;
          hits.push({
            patternIndex: hit.patternIndex,
            pattern: this.patterns[hit.patternIndex],
            byteStart: startUnit.byteStart,
            // Byte end absorbs trailing combining marks (they occupy bytes
            // and are part of the matched grapheme source span)...
            byteEnd: isLastSource ? norm.byteEnd : boundaryItem.byteEnd,
            u16Start: startUnit.u16Start,
            // ...but stripped marks contribute zero UTF-16 units, so the
            // UTF-16 end stays at the last emitted unit.
            u16End: norm.u16End,
          });
        }
      }
    }
    hits.sort(compareMatch);
    this.queue.push(...hits);

    // Zero-width matches at the boundary immediately after the cluster.
    const last = items[items.length - 1];
    this.emitZeroWidth(last.byteEnd, last.u16End);

    this.statsData.pendingMatches = hits.length;
    this.statsData.pendingMatchesHighWater = Math.max(
      this.statsData.pendingMatchesHighWater,
      hits.length,
    );
    // The cluster is now committed; a new one has not started yet.
    this.open = false;
    this.statsData.pendingBytes = 0;
    this.syncPositions();
  }

  private emitZeroWidth(bytePos: number, u16Pos: number): void {
    for (const index of this.zeroWidth) {
      this.queue.push({
        patternIndex: index,
        pattern: this.patterns[index],
        byteStart: bytePos,
        byteEnd: bytePos,
        u16Start: u16Pos,
        u16End: u16Pos,
      });
    }
  }
}
