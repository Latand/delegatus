# Merge queue: a finished refresh releases its slot, and a trivial base update needs no agent lane

Design, 2026-10-31. Architect stage of the lane for the task «Merge queue
refresh capacity: a parked refresh releases its slot and ready PRs behind base
do not wait in single file». It builds on
`docs/design/auto-refresh-conflicting-prs.md`,
`docs/design/merge-policy-and-task-finishing.md` §4.4 and #3439
(d291ebc3).

## 0. Originating requirement

The operator, task text, 2026-10-27, verbatim:

> «Слот має звільнятися, щойно оновлення з main завершено, або черга має
> пропускати PR, яким оновлення не потрібне.»

(In English: "The slot must be released as soon as the update from main is
finished, or the queue must let through the PRs that need no update.")

Standing instruction of 2026-10-19: «усі баги й недороблене — завести й
лагодити» ("file and fix every bug and every unfinished piece").

The pinned acceptance, condensed:

1. A refresh lane that is parked (needs_decision, paused, settlement-parked)
   or whose refresh stage has published releases the repository refresh slot,
   proved by a test of the 2026-10-30 shape that is red on the current head.
2. Ready PRs that are only behind base do not wait in single file: the
   architect chooses between a bounded number of concurrent refreshes and one
   batched merger train. A trivial behind-base update (no conflict, required
   checks green after the update) never needs a full agent lane.
3. No GitHub update-branch; merges are made as the Delegatus machine identity.
4. The project's own checks for the touched files, in isolated state.

Fences: engine.ts settlement and retry paths (lane 6200c748), Cloud stage
errors (d6d56949) and project settings (6cab9677) belong to other lanes. This
design keeps to the merge queue modules and their tests.

## 1. Answer in brief

**Confirmed cause.** A refresh lane in `needs_decision` or `paused` already
releases the slot (`src/lib/forge/autoMerge.ts:969`). What held the slot on
2026-10-30, and again on 2026-10-31, is the phase between the refresh agent's
pass and the cursor leaving the `refresh` stage. `holdsRefreshCapacity`
(`src/lib/forge/autoMerge.ts:964-975`) counts a lane as a holder while it is
`running` with its cursor at `refresh/committing` and the refresh attempt
`passed` or `skipped` (lines 973-974), and also while the attempt itself is
`committing` (line 973), which the engine sets only after a pass verdict
(`src/lib/pipelines/engine.ts:6010-6020`). That phase is passed-stage
settlement and publication. Its length depends on controller jobs and the
publication gate, which every lane on the machine shares:
`parkUnadmittedStageSettlement` (`src/lib/pipelines/engine.ts:12795-12840`)
keeps the lane `running`, cursor `committing`, attempt `passed` for a
15-minute admission window and, since 8878f49d (2026-10-31 03:18Z), three
automatic retries (+1, +5, +15 minutes, each followed by another window). Its
detail line, «no controller job became available for passed-stage settlement
within 15 minutes; automatic retry N/3», reads like a park while the lane
still holds the slot. When the lane finally parks (`park`,
`src/lib/pipelines/engine.ts:2951-2982`, state `needs_decision`) it releases
the slot, and every `retry-stage` or `publish` on it
(`src/lib/pipelines/engine.ts:16404-16422` and `:15693-15705`: attempt
`passed`, lane `running`, cursor unchanged) puts it back to `running` +
`committing` and takes the slot again. No admission check runs on
that resume, so the holder count can exceed the limit. #3439 chose to hold
through publication on purpose (comment at `autoMerge.ts:962-963`, and the
table row `["refresh", "passed", "committing", true]` in
`src/lib/forge/autoRefresh.test.ts:1219`).

**Fix for acceptance 1.** A refresh lane holds the slot only until its refresh
attempt has a pass verdict: while provisioning, while the cursor is `pending`
at `refresh` (a refresh attempt is about to start), and while the attempt is
`spawning`, `running` or `reviewing`. Settlement, publication, review and
every later stage hold nothing. This is the operator's rule as written: the
slot is free as soon as the update from main is finished.

**Recommendation for acceptance 2: a mechanical base update in the merge
queue.** When the PR at the head of a repository's queue reads `BEHIND` (no
conflict, no red check), the merge runner itself merges the current base into
the PR head with `git merge-tree`, writes the merge commit under the Delegatus
machine identity, pushes it to the PR branch as a fast-forward, and then waits
for that head's required checks and merges exactly as it does today. It uses
no agent lane and no refresh slot. Only a real conflict (GitHub `DIRTY`, or a
local `merge-tree` conflict) starts the existing refresh lane with its
resolution review. Bounded concurrent refreshes are rejected (§5.1), and the
batched train is deferred with a trigger (§9).

## 2. Evidence

Read-only, 2026-10-31 between 09:30Z and 11:15Z, on origin/main c41ad397
(`git rev-list HEAD..origin/main` = 0). Sources: the code at that revision; the
Viewer's journal (`journalctl --user -u delegatus.service`, filtered to
`held by refresh` and the lane ids); the lifecycle journal in the state
directory (read with a reader); `get_pipeline` and `list_pipelines`; the
project seat's transcript, its `pipeline_action` calls only; `gh api` for
branch protection, repository merge settings and check runs. Times are UTC.
The Viewer's process environment has no `LLV_MERGE_REFRESH_CONCURRENCY`, so
`refreshLimit` is 1 (`autoMerge.ts:977-979`, `:1594`).

### 2.1 2026-10-30: refresh 0cda5035 (#3263)

| UTC | What happened | Source |
|---|---|---|
| 20:01:05 | 0cda5035 refresh attempt starts | lifecycle `stage_started` |
| 21:01:44 | refresh attempt passed: main merged without conflicts | attempt `completedAt`, lifecycle `stage_completed` |
| 21:12:16 | seat wake lists 0cda5035 «stage_completed: passed but unpublished: Viewer publication reserved for execution outside the mutation lease» | seat transcript |
| 21:55:34 | holder list for the waiting PRs names e54c89a5 alone: 0cda5035 is not a holder | Viewer journal |
| 21:57:24 | seat wake: 0cda5035 «stage refresh asks stopped: publishing the passed stage: no controller job became available for passed-stage settlement within 15 minutes» | seat transcript |
| 22:04:51 | b259e14d (#3463) admitted as the one holder | Viewer journal |
| 22:25:31 | seat reads 0cda5035: `state: needs_decision`, cursor `refresh/committing` | seat transcript |
| 22:25:36 | seat `retry-stage refresh` → answer `state: running`, cursor `refresh/committing` | seat transcript |
| 22:25:45 | holders «0cda5035, b259e14d» | Viewer journal |
| 22:26:39 | holders «b259e14d»: 0cda5035 parked again | Viewer journal |
| 22:57:02 / 22:57:14 | `retry-stage` → running/committing; holders «0cda5035, b259e14d» | seat transcript, journal |
| 22:59:08 | holders «b259e14d» | journal |
| 23:07:32 / 23:07:39 | `retry-stage` → running/committing; holders «0cda5035, b259e14d» | seat transcript, journal |
| 23:10:58 | holders «b259e14d» | journal |
| 23:25:17 / 23:25:36 | `publish acceptedSha=4529700f` → running/committing; holders «0cda5035, b259e14d» | seat transcript, journal |
| 23:34:18 | b259e14d's refresh attempt passes; it keeps holding through its own settlement | lifecycle, journal 23:42:22 |
| 00:03:55 | holders «0cda5035» (still settling after the publish) | journal |
| 00:09:49 | holders «52f3df82»: 0cda5035 finally released | journal |
| 09:03–09:28 (31 Oct) | 0cda5035 review runs and passes | lifecycle |

The waiting PRs' lanes were 2254f6b4, b33ec060, a3ee8afc, acbd334a, b1b1d087,
526c9ac8 and 10f96988. Every hold by 0cda5035 began seconds after a seat action
returned it to `running` with cursor `refresh/committing`, and every release
followed its re-park to `needs_decision`. The refresh work itself had ended at
21:01:44.

### 2.2 2026-10-31: refresh 7226381b (#3463)

The refresh attempt ran 09:50:23–10:27:17 and passed with «passed but
unpublished: Viewer publication reserved for execution outside the mutation
lease». The lane stayed `running`, cursor `refresh/committing`, until about
11:03; its publication check settled `published 12da6625` before that. The
waiting PRs' reason changed from «held by refresh 7226381b» to «held by refresh
57d3e7f5» at 11:03:03. That is about 36 minutes of slot held by settlement
and publication after the update from main was finished.

### 2.3 Single file under strict protection

`main` requires branches to be up to date (`required_status_checks.strict:
true`) with four required contexts: `privacy-publication`,
`privacy-tracker-audit`, `typecheck`, `runtime-gate`. Every merge therefore
puts every other open PR `BEHIND`. Overnight (31 Oct) the queue merged #3525
03:55, #3524 04:35, #3527 05:18, #3471 06:07 and #3528 06:40 (40–49 minutes
apart), each through a refresh lane (merger agent, then reviewer agent).
Because #3439 releases the slot when the refresh stage leaves `refresh`, the
next refresh starts while the previous one is in review; the earlier one merges
first and the later one's result is behind again. PR #3526, a
CONTRIBUTING-only change, went through seven refresh lanes (d9757b43,
3177f69e, 63b455da, affa2916, bd068202, 5c011b35, 56bcfbf5) before it merged
at 07:42. Each was a merger agent plus a reviewer agent, and their refresh
summaries report a plain merge commit of main.

Required check timing, from the first required check's start to the last
required context's completion, on #3505,
#3528, #3526 and #3527: 9 min 49 s, 10 min 16 s, 7 min 6 s, 9 min 27 s
(`runtime-gate` completes last).

## 3. What #3439 changed and why it was not enough

#3439 made a refresh lane hold the slot only while its cursor is on `refresh`,
which fixed the 2026-10-27 shape (#3265's lane 97840186 holding through
appended UI stages). It kept the slot through passed-stage settlement and
publication («Refresh capacity applies only to the refresh stage's
preparation, execution and publication», merge-policy §4.4 item 5). Since then
settlement waits for a controller job under a 15-minute window plus retries,
and publication runs the full pre-push gate, so "publication" became the
longest part of a refresh, and the part the operator's rule excludes.

## 4. Acceptance 1: release at the pass verdict

### 4.1 Rule

`holdsRefreshCapacity(pipeline)` answers true only when
`pipeline.refreshOf` is set, the cursor is on `refresh`, and one of:

- `pipeline.state === "provisioning"` (as today: an admitted refresh before
  its host starts);
- `pipeline.state === "running"` and `cursor.state === "pending"` (as today:
  a refresh attempt is about to be made, including a retry);
- `pipeline.state === "running"` and the latest non-historical refresh
  attempt is `spawning`, `running` or `reviewing`.

Removed: the attempt state `committing` from the list at line 973, and the
clause `["passed", "skipped"].includes(attempt.state) && cursor.state ===
"committing"` at line 974. Every other state releases, including
`needs_decision`, `paused`, `needs_review`, a settlement wait, a publication in
flight or settled, and every later stage. The comment at lines 962-963 and
merge-policy §4.4 item 5 change to say the slot covers preparation and execution of
the refresh attempt.

Why this is safe: the slot exists so that the queue refreshes only the PR it
is about to merge (#3337). A second refresh for the same PR cannot start
while the first lane is open, because `refreshAdmission` refuses when any open
lane targets the same branch or PR (`src/lib/forge/autoRefresh.ts:24-29`).
Releasing earlier can only let a refresh for another PR start sooner. With §5
in place those are conflict refreshes only. If the earlier one merges first,
the later one's result reads `BEHIND` and §5 updates it mechanically, with no
second agent lane.

### 4.2 Tests (in `src/lib/forge/autoRefresh.test.ts`)

- **The 2026-10-30 shape, red on the current head.** `queuedRefreshes()`
  harness: after the first sweep, set `refresh-1` to `state: "running"`,
  cursor `{ stageId: "refresh", state: "committing" }`, refresh attempt
  `state: "passed"`, `verdict: { status: "pass" }`, `settlementAdmissionRetry:
  { failures: 1, retryAt: <past> }`, `stateDetail` «no controller job became
  available for passed-stage settlement within 15 minutes; automatic retry
  1/3 …». Sweep. Expect a second `startRefresh` (`h.creates` length 2) and no
  `queued-1` reason naming «held by refresh refresh-1». On the current head
  the lane holds and `h.creates` stays at 1. Then flip `refresh-1` to
  `needs_decision` and back to `running`/`committing` (the seat's
  `retry-stage`) and sweep again: still no holder.
- **Published, cursor not yet moved.** Same child with
  `delivery.operation = { state: "settled", sha: lastPassedCommit, result: {
  ok: true, remote: "published" } }`: releases.
- **Paused and needs_decision with the agent unfinished** (attempt `running`):
  release (green on the head; guards the rule).
- **Table at lines 1218-1232:** rows `passed/committing` and
  `skipped/committing` change to `false`; add `committing/committing → false`
  and `spawning/running → true`. Rows with cursor `pending` stay `true`.
- **`src/lib/forge/autoMergeStore.test.ts:1379`** «a persisted refresh
  reservation at %s releases capacity only after leaving refresh»: its
  `publishing` case (attempt `skipped`, cursor `committing`) now releases;
  its expectation for that case becomes the `later` expectation.

The existing rows `["refresh", "passed", "committing", true]` and
`["refresh", "skipped", "committing", true]` pass on the current head. They
assert the defect, which is the proof that the new 2026-10-30 case is red
there. Run 2026-10-31 on c41ad397, in a `git archive` export with isolated
`HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, `LLV_STATE_DIR`, a closed control URL and
`LLV_GATE_RUNNER=off`: `scripts/gate-slot.sh bun test
src/lib/forge/autoRefresh.test.ts -t "refresh capacity at refresh with refresh
(passed|skipped) and cursor committing"` → bun 1.4.0, 2 pass, 0 fail, exit 0.

## 5. Acceptance 2: which mechanism

### 5.1 Options

| | Bounded concurrent refreshes | Batched merger train | Mechanical base update (recommended) |
|---|---|---|---|
| What runs per behind PR | a refresh lane (merger agent + reviewer agent) | one integration commit for K PRs, one batch PR, rebase landing, receipts on the originals | `git merge-tree` + `git commit-tree` + one fast-forward push, in the merge runner |
| Agent lane for a trivial update | yes (fails the acceptance's last sentence) | yes, as the batch procedure runs today under the merger role; an unattended port is new machinery | none |
| Under strict protection | every merge makes the concurrent results stale; #3526 already needed 7 lanes at an effective concurrency of about 2 | lands K PRs per CI cycle: the only way past one merge per CI cycle | one merge per CI cycle (inherent to strict up-to-date), about 10–13 min each |
| New machinery | a knob that exists (`LLV_MERGE_REFRESH_CONCURRENCY`, capped at 2) | train state, batch PR lifecycle, forge writes (create, rebase-merge, close, comment), red-check attribution, restart safety | one git helper, two optional fields on `merge.updates[]`, one ownership predicate |

Bounded concurrency is rejected: it multiplies agent lanes whose results the
next merge invalidates. The batched train is the only option that lands
several PRs per CI cycle, and it is deferred (§9): it costs a batch subsystem,
and the mechanical update removes the hour-long wait first. The first part of
the operator's sentence is §4. Its second part is this section: a PR that
needs only a trivial update no longer waits for any refresh slot.

### 5.2 The mechanical base update

Where: `stepLane` (`src/lib/forge/autoMerge.ts:599`), at the point where
`decideMerge` answers `{ kind: "refresh" }` (line 462: `BEHIND`, no conflict,
no red check, no outstanding update), before the refresh-lane admission at
line 683. The git work lives in a new merge-queue module
(`src/lib/forge/baseUpdate.ts`) behind a new optional port
`AutoMergePorts.updateBase`; `productionAutoMergePorts` supplies the real one.
When the port is absent the runner keeps today's refresh-lane path.

Preconditions, all required (otherwise today's refresh-lane path):

- the lane has no `proactiveTaskIds`;
- the PR is in the same repository as its base: `isCrossRepository === false`
  and `headRefName` equals the lane's `delivery.target.branch` (both added to
  `PR_FIELDS`, line 60; a missing field counts as false);
- the delivery ownership half of `refreshAdmission`
  (`src/lib/forge/autoRefresh.ts:14-29`) holds: setting on, lane completed and
  `mergeEligible`, delivery `owner` and not `active`, no other open lane on the
  branch or PR. Extract it as a shared predicate; the refresh path keeps its
  extra per-attempt limit;
- no other lane in the repository owns an update for the current base tip
  (§5.3).

Steps:

1. Read the base tip (existing call at line 686). In `read.repoDir`, objects
   only, as `readBatchLanding`'s `patchPresent` already does
   (`src/lib/forge/batchLanding.ts:11-60`): `git fetch --no-tags
   --no-recurse-submodules --no-write-fetch-head origin <head> <base>`, then
   `git merge-tree --write-tree --no-messages <head> <base>`. Exit 1 (conflict)
   → today's refresh-lane path. No checkout, index or branch ref is touched.
2. `git -c commit.gpgsign=false commit-tree <tree> -p <head> -p <base> -m
   "Merge <base sha> into <head sha>"` with `controllerCommitIdentityEnv()`
   (`src/lib/git/controllerCommitIdentity.ts:4-11`: name Delegatus, a
   noreply address on the reserved `.invalid` domain) and `GIT_AUTHOR_DATE` /
   `GIT_COMMITTER_DATE`
   pinned to the update's `requestedAt`, so a replay recreates the same SHA.
   The message holds fixed words and two SHAs only.
3. Under the record lock (`commit`, line 499), re-check the preconditions
   against the live record, then append `{ requestedAt, head: null, commit,
   base }` to `merge.updates`, set `state: "updating"`, `reason: null`,
   `headSeenAt: null`, `nextReadAt: now + MERGE_POLL_MS`.
4. Outside the lock: `git push <delivery.target.remote> <commit>:<delivery
   branch>` from `read.repoDir`, plain (a non-fast-forward is refused by git),
   with the publication push environment (`pipelinePublicationHookEnv()` and
   `engineForgeWriteEnv()`, as `src/lib/pipelines/git.ts:2303-2314`) plus
   `LLV_SKIP_HOOKS=1` (`.githooks/pre-push:3`). Bounded: 60 s.
5. Next read: the PR head equals `commit`. `admitUpdateHead` (line 554)
   admits an outstanding update whose recorded `commit` equals the head
   exactly, without the `web-flow` committer check that the retired
   update-branch path needed; the chain gains the head, `update.head` is set,
   and `decideMerge` starts the head's check clock from zero (lines 439-443).
   Required checks settle green → `merging` → `merged` through the existing
   path. Red → `blocked` with the check's name, as today.

Hooks: the pre-push gate for this push would run the PR's touched tests and
types again (the changed files against the merge base are the PR's own),
behind CPU admission. The new commit publishes no new text: its tree is the
merge of the published base and the published PR head, its message is fixed
words and SHAs, its identity is the machine identity. The required checks on
the pushed head (`privacy-publication` from the trusted checkout, `typecheck`,
`runtime-gate`, `privacy-tracker-audit`) gate the merge, which is the
enforcement AGENTS.md names for a push whose hooks are skipped. This matches
the acceptance's definition of trivial ("no conflict, required checks green
after the update"). The batch merger already pushes with hooks skipped after
its own checks (`scripts/merge-batch.ts:994-997`, `:1223-1226`).

Identity (acceptance 3): no `update-branch` call (the harness still throws on
`api -X PUT`); author and committer are the machine identity that
`machineRefreshParent` (line 568) and the privacy merge boundary already
accept.

### 5.3 One update in flight per repository

An update owner is another lane in the same repository whose live merge
record's latest update has `base` equal to the current base tip. While one
exists, a `BEHIND` read waits in `checking` with the reason «waiting for the
update of PR #N (pipeline <id>)» and `nextReadAt` one poll ahead. A second
update for the same base would be stale as soon as the owner merges. The owner
stops owning when it merges (main moves), when it blocks, or when main moves
under it. The sweep reads at most `refreshLimit` candidates per repository
per sweep (`autoMerge.ts:1357-1360`), in queue order or, while a refresh is
outstanding, by oldest read; the first `BEHIND` PR read while no owner exists
becomes the owner.

### 5.4 State and records

`PipelineMerge.updates[]` (`src/lib/pipelines/types.ts:1372-1374`) gains two
optional fields, `commit?: string` and `base?: string`, and its comment
changes from "One entry per update-branch" to cover both kinds. Older entries
have neither and keep their reconciliation. States used: `checking` →
`updating` → (`waiting-checks` ↔ `checking`) → `merging` → `merged`, or
`blocked`. No new state; the UI's existing «updating from main» word applies.

Producers and consumers of `merge.updates` and `merge.chain` (from `grep -rn
"\.updates\b\|\.chain\b" src`), each to recheck during the build:

- `src/lib/forge/autoMerge.ts`: `newMerge` (line 324), `decideMerge`
  (437-461), `admitUpdateHead` (554), `machineRefreshParent` (568),
  `stepLane` bookkeeping (608-617), `reconcileBatchLanding` (1409);
- `src/lib/pipelines/store.ts:926-928`: the record validator requires
  `requestedAt` and a nullable `head` on each entry and ignores other keys;
  extend it to require `commit` and `base` to be 40-hex strings when present;
- `src/components/kanban/taskChronologyModel.ts:170-173` and `:262-270`: each
  entry becomes a «merge updated» event on the task timeline, so a mechanical
  update shows there with no UI change;
- `src/lib/monitor/seatTickSources.ts:1947` and `:3171`: a SHA in `chain`
  counts as merged or live work, which is correct for the update commit.

### 5.5 Failure modes

1. **Semantic conflict without a textual conflict.** `merge-tree` is clean,
   types and runtime pass, a behaviour covered only by tests breaks.
   Required checks do not run the test suite. This is the risk the
   acceptance accepts for a trivial update; the post-merge watch on main and
   the nightly full suite are the nets that remain. Today's refresh lane runs
   the PR's touched tests on the merged tree; the mechanical path does not.
2. **Crash between step 3 and step 4.** The record says `updating` with an
   unlanded commit while the PR head is still the old tip. The next read
   pushes the same commit again; if the object is gone, it is recreated with
   the pinned dates and must match the recorded SHA. A mismatch (a different
   git version merges differently) or a moved base drops the unlanded entry
   under the lock and plans again.
3. **Crash after step 4, before the next read.** The head equals the recorded
   commit and is admitted by exact SHA. Recording before pushing is what
   keeps `machineRefreshParent` from treating our own commit as an unknown
   published merge and starting a refresh lane.
4. **Someone pushes to the PR branch in between.** Git refuses the
   non-fast-forward push; the next read sees a head outside the chain and the
   existing `headChanged` / machine-parent handling applies.
5. **Main moves while the head's checks run.** The PR reads `BEHIND` again
   and is updated again. Each base movement costs one CI cycle; there is no
   loop without a real landing.
6. **Push refused** (App credential, protection, network). Counted as a read
   failure (lines 746-763): retried with backoff, blocked after
   `MERGE_READ_FAILURE_LIMIT` with git's own message. No fallback to
   update-branch.
7. **Fork PRs** (#3263 adds `prRepository`) and **proactive lanes** keep the
   refresh-lane path.
8. **Throughput ceiling.** With strict up-to-date protection one PR merges per
   CI cycle per repository. From the measured check timing (§2.3) that is an
   estimate of 10–13 minutes per PR, about 4–6 PRs per hour, with no agent
   lane; no before/after measurement exists yet. The verify stage measures it:
   for the next ten `BEHIND` PRs, first `BEHIND` read to `mergedAt`, from
   the merge records, beside the agent lanes started for them.
9. **Viewer load.** One fetch, one `merge-tree`, one `commit-tree` and one
   push per repository at a time, as async child processes with timeouts,
   under the existing `forge.auto-merge` operation label. The git objects go
   into the project checkout's object store, as batch-landing checks already
   do.

## 6. Shared paths and tests that reach the new path

`refreshCapacityReason` is read at three points: reservation (line 714),
deferred creation (line 938) and the sweep's bounded reads (line 1348). All
three follow the new rule with no other change.

`productionAutoMergePorts` gets the real `updateBase`. Tests that build
production ports and read a `BEHIND` PR would reach real git in a fixture
`repoDir`: `src/lib/forge/autoMergeStore.test.ts` (the child script at lines
1393-1412, and the one around line 1504) and any other
`productionAutoMergePorts(` caller whose fake `run` answers `BEHIND`. Each
passes `updateBase: undefined` to keep its refresh-lane expectations, or a
fake when it tests the new path. `src/lib/forge/autoRefresh.test.ts:374`
reads a red check on an outdated base, which stays on the refresh-lane path.

New tests (in `autoRefresh.test.ts`, with a fake `updateBase` and the
harness's `strict: true`, which moves the base and marks peers `BEHIND` on
each merge):

- a `BEHIND` queue of three: the head is updated, waits for its checks,
  merges; the next is updated only after that; `h.creates` stays empty; no
  `api -X PUT` call; every pushed commit has two parents (head, base tip) and
  the machine identity;
- a local conflict answer from `updateBase` starts exactly one refresh lane;
- a crash after the record and before the push (port throws once): the
  replay pushes the same commit, one update entry;
- the head moved by someone else between record and push: `blocked` with
  `headChanged`, no refresh lane;
- a red required check after the update: `blocked` with that check, the next
  PR is updated;
- a fork PR and a proactive lane keep the refresh-lane path;
- `baseUpdate.ts` against a real temporary repository (port-0 nothing; a local
  bare remote): clean merge yields a fast-forward push whose tree equals
  `merge-tree`; a conflict yields the conflict answer and pushes nothing; the
  same inputs recreate the same SHA.

Run by path with isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR`,
`LLV_STATE_DIR` and a closed `LLV_VIEWER_CONTROL_URL`, through
`scripts/gate-slot.sh`: `src/lib/forge/autoRefresh.test.ts`,
`src/lib/forge/autoMergeStore.test.ts`, `src/lib/forge/autoMerge.test.ts`,
and the new `src/lib/forge/baseUpdate.test.ts`.

## 7. Files

- `src/lib/forge/autoMerge.ts`: `holdsRefreshCapacity` and its comment;
  `PR_FIELDS`; the `BEHIND` branch of `stepLane`; `admitUpdateHead`; the
  update-owner check; `AutoMergePorts.updateBase`;
  `productionAutoMergePorts`.
- `src/lib/forge/autoRefresh.ts`: the shared delivery-ownership predicate
  (open #3263 edits `refreshRequest` in this file, a different function).
- `src/lib/forge/baseUpdate.ts` (new) and its test.
- `src/lib/pipelines/types.ts`: two optional fields on `merge.updates[]`
  entries and their comment. Open #3504, #3415, #3265 and #3263 edit other
  parts of this file.
- `docs/design/merge-policy-and-task-finishing.md` §4.4 items 3 and 5,
  `docs/design/auto-refresh-conflicting-prs.md` (strict base updates
  section), `CONTRIBUTING.md` line 170: a behind branch with no conflict is
  updated by the merge runner; a conflict refreshes through the lane.

`engine.ts` is untouched.

## 8. Validation against the requirement

- «Слот має звільнятися, щойно оновлення з main завершено»: §4 releases at
  the refresh attempt's pass verdict, which is when the merge from main is
  finished; settlement, publication, parks and resumes no longer hold it.
- «або черга має пропускати PR, яким оновлення не потрібне»: under strict
  protection every behind PR needs an update to merge. §5 makes the trivial
  update part of the merge step, so such a PR never waits for a refresh slot
  or an agent lane; only conflicts do.
- Acceptance 3: no update-branch; the machine identity on the only new
  commit. Acceptance 4: §6.

## 9. Deferred — not currently justified

- **Batched merger train in the merge runner.** The only way to land more
  than one PR per CI cycle under strict protection. It needs train state,
  batch PR lifecycle, forge writes, landing receipts and attribution of a red
  batch, and the existing procedure (`scripts/merge-batch.ts`) runs under a
  merger agent lane. Trigger to build it: after §5 ships, the count of
  eligible `BEHIND` PRs in one repository stays above six for more than two
  hours on three days within fourteen, read from merge records.
- **Raising `LLV_MERGE_REFRESH_CONCURRENCY`.** Rejected for behind PRs (§5.1);
  for conflict refreshes it stays 1 until conflicts queue up.
- **Mechanical retest of a red check on an outdated base** (the
  `failedCheck` path, lines 696-702). Same operation as §5.2, but it changes
  a test that builds production ports (`autoRefresh.test.ts:374`) and the
  acceptance asks only for behind PRs.
- **Running the local pre-push gate on the mechanical commit.** The required
  checks cover it; the gate would cost 10–25 minutes per update behind CPU
  admission.
- **Fork PRs and proactive lanes on the mechanical path.**
- **Controller-job starvation of passed-stage settlement** (tasks c77b6a06,
  lane cfa3e742). It caused the long settlement on 2026-10-30, lives in
  `engine.ts` and is fenced; after §4 it no longer affects the merge queue's
  slot.
- **GitHub merge queue.** Unavailable for a user-owned repository and would
  change repository settings.
