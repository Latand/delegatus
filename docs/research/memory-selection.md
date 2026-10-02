# Memory selection: 100 operator messages; no qualifying injection threshold

Study date: 2026-10-02. Successor to the seven-first-request pilot on PR #2475,
using the existing Phase 1 index and replay runner. **Keep on-demand search;
Phase 3 automatic injection remains no-go on this evidence.** The reason is
measured relevance across 100 operator messages. The corpus was large enough
for the requested sample.

The sample contains **100 messages from 30 conversations**, 78 received by
Claude and 22 by Codex, spanning five projects with operator input. All seven
project keys in the transcript index were examined. There were **548 eligible
operator events**, so no undersized-population exception was needed. The
sample spans 2026-07-23 through 2026-10-02.

Among 1,348 eligible retrieved candidates, contextual reviewers labelled ten
potentially useful. Jev's best observed nonempty threshold, **0.70**, offered
29 entries, of which one was useful: **3.45% precision**, 95% interval
**[0.00%, 11.54%]**, and 10% candidate recall. At 0.90 and above it offered
nothing. FTS's best observed precision was **1.76% at score 10**, with three
useful entries among 170 offers. Neither arm approached the quality target.
The study measures incremental relevance, not improvement in task completion.

## Population, authorship and sampling

The runner opens the transcript and memory SQLite indexes read-only, in read
transactions. It considers **every indexed user message at every position**
for both engines and every project. It reads each indexed source line for
native metadata and the Claude delivery ledgers for admission-stamped origin;
these reads do not instantiate live stores or refresh either index.

Authorship uses delivery origin where available: agent-origin messages are
excluded. Native `isMeta` and system-source records are excluded. The written
legacy rule in `machineMessage` removes recognizable controller/seat ticks,
pipeline and role scaffolds, recovery prompts, agent completion notices,
review/fix round relays, compaction summaries and tool/system text. Older
transcripts lack uniform positive authorship provenance: residual user-role
text is included, with explicit legacy-template exclusions and a contextual
sample audit. This is a reproducible operational classification, not proof
that every unmarked historical record was physically typed by a person.
The sample audit found two remaining machine relays; the final rule excludes
them and the same deterministic sampler fills their places before scoring.

Transport markers, viewer selection envelopes and image path wrappers are
stripped. A short reply, continuation, attachment-bearing request, pasted
stakeholder conversation or operator-supplied log is retained with context.
Image-description companion records contain no operator text and are excluded.
Copies of the same native event are folded by UUID, or by engine/timestamp/body
identity when there is no UUID; independently written repeated answers remain
eligible. No minimum text length, first-turn filter or project whitelist is used.

| Count | Value |
| --- | ---: |
| Indexed user records | 4,485 |
| Indexed conversations with user records | 1,461 |
| Machine/system/attachment-companion records | 3,916 |
| Copies of eligible events | 21 |
| Eligible operator events | **548** |
| Sampled events | **100** |
| Phase 1 memory entries | 7,673 |

Project aliases below are assigned by sorted index project key. The private
sample retains the mapping and source offsets; identities are not published.
Zero-operator projects remain in this accounting.

| Project alias | Receiving engine | Indexed records | Eligible events | Sample |
| --- | --- | ---: | ---: | ---: |
| project-1 | claude | 23 | 12 | 12 |
| project-1 | codex | 2 | 0 | 0 |
| project-2 | claude | 1 | 0 | 0 |
| project-3 | claude | 15 | 5 | 5 |
| project-3 | codex | 37 | 0 | 0 |
| project-4 | claude | 655 | 156 | 21 |
| project-4 | codex | 1705 | 264 | 20 |
| project-5 | claude | 413 | 71 | 20 |
| project-5 | codex | 1418 | 0 | 0 |
| project-6 | claude | 165 | 38 | 20 |
| project-6 | codex | 44 | 2 | 2 |
| project-7 | claude | 3 | 0 | 0 |
| project-7 | codex | 4 | 0 | 0 |

Sampling is equal allocation across nonempty **project × engine** strata,
with unused slots redistributed as strata exhaust. Within a stratum, sort
by SHA-256 of the fixed seed `memory-selection-v1`, transcript identity and
message index; round-robin sorted strata until 100. This deliberately gives
small projects coverage. Results describe this balanced sample, without
claiming proportional estimates for the complete operator population.

Each private case stores the message and **all preceding indexed turns** in
chronological order, never a subsequent turn. There are 89.6 preceding turns
per case on average. Repeated prompts in one conversation are dependent;
uncertainty therefore resamples whole conversations.

## Candidates, context and labels

For each case the runner retrieves the **top 30 surviving FTS candidates**
from that conversation's project plus global entries. The receiving engine's
own entries are removed. Near-native matches are also removed against all
entries authored by that engine: token-set Jaccard similarity at least 0.80
on title-plus-summary or body, requiring at least five tokens. Whole instruction
entries already belonging to the launch context are excluded as in the pilot.
Repeated Claude index pointers to the same memory file are folded. The index
snapshot is contemporary with the experiment, not reconstructed as of each
historical prompt; availability and applicability in the past remain limitations.

The recall query uses the current message followed by preceding turns newest
first, the first 16 distinct non-stopword terms of length at least four, joined
by OR, and Phase 1 BM25 weights `(0, 5, 2, 1)`. Both arms receive identical
candidates. This extends the pilot's exploratory recall query; it does not
change production `search_memory` semantics. The literal AND query remains
a diagnostic. FTS confidence is **negative BM25**, so larger scores rank higher;
it is an uncalibrated retrieval score, not a probability.

Three model reviewers adjudicated disjoint case sets before Jev scores existed.
They read the current requests and offered summaries, relevant preceding
exchanges, relevant candidate bodies, and searched older stored context for
references and redundancy. They did not claim to read every byte of every
long history or irrelevant skill body. Two replacement cases were adjudicated
before scoring; labels of the 98 retained cases were mapped by exact source
identity, with identical candidate memory IDs. This is single adjudication
per case, without inter-rater agreement or downstream outcome validation.

**Label rule:** helpful means the offered title and summary provide a specific,
applicable fact, rule or reference that would change the next response/action
beyond what the prompt and preceding conversation already provide. General
topic overlap, inapplicable environments, already-known facts, superseded
instructions and unsupported assumptions are false. Borderline cases are false.
The [public labels](memory-selection.all-turns.labels.json) contain only
scrubbed English paraphrases and explicit candidate judgments.

Jev receives the redacted current message (up to 8,000 characters), a trailing
16,000-character view of prior turns with role labels, and candidate titles
(up to 160 characters) and summaries (up to 400). Each candidate gets a `noul`
question about incremental usefulness. The full prefix stays in the private
case for contextual review. **89 cases had older context omitted from Jev's
view; no current message was truncated.** Omission is explicitly marked.
This bounds the payload for Jev's [32K input window](https://openrouter.ai/typesafe/jev-1.13/).
It also means this experiment does not measure a classifier receiving an
unbounded full conversation. Older facts can explain additional false offers.
Credential lines and opaque credential-shaped values are redacted before calls.

## Confidence thresholds and injection budget

The target, fixed before Jev scoring, is **at least 90% precision among offers**:
automatic context should rarely send an agent irrelevant instructions. A
candidate operating point must also have a **95% lower bound of at least 80%**
and **at least 20 offers**, to avoid accepting a threshold on one lucky hit.
Among qualifying points choose highest recall, then the lower threshold.
**No FTS or Jev threshold qualifies. Recommend no automatic injection.**
A Jev cutoff of 0.90 currently abstains completely; that establishes no
precision guarantee and provides no reason to pay for it on every message.

Both arms sort candidates by their own score, retain those meeting the
threshold, and offer at most **15 entries and 10,000 characters**. An entry
that does not fit is skipped; smaller later entries may fit. Counts are set
by confidence, with no fixed minimum. The measured offer is exactly
`title + newline + summary + newline`, including separators. Character
accounting uses JavaScript UTF-16 units, a conservative cap for Unicode code
points. FTS thresholds are 0, 2, 5, 10, 15, 20, 30; Jev thresholds are 0,
0.50, 0.70, 0.80, 0.90, 0.95, 0.99. No injection returns no entries.

## Results with 95% intervals

Precision is useful selections divided by all offers; recall is useful
selections divided by all retrieved candidates labelled useful across cases. Recall is conditional on the retrieved pool, not all
7,673 memories. Empty-offer precision is undefined. Means include all 100
messages, including cases with no candidates or no offers. Brackets are 95%
intervals; precision and recall are percentages.

| Arm | Threshold | Offered | Precision % [95%] | Recall % [95%] | Mean entries [95%] | Mean characters [95%] |
| --- | ---: | ---: | --- | --- | --- | --- |
| fts | 0 | 801 | 0.62 [0.10, 1.52] | 50.00 [11.11, 100.00] | 8.01 [6.47, 10.27] | 1700.22 [1385.46, 2151.44] |
| fts | 2 | 774 | 0.65 [0.10, 1.55] | 50.00 [11.11, 100.00] | 7.74 [6.20, 9.98] | 1639.04 [1321.00, 2099.58] |
| fts | 5 | 495 | 0.61 [0.00, 1.80] | 30.00 [0.00, 62.50] | 4.95 [3.68, 6.82] | 1081.36 [816.09, 1458.24] |
| fts | 10 | 170 | 1.76 [0.00, 5.34] | 30.00 [0.00, 62.50] | 1.70 [0.88, 3.02] | 365.53 [193.39, 637.89] |
| fts | 15 | 27 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.27 [0.12, 0.52] | 60.03 [25.96, 114.54] |
| fts | 20 | 9 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.09 [0.03, 0.19] | 20.07 [6.36, 42.13] |
| fts | 30 | 3 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.03 [0.00, 0.09] | 8.53 [0.00, 24.30] |
| jev | 0 | 801 | 1.25 [0.36, 2.43] | 100.00 [100.00, 100.00] | 8.01 [6.47, 10.27] | 1778.71 [1445.63, 2258.59] |
| jev | 0.5 | 187 | 3.21 [0.46, 7.53] | 60.00 [16.67, 100.00] | 1.87 [1.23, 2.85] | 403.38 [258.84, 618.47] |
| jev | 0.7 | 29 | 3.45 [0.00, 11.54] | 10.00 [0.00, 40.00] | 0.29 [0.15, 0.52] | 54.29 [27.41, 98.08] |
| jev | 0.8 | 3 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.03 [0.00, 0.07] | 5.94 [0.00, 14.49] |
| jev | 0.9 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| jev | 0.95 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| jev | 0.99 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| none | — | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |

Intervals use 2,000 percentile bootstrap resamples of the **30 conversation
clusters**, xorshift32 seed 2475, with nearest-rank endpoints. All messages
from a drawn conversation travel together; paired differences use the same
resampled indices. Undefined denominators are omitted, with valid draw counts
published. These intervals are conditional on the sampled corpus and labels;
they exclude authorship error, labelling uncertainty, candidate-generation
bias, provider variation and threshold-selection optimism. They are not
simultaneous confidence bands over the sweep.

There is **no qualifying operating point at which to claim a nonempty paired
precision win**. At the predeclared high-confidence reference pair, Jev 0.90
versus FTS score 10, the precision difference is undefined because Jev abstains;
recall changes by −30 percentage points, 95% interval **[−62.50, 0.00]**.
For an explicitly exploratory comparison of the best observed nonempty
precision points, Jev 0.70 versus FTS 10 is **+1.68 percentage points**,
95% paired interval **[−4.57, +10.00]**. Its recall is 20 points lower.
This does not establish a Jev advantage or meet the quality target.

## Latency, token limit and spend

| Arm | Median | p99 |
| --- | ---: | ---: |
| FTS retrieval including scope/native filtering | 20.06 ms | 318.26 ms |
| Same retrieval plus Jev HTTP/parse | 306.25 ms | 646.77 ms |
| No injection, no retrieval or provider call | 0 ms | 0 ms |

These are warm-process measurements across all 100 cases, with no HTTP call
for 14 empty pools. Selection/serialization overhead, process launch and live
hook integration are outside the timers. p99 is nearest-rank observation 99
of 100. The runner allows 30 seconds per call for measurement and never retries;
this is not a proposed production-hook timeout.

**Zero offers at every threshold exceed Codex's default 2,500-token
`additionalContextLimit`**, both across all cases and within the 22 Codex
cases. Counting uses `ceil(UTF-8 bytes / 4)` over the exact offer string,
matching Codex's approximate byte-based accounting. This is a hook spill
threshold, not an exact model-token measurement; [Codex documents the default
and its per-handler behavior](https://learn.chatgpt.com/docs/hooks).
The [string utility](https://github.com/openai/codex/blob/main/codex-rs/utils/string/src/truncate.rs)
implements the approximation. Unicode and the full 10,000-character cap can
exceed 2,500 approximate tokens in general; regression tests cover that case.

| Spend item | Input tokens | USD from usage fields |
| --- | ---: | ---: |
| 86 new Jev decisions | 855,222 | **0.035919324** |
| Reused original probe receipt; no new call | 367 | 0.000015414 |
| This ledger including probe | 855,589 | **0.035934738** |
| FTS / no injection | 0 | 0 |

The previous pilot and seven-request repeat together spent $0.001101618,
including the probe once. Total across those studies and these new decisions
is **$0.037020942**. All 86 new calls completed and there are no unsettled
reservations. The [public numeric results](memory-selection.all-turns.results.json)
publish usage receipts, scores, selections, sizes and cluster IDs, so metrics
can be recomputed without exposing source text.

## Seven-first-request pilot and repeat, retained separately

The original pilot selected only seven first requests, six Codex and one
Claude, from two project keys. Its fixed budget was eight candidates and
three slots, with no preceding-conversation context and Jev threshold 0.70.
The later first-request repeat examined more indexed messages but retained
exactly the same seven requests. Neither is pooled with the current sample.

| Earlier run / arm | Offered | Helpful | Precision among offers | Candidate recall |
| --- | ---: | ---: | ---: | ---: |
| Pilot FTS | 21 | 5 | 23.81% | 83.33% |
| Pilot Jev | 8 | 2 | 25.00% | 33.33% |
| First-request repeat FTS | 21 | 5 | 23.81% | 83.33% |
| First-request repeat Jev | 7 | 1 | 14.29% | 16.67% |

Original [pilot labels](memory-selection.pilot.labels.json) and
[pilot results](memory-selection.pilot.results.json), and the later
[first-request labels](memory-selection.labels.json) and
[first-request results](memory-selection.results.json), remain unchanged.
Their no-go conclusions were limited pilots. The new study replaces the
claim that only seven eligible operator prompts exist: there are 548 under
the all-turn collection rule in this snapshot.

## Safety and reproduction

The existing runner was extended with version-2 collection, confidence budgets,
native-store comparison and cluster metrics; its pilot replay functions and
budget protections remain tested. It writes private samples, labels, receipts
and public aggregate exports only. No engine memory, Jev setting, live prompt,
index or runtime state is mutated by the replay.

The authorized key is loaded from the local OpenRouter secret into
`OPENROUTER_API_KEY` for the runner process only; it is never logged, saved in
a ledger or published. Every sequential request durably reserves the greater
of $0.01 and the full serialized request byte count plus 4,096 overhead tokens
at the pinned input price. Admission refuses any call that would exceed the
**$2.00 ledger cap**. A lock permits one runner. Missing/ambiguous receipts
retain their reservation and block replay; an over-bound provider receipt
blocks subsequent calls, also after restart. Sample, labels and serialized
requests are hashed so changed inputs cannot reuse old decisions. This is a
conservative bound at the pinned price, not a provider-enforced account quota.

```sh
LLV_STATE_DIR="$PRIVATE_STATE" bun test scripts/memory-selection.test.ts
LLV_STATE_DIR="$PRIVATE_STATE" bun scripts/memory-selection.ts collect "$TRANSCRIPT_DB" "$MEMORY_DB" "$PRIVATE_SAMPLE"
# Adjudicate labels before scoring, then launch with the process-only key.
LLV_STATE_DIR="$PRIVATE_STATE" bun scripts/memory-selection.ts jev "$PRIVATE_SAMPLE" "$LABELS" "$RESULTS" "$LEDGER" "$EXISTING_PROBE"
# Re-export completed results offline, without reading any key or calling Jev.
LLV_STATE_DIR="$PRIVATE_STATE" bun scripts/memory-selection.ts report "$PRIVATE_SAMPLE" "$LABELS" "$NEW_RESULTS" "$LEDGER"
```

Output paths are exclusive-create. `population` uses the same collector without
candidate retrieval for authorship audits. Private samples retain the indexed
source provenance and preceding turns; public files contain no real prompt
text, personal identifiers, account names, hostnames or private paths.

Exact-path isolated tests verify all-turn inclusion, copy handling, the actual
SQLite collection boundary, preceding-context ordering, 30-candidate retrieval,
near-native matching, confidence/character caps, paired intervals, Unicode
token overflow, provider failure/restart accounting and public-result
reproduction. Targeted TypeScript and ESLint checks cover the touched runner
and tests. The local privacy gate uses the fingerprint catalog,
`--require-known-values` and `--check-commits` before push. Hosted CI is not
part of this stage's completion gate.
