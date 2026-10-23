# CPU admission lock verification

The implementation originated in Codex Cloud result 28. The supplied `28.diff`
passed its pinned SHA-256 check before application:
`8826a96e5a1f215e609d9d9ed9de14e5df566a1baf9a7b3fdb61d89f3e5ae8b1`.
Its source base was `adce5764927f7e838f20070cd2968128912e861c`.
Initial application and comparative tests used
`f348d75bd0012871867ebc63908a69b7b9e65b1c`. Before the commit, main advanced to
`a9e60a0d55c76c0b6b15b9134506e3feace8eeca`, and the assigned branch was
fast-forwarded to it. Its changes are confined to
`src/lib/memory/roleProblems.test.ts` and
`src/lib/monitor/seatTickSources.test.ts`, with no overlap in this patch.
All six verified source/test hashes survived that integration unchanged.
The combined-tree typecheck also passed after the fast-forward.
Verification ran on 2026-10-23.

## Scope and overlap

`scripts/cpu-admission-lock.ts` retries `SQLITE_BUSY` and `SQLITE_LOCKED`
through asynchronous backoff. The first contention starts one 30-second
monotonic deadline, retained across queue opening and subsequent checks.
A waiting episode prints its start and, after success, its acquisition;
exhaustion refuses the helper with a clear message. The helper opens SQLite with zero
busy timeout, captures its owner before opening can yield, and retains owner
checks and cancellation during the wait. Other queue callers retain their
existing five-second default. Constructor failures close the connection;
lock-sensitive setup statements execute separately.

`scripts/gate-slot.sh` propagates failed claims; exit 75 retains the existing
slot-race retry. Tests cover both shell paths, with and without `flock`.

Main already includes the pre-push dispatch change from #3278. The
`pre_push_parent` block and remote-runner dispatch block were compared with
main and remain byte-for-byte identical. The open Cloud result 26 lane was
read at the beginning and rechecked before completion: its overlap in
`scripts/gate-slot.sh` is a comment in the earlier remote-runner section.
This change adds the later claim handling. No changes from that lane were
copied. `.github/workflows` remains unchanged.

## Commands and exit codes

Command spellings below omit the output-only `rtk proxy` prefix. `$CLOUD_DIFF`
denotes the supplied patch. `$GATE_WRAPPER` denotes the prescribed stage-owned
wrapper locally, or the unchanged main wrapper on the native runner. A stable
main wrapper admitted the final runner batch; tests inside it exercised the
branch's helper and shell code. CPU admission and owned-process containment
remained enabled for the enclosing checks.

Each test table entry is the exit code of this command, with `$FILE` replaced
by that row's repository-relative path:

```sh
env HOME="$case/home" XDG_CONFIG_HOME="$case/config" \
  LLV_STATE_DIR="$case/state" TMPDIR="$case/tmp" \
  LLV_VIEWER_CONTROL_URL="$closed_control_url" \
  LLV_OWNED_RUN_TIMEOUT_MS="$file_budget" \
  setsid bash "$GATE_WRAPPER" bun run test "./$FILE" </dev/null
```

Every invocation got fresh private directories. The control endpoint was a
closed loopback port. File budgets were five minutes, extended to fifteen
minutes for the larger comparator file in later runs. Each batch ran files
sequentially, printed their individual results, and ended with a checked run
count. Scratch repositories were detached clones sharing the corresponding
source repository's origin; no delivery commits were made in them.

The final runner installed dependencies through `bun install --frozen-lockfile`
(exit 0): Bun 1.4.0, SDK 1.32.0, Next 16.4.1, TypeScript 5.9.3.

MR = initial native main; ML = local main; BL1 = first local branch snapshot;
BL2 = corrected local fixtures; BR = final native branch. Commas retain every
whole-file repeat. A dash means that phase did not run that file.

| `$FILE` | MR | ML | BL1 | BL2 | BR |
| --- | --- | --- | --- | --- | --- |
| `scripts/cpu-admission-lock.test.ts` | 1 | — | 1 | 0 | 0 |
| `src/lib/runtime/cpuAdmission.test.ts` | 0 | 1 | 1 | — | 0 |
| `src/lib/runtime/cpuAdmissionScope.test.ts` | 0 | — | 0 | — | 0 |
| `src/lib/runtime/cpuPressure.test.ts` | 0 | — | 0 | — | 0 |
| `scripts/gate-slot.queue.test.ts` | 0 | 1 | 1 | 1 | 0 |
| `scripts/local-gate.cpuQueue.test.ts` | 0 | — | 0 | — | 0 |
| `scripts/local-gate-tests.cpuQueue.test.ts` | 0 | 1 | 1 | — | 0 |
| `src/lib/pipelines/engine.cpuAdmissionPolling.test.ts` | 1 | 0, 0, 0 | 0, 0, 0 | — | 0 |
| `src/lib/pipelines/engine.cpuQueue.test.ts` | 0 | — | 0 | — | 0 |
| `src/lib/workflows/engine.cpuAdmission.test.ts` | 0 | — | 0 | — | 0 |
| `scripts/gate-slot.test.ts` | 0 | — | 0 | — | 0 |
| `scripts/gate-runner/client.test.ts` | 1 | 1 | 1 | — | 1 |
| `scripts/local-gate-tests.test.ts` | 0 | 1 | 1 | — | 0 |
| `src/lib/state/declaredIndexes.test.ts` | 0 | — | 0 | — | 0 |
| `src/lib/pipelines/testGuidance.test.ts` | — | 0 | 0 | — | 0 |
| `src/lib/runtime/cpuAdmissionBudget.test.ts` | — | 0 | 0 | — | 0 |

The four explicitly required suites passed on the final native branch:
20 lock tests, 39 admission tests, 11 shell queue tests and 2 local-gate
routing tests. The workflow file retains 32 explicitly skipped retired cases;
the pipeline file retains five such skips and the index file retains two
opt-in history skips. These existing skips were not changed.

| Other command or verification | Exit code |
| --- | --- |
| `sha256sum "$CLOUD_DIFF"` and Python assertion against the pinned digest | 0 |
| `git apply --check "$CLOUD_DIFF"` | 0 |
| `git apply "$CLOUD_DIFF"` | 0 |
| `git fetch origin main` (initial and repeated overlap checks) | 0 |
| `git merge --ff-only origin/main` | 0 |
| Python verification of all six source hashes after the main fast-forward | 0 |
| Python comparison of main's pre-push and runner blocks against the working tree | 0 |
| Python byte comparison of all six source/test files against the final scratch snapshot | 0 |
| `git diff --exit-code origin/main -- .github/workflows` | 0 |
| `git diff --check` (repeated after changes) | 0 |
| Initial local `bash "$GATE_WRAPPER" bun x tsc --noEmit --incremental false` | 2 |
| Final native `bash "$GATE_WRAPPER" bun x tsc --noEmit --incremental false` | 0 |
| Post-main native `bash "$GATE_WRAPPER" bun x tsc --noEmit --incremental false` | 0 |
| Initial local and final native `bash "$GATE_WRAPPER" bun x eslint scripts/cpu-admission.ts scripts/cpu-admission-lock.ts scripts/cpu-admission-lock.test.ts scripts/gate-slot.queue.test.ts src/lib/runtime/cpuAdmission.ts` | 0, 0 |
| `bash -n scripts/gate-slot.sh` (initial, corrected and final snapshots) | 0 |
| `bun scripts/privacy-publication-gate.ts --require-known-values --base f348d75bd0012871867ebc63908a69b7b9e65b1c --paths <changed-source-files>` with committed fingerprints | 0 |
| Final privacy inspection with `--base a9e60a0d55c76c0b6b15b9134506e3feace8eeca --paths <all-seven-changed-files>` and committed fingerprints | 0 |
| Python reconciliation of per-file result lines with each completed batch's run count | 0 |

Outer runner dispatches used `gate-remote -- ...`; local dispatches used the
prescribed stage-owned wrapper with `LLV_GATE_RUNNER=off`. Their outcomes are
retained separately from the individual test verdicts:

| Batch | File commands completed | Outer exit code |
| --- | --- | --- |
| Initial per-file baseline dispatch, stopped before any tests started to group admission | 0 | 143 |
| Grouped native main baseline | 14 | 0 |
| First branch runner dispatch, refused at the shared lock deadline before tests started | 0 | 1 |
| Local baseline and first branch snapshot | 24 | 1 |
| Local main comparison and corrected fixtures | 6 | 0 |
| Final native branch with frozen dependencies | 16 | 1 |
| Post-main native typecheck | 0 | 0 |

A batch exit of 0 records completion where the loop deliberately continued
through failed files. Individual verdicts are the table entries above.
The final native batch exited 1 solely for the existing runner-classification
assertion described below; its types, lint and shell checks all exited 0.

## Failed observations and their disposition

- Main has no `scripts/cpu-admission-lock.test.ts`; its requested baseline
  invocation exited 1 with no matching file. The new file passed all 20 cases
  in both corrected local and final native runs.
- `scripts/gate-runner/client.test.ts:129` fails the same environment
  classification assertion on main and branch, locally and natively.
  `LLV_SOUND_CAPTIONS_OUT` and `LLV_VOICE_DEVICES_OUT` lack classes. This
  independent failure was retained and left outside this change.
- The first native main run of
  `src/lib/pipelines/engine.cpuAdmissionPolling.test.ts:140` measured 1942 ms
  against a 1950 ms minimum. Three subsequent complete local main runs,
  three complete local branch runs and the final native branch run passed.
  No filtered reruns were used to classify that observation.
- Local main and branch reproduce the same priority observation failure in
  `src/lib/runtime/cpuAdmission.test.ts`, the native-owner and nested-wait
  barriers in `scripts/gate-slot.queue.test.ts`, the nested-wait assertion in
  `scripts/local-gate-tests.cpuQueue.test.ts`, and the cross-namespace lease
  refusal in `scripts/local-gate-tests.test.ts`. Every file was compared in
  full with the same local isolation. All four files pass on the final native
  runner. No namespace guard was relaxed.
- The first new cancellation fixture supplied a sibling PID, outside the
  adapter's parent/self contract. It now uses the real parent. The first shell
  fixture omitted the CPU-wait monitor added by `realExec`; it now implements
  that monitor. All new cases pass in the final snapshots.
- Initial local types found stream-iteration errors in the new tests and an
  SDK diagnostic from shared dependencies older than the lockfile. The tests
  now read streams through readers. The final frozen-dependency typecheck is
  clean; shared installed dependencies were not modified.
- The first branch runner dispatch printed wait/acquisition lines for brief
  contention and later refused when the one shared lock deadline expired.
  No checks started in that attempt. Final native verification used main's
  existing admission wrapper and exercised the branch code in private
  fixtures, including successful recovery, bounded failure and cancellation.

## Verified source bytes

These are the six source/test inputs used by the final native verification.
The evidence document itself is not a test input.

| File | SHA-256 |
| --- | --- |
| `scripts/cpu-admission.ts` | `82b3aad518de2b64b57aae84327a973bea1b802100ad7fb0a07dc2b9081b058e` |
| `scripts/cpu-admission-lock.ts` | `649f5bc29ee06a99d6540fc62a2991c6dd6b2dc24a98734690660f53c1de2f64` |
| `scripts/cpu-admission-lock.test.ts` | `65b534eeecae32317b89f96273330fca98783ad13e189e7e99f132b002e38b62` |
| `scripts/gate-slot.sh` | `64dbbbe91bb82a30ee80135afd59596a1043809ab0c5eab2daef24608c9cb2ad` |
| `scripts/gate-slot.queue.test.ts` | `c24c1f9b740416c3dbc0c1c3f25fd141f25998ad40b550f4634a909e1b1bc73c` |
| `src/lib/runtime/cpuAdmission.ts` | `6dbcfb29707eaeed106cb65b228148d87d3ea9dfc6989af1fd81c6b6b5a53ba9` |


## Review fixes and revalidation

Recorded 2026-10-23T23:57:07+00:00. This section supersedes the earlier lock-test source
hash and adds the review-fix observations; the original run remains above.
The pinned Codex Cloud result 28 checksum was rechecked and matches.

`Dockerfile:269` now copies `scripts/cpu-admission-lock.ts` with its importing
helper. `scripts/cpu-admission-lock.test.ts:38` reads the runtime stage's
actual gate-script COPY list, constructs that layout with the shipped source,
bin tree, aliases and dependencies, and requires `--reuse-slot` to exit 75
with empty output when no lease exists.

`scripts/cpu-admission-lock.test.ts:78` starts the real helper in a subprocess
against an independent SQLite writer. IPC barriers release the opening lock
after 80 controlled milliseconds, then acquire another writer lock before a
later check. The helper must refuse at the original 120 ms deadline. An earlier
queue ticket keeps the helper polling on systems without flock. Only the
monotonic clock and asynchronous sleep are controlled; both contention episodes
use real SQLite operations. An external five-second watchdog bounds the child,
and cleanup awaits its exit before releasing the writer.

The compared main revision is `fd7a0a14e75725b8d612237bf5a4413b0081e9a3`.
The branch export starts at `8c6a6d4cdefcc43674bb52024a90a157b3308904`
with the two source changes identified by the final hashes below. Main later
advanced through unrelated account credential handling and native compaction
test changes. Rechecking through `97bdb94ea9dfe32dff8a7bf022eeb2f83d8f02b7`
found no changes to this task's source or test files. The earlier remote-runner
shell comment remains separate from this change. Workflows are unchanged.

Both batches ran through the prescribed stage wrapper and `gate-remote`, one
at a time. Each file ran sequentially with setsid, stdin from the null device,
an external timeout, and fresh private HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and
TMPDIR directories. The Viewer control endpoint was a closed loopback port;
the test preload retained its owned-process supervision. The native runner
installed frozen dependencies and used Bun 1.4.0.

Inside the admitted batch, each test command was:

```sh
setsid timeout --signal=TERM --kill-after=15s "$BUDGET" \
  bun run test "./$FILE" </dev/null
```

The initial batch completed 50 commands: 23 branch files, 22 existing main
files, types, lint, shell syntax and two mutation probes. Its run counts were
reconciled against the explicit file manifest. The final batch completed seven
commands: the full lock suite, both runner integration files, types, lint and
both mutations. It kept all logs outside the export tree until tests ended.
The table uses the final observations for files repeated in that batch.

| Test file | Main exit | Branch exit |
| --- | --- | --- |
| `scripts/cpu-admission-lock.test.ts` | absent | 0 |
| `src/lib/runtime/cpuAdmission.test.ts` | 0 | 0 |
| `scripts/gate-slot.queue.test.ts` | 0 | 0 |
| `scripts/local-gate.cpuQueue.test.ts` | 0 | 0 |
| `src/lib/runtime/cpuAdmissionScope.test.ts` | 0 | 0 |
| `src/lib/runtime/cpuPressure.test.ts` | 0 | 0 |
| `scripts/local-gate-tests.cpuQueue.test.ts` | 0 | 0 |
| `src/lib/pipelines/engine.cpuAdmissionPolling.test.ts` | 0 | 0 |
| `src/lib/pipelines/engine.cpuQueue.test.ts` | 0 | 0 |
| `src/lib/workflows/engine.cpuAdmission.test.ts` | 0 | 0 |
| `scripts/gate-slot.test.ts` | 0 | 0 |
| `scripts/gate-runner/client.test.ts` | 1 | 1 |
| `scripts/local-gate-tests.test.ts` | 0 | 0 |
| `src/lib/state/declaredIndexes.test.ts` | 0 | 0 |
| `src/lib/pipelines/testGuidance.test.ts` | 0 | 0 |
| `src/lib/runtime/cpuAdmissionBudget.test.ts` | 0 | 0 |
| `scripts/dockerfile-permissions.test.ts` | 0 | 0 |
| `scripts/docker-image-scope.test.ts` | 1 | 1 |
| `scripts/gate-runner/remote.test.ts` | 0 | 0 |
| `scripts/gate-runner/remoteLifecycle.test.ts` | 0 | 0 |
| `scripts/gate-slot.namespace.integration.test.ts` | 0 | 0 |
| `scripts/owned-runner.integration.test.ts` | 0 | 0 |
| `src/lib/runtime/sandboxGateRunner.integration.test.ts` | 0 | 0 |

The four required branch suites pass 74 tests in total: 22 lock tests,
39 admission tests, 11 shell queue tests and two local queue tests. Main has
no lock-test file. Existing retired and opt-in skips remain: 32 workflow
cases, five pipeline cases, two index cases, five namespace cases and seven
sandbox gate cases.

The two exit-1 rows are outside this fix and reproduce on both complete files:
`scripts/gate-runner/client.test.ts:129` lacks environment classifications for
`LLV_SOUND_CAPTIONS_OUT` and `LLV_VOICE_DEVICES_OUT`;
`scripts/docker-image-scope.test.ts:78` lacks an image-input classification for
`scripts/privacy-known-value-fingerprints.json`.

The first branch runner integration observations (exit 1 and timeout 124)
were invalidated because generated logs inside the disposable export were
captured by its privacy scan. Recorded processes from the timeout were checked
to have exited. Both files were rerun with logs outside the tree and passed;
the complete main files also passed. These initial observations are retained
as setup failures and are not attributed to the source change.

| Final check | Exit |
| --- | --- |
| `bun x tsc --noEmit --incremental false` | 0 |
| `bun x eslint scripts/cpu-admission.ts scripts/cpu-admission-lock.ts scripts/cpu-admission-lock.test.ts scripts/gate-slot.queue.test.ts src/lib/runtime/cpuAdmission.ts` | 0 |
| `bash -n scripts/gate-slot.sh` (unchanged shell bytes) | 0 |
| Publication privacy for all eight changed files and branch messages, with committed fingerprints | 0 |
| Omit the lock helper from Docker COPY, run the runtime-layout test | 1, expected |
| Reset the waiter for every queue check, run the second-contention test | 1, expected |

The missing-copy mutation fails with a module import error instead of exit 75.
The per-check deadline mutation produces an extra retry at 120 ms, so the
exact IPC sequence assertion fails. Both mutations were restored, and the
final batch verified unchanged source hashes before returning its run count.

| Final source input | SHA-256 |
| --- | --- |
| `Dockerfile` | `28e488a355aacdd16d76b3cb07a0ca4d4b76d3fb5cd8a3f8ecf33fc83a9cf050` |
| `scripts/cpu-admission-lock.test.ts` | `93ff43ae3b8d462834ccc62d4f7de1364667397ffc223ce18ff4540901e61698` |
| `scripts/cpu-admission.ts` | `82b3aad518de2b64b57aae84327a973bea1b802100ad7fb0a07dc2b9081b058e` |
| `scripts/cpu-admission-lock.ts` | `649f5bc29ee06a99d6540fc62a2991c6dd6b2dc24a98734690660f53c1de2f64` |
| `scripts/gate-slot.sh` | `64dbbbe91bb82a30ee80135afd59596a1043809ab0c5eab2daef24608c9cb2ad` |
| `src/lib/runtime/cpuAdmission.ts` | `6dbcfb29707eaeed106cb65b228148d87d3ea9dfc6989af1fd81c6b6b5a53ba9` |
| `scripts/gate-slot.queue.test.ts` | `c24c1f9b740416c3dbc0c1c3f25fd141f25998ad40b550f4634a909e1b1bc73c` |
