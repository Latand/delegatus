# A large runtime journal never takes the stable entry down

Design for pipeline `4c010c33` (architect stage), issue #2459, 2026-10-02, read on `main` at `e7185fec5`. Line anchors below refer to that commit.

## The requirement

The operator, 2026-10-02, in the orchestrator conversation. The pinned specification carries it as an English paraphrase, quoted here verbatim:

> make a permanent fix so no Delegatus installation suffers long connection-refused outages on startup. Investigate receipt backfill, index rebuilds, readiness/availability ordering and the redundant same-revision handoff. Preserve live data and agents. Add large-history cold, repeated and interrupted-then-resumed startup tests plus a real handoff regression, an independent fresh full-diff review, CI, then the seat's deploy and browser/API verification. Local service is healthy now; do not restart the live service to reproduce.

The issue (Latand/delegatus#2459) governs. Its required outcome, verbatim:

> - Make receipt backfill versioned/idempotent and avoid repeated per-row durable writes for existing receipts. Use bounded/batched transactional work where correctness permits, with safe recovery after interruption.
> - Avoid unnecessary index rebuilds on every boot.
> - Add bounded startup progress evidence identifying journal subphases and distinguish booting from ready/unhealthy honestly.
> - Evaluate handoff/readiness ordering so long initialization does not silently remove the stable entry. Never serve mutations through two owners or weaken fencing/durability.
> - Investigate and remove unnecessary same-revision handoff if reproducible.

Incident evidence from the issue: `fence-acquired` 12:48:08Z → `journal-open` 13:06:46Z (18m37s), no stable listener in between, D-state in `jbd2_log_wait_commit`, >6 GB of process writes, ~304k events and ~307k producer receipts. A second same-revision handoff followed, and that boot was fast.

## 1. What the code does today

### 1.1 Boot order (`src/runtime-host/main.ts`)

1. `:91` `bootGeneration = currentRuntimeHostGeneration()`. This runs at process start, **before** the fence wait.
2. `:113` `startup.begin()` records `fence-waiting`.
3. `:148-154` waits for and takes the singleton fence, then records `fence-acquired`.
4. `:156` `new RuntimeJournal(...)` runs synchronously and blocks the event loop.
5. `:160-162` `claimHostEpoch()`, then `journal-open`.
6. `:198-205` handoff cleanup, run only when `bootGeneration` is tracked.
7. `:239-250` binds the **stable entry** (the 8898 proxy and the optional remote entry). It is created only when `deployments` exists, and `deployments` needs the journal.
8. `:277-283` recovers consumers, serves the runtime socket, records `ready`, then runs `deployments.recover()`.

The stable entry is `serveViewerDeploymentProxy` (`deploymentProxy.ts:26-100`). Per connection it reads only the release-target file and pipes to the Viewer container. It never touches the journal. Even so, it is bound only after the journal opens. Meanwhile the Viewer process keeps running through a host handoff, so the 18-minute outage was the **entry** being absent.

On a handoff, the predecessor closes the stable entry first (`:390-391`), drains the runtime socket (`:392`), then closes the journal and releases the fence. `stop()` (`:342-352`) does the same on SIGTERM.

### 1.2 What the journal constructor writes (`src/runtime-host/journal.ts:354-438`)

- `:360` uses `synchronous = FULL` in WAL mode. Every autocommit statement that changes a page is its own fsync'd commit.
- `:418-421` **receipt backfill**. It runs `SELECT * FROM events WHERE producer_key IS NOT NULL` with `.all()`, which loads every keyed event into memory. Then it runs one autocommit `INSERT … ON CONFLICT DO NOTHING` per row.
- `:422` **index rebuild**. `DROP INDEX IF EXISTS events_producer_key; … CREATE UNIQUE INDEX IF NOT EXISTS events_producer_key …` runs on every boot.
- `:432` `verify()` (`:2787-2805`) runs `quick_check` on 13 tables, then `SELECT * FROM events ORDER BY seq` with `.all()`, and re-hashes the whole chain.
- `:361` `NativeQueueJournal` rebuilds `native_queue_operation_holds` in one transaction: one commit per boot, bounded by the queue rather than by history. The tests treat it as the fixed per-boot overhead.

### 1.3 Why every boot re-pays the backfill

- `754f1225e` (2026-07-10) added `producer_receipts`, the per-boot backfill, **and** the receipt insert inside `appendInTransaction` (today `:1830-1831`), all in one commit. Since then, every keyed event gets its receipt in its own transaction. The backfill only ever had work to do for journals written before that commit.
- `6b2760e6a` (2026-07-22) made engine-cursor keys (`engine-host:{codex|claude}:<session>:<seq>`, `engineProducerCursor` `:142`) keep only the newest receipt per session prefix. The append path deletes the rest (`:1766-1779`, `:1832-1836`).
- `0165d3b71` (2026-08-04) added `maintainProducerReceipts` (`:1715-1759`). On a 10-second timer it deletes the same superseded rows, 4,096 rows per tick (`main.ts:294-302`).

The constructor backfill does not know about that rule. **Every boot re-inserts every superseded engine receipt whose event is still in `events`, one fsync'd commit per row.** The sweep then deletes them again over the next minutes. A receipt that already exists costs nothing: the measurements show `ON CONFLICT DO NOTHING` writes no WAL frame.

Measured on invented same-shape data in an isolated temporary state directory on tmpfs. The fixture has 300,000 events: 280,000 engine-keyed across 400 prefixes, 10,000 other keyed and 10,000 unkeyed. The base constructor ran as-is.

| boot | receipts before → after | bytes written by the process (`wchar`) | write syscalls | time on tmpfs |
|---|---|---|---|---|
| cold (as the runtime left it) | 10,400 → 290,000 | 3.6 GB | 1.69 M | 13.6 s |
| immediately again | 290,000 → 290,000 | 48 MB (index rebuild) | 17 k | 10.1 s |
| after the sweep ran (279,600 deleted) | 10,400 → 290,000 | 3.8 GB | 1.79 M | 12.9 s |

A 2,200-event run counted WAL commit frames directly. It showed 1,993 commits for 1,990 re-inserted receipts on a cold boot, and 3 commits on an immediate reboot: two for the index rebuild and one for the native-queue hold rebuild, which `DELETE FROM` performs even on an empty table. On ext4 with `synchronous = FULL`, 279,600 commits at the incident's ~3.7 ms each come to about 17 minutes, which matches the 18m37s. The fast second boot also follows: it ran seconds after the first boot had re-inserted everything, before the sweep could delete much.

### 1.4 The index rebuild never migrated anything

`events_producer_key` first appeared in `5786f3b8a` (2026-07-10), with its current definition, in the same line as the `DROP`. Before that commit, the column carried `producer_key TEXT UNIQUE` and there was no index of that name. So the `DROP` has never replaced an older definition. It only rebuilds the full index on every boot, about 48 MB at 300k events, under the write lock.

### 1.5 Other startup cost that grows with history

At 300k events, the hash-chain pass in `verify()` takes 4.4 s on this machine, with the loop blocked, and `.all()` materializes every row. `quick_check(events)` takes 0.2 s. The legacy `UPDATE … WHERE <column> IS NULL` statements in `migrateLegacyEvents` (`:2879-2895`) measured 0 ms. On a journal created from the current schema those columns are `NOT NULL`, so the predicate folds away. These costs are reads, so they do not refuse connections by themselves. They do block the event loop, and that matters once the stable entry is bound earlier (§2.4).

### 1.6 The second same-revision handoff (reproducible by construction)

The staging order is in `hostSuccessor.ts:462-492` and `:521-614`:

1. `docker run` the successor (`:578`). Its `main.ts:91` reads the release record within its first second.
2. `observeStableSuccessor` waits 11 s (`:595`).
3. The handoff intent is written (`:598`).
4. The record is published for the successor (`:612`).
5. The predecessor exits.

So the successor **always** reads the predecessor's record. `currentRuntimeHostGeneration` (`hostRelease.ts:148-159`) then returns `{ image: null, revision: null }`, and the successor runs untracked:

- `main.ts:198` skips the handoff cleanup, so the intent stays.
- `deployments.recover()` finds the deployment still in `host-handoff`.
- `stageDriftedHostSuccessor` (`deployment.ts:289-309`) logs "the running generation is untracked" and calls the adapter.
- The adapter takes the exact-intent resume path for **its own container** (`hostSuccessor.ts:556-569`): it starts the container, observes it for 11 s, then publishes.
- `onHostHandoff` makes the successor exit 0.
- dockerd (`--restart unless-stopped`) restarts the same container. This time it reads the published record and completes.

Every deployment that hands the host over pays this second boot. The boot-time read dates from `3f349d001` (2026-07-21). The existing rehearsal never saw it because it writes the release record **before** starting each generation (`hostRehearsalRun.ts:418`, `runtimeHostStartup.test.ts:154`).

### 1.7 Readiness today

The startup record (`runtimeHostStartup.ts`) holds seven fixed phases. `validatedEvidence` requires exactly that list (`:200`), and the deploy adapter checks it across generations. So the list is a wire contract: new subphases cannot be inserted into it.

Readiness is visible in three places:

- **Runtime socket:** answers `runtime-host-health` only once the host is ready.
- **Docker health check** (`scripts/runtime-host-healthcheck.ts`, set at `hostSuccessor.ts:248-251`): probes that socket.
- **Viewer snapshot route** (`src/app/api/runtime/snapshot/route.ts:42-44`): answers 503 "runtime host is unavailable".

A host that is booting and a host that is dead look identical on all three.

### 1.8 What landed from the 2026-09-20 migration work

The prior Codex sessions reviewed PR #1937 (indexed session host metadata). That review set the bar: bounded transactions, resumable after a kill, a recorded version, and a previous release can still open the journal. `journalSessionMetadata.ts:46-96` implements it:

- the version key `session_host_metadata_schema_version` in `journal_meta`;
- a cursor committed in the same transaction as the rows it describes;
- a `ready` marker written last.

None of it was applied to receipts or to the index. This design reuses that pattern.

## 2. Design

Each item is the smallest change that removes the measured cost or the observed defect.

### 2.1 One-time, versioned receipt pass (requirement 1)

This replaces `journal.ts:418-421`.

- **Marker.** The pass is gated by `journal_meta.producer_receipts_backfill_version`. When it equals `"1"`, the pass is skipped entirely: no scan and no write. Do not reuse `schema_version`/`RUNTIME_SCHEMA_VERSION`, which is the snapshot wire version, and do not use `PRAGMA user_version`. Follow the #1937 precedent.
- **Scan.** When the marker is absent, walk `events INDEXED BY events_producer_key` in `(producer_kind, producer_key)` order, resuming after `journal_meta.producer_receipts_backfill_cursor` (a JSON `[kind, key]` pair). Use batches of `startupBatchRows` index entries (default 512; overridable in `RuntimeJournalOptions` for tests). An index-only scan of 300k entries, with the receipt-existence probe, measured 130 ms.
- **Per entry.** If a receipt exists, skip it. If the key is an engine cursor and its prefix already holds a receipt with an equal or higher sequence, skip it: this is the append path's own invariant, and a per-pass `Map` caches the newest key per prefix. Otherwise read that one event row and `INSERT` its receipt with `stableJson(toEvent(row))`, exactly as today.
- **Commit.** A batch that inserted at least one row commits its rows and the advanced cursor in one `BEGIN IMMEDIATE … COMMIT`. A batch that inserted nothing commits nothing: a crash only re-reads those entries. After the last batch, one transaction sets the marker to `"1"` and deletes the cursor.
- **Crash safety.** Each batch is atomic, the cursor moves only with the rows it covers, and `producer_receipts` has a primary key. A kill at any point therefore loses nothing and duplicates nothing. The resumed run skips everything committed and finishes the rest. `synchronous = FULL` stays.
- **Why a marker is enough.** Since `754f1225e`, every release that has a `producer_receipts` table writes the receipt inside the event's own transaction, and no older release is in any rollback window. After one complete pass, the only keyed events without a receipt are superseded engine keys, and those are meant to stay deleted. A sequence watermark advanced on every append would cover a writer that does not insert receipts. No such writer exists, so the watermark is left out (§4).
- **Expected cost.** On a journal shaped like production, the first boot of the fixed release scans in under a second and makes **one** commit, the marker. Later boots make no receipt or index write at all; the only commit left is the native-queue rebuild (§1.2).

### 2.2 No index rebuild (requirement 2)

Delete `DROP INDEX IF EXISTS events_producer_key;` from `journal.ts:422`. Keep the three `CREATE UNIQUE INDEX IF NOT EXISTS` statements, and move them **before** the receipt pass, which needs `events_producer_key`. §1.4 shows the definition never changed, so no schema check or marker is needed.

### 2.3 Cooperative journal open with progress (requirements 3 and 4)

- **Two ways in.** Add `static async open(filename, options): Promise<RuntimeJournal>` beside the constructor. The receipt pass (§2.1) and the hash-chain verification are generators that yield after each batch.
  - The constructor drains them synchronously, so every existing caller and test is unchanged.
  - `open()` awaits `setImmediate` between yields, so the event loop serves the stable entry while the journal opens.
- **Hash chain.** `verify()` reads `events` in seq ranges of 4,096 rows (`WHERE seq > ? ORDER BY seq LIMIT 4096`) in place of `.all()`. The checks are identical: seq continuity, `prev_hash`, recomputed `hash`, then the tail check against `journal_meta`. Memory stays flat.
- **`quick_check`.** It stays one call per table, with a yield between tables. A single table's check cannot be split.
- **Progress callback.** `RuntimeJournalOptions.onStartupProgress?(p)` receives `{ subphase, done, total, committedBatches }`. Subphases are `schema`, `receipt-backfill`, `integrity-check` and `hash-chain`. It fires at each subphase start and end, and after every 32nd batch. That bound is a count, not a time, so tests can rely on it. The synchronous constructor calls it too: the interrupted-run test (§3.2) kills a child from inside it.
- **`main.ts:156`.** Becomes `await RuntimeJournal.open(journalFilename, { onStartupProgress: (p) => startup.progress(p) })`.

### 2.4 Stable entry before the journal, and kept until the fence is released (requirement 4)

- **Successor.** Move the stable-entry block (`main.ts:226-276`: gateway read, `deploymentProxy`, `remoteEntryProxy`, `recordBoundViewerEntries`) to directly after `startup.record("fence-acquired")`.
  - Gate it on `deploymentAdapterPath`, which is the same condition `deployments` had, so the journal is not needed.
  - Attach an `error` handler before `listen` (the #1254 rule). On `EADDRINUSE`, retry the listen up to 40 times, 250 ms apart. If the port is still taken after that, throw: the fence holder exits as it does today, and dockerd restarts it.
  - Await the `listening` event, call `startup.stableEntryListening()` (§2.5), and only then call `RuntimeJournal.open`. With no stable entry (deployments disabled), go straight on.
- **Predecessor.** In `stop()` and `handOffToStagedSuccessor()` (`main.ts:342-352`, `:383-403`), close `deploymentProxy` and `remoteEntryProxy` inside the `server.close` callback, immediately before `fence.release()`. Do the same in the forced-exit path. The entry then stays up through the drain, and the gap shrinks to process exit plus the successor's fence poll.
- **Single owner.** The runtime socket is still served only after `ready`. The journal is opened only by the fence holder. The proxy adds no writer: the Viewer behind it was already running, and it reaches the journal only through the runtime socket, which is not yet listening. Fencing (`fenceLock.ts`), the epoch claim and `synchronous = FULL` are untouched.

### 2.5 Bounded startup evidence and an honest readiness state (requirement 3)

- **Progress field.** `RuntimeHostStartupStore.progress(p)` (`runtimeHostStartup.ts`) overwrites one top-level `journal` field in the existing record file: `{ subphase, done, total, committedBatches, updatedAt }`.
  - It never touches `phases`, which is the wire contract of §1.7.
  - `version` stays 1. `recordFromDisk` ignores unknown fields, and `record()` rewrites the whole object, so older code keeps the field intact.
  - Writes are bounded by §2.3's callback count: one fixed-size file, about 20 writes per subphase at 300k events.
  - Each subphase change also prints one stderr line with the subphase name and counts only.
- **Stable-entry marker.** `RuntimeHostStartupStore.stableEntryListening()` sets a top-level `stableEntry: "listening"` once. Because `main.ts` writes it before the journal opens, every record that carries a `journal` field also carries `stableEntry`. §3.4 asserts exactly that, which proves the order without comparing timestamps.
- **Classifier.** `ready` stays what it is today: the runtime socket answers `runtime-host-health`. Both consumers below consult the classifier only after that probe or call has failed. `runtimeHostStartupState(record, liveIdentity)` in `runtimeHostStartup.ts` is a pure function that names the failure:

  | state | condition |
  |---|---|
  | `booting` | the record's pid/start identity is alive, `fence-acquired` is recorded, `ready` is not |
  | `unhealthy` | every other case, including no or unreadable record, an identity that is gone, or `ready` recorded while the socket refuses |
  | `unknown` | liveness cannot be read (no shared PID namespace); never reported as `booting` |

  `readRuntimeHostStartupState(directory)` picks the record of the fence holder: the live record past `fence-acquired`, and otherwise the newest by its `fence-waiting` time.
- **Consumers.** There are exactly two:
  - `scripts/runtime-host-healthcheck.ts` prints the state, subphase and counts on failure. The exit code is unchanged: booting is not healthy. It reads its own record at `LLV_RUNTIME_HOST_STARTUP_TARGET`, or else `<appDir>/state/runtime-host-startup/<LLV_RUNTIME_HOST_CONTAINER>.json`, resolving the path the way it already resolves the socket (`:11-17`). That keeps it free of `stateDir()` and of any owner claim (AGENTS.md, "Only a declared owner resolves the operator's state directory").
  - The snapshot route answers 503 with `code: "runtime-host-booting"` and the `journal` progress when `isRuntimeHostTransportFailure(error)` and the state is `booting`. Other failures keep their current answer.

  `isRuntimeHostTransportFailure` and every replay rule are untouched.

### 2.6 Read the generation after the fence (requirement 5)

Move `main.ts:91` to directly after `startup.record("fence-acquired")`, and rewrite the comment at `:190-193`.

This is correct because the predecessor publishes the record (`hostSuccessor.ts:612`) before it exits and releases the fence. Reading after the fence therefore sees the successor's own record. The handoff cleanup then runs and clears the intent, `stageDriftedHostSuccessor` answers "not required", and the deployment settles through `verifyRuntimeHostSuccessor`.

The rollback path writes its record before starting the retained generation, so it is unchanged. Nothing else reads `bootGeneration` earlier.

### 2.7 Compatibility (requirement 6)

| case | behaviour |
|---|---|
| A journal from any earlier release opens with this release | No marker yet, so the one-time pass runs once (§2.1). A pre-`754f1225e` journal with an empty `producer_receipts` gets every non-engine receipt and the newest per engine prefix, which keeps dedup intact. The index is created if missing. No schema object is added, removed or changed: the new state is two `journal_meta` keys, and the cursor is deleted when the pass completes. |
| An older release reopens a journal this release migrated | Old code ignores the unknown meta keys and reads the same schema. It runs its own per-boot backfill and index rebuild, which is as slow as today. Its appends insert receipts, so the marker stays valid when this release returns, and the superseded rows it re-inserted are swept as now. **State in the PR body:** a rollback to the pre-fix release boots as slowly as today, on every boot of that release. |
| Startup record read by an older adapter | `phases` is unchanged, and the extra `journal` field is ignored. |
| Snapshot 503 read by an older client | The added fields are optional. `code` was already optional on 503 answers. |

## 3. Regression tests

All tests run on invented data, in a directory from `fs.mkdtempSync(path.join(os.tmpdir(), …))`, with `LLV_STATE_DIR` and a built (never inherited) environment. Run them one file per invocation under `flock /var/tmp/llv-heavy-gate.lock`, and never as a sweep of `src/runtime-host/`.

### 3.1 Fixture and measurement helpers (new: `src/runtime-host/fixtures/largeRuntimeJournal.ts`)

`writeLargeRuntimeJournal(filename, shape)`:

- Calls `new RuntimeJournal(filename).close()` to get the schema, then writes rows directly in **one** transaction. This needs `recordHash`, `toEvent` and `stableJson` exported from `journal.ts`, marked as fixture-facing.
- Default shape: N = 300,000 events.
  - 280,000 are engine-keyed `delta` events across 400 prefixes, alternating `codex-app-server`/`claude-broker` with `engine-host:{codex|claude}:thread-<p>:<q>` keys.
  - 10,000 carry non-engine keys (`native:op-<n>`), and 10,000 are unkeyed.
  - Payloads are `{ conversationId, turnId, text }` with about 160 characters of text.
- Hash chain, `scope_revisions` and `journal_meta` `seq`/`published_seq`/`hash` are written from the same rows.
- Receipts are written as the runtime leaves them: the newest per engine prefix plus every non-engine key, 10,400 in all.
- Options:
  - `migrated` writes the marker.
  - `missingNonEngineReceipts: k` deletes k evenly spaced non-engine receipts, giving the pre-receipts shape.
- Measured: 19 s and 219 MB on tmpfs. Build it once per file and `fs.copyFileSync` it per test.

Measurement helpers. All are counts; no assertion compares durations, and durations are printed as evidence only.

- **`walCommits(filename)`.** Call it after `PRAGMA wal_checkpoint(TRUNCATE)` and while a read-only connection holds `BEGIN; SELECT …` open across the measured open, so no frame can be checkpointed away. It parses the WAL (32-byte header, then 24-byte frame headers carrying the header's salts) and returns `{ frames, commits }`, where commits are frames with a non-zero size-after-commit. Under `synchronous = FULL`, each commit is one fsync of the WAL. Use it at N ≤ 30,000 only: at 300k, base's pinned WAL grew past 1.6 GB and the run degraded to over 10 minutes.
- **`processWrites(fn)`.** Reads the `/proc/self/io` `wchar`/`syscw` delta around a synchronous constructor call. It is Linux-only, so use `test.skipIf(process.platform !== "linux")`. It needs no pinning, which makes it the measure for N = 300,000.
- **Receipt checks.** The receipt row delta, plus `expectedReceipts(filename)`, which recomputes the exact expected set from `events` independently of the code under test.

### 3.2 Constructor and open seams (new: `src/runtime-host/journalStartup.test.ts`)

| test | how | head assertion | red at base because |
|---|---|---|---|
| cold boot, 300k | `processWrites(() => new RuntimeJournal(f).close())` on the default fixture | receipt delta 0; receipts equal `expectedReceipts`; marker `"1"`; `isWritable()`; `wchar` below 1 MB (base: 3.6 GB) | re-inserts 279,600 receipts |
| repeated boot after runtime activity, 300k | boot, append one event per engine prefix and drain `maintainProducerReceipts` to `cycled`, boot again | second boot: receipt delta 0; `wchar` below 1 MB | re-inserts 279,600 again (3.8 GB measured) |
| immediate warm boot is size-independent | `walCommits` at N = 30,000 and N = 300 with `migrated`; call the N = 300 count `overhead` (today one commit, the native-queue rebuild) | frames and commits equal across the two sizes | the index rebuild writes frames in proportion to N |
| cold boot commit count | `walCommits` at N = 30,000 cold, minus `overhead` | exactly 1 (the marker) | about 28,000 commits, one per re-inserted row |
| interrupted then resumed | 30,000 events with `missingNonEngineReceipts: 3000`, `startupBatchRows: 256`. A child `bun -e` process runs the constructor with `onStartupProgress` that calls `process.kill(process.pid, "SIGKILL")` when `committedBatches === 3`. The parent pins a reader before the child starts and counts `walCommits` for the child, then for an in-process resume. A copy of the fixture is booted uninterrupted for comparison. | child − `overhead` `== 3`; cursor present and marker absent after the kill; after the resume, receipts equal `expectedReceipts` (no loss, no duplicate), the marker is set and the cursor deleted; (child − `overhead`) + (resume − `overhead`) equals uninterrupted − `overhead`, so every batch committed exactly once | no batching, cursor or marker; the hook never fires, and there are 3,000 per-row commits |
| journal from an older release | (a) the fixture with `producer_receipts` emptied; (b) after a head migration, the test runs the base constructor's mutating statements by hand (per-row `INSERT … ON CONFLICT DO NOTHING`, `DROP`/`CREATE INDEX`, `metaSetDefault`), then reopens with head | (a) receipts equal `expectedReceipts`; appending a duplicate non-engine key and an engine key at or below the newest sequence returns the existing event with the same seq. (b) `isWritable()`, the chain verifies, the marker is still `"1"`, the reopen makes zero receipt inserts and its frames equal `overhead`'s, and dedup holds | (a) base inserts a receipt for every engine key, so the set is larger than expected; (b) base writes no marker and its reopen rebuilds the index |
| `open()` yields | a `setImmediate` callback is scheduled just before `await RuntimeJournal.open(f, { onStartupProgress })` on the 300k fixture | the callback runs before the promise resolves and before `hash-chain` ends; subphases arrive in order | `open()` does not exist |

A crash *inside* a batch is not injected separately. A batch is one SQLite transaction, so a kill inside it leaves the same durable state as a kill after the previous commit, and the test above covers that state.

### 3.3 Evidence and readiness (extend `src/runtime-host/runtimeHostStartup.test.ts`; new `src/app/api/runtime/snapshot/route.test.ts`)

- **`progress()` is bounded.** After 10,000 calls the file size is unchanged, `phases.length` is unchanged, and `readyEvidence()` / `parseRuntimeHostHandoffEvidence` still accept the record. An older-shape parse, meaning `recordFromDisk` with the field present, still passes.
- **Classifier.** One case per row of the §2.5 table, using an injected `liveIdentity`.
- **Health check message.** It names `booting` and the subphase for a live, incomplete record, and `unhealthy` for a dead one. The exit code is 1 in both cases.
- **Snapshot route.** With a fixture state directory and no socket: a live, incomplete record answers 503 `runtime-host-booting` with the subphase; no record answers the current 503 `runtime host is unavailable`.

All of these are red at base because `progress`, the classifier and the route code do not exist.

### 3.4 Separate-process handoff (new: `src/runtime-host/runtimeHostSuccession.process.test.ts`)

It reuses `runtimeHostRehearsalEnvironment`, `probeStableListener` and `ephemeralPort`, and needs `installRehearsalTools` and `startGeneration` exported from `hostRehearsalRun.ts`. That gives each generation:

- the Docker stub on its `PATH` (it never reaches a daemon);
- a private socket, fence and journal;
- an ephemeral stable port;
- `LLV_VIEWER_DEPLOYMENTS=1`, so the stable entry exists.

**Scenario A: the stable entry stays up while the successor opens a large journal.**

1. Write the 300k fixture as the shared journal.
2. Start predecessor P (tracked: its release record is written first, as the rehearsal does). Wait for P's `ready`.
3. Append one event per engine prefix through P's socket, so the superseded receipts are deleted as in production.
4. Start successor S. It waits on the fence while the record still names P, which is the real staging order.
5. Write the handoff intent and publish the record naming S, then SIGTERM P.
6. Probe the stable port every 25 ms until S's record shows `ready`. Each poll stores whether it was answered next to S's `phases` and `journal` progress, read just before the probe. The overall deadline is 180 s, a bound on the wait and never asserted.

Head asserts:

- At least one record read carried a `journal` field, and every record read that carried one also carried `stableEntry: "listening"`.
- No poll taken after the test first saw `stableEntry: "listening"` was refused.
- At least one poll was answered while `journal-open` was not yet recorded. S's open at 300k includes the hash chain, over 100× the poll interval.
- Through S's socket, a duplicate non-engine key and a stale engine key return the existing events.
- `runtime-host-health` is ok, and the journal reopens with a verifying chain.
- Fence-acquired → ready, from S's record, is printed as evidence.

Red at base: the stable port is unbound for the whole journal open, base S records no subphase, and it re-inserts the superseded receipts.

**Scenario B: no self-handoff.**

1. The test plays the predecessor. It sets `LLV_RUNTIME_HOST_FENCE` in S's environment and acquires `RuntimeHostFence` on that path itself.
2. It writes a small fixture with a `viewer_deployments` row: `admitViewerDeployment`, then `updateViewerDeployment` to `phase: "host-handoff"`, with `candidate` set to S's identity, `previous` to P's, and an owner whose pid is not running.
3. It writes the release record naming P, then starts S. S's container env must equal `runtimeHostSuccessorName(revision, image)` in the default (`agent-log-viewer`) spelling, because `verify-host-successor` derives the name that way. The rehearsal's `successor`-role identity already uses that spelling.
4. Once S records `fence-waiting`, the test writes the intent and publishes the record naming S, exactly as `hostSuccessor.ts:598-612` does, then releases the fence.
5. It reads the deployment row read-only until it is terminal (deadline 120 s).

Head asserts:

- the deployment row is `succeeded`, with `runtimeHostHandoff.generation` equal to S;
- S is still running;
- the intent file is gone, and the rollback target names P → S;
- the Docker stub log contains no `container start <S>` and no `container update --restart no` issued by staging;
- S's log has no "running generation is untracked".

Red at base: S logs "untracked" and the stub log shows `container start <S>`. Because the stub's `inspect` carries no `Config`, the self-staging then fails its gate, so the deployment ends `failed` and the intent remains. Under real Docker, the same path exits S and dockerd restarts it, which is the incident's second handoff.

### 3.5 CI and the existing checks

- **CI.** No workflow runs `journal*.test.ts` today, so a green "CI" would otherwise say nothing about these tests. In `.github/workflows/bun-runtime.yml`, add a step after "Verify the runtime checks fail when they should" (`:211-235`). It runs the four new or extended files with the same existence check and `across N files` guard, using isolated `HOME`/`XDG_CONFIG_HOME`/`LLV_STATE_DIR`/`TMPDIR` as the MCP step at `:237-246` does. The runner is Linux, so `processWrites` runs.
- **Must stay green, run locally one file per invocation:**
  - `journal.test.ts`, `runtimeHostStartup.test.ts`, `hostRehearsal.test.ts`, `hostRehearsalRun.test.ts`, `deployment.test.ts`, `deploymentProxy.test.ts`;
  - `bun scripts/verify-runtime-host.ts`, which in this process exercises the runtime host. The predecessor now closes its stable entry later, and the rehearsal's listener hold has to stay green;
  - `privacy-publication` and `privacy-tracker-audit`.
- **Bun pin.** It does not move, so the AGENTS.md rule on Bun pins asks for nothing beyond the rehearsal.
- **Base-red runs.** Run them by the builder against `git show e7185fec5:<file>` copies, or in a merge-base worktree, never by stashing. A base S re-inserting 279,600 receipts takes about 14 s on tmpfs but minutes on a real disk, so run the process scenarios' base-red demonstration on tmpfs and give them generous `bun test` timeouts.

## 4. Deferred — not currently justified

- **Event retention is pinned.** 304k events against the default `maxEvents` of 20,000 means compaction is held back. `compact()` (`journal.ts:1654`) never passes `MIN(consumer_cursors.completed_seq)`, and the orchestration cursor advances only over a contiguous completed prefix (`:1342-1356`), so one event deferred forever pins all history. This design makes startup cost independent of history size, so it does not depend on retention. Filing an issue is part of this lane's work. The issue carries the read-only check to run on a **copy** of a live journal (`SELECT consumer, completed_seq FROM consumer_cursors; SELECT MIN(seq), COUNT(*) FROM events;`), which this stage could not run because of the live-state fence.
- **A sequence watermark advanced on every append (§2.1).** No writer exists that appends without a receipt.
- **Gating `migrateLegacyEvents` / `migrateEntityUpdatedAt` UPDATEs.** They measured about 0 ms on the current schema.
- **Incremental or worker-thread chain verification.** It would weaken or complicate the integrity guarantee. The 4.4 s at 300k runs cooperatively after §2.3.
- **A booting responder on the runtime socket.** It would change the transport-failure classification and every replay rule built on it. The startup record carries the state instead.
- **Docker `--health-start-period`, and a UI banner for `runtime-host-booting`.** No rendered surface changes in this lane.
- **A guard against self-handoff for a crash between disabling the predecessor's restart and publishing the record** (`hostSuccessor.ts:610-612`). The window is two consecutive synchronous calls, and §2.6 removes the path that fires on every deployment.
- **Waiting out a held journal write lock (`busy_timeout = 0` plus yield).** Nothing legitimate holds the lock behind the fence.
- **Lowering `synchronous`.** Durability is a stated constraint, and batching already removes about 280,000 of the commits.

## 5. Decisions

None of these needs the operator. The code and one isolated measurement settled each:

- the receipt gate is a `journal_meta` marker plus a resume cursor (§2.1);
- the index `DROP` is deleted outright (§2.2);
- the stable entry binds after the fence and before the journal (§2.4);
- the release record is read after the fence (§2.6).
