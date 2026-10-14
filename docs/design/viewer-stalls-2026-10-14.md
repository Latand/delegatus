# Viewer stalls: production measurement and isolated replay, 2026-10-14

**Measurement complete under the operator's replay decision. Release acceptance
still fails.** The retained production window contains 147 loop gaps above one
second, a maximum gap of 37,306 ms, seven pipeline deadlines, one scan deadline
and five runtime request timeouts. Production directly measures synchronous
registry admission at 754.7/606.9 ms and host snapshot collection at 257.4 ms.

The continuation profiles the deployed `cd0aec82` source and production build
against one SQLite backup set. It demonstrates expensive curation history
cloning, startup integrity checks and synchronous state work. The largest live
35–37 second gaps remain unattributed to a particular exclusive stack. The
operator explicitly accepted that production attribution gap and authorized this
replay; these results support a measured fix plan and the next build stage.
They do not establish release acceptance.

All times are UTC on 2026-10-14. The earlier attempt used the service journal,
`/proc`, cgroup counters, socket inventory, deployed source and a read-only SQL
aggregate. The continuation took the authorized backups and created only owned
scratch processes and files. No live Viewer or runtime-host HTTP/RPC measurement probe,
inspector attachment, signal, restart or deployment occurred. The earlier
refused performance-counter probe below was not repeated. Only this declared
repository document changed; nothing was staged, committed or pushed.

## Scope and evidence boundaries

The worktree starts at `d5512b78807ce81d9dad6611a3a19f986b515939`. At
13:31:04Z, the serving Viewer's `/proc/$WEB_PID/cwd` resolves to a release checkout
whose Git head is `cd0aec82a4b4946b42f4d47f84ed5e00487cd2e9`. The runtime host's
command names `src/runtime-host/main.ts` in that same release. The brief dates
deployment to 13:01Z; this stage independently checked the running checkout,
rather than retrieving a deployment receipt.

Byte comparisons at 13:31:04Z, 13:32:53Z and 13:41:57Z found these files
identical between this worktree and the running release: the loop monitor,
blocking-wait recorder, files operator projection, pipeline store/controller,
SQLite state and registry stores, agent registry, runtime client, runtime journal,
runtime socket/handler, runtime entry point, runtime deadlines, files delta,
files response worker, pipeline engine/durable evidence and Git provisioning.
References below use those worktree line numbers. They identify source paths;
the stage did not independently reconstruct the compiled build from its inputs.

The journal records child output under one forwarding process. Its journal PID
does not distinguish the Viewer from the runtime host. Process identity comes
from `/proc` and the call path. In particular, the runtime host inherits
`LLV_STATE_OWNER=launcher`: `src/runtime-host/main.ts:15` sets its owner only when
unset. Consequently, its `snapshot-collect` record says `role:"launcher"`.
`blockingWaitRole()` reads that environment variable at
`src/lib/blockingWaits.ts:80`; it does not independently identify a process.

The socket inventory at approximately 13:30:36Z associates the installation's
TCP listener on 8898 with the Viewer. The runtime host is a separate process
serving its internal RPC socket. Neither process was attached to a debugger.

Evidence commands use `$WEB_PID`, `$RUNTIME_PID`, `$LIVE_STATE`, `$RELEASE` and
`$OUTPUT` in place of private installation values. `$OUTPUT` means this report's
repository-relative path. No account, conversation, pipeline or operation
identity is needed to reproduce the aggregate observations.

## Production window and exact journal evidence

E1 is the service journal read at 13:32:53Z for **13:02:00–13:32:00Z**, using:

```sh
rtk proxy journalctl --user -u delegatus.service \
  --since '2026-10-14 13:02:00 UTC' --until '2026-10-14 13:32:00 UTC' \
  -o json --no-pager
```

The aggregation tests `MESSAGE` for the literal markers below. A loop-gap
record's JSON `gapMs` determines the one-second count. Journal microseconds in
`__REALTIME_TIMESTAMP` determine the displayed UTC times. These are recorded
warnings, with overlapping operations and waits; their counts are not counts of
distinct outages or completed requests.

| Marker or condition | Count |
| --- | ---: |
| `[viewer loop-gap]` | 278 |
| Loop gaps strictly above 1,000 ms | 147 |
| `pipelines phase exceeded its deadline` | 7 |
| `scan phase exceeded its deadline` | 1 |
| Runtime `request timed out` | 5: three snapshots, one session-read, one operation-status |
| `[state lease-hold]` | 0 |
| `[blocking-wait]` | 146 |

The 146 blocking-wait records contain 139 asynchronous snapshot transfers, one
asynchronous registry lock wait, two synchronous registry lock waits, three
synchronous revision retries and one synchronous snapshot collection. No
`snapshot-serialize`, `snapshot-parse` or `state-lease` warning appears. That is
thresholded evidence: `src/lib/blockingWaits.ts:68` sets the logging threshold to
250 ms. Failed requests may never reach the successful parse measurement, and
the encoded snapshot path has different coverage.

For comparison, the exact **13:02:00–13:27:00Z** read contains 231 loop-gap
records, 122 gaps above one second, six pipeline deadlines, one scan deadline,
five runtime timeouts and zero lease-hold records. The brief's seven pipeline
deadlines differ from this explicit 25-minute selection; the complete 30-minute
selection reaches seven at 13:31:45.782Z.

The following lines retain the journal's operation names and measured values.
`operations` is shortened to the relevant entries where indicated; null
correlation fields are omitted. Times are journal timestamps.

| UTC | Journal evidence |
| --- | --- |
| 13:07:07.066 | `[blocking-wait] site=registry-lock-async role=viewer durationMs=474.4 synchronous=false subject=agent-registry label="spawn admission"` |
| 13:07:45.151 | `[viewer loop-gap] gapMs=13287`; `files.get durationMs=13349 completed=false`; `controller.pipelines durationMs=13245 completed=true count=2`; `pipelines.controller-mutation durationMs=479 completed=true`. |
| 13:07:45.274 | `[runtime host] request timed out method=session-read elapsedMs=13422` |
| 13:07:45.275 | `[runtime host] request timed out method=operation-status elapsedMs=13331` |
| 13:07:46.910 | `[flow pipeline controller] pipelines phase exceeded its deadline` |
| 13:09:43.940 | `[viewer loop-gap] gapMs=37306`; `controller.pipelines durationMs=39025`; `files.get`, `files.health`, `pipelines.evidence durationMs=37952`; `pipelines.controller-mutation durationMs=37837`. All listed entries have `completed=false`. |
| 13:09:44.181 | `[flow pipeline controller] pipelines phase exceeded its deadline` |
| 13:09:44.272 | `[runtime host] request timed out method=snapshot elapsedMs=38125` |
| 13:09:44.285 | `[runtime host] request timed out method=snapshot elapsedMs=37923` |
| 13:10:22.388 | `[viewer loop-gap] gapMs=35724`; `files.get/files.health durationMs=76401 completed=false`; `pipelines.evidence durationMs=76400 completed=false`; `controller.pipelines durationMs=75797 completed=true`; `pipelines.controller-mutation durationMs=74568 completed=true`; `controller.scan durationMs=38118 completed=false`. |
| 13:10:22.472 | `[flow pipeline controller] scan phase exceeded its deadline` |
| 13:10:22.494 | `[runtime host] request timed out method=snapshot elapsedMs=39052` |
| 13:10:24.463 | `[viewer loop-gap] gapMs=1395`; `files.get/files.health/pipelines.evidence durationMs=78475 completed=false`; `controller.scan durationMs=40193 completed=false`. |
| 13:12:09.663; 13:16:45.170; 13:17:30.660; 13:25:28.042; 13:31:45.782 | `[flow pipeline controller] pipelines phase exceeded its deadline` at each timestamp. |
| 13:21:56.161 | `[blocking-wait] site=snapshot-transfer role=viewer durationMs=9742.2 synchronous=false subject="7731960 bytes"` |
| 13:24:46.621 | `[blocking-wait] site=registry-lock role=viewer durationMs=754.7 synchronous=true subject=j` |
| 13:24:46.622 | `[blocking-wait] site=registry-revision-retry role=viewer durationMs=756.3 synchronous=true subject=j` |
| 13:27:41.619 | `[blocking-wait] site=snapshot-collect role=launcher durationMs=257.4 synchronous=true subject=runtime-journal`; embedded `at=13:27:41.618Z`. |
| 13:28:14.219 | `[blocking-wait] site=registry-revision-retry role=viewer durationMs=369.5 synchronous=true subject=L` |
| 13:28:18.417 | Two `[blocking-wait]` lines: `registry-lock durationMs=606.9` and `registry-revision-retry durationMs=607.8`, both `role=viewer synchronous=true subject=j`. |

## What the timings establish

**Viewer timer starvation is measured; its largest synchronous stack is missing.**
`src/lib/viewerLoopMonitor.ts:16` samples a nominal ten-millisecond timer and
subtracts that interval. At `:21` it collects completed and active operations;
at `:62` it keeps a Promise operation active until its `finally` executes.
An operation's `durationMs` therefore includes asynchronous waits and delays
caused by other callbacks. It supplies no exclusive CPU attribution. A request
that starts immediately before a delayed timer runs can appear with a few
milliseconds of age alongside a multi-second gap.

The two largest missing timer intervals are approximately 13:09:06.624–13:09:43.940Z
and 13:09:46.654–13:10:22.388Z, inferred by subtracting `gapMs + 10` from the
journal time. They establish Viewer scheduling delay. They do not distinguish
JavaScript CPU, garbage collection, synchronous SQLite, filesystem waits or
another synchronous call. Thirty records in the narrower 13:02–13:28Z read have
an empty operation list, showing that the naming coverage is incomplete.

**Runtime timeouts also measure caller delay.** The timeout is a Viewer
`setTimeout` callback at `src/lib/runtime/client.ts:336`. The snapshot deadline
defaults to 30,000 ms (`src/lib/runtime/deadlines.ts:13`, used by the constructor
at `client.ts:177` and the snapshot call at `:197`); callbacks
running at 37,923–39,052 ms demonstrate delayed deadline processing. The
37-second and 35-second Viewer gaps end immediately before those warnings.
Host dispatch, service completion, socket delivery and Viewer callback execution
are not separately timestamped in these failed requests. Host service time
cannot be recovered from their `elapsedMs`.

**Snapshot transfer is an asynchronous interval.** `src/lib/runtime/client.ts:393`
starts it when the first data callback executes; `:406` stops it immediately
before parsing a complete frame. The measured 9,742.2 ms includes pauses between
Viewer data callbacks and transport/backpressure. It excludes the pre-first-byte
wait and does not measure host snapshot assembly. `JSON.parse` at `:402` is
measured separately by `snapshot-parse` at `:407`.

**Lease telemetry has a different boundary.** `pipelines.controller-mutation`
wraps all of `reconcileSnapshot()` at `src/lib/pipelines/store.ts:1516`. The
detached callback runs at `src/lib/state/sqliteStateStore.ts:1549`; only its
checkpoints acquire and release a durable lease at `:1553` and `:1573`. The
74,568 ms operation age is not a lease hold. The lease logger at `:56` emits
only completed pipeline holds above 1,000 ms. Zero warnings supplies no
200 ms upper bound and no proof about a hold still open at a window's end.

## Attributed blocking paths and remaining candidates

| Path | Production measurement | Code and blocking mechanism | Attribution boundary |
| --- | --- | --- | --- |
| Registry writer acquisition and lost-revision retry | E1: 754.7 ms lock within a 756.3 ms retry; another 606.9 ms lock within a 607.8 ms retry. A separate retry takes 369.5 ms. | `src/lib/agent/sqliteRegistryStore.ts:2571` calls `beginMutationWrite()`. At `:2747` it sets SQLite busy timeout to 5 ms, then repeatedly executes synchronous `BEGIN IMMEDIATE` at `:2751` until acquisition or a five-second deadline. There is no event-loop yield between attempts. `:2633` records the lock duration; `:2582` records the enclosing lost attempt. | These synchronous waits block the Viewer directly. Lock and enclosing retry overlap and must not be added. The minified subjects `j` and `L` identify no source-level caller or competing writer. These observations do not account for either 35–37 second gap. |
| Runtime-host snapshot assembly | E1: `snapshot-collect` 257.4 ms at 13:27:41.619Z. | `src/runtime-host/host.ts:146` invokes `snapshotJson()`. `src/runtime-host/journal.ts:1428` times `snapshotAt()`; `:1378` begins its transaction and `:1387`–`:1396` synchronously reads and constructs sessions, attentions, operations, edges, flows, workflows, tasks and deployments. `:1429` separately times serialization. | This stalls the runtime host's RPC dispatch while collection executes. The logged role is explained above. Collection's SQL/decoding/presentation components are not separately measured. No serialization warning reaches 250 ms in E1. This single 257.4 ms observation cannot explain the failed snapshot requests. |
| `files.get` projection and reads | E1: active elapsed age reaches 78,475 ms, overlapping the two largest gaps. Exclusive synchronous cost is **unmeasured**. | Entry: `src/app/api/files/operatorProjection.ts:615`. Awaited scanning at `:630`, worker projection at `:497`, and asynchronous result-file reading at `src/lib/scanner/filesResponseWorker.ts:448` can keep a request open. Synchronous candidates include persisted-body reading/hashing at `operatorProjection.ts:379`, health-overlay parsing at `:577`, health-change serialization/hashing at `:589`, and fallback delta creation at `:536` / `src/lib/filesDelta.ts:154`. Inline projection remains reachable at `operatorProjection.ts:530`. | Request age cannot assign cost to these candidates. Worker builds and delta transport already exist. The investigation did not establish that a fallback ran, or measure any of these functions on live request data. |
| `files.health` and `pipelines.evidence` | E1: both reach 78,475 ms of active age; exclusive synchronous cost is **unmeasured**. | Health entry: `src/app/api/files/operatorProjection.ts:625`; preparation: `src/lib/pipelines/store.ts:1077` and `:1089`. `src/lib/state/sqliteStateStore.ts:934` parses one SQLite row and `:936` validates it, then yields at `:938` once a four-millisecond slice is spent. One SQL iterator step, JSON parse or validation finishes before that yield. Legacy fallback reads remain at `store.ts:1095`. | The current implementation already slices the complete read and shares an in-flight preparation. A long individual row or callback could exceed the slice budget. No per-row or validation timing in E1 establishes that this occurred. The old whole-archive admission mechanism must not be assumed to remain unchanged. |
| `controller.pipelines` and detached reconciliation | E1: phase age reaches 75,797 ms; detached mutation age reaches 74,568 ms. E3: a 2,268 ms gap overlaps these operations without CPU throttling. Exclusive synchronous cost is **unmeasured**. | Phase wrapper: `src/lib/pipelines/controller.ts:312`; deadline race: `:323`. Engine pass: `src/lib/pipelines/engine.ts:9798`. Its initial active-row SQL/decode at `src/lib/state/sqliteStateStore.ts:1653` is synchronous. Durable transcript evidence uses asynchronous reads followed by synchronous line decoding/parsing at `src/lib/pipelines/durableEvidence.ts:619` and `:621`; read/consume loop at `:649`. | A slow asynchronous phase can exceed its deadline while unrelated synchronous work blocks the Viewer. Per-lane cooperation already appears at `engine.ts:9800`. Neither the SQL, transcript parsing nor a specific lane is timed in E1. The broad operation labels cannot choose among these paths. |

## CPU, memory and data-size controls

E2 sampled `/proc/$WEB_PID/stat`, `/proc/$RUNTIME_PID/stat` and each main thread's
`stat` at **13:30:08.949–13:30:18.952Z**, a measured 10.003 seconds. CPU is the
delta of fields 14 and 15 divided by `SC_CLK_TCK` and elapsed monotonic time.
RSS is field 24 times page size. The Viewer used 58.5% CPU, its main thread
43.5%, with RSS 5,107.4→4,988.3 MiB. The runtime host used 19.8%, its main
thread 18.2%, with RSS 473.6→542.8 MiB. This later sample does not measure the
peak incident interval.

E3 repeated those reads once per second for **13:34:37.835–13:34:57.870Z**,
measured 20.034 seconds, and read every own/ancestor cgroup's `cpu.max`,
`cpu.stat`, `memory.max`, `memory.events` and effective CPU set. All available
CPU quota values were `max 100000`; the remaining levels had no quota file.
The effective CPU set was 0–23, memory limits were unlimited, and all sampled
throttled-time and OOM-kill deltas were zero. Historical OOM counters on shared
ancestors were present; they did not increase during this sample.

The Viewer used **99.8% CPU**, with **81.7% on its main thread**, and RSS
5,095.1→5,027.6 MiB. The runtime host used 31.0%, with 26.0% on its main thread,
and RSS 547.2→469.1 MiB. `/proc/stat` deltas show 86.7% aggregate idle plus
iowait across the machine. At 13:34:47.220Z the journal records:

```text
[viewer loop-gap] {"gapMs":2268,"operations":[{"name":"controller.pipelines","durationMs":2944,"completed":false,"count":1},{"name":"pipelines.controller-mutation","durationMs":2744,"completed":false,"count":1},{"name":"files.get","durationMs":10,"completed":false,"count":1}]}
```

The matching E3 journal command uses those exact sample endpoints in `--since`
and `--until`. This proves a multi-second scheduling delay under the observed
unthrottled conditions. It supplies no exclusive function cost or explanation
of the earlier 37-second stall. No host-capacity conclusion follows from CPU
specifications, average utilization or a comparison with an unsampled period.

E4 is a size-only SQL read at **13:35:35.572–13:35:35.593Z**. The first attempted
environment-derived state path was absent at 13:35:19Z. A fresh descriptor
inspection found exactly one `state.sqlite` file open in the Viewer; that file
was opened through Python SQLite with URI `mode=ro`, zero lock timeout,
`PRAGMA query_only=ON`, `BEGIN`, the query below, then `ROLLBACK` and close.

```sql
SELECT collection, COUNT(*), SUM(length(CAST(value_json AS BLOB))),
       MAX(length(CAST(value_json AS BLOB)))
FROM state_rows WHERE collection IN (?, ?) GROUP BY collection;
-- Bound parameters: 'pipelines', 'pipelines_archive'
```

| Collection | Rows | JSON bytes | Largest row, bytes |
| --- | ---: | ---: | ---: |
| pipelines | 258 | 33,995,168 | 917,268 |
| pipelines_archive | 597 | 79,761,275 | 1,409,364 |

Connect, transaction, aggregate query and close together took **19.723 ms** in
the observer. This is a Python SQLite aggregate cost. It excludes JSON decoding,
validation, cloning, the Bun store readers and HTTP, and establishes none of
their costs. At E4, no replay or storage-speed comparison had been performed; the continuation below profiles the deployed code on one captured dataset.

The E3 observer ran as `rtk proxy python3 -u -` with this measurement body
(private PID literals replaced by environment variables). Its printing of CPU
deltas and matching journal lines is described above. E2 ran as
`rtk proxy python3 -` and used two `/proc` samples separated by `time.sleep(10)`.
The filesystem queries in the E3 body were:

```python
import pathlib, time, datetime, os

pids = {"Viewer": int(os.environ["WEB_PID"]),
        "runtime-host": int(os.environ["RUNTIME_PID"])}
hz = os.sysconf("SC_CLK_TCK")

def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds")

def sample():
    out = {"monotonic": time.monotonic(), "at": utc(), "system":
           [int(x) for x in pathlib.Path("/proc/stat").read_text().splitlines()[0].split()[1:]],
           "processes": {}, "cgroups": []}
    for name, pid in pids.items():
        tail = pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        task = pathlib.Path(f"/proc/{pid}/task/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        out["processes"][name] = {
            "cpu": int(tail[11]) + int(tail[12]),
            "main": int(task[11]) + int(task[12]),
            "rssMiB": int(tail[21]) * os.sysconf("SC_PAGE_SIZE") / 2**20}
    c = pathlib.Path(f'/proc/{pids["Viewer"]}/cgroup').read_text().strip().split("::", 1)[1]
    while True:
        root = pathlib.Path("/sys/fs/cgroup" + c)
        out["cgroups"].append({f: (root / f).read_text().strip()
            for f in ("cpu.max", "cpu.stat", "memory.max", "memory.events", "cpuset.cpus.effective")
            if (root / f).exists()})
        if c == "/":
            break
        c = os.path.dirname(c) or "/"
    return out

rows = [sample()]
for _ in range(20):
    time.sleep(1)
    rows.append(sample())
```

## Profiling access and prior answers

E5 attempted the following safe observer command at approximately 13:30:36Z:

```sh
rtk proxy perf stat -e cpu-clock -p "$WEB_PID" -- sleep 1
```

It returned `Access to performance monitoring and observability operations is
limited.` The refusal names `perf_event_paranoid=4`. At 13:33:50Z, fresh reads
confirmed that value and zero effective capabilities for the observer.
`/proc/$WEB_PID/cmdline` has no `--inspect`; its startup environment has no
`BUN_INSPECT`, `BUN_INSPECT_URL` or `NODE_OPTIONS`. The earlier `ss -lntp`
inventory found no Viewer inspector listener. No debugger-enabling signal,
ptrace attachment, capability grant or sysctl change was attempted. `perf` and
`bpftrace` are installed; installation alone supplies no profiling permission.
This failed counter probe produced no CPU profile. Native stack sampling would
also need verified JavaScript/JIT symbolization before assigning source costs.

Prior-context reads ran at approximately 13:29–13:34Z. Project-scoped transcript
queries included `loop-gap blocking-wait`, `Viewer stalls snapshot pipeline`
and `"snapshot-collect" "stall"`; an unscoped query used
`readStateCollectionsRows stalls`. Search interpretation dropped several
frequent terms, so those broad hits were treated as pointers. Relevant hits were
opened with `conversation_messages`: the 2026-10-14 09:03–09:16Z controller
review and the 2026-10-06 17:45–17:57Z registry/watchdog review. The former
measured a lease reduction from 2,652 to 5.4 ms while explicitly leaving larger
production gaps unexplained. The latter reproduced synchronous registry waiting;
the current code above still contains a synchronous writer-acquisition path.

Scoped and unscoped memory queries for Viewer/snapshot/pipeline profiling found
no specific cause attribution. A correctly scoped `registry` query found two
reference pointers; both were opened by memory id. Neither body supplied this
incident's stack or costs. Native and imported memory indexes were inspected.

The retained [2026-10-13 investigation](../investigations/viewer-load-stall-2026-10-13.md)
reproduced the former whole-store admission storm. Its subsequent implementation
already introduced sliced evidence and files-worker health/delta transport.
The [September host profile](runtime-host-stall-profile-2026-09.md) reproduced
snapshot bursts and synchronous Git provisioning. Current
`src/lib/workflows/provision.ts:46` uses asynchronous `spawn` at `:53`, and
`src/lib/pipelines/git.ts:130` awaits provisioning commands. Those historical
Git timings cannot be assigned to today's stalls. All historical measurements
remain separate from E1–E5.

## Authorized replay and measurement boundaries

The settled decision authorizes one read-only state copy, `cd0aec82`, a closed
`LLV_VIEWER_CONTROL_URL`, an ephemeral Viewer port, CPU profiling and no
succession on 8898. Production profiling, signals and changes to kernel policy
remain prohibited. The later instruction requires heavy profiling through
`scripts/gate-slot.sh`, an 8 GiB owned service, one replay Viewer at a time and a
bounded profile. The continuation followed that instruction after the first
uncontained replay hit its agent scope's 4.5 GiB limit.

R1 is the single retained backup set. Every database was opened with Python
SQLite URI `mode=ro`, `timeout=0` and `PRAGMA query_only=ON`, then backed up with
`Connection.backup()` into scratch. No live WAL or SHM was copied. Each completed
backup is a consistent SQLite snapshot; the set has no atomic cross-database
transaction. Ordinary core state files were read with before/after size and
mtime checks. Recursive capture stopped at an unreadable lock in unrelated test
scratch; that scratch was excluded. The immutable runtime-journal key was
copied once at 14:12:36.048Z, checked for a stable file version, and never printed.

| Database | Backup start UTC | Backup API elapsed, ms | Captured bytes |
| --- | --- | ---: | ---: |
| agent registry | 13:50:01.877 | 383.6 | 383,774,720 |
| memory index | 13:50:05.114 | 82.4 | 48,521,216 |
| runtime journal | 13:50:05.197 | 439.7 | 412,598,272 |
| hot state | 13:50:05.740 | 147.1 | 144,793,600 |
| transcript index | 13:50:05.899 | 1,390.5 | 668,815,360 |

A read-only aggregate on the captured hot-state database finds 259 pipeline
rows containing 34,143,564 JSON bytes and 597 archived rows containing 79,761,275
bytes. The role-memory collection has 2,215 rows, 5,054,619 JSON characters and a
largest row of 769,635 characters; its curation collection has 75 rows. These
are replay dimensions, distinct from E4's earlier live counts.

The backup operation, with private locations replaced by declared variables,
was:

```python
source = sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True, timeout=0)
source.execute("PRAGMA query_only=ON")
target = sqlite3.connect(scratch_database)
source.backup(target, pages=512, sleep=0.01)
target.close()
source.close()
```

R2 uses a Git archive of `cd0aec82a4b4946b42f4d47f84ed5e00487cd2e9`, a scratch
copy of that release's actual `.next` build, and its dependencies mounted
read-only. New working copies derive from R1; no second production database
capture occurred. New source references in this continuation were byte-checked
against the worktree on 2026-10-14 and agree.

The bounded launch was made by `rtk proxy python3 -`, which supplied isolated
HOME, XDG config/cache, TMPDIR and `LLV_STATE_DIR` to this command:

```sh
bash scripts/gate-slot.sh python3 "$SCRATCH/launch-gated.py"
```

That supervisor launches `bwrap` with a private PID, user and network namespace,
a private root filesystem, read-only system/dependency mounts and a writable
scratch mount. Inside it, only its own loopback interface is enabled. The
successful source-preserving run additionally mounts source trees read-only;
the original configuration tree is hidden except for read-only account transcript
roots. Both operator state directories remain inaccessible. HOME and all write
roots stay in scratch. `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`, a nonexistent
scratch runtime socket, `LLV_STRUCTURED_HOSTS=0`, `LLV_RUNTIME_EVENTS=0`, disabled
account/reaper/retirement/sweep switches and disabled telemetry prevent live
actuation. No provider CLI is on the namespace PATH. The copied install's
perimeter is authenticated with the key generated inside its own scratch HOME.

The Viewer command uses the pinned Bun 1.4.0, its unmodified production build,
`next start --hostname 127.0.0.1 --port <ephemeral>`, `--cpu-prof` and a scratch
preload. The preload saves `bun:jsc.profile(..., 1000)` windows after nominal
five-second intervals and exits after a nominal 40-second budget. A synchronous
block can delay that exit: the valid run lasts 42.5 seconds, within the
180-second owned runner guard. JSC traces include JavaScript source URLs,
lines and columns; the additional Chrome-format profile has insufficient source
locations and is not used for attribution. Profiles and raw logs remain private
in the owned scratch directory, outside publication.

Sampling counts below have nominal one-millisecond weights. They locate CPU
owners and include native leaves reached through JavaScript callers. They are
not exact exclusive wall times. Explicit operation durations use
`performance.now()` at the stated boundaries and include any await inside that
boundary. HTTP durations include reading the complete response body.

R2's final, source-preserving run is **14:11:27.280–14:12:11.032Z**. The cgroup
observer's matching bounds are 14:11:27.242–14:12:10.351Z. Its own memory limit
is 8,589,934,592 bytes, peak sampled use is 5,720.2 MiB, and OOM-kill deltas are
zero. The own cgroup has no CPU quota file; every quota-bearing ancestor reads
`max 100000`. All observed throttled-time deltas are zero. Thus its measured
pauses occur without recorded quota throttling.

The journal provides request categories, without a recoverable arrival trace.
The driver pins four concurrent sequential lanes: eight
`/api/files?view=storage-health`, eight `/api/files?view=summary`, four
`/api/files`, and four `/api/pipelines`, with 250/250/500/500 ms post-answer waits.
It lets the real copied controller perform pipeline/scan phases. The runtime
socket reads in R4 are a separate controlled lane. There is no browser, active
engine traffic, runtime consumer publication, host succession, forge access or
provider response. The read-only transcript trees can change while being read;
they are not a frozen transcript capture. These limits prevent reconstruction
of the original 37-second stall.

| R2 HTTP operation | Completed 200 answers | Elapsed range, ms |
| --- | ---: | ---: |
| `files.get` full | 4 | 85.7–868.9 |
| `files.get` summary | 8 | 262.7–4,602.0 |
| `files.health` | 8 | 451.6–10,607.2 |
| pipeline list | 4 | 221.9–1,024.1 |

There were two 500 responses during storage-health readiness, followed by the
successful readiness answer at 14:11:48.318Z. All 24 driven requests subsequently
answered 200. This is a measured startup limitation, not a green release gate.
The first summary answer's worker reports `files-worker-build=3623.7 ms`,
`files-registry=1690.2 ms`, `files-role-titles=442.4 ms` and `files-flows=731.9 ms`.
These are worker costs; asynchronous worker build time does not itself block
the serving Viewer's event loop. Later cached answers retain earlier timing
headers, so they must not be added or treated as new per-answer work.

## Stacks, causes and measured costs

### Curation reconciliation repeatedly copies complete role history

R2 contains 2,478 `structuredClone` leaf samples reached through curation callers
and 2,514 samples including those callers, across its saved windows. The source
chain is:

```text
seatTickController.ts:1651 → curation/run.ts:57 → currentPass()
curation/store.ts:78 → combineProjectRows():60–61 → readPass():42–47
roleMemoryCollection().snapshot() → sqliteStateStore.ts:1021
roleStore.ts:67 clone: structuredClone
```

`currentPass()` builds and sorts the historical pass list even when the project
has no live current pass. Each sort comparison calls `readPass()` twice; every
such read copies all role-memory rows to recalculate counts, although sorting
only needs `claimedAt`. The collection revision cache avoids a repeat SQL
load, while `snapshot()` still deep-copies every row on every call. The copy,
sort and history walk are synchronous. The seat's yield before reconciliation
cannot interrupt this work after it starts. It delays files, pipeline and
runtime-client callbacks in the same Viewer, even when the loop monitor names
only an overlapping `controller.pipelines` operation.

R3 directly profiles the unchanged exported source, with normal Bun flags, on
R1's project with eight historical passes:

| UTC | `currentPass` wall, ms | `structuredClone` leaf samples |
| --- | ---: | ---: |
| 14:06:54.120 | 472.650 | 345 |
| 14:06:54.679 | 384.809 | 342 |
| 14:06:55.152 | 366.466 | 328 |

A complete role-memory snapshot alone costs 26.184/26.560/26.378 ms at
14:06:54.623, 14:06:55.095 and 14:06:55.549Z. Repeated full copies amplify that
cost. A same-data metadata-selection ablation at
14:16:36.636–14:16:37.926Z measures full lookup at
475.985/371.144/381.631 ms and a keyed SQL read of the stored current selection
at 0.049/0.022/0.036 ms. Selection agrees for this captured project. The ablation
omits history aggregation and alias merging; it is a lower bound on a corrected
metadata lookup, not an implemented fix or a test of all curation semantics.

This is the strongest demonstrated repeated clone cost. It supplies no claim
that one such call caused the 37-second live interval. Its implementation is
inside the fenced `src/lib/memory/**`; the build stage must respect that fence,
using an authorized caller-level change or obtaining controller approval to
change the curation reader.

### Startup database integrity checks monopolize the Viewer

R2 logs a 10,625 ms loop gap at **14:11:38.159Z**. The preload independently
measures 10,625.2 ms. The first profile window,
14:11:27.289–14:11:38.265Z, has 7,824 samples in SQLite `all()` called by the
compiled integrity-inspection function. Its query and enclosing startup chain
match `src/lib/state/durability.ts:144` and
`src/lib/viewerInstrumentation.ts:896` (`checkStateDatabasesBeforeStores`).
The function synchronously executes `PRAGMA integrity_check`/`quick_check` before
activation. Native SQLite occupies the same thread that serves HTTP. The gap
includes other startup work; 7,824 samples are not a 7,824 ms stopwatch duration
for one database. This cost is attributable in the replay's startup window.
The earlier serving production window does not establish repeated activation,
so it does not explain the post-deployment 35–37 second pauses.

### A one-second serving gap contains several synchronous state operations

The source-preserving R2 logs **1,050.5 ms** at **14:11:58.731Z**. The corresponding
profile window is 14:11:53.934–14:11:59.453Z. Its stacks contain curation history
cloning, full task snapshots, task fingerprint canonicalization/serialization,
and registry liveness queries. Approximate alignment of JSC trace timestamps
with the preload interval selects 959 samples for the gap; no single stack
owns the whole interval. For example, 72 selected samples are a registry
liveness SQL `all()`, while 106 are task fingerprint `stringify()` leaves.
That alignment has sampling/boundary uncertainty and does not provide exact
per-function spans.

The full task read uses `src/lib/tasks/store.ts:526` and the deep-copy collection
snapshot at `sqliteStateStore.ts:1021`. A task write's preparation takes another
complete snapshot at `tasks/store.ts:631`; `src/lib/tasks/revision.ts:30` computes
fingerprints, whose recursive key sorting, `JSON.stringify` and hash run at
`:17`. These operations finish before a timer can run. The liveness path is
`src/lib/lifecycle/liveness.ts:788` →
`src/lib/agent/sqliteRegistryStore.ts:229`; its current hot-row SQL selection
appears in the compiled trace. The profile establishes their contribution to a
mixed gap. It does not assign the whole second to tasks, registry liveness or
curation individually.

R5 profiles the actual source-level `loadTasks` and a no-change `mutateTasks`
callback over the same component copy, through the owned gate, at
14:19:16.922–14:19:17.589Z. Complete task reads cost
86.880/47.060/41.636 ms; the no-change mutation's snapshot/fingerprint/lease
preparation costs 143.779/99.655/96.302 ms. Each finishes synchronously.
The first no-change probe used an invalid callback result and was discarded;
the measured callback returns the real API's explicit no-change result.
These spans support narrowing the task path, while leaving registry liveness's
exclusive cost and the full one-second mixture unmeasured.

### Files health and scanning consume CPU while awaiting other work

R3's source-level complete health preparation costs
363.908/333.682/289.442 ms at 13:56:31.389, 13:56:32.043 and 13:56:32.558Z, under
Bun `--smol`. The first profile has 129 JSON-parse and 91 SQLite-iterator leaf
samples out of 268. Source: `src/lib/pipelines/store.ts:1077` →
`src/lib/state/sqliteStateStore.ts:934` JSON decoding and `:936` validation, with
a timer yield at `:938` after a four-millisecond slice. R2 adds 2,910 parse/iterator
leaf samples on this path. A full health request lasting 10,607 ms includes
those timer opportunities and competing work. It is not an exclusive
10.6-second parse or lock hold.

The source-level pipeline projection costs 119.013 ms cold and 6.486/5.771 ms
warm at 13:56:31.805, 13:56:32.433 and 13:56:32.901Z. An empty detached controller
callback, including its active-row SQL/decode admission, costs
12.563/11.726/11.061 ms at 13:56:31.977, 13:56:32.493 and 13:56:32.960Z. These
narrow boundaries leave the actual engine/seat callback work outside them.
They argue against assigning tens of seconds to initial pipeline decoding on
this copy. The `--smol` process differs from the full production-Bun replay;
these component results are labeled accordingly.

R2 also contains 1,403 JSON-parse leaf samples under
`src/lib/search/transcriptSearch.ts:554`, reached through its async transcript
message iterator. A parse finishes synchronously before the iterator's next
await. This is measured aggregate CPU in the source-preserving scan, without
an individually timed >1 s line or batch. Incremental scan scheduling and
per-line decoding remain candidates for reducing shared CPU pressure; the
profile does not prove a single giant transcript parse caused a production gap.

### Runtime-host snapshot assembly is bounded here; client transfer remains separate

R4, **14:14:18.734–14:14:19.421Z**, drives the real exported `RuntimeJournal`,
`RuntimeHost.handle`, socket server and `UnixRuntimeHostClient` against R1's
journal, with its matching key, in one isolated process. No consumers, host
fence, deployment listeners or succession run. A scratch socket is the sole
endpoint. Collection and `snapshotJson` are wrapped separately around the real
methods; cold runs clear only the in-memory snapshot cache. The sampled stack
reaches `src/runtime-host/journal.ts:1387`, `:1428` and `:1429`, then the real
client parse at `src/lib/runtime/client.ts:402`.

| Sample start UTC | Collection, ms | Collection + serialization, ms | Complete socket RPC, ms |
| --- | ---: | ---: | ---: |
| 14:14:18.734 | 131.654 | 157.693 | 204.225 |
| 14:14:18.970 | 117.055 | 143.202 | 178.109 |
| 14:14:19.178 | 110.084 | 136.865 | 179.209 |

The JSON payload is 7,809,885 bytes. Cache-hit `snapshotJson` takes 0.022 ms;
the cache-hit RPC still takes 33.245 ms. Serialization, calculated as the
nested timer difference, is 26.040/26.147/26.781 ms. The client/socket remainder
includes scheduling, framing, copying and parsing, rather than pure transfer.
The host and caller share this controlled process; these timings do not measure
production two-process queueing.

These cold collection costs are lower than live E1's 257.4 ms. There are no
concurrent journal mutations or active engine streams in R4. The experiment
attributes host assembly and verifies cache reuse, while leaving the live
38-second timeout's host/caller split unresolved. The actual client already
measures/searches only each arriving chunk at `client.ts:393`; the historical
quadratic accumulated-frame path is absent. No regression to that old mechanism
was demonstrated.

### Controls and failed attempts that cannot choose a fix

The first full replay was OOM-killed under the agent's 4.5 GiB scope and saved
no usable profile. A source-empty gated run at 14:03:22.317–14:04:07.735Z saved a
5,749.6 ms gap at 14:03:40.779Z: 5,032 samples were synchronous
`MemoryIndex.removeSource` SQL calls (`src/lib/memory/index.ts:115–116`), in the
complete-inventory cleanup transaction at `:235–239`. Empty source roots made
previously indexed files appear absent. The source-preserving rerun has zero
`removeSource` leaf samples and no comparable deletion pause. This is an
isolation artifact; it is excluded from the production fix ranking.

A control launched before its derived copy finished was discarded completely.
Other unsuccessful probes encountered a read-only mountpoint, unavailable
sandbox loopback privileges, access-gate refusals, or an empty runtime journal
caused by an omitted environment argument. Their partial results cannot support
an attribution or expected gain. Successful runs enable loopback only inside
the private user/network namespace, use the scratch-generated access key, await
the copy's completion and name the backed-up journal explicitly. No failure
caused a production mutation or an extra database capture.

## Ranked fix plan and expected gain

Savings are conditional targets until the build stage runs the same input and
load before/after. Sampling weights are not additive stopwatch costs, and the
plan does not promise that these changes alone remove the unprofiled live
37-second pause.

| Rank | Change and affected path | Expected gain and regression proof |
| --- | --- | --- |
| 1 | Eliminate complete role-history copies from curation's current-pass selection and historical timestamp sorting. Read pass metadata once; aggregate counts only when needed, with revision-aware reuse. Address the caller at `seatTickController.ts:1651` within the fence, or obtain authority for the fenced curation reader. | The measured eight-pass lookup exposes 366–476 ms per call. Target <10 ms for the same metadata decision, approximately 0.36–0.47 s of Viewer availability recovered per comparable call. The raw SQL ablation is 0.02–0.05 ms and proves the retained state can answer that particular selection cheaply. Preserve aliases, live-pass validation, count deduplication, concurrent revisions and caller isolation. Fail on main with retained-history growth plus a timer probe. |
| 2 | Use asynchronous/no-wait registry writer admission at `sqliteRegistryStore.ts:2747–2751`; preserve revision retry correctness and label source-level callers. | Recover 0.607–0.755 s of timer availability for the observed live contended attempt. Completion still waits for the competing writer. Lock and enclosing retry overlap. A two-connection contention regression must show the timer blocked on main and progressing after the fix. |
| 3 | Bound synchronous task/state work in seat maintenance and pipeline callbacks; replace whole-collection task read/clone/hash work with bounded keyed preparation where semantics permit. Budget microtask chains with timer opportunities. | The demonstrated no-change task preparation exposes 96–144 ms per call and full reads expose 42–87 ms. Target <10 ms for a bounded no-change preparation, approximately 0.09–0.13 s per comparable call. The complete mixed 1,050.5 ms gap also contains other work. Time liveness selection separately before changing it. Regression must preserve nested task edits, revisions, linked companions and durable checkpoints. Do not remove required validation or assign the whole gap to tasks. |
| 4 | Move startup integrity checking off the serving thread while retaining the startup/fallback decision and release readiness barrier. | The replay's 10.625 s startup gap contains 7,824 samples under integrity SQL. Target no >1 s Viewer-thread pause while validation proceeds. Startup completion may still take seconds. This improves boot/release behavior; the gain for an already serving production Viewer is unproved. Test a real retained-size database and refusal/corruption/busy paths. |
| 5 | Preserve host snapshot caching; reduce cache-miss collection or isolate it from RPC dispatch only if a mutation-driven replay justifies the change. | R4 collection exposes 110–132 ms; E1 exposes 257.4 ms. A complete cache reuse saves 137–158 ms of copied-data assembly/serialization, while leaving about 33 ms of caller/socket work in the observed cache-hit RPC. The live observed-call collection ceiling is 257.4 ms. Interleaved mutations and status reads must prove correctness and dispatch latency before promotion. |
| 6 | Budget repeated complete health reads and transcript-index CPU, preserving completeness/revisions. Keep file projection in its existing worker. | Health preparation uses 289–364 ms of elapsed time under `--smol`; repeated reads and scan JSON parsing add CPU in R2. No separate >1 s parse was measured, so no larger single-block saving is claimed. Measure SQL, decode, validation, row/batch gaps, worker and HTTP separately. A revision-safe worker or reuse path must retain corruption reporting and a complete answer. |

The repository fence remains in force for `src/lib/memory/**`, unrelated docs,
landing/site, README, TTS and workflows. This authorized report is the sole docs
output. The measurement stage changed no implementation. A later builder must
resolve any needed fenced edit through its controller before making it.

Each implemented fix needs an explicit-path regression that fails on main,
with identical captured dimensions/load and isolated HOME, XDG, TMPDIR and
`LLV_STATE_DIR`, run through `bash scripts/gate-slot.sh bun test <file>`. A
runtime-host change additionally requires `scripts/verify-runtime-host.ts`
under the pin in private state and the required `runtime-gate`. This stage ran
profiles and the publication privacy check, and claims no implementation/CI
verdict. The final acceptance check remains a 30-minute normal-load production
window with zero >1 s loop gaps, zero exceeded deadlines and zero runtime-host
timeouts. Release 1.13.0 remains held.

## Evidence retention and validation

The private scratch manifest, SQL backups, launch arguments, driver/request
logs, cgroup samples, JSC windows and component profiles are retained for the
build stage. They include private data and must remain outside commits, issues,
PRs and fixtures. Reuse R1 locally; publication evidence uses only the redacted
measurements above. Owned Viewer processes exited on the profiler budget or
were terminated by their recorded parent PID's cleanup; the owned gate contains
and cleans descendants. No process was selected for termination by port, name
or command-line pattern.

The prior attempt's privacy check passed at 13:42:54Z. At
14:24:33.577–14:24:33.762Z the continuation ran
`bun scripts/privacy-publication-gate.ts --require-known-values --paths "$OUTPUT"`
via `rtk proxy python3 -`, with fresh scratch HOME, XDG config/cache, TMPDIR and
`LLV_STATE_DIR`. The committed known-value gate returned `PRIVACY GATE: PASS`,
exit 0, in 185.0 ms. All 34 individually named source references resolve;
supplemental scans found no absolute home paths, email addresses, private UUIDs
or learned-rule identifiers. The final whitespace check produces no diagnostics.
`git status --short` shows only the declared report, untracked. Nothing was
staged, committed or pushed.
