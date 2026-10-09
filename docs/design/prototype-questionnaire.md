# A short questionnaire inside the prototype review

## Originating requirement

The operator in the seat chat on 2026-10-09 at about 08:55 Kyiv, verbatim in
Russian, cut only where marked:

> вот эта твоя ошибка … что ты нихуя меня не понял, что я от тебя хотел — это
> меня заебало … Мы у нас прототипы есть, и ты там вроде расписываешь, но
> получается, что ты нихуя не понимаешь. Может быть, знаешь, типа, прототип для
> каждой задачи делать, и там, типа, такой опросник, где кликаешь на кнопочки …
> можно использовать что-то типа «Grill Me», вот как у Мэтт Покока есть скилл …
> где задаётся какое-то количество вопросов, небольшое, пусть будет 5 вопросов …
> до 5-7 вопросов … с вариантами ответов … может быть мультиселект плюс одно
> общее поле для ввода, по типу того, как вот у нас сейчас, … даже этот ничего
> не менять, просто немножко подправить дизайн прототипов, чтобы можно было туда
> запихнуть вопросы и на них легко отвечать. И это чтобы можно было делать
> практически по каждой задаче … но при этом, чтобы можно было пропустить эту
> фазу, не обязательно все задачи надо так делать … чтобы можно было вот «Grill
> Me» подобным образом пройтись и сделать shared understanding — это самое
> главное.

Their answers to the seat's four questions, about 09:00 Kyiv:

1. **а**: the questionnaire lives in the existing prototype review window. A review
   may carry questions only, with no images.
2. **б**: the orchestrator sends one when a task is non-trivial or reads two
   ways. The operator can always ask for one («grill me») or skip it.
3. **а**: each question has options (multi-select where it fits), the agent's
   recommended option is marked, one shared free-text field sits at the bottom,
   and one «Відповісти» button sends everything.
4. **а**: after the answers the orchestrator writes «як я зрозумів» (3–5 lines) on
   the task and starts at once. The operator can stop it.

Should this be built: yes. The operator names a failure that keeps repeating
(work built on a misreading) and asks for a specific remedy. The remedy is
small: the review window, its store and its delivery already exist. The answers
above rule out a new window, a new menu entry and a new notice kind, and this
design adds none of them.

## Prior work

- `search_memory` "prototype review questions grill me shared understanding"
  found the seat's own memory `grill-before-building-ambiguous-asks`, written
  the same morning: 3–7 numbered questions, lettered options, the recommended
  one marked, a "something else" line, all-recommended offered first. This
  design keeps that shape, so the seat's chat habit and the window agree.
- `search_transcripts` (project-scoped) on the same terms found only this
  task's own seat conversation (the seat's restatement of the four answers).
  No earlier design of questions inside a review exists.
- `docs/design/prototype-review-server.md` is the contract this extends
  (publication, copies, fences, decision delivery). Nothing here changes its
  media rules.

## 1. How it works today

### 1.1 Publication

- Tool input: `prototypePublishSchema`, `src/lib/prototypeReview/input.ts:15-26`.
  `variants` is required, 1–9 entries (`input.ts:25`), each `{number, name,
  description, frames?, videos?}`. `parsePrototypeInput`
  (`input.ts:31-37`) adds uniqueness and the `dir`/explicit-files exclusion.
- The MCP tool reuses that schema as its input schema
  (`src/lib/mcp/server.ts:3537`) with the description at `server.ts:3264`.
  `read_prototype_review` takes `{clientRequestId?, taskId?}`
  (`server.ts:3538`, description `server.ts:3265`). Both go through the Viewer
  (`src/lib/mcp/bindings.ts:7056-7065`), keyed by the caller-and-task scope
  (`bindings.ts:6945`, `src/lib/prototypeReview/http.ts:42-53`).
- `publishPOST` (`http.ts:61-71`) resolves the task (`publicationTarget`,
  `http.ts:28-37`: a pipeline stage inherits its task, anyone else names a task
  in their own project, `world.ts:45-51`) and calls `publishPrototype`
  (`src/lib/prototypeReview/store.ts:128-227`). That copies media into
  `state/prototype-reviews/<id>/`, refuses a variant with no media
  (`store.ts:145`), and appends the round to `task.prototypeReviews` in the task
  store inside `mutateTasks` (`store.ts:180-218`). The publication key is
  `<caller>:<clientRequestId>`, and `inputDigest` hashes the whole input, so a
  replay with a changed payload is refused (`store.ts:129-137`).
- A seat is a conversation in its project, so it already publishes with an
  explicit `taskId`. Every MCP tool is available to every caller
  (`server.ts:55`), the seat included.

### 1.2 The stored round and its views

- `PrototypeReviewRound` (`src/lib/prototypeReview/types.ts:58-71`):
  `id, title, taskId, project, createdAt, source, publicationKey, inputDigest,
  variants, decision?, mediaRemovedAt?`.
- `PrototypeDecision` (`types.ts:45-57`): `chosen` (variant numbers), `comment`,
  `at`, and `delivery {state, clientMessageId, conversationId, text,
  operationId?}`. The message text is persisted before dispatch, so every
  retry sends the same bytes under the same key.
- Public view: `prototypeRoundMetadata` (`src/lib/prototypeReview/model.ts:6-14`)
  spreads the round minus `publicationKey`, `inputDigest`, `decision` and
  `variants`, then re-adds variants and a decision of `{chosen, comment, at,
  delivery: {state, retryable}}`. `readPrototypeReviews`
  (`src/lib/prototypeReview/read.ts:36-67`) adds media URLs and the superseded
  mark. That one shape answers both the window (`GET
  /api/tasks/:id/prototypes`, `http.ts:72-85`) and `read_prototype_review`
  (`reviewReadPOST`, `http.ts:54-60`).
- Summary and notices: `prototypeReviewSummary` (`model.ts:27-34`), which says
  at most the newest round waits, and `prototypeReviewNotices` (`model.ts:52-63`),
  which give one notice per waiting task with `{id, project, taskId, reviewId,
  title, roundTitle?, createdAt, target}` (`types.ts:101-113`).
- Linked installations: `prototypeReviewReplica` (`model.ts:15-18`) crosses the
  link inside the task row. The receiver validates it with a **strict** zod
  schema (`src/lib/prototypeReview/replica.ts:11-24`) that requires
  `variants.min(1)` and `decision.chosen.min(1)`, and `decodeWireRow` rejects the
  whole task row when the replica fails (`src/lib/links/taskWire.ts:104`).
  Replicas go only to peers at task wire version 5 or newer
  (`taskWire.ts:31-33`, `taskExchange.ts:128`, `taskExchange.ts:267`,
  `taskServe.ts:59`).

### 1.3 The decision and its delivery

- `reviewPOST` (`http.ts:86-100`) admits only the operator's own browser:
  `directOperatorActivityAuthority`, no capability header, no caller
  conversation.
- `decidePrototype` (`src/lib/prototypeReview/decision.ts:84-128`) runs under
  the round's decision lock. It validates `chosen` against declared variants
  and the comment against 20 000 characters (`decision.ts:91-93`). A second
  save with the same choice and comment returns the stored decision, and a
  different one answers 409 (`decision.ts:94-97`). It then composes the message
  (`decision.ts:100`):

  ```
  Prototype review decision
  Task: <task id> — <task first line>
  Chosen: <n> — <name>, <n> — <name>

  Comment:
  <comment verbatim>

  End of prototype review decision.
  ```

  It records it with recipient `world.orchestrator(project)`, the project's
  active seat (`world.ts:40-43`), and `clientMessageId
  prototype-decision:<reviewId>` (`decision.ts:101-102`).
- Dispatch goes through the ordinary conversation-host send with
  `policy: "steer-or-queue"` (`decision.ts:55-60`). Recovery and retry use the
  existing receipt and journal (`decision.ts:27-54`, `61-65`). A read refreshes
  delivery state without sending (`decision.ts:70-83`).

### 1.4 The window

One component, `src/components/prototypeReview/PrototypeReview.tsx`, draws both
forms:

- **Desktop** (`PrototypeReview.tsx:793-842`): a portal dialog
  `w-[min(1240px,calc(100vw-48px))] h-[min(88vh,960px)]`. Header (icon, round
  title, "Prototype review · task", round tabs `:391-414`, close), banners
  (`:371-386`), then a row: the variants `aside` 264 px wide (`:824-831`) with
  `variantRow` entries (`:417-449`: a 28 px choice box showing the number, a
  check when chosen, and the name with its description), and the stage (`:555-623`).
  Footer (`:681-734`): "Chosen" chips (`chosenChips`, `:626-631`), the comment
  field with `MicButtonView`, and the `PRIMARY` save button (`:87-88` for
  `SECONDARY`/`PRIMARY`). A decided round's footer shows the chips, the
  comment and `delivery()` (`:633-654`).
- **Phone** (`:765-787`): `MobileSheet` full height, a sticky context block
  (round title · task, round tabs, `variantChips` `:453-474`: 44 px chips with a
  number box), `variantWords` (`:476-493`) with the 44 px «Обрати» toggle, then
  the stage. The footer is the same footer stacked (`flex-col`).
- Draft state per round: `interface Draft { chosen; comment }` (`:38`).
  `savable` requires at least one chosen variant (`:353`). The close guard
  counts an unsaved comment or speech in flight (`:273`).

### 1.5 «Чекають на вас» and the other notices

All of them read `prototypeReviewNotices` and say the same words,
`proto.notice.ready` ("Prototype ready" / «Прототип готовий»):

- desktop panel row: `PrototypeRow`, `src/components/attention/AttentionPanel.tsx:327-351`;
- phone sheet row: `PrototypeRow`, `src/components/attention/MobileAttentionSheet.tsx:385-413`;
- the queue entry: `buildNeedsYouQueue`, `src/components/attention/attentionQueue.ts:56-71`;
- the seat composer line and chip: `src/components/prototypeReview/PrototypeNoticeRow.tsx:23-123`;
- the card's needs-you reason: `src/components/kanban/KanbanCard.tsx:417`, and
  the phone card label `src/components/mobile/MobileKanban.tsx:515`.

### 1.6 The mandate

- Body: `ORCHESTRATOR_SYSTEM_PROMPT`, `src/lib/orchestrator/prompt.ts:400-483`.
  Its last line is `Prototype review: point to the task's review.`
  (`prompt.ts:483`). The same line is a delivered directive with the marker
  `"Prototype review:"` (`prompt.ts:569`), so a bespoke or stale mandate
  receives it at delivery unless it already has a line with that marker.
- Version: `ORCHESTRATOR_PROMPT_VERSION = 41` (`prompt.ts:95`). Any edit needs a
  bump and a new fingerprint in `PROMPT_FINGERPRINTS`
  (`src/lib/orchestrator/prompt.test.ts:150-172`, checked at `:227-239`).
- The envelope, measured on this branch's base in an isolated state directory:
  - delivered default 29 379 bytes against the bound `MAX_STRUCTURED_TEXT_BYTES - 2_600`
    = 29 400 (`prompt.test.ts:755-783`): **21 bytes** left;
  - rotation history room
    (`src/lib/orchestrator/handoffDigest.test.ts:439-459`):
    `remaining + 2 400 − pointer − HISTORY_BUDGET_BYTES` = **15 bytes** left;
  - what delivery appends to an empty mandate, 14 823 bytes against
    `DELIVERED_DIRECTIVE_BUDGET_BYTES = 14_900` (`handoffDigest.test.ts:486-494`):
    **77 bytes** left.
- Fenced lanes that also move the mandate: #2638 (lane 64e94078) takes v42,
  adds 9 bytes to the body and edits the board report directive. It also
  changes `prototypeReviewNotices` and the summary (`prototypeWaitsOnOperator`,
  `waitingDismissal`) and `AttentionPanel.tsx`. #2637 (lane 3c2b56d1) also
  takes v42 and shortens the body by 52 bytes. Whichever lands later takes the
  next free number, and this lane takes the one after.

## 2. Data model

### 2.1 What an agent publishes

`prototypePublishSchema` gains one optional key, and `variants` becomes
optional:

```ts
const questionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
questions: z.array(z.object({
  id: questionId,                                    // stable within the round
  text: z.string().trim().min(1).max(300),
  options: z.array(z.object({
    label: z.string().trim().min(1).max(120),
    recommended: z.boolean().optional(),
  }).strict()).min(2).max(6),
  multiple: z.boolean().optional(),                  // default: one choice
  other: z.boolean().optional(),                     // offers «Інше» → the shared field
}).strict()).min(3).max(7).optional(),
variants: <as today>.max(9).optional(),             // min(1) moves into the parser
```

`parsePrototypeInput` adds the rules zod cannot state alone, each refused with a
`PrototypeError` that names the question:

- at least one variant or at least three questions;
- `dir` only with variants (a `dir` with no variant has nothing to bind files to);
- question ids unique in the round;
- exactly one `recommended: true` per question (for `multiple` too: the
  preselection is that one option);
- option labels unique within a question.

`PublishPrototypeInput` (`types.ts:17-24`) gets `questions?:
PrototypeQuestionInput[]`, and `variants` becomes optional. `publishPrototype`
copies the parsed questions onto the round. A round with no variants copies no
media and still writes its manifest directory, so retention and orphan cleanup
need no new branch. The `inputDigest` already covers the questions. The publish
answer adds `questions: <count>` beside `variants`, `frames` and `videos`
(`http.ts:68-69`).

### 2.2 What is stored

```ts
export interface PrototypeQuestion {
  id: string;
  text: string;
  options: Array<{ label: string; recommended?: true }>;
  multiple?: true;
  other?: true;
}
export interface PrototypeAnswer {
  questionId: string;
  options: number[];      // 0-based indexes into the question's options, ascending
  other?: true;           // «Інше»: the answer is in the shared comment
}
PrototypeReviewRound  += questions?: PrototypeQuestion[]
PrototypeDecision     += answers?: PrototypeAnswer[]; skipped?: true
```

Answers store option indexes. A published round never changes (the
publication key and digest pin it), so an index is as stable as an id and costs
the agent nothing to declare. Booleans are stored only when true, so a round
without questions is byte-for-byte the shape it is today, and the existing
`decision.chosen` keeps its meaning.

`chosen` may be empty when, and only when, the round has questions. A
questions-only round has nothing to choose. A round with both treats the
pictures as context: a seat that needs a pick asks for it as a question, and
the operator may still tick variants. A round without questions keeps
`chosen.min(1)` exactly as today.

### 2.3 What the operator sends

`DecidePrototypeInput` (`types.ts:114`) becomes:

```ts
{ reviewId: string; chosen: number[]; comment: string;
  answers?: PrototypeAnswer[];       // «Відповісти»
  skip?: true }                      // «Пропустити»
```

`decidePrototype` (`decision.ts:89-103`) validates, under the lock as today:

- a round with questions takes `answers` or `skip`, never both, and a round
  without questions takes neither;
- `answers` names every question exactly once. A single-choice question has
  exactly one option or `other`, never both. A multiple-choice question has at
  least one option or `other`, or both. Every index is in range, and `other`
  only where the question offers it;
- `other` anywhere requires a non-empty `comment`, since the shared field is
  where that answer lives;
- `skip` makes the server write the answers itself: each question's
  recommended option, with `skipped: true`. The client never claims what was
  recommended;
- the composed message must fit `MAX_STRUCTURED_TEXT_BYTES`
  (`src/lib/runtime/structuredContent.ts:40`). Otherwise the save is refused
  with "the answer is too long to send; shorten the comment" before anything is
  stored.

A replayed save compares `answers` and `skipped` along with `chosen` and
`comment` (`decision.ts:94-97`): the same payload returns the stored decision,
and a different one answers 409.

### 2.4 What reads return

- `prototypeRoundMetadata` already spreads every unlisted round key, so
  `questions` reaches the window, `read_prototype_review` and the replica with
  no change. Its decision view (`model.ts:12-13`) adds `answers` and `skipped`.
  `PrototypeRoundView` (`types.ts:73-79`) follows.
- `PrototypeReviewSummary` (`types.ts:93-100`) gains `asks?: "questions"` (the
  waiting round has questions), and its `decision` gains `answered?: true`.
  `PrototypeReviewNotice` (`types.ts:101-113`) gains `asks?: "questions"`, set
  by `prototypeReviewNotices` from the waiting round, or from the summary when
  only a replica is held.
- Tool descriptions (`server.ts:3264-3265`) gain one sentence each, kept
  short. Publish: "questions (3–7): {id, text, options: 2–6 {label,
  recommended?} with exactly one recommended, multiple?, other?}; a review may
  carry questions without variants." Read: "rounds carry questions;
  decision.answers holds option indexes per question id, and skipped:true means
  the operator took the recommendations."

### 2.5 Linked installations

A peer one release behind validates replicas with the strict schema at
`replica.ts:11-24`. A round with a `questions` key, an empty `variants`, or a
decision with an empty `chosen` fails it, and the whole task row is then
rejected as malformed (`taskWire.ts:104`). So:

- `TASK_WIRE_VERSION` moves to 6 (`TASK_QUESTIONS_WIRE_VERSION`);
- the v6 replica schema admits `questions`, `answers`, `skipped`,
  `variants.min(0)` and `chosen.min(0)`, with the same rules as §2.1 and §2.3
  as refinements (a round has a variant or three questions; an empty `chosen`
  only on a round with questions);
- for a peer at version 5, `encodeTask` leaves the replica off a task in which
  any round carries questions (`taskWire.ts:49-51`). That peer keeps whatever
  replica it last had (`taskApply.ts:42` sets it only when present) and never
  sees a row it would reject.

## 3. The window

The questionnaire is a block inside `PrototypeReview`. It reuses the window's
own parts: the variant row's choice box, the variant chip's tint, the
caption's number chip, the aside header, `SECONDARY`/`PRIMARY`, the comment
field with `MicButtonView`, `delivery()`, `MobileSheet`. No new window, route,
menu entry or control family.

### 3.1 One question

```
┌ fieldset [data-prototype-question=<id>] rounded-control border bg-card p-3 ┐
│ [2] Where does the questionnaire live?             ← number chip as the
│     Choose any                                       caption's (:562)
│ ( а ) In the existing review window   [recommended]   ← option row
│ ( б ) A new window
│ ( в ) Інше — напишіть нижче                         ← only with other:true
└────────────────────────────────────────────────────────────────────────────┘
```

- **Question line**: the caption number chip (`h-5 min-w-5 rounded-sm bg-sunken
  text-caption font-bold`, as at `:562`) with the question number, then the
  text in `text-ui font-semibold text-primary [overflow-wrap:anywhere]`. A
  multiple-choice question adds `proto.q.multiple` ("Choose any" / «Можна
  кілька») under it in `text-label text-muted`.
- **Option row**: `variantRow`'s anatomy (`:420-448`). A full-width button with
  `role="radio"` (single) or `role="checkbox"` (multiple) and `aria-checked`,
  `rounded-control border p-1.5`, at least 36 px tall on desktop and 44 px on a
  coarse pointer. Leading 28 px box with the option letter (en a–f, uk а–е):
  `rounded-full` for a single choice and `rounded-control` for multiple. A
  chosen option takes the variant's chosen dress: box `border-accent
  bg-accent text-white` with `Check`, row `bg-accent-soft border-accent/60`.
  An unchosen option keeps `border-transparent hover:bg-sunken`, so the accent
  belongs to the choice alone, as the comment at `:414-416` already says.
- **Recommended mark**: a neutral pill after the label, `rounded-full bg-sunken
  px-2 py-0.5 text-caption font-semibold text-secondary`, with
  `proto.q.recommended` ("recommended" / «рекомендовано») and
  `data-prototype-recommended`. It stays when the operator picks another
  option, so a deviation is visible. The recommended option is **preselected**
  when the round opens.
- **Other**: an extra option row labelled `proto.q.other` ("Other — write it
  below" / «Інше — напишіть нижче»). Choosing it in a single-choice question
  clears the other options. While any «Інше» is chosen and the comment is
  empty, the hint line says `proto.q.otherNeedsComment` and «Відповісти» stays
  disabled.
- **Group**: a single-choice group is `role="radiogroup"` with arrow keys
  moving the choice. A multiple-choice group is `role="group"`. The window's
  digit shortcuts (`:281-304`) keep toggling variants only.

### 3.2 Desktop (1440)

- **Questions only** (no variants): the body row (`:822-833`) is replaced by one
  scroll column, `section[data-prototype-questions] min-h-0 flex-1
  overflow-y-auto`, with an inner `mx-auto flex w-full max-w-[760px] flex-col
  gap-3 px-4 py-4`. Above the first question stands the aside's header pattern
  (`:825-827`): `proto.questions` ("Questions" / «Питання») with the count in
  `text-caption tabular-nums text-muted`. No variants aside, no stage. The
  dialog keeps its size, so the window is recognisably the same one.
- **Questions and images**: the variants aside and the stage stay where they
  are. A third column, `aside[aria-label=proto.questions] w-[360px] shrink-0
  border-l border-border overflow-y-auto`, holds the same header and the
  question list with `p-1.5 gap-1.5`. At 1440 the stage keeps 616 px. A
  single scroll column for the questions keeps the footer and the stage still
  while the operator answers.
- **Footer** of an open round (`:698-734`):
  - the "Chosen" row shows only when the round has variants. On a questions
    round, its place holds the hint line `proto.q.answerAll` ("Answer every
    question" / «Дайте відповідь на кожне питання») while something is
    unanswered, or `proto.q.otherNeedsComment`, in the same `text-label
    text-muted`;
  - the comment field with `MicButtonView` is unchanged. Its placeholder on a
    questions round is `proto.q.commentPlaceholder` ("Anything to add…" /
    «Що додати…»);
  - to its right, `SECONDARY` «Пропустити» (`proto.skip`, `title` and
    `aria-label` `proto.skipAria`: "Skip: use the recommended answers" /
    «Пропустити: взяти рекомендовані відповіді»), then `PRIMARY` «Відповісти»
    (`proto.answer`) in place of «Зберегти вибір». Ctrl/Cmd+Enter in the field
    answers, as it saves today.
- **Answered**: the question list stays in place, read-only. The chosen options
  keep their accent, unchosen ones drop to `text-muted` with their boxes at
  `opacity-60`, and the recommended pills stay. A skipped round shows one
  line above the first question, in the retired banner's dress (`:381-383`):
  `proto.q.skipped` ("Skipped: the recommended answers were taken" /
  «Пропущено: взято рекомендовані відповіді»). The footer is today's decided
  footer: chips only when variants were chosen, then the comment or "No
  comment", then `delivery()` with its retry.

### 3.3 Phone (390)

- **Questions only**: the sticky context block keeps the round line and the round
  tabs, and drops the variant chips (none exist). The body below it is the
  question list, `flex flex-col gap-3 px-4`, under the `proto.questions` header.
  Option rows are full width at least 44 px tall, which is the chip's touch
  height (`:464`).
- **Questions and images**: chips, `variantWords` and the stage stay first, as
  today. The questions header and list follow the stage in the same scrolling
  body, so the pictures stay where they are and the questions are one scroll
  below.
- **Footer** (`MobileSheet` `footer`): the hint line, then the comment field
  stacked as today, then one row of two `flex-1` buttons, «Пропустити»
  (`SECONDARY`) and «Відповісти» (`PRIMARY`), both 44 px through their
  existing `[@media(pointer:coarse)]:h-11`.
- **Answered**: same read-only list, with the skipped line at its top when
  skipped, and today's decided footer.

### 3.4 State in the component

- `Draft` (`:38`) gains `answers: Record<questionId, { options: number[];
  other: boolean }>`. A question absent from the record reads as its
  recommendation, so preselection needs no effect and survives the 2-second
  poll.
- `savable` (`:353`): on a questions round, every question is answered, every
  «Інше» has a comment, and no speech is in flight. Variant choice is required
  only when the round has no questions. `save` sends `{reviewId, chosen,
  comment, answers}`. «Пропустити» sends `{reviewId, chosen, comment, skip:
  true}` and is enabled whenever no save or speech is in flight.
- The hook (`src/hooks/usePrototypeReview.ts:61-80`) needs only the widened input
  type.
- `open`, `successor`, `elsewhere` and the superseded line (`:203-219`,
  `:657-679`) apply unchanged. A round elsewhere or retired shows its questions
  read-only.

### 3.5 Strings

New keys in `src/lib/i18n/en.ts` and `uk.ts` beside `proto.*`:

| key | en | uk |
|---|---|---|
| `proto.questions` | Questions | Питання |
| `proto.q.multiple` | Choose any | Можна кілька |
| `proto.q.recommended` | recommended | рекомендовано |
| `proto.q.other` | Other — write it below | Інше — напишіть нижче |
| `proto.q.otherNeedsComment` | Write your answer in the field below | Напишіть відповідь у полі нижче |
| `proto.q.answerAll` | Answer every question | Дайте відповідь на кожне питання |
| `proto.q.commentPlaceholder` | Anything to add… | Що додати… |
| `proto.q.skipped` | Skipped: the recommended answers were taken | Пропущено: взято рекомендовані відповіді |
| `proto.answer` | Answer | Відповісти |
| `proto.skip` | Skip | Пропустити |
| `proto.skipAria` | Skip: use the recommended answers | Пропустити: взяти рекомендовані відповіді |
| `proto.row.answered` | answered | відповіли |
| `proto.notice.questions` | Questions for you | Питання до вас |
| `proto.notice.answer` | Answer | Відповісти |
| `proto.notice.answerAria` | Answer the questions for «{title}» | Відповісти на питання задачі «{title}» |

## 4. The decision message

`decision.ts:100` moves into an exported pure function
`prototypeDecisionText(task, round, decision)` in the same file. A round
without questions produces today's text **byte for byte** (a test pins it). A
round with questions produces:

```
Prototype review decision
Task: <task id> — <task first line>
Round: <round title>

Answers:
1. <question text>
   a) <option label> (recommended)
2. <question text> (several allowed)
   b) <option label>
   c) <option label> (recommended)
3. <question text>
   Other: see the comment

Chosen: <n> — <name>, …            ← only when the round has variants;
                                      "Chosen: none" when none was ticked
Comment:
<comment verbatim>

End of prototype review decision.
```

When skipped, the `Answers:` line reads `Answers: skipped, use your
recommendations.`, and the list still follows, showing each recommended option,
so the seat's record of what it was told to assume is explicit.

Rules: letters are Latin a–f in the message whatever the operator's locale
(labels travel verbatim, so the letter only orders them); `(recommended)` marks
the option the agent recommended; the question's own text and labels are
copied as published; the comment is copied verbatim, edge spaces and line
breaks included, as today. The header and the closing line stay the ones the
seat already knows, and the recipient, key, policy and retry path are
untouched (requirement 3).

## 5. The mandate paragraph

### 5.1 Text

The last line of the body (`prompt.ts:483`) and its delivered directive
(`prompt.ts:569`) become one exported constant,
`ORCHESTRATOR_PROTOTYPE_DIRECTIVE`:

> Prototype review: point to the task's review. Before work that is non-trivial
> or reads two ways, or on request, ask 3–7 questions there; the operator may
> skip. After the answers, write "how I understood" (3–5 lines) into the task
> text and start.

249 bytes, 204 more than the line it replaces. "The task text" names the place
on purpose: `update_task note` holds at most 280 characters
(`server.ts:3625`), too few for five lines. The task text is the human part of
the card, and the board already writes it in the operator's language. The
seat says «як я зрозумів» for this operator because it writes in Ukrainian
here.

### 5.2 Paying for the bytes

The body gives back what it takes, so the envelope bounds stay where they are:

- `prompt.ts:423`, the attention target paragraph, becomes `Targets are typed
  by kind (conversation, stage, pipeline, task, draft, region, point) and the
  tool schema gives each shape and intent.` (−154 bytes). The cut sentences
  repeat the tool's own schema: `intent` is described at `server.ts:4034`, and
  a refused target names its fields in the refusal. The test at
  `prompt.test.ts:437-445` still holds: it reads the kinds list and "the tool
  schema gives each shape".
- `prompt.ts:426`, the reply-drafts paragraph, drops `Work you can decide
  yourself is no ask: do it and say what you did.` (−68 bytes). "Human in the
  loop" already says it: "Decide yourself whatever the code, the running
  system or one cheap observation can settle", and "When a step needs nothing
  from the operator, keep going". No test pins the sentence.

Net body change: **−18 bytes**. Against the base that holds 21 / 15 bytes of
room, and after #2638 (+9) and #2637 (−52) in either order, every envelope test
keeps its bound.

What delivery appends to a bespoke mandate grows by 204 bytes: 14 823 →
15 027, or 15 036 with #2638's directive edit. `DELIVERED_DIRECTIVE_BUDGET_BYTES`
(`handoffDigest.test.ts:486`) moves to **15 100** with one sentence added to
its history comment. 32 000 − 15 100 = 16 900 still holds two history budgets
(8 192), which the test's second assertion pins.

### 5.3 Versioning and delivery

- Merge `origin/main` first, then take `ORCHESTRATOR_PROMPT_VERSION` = the
  highest fingerprinted version + 1 (43 if both fenced lanes have landed with
  one v42 and one v43 between them, otherwise whatever is next). Add its
  fingerprint and never rewrite an existing entry (`prompt.test.ts:146-149`).
  Re-measure the three numbers in §1.6 on the merged tree and record them in
  the two test comments.
- Seats whose stored mandate carries the old line verbatim get the new one.
  `orchestratorMandateWithRoleTable` (`prompt.ts:616`) replaces the **whole
  line** `Prototype review: point to the task's review.` (anchored
  `/^Prototype review: point to the task's review\.$/m`) with the directive,
  beside the shipped greeting and clock replacements. A plain `split/join` on
  the old sentence would also rewrite the new directive, which begins with
  that sentence, and grow it on every delivery. A mandate whose own
  `Prototype review:` line was reworded keeps its wording, since the marker
  still matches.
- The marker for `DELIVERED_DIRECTIVES` stays `"Prototype review:"`, so the
  directive is appended at most once.

## 6. «Чекають на вас»

For a notice with `asks: "questions"`, each surface in §1.5 swaps the words and
the mark and keeps its layout:

- mark `MessageCircleQuestionMark` (lucide-react, available in the installed
  version) in place of `GalleryHorizontalEnd`;
- desktop panel row (`AttentionPanel.tsx:341-347`): first line
  `proto.notice.questions` with the age, the title, and the third line
  `proto.notice.answer`. `aria-label` is `proto.notice.answerAria`;
- phone sheet row (`MobileAttentionSheet.tsx:398-404`): the role chip word
  `proto.notice.questions`, with the same `aria-label`;
- composer line and chip (`PrototypeNoticeRow.tsx:43`, `:55`, `:89`, `:119`):
  `proto.notice.questions` and the action `proto.notice.answer`;
- card reason and phone card label (`KanbanCard.tsx:417`, `MobileKanban.tsx:515`):
  `proto.notice.questions`;
- the card's review button row (`PrototypeReviewButton.tsx:115`): after an
  answer to a questions round, `proto.row.answered` in place of "chosen {n}",
  which would print an empty list.

A round with both images and questions reads as questions: the questions are
what blocks the work. The row still leaves the list by the answer, and #2638's
dismissal (`prototypeWaitsOnOperator`) applies unchanged. Build on top of it
once it lands.

## 7. Failing-first tests

Each one is written and seen red before the change that turns it green. All run
by path with isolated state (`LLV_STATE_DIR`, `HOME`, `TMPDIR` under the OS temp
root, `LLV_VIEWER_CONTROL_URL` on a closed port). None sweeps a directory.

1. **Tool schema**, `src/lib/prototypeReview/http.test.ts` beside `:68`:
   `TOOL_INPUT_SCHEMAS.publish_prototype_review` accepts a questions-only
   payload (3 questions, one `multiple`, one `other`), and `parsePrototypeInput`
   refuses 2 and 8 questions, 1 and 7 options, zero and two recommended,
   duplicate question ids, duplicate labels, `dir` without variants, and a
   payload with neither variants nor questions.
2. **Round trip**, same file: publish questions-only through `publishPOST`. The
   answer counts `questions: 3, variants: 0`. `reviewGET` and `reviewReadPOST`
   return the questions exactly as published. `reviewPOST` with answers
   (single, multiple, other plus comment) stores them, and both reads return
   `decision.answers` and no `skipped`. The notice clears. A second identical
   save replays and a changed one answers 409.
3. **Validation**, same file: missing answer, two options on a single choice,
   an index out of range, `other` where not offered, `other` with an empty
   comment, `answers` and `skip` together, and `answers` on a round without
   questions are all refused with nothing stored and nothing dispatched.
4. **Decision message**, `src/lib/prototypeReview/decision.test.ts` (new, beside
   the module), pure `prototypeDecisionText`: today's variants-only text byte
   for byte, the questions text of §4 as a golden string (single, multiple,
   other, recommended marks, comment with edge spaces and line breaks), the
   both-kinds text with "Chosen:", and "Chosen: none".
5. **Skip**, `http.test.ts` with a world whose `orchestrator` returns a seat and
   a recording `PrototypeDelivery`: `{skip: true, chosen: [], comment: ""}` stores
   each recommended option with `skipped: true`, and the sent text carries
   "Answers: skipped, use your recommendations." and every recommended label.
   A forged `answers` alongside `skip` is refused.
6. **Envelope bound**: a 7-question round with 300-character Cyrillic questions,
   120-character labels and a long comment is refused before storage when the
   message would pass `MAX_STRUCTURED_TEXT_BYTES`.
7. **Model and notice**, `src/lib/prototypeReview/model.test.ts`: a waiting
   questions round gives a notice and a summary with `asks: "questions"`, a
   variants round gives none, and a decided questions round gives
   `decision.answered` with an empty `chosen` list.
8. **Wire**, `src/lib/links/taskWire.test.ts` and a replica case: a v6 replica
   with questions and answers validates, and `encodeTask` for a v5 peer omits
   the replica on a task with a questions round and keeps it on one without.
9. **Window**, `src/components/prototypeReview/PrototypeReview.dom.test.tsx`:
   a questions-only round renders no variants aside and no stage. The
   recommended option is checked and carries `data-prototype-recommended`. A
   single choice moves its check and a multiple choice toggles. «Відповісти» is
   disabled until every question has an answer and every «Інше» has a comment,
   then posts `{answers, comment}` once. «Пропустити» posts `{skip: true}`. The
   answered state is read-only with the skipped line. The phone form puts the
   two buttons in one row.
10. **Needs-you row**, `src/components/attention/needsYouPanel.test.ts` (or the
    panel's DOM test) and the sheet's: a questions notice reads "Questions for
    you" / «Питання до вас» with the action "Answer" / «Відповісти». A
    variants notice keeps "Prototype ready".
11. **Mandate**, `src/lib/orchestrator/prompt.test.ts:935-940` rewritten: the
    default and a bespoke delivery each contain
    `ORCHESTRATOR_PROTOTYPE_DIRECTIVE` once. A mandate holding the v41 line
    gets the new directive once, and delivering it twice is a fixed point. A
    reworded `Prototype review:` line survives. The version is bumped and the
    fingerprint added.

## 8. Rendered evidence

Use the existing drivers only (AGENTS.md, "Rendered evidence"):

- Fixture: `src/components/kanban/issue1695Evidence.fixture.tsx`. Add a
  `?proto=questions` scenario beside `?proto=1` (`:2596-2620`), answered by the
  same `GET`/`POST /api/tasks/:id/prototypes` handler (`:2952`). It needs five
  tasks: questions only (5 questions, one multiple, one with «Інше»);
  questions plus images (3 questions, 2 variants with frames); multi-select
  heavy (every question multiple); long text (300-character questions and
  120-character labels in Ukrainian); answered (decided, one skipped round in
  history), plus the needs-you panel open on the questions notice.
- Desktop at 1440: a `describe` block in
  `src/components/kanban/kanbanBoard.browser.test.tsx` beside `:21843`. Phone
  at 390: a block in `src/components/mobile/issue1671Evidence.browser.test.tsx`
  beside `:8376`. Both run en and uk, light and dark.
- Measured and recorded in `evidence/prototype-review/questions.json` and
  `evidence/prototype-review-phone/questions.json`: no horizontal overflow in
  the dialog or sheet; every option row at least 44 px on the phone; the
  recommended pill whole and unclipped beside a 120-character label; the two
  footer buttons visible with the keyboard closed; the third desktop column
  at 360 px with the stage at least 560 px; the needs-you row text.
- From a stage, point Chrome at a short `TMPDIR` link (socket path limit), run
  the drivers through `scripts/gate-slot.sh`, and close every browser by the
  PID it was started with.

## 9. Options weighed

- **Where questions live.** On the round (chosen) or as a separate
  questionnaire record. A separate record needs its own route, notice kind and
  window state, and answer 1а rules that out. On the round it inherits
  publication, replay, fences, history, supersession, delivery and the notice.
- **What an answer stores.** Option indexes (chosen) or labels or option ids.
  The round is immutable, so indexes are stable, and agents declare no option
  ids.
- **«Інше».** A per-question text field, or one choice that points at the
  shared field (chosen). The operator asked for one shared field. A second
  field type is a new control family.
- **Questions beside images on desktop.** A third column (chosen), the variants
  aside, or a strip above the footer. The 264 px aside is too narrow for
  options with labels and pills. A strip above the footer squeezes the stage
  vertically and moves the footer while answering. The column keeps both still.
- **Where the mandate line sits.** Extending the delivered `Prototype review:`
  directive (chosen) reaches bespoke and stale seats at their next delivery.
  A body-only paragraph would reach only seats rotated onto the new version.
  The price is 204 bytes of appended text, covered in §5.2.

## 10. Checked against the requirement

- «опросник, где кликаешь на кнопочки … 5-7 вопросов … с вариантами ответов …
  мультиселект плюс одно общее поле»: §2.1 (3–7 questions, 2–6 options,
  `multiple`), §3.1 (tappable options), §3.2 and §3.3 (one shared field, one
  «Відповісти»).
- «ничего не менять, просто немножко подправить дизайн прототипов»: §3 adds a
  block and one column inside the same window and reuses its parts. No new
  window, menu entry or control family.
- «можно было пропустить эту фазу»: «Пропустити» in the window (§2.3, §3.2), and
  the mandate makes the questionnaire conditional and skippable (§5.1).
- «shared understanding — это самое главное»: answer 4а, «як я зрозумів» in the
  task text before starting (§5.1), and the decision message carries every
  question with its answer verbatim (§4).
- Outcome 5: §6.

## Deferred — not currently justified

- A per-question free-text field. The operator asked for one shared field.
- A «grill me» button or menu entry. The operator asks in chat, and the
  mandate covers "on request".
- Pipeline stages sending questionnaires in place of `needs_decision`. The
  requirement names the orchestrator. Stages can publish questions already
  (the tool is shared), and nothing routes their answers to the stage.
- A close guard for answers changed from the recommendation. Today's guard
  protects typed text, and five clicks are cheap to redo.
- Showing «як я зрозумів» inside the window. It belongs on the task, where the
  operator reads the card.
- Digit or letter shortcuts for options. The window's digits already choose
  variants.
- A second round of questions as a follow-up flow. A new round on the same task
  already supersedes the old one.
- Publishing visual variants of this design for the operator to choose from.
  The operator's four answers already fixed the structure. The one open layout
  choice (§9, the third column) follows from the window's own measurements,
  and a review would put a second gate in front of work the operator asked to
  start.


## Implementation verification

The implementation extends the existing round, operator decision and delivery receipt.
Questionnaire answers are canonicalized in question order and option-index order;
skip derives the answers on the server. Images remain optional context. The
variants-only decision message is pinned byte for byte by a golden test.

Failing-first checks observed the absent questionnaire schema and publication,
missing decision formatter, unmarked summaries, v5 wire version, missing window
controls, old notice text and old mandate directive before their implementations.
The focused checks also cover malformed answers, shared Other text, skip replay,
message-size refusal before storage, and the production runtime delivery after reload.

The mandate at version 42 measures 29 361 delivered bytes, with 39 bytes inside
its 29 400-byte ceiling. The rotation-history margin is 33 bytes. Delivery adds
15 027 bytes to an empty mandate, inside the deliberate 15 100-byte directive
budget. Existing fingerprints remain intact, and delivering a shipped old pointer
twice is a fixed point.

Rendered evidence uses the existing board and phone drivers, at 1440 and 390,
in English and Ukrainian, light and dark. Each matrix covers questions only,
questions with images, multi-select, maximum question and option text, answered
and skipped states, and the needs-you row. Measurements are in
`evidence/prototype-review/questions.json` and
`evidence/prototype-review-phone/questions.json`; screenshots are local artifacts
under `.artifacts/prototype-review/questions` and
`.artifacts/prototype-review-phone/questions`. The drivers record their browser
PID and close the browser they started.

The focused schema, HTTP, decision, model, wire, window, attention, mandate,
rotation, localization, media-fence, task-sync and MCP receipt checks pass in
isolated state. The real runtime delivery integration passes. Type checking
passes; the repository's lint comparison introduces zero errors and reports
four existing errors in the phone board on the merge base. The local privacy
gate passes. Publication runs the repository's hooks as well.
