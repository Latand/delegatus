# Kanban: recently worked tasks on top, every worked task visible

## Originating requirement

Operator, 2026-10-12 ~07:55Z, voice (ru), about what they called the «tasks
menu», later confirmed to mean the kanban board:

> то меню задач, которое там сейчас, оно очень старое, оно, по-моему, даже не
> все правильно задачи показывает, не все правильно отсортировано. То есть я бы
> хотел видеть все недавние задачи, которые работали, выше. И чтобы там была
> более детальная информация

Operator, 2026-10-12 ~14:45Z (uk), deciding the round that redesigned the old
panel: «цю панель взагалі прибрати … я взагалі казав про канбан». Voice relay,
~14:48Z: change the tasks in the kanban; do not ask the operator again whether
this was understood.

Read as three outcomes on the desktop kanban:

1. Inside each column, a task someone worked on recently stands above one
   nobody touched for a while.
2. Every open task that was worked recently reaches the board. A task the
   operator hid on purpose stays hidden.
3. A card says what is happening with its task now (stage, lanes, PR), using
   what the card already draws. The card is not redesigned: the «Calm card»
   round waits for the operator.

Fenced, because other open work changes them: the old «Задачі» panel and its
header entry (the panel-removal lane), the board header (#2782, merged to main
after this branch's base), and agent activity words (#2783).

## Verdict

The requirement can be met without an operator decision. The design changes
one comparator, one recency value, one visibility condition and the age in the
card's foot. It adds no panel, no header control and no card element.

No prototype round is published. Nothing new is drawn, the operator asked not
to be asked again, and the rendered evidence below covers what changes.

## 1. What the live board does today

### How it was measured

The measurement ran read-only at 2026-10-12 ~15:01Z on the project's own board.
It used a pinned copy of the files response the board polls (files, lanes,
flows, tasks), the stored task rows, the project's board preferences (closed
conversations) and the seat record. That input went through the product's own
`buildBranchGroups` → `buildSchemeLayout` → `buildTaskBands` →
`buildKanbanModel`, from an export of this branch's base commit. Per-tab
details were not replayed (open readers, drafts, collapsed workers). They
change which conversation tiles a card holds. They do not change which task
cards exist or their order.

| | count |
|---|---|
| tasks of the project | 482 |
| open | 138 (95 Inbox, 40 Assigned, 3 Blocked) |
| open tasks drawn as cards | 104 (61 Inbox, 40 Assigned, 3 Blocked) |
| done tasks drawn in «Готово» (3-day retention) | 93 |
| open tasks in the Hidden tray (`offBoard`) | 33 |
| open seat-only tasks (seat panel) | 1 |
| open tasks in a hidden group | 0 |
| cards no task owns («Не в задачі») | 0 |

### 1.1 Open tasks the board does not draw, and why

Each cause named in the brief was checked:

- **The board flag `board: "hidden"` on a band that holds nothing: 33 tasks.**
  `taskShowsOnBoard` (`src/lib/tasks/boardVisibility.ts:100`) honours the flag
  only while the band resolves no conversation, mirror or lane container. The
  band resolves only what the board loaded, and the board's file window does
  not reach back far enough.
  - 31 never had an agent (no assignment, no lane). They were moved here from
    another board on 2026-10-01 and carry the flag without an explicit choice.
    Since then only maintenance notes touched them (2026-10-02 … 10-08). They
    are not recently worked.
  - 1 has an explicit board choice (`boardChoice`). It is a duplicate of a
    finished task and never had an agent.
  - **1 was worked recently and is hidden by mistake.** That is the
    message-queue task («Черга повідомлень під час ходу Claude»). Its lane ran
    2026-10-11 01:08–03:59Z, and an agent moved it back to Inbox at 13:39Z.
    It was part of the same 10-01 move, and its flag is not an explicit
    choice either. None of its five
    conversations is in the board's file window, so the band holds nothing and
    the flag hides it.
- **Seat-only task: 1.** This is the seat's own notes task. The seat panel is
  its home (#1841). Correct, and unchanged.
- **Hidden group (`groupHidden`, the operator's kanban hide): 0 open tasks.**
- **Per-project board limit:** 197 of 300 bands are counted. The limit refuses
  new creates when the board is full. It never hides a stored task, so it is
  not a cause.
- **Unlinked or placeholder cards:** none unlinked. All 10 open
  placeholder-origin tasks are drawn.
- **Tasks with no lane:** 95 open tasks have none. Every one of them is drawn
  unless the flag above hides it, so this is not a cause.

The same imported flag also keeps 9 **done** tasks out of «Готово»: they
finished on 2026-10-11 and their transcripts have left the window.

### 1.2 Where recent work sits under stale cards

Today's order (`compareCards`, `src/components/kanban/kanbanModel.ts:370-408`)
has these keys, in order:

1. motion: needs-you, working, waiting, stopped, not started;
2. the start of in-flight work;
3. `lastAgentWorkAtMs`;
4. `updatedAt`.

Three mechanisms put stale cards above fresh ones.

**(a) Motion comes before recency.** Positions are 1-based, at 15:01Z.

- *Done.* Places 1–9 are done cards whose finished lane reports a blocked
  merge: «the PR was closed» on batch-merged PRs, «no pull request is linked»,
  or «checks did not finish». Their tasks were last edited 2026-10-11
  11:35–11:39Z. The card finished at 14:55Z today is 12th.
- *Assigned.* A card asking through a lane parked on a decision since
  2026-10-11 18:37Z (last lane movement 23:19Z) is 4th. It stands above three
  needs-you cards worked today at 14:45Z, 14:35Z and 14:18Z, and above all
  fourteen working cards. A conversation of that card is still flagged
  working, although its transcript has been quiet since 2026-10-11 13:48Z
  (#2783's subject).
- *Inbox.* There priority comes first and motion second. A card whose lane
  finished 2026-10-11 12:12Z, and whose prototype round waits for the
  operator, is 10th. Above it are nine high-priority cards nobody worked on,
  the oldest last edited 2026-10-09 10:14Z.

The needs-you mark is also noisy. 9 of 40 Assigned cards carry it, and 3 of
the 9 are working right now. By reason:

- 4 ask only through a finished prototype lane whose merge is blocked because
  «no pull request is linked to this lane». Two of these cards are working
  now, and one of the four rounds was already decided at 14:41Z.
- 1 asks through a draft PR, and that card is working now.
- 1 asks through a merge conflict.
- 3 are real decisions: two parked lanes and one conversation question.

**(b) Recency is blind to lanes whose transcripts the board did not load.**
`lastAgentWorkAtMs` reads only transcripts in the board's file window: 72 of
the project's 197 loaded files carry a work stamp. As a result, 18 of 40
Assigned cards and 72 of 93 Done cards score «never worked», although they
have lanes that ran. Every one of those 18 Assigned cards had a lane move
within the 20 hours before the snapshot. A nonzero stamp beats zero.

Example: the card whose only loaded transcript last worked 2026-10-06 19:22Z
(«Тестові процеси не лишаються сиротами») is 25th. Below it are a card whose
lanes moved 2026-10-12 10:54Z (edited 13:17Z), one whose lanes moved 09:01Z
and one whose lanes moved 05:30Z.

**(c) `updatedAt` is not a work signal.** 48 open tasks share the same
`updatedAt` minute, 2026-10-08 07:15Z: one maintenance pass. A note, a
maintenance line or an import moves it. It stays the last tie-break and
nothing more.

## 2. Design

### 2.1 Ordering rule per column

Three values per card, all already derived or derivable in `buildKanbanModel`:

- **inFlight**: `workingSinceMs !== null`. The definition is unchanged: a
  member conversation is working, or a stage is running, reviewing or
  committing in a lane that is not paused.
- **lastWork**: `lastAgentWorkAtMs`, now also including `laneMovedAt(lane)`
  for every lane on the card. `laneMovedAt`
  (`src/lib/pipelines/laneMovement.ts:13`) is the existing single definition
  of «when a lane last moved». It is the newest attempt start or completion
  stamped by the engine, and the group hide and the phone's dismissed-lane
  rule already read it. The board receives every lane, so this value exists
  even when no transcript of the lane is loaded.
- **recent**: `inFlight || lastWork >= now − 3 days`. The window is
  `DONE_TASK_BOARD_RETENTION_MS`, the span the board already treats as recent
  for «Готово».

**Assigned, Blocked, Done, and the «Не в задачі» list** (`compareCards`):

1. In-flight cards first. Among them, the newest `workingSinceMs` first. A
   start moves only when a turn or an attempt starts or ends, so working cards
   hold their places while agents stream (#2156).
2. Then `lastWork`, newest first.
3. Then `updatedAt`, newest first; then the id.

Motion (needs-you, waiting, stopped) no longer orders a column. This is
#2156's rule plus durable lane times; #2419 put motion first.

**Inbox** (`compareInboxCards`):

1. Recent cards first, in `compareCards` order.
2. Then the rest: high, normal, low, with `compareCards` inside each level.
   For cards never worked, that ends at `updatedAt`. #2229's priority queue is
   kept for untouched work. Only work done in the last three days rises above
   it.

**Needs-you cards are not pinned first**, as the evidence in 1.2 (a) shows:

- the mark is noisy;
- pinning it puts 27-hour-old asks above the work finished minutes ago;
- the operator already has dedicated ways to reach those cards:
  - the card keeps its «Потрібні ви» motion line wherever it sorts;
  - the header's «Потрібні ви» control on main filters the columns to exactly
    these cards, with a count (#2782);
  - operator decisions arrive as forms in the seat's conversation (#2788).

A fresh ask is recent by construction: the lane or conversation that asks has
just moved.

The phone is not changed. `phoneKanbanModel` keeps its own needs-first rule
(`docs/design/phone-kanban.md` §3.2: a tab's ⚠n counts its first n items). The
rest of each phone column already follows `compareCards`, so it inherits the
new order. The cross-project Overview uses the same comparator.

Result on the live snapshot, using the rule above applied to the same input
(1-based):

| card | before | after |
|---|---|---|
| Inbox: lane finished 10-11 12:12Z, prototype round waiting | 10 | 1 |
| Inbox: the hidden message-queue task (lane 10-11 03:59Z) | absent | 3 |
| Assigned: lanes moved 10-12 10:54Z, no loaded transcript | 27 | 25 |
| Assigned: loaded transcript 10-06 19:22Z, lanes 10-11 19:10Z | 25 | 38 |
| Done: finished 10-12 14:55Z | 12 | 3 |
| Done: the nine stale blocked-merge cards (edited 10-11) | 1–9 | 14, 27, 43–51 |

Two residues remain until #2783 lands. Both come from conversations flagged
working while their transcripts have been quiet since 2026-10-11:

- the parked-decision card stays in the in-flight group (Assigned 17th);
- two done cards stay above 14:55Z (Done 1st and 2nd).

Once the activity is true, those cards fall to their lane time. This design
does not fork `isWorkingAgent`, which every «working» count shares.

### 2.2 Which hidden tasks become visible, and by what rule

A task whose board flag is `hidden` draws its card when it was **worked
recently**:

- one of its lanes is still active; or
- one of its lanes moved within the last 3 days (`laneMovedAt`).

Two kinds of task stay hidden regardless:

- the flag is an explicit choice (`boardChoice`): the operator's «Remove from
  board», or an explicit `board` write;
- the operator hid the group (`groupHidden`). It keeps its existing
  resurfacing rules.

The flag keeps its documented meaning: «may an EMPTY band be drawn»
(`src/lib/tasks/types.ts:238-246`). Recent lane work now counts as the band
holding something, as a resolved conversation already does.

On the snapshot this draws:

- +1 open task: the message-queue task, into Inbox;
- +9 done tasks finished 2026-10-11, into «Готово».

The 31 never-worked imports and the one explicit choice stay in the Hidden
tray, still reachable there. `countBoardTasks`, the server's 300-band limit
and the task routes are unchanged.

Mechanism, with one decision point:

- `buildTaskBands` no longer drops a band for the board flag when the kanban
  asks it to defer. The existing `deferDoneVisibility` option already does
  this for done tasks; the change extends it to every task. A dropped band
  holds nothing, so building it claims no conversation from another band.
- `buildKanbanModel`'s existing `taskShowsOnBoard` call, the one that already
  routes refusals to `offBoard`, receives
  `bandHoldsMembers(band) || workedRecently`.

### 2.3 What the card already shows, and the one gap

From `KanbanCard.tsx`:

- **Motion line**: «Потрібні ви», «Працюють · N», «Очікує: …» with the hold's
  age, or the stopped wording.
- **Steps line**.
- **The orchestrator's status note**: short while folded, whole while open.
- **PR and issue chips** (`WorkLinkRow`): the task's own and every lane's,
  without duplicates, shown even on a folded card.
- **Lane rows** (`PipelineBlock`) with stage chips and the current stage.
  Finished lanes fold under «N завершених» past the row limit.
- **Conversation tiles** with state and the agent's latest line; Past
  attempts; launches that did not start.
- **Foot**: priority mark, age, prototype button, album, «Ask», «+ Agent».

Stage, lanes and PR are therefore on the card already, including for tasks
whose transcripts the board did not load: lanes come from the lane list, which
the board always receives.

**The gap is the age in the foot.** It reads `updatedAtMs`, titled «Оновлено
…» (`KanbanCard.tsx:861`): the edit time that maintenance passes move for 48
tasks at once. After this change the column sorts by `lastWork`. A card would
then read «4 д» while standing above a card reading «5 хв».

The fix: the foot shows `lastAgentWorkAtMs` when it is known, and
`updatedAtMs` otherwise. The phone card already does exactly this
(`phoneKanbanModel.ts:219`). The tooltip reads «Остання робота {age}» /
"Last worked {age}" for the work time and keeps «Оновлено {age}» for the
fallback. Same element, same place; one new i18n key.

### 2.4 Visual review round (60 frames, three widths, en and uk, light and dark)

Four findings from the frames, each fixed on the same elements:

- **A finished lane no longer says «Stopped, no reason given».** A stopped
  task with no declared reason that draws a lane row (desktop) or a pipeline
  line (phone) shows no state line: the row says how the work ended. The words
  stay on cards with no lane outcome to show.
- **One stopped number.** Sorting by work puts a card that stopped minutes ago
  among the live ones, so the old «trailing run of stopped cards» split counted
  two of three. The divider now holds the stopped cards nobody worked on for
  three days (`parkedCard`), and the header counts the same set
  (`column.stopped`, `column.parked`).
- **The age once.** The foot age is not drawn where a lane row on the card
  already dates the work. It stays on cards that have no lane row.
- **Work and edit do not look alike.** A card nobody worked on words its age as
  an edit («edited 2m ago» / «змінено 2 хв тому», `kanban.editedAge`), on the
  desktop foot and on the phone's agents line. A bare age always means work.

Left as they were, outside this change: the age inside «Past attempts» and in
the state line («Waiting: paused · 3d ago»), which date a different event than
the lane row.

## 3. Files to change

Line anchors are at this branch's base. They were rechecked against
`origin/main` after #2782. Of the files below, only these changed there:

- `kanbanBoard.browser.test.tsx`;
- the two i18n files, where `kanban.updated` moves to en `:4479` and uk
  `:4388`.

The other anchors are unchanged. Merge `origin/main` before building.

| file | change |
|---|---|
| `src/components/kanban/kanbanModel.ts:362-370` | Drop `MOTION_ORDER` and rewrite the order comment. |
| `src/components/kanban/kanbanModel.ts:400-417` | `compareCards`: in flight, then `lastAgentWorkAtMs`, then `updatedAtMs`, then id. `compareInboxCards(a, b, nowMs)`: recent first, then priority. |
| `src/components/kanban/kanbanModel.ts:651-691` | After `summaries`, compute `laneMovedMs = max(laneMovedAt(lane))` and `workedRecently`; pass `bandHoldsMembers(band) \|\| workedRecently` to `taskShowsOnBoard` (`:688`). |
| `src/components/kanban/kanbanModel.ts:759-763` | `lastAgentWorkAtMs` includes `laneMovedMs`; update its doc at `:130-134`. Leave `pipelineWorkAt` alone: the order of lanes inside a card stays #1729's. |
| `src/components/kanban/kanbanModel.ts:794` | The Inbox sort passes `now * 1000`. Fix the comment in `landUnderReading` (`:377-388`) that cites the motion order. |
| `src/components/scheme/taskBands.ts:136-137, 394-395` | `deferDoneVisibility` defers the board flag for every task and the doc says so. The name is kept so the tests that pass it stay untouched. |
| `src/components/kanban/KanbanCard.tsx:861` | The foot age and its tooltip, as in 2.3. |
| `src/lib/i18n/en.ts:4476`, `src/lib/i18n/uk.ts:4385` | One key beside `kanban.updated`: `kanban.worked`. |
| `src/components/kanban/kanbanModel.test.ts` | New tests, below. Update four expectations that encode the old rule: `:266` (an in-flight lane's start now counts in `lastAgentWorkAtMs`); `:317` (a paused lane no longer outranks a card worked 30 s ago); `:1147` (Inbox: working or recent cards above the priority queue); `:1289` (a needs-you card is no longer first by motion). |
| `src/components/mobile/phoneKanbanModel.test.ts:414` | The phone's Inbox inherits the new Inbox rule. |
| `src/components/kanban/issue1695Evidence.fixture.tsx` | A `recent-first` scenario beside `board-order` (`:379`, `:1964`). |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | One describe block right after «board order» (`:9265-9348`), not at the end of the file, where #2783 also adds blocks. Update «task priority»'s `INBOX`/`RAISED` (`:9362`, `:9439`): its working low-priority card now leads. |

The model rule was run before writing this, on a scratch export with the
change applied:

- `kanbanModel.test.ts`, `taskBands.test.ts`, `phoneKanbanModel.test.ts`,
  `reuseKanbanModel.test.ts` and `workingAgents.test.ts`: 137 pass and 5 fail,
  exactly the five expectations listed above. All 142 pass on the base.
- The live snapshot gives the table in 2.1.

### Unit tests to add (kanbanModel.test.ts)

1. **A recently worked waiting card sorts above a stale waiting card in the
   same column** (the acceptance test). Two Assigned cards, each with a paused
   lane:
   - card A: the lane moved 5 min ago, with no loaded transcript;
   - card B: the lane moved 3 days ago, and it has a loaded transcript stamped
     3 days ago.

   On main B is first, because a nonzero stamp beats zero. After the change A
   is first.
2. A card worked 2 min ago sorts above a needs-you card whose lane parked 2
   days ago, in Assigned and in Done.
3. In-flight cards keep their `workingSinceMs` order while `lastAgentWorkAt`
   advances.
4. Inbox:
   - a normal-priority card whose lane moved yesterday is above a
     high-priority never-worked one;
   - a lane that moved 4 days ago does not lift its card;
   - never-worked cards keep high → normal → low.
5. Visibility:
   - a `board: "hidden"` task whose band holds nothing, without
     `boardChoice` and with a lane that moved within 3 days, is a card;
   - the same task with `boardChoice` is in `offBoard`;
   - with the lane 4 days old it is in `offBoard`;
   - with `groupHidden` it is in `hiddenGroups`;
   - with an active lane it is a card whatever the lane's age.

## 4. States to cover in rendered evidence

The rendered evidence uses one describe block in `kanbanBoard.browser.test.tsx`
over the `recent-first` scenario of `issue1695Evidence.fixture.tsx`, in en and
uk. Readings go to `evidence/kanban-recent-first/readings.json`. Frames are
taken before any gate is read, so the same case renders the «before» frames on
main.

**Desktop, 1440 × 900:**

- **D1 Assigned**, in this order:
  1. a stage running now;
  2. a lane finished 5 min ago with no loaded transcript;
  3. a needs-you lane parked 2 days ago;
  4. a paused lane last moved 3 days ago;
  5. a loaded transcript from 6 days ago;
  6. a task never worked and edited 1 min ago, last.

  Read the DOM order.
- **D2 Inbox**:
  1. a low-priority card with an agent working;
  2. a normal-priority card whose lane moved yesterday;
  3. then high, normal and low never-worked cards.
- **D3 The hidden task worked recently** stands in Inbox as a card. The Hidden
  tray lists the never-worked hidden task, the explicit-choice task and the
  group-hidden task, and its count says 3.
- **D4 Done**: a card finished 10 min ago is above a done card whose merge
  blocked yesterday.
- **D5 Foot age**:
  - D1's second card reads «5 хв» / "5m", and its tooltip says
    «Остання робота …» / "Last worked …";
  - D1's last card keeps «Оновлено …».

  Measure that the age stays inside the foot and overlaps no foot control.

**Phone, 390 × 844:**

- **P1 Assigned tab**: the needs-you card first (the phone's own contract),
  then D1's order without it.
- **P2 Inbox tab**: D2's order.
- **P3** the card's meta age reads the lane time.

At both sizes there are no page errors. The phone has no horizontal overflow,
measured against the 390 px viewport passed in, not `innerWidth`. The
existing «board order» and «finding recurrence» blocks stay green unchanged;
«task priority» passes with the updated expectations.

## 5. What not to touch

- The old «Задачі» panel and its header entry, `TaskPanel`, `TaskSheet`, and
  `boardVisibility.ts` (the panel's membership note lives there). The
  panel-removal lane owns them; this design only imports
  `DONE_TASK_BOARD_RETENTION_MS` from that file.
- The board header, `ProjectBar`, and the header area of `KanbanBoard.tsx`
  (#2782).
- Agent activity: `isWorkingAgent`, `workingAgents.ts`, `cardStatus`,
  `CardStatusBadge`, `MemberTile`'s state word, and the motion wording (#2783).
  In `KanbanCard.tsx`, #2783 edits the imports and `MemberTile` (~`:166`); this
  design edits only the foot age.
- The card's layout. «Calm card» waits for the operator.
- The phone's needs-first rule (`phoneKanbanModel`), the order of lanes inside
  a card (`pipelineWorkAt`, #1729), and the column header counts.
- `countBoardTasks`, `BOARD_TASKS_PER_PROJECT_LIMIT`, server routes, MCP tools.

## Deferred — not currently justified

- **Stale «working» conversations.** A conversation flagged working, with a
  transcript quiet for a day, still lifts its card into the in-flight group.
  #2783 fixes the activity itself; forking the rule here would make two
  «working» answers.
- **False needs-you from blocked lane merges.** Finished prototype lanes with
  no PR, and batch-merged PRs read as «closed», ask the operator for a merge
  that cannot happen. Once needs-you no longer orders columns, this only
  inflates counts. It is a separate defect in lane-merge needs
  (`needReason.ts` `laneMergeNeed`), for the seat to take as its own task.
- **Assignment `at` as a work time.** Reconciliation and re-handoff rewrite
  it (`groupHide.ts` notes this), so it would make old tasks look fresh.
- **A server-side work stamp for conversations outside the board's file
  window.** Lanes cover the gap for laned work. Direct conversations with no
  lane, whose transcripts left the window, still sort by `updatedAt`. On the
  snapshot that is 2 Assigned cards.
- **Showing the 31 never-worked imported tasks.** Nobody worked them, and the
  Hidden tray already lists them.
- **Needs-you first on the desktop as an option.** Section 1.2 shows it does
  not serve the operator, and the header filter already gathers those cards.

## Check against the requirement

- «все недавние задачи, которые работали, выше»: every column now orders by
  the newest work, durable lane times included. The Inbox puts work from the
  last three days above the untouched queue.
- «не все правильно задачи показывает»: the one open task worked recently but
  hidden by an imported flag is drawn, and so are the nine done tasks behind
  the same flag. Hides by explicit choice stay hidden, and so do never-worked
  imports.
- «более детальная информация»: stage, lanes, PR chips and the orchestrator's
  note are already on the card. The age in the foot now reports the work that
  orders the column, so position and age agree.
