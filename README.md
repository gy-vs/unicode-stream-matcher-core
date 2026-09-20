# Unicode stream matcher

Incremental, multi-pattern Unicode search over **async byte streams**. Input
chunks may split a UTF-8 sequence, a normalization combining sequence, or a
potential match at any point — results are identical to searching the whole
stream at once. Every match reports offsets in both the **raw byte stream**
and the **UTF-16** text (and stays correct after U+FFFD replacements).

## Pipeline

```
bytes ─▶ incremental UTF-8 decoder ─▶ grapheme grouper
      ─▶ per-code-point NFD + lowercase + strip marks
      ─▶ Aho-Corasick automaton ─▶ committed matches
```

Driven as a pull-based async generator (`searchStream`), so a slow consumer
applies backpressure all the way to the producer: no chunk is buffered ahead
of demand.

### Commit rule

A match is released only when the grapheme cluster containing its ending
unit closes (or at EOF). A combining mark, ZWJ emoji continuation or second
Regional Indicator arriving in a later chunk can therefore never change an
already-committed prefix. Matches are ordered by
`(u16End, u16Start, patternIndex)`.

### Bounded memory (independent of stream length)

| stage | retained state |
| --- | --- |
| UTF-8 decoder | at most 3 carried bytes of one partial sequence |
| grapheme grouper | the single open cluster |
| automaton history | `longestPatternLength` normalized UTF-16 units (ring) |
| pending matches | occurrences ending in the open cluster |

## Usage

```ts
import { searchStream, searchBytes, searchText } from './dist/index.js';

// Async byte stream (back-pressured). Cancel with `break` or an AbortSignal.
for await (const m of searchStream(byteChunks, ['cafe', 'café'])) {
  // m.byteStart / m.byteEnd     — raw byte offsets (end exclusive)
  // m.u16Start  / m.u16End      — UTF-16 offsets
  // m.patternIndex / m.pattern
}

const oneShot = searchBytes(uint8array, patterns);
const strings = searchText('Café', ['cafe']);
```

### Options

- `mode: 'strict' | 'replace'` (default `'replace'`) — malformed UTF-8 throws
  `Utf8DecodeError`, or is substituted with U+FFFD following the WHATWG
  Encoding standard (each replacement carries its consumed byte span).
- `emptyPatterns: 'throw' | 'match' | 'ignore'` (default `'throw'`) — policy
  for patterns that normalize to nothing (`''` or mark-only). `'match'`
  reports zero-width hits at every grapheme boundary and EOF.
- `signal: AbortSignal` — aborts promptly, even while the producer is
  blocked; the source's `return()` is invoked on cancellation.

### Matching normalization

Patterns and text use the same per-code-point operation:
`NFD → lowercase → strip Unicode combining marks (\\p{M})`, so precomposed
`é` and `e + U+0301` are equivalent, and matching is case-insensitive.
ZWJ is not a mark, so emoji ZWJ sequences are kept literally.

A match's **byte end** absorbs trailing combining marks in the same grapheme
(so precomposed and decomposed input report equal source clusters); the
**UTF-16 end** points at the last normalized unit (stripped marks add no
UTF-16 units).

## Development

```sh
npm install
npm test      # vitest, incl. 200k-case decoder fuzz and chunk-invariance fuzz
npm run build
```

The legacy `findMatches`/`normalizeText` string API remains exported.
