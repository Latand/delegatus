# Due dates on board tasks, overdue work in the seat tick, seat rescheduling

Status: design, 2026-10-23, read-only stage. Nothing here is built. Code
references are `file:line` on `main` at `bf1c00247`.

## 0. Originating requirement

Operator decision, 2026-10-23 about 08:45Z, given as a comment on a decision
form about the dropped-requests audit. The operator's wording stays out of
published files, so this is a paraphrase:

> Keep no separate registry. The board tasks are the one registry; GitHub may
> mirror them. Everything on the board has to be carried out and picked up by
> the seat tick. Every promise gets a date. Overdue work lands in the tick. A
> date is mandatory for new tasks, and old tasks keep working without one. An
> overdue task is rescheduled by the seat, weighing how long it has waited and
> its priority, without reminding the operator: the seat acts as the project
> manager. Short design first, then slices.

Why: the read-only audit (lane `7371de1e`) of 123 operator requests between
2026-10-18 and 2026-10-23 found accepted continuations that waited hours or
days for a launch (one promised slice started 11 hours after the promise),
results nobody delivered, and promises lost across seat rotations.

## 1. Decisions

| # | Decision |
|---|---|
| D1 | `create_task` refuses a new task without `dueAt`. The operator is never refused: an operator create without a date gets a default (72 h later, rounded up to the hour), and the composer shows that default before the click. System cards stay undated. Old tasks are never overdue. |
| D2 | Only the task carries a date. A promise inside an existing outcome is an open step, and its task is due no later than that promise. |
| D3 | A new wake reason `overdue-task`, fed by one indexed query per check (partial index + `INDEXED BY`, at most 51 rows decoded). One line per task, most urgent first, with overdue age, open age, priority and moves. |
| D4 | Rescheduling is `update_task` with `dueAt` and a `dueReason`. A move of a date that has already passed is a slip; the task records its first date, the slip count and the latest slip. From three slips on, the wake asks for a structural action. The server records slips and refuses nothing for the count. |
| D5 | One mandate bullet is reworded (+17 bytes) and the tool descriptions carry the date rules. |
| D6 | No card change. The existing due chip already shows the date and «overdue». |

## 2. What exists today

- **Record.** `BoardTask.dueAt` (UTC instant) and `dueTz` (IANA zone),
  optional, both-or-neither (`src/lib/tasks/types.ts:239-243`,
  `src/lib/tasks/store.ts:177-182`). `normalizeDue` canonicalizes to
  `toISOString()` (`src/lib/tasks/commands.ts:284-294`). Create writes it at
  `commands.ts:409,452`; patch sets or clears it at `commands.ts:692-737`.
  `priority` is `high | normal | low`, normal never stored (`types.ts:65-75`).
  Steps are `{id, text, state, ref?, hold?}`, at most 20 (`types.ts:16-22`,
  `src/lib/tasks/steps.ts:4`).
- **Bindings.** `create_task` and `update_task` take optional
  `dueAt`/`dueTz` (`src/lib/mcp/server.ts:4083-4084,4130-4131`). The binding
  calls `createTask` with `explicit: true, actor: "agent"`
  (`src/lib/mcp/bindings.ts:2205`) and `patchTask` with `actor: "agent"`
  (`bindings.ts:2297`). The operator creates through `POST /api/tasks`
  (`src/app/api/tasks/route.ts:86`) and may patch `dueAt`
  (`src/app/api/tasks/[id]/route.ts:26,62`, `actor: "operator"`).
- **Tick.** Wake reasons are `src/lib/monitor/types.ts:185-245`. Accepted
  work with no open lane is reminded after 1 h and every 24 h
  (`src/lib/monitor/seatTickReminders.ts:4-5,45-56`; tested in
  `seatTick.test.ts:65-197`). The tick reads tasks from the frozen list
  snapshot (`src/lib/monitor/seatTickSources.ts:707`) and projects the
  project's board each check (`seatTickSources.ts:2528-2533,2936-2945`); no
  input carries `dueAt`, so nothing in the tick knows a date. Five items per
  wake (`src/lib/monitor/seatTick.ts:146`), labels cut at 200 characters in
  the reason line (`seatTick.ts:1492`).
- **Indexes.** Task rows live in `state_rows` as JSON. Precedent for a partial
  expression index read with `INDEXED BY`: `state_rows_task_finding`
  (`src/lib/state/sqliteStateStore.ts:404-408`, read at `:1518-1526`).
- **Card.** `TaskMeta` draws «⏰ date» in the zone it was set in and
  «· overdue» in danger ink (`src/components/kanban/TaskMeta.tsx:18-33`,
  tested in `TaskMeta.test.tsx:28-32`) on the desktop card
  (`KanbanCard.tsx:672`), the phone board (`MobileKanban.tsx:580`) and the
  phone task screen (`MobileTaskScreen.tsx:1143`).
- **Composer.** `DueChip` is an «add deadline» pill over a native
  `datetime-local`, with × once set (`src/components/tasks/TaskComposer.tsx:17-61`).
  It is mounted by the kanban «New task» composer
  (`src/components/kanban/KanbanBoard.tsx:2791`) and the phone `TaskSheet`
  (`src/components/ProjectDashboard.tsx:2552`). `TaskStickyComposer` and
  `BulkActionBar` sit under `SchemeBoard`, which no entry imports.
- **Linked boards.** The wire carries no date (`src/lib/links/taskWire.ts:105`).

Live data, from a `VACUUM INTO` copy of the operator's state database taken
read-only on 2026-10-23 08:57Z: 2 835 tasks, 527 open, 11 open with a date,
1 overdue; 12 tasks carry steps, with 7 open steps in total.

## 3. Where a date is required (item 1)

| Creator | Path | Rule |
|---|---|---|
| Any agent: the seat, the board maintainer's continuations (`roles/defaults.ts:175`), the owner relay (`externalRelay/ownerRun.ts:89`) | `create_task` → `createTask` with `requireDue` | Refused with `TASK_DUE_REQUIRED` (field `dueAt`) before any row or receipt is written. `dueTz` may be omitted: the operator's zone (`operatorTimeZone()`, `src/lib/operator/settings.ts:120`), else the server's. An agent's `dueAt` must lie in the future (`TASK_DUE_PAST`). The schema marks `dueAt` required so the model sees it. On a matched `findingKey` the existing date stands. |
| The operator | `POST /api/tasks` → `createTask` with `defaultDue` | Never refused. No `dueAt` → `defaultTaskDue(now)` = now + 72 h rounded up to the hour, `dueTz` = operator zone. Old cached clients get the same default. |
| System producers | direct `createTask` | Undated, as today: seat-tick cards (`seatTickController.ts:390`), maintenance (`boardMaintenance/run.ts:88`), release (`release/production.ts:199`), storage incident (`state/durability.ts:1382`), startup quarantine (`runtime/startupRowRetries.ts:168`), service-run holder (`tasks/systemRun.ts:22`), curator route (`tasks/curator.ts:282`), launch placeholders (`tasks/membership.ts:271`), linked arrivals (`links/taskApply.ts`), rows an older release writes during a rollback. Each is a notice or a container with its own owner. `tasks/proactive.ts:128` is reached only by its fixture. |

**UI default.** The composer chip, which reads «deadline» today, shows the
date `defaultTaskDue(now)` gives. Picking a date overrides it; × returns to the
default. The create request omits `dueAt` unless the operator picked one, so a
draft kept for days gets a fresh default at create time.

**Old tasks.** A task without `dueAt` is never overdue: the index below skips
it. No new aging surface: accepted undated work is already reminded every
24 h. `update_task`'s description asks an agent that touches an undated open
task to date it; nothing refuses an update for a missing date.

**Compatibility.** Stored fields stay optional. Older releases keep unknown
fields through the raw spread in `coerceTask` (`store.ts:222`). The 516 open
undated tasks load and behave as today.

## 4. Steps carry no date (item 2)

A promise that belongs to an existing outcome becomes an open step on that
task, and the task's `dueAt` is set no later than the earliest open promise.
When that step closes in time, the seat moves the date out to the next
promise, and the move counts nothing; a promise kept late makes that move a
slip (§6), which is what happened. Seven open steps
exist on the whole machine; a per-step date would need a field, validation, an
index over `json_each` and step rendering for them. Waits on a step already
have `hold.until`.

## 5. Overdue in the tick (item 3)

**Index**, added to the state schema inventory next to
`state_rows_task_finding` and created under the release fence like it:

```sql
CREATE INDEX IF NOT EXISTS state_rows_task_due ON state_rows(
  json_extract(value_json,'$.project'),
  round((julianday(json_extract(value_json,'$.dueAt'))-2440587.5)*86400000),
  row_key)
WHERE collection='tasks' AND json_valid(value_json)
  AND json_type(value_json,'$.dueAt')='text' AND json_type(value_json,'$.status')='text'
  AND json_extract(value_json,'$.status') <> 'done'
```

The `julianday` key is the one `state_rows_task_legacy_stamp` already uses
(`sqliteStateStore.ts:412-413`): it orders any parseable instant and compiles
on SQLite 3.39.

**Query**, `overdueTaskKeys(projects, nowMs, limit)` on the read connection
(no state lock): `INDEXED BY state_rows_task_due`, project `IN` the canonical
key and its aliases (as `taskSelectionSource` resolves them, `store.ts:569`),
due key `<= nowMs`, and two filters evaluated in SQL before any JSON is
decoded in JavaScript: a task `hold.until` later than now (an explicit
deferral), and a `machine` other than this install. `LIMIT 51`. Only those
rows are decoded (`collection.get` + `coerceTask`). It runs inside the
existing `seat-tick.project` span on the gather and refresh paths, every
check: time alone makes a task overdue, so the source-identity cache must not
reuse it. Fixtures inject it through a `SeatTickSources.overdueTasks` port.

Measured on the scratch copy (Bun 1.4.0, SQLite 3.53.2, load average 27 on
24 cores, 200 runs each): without the hint the planner picks
`state_rows_controller_active` and takes 18.1 ms per query; with
`INDEXED BY` 0.021 ms. After `ANALYZE` the planner finds the index alone, but
the live database carries no statistics, so the hint and a plan test stay.

**Reason.** `overdue-task` joins the kinds (`types.ts:185-245`), the label map
(`src/components/orchestrator/seatTickView.ts:57-74`, en «overdue task», uk
«прострочене завдання») and `versionedReasons` (`seatTick.ts:1466`). It is a
candidate under `wakeDue` beside `unstarted-task` (`seatTick.ts:1373-1408`),
so an overdue task wakes the seat within the wake interval (60 min,
`seatTick.ts:119`) even with no lane open. A project whose ticking is off
stays quiet (`seatTick.ts:1291`).

**Items.** One per task, composed with the reminders in
`seatTickReminders.ts`: kind `task`, `reminderKind: "overdue"`, version
`reminder:overdue:<sha256(id, dueAt)>@<now>`. The existing reminder ledger
then delivers it once per date and again every 24 h while the date stands;
a new date is a new key. It replaces the accepted-work line for the same task
through the merge at `seatTick.ts:2039-2046`; `unstarted-task` stops matching
overdue lines (`seatTick.ts:1453`). Order: priority high → low, then longest
overdue. Five are named, the rest «N more await a later wake»; a 51st row
reads «50 or more». Facts lead the label so the 200-character cut takes the
title:

`overdue 2d 4h · open 9d · high · moved 1× (first due 19 Oct) · no lane — <title>`

The retry guard sees a reschedule through the task's `updatedAt`: a `dueAt`
write bumps it (`commands.ts:475,720`), and the guard fingerprint carries it
(`seatTickSources.ts:1594`).

## 6. Rescheduling and its record (item 4)

**Action.** `update_task { taskId, dueAt, dueTz?, dueReason }`. A **slip** is a
move of a `dueAt` that has already passed to a later instant. Earlier moves,
and moves made before the date passes, are planning and count nothing.

| Write | Rule |
|---|---|
| Agent slip without `dueReason` (≤ 200 chars) | `TASK_DUE_REASON_REQUIRED`, nothing written |
| Agent `dueAt` in the past | `TASK_DUE_PAST` |
| Agent `dueAt: null` | `TASK_DUE_REQUIRED`; only the operator clears a date |
| Operator slip | counted, `by: "operator"`, reason optional |

**Record** on the task, written by `createTask` (first date) and `patchTask`
(slips), validated in `coerceTask` (`store.ts:194-257`) and dropped when
malformed, cleared with the date:

```ts
dueHistory?: {
  firstAt: string; // the task's first dueAt; every move keeps it
  slips: number;   // moves of a date that had already passed
  last?: { at: string; from: string; to: string; by: "operator" | "agent"; reason?: string; conversationId?: string };
};
```

No other write path touches the date: linked boards do not carry it, board
undo records status, text and hide only
(`src/components/kanban/boardHistory.ts:25-31`), and a rollback mirror
replaces whole rows. A release older than slice 1 moves a date without
counting it.

**The seat's choice**, stated in the reason's detail line of every overdue
wake: start or finish it, hold it with an `until`, close it with a note, or
move it. A move uses the priority horizon (high: next day, normal: +3 days,
low: +7 days); a task open more than 7 days takes the next shorter horizon and
its priority is raised one level. The seat tells the operator nothing about
dates.

**After three slips** the item reads «moved 3×: move again only with a lane
running on it or a hold with an until; otherwise split or close it». This is
wake policy; the server keeps counting and refuses nothing. Check set before
slice 2 ships: one week after it, count open tasks with `slips >= 3`; any task
at 5 reopens the deferred server refusal (§10).

## 7. A promise becomes a dated task (item 5)

The mandate bullet at `src/lib/orchestrator/prompt.ts:599` becomes:

> - Keep each task current: a brief note in plain operator language when the
> situation changes, and a dueAt for every promise you make: a task due by
> then, or an open step on a task due no later.

176 → 193 bytes. The note's contents it drops are already in `update_task`'s
description (`server.ts:3645`). Headroom measured in an isolated environment
on a scratch export: on `bf1c00247` the delivered mandate is 30 112 bytes
against 30 150 and the spawn envelope 30 327 against 30 350; on the head of
open PR #3200 (it takes mandate v59 and raises both bounds by 250) they are
30 338 / 30 400 and 30 553 / 30 600. +17 fits both. The version is the one
after #3200; `prompt.test.ts:1017` changes with it. The date rules themselves
go into the `create_task` and `update_task` descriptions and the overdue
reason's detail line, which spend no mandate bytes.

## 8. Board rendering (item 6)

The card stays as it is. `TaskMeta` already shows the date and «· overdue» on
every surface named in §2, and every new task now has a date to show. The only
rendered change is the composer chip's default text (§3). Slip history is read
with `get_task`.

## 9. Slices (item 7)

Each slice runs its touched tests by path in isolated state; refusals are
tested against the layer that enforces them, through the binding and through
`createTask`/`patchTask` directly.

1. **Record and reschedule rule.** `tasks/types.ts`, `tasks/commands.ts`,
   `tasks/store.ts`, `tasks/helpers.ts`, `mcp/server.ts` (`dueReason`),
   `mcp/bindings.ts`. Accept: an agent moves a passed date without a reason →
   refused, row unchanged; with one → `slips` 1, `firstAt` kept, `last`
   filled. A move before the date passes and an earlier move count nothing.
   Agent clear and agent past date refused; operator clear removes date and
   record. A malformed `dueHistory` loads without it.
2. **Overdue in the tick.** `state/sqliteStateStore.ts`, `tasks/store.ts`,
   `monitor/types.ts`, `monitor/seatTickSources.ts`,
   `monitor/seatTickReminders.ts`, `monitor/seatTick.ts`,
   `orchestrator/seatTickView.ts`, i18n. Accept: the plan test names
   `state_rows_task_due`; on 1 000 dated open tasks with 3 overdue, at most 51
   rows are decoded; high/normal/low order; 7 overdue → 5 named and «2 more»;
   the same date repeats only after 24 h; a new passed date is offered at
   once; done, held-until-future and other-machine tasks absent; a hold
   without `until` present; ticking off → quiet; overdue plus accepted-work
   reminder on one task → one line; the label carries the facts and, at three
   slips, the no-plain-move text.
3. **A date on every new task.** `mcp/server.ts`, `mcp/bindings.ts`,
   `tasks/commands.ts`, `app/api/tasks/route.ts`, `tasks/TaskComposer.tsx`,
   `hooks/useTaskDraft.ts`, i18n. Accept: `create_task` without `dueAt` →
   `TASK_DUE_REQUIRED`, no row, no receipt, also when the binding is called
   without the schema; `dueAt` alone → operator zone; operator create without
   a date → the 72 h default on a fixed clock; each system producer still
   creates undated; old undated tasks never overdue. 47 test files mention
   `create_task` and 2 of them mention a date: the slice gives every create
   in them a date through one fixture helper. Rendered frames of the composer
   chip (default, picked, × back to default) through the kanban and phone
   drivers, en and uk, light and dark.
4. **Wording.** `orchestrator/prompt.ts`, `prompt.test.ts`, the
   `create_task`/`update_task` descriptions in `mcp/server.ts`, the board
   maintainer's continuation rule (`roles/defaults.ts:175`) and the owner
   relay's board handoff (`externalRelay/ownerRun.ts:89`). After #3200 lands.
   Accept: the delivered mandate grows by 17 bytes and passes both bounds; the
   fingerprint test pins the new version; each changed text names `dueAt` and
   stays within the size bound its own tests hold.

## 10. Deferred — not currently justified

- **A date per step:** 7 open steps on the machine (§4).
- **Dates on linked boards:** the wire carries none; a task handed to another
  machine arrives undated there.
- **Slip count on the card:** nobody asked to see it; the seat acts on it.
- **Dating the 516 old open tasks in one sweep:** the requirement keeps old
  tasks working undated; agents date them as they touch them.
- **Server refusal after N slips:** reopened by the §6 check.
- **Telling the operator about overdue or slipped work:** the requirement
  asks for the opposite.
- **Dates on system cards** (§3), **GitHub due dates or milestones**, **a
  detector of promises in chat transcripts**, **a separate registry of
  requests and promises.**
- **Moving the existing per-tick board projection to indexed reads:** outside
  this change; the overdue reason adds no pass over the board.

## 11. Validation against the requirement

| Requirement | Where |
|---|---|
| Board tasks are the single registry | No new store; dates live on tasks (§2, §6) |
| Everything on the board is picked up by the tick | Overdue reason (§5); undated accepted work keeps its 24 h reminder |
| Every promise gets a date | `create_task` refusal (§3), steps under a dated task (§4), mandate bullet (§7) |
| Overdue work lands in the tick | `overdue-task`, one line per task (§5) |
| Mandatory for new tasks, old ones unaffected | §3 |
| Seat reschedules by age and priority, no reminders | §6 |

## 12. Questions for the operator

None. Every choice above has a default that follows from the requirement or
the code.
