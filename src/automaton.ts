/**
 * Aho-Corasick automaton over UTF-16 code units.
 *
 * Patterns are inserted pre-normalized (see normalize.ts). Failure links and
 * complete output lists are built in one BFS, so every state reports all
 * patterns ending there (including ones reached via suffix links) in the
 * pattern indices' registration order. Transitions are memoized lazily; the
 * transition cache size is bounded by (states * input alphabet actually
 * seen), and the matcher retains only O(longest pattern) units of input
 * history independently of this trie.
 */
export interface PatternHit {
  patternIndex: number;
  length: number; // pattern length in UTF-16 units
}

class Node {
  next = new Map<string, number>();
  fail = 0;
  /** All patterns accepted at this state, longest-... kept in index order. */
  output: PatternHit[] = [];
}

export class AhoCorasick {
  private nodes: Node[] = [new Node()];

  constructor(patterns: ReadonlyArray<{ index: number; text: string }>) {
    for (const { index, text } of patterns) {
      let state = 0;
      // UTF-16 code units (astral patterns contribute surrogate halves).
      for (let k = 0; k < text.length; k++) {
        const unit = text[k];
        let next = this.nodes[state].next.get(unit);
        if (next === undefined) {
          next = this.nodes.length;
          this.nodes[state].next.set(unit, next);
          this.nodes.push(new Node());
        }
        state = next;
      }
      this.nodes[state].output.push({ patternIndex: index, length: text.length });
    }
    this.buildFailures();
  }

  private buildFailures(): void {
    const queue: number[] = [];
    // Depth-1 states fail at root.
    for (const [, child] of this.nodes[0].next) {
      queue.push(child);
    }
    let head = 0;
    while (head < queue.length) {
      const r = queue[head++];
      for (const [unit, u] of this.nodes[r].next) {
        queue.push(u);
        // Standard failure resolution: climb r's failure chain until a state
        // with an edge on `unit` is found (root's edges included); if none,
        // the failure stays at root.
        let state = this.nodes[r].fail;
        let to = this.nodes[state].next.get(unit);
        while (to === undefined && state !== 0) {
          state = this.nodes[state].fail;
          to = this.nodes[state].next.get(unit);
        }
        this.nodes[u].fail = to ?? 0;
        // Inherit suffix outputs at construction time.
        const inherited = this.nodes[this.nodes[u].fail].output;
        if (inherited.length > 0) {
          this.nodes[u].output = [...this.nodes[u].output, ...inherited];
        }
      }
    }
  }

  private readonly goCache = new Map<number, Map<string, number>>();

  /** Transition from `state` on `unit`, taking failure links (root loops). */
  go(state: number, unit: string): number {
    let perState = this.goCache.get(state);
    if (perState === undefined) {
      perState = new Map();
      this.goCache.set(state, perState);
    }
    const cached = perState.get(unit);
    if (cached !== undefined) return cached;

    let next = state;
    for (;;) {
      const direct = this.nodes[next].next.get(unit);
      if (direct !== undefined) {
        next = direct;
        break;
      }
      if (next === 0) break;
      next = this.nodes[next].fail;
    }
    perState.set(unit, next);
    return next;
  }

  /** All patterns accepted at `state` (own + inherited via failure chain). */
  outputAt(state: number): readonly PatternHit[] {
    return this.nodes[state].output;
  }
}
