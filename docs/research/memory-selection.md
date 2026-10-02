# Memory selection: 100 requested, seven eligible; Phase 3 remains no-go

Study date: 2026-10-02. This implements [Phase 2 of the design](../design/agent-memory.md#6-phased-plan), building on the merged read-only index, PR #2417, at base `5b046f54c`.

**No-go for Phase 3.** The requested 100-prompt rerun exhausted the current
index at **seven usable first requests** under the pilot's exclusion rules.
They are the same seven requests as the pilot, so this is a repeated Jev
measurement, with no increase in independent sample size. FTS found five
helpful entries in 21 slots; Jev found one. The paired P@3 difference is
**−19.05 percentage points**, with an exploratory 95% prompt-bootstrap
interval of **[−38.10, −4.76] points**. Quality and minimum coverage both fail.
These intervals do not establish a population-wide ranking from seven
selected requests. Keep on-demand search; this evidence does not justify
sending every prompt for selection.

New provider spend was **USD 0.000543102**. Cumulative pilot plus rerun spend
was **USD 0.001101618**, including the single original reachability probe.

## Unchanged protocol and labelling rule

The hypothesis is that one Jev decision over a prompt and up to eight memory
summaries can select at most three useful additions more precisely than FTS
rank alone. No injection selects zero. The source of labels is the request
and the bounded indexed memory body; no downstream agent response is used.

The [labelled set](memory-selection.labels.json) contains paraphrases only,
with one binary decision and rationale for every candidate. The rule is
written in that file. A specific source pointer can help; broad topic overlap,
redundant instructions, unsupported environment assumptions and superseded
policies do not. Borderline cases count as false. This study estimates
potential relevance; task-completion improvement remains unmeasured.

Primary metric: helpful selections / (three slots × number of prompts),
including empty slots. Also report helpful / offered (undefined for no
injection), candidate recall and prompt coverage. This prevents an abstaining
decider from winning by returning one easy item. Jev's threshold is 0.70,
fixed before scores, with FTS order breaking ties. No threshold sweep.

Operationalize the design's “margin worth the outbound text” conservatively:
at least 10 percentage points better P@3 than the identical-candidate FTS arm,
at least 15 points better precision among offered items, no lower candidate
recall, and p99 end-to-end latency within 1.5 seconds. A promotion also needs
at least 30 independent requests including five for each receiving engine;
otherwise even a positive pilot remains no-go pending a representative test.
These numerical thresholds are this study's predeclared choices; the design
does not specify numerical thresholds.

## Rerun sampling and exclusions

Collection: **2026-10-02 17:32:32 UTC**. The runner opens the installation's
transcript and Phase 1 memory indexes read-only in SQLite read transactions.
It reads all indexed user messages from Claude and Codex; it never refreshes
an index or scans additional transcript files. It skips launch instruction,
environment and plugin preambles, then considers exactly the first request
per transcript. An excluded first request never promotes a later message.
Transport envelopes are stripped; exact prompt copies are folded.

The collector now requests 100 by default. Within each engine/project
stratum it sorts by SHA-256 of `memory-selection-v1` plus the prompt. It
round-robins projects within each engine, then engines, without replacement;
exhausted strata yield unused slots to the rest. Exact-copy provenance is
chosen deterministically by message index then transcript path. This is
balanced coverage sampling, with no claim of proportional population
weighting. With only seven eligible requests, all were retained.

| Collection count | Number |
| --- | ---: |
| Indexed user messages examined | 4,459 |
| Transcripts with a first non-preamble request | 1,049 |
| Explicit pipeline/role boilerplate, ticks, test requests and relays excluded | 1,035 |
| Context-only continuation requests excluded | 5 |
| Requests needing an unavailable image excluded | 1 |
| Exact duplicate requests excluded | 1 |
| Short requests excluded | 0 |
| Requested sample | **100** |
| Eligible and sampled requests | **7** |
| Phase 1 memory entries | 7,673 |

The sample contains six Codex requests and one Claude request, spanning two
project keys (five and two requests), dated 2026-07-20 through 2026-10-02.
Four are detailed briefs; three are shorter direct requests. A user-role
brief does not prove human authorship. Explicit automation scaffolds are
excluded, including many genuine tasks relayed through pipelines. The
result is strongly selected. The remaining 93 requested observations are
unavailable under this rule; no fabricated, later-turn or duplicate prompts
were substituted. All seven requests and their candidates match the pilot
exactly, despite the larger indexed population. Case IDs changed with the
stratified ordering; pilot artifacts retain their original IDs.

### Two retrieval policies, kept separate

**Literal Phase 1 query:** the first 16 alphanumeric/underscore terms, joined
by AND, with the Phase 1 BM25 weights `(0, 5, 2, 1)`. After the experiment's
scope/native filters it returned **zero candidates for all seven retained prompts**.
Directly passing complete natural-language prompts into this API is therefore
not a useful candidate generator in this rerun. An agent-written short
`search_memory` query can behave differently; this result does not evaluate
that interactive use.

**Exploratory recall query:** the first 16 distinct terms of length at least
four after a fixed English/Ukrainian/Russian stop list, joined by OR. It uses
the same Phase 1 FTS tables, BM25 weights and date/id tie breaks. This query
exists only in the replay runner. The production `search_memory` semantics
are unchanged. This policy supplies candidates to **both** the FTS and Jev
arms in the table below; the table makes no comparison between OR and AND.

For both policies, retain the conversation's project plus global entries,
exclude the receiving engine's entries and all `instruction` entries, fetch
up to 80 ranked hits, collapse identical titles and Claude index/topic pairs
by referenced filename, then retain eight. No conversation has a previous
offer because these are first requests. Historical native prompt contents
are unavailable, so excluding instruction entries is a conservative proxy
for instruction deduplication; shared skills may already be discoverable
through a native skill catalog. Explicitly requested skill pointers receive
negative labels for redundancy.

The recall policy yielded **51 candidates**: 36 project-scoped and 15 global;
16 references, 14 preferences, six project facts and 15 skills. The kinds
describe Phase 1 records; global skills are the cross-project contribution.
No candidate from another project's private scope is admitted.

These are current-index counterfactuals: 27 of 51 entries have recorded write
dates later than the request. Imported file timestamps may also differ from
when a fact originated. The study does **not** claim these memories were
available when the historical request first ran. It asks whether the current
index would offer useful additions if that request were replayed now.

### Deciders

- **FTS:** choose the first three entries in the frozen candidate list.
- **Jev:** one `typesafe/jev-1.13` request per prompt to the endpoint exported
  by `src/lib/asks/jev.ts`. The existing `classifierText` and
  `redactForClassifier` redact/bound the prompt and summaries. No memory body,
  source path field, labels or subsequent conversation is sent. Each candidate
  gets one `noul` statement asking whether it supplies a specific fact, rule
  or reference that changes the task beyond information already in the prompt.
  Keep scores at least 0.70, highest first, at most three. No retry or tuning.
- **No injection:** return no entries without a retrieval or provider call.

The pilot labeler read every request and bounded candidate body before scoring.
The rerun verified exact equality of all seven prompts and all 51 candidate
records against the private pilot sample, then reused those frozen labels
with the new stratified IDs. No label changed after inspecting pilot or rerun
scores. The six positive labels are `p04/c1`, `p04/c3`, `p05/c1`,
`p07/c1`, `p07/c2`, `p07/c8`.
[`memory-selection.results.json`](memory-selection.results.json) records
all numeric scores, costs, selections and timings without private text.

## Rerun results and uncertainty

| Decider, identical OR candidates | Offered | Helpful | P@3 | 95% interval | Helpful / offered | Candidate recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| FTS rank | 21 | 5 | **23.81%** | **[4.76%, 47.62%]** | 23.81% | 83.33% |
| Jev, threshold 0.70 | 7 | 1 | **4.76%** | **[0%, 14.29%]** | 14.29% | 16.67% |
| No injection | 0 | 0 | **0%** | **[0%, 0%]** | undefined | 0% |

Jev minus FTS: **−19.05 percentage points**, 95% interval
**[−38.10, −4.76] points**. FTS wins on three requests; four tie.
Jev's precision among offered entries is 9.52 points lower. Prompt coverage
is 100%, 71.43% and 0% for FTS, Jev and no injection respectively.

Intervals use 20,000 percentile bootstrap draws, xorshift32 seed 2475,
resampling seven prompt clusters with replacement. All three slots travel
with their prompt, and identical resampled indices are used for both arms
in the paired contrast. Endpoints are the nearest-rank 2.5th and 97.5th
percentiles. No injection has a structurally zero P@3 under this definition;
its [0, 0] interval says nothing about downstream task success. These are
approximate, conditional intervals: seven selected prompts, one labeler,
shared candidate memories and only one Claude request severely limit their
interpretation. They exclude labelling uncertainty, corpus selection bias
and provider variation. The rerun is not pooled with the pilot as 14
independent prompts. Bootstrap inference on this tiny corpus is exploratory.

| Decider | Median latency | p99 latency |
| --- | ---: | ---: |
| FTS retrieval and frozen-rank choice | 4.26 ms | 12.64 ms |
| Jev, same retrieval + decision request | 244.98 ms | 429.50 ms |
| No-injection empty-return measurement | <0.001 ms | <0.001 ms |

Retrieval is measured once at collection and reused by both ranking arms.
Jev adds HTTP round-trip and response parsing; small local serialization
and sorting overhead is outside these timers. No injection measures a local
empty return, without retrieval, hooks or process startup. Nearest-rank p99
is the maximum of seven observations. These are warm-process observations.

### Seven-prompt pilot, retained separately

The original collection at 16:52:16 UTC examined 4,349 user messages from
1,017 first-request transcripts: 1,003 machine requests, five continuations,
one attachment and one duplicate were excluded. It retained the same seven
requests and 51 candidates. Original
[pilot labels](memory-selection.pilot.labels.json) and
[pilot receipts/results](memory-selection.pilot.results.json) are preserved
unchanged. Pilot latency median/p99 was 2.32/5.68 ms for FTS and
267.75/456.26 ms for Jev; no injection was below 0.001 ms.

| Pilot arm | Offered | Helpful | P@3 | Helpful / offered | Candidate recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| FTS | 21 | 5 | 23.81% | 23.81% | 83.33% |
| Jev | 8 | 2 | 9.52% | 25.00% | 33.33% |
| No injection | 0 | 0 | 0% | undefined | 0% |

The pilot's paired difference was −14.29 points. Its no-go was a pilot
conclusion. The new call set selected one fewer helpful entry and remains
below both quality margins. Both runs used the same model, threshold,
question wording and labels. We did not tune to the rerun.

### Errors illustrated with scrubbed paraphrases

A workbook task needed a provenance trail and a pointer to newer workbooks;
FTS found both and Jev selected neither. A prompt already named its SQL
access skill, making the retrieved skill pointer redundant. Another prompt
explicitly authorized an account, superseding the older account prohibition
that Jev selected. A launcher investigation retrieved a restart warning for
a different host without evidence that its topology applied. These examples
illustrate incremental usefulness and applicability, not merely topic match.

## Spend, receipts and safety

| Measurement | Input tokens from provider | Sum of `usage.cost`, USD |
| --- | ---: | ---: |
| Original reachability probe, made once | 367 | 0.000015414 |
| Seven pilot decisions | 12,931 | 0.000543102 |
| Seven new rerun decisions | 12,931 | 0.000543102 |
| **Cumulative: 15 actual HTTP calls** | **26,229** | **0.001101618** |

The rerun ledger reuses the original probe receipt; it does not send another
probe. Its reported total is **0.000558516 USD**, including that reused
receipt. Summing the two run totals would count the probe twice. Costs above
come directly from Jev's `usage.cost` and `usage.input_tokens`, with no
estimated token conversion or separate billing audit. All seven new requests
completed; there are no unsettled reservations. FTS and no injection cost
zero provider dollars.

Each runner ledger is hard-capped at **USD 2.00** including its probe receipt.
A single-writer lock spans the run. Before each sequential request the runner
durably reserves the greater of USD 0.01 and the serialized request's UTF-8
byte count plus 4,096 overhead tokens at the existing client's pinned price.
This is a conservative bound under that price contract, not an account-wide
provider quota. Success settles to actual usage cost; an ambiguous failure
retains its reservation and blocks replay. An over-bound receipt blocks
subsequent calls, including after restart. Completed ledgers reuse scores;
changed samples or labels are refused. A new ledger is a separate budget;
the cumulative actual spend across these two ledgers is also below USD 2.

The authorized secret was loaded into `OPENROUTER_API_KEY` only for the runner
process and never printed or committed. The runner requires that environment
variable before calling the existing helper, preventing its secret-file
fallback. Nothing was injected into live prompts, written to engine memory,
or changed in installed Jev settings. Existing redaction bounds outbound
prompts and summaries; it is not a general anonymizer of names. Bounded
outbound selection was explicitly authorized. Public artifacts contain
aggregates, opaque local case IDs and scrubbed paraphrases only; private
samples, bodies, provenance and ledger input hashes remain outside the repo.

## Reproduction and verification

```sh
LLV_STATE_DIR="$(mktemp -d)" bun test scripts/memory-selection.test.ts
bun scripts/memory-selection.ts collect "$TRANSCRIPT_DB" "$MEMORY_DB" "$PRIVATE_SAMPLE"
bun scripts/memory-selection.ts local "$PRIVATE_SAMPLE" "$LABELS" "$LOCAL_RESULTS"
bun scripts/memory-selection.ts jev "$PRIVATE_SAMPLE" "$LABELS" "$PAID_RESULTS" "$PRIVATE_LEDGER" "$EXISTING_PROBE"
```

Set an isolated `LLV_STATE_DIR` for every command. The default collection
limit is 100. Label the resulting sample before paid scoring. Paid commands
require the authorized key in their process environment. Output files are
exclusive-create; do not repeat the completed probe or create a fresh paid
ledger just to export results. Retained private `sample.json`, `labels.json`,
`ledger.json` and `results.json` bind this rerun; the pilot has separate
retained private artifacts. Public JSON lets reviewers recompute selections,
metrics, confidence intervals and spend, while the private index and raw
prompts are intentionally not published. Replaying paraphrases would be a
different experiment.

Exact-path tests cover 100-case stratification and validation, exclusions,
read-only collection, paired intervals, both public artifact sets and budget
failure/restart behavior. The remaining evidence gap is coverage: the current
index cannot supply the requested 100 usable first prompts. Neither the
pilot nor this repeat can authorize Phase 3; broader independent requests
and independently adjudicated labels are still needed.
