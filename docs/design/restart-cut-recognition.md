# Restart cut recognition: one rule

Status: revision 2 of the design for PR #2570, written against the code at
branch head `57b174379` (2026-10-07). Revision 1 (`87d190109`) dated a later
turn by the runtime receipt that acknowledged its delivery. An adversarial
critique of that revision found six blockers (C1-C6 in the finding map), and
this revision answers all six. Lane 66251dff closed after five review rounds;
its rebuild follows the rule below.

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
round 5 findings and the six critique findings below. Everything in this
document serves requirement items (1) and (2); item (3) is served by the
records the rule writes, which `scripts/deploy-checkout.py` already lists.

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
published yet, and neither can tell a shutdown abort from an ended turn.

Revision 1 of this document swapped those premises for one of the same kind.
It ordered a turn's start against the transcript's close by the time the
runtime journal stamped the delivery acknowledgement, and it read that
acknowledgement from the session's eight newest receipts. The stamp is taken
when the delivery queue records the outcome, which can come after the turn
started and even after it ended (C2), and the eight-entry window drops it once
newer sends arrive (C3). The rule below reads the record the engine host keeps
of its own turns: it names each turn, puts its start and its end in one order,
and keeps every entry.

## The rule

### The host's own turn record

Every structured engine host appends its events to
`structured-host-events/<session id>.jsonl` under the state directory
(`FileRuntimeEventStore`, `src/lib/runtime/eventStore.ts`). Three properties
make it the evidence the specification asks for.

- **It names the turn and orders it.** `turn-started {turnId}` and
  `turn-ended {turnId, status}` carry the engine's own turn identity (the
  app-server's turn id for Codex, the delivery id for Claude), each with the
  next sequence number. Claude writes `turn-started` when it hands the prompt
  to the CLI, and for a prompt queued behind a running turn it writes it right
  after that turn's `turn-ended`, when the CLI's `result` arrives
  (`claudeStreamBrokerHost.ts:990-995`, `:1486-1521`). Codex writes both from
  the app-server's `turn/started` and `turn/completed` notifications.
- **It is written first.** `emit` appends and fsyncs the event before any
  subscriber or state listener sees it (`claudeStreamBrokerHost.ts:1299-1323`,
  `codexAppServerHost.ts:3136-3161`, `eventStore.ts:343-372`). The registry
  row is written by one of those listeners
  (`runtime/registry.ts` `bindStructuredHostPersistence`), so whatever the row
  says, the ledger said first.
- **It keeps every entry of the session.** One file per session, appended only
  by the host that holds the claim, never cut to a window. An unterminated
  final line is a write the crash cut short and is no record; a malformed
  earlier line or a sequence gap makes the file unreadable
  (`FileRuntimeEventStore.load`).

The seat tick already reads this file as a child's turn record
(`monitor/seatTickSources.ts:2058`). It carries no clock of its own; since it
is only ever appended, its modification time is the time of its newest record.
A scratch probe against the unchanged store confirmed the read semantics:
three appended events load in order, a torn final line is dropped, a malformed
middle line throws, and a missing file loads empty.

### Who is asked

A conversation is asked, before anything in this process can claim its row,
when all of these hold:

- its engine is Claude or Codex, it is not superseded, and it is not an
  orchestrator seat (seats keep their own capture, see Deferred);
- its current generation's row is a structured host with no pane (`host ===
  null`), with status `live`, or `idle` for Claude;
- the row's claim belongs to another process, compared by whole identity, or
  to none (`sameRecordedProcessIdentity`, round 2 F5);
- no record of a cut of this conversation is still unresolved after arrivals
  are settled (`owed`, or `submitted` without arrival). That record already
  owns the conversation's next message; whatever was written since it is its
  bookkeeping or its continuation's turn. This only postpones the question;
  the decision itself never reads earlier records;
- this process has not decided the row yet. Decisions are kept per host row in
  the pass state for the life of the process; an undecided row is asked again;
- its newest durable activity lies inside the adoption age window
  (`LLV_HOST_ADOPTION_MAX_TURN_AGE_HOURS`, default 6 h). The activity is the
  newer of the host ledger's newest record and the transcript's newest dated
  work record; when the conversation has neither, the row's last update (C1).

Every startup pass asks the rows in its scope that meet these conditions
before it adopts, demotes or nudges any of them: the first pass, a startup
retry, a runtime-host replacement pass, and the deferral re-probe below. The
evidence is all local files, so the decision needs no runtime read, and a pass
without a runtime client decides as well as one with.

### The evidence

| Evidence | Writer | Read as |
| --- | --- | --- |
| Host ledger | The engine host, before anything else learns of the event | H, the host's record of its newest turn (below) |
| Registry row: status, `activeTurnRef` | The Viewer, from host state, after the ledger | H only where the ledger holds no turn; the turn word names the cut |
| Transcript tail | The engine CLI | S, the completions in it, and w, the newest dated work record |
| Registry observation source | The registry | `turn.source === "empty"`: no record of this transcript was ever observed |
| Pipeline membership | The pipeline engine | The conversation runs a launched stage attempt |
| Background ledger | The engine CLI's tool results and notices | B, harness background work launched and not reported complete (Claude) |

Nothing else is read. Runtime receipts and interrupt receipts are gone from
the decision (C2, C3), earlier cut records only postpone it, and the marks a
dying CLI writes (Codex `turn_aborted`, Claude shutdown and interrupt markers)
are never read as an end.

### The decision

**H**, the host's record of its newest turn:

- `open T`: the ledger's newest `turn-started` names T and no `turn-ended` for
  T follows it. Where the ledger holds no turn: the row is `live`, names T, and
  the registry never observed a record of the transcript.
- `ended`: the ledger's newest `turn-started` names T and a `turn-ended` for T
  follows it, whatever its status. Where the ledger holds no turn: the row is
  `idle`.
- `none`: the ledger holds no turn and neither row clause applies. A live
  row's turn word over a transcript the registry has observed can lag that
  transcript (#1281), so it is no evidence of a start.
- `unreadable`: the ledger exists and cannot be read.

Any `turn-ended` status ends T because the host writes one only while it is
alive and holds the claim. An interrupt the host served and an abort the
engine reported to it are real ends. The marks a restart leaves come from
three writers, and none of them can end a turn this decision reads as open:
the dying CLI writes its marks into the transcript, which this rule never
reads as an end; a successor writes `turn-ended` from `restore`,
`reconcileAfterOpen` or its history replay only when it adopts, which is after
the boot that adopted it decided the row; and an orderly release that reaps a
CLI records its own cut first (`handOverHostForDemotion`), so the conversation
is postponed while that record is owed, and its tuple covers the same turn
once it is resolved.

**S**, the transcript tail through the shared projection
(`turnStateFromRecords`) over its work records: every record in the tail,
dated or undated, minus the bookkeeping a CLI writes as it exits or resumes.
That bookkeeping is Codex `token_count` and `turn_aborted`, and for Claude
meta prompts (`isMeta`), shutdown and interrupt markers, and the synthetic
"No response requested." no-op, the same shapes `lastAgentWorkIndex` passes
over. Records are removed one by one and the tail is never cut at a dated
record, so an undated completion still closes its turn (C5). API error
records stay, and a Claude turn the provider closed
(`claudeTurnClosedByProviderFailure`, read on the tail as written) is
`closed`; its recovery is the provider's (round 3 F1). S takes one of five
values: `open`, `closed`,
`empty` (no work records), `unknown` (work records and no turn boundary in the
tail, such as a Codex tail of reasoning items), or `unreadable` (the stable
tail read is uncertain). A missing transcript file is `empty`.

A scratch probe with the unchanged helpers, comparing the full projection,
revision 1's work slice and this filter:

| Tail | Full | Revision 1 slice | Filter |
| --- | --- | --- | --- |
| Claude dated prompt, undated provider `end_turn` | terminal | busy | terminal |
| Codex dated `task_started`, undated `task_complete` | terminal | busy | terminal |
| Codex prompt, open `function_call`, dated `turn_aborted` | terminal | busy | busy |
| Codex dated `reasoning` item only | unknown | unknown | unknown |

**A**, the CLI ended the host's open turn after its host stopped recording.
For H read from the ledger: the tail holds a completion (a record that closes
a turn in S) dated later than the ledger's newest record. For H read from the
row: S is `closed`. An undated completion cannot be placed after the host's
last record, so it does not count here.

A is sound because the host writes `turn-started T` only after the CLI's
previous turn ended (a send to an idle CLI) or after the CLI reported that end
(a queued prompt). Every completion of an earlier turn is therefore dated
before the ledger's newest record, and a completion dated after it was
written while nobody was recording: it ends the turn the host had open. This
compares two clocks of one machine; the runtime container shares the host
clock.

**B**, the background work a Claude turn that ended still waits on
(`pendingBackgroundTaskNames`, within `BACKGROUND_TASK_WAIT_LIMIT_MS` of the
newest work, as on the branch).

**The table**, read top to bottom; every combination of H and S lands on a
row:

| # | H | S, A | Decision | Turn recorded |
| --- | --- | --- | --- | --- |
| 1 | `unreadable` | any | **Undecided** | — |
| 2 | any | S `unreadable` | **Undecided** | — |
| 3 | `open T` | A false | **Cut.** The host started T and nothing ended it. | T |
| 4 | `ended`, or `open T` with A | — | **Cut** iff B is non-empty; otherwise no cut | null |
| 5 | `none` | S `open` | **Cut.** The CLI's own record shows a turn started and unended. | the row's turn word, if live |
| 6 | `none` | S `closed` | **Cut** iff B is non-empty; otherwise no cut | the row's turn word, if live |
| 7 | `none` | S `empty` or `unknown`, a launched stage attempt | **Cut.** The launch started the attempt and nothing ended it. | the row's turn word, if live |
| 8 | `none` | S `empty` or `unknown`, otherwise | **No cut.** No durable record shows a turn started. | — |

A production row whose host ran a turn reaches rows 1-4: every turn a
structured host starts, a spawn's first prompt and a stage launch included,
goes through `EngineHost.send` and so through the ledger. Rows 5-8 decide
conversations whose host recorded no turn: a host that never started one, a
row from before the ledger existed, and every existing test fixture (no fake
host writes a ledger). They keep the branch's transcript decisions with the
C5 and C6 corrections. The branch projects the full tail, and the filter
reads differently from it only where bookkeeping trails the work. No existing
fixture holds `turn_aborted`, a meta prompt or an interrupt or shutdown
marker, and the one synthetic no-op sits in a conversation its owed release
record postpones, so every existing case keeps its outcome.

The same rule is what an orderly release applies at the moment it hands a host
over (`handOverHostForDemotion`, `structuredDeliveryController.ts:2031`): the
live host's own state is the freshest evidence there is, so an active host is a
started, unended turn, and an idle Claude host is cut iff it still waits on
background work. That path stays as it is.

### What a decision produces

**Cut.** One record through `store.record` with `owner: null`, `turnRef` as
the table says, `boundary: viewer-restart:<w|launch>` where w is the newest
work record's time, and `checkpoint` = that record's kind and time plus the
background tasks for rows 4 and 6. A pipeline member is recorded `discharged`
with `STAGE_CUT_RESOLUTION`, a review-flow reviewer with its flow's
resolution; every other cut is `owed`. Then, unchanged:

- an owed record forces its row's adoption and gets one continuation keyed by
  the record id (`deliverInterruptionContinuations`);
- several owed records of one conversation collapse to the newest, which
  carries the one message; the older ones are discharged with that reason;
- the pipeline engine reads the newest record through `conversationRestartCut`
  and spends the stage's one fresh attempt (`engine.ts:4161-4200`);
- the deploy inventory lists the record.

**No cut.** Nothing is written. The row follows the existing adoption rules.

**Undecided.** See "Unresolved evidence". It never produces a record.

**The generic Codex nudge** (`enqueueInterruptedCodexContinuations`, keyed by
claim epoch) never answers a row whose decision in this process was cut or
undecided, a row with an unresolved record, or a pipeline member. It remains
for rows the rule does not ask (this process's own rows after a runtime-host
replacement) and for rows the rule answered "no cut" on an uncorroborated turn
word (row 8), which existing startup cases still expect it to resume.

### Identity across boots

A cut is named by `(conversation, host row, recorded turn, w or launch)`. That
tuple is the record id's input, as on the branch. Two observations are the
same cut exactly when the tuple matches:

- `store.record` returns an existing record under the same id in whatever
  state it reached;
- for an owner-less restart record, coverage of another record is tuple
  equality: same conversation, host row, `turnRef` and
  `checkpoint.lastEventAt`. The `recordedAt` comparison and the
  resolved-with-another-turn branch go. Release and seat records keep their
  coverage by owner and turn. A release record names the host's active turn
  and the same work checkpoint (`recordDemotionInterruption`,
  `structuredDeliveryController.ts:1972-1997`), so a release record and a
  restart record of one turn carry one tuple.

A later boot that finds the same silent turn lands on the same record and
sends nothing. Exit bookkeeping moves neither the turn nor w. A message that
started another turn changes the ledger's newest `turn-started`, and genuine
work changes w, so either one is a cut of its own.

### Unresolved evidence

An undecided row is:

- **held**: no adoption for a turn claim, no skipped-host demotion, no generic
  nudge. Pending work (a held delivery or a pending runtime operation) waits
  as well, until the re-probe below reaches its cap;
- **re-probed**: its host key joins the startup deferral that already holds
  rows behind unresolved pipeline evidence (`DeferredStructuredStartup`,
  `startup.ts:83-98`, `:1948-2018`). That re-probe runs on an unref'd timer
  from one second, doubling to thirty. It now also re-reads each undecided
  row's ledger and transcript tail, and when one of them reads whole it reruns
  the pass for the deferred rows (`startStructuredHostPass(dependencies,
  hostKeys)`), which bypasses the cached ready result. That pass decides the
  row before its adoption step, so a cut is recorded and continued once in the
  same Viewer, with no second restart needed (C4);
- **reported**: the deferral message (`structuredStartupDeferral`) names it,
  as it names rows held for pipeline evidence;
- **never recorded**.

Once the backoff has reached its thirty-second cap (about a minute in all) and
the row still cannot be read, pending work adopts it as #1281 allows today,
and nothing is recorded: the retry has happened, and the pending message is
what takes the conversation up. A row without pending work stays held and
re-probed for as long as this process lives, and the next Viewer asks it
again, since it is still the predecessor's.

The usual source of an uncertain read is a predecessor engine that outlived
its Viewer and is still appending: the transient case round 5 F3 reproduced.
The re-probe answers it in the same process. A tail that stays uncertain, such
as one ending on a record a kill cut short, stays held; see Deferred.

## Finding map

| Finding | What failed | Clause that decides it | Status at `57b174379` | Test |
| --- | --- | --- | --- | --- |
| R4 F1 | A spawned Claude agent cut before its first transcript record got no continuation | H `open T` (the ledger in production; the row clause on a never-observed transcript in the fixture), row 3 | Fixed (`firstTurn`); kept as H's row clause | Existing: "a spawned Claude agent cut before its first transcript record is resumed once across repeated boots"; "an agent's row …, its transcript holding no record, records nothing" |
| R4 F2 | A turn an operator resumed was swallowed by the discharged record of the earlier cut | The decision reads no earlier record; the tuple carries the new turn, so it is a new cut | Fixed by a special branch in `coversSameCut`; the build replaces it with tuple equality | Existing: "a turn an operator resumed after a cut, cut again before its transcript shows it, gets its own one continuation" |
| R4 F3 | A claim renamed during the deploy inventory gave a passing empty list | Outside recognition: the inventory lists every record or reports it moving | Fixed in `scripts/deploy-checkout.py` | Existing: `scripts/deploy_checkout_test.py` |
| R4 F4 | A native shutdown marker erased the cut attempt's last report | Shutdown markers are bookkeeping: neither the turn's end nor its last word | Fixed (`cutProse`, `cutAttemptReport`) | Existing engine cases |
| R5 F1 | A later accepted turn was lost when the restart preceded its prompt echo | Ledger: `turn-ended T1`, then `turn-started T2`; H `open T2`, no completion after the ledger's newest record: row 3 | **Open** | New, release seam |
| R5 F2 | A Codex shutdown `turn_aborted` hid the cut from the agent and from the stage witness | `turn_aborted` is bookkeeping in S and never an end of H: row 3 with a ledger, row 5 without | **Open** | New, release seam |
| R5 F3 | One uncertain read dropped the cut, then the row was adopted | Rows 1-2: held, re-probed, decided in the same process | **Open** | New, release and startup seams |
| C1 | An old preceding close aged a fresh T2 out of the window | The window dates the newest durable activity: the ledger's newest record is T2's start or later | **Open** (the branch dates by the same old work record) | New, release seam |
| C2 | The acknowledgement time cannot order a turn's start against a close | No receipt time is read; the ledger orders start and end, and A compares a completion with the host's last record | Revision 1 only | New, release seam: delayed acknowledgement; queued T2 |
| C3 | The eight-receipt window can drop the start evidence | No receipt is read; the ledger keeps every entry | Revision 1 only | New, release seam: nine later queued sends |
| C4 | An uncertain read was left for the next restart | The deferral re-probe re-enters recognition before adoption | **Open** (revision 1 deferred it) | New: controlled scheduler, release and startup seams |
| C5 | The work slice dropped undated completions and invented a cut | S removes bookkeeping record by record and keeps undated completions | Revision 1 only (the branch projects the full tail) | New: both native shapes, release seam and liveness |
| C6 | A readable tail projecting `unknown` fell through the table | S has an `unknown` value; rows 3, 7 and 8 decide it | Revision 1 only (the branch's expression covers it implicitly) | New: reasoning-only tail, release seam and liveness |

Rounds 1-3 each landed a test that the map below keeps.

## Existing test map

No existing fixture writes a host ledger, so every existing case is decided by
H's row clauses or by H `none`. The outcomes below are the ones each case
asserts at `57b174379`.

### `src/lib/runtime/releaseInterruption.test.ts`

Every case stays and passes unchanged.

| Case | Decided by |
| --- | --- |
| claude/codex: cut mid-tool by a Viewer release resumes once … | Release applies the rule to the live host; the boot postpones the conversation while that record is owed, and afterwards the adopted row is `idle`: row 4, B empty |
| a cut turn stays owed while runtime-host succession lags … | Release record; the boot postpones while it is owed |
| failed demotion cleanup keeps the obligation … | Release record; delivery waits for adoption of the survivor's row |
| a turn cut on a host startup adopted but never published … | The retrying boot records its cut (row 5), the release records its own; the newest owed record carries the message |
| an obligation the release cannot write to its directory … | Release record via the pending journal |
| a host whose obligation cannot be recorded anywhere … | Release path, unchanged |
| restarts between recording, admitting and recording the admission … | Record id keys the delivery |
| provider recovery bookkeeping written after the cut … | The owed release record postpones the decision, so the replayed prompt is no new cut |
| a message that reaches the cut conversation first …; a send the runtime admitted before …; a send the runtime admits while … | Discharge by a newer message, unchanged |
| a seat cut by the deploy it requested …; a seat rotated …; a seat that names an alias … | Seats are outside this capture |
| an unpublished host the release cannot hand over …; one published host failing its health probe … | Release records; restart records of the retrying boot are filtered out of the assertion |
| a submitted continuation whose reservation was compacted away … | Settling before capture |
| the pipeline engine reads a continuation the successor submitted as arrived … | Engine port, unchanged |
| persistent update drain …; a pending spawn's first prompt … | Outside the rule |
| a spawned agent whose turn a service restart cut is resumed once … | Row 5; the next boot finds the row the first one adopted, now `idle`: row 4, B empty |
| a spawned agent waiting on background work the restart killed … | Row 6, B non-empty: cut |
| a pipeline stage a restart cut gets no continuation … | Row 5, stage: witness |
| a restart that finds an agent's turn already settled … | Row 6, B empty (the notice arrived): no cut |
| an idle Claude agent whose ended turn still waited on background work … | Row 4 from the `idle` row, B non-empty: cut |
| an agent resumed after one restart and cut mid-turn by the next … | Row 5 with a new turn word and a new w: a second tuple; the third boot finds the same tuple |
| a spawned Claude agent cut before its first transcript record … | H `open T` from the row (never observed), S `empty`: row 3 |
| an agent's row idle / live with no turn named / naming a turn observed before | Row 4 with B empty; row 8; row 8 |
| a turn an operator resumed after a cut … | Release record discharged by the send; then row 5 under the operator's turn: cut, once |
| a Codex agent's restart cut is continued once across repeated boots … | Row 5, same tuple each boot; nudge suppressed for a cut decision |
| codex/claude pipeline stage gets no continuation from any path | Witness; nudge suppressed for pipeline members |
| an orderly release of a pipeline stage leaves its cut to the stage controller | Release record discharged as a stage cut |
| Codex exit bookkeeping after a cut owes no second continuation … | Token counts move neither the turn nor w; the resumed turn has a new tuple |
| claude/codex turn a delivered continuation started, cut before its transcript echoed it … | Row 5 under the continuation's turn word: cut; later boots find the same tuple |
| a stage whose turn a provider failure ended before the restart | Provider close: S `closed`, B empty: no cut |
| an orderly release resumes an idle Claude agent waiting on background work …; … with nothing in the background records nothing | Release path |
| a stage transcript truncated / corrupt proves no restart cut | Row 2: undecided, no record, the row held. These boots must pass a controlled `schedule`, so the re-probe timer cannot outlive the case |
| a stage cut at launch, its transcript empty / not written / launch-only … | Row 7: witness, one record across boots |
| a predecessor Viewer whose pid this process was given … | Whole-identity comparison; the second boot's row is this process's own claim |

### `src/lib/runtime/startup.test.ts`

The rule decides these cases, with the same outcome as at `57b174379`:

| Case | Decided by |
| --- | --- |
| a busy Codex turn advances after container replacement without operator messaging | Row 5: cut. After the replacement Viewer, the continuation's echo moved w, so a second tuple and a second, different restart continuation |
| unknown Codex durable state continues when the structured host retains an active turn | Row 8 (observed, empty): no cut; the generic nudge resumes it |
| unknown Codex durable state continues from runtime-running evidence | Row 8: no cut; the generic nudge resumes it |
| terminal / superseded Codex conversation stays outside startup continuation | No cut / not asked |
| startup adopts a persisted terminal conversation whose transcript starts a new turn before restart | Row 5: cut; the owed record keeps the expected adoption |
| startup keeps a live turn open when its transcript ends on an API error, a synthetic record or an error event | These run only `startupAdoptionAttempts` and assert the turn word; the capture is not involved |
| startup keeps a Codex host eligible when the bounded tail cuts off an unmatched tool call | Adoption filter only |
| a clean / production-shaped / 128 KiB-aligned terminal transcript stays retired across repeated startup | Row 6, B empty: no cut |
| a repeated promotion reuses one pending Codex continuation; startup retries a failed Codex continuation …; … same-epoch …; startup preserves a queued user draft … | Transcripts dated outside the age window: not asked; the generic nudge cases are unchanged |
| malformed JSON / truncated record / growing tail / missing / unreadable path cases | Outside the age window, or undecided and held; both give no adoption, as the cases expect |
| an explicit terminal transcript outranks a stale running runtime projection | Not asked (age window); no cut either way |
| deferred pipeline evidence completes the pass … re-probes only the evidence until it moves (#1501) | The deferral gains a second kind of held row; this case holds none, so its re-probe cadence is unchanged |

Every other `startup.test.ts` case (seat recovery, claim and retry mechanics,
MCP grants, spawn receipts, demotion) involves rows the rule does not ask
(seats, this process's own claims, dead or unhosted rows, transcripts outside
the age window) or rows it decides as `57b174379` does. The build confirms
this by running the whole file by path; a case that changes outcome is a
finding against this design, to be reported before any expectation is edited.

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
  the unpublished release path through `handOverHostForDemotion`, and the
  `firstTurn` condition, which becomes H's row clause.
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

- `resumedTurn` and the `inFlight` expression (`startup.ts:470-485`); the
  decision table replaces them.
- `restartCutsRecorded` and `recordedCuts` (`startup.ts:66-70, 1494-1501`);
  per-row decisions in the pass state replace them.
- `cutsAnsweredByRecord` and `lastWorkByHost` (`startup.ts:822-841,
  1015-1017, 1547`); the nudge reads the decisions.
- `coversSameCut`'s resolved-with-another-turn branch and its `recordedAt`
  comparison for owner-less restart inputs
  (`interruptionObligations.ts:180-189`).
- From revision 1's plan, never built: the delivery-receipt read through
  `readSession`, the interrupt-receipt exception, the work-slice projection and
  the three-read loop inside the pass.

Changes:

- `eventStore.ts` or `liveness.ts`: `hostTurnRecord(sessionId)` answers H from
  the ledger (`open T`, `ended`, no turn, or unreadable) and the ledger's
  newest record time. It reads through `FileRuntimeEventStore.load`, the read
  the successor's adoption performs on the same file moments later; the
  store's process-wide ledger cache (64 MiB) serves that second read while
  the file is unchanged.
- `liveness.ts`: `transcriptCutEvidenceFromRecords` projects S over the work
  records (bookkeeping removed, nothing sliced), reports `empty` and
  `unknown` apart, and lists the dated completions for A. A pure
  `restartCutDecision(input)` implements the table.
- `startup.ts`: `restartCutTargets` gathers H, S, A, B and the stage for each
  asked row and applies the decision; it returns cuts and undecided rows. The
  pass records cuts, keeps every decision per host key, adds undecided rows to
  the deferral, and holds them from adoption, demotion and the nudge. The
  deferral's probe re-reads their evidence and admits pending work at its cap.
- `interruptionObligations.ts`: tuple coverage for owner-less restart inputs.

## Build plan

Each step is test-first: the new case runs red on `57b174379` before the code
changes. New cases write the host ledger through `FileRuntimeEventStore` in
the case's isolated state directory, which is the store and the file a real
host writes; existing cases keep their fixtures. `successorBoot` passes a
recording `schedule` in every case, so no deferral re-probe ever reaches a
real timer or runs after its case restored the environment; a case that
exercises the re-probe runs the recorded callbacks itself.

1. **Tests.**
   - `releaseInterruption.test.ts`, R5 F1 and C1: a Claude conversation whose
     first turn closed seven hours ago, a ledger holding `turn-started T1`,
     `turn-ended T1 completed`, `turn-started T2` (the operator's send, through
     the existing operator-resume flow), the row live with T2, and boots before
     the prompt echo: one record naming T2 and one continuation across three
     boots. The same case without `turn-started T2` records nothing.
   - C2: (a) delayed acknowledgement: the ledger holds T's start and its
     `completed` end, the transcript closes T, the row still reads live with T,
     and the operator's receipt is delivered after the close: nothing. (b)
     queued turn: T2's send is acknowledged while T1 runs, T1 closes, the
     ledger holds `turn-ended T1` then `turn-started T2`, and the restart lands
     before T2's echo: exactly one continuation.
   - C3: case (b) with nine later queued sends to the same conversation, so
     the session's eight receipts no longer include T2's: the same one
     continuation.
   - R5 F2 (`test.each` agent / stage): the mid-tool Codex transcript plus a
     dated `turn_aborted`, a ledger holding `turn-started T`, no release record.
     The agent gets one continuation and the stage one discharged witness
     (`conversationRestartCut` set, no engine write), each once across
     repeated boots. With `turn-ended T interrupted` in the ledger (an
     interrupt the host served): nothing. Without a ledger: the same cut, by
     row 5.
   - R5 F3 and C4, with a controlled `schedule` passed through `successorBoot`:
     the transcript ends on a partial line during the boot, so the row is
     undecided, held and listed by `structuredStartupDeferral`; the line is
     then finished and the scheduled re-probe runs: one record, one
     continuation, in the same process, and nothing more on further probes. A
     line that stays corrupt: no record and no adoption across probes; with an
     operator send waiting, the send is delivered once the backoff reaches its
     cap, and still no record.
   - C5: a Claude dated prompt with an undated provider `end_turn`, and a
     Codex dated `task_started T` with an undated `task_complete T`, each with
     the row live naming T and a delivered receipt: nothing, both with no
     ledger and with a ledger holding T's start and end.
   - C6: a Codex tail holding only a dated reasoning item. With
     `turn-started T` in the ledger: an agent continuation and a stage witness.
     With no ledger: an agent records nothing; a stage records its witness.
   - `liveness.test.ts`: the decision table as pure cases, one per row and per
     S value, plus A with a dated completion after the ledger's newest record,
     one before it, and an undated one.
   - `startup.test.ts`: an undecided predecessor row is held out of
     `startupAdoptionAttempts`, appears in `structuredStartupDeferral`, and is
     decided and adopted by the re-probe pass once its tail reads whole.
2. **`eventStore.ts` / `liveness.ts`.** `hostTurnRecord`, the S projection
   with its five values, the completions for A, and `restartCutDecision`.
3. **`startup.ts`.** Recognition in every pass for the asked rows in its
   scope, decisions per host key in the pass state, undecided rows held and
   deferred, the deferral probe extended, pending work admitted at the cap;
   delete the code listed under "Goes".
4. **`interruptionObligations.ts`.** Tuple coverage for owner-less restart
   inputs.
5. **Gates**, from the specification: the touched test files by path with
   private `HOME`, `TMPDIR` and `LLV_STATE_DIR` and `LLV_VIEWER_CONTROL_URL` on
   a closed port (`releaseInterruption`, `startup`, `liveness`,
   `interruptionObligations`, `eventStore`, `structuredDeliveryController` and
   the engine file if touched), never a sweep of `src/lib/agent` or
   `src/app/api/runtime`; `tsc`; `eslint`; the privacy gate from the merge
   base; `bun scripts/verify-runtime-host.ts --runtime "$(which bun)"` in its
   private state; merge `origin/main` before the push.

Expected size: about 170 lines added and 120 removed in product code, with the
tests on top.

## Options considered

- **Keep patching each shape.** Rejected: five rounds show that each patch
  leaves the premise that produces the next finding.
- **The delivery receipt as a turn's start (revision 1).** Rejected by the
  critique: the journal stamps `at` when the queue records the outcome, which
  can follow the turn's end (C2), the session presents only its eight newest
  receipts (C3), and the read needs a runtime client that can fail (C4).
- **The runtime journal's `turn-started` / `turn-ended` events.** Rejected:
  the Viewer publishes them to the runtime host from the same host events, on a
  best-effort chain, after the host ledger already holds them; a stale
  `running` projection already outlives its host (startup case "a stale
  runtime-running projection cannot revive an idle registry host").
- **The host ledger.** Chosen: written first, fsynced, ordered, keyed by the
  engine's turn, kept whole, and read locally.
- **A transcript key for Claude turns.** The Claude delivery ledger binds a
  delivery to the transcript record that echoed it, which would let the
  transcript name a Claude turn the way `turn_id` names a Codex one.
  Rejected: A already answers the case it would serve, a CLI that finished
  after its host stopped recording, without a second file or a key.
- **The row's `updatedAt` as the host's last record.** Rejected: claims and
  cursor writes move it. It dates the window only where nothing else exists.
- **Hold undecided rows only from turn-claim adoption**, letting pending work
  adopt them at once. Rejected: the specification requires the retry before
  the predecessor's ownership is replaced. Holding pending work for as long as
  the row stays unreadable was rejected too: a send to a conversation whose
  tail ends on a torn record would then never arrive.

## Residual risks

- An engine that outlived its Viewer can finish its turn after this decision
  and before adoption terminates it (`terminateVerifiedStructuredOrphan`).
  The cut is then one continuation too many, telling the agent to inspect its
  transcript. A stage controller re-checks: a cut counts only when the
  attempt's newest work precedes the record (`restartCutOf`), so the stage
  keeps its result.
- During a deploy the successor can decide a row while the incumbent still
  holds it. A turn that ends between that decision and the incumbent's release
  gets the same one extra continuation, under the same stage re-check. A turn
  still running is recorded by both and collapses to one continuation.
- A completion written in the milliseconds between the CLI's transcript write
  and its host's ledger append, or an undated completion of a turn the host
  holds open, reads as a cut, and the agent gets one extra continuation.
- A tail that stays unreadable holds its row; pending work adopts it after
  about a minute without a record, and a row without pending work waits for a
  readable tail or the next Viewer.
- The ledger's modification time comes from the host's file system and
  transcript times from the CLI. Both run on one machine; the container shares
  the host clock.

## Deferred — not currently justified

- **Seats under this capture.** `orchestratorRestartRecoveryTargets` decides a
  seat by `conversationTurnLiveness`, whose turn axis reads the full
  transcript, so a Codex seat whose shutdown wrote `turn_aborted` would read
  settled. No finding names seats, and their tests encode process evidence
  (#1276, #1281). Revisit when a Codex seat is seen cut this way.
- **An in-process re-probe for undecided rows.** Revision 1 deferred this. The
  critique's C4 showed the bounded re-read leaves a row stranded until another
  restart, so it is now part of the rule (the deferral re-probe), and the
  three-read loop it would have backed is dropped.
- **A turn the CLI starts by itself after its host recorded the previous
  end**, such as a Claude task notification waking the agent, or a Codex
  app-server that outlived its Viewer dispatching a natively queued message.
  The host never recorded such a turn, and the transcript cannot tell it from
  a turn the host saw interrupted (both read open once the abort or the
  interrupt marker is set aside), so the rule decides it by B, as the branch
  does. No finding names it. Revisit when one is seen lost; Codex `turn_id`
  would tell the two apart.
- **Deciding past a torn final transcript record.** A kill can cut a
  multi-page write short, and the stable tail reader then reports the tail
  uncertain for good. Reading the records before an unterminated final line,
  as the host ledger does, would let such a row be decided. Not seen in
  production; revisit when a deferral report names a row held this way.
- **Asking only rows whose predecessor can no longer act on them.** Deciding
  inside the claim path, after the predecessor Viewer and its engine are gone,
  would remove the first two residual risks. It moves the decision into both
  engines' adoption loops (`runtime/registry.ts`). Revisit if extra
  continuations are reported after deploys.
- **Retiring the generic Codex nudge.** It still serves this process's own
  rows after a runtime-host replacement, which the rule does not ask.
- **Runtime-host succession cuts of this process's own rows under the same
  rule.** Today they are covered by the nudge and by #1747's stage recovery.
- **Journal turn events as end evidence** (see Options). The host ledger now
  serves that role from the source that writes first.

## Check against the requirement

- (1) A stage cut by a restart: the rule records a witness for every turn the
  host started and nothing ended, including a later turn before its echo (R5
  F1, C1-C3) and a Codex turn whose shutdown wrote an abort (R5 F2). The
  engine spends the one fresh attempt in the same worktree, and a second cut
  parks.
- (2) An agent cut mid-turn or mid-wait: one continuation per cut, naming the
  background work it was waiting on, deduplicated across boots by the tuple.
- (3) The deploy verdict lists each record; the cuts R5 F1-F3 and C1-C6 lost
  now produce records, so they are listed too.
- Unresolved evidence is retried in the same Viewer before the row is
  replaced, and never yields a record (R5 F3, C4).

No question for the operator remains: the code, two scratch probes against
the unchanged helpers and store, and the review records settled every fact
this design rests on.
