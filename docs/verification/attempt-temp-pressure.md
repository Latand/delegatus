# Attempt-temp pressure verification

## Current review regression files

The review corrections add explicit files for the automatic owner, approved
manifest execution, native removal races and persistent descendant inventory:

- `src/lib/runtime/attemptTempRetention.automatic.test.ts`: ordinary cleanup of
  expired registered scratch without pressure, live/protected/unknown holds,
  zero-cache roots beyond a protected prefix, and strict 24h−/24h/24h+ boundaries
  across real helper restarts. Legacy seven-day scheduling is upgraded once;
  copy lifetimes, keep markers and independent custody admissions survive.
- `src/lib/runtime/attemptTempRetention.safety.test.ts`: native removal held
  behind a child barrier while a lane tries to reopen; live inputs reached
  through flags, relative paths, aliases and symlink/parent traversal; evidence
  ancestry changes while the leaf inode stays unchanged.
- `src/lib/runtime/attemptTempRetention.inventoryRecovery.test.ts`: a real
  65,536-directory tree, helper restarts, a late keep marker in an already
  checkpointed descendant, and eventual retirement after its removal.
- `src/lib/runtime/attemptTempRetention.pressureScale.test.ts`: 1,000 real roots
  (128 eligible and 872 protected) under small real monotonic helper deadlines, first-tick deletion, cancellation
  and cold restarts, with live and keep roots surviving.
- `src/lib/runtime/attemptProtectionInventory.test.ts`: writer/reader output,
  quarantine rebasing, incomplete inventories and rejected escaping paths.
- `src/lib/runtime/attemptTempApproved.test.ts`: exact manifest/form binding,
  primary human decisions, hostile inputs, identity and shared retention holds,
  durable receipts, 32-row pages, strict completion-age boundaries and replacement
  names across helper restarts.

The automatic path and the manual approved list have separate inventories.
Neither path treats forgetting a vanished root's cached allocation as a
physical reclamation. Production free-space and throughput comparisons belong
to the authorized cleanup executor after review and deployment. Retained private
baseline reports distinguish physical scratch blocks, cached allocation,
outside-page observations and retention forecasts.

## Persistent-pass regression coverage

`src/lib/runtime/attemptTempRetention.pressurePass.test.ts` exercises a
1,000-root fixture under a synthetic small tick budget, the first-tick removal
and largest-first order, and completion within 250 ticks while reopening the
ledger between ticks. A companion 96-root fixture restarts the real helper
after the first and second ticks and reads the report from disk. It requires
completion within four ticks, removal of 95 roots and preservation of its keep root.
Its allocation clock spends one second per root of the 40-second tick;
native dispatch observations and the awaited removal port are fixture-owned
for deterministic scheduling. Removal still empties the real fixture
quarantine; the port rejects paths outside that fixture's scratch. Separate
removal-fence tests retain real kernel observations and owned subprocesses.

The negative multi-tick case protects live owners, process inputs, keep
markers, recorded custody and linked report evidence, adds protection and
restarts a lane after inventory creation, and tolerates vanished or forgotten
roots. Both the 1,000-root traversal and the protected multi-tick case fail on
`8ffc5d06`, which has no durable pass progress. Additional cases cover proof
reuse, expiry during an await, six-second proofs for large recorded roots,
a tree above the old 10,000-directory ceiling,
one discovery per pass and retention of the last full-pass report.

The updated acceptance also covers closed and completed lane roots with a
16 GiB sparse payload and 10,001 directories. A fixture port refuses a full
allocation walk. The real helper uses the native descendant protection fence
and must remove the root under a real monotonic deadline and a measured
40-second bound, with recorded allocation in the report. The sparse payload
exercises logical size without allocating 16 GiB on the test machine. A real SQLite writer lock on one root's
state defers that root while a sibling is removed, and a restarted helper
continues at the persisted next root. Separate cases cover busy bookkeeping
writes and the one-day grace for both absent-lane and unbound roots.
`src/lib/pipelines/worktreeSweepWorker.test.ts` holds a worktree request while
attempt retention must complete on its independent lease.

A read-only nested `node_modules` fixture has 512 package directories, read-only
files, an external symlink and an external hardlink. Before native removal,
every directory has gained only the owner bits, external file modes are
unchanged, and at most eight explicit path descriptors have been open. Failure
cases inject a permission-repair refusal and a partial native permission error:
the first preserves all data and its cause; the second retains the quarantine
journal and surviving payload. Both allow an independent sibling to retire.
Further negative cases submit stale group/other modes and rebind a directory
outside the admitted root before repair; outside permissions must survive.

See `docs/design/attempt-temp-pressure.md#persistent-pressure-passes` for
current scheduling and safety bounds. The verification records below describe
the earlier page scheduler and retain their original revisions and timings.

## Historical page-scheduler verification

This change originated on #4033. Current main was merged to preserve its
recovery fixes alongside W5 trash recovery.
The pressure scheduler reserves time for later roots and pages and gives the
candidate a full five-second window until a proof exhausts it. The real-parent regressions cover
both exhausted prefixes and uniform finite proof costs across helper restarts.
Scheduling and deletion fences are described in
`docs/design/attempt-temp-pressure.md#safety-and-scheduling`.

## Review corrections

Six counterexamples required additional changes:

- Standalone roots previously always received orphan authority. Keyed receipt
  and host reads now protect recorded live, starting and pending-resume owners
  even with an empty process snapshot. The observed facts are checked again at
  dispatch. The real parent/helper matrix covers scratch and config roots,
  over-cap and low-space modes, SQLite and legacy JSON, a transition to starting
  during the final reference observation, and a proven ended control.
- Dividing every visit by the page size starved a whole page of finite checks.
  Candidates now get the five-second ceiling until a proof exhausts it;
  completed holds and successful retirements keep that ceiling for later
  candidates. The regression has 33 roots, each
  with a 1,500 ms allocation or protection cost, and restarts the helper three
  times using the same ledger, with and without a protected first root.
  Slow-prefix regressions remain in place.
- Unreadable measurements previously replaced complete sizes with lower
  bounds. They now retain the greater of the previous size and the lower bound.
  Timeout and permission-denied fixtures preserve over-cap accounting across
  two helper starts, check physical allocation, and then verify recovery after
  complete measurement and safe removal become possible.
- A timeout followed by finite checks still starved every subsequent proof
  after helper restart. The remaining tick now retains separate full-proof
  and traversal budgets, with a full window reserved for the final search
  candidate. One timeout followed by 32 finite 1,500 ms checks, plus longer
  prefixes of eight and 32 timeouts followed by eight finite checks, cover allocation and protection, over-cap and
  low-space modes, and four helper restarts. Every pass with finite roots
  removes data; timeout roots retain their identity and bytes. Restoring the
  missing proofs then drains the same ledger and clears the failing condition.
  The durable cursor follows full-window visits, so fractional probes cannot
  restart the same timeout prefix forever. The mixed tests verify that each
  helper starts later in that prefix and that the oldest finite root behind
  eight timeouts is retired within three starts.
- A protected final root could leave every finite proof deferred after a
  timeout prefix. A separate reserve now funds retries of fractional probes
  from the tail, within the same tick and per-visit ceiling. These visits
  repeat all fences, retain the earlier cursor, and replace the provisional
  deferred outcome. Eight real-parent cases combine four or eight timeouts,
  32 finite 1,500 ms checks and a final keep root, across allocation/protection
  and over-cap/low-space. Each pass retires data, preserves timeout and keep
  roots, and stays within 40 seconds and 32 additional visits. Restoring proof
  and restarting the helper drains the same ledger to the protected bytes and
  clears the failing condition. Four further cases give the keep root a stale
  overestimate and prove that its fresh measurement clears cap pressure without
  any retry or retirement. Six additional controls give the protected tail
  the same 3,000 ms allocation cost as the finite roots, covering progress and
  cap recovery even when discovering the hold spends its own window.
  Two further cases restart the helper with an earlier ended root before the
  cursor and a protected suffix; both pressure modes must wrap and retire it
  within that same pass. The twenty cases live in
  `src/lib/runtime/attemptTempRetention.proofWindows.test.ts`, keeping each file
  below the pre-push comparator's five-minute budget.
- Multiple expensive keep roots could spend the retry reserve before an
  available ended root received a full proof. Retry admission now skips a
  root-level keep marker, retaining its provisional deferral without spending
  a retry slot or full window. Four additional real-parent cases reproduce
  eight exhausted proofs, one ended root needing 1,500 ms and forty keep
  roots needing the same proof, across allocation/protection and both pressure
  modes. All four fail on `98c8b4ca` with zero removals and 40,001 ms elapsed.
  With the fix each retires the ninth root in its first pass, reclaiming
  12,288 bytes in 33,026 ms (allocation) or 34,551 ms (protection). Protected
  inode identities and full payloads remain intact. All 24 proof-window cases
  pass, including the existing cheap-tail, costly-tail and restart controls.

The native mutation fence remains active in these fixtures. An ambient mount
change can refuse an otherwise available root. The slow-prefix recovery,
protected-tail and uniform-cost cases verify that refusal's unchanged inode and payload before
up to three additional helper starts. Only the named mount-namespace refusal
permits those extra recovery starts; budget starvation retains its assertions.

These cases use the existing pressure preload and production parent/helper.
The earlier verification campaigns below describe their named historical
revisions. Current command logs and committed-tree selection are retained in
the stage evidence; a green earlier revision does not certify these corrections.

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
- `src/lib/runtime/attemptTempRetention.ts` gives the first candidate a full
  window, then shares the remaining tick across unvisited roots until a
  retirement completes. One additional share is reserved for another page.
  Each visit retains the five-second ceiling within the
  existing 40-second work window. A normal pressure
  page has 32 roots; when it removes none, the default search can extend to
  1,024 distinct roots under the same deadline. Explicit diagnostic limits apply.

For an unchanged inventory of N roots, the visit bound is N admitted passes
when each admits only one root, or `ceil(N/32)` when full pages fit. A separate
test visits 1,000 tied records through 32 fresh processes. These are traversal
bounds. The slow-prefix regressions below separately establish retirement
progress when a later safe root can complete within its reserved window.

The fixed 20 GiB threshold reserves space for state, checks and recovery writes
and activates before availability reaches the low tens of GiB. It requires no
new setting. The report records the threshold, availability, low-space mode,
allocation, reclaimed bytes and deferral/hold causes.

## Earlier implementation checks (historical)

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

The earlier merged zero-budget test expects the #4033 admission refusal and proves
that recovery enumeration never starts and the quarantine remains intact.

## Original counterexample and continuation

A separate real-parent/helper probe supplies nine ended, unpinned roots. Eight
bounded measurement/proof steps consume 40,001 injected milliseconds. The first
tick visits eight roots, defers nine, removes zero and preserves every original
root identity and data-file size. The ninth root has no injected delay. A following control
tick removes it; the implementation removes all nine in that control. Thus the
first tick still reports zero removals while a removable root exists.

The same probe on `47fbd4a6` also reports zero initially; its control removes
the ninth root. Both diagnostic commands exit 0 because they assert and confirm
the counterexample. Their source and full logs are retained with stage evidence.
This was the remaining failure mode at `1d818d6333`.

The continuation merges `19b5e22d` with one conflict in
`src/lib/runtime/attemptTempRetention.test.ts`. It preserves both the zero-budget
admission-refusal case and the post-admission clock-exhaustion case from that
revision. The scheduler change is committed at `e3c0c4d216`.

`src/lib/runtime/attemptTempRetention.pressure.test.ts:199` commits the real
parent/helper regression, using the existing preload seam and an injected
clock. It covers both allocation and protection checks, plus a full slow page.
Before the scheduler change all three cases fail: eight visits spend 40,001 ms,
remove zero and defer the available root. After the change all three pass:

| Slow prefix | Injected time through the slow prefix | Checked | Deferred | Removed | Reclaimed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Eight allocation checks | 32,001 ms | 9 | 8 | 1 | 12,288 bytes |
| Eight protection checks | 32,001 ms | 9 | 8 | 1 | 12,288 bytes |
| 32 allocation checks | 38,789 ms | 33 | 32 | 1 | 12,288 bytes |

Each deferred original retains its device/inode and 4 KiB payload. A fresh
helper with the delays disabled removes the remaining eight or 32 roots using
the same durable ledger and cursor. The before command exits 1 (three failed
assertions); the after command exits 0 (three passed). Both use:

```sh
bun test --timeout=60000 src/lib/runtime/attemptTempRetention.pressure.test.ts \
  --test-name-pattern 'real parent retires'
```

Both commands run in scratch exports through the recorded gate, with a private
HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR and
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. The 40-second work deadline,
one-second reply margin, five-second visit ceiling and every deletion fence
remain in force. The pass reserves each later root's share before starting
earlier expensive work; it still defers a root whose own proof or removal
cannot finish safely in that share.

## Continuation checks

The full explicit-file campaign used scheduler source `e3c0c4d216`. Every row
below exited 0, with a fresh HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR
under the stage temp root and the Viewer control URL on closed port 1. Each
file ran in its own runner. The driver checked `--reuse-slot` before every
command; all admission-reuse checks exited 0. The command was the same
explicit-file command shown above. `d80938c17b` subsequently replaces two
BigInt literals with equivalent constructor calls and types the filesystem
mock's overloads; the pressure file is rerun after those fixture-only changes.
`de00edf962` makes the partial mock's overload assertion explicit through
`unknown`; this is erased at runtime. The final compiler run and hook selection
use that revision.

| Explicit test file | Passed | Skipped | Exit |
| --- | ---: | ---: | ---: |
| `src/lib/runtime/attemptTempRetention.test.ts` | 222 | 0 | 0 |
| `src/lib/runtime/attemptTempRetention.pressure.test.ts` | 21 | 0 | 0 |
| `src/lib/runtime/attemptTempRetention.permissions.test.ts` | 25 | 5 | 0 |
| `src/lib/runtime/attemptTempRetention.liveness.test.ts` | 3 | 0 | 0 |
| `src/lib/runtime/attemptTempRetention.removalFences.test.ts` | 25 | 0 | 0 |
| `src/lib/runtime/attemptTempProduction.test.ts` | 65 | 1 | 0 |
| `src/lib/runtime/attemptTempFilesystem.test.ts` | 66 | 14 | 0 |
| `src/lib/runtime/attemptTempFilesystem.permissions.test.ts` | 27 | 5 | 0 |
| `src/lib/pipelines/worktreeSweepDeadline.test.ts` | 21 | 0 | 0 |
| `src/lib/pipelines/worktreeSweepWorker.test.ts` | 38 | 0 | 0 |
| `src/lib/tempSweep.test.ts` | 88 | 0 | 0 |

The thousand-root real-parent fixture again reaches the cap in three passes:
94,052,352 bytes reclaimed, 22,687,744 ledger bytes and 22,732,800 physical
bytes remaining, against a 23,347,200-byte cap. Live and pinned roots survive.

The first TypeScript run exited 2 on the three fixture type errors corrected
above. Its next run exited 2 on the remaining overload assertion, corrected by
the explicit intermediate assertion. The first lint invocation exited 1 after
selecting thousands of unrelated files:
the scratch clone's `origin/main` initially tracked the source clone's older
local `main`. That result is an invalid lane comparison. The scratch remote ref
is now pinned to the source's `origin/main`; both checkouts resolve merge base
`fe4d96e4726075b7d7609c5ca5dd9b545fa0b615`. The final lint and pre-push
selection use that same base and the committed source tree.

Final source checks on `de00edf962`, 2026-11-14 UTC:

| Check | Result | Exit |
| --- | --- | ---: |
| Full pressure file after the BigInt changes | 21 passed | 0 |
| `bunx tsc --noEmit --incremental false` | No diagnostics | 0 |
| `bun scripts/eslint-changes.ts --base <merge-base> <changed-code-files...>` | 23 files, zero introduced errors | 0 |
| Official pre-push touched-tests selection | 17 complete files, zero failures and zero new failures against main | 0 |
| `git diff --check` | No whitespace errors | 0 |

The final hook selection again comes from `plan("pre-push", files,
discover(root, base, files))`. It is the same 17-path command listed above.
The all-green head needs no baseline sample. The final report commit changes
only these two documents; the scheduler, fixture code and selected tests retain
the verified blobs. Recorded logs, per-command exits, the selection's head/base
binding and the before/after regression manifest remain in stage evidence.

The publication privacy command, including commit messages and identities, is:

```sh
bun scripts/privacy-publication-gate.ts --require-known-values --check-commits \
  --base origin/main
```

The code and report scan exited 0 (`PRIVACY GATE: PASS`), resolving the range
from the merge base above. The same command checks the committed report before
handoff; its exit and full output are retained with stage evidence.

No push or production action was performed. Publication and its required hosted
checks (`privacy-publication`, `privacy-tracker-audit`, `runtime-gate`,
`typecheck`) remain with the publishing stage after acceptance is complete.
