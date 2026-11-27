# Self-update startup window: why a loaded install misses 90 s, and what the apply should wait for

Status: investigation and design, read-only. Base: `main` at `a32fb5d5`
(2026-11-26). Task: 229df97a.

## Originating requirement

On 2026-11-26 at about 10:45 UTC a terminal session relayed to the seat
(seat conversation, relay message of 10:45:44 UTC; paraphrased here) that on
the team install a self-update built `86aa5b71` at 10:35 UTC and applied it at
10:42 UTC. The apply ended `fell-back` with "the server did not answer within
90 seconds", and the install returned to `9e2f87c0` and restarted it. The
restarted Viewer's loop-gap reports then showed the operation
`runtime.startup` at `durationMs` 196 477 with `completed: false`, event-loop
gaps of 1–7 s, and a load average near 25 while lane type checks, privacy
gates and test runs were in progress. The terminal asked:

- why `runtime.startup` takes more than three minutes there (registry open,
  cold projection build, recovery of pending structured spawns, transcript
  scanning?);
- whether the fixed 90 s apply window should scale with load or follow
  startup progress;
- whether self-update should admit only while heavy lane checks are quiet,
  or pause lanes itself for the window.

Acceptance for the eventual fix: an apply on a loaded host succeeds without
manual lane pauses, or it refuses to start until the host is quiet and says
why. The interim, until a fix ships, is to pause heavy lane checks on the team
install during an apply.

## Answer in brief

1. The 90 s is a fixed total budget the launcher gives the new Viewer to
   answer `GET /api/ready?revision=<sha>` with 200
   (`bin/cli.mjs:54`, `bin/cli.mjs:1383`). The Viewer answers 200 only after
   its whole activation has run: state database checks, store loading, the
   registry snapshot, cleanup sweeps and the start of every controller
   (`src/lib/viewerInstrumentation.ts:1096-1257`). Nothing in that window
   measures whether startup is advancing, so a slow start that is making
   progress and a hung start fail the same way.
2. The 196 s figure belongs to a different part of startup. Every
   `runtime.startup` operation is opened by the structured-host adoption, and
   the Viewer starts that adoption without awaiting it before readiness
   (`src/lib/viewerInstrumentation.ts:1206-1216`, `:957-958`). The figure is
   evidence of slow background adoption on the rolled-back release, and says
   nothing direct about the candidate's 90 s window.
3. On this machine (a Docker install running the same startup code, see §3.3)
   the readiness-critical part of activation, from the deploy adapter's
   activation publication to the first step of the final activation call,
   took 102.6 s. A launcher install with this machine's state would already
   miss the 90 s window, whatever the load. State size is a cause on its own;
   load stretches it further.
4. Recommendation (§6): track startup progress the way the runtime host
   already does (#3540): 90 s without progress fails the start, and a start
   that keeps advancing may run until the switch's own 10-minute deadline,
   minus a reserve for the page check. Add one admission reason for automatic
   and seat-triggered applies: hold the dispatch while measured CPU pressure
   or heavy gates are high, using the CPU pressure policy the Viewer already
   applies to stage starts. Do not scale the deadline by load, and do not
   pause lane checks.

## 1. Evidence and method

What was read, and how. No command reached the team install; its figures in
this document come from the relay and are marked as such.

| Source | What it gave | Bounds |
|---|---|---|
| Code at `a32fb5d5` | Apply path, launcher readiness, Viewer activation order, adoption phases | file:line citations throughout |
| `git log` | `9e2f87c0..86aa5b71` is five commits; none touches `bin/cli.mjs`, `bin/self-update-supervisor.mjs`, `bin/launcher-relaunch.mjs`, `bin/server-runtime.mjs`, `src/lib/viewerInstrumentation.ts`, `src/lib/viewerReadiness.ts`, `src/lib/agent/registry.ts`, `src/lib/agent/sqliteRegistryStore.ts`, `src/lib/state/durability.ts` or `src/lib/runtime/startup.ts` (`git diff --stat 9e2f87c06 86aa5b71f -- <those files>` is empty) | The candidate and the release it fell back to start the same way |
| This machine's Viewer container log, read-only (`docker logs --timestamps`, 10:56–11:12 UTC on 2026-11-26) | Loop-gap reports, the `[viewer] Open` line, structured-host startup progress lines | Release `c38535d4`, Docker mode |
| This machine's deployment record (`deployment_status`, deployment of `c38535d4`) | Activation publication time, structured-host startup summary | Same deployment |
| The container's process table (`docker top`, start times at one-second resolution) | When the retirement guard, the state-check worker and the controller workers started | Same container |
| Load at read time (about 12:45 UTC): `/proc/loadavg` 10.97 / 13.81 / 14.21 on 16 CPUs; `/proc/pressure/cpu` some avg10 5.73; `/proc/pressure/io` full avg10 2.90; 15.8 GiB swap in use, 5.7 GiB available | Context only | The load during the 11:02–11:06 window was not recorded |
| A synthetic SQLite probe in stage scratch (§3.4) | Cost of `PRAGMA integrity_check` per megabyte on this machine | Synthetic schema, warm page cache |
| Earlier conversations (`search_transcripts`, several phrasings) and memory (`search_memory`) | The originating relay; no earlier design for the Viewer readiness window | — |

Not done, by the stage's rules: no copy of the live state directory, no
restart or signal of the live Viewer, runtime host or registry, no type check
and no test sweep.

## 2. The apply path and the 90 s deadline

### 2.1 Sequence for a checkout or package install with a relaunch-capable launcher

1. The Viewer records the apply intent and builds the target
   (`src/lib/selfUpdate/service.ts:1647-1653`), then marks it `ready` and
   re-reads its dispatch fences (`src/lib/selfUpdate/service.ts:1664-1690`).
   An operator or seat apply has no quiet requirement: it is refused while
   another update or restart is busy, and at dispatch only if the launcher,
   the intent or the activity fingerprint changed during the final decision
   (`src/lib/selfUpdate/service.ts:1680-1685`,
   `src/lib/selfUpdate/quiet.ts:606`). An automatic apply reaches this point
   only after the quiet rule admitted it
   (`docs/design/self-update-auto.md:41-54`).
2. `ApplyController.send` writes a ten-minute drain for non-automatic applies,
   patches the intent to `switching` with an absolute `switchDeadlineAt`, and
   publishes the launcher request (`src/lib/selfUpdate/apply.ts:70-87`,
   `:49-59`).
3. The launcher takes custody in a durable trial, runs a load check of the
   new entry (30 s child timeout, `bin/launcher-relaunch.mjs:689`), stops its
   children (at most 20 s, `bin/launcher-relaunch.mjs:743`) and execs the new
   release's `bin/cli.mjs` (`bin/launcher-relaunch.mjs:639-745`).
4. The new launcher starts the runtime host. That wait is progress-based: 30 s
   without a new startup marker fails it, with a 5-minute absolute ceiling
   (`bin/server-runtime.mjs:10`, `:52-121`; `bin/launcher-deadline.mjs:11`).
5. The new launcher starts the Viewer with `LLV_VIEWER_STARTUP_PHASES=1`
   (`bin/cli.mjs:1336`) and waits up to `RESTART_READINESS_TIMEOUT_MS` =
   90 000 ms for `/api/ready` (`bin/cli.mjs:54`, `:1356-1371`, `:1383`), then
   up to another 90 s for `GET /` and its first script chunk
   (`bin/cli.mjs:1384-1387`, `bin/self-update-supervisor.mjs:555-571`).
6. On a timeout the launcher throws
   `"The server didn't respond within 90 seconds. [<phase>]"`
   (`bin/cli.mjs:107`, `:1368-1369`), persists the candidate's output tails,
   and `relaunch.failed` stops the children, restores the previous pointer and
   execs the previous entry (`bin/cli.mjs:337-347`,
   `bin/launcher-relaunch.mjs:776-812`). The `[<phase>]` suffix is the Viewer
   startup phase that was still running; the relay quoted the message without
   it.
7. The previous release starts under its own launcher, again with the fixed
   90 s window (a rolled-back trial is still a replacement start,
   `bin/launcher-relaunch.mjs:626`). Once its web and host are healthy, the
   Viewer settles the apply `failed`, `rolledBack: true`, records history
   outcome `fell-back`, and releases the drain
   (`src/lib/selfUpdate/apply.ts:110-138`, `:186-191`, `:207-215`;
   `src/lib/selfUpdate/service.ts:2409`).

### 2.2 What "answered" means

The launcher probes `GET /api/ready?revision=<40-hex sha>`
(`bin/self-update-supervisor.mjs:409`, `:437`, `:456-499`), each attempt
bounded at 5 s, 200 ms apart. The route answers 400 for a malformed query,
503 until the process has marked itself ready, 409 for another revision, and
200 with `x-delegatus-viewer-revision` when it matches
(`src/lib/viewerReadiness.ts:32-43`, `src/app/api/ready/route.ts:5`). The mark
is set by `markViewerHttpReady()` as the last step of the activation callback
(`src/lib/viewerInstrumentation.ts:1256-1257`). In launcher mode the process
owns traffic from its first instant (no `viewer-release.json` target,
`src/lib/viewerReleaseTraffic.ts:12-31`), so `register()` awaits the whole
activation (`src/lib/viewerInstrumentation.ts:288-291`), and Next.js holds
requests until `register()` completes
(`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md:18`).
Either way, the probe cannot see 200 before activation finishes.

Releases older than #4383 (2026-11-24) answer the legacy `/api/files` probe
instead (`bin/self-update-supervisor.mjs:410`, `:489-494`).

### 2.3 Every place the fixed window applies

| Wait | Constant | Where |
|---|---|---|
| Ordinary launcher start (boot, service restart) | `READINESS_TIMEOUT_MS` 90 000 | `bin/cli.mjs:49`, `:1383` |
| Candidate start in a switch, and the rollback start | `RESTART_READINESS_TIMEOUT_MS` 90 000 | `bin/cli.mjs:54`, `:1383` |
| Viewer recovery after a crash, and a web restart | same | `bin/cli.mjs:1450-1463`, called at `:1488` and `:1517` |
| Page and chunk after readiness (replacement starts and web restarts; crash recovery skips it, `bin/cli.mjs:1488`) | `timeoutMs = 90_000` | `bin/self-update-supervisor.mjs:556` |
| Terminal bootstrap health verification | `TERMINAL_BOOTSTRAP_TIMEOUT_MS` = 2 × (300 + 90 + 90) s + 30 s = 990 s | `bin/launcher-deadline.mjs:12` |

The surrounding budgets: the switch has 10 minutes from `switchedAt`, the
rollback 10 minutes from its first step, and an ordinary launcher start 10
minutes from its controller (`bin/launcher-deadline.mjs:7-8`,
`bin/launcher-relaunch.mjs:394-412`; table in
`docs/design/launcher-start-deadlines.md:59`, `:71-72`).

### 2.4 Consequences that reach beyond self-update

- **Ordinary starts loop.** The Linux login service restarts the launcher on
  failure after 5 s, at most 5 starts per 600 s (`bin/login-service.mjs:57`).
  If every start needs more than 90 s of Viewer activation, every start is
  stopped at 90 s. With a cycle of about 145 s (30 s host, 90 s Viewer, up to
  20 s stop, 5 s delay) the unit restarts indefinitely and never serves. With
  a cycle under 120 s, six starts fit in 600 s and the unit also exhausts its
  start limit and stays down.
- **Crash recovery loops the same way**, retrying with backoff and stopping
  each attempt at 90 s (`bin/cli.mjs:1450-1490`).
- **The first rollback after a fix uses the old launcher.** Rollback execs the
  previous release's own `bin/cli.mjs` (`bin/launcher-relaunch.mjs:805`), so
  until both releases carry the new readiness code, a rollback keeps the
  fixed 90 s. The candidate's own wait always runs the candidate's launcher,
  so a fix takes effect on the first apply that installs it.

### 2.5 Precedent already in the tree

The runtime host had the same defect with a fixed 15 s and was moved to a
progress window by #3540 (`2bb852ef9`, 2026-11-02): the launcher reads only
the candidate's own startup record, counts a phase or counter as progress
only when it exceeds its high-water mark, and fails on 30 s of silence or the
5-minute ceiling (`bin/server-runtime.mjs:15-48`, `:52-121`, high-water check
at `:113`). The Viewer already prints coarse phase receipts that the launcher
parses into its readiness journal
(`src/lib/viewerReadiness.ts:12-30`, `bin/self-update-supervisor.mjs:584`,
`:651-670`), added by #4383 (`6f2de5019`, 2026-11-24). Those receipts name the
pending phase in the timeout message and are otherwise unused by the wait.

## 3. Startup phases

### 3.1 Before readiness, in order

Phase names are the receipts the Viewer prints
(`src/lib/viewerInstrumentation.ts:1096`, `:1107`, `:1110`, `:1156`, `:1176`,
`:1186`). In this table a bare line number refers to
`src/lib/viewerInstrumentation.ts`.

| Phase | What runs | Scales with | Where it runs |
|---|---|---|---|
| `http-ingress` | Loop monitor, render monitor, control ingress (`:1096-1105`) | Constant | Main loop, short |
| `access` | Spawn-capability resolver install, phone-access gate (`:1107-1109`) | Constant | Main loop, short |
| `release-authority` | Hot-state cutover boundary (`:1151`; polls only during a first SQLite cutover, `:178-231`), managed retirement guard (`:1155`) | Constant after the cutover | Guard is a helper process |
| `state-compatibility` | `PRAGMA integrity_check` on `state.sqlite` and `agent-registry.sqlite`, `quick_check` on `mcp-receipts.sqlite` and `handoff-queue.sqlite` (`src/lib/state/durability.ts:83-118`, `src/lib/state/durability.ts:164-172`, `src/lib/state/durability.ts:791-812`); delivery-ledger indexes (`:1159-1162`); hot-state stores: loads flows, pipelines, archived pipelines for the list, workflows, the history projection and the MCP receipt store (`:363-400`, called at `:1170`); legacy collection imports (`:1174`); interrupted transfers (`:1175`) | Database bytes (both integrity checks read every page and verify every index); pipeline count, hot and archived | Integrity checks in a leased worker process (`src/lib/state/durability.ts:1188-1198`); store loading in the Viewer process (whether each load yields to the loop was not traced) |
| `registry` | Registry open under a state lock (`src/lib/agent/registry.ts:13973-13976`); recovery indexes and the cooperative read-only snapshot (`src/lib/agent/sqliteRegistryStore.ts:2727-2765`); the native caller artifact index, awaited to completion (`src/lib/agent/sqliteRegistryStore.ts:2331-2350`, `waitUntilReady` gives it no deadline) | Registry rows (conversations, entries, receipts) and native host paths | Main loop in bounded synchronous slices with yields |
| `activation` | Finished-work cleanup and two placeholder retirements (`:1188-1194`); then `completeViewerRuntimeActivation` (`:948-965`): operator capability (prints `[viewer] Open`, `:702`), identity migration started off the loop, hot-state activation published, Claude login recovery, Codex hook retirement, structured-host adoption **started and not awaited** (`:957`, `:1206-1216`), every controller started and awaited (`:958`, `:1236-1240`, `:403-653`), release-ready published; then durability timers (`:1254`) | Task and placeholder counts for the sweeps; module count for the controller imports | Main loop; module evaluation is synchronous |

`markViewerHttpReady()` follows at `:1257`. Board refinement (worktree
recovery, the board summary build, attention reconcile) is started without
awaiting at `:962` and runs after readiness.

### 3.2 After readiness: what `runtime.startup` measures

The loop monitor reports, for each loop gap, every operation still open, with
its duration so far and `completed: false` (`src/lib/viewerLoopMonitor.ts:158-170`).
`runtime.startup` is opened only by the structured-host adoption:
`src/lib/runtime/startup.ts:2756` (startup memberships), `:3269` (the host
pass), `src/lib/runtime/registry.ts:1322` (skipped-host demotion) and
`src/lib/runtime/startupSnapshot.ts:90` (host selection), all reached from
`adoptStructuredHostsAtStartup` (`src/lib/runtime/startup.ts:3213`). The
Viewer starts that adoption in `startStructuredHosts`, inside a barrier
promise it does not await (`src/lib/viewerInstrumentation.ts:1206-1216`).

So the relayed "196 477 ms, completed: false" is adoption still running in a
Viewer that, by the settlement rule in §2.1 step 7, had already answered its
own readiness probe: the apply cannot be recorded `fell-back` until the
rolled-back web and host are healthy (`src/lib/selfUpdate/apply.ts:110-138`,
`:186-191`). That is an inference from code; the team install's history row
and readiness journal would confirm it (§7.4).

Adoption phases on this machine, from the `previousPhaseMs` of each
`[structured hosts] startup progress` line, 11:04:32.648 to 11:06:23.956 UTC,
111.3 s in total (the deployment record reports 1 of 1 hosts and 52 recovery
items examined, 36 completed, 16 deferred):

| Adoption phase | ms |
|---|---|
| refreshing transcripts | 67 523 |
| reading startup memberships (first pass) | 15 002 |
| recovering pending spawns | 6 193 |
| reading structured startup registry | 4 995 |
| reconciling terminal delivery receipts | 4 187 |
| publishing historical host fallbacks | 2 531 |
| recognizing interrupted hosts | 2 428 |
| reconciling structured hosts | 2 422 |
| finalizing structured delivery | 1 770 |
| adopting Claude hosts | 1 738 |
| eleven other phases | 2 519 |

"Refreshing transcripts" reads the stable tail of the transcript of every
conversation with a structured host in the registry snapshot, sixteen at a
time (`src/lib/runtime/startup.ts:1942-1987`, `:368`, `:3597-3605`); it
scales with the number of structured-host rows the registry still carries.
Memberships walk registry rows in 8 ms slices
(`src/lib/runtime/startup.ts:2756-2790`). Pending-spawn recovery scales with
pending spawns.

Against the task's list of suspects: the registry open and snapshot are on
the readiness path (`registry` phase). The cold projection build runs after
readiness (board refinement). Pending-spawn recovery and transcript scanning
are adoption phases after readiness; on this machine transcript refresh is
the largest. The adoption breakdown on the team install is in its own
`[structured hosts] startup progress` lines (§7.4).

### 3.3 Timeline of one start on this machine

Docker mode, release `c38535d4`, 2026-11-26. The deploy adapter published the
activation at 11:02:49.848 UTC ("incumbent still running after 15s;
activation published after 87s"). The container's process table shows the
managed retirement guard and the state-check worker both starting at
11:02:49 UTC, which places `release-authority` and the start of
`state-compatibility` there.

| UTC | Event | Source |
|---|---|---|
| 11:02:49.8 | Activation published; guard and state-check worker start | deployment record; process table |
| ≈ 11:03:32.5 | A registry preparation begins (inferred: the 11:04:32.548 loop gap lists `registry.prepare` 60 046 ms, completed) | loop-gap report |
| 11:04:32.487 | `[viewer] Open`, printed by the first step of `completeViewerRuntimeActivation` | container log; `src/lib/viewerInstrumentation.ts:702`, `:951` |
| 11:04:32.648 | Structured-host adoption starts | container log |
| 11:04:33 | Disk-pressure, worktree-sweep and account-migration workers start, so `startControllers` is running | process table |
| 11:06:23.956 | Adoption ready | container log; deployment record |

From publication to `[viewer] Open`: 102.6 s. `markViewerHttpReady()` comes
later still, after the controllers have started; Docker mode prints no phase
receipts, so its exact time is unknown. Inferred split: about 43 s from
activation to the registry preparation (`release-authority` and
`state-compatibility`), about 60 s of `registry`, then the cleanup sweeps.

Two differences from a launcher start, both noted so the number is not
over-read: a Docker candidate that has been promoted can serve board requests
during its activation (its `register()` returned early because it was not yet
current), which competes for the main loop; and the load during this window
was not recorded.

### 3.4 Synthetic cost of the integrity check

To bound the one indivisible step on the readiness path, a 201 MB SQLite file
with 145 000 rows, one unique index and two secondary indexes was built in
stage scratch and checked twice, through the gate wrapper (so at CPU weight 10
and I/O weight 10), at load 13.4 on 16 CPUs, with the file still in the page
cache:

| Check | Run 1 | Run 2 |
|---|---|---|
| `integrity_check` | 1 212 ms | 847 ms |
| `quick_check` | 668 ms | 198 ms |

That is roughly 4–6 ms per MB for `integrity_check` on a warm cache. The two
integrity-checked databases on this machine are 576 MiB and 802 MiB, so
inference puts their check at several seconds warm. A cold cache, swap
pressure and the registry's larger set of indexes raise it; by how much on the
team install is unknown until its readiness journal shows the
`state-compatibility` time (§7.4).

### 3.5 Why the candidate missed 90 s on the team install

Derived, and to be confirmed there:

- The candidate's readiness-critical work is the same code that took more than
  100 s here (§3.3). Its size terms are database bytes, pipeline count and
  registry rows (§3.1), all larger on an install that has run for months.
- Load adds to it. Gates run at CPU weight 10 and I/O weight 10 under the work
  slice when CPU placement is active (`docs/design/cpu-placement.md:19-26`),
  which protects CPU time; page cache, memory and swap stay shared with the
  gates, and swap was in use on this machine at read time (§1).
- The figures the relay paired with the failure (load near 25, 1–7 s loop
  gaps, 196 s of `runtime.startup`) were taken from the rolled-back release
  after it served (§3.2). The drain is released when the rollback settles
  (`src/lib/selfUpdate/apply.ts:207-215`), so lanes queued during the apply
  could start their stages and gates exactly then. The load during the
  candidate's own window, 10:42–10:44 UTC, is not in the evidence.
- The phase still running at the timeout is recorded twice on the team
  install: as the `[<phase>]` suffix of the history detail
  (`bin/cli.mjs:1368-1369`) and as the candidate run's `startup` map in the
  readiness journal (`bin/self-update-supervisor.mjs:591-683`, last four runs
  kept). Reading either settles which phase dominated.

## 4. What must precede readiness, and what could follow it

Readiness tells the launcher to declare the release healthy, and tells the
Viewer to settle the apply and release the drain, after which stages, seat
sends and deliveries start. A step can follow readiness only if nothing those
admit depends on it, or if the dependants already handle its absence.

| Step | Must precede readiness? | If moved after readiness | Risk |
|---|---|---|---|
| State database checks (`state-compatibility`) | Yes: stores must not open a damaged database (#1870 slice 10, `56be0eec9`, 2026-09-19; `src/lib/viewerInstrumentation.ts:977-993`) | A `quick_check` could stay on the path with the full `integrity_check` moved after readiness | Index corruption found after stores opened needs a restart to repair; changes a durability contract |
| Store loading, legacy imports, interrupted transfers | Yes: the first request reads these stores, and an interrupted install transfer that cannot be settled refuses activation (`:309-316`) | — | Requests answering from unloaded stores; launches against half-applied imports |
| Registry snapshot | Yes: every spawn, delivery and board read needs it | — | First reads would block on the same preparation anyway |
| Native caller artifact index (awaited with no deadline) | Partly: it serves native MCP callers, whose lookups already refuse an incomplete index and advance one batch (`src/lib/viewerInstrumentation.ts:967-975`) | Prepare in the background after readiness | MCP calls from agents adopted early would be refused and retried until it completes |
| Finished-work cleanup and placeholder retirements | No: idempotent sweeps | Run after readiness | Finished items and placeholders stay visible briefly |
| Controller start | Today yes, by placement before `publishViewerReleaseReady` and the mark | Mark readiness first, start controllers after | A release whose controllers cannot start would be declared healthy, and the apply would not roll back |
| Start of structured-host adoption (kicked off before the controllers, then running alongside them) | No: it is already unawaited; only its start precedes the mark | Start it after the mark | Live workers wait a few seconds longer for re-adoption; less contention on the readiness path |

None of these moves is in the recommended first slice. Each changes what
readiness promises, and each needs a before/after measurement on identical
data; the team install's per-phase numbers (§7.4) decide which, if any, is
worth it. They are listed under "Deferred".

## 5. Options for the window

### 5.1 Invariants every option must keep

- I1. The switch ends by `switchDeadlineAt`, 10 minutes after dispatch; the
  rollback ends 10 minutes after it starts.
- I2. Within the switch: for an automatic request, admission before the
  handler ≤ 20 s and re-admission after the load check ≤ 20 s
  (`bin/self-update-supervisor.mjs:347`, `:375`; each call bounded at
  `bin/cli.mjs:1578`); load check ≤ 35 s; child shutdown ≤ 20 s; runtime
  host ≤ 300 s; Viewer readiness 90 s; page and chunk ≤ 90 s. Today's worst
  sum is 20 + 35 + 20 + 20 + 300 + 90 + 90 = 575 s ≤ 600 s.
- I3. Only the candidate's own markers count as progress; unreadable or
  repeated evidence never extends a wait (the runtime-host rule,
  `bin/server-runtime.mjs:13-14`, `:113`).
- I4. A start that makes no progress fails no later than today's.
- I5. The terminal bootstrap waits long enough for a switch and a rollback to
  finish.
- I6. Admission keeps its existing fences: green target, quiet rule for
  automatic applies, memory ≥ 4 096 MB (`src/lib/selfUpdate/quiet.ts:303-306`,
  `:561`), and the six-hour **Deploy now** decision
  (`docs/design/self-update-auto.md:55-60`).
- I7. Nothing stops or pauses a process the Viewer did not start.

### 5.2 Option A: follow startup progress

The launcher keeps probing `/api/ready` as today and also watches the
Viewer's receipts. A new phase, or a strictly higher counter within a phase,
is progress. The start fails after 90 s without progress, or at an absolute
ceiling: `switchDeadlineAt` (or the rollback or ordinary-start expiry) minus a
90 s reserve for the page check.

Numeric checks (preflight P, shutdown S, host H, Viewer V, page G; figures for
the team install are assumptions where marked):

- A1, an operator apply (no admission calls) on a loaded host that keeps
  advancing: P 8 s, S 6 s, H 40 s (assumed). V may run
  to 600 − 54 − 90 = 456 s. A start that finishes at V = 200 s with no silence
  over 90 s passes at about 254 s after dispatch; I1 and I2 hold.
- A2, a start that hangs in `registry` at V = 40 s: it fails at V = 130 s,
  rollback begins at about 184 s, inside I1. I4 holds: a start with no
  receipts at all fails at 90 s, the same as today.
- A3, a slow host on an automatic apply: two admissions 20 s each, P 35 s,
  S 20 s, H = 300 s (its ceiling). V's ceiling is 600 − 395 − 90 = 115 s.
  A 200 s Viewer start fails at its ceiling with a budget detail and rolls
  back. I1 holds; the apply fails.
- A4, a legacy candidate without fine receipts: six phase receipts are the only
  progress, so a single phase longer than 90 s fails as today.
- A5, ordinary start after a reboot under load: the launcher's own 10-minute
  expiry bounds V. A 150 s start succeeds on its first attempt, where today it
  loops (§2.4).
- I5 fails unless the bootstrap bound changes: 990 s is less than a 600 s
  switch plus a 600 s rollback. It must derive from those budgets.

Cost: launcher and Viewer code only, no UI. Answers the size problem and the
load problem as long as the start keeps moving. Leaves A3.

### 5.3 Option B: hold the dispatch while the host is busy

Before the switch dispatches, apply the CPU pressure rule the Viewer already
uses to hold stage starts (`src/lib/runtime/cpuPressure.ts:23-24`: hold at
PSI cpu some avg10 ≥ 30 %, release once it stays below 20 % for 10 s;
`machineCpuPressureGate` at `:116`). Pressure alone decides. The reason also
shows the number of heavy gates the CPU admission queue lists as active
(`src/lib/runtime/cpuAdmission.ts:27`, `:202`), so the operator sees what is
loading the host; a gate count is no second threshold.

- Automatic applies: one more quiet blocker beside memory. The existing
  ten-minute waiting cycle bounds it and defers with a reason
  (`docs/design/automatic-update-waiting.md`). It counts as an activity
  blocker, so the six-hour **Deploy now** decision can override it: Option A
  still protects that start. I6 holds.
- Seat applies: refused with a retryable reason that carries the numbers, so
  the seat tries again later. This is the requirement's second branch.
- Operator applies: see Q2.
- Unreadable pressure (no PSI file): admit, with the reason recorded; Option A
  still protects the start. Holding on unreadable evidence would block
  platforms without PSI forever.
- Numbers: this machine at read time, avg10 5.73 % and load 0.69 per CPU,
  admits. A sample of 29 % admits, and if pressure then rises the start rests
  on Option A; a sample of 31 % holds until pressure stays below 20 % for
  10 s. A host at load 25 with 16 CPUs (1.56 per CPU) would very likely hold;
  the team install's CPU count and PSI during the apply are unknown.

Alone, B cannot fix §3.3: a quiet host with this machine's state still needs
more than 90 s. Paired with A it covers A3, where a busy host makes even a
progressing start overrun, and it shortens the outage under load, since the
service is down from child shutdown until readiness.

### 5.4 Option C: scale the deadline with load

For example 90 s × max(1, load per CPU ÷ 0.75), capped. Rejected:

- It grants nothing to a quiet install with large state (§3.3 already
  exceeds 90 s), so I4's companion goal, passing a slow healthy start, fails.
- A hung start on a loaded host waits longer for nothing.
- The sample is taken before the window and can change through it; the
  factor has no evidence behind it beyond the single relay.
- It still needs the same cap as A, so A's machinery would be needed anyway.

### 5.5 Option D: pause lane checks for the window

- Pausing running checks (for example SIGSTOP on their services) breaks I7:
  gates run under services agents started. Their publication budgets
  (15–45 minutes, `src/lib/pipelines/gateBudget.ts`) keep counting while
  stopped, so a pause can park lanes that did nothing wrong.
- Holding only new gate admissions needs a durable hold that every
  `gate-slot.sh` copy honours. Lanes run the gate scripts of their own
  checkouts and of cached tooling at older revisions, so coverage would stay
  partial until every lane rebases. Every apply already holds new stages,
  flow rounds, seat sends and structured deliveries until it settles: an
  automatic one through its drain cohort
  (`docs/design/self-update-auto.md:43-46`), an operator or seat one through
  the drain written at dispatch (`src/lib/selfUpdate/apply.ts:75`).

Rejected for now; listed under "Deferred".

## 6. Recommendation

Build A, then B. Reject C and D.

- A removes the fixed total and replaces it with the rule the runtime host
  already lives by: a start fails when it stops moving, or when the switch's
  own budget runs out. It fixes the size cause shown on this machine, it
  fixes ordinary starts and crash recovery under load (§2.4), and it keeps
  every budget in §5.1.
- B adds one reason to wait, for the case where the host is too busy for even
  a progressing start to fit, and gives the seat and the Update surface a
  clear "the host is busy" answer. It reuses the stage-start policy, so the
  thresholds and their settings (`CPU_PRESSURE`, `CPU_PRESSURE_HOLD`,
  `CPU_PRESSURE_RELEASE`, `src/lib/runtime/cpuPressure.ts:41-46`) already exist.
- Together they meet the acceptance: on a loaded host the apply either
  succeeds because startup keeps advancing within ten minutes, or, for
  automatic and seat applies, it waits or is refused with the measured reason
  before anything is stopped.

## 7. Build slice

### 7.1 Slice A: progress-tracking Viewer readiness

Deploy path: high risk, three review rounds (AGENTS.md, runtime host and
deploys).

- `src/lib/viewerReadiness.ts`: give `viewerStartupPhases()` a
  `progress(done, total)` call that prints
  `[viewer startup phase] <phase> progress <done> <total>` only when `done`
  grows, at most once per second per phase, under the existing
  `LLV_VIEWER_STARTUP_PHASES=1` gate, within the parser's 120-character limit.
- `src/lib/viewerInstrumentation.ts`: report progress
  - in `state-compatibility` per completed step (databases checked, ledger
    indexes, stores, imports, transfers);
  - in `registry` per completed preparation slice of the snapshot and of the
    native artifact index (`src/lib/agent/sqliteRegistryStore.ts:2331-2350`,
    `:2727-2765`, through a callback);
  - in `activation` per completed awaited step, counting each controller
    loader in `startCurrentReleaseControllers`.
- `bin/self-update-supervisor.mjs`: accept the `progress` receipt in
  `startupReceipt` (`:584`) and keep a high-water per phase in the readiness
  journal; give `waitForViewerReadiness` (`:456-499`) `silenceMs` (90 000)
  and an absolute `deadline`, with failure details naming the phase and the
  last progress; teach `readinessReason` (`:573-582`) the new details.
- One shared progress-wait function for the Viewer and the runtime host, so
  the decision "did this child advance within its silence window and ceiling"
  has one implementation. The host keeps 30 s and 5 minutes; its tests in
  `bin/runtime-host-readiness.test.ts` must pass unchanged (Q3).
- `bin/launcher-relaunch.mjs`: expose the current absolute expiry (switch,
  rollback or ordinary start), already computed by `arm`
  (`:394-412`).
- `bin/cli.mjs`: replace the fixed waits at `:1383` and `:1461` with
  silence 90 s and ceiling expiry − 90 s; crash recovery uses its own
  10-minute ceiling; new en and uk messages next to `serverTimeout`
  (`:107`, `:165`).
- `bin/launcher-deadline.mjs`: derive `TERMINAL_BOOTSTRAP_TIMEOUT_MS` from
  `SWITCH_TIMEOUT_MS + ROLLBACK_TIMEOUT_MS`, both stops and a margin; fix the
  comment at `:5-6`.
- `docs/design/launcher-start-deadlines.md:72`: the Viewer readiness row.

### 7.2 Slice B: busy-host admission reason

- `src/lib/selfUpdate/quiet.ts`: an optional `hostPressure` port and blocker
  beside `memoryMb`; unreadable admits.
- `src/lib/selfUpdate/instance.ts`: the port, from `cpuPressurePolicy` and a
  read-only count of active gate tickets.
- `src/lib/selfUpdate/service.ts`: the seat path (`:2061`) refuses with a
  retryable `host_busy` reason when the port holds.
- Copy in `src/components/selfUpdate/selfUpdateCopy.ts`,
  `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts`; rendered evidence of the new
  blocker line in en and uk, light and dark, through an existing driver
  (AGENTS.md, rendered evidence).
- `docs/design/self-update-auto.md:51-53`: add the blocker to the list.

### 7.3 Tests

By path, with isolated HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR`,
through the gate wrapper, one at a time.

- `bin/self-update-supervisor.test.ts`, fake clock and probe, modelled on
  `bin/runtime-host-readiness.test.ts`:
  - a start that answers 503 for 250 s while receipts advance every 30–60 s
    becomes ready and passes;
  - a start whose receipts stop at `registry` at 40 s fails at 130 s with a
    detail naming `registry` and its last progress;
  - a start that prints no receipts fails at 90 s, as today;
  - a repeated receipt, an equal counter, or a timestamp-only change does not
    extend the wait;
  - progress that continues past the ceiling fails with the budget detail;
  - a child exit during the wait fails at once;
  - an over-long or unknown-phase line is ignored.
- `bin/cli.selfUpdate.terminal.integration.test.ts` or
  `bin/cli.selfUpdate.deadline.integration.test.ts`, with the existing
  fixtures (`bin/__fixtures__/cli-self-update.ts`) and the existing practice
  of rewriting constants in the fixture release (`:1119-1123`):
  - a candidate that prints progress every 300 ms and answers `/api/ready`
    after 3 s, with silence rewritten to 1 s, settles `done` without a rollback;
  - a candidate that prints two receipts and then stalls falls back, and the
    apply's detail names the stalled phase.
- `bin/launcher-deadline.test.ts`: the bootstrap bound covers a switch, a
  rollback and both stops.
- A new `src/lib/viewerReadiness.test.ts`: the progress line appears only when
  `done` grows, at most once per second, only under the env gate, and fits
  the parser.
- Slice B: `src/lib/selfUpdate/quiet.test.ts` (holds above the threshold,
  admits below and when unreadable) and the seat refusal in
  `src/lib/selfUpdate/routes.test.ts`.

### 7.4 What only the team install can show

Before building, read-only and cheap:

1. History detail of the 10:42 UTC apply: the `[<phase>]` suffix
   (`bin/cli.mjs:1368-1369`) names the phase pending at 90 s. Its `trigger`
   in the apply record says whether the quiet rule was consulted.
2. `<state>/self-update/readiness-<installId>.json`: per-phase elapsed times
   of the candidate run and of the rollback run, if they are still among the
   last four runs; `<state>/self-update/startup-output-<installId>.json` holds
   the failed candidate's output tails.
3. The rolled-back Viewer's `[structured hosts] startup progress` lines: the
   adoption breakdown behind 196 s.
4. Sizes of `state.sqlite`, `agent-registry.sqlite` and `mcp-receipts.sqlite`;
   CPU count; whether the service runs with CPU weight 1000 and the cpu
   controller active (`docs/design/cpu-placement.md:19-26`); swap use.

After deploying slice A:

5. The next apply under ordinary lane load: the readiness journal shows the
   progress receipts, the total readiness time and outcome `done`. Record
   load, CPU, memory and I/O pressure during the window. This is the
   acceptance's "startup breakdown on a work-sized dataset under load".
6. A stuck candidate is never induced on the live install; the integration
   test above covers it.

After slice B: an apply attempted while gates run shows the busy-host reason
and starts after they finish.

## 8. Open questions

- **Q1. How long may a start go without progress?** Options: 30 s (the
  host's), 60 s, 90 s. Recommended: 90 s. It equals today's window, so
  nothing that passes today fails (I4), and it leaves room for the one
  indivisible step on the path, the integrity check of the largest database.
- **Q2. Should an operator's explicit apply also wait for a busy host?**
  Options: wait with an override, warn and proceed, unchanged. Recommended:
  warn and proceed. The operator chose the moment; slice A protects the
  start; automatic and seat applies, which nobody watches, wait.
- **Q3. Share the progress-wait loop with the runtime host, or copy it?**
  Recommended: share, keeping the host's 30 s and 5 minutes, with the host's
  readiness tests as the guard. One decision, one function.
- **Q4. Should the drain release wait for structured-host adoption?** The
  load near 25 that the relay saw followed the drain's release. Recommended:
  not in this work; first see whether the team install's adoption breakdown
  ties its length to that burst.
- **Q5. Should the activation integrity check shrink?** Recommended: decide
  after the team install's `state-compatibility` time is known; if that phase
  alone approaches 90 s without progress, emit per-database progress first,
  and only then consider `quick_check` on the path.
- **Q6. Should the 90 s page-and-chunk check also follow progress?**
  Recommended: no. After `/api/ready` answers it is one page render and one
  static file.
- **Q7. Is the interim still needed after slice A?** Recommended: yes for the
  first apply that installs A, because its rollback, if any, runs the old
  launcher with the fixed 90 s (§2.4); no afterwards.

## 9. Deferred — not currently justified

- Load-scaled deadline (Option C).
- Pausing running lane checks, or a durable hold on new gate admissions during
  the switch (Option D).
- Moving steps after readiness: the native caller index, the cleanup sweeps,
  the controller start, the adoption kick-off, a lighter integrity check
  (§4). Each needs the team install's per-phase numbers and a before/after
  measurement on identical data.
- Releasing the drain gradually, or only after adoption is ready (Q4).
- Faster structured-host adoption (transcript refresh, memberships). It runs
  after readiness and does not affect the apply window; it belongs with the
  loop-gap work.
- An operator-apply hold for a busy host (Q2).

## 10. Validation against the requirement

| Requirement | Where answered |
|---|---|
| Why `runtime.startup` exceeds 3 minutes | §3.2, §3.5: it is the background adoption; on this machine transcript refresh dominates; the team install's own lines confirm (§7.4 item 3) |
| Whether 90 s is adequate | §2, §3.3: no; this machine's readiness-critical activation took more than 100 s |
| Scale with load or follow progress | §5.2, §5.4, §6: follow progress, do not scale |
| Admit only when quiet, or pause lanes | §5.3, §5.5, §6: a busy-host reason for automatic and seat applies; no pausing |
| Apply succeeds on a loaded host, or refuses with a reason | §6, numeric checks A1–A5 |
| Measured breakdown on a work-sized dataset under load | §7.4 item 5, after slice A; this document's measurements are from this machine and a synthetic probe |
