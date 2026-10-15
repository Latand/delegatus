# Bounded pipeline controller work

The controller selects at most four lanes per phase. Each lane reconciles a
durable window of sixteen historical attempts plus its current attempt, with
`setImmediate` yields between lanes and attempt batches. Git settlement and
publication continue under an owned job after the phase returns. The committing
cursor and publication reservation remain their durable restart intents.

This implements design items 3–6 from
[the controller audit](pipelines-controller-pass.md#fix-design-and-verification).
The operator authorized item 3 after the
[baseline scope probe](pipelines-controller-bounds.md) exceeded the fifteen-second
phase budget. Branch-authority projection and generation work (items 1–2) remain
outside this change.

## Scheduling and custody

`pipeline_tick_work` stores row keys, change generations, due times and attempt
cursors. SQLite triggers enqueue row changes atomically, including writes from
older peers and raw SQL. An acknowledgment clears only its observed generation;
a newer write stays dirty. Attempt cursors advance independently so a lane's
own checkpoint cannot keep it on the first history window. A persisted fair
cursor reserves capacity alongside dirty and due work. That walk also observes
host, flow, account and CPU changes that do not write a pipeline row.

Settled closed/completed rows leave the schedule. Publication, provenance,
activation, close, historical-host and cleanup obligations keep their rows
eligible. Retry deadlines refine the ordinary thirty-second fallback. Large
reaps retain per-attempt retry custody until their windows finish. Scoped CPU
reconciliation preserves another lane's ticket and its FIFO age.

One shared job owner permits four outstanding jobs and one per lane. It does
not grant write authority. The existing lane/flow/ownership checks, commit
receipts, index custody, publication reservations and kernel locks still decide
which result may be checkpointed. Git children keep their inherited descriptor
until close. A phase deadline leaves that custody intact. A successor observes
the durable intent and existing lock, then reconciles the original remote
outcome before another publication can be admitted.

The internal result contains changed, pending-job and ready-work evidence.
It omits the whole-hot return snapshot in both the ordinary and stale paths.
Full-result callers retain their existing result. Hosts selections and
reconciliation share immutable decoded rows by row revision, file identity and
decoder authority. Their shared LRU retains at most 64 rows and 16 MiB of
serialized UTF-16 source within the existing eight-slot/256 MiB cache owner.
Decoded graphs can occupy more heap than their serialized source.

Static labels cover ownership, copying, task-note preparation, lane
continuations and job/Git waits. Existing durable-lease observations run through
release. Monitor overflow remains explicit.

## Replay method and budgets

The reference files are unchanged E4/E5: 267 hot rows (36,917,194 UTF-8 bytes)
and 674 archived rows (88,008,813 bytes). Their checksums appear in the numeric
evidence. Each revision runs from a separate source export with identical
dependency inputs, Bun 1.4.0, fixed engine time, conservative external responses,
fresh writable database copies and isolated HOME/config/temp/state roots.
The control URL is a closed loopback port. The driver refuses network, process
actuation and filesystem writes outside its run directory.

`scripts/measure-pipeline-controller.ts` is copied identically into both source
exports. `AUDIT_MODE=legacy` calls the old engine through the real controller;
`AUDIT_MODE=candidate` calls the internal path. A logical sweep visits each
eligible lane once, across bounded candidate phases, and then awaits job
settlement outside phase completion. Deferred work settles before subsequent
sweeps. The first sweep includes cold work and one ten-second Git reply; the
next two sweeps are reported separately. Three alternating revision pairs use
the same sequence. All authoritative hot/archive payloads are compared after
each pair. Derived scheduling tables are excluded from that comparison.

Replay command, from each export after copying E4/E5 and the auxiliary alias/map
files into `$RUN/state`:

```sh
HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/config" TMPDIR="$RUN/tmp" \
LLV_STATE_DIR="$RUN/state" LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 \
AUDIT_RUN="$RUN" AUDIT_MODE="$MODE" AUDIT_GIT_DELAY_MS=10000 NODE_ENV=test \
bash "$SERVING_RELEASE/scripts/gate-slot.sh" "$BUN" \
  --cpu-prof --cpu-prof-dir="$RUN/profiles" scripts/measure-pipeline-controller.ts
```

Budgets for this fixture are fifteen seconds per phase, two seconds for its
cold phase, 250 ms per warm phase, 50 ms for a warm labelled synchronous slice
and 100 ms warm timer delay. Scheduling admits four lanes and sixteen history
attempts per lane, plus the current attempt. Cold registry and task-note work
are measured separately from warm slices. These fixture budgets establish the
scope of the measurements; production verification follows deployment.

## Before and after

The table uses medians over three cold observations and six subsequent sweeps.
Each candidate sweep uses eight phases, including its final empty observation.
Main-thread CPU comes from utime+stime at 100 ticks/second. Timer delay is a
separate ten-millisecond scheduler probe. Bytes count serialized source behind
decoded/cloned pipeline rows. They do not measure heap allocation. Total sweep
CPU, wall and timer observations include a twenty-millisecond timer drain.
`rchar` counts main-thread logical file reads, including registry, SQLite and
measurement reads. It is separate from decoded pipeline source bytes. Keyed
internal selections use the primary indexes, so unrelated active headers are
not scanned to find the selected lanes.

| Measurement | Baseline | Candidate |
| --- | ---: | ---: |
| Largest cold controller phase, including the imposed wait on baseline | 11,475 ms | 697 ms |
| Largest warm controller phase | 201 ms | 67 ms |
| Largest cold per-phase main-thread CPU | 2,100 ms | 680 ms |
| Largest warm per-phase main-thread CPU | 195 ms | 65 ms |
| Complete cold sweep plus job settlement | 11,499 ms | 11,566 ms |
| Complete warm sweep plus job settlement | 221 ms | 330 ms |
| Complete cold sweep main-thread CPU | 2,100 ms | 2,190 ms |
| Complete warm sweep main-thread CPU | 195 ms | 305 ms |
| Cold pipeline rows decoded / source bytes | 614 / 75,757,641 | 554 / 71,346,537 |
| Cold pipeline rows cloned / source bytes | 859 / 110,803,535 | 298 / 35,182,513 |
| Warm pipeline rows decoded / source bytes | 94.5 / 11,298,036 | 56 / 7,518,373 |
| Warm pipeline rows cloned / source bytes | 373 / 49,692,470 | 91 / 11,390,425 |
| Whole-hot returned snapshot per sweep | 267 rows | 0 rows |
| Cold main-thread logical read bytes (`rchar`) | 749,671,680 | 956,422,288 |
| Cold maximum labelled synchronous slice | 445.16 ms | 426.42 ms |
| Cold maximum timer delay | 482.82 ms | 496.50 ms |
| Cold maximum observed durable lease hold | 471.73 ms | 389.89 ms |
| Warm main-thread logical read bytes (`rchar`) | 15,889,476 | 33,191,498 |
| Warm maximum labelled synchronous slice | 1.44 ms | 4.92 ms |
| Warm maximum timer delay | 8.09 ms | 34.51 ms |
| Warm maximum observed durable lease hold | 2.59 ms | 5.49 ms |
| Cold time awaiting jobs after the last phase | 0.02 ms | 10,327 ms |
| Main-thread CPU in that interval | 0 ms | 990 ms |
| Equal authoritative records in every pair | 941/941 | 941/941 |

Splitting the sweep increases its total CPU and wall time. The phase bound and
the reduction in materialization are the measured gains. The external stub
creates no child CPU load; job settlement and Viewer CPU during its wait are
recorded separately. The cold registry/task-note costs and the existing
whole-collection branch-ownership reader remain follow-up costs. These results
establish no production CPU or loop-gap improvement.

## Retained-history growth

An isolated engine fixture holds one eligible lane fixed and adds 1,000 settled
peers, each retaining eight attempt outputs. Three alternating full-result and
internal calls exercise the same warmed store. A ten-millisecond timer probes
delay, with a twenty-millisecond drain after each call. The full-result path is the
negative control retained for API compatibility.

| Settled peers | Full-result wall / CPU | Internal wall / CPU | Full-result copies | Internal copies | Internal timer delay / logical read bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 | 10.54 / 10 ms | 13.05 / 10 ms | 2 | 2 | 2.91 ms / 958,174 |
| 1,000 | 96.66 / 100 ms | 13.17 / 10 ms | 1002 | 2 | 3.10 ms / 966,378 |

The large-attempt fixture rotates 33 historical attempts without inspecting
more than sixteen per phase. A completed lane with 65 hosts finishes through
bounded windows and reaches the full engine's authoritative result.

## Verification

Controller-boundary coverage includes the twenty-second Git wait, a held
commit hook, peer claims/releases/repository/branch edits, removal and archival,
same-repository aliases and uncertain common directories,
progress-only peer writes, fair scheduling and conditional acknowledgment,
shared immutable selection, retained history, paused/completed obligations,
SQLite contention and CPU-ticket custody. A real local Git remote test kills
the fixture Viewer during its push hook, starts a successor while the Git child
holds the lock, releases the push and reconciles the landed head. The hook
records exactly one push. Refused, interrupted and uncertain publication cases
retain their accepted head and original outcome custody.

Numeric trials, source/reference hashes and command bounds are in
[`pipelines-controller-bounded-work.json`](../../evidence/perf/pipelines-controller-bounded-work.json).
Private payloads and CPU profiles were inspected in the isolated replay
artifacts. Focused tests, types, lint, publication privacy and the required
PR checks are recorded with the final evidence. The explicit nineteen-file
local comparison passed in 157 seconds with no failing assertions or runner
errors; it includes all twenty-five controller-boundary cases. TypeScript
passes with incremental output disabled. The local privacy gate passes with
committed known-value fingerprints over all twenty-three changed paths.
Runtime-host source and the Bun pin are unchanged. Deployment and the required
production journal audit remain with the authorized deployment stage.
