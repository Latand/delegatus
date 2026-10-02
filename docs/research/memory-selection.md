# Memory selection: Jev does not beat FTS in the first-request pilot

Study date: 2026-10-02. This is the board task **Shared memory phase 2:
does Jev pick useful memories better than search**, implementing
[Phase 2 of the design](../design/agent-memory.md#6-phased-plan).
Built on the merged read-only index, PR #2417, at base `5b046f54c`.
The design stays unchanged.

**No-go for Phase 3.** With the same candidates, FTS found five useful entries
in 21 slots; Jev found two. Jev's P@3 was 9.52%, against FTS's 23.81%.
Total observed spend was **USD 0.000558516**, including the reachability
probe. The sample is too small for a population estimate, and it also fails
the study's minimum coverage criterion. Keep on-demand memory search; this
measurement gives no reason to send every prompt out for selection.

## Protocol frozen before Jev scores

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

## Observation and method

The initial credential observation failed before this continuation, with no
request sent. The operator subsequently supplied a secret-file location and
authorized reading it into `OPENROUTER_API_KEY` for the runner process only.
One call through the existing `classifyWithJev` and `readOpenRouterApiKey`
confirmed the decisions endpoint was reachable: 367 input tokens,
`usage.cost = 0.000015414`, 416.42 ms. The key never enters an artifact or log.

[`scripts/memory-selection.ts`](../../scripts/memory-selection.ts) opens the
transcript and Phase 1 memory SQLite indexes read-only, with read transactions
for stable snapshots. It does no refresh, migration, offer-ledger write or
engine-store write. Collection happened at 2026-10-02 16:52:16 UTC.

The collector takes the first user request per indexed transcript, after
skipping launch instruction/environment/plugin-list preambles. If that first
request is excluded, a later message cannot take its place. It strips the
transport envelope, folds exact prompt copies, sorts by SHA-256 of a fixed
seed plus prompt, and takes at most 32. It retains private provenance with
transcript location, message index, timestamp and original memory ids.

| Collection count | Number |
| --- | ---: |
| Indexed user messages examined | 4,349 |
| Transcripts with a first non-preamble request | 1,017 |
| Explicit pipeline/role boilerplate, ticks, test requests and relays excluded | 1,003 |
| Context-only continuation requests excluded | 5 |
| Requests needing an unavailable image excluded | 1 |
| Exact duplicate requests excluded | 1 |
| Eligible and sampled requests | **7** |
| Entries in the Phase 1 memory snapshot | 7,673 |

The seven requests span 2026-07-20 through 2026-10-02, two project keys, six
Codex recipients and one Claude recipient. Four are detailed work briefs;
three are shorter direct requests. Authorship of a work brief cannot be
inferred reliably from its user role. The heuristic excludes explicit
automation scaffolds; it cannot certify that all retained prose was typed
directly by a person. It also excludes many genuine tasks delivered inside
pipeline scaffolds. This is a strongly selected pilot, not a representative
sample of the operator's work. No extra transcripts were sought to improve
the score after labels were set.

### Two retrieval policies, kept separate

**Literal Phase 1 query:** the first 16 alphanumeric/underscore terms, joined
by AND, with the Phase 1 BM25 weights `(0, 5, 2, 1)`. After the experiment's
scope/native filters it returned **zero candidates for all seven prompts**.
Directly passing complete natural-language prompts into this API is therefore
not a useful candidate generator in this pilot. An agent-written short
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

The labeler read each request and candidate's bounded body, wrote all 51
labels and the rule, then ran the arms. The six positive labels are
`p02/c1`, `p02/c3`, `p04/c1`, `p04/c2`, `p04/c8`, `p06/c1`.
[`memory-selection.results.json`](memory-selection.results.json) records
all numeric scores, costs, selections and timings without private text.

## Results

| Decider, identical OR candidates | Offered | Useful | P@3 | Useful / offered | Candidate recall | Prompt coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| FTS rank | 21 | 5 | **23.81%** | 23.81% | **83.33%** | 100% |
| Jev, threshold 0.70 | 8 | 2 | 9.52% | 25.00% | 33.33% | 71.43% |
| No injection | 0 | 0 | 0% | undefined | 0% | 0% |

Jev loses **14.29 percentage points of P@3**. Its precision among offered
entries improves by only 1.19 points, while it misses four of six positives.
Two prompts favor FTS by two and one positives respectively; five tie in
the number of useful selections. There is no statistical superiority
claim from seven clustered requests. Every candidate is annotated; recall
here says nothing about relevant entries that retrieval never surfaced.

| Decider | Median latency | p99 latency |
| --- | ---: | ---: |
| FTS retrieval and frozen-rank choice | 2.32 ms | 5.68 ms |
| Jev, same retrieval + decision request | 267.75 ms | 456.26 ms |
| No-injection empty-return measurement | <0.001 ms | <0.001 ms |

Retrieval timings were captured once at collection and reused for both
ranking arms. Jev adds measured HTTP round-trip/body parsing time; tiny local
sorting/serialization overhead is outside those timers. No-injection timing
is a local empty-return operation, with no hook or process startup. The p99
uses nearest rank and equals the maximum at this sample size. These are warm
process measurements, not a production-hook latency guarantee.

### Confusions, paraphrased

- A data-research request explicitly names a SQL access skill. Jev selects
  that redundant pointer (0.77). The label asks for incremental usefulness.
- A request for parking sale prices retrieves maintenance-tariff memories.
  Jev chooses generic advice to search older conversations (0.78), while the
  needed sales-data entry never enters the candidate list. Candidate recall
  is a separate problem from final selection.
- A workbook analysis needs a provenance trail and a pointer to newer
  half-year workbooks. FTS selects both. Jev scores them 0.46 and 0.67,
  below the fixed threshold.
- A current request explicitly authorizes an account. Jev selects an older
  prohibition (0.91) and old model guidance (0.87). Current instructions
  supersede these notes; neither was injected into a live prompt.
- A launcher update investigation retrieves another host's restart warning
  (0.79) and a container-bootstrap recipe (0.71). Both lack an established
  environment match. All technical statements in those notes remain
  hypotheses requiring current verification.
- For an orchestrator briefing, Jev correctly moves an external-audience
  warning from rank eight into its two choices (0.71), the one positive FTS
  misses. That isolated gain does not offset the other misses.

## Spend and safety

| Calls | Input tokens from provider | Sum of `usage.cost`, USD |
| --- | ---: | ---: |
| One reachability probe through the existing client | 367 | 0.000015414 |
| Seven memory-selection decisions | 12,931 | 0.000543102 |
| **Total: eight successful requests** | **13,298** | **0.000558516** |

These costs are response fields, not estimates or a separate account billing
audit. Every reported cost matches the pinned USD 0.042/million input-token
rate. There were no failed or ambiguous paid requests and no unresolved
reservations. FTS and no-injection made no paid calls.

The runner hard-caps the research ledger at USD 2.00 including the probe. A
single-writer lock covers the run. Before every request it durably reserves
the greater of USD 0.01 and the full serialized request's UTF-8 byte count
plus 4,096 overhead tokens at the existing client's pinned model price. This
conservative token bound assumes that price contract, the same assumption
as the live client's ceiling. It is not a provider-side account quota.
Requests are sequential; any reservation that would cross USD 2 is refused
before fetch. Success settles to `usage.cost`; errors keep the reservation
and block replay until reconciled. A receipt over its bound stops the run.
Restarting a completed ledger reuses scores and makes no further calls;
changed sample or labels are refused. A crash-held lock requires manual
inspection rather than automatic takeover. Reuse this ledger for this study;
creating another ledger starts a separate budget.

Nothing was injected into a live prompt. No engine memory, installed Jev
switch or runtime setting changed. The published examples are manually
paraphrased; raw prompts, indexed bodies, source paths and credentials stay
outside the repository. Existing Jev redaction is applied before outbound
selection, but it is not a general anonymizer of person or host names. The
operator explicitly authorized that bounded outbound selection text.

## Reproduction

Run the exact test file in an isolated state directory:

```sh
LLV_STATE_DIR="$(mktemp -d)" bun test scripts/memory-selection.test.ts
```

The collector accepts explicit index paths and writes a new private sample.
The inputs are the installation's `transcript-search.sqlite` and
`memory-index.sqlite`. It never discovers credentials or live state itself:

```sh
bun scripts/memory-selection.ts collect "$TRANSCRIPT_DB" "$MEMORY_DB" "$PRIVATE_SAMPLE"
bun scripts/memory-selection.ts local "$PRIVATE_SAMPLE" docs/research/memory-selection.labels.json "$LOCAL_RESULTS"
bun scripts/memory-selection.ts probe "$PRIVATE_PROBE"
bun scripts/memory-selection.ts jev "$PRIVATE_SAMPLE" docs/research/memory-selection.labels.json "$PAID_RESULTS" "$PRIVATE_LEDGER" "$PRIVATE_PROBE"
```

Use an isolated `LLV_STATE_DIR` for every command. The paid commands require
`OPENROUTER_API_KEY` already in their process environment, checked before
calling `readOpenRouterApiKey`, so an absent variable never falls back to a
secret file. The operator's wrapper reads the authorized file without
printing it. Do not run the probe again for this completed study. Output
files are exclusive-create; use a fresh output path to re-export the same
ledger. A new collection must be relabelled and is a new experiment.

The private study directory retains `sample-final.json`, `probe.json` and
`ledger.json`. Public readers can audit every label, selected id, score and
cost in the two JSON artifacts. The fixture-integrity test recomputes the
reported metrics from them. They cannot reproduce the private FTS corpus or
claim that sending the paraphrases to Jev reproduces the original requests.

## Decision and next evidence

**No-go:** the measured decider fails both quality margins and loses recall.
Latency and price pass, but they do not justify outbound text when selection
quality fails. Sample coverage independently fails (7 requests; one Claude
recipient), so a future positive score on this set could not authorize
Phase 3 either.

The useful next experiment would separate candidate recall from decision
quality, gather more direct first requests across both engines, record the
native context already supplied, and independently adjudicate labels. It
should include contradictory and outdated memories deliberately. This work
adds no automatic injection, retirement, deletion, or alternate classifier.
