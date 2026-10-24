# Lane diff comments: review a lane's changed files and send line comments to its agent

## Originating requirement

Operator decision, 2026-10-23 (decision form on the competitor research), quoted
from the pinned task:

> Take rank 1 first. Source and scope: docs/research/competitors-2026-10.md,
> rank 1 «First slice»: open a bounded changed-file list for one pipeline, pin
> base/head SHAs, add line/side comments, and send one explicit feedback
> message to the responsible agent (the lane's current/last producer stage
> conversation). If the head changes, ask for re-anchoring and retain the
> draft. Reuse current delivery receipts (send_message path) and the existing
> DiffCard rendering (src/components/feed/cards/DiffCard.tsx). No new board
> chrome beyond an entry from the pipeline/PR card; desktop first, phone shows
> the list read-only (or says not supported) — decide in the brief.

The acceptance asks for this brief first, then an implementation with tests
(comment anchoring, stale head, message composition, and authority, meaning
only the operator sends) and rendered evidence from the existing drivers.

The research row it comes from is `docs/research/competitors-2026-10.md:108`.

## Decisions in one place

| Question | Decision |
| --- | --- |
| Where the list comes from | A new read in `src/lib/pipelines/laneChanges.ts`: `git diff --numstat` and `--name-status` between a pinned base and head, run in the lane's `repoDir`. It follows the merge-base rule that `publicationChangedPaths` already uses (`src/lib/pipelines/git.ts:1640-1647`). |
| Base / head | Head is `refs/heads/<branch>`, or `lastPassedCommit` once the branch is gone. Base is `merge-base(head, refs/remotes/origin/<baseBranch>)`, or `baseRef` when no merge base exists. Both are full SHAs, returned once and carried on every later read and on the send. |
| Comment model | `{ path, side: "old" \| "new", line \| null, quote, body }`, anchored to the draft's head. |
| Target agent | The latest non-historical attempt with write access and a conversation. This is the producer rule from `stagePullRequestProducer` (`src/lib/pipelines/stagePullRequest.ts:23-27`), resolved on the server. |
| Delivery | A new operator-only route composes the text on the server and calls `conversationHostPOST` in-process with the person as actor. This is the path the prototype decision form uses (`src/lib/prototypeReview/decision.ts:173-176`), the same one `send_message` reaches (`src/lib/mcp/bindings.ts:1838`). Receipts and retries go through the existing `/api/runtime/operations/[operationId]` (`src/lib/runtime/http.ts:552`, `:754`). |
| Entry | One item, «Review changes», in the lane group of the card's ⋯ menu (`src/components/kanban/KanbanBoard.tsx:1687`), plus one row in the phone lane ⋯ sheet (`src/components/mobile/MobilePipelineScreen.tsx:520`). |
| Desktop | A full sheet in the stages sheet's frame (`gsheet-scrim` / `gsheet`, `src/components/kanban/StagesSheet.tsx:190-215`) with a file list, the file's diff, and comments under their lines. |
| Phone (< 640 px, `src/lib/attention/eligibility.ts:25`) | **Read-only list.** The phone shows files, base→head and each file's diff in the existing `DiffCard`. It has no comment controls and says in one line that comments are written on a computer. |
| Draft storage | Browser `localStorage`, one key per lane. It survives reloads and head moves on that browser. |

## 1. Where the changed-file list comes from

No route lists a lane's changed files today. The only computation is the private
`publicationChangedPaths` (`src/lib/pipelines/git.ts:1640-1647`). It takes
`merge-base` with `refs/remotes/origin/<baseBranch>` and runs
`git diff --no-renames --name-only -z`, and publication uses only its count
(`git.ts:1975`). `pipelineWorktreeChanges` (`git.ts:983-997`) lists
**uncommitted** paths in the checkout.

New module `src/lib/pipelines/laneChanges.ts`. It leaves `git.ts` unchanged and
copies the merge-base rule in eight lines. It has two functions, each taking an
`ExecPort` (`src/lib/workflows/provision.ts:43`, production `realExec` at
`:47`, async):

- `laneChangeSummary(pipeline, exec)` returns
  `{ base, head, baseSource: "merge-base" | "base-ref", headSource: "branch" | "last-passed", files, total, truncated, uncommitted }`.
  - head: `git rev-parse --verify --end-of-options refs/heads/<branch>^{commit}`,
    run in `pipeline.repoDir` because worktrees share refs and the worktree may
    have been swept. If that fails, use `pipeline.lastPassedCommit`
    (`src/lib/pipelines/types.ts:1125`).
  - base: `git merge-base <head> refs/remotes/origin/<baseBranch>`. If that
    fails, use `pipeline.baseRef` (`types.ts:1122`).
  - files: `git diff --no-ext-diff --no-textconv --no-renames --numstat -z`
    and `--name-status -z` over `<base> <head>`, joined by path. `op` is
    `add | update | delete`, since a rename shows as a delete plus an add.
    `binary` is true when numstat prints `-  -`. The list is cut at
    **200 files**: `total` keeps the real count, `truncated` is set, and the UI
    says how many are not listed.
  - uncommitted: the count from `pipelineWorktreeChanges` when the worktree
    still exists, else 0. The UI says that those files are not in the list,
    since a running stage commits only at its end.
- `laneFileDiff(pipeline, base, head, path, exec)` returns one `FileDiff`. It
  refuses unless `path` is in the `--name-only` list for exactly that pair,
  then runs `git --literal-pathspecs diff --no-ext-diff --no-textconv --no-renames -U3 <base> <head> -- <path>`.
  The output goes through a new export in `src/components/feed/diff.ts`,
  `diffFromGitFilePatch(path, op, patch, caps)`. It is the parse loop of
  `diffFromCodexFileChange` (`diff.ts:396-443`) fed into the existing
  `finalizeFile` (`diff.ts:206`), so redaction and caps stay in one funnel.
  The caps are `REVIEW_DIFF_CAPS = { files: 1, hunksPerFile: 200, linesPerFile: 2000, charsPerLine: 2000, totalChars: 256000 }`.

Both calls run under `withViewerOperation("pipelines.laneChanges", …)` so the
loop monitor can name them, with a 10 s timeout per git call. There is no
cache, since each read happens only when the operator opens the sheet.

**Bounds from real data.** These are the last 300 commits on `main`, each a
squashed lane, at revision `bf1c0024`: files per lane p50 10, p90 41, p99 110,
max 1,435. The largest single file diff in a lane is p50 209, p90 1,095 and
p99 17,109 lines. So 200 files covers more than the 99th percentile, and
2,000 lines per file covers more than the 90th. Beyond 2,000 lines the file
shows its first rows and a «cut» line, and a file-level comment still works.

**Measured cost** (this machine, 24 cores, load average about 34; same
repository; `merge-base` plus both `diff` calls; three runs each): 11 files
36 ms, 25 files 40 ms, and a 2,817-file range 956–1,124 ms. One file's `-U3`
diff took 14 ms.

### Routes

The routes sit beside `src/app/api/pipelines/[id]/route.ts`:

- `GET /api/pipelines/[id]/changes` returns the summary plus `target` (§4).
- `GET /api/pipelines/[id]/changes?base=<sha>&head=<sha>` returns that pair's
  file list, so a draft whose branch moved still shows the files its comments
  were written on.
- `GET /api/pipelines/[id]/changes?base=<sha>&head=<sha>&path=<path>` returns
  one `FileDiff`. Every request names its pair, so a review stays on one
  revision pair while the branch moves. A non-40-hex SHA is 400; a path outside
  the pair's list is 404 `path_not_changed`.
- `POST /api/pipelines/[id]/review` sends the review (§5).

All three call `rejectCrossOrigin` and allow only a person (§5, authority).
Open PR #3255 wraps the human pipeline routes in `workspaceRoute(...)`. Whichever
change lands second wraps these routes the same way.

## 2. How base and head are pinned

- `GET …/changes` resolves `{ base, head }` once. The draft stores both, and
  every file read and the send carry them explicitly.
- The UI checks for a stale head when the sheet opens and when the window
  regains focus, by calling `GET …/changes` again and comparing `head`. There
  is no polling.
- **The server decides at send time.** `POST …/review` resolves the head
  again. If it differs from the draft's `head`, the answer is
  `409 { code: "head_moved", base, head }` and nothing is delivered. The
  remaining race (the branch moves after this check but before the agent reads
  the message) is covered by the message itself, which names both full SHAs
  (§5).
- If the base moves while the head stays (`origin/<baseBranch>` advanced but
  the merge base did not), nothing changes. If the merge base moves (main was
  merged into the lane), the head moved too, so the same 409 applies.

## 3. Comment model

Pure module `src/lib/laneReview/model.ts`, shared by the client and the server:

```ts
type LaneReviewSide = "old" | "new";          // old = file at base, new = file at head
type LaneReviewComment = {
  id: string;                                   // client uuid
  path: string;
  side: LaneReviewSide;
  line: number | null;                          // 1-based in that side's file; null = file-level
  quote: string;                                // the row's text as shown (already redacted), ≤ 200 chars
  body: string;                                 // ≤ 4,000 chars, trimmed, non-empty
  state: "anchored" | "moved" | "detached";
};
type LaneReviewDraft = {
  v: 1; pipelineId: string; draftId: string;    // draftId: uuid, renewed after a send
  base: string; head: string;                   // full SHAs the comments refer to
  targetConversationId: string | null;          // as shown when the draft was last saved
  note: string;                                 // overall note, ≤ 4,000 chars, optional
  comments: LaneReviewComment[];                // ≤ 100
  sent?: { operationId: string; clientMessageId: string; head: string; at: string; stageName: string };
  updatedAt: string;
};
```

- **Line numbers** come from the hunk header that `finalizeFile` keeps
  (`-25,7 +25,7 @@ …`, the git shape checked on this revision). The function
  `numberRows(hunks)` gives each row `{ old?: number; new?: number }`.
  A `-` row has only `old`, a `+` row has only `new`, and a context row has
  both. A comment on a context row anchors to `new`, the GitHub default. A row
  that `finalizeFile` dropped under a cap can take no line comment.
- **Re-anchoring** is `reanchor(comments, newDiffs)`, pure. It runs only when
  the operator presses «Re-anchor» (§6). For each comment with a line, it
  searches the new diff of the same path on the same side for rows whose text
  equals `quote`. One match keeps the comment as `anchored` (same line) or
  marks it `moved`. Several matches pick the one nearest the old line. None, or
  a path gone from the list, makes it `detached`: its line becomes null and it
  turns into a file-level comment that keeps its quote. File-level comments
  stay as they are while their path is still in the list, and become detached
  otherwise. Nothing is ever deleted automatically.
- **Storage:** `localStorage["delegatus.laneReview.v1.<pipelineId>"]`, written
  on each edit and read on open. If storage refuses the write (full or
  private mode), the sheet says the draft is not saved on this device, and the
  comments stay in memory until the sheet closes.

## 4. Who receives it

`laneReviewTarget(pipeline)` lives in `laneChanges.ts`. Among
`pipeline.runs[].attempts`, it takes the attempts with no `historical` flag,
`effectiveRole.access !== "read-only"` and a non-null `conversationId`, and
picks the newest by `startedAt`. That is the running writer if one exists,
otherwise the last one. It returns
`{ conversationId, stageId, attempt, stageName, engine }`, or null.

`stagePullRequestProducer` also requires a report or output. That condition is
dropped here, because a writer that is still running is exactly the agent to
tell. With no target, the sheet still shows the diff and the Send button is
disabled with its reason. The client sends the `conversationId` it showed. If
the server resolves another one, it answers
`409 { code: "target_changed", target }`, the sheet shows the new stage name,
and the operator presses Send again.

Note: the sheet allows sending in every lane state where the composer could
message that conversation. A message to a finished writer resumes it, as the
composer's does today; this slice adds no new lane transition.

## 5. Message format and the delivery path

### Route `POST /api/pipelines/[id]/review`

The request body is
`{ draftId, base, head, conversationId, locale: "en" | "uk", note, comments: [{ path, side, line, quote, body }] }`.

The route runs these steps in order, and each refusal delivers nothing:

1. `rejectCrossOrigin`. Authority: `teamActor(req)` (`src/lib/team/actor.ts:62`)
   must be `operator` or an active `member`. An `agent` (a conversation
   capability), a `service` (`internalServiceClaim`) or `anonymous` gets
   `403 { code: "operator_only" }`. No MCP tool reaches this route.
2. Validate the shape: at most 100 comments, each body 1–4,000 chars, a quote
   of at most 200 chars, `line` a positive integer or null, `side` from the
   enum. A draft with no comments and no note is `422 { code: "empty_review" }`.
3. Head check (§2), returning `409 head_moved`.
4. Every comment `path` must be in the list for `base..head`, else
   `400 { code: "path_not_changed", field }`.
5. Target check (§4), returning `409 target_changed`.
6. Compose with `composeLaneReviewMessage(...)`
   (`src/lib/laneReview/message.ts`, pure). The server uses the client's quote
   only after checking that it equals the redacted text of that row at
   `base..head`. A mismatch is `400 { code: "quote_mismatch" }`, so the message
   can carry no quote that is not in the diff.
7. Call `conversationHostPOST(viewerRequest("/api/conversation-host", { conversationId, clientMessageId, text, policy: "steer-or-queue", images: [] }), { actor })`,
   as `src/lib/prototypeReview/decision.ts:174` does. The key
   `clientMessageId = "lane-review:" + sha256(pipelineId + draftId + head)`,
   cut to 128 chars, makes a repeat of the same draft and head replay the
   first answer and deliver nothing twice.
8. Answer `{ ok, conversationId, clientMessageId, operationId, receipt, outcome }`,
   as `conversationHostPOST` returned it.

Open PR #3207 changes how the conversation-host handler attributes an
in-process person (`inProcessPerson`). Whichever change lands second checks
that the feed labels this message as the operator's.

Long text: a message over 32,000 bytes (`MAX_STRUCTURED_TEXT_BYTES`,
`src/lib/runtime/structuredContent.ts:40`) travels through the handler's
existing long-text conversion (`src/app/api/conversation-host/longText.test.ts:28`).
This slice adds no separate size limit of its own.

### Text the agent receives

The text is plain and deterministic. Its frame is in the operator's interface
language; the comment bodies are verbatim. Comments are ordered by the file
list's order; within a file the file-level comments come first, then the
`new` side before the `old` side (their numbers count lines of different
files), then by line number. Each body line is indented three spaces. Both SHAs are given in
full.

English:

```
Line comments on this lane's changes.
Base 8e081f431c… · head bf1c00247d… (branch pipeline/example).
Line numbers: "old" is the file at the base commit, "new" is the file at the head commit.

Overall: tighten the error copy before the next round.

1. src/lib/example.ts:42 (new)
   > const limit = 200;
   Read this from REVIEW_DIFF_CAPS instead of repeating it.

2. src/lib/example.ts:17 (old)
   > return null;
   This removal drops the empty-state answer; keep it.

3. docs/design/example.md (file)
   Add the 390 px case.

Address each numbered comment on the branch, or answer why not.
```

Ukrainian:

```
Коментарі до змін у цій гілці.
База 8e081f431c… · голова bf1c00247d… (гілка pipeline/example).
Номери рядків: «старий» — файл у базовому коміті, «новий» — у головному.

Загалом: …

1. src/lib/example.ts:42 (новий)
   > const limit = 200;
   …

Виправте кожен пронумерований коментар у гілці або поясніть, чому ні.
```

(The examples shorten the SHAs; the real message carries all 40 characters.)

### Receipts after the send

The sheet stores `sent` in the draft and reads the delivery status through
`GET /api/runtime/operations/<operationId>`. A failed receipt that may be
retried uses `POST /api/runtime/operations/<operationId>`, the composer's own
retry (`src/components/TmuxComposer.tsx:4643`). In the target conversation the
message appears as an ordinary operator message with the delivery marks the
feed already draws.

## 6. States

The sheet waits for the server on Send and on Re-anchor, and shows no
optimistic result for them: the send is irreversible and both checks are
computed on the server. Editing comments is local and immediate.

| State | Defining element (visible text, first screen) | Controls |
| --- | --- | --- |
| loading | «Reading changes…» in the file column; «Loading diff…» in the diff column | Close |
| error | «Could not read the changes: {reason}» | Try again, Close |
| empty | «No changes between {base} and {head}.» | Send disabled |
| ready / draft | Header `{base} → {head}`, «{n} files · +a −b»; footer «{count} comments to {stage} · {engine}» | Line-number buttons, Comment on the file, Send |
| no target | Footer «No stage has written to this lane yet» | Send disabled |
| stale head | Banner under the header: «The branch moved: {old} → {new}. Your {count} comments are kept.» | Re-anchor to {new}; Send disabled with «Re-anchor first: the comments point at an older commit» |
| re-anchored | Banner: «{moved} moved, {detached} need a line»; detached comments listed first in their file under «Needs a line» | Edit, delete, or leave a detached comment as file-level; Send enabled |
| target changed | «The lane's writer is now {stage}. Check and send again.» | Send |
| sending | Send reads «Sending…», disabled | none |
| sent | Footer «Sent to {stage} at {time}» plus the receipt word (queued / delivered) | Open conversation; new comments start a new draft (`draftId` renewed) |
| failed | «Not sent: {reason}. Your comments are kept.» | Retry delivery (runtime retry) or Send again (same key) |

Uncommitted files (§1) add one line under the header in any state that has a
list: «{count} uncommitted files in the checkout are not shown».

## 7. Layout

### Desktop (≥ 640 px)

- The frame is the stages sheet's own scrim and sheet (`StagesSheet.tsx:190-215`):
  header with kind «Changes», the card title, `{base} → {head}` in mono, the
  file totals and a close button. Esc closes it unless focus is in a text
  field, and the board behind it is `inert` while it is open.
- The body is a grid. On the left is the file list, 260 px (220 px below
  1024 px), scrolling on its own. Each row shows the op letter in `OP_TONE`,
  the path (truncated from the left, full path in `title`), `+a −b`, and a
  comment-count badge. On the right is the selected file's diff.
- The diff reuses `DiffRows` / `LineRow` from `DiffCard.tsx:41-103`, extended
  with two optional props that existing callers omit
  (`FileDiffView` `:105`, `MandateDiff.tsx`): `numbers` (a gutter of old/new
  line numbers, where the new number is a button labelled «Comment on new
  line 42») and `after(rowIndex)` (comments and the open editor below their
  row). The diff column keeps the existing `overflow-x-auto`.
- The footer is pinned to the bottom of the sheet: the collapsed «Overall note
  (optional)», the target line and Send.
- The ⋯ menu item opens the sheet the same way «Expand stages» opens its own
  (`KanbanBoard.tsx:1687`, mounted next to `sheetView` at `:2838`). Only one of
  the two sheets is open at a time.

### Phone (< 640 px)

- The lane ⋯ sheet (`MobilePipelineScreen.tsx:520`) gets a «Changed files»
  row. It opens a `MobileSheet` holding the line «Line comments are written on
  a computer.», the line `{base} → {head}`, the totals, and the file rows.
  Tapping a row shows that file through the existing
  `<DiffCard body={{ type: "diff", files: [file], filesTruncated: false }} />`
  with its 8-line preview and «show all».
- The phone has no gutter buttons, no editor and no Send, and does not read a
  desktop draft.

## 8. Strings (en / uk)

All keys are new under `laneReview.*` in `src/lib/i18n/en.ts` and
`src/lib/i18n/uk.ts`. Existing keys are reused where they fit
(`common.cancel`, `tools.binaryContent`, the composer's delivery words).

| Key | en | uk |
| --- | --- | --- |
| menu | Review changes | Переглянути зміни |
| phoneRow | Changed files | Змінені файли |
| kind | Changes | Зміни |
| totals | {count} files · +{added} −{removed} (plural) | {count} файл/файли/файлів · +{added} −{removed} |
| loading | Reading changes… | Читаю зміни… |
| loadingFile | Loading diff… | Завантажую diff… |
| error | Could not read the changes: {reason} | Не вдалося прочитати зміни: {reason} |
| tryAgain | Try again | Спробувати ще раз |
| empty | No changes between {base} and {head}. | Між {base} і {head} змін немає. |
| moreFiles | {count} more files not listed | Ще {count} файлів не показано |
| uncommitted | {count} uncommitted files in the checkout are not shown | Незакомічені файли в робочій копії ({count}) не показано |
| lineOld / lineNew | Comment on old line {line} / Comment on new line {line} | Коментар до старого рядка {line} / до нового рядка {line} |
| fileComment | Comment on the file | Коментар до файлу |
| placeholder | What should change here? | Що тут змінити? |
| save / delete / edit | Save / Delete / Edit | Зберегти / Видалити / Змінити |
| note | Overall note (optional) | Загальна примітка (необов’язково) |
| footer | {count} comments to {stage} · {engine} (plural) | {count} коментар/коментарі/коментарів для {stage} · {engine} |
| send | Send to agent | Надіслати агентові |
| sending | Sending… | Надсилаю… |
| noTarget | No stage has written to this lane yet | Жоден етап ще не писав у цю гілку |
| stale | The branch moved: {old} → {new}. Your {count} comments are kept. | Гілка змінилася: {old} → {new}. Ваші коментарі ({count}) збережено. |
| reanchor | Re-anchor to {new} | Перенести на {new} |
| staleWhy | Re-anchor first: the comments point at an older commit | Спершу перенесіть коментарі: вони вказують на старіший коміт |
| reanchored | {moved} moved, {detached} need a line | Перенесено: {moved}; без рядка: {detached} |
| needsLine | Needs a line | Потрібен рядок |
| targetChanged | The lane's writer is now {stage}. Check and send again. | Зміни в гілці тепер пише {stage}. Перевірте й надішліть ще раз. |
| sent | Sent to {stage} at {time} | Надіслано: {stage}, о {time} |
| failed | Not sent: {reason}. Your comments are kept. | Не надіслано: {reason}. Коментарі збережено. |
| sendAgain | Send again | Надіслати ще раз |
| openConversation | Open conversation | Відкрити розмову |
| cut | Diff cut at {count} lines; comment on the file for the rest. | Diff обрізано на {count} рядках; для решти лишіть коментар до файлу. |
| notSaved | The draft is not saved on this device. | Чернетку не збережено на цьому пристрої. |
| phoneNote | Line comments are written on a computer. | Коментарі до рядків пишуться на комп’ютері. |
| reason.* | named refusals (no head, no base, git, file gone, quote gone, operator only), else «the server did not answer» / «the server refused it ({status})» | the same in Ukrainian |
| binary | Binary file: no lines to show. | Бінарний файл: рядків для показу немає. |

The message frame (§5) is composed on the server in `message.ts` and is not a
dictionary key.

## 9. Files

New:
- `src/lib/pipelines/laneChanges.ts` (+ `.test.ts`, which runs real git in a temp repository)
- `src/lib/laneReview/model.ts`, `message.ts` (+ tests); `http.ts` (both
  routes' handlers and the in-process delivery), `dependencies.ts` (their
  production ports), `gitFixture.ts` (the lane-shaped repository the tests and
  drivers share)
- `src/app/api/pipelines/[id]/changes/route.ts`, `src/app/api/pipelines/[id]/review/route.ts` (+ `review/route.test.ts`)
- `src/components/laneReview/LaneReviewSheet.tsx`, `LaneReviewPhoneSheet.tsx`,
  `client.ts` (+ `LaneReviewSheet.dom.test.tsx`, which covers both sheets)

Changed:
- `src/components/feed/diff.ts`: export `diffFromGitFilePatch` and `REVIEW_DIFF_CAPS`
- `src/components/feed/cards/DiffCard.tsx`: optional `numbers` / `after` props on `DiffRows`
- `src/components/kanban/KanbanBoard.tsx`: menu item and mount
- `src/components/mobile/MobilePipelineScreen.tsx`: one row, and
  `mobileNav.ts`: the sheet name `changes`
- `src/lib/viewerLoopMonitor.ts`: the operation name `pipelines.laneChanges`
- `src/components/kanban/KanbanStages.dom.test.tsx`: the lane menu's item list
  gains «Review changes»
- `src/lib/i18n/en.ts`, `uk.ts`
- `src/components/kanban/kanbanBoard.browser.test.tsx` (one `describe` block) and
  `src/components/mobile/issue1671Evidence.browser.test.tsx` (one case), both
  calling `captureLaneReviewFrames` in `issue1695BrowserHarness.ts`; the
  fixture passes the lane review routes to the driver's server only under
  `?laneReview`

## 10. Tests the acceptance names

Each test names its hostile input and the layer that enforces the refusal.

- **Anchoring** (`model.test.ts`): line numbers from real `git diff -U3`
  headers; a context row anchors to `new`; rows dropped by a cap take no line.
  `reanchor`: lines inserted above give `moved` with the new number; an edited
  line gives `detached` with its quote kept; duplicate text picks the nearest
  match; a path gone from the list gives `detached`; nothing is ever removed.
- **Stale head** (`review/route.test.ts`, temp repository): read the summary,
  then **commit to the lane branch** and POST the old head. Expect 409
  `head_moved` with the new SHA, and the `conversationHostPOST` spy called zero
  times. The test breaks the state after the step that sets it, so a check that
  only reads back its own value cannot pass. The same is checked for a branch
  deleted after the read, where the head falls back to `lastPassedCommit` and
  differs.
- **Message composition** (`message.test.ts`): exact en and uk text for a
  fixed draft; ordering; multi-line bodies indented; file-level comments; full
  SHAs. Hostile case: a diff row holding a token-shaped string. Its quote in
  the message is the redacted text, and a client quote that differs from the
  row is refused with `quote_mismatch` at the route.
- **Authority** (`review/route.test.ts`): a request carrying an agent
  conversation capability gets 403 `operator_only`; a valid internal service
  claim gets 403; a cross-origin request is refused; an anonymous request in
  team mode gets 401/403. In every case the delivery spy is called zero times.
  The operator, and an active member, get one call with the composed text and
  the derived key. Repeating the same draft and head gives the same
  `clientMessageId`.
- **List bounds** (`laneChanges.test.ts`): 205 files gives 200 listed with
  `total: 205` and `truncated`; a binary file; the base follows the merge base
  after main is merged into the lane; a path such as `:(glob)*` or `../x` is
  refused because it is not in the list.
- **Sheet** (`LaneReviewSheet.dom.test.tsx`): every state in §6; the draft
  survives a remount; Esc inside the editor does not close the sheet; Send is
  disabled while stale; Retry delivery calls the runtime retry route. Phone:
  no gutter buttons and no Send are rendered.

Checks, each through `gate-remote -- <command>`, one call at a time, with
`HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` isolated and
`LLV_VIEWER_CONTROL_URL` set to a closed port:

- `bunx tsc --noEmit`
- ESLint on the touched files
- `bun test <each touched test file>`

### Rendered evidence

Frames are made with the existing drivers only, and saved in scratch:

- Kanban board driver: desktop at 1440, 1024 and 640 px, in en and uk, light
  and dark. States: ready with comments, an open editor, stale, re-anchored,
  sent, failed, empty and loading. The fixture uses real data: a lane with an
  added, an updated, a deleted and a binary file, and a multi-hunk file.
- Phone driver: 390 px, list and one expanded file, in en and uk, light and
  dark.

Each frame is checked for: the state's defining text visible on the first
screen; the pinned footer not covering the last diff row; gutter targets at
least 24 px; the background inert.

## 11. What not to touch

- `.github/workflows/**`
- The pipeline engine and the publication code in `src/lib/pipelines/git.ts`
  (`publicationChangedPaths` stays private and unchanged), and the `Pipeline`
  type. No server-side draft field and no new lane state.
- `src/app/api/conversation-host/handlers.ts`: called, never edited. The same
  holds for the runtime operations route and the runtime host.
- `DIFF_CAPS`, `finalize` and the feed's tool-diff behaviour. `DiffCard`
  changes only through optional props.
- The MCP tool surface: no new tool, and `send_message` stays as it is.
- `StagesSheet` behaviour, and the card face: no new badge, chip or button on
  the card. The only entry is the ⋯ item and the phone row.

## Deferred — not currently justified

- Server-side drafts shared across devices, and comment editing on the phone.
  The requirement allows a read-only phone, and a browser-local draft keeps
  comments across head moves.
- Uncommitted worktree changes in the diff. They change under a running stage
  and have no SHA to pin.
- Rename detection, a split (side-by-side) view, syntax highlighting, and
  expanding context beyond `-U3`.
- Anchoring by diff-of-diffs instead of exact quote matching.
- Posting comments to the GitHub pull request, and threads or replies from the
  agent tied back to a comment.
- An entry from the PR work-link chip. The lane ⋯ item covers the card.
- A shared annotation framework with rank 8 (document comments). Rank 8 can
  reuse `POST …/review`'s delivery step when it is built.
- A cache for the change summary. Measured reads take 36–40 ms for typical
  lanes.
