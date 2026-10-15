# State database lock waits

Audit on 2026-10-15. **Current main can block a calling event loop for over
30 seconds while waiting for `state.sqlite`.** A replay of the actual transaction
helper made 6,000 failed acquisitions and 6,000 synchronous sleeps, taking
30,600.6 ms and producing a 30,608.3 ms timer gap. The helper emitted no
`[blocking-wait]` record. An asynchronous collection mutation also blocked for
735.5 ms inside its synchronous `persist()` callback.

This is a completed read-only audit and design input. It does not certify the
release criterion or an application fix. A small asynchronous transaction
prototype kept the timer gap below 6 ms under the same 750 ms competing writer.
Integrating that behavior with the existing callback, lease and durability
contracts remains build-stage work.

## Baseline, access and evidence boundaries

All dates and bounds below are UTC. Source references use
`45d25ac796d5824713c9fb57d65f57efea61041b`. `git ls-remote origin
refs/heads/main` returned that commit at 05:09:14. The branch was neither
switched nor updated. The serving deployment is
`781ecd4c33482d7486683d19d61a8b0bc8c14d38`, admitted at 00:24:48.201 and
finished at 00:28:32.843 according to
`deployment_status({compact:true,limit:3})`. The earlier incident deployment,
`61799bbcc819cde4e4e312d96c418182fd0cb74e`, finished at
2026-10-14 21:54:19.608. These are separate source and deployment observations.

At 05:10:13, byte comparisons found `sqliteStateStore.ts`,
`legacyDocumentStore.ts` and `blockingWaits.ts` identical between current main
and the running release. Process executable, cwd and database descriptors were
read through `/proc`; no live application module was imported. The production
reads followed the journal and SQLite backup methods already documented in
`docs/investigations/viewer-load-stall-2026-10-13.md:233` and
`docs/design/viewer-stalls-2026-10-14.md:337`. No production HTTP probe, debugger
attachment, signal, restart, deploy, migration or SQL write was performed.

Read-only transcript searches at approximately 05:08–05:15 used
`search_transcripts` with `state database lock Atomics` scoped to `delegatus`,
then `blocking-wait state.sqlite` unscoped, then `state-write-lock nonblocking`
scoped. The earlier architect's 2026-10-14 23:43:16.106 answer was opened using
`conversation_messages` at its returned transcript path. Its four retry sites
still exist at the cited lines. Its 37 MCP processes and its journal counts
describe its observation window; they were not reused as current measurements.
`search_memory` queries `state sqlite lock waits`, `sqliteStateStore` with the
project scope, and `state writer busy event loop` returned no relevant entries.
The desktop and native memory indexes supplied no additional lock-wait solution.

The complete static scan used text mode because `src/lib/board/store.ts`
contains a NUL byte: ordinary `rg` can stop before that file's retry loop.

```sh
rtk proxy rg -an 'Atomics.wait|busy_timeout' src/lib src/runtime-host
rtk proxy rg -an 'withImmediateTransaction|connectDatabase\(|openDatabase\(|acquireLease|releaseLease' src/lib/state/sqliteStateStore.ts
rtk proxy rg -an 'initializeStateCollections|SqliteStateCollection|importStateCollection|reimportStateCollection|recordStateImportMirror|LegacyDocumentStore' src scripts
```

Tests, fixtures and separate databases were classified separately. A TypeScript
AST scan of non-test source resolved static imports, re-exports and literal
dynamic imports with the repository's `tsconfig.json`, without executing them.
The owner inventory below is a complete cut of the call graph at the state
collection and legacy-document interfaces. Entry-point reachability describes
where a call can execute; it does not assert that each handler ran in production.

## The waits and every immediate caller

`sqliteStateStore.ts:133` sets 6,000 attempts and `:134` sets 5 ms. That is a
30,000 ms **sleep budget**, not a wall-clock deadline. SQLite calls, filesystem
checks, scheduling and rollback add time. Nested helpers have separate budgets.
All seven explicit sleep sites below run on their caller's JavaScript thread.
There is no automatic worker boundary in a collection constructor or an
`async` method's synchronous prefix.

| Sleep site | Trigger and callers | Attribution on current main |
| --- | --- | --- |
| `src/lib/state/sqliteStateStore.ts:343`, `connectRawDatabase` | Busy during connection PRAGMAs. Called by `connectDatabase:327` and `openRawDatabase:371`. `connectDatabase` is reached by `deleteLease:81`, `recordStateImportMirror:850`, `boundedPatch:1168`, `moveMatchingTo:1435`, `persistChangedRows:1975`, `persistReplacement:2053`, `acquireLeaseSync:2223`, `acquireLease:2253`. | None. Even asynchronous lease acquisition connects before its timer and `try/finally` start. |
| `src/lib/state/sqliteStateStore.ts:458`, `openRawDatabase` | Busy during journal/schema setup, `BEGIN IMMEDIATE`, index installation or commit. Called through `openDatabase:366` by initialization `:555`, import `:713`, reimport `:792`, and every collection constructor `:1006`. | None. A first read that constructs a collection can acquire a database write lock. |
| `src/lib/state/sqliteStateStore.ts:501`, `withImmediateTransaction` | Busy at begin, callback SQL or commit. All seven callers: import `:715`, reimport `:794`, import-mirror record `:852`, bounded patch `:1170`, atomic move `:1437`, changed-row persistence `:1977`, replacement persistence `:2055`. | None. The catch rolls back and retries the whole operation. |
| `src/lib/state/sqliteStateStore.ts:593`, `initializeStateCollections` | Busy in the collection-seeding transaction after database/schema opening. Direct external callers are listed below. | None. A no-op initialization still enters `BEGIN IMMEDIATE`. |
| `src/lib/state/sqliteStateStore.ts:2234`, `acquireLeaseSync` | Both SQLite writer contention and a live collection lease make `tryAcquireLease:2190` return false. Direct calls: `boundedPatch:1166`, `replaceSync:1527`, companion/own lease acquisition in `patchSync:1555/:1559/:1560`, `withSnapshotSync:1582`, `reconcileSnapshot:1644`, `checkpointMirror:1671`. | `state-lease` through `noteLeaseWait:2245`, only after a second attempt. Logs at 250 ms. No individual call-site field, and no distinction between DB busy and an existing logical lease. |
| `src/lib/board/store.ts:202`, `readBoardImportMarker` | `readStateImport` is busy during the board's first-touch marker check, called by `boardCollection:400`. Constants at `:179` are also 6,000 × 5 ms. | None. This read-only SQL probe can wait synchronously. |
| `src/lib/state/legacyDocumentStore.ts:255`, `readMarker` | Busy import-marker read from `collection:283`; used by attention, dismissals, reply suggestions and seat settings. Constants at `:77` are 6,000 × 5 ms. | None. |

For the first four loops, and for the synchronous lease loop after a failed
attempt, `accountMutationHeld()` causes an immediate `AccountCommitBusyError`
instead of sleeping. The two marker loops have no such shortcut. This explains
why an account-commit busy log establishes a refusal, without establishing a
long spin.

`openCurrentDatabase` adds another route to opening: its proxy checks the
database inode before guarded operations and can call its original opener again
(`src/lib/state/currentDatabase.ts:79`, `:102`, `:117`). Thus an already cached
collection can reach schema/connection waits after replacement. The proxy's own
three attempts contain no sleep, but each opener has the budgets above.

The asynchronous and release paths require particular care:

| Path | What yields and what still blocks |
| --- | --- |
| `acquireLease:2252` | `setTimeout` at `:2264` yields between failed acquisitions. Connection setup at `:2253` can still spin. The optional deadline is established after connection setup. |
| `boundedPatchAsync:1278` | Awaits a lease, then calls synchronous `boundedPatch:1280`; its database transaction can spin after the logical lease has been acquired. |
| `admit:1259` | A per-instance admission tail yields and takes a lease; the supplied operation can still enter the synchronous helpers. There is no global FIFO across processes or all collections. |
| `mutate:1590` | Acquires asynchronously, then supplies synchronous `persist:1603`. `persistSession:1903` selects changed-row or replacement persistence at `:1913/:1928/:1948`. Both use the unlogged transaction loop. |
| `reconcileSnapshot:1617` | Checkpoint lease acquisition uses `acquireLeaseSync(0):1644`. Its subsequent persistence at `:1652` still uses the transaction loop. A different collection's writer can win SQLite's global lock between these steps. |
| `moveMatchingTo:1422` | Awaits source/target leases in collection-name order; transaction at `:1437` is synchronous. |
| `checkpointMirrorForDemotion:1680` and `...Async:1692` | The former uses synchronous `checkpointMirror`; the latter awaits acquisition. Mirror callbacks and their import-evidence writes remain synchronous. |
| `releaseLease:2289`, `releaseLeaseSync:2283` | The async spelling calls the sync release. `deleteLease:78` tries begin/delete/commit once, so its SQL busy result is deferred to `abandonLease`; its connection setup can still spin. The retry timer `:100` calls the same delete path. |

`finishDurableHold:53` measures a logical collection lease from its successful
durable acquisition at `:2208` through successful deletion at `:87`. This already
includes a delayed continuation after `await`; preserve that boundary. Its
warning at `:58` covers only `pipelines`, strictly above 1,000 ms. It is not a
measurement of the much shorter SQLite `BEGIN`–`COMMIT` writer-lock interval.

### Native SQLite waits and exclusions

`src/lib/state/durability.ts` sets a 5,000 ms native busy timeout at `:143`
(`inspect`), `:162` (`readRevision`), `:507` (`holdWriteLock`), and `:605`
(`backupDatabase`). Activation integrity/repair and backup passes run in the
separate state-backup process through `answerBackupWorkerRequest:855`,
`runBackupPassInWorker:881` and `checkStateDatabasesInWorker:895`.
**The scheduler's revision read remains on the Viewer event loop:**
`startStateDurability:1029 → backupsDue:839 → readRevision:162`.
`stateDatabases:72` supplies the state-database revision query. None of these
native waits emits `[blocking-wait]`.

Ordinary WAL readers can proceed while another connection holds `BEGIN
IMMEDIATE`; the read-marker retry comments do not imply every ordinary writer
blocks reads. An exclusive connection/recovery condition is a distinct case,
reproduced below. The native scheduler read is a latent ≤5-second wait under
such contention, separate from the usual WAL writer competition.

`fileTransaction.ts:174` waits on JSON lock files. Account mutation locks,
registry locks, runtime journal locks, MCP receipt locks, memory/search indexes,
team state and delivery queues use other locks/databases. They are not additional
`state.sqlite` writer-wait sites. Their overlapping journal warnings must not be
counted as state-database waits.

## Process boundaries and collection callers

The Viewer reaches the store through startup, request handlers and controllers.
Startup explicitly calls initialization at
`src/lib/viewerInstrumentation.ts:352`; its async signature does not move the
work off-thread. Pipeline examples are `src/lib/pipelines/store.ts:1517`
(`mutate`), `:1531` (`reconcileSnapshot`), `:1552` (`admit`), `:1600`
(`boundedPatch`) and `:1604` (`boundedPatchAsync`).

The runtime host imports `createServerRuntimeConsumers` at
`src/runtime-host/main.ts:29` and installs it at `:290`.
`src/lib/runtime/serverConsumers.ts:60` saves flows,
`:79` saves workflows, `:83` mutates tasks, and `:44` records a spawn notice.
`src/runtime-host/host.ts:85` invokes consumers on its own event loop. These are
concrete runtime-host paths to the same synchronous lock layer; an await in the
consumer queue does not isolate them.

The stdio MCP process reaches local stores through
`src/lib/mcp/entry.ts → server.ts → bindings.ts`. Task mutations actually occur
at `bindings.ts:2038/:2080/:2131/:2553`; `:229` is the import, not a mutation
call. These calls execute on the MCP process's loop. Server-side API dispatch
can also reach the corresponding stores on the Viewer loop. The account
migration controller runs in `src/lib/accountMigrationController.worker.ts:5`;
file-response and scanner workers also have store imports/read paths. Their
synchronous work blocks their own processes. A first-touch constructor can
write even when the caller intends to read.

At **05:18:55.677–05:18:55.698**, enumeration of `/proc/<pid>/fd` symlinks equal
to the resolved live `state.sqlite` found:

| Process class | Processes with that file open | Main-database descriptors |
| --- | ---: | ---: |
| Viewer | 1 | 53 |
| Runtime host | 1 | 2 |
| Account-migration worker | 1 | 13 |
| MCP server | 9 | 93, with 4–12 per process |

The command classified only the executable's relevant script name, without
printing credentials or full arguments. These are main-file descriptor counts,
not proven connection or active-writer counts. The earlier 37-process observation
was not reproduced at this instant. No process-lifetime conclusion follows.

### Complete direct owner inventory

All rows below can be reached in the Viewer. `R`, `M`, `A`, `F`, `S`, `D` mark
additional static import reachability from runtime-host main, MCP entry, account
migration worker, files-response worker, scanner worker and durability worker.
These letters identify possible process-local execution, not evidence that an
imported function is invoked there. In particular, `D` imports many helpers
whose UI functions its backup dispatch never calls. The concrete runtime
dispatches above and the worker entry points delimit actual work.

Constructor (`C`) and initializer (`I`) lines are listed because first-touch
reads inherit their waits. `import`, `reimport` and `mirror-record` refer to the
standalone transaction helpers. Mutation/lease call sites are enumerated in the
following table; the combination covers all non-test direct owners and callers.

| Owner file and direct entry lines | Additional reachable processes |
| --- | --- |
| `src/lib/accounts/accountsStore.ts` — C :454, mirror-record :1108 | R, M, A, F, S, D |
| `src/lib/accounts/migration/provider.ts` — C :820, import :970, mirror-record :1020 | R, M, A, F, S |
| `src/lib/attention/dismissals.ts` — document :178 | R, M, A, F, S |
| `src/lib/attention/store.ts` — document :133 | M |
| `src/lib/board/store.ts` — C :213 | R, M, A, F, S, D |
| `src/lib/boardMaintenance/store.ts` — I :24, C :25 | M |
| `src/lib/bridge/store.ts` — C :476, reimport :1562, import :1626, mirror-record :1689 | R, M, A, F, S |
| `src/lib/bridge/taskChanges.ts` — I :85, C :86 | M |
| `src/lib/done/store.ts` — I :122, C :123 | M |
| `src/lib/externalRelay/publishedReferences.ts` — I :21, C :22 | M |
| `src/lib/flows/store.ts` — I :286, C :287 | R, M, A, F, S |
| `src/lib/links/boardLinks.ts` — I :20, C :21 | R, M, A, F, S, D |
| `src/lib/links/seatMessages.ts` — I :39, C :40 | M |
| `src/lib/links/taskFeed.ts` — I :128, C :129 | M |
| `src/lib/links/tombstones.ts` — I :46, C :47 | R, M, A, F, S, D |
| `src/lib/memory/curation/store.ts` — I :32, C :33 | R, M, A, F, S |
| `src/lib/memory/profileStore.ts` — I :11, C :12 | — |
| `src/lib/memory/roleStore.ts` — I :66, C :67 | R, M, A, F, S |
| `src/lib/monitor/seatTickAccounting.ts` — I :234, C :235 | R, M, A, F, S |
| `src/lib/monitor/seatTickSettings.ts` — document :309 | R, M, A, F, S |
| `src/lib/orchestrator/boardReportStore.ts` — I :58, C :59 | M |
| `src/lib/pipelines/store.ts` — I :1392, C :1412, C :1418 | R, M, A, F, S, D |
| `src/lib/projects/worktreeRecoveryStore.ts` — I :54, C :55 | R, M, A, F, S, D |
| `src/lib/prototypeReview/seatRounds.ts` — I :57, C :58 | R, M, A, F, S |
| `src/lib/spawnNotice/store.ts` — I :110, C :111 | R, M, A, F, S, D |
| `src/lib/state/legacyDocumentStore.ts` — C :264 | R, M, A, F, S |
| `src/lib/state/legacyImport.ts` — import :306, reimport :434, mirror-record :545 | R, M, A, F, S, D |
| `src/lib/suggestions/store.ts` — document :152 | M, F |
| `src/lib/tasks/store.ts` — C :349 | R, M, A, F, S, D |
| `src/lib/viewerInstrumentation.ts` — I :352 | M |
| `src/lib/workflows/store.ts` — I :353, C :354 | R, M, A, F, S |

The remaining non-test callers of returned collections are
`src/lib/memory/curation/apply.ts:57/:215` and
`src/lib/memory/roleProblems.ts:84`. They inherit the role-memory collection's
process reachability. Tombstones are written as the companion of task patches;
worktree recovery is supplied as the companion at
`src/lib/projects/worktreeBackfill.ts:277` to the board mutation. Both companions
share their owner's single SQL commit and ordered lease acquisition.

| Owner file | Direct mutation, lease or mirror call sites |
| --- | --- |
| `src/lib/accounts/accountsStore.ts` | `patchSync` :652, :671, :975, :1028, :1101; `checkpointMirror` :857; `checkpointMirrorForDemotion` :1093 |
| `src/lib/accounts/migration/provider.ts` | `patchSync` :956, :1093; `checkpointMirrorForDemotion` :1011 |
| `src/lib/attention/dismissals.ts` | `mutate` :274 |
| `src/lib/attention/store.ts` | `mutate` :208 |
| `src/lib/board/store.ts` | `patchSync` :285, :443; `checkpointMirror` :347 |
| `src/lib/boardMaintenance/store.ts` | `boundedPatch` :59, :91, :111, :129 |
| `src/lib/bridge/store.ts` | `patchSync` :687, :727, :1223, :1337, :1588; `checkpointMirror` :1284; `checkpointMirrorForDemotion` :1674 |
| `src/lib/bridge/taskChanges.ts` | `boundedPatch` :154 |
| `src/lib/done/store.ts` | `patchSync` :177, :216, :319 |
| `src/lib/externalRelay/publishedReferences.ts` | `boundedPatch` :44 |
| `src/lib/flows/store.ts` | `checkpointMirrorForDemotion` :308; `checkpointMirrorForDemotionAsync` :314; `replaceSync` :452, :473; `patchSync` :459, :488; `mutate` :501; `withSnapshotSync` :507 |
| `src/lib/links/boardLinks.ts` | `boundedPatch` :56, :71, :83, :106, :119, :130 |
| `src/lib/links/seatMessages.ts` | `boundedPatch` :86, :149, :157, :167, :194, :196, :211, :224, :232, :241 |
| `src/lib/links/taskFeed.ts` | `boundedPatch` :175, :183 |
| `src/lib/memory/curation/store.ts` | `boundedPatch` :127, :146 |
| `src/lib/memory/profileStore.ts` | `boundedPatch` :24 |
| `src/lib/memory/roleStore.ts` | `boundedPatch` :127, :201, :267, :331, :350, :379 |
| `src/lib/monitor/seatTickAccounting.ts` | `boundedPatch` :282, :292, :313, :348, :354, :618 |
| `src/lib/monitor/seatTickSettings.ts` | `mutate` :356 |
| `src/lib/orchestrator/boardReportStore.ts` | `boundedPatch` :75, :85 |
| `src/lib/pipelines/store.ts` | `mutate` :1517; `reconcileSnapshot` :1531; `admit` :1552; `boundedPatch` :1600; `boundedPatchAsync` :1604; `replaceSync` :1701; `moveMatchingTo` :1733; `checkpointMirrorForDemotion` :1742, :1745; `checkpointMirrorForDemotionAsync` :1753, :1756 |
| `src/lib/prototypeReview/seatRounds.ts` | `boundedPatch` :75, :94, :119 |
| `src/lib/spawnNotice/store.ts` | `boundedPatch` :132, :168, :183, :222 |
| `src/lib/state/legacyDocumentStore.ts` | `checkpointMirror` :116; `patchSync` :156, :201 |
| `src/lib/suggestions/store.ts` | `mutate` :286 |
| `src/lib/tasks/store.ts` | `patchSync` :398, :631; `checkpointMirror` :470; `boundedPatch` :776 |
| `src/lib/workflows/store.ts` | `checkpointMirrorForDemotion` :376; `checkpointMirrorForDemotionAsync` :382; `replaceSync` :543; `patchSync` :550; `mutate` :578 |

## What production records can count

The journal was captured at 05:10:13 with exactly these selections:

```sh
rtk proxy journalctl --user -u delegatus.service --no-pager -o json \
  --since '2026-10-14 21:54:20 UTC' --until '2026-10-14 23:44:00 UTC'
rtk proxy journalctl --user -u delegatus.service --no-pager -o json \
  --since '2026-10-15 04:40:00 UTC' --until '2026-10-15 05:10:00 UTC'
```

Count each journal `MESSAGE` containing the literal marker. Parse JSON after
`[blocking-wait]` and group by `site`, `synchronous`, `role`; parse `gapMs` after
`[viewer loop-gap]`. Use `__REALTIME_TIMESTAMP` for bounds and event time.
No wait or gap JSON failed to parse. Counters overlap and are not deduplicated
requests, unique incidents or independent outages.

| Observation | Earlier window, 109 min 40 s | Latest window, 30 min |
| --- | ---: | ---: |
| Journal records | 4,389 | 267 |
| `database is locked` messages | 11 | 0 |
| `state writer is busy during account commit` | 3 | 0 |
| `[state lease] abandoned` | 7, all included in the 11 locked messages | 0 |
| `[state lease-hold]` | 0 | 0 |
| `[blocking-wait]` | 1,243 | 51 |
| Attributed state-lease waits | 1 asynchronous; 0 synchronous | 0 |
| Attributed SQLite state write-lock waits | No logging site exists | No logging site exists |
| Runtime `request timed out` | 3 | 0 |
| Pipeline phase deadlines | 30 | 1 |
| Viewer loop gaps | 735 | 73 |
| Gaps strictly above 1,000 ms | 402 | 50 |
| Largest gap, ms | 17,840 | 3,760 |

The single state-lease warning was `pipelines`, async, 284.5 ms at
2026-10-14 23:35:39.991. The other earlier blocking-wait records were 671 async
snapshot transfers (maximum 19,928.5 ms), 35 synchronous registry acquisitions
(1,525.6 ms), 32 synchronous registry revision retries (1,243 ms), 480 synchronous
host snapshot collections (523.8 ms), and 24 async registry acquisitions
(1,469.6 ms). The latest window contains 42 async snapshot transfers (5,485.3 ms),
eight synchronous host snapshot collections (279.2 ms), and one async registry
acquisition (367.3 ms).

The account refusals occurred at 21:54:29.317286, .343047 and .366222.
Seven abandoned-release warnings named pipelines four times, tasks once,
seat-decisions once and flows once, between 22:42:54.934823 and
23:39:52.721862. The remaining locked messages include a raw error, an unhandled
rejection and an account-migration reconciliation failure. A logged failure can
be repeated by an outer handler, so 11 messages do not prove 11 distinct waits.

**The exact number and duration of successful SQLite lock retries cannot be
recovered from this journal.** Four common loops and two marker loops record
nothing, the lease recorder has a 250 ms threshold, and no exclusive stack was
captured for the 17.84-second gap. The replay proves that the mechanism can
produce such a gap; it does not attribute that historical gap to this mechanism.
Additional read access cannot reconstruct events that were never recorded.

The latest window has no logged lease-hold above one second and no busy/timeout
messages. It still has a pipeline deadline and lacks the necessary lock-wait
coverage. It therefore supplies no release-wide proof of the required calm
window. Completed-lease-only warnings also cannot exclude a lease still held
at the window boundary or a hold in another collection.

## Isolated contention measurements

One SQLite backup was taken at **05:10:12.560343–05:10:12.733056**. The source
connection used URI `mode=ro`, `timeout=0` and `PRAGMA query_only=ON`; SQLite's
backup API wrote only to an owned private destination. No live WAL/SHM files
were copied independently. The finished baseline was chmod 0400. Replays wrote
to separate writable copies of that baseline. Its SHA-256 remained unchanged:

`d4cf873dc03b7662b649d25c486b029c0a4432d8c33aabc8096fbb8fc45ef744`

The baseline is 156,934,144 bytes. The aggregate query was:

```sql
SELECT collection, count(*), sum(length(value_json)), max(length(value_json))
FROM state_rows GROUP BY collection;
SELECT count(*) FROM state_leases;
```

It contains 257 active and 654 archived pipelines, with 108,420,517 combined
JSON characters; 1,805 tasks; 2,541 role-memory rows; and zero held leases.
No production row payload is included here. Each experiment added a synthetic
`lock_audit` collection or an isolated counter table; production rows supplied
database size/index context, without replaying their business actions.

Source came from `git archive` of the audited commit into `$SCRATCH/source`.
Dependencies were borrowed read-only from the running release after its
`bun.lock` compared byte-for-byte equal. Bun was **1.4.0 (34cbb9a40)**. Private
HOME, XDG config, TMPDIR and `LLV_STATE_DIR` were under `/tmp`, with
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. No agent CLI was needed. Heavy work
ran sequentially through the supplied release's `scripts/gate-slot.sh`.

The primitive replay appended exports for existing private functions only to
the scratch source. Their bodies were unchanged. Board-marker and durability
probes used the same export-only technique. All three files were restored from
`git show HEAD:<path>` before the focused tests. Product code in the worktree
was never edited.

### Measurement boundaries

Each competitor is a separate synthetic process. It opens the copied database,
sets `busy_timeout=0`, executes `BEGIN IMMEDIATE`, records a monotonic acquisition
timestamp, writes a readiness file, waits 750 ms, updates its synthetic counter,
commits, then records the completed hold. The contender waits for readiness
before it begins. A 5 ms interval runs on the contender's own loop. Its maximum
time between callbacks includes the normal 5 ms interval; it is a measured
upper envelope of continuous starvation, not a CPU profile.

`Atomics.wait` was wrapped to count sleeps and their actual elapsed time.
`Database.exec` was wrapped around real SQL, recording busy failures, maximum
individual SQL-call time and time from successful `BEGIN IMMEDIATE` through
`COMMIT`/`ROLLBACK`. No mock lock errors were used. Setup/copying/initial schema
installation happened before measurement. Constructor contention deliberately
measures another constructor, after schema readiness. Each repeated case uses
the same data/workload boundaries; counter changes are synthetic.

The 18 nominal 750 ms competitor holds measured **750.930–753.360 ms**.
The warm uncontended store call took 3.748–4.156 ms, with a maximum 9.075 ms
timer interval. Results from 05:12:52.497–05:13:40.3 are below. Triple values
are the three runs, in order; milliseconds throughout.

| Contender operation | Operation elapsed | Largest timer interval | Maximum successful SQL-lock hold across the runs |
| --- | --- | --- | ---: |
| Collection constructor, schema already installed | 732.608 / 731.278 / 736.386 | 737.655 / 736.182 / 741.338 | 0.240 |
| `boundedPatch`, synchronous lease | 736.369 / 733.618 / 737.012 | 741.431 / 738.589 / 741.951 | 1.437 |
| `boundedPatchAsync`, contention before lease acquisition | 739.354 / 734.800 / 737.468 | 8.589 / 7.639 / 8.463 | 1.373 |
| `mutate(async ...)`, competitor starts after lease acquisition, measurement around `persist()` | 735.518 / 733.602 / 734.395 | 740.493 / 738.558 / 739.336 | 1.425 |
| Actual `withImmediateTransaction` | 735.775 / 731.472 / 733.591 | 740.803 / 736.741 / 738.649 | 0.429 |
| Async acquisition primitive, design prototype | 736.255 / 735.172 / 734.599 | 5.804 / 5.857 / 5.842 | 0.512 |

Synchronous cases made 142–144 sleeps each; the async primitive made 33 failed
begin attempts and zero synchronous sleeps. The actual async lease path made
142–143 failed attempts and zero synchronous sleeps. Maximum individual SQL
call time across these cases was 0.536 ms. The long intervals therefore consist
predominantly of waiting for the competitor, rather than holding SQLite's lock
while writing the synthetic rows.

A 2,000.928 ms competing hold produced a 1,984.843 ms synchronous store call
and a 1,989.773 ms timer interval. A 31,501.472 ms hold exhausted the actual
transaction helper: **6,000 busy failures, 6,000 sleeps, 30,411.833 ms inside
`Atomics.wait`, 30,600.642 ms elapsed, 30,608.322 ms maximum timer interval**.
It returned `FileTransactionBusyError` without entering the operation callback
or acquiring the writer lock. No successful write-lock or refusal log was
emitted by that helper. The nominal 30 seconds is therefore not a hard cap.

### Additional wait paths and a read control

At 05:16:27–05:16:31, independent copies used an exclusive SQLite connection
(`PRAGMA locking_mode=EXCLUSIVE`, then `BEGIN EXCLUSIVE`). Each competitor held
it for approximately 751 ms. This models exclusive-access contention; it is
not claimed as the ordinary production WAL-writer pattern.

| Real helper | Elapsed, ms | Maximum timer interval, ms | Atomics sleeps |
| --- | ---: | ---: | ---: |
| Board import-marker retry | 731.160 | 736.009 | 135 |
| Legacy-document import-marker retry | 731.702 | 736.665 | 137 |
| Connection PRAGMA retry | 735.678 | 739.779 | 143 |
| Durability revision read with native 5-second timeout | 730.342 | 735.729 | 0 |
| Read-only import marker against ordinary WAL `BEGIN IMMEDIATE` control | 0.588 | 5.465 | 0 |

At **05:25:50.112**, a separate seeding-race probe let schema creation commit,
then admitted a competing writer before initialization's second `BEGIN`.
The scratch SQL wrapper's injected handoff took 2.177 ms. The competitor held
the lock for 750.960 ms; the real seeding path made 146 busy attempts/sleeps,
took 836.901 ms from its first begin attempt through completion, and inserted
exactly one row. The whole call took 841.852 ms, with an 846.835 ms timer
interval. That interval includes the explicitly measured handoff and setup.
This exercises `sqliteStateStore.ts:593` separately from schema opening.
All seven explicit sleep sites now have isolated timing evidence. No production
measurement of individual native timeout waits or transaction holds is available.

### Four concurrent real collection writers

At 05:15:18.109, 05:15:20.776 and 05:15:23.753, four independent processes each
performed 100 `boundedPatch` read-modify-write operations against one synthetic
counter row on a fresh baseline copy. Each transaction increments the shared
counter and appends `(writer, sequence)`; each child yields for 1 ms between
operations. Constructors finish before a shared start barrier. This exercises
the actual collection lease, transaction, revision and change-log paths.

| Run | Completion elapsed, ms | Worst single store call, ms | Worst child timer interval, ms | Correctness |
| --- | ---: | ---: | ---: | --- |
| 1 | 2,457.398 | 350.519 | 350.765 | 400 increments; 400 distinct trace entries; each writer's sequence ordered; zero leases remaining |
| 2 | 2,788.190 | 345.876 | 347.746 | Same |
| 3 | 3,699.673 | 1,274.263 | 1,276.511 | Same |

The owned gate supplied three CPU equivalents (`60000/20000`) and 8 GiB memory;
the ancestor work slice supplied 18 CPU equivalents, with 24 effective CPUs.
The gate recorded four throttled periods totalling 41.866 ms and no OOM event.
This is shared-host synthetic contention, with scheduler variance. The result
does not predict a production percentile or establish host capacity. It proves
that correctness currently survives these concurrent writes while synchronous
waits violate the proposed responsiveness bound.

## Proposed non-blocking contract

Use **50 ms as the acceptance ceiling for any continuous main-loop hold caused
by lock waiting**, with **zero deliberate synchronous sleep on Viewer and
runtime-host loops**. Fifty milliseconds leaves headroom for ordinary syscall
and scheduling variation and is far below the multi-second failures measured
here. It is an acceptance limit, not permission to spend 50 ms at every nested
helper. Aim for ≤5 ms synchronous slices and record every wait above 50 ms.
An operating-system stall or a large SQL statement can still exceed a timing
target; measure and attribute those separately.

1. Centralize connection, schema, migration and transaction admission around a
   monotonic absolute deadline. `busy_timeout=0` applies explicitly to every
   connection. Execute and verify each PRAGMA separately, matching the project's
   Bun SQLite convention. The deadline starts before connection setup and is
   shared through nested admission, rather than restarting at each layer.
2. The async helper retries **acquisition** with timer backoff, for example
   1, 2, 4, 8, 16, then 25 ms with bounded jitter. It yields with no SQL
   transaction open. Once acquired, run the synchronous SQL unit and commit;
   never keep `BEGIN IMMEDIATE` open across arbitrary I/O or a timer. Handle
   post-admission/commit failures distinctly: a busy failure after a callback
   may not safely replay its external effects.
3. Route async store entry points all the way through that helper. Replacing
   only `acquireLease` leaves `persistSession`, `boundedPatch`, initialization,
   move and release connections blocking. Preserve collection-name lease order
   for companions, ownership tokens/PID identity, stale-owner fencing, authority
   rechecks, row revisions, change logs, atomic moves and companion writes.
   `openCurrentDatabase` must still reject replacement before commit.
4. Existing synchronous APIs cannot return an awaited retry transparently.
   A main-loop sync call gets a single nonblocking attempt and a typed
   **pre-admission** deferral only where its caller owns retry ordering. Audit
   and adapt the listed callers before enabling that policy. Queue the same
   operation/key in order; never acknowledge success before its commit or drop
   a failed persistence callback. For callbacks that must observe durable
   `persist()` before subsequent actuation, introduce an awaited commit boundary
   and update callers, or execute the complete bounded storage operation in a
   worker. Arbitrary JavaScript closures cannot simply be posted to a worker.
5. Keep MCP-side transactions and ordered read-modify-write semantics intact.
   They may retain synchronous retries on their own processes during migration,
   provided every long wait is attributed. Their busy timeout and refusal
   behavior must not change merely because Viewer APIs become async. Longer
   term, an async per-collection queue can yield in MCP too. SQLite and the
   durable collection lease remain the cross-process serialization authority;
   per-process queues do not supply global FIFO. Preserve order where the API
   already promises it, including same-key retry receipts.
6. Move the scheduler revision read into the existing durability worker, or
   give it a zero-timeout try and defer the tick. Bring board/legacy marker
   probes into the shared policy. Preserve release ownership and startup fences;
   do not bypass them to make initialization asynchronous. Acquisition failure
   must release earlier companion leases. Deferred release cleanup must remain
   bounded and durable enough for the existing stale-owner recovery contract.

Merely reducing 6,000 attempts to six bounds requested sleep to 30 ms. It does
not bound nested wall time, cover the other synchronous loops, provide ordered
retry to callers, or preserve eventual completion by itself.

### Attribution

Extend `recordBlockingWait` at `src/lib/blockingWaits.ts:99` with a stable state
database site and explicit phase/call-site fields. The existing threshold at
`:68` is 250 ms; state lock waits need a 50 ms threshold. Capture a start before
the first attempted connection/admission. Record completion in `finally` on
success, refusal, timeout, cancellation and error. Include:

- Stable source site such as `state.transaction.persistChangedRows`, source
  file/line (or a versioned site-to-source manifest), collection, release and
  process kind/PID. Runtime identity comes from the process entry point; an
  inherited owner environment value alone is insufficient.
- Total acquisition elapsed, attempt count, deliberate synchronous sleep,
  maximum synchronous slice, async backoff time, and outcome. Separate SQLite
  busy from an existing collection lease and local admission-queue delay.
- Existing correlation label/operation id when present; a stable fallback label
  when absent. No SQL values, row JSON, user text, account identifiers, home
  paths or credentials in logs.
- Separate SQL transaction hold and logical lease hold. Start SQL hold timing
  immediately after successful `BEGIN`; end after commit/rollback. Keep logical
  lease timing at successful durable acquisition, before an async continuation,
  through actual deletion, including deferred cleanup. Extend lease-hold coverage
  to all collections and expose currently held age at window boundaries.

Every wait over 50 ms emits a `[blocking-wait]` record, including successful
async waits and MCP waits. Keep refused attempts attributable even if short.
Use bounded in-memory counters for the complete distribution below the logging
threshold. An async wait's elapsed duration must not be labelled as event-loop
hold; preserve separate fields. A wait that never finishes needs an in-flight
age observation or independent watchdog, so a process death cannot erase it.

### Existing parallel work

`list_pipelines({state:"open",compact:true})` at approximately 05:09 showed the
heap, snapshot and MCP writer audits alongside this audit. Their ownership is
unchanged. PR #2905, inspected through `gh pr view 2905 --json headRefOid,files`
and the paginated PR files API, was at
`45a4277a2b356c106c8226422f7858d54d2cdf7b`. Its actual diff overlaps
`sqliteStateStore.ts` and `blockingWaits.ts`: six-attempt synchronous loops,
`sleepForStateWriter`, `measureStateWriteWait`, `state-write-lock` logging,
performance spans and pipeline evidence indexes. The synchronous lease loop
still uses `LOCK_ATTEMPTS`; the ordinary logging threshold remains 250 ms.

The builder must reconcile those actual hunks before changing the lock layer.
Keep its pipeline-evidence indexes, controller work and span instrumentation;
avoid duplicating a second attribution mechanism. The other lanes own heap,
snapshot payload and MCP process lifetime changes. A future PR or deploy is
not evidence this audit could or should supply.

## Reproduction and before/after acceptance

The read-only capture operation was:

```python
source = sqlite3.connect(source_path.as_uri() + '?mode=ro', uri=True, timeout=0)
source.execute('PRAGMA query_only=ON')
target = sqlite3.connect(scratch_baseline)
source.backup(target, pages=512, sleep=.01)
target.close()
source.close()
```

Keep that one baseline immutable and create fresh working copies for every
candidate run. Reuse the exact snapshot, Bun binary, process quotas, writer
count, barriers, timing boundaries and operation sequence for before/after.
Measure startup/first-open separately from warmed calls. The observed wait
starts roughly 20 ms after competitor readiness because the 5 ms timer was
primed for 20 ms; compare the measured competing hold, not only its requested
sleep. No fresh production snapshot is needed for each variant.

The design-only primitive used for the table is equivalent to:

```ts
async function transaction(db, operation) {
  const deadline = performance.now() + 30_000;
  let attempt = 0;
  for (;;) {
    try { db.exec('BEGIN IMMEDIATE'); break; }
    catch (error) {
      if (!/locked|busy/i.test(String(error)) || performance.now() >= deadline)
        throw error;
      await Bun.sleep(Math.min(25, 2 ** Math.min(attempt++, 5)));
    }
  }
  try { operation(); db.exec('COMMIT'); }
  catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
```

This demonstrates scheduling only. The production helper needs the authority,
deadline, cancellation, lease, replacement and attribution contracts above;
the prototype is not a drop-in patch. Its after column is not an application
after result.

Scratch commands were run in this form, with `$GATE` naming the supplied
running release's `scripts/gate-slot.sh`, `$BUN` the verified Bun executable,
and `$SCRATCH` the owned `/tmp` audit directory:

```sh
rtk proxy env HOME="$SCRATCH/home" XDG_CONFIG_HOME="$SCRATCH/config" \
  TMPDIR="$SCRATCH/tmp" LLV_STATE_DIR="$SCRATCH/state" \
  LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 LLV_GATE_BUN="$BUN" \
  NODE_ENV=test LLV_STATE_OWNER=viewer PATH=/usr/bin:/bin \
  bash "$GATE" "$BUN" "$SCRATCH/replay.ts"
# Then concurrent.ts and extra.ts, one admitted command at a time.
```

The raw local harnesses and results remain private scratch evidence, outside
the repository. The replay script SHA-256 is
`b523c669460b014f2d72a1c5c37a932be8ffde7253e657dc1c8c1416d6fc7c53`;
the four-writer coordinator is
`f457c1e1ca40641c9bae029a99347c0ca05253faa4af8ea1db228e2249d9542e`.
The declared document retains the input dimensions, algorithm, command forms
and raw timing triples so its conclusions do not depend on private row content.

The build's before/after check must cover all seven explicit sites plus native
revision-read contention, including the seeding race after schema opening.
Require three runs of each 750 ms case, the 2-second and exhausted-deadline
controls, and the four-writer trace check. Add a same-event-loop lease holder
that releases from a timer: the old synchronous contender should starve its
release, while the candidate must let it progress. Also force the race after
`acquireLeaseSync(0)` but before checkpoint persistence, and a connection reopen
after inode replacement. Do not equate a green async-acquisition test with a
green async-commit path.

For the candidate, every observed synchronous lock-wait slice and 5 ms probe
interval must stay ≤50 ms under this workload; each >50 ms elapsed acquisition
must have one attributable record with the correct outcome and process. Verify
logs for waits just above 50 ms, below the old 250 ms threshold, failed waits,
and missing operation correlation. Assert callback execution/acknowledgment
counts, 400 distinct ordered writes, revisions/change-log visibility, rollback,
companion atomicity, no lost lease ownership, recovery after process death,
release-fence handoff, and no write after timeout/cancellation. Timeout and
cancellation must not silently become successful empty writes.

Finally run the real candidate Viewer and runtime host, with concurrent MCP
writers, on isolated state. Primitive timing alone does not prove process-level
acceptance. Runtime-host changes require
`bun scripts/verify-runtime-host.ts --runtime <pinned-bun>` through the owned
gate. Required publication CI includes `bun-runtime`, native Codex and their
`runtime-gate` join plus `privacy-publication`. After deployment, collect a
timestamped 30-minute journal window with complete wait instrumentation and
in-flight lease coverage. Require no logical lease hold >1 second and no
busy/timeout burst; preserve throughput and error counts so reduced work cannot
masquerade as a responsiveness improvement.

## Validation and remaining limits

At approximately 05:17:44–05:17:55, exact main source in the scratch export ran:

```sh
bash "$GATE" "$BUN" test \
  src/lib/state/sqliteStateStore.bounded.test.ts \
  src/lib/state/sqliteStateStore.lifecycle.test.ts \
  src/lib/state/stateLeaseRecovery.test.ts
```

The command used fresh private test HOME/config/state/temp roots and the closed
control URL. **22 tests passed, 166 assertions, zero failures, 10.86 seconds.**
This checks current rollback, leases, snapshot fencing and descriptor cleanup;
it does not establish a non-blocking implementation. The first replay launch
failed before starting because the gate could not find Bun in the restricted
PATH; setting its supported `LLV_GATE_BUN` resolved it. No failed measurement
was discarded as a passing run. CPU admission waits were excluded from runtime
timings. At 05:18:55 every recorded synthetic child PID was absent.

Only this document is a worktree output. Nothing is staged, committed or pushed.
The final local validation uses the scratch copy of the project's privacy gate
against this explicit document path, with committed known-value fingerprints:

```sh
rtk proxy env LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE="$SCRATCH/source/scripts/privacy-known-value-fingerprints.json" \
  "$BUN" "$SCRATCH/source/scripts/privacy-publication-gate.ts" \
  --repository "$WORKTREE" --require-known-values \
  --paths docs/perf/state-db-lock-waits.md
rtk proxy git diff --no-index --check /dev/null docs/perf/state-db-lock-waits.md
rtk proxy git status --short --ignored
```

The privacy command also inherits the private test HOME/config/state/temp roots
and the closed control URL. Privacy and whitespace checks passed at 05:26:58,
then were repeated after the final source-reference correction. The worktree
contains only the declared untracked document, with no generated ignored files.
No runtime-host rehearsal was required for this documentation audit; no runtime
or dependency source changed. Historical exact SQLite wait
counts, a causal stack for the 17.84-second production gap, production SQL hold
durations and a full application after result remain explicitly unclaimed.
