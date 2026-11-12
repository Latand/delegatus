# Issue delivery verification

The earlier sections record the predecessor's checks. The successor refresh
and its fresh results are recorded under [Successor refresh](#successor-refresh).

Run one test file per isolated export command through the stage-provided gate.
`G` below expands to `bash "$GATE" --record "$TMPDIR/check-<run>.log"`.
The installed `scripts/gate-slot.sh` was supplied by the controller. Each run
used a fresh HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, a closed
`LLV_VIEWER_CONTROL_URL` on loopback port 1, `LLV_GATE_RUNNER=off`, and a
600000 ms owned-run deadline. Each recorder was awaited once through
`wait_for_check`, including cleanup. The application test runner was Bun 1.4.0.

The source was exported with `bun scripts/review-export.ts HEAD`, overlaid
through a counted tar archive, and checked from scratch. Source snapshot at original build acceptance:
16 TypeScript files, aggregate SHA-256 `29d9ee147b834bbdda8eeb799baa9a5a9633ca44ee4d619ff958a1ce7dce915c` (sorted file-to-SHA-256
JSON, with the default JSON separators). No performance gain is claimed.

The final focused selections total **314 passing tests, 3365 assertions**.
The full repository-initialization file has one matching baseline failure:
`P2: repeated board preflight reuses the successful existing-repository Git
probes`, expected 200, received 503. The Git-only lifecycle case passes.

## Every recorded run

Counts are passing / failing tests; lint rows give diagnostic counts. Earlier
attempts are retained below, including fixture failures and baseline reads.

| Run | Command | Exit | Counts | Assertions |
|---|---|---:|---|---:|
| delivery-1 | `G bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 38 / 0 | 81 |
| delivery-store-1 | `G bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 1 | 0 / 9 | 9 |
| mcp-links-1 | `G bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 1 | 1 / 2 | 6 |
| mcp-links-base | `G bun test --timeout=60000 src/lib/mcp/workLinks.test.ts (baseline export)` | 1 | 1 / 1 | 6 |
| delivery-store-2 | `G bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 0 | 9 / 0 | 64 |
| mcp-links-2 | `G bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 1 | 1 / 2 | 6 |
| auto-merge-1 | `G bun test --timeout=60000 src/lib/forge/autoMerge.test.ts` | 0 | 158 / 0 | 2731 |
| postmerge-binding-1 | `G bun test --timeout=60000 src/lib/forge/postMerge.taskBinding.test.ts` | 0 | 10 / 0 | 55 |
| worklinks-1 | `G bun test --timeout=60000 src/lib/forge/workLinks.test.ts` | 0 | 40 / 0 | 112 |
| done-project-1 | `G bun test --timeout=60000 src/lib/done/project.test.ts` | 0 | 31 / 0 | 122 |
| mcp-links-3 | `G bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 1 | 1 / 2 | 6 |
| focused-lint-1 | `G bunx eslint $CHANGED_TS` | 0 | 16 files; 0 errors; 8 existing warnings | — |
| git-only-1 | `G bun test --timeout=60000 src/lib/pipelines/repositoryInitialization.test.ts` | 1 | 39 / 1 | 297 |
| git-only-base | `G bun test --timeout=60000 src/lib/pipelines/repositoryInitialization.test.ts (baseline export)` | 1 | 39 / 1 | 297 |
| mcp-links-4 | `G bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 1 | 2 / 1 | 20 |
| delivery-2 | `G bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 47 / 0 | 94 |
| mcp-links-5 | `G bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 0 | 3 / 0 | 23 |
| delivery-final | `G bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 47 / 0 | 94 |
| delivery-store-final | `G bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 0 | 9 / 0 | 64 |
| auto-merge-final | `G bun test --timeout=60000 src/lib/forge/autoMerge.test.ts` | 0 | 158 / 0 | 2731 |
| git-only-focused | `G bun test --timeout=60000 src/lib/pipelines/repositoryInitialization.test.ts --test-name-pattern '^D:'` | 0 | 1 / 0 | 96 |
| git-task-finishes | `G bun test --timeout=60000 src/lib/forge/autoMergeStore.test.ts --test-name-pattern 'no PR is expected'` | 0 | 8 / 0 | 36 |
| delivery-pagination | `G bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 50 / 0 | 104 |
| delivery-store-pagination | `G bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 0 | 9 / 0 | 64 |
| task-wire-1 | `G bun test --timeout=60000 src/lib/links/taskWire.test.ts` | 0 | 3 / 0 | 19 |
| delivery-renames | `G bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 51 / 0 | 107 |
| focused-lint-final | `G bunx eslint $CHANGED_TS` | 0 | 16 files; 0 errors; 8 existing warnings | — |
| mcp-links-final | `G bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 0 | 3 / 0 | 23 |

The first persistence fixture used an invalid empty completed graph; it was
corrected to a valid completed lane. The MCP fixture needed an explicit caller,
its own transcript roots and an isolated capability. The baseline MCP run
reproduced the original caller refusal before those fixture changes. No
production authentication guard was weakened.

`CHANGED_TS` is the following explicit file list:

```text
src/lib/done/candidates.ts
src/lib/forge/autoMerge.test.ts
src/lib/forge/autoMerge.ts
src/lib/forge/issueDelivery.test.ts
src/lib/forge/issueDelivery.ts
src/lib/forge/issueDeliveryStore.test.ts
src/lib/forge/landedPullRequests.ts
src/lib/forge/postMerge.taskBinding.test.ts
src/lib/forge/workLinks.ts
src/lib/mcp/server.ts
src/lib/mcp/workLinks.test.ts
src/lib/monitor/seatTickSources.ts
src/lib/pipelines/engine.ts
src/lib/pipelines/store.ts
src/lib/pipelines/types.ts
src/lib/viewerLoopMonitor.ts
```

## Other checks

| Command / procedure | Exit | Counts and result |
|---|---:|---|
| `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json bun scripts/privacy-publication-gate.ts --require-known-values --paths $CHANGED_TS` | 0 | 16 whole files; PRIVACY GATE: PASS; before final pagination and rename edits |
| `git diff --check` | 0 | No whitespace errors |
| `gh --version` and `gh api --help` | 0 | Installed gh 2.45; pagination uses `--paginate --jq @json` |
| `gh api repos/$REPOSITORY/pulls/3909 --jq '{number,merged_at,base:{ref:.base.ref,repo:{default_branch:.base.repo.default_branch}}}'` | 0 | One primary record; merged into the default branch |
| `gh api graphql -f query="$CLOSER_QUERY" -f owner="$OWNER" -f name="$REPOSITORY_NAME" -F number=3901` | 0 | The exact query from issueDelivery.ts returned one closed event, closer PR 3906, zero GraphQL errors |
| `git fetch origin main` followed by `git diff --name-only dfc99dce..origin/main` | 0 | Five main changes; no overlap with this implementation |
| `gh pr list --state open --limit 100 --json number,title,headRefName,files` and `gh pr diff <number>` | 0 | Eleven overlapping PRs inspected |
| `git merge-file -p "$CURRENT_FILE" "$BASE_FILE" "$PR_FILE"`, repeated against both the starting and final file | See below | 31 file pairs across eleven PRs; 61 existing conflict regions on each side; zero newly introduced conflicts |

The compatibility checks covered PRs 3920, 3891, 3802, 3801, 3795, 3749, 3747,
3731, 3710, 3668 and 3585. Earlier placement checks introduced 5, 2 and 4
conflicts respectively; moving the new imports and creation hook clear of
existing changes reduced the final count to zero new conflicts. Per-file
merge-file exits count conflict regions (zero means a clean merge):

| PR | File | Starting exit | Final exit |
|---|---|---:|---:|
| 3920 | `src/lib/monitor/seatTickSources.ts` | 0 | 0 |
| 3891 | `src/lib/pipelines/types.ts` | 0 | 0 |
| 3802 | `src/lib/mcp/server.ts` | 3 | 3 |
| 3802 | `src/lib/pipelines/engine.ts` | 3 | 3 |
| 3802 | `src/lib/pipelines/store.ts` | 4 | 4 |
| 3802 | `src/lib/pipelines/types.ts` | 0 | 0 |
| 3801 | `src/lib/forge/autoMerge.ts` | 0 | 0 |
| 3801 | `src/lib/pipelines/engine.ts` | 2 | 2 |
| 3801 | `src/lib/pipelines/store.ts` | 1 | 1 |
| 3801 | `src/lib/pipelines/types.ts` | 0 | 0 |
| 3795 | `src/lib/mcp/server.ts` | 1 | 1 |
| 3749 | `src/lib/mcp/server.ts` | 7 | 7 |
| 3749 | `src/lib/pipelines/engine.ts` | 3 | 3 |
| 3749 | `src/lib/pipelines/store.ts` | 1 | 1 |
| 3749 | `src/lib/pipelines/types.ts` | 0 | 0 |
| 3747 | `src/lib/forge/autoMerge.ts` | 0 | 0 |
| 3747 | `src/lib/pipelines/engine.ts` | 2 | 2 |
| 3747 | `src/lib/pipelines/store.ts` | 1 | 1 |
| 3747 | `src/lib/pipelines/types.ts` | 0 | 0 |
| 3731 | `src/lib/mcp/server.ts` | 12 | 12 |
| 3710 | `src/lib/mcp/server.ts` | 12 | 12 |
| 3710 | `src/lib/pipelines/engine.ts` | 2 | 2 |
| 3710 | `src/lib/pipelines/store.ts` | 1 | 1 |
| 3710 | `src/lib/pipelines/types.ts` | 0 | 0 |
| 3710 | `src/lib/viewerLoopMonitor.ts` | 1 | 1 |
| 3668 | `src/lib/forge/autoMerge.test.ts` | 0 | 0 |
| 3668 | `src/lib/forge/autoMerge.ts` | 0 | 0 |
| 3668 | `src/lib/pipelines/engine.ts` | 2 | 2 |
| 3668 | `src/lib/pipelines/store.ts` | 3 | 3 |
| 3668 | `src/lib/pipelines/types.ts` | 0 | 0 |
| 3585 | `src/lib/mcp/server.ts` | 0 | 0 |

Publication runs the repository's guarded commit and pre-push checks. Their
terminal results are handed over in the stage report and retained check log.
The stage ran no full test suite, build or standalone publication typecheck.


## Final local checks

| Command | Exit | Counts and result |
|---|---:|---|
| `G bun scripts/privacy-publication-gate.ts --require-known-values --paths src/lib/forge/issueDelivery.ts src/lib/forge/issueDelivery.test.ts src/lib/forge/issueDeliveryStore.test.ts docs/verification/issue-delivery.md` | 0 | Four whole files pass; thirteen other source files were byte-identical to the earlier whole-file scan |
| `git commit -m "Close delivered issues after lane pull requests land"` with the tool attribution trailer | 1 | The staged whitespace hook found one extra blank line at EOF in the new landing helper; removed before retry |

The final guard retry and the privacy rescan of this updated ledger and the
whitespace-only helper correction are recorded in the stage handoff. No test
behaviour changed after the passing focused selections.


## Publication repair

The first publication passed privacy, typecheck and lint. Its touched-test
head run exhausted the comparator's fifteen-minute execution budget. Five
owned test services exited with status 124 at the same deadline. The retained
baseline samples for those files completed successfully. The smallest affected
file, `src/lib/pipelines/engine.terminalBudget.test.ts`, was rerun separately
on the accepted implementation and on its original base: both exit 0, eleven
passing tests, 136 assertions.

Current main was merged with a merge commit, preserving the design and accepted
implementation. The issue delivery sweep now uses the existing `forge.sweep`
monitor label. This removes the central monitor-type edit and the 96 root-level
test files that edit added to publication's sibling selection. The gate,
test selection algorithm and execution budgets retain their committed policy.

Repair checks use the same isolated, recorded wrapper procedure above:

| Command | Exit | Counts |
|---|---:|---|
| `G bun test --timeout=60000 src/lib/pipelines/engine.terminalBudget.test.ts` on the accepted head | 0 | 11 pass, 0 fail, 136 assertions |
| The same command on the original base | 0 | 11 pass, 0 fail, 136 assertions |
| `G bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 51 pass, 0 fail, 107 assertions |

The durable-store run and the full pre-push rehearsal are retained with their
terminal exit status in the publication-repair handoff.


### Further repair verification

The monitoring-scope change alone did not resolve publication. The first
full-hook rehearsal exited 1 after the head phase completed 63 of 84 files
before its fifteen-minute deadline. An unchanged rerun reused 58 qualified
green files and exited 1 with three new runner failures, 36 pre-existing
failures and three flaky observations. The three new failures were file
execution deadlines and owned-child cleanup diagnostics in `engine.cloud`,
`engine.roleMemoryDispatch` and `engine.settlement`; all three complete
baseline files passed. Privacy, types and lint passed in both rehearsals.

Creation now defers forge-cache and lane-registry reads until a title or
predecessor reference requires them. Git-only and ordinary creation perform
neither read. An explicit refresh reads only its named predecessor. Issue
and successor resolution retain the same links and partial markers.

| Command | Exit | Counts |
|---|---:|---|
| `G bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 55 pass, 0 fail, 117 assertions |
| `G bun test --timeout=60000 src/lib/pipelines/engine.settlement.test.ts` | 0 | 121 pass, 0 fail, 1016 assertions |

The final full-hook result is recorded in the publication-repair handoff.
No execution-budget or check-selection override was introduced.

## Successor refresh

On 2026-11-12, `git merge --no-ff origin/main` integrated main at `2614b079`
without conflicts. The merge preserves both the issue-delivery implementation
and main's orchestrator seat migration. The refresh adds verification evidence
alongside the merge. No performance gain is claimed.

Checks run from an immutable scratch export. Each test file has a fresh HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, native Git first on PATH, a closed
Viewer control endpoint, and its own owned runner. Heavy checks run sequentially
through the controller-supplied gate wrapper. The recorder is awaited through
admission, execution and cleanup. Bun is 1.4.0.

The publication compiler command, `bunx tsc --noEmit`, exited 0 with no
diagnostics. The project's touched-test selection contains 84 explicit paths.

The first sequential campaign exited 124 at its one-hour execution limit.
It completed 63 files: 2691 pass, four failed assertions and two skips.
`engine.rolePrivacyEffects.part2.test.ts` was interrupted and its partial result
was left unadopted. The runner finished cleanup, and every process identity
named in its deadline and survivor diagnostics was absent before the fresh
remainder run. Completed file results were retained. Publication selection
and execution budgets remain unchanged.

The 15 changed TypeScript files at the merged source snapshot have aggregate
SHA-256 `7fd6c366da3c5943281deb01a0cffee7c3e0feee51a37a27c3f1e3dc7ac4da3d`
(sorted file-to-SHA-256 JSON with default JSON separators).

### Baseline comparison

Every failed branch assertion from the first campaign also failed on main
`2614b079`, with the same isolation and command. These are retained baseline
notes; the refresh adds no change to those tests or their deadlines.

| File | Branch pass / fail | Main pass / fail | Matching assertion |
|---|---:|---:|---|
| `src/lib/pipelines/engine.activation.test.ts` | 52 / 1 | 52 / 1 | Internal terminal publication recovery, #1692 |
| `src/lib/pipelines/engine.cloud.test.ts` | 133 / 1 | 132 / 2 | Remaining stage deadline, expired=false, size=70000 |
| `src/lib/pipelines/engine.proactive.part2.test.ts` | 50 / 2 | 6 / 2, filtered | Unadopted merge custody, head-changed and review-changed |

Main's Cloud run also failed the expired=true, size=70000 case. Thus the
earlier observation that this file passed on current main did not reproduce
in this fresh run. Both sides report that the real deadline did not settle
the submission for expired=false, size=70000.

The full proactive baseline exited 124 at its five-minute file limit after
showing both matching failures; it has no complete counts. After its recorded
descendants were confirmed gone, a complete fresh sample ran:

```sh
bun test --timeout=60000 src/lib/pipelines/engine.proactive.part2.test.ts \
  --test-name-pattern 'unadopted merge custody survives restart'
```

It exited 1: six pass, two fail, 44 filtered out, 101 assertions. Neither
matching baseline observation was cached as a publication receipt.

### Completed selection and final main refresh

The remainder campaign completed all 21 outstanding touched files and four
direct consumer files. Across the 84 touched files there were 3513 pass,
12 failed assertions, two skips and 29853 assertions. The four direct
consumer files passed all 220 tests and 1868 assertions. In particular,
`engine.settlement.test.ts` passed 121 tests, and
`repositoryInitialization.test.ts` passed all 40 tests, including Git-only
creation and publication.

Main advanced during these runs. A second conflict-free merge commit brought
in `3c086dfc`. All 15 feature source and test files remained byte-identical;
their aggregate fingerprint above is unchanged. The incoming runner change
preserves the Linux execution branch, while the comparator change adds
baseline-report wording. The Windows runner, launcher and workflow changes
are retained. The exact publication compiler command passed again on this
merged tree with exit 0 and no diagnostics.

Fresh integration checks on the second merge renew the five changed test
files, the four engine files with failed assertions, and the updated Linux
selection of 18 files. The command ledger below distinguishes these runs
from the earlier complete touched-file selection.

### Third-merge outcomes and complete command ledger

A third conflict-free merge integrated main `cb408fce` at source snapshot
`88853d99`. The 15 feature files still have the same fingerprint. The compiler
passed on this export. The latest integration pass renews the five changed
feature test files, all 18 Linux files, and both incoming cleanup test files.
Current-main samples reproduce all eleven remaining failed assertions:
eight routing cases, one activation case and two proactive-custody cases.

The complete Cloud rerun passed all 134 tests and 1301 assertions, including
all four remaining-stage-deadline cases, in 228.05 seconds. Its owned process
allowance was 900000 ms; its test limit stayed 60000 ms. The preceding
five-minute renewal had no complete counts and remains unadopted. Its recorded
descendants were confirmed gone before the complete rerun. The observed Cloud
failures varied across the earlier main/head runs; this complete run is
green. No product change or publication-budget change was made to obtain it.

The latest Linux selection passes 217 tests, with ten platform skips and 1043
assertions. The Linux backend probe passes all four checks. All five changed
feature test files pass again. Lint reports zero errors and eight existing
warnings. The extra compiler run labelled `types-latest` used the second
snapshot after an export setup error; it is retained as a duplicate and does
not certify the third merge. `types-current` is the corrected third-merge run.

The complete observations through the third merge for the 84 touched files total **3514 pass,
11 pre-existing failures, two skips, 29853 assertions**. The four additional
direct consumer files contribute **220 pass, zero fail, 1868 assertions**.
The tables retain every earlier completed run and each incomplete observation.

`G` expands to `bash "$GATE" --record "$CHECK_LOG"`; `T` expands to
`setsid --wait bash "$GATE"`. `GATE` is the controller-provided installed
wrapper. The commands run from their named scratch snapshot, with the fresh
isolation described above. Times are UTC on 2026-11-12. Driver exits include
the expected failed baseline samples and are recorded separately from the
comparison: **zero introduced assertions**. Unknown counts are never adopted.

| Run / snapshot | Command | Exit | Pass / fail / skip | Assertions | Seconds | Invoked UTC |
|---|---|---:|---|---:|---:|---|
| first / a06eb246 | `T bun test --timeout=60000 src/lib/forge/autoMerge.test.ts` | 0 | 176 / 0 / 0 | 2879 | 47.23 | 10:39:32 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 55 / 0 / 0 | 117 | 1.431 | 10:40:19 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 0 | 9 / 0 / 0 | 64 | 10.238 | 10:40:20 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/forge/postMerge.taskBinding.test.ts` | 0 | 10 / 0 / 0 | 55 | 9.097 | 10:40:30 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/forge/workLinks.test.ts` | 0 | 40 / 0 / 0 | 112 | 1.95 | 10:40:40 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/mcp/server.test.ts` | 0 | 103 / 0 / 0 | 2664 | 41.231 | 10:40:41 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 0 | 3 / 0 / 0 | 23 | 2.579 | 10:41:23 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/monitor/seatTickSources.test.ts` | 0 | 166 / 0 / 0 | 1051 | 43.514 | 10:41:25 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.accountGuard.test.ts` | 0 | 31 / 0 / 0 | 161 | 87.278 | 10:42:09 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.accounting.test.ts` | 0 | 8 / 0 / 0 | 66 | 15.284 | 10:43:36 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.activation.test.ts` | 1 | 52 / 1 / 0 | 332 | 49.927 | 10:43:51 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.capacity.test.ts` | 0 | 25 / 0 / 0 | 410 | 36.614 | 10:44:41 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.claudeCloud.test.ts` | 0 | 11 / 0 / 0 | 93 | 11.529 | 10:45:18 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.closeAttempts.test.ts` | 0 | 50 / 0 / 0 | 323 | 10.868 | 10:45:29 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts` | 1 | 133 / 1 / 0 | 1301 | 219.848 | 10:45:40 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.containment.test.ts` | 0 | 55 / 0 / 0 | 402 | 102.204 | 10:49:20 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.controllerPass.test.ts` | 0 | 74 / 0 / 0 | 732 | 74.383 | 10:51:02 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.controllerSnapshot.test.ts` | 0 | 2 / 0 / 0 | 7 | 5.583 | 10:52:17 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.cpuAdmissionPolling.test.ts` | 0 | 15 / 0 / 0 | 112 | 72.275 | 10:52:22 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.cpuQueue.test.ts` | 0 | 2 / 0 / 0 | 36 | 4.364 | 10:53:35 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.creation.test.ts` | 0 | 113 / 0 / 0 | 722 | 41.778 | 10:53:39 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.dependencies.test.ts` | 0 | 4 / 0 / 0 | 19 | 2.751 | 10:54:21 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.fencedMessage.test.ts` | 0 | 24 / 0 / 0 | 229 | 25.534 | 10:54:23 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.historyWrites.test.ts` | 0 | 10 / 0 / 0 | 108 | 7.239 | 10:54:49 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.launchLease.test.ts` | 0 | 15 / 0 / 0 | 15 | 25.95 | 10:54:56 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.mechanicalRecovery.test.ts` | 0 | 42 / 0 / 0 | 822 | 128.754 | 10:55:22 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.missingWorktree.test.ts` | 0 | 35 / 0 / 0 | 352 | 31.727 | 10:57:31 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.pauseMetadata.test.ts` | 0 | 19 / 0 / 0 | 47 | 5.157 | 10:58:03 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.ports.part2.test.ts` | 0 | 51 / 0 / 0 | 426 | 69.581 | 10:58:08 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.ports.part3.test.ts` | 0 | 18 / 0 / 0 | 658 | 75.519 | 10:59:17 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.ports.test.ts` | 0 | 81 / 0 / 0 | 1735 | 77.151 | 11:00:33 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.privacyCorrelation.test.ts` | 0 | 1 / 0 / 0 | 5 | 1.935 | 11:01:50 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.proactive.part2.test.ts` | 1 | 50 / 2 / 0 | 445 | 129.388 | 11:01:52 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.proactive.test.ts` | 0 | 41 / 0 / 0 | 170 | 76.847 | 11:04:01 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudget.test.ts` | 0 | 42 / 0 / 0 | 172 | 27.585 | 11:05:18 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetChains.part2.test.ts` | 0 | 18 / 0 / 0 | 82 | 48.832 | 11:05:46 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetChains.part3.test.ts` | 0 | 26 / 0 / 0 | 94 | 49.598 | 11:06:35 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetChains.test.ts` | 0 | 18 / 0 / 0 | 82 | 56.95 | 11:07:24 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetKinds.test.ts` | 0 | 28 / 0 / 0 | 147 | 34.46 | 11:08:21 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetOutput.part2.test.ts` | 0 | 5 / 0 / 0 | 15 | 50.177 | 11:08:56 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetOutput.part3.test.ts` | 0 | 6 / 0 / 0 | 18 | 118.027 | 11:09:46 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetOutput.test.ts` | 0 | 5 / 0 / 0 | 15 | 141.47 | 11:11:44 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetPoolOutput.part2.test.ts` | 0 | 5 / 0 / 0 | 15 | 165.688 | 11:14:05 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetPoolOutput.part3.test.ts` | 0 | 6 / 0 / 0 | 18 | 81.765 | 11:16:51 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetPoolOutput.test.ts` | 0 | 5 / 0 / 0 | 15 | 64.786 | 11:18:13 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerChains.part2.test.ts` | 0 | 32 / 0 / 0 | 304 | 43.217 | 11:19:18 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerChains.test.ts` | 0 | 16 / 0 / 0 | 96 | 52.209 | 11:20:01 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerReset.part2.test.ts` | 0 | 5 / 0 / 0 | 25 | 96.357 | 11:20:53 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerReset.part3.test.ts` | 0 | 27 / 0 / 0 | 177 | 73.81 | 11:22:29 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerReset.test.ts` | 0 | 18 / 0 / 0 | 96 | 94.178 | 11:23:43 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.providerSignals.test.ts` | 0 | 28 / 0 / 0 | 128 | 49.858 | 11:25:17 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.provisioning.test.ts` | 0 | 73 / 0 / 0 | 388 | 62.47 | 11:26:07 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.publication.test.ts` | 0 | 36 / 0 / 0 | 454 | 64.569 | 11:27:10 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.recoveredPending.test.ts` | 0 | 43 / 0 / 0 | 622 | 27.347 | 11:28:14 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.recovery.part2.test.ts` | 0 | 85 / 0 / 0 | 605 | 56.092 | 11:28:42 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.recovery.test.ts` | 0 | 67 / 0 / 1 | 521 | 58.69 | 11:29:38 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.recoveryAdmission.part2.test.ts` | 0 | 116 / 0 / 0 | 306 | 70.826 | 11:30:36 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.recoveryAdmission.test.ts` | 0 | 65 / 0 / 0 | 411 | 58.323 | 11:31:47 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.recoveryAuthority.part2.test.ts` | 0 | 86 / 0 / 0 | 478 | 76.552 | 11:32:46 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.recoveryAuthority.test.ts` | 0 | 98 / 0 / 0 | 388 | 72.014 | 11:34:02 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.restoreContinuation.test.ts` | 0 | 78 / 0 / 0 | 296 | 50.345 | 11:35:14 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.roleMemoryDispatch.test.ts` | 0 | 110 / 0 / 0 | 1155 | 198.161 | 11:36:04 |
| first / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.rolePrivacy.test.ts` | 0 | 20 / 0 / 1 | 178 | 40.228 | 11:39:23 |
| base / 2614b079 | `T bun test --timeout=60000 src/lib/pipelines/engine.activation.test.ts` | 1 | 52 / 1 / 0 | 332 | 64.833 | 11:41:05 |
| base / 2614b079 | `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts` | 1 | 132 / 2 / 0 | 1301 | 287.684 | 11:42:09 |
| base / 2614b079 | `T bun test --timeout=60000 src/lib/pipelines/engine.proactive.part2.test.ts` | 124 | unknown / unknown / unknown | unknown | 301.307 | 11:46:57 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.rolePrivacyEffects.part2.test.ts` | 0 | 26 / 0 / 0 | 26 | 81.518 | 11:56:23 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.rolePrivacyEffects.part3.test.ts` | 0 | 26 / 0 / 0 | 26 | 88.58 | 11:57:44 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.rolePrivacyEffects.test.ts` | 0 | 27 / 0 / 0 | 27 | 83.6 | 11:59:13 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.routing.test.ts` | 1 | 99 / 8 / 0 | 700 | 112.908 | 12:00:36 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.settlement.test.ts` | 0 | 121 / 0 / 0 | 1016 | 270.469 | 12:02:29 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.settlementAuthority.test.ts` | 0 | 1 / 0 / 0 | 15 | 5.014 | 12:07:00 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.settlementPreparation.test.ts` | 0 | 31 / 0 / 0 | 544 | 74.487 | 12:07:05 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.setupRecipe.test.ts` | 0 | 7 / 0 / 0 | 52 | 12.28 | 12:08:19 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.spawnRetry.test.ts` | 0 | 103 / 0 / 0 | 1091 | 106.866 | 12:08:32 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.spawnSilence.test.ts` | 0 | 25 / 0 / 0 | 132 | 36.02 | 12:10:19 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.succession.part2.test.ts` | 0 | 99 / 0 / 0 | 651 | 167.298 | 12:10:55 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.succession.part3.test.ts` | 0 | 105 / 0 / 0 | 530 | 150.622 | 12:13:42 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.succession.test.ts` | 0 | 32 / 0 / 0 | 149 | 124.274 | 12:16:12 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.suspendedRetry.test.ts` | 0 | 21 / 0 / 0 | 193 | 31.082 | 12:18:17 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.terminalBudget.test.ts` | 0 | 11 / 0 / 0 | 136 | 48.187 | 12:18:48 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.watchdogRegression.test.ts` | 0 | 5 / 0 / 0 | 17 | 6.151 | 12:19:36 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/store.archiveText.test.ts` | 0 | 3 / 0 / 0 | 36 | 1.383 | 12:19:42 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/store.cooperativeFreeze.test.ts` | 0 | 2 / 0 / 0 | 20 | 2.124 | 12:19:44 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/store.reads.test.ts` | 0 | 4 / 0 / 0 | 71 | 2.591 | 12:19:46 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/store.schemaCompatibility.test.ts` | 0 | 13 / 0 / 0 | 45 | 1.79 | 12:19:48 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/store.test.ts` | 0 | 61 / 0 / 0 | 382 | 8.916 | 12:19:50 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/done/project.test.ts` | 0 | 31 / 0 / 0 | 122 | 5.777 | 12:19:59 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/links/taskWire.test.ts` | 0 | 3 / 0 / 0 | 19 | 0.926 | 12:20:05 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/repositoryInitialization.test.ts` | 0 | 40 / 0 / 0 | 299 | 8.263 | 12:20:06 |
| remainder / a06eb246 | `T bun test --timeout=60000 src/lib/forge/autoMergeStore.test.ts` | 0 | 146 / 0 / 0 | 1428 | 69.73 | 12:20:14 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/forge/autoMerge.test.ts` | 0 | 176 / 0 / 0 | 2879 | 41.228 | 12:25:53 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 55 / 0 / 0 | 117 | 1.478 | 12:26:35 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 0 | 9 / 0 / 0 | 64 | 8.026 | 12:26:36 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/forge/postMerge.taskBinding.test.ts` | 0 | 10 / 0 / 0 | 55 | 6.441 | 12:26:44 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 0 | 3 / 0 / 0 | 23 | 3.261 | 12:26:51 |
| second / 3c086dfc | `T bun test --timeout=60000 src/lib/pipelines/engine.routing.test.ts` | 1 | 99 / 8 / 0 | 700 | 98.843 | 12:26:54 |
| second / 3c086dfc | `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts` | 1 | 133 / 1 / 0 | 1301 | 288.571 | 12:28:33 |
| second / 3c086dfc | `T bun test --timeout=60000 src/lib/pipelines/engine.activation.test.ts --test-name-pattern 'an internal terminal pass an older build left waiting on publication closes without the network'` | 1 | 0 / 1 / 0 | 2 | 3.638 | 12:33:21 |
| second / 3c086dfc | `T bun test --timeout=60000 src/lib/pipelines/engine.proactive.part2.test.ts --test-name-pattern 'unadopted merge custody survives restart'` | 1 | 6 / 2 / 0 | 101 | 50.529 | 12:33:25 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/pipelines/engine.routing.test.ts` | 1 | 99 / 8 / 0 | 700 | 223.222 | 12:34:16 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts` | 124 | unknown / unknown / unknown | unknown | 301.397 | 12:37:59 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/pipelines/engine.activation.test.ts --test-name-pattern 'an internal terminal pass an older build left waiting on publication closes without the network'` | 1 | 0 / 1 / 0 | 2 | 5.122 | 12:43:00 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/pipelines/engine.proactive.part2.test.ts --test-name-pattern 'unadopted merge custody survives restart'` | 1 | 6 / 2 / 0 | 101 | 64.824 | 12:43:05 |
| second / bb10c711 | `T bun test --timeout=60000 scripts/owned-runner.portable.test.ts` | 0 | 2 / 0 / 0 | 4 | 1.46 | 12:44:10 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/proc/memory.test.ts` | 0 | 17 / 0 / 0 | 27 | 1.074 | 12:44:12 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/proc/portable.test.ts` | 0 | 1 / 0 / 0 | 2 | 1.253 | 12:44:13 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/proc/darwinIdentity.test.ts` | 0 | 3 / 0 / 0 | 7 | 1.266 | 12:44:14 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/proc/index.test.ts` | 0 | 6 / 0 / 0 | 19 | 1.383 | 12:44:15 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/proc/windowsSnapshot.test.ts` | 0 | 14 / 0 / 0 | 36 | 1.155 | 12:44:17 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/proc/windowsIdentity.test.ts` | 0 | 6 / 0 / 1 | 12 | 1.07 | 12:44:18 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/proc/windowsCwd.test.ts` | 0 | 3 / 0 / 0 | 8 | 1.107 | 12:44:19 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/proc/windows.test.ts` | 0 | 16 / 0 / 5 | 157 | 1.428 | 12:44:20 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/processGroup.test.ts` | 0 | 15 / 0 / 2 | 31 | 1.164 | 12:44:21 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/platformHome.test.ts` | 0 | 5 / 0 / 0 | 16 | 1.097 | 12:44:22 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/runtime/localEndpoint.test.ts` | 0 | 5 / 0 / 0 | 15 | 1.04 | 12:44:24 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/scanner/describe.test.ts` | 0 | 59 / 0 / 2 | 482 | 7.424 | 12:44:25 |
| second / bb10c711 | `T bun test --timeout=60000 src/lib/state/durableJson.test.ts` | 0 | 6 / 0 / 0 | 31 | 0.97 | 12:44:32 |
| second / bb10c711 | `T bun test --timeout=60000 src/runtime-host/socket.test.ts` | 0 | 7 / 0 / 0 | 16 | 1.203 | 12:44:33 |
| second / bb10c711 | `T bun test --timeout=60000 src/runtime-host/runtimeHostFence.test.ts` | 0 | 6 / 0 / 0 | 14 | 1.261 | 12:44:34 |
| second / bb10c711 | `T bun test --timeout=60000 bin/server-runtime.test.ts` | 0 | 31 / 0 / 0 | 116 | 2.35 | 12:44:35 |
| second / bb10c711 | `T bun test --timeout=60000 bin/bind-guard.test.ts` | 0 | 15 / 0 / 0 | 50 | 1.758 | 12:44:38 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/forge/autoMerge.test.ts` | 0 | 176 / 0 / 0 | 2879 | 61.002 | 13:31:56 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 55 / 0 / 0 | 117 | 2.657 | 13:32:57 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 0 | 9 / 0 / 0 | 64 | 13.238 | 13:33:00 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/forge/postMerge.taskBinding.test.ts` | 0 | 10 / 0 / 0 | 55 | 12.721 | 13:33:13 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 0 | 3 / 0 / 0 | 23 | 5.033 | 13:33:26 |
| latest / 88853d99 | `T bun test --timeout=60000 scripts/owned-runner.portable.test.ts` | 0 | 2 / 0 / 0 | 4 | 1.96 | 13:33:31 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/proc/memory.test.ts` | 0 | 17 / 0 / 0 | 27 | 1.667 | 13:33:33 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/proc/portable.test.ts` | 0 | 1 / 0 / 0 | 2 | 1.372 | 13:33:35 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/proc/darwinIdentity.test.ts` | 0 | 3 / 0 / 0 | 7 | 1.141 | 13:33:36 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/proc/index.test.ts` | 0 | 6 / 0 / 0 | 19 | 1.485 | 13:33:37 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/proc/windowsSnapshot.test.ts` | 0 | 14 / 0 / 0 | 36 | 1.207 | 13:33:39 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/proc/windowsIdentity.test.ts` | 0 | 6 / 0 / 1 | 12 | 1.201 | 13:33:40 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/proc/windowsCwd.test.ts` | 0 | 3 / 0 / 0 | 8 | 1.285 | 13:33:41 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/proc/windows.test.ts` | 0 | 16 / 0 / 5 | 157 | 1.33 | 13:33:42 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/processGroup.test.ts` | 0 | 15 / 0 / 2 | 31 | 1.692 | 13:33:44 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/platformHome.test.ts` | 0 | 5 / 0 / 0 | 16 | 1.598 | 13:33:45 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/runtime/localEndpoint.test.ts` | 0 | 5 / 0 / 0 | 15 | 1.702 | 13:33:47 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/scanner/describe.test.ts` | 0 | 59 / 0 / 2 | 482 | 11.8 | 13:33:49 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/state/durableJson.test.ts` | 0 | 6 / 0 / 0 | 31 | 2.761 | 13:34:00 |
| latest / 88853d99 | `T bun test --timeout=60000 src/runtime-host/socket.test.ts` | 0 | 7 / 0 / 0 | 16 | 1.782 | 13:34:03 |
| latest / 88853d99 | `T bun test --timeout=60000 src/runtime-host/runtimeHostFence.test.ts` | 0 | 6 / 0 / 0 | 14 | 1.653 | 13:34:05 |
| latest / 88853d99 | `T bun test --timeout=60000 bin/server-runtime.test.ts` | 0 | 31 / 0 / 0 | 116 | 2.546 | 13:34:07 |
| latest / 88853d99 | `T bun test --timeout=60000 bin/bind-guard.test.ts` | 0 | 15 / 0 / 0 | 50 | 1.273 | 13:34:09 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/scanner/filesResponseResults.test.ts` | 0 | 6 / 0 / 0 | 28 | 1.784 | 13:34:10 |
| latest / 88853d99 | `T bun test --timeout=60000 src/lib/selfUpdate/retentionWorker.test.ts` | 0 | 44 / 0 / 0 | 102 | 6.659 | 13:34:12 |
| latest / cb408fce | `T bun test --timeout=60000 src/lib/pipelines/engine.routing.test.ts --test-name-pattern "$ROUTING_FAILURES"` | 1 | 0 / 8 / 0 | 37 | 11.133 | 13:34:19 |
| latest / cb408fce | `T bun test --timeout=60000 src/lib/pipelines/engine.activation.test.ts --test-name-pattern 'an internal terminal pass an older build left waiting on publication closes without the network'` | 1 | 0 / 1 / 0 | 2 | 3.421 | 13:34:30 |
| latest / cb408fce | `T bun test --timeout=60000 src/lib/pipelines/engine.proactive.part2.test.ts --test-name-pattern 'unadopted merge custody survives restart'` | 1 | 6 / 2 / 0 | 101 | 70.718 | 13:34:33 |
| interrupted / a06eb246 | `T bun test --timeout=60000 src/lib/pipelines/engine.rolePrivacyEffects.part2.test.ts` | unknown | incomplete; unadopted | — | — | — |
| focused base / 2614b079 | `G bun test --timeout=60000 src/lib/pipelines/engine.proactive.part2.test.ts --test-name-pattern 'unadopted merge custody survives restart'` | 1 | 6 / 2 / 0; 44 filtered | 101 | — | — |
| complete / bb10c711 | `G bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts` | 0 | 134 / 0 / 0 | 1301 | 228.05 | — |
| types / a06eb246 | `G bunx tsc --noEmit` | 0 | 0 diagnostics | — | — | — |
| types-final / bb10c711 | `G bunx tsc --noEmit` | 0 | 0 diagnostics | — | — | — |
| types-latest / bb10c711; duplicate | `G bunx tsc --noEmit` | 0 | 0 diagnostics | — | — | — |
| types-current / 88853d99 | `G bunx tsc --noEmit` | 0 | 0 diagnostics | — | — | — |
| backend / bb10c711 | `G bun scripts/verify-platform-backend.ts --expect linux` | 0 | 4 probes passed | — | — | — |
| lint / unchanged 15 files | `G bunx eslint $CHANGED_TS` | 0 | 15 files; 0 errors; 8 warnings | — | — | — |
| whole-file privacy | `T bun scripts/privacy-publication-gate.ts --require-known-values --paths $CHANGED_PATHS` | 0 | 17 files; 0 findings | — | — | — |

Recorded campaign commands (the per-file results above are authoritative):

| Command | Exit | Complete file counts |
|---|---:|---|
| `G python3 campaign.py head` | 124 | 63 complete; next file interrupted |
| `G python3 campaign.py base1 failed-tests.json` | 1 | 2 complete; proactive baseline interrupted |
| `G python3 campaign-v2.py head2 remainder-and-direct.json` | 1 | 25 complete |
| `G python3 campaign-v3.py final final-integration-tests.json` | 1 | 31 complete, including baseline samples |
| `G python3 campaign-v3.py last last-integration-tests.json` | 1 | 28 complete, including baseline samples |

The scratch driver, selections, timestamps, full output, exact exits and closed
recorder directories are retained in the stage evidence under
`successor-refresh/`. Copies are forensic evidence and were never submitted
as publication receipts. Privacy checks after the ledger write and commit are
reported in the stage handoff. Publication and PR creation belong to the
pipeline publisher.

Command variables:

```sh
CHANGED_TS='
src/lib/done/candidates.ts
src/lib/forge/autoMerge.test.ts
src/lib/forge/autoMerge.ts
src/lib/forge/issueDelivery.test.ts
src/lib/forge/issueDelivery.ts
src/lib/forge/issueDeliveryStore.test.ts
src/lib/forge/landedPullRequests.ts
src/lib/forge/postMerge.taskBinding.test.ts
src/lib/forge/workLinks.ts
src/lib/mcp/server.ts
src/lib/mcp/workLinks.test.ts
src/lib/monitor/seatTickSources.ts
src/lib/pipelines/engine.ts
src/lib/pipelines/store.ts
src/lib/pipelines/types.ts
'
CHANGED_PATHS='
docs/design/issue-closing-on-merge.md
docs/verification/issue-delivery.md
src/lib/done/candidates.ts
src/lib/forge/autoMerge.test.ts
src/lib/forge/autoMerge.ts
src/lib/forge/issueDelivery.test.ts
src/lib/forge/issueDelivery.ts
src/lib/forge/issueDeliveryStore.test.ts
src/lib/forge/landedPullRequests.ts
src/lib/forge/postMerge.taskBinding.test.ts
src/lib/forge/workLinks.ts
src/lib/mcp/server.ts
src/lib/mcp/workLinks.test.ts
src/lib/monitor/seatTickSources.ts
src/lib/pipelines/engine.ts
src/lib/pipelines/store.ts
src/lib/pipelines/types.ts
'
ROUTING_FAILURES='^(?:a\ descendant\ that\ outlives\ the\ runtime'"'"'s\ release\ is\ still\ signalled,\ and\ the\ attempt\ is\ replaced|a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ dead|a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ idle|a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ stalled|a\ stage\ conversation\ switched\ to\ another\ account\ continues\ on\ the\ message\ held\ for\ the\ switch\ and\ settles\ on\ the\ successor'"'"'s\ verdict\ without\ the\ fail\ edge\ \(\#1695\ K6c\)|a\ stage\ that\ keeps\ working\ after\ its\ turn\ ended\ keeps\ its\ host\ through\ the\ recovery\ tick\ and\ the\ deferred\ cursor\ write|an\ attempt\ that\ worked\ on\ after\ a\ restart\ and\ is\ stopped\ for\ silence\ later\ is\ not\ called\ a\ restart|an\ attempt\ that\ worked\ on\ after\ a\ restart\ and\ whose\ host\ is\ found\ gone\ later\ is\ not\ called\ a\ restart)$'
```


### Fourth merge and private App regression

A fourth clean merge integrated main `15099450` at `0176ec69`. The exact
compiler command passed again. All five issue-delivery test files, all 18 Linux
files and the incoming registry-view test passed. The Cloud file reported
132 pass and two failures; both 70000-size deadline cases also failed in the
fresh main sample. The earlier green Cloud observation remains historical.
The other eleven assertion failures matched the same filtered main samples.

Self-review then found a production permission gap: the issues-only App token
could not read the merged PR in a private repository. The production scheduler
regression failed on the unmodified implementation (three failures, one pass).
The repair adds a separate exact issue-delivery permission purpose, preserving
the existing issue-report and Git/PR purposes. The scope and shared consumers
are traced in `docs/design/issue-closing-on-merge.md#47-identity-permission-text`.

The following rows are complete observations preceding the repair.

| Run / snapshot | Command | Exit | Pass / fail / skip | Assertions | Seconds | Invoked UTC |
|---|---|---:|---|---:|---:|---|
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/forge/autoMerge.test.ts` | 0 | 176 / 0 / 0 | 2879 | 47.016 | 14:15:04 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 55 / 0 / 0 | 117 | 1.328 | 14:15:51 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 0 | 9 / 0 / 0 | 64 | 9.787 | 14:15:52 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/forge/postMerge.taskBinding.test.ts` | 0 | 10 / 0 / 0 | 55 | 8.953 | 14:16:02 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 0 | 3 / 0 / 0 | 23 | 3.684 | 14:16:11 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts` | 1 | 132 / 2 / 0 | 1301 | 294.453 | 14:16:14 |
| fourth / 0176ec69 | `T bun test --timeout=60000 scripts/owned-runner.portable.test.ts` | 0 | 2 / 0 / 0 | 4 | 1.951 | 14:21:09 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/proc/memory.test.ts` | 0 | 17 / 0 / 0 | 27 | 1.282 | 14:21:11 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/proc/portable.test.ts` | 0 | 1 / 0 / 0 | 2 | 1.248 | 14:21:12 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/proc/darwinIdentity.test.ts` | 0 | 3 / 0 / 0 | 7 | 1.322 | 14:21:13 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/proc/index.test.ts` | 0 | 6 / 0 / 0 | 19 | 1.555 | 14:21:15 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/proc/windowsSnapshot.test.ts` | 0 | 14 / 0 / 0 | 36 | 1.323 | 14:21:16 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/proc/windowsIdentity.test.ts` | 0 | 6 / 0 / 1 | 12 | 1.363 | 14:21:17 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/proc/windowsCwd.test.ts` | 0 | 3 / 0 / 0 | 8 | 1.339 | 14:21:19 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/proc/windows.test.ts` | 0 | 16 / 0 / 5 | 157 | 1.542 | 14:21:20 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/processGroup.test.ts` | 0 | 15 / 0 / 2 | 31 | 1.569 | 14:21:22 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/platformHome.test.ts` | 0 | 5 / 0 / 0 | 16 | 1.875 | 14:21:23 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/runtime/localEndpoint.test.ts` | 0 | 5 / 0 / 0 | 15 | 1.579 | 14:21:25 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/scanner/describe.test.ts` | 0 | 59 / 0 / 2 | 482 | 11.193 | 14:21:27 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/state/durableJson.test.ts` | 0 | 6 / 0 / 0 | 31 | 1.302 | 14:21:38 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/runtime-host/socket.test.ts` | 0 | 7 / 0 / 0 | 16 | 1.294 | 14:21:39 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/runtime-host/runtimeHostFence.test.ts` | 0 | 6 / 0 / 0 | 14 | 1.497 | 14:21:40 |
| fourth / 0176ec69 | `T bun test --timeout=60000 bin/server-runtime.test.ts` | 0 | 31 / 0 / 0 | 116 | 2.68 | 14:21:42 |
| fourth / 0176ec69 | `T bun test --timeout=60000 bin/bind-guard.test.ts` | 0 | 15 / 0 / 0 | 50 | 1.419 | 14:21:45 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/agent/sqliteRegistryStore.viewAccessors.test.ts` | 0 | 8 / 0 / 0 | 228 | 13.075 | 14:21:46 |
| fourth / 15099450 | `T bun test --timeout=60000 src/lib/pipelines/engine.routing.test.ts --test-name-pattern '^(?:a\ descendant\ that\ outlives\ the\ runtime'"'"'s\ release\ is\ still\ signalled,\ and\ the\ attempt\ is\ replaced&#124;a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ dead&#124;a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ idle&#124;a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ stalled&#124;a\ stage\ conversation\ switched\ to\ another\ account\ continues\ on\ the\ message\ held\ for\ the\ switch\ and\ settles\ on\ the\ successor'"'"'s\ verdict\ without\ the\ fail\ edge\ \(\#1695\ K6c\)&#124;a\ stage\ that\ keeps\ working\ after\ its\ turn\ ended\ keeps\ its\ host\ through\ the\ recovery\ tick\ and\ the\ deferred\ cursor\ write&#124;an\ attempt\ that\ worked\ on\ after\ a\ restart\ and\ is\ stopped\ for\ silence\ later\ is\ not\ called\ a\ restart&#124;an\ attempt\ that\ worked\ on\ after\ a\ restart\ and\ whose\ host\ is\ found\ gone\ later\ is\ not\ called\ a\ restart)$'` | 1 | 0 / 8 / 0 | 37 | 12.329 | 14:21:59 |
| fourth / 15099450 | `T bun test --timeout=60000 src/lib/pipelines/engine.activation.test.ts --test-name-pattern 'an internal terminal pass an older build left waiting on publication closes without the network'` | 1 | 0 / 1 / 0 | 2 | 3.014 | 14:22:12 |
| fourth / 15099450 | `T bun test --timeout=60000 src/lib/pipelines/engine.proactive.part2.test.ts --test-name-pattern 'unadopted merge custody survives restart'` | 1 | 6 / 2 / 0 | 101 | 55.828 | 14:22:15 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/pipelines/engine.routing.test.ts --test-name-pattern '^(?:a\ descendant\ that\ outlives\ the\ runtime'"'"'s\ release\ is\ still\ signalled,\ and\ the\ attempt\ is\ replaced&#124;a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ dead&#124;a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ idle&#124;a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ stalled&#124;a\ stage\ conversation\ switched\ to\ another\ account\ continues\ on\ the\ message\ held\ for\ the\ switch\ and\ settles\ on\ the\ successor'"'"'s\ verdict\ without\ the\ fail\ edge\ \(\#1695\ K6c\)&#124;a\ stage\ that\ keeps\ working\ after\ its\ turn\ ended\ keeps\ its\ host\ through\ the\ recovery\ tick\ and\ the\ deferred\ cursor\ write&#124;an\ attempt\ that\ worked\ on\ after\ a\ restart\ and\ is\ stopped\ for\ silence\ later\ is\ not\ called\ a\ restart&#124;an\ attempt\ that\ worked\ on\ after\ a\ restart\ and\ whose\ host\ is\ found\ gone\ later\ is\ not\ called\ a\ restart)$'` | 1 | 0 / 8 / 0 | 37 | 12.215 | 14:23:10 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/pipelines/engine.activation.test.ts --test-name-pattern 'an internal terminal pass an older build left waiting on publication closes without the network'` | 1 | 0 / 1 / 0 | 2 | 3.225 | 14:23:23 |
| fourth / 0176ec69 | `T bun test --timeout=60000 src/lib/pipelines/engine.proactive.part2.test.ts --test-name-pattern 'unadopted merge custody survives restart'` | 1 | 6 / 2 / 0 | 101 | 49.047 | 14:23:26 |
| private regression / original 0176ec69 | `T bun test --timeout=60000 src/lib/forge/issueDelivery.app.test.ts` | 1 | 1 / 3 / 0 | 11 | 2.326 | 14:53:28 |
| deadline sample / 15099450 | `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts --test-name-pattern '^the Cloud runtime enforces the remaining stage deadline:'` | 1 | 2 / 2 / 0 | not reported | 112.77 | 14:53:31 |


### Final merge and scoped App repair

The final clean merge integrates main `f97d31b9` at `adfbb880`, retaining its
bounded event windows and heap diagnostics. The working overlay adds the
private-repository permission repair. The checked code is unchanged by the
later verification-text update and delivery commit. The 20 changed code/test
files have aggregate SHA-256 `c2535e7d102fab332c6c39ecf55cd0b35a4e97c62ba37560faf059948a497fc6` (the same sorted JSON procedure above).

The exact compiler command passed after the repair and again after this merge.
All 13 direct-consumer files passed on both overlays: 717 pass, zero fail,
1 platform skip, 6043 assertions. This includes the real production
scheduler and copied helper: full closure, partial reopening, both missing
grants, conflicting purposes, preservation of an older helper copy, exact
permissions and revocation of overbroad issued tokens. The original report,
PR/Git credentials and App connection consumers also pass.

Fresh filtered head/main observations, including the isolated Cloud
reconciliation, reproduce the failed test identifiers in all four engine
files. The complete per-file observations for the current
87-path touched selection are recorded across the snapshots above: 3728 pass,
13 baseline failures, two skips and 30586 assertions. These are whole-file
observations; the final filtered comparisons are listed separately below.
No interrupted observation supplies counts. Git-only creation and publication
passed in the additional repository-initialization consumer file.

The nested Cloud fixture can print both child and parent summaries. Repeated
failure identifiers are deduplicated for comparison; the assertion column
uses the final parent summary and says `not reported` when it omits that count.
An inner child's count is never substituted for its parent's missing count.

The final four-case Cloud sample reported 3 pass / 1 fail on main and
2 pass / 2 fail on the branch. The expired=true, size=70000 case was then
run alone twice per side; all four observations failed with the same
`deadline was not armed before the held acknowledgement` harness bound.
Earlier observations failed at other phases and one complete run passed;
those diagnostics and counts are retained, without changing a product or test
deadline. The comparison is by the failed test identifier.

This stage runs explicit files and the requested compiler. The publisher owns
the complete pre-push hook, including its scoped runtime and native lanes;
that publication verdict is not claimed by this stage. No build or deployment
was performed by the builder.

| Run / snapshot | Command | Exit | Pass / fail / skip | Assertions | Seconds | Invoked UTC |
|---|---|---:|---|---:|---:|---|
| repair / 0176ec69 overlay | `T bun test --timeout=60000 src/lib/forge/issueDelivery.app.test.ts` | 0 | 5 / 0 / 0 | 26 | 2.459 | 15:15:51 |
| repair / 0176ec69 overlay | `T bun test --timeout=60000 bin/forge-app-token.test.ts` | 0 | 192 / 0 / 0 | 637 | 1.405 | 15:15:53 |
| repair / 0176ec69 overlay | `T bun test --timeout=60000 src/lib/forge/appWrite.test.ts` | 0 | 19 / 0 / 0 | 70 | 1.995 | 15:15:55 |
| repair / 0176ec69 overlay | `T bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 55 / 0 / 0 | 117 | 1.336 | 15:15:57 |
| repair / 0176ec69 overlay | `T bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 0 | 9 / 0 / 0 | 64 | 9.31 | 15:15:58 |
| repair / 0176ec69 overlay | `T bun test --timeout=60000 src/lib/forge/autoMerge.test.ts` | 0 | 176 / 0 / 0 | 2879 | 43.652 | 15:16:07 |
| repair / 0176ec69 overlay | `T bun test --timeout=60000 src/lib/forge/postMerge.taskBinding.test.ts` | 0 | 10 / 0 / 0 | 55 | 5.473 | 15:16:51 |
| repair / 0176ec69 overlay | `T bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 0 | 3 / 0 / 0 | 23 | 2.416 | 15:16:56 |
| repair / 0176ec69 overlay | `T bun test --timeout=60000 src/lib/monitor/githubEvidence.test.ts` | 0 | 56 / 0 / 0 | 249 | 1.124 | 15:16:59 |
| repair / 0176ec69 overlay | `T bun test --timeout=60000 src/lib/git/agentForgeCredentials.test.ts` | 0 | 82 / 0 / 1 | 799 | 20.325 | 15:17:00 |
| repair / 0176ec69 overlay | `T bun test --timeout=60000 src/lib/forge/appConnect.test.ts` | 0 | 46 / 0 / 0 | 276 | 17.198 | 15:17:20 |
| repair / 0176ec69 overlay | `T bun test --timeout=60000 bin/forge-app-connect.test.ts` | 0 | 10 / 0 / 0 | 48 | 1.994 | 15:17:37 |
| repair / 0176ec69 overlay | `T bun test --timeout=60000 src/lib/mcp/issueReport.test.ts` | 0 | 54 / 0 / 0 | 800 | 28.446 | 15:17:39 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/forge/issueDelivery.app.test.ts` | 0 | 5 / 0 / 0 | 26 | 1.603 | 15:30:39 |
| final / adfbb880 overlay | `T bun test --timeout=60000 bin/forge-app-token.test.ts` | 0 | 192 / 0 / 0 | 637 | 0.992 | 15:30:40 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/forge/appWrite.test.ts` | 0 | 19 / 0 / 0 | 70 | 1.583 | 15:30:41 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 55 / 0 / 0 | 117 | 0.95 | 15:30:43 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 0 | 9 / 0 / 0 | 64 | 6.34 | 15:30:44 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/forge/autoMerge.test.ts` | 0 | 176 / 0 / 0 | 2879 | 44.43 | 15:30:50 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/forge/postMerge.taskBinding.test.ts` | 0 | 10 / 0 / 0 | 55 | 9.073 | 15:31:35 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 0 | 3 / 0 / 0 | 23 | 4.494 | 15:31:44 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/monitor/githubEvidence.test.ts` | 0 | 56 / 0 / 0 | 249 | 2.192 | 15:31:48 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/git/agentForgeCredentials.test.ts` | 0 | 82 / 0 / 1 | 799 | 28.276 | 15:31:50 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/forge/appConnect.test.ts` | 0 | 46 / 0 / 0 | 276 | 24.802 | 15:32:19 |
| final / adfbb880 overlay | `T bun test --timeout=60000 bin/forge-app-connect.test.ts` | 0 | 10 / 0 / 0 | 48 | 2.435 | 15:32:43 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/mcp/issueReport.test.ts` | 0 | 54 / 0 / 0 | 800 | 51.343 | 15:32:46 |
| main / f97d31b9 | `T bun test --timeout=60000 src/lib/pipelines/engine.routing.test.ts --test-name-pattern '^(?:a\ descendant\ that\ outlives\ the\ runtime'"'"'s\ release\ is\ still\ signalled,\ and\ the\ attempt\ is\ replaced&#124;a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ dead&#124;a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ idle&#124;a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ stalled&#124;a\ stage\ conversation\ switched\ to\ another\ account\ continues\ on\ the\ message\ held\ for\ the\ switch\ and\ settles\ on\ the\ successor'"'"'s\ verdict\ without\ the\ fail\ edge\ \(\#1695\ K6c\)&#124;a\ stage\ that\ keeps\ working\ after\ its\ turn\ ended\ keeps\ its\ host\ through\ the\ recovery\ tick\ and\ the\ deferred\ cursor\ write&#124;an\ attempt\ that\ worked\ on\ after\ a\ restart\ and\ is\ stopped\ for\ silence\ later\ is\ not\ called\ a\ restart&#124;an\ attempt\ that\ worked\ on\ after\ a\ restart\ and\ whose\ host\ is\ found\ gone\ later\ is\ not\ called\ a\ restart)$'` | 1 | 0 / 8 / 0 | 37 | 10.254 | 15:33:37 |
| main / f97d31b9 | `T bun test --timeout=60000 src/lib/pipelines/engine.activation.test.ts --test-name-pattern 'an internal terminal pass an older build left waiting on publication closes without the network'` | 1 | 0 / 1 / 0 | 2 | 2.966 | 15:33:47 |
| main / f97d31b9 | `T bun test --timeout=60000 src/lib/pipelines/engine.proactive.part2.test.ts --test-name-pattern 'unadopted merge custody survives restart'` | 1 | 6 / 2 / 0 | 101 | 59.606 | 15:33:50 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/pipelines/engine.routing.test.ts --test-name-pattern '^(?:a\ descendant\ that\ outlives\ the\ runtime'"'"'s\ release\ is\ still\ signalled,\ and\ the\ attempt\ is\ replaced&#124;a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ dead&#124;a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ idle&#124;a\ replaced\ attempt\ names\ its\ cause\ when\ no\ restart\ happened:\ stalled&#124;a\ stage\ conversation\ switched\ to\ another\ account\ continues\ on\ the\ message\ held\ for\ the\ switch\ and\ settles\ on\ the\ successor'"'"'s\ verdict\ without\ the\ fail\ edge\ \(\#1695\ K6c\)&#124;a\ stage\ that\ keeps\ working\ after\ its\ turn\ ended\ keeps\ its\ host\ through\ the\ recovery\ tick\ and\ the\ deferred\ cursor\ write&#124;an\ attempt\ that\ worked\ on\ after\ a\ restart\ and\ is\ stopped\ for\ silence\ later\ is\ not\ called\ a\ restart&#124;an\ attempt\ that\ worked\ on\ after\ a\ restart\ and\ whose\ host\ is\ found\ gone\ later\ is\ not\ called\ a\ restart)$'` | 1 | 0 / 8 / 0 | 37 | 9.485 | 15:34:50 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/pipelines/engine.activation.test.ts --test-name-pattern 'an internal terminal pass an older build left waiting on publication closes without the network'` | 1 | 0 / 1 / 0 | 2 | 2.677 | 15:35:00 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/pipelines/engine.proactive.part2.test.ts --test-name-pattern 'unadopted merge custody survives restart'` | 1 | 6 / 2 / 0 | 101 | 61.454 | 15:35:02 |
| main / f97d31b9 | `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts --test-name-pattern '^the Cloud runtime enforces the remaining stage deadline:'` | 1 | 3 / 1 / 0 | not reported | 108.872 | 15:36:04 |
| final / adfbb880 overlay | `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts --test-name-pattern '^the Cloud runtime enforces the remaining stage deadline:'` | 1 | 2 / 2 / 0 | not reported | 119.61 | 15:37:53 |
| main / f97d31b9 | `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts --test-name-pattern '^the Cloud runtime enforces the remaining stage deadline: expired=true size=70000$'` | 1 | 0 / 1 / 0 | not reported | 10.851 | 15:52:33 |
| Cloud reconciliation / adfbb880 overlay | `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts --test-name-pattern '^the Cloud runtime enforces the remaining stage deadline: expired=true size=70000$'` | 1 | 0 / 1 / 0 | not reported | 13.154 | 15:52:44 |
| main / f97d31b9 | `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts --test-name-pattern '^the Cloud runtime enforces the remaining stage deadline: expired=true size=70000$'` | 1 | 0 / 1 / 0 | not reported | 11.815 | 15:52:57 |
| Cloud reconciliation / adfbb880 overlay | `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts --test-name-pattern '^the Cloud runtime enforces the remaining stage deadline: expired=true size=70000$'` | 1 | 0 / 1 / 0 | not reported | 11.655 | 15:53:09 |

| Check | Command | Exit | Counts | Seconds | Invoked UTC |
|---|---|---:|---|---:|---|
| types-fourth | `G bunx tsc --noEmit` | 0 | zero compiler diagnostics | 421.827 | 14:08:02 |
| types-auth | `G bunx tsc --noEmit` | 0 | zero compiler diagnostics | 398.510 | 15:09:12 |
| types-fifth | `G bunx tsc --noEmit` | 0 | zero compiler diagnostics | 243.082 | 15:26:36 |
| lint-fifth | `G bunx eslint $FINAL_CHANGED_CODE` | 0 | 20 files; zero errors; eight existing warnings | 25.627 | 15:39:52 |

`FINAL_CHANGED_CODE` expands to these explicit paths:

```text
bin/forge-app-token.mjs
bin/forge-app-token.test.ts
src/lib/done/candidates.ts
src/lib/forge/appWrite.fixture.ts
src/lib/forge/appWrite.ts
src/lib/forge/autoMerge.test.ts
src/lib/forge/autoMerge.ts
src/lib/forge/issueDelivery.app.test.ts
src/lib/forge/issueDelivery.test.ts
src/lib/forge/issueDelivery.ts
src/lib/forge/issueDeliveryStore.test.ts
src/lib/forge/landedPullRequests.ts
src/lib/forge/postMerge.taskBinding.test.ts
src/lib/forge/workLinks.ts
src/lib/mcp/server.ts
src/lib/mcp/workLinks.test.ts
src/lib/monitor/seatTickSources.ts
src/lib/pipelines/engine.ts
src/lib/pipelines/store.ts
src/lib/pipelines/types.ts
```

| Recorded driver | Exit | Complete file observations | Notes |
|---|---:|---:|---|
| Private regression and main Cloud sample | 1 | 2 | Original code is red for the private App regression; main sample retained. |
| Repair compiler and direct consumers | 0 | 13 | 717 pass, zero fail, one skip. |
| Final compiler, integration comparisons and lint | 1 | 21 | 734 pass, 25 failed test observations, one skip; comparison failures retained. Compiler and lint exit 0. |
| Isolated Cloud reconciliation | 1 | 4 | Zero pass, four matching harness failures; two fresh observations per side. |

The whole-file privacy scan covers all 23 changed repository paths and
the exact stage-report preview. The later commit publication scan also reads
the final verification text and commit metadata. Their terminal results are
retained with the handoff.

Whole-file privacy completed with exit **0**, covering all 23 changed paths
and the stage-report preview (24 files), with no findings.

| Command | Exit | Counts | Seconds | Invoked UTC |
|---|---:|---|---:|---|
| `G bun scripts/privacy-publication-gate.ts --require-known-values --paths $FINAL_CHANGED_PATHS docs/verification/stage-report-preview.txt` | 0 | 24 files; zero findings | 374.844 | 15:57:55 |

`FINAL_CHANGED_PATHS` is `FINAL_CHANGED_CODE` above plus `CONTRIBUTING.md`,
`docs/design/issue-closing-on-merge.md` and this verification record. The
post-commit command is `G bun run privacy:check`; its terminal verdict is
handed over separately after the commit, without editing the committed record.

Before the delivery commit, a final clean merge integrated main `a00b2189`
at `982ea8cc`. It changes only pull-request branch filters in five workflows,
AGENTS.md and the stage-branch guide. Its actual diff changes no program file,
dependency input, compiler setting or test command. The checked program and
test inputs remain byte-identical to the final `adfbb880` overlay, so those
compiler, lint and test results carry forward. The publication privacy scan
reads the additional merge metadata and this explanation.


## Committed-tree campaign

The complete 87-path selection was renewed from a fresh immutable export of
commit `5a5bb8da`, after the guarded delivery commit and its publication privacy
check. This section supersedes the earlier mixed-snapshot selection totals.
The comparison base is `a00b2189`; its program/test inputs are identical to
`f97d31b9`, used for the recorded matching baseline samples. No later main
change was mixed into this campaign.

Every file ran sequentially with its own owned runner, native Git first,
fresh HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, and the closed Viewer
control endpoint. Initial files used the 300000 ms owned-run limit and
60000 ms Bun test limit. Three files hit the owned-run limit without complete
counts. All fourteen process identities in their cleanup diagnostics were
confirmed gone before a fresh recovery. Those files and the spawn-retry
stderr assertion then ran in full on both main and head, with a 900000 ms
diagnostic owned-run allowance. The Bun test limit stayed 60000 ms. The
campaigns had three hours of execution headroom each; no publication budget
changed. Each record was awaited once through admission, execution and cleanup.

Across the latest complete observations for all 87 files: 3728 pass, 13 baseline failed
tests, 2 skips and 30534 reported parent-runner assertions. All failed
test identifiers have recorded main matches; no new failed identifier or
incomplete file result was adopted. The final code/test SHA-256 is unchanged
from the 20-file repair fingerprint above. The later ledger-only commit
changes no compiler or test input.

| Command | Exit | Pass / fail / skip | Assertions | Seconds | Invoked UTC |
|---|---:|---|---:|---:|---|
| `T bun test --timeout=60000 bin/forge-app-token.test.ts` | 0 | 192 / 0 / 0 | 637 | 1.955 | 2026-11-12T16:23:10+00:00 |
| `T bun test --timeout=60000 src/lib/forge/appWrite.test.ts` | 0 | 19 / 0 / 0 | 70 | 2.712 | 2026-11-12T16:23:11+00:00 |
| `T bun test --timeout=60000 src/lib/forge/autoMerge.test.ts` | 0 | 176 / 0 / 0 | 2879 | 49.068 | 2026-11-12T16:23:14+00:00 |
| `T bun test --timeout=60000 src/lib/forge/issueDelivery.app.test.ts` | 0 | 5 / 0 / 0 | 26 | 2.231 | 2026-11-12T16:24:03+00:00 |
| `T bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 55 / 0 / 0 | 117 | 1.122 | 2026-11-12T16:24:06+00:00 |
| `T bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 0 | 9 / 0 / 0 | 64 | 9.983 | 2026-11-12T16:24:07+00:00 |
| `T bun test --timeout=60000 src/lib/forge/postMerge.taskBinding.test.ts` | 0 | 10 / 0 / 0 | 55 | 7.339 | 2026-11-12T16:24:17+00:00 |
| `T bun test --timeout=60000 src/lib/forge/workLinks.test.ts` | 0 | 40 / 0 / 0 | 112 | 1.678 | 2026-11-12T16:24:24+00:00 |
| `T bun test --timeout=60000 src/lib/mcp/server.test.ts` | 0 | 103 / 0 / 0 | 2612 | 47.606 | 2026-11-12T16:24:26+00:00 |
| `T bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 0 | 3 / 0 / 0 | 23 | 2.861 | 2026-11-12T16:25:13+00:00 |
| `T bun test --timeout=60000 src/lib/monitor/seatTickSources.test.ts` | 0 | 166 / 0 / 0 | 1051 | 57.183 | 2026-11-12T16:25:16+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.accountGuard.test.ts` | 0 | 31 / 0 / 0 | 161 | 104.724 | 2026-11-12T16:26:13+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.accounting.test.ts` | 0 | 8 / 0 / 0 | 66 | 19.5 | 2026-11-12T16:27:58+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.activation.test.ts` | 1 | 52 / 1 / 0 | 332 | 73.241 | 2026-11-12T16:28:18+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.capacity.test.ts` | 0 | 25 / 0 / 0 | 410 | 50.533 | 2026-11-12T16:29:31+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.claudeCloud.test.ts` | 0 | 11 / 0 / 0 | 93 | 14.206 | 2026-11-12T16:30:21+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.closeAttempts.test.ts` | 0 | 50 / 0 / 0 | 323 | 16.202 | 2026-11-12T16:30:36+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts` | 124 | not reported / not reported / 0 | not reported | 300.615 | 2026-11-12T16:30:52+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.containment.test.ts` | 0 | 55 / 0 / 0 | 402 | 81.852 | 2026-11-12T16:35:52+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.controllerPass.test.ts` | 0 | 74 / 0 / 0 | 732 | 105.199 | 2026-11-12T16:37:14+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.controllerSnapshot.test.ts` | 0 | 2 / 0 / 0 | 7 | 8.038 | 2026-11-12T16:38:59+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.cpuAdmissionPolling.test.ts` | 0 | 15 / 0 / 0 | 112 | 84.295 | 2026-11-12T16:39:07+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.cpuQueue.test.ts` | 0 | 2 / 0 / 0 | 36 | 10.903 | 2026-11-12T16:40:32+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.creation.test.ts` | 0 | 113 / 0 / 0 | 722 | 109.836 | 2026-11-12T16:40:43+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.dependencies.test.ts` | 0 | 4 / 0 / 0 | 19 | 5.838 | 2026-11-12T16:42:32+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.fencedMessage.test.ts` | 0 | 24 / 0 / 0 | 229 | 68.7 | 2026-11-12T16:42:38+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.historyWrites.test.ts` | 0 | 10 / 0 / 0 | 108 | 16.533 | 2026-11-12T16:43:47+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.launchLease.test.ts` | 0 | 15 / 0 / 0 | 15 | 59.43 | 2026-11-12T16:44:04+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.mechanicalRecovery.test.ts` | 0 | 42 / 0 / 0 | 822 | 224.694 | 2026-11-12T16:45:03+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.missingWorktree.test.ts` | 0 | 35 / 0 / 0 | 352 | 79.646 | 2026-11-12T16:48:48+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.pauseMetadata.test.ts` | 0 | 19 / 0 / 0 | 47 | 10.006 | 2026-11-12T16:50:07+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.ports.part2.test.ts` | 0 | 51 / 0 / 0 | 426 | 114.175 | 2026-11-12T16:50:17+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.ports.part3.test.ts` | 0 | 18 / 0 / 0 | 658 | 184.685 | 2026-11-12T16:52:11+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.ports.test.ts` | 0 | 81 / 0 / 0 | 1735 | 224.072 | 2026-11-12T16:55:16+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.privacyCorrelation.test.ts` | 0 | 1 / 0 / 0 | 5 | 5.383 | 2026-11-12T16:59:00+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.proactive.part2.test.ts` | 124 | not reported / not reported / 0 | not reported | 300.599 | 2026-11-12T16:59:06+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.proactive.test.ts` | 0 | 41 / 0 / 0 | 170 | 163.546 | 2026-11-12T17:04:06+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudget.test.ts` | 0 | 42 / 0 / 0 | 172 | 71.334 | 2026-11-12T17:06:50+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetChains.part2.test.ts` | 0 | 18 / 0 / 0 | 82 | 143.199 | 2026-11-12T17:08:01+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetChains.part3.test.ts` | 0 | 26 / 0 / 0 | 94 | 116.994 | 2026-11-12T17:10:24+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetChains.test.ts` | 0 | 18 / 0 / 0 | 82 | 70.849 | 2026-11-12T17:12:21+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetKinds.test.ts` | 0 | 28 / 0 / 0 | 147 | 44.332 | 2026-11-12T17:13:32+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetOutput.part2.test.ts` | 0 | 5 / 0 / 0 | 15 | 71.02 | 2026-11-12T17:14:16+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetOutput.part3.test.ts` | 0 | 6 / 0 / 0 | 18 | 164.674 | 2026-11-12T17:15:27+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetOutput.test.ts` | 0 | 5 / 0 / 0 | 15 | 124.33 | 2026-11-12T17:18:12+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetPoolOutput.part2.test.ts` | 0 | 5 / 0 / 0 | 15 | 81.79 | 2026-11-12T17:20:17+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetPoolOutput.part3.test.ts` | 0 | 6 / 0 / 0 | 18 | 72.585 | 2026-11-12T17:21:38+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerBudgetPoolOutput.test.ts` | 0 | 5 / 0 / 0 | 15 | 63.873 | 2026-11-12T17:22:51+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerChains.part2.test.ts` | 0 | 32 / 0 / 0 | 304 | 30.755 | 2026-11-12T17:23:55+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerChains.test.ts` | 0 | 16 / 0 / 0 | 96 | 59.082 | 2026-11-12T17:24:26+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerReset.part2.test.ts` | 0 | 5 / 0 / 0 | 25 | 93.72 | 2026-11-12T17:25:25+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerReset.part3.test.ts` | 0 | 27 / 0 / 0 | 177 | 112.786 | 2026-11-12T17:26:58+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerReset.test.ts` | 0 | 18 / 0 / 0 | 96 | 86.97 | 2026-11-12T17:28:51+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.providerSignals.test.ts` | 0 | 28 / 0 / 0 | 128 | 42.127 | 2026-11-12T17:30:18+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.provisioning.test.ts` | 0 | 73 / 0 / 0 | 388 | 56.974 | 2026-11-12T17:31:00+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.publication.test.ts` | 0 | 36 / 0 / 0 | 454 | 72.367 | 2026-11-12T17:31:57+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.recoveredPending.test.ts` | 0 | 43 / 0 / 0 | 622 | 33.953 | 2026-11-12T17:33:10+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.recovery.part2.test.ts` | 0 | 85 / 0 / 0 | 605 | 147.642 | 2026-11-12T17:33:43+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.recovery.test.ts` | 0 | 67 / 0 / 1 | 521 | 123.138 | 2026-11-12T17:36:11+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.recoveryAdmission.part2.test.ts` | 0 | 116 / 0 / 0 | 306 | 123.171 | 2026-11-12T17:38:14+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.recoveryAdmission.test.ts` | 0 | 65 / 0 / 0 | 411 | 93.352 | 2026-11-12T17:40:17+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.recoveryAuthority.part2.test.ts` | 0 | 86 / 0 / 0 | 478 | 124.399 | 2026-11-12T17:41:51+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.recoveryAuthority.test.ts` | 0 | 98 / 0 / 0 | 388 | 125.328 | 2026-11-12T17:43:55+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.restoreContinuation.test.ts` | 0 | 78 / 0 / 0 | 296 | 62.175 | 2026-11-12T17:46:01+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.roleMemoryDispatch.test.ts` | 124 | not reported / not reported / 0 | not reported | 300.679 | 2026-11-12T17:47:03+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.rolePrivacy.test.ts` | 0 | 20 / 0 / 1 | 178 | 124.245 | 2026-11-12T17:52:03+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.rolePrivacyEffects.part2.test.ts` | 0 | 26 / 0 / 0 | 26 | 183.543 | 2026-11-12T17:54:08+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.rolePrivacyEffects.part3.test.ts` | 0 | 26 / 0 / 0 | 26 | 159.968 | 2026-11-12T17:57:11+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.rolePrivacyEffects.test.ts` | 0 | 27 / 0 / 0 | 27 | 137.76 | 2026-11-12T17:59:51+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.routing.test.ts` | 1 | 99 / 8 / 0 | 700 | 154.604 | 2026-11-12T18:02:09+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.settlement.test.ts` | 0 | 121 / 0 / 0 | 1016 | 257.346 | 2026-11-12T18:04:44+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.settlementAuthority.test.ts` | 0 | 1 / 0 / 0 | 15 | 4.385 | 2026-11-12T18:09:01+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.settlementPreparation.test.ts` | 0 | 31 / 0 / 0 | 544 | 75.025 | 2026-11-12T18:09:05+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.setupRecipe.test.ts` | 0 | 7 / 0 / 0 | 52 | 9.319 | 2026-11-12T18:10:20+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.spawnRetry.test.ts` | 1 | 102 / 1 / 0 | 1074 | 128.699 | 2026-11-12T18:10:30+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.spawnSilence.test.ts` | 0 | 25 / 0 / 0 | 132 | 63.121 | 2026-11-12T18:12:38+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.succession.part2.test.ts` | 0 | 99 / 0 / 0 | 651 | 151.034 | 2026-11-12T18:13:41+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.succession.part3.test.ts` | 0 | 105 / 0 / 0 | 530 | 90.284 | 2026-11-12T18:16:12+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.succession.test.ts` | 0 | 32 / 0 / 0 | 149 | 72.473 | 2026-11-12T18:17:43+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.suspendedRetry.test.ts` | 0 | 21 / 0 / 0 | 193 | 27.562 | 2026-11-12T18:18:55+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.terminalBudget.test.ts` | 0 | 11 / 0 / 0 | 136 | 44.26 | 2026-11-12T18:19:23+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/engine.watchdogRegression.test.ts` | 0 | 5 / 0 / 0 | 17 | 5.506 | 2026-11-12T18:20:07+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/store.archiveText.test.ts` | 0 | 3 / 0 / 0 | 36 | 1.456 | 2026-11-12T18:20:13+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/store.cooperativeFreeze.test.ts` | 0 | 2 / 0 / 0 | 20 | 3.278 | 2026-11-12T18:20:14+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/store.reads.test.ts` | 0 | 4 / 0 / 0 | 71 | 2.49 | 2026-11-12T18:20:17+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/store.schemaCompatibility.test.ts` | 0 | 13 / 0 / 0 | 45 | 2.032 | 2026-11-12T18:20:20+00:00 |
| `T bun test --timeout=60000 src/lib/pipelines/store.test.ts` | 0 | 61 / 0 / 0 | 382 | 9.826 | 2026-11-12T18:20:22+00:00 |

The three interrupted original results above remain unadopted. The recovery
commands below run with the diagnostic 900000 ms owned-run allowance; the
comparison base is a00b2189 and the head is the same 5a5bb8da source.

| Side | Command | Exit | Pass / fail / skip | Assertions | Seconds | Invoked UTC |
|---|---|---:|---|---:|---:|---|
| base | `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts` | 1 | 132 / 2 / 0 | 1301 | 179.619 | 2026-11-12T18:23:47+00:00 |
| head | `T bun test --timeout=60000 src/lib/pipelines/engine.cloud.test.ts` | 1 | 132 / 2 / 0 | 1301 | 306.782 | 2026-11-12T18:26:47+00:00 |
| base | `T bun test --timeout=60000 src/lib/pipelines/engine.proactive.part2.test.ts` | 1 | 50 / 2 / 0 | 445 | 247.436 | 2026-11-12T18:31:53+00:00 |
| head | `T bun test --timeout=60000 src/lib/pipelines/engine.proactive.part2.test.ts` | 1 | 50 / 2 / 0 | 445 | 230.558 | 2026-11-12T18:36:01+00:00 |
| base | `T bun test --timeout=60000 src/lib/pipelines/engine.roleMemoryDispatch.test.ts` | 0 | 110 / 0 / 0 | 1155 | 193.913 | 2026-11-12T18:39:51+00:00 |
| head | `T bun test --timeout=60000 src/lib/pipelines/engine.roleMemoryDispatch.test.ts` | 0 | 110 / 0 / 0 | 1155 | 364.68 | 2026-11-12T18:43:05+00:00 |
| base | `T bun test --timeout=60000 src/lib/pipelines/engine.spawnRetry.test.ts` | 0 | 103 / 0 / 0 | 1091 | 153.962 | 2026-11-12T18:49:10+00:00 |
| head | `T bun test --timeout=60000 src/lib/pipelines/engine.spawnRetry.test.ts` | 0 | 103 / 0 / 0 | 1091 | 141.156 | 2026-11-12T18:51:44+00:00 |

The guarded commit also passed `bun scripts/local-gate.ts pre-commit`: staged
whitespace was clean, and lint of its six staged code/test files introduced
zero errors. No hook override was used.

| Command | Exit | Counts | Seconds | Invoked UTC |
|---|---:|---|---:|---|
| `G bun run privacy:check` at 5a5bb8da | 0 | 23 changed paths plus commit metadata; zero findings | 15.097 | 2026-11-12T16:19:23+00:00 |

The same publication command is run after the ledger-only commit. Its
terminal status and the final commit identity are retained with the handoff.

The spawn-retry failure in the original campaign was an unexpected timing
diagnostic on stderr from a child that exited successfully. Its fresh full-file
main and head observations both pass all 103 tests and 1091 assertions. No
product or test change was made to obtain those results. The Cloud and
proactive files have matching full-file failed test identifiers on main and
head. Role-memory dispatch passes all 110 tests on each side.

The final ledger and exact stage-report preview also passed whole-file
privacy with zero findings.

| Command | Exit | Counts | Seconds | Invoked UTC |
|---|---:|---|---:|---|
| `G bun scripts/privacy-publication-gate.ts --require-known-values --paths docs/verification/issue-delivery.md docs/verification/stage-report-preview.txt` | 0 | 2 files; zero findings | 2.571 | 2026-11-12T18:55:39+00:00 |
