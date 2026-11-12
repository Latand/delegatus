# Issue closing on merge

## 0. Originating requirement

On 2026-11-12 the operator asked that closing the GitHub issue a lane delivers
be Delegatus's own default, for every project and every person who works with
GitHub. They objected to keeping it as one orchestrator's working rule.
Source: the operator's instruction to this project's orchestrator, pinned on
this lane's task (a private conversation, paraphrased here).

The trigger was three merged pull requests. #3909 named its issue as `#3900`
and #3907 named its issue as `Refs #3902`; neither issue closed at merge. #3906
said `Closes #3901`, and that issue closed. The agent's wording of the PR body
decided the outcome.

Acceptance, as pinned on the task:

1. A lane linked to an issue it delivers closes that issue when its PR merges.
   The link comes from attach-link, the task's links or the issue named at
   creation. Delegatus does it, and no agent or orchestrator has to remember.
2. A lane marked as delivering part of an issue leaves it open, with a short
   note of what landed.
3. A batch merge (a merger's integration PR) closes the issues of every PR it
   carries.
4. Projects without GitHub keep working on Git alone. No GitHub read or write
   blocks publication, merge or completion.
5. Tests check behaviour, never prompt wording.

## 1. What happened

These are GitHub's own records, read on 2026-11-12: `pulls/N`, `issues/N` and
GraphQL `closingIssuesReferences`.

| PR | merged (UTC) | closing refs | issue afterwards | lane title |
|---|---|---|---|---|
| #3909 | 11-12 04:15 | none | #3900 closed by hand at 06:14 | `#3900 Controller records …` |
| #3907 | 11-12 00:50 | none | #3902 still open | `#3902 Narrow task class …` |
| #3906 | 11-11 23:50 | #3901 | #3901 closed at merge, closer = PR #3906 | — |

Neither lane stored a link to its issue, on the lane or on its task. The issue
number existed only in the lane title. The PR body is the producer stage's
summary, copied verbatim (`src/lib/pipelines/stagePullRequest.ts:213`, `:220`).

## 2. Where the pieces live

| concern | where |
|---|---|
| Stored links | `StoredWorkLink` (`src/lib/forge/workLinks.ts:18-25`) on `Pipeline.workLinks` (`src/lib/pipelines/types.ts:1315`) and `BoardTask.workLinks` |
| attach-link / detach-link | `editPipelineWorkLinks` (`src/lib/pipelines/engine.ts:15662`) and the task path (`src/lib/tasks/commands.ts:588`), both through `editStoredWorkLinks` (`workLinks.ts:391`) |
| Lane from an issue link | `linkSource.ts:185` returns `attachLink` and the title `Issue #N: …` (`:138-141`). The client attaches the link after creation (`src/components/pipelines/pipelineModel.ts:1405-1416`) |
| Discovered issue links | only through a PR's `closingIssuesReferences` (`workLinks.ts:354-359`) |
| PR opening | `ensureStagePullRequest` (`stagePullRequest.ts:130`), `gh pr create` at `:291` |
| Runner merge | `gh pr merge … --match-head-commit` (`src/lib/forge/autoMerge.ts:1056`), recorded `merged` at `:1074` |
| Batch landing | the runner's verified receipt (`reconcileBatchLanding`, `autoMerge.ts:1630`; `readBatchLanding`, `src/lib/forge/batchLanding.ts:58`) and the cache reading (`landedPullRequests`, `src/lib/done/candidates.ts:91`) |
| Batch PR | `scripts/merge-batch.ts` forwards `Closes #N` for every carried PR's closing references (`:1020-1024`) and closes the originals (`:1263-1269`) |
| Work after a landing | `scheduleAutoMerge` (`autoMerge.ts:1849`): post-merge recovery on its own slot, and the task-finish sweep chained after the merge pass (`:1907-1911`) |
| Forge writes | `forgeWriter` (`src/lib/forge/appWrite.ts:140`). The issue-scoped App token set is `FORGE_APP_ISSUE_PERMISSIONS` (`bin/forge-app-token.mjs:34`), already used by issue reports (`src/lib/issueReports/publish.ts:40`) |

## 3. Options

**A. Delegatus writes `Closes #N` into the PR body.** GitHub closes the issue at
merge.
- It uses only the existing `pull_requests` permission, and it covers every
  merge path.
- The decision is fixed when the PR opens. A link or a `part` marker added later
  needs a body edit on the publication path, which open PR #3918 is changing.
- A partial note still needs an issue write.
- A `Closes #N` the producer writes still closes an issue the lane marks partial.

**B. Delegatus settles each delivered issue after the lane's PR lands.** One
step closes the issue or adds a note, using the links and markers as they stand
at the landing.
- It is one decision point for every merge path: the runner, a person on
  GitHub, a batch.
- It leaves publication alone.
- It needs `issues: write`, which this repository's App installation already
  grants (§4.7).
- The close comes one controller cycle after the merge is seen.

**C. Leave it to working rules or the builder prompt.** This is today's state,
and the requirement rejects it.

**Recommendation: B.** Only B sees the final links, and only B can keep a
partially delivered issue open whatever the PR text says.

## 4. Design

### 4.1 One owner

A new module, `src/lib/forge/issueDelivery.ts`, is the only code that closes,
reopens or comments on an issue for a lane. It holds four parts:

- the creation rule (§4.2);
- `deliveredIssues(lane, tasks)`;
- `laneLanding(lane, cache)`;
- `sweepIssueDelivery(ports)`.

`scheduleAutoMerge` starts the sweep on its own global slot and debounce, the
way it starts post-merge recovery (`__llvPostMergeRunning`). The sweep is never
chained into the merge promise, so a slow GitHub cannot delay the next merge
pass. `merge-batch.ts` keeps forwarding closing references, which serves
carried PRs that no lane owns.

### 4.2 Which issues a lane delivers

The set is the union of four sources:

1. **The lane's own stored links:** attach-link, plus the link the client
   attaches to a lane created from an issue link.
2. **The issue named at creation (new).** `createPipelineFromRequest` records it
   beside `finishesTaskIds` (`engine.ts:14867`). It reads only the first line of
   the task: a leading `#N`, `owner/repo#N` or `Issue #N`, or a trailing
   `(#N)`. A leading `PR #N`, mid-sentence numbers, the spec and the details are
   ignored.
3. **A predecessor's links (new).** Some lanes continue another lane's work:
   - a lane created with `refreshOf`;
   - a lane whose title leads with a PR number that the cache maps, through
     `lanePullRequest`, to a hot lane sharing one of its tasks.

   Such a lane copies that lane's issue links, `part` markers included.
4. **Issue links stored on the lane's tasks.** These are read at settlement, so a
   link added while the lane runs still counts.

A link counts when its kind is `issue` or `null` and it names the landed PR's
repository by canonical name. It never counts with kind `pr`.

**Why the kind check decides.** 1,174 lanes delivering to this repository were
created from 2026-10-20 to 2026-11-12. The lane registry was read read-only, and
each number was checked against the forge cache and then against GitHub.

| title shape | lanes | PR | issue | neither | unknown to the cache |
|---|---|---|---|---|---|
| leading `#N` or `owner/repo#N` | 333 | 313 | 19 | 1 | 11 |
| leading `PR #N` | 41 | 41 | 0 | 0 | 0 |
| trailing `(#N)` | 5 | 0 | 5 | 0 | 3 |

Over the same span, 22 lanes carried a stored issue link. So creation stores a
candidate only when the cache does not know it as a PR. Each candidate goes
through `normalizeWorkLinkInput` and `cachedKindOf`, with the cache's kind
(`issue` or `null`). Settlement confirms the kind by reading the issue (§4.5).

Creation makes no GitHub call. A project with no GitHub repository stores
nothing, because a bare number then names nothing (`workLinks.ts:199`). A stored
link appears as an ordinary issue chip, so a wrong match is visible before the
merge, and detach-link removes it.

This reverses the deferral in `docs/design/pr-issue-chips.md` §9 ("Issue refs
parsed from the pipeline title"). That deferral was right for chips. Here the
title was the only place the reported lanes named their issue.

### 4.3 Partial delivery

**Marking.** `pipeline_action attach-link` takes `part: boolean`:

- `true` sets the marker and `false` clears it;
- leaving it out keeps the current value.

The marker is stored as `StoredWorkLink.part?: true`, and only on lane records.
To mark an issue inherited from a task, attach it to the lane with
`part: true`. `editStoredWorkLinks` treats an attach of an existing link as a
no-op today (`workLinks.ts:391`), so it must compare `part` and report a change.

**On landing.** The step posts `Part of this issue landed in #P: <PR title>.`
and leaves the issue open. If the PR's own closing reference closed the issue,
the step reopens it before posting the note. That case is recognised from the
issue's latest GraphQL `ClosedEvent.closer`, which names the PR (or its batch
PR) that closed it; probed on #3901, it answers PR #3906. The step does not
reopen when another lane landed the same issue with mode `close`.

### 4.4 When a lane has landed

**In-memory evidence comes first**, with no I/O. Any one of these counts:

- `merge.state === "merged"`. This covers a runner merge and a batch landing
  the runner verified.
- The cache shows `lanePullRequest(lane)` as merged, which covers a person
  merging on GitHub.
- The cache shows that PR closed, and its number appears in the title of a
  merged `merge-batch/` PR. `landedPullRequests` moves to `src/lib/forge/` so
  both readers share it.

**Then one read of the primary record** comes before any write:
`repos/R/pulls/P`, or the batch PR for a batch landing. `merged_at` must be set
and `base.ref` must equal `base.repo.default_branch`.

- Not merged means the cache was stale, and the step waits for the next pass.
- Merged into another base means the entry is final as `skipped/other-base`.
  GitHub's own keywords act only on the default branch too.

### 4.5 The settlement step

For each delivered issue of a landed lane that has no final entry, the step
runs these reads and writes in order:

1. It reads the PR (§4.4), then `repos/R/issues/N`. A `pull_request` key or a
   404 makes the entry final as `skipped/not-an-issue`.
2. For mode `close`:
   - If the issue is already closed, the entry is `already-closed` and nothing
     is written.
   - If it is open, the step posts `Landed in #P.` unless a comment with that
     text already exists since the landing. It then closes the issue with
     `state_reason=completed` and reads the state back.
3. For mode `part`, the step follows §4.3: a reopen if needed, then one note,
   deduplicated in the same way.

The outcome is recorded on the lane:

```ts
type IssueDelivery = {
  repository: string; number: number; mode: "close" | "part";
  pr: number; batch?: number; at: string;
  state: "pending" | "closed" | "already-closed" | "noted" | "reopened" | "skipped" | "refused";
  /** Fixed vocabulary; never GitHub text. */
  reason?: "not-an-issue" | "other-base" | "app-permission" | "github-unavailable";
  failures?: number; retryAt?: string;
};
// Pipeline.issueDelivery?: IssueDelivery[]
```

- **Once per lane and issue.** If a person reopens the issue later, Delegatus
  leaves it open, as task finishes do.
- **Uncertain writes.** An error, a timeout or a status code proves nothing.
  Every retry starts again from the reads in steps 1 and 2. A close that landed
  therefore reads as closed, and a comment that landed is found and not posted
  again.
- **Failures.**
  - A failure backs off with `githubReadBackoff`.
  - The third failure makes the entry `refused/github-unavailable`.
  - `ForgeAppWriteRefused` makes it `refused/app-permission` at once.
- **Bounds.** A pass does GitHub I/O for at most 10 issues, with 30 s per `gh`
  call.
- **No backfill.** The first pass writes `since` once, atomically, to
  `state/issue-delivery.json`. Landings before `since` are never settled, so
  deploying this cannot close a backlog of old issues.
- **Archive hold.** `pipelineSettledForArchive` (`src/lib/pipelines/store.ts:2438`)
  keeps a completed lane hot while one of its own issue links has no final
  entry, for at most 30 days after `closedAt`. This mirrors the task-finish
  hold at `:2450-2451`.
- **Cost.** Each controller cycle makes one in-memory pass over the shared lane
  and task lists. GitHub I/O happens only for landed, unsettled issues. No speed
  change is claimed.

### 4.6 Batch merges and Git-only projects

**Batch merges.** Each lane a batch carries counts as landed through the batch:
by the runner's receipt, or by the batch title in the cache. It settles its own
issues, and the comment names both PRs: `Landed in #B (carrying #P).`

`merge-batch.ts` is unchanged. When its forwarded `Closes #N` closes a lane's
issue first, the lane records `already-closed`. When that issue is marked
`part`, the closer check in §4.3 reopens it.

**Git-only projects.** `pipelineRepository` (`src/lib/forge/resolve.ts:27`) is
null when no GitHub origin is recorded. Such a lane stores no title link, and
the sweep skips it before any read, so it makes no `gh` call from this feature.
The sweep runs outside publication, merge and completion, and none of them
waits for it. `sweepTaskFinishes` and `stagePullRequest.ts` are untouched. A
GitHub outage stays on the lane's `issueDelivery` entry and its orchestrator
line.

### 4.7 Identity, permission, text

**Writer.** The writer is `forgeWriter(run, forgeAppWriter(…, issue-scoped
tokens))`, as issue reports use it:

- In a repository declared for the Delegatus App, the App writes with
  `issues: write` and `metadata: read` only.
- Elsewhere, the machine's `gh` writes, as the merge runner already does.
- A refused App sends nothing as a person.

**This repository.** Search on 2026-11-12 found 37 issues on this repository
opened by the App, the newest on 2026-11-10, so the installation already grants
`issues: write`. Another installation without the grant ends in
`refused/app-permission` and an orchestrator line.

**Text.** Notes use fixed English sentences and numbers. The one variable part
is the PR title, which is already published. It passes `inspectPullRequestText`
again before a part note uses it, and a refused title is left out.

**Authority.** No authority is new. Anyone who can name an issue in a lane title
could already write `Closes #N` in the PR. The close still needs that PR to be
reviewed and merged into the default branch.

### 4.8 Surfaces

- **MCP and API.** `attach-link` takes `part`. `get_pipeline full` returns
  `issueDelivery`.
- **Orchestrator.** `issueDeliverySeatSignals` sits beside
  `postMergeSeatSignals` (`src/lib/monitor/seatTickSources.ts:1584`). It shows
  one line per `refused` entry, naming the issue, the PR and the reason.
- **Board.** Nothing new. The existing issue chip shows the stored link.

## 5. Shared paths and default-on effects

- **`StoredWorkLink.part`.**
  - Writers: `editStoredWorkLinks`, from the lane path and the task path. Only
    the lane path may set `part`.
  - Why lane-only: linked boards reject a task link with any key beyond the
    current five (`src/lib/links/taskWire.ts:97-103`).
  - Readers: `manualDrafts`, `resolvePipelineLinks`, the forge sweep demand and
    MCP reads ignore the field or pass it through.
- **`Pipeline.issueDelivery`** is a new optional field. The sweep is its only
  writer. Its readers are `get_pipeline full`, the seat signal and the archive
  hold.
- **Creation.** `createPipelineFromRequest` also creates refresh, recovery and
  successor lanes. The PR-kind filter stops their `#<PR>` titles from becoming
  issue links, and §4.2(3) carries the predecessor's issue across. Fixtures
  built with `buildPipeline` bypass creation. Fixtures with no recorded GitHub
  remote store nothing.
- **Tests that start the new slot.** `autoMerge.test.ts:680-743` and
  `postMerge.taskBinding.test.ts:50` call `scheduleAutoMerge`. Their lanes carry
  no issue links, so the sweep does no I/O. Its global slot must still be
  awaited and cleared there, like `__llvPostMergeRunning`.

## 6. Tests

All tests are behaviour tests with fake `gh` and writer ports. Each runs with
isolated HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR`, and with
`LLV_VIEWER_CONTROL_URL` on a closed port. Files run by path.

1. **The reported case.** A lane titled `#3900 …` in a GitHub project, with 3900
   unknown to the cache, merges through the runner. GitHub says 3900 is an open
   issue. The sweep posts `Landed in #3909.`, closes the issue as completed and
   records `closed`. A second pass writes nothing.
2. **Kinds.** For a cached PR in the title (`#3845 successor …`) nothing is
   stored. An uncached number that GitHub reads as a PR ends `skipped`, and
   nothing is written. A lane created from an issue link (`Issue #N: …`) stores
   the issue even if the client never attaches it.
3. **A task link.** An issue link on the lane's task closes the issue, including
   a link added after the lane started.
4. **Partial delivery.** The issue stays open and gets one note. If the PR's
   closing reference closed it (closer = that PR), the issue is reopened and
   noted. There is no reopen when another landed lane delivers it in full.
5. **Batch.** Through the runner's receipt and through a cached batch title, both
   carried lanes' issues close.
6. **Person merge.** There is no merge record and the cache says merged. The
   issue closes.
7. **Other base.** A merge into a non-default branch ends `skipped/other-base`
   with no write.
8. **No backfill.** A landing before `since` makes no call.
9. **Git-only.** A project with a non-GitHub origin runs creation, publication,
   completion and the task finish. The `gh` port throws if called, and nothing
   calls it.
10. **Isolation.** The sweep's runner never answers. The merge pass and the task
    finish in the same cycle still complete.
11. **Uncertain writes.** A close that timed out after landing reads as closed
    next pass. A comment that timed out after landing is found and not posted
    again.
12. **App refused.** The entry ends `refused/app-permission` with one
    orchestrator line. The person's `gh` is never called.
13. **Reopened by a person.** After `closed`, later passes do not close the issue
    again.
14. **Successor.** A lane titled `#<PR> successor: …` on the same task copies the
    predecessor's issue link, `part` included, and settles it when it lands.

## 7. Build and open changes

One lane, one review round. It touches neither the runtime host, the deploy nor
a Bun pin.

1. The pure parts of `issueDelivery.ts`: the creation rule and copy, `part` on
   attach-link, the types, and moving `landedPullRequests`. Tests 2, 3 and 14.
2. The sweep, its slot, the archive hold and the seat signal. Tests 1 and 4-13.

After this merges and deploys, the orchestrator's stopgap rule about PR wording
is retired.

Open PRs on the same files, read on 2026-11-12:

- #3801, #3747, #3710 and #3668 edit inside `createPipelineFromRequest` on older
  bases. #3668 also changes one line of `productionAutoMergePorts`.
- None of them changes the `finishesTaskIds` assignment, `scheduleAutoMerge`,
  `pipelineSettledForArchive` or `editPipelineWorkLinks`.
- #3918 changes `stagePullRequest.ts`, which B leaves alone.

The build runs `git merge-file` against those branches before it publishes.

## 8. Deferred — not currently justified

- **A closing block in the PR body** (option A). It would add GitHub's
  Development-panel link, but it needs body edits on the publication path, and
  the sweep already closes the issue. Revisit if an installation cannot grant
  `issues`.
- **Holding the close while other open lanes deliver the same issue**, as task
  finishes wait. Slices are marked `part`. Revisit if early closes are seen.
- **Lanes that finish without a PR** (research, design). The requirement names
  merged lanes.
- **Issues in a repository other than the PR's.** These need another token and a
  rule for which repository's identity applies.
- **Task-inherited issues on a lane archived before its PR lands.** This needs
  the merge setting off and a person merging more than three days after
  completion. The archive hold covers the lane's own links.
- **Reopening when a revert lands.** Post-merge recovery owns reverts, and a
  revert lane can link the issue itself.
- **A per-project switch to turn closing off.** The requirement asks for one
  default for everyone, and detach-link turns it off for one lane.
- **A board control for `part`, or a link field on `create_pipeline`.** The
  title rule and attach-link cover both. Add a control if operators ask for one.
- **Issue numbers in free task text.** Most of it is progress lists
  (`pr-issue-chips.md` §1).

## 9. Check against the requirement

| acceptance | how it holds |
|---|---|
| Linked issue closes on merge, nobody remembers | The title rule, task links, predecessor copy and attach-link feed one sweep that closes the issue after the landing (§4.2-4.5). Test 1 replays #3909. |
| Partial lane stays open with a note | The `part` marker, a note naming the PR, and a reopen when the PR closed the issue anyway (§4.3). Test 4. |
| Batch closes every carried PR's issues | Each carried lane settles through the batch landing, and the batch body still forwards closing references (§4.6). Test 5. |
| Git-only keeps working; no GitHub call blocks | No GitHub repository means no link and no call. The sweep runs on its own slot, outside publication, merge and completion (§4.6). Tests 9 and 10. |
| Behaviour tests only | §6. |
| Public text carries no identities | Fixed sentences, numbers and a published PR title, inspected again (§4.7). |
