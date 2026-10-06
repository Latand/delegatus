# Restart cut recognition: one rule

Status: design for PR #2570, written against branch head `57b174379`
(2026-10-07). Lane 66251dff closed after five review rounds; this document is
the rule its rebuild follows.

## Originating requirement

Board task 9630f92a, written 2026-10-06 after that day's deploy (card text and
agent-facing details, verbatim):

> Етапи, обірвані деплоєм, продовжують самі
> Під час розгортання 6 жовтня перезапуск обірвав два етапи майже наприкінці
> роботи, і вони стали на «потрібне рішення», а мерджер загубив сповіщення про
> свою фонову перевірку. Після перезапуску така робота має продовжуватися сама.

> 2026-10-06 deploy of fd5b45a9 (restart ~14:28Z, verdict pass). Effects:
> pipeline 9763da0f stage build (Claude, attempt 1, near the end, waiting on a
> background test sweep) and 2f9618d0 stage fix (attempt 4) both settled
> "historical attempt completed without a valid final JSON verdict" ->
> needs_decision; merger conversation_cbd5efdf (spawned agent) was waiting for a
> Claude background-task completion notice (run_in_background) that died with
> the restart and went silent. Manual interventions by the orchestrator at
> ~15:35Z: retry-stage on both stages; message to the merger to read its gate
> output.
> Root-cause fix wanted: (1) a stage attempt whose host was cut by a Delegatus
> deploy/restart (the deploy verdict lists protected work) is resumed or retried
> automatically once, continuing in the same worktree, without operator
> decision; (2) an agent whose turn was cut mid-wait gets a resume message after
> the restart naming what it was waiting on (or the host replays the background
> task outcome); (3) the deploy procedure lists interrupted conversations in its
> verdict so the seat need not reconstruct them. Evidence: deploy-verdicts run
> a9573ad3e3b44b3696056ba164aac92d.

Pinned specification of pipeline a429112c, 2026-10-07 (verbatim excerpt):

> Task: stages and agents cut by a Delegatus restart continue by themselves (PR
> #2570, lane 66251dff closed after five review rounds). Tonight's deploy
> restart at 2026-10-07 00:29 Kyiv cut several stages and one measurement
> launch; each needed a manual retry — the exact pain this PR exists to remove.
>
> 1. design: docs/design/restart-cut-recognition.md pins ONE rule: for each
> conversation, the restart cut is decided from that conversation's own durable
> evidence of a STARTED turn (delivery receipt / turn identity / start time,
> registry live row) versus its own evidence of that turn ENDING by itself
> (completion record), independent of transcript publication timing, of earlier
> cut records, and of shutdown markers the restart itself caused; unresolved
> evidence is retried before the predecessor's ownership is replaced and never
> invents a cut; each resolved cut yields exactly one continuation (or a
> controller-owned witness for a pipeline member) across repeated boots. Map
> every finding of rounds 4 and 5 and every existing releaseInterruption/startup
> test case to the rule that decides it. Say which parts of the current branch
> stay, which go, and the smallest build plan.

## Should this be built

Yes. The requirement names two incidents in two days in which a restart left
work stopped until a person retried it. Tonight's manual retries ran on `main`,
which has no restart capture at all (PR #2570 is unmerged), so they show the
need. They say nothing about the branch, whose failures are the three open
round 5 findings below. Everything in this document serves requirement items
(1) and (2); item (3) is served by the records the rule writes, which
`scripts/deploy-checkout.py` already lists.

## Why five rounds kept finding the same defect

`restartCutTargets` (`src/lib/runtime/startup.ts:425-511`) decides "was this
turn cut" by starting from the shared transcript projection
(`busy`/`terminal`) and adding exceptions as reviews found shapes it misread:

- `resumedTurn` (`startup.ts:475-479`) accepts a terminal transcript only when
  an earlier resolved cut record exists with the same last-work time. A turn
  that started after a turn that ended normally has no such record (round 5
  F1).
- `firstTurn` (`startup.ts:482`) accepts an empty transcript only for a
  registry that never observed it. That condition is sound; it sits beside the
  stage special case and the resumed-turn case as a third independent premise.
- The turn axis comes from the full transcript (`liveness.ts:392-394`), while
  the cut's name comes from the work records alone. A Codex `turn_aborted` that
  the dying app-server wrote closes the full projection, so the turn reads as
  ended by itself (round 5 F2).
- Capture is one boolean per boot (`startup.ts:1494-1501`). A row whose read
  came back uncertain is skipped, the boolean is set, and the same pass then
  adopts the row on a later, complete read (round 5 F3).
- Record coverage compared a record's `recordedAt` against the transcript's
  last event and special-cased resolved records with another turn reference
  (`interruptionObligations.ts:180-189`), so an earlier record could answer for
  a later turn (round 4 F2).

Each fix was correct for its shape and left the premise intact: the transcript
projection answers "did the turn end", and earlier records answer "is this a
new turn". Neither can answer for a turn whose prompt the transcript has not
published yet, and neither can tell a shutdown abort from an ended turn. The
rule below asks each conversation's own records two questions: which unit of
work had started, and does anything record that unit ending.

## The rule

### Who is asked

A conversation is asked once per boot, before anything can claim its row, when
all of these hold (as on the branch; the runtime-client condition after the list
is new):

- its engine is Claude or Codex, it is not superseded, and it is not an
  orchestrator seat (seats keep their own capture, see Deferred);
- its current generation's row is a structured host with no pane (`host ===
  null`), with status `live`, or `idle` for Claude;
- the row's claim belongs to another process, compared by whole identity, or
  to none (`sameRecordedProcessIdentity`, round 2 F5);
- no record of a cut of this conversation is still unresolved after arrivals
  are settled (`owed`, or `submitted` without arrival). That record already
  owns the conversation's next message; the evidence written since it (resume
  bookkeeping, the continuation's own turn) is never a new cut to decide while
  it is in flight. This only postpones the question; recognition never reads
  earlier records;
- the newest work, else the delivery that started the turn, else the row's
  last update, lies inside the adoption age window
  (`LLV_HOST_ADOPTION_MAX_TURN_AGE_HOURS`, default 6 h).

The capture runs only in a pass that has a runtime client. Without one, nothing
can be adopted or delivered, so nothing is decided.

### The evidence

| Evidence | Writer | What it says |
| --- | --- | --- |
| Row status and `activeTurnRef` T | The Viewer, from each host state change (`runtime/registry.ts`) | `live` + T: the host last reported T active. `idle`: the host reported the turn's end. |
| Delivery receipt naming T | The runtime host journal, at the `delivered` transition (`journal.ts` `transitionOperation`) | T started no later than the receipt's `at`. `at` is stamped once at completion and never moves afterwards. Read through the session read startup already uses (`readStartupRuntime`: `client.readSession`, else the snapshot), whose `recentReceipts` hold the session's 8 newest receipts. |
| Interrupt receipt | The runtime host journal | Someone asked for the running turn to stop, at its `admittedAt`. |
| Transcript tail | The engine CLI | The work slice W: every record up to the newest agent-work record (`lastAgentWorkIndex`). Trailing exit and resume bookkeeping falls outside W: Codex token counts and `turn_aborted`, Claude shutdown and interrupt markers, replayed meta prompts, synthetic no-responses. |
| Registry observation source | The registry | `turn.source === "empty"`: no record of this transcript was ever observed. |
| Pipeline membership | The pipeline engine | The conversation runs a stage attempt that was launched. |
| Background ledger | The engine CLI's tool results and notices | Harness background work launched and not completed (Claude, inside `BACKGROUND_TASK_WAIT_LIMIT_MS`). |

A scratch run of the existing operator-resume flow at `57b174379` confirmed the
second row: after the successor delivered the operator's send, the session's
receipt read `{kind: "send", status: "delivered", turnId:
"turn:operator-second-task-operation", at, admittedAt}`, and that `turnId` is
the value the row names once the turn is running.

### The decision

Let S be the turn state of the work slice W, using the shared projection:
`open` (busy), `closed at c` (terminal, at its closing record's time), or
`none` (W holds no work). Two adjustments; the first is already in the code,
the second is new:

- a Claude turn the provider closed (a flagged API error with a closing stop
  reason, `claudeTurnClosedByProviderFailure`) is `closed` at that record; the
  provider recovery owns it (round 3 F1);
- when the runtime admitted an interrupt for this conversation at or after W's
  newest turn-opening record, S is projected over all records, so the abort
  that interrupt caused closes the turn. Without such an interrupt, a trailing
  abort is the restart's own mark and stays outside W. The row says the same
  thing: while it still names the turn live, the predecessor never processed
  that abort as an end.

Then, for a tail read whole, the started unit of work and its end:

| Row | Transcript | Decision |
| --- | --- | --- |
| `idle` | any | The host recorded the turn's end. Started work is the background work B. Cut iff B is non-empty. |
| `live` | S `open` | The transcript shows the turn started and nothing ended it. **Cut.** |
| `live` | S `closed at c`, T named, a receipt delivered T at o > c | T started after the newest close; its prompt is not published yet. **Cut.** |
| `live` | S `closed at c`, otherwise | The turn ended by itself. Cut iff B is non-empty. |
| `live` | S `none`, and T named with a receipt naming it, or T named and never observed, or a stage attempt | The turn started at launch and wrote nothing yet. **Cut.** |
| `live` | S `none`, otherwise | The row's turn word is all there is, and it can be stale (#1281). No cut. |

When the transcript has no closing time (an undated closing record) and a
receipt dates T, the two cannot be compared and the decision is no cut.

A decision is **undecided** when the transcript tail is still unreadable after
the bounded re-read below, or when the table's answer depends on a receipt
(T named, S `closed`, or S `none` on a transcript the registry observed) and the
runtime read failed. An absent session or an absent receipt is a resolved
answer: no delivery record names T.

The same rule is what an orderly release applies at the moment it hands a host
over (`handOverHostForDemotion`, `structuredDeliveryController.ts:2031`): the
live host's own state is the freshest evidence there is, so an active host is a
started, unended turn, and an idle Claude host is cut iff it still waits on
background work. That path stays as it is.

### What a decision produces

**Cut.** One record through `store.record` with `owner: null`, `turnRef` = T
(or null for an idle row), `boundary: viewer-restart:<w|launch>` where w is the
newest work record's time, and `checkpoint` = that record's kind and time plus
the background tasks when the turn itself had ended. A pipeline member is
recorded `discharged` with `STAGE_CUT_RESOLUTION`, a review-flow reviewer with
its flow's resolution; every other cut is `owed`. Then, unchanged:

- an owed record forces its row's adoption and gets one continuation keyed by
  the record id (`deliverInterruptionContinuations`);
- several owed records of one conversation collapse to the newest, which
  carries the one message; the older ones are discharged with that reason;
- the pipeline engine reads the newest record through `conversationRestartCut`
  and spends the stage's one fresh attempt (`engine.ts:4161-4200`);
- the deploy inventory lists the record.

**No cut.** Nothing is written. The row follows the existing adoption rules.

**Undecided.** The row is held: no adoption, whatever argues for it, pending
work included; no skipped-host demotion; no generic nudge. Its decision stays
open in the pass state and is attempted again, before anything else, by the
next pass in this process whose scope includes the row (a startup retry, a
runtime-host replacement pass) and by the next Viewer generation, since the row
is still the predecessor's. It never produces a record.

**The generic Codex nudge** (`enqueueInterruptedCodexContinuations`, keyed by
claim epoch) never answers a row whose decision this boot was cut, a row with
an unresolved record, or a pipeline member. It remains for rows the rule does
not ask: this process's own rows after a runtime-host replacement, and rows the
rule answered "no cut" on an uncorroborated turn word, which existing startup
cases still expect it to resume.

### Identity across boots

A cut is named by `(conversation, host row, T or null, w or launch)`. That
tuple is the record id's input, as on the branch. Two observations are the same
cut exactly when the tuple matches:

- `store.record` returns an existing record under the same id in whatever state
  it reached;
- for an owner-less restart record, coverage of another record is tuple
  equality: same conversation, host row, `turnRef` and
  `checkpoint.lastEventAt`. The `recordedAt` comparison and the
  resolved-with-another-turn branch go. Release and seat records keep their
  coverage by owner and turn.

So a later boot that finds the same silent turn lands on the same record and
sends nothing. Exit bookkeeping moves neither T nor w. A message that started
another turn changes T, and genuine work changes w, so either one is a cut of
its own.

### Unresolved reads

`readTranscriptCutEvidence` reads the tail up to three times within about one
second while the read comes back uncertain. The stable tail reader reports a
file that changed under the read, a partial last line or corrupt JSON all as
uncertain; the predecessor's engine can still be appending exit records for a
few seconds, which is the transient case round 5 F3 reproduced. A tail still
uncertain after that is undecided, held as above, and decided by whichever pass
next reads it whole. No pass records a cut from it.

## Finding map

| Finding | What failed | Clause that decides it | Status at `57b174379` | Test |
| --- | --- | --- | --- | --- |
| R4 F1 | A spawned Claude agent cut before its first transcript record got no continuation | S `none`, T named, never observed: cut | Fixed (`firstTurn`) | Existing: "a spawned Claude agent cut before its first transcript record is resumed once across repeated boots"; "an agent's row …, its transcript holding no record, records nothing" |
| R4 F2 | A turn an operator resumed was swallowed by the discharged record of the earlier cut | Recognition reads no earlier record; identity is the tuple, so T2 ≠ T1 is a new cut | Fixed by a special branch in `coversSameCut`; the build replaces it with tuple equality | Existing: "a turn an operator resumed after a cut, cut again before its transcript shows it, gets its own one continuation" |
| R4 F3 | A claim renamed during the deploy inventory gave a passing empty list | Outside recognition: the inventory lists every record or reports it moving | Fixed in `scripts/deploy-checkout.py` | Existing: `scripts/deploy_checkout_test.py` |
| R4 F4 | A native shutdown marker erased the cut attempt's last report | Shutdown markers the restart caused are neither the turn's end nor its last word | Fixed (`cutProse`, `cutAttemptReport`) | Existing engine cases |
| R5 F1 | A later accepted turn was lost when the restart preceded its prompt echo | S `closed at c`, T named, receipt delivered T at o > c: cut | **Open** | New, release seam |
| R5 F2 | A Codex shutdown `turn_aborted` hid the cut from the agent and from the stage witness | The abort sits outside W unless an interrupt was admitted; S `open`: cut | **Open** | New, release seam |
| R5 F3 | One uncertain read dropped the cut, then the row was adopted | Bounded re-read; undecided rows are held and decided per row | **Open** | New, release and startup seams |

Rounds 1-3 each landed a test that the map below keeps.

## Existing test map

### `src/lib/runtime/releaseInterruption.test.ts`

Every case stays and passes unchanged.

| Case | Decided by |
| --- | --- |
| claude/codex: cut mid-tool by a Viewer release resumes once … | Release applies the rule to the live host; the boot skips the conversation while that record is owed |
| a cut turn stays owed while runtime-host succession lags … | Release record; the capture needs a client and the first boot has none |
| failed demotion cleanup keeps the obligation … | Release record; delivery waits for adoption of the survivor's row |
| a turn cut on a host startup adopted but never published … | The retrying boot records its cut (S `open`), the release records its own; the newest owed record carries the message |
| an obligation the release cannot write to its directory … | Release record via the pending journal |
| a host whose obligation cannot be recorded anywhere … | Release path, unchanged |
| restarts between recording, admitting and recording the admission … | Record id keys the delivery |
| provider recovery bookkeeping written after the cut … | The owed release record postpones recognition, so the replayed prompt is no new cut |
| a message that reaches the cut conversation first …; a send the runtime admitted before …; a send the runtime admits while … | Discharge by a newer message, unchanged |
| a seat cut by the deploy it requested …; a seat rotated …; a seat that names an alias … | Seats are outside this capture |
| an unpublished host the release cannot hand over …; one published host failing its health probe … | Release records; restart records of the retrying boot are filtered out of the assertion |
| a submitted continuation whose reservation was compacted away … | Settling before capture |
| the pipeline engine reads a continuation the successor submitted as arrived … | Engine port, unchanged |
| persistent update drain …; a pending spawn's first prompt … | Outside the rule |
| a spawned agent whose turn a service restart cut is resumed once … | S `open`: cut; the next boot finds the row the first one adopted, now `idle` with nothing in the background |
| a spawned agent waiting on background work the restart killed … | S `closed`, no receipt: the turn ended; B non-empty: cut |
| a pipeline stage a restart cut gets no continuation … | S `open`, stage: witness |
| a restart that finds an agent's turn already settled … | S `closed`, no receipt, B empty: no cut |
| an idle Claude agent whose ended turn still waited on background work … | Row `idle`, B non-empty: cut |
| an agent resumed after one restart and cut mid-turn by the next … | New T and new w: a second tuple; the third boot finds the same tuple |
| a spawned Claude agent cut before its first transcript record … | S `none`, T named, never observed: cut |
| an agent's row idle / live with no turn named / naming a turn observed before … | `idle` with B empty; S `none` without T; S `none`, observed, no receipt, no stage: no cut |
| a turn an operator resumed after a cut … | Release record discharged by the send; then S `open` under T2: cut, once |
| a Codex agent's restart cut is continued once across repeated boots … | Same tuple each boot; nudge suppressed for a cut decision |
| codex/claude pipeline stage gets no continuation from any path | Witness; nudge suppressed for pipeline members |
| an orderly release of a pipeline stage leaves its cut to the stage controller | Release record discharged as a stage cut |
| Codex exit bookkeeping after a cut owes no second continuation … | Token counts move neither T nor w; the resumed turn has a new tuple |
| claude/codex turn a delivered continuation started, cut before its transcript echoed it … | S `open` under the continuation's T: cut; later boots find the same tuple |
| a stage whose turn a provider failure ended before the restart … | Provider close: S `closed`: no cut |
| an orderly release resumes an idle Claude agent waiting on background work …; … with nothing in the background records nothing | Release path |
| a stage transcript truncated / corrupt proves no restart cut | Undecided: no record, the row is held |
| a stage cut at launch, its transcript empty / not written / launch-only … | S `none`, stage: witness, one record across boots |
| a predecessor Viewer whose pid this process was given … | Whole-identity comparison; the second boot's row is this process's own claim |

### `src/lib/runtime/startup.test.ts`

The rule decides these cases, with the same outcome as at `57b174379`:

| Case | Decided by |
| --- | --- |
| a busy Codex turn advances after container replacement without operator messaging | S `open`: cut. After the replacement Viewer, the continuation's echo moved w, so a second tuple and a second, different restart continuation |
| unknown Codex durable state continues when the structured host retains an active turn | S `none`, T named, observed, no receipt, no stage: no cut; the generic nudge resumes it |
| unknown Codex durable state continues from runtime-running evidence | S `none`, no T: no cut; the generic nudge resumes it |
| terminal / superseded Codex conversation stays outside startup continuation | No cut / not asked |
| startup adopts a persisted terminal conversation whose transcript starts a new turn before restart | S `open`: cut; the owed record keeps the expected adoption |
| startup keeps a live turn open when its transcript ends on an API error, a synthetic record or an error event | API errors are provider closes (no cut); the other shapes are S `open`. The case asserts only the turn word |
| startup keeps a Codex host eligible when the bounded tail cuts off an unmatched tool call | S `open`: cut; adoption as expected |
| a clean / production-shaped / 128 KiB-aligned terminal transcript stays retired across repeated startup | S `closed`, no receipt: no cut |
| a repeated promotion reuses one pending Codex continuation; startup retries a failed Codex continuation …; … same-epoch …; startup preserves a queued user draft … | Transcripts dated outside the age window: not asked; the generic nudge cases are unchanged |
| malformed JSON / truncated record / growing tail / missing / unreadable path cases | Outside the age window, or undecided and held; both give no adoption, as the cases expect |
| an explicit terminal transcript outranks a stale running runtime projection | Not asked (age window); no cut either way |

Every other `startup.test.ts` case (seat recovery, claim and retry mechanics,
MCP grants, spawn receipts, deferred pipeline evidence, demotion) either
involves rows the rule does not ask (seats, this process's own claims, dead or
unhosted rows, transcripts outside the age window) or rows it decides as
`57b174379` does: an open transcript turn is a cut, a closed one is a cut only
behind a later delivery receipt, and none of these fixtures holds such a
receipt for the turn its row names. The build confirms this by running the
whole file by path; a case that changes outcome is a finding against this
design, to be reported before any expectation is edited.

### `src/lib/runtime/liveness.test.ts`

No case covers cut evidence today; the build adds the decision table there.

## The current branch: what stays and what goes

Stays:

- `interruptionObligations.ts`: the `stage` field, `answeredBy`,
  `STAGE_CUT_RESOLUTION`, `interruptionStageOf`, `checkpoint.backgroundTasks`
  and its continuation sentence, id-first lookup in `record`.
- `liveness.ts`: `TranscriptCutEvidence` naming the cut by work records,
  `backgroundWorkAwaitedAtCut`.
- `startup.ts`: settling arrivals before capture, whole-identity self
  exclusion, `recordRestartCuts`, the stage branch in
  `interruptionObligationDischarge`, newest-record-per-conversation discharge,
  the unpublished release path through `handOverHostForDemotion`.
- `structuredDeliveryController.ts`: `handOverHostForDemotion`, idle Claude
  background capture at release, work-based checkpoint and stage on release
  records.
- The pipeline side, unchanged: `restartCutOf`, `recoverRestartCutStage`,
  `startReplacementAttempt`, `cutAttemptReport`, the restart prompt,
  `conversationRestartCut`, `lastAgentWorkIndex`, `lastAgentEventAt`,
  `cutProse`, `claudeTurnClosedByProviderFailure`,
  `pendingBackgroundTaskNames`.
- `scripts/deploy-checkout.py` and its tests; the `startup.test.ts` edit.

Goes:

- `resumedTurn`, `firstTurn` and the `inFlight` expression
  (`startup.ts:470-485`); the decision table replaces them.
- `restartCutsRecorded` and `recordedCuts` (`startup.ts:66-70, 1494-1501`);
  a per-row decision map replaces them.
- `cutsAnsweredByRecord` and `lastWorkByHost` (`startup.ts:822-841,
  1015-1017, 1547`); the nudge reads the decisions.
- `coversSameCut`'s resolved-with-another-turn branch and its `recordedAt`
  comparison for owner-less restart inputs
  (`interruptionObligations.ts:180-189`).

Changes:

- `transcriptCutEvidenceFromRecords` projects the turn over W (the full records
  when an interrupt was admitted) and returns the closing time.
- `readTranscriptCutEvidence` re-reads an uncertain tail, bounded.
- `restartCutTargets` gathers the inputs above, reads the receipts it needs and
  applies the decision. It returns cuts and undecided rows.

## Build plan

Each step is test-first: the new case runs red on `57b174379` before the code
changes.

1. **Tests.**
   - `releaseInterruption.test.ts`, R5 F1: a Claude conversation with a
     runtime session (`runtimeSession`) whose newest turn has closed, a
     `delivered` receipt naming a later turn, the row live with that turn, a
     successor boot before the prompt echo: one restart continuation, one
     record naming that turn, nothing more across two further boots; the same
     shape without the later receipt records nothing. In a scratch run, an
     operator send to a fixture whose transcript had already closed failed
     with "structured host recovery did not start", so the dependable
     construction is the existing operator-resume flow (release, send, boot)
     followed by closing records dated before the delivery.
   - `releaseInterruption.test.ts`, R5 F2 (`test.each` agent / stage): the
     mid-tool Codex transcript plus a dated `turn_aborted`, no release record.
     The agent gets one continuation and the stage one discharged witness
     (`conversationRestartCut` set, no engine write), each once across
     repeated boots. A third case, with an `interrupt` operation the journal
     admitted before the abort, records nothing.
   - `releaseInterruption.test.ts`, R5 F3: the first tail read of the cut
     transcript grows under it (a bookkeeping line appended once, as the
     growing-tail startup case does): one record, one continuation. A tail that
     grows on every read: no record, no adoption, even with an operator send
     waiting.
   - `liveness.test.ts`: the decision table as pure cases, one per row, plus
     the provider close, the requested abort and the undated close.
   - `startup.test.ts`: an undecided predecessor row with pending work is held
     out of `startupAdoptionAttempts` and adopted by the next pass once its
     tail reads whole.
2. **`liveness.ts`.** Work-slice projection with the interrupt exception and
   the closing time; bounded re-read; a pure `restartCutDecision(input)`
   implementing the table.
3. **`startup.ts`.** `restartCutTargets` per the rule: candidates, the
   targeted `readSession` reads for rows that need a receipt, decisions in
   the pass state per host key, undecided rows held from adoption, demotion
   and the nudge; delete the code listed under "Goes".
4. **`interruptionObligations.ts`.** Tuple coverage for owner-less restart
   inputs.
5. **Gates**, from the specification: the touched test files by path with
   private `HOME`, `TMPDIR` and `LLV_STATE_DIR` and `LLV_VIEWER_CONTROL_URL` on
   a closed port (`releaseInterruption`, `startup`, `liveness`,
   `interruptionObligations`, `structuredDeliveryController` and the engine
   file if touched), never a sweep of `src/lib/agent` or
   `src/app/api/runtime`; `tsc`; `eslint`; the privacy gate from the merge
   base; `bun scripts/verify-runtime-host.ts --runtime "$(which bun)"` in its
   private state; merge `origin/main` before the push.

Expected size: about 150 lines added and 120 removed in product code, with the
tests on top.

## Options considered

- **Keep patching each shape.** Rejected: five rounds show that each patch
  leaves the premise that produces the next finding.
- **The runtime journal's `turn-started` / `turn-ended` events as the only
  evidence.** Rejected for now: the Viewer appends them from the same host
  events that write the registry row, so they are lost in the same crash, and
  a stale `running` projection already outlives its host (startup case "a
  stale runtime-running projection cannot revive an idle registry host").
- **The row's `updatedAt` as T's start time.** Rejected: cursor writes and
  claims move it, and the existing settled-turn fixture writes the row after
  its transcript closed, so this rule would invent a cut there.
- **The receipt's `admittedAt` as T's start time.** Rejected: a send admitted
  while the previous turn ran predates that turn's close, so an unechoed T
  would read as ended. The delivered `at` is stamped once, after the engine
  took the prompt.
- **Hold undecided rows only from turn-claim adoption**, letting pending work
  adopt them as an unreadable row is adopted today. Rejected: the
  specification requires the retry before the predecessor's ownership is
  replaced, and pending work is a replacement.

## Residual risks

- A Claude send accepted as `queued-next-turn` may be marked delivered while
  the previous turn runs. If the restart then lands between that turn's close
  and the queued prompt's echo, the queued turn reads as ended: a missed
  continuation, never an invented one.
- The session keeps its 8 newest receipts. A turn whose delivery receipt fell
  out of that window falls back to the transcript alone, with the same miss.
- A Codex abort neither requested through the runtime nor caused by the
  restart would read as the restart's. No such source is known for app-server
  hosts. If one exists, the cost is one extra continuation.
- An undecided row with pending work waits for the next pass or the next
  Viewer generation. Today such a row is adopted for its pending work.
- Receipt times come from the runtime host's clock and transcript times from
  the CLI's. Both run on one machine; the container shares the host clock.

## Deferred — not currently justified

- **Seats under this capture.** `orchestratorRestartRecoveryTargets` decides a
  seat by `conversationTurnLiveness`, whose turn axis reads the full
  transcript, so a Codex seat whose shutdown wrote `turn_aborted` would read
  settled. No finding names seats, and their tests encode process evidence
  (#1276, #1281). Revisit when a Codex seat is seen cut this way.
- **An in-process re-probe for undecided rows.** The deferred-startup re-probe
  could re-read their tails on its backoff. The bounded re-read covers the
  transient case the review reproduced. Add the re-probe if a production log
  shows a row still undecided after its pass.
- **Retiring the generic Codex nudge.** It still serves this process's own
  rows after a runtime-host replacement, which the rule does not ask.
- **Runtime-host succession cuts of this process's own rows under the same
  rule.** Today they are covered by the nudge and by #1747's stage recovery.
- **Journal turn events as end evidence** (see Options).

## Check against the requirement

- (1) A stage cut by a restart: the rule records a witness for every started,
  unended stage turn, including a later turn before its echo (R5 F1) and a
  Codex turn whose shutdown wrote an abort (R5 F2). The engine spends the one
  fresh attempt in the same worktree, and a second cut parks.
- (2) An agent cut mid-turn or mid-wait: one continuation per cut, naming the
  background work it was waiting on, deduplicated across boots by the tuple.
- (3) The deploy verdict lists each record; R5 F1-F3 cuts now produce records,
  so they are listed too.
- Unresolved evidence is retried before the row is replaced and never yields a
  record (R5 F3).

No question for the operator remains: the code, the journal and one scratch
run settled every fact this design rests on.
