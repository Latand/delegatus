# Viewer stalls since 28 October: root-cause account

Status: diagnosis for the lane that also builds the fixes. Written 2026-11-11 from a
read-only observation of one busy installation (24 CPUs, about 115 live agent
processes, release `803f12c1`). Nothing on that installation was changed.

This document answers four questions: what stops the Viewer and the runtime host, who
holds the locks and for how long, what changed around 2026-10-28, and which fixes this
lane builds. Every number names its source and time bounds. A sentence that starts
with "Inference:" is a conclusion drawn from the measurements around it.

## 1. Summary

1. **The Viewer's main thread is saturated.** Over the 72 hours the service journal
   retains, the Viewer's event loop was stalled 28.6 % of wall time (74 011 s of
   258 637 s). A 60 s sample of the thread's scheduler counters showed it on a CPU
   97.3 % of the time. 90 % of stalled time is in stalls shorter than 5 s. On the
   current release the largest single operation in such a stall accounts for a median
   of 11 to 13 % of it, and about 17 operations share each one.
2. **Cooperative work does not compose.** `yieldToRuntime` (`src/lib/cooperative.ts:11`)
   gives every job its own `setImmediate`. On the pinned Bun 1.4.0, N jobs that each
   yield after a 12 ms slice produce a timer gap of about 2 x N x 12 ms: 45 jobs stall
   the loop 94 % of the time in gaps of 1 075 ms, which is the gap size the journal
   shows (p50 984 ms on 2026-11-05, average 901 to 982 ms on 27 to 29 October). One
   shared queue that releases a single slice per loop turn removes the gaps at the same
   throughput (section 3.3).
3. **Three long synchronous blocks** stand out among the stalls longer than 5 s:
   role-memory history reads (up to 74 s, 124 GB read, already fixed by open pull
   request 3834 from another session), a curator apply (11 to 17 s on the loop while
   holding the state write lock), and a block of 177 full reads of the registry
   receipts collection 60 s after every Viewer start (23 to 37 s, 13 starts in 72 h).
4. **The registry write lock in the 2026-11-10 23:49Z episode was held by
   `migration.stop`**: the hygiene pass of the account-migration helper process stops a
   stale migration intent inside one write transaction that walks every conversation of
   the engine. The journal names it as holder with ages up to 94 s in that episode and
   up to 135 s in five earlier ones; a registry open waited 186.5 s through the last
   one (section 4.1).
5. **The state store in the 2026-11-11 00:12Z episode was held by a curator apply**
   (`memory.import.curation`): four holds of 15.0, 9.8, 9.6 and 10.3 s in two minutes,
   each also a loop stall of the same length (section 4.2).
6. **The refusals are amplified by two defects in the MCP path.** A process that opens
   the registry while a writer holds the lock fails after 5 s with `database is locked`
   (reproduced; a registry that is already open reads the same key in 1.4 ms), and a
   state-lock deferral raised before admission is stored as the answer for that
   `clientRequestId` on every tool that is not one of four wrapped ones (section 4.3).
7. **Around 2026-10-28 nothing was deployed and launches did not rise.** The first
   diagnosis measured the jump inside one process on one release. The count of
   conversations created that day (322) is below the days before it (430 to 684).
   Inference: the thread crossed its saturation point that morning. The journal for that
   week is gone, so the trigger cannot be measured again (section 6).
8. **The runtime host is no longer a large share.** After pull request 3804 it stalled
   23 s in 97 minutes, 18.5 s of that during its own start (section 5).

## 2. What was observed, and how

| Source | Bounds (UTC) | Read with |
|---|---|---|
| Service journal of the Viewer unit: 56 218 `[viewer loop-gap]`, 54 389 `[blocking-wait]`, 15 332 `[state transaction-hold]`, 5 091 `[state lease-hold]`, 5 971 `[mcp slow]` records | 2026-11-08 00:40:39 to 2026-11-11 00:31:16 | `journalctl --user -u <unit> -o short-iso-precise --utc`, exported once to stage scratch |
| State database, read-only consistent copy | taken 2026-11-11 00:39:59 | read-only connection, `VACUUM INTO` scratch |
| Agent registry, read-only consistent copy | taken 2026-11-11 00:55:40 | same |
| Main-thread scheduler and I/O counters | 2026-11-11 00:53:02 to 00:54:02 | `/proc/<pid>/task/<pid>/schedstat` and `io`, once a second |
| Process list of the service | 2026-11-11 00:30 to 00:55 | `ps` |

106 of the 56 218 loop-gap records did not parse and are excluded. Both databases were
opened read-only; the copies lived in the stage's scratch directory and were deleted at
the end. No profiler was attached, no process was signalled.

The loop monitor writes a gap record when its 10 ms timer is late by more than 500 ms
on the Viewer or 250 ms on the runtime host (`src/lib/viewerLoopMonitor.ts:140-145`).
"Stalled time" below is the sum of `gapMs`. A blocking wait is logged from 250 ms, and
from 50 ms for state-store sites (`src/lib/blockingWaits.ts:81,213`).

## 3. The Viewer's event loop

### 3.1 Stall share per serving process

| Release | Process lifetime in the window | Gaps | Stalled s | Longest gap ms | Heap at its largest |
|---|---|---|---|---|---|
| `13372c34` | 08.11 00:40 to 09.11 15:27 | 30 396 | 45 655 | 57 935 | 20.1 GB |
| `13372c34` (restart) | 09.11 15:29 to 19:27 | 5 178 | 7 165 | 30 112 | 11.5 GB |
| `a3fb5055` | 09.11 19:28 to 20:09 | 872 | 1 224 | 32 062 | 5.5 GB |
| `8885105f` (three processes) | 09.11 20:09 to 21:38 | 1 888 | 2 715 | 40 406 | 5.7 GB |
| `779222fe` | 09.11 21:38 to 23:30 | 1 123 | 1 401 | 28 718 | 6.6 GB |
| `cd8d4132` (three processes) | 09.11 23:30 to 10.11 13:53 | 6 892 | 7 599 | 31 513 | 9.8 GB |
| `688dc34f` | 10.11 13:53 to 16:56 | 1 909 | 2 110 | 25 421 | 7.5 GB |
| `84acdb9a` | 10.11 16:56 to 22:53 | 4 186 | 4 654 | 30 690 | 12.1 GB |
| `803f12c1` | 10.11 22:53 to 11.11 00:31 | 1 010 | 1 447 | 74 357 | 7.5 GB |

One more process (`4f1d8076`, 82 s of life on 09.11 15:27) adds 3 gaps and 40 s.

In every gap that carries scheduler samples the thread was running on a CPU: for
release `803f12c1` the thread's run time inside gaps is 1 429 s of 1 447 s (98.7 %) and
cgroup throttling is 0. The first diagnosis measured the same on 28 October (3 459 s of
run time for 3 266 s of gaps).

The 60 s scheduler sample at 00:53Z: the main thread ran 97.3 % of wall time, 55 of 60
one-second intervals were above 95 %, and it issued 18 554 reads per second (81 MB/s,
4.3 KB per read, which is the SQLite page size).

Heap size does not predict the stall share: the process with a 11 to 13 GB heap stalled
11 to 27 % per half hour, another with 4 to 8 GB stalled 42 to 69 %.

### 3.2 Ranking by share of stalled time

Exclusive synchronous time of every named reader inside gap windows
(`reads.top[].syncMs`, measured per call by `src/lib/readAttribution.ts`), grouped by
reader family. The last row is gap time in which the thread was running outside every
named reader.

| Family | 72 h, all releases | `84acdb9a` (before 3828) | `803f12c1` (current) |
|---|---|---|---|
| Stalled time | 74 011 s, 28.6 % of wall | 4 654 s, 21.7 % | 1 447 s, 24.8 % |
| Outside every named reader | 63.7 % | 59.8 % | 57.2 % |
| Agent registry reads and writes (`registry.*`) | 17.3 % | 18.0 % | 8.4 % |
| State store (`state.*`) | 6.2 % | 7.6 % | 5.9 % |
| Operation bodies outside readers | 5.1 % | 5.3 % | 4.8 % |
| Role-memory reads (`memory.view.*`) | 2.5 % | 2.2 % | 18.5 % |
| Named readers beyond the eight largest per gap | 3.0 % | 4.1 % | 3.2 % |
| Other named readers, scanner IPC | 2.2 % | 3.1 % | 2.1 % |

Two things moved between the last two columns. Pull request 3828 halved the registry
share. The same pull request introduced `scopeHistoryDigest`
(`src/lib/memory/roleViewSource.ts:584`, first present in `913cde2b`), and role-memory
reads rose from 2.2 % to 18.5 %.

By gap length, all 72 h: under 1 s 25.8 % of stalled time, 1 to 2 s 33.7 %, 2 to 5 s
30.8 %, 5 to 10 s 7.0 %, 10 s and longer 2.6 %.

### 3.3 The short stalls: many small slices in one loop turn

On release `803f12c1`, per gap:

| Gap length | Gaps | Stalled s | Largest single operation, share of the gap (p50 / p90) | Distinct reading operations (p50) | Operations pending (p50) | Longest synchronous span (p50) |
|---|---|---|---|---|---|---|
| 0.5 to 1 s | 565 | 378 | 0.13 / 0.57 | 17 | 45 | 13 ms |
| 1 to 2 s | 324 | 452 | 0.11 / 0.60 | 16 | 41 | 16 ms |
| 2 to 5 s | 92 | 248 | 0.13 / 0.73 | 18 | 44 | 27 ms |
| 5 s and longer | 29 | 366 | 0.89 / 0.99 | 21 | 47 | 17 ms |

A stall under 5 s is a turn of the loop that ran about 17 different operations back to
back, none of them long. In a stall over 5 s one operation usually owns the gap (median
share 0.89).

Reproduction, isolated, on the Bun binary the installation runs (1.4.0, the version the
`Dockerfile` pins). N jobs each burn a slice and then yield; a 10 ms timer measures the
gap exactly as the loop monitor does. Three rounds, identical within 1 %:

| Yield primitive | Slice | Jobs | Slices per second | Timer ticks in 4.5 s | Longest timer gap | Stalled share |
|---|---|---|---|---|---|---|
| own `setImmediate` per job (today) | 12 ms | 17 | 83 | 20 | 400 ms | 0 % above 500 ms |
| own `setImmediate` per job (today) | 12 ms | 45 | 83 | 8 | 1 075 ms | 94 % |
| own `setImmediate` per job (today) | 32 ms | 17 | 31 | 8 | 1 080 ms | 94 % |
| one shared queue, one slice per turn | 12 ms | 45 | 83 | 331 | 544 ms once, at the common start | 12 % (that one gap) |
| one shared queue, one slice per turn | 32 ms | 17 | 31 | 124 | 570 ms once, at the common start | 13 % (that one gap) |

Bun runs every immediate queued before a turn inside that turn. A job's 12 or 32 ms
budget bounds its own slice and says nothing about the turn. `yieldToRuntime` is called
from 82 places in 30 files, 58 places call `setImmediate` directly, and three state
store paths yield with a zero timer (`src/lib/state/sqliteStateStore.ts:1504,1645`,
`src/lib/pipelines/store.ts:1518`); inside gap windows those zero-timer yields waited up
to 7.7 s.

Inference: the short stalls are this effect on a thread that has no idle time left. The
measurements that support it are the composition table above, the 97 % utilisation and
the matching gap size. What would prove it directly is a per-turn count of resumed
slices, which the monitor does not record today (fix 5 adds it).

### 3.4 The long stalls

Over 72 h, gaps of 10 s or more add up to 1 957 s. In 816 s of that one reader owns at
least half of the gap: the receipts block 467 s, the curator apply 216 s, role-memory
search, open and curator pages 133 s. The other 1 141 s (85 gaps) have no reader with
half of the gap and belong with section 3.3.

**Role-memory history reads.** The role-memory collection holds 178 scope rows with
244 MB of JSON, 99.98 % of it retained history; the largest row is 50.4 MB with 1 957
history entries. `row_order` and `row_revision` sit behind `value_json` in `state_rows`,
so reading either walks the whole overflow chain. Measured on the copy, median of five:

| Statement (`src/lib/memory/roleViewSource.ts`) | Time | Bytes read |
|---|---|---|
| `scopeHistoryDigest` for the largest scope (`:602-609`) | 96.8 s | 98.7 GB |
| scope keys ordered by `row_order` (`keys`, `:79-84`) | 84 ms | 245 MB |
| `row_revision` of the largest scope | 18 ms | 50 MB |
| revision token over every scope (`:209-212`) | 88 ms | 245 MB |
| scope keys ordered by `row_key` (`roleScopeRowKeys`, `:166-171`) | under 1 ms | 0 |

On release `803f12c1` this reader produced gaps of 74.4 s (124 GB, `memory.search`),
36.9 s (66.6 GB), 12.0 s (`memory.open`) and seven gaps of 9.1 to 17.2 s under
`memory.import.curation`. Open pull request 3834 ("a scope's history digest loads its
row once", opened 2026-11-11 00:05Z by another session) replaces the digest statement
and announces a follow-up that moves history out of the scope row. This lane does not
touch `roleViewSource.ts`.

**Curator apply.** `curate_rules` with any action but `read` runs `applyCuration`
synchronously under `waitForStateLock` (`src/lib/mcp/bindings.ts:8834`,
`src/lib/memory/curation/apply.ts:314,326`). Seven gaps on release `803f12c1` belong to
it: 9.1, 10.3, 11.2, 17.2, 11.6, 11.3 and 11.3 s; 7.5 to 13.8 s of each was the reader
above (14 or 28 calls, 10 to 18 GB). `[mcp slow]` shows the same call from outside:
`tool=curate_rules bindingMs=14038`.

**Receipts at every start.** About 60 s after each Viewer start the loop stalls once
for 23 to 37 s with 177 calls of `registry.receipts.all` reading 30 to 33 GB (the
receipts collection is 158 MB, so each call reads all of it). 13 starts in 72 h, each
with exactly 177 calls. The one process that ran 38 hours repeated a smaller form of it
16 times (13 to 28 calls, 5 to 8 s) and the full form once, 34 hours into its life (180
calls, 57.9 s). The reader label names only the collection and the
method (`src/lib/sqliteReadAttribution.ts`), so the call site is not identified; 21
places walk `Object.values(...receipts)` (`grep` over `src/lib`). The 41 loop profiles
the journal holds from 9 November put the structured-host startup pass on the stack in
10.8 % of samples. That fits by time; it leaves the call site unproven.

## 4. Locks

Time callers spent waiting, 72 h, from `[blocking-wait]` records (a wait is logged from
50 or 250 ms, so shorter ones are missing):

| Waiting process, site | Waits | Waited s | Longest | Refused |
|---|---|---|---|---|
| Viewer, state write lock | 26 871 | 14 509 | 186.5 s | 1 153 |
| Viewer, file transaction | 12 960 | 14 135 | 72.1 s | 3 302 |
| Viewer, runtime snapshot transfer | 2 095 | 12 217 | 30.9 s | 0 |
| Viewer, registry write lock | 1 597 | 3 564 | 35.0 s | 127 |
| MCP executor processes, state write lock | 5 204 | 2 240 | 6.0 s | 10 |
| Command-line tools, state write lock | 336 | 1 800 | 60.7 s | 2 |

These waits are asynchronous: they delay the caller and leave the loop free. They
overlap each other and the loop stalls, so they are a second measure beside section 3.
The four longest state waits are registry opens (`scanner.registry.open`: 90.0, 112.9,
11.1 and 186.5 s). They end at 09.11 15:19:02, 17:51:43, 23:53:24 and 10.11 23:50:49,
each within seconds of the end of a `migration.stop` episode of section 4.1.

### 4.1 Registry write lock: `migration.stop`

The registry writer leaves a sidecar with its label and start time at
`BEGIN IMMEDIATE` (`src/lib/agent/registryWriter.ts:31-37`); a refused writer prints it
(`:48`). The journal holds 125 such lines:

| Holder label | Lines | Longest age | Episodes above 5 s |
|---|---|---|---|
| `migration.stop` | 105 | 135 113 ms | 6 |
| `registry.archive` | 12 | 7 327 ms | 1 |
| `registry.transcript-hosts` | 5 | 5 897 ms | 2 |
| `inventory.reconcile` | 3 | 5 601 ms | 1 |

`migration.stop` episodes (first to last mention, longest age seen): 09.11 15:17 to
15:18, 85.8 s; 09.11 17:49 to 17:51, 135.1 s; 09.11 22:27 to 22:28, 31.4 s; 09.11
23:52 to 23:53, 31.5 s; 10.11 12:18, 9.7 s; 10.11 23:47 to 23:49, 94.1 s. The last one
is episode 1 of the seat's report; the registry open that waited through it took
186.5 s, so the hold lasted about twice the last age a refused writer printed. In that
episode the holder's process id is the Viewer's `account-migration-controller-worker`
child; the earlier holders had exited before this observation.

What that write does. The hygiene pass stops an intent that made no progress for five
minutes (`src/lib/reaperRuntime.ts:782`,
`src/lib/accounts/migration/intentLiveness.ts:3`) with
`setMigrationIntentState(id, "stopped")` (`src/lib/agent/registry.ts:10930-10976`). In
one write transaction that method

- materialises every conversation of the registry to collect the engine's paths,
- computes `migrationReadinessSignature` over all of those paths
  (`src/lib/agent/registry.ts:1369-1390`: one conversation lookup, one held-delivery
  lookup and one entries lookup per path), and computes it again in
  `advanceMigrationScopeRevision` (`:1415-1422`),
- assigns `migrationOptOut` and `updatedAt` on every conversation of the engine that is
  not on the target account, which rewrites each of those rows,
- and, for each conversation the intent already rolled back, walks every held delivery.

The copy holds 19 344 conversations (14 291 on the engine of the intent stopped at
23:47Z), 27 635 held deliveries and 85 intents, 23 of them stopped.

The rows it touched, and a replay on the copy, are in section 4.4.

In the three minutes around the hold (23:47:30 to 23:50:30) the journal records 50 host
checkpoints that waited 250 ms or more, 18 of which wrote nothing, seven `delivery.admit`
writes refused after 5.2 s, one spawn admission refused after 30 s, and ten caller
identifications in an MCP executor process that timed out after 5.0 s.

### 4.2 State store: a curator apply, and task writes

Holders of the state write transaction and of collection leases, from
`[state transaction-hold]` and `[state lease-hold]`:

| Holder (collection, operation) | Holds in 72 h | Held s | Longest |
|---|---|---|---|
| `role_memory`, `memory.import.curation` | 656 | 1 451 | 15.0 s |
| `tasks`, a task mutation on the Viewer | 8 331 | 6 326 | 3.0 s |
| `tasks`, a task mutation in MCP executor processes | 2 467 | 1 755 | 3.8 s |
| `task_tombstones` lease (paired with `tasks`), `seat-tick.check` | 857 | 1 168 | 2.4 s |
| `role_memory`, transaction on the Viewer | 843 | 1 369 | 6.7 s |
| `pipelines`, `pipelines.mutation` | 66 | 120 | 5.3 s |

Episode 2 (00:12 to 00:14Z): the transaction log shows the Viewer holding the write
transaction for 14 961, 9 836, 9 636 and 10 279 ms, ending at 00:12:15, 00:12:34,
00:12:59 and 00:13:58, each paired with `role_memory` and `role_memory_curation` leases
held by `memory.import.curation`. In the same two minutes `state.lease.sqlite` waiters
succeeded after 2 to 4.3 s (41) or were deferred (20), one lease wait took 22.4 s, and
10 file transactions were refused. So the holder in episode 2 is the curator apply of
section 3.4. An average task write holds the transaction 0.76 s on the Viewer over 72 h
(0.39 s on the current release); why a task write is that long was not established.

The Viewer also waits for the state write lock synchronously on its main thread:
`state.write-wait` spans cover 46 s of the 1 447 s stalled on release `803f12c1`
(19 351 spans, longest 1.5 s).

### 4.3 What turned the holds into refusals

- **Opening the registry needs the write lock, and caller identification waits 5 s.**
  `identifyCallerWhenReady` waits `min(5 s, deadline)`
  (`src/lib/mcp/callerIdentification.ts:33-52`) and the HTTP layer answers `-32002`
  (`src/lib/mcp/http.ts:205`, `src/lib/mcpTask.worker.ts:117`). The journal shows the
  lookup failing with `SQLiteError: database is locked`. Reproduced on the registry
  copy with the installed release's code, while a second connection held
  `BEGIN IMMEDIATE`: a registry object that was already open answered
  `conversationIdForSpawnCapabilityDigest` in 1.4 ms (12 ms with no writer, first
  call); constructing a new registry object on the same file failed with
  `SQLiteError: database is locked` after 5 022 ms. The writable open sets a 5 s busy
  timeout and runs its schema statements (`src/lib/agent/sqliteRegistryStore.ts:1161-1163`).
  So a process that starts, or first touches the registry, during a hold cannot
  identify any caller until the writer commits, and each retry waits the full 5 s.
- **A deferral before admission consumes the key.** The server releases a claim only
  for `McpUnadmittedRefusal` (`src/lib/mcp/server.ts:3762,3812`). Only four bindings
  convert a busy store into it (`unadmittedBeforeMutation`,
  `src/lib/mcp/bindings.ts:2447-2458`: `create_pipeline`, `pipeline_action`,
  `stage_report`, `link_task_to_pipeline`), and only for two error classes. A
  `StateLockDeferredError` from any other tool is stored as that key's answer, which is
  what `seat_tick_settings` did in episode 2.
- **Connection resets** in both episodes coincide with loop stalls of 11 to 17 s
  (episode 2) and with the 5 s registry waits (episode 1). Inference: the peer closed
  on its own timeout. No socket-level record exists to confirm it.

### 4.4 The `migration.stop` hold on the registry copy

Method of the replay: the registry copy is copied again into a private state directory;
the installed release's `AgentRegistry` opens that file; the most recently stopped
intent is put back to `draining` and stopped again through `deliveryWrite` with the
hygiene pass's own label. Isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and state
directory, run through the gate wrapper, machine load average 15.

What the 23:47Z stop did, read from the copy: the intent it stopped owned three
conversations, all already `committed`. 11 010 conversation rows carry an `updatedAt`
inside the second of that stop, and 13 661 of the engine's 14 291 conversations carry a
`migrationOptOut`. A stop that had three conversations to settle rewrote eleven
thousand rows in one transaction.

Replay: one replayed stop held the scratch registry's write lock for more than 480 s
(the writer sidecar's age when the probe was stopped) and had not yet written a row:
the write-ahead log stayed at 124 KB, so all of that time is the read and compute part
of the method. The probe started with a cold registry on a loaded machine, while the
production helper keeps its rows in memory, so the replay runs slower than production
did. What it shows is where the time goes: all of it is spent before the first write,
and it grows with the row counts above. No before and after timing is claimed from it.

## 5. Runtime host, and what is left of issue 3803

| Period | Runtime-host gaps | Stalled s | `snapshot-collect` waits of 250 ms or more |
|---|---|---|---|
| To 09.11 21:38, 45 h, before pull request 3804 was deployed | 2 415 | 2 968 | 2 090 waits, 2 492 s, longest 3.0 s |
| `779222fe` to `84acdb9a`, 25 h | 220 | 113 | 11 waits, 5 s |
| `803f12c1`, 97 min | 20 | 23 | 2 waits, 1 s |

Of the 23 s on the current release, 18.5 s are five gaps in the first 17 s after the
host started, with the thread mostly off the CPU (2.9 s of run time in the 10.5 s gap).
In steady state a rebuild that crosses the 250 ms threshold spends 145 to 281 ms in
`runtime.collect` (once 690 ms) and 34 to 62 ms in `runtime.stringify`; eight such gaps
in 97 minutes. Rebuilds under 250 ms are not logged, so the median the issue asks for
(under 100 ms) cannot be read from the journal.

The Viewer side: waits for a snapshot transfer fell from 10 966 s in 45 h before pull
request 3804 to 27 s in 97 minutes (3 waits) on the current release.

Lane `d2a17781` holds no commit. Its worktree has one uncommitted change to
`src/runtime-host/journal.ts` (123 lines added, 29 removed), based on the commit before
pull request 3804: a per-entity `checkpoint_seq` stamp in place of the whole-cache wipe
on a peer commit, an undetached snapshot for serialisation, and a one-time compaction
that drops `liveTurn` from idle sessions at start. Nothing from it is taken into this
lane: the remaining share is small, the file is the runtime host's journal, and a
change there takes three review rounds under the repository's rules. The change is kept
as a patch in the lane's private evidence folder so closing that lane loses nothing.

The registry copy holds 3 405 entries with a structured host record, 3 031 of them not
updated for seven days or more; the issue counted 1 167 stale hosted sessions in the
runtime journal. Inference: periodic per-host work on the Viewer scales with these
rows. Not measured.

## 6. What changed around 2026-10-28

- **No deploy.** The first diagnosis (stage record of lane `c813466b`, 2026-10-29)
  found the same release and process serving from 27.10 23:17Z to 28.10 10:39Z, and
  the jump at 09Z inside it: 578 gaps and 380 s in 06 to 09Z, 3 039 gaps and 3 266 s
  in 09 to 12Z.
- **No rise in launches.** Conversations created per day, from the registry copy:
  20 to 23 October 550 to 684, 24 to 27 October 398 to 585, 28 October 322, 29 October
  424. The hour 09Z on 28 October had 47 after a night of 1 to 8 per hour; 27 October
  20Z had 21.
- **The stall did not follow launches down.** It stayed at 869 to 1 322 gaps per hour
  through the night of 28 to 29 October (task record), when few agents start.
- **Merged that week:** 55 pull requests on 25 October, 19 on the 26th, 22 on the
  27th, 16 on the 28th (`git log --first-parent`). The serving release at the jump was
  `e35798ad`, deployed about ten hours earlier.

Inference: the main thread was close to saturation before that morning (150 to 370
gaps per hour on 27 October), crossed it when the day's work started, and stayed
saturated because the work that fills it is periodic work over retained rows and live
hosts, which does not shrink at night. Above saturation the per-job yields of section
3.3 turn every loop turn into a stall. The journal of that week has been rotated out
(the oldest record is 2026-11-08 00:40Z), so this cannot be measured again.

What did start later and is measured: role-memory history. Retained history was 33 MB
on 28 October and 228 MB on 10 November. Curator entries rose from 86 to 463 per day
before 30 October to 427 to 1 058 per day after it, and the largest single entry grew
from tens of kilobytes to 1.2 MB. Every lesson rewrites its whole scope row (up to
50 MB).

## 7. Earlier answers, rechecked

| Earlier answer | Now |
|---|---|
| Issue 3803: the runtime snapshot rebuild re-parses every hosted session | Fixed by pull request 3804; section 5 has the remainder |
| First diagnosis: registry snapshot is the largest named blocker | Still the largest named family over 72 h (17.3 %); pull request 3828 brought it to 8.4 % |
| First diagnosis: about 70 % of sampled sites unknown | Still 57 to 64 % outside named readers; section 3.3 gives the mechanism |
| 2026-11-05: curator cancellation scope and alarm bookkeeping | Merged in pull request 3787; today's journal shows no stall share for it |
| 2026-11-05: an external profile, about 70 % native runtime | Consistent with 18 554 page reads per second on the main thread |
| Pull request 3828: lower CPU and read volume | Registry share halved; its new digest statement raised role-memory reads to 18.5 % |

No earlier transcript names `migration.stop` as a lock holder (`search_transcripts`,
project scope, 2026-11-11).

## 8. Not measured

- **A function-level CPU profile of the Viewer's main thread.** The read access this
  lane was given covers the journal, the records the Viewer writes and copies of state;
  attaching a profiler to the serving process is outside it. The built-in loop profiler
  was not armed on the current release, and when it was (41 captures on 9 November) its
  name filter kept under 11 % of samples. With a 60 s sampling profile the 57 % row of
  section 3.2 could be split by function.
- **The week of 28 October**, for the reason in section 6.
- **The call site of the 177 receipts reads** (section 3.4).
- **Which statement of the registry open takes the write lock** (section 4.3 shows
  that the open does).
- **Why an average task write holds the state transaction 0.4 to 0.8 s** (section 4.2).
- **Rebuild times of the runtime host under 250 ms** (section 5).
- **Socket-level cause of the connection resets** (section 4.3).

## 9. Fixes this lane builds, in order

Each fix lands with a test that fails on the base. Speed claims are repeated before and
after runs on identical data with the machine load recorded.

1. **`migration.stop` no longer holds the registry write lock for the whole stop.**
   Stopping an intent commits in bounded transactions and touches the rows the intent
   owns; the engine-wide opt-out is applied in slices or derived on read; the readiness
   signature is computed once, outside the write lock.
   Acceptance: on a fixture registry with 14 000 conversations on one engine and 27 000
   held deliveries, no single write transaction of a stop exceeds 250 ms, and a
   concurrent `delivery.admit` write started during the stop is admitted within 1 s.
   Recurrence test: the same fixture on the base holds one transaction for the whole
   stop and the concurrent write is refused. The result of the stop (intent state,
   opt-outs, terminalised deliveries) is compared row for row with the base.
2. **An MCP call survives a held registry write lock.** A process that only reads the
   registry opens it without taking the write lock when the schema is current, and
   caller identification waits to the call's own deadline when the store is still
   unavailable.
   Acceptance and recurrence test (the one the task asks for): a second connection
   holds `BEGIN IMMEDIATE` on the registry for N seconds while an MCP mutation arrives
   at a process that has not opened the registry yet; on the base the call answers
   `-32002` after 5 s; after the fix it is identified during the hold and completes.
3. **A refusal before admission never consumes the `clientRequestId`.** The server
   treats a state-lock deferral raised before any application callback as unadmitted
   for every tool and releases the claim.
   Acceptance: a binding that throws `StateLockDeferredError` before its mutation, then
   the same key and arguments again: the second call executes. On the base it replays
   the refusal. A test also proves that a deferral raised after a mutation started is
   still recorded.
4. **A curator apply does not block the loop while it holds the state lock.** Built on
   top of pull request 3834 once it is on main: the apply's reads run before the lock
   is taken and its write transaction contains writes only.
   Acceptance: with a scope of 400 retained entries and a 6.5 MB body (the fixture of
   pull request 3834), an apply holds the state write transaction under 250 ms and no
   loop gap above 500 ms is recorded during it. If pull request 3834 has not merged
   when the build reaches this fix, the fix is deferred and listed as the next slice.
5. **Cooperative slices go through one queue.** `yieldToRuntime` and the three
   zero-timer yields release one waiting slice per loop turn; the loop-gap record gains
   the number of slices resumed in the gap and the queue depth, so the next release
   reports whether section 3.3 was the cause.
   Acceptance: 45 concurrent jobs with 12 ms slices under the pinned Bun: longest timer
   gap after the common start under 50 ms and at least 300 timer ticks in 4.5 s; on the
   base 8 ticks and gaps above 1 000 ms. Throughput within 5 % of the base, three
   rounds each. Order within one job and cancellation of a waiting job are covered.

Before the build touches `src/lib/mcp/server.ts`, `src/lib/mcp/bindings.ts`,
`src/lib/mcp/callerIdentification.ts`, `src/lib/agent/registry.ts` or
`src/lib/agent/sqliteRegistryStore.ts`, it reads the diffs of the open pull requests
that change them: 2926, 3585, 3710, 3731, 3749, 3762, 3795, 3802 and 3805.
`src/lib/state/sqliteStateStore.ts` is changed by open pull request 3668 and
`src/lib/memory/curation/` by open pull request 3838.

This account was written against main at `2449d4c3`. Main moved by one commit while it
was written (pull request 3835, temporary-directory sweeps); that commit touches none of
the files named above.

## 10. Deferred, with the reason

| Item | Evidence | Reason |
|---|---|---|
| Role-memory row shape: history inside the scope row, `row_order` and `row_revision` behind it, the whole row rewritten per lesson | Section 3.4; 245 MB per key listing, 50 MB per revision read | Owned by pull request 3834 and its announced follow-up; not redone here |
| 177 full receipts reads after every start | Section 3.4; 23 to 37 s per start | Call site not identified, and it sits in launch recovery, which three open lanes are changing |
| Task writes holding the state transaction 0.4 to 0.8 s; seat-tick leases of 1.4 s | Section 4.2; 8 081 s held in 72 h | Cause not established; needs its own measurement |
| Synchronous `state.write-wait` on the main thread | Section 4.2; 3.2 % of stalled time | Shrinks with fixes 1 and 4; measure again after deploy |
| Runtime snapshot rebuild under 100 ms; `liveTurn` on idle sessions | Section 5 | 23 s per 97 min now; journal change needs three review rounds; patch from lane `d2a17781` kept |
| 3 031 structured host entries idle for a week | Section 5 | A retirement policy question: it needs a decision on what may be retired |
| Function-level profile of the remaining main-thread time | Section 8 | Needs profiler access to the serving process, or the counters of fix 5 after a deploy |

## 11. Check after deploy

Run over the same length of window before and after, with the load average and the
number of live host processes recorded beside the numbers.

1. `[viewer loop-gap]` records with `role: viewer`: sum of `gapMs` over wall time. Base:
   24.8 % on `803f12c1` (97 min), 28.6 % over 72 h. The stall counts as gone under 5 %
   at a comparable number of live hosts; between 5 % and the base, check 6 says which
   cause remains.
2. Lines matching `holder=migration.stop`: base 105 in 72 h, ages to 135 s. After fix 1
   no such line reports an age above 1 000 ms.
3. `[mcp caller-identification]` records with `outcome: failed`: base 14 in 12 minutes
   in episode 1. After fix 2 none while a registry writer is active.
4. `[state lease-hold]` with operation `memory.import.curation`: base 14 holds, 86 s,
   longest 15.0 s in 97 min. After fix 4 and pull request 3834 none above 1 000 ms.
5. `[viewer loop-gap]` records whose first `reads.top` row is `memory.view.all`: base
   up to 74 s. After pull request 3834 none above 2 s.
6. The new slice counter of fix 5 in gap records: if gaps persist with one or two
   slices resumed, section 3.3 is ruled out and the profile of section 8 is the next
   step.
7. Runtime host: `[viewer loop-gap]` with `role: runtime-host` after its first minute.
   Base 4.5 s in 96 minutes; it should not rise.
