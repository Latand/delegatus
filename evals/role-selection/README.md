# Role-selection evaluation

The fixed corpus has 24 historical launches: 10 from the failed-first-builder
protocol and 14 recent labelled deliveries. It contains 64 applied labels and
8 misled labels. Each case keeps its role, scope order, pseudonymous rule IDs,
and labels. Briefs and rules are semantic paraphrases with identifying details
and private quotations removed. Each case includes its labelled rules and one historically
BM25-selected unlabelled control (96 candidates total). Captured historical
`baselineIds` remain in the input as provenance only; the comparison reruns
the production BM25 selector against each case's exact fixed candidates and
brief, matching the Decisions arms. Provider-failure arms use that same
recomputed BM25 selection. The corpus is a fixed,
reproducible sample, not a claim that every retained installation rule was
scored.

`inputs.json` pins the corpus digest. `results.json` records every whole,
BM25, and provider/prompt cell with applied recall, misled retention, delivered
bytes, latency, and cost. `spend.json` preserves frozen provider responses and
durable reservations so replay makes no API calls. The cumulative local hard
cap is USD 4, preserving USD 1 of the task's USD 5 allowance.

The final prompt uses the same candidate order, a 0.02 score threshold,
9,000-code-point selection budget, and 24,000-byte rendered ceiling. The
threshold was tuned against this corpus, so these are in-sample measurements.
The whole arm delivers every candidate in this sample. Provider failures use
the same recomputed BM25 selection as the comparison arm. Offline requests
have a 120-second deadline; live selection retains its three-second deadline
and can fall back sooner.

| Arm | Decisions success | Applied recall | Misled retained / delivered | Mean bytes | Latency p50 / p95, ms | Usage-confirmed USD | Average USD per cell |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Whole | n/a | 64/64 (100.0%) | 8/96 (8.33%) | 1,420 | <1 / <1 | 0 | 0 |
| BM25 | n/a | 64/64 (100.0%) | 8/96 (8.33%) | 1,420 | <1 / <1 | 0 | 0 |
| OpenAI v1 | 24/24 | 23/64 (35.9%) | 1/31 (3.23%) | 884 | 339 / 595 | 0.002203900 | 0.000091829 |
| OpenAI v2 | 24/24 | 49/64 (76.6%) | 7/71 (9.86%) | 1,211 | 362 / 671 | 0.002599900 | 0.000108329 |
| OpenRouter v1 | 0/24 | 64/64 (100.0%) | 8/96 (8.33%) | 1,420 | 56 / 83 | 0 | 0 |
| OpenRouter v2 | 0/24 | 64/64 (100.0%) | 8/96 (8.33%) | 1,420 | 60 / 122 | 0 | 0 |

OpenRouter refused all 48 cells; both arms show the recomputed BM25 fallback.
OpenAI v2 recalls 15 fewer applied rules than BM25 (49/64 versus 64/64) and
retains one fewer labelled misled rule (7 versus 8). Its smaller block does
not establish a quality improvement on these labels. The misled rate counts
labelled misled rules among delivered rules; unlabelled controls have unknown
relevance. The small number of misled labels and the in-sample threshold limit
generalization. Whole and BM25 timings are measured by the current offline
replay; provider latency comes from the frozen receipts.

The final OpenAI v1 and tuned v2 result cells account for USD 0.004803800
across 48 cells, averaging USD 0.000100079 per cell. The earlier v2 scoring
call remains in spend history because its prompt was revised after that first
measurement. All 72 OpenAI calls for this corpus, including that first v2
measurement, cost USD 0.007271700 (USD 0.000100996 per call on average).
OpenRouter's 72 attempted cells were refused at no charge. The committed ledger
reports **USD 0.226469370** in usage-confirmed charges and **USD 0.365672995**
conservatively retained across all recorded work. Twelve cells retain their
full request ceiling because an exact bill was unavailable. The local cap
counts those ceilings and leaves at least USD 1 from the task allowance
unspent. No balance endpoint or admin credential was used.

Replay the committed bundle without credentials or API calls:

```sh
bun scripts/role-selection-eval.ts \
  evals/role-selection/corpus.json \
  evals/role-selection/inputs.json \
  evals/role-selection/spend.json \
  /path/to/replayed-results.json --replay
```

The test `scripts/role-selection-eval.test.ts` checks replayed results, corpus
text and labels, delivery sizes, and durable spend. Input assembly notes are
in `docs/design/role-memory-selector-observations.md#repeat-the-offline-evaluation`.

For an unsaved provider choice, a connected OpenAI key selects OpenAI; otherwise
a connected OpenRouter key selects OpenRouter. To override a saved choice, use
**Settings → Keys → OpenAI → Learned rules → OpenAI** (`PUT /api/openai-services`
with `{"feature":"rules","provider":"openai"}`). Live settings were left
intact.
