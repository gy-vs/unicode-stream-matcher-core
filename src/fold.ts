/**
 * Per-code-point normalization fold: lowercase (locale-independent) -> NFD ->
 * drop marks (\p{M}). Processing one scalar value at a time is exactly
 * equivalent to whole-string folding because:
 *
 *  - NFD never composes code points together and never merges across starter
 *    boundaries (canonical reordering only permutes combining marks, which we
 *    discard anyway);
 *  - lowercasing per code point differs from `String#toLowerCase` only for
 *    Greek final sigma (U+03A2 -> U+03C2, context dependent). We deliberately
 *    use the locale-independent, context-free per-code-point mapping so that
 *    streaming and whole-stream results are identical.
 *
 * Results are cached in a bounded LRU (never growing with stream length).
 */

const CACHE_LIMIT = 4096;
const cache = new Map<number, string>();

const MARK_RE = /\p{M}/u;

function computeFold(cp: number): string {
	// Lone surrogates only occur in malformed pattern strings; decoded text can
	// never contain them. Keep them total (raw lowercased unit) instead of
	// throwing inside String.fromCodePoint.
	if (cp >= 0xd800 && cp <= 0xdfff) return String.fromCharCode(cp).toLowerCase();
	const lowered = String.fromCodePoint(cp).toLowerCase();
	const decomposed = lowered.normalize('NFD');
	let out = '';
	for (const ch of decomposed) {
		if (!MARK_RE.test(ch)) out += ch;
	}
	return out;
}

/**
 * Folded UTF-16 code units for one scalar value (may be empty for pure marks).
 * The returned string must not be mutated by callers (cache identity).
 */
export function foldCodePoint(cp: number): string {
	let hit = cache.get(cp);
	if (hit !== undefined) {
		// Refresh LRU recency.
		cache.delete(cp);
		cache.set(cp, hit);
		return hit;
	}
	hit = computeFold(cp);
	cache.set(cp, hit);
	if (cache.size > CACHE_LIMIT) {
		// Evict oldest entries (Map iteration order is insertion order).
		const evictCount = CACHE_LIMIT >> 2;
		let n = 0;
		for (const key of cache.keys()) {
			cache.delete(key);
			if (++n >= evictCount) break;
		}
	}
	return hit;
}

/** Fold an entire pattern string (same per-code-point algorithm). */
export function foldPattern(pattern: string): string {
	let out = '';
	for (let i = 0; i < pattern.length; i++) {
		const cu = pattern.charCodeAt(i);
		if (cu >= 0xd800 && cu <= 0xdbff && i + 1 < pattern.length) {
			const lo = pattern.charCodeAt(i + 1);
			if (lo >= 0xdc00 && lo <= 0xdfff) {
				const cp = 0x10000 + ((cu - 0xd800) << 10) + (lo - 0xdc00);
				out += foldCodePoint(cp);
				i += 1;
				continue;
			}
		}
		out += foldCodePoint(cu);
	}
	return out;
}

/** Test-only: number of cached folds (bounded by CACHE_LIMIT). */
export const __foldCacheSize = (): number => cache.size;
