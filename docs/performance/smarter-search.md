# Smarter transcript search verification

The pinned design is [smarter-search.md](../design/smarter-search.md).
Its public copy omits recorded queries and transcript quotations. The replay
script and its tests contain invented fixtures only; measurement inputs remain
outside the repository.

## References checked against main

| Design reference | Current implementation |
| --- | --- |
| `ftsQuery`, `openWriterDatabase`, `indexTranscriptSources` | Remain in `src/lib/search/transcriptSearch.ts`; `ftsQuery` becomes the pure `queryUnits` parser. |
| `canonicalProject`, `projectAliasSnapshot`, remote map | Remain in `src/lib/projects/aliases.ts`; main already exports `recordedProjectRemotes()`, so that file needs no edit. |
| `projectForCwd` | Remains in `src/lib/scanner/describe.ts`; search uses the same worktree recognizers. |
| Transcript route, `searchTranscripts` MCP binding, presentation | Remain at the paths in the design. The binding sends its explicit order to the route. |
| Dialog hook and `GlobalSearch` | Remain unchanged; the route defaults to newest. |
| Search, route, MCP and schema tests; synthetic bench | Existing files remain; cases extend them. |
| Replay harness | The design lane's script was never committed. `scripts/transcript-search-replay.ts` implements its recorded-call extraction, time fence, seeded sampling and newest baseline, and invokes the production relevance implementation. |

## Implementation differences

- Schema v5 also creates a covering hit-metadata index. On the synthetic
  corpus, fetching metadata through message rows took about 1.7 seconds for
  the common pair because long bodies precede metadata in the SQLite record.
  The covering index avoids reading bodies for those hits. The first unchanged indexing pass
  that created it took 3.4 seconds on 250,000 messages; it preserves message
  IDs, hashes and the FTS index. The vocabulary table remains persistent.
- Relevance cursors also preserve interpreted units, weights, scoring time
  and folded-snippet signatures. Counts for length damping are fenced by
  the saved message ID. These preserve ordering when indexing adds rows,
  including when a frequency crosses the common-word threshold.
- Project resolution runs in the library so every caller uses the same
  semantics. It prefers the most specific name (such as `owner/name`) over
  a shared repository basename, and reports unknown or ambiguous scopes.
- Word forms use the design prototype's en/ru/uk suffix rules, including
  final-e Latin forms. Digit, underscore and hashtag tokens stay exact.
- Newest avoids vocabulary lookups and never drops units. Prefix expansion
  therefore retains every unquoted old match while preserving its time order.
- The recorded prototype also excludes vocabulary units with zero document
  frequency. D3's prose omitted that rule. Relevance follows the measured
  prototype and reports these units in `interpretedAs.ignored`; a query whose
  content units are all absent returns an empty page. Newest still requires
  every unit.
- `strongTotal` reports conversations covering at least 60% of the retained
  units before folding or paging, so the replay uses the design's strong-zero
  definition independently of the six returned results.

## Reproduction

Generate an invented corpus with
`bun scripts/transcript-search-fixture.ts <scratch>/fixture --conversations 7200 --messages 250000 --seed 1429`.
Run `scripts/transcript-search-bench.ts` with that fixture, an explicit private
`LLV_STATE_DIR`, and `--repeat 5`. The driver enforces a 300 ms relevance
common-pair median and a 6 KB six-conversation page.

Back up the live index through a **read-only** SQLite connection into a fresh
private directory. Copy project alias/remote maps there, then run
`LLV_STATE_DIR=<private-copy> bun scripts/transcript-search-replay.ts --sample 1000 --pairs 300 --since 2026-08-27`.
The script refuses operator/repository state directories and linked index
files. Each recorded query sees only messages at or before its call time and
excludes its issuing transcript. Only aggregate metrics are emitted.
The baseline preserves v4's exact AND and newest body collapse. Its recall
counts distinct conversations in first-occurrence order, as the design did.

Run heavy checks under `flock /var/tmp/llv-heavy-gate.lock`.

## Measured results

Fresh read-only backup reduced to the v4 schema before replay, 10,338
transcripts available for recorded-call extraction, 12,633 distinct
query/project pairs. The 1,000-query sample uses seed 20260926 and the design
lane's first-discovery ordering, updating the earliest call in place. Word
counts: 156 single-word, 220 two-word, 278 three/four-word, 261 five/seven-word
and 85 eight-or-more-word queries. Opened-transcript sampling uses seed 7 and
300 distinct query/opened-transcript pairs.

| Metric | v4 baseline | Relevance |
| --- | ---: | ---: |
| Zero-result rate, strong | 53.4% | 2.6% |
| Zero-result rate, any | 53.4% | 2.6% |
| Opened transcript in top 6 | 166 / 300 (55.3%) | 181 / 300 (60.3%) |
| Query p50 | 4.9 ms | 70.6 ms |
| Query p95 | 35.9 ms | 262.1 ms |
| Query maximum | — | 500.1 ms |

The strong-zero acceptance threshold is 8%; recall must be at least the
baseline. Both hold. The ranked p95 stays below the design's 350 ms band. The
replay includes interpretation, project resolution, ranking, folding and
snippet generation. If no conversation meets the coverage bar, retrieval
retries the rarest original term and reports the omitted terms. On the first
recorded query against this v4-shaped copy,
the search took 64.7 ms and the zero-delay event-loop timer fired after 64.9 ms.
The migration and vocabulary/index build finished in the background in 4.1 s;
steady query timings were collected after the covering index became available.
The route regression also sends a real HTTP request against a 10,000-message
v4 fixture; it returns in under 350 ms while a zero-delay timer runs, then
waits for the background vocabulary and index build to finish.

On the 250,000-message invented fixture (five repetitions), relevance's
common-pair library median is 122 ms for both speakers and 82 ms for user
messages. The packaged MCP median for the common pair is 122 ms. Every
six-conversation fixture page passes the driver's 6 KB check.

Newest common-pair library medians are 6,418 → 56 ms (user) and 74 → 77 ms
(both); the very-common-word cells are 2,252 → 114 ms (user) and 248 → 222 ms
(both). The baseline uses the unchanged main library on a separate copy of
the same synthetic index with the added covering index removed. A paired
rare-word run (100 repetitions after warm-up) measures 1.784 → 1.928 ms,
+8.1%, within the 10% allowance. All newest library cells satisfy that
allowance; rare user-scoped queries improve from 729 ms to about 3 ms.

## Review-fix checks

- `bun test src/lib/search/transcriptSearch.test.ts`: 33 passed, including
  v4 migration responsiveness and duplicate groups across pages.
- `bun test src/app/api/search/transcripts/route.test.ts`: 10 passed, including
  an HTTP request during background migration.
- `bun test scripts/transcript-search-replay.test.ts`: 4 passed.
- `bun node_modules/typescript/bin/tsc --noEmit`.

No deployment is included. The fenced privacy-gate, board-maintenance and
monitor areas and the repository instruction files remain untouched.
