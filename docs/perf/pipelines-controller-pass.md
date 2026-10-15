# Pipelines controller pass: production audit, 2026-10-15

The controller has an expensive ownership check inside its Git-wait watchdog.
`settlePendingStageGit` installs a 50 ms timer whose predicate calls
`loadPipelines()` and rebuilds the other lanes’ branch-ownership fence. Each
call makes independent mutable copies of the entire hot collection, including
settled history. `commitAndAdoptStageBranch` repeats this work before Git
commands. A long asynchronous Git operation therefore keeps substantial
synchronous allocation work running on the Viewer main thread for its whole
lifetime. The controller’s phase deadline leaves that operation running.

This mechanism is reproduced and CPU-profiled on a private production-state
copy. Holding one stubbed Git reply for 10 seconds made the main thread spend
about 99% of that interval on CPU. A scratch experiment using the same ownership
fields removed most of that CPU cost while retaining the same replay decisions.
The experiment is a design check. This read-only stage changes only this report;
implementation and production verification remain subsequent work.

Production evidence supports this mechanism as a contributor to the incident.
The permitted observation cannot identify the exact Git command or hook awaited
by the historical 135-second pass, or assign every production loop gap to it.
Those limits matter: pending operation duration includes external waits and
scheduling delay, and the production sampler classified most CPU as uncovered.

All times below are UTC on 2026-10-15. Source references name
`e3dad062c8f3a18c710b7f37317ac8f4826b077f`, the supplied main revision.
`git diff 8f2db43e573e HEAD -- src/lib/pipelines/engine.ts
src/lib/pipelines/store.ts src/lib/pipelines/controller.ts
src/lib/state/sqliteStateStore.ts src/lib/pipelines/stageBranch.ts` is empty.
These paths therefore also describe the serving `8f2db43e573e` release. The one
intervening first-parent commit changes Codex history paging.

## Evidence and boundaries

| Evidence | Command or query, time bounds, and result |
| --- | --- |
| E1: production journal | `rtk proxy journalctl --user -u delegatus.service --utc -o json --all --since '2026-10-15 10:07:00 UTC' --until '2026-10-15 10:25:00 UTC' --no-pager`. Retained privately as `evidence/journal-100700-102500.jsonl`, 10,892,891 bytes. Count and time loop gaps using their embedded `role` and `utc`; retain the journal receipt timestamp separately. The service’s journal PID is the launcher; JSON `pid` identifies Viewer 2244742 and runtime host 2244659. `--all` is necessary: the first query without it omitted MESSAGE on 409 large entries. That incomplete query was replaced before analysis. |
| E2: process identification | At 10:25:12–10:25:50, `systemctl --user show delegatus.service -p MainPID -p ExecMainStartTimestamp -p ControlGroup`, then read that group’s `cgroup.procs` and each listed `/proc/<pid>/cmdline`. The Viewer runs Next under Bun from release `8f2db43e573e`; MainPID 2970613 identifies the stable launcher. No process was signalled. |
| E3: passive main-thread sample | Python read `/proc/2244742/task/2244742/stat` and `io`, plus `/proc/2244742/status`, every 100 ms, 301 observations at 10:25:50.390397–10:26:20.592271. Compute CPU from main-thread utime+stime deltas, `os.sysconf('SC_CLK_TCK')`, and monotonic elapsed time. Retained in `evidence/proc-sample.json`. The measured interval between first and last observations is 30.101464 s; CPU 98.799%; rchar delta 7,510,356,368 bytes; 1,891,895 read syscalls; RSS range 4,649,132–5,937,056 KiB. rchar counts bytes returned by syscalls, including cached reads; it measures no physical-disk throughput. |
| E4: state reference | Locate the source through `/proc/2244742/fd/19`; Python `sqlite3.connect('file:'+source+'?mode=ro', uri=True)`, `PRAGMA query_only=ON`, then `source.backup(destination, pages=256, sleep=.005)`, 10:26:11.087651–10:26:11.383690. Reference `state.sqlite`: 161,460,224 bytes; SHA-256 `df05e55a2370fb31368b97a116b5c15ef6fc1cc5b21c462eeb01ef9aa465ae1e`. |
| E5: registry reference | Same read-only backup method, source resolved through `/proc/2244742/fd/45`, 10:27:35.791196–10:27:36.379049. Reference `agent-registry.sqlite`: 428,859,392 bytes; SHA-256 `4667570b61a1161d15a38d82a30b3942d8e946f472e5be6911e52da371bec016`. These two backups have separate capture times; they are not an atomic cross-store snapshot. Auxiliary copies contain only project aliases and the worktree map. |
| E6: source inspection | `rtk proxy git rev-parse HEAD`; `rtk proxy git log -5 --format='%h %s'`; the diff above; `rtk proxy nl -ba <source-path>` and the referenced line intervals, 10:24–10:35. Dependency sharing uses the release’s node_modules only after byte equality of package.json, bun.lock, and both patch files. The parent working checkout’s dependency inputs differed and were rejected. |
| E7: replay | In an immutable scratch export, with Bun 1.4.0: `bash "$SERVING_RELEASE/scripts/gate-slot.sh" "$BUN" --cpu-prof --cpu-prof-dir="$RUN/profiles" --cpu-prof-name=replay.cpuprofile "$EXPORT/replay.ts"`. Each process has a fresh private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR under `/tmp`; `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. The supplied serving-release gate serializes every heavy trial. Trial times and measurements follow below. |
| E8: access limit | Reading `/proc/2244742/task/2244742/syscall` at about 10:29Z returned `Operation not permitted`; `wchan` returned 0 and schedstat was readable. No ptrace attachment, signal, profiler, request, restart, deployment or runtime mutation was attempted against production. |

Each reference file is chmod 0400 and remains unchanged. Every replay receives
its own writable database copies. Source connections are explicitly read-only;
no live WAL or SHM file is copied independently. The copied state had zero
`state_leases` rows. The launcher clears only scratch lease rows before replay.
The reference pipeline payloads, their ordering and history are identical for
all treatments.

The replay uses the real engine, state collection, decoders, mutation logic and
copied registry. External Git returns a fixed unavailable result; one selected
`git branch --show-current` reply in stage-branch settlement has a requested timer delay of
10,000 ms. Runtime activity remains unknown, transcript evidence is
unavailable, structured delivery is unbound, and CPU-admission actuation is
stubbed. No live transcript or repository command is replayed. Spawn, signal,
network and filesystem writes outside the private run directory are guarded;
recorded refusal counts are empty in successful trials. This isolates
controller overhead during an external wait. It does not replay live agents,
forge responses, a real publication hook, or simultaneous production writers.

Prior-work searches at 10:24–10:33 used project-scoped
`pipelines controller phase deadline`, `"controller.pipelines" CPU`,
`"pipeline_controller_work" performance`, and `"ownership" "fence" "performance"`,
then unscoped `pipeline evidence repeated decoding` and `"loadPipelines" "50"`.
The search tool ignored common terms in several queries; its interpreted query
was checked. The relevant architect transcript was opened through
`conversation_messages`: its last answer at 2026-10-14T23:43:16.106Z warned that
pending-operation attribution is circumstantial and identified earlier whole
pipeline-evidence reads. Current compact evidence code supersedes that old
per-poll full-read explanation. No prior answer to the 50 ms ownership-copy
mechanism was found. Memory searches for pipeline-controller performance,
SQLite full decoding, controller caches and stage-branch ownership returned no
hits. Code references below establish the current behavior independently.

## Captured workload and production observations

The census queries run only on E4, with a read-only connection:

```sql
SELECT collection, count(*), sum(length(CAST(value_json AS BLOB))) AS utf8_bytes
FROM state_rows WHERE collection IN ('pipelines','pipelines_archive')
GROUP BY collection;
SELECT controller_active, count(*), sum(length(CAST(value_json AS BLOB)))
FROM state_rows WHERE collection='pipelines' GROUP BY controller_active;
SELECT json_extract(value_json,'$.state'),
       json_extract(value_json,'$.cursor.state'), count(*)
FROM state_rows WHERE collection='pipelines' GROUP BY 1,2;
SELECT kind, count(*), sum(length(CAST(r.value_json AS BLOB)))
FROM pipeline_controller_work w JOIN state_rows r
ON r.collection='pipelines' AND r.row_key=w.row_key GROUP BY kind;
```

| Population at capture | Rows | UTF-8 payload bytes |
| --- | ---: | ---: |
| Hot pipelines, all states | 267 | 36,917,194 |
| Controller-active hot rows | 15 | 1,777,576 |
| Settled hot rows, controller_active=0 | 252 | 35,139,618 |
| Archive | 674 | 88,008,813 |
| Indexed hosts candidates | 12 | 1,307,842 |
| Indexed running candidates | 7 | 498,042 |
| Indexed closed-launch candidates | 12 | 1,686,218 |

Hot state counts are 223 completed, 29 closed, seven running, five awaiting a
decision and three paused. The archive contains 549 completed and 125 closed
lanes. There are 1,392 hot attempts across 1,006 runs and 3,378 archived attempts
across 2,105 runs, counted with `json_each(value_json,'$.runs')` followed by
`json_each(run.value,'$.attempts')`. One running lane has a committing cursor;
its original SQL payload is 106,597 characters. No captured delivery operation
is running or pending. These are capture-time counts, about four minutes after
the incident window, and they cannot reconstruct earlier state transitions.

E1 contains 390 Viewer gaps in 10:07–10:25Z: maximum 27,603 ms, median 796 ms,
p95 4,879 ms. The narrower 10:16–10:22Z window has 133 gaps, maximum 15,633 ms,
median 724 ms, p95 4,531 ms. There are 12 pipelines-phase deadline messages,
45 runtime request timeouts and 15 queue-drain failures over the full bounds.
Timeout methods are append 21, session-read 7, effect-batch 6, wait 6,
operation-status 4 and command 1. At 10:22:01.764Z the runtime-host summary’s
request recorder has dropped 12,886 records. That field counts diagnostic
recorder overflow; it does not establish that 12,886 RPCs were rejected.

At 10:21:46.161Z, `controller.pipelines` has durationMs 135,521 and
completed:false. Matching the same operation by `tick-durationMs` gives an
approximate start of 10:19:30.640Z. Forty-six gap records overlap that pass;
the first and last are 10:19:32.055 and 10:21:46.161. Their scheduler observations
contain 81,826 ms of main-thread run time and 5,391,633,684 rchar bytes, covering
only the sampled windows. Of 868 reported site samples, 855 are
`unknown-runtime-or-native`. Earlier and later records show other passes
reaching 131,889 and 102,128 ms. A new pass is already present at 10:21:49.453Z.

Across all gaps, 6,930 of 7,030 watchdog site samples are uncovered. Logged
synchronous collection checkpoints peak at 6.88 ms and state-write-wait slices
at 18.80 ms in the retained gap records. Registry snapshot slices reach
302.12 ms. These are partial observations with overlaps and recorder retention
limits; summing nested slices cannot produce a complete exclusive CPU split.
Neither the journal nor /proc identifies the historical awaited Git command.
The controlled profile below supplies causal evidence for a concrete uncovered
main-thread path. Its warm read volume is much lower than production E3, so it
does not explain all of the production syscall traffic. No historical browser
poll count, writer rate or matching agent-population sample was collected;
the brief’s co-resident load remains context from the operator’s observation.

## Work done by a pass

| Path and source | Work and execution context |
| --- | --- |
| `controller.ts:169–230`, `:299–343`, `:384–400` | Signals coalesce and a 30 s watchdog wakes the controller. A cycle permits up to eight passes. Each pass awaits pipelines, then the first complete scan and flows. A complete scan itself requests another pass. The 15 s phase deadline is a Promise.race; it logs and releases the cycle without cancelling the original promise. The active-phase map prevents another pipelines operation from replacing that pending operation. All orchestration runs in the Viewer. |
| `engine.ts:9914–10017` | Reentry guard, stale-flow cleanup, CPU queue reconciliation, indexed admission, at most 16 legacy publication admissions, queued creations, remote-action/provenance settlement and provisioning. These are awaited in order. The admission timer continues polling while a commit/publication is outstanding. Their store work executes on the Viewer; subprocess and runtime waits suspend it. |
| `engine.ts:10019–10080`, `:8330–8352` | Four hosts selections occurred per replay pass: stage-branch protection, launch recovery, ingress and runtime switches. Protection/ingress issue Git or forge reads outside the mutation lease. Running publication reservations reconcile before the lease. Closed-launch repair consults receipts only for its indexed candidates. The captured corpus selected no remote actions, publication or provisioning work. |
| `sqliteStateStore.ts:1240–1266`, `pipelineControllerIndex.ts:5–31` | Each selection joins the indexed kind to state_rows, reads pages of 16, validates/revives and clones matching payloads. It does not share decoded rows with another selection of the same kind. The hosts set alone returned 48 rows across four calls in the baseline. Decoding and cloning execute synchronously on the Viewer between cooperative yields. |
| `store.ts:1445–1453`, `:1605–1611`; `sqliteStateStore.ts:1820–1875`, `:1960–2006` | Main reconciliation reads 15 controller-active rows, caches unchanged decoded versions, copies mutable records, and rechecks row revisions before effects and short checkpoint commits. The main lane loop at `engine.ts:10083–10197` visits all selected lanes: abandoned launches, embedded flows, adoptions, historical attempts, identities, parked retries and host cleanup, followed by ordinary progression. It yields after four lanes or 16 ms. A single callback can exceed that budget. |
| `engine.ts:9747–9854`, `:4607–4631`; `stageBranch.ts:14–19`, `:57–114` | Git settlement scans running candidates. For the committing lane, it snapshots every hot lane to establish ownership, snapshots them again in `matches`, and repeats matches every 50 ms and before commands. Writable-stage branch adoption takes another whole snapshot and checks the ownership fence before its commands. `store.ts:1052–1057`, `:1380–1382`, `sqliteStateStore.ts:1194–1195` synchronously clone every returned pipeline, including nested attempt outputs. This work runs on the Viewer and carries no enclosing synchronous attribution span. |
| `stageBranch.ts:88–114` | Branch adoption resolves Git common directories for other lanes whose literal repo/worktree/delivery repository does not already match. Applying that exact predicate to the captured committing lane leaves 109 of its 266 peers, including 103 terminal lanes: up to 218 extra common-directory Git probes, plus the owner’s probes. This command count is a source-derived upper bound for reaching that branch, not an observed production command trace. Each command also crosses the expensive ownership guards. |
| `engine.ts:10200–10236` | After reconciliation: stage Git, runtime switches, activations, pending publications, and up to three recursive publication settlement passes. Finally `loadPipelinesAsync()` loads/copies all 267 hot lanes for the returned snapshot and follow-up test. A stale-snapshot catch also returns a full snapshot. The phase controller uses only changed, yet pays for that full return. |
| `controller.ts:235–258`, `:286–297`; `forge/sweep.ts:93–112`, `forge/autoMerge.ts:883` | Hourly archive sweep, forge refresh, auto-merge and spawn notices start after the cycle. Forge demand and auto-merge have further full loadPipelines calls. Their asynchronous Git/network work is outside the awaited pipelines phase, while their synchronous preparation still shares its event loop. They were excluded from the replay and their exclusive incident CPU was not measured. |
| `store.ts:1109–1168`, `:1197–1212` | Health/ownership evidence uses the deployed compact evidence cache and revision tracking. Full startup evidence may visit both collections, totalling 124,926,007 UTF-8 bytes here. The ordinary tick’s indexed selection and final snapshot target the hot collection. The archive is not traversed for every tick. |

`realExec` at `workflows/provision.ts:46–53` uses an asynchronous spawned child.
The child’s Git or hook CPU runs elsewhere. The timer callbacks, row decoding,
fence construction, structuredClone, JSON comparisons, registry reads and
checkpoint continuations run on the Viewer’s main thread. Releasing the mutation
lease before Git prevents lease contention and still leaves these synchronous
callbacks in the Viewer.

The existing four-lane yield cannot bound a loop that runs outside that loop.
A timer with a 50 ms interval can also have a callback longer than its interval.
For the 36.92 MB hot corpus, 20 checks/s expose roughly 738 MB/s of logical
source payload to full copying before counting the clone’s object overhead,
extra guards per command, retained snapshots or garbage collection. The observed
rate falls when the callback itself takes longer than 50 ms.

A phase can remain outstanding for minutes because stage commit permits a
15-minute hook operation (`git.ts:47`, `:795–801`), settlement awaits Git and
publication sequentially, and the 15 s outer deadline leaves that work alive.
CPU-admission work and other Viewer operations continue concurrently. During
such waits, the ownership timer converts the wait’s duration into repeated
whole-history copying. Ordinary lane selection alone cannot explain the
measured CPU: the no-delay replay completes its first pass in 1.554 s and the
next two in 189 and 180 ms.

## Measured split and CPU profile

The first no-delay replay ran 10:28:30.737–10:28:32.721. Its first pass included
337.7 ms in the first registry snapshot, 128.4 ms in controller reconciliation,
70.7 ms in the final async whole-hot snapshot and 46.7 ms across the four hosts
selections. Other stage-settlement work accounts for much of the remainder.
Those spans overlap; they are not additive exclusive buckets. Later passes
still spend 61–69 ms on the final snapshot, 56–66 ms in reconciliation and about
29 ms on repeated hosts selections.

In `delayed-before-1`, 10:29:40.459–10:29:52.120, a single 10 s external wait
produced an 11.641 s pass, 11.587 s user CPU and 1.034 s system CPU across the
Bun process’s threads. There were 171 synchronous pipeline snapshots, copying
45,657 lane records; their summed enclosing time was 10.227 s and their largest
single call was 189.45 ms. The profile includes this first pass and the next
two no-delay passes: 11,085 samples over 12.258 s. Categorizing each sample by
its stack, with exclusive category priority, gives:

| Profile stack category | Samples | Share |
| --- | ---: | ---: |
| `matches` ownership validation in engine.ts | 9,301 | 83.91% |
| Other pipeline-copy paths | 362 | 3.27% |
| Other stageBranch paths | 122 | 1.10% |
| Registry paths | 408 | 3.68% |
| Remaining work, runtime and instrumentation | 892 | 8.05% |

The leaf function is `structuredClone` in 8,857 samples, 79.90% of all samples;
this overlaps the stack categories. Allocation/GC/native costs that the sampler
cannot name stay in the remaining category. No production CPU profile was taken.
The raw profile is retained privately at
`$AUDIT_ROOT/delayed-before-1/profiles/replay.cpuprofile` (552,202 bytes).
Additional profiles sit beside every successful replay’s result.json. These
profiles contain private paths and remain outside repository outputs.

A second preliminary delayed baseline at 10:31:25.355–10:31:40.030 had a
13.899 s first pass, 83 full snapshots taking 11.014 s and a maximum snapshot
call of 511.36 ms. The slower callback reduced timer frequency. This variation
is why the controlled paired trials below retain each measurement.

The scratch projection retains the fields the ownership fence actually reads,
with a database generation and a bounded per-owner fence cache. It replaces the
two full ownership-fence reads in settlement and the full-record supplier used
by stage-branch adoption. It leaves final result materialization, ordinary
reconciliation, Git return values and the 10 s wait intact. The experimental
projection invalidates conservatively on every pipeline update; the production
design below can narrow that to actual authority changes.

The following trials alternate baseline and projection on fresh identical copies.
Each first pass contains one 10 s Git wait, followed by two no-delay passes.
CPU is **main-thread CPU during the wait**, measured with /proc thread ticks
(100 Hz). Timer delay is from a 10 ms interval, measured within that wait.
It is an observed delay, not an exhaustive bound on all synchronous work.

| Treatment | First pass UTC bounds | Pass wall (s) | Main CPU during wait | Max wait timer delay (ms) | Full sync snapshots | Max full snapshot call (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| measured-before-1 | 10:33:11.069–10:33:23.014 | 11.926 | 99.11% | 130.04 | 131 | 220.61 |
| measured-after-1 | 10:33:37.224–10:33:48.560 | 11.316 | 4.10% | 6.45 | 0 | 0.00 |
| measured-before-2 | 10:33:57.593–10:34:09.302 | 11.688 | 99.33% | 83.62 | 161 | 196.58 |
| measured-after-2 | 10:34:10.753–10:34:22.028 | 11.255 | 4.10% | 5.94 | 0 | 0.00 |
| measured-before-3 | 10:34:23.345–10:34:35.517 | 12.151 | 99.33% | 101.19 | 166 | 325.08 |
| measured-after-3 | 10:34:38.940–10:34:50.156 | 11.196 | 4.00% | 4.96 | 0 | 0.00 |

Median main-thread CPU during the external wait is 99.33% before and 4.10%
with the projection; median maximum timer delay is 101.19 ms and 5.94 ms.
Median whole-pass wall time is 11.926 s and 11.255 s. The external wait remains
part of the pass in both treatments: this experiment removes CPU amplification
without implementing job separation. Across the three first passes, the old path
copies 34,977–44,322 lane records through its 131–166 synchronous snapshots.
The projected ownership path performs zero such full snapshots. It still returns
the full 267-lane async snapshot and copies mutable lanes for actual mutation.

Whole-pass maximum timer delays remain 518–654 ms before and 506–582 ms
with the projection, including cold registry and task-note work. The largest
measured synchronous full-snapshot calls are 197–325 ms before. Removing that
particular operation does not establish a bound for the entire main thread.
The next two no-delay passes range from 177–225 ms before and 175–196 ms with
the projection. They follow a mutated scratch state and are described as
subsequent passes, without a steady-state claim. Resource pressure from other
host workloads was uncontrolled; the same shared gate and process limits apply
to every trial. Each treatment repeats the same imposed I/O load.

All six runs finish without replay errors. Comparing `SELECT collection,
row_key,value_json FROM state_rows WHERE collection IN ('pipelines',
'pipelines_archive') ORDER BY collection,row_key`, after JSON normalization,
finds zero differing pipeline records across all six copies. The three projected
runs also match the original ownership fence for all 267 owners after replay.
The raw samples are retained at `$AUDIT_ROOT/measured-{before,after}-{1,2,3}/`
and the numeric comparison at `evidence/paired-results.json`.

These equivalence checks cover the recorded stubbed inputs. They do not prove
equivalent behavior for every concurrent ownership change, real Git result or
live runtime event. The private artifact root’s basename is
`pipelines-controller-audit-lq8kk9cv`, below the OS temp root; `$AUDIT_ROOT`
throughout this report refers to it. It retains the immutable source exports,
replay.ts drivers, Python launchers, JSON measurements, journals and profiles.
The baseline runs use `measured-baseline`; the experimental runs use
`measured-projected`. `launch_projected.py` creates each isolated working copy,
and `run_pairs.py` records the sequential pair order. The reference files’
checksums were rechecked at 10:38Z and still match E4/E5.

One early projected trial failed after 1.025 s with a UNIQUE constraint error in
the experiment’s projection trigger. Its result/profile is retained as
`projected-1` and excluded from comparisons. The trigger was corrected to use
explicit UPSERT before subsequent trials. Successful trials record no replay
exception or guarded external action.

## Fix design and verification

1. Add a minimal persisted branch-authority projection, owned by the state store,
   updated atomically with pipeline payload changes, inserts, deletions, archive
   moves and replacements. Store the exact fields used by the existing fence:
   lane id, repo/worktree, branch, delivery target, active/owner/epoch/publish and
   terminal status. Preserve unresolved repository relationships and terminal
   claims that still own a delivery target. Validate the projection against full
   records and retain the existing fail-closed checks. Startup must adopt a
   validated persisted projection; perform any large rebuild outside the Viewer
   main loop under the release fence.
2. Revalidate the current lane by keyed row revision and branch authority by a
   projection generation. A progress-only write must leave the authority
   generation unchanged. A peer claim change must invalidate before the next
   command and final adoption. Prepare relevant conflict candidates once per
   authority change, with persisted Git common-directory evidence where valid.
   Cache ownership answers under one owner, explicit byte/entry limits and LRU
   eviction. The 50 ms check should inspect compact generations; it must never
   load or clone all pipeline payloads. Apply the same interface inside
   commitAndAdoptStageBranch and audit auto-merge’s similar full-load guards.
3. Separate stage Git/publication jobs from tick completion. Persist intent,
   run the fenced operation in an owned worker/child, and checkpoint its result
   by lane/row/attempt/ownership revision. A tick reserves or observes the job
   and returns. Keep idempotency, index custody, publication locks, remote-outcome
   uncertainty and process cleanup exactly as today. Preserve per-lane ordering
   while other lanes progress. A phase timeout must not abandon a job’s effects
   or launch a second writer. Awaited hook duration can remain minutes without
   a controller pass spanning those minutes.
4. Schedule controller obligations from row changes plus due deadlines, with a
   durable cursor or bounded dirty set and a fair fallback scan. Include startup
   reconstruction, peer/raw-SQL commits, report/provenance, host/runtime events,
   account resets, retry times, CPU admission and unfinished close/reap work.
   Process a bounded number of lane/attempt obligations and yield with
   setImmediate between slices; many resolved awaits alone do not yield to I/O.
   Settled closed/completed lanes require no ordinary reconciliation. Paused,
   parked or terminal lanes with an outstanding obligation must still run that
   obligation. Bound attempts inside a large lane as well as lanes per tick.
5. Add a controller-only result shape containing changed/pending-work evidence;
   avoid constructing the whole-hot returned snapshot on the internal path.
   Preserve the existing full result for callers that request it. Share keyed,
   immutable decoded candidates across selectors by row revision and authority;
   detach only lanes being changed. Keep cache bounds from the deployed cache
   work. Never fix this by enlarging an unbounded history cache.
6. Give synchronous ownership, copying, task-note preparation and lane slices
   static monitoring labels and origins. Measure successful durable lease
   acquisition through release, external job wait, job CPU, and Viewer
   continuation separately. Keep monitor overflow explicit. The cold registry
   snapshot and synchronous task-note mutation remain measurable follow-up
   costs; the projection experiment alone does not meet the main-loop bound.

Before/after method for the implementation stage:

- Reuse E4/E5 unchanged and start each revision in a separate scratch export with
  the same Bun, dependency inputs, environment, gate quota, private state, fixed
  clock, stub responses and delayed-command sequence. Retain source hashes and
  per-run bounds. Alternate baseline and candidate at least three times. Report
  cold initialization separately from subsequent passes; let deferred readiness
  settle before calling a run steady-state. Keep failed and partial runs.
- Replay unchanged history, one dirty lane, many dirty lanes, one large-attempt
  lane, paused/terminal obligations and simultaneous peer updates. Compare full
  authoritative decisions, emitted operations, ordering, idempotency keys and
  refusal behavior against the old engine. Ownership cases must cover claim
  acquisition/release, branch or repository changes, same-repository aliases,
  uncertain common directories, deletion/archival and a peer write while Git is
  outstanding. Include a progress-only peer write that leaves authority intact.
- Measure pass wall time, Viewer main-thread utime/stime, logical read bytes,
  decoded/cloned rows and bytes, maximum labelled synchronous slice and timer
  delay. Record external wait separately, including a deliberately long hook
  and refused, interrupted and uncertain outcomes. The candidate pass should
  finish after reservation while the long job remains pending; report job wall
  time separately. Require bounded work and timer delay as retained history
  grows with the dirty count held fixed. Set explicit budgets before claiming
  acceptance; the 16 ms cooperative loop budget is not proof of such a bound.
- Use the existing explicit tests `src/lib/pipelines/engine.controllerSnapshot.test.ts`,
  `src/lib/pipelines/controller.test.ts`, stage-branch and publication tests as
  applicable, each through the supplied gate with isolated roots. Add behavioral
  coverage at the ownership/job boundary. Run the required privacy, touched-test
  and runtime CI gates for the actual implementation. Runtime-host changes also
  require its rehearsal. This documentation-only audit changes no runtime code.
- After an authorized deployment, repeat E1/E3 under normal load. Record live
  agents, dirty/active/terminal lane counts, browser tabs/poll traffic, writer
  rates, co-resident workers, CPU quota/throttling and memory pressure beside the
  numbers. Compare equal-length pre/post windows and wait for comparable load.
  Historical gap counts and an idle isolated replay cannot establish a
  production improvement.

## Checks performed

At 10:38:06.739321–10:38:06.944265, the local privacy gate passed for this
explicit document path, with committed known-value fingerprints:

```sh
LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE="$REPO/scripts/privacy-known-value-fingerprints.json" \
  "$BUN" "$EXPORT/scripts/privacy-publication-gate.ts" \
  --require-known-values --repository "$REPO" \
  --paths "$REPO/docs/perf/pipelines-controller-pass.md"
```

The final document is checked again after recording these results. The two
explicit existing test files were run separately with fresh isolated HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, the closed-port control URL, and
`bash "$SERVING_RELEASE/scripts/gate-slot.sh" "$BUN" test <explicit-file>`:

| File | UTC command bounds, including admission | Result |
| --- | --- | --- |
| src/lib/pipelines/controller.test.ts | 10:38:20.390066–10:38:24.937226 | 9 pass, 0 fail; execution 328 ms |
| src/lib/pipelines/engine.controllerSnapshot.test.ts | 10:38:24.937791–10:38:28.285616 | 2 pass, 0 fail; execution 1,124 ms |

An initial combined invocation at 10:37:45.212641–10:37:46.717369 reported
11 pass and 0 fail, but logged archive-sweep failures with a missing state_leases
table after the other file’s cleanup. Both files were therefore repeated in
separate processes and roots; the separate runs show no such archive errors.
No test assertion was changed. These tests establish the current controller’s
baseline fences, including refusal of a stale evidence reply; they do not test
a production implementation of the proposed design. `git diff --check` passes,
and `git status --short --ignored` shows only the declared untracked report.
No test, build, cache or dependency output was written into the worktree.

No signal, restart, deployment, mutating production request, commit or staged
change was made. The other fenced lanes’ files are untouched. The unavailable
historical command trace and production CPU attribution remain explicit limits;
the profile proves the ownership-polling defect with the captured corpus and
controlled wait, and the follow-up design preserves its decision fences.
