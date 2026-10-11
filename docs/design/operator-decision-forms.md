# Every operator decision as a clickable form in the orchestrator conversation

## Originating requirement

The operator in the Delegatus seat conversation, 2026-10-11 at 14:31Z (17:31
Kyiv), verbatim in Russian. Speech recognition wrote the word «звіт» (the
reports tab) as "zvid"; it is restored in brackets, as the pinned task does:

> У меня в прототипах ничего нет, то есть, которые стоят, закидывай мне в
> questions. И, кстати говоря, это такой баг, который я бы хотел, чтобы,
> получается, все решения, которые от меня нужны, они попадали не в [звіт], а
> они вот попадали вот в эту форму питань, чтобы... потому что они постоянно
> теряются. Поэтому, ну, в [звіт] можно их как бы всё равно кидать, конечно же,
> но форма питань мне нужна. Также вот вопрос: потому что я ничего не вижу, я
> не вижу ни прототипов, ни вопросы, которые ты мне задаёшь, ничего. Мне нужно,
> чтобы они в оркестраторе, вот как ты мне... ты меня спрашиваешь, и я вот хочу
> принять решение. Просто кликнуть.

In short: every decision the seat needs from him arrives as the question form
he already answers in prototype reviews; the form appears inside the
orchestrator conversation, where he is asked; he decides with clicks. Reports
may still mention a decision, but they are not where it lives.

**Should this be built: yes.** The operator names a failure that repeats
(decisions get lost) and the remedy. On 2026-10-07 he had said the same thing
in another project («ты публикуешь в эту вкладку "Отчёты", но они у меня всё
равно теряются»), and the seat's stopgap since this morning, publishing every
decision as a prototype review on a task, still lands outside the conversation
he reads. The build is small because the form, its store, its answer path and
its delivery already exist (§1); what is missing is the place it is drawn and a
way for the seat to ask without a task.

## Decision (2026-10-11, about 18:05 Kyiv)

The operator answered the prototype review round «Рішення формою прямо в
розмові оркестратора» (§6):

1. **Layout: variant 3, «Колонка «Рішення»»** (§3), not the recommended
   variant 1. The forms live in a «Рішення» tab of the column beside the seat
   conversation; the feed keeps a short pointer at the message that asked, and
   the pointer turns into the answer record once answered.
2. **Decisions without a task** live in the orchestrator conversation and in
   «Чекають на вас»; the seat does not create a board card for each.
3. **Reply pills** (`suggest_replies`) stay only for replies that are not a
   choice; every decision is a form.
4. **The column shows every open decision of the project**, the seat's forms
   and the prototype rounds lanes publish, with their thumbnails.
5. **Questions agents cannot resolve** reach the operator through the seat, in
   the same form (lane 01e9febe's escalation holds the round id, no question
   store of its own).
6. **Telegram:** the seat's forms go there exactly as prototype reviews do
   (lane f3bc9ab1's path).

What variant 3 means at each width, as built:

- **Desktop, seat on top, wide enough for the report column** (the column
  opens beside the chat from `REPORT_LOG_SPLIT_WIDTH`, 990 px of seat; a
  1440 px window): the column has two tabs, «Рішення N» and «Звіти». While a
  decision is open the column opens on «Рішення»; with none it opens on
  «Звіти» as before. Hiding the column hides both tabs; while it is hidden and
  a decision is open, one line under the seat header («N чекають рішення ›»)
  opens it on «Рішення».
- **Desktop, narrower seat** (a 1000 px window): the column cannot sit beside
  the chat, so it takes the transcript's place when asked, as the report log
  already does. The same one line under the seat header opens it there on
  «Рішення», and the composer stays under it.
- **Phone (390 px):** the column collapses to that one line under the seat's
  bar; it opens a sheet with the same two tabs.
- **«Чекають на вас»** lists each open decision as its prototype row does
  today; a seat decision's row opens the column (desktop) or the sheet (phone)
  on that form.

## Prior work

- `search_memory` "operator decisions questions form orchestrator" and
  "prototype review questions seat chat suggest_replies" found two memories:
  the Delegatus seat's `operator-design-variants-and-questions-in-chat` (point
  4, written today: every decision also goes into publish_prototype_review on
  the task, as the stopgap until this task ships), and the CelestiaCompose
  seat's `operator-loses-questions-keep-them-few` (2026-10-07: he misses
  questions in bridge reports and reply pills; each `suggest_replies` call
  replaced the previous set, so two of five open questions stayed unanswered
  for hours; he asked for "one accumulating questions plaque with answer
  options").
- `search_transcripts` (project-scoped, ru/uk and en phrasings) found only
  this task's seat conversation and the Telegram research lane
  (`docs/research/telegram-questions-and-prototypes.md`). No earlier design of
  a form inside the conversation exists.
- `docs/design/prototype-questionnaire.md` built the question block this design
  reuses (questions, recommended option, «Інше», shared comment, one answer,
  structured delivery). `docs/design/prototype-review-server.md` is the
  publication and delivery contract.
- Open lanes read on their branches: 01e9febe
  (`docs/design/attention-auto-resolve.md`), 4f9a5951 / #2744
  (`docs/design/done-section.md`), 73d507a0 / #2747 (the delivery change in
  `docs/design/prototype-review-server.md`), f3bc9ab1
  (`docs/design/telegram-prototype-review.md`). §6 places each one.

## 1. How it works today

Anchors are at this branch's base, `0ef6ec497`.

### 1.1 Four ways the seat asks, none of them in one place

| Channel | Where it is drawn | Why it gets lost |
|---|---|---|
| Chat text | the seat feed | scrolls away under the next tick's report; nothing marks it open |
| `suggest_replies` pills | under the seat's latest turn (`src/components/feed/SuggestedReplies.tsx`) | a new set replaces the previous one, and the operator's next message clears it (`src/lib/orchestrator/prompt.ts:433`); a pill is a draft, so it decides nothing |
| `bridge_report` with a decision item | the Reports column and Telegram (`src/lib/bridge/reportWords.ts:34`, `:97` «Чекає рішення») | a line among status lines; answered through the report-answer path in free text |
| `publish_prototype_review` with questions | the task's review dialog (`src/components/prototypeReview/PrototypeReview.tsx:885`, 760–1560 px wide) opened from a card, «Чекають на вас», or the seat composer's notice line | the form is one click away from the conversation, on a different surface; it needs a task |

### 1.2 What already exists and is reused unchanged

- **The form.** A round may carry 3–7 questions with no variants
  (`src/lib/prototypeReview/input.ts:20`, `:49`). Each question has 2–6
  options, exactly one recommended, optional multiple choice and «Інше»
  (`src/lib/prototypeReview/types.ts:18-24`). The question block draws them
  (`PrototypeReview.tsx:723-751`); the recommended option is preselected
  (`:41`, `recommendedAnswers`).
- **The answer.** The operator's browser posts `{answers, comment}`;
  `normalizePrototypeAnswers` validates them (`src/lib/prototypeReview/questions.ts:7`);
  `prototypeDecisionText` composes the structured message
  (`src/lib/prototypeReview/decision.ts:16-29`) and it is sent to the
  project's seat with a fixed key and the steer-or-queue policy. The seat
  receives «Prototype review decision … Answers: 1. … a) … (recommended) …».
- **The waiting signals.** `prototypeReviewNotices` (`src/lib/prototypeReview/model.ts:52`)
  feeds the «Чекають на вас» row, the card reason, the phone seat card chip
  (`PrototypeNoticeChip`, `src/components/prototypeReview/PrototypeNoticeRow.tsx:85`)
  and the seat composer's notice line (`PrototypeNoticeRow`, mounted at
  `src/components/TmuxComposer.tsx:5660` and folded into the seat strip at
  `src/components/orchestrator/OrchestratorPanel.tsx:593`).
- **The mandate line.** `ORCHESTRATOR_PROTOTYPE_DIRECTIVE`
  (`src/lib/orchestrator/prompt.ts:404`, marker `"Prototype review:"` at `:576`)
  tells the seat to ask 3–7 questions in the task's review before ambiguous
  work.

### 1.3 Why the operator "sees nothing"

He reads the seat conversation. A seat question is chat text or pills there,
and the forms that do exist live on task cards: the only trace of them in the
conversation is one composer line (two on desktop, one on the phone), which
names the task and opens a modal elsewhere. Nothing in the feed is clickable
at the place he was asked.

## 2. The design

### 2.1 How a seat asks: one call, the existing tool

The seat calls **`publish_prototype_review`**, as stages already do. Three
changes to its contract:

1. **No task needed for a seat.** A caller that is the project's designated
   seat may omit `taskId`. Such a round is bound to the seat conversation
   (`source.conversationId`, already recorded) and to the project. With a task,
   the seat passes `taskId` as today and the round also shows on that card. A
   pipeline stage is unchanged: it inherits its task (`http.ts:28-37`).
2. **1–7 questions.** `questions.min(3)` becomes `min(1)` so one decision is
   one question. The 3–7 «grill me» habit stays where it belongs, in the
   mandate.
3. **The answer names the round.** The publish result already returns
   `reviewId` (`http.ts:68`). The feed reads it from the tool call's result to
   draw the form at that row (§2.3). No anchor is stored.

One sentence joins the tool description: "A seat may omit taskId: the form
then lives in its conversation."

**Why not a new tool** (`ask_operator`) or a widened `suggest_replies`: one
store, one answer route, one structured message, one «Чекають на вас» row kind,
one Telegram rendering (f3bc9ab1) and one read tool (`read_prototype_review`)
already exist for this exact shape. A second tool would duplicate all six or
wrap them; the only thing a new name buys is a nicer word in the seat's tool
list, and the mandate line (§2.7) gives the seat that word.

`suggest_replies` stays as it is, for replies that are not a choice ("go on",
"explain X first"). A decision goes to the form; the mandate says so.

### 2.2 Storage for a round without a task

Task-bound rounds stay in `task.prototypeReviews`. A seat round without a task
goes into one small `SqliteStateCollection`, `seat-decisions`, keyed by round
id, holding the same `PrototypeReviewRound` with `taskId: null` and its
`project`. Media copies use the same `state/prototype-reviews/<id>/` directory,
so retention and orphan cleanup need no new branch.

- **Reads.** `GET /api/projects/:project/decisions` returns the project's open
  rounds, task-bound waiting rounds and seat rounds together, newest last,
  each with its `taskId` (or null) and its source. It is what the strip and the
  inline card poll. `read_prototype_review` without a `taskId`, from a seat,
  reads its own seat rounds.
- **Decide.** The existing `reviewPOST` route takes a round id; a seat round
  resolves through the collection. Validation, the decision
  lock, idempotency and delivery are the same code.
- **The message.** For a round with no task, `prototypeDecisionText` writes
  `Operator decision` as its first line and `Asked: <round title>, <HH:MM>` in
  place of the `Task:` line; everything after it is today's text, byte for
  byte. A task-bound round's message does not change.
- **Notices.** `prototypeReviewNotices` takes the seat rounds too, with
  `target: { kind: "seat-decision", reviewId }`, so «Чекають на вас», its
  counter and the phone seat card chip see them with no new row kind.
- **Linked installations.** Seat rounds do not cross the task wire; they are
  the local seat's questions. A second installation's operator answers them
  where that seat runs.

### 2.3 Where it renders (variant 1, recommended)

**Inline, at the message that asked.** `FeedItem` recognises a tool row for
`mcp__viewer__publish_prototype_review` (Claude and Codex spellings are already
normalised, `src/components/feed/parse.ts:518-520`) whose result carries a
`reviewId`, and draws the **decision card** in place of the tool row. The card
reads live state from the decisions endpoint, so it is answerable until
answered and turns into its answer record afterwards, on every surface that
shows the seat conversation: the seat panel, the agent window, the phone seat
screen.

**One strip at the top of the seat conversation.** Directly under the seat
header: «Чекають рішення · N» and a chip per open round, oldest first, two on
desktop with «ще N» folding the rest, one line on the phone with the count and
the oldest title. A chip opens its form as a drop-down under the strip
(desktop, 640 px) or a panel over the transcript (phone), the same card. A
chip for a round that has an inline card in the loaded feed scrolls to it
instead. The strip lists rounds the seat published and rounds a lane
published for this project, so a stage's prototype review (which has no
message in the seat feed) is answerable from the conversation too.

The strip **replaces** `PrototypeNoticeRow` in the seat composer
(`TmuxComposer.tsx:5660` for the seat's project) and takes its role: it is the
same list, moved to where the operator looks first, and it gives the composer
its height back. The folded seat strip keeps `PrototypeNoticeChip`
(`OrchestratorPanel.tsx:593`), and the phone board's seat card keeps its chip.

**Mirrors.** «Чекають на вас» keeps its row per open round (now including
seat rounds), opening the same card. A task-bound round still shows on its
card's review button. Telegram (f3bc9ab1) posts it with the same format.

### 2.4 Answering

- One click per question: the recommended option is already chosen, so
  agreeing with everything is one click on «Відповісти». A different option is
  one click; «Інше» opens the shared comment, which «Відповісти» then requires,
  exactly as in the review window.
- The inline card has **no «Пропустити»**: with the recommendations preselected
  it would send the same answers under another name. The review window keeps
  it. `skipped` is not written from the inline card.
- After «Відповісти» the card collapses at once to its answer record (each
  question with the chosen answer, the time, the delivery state), which is
  #2747's optimistic acceptance applied to the same route; delivery retries in
  the background and a failed delivery shows its retry in the record.
- The seat receives the structured message of §2.2 in its conversation, like
  «Prototype review decision» today, and its next turn appears under the
  record.

### 2.5 Prototype reviews waiting for him, with their frames

A round with variants draws, above its questions, one numbered thumbnail per
variant (the first frame, 176 × 106 px on desktop, 150 × 90 px on the phone and
in narrow columns) and «Відкрити прототипи», which opens the existing review
window on that round for full-size frames, before/after and video. Choosing a
variant is a question («Який варіант будуємо?», options «1 — …», «2 — …»), as
the seat already asks it; the thumbnails are previews and open the window. A round with variants and no questions (older publications) shows its
thumbnails and «Відкрити прототипи» only, and is decided in the window.

### 2.6 The decision card

The card is the review window's question block extracted into one shared
component (`DecisionQuestions`), used by the window and by the card, so there
is one implementation of the question rows. Inside the card:

- header: the question or gallery mark, the round title, its source («оркестратор»
  or «лейн e9e98524 · 2 варіанти»), the time;
- questions without their own box (the card is the box), side by side in two
  columns where the card is at least 600 px wide (desktop feed), one column
  elsewhere;
- option rows 36 px on a fine pointer, 44 px on touch (the window already
  uses 44 px everywhere);
- the comment field with the microphone and «Відповісти» on one row.

Strings: the window's `proto.q.*`, `proto.answer` and `proto.questions` keys,
plus four new keys: `decisions.strip` («Чекають рішення» / "Waiting for a
decision"), `decisions.more` («ще {n}» / "{n} more"), `decisions.fromSeat`
(«оркестратор» / "orchestrator"), `decisions.openPrototypes` («Відкрити
прототипи» / "Open prototypes").

### 2.7 The mandate

`ORCHESTRATOR_PROTOTYPE_DIRECTIVE` keeps its marker and becomes:

> Prototype review: every decision you need is a form:
> publish_prototype_review, 1–7 questions, taskId when a task exists; chat and
> reports only point to it. Before non-trivial or two-way work, or on request,
> ask 3–7 there. After the answers, write "how I understood" (3–5 lines) into
> the task text and start.

As built (mandate v46) the directive drops "one recommended each" and "from
the operator": the delivered directives sat 3 bytes under their 15 100-byte
share, and the schema already refuses a question without exactly one
recommended option.

The reply-drafts paragraph (`prompt.ts:431-433`) loses its third sentence
and gains "Decisions go to the form; drafts are for replies that are not a
choice." The build measures the envelope tests (`prompt.test.ts`,
`handoffDigest.test.ts:488`) first and pays back what the directive adds from
that paragraph, bumps the version past the highest fingerprint on main and
adds its fingerprint. A decision that needs an action outside Delegatus (run a
command on another machine, sign in) stays a bridge `decision` item: a click
cannot settle it.

## 3. Variants

Three placements of the same card. Frames: desktop 1440 × 900 and phone
390 × 844, light uk and dark en, three states each (the seat's question, a
lane's prototype round, after the answer). Measured in
`prototypes/operator-decision-forms/frames.json`; "transcript share" is the
visible feed height over the conversation column (desktop) or the screen
(phone), overlays subtracted.

| | 1 — У розмові + стрічка зверху | 2 — Над полем вводу, по одному | 3 — Колонка «Рішення» |
|---|---|---|---|
| Where the form is | in the feed at the asking message; the strip opens any other | docked above the composer, «1 з 3» arrows between open forms | a «Рішення» tab beside «Звіти» on desktop; a sheet with the same tabs on the phone |
| In the feed | the card itself | a pointer «… · Відповісти внизу ↓» | a pointer «… · Відповісти в колонці «Рішення» →» |
| Transcript share, a question open | 0.80 desktop, 0.80 phone (the card is in the feed) | 0.36 desktop, 0.33 phone | 0.86 desktop, 0 phone (sheet) |
| Always visible while open | strip line (40 px desktop, 44 px phone) | the whole dock | the tab count; on the phone, one line under the header |
| Cost | strip + inline card | the dock competes with #1d76a67f's ≥60% transcript rule while anything is open | on the phone it is a sheet away; on desktop it takes the reports column |

Variant 1 answers the requirement literally ("в оркестраторе … ты меня
спрашиваешь, и я … хочу … просто кликнуть"): the click is where he was asked,
and the strip is what keeps an older question from being lost. Variant 2
never lets a question out of sight but spends a third of the conversation on
it for as long as any decision is open, which conflicts with the open lane
that holds the transcript at ≥60%. Variant 3 is tidy on desktop and moves the
phone answer one sheet away from the conversation, which is the distance he
complained about.

**Recommended: variant 1.**

## 4. Relation to the other open lanes

- **01e9febe «Чекають на вас» keeps only real decisions.** Its design adds an
  `escalate` action that stores a question, options and a recommendation for
  the operator. That is this form. Recommended: the seat escalates by
  publishing a form (bound to the task or the seat); 01e9febe's escalation
  record holds the round id and no question of its own, and its row
  is the form's row. Its automatic clearing applies to rounds as it already
  does (`model.ts` supersession). This needs a word to that lane before its
  build adds a second question store (question 5).
- **4f9a5951 / #2744 «Готово».** Finished outcomes the operator acknowledges.
  They are not decisions: the strip never lists them and the decision card is
  never used for them. The panel keeps decisions above «Готово», as #2744
  draws it.
- **73d507a0 / #2747 optimistic acceptance.** The card posts to the same
  decide route, so it inherits the immediate close and background delivery;
  build on top of it.
- **f3bc9ab1 Telegram reviews.** Seat rounds use the same round shape, so the
  Telegram post and its copy-answer buttons cover them; the post's "Task" line
  reads «Рішення оркестратора» for a round without a task (question 6).
- **Bridge reports.** A report may mention a decision in one `status` line
  ("форма в розмові"); the form is the record. Bridge `decision` items stay for
  actions a click cannot settle (§2.7), so «Чекають на вас» never shows the same
  question twice.

## 5. Visual critic pass on the frames

Read every PNG at 1440 and 390 after each render. What it found and what
changed:

1. Desktop strip: four chips truncated their titles at 740 px. Now two chips
   with whole titles and «ще N»; `frames.json` records `stripChipsCut: 0`.
2. Phone, lane round opened from the strip: the strip line and the card header
   repeated the same title, and the panel's source line was translucent over
   the transcript. The card drops its header there (the strip line names it)
   and the source line is opaque.
3. Phone, variant 2: the dock grew past its budget and pushed «Відповісти» off
   the screen. The dock's questions now scroll and its footer is pinned; the
   check fails a frame whose Answer button is covered or off screen.
4. Variant 3 column (380 px): the two thumbnails overlapped and the source
   squeezed the title to an ellipsis. Narrow cards use 150 px thumbnails
   without «Відкрити прототипи» (a tap on a thumbnail opens the window) and
   drop the source; checks for overlap and a cut title were added.
5. The answer record printed the question's time (17:42); it now prints the
   answer's (17:46).
6. Phone: the card sat behind the avatar's 38 px indent; it now spans the feed.
7. Phone, variant 3: the header icon's count repeated the line under the
   header. The count was removed (nothing extra).

All 24 frames pass: no horizontal overflow, every option row on the phone
≥ 44 px, every thumbnail at its drawn size, every subject card's Answer button
reachable and uncovered.

## 6. Questions for the operator

Published on this task as the prototype review round «Рішення формою прямо в
розмові оркестратора» (2026-10-11): variants 1–3 with 24 frames and the six
questions below, each with my recommendation first.

1. **Яку розкладку будуємо?** 1 — у розмові + стрічка зверху (рекомендовано) ·
   2 — над полем вводу, по одному · 3 — колонка «Рішення».
2. **Рішення без задачі (деплоїти зараз? який акаунт?):** живе в розмові
   оркестратора і в «Чекають на вас» (рекомендовано) · оркестратор щоразу
   створює картку на дошці.
3. **Підказки-пігулки (suggest_replies):** лишаються для відповідей, які не є
   вибором; рішення тільки формою (рекомендовано) · прибрати пігулки зовсім.
4. **Стрічка зверху показує:** усі рішення проєкту, і прототипи від лейнів
   (рекомендовано) · тільки питання оркестратора.
5. **Питання агентів, які оркестратор не може вирішити сам (лейн 01e9febe):**
   оркестратор передає їх тією ж формою (рекомендовано) · окремий рядок з
   варіантами в «Чекають на вас».
6. **Telegram:** форми оркестратора йдуть туди так само, як прототипи
   (рекомендовано) · лише в Delegatus.

## 7. Build

Slices, each its own pull request:

1. **Shared question block.** Extract `DecisionQuestions` from
   `PrototypeReview.tsx:723-751`; the window renders through it, unchanged
   (its DOM test stays green as the regression).
2. **Seat rounds.** `taskId` optional for the designated seat, `questions`
   1–7, the `seat-decisions` collection, the decisions endpoint, decide by round
   id, the `Operator decision` message, notices for seat rounds. Failing-first
   tests in `src/lib/prototypeReview/http.test.ts` and `decision.test.ts`:
   a seat publishes without a task, a non-seat without a task is refused, a
   one-question round is admitted, the decision message for a seat round is
   pinned as a golden string, a task-bound message is unchanged byte for byte.
3. **The card in the feed and the strip.** `FeedItem` draws the card for the
   publish tool row; the strip replaces the seat composer's notice line.
   DOM tests: the card renders for a result with `reviewId` and not for an
   error result; «Відповісти» posts `{answers, comment}` once and the card
   becomes its record; the strip folds past two chips.
4. **Mandate** (§2.7), with the envelope tests remeasured on merged main.

Rendered evidence through the existing drivers only: a `describe` block in
`src/components/kanban/kanbanBoard.browser.test.tsx` for 1440 and one in
`src/components/mobile/issue1671Evidence.browser.test.tsx` for 390, uk/en,
light/dark, with the measurements of `frames.json` (Answer reachable, rows
≥ 44 px on touch, no overflow, transcript share).

## Deferred — not currently justified

- **Telegram for the seat's forms** (decision 6). Lane f3bc9ab1 (#2751) posts
  a round from `publishPOST` right after the publication; a seat round leaves
  through the same return, so its hook covers seat rounds once it merges. Its
  copy-answer path decides through a task and needs the seat round's null
  task (`decidePrototype(…, null, …)`) at that integration.
- **Videos in a seat round.** A seat round's pictures answer at
  `/api/image?prototype=<id>&media=<id>`; its videos are not served, since a
  seat asks with questions and a lane's prototype round, which has a task,
  keeps its videos in the review window.

- **A new `ask_operator` tool.** Same store and route under another name; the
  mandate names the habit instead (§2.1).
- **Answering from the pill row** (a pill that is a one-question form).
  `suggest_replies` keeps drafting replies; a decision has its own form.
- **A `formId` on bridge report lines** linking a report to its form, with
  deduplication in «Чекають на вас». The rule "decisions in forms, actions in
  bridge decision items" (§4) avoids the duplicate without it.
- **Seat rounds across linked installations.** They are the local seat's
  questions; the wire does not carry them.
- **Choosing variants by clicking thumbnails inside the card.** The seat asks
  the variant as a question; the window keeps the variant choice for older
  rounds.
- **«Пропустити» in the inline card** (§2.4).

## The prototype

`prototypes/operator-decision-forms/` — `card.tsx` (the card), `main.tsx` (the
three placements on both devices), `copy.ts` (uk/en), `render.ts` (bundles
with Bun, compiles the app's tokens, drives headless Chromium over 24 frames,
writes `frames.json` and fails on unreachable controls, short touch rows,
overlapping or resized thumbnails, cut titles and horizontal overflow). PNGs
stay out of Git; run `bun prototypes/operator-decision-forms/render.ts` to
redraw them (it needs `TMPDIR`, and `THUMBS` when the self-update lane's frames
are gone).
