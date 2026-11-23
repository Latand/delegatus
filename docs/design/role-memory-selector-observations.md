# Role-memory selection

Learned rules reach each eligible engine start through the selected block.
The role scaffold and working principles keep their existing instruction
channel. Operator-kept learned rules retain their reserved 3,000 code points;
ordinary selections use at most 9,000 code points. Every rendered block,
including whole fallback, has a hard 24,000-byte ceiling.

With no saved choice, the `rules` provider follows connected credentials:
OpenAI first, then OpenRouter, then BM25 when neither key exists. A saved
choice wins. An unavailable explicitly selected provider falls back to BM25.
Select it in **Settings → Keys → OpenAI → Learned rules**. The corresponding
API is `PUT /api/openai-services` with
`{"feature":"rules","provider":"openai"}` or `"openrouter"`. Saving or
importing a key changes no live preference. Legacy OpenAI opt-ins remain
explicit; older OpenRouter choices had no durable distinction from a missing
choice. New OpenRouter choices persist that distinction in `rulesProvider`.

The provider uses the role, bounded task brief and each redacted candidate.
`src/lib/memory/roleSelectionPrompt.ts` holds both evaluated prompt versions.
Version 2 asks whether any concrete precaution can prevent an error in the
upcoming work and rejects unrelated work. It ships with a 0.02 probability
cutoff, selected by replaying the saved probabilities. The provider adapters
share the batch builder; OpenAI translates it through the existing Decisions
adapter. Batches contain at most 32 named predicates.

BM25 is prepared locally so a refused, unpriced, timed-out, revoked or
unavailable Decisions request can return a completed fallback. Whole delivery
is used when the local selection cannot complete either. `reason`, provider,
scores, phase timings and accounting accompany the durable selection and
delivery. The three-second selection deadline and independent USD 5 monthly
reservation survive. No live settings are changed by this implementation.

`LLV_ROLE_MEMORY_SHADOW` has no effect. New rows have `shadow:false`; existing
shadow rows convert to their saved selected ids on the next engine start,
using exact retained historical text. Rows written by the retired whole bypass
are selected again. Other per-attempt selections remain frozen
across engine changes and restart. Explicit deletion, unresolvable text and
swarm consent keep their existing withdrawal rules. Historical schema names
`jev` and `shadowIds` remain readable; `shadowIds` names the chosen ids.

For a launch outside a pipeline, the selector uses the role, launch title and
goal. Its ledger records the delivered ids and fallback evidence. Pipeline
launches use the task, specification and stage brief.

## Repeat the offline evaluation

`evals/role-selection/` contains a committed replay bundle with anonymous case
ids, all candidate positions, scopes, labels, anonymized semantic paraphrases,
captured historical BM25 selections and frozen score/usage receipts. Learned
rule wording and private briefs stay outside this public repository. The
captured historical selections are provenance only: replay runs production
BM25 on each same fixed brief and candidate pool passed to both Decisions
prompts. Decisions fallback cells use that recomputed BM25 selection.
Reassembling from later snapshots creates a different dataset.

```sh
bun scripts/role-selection-eval.ts evals/role-selection/corpus.json evals/role-selection/inputs.json evals/role-selection/spend.json "$TMPDIR/replayed-results.json" --replay
```

This committed replay needs no provider key and sends no requests. A live
evaluation uses the snapshot assembler with private output paths. Isolate HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR. Each paid cell reserves its full
conservative ceiling in a private, fsynced ledger before dispatch. Every
observed usage bill reduces the retained charge. An incomplete cell prevents
further calls across process restarts; a completed cell with incomplete billing
retains its entire ceiling and is never retried. Both providers share one USD 5
cap. An exclusive lock prevents two invocations from racing the same ledger.

Append `--replay` to recompute packing and metrics from saved responses with
zero provider calls. Missing responses refuse an offline replay. The fixed
inputs join the #3406 failed-first-builder protocol to delivery identities and
add recent applied/misled reports. The original four-scope exporter correctly
rejected 278 historical candidates in this snapshot, mostly because of scope
succession; the delivery ledger supplies the exact historical versions and
delivered order.

See `evals/role-selection/results.json` and `evals/role-selection/README.md`
for the measured table, spend and limitations. Self-reported applied/misled
labels are sparse; absent labels do not establish irrelevance. The cutoff was
tuned on this corpus. These figures measure its replay cases.

## Verification

The provider and launch tests use real port-0 loopback HTTP servers with the
production request builders, parser, selection, renderer, freeze and ledger.
They cover key combinations, explicit settings, refusal, malformed responses,
deadline cancellation, key revocation, restart, legacy shadow conversion and
the byte ceiling. Existing spend tests retain restart and late-response guards.
