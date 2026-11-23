# Board Waiting routing: Waiting keeps operator actions, the seat gets the rest

## The requirement

On 2026-11-20, about 06:35 UTC, the operator asked by voice (relayed by Voice
Delegatus into this project's board) for a review of how the board agent
handles tasks in the Waiting column. Roughly 108 tasks had ended up there,
while the operator's own view showed only 4 of them working and 24 waiting on
the operator. The operator asked why these cards hang there while nothing hands
them back to the orchestrator to restart or continue, and asked for the
routing to be fixed: the agent escalates work that agents can resume to the
orchestrator, and Waiting keeps only tasks that really need an action from the
operator. Source: the board task created from that request (private; this
document paraphrases it).

The pinned acceptance asks for: the root cause with evidence (1); routing that
sends agent-resumable waits to the seat as a wake item naming the task and the
action, and keeps only genuine operator actions in Waiting (2); a maintainer
brief and guard that agree with the tick (3); regression tests over the real
routing and a dry-run count over a snapshot shaped like today's board (4); no
new UI chrome (5).

## Decisions first

1. **The premise needs one correction.** The orchestrator seats put these
   tasks in Waiting: every one of the 111 current holds was last written by a
   seat conversation, and the maintainer's ten retained runs moved no task into
   Waiting. The maintainer's defect is the other half of the request: it
   neither returns resumable Waiting tasks nor has any channel to hand them to
   the seat (§2, RC4).
2. **A hold parks a task in Waiting only when the operator owes the next
   step**: the hold's kind is `operator`, or the operator wrote the hold.
   Every other hold still records what the task waits on, but the task stays
   in (or returns to) its own column by the existing owner rule. This reverses
   the choice recorded on 2026-10-02 ("queued kinds move to Waiting", option 2A
   of [Task states and reasons](task-states-and-reasons.md)); the operator's
   request of 2026-11-20 governs.
3. **One pure classifier, `waitingRoute`, decides for each held or Waiting
   task who owes the next step**: the operator, the seat (with the action
   named), or nobody yet because agents carry it or it waits on a dated or
   tracked prerequisite. The seat tick and the maintainer both read it.
4. **The seat hears about it through the existing worker-ask path.** The seat
   agenda already turns every wait routed to the seat into one line on the
   next wake (`seatAgendaAsks`). It gains task-level lines for the seat class.
   No new wake reason, no new panel, no new card chrome.
5. **The maintainer may move resumable tasks out of Waiting and hands them to
   the seat with a new `seat:` report line; the server refuses a maintenance
   run that tries to park work on the operator.**
6. **Nothing moves cards by itself.** Existing Waiting cards leave through
   ordinary writes by the maintainer and the seat, both told by the same
   classifier. No data migration.

## 1. What the board looked like

### How it was read

All reads were read-only, between 2026-11-20 06:40 and 07:10 UTC.

| Read | What it gave |
| --- | --- |
| `list_tasks` status blocked, compact pages | 111 Waiting tasks of 270 open (117 Inbox, 42 In progress); ids, lanes, note authors |
| `list_tasks` compact:false, two rows | `hold` and `statusBy` shapes, used to cross-check the projection below |
| Read-only projection of the same task, lane and maintenance-run rows (the state store opened read-only with `query_only`) | `hold`, `statusBy`, decision rounds, lane states for all 111. Compact MCP rows omit `hold` and `statusBy`, and the full rows carry about 10 KB of assignments each |
| `laneRoute` from `src/lib/attention/routing.ts` run over those lane rows with the stored escalations and waiting rounds | who each parked lane is routed to today |
| `agent_activity` live-only for the project | 21 live conversations |
| `seat_tick_settings` verbose | maintenance every 12 h (set 2026-10-23 by an agent; default 3 h), last run 2026-11-19 23:27–23:44 UTC and its log |
| Forge, `gh pr view` | the three PRs that `pr` holds name are all open |

The relay said 108; the store held 111 at 06:47 UTC. Holds are being written
continuously: 62 of the 111 were written on 2026-11-19 and 2026-11-20 alone, by
eight successive seat conversations.

### Why the 111 wait

Hold kind against the state of the task's lanes (most active lane wins):

| Hold kind | Lane running | Lane parked (`needs_decision`) | Lane paused | Lanes all settled | No lane | Total |
| --- | --- | --- | --- | --- | --- | --- |
| operator | 3 | 3 | 4 | 5 | 2 | 17 |
| task | | 6 | 2 | 14 | 10 | 32 |
| external | 1 | 16 | 2 | 15 | 7 | 41 |
| resource | | 4 | | 2 | 2 | 8 |
| postponed | | | | 4 | 3 | 7 |
| pr | | 2 | | 1 | | 3 |
| worker | | 2 | | | | 2 |
| unstated | | 1 | | | | 1 |
| **Total** | **4** | **34** | **8** | **41** | **24** | **111** |

Who wrote the status and the hold:

| Writer | Current hold | Current status |
| --- | --- | --- |
| A seat conversation | 111 | 110 |
| A maintenance run | 0 | 1 (a continuation it created with an `external` hold on 2026-10-20) |
| The operator | 0 | 0 |

`statusBy.actor.role` reads `worker` for all 111, seats included: the MCP
binding fills it from the launch role (`src/lib/mcp/bindings.ts:1288-1296`),
while the note author uses the caller kind (`bindings.ts:2506-2508`). The
writer above was therefore identified by matching conversation ids against the
seat lineage and the maintenance-run index.

The operator's two numbers come from the Waiting column header
(`src/components/kanban/kanbanModel.ts:1073`): «працюють» (working) counts cards with a
working agent (the 4 running lanes), «чекають на вас» (waiting on you) counts cards whose
motion is needs-you, which an `operator` hold forces
(`src/lib/tasks/motion.ts:32`). The 17 operator holds and 2 operator step holds
make up most of the 24. Six of those 17 operator holds are stale: the operator
answered the task's own decision form after the hold was written, and the hold
was never cleared. No Waiting task has a decision form still waiting.

The remaining ~83 cards are neither working nor asking the operator anything.
That is the hang the operator saw.

## 2. Root cause (acceptance 1)

**RC1. Every hold parks the task in Waiting.** `createTask` stores a held task
as `blocked` (`src/lib/tasks/commands.ts:558`); `patchTask` turns any hold into
`blocked` (`commands.ts:758`) and a bare `blocked` into an `unstated` hold
(`commands.ts:762-764`). The kind does not matter: a dependency on another
task, a full CPU queue and an operator decision all land in the same column.
This was a deliberate choice ([task-states-and-reasons.md:144](task-states-and-reasons.md)
and option 2A at line 344), made when the board had 4 blocked cards.

**RC2. The seat's only sanctioned stop is a hold.** The tick contract tells the
seat: "If an item cannot be done, set its task's hold with the reason: that is
the stop, and the only one" (`src/lib/orchestrator/prompt.ts:231`; the compact
form in `src/lib/monitor/report.ts:174`). The `create_task` and `update_task`
descriptions say "When work stops, set hold" (`src/lib/mcp/server.ts:3949`,
`server.ts:3963`). So each transient stop a seat meets (a provider ended a
review early, six of six CPU slots taken, the pre-push budget ran out, "after
wave 2 merges") becomes a hold, and each hold becomes a Waiting card. Hold
notes on today's board are of exactly that kind; 62 were written on
2026-11-19 and 2026-11-20.

**RC3. Nothing reads a hold back as an obligation.** The tick treats Waiting
as a recorded stop:

- `hasOpenWork` counts only Inbox and In progress tasks (`src/lib/monitor/seatTick.ts:306`).
- `isUnstarted` and the accepted-work reminders skip held tasks
  (`seatTick.ts:279`, `src/lib/monitor/seatTickReminders.ts:135`).
- The only path is the waiting sweep (`seatTickReminders.ts:177`): one row per
  task at most once in 24 hours, ranked after overdue and unstarted rows
  (`seatTickReminders.ts:194`), at most 10 rows or 1500 characters a page
  (`seatTickReminders.ts:214`), and the row names the hold but no action. In
  the 24 hours before this read the seat was shown 53 waiting rows beside 106
  unstarted and 125 overdue rows.
- No code compares a hold with the present: whether its referenced task is
  done, its lane finished, its `until` passed, or anybody still carries it.
  The earlier design deferred exactly that ("Holds that clear themselves",
  [task-states-and-reasons.md:360](task-states-and-reasons.md)).

**RC4. The maintainer keeps Waiting cards and has no way to hand them over.**
Its scaffold (`src/lib/roles/defaults.ts:177`):

- leaves alone every task with an open pipeline (`defaults.ts:183`): 46 of the
  111 have one;
- clears a recorded wait only on evidence that its prerequisite was met and
  keeps "later authorized blockers" (`defaults.ts:184`);
- allows a hold for "an outside fact" (`defaults.ts:189`), the kind seats use
  for 41 of the 111;
- reports through two line types only (`defaults.ts:196`): `attention:` for an
  operator decision with two or more options (`src/lib/boardMaintenance/text.ts:8`,
  `src/lib/boardMaintenance/decision.ts:5`) and `left:` for the report.
  `maintenanceItemLabel`, the seat's wake line for a finished run, carries only
  the operator decisions (`text.ts:77`).

The guard permits moving a task out of Waiting
(`src/lib/boardMaintenance/guard.ts:66`) but nothing directs it. Measured over
the ten retained runs (2026-11-14 to 2026-11-19): no move into Waiting, six
moves out, no attention line. The last run examined 9 Waiting tasks; the
classifier below routes 6 of them to the seat. All 9 ended as `left:` lines,
which no seat wake carries.

**RC5. A parked lane routed to the seat comes back as a task hold.** For 32
Waiting tasks a parked lane is already routed to the seat
(`src/lib/attention/routing.ts:124`) and offered as a worker-ask line with its
action (`src/lib/attention/seatAgenda.ts:137-150`). The seat answered several
of them with a task hold ("the provider stopped the review") and left the lane
unresolved by `resolve-decision`, `retry-stage` or `close`; by RC1 that hold
parked the card. The lane keeps waiting on the seat while the card tells the operator
something waits.

A manual sweep does not hold either: on 2026-11-13 the seat audited Waiting by
hand and moved 33 cards out (78 were blocked then). A week later there are 111.

## 3. The design (acceptance 2, 3, 5)

### 3.1 The column rule

A task is in Waiting when the operator owes its next step. In code:

```ts
/** A hold parks its task in Waiting only when the operator owes the next step. */
export const holdParks = (hold: TaskHold): boolean => hold.kind === "operator" || hold.by === "operator";
```

`createTask` and `patchTask` use it in place of "any hold":

| Write | Today | After |
| --- | --- | --- |
| hold of kind `operator`, any writer | Waiting | Waiting |
| any hold written by the operator (UI, HTTP, default actor) | Waiting | Waiting (unchanged) |
| agent writes a non-operator hold on an Inbox or In progress task | Waiting | stays in its column |
| agent writes a non-operator hold on a Waiting task, no `status` | Waiting | owner rule (`commands.ts:759-761`: In progress with an owner, else Inbox) |
| agent sends `status: "blocked"` with a non-operator hold | Waiting | owner rule, plus a note in the answer: Waiting is for operator actions; use kind `operator` naming the action |
| agent sends `status: "blocked"` with no hold | Waiting, `unstated` | owner rule with an `unstated` hold and the same note |
| `hold: null` | owner rule | owner rule (unchanged) |
| a status other than Waiting, no `hold` field | clears the hold | clears the hold (unchanged); a patch that also carries `hold` keeps that hold; `done` always clears |
| `restoreHold` (operator undo) | restores | restores (unchanged) |

Writers are still never refused: a clamped write succeeds and says why, as the
earlier design required. Internal writers are unaffected: the only one that
writes `blocked` is a failed maintenance card (`src/lib/boardMaintenance/run.ts:118`),
which runs as the default operator actor and so keeps parking. That card is an
operator matter (a missing account, a decision).

The card already shows a hold outside Waiting: `taskMotion` reads the hold
whatever the status (`motion.ts:43-45`), and the waiting sweep already lists
held tasks outside Waiting (`seatTickReminders.ts:177`). A dependency wait
therefore reads "Waiting for «…»" on an In progress card, with no new element.

### 3.2 The classifier

`src/lib/tasks/waitingRoute.ts`, pure and browser-safe, for every open task
that is in Waiting or carries a hold:

```ts
type WaitingRoute =
  | { owner: "operator"; rule: "form" | "operator-hold" | "operator-written" }
  | { owner: "seat"; rule: SeatRule; carriedBy: "task" | "lane"; action: string; key: string }
  | { owner: "agents"; rule: "running" | "dated" | "dependency" | "lane" };
```

Inputs, all already in the seat agenda body (`src/lib/filesResponse.worker.ts:158-172`):
the task (hold, status, decision rounds, assignments), the project's lanes with
the route stamps routing already puts on them, every task by id (for `task`
refs), member conversations (live or not), and the time. Rules, first match
wins:

| Rule | Condition | Owner and action |
| --- | --- | --- |
| O1 | a decision round on the task waits, or a linked lane is escalated to a waiting form | operator |
| S7 | `operator` hold, and a round on the task was decided after the hold was written | seat, once per round: carry out the answer (`read_prototype_review`), then clear the hold or re-set it naming the new operator action. The task stays in Waiting until the seat writes |
| O2 | `operator` hold | operator |
| O3 | hold written by the operator | operator |
| A1 | a linked lane runs, or a member conversation is live | agents (the card reads working) |
| S1 | a linked lane is parked and routed to the seat (`laneRoute` owner `seat`: a decision, a spent review budget, a stopped merge or publication) | seat, carried by the lane's existing worker-ask line, which now also names the task |
| S3 | a linked lane was paused by an agent, and its resume date passed or it has no resume condition for 24 hours | seat, carried by the existing pause reminder (`pauseReminderReady`), which now also names the task |
| A2 | a linked lane is paused with a resume date still ahead | agents |
| S2 | a lane wait on the task was cleared (dismissed) and no lane is open | seat: start the next step or close the task with a note |
| S4 | `until` passed; or the referenced task is done or gone; or the referenced lane finished | seat: the wait is over, start or continue the work, then clear the hold |
| A3 | `postponed` with `until` ahead or without `until`; `limit` with `until` ahead | agents (no wake until the date) |
| A4 | the referenced task or lane is still open, or a `pr`/`issue` hold whose task has an open lane | agents (the prerequisite has an owner; S4 fires when it finishes) |
| S5 | anything else: a `worker`, `resource`, `external`, `unstated`, unresolvable `task` ref, or `pr` hold with no open lane and no live agent | seat. When every linked lane settled and at least one merged: check acceptance on the running build (`deployment_status`) and close the task or name what remains. Otherwise: verify the wait now; resume it, or give the hold a `ref` or `until` so Delegatus can tell when it clears; if only the operator can act, ask in a decision form on this task and set kind `operator` |

The ask key is `task:<id>:<rule>:<digest>`, where the digest covers the hold's
kind, `since`, `ref` and `until`, the linked lane states and the decided round,
so a changed wait is offered afresh and an unchanged one is offered once, as
worker-ask lines are today. The daily waiting sweep stays as the backstop for
operator and agents rows.

The classifier never reads hold notes: routing rests on structured fields only.
Judging a note ("is this really the operator's?") stays with the seat and the
maintainer.

### 3.3 The tick

- `seatAgendaAsks` (`seatAgenda.ts:128`) takes the body's tasks and appends one
  worker-ask line per task routed to the seat with `carriedBy: "task"`:
  `«<title>» (task <id>) — <why it no longer waits on the operator>; <action>`.
  The worker-ask reason, the "Waiting on seat" section, the per-wake bound and
  the delivered-version ledger work as they do now.
- A lane line (S1) and a pause reminder (S3) name the Waiting tasks they carry,
  so the seat moves the task when it settles the lane, and one wait gives one
  line.
- `seatTickTaskPage` leaves out of its waiting sweep the tasks that have a task
  ask on this wake, so a task is not listed twice.
- Work per check stays proportional to the body the agenda already reads: one
  pass over the project's tasks and a lane index by task id. No new store
  read, no forge call.

### 3.4 The maintainer

- **Brief.** `maintenanceBrief` (`text.ts:57`) gains a bounded "Waiting
  routing Delegatus measured" list from the same classifier, after the work
  evidence: the Waiting tasks routed to the seat or to agents, each with its
  rule and action, and the count of those that stay with the operator.
- **Scaffold** (`defaults.ts:177`), replacing what RC4 cites:
  - rule 3: a Waiting task whose routing is seat or agents is not left alone
    for having an open pipeline; move it out of Waiting by re-sending its hold
    (the server places it by the owner rule) or with `hold: null` when its
    prerequisite is met;
  - rule 6b: a hold records any wait; only an operator action parks a task, and
    a maintenance run never writes one. An operator decision nobody asked yet
    is an `attention:` line, which the seat turns into a form;
  - an operator hold that names neither a waiting form, nor access or a setting
    only the operator holds, gets a `seat:` line asking the seat to put it in a
    form or resume the work;
  - rule 10: a third line type,
    `seat: <task id> | <why it no longer waits on the operator> | <action>`.
- **Parser and log.** `parseMaintenanceReport` (`text.ts:8`) reads `seat:` lines
  into a new `MaintenanceRunLog.seat` list (bounded like `leftAlone`).
- **Hand-off.** `maintenanceItemLabel` (`text.ts:77`) lists the seat hand-offs
  beside the operator decisions on the seat's maintenance-settled wake line
  (`seatTick.ts:1989`). That is the existing wake surface for a finished run.
- **Guard.** `maintainerTaskWriteRefusal` (`guard.ts:66`) refuses, with code
  `maintainer_park_refused`, a maintenance write that sends `status: "blocked"`
  or a hold of kind `operator`, on update or create. Moving a task out of
  Waiting, re-sending a non-operator hold and clearing a hold stay allowed. The
  tick and the maintainer then agree by construction: one classifier, and the
  only writer that may park work on the operator is a seat or the operator.

### 3.5 Agent-facing text

- `create_task` and `update_task` hold descriptions (`server.ts:3949`,
  `server.ts:3963`): kind `operator` moves the task to Waiting, the operator's
  column, and is only for an action only the operator can take (a decision
  form already published, access or a setting only the operator holds). Every
  other kind records what the task waits on and keeps it in its column;
  Delegatus brings it back to the seat when that wait clears or nobody carries
  it.
- The seat mandate is unchanged. Its "set its task's hold … that is the stop"
  stays true, and a seat's non-operator stop no longer parks the card. No
  mandate version change.
- The Waiting column's existing hint strings (`kanban.statusHint.blocked`,
  `src/lib/i18n/en.ts:5223` and `src/lib/i18n/uk.ts:5138`) promise "a decision,
  dependency or capacity" and become wrong. They change to "an action of
  yours: a decision, access or a setting" in both languages. The element itself
  does not change.

### 3.6 What does not change

The stored status values, `taskMotion`, the needs-you panel, the kanban and
phone layouts, the worker-ask reason and its bounds, lane routing, the seat
mandate and its version, and the maintenance schedule (every 12 h on this
project; the tick asks are what makes the seat hear about a cleared wait
between runs).

### 3.7 Shared paths this touches

| Path | Producers and consumers checked |
| --- | --- |
| `hold` ⇒ status in `commands.ts` | MCP `create_task`/`update_task` (agents, gateway), HTTP task routes and kanban editing (operator), the maintenance card (`run.ts:100`), startup notices (`src/lib/runtime/startupRowRetries.ts`, inbox/assigned only), tick monitor cards (`src/lib/monitor/seatTickController.ts`, inbox/done only), launch membership (owner rule), operator undo (`restoreHold`) |
| Consumers of `blocked` | kanban columns and counts, `taskMotion`, tick `hasOpenWork`/`isUnstarted`/reminders/waiting sweep, accounting `readyAt` (`src/lib/tasks/accounting.ts:54`, skips any held task, unchanged), bridge deploy reports (`src/lib/bridge/taskChanges.ts:181`): the first moves out of Waiting appear once as In progress changes in the next deploy report |
| Seat agenda body | built for the tick only (`src/app/api/files/operatorProjection.ts:892`); the needs-you panel reads its own rows and is untouched |

## 4. Dry run over today's board (acceptance 4)

The classifier above, applied to the 111 Waiting tasks as read on 2026-11-20
06:47 UTC:

| Outcome | Rules | Tasks |
| --- | --- | --- |
| Stays in Waiting: the operator owes an action | O2 | 11 |
| Stays in Waiting until the seat carries out an answer the operator already gave (one seat line each) | S7 | 6 |
| Leaves Waiting, seat line on the task | S2 1, S4 3, S5 27 | 31 |
| Leaves Waiting, seat line already carried by its lane (lane decision 30, paused lane 4) | S1, S3 | 34 |
| Leaves Waiting, no wake: work running, dated, or waiting on an open task or lane | A1 2, A3 6, A4 21 | 29 |
| **Total** | | **111** |

Of the 27 S5 tasks, 11 have every lane settled with a merge: their line asks
for acceptance on the running build. Of the 21 A4 tasks, 3 wait on a task that
itself waits on the operator; the operator acts once, on that task's card. By
hold kind:

| Rule | operator | task | external | resource | postponed | pr | worker | unstated | Total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| O2 | 11 | | | | | | | | 11 |
| S7 | 6 | | | | | | | | 6 |
| S1 | | 6 | 15 | 4 | | 2 | 2 | 1 | 30 |
| S2 | | 1 | | | | | | | 1 |
| S3 | | 2 | 2 | | | | | | 4 |
| S4 | | | 2 | | 1 | | | | 3 |
| S5 | | 2 | 20 | 4 | | 1 | | | 27 |
| A1 | | | 2 | | | | | | 2 |
| A3 | | | | | 6 | | | | 6 |
| A4 | | 21 | | | | | | | 21 |

So Waiting goes from 111 to 11–17, the 17 operator holds that drive
«чекають на вас» (waiting on you) fall to 11 once the six answered forms are carried out, and
37 task lines plus 34 lane-carried lines reach the seat. The first wake after
release carries the 37 task lines across pages under the existing per-wake
bound.

## 5. Test plan (acceptance 4)

Every file runs by path through `scripts/gate-slot.sh bun test <file>` with a
private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` under the OS
temp root and `LLV_VIEWER_CONTROL_URL` on a closed port. Each shared test file
the change edits also runs as its unmodified base copy against the change: it
fails only at the assertions listed as intentionally changed below.

| File | Cases |
| --- | --- |
| `src/lib/tasks/waitingRoute.test.ts` (new) | One fixture per rule and per hold kind: each of the ten kinds with no lane, a running lane, a parked lane routed to the seat, a parked lane escalated to a waiting form, a dismissed lane wait, a paused lane with the date ahead or passed, settled lanes merged or not; `task` refs to a done, open or missing task and to an open or finished lane; `until` ahead and passed; a waiting round, a round decided before and after the hold; hold written by the operator or an agent; a live member. Asserts owner, rule, `carriedBy`, and that the key changes when the wait changes and not otherwise. Plus the dry-run fixture: 111 synthetic tasks built from the two tables in §4 (no ids or text from the real board), asserting 11 / 6 / 31 / 34 / 29 and the per-rule counts |
| `src/lib/tasks/taskHold.test.ts` | Every row of the §3.1 table, for create and patch. Intentionally changed: "a hold moves work to Waiting…" keeps its operator-written half; its agent re-write now leaves Waiting by the owner rule |
| `src/lib/mcp/bindings.test.ts` | `update_task` from an agent: a non-operator hold keeps the column; `status: "blocked"` is clamped with the note; an `operator` hold parks |
| `src/app/api/tasks/route.test.ts` | operator HTTP writes park as before |
| `src/lib/attention/seatAgenda.test.ts` | task lines appear for seat rules with `carriedBy: "task"`, never for operator or agents rules; lane lines and pause reminders name their Waiting tasks; a lane-carried task gets no second line |
| `src/lib/monitor/seatTick.test.ts` | a task named by a task ask is left out of the waiting sweep on that wake; the worker-ask reason fires for a new task ask and not again for a delivered key |
| `src/lib/boardMaintenance/guard.test.ts`, `src/lib/mcp/maintainerGuard.integration.test.ts` | `maintainer_park_refused` for `status: "blocked"` and for a hold of kind `operator`, on update and create; moving out of Waiting with the hold re-sent, and `hold: null`, are accepted and logged |
| `src/lib/boardMaintenance/text.test.ts` | `seat:` lines parse into the log with their bounds; malformed ids are dropped; the settled-run wake line carries the handed task ids |
| `src/lib/boardMaintenance/run.test.ts` | the brief is built from `waitingRoute` output for the run's project; `seat:` lines from the final message reach the run log |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | one `describe` block for the changed Waiting hint: en and uk, light and dark, desktop and 390 × 844, through the existing driver |

No test checks prompt or description wording. The publication pre-push runs
types, lint and touched tests as usual.

**Open branches on the same files** (checked with `git merge-file` on scratch
copies of main, the open branch head and the planned edit):

- #3805 (and #3762, the same audit work), both paused: `boardMaintenance/text.ts`
  gives three line conflicts (the `parseMaintenanceReport` signature, its
  return line, the brief's return line), all mechanical: keep both the audit
  parameters and the `seat` list. `boardMaintenance/guard.ts` merges cleanly.
- #3749 and #3802: `attention/seatAgenda.ts` merges cleanly.
- #4268, #4167 and #3805 touch `src/lib/roles/defaults.ts` elsewhere than the
  maintainer scaffold; recheck at implementation.

## 6. Options considered

| Option | Verdict |
| --- | --- |
| **A. Park only operator actions; classify the rest; maintainer moves, seat resumes** | Chosen. Stops the inflow at the write, tells the seat what to do, keeps every wait recorded |
| B. Keep "every hold parks", add seat lines for resumable Waiting tasks | Leaves 29 dependency and dated waits in Waiting, against the requirement, and every new seat stop still parks |
| C. The earlier option 2B: only `worker`, `resource` and `limit` stay out of Waiting | Moves 10 of today's 111 |
| D. One-time sweep plus a stronger seat instruction | The 2026-11-13 sweep is the precedent: 78 then, 111 a week later |
| E. Record dependencies as step holds | Two representations of one wait, and the tick does not read steps |

## 7. Deferred — not currently justified

- **Holds that clear themselves, and cards that move by themselves.** The
  classifier now detects a cleared wait and tells the seat; clearing the hold
  or moving the card without a writer is still left out. The reason from the
  earlier design stands (a column that moves without anyone acting; see
  [task-states-and-reasons.md](task-states-and-reasons.md), Model C), plus one
  more: whether a cleared wait means "resume" is a judgment, and the operator
  may have paused that work.
- **Forge state in the tick for `pr` and `issue` holds.** A `pr` hold with an
  open lane waits on that lane; without one it goes to the seat (S5). Polling
  the forge every check is the cost the earlier design deferred.
- **Deployment ancestry in the classifier.** S5 names "every lane merged" and
  sends the seat to `deployment_status`; the maintainer brief already carries
  the deployed revision.
- **The classifier judging operator holds that name no form.** That needs the
  note's meaning; the maintainer reads it and writes a `seat:` line.
- **Operator step holds parking their task** (2 tasks today). Not requested.
- **A seat mandate change.** The column rule makes the seat's stop
  non-parking without one.
- **A worker-slot scheduler** (still deferred from the earlier design) and
  waiting-time analytics.

## 8. Check against the requirement

| The operator asked | This design |
| --- | --- |
| Find why the cards hang | §2: every hold parks (RC1), the seat's only stop is a hold (RC2), nothing reads a hold back (RC3), the maintainer has no hand-off (RC4), lane waits come back as holds (RC5); the maintainer did not put them there |
| The agent returns resumable work to the orchestrator for restart or continuation | §3.2 S-rules become seat lines with the action named (§3.3); the maintainer moves them out and writes `seat:` lines (§3.4) |
| Waiting keeps only what needs the operator | §3.1: only operator holds and operator-written holds park; §4: 111 → 11, plus 6 until the seat carries out answers already given |
| No new UI | §3.5–3.6: existing column, card line, worker-ask wake and maintenance wake; one existing hint string reworded |
