# Calm task cards: build plan

Status: build design. Written against `main` at `0f9a382e0` (2026-10-12).
Every `file:line` below is to that commit. Production still runs `0ef6ec49`
(deployed 2026-10-11 18:35Z), which predates the seat routing of #2769; see
§9. The research and the three prototypes this plan builds on are
`docs/design/calm-task-cards.md` and `docs/design/calm-task-cards/` at commit
`b4a8bec02` (branch of lane a6eec92d, not on `main`). The build does not need
them in the tree: the decisions, words and measurements it uses are restated
here, and the build fixture draws synthetic records, not the prototype's
extracted production records (§10).

## Originating requirement

Operator, 2026-10-12 about 10:30Z, in Russian, on the board's cards, as the
task pinned it:

> «я не понимаю, почему оно висит … эти кнопки вообще здесь как будто бы
> лишние … непонятно, на основании чего принимать решение … оркестратор
> должен сам резолвить все вот эти проблемы, ему должно приходить сообщение
> … и он должен взяться и продолжить … А мне эта кнопка нужна, наверное,
> только если … я хочу раскрыть, понять, почему она остановилась … может
> быть, хронологический порядок … карточка выглядит перегруженной».

Operator through the voice relay, 2026-10-12 about 15:05Z, read by the seat as
the decision on the waiting prototype round «Спокійні картки задач: причина
при розгортанні, зупинки розв'язує оркестратор»:

> «Improve the board's task and pipeline presentation to be compact and
> chronological, while preserving all existing information. Remove
> unnecessary action buttons and have the orchestrator resolve those items
> automatically by default. Keep an optional overflow/ellipsis menu with a
> manual retry action so the operator can retry if something goes wrong; the
> orchestrator must remain responsible for handling these items
> automatically.»

Decision as the seat reads it: variant 2. The closed card is the one of
variants 1 and 2 (a status dot and one state line, no buttons). The expanded
card shows the task's events in order, the latest eight with «Раніше · N»
above them. Skip, Retry, retry merge, leave the PR open and the review
answers leave the card face and live in the ⋯ menu on the card and on the
stop's entry, marked as a manual override. «Відповісти» is the one face
button left, where the operator is really asked something. While the seat is
handling a stop, the closed card's state line says so in plain words.

## 1. What changes, in one paragraph

Cards are **closed by default**. A closed card is its head (icon, title,
chevron, ×, ⋯), one **state line** with a status dot, a «Відповісти» row
only when the operator owes an answer, and the lane's one-line chain with
its PR. The **expanded card** keeps everything it shows today, minus every
answer button, plus a **chronology** of the task's lanes, attempts, answers,
merges and clearings, oldest first, the latest eight shown. The answers move
into the lane's group of the card's ⋯ menu, where the three that were
missing from it (accept as is, retry the merge, leave the PR open) are added,
and onto a ⋯ on the stop's own chronology entry. On the phone the closed
card in the column gets the same state line, the task screen gets the
chronology, and the answers move into the lane sheet. Two seat-side gaps are
closed (§7): a stopped merge whose PR was closed or never existed has no
instruction the seat can act on, and a wait someone already cleared stays
routed to the seat, which would make the new state line say
«Оркестратор розбирається» for good.

## 2. Every face button today and where it goes

Desktop card (`src/components/kanban/KanbanCard.tsx`), phone card
(`src/components/mobile/MobileKanban.tsx` `CardView`), phone task screen
(`src/components/mobile/MobileTaskScreen.tsx`) and phone pipeline screen
(`src/components/mobile/MobilePipelineScreen.tsx`).

### 2.1 The answers: they leave the face

| # | Control today (uk / en) | Where today | Goes to |
|---|---|---|---|
| A1 | «Пропустити {stage}» / «Повторити {stage}» (Skip / Retry) | desktop expanded card lane row (`PipelineBlock` task density, `AnswerPanel` → `AnswerButtons`, `src/components/pipelines/PipelineBlock.tsx:422`, `:721`); phone task screen and pipeline screen at 44 px («Пропустити етап» / «Повторити етап», `:963`, `:1016`) | ⋯ lane group (already holds Retry and Skip, `KanbanBoard.tsx:1621–1622`), now with the answer's own words; ⋯ on the stop's chronology entry; phone lane sheet |
| A2 | «Прийняти без ревʼю» / «Ще одне ревʼю» (review stop) | same | same: the ⋯ items take these words when `reviewStop` applies (`pipelineBlockModel.ts:196`, `answerLabel` `:278`) |
| A3 | «Прийняти як є» (Accept as is, `needs_review`) | same | **added** to the ⋯ lane group (today absent from it); stop entry ⋯; phone lane sheet |
| A4 | «Залишити PR відкритим» / «Спробувати мердж ще раз» (stopped merge) | same (`mergeNeedsYou`, `pipelineBlockModel.ts:377`) | **added** to the ⋯ lane group (today absent); stop entry ⋯; phone lane sheet and pipeline screen sheet |

A seat-owned lane's answers carry the hint «Вручну: оркестратор робить це
сам» / «Manual override: the orchestrator does this itself». A lane the
operator owns (no seat, or a lane they made by hand that stopped after its
last fix, `laneReservedForOperator`, `src/lib/attention/routing.ts:59`)
carries no such hint: there the answer is theirs, and «Відповісти» on the
closed card opens exactly this group (§4.3).

### 2.2 The card foot: it moves into the expanded card

The closed card has no foot. The expanded card keeps the foot, minus the
three needs-you controls, whose job the state line and the ⋯ take over.

| Control today | Today | After |
|---|---|---|
| Reason text «Потрібні ви: …» + «+N» | foot (`KanbanCard.tsx:434`) | the state line says it once (§5); removed from the foot |
| ✓ «Зняти» (Dismiss) | foot icon button (`:442`) | card ⋯ item «Зняти позначку» / «Stop flagging», with today's hint (`needs.dismissHint`); shown while `card.reasons` is not empty |
| «Знято · ви · 5 хв» + «Скасувати» (Undo) | foot (`:451–456`) | the clearing is a chronology entry (§3); Undo is the card ⋯ item «Повернути позначку» / «Flag again» while `card.cleared` is not empty |
| Working / conversation counts | foot | expanded foot, unchanged |
| Prototype review button «Питання до вас» / «Прототип готовий» | foot (`CardPrototypeButton`) | while a round **waits**, the closed card's «Відповісти» opens it; the button itself stays in the expanded foot, unchanged (fence 9a4857cb) |
| Album, «Спитати», «+ Агент», host chip | foot | expanded foot, unchanged |
| Priority mark ↑ / ↓ (no action) | foot | end of the closed card's state line (it is how the Inbox reads at a glance) |
| Age | foot | the state line's age (§5); the expanded foot keeps «оновлено …» |

### 2.3 Everything else on the card: it stays where the content goes

| Control | Closed | Expanded |
|---|---|---|
| Chevron (expand / collapse), × hide, ⋯ | yes | yes |
| Task icon (icon picker), title (rename) | yes | yes |
| Project chip (Overview only) | yes | yes |
| One-line chain + PR (`PipelineBlock` card density) | yes, with no reason line (§6.2) | no: the lane rows draw it |
| `TaskMotionLine` (hold, working N, waiting, paused, finding recurrence) | becomes the state line's text when no lane owns the line (§5) | same line |
| `TaskStepsLine`, `TaskStatusNote`, task's own links row | no | yes |
| Description, Details, edit-failed / incoming-edit notices, resurfaced notice | no | yes, unchanged |
| Lane rows (`PipelineBlock` task density: opener ›, graph toggle, chain pills that open stages, PR chips, report and findings, merge notes, finish flag) | no | yes, **without answer buttons** |
| Stage panels, member tiles, drafts, failed launches, refs | no | yes, unchanged |
| «Минулі спроби · N» (`PastAttempts`) | no | attempts and review rounds move into the chronology; the section keeps only helper conversations and conversations not loaded (§3.4) |

A stage panel or a draft forces its card open, as `reading` does today
(`KanbanCard.tsx:411`).

### 2.4 Phone

| Control | Today | After |
|---|---|---|
| Phone card in a column | no answers; `TaskMotionLine` plus the card-density block's warning reason line | the state line with its dot (§5); the block draws no reason line; a full-width 44 px «Відповісти» row when the operator owes an answer (§4.3) |
| Task screen lane: Skip / Retry / review / merge answers at 44 px (`MobileTaskScreen.tsx:762`, `:789`) | buttons | removed; the lane sheet (`MobileTaskScreen.tsx:846`) gains the answer rows (§4.2) |
| Pipeline screen answers (`MobilePipelineScreen.tsx:566`) | buttons | removed; its action sheet gains the same rows |
| Phone long-press sheet | unchanged | unchanged |

## 3. The chronology

### 3.1 Model

A pure, browser-safe module, `src/components/kanban/taskChronology.ts`, with
no words in it (the component turns kinds into words), so a unit test reads
it without React or a locale:

```ts
export type ChronologyKind =
  | "task-created" | "lane-started"
  | "attempt-passed" | "attempt-failed" | "attempt-cut" | "attempt-lost"
  | "attempt-stopped" | "attempt-running" | "round"
  | "decision-answered" | "lane-paused" | "lane-resumed" | "lane-cleared"
  | "merge-queued" | "merge-updated" | "merge-stopped" | "merge-merged" | "lane-closed"
  | "need-cleared";

export interface ChronologyEntry {
  key: string;                 // stable: pipelineId:kind:stageId:n
  kind: ChronologyKind;
  atMs: number;
  pipelineId: string | null;
  stageId: string | null;
  attempt: number | null;
  count?: number;              // folded restarts; findings
  /** The lane's current stop: its manual answers ride this entry. */
  stop?: true;
  /** The attempt's or round's conversation, when one was kept. */
  conversation?: { path: string | null; conversationId: string | null };
  actor?: "operator" | "seat" | "agent" | "system";
  /** The record's own words for a stop, for «Подробиці». */
  detail?: string;
  stopKind?: LaneStopKind;     // §5.2
  prNumber?: number | null;
  mergeReason?: string | null; // merge.reason as stored
}

export function taskChronology(input: {
  taskCreatedAt: string | null;
  pipelines: readonly Pipeline[];
  past: readonly PastAttempt[];   // card.past (kanbanModel.ts:771)
  cleared: readonly ClearedNeed[];// card.cleared
  seatConversationId: string | null;
}): ChronologyEntry[];            // oldest first

export function foldChronology(entries: readonly ChronologyEntry[], open: boolean, recent = 8):
  { hidden: number; shown: ChronologyEntry[] };
```

`foldChronology`: with `open` false it shows the last `recent` entries and
counts the rest as hidden. Every entry with `stop` that falls under the fold
is pulled out and shown first after the «Раніше · N» row, and N drops by one
for each, so a lane's answers are always read under their reason (the
research's second critic round). With `open` true it shows everything.

### 3.2 Data sources

Everything is already on the board's records; nothing new is stored.

| Entry | Source | Time |
|---|---|---|
| task-created | `task.createdAt` | that |
| lane-started (only when the card holds more than one lane) | `pipeline.createdAt`, title by `pipelineTitle` | that |
| attempt-passed / -failed / -stopped, round | `card.past` rows (`pastAttempts`, `src/components/kanban/pipelineGraph.ts:569`: own attempts only, review-loop rounds included), joined to `pipeline.runs[].attempts[n]` for `error`, `verdict.findings` and `report.verdict.findings` | `completedAt`, else `startedAt` (`atMs` of the row) |
| attempt-cut | a run of consecutive attempts whose `error` says the stage was interrupted by a Delegatus restart, folded into one entry with its count | the last one's |
| attempt-lost | an attempt whose `error` says its stage host was lost | that |
| attempt-running | the stage's live latest attempt (`running`, `reviewing`, `committing`, `spawning`), which `pastAttempts` leaves out | `startedAt` |
| attempt-stopped with `stop` | the cursor stage's latest attempt of a lane in `needs_decision`, and the review stage of a lane in `needs_review` (`laneStageId`, `needReason.ts:94`); `detail` is `attempt.error ?? pipeline.stateDetail` with the « · Viewer publication…» tail cut | `completedAt`, else `report.at`, else `startedAt` |
| decision-answered | `pipeline.decisionAnswers[]` (`types.ts:336`): stage, attempt, actor, `at`; actor `operator` → «ви», an agent equal to the board's seat conversation → «оркестратор», any other agent → «агент» | `at` |
| lane-paused / -resumed | `pipeline.pausedAt`, `pipeline.resumedAt` (only the latest of each is stored) | those |
| lane-cleared | `pipeline.dismissedAt` / `dismissedBy` | that |
| need-cleared | `card.cleared[]` for conversation reasons (`needReason.ts` `ClearedNeed`) | `at` |
| merge-queued | `merge.requestedAt` | that |
| merge-updated | `merge.updates[].requestedAt` | each |
| merge-stopped, with `stop` while the lane's merge still asks | `merge.blockedAt`, `merge.reason` | that |
| merge-merged | `merge.mergedAt`, `merge.by` («Delegatus змерджив» / «змерджено поза Delegatus») | that |
| lane-closed | `pipeline.closedAt` on a `closed` lane | that |

What the chronology does not carry, and where it stays: a stage's account
and engine (the Stages sheet and the stage conversation, as today), the
findings' text (the lane row's report, as today), a stage's prompt (the
stage panel). Who pressed a retry is not recorded on the attempt, so the
chronology says «запущено знову», not who did it (Deferred).

### 3.3 Rendering (`src/components/kanban/TaskChronology.tsx`)

- An ordered list under a small heading «Хронологія» / «Timeline». Desktop:
  time column, a tone mark, text. Phone: the time leads the entry's own line
  (no time column), so the ⋯ keeps its 44 px.
- Times through `clockText` / `dateTimeText` of
  `src/components/activity/format.ts` (`hourCycle: "h23"`), in the browser's
  time zone; the day is added when it is not today. No AM/PM in English.
- An attempt or round entry with a kept conversation is a button that opens
  it through the card's existing `onOpenAttempt`.
- A `stop` entry carries a ⋯ (desktop: `openPipelineMenu` for its lane,
  `KanbanBoard.tsx:2114`; phone: the lane sheet) and, when `detail` is set,
  a «Подробиці» / «Details» disclosure with the record's words, at most six
  lines, scrolling inside itself, `overflow-wrap: anywhere`.
- There is no «зараз» entry: the state line above says who has the card now,
  once.

### 3.4 Words (uk / en)

| Kind | uk | en |
|---|---|---|
| heading | Хронологія | Timeline |
| fold row | Раніше · {count} | Earlier · {count} |
| task-created | Задачу створено | Task created |
| lane-started | Запущено лінію: {title} | Lane started: {title} |
| attempt-passed | {stage}: пройдено | {stage} passed |
| attempt-failed with findings | {stage}: {count} зауваження / зауважень (plural forms) | {stage}: {count} finding(s) |
| attempt-failed without | {stage}: не вдалося | {stage} failed |
| attempt-cut | {stage}: перервано перезапуском Delegatus, запущено знову; {count} > 1: {stage}: {count} рази перервано перезапуском Delegatus | {stage}: cut by a Delegatus restart, started again; {stage}: cut {count} times by Delegatus restarts |
| attempt-lost | {stage}: агент загубився, запущено знову | {stage}: the agent was lost, started again |
| attempt-running | {stage}: працює | {stage} is running |
| attempt-stopped | {stage}: зупинилось — {why} (why from §5.2's short words) | {stage} stopped: {why} |
| round | {stage}, раунд {n}: {verdict} | {stage}, round {n}: {verdict} |
| decision-answered | {who} відповіли на питання «{stage}» | {who} answered the {stage} question |
| lane-paused / -resumed | Лінію призупинено / Лінію продовжено | Lane paused / Lane resumed |
| lane-cleared, need-cleared | Знято · {who} | Cleared · {who} |
| merge-queued | Мердж PR #{pr} у черзі | PR #{pr} merge queued |
| merge-updated | PR #{pr} оновлено з main | PR #{pr} updated from main |
| merge-stopped | Мердж зупинено: {reason} (`mergeReasonText`) | Merge stopped: {reason} |
| merge-merged | PR #{pr} змерджено · {by} | PR #{pr} merged · {by} |
| lane-closed | Лінію закрито | Lane closed |
| Details | Подробиці | Details |

`{who}`: «ви» / «you», «оркестратор» / «the orchestrator», «агент» /
«an agent», reusing `needs.clearedBy*` where they exist.

## 4. The ⋯ menu and «Відповісти»

### 4.1 Card ⋯ (`KanbanBoard.tsx:1446–1506`)

In order; new or changed items in bold.

1. Move to (statuses), Priority, Colour.
2. Icon, **«Розгорнути картку» / «Згорнути картку»** (the existing item, now
   reading the open set), Rename, Describe, Attach link.
3. **«Зняти позначку»** (while the card asks) or **«Повернути позначку»**
   (while something on it is cleared): the old ✓ and Undo.
4. One group per lane (`laneGroups`, `:1479`), headed by the lane title when
   the card holds more than one, its state word as the head's note:
   - Stages ›, Attach link to the pipeline, Pause / Resume (unchanged);
   - **the lane's answers** from `pipelineAnswers` (`pipelineBlockModel.ts:246`)
     in `answerLabel` words (`:278`): Skip / Retry {stage}, or «Прийняти без
     ревʼю» / «Ще одне ревʼю» on a review stop, **«Прийняти як є»**,
     **«Спробувати мердж ще раз»**, **«Залишити PR відкритим»**. Each has
     the hint «Вручну: оркестратор робить це сам» when the seat owns the
     lane (§5.1) and none when the operator does. A lane with no answers
     keeps today's disabled Retry / Skip with their refusal hints;
   - Finishes the task (unchanged); Close (unchanged).
5. Hide from board (unchanged).

The answers are built by one pure helper,
`src/components/kanban/laneAnswerMenu.ts`:
`laneAnswerItems(t, pipeline, owner) → { action, label, why, stageId, stageName, expectedAttempt }[]`.
The desktop ⋯, the stop entry's ⋯ (same `pipelineMenu`), the phone lane
sheet and the phone pipeline screen's sheet all read it, and each selection
goes through the existing `startPipelineAction` (desktop) or `lane.start`
(phone), with Skip and Close held for their receipt as `answerPipeline` does
today (`KanbanBoard.tsx:2119`).

### 4.2 Phone sheets

The lane sheet (`MobileTaskScreen.tsx:846`) and the pipeline screen's action
sheet gain, after the existing rows and a divider, one `MobileSheetRow` per
`laneAnswerItems` entry (44 px), with one muted caption row above them
«Вручну · оркестратор робить це сам» when the seat owns the lane.

### 4.3 «Відповісти» / «Answer»

Shown on the closed card only when the card's owner is **you** (§5.1); a
quiet secondary button on the desktop, a full-width 44 px row on the phone.
It goes where the answer is given, by the subject the state line names:

| Subject | Desktop | Phone |
|---|---|---|
| A decision form waits: the card's own task round (`prototypeWaitsOnOperator`), or a lane whose route is `form` (`routeTypes.ts:27`) | `openPrototypeReview({ taskId, reviewId })` (`src/hooks/usePrototypeReview.ts:15`) | same |
| A conversation reason of the operator's (`card.reasons[0]` with subject `conversation`) | `onOpenMember(file)` | open that conversation |
| A lane the operator owns (`card.reasons[0]` with subject `pipeline`) | the lane's menu (`pipelineMenu`, kind `pipeline`) anchored on the button | the task screen opens with that lane's sheet open (a new `openLane` prop on `MobileTaskScreen`) |

The oldest reason wins, as the foot's text does today (`byNeedAge`). A
taskless seat round (open PR #2758) has no task to open; if #2758 lands
first, that case opens its «Рішення» column instead.

## 5. The state line

### 5.1 Owner

A pure module, `src/components/kanban/cardState.ts`, decides one owner per
lane and one per card. The owner comes from what the server already stamps
and the client already reads; the cause only picks words.

| Owner | Lane | Dot |
|---|---|---|
| **you** | `laneNeed(pipeline)` returns an uncleared need (`needReason.ts:108`), or the lane's route is `form` | amber (`--color-warning`) |
| **seat** | `laneRouteNow(pipeline)?.owner === "seat"` (`routeTypes.ts:106`) | indigo (`--color-accent`) |
| **waiting** | route `system` (an automatic retry), `paused`, a merge waiting for checks, provisioning waiting for disk, a draft, or a stop someone cleared (`laneNeed(…).cleared`) | grey ring |
| **working** | `running`, provisioning, a merge updating or merging | green (`--color-success`) |
| **done** | `completed` (merge merged, none, or cancelled) or `closed` | faded green |

Card owner: **you** when `card.needsYou` (`kanbanModel.ts:677`, which already
excludes routed lanes) or a lane is `form`; else the most urgent lane (seat,
then working, then waiting, then done); a seat-routed member conversation
(`attentionReason(file).route.owner === "seat"`) also makes it **seat**;
otherwise the card motion decides (`working` → working, `waiting` /
`stopped` → waiting, `done` → done; `not-started` draws no state line, as
`TaskMotionLine` draws none today). The motion itself is not changed (it
orders the columns: lane dde55e2d).

On a lane the seat owns, the parked stage's chip takes the seat's tone (the
alert glyph in `--color-accent`) and the block drops `data-needs`, so amber
appears only on a card that asks the operator. `PipelineBlock` reads the
owner from `cardState`'s lane rule rather than `pipelineNeedsYou`
(`PipelineBlock.tsx:564`, `:815`).

### 5.2 Stop kinds

`src/lib/pipelines/laneStop.ts`, pure and browser-safe, shared by the card and
the seat's wake (§7):

```ts
export type LaneStopKind = "question" | "review" | "unreviewed" | "commit" | "publish"
  | "capacity" | "auth" | "transport" | "provisioning" | "merge" | "other";
export function laneStopKind(pipeline: Pipeline): { kind: LaneStopKind; stageId: string | null } | null;
```

Order: a completed lane with a blocked merge → `merge`; `needs_review` →
`unreviewed`; `reviewStop(pipeline)` → `review`; a cursor attempt whose
verdict or report is `needs_decision` → `question`; no attempts →
`provisioning`; then the cursor attempt's `error` (or `stateDetail`) by the
prefix its producer writes: «committing the passed stage» and «created a
commit» (`src/lib/pipelines/git.ts:763`, `:649`) → `commit`; «publishing the
passed stage» → `publish`; «no allowed {engine} account has capacity» / «is
available» (`src/lib/accounts/projectBindings.ts:522–524`) → `capacity`;
«requires authentication» / «authentication check failed» → `auth`; «stage
host was lost», «spawn recovery», «transport» → `transport`; anything else →
`other`. `laneStop.test.ts` pins each producer's real phrase.

### 5.3 Wording (uk / en)

The line is one sentence and the age; at most two lines on a 280 px column,
never cut mid-word; the dot sits on its first line. The priority mark, when
set, ends the line.

| Owner and subject | uk | en |
|---|---|---|
| you · decision form | Потрібна ваша відповідь: {form title} | Needs your answer: {form title} |
| you · conversation | Потрібна ваша відповідь: {needLabel} | Needs your answer: {needLabel} |
| you · lane | Потрібна ваша відповідь: {why} | Needs your answer: {why} |
| seat · lane | Оркестратор розбирається: {why} | The orchestrator is on it: {why} |
| seat · conversation | Оркестратор відповідає: {role} | The orchestrator is answering: {role} |
| waiting · automatic retry | Чекає ліміту акаунта · повтор о {HH:MM} | Waiting for the account limit · retry at {HH:MM} |
| waiting · cleared stop | Зупинилось · знято ({who}) | Stopped · cleared ({who}) |
| working / waiting / done otherwise | `TaskMotionLine`'s own label, unchanged («Працює», «Працюють · 2», «Очікує: …», «Очікує: призупинено», hold reasons, finding recurrence) | same |

`{why}` by stop kind:

| Kind | uk | en |
|---|---|---|
| question | «{stage}» поставив питання | {stage} asked a question |
| review | рев'ю «{stage}» вичерпало раунди | {stage} used up its review rounds |
| unreviewed | останнє виправлення не переглянуто | the last fix is unreviewed |
| commit | коміт «{stage}» не вдався | the {stage} commit failed |
| publish | гілку не вдалося опублікувати | the branch could not be published |
| capacity | немає вільного акаунта для «{stage}» | no account has capacity for {stage} |
| auth | акаунт «{stage}» не пройшов вхід | the {stage} account failed its sign-in check |
| transport | зв'язок з агентом «{stage}» обірвався | lost the {stage} agent |
| provisioning | лінію не вдалося підготувати | the lane could not be prepared |
| merge | мердж PR #{pr} зупинено: {mergeReasonText} | PR #{pr} merge stopped: {mergeReasonText} |
| other | «{stage}» зупинилось | {stage} stopped |

The chronology's `attempt-stopped` uses the same `{why}` minus the stage
(«поставив питання», «коміт не вдався», …).

The line says what stopped and who has it. It never predicts what the seat
will do («Оркестратор повторює коміт»): the card cannot know that.

### 5.4 Dot and popover

The dot is the 8 px dot of open PR #2783 (`CardStatusBadge` `ActivityDot`):
a `role="button"` span, its popover a portalled `TooltipBubble`
(`src/components/TooltipBubble.tsx`, on `main`) opened by hover, focus or
tap, closed by Escape or a tap elsewhere, never changing the card's height.
The popover is one line, the owner and how long:

| Owner | uk | en |
|---|---|---|
| you | Чекає вашої відповіді вже {age} | Waiting for your answer for {age} |
| seat | Оркестратор розбирається вже {age} | The orchestrator has been on it for {age} |
| working | Працює вже {age} | Working for {age} |
| waiting | Чекає вже {age} | Waiting for {age} |
| done | Готово {age} тому | Done {age} ago |

`{age}` is `humanizeDuration` of the time since the lane last moved
(`pipelineMovedAtMs`), since the merge stopped for a merge, or the motion's
`since`. Note the same amber means «checking» on #2783's member-tile dot; the
words beside each dot keep them apart.

## 6. The closed and expanded card, concretely

### 6.1 Desktop (`KanbanCard.tsx`, `KanbanBoard.tsx`)

- `KanbanBoard` keeps an **open** set in place of the collapsed set
  (`KanbanBoard.tsx:380`), session-only as today; `collapsed` passed to the
  card becomes `!open.has(id) && !reading`. The chevron, the ⋯ item and the
  state line (a button) toggle it.
- Closed: head; `CardStateLine` (dot, line, age, priority mark);
  «Відповісти» row when owner is you; one chain row: the top lane's
  `PipelineBlock` at card density with no reason line, «+N лінії» / «+N
  lanes» for the other unfinished lanes, the PR at the end.
- Expanded: head; `CardStateLine`; then today's expanded body in today's
  order, with the chronology inserted after Details and before the lane rows;
  lane rows without `onAnswer`; `PastAttempts` with helpers and
  not-loaded conversations only; the foot of §2.2.
- `answerPipeline` and `KanbanCard`'s `onAnswer` prop are deleted; the
  menu's own `item()` path sends the actions.

### 6.2 `PipelineBlock`

- Card density: a `reasonLine?: boolean` prop (default true) the closed
  desktop card and the phone card set to false; today's `managedOn` stays
  for remote lanes only.
- Task and screen densities: `onAnswer`, `largeAnswers` and `AnswerButtons`
  are removed (no caller is left); `AnswerPanel` becomes the report only
  (what the stage said, its findings, the merge reason, the review heads),
  which it already draws without buttons when `onAnswer` is absent
  (`PipelineBlock.tsx:463`).
- The seat tone of §5.1 for a seat-owned parked chip.

### 6.3 Phone

- `MobileKanban.tsx` `CardView`: `CardStateLine` in place of `TaskMotionLine`
  and of the block's reason line; the «Відповісти» row of §4.3.
- `MobileTaskScreen.tsx`: `TaskChronology` after the description block and
  before the lanes; no `onAnswer` / `largeAnswers`; the lane sheet rows of
  §4.2; an `openLane?: string` prop for «Відповісти».
- `MobilePipelineScreen.tsx`: no `onAnswer`; its sheet gains §4.2's rows.

## 7. Does every stop reach the seat? The path, and the two gaps

### 7.1 The path on `main`, end to end

1. `/api/files` stamps every lane's route after every other overlay
   (`src/app/api/files/response.ts:876` → `overlayAttentionRoutes`,
   `src/lib/attention/routeOverlay.ts:93` → `laneRoute`,
   `src/lib/attention/routing.ts:122`). A lane in `needs_decision`,
   `needs_review` or a completed lane whose merge is `blocked`
   (`laneNeedKind`, `routeTypes.ts:83`) goes to the project's designated
   seat when the seat is active and its tick is on (`routingInputs`,
   `routeOverlay.ts:74`), except a provider wait with a scheduled retry
   (`system`, `routing.ts:45`), a hand-made lane stopped after its last fix
   (operator, `routing.ts:59`) and a wait the seat escalated to a waiting
   form (`form`).
2. The seat tick reads the same projection
   (`src/lib/monitor/seatTickSources.ts:720` → `seatAgendaAsks`,
   `src/lib/attention/seatAgenda.ts:94`) and puts each seat-routed wait on
   the wake as an `ask` item ahead of the seat's own news
   (`seatTick.ts:1868`) with the reason «a worker or stage waits on you
   first» (`seatTick.ts:1316`). An item beyond the five per wake stays
   offered for the next one; a delivered item is not repeated while its key
   (`laneRouteKey`, `routeTypes.ts:93`) is unchanged; a seat rotation offers
   it again to the new seat (`seatTick.ts:2230`).
3. The item says what to do (`laneLine`, `seatAgenda.ts:65`): a decision →
   `pipeline_action resolve-decision`, or `retry-stage` for a mechanical
   stop; a spent review → `accept-head`; a stopped merge → «repair it and
   pipeline_action retry-merge»; and in every case how to escalate through
   a decision form. The `dismiss_attention` description repeats the duty
   (`src/lib/mcp/server.ts:3381`), and the mandate's merge bar says to act on
   `merge.state blocked` (`src/lib/orchestrator/prompt.ts:469`).
4. The seat may act: `retry-stage`, `skip-stage` and `retry-merge` are not
   creator-gated, and `resolve-decision` / `accept-head` admit the active
   seat (`mayAnswerPipelineDecision`, `src/lib/pipelines/engine.ts:11221`).

By the research's classes: commit, publish, transport, auth and account
capacity park as `needs_decision` (an admission refusal for capacity saves no
provider wait, `engine.ts:8290`) and route to the seat; merge and conflict
are `lane-merge`; the review budget is `lane-review` or a review park. All
reach the seat as an `ask` item.

### 7.2 Gap 1: a stopped merge whose PR was closed or never existed

`laneLine` gives every stopped merge one instruction, «repair it and
pipeline_action retry-merge». For «the PR was closed» (8 of the 17 stopped
merges at the research snapshot) and «no pull request is linked» (3), a retry
blocks again at once (`MERGE_REASONS.closed`, `.noPr`,
`src/lib/forge/mergeReasons.ts:6`). The seat either loops or leaves it, and
with this build the card would say «Оркестратор розбирається: мердж PR #…
зупинено» for good.

Fix (`seatAgenda.ts` `laneLine`): name the merge class from `merge.reason`
and give its step:

- `closed`, `noPr`, `settingOff` → the change reached main another way or
  the lane had nothing to merge: `pipeline_action dismiss` (the same write as
  «Leave the PR open»), with a one-line reason;
- `conflict`, `mainMoving`, `headChanged` → a refresh lane (merge current
  main, resolve, one review of the resolution), then `retry-merge`; once open
  PR #2777 lands this is automatic and the line says so;
- `checksTimeout`, a red check, `noChecks` → `retry-merge` once checks are
  green;
- anything else → today's text.

For a parked lane the label also prefixes `laneStopKind` («[commit]»,
«[transport]», …) so the seat reads the class before the stage's words. No
mandate sentence is added (the mandate sits at its envelope; `prompt.test.ts`
and `handoffDigest.test.ts` budgets).

### 7.3 Gap 2: a cleared wait stays routed to the seat

`laneRoute` routes on `laneNeedKind` alone. A lane whose dismissal covers its
current wait (the seat or the operator pressed «Leave the PR open», or
cleared a decision) keeps a `seat` route: `laneNeed` then returns null before
it ever looks at the dismissal (`needReason.ts:110`), so the card cannot say
«знято», and `seatAgendaAsks` keeps listing it, which re-offers it to every
new seat after a rotation.

Fix (`routing.ts` `laneRoute`): a wait the lane's dismissal covers routes to
nobody, by the predicate the dismissal write already uses (`laneCleared`,
`src/lib/attention/dismissals.ts:436`), moved to `routeTypes.ts` as
`laneWaitCleared(pipeline)` so the browser and the server share it. `laneNeed`
then reports it as cleared, with who cleared it, as it does for an operator's
dismissal today; the card's owner is **waiting** with «Зупинилось · знято
(оркестратор)»; the chronology shows the clearing.

### 7.4 Not gaps, and why

- A project with no active seat, or its tick off: every wait is the
  operator's, by design; the card shows «Відповісти».
- A provider wait with a scheduled retry is the engine's (`system`); the card
  says «Чекає ліміту акаунта · повтор о …». Its retry is cancelled by a
  control change or a different park, which routes the lane afresh.
- A delivered item is not repeated while the seat leaves the lane parked.
  That is the ledger's contract (`seatTick.ts:1316`); a reminder is Deferred.
  The popover's age makes a long wait visible.
- The seat's own-lane line still says «parked on a decision» for any park
  (`seatTick.ts:745`); the `ask` item for the same lane, which comes first,
  names the class. Left alone because open PR #2783 edits `seatTick.ts`.

## 8. Files to change

New:

- `src/lib/pipelines/laneStop.ts`, `laneStop.test.ts`
- `src/components/kanban/cardState.ts`, `cardState.test.ts`
- `src/components/kanban/taskChronology.ts`, `taskChronology.test.ts`
- `src/components/kanban/laneAnswerMenu.ts`, `laneAnswerMenu.test.ts`
- `src/components/kanban/CardStateLine.tsx`
- `src/components/kanban/TaskChronology.tsx`

Changed:

- `src/components/kanban/KanbanCard.tsx`, `KanbanBoard.tsx`, `kanbanBoard.css`
- `src/components/kanban/PipelineSection.tsx` (`PastAttempts` keeps helpers and
  not-loaded conversations)
- `src/components/pipelines/PipelineBlock.tsx`, `pipelineBlock.css`
- `src/components/mobile/MobileKanban.tsx`, `MobileTaskScreen.tsx`,
  `MobilePipelineScreen.tsx`
- `src/lib/attention/routing.ts`, `routeTypes.ts`, `dismissals.ts` (the moved
  predicate), `seatAgenda.ts`
- `src/lib/i18n/en.ts`, `uk.ts`
- `src/components/kanban/issue1695Evidence.fixture.tsx` (scenario
  `calm-cards`), `kanbanBoard.browser.test.tsx` (one `describe`)

Tests to run by path, each under isolated HOME, XDG, TMPDIR and
`LLV_STATE_DIR`, through `scripts/gate-slot.sh`, in one gate-slot call:

- new: the four model tests above. `taskChronology.test.ts` covers order,
  restart folding, the fold of eight, a stop pinned after «Раніше · N» when a
  second lane's work pushes it under the fold, decision answers, merges and
  clearings. `laneAnswerMenu.test.ts` covers, for a decision, a decision with
  skip refused, a review stop, `needs_review` and a stopped merge, that every
  action `pipelineAnswers` yields is in the menu with `answerLabel`'s words,
  with the manual hint only when the seat owns the lane; this is the
  «removed buttons are reachable from ⋯» test.
- changed: `src/lib/attention/routing.test.ts` (a cleared decision and a
  cleared merge route nowhere; an uncleared one still routes to the seat),
  `seatAgenda.test.ts` (each merge class's step; the stop-kind prefix),
  `needReason` tests, `PipelineBlock.dom.test.tsx`,
  `KanbanStages.dom.test.tsx`, `KanbanPipelines.dom.test.tsx`,
  `KanbanDismiss.dom.test.tsx`, `MobileTaskScreen.dom.test.tsx`,
  `MobilePipelineScreen.dom.test.tsx`,
  `MobilePipelineScreen.actions.dom.test.tsx`.
- the kanban browser driver for the new block; the older blocks that press
  answer buttons on a card face (#2187 «answers in plain words», #1938,
  #2072, K5b) press them through the ⋯ instead, and the ones that read lane
  rows open the card first. Their committed `evidence/**/*.json` stays.
- `tsc` on the touched files and ESLint on changed files (the pre-push hook).

Expect the default-closed card to touch most kanban DOM and browser tests
that read lane rows. Give the fixture a `cards=open` query that starts every
card open (passed to `KanbanBoard` as `initialOpen`), so blocks that are not
about the card face keep their setup with one query parameter.

## 9. Rollout

The **seat** owner depends on the route stamps of #2769. Production
(`0ef6ec49`) has none, so until `main` is deployed every stop there would
read «Потрібна ваша відповідь». Deploy `main` with or before this change
(the standing deploy covers it). No migration; no stored field changes.

## 10. States to render

Scenario `calm-cards` in `issue1695Evidence.fixture.tsx`, synthetic records
shaped like the research's seven production cards, Delegatus project with a
designated seat whose tick is on. Fixture strings follow the privacy rules:
no UUID-like ids, no real hosts, branch names as plain words.

| Card | Record | Owner |
|---|---|---|
| C1 | a lane parked after a passed stage's commit failed, route `seat` | seat |
| C2 | a completed lane, merge `blocked` on a conflict, route `seat`, a refresh lane running beside it | seat (closed line) and working (second lane) |
| C3 | a lane whose wait the seat escalated to a waiting round on this task (route `form`) | you |
| C4 | a member conversation with an operator question (no route) | you |
| C5 | a running stage | working |
| C6 | a provider wait with a scheduled retry (route `system`) | waiting |
| C7 | done, PR merged by Delegatus | done |
| C8 | two lanes, twelve-plus events with three restart cuts, the first lane's stop older than the last eight | seat, stop pinned under the fold |
| C9 | a completed lane whose closed-PR merge the seat cleared | waiting, «знято (оркестратор)» |

Frames, each at **1440 and 390** (and 1000 for the narrow desktop column),
**uk and en, light and dark**:

1. The board with every card closed.
2. C1, C3 and C8 expanded on the desktop; on the phone, the task screens of
   C1, C3 and C8.
3. C1's ⋯ open (manual hint on the answers); C1's stop entry ⋯ open; C3's
   «Відповісти» after the press (the form open); on the phone, C1's lane
   sheet with the answer rows and the caption.
4. C1's dot popover open.

Measured in the driver, failing the run on any miss:

- no `[data-answer-action]` anywhere on a card or a phone screen; one
  «Відповісти» on C3 and C4 and none elsewhere;
- for C1, C2, C3 and C8, the count of answer items in the ⋯ lane group (and
  in the phone lane sheet) equals the lane's own `pipelineAnswers` count;
- C8 shows eight entries plus the fold row, and C8's stop entry is visible
  with its ⋯ without opening «Раніше»;
- every time in en has no AM/PM;
- no sideways scroll at 390 (scrollLeft probe), no cut title or state line
  (a Range against its box), the state line on at most two lines, the dot
  within 2 px of the first line's centre, the popover covering no text of
  the state line, «Відповісти» and every phone sheet row at least 44 px tall;
- no amber on C1, C2, C5–C9 (no `data-needs`, no warning-toned chip).

Then read every frame.

## 11. What not to touch

- Column order, `compareCards`, the motion keys, which tasks reach the board
  (lane dde55e2d). This lane changes what a card shows and how it is laid
  out, never where it stands.
- The old «Задачі» panel (lane a64c2c70); the board header (#2782).
- Agent activity: `CardStatusBadge`, `TooltipBubble` internals, member tile
  state words, `agentActivity` (#2783, lane 23790aa4). Reuse its dot and
  words; do not change them.
- The prototype review form, its window and `CardPrototypeButton`
  (lane 9a4857cb), and the decision column of open PR #2758.
- `src/lib/monitor/seatTick.ts` and the mandate in
  `src/lib/orchestrator/prompt.ts`.
- The pipeline engine and its action semantics; MCP tool descriptions.
- The Stages sheet, the graph, the phone long-press sheet, remote lanes
  (`managedOn`), the card-density chain folding.
- Edit-conflict, failed-launch and resurfaced notices (not lane stops).

## 12. Validation against the requirement

- «эти кнопки … лишние … путают» / «Remove unnecessary action buttons»: no
  answer button on any card face or phone screen; «Відповісти» only where
  the operator is asked (§2, §4.3), measured (§10).
- «оркестратор должен сам резолвить … ему должно приходить сообщение … и он
  должен взяться и продолжить» / «the orchestrator resolve those items
  automatically by default»: every seat-resolvable class reaches the seat as
  an `ask` item with its step (§7.1); the two places it could not act or
  would be told twice are fixed (§7.2, §7.3).
- «раскрыть, понять, почему она остановилась»: the state line names the stop
  on the closed card; the expanded card's chronology names it in order with
  the record's words under «Подробиці» (§3, §5).
- «хронологический порядок» / «compact and chronological»: closed by
  default; the chronology (§3).
- «preserving all existing information»: §2.3 and §3.2 place every fact the
  card shows today.
- «Keep an optional overflow/ellipsis menu with a manual retry action»: the
  ⋯ lane group and the stop entry's ⋯, marked as a manual override (§4).

## Deferred — not currently justified

- **Re-offering a wait the seat left unresolved** (a reminder after some
  hours). The ledger offers each wait once per seat; the popover age shows a
  long wait and the ⋯ keeps the manual answer.
- **Recording who pressed a retry or skip** on the attempt, for the
  chronology. Decision answers already carry their actor.
- **Rewording the seat's own-lane line** in `seatTick.ts` (open PR #2783 edits
  that file; the `ask` item already names the class).
- **Telling on the card what the seat will do next** («повторює коміт»): a
  guess the card cannot verify.
- **A per-cause classifier richer than §5.2**, and per-cause operator
  settings.
- **Routing a provider wait with a far reset to the seat** instead of the
  engine's retry.
- **Folding helper conversations and not-loaded conversations into the
  chronology.**
- **Changing the phone long-press sheet or the phone pipelines list.**
- **The prototype's in-flow popover row**: the product's dot popover is the
  portalled one the operator chose for #2783.
- **Notifying the operator elsewhere** for «you» stops: decision forms
  already reach the paired chat.
