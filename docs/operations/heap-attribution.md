# Viewer heap attribution

The operator-only `GET /api/operator/heap` diagnoses the serving Viewer's own
process. The existing operator authentication and same-origin checks apply to
stats, full collection, snapshots and history. Agent capabilities and Viewer
service identities cannot read any mode. Responses use `Cache-Control: no-store`.

Use these paths with an already authenticated operator client:

| Path | Result |
| --- | --- |
| `/api/operator/heap?mode=stats` | Census, memory counters and current attribution; no requested collection. Census cached for 30 seconds; attribution read fresh. |
| `/api/operator/heap?mode=stats&gc=full` | `Bun.gc(true)`, then a fresh census and attribution. `gc.durationMs` and `blockedMs` report collection and census separately. Each explicit call collects. |
| `/api/operator/heap?mode=series` | Persisted ten-minute samples, oldest first, with recorder health and retention bounds. Reading creates no sample. |

The existing explicit snapshot mode and its confirmation header keep their
existing size, disk, memory and rate guards. Attribution needs no snapshot.
A full collection blocks the main loop. Its cost depends on the serving heap;
use the duration in that response when judging the pause. A cached census
retains its `gc` provenance and census timestamp. A later uncollected census
reports `gc.mode: "none"`.

## Reading the holders

`attribution.processes.groups` groups weakly reachable launch results by `api`
and `site`. `running` and `exited` distinguish process state from wrapper-object
lifetime. `oldestExitedAgeMs` measures time since the exit notification. Rising
exited survivors at the same site across full collections identify a creation
path to investigate. A native runtime can also retain a subprocess; the site
names where it was created. Determining its retaining reference chain still
requires inspecting that code. Weak references disappear when the runtime
collects their targets; finalizer scheduling does not determine the counts.

`processes.oldest` gives up to 32 oldest tracked results with command basename,
pid, start time, exit time, exit code and signal. A synchronous Bun launch
produces a result object, represented separately as `Bun.spawnSync`. `exec`
records a shell label or the underlying shell executable. `fork` records the
interpreter. Arguments, shell source, environment values and file contents
never enter the registry. No full stack is retained. Sites keep the first
repository frame as a relative file, line and column. A deployment lacking
source mappings can show a `.next/server` chunk location; unresolved sites
are `unknown`. Third-party frames under `node_modules` are skipped.

The startup hook installs wrappers before loading the Viewer's runtime graph.
The Node `ChildProcess.prototype.spawn` fallback covers native lexical calls,
Bun's previously captured named imports, and custom promisify implementations.
It deduplicates targets already seen through another entry point. `coverage`
lists the installed hooks and counts observation errors. The registry describes
launches after installation in this process. Other processes and workers have
independent heaps. Native launches that bypass both patched surfaces remain
outside this coverage.

`attribution.pending` reports operation counts by name, their oldest age and
the 32 oldest operations currently held by the loop monitor. Its existing
128-operation admission bound remains. `dropped` counts lifetime admission
losses, so an overfull monitor is visible. Awaited work can remain pending while
it waits for external I/O.

`attribution.hosts.byEngine` totals reachable hosts, retained event-array
lengths, event subscribers, state subscribers and subscriber queue lengths.
`hosts.largest` gives the largest 256 hosts, with process-local numeric IDs.
Compare those IDs across reads from the same process to find a growing host.
`attribution.delivery` reports the current controller's held hosts,
registrations, attached state/event subscription pairs and pending publish
chains. The counters read the existing arrays and sets and work with the event
window and subscriber changes in #3946. They never read or change an event.
Subscriber queues can share references with the host array: counts describe
holders and cannot be summed into a byte estimate.

`attribution.caches` adds the existing cache telemetry: code owner, entry count,
charged bytes, measurement basis and unmeasured entries. This introduces no
additional cache mutation accounting. Timer, watcher and SQLite constructors
are outside the new hooks.

## Bounds and history

The launch registry admits 16,384 objects and interns 256 sites. Further sites
share `other-sites`. The host registry admits 2,048 hosts. Registry overflow,
site overflow and omitted detail counts are explicit. An overflowing registry
reports a partial census. Metadata contains weak references and scalars;
exit observers retain scalar metadata alone. A registry can sweep dead weak
references before finalizers run.

Only the active Viewer records history, starting ten minutes after activation.
The timer is unreferenced and retries at the next interval after an error.
`recorder.started`, `failures` and `lastSuccessAt` explain missing samples.
The `heap_series` collection in `state.sqlite` keeps at most 1,008 rows and
seven days, pruning on append and filtering expired rows on read. A sample
is refused above 64 KiB. Samples survive Viewer restarts; pid, uptime and
census timestamp distinguish process generations and cached census age.
A stopped installation creates a gap in the series.

Each row contains heap size, extra memory, RSS, selected object-type counts,
census duration, GC provenance and attribution summaries. Automatic samples
request no collection. They can reuse a census requested within the previous
30 seconds, including its explicit collection provenance. Per-process details
and per-host details stay out of history. History keeps the largest 64 process
site groups, the first 64 cache counters, all bounded pending-operation counts,
and engine/controller totals; omitted counts remain visible. At the row-size
limit, retained JSON payload is bounded by 63 MiB, plus SQLite overhead and its
existing bounded change-log retention. The response reads at most 1,008 rows.

## Cost

Measurements below used pinned Bun 1.4.0 on a shared Linux machine. They are
synthetic unit costs, with no claim about collection time on a multi-gigabyte
production heap. The launch measurement substitutes a native-shaped object
and already resolved exit promise, retaining 10,000 targets so GC cannot erase
them during the measurement. It measures instrumentation separately from OS
process creation. No production state was used.

| Part | Measured cost per call | Ongoing work |
| --- | --- | --- |
| Launch wrapper | About 8.2 microseconds over a 0.04-microsecond fake launch | One bounded stack, relative-site interning, weak registration, scalar metadata and exit observer per new result; nested Node entry points deduplicate. |
| Attribution read, 10,000 launch results | About 7.4 ms with oldest-result details; 1.4 ms for series | Linear weak-reference scan, site aggregation; details keep only the oldest 32 results. At capacity an admission can also sweep at most 16,384 weak references. |
| Host registration | About 0.8 microseconds for weak registration and scalar metadata | Once per constructed host; reads of 150 launch results and 50 synthetic hosts cost about 119 microseconds with details or 21 microseconds for series. |
| Cache-counter read | About 0.5 microseconds with an empty registry | Copies at most 256 existing scalar rows. |
| Pending-operation read | About 0.4 microseconds empty; 7.5 microseconds for 128 operations | Bounded sort and scalar aggregation; existing operation instrumentation supplies the data. |
| Census | About 46 ms for 1.63 million objects, about 28 ns/object | One heap walk per uncached request or ten-minute sample. |
| Full GC | About 18 ms on that synthetic heap | Only an explicit `gc=full` request; measured separately on every request. |
| SQLite append | About 49–59 ms with up to 154 small history rows | One append and retention pruning every ten minutes; includes synchronous filesystem/SQLite work on this machine. Larger rows/history can cost more. |

Host event production and subscriber handling gain no per-event work. Each host
registers once; reads inspect array lengths and subscriber queue lengths.
Cache reads copy existing scalar counters. No timer or file-watcher wrapping
runs on their higher-frequency paths. The production census reports actual
GC and census pause costs so they can be compared with heap growth.
