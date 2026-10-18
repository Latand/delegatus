# Main-thread blocking audit: Viewer and runtime host

Status: part 1 of 3, the static inventory (pipeline stage `inventory`,
2026-10-18). The measurement stage adds measured durations and the correlated
stalls. The synthesis stage adds the ranked list, remediation slices,
regression guards, the follow-up window and the final coverage gaps. This part
measures no duration. Durations quoted from earlier audits carry their source;
counts and sizes below are scale observations with their commands.

## Requirement

On 2026-10-18 at about 13:10 UTC the operator asked, through the board brief
for this audit, that everything else affecting the main thread be checked,
because something clogs the server again and again. This is a paraphrase; the
brief keeps the operator's words and forbids copying them into published
files.

The pinned goal: a complete, evidence-ranked audit of everything that blocks
the main JavaScript loop of the Viewer and of the runtime host. It covers
multi-second stalls and repeated sub-second stalls beyond the merged-worktree
sweep already being fixed, keeps measured causes apart from suspects, and calls
nothing complete until it is verified.

## Sources, base and method

- **Code base.** All `file:line` references are at `c91603e0`, the lane base.
  `origin/main` has moved once since: `9c889c07` (#3051) changes only
  `src/lib/loopProfiler.ts` and `src/lib/viewerLoopMonitor.ts` (the 60 s
  cooldown after a slow window is gone, and every gap of at least 2 s carries
  `jsProfile.status`). Line numbers in those two files differ on main.
- **Serving revisions.** `$HOME/.config/delegatus/state/self-update/history.jsonl`
  records `kind: apply` for `c91603e0` at 2026-10-18T12:14:58.377Z and for
  `9c889c07` at 13:19:58.559Z.
- **Earlier answers read first (rule 3).** `docs/perf/viewer-stall-attribution.md`,
  `docs/perf/viewer-stalls-attribution.md`, the board task for the residual
  long server pauses with its notes, and the stage results of audits
  `e5a90d5a`, `30c04d79` and `af6115c1`, runtime-host verification
  `cbaaf29a`, diagnoses `1ce89da8`, `3ad4d372` and `1c84dacd`, and the merged
  fix lanes listed under [Prior fixes](#prior-fixes-and-the-residual-each-leaves).
- **Open work read (rule 8).** `1eb0ab07` (its uncommitted worktree diff, read
  only), `e9a56ff7` (#3051, merged), `41be75ea` (#3048, branch diff) and
  `44e9fd13` (#3050, branch diff). See
  [Covered-by-lane assessment](#covered-by-lane-assessment).
- **Inventory method.** Every controller start in
  `src/lib/viewerInstrumentation.ts:359-555` and every timer in
  `src/runtime-host/main.ts:309-364` was followed to its tick body. Server code
  (`src/lib`, `src/app/api`, `src/runtime-host`, tests and fixtures excluded)
  was searched for `setInterval(`/`setTimeout(` schedulers, every
  `withViewerOperation(`/`viewerLoopMonitor.run(` label, synchronous
  `fs.*Sync` calls, `spawnSync`/`execFileSync`, whole-store readers
  (`loadTasks(`, `loadPipelines(`, `loadArchivedPipelines(`,
  `readOnlySnapshot(`, `.snapshot()`), and large `JSON.parse`/`JSON.stringify`
  sites. Each hit on a timer, request or lane path was read at its call site.
  UI polling cadences come from the constants in `src/components` and
  `src/hooks`.
- **Scale method, read-only.** SQLite counts come from `VACUUM INTO` copies made
  in the stage scratch through `mode=ro` connections at 2026-10-18T13:26:04Z
  (`state.sqlite`, `mcp-receipts.sqlite`) and 13:26:16-17Z (registry, runtime
  journal, delivery progress, memory index). Transcript sizes come from `stat`
  only. Process counts were read from `/proc` at 13:41:49Z and the Viewer's
  `VmRSS`/`VmHWM` at 13:41:27Z. Nothing was requested from the serving Viewer,
  no profiler or tracer was attached, and nothing in the live state, the
  registry or any worktree was written.

### Installation scale used throughout

| Store or input | Size on this installation |
| --- | --- |
| `state.sqlite` collections | `pipelines_archive` 935 rows / 110.9 MB of JSON (largest row 1.09 MB); `pipelines` 266 rows / 33.5 MB (largest 515 KB; 199 completed); `role_memory` 3,839 rows / 15.5 MB (largest 2.9 MB); `tasks` 2,436 rows / 9.8 MB; `bridge_reports` 2,069; `spawn_notices` 1,557; `done_items` 843; `state_changes` 36,435 |
| `agent-registry.sqlite` (551 MB copy) | 54,543 hot rows: `deliveryOperationOwners` 12,145 / 106.2 MB, `receipts` 7,352 / 46.8 MB, `conversations` 8,209 / 12.9 MB, `entries` 7,065 / 7.6 MB, `heldDeliveries` 6,941 / 7.1 MB, `lineageEdges` 6,956 / 6.4 MB, `memberships` 5,817 / 1.9 MB; `registry_archive` 61,583; `registry_changes` 100,000 |
| `mcp-receipts.sqlite` | 83,112 receipts |
| Runtime journal (510 MB copy) | `events` 20,000; `consumer_checkpoints` 19,997; `scope_revisions` and `projections` 39,875 each; `entities` 13,220; `producer_receipts` 10,976; `outbox` 8,046; `session_host_metadata` 7,021 |
| Operator board summary | body 35,201,169 bytes, gzip 7,202,063 bytes (manifest of `board-summary-bootstrap.bin`) |
| Other state files read by Viewer paths | `project-catalog.json` 9.4 MB (12,899 files); `files-response-cache-*.json` 47 MB; `voice-companion.json` 5.6 MB; `host-retirement-journal.ndjson` 2.1 MB; `orchestrator-seats.json` 1.4 MB (10 seats); `forge-links.json` 1.4 MB; `lifecycle-journal.json` 1.3 MB; `reaper-state.json` 1.3 MB; `operator-asks.json` 0.8 MB; `limits-history.json` 0.8 MB; `worktree-sweep-report.json` 0.2 MB |
| Transcripts (9 roots) | 8,459 `.jsonl` files, 31.3 GB; median 2.3 MB, p99 24.7 MB, largest 324 MB; 34 files (126 MB) modified in the hour before the count |
| Worktrees | 932 kept across 7 repositories (`worktree-sweep-report.json`, sweep at 12:23:59Z) |
| Retained releases | 84 (`self-update/retention.json`, 13:19:58Z) |
| `/proc` | 816 processes, 291 owned by this user with 6,686 open descriptors and 7.5 MB of `maps` plus `environ` |
| Viewer process | `VmRSS` 5.08 GB, `VmHWM` 11.4 GB, 58 threads, about 22 minutes after the process started at about 13:19Z; 7 Claude and 5 Codex structured agents are its children |
| Agent memory and CPU placement | the `delegatus-agents.slice` is active with 52 scopes; the 2 s `ps` memory watchdog (`src/lib/runtime/agentMemory.ts:336`) starts only when that scope mechanism is unavailable, so it is inferred inactive here |

### Scoping observations from the journal

These counts tell the measurement stage where to look first; it repeats them
over 48 hours with durations. Window: 2026-10-18 07:40:00 to 13:40:00
UTC, read with
`journalctl --user -u delegatus.service --utc --all --no-pager -o short-iso-precise --since "2026-10-18 07:40:00 UTC" --until "2026-10-18 13:40:00 UTC"`
(59,354 lines, 131 MB).

| Line | Count in the window |
| --- | --- |
| `[viewer loop-gap]` | 3,841 Viewer and 369 runtime-host records; 1,357 and 133 of them at least 1 s |
| `[auto merge] <id>: not admitted: …` | 35,503 lines in 456 distinct seconds, up to 84 lines in one second; median 28 s between bursts (p10 15 s, p90 37 s) |
| `[state transaction-hold]` (sync `BEGIN IMMEDIATE` held at least 50 ms) | `tasks` 1,029 holds, 284.4 s summed, largest 794 ms; `pipelines` 438 / 32.9 s / 268 ms; `role_memory` 17 / 3.7 s / 412 ms |
| `[blocking-wait]` with `synchronous: true` | runtime host `snapshot-collect` 19 (largest 542.9 ms); Viewer `registry-lock` 18 (675.7 ms) and `registry-revision-retry` 14 (679.1 ms) |
| `[mcp slow]` (tool calls of at least 2 s) | `curate_rules` 305 calls, `bindingMs` summed 1,370 s, largest 18.2 s (all between 08 and 11 UTC); `bridge_report` 14 / largest 22.2 s; `list_tasks` 13; `stage_report` 11; `create_pipeline` 6 / 12.3 s; `search_memory` 3 / 15.7 s; `search_transcripts` 4 / 11.5 s |

Counts marked "in 48 h" in the inventory use 2026-10-16 13:30:00 to
2026-10-18 13:30:00 UTC with the same command and `-o cat`. The journal reaches
back to 2026-10-13T21:00Z, so the measurement stage has a full 48-hour window. All 4,215 loop-gap lines of a later 6-hour read parsed as JSON; the
longest was 36,390 bytes, below journald's line limit.

## How to read the inventory

Each row names one candidate. Columns:

- **Call site**: the entry point at `c91603e0`, then the heavy step.
- **Trigger, frequency**: what starts it and how often, from the code.
- **Journal label**: the loop-monitor operation (`operations[].name`) and the
  watchdog or span site (`scheduler.sites[].site`, `attribution.slices[].site`)
  a gap shows when this work runs. `none` means the work is invisible in
  gap records except through profiler frames.
- **Scale here**: the input size on this installation.
- **Status**: `open` (a suspect, unmeasured), `covered-by-lane <id>`,
  `prior fix #N` (a merged fix whose residual must be rechecked), `off-main`
  (runs in another process; it can still contend on locks, CPU or I/O), or
  `inactive here`.
- **Measure**: the measurement IDs from the
  [measurement catalogue](#measurement-catalogue).

## Inventory

### T. Timers and background maintenance in the Viewer

| ID | Call site | Trigger, frequency | Journal label | Scale here | Status | Measure |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | `src/lib/pipelines/worktreeSweep.ts:1609` start, `:822` `sweepMergedWorktreesWithRoots` (sync tree walks, `inspectTree`, mount points, `/proc` scans through `tempSweep.ts:124`/`:219`), `:1549` archived pipelines | 10 min after Viewer start (`:136`), then 1 h after the previous pass ends | none at base (`worktrees.sweep` in the lane); profiler frames | 932 trees, 7 repositories, 935 archived pipelines | covered-by-lane `1eb0ab07` | M1, M2, M3 |
| T2 | `src/lib/tempSweep.ts:831` start, `:794` `runTempSweep`, `:807` `scanProcesses()` (`:124`, sync `readdirSync`/`readFileSync` of `fd`, `cmdline`, `maps`, `environ`), `:357`/`:438` sync tree walks, `:780` worktree list | 5 min after Viewer start (`:59`), then 1 h after the previous pass ends | none; completion line `[temp sweep] removed …` | 291 processes, 6,686 fds, 7.5 MB of `maps`+`environ`; 3 roots, 112 held entries in the last report | open (outside `1eb0ab07`, which leaves `tempSweep.ts` alone) | M1, M2, M3, M4 |
| T3 | `src/lib/pipelines/controller.ts:325` `sweepSettledArchive` → `src/lib/pipelines/store.ts:1981` `archiveSettledPipelines` | at most hourly (`controller.ts:91`), from the controller cycle | `pipelines.controller-read` (`store.ts:1985`); `[flow pipeline controller] archived N …` | 266 hot / 935 archived pipelines | open | M1, M2, M3 |
| T4 | `src/lib/pipelines/controller.ts:285` → `src/lib/forge/autoMerge.ts:1012` `scheduleAutoMerge` → `:697` `sweepAutoMerge` (`loadPipelines()` at `:699`, more per lane at `:486`-`:786`), `:917` `sweepTaskFinishes` (`loadPipelines()` at `:919`); one log line per completed lane per pass (`:702`-`:734`) | every controller cycle, debounced to 15 s (`:47`); the journal shows a median of 28 s between passes | none; `pipeline.copy` site during the clones; `[auto merge]` lines | each `loadPipelines()` clones 266 records / 33.5 MB; up to 84 log lines per pass | open | M1, M2, M3, M4 (D3) |
| T5 | `src/lib/pipelines/controller.ts:278` → `src/lib/forge/sweep.ts:294` `scheduleForgeSweep` (`loadPipelines()` at `:101`, `loadTasks()` at `:107`, then `gh`) | every controller cycle, debounced to 30 s (`:21`); live/idle forge intervals 3/30 min | none; `pipeline.copy` during the clone | as T4 plus 2,436 tasks | open | M2, M3, M4 (D1, D3) |
| T6 | `src/lib/done/sweep.ts:42` start → `src/lib/done/world.ts:41-49` `archivedPipelines()` (`loadArchivedPipelines()` at `:46`, cached 60 s at `:39`), `:82` task list | 15 s after start, then every 60 s (`sweep.ts:11`) | `done.frame-source`/`done.media` only around frame copies; `pipeline.copy` during the clone | each archive read clones 935 records / 110.9 MB | open | M2, M3, M4 (D2) |
| T7 | `src/lib/attention/reconcileController.ts:97` start → `:27-56` ports → `src/app/api/files/operatorProjection.ts:819-826` `operatorBoardRepresentation` (`JSON.parse` of the summary body at `:825`), registry snapshot, seat file, reply suggestions | 30 s after start, then every 60 s (`:15`) | none | 35.2 MB summary body per pass | open | M2, M3, M4 (T7 case) |
| T8 | `src/lib/asks/controller.ts:133` start → `:89` `runAsksSweepOnce` (scan nudge, registry snapshot at `:107`, `src/lib/asks/store.ts:129` `loadOperatorAsks` parse) | 60 s after start, then every 15 s (`:19`); enabled here; the registry and file reads run only when a conversation wrote recently | none | 0.8 MB asks file | open | M2, M3 |
| T9 | `src/lib/monitor/seatTickController.ts:2285` start → `:2209` `reconcileSeatTick` loops over every seat project (`:2243`) → `:1332` → `:1450` `check`; sources at `src/lib/monitor/seatTickSources.ts:639-760`: tasks (`:681`), archived pipelines (`:680`, read at `:1695`), lifecycle journal (`:682`, `src/lib/lifecycle/journal.ts:208` reads and parses the whole file on every call), retirement journal window (`:691`), disk pressure (`:686`, see H3), worker asks (`:693-697`, the 35.2 MB summary parse of T7), open pull requests through `gh` (`:699`), liveness (`src/lib/lifecycle/liveness.ts:1089`) | every 5 min (`src/lib/monitor/seatTick.ts:142`), one check per seat project | `seat-tick.check`, `seat-tick.payload`, `seat-tick.audit` | 10 seat records; per check up to the T6 and T7 inputs | open; `44e9fd13` changes reachability accounting only (see below) | M1, M2, M3, M4 |
| T10 | seat-tick-driven role-memory curator and board maintenance (`src/lib/monitor/seatTickSettings.ts:386`, `:402`; `src/lib/boardMaintenance/run.ts:120` loads all tasks) | curator every 6 h and board maintenance every 3 h by default | `memory.curation-*`; the curator agent's calls appear as `[mcp slow] tool=curate_rules` (see H1) | 3,839 role-memory rows; 2,436 tasks | open | M1, M2 |
| T11 | `src/lib/runtime/structuredHostRetirement.ts:1354` start → `:1320` sweep (registry snapshot at `:1124`, per-host checks, journal append) | every 5 min (`:97`) | none; `[host retirement] …` lines | 2.1 MB retirement journal; 12 live structured agents | open | M1, M2 |
| T12 | `src/lib/orchestrator/deputySweep.ts:318` | every 4 s (`:39`) while deputies are live; stops itself otherwise | `orchestrator.deputy` | per live deputy | open, conditional | M2 |
| T13 | `src/lib/links/schedule.ts:123` linked-board sync | 10 s tick (`:17`); a failing peer backs off to 300 s | `links.task-export` (the export runs in the `task-export` helper since #3014) | 4 board links; 213 `[linked boards] sync failed: malformed` lines in 48 h | prior fix #3014 | M2 |
| T14 | `src/lib/prototypeReview/deliveryWorker.ts:267` | 1 s tick (`:36`), pages of 16 tasks | `prototype.state` | 2,436 tasks, 505 review directories | open, bounded by design | M2 |
| T15 | `src/lib/orchestrator/seatChannel.ts:379` | at start (replays revocations of the last 24 h and persisted open rows), then on each seat-channel change | `orchestrator.seat-channel` | 10 seats | open | M2 |
| T16 | `src/lib/telegram/reportRunner.ts:899` (60 s tick, `:89`), `src/lib/telegram/bot/service.ts:1408` poller, `src/lib/telegram/bot/reviewPolls.ts:78-133`, `src/lib/externalRelay/poller.ts:402` (targets refresh 5 min, prune hourly) | continuous long polls and minute ticks | `telegram.review-polls` (a long pending operation present in most gap records), `external-relay.chains` | per bot and relay | open; the pending label alone proves no CPU use | M2, M3 |
| T17 | `src/lib/accounts/migration/controller.ts:445` fast controller, `:259` cycle | every 60 s (`controllerSignal.ts:5`); inventory runs in the `account-migration-controller-worker` process | `controller.account-migration` | 137 account rows | prior fix #2963 | M2 |
| T18 | `src/lib/runtime/accountCreditGuard.ts:259` reconciliation | 1 s | `controller.account-credit-guard`, `account-credit-guard.store` | per guarded account | prior fix #2953 | M2 |
| T19 | `src/lib/selfUpdate/instance.ts:45-48` (1 s active / 5 s idle tick, 60 min poll); `src/lib/selfUpdate/service.ts:831` → `src/lib/selfUpdate/retention.ts:63` `retainReleases`, whose `bytesOf` (`:32`) walks up to 200,000 entries per release with `lstatSync`/`readdirSync` | the retention pass runs after every checkout drain and every finished apply; 17 `[self-update] retention …` lines in 48 h | none | 84 retained releases, each a full checkout with `node_modules` and `.next` | open | M1, M2, M4 |
| T20 | `src/lib/spawnNotice/production.ts:37` prune, `src/lib/runtime/deliveryProgress.ts:130` prune | hourly; every 10 min | none | 1,557 notices; 6,092 progress rows | open, low | M2 |
| T21 | `src/lib/state/durability.ts:1001` backup tick → `:886` `runBackupPassInWorker` | 60 s tick; `VACUUM INTO` runs in the `state-backup` helper | none | 216 MB `state.sqlite` copy | off-main | M5 (I/O) |
| T22 | `src/lib/viewerLoopMonitor.ts:162` `run` and `:189-197` `start` (10 ms tick), `src/lib/loopProfilerServing.ts`, `src/lib/loopProfiler.ts` collect and trim | always; profiler armed for 30 min after each deploy | `loop-profiler.collect`, `loop-profiler.trim` (seen inside gaps at 12:19:20Z and 12:25:12Z) | profile sample cap 4,096, 10 ms interval | open (self-cost) | M2, M3 |

### S. Scanning, transcript index, memory and activity

| ID | Call site | Trigger, frequency | Journal label | Scale here | Status | Measure |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | `src/lib/scanner/fileScanWorker.ts:166-186` frame consume, `:175` `JSON.parse` of each worker frame, `:186`/`:234` publication | every scanner frame; ordinary refresh 300 s and membership refresh 10 s (`src/lib/scanner/scanCache.ts:98`, `:100`); discovery itself runs in the `file-scanner-worker` helper | `controller.scan`; sites `scanner.ipc-frame`, `scanner.ipc-decode`, `scanner.publication`, `scanner.cache-encode`, `scanner.cache-persist` | 12,899 catalogued files; an earlier 30,000-row replay frame was 20.2 MB | prior attribution (`viewer-stall-attribution.md`); open | M2, M4 |
| S2 | `src/lib/search/transcriptFeed.ts:46-47` → `src/lib/search/transcriptSearch.ts:626-686`: each changed transcript is read again from message 0 (`:658`), one `SELECT` per message, one write transaction per file | after every completed scan feed | `transcript.index`; site `transcript.index` | 34 changed transcripts (126 MB) in an hour; p99 file 24.7 MB; 920 MB index | open | M2, M3, M4 |
| S3 | `src/lib/memory/service.ts:39-44` → `src/lib/memory/index.ts:197` `refresh` (sync transaction per changed source) | after every transcript feed | `memory.discovery`, `memory.refresh`; sites of the same names | 1,407 memory files, 7,853 entries | open | M2 |
| S4 | `src/lib/activity/continuous.ts:50` → `src/lib/activity/ingest.ts` (32 MB pieces, 1 GiB pass budget) | after every transcript feed; host pulls every 5 min | `activity.ingest` | 8,459 transcripts / 31.3 GB | covered-by-lane `41be75ea` (changes the work; see below) | M2 |
| S5 | `src/lib/scanner/projectCatalog.ts:295` `writeState` (`JSON.stringify` and `writeFileSync` of the catalog, two `fsync`s), called at `:838` | most completed scans; the file was rewritten twice within one minute during this audit | runs in the `file-scanner-worker` helper | 9.4 MB catalog | off-main | M5 (I/O) |
| S6 | `src/lib/scanner/describe.ts:434` parses `project-catalog.json` for checkouts with a separate Git directory | per unresolved cwd of that layout | none | 9.4 MB | open, rare | M2 |

### P. Pipelines controller, lane loops and stage launch

| ID | Call site | Trigger, frequency | Journal label | Scale here | Status | Measure |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | `src/lib/pipelines/controller.ts:336-352` `runPhase` (phases `pipelines`, `scan`, `flows`), `src/lib/pipelines/controllerPass.ts:18`, engine lane work at `src/lib/pipelines/engine.ts:10775` | 30 s watchdog (`controller.ts:93`), runtime and request signals, 45 s request deadline (`controllerSignal.ts:5`) | `controller.*`, `pipelines.controller-schedule`, `-lane`, `-mutation`, `-checkpoint`, `-decode`, `-read`, `-select`, `-materialize`, `-job`; 717 `pipelines phase exceeded its deadline` and 206 `scan phase exceeded its deadline` lines in 48 h | 266 hot pipelines, 27 tick-work rows | prior fix #2942, #3039; open residual | M1, M2, M3 |
| P2 | 50 ms revalidation timers that re-read a pipeline while Git or exec work runs: `src/lib/pipelines/engine.ts:5067` (remote action), `:6346-6349` (stage activation: `JSON.stringify(findPipelineRecord(id))` every 50 ms), `:8303` (provisioning jobs), `:10128` (publication admission), `:10259` (spawn retry), `:10384` (review ingress hosts); `findPipelineRecord` (`src/lib/pipelines/store.ts:2021`) is a keyed SQL read, `JSON.parse`, `structuredClone` and revive (`src/lib/state/sqliteStateStore.ts:1432-1438`, `store.ts:1474`) | 20 times a second per running activation or Git step | `pipeline.copy` site; the enclosing `pipelines.controller-job` or `-lane` | hot records average 126 KB, largest 515 KB | open (the whole-collection variant, issue #2929, now reads the immutable list at `engine.ts:10424`) | M2, M3, M4 (P2 case) |
| P3 | stage and agent launch: `src/lib/runtime/codexAppServerHost.ts:1479` runs `codex --version` (`src/lib/accounts/codexPinnedProtocol.ts:39`, `spawnSync`, 5 s timeout) and `:1485` runs `codex features list` (`src/lib/agent/codexSpawnPolicy.ts:75`/`:90`, `spawnSync`, no cache); `src/lib/runtime/agentMemory.ts:515` `systemctl --user show` through `execFileSync` for each headroom check (`src/lib/pipelines/engine.ts:1876`) | every Codex host open (launch, resume, recovery); every launch admission | none; the `pipelines.controller-lane` or `-job` around it | 5 live Codex agents at the count | open | M2, M3, M4 (X case) |
| P4 | first CPU placement per Viewer process: `src/lib/runtime/cpuPlacement.ts:215-223` (`systemctl --user set-property`, then a `systemd-run --scope` probe in `verifyCpuScope`, both `execFileSync` with 5 s timeouts) | once per process and settings key, again after a failure | none | one per start | open, startup only | M2 |
| P5 | pipeline evidence: `src/lib/pipelines/store.ts:1201` `preparePipelineEvidence` (compact reads), startup admission at `:1779` | storage-health polls, ownership checks, startup | `pipelines.evidence`, `pipelines.startup-admission`; sites `pipeline.validate`, `pipeline.evidence` | 825 evidence rows | prior fix (#2905 line of work); open residual | M2 |
| P6 | other full mutable hot clones: `loadPipelines()` at `src/lib/flows/engine.ts:1310`, `:1424`, `src/lib/flows/decisions.ts:124`, `src/lib/forge/resolve.ts:161`, `src/lib/pipelines/runtimeSwitchFence.ts:34`, `src/lib/pipelines/engine.ts:3290`, `:5040`, `:11953`, `:14566`, `:14654`, `src/lib/agent/spawnCommand.ts:201`, `src/app/api/tasks/[id]/route.ts:93`, `src/app/api/pipelines/[id]/route.ts:140`, `src/app/api/onboarding/route.ts:20` | per flow decision, spawn command, task or pipeline write, stage completion | `pipeline.copy` site | 33.5 MB per call | open | M3, M4 (D3) |

### D. State stores (bun:sqlite is synchronous)

| ID | Call site | Trigger, frequency | Journal label | Scale here | Status | Measure |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | tasks: `src/lib/tasks/store.ts:267` `loadTasks` → `:538` `collection.snapshot()` (`sqliteStateStore.ts:1245` clones every row with `structuredClone`, `tasks/store.ts:366`), then `stateFromBody`; 50 call sites, among them T5, T9, T10, `src/app/api/orchestrator/seat/route.ts:124` (H5), `src/lib/forge/autoMerge.ts:879`, `src/lib/pipelines/engine.ts:3384`, `:9271`, `:9398`, `:11903`, `:11936`, `:13218`-`:13595`, `src/lib/mcp/bindings.ts:2192`-`:7234`. Writes: `:751` `mutateTasks` → `:763` `mutateLinkedTasks` read all tasks, snapshot them and diff inside `BEGIN IMMEDIATE` (`sqliteStateStore.ts:520-541`) | every caller above; writes from the Viewer, the `mcp-tasks` helper and embedded workers (`stateWait.processKind: embedded`) | none for the clone; `[state transaction-hold] { collection: "tasks", heldMs }` for writes (no process field); `state-write-lock` waits of every other writer | 2,436 tasks / 9.8 MB | open | M1, M2, M4 (D1 cases) |
| D2 | archived pipelines: `src/lib/pipelines/store.ts:1958` `loadArchivedPipelines` = `archiveStore().snapshot()`, a `structuredClone` plus revive per record (`:1474`); callers T6 (`src/lib/done/world.ts:46`), T9 (`src/lib/monitor/seatTickSources.ts:680`), `src/lib/taskAlbum/world.ts:20`, `src/lib/orchestrator/boardReportRun.ts:344`, T1 (`worktreeSweep.ts:1549`), startup (`src/lib/viewerInstrumentation.ts:345`) | about once a minute from T6 alone, plus every seat check that reaches pull requests | `pipeline.copy` site | 935 records / 110.9 MB | open | M2, M3, M4 (D2) |
| D3 | hot pipelines: `src/lib/pipelines/store.ts:1103` `loadPipelines` (same clone path) | T4 twice or more per pass, T5 per pass, P6 | `pipeline.copy` site | 266 / 33.5 MB | open | M2, M3, M4 (D3) |
| D4 | registry read view: `src/lib/agent/registry.ts:5621` → `src/lib/agent/sqliteRegistryStore.ts:1397`-`:1399` → `:1508-1517` (cached by revision and store stamp, incremental refresh, otherwise `loadSnapshot(true)`, a full decode); 345 `readOnlySnapshot(` call sites, including T7, T8, T11, the structured delivery controller (A3) and the runtime host (R2) | after any registry write by any process | site `registry.snapshot` (the 2026-10-15 audit's largest attributed slice, 325 ms), `registry.keyed` | 54,543 hot rows, about 189 MB of JSON | prior fixes #2958, #3013, #3032, #3043; open residual | M2, M4 (D4) |
| D5 | registry write admission that still waits synchronously: `src/lib/agent/sqliteRegistryStore.ts:3124` (`registry-revision-retry`) and `:3177` (`registry-lock`) | registry writes from the Viewer | `[blocking-wait]` with `synchronous: true`; `subject` is often a minified name (`l`, `bf`, `aT`, `A`) | see scoping table | prior fix #2953 (async admission for other paths); open | M1, M2 |
| D6 | role memory: curator reads and applies (`src/lib/memory/curation/read.ts`, `apply.ts`, `admission.ts:71`) through the H1 endpoint | curator passes (T10) | `memory.curation-admission`, `memory.curation-status`; `[mcp slow] tool=curate_rules` | 3,839 rows / 15.5 MB, largest row 2.9 MB | prior fixes #3032, #3036; open | M1, M2 |
| D7 | state write admission for everyone else: `waitForStateLock` (`src/lib/state/lockWait.ts`) | every state write | `[blocking-wait] site=state-write-lock`, `synchronous: false` (waits are asynchronous; the holder's transaction is the block, see D1) | 36,435 change rows | prior fix #3016; context for D1 | M1 |
| D8 | lifecycle journal file: `src/lib/lifecycle/journal.ts:208` `readJournalFile` parses the whole file and merges worktree recoveries on every read; `appendLifecycleEvents` (`:240`) reads it inside a file transaction | seat checks (T9), projector appends, the `lifecycle_events` tool | none | 1.3 MB | open, low | M4 |

### H. HTTP, MCP and streaming handlers

All Next request handling sits inside the umbrella operation `http.render`
(`src/lib/nextRenderMonitor.ts:29`), which also stays pending for open streams;
its presence in a gap proves no CPU use by itself.

| ID | Call site | Trigger, frequency | Journal label | Scale here | Status | Measure |
| --- | --- | --- | --- | --- | --- | --- |
| H1 | shared MCP endpoint: `src/app/api/mcp/route.ts:10` → `src/lib/mcp/http.ts` → bindings in `src/lib/mcp/bindings.ts` (for example `curate_rules` at `:7919`). The HTTP transport is the default for structured launches that carry a spawn capability (`src/lib/agent/spawnPolicy.ts:168-191`). On it, every tool runs inside the Viewer, on a server object and transport built per request (`src/lib/mcp/http.ts:254-256`), except `list_tasks`, `get_task`, `create_task` and `update_task`, which go to the `mcp-tasks` helper (`http.ts:240-244`, `src/lib/mcp/taskChannel.ts:7`). Stdio MCP servers run their tools in their own process. `[mcp slow]` is written at `src/lib/mcp/server.ts:3383` | every tool call of every structured agent | `mcp.receipts`, `mcp.tasks.executor`, `mcp.project-prefix`; no per-tool operation label; `[mcp slow] tool=… bindingMs=…` for calls of at least 2 s (the line has no process field; the launcher writes both children's output) | 12 live structured agents; 83,112 receipts | open | M1, M2, M3, M4 |
| H2 | board poll: `src/app/api/files/operatorProjection.ts:595-608` `GET` (`files.get`), storage health at `:697` (`files.health`); projection in the `files-response-worker`; main-thread delta, clone and encode | every 10 s per visible tab, 30 s hidden (`src/hooks/useFiles.ts:31`, `:44`) | `files.get`, `files.health`; sites `files.scan`, `files.delta`, `files.clone`, `files.encode`, `files.worker` | 35.2 MB summary body | prior fixes (`board-poll-payload.md`, `cold-board-start.md`); open residual | M2, M4 |
| H3 | resources: `src/app/api/resources/route.ts` → `src/lib/resources.ts:2661-2671`: `src/lib/resourceViewerTree.ts:217-224` walks the Viewer's process tree through sync `/proc` reads, then `src/lib/state/diskPressure.ts:250` `readDiskPressure` (30 s cache, `:36`): `scanProcesses()` at `:285`, `loadPipelinesForList`, the sweep report, then `statSync` plus `statfsSync` per root (`:60-62`) for every worktree root (`diskVolumes`, `:110`) and a SHA-256 per temp view | every 30 s per open tab (`src/components/ResourcesFooter.tsx:17`), the MCP `resources` tool, and T9 | none | 932 worktree roots; the T2 `/proc` scale | open | M2, M3, M4 |
| H4 | needs-you read: `src/lib/attention/needsYouRead.ts:262-267` (the 35.2 MB summary parse of T7, then tasks, pipelines, dismissals, bridge log, registry snapshot) | the needs-you API and tool, the board report run (`src/lib/orchestrator/boardReportRun.ts:387`), seat checks | none | as T7 | open | M2, M4 (T7 case) |
| H5 | seat panel: `src/app/api/orchestrator/seat/route.ts:124` loads all tasks whenever the project has a seat | every 6 s per tab showing a seat (`src/components/orchestrator/useOrchestratorSeat.ts:14`) | none | 2,436 tasks | open | M4 (D1) |
| H6 | other UI polls, server cost per request unmeasured: decisions every 3 s (`/api/projects/decisions`), delivery progress 3 s (`/api/runtime/delivery-progress`), log bus 1.2 s (`/api/logs`), self-update feed 1 s while shown, host targets 5 s, timeline 7 s, board state 10 s, runtime snapshot fallback 10 s, report log 10 s, telegram reports 20 s, done items 30 s, bot 30 s, task album 45 s, limits 60 s, seat-tick settings 60 s | cadences from the constants under `src/components` and `src/hooks` | `http.render` only | one view session recorded in `view-presence.json` at read time | open | M4, M7 |
| H7 | streams: `src/app/api/logs/stream/route.ts` with `src/lib/logTailStream.ts:124`, `:127` (heartbeat and restat timers per stream), `src/app/api/runtime/stream/route.ts`, `src/app/api/streams/route.ts` | per open stream | `http.render` (pending) | per tab | open, low | M2 |

### A. Structured agent hosts and delivery inside the Viewer

The Claude and Codex agents are children of the Viewer process, so their
output is parsed on its main loop.

| ID | Call site | Trigger, frequency | Journal label | Scale here | Status | Measure |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Claude stream JSON: `src/lib/runtime/claudeStreamBrokerHost.ts:755-757` (stdout `data`) → `:1464` `acceptStdout` (re-slices the buffer after each line) → `:1479-1482` `acceptMessage` (`JSON.parse` per line; partial-message events are enabled for these hosts) | every stdout chunk of every live Claude agent | none | 7 live Claude agents; line size up to the structured image cap (`:366`) | open | M3, M6, M4 |
| A2 | Codex app-server JSON-RPC: `src/lib/runtime/codexAppServerHost.ts:1434` → `:3911` `acceptStdout` → `:4034` `JSON.parse` | every stdout chunk of every live Codex agent | none | 5 live Codex agents | open | M3, M6, M4 |
| A3 | delivery: `src/lib/runtime/structuredDeliveryController.ts:1331` drain wake, settlement sweep every 15 s (`:123`), hostless settle every 60 s (`:607`), 29 registry-snapshot reads in this file; pages at `src/lib/runtime/deliveryEffectPages.ts:40` | each published runtime event, plus the sweeps | `runtime.delivery-wake`, `runtime.delivery-list`, `delivery.inbox-batch`; 1,877 `queue drain failed … runtime host request timed out` lines in 48 h | 6,941 held deliveries, 12,145 delivery owners | open | M1, M2, M3 |
| A4 | runtime host RPC client: `src/lib/runtime/client.ts:394` (`runtime.rpc`), reply decode; activity snapshot once per controller pass (`src/lib/pipelines/runtimeReads.ts:6-16`) | every RPC | `runtime.rpc`; sites `runtime.parse`, `rpc.receive`, `rpc.frame` | snapshot replies of 6.8-11.1 MB (cbaaf29a) | prior fix #1987 (linear chunk scanning, per `cbaaf29a`); open residual | M2 |

### R. Runtime host process

| ID | Call site | Trigger, frequency | Journal label | Scale here | Status | Measure |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | snapshot: `src/runtime-host/journal.ts:1521-1537` `snapshotJson`; the cache keys on `total_changes()`, so any write forces `snapshotAt` (`:1533`, `snapshot-collect`) and `JSON.stringify` (`:1534`, `snapshot-serialize`) on the next snapshot RPC | every `snapshot` RPC after a change (`src/runtime-host/host.ts:151`) | `[blocking-wait] site=snapshot-collect` / `snapshot-serialize` (sync); sites `runtime.collect`, `runtime.stringify` | 7,021 sessions; cbaaf29a measured projection p50 205-277 ms on a copy | open (cbaaf29a item 5, deferred there) | M1, M2 |
| R2 | journal maintenance: `src/runtime-host/main.ts:332-343`: `agentRegistry().readOnlySnapshot()` in the host (D4 path without the prepared reader) and `settleStalePendingEffects` | every 60 s | none in the host; site `registry.snapshot` | 54,543 registry rows | open | M1, M2, M4 (D4 cold) |
| R3 | producer-receipt sweep: `src/runtime-host/main.ts:318-327` → `src/runtime-host/journal.ts:2173` (budget 4,096) | every 10 s | none; `[runtime journal] receipt sweep removed …` every 15 min | 10,976 receipts | open, bounded | M2 |
| R4 | vacuum: `src/runtime-host/main.ts:345-361` (freelist inspection inline, vacuum in a child) | hourly check, at most daily vacuum | none | 510 MB journal | cbaaf29a: freelist calls 0.009-0.045 ms | M2 |
| R5 | RPC handlers: `src/runtime-host/host.ts:143-353` (`append` with checkpoints, `session-read`, `events` replay, `wait`, `effect-batch`, native queue, deployments) | every Viewer and MCP call | none per method | 20,000 events, 19,997 checkpoints | prior fix #3045 (checkpoint deletion); open residual | M1, M2 |
| R6 | the runtime host starts the loop monitor (`src/runtime-host/main.ts:33-34`) but no loop profiler | always | gap records with `role: runtime-host`; no `jsProfile` | 369 records in the scoping window | coverage gap | M2 |

### X. Synchronous child processes and Git

| ID | Call site | Trigger | Status |
| --- | --- | --- | --- |
| X1 | `codex --version` and `codex features list` (P3) | every Codex host open | open (P3) |
| X2 | `systemctl --user show` (P3), `systemctl set-property` and `systemd-run` probe (P4) | each launch admission; once per process | open (P3, P4) |
| X3 | `src/lib/state/hostTempViews.ts:38` `enterStageHost` (`nsenter`, `spawnSync`, 2 s) from `src/lib/state/diskPressure.ts:79` | only when `/proc/1/root` is unreadable (container installs) | inactive here (checkout install) |
| X4 | `src/lib/agent/cli.ts:295` `codex mcp list`; `src/lib/git/agentForgeCredentials.ts:167` login-shell probe; `src/lib/selfUpdate/actions.ts:217`; `src/lib/resources.ts:862-938` `ps` | terminal launches; forge credential setup; self-update actions; non-Linux process listing | open, low; inactive here for `ps` |
| X5 | Git and `gh`: run asynchronously (`src/lib/pipelines/git.ts`, `src/lib/forge/sweep.ts:304`, `src/lib/pipelines/worktreeSweep.ts:1401`); their outputs are parsed on the main loop, and P2's 50 ms timers run while they wait | lanes, forge and merge sweeps, seat checks | covered by P2, T4, T5, T9 |

### G. Process-wide: allocation, GC and logging

| ID | Source | Evidence so far | Status | Measure |
| --- | --- | --- | --- | --- |
| G1 | Large transient allocations from D1-D3 clones, the T7/H4 35.2 MB parse, D4 full loads, A1/A2 line parsing, S1 frames and R1 replies | Viewer `VmHWM` 11.4 GB 22 minutes after start; RSS 3.3 → 7.4 GB inside 10:31-11:01Z on 770f18f9 (`30c04d79`); RSS +2.0-2.8 GB inside single gaps (`1c84dacd`) | open | M3, M4 (heap deltas), M5 |
| G2 | Garbage collection itself | `gc.source` is `unavailable` with `gc-entry-unsupported`; heap counters are unavailable on Bun; 85-98 % of long-gap watchdog samples are `unknown-runtime-or-native` in every audit; native sampling is blocked (`perf_event_paranoid` = 4, no capabilities, `1c84dacd`) | coverage gap | M3, M4, M5 |
| G3 | Log volume on the main loop: `[auto merge]` (T4) writes up to 84 lines per pass; `[state transaction-hold]` writes multi-line objects | see scoping table | open, low | M2 |

### Off-main processes that can still contend

`file-scanner-worker`, `files-response-worker`,
`account-migration-controller-worker`, and the leased helpers `task-export`,
`mcp-tasks`, `transcript-search-query`, `state-backup` (and `worktree-sweep`
once `1eb0ab07` lands). They do not run on the Viewer loop. They share the
SQLite write lock (D1, D7), CPU and disk, and their replies are decoded on the
Viewer loop (S1, H2, H1).

## Covered-by-lane assessment

| Lane | Scope, from its diff | Does it remove its share? | Remaining main-loop work in the same area |
| --- | --- | --- | --- |
| `1eb0ab07` worktree sweep (build stage, uncommitted when read) | the hourly sweep asks one leased `worktree-sweep` child for a pass; inputs, physical paths, `/proc` scans, proofs, measurement, quarantine and report persistence run there; a persisted per-tree cache with bounds; `worktrees.sweep` labels the Viewer's wait. Its fixture (930 trees, 93,930 files) measured a maximum loop interval of 6,017-6,075 ms before and 2.8-10.2 ms after, three passes each | Yes, for T1 and for the frames of the 12:25:12Z capture (537 of 545 samples under `worktreeSweep.ts:822`). Not proven for the rest of the 12:24-12:26Z cluster (9.6 s, 9.5 s, 7.4 s, 6.3 s, 6.2 s gaps), whose records enclose `seat-tick.check`, `runtime.rpc`, `runtime.delivery-list`, `runtime.delivery-wake` and `controller.pipelines` and carry no profile because of the cooldown; the pass ran from 12:23:59Z (the report's `at`, set when the pass starts, `worktreeSweep.ts:844`) to its completion line at 12:35:23Z | T2 (its own hourly pass five minutes after start), H3 (`scanProcesses` and per-worktree `statfs` every 30 s), reads of `worktree-sweep-report.json` |
| `e9a56ff7` profiler coverage (#3051, merged, serving since 13:19:58Z) | removes the cooldown; every gap of at least 2 s says `captured`, `unavailable`, `not-armed` or `skipped` | Instrumentation; it removes no stall | Profiles exist only for 30 minutes after each deploy, only in the Viewer (R6), at 10 ms sampling, and leave native and GC frames unnamed (G2) |
| `41be75ea` activity token usage (#3048, UI stage running) | adds a usage reader to S4: yields between reads (`readFrom`), a usage backfill from offset 0 for every transcript under the same 1 GiB pass budget, `maintainUsage` and a pending-bytes scan inside a state-lock transaction at the end of each pass, store opens and commits through `waitForStateLock`. Its replay of 332 files (909 MB) logged a largest loop delay of 149.6 ms | It is a feature lane. It adds work to S4 and adds yields; on this installation the backfill spans 29.1 GiB (31.3 GB), at least 30 passes of 1 GiB | S4 after deploy: `activity.ingest` and `activity.usage-backfill` durations, gaps during backfill passes, and the end-of-pass transaction |
| `44e9fd13` seat-tick reachability (#3050, fix stage) | stops MCP health, queued delivery and host loss from opening false outage windows (`seatTickController.ts:1649-1653`, `:1984`); adds a bound host probe that calls `sources.liveness(… limit: 1)` at the start of every check | No. It changes no source read of `check` (`seatTickController.ts:1450`, `liveness.ts:1089`, captured at 12:19:20Z) and adds one liveness probe per check | T9 as listed |

## Prior fixes and the residual each leaves

| Merged fix | What it removed | Residual to recheck (label or site) |
| --- | --- | --- |
| #3036 | privacy filtering for stage launches and bridge reports moved to a shared cached matcher off the main thread; `1c84dacd` measured parent CPU 2.65-2.86 s → 23-27 ms | `memory.privacy.*` sites, `stage launch` gaps |
| #3032 | curator admission and liveness stopped hydrating full history (249 MB per call) | `history.*`, `memory.curation-admission`; `history.projection` lock waits (250 in the scoping window, largest 14.4 s, asynchronous) |
| #3013, #3043 | receipt reads under page rendering use index seeks; selected liveness receipts are seeked | `registry.keyed`, `pipelines.delivery-liveness` |
| #3014 | linked-board task export runs in a helper and stops cloning role memory per task | T13, `links.task-export` |
| #3016 | one lock deferral no longer produces about 1,000 log lines | `StateLockDeferredError` line counts |
| #2942, #3039 | bounded controller work per tick; global sweeps outside lane scope | P1 deadlines |
| #2953 | asynchronous registry write admission; bounded credit-guard ticks | D5 synchronous waits that remain |
| #2958 | registry writes touch only changed rows; cached writer snapshot | D4 refresh and full loads |
| #2963 | idle worker CPU (incremental account migration, no refused reaper retries) | T17 |
| #2930 | MCP writes routed through the Viewer; task tools isolated in a helper | H1 (the other tools now run in the Viewer) |
| #3045 | runtime-host checkpoint deletion touches only retiring events | R5 append cost |

## Attribution gaps the measurement must work around

1. Profiles exist only in the 30 minutes after a deployed revision first
   starts, only in the Viewer. On `9c889c07` that window runs from about
   13:19Z to 13:49Z with no cooldown. The first T2 pass completed at
   13:37:23Z and the first T1 pass at 13:40:57Z, both inside it, and 19 Viewer
   gaps of at least 2 s since 13:15Z carry `jsProfile.status: captured`.
   Later hourly passes fall outside any armed window unless another deploy
   lands.
2. Profile frames name compiled chunks (`.next/server/chunks/<n>.js:<line>`).
   The serving release ships no source maps (`ls … .next/server/chunks/*.map`
   counts 0), so each frame is mapped by reading that line of the chunk and
   matching its identifiers in `src/`; line 1 of a large chunk stays ambiguous.
3. Unlabelled work: T1 at base, T2, T4, T5, T7, T8, T11, T19, T20, P3, P4, D1 clones,
   D8, H3, H4, H5, A1, A2, R2, R3. In gap records it appears only as
   `unknown-runtime-or-native`, a span site such as `pipeline.copy`, or a
   profile frame.
4. `[mcp slow]`, `[state transaction-hold]` and synchronous `[blocking-wait]`
   lines carry no process identity usable from the journal: the launcher
   writes the output of both children, so `_PID` is the launcher. Loop-gap
   records carry `role` and `pid` in their JSON.
5. MCP calls under two seconds leave no line, and no tool-level operation
   label exists.
6. Requests carry no route in `requests.records`; the per-route request mix
   is not in the journal.
7. GC and native frames cannot be attributed in production (G2).

## Measurement catalogue

All production reads are read-only: the journal, `/proc` of our own
processes, and state files copied first. Heavy work runs on scratch copies
with an isolated environment through the supplied `scripts/gate-slot.sh`.
Record UTC bounds, `/proc/loadavg` at the start and end, the live and running
agent counts (`agent_fleet`), and the serving revision with every number.

### M0. Window capture

```sh
SINCE="<UTC start, 48 h before the read>"; UNTIL="<UTC end>"
journalctl --user -u delegatus.service --utc --all --no-pager -o short-iso-precise \
  --since "$SINCE" --until "$UNTIL" > "$TMPDIR/journal.txt"
```

About 1 GB for 48 hours at the scoping rate; keep it in the stage scratch.
Each line is `<timestamp> <host> <unit>[<launcher pid>]: <message>`. The
message prefixes used below:

| Prefix | Fields | Written at |
| --- | --- | --- |
| `[viewer loop-gap] {json}` | `gapMs`, `utc` (end of the gap), `role` (`viewer` or `runtime-host`), `pid`, `revision`, `sequence`, `operations[]` (`name`, `durationMs`, `completed`, `count`, `readBytes`, `decodedJsonBytes`), `pendingOperations`, `attribution.slices[]` (`site`, `kind`, `maxMs`, `overlapMs`), `scheduler.sites[]` (`site`, `samples`), `scheduler.stall.site`, `scheduler.rss` (`beforeBytes`, `afterBytes`, `deltaBytes`, `peakBytes`), `scheduler.runMs`, `queueMs`, `throttleMs`, `readBytes`, `readCalls`, `reads`, `requests`, `gc`, `heap`, `jsProfile` (`status`; when `captured`: `frames.samples` and `frames.rows[]` with `function`, `file`, `line`, `self`, `total`) | `src/lib/viewerLoopMonitor.ts:77-140`; gaps above 500 ms |
| `[blocking-wait] {json}` | `site`, `label`, `subject`, `durationMs`, `synchronous`, `role`, `stateWait.callSite`, `stateWait.processKind`, `stateWait.pid`, `at` | `src/lib/blockingWaits.ts`; from 50 ms for state-lock, lease and file-transaction sites, from 250 ms for others |
| `[state transaction-hold]` followed by `collection: "…",` and `heldMs: N` on the next journal lines | collection, held milliseconds | `src/lib/state/sqliteStateStore.ts:539`; from 50 ms |
| `[mcp slow] tool=… callerMs= httpMs= claimMs= bindingMs= completionMs= serializationMs= serviceTotalMs= replayMs=` | per-phase wall milliseconds | `src/lib/mcp/server.ts:3383`; calls of at least 2 s |
| `[performance summary] {json}` | `role`, `revision`, `requests` | every 60 s per process |
| completion lines | `[worktree sweep] removed …`, `[temp sweep] removed …`, `[flow pipeline controller] archived …`, `[self-update] retention …`, `[host retirement] …`, `[runtime journal] receipt sweep …`, `[auto merge] …` (one burst per pass), `[seat tick] …`, `[linked boards] …`, `[flow pipeline controller] … exceeded its deadline` | the T, P and R call sites above |

### M1. Gap table with candidate overlap

Parse every `[viewer loop-gap]` line into one row per gap with
`start = utc - gapMs` and `end = utc`. Build one timeline per candidate:

- from completion lines: T1, T2 (a pass ends at its line; its start is the
  previous end plus the interval, or the Viewer start plus 5 or 10 minutes
  after a deploy), T3, T11, T19, R3;
- T4 passes: each distinct second holding `[auto merge]` lines;
- from loop-gap `operations[]`: for an operation with `completed: false`,
  its start is `utc - durationMs`; use this for `seat-tick.check`,
  `controller.*`, `pipelines.*`, `runtime.*`, `activity.ingest`,
  `transcript.index`, `memory.*`, `files.*`, `mcp.*`;
- H1: `[mcp slow]` lines, each covering `serviceTotalMs` before its
  timestamp;
- D1, D5, R1: `[state transaction-hold]` and synchronous `[blocking-wait]`
  lines, each covering its duration before its timestamp;
- deploys: `kind: apply` rows of a copy of `self-update/history.jsonl`; seat
  checks: `at` of a copy of `seat-tick/runs.ndjson`.

For every gap of at least 1 s, record the overlapping candidates, the summed
gap time per candidate (a gap with several overlaps counts toward each, so
report overlap counts beside the sums), and the gaps that overlap nothing.
Report both roles separately, over the full 48 hours, and per hour.

### M2. Label and site shares

Over the same gaps: summed `gapMs` grouped by each `operations[].name`
present, by `scheduler.stall.site`, by the most-sampled `scheduler.sites[]`
entry, and by `attribution.slices[]` entries with `kind == "sync"`
(`site`, `maxMs`). Per candidate in the inventory, state which label or site
it would show and whether that label or site appears. Count `[blocking-wait]`
and `[state transaction-hold]` lines per `site`/`collection` per hour.

### M3. Profile frames

For gaps with `jsProfile.status == "captured"`, aggregate `frames.rows` by
`file:line:function` (sum `self` and `total`, and the number of gaps each
frame appears in). Map chunk frames with

```sh
REL="$HOME/.cache/delegatus/self-update/<install-id>/releases/<serving revision, 12 chars>"
sed -n '<line>p' "$REL/.next/server/chunks/<n>.js" | cut -c1-2000
```

then search a distinctive identifier or string literal of that line with
`grep -rnF '<literal>' src/` in the scratch export. Record each mapping as
mapped (one source location) or ambiguous. Assign mapped frames to inventory
IDs by file. Use the `9c889c07` arm window first, then every later deploy's
window inside the 48 hours.

### M4. Replays on scratch copies

Never against the operator's state, registry or worktrees.

```sh
X="$TMPDIR/export"; S="$TMPDIR/state"; mkdir -p "$X" "$S" "$TMPDIR/home" "$TMPDIR/xdg" "$TMPDIR/tmp"
git -C "<this worktree>" archive <serving revision> | tar -x -C "$X"
ln -s "$REL/node_modules" "$X/node_modules"        # read-only use of the serving release's dependencies
for db in state.sqlite agent-registry.sqlite mcp-receipts.sqlite memory-index.sqlite delivery-progress.sqlite; do
  python3 -I -c 'import sqlite3,sys; c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True); c.execute("VACUUM INTO ?", (sys.argv[2],))' \
    "$HOME/.config/delegatus/state/$db" "$S/$db"
done
for f in board-summary-bootstrap.bin lifecycle-journal.json orchestrator-seats.json worktree-sweep-report.json operator-asks.json; do
  cp -p "$HOME/.config/delegatus/state/$f" "$S/$f"
done
cd "$X" && HOME="$TMPDIR/home" XDG_CONFIG_HOME="$TMPDIR/xdg" TMPDIR="$TMPDIR/tmp" LLV_STATE_DIR="$S" \
  LLV_VIEWER_CONTROL_URL="http://127.0.0.1:<closed port>/" LLV_TEMP_SWEEP=dry-run LLV_WORKTREE_SWEEP=dry-run NODE_ENV=production \
  bash <supplied gate-slot.sh> bun ./probe.ts <case> 6
```

Check the port is closed before use (a refused `bash -c '</dev/tcp/127.0.0.1/<port>'`).
`probe.ts` lives in the scratch export, so the `@/` paths resolve:

```ts
import os from "node:os";
import fs from "node:fs";
import { heapStats } from "bun:jsc";

const [name, runsText = "6"] = process.argv.slice(2);
const state = process.env.LLV_STATE_DIR!;
const cases: Record<string, () => Promise<() => unknown>> = {
  D1: async () => { const t = await import("@/lib/tasks/store"); return () => t.loadTasks().length; },
  "D1-write": async () => { const t = await import("@/lib/tasks/store"); return () => t.mutateTasks(() => ({ tasks: undefined, result: 0 })); },
  D2: async () => { const p = await import("@/lib/pipelines/store"); return () => p.loadArchivedPipelines().length; },
  D3: async () => { const p = await import("@/lib/pipelines/store"); return () => p.loadPipelines().length; },
  D4: async () => { const r = await import("@/lib/agent/registry"); return () => Object.keys(r.agentRegistry().readOnlySnapshot().entries).length; },
  P2: async () => { const p = await import("@/lib/pipelines/store"); const id = process.env.PROBE_PIPELINE_ID!; return () => JSON.stringify(p.findPipelineRecord(id)).length; },
  T2: async () => { const s = await import("@/lib/tempSweep"); return () => s.scanProcesses().processes.length; },
  T7: async () => {
    const bytes = fs.readFileSync(`${state}/board-summary-bootstrap.bin`);
    const head = bytes.readUInt32BE(0);
    const manifest = JSON.parse(bytes.subarray(4, 4 + head).toString());
    const body = bytes.subarray(4 + head, 4 + head + manifest.bodyBytes).toString();
    return () => Object.keys(JSON.parse(body)).length;
  },
};
const run = await cases[name]!();
let last = performance.now(), maxGap = 0;
const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last - 10); last = now; }, 10);
for (let index = 0; index < Number(runsText); index++) {
  await new Promise(resolve => setTimeout(resolve, 200));
  maxGap = 0; last = performance.now();
  const heap = heapStats().heapSize, rss = process.memoryUsage().rss, cpu = process.cpuUsage(), started = performance.now();
  const result = await run();
  const wallMs = performance.now() - started, used = process.cpuUsage(cpu);
  await new Promise(resolve => setTimeout(resolve, 50));
  console.log(JSON.stringify({ name, index, wallMs, cpuMs: (used.user + used.system) / 1000, maxLoopGapMs: maxGap,
    heapDeltaBytes: heapStats().heapSize - heap, rssDeltaBytes: process.memoryUsage().rss - rss,
    result: typeof result === "number" ? result : null, loadavg: os.loadavg() }));
}
clearInterval(timer);
```

Report run 0 (cold, it includes the first cache fill) apart from runs 1-5.
D4 is the cold full load only when run 0 of a fresh process; the incremental
refresh needs writes between reads and is measured through M2's
`registry.snapshot` slices instead. Choose `PROBE_PIPELINE_ID` as the largest
hot row of the copy
(`SELECT row_key FROM state_rows WHERE collection = 'pipelines' ORDER BY length(value_json) DESC LIMIT 1`).
T2 reads the machine's real `/proc`, read-only. Further cases follow the
same shape: S2 (`indexTranscriptSources` from `src/lib/search/transcriptSearch.ts`
on copies of the five largest transcripts changed in the last hour, into an
empty index under `$S`), H3 (`readResourcesWithDiagnostic` with the copied
pipelines; it `stat`s and `statfs`es the real worktree roots, read-only), T19
(a verbatim copy of the private `bytesOf` at `src/lib/selfUpdate/retention.ts:32`
over one retained release, read-only), X1 (`installedCodexVersion` and `readCodexFeatures` with the
isolated HOME; `readCodexFeatures` makes its own sandbox). T1 has a lane
driver already: `scripts/measure-worktree-sweep.ts` on the `1eb0ab07`
branch with its fixture.

### M5. `/proc` sampling of the serving processes

Find the Viewer PID in the newest `[viewer loop-gap]` record with
`role: viewer`, then confirm that `/proc/<pid>/cmdline` contains `next start`
and that its parent is the child of `systemctl --user show delegatus.service -p MainPID --value`
(never select a process by pattern). The runtime host is the sibling running
`src/runtime-host/main.ts`.

```sh
python3 -I - "<viewer pid>" 1800 > "$TMPDIR/proc-viewer.ndjson" <<'EOF'
import json, os, sys, time
pid, end = int(sys.argv[1]), time.time() + float(sys.argv[2])
tick = os.sysconf("SC_CLK_TCK")
def cpu(path):
    fields = open(path).read().rsplit(")", 1)[1].split()
    return (int(fields[11]) + int(fields[12])) / tick
while time.time() < end:
    at = time.time()
    try:
        threads = {}
        for tid in os.listdir(f"/proc/{pid}/task"):
            name = open(f"/proc/{pid}/task/{tid}/comm").read().strip()
            threads[name] = threads.get(name, 0) + cpu(f"/proc/{pid}/task/{tid}/stat")
        rss = next(int(line.split()[1]) for line in open(f"/proc/{pid}/status") if line.startswith("VmRSS"))
        io = dict(line.split(": ") for line in open(f"/proc/{pid}/io").read().splitlines())
    except (FileNotFoundError, ProcessLookupError):
        break
    print(json.dumps({"t": round(at, 3), "mainCpuS": cpu(f"/proc/{pid}/task/{pid}/stat"), "threadsCpuS": threads,
        "rssKiB": rss, "rchar": int(io["rchar"]), "wchar": int(io["wchar"])}), flush=True)
    time.sleep(max(0, 0.1 - (time.time() - at)))
EOF
```

Ten samples a second for at most 30 minutes, bounded. Main-thread CPU per
gap (`mainCpuS` difference across the gap) tells CPU-bound stalls from waits;
`threadsCpuS` shows GC helper threads; RSS steps date allocations.

### M6. Agent output rates

For each child of the Viewer whose `argv[0]` basename is `claude` or `codex`
(read only `argv[0]`; the other arguments hold private prompt text), sample
`wchar` from `/proc/<child>/io` every 10 s for 30 minutes. Report bytes per
second per agent and in total. Replay the same byte volume through
`JSON.parse` of real transcript lines in M4 to bound A1 and A2.

### M7. Request mix

The journal has no per-route record. Count open views from a copy of
`view-presence.json`, multiply by the H2-H6 cadences, and time one request of
each polled route's handler in M4. Report the request mix as derived.

### M8. Hourly and post-deploy cycles

Bin Viewer gap time per 5 minutes across the 48 hours. Fold the bins by
minutes since the latest apply (deploy and restart) and by minutes since the
latest T1 completion. Report the post-deploy profile (T2 at +5, T1 at +10,
startup work, T19 retention) apart from the steady hourly profile.

### Measurements per candidate

| ID | Take | Report |
| --- | --- | --- |
| T1 | M1 against `[worktree sweep]` lines; M3 frames in `worktreeSweep.ts`; the lane's fixture numbers | gap time during passes, frames share |
| T2 | M1 against `[temp sweep]` lines and post-deploy +5 min; M3 frames in `tempSweep.ts`; M4 `T2` | block per pass, per `scanProcesses` |
| T3 | M1 against `archived` lines; M3 | gap time per archive pass |
| T4 | M1 against `[auto merge]` bursts; M2 `pipeline.copy`; M4 `D3` times the clones per pass | block per pass and per hour |
| T5 | M3 frames in `forge/sweep.ts`; M4 `D1` plus `D3` | block per pass |
| T6 | M3 frames in `done/`; M2 `pipeline.copy`; M4 `D2` | block per minute |
| T7 | M3 frames in `reconcileController.ts`, `operatorProjection.ts:825`; M4 `T7` | parse time and heap per pass |
| T8 | M3 frames in `asks/` | block per sweep |
| T9 | M1 and M2 on `seat-tick.check`; M3 frames in `seatTick*`, `liveness.ts`; M4 `D1`, `D2`, `T7` | block per check and per 5-minute sweep |
| T10 | M1 against curator and maintenance passes (`[mcp slow] tool=curate_rules`, `memory.curation-*`) | gap time per pass |
| T11 | M1 against `[host retirement]` lines; M3 | block per sweep |
| T12-T18, T20, T22 | M2 on their labels; M3 frames | gap time attributed, or none |
| T19 | M1 against apply times and `[self-update] retention`; M4 `bytesOf` on one release | block per retention pass |
| T21, S5 | M5 I/O (`rchar`, `wchar`) during passes | contention only |
| S1-S4, S6 | M2 on `controller.scan`, `scanner.*`, `transcript.index`, `memory.*`, `activity.ingest`; M3; M4 `S2` | block per feed |
| P1 | M1 and M2 on `controller.*`, `pipelines.*`; deadline lines per hour | gap time; deadlines |
| P2 | M2 `pipeline.copy` inside `pipelines.controller-job`/`-lane`; M4 `P2` at 20 per second | cost per 50 ms tick |
| P3, P4, X1, X2 | M3 frames in `codexAppServerHost.ts`, `cpuPlacement.ts`, `agentMemory.ts`; M4 `X1` | block per launch |
| P5, P6 | M2 `pipelines.evidence`, `pipeline.copy`; M4 `D3` | block per call |
| D1 | `[state transaction-hold]` per hour (M2); M4 `D1` and `D1-write`; M1 overlap of holds with Viewer gaps | clone and hold time |
| D2, D3 | M4 `D2`, `D3` | clone time and heap delta |
| D4, R2 | M2 `registry.snapshot` slices; M4 `D4` cold | refresh and full-load time |
| D5 | synchronous `[blocking-wait]` `registry-*` per hour (M2); M1 overlap | wait time |
| D6, H1 | M1 overlap of `[mcp slow]` with gaps; M3 frames in `src/lib/mcp/`, `src/lib/memory/curation/` | gap time per tool |
| D8 | M4 parse of the copied journal | parse time |
| H2-H7 | M2 on `files.*`; M4 per handler; M7 | cost per request and per hour |
| A1, A2 | M6; M3 frames in `claudeStreamBrokerHost.ts`, `codexAppServerHost.ts`; M4 parse replay | parse cost per second of output |
| A3, A4 | M1 and M2 on `runtime.*`, `delivery.*`; drain-failure lines per hour | gap time |
| R1, R3, R4, R5 | runtime-host gap records (M1, M2), `snapshot-collect`/`-serialize` waits | gap time per hour |
| R6 | none possible beyond R1-R5 | name as a coverage gap |
| G1, G2 | M5 RSS steps and helper-thread CPU in gaps; M4 heap deltas of D1-D4, T7 | allocation per source |
| G3 | M2 line counts per hour | lines per hour |

## Parts completed by later stages

The measurement stage reports its numbers in its stage result. The synthesis
stage then adds these sections to this document: measured and correlated
stalls (including repeated bursts and the hourly cycle), the ranked list with
measured items apart from suspects, remediation slices with acceptance and
before/after plans, regression guards, the follow-up window across an hourly
maintenance cycle under real load, and the final coverage gaps.

## Deferred — not currently justified

- Native or kernel sampling of production (`perf`), which needs an
  operator-level change of `perf_event_paranoid` or capabilities. The JS
  profiler and `/proc` sampling come first; revisit only if G2 stays the
  largest unexplained share after M3 and M5.
- A runtime-host loop profiler. In the audits read, its gaps were a fraction
  of the Viewer's: `cbaaf29a` reported 31.7 s summed (largest 1.6 s) against
  315.9 s for the Viewer in the 11:25-11:55Z window it read, and this audit's
  scoping window holds 369 runtime-host records against 3,841. Revisit if M1
  shows runtime-host gaps aligned with Viewer RPC timeouts.
- Inventorying every one of the 220 API routes. Only polled, timer-driven and
  tool-driven paths are listed; one-off operator actions are out of scope
  unless M1 finds a gap that overlaps nothing listed.
- A repository-wide ban on synchronous filesystem calls. The guard belongs on
  timer, poll and request paths of the two serving processes; the synthesis
  stage designs its scope from the measured list.
- Client rendering and browser main-thread work. The brief covers the Viewer
  and runtime-host server loops.
