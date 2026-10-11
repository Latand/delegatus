# «Готово» in «Чекають на вас»

## Originating requirement

The operator, 2026-10-11 ~11:20 Kyiv, answering prototype review
`pr_38ff7ef61d1065c1ef37fde50163a242` (task `a95fe7ba`), as pinned on this
pipeline:

> - Variant 2 — «Чекають на вас» + «Готово»: the panel he already clears
>   («Зняти», «Зняти всі», the phone drawer) gains a «Готово» section.
> - WHEN: «Завжди коли якісь задачі виконані показувати» — every finished
>   outcome appears in «Готово» as soon as it happens and stays until
>   acknowledged (not only after an absence).
> - Technical fixes without UI: one group, one button acknowledges all, the
>   group expands to rows (each row acknowledgeable on its own too).
> - Counter: unacknowledged «Готово» items count in the «Чекають» counter until
>   acknowledged; after that only decisions remain.
> - Scope of items: merged PRs, deploys and publications (e.g. a landing
>   publication), incidents (a stuck lane, a credit guard pause, a manual
>   intervention), tasks closed without a PR, and an account-limits line.
> - Telegram: nothing new; reports stay as they are.
>
> ITEM SHAPE: a visible change shows a thumbnail (the rendered frame its lane
> produced: prototype review frames, visual-check frames, evidence) that opens
> in the existing image viewer (before/after when both exist); a technical
> change shows a lucide icon and one plain Ukrainian sentence, plus the PR
> link. Each item knows its source (pipeline, PR, deployment, task, report) so
> acknowledging is durable and survives reloads, other devices and restarts,
> and a repeated event never re-creates an acknowledged item.

The review's raw answers: variant 2 chosen; the trigger question answered
«Other» with the comment quoted above; technical grouping, counter, scope and
Telegram took the recommended options. On 2026-10-10 (task `a16e413e`) the
operator had kept the panel to real decisions and turned down a «Вирішено без
вас» section; this choice adds «Готово» on purpose, below the decisions and
visually distinct from them.

What the answers change against the frames: the frames were drawn for the
absence trigger the operator did not pick, so the section is titled «Готово»
(not «Готово, поки вас не було») and the «Поки вас не було · 02:59 → 10:46»
summary card is not built (§8).

## 1. What the existing panel already provides

Everything below is reused; the section adds rows to it and nothing beside it.

| Piece | Where | Used for |
| --- | --- | --- |
| Desktop panel: head (title with count, Undo, «Зняти всі», dock/float, close), body of per-project sections, fold memory, `QUIET`/`ICON` controls | `src/components/attention/AttentionPanel.tsx` | «Готово» becomes the last block of the body, after every project section |
| Phone sheet: `MobileSheet`/`MobileSheetSection`, header «Чекають на вас · n», «Зняти всі», receipts with Undo (`showReceipt`) | `src/components/attention/MobileAttentionSheet.tsx` | the same block at the bottom of the sheet; acknowledgement receipts |
| Header control `AttentionIsland` (`count`), the phone bar's badge (`shellQueueCount`), the tab title | `src/components/Viewer.tsx:997-1050`, `:1319`, `:1561` | the counter rule (§5) |
| Image viewer with before/after swap (`GalleryImage.before`) | `src/components/feed/Lightbox.tsx` | opening a thumbnail, unchanged |
| Prototype frame pairs (`frame.original`) and their media route `/api/image?taskId=…&prototype=…&media=…` | `src/lib/prototypeReview/*`, `PrototypeReview.tsx:66-80` | thumbnails and before/after |
| Task album: every picture a task's stages looked at or named, with its stage | `src/lib/taskAlbum/{album,sources,world}.ts` | visual-check and evidence frames |
| Task icon (`BoardTask.icon`, a lucide name) and `TaskIconGlyph` | `src/lib/tasks/types.ts:256`, `src/components/tasks/TaskIcon.tsx` | the icon on a technical row |
| Optimistic overlay pattern for a click (`dismissalOverlay.ts`) | `src/components/attention/dismissalOverlay.ts` | an acknowledgement is drawn the moment it is clicked |
| `SqliteStateCollection` (a plain collection in `state.sqlite`, no legacy file) | `src/lib/state/sqliteStateStore.ts`, used by `src/lib/links/taskFeed.ts:82` | the acknowledgement store (§3) |

The decisions queue (`buildNeedsYouQueue`), its sections, the N key, the rail's
⏸ counts, `dismiss_attention`, the needs-you MCP read (`needsYouRead.ts`) and
the board report's «Waiting for you» line stay exactly as they are: «Готово» is
a second list beside the queue.

## 2. Item sources

Every item comes from a record Delegatus already keeps. One finished unit of
work gives exactly one item, so each unit belongs to exactly one source:

| Item | Source record | Key | When it appears |
| --- | --- | --- | --- |
| A PR landed | forge cache `state/forge-links.json` (`src/lib/forge/sweep.ts`) | `pr:<repository>#<number>` | the sweep sees it `merged`, or landed through a merge batch (below) |
| A pipeline finished without a PR | `pipelines` and `pipelines_archive` | `pipeline:<id>:done` | the lane is `completed` or `closed`, its last stage attempt `passed`, and it names no PR (`delivery.target.pr`, `merge`, a PR on its branch) |
| A task closed with no pipeline | `tasks` (`status: "done"`, `doneAt`) | `task:<id>` | `doneAt` is set and no pipeline is bound to the task |
| A deploy of Delegatus | `ledgerDeployments(20)` (`src/lib/runtime/deploymentLedger.ts`; runtime host and self-update checkout alike) | `deploy:<deploymentId>` | phase `succeeded`, `failed` or `rolled-back` |
| An incident or a publication | the bridge report log, manager rows marked `outcome` (§2.3) | `report:<report id>` | the report is appended |
| An account limit | account usage observations (`limits-history.json` samples, the store `account_limits` reads) | `limit:<engine>:<accountId>:<window>:<episode start t>` (§2.4) | a window is first observed exhausted |

A task bound to a pipeline is represented by that pipeline's item (the PR item
or the pipeline item names it in `refs.taskIds`), so a lane that merges and
moves its task to Done is one item. A pipeline closed without passing
(discarded, failed) is no outcome and gives nothing.

### 2.1 Merges, including merge batches

Measured on 2026-10-11 for the night of the prototype (22:00Z–08:00Z): 14
changes reached `main`. Four merged directly, and only those four have a
`pipeline_merged` event in the lifecycle journal. The other ten landed through
`scripts/merge-batch.ts`, which merges one batch PR (`merge-batch/<id>`, titled
`Merge batch: #2699, #2708, …`; that night #2703, #2728 and #2738) and closes
the originals with a comment, so the forge cache lists all ten as `closed`.
Reading `pipeline.merge` or the journal alone loses more than two thirds of the
night.

So the sweep's `PR_FIELDS` (and `LEGACY_PR_FIELDS`) gain `title` and `mergedAt`,
stored on `StoredPullRequest` as optional fields. A PR counts as landed at:

- its own `mergedAt` when the cache says `merged` and its head is not
  `merge-batch/*`;
- the batch's `mergedAt` when it is `closed` and a `merged` PR with a
  `merge-batch/*` head names its number in the title `Merge batch: #a, #b`.

The batch PR itself is never an item. The title format becomes a contract of
`merge-batch.ts`; a parser test pins it.

A landed PR joins its pipeline by head branch (`pipeline.branch ===
headRefName`), then by `delivery.target.pr` or `merge.prNumber`, across live
and archived pipelines. Its tasks are the pipeline's `taskIds` (the
`finishesTaskIds` first) plus any task whose `workLinks` name the PR.

### 2.2 Floor and capture

The projector considers source events at or after `activation`, the instant
the store was first written, kept in its meta row, so the first deploy shows
nothing from before it. There is no rolling window: an outcome nobody has read
yet stays eligible however long ago it happened, so a task done a second after
activation still arrives when the next projection runs eight days later.

Three sources roll over on their own (the limits history keeps 8 days, the
report log 500 rows, the deploy ledger is read 20 deep), so an outcome has to
reach the store while its source still holds it. The release that owns traffic
projects every minute (`src/lib/done/sweep.ts`, started with the other
controllers), whether or not a tab is open; the read route projects as well.
Once an item is in the store it stays there until acknowledged (§3), whatever
its source does next.

### 2.3 Incidents and publications: a marker on the report

A stuck lane, a credit-guard pause, a manual intervention and a landing
publication have no structured record; the seat narrates them in bridge
reports (`status` 619, 631, 634, 643 that night), mixed with progress lines
that are no outcome. Classifying report text would be a detector, and those
are hints here. So `bridge_report` gets one optional input:

```
outcome?: "incident" | "publication"
```

It is honoured only on a manager-origin row of the caller's project (another
origin keeps its report and the answer says the marker was ignored), stored on
`BridgeReportV1` as `outcome: { kind, summary }`, the summary being the one the
report rendered after scrubbing, and changes neither the body nor the Telegram
copy. The tool description says when to set it: `incident` when the report
tells of something that went wrong and was handled (a lane stuck and
restarted, lanes paused by the credit guard, a step done by hand);
`publication` when something was published outside Delegatus's own deploy
(the landing site, a release tag). The seat's report rules (mandate v46) point
at that description in one clause: the delivered mandate sits a few bytes
under the budget that keeps a rotation's history section whole.

A failed or rolled-back deploy is an incident from the ledger directly, with no
marker.

### 2.4 Account limits

An exhausted usage window is the limits line. The projector reads the limits
history: a run of samples with `remaining ≤ 0` for one engine, account and
window is one episode, keyed by its first sample's `t`. The history drops
samples older than 8 days, so an episode that lasts across that edge would
show a later first sample; the store therefore remembers each episode it saw
(its start, its latest sample at no room left and the sample that showed it
back, in the `limit-episodes` row) and a run that overlaps a remembered
episode, or that begins the visible history while the latest remembered one
is still open, keeps that episode's key. A run after an observed reset is a
new episode. An episode is forgotten 30 days after its last exhausted sample.
The row says which account and window ran out, when, and,
once a later sample shows it reset, when it came back; when pipeline attempts
recorded that account in `usageLimitedAccounts` during the episode, it adds how
many lanes waited. Its key never changes as the text fills in or the history
trims, so acknowledging it early holds.

## 3. The acknowledgement store

One collection, `done_items` in `state.sqlite` (`SqliteStateCollection`, keyed
by item key), holds the item and its acknowledgement together:

```ts
interface DoneItemV1 {
  key: string;                       // §2 keys, deterministic
  kind: "pr" | "pipeline" | "task" | "deploy" | "report" | "limit";
  look: "visible" | "technical" | "closed" | "deploy" | "publication" | "incident" | "limit";
  project: string | null;            // null: deploys and limits, shown on every board
  at: string;                        // the event's own time
  createdAt: string;
  title: string;                     // task title, report summary or PR title (§4)
  icon: string | null;               // lucide name: the task's icon, else the kind's
  refs: { pipelineId?: string; pr?: { repository: string; number: number; url: string };
          taskIds?: string[]; deploymentId?: string; sha?: string; reportId?: string;
          account?: { engine: string; accountId: string; window: string } };
  frame: { src: string; before?: string; caption: string } | null;
  frameCheckedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: { kind: "operator"; surface: "desktop" | "phone" } | null;
}
```

- **Projection.** `projectDoneItems()` reads the sources, builds the keyed
  candidates and inserts the keys it has never seen. An existing row is never
  re-created: an acknowledged row stays acknowledged whatever its source does
  next. An unacknowledged row may refresh its `title`, its limit text and its
  `frame`. Running it twice writes nothing the second time. The sweep of the
  release that owns traffic runs it every minute and the read route runs it
  too, each at most once every 30 s per process (a `globalThis` stamp, as
  `src/lib/lifecycle/projector.ts` throttles); a Viewer that was stopped
  catches up from `activation` when it starts.
- **Acknowledgement.** Sets `acknowledgedAt` and `acknowledgedBy`; undo clears
  both. Operator only, through the Viewer's own route: no MCP tool takes it, so
  no agent can acknowledge what the operator has not seen.
- **Retention.** An acknowledged row is kept 30 days after its acknowledgement.
  Past 2 000 rows the acknowledged rows with the oldest events go first.
  Unacknowledged rows stay until acknowledged. Removing a row leaves a settled
  row (`settled:<key>` with the event time) in the same transaction, and the
  store never inserts a settled key, so neither a repeated source nor a fresh
  reader after a restart can re-create a pruned acknowledgement, while every
  other key, however old its event, stays eligible. A settled row retires once
  its event is 400 days old and moves the meta row's `retiredThrough` up to
  that event, so only an outcome older than that which no projection saw in
  all that time is no longer inserted.
- **Routes.** `GET /api/attention/done` answers `{ items, revision }`, the
  unacknowledged rows, newest event first, after projecting.
  `POST /api/attention/done` takes `{ keys, undo?, surface }` (at most 200
  keys), same-origin checked as the dismissals route is, and answers the rows
  it changed. The Viewer reads it on mount, every 30 s while the tab is visible,
  and after each acknowledgement; another device sees an acknowledgement on its
  next read. Reads are numbered as they leave, and an answer that comes back
  behind a later applied read is dropped, so a poll that left before an
  acknowledgement or its undo cannot redraw the old state.

The store lives under the state directory, so it obeys
`src/lib/stateOwnership.ts`: the route runs in the Viewer, a build or a test gets
its own directory.

## 4. Rows, groups and the thumbnail lookup

### 4.1 Words

The row's sentence is Ukrainian text Delegatus already holds; nothing is generated:

- a PR or pipeline item: the first line of its first bound task's text (board
  task text is written in Ukrainian); without a task, the pipeline's `task`,
  then the PR title;
- a task item: the task's first line;
- a report item: the report's `summary`;
- deploys and limits: templates in the dictionaries (`uk.ts` and `en.ts`),
  filled from `refs`.

The meta line under it: `#2698 · злито 02:21` (the number links to the PR's
`url`), `задачу закрито 03:30`, `деплой · 04:34`. The deploy's commit is an id the
operator does not need; the time and the sentence say what happened. A row from another
project than the one on screen names its project first, as the decision rows'
sections do.

### 4.2 The thumbnail lookup

Run at projection for `pr` and `pipeline` items, stopping at the first hit:

1. A prototype review round on one of the item's tasks published by the
   item's own pipeline and not decided (a build or fix stage's rendered
   result), newest round, the first frame of its first variant; the frame's
   `original` is the `before`. A decided round of the lane's own is a design
   choice and is read by step 3.
2. The newest image in the task album (`readTaskAlbum`) whose source stage
   belongs to the item's pipeline and has the `visual-critic` role, else one the
   album admits from an evidence root (`LLV_EVIDENCE_ROOTS`) from any stage of
   that pipeline.
3. The chosen variant's first frame of the newest decided round on the task
   (the design target the lane built), with its `original` when present.

No hit: the item is technical. An album still indexing leaves `frameCheckedAt`
empty and the next projection tries again; a settled answer is final. Step 2
runs for every item with a pipeline, a builder-only lane included, since its
evidence frame is as much the lane's rendered result as a critic's; one
projection reads at most four albums and leaves the rest open for the next, so
indexing stays bounded and retryable.

A press on the thumbnail opens `Lightbox` with `{ src, before }`, unchanged.

### 4.3 Layout inside the section

The section head: «Готово · N» and the accent «Прийняти всі N». Below it, in
this order:

1. Visible changes, each its own row: thumbnail (expand mark in its corner),
   the sentence, the meta line, and «Прийняти» at the row's right end as the
   square check an expanded group's members carry (a finger's 44 px on the
   phone). No row keeps a line for its button.
2. Deploys and publications, each its own row: icon (`Rocket`, `Globe`),
   sentence, meta, «Прийняти».
3. **«Технічні виправлення · N»**: every landed PR without a frame. One row:
   `GitMerge` icon, short topics and «і ще N», the double check with N and a
   chevron at the right end. A topic is a sentence's first clause cut at a
   word to at most three words, with no ellipsis and lower case after the first
   (an acronym or, in Ukrainian copy, a Latin name keeps its case); topics are
   listed while they fit about two short lines and «і ще N» names the rest,
   never cut. Expanded, each member is a line: the task's icon, `#number`
   linked, the sentence, its own check, and the head repeats no member: it
   shows only «N прийнято» once some are accepted.
4. **«Без PR · N»**: pipelines finished without a PR and tasks closed with no
   pipeline, the same group anatomy (`CircleCheck`).
5. Incidents and limits, each its own row (`TriangleAlert`, `Gauge`): sentence
   and «Прийняти».

An item acknowledged while the panel or the sheet is open collapses in place to
«<назва> · прийнято» with «Повернути» (the name is the sentence's first clause,
«Лендінг #2691 · прийнято»; it wraps rather than clips, and «· прийнято» is
never cut), and leaves when the panel closes or the
sheet is dismissed. In an expanded group an acknowledged member keeps its line
with a filled check, and the group head reads «6 з 10 · 4 прийнято» (the
desktop keeps «6 з 10» beside the name, the phone moves it onto the line under
it, where it never breaks) with
«Прийняти 6». The phone shows the same receipt row; the desktop head's Undo
stays for dismissals only.

Empty «Готово» draws nothing: the panel is the decisions list it is today, and
«Ніщо не чекає на вас.» shows only when both are empty.

## 5. The counter rule

`waiting = decisions + unacknowledged done items`, each group member counting
one:

- the desktop header control (`AttentionIsland count`), the panel title
  «Чекають на вас · N», the tab title `(N) Delegatus`;
- the phone bar's badge and the sheet header, over the same project slice the
  badge already uses, plus the items whose `project` is null.

Unchanged and decisions-only: the rail's ⏸ per project, the head's «Зняти всі
N» (it dismisses decisions; «Готово» has its own «Прийняти всі»), the
needs-you MCP read and the board report. Once every item is acknowledged the
counter is the decisions count again, which is the frames' «усе прийнято,
Чекають 3». The frames' head showed «Зняти всі 19» over 3 decisions; that would
promise a dismissal of rows it does not touch, so the head counts what it
clears.

## 6. Options considered

**Acknowledgement store.**
- *Items and acknowledgements in one `done_items` collection (chosen).* An item
  outlives its source's trimming, a repeated event finds its key, and
  acknowledgement is one row write.
- *Acknowledgements only, items re-derived on each read* (a `done:` kind in
  `attention_dismissals`). Smaller, but an unacknowledged item would vanish with
  its source (2 000 journal events, 500 reports, 8 days of limits), which breaks
  "stays until acknowledged", and the dismissals collection's 30-day retention
  and 2 000-conversation capacity would bind two unrelated records.
- *The lifecycle journal as the source.* Already keyed and deduplicated, but it
  misses batch merges, publications and limits and holds about two days.

**Merge detection.** Forge cache plus batch titles (chosen) against
`pipeline.merge` alone (misses 10 of 14 that night) or a first-parent `git log`
of each project's base branch (needs a fetched checkout per project, which the
sweep already replaces with one `gh pr list`).

**Incidents.** An explicit `outcome` marker (chosen) against classifying report
prose, or new detectors over stalls and pauses; both of those guess, and the
seat already writes the sentence the operator reads.

## 7. Checks the build owes

By path, under isolated state (one `mktemp -d` root holding HOME,
`LLV_STATE_DIR` and TMPDIR, `LLV_VIEWER_CONTROL_URL` on a closed port), through
`scripts/gate-slot.sh`:

- projector: one item per unit (a direct merge, a batch member at the batch's
  time, no item for the batch PR, a PR-less passed lane, a task without a
  pipeline, none for a task its pipeline covers, none for a discarded lane);
  idempotent second run; an acknowledged key stays acknowledged while its source
  repeats; nothing before `activation`; an unread outcome arriving days later;
  the sweep keeping items past their source's rollover; manager-only `outcome`;
  a limit episode keeps its key as its reset arrives and as the history trims
  its first samples; retention and the row cap never re-creating an
  acknowledged key and never hiding an older key first seen afterwards; a builder-only lane's evidence frame;
- forge sweep: `title`/`mergedAt` parsed on both field sets; the batch-title
  parser;
- the route: GET projects and answers unacknowledged rows; POST acknowledges,
  undoes, refuses cross-origin and more than 200 keys;
- `AttentionPanel.dom.test.tsx` and `MobileAttentionSheet.dom.test.tsx`: the
  section after the decisions, the counter, row, group and all acknowledgement,
  the collapsed receipt, a thumbnail opening `Lightbox` with `before`, a read
  that left before an acknowledgement or its undo arriving last;
- `bunx tsc --noEmit` through `scripts/gate-slot.sh`;
- rendered evidence with the existing drivers only: a `describe` case in
  `src/components/kanban/kanbanBoard.browser.test.tsx` for 1440 and in
  `src/components/mobile/issue1671Evidence.browser.test.tsx` for 390, uk, over
  `needsYouPanel.fixture.tsx` extended with done items whose fixture text holds
  no account, email, host or home path; a short Chrome TMPDIR;
- the local privacy gate from the merge base.

## 8. Deferred — not currently justified

- **The «Поки вас не було» summary card and any absence trigger.** The operator
  replaced the trigger with "always"; the per-item rows carry the same facts.
- **A «Документи» group.** Docs-only PRs sit in «Технічні виправлення»;
  splitting them needs each PR's changed files, which the sweep does not read.
- **«на проді з HH:MM» on a merge row.** Needs deploy containment per merge
  commit; the deploy items already say when Delegatus moved.
- **«Прийняти» and «Відкрити сайт» inside the image viewer** (frame 2/4).
  `Lightbox` is shared by the feed, prototype reviews and the album; the row's
  own button sits beside the thumbnail.
- **Before/after from album images** paired by file name. Only explicit
  prototype pairs make a `before`.
- **Acknowledgement by agents or over MCP, and an unacknowledged count in the
  seat's reads.** The point of the section is what the operator has seen.
- **Per-project «Готово» sections.** One section; a foreign row names its
  project.
- **Backfill before activation.**
- **Anything in Telegram.**
