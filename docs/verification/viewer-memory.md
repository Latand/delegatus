# Viewer memory and SQLite descriptors

Investigation and fix for #2512. All measurements below were repeated on
2026-10-13. The interrupted lane's draft was reviewed; its measurements were
not reused. The earlier [investigation](../research/viewer-memory-growth-2026-10.md)
remains historical context.

## Current production observation

`deployment_status` identified `ba6ae835ced5fcd2ffae8b220f51618c3ad50dd4`,
deployed at 02:08:48 UTC. The running command named that release and
`next start`; its executable reported Bun 1.4.0. Deployment status was checked
again after sampling. The registry and state-store source files at that release
are identical to the baseline `8f103d02ec68ecae135c5a60d8bb14430ca207b7`.

From **04:12:56.647 through 04:22:56.649 UTC**, 601 samples read the Viewer's
`/proc/$VIEWER_PID/status` and descriptor symlinks at one-second intervals.
Each sample checked the process's kernel start identity. A `smaps_rollup` read
also confirmed anonymous memory. This observes the web process alone; the
runtime host, agents and workers have separate address spaces. There was no
debugger attachment, signal, forced collection, database query or restart of
the live service. An isolated build and the start of the baseline profile
overlapped this window; production traffic and other lanes were uncontrolled.

| Metric, MiB | Floor | Peak | First | Last |
| --- | ---: | ---: | ---: | ---: |
| RSS | 4,614.969 | 6,999.887 | 5,521.797 | 5,660.398 |
| Anonymous RSS | 4,534.012 | 6,918.930 | 5,440.840 | 5,579.441 |
| Swap | 0 | 0 | 0 | 0 |

Minute RSS floors were 4,615, 4,766, 5,418, 5,481, 5,476, 4,718, 5,526,
5,166, 5,514 and 5,483 MiB. They fluctuate, with a higher final-minute floor;
this window cannot establish a long-term trend. Twenty-second-lag correlation
was 0.0200 after linear detrending and -0.0124 for consecutive RSS differences.
The trace does not establish a regular twenty-second oscillator.

| Database | DB descriptors | WAL descriptors | SHM descriptors |
| --- | ---: | ---: | ---: |
| `state.sqlite` | 52 throughout | 47–50; first/last 47 | 1 |
| `agent-registry.sqlite` | 2 | 1 | 1 |
| `admission.sqlite`, `bot.sqlite`, `delivery-progress.sqlite`, `handoff-queue.sqlite`, `mcp-receipts.sqlite`, `memory-index.sqlite`, `team.sqlite` | 1 each | 1 each | 1 each |
| `records.sqlite`, `transcript-search.sqlite` | 0–1 each | 0–1 each | 0–1 each |

The separate inode check found all 52 state database descriptors on one file.
The record, including per-minute bounds and each database's counts, is
[`live.json`](../../evidence/viewer-memory/live.json).

**Reproduction verdict:** the large anonymous footprint and dozens of state
connections remain present. The exact 12 GB magnitude, swap and regular
twenty-second cycle did not reproduce. The investigation continued because the
current code still contains an unbounded retention path, reproduced below;
there is no proof that the historical incident's source was already removed.

## Retained registry views

`rememberReadOnly` reuses archive accessors across snapshots. The old accessors
capture its activation, including `file` and `snapshot`. Alternating writes to
entries/receipts, conversations and deliveries rebuilds different collections,
so a new view can hold earlier views through the reused accessors. The existing
deleted-row cache pruning does not break this separate chain.

The fix constructs archive-row, merged-collection and constant readers in class
methods outside that activation. Each retains its own immutable archive version,
grant lists and collection inputs. Operation owners additionally retain a reader
for their own delivery collection. The production minifier inlined module-level
factory functions back into `rememberReadOnly`, recreating the captured scope
even while source tests passed; method calls preserve the boundary in the
compiled build. The grant refresh algorithm, indexed lookups,
projection caches and lazy archive construction remain in use.

The failing-first regression runs two real SQLite stores against a small synthetic
history and alternates 36 foreign writes. It enumerates each resulting reader view,
holds only weak references to superseded roots, then collects in later jobs.
The original implementation retained 36 of the 37 distinct views; the fixed implementation
passes the bound of at most two. The full history file passes all 11 tests,
including payload-read bounds, grant decisions, held-view ownership, incremental
archive refresh and once-per-version projections.

The final compiled baseline heap has 465 objects with registry envelope fields.
Strong edges lead from `readOnlyCache.file` through collection getters
(`memberships`, `receipts`, `entries`), functions and their lexical environments
to earlier registry envelopes. The fixed snapshot has four registry-shaped
objects; its only reported path to another envelope goes through the global
object. These counts include hot and normalized envelopes, so the separate
weak-reference count identifies the actual observed reader views. The extracted
graph record is [`heap.json`](../../evidence/viewer-memory/heap.json); raw heap
snapshots remain private because they can contain environment data.

## Rejected collection opens

`SqliteStateCollection` opened its persistent reader before checking collection
metadata. Missing collections and unsupported schemas threw without closing
the connection. The constructor now closes its reader on initialization failure.

An isolated probe alternated 100 missing/unsupported opens. Before the fix it
left 100 DB, 100 WAL and one SHM descriptor immediately, and 100/99/1 after two
collections. The regression failed on its first rejection with three descriptors
against an expected zero. With the fix, it passes all 48 assertions, checking
immediate release after each of twelve attempts for each error kind.
The before/after probe is recorded in
[`descriptors.json`](../../evidence/viewer-memory/descriptors.json).

This identifies a real failure-path leak. The live service's stable 52 readers
were not traced to constructor failures. Normal collections retain persistent
readers, including independent compiled module instances. A high stable count
alone does not establish a per-request leak; connection sharing is outside this
fix.

## Repeating the isolated Viewer workload

The existing `scripts/profileBrowser.ts` accepts `--server-memory --history`.
It seeds the candidate gate's large registry: 30,036 rows, 27,836 cold rows,
96,833,259 payload bytes, 320 invented transcripts and eight projects. A separate writer alternates
entry `updatedAt`, receipt `createdAt`, conversation `updatedAt` and delivery
`deliveredAt` updates. Each write is followed by
enumerating the compiled Viewer's own registry view and requesting its actual
board route, then a 250 ms pause. The diagnostic view action reaches the registry
already owned by the compiled Viewer; it does not import another reader instance.

The comparison uses Bun 1.4.0, Next 16.3.8, production builds, ten warm-up writes
and a 120-second workload window. The parent samples the Viewer child's RSS,
anonymous RSS and SQLite descriptors every 500 ms. It also records the time to
refresh and enumerate the registry inside the Viewer. GC is requested immediately
before the window and in two separate requests afterward; heap snapshots are
taken only afterward. Weak references count distinct compiled registry views,
and `--assert-bounded` refuses more than two remaining roots after collection.
There is no forced GC or snapshot generation inside the measured window. The writer's
memory is outside the measured Viewer process. Host load remains uncontrolled.

Every run uses a private HOME, TMPDIR, XDG roots and LLV_STATE_DIR, with
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`; the child binds loopback port zero.
The shared gate owns descendants, and the driver stops the Viewer before its
workers, then cleans up recorded PIDs after checking their start identities.
Stopping workers first allowed the running Viewer to replace them during cleanup.
After an isolated production build:

```sh
bash scripts/gate-slot.sh bun scripts/profileBrowser.ts \
  --server-memory --history --seconds 120 --snapshots --assert-bounded \
  --out aggregate.json
```

The unchanged implementation ran at 04:53:11.903–04:55:12.887 UTC; the fixed
implementation ran at 04:53:57.608–04:55:57.651 UTC. Both used the same driver
bytes and dependency lockfile. Their windows overlapped on the shared machine.
The final in-flight iteration can finish after the 120-second deadline: sampled
elapsed times were 120.738 and 120.002 seconds. The aggregate records the driver
and fixed source hashes in [`comparison.json`](../../evidence/viewer-memory/comparison.json).

| Measure | Before | After |
| --- | ---: | ---: |
| RSS floor / peak, MiB | 481.242 / 1,487.336 | 411.078 / 605.852 |
| Anonymous RSS floor / peak, MiB | 403.730 / 1,409.637 | 333.922 / 528.633 |
| Final 30-second RSS floor, MiB | 1,291.930 | 497.258 |
| Collected heap after window, MiB | 1,015.530 | 126.518 |
| Retained / observed distinct registry views | 231 / 231 | 1 / 331 |
| Completed writes during window | 221 | 321 |
| Registry refresh/enumeration p50 / p95, ms | 7.939 / 98.797 | 9.830 / 120.368 |
| `state.sqlite` DB / WAL / SHM descriptor ranges | 12–16 / 11–14 / 1 | 12–16 / 11–14 / 1 |
| Registry, admission and memory-index DB / WAL / SHM descriptors | 1 / 1 / 1 each | 1 / 1 / 1 each |
| Rejected-open probe: descriptors after 100 failures, DB / WAL / SHM | 100 / 100 / 1 | 0 / 0 / 0 |

Peak RSS fell 59.3%. The baseline's successive 30-second RSS floors were
481, 895, 1,128 and 1,292 MiB; the fixed floors were 411, 499, 502 and 497 MiB.
The bounded-root check exited 1 on the baseline and 0 on the fixed compiled
Viewer, with no surviving descendants reported by the owned runner. Normal
reader descriptor counts stayed the same; the separate rejection probe
demonstrates the failure-path repair.

The refresh/enumeration p95 increased in this shared-host sample, while total
completed writes increased. This is not a controlled latency benchmark.
Preservation of #2762's speed-ups is checked by the existing deterministic
payload-read, grant-decision, indexed-identity, collection-reuse and projection
assertions in the history, archive and read-only-view suites. No cache, index,
projection or lazy-reader optimization was disabled to obtain the memory result.

This workload isolates registry retention with a large synthetic history. It
does not recreate all live pipeline payloads, agent traffic or browser activity,
or attribute every byte of the historical 12 GB report. No deployment or
post-deployment memory claim is made.

## Verification

All test invocations named their files explicitly and ran through
`bash scripts/gate-slot.sh bun test <file>` with private HOME, XDG roots,
TMPDIR and LLV_STATE_DIR, and the closed control URL above.

| Check | Result |
| --- | --- |
| `src/lib/agent/sqliteRegistryStore.history.test.ts` | Baseline: new retention case fails with 36 held roots; fixed: 11 pass, 9,522 assertions |
| `src/lib/agent/sqliteRegistryStore.readOnlyView.test.ts` | 16 pass, 215 assertions |
| `src/lib/agent/registryArchive.test.ts` | 35 pass, 648 assertions |
| `src/lib/state/sqliteStateStore.lifecycle.test.ts` | Baseline: first rejected open leaks three descriptors; fixed: 1 pass, 48 assertions |
| `src/lib/state/sqliteStateStore.bounded.test.ts` | 3 pass, 14 assertions |
| `bun run build` | Production build, including bundled server and MCP, passes |
| `bunx tsc --noEmit` | Passes |
| Compiled history profile with `--assert-bounded` | Baseline fails; fixed passes |

## Scope boundaries

The current scanner includes #2805; its complete/incomplete generation and
snapshot-copy behavior was read and left unchanged. The parallel registry
refresh lane owns grant re-decision cost. This change touches only the archive
accessors' captures in that store and state-collection constructor cleanup.
The MCP imports/delegation (#1816), board rebuilding (#1838), account mutation
locks (#1935) and automatic updates (#2515) were left unchanged. The open worker
limit change adds separate registry lookup methods, outside these hunks.
