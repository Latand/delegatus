# Task files: the documents a task's lanes created or changed, beside its images

Status: design for the builder. Grounded at `37556e0bbe5cc3c223fb51022be141057fa7581f`
(`origin/main` and the remote `main` at 2026-11-06 08:55 UTC). Every file:line
below refers to that revision. Observations were made between 08:30 and 08:55
UTC on 2026-11-06.

## 1. Originating requirement

Source: the operator, by voice, in this project's orchestrator seat on
2026-11-06. This file is public, so the request is paraphrased in English; the
verbatim words stay in the task's private record.

- A task already shows its pictures, and every picture can be opened. The
  operator also wants the files the agents changed, with a convenient preview.
- The preview must load fast and must not overload the server, as file work did
  before. Cache and process files correctly, using the earlier lessons.
- Either the agent leaves a handoff file to look at, or it adds a list of the
  files (their paths) it created. Besides pictures, the operator wants to see
  the documents an agent produced and check them, at least rendered Markdown.
- Think about how to do it well and properly.

The pinned acceptance adds, in summary:

- Extend the task's existing image album; preserve image viewing.
- A discoverable list matching the task's registered files, with pagination and
  small metadata only. Opening Markdown fetches bounded content lazily and
  renders it without active HTML or scripts.
- Link, root, symlink, workspace and authorization boundaries hold; safe
  missing, changed, denied, large and binary states; keyboard, focus, close and
  back behaviour from the existing UI; 390 px phone and desktop.
- No filesystem browser, no global recursive census, no full transcript
  hydration and no content read on board render. A path alone authorizes
  nothing.
- Caches bounded by bytes, entries, concurrency and lifetime, invalidated by
  file identity and revision, with no cross-task, cross-user or cross-workspace
  leak. Requests coalesced and cancellable where that fits.
- Concrete caps and measurements before the build; cold and warm, before and
  after, on identical owned fixtures, with honest RAM, CPU and latency.
- Rendered evidence through the existing drivers at 390 px and desktop, en and
  uk, light and dark.

## 2. What exists today

| Surface | Observed behaviour | Where |
|---|---|---|
| Album entry | A desktop card foot button and a phone task-screen row. Both render nothing while the task has no pictures. | `src/components/taskAlbum/AlbumButton.tsx:28`, `:63`; mounted at `src/components/kanban/KanbanCard.tsx:985` and `src/components/mobile/MobileTaskScreen.tsx:1388` |
| Album counts on the board | One batched `GET /api/task-album?ids=…` per page every 45 s, which indexes transcripts under a 24 MiB byte budget per call. | `src/components/taskAlbum/albumSummaries.ts:19`, `:51`; `src/lib/taskAlbum/album.ts:26`, `:196-213` |
| Album dialog | A portalled dialog at `Z.modal` (66); images grouped by stage or conversation; the feed's `Lightbox` on tap; full screen on the phone; Escape through `useOverlayEscape`. | `src/components/taskAlbum/TaskAlbum.tsx:106`, `:209`, `:220` |
| What the album finds | Rasters only: inline bytes, files a Read or `view_image` opened, raster paths named in prose and tool input. | `src/lib/taskAlbum/extract.ts:46-53` |
| Document preview | One sheet mounted by the shell, opened through `previewBus`. It reads `GET /api/artifact?mode=meta`, then ranged content pinned by `If-Match`. Markdown renders through the feed's own grammar; HTML renders in a sandboxed frame; text, image and PDF panes exist. | `src/components/preview/ArtifactPreviewHost.tsx:159-452`, `src/components/preview/previewBus.ts:27`, `src/components/preview/DocumentPanes.tsx:59-124` |
| Preview layer | The sheet paints at `above("reader")` = 65, below `modal` = 66. Opened from the album, it would sit under the album dialog. | `ArtifactPreviewHost.tsx:388-391`, `src/components/layers.ts:58-64` |
| Markdown safety | `MarkdownDocument` builds React elements. Raw HTML in the text stays text. The only `dangerouslySetInnerHTML` is highlight.js output for code blocks, which escapes its input. React 19.2.8 replaces a `javascript:` href with a blocked URL. | `src/components/feed/markdownDocument.tsx:236-254`, `src/components/feed/markdown.tsx:100`; the guard string ships in `react-dom-client` |
| Bytes on disk | `/api/artifact` admits registered project folders, worktrees and stage scratch; evidence roots serve rasters only. It applies lexical then realpath admission, the workspace check, an `O_NOFOLLOW` open pinned to its place, a sniff, a 64 MiB bound and sandboxing headers. | `src/app/api/artifact/route.ts:92-203`, `src/lib/artifact/localFile.ts:61-93`, `src/lib/artifact/serve.ts:86` |
| A lane's changed files | `laneChangeFiles` lists `base..head` with `--numstat` and `--name-status`; `resolveLaneRevisions` pins head (branch tip, else last passed commit) and base (merge base with `origin/<base>`, else `baseRef`). The route is owner-only, opened from the lane's ⋯ menu, and is a diff review. | `src/lib/pipelines/laneChanges.ts:50-96`, `src/lib/team/workspaceRoutes.ts:117` |
| Live worktree reads | `laneChangeSummary` also runs `git status --porcelain` inside a running stage's worktree. | `laneChanges.ts:104-108`, `src/lib/pipelines/git.ts:1065` |
| Declared outputs | A read-only stage may declare repository-relative output files or directories; the controller alone commits them. The report's provenance records whether each was present. | `src/lib/pipelines/types.ts:129-131`, `:318-321` |
| Workspace gate | `/api/tasks/[id]/…` routes check the task's project. Every route also reads the query keys `path`, `paths` and `src` as conversation identities and `pipelineId` through the hot pipeline list only. | `src/lib/team/workspaceRoute.ts:226`, `:194`, `:164`, `:79-82` |
| Cache accounting | `MeasuredCache` charges entries to a named owner that `GET /api/onboarding/diagnostics?loop=1` reports. | `src/lib/cacheTelemetry.ts:88`, `docs/design/viewer-memory-telemetry.md` |

Two earlier lessons decide the content source:

- #3042 (`a81a444549`) moved Done-panel thumbnails into Delegatus state because
  lane paths are swept after a lane finishes. A preview that reads a lane's
  worktree breaks for exactly the tasks the operator checks after completion.
- #2761 (fixed in `8f1cfd5308`) found that album indexing under concurrent
  board views queued behind every await, and bounded it by byte budgets and
  time slices (`src/lib/taskAlbum/transcriptIndex.ts:20-25`). New work belongs
  on an explicit open, never on the board's beat.

## 3. Decision

The album dialog gains a second view, **Files**, beside **Images**. Its list is
derived on demand from each of the task's lanes at a pinned commit: the files
the lane added, changed or deleted between its merge base and its head, with
each stage's declared outputs marked as that stage's result. The commit is the
capture boundary. A builder's own commit and the controller's commit of a
read-only stage's declared outputs both produce it, so the manifest needs no new
store, no new MCP field and no write to the pipeline records. Opening a file
reads the blob at that commit from the lane's own repository, never the
filesystem, and shows it in the existing preview sheet with the existing panes.
Two small bounded caches, keyed by repository and object id, make warm opens
free. Nothing changes on the board's beat: the entry renders from data the card
already holds, and the list is read only when the Files view opens.

What it answers in the requirement's words: "files that were changed" are the
lane's committed changes; "documents it created" are its additions; "a handoff
file" is a declared output or any document the agent commits in its lane; the
"list of paths" is the lane's own Git record, which the server reads itself.

## 4. Options considered

| Option | Result |
|---|---|
| Collect document paths named in transcripts, as the album does for rasters | Rejected. Agents name many paths they never made, so the list is noisy; it extends transcript indexing and a filesystem stat per named file into the board summary's beat. |
| Serve the lane's worktree files through `/api/artifact` | Rejected as the source. Worktrees are swept after completion (#3042), the content is whatever is on disk now, and listing uncommitted files needs `git status` inside a live agent's worktree, where an index lock can collide with the agent's own Git commands. |
| A new `stage_report` field naming files, with a managed copy store | Not now. Open design #3644 proposes `stage_report.deliverables` with a content-addressed store for documents outside any checkout. Building a second field here would collide with it and with the MCP lane 83306a33 in `src/lib/mcp/server.ts` and `bindings.ts`. Files inside the lane already have a better record: the commit. See §13. |
| Persist a manifest on each attempt at settlement | Rejected. It grows the pipeline records the parent lane is profiling and duplicates what Git answers in tens of milliseconds. |
| **Lane commits as the manifest, blobs as the content, existing album and preview** | **Chosen.** |

## 5. The manifest: sources, producers, consumers

**Which lanes.** The client already holds the task's lanes: `card.pipelines`
on the desktop card and `lanes` on the phone task screen, both passed to
`TaskAlbum` as `pipelines` today. It asks for them by id. The server reads each
id with `findPipelineRecord` (hot store, then archive, by key) and keeps only a
lane whose `taskIds` contains the task. No full pipeline or archive scan runs
per request.

**Which files.** For each lane:

1. `resolveLaneRevisions(lane)` gives `{ base, head, headSource }`. It is
   unchanged and reused.
2. `laneChangeFiles(lane, base, head)` gives every changed path with its op,
   line counts and binary flag. It is unchanged and reused. `git status` is
   never run.
3. One `git --literal-pathspecs ls-tree -z -l <head> -- <paths>` over the
   listed, non-deleted paths (at most 200 after step 6) gives each one's mode
   and size: `file` (`100644`, `100755`), `link` (`120000`) or `submodule`
   (`160000`). Measured at 20 to 22 ms for 200 paths (§12).
4. A path that equals a stage's declared output, or lies under a declared
   output directory, is marked `declaredBy: <stageId>`.
5. Each path gets a group: `declared`, then `document`, `image`, `source`,
   `other`, with deletions last. Documents are `md markdown txt pdf html htm
   csv tsv json yaml yml toml log`. Images are the extensions
   `classifyArtifact` calls images. Source is every other extension
   `classifyArtifact` accepts. Everything else is `other`.
6. Sort by group, then Markdown first among documents, then path. Truncate to
   `LANE_CHANGE_LIMITS.files` (200) **after** sorting, so declared outputs and
   documents survive truncation. Report the real `total`. Step 3 runs on the
   truncated list, and its result is stored with the pair in the `lists` cache.

**Producers of the record.** Builders commit their work; the controller commits
a read-only stage's declared outputs (`types.ts:129-131`); lane authors declare
outputs in the stage definition. This design adds no producer.

**Consumers.** The new list route and content route (§6), the album's Files
view (§7), and the shared preview sheet (§7.4).

**Out of the manifest, deliberately:** files outside the lane's repository
(stage scratch, home folders), uncommitted work of a running stage, and tasks
whose work ran only in plain conversations. §13 keeps each.

## 6. Server

### 6.1 Module layout

`src/lib/taskFiles/` holds the logic, with ports for tests, following the
`src/lib/laneReview/` pattern:

- `files.ts`: lane resolution, grouping and sorting, the content resolution
  in §6.3, and the caps.
- `cache.ts`: the three caches and the two semaphores (§6.5). This is the one
  owner.
- `http.ts`: `taskFilesGET(req, taskId, deps)` and
  `taskFileContentGET(req, taskId, deps)`.
- `dependencies.ts`: production ports (`findPipelineRecord`, task lookup,
  `realExec`, `requestWorkspaceScope`).

Route files stay thin and are wrapped like every project route:

- `src/app/api/tasks/[id]/files/route.ts`: `GET = workspaceRoute("/api/tasks/[id]/files", …)`
- `src/app/api/tasks/[id]/files/content/route.ts`: `GET = workspaceRoute("/api/tasks/[id]/files/content", …)`

Both export `runtime = "nodejs"` and `dynamic = "force-dynamic"`, take
`params: Promise<{ id: string }>`, and answer from dynamic Route Handlers
without Next caching. The installed guides
`node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
and `03-api-reference/03-file-conventions/route.md` were read for this design;
`cacheComponents` is not enabled in `next.config.ts`.

Both routes join `WORKSPACE_ROUTES` as `"project"`
(`src/lib/team/workspaceRoutes.ts`). `workspaceRoutes.test.ts` enforces the
entry and the wrapper.

### 6.2 `GET /api/tasks/[id]/files?lanes=<id>,<id>…`

Query: `lanes`, from 1 to 5 lane ids, each matching `^[A-Za-z0-9_-]{1,64}$`.
The key is `lanes` on purpose: the gate reads `pipelineId` through the hot list
only, so an archived lane would refuse a member (`workspaceRoute.ts:79-82`, `:164`).
The handler makes the lane checks instead (§6.4).

Answer, `cache-control: private, no-store`:

```ts
type TaskFilesAnswer = { lanes: TaskFilesLane[]; omitted: number };

type TaskFilesLane =
  | { lane: string; status: "ok"; head: string; base: string;
      headSource: "branch" | "last-passed"; committedAt: number;
      files: TaskFile[]; total: number; truncated: boolean }
  | { lane: string; status: "unavailable";
      reason: "repository-missing" | "commits-gone" | "failed" | "busy" };

type TaskFile = {
  path: string;                 // repository-relative, as Git prints it
  op: "add" | "update" | "delete";
  added: number; removed: number; binary: boolean;
  mode: "file" | "link" | "submodule" | null;   // null when deleted
  size: number | null;                           // bytes at head; null when deleted
  group: "declared" | "document" | "image" | "source" | "other";
  // classifyArtifact accepts it, git does not call it binary, op is not delete,
  // mode is file, size <= 8 MiB
  previewable: boolean;
  declaredBy?: string;                           // stage id
};
```

`omitted` counts ids that were unknown, not bound to the task, or refused by
workspace (§6.4). It does not say which, so it reveals nothing about lanes the
caller cannot read.

Per lane: if `repoDir` does not exist, the answer is `repository-missing`. If
head or base cannot be resolved, it is `commits-gone`. A Git failure is
`failed`. A lane not finished within the request deadline, or refused by a full
queue, is `busy`. `committedAt` comes from `git show -s --format=%ct <head>`.

### 6.3 `GET /api/tasks/[id]/files/content?lane=<id>&head=<sha>&file=<path>[&mode=meta][&download=1]`

The key is `file`, never `path`: the gate reads `path` as a conversation
identity on every route (`workspaceRoute.ts:194`), which would refuse every
member.

Checks, in order. Each refusal reads no blob.

1. `rejectCrossOrigin`.
2. `lane` matches `^[A-Za-z0-9_-]{1,64}$`; `head` is 40 lowercase hex; `file`
   is 1 to 1,024 characters with no NUL, no leading `/`, and no `.` or `..`
   segment. Otherwise 400.
3. The task exists (404 `task_not_found`). `findPipelineRecord(lane)` exists
   and its `taskIds` contains the task (404 `lane_not_found`).
4. Workspace: when a scope applies and the caller is not the owner,
   `scope.canReadFile(lane.project)` must hold, else 403 `workspace_forbidden`.
5. The **resolved-file cache** (§6.5), keyed by lane, real `repoDir`, head and
   file, answers steps 6 to 9 when warm. Steps 1 to 4 run on every request.
6. `repoDir` exists (404 `not-found`). `resolveLaneRevisions(lane)` gives the
   current head. The requested head must equal it, or be its ancestor
   (`git merge-base --is-ancestor`), else 409 `head_unknown`. An earlier head
   stays readable after the branch moves on, so an open preview keeps paging.
7. Base for that head: `git merge-base <head> refs/remotes/origin/<baseBranch>`,
   else `baseRef`; when `baseRef` is a descendant of that merge base (a base
   branch that lags the lane's start, or a lane that landed) it starts the
   interval instead. An earlier head must descend from the tip's `baseRef`,
   else 409 `head_unknown`: the remote's base branch proves nothing about where
   the task began. The pair's file list (list cache) must contain `file`, else
   404 `not-listed`. An entry whose op is `delete` is 404 `not-found`.
8. `git --literal-pathspecs ls-tree -z -l <head> -- <file>` must print exactly
   one record whose path equals `file`. Mode `100644` or `100755` with type
   `blob` passes. Mode `120000` (a symlink) is 403 `symlink`. Mode `160000` (a
   submodule) is 415 `unsupported`. No record is 404 `not-found`. This gives the
   object id and the size.
9. `classifyArtifact(file)` must accept it, else 415 `unsupported`.
10. Meta (`mode=meta`) answers 200 with the `ArtifactMeta` shape plus revision
    fields, also when the size exceeds the preview bound:

    ```ts
    { name, kind, mime, size, mtimeMs /* commit time */, etag: `"g<oid>"`,
      revision: { head, committedAt, headSource },
      baseDir /* see §7.4 */ }
    ```

    For a size within the bound, meta first reads the blob (blob cache) and
    refuses a sniff mismatch with 415 `mime-mismatch`, as `/api/artifact` does.
11. Content: a size over the bound is 413 `too-large`. `If-Match` other than
    the etag is 412 `changed`. Otherwise the blob comes from the blob cache and
    `parseByteRange` serves 200, 206 or 416. Headers come from the same
    function `/api/artifact` uses, extracted from `route.ts:68-90` into
    `src/lib/artifact/serve.ts` as `artifactResponseHeaders(mime, etag, name,
    download)`: `nosniff`, the sandbox CSP (PDF keeps its existing exception),
    `content-disposition` with `dispositionFilename`, `accept-ranges: bytes`,
    `cache-control: private, no-store`. Markdown and every other text type go
    out as `text/plain; charset=utf-8`.

Every failure body is `{ error, code }` with the status map that
`failureFromStatus` (`src/components/preview/artifactResource.ts:206-213`)
already turns into the sheet's existing states: 404 missing, 403 denied, 415
unsupported, 413 oversized, 412 changed, anything else error with Reload. 409
and 503 land on error with Reload.

### 6.4 Authorization and threat cases

The task's project is checked by the gate. Every lane is checked by the handler,
on every request, against the record read by key. A cache hit never skips a
check: caches hold Git facts and bytes, never a decision.

| Threat | The check that holds | Test |
|---|---|---|
| Cross-origin or DNS-rebound page reads a blob | `rejectCrossOrigin` in both handlers | request with a foreign `Origin` is 403 and spawns no Git |
| Anonymous or revoked member | gate: 401 without a live session; scope signature rechecked after the handler (`workspaceRoute.ts:262-266`) | revoked session mid-request answers `workspace_forbidden` |
| Member of workspace B asks for task A | gate's `taskProject` check | 403 before the handler runs |
| Task A's member names a lane bound only to task B, in the same repository | `lane.taskIds.includes(taskId)` | 404 `lane_not_found`, and the blob cache holds that blob from the owner's earlier read |
| Lane bound to task A but in a project the member cannot read | `canReadFile(lane.project)` | list answers `omitted: 1`; content answers 403 |
| Project key moved (`dir-` to `repo-`, rename alias) | `canReadFile` resolves aliases (`workspaceAccess.ts:40-41`); cache keys hold no project key | a member of the new key reads; a member of an unrelated key is refused |
| Arbitrary path in the repository, history or another branch | `file` must be in the pair's change list, and the head must be the lane's head or its ancestor | an unchanged tracked file, a crafted head, another lane's head: 404 or 409 |
| Traversal, absolute path, NUL, glob characters | parameter rules in step 2; `--literal-pathspecs`; exact path equality in step 8 | `../x`, `/etc/x`, `a/*`, a NUL each 400 or 404 |
| Symlink committed in the lane | mode `120000` refused; nothing is read from disk | 403 `symlink` |
| Submodule, binary, unknown type, renamed binary | mode, `classifyArtifact`, `sniffAgrees` | 415 |
| Active content in Markdown, HTML or SVG | text served as `text/plain`, sandbox CSP, `nosniff`; Markdown rendered as React elements; HTML from Git never gets a frame scope; SVG drawn through `<img>` from an object URL | DOM test of §11.3 |
| Oversized blob, memory pressure | ls-tree size checked before reading; `maxOutputBytes`; caches bounded; queue bounded | 413 and 503, with cache bytes never above the cap |
| A slow repository holds the server | every Git call has a 10 s timeout; semaphores; list request deadline | the timeout fixture answers `busy` |

**Access level.** The routes are `"project"`, like the album and
`/api/artifact`, so a workspace member with read access to the lane's project
can list and read its committed files. That member can already read the same
files in the project's checkout and live worktrees through `/api/artifact`.
The owner-only lane review route (`workspaceRoutes.ts:117`) stays owner-only;
nothing here sends a message or reads a diff.

### 6.5 Caches: one owner, three maps, two semaphores

All live in `src/lib/taskFiles/cache.ts` as `MeasuredCache` instances with owner
`taskFiles/cache`, so the existing loop diagnostics report their counts and
bytes. Every entry records its insertion time. Eviction is least recently used,
plus an idle age checked on access and insertion; no timer runs.

| Cache | Key | Value | Bound | Idle age | Why it never needs invalidation |
|---|---|---|---|---|---|
| `lists` | real `repoDir`, base, head | the pair's full change list (for membership checks), the sorted and truncated `TaskFile[]` with modes and sizes, and the total | 128 entries and 8 MiB of payload | 30 min | A commit pair's diff never changes. A moved branch is a new key, because revisions are resolved on every list read. |
| `resolved` | lane id, real `repoDir`, head, file | base, oid, mode, size, kind, mime | 512 entries | 60 s | An object at a commit and path never changes. The 60 s bounds how long a force-pushed branch may keep serving an old head that is no longer its ancestor. |
| `blobs` | real `repoDir`, oid | `Buffer` | 24 MiB, 48 entries, 8 MiB per entry | 10 min | Content addressed. A re-cloned repository at the same path holds the same bytes under the same oid. |

**Never cached:** the lane record, the task binding, the workspace decision,
and the lane's current head on a list read.

**Coalescing.** An in-flight `Map<key, Promise>` per cache: concurrent identical
list or blob reads share one Git process. A pdf.js viewer firing several ranges
at once costs one `cat-file`.

**Concurrency.** `cat-file` reads: 2 at once in the process, 16 waiting, then
503 `busy` with `retry-after: 2`. Lane list computations: 2 at once, 32 waiting,
then the lane answers `busy`. A list request has an 8 s deadline overall.

**Cancellation.** A lane list, a content resolution and a blob read each run
once per identical caller and hold their admission slot until their own Git
work has ended. The run's children carry the run's abort signal: when the last
waiter leaves (a closed request or the deadline) the children are killed, and
the slot frees only after they have closed, so cancelled requests never let
more work run than the line allows. A queued run with no waiter left leaves the
line and never starts. A run whose waiters all left caches nothing. On the
client, the Files view aborts its list read on close, and every pane already
aborts its own fetches on close (`TextPane.tsx:113-121`,
`ImagePane.tsx:51-75`).

**Fresh generation.** Nothing persists. A Viewer restart starts every cache
empty; the first open after it pays the cold costs in §11.

### 6.6 Caps

| Cap | Value | Basis |
|---|---|---|
| Lanes per list request | 5 | The client pages lanes, newest first by `createdAt` |
| Files per lane | 200, after sorting | existing `LANE_CHANGE_LIMITS.files` (`laneChanges.ts:15`); lanes on `main` have p99 110 files (`docs/design/lane-diff-comments.md` §1) |
| Preview bytes per file | 8 MiB | largest blob at the base revision is 6.3 MiB; five blobs exceed 2 MiB; Markdown p99 is 142 KiB and the largest is 335 KiB (§12) |
| Markdown rendered | first 2 MiB, existing | `MARKDOWN_RENDER_BYTES` (`DocumentPanes.tsx:20`) |
| Text page, PDF range | 256 KiB and 64 KiB, existing | `TextPane.tsx:19`, `PdfPane.tsx:13` |
| Git call timeout | 10 s, existing | `laneChanges.ts:17` |
| Git output | 8 MiB, existing `realExec` default | `src/lib/workflows/provision.ts:78` |
| Caches | §6.5 | worst case about 34 MiB of payload |

### 6.7 What the board never does

- No new request on render or on the 45 s album beat. The entry renders from
  `card.pipelines.length` and `remote`, which the card already has.
- No Git, no stat and no file read for a card that is merely drawn.
- `albumSummaries.ts`, `/api/task-album` and the transcript indexer are
  unchanged.

## 7. Client

### 7.1 Entry

- **Desktop card.** `CardAlbumButton` takes `filesAvailable`, which
  `KanbanCard` sets to `!remote && card.pipelines.length > 0`. The button
  renders when there are pictures or `filesAvailable`. With pictures it looks as
  it does today. Without pictures it shows a `FileText` icon alone with a title
  and aria label. It opens the dialog on Images when there are pictures, else on
  Files.
- **Phone task screen.** The Images row stays as it is. A **Files** row follows
  it when `filesAvailable`, with the same row class and chevron, and opens the
  same dialog on Files.

### 7.2 The album dialog

`TaskAlbum` takes `filesAvailable` and `initialView: "images" | "files"`.
Without files the dialog is exactly today's. With files:

- A segmented control of two `aria-pressed` buttons, Images and Files, in the
  existing `ModeToggle` style (`DocumentPanes.tsx:31-53`). It sits in the header
  row on desktop, and as a full-width row of two 44 px buttons under the header
  on the phone.
- The header title follows the view. The subline keeps today's image count on
  Images and shows the task title alone on Files.
- **Images load only when the Images view is first shown.** Today the album
  loads them on mount and marks them seen (`TaskAlbum.tsx:132-141`). A dialog
  opened on Files must not mark pictures seen that nobody looked at.
- Files load only when the Files view is first shown, and never poll.

### 7.3 The Files view

`src/components/taskAlbum/TaskFiles.tsx` takes the task id, the task's
pipelines and the locale.

- **Lanes.** Newest first by `createdAt`. The first 5 are requested at once;
  "Show older lanes" requests the next 5.
- **Lane group header.** The lane's title (the first line of `pipeline.task`,
  through `cleanTitle`), then `at <7-char head>` with the commit time in its
  title, and "last passed commit; branch removed" when `headSource` is
  `last-passed`. A running lane adds one muted line saying its uncommitted
  changes appear after it commits.
- **Rows** in the server's order. Each row shows a kind glyph, the basename in
  monospace, the op word (new, changed, deleted), and `+added −removed` or
  "binary". A second line shows the directory, truncated from the start; a file
  at the repository root has none, and its size sits beside its counts. Text
  that explains a row that cannot open uses the secondary text colour, so it
  keeps the 4.5:1 floor, and the row is told apart by its muted glyph.
  A declared output adds "<stage name> result", named with `stageDisplayName`
  from the client's own pipeline.
  - A previewable row is a button with `aria-label` "<name>, <op>, in <dir>.
    Open".
  - A deleted, symlink, submodule, oversized or unsupported row is a plain
    list item ending in "deleted", "link", "submodule", "too large to preview"
    or "no preview". It is not focusable.
  - The second line also carries the size at head (`formatBytes`).
  - The lane heading names the lane only when the task has several lanes or
    the lane's title differs from the dialog's subtitle; a lone lane named like
    the task keeps its heading for screen readers. A lane whose repository
    cannot be read shows only that reason.
  - The preview sheet opened above the album dims the album with the same scrim
    the album puts over the board; a click on the scrim closes the sheet.
- **Visible versus folded.** Declared, document and image rows show, up to 24
  per lane. Every other row sits behind "Show N other changed files", which
  toggles in place. That keeps source files as metadata until asked for.
- **Notes.** "N more files not listed" when truncated. "No committed changes in
  this lane yet" for an empty lane.
- **Lane states.** Unavailable lanes say why in one line ("repository isn't on
  this machine", "commits are no longer in the repository", "couldn't read",
  "still reading"); the last two carry Retry, which asks for that lane alone.
- **View states.** Loading (spinner and the existing "Loading…", `role=status`),
  failed (the album's alert style with Retry), empty ("No committed files yet…"),
  and the older-lanes failure line beside its button, as the album does.

Layout uses the album's existing tokens and spacing (`TaskAlbum.tsx:254-308`).
Rows are at least 44 px tall on the phone and 32 px on desktop. The basename
truncates with its full value in `title`.

### 7.4 Opening a file in the existing preview

A row press calls:

```ts
openArtifactPreview(file.path, { kind: "file", path: file.path, line: null, column: null, anchor: null }, {
  source: { metaUrl: `${base}&mode=meta`, contentUrl: base },
  layer: "overlay",
});
// base = `/api/tasks/${taskId}/files/content?lane=…&head=…&file=…`
```

The changes to the shared preview stay additive; every existing caller keeps
its behaviour:

- `previewBus.ts`: `ArtifactPreviewRequest` gains optional
  `source?: { metaUrl: string; contentUrl: string }` and
  `layer?: "overlay"`. `openArtifactPreview` takes them as a third argument.
- `ArtifactPreviewHost.tsx`: `OpenRequest` carries `source` and `layer`. The
  meta read uses `source.metaUrl` when present. Panes get
  `contentUrl = source?.contentUrl ?? artifactContentUrl(target.path)`.
  Download is `contentUrl` plus `download=1`. "Open in a new tab" is
  `contentUrl`. The sheet paints at `LAYER.overlay` when the request says so; a
  later request that names no layer (a link clicked inside the open document)
  keeps the open sheet's layer. The `#a=` fragment entry never carries a source
  or a layer. The header subline adds `at <sha>` when `meta.revision` is
  present.
- `artifactResource.ts`: `ArtifactMeta` gains optional `revision` and
  `baseDir`.
- `DocumentPanes.tsx` (`MarkdownPane`, `HtmlPane`), `TextPane.tsx`,
  `ImagePane.tsx`, `PdfPane.tsx`: an optional `contentUrl` prop, defaulting to
  `artifactContentUrl(path)`. `MarkdownPane` uses `meta.baseDir ??
  directoryOf(path)` as the document's base. `HtmlPane` is never reached for a
  Git source, since its meta carries no `frame`; HTML opens as source text.
- `src/app/api/artifact/route.ts`: `baseHeaders` moves to
  `serve.ts` as `artifactResponseHeaders`. That is one hunk, and `route.test.ts`
  must pass unmodified.

**Relative links inside a previewed task document** resolve against
`meta.baseDir`: the file's directory in the lane's worktree when it still
exists, else in the repository checkout. They open the file currently on disk,
through `/api/artifact` and all its checks, in the same sheet. The document
itself is the committed revision, and its header says which. Resolving such
links to the same lane revision needs a hook in `markdown.tsx`, which open
PR #3705 is changing (§13).

**Escape, focus and phone.** The sheet already pushes its own modal layer, traps
Tab and restores focus to the opener (`ArtifactPreviewHost.tsx:253-256`,
`src/components/modalLayer.ts:86-106`). It is pushed after the album's escape
entry, so Escape closes the sheet first and the album second. On the phone the
sheet covers the screen with 44 px Download, Open and Close controls; Close
returns to the list with focus on the row. Pinch zoom on images is existing
behaviour. On desktop the list stays visible to the left of the sheet, and
pressing another row switches the sheet, as conversation links already do.

### 7.5 Strings (en / uk)

New keys sit beside the `album.*` block (`src/lib/i18n/en.ts:2308-2332` and its
uk twin).

| Key | en | uk |
|---|---|---|
| `files.title` | Files | Файли |
| `album.viewAria` | Show images or files | Показати зображення або файли |
| `album.dialogAriaFiles` | Images and files of «{title}» | Зображення і файли «{title}» |
| `album.buttonAriaFilesOnly` | Open the files of «{title}» | Відкрити файли «{title}» |
| `album.buttonAriaWithFiles` | Open images and files of «{title}»: {count} image / images | Відкрити зображення і файли «{title}»: {count} зображення / зображень (one, few, many, other) |
| `files.empty` | No committed files yet. Files this task's lanes add or change appear here after each commit. | Закомічених файлів ще немає. Файли, які лінії цієї задачі додають або змінюють, з'являються тут після кожного коміту. |
| `files.failed` | Couldn't load the files | Не вдалося завантажити файли |
| `files.at` | at {sha} | на {sha} |
| `files.committedAt` | Committed {time} | Закомічено {time} |
| `files.lastPassed` | last passed commit; branch removed | останній прийнятий коміт; гілку видалено |
| `files.running` | The running stage's uncommitted changes appear after it commits. | Незакомічені зміни етапу, що працює, з'являться після коміту. |
| `files.op.add` / `.update` / `.delete` | new / changed / deleted | новий / змінений / видалений |
| `files.declared` | {stage} result | Результат: {stage} |
| `files.binary` | binary | двійковий |
| `files.noPreview` / `files.link` / `files.submodule` | no preview / link / submodule | без перегляду / посилання / підмодуль |
| `files.tooLarge` | too large to preview | завеликий для перегляду |
| `files.more` | Show {count} other changed file / files | Показати ще {count} змінений файл / змінені файли / змінених файлів |
| `files.less` | Hide other changed files | Сховати інші змінені файли |
| `files.truncated` | {count} more file / files not listed | Ще {count} файл / файли / файлів не показано |
| `files.noChanges` | No committed changes in this lane yet. | У цій лінії ще немає закомічених змін. |
| `files.unavailable.repository` | This lane's repository isn't on this machine. | Репозиторію цієї лінії немає на цьому комп'ютері. |
| `files.unavailable.commits` | This lane's commits are no longer in the repository. | Комітів цієї лінії вже немає в репозиторії. |
| `files.unavailable.busy` | Still reading this lane. | Ще читаю цю лінію. |
| `files.unavailable.failed` | Couldn't read this lane's changes. | Не вдалося прочитати зміни цієї лінії. |
| `files.olderLanes` | Show older lanes | Показати старіші лінії |
| `files.olderFailed` | Couldn't load older lanes. Press Show older lanes to try again. | Не вдалося завантажити старіші лінії. Натисніть «Показати старіші лінії», щоб спробувати ще раз. |
| `files.rowAria` | {name}, {state}, in {dir}. Open | {name}, {state}, у {dir}. Відкрити |
| `preview.revision` | at {sha} | на {sha} |

Plural keys follow the existing `{ one, other }` and `{ one, few, many, other }`
shapes. Retry and Loading reuse `album.retry` and `common.loadingCap`.

## 8. Shared paths: every producer, consumer and default

| Path | Who reaches it | Effect |
|---|---|---|
| `openArtifactPreview` | `markdown.tsx` `FileAnchor`, file chips and any other existing caller | Third argument optional; existing calls unchanged |
| `ArtifactPreviewHost` | Viewer shell (`Viewer.tsx:2065`), memory cases, fixtures | Defaults keep the `/api/artifact` source and the `above("reader")` layer |
| Panes | the host only | `contentUrl` defaults to today's URL |
| `ArtifactMeta` | host, panes, `/api/artifact` meta | Optional fields only |
| `artifactResponseHeaders` | `/api/artifact` and the new content route | Same header values; `route.test.ts` unmodified proves it |
| `resolveLaneRevisions`, `laneChangeFiles` | lane review routes and the new routes | Called unchanged; `laneChangeSummary` is not used |
| `TaskAlbum`, `CardAlbumButton`, `PhoneAlbumRow` | `KanbanCard`, `MobileTaskScreen` | New props default to today's behaviour (`filesAvailable = false`, `initialView = "images"`) |
| `WORKSPACE_ROUTES` | gate, proxy, coverage test | Two `"project"` entries |
| `MeasuredCache` registry | loop diagnostics | One new owner, `taskFiles/cache`; add its row to `docs/design/viewer-memory-telemetry.md` |

## 9. Overlap with open work, and what stays untouched

Checked on 2026-11-06 against the actual diffs of every open PR (20) and the six
lanes the brief names.

| Change | Overlap found | Handling |
|---|---|---|
| #3705, lane 46044220, head `98c2919eb7` | Edits `markdown.tsx`, `linkTarget.ts`, `FeedItem.tsx`, `LogFeed.tsx`, `LiveTurnRows.tsx` and the conversation-window driver. Its design names `ArtifactPreviewHost`, `previewBus`, `artifactResource`, `DocumentPanes` and `markdownDocument` as read-only for it. | This design edits none of its files and does not touch link resolution. It adds optional props to the preview files it only reads. It does not take over, rebase or merge that lane, and repeats none of its repair. Same-revision relative links wait for it (§13). |
| #3682, lane d1492858 (accounts panel) | `en.ts`, `uk.ts`, the kanban driver and fixture. Its fixture hunks sit at the fetch router near line 4191 and at 5577; its driver hunks are in the spending block. | New keys go in the `album.*` block (en 2308-2332); the driver case goes in the album `describe` (`kanbanBoard.browser.test.tsx:17746`); the fixture answer goes beside the album answers (`issue1695Evidence.fixture.tsx:4367-4383`). |
| #3650, lane f4f4e20e (settings) | The same three files plus `modalLayer.ts` and `useIsMobile.ts`. | Same placement. `modalLayer.ts` and `useIsMobile.ts` are not edited. |
| Lane 83306a33 (MCP claims) | `src/lib/mcp/server.ts`, `bindings.ts`, registry and pipeline store. | No MCP, registry or store change here. |
| Lane 29a4b3ce (attempt temp cleanup), lane d72e9ed7 (seat tick) | Retention, sweeps, seat tick, files response worker. | Not touched. |
| #3644 (design only, `docs/design/agent-document-handoff.md`, no lane found) | Proposes `stage_report.deliverables` and a managed store for documents outside a checkout. | Not built here; see §13. Nothing here blocks it. |
| #3714 (`37556e0bbe`, in the base) | Role-title and review grouping index. | Preserved; not touched. |

The parent lane owns `registry`, `sqliteRegistryStore` and `MemoryProfile`
performance. This design reads pipelines by key and adds no registry work.

## 10. Exact files to build

| File | Change |
|---|---|
| `src/lib/taskFiles/files.ts` (new) | Lane resolution, grouping, sorting, content resolution, caps |
| `src/lib/taskFiles/cache.ts` (new) | Three `MeasuredCache` maps, coalescing, two semaphores, test seam to reset |
| `src/lib/taskFiles/http.ts` (new) | `taskFilesGET`, `taskFileContentGET` |
| `src/lib/taskFiles/dependencies.ts` (new) | Production ports |
| `src/lib/taskFiles/files.test.ts`, `http.test.ts` (new) | §11.1, §11.2, and the gated measurement in §11.4 |
| `src/app/api/tasks/[id]/files/route.ts`, `…/files/content/route.ts` (new) | Thin wrapped handlers |
| `src/lib/team/workspaceRoutes.ts` | Two `"project"` entries |
| `src/lib/artifact/serve.ts`, `src/app/api/artifact/route.ts` | Extract `artifactResponseHeaders`; route uses it |
| `src/components/preview/previewBus.ts`, `ArtifactPreviewHost.tsx`, `artifactResource.ts`, `DocumentPanes.tsx`, `TextPane.tsx`, `ImagePane.tsx`, `PdfPane.tsx` | §7.4 |
| `src/components/taskAlbum/TaskFiles.tsx` (new), `TaskFiles.dom.test.tsx` (new) | §7.3, §11.3 |
| `src/components/taskAlbum/TaskAlbum.tsx`, `AlbumButton.tsx`, `TaskAlbum.dom.test.tsx` | §7.1 and §7.2; existing tests keep passing |
| `src/components/kanban/KanbanCard.tsx`, `src/components/mobile/MobileTaskScreen.tsx` | Pass `filesAvailable`; phone Files row |
| `src/lib/i18n/en.ts`, `uk.ts` | §7.5 |
| `src/components/kanban/kanbanBoard.browser.test.tsx`, `issue1695Evidence.fixture.tsx` | One case in the existing album `describe` (§11.5) |
| `docs/design/viewer-memory-telemetry.md` | One inventory row for `taskFiles/cache` |

Nothing else: no MCP, engine, store, registry, spawn, prompt, runtime-host or
settings change.

## 11. Verification plan

Run each test file by explicit path through the project's
`scripts/gate-slot.sh` with the pinned Bun, from a scratch export of the head,
with private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` and
`LLV_VIEWER_CONTROL_URL` on a closed port. Write each new test first and show
it red on the base where it can be. No sweeping runtime suites. Fixtures are
owned and synthetic; the live installation's tasks are never inputs.

### 11.1 `files.test.ts` (logic, real Git)

Build the repository with `createLaneRepo` (`src/lib/laneReview/gitFixture.ts`)
plus: a declared-output directory with two Markdown files, a 1.5 MiB Markdown
file, a 4 MiB PDF, a 9 MiB text file, a PNG, a committed symlink, a gitlink entry, an `.env`-shaped
file, a lane with 250 changed files, and a second lane bound to another task in
the same repository.

- Modes and sizes from the one `ls-tree` per lane: the symlink is `link`, the
  gitlink is `submodule`, the 9 MiB text blob carries its size, and all three
  have `previewable: false`.
- Grouping and order: declared before documents before images before source
  before other, deletions last; truncation after sorting keeps every declared
  and document row; `total` is the real count.
- Revisions: branch tip; `last-passed` once the branch ref is deleted;
  `commits-gone` once both are unresolvable; `repository-missing`.
- No `git status`: an `ExecPort` spy records every Git argument list and finds
  none.
- Caches: a second identical list spawns only the revision commands; eight
  concurrent identical blob reads spawn one `cat-file`; the blob cache never
  exceeds 24 MiB or 48 entries; idle entries leave after their age with an
  injected clock; the per-entry cap refuses to cache 8 MiB plus one byte.
- Queue: a third concurrent distinct read waits; the seventeenth waiting read
  answers busy; an aborted queued read never spawns.

### 11.2 `http.test.ts` (routes, threat cases)

Through the real handlers with fixture ports, plus one pass through the wrapped
route exports for the gate:

- Every row of §6.4, each asserting the status, the code, and that no blob was
  read where the check comes first.
- Meta then content for Markdown, text, PNG, PDF: the content hash equals the
  committed blob; `If-Match` mismatch 412; range 206; bad range 416; oversized
  413 with meta 200; sniff mismatch 415; headers equal `/api/artifact`'s for the
  same type.
- A head that moved on: the old head keeps serving; a force-pushed unrelated
  head is 409 after the `resolved` age.
- Cache isolation: the owner reads a blob, then a member of another workspace
  and a member of the other task each get their refusal and no bytes.
- Project key moved through an alias: the new key's member reads.
- `workspaceRoutes.test.ts` and `src/app/api/artifact/route.test.ts` pass
  unmodified.

### 11.3 DOM tests

`TaskFiles.dom.test.tsx`, plus additions to `TaskAlbum.dom.test.tsx` and the
existing preview DOM tests:

- No fetch to `/api/tasks/*/files*` while a board of cards renders and the 45 s
  beat advances; the first fetch happens when the Files view opens. The Images
  view's load and seen-mark do not run when the dialog opens on Files.
- Every state of §7.3 by its defining text; keyboard order through segment,
  rows, fold toggle and older-lanes button; non-previewable rows not focusable.
- A row opens the sheet at the overlay layer above the album; Escape closes the
  sheet, then the album; focus returns to the row.
- Markdown with `<script>`, an `<img onerror>`, a raw HTML block,
  `[x](javascript:…)` and `[y](data:text/html,…)` renders no script, image or
  frame from them, and no anchor whose href runs code.
- Existing callers of the preview without `source` or `layer` behave as before.

### 11.4 Cold and warm measurements

A gated block in `http.test.ts` (`LLV_TASK_FILES_MEASURE=1`) writes readings
JSON under `$LLV_EVIDENCE_DIR/task-files-measure/`. It runs on the §11.1 fixture
and reports the commit it ran on, the load average, and the process start time
as the cache generation.

- Five rounds, alternating cold (caches reset) and warm, for: the list of 3
  lanes; meta plus first content of the 40 KiB and 1.5 MiB Markdown files and
  the 4 MiB PDF; eight concurrent identical requests; eight concurrent distinct
  requests.
- Per request: latency, Git spawns, `process.cpuUsage` delta, the cache hit,
  and the hit entry's age.
- Per round: `process.memoryUsage()` `rss`, `heapUsed`, `external` and
  `arrayBuffers` before, after filling the blob cache to its cap, and after
  eviction; the `taskFiles/cache` counts and bytes.
- **Before and after on identical load:** the board beat. A new case in the
  existing `TaskAlbum.dom.test.tsx` renders twenty cards' album entries (half
  with lanes, half with pictures), advances the 45 s beat ten times and records
  every request and every `ExecPort` call. Copy that case unchanged into a base
  export, as `docs/design/viewer-memory-telemetry.md` did for its driver, and run
  base and head alternately under the same gate admission, five rounds each.
  Requests per beat must be equal and Git calls zero on both. This proves that
  nothing was added to the beat; it claims no speedup.

Report the numbers as measured against the §6.6 caps. A new feature has no
"before" for its own routes, so it claims no improvement.

### 11.5 Rendered evidence through the existing driver

Add one `browserTest` in the album `describe` of
`src/components/kanban/kanbanBoard.browser.test.tsx`
(`LLV_KANBAN_BROWSER_TEST=1`, `CHROME_BIN`). The fixture's fetch router hands
`/api/tasks/:id/files*` to the driver (`serverFetch`, as other cases do). The
driver answers with the real `taskFilesGET` and `taskFileContentGET` over a Git
repository it builds in its own temporary directory with neutral documents, so
the frames show real authorization and real bytes. No new driver file.

- Widths 390 (touch), 820 and 1440; en and uk; light and dark.
- States: card entry with and without pictures; phone Files row; Files view
  with declared outputs, documents, the fold, truncation, the running note, an
  unavailable lane, the empty view and loading; Markdown rendered and source;
  text; image; PDF; unsupported, deleted, oversized, link and submodule rows;
  the sheet's denied and oversized states through a direct open of the symlink
  and the 9 MiB file.
- Readings from text ranges: each state's defining text on the first screen; no
  row cut by a scroll edge or the sheet; the sheet above the album by a hit
  test; 44 px targets on the phone; focus after close.
- Run from a scratch export so `.artifacts/` stays out of the worktree; set
  `TASK_ALBUM_PNG_DIR` under `$LLV_EVIDENCE_DIR`. Readings JSON may join
  `evidence/task-album/` with fixture content only. Every frame is looked at
  directly, without OCR.

### 11.6 Project checks

Touched test files by path; `eslint` on changed files; the privacy gate on the
changed files with the committed fingerprints; then the pre-push hook at
publication. The backend routes and caches are high risk and take three review
rounds; the UI takes two; the visual critic takes two.

## 12. Measurements taken for this design

Read-only Git on the shared object store at the base revision, 2026-11-06 about
08:48 UTC, Git 2.43.0, 24 cores, 1-minute load average 4.25 to 4.47, three runs
each. Scripts and logs are retained under this stage's evidence directory
(`design-measurements/`), outside the worktree.

| Call (what the routes run) | Measured |
|---|---|
| `rev-parse` of a branch tip | 4 to 5 ms |
| `merge-base` with `origin/main` | 4 to 6 ms |
| `diff --numstat -z`, lanes of 11, 18, 19, 36 and 73 files | 14 to 18, 9 to 10, 54 to 55, 42 to 51, 66 to 82 ms |
| `diff --name-status -z`, same lanes | 5 to 7 ms |
| `ls-tree -l` of one path | 4 to 5 ms |
| `ls-tree -l` of 200 paths in one call | 20 to 22 ms |
| `cat-file blob`, 4 KB / 90 KB / 0.9 MB / 3.3 MB | 4 to 5 / 5 to 6 / 5 to 7 / 13 to 17 ms |

At the base revision the repository holds 7,737 blobs; the largest is
6,626,093 bytes, five exceed 2 MiB and none exceeds 8 MiB. Its 643 Markdown
files have p50 15,351 bytes, p90 60,491, p99 145,319 and a maximum of 343,531.
Of the last 300 commits on `main`, 127 touched Markdown, with p90 2 Markdown
files and a maximum of 68.

So a cold list of five typical lanes costs about 5 × (5 + 5 + 50 + 6 + 5 + 20)
ms of Git (rev-parse, merge-base, numstat, name-status, commit time, ls-tree),
near 455 ms with concurrency 1 and about half with 2. A cold Markdown open
costs about 30 ms of Git; a warm open of a cached blob spawns nothing after the
`resolved` entry is warm. These are estimates from the table, to be replaced by
§11.4's measurements of the built routes.

## 13. Deferred — not currently justified

- **Documents outside the lane's repository** (stage scratch, home folders) and
  an agent's explicit handoff list. Open design #3644 proposes
  `stage_report.deliverables` with a managed store. When it lands, its entries
  can join the Files view as a "Handed over" group served by `/api/artifact`.
  Building a second contract now would collide with #3644 and with lane
  83306a33.
- **A new `stage_report` field to highlight files.** Declared outputs and
  committed documents already do it.
- **Uncommitted changes of a running stage.** Listing them needs `git status`
  inside a live agent's worktree; the note in §7.3 says when they appear.
- **Tasks whose work ran in plain conversations.** They have no commit
  boundary; finding their files means a transcript census.
- **A file count on the card.** It would put Git on the board's beat.
- **Relative links and images that resolve within the same lane revision.**
  This needs a resolver hook in `markdown.tsx`, which #3705 is changing; revisit
  after it merges.
- **Blocking remote images in previewed Markdown.** This is existing behaviour
  of every document preview, and also a `markdown.tsx` change.
- **HTML reports from Git rendered as pages.** They need a frame scope over a Git
  tree; they open as source.
- **Downloads of unsupported types and of files over 8 MiB.** Metadata only.
- **Diffs inside the album.** The owner's lane review sheet exists.
- **Search or filters in the list; a persisted manifest; browser HTTP caching
  of blobs.** Not needed at these sizes, and `no-store` keeps revocation
  immediate.

## 14. Validation against the requirement

| Requirement | Met by |
|---|---|
| Beyond pictures: changed files, with a convenient preview | §5, §7.2 to §7.4 |
| Documents the agent created, at least rendered Markdown | additions and declared outputs (§5); `MarkdownPane` (§7.4) |
| A handoff file or a list of created files | declared outputs and committed documents, marked and listed first (§5); out-of-tree handoff deferred to #3644 (§13) |
| Fast, without overloading the server; correct caching | lazy list and content (§6.7, §7.2); caps and caches (§6.5, §6.6); measured costs (§12, §11.4) |
| Earlier lessons | commit-pinned content survives worktree sweeps (§2, #3042); nothing on the board's beat (#2761); no live worktree status (§4) |
| Images keep working | Images view unchanged; it loads only when shown (§7.2) |
| Boundaries: auth, workspace, symlink, root, revision | §6.3, §6.4 |
| States, keyboard, focus, phone | §7.3, §7.4, §11.3, §11.5 |
| Rendered at 390 px and desktop, en and uk, light and dark | §11.5 |

## Notes

- `laneChangeSummary` runs `git status` without `GIT_OPTIONAL_LOCKS=0` in a
  live stage's worktree (`laneChanges.ts:104-108`, `git.ts:1065`). That is the
  owner's lane review, outside this scope, and worth its own look.
- The existing album dialog has no Tab trap of its own (`TaskAlbum.tsx:106`
  uses only the escape stack). This design leaves that unchanged; the sheet it
  opens traps Tab while it is open.
