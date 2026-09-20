/**
 * Streaming grapheme cluster boundary classifier implementing the rules of
 * UAX #29 (extended grapheme clusters, GB3..GB13/GB999).
 *
 * The pipeline only needs this classifier to decide one question: may a
 * zero-fold (pure mark) code point still extend the end offset of the match
 * currently held at the tail of the stream? A mark can do so exactly when it
 * does NOT begin a new cluster (GB9/GB9a/GB11 keep it inside the previous
 * cluster; GB4/GB5/GB999 close it).
 *
 * Categories are derived from V8's Unicode property escapes:
 *   Extend <- \p{Grapheme_Extend} (includes ZWNJ)
 *   RI     <- \p{Regional_Indicator}
 *   EP     <- \p{Extended_Pictographic}
 *   Control <- GCB Control: gc=Control plus Zl/Zp (U+2028/U+2029), or
 *              gc=Format minus ZWJ/ZWNJ/Prepend
 * SpacingMark is approximated by \p{Mc} (every Mc is a SpacingMark in the
 * current Unicode data; the few Mn SpacingMarks simply behave like "Other",
 * which is always safe for fold-commit purposes).
 * Prepend uses an explicit range table tracking Unicode 15; misclassification
 * of a rare Prepend format character only moves a cluster boundary, never a
 * match.
 *
 * Implemented rules are GB1..GB999 as published in UAX #29 (Unicode 15). Two
 * ICU tailoring divergences are intentionally not modeled because every code
 * point they move is stripped by the fold: GB9c Indic conjuncts (VSM x
 * consonant) and the "orphan ZWJ" handling (EP ZWJ ZWJ EP). In both cases the
 * diverging code points are zero-fold, so commit decisions on match-bearing
 * prefixes are unaffected.
 */

export type GCB =
	| 'CR'
	| 'LF'
	| 'Control'
	| 'Extend'
	| 'ZWJ'
	| 'RI'
	| 'EP'
	| 'L'
	| 'V'
	| 'T'
	| 'LV'
	| 'LVT'
	| 'Prepend'
	| 'SpacingMark'
	| 'Other';

const EXTEND_RE = /\p{Grapheme_Extend}/u;
const RI_RE = /\p{Regional_Indicator}/u;
const EP_RE = /\p{Extended_Pictographic}/u;
const CC_RE = /\p{General_Category=Control}/u;
const CF_RE = /\p{General_Category=Format}/u;
const ZLZP_RE = /\p{gc=Line_Separator}|\p{gc=Paragraph_Separator}/u;
const MC_RE = /\p{gc=Spacing_Mark}/u;

const HANGUL_L: Array<[number, number]> = [
	[0x1100, 0x115f],
	[0xa960, 0xa97f],
];
const HANGUL_V: Array<[number, number]> = [
	[0x1160, 0x11a7],
	[0xd7b0, 0xd7c6],
];
const HANGUL_T: Array<[number, number]> = [
	[0x11a8, 0x11ff],
	[0xd7cb, 0xd7fb],
];
const LV_BASE = 0xac00;
const LV_END = 0xd7a3;

// Unicode 15 DerivedCoreProperties Prepend ranges (Cf characters).
const PREPEND_RANGES: Array<[number, number]> = [
	[0x0600, 0x0605],
	[0x06dd, 0x06dd],
	[0x070f, 0x070f],
	[0x0890, 0x0891],
	[0x08e2, 0x08e2],
	[0x110bd, 0x110bd],
	[0x110cd, 0x110cd],
	[0x111c2, 0x111c3],
	[0x1193f, 0x1193f],
	[0x11941, 0x11941],
	[0x16af0, 0x16af4],
	[0x1bca0, 0x1bca3],
	[0x1d173, 0x1d17a],
];

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
	for (const [lo, hi] of ranges) {
		if (cp >= lo && cp <= hi) return true;
	}
	return false;
}

export function classify(cp: number): GCB {
	if (cp === 0x0d) return 'CR';
	if (cp === 0x0a) return 'LF';
	if (cp === 0x200d) return 'ZWJ';
	// UTS #18's Grapheme_Extend excludes emoji skin-tone modifiers, but UAX #29's
	// Extend class includes them (they are the only members of Emoji_Modifier).
	if (
		EXTEND_RE.test(String.fromCodePoint(cp)) ||
		(cp >= 0x1f3fb && cp <= 0x1f3ff)
	)
		return 'Extend';
	if (RI_RE.test(String.fromCodePoint(cp))) return 'RI';
	if (EP_RE.test(String.fromCodePoint(cp))) return 'EP';
	if (cp >= LV_BASE && cp <= LV_END) {
		return (cp - LV_BASE) % 28 === 0 ? 'LV' : 'LVT';
	}
	if (inRanges(cp, HANGUL_L)) return 'L';
	if (inRanges(cp, HANGUL_V)) return 'V';
	if (inRanges(cp, HANGUL_T)) return 'T';
	if (inRanges(cp, PREPEND_RANGES)) return 'Prepend';
	if (
		CC_RE.test(String.fromCodePoint(cp)) ||
		ZLZP_RE.test(String.fromCodePoint(cp)) ||
		CF_RE.test(String.fromCodePoint(cp))
	)
		return 'Control';
	if (MC_RE.test(String.fromCodePoint(cp))) return 'SpacingMark';
	return 'Other';
}

/**
 * Stateful extended-grapheme-cluster boundary tracker. Feed scalar values in
 * order; `feed` returns true when the code point starts a *new* cluster
 * (i.e. a cluster boundary sits before it).
 */
export class GraphemeBoundaryTracker {
	private prev: GCB | null = null;
	/** Consecutive RI count inside the current RI run (GB12/GB13). */
	private riCount = 0;
	/** Current cluster began with an Extended_Pictographic (GB11 prefix). */
	private clusterEP = false;
	/** Last fed code point was a ZWJ within the current (unbroken) cluster. */
	private prevZWJ = false;

	feed(cp: number): boolean {
		const cls = classify(cp);
		const isFirst = this.prev === null;
		const breakBefore = isFirst || this.breakBefore(cls);
		if (breakBefore) {
			this.riCount = cls === 'RI' ? 1 : 0;
			this.clusterEP = cls === 'EP';
			this.prevZWJ = cls === 'ZWJ';
		} else {
			if (cls === 'RI') {
				// Only reachable via GB12 (paired RI); keep the run counter exact.
				this.riCount += 1;
			}
			// Inside an EP-prefixed cluster an EP can only arrive through GB11,
			// which keeps the prefix alive for another round.
			this.prevZWJ = cls === 'ZWJ';
		}
		this.prev = cls;
		return breakBefore;
	}

	private breakBefore(cls: GCB): boolean {
		const prev = this.prev;
		if (prev === null) return false; // GB1
		// GB3
		if (prev === 'CR' && cls === 'LF') return false;
		// GB4: Control/CR/LF closes
		if (prev === 'Control' || prev === 'CR' || prev === 'LF') return true;
		// GB5: break before Control/CR/LF (CR x LF already handled)
		if (cls === 'Control' || cls === 'CR' || cls === 'LF') return true;
		// GB6: L × (L | V | LV | LVT)
		if (
			prev === 'L' &&
			(cls === 'L' || cls === 'V' || cls === 'LV' || cls === 'LVT')
		)
			return false;
		// GB7: (LV | V) × (V | T)
		if (
			(prev === 'LV' || prev === 'V') &&
			(cls === 'V' || cls === 'T')
		)
			return false;
		// GB8: (LVT | T) × T
		if ((prev === 'LVT' || prev === 'T') && cls === 'T') return false;
		// GB9: × (Extend | ZWJ)
		if (cls === 'Extend' || cls === 'ZWJ') return false;
		// GB9a: × SpacingMark
		if (cls === 'SpacingMark') return false;
		// GB9b: Prepend ×
		if (prev === 'Prepend') return false;
		// GB11: EP (Extend|SpacingMark)* ZWJ × EP
		if (this.prevZWJ && this.clusterEP && cls === 'EP') return false;
		// GB12: ^(RI RI)* RI × RI — no break before even-positioned RI
		if (prev === 'RI' && cls === 'RI' && (this.riCount & 1) === 1)
			return false;
		// GB13 / GB999: break
		return true;
	}

	reset(): void {
		this.prev = null;
		this.riCount = 0;
		this.clusterEP = false;
		this.prevZWJ = false;
	}
}
