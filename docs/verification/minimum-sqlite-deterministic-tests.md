# Minimum SQLite timing regressions

Investigation date: 2026-10-22, completed 2026-10-23. Base: `d89efd14`. Verified
source revision: this branch's head, including every preceding timing and
fixture commit; each earlier observation below names the revision it was made
on.

The failing Actions logs were read with `gh api repos/<repository>/actions/jobs/<job-id>/logs`, including the failed first attempt of the #3193 run. Its later attempt passed.

| Test | Location | Observed assertion | Job | Timing dependency |
| --- | --- | --- | --- | --- |
| Verified unbound folder identities | `src/lib/memory/index.test.ts:115` | Expected one directory-phase candidate, received zero; original line 114 | 119820769368 | Optional retrieval gives up after 100 ms, including asynchronous filesystem reads. |
| Cancellation during refused-connection backoff | `src/lib/mcp/http.test.ts:467` | Expected `not-executed` and `retry-same-key`, received `unknown` and `original-key-lookup`; original line 470 | 119884849864 | A 25 ms abort could interrupt the first connection attempt before refusal was established. The dispatch-timeout wording also covers upstream cancellation. |
| One thousand worktree hook lookups | `src/lib/memory/index.test.ts:35` | Expected one candidate, received zero; original line 35 | 119908417246 | Freezing `performance.now()` left real 100 ms retrieval and 50 ms slug-proof timers running. |

Functional memory cases now hold the monotonic clock and both asynchronous read schedulers. Ownership, restart, search, open, cardinality and foreign-origin assertions remain. Separate deadline cases drive a stalled read explicitly, including the 99/100 ms boundary and cancellation of its timer. Production constructors and control dependencies default to the existing system scheduler.

The cancellation case uses the real closed listener, waits for the refused-connection backoff to be armed, then aborts. It checks timer cleanup, absence of a retained claim or delivery, and exactly one delivery after retrying the same key.

Three scratch red controls each produced one assertion failure, with no timeout or setup failure:

| Guard deliberately broken | Failure retained by the final test |
| --- | --- |
| Allow a predecessor's ownership to move to an unrelated origin: delete the first-ownership refusal at `src/lib/memory/index.ts:106`. | The unrelated-origin candidate list contains a foreign memory. |
| Use the worktree cwd instead of the repository root for historical scope at `src/lib/memory/index.ts:408`. | The first worktree recall returns zero candidates. |
| Classify cancellation after a refused connection as dispatch uncertainty at `src/lib/mcp/bindings.ts:719`. | The result gives `unknown` instead of `not-executed`. |

The three controls were repeated at `2871a62f7` and again at `7e5fdc3d9` in a disposable copy on the gate server; the later commits change neither these tests nor the guarded code. At `7e5fdc3d9` each test passed unmodified, and each control failed it at one assertion: `toEqual` on the candidate list, `toHaveLength(1)` with length 0, and `toMatchObject` on the outcome, respectively. Each was applied with a scripted edit to that copy, run alone, then restored and confirmed with `git diff --stat`. All three tests passed on that copy before each control, and each control produced exactly one failing test.

The captured base passes all five explicitly sampled suites: 160 tests pass, with two platform skips in the scanner suite. The separate image-store baseline passes 32 tests. Advancing its wall clock by 20 ms per read reproduces the recovery timeout. The five changed suites in the minimum-SQLite selection contain 136 tests. Scanner checks also run in the final publication gate.

A supplementary minimum-library scanner run rejected successful-lock diagnostics at two empty-stderr assertions, outside this job's selection. Forcing the same diagnostics reproduces both assertions on both base and head. Those scratch controls are restored before normal verification.

## Audit of the complete job selection

The workflow selects 44 explicit files, including its two minimum-library suites and the filtered transcript migrations. The following additional short elapsed-time assertions were replaced:

| Location | Replacement |
| --- | --- |
| `src/lib/memory/index.test.ts:678` | Observe actual SQLite busy-timeout settings around each of three contended hook operations. |
| `src/lib/memory/index.test.ts:697` | Thirty-result cap, bounded clock-check count and statement reuse over 6,000 rows. |
| `src/lib/memory/index.test.ts:771` | Exactly one source read for citation accounting over 1,000 offers. |
| `src/lib/memory/index.test.ts:1106` | Exactly 256 confirmations in the first replay batch, bounded progress after reopen, and exactly-once retained offers. |
| `src/lib/memory/index.test.ts:1146` | Zero SQLite busy timeout during failed cold initialization, followed by successful recovery. |
| `src/lib/mcp/http.test.ts:282` | Keep the writer locked until the Viewer has retried asynchronously; require no blocking sleep, then release and verify replay. |
| `src/lib/agent/sqliteRegistryStore.readOnlyView.test.ts:145` | Observe the retired view's root through a test-owned finalization callback, with each forced collection in its own task; see below. |
| `src/lib/state/stateLeaseRecovery.test.ts:48` | Replace the abandoned token synchronously while its release fault remains active. |
| `src/lib/state/stateLeaseRecovery.test.ts:219` | Both async and sync contenders refuse on their first disk-space probe without writing. |
| `src/runtime-host/journalSessionMetadata.test.ts:20` | Require indexed keyed selection without session-body scans or temporary sorting; preserve exact rows and snapshot bytes. Each comparison query runs once. |
| `src/lib/runtime/runtimeImageStore.test.ts:513` | Keep the exact live owner fenced until the injected acquisition budget expires. |
| `src/lib/runtime/runtimeImageStore.test.ts:530` | Keep a live owner without a fingerprint fenced under the same injected clock. |
| `src/lib/runtime/runtimeImageStore.test.ts:549` | Recover an exited owner's aged lock with time advancing by clock reads. |
| `src/lib/runtime/runtimeImageStore.test.ts:568` | Recover an aged lock after PID reuse under the same injected clock. |
| `src/lib/mcp/server.test.ts:1347` | Release the paused namespace handoff only after the successor reports an acquisition retry; see below. |
| `src/lib/mcp/server.test.ts:55` | Child milestone waits default to the test's own bound instead of 3 seconds, and stop when the named child exits. |
| `src/lib/mcp/server.test.ts:2171` | Hold the receipt lock until each contended operation's lock wait is observed, failing only when the operation settles without waiting; see below. |
| `src/lib/scanner/conversationSearchProjection.test.ts:235` | Observe the asynchronous lock wait until the search settles, replacing a 2-second abort. |
| `src/lib/memory/deliveryLedger.test.ts:177` | Observe admission retries until the delivery settles, replacing a 3-second deadline. |

The memory metadata and directory-walk sentinels also reject forbidden synchronous reads directly, replacing artificial busy loops. The stalled directory-walk test owns its timeout scheduler.

The transcript search file's 350 ms first-search test is excluded by this job's migration-name filter. Remaining measured durations in the selection are diagnostics, or the existing 4-second HTTP abandonment check; that longer lifecycle check was left as it stood.

An initial loaded full-job attempt reached the metadata fixture's 120-second watchdog after passing the repaired cases. Removing its obsolete timing ratio also removes 36 redundant measurement queries. The 24,000-session fixture, migration batches, query plans, legacy-row comparisons and all snapshot variants remain.

A subsequent attempt exposed the lease fixture's three-second readiness polling allowance. `src/lib/state/stateLeaseRecovery.test.ts:187` now waits for an IPC ready message sent after the child's committed write. Startup and exit retain owned 30-second watchdogs, which are cleared on completion. The existing readiness file remains available for manual probes.

A later loaded sequence passed twice, then exposed the image-lock recovery test's implicit 10 ms deadline. Reclaiming the stale directory and acquiring its replacement require separate passes; filesystem work or descheduling between them could exhaust the deadline. Both recovery cases and both live-owner controls now use the store's existing injectable clock, so their retry budget is independent of runner speed.

The same 20 ms wall-clock-advance control passes with the injected clock. A further scratch control disables stale-lock reclamation: the recovered-owner test fails with the lock-timeout error, within its finite injected budget. Restoring reclamation gives 32 passing image-store tests on the minimum library.

### Namespace handoff before forced inode reuse

The first loaded ten-run sequence at `2871a62f7` passed nine runs and failed run 7 in `src/lib/mcp/server.test.ts`: "successors wait for namespace release before forced inode reuse" expected the reuse ready file 3 seconds after the handoff was released and found none (original line 1400, 3,525 ms). The test released the paused handoff 250 ms after spawning the successor, whether or not it had started, and then allowed 3 seconds for a child startup, the reaper's finish and the reuse. The 250 ms window also proved nothing when the successor started late.

The successor fixture in `src/lib/mcp/server.lockChild.ts` now writes a waiting file when it takes an acquisition retry (`waitForLockRetry`) while the lock is absent and the retired inode is still pinned. Lock contention leaves the lock present, and pauses inside namespace cleanup are not acquisition retries. The parent waits for that file or the reuse ready file, requires the waiting file, and only then releases the handoff. Fixture children no longer charge time held at a fixture barrier to their 5-second lock budget or their call timing, which keeps the reaper's budget independent of how long the parent takes to start the successor. Contended claimants may print only the threshold-gated `[mcp slow]` line on stderr; any other line still fails.

Under 16 owned CPU workers on the 16-core gate server, the case passed 20 of 20 runs (742 to 937 ms each; one-minute load average 6.8 when the workers started and 11.9 when they stopped), and the whole file passed 101 tests on the minimum library. Skipping the namespace check at `src/lib/mcp/server.ts:1547` makes the successor reuse the inode during the handoff: the test fails at line 1415 with the ready file in place of the waiting file.

Two further red controls cover the replaced deadlines. Throwing a plain error for a busy catalog write at `src/lib/scanner/conversationSearchProjection.ts:269` fails the search case at its lock-wait assertion. Bypassing `stateLockAttempt` at `src/lib/memory/deliveryLedger.ts:206` fails the delivery case with "delivery admission did not retry". Under the same CPU load, both files passed three consecutive runs each (14 and 19 tests).

### Retired reader kept by a retained collection

The first final ten-run sequence at `7e5fdc3d9` passed nine runs. Run 8 failed one test in `src/lib/agent/sqliteRegistryStore.readOnlyView.test.ts`: "a retained archived collection keeps its retired reader alive after its root is collected" found the view's root still alive after twenty forced collections (`expect(received).toBeUndefined()`, 549 ms). The test is unchanged from the base, so this flake predates this work. Forty isolated runs of the file on the unchanged head passed.

The test is not timed; it depends on when the garbage collector releases the root. The loop read its `WeakRef` in the same task as each `Bun.gc(true)`, and a WeakRef read keeps its target alive until that task ends. The test now registers the root with its own `FinalizationRegistry`, runs each collection in a fresh task, and stops after 50 attempts. It requires its callback to have fired, then yields three tasks so the store's own finalizer queued by the same collection can run, and only then reads the retained collection (`src/lib/agent/sqliteRegistryStore.readOnlyView.test.ts:175`, `:178`).

Red control: lease the retired reader only to the root in `registerRetiredPreparedReader` (`src/lib/agent/sqliteRegistryStore.ts:4962`), leaving the retained collection unregistered. The test fails 30 of 30 isolated runs with "Database has closed". Without the control it passes 30 of 30. The other GC observation in the job, `src/lib/agent/sqliteRegistryStore.history.test.ts:75`, already collects in later tasks and allows two survivors; it did not fail in any run.

### Contended asynchronous receipt transitions

A re-audit of the selection after `54c111f5a` found one more wall-clock bound at
the ~2-second boundary that the first pass had missed: in
`src/lib/mcp/server.test.ts`, "async SQLite receipts retry each transition and a
contended completion never repeats the binding" gave each contended operation
2,000 ms to register a second lock attempt and otherwise threw "receipt
operation did not yield while waiting for its lock". Twelve operations shared
one 10-second test budget, so a loaded runner could expire that bound while the
operation was still retrying correctly.

The holding connection now keeps the lock until the wait is observed, and the
test fails only when the operation settles without having waited
(`src/lib/mcp/server.test.ts:2171`, `:2177`, `:2220`). Nothing in the case
measures elapsed time, so its bound is the runner's own 60-second timeout
(`:2226`).

Two red controls, each applied to the shipped checkout on the gate server and
restored afterwards (`git status` clean for `src/lib/mcp/server.ts`):

| Guard deliberately broken | Observed failure |
| --- | --- |
| Call each receipt transition directly in `openAsyncMcpReceiptStore`, without `waitForStateLock` or `stateLockAttempt` (`src/lib/mcp/server.ts:2249`). | The first contended claim raises `SQLiteError: database is locked` through `claim` and the test fails in 27.75 ms. |
| Keep the retry wrapper but give up after one attempt (`waitMs: 0` at `src/lib/mcp/server.ts:2251`). | The new check fires: "receipt operation did not yield while waiting for its lock", failing in 42.77 ms. |

Unmodified, the whole file passes 101 tests on the minimum library in 26.79 s.
The remaining short bounds in the selection are polling watchdogs of five
seconds or more, bounded counts and byte limits, the excluded transcript-search
case and the 4-second HTTP abandonment check.

## Verification procedure

All test processes use private home, config, state and temporary roots, with Viewer control directed at a closed port. Heavy commands run through `gate-remote` and `scripts/gate-slot.sh`. SQLite 3.39.4 is built by `minimumSqliteLibrary` and selected with the workflow's preload. Scratch fault injections are restored before the next case; no scratch commit is imported.

The repeated run extracts the `Run the state stores on it` shell body verbatim from `.github/workflows/platform-tests.yml`. It executes that body ten consecutive times, giving each repetition its own runner temporary root and retaining the workflow's per-file isolation and 60-second test timeout. One owned CPU worker runs `while True: sum(range(100000))` continuously during the repetitions and is stopped by its recorded process handle afterward.

A two-worker exploratory sequence exhausted the unchanged activity-ingest fixture's explicit 30-second watchdog. The identical focused case fails on both base and head with two workers and passes on both with one worker. The final sequence uses one worker. An SSH interruption also stopped an earlier sequence before any result was recorded.
