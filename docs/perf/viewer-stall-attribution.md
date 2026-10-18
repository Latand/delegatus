# Viewer stall attribution

This change adds attribution for the next isolated replay or approved release.
The production caller behind the reported fourteen-second stalls remains
unobserved. No production fix, GC attribution or deployment improvement is
claimed.

## Independent heartbeat evidence

`loopWatchdog.ts` keeps the existing 600-slot, 100 ms shared ring. The main
monitor updates one atomic heartbeat on each tick. The independently scheduled
worker records a trigger when that heartbeat is more than one second old.
The trigger contains numeric timestamps, the current static performance-site
number, and cached RSS readings with their sample timestamps. It records one
trigger per stale heartbeat, with a sixty-second
cooldown and one retained record. The whole shared allocation is 52,904 bytes.
There is no message stream, stack capture, profiler, filesystem output, or
main-thread read added to an ordinary monitor tick. RSS comes from one
asynchronous `/proc/PID/status` read in the worker: at most one in flight,
once per second while healthy and at most ten per second while stale. The
600-slot ring retains RSS values and sample timestamps throughout the stall.
`scheduler.rss` reports the observed endpoints, peak and growth;
`scheduler.stall` also retains the baseline and trigger-time values. RSS is
process-wide. Main-VM heap counters remain explicitly unavailable on Bun;
no heap walk or synchronous memory reader was added.

The next loop-gap report includes the retained trigger under `scheduler.stall`,
with its site decoded. Its timestamp belongs to the stalled interval, before
the recovery callback. The sequence repeats until a later trigger replaces it;
compare its timestamps with the gap before attributing that gap. A static site
describes an enclosing synchronous call. It does not identify a native or GC
stack. Unwrapped work remains `unknown-runtime-or-native`.

Tests run a real worker across main-thread CPU blocks, delay observation past
recovery, start fresh processes, probe cooldown, and run the actual producer
past 600 samples. The healthy-heartbeat control retains no trigger. The
unpublished trigger sentinel is rejected by the reader.

## Phase inventory

| Producer | Phase | Consumer |
| --- | --- | --- |
| Scanner worker stdout consumer | `scanner.ipc-frame`, `scanner.ipc-decode` | Shared performance spans and watchdog site |
| Resource and completed catalog publication | `scanner.publication` | Same recorder; existing catalog generation fence |
| Completed catalog to index feed | `transcript.feed` | Same recorder; existing index scheduler |
| Persisted scan snapshot writer | `scanner.cache-encode`, `scanner.cache-persist` | Same recorder; existing persistence path |
| Transcript feed background runner | `transcript.index` | Awaited span plus loop-monitor operation |
| Memory service discovery and refresh | `memory.discovery`, `memory.refresh` | Awaited spans plus loop-monitor operations |
| Memory project resolution, source identity reads, oversize removal, parse, entry transaction and complete pruning | `memory.refresh` | Synchronous spans and watchdog site; the site is restored around each asynchronous file operation |
| Existing response JSON encoding | `files.encode`, `runtime.stringify`, plus `scanner.cache-encode` | Synchronous spans and watchdog site |
| Next serving tracer render entry points | `http.render` | Synchronous entry span and awaited loop-monitor operation |

The site array is append-only in this change, preserving existing numeric IDs.
The worker produces the shared numeric ring; `startLoopWatchdog().snapshot()`
reads it; `createViewerLoopMonitor` consumes it and maps sites in journal JSON.
The standalone `benchmark-loop-heap.ts` and performance-span tests also read
the ring. Existing numeric site IDs stay fixed; the RSS fields and render site
are appended, and no persisted format changes. Journal consumers in the
read-attribution and registry benchmarks,
SQLite tests and pipeline responsiveness/lease tests select existing fields;
none requires an exact set of scheduler keys.
Runtime-host consumers of the same monitor retain the same report shape with
additive stall and RSS fields. Payloads, catalog fences, durable formats,
refresh cadence
and failure outcomes retain their existing contracts.

The residual-reader change on main covers scanner discovery and registry
readers. Its diff was checked; these attribution changes stay in the IPC,
cache, publication and memory adapters.

## Pinned-runtime profiler control

Run `scripts/probe-loop-profiler.ts` through `scripts/gate-slot.sh`, with private
HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR. The script creates another
private child environment. An outer parent owns a fifteen-second SIGKILL
deadline. Profiles exist only inside that disposable child; its output is
bounded control metadata without source paths or captured application data.

Under Bun 1.4.0, local `node:inspector` Profiler enable, 10,000 microsecond
sampling, start and stop identify both `namedMainThreadControl` and
`pbkdf2Sync`. An immediate second capture verifies that the previous caller is
cleared. A separate worker arms through `connectToMainThread()` and completes
its own stop before main-thread recovery, but misses the named main-thread
control which the local session captured. Successful command acknowledgement
does not establish that it targeted the main thread.

The pinned implementation's
[connectToMainThread](https://github.com/oven-sh/bun/blob/bun-v1.4.0/src/js/node/inspector.ts)
connects the worker's local session. Its
[CPU-profiler binding](https://github.com/oven-sh/bun/blob/bun-v1.4.0/src/jsc/bindings/BunCPUProfiler.cpp)
uses the calling VM and exposes sampling interval, start, and stop. There is no
producer sample cap in the exposed inspector path. The probe asks for a
one-sample cap with `maxSamples` and `maxBufferSize`; the returned profile
contains more than one sample. Truncating that result would only bound the
consumer after native samples and their conversion had already accumulated.

The probe performs real forced collections in another capture. Automatic-GC
coverage stays `unknown`; neither an allocation loop nor a function named `gc`
establishes coverage of automatic collections. The existing GC observer
continues to report `gc-entry-unsupported` on this runtime.

Consequently this change deliberately ships no continuous serving profiler.
A main-thread stop timer would run after a blocking call returns. The tested
worker session does not supply an independent main-thread stop or producer
cap. A bounded production recorder still needs a runtime primitive with those
properties, or separately authorized native sampling with an independently
controlled bounded producer. The settled scope ships the heartbeat, RSS
evidence and labels without a
serving recorder. No Bun modification, new capability or host-policy change
is required. Unlabelled native work and GC still require further evidence.

The render bridge loads the serving Next tracer through `createRequire`,
reached by an ignored dynamic import of `node:module` outside the
instrumentation bundle, and installs once per tracer in a shared
WeakSet. It forwards every argument and retains only static render labels.
Its synchronous entry sets the watchdog site, and the enclosing operation
survives the returned promise. Streaming work and later async continuations
can still sample as unknown; an overlapping render operation alone does not
establish CPU ownership. The bridge does not retain rendered content, route
strings, headers or exceptions. It uses the installed Next internal tracer,
so its real-module test and built Viewer rehearsal must accompany upgrades.

## Populated scanner replay

`scripts/measure-scanner-ipc.ts` replays 30,000 deterministic catalog rows as
4 KiB writes from a real leased scanner child. It emits the frame's SHA-256,
size, three timing samples, maximum timer gap, and sampled function names.
Run with `NODE_ENV=test`, the isolated roots above, and `gate-slot.sh`. Use
the same script and data for both revisions, in separate scratch exports;
do not time a serving installation. These are instrumented replay timings,
including process startup, with a 10 ms CPU sampling interval.

The initial attempt’s scanner comparison used a 20,197,884-byte frame, SHA-256
`33daf4eb29d28fdfd2651f001adb04e8d3ea91a6bd49843f4c9c6e953020a06c`,
Bun 1.4.0, the same script in separate scratch exports, and the same gate
admission policy. The base was `225c3c166f710a6723ffa3309f0437d2f732df3c`.
Runs were serial, three at the base followed by three with attribution.

| Run | Base elapsed (ms) | Attribution elapsed (ms) | Base max timer gap (ms) | Attribution max timer gap (ms) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 252.7 | 342.3 | 190.0 | 278.8 |
| 2 | 323.7 | 346.0 | 252.7 | 276.5 |
| 3 | 334.9 | 339.2 | 267.4 | 275.7 |

`consume` and `indexOf` dominated the base samples. Median elapsed time was
323.7 ms at the base and 342.3 ms with attribution, an observed increase of
18.6 ms (5.8%). These instrumented sequential runs do not isolate telemetry
overhead from scheduling variation. Neither revision reproduced the
fourteen-second stall. This change claims no speed improvement.

## Historical settled-continuation overhead

This measurement is retained as historical evidence. Its watchdog and monitor
fingerprints predate the final diagnostic sources, so it does not establish the
idle-cost condition for the final recorder.

An earlier watchdog/monitor source was compared with the task's starting
revision in fresh private child processes, alternating the order within each
of five pairs per mode under one gate admission. Every child warmed up for
one second, then ran 200 batches at a 20 ms period. The loaded case performed
three JSON round trips over the same 10,000 deterministic rows per batch.
Every input digest matched and every loaded checksum was 6,000,000.
The metric is whole-process user plus system CPU, including the worker.

| Mode (four-second phase) | Base median CPU (ms) | Final median CPU (ms) |
| --- | ---: | ---: |
| Idle | 76.635 | 79.711 |
| JSON load | 1062.815 | 901.842 |

The paired mean idle difference was −0.132 percentage points of one core;
the two-sided 95% t interval was [−0.962, +0.699]. No idle increase was
detected in this fixture; this interval cannot exclude a small cost. Loaded
results varied substantially and establish no speed improvement. These runs
exercise the idle monitor and JSON work, without claiming production-equivalent
load or identifying the fourteen-second caller.

The complete historical measurement source, parameters, data SHA-256 and every timing
are retained under `continuation.overhead` in the evidence JSON. To reproduce,
make scratch exports named `base` and `candidate`, supply their dependencies,
and write `protocolSource` verbatim to `idle.ts` beside them. Use the starting
revision above for `base` and the containing commit for `candidate`. Run
`bun idle.ts` through the gate wrapper with isolated HOME, XDG_CONFIG_HOME,
LLV_STATE_DIR and TMPDIR. The protocol uses `isolatedEnvironment` for every
child. It never loads a serving profiler.

## Final-source settled-continuation overhead

After the memory attribution fix, the paired run used the original baseline
`225c3c166f710a6723ffa3309f0437d2f732df3c` and source revision
`59339d0afcab15bad861dcdce3c3d448934a5602`. Fresh scratch exports ran under
Bun 1.4.0 through one gate admission. Each child warmed up for one second and
ran 200 batches at 20 ms intervals; the JSON-load phase serialized and parsed
three times per batch over the same 10,000 deterministic rows. Run order
alternated within five pairs in each mode. All input digests matched
(`0d7b7c3aa91f91b6d1bb3cad9d72a87db923580e3f206216875eccea55ceb8cf`), and
each loaded checksum was 6,000,000. CPU is whole-process user plus system time,
including the watchdog worker.

| Mode (four-second phase) | Base median CPU (ms) | Final-source median CPU (ms) |
| --- | ---: | ---: |
| Idle | 96.559 | 93.042 |
| JSON load | 2111.233 | 1733.812 |

The paired mean idle difference was +0.119 percentage points of one core;
the two-sided 95% interval was [−0.576, +0.815]. This fixture detects no idle
increase and the interval remains wide enough to include a small cost. The
loaded interval was [−22.736, +12.095] percentage points, with substantial
run-to-run variation. These results establish neither a production-equivalent
load nor a performance gain, and they do not identify the production stall
caller.

The complete final-source protocol, all twenty raw observations and a SHA-256
manifest for every TypeScript source and test changed in the diagnostic lane
through the measured revision are stored under
`continuation.finalSourceOverhead` in the evidence JSON. This run supersedes
the earlier overhead evidence for final-source claims; the earlier raw run
remains under `continuation.overhead` with its historical provenance.

## Verification before the settled continuation

Both the starting revision and this change built successfully. With the
repository's `createGateSandbox` and `isolatedEnvironment`, the Viewer
runtime verifier loaded 25/25 modules and served HTTP 200 on both builds.
Runtime-host succession passed, including 27/27 stable-listener responses
and 27/27 runtime-socket responses over fifteen seconds. The three executable
runtime negative controls passed. Typecheck and changed-file ESLint passed.

The watchdog/profiler/monitor group passed five tests. The scanner/memory
group passed 75 tests and retained one existing failure:
`worker scans publish a Claude transcript that appears in a previously
sessionless project directory`, with `read ECONNRESET`. The starting revision
failed the same case under the same isolation (10 pass, one fail). Both new
scanner diagnostic cases passed. The performance/heap/feed group passed
25 tests. An earlier 39-case run also covered catalog freshness successfully.

Initial Viewer runtime checks failed identically on both revisions because
their nested private inbox paths lost the pipeline scratch exemption. The
existing gate isolator resolved that harness condition; no owner token or
state-ownership exception was added. Test/build commands ran through the
project's gate wrapper, against scratch exports and private state.

The native shared-runtime selection and both pinned Codex engine selections
(0.154.0 and 0.159.0) passed. Detailed results are recorded in
[`viewer-stall-attribution.json`](../../evidence/performance/viewer-stall-attribution.json).
Hosted publication and tracker
audit checks belong to the pipeline's later publication; no source was pushed
or service deployed by this stage.

An own-process `perf stat -e task-clock -- true` control was refused at
`perf_event_paranoid=4`. The operator deferred both native sampling and Bun
changes. No capability, kernel policy or service configuration was changed.
The profiler compatibility probe runs only when invoked explicitly; nothing
in the serving import graph starts it.

## Settled-continuation verification

The final path selection passed 76 tests across the watchdog, real Next tracer,
loop monitor, performance spans, heap signals and Viewer instrumentation.
After the final native-import correction, all 46 affected render/startup
cases passed again. Final typecheck, changed-file ESLint and local privacy
publication checks passed.
The corrected production build completed without the createRequire warning.
Its emitted render bridge retains the ignored native module import.

Under Bun 1.4.0, the built Viewer loaded 25/25 server modules and answered
GET / with HTTP 200 (82,414 bytes). The runtime host completed succession
and answered 27/27 requests on both the listener and runtime socket over
fifteen seconds. All three executable runtime negative controls passed.
The runtime rehearsals used the existing `createGateSandbox` and
`isolatedEnvironment` helpers, as in the previous attempt: a nested scratch
inbox otherwise reproduces the already-recorded ownership refusal.
No owner token, ownership exception or live-state test was added.

The documented journal parser passed controls for a binary prefix, process
identity, role selection, the strict five-second threshold and a retained
trigger outside its gap. Required hosted checks, including the tracker audit,
run after the pipeline publishes and a pull request exists. No push, PR
creation, deploy or production acceptance run was performed in this
continuation. The exact production caller and automatic-GC contribution
remain unproven.

## Final-source fix verification

Revision `59339d0afcab15bad861dcdce3c3d448934a5602` passed the two explicit
memory paths under isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR:
`src/lib/memory/service.test.ts` (2 tests, 21 assertions) and
`src/lib/memory/index.test.ts` (62 tests, 2,781 assertions). The service test
holds the source read, checks that the watchdog site is unknown during the
wait, then injects bounded CPU into a resumed segment and complete pruning; the
watchdog site and corresponding synchronous slices both identify
`memory.refresh`.

Typecheck (`bunx tsc --noEmit`), local privacy-publication, and the production
build passed from the exact source export. The build emitted its existing CSS
warning for `::highlight(tts-karaoke)`. With the scratch-only TMPDIR harness
adjustment, the Viewer loaded 25/25 modules and GET `/` returned HTTP 200. The
runtime host completed succession and answered 27/27 requests on both
endpoints over fifteen seconds. The hosted `privacy-tracker-audit` and
aggregate `runtime-gate` verdicts remain for pipeline publication. No service
was deployed; the production caller and the loaded thirty-minute acceptance
window remain unobserved.

## Deployment acceptance remains pending

After a separately approved deployment, record serving readiness, loaded
agent count (load comparable to the reported eleven live agents), PID/start
identity, revision and exact UTC START. END must be
exactly thirty minutes later. Select that closed interval with:

```sh
journalctl --user -u delegatus.service --utc --since "$START" --until "$END" \
  --all -o cat --no-pager | grep -aF '[viewer loop-gap] '
```

For each gap, inspect `scheduler.stall` only when its `utcMs` falls between
`timeOrigin + lastTick` and the report completion. Its
`site` is the phase sampled during the stall. Also inspect
`attribution.slices` (synchronous kind and overlap), `operations`,
`scheduler.sites`, and `scheduler.rss` with its sample timestamps. A named
synchronous slice covering the gap and repeated site samples can identify a
caller; an awaited operation alone cannot. Retained triggers can repeat
during cooldown. Unknown sites and unavailable heap counters are evidence
limits, never a GC diagnosis.

Keep the unfiltered journal for the same interval as well:

```sh
journalctl --user -u delegatus.service --utc --since "$START" --until "$END" \
  --all -o cat --no-pager > "$JOURNAL"
grep -aF '[viewer loop-gap] ' "$JOURNAL"
grep -aF '[performance summary] ' "$JOURNAL"
```

To display the attribution for the selected serving process, set PID,
PROCESS_START (the diagnostic `start` UUID) and REVISION, then run:

```sh
python3 - "$JOURNAL" "$PID" "$PROCESS_START" "$REVISION" <<'PYTHON'
import json, sys
source, pid, start, revision = sys.argv[1:]
gaps = []
for line in open(source, 'rb'):
    marker = b'[viewer loop-gap] '
    if marker not in line:
        continue
    row = json.loads(line.split(marker, 1)[1])
    if (row.get('role'), row.get('pid'), row.get('start'), row.get('revision')) != ('viewer', int(pid), start, revision):
        continue
    gaps.append(row)
    if row['gapMs'] > 5000:
        stall = row['scheduler'].get('stall')
        in_gap = bool(stall and row['timeOrigin'] + row['lastTick'] <= stall['utcMs'] <= row['timeOrigin'] + row['tick'])
        print(json.dumps({'utc': row['utc'], 'gapMs': row['gapMs'],
            'stallInGap': in_gap, 'stall': stall,
            'rss': row['scheduler'].get('rss'),
            'sites': row['scheduler']['sites'],
            'operations': row['operations'], 'slices': row['attribution']['slices']}))
print(json.dumps({'gapRecords': len(gaps), 'violations': sum(row['gapMs'] > 5000 for row in gaps)}))
PYTHON
```

Require zero violations, continuous performance-summary coverage,
stable serving identity, no lost gap sequence and no increase in `logDropped`.
Match summaries by role, PID and start UUID; their revision can be null.
Check summary coverage across both window edges and each minute in between.
Record START and END and verify their difference is exactly 1,800 seconds.
An empty selection alone cannot pass. A populated isolated replay does not
replace this production acceptance window.


## Follow-up sampling spike on the pinned runtime

The standing requirement dated 2026-10-14 is to eliminate multi-second Viewer
pauses. A profiler can supply the missing caller evidence; it supplies no
latency improvement by itself. At the spike checkpoint, no tested API supplied the specification's hard
producer bound on Bun 1.4.0. Work stopped there for a decision. The subsequent
decision accepts native collection throughout a blocked interval and authorizes
the serving recorder described below; the original measurements remain intact.

`scripts/probe-loop-profiler.ts --jsc` now tests `bun:jsc.profile()` in a
disposable main-thread process. A synthetic three-second CPU block is sampled
at 10,000 microseconds. The result identifies `syntheticThreeSecondBlock` in
`scripts/probe-loop-profiler.ts`, including its source line and self/total
sample weights. Only the known synthetic target's metadata leaves the child;
raw profiles, source paths and function names from other frames stay inside it.
The control also checks exception propagation and a clean subsequent capture.
This proves function attribution in the spike. It creates no serving
`[viewer loop-gap]` record.

| API on Bun 1.4.0 | Result | Missing bound |
| --- | --- | --- |
| `bun:jsc.profile(callback, interval)` | Names the synthetic function and source line; accepts an async callback. | Stops when the callback/promise completes. A 100 ms stop timer is delayed until the three-second CPU block returns. No exposed sample, byte or stack-depth cap. |
| `bun:jsc.startSamplingProfiler()` | Export exists; its binding starts the current VM's profiler. | No exported stop; unsuitable for a temporary serving recorder. |
| Local `node:inspector` CPU profiler | Existing control captures JS/native callers and clears them on stop. | Requested one-sample limits are ignored. The main loop must execute stop. |
| Worker `connectToMainThread()` | Existing worker control stops before main-thread recovery. | It misses the main-thread function captured by the local session. |

The pinned [JSC binding](https://github.com/oven-sh/bun/blob/bun-v1.4.0/src/jsc/modules/BunJSCModule.h#L621)
starts profiling before invoking the callback and builds the reports after it
returns or its promise settles. It exposes the interval and callback arguments.
Its [start binding](https://github.com/oven-sh/bun/blob/bun-v1.4.0/src/jsc/modules/BunJSCModule.h#L412)
also uses the calling VM. The pinned
[inspector binding](https://github.com/oven-sh/bun/blob/bun-v1.4.0/src/jsc/bindings/BunCPUProfiler.cpp#L44)
starts that VM's sampling profiler with its interval. These exposed paths
provide no independently enforced producer cap. This is a conclusion about
the tested APIs and reviewed bindings; no custom native implementation was
attempted. Trimming a returned profile limits output only after collection
and report conversion have already happened. A cooldown also cannot bound the
capture already in progress.

### Reproduce the spike

Work in a scratch export with frozen dependencies. Set private HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR; unset LLV_STATE_OWNER and set
LLV_VIEWER_CONTROL_URL to `http://127.0.0.1:1`. GATE below is the installed
`scripts/gate-slot.sh`. Run each heavy command serially:

```sh
bash "$GATE" bun scripts/probe-loop-profiler.ts
bash "$GATE" bun scripts/probe-loop-profiler.ts --jsc
bash "$GATE" bun scripts/probe-loop-profiler.ts --cost
bash "$GATE" bun scripts/local-gate-tests.ts --base "$BASE" \
  ./scripts/probe-loop-profiler.test.ts
bash "$GATE" ./node_modules/.bin/tsc --noEmit --incremental false
bash "$GATE" ./node_modules/.bin/eslint \
  scripts/probe-loop-profiler.ts scripts/probe-loop-profiler.test.ts
```

The capability child has a parent-owned 15-second kill deadline. Each cost
child has a 120-second parent-owned deadline; the gate owns the whole run.
Those protections belong to disposable spike processes. Killing a serving
Viewer would violate the purpose of this task.

The cost driver repeats each API in three fresh processes, reversing API
order on the middle repetition. Each process warms both arms, then alternates
baseline/profiled order for 20 idle and 20 busy pairs. Idle awaits 200 ms;
busy performs fixed batches of 20 JSON round trips over 10,000 fixed rows.
A calibration chooses the batch count once per process, then both arms use
that identical work. Both arms retain the loaded profiler modules and idle
inspector session. Whole-process CPU and elapsed time include start, stop
and report conversion. Raw pairs include the work counts, checksum and load
averages before/after; background machine work is uncontrolled. Negative
paired deltas are measurement variation. These synthetic results establish
no production overhead or maximum-memory guarantee.

Results and source hashes are in
[`evidence/loop-profiler-spike/spike.json`](../../evidence/loop-profiler-spike/spike.json).
The final cost run completed at **2026-10-18T09:45:45.769Z** under Bun
**1.4.0**, revision `34cbb9a40b4bd1bd767d134a7065e66c2432a676`.
Each row has 60 pairs. Values below are profiled minus baseline milliseconds
per paired block, including report conversion.

| API | Workload | Mean added CPU ms | CPU-difference SD ms | Mean added wall ms |
| --- | --- | ---: | ---: | ---: |
| jsc | idle | -0.0640 | 0.6360 | 0.0914 |
| jsc | busy | 0.6346 | 22.4417 | 0.2265 |
| inspector | idle | -0.0141 | 0.6290 | 0.1124 |
| inspector | busy | -5.1869 | 9.7884 | -5.6862 |

The dispersion prevents a negligible-overhead claim. The parent gate had a
three-core CPU quota and an 8 GiB memory cap; it shared an eighteen-core work
slice. These are disposable-process containment limits. They provide no
in-process native-buffer guarantee for a serving Viewer.

The full touched-tests gate passed both tests with a green head and no new
failures against base `f69ba98f92fcd84743c9570ca7a2ba011b474742`; no baseline
checkout was needed. Full TypeScript and changed-file ESLint passed.
No runtime-host source, shared
monitor, release pin or deploy path changes in this spike. The exercised
processes are disposable Bun main-thread controls and their inspector worker;
neither a serving Viewer nor a runtime-host generation is exercised.

### Options recorded at the spike checkpoint

The subsequent decision selected option 2. This list preserves the spike
checkpoint; the serving contract below governs the implementation.

1. Recommended: authorize a runtime-level follow-up that adds or selects a
   profiler with a fixed native sample/byte/depth budget and a stop deadline
   independent of the sampled main thread. Re-run this spike before wiring
   the Viewer setting and 30-minute deploy window. A changed Bun pin also
   requires both Viewer and runtime-host rehearsals.
2. Revise the hard-bound acceptance to permit a temporary opt-in recorder
   whose native collection can continue for the entire blocked interval.
   A timer/cooldown and bounded log would still leave that exposure.
3. Reconsider separately authorized external native sampling with independently
   bounded collection. This changes the no-privileges constraint and requires
   a new scope; existing machine access restrictions remain in force.


## Serving JavaScript recorder under the revised contract

The follow-up decision permits native collection throughout a blocked interval
on the pinned Bun 1.4.0. No runtime or Bun pin changes and no external profiler
are involved. This adds diagnostic attribution; it claims no reduction in pauses.
The spike's 240 idle/busy pairs above remain the cost evidence. Their dispersion
still prevents a negligible-overhead claim for a serving process.

### Arming and disabling

The opt-in setting is the small `loop-profiler.json` file in the installation's
state directory: `{"enabled":true}` enables the next deployed revision's first
Viewer start. The default is off. Set `enabled` to `false`, remove the file,
or make it invalid to disable collection. Settings are reread asynchronously at
every window boundary and before collection following cooldown; a read error
fails closed. The read itself is limited to 513 bytes; over 512 is invalid.
No UI, MCP mutation or runtime-host setting was added.

Only a serving Viewer with a validated launcher diagnostic revision or container
release revision can arm it. Development, builds, unidentified starts and the
runtime host cannot arm it. The first Viewer start for a new revision consumes
that revision's opportunity in `loop-profiler-deploy.json`, even when opt-in is
off. A restart on the same revision stays off; a new deployed revision can arm
again. A malformed ledger fails closed. The one-row ledger is replaced atomically
under the existing asynchronous file-transaction lock, so concurrent starts
cannot both claim it. It contains a revision and startup timestamp only.

An armed process expires thirty minutes after recorder startup, using a monotonic
deadline set before startup I/O. No window starts at or after expiry. The final
window's timer is shortened to the remaining budget. A blocked main thread can
postpone timer completion and expiry enforcement until it recovers; this is the
accepted native exposure. Changing the opt-in file to off prevents another
window at the next boundary, including when the change occurs during collection.
Re-enabling after a disable requires the next deployed revision.

### Collection, correlation and bounds

`src/lib/loopProfilerServing.ts` is loaded only from Viewer instrumentation.
It loads `bun:jsc` through a runtime import after opt-in and deploy admission.
The monitor owns one recorder across compiled bundles, and stopping the monitor
stops admission of new windows. The runtime host shares monitor code but has no
recorder startup path; the Bun pin and runtime-host source are unchanged.

Consecutive `profile(async () => sleep(W), 10000)` windows use W = five seconds.
A window without a loop gap of at least two seconds releases the returned
profile without accessing or retaining its stacks. A qualifying gap retains its
existing diagnostic record until the profile boundary, usually at most five
seconds later; the recorder flushes the monitor's tick before converting the
profile, so a profile timer that runs first still correlates the gap. Up to four
pending gap records share one sanitized window summary. Their original sequence,
timestamps, operations and scheduler evidence remain on the same
`[viewer loop-gap]` line, with an added `jsProfile` field. Capture/conversion
failure releases pending records with status `unavailable` and stops collection.
The existing bounded nonblocking log sink still owns delivery and drop counts.

Native collection continues throughout the blocked interval: at 10 ms this is
approximately 100 samples per blocked second. Bun also constructs its native
reports before returning them. There is no hard native sample, depth, memory,
CPU or stop-time bound. The following limits apply **after** collection:

- Inspect at most 4,096 evenly spaced samples and 32 frames per sample in
  each of two bounded passes.
- Keep at most 128 candidate frame counters using Misra-Gries elimination,
  then count exact weights for the survivors and keep the top 16 rows by
  self/total samples. Candidate selection can omit rare frames; hot frames
  arriving late can displace earlier one-off frames. Recursive frames count once per sample for total weight. Weights
  divide by inspected samples, including samples omitted by privacy filtering.
- Enforce an 8,192-byte UTF-8 cap on the retained window summary and metadata,
  dropping the lowest-ranked rows as needed. Raw stacks and Bun's source and
  bytecode reports never enter logs or durable storage.
- Log only identifier-shaped function names, numeric lines and paths relative
  to the repository under `src/`, `scripts/` or `.next/server/`. Reject
  external paths, dependency paths, URL parameters, native/eval frames and
  dynamic text names. Compiled production frames can name a generated chunk
  and its generated line; keep the serving revision to resolve that location.
- A qualifying gap or a window longer than 5.25 seconds imposes a one-minute
  cooldown before the next collection, bounded by expiry. Collection, conversion
  and setting/ledger work use the monitor phases `loop-profiler.collect`,
  `loop-profiler.trim` and `loop-profiler.settings`.

The bounded conversion limits JavaScript work and retained output; it cannot
retroactively limit Bun's collection or report conversion. A window covers all
samples in its interval, so self/total weights describe the whole window rather
than precisely isolating one gap when other work ran in the same window.

### Verification of the serving path

In a scratch export, isolate HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR,
unset LLV_STATE_OWNER, and set the Viewer control URL to a closed port. Use the
installed gate wrapper serially. The focused test command is:

```sh
bash "$GATE" bun test ./src/lib/loopProfiler.test.ts ./src/lib/viewerLoopMonitor.test.ts
```

The native fixture starts the real serving recorder, drives a three-second CPU
block on its Bun main thread and checks its original loop-gap record for the
function, repository file, line and self/total samples. It disables the real
setting at the first captured record. Fresh-process tests share only their own
isolated ledger to prove a restart cannot renew admission and a runtime-host
caller cannot claim it. Deterministic clock/collector controls cover healthy
discard, overlapping gaps, timer ordering, expiry, boundary disable, cooldown,
privacy filtering, output limits and capture/conversion failures.

The final Next production build and its served Viewer rehearsal passed under
Bun 1.4.0. The compiled-path control is available after building:

```sh
bash "$GATE" bun src/lib/loopProfiler.fixture.ts native-compiled
```

Use a fresh isolated state directory for each native fixture run, since it
consumes the same deploy admission as serving code. The compiled fixture loads
Next's instrumentation entry and chunk definitions, then invokes the emitted
serving recorder export. It exercises the actual emitted `import("bun:jsc")`
and the native profile conversion. Its three-second gap had **295 of 297**
samples naming `syntheticThreeSecondBlock` in `src/lib/loopProfiler.fixture.ts:10`
on the same sequence-1 loop-gap record. The retained profile occupied **660
UTF-8 bytes**. It disabled the real setting at that first record and returned.

The separate runtime-host rehearsal, using `scripts/verify-runtime-host.ts`
under Bun 1.4.0, passed: two isolated host generations completed succession in
**506 ms**, with **27/27** listener and **27/27** runtime-socket answers during
a fifteen-second hold. Both endpoints survived abandoned callers. These were
disposable host generations, never the operator's stable listener. The record
and final implementation source hashes are in
`evidence/loop-profiler-spike/serving.json`. The post-deploy pause audit remains
the check of whether the production attribution names the observed CPU owner.

The final isolated full touched-tests gate selected four explicit files and
reported a green head with no new failures; no baseline sample was needed:

```sh
bash "$GATE" bun scripts/local-gate-tests.ts \
  --base f69ba98f92fcd84743c9570ca7a2ba011b474742 \
  ./scripts/probe-loop-profiler.test.ts ./src/lib/loopProfiler.test.ts \
  ./src/lib/viewerInstrumentation.test.ts ./src/lib/viewerLoopMonitor.test.ts
bash "$GATE" ./node_modules/.bin/tsc --noEmit
```

Full typecheck and ESLint on the six changed implementation/fixture/test files
passed. The checks in `serving.json` record the commands. Viewer verification
loaded **28/28** compiled server modules and received **HTTP 200** for `GET /`.
