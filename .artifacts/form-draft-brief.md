# Brief: the decision form keeps what the operator typed

Read-only brief for the frontend builder of lane 94e88098. Made from commit
7367fd9f3 (origin/main at the lane's start). Open PRs #3023, #3024, #3027 and
#2985 were read on 2026-10-17. Line numbers below are at 7367fd9f3.

## Originating requirement (agent-only: never copy, translate or excerpt into a published file, PR body or commit)

Operator decision, 2026-10-17 13:06Z, form «Форма, яку не можна відповісти
після закриття задачі», chosen option, verbatim:

> Так, лінія зараз: форма лишається доступною, текст не губиться, 2 раунди рев'ю

The form's question, verbatim: «Обслуговування дошки закрило задачу, на якій
висіла форма, і твоя відповідь не збереглась («prototype review is
unavailable»), а набраний текст зник. Лагодимо?»

A later answer from the same operator (13:07Z, form «Після фіксу індексу:
чернетка форми, …», question 1) asks for the same draft: «Так, мала UI-лінія
після фіксу індексу, 1 раунд рев'ю». Both answers agree on the scope: keep the
typed text as a draft so nothing is lost on an error or a page reload. They
disagree on review rounds (2 or 1). The pinned spec says 2, and settling that is
the seat's job. It does not change this brief.

Pinned acceptance, in short: selections, free text and comment survive a
failed save (any non-2xx or network error), a page reload, and closing then
reopening the form. The error shows in place and retry sends the same answer.
The draft is kept per review id in this browser, cleared once saved, never
applied to another round, and bounded. Optimistic UI stays as it is, except that
rollback never erases text. Add DOM tests and a case in the existing driver at
desktop and 390 px.

## 1. Where the form renders

There are two components. They share one question block, `DecisionQuestions`
(`src/components/prototypeReview/DecisionQuestions.tsx`), which takes answers
as props and holds no state. Do not change it: #2985 edits it.

### A. The review window: `PrototypeReview` (`src/components/prototypeReview/PrototypeReview.tsx`)

- Mounted only by `PrototypeReviewHost` (`PrototypeReviewHost.tsx:43`) with
  `key={target.taskId}`. The host is mounted once, in `Viewer.tsx:1923`.
- Desktop: a portal dialog (`PrototypeReview.tsx:711-760`). Phone (`useIsMobile`):
  a `MobileSheet` (`:683-708`). It is the same component and the same draft
  code at 390 px.
- Entry points, all through `openPrototypeReview(...)`: a kanban card's
  `CardPrototypeButton` (`KanbanCard.tsx:28`); the phone task screen's
  `PhonePrototypeRow` (`MobileTaskScreen.tsx:26`) and the phone card
  (`MobileKanban.tsx:40,1221`); the board's form subject (`KanbanBoard.tsx:2207`);
  the seat notice chip (`PrototypeNoticeRow.tsx:23`, mounted in
  `OrchestratorPanel.tsx` and `MobileSeatCard.tsx`); the Viewer's notices
  (`Viewer.tsx:1405,1408`); the URL deep link
  `?prototypeTask=…&prototypeReview=pr_<32 hex>` (`PrototypeReviewHost.tsx:32-38`).
  The deep link also reopens the review after a reload. A task card's
  thumbnails in the «Рішення» column open this window too (`DecisionCard.tsx:51`).
- The draft today is `useState<Record<reviewId, Draft>>` (`:138`).
  `Draft = { reject, chosen, comment, answers }` (`:41`), with
  `initialDraft(round)` set to the recommended answers (`:42`). It is written by
  `setDraft` (`:178`), `toggle` (`:182`), `selectAnswer` (`:561`), the comment
  `onChange` (`:619`), reject (`:601`) and dictation `insertSpoken` (`:197`).
  There is also an in-memory handoff, `refusedSaves` (`:46`), used only when a
  refusal arrives after the window has unmounted (`:344-345`). It is read once
  at mount (`:138-140`).

### B. The «Рішення» card: `DecisionCard` (`src/components/decisions/DecisionCard.tsx:121`)

- Rendered by `DecisionList` (`DecisionColumn.tsx:36`, `:90`) for the one
  expanded open decision. The other decisions are `DecisionRow` (`:91`), and an
  answered one is `DecisionRecord` (no form).
- `DecisionList` is mounted in three places: the desktop seat column
  `DecisionColumn` (`DecisionColumn.tsx:142`, used by `OrchestratorPanel.tsx:71`);
  the desktop dialog `DecisionDialog` (`DecisionSheet.tsx:74`); and the phone
  sheet with `touch` (`DecisionSheet.tsx:42`), which opens from
  `MobileFocusView.tsx:693` and `openOperatorDecisions`.
- It lists seat rounds (`taskId: null`) and each task's waiting round
  (`src/lib/prototypeReview/read.ts:114-129`). A task round with questions can
  therefore be answered from both the card and the window.
- The draft today is three `useState`s (`DecisionCard.tsx:136-138`): `answers`,
  `comment`, `reject`. They are seeded from the module map
  `drafts` (`useOperatorDecisions.ts:21`), and that map is written **only when
  the operator presses Answer** (`:80`) and deleted on 2xx (`:92`). The card
  always sends `chosen: []` (`DecisionCard.tsx:158`).

### Not a form

`DecisionPointer` in the feed (`FeedItem.tsx:357`) and `DecisionRecord` render
answered records only. They need no change.

## 2. How saving works today

### Window: `usePrototypeReview.write` (`src/hooks/usePrototypeReview.ts:89-112`)

1. It stores `before`, then sets the snapshot to `optimisticPrototypeRead`
   (`:44-60`): the round reads as decided at once and the textarea unmounts.
2. It POSTs `/api/tasks/:id/prototypes`. On a non-2xx or a throw it restores
   `data: before` with `error: message` (`:107-110`), and the banner
   `[data-prototype-error]` shows it in place (`PrototypeReview.tsx:359-363`).
3. `drafts` state is never touched by `write`. The component deletes its own
   draft only on `result.ok` (`PrototypeReview.tsx:346-347`), so **a failed save
   already keeps the text while the page lives**. This is tested at
   `PrototypeReview.dom.test.tsx:838` and `:896`.
4. Polls are skipped while a write is in flight (`writing.current`, `:71`).
5. Generic failure text: `prototypeFailure` in `src/lib/prototypeReview/http.ts`
   returns 503 "prototype review is unavailable". That file is fenced (#3027,
   #3023). Do not touch it.

### Card: `useOperatorDecisions.answer` (`src/components/decisions/useOperatorDecisions.ts:75-104`)

1. It writes `drafts.set(reviewId, body)` and adds the id to `answering`. The card
   leaves the list, so it unmounts.
2. It POSTs `/api/projects/decisions`. On failure it sets `error` and removes the
   id from `answering`. The card remounts and seeds from `drafts`, and the error
   shows as `[data-decision-error]` (`DecisionCard.tsx:220`). This is tested at
   `DecisionColumn.dom.test.tsx:75,149,175-209`.

### Is a retry idempotent?

`decidePrototype` (`src/lib/prototypeReview/decision.ts:276-282`) returns
`false` when the same operator sends the same answer to a round already
decided. So retrying after a refusal that had actually saved (an error reply is
no proof, working rule 15) cannot create a second revision.

## 3. Where text is lost today (the gaps to close)

| # | Surface | Path | Today |
|---|---------|------|-------|
| G1 | window, card | page reload, crash, tab closed | all drafts and `refusedSaves` live in JS memory, so all of it is lost |
| G2 | window | another review opens over it (a notice, a card button) | `PrototypeReviewHost` sets a new target with no guard, and `key=taskId` remounts, so the typed text is lost (only an in-flight refused save survives via `refusedSaves`) |
| G3 | window | the round leaves the read (task closed, read refused) | the draft stays in state but nothing shows it; it dies with the window |
| G4 | card | typing, then opening another row (`DecisionRow.onOpen`), switching to «Звіти», closing the sheet or dialog, folding the seat | card state unmounts and `drafts` is written only on press, so the text is lost with **no guard at all** |
| G5 | card, window | same task round in both surfaces | two separate drafts, so the text typed in one is missing in the other |

Kept as is: the window's close guard (`requestClose`, `PrototypeReview.tsx:238`).
«Discard» (`data-prototype-guard-discard`) is the operator's explicit choice to
drop the text, and `PrototypeReview.dom.test.tsx:896` (end) asserts that
"a discard and a reopen start clean". This follows `useTaskDraft`
(`src/hooks/useTaskDraft.ts:67-69`): "Esc/close keeps the draft; an explicit
discard clears it."

## 4. Where the draft key and storage should live

**One new client module: `src/components/prototypeReview/decisionDrafts.ts`.**
Both surfaces import it. It replaces both the `refusedSaves` map
(`PrototypeReview.tsx:46`) and the `drafts` map with its `decisionDraft()` and
`resetDecisionDraftsForTests()` (`useOperatorDecisions.ts:21-28`). That leaves
one draft mechanism instead of three. Model it on the existing page-wide store
`prototypeReviewStore.ts`: `useSyncExternalStore`, try/catch on storage, and a
`…ForTests` reset.

- **Storage:** `localStorage`, one key per round:
  `llv.prototypeReview.draft:<reviewId>`. The prefix follows `SEEN_KEY`
  (`prototypeReviewStore.ts:19`), and one key per item follows `useTaskDraft`
  and `QuestionCard`. A keystroke rewrites only its own round's entry, never the
  whole set (a comment can be 20 000 characters, `input.ts:10`).
- **Entry:** `{ v: 1, reviewId, taskId: string | null, project, reject, chosen, comment, answers, updatedAt }`.
  `taskId` and `project` exist only for pruning (below).
- **Write:** synchronously on every draft change, through the existing
  `setDraft` in the window and the three setters in the card. Write only a
  draft that differs from `initialDraft(round)`. Writing an untouched draft
  removes the key, so an opened-and-left round stores nothing. On quota or
  disabled storage, keep it in a module-level memory map: today's page-life
  behaviour stays as the floor.
- **Read and apply:** the window reads `drafts[roundId] ?? stored(roundId) ?? initialDraft(round)`,
  and the card's initial state reads the same. Sharing the snapshot through
  `useSyncExternalStore` closes G5: a card under the window sees the window's
  text. Never apply a stored draft to a round that does not match:
  - the key is the review id, so another round never reads it;
  - drop stored `answers` (fall back to recommended) unless every `questionId`
    matches the round's questions in order and every option index is in range;
  - filter `chosen` to the round's variant numbers;
  - keep `reject` only when the round has variants;
  - never show a stored draft for a round whose read carries a `decision`. The
    window already renders `round.decision` over the draft (`:404`, `:570`).
- **Card `chosen`:** the card edits no variant choice. It should send the
  stored `chosen` back unchanged (`DecisionCard.tsx:158`) instead of `[]`, so a
  choice made in the window and finished in the card reaches the server.
  (Recommended. The alternative keeps `[]` and silently drops the window's choice.)

### Clearing and bounds (acceptance 2)

1. **Saved:** delete the entry on a 2xx: in the window where it deletes today
   (`PrototypeReview.tsx:346-347`), and in `answer` where `drafts.delete` sits
   (`useOperatorDecisions.ts:92`). Never delete at press time. During an
   in-flight save, and after its rollback, the entry stays as typed
   (acceptance 3).
2. **Decided:** a successful **server** read (never the
   `optimisticPrototypeRead` snapshot) showing `round.decision` for a stored
   id deletes it. This covers answers made elsewhere (Telegram, another tab).
3. **Gone, task rounds:** a successful task read (`response.ok`, not
   `historyTruncated`, not `unavailable`) drops stored entries whose `taskId`
   equals that task and whose id is not among `rounds`.
4. **Gone, seat rounds:** a successful `GET /api/projects/decisions` drops
   stored entries with `taskId === null` for that project that are absent from
   `decisions`. That list holds every undecided seat round of the project
   (`read.ts:125-127`). Compare canonical project keys (`read.project` is
   canonical). Do **not** prune task rounds by absence from this list: it shows
   only each task's single waiting round (`read.ts:122`).
5. **A failed read never prunes.** This is the incident: the task was closed and
   reads failed with 503, and the text must survive exactly then.
6. **Cap:** at most 20 entries. When writing a new key, drop the entries with the
   oldest `updatedAt` beyond 20, and drop entries older than 30 days. Scan the
   `llv.prototypeReview.draft:` prefix once per page load and on new-key writes,
   never per keystroke. Worst case is 20 × 20 000 characters, about 0.8 MB
   in UTF-16.
7. **Guard «Discard»** deletes the stored entries of the rounds the guard
   counted (`unsavedOf`, `PrototypeReview.tsx:48`), then closes.

The refusal **message** (`refused`, `PrototypeReview.tsx:139`) stays in memory
only. After a reload the restored text is enough, and adding a "last save
failed" notice would be unrequested UI.

## 5. States to cover

For each surface (window desktop, window 390 px, card in the desktop column,
card in the phone sheet):

1. **Typing:** choice, questions, «Інше», reject and comment are written to the
   store as they change. Dictation's `insertSpoken` and live commit land in the
   draft too, because they already go through `setDraft` (window) and
   `setComment` (card).
2. **Failed save (409, 503, network throw):** the error shows in place
   (`[data-prototype-error]` / `[data-decision-error]`). Every field stays as
   typed, and the stored entry is unchanged.
3. **Retry:** the second press sends a body equal to the first (deep equal).
4. **Reload:** with the window deep-linked or the card's column reopened, the
   draft is restored with the same choice, answers, reject and exact comment
   (edge spaces and line breaks kept, as `PrototypeReview.dom.test.tsx:149`
   requires for saves).
5. **Close and reopen:** G2 (another review replaces the window) and G4 (the
   card collapses, the tab switches, the sheet closes) both bring the text back.
6. **Saved:** the entry is gone, and reopening shows the decision record.
7. **Decided elsewhere:** a server read with a decision drops the entry.
8. **Other round:** the draft of round A never appears in round B (two rounds
   of one task, and a seat round beside a task round).

## 6. Tests to extend (acceptance 4)

**Shared-id leak:** nearly every case in `PrototypeReview.dom.test.tsx` uses
review `pr_a…a` / `task-1`, and `DecisionColumn.dom.test.tsx` reuses `SEAT` /
`TASK`. Once drafts persist, one case's text reaches the next unless storage is
cleared.
- `PrototypeReview.dom.test.tsx:70-78` `afterEach`: add the new store's reset,
  which clears storage and memory. It currently resets nothing of the sort.
- `DecisionColumn.dom.test.tsx:56-63`: replace `resetDecisionDraftsForTests()`
  with the new reset.

**`PrototypeReview.dom.test.tsx`**, in `describe("a saved decision answers at once")` (`:776`):
- extend `:838` (refusal reopens the round): press Save again and assert
  `posted[1]` equals `posted[0]`; assert the stored entry still holds the text.
- new: **reload restores the draft.** Mount, choose, type, unmount the root,
  drop module memory but keep `localStorage` (a test hook that leaves storage
  alone), mount again, and the field and choice are restored. The test must fail
  if the draft is kept only in memory.
- new: **successful save clears the draft.** After the `hostServer("commit")`
  flow (`:945`), the storage key is absent and a remount of an undecided read
  starts clean.
- new: **not applied to another round.** With `twoRoundServer` (`:968`), type
  in the later round, open the earlier one, and its field is empty. A stored
  entry whose question ids do not match the round falls back to recommended answers.
- new: **G2.** With `hostServer`, type in task-1 (no save), call
  `openReview("task-2")`, reopen task-1, and the text is there.
- keep `:896`'s closing assertion (discard, reopen, clean) green.

**`DecisionColumn.dom.test.tsx`:**
- extend `:175-209` (refusal after the form left): add a remount with module
  memory dropped after the refusal, and the form comes back from storage.
- new: **G4.** Type in the open card without pressing, open the other
  `DecisionRow`, open the first again, and the text and choices are kept.
- new: a successful answer removes the storage key.

**New `src/components/prototypeReview/decisionDrafts.test.ts`** (pure store, no
DOM): cap of 20 by `updatedAt`, 30-day expiry, corrupt JSON ignored,
`setItem` throwing falls back to memory, `v` mismatch ignored, an untouched
draft removes its key.

## 7. Rendered evidence (acceptance 5): one case in the existing kanban driver

Do not write a new driver (AGENTS.md «Rendered evidence»).

- **File:** `src/components/kanban/kanbanBoard.browser.test.tsx`. Add one
  `describe` **directly after** `describe("prototype Telegram resend")`, which
  ends at `:720`, and model it on that block (`:629-720`). It already opens the
  task window by deep link at 1440×900, 1000×700 and 390×844 (phone flag),
  types into `[data-prototype-comment-field]`, then opens the seat form
  (`[data-decision-card="open"]`) at each width. Do **not** append at the end of
  the file: #3024 appends a `describe` there (`@@ -33403`).
- **Fixture:** `src/components/kanban/issue1695Evidence.fixture.tsx`. Add a
  refusal hook beside `protoHoldSave` (`:3417-3431`), for example a URL flag
  `&protoRefuse=1` and `window.protoAcceptSaves()`. Both POST handlers then
  answer `503 { error: "prototype review is unavailable" }` until accepted:
  `/api/tasks/:id/prototypes` (`:3917-3933`) and `/api/projects/decisions`
  (`:3894-3905`). A URL flag survives `page.reload()`. Fixture rounds reset on
  reload, so the round is undecided again, which the reload frame needs.
  #3024, #3017 and #2962 touch this fixture elsewhere (`:130`, `:2542`,
  `:3873`). Keep your hunks to these regions.
- **Deep links:** `PrototypeReviewHost` accepts only `pr_<32 hex>` ids. Use
  `proto=telegram`, which renames the search round to `pr_e…e`, or give your
  rounds `pr_` ids. `proto=questions` ids (`r-questions-…`) will not open by URL.
- **Frames per surface:** after the refused save (text kept plus the in-place
  error), after `page.reload()` (draft restored), after the accepted retry
  (decided). Shoot the task window and the seat form at 1440, 1000 and 390, in
  uk and en, light and dark. Read the readings from the DOM: field value equals
  the typed text, the error element is visible, and the comment and error text
  ranges are inside the viewport and not cut by the sheet footer. Write the
  readings to a new `evidence/decision-form-draft/readings.json` and the frames
  to `.artifacts/decision-form-draft/`. Do not commit media
  (memory: PR frames need no tree media).
- **Run** in isolated state with a short Chrome TMPDIR and the control URL on a
  closed port, through `scripts/gate-slot.sh` (a reviewer scope can be 4 GiB):
  `LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=… bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "<your describe>"`.

## 8. Checks (acceptance 6)

Run each by path, through
`bash <release>/scripts/gate-slot.sh bun test <file>` with private `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR`, `LLV_STATE_DIR` under the stage scratch and
`LLV_VIEWER_CONTROL_URL` on a closed port:
`src/components/prototypeReview/PrototypeReview.dom.test.tsx`,
`src/components/decisions/DecisionColumn.dom.test.tsx`,
`src/components/prototypeReview/decisionDrafts.test.ts`,
`src/components/prototypeReview/prototypeReviewStore.test.ts`, plus the driver
case. Typecheck the touched files (`bunx tsc --noEmit -p .`) and lint the
changed files. Pre-push runs the touched-tests gate. Never sweep whole
directories against live state.

## 9. What not to touch (fences)

- `src/lib/prototypeReview/decision.ts`, `http.ts`, `deliveryWorker.ts`,
  `types.ts`: #3023 (3d1522a9). `http.ts` and `src/lib/state/sqliteStateStore.ts`:
  #3027 (f5d94818). No server change is needed. Persistence is client-only, and
  the server's same-answer idempotence (§2) already makes retry safe. Do not
  change the 503 fallback text.
- Overlay layering: #3024 (685e2bb2) changes `src/components/layers.ts`,
  `modalLayer.ts`, `src/hooks/useOverlayEscape.ts`, `ArtifactPreviewHost.tsx`,
  `RuntimePill.tsx` and the conversation window's overlays. `PrototypeReview`
  uses `useModalLayer` and `useOverlayEscape`. Call them as they are and do not
  edit them or the `Z` scale.
- `DecisionQuestions.tsx`: #2985 edits it. It needs no change here.
- `usePrototypeReview.ts`: do not change the optimistic read
  (`optimisticPrototypeRead`) or the rollback. If the window's server reads
  prune drafts, call the store from the read's success path (`:77`) and never
  from `write`'s optimistic `setSnapshot` (`:94-97`).
- Out of scope per spec: carrying a waiting form to a successor task.

## 10. Notes

- Nothing in the transcripts or memory showed which surface lost the text in the
  incident. Both surfaces keep text after a refusal within one page life (tested
  above), so the likely losses are G1 (reload) or G3/G4 after the task closed.
  The design closes all of G1–G5. Nothing depends on knowing which one happened.
- No hot-path concern: this is client-only. A keystroke writes one key, and
  pruning runs on reads the window and column already make (every 2 s and 3 s),
  with no extra request.

## Deferred — not currently justified

- Cross-tab live sync through the `storage` event: neither answer asks for it.
  Reload in the other tab restores the draft.
- Persisting the refusal message across reload: unrequested UI (§4).
- A close guard for the «Рішення» card: persistence makes the guard
  unnecessary, so adding chrome is not justified.
- Server-side drafts: the spec says local to the browser.
