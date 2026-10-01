# State leases recover after a full disk

## Requirement

Operator, 2026-10-01 19:24, verbatim, from the pinned specification of this
pipeline: «і розбирай задачі з вхідних по пріорітетам і правильно запускай».
That instruction put the card «Блокування стану переживають заповнений диск»
(high) and issue #2404 into this lane. The issue states the work, quoted as the
pipeline carries it:

> Incident (2026-10-01): /home reached 100% (ENOSPC). After 56 GB was freed,
> every task write still failed with "task tombstones busy" and MCP reads and
> writes timed out. state_leases in state.sqlite still held three leases with
> LIVE owner PIDs: task_tombstones and pipelines (owner: the
> accountMigrationController worker, a child of the prod `next start`), and
> seat-tick-v3 (owner: the prod `next start`). A direct BEGIN IMMEDIATE;
> ROLLBACK; succeeded, so SQLite was writable; only the leases were stuck.
> leaseIsStale treats a lease as stale only when its owner process is gone.
> Under ENOSPC the release DELETE most likely failed, and a long-lived owner
> never expires. The only recovery was a redeploy. Contributing cause: 38
> closed pipeline worktrees still held .next build caches (54.7 GB).
>
> 1. A lease whose release failed is not leaked: the release is retried, or the
>    owner records that it no longer holds it and drops the row on its next
>    successful write.
> 2. A lease also expires after a bounded age (far above any legitimate
>    critical section, justified with measured section lengths) even when its
>    owner PID is alive. A stolen-then-returning owner must not corrupt state:
>    fencing or equivalent.
> 3. Disk-full surfaces as an operator attention item ("disk full, state writes
>    failing"), not as "task tombstones busy".
> 4. Closed lanes drop their .next build cache when they finish, without
>    touching an active lane, a user checkout or anything outside the lane's
>    own worktree.
> 5. Tests that simulate a failed release (an injected ENOSPC on the DELETE) and
>    prove recovery without a restart.
>
> Preserve active lanes and user data. No cleanup or process action against
> the live machine.

Everything below was read at `311e47fd1` on `main`.

## What was found before

- `search_transcripts` for `state_leases`, `leaseIsStale`, `ENOSPC`,
  `lease stuck owner alive`, `redeploy leases`, `54.7 GB` and `2404`, scoped to
  this project and then unscoped: no hits. The index holds about 380 recent
  conversations, so this says nothing about older ones.
- `tombstones busy`: one hit, the incident itself. Another project's seat tick
  woke its orchestrator (`conversation_48efb730-f61b-42f7-92cf-9fdcd14c38d0`)
  at 15:48Z with «stage_blocked: task membership could not be recorded: task
  tombstones busy». Its turn at 15:50Z, after the redeploy, reads «Task writes
  go through again».
- `database or disk is full`: a Codex stage on 2026-09-29 reported that its
  `stage_report` call returned «database or disk is full». The disk had filled
  two days earlier as well, so this is a repeating condition.
- Repository history: `state_leases`, `leaseIsStale` and `owner_start_identity`
  all arrive in #956 (`dfa7447e8`) and have not changed since. The only reclaim
  rule ever designed is process death (`docs/design/state-sqlite-migration.md:324`).
- `docs/design/command-intents.md:41,63` records that the lease is a logical
  row held across awaits, and that the acquisition limits are "never an upper
  bound on the callback's work". Its slice 1 measured a pipelines hold of
  161.3 ms with a 100 ms fake spawn under the lease. It also fixed a rule for
  activation claims: "an elapsed lease or unreadable process identity cannot
  transfer execution ownership" (`command-intents.md:341-342`). The expiry
  below transfers the right to commit to a collection and leaves activation
  claims under that rule (see Fencing).
- The worktree sweep (#2202, `src/lib/pipelines/worktreeSweep.ts:17-23`) was
  written after `/home` reached 98% on 2026-09-25. It removes a worktree only
  when its pull request merged.

## Root cause

1. **A failed release throws and leaves the row.** `releaseLeaseSync` and
   `releaseLease` (`src/lib/state/sqliteStateStore.ts:1776-1818`) retry only
   SQLite busy; any other error is rethrown at `:1788` and `:1810`. The DELETE
   is appended to the WAL at COMMIT, and when the WAL must grow on a full
   filesystem SQLite answers `SQLITE_FULL` ("database or disk is full"). A
   commit that fits in blocks the WAL file already owns still lands, which is
   the likely reason some releases in the incident landed and three did not.
2. **A lease is stale only when its owner died.** `leaseIsStale`
   (`:376-378`) calls `stateLeaseOwnerAlive` (`:372-374`), which checks the PID
   and its start identity (`:365-370`). `acquired_at` is written at `:1731-1733`
   and never read. The Viewer and the inventory worker live for days, so a row
   they failed to delete stays until a restart.
3. **Every contender waits out the whole budget, synchronously.**
   `tryAcquireLease` (`:1717-1740`) returns false for a live owner;
   `acquireLeaseSync` (`:1742-1758`) retries 6,000 times with a 5 ms
   `Atomics.wait` (`:19-20`). That holds the caller's event loop for at least
   30 s per task write, then throws the collection's `busyMessage`, here
   "task tombstones busy" (`src/lib/links/tombstones.ts:48`). The blocked
   event loop explains the MCP timeouts.
4. **One failed release skips the next one and hides the result.** `patchSync`
   releases its leases one after another in a single `finally`
   (`sqliteStateStore.ts:1240-1244`), so a throw from the first leaves the
   others held. The release error also replaces the operation's own outcome;
   `src/lib/pipelines/store.ts:1162-1167` documents that a busy error can
   arrive after the row is committed.
5. **Who held what.** The inventory worker is spawned by `next start`
   (`src/lib/accounts/migration/controller.ts:295-307`) and runs
   `reconcileFileControllers` (`src/lib/scanner/index.ts:383-420`). That
   function holds `pipelines` through `withPipelineMutation` (`:400`) and
   `tickPipelines` (`:408`), and writes tasks through `tickTaskInbox`,
   `admitScannedConversations` and `reconcileControllerTasks`
   (`controller.ts:153-169`). Every task write goes through `writeTaskState`
   (`src/lib/tasks/store.ts:567-599`), which on a linked install takes
   `task_tombstones` before `tasks` (`sqliteStateStore.ts:1226-1233`; "task_"
   sorts before "tasks"). `seat-tick-v3` is written by `SeatTickAccounting`
   through `boundedPatch` (`src/lib/monitor/seatTickAccounting.ts:274-282`,
   `sqliteStateStore.ts:900-962`) in the Viewer process.
6. **Why the disk filled.** A closed lane keeps its `.next`, about 1.4 GB each
   (54.7 GB across 38 lanes; the production checkout's own `.next` measures
   1.4 GB). The sweep keeps every worktree without a merged pull request
   (`worktreeSweep.ts:477-480`, reason `no-merged-pr`). On this machine's last
   sweep (2026-10-01 18:56Z), 24 of the 38 kept worktrees were kept for that
   reason.

## Critical sections

Hold = from the committed `state_leases` row to its deletion.

| Holder | Collection | Kind | Measured | Bound from the code |
| --- | --- | --- | --- | --- |
| `writeTaskState` → `patchSync` | `tasks`, `task_tombstones` | synchronous | 10.2 ms p50, 23.4 ms max (5,000 rows of 1.5 KB, snapshot + one changed row) | one synchronous read-modify-write; the event loop is blocked for the whole hold |
| `replaceSync` (whole collection) | any | synchronous | 66.8 ms p50, 71.3 ms max (5,000 rows, all changed) | same |
| `boundedPatch` | `seat-tick-v3`, board links, notices, reports, pipeline delivery | synchronous | 1.1 ms p50, 1.9 ms max (one row) | at most 4,096 rows per call |
| `withPipelineStartupAdmission` | `pipelines` | async | in the live `pipelines` row below | warns above 100 ms (`pipelines/store.ts:1209`) |
| `withPipelineControllerMutation` (controller pass) | `pipelines` | async | live, all `pipelines` holders: max 2.6 s (below); 161.3 ms with a 100 ms fake spawn (`command-intents.md`, slice 1) | awaits every open lane in turn: a stage spawn (account admission up to 10 s, `accounts/accountMutation.ts:13`; runtime RPC 3 s, snapshot 10 s, event wait 16 s, `runtime/client.ts:20,149,174`; three handshake attempts 1 s apart, `engine.ts:1448-1449`), a terminal reap up to 5 s per lane (`engine.ts:5604`), remote reads up to 5 s each (`engine.ts:1466-1468`). A healthy pass that launches several stages is seconds to a minute. A pass in which every runtime RPC times out reaches about 16 s per lane, so 40 open lanes would hold about 11 min. `LLV_PIPELINE_ACTIVATION_DRAIN` moves spawns out of the lease; it is unset on the live Viewer. |
| `withFlowMutation`, `withWorkflowMutation` | `flows`, `workflows` | async | none seen in the live sample | the callback's awaits, the same ports as above |
| `moveMatchingTo`, `checkpointMirrorForDemotionAsync` | pipelines, archive, flows, workflows | async acquisition, synchronous body | — | one transaction or one mirror write |

The synchronous rows were timed in an isolated state directory with the store
from this commit (`bun`, 20 runs each, 5 runs for `replaceSync`). The live
sample is a read-only connection to this machine's `state.sqlite`, polling
`state_leases` every 20 ms for 10 minutes; a row's hold is the time from its
`acquired_at` to the last poll that saw it.

Live sample, 2026-10-01 19:32–19:42Z, 29,772 polls, no read errors:

| Collection | Holds seen | p50 | p90 | max |
| --- | --- | --- | --- | --- |
| `tasks` | 38 | 7 ms | 12 ms | 18 ms |
| `pipelines` | 98 | 23 ms | 60 ms | 2,606 ms |
| `seat-tick-v3` | 1 | 1 ms | 1 ms | 1 ms |

No `flows` or `workflows` hold was seen. The poll misses most holds shorter
than 20 ms and reads a seen hold up to 20 ms short, so these figures sample
the longer holds. This machine's state is small (442 tasks, 15 pipelines, no
linked boards), which is why the synchronous rows were also timed at 5,000
rows.

**Maximum age: 15 minutes.** Every measured hold is under 3 s, and the
largest code bound for a healthy controller pass is about a minute. Fifteen
minutes is more than ten times that, and stays above the 11-minute pass in
which every RPC times out. `src/lib/mcp/writerConcurrency.test.ts:236` holds a
live owner's lease aged 60 s and expects it to keep blocking; it keeps passing.
The cost of a long age is small, because the age is only the backstop: a
failed release is cleared by its owner within seconds once a write can land
(outcome 1). The age frees a row only when its owner can no longer clear it: a
callback that never settles, an event loop that never runs again, or an owner
running an older release that has no retry. Those were unrecoverable without a
restart before.

## Design

### 1. A failed release is not leaked

**Chosen.** A release never throws. When its transaction fails for any reason
(SQLite busy past the attempt limit included), the store records the token as
abandoned and keeps trying to delete it:

- A process-wide map on `globalThis` (`__llvAbandonedStateLeases`, keyed by
  database file, then collection, holding tokens) survives Next bundling the
  module twice, the way `globalController` does in `controller.ts:246-252`.
- One unref'd timer per process retries
  `DELETE FROM state_leases WHERE collection = ? AND owner_token = ?` for every
  abandoned token, starting at 250 ms and doubling to a 5 s ceiling, back to
  250 ms whenever a new token is abandoned, until the map is empty. The
  predicate names the token, so a retry can never delete a lease someone else
  took.
- In `tryAcquireLease`, a held row whose token this process abandoned counts
  as stale, so the owner's next write to that collection replaces the row in
  its own acquisition commit. This is "drops the row on its next successful
  write". When that commit fails too, the caller gets the disk-full error
  (outcome 3) and the token stays abandoned.
- The release logs once when a token is abandoned (collection, classified
  error) and once when it is cleared (how long it was held).
- `patchSync` releases all its leases, because a release can no longer throw
  out of the `finally`. The caller sees its own result or its own error, and
  the comment at `pipelines/store.ts:1162-1167` is corrected: a busy error after
  admission no longer comes from the release.

**Rejected.**

- *Retry inside the `finally` until it succeeds.* On a full disk that never
  returns: the Viewer's event loop stops, or every async caller hangs.
- *Exit the owner on a failed release, so process death frees the row.* The
  owner of `seat-tick-v3` was the production Viewer. The worker would lose its
  in-flight pass, and each exit is a restart, which outcome 5 rules out.
- *Rely on the maximum age alone.* Every disk-full event would then cost
  15 minutes of refused writes after the space returns.
- *A per-lease heartbeat.* A callback that never settles keeps renewing, which
  is the same stuck row; and a renewal is a write, which fails on a full disk.

### 2. A lease expires after a bounded age

**Chosen.** `STATE_LEASE_MAX_AGE_MS = 15 * 60_000` in
`sqliteStateStore.ts`. `leaseIsStale(lease, now)` returns true when the owner
is dead, when this process abandoned the token, or when
`now - acquired_at > STATE_LEASE_MAX_AGE_MS`. `LeaseRow` gains `acquired_at`
and the SELECT at `:1720-1723` reads it. Taking over a row because of its age
logs a warning naming the collection, the owner PID and the age, so a
legitimate hold that grows near the limit shows up in the logs before it is
cut. No schema change: `acquired_at` has been written since #956. Older
releases ignore the age, and their own writes are fenced the same way.

**Rejected.**

- *Two tiers, a short age for synchronous holders and a long one for async
  holders.* It needs a new column and a declared kind at every acquisition, and
  the short tier would change the contract `writerConcurrency.test.ts:236`
  holds. Outcome 1 already recovers the synchronous collections in seconds.
- *An age set by environment variable.* Tests age a row by writing
  `acquired_at`, as `writerConcurrency.test.ts` already does, so no knob is
  needed.

### Fencing: an owner whose lease expired while it was alive

Each acquisition writes a fresh random `owner_token`. Every commit made under a
lease checks that token inside its own `BEGIN IMMEDIATE` transaction, before it
writes: `persistChangedRows` (`:1511`), `persistReplacement` (`:1588`),
`mergeRows` (`:1660`), `boundedPatch` (`:909`) and `moveMatchingTo`
(`:1113-1114`), all through `assertLease` (`:1694-1699`). `BEGIN IMMEDIATE`
holds SQLite's single writer lock, and a takeover needs that lock too, so no
takeover can fall between the check and the COMMIT. An owner that comes back
after its row was taken finds a different token and writes nothing. Its
release and its abandoned-token retries delete by its own token, so they cannot
remove the new owner's row.

Changes:

- `assertLease` throws a new `StateLeaseLostError`, a subclass of
  `FileTransactionBusyError`, so every existing `instanceof` check still
  matches. Its message is
  `"<busyMessage>: this writer's lease expired or was taken over; nothing was written"`.
- The callback's in-memory snapshot is stale after a takeover. It can still act
  outside SQLite before it next tries to commit. What the long holder does
  outside SQLite: it launches stage agents, which the registry deduplicates by
  `clientAttemptId` = `pipeline_<id>_<stage>_<n>` (`engine.ts:1505-1507`,
  `beginSpawnRequestAsync` at `engine.ts:607-633` answers `replay` for the
  same attempt); it reaps terminal hosts, and a second kill of a finished host
  does nothing; it publishes branches, which carry their own epoch fence under
  `withDeliveryMutation` (`pipelines/store.ts:1256-1258`). Activation claims
  under `LLV_PIPELINE_ACTIVATION_DRAIN` keep their positive-death rule, because
  the age transfers only the collection lease.
- The clock is each process's `Date.now()` on one host. A backward jump delays
  expiry. A forward jump can expire a lease early, and that owner is then
  fenced. A monotonic clock is per process and cannot be compared across
  owners.
- `checkpointMirror` writes the legacy JSON mirror under a lease without a
  token check. It runs only at demotion, synchronously, in milliseconds, and
  `checkpointMirrorForDemotion` checks the revision again after writing
  (`:1295-1305`). It is left as it is.

### 3. Disk full is reported as disk full

**Chosen.**

- New module `src/lib/state/diskFull.ts`:
  - `class StateDiskFullError extends Error`, message
    `"disk full, state writes failing (<detail>)"`, with the original error as
    `cause`.
  - `isDiskFullError(error)`: `code` is `SQLITE_FULL` or `ENOSPC`, or the
    message matches `database or disk is full|ENOSPC|no space left on device`.
    Bun reports `SQLiteError`, `code: "SQLITE_FULL"`, `errno: 13` (checked on
    Bun 1.4.0).
  - `stateFreeBytes(directory)`: `statfs` `bavail * bsize`, null when unknown.
  - `STATE_DISK_FULL_FLOOR_BYTES = 64 MiB`. The WAL may grow to 64 MiB
    (`journal_size_limit`, `sqliteStateStore.ts:205`) before it is truncated,
    so with less free than that, the next commits can fail.
  - A process-wide record, on `globalThis` like the abandoned-lease map: the
    first disk-full failure since the last successful commit, and that commit's
    time. `noteStateDiskFull(detail)` sets the failure when none is open;
    `noteStateCommit()` clears it.
    `stateWriteHealth(directory): { state: "ok" | "disk-full"; freeBytes: number | null; since: string | null }`
    is `disk-full` when the free space is under the floor or a failure is open
    in this process; `since` is the open failure's time.
- In `sqliteStateStore.ts`, every non-busy rethrow goes through one
  `classifyStateError(error, detail)`: `withImmediateTransaction` (`:358`),
  `tryAcquireLease` (`:1736-1738`), the open paths (`:208`, `:320`, `:447`),
  and the release log. `withImmediateTransaction` calls `noteStateCommit()`
  after COMMIT.
- A contender stops waiting on a full disk. After each second of waiting in
  `acquireLeaseSync` and `acquireLease` (every 200 attempts), and again when the
  attempts run out, it checks `stateFreeBytes`. Under the floor it throws
  `StateDiskFullError("<collection> is held by a writer that cannot release it")`;
  with room on the disk it keeps the busy message. That cuts the blocked event
  loop from 30 s to about 1 s per write while the disk is full.
- The operator item: `/api/files` adds
  `systemHealth.storage.writes = stateWriteHealth(stateDir())` beside the
  incidents (`src/app/api/files/response.ts:888,937`). That costs one `statfs`
  call and reads a record in memory; nothing is written. A new
  `src/components/StateWritesAlert.tsx` renders it as a `role="alert"` strip,
  mounted once in `src/components/Viewer.tsx` beside `DeploymentStatusPill`
  (`:1732`), on desktop and on the phone. Title «Disk full: state writes are
  failing»; body: free space on the state directory's filesystem, the time
  since the first failure, and «Free space on this disk; Delegatus recovers by
  itself.» It renders nothing in the `ok` state and disappears on the next
  files refresh after a commit succeeds. Strings go in every locale file under
  `src/lib/i18n/`.
- Agents get the same words. An MCP tool that fails on a full disk returns the
  `StateDiskFullError` message. The MCP server files (`src/lib/mcp/server.ts`,
  `bindings.ts`) are fenced by another lane and need no change, because the
  wording comes from the store.

**Rejected.**

- *A persisted attention request, or the board task card storage incidents
  raise today (`src/lib/state/durability.ts:1039-1063`).* Both are rows in the
  database that cannot take a write; the card would appear only after the
  problem was over.
- *A third kind in the needs-you queue* (`src/components/attention/attentionQueue.ts:25-27`
  has conversation and pipeline). Every reader of that queue (desktop panel,
  phone sheet, project rail counts, dismissals) would need a kind that is
  neither a conversation nor a lane, and the alert would have to be dismissable
  while the fault still holds. OVER-BUILT for one machine-wide condition.
- *A seat-tick wake item.* The seat tick and its wake prompt are fenced by
  another lane, and delivering a wake writes to the registry on the same disk.

### 4. Closed lanes drop `.next`

**Chosen.** A second pass in `sweepMergedWorktrees`, per repository root,
after the removal loop (`worktreeSweep.ts:447-583`). For each linked worktree
still in `remaining`:

1. It is no main checkout, repository root or registered project root (the
   checks at `:452`).
2. At least one pipeline owns it (`pipeline.worktreeDir` resolves to it), its
   directory name is that pipeline's `pipelineIdentity` name,
   `<repo>-pipeline-<id>` (`pipelines/store.ts:1433-1438`), and every owner is
   settled (`!pipelineHoldsCheckout`, `:185-187`). A user's own checkout has no
   owner and is never a candidate.
3. Git does not list it as locked or prunable, and it exists.
4. `<worktree>/.next` is a real directory (`lstat`, never a symlink), its
   `realpath` is a direct child of the worktree's `realpath`, and no other
   listed worktree lies inside it.
5. `heldBy(readGuards(), worktree)` (`:402-409`) is null: no open pipeline,
   no process with its cwd, an open file, `TMPDIR`, `LLV_STATE_DIR` or
   `XDG_CONFIG_HOME` inside it, and no live or waiting conversation there.

Then measure `exclusiveBytes(.next)`, read the guards of step 5 again (the
measurement can take a while, as it does before a removal at `:534-548`), and
remove the directory with `fs.promises.rm(next, { recursive: true })`, which
unlinks symlinks inside it without following them. A dry run measures, reports
and deletes nothing. The report gains
`trimmed: { path; bytes; pipelineId }[]` and `trimmedBytes`, and
`summarizeWorktreeSweep` adds «trimmed N build cache(s) (X GB)». The pass is
off with the sweep (`LLV_WORKTREE_SWEEP=0`). It runs hourly, the first time
10 minutes after boot (`:99`), so a lane's `.next` is gone within an hour
of the lane settling. At 1.4 GB a lane, an hour's lag holds a few gigabytes;
the incident took days of accumulation.

**Rejected.**

- *Delete in the close teardown.* The teardown runs in the controller pass
  under the pipelines lease, and a recursive delete of 1.4 GB takes seconds
  there. It would also duplicate the guards the sweep already has.
- *`git clean -fdX`.* It removes every ignored file: `.env`, agent session
  files, a nested repository under an ignored `.worktrees/`, all of which the
  sweep deliberately keeps (`:49-54`).
- *Remove whole worktrees of closed lanes without a merged pull request.* That
  loses unmerged work; `no-merged-pr` stays until someone decides
  (`:39-41`).
- *Move every lane's `.next` outside the worktree.* It changes the build
  layout of every checkout, the production one included.

### 5. Tests

Each file runs by path in its own process with its own state directory:
`LLV_STATE_DIR="$(mktemp -d)" bun test <file>`. Do not sweep
`src/lib/agent/` or `src/app/api/runtime/`.

Test seams, in `sqliteStateStore.ts` beside `resetStateReadonlyConnectionCountForTests`:

- `injectStateWriteFaultForTests(fault: { site: "release" | "commit"; collection?: string; times?: number; error: Error } | null)`.
  `"release"` throws inside the release transaction before its DELETE;
  `"commit"` throws inside `withImmediateTransaction` before COMMIT. The test
  error is the shape Bun produces:
  `Object.assign(new Error("database or disk is full"), { name: "SQLiteError", code: "SQLITE_FULL", errno: 13 })`.
- `setStateFreeBytesProbeForTests(probe: ((directory: string) => number | null) | null)` in `diskFull.ts`.

New `src/lib/state/stateLeaseRecovery.test.ts`:

1. **A release that fails with SQLITE_FULL leaves its row, and the owner's next
   write replaces it.** Fault `release` on collection `probe` until cleared
   (the `release` site covers the background retry too, so only the
   acquisition path can clear the row). `await c.mutate(...)` resolves with the
   callback's value and its row is committed; a read-only connection sees the
   `state_leases` row with that token. The same process runs
   `c.boundedPatch(...)`: it returns in under 1 s, its row is committed, and
   the first token is no longer in `state_leases`. Clear the fault: within 3 s
   no `probe` row remains.
2. **The abandoned release is retried in the background.** Fault `release`
   with `times: 3`; after the write, poll `state_leases` until the row is gone,
   within 3 s, with no further call into the store.
3. **Recovery without a restart, across processes.** A child process
   (`src/lib/state/stateLeaseOwner.fixture.ts`, run with `bun`, its own
   `LLV_STATE_DIR` = the test's sandbox) faults every `release`, writes once,
   reports ready and stays alive. The parent, probe reporting plenty of space:
   `mutate` with `lockWaitMs: 300` refuses with busy (the owner is alive and
   the lease is young). The parent then creates the child's `lift` file; the
   child clears the fault; the parent's `mutate` with `lockWaitMs: 10_000`
   resolves; `process.kill(childPid, 0)` still succeeds; the child exits 0 when
   told to.
4. **A lease older than the maximum age is taken over from a live owner, and
   the old owner is fenced.** Holder A runs `mutate` and awaits a gate inside
   the callback. The test sets `acquired_at = Date.now() - STATE_LEASE_MAX_AGE_MS - 1_000`.
   Holder B's `mutate` commits `x = 2`. The gate opens; A's `persist()` throws
   `StateLeaseLostError`, which is also a `FileTransactionBusyError`; the
   collection holds B's row; A's release deletes nothing.
5. **A young lease of a live owner still blocks.** As 4 with
   `acquired_at = Date.now() - 60_000`; B with `lockWaitMs: 200` refuses busy.
6. **`patchSync` releases every lease when one release fails.** Two
   collections, `a_companion` and `b_own` (the companion sorts first, as
   `task_tombstones` does before `tasks`). Fault `release` once on `b_own`
   during `b_own.patchSync(..., { companion: a_companion })`: the call returns,
   the `a_companion` row is gone at once, and the `b_own` row is gone within
   3 s.
7. **The operation's own disk-full error reaches the caller.** Fault `commit`
   and `release` on one collection; `boundedPatch` throws `StateDiskFullError`
   whose message starts `disk full, state writes failing`, never the busy
   message.
8. **A contender on a full disk says disk full within about a second.** A
   lease held by a live child (case 3's fixture), probe returning 0: the
   parent's `mutate` rejects with `StateDiskFullError` in under 2 s, where the
   current code waits out 6,000 attempts.

New `src/lib/state/diskFull.test.ts`:

9. `isDiskFullError` accepts the Bun `SQLITE_FULL` shape, `ENOSPC` errno
   errors and the message forms, and rejects `SQLITE_BUSY`, `SQLITE_IOERR`
   and `EACCES`.
10. `stateWriteHealth` is `disk-full` after `noteStateDiskFull`, `ok` after a
    later `noteStateCommit`, and `disk-full` whenever the probe reports under
    `STATE_DISK_FULL_FLOOR_BYTES`.

`src/lib/pipelines/worktreeSweep.test.ts`, with the existing `repository()`,
`lane()`, `pipeline()` and `ports()` helpers:

11. **A settled lane's own worktree loses `.next` and keeps everything else.**
    Lane `<repo>-pipeline-<id>`, pipeline `closed` and settled, no merged pull
    request, holding `.next/cache/x`, `.env` and an untracked file: the report
    lists the trim; `.next` is gone; `.env`, the untracked file and the
    worktree stay; the worktree is still kept as `no-merged-pr`.
12. **Each guard keeps `.next`:** an open owner; a settled owner beside an
    open one; a process whose cwd is inside; a live conversation there; the
    main checkout; a linked worktree no pipeline owns; a pipeline whose
    `worktreeDir` is not its `<repo>-pipeline-<id>` name.
13. **Symlinks are never followed.** A `.next` that is a symlink to a
    directory outside the worktree: the target and its files remain, and
    nothing is reported trimmed. A real `.next` holding a symlink to an outside
    directory: `.next` is removed and the outside directory and its files
    remain.
14. **A dry run reports the trim and deletes nothing.**

UI:

15. `src/components/StateWritesAlert.dom.test.tsx`: renders the alert with the
    free space when `writes.state === "disk-full"`; renders nothing for `ok`
    and when `storage` is absent.
16. Rendered evidence through the existing drivers, one case each, behind a
    fixture flag `?state-disk-full=1` that serves
    `systemHealth.storage.writes` in disk-full state:
    `src/components/kanban/kanbanBoard.browser.test.tsx` (desktop, both colour
    schemes, `issue1695Evidence.fixture.tsx`) and
    `src/components/mobile/issue1671Evidence.browser.test.tsx` (390 px,
    `issue1671Evidence.fixture.tsx`). Each asserts the alert is inside the
    viewport and overlaps neither the header nor the composer, and saves its
    screenshot beside the existing self-update case.

## Files to change

| File | Change |
| --- | --- |
| `src/lib/state/sqliteStateStore.ts` | release never throws; abandoned-token map and retry timer; own abandoned token counts as stale; `STATE_LEASE_MAX_AGE_MS` and `acquired_at` in `leaseIsStale`; takeover warning; `StateLeaseLostError` from `assertLease`; `classifyStateError` at every non-busy rethrow; disk-full early exit in both acquire loops; `noteStateCommit` after COMMIT; the fault seam |
| `src/lib/state/diskFull.ts` (new) | `StateDiskFullError`, `isDiskFullError`, `stateFreeBytes`, floor, health record, `stateWriteHealth`, probe seam |
| `src/lib/pipelines/store.ts` | correct the comment at `:1162-1167` |
| `src/app/api/files/response.ts` | `systemHealth.storage.writes` |
| `src/lib/types.ts` (`:472-480`), `src/hooks/useFiles.ts` (`:60`, `:96`) | carry `storage.writes` to the client |
| `src/components/StateWritesAlert.tsx` (new), `src/components/Viewer.tsx` | the alert, mounted once |
| `src/lib/i18n/*.ts` | alert strings, every locale |
| `src/lib/pipelines/worktreeSweep.ts` | build-cache pass, report fields, summary |
| `src/components/kanban/issue1695Evidence.fixture.tsx`, `src/components/mobile/issue1671Evidence.fixture.tsx` | the `state-disk-full` flag |
| tests | as listed above, plus `src/lib/state/stateLeaseOwner.fixture.ts` |

None of these is fenced by another open lane. `Viewer.tsx` gets one mount line.

## Checks

- Each touched or new test file by path, each in its own process with its own
  `LLV_STATE_DIR`. Also run the existing suites that read `state_leases`, by
  path: `src/lib/mcp/writerConcurrency.test.ts`,
  `src/lib/state/hotStateStores.sqlite.test.ts`,
  `src/lib/state/sqliteStateStore.bounded.test.ts`,
  `src/lib/pipelines/store.test.ts`.
- The two browser cases with `LLV_KANBAN_BROWSER_TEST=1` and
  `LLV_SWIPE_BROWSER_TEST=1`, plus `CHROME_BIN`.
- `bunx tsc --noEmit`; eslint on the changed files; the privacy gate
  (`bun scripts/privacy-publication-gate.ts --base <merge-base> --check-commits`).
- A `Bun.build` of `src/runtime-host/main.ts` at this commit bundles
  `src/lib/state/sqliteStateStore.ts`, so the runtime host's code changes:
  `bun scripts/verify-runtime-host.ts --runtime "$(command -v bun)"`. The
  retry timer must be `unref()`ed so it never keeps a CLI, an MCP server or the
  runtime host alive.
- No command against the live state directory and no cleanup on the live
  machine. The sweep's new pass runs only in tests here.

## Deferred — not currently justified

- **The file-transaction lock** (`src/lib/state/fileTransaction.ts:77-96`)
  has the same rule, so a live owner never goes stale. The incident did not
  involve it.
- **A proactive low-space warning** before writes fail (for example under
  5 GB free). The floor above reports the condition once commits are at risk;
  an earlier warning is a separate request.
- **Trimming `node_modules` and other rebuildable outputs** of settled lanes.
  The requirement names `.next`, and `node_modules` can be hard-linked from
  the package cache, so deleting it frees less than it measures.
- **Bounding the controller pass itself** so the maximum age could be shorter.
  `LLV_PIPELINE_ACTIVATION_DRAIN` and `command-intents.md` slice 1a own that.
- **Shortening the 30 s synchronous acquisition spin** in general. Outside a
  full disk it is the existing contract (#1766).
- **Faster recovery from an owner on an older bundle.** An MCP process keeps
  the bundle it loaded until its session restarts
  (`state-sqlite-migration.md:195`), so a release it fails has no retry; the
  maximum age clears that row.

## Validation against the requirement

1. A failed release is retried every 250 ms to 5 s, and the owner's next
   acquisition of that collection replaces its own abandoned row. After the
   incident's 56 GB were freed, the three rows would have cleared within 5 s
   with both processes still running.
2. A lease older than 15 minutes is taken over even from a live owner. That is
   above every measured hold and every code bound for a healthy pass. A
   returning owner's commits are refused by the token check inside the same
   writer transaction, and its external effects are deduplicated or
   idempotent.
3. A write on a full disk fails with «disk full, state writes failing», a
   contender says the same within about a second, and the Viewer shows one
   alert on desktop and phone. Showing it needs no write.
4. A settled lane's own `.next` is deleted within an hour; open lanes, user
   checkouts, symlinks and everything else in the worktree are left alone.
5. Tests 1–8 inject `SQLITE_FULL` into the release DELETE and into commits,
   and prove recovery in the same process and across a live second process
   without restarting either.
