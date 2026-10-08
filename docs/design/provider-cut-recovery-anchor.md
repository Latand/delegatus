# Provider-cut recovery: the cut a stage still owes

Status: design for PR #2537 (lane d2d49fe8, branch of lane 499d73d9), revision
2 of 2026-10-08. The controller approved the chain rule, and this revision adds
the parked retry and the zero-time successor to the build plan after the
critique of revision 1.
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

The rule this lane builds, as the controller approved it on 2026-10-08 after
the critique of revision 1 ("CHAIN є чинним правилом"), in the critique's
words: "Два і три зрізи без output є одним боргом; reply чи pause/resume між
ними скасовують його, harness не скасовує; output перед C2/C3 відкриває новий
борг." Stated in full:

> A stage attempt owes recovery for its open cut chain: the provider cuts after
> its last agent output. Agent output closes the chain, and the next cut opens
> a new chain that is owed by itself. An operator or orchestrator reply, a
> pause or a resume, a close or a report after the chain's first cut cancels
> it; a harness wake or an engine continuation cancels nothing. The evidence
> window, the cancellation test and the 8 MiB reader bound all start at the
> chain's first cut. An earlier chain and the attempt start bound none of them.

This replaces the per-cut wording of this lane's pinned outcome 1; the section
"Two cuts with no output between them are one item" records why.

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

The critique of revision 1 found two more such paths in revision 1's own plan:
a parked retry, whose `providerCutActivity` reads any newer record as
cancelling activity, and a zero-time successor, whose inherited wait keeps its
predecessor's cancellation and budget. Both are covered below.

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

### Critique of revision 1 (two P2, 2026-10-08)

- Parked: cut 1 parked with a `stageRetry`; before the next tick a harness
  wake, real agent output, cut 2. Revision 1's refresh refused to move the
  wait, and the unchanged `providerCutActivity` (`engine.ts:6703-6706`)
  answered "newer", so `reconcileParkedProviderRetry` (`:6786-6788`) withdrew
  the retry. Cut 2 was never recovered; the same with a cut 3.
- Zero-time successor: inherited `providerWait.turnTs` 0; its cut 1, a pause
  and resume, a harness wake or a reply, real output, cut 2, all before the
  first recovery tick. The pause set `retryCancelled` (`engine.ts:10425`,
  `:6712-6717`). Revision 1 discharged only waits with `turnTs > 0`, so
  `recoverProviderCut` (`:2129-2132`) parked cut 2 on the inherited
  cancellation; without a pause, cut 2 inherited its predecessor's budget.

## The rule

**A stage attempt owes recovery for its open cut chain while the engine owns
the stage.**

- A *provider cut* is a native terminal provider-failure record of this
  attempt: the Claude assistant record flagged `isApiErrorMessage` with a
  terminal API error, or the Codex turn-end record carrying a provider failure.
  A turn the operator or a deploy aborted (`turn_aborted`) is not a provider
  cut. Records older than `attempt.startedAt` belong to an earlier attempt; the
  attempt start decides membership only and never anchors a window.
- *Agent output* is a record the agent authored after the provider accepted a
  turn. Claude: an `assistant` record that is not flagged `isApiErrorMessage`
  and whose model is not `<synthetic>`, carrying text, thinking or a tool call.
  Codex: `agent_message`, `agent_reasoning` / `reasoning`, an assistant
  `message`, a `*_call` response item (its output excluded), and an
  `item_completed` agent message or reasoning item.
- The *open cut chain* is the run of provider cuts after the attempt's last
  agent output. Its *first cut* is the cut record the rule measures from.
  Further cut records with no agent output between them belong to the same
  chain; each one refreshes the saved witness (`turnTs`, reset) and opens
  nothing new, and the chain keeps one try budget.
- The chain is **closed by agent output**: the stage is working again, because
  the engine's continuation took effect or because someone's prompt was worked
  on. The next cut after that output opens a new chain, owed by itself with a
  budget of its own.
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
- A **zero-time successor** (an attempt the engine relaunched on another
  account or host, whose inherited wait has `turnTs` 0) continues its
  predecessor's chain. That chain is open from the successor's start until the
  successor's first agent output; after it, the successor's next cut opens a
  chain of its own, and the inherited cancellation and budget go with the old
  one.
- The engine **owns** the stage while the lane runs, and while a parked lane
  holds a live stage retry. A parked retry **follows the chain**: once agent
  output closes the parked cut's chain, the retry holds while the stage's turn
  runs; a turn that ends in a new cut moves the retry to that chain, its reset
  and a fresh budget, and a turn that ends with no cut withdraws it, because
  nothing is owed.
- Close, report, retry-stage and skip-stage end ownership through pipeline and
  attempt state, as they do today. On a parked lane, pause and resume act
  through state as well: they withdraw the retry at once (`engine.ts:10425`).
  A withdrawn parked retry stays withdrawn (Deferred).
- The chain is read from the transcript on every tick. Nothing persisted
  anchors it, so a deleted wait, a restart or a missed clearing path cannot move
  it.

### Two cuts with no output between them are one item

The pinned outcome said "each provider cut is its own owed item". Read per cut
record, a transcript like this one would owe recovery for its second record:

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
which this lane's brief names among the cases the build must keep. The critique
of revision 1 put the question to the controller, and the controller decided on
2026-10-08 that the chain rule governs. A cut is its own owed item once agent
output separates it from the previous one, which is every round-10, round-12
and critique scenario.

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
the originating requirement, and the controller chose the chain.

**B. Persist the cleared cut's boundary** (round 12's proposed intent: when
verified work clears a saved wait, record a `"continue"`-like boundary and
anchor on it). Keeps a persisted anchor that every clearing path must write
(`engine.ts:5466`, `:5481-5484`, the external-prompt branch at `:5448-5467`)
and that must survive restarts. Read against the code, it would still park two
shapes the probes below cover: a reply, its answer and cut 2 all written
between two ticks (no clearing pass ran, so the saved wait still names cut 1),
and a reply whose answer is still busy at the tick (the head keeps the wait as
a cancelled witness until the turn ends, and a turn that ends in cut 2 parks on
it). It also leaves both critique shapes open: a parked retry and a zero-time
wait are never cleared by verified work. Rejected: it is the round-10 fix
extended by one more path, and the class lives in the paths.

**C. Derive the owed cut from the transcript: the open cut chain.** Chosen.
The reader already streams the whole transcript in physical order when a
recovery decision is pending (`readRecoveryWindow`, `durableEvidence.ts:350`).
Resetting its retained window on agent output yields the chain directly. The
reader also says whether the saved wait still belongs to the open chain, for a
saved cut and for a zero-time wait alike. The engine keeps its saved wait as
the witness and continuation key, and acts on that one answer on each path:
the running tick drops a wait outside the open chain, and a parked retry moves
to the open chain.

For the parked retry two narrower answers were weighed. Withdrawing the retry
on any operator prompt after the parked cut would make the outcome depend on
whether a tick lands between the reply and the agent's output, and it measures
from the parked cut where the rule measures from the open chain. Reopening a
parked lane to `running` when its stage works again would change what the
board shows without the operator, which the requirement does not ask for. Both
were rejected.

## What stays, what goes

Goes:

- `evidenceStartedAt` and the continuation anchor (`engine.ts:5411-5415`). The
  tick passes `attempt.startedAt`, which also restores report-prose reading
  from the attempt start (round 12, note 2).
- The requested-cut anchor in the reader: `cutTime ?? firstProviderCutAt`,
  `cutIndex`, `latestCutIndex` (`durableEvidence.ts:498-507`). `afterCutAt`
  stays as an argument with two jobs only: it requests coverage while a wait is
  saved, and it asks whether the saved wait is in the open chain.
- `automaticPromptBeforeProviderCut` (`durableEvidence.ts:42`, `:515-517`) and
  the matching message and prompt checks in `refreshHarnessProviderCut`
  (`engine.ts:6674-6676`). A newer cut in the same open chain with no external
  activity is a re-observed cut by definition.
- Window retention from the first cut at or after a boundary
  (`durableEvidence.ts:371-381`).
- The requirement that a requested cut be found before history counts as
  complete (`durableEvidence.ts:522-523`). A closed chain is dropped from the
  window, so its cut is legitimately absent.

Stays:

- `providerWait.turnTs` as the witness, the continuation key
  (`providerContinuationKey`) and the host-retirement fence
  (`hostRetirement.ts:44-55`).
- `retryCancelled`, `stageRetry`, `controlGeneration` and the
  `continuationAllowed` fence (`engine.ts:2282-2288`).
- The `providerRecoveries` journal, for the park reason and the legacy park
  upgrade. It anchors nothing.
- Prompt classification (`stagePrompts`), the full-scan trigger, the 8 MiB
  bound and the bounded "delivered prompt history is incomplete" transport
  wait.
- The pause/resume comparison at `engine.ts:5442-5446`, now against the chain's
  first cut.
- `newerExternalProviderPrompt`'s `prompts` fallback (`engine.ts:6656-6657`).
  It serves evidence that carries no chain fields: test doubles, and a closed
  chain on a running lane, where it keeps a stale wait marked cancelled until
  the turn ends or the next chain discharges it.
- The hostless legacy park (`engine.ts:6745`) keeps the attempt start as its
  bound: it has no cut record to measure from.
- The withdrawal of a parked retry by pause, resume, a control change, a
  report, close, retry-stage and skip-stage (`cancelProviderStageRetry` and its
  callers), unchanged.

## Build plan (smallest)

A prototype of exactly this plan ran in a scratch export of `52d7f9bd3`
(results below). Source change: 112 added and 52 removed lines in two files,
comments included.

### `src/lib/pipelines/durableEvidence.ts`

1. Add `agentOutput(record, codex)` with the definition above, and one chain
   tracker fed in physical order by both passes: agent output closes the chain,
   the next cut of this attempt opens one, and it records whether the requested
   position is still open. It replaces the cut test now written twice inline
   (`:371-375`, `:490-497`).
2. `readRecoveryWindow(pathname, codex, attemptStartedAt, requestedAt,
   fallbackTs, snapshot)`: agent output clears the retained records and the
   byte count; the first cut after it starts retention. A chain over 8 MiB
   keeps scanning (later agent output can still close it) and returns `null` at
   the end of the file only if that chain is still open. No open chain at the
   end returns an empty, complete window. The window returns the tracker's
   answer for the requested position.
3. Keep the coverage trigger as it is (a saved cut, or a terminal provider
   failure with a known attempt start) and pass the attempt start to the window
   for membership only.
4. Compute the open chain over the verified records (the complete tail or the
   window): `firstProviderCutAt` is its first cut, or `null`;
   `externalPromptAfterCut` and `automaticPromptAfterCut` describe prompts after
   it and are omitted when no chain is open. A new `requestedCutOpen` answers
   for the requested position: for `afterCutAt > 0`, the cut record with that
   time, open until agent output follows it; for `afterCutAt === 0`, the chain
   a zero-time successor inherited, open from the attempt start until the
   attempt's first agent output. It is omitted when the read cannot place the
   position; a partial tail can only report it closed. `promptHistoryComplete`
   becomes "the read is complete or the window was verified".
5. Use one timestamp rule for cut membership in both passes (the record's own
   time, the file time when it has none; the window uses a zero fallback
   today).

### `src/lib/pipelines/engine.ts`

1. Delete `evidenceStartedAt`; pass `attempt.startedAt` (`:5411-5416`). The
   call already passes `providerWait.turnTs`, which is 0 for a zero-time
   successor.
2. After the incomplete-history check (`:5438-5441`), discharge a saved wait
   outside the open chain, zero-time waits included:
   `providerWait && durable.requestedCutOpen === false && durable.firstProviderCutAt`
   deletes `providerWait` and `providerRecoveryBudget`, as the newer-output
   branch at `:5481-5484` does. The new cut then opens a fresh wait through
   `recoverProviderCut` with a fresh budget, and its `retryCancelled` check
   (`:2129`) no longer sees the old chain's cancellation. A successor with no
   output keeps its inherited wait, cancellation and budget.
3. `refreshHarnessProviderCut` (`:6669-6692`): replace the message and
   `automaticPromptBeforeProviderCut` checks with one test on
   `requestedCutOpen`. Absent: no refresh. `true`: refresh the witness as today.
   `false`, with a live `stageRetry` and an open chain: move the wait to the
   newer chain, setting its witness and its reset (or none), `tries` 0, deleting
   `providerRecoveryBudget`, and parking again through
   `parkProviderUsageLimit`, which reschedules the retry at that chain's reset
   with the current control generation. The external-prompt test before it is
   already measured from the open chain's first cut.
4. `providerCutActivity` (`:6694-6710`): before the external-prompt test, a
   saved wait outside the open chain with no newer cut open answers by the
   turn: busy → a new `"working"`, terminal → `"newer"`, otherwise
   `"unknown"`. A report or a verdict still answers `"newer"`.
5. `reconcileParkedProviderRetry`'s confirmation (`:6771-6784`): `"working"`
   holds the retry and spends nothing from the bounded confirmation wait; the
   other answers keep their branches. `relaunchCutStage` already treats any
   answer other than `"unchanged"` and `"newer"` as unavailable evidence (a
   bounded transport wait) and needs no edit.

Everything else in the provider path reads the same fields with the new
meaning and needs no edit: `newerExternalProviderPrompt`,
`newerAutomaticProviderPrompt`, `continuationAllowed`, the legacy upgrade in
`reconcileParkedProviderRetry`, `cancelProviderStageRetry`, the pause handler
and `providerRecoveryTurnProven`.

### Tests (failing first)

Engine seam, fake clock, real reader through `readFixtures`, both engines,
pinned and pool, in `src/lib/pipelines/engine.test.ts` beside "stage progress
makes the next provider cut own cancellation". Clock shape shared by all three
families: cut 1 at 17:22:09Z ("resets 10pm (Europe/Kyiv)", 19:00Z; Codex adds
a `token_count` with that reset); later cuts name "2am" (23:00Z), "3am"
(00:00Z) or "4am" (01:00Z). Pool mode allows two or three accounts.

**"a provider cut after agent output owes its own recovery"** (running lane,
32 cases): activity at 19:00:20Z, cut 2 at 21:30Z, ticks every 30 s to 23:05Z.
Pool mode resolves `exhausted` until the current reset.

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

**"a parked retry follows the open cut chain"** (32 cases): cut 1 parks with a
`stageRetry` (try budget spent; in pool mode every allowed account tried).
After the reset the host wakes at 19:00:20Z and the agent works at 19:00:25Z.

| Case | After the park | Expected |
| --- | --- | --- |
| harness | harness wake, agent output, cut 2 at 19:00:40Z, then the next tick | no spawn before 23:01, a fresh attempt after it |
| harness-three | as harness, then a harness wake, output and cut 3 ("3am") before the tick | no spawn before 00:01, a fresh attempt after it |
| harness-busy | harness wake, an open tool call; ticks while it runs, across cut 1's retry time, to 21:29Z; the turn ends in cut 2 at 21:30Z | no spawn before 23:01, a fresh attempt after it |
| operator-busy | as harness-busy, opened by an operator prompt | same |
| reply-after | as harness, tick; operator prompt one second after cut 2, refused | retry withdrawn, `needs_decision`, no spawn |
| control-after | as harness, tick; pause and resume one second after cut 2 | retry withdrawn, no spawn |
| harness-no-output | harness wake at 17:24:05Z refused half a second later, same reset | a fresh attempt after 19:01 |
| operator-refused | operator prompt at 17:24:05Z refused half a second later | retry withdrawn, no spawn |

**"a zero-time successor owes the chain its own output opened"** (26 cases):
cut 1 on the first account relaunches the stage (pool: at once on the spare;
pinned: on its own account at 19:01, the relaunch branch a pane-hosted stage
takes). The successor's
inherited wait has `turnTs` 0. Its own transcript, all written before its first
recovery tick: cut 1 ("2am"), the activity, agent output, cut 2 (pool at once;
pinned at 21:30Z, "3am").

| Case | Activity in the successor | Expected |
| --- | --- | --- |
| harness | harness wake before the output | cut 2 recovered (pool: relaunch on the third account; pinned: relaunch after 00:01) with a fresh budget (`tries` 1 on the next attempt) |
| operator | operator prompt before the output | same |
| pause-harness | pause and resume after cut 1, then harness wake | same |
| pause-operator | pause and resume after cut 1, then operator prompt | same |
| three | pause-harness, then harness wake, output, cut 3 before the tick | cut 3 recovered with a fresh budget |
| three-ticked (pinned) | pause-operator, output, cut 2, tick, harness wake, output, cut 3 ("4am"), tick | cut 3 recovered after 01:01 with a fresh budget |
| reply-after (pinned) | harness as above, tick; operator prompt after cut 2, refused | no relaunch, `needs_decision` |
| control-after (pinned) | harness as above, tick; pause and resume after cut 2 | no relaunch, `needs_decision` |

The existing "zero-time successor preserves its first cut across human /
operator-control / automatic activity" keeps the no-output side: there the
inherited chain stays open, and human or control activity cancels it.

Reader units in `durableEvidence.test.ts`, both engines:

- cut, operator prompt, agent output, later cut: `firstProviderCutAt` of the
  later cut, `externalPromptAfterCut: false`, `requestedCutOpen: false` for the
  first cut; cut, operator prompt, refused cut: the first cut,
  `externalPromptAfterCut: true`, `requestedCutOpen: true`.
- With `afterCutAt` 0: cut, prompt, cut gives `requestedCutOpen: true` and the
  first cut; cut, prompt, output, later cut gives `requestedCutOpen: false` and
  the later cut.
- Cut, prompt, output, 9.35 MiB of records, cut, operator prompt, cut: the
  verified window starts at the later cut (`firstProviderCutAt`,
  `externalPromptAfterCut: true`, complete history), reports the first cut
  closed and the last cut open.

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

All runs used `git archive` exports of `52d7f9bd3` under the stage's scratch
directory, a symlinked `node_modules` with the same lockfile, and the isolated
wrapper above, each run through `scripts/gate-slot.sh`. The worktree was not
edited. "Revision 1" is the plan of revision 1 of this document rebuilt in a
third export: discharge only for `turnTs > 0`, refresh only for
`requestedCutOpen === true`, no `"working"` answer.

| Run | Result |
| --- | --- |
| head, the 90 engine probe cases above | 54 fail, 36 pass |
| revision 1, the 90 probe cases | 38 fail (16 parked, 22 zero-time), 52 pass |
| revision 2, the 90 probe cases | 90 pass |
| revision 2, full `engine.test.ts` (1 012 existing + 90 probes) | 1 102 pass, 0 fail |
| revision 2, `durableEvidence.test.ts` + `hostRetirement.test.ts` with the expectation update and the six reader units | 138 pass |
| head reader, the same two files | 7 fail (the six units and the changed expectation), 131 pass |
| revision 2 `tsc --noEmit` | 0 errors |
| revision 2 eslint on the two source files and the reader test | 0 errors (4 warnings at `engine.ts:2589`, untouched code) |

What failed, by family:

- Running lane, head: the twenty owed cases, sixteen with "provider recovery
  cancelled after newer stage activity" and four with "…by operator control
  during the stage"; the twelve cancellation cases pass. Revision 1 passes all
  32.
- Parked retry, head: Codex harness and harness-three withdraw the retry
  ("automatic provider retry cancelled after newer stage activity");
  harness-busy withdraws it ten minutes after cut 1's retry time ("could not
  confirm unchanged cut evidence"); operator-busy withdraws it at the first
  tick. Claude harness and harness-three pass on head (see Notes). Revision 1
  withdraws all sixteen owed cases. The cancellation cases pass everywhere.
- Zero-time successor, head: harness recovers with the inherited budget
  (`tries` 2); operator parks "after newer stage activity"; every pause case
  parks "by operator control during the stage". Revision 1: harness and
  operator recover with the inherited budget, every pause case parks "by
  operator control" from `recoverProviderCut`, the critique's exact path.

## Rounds and existing tests mapped to the rule

Clauses: **R1** later cuts with no agent output between them are one chain,
measured from its first cut, with one budget; **R2** agent output closes a
chain and the next cut owes itself with its own budget; **R3** an external
prompt after the first cut cancels; **R4** pause or resume after the first cut
cancels, and on a parked lane they withdraw the retry at once; **R5** harness
wakes and engine continuations cancel nothing, and a re-observed cut refreshes
the witness; **R6** the window and the 8 MiB bound start at the first cut;
**R7** close, report, retry and skip end ownership through state; **R8** a
zero-time successor's inherited chain is open from its start until its first
agent output; **R9** a parked retry follows the chain: it holds while the stage
works after its cut, moves to a newer chain with that chain's reset and budget,
and is withdrawn when the turn ends with no cut.

Rounds and critique:

| Finding | Rule | Outcome under the rule |
| --- | --- | --- |
| Round 10 (a) reply answered, (b) pause/resume, (c) 9.5 MiB of work, all before cut 2 | R2, R6 | the continuation's work closed chain 1; cut 2 opens chain 2; the activity and the 9.5 MiB precede it; continued at 23:01 |
| Round 12 operator or orchestrator reply answered, then cut 2 | R2 | the answer closed chain 1; cut 2 owed; continued at 23:01 |
| Round 12 harness wake answered, pause/resume at 20:00, cut 2 | R2, R4 | the control precedes chain 2's first cut; continued at 23:01 |
| Same shapes, reply or control after cut 2 | R3, R4 | cancelled |
| Critique: parked cut 1, harness wake, output, cut 2 (or cut 3) | R2, R9 | the retry moves to the newer chain and runs after its reset |
| Critique: zero-time successor, cut 1, pause/resume, harness or reply, output, cut 2 (or cut 3) | R2, R8 | the inherited wait, its cancellation and its budget are discharged; cut 2 (cut 3) recovered with a fresh budget |

`engine.test.ts` (line numbers at `52d7f9bd3`). Every case stays with its
assertions unchanged.

| Line | Test | Shape | Rule |
| --- | --- | --- | --- |
| 22485 | stage progress makes the next provider cut own cancellation (reply-before, control-before, large-work, reply-after, control-after) | continuation, agent output, then activity before or after cut 2 | R2; R6 for large-work (9.35 MiB precede chain 2); R3/R4 for the after cases. Passes with the continuation anchor deleted |
| 22066 | first recovery tick respects a prior operator / pipeline / initial / harness prompt (large tail) | cut, prompt, cut, first look | R1: one chain from cut 1. Operator cancels (R3); pipeline and harness do not (R5); initial lies before cut 1 |
| 22127 | first recovery tick respects pause and resume after-cut / before-cut | one cut | R4 |
| 22280 | backdated context after a large native record retains human cancellation (first-tick, running, parked) | cut, human, 150 KB, backdated row, cut | R1, R3; R6 physical order; parked: the chain is open, so R3 withdraws |
| 22395 | zero-time successor preserves its first cut across human / operator-control / automatic activity | successor transcript: cut, prompt or control, cut; no agent output | R1, R8: the inherited chain stays open (`requestedCutOpen: true` for 0), nothing is discharged; human and control cancel, automatic recovers |
| 21853 | a quota reply remains external through image / large-tail / human-before-harness evidence | cut, reply, cut | R1, R3 |
| 21714 | running / pinned-park / pool-park quota cut distinguishes a newer operator / task-notification / scheduled turn | cut, prompt, cut | R1; R3 for operator, including the parked modes (the chain is still open); R5 refresh for harness |
| 21758 | quota continuation trusts delivered pipeline / startup-recovery / operator authorship | cut, continuation, cut | R1; R5 or R3 by authorship |
| 22199 | native Codex shapes: operator / pipeline / startup-recovery authorship controls quota recovery (parked) | cut, prompt, cut | R1; R3 or R5 |
| 22239 | Claude modes and wrappers: native-human / ledger-human / harness authorship controls quota recovery | cut, prompt, cut | R1; R3 or R5 |
| 22445 | an accepted continuation retains recovery after proved / human / unknown execution refusal | human: cut, reply, cut | R1, R3 |
| 22347 | legacy quota upgrade respects operator control (before-cut, after-cut, after-later-cut, hostless, human-before-later-cut) | parked legacy chain | R1, R3, R4 on the chain's first cut; hostless keeps the attempt start |
| 21805 | parked harness quota notice persists its named 10pm / 11pm reset (pool) | cut, task notification, cut | R1, R5 refresh: no output, so the same chain |
| 21902 | parked retry retains a delivered pipeline / startup-recovery continuation | cut, continuation, cut | R1, R5 |
| 21967 | running / parked quota wait retains a human prompt removed by shutdown normalization | cut, typed prompt, interrupt, `<synthetic>` no-op | R3; the `<synthetic>` record is not agent output |
| 19307 | a newer native operator turn cancels running reset continuation (tool) | cut saved, reply, tool call | R3; with the tool call the chain is closed and no newer chain is open, so the running lane keeps the stale wait marked cancelled until the turn ends |
| 19710 | an operator reply ending on a newer native provider-notice / empty-completion cancels the old quota retry | cut, reply, cut or clean completion without output | R1, R3 |
| 19645 | operator close / pause / pause-resume / reply / report / retry-stage / skip-stage cancels a parked quota retry | parked | R3 (test-double evidence without chain fields), R4 through state, R7 |
| 19496 | cancelled quota retry withdraws its card promise after pause-resume / report | parked | R4, R7 |
| 19584 | an exhausted provider limit retries the stage after its native reset across a Viewer restart (none / failed / delivered / pending) | parked, held delivery | unchanged cut; the bounded confirmation wait still applies to everything except `"working"` |
| 19695, 21474, 21516 | reply while termination is confirmed; reply before a far-future reset; reply during fresh target termination | test-double evidence | R3 through the `prompts` fallback |
| 21947, 22044 | reply racing continuation admission; capacity relaunch rechecks operator input | test-double evidence | R3 through the `prompts` fallback |
| 21992 | pause and resume withdraws a running provider reset obligation | saved wait, pause, resume | R4 |
| 19910 | a report wins over a terminal limit | report | R7 |
| 21879, 22106 | prompt history over the read bound; first recovery tick bounds incomplete prompt history | 9 MiB inside one chain | R6 |
| 22307 | large historical prefix permits named reset recovery (parked) | 9.35 MiB before the chain | R6 |
| 20081, 20418 | unknown resets keep the three-continuation bound; mixed provider cuts keep expenditure until progress | repeated cuts, no output (test doubles) | R1: one chain keeps one budget |
| 20098 | a busy resumed turn retires the old unknown-reset wait (assistant progress) | test double | R2 |
| 19035, 19064 | Codex unavailable prompt metadata lets both lanes settle; cancels a parked quota retry | reply answered; cut, reply, cut | R2 settles; R3 for the parked retry (the chain is open) |
| 19109, 19176, 19437, 19731, 20167, 20208, 20245, 20272, 20802, 21426, 21662 and the remaining provider cases | single cut per transcript: selection, resets and time zones, budgets, restart, delivery fences, host stops, card text | one chain, so every anchor agrees | unaffected |

`durableEvidence.test.ts`: "prompt order survives clock skew" (705, R1 physical
order), "backdated context cannot hide a human reply" (722, R1, R6), "first
provider cut follows native order when timestamps run backward" (738, R1),
"large historical prefix preserves a recent named cut" (780, R6), "large
relevant history with backdated rows remains incomplete" (806, R1, R6) stay
unchanged. "Codex unavailable prompt metadata stays external" (22) changes as
described in the build plan. `hostRetirement.test.ts` is unaffected: a proven
retirement requires the transcript to end in the saved cut, which is in the
open chain by construction, and a parked retry that moved writes the newer cut
into the fence it hands over.

## Validation against the originating requirement

- *Resumes by itself after the reset*: a cut after agent output is owed whatever
  happened before it (rounds 10 and 12), on both engines, pinned and pooled,
  on a running lane, on a parked lane whose stage worked again, and in a
  zero-time successor.
- *Never resumes a lane the operator closed, paused or answered meanwhile*:
  "meanwhile" is the time since the chain's first cut. A reply, a pause or a
  resume in that time cancels, including a reply the provider refused at once.
  On a parked lane, a pause or a resume withdraws the retry at once.
- *Survives a Viewer restart*: the chain comes from the transcript, so a
  restarted Viewer derives the same owed cut with no persisted anchor. A parked
  retry that moved is persisted like any park.
- *Same attempt semantics as `retry-stage`*: unchanged (parked retries still go
  through `reconcileParkedProviderRetry`, and a moved retry creates the same
  fresh attempt at its new reset).

## Deferred — not currently justified

- **A parked lane whose retry was already withdrawn, followed by new agent work
  and a later cut.** The retry was withdrawn by a pause, a resume, a control
  change, an operator prompt while the parked chain was still open, a turn that
  ended with no cut, or an expired confirmation; the card says so and the
  operator holds the lane. A later cut in that conversation is not upgraded
  into a new retry. Revision 2 covers the shape the critique found, where the
  retry was still live when the stage worked again (R9). No incident shows the
  withdrawn shape.
- **Moving the wait inside a pool relaunch.** `relaunchCutStage` confirms the
  cut twice around an idle-only host stop, inside the tick that has already
  discharged a closed wait; a newer chain cannot form between those reads
  without a turn on an idle host. It keeps answering such a change as newer
  activity.
- **Avoiding the whole-file scan on every waiting tick** (round 10, note 4:
  100–240 ms on 8–30 MiB transcripts). A tail that holds agent output before the
  chain's first cut proves the chain's start and could skip the scan. It saves
  time and changes no outcome.
- **Dropping the 8 MiB retention** by summarizing the chain while streaming.
  The approved rule keeps the bound.
- **Treating an operator prompt refused before any earlier cut as a
  cancellation.** The rule measures from the chain's first cut; the base, the
  head and the reply-before case (both engines) resume there. Revisit only if
  the operator asks for it.
- **Removing the `prompts` fallback** in `newerExternalProviderPrompt`. Test
  doubles depend on it, and for a closed chain on a running lane it has no
  effect beyond the witness.

## Notes

- No earlier solution existed: transcript and memory searches for the anchor
  question, the parked retry and the zero-time successor returned only lane
  499d73d9's rounds and this lane's own critique.
- Revision 1 claimed that `retryCancelled` on a wait from a closed chain is
  harmless because the discharge step removes that wait before the next chain
  is judged. That held only for waits with `turnTs > 0`. In revision 2 the
  discharge covers zero-time waits too, and a parked retry moves to the newer
  chain through the refresh.
- Claude parked harness and harness-three pass on head by accident: the head's
  refresh compares the last assistant message, which for Claude is the
  synthetic limit notice, so it never sees the agent's output and treats cut 2
  as a re-observed cut 1. The same transcript from Codex reports the agent
  message and withdraws the retry.
- The reader units in the build replace the probe names used in the prototype;
  the case lists above are the ones the prototype ran.
