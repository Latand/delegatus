# Provider-cut recovery: the cut a stage still owes

Status: design for PR #2537 (lane d2d49fe8, branch of lane 499d73d9).
Head reviewed: `52d7f9bd3`. Base the PR started from: `ff4af9a38`.

## Originating requirement

The operator's board task, created 2026-10-05 on the Delegatus board (task
`ac8805a6`), text verbatim:

> Етап, обірваний лімітом сесії, сам продовжує після скидання
> Сім етапів зупинились на ліміті сесії Claude й стояли в «потрібне рішення» ще понад годину після скидання ліміту, поки їх не підняли вручну. Етап має сам перейти на інший дозволений акаунт або сам продовжити, коли ліміт скинувся.

From the task's details, same date: "Wanted: (1) a stage cut by a provider
limit that names a reset time is resumed by the engine after that time without
anyone asking, with the same attempt semantics as a manual retry-stage".

Lane 499d73d9's pinned specification, item 2, verbatim:

> A stage cut by a provider limit that names a reset time is resumed by the
> engine itself after that time (parsed from the provider message, with a small
> margin; a bounded fallback when no time is given), with the same attempt
> semantics as a manual `retry-stage`. Survives a Viewer restart. Never resumes
> a lane the operator closed, paused or answered meanwhile.

This lane's pinned outcome 1, verbatim:

> design: docs/design/provider-cut-recovery-anchor.md pins ONE rule: each
> provider cut is its own owed item, opened by its cut record and closed only by
> the engine's continuation or by activity that happens AFTER that cut
> (operator/orchestrator reply, pause/resume, close, report); the evidence
> window and the cancellation test for a cut are both measured from that cut,
> never from an earlier cut or the attempt start; the 8 MiB reader bound applies
> from that cut.

Two sentences carry the whole class: the stage must resume by itself, and it
must never resume a lane the operator closed, paused or answered meanwhile.
Every review round from 10 onward argued about what "meanwhile" is measured
from.

## The class, and why it kept coming back

Lane 499d73d9 closed after twelve review rounds. Rounds 10 (P1) and 12 (P2)
found the same defect in two places: the engine judged a later provider cut
against an earlier one.

The head answers "since when?" with three different anchors, and each consumer
picks one:

| Anchor | Where | Used by |
| --- | --- | --- |
| `attempt.startedAt` | `durableEvidence.ts:441-447` (first-tick boundary), `:490-501` (first cut ≥ start) | first tick with no saved wait, `reconcileParkedProviderRetry` legacy upgrade (`engine.ts:6742-6750`) |
| last `providerRecoveries` record with action `"continue"` | `engine.ts:5411-5416` (`evidenceStartedAt`), added by the round-10 fix `d57a0cb5f` | the running tick when no wait is saved |
| `providerWait.turnTs` (the saved cut) | `engine.ts:5416` `afterCutAt`, `:6653-6658`, `:6694-6699`, `:2283` | every check while a wait is saved |

A saved wait is deleted when verified work follows its cut (`engine.ts:5466`,
`:5481-5484`). From then on the engine has forgotten where that cut ended, and
the next cut falls back to the attempt start or to the last engine
continuation. The round-10 fix added the continuation anchor; round 12 showed
that a wait cleared by an operator's answered reply or by a harness wake leaves
no continuation record, so the anchor falls back to the attempt start again.
Any fix that persists one more anchor has to be written on every path that
clears a wait, and each missed path reopens the class.

### Round 10 (P1, head `63d4ce5ca`)

Cut 1 at 17:22:09Z ("resets 10pm (Europe/Kyiv)"), engine continuation at
19:01:30, work; then (a) an operator message about 20:02 that the agent
answers, (b) a pause and resume about 20:02, or (c) 9.5 MiB of work with no
interaction; cut 2 at 21:30Z ("resets 2am"). The head of that round parked at
once in (a) and (b) and after ten minutes in (c) ("delivered prompt history is
incomplete"), with no `stageRetry`. Base `ff4af9a38` continued at 23:01 in all
three.

### Round 12 (P2, head `52d7f9bd3`)

Cut 1 at 17:22:09Z, tick; at 19:00:20Z an operator or orchestrator line and the
agent's `end_turn` answer, tick; cut 2 at 21:30Z ("resets 2am"); ticks every
30 s to 23:05Z. The head parks at once with "provider recovery cancelled after
newer stage activity". With a Claude task notification in place of the reply
and a pause and resume at 20:00, it parks with "provider recovery cancelled by
operator control during the stage". Base continued at 23:01. When the engine
itself had continued cut 1, the head also continued at 23:01: the continuation
anchor covered only that one path.

## The rule

**A stage attempt owes recovery for its open cut chain.**

- A *provider cut* is a native terminal provider-failure record of this
  attempt: the Claude assistant record flagged `isApiErrorMessage` with a
  terminal API error, or the Codex turn-end record carrying a provider failure.
  A turn the operator or a deploy aborted (`turn_aborted`) is not a provider
  cut. Records older than `attempt.startedAt` belong to an earlier attempt; the
  attempt start decides membership only and never anchors a window.
- *Agent output* is a record the agent authored after the provider accepted a
  turn. Claude: an `assistant` record that is not flagged `isApiErrorMessage`
  and whose model is not `<synthetic>` (text or a tool call). Codex:
  `agent_message`, `agent_reasoning` / `reasoning`, an assistant `message`, and
  a `response_item` tool call (its output excluded).
- The *open cut chain* is the run of provider cuts after the attempt's last
  agent output. Its *first cut* is the cut record the rule measures from.
  Further cut records with no agent output between them belong to the same
  chain; each one refreshes the saved witness (`turnTs`, reset) and opens
  nothing new.
- The chain is **closed by agent output**: the stage is working again, because
  the engine's continuation took effect or because someone's prompt was worked
  on. The next cut after that output opens a new chain, which is owed by
  itself.
- The chain is **cancelled by activity after its first cut**: an operator or
  orchestrator prompt (any prompt the reader classifies `external`), a pause or
  a resume, a close, a report. Harness wakes and engine continuations
  (`harness`, `pipeline`, `startup-recovery` origins) after the first cut
  cancel nothing.
- The evidence window and the cancellation test both start at the chain's
  first cut record, in verified physical record order. They never start at an
  earlier chain, at the last engine continuation, or at the attempt start. The
  8 MiB reader bound (`MAX_REPORT_EVIDENCE_BYTES`) counts from that first cut;
  history before it is validated in order and never retained.
- The chain is read from the transcript on every tick. Nothing persisted
  anchors it, so a deleted wait, a restart or a missed clearing path cannot move
  it.

Close, report, retry-stage and skip-stage keep ending engine ownership through
pipeline and attempt state, as they do today; they need no timestamp.

### Where this reads the pinned wording narrowly

The pinned outcome says "each provider cut is its own owed item". Read per
cut record, a transcript like this one would owe recovery for its second record:

```
17:22:09  cut ("You've hit your session limit · resets 10pm")
17:30:00  operator: "Wait for my answer"
17:30:00  cut (the provider refused that prompt; no agent output)
```

The second record is the provider refusing the operator's own prompt. Owing it
would send "Continue the same stage…" after the reset, on top of "Wait for my
answer": a resume of a lane the operator answered meanwhile. Ten existing
engine test families pin exactly this shape as a cancellation (lines 21714,
21758, 21853, 22066, 22199, 22239, 22280, 22347, 22395 and 22445 in the table
below), including "first recovery tick respects a prior operator prompt",
which this lane's brief names among the cases the build must keep. The rule
therefore treats such a record as part of the chain the operator answered. A
cut is its own owed item once agent output separates it from the previous one,
which is every round-10 and round-12 scenario. This reading satisfies the brief's other constraints
("all existing cases kept", the named tests green) and the originating "never
resumes a lane the operator … answered meanwhile"; the per-record reading
satisfies neither.

One consequence is deliberate and matches the base and the head: an operator
prompt refused before any earlier cut (agent output, then the prompt, then a
cut) lies before the chain's first cut, so it cancels nothing. The engine's
continuation then follows the operator's message in the conversation. The
reply-before and control-before cases of "stage progress makes the next
provider cut own cancellation" pin that activity before the chain's first cut
cancels nothing.

## Options considered

**A. Every cut record is its own item, measured from itself.** Smallest reader
change. It resumes over a refused "Wait for my answer" (section above) and
flips those ten engine test families from cancel to resume. Rejected: it fails
the originating requirement.

**B. Persist the cleared cut's boundary** (round 12's proposed intent: when
verified work clears a saved wait, record a `"continue"`-like boundary and
anchor on it). Keeps a persisted anchor that every clearing path must write
(`engine.ts:5466`, `:5481-5484`, the external-prompt branch at `:5448-5467`)
and that must survive restarts. Read against the code, it would still park two
shapes the probes below cover: a reply, its answer and cut 2 all written
between two ticks (no clearing pass ran, so the saved wait still names cut 1),
and a reply whose answer is still busy at the tick (the head keeps the wait as
a cancelled witness until the turn ends, and a turn that ends in cut 2 parks on
it). Rejected: it is the round-10 fix extended by one more path, and the class
lives in the paths.

**C. Derive the owed cut from the transcript: the open cut chain.** Chosen.
The reader already streams the whole transcript in physical order when a
recovery decision is pending (`readRecoveryWindow`, `durableEvidence.ts:350`).
Resetting its retained window on agent output yields the chain directly. The
engine keeps its saved wait as the witness and continuation key, and drops it
when the reader shows its cut lies outside the open chain.

## What stays, what goes

Goes:

- `evidenceStartedAt` and the continuation anchor (`engine.ts:5411-5415`). The
  tick passes `attempt.startedAt`, which also restores report-prose reading
  from the attempt start (round 12, note 2).
- The requested-cut anchor in the reader: `cutTime ?? firstProviderCutAt`,
  `cutIndex`, `latestCutIndex` (`durableEvidence.ts:498-507`). `afterCutAt`
  stays as an argument with two jobs only: it requests coverage while a wait is
  saved, and it asks whether the saved cut is in the open chain.
- `automaticPromptBeforeProviderCut` (`durableEvidence.ts:42`, `:515-517`) and
  the matching checks in `refreshHarnessProviderCut` (`engine.ts:6674-6676`).
  A newer cut in the same open chain with no external activity is a re-observed
  cut by definition.
- Window retention from the first cut at or after a boundary
  (`durableEvidence.ts:371-381`).

Stays:

- `providerWait.turnTs` as the witness, the continuation key
  (`providerContinuationKey`) and the host-retirement fence
  (`hostRetirement.ts:44-55`).
- `retryCancelled`, `stageRetry`, `controlGeneration` and the
  `continuationAllowed` fence (`engine.ts:2282-2288`).
- The `providerRecoveries` journal, for the try budget, the park reason and the
  legacy park upgrade. It anchors nothing.
- Prompt classification (`stagePrompts`), the full-scan trigger, the 8 MiB
  bound and the bounded "delivered prompt history is incomplete" transport
  wait.
- The pause/resume comparison at `engine.ts:5442-5446`, now against the chain's
  first cut.
- `newerExternalProviderPrompt`'s `prompts` fallback (`engine.ts:6656-6657`).
  It serves evidence that carries no chain fields: test doubles, and a closed
  chain, where it can only keep a stale wait marked cancelled until the turn
  ends or the next chain discharges it.
- The hostless legacy park (`engine.ts:6745`) keeps the attempt start as its
  bound: it has no cut record to measure from.

## Build plan (smallest)

A prototype of exactly this plan ran in a scratch export of `52d7f9bd3`
(results below). Source change: about 65 added and 50 removed lines in two
files, comments included.

### `src/lib/pipelines/durableEvidence.ts`

1. Add `agentOutput(record, codex)` with the definition above, and
   `providerCutAt(record, codex, startedAt, fallbackTs)`, the cut test now
   written twice inline (`:371-375`, `:490-497`).
2. `readRecoveryWindow(pathname, codex, attemptStartedAt, snapshot)`: agent
   output clears the retained records and the byte count; the first cut after
   it starts retention. A chain over 8 MiB keeps scanning (later agent output
   can still close it) and returns `null` at the end of the file only if the
   chain is still open. No open chain at the end returns an empty, complete
   window.
3. Keep the coverage trigger as it is (a saved cut, or a terminal provider
   failure with a known attempt start) and pass the attempt start to the window
   for membership only.
4. Compute the open chain over the verified records (the complete tail or the
   window): `firstProviderCutAt` is its first cut, or `null`;
   `externalPromptAfterCut` and `automaticPromptAfterCut` describe prompts after
   it and are omitted when no chain is open; a new `requestedCutOpen` says
   whether a cut with `ts === afterCutAt` is in the chain, reported when
   `afterCutAt` was given and the read either is complete or contains agent
   output. `promptHistoryComplete` becomes "the read is complete or the window
   was verified".
5. Use one timestamp rule for cut membership in both passes (the window uses a
   zero fallback today; the summary pass uses the file time).

### `src/lib/pipelines/engine.ts`

1. Delete `evidenceStartedAt`; pass `attempt.startedAt` (`:5411-5416`).
2. After the incomplete-history check (`:5438-5441`), discharge a saved wait
   whose cut lies outside the open chain:
   `turnTs > 0 && durable.firstProviderCutAt && durable.requestedCutOpen === false`
   deletes `providerWait` and `providerRecoveryBudget`, as the newer-output
   branch at `:5481-5484` does. The new cut then opens a fresh wait through
   `recoverProviderCut`, and its `retryCancelled` check (`:2129`) no longer sees
   the old chain's cancellation. A zero-time successor (`turnTs === 0`) is
   never discharged: its inherited budget belongs to its predecessor's chain.
3. `refreshHarnessProviderCut` (`:6672-6677`): replace the message and
   `automaticPromptBeforeProviderCut` checks with
   `durable?.requestedCutOpen !== true → return false`.

Everything else in the provider path reads the same fields with the new
meaning and needs no edit: `newerExternalProviderPrompt`,
`newerAutomaticProviderPrompt`, `providerCutActivity`, `continuationAllowed`,
the legacy upgrade in `reconcileParkedProviderRetry`, and
`providerRecoveryTurnProven`.

### Tests (failing first)

Engine seam, fake clock, real reader, both engines, pinned and pool, in
`src/lib/pipelines/engine.test.ts` beside "stage progress makes the next
provider cut own cancellation": "a provider cut after agent output owes its own
recovery". Shape, as probed: cut 1 at 17:22:09Z ("resets 10pm (Europe/Kyiv)";
Codex adds a `token_count` with that reset); activity at 19:00:20Z; cut 2 at
21:30Z ("resets 2am"; Codex `resets_at` 23:00Z); ticks every 30 s to 23:05Z.
Pool mode allows two accounts and resolves `exhausted` until the current reset.

| Case | Activity between the cuts | Expected |
| --- | --- | --- |
| operator | operator prompt, agent answer `end_turn`, tick | one continuation after 23:01, one spawn |
| orchestrator | orchestrator prompt (delivery ledger / structured origin), answer, tick | same |
| harness-control | Claude task notification or Codex `startup-recovery` prompt, answer, tick; pause and resume at 20:00 | same |
| busy-operator | operator prompt, agent tool call still open at the tick | same |
| same-tick | operator prompt, answer and cut 2 all before the next tick | same |
| reply-after | operator answer and tick as above; operator prompt one second after cut 2 | no continuation, one spawn |
| control-after | as above; pause and resume one second after cut 2 | no continuation, `needs_decision` |
| operator-refused | operator prompt, cut 2 half a second later, no output | no continuation, `needs_decision` |

On head the twenty owed cases fail (sixteen park with "provider recovery
cancelled after newer stage activity", four with "…by operator control during
the stage"); the twelve control cases pass.

Reader unit in `durableEvidence.test.ts`, both engines: cut, operator prompt,
agent output, later cut gives `firstProviderCutAt` of the later cut,
`externalPromptAfterCut: false`, `requestedCutOpen: false` for the first cut;
cut, operator prompt, refused cut gives the first cut,
`externalPromptAfterCut: true`, `requestedCutOpen: true`. Head fails it
(reports the first cut and `true`).

One existing expectation changes with the rule: "Codex unavailable prompt
metadata stays external without losing terminal evidence"
(`durableEvidence.test.ts:22`). Its transcript ends in the agent's answer, so no
chain is open: the case keeps its terminal, message and `prompts` assertions
and now asserts `firstProviderCutAt: null`, no `externalPromptAfterCut`, and
`requestedCutOpen: false` when the cut is requested. Its engine twins (lines
19035 and 19064 of `engine.test.ts`) pass unchanged. Every other existing case
keeps its assertions.

### Gates

Touched test files by path through an isolated wrapper (private `HOME`,
`XDG_*`, `TMPDIR`, `LLV_STATE_DIR`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` under a
fresh temp root, `LLV_VIEWER_CONTROL_URL` on a closed port, `NODE_ENV=test`,
`--timeout 900000`): `engine.test.ts`, `durableEvidence.test.ts`,
`hostRetirement.test.ts`. Then `tsc --noEmit` with a scratch
`--tsBuildInfoFile`, eslint on the changed files, the local privacy gate from
the merge base, a merge of `origin/main` before the push. No broad sweeps
against live state; no hosted-check waiting.

## Prototype evidence

All runs used a `git archive` export of `52d7f9bd3` under the stage's scratch
directory, a symlinked `node_modules` with the same lockfile, and the isolated
wrapper above. The worktree was not edited.

| Run | Result |
| --- | --- |
| head, 183 anchor-sensitive engine cases | 183 pass |
| head, the 32 probe cases above | 20 fail (all owed cases), 12 pass |
| prototype, full `engine.test.ts` (1 012 existing + 32 probes) | 1 044 pass, 0 fail |
| prototype, `durableEvidence.test.ts` + `hostRetirement.test.ts` before the expectation update | 131 pass, 1 fail (the case named above) |
| prototype, `durableEvidence.test.ts` with the update and the chain unit | 93 pass |
| head reader, the chain unit | 2 fail |
| prototype `tsc --noEmit` | 0 errors |
| prototype eslint on the two source files | 0 errors (4 warnings at `engine.ts:2589`, untouched code) |

## Rounds and existing tests mapped to the rule

Clauses: **R1** later cuts with no agent output between them are one chain,
measured from its first cut; **R2** agent output closes a chain and the next
cut owes itself; **R3** an external prompt after the first cut cancels;
**R4** pause or resume after the first cut cancels; **R5** harness wakes and
engine continuations cancel nothing, and a re-observed cut refreshes the
witness; **R6** the window and the 8 MiB bound start at the first cut;
**R7** close, report, retry and skip end ownership through state.

Rounds:

| Finding | Rule | Outcome under the rule |
| --- | --- | --- |
| Round 10 (a) reply answered, (b) pause/resume, (c) 9.5 MiB of work, all before cut 2 | R2, R6 | the continuation's work closed chain 1; cut 2 opens chain 2; the activity and the 9.5 MiB precede it; continued at 23:01 |
| Round 12 operator or orchestrator reply answered, then cut 2 | R2 | the answer closed chain 1; cut 2 owed; continued at 23:01 |
| Round 12 harness wake answered, pause/resume at 20:00, cut 2 | R2, R4 | the control precedes chain 2's first cut; continued at 23:01 |
| Same shapes, reply or control after cut 2 | R3, R4 | cancelled |

`engine.test.ts` (line numbers at `52d7f9bd3`). Every case stays with its
assertions unchanged.

| Line | Test | Shape | Rule |
| --- | --- | --- | --- |
| 22485 | stage progress makes the next provider cut own cancellation (reply-before, control-before, large-work, reply-after, control-after) | continuation, agent output, then activity before or after cut 2 | R2; R6 for large-work (9.35 MiB precede chain 2); R3/R4 for the after cases. Passes with the continuation anchor deleted |
| 22066 | first recovery tick respects a prior operator / pipeline / initial / harness prompt (large tail) | cut, prompt, cut, first look | R1: one chain from cut 1. Operator cancels (R3); pipeline and harness do not (R5); initial lies before cut 1 |
| 22127 | first recovery tick respects pause and resume after-cut / before-cut | one cut | R4 |
| 22280 | backdated context after a large native record retains human cancellation (first-tick, running, parked) | cut, human, 150 KB, backdated row, cut | R1, R3; R6 physical order |
| 22395 | zero-time successor preserves its first cut across human / operator-control / automatic activity | successor transcript: cut, prompt or control, cut | R1 in the successor's own transcript; `turnTs 0` never discharged |
| 21853 | a quota reply remains external through image / large-tail / human-before-harness evidence | cut, reply, cut | R1, R3 |
| 21714 | running / pinned-park / pool-park quota cut distinguishes a newer operator / task-notification / scheduled turn | cut, prompt, cut | R1; R3 for operator; R5 refresh for harness |
| 21758 | quota continuation trusts delivered pipeline / startup-recovery / operator authorship | cut, continuation, cut | R1; R5 or R3 by authorship |
| 22199 | native Codex shapes: operator / pipeline / startup-recovery authorship controls quota recovery (parked) | cut, prompt, cut | R1; R3 or R5 |
| 22239 | Claude modes and wrappers: native-human / ledger-human / harness authorship controls quota recovery | cut, prompt, cut | R1; R3 or R5 |
| 22445 | an accepted continuation retains recovery after proved / human / unknown execution refusal | human: cut, reply, cut | R1, R3 |
| 22347 | legacy quota upgrade respects operator control (before-cut, after-cut, after-later-cut, hostless, human-before-later-cut) | parked legacy chain | R1, R3, R4 on the chain's first cut; hostless keeps the attempt start |
| 21805 | parked harness quota notice persists its named 10pm / 11pm reset (pool) | cut, task notification, cut | R1, R5 refresh |
| 21902 | parked retry retains a delivered pipeline / startup-recovery continuation | cut, continuation, cut | R1, R5 |
| 21967 | running / parked quota wait retains a human prompt removed by shutdown normalization | cut, typed prompt, interrupt, `<synthetic>` no-op | R3; the `<synthetic>` record is not agent output |
| 19307 | a newer native operator turn cancels running reset continuation (tool) | cut saved, reply, tool call | R3; with the tool call the chain is closed and the stale wait stays marked cancelled until the turn ends |
| 19710 | an operator reply ending on a newer native provider-notice / empty-completion cancels the old quota retry | cut, reply, cut or clean completion without output | R1, R3 |
| 19645 | operator close / pause / pause-resume / reply / report / retry-stage / skip-stage cancels a parked quota retry | parked | R3, R4, R7 |
| 19496 | cancelled quota retry withdraws its card promise after pause-resume / report | parked | R4, R7 |
| 19695, 21474, 21516 | reply while termination is confirmed; reply before a far-future reset; reply during fresh target termination | test-double evidence | R3 through the `prompts` fallback |
| 21947, 22044 | reply racing continuation admission; capacity relaunch rechecks operator input | test-double evidence | R3 through the `prompts` fallback |
| 21992 | pause and resume withdraws a running provider reset obligation | saved wait, pause, resume | R4 |
| 19910 | a report wins over a terminal limit | report | R7 |
| 21879, 22106 | prompt history over the read bound; first recovery tick bounds incomplete prompt history | 9 MiB inside one chain | R6 |
| 22307 | large historical prefix permits named reset recovery (parked) | 9.35 MiB before the chain | R6 |
| 20081, 20418 | unknown resets keep the three-continuation bound; mixed provider cuts keep expenditure until progress | repeated cuts, no output (test doubles) | R1: one chain keeps one budget |
| 20098 | a busy resumed turn retires the old unknown-reset wait (assistant progress) | test double | R2 |
| 19035, 19064 | Codex unavailable prompt metadata lets both lanes settle; cancels a parked quota retry | reply answered | R2 settles; R3/R7 for the parked retry |
| 19109, 19176, 19437, 19584, 19731, 20167, 20208, 20245, 20272, 20802, 21426, 21662 and the remaining provider cases | single cut per transcript: selection, resets and time zones, budgets, restart, delivery fences, host stops, card text | one chain, so every anchor agrees | unaffected |

`durableEvidence.test.ts`: "prompt order survives clock skew" (705, R1 physical
order), "backdated context cannot hide a human reply" (722, R1, R6), "first
provider cut follows native order when timestamps run backward" (738, R1),
"large historical prefix preserves a recent named cut" (780, R6), "large
relevant history with backdated rows remains incomplete" (806, R1, R6) stay
unchanged. "Codex unavailable prompt metadata stays external" (22) changes as
described in the build plan. `hostRetirement.test.ts` is unaffected: a proven
retirement requires the transcript to end in the saved cut, which is in the
open chain by construction.

## Validation against the originating requirement

- *Resumes by itself after the reset*: a cut after agent output is owed whatever
  happened before it (rounds 10 and 12), on both engines, pinned and pooled.
- *Never resumes a lane the operator closed, paused or answered meanwhile*:
  "meanwhile" is the time since the chain's first cut. A reply, a pause or a
  resume in that time cancels, including a reply the provider refused at once.
- *Survives a Viewer restart*: the chain comes from the transcript, so a
  restarted Viewer derives the same owed cut with no persisted anchor.
- *Same attempt semantics as `retry-stage`*: unchanged (parked retries still go
  through `reconcileParkedProviderRetry`).

## Deferred — not currently justified

- **A parked lane whose withdrawn retry is followed by new agent work and a
  later cut.** The lane is in `needs_decision`; its retry was withdrawn by the
  activity after the parked cut, as the rule requires. A later cut in that
  conversation is not upgraded into a new retry. No incident shows this shape,
  and the operator already holds the lane.
- **Avoiding the whole-file scan on every waiting tick** (round 10, note 4:
  100–240 ms on 8–30 MiB transcripts). A tail that holds agent output before the
  chain's first cut proves the chain's start and could skip the scan. It saves
  time and changes no outcome.
- **Dropping the 8 MiB retention** by summarizing the chain while streaming.
  The pinned outcome keeps the bound.
- **Treating an operator prompt refused before any earlier cut as a
  cancellation.** The rule measures from the chain's first cut; the base, the
  head and the reply-before case (both engines) resume there. Revisit only if
  the operator asks for it.
- **Removing the `prompts` fallback** in `newerExternalProviderPrompt`. Test
  doubles depend on it, and for a closed chain it has no effect beyond the
  witness.

## Notes

- No earlier solution existed: transcript and memory searches for the anchor
  question returned only lane 499d73d9's own rounds.
- `retryCancelled` on a wait from a closed chain is harmless after this change:
  the discharge step removes that wait before the next chain is judged.
