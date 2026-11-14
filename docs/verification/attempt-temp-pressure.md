# Attempt-temp pressure verification

This change is stacked on #4033. Main was merged to preserve W5 trash recovery.
Acceptance 4 remains incomplete: the cursor guarantees traversal progress, but
the implementation can still complete a pressure tick without deleting a root.

## Causes and implemented policy

The cause analysis is pinned to `47fbd4a6`; see
`docs/design/attempt-temp-pressure.md#base-causes` for the original file:line
citations. The cap previously increased the page size without shortening
evidence retention. Preliminary authority reads and repeated checkout/protection
walks consumed the tick; unvisited roots could regain their old queue position.
#4033 already supplied the shared parent/helper deadline and reply margin.

In the implementation:

- `src/lib/runtime/attemptTempRetention.ts:341` enables pressure above the
  existing 100 GiB cap or below 20 GiB available on the scratch filesystem.
- `src/lib/runtime/attemptTempRetention.ts:157` selects roots through a durable
  `(createdAt,directory)` cursor. Its checkpoint precedes asynchronous work.
- `src/lib/runtime/attemptTempRetention.ts:563` retains ended-owner eligibility;
  pressure removes unlinked captures with scratch. Ordinary retention continues
  below the cap. Orphans retain their existing minimum age.
- `src/lib/runtime/attemptTempRetention.ts:486` rechecks owner binding, recorded
  custody, linked report evidence and authority at dispatch. Keep markers,
  process references, checkout dependencies, sockets and container mounts remain
  fences. `src/lib/runtime/attemptTempProduction.ts:29` also protects a running
  attempt recorded inside a closed lane. W5 recovered-trash proof stays intact.
- `src/lib/runtime/attemptTempRetention.ts:747` bounds each pressure visit at
  five seconds within the existing 40-second work window. A normal pressure
  page has 32 roots; when it removes none, the default search can extend to
  1,024 distinct roots under the same deadline. Explicit diagnostic limits apply.

For an unchanged inventory of N roots, the visit bound is N admitted passes
when each admits only one root, or `ceil(N/32)` when full pages fit. A separate
test visits 1,000 tied records through 32 fresh processes. These are traversal
bounds. They do not establish the required nonzero-deletion guarantee.

The fixed 20 GiB threshold reserves space for state, checks and recovery writes
and activates before availability reaches the low tens of GiB. It requires no
new setting. The report records the threshold, availability, low-space mode,
allocation, reclaimed bytes and deferral/hold causes.

## Commands and results

Verification date: 2026-11-14 UTC. The final code sample was committed source
`d7abc16c4a`. The publication report added afterwards changes documentation only.
Every test used private HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR. Heavy
commands used the supplied installed gate; its contents matched the checkout's
`scripts/gate-slot.sh` (`cmp` exit 0). The sequential driver proved admission
reuse (`--reuse-slot` exit 0) before each explicit file command. Recorded runs
received one native foreground wait through execution and cleanup.

Each file row used this command, with its own RUN directory:

```sh
bash "$GATE" env HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/config" \
  LLV_STATE_DIR="$RUN/state" TMPDIR="$RUN/tmp" \
  bun test --timeout=60000 "$FILE"
```

| FILE | Latest successful explicit-file result | Exit |
| --- | --- | ---: |
| `src/lib/runtime/attemptTempRetention.test.ts` | 221 passed | 0 |
| `src/lib/runtime/attemptTempRetention.pressure.test.ts` | 18 passed | 0 |
| `src/lib/runtime/attemptTempRetention.permissions.test.ts` | 25 passed, 5 skipped | 0 |
| `src/lib/runtime/attemptTempRetention.liveness.test.ts` | 3 passed | 0 |
| `src/lib/runtime/attemptTempRetention.removalFences.test.ts` | 25 passed | 0 |
| `src/lib/runtime/attemptTempProduction.test.ts` | 65 passed, 1 skipped | 0 |
| `src/lib/runtime/attemptTempFilesystem.test.ts` | 66 passed, 14 skipped | 0 |
| `src/lib/runtime/attemptTempFilesystem.permissions.test.ts` | 27 passed, 5 skipped | 0 |
| `src/lib/pipelines/worktreeSweepDeadline.test.ts` | 21 passed | 0 |

The skips are opt-in container cases and the existing load benchmark.

The pre-push selection came directly from `plan("pre-push", files,
discover(root, base, files))`, with `files` from the committed diff against the
merge base. Its command was:

```sh
bun scripts/local-gate-tests.ts --base fe4d96e4726075b7d7609c5ca5dd9b545fa0b615 \
  ./src/lib/pipelines/worktreeSweepDeadline.test.ts \
  ./src/lib/pipelines/worktreeSweepWorker.test.ts \
  ./src/lib/runtime/attemptTempFilesystem.permissions.test.ts \
  ./src/lib/runtime/attemptTempFilesystem.test.ts \
  ./src/lib/runtime/attemptTempProduction.test.ts \
  ./src/lib/runtime/attemptTempRetention.pressure.test.ts \
  ./src/lib/runtime/attemptTempRetention.test.ts \
  ./src/lib/tempSweep.test.ts \
  ./src/lib/pipelines/store.cooperativeFreeze.test.ts \
  ./src/lib/pipelines/store.test.ts \
  ./src/lib/pipelines/store.reads.test.ts \
  ./src/lib/pipelines/store.archiveText.test.ts \
  ./src/lib/pipelines/store.schemaCompatibility.test.ts \
  ./src/lib/runtime/attemptTempRetention.permissions.test.ts \
  ./src/lib/runtime/attemptTempRetention.liveness.test.ts \
  ./src/lib/runtime/attemptTempRetention.removalFences.test.ts \
  ./src/lib/tempSweep.cap.test.ts
```

Exit 0: all 17 files complete with zero failures. The green head required no
baseline checkout or assertion sample. There are zero new failures against the
base in this selection. The earlier committed sample against `68d3bc37` also
passed the hook's 17-file selection.

The real-parent/helper fixture has 1,000 roots, initially five times its cap:
100 old roots carry 1 MiB payloads and 900 carry 4 KiB payloads. Each pass starts
a new helper with an injected clock. Three roots are live or pinned. Every pass
visits at most 32 roots and removes some. The observed result is three passes,
94,052,352 reclaimed bytes, 22,687,744 ledger bytes and 22,728,704 physical bytes
remaining against a 23,347,200-byte cap. The final report has `overCap: false`
and `failing: false`.

Additional commands and earlier observations:

| Command or run | Exit | Observation |
| --- | ---: | --- |
| Same retention file on `47fbd4a6` | 0 | 143 passed |
| Same filesystem file on `47fbd4a6` | 0 | 66 passed, 14 skipped |
| Same production file on `47fbd4a6` | 0 | 65 passed, 1 skipped |
| Same retention file on main `fe4d96e4` | 1 | One final-dispatch case failed in this observation |
| Initial pressure-file development runs 1–5 | 1 each | Fixture errors and the first uniform fixture's 180-second timeout; corrected before the final sample |
| Pressure development run 6 | 0 | First successful real-helper pressure fixture |
| Initial retention-file run | 1 | Policy expectations and namespace fixtures updated |
| First sequential direct campaign | 1 | Page-clock and preservation-fixture mismatches |
| Next sequential direct campaign | 1 | Mount-fence deferral and a stale state-read counter assertion |
| Refreshed changed-file campaign | 0 | All four files passed |
| First merged direct campaign | 1 | Two namespace assertions and the W5 zero-budget assertion |
| Final merged direct campaign and hook selection | 0 | Both direct files and all 17 selected files passed |
| Plain implementation, merge and compatibility commits | 0 each | Repository hooks ran; zero introduced lint errors |
| `bun scripts/privacy-publication-gate.ts --require-known-values --check-commits --base origin/main` on the implementation commit | 0 | Publication scan passed; final report text receives another scan before handoff |
| `git diff --check` | 0 | No whitespace errors |

The merged zero-budget test now expects the #4033 admission refusal and proves
that recovery enumeration never starts and the quarantine remains intact.

## Unresolved acceptance 4

A separate real-parent/helper probe supplies nine ended, unpinned roots. Eight
bounded measurement/proof steps consume 40,001 injected milliseconds. The first
tick visits eight roots, defers nine, removes zero and preserves every original
root identity and data-file size. The ninth root has no injected delay. A following control
tick removes it; the implementation removes all nine in that control. Thus the
first tick still reports zero removals while a removable root exists.

The same probe on `47fbd4a6` also reports zero initially; its control removes
the ninth root. Both diagnostic commands exit 0 because they assert and confirm
the counterexample. Their source and full logs are retained with stage evidence.
This is a pre-existing failure mode that this lane's stronger acceptance still
requires fixing. The serial proof scheduler needs another iteration and a
committed regression for this case. The green touched-tests selection does not
close this requirement.

No push or production action was performed. Publication and its required hosted
checks (`privacy-publication`, `privacy-tracker-audit`, `runtime-gate`,
`typecheck`) remain with the publishing stage after acceptance is complete.
