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
- Relevance cursors preserve interpreted units, weights, scoring time
  and compressed identities of visited conversation files. Counts for length damping are fenced by
  the saved message ID. These preserve ordering when indexing adds rows,
  including when a frequency crosses the common-word threshold.
- Project resolution runs in the library so every caller uses the same
  semantics. It prefers the most specific name (such as `owner/name`) over
  a shared repository basename, and reports unknown or ambiguous scopes.
- Word forms use the design prototype's en/ru/uk suffix rules, including
  final-e Latin forms. Digit, underscore and hashtag tokens stay exact.
- Newest never drops units. Small exact dictionary unions accelerate prefix
  matching. A bounded expression cache is fenced by file identity, schema and
  the indexed message high-water ID, so new word forms invalidate it. Ready
  indexes use stored timestamps without per-hit compatibility joins; activity
  date reads retain their covering range index too.
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

Run every benchmark, replay and large-fixture test under a hard memory cap:
`systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 -- flock /var/tmp/llv-heavy-gate.lock <command>`.
Use a private `LLV_STATE_DIR` and a temporary root outside operator state.
Measure a small slice's peak RSS before expanding a workload.
For stage checks, set `TMPDIR` to the private scratch root too: an inherited
temporary directory inside operator state is correctly refused by replay guards.

## Response budget and paging

Relevance snippets retain at most 512 serialized UTF-8 bytes each, including
JSON escapes. Truncation preserves Unicode scalar values and complete match
markers. Each library page, including metadata and cursor, fits 12 KiB with
space reserved for route titles; HTTP and decoded MCP pages fit 16 KiB.
Conversation count and bytes both drive pagination. Required jump coordinates
remain intact. A single item or interpretation whose metadata cannot fit is
rejected with a bounded HTTP 400 asking for a narrower query or project.

Relevance has no one-word strong retry. Every result keeps the originally
retained units as its coverage denominator and reports its missing units.
Quoted phrases are always atomic. Unquoted hyphenated terms and paths are
atomic on the first pass; when that pass has no strong match, the second pass
may also match their parts near each other in one message, and marks the unit
with `~`. During migration a
bounded subset can be retrieved while the full denominator remains unchanged.

Copies with identical 16-token lead snippets fold even when their remaining
body text differs. Complete-body copies share one signature calculation;
other lead signatures are computed in one batched FTS scan before pagination.
This extends the design's candidate-only snippet pass to preserve complete
copy counts across pages. Only returned fragments have jump metadata hydrated.
The cursor stores compressed delta-varint file identities, so pruning an
earlier hit or truncating unrelated messages cannot skip a surviving
conversation whose score changes. Cursor decoding bounds decompression too.

## Previous review-fix measurements

On the existing 250,000-message invented fixture (five repetitions, hard
12 GiB cap), all six-conversation pages pass the existing 6 KiB fixture gate.
The common-pair library median is 130.5 ms for both speakers and 86.7 ms
for user messages; the packaged MCP median is 135.2 ms. The final
benchmark peak RSS was 496 MiB. It includes library, route, HTTP and packaged
MCP; the unchanged UI driver was skipped in this backend fix round.

Paired newest measurements use the byte-identical current main library on a
separate copy of the same index, without the PR's covering hit index. Five
warm-ups precede each cell and execution order alternates. Rare cells have
200 repetitions; common cells have 15.

| Query cell | Speaker | Main ms | Revised ms | Change |
| --- | --- | ---: | ---: | ---: |
| rare | user | 0.640 | 0.652 | +1.8% |
| rare | all | 0.674 | 0.688 | +2.1% |
| common pair | user | 27.774 | 27.295 | -1.7% |
| common pair | all | 38.032 | 37.337 | -1.8% |
| very common | user | 71.775 | 69.765 | -2.8% |
| very common | all | 119.146 | 118.112 | -0.9% |

All cells satisfy the 10% allowance. This paired run peaked at 411 MiB RSS.
A 20-pair rare-query slice peaked at 44 MiB; 2,000 pairs plateaued at 64 MiB.
The preceding attempt's reported 125 GB OOM has not been reproduced or
causally attributed. Subsequent measurements all ran under a hard cap.

The real standalone build contains a bundled worker and its runtime chunks.
Its production worker migrates a private v4 fixture to v5, preserves message
IDs, hashes and FTS rows, creates vocabulary/indexes, and restores complete
ranked coverage. Failed worker exits are reported and later searches retry.

## Main-versus-PR baseline and acceptance

The 2026-10-02 decision accepts PR #2397 as a measured improvement:
**net improvement over main on the same replay; ≤8% strong-zero tracked as
follow-up**. The named follow-up is
[Strong-zero recall ≤8%](../design/smarter-search.md#follow-up-strong-zero-recall-8).
The target remains unmet and is no longer a merge blocker.

The independent paired replay measured main at `30f50035` and the published
PR at `b8373b64`, using identical offline index copies and seeded inputs:
1,000 queries with seed 20260926 and 300 search/open pairs with seed 7.
Strong means coverage of at least 60% of retained units; strong-zero includes
weak-only and zero results. Both sides preserve historical time,
issuing-transcript exclusion and project scope. Only aggregates are published.

| Metric | Main | PR |
| --- | ---: | ---: |
| Strong queries | 386 / 1,000 | 879 / 1,000 |
| Weak-only queries | 1 / 1,000 | 53 / 1,000 |
| Zero queries | 613 / 1,000 | 68 / 1,000 |
| Strong-zero | 61.4% | 12.1% |
| Opened transcript in top-6 | 34 / 300 | 42 / 300 |
| Search latency p50 | 0.49 ms | 5.2 ms |
| Search latency p95 | 1.39 ms | 16.4 ms |

Recall improved on 545 queries with no recall regressions. Opened top-6 had
14 wins and six losses: four two-word and two three-to-four-word queries,
all without project scope. The aggregate top-6 gain coexists with those
ranking losses. Searches are slower at both reported latency percentiles.
This comparison establishes net improvement under the revised acceptance;
it does not establish the ≤8% follow-up target.

These are the independently measured revisions, rather than a new replay of
the final merged tree. The later atomic phrase-frequency fix is preserved;
its separate replay below reports 11.7% strong-zero and 43/300 opened top-6.
The update stage merges current main and changes the documentation only.

## Historical phrase-frequency replay

The previous reported 2.6% strong-zero result used a one-word retry that
changed the coverage denominator. It is invalid as evidence for the 8%
strong-zero target and is withdrawn.

The latest phrase-frequency fix replay ran on 2026-10-02 against a separate
scratch copy of the supplied consistent offline snapshot. Recorded calls were read from 479
local transcripts, bounded by the snapshot's recorded file sizes; no files
were unavailable. The seeded sample contains 1,000 of 2,477 distinct queries
since 2026-08-27. Each query retains the historical time and issuing-transcript
exclusion fences. No query text or transcript content is published.

| Result | Count | Rate |
| --- | ---: | ---: |
| Baseline zero | 613 | 61.3% |
| Revised strong | 883 | 88.3% |
| Revised weak only | 52 | 5.2% |
| Revised zero | 65 | 6.5% |
| Revised strong-zero (weak or zero) | 117 | 11.7% |

The unchanged 60% retained-unit coverage criterion gives **11.7% strong-zero,
above the 8% follow-up target**. This replay does not establish that target;
the 2026-10-02 decision replaces the former recall merge gate with the paired
net-improvement acceptance above. Among 300 recorded search/open pairs,
opened-transcript top-6 count improves from 34 to 43 (11.3% to 14.3%),
satisfying its baseline comparison. Query lengths are 174 one-word,
211 two-word, 309 three-to-four-word, 242 five-to-seven-word and 64 longer queries.

Revised latency p50/p95/max is 5.60/17.01/38.54 ms; baseline p50/p95 is
0.20/0.51 ms. On the already migrated private index, the first search takes
13.38 ms and its event-loop timer fires after 13.45 ms. Peak RSS is
186,076 KiB (182 MiB). Extraction, replay and measurement run under the hard
8 GiB scope with swap disabled and the shared heavy-work lock. The cap is
not reached; the earlier reported 125 GB OOM remains unattributed. The live
index is never opened. Private scratch inputs are deleted after verification.

## Review-fix checks

99 tests pass across seven exact-path files, including the enabled real
standalone migration case against the existing standalone artifact, with
independent private state roots. The worker and migration code are unchanged
by the phrase-frequency fix. The earlier fix recorded eleven focused
regressions against its preceding implementation; the new atomic-frequency
regression also fails before its fix and passes afterward. Coverage includes denominator honesty, atomic phrases/paths,
long-token and multibyte HTTP/MCP pages, copy grouping, pruning during paging,
malformed relevance cursors, activity range-index use, background failure
retry, Unicode tokenizer folding, legacy timestamp preservation and real
standalone migration. TypeScript and changed-file ESLint pass (zero errors,
three existing warnings across the full PR). The privacy gate passes against
the merge base with commit checking on the final committed tree.

No deployment is included. The fenced privacy-gate, board-maintenance and
monitor areas and the repository instruction files remain untouched.

## Atomic-unit frequency fix and recall follow-up

Relevance now measures an atomic phrase's document frequency with its complete
FTS MATCH expression. The minimum frequency of its individual tokens was an
upper bound that incorrectly discarded rare phrases containing common words.
The same rule covers quoted phrases, hyphenated terms and paths. An absent
atomic phrase is explicitly ignored as one unit, following the existing
absent-vocabulary rule; its individual tokens never become retrieval units.

The invented regression has separate common-token filler messages and a rare
complete phrase. It fails before the fix and passes after it: the complete
conversation ranks first, the phrase remains matched, the partial hit reports
it missing, and only the complete conversation is strong. A separate production
regression keeps both retained units when only future or issuing-transcript
messages complete a query; the historical partial result remains weak.

The latest five-repetition 250,000-message benchmark under the hard 8 GiB cap
passes the 300 ms common-pair and 6 KiB fixture page gates. Common-pair library
and packaged MCP medians are both 137 ms; peak RSS is 510,472 KiB (499 MiB).
Library, route, HTTP and packaged MCP were exercised; UI was unchanged.

The former P1 recall acceptance blocker becomes the named
[Strong-zero recall ≤8%](../design/smarter-search.md#follow-up-strong-zero-recall-8)
follow-up under the 2026-10-02 decision. The phrase-frequency fix improves
strong-zero from 121 to 117 of the same 1,000 seeded queries and opened top-6
from 42 to 43 of the same 300 pairs. It does not reach the 8% follow-up target.
No coverage threshold, project scope, historical time or issuing-transcript
fence was relaxed, and ranking cannot change the corpus-wide strong count.

Private aggregate diagnostics found 34 failed queries with no retained units
(30 have only literal atomic/identifier/short-token candidates), 73 failures
that become strong when both historical/issuing fences are removed, and nine
that become strong unscoped. These groups overlap. A four-letter-prefix
experiment with the current retained interpretation still had 89 strong-zero
queries. That experiment is exploratory: it does not prove an impossibility
bound for every permitted word form or change in common-unit filtering.
Further recall work must establish a retrieval improvement within D1/D3 or
return to design with these corpus constraints; the current fix does not
claim the unmet follow-up target.

The preceding read-only review of the full diff found no additional source
defects; it retained the recall acceptance blocker under the former criterion.
The 2026-10-02 decision supersedes that criterion as described above.
TypeScript, changed-file ESLint (zero errors, three existing warnings across
the PR), and the privacy gate with commit checking pass. The merge rehearsal
against current main is clean.

## Acceptance-update checks

Current main was merged without conflicts. This update adds no product-source
changes beyond that merge and preserves the atomic phrase-frequency fix.
Six exact-path search/replay files pass 68 tests with isolated state and a
private temporary root; the standalone migration case is skipped because this
worktree has no built standalone artifact. TypeScript passes, and ESLint on
all TypeScript files changed by the PR reports zero errors and three existing
warnings. Heavy checks run through the machine's capped gate. The privacy publication
gate passes against main with commit checking.

The full seven-file run reports 97 passes, one skip and one failure at
`src/lib/mcp/schemaParity.test.ts:700`: the pipeline fail-edge description
assertion expects older wording. Both that assertion and the corresponding
pipeline description are unchanged from current main; the PR only appends a
search-order test in that file. This inherited pipeline mismatch is outside
the search update's scope. Five search/bounded-numeric MCP schema checks pass
separately; the remaining 25 schema cases are filtered out in that scoped run.

## Second pass for compound terms

The second pass is specified in
[D1 of the design](../design/smarter-search.md#d1-query-units-and-word-forms-on-the-query-side-no-reindex).
This section records its replay on 2026-10-04. The protocol is the one in
"Reproduction" above, unchanged: the same offline snapshot as the 11.7%
measurement, 1,000 queries with seed 20260926, 300 search/open pairs with seed
7, the historical time and issuing-transcript fences, project scope, 60%
coverage, and whole-corpus frequencies. The snapshot held the index only, so
no project maps were copied; main reproduces its earlier 117 and 43 on it,
which is the control. Each side ran against its own private copy under the
hard 8 GiB scope with the shared lock, in the order main, candidate, main,
candidate. Recorded calls came from 479 transcripts (none unavailable) and
2,477 distinct queries.

| Metric | Main | Second pass |
| --- | ---: | ---: |
| Strong queries | 883 / 1,000 | 892 / 1,000 |
| Weak-only queries | 52 / 1,000 | 47 / 1,000 |
| Zero queries | 65 / 1,000 | 61 / 1,000 |
| **Strong-zero** | **117 (11.7%)** | **108 (10.8%)** |
| Opened transcript in top-6 | 43 / 300 | 43 / 300 |
| Replay latency p50 / p95, run 1 | 5.29 / 16.52 ms | 5.42 / 16.74 ms |
| Replay latency p50 / p95, run 2 | 5.75 / 17.77 ms | 5.68 / 17.56 ms |
| Page size p50 / p95 / max | 4,907 / 6,977 / 8,615 B | 4,915 / 6,977 / 8,615 B |
| Peak RSS, larger run | 185 MiB | 194 MiB |

A paired comparison loaded both implementations in one process against one
copy and ran every query through each, alternating the order:

- **Recall:** 9 queries gain a strong match and none loses one. No unit of
  main's interpretation is missing from the candidate's, and no denominator
  shrinks, on all 1,000 queries.
- **Pages:** 991 pages are byte-identical to main's. The other 9 are the
  second-pass pages; the largest is 6,173 B. The page-size median moves by
  8 B because of those nine; p95 and max are main's.
- **Top-6:** 43 and 43, with no win and no loss among the 300 pairs.
- **Latency, best of seven rounds per query:** p50 4.82 → 4.91 ms and p95
  15.73 → 15.92 ms. Three earlier paired runs gave +0.09 / −0.01 ms,
  +0.12 / +0.10 ms and +0.11 / +0.05 ms. The cost falls on the 117 queries
  main leaves without a strong match: p50 0.76 → 1.14 ms, p95 7.52 → 11.69 ms.

The table and the paired figures are from the run repeated after the review
fixes: a term repeated inside and outside quotation marks stays quoted in
either order, and the `search_transcripts` description explains the `~` mark.
Every count is the same as before those fixes; only the timings and the peak
RSS are new readings. Peak RSS across the four runs was 171 and 185 MiB on
main, 189 and 194 MiB on the candidate.

The 8% follow-up is closed as unreachable on this protocol; the classes of the
117 failures, the 8.4% floor and the choice of an 8-token window are in
[the design](../design/smarter-search.md#follow-up-strong-zero-recall-8).

On the invented 250,000-message fixture (five repetitions, hard 8 GiB cap,
library, route and HTTP surfaces; packaged MCP and UI skipped as unchanged),
the new compound-term cell, an absent compound whose two parts are both
common, has a 77 ms library median against its 300 ms bound. The common-pair
relevance median is 134 ms and the six-conversation page gate passes; peak RSS
is 485 MiB.

Six new contract cases cover proximity, the growing denominator, no widening
beside a strong literal match, numeric parts and function words, identifier
prefix, and cursor continuation with forged wide units rejected. Four fail on
main and two hold the prohibitions there. With them, four exact-path search
and replay files pass 62 tests (one standalone migration case skipped for lack
of a built artifact), and the route and MCP search files pass 14. Private
scratch copies and outputs were deleted after verification.
