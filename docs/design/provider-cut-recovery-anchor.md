# Provider-cut recovery: the cut a stage still owes

Status: design for PR #2537 (lane d2d49fe8, branch of lane 499d73d9), revision
3 of 2026-10-08. The controller approved the chain rule. Revision 2 added the
parked retry and the zero-time successor after the critique of revision 1;
this revision answers the critique of revision 2: a parked retry moves to a new
chain with that chain's own kind, reset and budget, whatever kind the parked
cut had, and the closed chain's confirmation wait is cleared.
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

The critiques of revisions 1 and 2 found four more such paths in this
document's own plans. In each, a new chain inherited state an old chain left
behind: a parked retry read any newer record as cancelling activity; a zero-time successor's inherited wait kept its predecessor's
cancellation and budget; a parked retry moved only between two quota cuts; and
the parked chain's confirmation wait kept its clock across hours of work. All
four are covered below.

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

### Critique of revision 2 (two P2, 2026-10-08)

- A new chain of another cut kind lost its retry. Revision 2 moved a parked
  retry inside `refreshHarnessProviderCut`, which keeps its two `usage_limit`
  guards (`engine.ts:6672`, `:6677`): the saved wait and the new cut both had
  to be quota cuts. A successor parked on a capacity cut until its source's
  reset (the shape of "successor capacity cut retains the source reset retry",
  `engine.test.ts:19176`), then a harness wake, real output and a quota cut on
  the successor, all before the next tick: the refresh refused,
  `providerCutActivity` answered "newer" (`:6703-6706`) and the retry was
  withdrawn (`:6786-6788`). The reverse (quota, output, capacity or overloaded)
  failed the second guard, and so did a third cut of another kind.
- The parked chain's confirmation wait kept aging. Cut 1 parked with reset
  19:00; at 19:01 a harness prompt is written and its answer is not, so the
  confirmation at the retry time opens `attempt.controllerWait` with
  `startedAt` 19:01; at 19:01:30 the agent works until 21:30, when cut 2 names
  23:00. Revision 2 moved the retry and left that `controllerWait`. At 23:01 a
  held delivery is outstanding for thirty seconds; the first confirmation books
  a round on the 19:01 wait, `nextBoundedWait` (`engine.ts:7173-7194`) finds
  four hours spent of its ten minutes, and the retry is withdrawn ("could not
  confirm unchanged cut evidence") before the delivery clears. Revision 2 had
  only skipped booking while the stage worked.

## The rule

**A stage attempt owes recovery for its open cut chain while the engine owns
the stage.**

- A *provider cut* is a native terminal provider-failure record of this
  attempt: the Claude assistant record flagged `isApiErrorMessage` with a
  terminal API error, or the Codex turn-end record carrying a provider failure.
  A turn the operator or a deploy aborted (`turn_aborted`) is not a provider
  cut. Its *kind* is the condition `classifyProviderCondition` gives it: a
  quota cut (`usage_limit`), a capacity or other transient cut, an
  authentication cut, or an unclassified provider error. Records older than
  `attempt.startedAt` belong to an earlier attempt; the attempt start decides
  membership only and never anchors a window.
- *Agent output* is a record the agent authored after the provider accepted a
  turn. Claude: an `assistant` record that is not flagged `isApiErrorMessage`
  and whose model is not `<synthetic>`, carrying text, thinking or a tool call.
  Codex: `agent_message`, `agent_reasoning` / `reasoning`, an assistant
  `message`, a `*_call` response item (its output excluded), and an
  `item_completed` agent message or reasoning item.
- The *open cut chain* is the run of provider cuts after the attempt's last
  agent output. Its *first cut* is the cut record the rule measures from.
  Further cut records with no agent output between them belong to the same
  chain, whatever their kind; each one refreshes the saved witness (`turnTs`,
  and the reset when a quota chain meets a quota record) and opens nothing new,
  and the chain keeps one try budget.
- The chain is **closed by agent output**: the stage is working again, because
  the engine's continuation took effect or because someone's prompt was worked
  on. The next cut after that output opens a new chain, owed by itself with a
  budget of its own and the recovery its own kind calls for.
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
- **Nothing a closed chain left behind binds the next one**: its saved wait,
  its budget, its cancellation flag and its bounded confirmation wait
  (`controllerWait`) all go when agent output closes it.
- The engine **owns** the stage while the lane runs, and while a parked lane
  holds a live stage retry. A parked retry **follows the chain**:
  - a further cut in the parked chain keeps the retry and refreshes the
    witness; a quota record in a quota chain also refreshes the reset and the
    retry time, as at the head;
  - once agent output closes the parked chain, the retry holds while the
    stage's turn runs, and spends nothing from the bounded confirmation wait;
  - a turn that ends in a new cut moves the retry to the new chain: the wait
    the running tick would open for that cut (its kind, its reset, its account,
    a fresh budget), parked at that kind's own retry time. A quota cut retries
    at the earliest allowed reset, or after the bounded 30-minute fallback when
    none is named; a capacity or other transient cut retries after the running
    path's first backoff, one minute. Either retry is a fresh attempt, as at a
    quota reset;
  - a new chain cut by authentication or by an unclassified provider error
    withdraws the retry (Deferred): the running path answers the first with an
    account choice and parks the second;
  - a turn that ends with no cut withdraws the retry, because nothing is owed.
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

For the parked retry three narrower answers were weighed. Withdrawing the
retry on any operator prompt after the parked cut would make the outcome
depend on whether a tick lands between the reply and the agent's output, and
it measures from the parked cut where the rule measures from the open chain.
Reopening a parked lane to `running` when its stage works again would change
what the board shows without the operator, which the requirement does not ask
for. Dropping the quota guards from the refresh, so that it moves the retry
for every kind, would let one function both refresh a chain's witness and
replace its condition, reset and budget; those guards are what keep a
same-chain record from rewriting a chain's reset. All three were rejected, as
the revision-2 critique asked: the move is a step of its own that opens the new
chain's wait with the constructor the running tick already uses, so the new
chain gets the same condition, reset, account and budget it would get on a
running lane.

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
- The refresh's `usage_limit` guards as a gate on a parked lane
  (`engine.ts:6672`, `:6677`). They stay as the gate on the reset refresh, and
  on a running lane, where `relaunchCutStage` is the only caller.

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
- The parked retry's validity guard (`engine.ts:6756-6763`), unchanged: a moved
  quota retry is a quota retry, and a moved capacity retry carries
  `fallback: false`, the form the guard already admits for transient waits.
- The ten-minute confirmation budget (`SPAWN_HOST_WAIT_BUDGET_MS`) and
  `nextBoundedWait`, unchanged. Each chain gets its own.

## Build plan (smallest)

A prototype of exactly this plan ran in a scratch export of `52d7f9bd3`
(results below). Source change against the head: 192 added and 97 removed lines
in two files, comments included; about thirty of each are the wait constructor
moving out of `recoverProviderCut` unchanged.

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
3. Two extractions, moved unchanged so both paths share them:
   `providerCutNotice(engine, message)`, the notice the running tick builds
   from a terminal provider message (`:5432-5436`), and
   `openProviderWait(stage, attempt, notice, ports)`, the wait a new cut opens
   in `recoverProviderCut` (`:2134-2164`: account, budget, reset, delay,
   `failedAccounts`, the usage-limited entry, the `"wait"` journal record and
   `delete attempt.controllerWait`). `recoverProviderCut` calls it and
   persists.
4. `refreshHarnessProviderCut` (`:6669-6692`) refreshes the same open chain
   only: `requestedCutOpen === true` replaces the message and
   `automaticPromptBeforeProviderCut` checks. On a parked lane any newer record
   of the chain moves the witness (`turnTs`, text) and keeps the retry; the
   reset, the usage-limited entry and the retry time are refreshed only when a
   quota chain meets a quota record, as at the head. On a running lane it stays
   quota-only.
5. New `moveParkedProviderRetry`: with a live `stageRetry`,
   `requestedCutOpen === false`, an open chain (`firstProviderCutAt`), and a
   terminal cut newer than the witness, classify that cut. For a quota or a
   transient cut, delete the wait and `providerRecoveryBudget`, open the new
   chain's wait through `openProviderWait` (fresh budget, `tries` 0), record a
   `"park"` with "stage cut by <kind>; last: <text>", and park through
   `parkProviderUsageLimit`: a quota cut as today (earliest allowed reset, or
   the bounded fallback), a transient cut with `retryAt` set to the new wait's
   own `resumeAt` (one minute) and `fallback: false`. Any other kind returns
   false, and the retry is withdrawn as newer activity.
6. `parkProviderUsageLimit` (`:1964`, `:1973`) takes an optional `fallback`;
   the backoff retry passes `false`, because it names its own time. That keeps
   the moved capacity retry inside the guard at `:6760-6762` and gives its
   fresh attempt a replenished budget at `:6826-6836`, as a named reset does.
7. `providerCutActivity` (`:6694-6710`), in order: incomplete history answers
   `"unknown"`; when the saved wait is outside the open chain and the lane is
   parked, delete `attempt.controllerWait` and persist; with no newer chain
   open, answer by the turn (busy → a new `"working"`, terminal → `"newer"`,
   otherwise `"unknown"`); the external-prompt test, measured from the open
   chain's first cut; then the move, or else the same-chain refresh; the final
   comparisons read the wait the attempt holds after them. A report or a
   verdict still answers `"newer"`.
8. `reconcileParkedProviderRetry`: `"working"` holds the retry and spends
   nothing from the bounded confirmation wait (`:6771-6784`). After each
   `providerCutActivity` call, a retry that moved returns at once
   (`attempt.providerWait !== wait`, `:6772` and `:6790`): the rest of the pass
   holds the old wait's `resumeAt` and `turnTs`, and the next pass judges the
   moved retry on its own. `relaunchCutStage` already treats any answer other
   than `"unchanged"` and `"newer"` as unavailable evidence (a bounded transport
   wait) and needs no edit.

Everything else in the provider path reads the same fields with the new
meaning and needs no edit: `newerExternalProviderPrompt`,
`newerAutomaticProviderPrompt`, `continuationAllowed`, the legacy upgrade in
`reconcileParkedProviderRetry`, `cancelProviderStageRetry`, the pause handler
and `providerRecoveryTurnProven`.

### Tests (failing first)

Engine seam, fake clock, real reader through `readFixtures`, both engines,
pinned and pool, in `src/lib/pipelines/engine.test.ts` beside "stage progress
makes the next provider cut own cancellation". Clock shape shared by all
families: cut 1 at 17:22:09Z ("resets 10pm (Europe/Kyiv)", 19:00Z; Codex adds
a `token_count` with that reset); later cuts name "2am" (23:00Z), "3am"
(00:00Z) or "4am" (01:00Z). Pool mode allows two or three accounts. A capacity
cut is the Claude `overloaded` API-error record or the Codex `task_complete`
with "Selected model is at capacity" (`server_overloaded`); an authentication
cut is "OAuth session expired and could not be refreshed".

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

**"a parked retry moves to a newer chain of another kind"** (28 cases).
Source-kind cases run in pool mode only: a pinned lane never holds a parked
retry for a non-quota cut, because `providerRetryReset` excludes the cut's own
account for such a cut and a pinned lane has no other. In them, cut 1 on the
first account relaunches the stage on the spare at once; the spare's budget is
spent and its capacity or authentication cut at 17:23Z parks it with a retry at
the first account's reset (19:01, `fallback: false`).

| Case | After the park | Expected |
| --- | --- | --- |
| capacity-then-quota (pool) | the spare's harness wake at 17:30Z, output, its quota cut at 17:40Z ("2am"), tick | the retry moves: quota, the spare's account, still due at 19:01 (the earliest allowed reset); a fresh attempt on the first account after 19:01, the spare excluded |
| auth-then-quota (pool) | as above after an authentication cut | same |
| quota-then-capacity | quota park; harness wake at 19:00:20Z, output, capacity cut at 19:00:40Z, tick | the retry moves: transient, due one minute after the tick, `fallback: false`; a fresh attempt then |
| quota-quota-capacity | as above, with a quota cut ("2am"), harness wake and output before the capacity cut | same |
| capacity-reply-after | quota-then-capacity, tick; operator prompt after the capacity cut, refused by capacity | retry withdrawn, `needs_decision`, no spawn |
| capacity-control-after | quota-then-capacity, tick; pause and resume | retry withdrawn, no spawn |
| same-chain-capacity | quota park; harness wake at 19:00:20Z refused by capacity at once, no output, tick | the retry stays due at 19:01 with the newer witness; a fresh attempt then |
| same-chain-capacity-reply | quota park; operator prompt at 19:00:20Z refused by capacity, no output, tick | retry withdrawn, no spawn |

**"a moved retry starts its own confirmation wait"** (16 cases): cut 1 parks
as in the parked family. At 19:00:58Z a harness prompt is written with no
answer; the tick at 19:01:00Z opens the confirmation wait (`controllerWait`
starting 19:01:00Z, asserted). At 19:01:30Z the agent opens a tool call and
works, ticks every ten minutes to 21:29Z; at 21:30Z the turn ends in cut 2
("2am"), tick: the retry is due at 23:01.

| Case | At the retry time | Expected |
| --- | --- | --- |
| held-fails | a held delivery is outstanding at 23:01:00Z and gone thirty seconds later | the retry holds, then a fresh attempt |
| held-lasting | the delivery stays outstanding | still live with no spawn at 23:06; withdrawn ("could not confirm unchanged cut evidence") only after the new chain's own ten minutes; no spawn |
| held-reply | the held delivery lands as an operator prompt at 23:01:15Z, refused | retry withdrawn, no spawn |
| three-held-fails | as held-fails, with a harness wake, output and cut 3 ("3am") after cut 2, before the tick | the retry holds at 00:01, then a fresh attempt |

**"a zero-time successor owes the chain its own output opened"** (26 cases):
cut 1 on the first account relaunches the stage (pool: at once on the spare;
pinned: on its own account at 19:01, the relaunch branch a pane-hosted stage
takes). The successor's inherited wait has `turnTs` 0. Its own transcript, all
written before its first recovery tick: cut 1 ("2am"), the activity, agent
output, cut 2 (pool at once; pinned at 21:30Z, "3am").

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
wrapper above, each run through `scripts/gate-slot.sh`. Product source in the
worktree was not edited. Revision 2's prototype was rebuilt by replaying its recorded edits
into a fresh export; it reproduced its recorded diff (112 added, 52 removed)
and its 90 of 90 probe passes before revision 3 was applied on top of it.

| Run | Result |
| --- | --- |
| head, all 134 probes | 94 fail (54 of the 90 earlier probes, as in revision 2's run, and 40 of the 44 new), 40 pass |
| revision 2, the 90 earlier probes, rebuilt | 90 pass |
| revision 2, the 44 probes added in revision 3 | 36 fail, 8 pass |
| revision 3, all 134 probes | 134 pass |
| revision 3, full `engine.test.ts` (1 012 existing + 134 probes) | 1 146 pass, 0 fail |
| revision 3, `durableEvidence.test.ts` + `hostRetirement.test.ts` with the expectation update and the six reader units | 138 pass |
| revision 3 `tsc --noEmit` | 0 errors |
| revision 3 eslint on the two source files and the reader test | 0 errors (4 warnings at head `engine.ts:2589`, untouched code) |

What failed, by family:

- Running lane, head: the twenty owed cases, sixteen with "provider recovery
  cancelled after newer stage activity" and four with "…by operator control
  during the stage"; the twelve cancellation cases pass. Revisions 1 to 3 pass
  all 32.
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
- Newer chain of another kind, head and revision 2: every owed case withdraws
  the retry at the tick after the newer cut, and the saved wait keeps the old
  chain's kind (a capacity wait after a quota cut, a quota wait after a
  capacity cut). The four same-chain-capacity cases withdraw it as well. The
  reply-after and control-after cases end withdrawn on every revision and fail
  on head and revision 2 only at the assertion that the retry moved first. The
  four same-chain-capacity-reply cases pass everywhere.
- Confirmation wait, revision 2: every held-fails, held-lasting and
  three-held-fails case is withdrawn at the retry time itself (23:01:00Z,
  00:01:00Z for three) with "automatic provider retry could not confirm
  unchanged cut evidence", the critique's exact path; held-reply ends
  withdrawn on every revision. On head all sixteen fail earlier: the retry is
  withdrawn while the stage works, before cut 2 ("could not confirm unchanged
  cut evidence"), as in the parked family's harness-busy case.

## Rounds and existing tests mapped to the rule

Clauses: **R1** later cuts with no agent output between them are one chain,
measured from its first cut, with one budget; **R2** agent output closes a
chain and the next cut owes itself with its own budget and its own kind's
recovery; **R3** an external prompt after the first cut cancels; **R4** pause
or resume after the first cut cancels, and on a parked lane they withdraw the
retry at once; **R5** harness wakes and engine continuations cancel nothing,
and a re-observed cut refreshes the witness; **R6** the window and the 8 MiB
bound start at the first cut; **R7** close, report, retry and skip end
ownership through state; **R8** a zero-time successor's inherited chain is open
from its start until its first agent output; **R9** a parked retry follows the
chain: it holds while the stage works after its cut, moves to a newer chain
with that chain's kind, reset and budget, and is withdrawn when the turn ends
with no cut or in a kind with no timed retry; **R10** nothing a closed chain
left behind (wait, budget, cancellation, confirmation wait) binds the next.

Rounds and critiques:

| Finding | Rule | Outcome under the rule |
| --- | --- | --- |
| Round 10 (a) reply answered, (b) pause/resume, (c) 9.5 MiB of work, all before cut 2 | R2, R6 | the continuation's work closed chain 1; cut 2 opens chain 2; the activity and the 9.5 MiB precede it; continued at 23:01 |
| Round 12 operator or orchestrator reply answered, then cut 2 | R2 | the answer closed chain 1; cut 2 owed; continued at 23:01 |
| Round 12 harness wake answered, pause/resume at 20:00, cut 2 | R2, R4 | the control precedes chain 2's first cut; continued at 23:01 |
| Same shapes, reply or control after cut 2 | R3, R4 | cancelled |
| Critique 1: parked cut 1, harness wake, output, cut 2 (or cut 3) | R2, R9 | the retry moves to the newer chain and runs after its reset |
| Critique 1: zero-time successor, cut 1, pause/resume, harness or reply, output, cut 2 (or cut 3) | R2, R8, R10 | the inherited wait, its cancellation and its budget are discharged; cut 2 (cut 3) recovered with a fresh budget |
| Critique 2: parked capacity or authentication cut, output, quota cut (and the reverse, and a third cut of another kind) | R2, R9 | the move opens the new chain's own wait; quota retries at the earliest allowed reset, capacity after one minute |
| Critique 2: unknown confirmation at 19:01, hours of work, cut 2, a held delivery at 23:01 | R9, R10 | the 19:01 wait went with chain 1; 23:01 starts its own ten minutes; a short hold resumes, a lasting one still withdraws, a delivered reply cancels |
| Build review 2: running lane, continuation refused at 19:01, output, cut 2 over the read bound at 21:30 | R10 | the 19:01 wait went with chain 1; chain 2 starts its own ten minutes at its own cut |

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
| 19176 | successor auth / auth-window / capacity cut retains the source reset retry | test doubles: a non-quota park until the source's reset, no later cut | unchanged; the revision-3 family starts from this park and adds the output and the newer cut |
| 19307 | a newer native operator turn cancels running reset continuation (tool) | cut saved, reply, tool call | R3; with the tool call the chain is closed and no newer chain is open, so the running lane keeps the stale wait marked cancelled until the turn ends |
| 19710 | an operator reply ending on a newer native provider-notice / empty-completion cancels the old quota retry | cut, reply, cut or clean completion without output | R1, R3 |
| 19645 | operator close / pause / pause-resume / reply / report / retry-stage / skip-stage cancels a parked quota retry | parked | R3 (test-double evidence without chain fields), R4 through state, R7 |
| 19496 | cancelled quota retry withdraws its card promise after pause-resume / report | parked | R4, R7 |
| 19584 | an exhausted provider limit retries the stage after its native reset across a Viewer restart (none / failed / delivered / pending) | parked, held delivery | unchanged cut; the bounded confirmation wait still applies to everything except `"working"`, and starts with that chain |
| 19695, 21474, 21516 | reply while termination is confirmed; reply before a far-future reset; reply during fresh target termination | test-double evidence | R3 through the `prompts` fallback |
| 21947, 22044 | reply racing continuation admission; capacity relaunch rechecks operator input | test-double evidence | R3 through the `prompts` fallback |
| 21992 | pause and resume withdraws a running provider reset obligation | saved wait, pause, resume | R4 |
| 19910 | a report wins over a terminal limit | report | R7 |
| 21879, 22106 | prompt history over the read bound; first recovery tick bounds incomplete prompt history | 9 MiB inside one chain | R6 |
| 22307 | large historical prefix permits named reset recovery (parked) | 9.35 MiB before the chain | R6 |
| 20081, 20418 | unknown resets keep the three-continuation bound; mixed provider cuts keep expenditure until progress | repeated cuts, no output (test doubles, running lane) | R1: one chain keeps one budget |
| 20098 | a busy resumed turn retires the old unknown-reset wait (assistant progress) | test double | R2 |
| 19035, 19064 | Codex unavailable prompt metadata lets both lanes settle; cancels a parked quota retry | reply answered; cut, reply, cut | R2 settles; R3 for the parked retry (the chain is open) |
| 19109, 19437, 19731, 20167, 20208, 20245, 20272, 20802, 21426, 21662 and the remaining provider cases | single cut per transcript: selection, resets and time zones, budgets, restart, delivery fences, host stops, card text | one chain, so every anchor agrees | unaffected |

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
  zero-time successor. On a parked lane the new chain's own kind decides when:
  its reset, or a one-minute backoff for capacity.
- *Moves to another allowed account*: a moved quota retry runs at the earliest
  reset among the allowed accounts, and its fresh attempt's admission excludes
  the account the new chain cut (the capacity-then-quota and auth-then-quota
  cases).
- *Never resumes a lane the operator closed, paused or answered meanwhile*:
  "meanwhile" is the time since the chain's first cut. A reply, a pause or a
  resume in that time cancels, including a reply the provider refused at once.
  On a parked lane, a pause or a resume withdraws the retry at once.
- *Survives a Viewer restart*: the chain comes from the transcript, so a
  restarted Viewer derives the same owed cut with no persisted anchor. A parked
  retry that moved is persisted like any park, and the cleared confirmation
  wait is persisted with it.
- *Same attempt semantics as `retry-stage`*: unchanged (parked retries still go
  through `reconcileParkedProviderRetry`, and a moved retry creates the same
  fresh attempt at its new time).

## Deferred — not currently justified

- **A parked lane whose retry was already withdrawn, followed by new agent work
  and a later cut.** The retry was withdrawn by a pause, a resume, a control
  change, an operator prompt while the parked chain was still open, a turn that
  ended with no cut, or an expired confirmation; the card says so and the
  operator holds the lane. A later cut in that conversation is not upgraded
  into a new retry. Revisions 2 and 3 cover the shape the critiques found,
  where the retry was still live when the stage worked again (R9). No incident
  shows the withdrawn shape.
- **A parked lane's new chain cut by authentication or by an unclassified
  provider error.** It withdraws the retry. On a running lane an unclassified
  error parks, and an authentication cut moves to an untried allowed account,
  retries at another allowed account's known reset, or parks. Carrying that
  account choice into the parked path adds account selection there for a cut
  the requirement does not name (it names limits), and no incident shows the
  shape.
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
  question, the parked retry, the zero-time successor, the cut-kind move and
  the stale confirmation wait returned only lane 499d73d9's rounds and this
  lane's own critiques.
- Revision 1 claimed that `retryCancelled` on a wait from a closed chain is
  harmless because the discharge step removes that wait before the next chain
  is judged. That held only for waits with `turnTs > 0`. In revision 2 the
  discharge covers zero-time waits too, and a parked retry moves to the newer
  chain.
- Revision 2 put the move inside the quota refresh, so it inherited that
  function's quota guards, and it skipped booking the confirmation wait while
  the stage worked without clearing the wait it already had. Revision 3 makes
  the move its own step and clears that wait with the chain.
- Claude parked harness and harness-three pass on head by accident: the head's
  refresh compares the last assistant message, which for Claude is the
  synthetic limit notice, so it never sees the agent's output and treats cut 2
  as a re-observed cut 1. The same transcript from Codex reports the agent
  message and withdraws the retry.
- The reader units in the build replace the probe names used in the prototype;
  the case lists above are the ones the prototype ran.

## Build notes

The build landed the prototype's source change unchanged (192 added, 97
removed) with its 134 engine cases and the reader units under the family names
above. Before the source change, 94 of the 134 engine cases and 7 reader cases
failed; after it, all pass. The merge of `origin/main` (base `ff4af9a38`) met
four changes on main and settled them as follows:

- **Evidence floor.** Main measures a stage attempt from
  `attemptEvidenceFloor(attempt)`, which moves past `attempt.startedAt` when a
  runtime switch continues the attempt (#2511). The tick, the continuation
  fence and `providerCutActivity` pass that floor to the reader, so chain
  membership starts there.
- **Closed Claude API errors.** Main reads a Claude API-error record stamped
  with a closing stop reason as the end of a stage attempt
  (`claudeApiErrorClosedAttempt`). The chain tracker counts the same record as
  a cut, so the reader and the tick agree on which records cut the stage.
- **One snapshot.** The reader returns no evidence when the transcript changed
  between its reads only for a recovery read (a requested cut, or a provider
  cut with a known attempt start). Other reads keep main's behaviour.
- **Account failover.** Main's #2511 reseated a Codex conversation onto the
  next allowed account from the provider path. This branch binds the target
  with a fresh host for both engines, because a review of lane 499d73d9 found
  an incident where a reseat request was followed by a continuation on the
  source account. Main's account-policy fences stay: the pool filter on the
  selected target, and the wait while a persisted migration or reseat target is
  no longer allowed. Main's two Codex reseat cases now assert the fresh launch
  and the fence.

## Review of the build (three P2, 2026-10-08)

An independent correctness pass found three places where the build applied
the rule to less than the rule names. Each is fixed, with engine cases in the
seam (fake clock, real reader, both engines, pinned and pool) that failed
before the fix:

- **A large record in closed history.** `readRecoveryWindow` refused any line
  over 8 MiB, before it knew whether the line was inside the open chain. A
  9 MiB native tool result between a continuation's tool call and its answer
  then kept every later cut incomplete, and the lane parked ten minutes after
  cut 2. The window now parses a record of any size and applies the bound to
  retained bytes only, which count from the open chain's first cut. Over 8 MiB
  inside a chain that stays open, and a torn record anywhere, still leave the
  history incomplete. "quota continuation waits for a decision when prompt
  history exceeds the read bound" now writes the saved cut at the head of its
  fixture: without it, its 9 MiB record lay before the only cut in the file,
  in closed history.
- **A chain closed by tool or reasoning output.** The tick removed the
  closed chain's budget only when a newer text message followed the cut, or
  when the next cut was already written. A turn that ended on a tool call or
  on reasoning alone left the spent tries for the next chain, and a capacity
  cut after it parked "after 3 tries". The budget now goes whenever the reader
  proves the saved wait's chain closed (`requestedCutOpen === false`); the
  wait itself still goes only once a newer chain is open, as before.
- **A closing Claude API error on the first tick.** The coverage trigger read
  the shared turn projection, which keeps an overloaded error busy, while the
  chain tracker and the final turn read the same record as the end of the
  attempt (`claudeApiErrorClosedAttempt`). After more than 128 KiB of work the
  first tick therefore saw incomplete history and parked. The trigger now uses
  the final turn's reading. A Claude API error with no closing stop reason
  stays busy, and a reply after the cut still cancels.

## Review of the build (one P2, 2026-10-09)

**A running chain's confirmation wait.** On a running lane the tick removed a
closed chain's budget and wait and left `attempt.controllerWait` behind, which
R10 names with them. A continuation refused at 19:01 opened that wait; output
at 19:01:30 closed the chain; at 21:30 a new chain whose history after its
first cut ran past the read bound booked its first transport round against
the 19:01 clock and parked at once, "exhausted after 10 minutes". The tick now
clears the confirmation wait with the budget wherever agent output closes the
chain: when the reader proves the saved wait's chain closed, and when a newer
agent message follows the saved cut. The parked path already did so in
`providerCutActivity`. "a closed running chain's confirmation wait never binds
the next cut" (both engines, pinned and pool) failed in all four cases before
the fix: the new chain now starts its own ten minutes at its own cut, and
output followed by a later cut recovers after that cut's reset.
