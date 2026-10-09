# Restart cut recognition: one rule

Status: revision 3 of the design for PR #2570, written against the code at
branch head `57b174379` (2026-10-07), and built on this branch; "Build notes"
at the end records where the build settled a detail this text left open. Revision 1 (`87d190109`) dated a later
turn by the runtime receipt that acknowledged its delivery; a first critique
found six blockers (C1-C6 in the finding map). Revision 2 (`eb027b54f`) moved
to the engine host's own event ledger and answered those six; a second
critique found five more (D1-D5). This revision answers all five and keeps the
answers to C1-C6. Lane 66251dff closed after five review rounds; its rebuild
follows the rule below.

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
round 5 findings and the eleven critique findings below. Everything in this
document serves requirement items (1) and (2); item (3) is served by the
records the rule writes, which `scripts/deploy-checkout.py` already lists.

## Why five rounds kept finding the same defect

`restartCutTargets` (`src/lib/runtime/startup.ts:425-505`) decides "was this
turn cut" by starting from the shared transcript projection
(`busy`/`terminal`) and adding exceptions as reviews found shapes it misread:

- `resumedTurn` (`startup.ts:475-477`) accepts a terminal transcript only when
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

Revision 1 swapped those premises for one of the same kind: it ordered a
turn's start against the transcript's close by the time the runtime journal
stamped the delivery acknowledgement, which can follow the turn's end (C2), and
read it from the session's eight newest receipts (C3).

Revision 2 put the host's own ledger in the right place and then tied it to
the transcript with a clock: a completion counted for the open turn when it
was dated after the ledger file's last write. A record with no date could not
be placed (D5). The cut's name still carried the transcript's newest work
time, which moves when a record is published late (D4). A turn the CLI begins
by itself after its host recorded an end had no row in the table (D3). The
ledger was read through the store's `load`, which hands back what it read even
when the file grew under the read (D1), and each decision was kept for the life
of the process (D2).

This revision ties the two files by identity. Every frame the Claude host
records carries the `uuid` of the same record in the transcript, and every
Codex lifecycle record names the turn the host recorded. A turn's own records
are found by name and by file order, and no clock orders a start against an
end.

## The rule

### The host's own turn record

Every structured engine host appends its events to
`structured-host-events/<session id>.jsonl` under the state directory
(`FileRuntimeEventStore`, `src/lib/runtime/eventStore.ts`). Four properties
make it the evidence the specification asks for.

- **It names the turn and orders it.** `turn-started {turnId}` and
  `turn-ended {turnId, status}` carry the engine's own turn identity (the
  app-server's turn id for Codex, the delivery id for Claude), each with the
  next sequence number. Claude writes `turn-started` when it hands the prompt
  to the CLI, and for a prompt queued behind a running turn it writes it right
  after that turn's `turn-ended`, when the CLI's `result` arrives
  (`claudeStreamBrokerHost.ts:990-995`, `:1486-1524`). Codex writes both from
  the app-server's `turn/started` and `turn/completed` notifications
  (`codexAppServerHost.ts:3976-3986`, `:4035-4056`).
- **It is written first.** `emit` appends and fsyncs the event before any
  subscriber or state listener sees it (`claudeStreamBrokerHost.ts:1299-1324`,
  `codexAppServerHost.ts:3118-3162`, `eventStore.ts:344-373`). The registry
  row is written by one of those listeners (`runtime/registry.ts`
  `bindStructuredHostPersistence`), so whatever the row says, the ledger said
  first.
- **It keeps every entry of the session.** One file per session, appended only
  by the host that holds the claim, never cut to a window and never pruned. An
  unterminated final line is a write the crash cut short and is no record.
- **It indexes the transcript.** The Claude host records every `user` and
  `assistant` frame the CLI emits as an `item` event holding the whole frame,
  under the turn it had open or under none
  (`claudeStreamBrokerHost.ts:1378-1430`). The frame carries the `uuid` the CLI
  gives the same record in the transcript. The Codex rollout's lifecycle
  records (`task_started`, `task_complete`, `turn_aborted`, `turn_context`)
  carry the host's turn id as `turn_id`.

The last property was measured on this machine's own ledgers and transcripts
on 2026-10-07, read-only, counts only:

| Measured | Result |
| --- | --- |
| Claude frames recorded in 2,023 ledgers | 154,751: every one carries `uuid` and `timestamp` |
| Recorded frames found in the transcript by `uuid`, 744 ledger and transcript pairs | 152,864 of 154,739 |
| The 1,875 frames with no transcript record | 1,857 task notifications, which the stream replays under a fresh `uuid`; 18 others, 10 of them the last frames of a ledger: emitted and never written |
| Frames whose ledger order differs from their transcript order | 0 |
| Codex ledger turns with a rollout `task_started` of the same id, 664 pairs | 728 of 728 |
| Rollout `task_started`, `task_complete`, `turn_aborted` records carrying `turn_id` and `timestamp`, 600 rollouts | 1,346 of 1,346 |
| Codex turns with no host end and a `turn_aborted` naming them (round 5 F2's shape) | 19 |
| Codex turns the host ended `error` whose rollout holds a `task_complete` naming them | 4 |
| Claude ledgers holding frames recorded under no turn (D3's shape) | 72; none of those frames follows an `interrupted` end |
| Claude turns ended `interrupted`: the interrupt marker is the last frame recorded before the end | 51 of 51 |

A host closes its newest turn in the ledger three ways: a `turn-ended` for
that turn, written from the CLI's `result` (Claude) or `turn/completed`
(Codex); a `session-status` of `dead` or `unhosted`, when the host stops
hosting; and the `turn-ended … error` an adopting host writes for a turn it
finds open (`claudeStreamBrokerHost.ts:1227-1251`,
`codexAppServerHost.ts:3265-3288`). The hosts' own `restore` reads the ledger
the same way.

One end is missing from the Claude ledger: the end of work the CLI began by
itself. A `result` that belongs to no host turn is dropped (`acceptResult`,
`claudeStreamBrokerHost.ts:1486-1498`). The transcript answers that end.

### Who is asked

A conversation is a candidate when all of these hold:

- its engine is Claude or Codex, it is not superseded, and it is not an
  orchestrator seat (seats keep their own capture, see Deferred);
- its current generation's row is a structured host with no pane (`host ===
  null`), with status `live`, or `idle` for Claude;
- the row's claim belongs to another process, compared by whole identity, or
  to none (`sameRecordedProcessIdentity`, round 2 F5).

A candidate is asked when two more hold:

- no record of a cut of this conversation is still unresolved after arrivals
  are settled (`owed`, or `submitted` without arrival). That record already
  owns the conversation's next message; whatever was written since it is its
  bookkeeping or its continuation's turn. This only postpones the question;
  the decision itself never reads earlier records. A restart record that is
  still a proposal postpones nothing (see "A cut is a proposal until the row
  is taken");
- its newest durable activity lies inside the adoption age window
  (`LLV_HOST_ADOPTION_MAX_TURN_AGE_HOURS`, default 6 h). The activity is the
  newer of the host ledger's last write and the transcript's newest dated
  work record; when the conversation has neither, the row's last update (C1).
  A ledger that reads unreadable, or a transcript whose tail is uncertain, is
  dated by its file's last write, since its newest record cannot be read; a
  file that cannot be dated at all is never provably old. Such a row is asked,
  lands on row 1 or 2, and is held and re-probed below.

Every startup pass asks the rows in its scope before it adopts, demotes or
nudges any of them: the first pass, a startup retry, a runtime-host
replacement pass, and the deferral re-probe below. A decision belongs to the
pass that made it; no later pass reads it (D2). The evidence is all local
files, so a pass without a runtime client decides as well as one with.

### The evidence

| Evidence | Writer | Read as |
| --- | --- | --- |
| Host ledger | The engine host, before anything else learns of the event | H, the host's newest turn and how the host closed it; the frames and turn ids that tie the transcript to that turn |
| Transcript tail | The engine CLI | R, the engine's own record since the host's newest boundary; w, the newest dated work record |
| Registry row: status, `activeTurnRef` | The Viewer, from host state, after the ledger | Who is asked; H only where the ledger holds no turn |
| Registry observation source | The registry | `turn.source === "empty"`: no record of this transcript was ever observed |
| Pipeline membership | The pipeline engine | The conversation runs a launched stage attempt |
| Background ledger | The engine CLI's tool results and notices, and the continuation prompts Delegatus sent | B, harness background work launched and not reported ended (Claude) |

Nothing else is read. Runtime receipts and interrupt receipts are out of the
decision (C2, C3), earlier cut records only postpone it, the ledger file's
clock orders nothing against the transcript except in the one case named
below, and the marks a dying CLI writes (Codex `turn_aborted`, Claude shutdown
and interrupt markers) are never read as an end.

### The decision

**H**, from one stable read of the ledger (see "Evidence that can still
move"):

- `open T`: the newest `turn-started` names T and the host closed T in none
  of the three ways.
- `closed T`: the host closed T.
- `none`: the ledger holds no turn, or there is no ledger. The row is read in
  its place (rows 7-12).
- `unreadable`: the file moved under the read, or a record the decision needs
  cannot be parsed.

A host's own close ends T whatever its status, because the host writes one
only while it is alive and holds the claim. An interrupt the host served and
an abort the engine reported to it are real ends. The `turn-ended … error` of
an adopting host is written after that boot decided the row, so it closes a
turn whose cut is already on record, and the record's name (below) makes a
later boot land on it.

**R**, the engine's own record since the host's newest boundary: a slice of
the transcript tail (`readStableTailRecords`, 128 KiB), projected by the
shared projection (`turnStateFromRecords`, as the branch calls it) after the
bookkeeping a CLI writes as it exits or resumes is removed record by record.
That bookkeeping is Codex `token_count` and `turn_aborted`, and for Claude
meta prompts (`isMeta`), shutdown and interrupt markers, and the synthetic
"No response requested." no-op, the same shapes `lastAgentWorkIndex` passes
over. A Claude turn the provider closed (`claudeTurnClosedByProviderFailure`)
reads closed; its recovery is the provider's (round 3 F1). R reads `open`,
`closed`, `empty` (no work record), `unknown` (work records and no turn
boundary), `unreadable` (the stable tail read is uncertain) or `undelimited`
(the slice cannot be found).

The slice is found by identity:

| H | Claude | Codex |
| --- | --- | --- |
| `open T` | The records after the anchor: the newest tail record whose `uuid` the ledger holds in a frame recorded before `turn-started T` | The records from T's own start record on (`task_started` naming T) |
| `closed T` | Of the records after the anchor (the newest tail record the ledger holds in a frame recorded before the event that closed T), those from the first sign that the engine began again: a task notification, or an assistant record the provider wrote. With no such record R is `empty` | `empty`: a turn the app-server starts is a host turn while its host records, and Codex holds no background work |
| `none` | The whole tail | The whole tail |

Where the anchor is missing from the tail:

- The tail starts mid-file (`prefixTruncated`) and the ledger holds earlier
  frames: the anchor lies above the tail, so all of the tail is after it.
- The tail is the whole transcript and the ledger holds earlier assistant
  frames: the two files disagree and R is `undelimited`.
- The ledger holds no frame before the boundary: the slice starts at the first
  tail record the ledger holds as a frame recorded after it. When it holds
  none of those either, the host recorded nothing of this transcript, and the
  slice is the records dated after the ledger file's last write; an undated
  work record then makes R `undelimited`. This is the one place a clock is
  read, and both clocks are this machine's.
- Codex: a tail that never names T holds nothing of T, so R is `empty`. A
  tail that names T with T's start record above it is all T's. A lifecycle
  record that names no turn is placed by file order after T's start record,
  and makes R `undelimited` when the tail does not hold that record.

Two details follow from the measurements. Task notifications never match by
`uuid`, so they are skipped when the anchor is sought and found in the
transcript by their own shape (`taskNotifications`,
`pipelines/backgroundTasks.ts`). And a frame the host recorded can be missing
from a tail that reaches back to the anchor, when the CLI was killed between
its two writes: when that frame is the newest assistant frame recorded under
no turn after the close, the engine had begun again and nothing closed it, so
R is `open`.

A scratch probe with the unchanged shared projection over such slices, the
bookkeeping removed (`busy` is shown as open, `terminal` as closed, and a
slice with no record as empty):

| Slice | Reads |
| --- | --- |
| Claude, after a closed turn: task notification, then a tool call | open |
| Claude, the same follow-up finished (tool result, provider `end_turn`) | closed |
| Claude, after a closed turn: a task notification alone | open |
| Claude, an open turn's own records: tool call, tool result, undated provider `end_turn` | closed |
| Claude, an open turn's own records: tool call, then a shutdown interrupt marker | open |
| Codex, T's own records: start, tool call, `turn_aborted` naming T | open |
| Codex, T's own records: start, undated `task_complete` naming T | closed |
| Codex, a reasoning item alone | unknown |
| Either engine, no record | empty |

**B**, the background work a Claude turn that ended still waits on
(`verifiedBackgroundWork`, within `BACKGROUND_TASK_WAIT_LIMIT_MS` of the
newest work). Empty for Codex. Two properties make it evidence a cut can rest
on.

- **It is read whole or it is `unreadable`.** A task launched hours of output
  ago lies above the 128 KiB tail, so B folds the whole transcript: one
  descriptor from the first byte, a stat before the read and two after, and no
  offset kept from an earlier read. A record that could move the fold and
  cannot be parsed, an unterminated final line, or a file that changed under
  the read makes B `unreadable`. The records before a bad one are a prefix,
  and a prefix can hold a task whose end was the lost record. The shared
  incremental reader (`readBackgroundTaskLedger`) skips such a record and
  keeps its offset past it, which suits a wait that is asked again every tick
  and never a record that authorizes a fresh attempt.
- **Work a continuation reported as killed is held no longer.** The work is a
  child of the engine process, and the harness that would write its
  completion notice dies with it. The continuation of a cut names that work in
  one fixed sentence (`killedBackgroundWorkNotice`), and the prompt arrives in
  the transcript as a user record. The fold reads that sentence as the end of
  the tasks it names, exactly as it reads a task notification. So the
  conversation's own transcript says the work is over, from the moment the
  agent was told, and no cut record is consulted. A job launched after the
  report is new work under its own id.

**The table**, read top to bottom; every combination lands on a row:

| # | H | R | Decision | Named by |
| --- | --- | --- | --- | --- |
| 1 | `unreadable` | any | **Undecided** | — |
| 2 | any | `unreadable` or `undelimited`, or B `unreadable` where B was read | **Undecided** | — |
| 3 | `open T` | `open`, `empty` or `unknown` | **Cut.** The host started T and nothing ended it. | T |
| 4 | `open T` | `closed` | T ended by itself after its host stopped recording. **Cut** iff B is non-empty | T |
| 5 | `closed T` | `open` | **Cut.** The engine began work by itself and nothing ended it. | T |
| 6 | `closed T` | `closed` or `empty` | **Cut** iff B is non-empty; otherwise no cut | T |
| 7 | `none`; the row is `live`, names T, and no record of the transcript was ever observed | `open`, `empty` or `unknown` | **Cut.** The first prompt reached the engine and nothing ended it. | the row's turn word, w |
| 8 | `none`; the row is `idle` | — | **Cut** iff B is non-empty; otherwise no cut | w |
| 9 | `none`; the row is `live` | `open` | **Cut.** The CLI's own record shows a turn started and unended. | the row's turn word, w |
| 10 | `none`; the row is `live` | `closed` | **Cut** iff B is non-empty; otherwise no cut | the row's turn word, w |
| 11 | `none`; the row is `live` | `empty` or `unknown`, a launched stage attempt | **Cut.** The launch started the attempt and nothing ended it. | the row's turn word, w |
| 12 | `none`; the row is `live` | `empty` or `unknown`, otherwise | **No cut.** No durable record shows a turn started. | — |

A production row whose host ran a turn reaches rows 1-6: every turn a
structured host starts, a spawn's first prompt and a stage launch included,
goes through `EngineHost.send` and so through the ledger. Rows 7-12 decide
conversations whose host recorded no turn: a host that never started one, a
row from before the ledger existed, and every existing test fixture (no fake
host writes a ledger). They are the branch's transcript decisions with the C5
and C6 corrections of revision 2, unchanged here. A live row's turn word over
a transcript the registry has observed can lag that transcript (#1281), so by
itself it is no evidence of a start (row 12). Row 8 reads no R: the existing
case "a spawned agent whose turn a service restart cut is resumed once, and a
second restart sends nothing more" leaves the adopted row `idle` over a
transcript that still reads open and expects nothing further, and without a
ledger nothing tells such residue from work begun again.

Row 5 is what D3 asked for. Replayed over the final state of 746 real ledger
and transcript pairs, the Claude rule finds 620 conversations where nothing
began after a completed turn, 59 where self-started work reads closed, 5 where
it reads open after a completed turn, 43 turns their host ended `error` (21
of them with later engine records reading open), 12 hosts that stopped
hosting, 7 turns the host still held open, and no row it cannot delimit.

### What a decision produces

**Cut.** One record through `store.record` with `owner: null`, `reason:
viewer-restart`, and:

- rows 3-6: `turnRef` T and `boundary: viewer-restart:turn`;
- rows 7-11: `turnRef` the row's turn word when the row is live, and
  `boundary: viewer-restart:<w|launch>`, as on the branch;
- `checkpoint`: the kind and time of w, plus the background tasks for rows 4,
  6, 8 and 10.

A pipeline member is recorded `discharged` with `STAGE_CUT_RESOLUTION`, a
review-flow reviewer with its flow's resolution; every other cut is `owed`.
Then, unchanged:

- an owed record forces its row's adoption and gets one continuation keyed by
  the record id (`deliverInterruptionContinuations`);
- several owed records of one conversation collapse to the newest, which
  carries the one message; the older ones are discharged with that reason;
- the pipeline engine reads the newest record through `conversationRestartCut`
  and spends the stage's one fresh attempt (`engine.ts:4161-4176`);
- the deploy inventory lists the record.

**No cut.** Nothing is written, and a proposal standing for the row is
withdrawn (below). The row follows the existing adoption rules.

**Undecided.** See "Unresolved evidence". It never produces a record.

### A cut is a proposal until the row is taken

A pass decides before it claims, so a predecessor that is still alive can
finish the turn after the record was written. The turn's own ending evidence
has to decide that too. A restart record is therefore a **proposal** while
all of these hold (`restartCutProposal`): it is a restart record of no seat;
the row's claim epoch is the one it was written under, so no successor has
taken the row; and it is still `owed`, or stands as the witness it was
recorded as (a stage's or a reviewer's). Three things follow.

- **Every pass asks a proposed row again.** An owed proposal postpones
  nothing. A row decided "cut" again keeps its proposal, which still owns the
  conversation's next message, and writes no second record. A row that reads
  undecided keeps its proposal, since the record was written from evidence
  that read whole, and is held like any undecided row: stamped, never adopted
  for the proposal, and its continuation waits until the evidence can be read
  and decides the row again (see "Unresolved evidence").
- **A row decided "no cut" from evidence that the turn ended has its
  proposals withdrawn** (rows 4, 6, 8 and 10; row 12 is the absence of
  evidence and disproves nothing). The record is removed (`store.withdraw`)
  wherever the store keeps it, the directory and the pending journal a
  refused write falls back to, so no continuation is sent, the stage
  controller finds no witness, and the deploy inventory lists nothing. A
  record the store could not remove is still listed: its row is held and
  asked again, which retries the withdrawal. The same cut found again later
  is recorded anew under the same id.
- **The stamp guards a cut row like any other.** When the stamp of a proposed
  row has moved at one of the three comparison sites below, its proposals are
  withdrawn, the row is held, and the re-probe decides it from what the
  evidence says then. A turn that ended by itself in the window is decided "no
  cut". A turn whose shutdown merely wrote its marker is decided "cut" again,
  recorded under the same name and continued once.

A proposed row that reads `dead` or `unhosted` at the comparison with its
files moved was given up by an owner that was alive to write its ledger: the
proposal is withdrawn, and what that release cut is its own record's. This
pass's own dead-wrapper cleanup moves no file, so a row it retired keeps its
record.

Once a successor has claimed the row the record is final: the claim succeeds
only when the recorded engine process and the claim's owner are both gone, so
nothing can end the turn afterwards.

**The generic Codex nudge** (`enqueueInterruptedCodexContinuations`, keyed by
claim epoch) never answers a row this pass decided cut or undecided, a row
this process has found cut, a row with an unresolved record, or a pipeline
member. The rows this process found cut are kept as a set of host keys for
the life of the process; the set silences the nudge and gates nothing else.
The nudge remains for rows the rule does not ask (this process's own rows
after a runtime-host replacement) and for rows the rule answered "no cut" on
an uncorroborated turn word (row 12), which existing startup cases still
expect it to resume.

### Identity across boots

A cut decided from the ledger is named by `(conversation, host row, T)`, where
T is the newest turn the host started, open or closed (D4). The transcript's
newest work time w is the record's checkpoint and takes no part in the name.

T alone is enough because of what can follow a record. An owed record is
answered by its continuation or by a message that reached the conversation
first, and either is a host turn, which changes T. A stage's witness is
answered by a fresh attempt in a conversation of its own
(`startReplacementAttempt`). So the same T found again is the same cut:

- a late echo or flush of T's records moves w and leaves the name alone;
- a boot that adopts writes `turn-ended T error`, and a later boot that finds
  T closed with the engine's residue still reading open (row 5) lands on the
  record the first boot wrote under row 3;
- a host turn T3 started over an unchanged transcript is a cut of its own.

A cut decided without a ledger (rows 7-11) keeps the branch's name,
`(conversation, host row, turn word, w or launch)`, which every existing case
asserts.

In the store:

- `store.record` returns an existing record under the same id in whatever
  state it reached;
- between two restart records of a conversation that is no seat, the id is the
  whole identity. `coversSameCut`'s `recordedAt` comparison and its
  resolved-with-another-turn branch no longer apply between them. Release and
  seat records keep the coverage they have today, which an existing case pins
  ("a boot that finds the released turn severed records no second
  obligation");
- a pass that lands on an existing restart record with a newer work
  checkpoint moves the record's `checkpoint` and `recordedAt` to what it saw,
  and leaves its state and resolution alone. The stage controller counts a cut
  only when the attempt's newest work precedes the record (`restartCutOf`,
  `engine.ts:4172-4175`), and the deploy inventory lists by `recordedAt`
  (`scripts/deploy-checkout.py`), so a witness found standing again after its
  engine wrote more has to say when it was last seen. Only a resolved record
  can be found again: an unresolved one postpones its conversation.

### Evidence that can still move

A predecessor Viewer can still be alive while its successor boots, and an
engine can outlive its Viewer. Either can write the evidence while it is being
read or after it was decided.

**One stable read each.** The ledger gets the discipline the transcript tail
already has (`readStableTailRecords`, `scanner/activity.ts:286-309`): one
descriptor, a stat before the read and one after, and a stat of the path. Any
difference in device, inode, size or modification time makes the ledger
`unreadable` for this pass (row 1), whether a record was appended or the file
was replaced. The decision never reads through `FileRuntimeEventStore.load`,
which returns the events it parsed even when the file changed under it
(`eventStore.ts:337-341`) (D1). The reader parses and validates every record
it reads, newest first, deltas included, with the checks that load applies; a
record that is not JSON or not a valid event is row 1, whatever its kind. A
valid delta is then skipped by its kind. The modification time it reports is
the one both stats agreed on.

**A decision belongs to its pass and to the evidence it read.** Nothing is
kept for a later pass to skip a row with (D2). A row decided again from
unchanged evidence lands on the same record id, so repeating a decision adds
nothing. A pass may reuse its own earlier reading of a row only while the
stamp below is identical.

**A stamp guards every row the pass decided.** For each candidate the pass
decided, "cut" included, and each candidate it did not ask because its
evidence was older than the window, it keeps a stamp: the identity of the
ledger file, the identity of the transcript file, and the row's status and
turn word. The stamp is compared wherever the pass would replace the
predecessor's ownership of that row:

- `shouldAdopt`, which both production adopters ask before the claim and again
  on the claimed row, releasing the claim when it answers no
  (`runtime/registry.ts:596-616`, `:712-732`);
- the demotion's `admit` callback, before the claim and before the write that
  retires the row (`startup.ts:1793-1804`);
- the retain predicate of the dead-wrapper cleanup (`startup.ts:1562-1565`).

A row whose stamp moved is left exactly as it was, held, and asked again by
the re-probe below. A cut row is stamped too: its record is a proposal until
the row is taken, and a moved stamp withdraws it.

The claim is what makes the second comparison final. `claimStructuredHost`
succeeds only when the recorded engine process and the claim's owner are both
gone (`agent/registry.ts:7055-7064`), so once it has succeeded nothing appends
to either file until this process's own host opens. A row released there for a
moved stamp is decided by the next pass from evidence that can no longer move.

### Unresolved evidence

A row that is undecided, or whose stamp moved, is:

- **held**: no adoption for a turn claim or for an owed proposal, no
  skipped-host demotion, no generic nudge, no continuation. Pending work (a
  held delivery or a pending runtime operation) waits as well, until the
  re-probe below reaches its cap;
- **re-probed**: its host key joins the startup deferral that already holds
  rows behind unresolved pipeline evidence (`DeferredStructuredStartup`,
  `startup.ts:83-98`, `:1948-2024`). The probe takes each held row's stamp and
  reruns the pass for the held rows (`startStructuredHostPass(dependencies,
  hostKeys)`, which bypasses the cached ready result) when a row's files now
  read stable. That pass decides the row before its adoption step, so a cut is
  recorded and continued once in the same Viewer, with no second restart
  needed (C4). The next probe comes one second after any held stamp moved, and
  the delay doubles to thirty seconds only while nothing moves;
- **reported**: the deferral message (`structuredStartupDeferral`) names it,
  as it names rows held for pipeline evidence;
- **never recorded**.

Once the delay has reached its thirty-second cap with nothing moving (about a
minute in all) and the row still cannot be decided, pending work adopts it as
#1281 allows today, and nothing is recorded: the retry has happened, and the
pending message is what takes the conversation up. A row without pending work
stays held and re-probed for as long as this process lives, and the next
Viewer asks it again, since it is still the predecessor's.

A row that keeps moving belongs to an engine that is still writing. Its turn
is in flight, and the row is decided when the writing stops.

### The same rule at an orderly release

A release decides at the moment it hands a host over
(`handOverHostForDemotion`, `structuredDeliveryController.ts:2031-2047`),
where the live host's own state is the freshest H there is:

- an active host is an open turn: recorded, as today;
- an idle Claude host is rows 5 and 6 read from its own ledger and
  transcript. Work the engine began by itself that reads open is recorded and
  continued, which the branch does not do: today such a host is released with
  no record, and the follow-up D3 names is lost on every deploy that catches
  it. Otherwise B decides, as today.

The releasing process is the ledger's only writer, so no append can land
inside its synchronous read. The CLI is alive and may be writing the
transcript, so the tail is read up to three times; a tail still uncertain
records nothing, as the background clause does today, and the release log
names the host. Rows 1 and 2 apply before B is read: a ledger that cannot be
read, or a tail that holds no boundary for the ledger's newest turn, records
nothing either, and the log names the host and what could not be decided. B is
read up to three times as well, and a B still `unreadable` records nothing.

Those reads await, and the host keeps writing its ledger and the CLI its
transcript in the meantime. The decision stands only when neither file moved
from the moment its reads began, and the same comparison is asked again after
the record's own reads, just before it is written. A moved file decides the
host again from fresh reads, up to three times, so work that ended in the
window is owed nothing and work still open is recorded once; evidence that
keeps moving records nothing, and the log names the host.

## Finding map

| Finding | What failed | Clause that decides it | Status at `57b174379` | Test |
| --- | --- | --- | --- | --- |
| R4 F1 | A spawned Claude agent cut before its first transcript record got no continuation | Row 3 in production (the ledger holds `turn-started T` and no frame); row 7 in the fixture | Fixed (`firstTurn`); kept as row 7 | Existing: "a spawned Claude agent cut before its first transcript record is resumed once across repeated boots"; "an agent's row …, its transcript holding no record, records nothing" |
| R4 F2 | A turn an operator resumed was swallowed by the discharged record of the earlier cut | The decision reads no earlier record; the record is named by the new turn | Fixed by a special branch in `coversSameCut`; kept for release records, replaced by id equality between restart records | Existing: "a turn an operator resumed after a cut, cut again before its transcript shows it, gets its own one continuation" |
| R4 F3 | A claim renamed during the deploy inventory gave a passing empty list | Outside recognition: the inventory lists every record or reports it moving | Fixed in `scripts/deploy-checkout.py` | Existing: `scripts/deploy_checkout_test.py` |
| R4 F4 | A native shutdown marker erased the cut attempt's last report | Shutdown markers are bookkeeping: neither the turn's end nor its last word | Fixed (`cutProse`, `cutAttemptReport`) | Existing engine cases |
| R5 F1 | A later accepted turn was lost when the restart preceded its prompt echo | Ledger: `turn-ended T1`, then `turn-started T2`; nothing after the anchor: row 3 | **Open** | New, release seam |
| R5 F2 | A Codex shutdown `turn_aborted` hid the cut from the agent and from the stage witness | `turn_aborted` is bookkeeping in R and never a close of H: row 3 with a ledger, row 9 without | **Open** | New, release seam |
| R5 F3 | One uncertain read dropped the cut, then the row was adopted | Rows 1-2: held, re-probed, decided in the same process | **Open** | New, release and startup seams |
| C1 | An old preceding close aged a fresh T2 out of the window | The window dates the newest durable activity: the ledger's last write is T2's start or later | **Open** (the branch dates by the same old work record) | New, release seam |
| C2 | The acknowledgement time cannot order a turn's start against a close | No receipt is read; the ledger orders start and end, and R is found by identity | Revision 1 only | New, release seam: delayed acknowledgement; queued T2 |
| C3 | The eight-receipt window can drop the start evidence | No receipt is read; the ledger keeps every entry | Revision 1 only | New, release seam: nine later queued sends |
| C4 | An uncertain read was left for the next restart | The deferral re-probe re-enters recognition before adoption | **Open** (revision 1 deferred it) | New: controlled scheduler, release and startup seams |
| C5 | The work slice dropped undated completions and invented a cut | R removes bookkeeping record by record and keeps undated completions | Revision 1 only (the branch projects the full tail) | New: both native shapes, release seam and liveness |
| C6 | A readable tail projecting `unknown` fell through the table | R has an `unknown` value; rows 3, 11 and 12 decide it | Revision 1 only (the branch's expression covers it implicitly) | New: reasoning-only tail, release seam and liveness |
| D1 | A ledger that grew under the read was decided from its old prefix | One stable read; a moved or replaced file is row 1, held and re-probed before adoption | Revision 2 only | New: ledger reader with an append and a replacement injected between read and stat; release seam |
| D2 | A decision cached per host key outlived the turn it decided | Decisions belong to the pass; a stamp is compared before ownership is replaced | **Open** in another form (capture runs once per boot, `startup.ts:1494-1501`) | New, release and startup seams: two passes, and an append between decision and claim |
| D3 | Work the CLI began by itself after its host recorded an end got no continuation | Row 5, and the same clause at an orderly release | **Open** (an idle row is decided by B alone) | New, release seam: boot and release, agent and stage |
| D4 | A late echo of the same turn changed the cut's name and made a second witness | A ledger cut is named by T; w is the checkpoint, and a record found again moves it | **Open** (the branch names by w too) | New, release seam: three boots, then T3 |
| D5 | An undated completion of the open turn invented a cut | R is T's own records, found by `turn_id` or by frame `uuid`: row 4 | Revision 2 only | New: Codex and Claude, release seam and liveness |
| E1 | A background job the restart killed was cut again on every later boot and release, after its continuation had completed | B: work a continuation reported as killed is held no longer | Open at `e6401f38f` | New, release seam: "background work a continuation reported as killed is never cut again …" (the turn finishes, is cut mid-tool, launches a new job); "an orderly release … already reported as killed"; fold case in `backgroundTasks.test.ts` |
| E2 | A corrupt task notification above the 128 KiB tail left its job pending and authorized a cut | B is read whole or is `unreadable`: row 2, held and re-probed | Open at `e6401f38f` | New, release seam: "a corrupt background record above the transcript tail invents no cut across probes and boots, and its repair decides the row" (job ended, job still pending); its valid control; the orderly release; reader cases in `backgroundTasks.test.ts`; row 2 in `liveness.test.ts` |
| E3 | A predecessor's turn that completed after recognition and before adoption still got a continuation | A cut is a proposal until the row is taken: the stamp withdraws it and the next decision is the turn's own evidence | Open at `e6401f38f` (deferred by revision 3) | New, release seam: "a turn that ends by itself before the row is claimed / after a pass that recorded it and never adopted …" (agent and stage); "a turn whose shutdown wrote its marker before the row is claimed is still cut, once"; store cases in `interruptionObligations.test.ts` |
| E4 | An owed proposal whose evidence read unreadable was adopted and continued, though the turn had completed | Unresolved evidence holds the row, a proposal included; its continuation waits for the evidence | Open at `2cff6bd4b` | New, release seam: "an owed proposal whose transcript / host ledger reads unreadable is held …" (turn completed, turn still open) |
| E5 | An orderly release recorded a cut from a decision made before its awaited background read, after the work had completed | The same rule at an orderly release: a decision stands only on files that did not move under its reads | Open at `2cff6bd4b` | New, release seam: "an orderly release of an idle Claude host decides on the evidence as it stands after its reads" (finishes during the read, stays open) |
| E6 | A withdrawn proposal stayed in the pending journal and came back once the directory accepted records | A proposal is withdrawn wherever the store keeps it; one still listed holds its row | Open at `2cff6bd4b` | New, release seam: "a proposal the pending journal holds is withdrawn …" (agent and stage); store case in `interruptionObligations.test.ts` |

Rounds 1-3 each landed a test that the map below keeps.

## Existing test map

No existing fixture writes a host ledger, so every existing case is decided by
rows 7-12 or is not asked. The outcomes below are the ones each case asserts
at `57b174379`.

Three changes reach rows without a ledger: every pass decides again, restart
records are told apart by id alone, and a row whose evidence moved is held.
Applied to a scratch export of `57b174379` and run by path in isolated state,
they leave every existing case passing: `releaseInterruption` 48 of 48,
`startup` 116 of 116, `interruptionObligations` 5 of 5, `liveness` 27 of 27,
`structuredDeliveryController` 4 of 4. The one existing row a stamp would have
held in that run belongs to a seat, which this capture does not stamp.

### `src/lib/runtime/releaseInterruption.test.ts`

Every case stays and passes unchanged.

| Case | Decided by |
| --- | --- |
| claude/codex: cut mid-tool by a Viewer release resumes once … | The release decides from the live host; the boot postpones the conversation while that record is owed, and afterwards the adopted Claude row is `idle`: row 8, B empty. An `idle` Codex row is not asked |
| a cut turn stays owed while runtime-host succession lags … | Release record; the boot postpones while it is owed |
| failed demotion cleanup keeps the obligation … | Release record; delivery waits for adoption of the survivor's row |
| a turn cut on a host startup adopted but never published … | The retrying boot records its cut (row 9), the release records its own; the newest owed record carries the message |
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
| a spawned agent whose turn a service restart cut is resumed once … | Row 9; the next boot finds the row the first one adopted, now `idle`: row 8, B empty |
| a spawned agent waiting on background work the restart killed … | Row 10, B non-empty: cut |
| a pipeline stage a restart cut gets no continuation … | Row 9, stage: witness |
| a restart that finds an agent's turn already settled … | Row 10, B empty (the notice arrived): no cut |
| an idle Claude agent whose ended turn still waited on background work … | Row 8, B non-empty: cut |
| an agent resumed after one restart and cut mid-turn by the next … | Row 9 with a new turn word and a new w: a second id; the third boot finds the same id |
| a spawned Claude agent cut before its first transcript record … | Row 7 |
| an agent's row idle / live with no turn named / naming a turn observed before | Row 8 with B empty; row 12; row 12 |
| a turn an operator resumed after a cut … | Release record discharged by the send, which names another turn and so does not cover; then row 9 under the operator's turn: cut, once |
| a Codex agent's restart cut is continued once across repeated boots … | Row 9, same id each boot; the nudge is silenced for a row found cut |
| codex/claude pipeline stage gets no continuation from any path | Witness; the nudge is silenced for pipeline members |
| an orderly release of a pipeline stage leaves its cut to the stage controller | Release record discharged as a stage cut |
| Codex exit bookkeeping after a cut owes no second continuation … | Token counts move neither the turn word nor w; the resumed turn has a new id |
| claude/codex turn a delivered continuation started, cut before its transcript echoed it … | Row 9 under the continuation's turn word: cut; later boots find the same id |
| a stage whose turn a provider failure ended before the restart | Provider close: R `closed`, B empty: row 10, no cut |
| an orderly release resumes an idle Claude agent waiting on background work …; … with nothing in the background records nothing | Release path: no ledger, so row 8 from the host's own state |
| a stage transcript truncated / corrupt proves no restart cut | Row 2: undecided, no record, the row held. These boots must pass a controlled `schedule`, so the re-probe timer cannot outlive the case |
| a stage cut at launch, its transcript empty / not written / launch-only … | Row 11: witness, one record across boots, left as written because w did not move |
| a predecessor Viewer whose pid this process was given … | Whole-identity comparison; the second boot's row is this process's own claim |

### `src/lib/runtime/startup.test.ts`

The rule decides these cases, with the same outcome as at `57b174379`:

| Case | Decided by |
| --- | --- |
| a busy Codex turn advances after container replacement without operator messaging | Row 9: cut. After the replacement Viewer, the continuation's echo moved w, so a second id and a second, different restart continuation |
| unknown Codex durable state continues when the structured host retains an active turn | Row 12 (observed, empty): no cut; the generic nudge resumes it |
| unknown Codex durable state continues from runtime-running evidence | Row 12: no cut; the generic nudge resumes it |
| terminal / superseded Codex conversation stays outside startup continuation | No cut / not asked |
| startup adopts a persisted terminal conversation whose transcript starts a new turn before restart | Row 9: cut; the owed record keeps the expected adoption |
| startup keeps a live turn open when its transcript ends on an API error, a synthetic record or an error event | These run only `startupAdoptionAttempts` and assert the turn word; the capture is not involved |
| startup keeps a Codex host eligible when the bounded tail cuts off an unmatched tool call | Adoption filter only |
| a clean / production-shaped / 128 KiB-aligned terminal transcript stays retired across repeated startup | Row 10, B empty: no cut |
| a repeated promotion reuses one pending Codex continuation; startup retries a failed Codex continuation …; … same-epoch …; startup preserves a queued user draft … | Transcripts dated outside the age window: not asked; the generic nudge cases are unchanged |
| malformed JSON / truncated record / growing tail / missing / unreadable path cases | Outside the age window, or row 2: undecided and held; both give no adoption, as the cases expect |
| an explicit terminal transcript outranks a stale running runtime projection | Not asked (age window); no cut either way |
| viewer boot skips an orchestrator seat that becomes dead, unhosted or rotated during startup | A seat: outside this capture, and no stamp is kept for it |
| deferred pipeline evidence completes the pass … re-probes only the evidence until it moves (#1501) | The deferral gains a second kind of held row; this case holds none, so its re-probe cadence is unchanged |

Every other `startup.test.ts` case (seat recovery, claim and retry mechanics,
MCP grants, spawn receipts, demotion) involves rows the rule does not ask
(seats, this process's own claims, dead or unhosted rows, transcripts outside
the age window) or rows it decides as `57b174379` does. The build confirms
this by running the whole file by path; a case that changes outcome is a
finding against this design, to be reported before any expectation is edited.

### `src/lib/runtime/interruptionObligations.test.ts`

| Case | Decided by |
| --- | --- |
| the obligation id is derived from the cut, so separate processes agree on one key | Id-first lookup in `record`, unchanged |
| a boot that finds the released turn severed records no second obligation | Release coverage, unchanged: the existing record has an owner |
| a later cut of the same conversation owes its own continuation | A release input; its coverage is unchanged |
| the continuation names the deployment and the way back to a stage verdict; a record appended to the pending journal while an import runs … | Outside the rule |

### `src/lib/runtime/liveness.test.ts`

No case covers cut evidence today; the build adds the decision table there.

## The current branch: what stays and what goes

Stays:

- `interruptionObligations.ts`: the `stage` field, `answeredBy`,
  `STAGE_CUT_RESOLUTION`, `interruptionStageOf`, `checkpoint.backgroundTasks`
  and its continuation sentence, id-first lookup in `record`, and
  `coversSameCut` as it is for release and seat records.
- `liveness.ts`: `TranscriptCutEvidence` naming the checkpoint by work
  records, `backgroundWorkAwaitedAtCut`.
- `startup.ts`: settling arrivals before capture, whole-identity self
  exclusion, `recordRestartCuts`, the stage branch in
  `interruptionObligationDischarge`, newest-record-per-conversation discharge,
  the unpublished release path through `handOverHostForDemotion`, and the
  `firstTurn` condition, which becomes row 7.
- `structuredDeliveryController.ts`: `handOverHostForDemotion`, idle Claude
  background capture at release, work-based checkpoint and stage on release
  records.
- The pipeline side, unchanged: `restartCutOf`, `recoverRestartCutStage`,
  `startReplacementAttempt`, `cutAttemptReport`, the restart prompt,
  `conversationRestartCut`, `lastAgentWorkIndex`, `lastAgentEventAt`,
  `cutProse`, `claudeTurnClosedByProviderFailure`. The branch's
  `pendingBackgroundTaskNames` gave way to `verifiedBackgroundWork` (E2).
- `scripts/deploy-checkout.py` and its tests; the `startup.test.ts` edit.

Goes:

- `resumedTurn` and the `inFlight` expression (`startup.ts:470-485`); the
  decision table replaces them.
- `restartCutsRecorded` and `recordedCuts` (`startup.ts:66-70, 1494-1501`);
  every pass decides, and a set of host rows found cut serves the nudge.
- `cutsAnsweredByRecord` and `lastWorkByHost` (`startup.ts:822-841,
  1015-1017, 1547`); the nudge reads that set and the pass's decisions.
- Between two restart records: `coversSameCut`'s resolved-with-another-turn
  branch and its `recordedAt` comparison (`interruptionObligations.ts:180-189`).
- Never built, from revisions 1 and 2: the delivery-receipt read through
  `readSession`, the interrupt-receipt exception, the work-slice projection,
  the three-read loop inside the pass, the completion-after-last-write
  comparison (A), the read through `FileRuntimeEventStore.load`, and decisions
  kept per host key for the life of the process.

Changes:

- `eventStore.ts`: `readHostTurnRecord(sessionId)` beside the store. One
  stable read; it answers the newest turn and how the host closed it, the
  frames recorded before and after that boundary with the turn each was
  recorded under, the file's identity and its modification time, or `absent`,
  or `unreadable`. `FileRuntimeEventStore` itself is untouched.
- `liveness.ts`: `engineRecordSince(host record, tail)` finds the slice and
  projects it, with the six values of R; `transcriptCutEvidenceFromRecords`
  keeps naming w. A pure `restartCutDecision(input)` implements the table.
- `startup.ts`: `restartCutTargets` gathers H, R, B and the stage for each
  asked row in the pass's scope and applies the decision; it returns cuts,
  undecided rows and stamps. The pass records cuts, holds undecided rows,
  compares stamps in `shouldAdopt`, the demotion's `admit` and the cleanup's
  retain predicate, and joins held rows to the deferral, whose probe gains the
  stamp read, the one-second cadence on movement and the cap for pending work.
  `StructuredStartupDependencies` gains the ledger reader, so a case can hand
  in one whose file moves.
- `interruptionObligations.ts`: id equality between restart records; a
  restart record found again with a newer work checkpoint moves its
  `checkpoint` and `recordedAt`.
- `structuredDeliveryController.ts`: an idle Claude host is decided by rows 5
  and 6 at release, and `recordDemotionInterruption` records work the engine
  began by itself.

## Build plan

Each step is test-first: the new case runs red on `57b174379` before the code
changes. New cases write the host ledger through `FileRuntimeEventStore` in
the case's isolated state directory, which is the store and the file a real
host writes; their Claude records carry `uuid`s and their Codex lifecycle
records `turn_id`s, as real ones do. Existing cases keep their fixtures.
`successorBoot` passes a recording `schedule` in every case, so no deferral
re-probe ever reaches a real timer or runs after its case restored the
environment; a case that exercises the re-probe runs the recorded callbacks
itself.

1. **Tests.**
   - `releaseInterruption.test.ts`, R5 F1 and C1: a Claude conversation whose
     first turn closed seven hours ago, a ledger holding `turn-started T1`,
     its frames, `turn-ended T1 completed`, `turn-started T2` (the operator's
     send, through the existing operator-resume flow), the row live with T2,
     and boots before the prompt echo: one record naming T2 and one
     continuation across three boots. The same case without `turn-started T2`
     records nothing.
   - C2: (a) delayed acknowledgement: the ledger holds T's start and its
     `completed` end, the transcript closes T, the row still reads live with T,
     and the operator's receipt is delivered after the close: nothing. (b)
     queued turn: T2's send is acknowledged while T1 runs, T1 closes, the
     ledger holds `turn-ended T1` then `turn-started T2`, and the restart lands
     before T2's echo: exactly one continuation.
   - C3: case (b) with nine later queued sends to the same conversation, so
     the session's eight receipts no longer include T2's: the same one
     continuation.
   - R5 F2 (`test.each` agent / stage): the mid-tool Codex transcript with
     `task_started` naming T and a dated `turn_aborted`, a ledger holding
     `turn-started T`, no release record. The agent gets one continuation and
     the stage one discharged witness (`conversationRestartCut` set, no engine
     write), each once across repeated boots. With `turn-ended T interrupted`
     in the ledger (an interrupt the host served): nothing. Without a ledger:
     the same cut, by row 9.
   - R5 F3 and C4, with a controlled `schedule` passed through `successorBoot`:
     the transcript ends on a partial line during the boot, so the row is
     undecided, held and listed by `structuredStartupDeferral`; the line is
     then finished and the scheduled re-probe runs: one record, one
     continuation, in the same process, and nothing more on further probes. A
     line that stays corrupt: no record and no adoption across probes; with an
     operator send waiting, the send is delivered once the delay reaches its
     cap, and still no record.
   - C5: a Claude dated prompt with an undated provider `end_turn`, and a
     Codex dated `task_started T` with an undated `task_complete T`, each with
     the row live naming T and a delivered receipt: nothing, both with no
     ledger and with a ledger holding T's start and end.
   - C6: a Codex tail holding only a dated reasoning item. With
     `turn-started T` in the ledger: an agent continuation and a stage witness.
     With no ledger: an agent records nothing; a stage records its witness.
   - D1: the boot is handed a ledger reader whose hook appends
     `turn-started T2` after the read and before the second stat, over a ledger
     that held T1's start and end. The row is undecided, held and listed,
     nothing is recorded and nothing adopted; the re-probe then reads the file
     still: one record naming T2 and one continuation for an agent, one witness
     for a stage. The same with the file replaced between read and stat.
   - D2: (a) two passes of one process: the first decides "no cut" over
     `turn-started T1`, `turn-ended T1` and fails while adopting another row;
     `turn-started T2` is then appended and the row restated live with T2,
     with no echo; the retry pass records T2 and continues it once, and a
     third pass over unchanged evidence adds nothing. (b) one pass: the append
     lands after the decision and before the row's claim; the row is neither
     adopted nor demoted in that pass, and the re-probe pass records and
     continues T2 once.
   - D3: `waitingOnBackgroundTranscript` with a ledger holding T1's start,
     frames and `completed` end; then the completed task notification and an
     assistant tool call are appended, the ledger recording the assistant
     frame under no turn. An agent gets one continuation across three boots
     and a stage one witness. The notification alone: the same. The follow-up
     finished (tool result, provider `end_turn`): nothing. The frame recorded
     and its transcript record never written: one continuation. A turn the
     operator interrupted (`turn-ended T1 interrupted` after the marker
     frame): nothing. At the release seam, an idle Claude host
     (`persistedIdleClaudeHost`) over the same ledger and transcript: the
     release records one cut and the successor resumes it once; with the
     follow-up finished the release records nothing.
   - D4: a stage whose ledger holds `turn-ended T1`, `turn-started T2`. The
     first boot, before T2's echo, records the witness and exits before it
     adopts. T2's echo and a tool call are then appended with later dates.
     Boots two and three leave one record, whose `checkpoint` and `recordedAt`
     now follow the new work, so `conversationRestartCut` is no earlier than
     the attempt's newest work. `turn-ended T2` and `turn-started T3` over the
     unchanged transcript: a second record naming T3.
   - D5: Codex, ledger `turn-started T` and no end, rollout `task_started T`
     dated and `task_complete T` undated: nothing. Ledger `turn-ended T1`,
     `turn-started T2`, rollout holding T1's start and completion, dated in one
     variant and undated in the other, and nothing of T2: one record naming
     T2. Claude, ledger `turn-started T` with its frames and no end, the
     transcript ending on an undated provider `end_turn` after those frames:
     nothing; with that closing record before the anchor, as T1's: one record
     naming T2.
   - `eventStore.test.ts`: `readHostTurnRecord` over a missing file, a torn
     final line, a malformed boundary record, a file appended to or replaced
     between read and stat, a turn closed each of the three ways, and frames
     recorded under a turn and under none.
   - `liveness.test.ts`: the decision table as pure cases, one per row and per
     value of R; the slice cases (anchor found, anchor above a cut tail, a
     whole transcript holding none of the recorded frames, a ledger with no
     frame over dated and undated records, a recorded frame that never reached
     the transcript, Codex records with and without `turn_id`); the probe
     table above.
   - `interruptionObligations.test.ts`: two restart inputs under one id, the
     second with a newer checkpoint: one record, its `checkpoint` and
     `recordedAt` moved, its state untouched; two restart inputs that differ
     in turn: two records.
   - `startup.test.ts`: an undecided predecessor row is held out of
     `startupAdoptionAttempts`, appears in `structuredStartupDeferral`, and is
     decided and adopted by the re-probe pass once its evidence reads whole; a
     row whose stamp moved is neither adopted nor demoted.
2. **`eventStore.ts` / `liveness.ts`.** `readHostTurnRecord`,
   `engineRecordSince`, `restartCutDecision`.
3. **`startup.ts`.** Recognition in every pass for the asked rows in its
   scope, stamps and their three comparison points, held rows joined to the
   deferral, the probe extended, pending work admitted at the cap, the nudge
   set; delete the code listed under "Goes".
4. **`interruptionObligations.ts`.** Id equality between restart records; the
   moved checkpoint.
5. **`structuredDeliveryController.ts`.** Rows 5 and 6 for an idle Claude
   host at release.
6. **Gates**, from the specification: the touched test files by path with
   private `HOME`, `TMPDIR` and `LLV_STATE_DIR` and `LLV_VIEWER_CONTROL_URL` on
   a closed port (`releaseInterruption`, `startup`, `liveness`,
   `interruptionObligations`, `eventStore`, `structuredDeliveryController` and
   the engine file if touched), never a sweep of `src/lib/agent` or
   `src/app/api/runtime`; `tsc`; `eslint`; the privacy gate from the merge
   base; `bun scripts/verify-runtime-host.ts --runtime "$(which bun)"` in its
   private state; merge `origin/main` before the push.

Expected size: about 380 lines added and 130 removed in product code, with the
tests on top.

## Options considered

- **Keep patching each shape.** Rejected: five rounds show that each patch
  leaves the premise that produces the next finding.
- **The delivery receipt as a turn's start (revision 1).** Rejected by the
  first critique: the journal stamps `at` when the queue records the outcome,
  which can follow the turn's end (C2), the session presents only its eight
  newest receipts (C3), and the read needs a runtime client that can fail (C4).
- **The runtime journal's `turn-started` / `turn-ended` events.** Rejected:
  the Viewer publishes them to the runtime host from the same host events, on a
  best-effort chain, after the host ledger already holds them; a stale
  `running` projection already outlives its host (startup case "a stale
  runtime-running projection cannot revive an idle registry host").
- **The host ledger.** Chosen: written first, fsynced, ordered, keyed by the
  engine's turn, kept whole, read locally, and an index of the transcript.
- **A completion dated after the ledger's last write ends the open turn
  (revision 2).** Rejected by the second critique: an undated completion that
  names the open turn cannot be placed (D5), and the Claude host records a
  turn's last assistant frame before the CLI's `result`, so a Viewer that dies
  between the two leaves a completion dated before the ledger's last write.
  Identity places both. The comparison survives only where the ledger holds no
  frame at all.
- **Reading the ledger through `FileRuntimeEventStore.load` (revision 2).**
  Rejected: it returns a stale prefix when the file grows under the read (D1),
  and it parses every delta of a ledger that can run to hundreds of megabytes
  on each pass of a retry loop.
- **Decisions kept per host key for the life of the process (revision 2).**
  Rejected: a new turn under the same key was never asked (D2). The record id
  already makes a repeated decision harmless.
- **The Claude host records self-started work as a turn of its own.**
  Considered for D3: rows 3 and 4 would then decide such work and the release
  would see an active host. Rejected for this change: the broker's queue
  disposition, its `expectedTurnId` fence, its compaction refusal and the
  row's running state all read `activeTurnId`, and ledgers already written
  would still need row 5. See Deferred.
- **A clock on `turn-started`.** Rejected: host events cross to the
  runtime-host process, whose build can differ from the Viewer's during a
  deploy, and identity makes the clock unnecessary.
- **A transcript key from the Claude delivery ledger.** The delivery ledger
  binds a delivery to the transcript record that echoed it. Rejected: the host
  event ledger already holds the `uuid` of every frame, so no second file is
  read.
- **The seat tick's ledger cursor (`monitor/seatTickChildLedger.ts`).** It
  reads forward from a saved offset within a byte budget and tracks the active
  turn. Rejected as the decision's reader: a decision needs the newest boundary
  now, and it needs the frames.
- **Deciding inside the claim.** The claim is the first moment nothing can
  write the evidence. Rejected in favour of releasing the claim and asking
  again: the decision keeps one site, and the next pass reads the same frozen
  files.
- **The row's `updatedAt` as the host's last record.** Rejected: claims and
  cursor writes move it. It dates the window only where nothing else exists.
- **Hold undecided rows only from turn-claim adoption**, letting pending work
  adopt them at once. Rejected: the specification requires the retry before
  the predecessor's ownership is replaced. Holding pending work for as long as
  the row stays unreadable was rejected too: a send to a conversation whose
  tail ends on a torn record would then never arrive.

## Residual risks

- During a deploy the successor can decide a row while the incumbent still
  runs its turn. The record it writes is a proposal, and the moving evidence
  holds the row; a turn that then ends by itself has its proposal withdrawn.
  A stage witness is visible to its controller for as long as the proposal
  stands, which is until the next comparison or the next pass. The controller
  re-checks: a cut counts only when the attempt's newest work precedes the
  record (`restartCutOf`), so a stage whose turn went on writing keeps its
  result.
- A continuation that never reaches the agent (a newer message resumed the
  conversation first, or the queue refused it for good) reports no killed
  work. The work stays in B, and the next cut of that conversation names it
  in its one continuation.
- B parses the records that can move the fold and skips the rest unparsed. A
  record damaged so far that it no longer names what it was is not seen.
- A Viewer killed in the few synchronous milliseconds between a Codex host's
  ledger append and its registry row write leaves the row `idle`, and an
  `idle` Codex row is not asked.
- A ledger that holds no frame of its transcript is tied to it by the ledger
  file's clock against the CLI's timestamps. Both run on one machine; the
  container shares the host clock.
- A conversation whose record was resolved with no message reaching it (the
  queue refused the continuation for good, or it aged out) keeps that record's
  name until a host turn starts, so later self-started work cut by a later
  restart lands on the same record.
- A task notification written into an idle conversation that nothing answers
  reads as work begun. The conversation gets one continuation, which tells the
  agent to read its transcript; no second one follows under the same T.
- Work the engine began by a prompt that is no task notification (a scheduled
  wakeup's prompt) is seen from its first assistant record on. A restart that
  lands in the seconds before that record finds nothing begun.
- After a close the host wrote without the CLI's `result` (it stopped hosting,
  or an adopting host closed the turn), the turn's own late records can read
  as work begun again. The record carries the name of that turn's cut, so at
  most one continuation follows.
- A row whose evidence stays unreadable or cannot be delimited is held;
  pending work adopts it after about a minute without a record, and a row
  without pending work waits for readable evidence or the next Viewer. The
  replay above found no such row.
- The release reads a live CLI's transcript; three uncertain reads in a row
  leave self-started work unrecorded.

## Deferred — not currently justified

- **Seats under this capture.** `orchestratorRestartRecoveryTargets` decides a
  seat by `conversationTurnLiveness`, whose turn axis reads the full
  transcript, so a Codex seat whose shutdown wrote `turn_aborted` would read
  settled. No finding names seats, and their tests encode process evidence
  (#1276, #1281). Revisit when a Codex seat is seen cut this way.
- **An in-process re-probe for undecided rows.** Revision 1 deferred this. The
  first critique's C4 showed the bounded re-read leaves a row stranded until
  another restart, so it is part of the rule (the deferral re-probe).
- **A turn the CLI starts by itself after its host recorded the previous
  end.** Revision 2 deferred this. The second critique's D3 showed it loses an
  agent's interrupted work, so Claude's case is part of the rule (row 5 and
  the release clause). Codex's case stays here in part. A turn the app-server
  starts under a live host is a host turn. One it starts after its host died
  with a turn still open lies inside that turn's own records, where row 3
  reads it. One it starts after its host recorded the end and died leaves an
  `idle` row, which is not asked; revisit with the item on `idle` Codex rows
  below.
- **The Claude host recording self-started work as turns.** It would give
  such work a start and an end in the ledger and a live signal at release (see
  Options). Revisit when the broker's turn plane is next changed.
- **Deciding past a torn final transcript record.** A kill can cut a
  multi-page write short, and the stable tail reader then reports the tail
  uncertain for good. Reading the records before an unterminated final line,
  as the host ledger does, would let such a row be decided. After the claim
  nothing else can write the file, so that is the place for it. Not seen in
  production; revisit when a deferral report names a row held this way.
- **Asking only rows whose predecessor can no longer act on them.** Holding
  every row whose predecessor Viewer is still alive would remove the first
  residual risk. It changes when a deploy's cuts are recorded, which existing
  cases pin. The stamp comparison at the claim, and the proposal a moved stamp
  withdraws, take the part of this the findings need.
- **Asking `idle` Codex rows.** It would close the second residual risk at the
  cost of a read for every idle Codex row a predecessor left.
- **Retiring the generic Codex nudge.** It still serves this process's own
  rows after a runtime-host replacement, which the rule does not ask.
- **Runtime-host succession cuts of this process's own rows under the same
  rule.** Today they are covered by the nudge and by #1747's stage recovery.
- **Journal turn events as end evidence** (see Options). The host ledger
  serves that role from the source that writes first.

## Check against the requirement

- (1) A stage cut by a restart: the rule records a witness for every turn the
  host started and nothing ended, including a later turn before its echo (R5
  F1, C1-C3), a Codex turn whose shutdown wrote an abort (R5 F2), and work the
  CLI began by itself (D3). The engine spends the one fresh attempt in the
  same worktree, and a second cut parks. A witness found again after its
  engine wrote more says so, so the controller's own check still holds (D4).
- (2) An agent cut mid-turn or mid-wait: one continuation per cut, naming the
  background work it was waiting on, deduplicated across boots and passes by
  the turn its host started. The merger of the originating incident is row 6
  with B non-empty when its notice had not arrived, and row 5 when it had and
  the agent was reading the result.
- (3) The deploy verdict lists each record; the cuts R5 F1-F3, C1-C6 and
  D1-D5 lost now produce records, so they are listed too.
- Started and ended are each read from the conversation's own durable
  evidence: the host's record of the turn, and the engine's own records tied
  to that turn by identity. Transcript publication timing moves neither the
  decision nor the record's name (D4, D5), earlier records only postpone, and
  shutdown markers are never an end.
- Unresolved evidence, a moving ledger included, is retried in the same Viewer
  before the row's ownership is replaced, and never yields a record (R5 F3,
  C4, D1, D2).

## Build notes

### Existing contracts changed by restart capture

Batch B's two failures attributed to this PR came from the reviewed test
copies at PR #2609's head `50eb80c5f`, replayed against this PR's code. Both
assertions describe the behavior before boot-time cut capture. Replaying those
two cases in isolated state reproduces their failures:

- `releaseInterruption.test.ts`, "an unpublished host the release cannot
  hand over still lets the published hosts record their cuts and resume once":
  its retrying boot finds two predecessor turns and records both restart
  cuts before adoption. The later release records the published host's cut,
  leaving three records. The older assertion expected the whole inventory
  to contain only that release record. The updated case checks all three
  records, the release's delivery operation, discharge of the published
  host's earlier restart record, and one release continuation across repeat
  boots. The unpublished host's failed health probe still allows the
  published host to record and release.
- `startup.test.ts`, "a busy Codex turn advances after container replacement
  without operator messaging": a captured cut uses
  `interruptionContinuationText`, whose opening is "Viewer restarted and
  severed your structured host mid-turn." The older assertion expected
  `INTERRUPTED_CODEX_CONTINUATION_TEXT` and a claim-epoch operation id. The
  updated case checks the detailed continuation and its recorded operation,
  one record and delivery for the first cut, a distinct record and delivery
  for the next replacement, and no additional record or delivery when either
  boot repeats. Its fake host dates the resumed turn after the first cut,
  matching the order in which a real continuation arrives.

These expectation changes follow the rule above: a boot captures every
resolved cut before taking its row, and the durable obligation owns the
continuation. The two older assertions fail on that behavior even when their
cases run alone. The runtime implementation already supplies it; this
integration strengthens the assertions and records the contract changes.

What the build settled, 2026-10-07:

- **Pending work on a held row waits in the queue.** Holding a row out of the
  startup pass was half of "pending work waits": the delivery queue asks for
  on-demand recovery of a conversation with no host, and with the row held it
  settled the waiting send `failed` ("structured host recovery did not
  start"). `runtime/restartCutHold.ts` keeps the held host keys on the process
  object; the queue's recovery callback in `structuredDeliveryController.ts`
  answers a held row with the existing held-recovery error, so the message
  stays queued and is asked again. The set is emptied once the re-probe has
  reached its cap, which is when pending work takes the row in a pass or on
  demand.
- **A stamp stops applying once this process owns the row.** A row this
  process claimed and whose endpoint it replaced (it opened the host, or
  retired the row) is compared no further; until then the comparison holds on
  the claimed row, as designed. A row that reads `dead` or `unhosted` is
  compared no further either: this pass's own dead-wrapper cleanup wrote
  that, or an owner that was alive to write it, and a release records what it
  cuts.
- **The ledger read is bounded.** `readHostTurnRecord` keeps the 256 newest
  frames recorded before the boundary: the ledger records frames in the
  transcript's order, so the anchor is the newest of them the tail holds. A
  Codex ledger holds no frames, so its read stops at the newest turn's start.
- **Shared predicates.** `withoutExitBookkeeping` sits beside
  `lastAgentWorkIndex` in `pipelines/durableEvidence.ts`, and
  `isTaskNotificationRecord` beside `taskNotifications` in
  `pipelines/backgroundTasks.ts`.
- **After the cap.** The cap pass runs once; a row still held is re-probed at
  the capped delay, and a pass runs again when the row can be decided or a
  held delivery is waiting for it.
- **Fixtures.** No fake host writes a ledger, so the release-seam case for an
  orderly release appends the continuation's own turn to the ledger between
  boots, as the delivering host would. The D2 cases use a turn its host saw
  interrupted, whose transcript still reads open, so the row survives the
  dead-wrapper cleanup between passes; the D4 case runs a real process as the
  engine that outlives its Viewers. `startupAdoptionAttempts` in
  `startup.test.ts` passes a `schedule` that arms nothing, because eight
  existing cases there now hold a row (row 2), as the test map says.
- **Existing cases.** Every case of the five mapped files passes with its
  expectations unchanged.

What a correctness pass against the build settled, 2026-10-07:

- **The nudge keeps each pass's "no cut".** A row decided "no cut" by any
  row of the table other than 12 joins the set the generic Codex nudge never
  answers, for that pass. Before, a Codex turn its host closed, with the
  rollout still ending mid-tool, was told to continue on every boot.
- **B reads the turn as the agent's records and its host leave it.** The turn
  axis B is gated on is projected after the exit bookkeeping is removed, and a
  host's own close of the turn counts as its end. A shutdown marker after a
  turn that ended waiting on background work had hidden that work.
- **The hold is enforced where recovery mutates.**
  `recoverDeadStructuredConversation` refuses a held row before it looks for
  a live host and again under the row's operation lock, with the same
  held-recovery error the queue already keeps a message queued on, so a direct
  send, a retry or a control cannot retire or replace the predecessor. The
  queue's own callback still answers first, since recovery returns nothing on
  a non-structured transport. The reaper's dead-wrapper cleanup retains held
  rows by default.
- **The ledger read checks its sequence.** Every record the read passes,
  skipped deltas included, must carry the sequence one below the record after
  it and be a valid event. A gap, a repeat or an invalid event is
  `unreadable`, as `FileRuntimeEventStore.load` refuses the same file: the
  missing record could be the turn's end.

What a second correctness pass settled, 2026-10-07:

- **A delta is parsed like every other record.** The read had taken a
  delta's `seq` from its closing `"seq":N}` without parsing it, so a delta
  that was not JSON, named no turn or carried no text read as evidence and
  authorized a cut. Every record is now parsed and validated; a delta is
  skipped only after that.
- **Only provably old evidence ages out.** An unreadable ledger had dropped
  its last write from the window, so a fresh ledger over an old transcript
  aged out and its open turn was lost for good. Unreadable or uncertain
  evidence is now dated by its file's last write, and evidence that cannot be
  dated is asked.
- **The orderly release applies rows 1 and 2 first.** An idle host's
  unreadable ledger, or a tail with no boundary for the ledger's newest turn,
  had still let B authorize a record. Both now record nothing.

What a third correctness pass settled, 2026-10-07 (E1-E3 of the finding
map):

- **B is verified evidence.** `verifiedBackgroundWork` replaces the read
  through the shared incremental reader, at the boot and at the orderly
  release. A corrupt record above the tail had left its job pending in a
  prefix, and the offset cached past it would have hidden the repair.
- **The continuation is the report.** `killedBackgroundWorkNotice` builds the
  sentence `interruptionContinuationText` sends, and the fold in
  `pipelines/backgroundTasks.ts` reads it back as the end of the tasks it
  names. A stage wait and a review flow read the same fold, so neither waits
  on work its agent was told is gone.
- **A cut is a proposal until the row is taken.** `store.withdraw` removes a
  record; `restartCutProposal` says which records may be removed. Cut rows are
  stamped, proposed rows are asked by every pass, and a proposal is withdrawn
  when its row reads "no cut" or its stamp has moved. The check the
  revision deferred is now part of the rule.
- **Existing cases.** Every case of the mapped files passes with its
  expectations unchanged.

What a fourth correctness pass settled, 2026-10-07 (E4-E6 of the finding
map):

- **An undecided row is held whatever stands for it.** A row with an owed
  proposal that read undecided had been passed over unstamped, so the
  proposal forced its adoption and its continuation went out over evidence
  that could still show the turn ended. Such a row is now stamped and held
  like any other; the proposal is kept, and no continuation is delivered for
  a held row, even where pending work took it after the re-probe's cap.
- **A release decides on evidence that stood still.** `idleHostCut` takes the
  identity of the host ledger and the transcript before its reads and
  compares it after them, and `recordDemotionInterruption` asks the same
  comparison again before it writes. A moved file decides the host again.
- **A withdrawal reaches the pending journal.** `store.withdraw` takes the
  journal and its abandoned claims as an import does and puts every other
  record back. A record still listed after a withdrawal holds its row, so
  the next pass retries it.

No question for the operator remains: the code, read-only counts over this
machine's own ledgers and transcripts, three scratch runs of the existing
suites and two scratch probes against the unchanged helpers settled every fact
this design rests on.
