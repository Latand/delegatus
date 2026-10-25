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

Needs the operator's answers to §7 before the executor slice (S5) is
built. S1 to S4 do not depend on those answers and can start now. The default
answer to "should we build this" is yes here: the requirement demands it, and
§2 shows that on 2026-10-25 every one of the three GitHub-bound mechanisms
stopped work that Git alone could have finished.

## Summary

- **Today GitHub is load-bearing in six places**: every passed stage must find
  or open a pull request or the lane parks; the merge queue reads and writes
  only GitHub; a task finishes only when GitHub says the PR merged; the seat
  tick runs `gh pr list`, `gh issue list` and a release observation inside the
  alarm; release readiness, the release lane and unattended updates read GitHub
  check runs, pull requests and workflows; bug reports go out as the GitHub
  App. A project whose remote is any other Git host parks at its first passed
  stage (a lane created with `publication: "remote-branch"` and no remote
  parks the same way). A project with no remote runs with the omitted or the
  `"internal"` publication policy, and with the merge setting on its
  implementation lanes never merge and their tasks never finish.
- **On 2026-10-25** this cost: 1,154 of 2,087 seat-tick checks across every
  project on this machine cancelled on "pull-request evidence changed" (journal rings read up to
  19:58Z); this project received no new wake between 17:49:26Z and the
  capture at 19:58Z (a later read shows wakes resuming at 21:52Z); 13 hot
  lanes blocked in the merge queue, 4 on «the PR head changed after the lane
  finished» and 9 on named red hosted checks (one of them green again after a
  rerun, 4 h later); three refusals of an approved bug report by the GitHub
  App check. Each is traced to its line in §2.
- **The Git-only path** keeps the parts that are already Git: the lane branch,
  the exact-head publication, the reviewed-head fence, `merge-tree`
  conflict detection, the local pre-push gate, ancestry. The landing becomes a
  Git merge commit of the lane's landing head (the exact head its review
  judged) into the base, gated by the project's declared local checks on that
  exact merge commit, then fast-forward pushed to the project's Git remote or
  applied to the local base. A lane is finished when its landing head is an
  ancestor of the authoritative base; a prepared but unapplied local landing
  finishes nothing. The seat wakes from Git ancestry, Delegatus's own records
  and cached forge observations, with zero forge subprocesses and no forge or
  release read awaited on the alarm path.
- **GitHub becomes an adapter**: a pull request mirrors the lane, hosted checks
  and reviews are read into the record as signals, an issue is filed where the
  repository has one. The adapter adds; it never gates the Git path, with one
  exception the operator can switch on per project: hosted checks as a landing
  gate. On this public repository, branch protection (four required contexts,
  `enforce_admins: true`) admits a push to main only for a commit on which the
  four hosted contexts already succeeded, so the executor attaches them to the
  exact checked merge commit through a dedicated candidate pull request and
  fast-forwards main to that same commit, after the local gate; hosted
  privacy-publication keeps its enforcement.
- **Seven slices**, the first four independent of the open questions.

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
| `src/lib/pipelines/publication.ts:5-8` `pipelinePublishesRemoteBranch`, `engine.ts:4758-4761`, `:5539-5543`, `:9104` | Three policies. `remote-branch` (explicit) publishes every passed stage and parks with `MISSING_DELIVERY_REMOTE` (`publication.ts:10`) when the delivery target has no remote (`engine.ts:4774-4777`, `:5564-5567`, `:11567`, `src/lib/pipelines/git.ts:2183`; review ingress `engine.ts:9115-9120`). Omitted publishes only when an owner delivery has a remote and is local-only without one: the stage advances without publishing (`types.ts:1137`, `engine.ts:12415`) and review ingress skips the remote probe (`engine.ts:9104`). `internal` is the explicit local-only form (`types.ts:235`). | A project without any remote **runs** under omitted and `internal`; only an explicit `remote-branch` request parks. What fails there is the landing: the merge runner never admits the lane (§1.2) and, with the merge setting on, the task never finishes (§1.3). | n/a |
| `src/lib/pipelines/stageProvenance.ts:50-70`, `:125` | After every stage report, `gh pr list --head` (10 s) for the provenance record. | `pullRequestState: "unknown"`; non-blocking. | Same; non-blocking. The observed PR seeds the forge cache (`:143-147`). |
| `src/lib/pipelines/stageAttemptPush.ts:30-123` `publishedIntegrationGreen` | Excuses a missing creation receipt only when GitHub shows the exact head's PR open, non-draft, with every check and every required context green (`gh pr view`, `gh api graphql`, `gh api repos/…/branches/<base>`). | Returns false: the push is refused as before, no excuse. | `StageIntegrationChecksPending` → the stage **waits** on GitHub ("the published integration is waiting for green checks", `:120-122`). |
| `src/lib/pipelines/stageBranch.ts:96-116`, consumed at `:235` | The adoption fence for a stage that adopts a foreign branch: it reads the remote's branch protection with `gh api repos/…/branches/<branch> --jq .protected`, and a refusal reaches settlement as a refusal. | Only a filesystem remote (`/`, `./`, `file://`) and a repository with no remote at all return an error-free observation (`:103-109`). **An HTTPS or SSH remote on any other forge returns "the remote forge's stage branch protection cannot be verified" (`:109`)**, so adopting a foreign branch is refused. | "the stage branch's forge protection cannot be verified" (`:115`); a failed `ls-remote` refuses with `:112`. |
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
| `:915-934`, `:975-976` recovery and queue | A `blocked` record is reconsidered only when its PR is cached `merged` (`:927-934`) or closed (`:920-925`); the queue loop returns for any state outside `PIPELINE_MERGE_LIVE_STATES` or `refreshing` (`:975-976`), so `blocked` is never read again by the runner. | A `noPr` block is permanent: creating the PR later does not requeue the lane; only a person's `retry-merge` does. | Same. This is why a slice that moves PR creation behind the lane's completion must also change admission (§6 S2). |
| `:474-515` `stepLane` | Per read: `gh pr view --json <PR_FIELDS>` (`:495`), `gh api …/pulls/N/reviews` (`:509`), branch protection contexts (`:232-247`), repository merge method (`:220-230`), batch-landing receipts from issue comments (`:498-500`, `batchLanding.ts:57-86`). | n/a | Three failed reads → **blocked** `unreachable` (`:570-571`, `MERGE_READ_FAILURE_LIMIT` `:50`); 90 min → `checksTimeout` (`:48`). |
| `:370-423` `decideMerge` | Decides from GitHub's words: `headRefOid` ≠ chain tip → **`headChanged`** (`:376`); `DIRTY`/`CONFLICTING` → conflict (`:386`); any red check → blocked `check "<name>" failed` (`:388-389`); no checks after 3 min → `noChecks` (`:407`); `BEHIND` → refresh lane (`:395-398`); `BLOCKED` → protection (`:416-419`); `UNKNOWN` → wait (`:420-423`). | n/a | Every `UNKNOWN`/null read waits, up to 90 min; stale check results on the head stay red until someone reruns them (§2.2). |
| `:640-644` | The merge itself: `gh pr merge --<method> --match-head-commit <headRefOid>` as the Delegatus GitHub App (`src/lib/forge/appWrite.ts:111-131`, `forgeWriter` `:137-147`). The flag fences only the pull request's head: GitHub merges that head into whatever the base is at that moment, and refuses outright when the head is no longer the one named. | n/a | `GitHub refused the merge: <words>` → blocked. A missing App credential refuses the write and nothing falls back (`appWrite.ts:79-104`). |
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
| `autoMerge.ts:1123-1132` `laneFinishedForTasks` | With the setting off a completed lane finishes at once (`:1126`). With it on, a marked lane finishes its task only when `merge.state === "merged"` or the forge cache says the PR is merged (`ports.cachedState`, `:1243`, from `forge-links.json`). Lanes that need no PR (no commits, read-only outputs, published prototype) finish without one (`:1085-1101`, `:1129`). | **With the setting on, an implementation lane with no PR never moves its task to Done**: no PR → `laneNeedsNoPr` false → `false` (`:1129`). Setting off, and the three no-landing outputs, already finish without GitHub. | Stays unfinished until the sweep reads GitHub again (`src/lib/forge/sweep.ts:20-27`, 3 min live / 30 min idle, retry 3 min). |
| `src/lib/pipelines/store.ts:2165-2170` | A completed lane with an unfinished mark never archives. | Hot store grows by one lane per such task. | |
| `src/lib/done/candidates.ts:85-100`, `:207-218` | Two classes. "Landed" candidates come from PRs the forge cache saw merged, including batch landings parsed from PR titles. A second loop adds a completed pipeline as its own candidate when it names no PR (`:213` skips only a lane that names one by `delivery.target.pr`, a merge record, a PR on its branch or a PR work link). | A finished lane with no PR, no merge record and no PR link already appears in Done as a pipeline candidate; the forge-backed "landed" class never appears for it. | "Landed" candidates stay stale until the next sweep. |
| `src/lib/done/recover.ts:85`, `:115-118` | Cold frame recovery reads the PR body and the Git tree through `gh`. | Falls through to local refs (`:98-113`). | Same. |

### 1.4 The seat tick (`src/lib/monitor/seatTickSources.ts`, `seatTickController.ts`, `seatTick.ts`)

| Where | What it does | No GitHub | GitHub down or slow |
|---|---|---|---|
| `seatTickSources.ts:1817-1961` `unmergedPullRequests` | On every due check with a seat: `gh pr list --state open --limit 60` in the project's repository (`:1907`; `src/lib/monitor/githubEvidence.ts:232-247`, 20 s), joined to finished lanes by head branch, to raise `unmerged-pr` (`seatTick.ts:1385-1398`). | `gh` in a non-GitHub checkout fails → `command-failed` gap, replayed at the wake interval (`:1899-1901`). The reason never fires. | Same gap; the fingerprint carries `FINGERPRINT_UNREAD` (`:1627-1667`). |
| `seatTickSources.ts:2938-2971` `pullRequestEvidenceKey` and `:2975-2993` `refreshSeatTickEvidence` | Hashes **every lane of the project** (`:2951-2956`) before and after the PR read; any lane change, alias change, seat change or settings change in between throws `SeatTickEvidenceRefreshCanceledError` (`:2896-2901`). | **Runs for every project**, GitHub or not: the key is computed before the `gh` gate, so plain-directory projects pay it too (§2.1 shows cancellations on `dir-…` rings). | The longer the `gh` read, the wider the window a lane change can fall into. |
| `seatTickController.ts:1344-1350`, `:1391-1415` | One in-process retry, then the check is journaled `verdict: "error"` with the cancel text and nothing is delivered; `refreshWake` (`:1818-1825`) and the main check (`:1870-1883`) both refresh evidence before composing the wake. | | A check that always cancels delivers no wake: the livelock of §2.1. |
| `seatTickController.ts:1822-1823`, `:1877-1878`, `:2280-2283`; `githubEvidence.ts:249-263` | When the verdict needs work sources, the tick **awaits** `defaultProposalIssues` before it delivers, which starts `gh issue list --state open` (20 s timeout) in the project's checkout; the wake is composed only after it returns, then evidence is refreshed again (`:1824`, `:1879`). | `gh` fails, the read answers `[]` after the failure; the wake waits for the subprocess to end. | The wake waits up to 20 s on every due check that needs work sources. |
| `seatTickController.ts:1860`, `:2159` and `src/lib/release/run.ts:34-50`, `:138-147` | Before gathering, the tick awaits `dependencies.release.reconcile(project)` (`reconcileRun` reads tags in Git, then `admit` calls `ports.observe`, `production.ts:150`, which reads check runs and `gh repo view` at `:111-174`). After delivery, `:2159` awaits `launchIfDue`, which calls `observe` again (`run.ts:143`). | The observation throws; the tick records `release reconcile: <error>` in its maintenance details and goes on. | `:1860` delays the wake behind every `gh` read of the observation; `:2159` sits after delivery and holds only the check's completion. |

### 1.5 Release readiness and the release lane (`src/lib/release/`)

| Where | What it does | No GitHub | GitHub down or slow |
|---|---|---|---|
| `production.ts:130-146` `requiredReleaseChecks`, `:104-108`, `:111-128` | Reads main's branch protection contexts and the check runs of main and the cut through `gh api`; a PR-only `runtime-gate` is read off the merged PR's head. | `gh repo view` (`:174`) throws; the controller's `observe` fails and every tick logs the error. | `checks: "pending"` or a thrown read → blocker 5 `checks-red`/`checks-pending` (`policy.ts:48`). |
| `policy.ts:44-46` | Blocker 3 `merge-off`: releases need the GitHub merge setting on. | Releases impossible in a project that cannot have the setting (§1.7). | |
| `stages.ts:8` publish brief | The deployer re-reads "main/cut required checks" before any tag push. | | A pending hosted check holds the tag. |
| `production.ts:21-30`, `:150-170` | Tags, ancestry, the six-hour production cut: Git and the deployment ledger already. | works | works |
| `production.ts:57-70` `changesSinceRelease` | Walks `lastTag..cut` first-parent, and **drops every subject that lacks a numeric PR marker** (`(#123)` or `Merge pull request #123`, `:65`). The change list and the change count that arms a release come from it. | A Git-only landing, which carries a `Delegatus-Landing:` trailer and no PR marker (§4.2.3 step 4), matches nothing, so landings made without a PR **never count toward a release**; a project without a forge accumulates no changes. | Same list; no `gh` here. |
| `src/lib/release/stages.ts:8-10` prepare and publish briefs | `prepare` tells the builder to read each PR title and body, "including closed batch-merged PRs", and to open the release PR titled `Release X.Y.Z`. `publish` requires `bun scripts/release-verify.ts --preflight` and, after the tag, `bun scripts/release-verify.ts --tag` | A project without a forge cannot read PR bodies or open a release PR; the lane's own publication path is the PR. | The lane waits or fails on the same reads. |
| `scripts/release-verify.ts:144-156` | After the tag it reads `gh repo view` and lists the runs of three hosted workflows (`publish.yml`, `docker-image.yml`, `macos-newcomer.yml`) for the tag's SHA, up to 90 min. | Throws at the first `gh` call. | Waits up to 90 min, then reports `publication not observed`. These are hosted *publication* workflows (npm, Docker, macOS install), distinct from required checks. |

### 1.6 Deploy and unattended updates

| Where | What it does | No GitHub | GitHub down or slow |
|---|---|---|---|
| `scripts/rebuild.sh`, `src/lib/runtime/deploymentLedger.ts`, `src/runtime-host/deployment.ts` | The deploy of this installation reads a Git revision and the host control key; no `gh` anywhere (grep over those files is empty). | works | works |
| `src/lib/selfUpdate/green.ts:1-125` `GreenReader`, `service.ts:1584` | Unattended checkout updates run three gates in order, all through `api.github.com`. (1) **A merged pull request** whose `merge_commit_sha` equals the target on the target branch (`green.ts:111-117`); none → `no-pull-request`, whatever the checks say. (2) **That pull request's head tree equals the target's tree** (`:118-121`); otherwise `untested-tree`. (3) Check runs and statuses on the head, with branch protection's required checks (`:75`). The ports are `fetch`, `treeOf` and `now` (`:7-17`); the service hands the reader a checkout path, not a lane store (`service.ts:1584`). | `availability: "not-github"` (`service.ts:420`); an operator-chosen revision on a checkout install is admitted without a green read (`service.ts:1572-1573`), a launcher upgrade skips the read (`:1682`). On a GitHub remote, a Git-only landing with no merged PR answers `no-pull-request`. | `GitHubReadError` with the rate-limit reset time; the update waits. |
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
- Board copy `src/lib/i18n/en.ts:682-685`: "Pipelines end with an open PR.", "Green checks only; a conflict waits for you.", "Needs a GitHub pull request; pipelines here end without a merge." The setting row disables itself when the project remote is not GitHub: that restriction lives only in `src/components/MergeOnReviewRow.tsx:63-89` (`noGithub` disables the switch and swaps the hint). The route (`src/app/api/projects/settings/route.ts:63`, `:82`) only declares and returns the `github` field; its PUT (`:127-133`, `:183-191`) accepts the boolean for any project, persists it and schedules a tick, so the same PUT succeeds for a non-GitHub project.

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
directory (`seat-tick/runs.ndjson.projects`, one ring per project), a read-only
`VACUUM INTO` copy of `state.sqlite` taken at about 19:57Z, the seat's own
chat with the operator, and GitHub's check-runs API read at 20:03Z. Every
count and every "none" below is bounded to records before 19:58Z on
2026-10-25: the capture time. The rings were re-read at 22:42Z for this
revision and reproduce the same per-ring totals when cut at 19:58Z; nothing
after the cut supports a conclusion about the rest of the day.

### 2.1 Seat wakes cancelled on the pull-request evidence refresh

The detail string is `SeatTickEvidenceRefreshCanceledError`'s message
(`seatTickSources.ts:2898`), journaled by `seatTickController.ts:1352-1356`
after the one in-process retry (`:1344-1350`).

| Ring | Checks, 00:00Z to 19:58Z | Cancelled | Wake rows, last wake row (before 19:58Z) |
|---|---:|---:|---|
| this project | 199 | 104 | 49, last 17:49:26Z |
| the most active other repository project | 201 | 102 | 36, last 19:43:45Z |
| a repository project with 9 wakes | 174 | 114 | 9, last 15:52:18Z |
| two plain-directory projects (`dir-…`) | 165 each | 78, 80 | none |
| `project_unresolved` | 165 | 96 | n/a |
| six more repository projects | 165 to 191 each | 90 to 108 | five rings: none; one ring (191 checks, 90 cancelled): 25, last 19:34:14Z |
| **all project rings** | **2,087** | **1,154** | |

Observed: the first cancellation on every ring is between 00:00Z and 00:32Z
(the rings start at midnight), so the condition held through the captured
window and worsened with lane churn (the seat reported 36 active lanes at
19:37Z). Cancelled checks and wake-less rings coexist with delivered wakes on
the same rings: the table shows a high cancellation rate and long gaps
between deliveries on the rings that did wake, and five rings with no wake
row in the window. A later read of this
project's ring (22:42Z) shows its wakes resuming at 21:52Z, after the
capture. Plain-directory
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

1. **A merge is a Git merge commit** of the lane's landing head (§4.2.1: the
   exact head its review judged) into the base, made by Delegatus with the
   controller identity, gated by the project's declared local checks on that
   merge commit, then fast-forward pushed to the project's Git remote or
   applied to the local base. "Landed" means `git merge-base --is-ancestor
   <landingHead> <base>` is true on the authoritative base: the remote base
   after a fetch, or `refs/heads/<base>` for a project without a remote.
   A prepared local landing that no base contains yet is not landed.
2. **"Finished" means ancestry on the authoritative base.** `finishesTask`
   moves a task to Done when the marked lane's landing head is an ancestor of
   that base (or, with the landing setting off, when the lane completes, as
   today).
3. **The seat wakes from records and Git.** The alarm path makes no forge
   subprocess and awaits no forge or release read. Forge and release facts
   reach the seat as annotations from cached observations that a background
   cycle produces, with their age.

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
  omitted `publication` already resolves to local-only when the owner delivery
  has no remote (`publication.ts:5-8`, `types.ts:1137`, `engine.ts:4758-4761`,
  `:12415`), and the review fence already honours that
  (`engine.ts:9104`). The `unavailable` parks (`engine.ts:4774`, `:5564`,
  `:11567`, `:9115`) apply only to an explicit `publication: "remote-branch"`
  and keep their wording. No change to the default.
- `publishedIntegrationGreen` (`stageAttemptPush.ts:30-123`) loses its forge
  branch: a missing creation receipt is excused only by Git evidence (the
  integration commit's parents and the local gate receipt on that exact head,
  §4.2.2), or refused as before. A hosted-green excuse comes back only as an
  adapter signal when the operator turns hosted gating on (§5.3).
- `stageProvenance.pullRequestOf` reads the forge cache instead of `gh`
  (the cache is already seeded by the sweep, `sweep.ts`); the provenance record
  keeps `pullRequest` and `pullRequestState` with the cache's `checkedAt` as
  its age.
- **The adoption fence stops asking the forge to decide.**
  `observeStageBranchProtection` (`stageBranch.ts:88-116`) refuses a foreign
  branch whenever the forge answer is missing, and today only a filesystem
  remote or a repository without a remote avoids that (§1.1). The Git and
  ownership verdict replaces it, in this order: (1) the existing ownership
  fence `stageBranchOwnershipFence` (`:135`) and the exact base, accepted and
  branch SHA checks (`:233-240`), unchanged; (2) a **published foreign branch**
  is refused: `git ls-remote --heads <remote> refs/heads/<branch>` (bounded,
  as `:111`) names it at the delivery remote and no lane in the store records
  it as its own branch or delivery target; an unpublished local branch passes
  as today (`:113`); (3) the base and default branch names keep the rule they
  have at `:98`. The forge's `protected` answer remains an adapter refusal
  signal: when GitHub answers `true`, adoption is refused as now; when the
  remote is not GitHub, `gh` is unavailable or the call times out, the answer
  is "unknown" and the Git and ownership verdict decides, with the unknown
  recorded on the observation. Protection of the base and of foreign-owned
  branches therefore comes from ownership and `ls-remote`, not from a
  forge that may not exist.

### 4.2 Landing: the Git merge

The landing executor replaces `stepLane`'s GitHub decision with Git facts,
keeps the queue, the admission rules and the record shape, and gains one write
path per remote kind and per base-protection kind.

#### 4.2.1 The landing head

`mergeEligible` (`autoMerge.ts:115-152`) admits a lane on four bars, but
`reviewedHead` (`:319-345`) answers only for the first. The executor needs one
exact SHA per bar and never the branch tip:

| The merge bar was met by | The landing head is |
|---|---|
| A passed review attempt (`:123`) | `reviewedHead(pipeline)` as today: the latest passed review's `reviewHeadSha`, `outputBaseHead` or `report.provenance.head`. |
| An explicit review acceptance (`reviewAcceptances`, `:124`) | The same three fields read from the **accepted attempt itself** (the acceptance names the stage and the attempt number). |
| A skipped review (`:123`) | No review judged a head, so the lane's own `lastPassedCommit` as recorded at completion: the last revision a stage passed, a stored SHA. |
| A budget-exhausted review whose fail-edge fix attempt passed (`:125-134`) | The same three fields read from that **fix attempt**. |

Records that predate the SHA fields keep today's terminal-head heuristic
(`:342-345`) and nothing else. If no SHA resolves, the lane is not admitted
for Git landing: the card says "no exact reviewed head recorded" and the
legacy GitHub path (adapter on) or a person decides. A resolved SHA is
accepted only when the project repository holds the object after fetching the
lane branch and `git merge-base --is-ancestor <head> <lane branch tip>`
holds, so a rewritten branch refuses instead of landing a stray commit. This
adds one admission condition (`landingHead` resolves) beside `mergeEligible`,
which stays as it is; the contract change is stated here so the reviewer of
S5 does not assume `reviewedHead` suffices.

#### 4.2.2 The local gate: how a project's checks run on the landing

The pre-push plan is this repository's own (`scripts/local-gate.ts`); other
projects do not have it. The executor therefore runs what the project
**declares**, in this order, against the exact merge commit:

1. The operator's project setting `landingGate` (an argv, set in Settings),
   if present.
2. The tracked file `.delegatus/landing.json` read from the **base tip's**
   tree (`git show <baseTip>:.delegatus/landing.json`): `{ "gate": [argv…] }`.
   Reading the base means a lane cannot weaken the gate that judges it; a
   change to the file takes effect from the next landing.
3. Neither: gate kind `none`. The landing proceeds on the review verdict, the
   receipt says `kind: "none"`, and the card says "landed without local
   checks: none declared". Turning the landing setting on is the consent for
   this, and the setting defaults to off (§4.6).

The argv is executed in a scratch worktree checked out at the merge commit
`M`, through the same heavy-command admission wrapper stage agents are handed
(CPU admission, own memory scope), with isolated `HOME`, `TMPDIR` and state
directory, under the publication budget (`src/lib/pipelines/gateBudget.ts`),
with the placeholders `{base}` (the base tip SHA), `{head}` (`M`) and
`{tree}` (`M^{tree}`) substituted and the same three exported as
`LLV_LANDING_BASE`, `LLV_LANDING_HEAD`, `LLV_LANDING_TREE`. Exit 0 is a pass.

For this repository the declaration is
`["bun", "scripts/local-gate.ts", "pre-push", "--base", "{base}"]`, and S5
changes `scripts/local-gate.ts` to accept it. Today the script cannot take an
explicit base: `main` resolves `origin/main` at `:839-849`, fetches it
(`fetchMain`) and takes only the mode and `--admitted` (`:961-964`), so a
repository with no `origin` fails base resolution and a base other than `main`
is compared against the wrong branch. The new `--base <sha>` mode: the SHA
must be a 40-hex ancestor of `HEAD` (checked); it performs **no fetch** and
reads no `origin/*` ref; touched files, touched tests' baseline, privacy
`--check-commits` and the commit range all derive from `<sha>..HEAD`; the
`LLV_GATE_PUSH_HEAD` check (`:836`) is reused to assert the checkout's `HEAD`
equals `{head}`. Without `--base` the hook behaves exactly as today. The gate's
file list for a landing is therefore exactly `git diff <baseTip> M`.

The verdict is recorded on the lane as
`landing.gate = { kind, landingHead, baseTip, mergeCommit, tree, passed, at, log }`.
A red gate blocks with the failing check's name, exactly as a red hosted
check does today; a deadline-only failure retries after 1, 5 and 15 minutes
like a publication (`publication.ts:16-33`). On this repository the plan's
privacy step runs with `--check-commits` over the landing's commits, so the
same fingerprints gate the landing as gate every push.

#### 4.2.3 Steps (one lane per repository at a time, queue order as today, `:968-1000`)

1. **Fetch** the base tip from the remote, bounded (`git fetch --no-tags
   <remote> +refs/heads/<base>:refs/remotes/<remote>/<base>`, the 10 s
   `timeout --signal=KILL` form `git.ts:1712-1715` uses). No remote: the
   pending target of §4.2.5.
2. **Already landed?** `git merge-base --is-ancestor <landingHead> <baseTip>`
   true → record `landed` (applied) with the base tip and finish (replaces the
   `MERGED`/"by outside" reads, `:371`, `:863-872`, `:925-934`).
3. **Conflict probe**: `git merge-tree --write-tree --no-messages
   --merge-base=$(git merge-base base head) <baseTip> <landingHead>` in the
   project repository (objects only, as `batchLanding.ts:29-33`). Exit 1 →
   conflict → the existing refresh lane (`autoRefresh.ts`), whose detection
   today needs GitHub's `DIRTY` (`:386`) and `BEHIND` (`:395`). `BEHIND` has
   no Git meaning for a merge commit and is dropped: a clean `merge-tree`
   lands whatever the distance, which is what the refresh lane produces
   anyway. The refresh brief's "merge current origin/<base>" becomes "merge
   the current base <remote>/<base>" or the local base.
4. **Merge commit** `M` in a scratch worktree of the project repository
   (`git worktree add --detach <scratch> <baseTip>`; `git merge --no-ff
   <landingHead>` with `controllerCommitIdentityEnv`, as `provision.ts:277`).
   The message is `<task title>` with the trailer `Delegatus-Landing: <lane
   id>` (no `(#…)` marker; the release path reads the trailer, §4.5). The
   tree equals the `merge-tree` result; assert it.
5. **Local gate on `M`** (§4.2.2), recorded as the receipt.
6. **Publish `M`.** Immediately before any write, re-verify the receipt
   against Git: `landing.gate.passed`, `mergeCommit == M`, first parent
   `== baseTip`, second parent `== landingHead`, `M^{tree} == tree`; then
   re-read the base tip once more. A different tip writes **nothing**: go to
   step 1 with the new base, which regenerates `M'` and reruns the gate; after
   N rounds the lane blocks with `mainMoving` (`mergeReasons.ts:16`). Then:
   - **Plain Git remote, or GitHub without protection**: `git push <remote>
     M:refs/heads/<base>`, a plain fast-forward push with no force. A
     non-fast-forward refusal means the base moved between the re-read and
     the push: nothing was published; go to step 1.
   - **GitHub base with required contexts**: §4.2.4.
   - **No remote**: §4.2.5.
7. **Record** `merge.landed = { base, baseTip, mergeCommit, landingHead,
   by: "git" | "forge", at, state: "applied" | "prepared" }` under the
   pipeline lock through the existing `commit` fence (`:435-450`). Only
   `applied` triggers the finish sweep (§4.3). `landing.gate` stays on the
   lane for release and update readers (§4.5, §4.7). Where the landing
   reaches a remote, `git notes --ref=delegatus/landings add -f -m <receipt
   json> M` is pushed with it so a consumer of the Git remote can read the
   receipt without the producer's state (§4.7).

#### 4.2.4 A GitHub base that requires hosted contexts (this repository)

`gh pr merge --match-head-commit <head>` (`autoMerge.ts:640-644`) cannot carry
the checked merge commit. It fences only the pull request's head, so after the
gate checked `merge(B, H)` and main advanced to `B2`, GitHub would publish
`merge(B2, H)`, a tree the gate never saw. It also refuses once the PR branch
advanced to `H2`, because the head it names is no longer the PR's head. The
design therefore never asks GitHub to make the merge. It asks GitHub to
**check the commit Delegatus already made**, then pushes that exact commit.

GitHub's branch protection with required status checks admits a push to the
protected branch only for a commit on which the required contexts already
succeeded (GitHub documents this as "commits must first be pushed to another
branch ... after all required status checks have passed"). On this
repository (no required reviews, no push restrictions, `enforce_admins: true`,
`strict: false`) that is the only gate on a direct push. So:

1. Push `M` to a **new candidate branch** `delegatus/land/<lane>-<M12>`. The
   name carries the SHA; it is never an existing lane branch, never reused and
   never force-pushed. The lane's own mirror PR and branch are untouched, so a
   PR branch that advanced to `H2` after review is irrelevant.
2. Open a pull request with that branch as head, as the App (the covered
   write kind, `appWrite.ts`). Its `pull_request` and `pull_request_target`
   events attach the contexts to **`M`'s SHA** (§5.3 lists the triggers).
3. Wait, bounded (90 min, as `:48`), for the required contexts on `M` through
   adapter reads. A red names the check as today; a result computed against a
   merge ref of an older main still attaches to `M`, and the rerun attaches
   to `M` too.
4. Re-verify (step 6) and `git push <remote> M:refs/heads/<base>` as the App,
   a plain fast-forward push. GitHub accepts it only if the contexts are green
   on `M`; the fast-forward rule refuses it if main moved. Either refusal
   writes nothing: delete the candidate branch, return to step 1 with the new
   base, and the candidate for `M'` is a new branch.
5. The mirror PR of the lane and the candidate PR close by themselves when
   their heads become reachable from the base; the adapter closes any that do
   not, with a comment linking the landing. Neither is read to decide
   anything. Commits the mirror branch gained beyond `landingHead` are
   reported on the card as "N commits not reviewed, not landed".

Cost: the hosted workflows run a second time on `M`, as they run on any PR;
on this repository that is the privacy, tracker, typecheck and runtime
contexts of §5.3. **Not verified:** that the contexts attach to a candidate
PR opened by the App, and that the App's fast-forward push of `M` is
accepted under `enforce_admins`. S5's first step proves both, plus the
refusal of a non-fast-forward push, on this repository with a no-op candidate
(§6). If the push is refused for a green `M`, the design falls back to
Q2 (b), which needs the operator's decision, and S5 does not ship for this
repository.

#### 4.2.5 A project without any remote: prepared and applied

The base is a local branch, usually checked out in the operator's working
copy. `refs/heads/<base>` of the project repository is the authority. Two
states keep an unapplied landing from being mistaken for a finished one:

- **applied**: the base branch contains `M`.
- **prepared**: `M` is in `refs/delegatus/landed/<base>` (the **pending
  ref**) and the base does not contain it yet.

Per landing, serialized per repository:

1. **Target.** If the pending ref exists and `refs/heads/<base>` is its
   ancestor, the target is the pending ref (prepared landings stack: each new
   `M` has the previous one as an ancestor). A pending ref that does not
   descend from the base (the operator moved the base somewhere else) is
   stale: every lane whose `merge.landed.state` is `prepared` and whose `M` is
   in that chain returns to the queue with the reason "base moved; landing
   redone", and the ref is deleted with a compare-and-swap on its old value.
   Otherwise the target is `refs/heads/<base>`.
2. Steps 2 to 5 of §4.2.3 run with `baseTip := target`, so the second lane's
   `M2` contains the first lane's `M1` and its gate runs on the combined tree.
3. **Apply** when safe: base not checked out in any worktree →
   `git update-ref refs/heads/<base> M <old>` (compare-and-swap); base
   checked out in a clean worktree at the old tip → `git -C <worktree> merge
   --ff-only M` (the `finishMerge` preconditions, `provision.ts:255-263`);
   either way the result is `applied` and the pending ref is deleted.
   Otherwise → `git update-ref refs/delegatus/landed/<base> M <old pending>`
   and `merge.landed.state = "prepared"`; the card shows "prepared; your
   checkout of <base> is dirty or not at its last tip, run `git merge
   --ff-only refs/delegatus/landed/<base>`".
4. A `prepared` landing finishes nothing, writes no `merged` state and makes
   no Done candidate. The runner's ancestry sweep (record and Git only) turns
   a `prepared` landing into `applied` the moment `landingHead` is an ancestor
   of `refs/heads/<base>`, which finishes every lane of the stack once the
   operator applies the pending ref.

#### 4.2.6 The seat's batch merger

`scripts/merge-batch.ts` keeps `build` and `gate`; `land` gains the Git push
path of step 6 for remotes without protection and the candidate-branch path of
§4.2.4 for protected ones, and keeps `gh pr merge --rebase
--match-head-commit` only as an explicit forge mode. The App principal check
(`:455-471`) applies only to the forge path.

#### What this removes

`headChanged` (`:376`): the landing merges the exact landing head and never
reads the lane PR's head, so later pushes to the lane branch cannot block it.
`noChecks`, `checksTimeout`, `draft`, `closed`, `changesRequested`,
`reviewRequired`, `protection`, `unreachable` (`mergeReasons.ts:10-21`) stop
being landing reasons; the first two are replaced by the gate's own verdicts
and the hosted wait of §4.2.4, the others become adapter signals (§5.2) and,
where the write channel is a push the forge refuses, refusals in GitHub's
words (`MERGE_REASON_PATTERNS.refusedMerge`, kept).

**Method.** A merge commit is the Git-only default because it keeps the
landing head's SHA in history, which is what makes "landed" provable by
ancestry. Squash and rebase rewrite the SHA; proving a landing then needs
`patchPresent` (`batchLanding.ts:12-54`), which exists and is slower. §7 Q1.

### 4.3 Completion from ancestry

- `laneFinishedForTasks` (`autoMerge.ts:1123-1132`): with the landing setting
  on, finished means `merge.landed.state === "applied"`, or a bounded ancestry
  read of the authoritative base shows `landingHead` landed (covers landings
  made by hand or by the operator's own `git merge`). A `prepared` record, a
  pending ref and a pushed candidate branch are all unfinished. The forge cache
  is no longer consulted. `laneNeedsNoPr` keeps its three Git-only rules (no
  commits, read-only outputs, published prototype) under a new name,
  `laneNeedsNoLanding`; the setting-off rule (`:1126`) is unchanged.
- `sweepTaskFinishes` (`:1150-1203`) and the archive hold (`store.ts:2170`)
  are unchanged.
- The Done section (`done/candidates.ts`) keeps its two existing classes (a
  forge "landed" class from merged PRs and a pipeline candidate for a finished
  lane that names no PR, merge record or PR link, `:207-218`) and adds a
  "landed" class from `merge.landed` applied. A lane that gains a merge record
  leaves the pipeline class by the existing `:213` rule, so it appears once.
- Worktree sweep and reaper: `mergedPullRequests` (`worktreeSweep.ts:269-271`)
  gets a Git-first implementation (landing head ancestor of the fetched or
  local base) with the forge read as a fallback for lanes whose records
  predate `merge.landed`; `reaperRuntime.ts` already has `localBranchMerged`.

### 4.4 The seat tick without a forge subprocess

- `unmergedPullRequests` becomes `unlandedLanes`: finished lanes of the project
  whose `merge` record is not applied, read from the hot store and archive the
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
- **No forge or release read is awaited on the alarm path, and this ships in
  the same slice (S1).** The tick has three more awaits on forge-bound work
  (§1.4), and each moves out:
  - *Proposal issues* (`:1823`, `:1878`, `:2280-2283`): a per-repository cache
    of open issues (number, title, labels, `updatedAt`, `checkedAt`) is
    refreshed by the forge sweep (`sweep.ts` cadence), with its own 20 s
    `gh issue list` timeout, never by the tick. The tick reads the cache,
    labels it with its age and takes `[]` when there is none.
  - *Release reconcile and `launchIfDue`* (`:1860`, `:2159`): both move to the
    release controller's own cycle, started fire-and-forget beside the merge
    runner in the pipeline controller cycle, serialized per project as
    `run.ts` already serializes them. The tick composes the seat's words from
    the persisted release row (`readReleaseProject`: `observation`,
    `blocked`, `live`), never from a fresh `observe`.
  - *Hosted facts the seat still wants* (PR number and URL, a hosted red as a
    hint) come from the forge cache with `checkedAt`, attached to the item,
    never gating it.
- Acceptance for S1: with every forge reader unavailable (a `gh` stub that
  exits 1) and again with every forge reader left pending (a stub that never
  returns), a due wake completes from local records and is delivered, and a
  spy on the subprocess runner counts **zero** `gh` calls during gather, refresh and delivery; a `launchIfDue` whose `observe`
  never returns does not delay the check's journal record.
- Lane 37c26247 (opened 2026-10-25 19:44Z) is fixing the livelock inside the
  current design (deliver with the evidence it has, or cap cancels). This
  slice supersedes that fix's PR-key machinery; the lane's reproduction test
  (churn on every refresh still yields a wake) is an acceptance test here.

### 4.5 Release readiness from landings and the ledger

- Blocker 5 (`policy.ts:48`) reads **landing receipts**: every first-parent
  commit in `lastTag..cut` that is a Delegatus landing (it carries the
  `Delegatus-Landing:` trailer and a `refs/notes/delegatus/landings` receipt)
  has `passed`; a commit on main that no receipt covers (a hand push) is
  `unknown` and the release asks the seat, as the deployer brief already does
  for an unverified premise. Hosted check runs are read only when the adapter
  is on and hosted gating is chosen (§5.3), and the `gh repo view` at
  `production.ts:174` goes.
- **The change list counts landings.** `changesSinceRelease`
  (`production.ts:57-70`) drops every first-parent subject without a numeric PR
  marker (`:65`), so a landing without a PR would never count toward a release
  and a project without a forge would never reach the change threshold. A
  first-parent commit counts when its subject carries the PR marker (today's
  rule, kept) **or** its message carries the `Delegatus-Landing:` trailer
  (read with `git log --format=%H%x00%s%x00%(trailers:key=Delegatus-Landing,valueonly)`).
  The change record gains the lane id; the changelog input for a landing
  without a PR is the lane's stored final report, the text the PR body was
  always a copy of.
- **The release lane's own steps** (`stages.ts:8-10`). `prepare` reads each PR
  title and body where a PR exists and the lane's stored report where it does
  not, and "opens the release PR" becomes "publishes the release branch for
  landing; a pull request is opened where a forge adapter exists". The release
  commit lands through the executor like any lane. `publish` keeps
  `release-verify.ts --preflight`, which is Git (tag, versions, ancestry).
- **Hosted publication verification is optional on the Git path.**
  `release-verify.ts:144-156` (`gh repo view`, three hosted workflows for the
  tag's SHA, up to 90 min) verifies that npm, Docker and the macOS install
  published; these workflows are this repository's release *channel*, not a
  gate on landing. The verifier takes `--forge off`: with no GitHub remote or
  an unavailable `gh` it skips the workflow reads, prints `publication not
  observed (no forge)` and exits with a distinct status the lane records as
  "tag pushed, publication unverified"; the tag push itself is Git and is
  never held by GitHub. On this repository the default stays "required", so
  a GitHub outage parks the lane after the tag, with the cause, never before
  it.
- Blocker 3 `merge-off` (`policy.ts:46`) reads the landing setting (§4.6).
  Everything else in `releaseState` is already Git and ledger.
- Acceptance: a project with only no-PR landings in `lastTag..cut` reaches
  the change threshold; with `gh` stubbed to fail, the release lane reaches
  the tag push and records "publication unverified" instead of failing.

### 4.6 The setting

`mergeOnReview` (`src/lib/projects/settings.ts:177-182`, `:262`) keeps its key
and its storage and changes meaning and words: **"Land when the review
passes"**. Off: a completed, review-eligible lane keeps its branch published
(and mirrored, where a forge exists) and the seat is told it is ready; nobody
lands it automatically. On: the landing executor lands it. `retry-merge`
(`engine.ts:14702`) keeps working as "retry the landing". The only
GitHub-only restriction is in the **UI**: `MergeOnReviewRow.tsx:63-89`
(`noGithub`) disables the switch for a project whose remote is not GitHub.
The settings route has no such check (§1.9): its PUT already admits the
boolean for any project, so S6 removes the UI restriction and adds no server
change; a test pins the existing behavior (the same PUT succeeds for a
non-GitHub project). The row is then available to every project with a Git
repository, and a plain directory (no repository) shows "this folder has no
repository yet; the first pipeline creates one" (`docs/pipelines.md:12-15`
already initializes one).

### 4.7 Deploy and unattended updates

The deploy is already Git. `GreenReader` (`green.ts`) today answers
`no-pull-request` without a merged PR whose `merge_commit_sha` is the target
(`:111-117`) and `untested-tree` unless that PR's head tree equals the
target's tree (`:118-121`), and only then reads check runs (§1.6). Both gates
bind the target to a PR a Git-only landing never has. The replacement reads
the **landing receipt from Git**, because an installation is a fresh checkout
on another machine with Git access to the remote and no producer state:

- **Source.** The receipt is the note `refs/notes/delegatus/landings` on the
  landing commit (§4.2.3 step 7), fetched with the target (bounded, one
  extra refspec). The reader gains a `receipt(repo, target)` port beside
  `fetch`, `treeOf` and `now` (`green.ts:7-17`); the service hands it the
  checkout, as it hands `treeOf` today (`service.ts:1584`).
- **Accept** when: a note exists for exactly the target commit; its `tree`
  equals `target^{tree}` (the `untested-tree` check, now from Git); its gate
  `kind` is a declared gate (not `none`) and `passed` is true; and its `at` is
  within 14 days. The age bound exists because the gate's definition can have
  changed since.
- **Missing or expired** receipt → a new verdict `no-receipt` (shown where
  `no-pull-request` is shown). It never reads as green. On a GitHub remote the
  reader then falls through to today's three PR gates (merged PR, tree
  match, check runs) as the adapter path, so a repository that has both keeps
  every guarantee it has. Without GitHub the unattended update waits, and the
  operator-chosen revision path (`service.ts:1572-1573`) keeps admitting an
  explicit choice.
- **Trust.** A note is writable by whoever can push to the remote, as a
  commit is, so a receipt carries the trust of the commit it names, no more.
  The consumer's own apply-time verification is unchanged. Signed receipts
  are deferred (§8).
- **Compatibility across slices.** The receipt reader and the receipt format
  ship before the executor (§6: S4 before S5), and with no note on any commit
  it behaves exactly as today. Until the executor lands a commit that has a
  note, nothing changes for a consumer. After, a landing with its note is
  judged by the note; a commit without one (a hand push, an older landing) falls
  to the PR gates on a GitHub remote as today, and answers `no-receipt`
  elsewhere.

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
  landThroughCandidate(lane, mergeCommit): Promise<WriteOutcome>; // §4.2.4: candidate branch + PR for the checks, then the fast-forward push, as the App
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
| Ready to land | `mergeEligible`, a resolved landing head and a passed (or `none`) gate receipt on the merge commit | the hosted checks on the head and the PR's `reviewDecision`, shown on the card with their age; a human "changes requested" on GitHub is a **signal** the seat reads, never a block, unless §5.3 |
| Landed | landing head is an ancestor of the authoritative base | GitHub marks the PR merged by itself when its head becomes reachable from the base; the adapter closes it with a comment otherwise. With a protected base the candidate PR carries the hosted checks for the exact merge commit and the landing is a fast-forward push of it (§4.2.4) |
| Finished | `merge.landed` applied and no open lane on the task | the PR chip reads "merged" |
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
required reviews; no restrictions; no rulesets. The four contexts run on
these events (read from the workflow files on `b027e190d`):

| Required context (workflow) | `push` to main | PR event | `workflow_dispatch` |
|---|---|---|---|
| `privacy-publication` (`privacy-publication.yml:6-15`) | yes | `pull_request_target` opened, synchronize, reopened | yes |
| `privacy-tracker-audit` (`privacy-tracker-audit.yml:6-18`) | yes | `pull_request_target` opened, edited, synchronize, reopened; also issue, comment and review events | yes |
| `typecheck` (`memory-selection.yml:3-7`) | yes | `pull_request` to main | no |
| `runtime-gate` (`bun-runtime.yml:29-31`, job at `:341`) | **no** | `pull_request` | yes |

Read carefully, the constraint is this. A merge commit created locally and
pushed straight to main has no context on it at push time; protection refuses
it, and the `push: main` runs of three workflows would only start after an
accepted push, and `runtime-gate` never runs on a push at all. A commit that
already carries the four successes is accepted by a plain push. The
workflows differ in how they can be pointed at a candidate commit without it
being on main: `typecheck` has no dispatch and needs a PR event or a push to
main; `privacy-publication` and `runtime-gate` can be dispatched (a dispatched
privacy run inspects `github.sha`, the commit its own check lands on,
`privacy-publication.yml:9-14`); `privacy-tracker-audit` can be dispatched
too. A pull request whose head is the candidate is therefore the one
mechanism that attaches all four contexts to that exact SHA with no workflow
change. The pull request is a **check carrier**, not the write channel: the
write is the fast-forward push of the checked commit (§4.2.4). Two ways to
keep "Git decides" true here:

- **A (recommended):** keep protection; the executor uses the candidate branch
  and PR of §4.2.4 and fast-forwards main to the exact checked merge commit;
  the local gate runs first and a local red stops the landing before GitHub is
  asked; a hosted red is then a real block reported in GitHub's words. The
  public privacy-publication check keeps its full force on every candidate and
  on main. Cost: the hosted workflows run once more per landing, and the
  design rests on the unverified push acceptance named in §4.2.4.
- **B:** relax protection to "no required contexts" and push merge commits
  directly; `privacy-publication`, `privacy-tracker-audit` and `typecheck`
  already run on `push: main` as post-landing signals, and `runtime-gate` would
  need a `push` trigger to run at all. The public repository would then
  publish a landing before the hosted privacy check saw it; the local privacy
  gate with the same fingerprints ran, but a skipped hook
  (`LLV_SKIP_HOOKS=1`) would have no backstop. §7 Q2.

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
| S1 | **Tick wakes without any forge or release wait** | `unlandedLanes` from records; delete the PR evidence key, second refresh and cancel error; drop the PR list from the fingerprint. Proposal issues come from a sweep-fed cache; release `reconcile` and `launchIfDue` move to the release controller's own cycle and the tick reads the persisted release row (§4.4). Rename `unmerged-pr` → `unlanded-lane` with a reader for stored `lastWakeReasons`. | Duplicate or lost wake; a release that stops reconciling. Controls: the delivery dedupe already in the controller; tests `seatTickSources.test.ts` churn case (from lane 37c26247's reproduction), "real source failure still surfaces" becomes "blocked landing still surfaces", restart mid-tick; a release-cycle test that reconcile still settles a live run without the tick; the S1 acceptance of §4.4 (zero `gh` calls with every reader failing or pending). | Ends §2.1 for all 10 seats and removes the 20 s issue read and the release observation from the wake. Supersedes the PR-key part of lane 37c26247; coordinate before both land. |
| S2 | **Stage publication advisory, with merge admission and adoption** | `ensureStagePullRequest` moves behind the adapter queue; the four call sites advance first; non-GitHub remotes record "no forge" and continue; `publishedIntegrationGreen` Git-only; `stageProvenance` reads the cache. **Admission:** a completed lane whose mirror is not yet open is admitted to the existing GitHub merger as `queued` with the card line "mirror pending", not blocked `noPr`; and a record blocked `noPr` is requeued (to the state `newMerge` gives, `autoMerge.ts:262-263`) as soon as `pullRequestOf` finds the PR, with the recovery added beside `:917-934`. **Adoption:** the Git and ownership fence of §4.1 replaces the forge protection read. | A lane completes with a PR body one head behind; a requeue loop; an adoption that admits a foreign branch. Controls: the sweep retries the mirror; the card shows "mirror pending"; the requeue fires once per PR appearance and never for a record blocked by a different reason. Tests: `stagePullRequest.test.ts` cases flip from park to recorded outcome; non-GitHub remote passes; **delay the first mirror until after the completion sweep, then create it: the existing GitHub merger resumes with no `retry-merge` and without waiting for S5**; adoption of a foreign branch under a non-GitHub HTTPS origin and with `gh` unavailable (refused when published and foreign-owned, admitted when owned or unpublished). | Lanes stop parking on a `gh` hiccup at pass. PR bodies may lag by one sweep (3 min). |
| S3 | **Landing record and completion from ancestry** | `merge.landed` with `applied` and `prepared`; `laneFinishedForTasks`, Done candidates, worktree sweep, reaper read the record or ancestry on the authoritative base; forge cache becomes a fallback for old records. | A task finishing on a hand merge the operator did not mean as a landing; an unapplied landing treated as done. Control: ancestry of the **landing head** only, on the authoritative base only; `prepared` finishes nothing; a `--force` rewrite of main is out of scope. Tests: `forge/taskFinish.test.ts`, `worktreeSweep.test.ts`; a record with `prepared` and a base that lacks the head keeps the task open; Done keeps both existing classes (§4.3). | Tasks finish when main contains the landing head, even if GitHub's PR state is stale. |
| S4 | **Receipts and their readers: release and update** | The `landing.gate` record shape and the note `refs/notes/delegatus/landings` (readers only; nothing writes yet). Release: blocker 5 from receipts, blocker 3 from the setting, `changesSinceRelease` counting the `Delegatus-Landing:` trailer, release briefs without a PR requirement, `release-verify.ts --forge off` (§4.5). Update: `GreenReader` `receipt` port and the `no-receipt` verdict, with today's PR gates as the fall-through on a GitHub remote (§4.7). | A release cut containing an unreceipted hand push; an update admitted on a note that is not the target's. Control: `unknown` asks the seat; a note is accepted only for the exact target with a matching tree, a declared gate and an age under 14 days. Tests: `release/production.test.ts` (no-PR landing counts; `gh` stubbed to fail reaches the tag push), `selfUpdate` green tests (fresh consumer with Git access, no GitHub, no producer state: takes the safe path with a note and `no-receipt` without; PR gates unchanged when no note exists). Ships **before** S5 so a landing never meets a reader that cannot judge it. | None visible until S5: with no note anywhere, both readers behave as today. |
| S5 | **Git landing executor** | §4.2.1 to §4.2.6: landing head per bar, declared gate, steps 1 to 7, the protected-base candidate protocol, prepared and applied for projects without a remote; `scripts/local-gate.ts` gains `--base <sha>`; `headChanged` and the GitHub-only reasons retired; `merge-batch.ts land` Git path. **First step:** on this repository, with a no-op candidate, prove that the four contexts attach to a candidate PR opened by the App, that the App's fast-forward push of that SHA is accepted under `enforce_admins`, and that a non-fast-forward push is refused. Needs §7 Q1 to Q4. | Highest. A landing that bypasses a gate, a base that moves between check and write, a scratch worktree leak, gate time per landing. Controls: the landing refuses unless the receipt names the exact merge commit, parents and tree (break the receipt, move the base after the gate, advance the PR head after review, each in a test, and watch it refuse or regenerate before any write); worktrees under the lane artifacts dir with the existing sweep; measure gate time on ten real landings before enabling by default (the pre-push plan on a small change took 25 min under load on 2026-10-12, `docs/design/checks-under-five-minutes.md` §2.2; the after-times of that work decide whether a landing gate fits). Acceptance cases: a project with no Delegatus scripts (kind `none` and a declared argv), a local-only repository (no `origin`, `--base` never fetches), a base other than `main`, and the gate's file list equal to `git diff <baseTip> M`; dirty checkout with two completed lanes (neither task finishes early, both prepared results survive in the stack, applying the ref finishes both). Three review rounds, as for the merge runner. | With A in §5.3: landings still reach main through the candidate PR's checks and a fast-forward push of the checked commit; `headChanged` blocks disappear; red hosted checks on the candidate still block (protection). |
| S6 | **Setting, copy, prompts, docs** | "Land when the review passes" everywhere in §1.9; remove the UI-only GitHub guard on the row (`MergeOnReviewRow.tsx:63-89`; the route already admits the PUT, §4.6); `hostedChecksGate` row beside it; `docs/pipelines.md`, `docs/merge-batch.md`, `AGENTS.md` lines on merging. | Text and one UI condition. Test: the same valid PUT succeeds for a non-GitHub project, and the row renders enabled for one. | Board row enabled for every repository project. |
| S7 | **Retire GitHub-only leftovers** | Batch-landing receipts via issue comments → `patchPresent` on the base (Git already does the proof, `batchLanding.ts:12-54`); forge cache `landedPullRequests` kept for history only; `forgeRename` unchanged (optional by construction). | Low. | None visible. |

Order: S1 → S2 → S3 are independent of the questions and of each other in
code (S1 touches `monitor` and `release`, S2 `pipelines` and the merge
admission, S3 `forge/autoMerge` finish half and `done`). S4 follows S3 (it
reads the record S3 defines) and ships before S5 (so the readers exist before
the first landing that needs them). S5 follows S3 and S4 and the answers.
S6 follows S5. S7 any time after S3.

Fences for whoever builds: lane 37c26247 (seat tick) and lane 7928afbc (Cloud
86 and 87, `autoMerge.ts`, `autoRefresh.test.ts`, `seatAgenda.ts`,
`mergeSuccessor.ts`) are open on 2026-10-25 and change the same files as S1
and S5; read their diffs first (rule 8). Main moved after this document was
written (head `9b6108030`, 163 files); `git diff --stat b027e190d 9b6108030`
over the forge, pipeline engine and stage-branch files, the release and
self-update files, the seat-tick monitor, `scripts/local-gate.ts`,
`scripts/release-verify.ts`, the workflows, the Done candidates and the
settings components shows no change to the cited implementation (only the
create route and two route tests under `src/app/api/projects` moved).

## 7. Questions only the operator can answer

Each with options and one recommendation. They change S5 and later; S1 to S4
need none of them.

**Q1. How does a lane land?**
(a) **Merge commit of the landing head** (recommended): provable by
ancestry, GitHub marks the mirrored PR merged on its own, `headChanged`
cannot happen, history keeps one commit per review round. (b) Squash, as
GitHub does today (`autoMerge.ts:225` prefers squash when allowed): one
commit per lane on main, but landing proof needs `patchPresent` and the
mirrored PR needs an explicit close. (c) Rebase: rewrites every lane commit;
same costs as squash.

**Q2. This public repository: keep branch protection?**
(a) **Keep it** (recommended): a candidate pull request carries the four
hosted contexts onto the exact merge commit the local gate checked, and main
is fast-forwarded to that commit; hosted privacy-publication keeps enforcing
every candidate and main; a hosted red still blocks here, by protection,
whatever the project switch says. It costs one more hosted run per landing and
rests on a push acceptance that S5's first step verifies; if that fails, only
(b) remains. (b) Relax protection and push merge commits directly with the
local gate as the only gate; privacy, tracker and typecheck already run on
`push: main` as post-landing signals, `runtime-gate` needs a `push` trigger
(`bun-runtime.yml:29-31` has only `pull_request` and dispatch); accept that a
skipped hook has no hosted backstop.

**Q3. A project with no remote: where does the landing go?**
(a) **Apply it to the local base when that is safe (base not checked out, or
checked out clean at its last tip); otherwise prepare it in
`refs/delegatus/landed/<base>` and say so on the card; a prepared landing
finishes nothing until the base contains it** (recommended). (b) Always write the ref and never touch the checkout; the
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
- Signed landing receipts (§4.7 trust note) and a consumer that runs the
  declared gate itself instead of reading a receipt.
- Reusing a green hosted run from the lane's own PR for the candidate when the
  trees are equal; the candidate re-runs the hosted workflows once.
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
| A completed lane resumes merging once its mirror exists | the first mirror created only after the completion sweep | S2 admission and requeue beside `autoMerge.ts:917-934` | the lane is `queued`, then merges with no `retry-merge` |
| A due wake needs no forge read | every forge reader a stub that exits 1, and again a stub that never returns; release `observe` pending | S1: alarm reads caches and the persisted release row | wake delivered; subprocess spy counts zero `gh` calls during gather, refresh and delivery |
| A tick completes under churn | a source that mutates a lane on every `pipelines()` read | S1's single-read refresh | one wake delivered within the interval; `verdict: "error"` count 0 in the journal ring |
| Adoption stays fenced without a forge | foreign published branch under a non-GitHub HTTPS origin; `gh` unavailable | S2 Git and ownership fence (`ls-remote`, ownership) | published foreign-owned branch refused; owned or unpublished branch admitted; unknown protection recorded |
| Nothing lands red or untested | a merge commit whose gate receipt names a different SHA, parent or tree | executor step 6 re-verifies the receipt against Git before any write | `merge.state: "blocked"`, reason names the missing receipt; a test breaks the receipt after step 5 and asserts the refusal |
| Nothing lands over a moved base | the base advanced after the gate and before the write | step 6 re-read of the base tip and a plain fast-forward push | no write happens before regeneration; the executor rebuilds `M'` and reruns the gate; after N rounds `mainMoving` |
| The checked tree is the published tree on the protected channel | main advanced to `B2` between gate and push, with the PR branch unchanged | candidate push of `M` as a fast-forward | push refused; candidate branch deleted; new `M'` gated again; GitHub never makes `merge(B2, H)` |
| An advanced PR head does not strand a landing | the lane's PR branch advanced to `H2` after review | the landing never reads the PR head; it lands `landingHead` | landed; the card reports the commits beyond the landing head as not reviewed |
| The gate runs the project's own checks on the exact diff | a project with no Delegatus scripts; a repository with no `origin`; base `release/x` | §4.2.2 declaration and `--base <sha>` | the gate's file list equals `git diff <baseTip> M`; kind `none` is recorded for an undeclared project |
| Every merge bar has an exact head | lanes whose review passed, was accepted, was skipped, or exhausted its budget with a passed fix | `landingHead` (§4.2.1) | each yields its own SHA; none resolves to the branch tip; unresolved → not admitted with the stated reason |
| An unapplied local landing finishes nothing | dirty checkout; two completed lanes | prepared/applied states, pending-ref stack | neither task finishes early; both prepared results survive; applying the ref finishes both by ancestry |
| A task finishes only on the landing head | a branch force-pushed to a different tip after review | `merge-base --is-ancestor <landingHead>` on the authoritative base | the task stays open; the lane shows the unlanded landing head |
| Releases count landings and survive a forge outage | only no-PR landings in `lastTag..cut`; `gh` failing | `changesSinceRelease` trailer rule; `release-verify.ts --forge off` | change count reaches the threshold; the lane reaches the tag push and records "publication unverified" |
| An update needs evidence for the exact target | a fresh consumer with Git access, no GitHub, no producer state; a note for another commit; a note older than 14 days | `GreenReader` receipt port | note for the target with matching tree and declared passed gate: allowed; otherwise `no-receipt`, never green |
| The App never falls back to a person | the App helper absent | `forge-app-token.mjs` refusal, unchanged | mirror withheld, candidate PR and the protected push refused with the App's words; the plain Git push channel unaffected |
| Hosted gate off means a hosted red does not block | a red check run on the head, switch off, unprotected base | landing executor | landed; the card and the wake carry the red as a signal |
| The merge setting is not guarded server-side | the same PUT for a non-GitHub project | settings route (`route.ts:127-133`, `:183-191`) | accepted and persisted; only the UI row was disabled before S6 |

## 10. Evidence register

| Item | How it was read | When |
|---|---|---|
| Line anchors | `grep`, `sed -n` on the worktree at `b027e190d`; `git fetch origin main` confirmed main unchanged then; re-checked at 22:40Z the same evening against `9b6108030` with `git diff --stat` over the cited files (§6 fences) | 2026-10-25 19:00Z to 20:00Z; 22:40Z |
| Seat-tick journal counts | `grep -c` over the per-project rings (`seat-tick/runs.ndjson.projects`) in the live state directory, read-only; per-project verdict summary with a short Python script. Re-read for the revision with a script that cut each ring at 19:58Z on 2026-10-25: 2,087 checks (12 rings with a project key), 1,154 cancelled, matching the capture; the per-ring wake rows of §2.1 come from this re-read. The global ring is not used: it keeps only the last 500 records | captured about 19:58Z; re-read 22:42Z the same day (machine clock) |
| Lane counts, publication modes, blocked merge records | `VACUUM INTO` a scratch copy of `state.sqlite` with `bun:sqlite` read-only; one script over `state_rows` for `pipelines` and `pipelines_archive` | about 19:57Z |
| PR 3318 check runs | `gh api repos/<this repository>/commits/<sha>/check-runs?filter=all` for `aa810de5` and `88a8cf63` | 20:03Z |
| Branch protection | `gh api repos/<this repository>/branches/main/protection`; `rules/branches/main` answered `[]` | 20:00Z |
| Open PR merge states | `gh pr list --state open --limit 100 --json mergeStateStatus` | 19:59Z |
| The operator's words, the seat's reports, the issue refusal | the seat conversation's messages of 19:28Z to 19:42Z through `conversation_messages` | |
| Cloud result 86's cause | lane 7928afbc's pinned specification (18:14Z) | |
| Prior designs read | `merge-policy-and-task-finishing.md`, `auto-refresh-conflicting-prs.md`, `auto-release.md`, `issue-report-approval.md`, `cloud-checks.md`, `checks-under-five-minutes.md`, `pr-issue-chips.md`, `retire-flows.md`; `search_transcripts` found no earlier design for a Git-only path; `search_memory` found nothing | |

Not verified: the "stale merge ref" cause of the red hosted checks (§2.2); the
after-time of the pre-push plan since 2026-10-12, which decides whether a
landing gate fits in minutes (S5's measurement step); that the four hosted
contexts attach to a candidate PR opened by the App and that the App's
fast-forward push of that SHA is accepted under `enforce_admins` (§4.2.4,
S5's first step); that a pull request whose head is pushed to the base shows
as merged with a usable `merge_commit_sha` (the adapter closes it by comment
when it does not). The `gh pr merge` manual documents `--match-head-commit`
as a head-only fence; the claim about GitHub's branch protection and direct
pushes is from GitHub's documentation of required status checks, not from a
probe of this repository.
