# Memory selection: grounded Jev improves filtering; automatic injection remains unvalidated

Study date: 2026-10-02. Successor to the seven-first-request pilot on PR #2475. The final comparison uses **100 operator messages across all indexed projects**, with full preceding context retained privately and identical candidate labels for every arm. The corrected frozen population contains **588 eligible events**, so the full requested sample is available.

**Request design changes the conclusion:** grounded Jev reaches 37.5% precision / 30% recall at 0.50, compared with original Jev’s 6.15% / 80% and FTS score 10’s 1.84% / 30%. Grounded at 0.70 retains one useful memory with no observed false offers. This supports further work on the grounded request; it cannot establish reliable automatic injection from one offer. Graph gating loses that useful offer. Total spend, including all earlier experiments, is **$0.194018286 of the $2.00 cap**.

## Population, authorship and sampling

The runner reads the transcript and Phase 1 SQLite indexes in read-only transactions. It considers every indexed user message at every position, in every project, for Claude and Codex. Native source lines and Claude delivery receipts identify agent-origin, system and meta messages. Explicit operator provenance takes precedence over topic or tool-name heuristics. Native queued-human provenance also takes precedence over a generic metadata flag; authenticated agent delivery remains excluded. Exact machine control envelopes still exclude seat ticks, pipeline scaffolds, recovery notices and relays. Historical records without provenance use the written legacy-template rule in `machineMessage`, followed by full-body matching against earlier agent send calls. The latter reads indexed transcript prefixes and statically extracts literal `send_message`, `send_message_to_orchestrator`, and the legacy Python JSON POST to `/api/tmux`; it never executes logged code. Explicit operator provenance takes precedence over this matching too. Residual user-role text is included. This operational classification has uncertainty because older transcripts lack uniform authorship metadata, dynamic send expressions are not reconstructed, and unmarked human reuse of an earlier sent body can remain ambiguous.

Transport markers, image-path wrappers and voice bridge digests are removed while preserving the operator's actual text after a digest. Short replies, continuations, attachments and operator-supplied logs remain eligible. Image-description companion records, tool results and system/hook text are excluded. Native event copies are folded by native event ID, or engine/precise-native-timestamp/body identity when there is no ID; records without either retain their source-position identity; separately written repeated replies remain eligible. No first-turn filter, minimum length or project whitelist is used.

The corrected frozen snapshot contains **4,497 user records, 1,467 conversations, 3,891 excluded machine records, 18 copied events and 588 eligible operator events**. It contains 7,675 memory entries. The requested population is large enough to sample 100. Five of seven project keys contain operator input; all seven are accounted for below. Project aliases follow sorted index keys; private paths and identities are withheld.

| Project | Engine | Indexed | Operator | Sample |
| --- | --- | --- | --- | --- |
| project-1 | claude | 23 | 12 | 12 |
| project-1 | codex | 2 | 0 | 0 |
| project-2 | claude | 1 | 0 | 0 |
| project-3 | claude | 16 | 6 | 6 |
| project-3 | codex | 37 | 0 | 0 |
| project-4 | claude | 655 | 153 | 20 |
| project-4 | codex | 1705 | 302 | 20 |
| project-5 | claude | 415 | 74 | 20 |
| project-5 | codex | 1427 | 0 | 0 |
| project-6 | claude | 165 | 39 | 20 |
| project-6 | codex | 44 | 2 | 2 |
| project-7 | claude | 3 | 0 | 0 |
| project-7 | codex | 4 | 0 | 0 |

Sampling round-robins sorted project × engine strata without replacement, redistributing unused slots when small strata exhaust. Within each stratum, SHA-256 of seed `memory-selection-v1`, transcript identity and message index fixes the order. This balances project coverage rather than estimating population-weighted traffic. The sample has **78 Claude and 22 Codex messages from 30 conversations**. Each private case stores the current message and all preceding indexed turns in chronological order, never subsequent turns. Mean preceding history is 89.54 turns.

The first all-turn collection had 548 eligible events. Review found that broad prose heuristics could reject genuine operator messages and that a voice digest could hide an operator suffix. Those rules were corrected before the comparison below. All arms were rerun on the same final 100 cases; earlier calls count toward the shared dollar cap. Ninety-three case labels were retained by exact source identity and identical candidate IDs/content. Seven replacements were adjudicated before this run. The intermediate all-turn metrics are superseded. A final native queued-human regression fix changed no sampled input: a read-only audit found no such envelopes in this index.

The sender-provenance correction audits the frozen 595-event population. It excludes six confirmed agent relays, including the four reported by review; four mirrored occurrences of those relays move from copied events to machine records. Reapplying the existing native-ID deduplication also folds one previously retained copy: the two records share a native message ID despite different timestamps. Thus eligible events fall by seven, machine records rise by ten, and copied events fall by three. All affected events belong to project-4. Regenerating the seeded sample from the corrected population preserves all 100 source identities in order, prompts, context, candidates and labels. Scoring was not rerun; the original immutable receipts still reproduce every selection, interval and cost below. The live index has since grown, so a fresh live collection is a separate population, not a replacement for this frozen experiment.

## Candidates and labels

Each case receives the top 30 surviving FTS hits from its project plus global entries. Entries written by the receiving engine are removed, as are near-native matches against that engine's whole indexed store: token-set Jaccard at least 0.80 on title-plus-summary or body, requiring at least five tokens. Whole instruction entries already in launch context remain excluded, as in the pilot. Repeated Claude index pointers to the same file are folded.

The recall query takes the current message and prior turns newest-first, extracts the first 16 distinct non-stopword terms of at least four characters, and ORs them. Phase 1 BM25 weights are `(0, 5, 2, 1)`; the threshold score is negative BM25, with larger values ranking higher. This is an uncalibrated retrieval score. The contemporary index is not reconstructed as of each historical prompt, so historical availability remains a limitation.

Three model reviewers labelled disjoint case sets using the current request, offered title/summary, relevant preceding exchanges and candidate bodies. One reviewer adjudicated replacements; there is no inter-rater agreement estimate. They did not claim exhaustive reading of every long history or irrelevant skill body. **Helpful** means the offered title and summary supply a specific applicable fact, rule or reference that would change the next response/action beyond what the current request and history already provide. Topic overlap, wrong environment, already-known or superseded information, unsupported assumptions and borderline cases are false. A useful fact only in the unoffered body does not qualify. There are **10 helpful labels among 1,368 candidates**. The [labels](memory-selection.all-turns.labels.json) publish scrubbed paraphrases only.

## How the Jev request is built

The implementation follows the existing [attention classifier study](attention-classifier.md), `src/lib/asks/jev.ts`, and the [Jev endpoint contract](https://docs.typesafe.ai/api). The OpenRouter route accepts `model`, `state`, and `questions`, with `noul` probabilities plus usage fields in the response. Question-map IDs are routing keys, not semantic instructions; the [OpenRouter explanation](https://openrouter.ai/blog/insights/what-is-jev/) warns that IDs are not sent to the underlying model. All four requests use `typesafe/jev-1.13` through the same decisions endpoint.

| Arm | State and question construction |
| --- | --- |
| original | The pilot request: current prompt only, up to 4,000 characters using the existing head/tail classifier clipping; a state list of IDs, 160-character titles and 400-character summaries; each question says “Memory cN” and applies the original generic usefulness statement. |
| context-id | The first all-turn revision: current prompt up to 8,000 characters, trailing 16,000-character role-labelled history, and the same ID/title/summary list. The statement asks for an increment beyond the preceding conversation. |
| framed | Explicit next-response task, project alias, receiving engine, current message, opening user request up to 2,000 characters, and trailing role-labelled history. Each question directly embeds the full offered title and summary, a concrete incremental-usefulness statement, and true/false criteria. There is no shared list to search by ID. |
| grounded | The framed request plus the first 2,000 characters of that memory's redacted body and three synthetic positive/negative examples. The body disambiguates applicability; an explicit rule rejects value found only in the body. Examples distinguish an unstated parser rule, a repeated plan constraint and an unrelated deployment environment. |

The examples were written without tuning to case labels or returned scores; they are rubric examples, not probability calibration. Project aliases distinguish scope without giving Jev a semantic project description; task meaning comes from the current request, opening request and recent turns. 90 histories are truncated explicitly; the full prefix remains private for review. Credential-shaped lines and values are redacted before every call. The [provider contract](https://docs.typesafe.ai/models) allows 64K tokens across a request and 32K for state plus the longest question. All 344 requests were accepted; the largest reported aggregate input was 35,403 tokens. These variants jointly change multiple request features, so a performance difference cannot isolate the causal contribution of one field.

**Grounded is the strongest observed request for filtering, with a substantial recall tradeoff.** At the shared 0.50 threshold, original gives 6.15% precision / 80% recall, context-id 3.23% / 60%, framed 33.33% / 10%, and grounded **37.50% / 30%**. Putting the actual offer inside its question and defining the immediate decision suppresses many irrelevant offers; adding body evidence/examples recovers three useful offers versus framed’s one. This interpretation is consistent with the design, but the bundled changes do not prove which component caused it. Simply appending conversation context to the ID-list request made the measured result worse.

At the provisional filtering threshold **0.70**, original offers 28 entries (3 useful), context-id 29 (1 useful), framed none, and grounded **one entry, useful**. Grounded is therefore the candidate to investigate further. Its one-offer bootstrap precision interval degenerates to [100%, 100%] because resamples with no offer have undefined precision and are omitted. This is not a population guarantee: even an independent-trial exact binomial interval for one success out of one would be [2.5%, 100%]. At 0.90 every Jev variant abstains. The data do not justify a claim that Jev inherently loses to FTS.

## Graph and combined selection

The graph arm reranks the same top-30 eligible pool. It seeds the five highest FTS hits and considers undirected one-hop neighbours. A resolved `[[name]]` or Markdown memory-file link has weight 1. Codex keywords appended by the Phase 1 parser give a Jaccard edge when at least two keywords overlap within project scope. Shared project/kind gives a weak 0.05 edge. The parser already maps Codex cwd to project; the graph uses that scoped pool rather than treating unrelated cwd values as equivalent.

For each node, score = 0.5 × normalized FTS + 0.5 × strongest seed-weighted neighbouring edge. This score is heuristic, not a probability. Across the 100 induced graphs there are 204 resolved link edges, 0 keyword edges and 1957 weak project/kind edges, counting a repeated edge again in each case. This tests reranking, not expansion beyond the labelled pool; it cannot measure graph recovery of relevant memories missed by FTS.

The **graph-grounded** combined arm requires graph score ≥0.50, then applies the grounded Jev probability threshold and ranks survivors by that probability. It reuses the exact grounded scores for paired comparison. No extra calls are charged; latency and hypothetical serving cost conservatively include the full grounded request. A reduced-candidate API request was not measured.

## Confidence target and budget

The prespecified target is **90% precision**, a **95% lower bound of at least 80%**, and **at least 20 offers**. Automatic context should rarely introduce irrelevant instructions, and a single lucky hit is insufficient evidence. Among qualifying thresholds choose greatest recall, then the lower threshold. **No arm qualifies. Automatic injection remains disabled.**

Every arm sorts eligible candidates by its score and offers at most **15 entries and 10,000 characters**. Confidence determines the count; there is no minimum. An oversized entry is skipped so smaller later entries can fit. The offer is exactly `title + newline + summary + newline`, including separators. Characters use JavaScript UTF-16 units. FTS thresholds are 0, 2, 5, 10, 15, 20 and 30; Jev thresholds are 0, .50, .70, .80, .90, .95 and .99; graph thresholds are 0, .25, .50, .70 and .90. No injection offers nothing.

## Results with 95% intervals

Precision counts useful selections divided by all offers. Recall counts useful selections divided by the ten useful candidates in the retrieved pools, not by all useful memories in the index. Empty-offer precision is undefined. Means include all 100 cases. Brackets are 95% intervals; precision and recall are percentages.

| Arm | Threshold | Offers | Precision % [95%] | Recall % [95%] | Mean entries [95%] | Mean characters [95%] |
| --- | --- | --- | --- | --- | --- | --- |
| fts | 0 | 818 | 0.61 [0.11, 1.43] | 50.00 [14.29, 100.00] | 8.18 [6.62, 10.53] | 1736.67 [1430.74, 2212.50] |
| fts | 2 | 778 | 0.64 [0.11, 1.51] | 50.00 [14.29, 100.00] | 7.78 [6.25, 10.06] | 1641.91 [1342.19, 2092.47] |
| fts | 5 | 487 | 0.62 [0.00, 1.80] | 30.00 [0.00, 62.50] | 4.87 [3.63, 6.78] | 1059.24 [810.89, 1438.89] |
| fts | 10 | 163 | 1.84 [0.00, 5.51] | 30.00 [0.00, 62.50] | 1.63 [0.86, 2.91] | 346.54 [192.23, 606.67] |
| fts | 15 | 22 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.22 [0.08, 0.44] | 47.86 [17.51, 95.77] |
| fts | 20 | 6 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.06 [0.01, 0.14] | 12.75 [2.62, 28.95] |
| fts | 30 | 1 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.01 [0.00, 0.04] | 3.56 [0.00, 12.95] |
| none | 0 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| original | 0 | 818 | 1.22 [0.37, 2.30] | 100.00 [100.00, 100.00] | 8.18 [6.62, 10.53] | 1797.31 [1462.87, 2303.41] |
| original | 0.5 | 130 | 6.15 [1.64, 12.09] | 80.00 [50.00, 100.00] | 1.30 [0.81, 2.07] | 284.53 [172.07, 460.86] |
| original | 0.7 | 28 | 10.71 [0.00, 25.93] | 30.00 [0.00, 60.00] | 0.28 [0.14, 0.49] | 65.78 [27.58, 119.96] |
| original | 0.8 | 5 | 20.00 [0.00, 66.67] | 10.00 [0.00, 33.33] | 0.05 [0.02, 0.08] | 11.59 [4.26, 18.35] |
| original | 0.9 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| original | 0.95 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| original | 0.99 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| context-id | 0 | 818 | 1.22 [0.37, 2.30] | 100.00 [100.00, 100.00] | 8.18 [6.62, 10.53] | 1815.41 [1495.78, 2304.78] |
| context-id | 0.5 | 186 | 3.23 [0.52, 7.30] | 60.00 [18.18, 100.00] | 1.86 [1.21, 2.93] | 401.61 [252.14, 636.95] |
| context-id | 0.7 | 29 | 3.45 [0.00, 11.43] | 10.00 [0.00, 42.86] | 0.29 [0.16, 0.51] | 55.36 [29.25, 98.51] |
| context-id | 0.8 | 5 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.05 [0.00, 0.12] | 8.70 [0.00, 20.19] |
| context-id | 0.9 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| context-id | 0.95 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| context-id | 0.99 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| framed | 0 | 818 | 1.10 [0.34, 2.14] | 90.00 [66.67, 100.00] | 8.18 [6.62, 10.53] | 1724.54 [1424.11, 2185.25] |
| framed | 0.5 | 3 | 33.33 [0.00, 50.00] | 10.00 [0.00, 40.00] | 0.03 [0.00, 0.10] | 5.30 [0.00, 16.06] |
| framed | 0.7 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| framed | 0.8 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| framed | 0.9 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| framed | 0.95 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| framed | 0.99 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| grounded | 0 | 818 | 1.22 [0.37, 2.30] | 100.00 [100.00, 100.00] | 8.18 [6.62, 10.53] | 1719.95 [1417.19, 2191.15] |
| grounded | 0.5 | 8 | 37.50 [0.00, 66.67] | 30.00 [0.00, 80.00] | 0.08 [0.03, 0.14] | 15.89 [4.69, 27.33] |
| grounded | 0.7 | 1 | 100.00 [100.00, 100.00] | 10.00 [0.00, 33.33] | 0.01 [0.00, 0.02] | 2.75 [0.00, 6.71] |
| grounded | 0.8 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| grounded | 0.9 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| grounded | 0.95 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| grounded | 0.99 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| graph | 0 | 818 | 0.73 [0.20, 1.57] | 60.00 [30.00, 100.00] | 8.18 [6.62, 10.53] | 1729.73 [1426.29, 2202.63] |
| graph | 0.25 | 562 | 0.71 [0.00, 1.75] | 40.00 [0.00, 66.67] | 5.62 [4.63, 7.08] | 1227.11 [1033.86, 1513.83] |
| graph | 0.5 | 121 | 0.83 [0.00, 2.26] | 10.00 [0.00, 33.33] | 1.21 [1.00, 1.49] | 248.69 [204.07, 305.29] |
| graph | 0.7 | 31 | 3.23 [0.00, 16.67] | 10.00 [0.00, 33.33] | 0.31 [0.07, 0.63] | 62.58 [12.47, 132.11] |
| graph | 0.9 | 10 | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.10 [0.03, 0.17] | 18.92 [3.89, 32.45] |
| graph-grounded | 0 | 121 | 0.83 [0.00, 2.26] | 10.00 [0.00, 33.33] | 1.21 [1.00, 1.49] | 243.34 [203.97, 290.92] |
| graph-grounded | 0.5 | 2 | 50.00 [0.00, 100.00] | 10.00 [0.00, 33.33] | 0.02 [0.00, 0.05] | 4.11 [0.00, 9.48] |
| graph-grounded | 0.7 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| graph-grounded | 0.8 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| graph-grounded | 0.9 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| graph-grounded | 0.95 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |
| graph-grounded | 0.99 | 0 | undefined | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] | 0.00 [0.00, 0.00] |

Intervals use 2,000 percentile bootstrap draws of the 30 conversation clusters, xorshift32 seed 2475, with nearest-rank endpoints. All messages from one drawn conversation move together; paired contrasts use identical resampled indices. Undefined denominators are omitted and valid-draw counts are published. These conditional intervals exclude authorship/label error, retrieval bias, provider variation and threshold-selection optimism. They are not simultaneous bands. With only ten positives, the minimum-20-offer quality target cannot be demonstrated even by a perfect ranking; low measured precision supplies additional evidence against enabling the tested selectors.

There is no accepted operating threshold at which to claim superiority. At the predeclared reference pair (Jev 0.90, FTS 10), every Jev precision difference is undefined because no memories are offered; recall difference is −30 percentage points, 95% interval [−62.50, 0.00]. The table below instead compares each Jev arm’s **post-hoc best nonempty precision** with FTS 10 (1.84% precision, 30% recall). These exploratory choices are subject to selection optimism.

| Jev request | Threshold | Precision difference, pp | Paired 95% interval |
| --- | --- | --- | --- |
| original | 0.8 | +18.16 | [-4.95, +65.67] |
| context-id | 0.7 | +1.61 | [-5.17, +10.14] |
| framed | 0.5 | +31.49 | [-3.01, +49.35] |
| grounded | 0.7 | +98.16 | [+94.81, +100.00] |

Grounded’s +98.16-point estimate comes from its single surviving offer; only 1,306 of 2,000 resamples have defined paired precision. Its narrow conditional bootstrap interval does not establish generalization. The graph-grounded 0.50 arm offers two memories, one useful (50% precision / 10% recall); at 0.70 it offers none. Graph score ≥0.50 removes the useful memory grounded retained at 0.70. Graph evidence should therefore not be a mandatory gate in the next selector.

## Latency, spend and Codex context limit

| Arm | Median ms | p99 ms |
| --- | --- | --- |
| fts | 23.02 | 369.97 |
| original | 278.69 | 639.69 |
| context-id | 319.46 | 702.61 |
| framed | 318.49 | 691.77 |
| grounded | 350.21 | 864.21 |
| graph | 23.04 | 370.10 |
| graph-grounded | 350.23 | 864.31 |
| none | 0.00 | 0.00 |

Timers cover warm-process FTS retrieval/filtering, graph calculation where applicable, and Jev HTTP/parse. They omit process launch, selection/serialization and live-hook integration. Fourteen empty candidate pools make no API call per variant. p99 is nearest-rank observation 99/100. Arms run sequentially, so network-load effects are not controlled. A 30-second request timeout is an experimental safeguard, not a proposed live-hook timeout.

| Run | Calls | Input tokens | USD from usage |
| --- | --- | --- | --- |
| original | 86 | 207,192 | 0.008702064 |
| context-id | 86 | 858,226 | 0.036045492 |
| framed | 86 | 995,112 | 0.041794704 |
| grounded | 86 | 1,677,502 | 0.070455084 |
| Earlier experiments | carried once | 881,451 | 0.037020942 |
| Combined total | 344 | 4,619,483 | 0.194018286 |

All four Jev variants use one durable ledger under a **USD 2.00 cap**, including $0.037020942 carried from the pilots and superseded all-turn run. FTS, graph and no injection incur no provider charge. Combined-arm score reuse adds zero measured spend. Costs and input tokens come from Jev usage fields, never a guessed per-call average. All 344 new requests completed with no unsettled reservation. The [numeric artifact](memory-selection.all-turns.results.json) publishes scores, usage receipts, selections, sizes and cluster IDs for independent recomputation.

0 offers exceed Codex's default 2,500-token `additionalContextLimit` across this sweep; 0 do within the 22 Codex cases. Counting uses `ceil(UTF-8 bytes / 4)` over the exact offer string, following the [Codex byte approximation](https://github.com/openai/codex/blob/main/codex-rs/utils/string/src/truncate.rs). The [documented limit](https://learn.chatgpt.com/docs/hooks) is a per-handler spill threshold, not an exact tokenizer count. The full 10,000-character cap can exceed it for Unicode; regression tests cover that case.

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
claim that only seven eligible operator prompts exist: there are 588 under
the all-turn collection rule in this snapshot.


## Safety and reproduction

The existing runner was extended; pilot replay remains tested. It writes private samples/labels/receipts and scrubbed aggregate exports only. It does not mutate live state, indexes, engine stores or Jev settings. Load the authorized local secret into `OPENROUTER_API_KEY` for the runner process only; it is never logged or saved in artifacts.

A lock spans the paid run. Every call first durably reserves max($0.01, serialized request bytes plus 4,096 overhead tokens at the pinned input price). Admission includes completed usage and outstanding reservations across all variants. Ambiguous responses retain the reservation and block retries. A provider overrun blocks later calls, including after restart. Frozen sample, labels and request hashes prevent silently reusing changed decisions. The carry record is a completed `prior-experiments` receipt summing earlier usage, not a new network call. This is a conservative runner bound at the pinned price, not an account-wide provider quota.

```sh
LLV_STATE_DIR="$PRIVATE_STATE" bun scripts/memory-selection.ts collect "$TRANSCRIPT_DB" "$MEMORY_DB" "$PRIVATE_SAMPLE"
# Adjudicate labels before scoring; launch with a process-only API key.
LLV_STATE_DIR="$PRIVATE_STATE" bun scripts/memory-selection.ts variants "$PRIVATE_SAMPLE" "$LABELS" "$RESULTS" "$LEDGER" "$BUDGET_HISTORY"
# Offline export, without a key or API call.
LLV_STATE_DIR="$PRIVATE_STATE" bun scripts/memory-selection.ts variants-report "$PRIVATE_SAMPLE" "$LABELS" "$NEW_RESULTS" "$LEDGER"
LLV_STATE_DIR="$PRIVATE_STATE" bun test scripts/memory-selection.test.ts
```

Output paths are exclusive-create. `population` runs the same collector without retrieval. Exact-path isolated tests cover real SQLite reads, authorship/voice envelopes, context ordering, native deduplication, caps, shared paid accounting, graph reranking, and reconstruction of every public arm. Targeted TypeScript and ESLint checks cover the runner/tests. The local privacy gate uses the fingerprint catalog, `--require-known-values` and `--check-commits` before push; hosted CI is not the completion gate.

## Recommendation

**Use project/global FTS for the top-30 candidate source and the grounded Jev request for the next controlled selector trial; keep automatic injection off until it passes the precision gate.** Give the decider the latest operator message, opening request, recent role-labelled conversation, project scope and receiving engine, with each offered memory’s own text, bounded body evidence and explicit novelty/applicability criteria inside its question. Do not require graph connectivity: this graph gate discards a useful offer and provides no reliable quality gain.

Use **0.70 only as a provisional shadow-test threshold**, with the same 15-entry / 10,000-character ceiling and no forced minimum. It removed all observed false offers but retained only one of ten useful candidates, so it is not a validated production setting. The release criterion remains ≥90% precision, lower 95% bound ≥80%, and ≥20 offers on fresh independently labelled cases. Until then, on-demand memory search supplies context and automatic injection abstains. A 0.90 probability cutoff currently offers nothing and cannot itself certify precision. This recommendation follows the improved-request comparison, not the seven-prompt pilot.
