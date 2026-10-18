# Main-thread blocking audit: Viewer and runtime host

Status: complete, all three parts written 2026-10-18. Part 1 is the static
inventory (stage `inventory`), from [Requirement](#requirement) to
[Measurement catalogue](#measurement-catalogue); it measures no duration, and
its `Status` column records what was known before measurement. Part 2 is the
production measurement (stage `measure`), summarized under
[Measured and correlated stalls](#measured-and-correlated-stalls). Part 3
(stage `synthesize`) adds the first look at the fixes deployed at 15:04:33Z,
the [ranked list](#ranked-list), the
[remediation slices](#remediation-slices), the
[regression guards](#regression-guards), the
[follow-up window](#follow-up-measured-window) and the
[coverage gaps](#coverage-gaps). Inventory row H8 was added by part 3 after a
production profile named it.

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
  Main then moved to `a25592be` (#3050 seat-tick reachability with targeted
  liveness reads, #3052 merged-worktree sweep in a leased worker), applied at
  2026-10-18T15:04:33.370Z. Between `c91603e0` and `a25592be` the non-test
  source changes are in `src/lib/agent/registry.ts`,
  `src/lib/lifecycle/liveness.ts`, `src/lib/loopProfiler.ts`,
  `src/lib/monitor/*`, `src/lib/state/historyProjection.ts`,
  `src/lib/viewerLoopMonitor.ts` and the worktree-sweep files
  (`git diff --stat c91603e06 a25592bea`). Part 3 cites `file:line` at
  `c91603e0` unless it names `a25592be`; every line it cites outside those files
  is identical at both.
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
| H8 | role-memory rules window (added by part 3): `src/components/roleMemory/LearnedRules.tsx:170` polls `GET /api/role-memory` → `src/app/api/role-memory/route.ts:16` → `src/lib/memory/roleStore.ts:499` `projectView`, which reads every role-memory row (`rows()`), then filters all rules once per scope; the same view backs the `curate_rules` overview (`src/lib/memory/curation/read.ts:20`, D6) | every 15 s per open rules window; lessons every 20 s (`LearnedRules.tsx:27`, `:55`); each `curate_rules` overview | `http.render` only; `[mcp slow] tool=curate_rules` for the tool | 3,872 rows / 15.5 MB | measured by part 3 (ranked list, rank 2) | M3, M4 (D6 case) |

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

## Measured and correlated stalls

### Window, method and conditions

Part 2 read the journal from 2026-10-16 14:00:00Z to 2026-10-18 14:00:00Z
(M0 with `-o json --output-fields=__REALTIME_TIMESTAMP,MESSAGE,_PID`, captured
14:00:27-14:00:39Z: 297,481 records, 1.24 GB, no malformed loop-gap JSON). It
attributed records by the `role` and `pid` in each payload, and processed every
gap of at least 1 s with `start = utc - gapMs` against operations, synchronous
spans, watchdog sites, profile frames and the overlapping maintenance,
transaction, wait and MCP intervals (M1-M3, M8). It replayed candidates on
copies (M4): a `git archive 9c889c07` export using the retained release's
dependencies, databases copied through read-only `VACUUM INTO` at
14:00:40-14:00:42Z (state 216.6 MB, registry 551.8 MB, MCP receipts 208.9 MB,
runtime journal 511.9 MB, summary body 35.5 MB), isolated HOME, XDG, TMPDIR and
`LLV_STATE_DIR`, `LLV_VIEWER_CONTROL_URL` on a refusing port,
`NODE_ENV=production`, the supplied `gate-slot.sh` (CPU cap 300 %), Bun 1.4.0,
host load 3.8-8.4 (10.7 for one diagnostic), fleet 11 live / 4 running at
14:00:28Z. It sampled `/proc` of both serving processes (M5, M6) from
14:08:08.610Z to 14:38:08.572Z, 17,907 samples each, with both process
identities and the release unchanged.

Part 3 added two probes, two journal reads and a read of release chunks, with
the same isolation and gate. A state copy (`VACUUM INTO` at 14:59:24Z) for a cache-eviction probe at 14:59:46-15:00:57Z,
and a registry copy (15:02:03Z) for an MCP attribution probe at
15:02:42-15:02:54Z, both on the `9c889c07` export, load recorded per run
(5.6-14.1). Journal reads of the `9c889c07` arm window (13:18:50-13:49:00Z) and
of the window after the `a25592be` apply (15:03:00-15:30:01Z), each with
`--grep '\[viewer loop-gap\]'` plus the sweep lines. Release chunks of
`a25592be` were read to map its profile frames. Nothing in production was
written, signalled or requested.

### Totals over 48 hours

| Process | Logged gaps (above 500 ms) / seconds | At least 1 s / seconds | At least 2 s / at least 5 s | Largest |
| --- | ---: | ---: | ---: | ---: |
| Viewer | 33,216 / 48,230.6 | 12,230 / 33,643.7 | 4,099 / 1,628 | 35,188 ms |
| Runtime host | 3,076 / 3,128.2 | 1,090 / 1,602.9 | 142 / 0 | 3,407 ms |

In 12,144 of the 12,230 Viewer gaps of at least 1 s (1,087 of 1,090 in the
host) the watchdog's main-thread run counter (padded by 200 ms) covers at least
80 % of the gap: the loop was running, which part 2 reads as predominantly CPU
work with SQLite-sized reads (mean 3,883 bytes per read). The `/proc` sample
agrees: 665.6 s of Viewer main-thread CPU and 237.7 s of host main-thread CPU in
the 30 minutes from 14:08:08Z. In those
gaps 89.28 % of the Viewer's and 84.75 % of the host's watchdog samples name no
site (`unknown-runtime-or-native`), and all 1,090 host gaps report
`operations: []`. Asynchronous `state-write-lock` waits (27,717, 3,907 s) are
not loop occupancy. Summed overlaps below double-count: a gap that overlaps
several candidates counts toward each.

### Repeated bursts and cycles

| Pattern | Process | Production observation | Source |
| --- | --- | --- | --- |
| Hourly sweep burst | Viewer | 13:31:43-13:34:31Z on `9c889c07`: eleven gaps of 2.1-10.0 s, 53.0 s summed (10.028, 7.528, 6.917, 4.872, 4.594, 4.156, 3.523, 3.341, 3.334, 2.639, 2.109 s), whose profiles hold `sweepMergedWorktreesWithRoots` (`11265:1 ab`, up to 1,152 of 1,242 samples) and the shared `/proc` helpers `scanProcesses` and `resolvePhysicalPath` (`37659:1 A`/`C`, up to 457 and 290). The 12:24-12:26Z cluster on `c91603e0` (9.6, 9.5, 7.4, 6.3, 6.2 s) fell inside that revision's T1 pass but carried no profile (cooldown) | T1, with T2/H3 helpers |
| Minute maintenance | runtime host | On `9c889c07`, all 41 host gaps after boot (13:19:54-13:59:54Z) end at second 54.06-54.89 of their minute, 771-1,578 ms. On `a25592be`, 15 of 15 minutes from 15:04:25 to 15:18:25Z end at second 25.5-26.2, 915-1,514 ms; every one carries a `registry.snapshot` sync span (108-456 ms) and 14 of them a `registry.headers` span (60-112 ms). Over 48 hours the host logged 3,076 gaps above 500 ms in 2,880 minutes, median spacing 59.985 s (p10/p90 58.731/60.316 s) | R2 |
| Done-sweep minute chain | Viewer | On `a25592be` (Viewer process started 15:03:24.230Z by `/proc`), 17 gaps from 15:03:50.090 to 15:20:09.513Z, 791-1,368 ms each (median 943 ms) except 2,540 ms (15:15:01.538) and 3,541 ms (15:19:08.115, shared with a role-memory view). Each gap ends 60 s plus its own duration after the previous one, within 0.14 s for 14 of 16 links (0.38 s and 0.32 s for two): a timer re-armed 60 s after its pass ends, whose pass is the gap. The first pass started about 25 s after the process, which fits the done sweep's 15 s first delay if the controllers started about 10 s after the process (the attention reconcile, the other 60 s re-armed timer, waits 30 s). The largest retained sync slices are `pipeline.copy`, `state.write-wait` and `state.checkpoint`, each at most 25 ms, consistent with per-record clones of a whole-collection snapshot. On `9c889c07` the same chain ran from 13:19:16 to at least 13:29:36Z: seven passes of 1.98-2.49 s, each with an RSS step of +0.6 to +1.3 GiB, then 0.73-0.98 s per pass; its links fit 60 s plus the gap within 0.01-0.85 s, the pass spending part of its time in awaits outside the gap. 2 of the 6 captured profiles in it hold the done and album frames (`projectDoneItems` `done/project.ts:56`, `runDoneSweepOnce` `done/sweep.ts:29`, `lookupDoneFrame`, `readTaskAlbum` `taskAlbum/album.ts:143`; 203-227 samples) | T6 with the archive cache (rank 4) |
| Curator pass | Viewer | On `a25592be`, a role-memory curator called `curate_rules` 26 times from 15:18:59 to 15:22:36Z, each with 3.0-4.1 s of `bindingMs` (92.5 s summed; `serviceTotalMs` 4.8-6.5 s, `serializationMs` 0). Every one of the 26 completions ends within 0.4 s of the end of a Viewer gap; the Viewer spent 158.0 s of those 216.8 s (73 %) in logged gaps, 25 of them at least 2 s (77.1 s). Of the 25 captured profiles, 9 hold the deployed role-memory and curation chunk (`36787.js`) above 20 % of samples and 6 the MCP attribution frames (`25514.js:34 cF`/`cE`) above 5 %. Over 48 hours `curate_rules` logged 589 calls of at least 2 s, 2,872.7 s of `bindingMs`, largest 18.2 s | D6, H8, H1 (rank 2) |
| Post-start | Viewer | Exposure-normalized gap share by process age in five-minute bins: 34.28, 27.36, 54.91, 38.01, 31.04, 32.47, 30.11, 33.74, 32.72, 34.29, 30.71 and 28.53 % for 0-55 min, 23.62 % beyond 60 min; the +10 min bin holds the first T1 pass. Early profiles also hold `pipelineStartupEvidence` (`runtime/startup.ts:1770`, 188-199 samples) | T1, startup evidence (P5), done/album frame migration |
| Host and Viewer together | both | Host gaps overlapped the T1 and T2 envelopes 303 and 330 times (448 s and 481 s): concurrent activity across processes; no causal link established | none |

### The hourly cycle

The hourly passes are T1 (10 min after start, then 1 h after each pass ends)
and T2 (5 min, then hourly). T1 is the only hourly source with production
profiles; its envelopes overlapped 3,559 Viewer gaps of at least 1 s
(7,777 s) and T2's 3,456 (7,494 s), but envelope starts are lower bounds
(registration delay is not logged) and a missing completion line does not show
that a pass ran. Folding gaps of at least 1 s by minutes since each T1
completion gives 6.25-12.80 % per five-minute bin and 15.71 % beyond 60
minutes: the bursts continue outside the sweep, so no single hourly cause
explains the steady load.

Hourly totals cannot measure a fix. Over the 48 hours (part 2's hourly table,
mixed revisions and load), Viewer seconds in gaps of at least 1 s per hour had
mean 700.9, median 439.5, standard deviation 739.3, range 29.6-2,471.7, and the
ratio of one hour to the previous had p10 0.36 and p90 2.75; host values were
mean 33.4, median 21.0, range 0-103.9 (zero in quiet hours, while its logged
gaps above 500 ms average 64 per hour over the 48 hours, about one a
minute). A source-level decision rule follows in the
[follow-up window](#follow-up-measured-window).

| UTC hour | Viewer N / s | Host N / s | UTC hour | Viewer N / s | Host N / s |
| --- | ---: | ---: | --- | ---: | ---: |
| 10-16 14 | 691 / 2,373.0 | 46 / 63.5 | 10-17 14 | 535 / 1,430.4 | 59 / 103.9 |
| 10-16 15 | 644 / 2,377.1 | 49 / 71.0 | 10-17 15 | 501 / 749.8 | 53 / 83.7 |
| 10-16 16 | 597 / 2,312.1 | 43 / 64.5 | 10-17 16 | 108 / 207.5 | 23 / 30.1 |
| 10-16 17 | 631 / 2,471.7 | 48 / 74.4 | 10-17 17 | 71 / 135.3 | 3 / 4.7 |
| 10-16 18 | 675 / 2,410.5 | 52 / 79.9 | 10-17 18 | 47 / 91.2 | 0 / 0 |
| 10-16 19 | 681 / 2,227.3 | 47 / 70.4 | 10-17 19 | 21 / 29.6 | 0 / 0 |
| 10-16 20 | 539 / 1,051.7 | 54 / 86.1 | 10-17 20 | 62 / 122.5 | 0 / 0 |
| 10-16 21 | 314 / 520.0 | 29 / 43.0 | 10-17 21 | 62 / 121.2 | 0 / 0 |
| 10-16 22 | 132 / 249.4 | 8 / 9.9 | 10-17 22 | 37 / 74.7 | 0 / 0 |
| 10-16 23 | 159 / 428.1 | 19 / 24.7 | 10-17 23 | 44 / 86.6 | 0 / 0 |
| 10-17 00 | 117 / 450.9 | 10 / 11.6 | 10-18 00 | 39 / 86.4 | 1 / 1.0 |
| 10-17 01 | 70 / 269.2 | 1 / 1.1 | 10-18 01 | 33 / 74.1 | 0 / 0 |
| 10-17 02 | 94 / 311.2 | 1 / 1.1 | 10-18 02 | 29 / 74.9 | 0 / 0 |
| 10-17 03 | 115 / 338.7 | 1 / 1.2 | 10-18 03 | 213 / 496.8 | 17 / 21.8 |
| 10-17 04 | 71 / 348.9 | 0 / 0 | 10-18 04 | 278 / 553.6 | 56 / 88.0 |
| 10-17 05 | 252 / 706.8 | 32 / 43.7 | 10-18 05 | 205 / 384.4 | 45 / 68.2 |
| 10-17 06 | 290 / 712.6 | 42 / 65.6 | 10-18 06 | 52 / 104.8 | 1 / 1.4 |
| 10-17 07 | 214 / 653.4 | 13 / 15.4 | 10-18 07 | 30 / 37.2 | 0 / 0 |
| 10-17 08 | 295 / 841.6 | 15 / 20.1 | 10-18 08 | 251 / 613.8 | 15 / 17.6 |
| 10-17 09 | 166 / 573.3 | 14 / 17.5 | 10-18 09 | 365 / 700.3 | 22 / 26.6 |
| 10-17 10 | 190 / 494.4 | 24 / 32.5 | 10-18 10 | 487 / 1,239.2 | 48 / 69.2 |
| 10-17 11 | 202 / 388.1 | 34 / 43.4 | 10-18 11 | 52 / 83.5 | 12 / 13.1 |
| 10-17 12 | 662 / 1,392.2 | 54 / 88.1 | 10-18 12 | 102 / 229.4 | 12 / 12.7 |
| 10-17 13 | 708 / 1,821.6 | 58 / 97.6 | 10-18 13 | 97 / 192.3 | 29 / 34.5 |

### Synchronous spans measured in production

Retained `attribution.slices` of kind `sync` are durations measured by the
serving process at a named site. They are capped and can nest, so their sums
undercount.

| Site | Viewer overlap, s | Host overlap, s | Largest single span |
| --- | ---: | ---: | --- |
| `pipeline.copy` (archive clones, hot clones, keyed reads) | 1,195.1 | — | — |
| `registry.keyed` | 393.9 | 0.002 | — |
| `state.write-wait` (around state write attempts) | 206.8 | — | — |
| `registry.snapshot` | 104.5 | 201.6 | Viewer 839.5 ms, host 1,107.6 ms |
| `registry.headers` | 32.5 | 62.4 | host 257.8 ms |
| `memory.refresh` | 41.0 | — | 1,563.4 ms |
| `state.checkpoint` | 38.9 | — | — |
| `runtime.commit` | — | 44.0 | 126.7 ms |
| `runtime.collect` | — | 5.5 | 762.8 ms |
| `controller.port-start` (startup) | — | — | 1,793.5 ms |

Synchronous waits: `snapshot-collect` 335 / 143.0 s / largest 762.8 ms (host),
`registry-lock` 106 / 52.2 s / 1,248.4 ms and `registry-revision-retry`
102 / 49.6 s / 1,252.7 ms (Viewer), `state-write-lock` 622 / 6.8 s / 250.1 ms.
Transaction holds of at least 50 ms, process unknown: `tasks` 19,386 / 5,627.1 s
/ largest 6,003 ms, `pipelines` 2,887 / 249.1 s / 410 ms, `role_memory`
44 / 8.5 s / 456 ms. Slow MCP calls (at least 2 s of wall time, process
unknown): `curate_rules` 589 / 2,872.7 s / 18,214 ms, `search_transcripts`
185 / 1,206.9 s / 47,476 ms, `agent_activity` 240 / 811.7 s / 16,808 ms,
`bridge_report` 69 / 608.7 s / 27,013 ms.

### Unit costs on copied state

Warm values are the median and range of runs 1-5 of six in one process; run 0
is the first call. "Loop" is the largest lateness of a 10 ms timer around the
call.

| Case (inventory IDs) | First, ms | Warm median [range], ms | Notes |
| --- | ---: | --- | --- |
| Runtime-host minute maintenance (R2) | 1,186.2 | 763.9 [726.3-869.6] | retention map alone 846.1 [788.4-893.7], +107-109 MB heap per pass; settling the 3 pending effects with a built map 0.40 [0.37-0.44]. Map builder at `src/runtime-host/journalRetention.ts:36`: 8,294 states over 8,220 conversations, entry reads, then receipts and aliases (1 ms profile: receipts 356, conversations 213, entry lookups 159 of 740 samples) |
| Archive read under the shared 256 MiB cache, alternating with a hot list read (T6, D2) | 691-793 | archive 591-937, the following hot list read 96-215 | probe below; hot list 0.24-0.44 when it was not evicted |
| Same at a 512 MiB budget | 734-915 | archive 244-311 (the per-record clone), hot list 0.27-0.73 | both slots stay resident |
| Archive clone alone (D2) | 659.9 | 197.8 [192.3-234.0] | 935 records, 110.9 MB of JSON |
| Hot clone (D3, P6) / two hot clones (T4) | 208.8 / 241.0 | 55.0 [53.0-56.8] / 98.7 [96.5-112.4] | 266 records, 33.5 MB |
| `loadTasks` (D1, H5) / no-op `mutateTasks` (D1) | 127.4 / 111.8 | 49.0 [45.4-50.6] / 18.4 [18.3-21.0] | 2,436 tasks |
| Largest hot record read and stringify (P2) | 15.7 | 11.4 [3.5-13.3] | 514,685 characters |
| Registry snapshot (D4, R2) | 565-1,098 cold | 0.41 cached; incremental after one write 1.60-1.90 (99.6 first) | cold read about 819.5 MB |
| MCP caller enumeration `hostedConversationsFromSnapshot` with the process probe (H1) | 552-596 | 39.4-100.9 over 2 repetitions | 8,243 conversations, 55 pid checks; without the probe 46.5-83.3; snapshot first fill 857-1,512 |
| Role-memory curation overview, which wraps `projectView` (D6, H8) | 393.2 | 228.1 [219.1-238.3] | 3,872 rows |
| Board summary parse (T7, H4) / stringify (H2) | 61.3 / 117.9 | 56.6 [44.6-66.3] / 136.0 [103.1-148.7] | 35.2 MB |
| `scanProcesses` (T2, H3) / scan plus volume probes (H3) | 64.2 / 69.1 | 65.8 [63.6-68.5] / 63.9 [59.6-77.8] | 302 processes, 40,823 path references, 931 roots |
| One release `bytesOf` (T19) | 87.7 | 92.2 [88.5-101.7] | 48,792 entries |
| Forced full / summary runtime snapshot (R1) | 224.6 / 330.6 | 211.9 [182.6-219.7] / 303.3 [268.3-314.7] | cache hit 0.02 |
| Archive maintenance no-op (T3) | 276.1 | 220.9 [217.9-245.5] | hourly |
| Targeted liveness (T9), `9c889c07` → `eb1535f0` | 634.8 → 822.2 | 47.0 [45.6-52.9] → 11.6 [9.3-15.0] | same copy and target |
| Profile trim at the caps, 4,096 × 32 (T22) | 231.8 | 231.7 [228.7-237.6] | real captures hold 246-1,504 samples |
| Receipt maintenance page (R3) | 51.2 | 18.8 [4.1-26.3] | every 10 s |
| Codex `--version` / `features list` (P3, X1) | 46.0 / 37.9 | 35.2 / 41.6 | per Codex host open |
| Claude / Codex stdout JSON surrogate (A1, A2) | 60.4 / 9.4 | 53.2 [45.5-67.4] / 9.3 [7.5-10.3] | 44.0 MB / 9.5 MB |
| Five-transcript reindex (S2) | 163.2 | 130.7 [109.1-135.3] | loop at most 6.8 ms (yields) |
| T1 sweep, 930 trees × 101 files, before → `98a23e4f` worker | — | largest loop interval 5,329.5-5,586.8 → 3.36-9.06 | same fixture, three runs each |

Cache-eviction probe (part 3): one Bun process per side on the state copy,
calling `loadPipelinesForList()` (hot) and `loadArchivedPipelines()` (archive)
twelve times with 200 ms pauses in the order hot, hot, archive, archive, then
alternating, and printing the shared cache slots
(`globalThis.__llvCollectionReadCachesV1`) after each call; the 512 MiB side
changed only `MAX_BYTES` in `src/lib/state/collectionReadCache.ts:11` of its
scratch export. Two repetitions per side at 15:00:20-15:00:57Z, load 5.7-7.5.
At 256 MiB the slots held only the collection read last: the hot slot is
64.8 MiB and the archive 212.5 MiB in the cache's UTF-16 units, so together
they exceed the budget, and every archive fill evicts the hot rows and every
hot fill evicts the archive. The budget was sized when the archive was
147.5 MiB (`docs/perf/viewer-heap-gc-fixes.md`).

MCP attribution probe (part 3): on the registry copy, `readOnlySnapshot()`
then `hostedConversationsFromSnapshot` with the production process probe
(`pidAlive`, `processIdentity`, boot epoch), six calls, then three without the
probe, two repetitions, under the test context so the inbox resolved to a
throw-away directory. Production attribution (`src/lib/mcp/bindings.ts:1241`
`attentionCallerSources`) runs this enumeration on every call that resolves
its caller, and `attributionOf` has 41 call sites in `bindings.ts`, so one tool
call can run it more than once. The MCP receipt copy holds 8,980 receipts in
the 48 hours (187 per hour; hourly 0-614): `agent_activity` 5,229,
`curate_rules` 981, `stage_report` 523, `update_task` 421, `leave_lesson` 333,
`search_memory` 325.

### First look at the deployed fixes (`a25592be`)

`a25592be` (#3050 and #3052) has served since the Viewer process started at
15:03:24.230Z (apply recorded 15:04:33.370Z); the profiler is armed until about
15:33Z. Read between 15:12:21 and 15:30:01Z:

- **T1 now runs in the `worktree-sweep` helper.** Its wait carries the
  `worktrees.sweep` label; the first gap record naming it ends at
  15:13:57.868Z, about 10 minutes after the controllers started, and its
  completion line was written at 15:21:53.575Z (1 worktree removed, 929 kept
  across 7 repositories). Before the curator pass below began, its gaps of at
  least 2 s were 15:14:31.040 (2,056 ms) and 15:15:01.538 (2,540 ms, a done
  pass); their profiles hold no worktree-sweep frame (largest JS frame totals
  7-9 of 462-515 samples). From 15:18:59Z the pass overlapped the curator
  burst, whose gaps hold curator, attribution and seat frames and none from
  the sweep. This is a first look at one pass; the verdict on T1 needs the
  [follow-up window](#follow-up-measured-window).
- **The runtime-host minute gap continues** at second 25.5-26.2 of each minute
  (above).
- **The Viewer done-sweep chain continues** (above).
- **A curator pass held the loop for most of 3.6 minutes** (15:18:59-15:22:36Z;
  the "Curator pass" row above). Its first long gap, 3,541 ms at
  15:19:08.115Z, also held a done pass and shows the curation frames:
  chunk `36787.js` of the deployed build, whose line 3 holds one `X(a, b =
  Date.now())` that begins with the scope join, the canonical project, the
  scope resolver and all rows, the shape of `projectView`
  (`src/lib/memory/roleStore.ts:499`), 276 samples; the same chunk's line 1
  frames `C`, `v` and `I` (495, 492 and 258 samples) are role-memory and
  curation functions whose names repeat on that line; the MCP bindings chunk
  frame `25514.js:1 m` holds 293. The profile window (746 samples) is wider
  than the gap. Inventory row H8 records the path.
- The temp sweep (T2) wrote its completion line at 15:23:24.403Z (2
  directories removed, 2 errors); its start is not logged. Eleven Viewer gaps
  of 0.7-1.5 s ran from 15:08:35 to 15:09:01Z, about 5 minutes after the
  controllers started, with `memory.discovery`, `seat-tick.check` and
  `runtime.rpc` pending and no label for the sweep, so they cannot be assigned
  to it.

## Ranked list

### Evidence levels

- **Profiled**: production profile frames of that source inside the gap.
- **Cadence**: production gaps recur on that source's exact schedule
  (including the boot-aligned second or the re-arm signature).
- **Span**: a production synchronous span or wait record names the site.
- **Replay**: the unit cost was measured on copied production-sized state.
- **Overlap**: the source's label or envelope overlaps gaps; no cost.
- **Code**: code reading only.

A **measured cause** has a production observation that names it (profiled,
cadence or span) and a replayed unit cost. Everything else is a **suspect**.
Within each list, rows are ranked by evidence times cumulative cost per hour
on this installation. Cost per hour multiplies the replayed unit cost by the
production cadence; "per tab" costs apply only while that view is open.

### Measured causes

| Rank | ID | Process | Evidence | Unit cost | Cadence | Cost per hour | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | T1 merged-worktree sweep | Viewer | profiled (11 gaps, up to 10.0 s), replay | largest loop interval 5.3-5.6 s per pass (930 trees) | +10 min, then 1 h after each pass | about 53 s of gaps of at least 2 s in the profiled pass | fixed by #3052 (helper; replay 3.4-9.1 ms), serving since 15:03:24Z; production verdict pending ([L0](#l0-verify-t1-in-the-follow-up-window)) |
| 2 | D6/H8/H1 role-memory curation calls and the role-memory view | Viewer | profiled (9 of 25 captured gaps above 20 % of samples in the curation chunk, 6 with attribution frames; `projectView` at 15:19:08Z), cadence (26 of 26 `curate_rules` completions end a Viewer gap within 0.4 s), replay of the overview only | 3.0-4.1 s of `bindingMs` per call in production; the overview replay, 219-238 ms warm, covers under a tenth of it | 26 calls in 3.6 min per curator pass; the rules window polls the view every 15 s while open | 2,872.7 s of `bindingMs` in 48 h, about 60 s per hour if binding time is loop time, as the 26 of 26 alignment shows for the observed pass (whose window the Viewer spent 73 % in gaps); 53-57 s more per open rules window | open, [L4](#l4-curator-calls-and-the-role-memory-view-stop-holding-the-loop) |
| 3 | R2 runtime-host stale-effect maintenance | host | cadence (41/41 and 15/15 minutes), span (`registry.snapshot` 108-456 ms in each), replay | 726-894 ms per tick | every 60 s from boot | 44-54 s by replay; the host logged 65 s/h of gaps above 500 ms over 48 h | open, [L1](#l1-runtime-host-maintenance-reads-only-the-pending-effects) |
| 4 | T6 done sweep reading the archive, with hot/archive cache eviction (D2) | Viewer | cadence (re-arm chains on both revisions), profiled on `9c889c07` (2 of 6), span (`pipeline.copy`), replay | median 943 ms per pass in production (791-1,368 ms; 1.98-2.49 s for the first seven after a start); archive read 591-937 ms plus the next hot read 96-215 ms when evicting | every 60 s plus the pass | about 56 s (943 ms × 59 passes) | open, [L2](#l2-the-pipeline-archive-leaves-the-minute-timers-and-stops-evicting-the-hot-rows) |
| 5 | H1 MCP caller attribution | Viewer | profiled (2.2 s of 553 samples in the 2.6 s gap at 13:29:01Z; present in two more windows), replay | 39-101 ms warm per enumeration | every caller-resolving tool call, sometimes more than once per call | 7-19 s at 187 calls per hour | open, [L3](#l3-mcp-caller-attribution-reads-only-the-caller) |
| 6 | T9 seat check | Viewer | profiled (91 of 507 samples at 13:24:29Z; 106 of 1,504 in the 11.554 s gap), replay of targeted liveness only | targeted liveness 11.6 ms warm after #3050 (47.0 before); whole check unmeasured | every 5 min per seat project (10 seats) | unknown | #3050 merged and serving; [L8](#l8-seat-check-measured-end-to-end-then-bounded) |
| 7 | T2/H3 `/proc` scans (`scanProcesses`, `resolvePhysicalPath`) | Viewer | profiled (inside T1 windows; shared with T1), replay | 63.6-77.8 ms per scan | T2 hourly; H3 every 30 s per open resources footer | 7.7 s per open footer; T2 pass untimed | open, [L6](#l6-temp-sweep-and-disk-pressure-scans-leave-the-loop) |
| 8 | D5 synchronous registry write waits | Viewer | span (wait records) | up to 1,252.7 ms | registry writes from the Viewer | 2.1 s (208 waits, 101.8 s in 48 h) | open, [L7](#l7-registry-write-admission-without-synchronous-waits) |
| 9 | R1 runtime snapshot rebuild | host | span (`snapshot-collect` waits, `runtime.collect` 762.8 ms), replay | 183-315 ms per rebuild | each `snapshot` RPC after a journal change | 3.0 s (143.0 s in 48 h) | deferred (below) |
| 10 | S3 memory refresh | Viewer | span (`memory.refresh` up to 1,563 ms; 9-19 ms slices in a burst at 15:14:34-15:14:48Z) | — | after each transcript feed | 0.85 s retained overlap (41.0 s in 48 h) | deferred (below) |

### Suspects

| Rank | ID | Process | Evidence | Unit cost | Cadence | Potential cost per hour | Next step |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | P2 50 ms pipeline revalidation timers | Viewer | replay; `pipeline.copy` is the largest retained sync site (1,195 s) and `pipelines.controller-job` overlaps 18,955 s of gaps, neither separable | 3.5-13.3 ms per tick on the largest row | 20 per second per running activation, provisioning job, publication admission, remote action or review ingress | 229 ms per second per active timer (824 s per continuously occupied hour); duty unknown | [L5](#l5-pipeline-revalidation-timers-read-the-row-revision), labelled by [L0b](#l0b-labels-and-process-identity-for-unlabelled-work) |
| 2 | D1 task transaction holds | unknown process | span without process identity (19,386 holds, 5,627 s, largest 6,003 ms) | no-op `mutateTasks` 18.4 ms | every task write from the Viewer, the `mcp-tasks` helper and embedded workers | up to 117 s if all were in the Viewer | identity first ([L0b](#l0b-labels-and-process-identity-for-unlabelled-work)); then keyed task writes if the Viewer holds them |
| 3 | H5 seat panel `loadTasks()` | Viewer | replay | 45.4-50.6 ms | every 6 s per tab showing a seat | 29.4 s per tab | [L9](#l9-read-only-collection-readers-stop-cloning) |
| 4 | T4 auto-merge sweep clones and log | Viewer | replay, journal cadence (median 28 s; 39,111 lines in 48 h, up to 84 per second) | 96.5-112.4 ms per pass | every controller cycle, debounced to 15 s | 12.7 s | [L9](#l9-read-only-collection-readers-stop-cloning) |
| 5 | T19 release retention | Viewer | replay of parts; code shows one `scanProcesses()` per kept candidate | per candidate about 64 ms scan plus 88-102 ms `bytesOf` | after each apply and drain (17 in 48 h) | about 13 s of loop per pass in slices of about 150 ms, after deploys | [L10](#l10-release-retention-scans-once-and-counts-bytes-off-the-loop) |
| 6 | T7/H4 summary parse | Viewer | replay | 44.6-66.3 ms | every 60 s, plus needs-you reads and seat checks | 3.4 s and more per read | deferred |
| 7 | T22 profiler trim | Viewer | replay at the caps | 229-238 ms at 4,096 samples; real captures are smaller | each captured gap during an arm window | self-cost of the instrument | accepted; noted in [L0a](#l0a-profiler-exact-frames-and-a-window-that-spans-the-hourly-cycle) |
| 8 | R3 receipt sweep | host | replay | 4.1-26.3 ms | every 10 s | up to 6.8 s in bounded slices | deferred |
| 9 | T3 archive maintenance | Viewer | replay | 217.9-245.5 ms | hourly | 0.25 s | deferred |
| 10 | P3 Codex probes | Viewer | replay | about 80 ms (`--version` plus `features list`) | each Codex host open | depends on launches | deferred |
| 11 | A1/A2 agent stdout parsing | Viewer | replay, `/proc` write rates (sum 310,873 B/s lifetime-normalized) | about 1 ms per MB | continuous | about 1.1 s | deferred |
| — | Overlap or code only: T8, T10-T18, T20, T21, S1, S2, S4-S6, P1, P4, P5, D7, D8, H2, H6, H7, A3, A4, R4-R6, X3-X5, G1-G3 | — | part 2 records each one's overlap or its stated limit; none has a production observation naming it as a blocker | — | — | — | the follow-up window re-reads them with L0b labels |

### Explained and unexplained time

The Viewer spent a mean of 701 s per hour (median 440) in gaps of at least
1 s over the 48 hours. The measured Viewer causes account for roughly
175-255 s per hour on average (ranks 2, 4, 5 and 7, plus rank 1's hourly pass
before #3052; the upper end with a rules window and a resources footer open),
and less in quiet hours. The busy hours
(1,000-2,500 s per hour) are mostly unexplained: their gaps hold
`controller.pipelines`, `pipelines.controller-job`, `runtime.rpc` and
`files.get` as pending operations and 89 % unnamed watchdog samples. The
strongest suspect for that share is P2, whose cost grows with the number of
running lane jobs; it is unlabelled today. The host's time is mostly
explained by R2.

### Covered-by-lane, rechecked

| Lane | Outcome on 2026-10-18 | Does it remove its share? |
| --- | --- | --- |
| `1eb0ab07` (#3052) | merged 14:42Z; measured tip `98a23e4f` equals the merged files (same blob ids for `worktreeSweep.ts`, `worktreeSweepWorker.ts`, `worktreeSweepCache.ts`); serving since 15:03:24Z | On the fixture, yes: largest loop interval 5,329.5-5,586.8 ms before, 3.36-9.06 ms after (same 930 trees, load 4.5-5.4); the cold helper pass takes longer in wall time (6.2-10.9 s against 7.0-7.3 s). In production, no captured long gap during the first helper pass (about 15:13:34 to 15:21:53Z) holds a worktree-sweep frame. The shared `/proc` helpers still run on the Viewer for T2 and H3 (rank 7) |
| `e9a56ff7` (#3051) | merged and serving since 13:19:58Z | Instrumentation: 19 of 19 Viewer gaps of at least 2 s in its arm window said `captured` (17 distinct profiles). Profiles still last 30 minutes after a deploy and drop the column, leaving `G`/`S` frames ambiguous ([L0a](#l0a-profiler-exact-frames-and-a-window-that-spans-the-hourly-cycle)) |
| `41be75ea` (#3048) | open, unmerged, unserved | Feature work that adds a usage backfill to S4; no production measurement possible yet. The follow-up window measures `activity.ingest` and its backfill passes after it deploys |
| `44e9fd13` (#3050) | merged 14:11Z, serving since 15:03:24Z | Better than part 1 assessed: it adds `livenessConversationSnapshot` with indexed reads, and a paired replay measured targeted liveness at 47.00 → 11.61 ms warm (first call 634.8 → 822.2 ms). The complete seat check keeps its task, archive and summary reads (rank 6) |

## Remediation slices

Each slice is one lane. Every speed claim in an acceptance is a before/after
pair on the same copy, the same Bun, the same gate and six runs per side, with
load and live/running agent counts recorded beside the numbers. Each slice
also carries its history-flat test ([RG1](#rg1-history-flat-work-tests)).
Runtime-host slices are high risk under `AGENTS.md`: three review rounds and
`bun scripts/verify-runtime-host.ts --runtime <the pinned bun>`.

Recommended order: L0a, L0b, L1, L2, L3 and L4 can run in parallel (L3 and
L4 both touch `src/lib/mcp/bindings.ts`, in different functions; land L3
first if they collide); then L5; then L6 and L9; then L7, L8 and L10. Open work
touching the same files: none; `41be75ea` changes activity ingest only, and
#3050/#3052 have merged.

### L0. Verify T1 in the follow-up window

No code. The [follow-up window](#follow-up-measured-window) decides whether
#3052 removed T1's share in production.

### L0a. Profiler: exact frames and a window that spans the hourly cycle

- **Change.** `src/lib/loopProfiler.ts` keeps a validated numeric `column` in
  each frame, its location, its aggregation key and the emitted row, and drops
  frames whose line is 4294967295; privacy filters and size caps stay.
  `src/lib/loopProfilerServing.ts` reads an optional `armMinutes` (30-120) from
  the existing settings file; absent, the arm stays 30 minutes, and the file
  stays a kill switch.
- **Acceptance.** Tests: a captured row carries `column`; a sentinel line is
  dropped; `armMinutes: 90` arms for 90 minutes; values outside 30-120 are
  refused with a log line and fall back to 30; existing privacy and cap tests
  pass unchanged.
- **Measurement.** Instrumentation; it claims no speed gain. One deploy shows a
  gap row with columns, which resolves the ambiguous `G`/`S` frames.

### L0b. Labels and process identity for unlabelled work

- **Change.** Run each of these ticks under a loop-monitor operation:
  `done.sweep` (T6, `src/lib/done/sweep.ts`), `attention.reconcile` (T7),
  `temp.sweep` (T2), `forge.auto-merge` and `forge.sweep` (T4, T5),
  `asks.sweep` (T8), `hosts.retirement` (T11), `self-update.retention` (T19),
  the notice prunes (T20), `resources.read` (H3), `seat.panel` (H5),
  `role-memory.view` (H8), `pipelines.revalidate` (P2), and in the runtime
  host `runtime-journal.maintenance` (R2) and `runtime-journal.receipt-sweep`
  (R3). Add `pid` and `role` to `[state transaction-hold]`
  (`src/lib/state/sqliteStateStore.ts:539`) and `[mcp slow]`
  (`src/lib/mcp/server.ts:3383`), because the journal's `_PID` is the launcher
  for both children; `[blocking-wait]` already carries `role`
  (`src/lib/blockingWaits.ts:116`), and its registry waits gain the call site
  that L7 needs.
- **Acceptance.** For each label, a test runs the tick with a slow injected port
  under the monitor's test harness and finds the label in the gap record's
  operations; notice tests find `pid` and `role`.
- **Measurement.** Instrumentation; no speed claim. The follow-up window uses
  these labels.

### L1. Runtime-host maintenance reads only the pending effects

- **Evidence.** Measured rank 3.
- **Change.** In `src/runtime-host/main.ts:332-343`, query the pending
  spawn/kill effects first (the `SELECT` in `settleStalePendingEffects`,
  `src/runtime-host/journal.ts:1946`); with none, skip the registry. With some,
  resolve the retention state of each pending conversation through keyed
  registry reads: the alias chain (as `seatTickConversation` does at
  `src/lib/agent/sqliteRegistryStore.ts:2929`), the conversation row, its
  newest generation's entry by session key, and receipts through the indexed
  `conversationId` lookup for the canonical id and each alias that resolves to
  it. This replaces `agentRegistry().readOnlySnapshot()` plus
  `registryConversationRetentionStates` over every conversation;
  `settleStalePendingEffects` takes a lookup in place of the full map.
- **Acceptance.** (1) Equivalence: on fixtures with alias chains and cycles,
  superseded conversations, dead entries, failed and conflicted receipts and
  pending artifact receipts, the targeted state equals
  `registryConversationRetentionStates(...).get(id)` for every pending id.
  (2) History-flat: registry rows decoded per tick are the same with ten times
  the unrelated conversations, and zero with nothing pending. (3) Copy: the
  tick takes at most 10 ms warm (before 726-870 ms). (4) The runtime-host
  rehearsal passes under the pinned Bun.
- **Before/after.** Part 2's maintenance, retention-map and settlement cases on
  one copy; production: minutes with a host gap above 500 ms at the
  boot-aligned second (before: 41 of 41, then 15 of 15).

### L2. The pipeline archive leaves the minute timers and stops evicting the hot rows

- **Evidence.** Measured rank 4.
- **Change.** (a) A read-only archive accessor returns the shared frozen rows,
  as `loadPipelinesForList()` does for the hot collection, and replaces
  `loadArchivedPipelines()` at `src/lib/done/world.ts:46`,
  `src/lib/taskAlbum/world.ts:20`, `src/lib/monitor/seatTickSources.ts:680`
  and `src/lib/orchestrator/boardReportRun.ts:344`; the private 60 s copies in
  `done/world.ts:39-49` and `taskAlbum/world.ts:14-27` go, since the shared
  cache is keyed by collection revision. (b) The archive's rows stop competing
  with the hot collections for the 256 MiB budget
  (`src/lib/state/collectionReadCache.ts:11`), and an eviction under byte
  pressure writes one rate-limited line naming the collection.
- **Option for (b).** Raising the shared budget to 512 MiB measured hot reads
  of 0.27-0.73 ms and archive reads of 244-311 ms. A dedicated archive slot
  with its own bound gives the same result and keeps the hot collections safe
  as the archive grows (147.5 MiB at the heap-fix audit, 212.5 MiB now; the
  hot collection stays near 65 MiB). Recommendation: the dedicated slot,
  bounded at 512 MiB (2.4 times today's archive), with the eviction line
  firing before the archive outgrows it. The archive's decoded rows already
  occupy the heap for most of each minute today; keeping them resident removes
  the per-read churn (+134 to +475 MB of RSS per archive read in the probe).
- **Acceptance.** (1) A test fills hot and archive slots in the measured size
  ratio and finds the hot slot intact after an archive fill and the reverse.
  (2) Done, album and seat paths run on frozen fixtures without writing to
  them. (3) Copy: warm archive and hot reads at most 1 ms each when
  alternated (before 591-937 and 96-215 ms); a `runDoneSweepOnce` replay with
  the production world on copied state keeps the loop within 100 ms.
  (4) [RG3](#rg3-native-eslint-restrictions-on-server-code) allows
  `loadArchivedPipelines` only in the archive maintenance and the sweep
  helper.
- **Before/after.** The eviction probe and a new `runDoneSweepOnce` case on one
  copy; production: the done chain's pass durations (before: median 943 ms,
  791-1,368 ms on `a25592be`).

### L3. MCP caller attribution reads only the caller

- **Evidence.** Measured rank 5.
- **Change.** In `attentionCallerSources` (`src/lib/mcp/bindings.ts:1241`),
  a caller that presents a capability (every HTTP caller) is resolved through
  the indexed digest lookup (`conversationIdForSpawnCapabilityDigest`), and the
  hosted record is built for that conversation only, from its generations'
  entries by key, before its pids are checked. The full enumeration
  (`hostedConversationsFromSnapshot`, `:1187`) stays for capability-less stdio
  callers, memoized per registry revision and boot epoch. Attribution is
  computed once per tool call and passed to `pipelineCallerRoles` (`:2283`),
  `inferredPipelineSource` (`:2302`) and the other `attributionOf` sites.
- **Acceptance.** The existing caller-authority and bindings tests decide the
  same (pid conflict, capability conflict, unresolved capability, native
  caller, deputy seat). History-flat: registry rows decoded per HTTP
  attribution stay constant with ten times the unrelated conversations. Copy:
  at most 2 ms warm (before 39-101 ms).
- **Before/after.** The attribution probe on one registry copy; production:
  attribution frames in captured profiles and `[mcp slow]` lines per 100
  receipts.

### L4. Curator calls and the role-memory view stop holding the loop

- **Evidence.** Measured rank 2. Each `curate_rules` call
  (`src/lib/mcp/bindings.ts:7919`) resolves its caller twice (once in
  `authorizeReceipt`, once in the call), builds the curator snapshot or the
  registry snapshot two or three times, then reads (`readCuration`, which
  calls `projectView` through `src/lib/memory/curation/read.ts:20`) or applies
  (`applyCuration`). In production one call holds the Viewer loop for 3.0-4.1 s;
  the overview replay alone costs 219-238 ms, so most of the time sits in
  parts no replay has timed yet.
- **Change.** (1) Replay first: run one curator pass's sequence of calls (from the
  `curate_rules` MCP receipts where they keep the arguments, otherwise a
  synthetic pass with the same read and apply mix) on copies of
  `state.sqlite` and the registry, through the real binding with a stubbed
  admission port, and time admission, attribution, snapshots, read, apply and
  the role-memory transaction per call. (2) Resolve the caller and the curator
  snapshot once per call and reuse them in `authorizeReceipt` and the binding
  (with L3's targeted attribution). (3) `projectView`
  (`src/lib/memory/roleStore.ts:499`) reads the rows of the scopes it shows
  (the project, machine and the project's role scopes) and no others,
  builds `rulesById` and the per-scope lists in one pass (today every rule is
  filtered again for each scope), and memoizes per role-memory collection
  revision, which the rules window poll
  (`src/components/roleMemory/LearnedRules.tsx:170`) also reuses. (4) Remove
  whatever else the replay shows above 100 ms per call.
- **Acceptance.** Identical `curate_rules` answers and `projectView` output on
  fixtures against the current implementation; history-flat: rows decoded for
  project A stay the same when project B's rules grow tenfold; the curator-pass
  replay keeps the loop within 100 ms per call; an unchanged-revision rules
  poll takes at most 1 ms.
- **Before/after.** The curator-pass replay and the D6 overview case on one
  copy; production: Viewer gaps of at least 1 s that end within 0.4 s of a
  `curate_rules` completion (26 of 26 in the 15:18:59-15:22:36Z pass) and
  `bindingMs` per call (3.0-4.1 s).

### L5. Pipeline revalidation timers read the row revision

- **Evidence.** Suspect rank 1.
- **Change.** The six 50 ms timers in `src/lib/pipelines/engine.ts` (`:5067`,
  `:6346-6349`, `:8303`, `:10128`, `:10259`, `:10384`) read the row's
  `row_revision`, one indexed integer as `pipelineControllerVersion` reads it
  (`src/lib/state/sqliteStateStore.ts:1286`), and decode and run their
  predicate only when it changed; `:6346` stops serializing the whole record
  every 50 ms.
- **Acceptance.** The engine tests for activation supersession, publication
  admission, remote actions, review repair, provisioning and review ingress
  decide the same; an unchanged row decodes no record per tick (counted
  through the store's decode hook); copy: an unchanged tick on the largest
  hot row takes at most 0.1 ms (before 3.5-13.3 ms).
- **Before/after.** Part 2's P2 case on one copy; production:
  `pipelines.revalidate` (L0b) totals and gap seconds with
  `pipelines.controller-job` pending.

### L6. Temp sweep and disk-pressure scans leave the loop

- **Evidence.** Measured rank 7.
- **Change.** `runTempSweep` (`src/lib/tempSweep.ts:794`) runs in the leased
  `worktree-sweep` helper that #3052 added, under its lease, deadline and
  bounded reply. The disk-pressure reader (`src/lib/state/diskPressure.ts:285`
  at `a25592be`) takes the process scan from the helper's latest result within
  its 30 s cache, and the per-root `statSync`/`statfsSync` move with it.
- **Acceptance.** No `scanProcesses()` call on a Viewer timer or request path;
  a fixture pass over the measured shape (about 300 processes, 40,000 path
  references) keeps the Viewer loop within 50 ms; a resources request spends
  at most 10 ms on the main thread with a fresh helper result (before
  59.6-77.8 ms).
- **Before/after.** Part 2's T2 and H3 cases; production: gaps in the five
  minutes after the temp pass starts, and `resources.read` totals.

### L7. Registry write admission without synchronous waits

- **Evidence.** Measured rank 8.
- **Change.** The synchronous waits at `src/lib/agent/sqliteRegistryStore.ts:3124`
  (`registry-revision-retry`) and `:3177` (`registry-lock`) take the
  asynchronous admission #2953 introduced, for Viewer callers; the lane maps
  the callers first (the `subject` field is minified; L0a columns resolve it).
- **Acceptance.** A test holds the registry write lock from a child process and
  finds a Viewer write waiting asynchronously while a 10 ms timer stays within
  50 ms; production: no `synchronous: true` registry wait with `role: viewer`
  in 24 hours (before 208 waits, 101.8 s, largest 1,252.7 ms in 48 h).
- **Before/after.** The held-lock test red before and green after; production
  counts.

### L8. Seat check measured end to end, then bounded

- **Evidence.** Measured rank 6, with the complete check unmeasured.
- **Change.** After L2, replay `check` (`src/lib/monitor/seatTickController.ts`
  at `a25592be`) with production sources on a copy, `gh` stubbed and transcript
  evidence suppressed; record time per source; then remove any synchronous
  source above 50 ms. Candidates from the inventory: the `loadTasks()` clone
  (`src/lib/monitor/seatTickSources.ts:681`), the 35 MB summary parse for
  worker asks (`:693-697`), and the lifecycle journal parse
  (`src/lib/lifecycle/journal.ts:208`).
- **Acceptance.** The complete check keeps the loop within 100 ms on the copy.
- **Before/after.** The replay before and after on one copy; production:
  `seat-tick.check` overlap per hour.

### L9. Read-only collection readers stop cloning

- **Evidence.** Suspects 3 and 4.
- **Change.** `sweepAutoMerge` and `sweepTaskFinishes`
  (`src/lib/forge/autoMerge.ts:699`, `:919`), the forge sweep
  (`src/lib/forge/sweep.ts:101`, `:107`) and the seat panel
  (`src/app/api/orchestrator/seat/route.ts:124`) read
  `loadPipelinesForList()`/`loadTasksForList()` where they only read; writes
  stay keyed. `[auto merge] <id>: not admitted: …` is written when a lane's
  reason changes, through a map bounded by the hot lanes.
- **Acceptance.** Frozen-fixture tests show these paths write nothing to rows;
  two passes with unchanged reasons write one line per lane; copy: an
  auto-merge pass takes at most 5 ms without `gh` (before 96.5-112.4 ms) and
  the seat panel's task read at most 1 ms warm (before 45.4-50.6 ms).
- **Before/after.** Part 2's D1, D3 and T4 cases; production: `[auto merge]`
  lines per hour (before 39,111 in 48 h).

### L10. Release retention scans once and counts bytes off the loop

- **Evidence.** Suspect 5.
- **Change.** `retainReleases` (`src/lib/selfUpdate/retention.ts:63`) scans
  `/proc` once per pass (it now calls `scan()` per kept candidate, 84 here) and
  runs `bytesOf` (`:32`) in a helper.
- **Acceptance.** A fixture of 84 release directories triggers one scan per
  pass and keeps the Viewer loop within 50 ms during the pass.
- **Before/after.** Part 2's `bytesOf` case extended to a full pass over copies
  of retained releases (read-only); production: gaps in the minutes after an
  apply.

## Regression guards

The repository already bounds the serving loop in one place: the candidate
performance gate refuses a release whose Viewer loop exceeds p95 50 ms or max
500 ms while serving (`docs/design/candidate-performance-gate.md`), over a
synthetic registry of 53,299 rows. Its dataset holds no pipeline, task or
role-memory collections, its serving phases last 8-12 s (`WARM_MS`,
`SERVED_AFTER_SWITCH_MS` in `src/runtime-host/candidatePerformanceRun.ts:74-76`),
shorter than the minute timers, and it sets no bound on the runtime host's own
loop. The project rules already ask for asynchronous state-lock waits,
loop-monitor labels for new work, and history-bounded hot paths. The guards below close the measured
holes.

### RG1. History-flat work tests

Each of L1-L5 and L9 ships a test that counts rows or bytes decoded by the
fixed path through the store's own hook, then grows unrelated history tenfold
and asserts the count is unchanged. The count is deterministic, so it runs in
the ordinary `bun test` by path without timing noise, and it fails the day a
whole-collection read returns to that path.

### RG2. The candidate performance gate covers state history, the minute timers and the host loop

- Add generated state collections at this installation's measured sizes to the
  gate's dataset (`src/runtime-host/candidatePerformanceRun.ts`): about 270 hot
  pipelines (34 MB, largest about 515 KB), 950 archived (111 MB, largest
  about 1.1 MB), 2,450 tasks (9.8 MB) and 3,900 role-memory rows (15.5 MB, one
  of about 2.9 MB). Generated content only; no copied data.
- Keep the serving window open at least 75 s after warm-up, so the done sweep
  (15 s, then every 60 s), the attention reconcile (30 s, then 60 s) and the
  runtime host's minute maintenance fire inside it.
- Read the runtime host's own loop-gap records and refuse a release whose host
  loop exceeds 250 ms outside boot. The gate's host already runs the
  candidate's `src/runtime-host/main.ts` unchanged
  (`src/runtime-host/candidateRuntimeHost.ts`) over the synthetic registry,
  so its minute maintenance fires once the window passes 60 s; today the gate
  bounds only the Viewer's loop (`src/runtime-host/candidatePerformance.ts:254-269`).
- Adoption check: run the extended gate on `a25592be` first; it must refuse for
  R2 and the archive read (red before), then pass after L1 and L2.

### RG3. Native ESLint restrictions on server code

- In `eslint.config.mjs`, for `src/lib/**`, `src/app/api/**` and
  `src/runtime-host/**` (tests, fixtures, `*.worker.ts` and helper entries
  excluded): `no-restricted-syntax` on calls to `spawnSync`, `execFileSync`,
  `execSync` and `Atomics.wait`, and `no-restricted-imports` naming
  `loadArchivedPipelines` from `@/lib/pipelines/store` (after L2) and
  `scanProcesses` from `@/lib/tempSweep` (after L6). The existing call sites
  (`grep` finds 50 lines naming these child-process functions in 19 files and
  19 `Atomics.wait` lines in 15 files, imports and comments included) each get
  one `eslint-disable-next-line … -- <reason>`, which a reviewer then sees.
  Pre-commit and pre-push lint changed files, so the rule binds new code
  without a sweep.
- A blanket rule on synchronous filesystem calls is left out: the server code
  has 2,648 lines naming synchronous `fs` functions in 376 files, most of them
  small single-file reads, and RG2 refuses the expensive ones by their effect
  on the loop.

## Follow-up measured window

**When.** After the first deploy that carries L0a and L0b; then again after
each of L1-L5 deploys. A deploy restarts the hourly timers, so the window
starts at the deploy and ends 15 minutes after the second worktree pass
completes, at most 120 minutes, with `armMinutes: 120`. It spans startup, the
temp pass at +5 min, the worktree pass at +10 min, every done-sweep and
host-maintenance minute, a seat-tick sweep every 5 minutes, and the second
temp and worktree passes, due 1 h after the first ones end (the first helper
pass on `a25592be` was still running 10 minutes after it began).

**Load.** At least 8 live structured agents and 3 running lanes at the start
(`agent_fleet`), just below the two fleet reads of this day (11 live / 4
running at 14:00Z, 10 / 3 at 14:35Z). If load is lower at the start, the
window is rescheduled. Record `/proc/loadavg` and the fleet every 15 minutes.

**Records.** The journal for the window (M0, `--grep` on loop-gap and the
maintenance lines); M5 `/proc` sampling of both serving processes for the
whole window; at the end, `VACUUM INTO` copies of the MCP receipts and the state
database for per-hour counts. Production stays read-only.

**Pre-registered decision rules, per source.**

| Source | Measure | Before | Passes when |
| --- | --- | --- | --- |
| T1 (#3052) | Viewer gaps of at least 2 s whose profile holds worktree-sweep frames, while `worktrees.sweep` is pending | 11 gaps, 53.0 s in one pass | none |
| R2 (L1) | minutes with a host gap above 500 ms within 2 s of the boot-aligned second | 41 of 41; 15 of 15 | at most 2 % of the window's minutes |
| T6 (L2) | done-chain pass duration (`done.sweep` label) | median 943 ms (791-1,368 ms); 1.98-2.49 s for the first seven after a start | 95th percentile at most 100 ms |
| H1 (L3) | captured gaps where attribution frames exceed 5 % of samples | 3 of 19 in the `9c889c07` window | none |
| D6/H8 (L4) | Viewer gaps of at least 1 s ending within 0.4 s of a `curate_rules` completion; captured gaps with curation frames above 5 % of samples | 26 of 26 completions; 9 of 25 captured gaps above 20 % | none; `bindingMs` 95th percentile at most 300 ms |
| P2 (L5) | `pipelines.revalidate` seconds per running activation-hour | not labelled yet | measured in the first window; after L5, at most 1 % of the first window's value |
| Attribution | share of Viewer gap seconds (at least 1 s) with a non-umbrella label; share of profile samples under a mapped source | 89 % unknown watchdog samples | reported; any unlabelled source above 10 % of gap seconds gets an attribution task |

Aggregate seconds per hour are reported beside the 48-hour table for context
and decide nothing: hour-to-hour ratios of 0.36-2.75 with no code change exceed
any effect these slices can show in one window.

## Coverage gaps

1. **Most stall time has no named cause.** 89.28 % (Viewer) and 84.75 % (host)
   of watchdog samples in gaps of at least 1 s are
   `unknown-runtime-or-native`. The measured causes explain about 175-255 s of
   the Viewer's mean 701 s per hour; busy hours of 1,000-2,500 s are mostly
   unexplained (see [Explained and unexplained time](#explained-and-unexplained-time)).
2. **The largest stall in the arm window is unresolved.** 11.554 s at
   13:30:59.458Z: 118 of 118 watchdog samples unknown, 3.25 ms of retained
   `registry.keyed`, seat frames in 106 and liveness in 27 of 1,504 profile
   samples, and an RSS step of +3.2 GB inside the gap. Part 2 does not say
   whether the 48-hour maximum, 35,188 ms, carried a profile.
3. **GC and heap.** Bun exposes no GC entries (`gc-entry-unsupported`) and no
   cheap heap counters; native sampling is blocked (`perf_event_paranoid` 4).
   RSS steps of up to 4.2 GB inside a single gap (2026-10-17 13:57:00Z; 3.2 GB
   in the 11.554 s gap), a 30-minute peak of 6.89 GB and
   `VmHWM` 11.4 GB are context; no allocation is tied to a gap except through
   the replays' heap deltas (archive read +134 to +475 MB, R2 +107 MB).
4. **The runtime host has no JS profiler** (R6), and all its gaps report
   `operations: []`. R2's attribution rests on its cadence, the
   `registry.snapshot` spans inside each minute gap and the copy replay.
5. **Profiles cover 30 minutes after a deploy**, so the second hourly pass is
   never profiled, and dropped columns leave `11265:1 G`/`S`, `72293:80 h`/`s`,
   `92134:1 p`/`s`, `89508:1 q`/`u` and `36787:1 C`/`v`/`I` ambiguous (L0a).
6. **No process identity** on `[mcp slow]` and `[state transaction-hold]`,
   and registry `[blocking-wait]` records name their caller only by a minified
   `subject`; MCP calls under 2 s leave no line and carry no per-tool label;
   requests carry no route, so the request mix (H6) is unknown (L0b).
7. **Unmeasured units.** The phases inside a production `curate_rules` call
   (3.0-4.1 s, against 219-238 ms for the overview replay; L4 replays a pass
   first), the complete seat check (T9), a whole temp pass (T2),
   T8, T11 and T20 passes, delivery drains (A3: 1,885 drain-failure and 1,908
   timeout lines, not replayed), and the activity usage backfill (`41be75ea`,
   unserved).
8. **Unknown duty.** P2's activation and job duty, and how many tabs show the
   seat panel (H5), the resources footer (H3) or the rules window (H8); one
   view session was recorded at the inventory read.
9. **Replays are single-process.** Unit costs come from one Bun process on
   copied production-sized state under a 300 % CPU cap with load 3.8-14.1; the
   serving process runs them concurrently with other work, so they are lower
   bounds for contended runs.
10. **The deployed fixes have a first look only**: one worktree-sweep pass
    (completed 15:21:53Z) and 27 minutes of `a25592be`, inside its arm
    window.

## Validation against the requirement

The requirement asks what else blocks the two main loops, again and again. The
answer, by rank: the hourly worktree sweep (fixed, verification pending);
role-memory curation calls, each holding the Viewer loop for 3-4 s, 26 times
in one 3.6-minute pass, plus the role-memory view behind the rules window;
the runtime host's whole-registry read every minute; the Viewer's archive
read and cache eviction every minute; and the per-call MCP caller enumeration;
then the seat check, `/proc` scans and synchronous registry waits. Suspects
with measured unit costs follow, led by the 50 ms revalidation timers, and the busy-hour share stays
unexplained until L0a and L0b let the follow-up window name it. No operator
decision is open: L2's choice between a larger shared budget and a dedicated
archive slot is made above with its reason.

## Deferred — not currently justified

- Native or kernel sampling of production (`perf`), which needs an
  operator-level change of `perf_event_paranoid` or capabilities. The JS
  profiler and `/proc` sampling come first; revisit only if G2 stays the
  largest unexplained share after M3 and M5.
- A runtime-host loop profiler. In the audits read, its gaps were a fraction
  of the Viewer's: `cbaaf29a` reported 31.7 s summed (largest 1.6 s) against
  315.9 s for the Viewer in the 11:25-11:55Z window it read, and this audit's
  scoping window holds 369 runtime-host records against 3,841. Part 2 found the
  host's gaps on R2's minute cadence, and part 3 found `registry.snapshot`
  spans inside each of them, so L0b's labels and L1 come first. Revisit if,
  after L1, host gaps above 500 ms remain in more than 2 % of minutes.
- Inventorying every one of the 220 API routes. Only polled, timer-driven and
  tool-driven paths are listed; one-off operator actions are out of scope
  unless M1 finds a gap that overlaps nothing listed.
- A repository-wide ban on synchronous filesystem calls. Part 3 scoped the
  guards from the measured list: RG3 restricts synchronous child processes,
  `Atomics.wait` and the two measured whole-store helpers, and RG2 refuses
  expensive synchronous work by its effect on the loop.
- Client rendering and browser main-thread work. The brief covers the Viewer
  and runtime-host server loops.
- Archive retention, or slim per-revision projections of the archive. L2
  removes the per-minute clone and the eviction; the archive's resident size
  still grows with history (147.5 MiB at the heap-fix audit, 212.5 MiB now).
  Revisit when the archive slot passes twice the hot collections' size again
  or the follow-up window shows archive reads above 100 ms.
- Caching the board summary parse (T7, H4): 44.6-66.3 ms per read, about 3.4 s
  per hour from the reconcile timer. L8 removes it from the seat check if it
  dominates there.
- Rebuilding the runtime snapshot by changed scope (R1, deferred by `cbaaf29a`
  item 5): 3.0 s per hour of synchronous waits, largest 762.8 ms.
- The receipt sweep (R3, at most 26 ms per 10 s), archive maintenance (T3,
  about 0.25 s per hour), agent stdout parsing (A1/A2, about 1.1 s per hour)
  and the Codex launch probes (P3, about 80 ms per Codex host open). Each is
  bounded per call or below 7 s per hour.
- Memory refresh (S3): 41.0 s of retained spans in 48 hours, single spans up to
  1,563 ms. Revisit if the follow-up window shows spans above 1 s more than
  once per hour.
- Keyed task writes (D1). The holds (19,386, 5,627 s in 48 hours) have no
  process identity; L0b adds it, and the change is justified only if the
  Viewer holds a material share.
- A per-route request log (H6). L0b's labels name the polled handlers that
  cost; a route log adds volume without a measured need yet.
