# Viewer memory telemetry

The existing loop monitor retains up to 120 samples, at most one every
15 seconds, with a 30-minute age limit. Read them on demand through
`GET /api/onboarding/diagnostics?loop=1`. This uses the diagnostic route's
existing access perimeter and cross-origin guard, returns `no-store`, and
does not run the installation doctor. Ordinary doctor reads are unchanged.
The existing loop-gap journal records remain available.

Each sample carries PID, the process incarnation (`start`), its epoch in
milliseconds (`timeOrigin`), serving revision, sample clocks and role. A
missing revision stays null. RSS comes from the watchdog worker's asynchronous
`/proc/<pid>/status` read. Its own timestamp travels with the value, so an old
RSS observation is distinguishable from a fresh sample. Unsupported platforms,
failed workers and a monitor that has not started report null RSS. No heap
snapshot, forced collection or new profiler attachment is involved.

Gap counts, total duration and maximum duration cover the sampling interval.
`operations` retains up to 16 existing operation labels that overlapped gaps,
including synchronous work that returned before the delayed timer ran.
`sites` separately retains up to 16 existing measured sites, preferring
synchronous work. Omitted labels and operation-recorder overflow are explicit.
An awaited operation's presence establishes overlap; it does not assign CPU
time or retained memory to that operation. `cache.accounting` labels the new
mutation-time size calculation.

## Ownership inventory

This inventory follows the Viewer request/controller imports. A name below
identifies an owner in `src/lib/` unless the row gives another prefix. The
telemetry registry contains scalars only, aggregates instances of the same
owner/name, and retains at most 256 owner/name pairs. Names come from code;
keys, paths, transcripts, credentials and cached values never enter samples.
Explicit removal updates the counters immediately. Weak owners release their
charges when the VM finalizes them; telemetry holds no strong reference to
the cache or its keys.

| Owner | Cached data | Existing retention / eviction |
| --- | --- | --- |
| `scanner/caches` via `scanner/activity` | `tail-v3`, `head-records-v2`, `turn-evidence-v3` | 64 tails; 64 heads / 16 MiB source; 4,096 turn records |
| `scanner/caches` via `scanner/head` | `scanner-head-v1` | 2,048 entries / 32 MiB buffers; oldest first |
| `scanner/caches` via `scanner/links` | background commands and indexes, lineage, compact links, slug and chain lookups | Nested background maps and lineage cap at 20,000; several outer metadata maps have no total cap |
| `scanner/caches` via `scanner/needle` | per-needle checkpoints and tail UUID indexes | Read windows bounded to 1 MiB; outer maps have no total cap |
| `scanner/caches` via `scanner/describe` | transcript metadata, project overlays, titles, cwd, start times, project resolutions | Generation/identity invalidation; outer maps have no total cap |
| `scanner/caches` via `scanner/model`, `effort`, `context`, `plan`, `wakeup`, `questions`, `turnDuration`, `codexNative`, `transcripts`, `projectDirectories`, `json` | Derived transcript fields and sidecars | Per-file identity/version replacement; most maps have no total cap |
| `scanner/caches` via `session/reader`, `timeline`, `review/reviewOutcome`, `lifecycle/transcript` | Authorship checkpoints, timeline, review outcome, provider progress | Per-file replacement; provider progress caps at 4,096 |
| `scanner/scanCache` | Full snapshot and pinned snapshots | One current generation; eight pins, oldest first |
| `scanner/conversationCatalog` | Pagination and project-scoped slices | 16 pagination generations / 20,000 retained rows (one oversized generation can remain); eight slices per weak source/ownership pair |
| `src/app/api/files/operatorProjection` | Full representations and weak gzip bodies | 32 scopes, oldest first; gzip follows representation lifetime |
| `boardEncoding` | Structured comparison bases | Four scopes / 96 MiB encoded size / 120 seconds |
| `boardHistory` | Delta links and encoded/gzip answer reservations | 32 scopes, 32 links per scope, 16 MiB, 120 seconds |
| `team/workspaceFilesResponse` | Authorized member response bytes | 16 entries / 32 MiB; oversized responses served without retention |
| `state/collectionReadCache` | Shared decoded collection and controller-row slots; archive generation | Eight hot slots / 256 MiB source; one archive / 512 MiB source; oldest hot slot first |
| `agent/sqliteRegistryStore` | Hot parsed rows; cold readers; stable archived rows | Hot rows follow current database rows; cold readers cap at 128; stable rows retain the existing source-byte bound; a retained closed store stays counted until collected |
| `state/historyProjection` | Warm counts and headless owner projections | Existing revision-key replacement; headless cache caps at two entries / 16 MiB |
| `state/cachedJsonFile` owners `forge/cache`, `operator/settings`, `projects/settings` | Decoded file snapshot | One path/version per owner; failed or unstable read and invalidation clear it |
| `resourceCollector` | Last successful resource observation | One observation per collector; failed refresh keeps the previous generation |
| `mcp/pageCursors` | Immutable continuation strings | 2,048 entries / 8 MiB / five minutes; FIFO |
| `mcp/budgetPage` | Byte-split observed pages | 128 per weak service owner; five minutes |
| `runtime/eventStore` | Decoded event ledgers | 64 ledgers / 64 MiB source; oldest first |
| `runtime/deliveryEffectPages` | Conditional effect pages | 32 pages / 8 MiB / 30 seconds |
| `runtime/client` | Deployment-list capability observations | 32 endpoints |
| `activity/tokenReport`, `activity/agentSource` | Aggregate reports and conversation observations | 16 reports and six conversation ranges; existing TTLs |
| `orchestrator/seats` | Recipient-authority files and derived indexes | Eight entries per cache, oldest first |
| `orchestrator/health` | Attachment scan checkpoints | 64 transcripts |
| `pipelines/preflight`, `pipelines/backgroundTasks` | Successful preflights and incremental background ledgers | 32 preflights / five seconds; 256 ledgers |
| `externalRelay/stepObservation`, `externalRelay/conversations` | Transcript tool progress, conversation views and run ledgers | 256 progress entries; eight conversation and eight run-ledger entries |
| `memory/roleStore`, `memory/curation/store` | Rendered project views, curation counts and summaries | 16 views / 8 MiB; 32 counts / 512 KiB; 32 summaries |
| `projects/git`, `accounts/codexServiceTiers` | Repository resolution and model catalogs | Existing per-path invalidation; 64 model catalogs |
| `monitor/seatQuotaRecovery`, `monitor/seatTickReports`, `lifecycle/liveness` | Turn evidence, unchanged-report revisions, headless verdicts | 64 evidence entries; 128 revisions; 8,192 verdicts per weak probe owner |
| `voiceCompanion/readPaths`, `selfUpdate/green` | Search handles and final check verdicts | 1,024 handles; eight final verdicts |

This slice preserves those owners' existing policies, including the uncapped
metadata families identified above. A new count limit would change their
behaviour and is separate work. Database connections and native SQLite page
caches, active delivery/controller state, request-local maps, module code,
VM/allocator overhead and subprocess caches are outside payload accounting.
Worker processes have their own globals and RSS; these records describe the
process whose PID is in the sample. Weak derived views sharing an already
counted snapshot are references to the same data, so the columns cannot be
summed into an exclusive heap total.

## Byte accounting and work bounds

`bytes` states the amount charged by that cache, with its `basis` alongside:
encoded JSON bytes, source UTF-16 bytes, source JSONL bytes, buffer bytes or a
documented reservation. Generic payload estimates count UTF-16 strings,
numeric scalars, object field names, maps, sets and buffer view lengths. They
exclude object/allocator overhead, native handles and accessors, and deduplicate
references within one entry. Traversal has depth and object-count bounds. An
unreadable or over-budget estimate increments `unmeasured`, preserves the cache
write and contributes no invented bytes. These are payload measurements and
estimates; RSS includes additional memory.

The counter wrapper updates a saved charge on `set`, subtracts it on `delete`
and clears it on `clear`. In-place scanner/history changes explicitly refresh
their charge. The per-needle checkpoint owner keeps a scalar payload sum on
each entry. After its first measurement, a write measures only the changed
file's five checkpoint fields and applies their byte delta, including deleted
hits and boundaries on reset. Accounting work per candidate is independent of
previously retained files, including when the read allowance is exhausted.
The scalar uses a shared symbol so it survives module reload; it is accounting
metadata excluded from the payload estimate. Replacing an entry starts a new
sum; cache deletion and clear release the saved charge. An unreadable delta
marks the entry unmeasured until replacement and cannot refuse scanning.
Small collection-slot aggregates update on their existing
mutation path (at most eight slots). The monitor copies at most 256 scalar
rows once per sampling interval. Its healthy RSS read checks one shared-memory
slot. It never enumerates a cached store, invokes an owner callback, serializes
a cache or reads the filesystem for this telemetry.

## Verification and cost measurement

Tests use the production monitor, scanner cache factory, board encoder/history,
cursor store, file-scan runner, resource collector and registry builders. They
cover replacement/deletion/clear, eviction/expiry, unreadable estimates,
independent RSS timestamps, access guards, detached reads, and fresh-process
retention/owner-budget reset. The no-scan test poisons both a populated cache's
iterators and its payload enumeration after mutation.

Run `scripts/measure-loop-monitor.ts` unchanged in isolated base and candidate
exports, through the gate wrapper under the same admission. Copy the candidate's
driver into both exports; the baseline predates it. It seeds 5,000
1,024-character values, 64 4-KiB buffers and 64 additional one-entry owners
(66 owners and 5,128 entries total), drives 200,000 ticks per round,
discards one warmup and reports seven rounds. Healthy ticks advance by 10 ms;
the gap workload adds 750 ms every 500 ticks inside `files.get`, with a pending
`history.read` in both workloads. Timing includes the tick driver and gap
operation bookkeeping, and excludes cache setup and diagnostic reads.
The synthetic monitor does not start a live sampler; worker RSS is verified
separately through real-worker tests. This measures observation overhead and
makes no application speedup or retainer diagnosis claim.

Recorded on Bun 1.4.0 against base `dae645df5b87b6091ef0780ec1c9d3b487fbb826`,
in base/candidate/candidate/base process order under one gate admission.
This historical tick record uses the initial telemetry implementation at
`8f1376ad3673548ad1732c2dc7f51080a969557e`. The later mutation mode extends the
driver outside that timed loop and records its own source hashes separately.
There are 14 measured rounds per arm and workload. CPU affinity was not pinned;
the ranges expose scheduling and warmup variation. Candidate diagnostics held
120 healthy samples and 119 gap-workload samples at the final read; the age
bound can remove an old sample between the last sample and that read.

| Workload | Base median µs/tick (range) | Candidate median µs/tick (range) | Observed median difference |
| --- | --- | --- | --- |
| Healthy | 0.114 (0.105–0.176) | 0.141 (0.108–0.197) | +0.027 µs |
| Synthetic gaps | 0.169 (0.129–0.246) | 0.197 (0.146–0.362) | +0.028 µs |

[Raw rounds and source hashes](../../evidence/viewer-memory-telemetry/tick-cost.json)
retain the inputs, command, process order and samples. These are observed
synthetic costs; cache mutation cost and whole-process CPU are outside the
timed region.

### Needle mutation cost after the review fix

Run `bun scripts/measure-loop-monitor.ts --needle-mutations` unchanged in
isolated pre-fix (`8f1376ad3673548ad1732c2dc7f51080a969557e`) and fixed exports.
Under one gate admission, fresh processes ran in base/fixed/fixed/base order.
Each process seeded 0, 64 and 1,024 previous checkpoints, then scanned 32
new eight-byte files per round with a 1,024-byte allowance per file. One
warmup preceded seven recorded rounds, giving 14 rounds per arm and size.
The timed region includes file stat/read, boundary hashing and both cache
writes. Setup and diagnostic reads are outside it. Descriptor-counting Proxy
traps identify visits to the seeded files and add overhead to these timings.
CPU affinity and unrelated machine load were uncontrolled; raw load averages
and cgroup limits accompany the rounds. These measurements establish the
accounting work bound and describe this instrumented fixture's cost.

| Seeded files | Pre-fix descriptors/update | Fixed descriptors/update | Pre-fix median ms/32 updates | Fixed median ms/32 updates |
| --- | --- | --- | --- | --- |
| 0 | 0 | 0 | 11.526 | 1.241 |
| 64 | 1,024 | 0 | 19.319 | 0.747 |
| 1,024 | 16,384 | 0 | 206.113 | 1.100 |

[Mutation rounds, source hashes and verification](../../evidence/viewer-memory-telemetry/needle-mutation-cost.json)
record the final fix's inputs and all 11 explicitly selected test files:
138 passing cases, zero failures, plus a passing full typecheck and changed-file
ESLint. The new enumeration regression fails on the pre-fix source. Additional
checks compare scalar sums with full payload estimates after append, reset,
read refusal, entry replacement, delete and clear, and confirm that an
unreadable estimate preserves scanning.

The initial telemetry implementation's isolated selection completed all 43
explicit test files: 1,113 passed
test cases and 14 adjacent failures. All touched test files passed.
Full-file base/candidate repeats matched eight files-route failures, one
relay parser failure and four voice-read failures. The remaining role-memory
case failed on the base and initial candidate, then passed on the candidate
repeat. No ordering cause is inferred. The final resource-collector fixture
run, full typecheck and privacy check passed. The
[verification record](../../evidence/viewer-memory-telemetry/verification.json)
lists every selected file and comparison, including the nonzero baseline
exits; those existing failures are not claimed green.
