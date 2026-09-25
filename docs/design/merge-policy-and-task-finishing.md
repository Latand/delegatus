# Merge policy and task finishing (#2187, #2011)

## 0. Originating requirement

Operator report, 2026-09-25 03:30 Kyiv, spoken to the project orchestrator while
looking at a parked review card. The repository is public, so the operator's
words are quoted as issue #2187 paraphrases them in English:

> The operator could not tell what a parked review stage wanted from them. After the last allowed review round failed, the card showed "Skip review" and "Retry review", while they expected the builder to pick the findings up and fix them, as it does on every earlier round.
>
> 1. **Default after the last review round: the builder fixes, nothing parks.** A spent review budget hands the last findings to the fix stage once more and then completes (what `onExhausted: "advance"` does today). Stopping after the last fix, for someone who wants to look before merge, becomes an explicit choice when the pipeline is created, not the default. Where a pipeline does park, the two buttons say what they do in plain words: "Accept without review" (continue with the current code) and "Review again" (one more review of the same code, no fix in between), with one line on why it stopped.
> 2. **Merge policy as a setting, default off.** A per-project setting "merge automatically when the review passes" (default: no merge; the pipeline ends with an open PR). When on, a passing final review (or a spent budget whose last fix landed with green checks) merges the PR.
> 3. **Which pipeline closes the task.** A pipeline linked to a task can be marked as the one that finishes it. When that pipeline completes (merged, if auto-merge is on), its task moves to Done. Big tasks carry several pipelines and none of them closes the task by itself unless marked.

The operator's own sentences add two points the issue compresses: the stop
must come **after the last fix**, and with auto-merge on "the task closes as
closed". Related: #2011 (the spent-edge tooltip contradicts the default).

Mockups: `$HOME/Pictures/delegatus-review/merge-policy/` (eight PNGs, §7). No
raster lives under `docs/`.

## 1. What actually stopped the operator's lane

The screenshot the operator sent shows `Build → Review ②`, "Review failed ·
2 findings", a first finding that reads `round limit reached`, "previous
attempts · 4, latest: Review · attempt 1", and the buttons "Пропустити Review /
Повторити Review". Only the **legacy `review-loop` stage** produces that card:

- a `review-loop` stage delegates to an embedded flow created with
  `roundLimit: 5` (`src/lib/pipelines/engine.ts:3929`);
- the flow parks after the last round's REQUEST_CHANGES without relaying a
  fix: `relayFixOrPark` → `markNeedsDecision(flow, "round limit reached")`
  (`src/lib/flows/engine.ts:1057-1066`);
- the pipeline turns that into a `needs_decision` whose first "finding" is the
  flow's state detail (`src/lib/pipelines/engine.ts:4406-4411`), and the card
  offers skip/retry for any `needs_decision` (`src/components/pipelines/pipelineBlockModel.ts:173-181`),
  labelled `Skip {stage}` / `Retry {stage}` (`src/lib/i18n/en.ts:3556-3557`).

A read of this machine's pipeline store (read-only, 2026-09-25) shows how
common that path still is. Of the pipelines created since 2026-09-18,
**51 used `review-loop` stages** (43 of them in this repository), 13 used a run
reviewer with a fail edge under the default, and 4 in another project set
`onExhausted: "park"` explicitly. The record behind the screenshot is no longer
in the store, so the attribution rests on the card's text, which only the flow
path produces.

Three mechanisms stop a lane after its last review today, and each one needs a
different fix:

| # | Mechanism | Where | Stops before or after the last fix | Fix in this design |
|---|---|---|---|---|
| A | Legacy `review-loop` flow at its round limit | `flows/engine.ts:1061` | before (no last fix) | every new `review-loop` stage converts to run stages, at creation and on `add-stage` (§3.2) |
| B | `onExhausted: "park"` on a fail edge | `engine.ts:2455-2458` | before | stays, explicit only; plain labels (§3.4) |
| C | #1938: under the **default** `advance`, the last fix wrote a new head, so the lane stops in `needs_review` | `engine.ts:2221-2227`, `parkForReview` `:2266-2296` | after | becomes the explicit `stop-after-fix`; the default completes (§3.1) |

C matters as much as A. Since #1938, a lane that uses the default and whose last
fix changes code (almost every fix does) never completes. It waits on "Close the
pipeline / One more round". The issue text says "what `onExhausted: "advance"`
does today", which was true before #1938 and is not true now.

## 2. Prior decisions

Found with `search_transcripts` ("auto-merge", "Skip review Retry review",
"Per-feature screenshot catalog") and the issue tracker:

- **#1868** (operator decision, closed): a spent budget ends in one last fix and
  moves on, and never parks. It also says: "Nothing merges automatically;
  merging stays with the agent that owns the merge bar." #2187 changes that
  second sentence for projects that opt in.
- **#1938** (closed): a lane that completed on a spent budget looked identical to
  a clean APPROVE, and "a manager that merges on 'lane completed' would merge
  unreviewed code". The fix made the default stop in `needs_review`. #2187
  reverses that default and keeps the stop as an explicit choice. The honesty
  part of #1938 is still needed: a completed lane with an unreviewed last fix
  must say so on every surface (§3.5).
- **`docs/design/retire-flows.md`** §5 plans to refuse new `review-loop`
  definitions with `STAGE_KIND_RETIRED` at cutover, and the refusal isn't
  implemented yet (`grep STAGE_KIND_RETIRED src` is empty). Its explicit
  conversion, `convert-legacy-review`, exists
  (`src/lib/pipelines/legacyReviewDefinition.ts`, `engine.ts:7017`).
- **Orchestrator transcript, 2026-09-25 03:32 Kyiv**: the seat explained both
  buttons to the operator and filed #2187. The same seat merges finished lanes
  by hand: `gh pr merge --squash`, then `PUT …/pulls/N/update-branch` for the
  next PR, "one at a time, because GitHub requires each branch to be current
  with main". That sequence is what §4.4 automates.
- **A lane prompt on 2026-09-13**: "NEVER auto-merge unreviewed/red work".
  §4.3 keeps the "red" half absolutely. The "unreviewed" half is relaxed only
  where the operator relaxed it: a spent budget whose last fix landed.

Nothing earlier designed a per-project setting or a task-finishing link.

## 3. Part 1: after the last review, the builder fixes

### 3.1 Three exhaustion modes, one default

`PipelineFailEdgeExhaustion` (`src/lib/pipelines/types.ts:76,82`) gains one value:

| Value | When the last allowed review fails | After that fix passes | Who asks for it |
|---|---|---|---|
| `advance` (default, absent reads as this) | findings go to `onFail.to` once more | the lane follows the reviewer's pass edge, or **completes** when that is `null`, with `stateDetail` "budget spent" and the unreviewed findings in the next stage's input (`budgetSpentInput`, `engine.ts:2305`) | nobody |
| `stop-after-fix` (new) | same | the lane stops in `needs_review` (today's #1938 `parkForReview`) for the operator to look before merge | the creator, explicitly |
| `park` (kept) | the lane stops in `needs_decision` **before** the fix | — | the creator, explicitly |

Engine change: in `advancePipeline` (`engine.ts:2221`) the `parkForReview`
branch runs only when the source edge's exhaustion is `stop-after-fix`. Under
`advance` a fix that wrote a new head completes or moves on like a fix that
wrote nothing. `routeFailedAttempt` (`engine.ts:2413-2460`) treats
`stop-after-fix` like `advance` for counting and handoff (`advancesWhenSpent`).
The once-per-stage rule stays for all three modes (`failEdgeBudgetSpent`,
`failEdgeBudget.ts:60`): a stage that already handed its findings on and fails
again after another edge loops back through it parks. It is rare, and its card
gets its own reason line (§3.4).

`park` stays because four live lanes in another project use it and stored
records carry it. It isn't offered as a choice on the board (§3.3): nothing in
the requirement asks for a stop that skips the fix.

### 3.2 Legacy `review-loop`: convert every new one

The flow is being retired (retire-flows.md), so it gets no new round-limit
mode. A new `review-loop` stage can reach a plan in three ways: `create_pipeline`
(`engine.ts:6032`), a graph edit `add-stage` on a draft or a started lane
(`engine.ts:7269`, exposed as MCP `pipeline_action add-stage`), and the board's
**Add review** button, which sends `add-stage` with `kind: "review-loop"`
(`src/components/scheme/nodes.tsx:1577-1593,1616`). All three reach
`normalizeStages` (`engine.ts:5355`): creation directly, and `add-stage`
through `replaceDraftStages` (`:5626`) or `replaceStartedStages` (`:5762`).
The conversion goes there, once, so no path can skip it:

- `normalizeStages` takes each incoming stage of kind `review-loop` whose id
  is **not** in `preservedStages` (creation passes none, so every stage there
  counts) and runs it through the existing preview
  (`previewLegacyReviewConversion`, `legacyReviewDefinition.ts:175`) with that
  stage id named. When the preview is ok, the stored plan carries its result:
  the reviewer becomes a read-only run stage with `onFail: { to: <fixer>,
  maxRounds: 5, onExhausted: "advance" }` (`legacyReviewDefinition.ts:250`),
  and a fixer stage copied from the implementer is added after it. On
  `add-stage` the implementer is the predecessor whose pass edge the seam just
  pointed at the new stage, so it is known.
- When the preview refuses (no read-write implementer, `stage-count`
  overflow, an ambiguous implementer), the stage is stored as sent, and the
  answer, from creation or from `add-stage` alike, carries
  `legacyReview: { stageId, refusals }` with the preview's codes and
  messages. That is the clamp-over-reject rule agents rely on. Such a stage
  still stops at its round limit with no last fix, and its parked card says so
  (§3.4). Every refusal case is a plan where a fix stage can't be built without
  a guess.
- The answer lists the resulting stage ids (`convertedStages: { reviewer,
  fixer }`) so a creator that uses `set-edge` later addresses the right ones.
- Stages already in the plan (`preservedStages`) are never converted, so
  `reorder-stage`, `set-edge`, `remove-stage` and `override-stage` on a stored
  legacy lane leave its `review-loop` stage alone.
- **The board's Add review.** The button keeps its call. The engine's answer
  now carries two stages, and the canvas renders that answer in place of
  `optimisticAddStage`'s single node (`src/components/pipelines/pipelineModel.ts:1598`).
  The optimistic frame inserts the reviewer and the fixer together, so the
  canvas doesn't redraw twice. `canAddReview` requires two free stage slots
  (`MAX_PIPELINE_STAGES`), because the button now adds two stages.

This path handles new stages only. The retire-flows rule "No loading path
invokes the converter" still holds: stored and archived rows are untouched, and
a running legacy lane keeps its flow until it ends.

### 3.3 How a creator asks to stop after the last fix

- **MCP** `create_pipeline` and `pipeline_action set-edge`: `onFail.onExhausted:
  "advance" | "stop-after-fix" | "park"`. The zod enum at
  `src/lib/mcp/server.ts:3137` and its description at `:3138` change. The new
  description says: "advance (default): the fix stage takes the last findings
  and the lane continues or completes. stop-after-fix: after that fix the lane
  waits for the operator in needs_review. park: stop before the fix." The
  sentence at `server.ts:2960` changes to match. The `add-stage` description
  says that a `review-loop` stage is stored as a reviewer and a fix stage.
- **Orchestrator mandate** `src/lib/orchestrator/prompt.ts:339`: the same three
  sentences, plus "use stop-after-fix only when the operator asked to look
  before merge; review-loop stages are converted to a reviewer and a fix stage
  when you create or add them".
- **Board draft editor** `src/components/pipelines/StageEdgeControls.tsx:112-122`:
  the "When the rounds are spent" select shows two options, **Fix, then
  continue** (default) and **Fix, then wait for me** (uk **Виправити й
  продовжити** / **Виправити й чекати на мене**), each with a one-line hint in
  the open list. A stored `park` edge shows a third, disabled option, **Stop
  without fixing**, so the select never misreports a record. The field keeps a
  210 px minimum and wraps to its own row: beside the three other edge fields
  in the draft sheet, the uk label wrapped inside a 170 px select (mockup D3,
  first render).
- **Validators** `src/lib/pipelines/store.ts:342,484`, `engine.ts:5426-5429,7428`
  and `PIPELINE_FAIL_EDGE_EXHAUSTIONS` accept the new value. `stageDigest.ts:55-58`
  already joins `onExhausted` only when named, so digests of existing records do
  not move.

### 3.4 The parked card: plain buttons and one line on why

A card that stops on a review shows one **reason line**, the findings as today,
and two buttons. What counts as a review stage: a `review-loop` stage, or a
read-only run stage that owns a fail edge. Any other `needs_decision` keeps
today's `Skip {stage}` / `Retry {stage}`.

| Lane state | Reason line (en / uk) | Quiet button | Primary button |
|---|---|---|---|
| `needs_review` from `stop-after-fix` | "Stopped after the last fix, as this pipeline asked: the fix is not reviewed." / "Зупинено після останнього виправлення, як просив цей пайплайн: виправлення не перевірене." | **Accept as is** / **Прийняти як є** → new action `accept-head` | **Review again** / **Ще одне рев'ю** → `continue-review`, `addRounds: 1` |
| `needs_decision` on a review, edge `park` | "Stopped: the last of {n} review rounds failed, and this pipeline stops before fixing." / "Зупинено: останній із {n} раундів рев'ю провалено, і цей пайплайн зупиняється до виправлення." | **Accept without review** / **Прийняти без рев'ю** → `skip-stage` | **Review again** / **Ще одне рев'ю** → `retry-stage` |
| `needs_decision` on a review, once-per-stage rule | "Stopped: {stage} failed again after its last fix round." / "Зупинено: {stage} знову провалено після останнього раунду виправлень." | same | same |
| `needs_decision` on a legacy `review-loop` | "Stopped: the older review loop ends at its round limit without a last fix." / "Зупинено: старий цикл рев'ю закінчується на ліміті раундів без останнього виправлення." | same | same |

- `accept-head` is the one new pipeline action. It is admitted only in
  `needs_review` and only for the creator or the operator, with the same actor
  rule as `continue-review` (`engine.ts:6860`). It clears `reviewPending`,
  records who accepted, and advances along the review stage's pass edge exactly
  as `advance` would have. With auto-merge on, that completion is what merges.
  **Close** leaves the answer pair and stays in the lane's ⋯ menu, where it
  already is.
- "Accept without review" is `skip-stage`. On a read-only review stage the reset
  in `resetPipelineStage` has nothing to discard and the lane moves on
  (`engine.ts:7601-7635`).
- "Review again" on `needs_decision` is `retry-stage`. On the flow path it
  starts a fresh flow on the same head, which is what the label says.
- On the legacy path the flow's own state detail ("round limit reached") is
  stored as the first finding (`engine.ts:4406-4411`). The reason line now says
  it in words, so the card's findings list skips a first finding equal to the
  flow's `stateDetail`. The record is unchanged.
- The model change sits in `pipelineAnswers` and `pipelineReason`
  (`pipelineBlockModel.ts:173-240`) and the labels in `AnswerButtons`
  (`PipelineBlock.tsx:314-338`). Desktop and phone draw the same block, so one
  change covers both. The phone uses the same words; the uk strings fit the
  44 px buttons at 390 (mockup P1).
- The engine's own `stateDetail` strings that the seat reads
  (`reviewPendingDetail`, `engine.ts:2298-2301`; the park detail at `:2456`)
  keep their machine wording and gain the mode name.

### 3.5 A completed lane with an unreviewed last fix says so (#1938 kept)

Under the default, a lane can now complete with a head no reviewer saw.
Everything that shows a completed lane distinguishes that case:

- the record already carries it: the fix attempt's `activatedBy.budgetSpent`
  and the review attempt's `reviewedHead`. `pipelineReviewSummary`
  (`failEdgeBudget.ts:77`) gains a sibling `pipelineCompletedUnreviewed(pipeline)`
  that answers `{ reviewedHead, currentHead, findings }` for a completed lane;
- the card keeps its state word ("done", plus the merge word of §6) and adds
  one muted line under the chain: "Last fix not re-reviewed · {n} findings" /
  "Останнє виправлення не перевірене рев'ю · {n} зауваження". The note lives
  on its own line because in the lane's head the uk wording cut the lane title
  to a few words at 1440 (first render of mockup D1);
- the seat wake's `unmerged-pr` detail (`src/lib/monitor/seatTick.ts:1230-1236`)
  appends "last fix not re-reviewed" for such a lane.

### 3.6 #2011

`arcTitle` (`src/components/kanban/PipelineSection.tsx:207-220`) and the
block's `arcLines` (`PipelineBlock.tsx:668-680`) read the edge's exhaustion:

| Mode | Spent-edge sentence (en) |
|---|---|
| `advance` | "No rounds left · {from}'s next failure goes to {to} once more, then the lane moves on" |
| `stop-after-fix` | "No rounds left · {from}'s next failure goes to {to} once more, then the lane waits for you" |
| `park` | "No rounds left · another failure of {from} parks the pipeline" (today's `kanban.loopParked`, `en.ts:3301`) |

`LoopArc` already holds `loop.from`, which carries `onFail`, so no new input is
needed. The stale comment on `reviewerActivationsForLimit`
(`legacyReviewDefinition.ts:69-71`) and the engine comment at `engine.ts:2589`
are updated in the same slice.

## 4. Part 2: "Merge when the review passes", a project setting

### 4.1 Where it lives

- **Store**: a new file `state/project-settings.json`, module
  `src/lib/projects/settings.ts`, same shape as `curation.ts` (mtime-cached
  read, atomic write): `{ schemaVersion: 1, projects: { [project]: {
  mergeOnReview: { enabled, changedAt, changedBy } } } }`. It is keyed by the
  canonical project key and read through `canonicalProject`, so a folder whose
  key moved (the succession rule in AGENTS.md) keeps its setting. It is a new
  file because the existing per-project stores each own something else:
  `project-curation.json` holds crowns and manual projects,
  `seat-tick-settings.json` holds the monitor.
- **Default**: off, and an absent entry reads as off. No project is seeded.
- **Who writes**: the operator, from the board (`PUT /api/projects/settings`,
  new route beside `src/app/api/projects/`). Agents read it: `get_orchestrator`
  and `list_pipelines` rows gain `mergeOnReview: boolean`. An agent write path
  is deferred (§9).
- **When it is read**: at the moment a lane completes, and again before each
  merge attempt. Turning it on makes lanes that complete afterwards merge.
  Turning it off cancels any merge that is only waiting (on checks, or in the
  queue), and never interrupts a `gh pr merge` already running.

### 4.2 What "passes" means

A completed lane is **eligible** when all of these hold:

1. it has a pull request: `delivery.target.pr`, or the one PR the forge cache
   joins to the lane's head branch (`pipelineWorkLinks`,
   `src/lib/forge/resolve.ts:51`). No PR, several PRs, or a PR from a
   `comparison` delivery means not eligible;
2. every review stage that ran ended in one of:
   - its last attempt **passed** (the final review passed); or
   - its budget was **spent** and the fix that took the last findings passed and
     is the lane's `lastPassedCommit` (the last fix landed); or
   - the operator **accepted** it (`skip-stage` on it, or `accept-head`).
     `accept-head` arrives in S2, and S3 is built after S2 (§8), so the
     runner reads a record that already exists;
3. at least one review stage exists. A lane with no review (a design stage
   alone, a one-shot build) never merges on its own.

Then the PR must be green (§4.3). A lane in `needs_review` or `needs_decision`
has not completed, so it is never eligible.

### 4.3 Never red, and never before the checks have arrived

"Every reported check is green" is not enough on its own. Right after a push
(a lane that pushes at completion, or the runner's own `update-branch`),
GitHub has not registered the new head's workflows yet. The rollup is empty or
partial, and on a repository with no required checks `mergeStateStatus` already
reads `CLEAN`. The runner would then merge code that CI never ran on. This
repository's two strict required contexts only hide the gap here.

So the runner merges a head only when its checks are **settled and green**:

1. **Settled.** All of these hold:
   - the head has at least one check run or status context;
   - every **required** context of the base branch is present. They are read
     once per repository and base from `gh api repos/<r>/branches/<base>
     --jq .protection.required_status_checks.contexts`, which works with read
     access (checked 2026-09-25: `privacy-publication`,
     `privacy-tracker-audit`). An unprotected branch has none;
   - every check name the runner recorded on an **earlier head of this PR**
     (`merge.seenChecks`, a union of names, written at each read) is present.
     That covers the partial rollup right after `update-branch`: the update
     commit merges the base into the branch, the PR diff against the base is
     unchanged, and the same workflows run again;
   - at least **3 minutes** have passed since the runner first saw this head
     (`merge.headSeenAt`);
   - the set of names did not grow between the last two reads (60 s apart).
     A workflow that registers late shows up as growth and restarts the wait;
   - every check has finished (`status: COMPLETED`, or a status context not
     `PENDING`).
2. **Green.** No check concluded `FAILURE`, `CANCELLED`, `TIMED_OUT`,
   `ACTION_REQUIRED`, `STARTUP_FAILURE` or (status context) `ERROR`.
   `SUCCESS`, `NEUTRAL` and `SKIPPED` pass. A red check that branch protection
   does not require still blocks.

A head that still has **no check at all** once the 3 minutes have passed is
blocked: "no checks reported on this head". A repository without CI therefore
never merges automatically (§9). A main-wide red check stops merges until
someone fixes main, as the expired audit allowlist did on 2026-09-25 (#2188).
That stop shows in Needs you and is never silent.

Waiting is bounded. The runner polls every 60 s for at most 90 minutes from
the first read of a head, then blocks with "checks did not finish in 90 min".

### 4.4 How the merge runs

Through GitHub, with `gh`. A local `git merge` plus a push to the base branch is
refused by this repository's protection (`enforce_admins: true`, required
checks `privacy-publication` and `privacy-tracker-audit`, `strict: true`, as
read with `gh api repos/<repo>/branches/main/protection` on 2026-09-25), and it
would leave the PR open.

A new module `src/lib/forge/autoMerge.ts` holds the runner. It is scheduled
beside the forge sweep from the controller's `sweepForgeLinks` port
(`src/lib/pipelines/controller.ts:103`) and runs outside every pipeline lease,
the same way the sweep does (`sweep.ts:11-17`). It reuses the `GithubRunner`
from `src/lib/monitor/githubEvidence.ts:34`. It writes its result into the
pipeline under the pipeline lock and resolves the record again inside the
lock, so it never works on a stale read.

Per eligible lane, a small state machine stored on the pipeline as
`merge: PipelineMerge`:

```
queued → checking ─┬─ head in chain, CLEAN or HAS_HOOKS, checks settled + green ─→ merging → merged
                   ├─ checks not settled, UNKNOWN, mergeable null/UNKNOWN,
                   │  BLOCKED while a required check is pending ─→ waiting-checks (60 s, ≤ 90 min) → checking
                   ├─ BEHIND ─→ updating (update-branch) → waiting-checks
                   └─ DIRTY, a red check, BLOCKED with checks settled, head outside chain,
                      draft, closed, gh error ─→ blocked(reason)
```

1. **Read**: `gh pr view <n> --repo <owner/name> --json
   state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup`.
   `mergeStateStatus: UNKNOWN` or `mergeable: UNKNOWN`/null is routine right
   after a push or an update, while GitHub computes mergeability. It means
   "read again next poll", inside the same 90-minute bound, and never blocks
   by itself. `UNSTABLE` (a non-required check failed) is caught by the green
   rule. `BLOCKED` after the checks have settled green means protection wants
   something the runner cannot give (an approving review, a signed commit),
   and blocks with GitHub's reason.
2. **Head fence, as a chain.** The runner keeps `merge.chain`: the lane's
   `lastPassedCommit`, then each head its own updates produced, in order. The
   PR head must be **in** the chain. `update-branch` answers `202` with no sha,
   so after each update the runner reads the PR, and it adds a new head to the
   chain only when all of these hold: an update is outstanding (recorded
   `merge.updates[i].requestedAt`, no head recorded yet), the new head's
   parents (`gh api repos/<r>/commits/<sha> --jq '[.parents[].sha]'`) are two,
   the first is the chain's tip, and GitHub is its committer (`web-flow`). A
   web-UI file edit also carries `web-flow` but has one parent, so it fails
   the check. Then `merge.updates[i].head` is set. A second or third update
   extends the same chain, so the runner never blocks on its own commit. Any
   other head means someone pushed after the lane finished, and the lane is
   blocked with "the PR head changed after the lane finished".
3. **Behind base** (`BEHIND`, the "up to date" rule): `gh api -X PUT
   repos/<r>/pulls/<n>/update-branch -f expected_head_sha=<chain tip>`, then
   wait for checks on the new head (§4.3, from zero). That is at most three
   updates per lane; a fourth blocks with "main keeps moving". This is the call
   the seat already makes by hand. It works with the repository's "suggest
   updating" option off, and the repository has it off.
4. **Merge**: `gh pr merge <n> --repo <r> --squash --match-head-commit <head>`.
   `--match-head-commit` makes GitHub refuse the merge if the head moved between
   the read and the merge. The method is squash when the repository allows it
   (it does here), otherwise merge commit, otherwise rebase, read once per
   repository from `gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed`.
   The branch is kept, because worktree cleanup owns lane branches.
5. **One at a time per repository.** Each merge moves main and puts every other
   PR behind it, so the runner keeps a FIFO per repository (ordered by
   completion time) and only the head of the queue goes past `queued`. This is
   the order the seat enforces by hand today. A blocked lane leaves the queue.
6. **Merged elsewhere**: when the forge sweep or a read sees the PR `MERGED`,
   whoever merged it, the record becomes `merged` with `by: "outside"`.

Blocked reasons, each one plain sentence: conflict with the base branch
(`DIRTY`); a named red check; no checks reported on this head; checks did not
finish in 90 min; branch protection wants something else (GitHub's words); the
PR is a draft; the PR was closed; the PR head changed after the lane finished;
main keeps moving; GitHub CLI not signed in or unreachable; GitHub refused the
merge (with its message).

**Conflicts are never resolved by the runner.** A conflict needs code judgment,
so it goes to the operator and the seat. A lane that resolves conflicts
automatically is deferred (§9).

### 4.5 Who is attributed

- **On GitHub**: the account `gh` is signed in as on this machine performs the
  update and the merge. That is the only credential Delegatus has, and GitHub
  shows that account as the merger. The squash commit keeps GitHub's default
  title "PR title (#n)" and body (the branch's commit messages, which already
  carry the agents' `Co-Authored-By: …noreply…` trailers). The runner adds no
  trailer and posts no comment, so nothing new reaches the public repository.
- **In Delegatus**: `pipeline.merge` records `{ state, by: "auto-merge" |
  "outside", policyChangedAt, reviewedHead, chain, updates: [{ requestedAt,
  head }], seenChecks, headSeenAt, mergedHead, mergeCommit, method, prNumber,
  requestedAt, mergedAt, attempts, reason }`. The lifecycle journal gains a
  `pipeline_merged` event, and the card reads "merged by Delegatus".

### 4.6 A failed merge goes to Needs you

`LaneReasonKind` (`src/lib/attention/dismissalTypes.ts:22`) gains
`"lane-merge"`. `laneNeed` (`src/components/attention/needReason.ts:81-93`)
raises it for a completed lane whose `merge.state` is `blocked`, keyed
`pipeline:<id>:merge` so it doesn't collide with the lane's own key. The block
shows the reason in warning ink and two answers:

- **Try the merge again** / **Спробувати мердж ще раз** → new action
  `retry-merge`: sets `queued`, keeps the head chain, and counts attempts;
- **Leave the PR open** / **Залишити PR відкритим** → `dismiss`, as any lane
  need is cleared today; the record stays `blocked`.

The seat wake lists a blocked merge under `unmerged-pr` with its reason. A PR
whose lane is `queued`, `checking`, `waiting-checks`, `updating` or `merging` is
left out of `unmerged-pr`, because the runner owns it
(`seatTick.ts:1229-1236` and its source in `seatTickSources.ts`).

### 4.7 The orchestrator's own merges (decision D1)

The orchestrator mandate says "merge on APPROVE"
(`src/lib/orchestrator/prompt.ts:93,335`), and the seat merges finished lanes by
hand today. The requirement reads two ways here:

- **D1-A: the setting governs every automatic merge** (recommended). On, the
  runner merges, and the mandate tells the seat not to merge a lane the runner
  owns and to act on blocked merges. Off, the seat does not merge on its own
  either: it reports "PR ready" and merges when the operator asks. This fits "by
  default, no merge; I add automatic merge in settings" and gives one switch to
  read. The operator turns it on for this repository at rollout, or the current
  habit stops.
- **D1-B: the setting governs the engine only.** Off, the seat keeps merging on
  APPROVE as today. A new project's orchestrator then merges by default, which
  contradicts "default: no merge".

Only slice S4 depends on the answer. S1 to S3 are the same under both.

## 5. Part 3: a pipeline that finishes its task

### 5.1 The flag

Stored on the pipeline as `finishesTaskIds?: string[]`, a subset of `taskIds`
(`types.ts:705`). A flag per link is what the requirement names, and three of
the hundred stored pipelines link two tasks. `unlink-task` removes the id from
both lists.

- **At creation**: `create_pipeline` takes `finishesTask?: boolean | string[]`,
  next to `taskIds` (`server.ts:3349`). `true` means every linked task, a list
  means those ids, and an id outside `taskIds` is dropped with a note in the
  answer (clamp).
- **Later**: `pipeline_action link-task` takes `finishes?: boolean` and becomes
  an upsert. On a task already linked it sets or clears the flag
  (`engine.ts:7177`). The board toggle calls the same action.
- **Default**: off. A marked pipeline is the operator's or the orchestrator's
  statement; nothing infers it.

### 5.2 What "finished" means

A marked pipeline finishes its tasks when:

| Merge setting | Lane has a PR | Finishes when |
|---|---|---|
| off | any | the lane is `completed` (the PR stays open) |
| on | no | the lane is `completed` |
| on | yes | the lane is `completed` **and** `merge.state` is `merged` (by the runner or anyone) |

`needs_review`, `needs_decision`, `paused` and `closed` never finish a task. A
blocked merge leaves the task where it is until the PR merges.

### 5.3 How the task moves, and when it waits

A sweep beside the merge runner (same module, same schedule) reads settled
pipelines with `finishesTaskIds`. For each named task whose marked pipeline
has finished (§5.2), it counts the task's **other open pipelines**: every
other pipeline whose `taskIds` holds the task and whose state is
`provisioning`, `running`, `paused`, `needs_review` or `needs_decision`. A
`draft` doesn't count, because a plan nobody started asks nothing and would
otherwise hold a task forever. `completed` and `closed` don't count either.

- **None open:** the task moves to `done` through `patchTask`
  (`src/lib/tasks/commands.ts:421`), attributed to the actor `pipeline:<id>`.
  The pipeline records `taskFinishes: [{ taskId, at }]`, so each task finishes
  once: if the operator reopens it, the pipeline does not close it again. A
  task that is already `done` is only recorded.
- **Some open: the move waits.** Nothing moves, so a Done card never sits over
  a lane that is still working. The pipeline records `taskFinishWaits: [{
  taskId, since, open }]`, and every surface says so (§6): the task card says
  "Done waits for 1 more pipeline", and the marked lane's row says "finishes
  the task once 1 other pipeline ends". The next sweep after the last of them
  completes or is closed moves the task and clears the wait. A lane linked
  while the task waits counts too.

The wait raises **no Needs-you line of its own**. Nothing about it needs the
operator: a lane that is still running ends by itself, and one that stops
(`needs_review`, `needs_decision`) already raises its own need through
`laneNeed`. A `paused` lane holds the move until the operator resumes or
closes it, and the task card shows that wait with the count. The seat wake's
lane digest names it ("task waits for N open pipelines") so an orchestrator
that marked the wrong lane sees it.

The alternative was to move the task at once and note the open lanes. It was
rejected: a Done task with a working lane under it is the state that
confuses, and the requirement describes a big task as one several lanes work
on, which is still open while they do.

### 5.4 How orchestrators use it

The mandate (`prompt.ts`) gains one paragraph: "Set `finishesTask: true` when
this lane's PR delivers the whole task. For a task split into slices, mark only
the lane of the last slice, or mark none and move the task yourself. With the
merge setting on, a marked lane's task moves to Done when its PR merges;
with it off, when the lane completes. Either way it waits for every other
started lane on the task to end." Nothing is backfilled for pipelines already
in flight.

## 6. Part 4: board and phone

- **The setting row**: in the board's ⋯ menu, in the `project` group
  (`src/components/ProjectDashboard.tsx:2114`), above Archive. It is a switch
  row: **Merge when the review passes** / **Мерджити, коли рев'ю пройдено**,
  with one muted line under it. Off: "Pipelines end with an open PR." / "Пайплайни
  закінчуються відкритим PR." On: "Green checks only; a conflict waits for you." /
  "Лише із зеленими перевірками; конфлікт чекає на вас." The phone's ⋯ sheet
  (`src/components/mobile/MobileShell.tsx:322`) shows the same row. It is the
  one place the setting shows; the header gains nothing ("every fact once",
  `docs/design/board-header.md` §1.6).
- **The parked card**: §3.4. The reason line sits between the chain row and the
  findings, in warning ink. The buttons keep today's geometry.
- **A completed lane's merge**: the state word after "done" reads "merged" /
  "змерджено" (success ink), "waiting for checks · 12 min" / "чекає перевірок ·
  12 хв" with the muted line "Merges when every check is green." / "Змерджиться,
  коли всі перевірки стануть зеленими.", "updating from main" / "оновлюється з
  main", or "merge stopped" / "мердж зупинено" (warning ink, with the reason
  line and the two answers of §4.6). A merged lane's foot names who merged:
  "Delegatus merged it" / "Delegatus змерджив". The PR chip already on the row
  (`pb-links`) shows the PR state.
- **The flag on the pipeline row**: a `flag` icon and "finishes the task" /
  "завершує задачу" at the end of the chain row, before the PR chip, in muted
  ink. After it has done so: "finished the task" / "завершив задачу" in success
  ink. It stays out of the lane's head: there it cut the lane title to "Slice 3:
  merge runner and N…" at 1440 (mockup D2, first render). The row's ⋯ menu gains
  a check row **Finishes the task** / **Завершує задачу** with the hint "When the
  pipeline completes and its PR merges, the task moves to Done." The draft editor
  gains the same checkbox under the stage list, with a muted line naming the
  project's merge setting and where it changes.
- **A finished lane whose task waits** (§5.3, mockups D4 and P4): the flag line
  on the lane's row reads "finishes the task once {n} other pipeline(s) end" /
  "завершить задачу, коли закінчиться ще {n} пайплайн(и/ів)" in muted ink,
  below the chain on its own line. The task card shows one muted line with
  the flag icon under its description: "Done waits for {n} more pipeline(s)" /
  "«Готово» чекає ще {n} пайплайн(и/ів)". On the phone the task screen shows
  the same line under the title. Plurals go through the i18n plural rule.
- **The menu hint names the count** whenever the task has other open
  pipelines, checked or not: a second line in warning ink, "{n} other
  pipeline(s) on this task are open; Done waits for them." / "На задачі
  відкритий ще {n} пайплайн; «Готово» дочекається його." (uk plural forms
  follow `n`).
- **A repository without GitHub**: the setting row's hint reads "Needs a GitHub
  pull request; pipelines here end without a merge." and the switch is disabled.

## 7. Mockups

Rendered from static HTML with the product's tokens
(`src/styles/tokens.css`), in Ukrainian because that is the operator's board
language and the longer strings; en strings are in the tables above. Light theme
at desktop, dark at the phone, matching the operator's screenshots.

| File | Viewport | Shows |
|---|---|---|
| `desktop-1440-cards.png` (D1) | 1440 × 900 | Assigned column: a `stop-after-fix` lane with its reason and **Прийняти як є / Ще одне рев'ю**; a legacy `review-loop` lane parked with **Прийняти без рев'ю / Ще одне рев'ю**; a completed lane whose merge stopped on a red check, with **Залишити PR відкритим / Спробувати мердж ще раз**. Done column: a task a marked lane finished, merged by Delegatus; a second finished task whose last fix was not re-reviewed (§3.5 line) |
| `desktop-1440-menu.png` (D2) | 1440 × 900 | the board header with ⋯ open and the setting row on; the same row off, set apart; a task with two lanes, the running one marked "завершує задачу", and that lane's ⋯ with **Завершує задачу** checked |
| `desktop-1440-draft.png` (D3) | 1440 × 900 | the draft sheet: the fail edge's "Коли раунди вичерпано" select open on its two options, the finishes-the-task checkbox and the project's merge setting line |
| `phone-390-parked.png` (P1) | 390 × 844 @3× | task screen: the `stop-after-fix` lane with its 44 px answers, and a completed lane waiting for checks |
| `phone-390-settings.png` (P2) | 390 × 844 @3× | the ⋯ sheet with the setting row on |
| `phone-390-finished.png` (P3) | 390 × 844 @3× | a Done task: its marked lane merged and "завершив задачу", and a second lane's ⋯ sheet with the unchecked toggle |
| `desktop-1440-hold.png` (D4) | 1440 × 900 | §5.3's wait: an Assigned task whose marked lane merged while a second lane still runs, with "«Готово» чекає ще 1 пайплайн" on the card, "завершить задачу, коли закінчиться ще 1 пайплайн" on the lane row, and that lane's ⋯ menu with the count hint in warning ink; beside it, a Done task its marked lane finished |
| `phone-390-hold.png` (P4) | 390 × 844 @3× | the same wait on the phone's task screen, with the lane's ⋯ sheet and its count hint |

Checked by eye at their rendered sizes. The first renders had four defects,
all fixed in the design above: the unreviewed note in D1's lane head, the flag
in D2's lane head, the wrapped select in D3, and D4's menu covering the Done
column's card (moved below the lane's ⋯). In the final frames no button
clips its label, no text overlaps, and the uk strings fit the 44 px phone
buttons. The HTML sources sit beside the PNGs in `src/`, and they are mockups
only. The product's evidence for S2, S3 and S4 comes from the two existing browser
drivers.

## 8. Build slices

Each slice gates on `bunx tsc --noEmit` (logged to a file, exit code checked),
the touched test files by path under the pinned Bun, and the privacy gate. The
suites that sweep runtime directories are not run against live state
(AGENTS.md).

| Slice | What | Files it owns | Acceptance |
|---|---|---|---|
| **S1 · Fix after the last review** | §3.1, §3.2 (engine), §3.3 (MCP, validators, prompt), §3.5 record helper, §3.6 | `src/lib/pipelines/{types,engine,store,failEdgeBudget,legacyReviewDefinition,stageDigest}.ts`, `src/lib/mcp/server.ts` (onExhausted schema, `add-stage` description), `src/lib/orchestrator/prompt.ts` (line 339 paragraph), `src/lib/monitor/seatTick.ts` (unreviewed note), their tests | The production controller drives N failed reviews under the default: the fixer runs N+1 times and the lane **completes** with the unreviewed findings recorded, including when the last fix writes a new head. `stop-after-fix` stops in `needs_review` as #1938 does. `park` parks as today. A `review-loop` stage sent **by `create_pipeline`, by `add-stage` on a draft, and by `add-stage` on a started lane** is stored as a read-only reviewer, a fixer and an `advance` fail edge; a draft built by `add-stage`, started, and failed on every round completes after a last fix. A refused preview stores the stage unchanged and the answer carries `legacyReview.refusals`. `reorder-stage` on a stored legacy lane doesn't convert. Digests of stored records are unchanged |
| **S2 · Parked card words** | §3.2 board Add review, §3.3 board select, §3.4, §3.5 card word, §3.6 arc sentences, `accept-head` action | `src/components/pipelines/{pipelineBlockModel.ts,PipelineBlock.tsx,StageEdgeControls.tsx,pipelineModel.ts}`, `src/components/scheme/nodes.tsx` (`canAddReview`, two-stage insert), `src/components/kanban/{PipelineSection.tsx,stagesModel.ts,usePipelineActions.ts}`, `src/lib/pipelines/engine.ts` (`accept-head` only), `src/app/api/pipelines/[id]/route.ts`, `src/lib/i18n/{en,uk}.ts`, a `describe` block in `kanbanBoard.browser.test.tsx` and in `issue1671Evidence.browser.test.tsx` | Each row of §3.4's table renders its reason and labels at 1440 and 390, en and uk, with no clipped button or overlap (rendered evidence through the two existing drivers). `accept-head` completes the lane along the pass edge and is refused outside `needs_review`. The board's Add review shows a reviewer and a fixer, and is disabled with fewer than two free slots |
| **S3 · Merge setting and runner** | §4.1–§4.6, §6 setting row and merge words | `src/lib/projects/settings.ts` (new), `src/app/api/projects/settings/route.ts` (new), `src/lib/forge/autoMerge.ts` (new), `src/lib/pipelines/{types,store,controller}.ts` (`merge` record, schedule), `src/lib/pipelines/engine.ts` (`retry-merge` action only), `src/app/api/pipelines/[id]/route.ts` (`retry-merge` only), `src/components/kanban/usePipelineActions.ts` (`retry-merge` only), `src/components/pipelines/{pipelineBlockModel.ts,PipelineBlock.tsx}` (merge state words, merge answers, "Delegatus merged it" only), `src/lib/attention/dismissalTypes.ts`, `src/components/attention/needReason.ts`, `src/lib/monitor/{seatTick,seatTickSources}.ts` (exclusion, blocked reason), `src/components/ProjectDashboard.tsx` (row), `src/components/mobile/MobileShell.tsx` (row), `src/lib/mcp/server.ts` (`mergeOnReview` read fields, `retry-merge` in `pipeline_action`), i18n, a `describe` block in each of the two browser drivers | A fake `GithubRunner` drives every path of §4.3–§4.4: CLEAN with settled green checks merges with `--match-head-commit`; BEHIND updates, then merges; **an empty rollup with CLEAN does not merge** and blocks after 3 min with "no checks reported"; **a partial rollup right after `update-branch`** (fewer names than the previous head) does not merge; a rollup missing a required context waits; a set that grows between reads restarts the wait; `UNKNOWN` and a null `mergeable` wait and never block; two updates in a row keep the head in the chain; a one-parent `web-flow` head blocks; pending checks time out at 90 min; a red non-required check blocks; DIRTY blocks; two lanes in one repository merge in order. Off, nothing calls `gh pr merge`. A blocked merge raises `lane-merge`, and `retry-merge` requeues it. Rendered evidence at 1440 and 390, en and uk: the setting row on and off, and a completed lane in each merge state (waiting for checks, updating from main, merge stopped with its answers, merged by Delegatus). **Before this slice merges**, one live run on a scratch repository proves the real `gh` shapes: `update-branch` with `expected_head_sha` and the parents of its commit, `pr merge --match-head-commit`, `statusCheckRollup` conclusions, and the rollup right after a push |
| **S4 · Finishing and the orchestrator** | §5, §6 flag and wait words, and §4.7 per D1 | `src/lib/pipelines/{types,store,engine}.ts` (`finishesTaskIds`, `taskFinishes`, `taskFinishWaits`, `link-task` upsert), `src/lib/forge/autoMerge.ts` (finish sweep), `src/lib/mcp/server.ts` (`finishesTask`), `src/lib/orchestrator/prompt.ts`, `src/lib/monitor/seatTick.ts` (wait note), `src/components/pipelines/PipelineBlock.tsx` (flag line only), `src/components/kanban/KanbanCard.tsx` and `src/components/mobile/MobileTaskScreen.tsx` (wait line), the lane ⋯ menu and draft editor components, i18n, a `describe` block in each of the two browser drivers | Each row of §5.2's table moves the task once, attributed to the pipeline; a reopened task stays open; an unmarked lane never moves its task; unlinking clears the flag. **Two lanes linked to one task, the marked one completing while the other runs: the task stays where it is, `taskFinishWaits` records one open lane, and when the other lane completes (and, separately, when it is closed) the next sweep moves the task.** A draft linked to the task doesn't hold it. Rendered evidence at 1440 and 390: the flag, "finished the task", the wait line on the card and the lane row, and the menu hint with its count, matching D4 and P4 |

The slices run in order, S1 → S2 → S3 → S4, one merging before the next
starts. S2 needs S1's engine; S3 edits the same components as S2 and reads the
`accept-head` record S2 adds; S4 edits the same row and the sweep S3 adds.

## 9. Deferred — not currently justified

- **An agent write path for the merge setting.** The operator asked for "a
  setting" that they turn on. Agents read it (§4.1). Reconsider if an
  orchestrator needs to pause merges during an incident.
- **A per-pipeline merge override** ("never merge this one"). `stop-after-fix`
  and `accept-head` already give the operator a look before merge where they
  asked for one, and a lane with no review stage never merges.
- **A "Fix these findings" button on a parked card.** With the default changed,
  the lanes that still park are the ones whose creator chose it, and the issue
  names only the two buttons.
- **Automatic conflict resolution** (a successor lane that merges main and
  pushes). Conflicts are rare and need judgment; they surface to Needs you.
- **A local `git merge` for repositories without GitHub.** The workflow
  engine's `finishMerge` (`src/lib/workflows/provision.ts:191`) is the precedent.
  Every repository in use here has a GitHub remote. Without one, the lane ends
  as if the setting were off, and the setting row says "needs a GitHub pull
  request".
- **Automatic merge in a repository without CI.** "Never merging red" can't
  be checked on a head that reports no checks, so such a head blocks with "no
  checks reported on this head" (§4.3). Reconsider when a project without CI
  asks for the setting; the answer then is an explicit per-project "no checks
  expected" flag, never an empty rollup read as green.
- **A Needs-you line for a task whose Done move waits.** The open lanes raise
  their own needs when they stop (§5.3).
- **Converting running legacy `review-loop` lanes.** The explicit
  `convert-legacy-review` action exists; running lanes finish on the flow.
- **A PR comment announcing the automatic merge.** GitHub's merge event and the
  Delegatus record already name it, and every comment is a public artifact.

## 10. Check against the requirement

| Requirement | Where it is met |
|---|---|
| after the last review the builder fixes, nothing parks | §3.1 default `advance` completes (C fixed); §3.2 every new `review-loop` stage converts, whether created or added (A fixed) |
| stopping after the last fix is an explicit creation choice | §3.3 `stop-after-fix`, in MCP, the prompt and the draft editor |
| plain buttons, one line on why | §3.4 table, desktop and phone |
| per-project setting, default off, open PR otherwise | §4.1 |
| passing final review, or spent budget with the last fix landed and green checks | §4.2; §4.3 counts checks as green only once they have arrived and settled |
| merge runs and closes the task | §4.4, §5.2 |
| a pipeline marked as finishing its task; big tasks unmarked | §5; a marked lane's task waits for the task's other open lanes (§5.3) |
| mockups before build | §7; the operator reviews them before S2–S4 |

One decision is the operator's, at the mockup review: **D1** (§4.7), whether
the setting also governs the orchestrator's own merges. The recommendation is
D1-A.
