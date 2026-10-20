# Bounded Viewer work

Measured on 2026-10-20 against `0e2cfa00`, before changing the serving slices.
The final repeated comparison is [the raw record](../../evidence/perf/viewer-loop-slices.json),
completed at 06:03:18Z. Source and compiled-bundle digests identify both arms.
Earlier profiling and the existing registry keyed-write work showed that a
small requested result can still materialize retained history before selecting it.
This change selects sooner and yields between bounded batches.

The first results table records the original comparison. Independent review
then identified additional warm-registry, seat-projection, merge-sweep and cold
session costs; the follow-up below records those fixes and supersedes the first
table's cold-session conclusion.

## Reproduction and conditions

`scripts/benchmark-viewer-loop-pair.py` compiles the same
`scripts/benchmark-viewer-loop.ts` into each scratch export with `bun build
--target=bun`. Each resulting Bun HTTP server calls the production memory,
seat, registry and auto-merge functions; the session case calls the real Next
GET handler and requires HTTP 200. This is a compiled production-module
reproduction. The separately built Next server also loaded all 32 compiled
server runtimes and served GET `/` with HTTP 200. The synthetic benchmark does
not reproduce the production journal window or its browser traffic.

Export the base and head under the stage-provided `$TMPDIR` with
`scripts/review-export.ts`. It shares dependencies only when their manifests,
lock and patch inputs match. Pass its returned checkout directories to the
paired driver through the prescribed gate wrapper:

```sh
before_json=$(TMPDIR="$TMPDIR" bun scripts/review-export.ts "$BASE_REF")
after_json=$(TMPDIR="$TMPDIR" bun scripts/review-export.ts "$HEAD_REF")
before_export=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["directory"])' <<<"$before_json")
after_export=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["directory"])' <<<"$after_json")
rtk proxy bash "$GATE_SLOT" python3 scripts/benchmark-viewer-loop-pair.py \
  "$before_export" "$after_export" "$TMPDIR/paired.json"
```

The script refuses checkouts with `.git`, gives both servers private HOME,
config, provider, temp and state directories, closes Viewer control access,
records owned PIDs and stops only those children. Setup and corpus generation
precede the timers. Both arms use Bun 1.4.0, the same package/lock digests,
three alternating repeats, and one request at a time. No live agent runs:
six synthetic lanes mutate at the *tail* of 804 lanes containing 84,649,031
JSON bytes. There are 1,200 tasks, 3,500 memory entries in 1,699,912 bytes,
and 53,299 registry rows containing 217,949,183 JSON bytes. The registry
corpus hash is checked equal before measurement; no production state is used.
The tightest CPU quota is 3 CPUs, memory 8 GiB; observed host load average
is 8.69–9.07. Both arms share those limits and alternate on the same machine.

Memory changes one source revision per repeat. Seat inputs remain fixed so
the first pass hashes rows and later passes exercise immutable-row reuse.
Each merge case makes six persisted mutations then runs both sweeps, with
network calls refused. Each registry case opens a new read connection and
prepares a view. Each session case creates a cold facade before resolving one
conversation: its constructor cost is included on both sides.

## Results

`Sampled s` sums nonempty JSC self-stack samples at 1 ms over the three
requests for a cause. Samples are counted once, so nested operations do not
double count this estimate. It estimates occupied main-thread time, with
sampling error; it is separate from wall time spent awaiting the helper or
cooperative yields. The record also retains exclusive synchronous span times
(parent duration minus direct synchronous children), CPU usage, unresolved
samples, longest slices and raw per-run gap percentiles. No span records were
dropped. `p95/max` below means median of the three per-run timer-gap p95s /
largest per-run gap, in milliseconds; it is not a pooled production p95.

| Cause and final slice | Before: sampled s; gap p95/max ms | After: sampled s; gap p95/max ms | Scaling and conditions |
| --- | --- | --- | --- |
| Memory parsing, redaction and FTS replacement: `src/lib/memory/index.ts:234`; dispatch `src/lib/memory/service.ts:39` | 0.809; 290.70 / 293.08 | 0.014; 0.07 / 4.35 | Whole changed source costs O(entries + text bytes). The existing leased helper now owns discovery and indexing; the Viewer sends one bounded request and receives four counts. Unchanged source identities persist across helper restarts. |
| Seat lane hashing: `src/lib/monitor/seatTickSources.ts:2480`; task join `src/lib/pipelines/taskBinding.ts:37` | 0.354; 73.21 / 78.50 | 0.245; 7.47 / 10.53 | Hash at most four rows / 8 ms before yielding; frozen rows reuse their existing weak cache. Replace the O(tasks × lanes) join with one membership pass plus requested tasks. A changed source/seat/alias/settings gate cancels evidence after a yield. |
| Auto-merge mutations and sweeps: `src/lib/forge/autoMerge.ts:1072`, `src/lib/forge/autoMerge.ts:729` | 2.124; 768.54 / 769.69 | 0.144; 10.09 / 10.44 | Select the lane before the existing mutation snapshot copies it, then release its lease before yielding. Sweeps yield after eight rows / 8 ms. Tail position previously cloned preceding lanes. Six mutations, same data on both sides. |
| Cooperative registry preparation: `src/lib/agent/sqliteRegistryStore.ts:1732`, `src/lib/agent/sqliteRegistryStore.ts:2391`, `src/lib/agent/sqliteRegistryStore.ts:212` | 1.722; 50.98 / 78.47 | 2.055; 9.29 / 52.87 | Iterate cold keys and headers, avoid SQLite whole-result sort/materialization and aggregate scan; sort at most 128 headers natively then merge in yielded chunks. Preparation has an 8 ms slice target. Full preparation still costs O(rows + headers log headers); one indivisible hot-row batch or runtime scheduling can exceed the target. |
| Session registry read: `src/lib/agent/registry.ts:8959`, `src/app/api/session/route.ts:20` | 1.722; 631.52 / 654.07 | 0.175; 66.36 / 71.15 | Resolve aliases, conversation and staged-path receipts inside one keyed transaction before decoding unrelated rows. The new keyed span maxima were 1.33 / 0.84 / 1.95 ms. The cold facade constructor is included and remains synchronous; no constructor latency gain is claimed. |

Viewer CPU totals across three requests, in the same order: memory
1,033.0 → 74.0 ms; seat 483.8 → 361.8 ms; merge 2,676.7 → 200.9 ms;
registry preparation 2,420.7 → 2,928.0 ms; session 2,361.5 → 290.6 ms.
The helper moves memory CPU to a separate process. Cooperative registry
preparation spends more CPU on iteration and monitoring to reduce loop gaps.
These results support latency improvements for the measured slices only. The
measured registry backend is authoritative SQLite. The compatibility JSON
backend retains its existing whole-file materialization; its session privacy
behavior is covered by the existing API tests, with no speed claim here.

## Independent review follow-up

The regenerated comparison is [the raw review record](../../evidence/perf/viewer-loop-slices-review.json),
completed at 11:35:11Z on Bun 1.4.0, with three alternating repeats and one
request at a time. Its `before` arm is the base export; `after` is the committed
fix source, identified by its digest in the record. Both arms used the same
804 pipelines / 89,848,013 bytes, 603 open lanes, 201 own settled lanes, active
seat, 1,200 tasks, 3,500 memory entries / 1,699,912 bytes, and 53,299 registry
rows / 218,547,668 bytes. The registry corpus digest matches. There were no
synthetic agents. The tightest cgroup limit was 3 CPUs and 8 GiB; observed host
load averages ranged from 18.13 to 28.01. Wall timings include scheduling
delay, and each request records its load.

| Cause and final slice | Before: sampled / exclusive s; gap p95/max ms | After: sampled / exclusive s; gap p95/max ms | Loop work and scale |
| --- | --- | --- | --- |
| Memory refresh: `src/lib/memory/service.ts:39` | 1.642 / 2.350; 825.63 / 826.54 | 0.024 / n/a; 1.13 / 20.94 | The Viewer dispatches refresh to its helper. The request has no exclusive synchronous span; helper work still scales with changed source bytes and entries. |
| Seat projection and hashing: `src/lib/monitor/seatTickSources.ts:2457`, `:2472-2483`, `:2606`; own lanes `:1000` | 1.387 / n/a; 310.99 / 351.98 | 0.539 / 0.475; 28.51 / 48.29 | The corpus has 603 open lanes, 201 own settled lanes and 6,000 attempts on one selected lane. First request replaces the frozen source during preparation and verifies populated spec output; two stable repeats exercise the warm projection. Candidate samples 0.463 s in named projection and 0.012 s hashing across three runs; 1,270 detailed spans (79.48 ms) overflowed the bounded 1,024-record recorder and are explicitly counted in the raw record. |
| Auto-merge sweep: `src/lib/forge/autoMerge.ts:745` | 7.835 / 5.042; 3,561.42 / 3,862.29 | 0.548 / 0.367; 45.88 / 139.73 | The old prefix filter/map and admission scan ran before the first yield; repository queues were sorted before selecting a head. Current prune, admission and queue passes yield during traversal. Six tail mutations per request. |
| Registry cold preparation: `src/lib/agent/sqliteRegistryStore.ts:1572`, `:1576` | 4.047 / 4.935; 35.46 / 192.11 | 5.812 / 7.472; 11.95 / 153.51 | Preparation iterates and yields through `registry.prepare.slice` and `registry.headers`; the batch cap is 16. CPU rises as cooperative iteration and instrumentation replace whole-result drains. |
| Registry warm refresh: `src/lib/agent/sqliteRegistryStore.ts:1572`, `:1576` | 1.506 / 1.023; 627.08 / 744.08 | 6.343 / 7.277; 16.31 / 341.61 | Three peer archives invalidate the prepared view. Current preparation keeps loop gaps lower while doing more CPU work and retaining the old view's lazy reader until its last user releases it. |
| Cold session target: `src/lib/agent/registry.ts`, `src/app/api/session/route.ts:19` | 3.793 / 4.496; 1,521.80 / 1,932.61 | 0.080 / 0.051; 12.87 / 85.91 | The old facade constructor drained cold keys synchronously. Current reads use async admission and keyed rows without a full cold-key scan. |

This follow-up measures the seat evidence projection and attempt history, three
warm archive invalidations, the auto-merge queue and cold session facade. All
36 requests had zero unresolved profiler samples. The seat projection generated
more than the recorder's bounded 1,024-span ring; dropped span count and summed
duration are preserved in the raw record, and the longest named spans remain
available. The record also keeps per-request load, source and bundle digests,
CPU, exclusive spans, timer gaps and longest slices. The earlier comparison
above remains the original record; this table replaces its former follow-up.

The paired `before` source identifies the handed synchronous slices: the warm
registry called `preparedReader.readOnlySnapshot()` at
`src/lib/agent/sqliteRegistryStore.ts:1575`, which drained journal, header and
projection generators through `finishSteps`; cold session construction at
`src/lib/agent/registry.ts:11477-11478` synchronously filled every cold key and
kept SQLite's 5 s busy timeout; seat evidence scanned full pipeline specs and
attempt histories at `src/lib/monitor/seatTickSources.ts:2415-2430` and
`:2561-2584`, then materialized and sorted own-lane results before the limit at
`:1007-1008`; and auto-merge filtered/mapped its full prefix at
`src/lib/forge/autoMerge.ts:750` before admission, then sorted each eligible
repository queue at `:871-872`. The record's source and bundle digests bind
those reproductions to the reviewed `before` and `after` builds.

The baseline profile names memory SQLite `run`, filesystem discovery,
seat `update` / `stringify`, merge `structuredClone` / `stringify`, and registry
`all` / snapshot projection. Representative exclusive baseline spans total
0.877 s for memory refresh, 0.832 s for pipeline copies, 0.181 s for registry
headers during preparation, and 1.577 s for session snapshot work excluding
its nested headers. New header iteration is individually recorded inside
`registry.prepare.slice`; its aggregate time includes per-row instrumentation.

## Attribution, ownership and failure behavior

`registry.read` labels synchronous snapshot/keyed reads; `registry.prepare`
labels cold construction and resumed preparation. Both public seat gather
and the separately called evidence hash carry `seat-tick.check`; the phases
are `seat-tick.project` and `seat-tick.hash`. Merge reads and mutation callbacks
carry `forge.auto-merge.read` / `forge.auto-merge.step` inside the existing
operation. The helper dispatch retains `memory.refresh`; the child labels
discovery and refresh too. Native decode/SQLite frames therefore retain the
first-party caller label. Tests cover operation context on success, refusal,
resumption and retry. Loop-gap and performance-summary emitters are unchanged.

Refresh writes and read-connection admission use `waitForStateLock` around
zero-timeout attempts. No synchronous waiting site is added. Memory replacement
remains atomic per source; a single in-flight request is shared only for the
same state root and serialized roots, and evicted on success or failure.
Requests/replies are limited to 64 KiB / 1 KiB, with a five-minute helper
lifetime. Existing helper leases own process cleanup. Source discovery remains
complete before pruning. Existing immutable snapshot/cache owners and bounds
are retained; no long-lived registry cache is added.

Contract edges checked before changing shared paths:

- Memory: `search/transcriptFeed.ts` is the production refresh caller; the
  memory service dispatches to the existing memory import launcher/lease and
  worker. The new private request kind returns counts only; the existing import
  request/reply and durable schemas remain unchanged. Tests and builds retain
  their guarded local path with explicit roots.
- Merge: production controller construction passes `loadPipelinesForList`;
  this selects async preparation by default. Injected test ports may omit the
  optional preparation hook. The existing controller scope, mutation lease,
  persistence callback and rollback continue to own writes. A thrown callback
  rolls back; a subsequent mutation succeeds.
- Task projection: the tasks API, orchestrator board report and both seat
  paths share the same join. Task order, duplicate membership suppression and
  independent result arrays are preserved.
- Session: GET consumes one scalar target from `AgentRegistry`; the same
  materialization fence, allowed-root check and engine check still protect it.
  ID, alias and raw staged paths are refused before materialization and become
  readable after peer finalization. Team audit subjects use existing keyed
  lookups; no full snapshot is needed for one conversation.
- Snapshot preparation: synchronous readers still drain the shared generator;
  async readers publish only a complete validated view. Cancellation/owner
  close ends the yielded statement before rollback; a retry/reopen remains
  usable. Existing peer-journal and archive identity tests cover invalidation.

## Scope and verification

`controller.pipelines` startup/reconciliation is a distinct slice through
`src/lib/pipelines/store.ts:1789` (`withPipelineStartupAdmission`). Its state
lease belongs to the fenced reconciliation lane and is unchanged here. The
scoped auto-merge caller uses the existing selection API without changing that
lease. Structured spawn, send settlement, the delivery integration suite and
local/pre-push gate implementation are untouched. A post-deploy production
journal audit remains the seat’s follow-up.

Checks use scratch exports, private HOME/config/TMPDIR/state/provider roots,
a closed `LLV_VIEWER_CONTROL_URL`, and explicit test paths through the gate
wrapper. The final build passes, TypeScript passes, and the built Viewer smoke
loads 32/32 modules and serves HTTP 200. Regression coverage includes real
leased helper restarts/refusal/retry, selected mutation rollback and fairness,
keyed session privacy/peer finalization, cold archive ordering across reopen,
and cancellation during asynchronous preparation. A direct invocation of the
compiled memory import worker accepts the new refresh request and returns
validated counts. The three new regressions
for tail selection, membership visit counts and header iteration fail on the
original base and pass with the change.

The existing instrumentation extraction test has four unrelated retention
harness failures on both base and head; its two merge cases now pass. A combined
run with the journal suites adds three shared-fixture failures on both sides
(39 pass / 8 fail on base, 40 pass / 7 fail on head). Separate fresh-process
performance-span and loop-monitor runs pass 10 tests each, including preserved
quiet-mode gap/summary output and journal backpressure. The existing paged
child-discovery test exceeded its default five-second budget on both base and
head; the final explicit file run with `--timeout 30000` passes all assertions.
No retention or gate implementation was changed to address those baseline
conditions.
