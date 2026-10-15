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

These measurements record the initial implementation. The review-fix replay
below records the updated implementation.

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


### Publication verification

The publication hook passed types (288 seconds), changed-line lint (8 seconds)
and privacy. Its twenty-nine-file touched-test run exceeded the five-minute
file limit in `engine.providerBudget.test.ts` during concurrent checks. An
isolated rerun passed all 164 tests in 214 seconds. The hook also reproduced one
pre-existing creation-test failure on the merge base: the `early-switch-off`
case of a stage completing while its successor waits for both update roles.

The stopped Linux checks then ran independently: the backend probe passed,
and all seventeen explicit Linux test files passed (1.46 seconds). Every check
used isolated state and the supplied serving-release gate. The measured product
source remained unchanged. These completed checks support the documented
`LLV_SKIP_HOOKS=1` publication override after the concurrent runner refusal;
required hosted checks still judge the published commit.


## Review fixes, 2026-10-15

Close drains share one phase budget across every invocation in that phase.
At most eight cancellation attempts consume it, leaving capacity for host
teardown within the sixteen-operation bound. Failed cancellations move to the
end of the persisted pending list. A fresh process continues that order and
retains every failed cancellation until it succeeds.

Host and flow ownership guards read indexed identity references. Row triggers
commit these references alongside the authoritative pipeline, including writes
from older peers, rollback, deletion and restart backfill. The host projection
preserves source ownership, publication custody, running attempts and unfinished
activation. Resident-host checks and stale-flow cleanup keep peer protection.

A second projection holds attempt positions and references to outstanding host
obligations. The persisted keyset cursor selects sixteen references directly;
a separate indexed lookup retains the current attempt. Deadline preparation
and ordinary reconciliation use those references. Terminal reaping probes its
selected references and asks an indexed existence query about other candidates.
Its identity deduplication and retry custody retain the full engine's decisions.
Projection construction materializes compact reference fields before sorting.

The focused checks exercise seventeen cancellations with sixteen immediate
refusals, host progress within the same phase budget and a fresh process between
phases; resident-host and stale-flow peer ownership with zero and one thousand
settled peers; and selection with 32 and 4,096 attempts. The projection checks
compare custody predicates with the existing guard and cover old-writer SQL,
rollback, deletion and backfill. An independent timer advances while each new
read runs beside a peer-held writer lock.


### Attempt preparation with fixed selected work

The integrated scale probe keeps one paused lane and a sixteen-reference
window. Each sample invokes the production indexed window/current lookup.
CPU uses the main thread's ten-millisecond accounting ticks over one thousand
calls. The maximum call time bounds its synchronous work from above.

| Measurement | 32 retained attempts | 4,096 retained attempts |
| --- | ---: | ---: |
| References returned per preparation | 16 | 16 |
| Selected-key serializations across one phase | 80 | 80 |
| Preparation calls | 1,000 | 1,000 |
| Total preparation wall time (ms) | 39.69 | 34.47 |
| Total preparation main-thread CPU (ms) | 40 | 40 |
| Maximum preparation call wall time (ms) | 2.67 | 0.15 |
| Whole warmed phase wall time (ms) | 24.47 | 92.90 |

These earlier measurements still included full-lane copying. The production
safety review below addresses that remaining phase cost and the reference
trigger that rebuilt retained attempts during output edits. Backfill treats
stored row keys as SQL data, including keys containing alias text and quotes.

### Paired replay after integration

Three fresh alternating pairs reused the unchanged E4/E5 checksums, the same
guarded driver, fixed engine time, conservative responses and a ten-second Git
wait. The candidate includes the merged main source, backfill repair and portable
JSON iteration for native platform SQLite builds.
Every source export and trial used isolated roots. All 941 authoritative
hot/archive payloads match in every pair, with zero refused actuation and zero
replay errors. Cold initialization and two subsequent sweeps are separate.

| Measurement | Baseline | Fixed candidate |
| --- | ---: | ---: |
| Cold largest phase, median (ms) | 11,625.9 | 1,848.9 |
| Cold largest phase across trials (ms) | 11,637.8 | 1,853.2 |
| Cold largest per-phase main-thread cpu, median (ms) | 2,360 | 1,810 |
| Cold complete sweep including job settlement, median (ms) | 11,652 | 12,704 |
| Cold complete sweep main-thread CPU, median (ms) | 2,360 | 3,400 |
| Cold pipeline decoded rows, median | 614.0 | 553.0 |
| Cold pipeline decoded source bytes, median | 75,757,641 | 71,231,598 |
| Cold pipeline cloned rows, median | 859.0 | 298.0 |
| Cold pipeline cloned source bytes, median | 110,803,535 | 35,182,513 |
| Cold pipeline logical read bytes, median | 749,671,728 | 1,045,526,886 |
| Cold largest labelled synchronous slice, median (ms) | 446.83 | 1,076.42 |
| Cold largest labelled slice across trials (ms) | 449.40 | 1,249.16 |
| Cold largest timer delay across trials (ms) | 609.09 | 1,255.66 |
| Cold largest observed lease hold across trials (ms) | 581.74 | 423.60 |
| Warm largest phase, median (ms) | 263.4 | 65.6 |
| Warm largest phase across trials (ms) | 420.5 | 134.2 |
| Warm largest per-phase main-thread cpu, median (ms) | 260 | 70 |
| Warm complete sweep including job settlement, median (ms) | 284 | 383 |
| Warm complete sweep main-thread CPU, median (ms) | 260 | 350 |
| Warm pipeline decoded rows, median | 94.5 | 55.5 |
| Warm pipeline decoded source bytes, median | 11,298,036 | 7,460,856 |
| Warm pipeline cloned rows, median | 373.0 | 91.0 |
| Warm pipeline cloned source bytes, median | 49,692,470 | 11,390,425 |
| Warm pipeline logical read bytes, median | 15,889,416 | 38,895,176 |
| Warm largest labelled synchronous slice, median (ms) | 2.37 | 2.78 |
| Warm largest labelled slice across trials (ms) | 48.61 | 8.96 |
| Warm largest timer delay across trials (ms) | 107.07 | 58.19 |
| Warm largest observed lease hold across trials (ms) | 6.02 | 7.85 |
| Whole-hot returned rows per sweep | 267 | 0 |

Complete sweeps use more main-thread CPU, logical reads and wall time. Cold
projection initialization remains visible. The phase and materialization
measurements establish the improvement within this slice's scope. Raw samples,
measured source hashes, preparation probes and check coverage are in
[pipelines-controller-review-fixes.json](../../evidence/perf/pipelines-controller-review-fixes.json).

The final checks passed 37 cases across the two affected files and eight
projection tests under Bun 1.3.3 after the SQLite iterator compatibility repair.
The twenty-file comparison against the merged main commit found zero new
failures and reproduced nineteen existing assertions. All 432 publication
cases passed in two disjoint filters (206 and 226), with a fifteen-second
per-test timeout and a five-minute execution guard for each group. Earlier
unfiltered runs exceeded that file guard. The Linux backend and seventeen
explicit platform files, TypeScript with incremental output disabled,
changed-file lint and the local privacy gate passed. Checks used isolated
HOME/config/temp/state roots and a closed-port control URL. The documented
publication override avoids repeating the known concurrent-runner timeout
after these isolated checks. Deployment and production verification belong
to the authorized deployment stage.


### Production safety review fixes, 2026-10-15

Output edits now compare a compact projection of the fields that affect
ownership and attempt selection. A matching projection performs zero reference
writes. SQL materializes each run and attempt before extracting its fields;
changes to ownership still refresh the references within the authoritative
writer transaction. The new projection is installed and backfilled under the
existing startup fence, including an upgrade from the earlier trigger schema.
Older peers continue to maintain it through their ordinary row writes.

A terminal batch that follows a settled reap starts with zero failed stops.
An unfinished batch keeps its recorded counts. The regression retains eighteen
terminal attempts, leaves the first settled, and gives the other seventeen
hosts temporary stop failures. Each receives five stop attempts across bounded
windows, including four phases in a fresh process, before becoming unconfirmed.
The same regression on the reviewed revision makes hosts unconfirmed after
one failed stop.

Mutable controller rows copy attempt slots and settled-attempt keys when
accessed. Idle reaping consults cached settled keys before materializing a new
batch. Serialization and checkpoints retain the complete lane. Guard and
membership indexes belong to
the immutable decoded revision and follow it through the shared bounded cache.
Off-window activation or survivor evidence refuses progress; selected mutable
attempts are checked directly. Current-attempt lookup and provenance use the
selected references. Fallback task binding uses indexed identities with the
existing conversation, launch and legacy-path precedence. Unclaimed publication
selection reads cached candidates through async state admission.

The complete warmed-phase probe includes copying, activation and survivor
guards, fallback task preparation, provenance selection, all reconciliation
loops and the controller acknowledgment. It holds one paused lane and sixteen
selected references fixed while retaining 32 or 4,096 attempts and the same
number of settled-attempt keys. Separate checks
cover off-window activation and survivor protection, task identity precedence,
discarded mutable copies and complete checkpoints. A peer-held writer check
covers the controller reads and acknowledgment while an independent timer runs.

The byte counter in the shared replay driver now includes individual attempt
copies and the serialized header of a lazy row. Complete pipeline roots and
partial attempt copies have separate counts; their bytes share one total.
Both revisions use the same driver. Cold initialization remains separate from
the two warm sweeps. Three fresh alternating E4/E5 pairs use the unchanged
reference checksums, captured engine time, external responses and ten-second
Git wait. Their numeric results and focused write/growth samples follow in the
production-safety evidence record. These measurements concern the Viewer and
its controller; deployment and the calm production window remain separate work.


The final replay set includes main `716ddaa48`. Its merge preserves both
Telegram and pipeline monitor labels. Controller tests and TypeScript pass on
the resolved tree; the numeric record retains the earlier measurements too.

E4/E5 uses baseline `011a4fe97` and compares every authoritative hot/archive
payload after each pair: 941 of 941 match in all three pairs. Synthetic write
and retry comparisons use the reviewed revision `a677ae046`.

| Measurement | Baseline | Fixed candidate |
| --- | ---: | ---: |
| Cold largest phase, median (ms) | 11,264.17 | 1,014.21 |
| Cold largest phase across trials (ms) | 11,457.52 | 1,101.15 |
| Cold largest per-phase main-thread CPU, median (ms) | 1,890 | 1,000 |
| Cold complete sweep including jobs, median (ms) | 11,286.62 | 11,786.01 |
| Cold complete sweep main-thread CPU, median (ms) | 1,890 | 2,430 |
| Cold decoded rows, median | 614 | 526 |
| Cold decoded source bytes, median | 75,757,641 | 67,767,804 |
| Cold cloned pipeline roots, median | 859 | 271 |
| Cold cloned roots and attempt bytes, median | 110,803,535 | 31,716,153 |
| Cold logical read bytes, median | 749,671,501 | 1,041,564,723 |
| Cold maximum labelled slice across trials (ms) | 413.48 | 534.48 |
| Cold maximum timer delay across trials (ms) | 505.35 | 538.74 |
| Cold maximum lease hold across trials (ms) | 491.61 | 371.06 |
| Warm largest phase, median (ms) | 185.57 | 58.72 |
| Warm largest phase across trials (ms) | 200.29 | 64.14 |
| Warm largest per-phase main-thread CPU, median (ms) | 180 | 60 |
| Warm complete sweep including jobs, median (ms) | 205.89 | 343.23 |
| Warm complete sweep main-thread CPU, median (ms) | 180 | 315 |
| Warm decoded rows, median | 94.5 | 28.5 |
| Warm decoded source bytes, median | 11,298,036 | 3,996,967 |
| Warm cloned pipeline roots, median | 373 | 64 |
| Warm cloned roots and attempt bytes, median | 49,692,470 | 7,923,970 |
| Warm logical read bytes, median | 15,889,480 | 36,351,251 |
| Warm maximum labelled slice across trials (ms) | 3.27 | 3.87 |
| Warm maximum timer delay across trials (ms) | 12.59 | 34.33 |
| Warm maximum lease hold across trials (ms) | 2.78 | 6.15 |
| Whole-hot returned rows per sweep | 267 | 0 |

The candidate additionally copies 66 individual attempts per sweep (1,192,467
serialized bytes in the median warm sweep), included in its byte total.
Complete sweeps still use more CPU and logical reads than the original engine.
The largest awaited phases and retained-attempt copying fall within the stated
fixture budgets. Cold startup remains visible in the synchronous-slice and
timer measurements.

| Retained attempts | Reviewed output write, median (ms) | Fixed output write, median (ms) | Fixed controller checkpoint lease (ms) |
| --- | ---: | ---: | ---: |
| 32 | 1.06 | 0.56 | 15.64 |
| 1,024 | 184.77 | 11.73 | 70.75 |
| 4,096 | 3669.89 | 41.66 | 255.33 |

The output write is identical raw SQL on both revisions. The fixed projection
also checks zero reference inserts during these edits and verifies an ownership
change and rollback through independent connections. The larger engine
fixture reproduced a 12,849 ms mutation lease on the reviewed revision.

| Retained attempts and settled keys | Attempt visits per phase | Attempt copies per phase | Median phase wall (ms) | Maximum labelled slice (ms) | Maximum timer delay (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 32 | 112 | 16 | 24.99 | 1.42 | 19.20 |
| 4,096 | 112 | 16 | 31.09 | 2.90 | 19.35 |

Thirty warmed phases per size retain distinct terminal host identities and a
settled key for every attempt. The focused checks pass 110 cases across six
explicit files, with the recovery file filtered to task binding. TypeScript,
changed-file ESLint and local publication privacy passed.
All commands use the supplied CPU gate and isolated HOME, config, temp and
state roots with a closed Viewer control URL. Existing ESLint warnings are
unchanged. The numeric record includes every replay sample and the work counts:
[pipelines-controller-production-safety-fixes.json](../../evidence/perf/pipelines-controller-production-safety-fixes.json).

An optional expanded run on the reviewed revision completed the 32-attempt
sample and was cancelled during setup of the 4,096-attempt case, after about 151 s
in the owned run. Its partial samples are retained in the numeric
record. The two ordinary regressions failed independently on that revision;
the identical SQL write comparison completed at every size. The candidate's
expanded fixture completes all thirty phases at both sizes.

## Running-lane and schema-upgrade follow-up

The next review found repeated full copies in running selections, a regression
in unrelated keyed writes, and an incomplete schema-readiness sentinel. Hosts
and running selections now share immutable candidates. Other selection kinds
retain detached report/header copies and use the controller attempt window.
Explicit full-result callers retain their complete mutable snapshots.

Complete running phases also serialized the whole lane twice to detect
progress. That comparison now covers run headers, selected obligations and any
new attempt tail, under the static controller-lane label. The growth case keeps
a running cursor and a distinct current attempt alongside sixteen historical
references. It pins that window before each measured phase so both sizes do
exactly the same selected work.

The write regression came from combining the reference-trigger graph with the
scalar order subquery inside each keyed INSERT. Separating the indexed MAX
lookup from the INSERT preserves its transaction, order allocation, conditional
patches, rollback and all old-writer triggers. The unchanged 5,000 ms test failed
on the reviewed code in 6,696.91 ms and now passes in 142.46 ms. An identical
500-write comparison and its trigger-removal control are recorded below.

Both the outer database-opening fast path and the installer now require the
same complete reference schema. A fresh-process regression checks compact
backfill, unchanged authoritative rows and zero reference inserts after an
output-only edit. A separate probe installed the actual reference schema from
`a677ae046`, then opened it in a fresh current process: compact input and owner
backfill succeeded, every authoritative row stayed identical, and an output edit
caused zero reference inserts.

Three final alternating E4/E5 pairs use the unchanged checksums, baseline
`011a4fe97`, identical guarded driver, fixed time and ten-second Git delay.
Every pair matches all 941 authoritative hot/archive records. Cold initialization
and two warm sweeps remain separate. Entries are medians except named maxima.

| Measurement | Baseline | Follow-up candidate |
| --- | ---: | ---: |
| Cold largest phase (ms) | 11,211.04 | 1,026.46 |
| Cold largest phase across trials (ms) | 11,289.08 | 1,041.82 |
| Cold largest per-phase main-thread CPU (ms) | 1,670 | 960 |
| Cold complete sweep including jobs (ms) | 11,233.74 | 11,760.80 |
| Cold complete sweep main-thread CPU (ms) | 1,670 | 2,240 |
| Cold decoded rows / source bytes | 614 / 75,757,641 | 526 / 67,767,804 |
| Cold cloned roots / roots and attempt bytes | 859 / 110,803,535 | 256 / 30,295,938 |
| Cold logical read bytes | 749,671,524 | 1,041,564,757 |
| Cold maximum labelled synchronous slice (ms) | 377.01 | 586.05 |
| Cold maximum timer delay (ms) | 459.69 | 590.85 |
| Cold maximum lease hold (ms) | 446.96 | 332.52 |
| Warm largest phase (ms) | 184.94 | 57.29 |
| Warm largest phase across trials (ms) | 223.71 | 61.42 |
| Warm largest per-phase main-thread CPU (ms) | 185 | 60 |
| Warm complete sweep including jobs (ms) | 205.24 | 341.36 |
| Warm complete sweep main-thread CPU (ms) | 185 | 310 |
| Warm decoded rows / source bytes | 94.5 / 11,298,036 | 28.5 / 3,996,967 |
| Warm cloned roots / roots and attempt bytes | 373 / 49,692,470 | 52 / 6,845,539 |
| Warm logical read bytes | 15,889,378.5 | 36,351,195.5 |
| Warm maximum labelled synchronous slice (ms) | 1.84 | 4.80 |
| Warm maximum timer delay (ms) | 13.98 | 34.95 |
| Warm maximum lease hold (ms) | 3.06 | 7.00 |
| Whole-hot returned rows per sweep | 267 | 0 |

The candidate detaches 108 individual attempts per sweep, included in the byte
total. Complete-sweep CPU and logical reads remain above the original engine;
cold schema initialization remains visible in slice and timer measurements.
The fixture phase budgets pass. Production deployment and its calm observation
window remain separate work.

Thirty complete warmed phases per size and state keep the selected window fixed:

| State | Retained history | Visits / copies per phase | Median phase (ms) | Maximum labelled slice (ms) | Maximum timer delay (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Paused | 32 | 112 / 16 | 24.42 | 1.66 | 17.45 |
| Paused | 4,096 | 112 / 16 | 25.96 | 1.96 | 17.63 |
| Running, plus current attempt | 32 | 136 / 17 | 23.60 | 1.08 | 15.90 |
| Running, plus current attempt | 4,096 | 136 / 17 | 35.13 | 1.89 | 20.74 |

On the reviewed revision, the new running case copied 12,291 attempts at the
larger size and failed its 128-copy bound. Its fresh-process upgrade case failed
because `pipeline_ref_inputs` remained absent. Together with the unchanged
bounded-store timeout, all three findings have failing controls on the reviewed
code. Numeric samples, source hashes and the earlier exploratory replay are
retained under `runningAndUpgradeReview` in the
[existing evidence record](../../evidence/perf/pipelines-controller-production-safety-fixes.json).

| Unrelated 500-write transaction, three samples | Reviewed median (ms) | Follow-up median (ms) |
| --- | ---: | ---: |
| All reference triggers installed | 611.79 | 10.51 |
| Reference triggers removed in the private database | 161.22 | 9.34 |

The identical probe runs on the recorded reviewed export and final candidate.
Ordinary prepared VALUES inserts take about 1.8 ms on both; the expensive
combination is the scalar order subquery inside the trigger-bearing INSERT.
Reference-trigger SQL stays intact in the fix.

Focused verification passes 260 tests across ten explicit files, each with
isolated HOME, config, temp and state roots and a closed Viewer control URL.
The full touched files contribute 35 controller-pass and ten bounded-store
tests. Nonincremental TypeScript and changed-file ESLint pass, with six existing
warnings. The evidence record lists each file and count.

The normal publication hook passed privacy, types (95 seconds) and lint
(4 seconds). Its concurrent twenty-nine-file test run reported a new runner
error after the provider-budget file exceeded the five-minute file budget.
The hook also reproduced the existing `early-switch-off` creation assertion
on the merge base. This repeats the concurrent timeout recorded in the earlier
publication verification above.

The provider-budget file then passed all 164 tests alone in 279.43 seconds,
under the unchanged five-minute execution budget. The stopped Linux backend
probe and all seventeen explicit platform files passed independently; their
comparison had a green head in 1,218 ms and needed no baseline sample. These
isolated checks support the documented `LLV_SKIP_HOOKS=1` publication override.
The production source stayed unchanged during these rechecks; required hosted
checks still judge the published commit.
