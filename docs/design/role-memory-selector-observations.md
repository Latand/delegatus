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
upcoming work and rejects unrelated work. It ships with a 0.10 probability
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

`evals/role-selection/inputs.json` fixes the corpus digest, anonymous case ids,
candidate counts and applied/misled labels. The private corpus and response
receipts contain the full inputs. Learned-rule text and private briefs stay
outside this public repository. Reuse the retained corpus for an exact run;
assembling from later snapshots creates a different dataset.

```sh
bun scripts/role-selection-inputs.ts "$STATE_SNAPSHOT" "$DELIVERY_SNAPSHOT" "$PRIVATE_INPUTS"
bun scripts/role-selection-eval.ts "$PRIVATE_INPUTS/corpus.json" evals/role-selection/inputs.json "$PRIVATE_INPUTS/spend.json" "$PRIVATE_INPUTS/results.json"
```

Supply the normal provider keys in the invoking environment and isolate HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR. The runner makes no balance or admin
requests. Each paid cell reserves its full conservative ceiling in a private,
fsynced ledger before dispatch. Every observed usage bill reduces the retained
charge. An incomplete cell prevents further calls across process restarts;
a completed cell with incomplete billing retains its entire ceiling and is
never retried. Both providers share one USD 5 cap. An exclusive lock prevents
two invocations from racing the same ledger.

Append `--replay` to recompute packing and metrics from saved responses with
zero provider calls. Missing responses refuse an offline replay. The fixed
inputs join the #3406 failed-first-builder protocol to actual delivery hashes
and add recent applied/misled reports. The original four-scope exporter
correctly rejected 278 historical candidates in this snapshot, mostly because
of scope succession; the delivery ledger supplies the exact historical rule
versions and delivered order.

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
