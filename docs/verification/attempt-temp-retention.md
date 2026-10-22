# Attempt temp lifetime

## Observation before implementation

Read-only observations on 2026-10-22, approximately 16:15–16:26 UTC, against
base `6b5d8509`. Another cleanup was running concurrently. Directory counts
and samples describe discovery time; a disappearing entry made some `du`
invocations exit 1. Those byte counts are lower bounds. Nothing in this lane
removed live files or changed the running service.

The procedure enumerated direct children with `os.scandir`, kept directories
without following links, sorted paths, then ran `du -s -B1 --` on the first
30 directories in each kind (five for the later gate-prefix sample). Nested
export/evidence observations inspected only the stage root and its `tmp`
child in the same 30-stage sample. Counts are samples, not estimates of the
unsampled population. Parent and nested rows overlap and must not be summed.

| Kind | Discovered roots | Sampled roots | Allocated bytes observed |
| --- | ---: | ---: | ---: |
| Stage scratch | 475 | 30 | 14,730,051,584 (partial) |
| Review exports within sampled stages | 12 | 12 | 2,071,097,344 |
| Evidence/frame roots within sampled stages | 6 | 6 | 189,399,040 (partial) |
| Merger batches within sampled stages | 0 | 0 | 0 |
| Publication/check roots within sampled stages | 1 | 1 | 90,112 |
| Local gate roots in secondary system temp | 55 | 5 | 1,585,152 |
| Test-comparison roots in secondary system temp | 72 | 5 | 159,879,168 |
| Legacy shared spawn sandbox | 1 | 1 | 13,917,282,304 |

The initial broader temp-prefix sample also found 186 `delegatus-` roots in
secondary system temp (30 sampled: 19,215,593,472 bytes), 75 in system temp
(30 sampled: 5,332,185,088 bytes), and one `merge-` root in secondary system
temp (10,137,600 bytes). The later discovery found 453 stage roots, showing
why these observations cannot be treated as a static census.

## Creation and prior cleanup inventory

Line anchors name the final source; descriptions of prior behavior were checked
against the base revision before implementation.

| Kind | Creation / owner | Prior removal |
| --- | --- | --- |
| Stage scratch and stage TMPDIR | `src/lib/runtime/structuredSpawn.ts:200`, `materializeStructuredHostAccess` | A synchronous recursive callback on host release; no attempt ownership persisted across Viewer restarts. |
| Review exports | `scripts/review-export.ts:34`, under stage TMPDIR | Error cleanup at line 53; successful export waits for enclosing stage scratch cleanup. |
| Evidence roots | `scripts/capture-directory.ts:86`, capture-owned child of TMPDIR | Allocation-error cleanup at line 90; successful captures remain for consumers. `src/lib/prototypeReview/store.ts:118` copies published review media into its separate durable publication store. |
| Merger batches and resolution roots | `scripts/merge-batch.ts:507`, `scripts/merge-batch.ts:1205`, under the merger run TMPDIR | The enclosing stage owns run files. Linked Git checkouts are retained for the existing worktree preservation procedure. |
| Publication text checks | `src/lib/pipelines/stagePullRequest.ts:148` | Its `finally` at line 176 removes the check directory. |
| Local publication gate roots | `scripts/local-gate.ts:199`, `scripts/local-gate-tests.ts:358` | `finally` at lines 841 and 447; individual test roots also have a `finally` at line 318. These scripts are owned by the adjacent gate lane. |
| Merger gate/privacy roots | `scripts/merge-batch.ts:607`, `scripts/merge-batch.ts:1002` | `finally` at lines 633 and 1019. |
| Gate admission monitor roots | `scripts/gate-slot.sh:118` | EXIT/INT/TERM traps call `end_cpu_wait`, which removes its recorded directory at line 113. |
| Spawn config/state sandboxes | `src/lib/runtime/agentConfigSandbox.ts:58` | Previously shared by account beneath the system temp root; deliberately excluded from the stale sweep. New pipeline attempts use their own ledger-owned sandbox. |
| Test process temp roots | `src/lib/tempDirs.ts:59`, `test-preload.ts` | Test teardown releases the owned root; the stale sweep handles interrupted runs. |

Earlier answers were searched with project-scoped and unscoped transcript and
memory queries for scratch cleanup, retention, `tempDirs`, `llv-stage-` and
1957. The transcript conclusion at 2026-10-11 07:41:40 UTC reports the earlier
preload cleanup coverage and a pre-existing preload failure. The read-only
audit conclusion at 2026-10-14 22:05:54 UTC confirms #1957 as the earlier scratch
ownership work and reproduces the subsequent deep-freshness defect in #2889.
The current source has the later full-tree freshness and quarantine safeguards;
this change preserves them for legacy roots. No private transcript text or
transcript location is published here.

## Ownership and retirement

The structured spawn boundary commits a root ledger entry before starting an
agent. The entry binds the exact launch and pipeline ids to the directory
inode/device identity. Both structured spawn paths pass the existing durable
pipeline membership. Each attempt gets scratch plus a config/state sandbox in
the mounted home cache, outside the operator state tree. The home path names
the same filesystem in Viewer and agent mount namespaces; container temp paths
can name different filesystems.

Producers are `materializeStructuredHostAccess` and its two production callers.
Consumers are the config sandbox environment builder, the leased sweep worker,
and the existing stale sweeper. The host-release callback marks roots due.
The attempt tick independently reads the persisted attempt, so settlement does
not depend on the old host callback surviving. Startup/adoption creates a new
root for its generation; previous roots remain indexed. The config sandbox
builder uses the declared attempt root before its legacy account default.
Both child config variables resolve inside that root; forwarded forge config
keeps its existing contract.

Passed, failed, skipped and parked attempts are eligible after their last live
process leaves. Checkout symlinks into an attempt root keep it through lane completion or explicit
close, including idle intervals between stages. Explicitly retired startup launches are matched in the
attempt's retained launch history. Declared stage outputs retain their scratch until lane completion or explicit
close. Both completed and explicitly closed lanes use the terminal cleanup
state; remaining process holders still retain their roots. Config sandboxes can retire at settlement. Published prototype media is
already copied into the durable publication store and remains governed by that
store. Missing lane records are orphan candidates after the configured age;
an unreadable owner or unmatched launch stays held. A registered owner marker
keeps the legacy sweep from bypassing this decision.

Removal uses the existing durable quarantine intent and inode/snapshot checks.
Authority is read again after measurement and after quarantine. Each delete
also refreshes process references (cwd, files, mappings, argv and directory
environment), mount checks and physical path identity. A late holder restores
the original directory. Pins, unreadable/oversized trees and linked Git
worktrees stay held. Disposable standalone test repositories inside a registered
attempt root can retire. Worktree retirement remains owned by its existing
preservation procedure.

## Bounds and settings

The separate `attempt-temp.sqlite` ledger selects due rows through an index.
A normal minute tick examines at most four roots; measured usage above the cap
raises that bound to 32. The due checkpoint commits before asynchronous work,
so helper restarts preserve fairness. New roots enter at their creation time,
so arrivals cannot jump ahead of a due retry. A process-shared asynchronous
file transaction owns each tick through its journal writes. Overlapping Viewer
generations serialize their workers; a dead worker's lock is recovered using
the existing process-identity check. Admission waits are bounded and recorded.
Registered roots use streamed native
inspection and allocation commands, each
bounded to 15 seconds. Legacy snapshots and Windows inspection retain their
200,000-entry ceiling. A constrained cleanup container can inspect and remove
container-owned files and measure their allocations; its own 12-second watchdog also runs after helper loss.
Registered roots and recovery intents use point reads; the
tick does not enumerate sibling roots or load the pipeline registry. Ownership
reads address one lane. The leased helper has a 60-second attempt-tick deadline
and is reaped on timeout. No filesystem walk runs on the Viewer loop.

`LLV_ATTEMPT_TEMP_CAP_BYTES` defaults to 107374182400 (100 GiB), and
`LLV_ATTEMPT_TEMP_MAX_AGE_DAYS` defaults to 1. The total is the ledger allocation
estimate across registered scratch, config and adopted gate roots; new or
unmeasured trees can make it a lower bound. Old orphan roots evict oldest first. Settled roots
are reclaimed even below the cap. Live processes, open-lane evidence and
preservation holds take priority over reclamation; over-cap held usage is
reported. `LLV_TEMP_SWEEP=off` disables retirement and `dry-run` records decisions
without removal. The existing hourly sweep remains the legacy fallback.
It adopts at most 32
interrupted gate roots per pass, using the exact publication/check and admission-monitor
prefixes; linked checkout and process guards still apply. Namespace-reader
aliases stay with the existing lease-bound legacy sweep. Shared lock roots
are never adopted.

Each retired root emits its directory count and attributed bytes before the
next candidate is inspected. Completed ticks write `attempt-temp-report.json`
and emit aggregate counts, bytes, hold/error counts and measured over-cap bytes. This work makes no performance improvement
claim and changes no deployment or worktree-retirement policy.

## Verification

Both behavioral regressions were run on base `6b5d8509` in scratch exports with
isolated state. The baseline export copied the production settlement and cap
regressions into that revision, shared matching dependencies read-only, and ran:

```sh
bun run test src/lib/runtime/attemptTempProduction.test.ts src/lib/tempSweep.cap.test.ts -t 'production settlement|a capped stale sweep'
```

Both failed: settlement left its fresh scratch present, and the one-removal
sweep selected the newer alphabetic root. The original 71 temp-sweep tests
also passed on that base.

The full publication gate passed with zero failures in all 11 touched test
files and all 17 scoped Linux test files. Types, privacy and changed-file
ESLint passed. The command was:

```sh
gate-remote -- env LLV_OWNED_RUN_TIMEOUT_MS=1800000 bun scripts/local-gate.ts pre-push
```

The remote wrapper supplies private home, config, temp and state roots plus a
closed control endpoint. Its comparator runs each explicit test file in fresh
isolation. The shared quarantine consumer was also checked separately with
`gate-remote -- bun scripts/local-gate-tests.ts --base 6b5d8509
src/lib/pipelines/worktreeSweep.test.ts`: a complete green head needed no base
sample.

Coverage includes real helper restarts, arrival fairness, the default 100 GiB
cap changing the removal budget from 32 back to four across restarted helpers,
concurrent helper admission and recovery after the lock owner is killed,
authority changes during filesystem inspection, late holders, idle checkout
links, evidence retention, canonical path aliases, damaged Git metadata,
quarantine replacement and recovery after a refused removal. Directory-reader
races inject at the streaming reader used by production. The Unix-socket case
uses a held directory descriptor so it also fits the comparator's deep roots.

The remote runner has no Docker executable. The optional Docker case ran
locally through the project gate in a scratch export with the locked dependency
graph and isolated roots. A real container created a private 4 MiB payload
owned by another uid. A pin retained it; after the pin was removed, namespace
cleanup retired it and reported at least the payload's allocated bytes. No
running installation or pre-existing directory was removed by these checks.
