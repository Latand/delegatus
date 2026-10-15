# Viewer heap and GC fixes

These changes address the pipeline cache and list allocations measured in [the
heap audit](viewer-heap-gc.md).

Within each JavaScript VM, pipeline and task collections share decoded read data
across compiled module copies. Cache keys include the database path and inode,
collection, schema, decoder version and external decode authority. Pipeline keys
also include the supported role vocabulary. SQLite connections, validation
functions, leases and mutable controller sessions stay local to their owning
module.

Each VM keeps at most eight shared cache slots with a combined 256 MiB budget
measured as UTF-16 source JSON bytes. Expanded object graphs can use more heap.
Worker VMs maintain separate budgets. The frozen active, archive and task rows
occupy 59.274, 147.522 and 14.966 MiB in these units, so the budget admits that
working set together. Eviction clears the slot held by every reader. An oversized
collection still answers its caller and is decoded again on its next read. The
cache keeps row revisions and decoded values; source JSON strings live only during
the read. Cold full loads iterate SQLite rows instead of first collecting all JSON
rows.

Closed-inclusive lists select active rows first and read archive pages only when
the requested page has room. Archive reads pin one SQLite snapshot, decode at most
sixteen rows per page and yield between pages. Selection stops once the page
fills. A selective miss can still scan the archive in these bounded pages. Full-
history consumers reuse the shared revision cache. This avoids repeating a
synchronous scan for periodic full-history readers. Health and startup evidence
retain their independent rejected-record checks.

The pipeline HTTP response serializes and encodes a row when its reader asks for
it. It yields after four milliseconds of serialization work, clears its record
references on completion or cancellation, and preserves the full JSON model.
Individual records still determine the largest serialization step.

## Measurement method

The baseline is the branch after merging `origin/main` (`f1083f301`). Both
baseline and candidate use separate production builds, the same Bun 1.4.0
interpreter and the frozen inputs from audit E3. Each run starts from a fresh
writable clone. The pristine databases remain read-only.

The contained child has private PID and network namespaces, read-only host and
source mounts, isolated HOME/config/temp/state directories, an empty executable
search directory and a port-0 HTTP listener. Runtime events, structured hosts,
account control and telemetry are disabled. Viewer control points at closed
loopback port 1. Cleanup addresses only recorded owned child PIDs.

Each run warms active pipelines, closed-inclusive pipelines, tasks and files
summary, then waits fifteen seconds. The timed interval performs 180 iterations:
concurrent files-summary and task requests each second, plus a closed-inclusive
pipeline request every tenth iteration. Every response is fully drained. Three
pairs alternate baseline/candidate order. Each run therefore has 378 timed HTTP
responses with the same request mix.

A 100 ms timer records RSS, heap counters and loop delay. JSC logging supplies
main-VM pause fragments, excluding other VMs and explicit pre/post collections.
Nested GC log records are reassembled across interleaved VM output. Every `p=`
fragment is accounted for; `cycle` time includes concurrent GC work. Two explicit
collections, separated by an event-loop turn, measure retained heap outside the
timed interval in the main VM. RSS covers the whole process; peaks between samples
can be missed.

The initial 64 MiB policy could not hold the active/task working set. A 96 MiB
experiment reduced RSS and heap but increased collection frequency, and uncached
full archive reads caused periodic main-thread input of about 178 MB and loop gaps
near one second. The final policy keeps full-history reads cached by revision
within 256 MiB. Earlier completed and interrupted experiments remain private and
contribute no final comparison rows. A later baseline attempt exceeded its
30-second cold files warmup deadline before timing began. Warmup requests in the
final replay use a 120-second deadline; timed requests retain their 30-second
deadline.

## Results

The table combines three matched runs per build. RSS and collected heap use the
median of run medians or post-window collections. Counts and pause totals sum all
three runs; maxima span all three runs. Each side completed 1,134 timed responses.
[Per-run measurements](../../evidence/viewer-heap-gc/comparison.json) retain the
individual results, response counts and cgroup counters.

| Metric | Before | After |
| --- | ---: | ---: |
| Median RSS, MiB | 2,264.3 | 1,231.6 |
| Peak sampled RSS, MiB | 3,089.0 | 1,704.2 |
| Collected heap, MiB | 1,177.2 | 510.5 |
| GC pause fragments | 1163 | 1254 |
| Mean GC pause fragment, ms | 4.7 | 4.4 |
| Total GC pause, ms | 5,469.9 | 5,510.2 |
| Longest GC pause, ms | 37.9 | 20.4 |
| Viewer loop gaps >=1 s (10 ms timer) | 0 | 0 |
| Sampled loop gaps >=1 s (100 ms timer) | 0 | 0 |
| Longest sampled loop gap, ms | 537.8 | 327.1 |

Median RSS fell 45.6%, collected heap 56.6% and the longest GC pause 46.2%. Pause
fragments increased 7.8%; aggregate pause time stayed effectively flat (+0.7%).
The per-run GC results vary, while the memory reduction holds across all three
pairs.

## Verification

Ten explicit test files cover collection sharing, mutable snapshots, peer
updates/deletes, database replacement at the same revision, decoder authority and
vocabulary isolation, cache eviction, oversized collections, the full working-set
budget, bounded archive selection, cancellation, JSON output, cross-release
validation, rollback and concurrent writers. They run under isolated state through
the installed gate. The new shared-reader regression fails on the merged baseline:
two readers decode four rows. The candidate decodes two. Repository type checking,
changed-file lint and both production builds pass. The local privacy gate passes
with the committed fingerprints and required known-value checks.

## Parallel work and limits

The read-cache and cold-read hunks in `src/lib/state/sqliteStateStore.ts` are
separate from the lock lane's connection, lease and transaction retry changes.
`src/lib/pipelines/store.ts` and `src/lib/tasks/store.ts` opt into shared caches;
the lock lane owns their mutation/commit interface changes. The compact evidence
and controller behavior from #2905 remains intact.

Runtime snapshot transport, board poll projections/deltas/history and MCP writer
lifetimes remain with their owning lanes. This change leaves their files alone.
The Bun pin and runtime-host source stay unchanged.

These bounded copied-data runs exercise the compiled Viewer. They omit live
transcripts, external runtime traffic, concurrent external writers, browser
rendering and the release's separate thirty-minute production acceptance window.
They establish the effect of these cache/list changes under the stated load.
