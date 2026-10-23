# Delegatus refreshes a reviewed PR whose merge stopped on a conflict

Design, 2026-10-12. It builds on `docs/design/merge-policy-and-task-finishing.md`
(#2187), whose §4.4 sends every conflict to the operator and whose §9 deferred
"a successor lane that merges main and pushes". The operator has now asked for
that lane.

## 0. Originating requirement

Operator, 2026-10-12 about 04:30 Kyiv, in the project orchestrator's chat, in
Russian, replying to the seat's proposal that Delegatus refresh conflicting
PRs itself:

> «Что, автообновление? Согласен.»

(In English: "What, an auto-refresh? Agreed.")

The pinned specification the seat wrote for this task, verbatim:

> What happened: on the night of 2026-10-11→12, nine PRs (#2754, #2744, #2756, #2757, #2770, #2758, #2767, #2751, #2769) finished their lanes with review passed, and then auto-merge stopped with merge.state blocked: «conflict with the base branch». For each one the seat built a refresh lane by hand. A builder merged origin/main on the PR's delivery branch, committing with the enforced Delegatus machine identity plus the Codex noreply trailer. Then one review read only the resolution (`git show --remerge-diff`), and auto-merge followed. One case (#2754) hit a semantic conflict: main added the role curator, and the PR's costume map lacked it, so rendering threw. That one needed a decision.
>
> Acceptance:
> - When auto-merge blocks because the PR conflicts with its base, and the lane's reviews passed (or its budget is spent with the last fix passed), Delegatus starts the refresh itself, at most once per base movement. It must not race another refresh on the same PR, and it must not touch a PR whose lane is not finished.
> - The refresh runs as visible pipeline work on the same board task: a refresh stage on the PR's delivery branch, one resolution-only review (1 round), and a fix stage. Then the existing auto-merge takes over. The commit identity follows the project's hooks (the enforced Delegatus identity plus the Codex noreply trailer). It never uses GitHub update-branch.
> - A refresh that cannot resolve without changing either side's behaviour (a semantic conflict) parks needs_decision, naming the hunk, and the seat is told. It never guesses.
> - If a refresh fails or parks, the PR stays unmerged with a plain reason on the card. Nothing merges red.
> - The merge setting («Merge when the review passes») still governs: when it is off, nothing is refreshed automatically.
> - Tests cover: one conflict starting exactly one refresh; a second base movement during a refresh; a semantic conflict parking; the setting off; a non-finished lane being left alone; and restart safety (no duplicate refresh after a Viewer restart).
> - The project's own checks pass (pre-push gate). Fences: lane 022c8be9 (PR #2773, CPU admission queue) is changing src/lib/runtime/cpuPressure.ts and src/lib/workflows/engine.ts, so stay out of them. Production deploys are frozen by an incident.

## 1. What the seat did by hand

Read-only evidence, 2026-10-12 about 07:30 Kyiv: this machine's pipeline store
(`state.sqlite`, opened read-only) and `get_pipeline`.

The seat built **14 refresh lanes** on 2026-10-11 and 2026-10-12, all of one
shape:

- created from main, with `delivery: { branch: <the PR's delivery branch>, pr: N }`,
  the finished lane's `taskIds` and `finishesTaskIds`, and
  `publication: "remote-branch"`;
- three run stages: `refresh` (builder, no fail edge, `next: "review"`) →
  `review` (reviewer, `onFail: { to: "fix", maxRounds: 1, onExhausted: "advance" }`,
  `next: null`) ⇄ `fix` (builder in `apply-fixes` mode, `next: "review"`).

By 07:30 seven of them had merged (six by the merge runner, one outside it) and
seven were running. One complete run, #2757:

| UTC, 2026-10-12 | What happened |
|---|---|
| 00:27:13 | lane 0f1a2b9a completes, budget spent with the last fix passed; its merge record is queued |
| 00:27:43 | the runner reads `DIRTY` and blocks: «conflict with the base branch» |
| 00:34:45 | the seat creates lane 884eca93; it claims the PR's delivery target at epoch 2 (the old lane released epoch 1 on completion) |
| 04:16:42 | 884eca93 completes (refresh passed, review passed) and its own merge record is queued |
| 04:20:19 | the runner squash-merges #2757 |
| 04:21:47 | the old lane's blocked record reads "merged, by outside" from the forge cache, and the task finish is recorded |

#2754 is the semantic case (lane 8cf74468, refresh lane d7678b6a). The refresh
builder's first attempt reported one P1 finding naming `src/lib/roles/types.ts:12`,
merge hunk `@@ -9,6 +9,7 @@` (main added `curator` to `ROLE_IDS`), and
`src/components/brand/roleCostumes.ts:166`, where `costumeSvg` throws for a role
with no drawing. The refresh stage has no fail edge, so the lane parked with
that finding as its reason, and the seat took it to the operator.

So every moving part already exists and has run end to end seven times. What
is missing is the trigger, a record on the finished lane saying the refresh is
under way, and the rules that keep it to one.

Earlier work: `search_transcripts` (project-scoped and unscoped: "refresh
remerge-diff conflict", "автообновление конфликт", "successor lane delivery
takeover epoch") found these lanes and their briefs, and nothing that designed
an automatic refresh. `search_memory` had nothing on it.

## 2. The current path, and where the conflict is detected

- **Queueing.** `sweepAutoMerge` (`src/lib/forge/autoMerge.ts:576`) gives a
  completed lane a merge record once, when the setting is on and the lane is
  eligible (`:582-596`). `mergeEligible` (`:97`) is exactly the specification's
  rule: every review stage that ran passed, was accepted, or spent its budget
  with the fix of its last findings passed. Then it steps the head of each
  repository's queue whose next read is due (`:615-633`).
- **Reading.** `stepLane` (`:406`) runs `gh pr view --json` with `PR_FIELDS`
  (`:48`), admits the runner's own update heads, and asks `decideMerge`.
- **Detection.** `decideMerge` (`:335`): `mergeStateStatus === "DIRTY" ||
  mergeable === "CONFLICTING"` answers `{ kind: "block", reason:
  MERGE_REASONS.conflict }`. It runs after the head fence (`:325`), so the PR
  head is the reviewed head or one of the runner's own update commits.
- **Blocking.** The block branch (`:480-483`) writes `state: "blocked"`, the
  reason and `blockedAt` under the pipeline lock, compared on
  `merge.updatedAt` (`commit`, `:381-389`). A blocked record leaves the queue
  (only `PIPELINE_MERGE_LIVE_STATES`, `src/lib/pipelines/types.ts:1129`, are
  queued), raises `lane-merge` in Needs you (`src/components/attention/needReason.ts:97-111`,
  `mergeNeedsYou` at `src/components/pipelines/pipelineBlockModel.ts:377`),
  shows «Merge stopped: conflict with the base branch.», and reaches the seat
  under `unmerged-pr` with `mergeBlocked` (`src/lib/monitor/seatTickSources.ts:1782-1790`).
  `retry-merge` (`src/lib/pipelines/engine.ts:12614`) queues it again and
  counts `attempts`.
- **Settling elsewhere.** A blocked or cancelled record turns "merged, by
  outside" when the forge cache reads the PR merged (`autoMerge.ts:603-612`).
  Turning the setting off cancels a live record that is not merging
  (`:598-601`).
- **Finishing.** `laneFinishedForTasks` (`:650`) waits for the PR to merge, and
  `openPipelinesOnTask` (`src/lib/pipelines/taskFinish.ts:14`) holds the move to
  Done while another lane on the task is open.
- **Delivery.** `assignPipelineDelivery` (`src/lib/pipelines/store.ts:1490`)
  makes a new lane on a target with an active owner a `comparison` lane, which
  never publishes; otherwise the lane claims the target at the previous epoch
  plus one. Completion releases the claim unless a publication is in flight
  (`releaseTerminalDelivery`, `store.ts:1458-1468`); a park keeps it. `createPipelineWithDelivery`
  (`store.ts:1505`) looks up `creationRequest.key` inside the same transaction,
  over the hot and archive collections (`src/lib/state/sqliteStateStore.ts:1083-1114`),
  and returns the first lane for a repeated key. A lane whose delivery ref is
  checked out in another worktree provisions on its own lane ref from the
  remote delivery head and still publishes to the delivery target
  (`src/lib/pipelines/git.ts:220-330`).

## 3. Where the refresh is recorded

**A. Append `refresh → review → fix` to the finished lane and reopen it.**

- `completed` is terminal for every reader. `closedAt` is set, the delivery
  claim is released, and `takeoverPipelineDelivery` refuses a terminal lane
  (`store.ts:1541`). Host reaping and the worktree sweep settle after
  completion, the lane archives three days after `closedAt` (`store.ts:1576`),
  and the seat was already told "completed" once (`seatTickSources.ts:915-950`).
- The merge record belongs to the completed lane: `commit` writes only while
  `live.state === "completed"` (`autoMerge.ts:384`). `mergeEligible` and
  `reviewedHead` (`:269`) would mix the PR's own reviews with the resolution
  review.
- The operator's rule of 2026-10-09 fixes a review budget when the lane is
  created and never grows it. A review stage added to a started lane is that
  growth.
- It needs a new completed-to-running transition, a re-claim of the target by
  the same lane, and a change in each terminal-state reader.

**B. A successor lane on the same delivery target and the same board task.**

- It is the seat's hand-built shape (§1). Delivery epochs, provisioning on a
  held ref, publication to the target, the merge record at completion and the
  task finish with its waits all exist and have run.
- The successor's one review round is fixed when it is created. The finished
  lane's reviews stay the unchanged record of what was reviewed at its head.
- Cost: a second lane row on the task card, and the finished lane needs a merge
  state that says Delegatus is on it, so it stops asking the operator.

**Decision: B.** A is a new lifecycle for one feature; B is the path that
already merged six PRs last night.

## 4. Design

Names used below: the **finished lane** is the one whose merge stopped; the
**refresh lane** is the successor Delegatus starts.

### 4.1 Trigger and admission

The trigger sits in `stepLane`, where `decideMerge` answers the conflict block.
That is the only place a conflict is observed, so the refresh starts "when
auto-merge blocks because the PR conflicts". A record already blocked before
this ships is never picked up by a sweep; a `retry-merge` on it reads the PR
again and passes through the same point. The first run of the new code
therefore starts no burst of refresh lanes.

Admission is one pure function, `refreshAdmission(lane, pipelines, setting)`,
in a new module `src/lib/forge/autoRefresh.ts`. All of these must hold:

1. The project's merge setting is on, read again now (#2187 §4.1 reads it before
   each move).
2. The finished lane owns its delivery target: `delivery.disposition ===
   "owner"`, `delivery.active === false` (released at completion, so no
   publication is in flight), and `merge.prNumber` is set. A lane without a
   delivery target, or a comparison lane, is never refreshed.
3. No other pipeline that is neither `completed` nor `closed` (hidden ones
   excluded) has the same delivery target (`repository` and `branch`) or joins
   the same PR through `lanePullRequest` (`autoMerge.ts:123`). This is "never
   touch a PR whose lane is not finished", and the first half of "no race".
4. `merge.refresh` is absent, or was made for an earlier `merge.attempts`. One
   refresh per stopped merge; the operator's `retry-merge`, which increments
   `attempts`, allows the next one.

When admitted, the runner reads the base tip once, `gh api
repos/<owner>/<repo>/branches/<baseRefName> --jq .commit.sha`, inside the
existing `try` block, so a failed read takes the existing read-failure path
(read again in 60 s, block as unreachable after three). The installed `gh`
2.45 has no `baseRefOid` field in `pr view --json` (checked). The read happens
only for an admitted conflict, so the current `DIRTY` test, whose lanes have no
delivery target, sees no new call.

5. When the finished lane is itself a refresh lane (`refreshOf` is set) and
   `refreshOf.base` equals the tip just read, the merge blocks with a new
   reason, «the refresh did not clear the conflict, and main has not moved
   since» (§4.5).

If 1 to 4 fail, the merge blocks with «conflict with the base branch» exactly
as it does today.

### 4.2 The refresh lane

Created with `createPipelineFromRequest` (`engine.ts:10398`) as the Viewer's own
create: no briefer, so no sizing rules apply; an engine nobody is signed in to
is refused as for any started lane.

```ts
const request: CreatePipelineRequest = {
  task: `#${pr} ${firstLine(finished.task, 60)}: merge current ${base}, resolve the conflict, review the resolution only`,
  taskIds: finished.taskIds,
  finishesTask: finished.finishesTaskIds ?? false,
  spec: refreshSpec(finished, pr, base, baseSha, head),
  repoDir: finished.repoDir,
  baseBranch: base,
  delivery: { branch: finished.delivery.target.branch, remote: finished.delivery.target.remote, pr },
  publication: "remote-branch",
  autoStart: true,
  stages: [REFRESH_STAGE, REVIEW_STAGE, FIX_STAGE],
};
const options = {
  creationRequest: { key: refresh.key, digest: refresh.digest },
  refreshOf: { pipelineId: finished.id, base: baseSha, lineage },
};
```

The three stages are the hand-built ones, with role presets and no pinned
engine or model, so each resolves through the role registry like any lane:

```ts
{ id: "refresh", kind: "run", role: { roleId: "builder" }, next: "review", onFail: null, "prompt": REFRESH_PROMPT }
{ id: "review", kind: "run", role: { roleId: "reviewer" }, next: null,
  onFail: { to: "fix", maxRounds: 1, onExhausted: "advance" }, "prompt": REVIEW_PROMPT }
{ id: "fix", kind: "run", role: { roleId: "builder", params: { mode: "apply-fixes" } }, next: "review", onFail: null, "prompt": FIX_PROMPT }
```

`REFRESH_PROMPT`, with the PR facts filled in:

> Merge current origin/{base} into this PR's delivery branch {branch} as a merge
> commit on top of the reviewed head {head}, and resolve every conflict so both
> sides keep their behaviour: the PR keeps what {head} does, and main keeps
> everything it merged. Never rebase, never force-push, never call GitHub's
> update-branch. The launch environment sets the Delegatus machine identity;
> keep your engine's noreply Co-Authored-By trailer. Run the tests of the files
> the PR touches and of the files your resolution changed, by path, through
> scripts/gate-slot.sh with an isolated HOME, TMPDIR and LLV_STATE_DIR. If a
> conflict cannot be resolved without changing either side's behaviour, run
> `git merge --abort` so nothing partial is committed, and report
> needs_decision with exactly one finding: the file:line, the merge hunk's `@@`
> header, and the behaviour each possible resolution would change. This stage
> has no fail edge, so that finding parks the lane for a decision. Never guess.

`REVIEW_PROMPT`:

> Review only the refresh merge on PR #{pr}: `git show --remerge-diff` of the
> merge commit on top of {head}, plus main's changes to the files the PR
> touches (`git diff {head}...<merge>^2 -- <those files>`). Confirm that no hunk
> of either side was lost or changed in behaviour, and that the focused tests
> pass on the merged head. The PR's own changes passed review at {head}; do not
> review them again.

`FIX_PROMPT`:

> Fix the resolution findings on this PR's delivery branch, never another.
> Never rebase, force-push or call update-branch. Your verdict is pass unless
> you are blocked.

`refreshSpec` pins the operator's sentence of §0, the review rule of 2026-10-09
("a content-preserving refresh from main gets one review of the resolution
only"), the facts (PR, finished lane, base and its tip, the reviewed head) and
the acceptance lines of §0 that bind the lane: both sides survive; identity
from the launch environment plus the noreply trailer; never update-branch,
rebase or force-push; a semantic conflict parks with the hunk named; the
review reads only the resolution; the project's checks pass.

**Owner.** `lineage` is the project's active seat (`orchestratorSeatFor(project).active`,
`src/lib/orchestrator/seats.ts:551`, its `conversationId` and `path`) when one
holds the project; otherwise the finished lane's own `srcPath`,
`srcConversationId` and `srcDeputyConversationId`. The seat wake reports a
lane to the seat whose conversation created it (`seatTickSources.ts:992`), and
the creator may answer the lane's decision, so the seat is the owner that has
to hear about a park. The option bypasses transcript lookup because the
Viewer already holds both ids.

**Identity.** Nothing new. CONTRIBUTING.md ("Commits from launched agents"):
every launched stage gets the Delegatus machine identity in its environment,
the launch hooks refuse rewriting another author's commits, and the
repository's own hooks run, publication gate included. The refresh is an
ordinary builder commit in a pipeline worktree; the Viewer publishes it to the
delivery target through the pre-push gate (`publication: "remote-branch"`).
No path in this design calls `update-branch`.

**After the refresh.** The refresh lane completes like any lane and, being
eligible, gets its own merge record (`autoMerge.ts:582-596`); its `chain`
starts at the head it published, which is the PR head. The existing runner
waits for settled green checks and merges. A `BEHIND` read there takes the
runner's existing update path through the App write seam
(`AutoMergePorts.write`, `autoMerge.ts:54-58`); that path predates this design
and is unchanged by it.

### 4.3 The finished lane's record: a new merge state, `refreshing`

`PipelineMergeState` gains `"refreshing"`. It stays out of
`PIPELINE_MERGE_LIVE_STATES`, so the runner never steps it and it never holds
its repository's queue for the hours a refresh takes. It is not `blocked`, so
it raises no `lane-merge` need, offers no "Try the merge again", and is not
dismissible. `PipelineMerge` gains:

```ts
/** The refresh Delegatus started when this merge stopped on a conflict
    (docs/design/auto-refresh-conflicting-prs.md). */
refresh?: {
  /** `attempts` when it started: one refresh per stopped merge. */
  attempt: number;
  /** Forge base name; absent on older reservations. */
  baseBranch?: string;
  /** The base tip GitHub reported the conflict against, and the PR head. */
  base: string;
  head: string;
  /** The refresh lane's creation key and digest, reused verbatim on replay. */
  key: string;
  digest: string;
  requestedAt: string;
  /** Null until the create answered. */
  pipelineId: string | null;
};
```

`Pipeline` gains `refreshOf?: { pipelineId: string; base: string }`, written at
creation on the refresh lane and never changed.

| From | Event | To | Where |
|---|---|---|---|
| a live state | conflict read, admitted (§4.1) | `refreshing`, `refresh` reserved with `pipelineId: null` | `stepLane` |
| a live state | conflict read, admission fails | `blocked`: conflict with the base branch (today) | `stepLane` |
| a live state, lane is a refresh lane | conflict read, `refreshOf.base` is the current tip | `blocked`: the refresh did not clear the conflict… | `stepLane` |
| `refreshing`, no `pipelineId` | the create answered a lane | `refreshing`, `pipelineId` set | `startRefresh` |
| `refreshing`, no `pipelineId` | the create refused (an error answer) | `blocked`: Delegatus could not start the refresh: {message} | `startRefresh` |
| `refreshing`, no `pipelineId` | the create threw (store busy, process died) | unchanged, `readFailures + 1`; the next pass tries again; the third failure blocks as above | sweep |
| `refreshing` | the refresh lane's merge is `merged`, or the forge cache reads the PR merged | `merged`, `by` copied from the refresh lane's record (else `outside`) | sweep |
| `refreshing` | the forge cache reads the PR closed | `blocked`: the PR was closed | sweep |
| `refreshing` | the refresh lane is `closed` | `blocked`: the refresh was closed before the PR merged | sweep |
| `refreshing` | the setting is turned off | `cancelled`: the project's merge setting was turned off | sweep |
| delegated record | refresh completes and its merge progresses | reflect the successor's queue, check-waiting or stopped state, still outside the queue | sweep |
| `blocked`, `cancelled` or stale `refreshing` | `retry-merge`, refresh completed | retry or admit the successor's merge in the same transaction | operator |
| `blocked`, `cancelled` or stale `refreshing` | `retry-merge`, refresh closed | remove delegation, `queued`, `attempts + 1` | operator |

While the refresh lane runs or parks, the finished lane stays `refreshing`.
After completion it reflects the successor's merge progress. The successor
continues to own the PR's reviewed head and the repository queue. A refresh
lane archived before the PR settles leaves the finished lane as it is; both
archive three days after their own `closedAt`.

### 4.4 Exactly one refresh, across races and restarts

Three steps, each durable before the next:

1. **Reserve.** Under the pipeline lock, through the existing `commit`
   (compared on `merge.updatedAt`): `state = "refreshing"`, `reason = null`,
   `nextReadAt = null`, and `refresh = { attempt, base, head, key, digest,
   requestedAt, pipelineId: null }`, with `key =
   "auto-refresh:<finished lane id>:<attempt>"` and `digest` the SHA-256 of
   those facts plus the PR number. A writer that changed the record since the
   read (a retry, the setting cancel, a second Viewer generation) makes the
   compare fail, and nothing is created.
2. **Create.** With no lock held, `createPipelineFromRequest(request, ports,
   { creationRequest: { key, digest }, refreshOf })`. Its replay check inside
   the delivery transaction (`store.ts:1505-1515`) returns the lane already
   made under that key, from the hot or the archive collection. With
   `refreshOf` present, `createPipelineWithDelivery` also refuses, in the same
   transaction, when the target has an active owner: the refresh lane is the
   target's owner or does not exist. Today such a lane would quietly become a
   comparison lane that never publishes.
3. **Record.** Under the lock: `refresh.pipelineId = <id>`.

A restart between any two steps leaves a record that says what happened. The
sweep (§4.3) finds `refreshing` with `pipelineId: null` and repeats step 2 with
the stored key and digest, which either creates the lane or returns the one a
dead process already made; step 3 follows. Two Viewer generations during a
release handoff each run the sweep: step 1 lets one of them reserve, and the
key lets one lane exist. The key carries `attempt` so an explicit
`retry-merge` can start a fresh refresh; it carries no base because the
reservation fixes the base before the create.

"Never race another refresh on the same PR" holds three ways: admission rule 3
(no open lane on the target or the PR), the reservation's compare, and the
create's owner refusal. "Never touch a PR whose lane is not finished": only a
`completed` lane has a merge record, and rule 3 excludes a PR any open lane
works on.

### 4.5 Once per base movement

- One stopped merge starts at most one refresh (rule 4).
- A refresh lane whose own merge stops on a conflict starts another refresh
  only when the base tip moved since its creation (`refreshOf.base` differs
  from the tip read now). Otherwise it blocks with «the refresh did not clear
  the conflict, and main has not moved since», which ends any loop of no-op
  refreshes.

A second base movement during a refresh, step by step:

1. Finished lane F conflicts at base tip B1; F is `refreshing`; refresh lane R1
   is created with `refreshOf.base = B1`.
2. Main moves to B2 while R1 runs. F is not stepped (`refreshing` is not live),
   R1 has no merge record yet, and admission for anything on this PR fails
   rule 3 because R1 is open. Nothing new starts.
3. R1 completes; its merge record queues.
   - If B2 merges cleanly into R1's head, the runner merges (or takes its
     existing `BEHIND` path first).
   - If B2 conflicts, R1's merge reads the conflict; B2 differs from B1, so R1
     goes `refreshing` and R2 is created with `refreshOf.base = B2`, one lane
     for the movement.
   - If R1's builder had not merged B1 at all and the base is still B1, R1
     blocks with the "did not clear" reason, and no R2 starts.

The refresh builder fetches main when it runs, so it often merges a tip newer
than B1. The record keeps B1 because B1 is what the conflict was read
against, and a newer merged tip only makes rule 5 stricter.

### 4.6 A semantic conflict

The refresh prompt (§4.2) asks for `needs_decision` with exactly one finding
that names the file and line, the merge hunk's `@@` header, and what each
resolution would change. The engine already parks such a verdict on a stage
with no fail edge and makes the finding the park reason
(`engine.ts:4686-4733`, `park` at `:2155`; proven by
`src/lib/pipelines/stageCompletion.test.ts:887`, "a needs_decision parks with no
fail edge"). The #2754 attempt is that case in production.

- **The hunk is named** in the lane's `stateDetail` and the stage's verdict,
  both shown on the task card.
- **The seat is told**: the refresh lane's creator is the seat (§4.2 Owner),
  and the seat wake reports its own lanes that settle `needs_decision`
  (`seatTickSources.ts:915-950`, `:992`). The seat may answer through
  `resolve-decision`, which starts a fresh refresh attempt with the answer, or
  the operator decides.
- **Nothing is guessed or merged**: the refresh lane cannot complete without a
  passing refresh, so it gets no merge record, and the finished lane stays
  `refreshing`, which the runner never merges.

### 4.7 Failures and parks: what the card says

| Situation | The task card shows | Needs you |
|---|---|---|
| refresh running | finished lane: "done · updating from main"; refresh lane: its stages | nothing new |
| refresh parked (semantic conflict, a failed check the builder could not fix, a refused publication) | refresh lane: the park reason, e.g. the finding with the hunk | `lane-decision` for the refresh lane |
| refresh lane closed by someone | finished lane: «Merge stopped: the refresh was closed before the PR merged.» | `lane-merge`, with "Try the merge again" / "Leave the PR open" |
| create refused (task deleted, engine not signed in, target owned) | finished lane: «Merge stopped: Delegatus could not start the refresh: {message}.» | `lane-merge` |
| refresh did not clear the conflict | refresh lane: «Merge stopped: the refresh did not clear the conflict, and main has not moved since.» | `lane-merge` |
| refresh lane's own merge stops (a red check, protection) | refresh lane: its existing reason | `lane-merge` for the refresh lane |

In every row the PR stays open until checks are settled and green on the head
the runner merges (#2187 §4.3), so nothing merges red.

### 4.8 The merge setting

- Off when the conflict is read: admission rule 1 fails and the merge blocks
  as today. With the setting off from the start, no lane is ever queued
  (`autoMerge.ts:584`), so no conflict is read at all.
- Turned off while refreshing: the finished lane goes `cancelled` with the
  setting reason (the sweep's cancel condition at `:598` gains `refreshing`).
  A refresh lane already running keeps running, visible on the card, and the
  operator may close it. When it completes, the setting is off, so it gets no
  merge record and the PR stays open. This follows #2187 §4.1: turning the
  setting off cancels what only waits and interrupts no work in flight.
- Turned on again: `retry-merge` on the cancelled record re-reads the PR;
  admission rule 3 keeps a second refresh from starting while the first lane
  is open.

### 4.9 What the board, Needs you and the seat see

No new control, word or action.

- `laneMergeWord` (`pipelineBlockModel.ts:351`) maps `refreshing` to the
  existing word `updating` ("updating from main" / «оновлюється з main»),
  which `laneMergeUnsettled` keeps out of the finished fold.
- Three reason sentences join `MERGE_REASONS` (`src/lib/forge/mergeReasons.ts`)
  and the en and uk dictionaries: `refreshClosed`, `refreshSameBase`, and the
  pattern `refusedRefresh` (`/^Delegatus could not start the refresh: (.+)$/`).
  `mergeReasonText` maps them as it maps the others (`pipelineBlockModel.ts:395`).
- The seat's `unmerged-pr` list skips `refreshing` the way it skips live
  states (`seatTickSources.ts:1782`); the needs-you read counts it with them
  (`src/lib/attention/needsYouRead.ts:98`).
- `mergeFields` (`src/lib/mcp/bindings.ts:5191`) adds `refresh: <lane id>`
  while one exists, so `list_pipelines` names the lane carrying the PR.
- The mandate's merge bar (`src/lib/orchestrator/prompt.ts:462`) lists
  `refreshing` among the states the seat leaves alone. That is a few bytes; run
  `prompt.test.ts` and `handoffDigest.test.ts`, because the mandate sits just
  under its envelope.

## 5. Changes by file

| File | Change |
|---|---|
| `src/lib/forge/autoRefresh.ts` (new) | `refreshAdmission`, the base-tip read helper, the stage and spec templates, `refreshRequest`, `refreshLineage`, `startRefresh` (create plus record) |
| `src/lib/forge/autoMerge.ts` | `stepLane`: base read and reservation on an admitted conflict, the "did not clear" block; `sweepAutoMerge`: the `refreshing` rows of §4.3; `AutoMergePorts` gains `startRefresh` and `activeSeat`, wired in `productionAutoMergePorts` through dynamic imports of the pipeline engine and the seat store (the engine imports `nudgeAutoMerge`, so a static import would close a cycle); the header comment's "Nothing here resolves a conflict" gains "it starts a refresh lane, §4" |
| `src/lib/forge/mergeReasons.ts` | three reasons, one pattern |
| `src/lib/pipelines/types.ts` | `"refreshing"` in `PipelineMergeState` (kept out of the live set); `PipelineMerge.refresh`; `Pipeline.refreshOf` |
| `src/lib/pipelines/store.ts` | `MERGE_STATES` gains `refreshing`; validators for `merge.refresh` and `refreshOf`; `createPipelineWithDelivery(…, { requireOwner })` refuses inside its transaction when the target has an active owner |
| `src/lib/pipelines/engine.ts` | `CreatePipelineOptions.refreshOf` (`pipelineId`, `base`, `lineage`): sets `pipeline.refreshOf`, uses `lineage` as the creator, and passes `requireOwner` to the store. About ten lines, all inside `CreatePipelineOptions` and `createPipelineFromRequest` (`:10320-10610`) |
| `src/components/pipelines/pipelineBlockModel.ts` | `refreshing` → `updating` |
| `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` | three `pipelineBlock.mergeReason.*` keys beside the existing ones (about line 2618) |
| `src/lib/monitor/seatTickSources.ts`, `src/lib/attention/needsYouRead.ts` | treat `refreshing` like a live merge |
| `src/lib/mcp/bindings.ts` | `refresh` in `mergeFields` |
| `src/lib/orchestrator/prompt.ts` | `refreshing` in the held list |
| `docs/design/merge-policy-and-task-finishing.md` | §4.4's "never resolved by the runner" and §9's deferred item point here |

**Fences.** Nothing here touches `src/lib/runtime/cpuPressure.ts` or
`src/lib/workflows/engine.ts`. PR #2773's actual file list (read with `gh pr
view 2773 --json files`) also changes `src/lib/pipelines/engine.ts`,
`src/lib/workflows/provision.ts`, `PipelineBlock.tsx`, both i18n files and the
kanban driver and fixture. Its engine hunks are at lines 6-8, 280-288,
1387-1405, 6046-6090 and 9398 (spawn admission); this design's engine edit is
inside `createPipelineFromRequest`, far from them. Its i18n hunks are near line
4390; ours are near 2618. This design does not touch `provision.ts` (it only
keeps using `realExec`) or `PipelineBlock.tsx`. The kanban driver and fixture
get one new block (§6); #2773 adds its block near the top of the driver, so
build after #2773 lands, or append at the end.

## 6. Tests for each acceptance line

New file `src/lib/forge/autoRefresh.test.ts`, on the fake `gh` and clock of
`autoMerge.test.ts` (sandboxed `LLV_STATE_DIR`, invented repositories and heads),
extended with branch tips and a recording `startRefresh` that keeps lanes by
creation key the way the store does. The real-store cases use the sandboxed
SQLite store.

| Acceptance line | Test |
|---|---|
| one conflict starts exactly one refresh | A completed reviewed lane that owns its delivery target reads `DIRTY`: after ten sweeps over 30 minutes, `startRefresh` ran once with key `auto-refresh:<id>:0`; the request carries the lane's `taskIds`, `finishesTask`, delivery branch, remote and PR, `publication: "remote-branch"`, and the three stages with their edges and roles; the record is `refreshing` with that `pipelineId`; `laneMergeWord` says `updating`; no `lane-merge` need; no `gh pr merge` and no `update-branch` call. The same with `budgetSpent` plus a passed fix |
| a second base movement during a refresh | §4.5 scripted: the tip moves B1 → B2 while R1 runs → no second create; R1 completes and conflicts at B2 → exactly one create for R1 with `refreshOf.base = B2`; a variant where R1 conflicts at B1 again blocks with the "did not clear" reason and creates nothing |
| a semantic conflict parks | the generated refresh stage has `onFail: null` and its prompt asks for `needs_decision` with one finding naming file:line and the `@@` header (the engine rule is already proven by `stageCompletion.test.ts:887`); a refresh lane in `needs_decision` whose `stateDetail` names a hunk: sweeps leave the finished lane `refreshing`, call no `gh pr merge` and start no second refresh; the refresh lane raises `lane-decision` and the finished lane raises nothing; the seat tick's own-lane source (`ownSettledLanes`) reports the refresh lane as `needs_decision` to the seat whose conversation is its creator |
| the setting off | off from the start: no record, no `gh`, no create; a setting that turns off between the sweep's cancel check and the step: the conflict blocks as today with no create; off while refreshing: the finished lane goes `cancelled`, the refresh lane is untouched, and on completion it gets no merge record and nothing is merged |
| a non-finished lane is left alone | lanes in `running`, `needs_review` and `needs_decision` whose PRs conflict: no record, no create; a completed lane whose PR is also targeted by an open lane (same delivery branch, and separately the same PR number): the conflict blocks as today with no create; real store: `createPipelineWithDelivery` with `requireOwner` refuses when the target has an active owner and creates when the owner released |
| restart safety | a create that throws after the reservation, then `resetAutoMergeForTests()` and a second sweep: one lane, created with the stored key and digest; a create that succeeds but whose answer is lost, then a second sweep: the replay answers the same lane and `pipelineId` is written; real store: the same creation key twice, and concurrently, yields one row and one id; two sweeps with separate ports over one shared record: one reservation, one lane |
| refresh failure leaves a plain reason | each row of §4.7 sets the stated reason, and `mergeReasonText` renders it in en and uk |
| the existing runner is unchanged | `autoMerge.test.ts` passes untouched, including "DIRTY blocks: a conflict is never resolved by the runner" (its lanes have no delivery target, so admission fails and no new `gh` call happens) |

Beside it: `pipelineBlockModel.test.ts` (`refreshing` → `updating`; the three
reasons), `seatTickSources.test.ts` (a `refreshing` lane is not listed in
`unmerged-pr`), `needsYouRead.test.ts`, `bindings.test.ts` (`refresh` in
`mergeFields`), `src/lib/i18n/i18n.test.ts` (key parity), `prompt.test.ts` and
`handoffDigest.test.ts`. Rendered evidence goes through the existing kanban
driver (`kanbanBoard.browser.test.tsx` over `issue1695Evidence.fixture.tsx`),
one `describe` block: a task whose finished lane is `refreshing` beside its
running refresh lane, and a finished lane stopped with each new reason, at 1440
and 390, en and uk, measuring that the reason line neither overflows nor
overlaps a control.

## 7. Checks the build runs

`bunx tsc --noEmit` logged to a file; changed-file ESLint; each touched test
file by path through `bash scripts/gate-slot.sh bun test <file>` with an
isolated HOME, XDG directories, TMPDIR and `LLV_STATE_DIR`, and with
`LLV_VIEWER_CONTROL_URL` pointed at a closed port; the kanban driver block
under `LLV_KANBAN_BROWSER_TEST=1` and `CHROME_BIN`, through `gate-slot.sh`; the
privacy gate with the committed fingerprints; then the pre-push gate at
publication. No suite that sweeps runtime directories runs against live state
(AGENTS.md). No deploy: production deploys are frozen.

## 8. Deferred — not currently justified

- **Refreshing lanes that were blocked before this ships.** The trigger is a
  fresh conflict read. `retry-merge` on an old record goes through it, and no
  sweep starts a burst of lanes.
- **A cap on refreshes per PR.** Rule 5 ends no-op loops; each further refresh
  needs a real base movement that conflicts again.
- **Mirroring a parked refresh into the finished lane's reason.** The refresh
  lane's park reason and its Needs-you line already sit on the same task card;
  a second line on the finished lane would raise a duplicate need.
- **The park detail in the seat wake.** The wake names the lane and its
  `needs_decision`; the seat reads the hunk with `get_pipeline`. Adding detail
  changes the wake for every parked lane.
- **Refreshing a `BEHIND` PR through a lane.** Implemented by the strict-base
  amendment below; the earlier GitHub update path is retired.
- **A localized title for the refresh lane.** It follows the English shape of
  the seat's hand-built titles and of other engine-generated lane text.
- **A lifecycle event for a started refresh.** The lane's creation and the
  record's `refresh` already say it.
- **Closing a running refresh lane when the setting is turned off.** That
  would destroy visible work the operator can close with one action.

## 9. Check against the requirement

| Requirement | Where |
|---|---|
| «Что, автообновление? Согласен.» — Delegatus refreshes conflicting PRs itself | §4.1 trigger, §4.2 lane |
| starts on a conflict block of a lane whose reviews passed or spent their budget with the last fix passed | §2 (the merge record exists only for `mergeEligible` lanes), §4.1 |
| at most once per base movement | §4.1 rules 4 and 5, §4.5 |
| never races another refresh on the PR | §4.1 rule 3, §4.4 |
| never touches a PR whose lane is not finished | §4.1 rules 2 and 3, §4.4 |
| visible pipeline work on the same board task: refresh, one resolution-only review, a fix stage | §3 B, §4.2 |
| then the existing auto-merge takes over | §4.2 "After the refresh" |
| identity from the project's hooks plus the noreply trailer; never update-branch | §4.2 "Identity" and the prompts |
| a semantic conflict parks `needs_decision` naming the hunk, the seat is told, nothing guessed | §4.6 |
| a failed or parked refresh leaves the PR unmerged with a plain reason; nothing merges red | §4.3, §4.7 |
| the merge setting governs | §4.8 |
| tests for each named case | §6 |
| the project's checks pass; fences kept | §5 Fences, §7 |

## 10. Notes

- The fence in the specification names `src/lib/workflows/engine.ts`. PR
  #2773's file list (§5) includes `src/lib/pipelines/engine.ts`, and
  `src/lib/workflows/engine.ts` is absent from it. This design keeps its one
  engine edit inside `createPipelineFromRequest`, away from #2773's hunks.
- No operator decision is open. The questions this design answered from the
  code and from last night's record: successor lane (§3), no burst for old
  blocks (§8), a running refresh survives turning the setting off (§4.8), and
  the seat owns the refresh lane (§4.2).


## Completion and recovery (2026-10-19)

The controller's global merge sweep reconciles persisted refresh completion on
its next pass, including after a delayed or missed completion wake. The refresh
lane owns the resolution's reviewed head and the existing check-settle clock.
The original lane reflects that merge's queued, check-waiting, stopped and
merged states. A record with `refresh.pipelineId` stays outside the repository
queue, so reflecting progress cannot merge the original, older head or perform
a second merge. Red checks stop both records with the same reason.

`retry-merge` accepts a refreshing original whose refresh lane has completed
or closed. Completion retries or admits the successor's merge record in the
same registry transaction. An already queued successor is nudged; its checks
still have to pass. Closure removes the delegation and queues the original for
a fresh forge read. An open refresh, unavailable or conflicting lineage, and a
project with automatic merging disabled refuse the retry. A stale refreshing
record on another completed or closed lane never vetoes admission of a carrier
on the same PR.

A new refresh reservation saves the forge PR base branch alongside its SHA and
includes the branch in its creation digest. The request, task and stage prompts
use that saved branch. Older reservations remain readable; creation replay
reads the PR's forge base, with the repository default branch as fallback. The
lane's checkout `baseBranch` supplies no refresh-source authority, because a PR
successor may have checked out its own delivery branch. A source equal to the
delivery branch is refused. Existing reservations keep their creation keys and
digests during replay.

Regression coverage lives in `src/lib/forge/autoRefresh.test.ts`,
`src/lib/forge/autoMergeStore.test.ts` and
`src/lib/pipelines/engine.ports.test.ts`. The controller cases settle a real
refresh review, delay the handoff by zero or 27 seconds, and require one merge
at the refreshed head only after checks pass. This change claims no performance
gain.


## Strict base updates (2026-10-23)

Strict branch protection can mark the next queued PR `BEHIND` after each
merge while its existing head's checks remain green. A fresh `BEHIND` read now
uses this same visible local-merge refresh, with the same ownership, review,
base-source, reservation and publication guards. The runner issues no GitHub
update-branch request. A missing or unavailable delivery owner stops the lane
with the existing refresh-refusal reason and releases its repository slot.

A new reviewed successor starts a check clock for its own head. Its predecessor's
old green checks and clock supply no settlement evidence for that head. If the
base moves during refresh, the existing second-movement and same-base guards
still apply. Refresh admission checks the current delivery and completed review
both after forge awaits and under the reservation write lock.
