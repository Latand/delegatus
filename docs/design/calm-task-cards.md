# Calm task cards: the orchestrator resolves stuck lanes, the card tells why on demand

Status: design and prototype. Written against `main` at `9490b3b2c`
(2026-10-12); production runs `0ef6ec49` (deployed 2026-10-11 18:35Z, held
there by an incident fence). Every file and line reference below is to
`9490b3b2c`; `origin/main` moved to `ca02d5966` while this was written and
none of the cited files changed. This stage wrote only this document and
`docs/design/calm-task-cards/`. No product file changed.

## Originating requirement

Operator, 2026-10-12 about 10:30 Kyiv, in Russian, with a screenshot of real
board cards. Verbatim excerpts as the task pinned them:

> «Залишити PR відкритим. Спробувати мердж ще раз. Пропустити діагноз.
> Повторити діагноз. Потом … «Пропустити прототайп», «Повторити прототайп». Я
> не понимаю, почему оно висит … эти кнопки вообще здесь как будто бы лишние.
> Они как будто бы путают, потому что непонятно, на основании чего принимать
> решение … какая разница, конфликт как конфликт … оркестратор должен сам
> резолвить все вот эти проблемы, ему должно приходить сообщение типа, что там
> что-то не прошло, и он должен взяться и продолжить это … А мне эта кнопка
> нужна, наверное, только если … я хочу раскрыть, понять, что там, почему она
> остановилась, и тогда я уже нажимаю … Возможно, мне тоже прототипы нужны …
> нужен какой-то research того, вообще в принципе, насколько это viable, и
> насколько удобно будет … слишком много вещей сейчас требует моего внимания, я
> хочу, чтобы это было меньше. Возможно, я буду большую часть времени
> находиться в оркестраторе … В самой задаче я хочу видеть … может быть,
> хронологический порядок … карточка выглядит перегруженной, вроде бы вся
> информация полезная … По реальным карточкам, по которым там пайплайны были,
> реальные статусы, вот как у меня сейчас. На проде … отрендерить в разных
> видах.»

In short: the stop buttons on cards confuse; the orchestrator should get a
message when something did not pass and carry on by itself; the operator wants
the button only after opening the card to see why it stopped; the task should
read in order; render it on real production cards in several forms; and first
research whether this is viable.

## Decision in one paragraph

It is viable, and most of the machinery exists. Over the last 72 hours 171
lane stops drew answer buttons on cards; 14 of them (8%) were questions only
the operator could answer, and 8 of those 14 had already been asked through a
decision form. Since #2769 (merged 2026-10-12 08:44Z, not yet on production)
every lane wait in a project with a ticking seat is routed to the seat and
leaves the amber edge and «Чекають на вас», yet the card still draws «Skip /
Retry» and «Leave the PR open / Try the merge again» for it, because the
answer panel reads neither the route nor a dismissal
(`src/components/pipelines/PipelineBlock.tsx:569`,
`src/components/pipelines/pipelineBlockModel.ts:246`). The change is three
small pieces: (1) the card draws a lane's answers only when the wait is the
operator's, and otherwise one state line with a status dot; the answers move
into the opened card; (2) one pure classifier names the cause of a stop
(commit, transport, conflict, closed PR, question …) and feeds both the card's
words and the seat's wake item, which today says only «parked on a decision»
(`src/lib/monitor/seatTick.ts:743`); (3) the seat acts on its classes with
tools it already has. Three numbered prototypes on the real production cards
show the closed and opened card; the recommendation is variant 1 with the
chronology folded inside it.

## 1. The board as the operator saw it

Snapshot: `list_pipelines` at 2026-10-12 10:40Z, plus the state store read
read-only (`bun:sqlite` with `readonly: true`) for completed lanes and their
merge records. Projects other than Delegatus are named «project A/B/C».

- 37 lanes were open; 13 of them parked in `needs_decision`.
- 17 completed lanes had a stopped automatic merge nobody had cleared.
- So **30 lanes drew an answer panel: 60 buttons on 28 cards** (Delegatus 26
  lanes, project A 3, project C 1). 19 of those lanes (38 buttons) sat on open
  tasks, 11 (22 buttons) on cards in Done.
- On production every one of them also painted the card amber and filed a
  «Чекають на вас» row, because production predates #2769.

What the 13 parked lanes were waiting on:

| Cause at the snapshot | Lanes | Who can resolve it |
|---|---|---|
| A passed stage's work could not be committed (eslint missing from a worktree with no `node_modules`: 4; the 60 s commit timeout under CPU pressure: 2; a read-only stage made a commit: 1) | 6 | seat |
| The branch could not be published (pre-push budget ran out, retried 3 times) | 1 | seat |
| Provider transport recovery exhausted (its PR had already merged through a successor lane) | 1 | seat |
| Sign-in check failed on the stage's account | 1 | seat, operator only if no account of the engine is signed in |
| Review budget spent, findings remain (already dismissed by the operator on 2026-10-08, still drawing buttons) | 1 | seat |
| Stage asked a question: a fresh test capture or a contract change (project C; the seats answered it by opening a capture lane) | 1 | seat |
| Stage asked a question: record in a time window that opens at 18:00 (project A) | 1 | seat |
| Stage asked a question: the output of one read-only command on the operator's second installation | 1 | **operator** |

The 17 stopped merges: the PR was closed because another PR superseded it (8),
a conflict with the base branch (4), a design lane with no PR (3), checks did
not finish in 90 minutes (2). None needs the operator. Three of the four
conflicts already had a refresh lane running, opened by the seat, while their
cards kept offering «Try the merge again».

The seat was already acting on these: within ten minutes of the snapshot it
had retried two of the six stuck commits (`voice-head` and `reject-redo-fix`
in the prototype data started fresh attempts).

## 2. Every operator-facing action a card can show

| # | Control (uk / en) | Where | State behind it | Code |
|---|---|---|---|---|
| 1 | «Пропустити {stage}» / «Повторити {stage}» (Skip / Retry); Retry alone when skip is refused | desktop card lane row; phone task screen (44 px, «Пропустити етап» / «Повторити етап»); phone pipeline screen | `needs_decision` with a retryable cursor stage | `pipelineAnswers` `pipelineBlockModel.ts:246`, `AnswerButtons` `PipelineBlock.tsx:422` |
| 2 | «Прийняти без ревʼю» / «Ще одне ревʼю» | same | `needs_decision` that is a review stop (`reviewStop`: park, once, legacy) | `reviewStop` `pipelineBlockModel.ts:196`, `answerLabel` `:278` |
| 3 | «Прийняти як є» (Accept as is) | same | `needs_review` (stop after the last fix) | `pipelineBlockModel.ts:267` |
| 4 | «Залишити PR відкритим» / «Спробувати мердж ще раз» (Leave the PR open / Try the merge again) | same | completed lane, `merge.state = "blocked"`, not cleared since it stopped | `mergeNeedsYou` `pipelineBlockModel.ts:377` |
| 5 | Card foot ✓ «Зняти» and «Скасувати» (Dismiss / Undo) | desktop card foot; phone card aside | any need reason on the card | `KanbanCard.tsx:441` |
| 6 | Prototype review button: «Питання до вас» / «Прототип готовий» | card foot, phone card | a decision form round waits | `CardPrototypeButton` |
| 7 | Failed launch: «Відкрити» / «Прибрати» | card body | an operator launch failed before its transcript | `KanbanCard.tsx` `UnstartedLaunches` |
| 8 | Edit conflicts: Retry / Discard, Use theirs / Keep mine | card body while editing | a local edit the server refused or an agent overwrote | out of scope: no lane is stuck |
| 9 | «Сховати знову» (Hide again) | resurfaced card | a hidden group came back | out of scope |
| 10 | ⋯ menu lane group: pause, resume, retry, skip, close | card ⋯ | always | `KanbanBoard.tsx:1655` |
| 11 | «Спитати», «+ Агент» | card foot | always | `KanbanCard.tsx` foot |

Rows 1–4 are what the operator quoted. They come from one place: the
`AnswerPanel` that `PipelineBlock` draws at task density whenever
`pipelineAnswers` returns something (`PipelineBlock.tsx:569`, `:721`), and
`KanbanCard` hands every lane an `onAnswer` (`KanbanCard.tsx:507`). Neither
reads `laneRouteNow` (`src/lib/attention/routeTypes.ts:106`) nor
`pipelineHiddenFromBoard` (`src/components/mobile/mobileBoardModel.ts:360`).
So on `main` a seat-routed lane loses its amber edge (`needReason.ts:110`)
and its panel row (`mobileBoardModel.ts:349`) and keeps its warning-ink reason
line and both buttons; a lane the operator dismissed keeps them too (visible on
the unsafe-root card in every original frame: «Знято · ви» above
«Пропустити Diagnose / Повторити Diagnose»).

## 3. How often each stop happened, and who can resolve it

Window: 2026-10-09 10:30Z to 2026-10-12 10:30Z, both bounds applied to every
query. The lifecycle journal keeps only its last 2 000 events (about 25 hours,
from 2026-10-11 09:40Z), so the 72-hour counts come from the lane records: a
parked attempt keeps its state `needs_decision` and its error after a retry
opens the next attempt, and a merge record keeps `blockedAt` after it merges.
237 lanes were created in the window (Delegatus 199, project C 18, project B
12, project A 7, one other).

| Stop class | 72 h | Example cause (as recorded) | Owner | What resolves it |
|---|---|---|---|---|
| Stage verdict `needs_decision` | 43 | see §3.1 | seat 29, operator 14 | seat answers with `pipeline_action resolve-decision` or escalates through a form |
| Transport or host failure | 31 | «database is locked» (10), «cannot inspect controller artifact Git paths» (8), spawn recovery exhausted (7), host lost, staged launch released, background task over 60 min | seat | `retry-stage`; `close` when the work landed elsewhere |
| Operator pause or control | 27 | «provider recovery cancelled by operator control» (a mass pause on 2026-10-10 about 22:30Z) | waiting | resumes with the resume; nobody is asked |
| Commit of a passed stage | 12 | eslint missing in a worktree without `node_modules`; 60 s timeout under CPU pressure; read-only stage made a commit; detached head | seat | install deps through `scripts/gate-slot.sh`, then `retry-stage`; #2765 (merged on `main`, absent from production) retries controller timeouts by itself; open PR #2780 commits without `node_modules` |
| No account capacity | 7 | «no allowed codex account has capacity … resetsAt 2026-10-14» | seat | `override-stage` to another engine, or wait for the reset |
| Sign-in check failed | 2 | «Claude subscription authentication check failed» | seat, then operator | move the stage to a signed-in account; ask the operator to sign in only when none is |
| Merge stopped | 48 | conflict, PR closed, no PR, checks over 90 min | seat | 31 already merged after a retry; conflict → refresh lane (open PR #2777 automates it); closed or no PR → `dismiss_attention` with a reason; checks → `retry-merge` |
| Review budget spent | 1 at the snapshot | «fail-edge budget exhausted after 3 rounds» | seat | the project rule: N rounds, fix the last, merge (`accept-head`) |
| **All** | **171** | | **operator 14 (8%)** | |

The seat already does most of this by hand. In the same window agents sent
`pipeline_action` 391 times; by request key at least 82 were stage retries, 16
merge retries, 6 skips and 38 closes (the receipts store keeps each call's key and
answer and drops its action field, so this is a lower bound read from keys
such as `…-retry-…`).

### 3.1 The 43 stage questions

Read from each parked attempt's report:

- **Operator only (6).** A paid generation needing approval (project A); a
  client's administrator binding and separate approval (project A); a client
  data conflict with no recorded author, asked twice (project A); a retention
  policy, keep archives forever or expire them (Delegatus); the output of a
  command on the operator's second installation (Delegatus).
- **Already asked in a decision form (8).** The stage published a prototype
  round or a design questionnaire and parked; the operator answers the round
  and the parked lane is a second copy of the same ask.
- **The seat can answer (29).** Merge identity refusals, a role reassignment,
  a deploy window that opens at 18:00, scope questions with a recommendation,
  a duplicate lane, a test capture, «the round was already decided», a
  question explicitly addressed «to the controller, not to the operator»,
  and one asking for a video only the operator has where the brief already
  allows building without it.

## 4. What truly needs the operator, and how the card says it

Four kinds, and nothing else:

1. **A product choice** (a design variant, a policy such as retention).
2. **Evidence only the operator holds** (a command on another installation,
   a screenshot from their phone).
3. **Spending or a business approval** (paid generation, a client's
   approval, client data with no recorded author).
4. **Signing in**, when no account of the engine is signed in.

Each goes through the existing decision form: the seat publishes a
`publish_prototype_review` round and escalates the wait with
`dismiss_attention escalate {reviewId}` (#2769). The card then shows:

- an amber dot and one bold line, «Потрібна ваша відповідь: {the form's
  title}», for example «вивід команди з другої установки»;
- **one** button, «Відповісти», which opens that form;
- in the opened card: why it stopped, «Сам відповісти не може: ці дані є лише
  у вас», the form button first, then the lane's own Skip / Retry and «Запитати
  оркестратора».

Everything else shows no button on the closed card.

## 5. The model: who owns a stop

One pure, browser-safe classifier beside `pipelineBlockModel.ts` reads what
the record already holds (`stateDetail`, the cursor attempt's `error`, the
verdict, `merge.reason`, sibling lanes, the PR state) and answers a cause and
an owner. The prototype's version is
`docs/design/calm-task-cards/calmModel.ts` (`laneCause`, `causeOwner`).

| Owner | Dot | When | Closed card |
|---|---|---|---|
| working | green | a stage runs; a merge is being refreshed by a running lane | «{stage} працює» |
| waiting | grey ring | a queue, a timer, an operator pause, checks running | «Мердж PR #… чекає перевірок» |
| seat | indigo | every stop in §3 the seat resolves | what the seat does, in one line: «Оркестратор повторює коміт «Prototype»» |
| you | amber | §4 only, after the seat escalated | «Потрібна ваша відповідь: …» and «Відповісти» |
| done | faded green | finished | «Готово» |

The dot carries the owner and its popover says it in words, naming what the
bare duration beside the state line counts («Оркестратор розбирається вже
29 хв»); the time is said once, with no second clock. The popover opens as a
row of the card under the state line, its tail on the dot, so it covers no
text and no chip and the card's clip cannot cut it; the card grows by one line
while it is open. The dot stands on the first line of a state line that wraps.
The colour is never the only signal: the line says the same in words.

The owner comes from the route the server already stamps
(`stampAttentionRoutes`, `src/lib/attention/routing.ts`): a seat or system
route is never «you»; an operator route (no seat, a lane the operator made by
hand that stopped after its last fix, or a form escalation) is «you». The
cause only picks the words.

## 6. What to build

The minimum the requirement demands, in order:

1. **Card render rule.** `PipelineBlock` (task and screen densities) draws the
   answer panel on the closed card only when the lane's need is the
   operator's and uncleared: `laneNeed(pipeline)` returns a need with
   `cleared === null` (`src/components/attention/needReason.ts:108`). That
   existing reader already drops a routed wait (`:110`), covers a stopped
   merge (`laneMergeNeed`, `:131`) and reports a dismissal as cleared;
   `pipelineAsks` (`mobileBoardModel.ts:349`) covers decisions and reviews
   and leaves merges out, so it is the wrong predicate here. Otherwise
   the lane's warning reason line gives way to the state line with its dot,
   and the answers live in the opened card. The phone task screen follows the
   same rule.
2. **Cause words.** The classifier of §5, with uk and en strings for each
   cause's line, why and seat text (the prototype's copy is in
   `calmModel.ts`).
3. **Seat wake items name the cause.** `ownLaneLabel`
   (`src/lib/monitor/seatTick.ts:726`) and the routed-wait item say «parked:
   commit of Prototype failed (eslint missing, no node_modules)» where today
   they say «parked on a decision», with the one next step from §3's table. The
   mandate is near its envelope (`prompt.test.ts` budgets), so the steps live
   in the wake item and the `pipeline_action` description, with no new mandate
   paragraph.
4. **Deploy what is already merged.** #2769 (routing) and #2765 (commit
   timeouts) are on `main` and not on production; the board the operator
   quoted is production.

Engine work already in flight reduces the stops themselves: PR #2780
(commit without `node_modules`), PR #2777 (refresh a reviewed PR after a
conflict), #2773 (CPU admission never starves).

### 6.1 How the prototype reads production

`docs/design/calm-task-cards/extract.ts` opens the state store read-only,
takes the chosen lanes and every lane on their tasks, rewinds anything that
moved after the snapshot instant (attempts started later are dropped and the
lane is parked again as the board read it), and writes `cards.json` with no
paths, accounts, commits, conversation ids or branch names (lane ids become
words such as `voice-head`; long agent texts are cut to 360 characters). The
Ukrainian task texts are as stored; the en frames carry a faithful
translation (`EN_TEXT` in `fixture.tsx`). The seat's handling lines are the
proposal of §3 for each class, and the one escalation (unsafe-root) is marked
in the fixture, because the seat's judgment is what decides it.

## 7. The prototypes

Seven real cards from the snapshot, Delegatus project: a stuck commit under
CPU pressure (voice head), two stuck commits on one task (reject and redo), a
stopped merge whose refresh lane runs (node_modules), a transport failure
whose PR already merged elsewhere (mid-turn messages), a healthy running lane
(activity truth), the one question for the operator (unsafe-root), and a
closed superseded PR in Done (auto-merge checks).

The original is drawn by the real components: `KanbanCard` on the desktop,
`MobileKanban` per column and `MobileTaskScreen` on the phone, through the
kanban evidence harness (`serveEvidenceFixture`, `openFixture`). The variants
reuse the board's card shell (`.kb .card`), the real task icon, the real
one-line chain (`PipelineBlock` at card density with no reason line) and the
real PR text (`WorkLinkText`); the state line, dot, popover and opened view
are new. On a card the orchestrator owns, the stopped stage's chip keeps the
seat's indigo and carries no amber mark (no bang on the glyph, no amber round
counter): amber stays on the one card that needs the operator.

The frame's board keeps the product's column floor (280 px,
`--kb-column-width`), so the 1000 px frame gives the wide column what is left.
In a card under 300 px the age drops under the state line and the title may
take four lines; nowhere is a title cut.

### Variant 1 · Причина в розгорнутій картці (Reason in the opened card)

Closed: icon, title, the dot and one state line with the age, the chain with
the PR. Opened (the chevron or the state line): the task's description, «Чому
зупинилось» in plain words with «Подробиці» showing the raw record, «Що робить
оркестратор», and «Якщо хочете самі» with the lane's real answers in quiet
buttons and «Запитати оркестратора». «Подробиці» holds whole lines and whole
sentences of the record with no file path, and a link to the full record in
the stage's conversation. On the phone «Відповісти» takes its own full row,
the lane's two answers stand side by side under it, and the question for the
orchestrator comes last. Closest to the quote: open, understand, then press.

### Variant 2 · Хронологія задачі (Task chronology)

Same closed card. Opened: the task in order, oldest first, from the records
(task created, each lane started, each attempt passed / failed / cut by a
restart, merges queued, stopped, merged), the last eight entries with
«Раніше · N» above them, ending on what happens now («зараз · Оркестратор:
…», the actor named once). The answers ride the stop's own entry as small
links, on one row. On the phone the time leads each entry's own line (there is
no time column), which is what leaves the links their row. Restarts that cut
one stage several times fold into one line.

### Variant 3 · Лише рішення (Decisions only)

Closed: icon, title, dot and line; no chain at all. Opened: a short summary
(Зупинилось / Оркестратор / Далі / Самі), the chain, «Хронологія · N» folded.
The last row, «Самі», holds the lane's answers as quiet links, visible at
every width with no gesture and no instruction line; only «Відповісти» is a
button. The quietest board.

### Measured (driver `render.ts`, all 96 renders, `geometry.json`)

- Closed cards: the original 1440 board draws **14 answer buttons and 5 ✓ on
  7 cards** with 5 amber cards; every variant draws **1 button** («Відповісти»
  on unsafe-root).
- The five In-progress cards stand 1 969 px tall in the original at 1440
  (405, 439, 286, 550, 289); 520 px in variants 1 and 2 (104 each), 380 px in
  variant 3 (76 each). The frame shows one popover open, which adds its own
  39 px row to that card (143 and 115). At 1000 the same five stand 699 px in
  variants 1 and 2 and 559 px in variant 3, at 390 they stand 639 and 499.
- The phone's closed cards carry no buttons today; its task screens carry 8
  answer buttons for these 4 tasks. Every variant's opened card shows the
  lane's answers at every width (the driver compares the count with the
  lane's own), at 44 px or more on the phone.
- The driver checks every variant frame and fails the run on a miss
  (`problems` in `geometry.json`; all 72 variant frames pass): no sideways
  overflow (the page does not pan, no fractional right edge passes the
  width); no cut title or state line (a Range against its box); the popover
  inside its card, covering 0 px² of the title, the state line, the age, the
  chips and the buttons, and holding no clock time; the dot within 2 px of the
  state line's first line (0.1 measured); the state line on at most three
  lines (two measured); no amber mark on a chip of a card that asks nothing;
  one button on a closed card that needs the operator and none elsewhere; no
  instruction line or menu standing in for the answers; an entry's links on
  one row; on the phone «Відповісти» across its full row and no control under
  44 px; «Подробиці» ending on a whole sentence, naming no file and offering
  the full record; the «зараз» entry naming the orchestrator once.

Frames: `/var/tmp/calm-task-cards/variant-N-<1440|1000|390>-<uk|en>-<light|dark>-<board|open>-<original|changed>.png`,
144 files, listed in `docs/design/calm-task-cards/frames.txt`. To render again:
`CHROME_BIN=<chrome> bun docs/design/calm-task-cards/render.ts [w=390] [variant=1] …`
from the repository root (in a pipeline stage, give Chrome a short `TMPDIR`
through a wrapper).

## 8. «Needs you» load before and after

| | Today (production) | After the change |
|---|---|---|
| Lanes drawing answers, all projects | 30 lanes, 60 buttons, 28 cards | 1 lane, 1 button («Відповісти») |
| …of which on open tasks | 19 lanes, 38 buttons | 1 |
| Amber cards and «Чекають на вас» rows from lanes | 30 | 1 (plus any waiting decision form, unchanged) |
| Stops over 72 h that asked the operator | 171 | 14, 8 of them already in forms |
| What the seat hears when a lane parks | «parked on a decision» | the cause and the next step |

## 9. Questions for the operator

1. **Which variant?** 1, 2 or 3. *Recommendation:* variant 1, with variant 2's
   chronology added as a folded «Хронологія» section at the end of the opened
   card (as variant 3 already folds it).
2. **How loud are Skip / Retry for a stop the orchestrator owns?** Every
   variant shows them in the opened card: quiet buttons under «Якщо хочете
   самі» (variant 1), links on the stop's entry (variant 2), links in the
   summary's «Самі» row (variant 3). *Recommendation:* the buttons of
   variant 1, which is «раскрыть, понять … и тогда я уже нажимаю».
3. **Does the closed card still say that the orchestrator is fixing
   something,** or does it read «Працює» until the seat gives up?
   *Recommendation:* keep the one indigo line; hiding it would make a stuck
   lane look like progress.

## 10. Validation against the requirement

- «эти кнопки … лишние … путают»: no answer button on a closed card unless the
  operator must answer (§4, §8).
- «оркестратор должен сам резолвить … ему должно приходить сообщение»: the
  wake item names the cause and the step (§6.3), and §3 shows the tools exist
  and are already used.
- «раскрыть, понять, почему она остановилась, и тогда я уже нажимаю»: the
  opened card (§7, every variant).
- «хронологический порядок»: variant 2 and the recommended fold.
- «карточка выглядит перегруженной»: 1 969 px to 520 px for the same five
  cards.
- «research … насколько это viable»: §1–§3, 92% of 171 stops need no operator.
- «по реальным карточкам … на проде … в разных видах»: real production
  records, three variants, 1440, 1000 and 390, uk and en, light and dark.

## Deferred — not currently justified

- **A separate auto-resolver in the engine** that retries every class by
  itself. The seat and the engine's existing retries (#2765, provider waits)
  cover it; a second actor would race the seat on the same lanes.
- **Recording the seat's own actions on the lane** (who pressed Retry, and
  when) to show them in the chronology. Useful, and the receipts already hold
  most of it; the chronology reads the attempts the record keeps today.
- **Per-class policy settings** for the operator. Nothing in the requirement
  asks for knobs.
- **Changing the ⋯ menu or the phone's long-press sheet.**
- **Notifying the operator elsewhere** (Telegram) for «you» stops: decision
  forms already reach the paired chat (#2751).
- **The edit-conflict, failed-launch and resurfaced notices** (rows 7–9 of
  §2): they are not lane stops and were not quoted.
