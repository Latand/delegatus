The Viewer must stop pausing for seconds (operator requirement standing since 2026-10-14). The initial reproduction, taken before implementation on an export of `c91603e0`, measured 6.51–7.78 seconds between main-loop timer callbacks during a sweep of 930 retained fixture trees.

The production timer now asks one leased `worktree-sweep` child for a pass. Input loading, physical-path resolution, process scans, filesystem proofs, measurement, quarantine and report persistence execute there. The request has a 45-minute deadline, followed by the existing helper guardian's bounded group cleanup. The helper follows its Viewer owner and release. `worktrees.sweep` labels the Viewer's asynchronous wait; input lock admission uses `waitForStateLock`. The child receives the existing `tool` owner before imports and cannot perform the serving Viewer's startup migrations.

`WorktreeSweepCache` owns `worktree-sweep-cache.json` and the directory observers in that child. Its keys include owner epoch, observer generation, root identity and timestamps, retention/reason context, and nested-root exclusions. Directory events invalidate the complete observed view. Installation checks parent identities again to refuse partial observer coverage. A new worker epoch revalidates persisted rows because changes during its downtime cannot be excluded. The existing persisted sweep report continues to provide the display bootstrap.

Bounds are 2,048 roots, 200,000 retained inode contributions, 32,768 native directory watches, a 24 MiB serialized cache and a 24-hour observation lifetime. Discovery lists also have per-root count and byte limits. Inventory entries use LRU eviction; observer admission retires the oldest registered view. Both close the retired observers. Trees beyond coverage or inventory bounds fall back to fresh measurement in the child. Cached inode contributions preserve shared-file, namespace-alias and nested-root accounting in the current report order.

Cached discovery supplies candidate paths; cached allocation supplies diagnostic bytes. Removal eligibility, recent-write and busy holds, fresh ignored/tracked-file proofs, HEAD locks, quarantine validation, removal intents and the 200-removal cap retain their original checks. Warm-cache integration tests introduce nested evidence, live conversation ownership and recent writes after an awaited Git read and confirm that trimming refuses each one.

In production, the child is the cache’s only producer and reader. `runWorktreeSweep` and `startWorktreeSweep` retain the environment modes and schedule. Explicit injected ports keep their in-process test seam. The existing report writer, `readWorktreeSweepReport`, `worktreeSweepStatus` and resource consumers keep the report shape. The new webpack worker entry is included in standalone tracing. No changes reach the activity, seat-tick or profiler implementations, or `tempSweep.ts`.

The final repetition uses the same 930 trees and 93,930 files in separate source exports, under Bun 1.4.0 and the same 300% CPU gate. It injects no additional load; ambient 1/5/15-minute load averages and calling-process CPU usage are retained in `evidence/worktree-sweep.json`. Each pass keeps the same 1,860 root/nested decisions and the same allocated-byte totals. The Git, forge, registry and process inputs are synthetic, so these measurements establish responsiveness and reuse on this fixture; they do not estimate a production pass's wall time.

| Pass | Before max loop interval | After max loop interval | Before elapsed | After elapsed |
| --- | ---: | ---: | ---: | ---: |
| 1 | 6287.80 ms | 9.24 ms | 8.24 s | 11.19 s |
| 2 | 5967.80 ms | 2.46 ms | 7.87 s | 7.18 s |
| 3 | 5750.06 ms | 2.11 ms | 7.47 s | 6.58 s |

The first child pass is cold. Both warm passes reuse all 1,860 allocation inventories and all 930 discovery inventories without adding a measurement miss. The interval sampler includes scheduler delay; it reports observed loop blocking rather than claiming an exact CPU profile. The initial reproduction preceded source changes; the table repeats the baseline with the final measurement driver.

To reproduce, export the baseline and candidate into owned scratch directories, provide matching dependencies, and copy the candidate's measurement driver into the baseline export. Choose fresh isolated HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR for each command. Run the baseline first with `--in-process`, then the candidate without that flag, using the identical `SWEEP_FIXTURE` directory. Each command produces three JSON records:

```sh
# From each isolated export, through the project's admission wrapper:
SWEEP_FIXTURE="$FIXTURE_COPY" bash scripts/gate-slot.sh bun scripts/measure-worktree-sweep.ts --in-process
SWEEP_FIXTURE="$FIXTURE_COPY" bash scripts/gate-slot.sh bun scripts/measure-worktree-sweep.ts
```

Verification runs explicit test paths only. The original 311 sweep tests remain unchanged. Their first isolated baseline and candidate runs both had 157 fixture failures because the empty safe Git template omitted `info/exclude`; seeding that isolated template with an empty exclude file made all 311 candidate tests pass. The 19 new cache/worker tests and nine configuration/loop-monitor tests pass. Coverage includes owner restart and full-cache admission after restart, deep-file invalidation, replaced roots, observation races, shared inodes, eviction and bounds, unavailable watches, malformed/oversized replies, unexpected child exit, and deadline cleanup of a SIGTERM-resistant process. Full typecheck, ESLint, the production build and two passes through the actual webpack worker are checked in isolated state. Hosted privacy-publication, privacy-tracker-audit and runtime-gate remain required and await publication; this stage does not push.
