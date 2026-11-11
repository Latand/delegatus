# Viewer stalls since 28 October: root-cause account

Status: diagnosis, and the fixes built from it. Written 2026-11-11 from a read-only
observation of one busy installation (24 CPUs, about 115 live agent processes, release
`803f12c1`). Nothing on that installation was changed. Sections 1 to 11 are the
diagnosis as it was handed to the build; section 12 records what was built, with the
before and after measurements, and what the build moved to the deferred list. Sections
12.7, 12.8 and 12.9 record what the three reviews of the build found in fix 1 and how
each was fixed.

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
  that the open does). Found while building fix 2: section 12.2.
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

What the build did with each of these, and its measurements, is in section 12.

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
| Fix 4, a curator apply that does not block the loop under the state lock | Sections 3.4 and 4.2; four holds of 9.6 to 15.0 s in episode 2 | Pull request 3834 was still open when the build reached it (checked 2026-11-11 02:08Z), and its follow-up 3841, opened at 01:18Z, moves the history the apply reads into rows of its own. Built on top of both once they are on main |
| Key release for the other mutating tools | Section 12.3 | The release applies to tools whose every effect is a write to a store of the serving process, and that set holds `seat_tick_settings` alone. Each further tool needs its binding read for the order of its effects |
| A state wait that ran out its deadline (`state admission timed out at ...`) still consumes the key | `src/lib/state/lockWait.ts`, `waitForStateLock`: the timeout is raised as the untyped busy error, which other code also raises after a write | Needs a typed timeout that carries its last deferral, and a reading of every caller that retries on a deferral |
| Starting an engine-wide migration reads and writes every conversation in one write transaction | `commitMigrationIntent` in `src/lib/agent/registry.ts`: one loop over every conversation, with `migrationReadiness` called without its index, so each conversation scans every held delivery and every entry. The same shape as the stop of section 4.1; not measured | Found while building fix 1. Needs the fixture of section 12.1 and its own slice |
| The registry's keyed readers walk every row a transaction has changed, on every lookup | `pathReaders` and `keyedReaders` in `loadLazyInTransaction`, `src/lib/agent/sqliteRegistryStore.ts`. Inference: this is where the stop of section 12.1 spent its 295 to 432 s (14 000 path lookups, each over 11 000 changed rows). Not profiled on the base | Any transaction that changes many rows and then looks rows up pays it. Fix 1 keeps a stop's transactions to 32 rows, which bounds it there |
| Other holders of the registry write lock above 5 s | Section 4.1: `registry.archive` 7.3 s, `registry.transcript-hosts` 5.9 s, `inventory.reconcile` 5.6 s | Four episodes in 72 h against six of `migration.stop`; not built |
| The registry file never shrinks | Section 12.2: the serving registry reads `auto_vacuum = 0`, and so does a registry created today, because the pragma is set after the journal mode has initialised the file. The file is 2.09 GB | A decision: reclaiming the space takes a `VACUUM` of the registry |
| The state store sets `auto_vacuum` on its open too | `src/lib/state/sqliteStateStore.ts`, the statement beside the store's schema. Whether it runs on every open of an existing database, and so takes a write transaction each time as the registry's did, was not established | Read and measure before changing: the state store's open path has its own retry |
| The plain registry snapshot brings its view up to date in one synchronous step | Section 12.7: 538 to 923 ms on the loop after one small transaction at incident size (load average 29 to 32); 127 and 134 ms after 32 and 1 280 changed rows (load average 19). The hygiene pass still reads it after a stop, in the helper process (`terminalizeStaleUndeliverableHeldDeliveries` in `src/lib/reaperRuntime.ts`), as it did on the base | The stop no longer reads it. Its other callers each have to move to the prepared view or to a keyed read, which is the open work on registry reads |
| Direct `setImmediate` yields and the unlabelled zero-timer yields | Section 3.3: 58 places call `setImmediate` directly; two zero-timer yields carry no label (`src/lib/state/sqliteStateStore.ts`, `src/lib/pipelines/store.ts`) | Fix 5 moves `yieldToRuntime` and the three labelled zero-timer yields. The counter of section 12.5 says after a deploy whether the rest matter |
| The whole-registry reading shows a stopped migration as waiting until the sweep has written it | Section 12.8: `readOnlySnapshot` is the stored rows; the Accounts panel and the coordinator's work list read it | Every decision is taken from the keyed read, which shows the stop at once; a projection over the whole reading would cost every reader of it |

## 11. Check after deploy

Run over the same length of window before and after, with the load average and the
number of live host processes recorded beside the numbers.

1. `[viewer loop-gap]` records with `role: viewer`: sum of `gapMs` over wall time. Base:
   24.8 % on `803f12c1` (97 min), 28.6 % over 72 h. The stall counts as gone under 5 %
   at a comparable number of live hosts; between 5 % and the base, check 6 says which
   cause remains.
2. Lines matching `holder=migration.stop`: base 105 in 72 h, ages to 135 s. After fix 1
   no such line reports an age above 1 000 ms, and the same holds for the sweep's own
   label, `holder=migration.stop.sweep`.
3. `[mcp caller-identification]` records with `outcome: failed`: base 14 in 12 minutes
   in episode 1. After fix 2 none while a registry writer is active.
4. `[state lease-hold]` with operation `memory.import.curation`: base 14 holds, 86 s,
   longest 15.0 s in 97 min. After fix 4 and pull request 3834 none above 1 000 ms. Fix
   4 is deferred (section 10), so this check waits for it.
5. `[viewer loop-gap]` records whose first `reads.top` row is `memory.view.all`: base
   up to 74 s. After pull request 3834 none above 2 s.
6. The `cooperative` field of fix 5 in `[viewer loop-gap]` records (`resumed`, `turns`,
   `depth`, `maxDepth`, `longestWaitMs`): a gap in which `resumed` is close to `turns`
   and small was not made by the queue. If gaps persist with one or two slices resumed,
   section 3.3 is ruled out and the profile of section 8 is the next step. If `depth`
   stays in the tens and `longestWaitMs` in the seconds, the thread is still saturated
   and the jobs now wait in the queue where they used to stall the loop.
7. Runtime host: `[viewer loop-gap]` with `role: runtime-host` after its first minute.
   Base 4.5 s in 96 minutes; it should not rise.
8. An MCP call refused with the text `state admission is busy at`, repeated under its
   original `clientRequestId`: for `seat_tick_settings` the repeat executes after fix 3
   and answers `replayed: false`. Base: the repeat answered the stored refusal.
9. A migration stopped with the Stop button, which runs in the serving process: between
   the request and its answer no `[viewer loop-gap]` record with `role: viewer` should
   be longer than one registry transaction (section 12.7 measured 86 to 195 ms for the
   longest timer gap at incident size). The first build of fix 1 would have produced
   one gap as long as the stop. A line `migration.stop.sweep for <intent> ended early` means a
   sweep was left to the hygiene pass; the intent then keeps a `stopSweep` value until
   that pass finishes it.

## 12. What was built

Four of the five fixes of section 9 are built, each in its own commit with its tests;
the fourth is deferred (section 10). Every measurement below was made on one machine
(24 CPUs) that was running other work; the load average is given beside each. Tests and
probes ran in isolated state directories, never against the serving installation.

### 12.1 Fix 1: a stop in bounded transactions

Stopping an intent is now one transaction for the intent and the conversations it owns,
read by key, followed by a sweep that writes the engine-wide opt-out 32 conversations
per transaction, with the write lock given up and the event loop given a turn between
them. The stop records the opt-out as a decision on the intent (`stopSweep`); until the
sweep reaches a conversation, an automatic or lazy migration reads the decision from
there, and a manual migration to the same target withdraws it. A sweep that a refused
write or a restart interrupts keeps its marker; the hygiene pass resumes it and the
archive pass leaves such an intent hot. Section 12.7 describes how the late write is
ordered against what is decided in between, and how the stop leaves the loop free.
Section 12.8 describes how the stop is in force for every conversation the intent owns
before the sweep reaches it, and how decisions made in the same millisecond are ordered.
Section 12.9 describes how the sweep tells which conversations the stop covered without
reading the clock.

The readiness signature is computed inside the stop's transaction over the
conversations the stop rolls back, where section 9 said once and outside the lock:
those are the only rows whose readiness a stop changes, so the bounded form is exact
and needs no second reading.

Fixture (`src/lib/agent/registry.migrationStop.fixture.ts`): 14 000 conversations on
the migrating engine (13 400 off the target, 600 on it), 400 on another engine, 27 000
settled deliveries, one draining intent that owns three waiting conversations with held
input and one committed conversation; a 140 MB registry. The hygiene pass stops the
stale intent in a process of its own, as the migration helper does.

| | Rounds | Write transactions of the pass | Longest hold of the write lock | Rows in the largest transaction | Pass | Load average |
|---|---|---|---|---|---|---|
| Base `917ccfbf` | 4 | 4 | 295.4, 305.1, 423.5, 431.8 s | 13 410 | 297 to 433 s | 15 to 28 |
| Head, first build | 4 | 424 | 93, 94, 98, 204 ms | 32 conversations | 9.5 to 11.5 s | 14 to 16 |
| Head, after section 12.7 | 4 | 421 | 92, 101, 112, 118 ms | 32 conversations | 10.4 to 15.7 s | 20 to 25 |
| Head, after section 12.8 | 4 | 421 | 89, 98, 114, 133 ms | 32 conversations | 9.7 to 12.4 s | 13 to 15 |
| Head, after section 12.9 | 4 | 421 | 91, 96, 101, 104 ms | 32 conversations | 8.4 to 10.2 s | 8 to 11 |

The last row is the final code; the head of section 12.8 measured again beside it, on
the same copy of the fixture, is in section 12.9, and the head of section 12.7 beside
the head of section 12.8 is in section 12.8. The first build measured again beside
the head of section 12.7: 421 transactions, longest holds 95, 98, 125 and 147 ms, pass
10.4 to 15.2 s, load average 25 to 37. The three transactions more in the first build's
own row wrote no rows and carry no label of the stop.

With 64 rows per transaction the longest hold was 117 to 176 ms and with 200 it was
212 ms, so the slice is 32 (measured on the first build, load average 14). Half of that
pass is SQLite writing the rows (0.42 ms per row, 5.6 s of an 11.3 s profile); the base
wrote the same rows.

Rows after the stop, base against the first build on one copy of the fixture: three
values differ, the `settledAt` wall-clock stamps of the three cancelled deliveries'
owners. Every conversation, delivery, intent and revision counter is equal. The code
of section 12.7 against the first build, compared the same way: the same three stamps
differ and nothing else. The code of section 12.8 adds one number to each opt-out and
one to a revision counter, and the final code writes the same rows as that for such a
stop (section 12.9).

Recurrence test (`src/lib/agent/registry.migrationStop.test.ts`, the case "a stale intent
is stopped at incident size without holding other writers out"):
while the stop runs in its own process, this process keeps admitting deliveries with a
one-second deadline. On the base the first admission made during the stop is refused
after 1 002 ms. On the head every admission is admitted; the longest wait logged was
256 ms.

### 12.2 Fix 2: opening a current registry takes no write lock

The open asked for the write lock four times whatever the state of the schema:

- `PRAGMA auto_vacuum = INCREMENTAL`, which opens a write transaction. The serving
  registry reads `auto_vacuum = 0` (read through a read-only connection), so the
  statement changed nothing there on any open;
- the archive installation, in a startup transaction (processes that may run startup
  migrations);
- the liveness projection, in a transaction that ran even when it had nothing to create;
- the first-boot import, which opened its transaction before reading whether the import
  was complete.

Each step now reads first and takes the lock only when it has something to do: a
missing object, a retired trigger to drop, a records view in its conserving form, a
projection or an import behind its version.

| Opening an initialised registry while another connection holds `BEGIN IMMEDIATE` | Five rounds | Load average |
|---|---|---|
| Base | `database is locked` after 5 006 to 5 007 ms, every round | 8.0 |
| Head | opened and read its row in 1.8 to 3.1 ms, every round | 8.0 |

Recurrence test, the one the task asks for (`src/lib/mcp/callerIdentification.test.ts`):
a second connection holds the write lock while a call arrives at a real task-executor
process that has not opened the registry. On the base the identity call and the
`update_task` call are both refused after about 5.1 s. On the head both are answered
inside the other writer's transaction, with no wait logged.

Caller identification waited at most five seconds for a registry that was not ready; it
now waits until the call's own deadline, less 250 ms for the refusal to reach the
caller. Test: the Viewer finishes its migration six seconds into a twelve-second call,
and the call is identified; on the base it failed at five seconds.

### 12.3 Fix 3: a deferral before any writer gives the key back

Every binding runs under a witness of the writers the stores of its process admitted
for it: a state collection's lease or transaction, a file transaction, a registry
mutation. A refusal that is the typed pre-admission deferral, raised while that count is
zero, releases the claim and answers `store_busy`; the same key then runs the call
again. A deferral raised after a writer entered is recorded as before.

Narrower than section 9 proposed. The witness sees the stores of its own process, so a
tool that reaches another process or a network before its first write there could be
run twice under one key. The release therefore applies to tools whose every effect is a
write to those stores, and that set starts with `seat_tick_settings`, the tool the
refusal was observed on (its binding writes the durable setting and dispatches
nothing). The other mutating tools keep their old behaviour until their bindings are
read (section 10).

Tests (`src/lib/mcp/deferredBeforeAdmission.test.ts`), with the real tool service, the
real receipt store and another connection holding the state database's write lock: the
refused call answers `store_busy` and the same key and arguments then execute; a
deferral after a first write stays the key's answer and the binding runs once; a
registry mutation before the deferral counts as a writer; a tool outside the set keeps
the refusal. On the base the first of these answers `tool_failed` and replays it.

### 12.4 Fix 4: deferred

Pull request 3834 was open when the build reached this fix. See section 10.

### 12.5 Fix 5: one queue for cooperative slices

`yieldToRuntime` and the three labelled zero-timer yields go through one queue for the
process. A turn of the loop resumes the job that has waited longest; when a resumed job
yields again and the turn has used less than 4 ms, the next job that was already
waiting when the turn began shares it; otherwise the rest wait for the next turn. So
short slices share a turn as they did, a slice longer than the budget has the turn to
itself, and a job is never resumed in the turn it yielded in. A wait can be withdrawn
with an abort signal. The loop-gap record carries the queue's counters for the gap
(`cooperative`, section 11 check 6).

Section 9 proposed one slice per turn. The budget keeps the throughput of jobs with
very short slices, which one slice per turn would have divided by the number of jobs.

Measurement (`src/lib/cooperative.loopGap.fixture.ts`): N jobs burn a slice and yield
for 4.5 s under Bun 1.4.0, a 10 ms timer measures gaps as the loop monitor does, three
rounds each, identical within one tick. Gaps are counted after every job has had its
first slice.

| Jobs, slice | | Timer ticks | Longest gap | Stalled above 500 ms | Slices per second | Load average |
|---|---|---|---|---|---|---|
| 45 jobs, 12 ms | Base | 8 | 531 ms | 3.18 s of 4.5 s | 83 | 9.2 to 9.8 |
| | Head | 329 to 330 | 3 to 4 ms | 0 | 83 | 9.3 to 9.8 |
| 17 jobs, 32 ms | Base | 8 | 535 ms | 3.21 s of 4.5 s | 31 | 9.6 to 10.1 |
| | Head | 124 | 22 to 23 ms | 0 | 31 | 9.3 to 9.9 |
| 17 jobs, 12 ms | Base | 22 | 195 ms | 0 | 83 | 8.2 to 9.1 |
| | Head | 358 | 3 ms | 0 | 83 | 8.2 to 9.1 |

The base gap here is N times the slice (531 ms for 45 jobs of 12 ms); section 3.3
reported 1 075 ms for the same shape from the diagnosis's own probe, which is gone with
its scratch. Both show the turn growing with the number of jobs; the table above is the
one that can be run again.

What this measurement does not show is the serving process: there the queue bounds
each turn, and whether the stall share falls depends on how much of it was this effect
(check 6 of section 11 answers that after a deploy). Work that is saturated stays
saturated; it now waits in the queue, where the counter reports it, and requests and
timers run between its slices.

### 12.6 Checks run

Run on the final tree, after the changes of section 12.9.

- **Tests.** One file per isolated command (private home, temporary directory and state
  directory, the control URL on a closed port), thirty files. These pass:
  `src/lib/agent/registry.migrationStop.test.ts` 59 cases,
  `src/lib/agent/registry.test.ts` 147, `src/lib/agent/registry.reseat.test.ts` 28,
  `src/lib/agent/registry.migrationBinding.test.ts` 18,
  `src/lib/agent/registry.spawnAdmission.test.ts` 18,
  `src/lib/runtime/structuredReconfigure.test.ts` 41,
  `src/lib/runtime/structuredAccountSwitch.test.ts` 17, the stop route's
  `action.test.ts` 3, the conversation migration route's `route.test.ts` 13,
  `src/lib/accounts/migration/controller.test.ts` 22,
  `src/lib/accounts/migration/ancestorAdmission.test.ts` 47,
  `src/lib/runtime/structuredSwitchCommitMessages.test.ts` 12,
  `src/lib/runtime/structuredMessageDelivery.accountReseat.test.ts` 32, the files of
  fixes 2, 3 and 5 (`src/lib/agent/registry.open.test.ts` 10,
  `src/lib/agent/registry.openUnderWriter.test.ts` 7,
  `src/lib/agent/registry.writerWait.test.ts` 31, `src/lib/mcp/callerIdentification.test.ts`
  43, `src/lib/mcp/deferredBeforeAdmission.test.ts` 8, `src/lib/cooperative.test.ts` 10,
  `src/lib/viewerLoopMonitor.test.ts` 18), and two files added to the run for section
  12.9 because they cover the takeover of a conversation the scanner made:
  `src/lib/agent/registry.projectOwnership.test.ts` 8 and
  `src/lib/agent/spawnProjection.test.ts` 52.
- **Files with failures, compared with the lane's base.** Eight neighbouring files have
  failing cases. Each was run in the same isolation on this head and on the head the
  third review read and fails with the same named cases on both; the rounds before
  compared those cases with the base `2449d4c3` and found them the same there: `src/lib/reaperRuntime.test.ts` (one case),
  `src/lib/accounts/migration/coordinator.test.ts` (two),
  `src/lib/accounts/migration/provider.test.ts` (two),
  `src/lib/runtime/structuredSwitchCancel.test.ts` (one),
  `src/lib/agent/registryArchive.test.ts` (two),
  `src/lib/agent/registry.spawnCapabilityHandover.test.ts` (two),
  `src/lib/runtime/structuredDeliveryController.nativeSwitch.test.ts` (fourteen) and
  `src/lib/pipelines/runtimeSwitch.test.ts` (nine). They are not caused by this lane;
  their cause on the base was not looked into.
- **Each new test on the code before it.** The recurrence tests of 12.1, 12.2 and 12.3
  and the measurement of 12.5 were run against the base tree and fail or stall there as
  described above. The cases of 12.7 were run against the head the first review read:
  12 of 17 fail there. The cases of 12.8 were run against the head the second review
  read: 23 of 25 fail there, and the review's own three probes, which fail there, pass
  on the final tree. The seven cases of 12.9 were run against the head the third review
  read: all seven fail there, and that review's probe, which fails there, passes on the
  final tree.
- **Typecheck.** `tsc --noEmit` over the whole tree: no errors.
- **Main.** Main is at `c963a956`, eight pull requests ahead of this lane's base: 3835,
  3837, 3834, 3832, 3840, 3847, 3839 and 3838. Of the files this round changes, 3832
  changes `src/lib/agent/registry.ts`, in the lines of the launch and pane code; the
  final tree merges with main without a conflict. On the merged tree the typecheck has
  no errors and `src/lib/agent/registry.migrationStop.test.ts` (59),
  `src/lib/agent/registry.test.ts` (137 there, after 3832 removed cases),
  `src/lib/agent/registry.reseat.test.ts` (28), `src/lib/agent/registry.spawnAdmission.test.ts`
  (18) and `src/lib/accounts/migration/controller.test.ts` (22) pass.
- **Runtime host rehearsal.** The loop monitor runs in the runtime host and reads the
  cooperative queue, and the host opens the registry through the changed path, so the
  rehearsal is run although no file under `src/runtime-host/` changed. On the final
  tree `bun scripts/verify-runtime-host.ts` under Bun 1.4.0 completed the succession in
  509 ms, and the stable listener and the runtime socket each answered 27 of 27 polls
  over 15 s (earlier rounds measured 1 008 to 1 019 ms on a busier machine, 27 of 27).
  That is a statement about the runtime host. The Viewer was not started from this
  tree.
- **Privacy publication gate.** Passed over the commits and their added lines, and
  again over the whole of each touched file.

### 12.7 Review round 1: the order of decisions, and the loop during a stop

The first review of the build found two defects in fix 1. Both are fixed, together with
what the same reading of the code turned up beside them.

#### The order of decisions

A stop decides the engine-wide opt-out at its own time and its sweep writes it later.
The first build judged whether something had been decided for a conversation since the
stop by the migration it found on the conversation, and a migration is removed once it
is cleaned up. The sequence the review ran: a stop of target A interrupted before its
sweep, a manual migration to B, a stop of B, the routine clearing of the rolled-back
migration, the first sweep resumed. The resumed sweep found nothing on the conversation
and wrote the opt-out from A over the opt-out from B. The next send then migrated the
conversation to B, the migration that had just been stopped.

The order is now read from the opt-out itself (`src/lib/agent/registry.ts`,
`stopSweepOptsOut` and the functions beside it). A conversation has one opt-out, every
decision about it carries its own time, and the newest stands:

- A sweep writes its stop's decision under the stop's time, and only where nothing was
  decided at or after that time. Whether the conversation migrated in between changes
  nothing.
- A withdrawal (a manual migration or a reseat that names the target) empties the
  opt-out. While a stop that covers the conversation has its sweep still to finish, an
  empty opt-out would read to that sweep as never decided, so the withdrawal keeps its
  time there, as an opt-out with no target. A release from before this change reads that
  value as no opt-out.
- A reader that acts before the sweep arrives (an engine-wide migration, a reseat, a
  send that follows routing) reads the opt-out that stands: the stored one, or a newer
  one that a stop decided and has not written yet.
- A stop decides for the account a conversation was on at the stop's time, taken in
  this round from the newest generation created by then. A conversation that left the
  target afterwards is not opted out of it by a late sweep. Section 12.9 keeps the rule
  and stops reading it from creation times.
- A manual migration to the stopped target withdraws the opt-outs the sweep has not
  written. It does not touch pinned conversations, so the stop's opt-out for them is
  written in that transaction, as the single transaction of the base had written it.
- A stop repeated after routing left the target decides no opt-out; the one its first
  run decided, and had not finished writing, stays.
- The coordinator completes an intent from a reading it took earlier. A completion that
  arrives while the sweep is writing leaves the intent stopped; the first build then
  dropped the rest of the sweep.

What a stop owes a conversation is fixed at the stop's time, and a conversation that is
settled, or has something newer decided for it, does not become owed again. So a sweep
makes one reading and is over with its last slice. The first build read the whole
registry again until a reading came back empty, 1 150 ms on the loop for the second
reading at incident size (load average 30).

Tests (`src/lib/agent/registry.migrationStop.test.ts`). Nine sequences of later
decisions each run on two copies of one registry, one whose sweep finished before the
decisions and one whose sweep had not started, under a clock that steps one second per
decision; the opt-out, the migration and the row time of every conversation are then
compared, with what a send does to three of the conversations. The review's sequence
has a case of its own with the expected rows written out, run once with a second
between its steps and once with every step in the same instant. Two cases make their
decisions between two transactions of a running sweep: a reseat and a rollback on rows
the sweep had read and not yet written, and a repeated stop. One case writes the
coordinator's late completion. On the head the review read, 12 of the 17
new cases fail; the other five are sequences the first build already ordered
correctly, and its own ten cases pass.

Two limits were left by choice in this round. The first no longer holds: decisions
stamped in the same millisecond as a stop were kept by its sweep, whichever was written
first, because the registry had no finer order than its clock. The second review showed
that this loses a stop that follows another decision within one millisecond, and
section 12.8 gives every decision a place of its own. The second limit stands: a send
that follows routing checks the stored opt-out before it lists the intents, as it did
before fix 1, so a conversation with an older opt-out from the routed account stays
there until a pending sweep of another target has reached it, where the base would
have moved it.

#### The loop during a stop

A registry write lock that is free is granted without a wait, so the awaits on the
sweep's writes never gave the loop a turn. A stop asked for through the Viewer's own
route (`src/app/api/account-migrations/[intentId]/action.ts`) ran every transaction in
one turn: the review measured 14 024 ms with a 10 ms timer that did not fire once and a
delivery of the same process that started 14 035 ms late. The recurrence test of 12.1
has its other writer in another process and could not see this.

The sweep now gives the loop its turn after each transaction, through the queue of fix
5, once the lock is released. Each transaction reads the sweep's marker, the intent's
state and every conversation it was going to write again, so what a turn changed is
seen. The stop's two readings of the registry come from the prepared reader view,
which the serving process and the migration helper both keep and which is brought up to
date a few milliseconds at a time. The plain snapshot brings its view up to date in one
synchronous step: after the stop's own transaction that step took 538, 823 and 923 ms
on the loop at incident size (three rounds, load average 29 to 32). A view that was
started before the stop committed is recognised by the sweep's marker and prepared
again; a sweep that cannot read or write keeps its marker for the hygiene pass, and the
stop it belongs to is still answered as stopped.

Measurement (the fixture of 12.1; one process stops the intent, keeps a 10 ms timer and
has one delivery due 10 ms into the stop; the head the review read and the final head
in turn, six rounds each):

| | Rounds | Stop | Timer ticks during the stop | Longest timer gap | The delivery started | Admitted | Load average |
|---|---|---|---|---|---|---|---|
| Head the review read | 6 | 11.7 to 17.9 s | 0 | the whole stop | 11.7 to 17.9 s late | after the stop | 22 to 40 |
| Final | 6 | 11.7 to 19.9 s | 517 to 629 | 86 to 195 ms | 22 to 53 ms late | during the stop | 22 to 39 |

Both wrote 421 transactions and the same 13 403 opt-outs. The longest timer gap on the
final head is one transaction of the sweep (86 to 184 ms).

The stop takes as long as its writes take, and in this probe it took longer on the
final head in four of the six rounds, by 1.7 to 4.1 s; one round was equal and one was
0.5 s shorter. A second probe without the timer and the delivery, two rounds each:
14.6 and 14.7 s against 13.3 and 14.3 s, with 14.4 to 14.6 s of process CPU against
13.9 to 14.4 s; the time between transactions fell from 1.80 to 1.87 s (the two
synchronous readings) to 1.64 to 1.67 s, and the time inside them rose from 11.5 to
12.4 s to 12.9 to 13.1 s. The cause of that rise was not separated from the load of the
machine, which moved a round of either head by more than a second. No gain in the
stop's own duration is claimed; the hygiene pass in its own process measures the same
on both (the table of 12.1).

Tests: the loop gets a turn between every two transactions of a stop, counted with an
immediate that re-arms itself (deterministic, small fixture); a stop at incident size
with a timer and a delivery in the same process, where the delivery has to start
within a second and be admitted before the stop ends; a view that cannot be read, and a
view older than the stop. The first two fail on the head the review read.

### 12.8 Review round 2: a stop in force before its sweep, and decisions of one instant

The second review found two more defects in fix 1. Both came from the same step of the
first build: a stop that had been one transaction became a decision followed by late
writes, and two things still read the late writes where they had to read the decision.

#### A stop is in force before its sweep arrives

The stop's own transaction settles at most 32 of the conversations the intent owns and
records the intent as stopped. An engine-wide intent owns every conversation it
enrolled, so the rest stayed `requested`, `preparing`, `successor-starting` or
`verifying` until the sweep reached them, and a sweep that the lock refused or a restart
interrupted left them so until the hygiene pass. Nothing that advances a migration read
the intent: `transitionConversationMigration` and `commitSuccessor` judged the
conversation's own migration alone. The review's probe stopped an intent over 80
conversations with the sweep interrupted and then committed a successor that was ready
for the last one: the conversation moved to the account that had just been stopped, and
a sweep leaves a committed migration alone. A second probe advanced `requested` to
`preparing` after the stop.

The stop is now read from the intent by everything that acts on a migration
(`src/lib/agent/registry.ts`, `stopOwingRollback`). While a stopped intent still carries
its `stopSweep` marker, a conversation whose migration that intent owns, and that is
neither committed nor rolled back, is rolled back:

- **For a writer.** A registry write that decides from a conversation's migration first
  writes onto that conversation what the stop owes it (`settleStoppedMigration`): the
  rollback, the cancellation of the input the migration held, and the opt-out. It is
  what the sweep writes, for one conversation read by key, in the writer's own
  transaction. The write then decides from a rolled-back migration, as it did when one
  transaction stopped the whole engine. An advance, a provider receipt and a commit are
  refused. An artifact a provider reports late is recorded as abandoned. A send
  is assigned to the account the conversation runs on, and the input the migration held
  is cancelled with the stop's reason. A rollback or a cancelled switch finds nothing
  left to re-arm. The writes that do this are the phase transition, the provider
  receipt, the continuity path, the commit, the retry, the rollback, the cancelled
  switch, the clearing of a rolled-back migration, the reseat, the reconfigure claim
  and its settlement, the engine-wide and the lazy migration request, the spawn
  capability, the resume request and the spawn settlement, and the delivery writes:
  admission, claim, retry placement, the hand-over of undispatched claims, and the
  cancellation of rolled-back input. A write that is refused writes nothing, and the
  sweep finds the stored row as it was. Two writes that read a migration are left as
  they were. Removing an account settles every migration towards it in its own
  transaction. The inventory pass holds a resumed launch back while a migration is
  creating a successor, and keeps doing so for a stopped one until the sweep has
  passed, which delays that launch and advances nothing.
- **For a reader.** `conversation` and `conversationForPath` return the conversation as
  the stop leaves it (`conversationAsStopped`): the migration rolled back at the stop's
  time, the stop's opt-out standing. The migration coordinator takes its decisions from
  these two: which branch a lane takes, and the checks it repeats after each await
  around the provider's `create`, `verify` and host publication. A stop that lands
  inside one of those awaits is seen by the next check, and the successor the provider
  made is discarded on the path a rollback already used. The delivery controllers read
  the phase through the same call.
- **Bounded as before.** The stop's own transaction and every transaction of the sweep
  are unchanged, 32 conversations at most. A write that reaches a conversation before
  the sweep adds that one conversation to its own transaction.

The marker now also carries the reason the stop gave for the input it cancels. A sweep
resumed by another process, and a writer that settles a conversation first, tell the
sender what the stop itself told the senders of the first slice; before, a resumed sweep
gave the default reason.

What still shows the stored phase until the sweep writes it: a reading of the whole
registry (`readOnlySnapshot`), which the Accounts panel and the coordinator's list of
conversations with work come from. The coordinator reads each conversation again
through `conversation` before it acts on it, so the list costs a lane that finds
nothing to do; the panel shows a conversation as waiting until the sweep has passed.

Tests (`src/lib/agent/registry.migrationStop.test.ts`), each on an intent that owns 97
conversations and is stopped with its sweep never run:

- After a restart of the registry, a conversation outside the first slice reads as
  rolled back and opted out; a transition, a transition to the recoverable failure, a
  provider receipt, a commit and a retry are each refused and the stored row is
  byte-equal to what it was; the resumed sweep then writes what the readers were told.
- A successor being created, and one ready to commit, when the stop lands: receipt and
  commit refused, the late artifact abandoned, and every conversation and delivery
  equal to those of a stop whose sweep ran uninterrupted.
- A send after the stop: assigned to the source account in a transaction that wrote one
  conversation, the earlier held send failed with the stop's reason and never claimed,
  equal again to the uninterrupted stop.
- A rollback, a cancelled switch and the clearing of the rolled-back migration, on three
  conversations holding input: no held send is re-armed.
- The coordinator itself (`advanceConversationMigration`) with a provider whose
  `create`, `verify` or host publication is the await the stop lands in, one case each:
  no commit, the conversation stays on its account, the successor is cleaned up once,
  and a second pass creates nothing.

- Thirteen writes, each the first to reach a conversation that holds a send claimed
  before the migration, one assigned before it and one held by it: a reseat, an
  engine-wide migration, a send that follows routing, a claim, a requeue, the hand-over
  of undispatched claims, the cancellation of rolled-back input, a spawn capability, a
  reconfigure claim and its settlement, a resumed launch, a rollback and the clearing of
  a rolled-back migration. Each returns, and leaves on every conversation and delivery,
  what it does after a stop whose sweep had finished.

The review's own three probes (kept beside its report) pass on this head. On the head
the review read, 23 of the 25 cases added in this round fail; the two that pass there
are orders the clock already told apart (below).

#### Decisions made in one instant

Section 12.7 ordered the decisions about a conversation's opt-out by their times and let
a sweep write only where nothing was decided at or after its stop's time. Two decisions
of one millisecond have one time. The sequence the review ran under a controlled clock:
a stop of target A that finished, a manual migration to B, a stop of B. The first slice
of the second stop wrote B. On every other conversation the sweep found A's opt-out
with the stop's own time, read it as the newer decision and left it. After the routine
clearing of the rolled-back migration, the next send migrated the conversation to B,
the migration that had just been stopped.

Every decision about an opt-out now takes a place of its own
(`nextMigrationDecisionOrder`, `migrationDecidedBefore`): a number handed out in the
transaction that decides, from the engine's conversation revision, which only grows
and is stored with the rows. A stop takes one and keeps it on its marker; a cancelled
switch, a rolled-back migration and a withdrawal that keeps its place take one each.
The opt-out stored on a conversation and the marker of a stop both carry the number,
and one comparison orders them for the sweep, for the readers that act before the
sweep arrives, and for the merge of two rows of one conversation. Time is no longer
compared where both sides have a place, so two decisions of one millisecond, and a
decision made after the clock stepped back, keep the order they were made in. A sweep
is recognised by its stop's place as well as its time, so a stop repeated within one
millisecond is not mistaken for the sweep already running.

Tests: the review's sequence under one frozen instant with the registry reopened
between the two stops, where every conversation ends opted out of B and a send migrates
nothing; an older stop's unfinished sweep resumed after a newer stop in the same
instant, which leaves the newer opt-out; a withdrawal just before and just after a stop
in one instant, which are told apart in both orders; an opt-out stored without a place.
The nine sequences and the same-instant run of section 12.7 pass; their expected
opt-outs are the same, read now beside the new number.

Rows. Each opt-out now carries its place, and the conversation revision of the engine
is higher by one for each decision. A stop on one copy of the incident-size fixture,
this head against the head the review read: 13 407 values differ. 13 403 are the place
on each of the 13 403 opt-outs, one is the conversation revision of the engine (10
against 9), and three are the `settledAt` wall-clock stamps of section 12.1. A release
from before this change reads such an opt-out without its place.

Limits, by choice:

- An opt-out written by a release from before this change has no place. Against a stop
  it is ordered by its time, and at an equal time it is kept, as section 12.7 kept it:
  a late write must not replace what may be newer. It takes a stop in the millisecond
  such a record was written, across the upgrade.
- This round read which conversations a stop covers, and the account each was on, from
  creation times. The third review showed a stop losing its decision that way, and
  section 12.9 replaces the reading: no creation time is compared any more.

#### Measurements of this round

The stop itself is unchanged in shape: the same transactions, with one number more on
each opt-out. No gain is claimed. The two probes of sections 12.1 and 12.7 were run
again, the head the review read and this head in turn on one copy of the fixture.

The stop with a 10 ms timer and one delivery due 10 ms in, in one process (the probe
of section 12.7), four rounds each:

| | Rounds | Stop | Transactions | Longest transaction | Timer ticks during the stop | Longest timer gap | The delivery started | Admitted | Load average |
|---|---|---|---|---|---|---|---|---|---|
| Head the review read | 4 | 7.9 to 10.6 s | 421 | 96, 109, 113, 128 ms | 497 to 513 | 96 to 128 ms | 8 to 25 ms late | during the stop | 18 to 35 |
| Final | 4 | 8.5 to 10.7 s | 421 | 104, 110, 118, 139 ms | 498 to 515 | 104 to 140 ms | 9 to 28 ms late | during the stop | 17 to 30 |

The hygiene pass in a process of its own (the probe of section 12.1), four rounds each:

| | Rounds | Write transactions of the pass | Longest hold of the write lock | Rows in the largest transaction | Pass | Load average |
|---|---|---|---|---|---|---|
| Head the review read | 4 | 421 | 93, 97, 100, 124 ms | 32 conversations | 9.7 to 11.0 s | 14 to 17 |
| Final | 4 | 421 | 89, 98, 114, 133 ms | 32 conversations | 9.7 to 12.4 s | 13 to 15 |

Both heads wrote the same 13 403 opt-outs in the same 421 transactions. The longest
holds and the durations overlap between the two heads; the rounds of one head differ
from each other by more than the heads do, so neither a gain nor a loss is read from
them. Neither probe runs the new path where a write reaches a conversation before the
sweep: there the write adds one conversation, read by key, to its own transaction (the
test above counts the one row), and its cost at incident size was not measured. A
read of one conversation (`conversation`) does one more keyed read, of the intent, and
only while that conversation has a migration that is neither committed nor rolled back.

### 12.9 Review round 3: what a stop covers is not read from the clock

The third review found one defect in fix 1. A stop decides an opt-out for the
conversations of its engine that existed when the intent stopped and were not on the
stopped target then. Since section 12.7 the sweep answered both questions from times: a
conversation was covered when its creation time was not after the stop's, and its
account was that of the newest generation created by the stop's time. The review's
probe created 80 conversations and enrolled them in an intent at one second, set its
controlled clock back by one second and stopped the intent. Every conversation then
carried a creation time after the stop's, the stop covered none of them, and after the
routine clearing of the rolled-back migration the next send started a migration to the
account that had just been stopped. The base, one transaction over the engine, read no
times and kept the opt-out.

#### A place against the stop

What a stop covers is now read from what the registry stores in order
(`stopSweepCovers` in `src/lib/agent/registry.ts`). A stop already takes a place among
the decisions of its engine (section 12.8). While a stop still has opt-outs to write:

- A conversation that starts is stored with the engine's conversation revision of that
  moment, which is at or above the stop's place (`stopsPassedAtBirth`, at the three
  places a conversation is made: a settled launch, `ensureConversation` and the
  scanner's reconciliation).
- A writer about to change the account a conversation runs on first writes onto that
  conversation the newest opt-out the unfinished stops decided for it, as their sweeps
  would have written it, and stores the same number on it (`settleStopOptOuts`, at a
  launch settled onto an existing conversation, at the commit of a successor, and where
  the scanner corrects the account of a generation).

The number is `stopsSettledThrough` on the conversation. A sweep passes over a
conversation whose number is at or above its stop's place, and covers every other
conversation by the account it is on now. Both questions are answered without a time. A
conversation with no such number existed when the stop was decided, because one that
started later was given the number. It is on the account it was on then, because a
change of account would have settled it first. The creation times of conversations and
generations are no longer compared, and the function that picked a generation by its
time is removed. The sweep's transactions are as they were: 32 conversations at most,
each read by key. The early write adds one conversation to the transaction of a writer
that was changing that conversation already.

A conversation is stored with the number only when it starts or changes account while
a stop is still writing: the seconds of a sweep, or the time until the hygiene pass
resumes an interrupted one. Every other row is stored as before. A conversation written
by an earlier release has no number and is read as one that existed, which it did
before any stop this release decides.

The same reading of the code found one more place that took the late write for the
decision. When the scanner finds a transcript before its launch settles, the launch's
conversation takes over the one the scanner made and copies its opt-out
(`adoptProvisionalOwner`). An opt-out the sweep had not written yet was not copied, and
the sweep cannot find a conversation that has been taken over. The takeover now copies
the opt-out that stands, stored or still on its way.

Tests (`src/lib/agent/registry.migrationStop.test.ts`), seven cases:

- The review's sequence over more conversations than two slices, under a frozen clock:
  once with the sweep run at once, and once with the sweep interrupted, the registry
  reopened and the sweep resumed. Every conversation off the target ends opted out,
  none on the target does, and after the clearing a send starts no migration for the
  first conversation or the last.
- Five changes made after a stop while the clock runs four seconds behind the stop's
  time, each once after a finished stop and once before the sweep has started, with the
  registry reopened before the sweep resumes: a conversation that starts, one the
  scanner finds, one on the stopped target that moves to another account, one whose
  account the scanner corrects to the stopped target, and one corrected away from it.
  Each is held to written-out generations, opt-out and answer to the next send, the
  same in both runs.
- The takeover of a conversation the scanner found before the stop, with the sweep not
  started and the clock running forward.

All seven fail on the head the review read and pass on this one, and the review's own
probe, which fails there, passes here.

Rows. A stop with nothing started or moved during its sweep writes what it wrote
before: on one copy of the incident-size fixture, this head against the head the review
read, three values differ, the `settledAt` wall-clock stamps of section 12.1. The same
13 403 opt-outs carry the same places. A release from before this change reads a
conversation that carries `stopsSettledThrough` and ignores the number.

Limits, by choice:

- The first limit of section 12.8 stands. An opt-out written by a release from before
  that section has no place, so a stop is ordered against it by time. A clock set back
  behind the time of such a record, followed by a stop of another target, leaves the
  older opt-out standing on the conversations the sweep reaches. Reading every record
  without a place as older than every stop would close it, and would let a late sweep
  replace an opt-out that an earlier release wrote after the stop, during a rollback of
  the release. Not built; the records without a place only age.
- The times a stop writes onto rows (`updatedAt`, `stoppedAt`) are the clock's, as
  before. Nothing is decided from them where both sides have a place.
- A sweep marker with no place is written by no release. If one is read, no
  conversation is placed behind it and it covers by account alone.
- While a stop is writing, each conversation that starts and each change of account
  reads the engine's intents once to find the unfinished stops. The same read is made
  by every send that follows routing. Its cost was not measured, and no gain is claimed
  for this round.

#### Measurements of this round

The sweep compares one number per conversation where it compared times and walked
generations; the transactions are the same. No gain is claimed. The two probes of
sections 12.1 and 12.7 were run again, the head the review read and this head in turn
on one copy of the incident-size fixture.

The stop with a 10 ms timer and one delivery due 10 ms in, in one process, four rounds
each:

| | Rounds | Stop | Transactions | Longest transaction | Timer ticks during the stop | Longest timer gap | The delivery started | Admitted | Load average |
|---|---|---|---|---|---|---|---|---|---|
| Head the review read | 4 | 8.0 to 9.5 s | 421 | 40, 102, 105, 108 ms | 485 to 513 | 40 to 118 ms | 6 to 12 ms late | during the stop | 6 to 12 |
| Final | 4 | 7.7 to 8.9 s | 421 | 95, 111, 117, 129 ms | 493 to 504 | 96 to 129 ms | 8 to 14 ms late | during the stop | 7 to 13 |

The hygiene pass in a process of its own, four rounds each:

| | Rounds | Write transactions of the pass | Longest hold of the write lock | Rows in the largest transaction | Pass | Load average |
|---|---|---|---|---|---|---|
| Head the review read | 4 | 421 | 96, 99, 104, 119 ms | 32 conversations | 8.8 to 10.5 s | 9 to 13 |
| Final | 4 | 421 | 91, 96, 101, 104 ms | 32 conversations | 8.4 to 10.2 s | 8 to 11 |

Both heads wrote the same 13 403 opt-outs in the same 421 transactions, and the
durations and the longest holds overlap, so neither a gain nor a loss is read from
them. Neither probe starts or moves a conversation during the sweep: the early write
of this round, one conversation in the transaction of the writer that changes it, was
not measured at incident size.
