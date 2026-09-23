# PR and issue chips on pipelines and task cards (#2059)

## The originating requirement

Issue #2059, opened by the operator on 2026-09-23, quoted verbatim:

> ## Outcome
>
> On the board, every pipeline (and the task card that carries it) shows clickable chips for the GitHub work it belongs to: the pull request with its number and state (open, draft, merged, closed) as a coloured chip, and the linked issue. A pipeline whose branch has no PR yet shows that plainly, so the operator can tell at a glance which lanes have a PR and which do not. One click opens the PR or issue on GitHub.
>
> ## Requirements
>
> - Links are attached to the pipeline first; the task card aggregates the links of its pipelines (plus any attached to the task directly).
> - Automatic discovery: when a PR exists for a pipeline's delivery branch (the `pipeline/<slug>` head, or the recorded `delivery.pr`), it is picked up without anyone attaching it by hand. Stage provenance already queries `gh pr list --head <branch>` at stage report time (`src/lib/pipelines/stageProvenance.ts`); reuse that knowledge instead of adding a second poller where possible, and keep network work out of pipeline locks.
> - Manual attach and detach of a PR or issue URL/number on a pipeline or task, through both the UI and the MCP/HTTP API, for cases discovery cannot see (lane branch differs from PR branch, work delivered via another PR).
> - Many-to-many: a task can carry several PRs and issues; several tasks or pipelines can point at the same PR (retries, successor lanes, fix rounds). The design must first measure how often each case actually occurs in the current registry and board data, and render both cases readably.
> - Existing branches: backfill so pipelines already on the board show their PR or "no PR" state after deploy.
> - Chips must fit the existing card design at 390 px through desktop widths, in en and uk.
>
> ## First step
>
> Measure the real data before designing: count pipelines with a delivery branch, with a PR found by branch, with `delivery.pr`, tasks spanning several PRs, PRs shared by several tasks or pipelines, and issue references in task text. Report the numbers in the design note.

The pinned stage specification adds three constraints, which this design treats
as part of the requirement: any extra `gh` call runs outside pipeline registry
locks, is time-bounded and cached, and never runs per request on the board's
`/api/files` path. Manual input is normalized, and `#2059`, `2059` and a full
URL are all accepted. Chips must not overlap or clip titles at 390, 768, 1080
and 1440 px.

## 1. Measurement (2026-09-23)

### How the numbers were taken

- **Registry.** `list_pipelines` over MCP reported 179 active pipelines, so I
  took a read-only `.backup` of `state/state.sqlite` into a scratch directory
  and counted there, with no write to the live store. The copy has 179 rows in
  `pipelines`, the collection the board reads, the same count MCP reported. It
  also has 1454 in `pipelines_archive` and 1621 task rows. "Board" below means
  the 179 active pipelines and "all" means active plus archive. A task is
  joined to its pipelines through `Pipeline.taskIds`. `BoardTask.pipelineIds`
  is filled on only 20 tasks, so it is not the join.
- **Forge.** `gh pr list --state all --limit 500 --json number,headRefName,state,title,body`
  as the spec asks. I also fetched the whole repository (`--limit 2500`), which
  returned 1016 PRs: 960 merged, 47 closed, 9 open, 11 of them draft. The
  500-PR window only reaches back to #967, so it undercounts older lanes. The
  figures below use the full list. Every board figure is identical under the
  500-PR window. Only the all-pipelines lane-branch count changes: 400 with
  the window, 595 with the full list.
- **Matching.** A pipeline's "delivery branch" is `delivery.target.branch` with
  `refs/heads/` stripped. Its lane branch is `Pipeline.branch`. A PR "by head"
  is one whose `headRefName` equals that branch. Issue references are
  `#N` (2–5 digits, not part of a URL or an HTML entity) or
  `github.com/<owner>/<repo>/issues/N`. Closing references use GitHub's own
  keyword set (`close[sd]`, `fix(e[sd])`, `resolve[sd]`).

### Pipelines and branches

| | board (179) | all (1633) |
|---|---|---|
| pipelines in this repository (the rest belong to 4 other repositories) | 150 | 1450 |
| lane branch set (`Pipeline.branch`) | 179 | 1633 |
| delivery branch set (`delivery.target.branch`) | **147** | 147 |
| … delivery branch differs from the lane branch | 46 | 46 |
| delivery branches in this repository that have a PR by head | **76 / 128** | 76 / 128 |
| lane branches in this repository that have a PR by head | 68 / 150 | 595 / 1450 |
| `delivery.pr` recorded | **22** | 22 |
| … `delivery.pr` not found by either head | 1 | 1 |

`delivery` is a recent field, which is why its counts are identical in both
columns. The 46 lanes whose delivery branch differs from the lane branch are
the case the issue names. Of the 45 in this repository, **31 have their PR only
on the delivery head, 11 only on the lane head, none on both, and 3 on
neither**. Discovery therefore has to ask about both heads.

Seven head names carry two or more PRs, for example one hotfix branch reused
for 15 PRs. All seven are hand-named branches. 22 head-matched PRs on the board
were opened before their lane was created, and 21 of those are named by
`delivery.pr` (fix-round lanes). The only unexplained one is the case a
"PR created at or after the lane" rule would drop.

### Stage provenance

| | board | all |
|---|---|---|
| attempts carrying a provenance record | 299 | 630 |
| … with `provenance.pullRequest` non-null | **168** | 409 |
| pipelines with at least one provenance PR | 72 | 133 |
| pipelines whose provenance names 2+ distinct PRs | 0 | 0 |
| provenance PR records whose recorded state differs from the PR's current state | **156 / 156** | 397 / 397 |

Every provenance PR record says `OPEN`, because a stage reports before its PR
merges. Provenance tells us which PR a pipeline has. It never tells us the
PR's current state. It also reads only the lane branch
(`stageProvenance.ts:78-90`), so it misses the 31 delivery-head PRs above.

### Pipeline → PR, the union of every source

The sources are the lane head, the delivery head, `delivery.pr` and provenance.

| | board | all |
|---|---|---|
| pipelines mapped to ≥ 1 PR | **106** (105 with the created-at rule) | 633 |
| pipelines mapped to 2+ PRs | **0** | 2 |
| pipelines with no PR | 73 | 1000 |
| open lanes (not closed or completed) | 10, of which 5 have a PR | 22 |

The source combinations on the board are delivery head + lane + provenance
(43), lane + provenance (23), delivery head + `delivery.pr` (21), delivery head
only (10), provenance only (6), delivery head + lane (2) and `delivery.pr` only
(1). No single source covers all 106: the delivery head finds 76, provenance
72, the lane head 68 and `delivery.pr` 22.

### Many-to-many

| | board | all |
|---|---|---|
| tasks carrying pipelines | 79 | 316 (281 still in the task store) |
| pipelines per task: 1 / 2 / 3 / 4–5 / 6+ | 40 / 18 / 12 / 1 / 8 | 223 / 36 / 23 / 15 / 19 |
| distinct PRs per task: 0 / 1 / 2 / 3 / 4 / 5+ | 18 / 48 / 8 / 2 / 1 / 2 | 144 / 145 / 14 / 7 / 2 / 4 |
| **tasks spanning 2+ PRs** | **13 / 79 (16 %)** | 27 / 316 |
| **PRs reached from 2+ pipelines** | **11 / 84** (max 5) | 11 / 613 |
| **PRs reached from 2+ tasks** | **0** | 5 (max 3) |
| total chips per card (PRs + closed issues): 0 / 1 / 2 / 3 / 6 / 7 | 18 / 32 / 20 / 6 / 2 / 1 | — |

So one PR shared by several pipelines of the same task (retries, successor
lanes, fix rounds) is common. One PR shared across different tasks has not
happened on the board. 76 of 79 cards need three chips or fewer.

### Issue references

| where | count |
|---|---|
| task text with `#N` or an issue URL | 322 / 1621 tasks, 155 of them with 2+ refs. Of the numbers, 189 are PR numbers and 566 are something else |
| task `details` with a ref | 56 tasks |
| task text with a PR URL | 53 tasks |
| pipeline titles with `#N` | board 29 / 179 (4 with 2+). All: 1028 / 1633 (220 with 2+) |
| PR bodies with `Closes/Fixes/Resolves #N` | 575 / 1016 (48 close 2+ issues). Last 500 PRs: 315 |
| PR bodies with any `#N` or issue URL | 865 / 1016 |
| issues closed by 2+ PRs | 37 / 594 (max 8) |

GitHub's `closingIssuesReferences` field agrees exactly with the body regex on
all of the latest 200 PRs (104 agree, 96 have neither, 0 differ). It is the
authoritative source for "the issue this PR is for", so this design reads that
field and parses no bodies. The pipeline title adds an issue that the PR does
not close in 8 of the 18 board pipelines that have both a title ref and a PR.
That case is deferred (§9). Free task text is too noisy to discover from: most
of its refs are progress lists ("✅ #569 + #561 + #560"), and a quarter of the
numbers are PR numbers.

### Forge call cost (measured)

| call | time | bytes |
|---|---|---|
| `gh pr list --state all --limit 100 --search "sort:updated-desc" --json number,headRefName,state,isDraft,url,updatedAt,closingIssuesReferences` | 1.2 s | 33 KB. The page reached back 4 days |
| `gh pr list --state all --limit 1000 --json number,headRefName,state,isDraft,url,closingIssuesReferences` | 8.6 s | 355 KB |

`gh` 2.101 exposes `isDraft` and `closingIssuesReferences` on `pr list`
(verified with `gh pr list --json`). Provenance's `state` field reports a
draft PR as `OPEN`, so draft has to come from `isDraft`.

## 2. What the numbers decide

1. **Stored provenance cannot carry the chip on its own.** It holds identity
   for 72 of 106 board pipelines, its state is stale in every record, and it
   never sees the delivery head. The pinned spec says to reuse it before adding
   a poller. The design reuses it (§4.3), and a state refresher is still
   required, because the state is always wrong otherwise.
2. **One repository-wide read replaces per-lane polling.** A single
   `gh pr list` answers every head of every pipeline in a repository in about
   1 s. Asking per lane would take `2 × lanes` calls.
3. **The card needs three chips and "+N".** A pipeline header needs one PR chip
   plus at most two issue chips. No board pipeline has two PRs.
4. **Several pipelines point at one PR (11 PRs), and a task spans several PRs
   (13 cards).** Both have to render readably. Per-card dedupe covers the first
   and the "+N" overflow covers the second.
5. **Links resolve at read time, and only manual links are stored.** Every
   automatic fact already sits on the pipeline record (branches,
   `delivery.pr`, provenance) or comes from the forge cache. Storing auto links
   would mean a registry write for each discovery and each state change.

## 3. Data model

### 3.1 Stored on records: manual links only

New module `src/lib/forge/workLinks.ts`, shared by server and client (pure, no I/O):

```ts
export type WorkLinkKind = "pr" | "issue";

/** An operator- or agent-attached reference. `kind` is null while the number
    is not yet known to be a PR or an issue; a github.com/<r>/issues/<n> URL
    opens either, since GitHub redirects an issue URL to its PR. */
export type StoredWorkLink = {
  repository: string;          // "<owner>/<repo>", lower-cased
  number: number;
  kind: WorkLinkKind | null;
  addedAt: string;
  addedBy: "operator" | "agent";
};
```

- `Pipeline.workLinks?: StoredWorkLink[]` goes beside `dismissedAt` in
  `src/lib/pipelines/types.ts:699-775`, bounded to 20. It survives into the
  archive with the record.
- `BoardTask.workLinks?: StoredWorkLink[]` goes beside `color` in
  `src/lib/tasks/types.ts:167`, bounded to 20. An attach or detach is a
  **presentation-only** patch: it joins `color` and `hide` in the
  `presentationOnly` test at `src/lib/tasks/commands.ts:462`, so `updatedAt`
  and the card's ranking stay put. The revision still moves, which is what the
  fence expects.

Absent means none. No migration is needed.

### 3.2 Never stored: the resolved view

```ts
export type WorkLinkVia = "manual" | "delivery-pr" | "provenance" | "lane-branch" | "delivery-branch" | "closes";
export type PullRequestState = "open" | "draft" | "merged" | "closed";

export type WorkLink = {
  key: string;                 // "<repository>#<number>"
  kind: WorkLinkKind | null;
  repository: string;
  number: number;
  url: string;
  source: "auto" | "manual";   // manual wins when both apply
  via: WorkLinkVia[];          // every piece of evidence, for the tooltip and MCP
  state: PullRequestState | null;   // PRs only; null = never read
  checkedAt: string | null;    // when `state` was read from the forge
};

export type ResolvedWorkLinks = {
  links: WorkLink[];           // deduped, ordered (§6.3)
  /** A PR was looked for and there is none: the repository's cache is complete
      and neither head has a PR. False while the answer is unknown. */
  noPr: boolean;
};

export function resolvePipelineLinks(pipeline: Pipeline, cache: ForgeCacheView): ResolvedWorkLinks;
export function resolveTaskLinks(task: BoardTask, pipelines: readonly Pipeline[], cache: ForgeCacheView): ResolvedWorkLinks;
```

`source` is exactly the `auto | manual` split the spec asks for. `via` records
which evidence produced each link, so an MCP caller can tell a delivery-head PR
from a provenance one.

### 3.3 The forge cache: where state and freshness live

`state/forge-links.json` is a single-writer JSON file owned by the Viewer
process, written with `writeJsonDurably` (the controller's own writer,
`src/lib/pipelines/controller.ts:5`). It is read through an mtime-keyed memory
cache, the same pattern as `readRemotes()` at `src/lib/projects/aliases.ts:353`.

```ts
type ForgeCacheFile = {
  schemaVersion: 1;
  repositories: Record<string /* owner/repo */, {
    /** Every PR of the repository created before this instant is in `prs`.
        Null until the first complete read; reset by a sweep that fails to
        overlap the previous one (§4.2). */
    completeSince: string | null;
    lastSweepAt: string | null;
    /** Coarse token, as githubEvidence.ts:165 does it: never gh's stderr. */
    lastError: "timed-out" | "command-failed" | "malformed-output" | null;
    prs: Record<string /* number */, {
      url: string; headRefName: string; createdAt: string;
      state: PullRequestState; closes: number[]; checkedAt: string;
    }>;
    /** Numbers a per-number read found to be issues, not PRs. */
    issues: Record<string, { checkedAt: string }>;
  }>;
};
```

The measured size is 355 KB for this repository's 1016 PRs. The file is never
sent to the browser. Only resolved links are.

Freshness is `checkedAt` on each PR, shown in the chip tooltip ("merged ·
checked 3 min ago"). When a repository's last successful sweep is more than 30
minutes old, the chip keeps its last state and the tooltip says "as of <time>".
The card never shows a state that was never read. It shows `#N` in the neutral
colour instead.

Other ways to hold state that I rejected:

- **State on the records.** This needs a pipeline mutation and a task mutation
  per transition. The task revision is a content hash
  (`src/lib/tasks/revision.ts:15-24`), so each state change would also refuse a
  concurrent drag with 409.
- **A new endpoint the client polls.** This adds a second transport, while
  `/api/files` already carries both pipelines and tasks
  (`src/app/api/files/response.ts:893-897`).

## 4. Discovery

### 4.1 Repository of a record

A pipeline's repository comes from the `delivery.target.remote` GitHub URL (147
of 179 board pipelines have it), or else
`recordedProjectRemote(pipeline.project)` (`aliases.ts:382`). A task's comes
from `recordedProjectRemote(task.project)`. A remote that does not name
`github.com` gives no repository. Such a record gets manual links only and
never a "no PR" mark. This is also why the 29 board pipelines of other
repositories need nothing special: they resolve through their own remotes.

### 4.2 The sweep (the one poller)

`sweepForgeLinks()` is a sibling of `sweepSettledArchive()`. It is called next
to it in the controller cycle (`src/lib/pipelines/controller.ts:194`) and built
the same way (`:220-229`): an interval gate, fire-and-forget, one run in flight
at a time, and errors logged without being thrown.

1. **Collect, read-only.** It uses `loadPipelines()` (the same lease-free read
   `reportStageCompletion` does at `src/lib/pipelines/engine.ts:7787`) and the
   task store read. It groups the repositories referenced by active pipelines
   and by manual links on tasks. No pipeline or task lock is taken at any
   point, because the sweep writes nothing but the cache file.
2. **Per repository, due when:**
   - 3 minutes have passed since the last sweep while the repository has a
     "live" record: an open lane, or a linked PR cached as `open` or `draft`;
   - 30 minutes have passed otherwise;
   - a nudge arrived (§4.3, §5), debounced to one sweep per 30 s.
3. **Incremental read.**
   `gh pr list --repo <r> --state all --limit 100 --search "sort:updated-desc" --json number,url,headRefName,state,isDraft,createdAt,updatedAt,closingIssuesReferences`,
   through `githubRunner` (`src/lib/monitor/githubEvidence.ts:34`) with a 20 s
   timeout. `--repo` means a deleted `repoDir` does not matter. Every row
   upserts into `prs`, and `state` is derived as
   `isDraft ? "draft" : state.toLowerCase()`.
4. **Coverage rule.** When the oldest `updatedAt` on the page is at or before
   the previous sweep's start, the page overlapped and `completeSince` holds.
   When it did not (more than 100 PRs changed in between), the sweep runs a
   full read: `--limit 5000` without `--search`, 8.6 s measured for 1000 PRs.
   Then `completeSince = now`. A repository with `completeSince === null`
   always gets the full read, and that read is the backfill (§7).
5. **Per-number fill.** Some numbers are named by `delivery.pr` or by a manual
   link and are missing from `prs` and `issues`, or are cached `open`/`draft`
   but absent from this page (older than the page). For each one, up to 10 per
   sweep, the sweep runs `gh pr view <n> --repo <r> --json …`. A failure that
   says the number is not a PR records it under `issues`.
6. **Failure.** The sweep writes `lastError`, leaves every entry untouched, and
   retries on the next due tick. On a failed sweep, `completeSince` keeps its
   value, because missing one read loses nothing when the next page overlaps.

### 4.3 Reusing stage provenance

`reportStageCompletion` already runs `collectStageProvenance` outside the
pipeline mutation (`engine.ts:7795`, before `withPipelineMutation` at `:7801`).
Right after it, and still outside the mutation, the report calls
`observeForgePullRequest(repository, provenance.pullRequest, now)`. This
merges the number, URL and head into the cache when the cache has nothing
fresher, and it nudges the sweep for that repository. There is no extra
network call, and the chip appears on the report that published the PR rather
than up to 3 minutes later. `stageProvenance.ts` itself does not change.

### 4.4 Resolution rules (`resolvePipelineLinks`)

Every link below is deduped by `key` (§3.2), with `via` accumulated across the
rules that found it:

1. Manual `workLinks` give `source: "manual"`, `via: ["manual"]`.
2. `delivery.target.pr` gives `via: ["delivery-pr"]`.
3. Each distinct `runs[].attempts[].report.provenance.pullRequest` number gives
   `via: ["provenance"]`.
4. Cached PRs whose `headRefName` is the lane branch or the stripped delivery
   branch give `lane-branch` or `delivery-branch`. The PR must have been opened
   while the lane was alive, meaning both of these hold:
   - its `createdAt` is at or after `pipeline.createdAt`;
   - for a settled lane, its `createdAt` is at or before `pipeline.closedAt`.
     Every completed and closed lane carries `closedAt`, and no open lane does.

   The window does not apply to a PR that rule 2 (`delivery.pr`) or rule 3
   (provenance) already names, because those are the lane's own records.
   Instants are compared with `Date.parse`, because the forge writes `…00Z` and
   the registry writes `…00.000Z`. A PR whose opening time cannot be read falls
   outside the window.

   The lower bound stops a new lane from inheriting an old PR on a reused head.
   The upper bound stops a finished lane from picking up the PRs that later
   lanes open on the same head. The seven reused head names in §1 (one of them
   carrying 15 PRs) are exactly that case. The window loses the one unexplained
   case in §1.
5. For every PR from rules 1–4, `closes` gives issue links with
   `via: ["closes"]`.

`noPr` is `true` exactly when the repository resolves,
`completeSince` is not null, and no PR link came out of rules 1–4.

`resolveTaskLinks` takes the task's manual links together with
`resolvePipelineLinks` for every pipeline whose `taskIds` contains the task
(the same join the card uses). It dedupes by key and keeps "manual" when either
side is manual. `noPr` on a task is not rendered. A task without a PR is not a
defect, since many tasks are chat work.

## 5. API and MCP surface

### 5.1 Input normalization (`normalizeWorkLinkInput`)

Clamp, never reject a reasonable form. The accepted forms are:

- `https://github.com/<o>/<r>/pull/<n>` (any suffix such as `/files` or `#…`)
  gives `pr`.
- `https://github.com/<o>/<r>/issues/<n>` gives `issue`.
- `<o>/<r>#<n>` gives the kind from the cache, else `null`.
- `#<n>`, `<n>`, `PR 2059`, `pr#2059` or `issue 2059` gives the record's
  repository (§4.1). A `pr` or `issue` word sets the kind. Otherwise the kind
  comes from the cache, else `null`.
- Surrounding whitespace, `<…>` and a trailing `.` are stripped.

These are refused with a sentence that names the form that would work:

- a non-GitHub URL;
- a bare number on a record with no resolvable repository;
- a number ≤ 0.

An optional `kind: "pr" | "issue"` argument overrides the guess. An attach that
already exists is a no-op that answers `unchanged`. At the limit of 20, the
attach is refused (409) and the answer lists the links already attached.

### 5.2 Pipeline

- Add `attach-link` and `detach-link` to `PIPELINE_ACTIONS`
  (`src/lib/pipelines/types.ts:798-825`). The PATCH route and the MCP enum
  pick them up by construction (#774).
- `PatchPipelineRequest` (`types.ts:828`) gains `link?: string`
  (or `string[]`) and `kind?: WorkLinkKind`.
- Engine: a branch next to `dismiss`/`undismiss`
  (`src/lib/pipelines/engine.ts:7506`). The action is allowed in every state
  (draft and closed included), because linking a finished lane to its PR later
  is the point. Archived records keep their existing 409 (`engine.ts:6886`).
  The engine does no forge work in the mutation. After persist, it nudges the
  sweep for any link whose kind or state is unknown.
- `detach-link` removes manual links only. Detaching an auto link answers 409
  `WORK_LINK_AUTO`, naming its `via` evidence, and changes nothing. §9 explains
  why auto links are not suppressible.
- The acknowledgement adds `workLinks: ResolvedWorkLinks` beside the existing
  `stageDigests` (`src/lib/mcp/compactAnswers.ts:53`).

### 5.3 Task

- `PatchTaskInput` (`src/lib/tasks/commands.ts:69`) gains
  `attachLinks?: string | string[]`, `detachLinks?: string | string[]` and
  `linkKind?`. They are add and remove sets, so two writers never replace each
  other's list. They are validated next to `color` (`:411`) and are
  presentation-only (`:462`).
- The route is `PATCH /api/tasks/:id` (`src/app/api/tasks/[id]/route.ts:17`),
  unchanged apart from passing the fields through.
- MCP `update_task` (`src/lib/mcp/server.ts:3242`) gets the same three fields.
  `get_task` and `list_tasks` with `full:true` add a resolved `workLinks`.

### 5.4 Reads

- `get_pipeline` (every form) and `list_pipelines` with `compact:false` or
  `full:true` add `workLinks: ResolvedWorkLinks`. The compact row adds
  `pr: "#2059 open" | "no PR" | null`, a single string that keeps the row
  within its 24 KB page budget.
- `/api/files` (`src/app/api/files/response.ts:884-897`) adds
  `workLinks: { pipelines: Record<id, ResolvedWorkLinks>, tasks: Record<id, ResolvedWorkLinks> }`.
  The map covers only the records it already carries and only the non-empty
  entries. It is built by in-memory map lookups against the cache view: no
  `gh`, no file read beyond the mtime check, and no lock. For 179 pipelines
  that is about 360 head lookups.

## 6. UI

The chip is one component, `WorkLinkChip` in `src/components/workLinks/`,
used by the kanban board and the phone board:

- It is an `<a href target="_blank" rel="noopener noreferrer">`, a real link,
  so middle-click and "copy link" work.
- Anatomy: a lucide glyph whose shape carries the state, so colour is never the
  only signal. `GitPullRequest` is open, `GitPullRequestDraft` is draft,
  `GitMerge` is merged, `GitPullRequestClosed` is closed and `CircleDot` is an
  issue. After the glyph comes `#N` in tabular numerals.
- The chip is 18 px tall, pill-shaped, `--text-caption` weight 600, and
  follows the `project-chip` recipe (`src/components/kanban/kanbanBoard.css:278-285`).
- Colours use existing tokens only: open is `--color-success`, draft is
  `--color-muted` with a dashed border (the `provisioning` idiom at
  `kanbanBoard.css:353`), merged is `--color-accent`, closed is
  `--color-danger`, and unknown or issue is `--color-secondary`.
- The title and `aria-label` spell out the whole fact, for example
  "Pull request #2059 · merged · checked 3 min ago · found by delivery branch".
- "no PR" is plain muted text, no pill and no link ("без PR" in uk). It is a
  fact about the lane, not something to click.
- The whole visible chip is the target (44 px hit area through padding on
  touch, per the design system). A tap never opens the card underneath:
  `stopPropagation` on pointerdown, the same treatment as `project-chip`
  (`KanbanCard.tsx:291`).

### 6.1 Pipeline section header (desktop kanban, ≥ 640 px)

`PipelineSection.tsx:220-223` renders `.sec-head` as `title · state chip ·
progress note · acting · grow · buttons` on one line. The pipeline's own chips
go right after `.pstate-chip`, as `<span className="plinks">` holding at most
one PR chip, then issue chips, then "no PR". For a pipeline with more than
three links, it shows two chips and "+N" (not observed on the board, but
bounded anyway).

Fit: `.plinks` is `flex: 0 0 auto`. `.ptitle` keeps `flex: 0 1 auto` but gains
`min-width: min(10rem, 40%)`, following the memory rule "flex-1 title
collapses beside shrink-0 chips". When title minimum + state + links + buttons
exceeds the width, `.sec-head` wraps (`flex-wrap: wrap`, which the shelf
variant already does at `kanbanBoard.css:344-346`), and `.plinks` moves to its
own line under the title with `order: 5`. The progress note shrinks first, as
it already does (`flex: 0 4 auto`, `:334`).

### 6.2 Task card (desktop kanban)

A `.links` row sits directly under `.head` (`KanbanCard.tsx:301-366`), above
the description. It sits there so it stays visible when the card is
**collapsed**, when the pipeline sections are gone (`:477`). The row holds the
deduplicated union from `resolveTaskLinks`: up to three chips, then a
`+N` button. The button opens a `KanbanPopover` (`src/components/kanban/kanbanMenus.tsx:160`)
listing every link as a full-width row: chip, then "found by …" or "attached",
then a × on manual rows. The row wraps and never scrolls horizontally.

The card row renders when the task has at least one link. A pipeline's "no PR"
appears only in that pipeline's header, because a card cannot say "no PR" for
a set of pipelines where some lanes have one.

Duplication is deliberate and bounded. With the card expanded, a PR can show
both in the card row and in its pipeline's header. The requirement asks for
both ("every pipeline … and the task card that carries it"), and the card row
is the only place the aggregate stays visible when collapsed. §9 records the
alternative.

### 6.3 Ordering

PRs come before issues. PRs are ordered open, draft, merged, closed, then
unknown, and within a state the higher number comes first. The newest work
leads, and a retry's merged PR sorts ahead of the closed attempt it replaced.

### 6.4 Phone (< 640 px, which is where 390 px renders)

At phone width the board is `MobileShell` (`src/hooks/useIsMobile.ts`, query
`(max-width: 639px), (max-height: 599px)`), not the kanban. The pipeline rows
there are whole-row buttons, and a link cannot nest inside a button. So:

- **Pipeline screen** (`src/components/mobile/MobilePipelineScreen.tsx:472-490`):
  a `data-mobile2-links` line under the meta line, holding the same
  `WorkLinkChip`s (wrapping, three plus "+N" into a `MobileSheet`) or "no PR".
  These are the clickable chips on the phone.
- **Rows** (`MobilePipelineQueueRow`, `src/components/mobile/MobileBoard.tsx:244`,
  and `MobilePipelineRow` in the pipelines screen): the meta sentence gains a
  passive `PR #2059 merged` or `no PR` clause, as text and not a link, which
  keeps the row a single target.

### 6.5 Manual affordance

- **Pipeline menu** (`src/components/kanban/KanbanBoard.tsx:1299-1310`): an
  "Attach PR or issue…" item after "Stages". It opens a `KanbanPopover` with
  one input (placeholder `#2059 or URL`), an Attach button, and the list of
  current links, where manual ones carry ×. Enter submits.
- **Card menu** (`KanbanBoard.tsx:1216`): the same item, writing to the task.
- **Phone pipeline screen**: the same form in the existing menu sheet.

Errors show inline under the input with the server's sentence. On success the
popover stays open, so several links can be added in a row.

### 6.6 Copy (en / uk)

The new keys are `workLinks.noPr` ("no PR" / "без PR"), `workLinks.attach`
("Attach PR or issue…" / "Прикріпити PR або issue…"), `workLinks.more`
("+{count}"), `workLinks.state.*` and `workLinks.via.*`. The chip text itself
is language-neutral (`#N` plus a glyph), which is what keeps uk from widening
the header.

## 7. Backfill

There is no data migration. Resolution is a read-time join and the only new
stored field is empty by default. After deploy, the first controller cycle
finds each repository at `completeSince: null` and runs the full read (§4.2
step 4): one call per repository, about 9 s for this one, off the critical
path. The next `/api/files` then shows the PR or "no PR" for all 179 board
pipelines. On measured data that is 98 of the 150 pipelines in this
repository with a PR chip and 52 with "no PR". The 29 in other repositories get
their own repository's answer, and 7 of them already carry a PR through
`delivery.pr` or provenance.

Archived pipelines are not on the board and cost nothing. `get_pipeline` on
one still resolves against the same cache.

## 8. Test plan

All tests are run by path and none sweeps the live registry. Tests that touch
state set `LLV_STATE_DIR` to a temp directory. Fixtures use invented
`<owner>/<repo>` names and branch names, never an operator string.

- `src/lib/forge/workLinks.test.ts` (pure):
  - each of the §5.1 input forms, and the refusals;
  - the §4.4 rules one by one, including:
    - a lane whose delivery head differs from the lane branch and carries the PR;
    - a reused head whose older PR predates the lane and is excluded;
    - the same, but named by `delivery.pr` and included;
    - provenance-only;
    - manual plus auto on the same key giving one link with `source: "manual"`
      and both `via`;
  - `noPr` under an incomplete cache (false) and a complete one (true);
  - task aggregation across several pipelines sharing one PR giving one chip;
  - ordering (§6.3).
- `src/lib/forge/sweep.test.ts`, with an injected `GithubRunner` and clock:
  - the interval gates (3 min live, 30 min idle, nudge debounce);
  - the overlap rule falling back to a full read;
  - a `timed-out` read leaving entries and `completeSince` intact;
  - the per-number fill capped at 10;
  - `isDraft` mapping to `draft`;
  - **a spy asserting no `withPipelineMutation` and no task-store write
    happens during a sweep**.
- `src/lib/pipelines/stageCompletion.test.ts` (extend): a report whose
  provenance carries a PR updates the cache, and the observation runs before
  the mutation (ordering assertion on the ports).
- `src/lib/pipelines/engine.test.ts` or a new `workLinksAction.test.ts`:
  - `attach-link` and `detach-link` on running, closed and draft lanes;
  - the archived 409;
  - the auto-detach 409 naming `via`;
  - the 20-link limit;
  - idempotent re-attach.
- `src/lib/tasks/commands.test.ts` (extend): attach and detach keep
  `updatedAt` and move the revision.
- The MCP end-to-end harness (the in-memory client plus loopback route):
  - `pipeline_action attach-link` with `"#2059"`, `"2059"` and a full URL;
  - `update_task attachLinks`;
  - `get_pipeline` returning `workLinks`.
- `src/app/api/files` response test: `workLinks` is present for carried
  records and absent for records with nothing, and **the response path never
  invokes the gh runner** (runner spy).
- Rendering: `KanbanPipelines.dom.test.tsx` (header chip, "no PR", +N) and
  `KanbanBoard.dom.test.tsx` (card row visible when collapsed, popover lists
  all, manual × only).
- **Fit evidence, using the existing drivers only** (AGENTS.md "Rendered
  evidence"): add a `describe` block to
  `src/components/kanban/kanbanBoard.browser.test.tsx` over
  `issue1695Evidence.fixture.tsx` at 768, 1080 and 1440 in en and uk. The
  fixture adds a long title with one PR, three pipelines sharing one PR, and a
  card with 7 links. Add a case to
  `src/components/mobile/issue1671Evidence.browser.test.tsx` at 390 for the
  pipeline screen and a row. Each case asserts measured ink rather than boxes,
  per the overlap-test rule: title text rects never intersect chip rects, the
  title keeps at least 10rem or wraps, and no chip is clipped by an overflow
  ancestor.

## 9. Deferred — not currently justified

- **Issue refs parsed from the pipeline title.** This would add an issue chip
  for 8 of 18 board pipelines, but free-text parsing names PR numbers and
  stale refs, and an issue number already sits in the title text. Revisit if
  operators attach those by hand often.
- **Discovery from task text.** 322 tasks carry refs, but most are progress
  lists. Manual attach covers the real need.
- **Suppressing an auto link** (a "hide this discovered PR" list). No false
  positive exists once the created-at rule (§4.4) is in place. Add it when one
  is observed.
- **Provenance reading the delivery head.** It would give a report-time chip
  for the 31 delivery-head lanes, but it changes what an attempt's provenance
  records, and the sweep already finds those PRs within one interval.
- **Links in `create_pipeline`.** `delivery.pr` already covers the fix-round
  case at creation. `attach-link` right after create covers the rest.
- **Issue state (open/closed) on issue chips.** The requirement asks for state
  on the PR only. It would need an issue read per sweep.
- **Hiding the card row when it equals the sole expanded pipeline's header.**
  It would remove the one duplicate, but the row would appear and disappear as
  the card changes. Consider it after the rendered evidence exists.
- **Webhooks.** There is no public endpoint to receive them, and a 3-minute
  sweep at about 1 s is already cheap.

## 10. Check against the originating requirement

| Requirement | Where |
|---|---|
| Clickable PR chip with number and coloured state, plus linked issue | §6, `WorkLinkChip`. Issues come from `closingIssuesReferences` (§4.4 rule 5) |
| "no PR" shown plainly | §4.4 `noPr`, §6.1, §6.4 |
| Links on the pipeline first, and the card aggregates pipelines plus task | §3.1, §4.4 `resolveTaskLinks`, §6.2 |
| Auto discovery from the delivery branch and `delivery.pr`, reusing provenance, network outside locks | §4.2–§4.4. The sweep writes no registry. Provenance feeds the cache before the mutation |
| Manual attach and detach, UI plus MCP/HTTP, lenient input | §5, §6.5 |
| Many-to-many measured and rendered | §1 "Many-to-many", §6.2 dedupe and "+N" |
| Backfill | §7 |
| Fit at 390 through desktop, en and uk | §6.1, §6.4, §6.6, §8 fit evidence |
| Measure first | §1 |

## 11. Build slices

1. `src/lib/forge/` (types, normalize, resolve, cache and sweep) and its
   controller hook, plus `observeForgePullRequest` in stage report. Server
   tests.
2. Stored manual links: the pipeline actions, the task patch fields, MCP, and
   `/api/files` `workLinks`. API and MCP tests.
3. UI: the chip, the header, the card row with popover, the phone screen and
   rows, the attach popover, and the copy. DOM tests plus the fit evidence in
   the existing drivers.

Slices 1 and 2 can land together. Slice 3 depends on them.

## 12. What the build changed (2026-09-23)

Four things the build met that this note did not know. The rest landed as
written above.

- **A renamed repository.** This repository was renamed on GitHub after its
  records were written, so a pipeline's remote still carries the old name.
  `gh pr list --repo <old name>` without `--search` follows the rename, but
  with `--search "sort:updated-desc"` it answers `[]`. The incremental read in
  §4.2 step 3 would then fail its overlap check and fall back to a full read on
  every sweep. The sweep learns the name GitHub answers with from the PR URLs
  of its first full read, stores it as `canonical` on the cache entry, and
  searches under that name after that. Once PRs are known, an empty page no
  longer counts as proof of coverage. Links and URLs use the canonical name, so
  a pasted URL under the new name and a record under the old name dedupe to
  one chip.
- **The header chips sit on their own line** (§6.1). They sit directly under
  the header line, never inside it. The header line already holds the title,
  the state chip, the stage note and three buttons. Measured in Chromium with
  the chips placed inline after `.pstate-chip`, the title collapsed to 0 px at
  768, 1080 and 1440 px in en and uk, and a "no PR" mark was cut to nothing in
  a shelf column. On their own line they never take width from the title.
- **The phone draws every chip, wrapping** (§6.4). It has no "+N". An "Attach
  PR or issue…" link beside the chips opens the list and the form in a sheet.
  On measured data the most links a lane carries is three.
- **The evidence driver could not build** while this was built. `LogFeed`
  imports a Next.js `"use server"` action, and a plain `bun build` pulled the
  action's body, with the state directory code, into the browser bundle. #2009
  landed the same fix on main in parallel: the harness stubs server actions the
  way Next does. The chip case runs on that harness.

Reads also carry the links. `list_pipelines` compact rows add
`pr: "#2059 open" | "no PR"` only when there is one. Full and `compact:false`
rows add `workLinks`. So do `get_pipeline` in both forms and `get_task`
without `compact`.
