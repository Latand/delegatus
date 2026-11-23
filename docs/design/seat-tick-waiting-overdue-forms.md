# Seat tick: waiting and overdue tasks by id, open decision forms, current instructions

## Originating requirement

Source: the operator's brief of 2026-11-12, task 3 ("the seat tick"), and the
operator's answer to a decision form on 2026-11-12 at 13:09 UTC. Paraphrased:

- On every tick the seat also reviews the tasks that are waiting. Today they
  are apparently not reviewed, and a lot is missed.
- Overdue tasks must appear by their id.
- On every tick the seat reviews the decision forms (`needs_decision`): a form
  whose question changed is refreshed; old questions and stale forms are
  removed, so the set stays current.
- The orchestrator keeps the tick's instruction text current when it is out of
  date, because it often is.

The form answer of 13:09 UTC settled which text is meant: the tick card's
«Інструкції» (the `reason` field); the long monitor note is out of scope. The seat may
rewrite the legacy lines with no recorded author (dated 17–19 October) so they
match the current state. Lines the operator writes with a known author stay the
operator's.

Acceptance, as pinned for this lane:

1. Every wake that carries tasks names each overdue and each waiting task by
   its id, with its title, its due date and its hold reason. The list is bounded
   per wake and pages with a cursor across wakes, so no task is silently
   dropped.
2. Every wake lists the open decision forms (pipelines in `needs_decision` and
   pending prototype reviews) with their age and whether the question is still
   current (the lane moved on, or the question was answered elsewhere), so the
   seat can refresh or withdraw stale ones. Withdrawal itself is PR #3928; this
   design builds on it and does not duplicate it.
3. The tick flags a stale instruction text (it refers to finished work, or it
   is older than a set age). The designated seat may replace lines with no
   known author and lines written by earlier seat epochs of the same project.
   Lines with a known operator author stay the operator's.
4. Tests run through the real seat-tick source paths; MCP-facing changes are
   proved through a real MCP SDK client against the real server on loopback
   port 0; each lifecycle test file runs in its own gate-slot command;
   typecheck, lint and privacy pass.

Fences: the spawn-custody lane and the host-reconciliation lane are not
touched; PR #3928 owns form withdrawal. The repository is public: this
document carries no handles, paths outside the repository, or live task text.

Verdict of this design: **build it, in three slices** (C, A, B), with no open
question for the operator. Every slice reuses an existing mechanism: the
reminder credit ledger for the task cursor, the operator's own «Чекають на вас»
projection for forms and their staleness facts, and the existing claim path
of the instruction editor for the seat's rewrite.

Anchors are at this branch's base `cb408fce48`; `origin/main` was
`15099450d8` at 2026-11-12 13:35 UTC and changed none of the cited files.

## 1. How a wake is composed today

### 1.1 Sources

One check per project gathers a `SeatTickCheckInput`
(`gatherSeatTickInputWork`, `src/lib/monitor/seatTickSources.ts:3287-3460`):

- **Open lanes** from the hot pipeline list, projected to
  `SeatTickPipelineInput` (`seatTickSources.ts:3314-3326`).
- **Board tasks**: every task of the project from the hot board
  (`loadTasksForList`, `seatTickSources.ts:829`), mapped with `status`,
  `hold`, `dueAt`, `accepted` and `waitingSince`
  (`seatTickSources.ts:3334-3345`).
- **Overdue tasks** from a separate indexed store query, at most 51 rows
  (`overdueTaskInputs`, `seatTickSources.ts:514-526`; SQL
  `OVERDUE_TASK_KEYS_SQL`, `src/lib/state/sqliteStateStore.ts:1839-1936`;
  limit check `sqliteStateStore.ts:2265-2270`). The query has three passes: a
  fixed head of daily repeats, discovery of due dates not yet shown, and a
  keyset sweep after a cursor (`overdueSweepCursor`,
  `src/lib/monitor/seatTickReminders.ts:74-84`).
- **Worker asks** routed to the seat, read from the operator's own board
  projection in a worker (`operatorSeatAgenda`,
  `src/app/api/files/operatorProjection.ts:882-884`;
  `seatAgendaAsks`, `src/lib/attention/seatAgenda.ts:128-158`). This is an
  optional source with at most an eighth of the check, capped at five seconds
  (`src/lib/monitor/seatTickWork.ts:30-60`); when its share is spent the wake
  says `Skipped sources (budget): workerAsks`.
- **Signals**, including the prototype-review failure signals
  (`signals`, `seatTickSources.ts:1583-1585`).
- **Settings**: the instruction lines (`reason`) and the monitor note.

### 1.2 Item derivation and order

`decide` (`src/lib/monitor/seatTick.ts:1127`) derives reminders
(`seatTickReminders`, `seatTickReminders.ts:86-143`), unstarted tasks
(`seatTick.ts:1258-1260`) and the wake reasons (`seatTick.ts:1318-1430`), then
`wakeItems` (`seatTick.ts:1939-2125`) builds one ordered list: deploys,
release alerts, maintenance, seat-paused lanes, worker asks (`:1977`), pull
requests, own settled lanes, lane events, child outcomes, permission
requests, new stalls, **reminders** (`:2080`), unstarted tasks, older stalls,
open lanes (`:2094`), running children, signals.

### 1.3 Budgets

- **Items per wake: 5** (`DEFAULT_SEAT_TICK_POLICY.itemsPerWake`,
  `seatTick.ts:142-149`), one window shared by every kind
  (`offered.slice(0, input.policy.itemsPerWake)`, `seatTick.ts:1598`).
- **Message: 4,000 characters** (`SEAT_TICK_MESSAGE_LIMIT`,
  `src/lib/monitor/report.ts:123`). The reserved tail (instructions, note
  preview, worker limit, contract) is subtracted first; the dynamic head
  (items, then reasons) is cut with a bare `…` when it does not fit
  (`boundedSeatTickMessage`, `report.ts:150-156`).
- **Overdue rows per check: 51** (`seatTickSources.ts:519`,
  `sqliteStateStore.ts:2266`).
- **Instructions: 500 UTF-16 units combined** (`REASON_LIMIT`,
  `src/lib/monitor/seatTickSettings.ts:54`, checked at `:649`).

### 1.4 Cursors and credit

- The delivered-item ledger `itemsShown` records a version per item only when
  a wake **lands**, and only for items whose complete bullet line is in the
  landed text (`visibleAgendaVersions`, `seatTick.ts:2433-2458`; the plan's
  `itemLines`, `seatTick.ts:2229-2231`). Reminder versions carry a stamp and
  suppress a repeat for 24 hours (`SEAT_REMINDER_REPEAT_MS`,
  `seatTickReminders.ts:6`; `recentReminderVersion`, `:17-21`), survive
  restarts and survive a seat rotation (`seatTickStateForEpoch`,
  `src/lib/monitor/seatTickState.ts:421-450`, keeps reminder versions).
- Overdue rows also carry `overdue-date` and `overdue-sweep` credits that feed
  the store query's discovery and sweep passes (`seatTickReminders.ts:51-84`).
- The event cursor, harvest cursor and announcement lists are unrelated to
  this design and stay as they are.

### 1.5 Where overdue items are truncated

1. **The reason line names them by label, without ids.**
   `seatTick.ts:1509` renders the overdue (and unstarted) reason as
   `pending.slice(0, itemsPerWake).map(item => item.label…slice(0, 200))`. The
   overdue label puts the title last (`seatTickReminders.ts:112`), so the
   200-unit cut removes the title first, and no id is printed for a task
   (only a pull request gets its id, `:1509`).
2. **The rest is a count.** `seatTick.ts:1510` appends
   `N more await a later wake` with no ids.
3. **The 51-row window is reported by a magic number.** `seatTick.ts:1512`
   says "50 or more overdue tasks" when exactly 51 rows came back.
4. **Ids reach the seat only through the shared five-item window.** A reminder
   bullet does print the id (`seatTickBullet`, `report.ts:180-184`), but
   reminders sit near the end of the order (`seatTick.ts:2080`) and the window
   is five items (`seatTick.ts:1598`), so a wake carrying lanes, asks or
   events shows one overdue task by id or none.
5. **Only a delivered bullet earns credit.** A task named only in
   the reason line earns no credit (`seatTick.ts:2433-2458`), so the same top
   five by priority are named again on the next wake and the tail is reached
   one item at a time.
6. **The message bound cuts the reason lines.** Items are rendered before the
   reasons (`report.ts:348`, `:352`), so when the head exceeds its budget the
   cut falls on the reason lines (`report.ts:155`).

The wake delivered on 2026-11-12 at 12:47 UTC (snapshot time on the wake)
shows all six: 3,999 characters; one overdue task by id in the items; an
overdue reason line of 901 characters naming five titles without ids and
"16 more await a later wake"; an unstarted reason line of 517 characters
naming five more without ids and cut mid-word at "20 more await a…" by the
bound; and `Skipped sources (budget): workerAsks`.

### 1.6 Where waiting tasks are dropped

1. `taskHasBlocker` (`seatTickReminders.ts:32-36`): a hold with a kind other
   than `unstated` and a non-empty note is a blocker until its `until`, and
   **for ever when it has no `until`**. Only `limit` and `postponed` holds
   store an `until` (`src/lib/tasks/hold.ts:31-34`), so operator, task, pr,
   issue, worker, resource and external holds silence a task permanently.
2. The accepted-work reminder skips every task that is not in `inbox` or
   `assigned`, and every blocked one (`seatTickReminders.ts:117`). A task in
   `blocked` status is never named.
3. `isUnstarted` (`seatTick.ts:276-283`) and the backlog count
   (`seatTick.ts:1260`) skip held tasks the same way.
4. `taskIsOverdue` (`seatTickReminders.ts:38-41`) and the store query
   (`src/lib/tasks/store.ts:626-628`) exclude a past-due task whose hold runs
   to a future `until`. That task is neither overdue nor named anywhere.
5. `hasOpenWork` (`seatTick.ts:303-306`) counts only `inbox` and `assigned`
   cards, so a board whose remaining work is held raises no interval wake.

The earlier reminder design made rule 1 deliberate: "a reasoned hold …
suppresses the reminder until its optional expiry"
(`docs/design/seat-tick-reminders.md`). The suppression exists so a held task
is not presented as "accepted work, start it". This design keeps that: a held
task is never presented as unstarted work; it is listed as **waiting**, with
its hold, once a day. PR #3917's analysis traces the same rule from the other
side: holding each fresh page removed those tasks from future reminders, so
holds became the way a seat quieted a wake.

On 2026-11-12 at 13:35 UTC this project had 64 tasks in `blocked` status
(`list_tasks status:blocked`, read-only). None of them can reach a wake today.

### 1.7 Where decision forms are and are not listed

Listed today:

- A lane **the seat launched** that parks is announced once as "parked on a
  decision" (`ownLaneLabel`, `seatTick.ts:756-776`), without its question or
  age.
- A parked lane **routed to the seat** is a worker ask with the stage's
  question (`laneLine`, `src/lib/attention/seatAgenda.ts:89-112`; built at
  `:138-150`) and a row in the "Waiting on seat" roster with its age
  (`seatOwnedLaneSection`, `report.ts:256-279`). Both disappear when the
  worker-ask source is skipped for budget (§1.1).
- Any open lane is "— open" on an interval wake (`seatTick.ts:2094-2098`),
  with no question.

Not listed:

- **A lane decision that waits on the operator** — escalated by the seat, or
  reserved for the operator — is excluded from the seat's agenda
  (`state.owner !== "seat"`, `seatAgenda.ts:144`).
- **Pending prototype reviews** (task rounds and the seat's own taskless
  rounds) never appear as forms. The only form-related items are failures:
  undelivered saved answers, failed Telegram posts and incomplete polls
  (`telegramPostSignals`, `src/lib/prototypeReview/telegramPostSignals.ts:20-37`).
- **Age and currency** are not in any wake line.

The operator's own surface already has all of it.
`needsYouAnswer` (`src/lib/attention/needsYouRead.ts:240-280`) builds the
«Чекають на вас» rows for kinds `prototype`, `lane-decision` and
`lane-review`, each with `since`, a `stale` flag and evidence facts
(`needsYouEvidence`, `needsYouRead.ts:75-130`): `task-done`,
`later-round-decided`, `lane-moved-past`, `pr-merged`, `pr-closed`,
`merge-queued`, `newer-work`. Lane rows there exclude waits the seat answers
first (`pipelineAsks`, `src/components/mobile/mobileBoardModel.ts:360-372`).
A taskless seat round gets no facts at all: the evidence reads rounds only
from the task (`needsYouRead.ts:116-127`) and the seat notice carries no
source (`seatRoundNotice`, `src/lib/prototypeReview/model.ts:74-78`).

### 1.8 Why the seat cannot rewrite the instructions

- A `reason` write replaces only lines whose author is the same writer
  (`sameWriter`, `src/lib/monitor/seatTickInstructions.ts:26-31`;
  `replaceSeatTickInstructions`, `:35-48`). For a seat that means the same
  conversation, project **and seat epoch**, so lines of earlier epochs are
  someone else's after every rotation.
- Lines with no author (written before #3091) are treated as the operator's
  (`isSeatNote`, `seatTickInstructions.ts:53-55`). Only an operator may clear
  or claim them (`clearUnknownInstructions`, `seatTickSettings.ts:560-566`);
  the MCP binding never passes that field (`src/lib/mcp/bindings.ts:5130-5141`).
- The 500-unit limit applies to the combined text (`seatTickSettings.ts:649`).

Live record, read at 2026-11-12 13:35 UTC (`seat_tick_settings verbose:true`,
read-only): three lines, 489 units in all — one line of 301 units with no
author and no date, one of 139 units by seat epoch 277 (2026-11-04), one of 47
units by seat epoch 298 (2026-11-05). A new 360-unit seat write keeps all
three and stores 489 + 1 + 360 = 850 units, which is the refusal at 851
the seat reported. The wake of 12:47 UTC rendered these lines under "Seat
notes" and "Instructions — author unknown" (588 characters).

## 2. Prior work and parallel changes

- **#3091** gave each instruction line an author and date, and fixed the rule
  that a write replaces only its author's lines
  (`docs/design/seat-tick-panel-api.md`, "Instruction authorship"). Commit
  `0a8790747e` moved author-unknown lines into the operator's editable field.
  The operator's 13:09 UTC answer changes one decision of that work: the
  designated seat may now replace author-unknown lines and lines of earlier
  epochs of its own project. Operator-authored lines keep the old rule.
- **`docs/design/seat-tick-reminders.md`** defined the reminder ledger, the
  24-hour repeat and hold suppression (§1.6 above). Its ledger is the cursor
  this design reuses.
- **PR #3928** (open, in the merge queue) gives every waiting round an
  exact-round withdrawal target `{kind:"prototype", taskId, reviewId}`
  (`taskId: null` for a seat form) through `dismiss_attention`, and filters
  withdrawn rounds out of the Decisions projections, including
  `seatDecisionNotices` and `operatorDecisions`. Slice B lists forms from
  that projection and names that target. It writes nothing.
- **PR #3917** (open, analysis only) measured wakes that advance nothing and
  found holds without `until` silencing reminders, the retry guard counting a
  hold as movement, and worker asks exempt from the guard. This design does
  not adopt its detector or backoff proposals; §3.1 avoids making a hold edit
  re-wake the seat.
- **PR #3920** (open) changes the unmerged-lane signal in
  `seatTickSources.ts` at lines 69, 1922–2030 and 3182–3205.
- **Fenced lanes** (spawn custody, host reconciliation) have no published
  branch at the time of writing; this design touches neither area.

Overlap check: `git merge-file` on scratch copies of the base, each open
branch, and a copy with a marker at every planned edit site
(`seatTickSources.ts` 93, 514, 519, 1584, 2791, 2802, 3334, 3420, 3428 against
#3920; `bindings.ts` 5059–5245, `needsYouRead.ts` 57–245 and
`prototypeReview/model.ts` 74–81 against #3928) reported no conflict in any of
them.

## 3. Design

Three slices. C is independent and smallest; A is independent of the open
PRs; B rebases on #3928 after it merges.

### 3.1 Slice A — a Tasks section with ids and a cursor (acceptance 1)

**Rows.** A pure function beside the reminders,
`seatTickTaskPage(input)` in `seatTickReminders.ts`, derives three classes
from data the check already holds (the overdue store rows and the hot-board
task inputs):

| Class | Rule | Source today |
|---|---|---|
| `overdue` | `taskIsOverdue` (unchanged) | `input.overdueTasks` |
| `unstarted` | the accepted-work reminder (`reminderKind: "task"`) and the legacy `isUnstarted` rows | `seatTickReminders.ts:115-127`, `seatTick.ts:1258` |
| `waiting` | not overdue, not done, not run by another machine, no open lane owns it, and `status === "blocked"` **or** any hold (a hold with a future `until` on a past-due task included) | new; replaces the silence of §1.6 |

`runsOn` tasks and board notices (`taskMonitorRef`) stay excluded as today.

**Row text.** One line per task, never cut inside a row:

```
- <full task id> | overdue 4h | due 2026-11-12 | high · moved 2× · no lane | hold: none | <title, ≤70>
- <full task id> | waiting 6d | due none | hold: task by agent since 2026-11-06: <note, ≤90> | <title, ≤70>
- <full task id> | waiting 2d | due 2026-11-10 | hold: postponed by operator until 2026-11-20: <note, ≤90> | <title, ≤70>
- <full task id> | waiting 9d | due none | hold: lapsed 2026-11-08 (limit): <note, ≤90> | <title, ≤70>
```

The full id is printed because `get_task` and `update_task` take the full id
(`src/lib/mcp/bindings.ts:6502-6508`). The age is the overdue time, the hold's
age, or the wait since the latest status entry. Priority, slip count and lane
state stay on overdue rows because the due policy in the reason line acts on
them.

**Order.** `overdue` (priority, due date, id — the store's order), then
`unstarted` (existing reminder order), then `waiting`: a lapsed hold first,
then a blocked task with no reasoned hold, then by hold age, oldest first,
then id.

**Page and cursor.** The cursor is the reminder ledger that already exists:

- A row is **due** when its version has no stamp younger than 24 hours.
  Overdue and unstarted rows keep their existing versions and credits
  (`reminder:overdue:…` with `overdue-date`/`overdue-sweep`,
  `reminder:task:…`). Waiting rows get `reminder:waiting:<sha256(task id)>`.
  The waiting key is the task id alone, so a seat that edits a hold does not
  bring the row back at once; that would turn a hold edit into a new wake,
  the loop PR #3917 measured.
- Each wake renders due rows in order, at most **10 rows and 1,800
  characters**; a row that does not fit is left whole for the next page.
- Each rendered row joins the commit plan's `itemsShown` and `itemLines`
  with its exact line, so `visibleAgendaVersions` credits it only if the
  landed text carries that line. An unlanded or unrendered row stays due and
  leads the next page. Ledger stamps survive restarts and rotation
  (§1.4), so the page continues across process restarts.
- The section header states every count, so nothing leaves without being
  said:

  ```
  Tasks: overdue 21, unstarted 25, waiting 64. This page: 10. Not yet named
  in the last 24 h: 34 more, on later wakes. Named in the last 24 h: 66.
  get_task <id> reads a task in full.
  ```

  When the overdue store window was full the count reads `overdue 51+`, and
  the sweep cursor continues past it as it does today.

**Reasons.** The reason lines stop listing labels. `overdue-task` reads
`21 overdue tasks (Tasks section); …` and keeps its due policy sentence;
`unstarted-task` reads `25 accepted tasks with no lane (Tasks section)`, plus
the backlog clause. Due waiting rows make the interval agenda non-empty:
`hasOpenWork` and `intervalAgenda` (`seatTick.ts:1261`, `:1317`) also count
due waiting rows, and the interval reason reads `N waiting tasks are due for
their daily review (Tasks section)`. No new reason kind is added, so the tick
panel's reason labels (`src/components/orchestrator/seatTickView.ts:63-64`)
and their translations do not change. A waiting row never wakes the seat
more often than the project's wake interval.

**Out of the five-item window.** Overdue, unstarted and accepted-work task
items leave `wakeItems` (`seatTick.ts:2080-2091`); the five slots go to lanes,
asks, events, children and signals. Pause reminders stay items. A task
appears in the Tasks section or not at all.

**Message bound.** The Tasks section goes in the reserved tail, after the
reasons and before the instructions, so the head's cut never reaches it. The
message limit becomes `4,000 + rendered length of the Tasks and Forms
sections`, applied in `boundedSeatTickMessage` and in the roster budget
(`report.ts:150-156`, `:430-448`). A wake without either section is the same
text, byte for byte, as today. On the 12:47 UTC wake the 1,418 characters of
the two reason lines and the 162-character task bullet would give way to two
short reason lines (about 250 characters) and a 10-row section (about 1,900
characters). These numbers are an estimate from that wake; the build measures them (§6).

**Catch-up wakes** carry the same bounded page; catch-up stays about lane
outcomes.

**Producers and consumers touched.** `SeatTickTaskInput` gains `priority`,
`createdAt` and `dueHistory` from the board mapping
(`seatTickSources.ts:2791-2796`, `:3334-3345`; both refresh paths). The
verdict gains `taskPage` rows and counts (`types.ts`). Readers of
`verdict.items`/`deferred` (controller send, accounting, journal) are
unchanged; the controller passes `taskPage` to `seatTickWakeMessage` and the
commit plan (`seatTick.ts:2127-2235`). `seatTickProposalMessage` does not
carry tasks.

### 3.2 Slice B — open decision forms with age and currency (acceptance 2)

**Source: the operator's own projection, in the read the check already
makes.** The worker request `seat-agenda`
(`src/lib/filesResponse.worker.ts:157-160`) already parses the operator board
body for the worker asks. It returns `{ asks, forms }`, where `forms` is
`needsYouAnswer` over that body for kinds `prototype`, `lane-decision` and
`lane-review`, with the files left out (`needsYouEntries({ ...body, files: []
})`). Without files, the conversation entries are skipped and the cost is
proportional to the project's lanes, the tasks that hold rounds, and the
seat notices. After #3928 the body's task summaries and seat notices omit
withdrawn rounds, so a form the seat withdraws leaves the next wake.
`lane-review` is included because the operator's Decisions surface lists a
spent review budget as a decision; it costs no extra filter.

**Facts for seat forms.** `seatRoundNotice` (`model.ts:74-78`) gains the
round's `source` (`conversationId`, `pipelineId`, `stageId`, `attempt`), and
the prototype branch of `needsYouEvidence` uses it when no task round exists:
`lane-moved-past` with the same rule as task rounds, and `earlier-seat`
(`stale: false`; a hint that a previous seat epoch asked it). The needs-you
read (`/api/attention/needs-you` and the seat's board report,
`src/lib/orchestrator/boardReportRun.ts:389`) gains the same facts, so the two
readers agree. No component draws the evidence or `stale` fields, and the new
notice field is ignored by the components that draw notices, so nothing
rendered changes.

**Section.** In the reserved tail after Tasks, on every wake that has open
forms:

```
Open decision forms: 3 waiting on the operator; 2 lane decisions wait on you (Waiting on seat).
Withdraw a stale form with dismiss_attention target {kind:"prototype", taskId, reviewId} (taskId null for a seat form); refresh by publishing a new round, then withdraw the old one.
- prototype pr_… | task <id> | asked 2d 4h ago | STALE: lane-moved-past — the publishing lane moved past this round | <title, ≤80>
- prototype pr_… | seat form | asked 6d ago | earlier-seat | <title, ≤80>
- lane-decision <lane id> | parked 5h | current | <title, ≤80>
```

Rows: stale first, then oldest first; at most **8 rows and 1,200
characters**. If more are open, a rotating cursor `formPageAfter` (row id) in
`SeatTickProjectState` is advanced by the landed wake's commit and wraps at
the end; the header names the page ("rows 1–8 of 11; the next wake
continues"). The forms list rides every wake that goes out; it is not a wake
reason of its own.

**When the read is skipped.** If the worker-ask source is skipped for budget
or fails, the section says `Open decision forms: not read this check
(budget); the next check reads them`. It never says "none".

**What the seat does with a row.** Withdraw with #3928's target; refresh by
publishing a new round and withdrawing the old one; answer a seat-owned lane
with `pipeline_action resolve-decision` as today. The wake executes nothing.

### 3.3 Slice C — instructions the seat keeps current (acceptance 3)

**Who may replace what** with a `reason` write:

| Line author | Operator (panel, gateway) | Designated seat of this project, current epoch | Any other writer |
|---|---|---|---|
| operator (`gateway`) | own block, as today | never | never |
| unknown (`null` or `unidentified`) | with `clearUnknownInstructions`, as today | **yes** | no |
| seat of this project, earlier or unrecorded epoch | removable as a seat note, as today | **yes** | no |
| seat of this project, current epoch | removable as a seat note | own block, as today | no |
| seat of another project | removable as a seat note | no | no |
| agent session | removable as a seat note | no (deferred) | own block |

**The rewrite is implicit for the designated seat.** Its `reason` text is the
whole text it controls: the write replaces its own lines, the author-unknown
lines and the earlier-epoch lines of this project together. The seat's reported
360-unit write then stores 360 units and succeeds, as the operator asked; a
separate flag would leave that same request refused at 851. Lines the seat
resends unchanged keep their stored entries (author and date), using the
claim path that already exists for the operator
(`previewSeatTickInstructions`, `seatTickInstructions.ts:85-115`, generalized
from `claimUnknown` to a claim predicate). `reason: null` from the seat clears
the same set.

**The guard is inside the write.** `changeSeatTickSettings`
(`seatTickSettings.ts:849-854`) reads the project's active designation inside
its locked mutation and passes `{conversationId, seatEpoch}` to
`applySeatTickSettingsChange`. The claim applies only when the instruction
actor is `manager`, its project is this row's project after canonicalization,
and both its conversation and its epoch equal the active designation. The
binding's actor alone is not enough: `orchestratorSeatIdentityForConversation`
also returns a revoked seat's old epoch (`src/lib/orchestrator/seats.ts:1019-1029`),
which the binding turns into a `manager` instruction actor
(`bindings.ts:5192-5200`). A retired seat, a deputy of another seat, or a
writer whose designation rotated before the lock keeps today's rule (own lines
only). The remaining window is a rotation committed after the settings lock
is taken and before it is released; its worst effect is the predecessor
replacing lines the successor may also replace.

**The answer names what went.** A designated-seat write that replaced or
removed inherited lines answers `replacedInherited: [{ text, author, at }]`
(at most 500 units, since they came from a 500-unit field). The removed text
stays in the seat's transcript; nothing is lost without a record.

**Review stamp.** The settings row gains `instructionsReviewedAt`, written by
every designated-seat `reason` write inside the same mutation (resending the
same text is a valid review). Every path that reads or rewrites the row
carries it: `normalizeRow`, `withInstructionLines`/`toFile` (the JSON mirror),
`seatTickSettingsAfterLapse` and expiry, the MCP verbose read (under
`settings`), and the panel route's answer (passed through; the panel draws nothing new). An
operator write does not set it.

**Stale flag.** A pure function `seatTickInstructionReview(lines, context)`
in `seatTickInstructions.ts` flags lines **the seat may rewrite** (unknown,
earlier epochs, its own epoch). Operator lines are never flagged, since they
are the operator's to keep. A line is flagged when:

- **age**: `max(line.at, instructionsReviewedAt)` is more than **3 days** old,
  or both are unknown. Three days is the tick's existing backlog bound
  (`backlogAfterMs`, `seatTick.ts:148`) and the hot residence of a finished
  lane; or
- **finished work**: the line names an 8-hex lane id that the hot pipeline
  list holds in a terminal state, a task id whose task is done, or `#NNNN`
  that a hot lane records as its merged pull request, and that work finished
  after `max(line.at, instructionsReviewedAt)`. Unknown references are never
  flagged.

The check computes it in `seatTickSources.ts` from rows it already holds
(the hot lanes and the project's tasks), over at most 500 characters.
`seatTickInstructionSections` (`seatTickInstructions.ts:119-139`) renders one
line after the sections, at most 400 characters, in both the wake and the
proposal wake (`report.ts:397`, `:599`):

```
Instructions to review: line 3 (author unknown, undated); line 1 (seat epoch 277, 8 days); line 2 names lane <id>, completed 2026-11-05. Rewrite with seat_tick_settings reason: your text replaces author-unknown and earlier-seat lines; operator lines stay.
```

It is not a wake reason. A designated-seat write clears it by restamping
the review or by dropping the reference.

**Tool text.** The `seat_tick_settings` description and the `reason` schema
text (`src/lib/mcp/server.ts:4047`) say what the designated seat's write replaces.
Tests do not check for those phrases.

**No UI change.** The panel keeps drawing stored lines with their authors;
after a seat rewrite it shows seat lines where the legacy line was. If the
operator saves the field with `clearUnknownInstructions` after the seat
replaced those lines, the operator's text is stored as operator lines; the
operator's explicit save wins, as with any concurrent edit today.

## 4. Options considered

| Question | Chosen | Rejected and why |
|---|---|---|
| Task cursor | reminder ledger, 24 h per row, exact-line credit | A rotating keyset cursor in project state would repeat each task every ~9 wakes, about three times a day, so three times the text, and needs a new state field and wrap rules. |
| Where task rows live | own section in the reserved tail | Raising `itemsPerWake` would still mix tasks with lanes in one window and still let the head cut drop rows silently. |
| Message limit | 4,000 + rendered length of the new sections | Keeping 4,000 makes the new sections take space from items. Raising the constant for every wake grows wakes that carry no tasks. |
| Waiting rows waking the seat | due rows join the interval agenda | A new reason kind needs a panel label in two locales and rendered evidence for one word. Riding only on other wakes leaves a board with only held work unreviewed. |
| Form source | `needsYouAnswer` from the body the worker already parses | A tick-side detector would duplicate the evidence rules the operator's surface uses, and the two would drift. |
| Seat rewrite | implicit for the designated seat, guarded inside the write | An explicit flag leaves the reported request refused. Opening `clearUnknownInstructions` to seats would not cover earlier epochs. |
| Stale age | 3 days from write or review | 7 days would have left the 04.11 and 05.11 lines unflagged on 2026-11-10. |

## 5. The reported cases through each slice

- **Overdue by title (12:47 UTC wake).** After A: a Tasks section with 10
  rows by full id, title, due date and hold; header counts 21/25/64; the
  next wake continues with rows not yet named; all overdue rows are named
  within three wakes, all 110 rows within 11 landed wakes, each again a day
  later. The reason lines carry counts only, so the head is no longer
  cut. The misattributed lane cannot recur from this cause: every task line
  carries its id.
- **Waiting tasks not listed.** After A: each of the 64 blocked tasks is a
  `waiting` row with its hold, named once a day; a past-due task held to a
  future date is a waiting row with its due date.
- **Forms.** After B: the wake lists each operator-facing form and lane
  decision with its age and its stale facts, plus the withdrawal target from
  #3928. The three legacy rows that #3928 describes appear with their facts
  until the seat withdraws them.
- **Instructions.** After C: the three current lines are flagged (undated
  legacy; epoch 277 eight days old; epoch 298 seven days old). The seat's
  360-unit rewrite replaces all three and stores 360 units; the answer
  returns the three removed lines; the flag clears; an operator line written
  later is untouched by the next seat write.
- **Worker asks repeating every two minutes.** Not in the acceptance; see
  Deferred.

## 6. Cost and measurement

No speed gain is claimed. Added work per check:

- Waiting rows: one pass over the project's task inputs the check already
  builds (`seatTickSources.ts:3334`), no new read.
- Forms: one call of the needs-you row builder inside the worker read that
  already parses the board body; files excluded; no new store read.
- Instruction review: a regex over at most 500 characters and map lookups in
  rows already loaded.
- Wake size: grows only by the rendered sections (at most 1,800 + 1,200 + 400
  characters), and drops by the label lists it replaces.

The build records, before and after, on the same recorded board fixture (21
overdue, 25 unstarted, 64 waiting, 3 forms): the wake length, the worker
request's duration (repeated runs), and the decision's duration.

## 7. Tests (acceptance 4)

Run each file by path in its own `scripts/gate-slot.sh` command with private
`HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, `LLV_STATE_DIR` and
`LLV_VIEWER_CONTROL_URL` on a closed port.

Slice A:
- `seatTick.test.ts`: real `seatTickDecision` → `seatTickWakeCommit` →
  `seatTickDecision`. Classes: blocked with no hold, operator hold without
  until, past-due with future until, lapsed hold. 25 waiting rows and three
  landed wakes name every id exactly once; an unlanded wake credits nothing;
  a row cut by the character bound is not credited and leads the next page;
  a hold edit does not re-list the row inside 24 hours; `overdue 51+`.
- `seatTickController.agenda.test.ts` (controller fixture): page progress
  survives a process restart between two wakes, with more already-credited
  rows than one page ahead of the first due row; the work per check stays
  bounded by the page.
- `report.test.ts`: byte-identical wake without tasks or forms; rows never
  cut; the limit grows by exactly the sections' length; the roster path keeps
  its budget.
- `seatTickSources.test.ts`: board mapping carries `priority`, `createdAt`,
  `dueHistory` on both refresh paths.

Slice B (after #3928):
- `needsYouRead.test.ts`: seat-round facts (`lane-moved-past`,
  `earlier-seat`) from the notice's source; a withdrawn round leaves the rows.
- A worker test over a recorded body: `seat-agenda` returns asks and forms;
  files are not visited for forms.
- `seatTickController.sources.test.ts`: a skipped worker-ask source renders
  "not read this check", never "none"; the form cursor advances only on
  landing.

Slice C:
- `seatTickSettings.test.ts`: the replacement table above, row by row; the
  851 case (489 legacy + 360 seat) stores 360; a revoked seat epoch keeps
  today's rule; a rotation committed before the lock refuses the claim;
  `instructionsReviewedAt` survives lapse, expiry and the JSON mirror.
- A new `seatTickInstructions.test.ts` for the review: age, unknown date, finished lane,
  done task, merged PR, unknown reference not flagged, operator line never
  flagged.
- MCP: a test under `src/lib/mcp/` with an MCP SDK `Client` against the
  real server and tool service on loopback port 0: the designated seat's `reason` write replaces
  inherited lines and answers `replacedInherited`; a former seat's write
  does not claim; the verbose read returns `instructionsReviewedAt`; the
  write receipt replays.

Publication runs typecheck, lint and privacy through the pre-push hook.

## 8. Build order and files

1. **Slice C**: `src/lib/monitor/seatTickInstructions.ts`,
   `src/lib/monitor/seatTickSettings.ts`, `src/lib/mcp/bindings.ts`
   (`seat_tick_settings` only), `src/lib/mcp/server.ts` (description, `:4047`),
   `src/lib/monitor/seatTickSources.ts` (review input),
   `src/lib/monitor/report.ts`, `src/lib/monitor/types.ts`.
2. **Slice A**: `src/lib/monitor/seatTickReminders.ts`,
   `src/lib/monitor/seatTick.ts`, `src/lib/monitor/types.ts`,
   `src/lib/monitor/report.ts`, `src/lib/monitor/seatTickSources.ts`,
   `src/lib/monitor/seatTickController.ts`.
3. **Slice B**, after #3928 merges: `src/lib/attention/needsYouRead.ts`,
   `src/lib/prototypeReview/model.ts` (`seatRoundNotice` source),
   `src/lib/filesResponse.worker.ts`, `src/app/api/files/operatorProjection.ts`,
   `src/lib/monitor/seatTickSources.ts`, `src/lib/monitor/seatTick.ts`,
   `src/lib/monitor/seatTickState.ts` (`formPageAfter`),
   `src/lib/monitor/report.ts`.

Before each slice: refresh the base, re-read #3920 and #3928, and rerun the
merge-file check on the files above.

## 9. Risks

- **More wakes on a board with only held work**: at most one per wake
  interval while waiting rows are due, so ⌈64 / 10⌉ = 7 a day here, then
  quiet until the rows are due again. On this project the interval wake
  already runs hourly for open lanes, so the page usually rides it.
- **A seat rewrite drops a still-valid legacy line**: the seat sees every
  line on every wake, the answer returns what was removed, and the operator
  asked for this rewrite.
- **The forms list shares the worker-ask budget**: a skipped read is named
  in the wake; repairing that budget is outside this lane.
- **The proposal slot waits while waiting rows are due**: due rows count as
  open work (`seatTick.ts:1659`), so on a board with no lanes the daily
  proposal comes after that day's waiting review, a few hours at most.

## Deferred — not currently justified

- **Worker asks repeating every two minutes.** Observed by the seat; not in
  the acceptance. PR #3917 analyses it (worker asks exempt from the retry
  guard, `seatTick.ts:1495-1496`).
- **The long monitor note.** The operator chose the `reason` field.
- **Agent-session lines** in the seat's rewrite. The answer names unknown and
  earlier-epoch lines only; none exist in the live record.
- **A `list_tasks` filter for overdue or held tasks.** The wake pages them;
  `status: blocked` already lists blocked tasks.
- **An exact overdue count past 51**: needs a new count query; `51+` with
  the sweep cursor says what is known.
- **Binding task-page credit to the seat epoch.** The reminder ledger
  survives rotation by design; a successor sees the counts and the rows the
  predecessor was shown return within 24 hours.
- **A wake reason for a newly stale form.** Forms ride every wake; this
  project always has open work.
- **"The operator answered in chat" as a form fact.** It needs the
  reply-suggestion store in the tick; the seat reads its own transcript.
- **Showing the stale flag or the review stamp in the tick panel.** No UI
  change is needed for the acceptance.
- **Flagging operator lines.** The operator's lines are the operator's; a
  flag on them would invite questions the operator did not ask for.

## Validation against the requirement

| Requirement | Where it holds |
|---|---|
| Waiting tasks reviewed on the tick | §3.1 `waiting` class, daily due rows, interval agenda |
| Overdue tasks by id | §3.1 rows with full ids; reason lines carry counts only |
| Bounded per wake, cursor across wakes, nothing silently dropped | §3.1 page bound, ledger cursor, exact-line credit, header counts |
| Forms with age and currency, refresh or withdraw | §3.2 rows from the operator's projection, stale facts, #3928 target |
| Stale instruction text flagged | §3.3 age and finished-work flag |
| Seat rewrites legacy and earlier-epoch lines; operator lines stay | §3.3 table and guard inside the write |
| Real paths, SDK client on port 0, isolated files, checks | §7 |
