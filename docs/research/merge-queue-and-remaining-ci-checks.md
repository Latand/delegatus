# Merge queue and remaining CI checks

Source audit dated 2026-10-23, adapted from Codex Cloud result 12 (GPT-6.1 Sol).
The patch SHA-256 matched its export manifest:
`e444f3bc5c567dee758744fb0bcdef39a1577ee856ad055a676768965599ed68`.
The accompanying report SHA-256 also matched:
`3d793bacf5f4c05621a23b8be93c5cb350421fb826a60d7a737b57095ef6ebaf`.

The week of green CI and merge-queue acceptance remain unverified. No workflow
was changed. This audit reads all eleven files in `.github/workflows/`,
`src/lib/forge/autoMerge.ts`, its check-rollup dependency and existing verification
notes. It has no live branch-protection snapshot or current CI job history.
Workflow comments describe earlier measurements; they do not establish current
failure rates or prove that a check is still required.

## Required checks: evidence and latency

Repository instructions and workflow comments identify `privacy-publication`,
`privacy-tracker-audit`, and `runtime-gate` as required or intended required
contexts. Confirm the actual union of classic protection and active inherited
rules before changing policy. Job names alone cannot establish requiredness.

| Context | Evidence of flakiness | Evidence of slowness and concrete proposal |
| --- | --- | --- |
| `privacy-publication` | No current rate established. Older shared workflow comments say both privacy jobs never failed in that audit window. Current provisioning explicitly anticipates package network/index failures. | 25-minute job cap; cold media download allows two bounded attempts within a 10-minute step, plus 3-minute restore and install steps. Candidate self-tests have a 130-second execution cap. Measure cold/warm provisioning separately; retain the existing trusted media cache, bounded retries and offline installation. Prewarm on trusted pushes and report cache misses by runner image. Never retry a scanner refusal as infrastructure. |
| `privacy-tracker-audit` | No current rate established. Package provisioning and tracker API/media reads are failure surfaces whose current rates remain unmeasured. | Same 25-minute cap and cold provisioning costs. Keep publication-event runs uncancelled; preserve trusted tool-cache seeding. Verify what `--report-only` guarantees before treating green as privacy enforcement. A main push seeds tools but skips the tracker audit step. |
| `runtime-gate` | Historical native Codex cleanup races are documented in `docs/verification/ci-flakes.md`. Attempt 1 failed and attempt 2 passed on the same CI head; fixes and later 0/50 campaigns are recorded. Fresh samples are needed to establish today's rate. | The final job has a 1-minute cap but waits for `bun-runtime` (30 minutes) and every `native-codex-runtime` matrix leg (15 minutes). The build, package, Chromium layout, held controls, Viewer and host rehearsals share the Bun parent. Record per-step durations before splitting; retain a stable final gate requiring every parent. Cache compiler work without reusing verdicts or skipping rehearsals. |

All reported failed checks still block product auto-merge even when optional.
Only required checks hold it while pending or absent. Consequently an optional
flake can block a lane; making a slow job optional does not make its failure
irrelevant to this product.

## Remaining workflow inventory

Caps below are configured upper bounds. Observed durations need run history.

| Workflow | Current coverage and remaining audit work |
| --- | --- |
| `bun-runtime.yml` | PR and manual runtime verification; separate manual native queue campaign. This campaign tests the native agent queue. Forge merge-group coverage remains separate. Preserve the matrix, induced failure controls and runtime gate aggregation. Both normal parent jobs explicitly check out PR head; queue runs must instead verify the merge-group SHA. |
| `platform-tests.yml` | Journal startup (15 minutes), minimum SQLite (20), Windows scope (3), Windows native (10). SQLite verification records a historical GC flake, its deterministic repair and 30/30 passing samples (`docs/verification/minimum-sqlite-deterministic-tests.md`); collect fresh samples before judging current health. Measure the serial SQLite files and journal rehearsals. Keep fresh state per file and native backend assertions. |
| `macos-identity.yml` | Scope (3 minutes), native identity (10). Historical Claude persistence timing flakes and fixes are recorded in `docs/verification/ci-flakes.md`. Dependency scope already reduces work and fails open to testing on uncertainty. Keep this behavior; collect fresh native evidence. |
| `macos-newcomer.yml` | Path-filtered PRs, manual runs and post-publication verification (15 minutes). Retain as scoped/post-release coverage; do not require this path-filtered workflow for every PR. Package install and registry checks need their own latency classification. |
| `memory-selection.yml` | Full `typecheck` (5 minutes) on PR/main, replay on PR only. Replay has no explicit job timeout. Propose an explicit timeout after measuring its p95. Preserve full typecheck and isolated replay coverage. |
| `supply-chain.yml` | Weekly/manual audit (10 minutes). Retain scheduled vulnerability discovery and explicit lockfile/audit controls. Its historical PR comments do not match its current triggers. Do not require it on every merge without adding a producer on that event. |
| `docker-image.yml` | Scoped PR verification (45 minutes), main/tag publication (360). Shared build slots add queue latency beyond execution. Preserve separate verification/publication capacity. Its scope can skip merge-batch branches; distinguish that product convention from forge merge groups. Do not put conditional publication on the required PR path. |
| `privacy-publication.yml` | Trusted scanner reads candidate source; candidate self-tests run last without credentials. Preserve this trust boundary in any queue adaptation. Default-branch self-test failure is warning-only on push; candidate scoped tests and trusted scanning still enforce their own verdicts. |
| `privacy-tracker-audit.yml` | Issue/comment/review events, target PR, main push and manual entry points. These entry points inspect tracker publications. Preserve it when adding queue-specific coverage. |
| `dependabot-lockfile.yml` | Narrow target-PR lockfile writer. Its token-authored push explicitly dispatches workflows because it does not cause a synchronize event. Audit dispatch completion and check SHA attribution; do not expand its write permissions for queue support. |
| `publish.yml` | Tag/manual package and release publication. Keep outside merge validation. Preserve tag provenance and release checks; no queue trigger is proposed. |

There is no fresh ranking of the ten slowest or flakiest jobs. Producing one
requires job and attempt history. Prior
workflow comments report 7% superseded PR work and privacy runtimes of 40–90
seconds; treat those numbers as historical until the sampling below repeats.

## Merge-queue compatibility proposal

None of the eleven workflows declares `merge_group`. A required context cannot
validate a merge-group SHA through its existing PR-only trigger. Do not enable
mandatory queueing until every required context has an event-specific producer.

1. Snapshot classic protection plus active rules for each protected base,
   including inherited rules, required context names, application bindings,
   strictness and queue policy. Match every context to a producer and SHA.
2. In a separate workflow change, add `merge_group: { types: [checks_requested] }`
   to the code-validation workflows actually required. Preserve stable context
   names. Build and test `github.event.merge_group.head_sha`; derive comparison
   base from the merge-group payload. PR-only scope helpers must run conservatively
   when that payload is absent or unsupported. Key cancellation by the individual
   merge-group ref/SHA so unrelated groups cannot cancel each other.
3. Add a trusted queue path for privacy inspection. Inspect the synthetic group
   commit as data using trusted base code and fingerprints. Do not execute group
   code with target-event privileges. Tracker inspection needs explicit PR
   membership resolution for the group: the current event's PR/issue number is
   absent. Queue evidence must show which publications were audited.
4. Exercise two queued PRs, a moving base, failed/pending required checks,
   cancellation, removal and requeue. Assert all required contexts land on the
   group SHA and that one failure prevents landing. Preserve explicit skipped
   success only for scopes whose dependency analysis proves no work is needed.
5. Audit the product's enqueue response separately. `gh pr merge` success can
   mean queued rather than merged. This task removes a fallback that declared
   success when the confirmation read failed. Test queued OPEN responses and eventual MERGED state before
   claiming queue compatibility. Never treat CLI exit 0 as a landed commit.

## Product correction in this task

Previously `requiredContexts` queried only
`.protection.required_status_checks.contexts`, used an unencoded base branch,
and cached malformed JSON as an empty requirement list. A CLEAN PR with a
ruleset-only context absent from its rollup could reach the merge attempt after
the settling window. The forge remains the final enforcement boundary, but the
product's readiness decision and displayed wait reason were incomplete.

The code now unions classic context/check entries with the active branch-rules
endpoint, including inherited rules and all paginated pages. It encodes branch
names and caches only validated complete results. Unreadable or malformed
requirements use the existing retry/refusal path, never an empty fallback.
Tests model a CLEAN PR with missing and pending ruleset checks, multiple pages,
duplicate classic/ruleset names, a slash in the base name, and malformed responses.
A second regression models successful enqueue followed by an unreadable
confirmation: the lane now stays `merging` until a later read proves `MERGED`.
Previously CLI success plus no confirmation marked the lane merged.
The ruleset fixture probes the old implementation's ruleset-blind readiness decision.

Limits: requirement caching still lasts 30 minutes. Application bindings are
not yet carried into the product's name-only required-context comparison.
Unsupported/unauthorized branch-rule reads now refuse readiness rather than
silently falling back to classic protection. Confirm API support and read
permissions before rollout. This change does not implement queue event handling.

## A week of green CI: completion criteria

Start a new seven-consecutive-day window only after the last CI repair lands.
Collect every run and attempt for required contexts and scoped platform/runtime
jobs. Record head/group SHA, event, first-attempt result, later attempts,
queue wait, step execution time, cache state and failure category. Keep the raw
logs private and publish aggregates without identities or machine paths.

Report first-attempt failure rate and same-SHA retry recovery separately. Exclude
superseded cancellations from flake counts, but show them as wasted work; count
an unexplained required-check cancellation as a gate failure. Report p50/p95/max
queue and execution times separately, plus sample counts. For this acceptance
window require no unexplained first-attempt required failures, no stranded
required contexts and a passing queue negative control. Zero samples is not
success. Any unresolved failure keeps the task open; do not erase it by rerun.

Reconcile the remaining audit checklist against these results: required-context
ownership, slowest/flakiest rankings, uncovered test-file classification,
duplicate gates and coverage retained after cuts. Propose deletions only with
replacement coverage or evidence the behavior is unreachable. The current
source review alone cannot close those checklist items.

## Scope and overlap

The implementation was first applied at `adce5764927f7e838f20070cd2968128912e861c`.
During verification the integration train landed on main at
`3e570adfba80059eaba26a978402a2e73a02978e`, including #3238 at
`0679d97462404f57b5a58b8b80f2bdf12c77b171`. The assigned branch was
fast-forwarded to that main revision without rebasing, and the verified patch
was reapplied. #3238 supplies queue stall recovery, check rollup identity,
pending reasons and BEHIND refresh handling. It leaves both the classic-only
requirement discovery and the CLI-success/no-confirmation fallback intact.
Both Cloud corrections remain necessary; its queue logic is retained.

The preliminary scratch three-way merge combined `autoMerge.ts`,
`autoRefresh.test.ts` and `autoMergeStore.test.ts` cleanly (exit 0 each).
`autoMerge.test.ts` had one adjacent helper comment/signature conflict
(exit 1), resolved by keeping #3238's comment and these helper options.
Reapplication with `git apply --3way` likewise exited 1 for that conflict;
resolution and the staged whitespace check exited 0. Four importer fixtures
answer the added rules read. #3238's two new store/restart fixtures now answer
`/rules/branches/` with `[[]]` before their broad `/branches/` matchers.

The controller supplies production ports and schedules the sweep; the pipeline
engine consumes merge admission and retry behavior; auto-refresh consumes merge
eligibility. Requirement discovery has one caller in `stepLane`, which passes
the PR base or its existing `main` default, then feeds the union into
`decideMerge`. The existing mutation fence and App writer still guard writes.
There is no schema or persisted record change. The existing 30-minute cache
and 30-second GitHub subprocess deadline remain; no performance gain is claimed.

GitHub documents that [branch rules include active inherited rules](https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch).
The CLI's [pagination and slurp options](https://cli.github.com/manual/gh_api)
collect each page into an outer array. Malformed later pages reject the whole
read before its contexts enter the cache.

## Validation and handoff

The workflow inventory and configured caps above were checked against all
eleven workflow files at the original base. Those files are unchanged in the
integrated main revision. No workflow was edited.
The historical rates remain attributed to their verification notes. Fresh CI
history, actual protection settings and a live merge-group exercise remain
follow-up evidence.

The initial checks below ran before the integration train landed.
They used Bun 1.4.0 through `gate-slot.sh` and `gate-remote`, one
remote call at a time. Each test file used a fresh process, HOME,
XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR, with the Viewer control URL on a
closed port. Main was exported from the original `adce5764` revision; branch used the
Cloud corrections and the initial importer fixtures. The remote loop used `setsid` and
closed stdin, retained every exit and finished with
`RAN_COUNT 16 FAIL_COUNT 0` (driver exit 0).

Each command below ran separately on both revisions:

| Command | Main exit | Branch exit | Passed, main / branch |
| --- | --- | --- | --- |
| `bun test --timeout=60000 src/lib/forge/autoMerge.test.ts` | 0 | 0 | 59 / 75 |
| `bun test --timeout=60000 src/lib/forge/autoMergeStore.test.ts` | 0 | 0 | 98 / 98 |
| `bun test --timeout=60000 src/lib/forge/autoRefresh.test.ts` | 0 | 0 | 34 / 34 |
| `bun test --timeout=60000 src/lib/forge/taskFinish.test.ts` | 0 | 0 | 18 / 18 |
| `bun test --timeout=60000 src/lib/pipelines/engine.ports.part2.test.ts` | 0 | 0 | 51 / 51 |
| `bun test --timeout=60000 src/lib/pipelines/engine.ports.part3.test.ts` | 0 | 0 | 18 / 18 |
| `bun test --timeout=60000 src/lib/tasks/doneVisibility.test.ts` | 0 | 0 | 16 / 16 |
| `bun test --timeout=60000 src/lib/forge/checkRollup.test.ts` | 0 | 0 | 9 / 9 |

Totals: main 303 passed, branch 319 passed, four existing skipped legacy cases
on each revision, zero failures. The first invocation put all eight explicit
paths in one `bun test --timeout=60000` process on main: exit 1, 285 passed,
four skipped and 18 failed. The later pipeline file encountered
`no such table: state_leases` after earlier files had removed shared state.
The fresh-process runs above passed every file, including that entire file;
no production change was made for the combined-run failure.

Preparation and source checks:

| Command or check | Exit |
| --- | --- |
| SHA-256 comparison of `12.diff` and `12.md` with the manifest | 0, both match |
| `git apply --check` and `git apply` for the verified patch | 0 each |
| `gh pr view 3238`, `gh pr diff 3238` and overlapping open-PR inventory | 0 each |
| `git fetch origin main` and base/PR revision recheck | 0 each, revisions unchanged |
| Workflow inventory/cap assertions over eleven files | 0 |
| `git diff --exit-code -- .github/workflows` | 0 |
| `git diff --check` and `git diff --cached --check` | 0 each |
| `bun install --frozen-lockfile` in private scratch for hook dependencies | 0 |
| Initial scratch-driver construction, then corrected construction | 2, then 0 |
| `bun run privacy:check` before final report update | 0 |

The overlap check's individual three-way-merge exits are recorded in the scope
section. Before the train landed, the production source blob matched the pinned patch exactly:
`65b60bedfa2af45a3fd8d7cdb76783abaa53e021` (`git hash-object`, exit 0).

| Initial static/regression command | Exit | Result |
| --- | --- | --- |
| `bun x tsc --noEmit` | 0 | Full typecheck |
| `bun x eslint src/lib/forge/autoMerge.ts src/lib/forge/autoMerge.test.ts src/lib/forge/autoMergeStore.test.ts src/lib/forge/autoRefresh.test.ts src/lib/pipelines/engine.ports.part2.test.ts src/lib/pipelines/engine.ports.part3.test.ts` | 0 | Zero errors; three warnings on unchanged imports in the pipeline test files |
| Old-source regression command below, with initial main production source and final test fixtures in scratch | 1, expected | 15 failed, one passed; both original behavioral defects reproduced |
| Sequential remote static/regression driver | 0 | Required negative-control failures confirmed |
| `bun run privacy:check` on the finished report and staged diff | 0 | Publication gate passed |

```sh
bun test --timeout=60000 src/lib/forge/autoMerge.test.ts --test-name-pattern 'accepted queue request|active ruleset contexts|invalid required-check discovery|failed discovery'
```

The negative control keeps the final test fixtures and substitutes only the
old production implementation through a main export. Unreadable and malformed
confirmation reads incorrectly mark the old lane merged, and missing ruleset
checks incorrectly permit an old merge attempt. The same cases pass in the
75-test branch suite above. The readable OPEN-confirmation control passes on
both implementations.

## Verification after the integration train

The required checks were repeated against main at
`3e570adfba80059eaba26a978402a2e73a02978e` and the integrated branch.
This run also covers #3238's newly landed store/restart fixtures. Each command
again ran separately with fresh state:

| Command | Main exit | Integrated branch exit | Passed, main / branch |
| --- | --- | --- | --- |
| `bun test --timeout=60000 src/lib/forge/autoMerge.test.ts` | 0 | 0 | 67 / 83 |
| `bun test --timeout=60000 src/lib/forge/autoMergeStore.test.ts` | 1 | 1 | 98 / 98, one failure each before the fixture correction below |
| `bun test --timeout=60000 src/lib/forge/autoRefresh.test.ts` | 0 | 0 | 42 / 42 |
| `bun test --timeout=60000 src/lib/forge/taskFinish.test.ts` | 0 | 0 | 18 / 18 |
| `bun test --timeout=60000 src/lib/pipelines/engine.ports.part2.test.ts` | 0 | 0 | 51 / 51, four existing skips each |
| `bun test --timeout=60000 src/lib/pipelines/engine.ports.part3.test.ts` | 0 | 0 | 18 / 18 |
| `bun test --timeout=60000 src/lib/tasks/doneVisibility.test.ts` | 0 | 0 | 16 / 16 |
| `bun test --timeout=60000 src/lib/forge/checkRollup.test.ts` | 0 | 0 | 13 / 13 |

The loop finished `RAN_COUNT 16 FAIL_COUNT 2`. Full typecheck and the same
six-file ESLint command above exited 0; lint retained the same three unchanged
import warnings. The old-source regression command above, now substituting
integrated main's production source, exited 1 as expected: 15 failures and one
pass. The sequential combined driver exited 1 because of the two store-file
failures, with every planned command completed.

Main's restart-after-timeout case and the branch's earlier refresh-restart
case both received child exit 0 plus a successful `[blocking-wait]` diagnostic.
Their empty-stderr assertions failed before their state assertions. The
pre-existing fixture issue is corrected in the three child-result assertions:
known successful state-write waits and pipeline transaction-hold diagnostics
are validated and printed. Nonzero exits, malformed records, failed waits and
unknown stderr remain failures. Production code is unchanged by this repair.

The whole store file was repeated three times per revision, alternating main
and branch with fresh state:

| Command | Round | Main exit | Corrected branch exit |
| --- | --- | --- | --- |
| `bun test --timeout=60000 src/lib/forge/autoMergeStore.test.ts` | 1 | 0 | 0 |
| Same whole-file command | 2 | 1 | 0 |
| Same whole-file command | 3 | 0 | 0 |

Each corrected branch run passed all 99 tests. Main's second repetition again
failed an empty-stderr assertion on a successful child wait diagnostic; its
other two repetitions passed all 99 tests. The driver ended with
`RAN_COUNT 6 BRANCH_FAIL_COUNT 0 BASE_FAIL_COUNT 1`. Combined with the other
seven passing branch files above, the final test selection has 340 passing
cases and four existing skips. The repeated store runs are additional samples
and are not added to that selection total.

A separate scratch probe extracted the final child-result assertion and
exercised empty stderr, both accepted diagnostic classes, nonzero exits,
malformed records, failed waits, unknown stderr, wrong sites/collections and
invalid hold durations. All 12 cases passed.

| Final follow-up command | Exit | Result |
| --- | --- | --- |
| `bun x tsc --noEmit` | 0 | Full typecheck after the fixture correction |
| Same six-file `bun x eslint` command above | 0 | Zero errors, three unchanged import warnings |
| `bun test --timeout=60000` on the extracted scratch diagnostic probe | 0 | 12 passed, including all refusal cases |
| Sequential store/static/probe driver | 0 | All six full-file runs accounted for; corrected branch green in all three |
| Final `git diff --check`, `git diff --cached --check` and workflow diff check | 0 each | No whitespace errors or workflow changes |
| Final `bun run privacy:check` | 0 | Publication check on the complete staged report and code |

The final production source blob is
`340abfb0fa369ad13076d5660040787ddba9b29e`. Its delta from integrated main
retains exactly the two production corrections in the verified Cloud patch.
The source audit, overlap handling and every nonzero verification exit remain
recorded above; the baseline failures were not discarded by the reruns.

Final base recheck: `git fetch origin main` exited 0 and observed
`800a26ebc10ca2db855d12a71320f75c5f2fb955`. Its post-base batch changes gate
routing, swarm rules and telemetry. It changes none of the forge/pipeline
files, package/lockfile or workflow files checked for overlap. The tested base
remains `3e570adfba80059eaba26a978402a2e73a02978e`, including #3238.

The hooked commit outcome and the final clean-worktree check are supplied in
the stage completion report. No push is part of this task.
