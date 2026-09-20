/**
 * Aho-Corasick automaton over UTF-16 code units with sparse transitions and
 * fail-link walks. Every dictionary entry (pattern index + folded word) becomes
 * an output; outputs are reported longest-first with all overlaps included.
 *
 * Memory is O(sum of folded pattern lengths) for transitions plus one object
 * per state; it does not depend on the searched stream at all.
 */

export interface PatternSpec {
	index: number;
	word: string;
}

interface Node {
	/** Sparse goto edges keyed by UTF-16 code unit. */
	goto: Map<number, number>;
	fail: number;
	/** Outputs terminating at this node itself (no fail-chain outputs). */
	dict: number[]; // pattern indices
}

export class AhoCorasick {
	private nodes: Node[] = [{ goto: new Map(), fail: 0, dict: [] }];

	constructor(patterns: PatternSpec[]) {
		this.build(patterns);
	}

	private addPattern(word: string, index: number): void {
		let state = 0;
		for (let i = 0; i < word.length; i++) {
			const unit = word.charCodeAt(i);
			let next = this.nodes[state].goto.get(unit);
			if (next === undefined) {
				next = this.nodes.length;
				this.nodes.push({ goto: new Map(), fail: 0, dict: [] });
				this.nodes[state].goto.set(unit, next);
			}
			state = next;
		}
		this.nodes[state].dict.push(index);
	}

	private build(patterns: PatternSpec[]): void {
		for (const { index, word } of patterns) {
			if (word.length > 0) this.addPattern(word, index);
		}
		// BFS to fill failure links.
		const queue: number[] = [];
		const root = this.nodes[0];
		for (const child of root.goto.values()) {
			this.nodes[child].fail = 0;
			queue.push(child);
		}
		let head = 0;
		while (head < queue.length) {
			const r = queue[head++];
			const rFail = this.nodes[r].fail;
			for (const [unit, s] of this.nodes[r].goto) {
				queue.push(s);
				let f = rFail;
				while (f !== 0 && !this.nodes[f].goto.has(unit)) f = this.nodes[f].fail;
				const fChild = this.nodes[f].goto.get(unit);
				this.nodes[s].fail = fChild === undefined || fChild === s ? 0 : fChild;
			}
		}
	}

	/**
	 * Feed one UTF-16 code unit starting from `state`; returns the new state.
	 * Matches ending at this unit are appended to `out`, ordered longest-first,
	 * then by pattern index.
	 */
	step(state: number, unit: number, out: number[]): number {
		let s = state;
		for (;;) {
			const next = this.nodes[s].goto.get(unit);
			if (next !== undefined) {
				s = next;
				break;
			}
			if (s === 0) break;
			s = this.nodes[s].fail;
		}
		// Collect outputs along the dictionary chain (this node + fail links).
		let d = s;
		while (d !== 0) {
			const dict = this.nodes[d].dict;
			for (let i = 0; i < dict.length; i++) out.push(dict[i]);
			d = this.nodes[d].fail;
		}
		return s;
	}

	get stateCount(): number {
		return this.nodes.length;
	}

	/** Folded word length recorded for a pattern index (looked up via builder map). */
}
