# Role-memory selector observations

## Diagnosis

The investigation started from the published analysis of 1,580 first launches:
1,398 provider-limit fallbacks, 168 selector timeouts, 14 Jev-path timeouts,
and no successful Jev selections. Those historical rows cannot identify the
rejected provider response or the phase that consumed the deadline.

A read-only request to the configured key metadata endpoint on 2026-10-29
returned HTTP 200, a USD 3 key limit, USD 0 remaining, and usage slightly above
USD 3. No decision request was sent. This reproduces a legitimate admission
refusal with the current key. It does not prove that every historical refusal
had that cause. The independent USD 5 role-selection cap cannot replenish or
raise a provider key's limit. Running paid shadow selections on this installation
therefore requires the operator to restore that key's budget first.

OpenRouter documents `limit` and `limit_remaining` as per-key credit controls:
[limits](https://openrouter.ai/docs/api/reference/limits) and
[current key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key).
Finite remaining credit must cover the conservative byte-based cost ceiling.
An unlimited key has null limit and remaining fields. Missing or invalid fields
refuse admission. Negative remaining credit is an insufficient-budget result.
HTTP refusals, invalid metadata, and insufficient credit have distinct evidence
statuses. The adapter never stores the key endpoint's labels, account metadata,
credentials, or response text.

`src/lib/memory/roleLaunch.ts` starts one three-second budget before lazily
loading the pipeline store and obtaining the brief. `src/lib/memory/roleSelect.ts`
uses its remainder for BM25, packing, key reads, admission, reservation,
decisions, settlement, and final packing. A deadline before the BM25 fallback
exists produces `selector-timeout` and whole fallback; a deadline during the
provider path produces `jev-timeout` and the completed BM25 fallback. A stalled
key endpoint or decision body can consume that same budget. No historical
phase timings exist to attribute the 182 recorded timeouts more precisely.
The deadline is retained. External operations now start lazily after a
monotonic-clock check, and are checked again after each await. This prevents
a late timer callback from admitting a request after its budget already elapsed.
A controlled-clock regression advances the deadline during a real adapter
admission read without firing the timer and requires zero paid decision
requests.
This change claims no latency improvement.

## Provider boundary and evidence

`src/lib/memory/roleSelectionProvider.ts` defines one provider interface.
The OpenRouter adapter owns credential reads, redaction, batches of up to 32
questions, wire formats, pricing, admission, and score parsing. The selector
owns the shared deadline, current-key and memory-enabled checks before every
dispatch, the independent USD 5 monthly cap, and packing. No additional provider
or delivery mode is introduced.

The existing per-attempt `role_memory_selection` row accepts optional `evidence`.
Old rows remain readable. New selection results include provider and model,
admission status, HTTP status, limit, remaining credit, requested ceiling,
total latency and phase durations, reserved and retained cost, observed bill,
and scores for every scored candidate, including rejected candidates. BM25
scores and Jev probabilities retain their precision in `allScores`; `scoreSource`
names their interpretation. Operator-protected rules are excluded from scoring.
The existing `scores` field remains the rounded selected-rule projection.

`billedUsd: null` means at least one request's bill was not fully observed.
`costUsd` is the charge retained by the local cap, which can conservatively
include the full reservation for a lost or timed-out reply. An observed HTTP
refusal releases its reservation; an invalid response with a valid reported bill
retains that bill. No late response refunds a cancelled request. The monthly
reservation survives a fresh process. The evidence has the selection row's
existing retention policy; it is retained until proven settlement plus 24 hours.

`selectionCandidate` remains the production row builder. First delivery freezes
the candidate and its evidence together; resumes reuse that row and make no
new paid request. `mode` remains `whole`; agents receive the complete snapshot,
subject to the existing explicit-withdrawal and consent rules. The shadow
environment switch still disables computation.

## Reproduction and verification

`src/lib/memory/roleSelect.test.ts` invokes the real selector and adapter with
stubbed fetch responses. It covers an exhausted and a replenished finite key,
an unlimited key, invalid metadata, HTTP refusals, stalled admission and decision
requests, body stalls, BM25 cancellation, current-key changes, conservative
cost accounting, and the monthly cap across process restart. New observations
are regression detectors against the original implementation, which discarded
the admission data, timing, cost, and rejected-rule scores.

`src/lib/memory/roleSelection.test.ts` uses `buildPipeline` and the real launch,
selection, freeze, and read paths. A stubbed low-probability decision leaves the
whole delivered rule block intact, persists the rejected score and costs,
round-trips the writer's actual row through a fresh-process reader, and makes
no second decision request on resume. Tests make no paid provider calls.
