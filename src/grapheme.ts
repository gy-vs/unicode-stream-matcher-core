import type { DecodedItem } from './types.js';

/**
 * Grapheme cluster boundary stage (UAX #29, tailoring-free subset).
 *
 * Decoded code points are grouped into extended grapheme clusters so the
 * matcher only commits once a cluster is closed: a later combining mark,
 * ZWJ emoji continuation or Regional Indicator partner cannot change
 * anything already committed.
 *
 * Classification uses V8's Unicode property escapes where available
 * (`Grapheme_Extend`, `General_Category=Mc`, `Regional_Indicator`,
 * `Extended_Pictographic`) plus explicit tables for classes those escapes
 * do not expose (Prepend/Control/Hangul/ZWJ/CR/LF). Any exotic code point
 * that an explicit table misses is classified as `Other`; that can only
 * *advance* a boundary (commit slightly earlier) — never merge clusters
 * that should break — so it cannot delay or corrupt results.
 */

export type Gcb =
  | 'CR'
  | 'LF'
  | 'Control'
  | 'Extend'
  | 'ZWJ'
  | 'RI'
  | 'Prepend'
  | 'SpacingMark'
  | 'L'
  | 'V'
  | 'T'
  | 'LV'
  | 'LVT'
  | 'Other';

const EXTEND_RE = /\p{Grapheme_Extend}/u;
const MCMARK_RE = /\p{Mc}/u;
const EP_RE = /\p{Extended_Pictographic}/u;

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

// Grapheme_Cluster_Break=Prepend, common assignments (Unicode 15).
const PREPEND: ReadonlyArray<readonly [number, number]> = [
  [0x0600, 0x0605],
  [0x06dd, 0x06dd],
  [0x070f, 0x070f],
  [0x0890, 0x0891],
  [0x08e2, 0x08e2],
  [0x0d4e, 0x0d4e],
  [0x110bd, 0x110bd],
  [0x110cd, 0x110cd],
  [0x111c2, 0x111c3],
];

// Subset of Grapheme_Cluster_Break=Control beyond Cc (Cf controls). Prepend
// ranges are checked first and therefore win overlaps.
const CF_CONTROL: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0x1bca0, 0x1bca3],
];

// Spacing marks not in General_Category=Mc (halfwidth voice marks etc.).
const EXTRA_SPACING_MARK: ReadonlyArray<readonly [number, number]> = [
  [0xff9e, 0xff9f],
];

export function isExtendedPictographic(cp: number): boolean {
  return EP_RE.test(String.fromCodePoint(cp));
}

export function classify(cp: number): Gcb {
  if (cp === 0x0d) return 'CR';
  if (cp === 0x0a) return 'LF';
  if (cp === 0x200d) return 'ZWJ';
  if (inRanges(cp, PREPEND)) return 'Prepend';
  if ((cp >= 0x00 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f)) return 'Control';
  if (inRanges(cp, CF_CONTROL)) return 'Control';
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 'RI';
  // Hangul syllable classes (GB6/7/8).
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c) ||
      (cp >= 0x3131 && cp <= 0x3186)) {
    return 'L';
  }
  if ((cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6)) return 'V';
  if ((cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb)) return 'T';
  if (cp >= 0xac00 && cp <= 0xd7a3) {
    return (cp - 0xac00) % 28 === 0 ? 'LV' : 'LVT';
  }
  if (EXTEND_RE.test(String.fromCodePoint(cp))) return 'Extend';
  if (MCMARK_RE.test(String.fromCodePoint(cp)) || inRanges(cp, EXTRA_SPACING_MARK)) {
    return 'SpacingMark';
  }
  return 'Other';
}

interface Member {
  item: DecodedItem;
  gcb: Gcb;
  ep: boolean;
}

/**
 * Accumulates code points and invokes `onClose` whenever an extended
 * grapheme cluster is complete. Boundary decisions follow GB3–GB13 plus
 * GB999 of UAX #29.
 */
export class GraphemeGrouper {
  private members: Member[] = [];

  constructor(private readonly onClose: (items: DecodedItem[]) => void) {}

  get pendingCount(): number {
    return this.members.length;
  }

  feed(item: DecodedItem): void {
    const cp = item.cp;
    const gcb = classify(cp);
    const ep = isExtendedPictographic(cp);

    if (this.members.length > 0 && this.breaksBefore(gcb, ep)) {
      this.flush();
    }
    this.members.push({ item, gcb, ep });
  }

  /** Force-close the open cluster (end of stream). */
  flush(): void {
    if (this.members.length === 0) return;
    this.onClose(this.members.map((m) => m.item));
    this.members = [];
  }

  private breaksBefore(gcb: Gcb, ep: boolean): boolean {
    const last = this.members[this.members.length - 1].gcb;

    // GB3
    if (last === 'CR' && gcb === 'LF') return false;
    // GB4, GB5
    if (last === 'CR' || last === 'LF' || last === 'Control') return true;
    if (gcb === 'CR' || gcb === 'LF' || gcb === 'Control') return true;
    // GB6, GB7, GB8 (Hangul syllable / jamo sequences)
    if (last === 'L' && (gcb === 'L' || gcb === 'V' || gcb === 'LV' || gcb === 'LVT')) {
      return false;
    }
    if ((last === 'LV' || last === 'V') && (gcb === 'V' || gcb === 'T')) return false;
    if ((last === 'LVT' || last === 'T') && gcb === 'T') return false;
    // GB9, GB9a, GB9b
    if (gcb === 'Extend' || gcb === 'ZWJ' || gcb === 'SpacingMark') return false;
    if (last === 'Prepend') return false;
    // GB11: Extended_Pictographic Extend* ZWJ × Extended_Pictographic
    if (ep && last === 'ZWJ' && this.trailingEmojiZwj()) return false;
    // GB12/GB13: pair Regional Indicators (odd trailing run => pair).
    if (gcb === 'RI' && this.trailingRiCount() % 2 === 1) return false;
    // GB999
    return true;
  }

  /** True when the cluster tail (before the arriving EP) is `EP Extend* ZWJ`. */
  private trailingEmojiZwj(): boolean {
    const n = this.members.length;
    if (n < 2) return false;
    // members[n-1] is known ZWJ; skip Extend* before it...
    let j = n - 2;
    while (j >= 0 && this.members[j].gcb === 'Extend') j--;
    return j >= 0 && this.members[j].ep;
  }

  /** Number of contiguous RI code points at the cluster tail. */
  private trailingRiCount(): number {
    let count = 0;
    for (let j = this.members.length - 1; j >= 0; j--) {
      if (this.members[j].gcb !== 'RI') break;
      count++;
    }
    return count;
  }
}
