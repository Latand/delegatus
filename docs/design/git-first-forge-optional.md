# Pipelines, merges and wakes run on Git alone; GitHub is an optional adapter

Design, 2026-10-25. Read-only; every `file:line` below is on main at
`b027e190d` (the head of main at the time of writing, verified with
`git fetch origin main` at 19:58Z). No code changes are proposed here; the
slices in §6 are the build plan.

## 0. Originating requirement

Operator, 2026-10-25 19:36Z, in the project orchestrator's chat (voice, Russian,
transcribed, verbatim):

> «Вообще. У нас, по идее, вообще не должно быть зависимости от GitHub. У нас,
> по идее, у нас, по идее, все работают. Работают с Git. И нам... я не понимаю,
> зачем мы делаем зависимость от pull request. От ещё чего-то. Пайплайны от
> этого не должны зависеть. Максимум — они должны работать с Git. Мержи все
> через Git, всё через Git. А если мы работаем с GitHub, доступный, то мы тогда
> уже создаём вот эти все pull requests и так далее. Не для каждого проекта у
> нас GitHub. GitHub.»

In English: nothing should depend on GitHub; everything works with Git; the
dependency on pull requests is unexplained; pipelines must work with Git at
most; every merge goes through Git; where GitHub is available, the pull
requests and the rest are created on top; not every project has GitHub.

The seat recorded the same decision as a project rule the same evening
(`r_381f2bc450428e56`, delivered to every role here): pipelines, merges, task
completion and seat wakes work on Git alone, GitHub is an optional layer, and
no lane, merge or wake waits on a GitHub read. This document is the design
behind that rule.

The pinned specification asks for five parts: (1) an evidence map of every
GitHub dependency, (2) the Git-only path for each, (3) GitHub as an adapter on
top, (4) migration slices, (5) operator questions. They are §1 and §2, §4, §5,
§6 and §7 below. §3 states the principle the rest follows.

## Status

Needs the operator's answers to §7 before the first landing slice (S4) is
built. S1 to S3 do not depend on those answers and can start now. The default
answer to "should we build this" is yes here: the requirement demands it, and
§2 shows that on 2026-10-25 every one of the three GitHub-bound mechanisms
stopped work that Git alone could have finished.

## Summary

- **Today GitHub is load-bearing in six places**: every passed stage must find
  or open a pull request or the lane parks; the merge queue reads and writes
  only GitHub; a task finishes only when GitHub says the PR merged; the seat
  tick runs `gh pr list` inside the alarm's consistency window; release
  readiness and unattended updates read GitHub check runs; bug reports go out
  as the GitHub App. A project whose remote is any other Git host parks at its
  first passed stage. A project with no remote runs only with
  `publication: "internal"` and then never merges or finishes a task.
- **On 2026-10-25** this cost: 1,154 of 2,087 seat-tick checks across every
  project on this machine cancelled on "pull-request evidence changed", with no
  wake delivered to this project between 17:49Z and the end of the day; 13 hot
  lanes blocked in the merge queue, 4 on «the PR head changed after the lane
  finished» and 9 on named red hosted checks (one of them green again after a
  rerun, 4 h later); three refusals of an approved bug report by the GitHub
  App check. Each is traced to its line in §2.
- **The Git-only path** keeps the parts that are already Git: the lane branch,
  the exact-head publication, the reviewed-head fence, `merge-tree`
  conflict detection, the local pre-push gate, ancestry. The landing becomes a
  Git merge commit of the reviewed head into the base, gated by the local
  checks, pushed to the project's Git remote or applied to the local base. A
  lane is finished when its reviewed head is an ancestor of the base. The seat
  wakes from Git ancestry and Delegatus's own records, with zero subprocesses
  to GitHub on the alarm path.
- **GitHub becomes an adapter**: a pull request mirrors the lane, hosted checks
  and reviews are read into the record as signals, an issue is filed where the
  repository has one. The adapter adds; it never gates the Git path, with one
  exception the operator can switch on per project: hosted checks as a landing
  gate. On this public repository, branch protection (four required contexts,
  `enforce_admins: true`) makes GitHub the only write channel to main, so the
  landing executor pushes through the pull request there, after the local
  gate, and hosted privacy-publication keeps its enforcement.
- **Seven slices**, the first three independent of the open questions.

## 1. Where GitHub is load-bearing today

Legend for the two failure columns: **no GitHub** means a project whose
delivery remote is a plain Git host or no remote at all (`githubRepositoryOfRemote`
answers null, `src/lib/forge/workLinks.ts:135-140`); **GitHub down or slow**
means `gh` fails, times out or answers UNKNOWN. "Parks" means the lane stops in
`needs_decision` and waits for a person.

### 1.1 Stage publication: every passed stage must find or open a pull request

| Where | What it does | No GitHub | GitHub down or slow |
|---|---|---|---|
| `src/lib/pipelines/stagePullRequest.ts:76-83` `ensureStagePullRequest` | For an owner lane with `publish: "enabled"`, resolves the GitHub repository from the delivery remote; `null` answers `{ ok: false, error: "the delivery remote has no supported pull request service" }` (`:83`). | **Parks at the first passed stage.** The refusal has no `privacy` part, so `handlePullRequestRefusal` parks (`src/lib/pipelines/engine.ts:4671-4676`). | n/a |
| `stagePullRequest.ts:95-100` `readOnce` | `gh pr view` or `gh pr list --head <branch>`; a non-zero exit is `"the delivery pull request lookup failed"`. | n/a | **Parks** through the same path; the only retry is the 30 s head-retry for the lane's own just-published head (`:69-70`, `:121-137`). |
| `stagePullRequest.ts:183-187` | `gh pr create` or `gh api PATCH pulls/N` as the engine's forge identity; the body is the producer's report. | n/a | Parks: "the delivery pull request could not be opened" / "...could not be verified" (`:202-205`). |
| `engine.ts:4793-4794`, `:5573-5574`, `:4716-4722`, `:5528-5534` | The four call sites: every pass of a publishing stage, terminal-output and text-repair retries. | as above | as above |
| `engine.ts:4774-4777`, `:5564-5567`, `:11567` and `src/lib/pipelines/git.ts:2183` | A repository with no `origin` publishes `remote: "unavailable"`, and the stage parks with `MISSING_DELIVERY_REMOTE` (`src/lib/pipelines/publication.ts:10`) unless the lane was created with `publication: "internal"` (`src/lib/pipelines/types.ts:235`; `pipelinePublishesRemoteBranch`, `publication.ts:5-8`). Review ingress skips publication for internal lanes (`engine.ts:9102-9103`) and parks otherwise (`:9115-9120`). | **Only `internal` lanes run** in a project without any remote. The default (`publication` omitted) parks. | n/a |
| `src/lib/pipelines/stageProvenance.ts:50-70`, `:125` | After every stage report, `gh pr list --head` (10 s) for the provenance record. | `pullRequestState: "unknown"`; non-blocking. | Same; non-blocking. The observed PR seeds the forge cache (`:143-147`). |
| `src/lib/pipelines/stageAttemptPush.ts:30-123` `publishedIntegrationGreen` | Excuses a missing creation receipt only when GitHub shows the exact head's PR open, non-draft, with every check and every required context green (`gh pr view`, `gh api graphql`, `gh api repos/…/branches/<base>`). | Returns false: the push is refused as before, no excuse. | `StageIntegrationChecksPending` → the stage **waits** on GitHub ("the published integration is waiting for green checks", `:120-122`). |
| `src/lib/pipelines/stageBranch.ts:114-116` | `gh api repos/…/branches/<branch> --jq .protected` for a stage that adopted a foreign branch. | Local or non-GitHub remotes: observation without error (`:103-109`). | "the stage branch's forge protection cannot be verified" (`:115`). |
| `src/lib/workflows/provision.ts:230-249` `finishPr` | Legacy flows: `git push` then `gh pr create`. `finishMerge` (`:253-301`) is the legacy **local merge into the base**, the one Git-only landing in the codebase. | Flows with `finish: "pr"` fail. | Fails with `gh pr create`'s stderr. Flows are being retired (`docs/design/retire-flows.md`). |

Numbers (read-only copy of the state store, `VACUUM INTO` a scratch file at
about 19:57Z): 362 hot lanes, every one with a GitHub delivery remote; 1,611
archived lanes, 1,608 GitHub, 3 with no remote at all. Publication modes over
all 1,973: `omitted` 1,244, `remote-branch` 622, `internal` 107. Of the 10
projects with an orchestrator seat, 2 are plain directories (`dir-…` keys) and
8 are repositories.

### 1.2 The merge queue and auto-merge (`src/lib/forge/autoMerge.ts`)

| Where | What it does | No GitHub | GitHub down or slow |
|---|---|---|---|
| `:717-740` `mergeAdmission` | A completed, review-eligible lane (`mergeEligible`, `:115-152`, record-only) is admitted only with a `pipelineRepository` (GitHub `owner/name` from the delivery remote or the recorded project remote, `src/lib/forge/resolve.ts:25-31`). | **Never admitted**: `"lane has no resolved repository"` (`:735`), logged once, never shown on the card. No PR → admitted and blocked at once with `noPr` (`:737`, `mergeReasons.ts:11`). | n/a |
| `:474-515` `stepLane` | Per read: `gh pr view --json <PR_FIELDS>` (`:495`), `gh api …/pulls/N/reviews` (`:509`), branch protection contexts (`:232-247`), repository merge method (`:220-230`), batch-landing receipts from issue comments (`:498-500`, `batchLanding.ts:57-86`). | n/a | Three failed reads → **blocked** `unreachable` (`:570-571`, `MERGE_READ_FAILURE_LIMIT` `:50`); 90 min → `checksTimeout` (`:48`). |
| `:370-423` `decideMerge` | Decides from GitHub's words: `headRefOid` ≠ chain tip → **`headChanged`** (`:376`); `DIRTY`/`CONFLICTING` → conflict (`:386`); any red check → blocked `check "<name>" failed` (`:388-389`); no checks after 3 min → `noChecks` (`:407`); `BEHIND` → refresh lane (`:395-398`); `BLOCKED` → protection (`:416-419`); `UNKNOWN` → wait (`:420-423`). | n/a | Every `UNKNOWN`/null read waits, up to 90 min; stale check results on the head stay red until someone reruns them (§2.2). |
| `:644-647` | The merge itself: `gh pr merge --<method> --match-head-commit` as the Delegatus GitHub App (`src/lib/forge/appWrite.ts:111-131`, `forgeWriter` `:137-147`). | n/a | `GitHub refused the merge: <words>` → blocked. A missing App credential refuses the write and nothing falls back (`appWrite.ts:79-104`). |
| `:1219-1226` production ports | `githubRunner(os.tmpdir(), 30 s)` and `forgeWriter(run, forgeAppWriter(…))`. | | |
| `src/lib/forge/autoRefresh.ts:14-30`, `:54-77` | A conflict or `BEHIND` starts a refresh lane whose brief says "merge current origin/<base>" and "never call GitHub update-branch". | The detection never fires (no `stepLane`). The refresh lane itself is Git-only. | |
| `scripts/merge-batch.ts:455-471`, `:1134-1141` | The seat's batch merger lands through `gh pr merge --rebase --match-head-commit` and refuses without a verified App installation principal. Its `build` and `gate` steps are local Git and local checks (`docs/merge-batch.md`). | `land` impossible. | `land` fails "Forge rebase merge requires a verified machine principal". |

Scheduling: both the forge sweep and the merge runner are fire-and-forget from
the pipeline controller cycle (`src/lib/pipelines/controller.ts:8-9`,
`:64-67`, `:282-286`), outside pipeline leases; the `gh` calls hold no lock.
That part is already right and stays.

### 1.3 Task completion (`finishesTask`, #2187 §5)

| Where | What it does | No GitHub | GitHub down or slow |
|---|---|---|---|
| `autoMerge.ts:1123-1132` `laneFinishedForTasks` | With the merge setting on, a marked lane finishes its task only when `merge.state === "merged"` or the forge cache says the PR is merged (`ports.cachedState`, `:1243`, from `forge-links.json`). Lanes that need no PR (no commits, read-only outputs, published prototype) finish without one (`:1085-1101`). | **The task never moves to Done** with the setting on: no PR, implementation lane → `laneNeedsNoPr` false → `false`. With the setting off it finishes on completion (`:1125`). | Stays unfinished until the sweep reads GitHub again (`src/lib/forge/sweep.ts:20-27`, 3 min live / 30 min idle, retry 3 min). |
| `src/lib/pipelines/store.ts:2165-2170` | A completed lane with an unfinished mark never archives. | Hot store grows by one lane per such task. | |
| `src/lib/done/candidates.ts:85-100`, `:208-212` | The Done section's "landed" candidates come from PRs the forge cache saw merged, including batch landings parsed from PR titles. | No Done candidates from lanes. | Stale until the next sweep. |
| `src/lib/done/recover.ts:85`, `:115-118` | Cold frame recovery reads the PR body and the Git tree through `gh`. | Falls through to local refs (`:98-113`). | Same. |

### 1.4 The seat tick (`src/lib/monitor/seatTickSources.ts`, `seatTickController.ts`, `seatTick.ts`)

| Where | What it does | No GitHub | GitHub down or slow |
|---|---|---|---|
| `seatTickSources.ts:1817-1961` `unmergedPullRequests` | On every due check with a seat: `gh pr list --state open --limit 60` in the project's repository (`:1907`; `src/lib/monitor/githubEvidence.ts:232-247`, 20 s), joined to finished lanes by head branch, to raise `unmerged-pr` (`seatTick.ts:1385-1398`). | `gh` in a non-GitHub checkout fails → `command-failed` gap, replayed at the wake interval (`:1899-1901`). The reason never fires. | Same gap; the fingerprint carries `FINGERPRINT_UNREAD` (`:1627-1667`). |
| `seatTickSources.ts:2938-2971` `pullRequestEvidenceKey` and `:2975-2993` `refreshSeatTickEvidence` | Hashes **every lane of the project** (`:2951-2956`) before and after the PR read; any lane change, alias change, seat change or settings change in between throws `SeatTickEvidenceRefreshCanceledError` (`:2896-2901`). | **Runs for every project**, GitHub or not: the key is computed before the `gh` gate, so plain-directory projects pay it too (§2.1 shows cancellations on `dir-…` rings). | The longer the `gh` read, the wider the window a lane change can fall into. |
| `seatTickController.ts:1344-1350`, `:1391-1415` | One in-process retry, then the check is journaled `verdict: "error"` with the cancel text and nothing is delivered; `refreshWake` (`:1818-1825`) and the main check (`:1870-1883`) both refresh evidence before composing the wake. | | A check that always cancels delivers no wake: the livelock of §2.1. |
| `seatTickController.ts:1822-1823`, `:1877-1878`; `githubEvidence.ts:249-336` | Open issues as proposal material (`gh api graphql`) when the verdict needs work sources. | Degraded run, says so; non-blocking by design (`githubEvidence.ts:7-16`). | Same. |

### 1.5 Release readiness and the release lane (`src/lib/release/`)

| Where | What it does | No GitHub | GitHub down or slow |
|---|---|---|---|
| `production.ts:130-146` `requiredReleaseChecks`, `:104-108`, `:111-128` | Reads main's branch protection contexts and the check runs of main and the cut through `gh api`; a PR-only `runtime-gate` is read off the merged PR's head. | `gh repo view` (`:174`) throws; the controller's `observe` fails and every tick logs the error. | `checks: "pending"` or a thrown read → blocker 5 `checks-red`/`checks-pending` (`policy.ts:48`). |
| `policy.ts:44-46` | Blocker 3 `merge-off`: releases need the GitHub merge setting on. | Releases impossible in a project that cannot have the setting (§1.7). | |
| `stages.ts:8` publish brief | The deployer re-reads "main/cut required checks" before any tag push. | | A pending hosted check holds the tag. |
| `production.ts:21-30`, `:53-80`, `:150-170` | Tags, ancestry, change list, the six-hour production cut: **all Git and the deployment ledger** already. | works | works |

### 1.6 Deploy and unattended updates

| Where | What it does | No GitHub | GitHub down or slow |
|---|---|---|---|
| `scripts/rebuild.sh`, `src/lib/runtime/deploymentLedger.ts`, `src/runtime-host/deployment.ts` | The deploy of this installation reads a Git revision and the host control key; no `gh` anywhere (grep over those files is empty). | works | works |
| `src/lib/selfUpdate/green.ts:1-125` `GreenReader` | Unattended checkout updates require the target revision's check runs green at `api.github.com`, with branch protection's required checks (`:75`). | `availability: "not-github"` (`service.ts:420`); an operator-chosen revision on a checkout install is admitted without a green read (`service.ts:1572-1573`), a launcher upgrade skips the read (`:1682`). | `GitHubReadError` with the rate-limit reset time; the update waits. |
| `src/lib/orchestrator/prompt.ts:465` | Deploy mandate: "merges landed on origin/main, gates green. Never deploy red." | | |

### 1.7 Issues and the GitHub App

| Where | What it does | No GitHub | GitHub down or slow |
|---|---|---|---|
| `src/lib/issueReports/publish.ts:30-50` | The one issue Delegatus files itself (the operator-approved bug report) goes out as the App on an `issues: write` token in a declared repository, or as plain `gh issue create` elsewhere. The repository is always the one Delegatus is developed in (`:23-25`), so this is an adapter to **this** project's forge, whatever project the seat serves. | n/a | Refused by the installation check (`bin/forge-app-token.mjs:158`, `:178-180`): "the GitHub App installation is missing, suspended, or differs from the verified one". Nothing is filed; the seat tells the operator (§2.3). |
| `src/lib/git/agentForgeCredentials.ts`, `CONTRIBUTING.md:78-130` | Agent `gh`/`git` shims route covered writes to declared repositories through the App; everything else is untouched. | Nothing to route. | A refused write stops with "Delegatus refused this GitHub write". |

### 1.8 Grouping, worktree sweep and reaping

| Where | What it does | No GitHub | GitHub down or slow |
|---|---|---|---|
| `src/lib/projects/forgeRename.ts:116-153` | A repository rename is aliased only when `gh api repos/<name>` (then plain REST) proves the same numeric id. | Not applicable; no alias needed. | Candidate stays undecided; projects stay separate. Fine. |
| `src/lib/pipelines/worktreeSweep.ts:269-271`, `:62-69`, `:182-187` | Frees a lane worktree once a **merged pull request** has its branch as head; `no-merged-pr` keeps it until the retention bound. | Worktrees of finished lanes are kept to the time bound only; disk grows. | Same. |
| `src/lib/reaperRuntime.ts:145-185`, `:305-330` | Flow reaping probes `gh pr view/list` for a merged PR at the reviewed head, then falls back to `localBranchMerged` (Git). | Git fallback works. | 5 s timeout, then Git fallback. Already right. |

### 1.9 Words the agents and the board read

- Orchestrator mandate `src/lib/orchestrator/prompt.ts:588` ("bring the result to the merge bar", attach a GitHub issue), `:593` (a stage prompt says whether to open a pull request), `:597` (the merge bar: "A PR is ready when…", "tell the operator PR ready: <url>", batch "2+ ready, authorized PRs"), `:603`, `:607` ("when this lane's PR delivers the whole task… moves to Done when its PR merges").
- MCP descriptions `src/lib/mcp/server.ts:3700`, `:4213`, `:4275` (finishesTask "when its PR merges"), `:4236` (retry-merge).
- Builder scaffold `src/lib/roles/defaults.ts:294`: "the report is published as the pull request body". Merger role `:358`: GitHub-only procedure. Board maintainer `:172-183`: reads PR state on the forge, "a task with an open pull request stays assigned".
- Board copy `src/lib/i18n/en.ts:682-685`: "Pipelines end with an open PR.", "Green checks only; a conflict waits for you.", "Needs a GitHub pull request; pipelines here end without a merge." The setting row disables itself when the project remote is not GitHub (`src/components/MergeOnReviewRow.tsx:63-89`; `src/app/api/projects/settings/route.ts:63`, `:82`).

### 1.10 What is already Git-only (keep, reuse)

- Provisioning from `origin/<base>` or the local base when there is no origin (`src/lib/pipelines/git.ts:236-252`); the remote read that tolerates a missing remote (`:1706-1717`).
- Exact-head publication and its receipts (`git.ts:1814`, `stageAttemptPush.ts:173-536`), the review fence on `origin/<branch>` or the local head for internal lanes.
- `mergeEligible` and `reviewedHead` (`autoMerge.ts:115-152`, `:319-345`), `prHeadBehindReviewedHead` (`:348-357`, `git merge-base --is-ancestor`).
- Conflict and patch proofs with `git merge-tree --write-tree` (`provision.ts:272`, `batchLanding.ts:12-54`).
- The local pre-push gate plan (`scripts/local-gate.ts:51-95`; the hook `.githooks/pre-push:1-18`): privacy with `--check-commits` and the committed fingerprints, types, eslint, touched tests compared against the merge base, scoped Linux, runtime and native lanes, supply chain. Cloud execution of the same plan is per project and optional (`docs/design/cloud-checks.md`).
- The legacy local landing `finishMerge` (`provision.ts:253-301`): clean checkout on the base, preview with `merge-tree`, `git merge --no-ff` with the controller identity, no push.
- Release: tags, cut, change list, deployment ledger (§1.5 last row).

## 2. The incidents of 2026-10-25

All times UTC. Sources: the seat-tick journal rings under the state
directory (`seat-tick/runs.ndjson` and one ring per project), a read-only
`VACUUM INTO` copy of `state.sqlite` taken at about 19:57Z, the seat's own
chat with the operator, and GitHub's check-runs API read at 20:03Z.

### 2.1 Seat wakes cancelled on the pull-request evidence refresh

The detail string is `SeatTickEvidenceRefreshCanceledError`'s message
(`seatTickSources.ts:2898`), journaled by `seatTickController.ts:1352-1356`
after the one in-process retry (`:1344-1350`).

| Ring | Checks on 2026-10-25 | Cancelled | Last delivered wake |
|---|---:|---:|---|
| this project | 199 | 104 | 17:49:26Z |
| the most active other repository project | 201 | 102 | 19:43:45Z |
| a repository project with 9 wakes | 174 | 114 | 15:52:18Z |
| two plain-directory projects (`dir-…`) | 165 each | 78, 80 | none |
| `project_unresolved` | 165 | 96 | n/a |
| six more repository projects | 165 to 191 each | 90 to 108 | none |
| **all project rings** | **2,087** | **1,154** | |

Observed: the first cancellation on every ring is between 00:00Z and 00:32Z
(the rings start at midnight), so the condition held all day and worsened
with lane churn (the seat reported 36 active lanes at 19:37Z). Plain-directory
projects, which can never produce a pull request, cancelled at the same rate:
the lane hash in `pullRequestEvidenceKey` (`:2951-2956`) runs for every
project before the `gh` gate in `unmergedPullRequests` (`:1832`). The seat's
own words at 19:37Z: since 17:07Z every check of this project ended with that
error and no wake reached it; its fix lane 37c26247 was opened for the tick
itself. Inferred: the window is the `gh pr list` subprocess (20 s timeout) plus
the lane hashing on both sides; with dozens of lanes writing attempts, a change
inside that window is the common case.

### 2.2 Merges blocked on PR head changes and red hosted checks

Hot store at about 19:57Z, completed lanes with `merge.state === "blocked"`:

| Reason (`mergeReasons.ts`) | Lanes | Pull requests | `blockedAt` |
|---|---:|---|---|
| `the PR head changed after the lane finished` (`decideMerge` `:376`) | 4 | 3257, 3273, 3279, 3200 | 13:30Z to 14:44Z |
| `check "typecheck" failed` | 4 | 3252 (the original and three refresh generations, all mirroring one read, `autoMerge.ts:893-912`) | 15:45Z |
| `check "build" failed` | 2 | 3308 (original and refresh child) | 18:53Z |
| `check "darwin-identity" failed` | 2 | 3277, 3298 | 23/24.10 |
| `check "privacy-publication" failed` | 1 | 3321 | 19:36Z |

Observed cause of the first row: Codex Cloud result 86, applied by lane
7928afbc the same evening, states that a merge-controller lane published a
main merge onto a finished lane's PR branch without lineage, and the queue
then blocked the PR forever with that reason (the lane's pinned specification,
18:14Z). The reviewed head is still an ancestor of the new head; Git could
have proved that, GitHub's `headRefOid` cannot.

Observed on the red checks, one case end to end: PR 3318. Lane a1851948
completed at 10:41:20Z with reviewed head `aa810de5` (all checks green on that
head, API read at 20:03Z). Its refresh child merged main and produced head
`88a8cf63`; on that head `bun-runtime` ran 12:03Z to 12:10Z and **failed**,
then a rerun 15:58Z to 16:07Z **succeeded** (check-runs API with
`filter=all`). The seat-tick item at 16:34Z carried «merge stopped: check
"bun-runtime" failed; pipeline_action retry-merge once the PR's checks are
green»; the seat reran the check, judged the failure a one-off npm failure,
retried the merge, and the PR merged at 16:39:55Z. Six hours between a
reviewed, locally gated lane and its landing, four of them on one red hosted
run of unchanged code.

What the records cannot show: the merge record keeps check names and the
verdict (`checkRollup.ts:77-80` drops everything else), so whether a red was
computed on a merge ref against an older main cannot be read back. The
mechanism exists: `pull_request` workflows run on the merge ref GitHub
computes at trigger time, the result is attached to the head SHA and never
recomputed when main moves, and this repository's protection has
`strict: false`, so a result can be stale in either direction. The pinned
specification's "red checks from stale merge refs" is the seat's reading of
PR 3252's chain; this document records it as plausible and unproven.

Note (20:03Z): `gh pr list` showed 25 of the 26 open PRs with
`mergeStateStatus: UNKNOWN`. GitHub computes mergeability lazily, so this
alone proves no outage; it does show what `decideMerge` `:420-423` waits on.

### 2.3 Issue publication refused by the App check

At 19:33Z the operator approved the bug report «Conversation view names a
Codex default model instead of the model the stage was set to run on» (digest
`0a53e71a`). The seat reported at 19:40Z three refusals with the exact text of
`bin/forge-app-token.mjs:180`, "the GitHub App installation is missing,
suspended, or differs from the verified one", while pushes to the same
repository worked. The installation is re-read on every mint (`:132-134`); a
transient GitHub answer about the installation refuses the write. Nothing was
filed; the seat asked the operator to check the App. This is the correct
behaviour for a write that must never fall back to a person's credentials, and
exactly why an issue can only ever be an adapter: no lane, task or wake may
depend on it.

## 3. The principle

**Git is the truth; a forge mirrors it.** For every fact Delegatus acts on,
the authoritative source is one of: the lane's own records (verdicts, reviewed
head, publication receipts), Git objects and refs (branch, commits, merge
commit, ancestry to the base), the local gate's receipts, and the deployment
ledger. GitHub (pull requests, check runs, reviews, issues, the App) is read
into those records as a signal and written to as a mirror. A missing or slow
forge degrades the mirror, never the path. A forge write that must be
exclusive (the App) stays exclusive and stays off the path.

Three consequences:

1. **A merge is a Git merge commit** of the lane's reviewed head into the base,
   made by Delegatus with the controller identity, gated by the local required
   checks on that merge commit, then pushed to the project's Git remote or
   applied to the local base. "Landed" means `git merge-base --is-ancestor
   <reviewedHead> <base>` is true on the remote (or local) base.
2. **"Finished" means ancestry.** `finishesTask` moves a task to
   Done when the marked lane's reviewed head is an ancestor of the base (or,
   with the landing setting off, when the lane completes, as today).
3. **The seat wakes from records and Git.** The alarm path makes no forge
   subprocess. Forge facts reach the seat as annotations from the cache, with
   their age.

## 4. The Git-only path, area by area

### 4.1 Stage publication without a pull request

- `ensureStagePullRequest` stops being a pass-edge gate. The pass edge
  publishes the exact head (unchanged) and then asks the **forge adapter** (§5)
  to mirror it. The adapter answers at once from a queue; it never parks a
  stage. The four call sites (`engine.ts:4793`, `:5573`, `:4716`, `:5528`)
  become `enqueueForgeMirror(pipeline, attempt, head)` plus
  `advancePipeline`.
- The privacy inspection of the PR title and body (`stagePullRequest.ts:37-56`,
  the summary rewrite loop `engine.ts:4671-4697`) stays, as an adapter
  precondition: a body that fails privacy is not mirrored, the lane records
  `forge.pr.state: "withheld (privacy)"`, and the producer rewrite still runs,
  but after the lane advanced. The stored report remains the record of what
  the stage did; the PR body was always a copy of it (`:147-156`).
- A non-GitHub remote: `publishPipelineBranch` already pushes to any Git
  remote; the adapter is simply off for it. A project with no remote: the
  default `publication` (omitted) resolves to local-only when the owner
  delivery has no remote (`types.ts:1137`), which is what the engine documents
  (`engine.ts:12415`) and what the review fence already honours for internal
  lanes (`engine.ts:9102`). The remaining `unavailable` parks
  (`engine.ts:4774`, `:5564`, `:11567`, `:9115`) apply only when
  `publication: "remote-branch"` was asked for explicitly, and keep their
  wording.
- `publishedIntegrationGreen` (`stageAttemptPush.ts:30-123`) loses its forge
  branch: a missing creation receipt is excused only by Git evidence (the
  integration commit's parents and the local gate receipt on that exact head,
  §4.3), or refused as before. A hosted-green excuse comes back only as an
  adapter signal when the operator turns hosted gating on (§5.3).
- `stageProvenance.pullRequestOf` reads the forge cache instead of `gh`
  (the cache is already seeded by the sweep, `sweep.ts`); the provenance record
  keeps `pullRequest` and `pullRequestState` with the cache's `checkedAt` as
  its age.

### 4.2 Landing: the Git merge

The landing executor replaces `stepLane`'s GitHub decision with Git facts,
keeps the queue, the admission rules and the record shape, and gains one write
path per remote kind.

**Input.** A completed lane with `mergeEligible` true (`autoMerge.ts:115-152`,
unchanged), its `reviewedHead(pipeline)` (`:319-345`, unchanged), the delivery
target's branch and remote, and the base branch.

**Steps, one lane per repository at a time (queue order as today,
`:968-1000`):**

1. **Fetch** the base tip from the remote, bounded (`git fetch --no-tags
   <remote> +refs/heads/<base>:refs/remotes/<remote>/<base>`, the 10 s
   `timeout --signal=KILL` form `git.ts:1712-1715` uses). No remote: read
   `refs/heads/<base>` of the project repository.
2. **Already landed?** `git merge-base --is-ancestor <reviewedHead> <baseTip>`
   true → record `landed` with the base tip and finish (replaces the
   `MERGED`/"by outside" reads, `:371`, `:863-872`, `:925-934`).
3. **Conflict probe**: `git merge-tree --write-tree --no-messages
   --merge-base=$(git merge-base base head) <baseTip> <reviewedHead>` in the
   project repository (objects only, as `batchLanding.ts:29-33`). Exit 1 →
   conflict → the existing refresh lane (`autoRefresh.ts`), whose detection
   today needs GitHub's `DIRTY` (`:386`) and `BEHIND` (`:395`). `BEHIND` has
   no Git meaning for a merge commit and is dropped: a clean `merge-tree`
   lands whatever the distance, which is what the refresh lane produces
   anyway. The refresh brief's "merge current origin/<base>" becomes "merge
   the current base <remote>/<base>" or the local base.
4. **Merge commit** in a scratch worktree of the project repository
   (`git worktree add --detach <scratch> <baseTip>`; `git merge --no-ff
   <reviewedHead> -m "<title> (#lane…)"` with `controllerCommitIdentityEnv`,
   as `provision.ts:277`). The tree equals the `merge-tree` result; assert it.
5. **Local gate on the merge commit**: `scripts/local-gate.ts pre-push` in the
   scratch worktree with the base set to `<baseTip>` (the plan already
   compares touched tests against a base, `local-gate.ts:51-95`), through
   `scripts/gate-slot.sh`, with isolated state (`isolatedEnvironment`), under
   the publication budget (`src/lib/pipelines/gateBudget.ts`). The verdict is
   recorded on the lane as `landing.gate: { head, mergeCommit, base, passed,
   at, log }`. A red gate blocks with the failing check's name, exactly as a
   red hosted check does today; a deadline-only failure retries after 1, 5 and
   15 minutes like a publication (`publication.ts:16-33`). The pre-push plan's
   privacy step runs with `--check-commits` over the landing's commits, so the
   same fingerprints gate the landing as gate every push.
6. **Publish the landing** by remote kind:
   - plain Git remote: `git push <remote> <mergeCommit>:refs/heads/<base>
     --force-with-lease=refs/heads/<base>:<baseTip>`. A lease failure means
     the base moved: go to step 1 (the `mainMoving` reason, `mergeReasons.ts:15`,
     after N rounds).
   - GitHub remote **with branch protection that requires contexts** (read
     once per repository per 30 min, `:232-247`, kept as an adapter read):
     the push would be refused (§5.3), so the adapter performs the write
     through the mirrored pull request: `gh pr merge --merge
     --match-head-commit <reviewedHead>` as the App, as today (`:644`). The
     merge commit GitHub makes is then fetched and recorded; "landed" is still
     proved by ancestry in step 2 on the next read, never by GitHub's `MERGED`.
   - GitHub remote **without** protection: the plain push, like any Git remote.
   - no remote: §4.2.1.
7. **Record** `merge.landed = { base, baseTip, mergeCommit, reviewedHead,
   by: "git" | "forge", at }` under the pipeline lock through the existing
   `commit` fence (`:435-450`), then the finish sweep (§4.3).

**What this removes.** `headChanged` (`:376`): the landing merges the exact
reviewed head, so later pushes to the lane branch are irrelevant; a branch
whose tip is no longer the reviewed head lands the reviewed head and the
record says so. `noChecks`, `checksTimeout`, `draft`, `closed`,
`changesRequested`, `reviewRequired`, `protection`, `unreachable`
(`mergeReasons.ts:9-21`) stop being landing reasons; the first two are
replaced by the gate's own verdicts, the others become adapter signals (§5.2)
and, where the write channel is the pull request, write refusals in GitHub's
words (`MERGE_REASON_PATTERNS.refusedMerge`, kept).

**Method.** A merge commit is the Git-only default because it keeps the
reviewed head's SHA in history, which is what makes "landed" provable by
ancestry and what makes GitHub mark the mirrored PR as merged by itself when
the base receives it. Squash and rebase rewrite the SHA; proving a landing then
needs `patchPresent` (`batchLanding.ts:12-54`), which exists and is slower.
§7 Q1.

**4.2.1 A project without any remote.** The base is a local branch, usually
checked out in the operator's working copy. Updating `refs/heads/<base>` under
a checked-out dirty tree is unsafe. Proposal: when the project checkout is on
the base, clean, and at `<baseTip>`, fast-forward it (`git merge --ff-only
<mergeCommit>`, the `finishMerge` preconditions `provision.ts:255-263`);
otherwise write `refs/delegatus/landed/<base>` to the merge commit, record
`landed.applied: false`, and show on the card "landed; your checkout of
<base> is dirty, run `git merge --ff-only refs/delegatus/landed/<base>`". §7 Q3.

**4.2.2 The seat's batch merger.** `scripts/merge-batch.ts` keeps `build` and
`gate`; `land` gains the Git push path of step 6 for remotes without
protection and keeps the `gh pr merge` path for protected ones. The App
principal check (`:455-471`) applies only to the forge path.

### 4.3 Completion from ancestry

- `laneFinishedForTasks` (`autoMerge.ts:1123-1132`): with the landing setting
  on, finished means `merge.landed` is recorded, or a bounded ancestry read of
  the base shows the reviewed head landed (covers landings made by hand or by
  the operator's own `git merge`). The forge cache is no longer consulted.
  `laneNeedsNoPr` keeps its three Git-only rules (no commits, read-only
  outputs, published prototype) under a new name, `laneNeedsNoLanding`.
- `sweepTaskFinishes` (`:1150-1203`) and the archive hold (`store.ts:2170`)
  are unchanged.
- The Done section (`done/candidates.ts`) adds a candidate class "landed" from
  `merge.landed`; the forge-cache classes stay for history.
- Worktree sweep and reaper: `mergedPullRequests` (`worktreeSweep.ts:269-271`)
  gets a Git-first implementation (reviewed head ancestor of the fetched base)
  with the forge read as a fallback for lanes whose records predate
  `merge.landed`; `reaperRuntime.ts` already has `localBranchMerged`.

### 4.4 The seat tick without a forge subprocess

- `unmergedPullRequests` becomes `unlandedLanes`: finished lanes of the project
  whose `merge` record is not `landed`, read from the hot store and archive the
  check already reads (`:1871-1880`), with `mergeBlocked` and
  `lastFixUnreviewed` from the record as today (`:1950-1956`). No `gh`. The
  wake reason is renamed `unlanded-lane` (`seatTick.ts:1394`; the kind list
  `types.ts:185-235`), its detail "lane <id> finished and has not landed; merge
  stopped: <reason>".
- `pullRequestEvidenceKey`, `refreshSeatTickEvidence`'s second read and
  `SeatTickEvidenceRefreshCanceledError` (`:2896-2993`) are deleted; the check
  reads its evidence once, and the fingerprint (`:1627-1667`) drops the PR
  list and `FINGERPRINT_UNREAD`. A lane that changes during the check changes
  the next check's fingerprint; it does not cancel this one. The two consumers
  in the controller (`:1820-1825`, `:1870-1883`) call the plain refresh.
- Forge facts the seat still wants (the PR number and URL for its words, a
  hosted red as a hint) come from the forge cache with `checkedAt`, attached to
  the item, never gating it. Proposal issues (`:1822`, `:1877`) stay as the
  optional degraded source they already are, with their own timeout.
- Lane 37c26247 (opened 2026-10-25 19:44Z) is fixing the livelock inside the
  current design (deliver with the evidence it has, or cap cancels). This
  slice supersedes that fix's PR-key machinery; the lane's reproduction test
  (churn on every refresh still yields a wake) is the acceptance test here.

### 4.5 Release readiness from landings and the ledger

- Blocker 5 (`policy.ts:48`) reads **landing receipts**: every first-parent
  commit in `lastTag..cut` that is a Delegatus landing has `landing.gate.passed`
  (the release controller already enumerates them, `production.ts:53-66`); a
  commit on main that no landing record covers (a hand push) is `unknown` and
  the release asks the seat, as the deployer brief already does for an
  unverified premise. Hosted check runs are read only when the adapter is on
  and hosted gating is chosen (§5.3), and the `gh repo view` at `:174` goes.
- Blocker 3 `merge-off` (`policy.ts:46`) reads the landing setting (§4.6).
  Everything else in `releaseState` is already Git and ledger.

### 4.6 The setting

`mergeOnReview` (`src/lib/projects/settings.ts:177-182`, `:262`) keeps its key
and its storage and changes meaning and words: **"Land when the review
passes"**. Off: a completed, review-eligible lane keeps its branch published
(and mirrored, where a forge exists) and the seat is told it is ready; nobody
lands it automatically. On: the landing executor lands it. `retry-merge`
(`engine.ts:14702`) keeps working as "retry the landing". The row's
GitHub-only guard (`MergeOnReviewRow.tsx:63`; route `:82`) goes; the row is
available to every project with a Git repository, and a plain directory (no
repository) shows "this folder has no repository yet; the first pipeline
creates one" (`docs/pipelines.md:12-15` already initializes one).

### 4.7 Deploy and unattended updates

The deploy is already Git. For `GreenReader` (`green.ts`): a revision is green
when its landing receipt shows the local gate passed (§4.2 step 5); hosted
check runs stay a second source when the adapter is on. `not-github` stops
being a reason to skip the question: a checkout install of a plain Git remote
gets the same landing-receipt answer.

### 4.8 Words

The mandate, the MCP descriptions, the builder and merger scaffolds and the
board copy of §1.9 change "PR merges" to "lands", "PR ready: <url>" to "ready
to land: <branch> (PR <url> where one exists)", and the merger's procedure
gains the Git push path. Text-only edits; no prompt-phrase tests (project
rule).

## 5. GitHub as an adapter

### 5.1 One seam

`src/lib/forge/adapter.ts` (new; the production ports pattern of
`autoMerge.ts:1219-1256` and `appWrite.ts` carry over):

```ts
interface ForgeAdapter {
  enabled(repository: RepositoryIdentity): boolean;          // GitHub remote and not switched off
  mirrorPullRequest(lane, head): Promise<MirrorOutcome>;       // ensureStagePullRequest's body, queued, retried by the sweep
  readPullRequest(repository, number): CachedPullRequest | null; // forge cache
  readChecks(repository, sha): ReadCheck[] | "unavailable";     // hosted checks, with checkedAt
  readReviews(repository, number): PullRequestReview[] | "unavailable";
  landThroughPullRequest(lane, reviewedHead, method): Promise<WriteOutcome>; // the protected-branch write channel, as the App
  fileIssue(report, repository): Promise<string>;              // unchanged seam, issueReports/publish.ts
}
```

Every read answers from the forge cache or `"unavailable"` with a bounded
timeout and never throws into a pipeline, tick or sweep. Every write is one
of the covered kinds the App already routes (`CONTRIBUTING.md:98-102`).

### 5.2 Mirrors and signals

| Fact | Git truth | GitHub mirror or signal |
|---|---|---|
| The lane's work | the published lane branch at the exact head | a pull request opened at the first passed stage, body refreshed on later heads; opened later if the forge was down (the sweep retries) |
| Reviewed | the reviewer's passed attempt and `reviewedHead` | a PR review comment with the verdict summary (optional, deferred) |
| Ready to land | `mergeEligible` and a green local gate on the merge commit | the hosted checks on the head and the PR's `reviewDecision`, shown on the card with their age; a human "changes requested" on GitHub is a **signal** the seat reads, never a block, unless §5.3 |
| Landed | reviewed head is an ancestor of the base | GitHub marks the PR merged by itself when the base contains the head (merge-commit method); with a protected base, the PR is the write channel and GitHub's merge commit becomes the landing |
| Finished | `merge.landed` and no open lane on the task | the PR chip reads "merged" |
| A bug in Delegatus | a board task in this project | an issue in this repository, filed as the App after approval (unchanged) |

### 5.3 Hosted checks as a gate, by explicit choice

A per-project switch `hostedChecksGate` (default off). On: the landing
executor, after the local gate, also requires the hosted required contexts
green on the head it is about to land (the `decideMerge` rules `:400-411`
applied to adapter reads, with the 90 min bound), and a red hosted check
blocks with its name as today. Off: a hosted red is shown and reported, and
the landing proceeds on the local gate.

This repository forces the question. Branch protection on main (read 20:00Z):
required contexts `privacy-publication`, `privacy-tracker-audit`,
`runtime-gate`, `typecheck`; `enforce_admins: true`; `strict: false`; no
required reviews; no restrictions; no rulesets. A direct push of a merge
commit to main is refused unless those four contexts have reported success on
that SHA, and three of them run only on pull-request events
(`.github/workflows/bun-runtime.yml` `on: pull_request`;
`privacy-publication.yml` `push: main` and `pull_request_target`;
`memory-selection.yml` `typecheck` on `pull_request` and `push: main`). So,
with protection kept, the only write channel to main is the pull request, and
the hosted contexts gate it whatever the switch says. Two ways to keep "Git
decides" true here:

- **A (recommended):** keep protection; the executor's step 6 uses the PR
  write channel on this repository; the local gate runs first and a local red
  stops the landing before GitHub is asked; a hosted red is then a real block
  reported in GitHub's words. The public privacy-publication check keeps its
  full force on every PR and on main.
- **B:** relax protection to "no required contexts" and push merge commits
  directly; hosted workflows still run on `push: main` for privacy and
  typecheck, as post-landing signals, and `bun-runtime` would need a `push`
  trigger to run at all. The public repository would then publish a landing
  before the hosted privacy check saw it; the local privacy gate with the same
  fingerprints ran, but a skipped hook (`LLV_SKIP_HOOKS=1`) would have no
  backstop. §7 Q2.

### 5.4 Credentials

Reads use the Viewer process's own `gh` login as today (`githubRunner`,
`githubEvidence.ts:34-39`). Writes to a declared repository go out as the App
or not at all (`appWrite.ts`, `forge-app-token.mjs`); an App refusal is an
adapter outcome on the record ("mirror withheld: <reason>"), never a park. The
subscription-login rule for the agents is untouched.

## 6. Migration in slices

Each slice ships alone, behind no flag unless named, with its tests by path.
"Here today" says what changes for this repository and this installation.

| # | Slice | Changes | Risk and its control | Here today |
|---|---|---|---|---|
| S1 | **Tick wakes without the forge window** | `unlandedLanes` from records; delete the PR evidence key, second refresh and cancel error; drop the PR list from the fingerprint; keep hosted facts as cache annotations. Rename `unmerged-pr` → `unlanded-lane` with a reader for stored `lastWakeReasons`. | Duplicate or lost wake. Controls: the delivery dedupe already in the controller; tests `seatTickSources.test.ts` churn case (from lane 37c26247's reproduction), "real source failure still surfaces" becomes "blocked landing still surfaces", restart mid-tick. | Ends §2.1 for all 10 seats. Supersedes the PR-key part of lane 37c26247; coordinate before both land. |
| S2 | **Stage publication advisory** | `ensureStagePullRequest` moves behind the adapter queue; the four call sites advance first; non-GitHub remotes record "no forge" and continue; `publishedIntegrationGreen` Git-only; `stageProvenance` reads the cache. | A lane completes with a PR body one head behind. Control: the sweep retries the mirror; the card shows "mirror pending". Tests: `stagePullRequest.test.ts` cases flip from park to recorded outcome; a new case: non-GitHub remote passes. | Lanes stop parking on a `gh` hiccup at pass. PR bodies may lag by one sweep (3 min). |
| S3 | **Landing record and completion from ancestry** | `merge.landed`; `laneFinishedForTasks`, Done candidates, worktree sweep, reaper read it or ancestry; forge cache becomes a fallback for old records. | A task finishing on a hand merge the operator did not mean as a landing. Control: ancestry of the **reviewed** head only; a `--force` rewrite of main is out of scope. Tests: `forge/taskFinish.test.ts`, `worktreeSweep.test.ts`. | Tasks finish when main contains the reviewed head, even if GitHub's PR state is stale. |
| S4 | **Git landing executor** | §4.2 steps 1 to 7; GitHub write channel for protected bases; `headChanged` and the GitHub-only reasons retired; `merge-batch.ts land` Git path. Needs §7 Q1 to Q4. | Highest. A landing that bypasses a gate, a lease race, a scratch worktree leak, gate time per landing. Controls: the landing is refused unless the gate receipt names the exact merge commit (break the receipt in a test and watch it refuse); `--force-with-lease`; worktrees under the lane artifacts dir with the existing sweep; measure gate time on ten real landings before enabling by default (the pre-push plan on a small change took 25 min under load on 2026-10-12, `docs/design/checks-under-five-minutes.md` §2.2; the after-times of that work decide whether a landing gate fits). Three review rounds, as for the merge runner. | With A in §5.3: landings still go through the PR, after a local gate; `headChanged` blocks disappear; red hosted checks still block (protection). |
| S5 | **Release and update readiness from receipts** | Blocker 5 from landing receipts; blocker 3 from the landing setting; `GreenReader` receipt source; `not-github` no longer skips. | A release cut containing an unreceipted hand push. Control: `unknown` asks the seat. Tests: `release/production.test.ts`, `selfUpdate` green tests. | Releases stop depending on `gh api` for check runs; the publish brief keeps re-reading hosted checks only while §5.3 is on. |
| S6 | **Setting, copy, prompts, docs** | "Land when the review passes" everywhere in §1.9; remove the GitHub-only guard on the row; `hostedChecksGate` row beside it; `docs/pipelines.md`, `docs/merge-batch.md`, `AGENTS.md` lines on merging. | Text only. | Board row enabled for every repository project. |
| S7 | **Retire GitHub-only leftovers** | Batch-landing receipts via issue comments → `patchPresent` on the base (Git already does the proof, `batchLanding.ts:12-54`); forge cache `landedPullRequests` kept for history only; `forgeRename` unchanged (optional by construction). | Low. | None visible. |

Order: S1 → S2 → S3 are independent of the questions and of each other in
code (S1 touches `monitor`, S2 `pipelines`, S3 `forge/autoMerge` finish half
and `done`). S4 follows S3 (it writes the record S3 reads) and the answers.
S5 and S6 follow S4. S7 any time after S3.

Fences for whoever builds: lane 37c26247 (seat tick) and lane 7928afbc (Cloud
86 and 87, `autoMerge.ts`, `autoRefresh.test.ts`, `seatAgenda.ts`,
`mergeSuccessor.ts`) are open on 2026-10-25 and change the same files as S1
and S4; read their diffs first (rule 8).

## 7. Questions only the operator can answer

Each with options and one recommendation. They change S4 and later; S1 to S3
need none of them.

**Q1. How does a lane land?**
(a) **Merge commit of the reviewed head** (recommended): provable by
ancestry, GitHub marks the mirrored PR merged on its own, `headChanged`
cannot happen, history keeps one commit per review round. (b) Squash, as
GitHub does today (`autoMerge.ts:225` prefers squash when allowed): one
commit per lane on main, but landing proof needs `patchPresent` and the
mirrored PR needs an explicit close. (c) Rebase: rewrites every lane commit;
same costs as squash.

**Q2. This public repository: keep branch protection?**
(a) **Keep it** (recommended): the pull request stays the write channel here,
after the local gate; hosted privacy-publication keeps enforcing every PR and
main; a hosted red still blocks here, by protection, whatever the project
switch says. (b) Relax protection and push merge commits directly with the
local gate as the only gate; add `push` triggers to the required workflows so
they still run after landing as signals; accept that a skipped hook has no
hosted backstop.

**Q3. A project with no remote: where does the landing go?**
(a) **Fast-forward the operator's checkout when it is clean on the base;
otherwise write `refs/delegatus/landed/<base>` and say so on the card**
(recommended). (b) Always write the ref and never touch the checkout; the
operator merges by hand. (c) Refuse to land without a remote; the lane ends
"ready to land" and the task waits.

**Q4. Hosted checks as a landing gate, default for projects with GitHub?**
(a) **Off** (recommended): a hosted red is a signal on the card and in the
seat's wake; the local gate decides. (b) On: a hosted red blocks the landing,
as today, with the 90 min settle bound.

**Q5. Default of the landing setting for a new project?**
(a) **Off** (recommended, unchanged): a finished lane is "ready to land" until
the operator or the seat turns the project's landing on; the operator's words
«мержи все через Git» are about the mechanism, and #2187's default was chosen
by them a month ago. (b) On: every reviewed lane lands by itself in every
project.

## 8. Deferred (not currently justified)

- Adapters for other forges (GitLab merge requests, Gitea, Forgejo). The
  Git-only path makes those projects work; a second mirror is new scope.
- Posting review verdicts as PR reviews or comments on the mirror.
- Moving the hosted privacy-publication check to local-only for this
  repository. The local gate uses the same fingerprints, but the hosted check
  is the backstop for a skipped hook on a public repository.
- Per-stage hosted check gating; per-lane landing method.
- Replacing the forge cache and the PR/issue chips (#2059); they are the
  mirror's own display and stay.
- A merge queue that batches several lanes into one landing (the seat's
  `merge-batch.ts` keeps doing that by hand; the executor lands one lane at a
  time, as the runner does today).

## 9. Acceptance, with the hostile input and the enforcing layer

For every refusal this design promises (rule: name the input, the layer and
the observable hold):

| Promise | Hostile input | Enforcing layer | Observable |
|---|---|---|---|
| A lane never parks on a forge read at pass | `gh` replaced by a stub exiting 1 at every call | engine pass edge after S2 | the stage advances; the lane shows "mirror pending"; `stagePullRequest.test.ts` case |
| A tick completes under churn | a source that mutates a lane on every `pipelines()` read | S1's single-read refresh | one wake delivered within the interval; `verdict: "error"` count 0 in the journal ring |
| Nothing lands red | a merge commit whose gate receipt names a different SHA | landing executor step 6 refuses without a receipt for the exact merge commit | `merge.state: "blocked"`, reason names the missing receipt; a test breaks the receipt after step 5 and asserts the refusal |
| Nothing lands over a moved base | the base advanced between fetch and push | `--force-with-lease=<base>:<baseTip>` | push refused; the executor re-fetches; after N rounds `mainMoving` |
| A task finishes only on the reviewed head | a branch force-pushed to a different tip after review | `merge-base --is-ancestor <reviewedHead>` | the task stays open; the lane shows the unlanded reviewed head |
| The App never falls back to a person | the App helper absent | `forge-app-token.mjs` refusal, unchanged | mirror withheld, landing through the PR channel refused with the App's words; the Git push channel unaffected |
| Hosted gate off means a hosted red does not block | a red check run on the head, switch off | landing executor | landed; the card and the wake carry the red as a signal |

## 10. Evidence register

| Item | How it was read | When |
|---|---|---|
| Line anchors | `grep`, `sed -n` on the worktree at `b027e190d`; `git fetch origin main` confirmed main unchanged | 2026-10-25 19:00Z to 20:00Z |
| Seat-tick journal counts | `grep -c` over `seat-tick/runs.ndjson` and the per-project rings in the live state directory, read-only; per-project verdict summary with a short Python script | about 19:58Z |
| Lane counts, publication modes, blocked merge records | `VACUUM INTO` a scratch copy of `state.sqlite` with `bun:sqlite` read-only; one script over `state_rows` for `pipelines` and `pipelines_archive` | about 19:57Z |
| PR 3318 check runs | `gh api repos/<this repository>/commits/<sha>/check-runs?filter=all` for `aa810de5` and `88a8cf63` | 20:03Z |
| Branch protection | `gh api repos/<this repository>/branches/main/protection`; `rules/branches/main` answered `[]` | 20:00Z |
| Open PR merge states | `gh pr list --state open --limit 100 --json mergeStateStatus` | 19:59Z |
| The operator's words, the seat's reports, the issue refusal | the seat conversation's messages of 19:28Z to 19:42Z through `conversation_messages` | |
| Cloud result 86's cause | lane 7928afbc's pinned specification (18:14Z) | |
| Prior designs read | `merge-policy-and-task-finishing.md`, `auto-refresh-conflicting-prs.md`, `auto-release.md`, `issue-report-approval.md`, `cloud-checks.md`, `checks-under-five-minutes.md`, `pr-issue-chips.md`, `retire-flows.md`; `search_transcripts` found no earlier design for a Git-only path; `search_memory` found nothing | |

Not verified: the "stale merge ref" cause of the red hosted checks (§2.2); the
after-time of the pre-push plan since 2026-10-12, which decides whether a
landing gate fits in minutes (S4's measurement step).
