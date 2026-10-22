# Landing refresh: full autonomy, task limit spend and agent memory

## Originating requirement

Paraphrase, dated. The operator, 2026-10-21 about 12:40Z, in a private Telegram
message relayed to the project's orchestrator. The verbatim words stay with the
agents (board task details) and are not copied here. Update the delegatus.org
landing for what has shipped since its last refresh (2026-10-14, #2846), with
more pictures of the product. Three subjects are named:

1. the seat tick, where full autonomy lives;
2. statistics: how much of the subscription a task used, as the task cards
   show it, and the limit history per account;
3. the agents' memory, with examples taken from the real role memory and
   cleaned up for a public page.

The pinned acceptance asks for the real product UI over invented data, in en and
uk, at 1440×900 and 390×844. It requires a clean `capture.ts` report, passing
hero checks, a first screen no heavier than main, and frames kept out of the
tree. It shows only shipped behaviour and captions anything unshipped as in
progress. It also sets two fences: Turbo in the seat tick settings (lane
1ab7de9b) and voice tools (lane 3f67e4dc).

This document is the builder's brief. It changes nothing by itself and
publishes nothing. Publication to the Worker is a separate seat step after merge.

## The answer in short

- **Three new sections**, each a live frame of the real `Viewer` over the
  invented harbor-api world, in the order below. The page becomes: hero → run →
  **autonomy** → **memory** → open → **usage** → reach → FAQ. The hero, run,
  open, reach, FAQ and footer copy stay as they are.
- **No new product code and no new driver.** The work is in `landing/site/`:
  `index.html`, `copy.js`, `styles.css`, `main.js` (one phone-only rule),
  `demo/demo.tsx` (answers and views), `demo/world.ts` (data) and
  `capture.ts` (it must walk the new frames and count requests left unanswered
  in every frame).
- **The memory section's eight rules** are cleaned, generic rewrites of real rules
  read through Delegatus on 2026-10-21 (§5). The raw text of a rule is never
  copied.
- **Not shipped, and so not shown:** limit history on the phone, a history
  chart for an account that is not in use, the autonomy badge on the phone
  board, Turbo, and voice tools (§8). No caption has to say "in progress",
  because nothing unshipped is drawn.
- **Release order matters.** Task-card limit spend (#3151) and the per-account
  Codex history (#3155) are on main but in no npm release yet; npm's latest is
  v1.15.0 (2026-10-20). The seat publishes the landing only after a release
  that contains both (§9).

## 0. Earlier answers

- `docs/design/landing-refresh.md` (#2846, 2026-10-14) describes the landing's
  machinery: the frames, how views are reached by pressing the product's own
  controls, how the world is built, and the capture driver. This brief extends
  it and keeps its decisions: frames over captures, a drawn hero, the phone
  layout at 390, and panels that fill their frame.
- `docs/design/full-autonomy-mode.md`: the setting, the episode, the decision
  log (decision, why, undo), the forbidden list and the end report. Its §6
  defers the phone board badge and a countdown in the thumb.
- `docs/design/task-limit-spend.md` and #3151: variant 2 was built, which puts
  a four-cell scale per provider on the card's state line and the numbers in a
  popover. Estimates are ±30 %, shown as `≈`, `<1%` or `≥`, with Claude first.
- `docs/design/role-memory-curation.md`, `orchestrator-role-memory.md`, #3034
  and #3101: three levels, a curator on its own timer, and every curator pass
  reversible. The learned-rules window has a Profile page and an All rules page.
- `search_transcripts` (project-scoped: "landing memory rules section autonomy
  delegatus.org") found this lane's brief, the 2026-10-14 refresh lanes and the
  orchestrator's relay. The relay also mentions "a /stats page". The product
  has no `/stats` route (`src/app` holds `activity`, `api`, `team` and the root
  page). The pinned specification names task cards and per-account limit
  history, and this brief follows it. The Activity page's Tokens tab (#3048) is
  listed under Deferred.
- `search_memory` returned the live role rules used in §5. It found no earlier
  landing work on memory or autonomy.

## 1. What the page looks like now, and what is stale

Read from the code at `db528f4d` and from a landing build of it made in this
stage's scratch directory (§10 has the procedure, and says what was read from
code and what was measured).

- `index.html` has the sections hero, run, open, reach and FAQ. Its frames are
  `.live-run` (1180×780), `.live-open` (900×760) and `.live-phone` (390×740).
- `demo/demo.tsx` answers every route the frames used on 2026-10-14. Since
  then the product asks for routes it does not answer:
  - `TaskSpendMarks` asks for `GET /api/task-spend` from every board card
    (`KanbanCard.tsx:663`, `taskSpendSummaries.ts`).
  - `StageLessonLine` asks for `GET /api/role-memory/lessons` under each stage
    report in the pipeline sheet (`PipelineSection.tsx:125`).
  - The ⋯ menu's learned-rules row asks for `GET /api/role-memory` when the
    menu opens.

  The built bundle contains all three paths and
  `/api/role-memory/profile`. `demo.tsx` has no handler for any of them, so
  its fallback answers 404 and adds each one to `window.demoUnanswered`. The
  run frame's board and pipeline views already reach the first two today.
- `capture.ts:1321` reads `demoUnanswered` from `.live-run` alone, so
  `report.json` cannot show what another frame left unanswered. The new frames
  would have the same blind spot.

## 2. Sections and their order

| # | Section | Status | Layout (reuses) | Frame (desktop / phone) | Tabs (`data-view`) |
|---|---|---|---|---|---|
| 1 | hero | unchanged | — | drawn | — |
| 2 | run | unchanged copy | `.sec-run` | `.live-run` 1180×780 / 390×700 | Build, Review, Verify · A decision |
| 3 | **autonomy** `sec-auto` | new | side copy, like `.sec-open` (`.open-side` + frame) | `.live-auto` 908×760 (exact) / 390×740 | `autonomy` · `decisions` |
| 4 | **memory** `sec-mem` | new | full width, like `.sec-run` (`.sec-head` + `.stage-wrap` + `.seg`) | `.live-mem` 1180×760 / 390×740 | `rules` · `curator` |
| 5 | open | unchanged | `.sec-open` | `.live-open` | conversation · search · accounts · overview |
| 6 | **usage** `sec-use` | new | full width, like `.sec-run` | `.live-use` 1180×760 / 390×740 | `spend` · `task` · `history` (desktop only, §6.3) |
| 7 | reach | unchanged | `.sec-reach` | `.live-phone` | board · decision · reports |
| 8 | FAQ | unchanged | | | |

Why this order: run says it does the work, autonomy says it keeps going without
you, and memory says it gets better at it. Open says you can see everything,
usage says what it cost, and reach says it finds you. Full-width and side
layouts alternate, so no two full-width frames sit next to each other.

The copy of each new section goes in a list of captions that is visible at
every width, as in `.sec-run`. In the `.vtabs` pattern the tab descriptions
are hidden at 640 px and below (`styles.css:839`), and the autonomy section
needs its captions on the phone. So `sec-auto` takes the side layout's frame
position with a `.caps` list and a `.seg` tab list, and no `.vtabs`.

The styles for the new sections are added to the existing selectors
(`.sec-run, .sec-mem, .sec-use`, `.live-open, .live-auto` and so on). Every
frame keeps the full-screen control `main.js` already adds to each `[data-live]`.

## 3. Section 3, autonomy

### 3.1 Product components behind it

| What shows | File |
|---|---|
| The tick switch in the seat head, with the violet travelling ring while autonomy is on | `src/components/orchestrator/SeatTickChip.tsx`, `SeatTickSwitch.tsx` (`role="slider"`, `aria-label` = `seatTick.switch.aria`) |
| The panel: wakes, Full autonomy (toggle, duration, the status «until … · … left»), Role memory curator, Details | `src/components/orchestrator/SeatTickBody.tsx` (`SeatTickAutonomy` :811, `AutonomyStatus` :791, `SeatTickCuration` :910, `SeatTickDetails` :1189) |
| The decision log: decision, form state, why, «How to undo» | `SeatTickBody.tsx:1234-1237` (`[data-seat-tick-autonomy-log]`, inside `details[data-seat-tick-details]`) |
| Data shape | `src/lib/monitor/seatTickSettingsAnswer.ts` (`SeatTickSettingsAnswer.autonomy`, `.curation`), `src/lib/monitor/autonomy.ts` (`AutonomySetting`, `AutonomyDecision`), `src/lib/memory/curation/answer.ts` |
| Phone | `src/components/mobile/MobileOrchestratorSheet.tsx` (`MobileSeatTickRow`) opens `MobileSeatTickSheet.tsx`, which holds the same `SeatTickBody` |

On the desktop the panel is a 320 px popover portalled to fixed coordinates,
`max-h-[70vh]`, scrolling (`SeatTickChip.tsx:149`). In a 760 px frame that is
532 px, so the decision log has to be scrolled into view inside the popover.

### 3.2 Views (`demo.tsx`, `navigateView`)

- `autonomy` (desktop): go to the board with the seat docked at the side, the
  same as the `board` view. Then press the tick slider in the seat head. The
  panel opens at its top: the switch, wakes, and the Full autonomy section with
  its status line. Phone: open the seat sheet from the seat row, then tap its
  tick row.
- `decisions`: the same steps, then open `details[data-seat-tick-details]` and
  scroll the popover (the phone sheet) until `[data-seat-tick-autonomy-log]`
  sits at the top, using `scrollIntoView({ block: "start" })` on the
  popover's own scroller with `preventScroll` focus, as `demo.tsx` does
  elsewhere.
- The frame turns autonomy on through a world flag, `autonomy=1` in the
  frame's `data-query` and `data-phone-query`, so the other frames keep the
  world as it is (§3.3). Readiness waits for `[data-seat-tick-autonomy-summary]`
  and, for `decisions`, for the log.

### 3.3 What the invented world needs (`world.ts` + the settings answer)

All of it applies only when `autonomy=1`:

- **The episode**: `enabled: true`, `startedAt` = boot − 3 h 48 min, `until`
  = boot + 4 h 12 min (an 8-hour episode), `setBy` the operator (`gateway`),
  `endedAt: null`, `why: null`. The status line then reads «Full autonomy ·
  until HH:MM · 4 h 12 min left» and the duration select shows «Until HH:MM».
  `answer.autonomy` = `{ active: true, until, startedAt, episode }`. Wakes are
  on (`effective.enabled: true`) at a 30-minute interval, which is a
  non-default value.
- **Three decisions** (`AutonomyDecision`, `by` = the seat, written in both
  languages):

| id | decision | why | undo | task, form |
|---|---|---|---|---|
| d1 | Webhook retries stop after 72 hours. / Повтори вебхуків зупиняються через 72 години. | Most merchants fix a broken endpoint within a weekend; 24 hours would drop their deliveries. / Більшість мерчантів лагодять зламаний ендпоінт за вихідні; за 24 години їхні доставки пропали б. | Answer the decision on «Back off webhook retries» again with 24 hours; the stage runs again. / Дай іншу відповідь на рішення в «Затримка повторів вебхуків» — 24 години; етап запуститься знову. | `t-retries`, `reviewState: "decided"` (prints «Form saved») |
| d2 | Receipts go out as plain text with a one-line summary. / Квитанції йдуть простим текстом з підсумком в один рядок. | The other order emails are plain text, so no template engine is added. / Інші листи про замовлення — простий текст, тож рушій шаблонів не потрібен. | Ask the orchestrator for the HTML variant on «Email a receipt for each refund». / Попроси оркестратора про HTML-варіант у задачі «Квитанція на кожне повернення». | `t-receipts` |
| d3 | Refund calls keep the same 10 s provider timeout. / Виклики повернень мають той самий тайм-аут провайдера 10 с. | They go through the same provider client; one limit is easier to reason about. / Вони йдуть через того самого клієнта провайдера; одну межу простіше тримати в голові. | Set a separate refunds timeout in the provider client and tell the orchestrator. / Задай окремий тайм-аут повернень у клієнті провайдера і скажи оркестраторові. | none |

- **The board stays consistent with autonomy on.** In the `autonomy=1` world
  at step 5, `p-retries` is running again (Build attempt 2) instead of
  `needs_decision`, `t-retries` owes no answer, `needsYou` is 0, and the
  report log gains one `status` entry: «Under full autonomy: webhook retries
  stop after 72 hours; the stage runs again.» Without this the frame would show
  autonomy on beside a decision still waiting for the operator, which
  contradicts the setting. The reach frame keeps its waiting decision because
  it does not carry the flag.
- **Curator block** (`answer.curation`): `enabled: true`, `intervalHours: 6`,
  bounds 1/168 and default 6. `lastRun` is a `succeeded` pass that ended 2 h
  ago, with counts `{ calls: 1, changed: 4, rewritten: 2, merged: 1, moved: 0,
  split: 0, archived: 1, restored: 0 }` and `conversationId: null`, so no link
  points at a conversation the world lacks. `nextRunAt` is in 4 h, and `live`
  and `runsError` are null. The same pass appears in the memory frame's curator
  history (§4.3), so the two frames agree.
- **Fields to leave out**: `release`, `autoRotate` and every Turbo field. Their
  sections do not render without them (the `?.` reads in `SeatTickBody.tsx`),
  which keeps the panel short enough for the frame. This departs from a real
  install's panel; record it in the README's departures list. Check that
  `maintenance`, which the type marks as required, renders as empty or off
  with the answer the demo gives; if it does not, answer the smallest
  `BoardMaintenanceAnswer` with `enabled: false`.
- **Saving**: a press of Save (`PUT /api/monitor/seat-tick/settings`) is
  answered like the pipeline mutations, with 409 «This is a demo: nothing runs
  here.» The builder confirms the panel shows that message in place and keeps
  the draft.

### 3.4 Copy (en / uk)

The landing keeps its own voice: short, informal «ти» in Ukrainian, with the
product's own terms (Повна автономія, Як повернути).

| key | en | uk |
|---|---|---|
| `auto.title` | It can keep going without you. | Він може працювати без тебе. |
| `auto.c1` | Turn on full autonomy for 8, 12 or 24 hours, or with no end. The orchestrator answers its own questions and keeps the work moving. | Увімкни повну автономію на 8, 12 чи 24 години або без кінця. Оркестратор сам відповідає на свої питання і рухає роботу. |
| `auto.c2` | Every decision it makes is logged with why, and how to undo it. | Кожне його рішення записане: чому і як його повернути. |
| `auto.c3` | Accounts, spending, other projects and public posts stay off limits. You get one report when it ends. | Акаунти, витрати, інші проєкти й публічні дописи лишаються забороненими. Наприкінці — один звіт. |
| `auto.views` | Full autonomy | Повна автономія |
| `auto.tab1` | Settings | Налаштування |
| `auto.tab2` | Its decisions | Його рішення |
| `auto.alt` | The orchestrator's tick settings in Delegatus, with invented data: full autonomy on with hours left, and the decisions it made, each with why and how to undo it. | Налаштування тікера оркестратора в Delegatus із вигаданими даними: повна автономія увімкнена, видно, скільки лишилось, і рішення, кожне з причиною і способом повернути. |

Each claim and the code behind it:

- 8/12/24 h and no end: `SeatTickAutonomy`'s options and the «No end» string.
- Answers its own questions and keeps work moving: the overlay's rules in
  `autonomyMandate`.
- Logged with why and undo: `AutonomyDecision`.
- The forbidden list (accounts, spend, other projects, outward messages):
  `autonomyMandate` and design §5.
- One report at the end: design §7.

## 4. Section 4, memory

### 4.1 Product components behind it

| What shows | File |
|---|---|
| The way in: «Learned rules · N rules» on the board's ⋯ menu; a row in the phone's project rules sheet | `src/components/roleMemory/LearnedRules.tsx` (`LearnedRulesRow`), mounted at `src/components/ProjectDashboard.tsx:2062` and `:2134-2136` |
| The window: Profile and All rules pages, the curator history at the top, three columns Role / Project / Machine, a role picker with counts, rule rows (why, provenance, earlier texts), «Left the rules» with «Return», × with Undo | `LearnedRules.tsx` (`RulesWindow` :341, `RuleSection` :295, `RuleRow` :200, `LeftRow`, `UndoRow`), host `LearnedRulesWindowHost` in `src/components/Viewer.tsx:1991` |
| Profile page | `src/components/roleMemory/MemoryProfile.tsx`, `useMemoryProfile.ts` |
| The line under a stage report («Left 1 rule → Reviewer») | `StageLessonLine` in `LearnedRules.tsx`, mounted in `src/components/kanban/PipelineSection.tsx` |
| Data shape | `src/lib/memory/roleTypes.ts` (`RoleMemoryProjectView`, `ScopeView`, `RuleView`, `CuratorPassView`, `StageLessonView`), scope ids in `src/lib/memory/roleScopes.ts` (`role:<project>:<role>`, `role:*:<role>`, `project:<project>`, `machine`), `src/lib/memory/profileTypes.ts` |

### 4.2 Views

- `rules`: open the board's ⋯ menu, press the «Learned rules» row
  (`roleMemory.row`), then «All rules» (`memoryProfile.allRules`), then the
  Orchestrator chip in the role picker (`[data-rules-role="orchestrator"]`).
  Expand O1 so the frame shows its «Why:» line and its provenance. The
  builder's merged rule (B1) is one chip away. Desktop draws three columns. The phone draws the window
  full screen as one column, scrolled to the top.
- `curator`: the same window. Open `details[data-curation-history]` (passes,
  counts, «Undo pass») and the Project column's «Left the rules» toggle, which
  shows the archived one-task rule with its reason «about one task» and
  «Return».
- The window opens over the board (`fixed inset-0` overlay, `md:max-w-[1120px]`,
  `max-h-[min(689px,90dvh)]` on the rules page), so a 1180×760 frame shows it
  whole with the board dimmed behind it.

### 4.3 What the invented world needs

- `GET /api/role-memory?project=harbor-api` gives a `RoleMemoryProjectView`
  with `enabled: true` and these scopes. The eight rules and their texts are
  in §5.
  - `role:harbor-api:orchestrator` → O2.
  - `role:*:orchestrator` → O1.
  - `role:*:builder` → B1, with `mergedFrom` of two ids, `revisedBy: { by:
    "curator" }` and `tasks: 4`, so the row reads «rewritten by curator ·
    merged from 2 rules · from 4 tasks».
  - `role:*:reviewer` → R1, with `fixRound: true` (the row's provenance adds «fix round»).
  - `role:*:architect` → A1, with `awaitingCuration: true` («awaiting
    curator»), which shows that a new lesson arrives before the curator
    reviews it.
  - `project:harbor-api` → P1, plus one `left` rule: `state: "archived"`,
    `reason: "task-specific"`, text «Retry the March refunds export twice
    before reporting it. / Повтори березневий експорт повернень двічі, перш
    ніж звітувати.». This rule is invented to show an archive.
  - `machine` → M1, M2, with `chars` well under the bound, so no size counter
    shows.
- `curation`: `lastAt` 2 h ago, `nextAt` in 4 h, `newLessons: 1`, and two
  passes: the one from §3.3 (`succeeded`, counts as there) and one a day
  earlier (`succeeded`, `revertedAt` set, so it reads «Pass undone»).
- `POST /api/role-memory` (`delete`, `restore`, `revert`, `revert-pass`)
  applies the action to a copy the frame keeps and answers the new view. Use
  the product's exported `predictedRules` for delete, restore and revert, and
  set `revertedAt` for `revert-pass`. The visitor's × then really removes the
  rule, the Undo row really puts it back, and nothing is refused or left
  unanswered.
- `GET /api/role-memory/lessons?project=harbor-api` →
  `{ lessons: [{ pipelineId: "p-refunds", stageId: "review", attempt: 1,
  rules: [{ id: R1, rule: R1.rule, scope: "role", roleId: "reviewer" }],
  none: null }] }` from step 4 on, and `{ lessons: [] }` before. The run
  frame's pipeline sheet then shows «Left 1 rule → Reviewer» under the Review
  report, which opens this same window. This is the shipped link between a
  stage and memory, and it also answers a request the run frame leaves
  unanswered today (§1).
- `GET /api/role-memory/profile?project&locale` gives an invented
  `MemoryProfileView` in the frame's language. `overall` has a headline and
  two sentences («What this project's agents have learned: prove claims with
  the real path, keep changes to what was asked, clean up only what you
  created»), three topics whose `ruleIds` point at §5's rules, and one summary
  per slice. `run: { state: "done" }` and `stale: false`. `POST` answers that
  view as one NDJSON line. No landing tab shows the Profile page, but the window
  opens on it before the view presses «All rules», and a visitor can click
  back to it. It has to read as finished and leave no request unanswered.
- The ⋯ menu row counts the rules: «8 rules» / «8 правил».

### 4.4 Copy (en / uk)

| key | en | uk |
|---|---|---|
| `mem.title` | Each new agent starts with what the last ones learned. | Кожен новий агент починає з того, чого навчились попередні. |
| `mem.c1` | When an agent finishes a stage, it can leave one short rule for the next one. | Закінчивши етап, агент може лишити одне коротке правило для наступного. |
| `mem.c2` | Rules live at three levels: a role, a project, or every project on this machine. | Правила живуть на трьох рівнях: роль, проєкт або всі проєкти на цій машині. |
| `mem.c3` | A curator merges repeats, makes rules general and archives one-off ones. You can undo any of it. | Куратор зливає повтори, узагальнює правила й архівує разові. Будь-яку його зміну можна скасувати. |
| `mem.c4` | Delete a rule with one tap, or bring back an earlier version. | Видали правило одним дотиком або поверни попередню версію. |
| `mem.views` | Learned rules | Вивчені правила |
| `mem.tab1` | Rules | Правила |
| `mem.tab2` | Curator | Куратор |
| `mem.note` | Example rules adapted from real agent memory; everything else is invented. | Приклади правил узято зі справжньої пам’яті агентів і очищено; решта вигадана. |
| `mem.alt` | Learned rules in Delegatus: rules for the orchestrator, the project and the machine, with why each exists, and the curator's passes with their undo. | Вивчені правила в Delegatus: правила для оркестратора, проєкту й машини, з причиною кожного, і проходи куратора з можливістю скасувати. |

Each claim and the code behind it:

- One rule per stage: `MAX_LESSONS_PER_ATTEMPT = 1`.
- Three levels: `ScopeKind`.
- Merge, generalise and archive: the curator's `merge`, `rewrite` and `archive`.
- Undo: `revert-pass` and `restore`.
- One-tap delete with Undo, and earlier versions: `RuleRow`, `UndoRow` and
  `EarlierTexts`.

`mem.note` sits under the frame in the place `demo.note` has in the hero.

## 5. The eight example rules (cleaned)

Source: the live role rules, read through Delegatus (`search_memory`, which
reads the role-memory store live, and the learned-rules block injected into
this stage) on 2026-10-21 between 17:30Z and 17:45Z. Each line below is a new
text written for strangers. It keeps no person, account, chat, group,
hostname, path, id, secret, client or other project name, and no private
quote. The «From» column names each source by kind only; the exact rule ids
went to this stage's report for the reviewer and stay out of every published
file, including `world.ts`.

| # | Scope (role) | Rule — en | Rule — uk | Why — en / uk | From |
|---|---|---|---|---|---|
| O1 | role, every project (orchestrator) | Answer a quick question from data you already have in the same turn. Start a pipeline only for work that needs one. | Швидке питання, на яке вже є дані, закривай тим самим ходом. Пайплайн запускай лише для роботи, якій він потрібен. | A pipeline for a one-line answer made the person wait for a free slot. / Пайплайн заради відповіді в один рядок змусив людину чекати вільного місця. | an orchestrator rule of another project, kept as its generic practice |
| O2 | role, this project (orchestrator) | Run a load test that needs the whole machine at a quiet hour, in small batches, and stop starting runs when asked. | Навантажувальний тест, якому потрібна вся машина, запускай у тиху годину, малими партіями, і припиняй нові запуски на прохання. | While it ran, every other task's checks slowed down. / Поки він ішов, перевірки всіх інших задач сповільнились. | this project's orchestrator rule |
| B1 | role, every project (builder) | Change only what was asked. Add no labels, notices or explanations nobody requested; fix the cause of a complaint instead of explaining it. | Змінюй лише те, що просили. Не додавай написів, повідомлень чи пояснень, яких ніхто не просив; виправляй причину скарги, а не пояснюй її. | Extra text added to answer one complaint became the next complaint. / Зайвий текст, доданий у відповідь на скаргу, став наступною скаргою. | two overlapping rules from two roles, merged as the row shows |
| R1 | role, every project (reviewer) | To prove the output never contains something, make the test's fake input contain it and check what comes out. A fake that already behaves passes before the fix and proves nothing. | Щоб довести, що у виході чогось ніколи немає, дай це в підробленому вході тесту й перевір, що вийде. Підробка, яка вже поводиться правильно, проходить і до виправлення та нічого не доводить. | A test written the easy way stayed green with the bug put back. / Тест, написаний легким шляхом, лишався зеленим і з поверненою помилкою. | an architect rule on proving a negative |
| A1 | role, every project (architect) | When a design turns a setting on by default, list the existing tests that now reach it and the state they share. | Коли дизайн вмикає налаштування за замовчуванням, перелічи наявні тести, які тепер до нього доходять, і спільний стан між ними. | Tests that passed one by one failed together after a default changed. / Тести, що проходили поодинці, впали разом після зміни типового значення. | an architect rule on default switches |
| P1 | project | A fresh checkout has no dependencies: install them from the lockfile before the first commit, and never skip the commit hook to get past an error. | У свіжій копії репозиторію немає залежностей: встанови їх із lock-файлу перед першим комітом і ніколи не обходь хук коміту, щоб проскочити помилку. | The hook failed on a missing module, and skipping it let a lint error through. / Хук упав через відсутній модуль, а його обхід пропустив помилку лінтера. | this project's rule for every role |
| M1 | machine | Delete only the temporary files your own script created and recorded. Never choose files to delete by a name pattern. | Видаляй лише тимчасові файли, які створив і записав твій власний скрипт. Ніколи не обирай файли для видалення за шаблоном імені. | A pattern matched files another task was still using. / Шаблон зачепив файли, якими ще користувалась інша задача. | a machine rule |
| M2 | machine | When a test run stops at its time limit, run it again with a longer limit before reading the results as failures. | Якщо прогін тестів зупинився на ліміті часу, перезапусти його з довшим лімітом, перш ніж вважати результати падінням. | Tests cut off by the limit looked like real failures. / Тести, обірвані лімітом, виглядали як справжні падіння. | a machine rule |

The rules cover four roles (orchestrator, builder, reviewer, architect), the
project level and the machine level, which matches acceptance (c). Every text
is under the product's 300-character rule limit and every why is under 160
(`RULE_MAX_CHARS`, `WHY_MAX_CHARS`). The builder checks this with a length
assertion in `copy.test.ts` (§11) so a long translation fails there and not
in the window.

How the text was cleaned:

- Ids, file names, tool and flag names were removed.
- Each rule was rewritten so that someone who does not know Delegatus can act
  on it.
- The reason became a concrete consequence.
- The other project's rule (O1, from a client project's seat) keeps only its
  generic practice.

The privacy gate is still the judge. The builder runs it on `world.ts` and
`copy.js` before the push.

## 6. Section 6, usage

### 6.1 Product components behind it

| What shows | File |
|---|---|
| Card marks: engine mark plus four-cell scale per provider on the state line, Claude first | `src/components/kanban/TaskSpend.tsx` (`TaskSpendMarks` :131, `spendCells`), on the card via `CardStateLine.tsx:125` and `KanbanCard.tsx:663`; phone `MobileKanban.tsx:578` (passive) |
| The popover: «≈3% of the week», per account «task 2% · week 31%» with a bar, the 5-hour line, «Estimate, ±30%» | `TaskSpend.tsx` (popover blocks, `data-spend-pop`) |
| Phone task screen section «Limits» | `PhoneTaskSpend` in `TaskSpend.tsx:192`, mounted at `src/components/mobile/MobileTaskScreen.tsx:1254` |
| Data | `GET /api/task-spend?ids=…` (`src/app/api/task-spend/route.ts`), types `src/lib/activity/taskLimitSpendTypes.ts`; one batched request per board (`taskSpendSummaries.ts`) |
| Limit history: the burndown panel with Week and 5 h tabs, the ideal diagonal, the actual curve, pace text («on even pace», «12% ahead of pace — burning fast») and the projected zero | `src/components/BurndownPanel.tsx`, opened from the rail footer's week button (`LimitsFooter.tsx`, `aria-label` = `burndown.openAria`); data `GET /api/limits/history` (`BurndownPayload`, `src/lib/types.ts:775-806`) |

### 6.2 Views

- `spend`: the board with the seat folded (the existing `fold` path), so the
  In progress column is wide and every card's state line carries its marks.
  Readiness waits for `[data-spend="t-refunds"]` to draw its cells.
- `task`: the same board, then press `[data-spend="t-refunds"][role=button]`
  so its popover opens. The popover opens downward and covers no other card's
  text; if it does at 1180, open the card below the column's last card instead
  (`t-logs`). The phone opens the task screen for `t-refunds` (`#t=` or the
  card tap the phone uses) and scrolls to `[data-phone-task-spend]`.
- `history` (desktop only): show the rail, as `accounts` does, then press the
  Claude week button (`burndown.openAria` with `{engine: "Claude"}`). The
  panel is 430 px wide and anchored beside the rail's foot, and it opens on
  the Week tab.

### 6.3 Limit history is not on the phone

The burndown panel mounts only in the desktop rail's footer
(`LimitsFooter.tsx:400`), and `src/components/mobile/` has no burndown and no
history (`grep -rln "burndown\|limits/history" src/components` finds only
`BurndownPanel.tsx`, `LimitsFooter.tsx`, `rateLimit.ts` and the kanban test
fixture). So at phone widths the `history` tab is hidden by the same media
query `main.js` uses for `phoneQuery`. If the frame's view is `history` when
it becomes a phone frame, `main.js` switches it to `spend`. `use.c3` names
the computer, so the caption claims nothing the phone draws.

### 6.4 What the invented world needs

- `GET /api/task-spend` answers `{ generatedAt, tasks }`. Each value is a
  `TaskSpendSummary` with Claude first and `accounts` present (the demo plays
  the owner). The values below were checked against `spendCells`.
  - `t-refunds`: Claude 3.2 → `≈3%`, one cell. Accounts: Main · Max with task
    2.1, week 31, session 9; Work · Max with task 1.1, week 12. Codex 1.4 →
    `≈1%`, one cell; Main · Pro with task 1.4, week 22.
  - `t-retries`: Claude 2.0; Codex 0.6 → `<1%`, no cells.
  - `t-keys`: Claude 0.4 → `<1%`.
  - `t-logs`: Claude 0.8.
  - `t-receipts`: Claude 1.2.
  - Done cards: `t-postgres` Claude 6.3 → two cells, Codex 2.1; `t-charges`
    Claude 1.9, Codex 0.7; `t-health` 0.9; `t-timeouts` 1.1.
  - The other project's cards: under 1 %.
  - Inbox cards: no providers, so they draw nothing (as for a task with no work
    yet). All `bound: "approx"`.
  - Account weeks equal `accounts()` in `demo.tsx:189-195`, so the popover and
    the accounts panel agree.
- `GET /api/limits/history` returns `claudeAccountId: "main"`,
  `codexAccountId: "main"` and `historySince` 9 days ago.
  - `claude.weekly`: the window opened 3 days 22 h ago and resets in 3 days
    (`demo.tsx` uses `resetIn(3*24*60)` for weekly). Samples every 30 min run
    from 100 down to 69, flat at night and steeper in working hours, ending at
    the 31 % used that the footer prints. The pace text then reads a few
    percent «under pace — room to spare».
  - `claude.session`: the 5-hour window opened 2 h 40 min ago. It falls from
    100 to 58 (42 % used), steeper than even, so that tab reads «ahead of
    pace» with a projected zero.
  - `codex.weekly`: falls from 100 to 78. `codex.session` has
    `windowUnreported: true` (Codex reports no 5-hour window, as
    task-limit-spend §1.4 measured), so that tab says why it has no curve.
  - The invented series stays inside the bounds `limitsHistoryStore.ts` keeps
    (one sample per 5 minutes at most, 8 days).

### 6.5 Copy (en / uk)

| key | en | uk |
|---|---|---|
| `use.title` | Know what each task spent. | Знай, скільки витратила кожна задача. |
| `use.c1` | Every card estimates how much of your weekly Claude and Codex limits its task used, within about 30%. | Кожна картка оцінює, скільки тижневого ліміту Claude і Codex з’їла її задача, з точністю близько 30%. |
| `use.c2` | Open the marks for each account: the task's share and how much of the week is gone. | Відкрий позначки — побачиш кожен акаунт: частку задачі й скільки тижня вже витрачено. |
| `use.c3` | On a computer, the account in use draws its week and its 5 hours against an even pace. | На комп’ютері видно, як акаунт у роботі витрачає тиждень і 5 годин проти рівного темпу. |
| `use.views` | Limits | Ліміти |
| `use.tab1` | On the cards | На картках |
| `use.tab2` | One task | Одна задача |
| `use.tab3` | History | Історія |
| `use.alt` | The Delegatus board with invented data: each task's estimated share of the weekly Claude and Codex limits, one task's accounts, and an account's weekly burndown. | Дошка Delegatus із вигаданими даними: оцінена частка тижневих лімітів Claude і Codex для кожної задачі, акаунти однієї задачі й тижнева витрата акаунта. |

Each claim and the code behind it:

- About 30 %: «Estimate, ±30%».
- The weekly unit: `taskSpend.ofWeek`.
- Per account task and week: `TaskSpendAccount.week`.
- The account in use only: `BurndownPanel` takes `activeAccountId`.

## 7. States to render, at 1440×900 and 390×844, en and uk

The landing pins the dark palette (README), so dark is the only theme. Each
state names the element that defines it, which must be visible text on the
first screen of the frame once the section is scrolled into view.

| Section · tab | 1440 (frame) | 390 (phone frame) | Defining element |
|---|---|---|---|
| autonomy · Settings | board with seat at side, tick popover open at top; ring on the slider | seat sheet → tick sheet, autonomy section on screen | «Full autonomy · until HH:MM · 4 h 12 min left» (`[data-seat-tick-autonomy-summary]`), the toggle on |
| autonomy · Its decisions | popover scrolled to the log, Details open | tick sheet scrolled to the log | «Autonomous decisions» heading and d1's decision, «Form saved», why, «How to undo:» line, all whole |
| memory · Rules | window on All rules, Orchestrator chosen, three columns, O1 expanded | window full screen, Role column, O1 expanded | the three headings Role / Project / Machine (desktop); on the phone the Role heading, the role chips with counts and O1's «Why:» |
| memory · Curator | curator history open with two passes; Project's «Left the rules» open | same, one column, scrolled so the passes show first | «Curator · Last: …» summary, «merged 1, rewrote 2, …», «Undo pass» / «Pass undone», «about one task» with «Return» |
| usage · On the cards | board, seat folded, In progress cards with marks | board, In progress tab, cards with passive marks | the scale cells on `t-refunds` and `t-postgres` (two cells) |
| usage · One task | `t-refunds` popover open | task screen, «Limits» section | «≈3%», «Main · Max … task 2% · week 31%», «Estimate, ±30%» |
| usage · History | burndown panel, Week tab | tab hidden | the curve, the dashed ideal line, the pace sentence |
| run · Build, Review, Verify | unchanged, plus «Left 1 rule → Reviewer» under Review | unchanged, plus the same line | the line, whole |

Also required, from the acceptance and the role's rendering rules:

- One width between each pair, 900 px (between 390 and 1440), in both
  languages. Not every tab is required: the sections' first screens and the
  full page are enough, because the frames scale and the copy wraps there.
- No sideways overflow on the page.
- No control or popover leaves the frame or covers another card's text. Check
  the spend popover and the burndown panel especially.
- No row is cut by the frame's edge or the popover's scroll edge, measured
  from text ranges.
- Reduced motion: the autonomy ring draws its static outline (design §6, and
  the frame's own `prefers-reduced-motion` rule in `demo.tsx:733`).
- Full screen: each new frame through its control, in both languages and at
  both widths, with `--check-fullscreen` (§11).

## 8. Not shipped, and so not on the page

| Thing | State on main `db528f4d` | On the page |
|---|---|---|
| Limit history on the phone | none (§6.3) | `history` tab hidden at phone widths; `use.c3` names the computer |
| A history chart for an account that is not in use | `BurndownPanel` charts the active account only (`burndownForActiveAccount`; `LimitsFooter.tsx` `InactiveAccountLine`: "It has no burndown chart"). #3155 records each Codex account's history, but no surface charts it | caption says «the account in use» |
| Autonomy badge on the phone board, countdown in the thumb | deferred, full-autonomy design §6 | not drawn |
| Turbo in the seat tick settings | lane 1ab7de9b, building | no Turbo field in the world. If Turbo merges before this lane's build, its control renders in the default off state as part of the shipped panel and gets no caption |
| Voice tools | lane 3f67e4dc, PR #3157 draft | not touched |
| Memory profile through Claude Code | lane 10fb39d3, building; it changes how the profile is produced | the Profile page is reachable but not a tab; it shows whatever main draws |
| Spend for Copilot and other engines | not read (task-limit-spend §1.3) | the demo has Claude and Codex only |
| Task spend and per-account Codex history in an npm release | on main (#3151, #3155), not in v1.15.0 | see §9 |

Because nothing unshipped is drawn or claimed, no "in progress" caption is
needed. If the builder finds that a needed view only works with a product
change, it stops and reports it. It does not caption an unshipped surface.

## 9. Publication order (for the seat, after merge)

The landing's frames bundle main. Its visitors install npm's latest release.
Card spend marks (#3151, merged 2026-10-21) and the per-account Codex history
(#3155) are not in v1.15.0, the latest npm release. The rest (autonomy
v1.13.0, curator panel and token store v1.14.0, curator import v1.15.0) is
released.

- Publish after the next release contains both: `git tag --contains
  de097ea17` lists a `v*` tag, and `npm view delegatus-cli version` names it.
- Otherwise the usage section's `use.c1`/`use.c2` describe something a fresh
  install does not have yet.

This lane does not publish and does not cut a release. The seat cuts daily
releases.

## 10. Observations made for this brief

All on a `git archive` export of `db528f4d` under this stage's `$TMPDIR`, with
`bun install --frozen-lockfile`. The environment had a private `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`, and `LLV_VIEWER_CONTROL_URL`
on a closed port. Heavy steps ran through `scripts/gate-slot.sh`.

- **Build**: `bun landing/site/build.ts` in the export, through
  `scripts/gate-slot.sh`, finished with exit 0. Sizes: `index.html` 18 898 B,
  `copy.js` 26 920 B (8 518 B gzip), `main.js` 28 263 B, `styles.css`
  54 195 B, `boardDemo.js` 51 690 B, `demo/demo.js` 5 211 104 B and
  `demo/viewer.css` 386 721 B. The two demo files are lazy and load with the
  first frame below the hero.
- **The routes the bundle asks for**: `grep` over the built `demo/demo.js`
  finds `/api/task-spend?ids=…`, `/api/role-memory`,
  `/api/role-memory/lessons` and `/api/role-memory/profile`. `demo.tsx` has a
  handler for none of them.
- **Not measured**: a browser probe of each existing view's
  `demoUnanswered` (a scratch script beside the export) waited in the shared
  CPU queue for over 25 minutes at load 18–56 and had not run when this
  document was written. §1's statement about the run frame comes from the
  code paths cited there, not from a measured run. The builder's
  `capture.ts` run, once it reports every frame (§11), measures it.
- **Privacy**: `scripts/privacy-publication-gate.ts --require-known-values`
  with the committed fingerprints, run on this document in a scratch clone,
  printed `PRIVACY GATE: PASS`.
- **Releases**: `git tag --contains` puts autonomy (`098503993`) in v1.13.0,
  the curator panel (`e705f5106`) and the token store (`6a1ea0d93`) in
  v1.14.0, and the curator import (`85d6cc0ff`) in v1.15.0. Task spend
  (`de097ea17`) and per-account Codex history (`fee9eac9d`) are in no tag.
  `npm view delegatus-cli version` printed 1.15.0.

## 11. What the builder changes, file by file

| File | Change |
|---|---|
| `landing/site/index.html` | three sections in the order of §2, with English text in place (the page's no-JS fallback), `data-i18n` on every string, a `[data-live]` frame each with `data-query`/`data-phone-query` (autonomy carries `autonomy=1`), tablists with the views of §3.2, §4.2 and §6.2; `mem.note` under the memory frame; the `history` tab marked desktop-only |
| `landing/site/copy.js` | the keys of §3.4, §4.4 and §6.5 in `en` and `uk`; nothing else changes |
| `landing/site/styles.css` | the new section classes join the existing section, frame and tab selectors; the desktop-only tab rule under the same media query as `phoneQuery`; no new tokens |
| `landing/site/main.js` | only the phone fallback for `history` (§6.3); every other behaviour is generic over `[data-live]` already |
| `landing/site/demo/demo.tsx` | answers for `/api/task-spend`, `/api/limits/history`, `/api/role-memory` (GET, POST), `/api/role-memory/lessons`, `/api/role-memory/profile` (GET, POST), the richer seat tick settings and its refused save; the views `autonomy`, `decisions`, `rules`, `curator`, `spend`, `task`, `history` on both layouts; the `autonomy` flag read from the query |
| `landing/site/demo/world.ts` | the data of §3.3, §4.3 (with §5's rules in both languages), §6.4, as functions of `(step, lang)` plus the flag, beside the existing world; the header comment names the flag |
| `landing/site/capture.ts` | the new frames in the load loop (`:1293`), the section shots, the tabs loop, the full-page walk, `--check-fullscreen` (`:387`) and the swipe check's frame lists and expectations (`:305`, `:350`); `report.unanswered` becomes the union of `demoUnanswered` over every `.live iframe`, keyed by frame |
| `landing/site/copy.test.ts` | the existing key-parity test already covers the new `data-i18n` keys; add one assertion that the eight rules in `world.ts` stay within 300/160 characters in both languages |
| `landing/site/README.md` | the sections and files tables, the new views, the `autonomy` flag, the departures (§3.3 omitted panel sections; history desktop-only) |

Checks the builder runs:

- `landing/site/*.test.ts` and `landing/worker.test.ts` by path, under
  isolation, through `scripts/gate-slot.sh`.
- Typecheck, lint, the privacy gate with the fingerprints environment, and
  the pre-push hook.
- `bun landing/site/build.ts`.
- `capture.ts` (default run, both languages and widths), `--check-demo` with
  `LANDING_BEFORE_DIR` set to a build of main, `--check-fullscreen` and
  `--check-swipe=after`. All of these run under `flock
  /var/tmp/llv-heavy-gate.lock` or `gate-slot.sh`, with renders under the
  stage scratch or the evidence root.

**First-screen weight.** The new sections add strings to `copy.js` and markup
to `index.html`, both of which load on the first screen. Expect about 6–8 KB
raw, about 2.5 KB compressed. Today `copy.js` is 26 920 B (8 518 B gzip) and
`index.html` is 18 924 B (5 254 B gzip). The hero, its demo, the fonts and the
frames' bundle (lazy) do not change.

- The builder reports `--check-demo`'s first-screen bytes and request count,
  median LCP and CLS, before and after.
- The request count must not grow, and the LCP element and CLS must not get
  worse.
- The byte growth must be no more than the compressed size of the added
  strings and markup, and the PR states the number.

If the seat reads "not worse" as zero added bytes, the only way is to move
strings out of the first screen, which is listed in Deferred.

## 12. What not to touch

- `src/**`: no product change. Every view is reached through product
  controls that already exist. If one cannot be reached that way, report it
  and do not patch the product.
- The hero (`boardDemo.js`, its styles, `mascot.js`), its captions, the
  install boxes, the prompts, the footer and the FAQ. The hero's checks
  (`--check-demo`) must pass unchanged.
- The run, open and reach copy and their views. The run frame changes only in
  what the product now draws there (the lesson line, card marks once the
  board shows).
- The Worker (`landing/worker.ts`, `wrangler.jsonc`) and the site event
  contract. No new event and no new analytics.
- The seat tick panel's Turbo and the voice tools (fences).
- `evidence/**` and any committed media. Frames stay outside the tree.
- No raw rule text, rule id, account, chat, path or project name other than the
  invented ones in `world.ts`, `copy.js`, a commit or the PR body.

## 13. Validation against the requirement

| Requirement (paraphrased, 2026-10-21) | Where |
|---|---|
| More pictures of what shipped since 2026-10-14 | three new live frames, seven new views (§2) |
| The seat tick where full autonomy lives | §3: the tick panel with autonomy on, the episode's deadline, the decision log with why and undo |
| Statistics: task's share of the subscription as on cards | §6: card marks, the popover, the phone task screen |
| Per-account limit history | §6: the burndown of the account in use; the phone and non-active accounts are not shipped (§8) |
| Agent memory with real, cleaned examples | §4 and §5: eight rules rewritten from the live store, four roles plus project and machine, the curator and its undo |
| en/uk, 1440/390 | §3.4, §4.4, §6.5, §7 |

## Deferred — not currently justified

- **The Activity page's Tokens tab** (#3048) as a fourth statistics view. The
  pinned specification names task cards and limit history. The relay's
  "/stats" has no such route, and Activity is already one tab of the open
  section. If the operator meant the Tokens tab, it is one more `open` view
  (`overview` already reaches the Activity page), with no new section.
- **The memory Profile page as a landing tab.** It is a model-written summary
  that lane 10fb39d3 is changing now. It stays reachable and answered, but no
  tab points at it.
- **An end-of-autonomy report view** (the Done report with outcome
  `autonomy`). It is shipped, but the two views already prove the setting and
  the log, and `auto.c3` names the report.
- **Moving the new strings out of the first screen** (a second copy file
  loaded with the frames) to reach zero added first-screen bytes. This is
  machinery for about 2.5 KB compressed. Do it only if the seat reads the
  acceptance that strictly.
- **A drawn (hero-style) picture of any of these surfaces.** The frames are
  the product, and the README's decision stands.

## Notes

- Load on the host was high while these observations were made (load average
  26–56). Timings from this stage are not comparisons. The builder's
  `--check-demo` before/after run on one machine is the measurement.
