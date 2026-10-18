# Main-thread blocking audit: Viewer and runtime host

Status: complete, revised 2026-10-18 after verification. Part 1 is the static
inventory (stage `inventory`), from [Requirement](#requirement) to
[Measurement catalogue](#measurement-catalogue); its `Status` column records
what was known before measurement. Part 2 is the production measurement (stage
`measure`), summarized under
[Measured and correlated stalls](#measured-and-correlated-stalls). Part 3
(stage `synthesize`) adds the first look at the fixes deployed at 15:04:33Z,
the [ranked list](#ranked-list), the
[remediation slices](#remediation-slices), the
[regression guards](#regression-guards), the
[follow-up window](#follow-up-measured-window) and the
[coverage gaps](#coverage-gaps). The revision of part 3 answers four
verification findings: it keeps production gap and profile-window durations
apart and counts no MCP binding wall time as stall time; it replaces the probe
snippet with the complete procedure every timed case ran from (M4), rerun on
fresh copies; it ranks by a stated, reproducible rule over normalized costs;
and it screens every API route and MCP tool handler
([Route and tool screen](#route-and-tool-screen)). Inventory rows H8-H12 were
added by part 3. A last recheck before hand-off found that the release applied
at 16:38:04Z (`72866c7d`, #3056) writes no loop-gap record on this
installation; [the observation](#loop-records-silenced-from-163657z-72866c7d)
and slice [L0c](#l0c-loop-records-reach-the-service-journal-again) carry it.

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
  is identical at both. Main has since moved to `2189404a` (#3055,
  `src/lib/telemetry/sender.ts` only), `72866c7d` (#3056, merged 15:52:49Z:
  startup diagnostics behind the CLI's debug switch, the loop-gap and
  performance-summary lines included, see
  [below](#loop-records-silenced-from-163657z-72866c7d); one comparison in
  `src/lib/agent/registry.ts`; one import in `src/lib/pipelines/controller.ts`,
  which moves that file's lines by one on main) and `6a1ea0d9` (#3048, merged
  16:29:58Z, the `41be75ea` activity token lane).
- **Serving revisions.** `$HOME/.config/delegatus/state/self-update/history.jsonl`
  records `kind: apply` for `c91603e0` at 2026-10-18T12:14:58.377Z, for
  `9c889c07` at 13:19:58.559Z, for `a25592be` at 15:04:33.370Z and for
  `72866c7d` at 16:38:04.273Z (its Viewer and runtime-host processes started
  at 16:36:57-59Z by `/proc`).
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
- **Revision of part 3, read and rerun 2026-10-18 15:48-16:36Z.** The journal
  for 2026-10-16 14:00Z to 2026-10-18 16:00Z was read again with
  `--grep '\[viewer loop-gap\]|\[mcp slow\]|…'` (39,055 lines) and analysed
  with the script under [M1b](#m1b-timer-chains-curator-passes-and-profile-windows).
  Every timed case was rerun from the procedure in [M4](#m4-replays-on-scratch-copies)
  on copies made at 16:09:06-16:09:10Z, export `a25592be` (the serving
  revision), Bun 1.4.0, 16:09:10-16:13:26Z, load 4.7-6.9, fleet 9 live /
  4 running at 16:09:13Z, once more from the document's own text at
  16:31:44-16:35:59Z, and a third time, with the journal checks, the receipt
  checks, the route and tool screen and `profile-view.ts`, from the final text
  at 16:44:10-16:52:02Z on export `72866c7d`, the revision then serving (see
  [Unit costs](#unit-costs-on-copied-state)). Receipt and curator-pass counts
  come from the 16:09Z copies. The route and tool screen ran over an export of
  `c91603e0`. Production was only read.

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
  (runs in another process; it can still contend on locks, CPU or I/O),
  `inactive here`, or `screened by part 3` (found by the
  [route and tool screen](#route-and-tool-screen)).
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
| T10 | seat-tick-driven role-memory curator and board maintenance (`src/lib/monitor/seatTickSettings.ts:386`, `:402`; `src/lib/boardMaintenance/run.ts:120` loads all tasks) | a curator pass per project when it has never run, when a scope holds uncurated rules at 90 % of its bound, after 10 new lessons (`CURATION_NEW_LESSONS`), or 6 h after the last (`src/lib/memory/curation/store.ts:175`); board maintenance every 3 h when enabled, off by default; 38 curator passes were claimed in 48 h (26 succeeded, 12 failed), 24 of them for one project | `memory.curation-*`; the curator agent's calls appear as `[mcp slow] tool=curate_rules` (see H1) | 3,911 role-memory rows; 3-49 retained curator passes per project; 2,347 tasks | curator calls measured by part 3 (ranked list, rank 2) | M1, M1b, M2 |
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
| H8 | role-memory view (added by part 3): `useProjectRules` (`src/components/roleMemory/LearnedRules.tsx:146-171`, used by the rules window `:349` and by the menu row `:454`) polls `GET /api/role-memory` → `src/app/api/role-memory/route.ts:16` → `src/lib/memory/roleStore.ts:499` `projectView`, which reads every role-memory row (`rows()`), filters all rules once per scope, and ends in `curationView` (`src/lib/memory/curation/store.ts:227-235`), which reads every scope row of the project once per retained curator pass (`readPass` → `curationScopes`, `:50-61`, `:95-112`); the same view runs in every `curate_rules` read (`src/lib/memory/curation/read.ts:20`, D6) | at once and every 15 s while the rules window, the project's ⋯ menu or the phone menu sheet is open; lessons every 20 s (`LearnedRules.tsx:27`, `:55`); each `curate_rules` read | `http.render` only; `[mcp slow] tool=curate_rules` for the tool | 3,911 rows / 16.0 MB, of which 102 scope rows hold 12.6 MB of history; 3-49 retained passes per project | measured by part 3 (curator calls rank 2; the poll in the duty table) | M3, M4 (`H8`, `D6-*`, `role-projects`) |
| H9 | task and pipeline request routes that clone whole collections (found by the [route screen](#route-and-tool-screen)): `POST /api/tasks` (`src/app/api/tasks/route.ts:105`: `loadTasks()`, then `sweepAttachments`, `src/lib/tasks/attachments.ts:96-106`, one `readdirSync` and a `statSync` per unreferenced file), `/api/tasks/[id]` (`route.ts:93`, `loadPipelines()`), `/api/tasks/[id]/assignment` (`:85`), `/api/tasks/[id]/send` (`:86`), `/api/tasks/[id]/spawn` (`:217`), `/api/pipelines/[id]` (`:140`, tasks and pipelines), `/api/pipelines` (`src/lib/pipelines/engine.ts:11903`), `/api/attention/dismissals` (`src/lib/attention/dismissals.ts:730`, a whole task list per task lookup), `POST /api/attention/[id]` (the attention service's `tasks` port, `src/lib/attention/service.ts:82`, found by hand), `/api/orchestrator/ghost` (`src/lib/orchestrator/deputyCommandPorts.ts:99`), launch membership (`src/lib/tasks/launchMembership.ts:327`) | each operator or tool action on those routes | `http.render` only | 2,347 tasks, 253 hot pipelines; no attachment directory exists here, so the sweep is one failing `readdirSync` | screened by part 3; unit costs D1, D3 | M4 (D1, D3) |
| H10 | `/api/transcribe` (`src/app/api/transcribe/route.ts:94`): `writeFileSync` of the uploaded audio to the temp directory before transcription, capped at 16 MiB (`:21`) | each dictation | `http.render` only | at most 16 MiB per request | screened by part 3; 6.3-13.8 ms at the cap | M4 (H10-write) |
| H11 | terminal launch routes (`/api/spawn`, `/api/tasks/[id]/spawn`, `/api/workflows`, `/api/workflows/[id]`): Codex transcript discovery walks the selected sessions directory and `stat`s every rollout on each poll (`src/lib/agent/spawnedTranscript.ts:44-70`, depth 6); `codex mcp list` through `spawnSync` (`src/lib/agent/cli.ts:295`, X4); external relay pairings walk Codex sessions until a match (`src/lib/externalRelay/conversations.ts:424`) | each terminal Codex spawn until its transcript appears; each relay pairing | `http.render` only | largest account sessions directory 1,671 rollouts; another sessions root holds 2,890 | screened by part 3; 4.2-7.0 ms per walk with a warm page cache | M4 (X5-codex-walk) |
| H12 | MCP tool bindings with whole-collection or liveness reads on the Viewer: `bridge_report` (`src/lib/mcp/bindings.ts:3905`), `pipeline_action` (`:7144`), `request_attention` (`:6868`), `dismiss_attention` (`:7234`), `create_pipeline` (`src/lib/pipelines/engine.ts:11903`, plus `systemctl` through `src/lib/runtime/agentMemory.ts:15`); `agent_activity` (`:6630`) runs the T9 liveness snapshot with a 1 s answer budget and refreshes the lifecycle journal (D8) on every call. The task tools run in the `mcp-tasks` helper on the HTTP transport (H1) | each tool call | `mcp.receipts`, `mcp.tasks.executor`; `[mcp slow]` for calls of at least 2 s | 48 h receipts: `agent_activity` 5,229, `pipeline_action` 208, `bridge_report` 207; `agent_activity` logged 240 calls of at least 2 s (811.7 s of binding wall time, largest 16.8 s) | screened by part 3; `agent_activity` per-call loop cost unmeasured | M4 (D1, T9-liveness) |

### Route and tool screen

Part 3 screened every API route handler and every MCP tool binding for
synchronous and CPU-heavy work, so that no handler family is left out by
assumption.

**Method.** `route-reach.ts` (below) builds a TypeScript program over an export
of `c91603e0` with the repository's `tsconfig.json`, takes each exported
`GET`/`POST`/`PUT`/`PATCH`/`DELETE` handler of the 220 `src/app/api/**/route.ts`
files (with the argument `mcp`: each of the 60 tool entries of the bindings table
in `src/lib/mcp/bindings.ts`), and follows every call the type checker resolves
to a function in `src/`, breadth first, up to six calls deep, recording the
first path to each sink. A handler may be a function, a function value, an
alias of an imported function (`export const GET = conversationHostGET`), a
factory call (`createConversationMigrationPOST()`) or a re-export
(`export { postInstallAction as POST } from …`); a binding initialized by a
factory call (`const read = doneReadHandler({ … })`) is followed into the
factory, closures included. The first version of the screen followed none of
the last four forms and reported 35 routes clean; the revision extended it and
reran it at 16:51:56Z. Sinks: synchronous child processes (`spawnSync`,
`execFileSync`, `execSync`), directory listings (`readdirSync`, `opendirSync`),
synchronous file writes (`writeFileSync`), the whole-collection readers
`loadTasks`, `loadPipelines` and `loadArchivedPipelines`, the registry read view
`readOnlySnapshot`, and the helpers this audit measured as heavy
(`projectView`, `stageLessons`, `readResourcesWithDiagnostic`,
`readDiskPressure`, `scanProcesses`, `operatorBoardRepresentation`,
`readLifecycleJournal`, `archiveSettledPipelines`, `indexTranscriptSources`,
`sweepAttachments`, `hostedConversationsFromSnapshot`). A helper counts only when
its declaration is in the expected file, or when the call goes through a port
typed after it (`dependencies.loadTasks()`); a same-named function elsewhere is
not a sink. Each first path was then read at its sink and classed by what it
enumerates or clones on this installation.

```sh
mkdir -p "$P/screen-export" && git archive c91603e0 | tar -x -C "$P/screen-export"     # from this worktree; $P, $GATE, $REV, $INSTALL as in M4
ln -s "$HOME/.cache/delegatus/self-update/$INSTALL/releases/${REV:0:12}/node_modules" "$P/screen-export/node_modules"
cp <dir>/route-reach.ts "$P/screen-export/" && cd "$P/screen-export"
bash "$GATE" bun ./route-reach.ts 6 > reach.json && bash "$GATE" bun ./route-reach.ts 6 mcp > tools.json   # about 10 s each
python3 -I - reach.json tools.json <<'PY'   # the totals below
import json, sys, collections
for f in sys.argv[1:]:
    d = json.load(open(f)); kinds = {k: {x.split(":")[0] for x in v} for k, v in d.items()}
    print(f, len(d), "reach", sum(1 for v in kinds.values() if v), "only write/registry", sum(1 for v in kinds.values() if v and v <= {"sync-write", "registry-snapshot"}),
          dict(collections.Counter(c for v in kinds.values() for c in v)), sorted(k for k, v in kinds.items() if not v) if f.startswith("reach") else "")
PY
```

`route-reach.ts`:

```ts
// bun route-reach.ts [depth]: from each API route handler, follow calls (resolved by the type checker) up to `depth`
// hops and report the first path to each sink. Run from an export of the revision; it reads source only.
import ts from "typescript";
import path from "node:path";
const depth = Number(process.argv[2] ?? 6), root = process.cwd();
// name -> [kind, files that may declare it]; Node built-ins are matched by name outside src/
const SINKS: Record<string, string[]> = {
  spawnSync: ["child-sync"], execFileSync: ["child-sync"], execSync: ["child-sync"], readdirSync: ["dir-walk"], opendirSync: ["dir-walk"], writeFileSync: ["sync-write"],
  loadTasks: ["whole-store", "src/lib/tasks/store.ts"], loadPipelines: ["whole-store", "src/lib/pipelines/store.ts"],
  loadArchivedPipelines: ["whole-store", "src/lib/pipelines/store.ts"], readOnlySnapshot: ["registry-snapshot", "src/lib/agent/registry.ts", "src/lib/agent/sqliteRegistryStore.ts"],
  operatorBoardRepresentation: ["heavy", "src/app/api/files/operatorProjection.ts"], readDiskPressure: ["heavy", "src/lib/state/diskPressure.ts"],
  scanProcesses: ["heavy", "src/lib/tempSweep.ts"], projectView: ["heavy", "src/lib/memory/roleStore.ts"], stageLessons: ["heavy", "src/lib/memory/roleStore.ts"],
  readLifecycleJournal: ["heavy", "src/lib/lifecycle/journal.ts"], archiveSettledPipelines: ["heavy", "src/lib/pipelines/store.ts"],
  indexTranscriptSources: ["heavy", "src/lib/search/transcriptSearch.ts"], sweepAttachments: ["heavy", "src/lib/tasks/attachments.ts"],
  hostedConversationsFromSnapshot: ["heavy", "src/lib/mcp/bindings.ts"], readResourcesWithDiagnostic: ["heavy", "src/lib/resources.ts"],
};
const config = ts.getParsedCommandLineOfConfigFile("tsconfig.json", {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })!;
const routes = config.fileNames.filter(f => /\/src\/app\/api\/.*\/route\.tsx?$/.test(f));
const program = ts.createProgram({ rootNames: routes, options: { ...config.options, noEmit: true, incremental: false } });
const checker = program.getTypeChecker();
const rel = (n: ts.Node) => { const s = n.getSourceFile(); return `${path.relative(root, s.fileName)}:${s.getLineAndCharacterOfPosition(n.getStart()).line + 1}`; };
const inSrc = (n: ts.Node) => { const f = n.getSourceFile().fileName; return f.startsWith(path.join(root, "src")) && !/\.(test|spec)\.|\.d\.ts$/.test(f); };
// A function, or what a binding stands for: `const x = f` follows f, `const x = factory(...)` follows the factory call (its returned closures included).
const fnOf = (d: ts.Declaration): ts.Node | null => {
  if (ts.isFunctionLike(d)) return d;
  const init = ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d) ? d.initializer : undefined;
  if (!init) return null;
  if (ts.isFunctionLike(init) || ts.isCallExpression(init)) return init;
  if (ts.isIdentifier(init)) { const target = declarationsOf(init).map(fnOf).find(Boolean); return target ?? null; }
  return null;
};
function declarationsOf(n: ts.Node): ts.Declaration[] {
  let symbol = checker.getSymbolAtLocation(n);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return (symbol?.declarations ?? []).filter(inSrc);
}
const nameOf = (callee: ts.Expression) => ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : null;
function callees(fn: ts.Node) {
  const out: { name: string | null; site: ts.Node; targets: ts.Node[]; declared: string[] }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = n.expression; const name = nameOf(callee);
      let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declared = (symbol?.declarations ?? []).map(d => path.relative(root, d.getSourceFile().fileName));
      const targets = (symbol?.declarations ?? []).filter(inSrc).map(fnOf).filter((x): x is ts.Node => !!x);
      out.push({ name, site: n, targets, declared });
    }
    ts.forEachChild(n, visit);
  };
  if (ts.isCallExpression(fn)) visit(fn); else ts.forEachChild(fn, visit);
  return out;
}
// Roots: each route's exported method handlers; with `mcp`, each tool entry of the bindings table (its calls are dispatched by name at run time).
const roots: [string, ts.Node[]][] = [];
for (const file of routes) {
  const source = program.getSourceFile(file)!; const handlers: ts.Node[] = [];
  source.forEachChild(n => {
    if (ts.isFunctionDeclaration(n) && n.name && /^(GET|POST|PUT|PATCH|DELETE)$/.test(n.name.text)) handlers.push(n);
    if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name) && /^(GET|POST|PUT|PATCH|DELETE)$/.test(d.name.text) && d.initializer) { const f = fnOf(d); if (f) handlers.push(f); }
    // `export { handler as GET } from "..."`
    if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause)) for (const e of n.exportClause.elements) if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(e.name.text)) handlers.push(...declarationsOf(e.name).map(fnOf).filter((x): x is ts.Node => !!x));
  });
  roots.push(["/" + path.relative(path.join(root, "src/app"), file).replace(/\/route\.tsx?$/, ""), handlers]);
}
if (process.argv.includes("mcp")) {
  const bindings = program.getSourceFile(path.join(root, "src/lib/mcp/bindings.ts"))!; roots.length = 0;
  const visit = (n: ts.Node) => { if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && /^[a-z]+(_[a-z]+)+$/.test(n.name.text) && (ts.isFunctionLike(n.initializer) || ts.isCallExpression(n.initializer)) && !roots.some(r => r[0] === `mcp:${(n.name as ts.Identifier).text}`)) roots.push([`mcp:${n.name.text}`, [n.initializer]]); ts.forEachChild(n, visit); };
  visit(bindings);
}
const result: Record<string, Record<string, string[]>> = {};
for (const [route, handlers] of roots) {
  const found: Record<string, string[]> = {}; const seen = new Set<ts.Node>(handlers);
  let frontier = handlers.map(h => ({ fn: h, trail: [] as string[] }));
  for (let hop = 0; hop <= depth && frontier.length; hop++) {
    const next: typeof frontier = [];
    for (const { fn, trail } of frontier) for (const call of callees(fn)) {
      const sink = call.name && Object.hasOwn(SINKS, call.name) ? SINKS[call.name] : undefined;
      // A port typed `typeof loadTasks` resolves to its property signature (no body): keep it; a same-named function elsewhere is not the sink.
      const kind = sink && (sink.length > 1 ? sink.slice(1).some(f => call.declared.includes(f)) || !call.targets.length : !call.declared.some(f => f.startsWith("src/"))) ? sink[0] : undefined;
      if (kind) { const key = `${kind}:${call.name}`; if (!found[key]) found[key] = [...trail, rel(call.site)]; continue; }
      for (const t of call.targets) if (!seen.has(t)) { seen.add(t); next.push({ fn: t, trail: [...trail, rel(call.site)] }); }
    }
    frontier = next;
  }
  result[route] = found;
}
console.log(JSON.stringify(result));
```

**Totals.** Of 220 routes, 199 reach at least one sink and 21 reach none
(review-history 3, runtime 3, team 3, attention 2, tts 2, and one each in
accounts, agent, inbox, keys, projects, task-icons, transcribe and view; each
is read by hand below). 96 routes reach only single-file writes or the cached
registry view. Routes reaching each sink class: whole collection 34, child
process 15, measured heavy helper 6, directory listing 93, registry view 118,
single-file write 179. Of 60 tool bindings, 52 reach a sink: whole collection
9, child process 2, heavy helper 7, directory listing 47, registry view 23,
single-file write 51.

| Sink site (first path) | Routes or tools reaching it | Class on this installation | Row |
| --- | --- | --- | --- |
| `loadTasks` at route lines `src/app/api/tasks/route.ts:105`, `tasks/[id]/assignment/route.ts:85`, `tasks/[id]/send/route.ts:86`, `tasks/[id]/spawn/route.ts:217`, `pipelines/[id]/route.ts:140`; `src/lib/pipelines/engine.ts:11903`; `src/lib/attention/dismissals.ts:730`; `src/lib/orchestrator/deputyCommandPorts.ts:99`; `src/lib/tasks/launchMembership.ts:327` | 11 routes, and `POST /api/attention/[id]` through a port (read by hand); tools `bridge_report`, `pipeline_action`, `request_attention`, `dismiss_attention` and `create_pipeline` on the Viewer, `list_tasks`, `get_task` and `update_task` in the `mcp-tasks` helper | whole task clone per action, 48.4-106.3 ms (D1); the seat panel route is H5 | H9, H12 |
| `loadPipelines` at `src/app/api/tasks/[id]/route.ts:93`, `pipelines/[id]/route.ts:140` | 2 routes | whole hot clone per action, 52.3-88.1 ms (D3) | H9, P6 |
| `loadTasks` at `src/lib/tasks/store.ts:831` (`loadPrototypeTask`) | 11 routes (prototype reviews, image, external relay) | legacy fallback taken only when the keyed task collection is absent; inactive here | — |
| `loadTasks` at `src/app/api/files/response.ts:708` | `/api/files` | inline projection, taken when the response worker is not used (`operatorProjection.ts:432`); no `files.clone` span was retained in any Viewer gap of the 48 hours | H2 |
| `loadArchivedPipelines` at `src/lib/taskAlbum/world.ts:20` | 3 routes (task album) | archive clone, 204-282 ms (D2) | D2, L2 |
| `loadPipelines` at `src/lib/forge/autoMerge.ts:699`, `loadTasks` at `src/lib/forge/sweep.ts:107`, `archiveSettledPipelines` | `/api/pipelines/tick`, deployment, self-update action and launcher-admission routes (they run a controller pass) | T3, T4, T5 | T3-T5 |
| `hostedConversationsFromSnapshot` at `src/lib/mcp/bindings.ts:1251` | tools `account_project_binding`, `auto_updates`, `bridge_directive`, `bridge_report`, `deploy_exact_sha`, `seat_tick_settings` directly; every caller-resolving tool through its attribution port | 31.8-106.1 ms per enumeration (H1) | H1 |
| `projectView`, `stageLessons` | `/api/role-memory`, `/api/role-memory/lessons`; tool `curate_rules` | measured: 0.31-3.73 s per view by project | H8, D6 |
| `readResourcesWithDiagnostic` | `/api/resources` | H3 | H3 |
| `readLifecycleJournal` at `src/lib/projects/worktreeBackfill.ts:260` | `/api/board/maintenance/worktrees` (also the backfill tool) | whole 1.3 MB journal, 4.1-8.5 ms (D8), per operator action | D8 |
| `sweepAttachments` | `POST /api/tasks` | attachment directory absent here: one failing `readdirSync`; with attachments, a `statSync` per unreferenced file | H9 |
| `spawnSync` at `src/lib/agent/cli.ts:295` (`codex mcp list`) | 6 routes (spawn, task spawn, pipelines, workflows) | terminal launches only | X4, H11 |
| `execFileSync` at `src/lib/runtime/agentMemory.ts:15` (`systemctl --user show`) | `/api/pipelines`, `/api/pipelines/[id]`; tool `create_pipeline` | 3.7-5.4 ms per launch admission (X2) | P3 |
| `spawnSync` at `src/lib/selfUpdate/actions.ts:217` | 5 deployment and self-update routes | operator deploy actions | X4 |
| `spawnSync` at `src/lib/runtime/cpuAdmission.ts:62` (`machineHome`) | `/api/flows`, `/api/pipelines/preflight` | one child per process, cached on `globalThis` | P4 |
| `spawnSync` at `src/lib/processIdentity.ts:42` | 2 routes; tool `seat_tick_settings` | macOS branch; inactive on Linux | — |
| `readdirSync` at `src/lib/agent/spawnedTranscript.ts:50`, `src/lib/externalRelay/conversations.ts:424` | 6 routes | Codex session walks; grow with history: 1,671 rollouts in the largest account directory, 4.2-7.0 ms per walk warm (X5) | H11 |
| `readdirSync` at `src/lib/telegram/sessionStore.ts:173`, `src/lib/externalRelay/answers.ts:82`, `src/lib/memory/index.ts:761`, `:818`, `src/lib/scanner/describe.ts:349` | 1-6 routes each; tools `create_pipeline`, `spawn_agent`, `role_presets` and `create_task` (`describe.ts:349`) | grow with history (2,629 files under the Telegram state, 1,760 under the external relay state); `describe.ts:349` walks only prefixes a slug can still match (depth 32, 16 matches); unmeasured | coverage gap 8 |
| `readdirSync` at `src/lib/state/fileTransaction.ts:128`, `src/lib/accounts/accountMutation.ts:247`, `src/lib/selfUpdate/mode.ts:96`, `src/lib/accounts/providerSecretRedaction.ts:250`, `src/lib/activity/requestLedger.ts:138`, `src/lib/state/legacyImport.ts:234`, `src/lib/scanner/links.ts:347`, `src/lib/voiceCompanion/transcriptRecord.ts:128`, `src/lib/issueReports/store.ts:142`, `src/lib/onboarding/healthCheck.ts:959`, `src/lib/runtime/runtimeImageStore.ts:690`, `src/lib/selfUpdate/actions.ts:142`, account, asks, bridge, CPU-budget and runtime-startup listings | 1-10 routes each; most tools reach `providerSecretRedaction.ts:250` | bounded: lock-ticket queues (one file per waiter), launcher records, account homes, ledger day files within retention, about 90 state entries, at most 58 transcripts per Claude project, 25 voice sessions, 48 issue reports, onboarding health-run folders; the releases directory (85 entries, a `git` read awaited per entry) only on an operator's self-update action | — |
| `readdirSync` at `src/lib/scanner/roots.ts:58`, `src/lib/limits/copilotTranscriptLimits.ts:19`, `src/lib/agent/copilotModels.ts:71` | 19, 2 and 1 routes | inactive here: no OpenClaw directory; Copilot listings run only for Copilot accounts | — |
| `writeFileSync` (55 sites) | 179 routes, 51 tools | one small file per request: the legacy-migration sentinel (`src/lib/configDir.ts:152`, once per directory per process, 63 routes), file-transaction tickets, project aliases, durable JSON, account and relay state; the largest capped payload is H10 | H10 |
| `readOnlySnapshot` | 118 routes, 23 tools | cached per registry revision: 0.4-0.5 ms cached, 3.6-4.6 ms after one write, 570 ms cold (D4) | D4 |

**The 21 routes the screen reports clean, read by hand.** Two reach a whole
collection through a production port the screen cannot follow:
`POST /api/attention/[id]` clones every task through the service's `tasks`
port (`src/lib/attention/service.ts:82`, the D1 cost per answer; H9), and
`GET /api/attention/done` reads the archive through the done world
(`src/lib/done/world.ts:41-49`, the D2 clone, at most once per 60 s and shared
with T6). The three review-history routes read keyed rows of a read-only
connection in pages of at most 100 with a per-row byte cap
(`src/lib/reviewHistory/reader.ts:36-90`): bounded. The three runtime routes
are RPC calls to the runtime host (A4) and an in-memory wait ring. The others
read one small file or nothing: the CLI binary `stat` (accounts), the key
store, team member files, the dictation and speech backend settings, request
bodies (typing latency, attention events) and asynchronous inbox reads. The
same port limit hides the summary parse of `/api/attention/needs-you` (H4),
which the screen reaches only up to its registry and slug-walk sinks.

**Limits.** The screen follows calls the type checker resolves. It does not
follow calls through ports whose implementation is assigned elsewhere (the
production dependency objects, such as the needs-you `read` port and the
attention service's `tasks` port above), calls made by name at run time (the MCP
server's `bindings[tool](…)`, which is why tools are screened separately),
worker messages, dynamic imports, or paths deeper than six calls, and it treats
every branch as taken. A path it reports may be conditional; a handler it
reports clean may still reach work through a port. Both kinds of miss are
listed under [Coverage gaps](#coverage-gaps).

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
8. A captured profile covers the profiler's 5 s collection window
   (`LOOP_PROFILE_WINDOW_MS`, `src/lib/loopProfiler.ts` at `9c889c07`), which
   overruns when the loop is blocked and is attached whole to each qualifying
   gap inside it. Its samples are window samples: they cannot be placed inside
   the gap, and a window's length is not a gap's (added by part 3's revision,
   M1b).
9. `[mcp slow] bindingMs` is wall time across awaits
   (`src/lib/mcp/server.ts:3268-3332`); it is no measure of loop occupancy
   (added by part 3's revision).

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

### M1b. Timer chains, curator passes and profile windows

Part 3's revision dates sources by the timing of the gaps themselves, so no
binding wall time and no profile window stands in for a gap. Read the journal
once:

```sh
journalctl --user -u delegatus.service --utc --all --no-pager -o short-iso-precise \
  --since "2026-10-16 14:00:00 UTC" --until "2026-10-18 16:00:00 UTC" \
  --grep '\[viewer loop-gap\]|\[mcp slow\]' > "$TMPDIR/journal.txt"
python3 -I journal-checks.py "$TMPDIR/journal.txt"
python3 -I receipt-checks.py "$P/state/state.sqlite" "$P/state/mcp-receipts.sqlite"
```

- **Fixed-phase chains** (runtime host): a gap belongs to a chain when the next
  gap of the same process starts 60, 120 or 180 s later within 1.0 s; chains of
  at least five gaps count. A `setInterval` of 60 s started at boot (R2,
  `src/runtime-host/main.ts:332`) starts its gaps on that phase. The count
  barely depends on the tolerance: 2,868 gaps at ±0.25 s, 2,880 at ±1.0 s
  (equal to the window's minutes by coincidence), 2,903 at ±2.0 s.
- **Re-arm chains** (Viewer): the next gap starts 60 s after the previous gap
  ended, within 0.25 s or, stricter, 0.15 s (learned from the done-sweep chain):
  the signature of a timer re-armed 60 s after its pass ends whose pass is the
  gap. The done sweep (T6) and the attention reconcile (T7) both re-arm this
  way; the chain does not tell them apart, the first delay and the profiles
  below do. A link displaced by an await longer than the tolerance breaks the
  chain, so the count is a lower bound of the chain's presence.
- **Curator passes**: the Viewer's share of wall time inside logged gaps from
  the first call's start (`serviceTotalMs` before its line) to the last call's
  line, against the same length before and after; and how long after the
  preceding gap's end each completion line was written.
- **Receipts** classify `curate_rules` calls by the shape of their stored
  result (scope read, overview, apply, error) without printing it, and assign
  each to the curator pass whose claim-to-end interval contains it.

`journal-checks.py`:

```py
# python3 -I journal-checks.py <journal.txt>  (journalctl -o short-iso-precise --grep '\[viewer loop-gap\]|\[mcp slow\]')
import json, re, sys, collections
from datetime import datetime
def ts(s): return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
gaps, slow = [], []
for line in open(sys.argv[1], errors="replace"):
    at = ts(line.split(" ", 1)[0]); i = line.find("[viewer loop-gap] {")
    if i >= 0:
        r = json.loads(line[i + 18:]); end = ts(r["utc"]); gaps.append((r.get("role"), r.get("pid"), end - r["gapMs"] / 1000, end, r["gapMs"], r))
    elif "[mcp slow]" in line:
        m = dict(re.findall(r"(\w+)Ms=(\d+)", line)); slow.append((at, re.search(r"tool=(\w+)", line).group(1), {k: int(v) for k, v in m.items()}))
W0, W1 = ts("2026-10-16T14:00:00Z"), ts("2026-10-18T14:00:00Z")
# 1. A profile window is not a gap: the 13:29:01.855Z record
for *_, r in gaps:
    if r["utc"] == "2026-10-18T13:29:01.855Z":
        p = r["jsProfile"]; rows = {f"{x['file']}:{x['line']} {x['function']}": x["total"] for x in p["frames"]["rows"]}
        print("13:29:01Z gapMs", r["gapMs"], "profile window ms", round(p["to"] - p["from"]), "samples", p["frames"]["samples"], "attribution cF", rows.get(".next/server/chunks/25514.js:34 cF"))
# 2. Curator passes: Viewer gap share inside each pass against the same length before and after
def share(a, b):
    v = [g for g in gaps if g[0] == "viewer"]
    return round(100 * sum(max(0, min(g[3], b) - max(g[2], a)) for g in v) / (b - a), 1), sum(1 for g in v if a <= g[3] <= b and g[4] >= 2000)
for lo, hi in (("2026-10-18T15:18:55Z", "2026-10-18T15:22:40Z"), ("2026-10-18T15:34:00Z", "2026-10-18T15:39:00Z")):
    calls = [s for s in slow if s[1] == "curate_rules" and ts(lo) <= s[0] <= ts(hi)]
    a, b = calls[0][0] - calls[0][2]["serviceTotal"] / 1000, calls[-1][0]; n = b - a
    ends = sorted(g[3] for g in gaps if g[0] == "viewer" and a - 10 <= g[3] <= b)
    lag = sorted(round(c[0] - max(e for e in ends if e <= c[0]), 2) for c in calls if any(e <= c[0] for e in ends))
    print(f"curator pass {lo[11:19]}: calls>=2s {len(calls)}, binding ms {min(c[2]['binding'] for c in calls)}-{max(c[2]['binding'] for c in calls)},"
          f" gap share/≥2s inside {share(a, b)}, before {share(a - n, a)}, after {share(b, b + n)}; completion minus previous gap end s {lag[0]}-{lag[-1]}")
# 3. Timer chains over the 48 hours: host gaps on a fixed 60 s phase, Viewer gaps on a 60 s re-arm (next start = previous end + 60 s)
def chained(rows, link, minimum=5):
    rows.sort(key=lambda g: g[2]); nxt = {}
    for i, g in enumerate(rows):
        for j in range(i + 1, len(rows)):
            d = link(g, rows[j])
            if d == "past": break
            if d: nxt[i] = j; break
    heads, keep = set(nxt) - set(nxt.values()), set()
    for h in heads:
        c = [h]
        while c[-1] in nxt: c.append(nxt[c[-1]])
        if len(c) >= minimum: keep.update(c)
    return [rows[k] for k in keep]
def phase(tol):
    def f(a, b): d = b[2] - a[2]; return "past" if d > 180 + tol else any(abs(d - 60 * k) <= tol for k in (1, 2, 3))
    return f
def rearm(tol):
    def f(a, b): d = b[2] - (a[3] + 60); return "past" if d > tol else abs(d) <= tol
    return f
for role, link, label in (("runtime-host", phase(1.0), "fixed 60 s phase ±1.0 s"), ("viewer", rearm(0.25), "60 s re-arm ±0.25 s"), ("viewer", rearm(0.15), "60 s re-arm ±0.15 s")):
    by = collections.defaultdict(list)
    for g in gaps:
        if g[0] == role and W0 <= g[3] < W1: by[g[1]].append(g)
    allg = [g for v in by.values() for g in v]; ch = [g for v in by.values() for g in chained(v, link)]
    print(f"{role} {label}: {len(ch)} of {len(allg)} gaps, {sum(g[4] for g in ch) / 1000:.1f} of {sum(g[4] for g in allg) / 1000:.1f} s, {sum(g[4] for g in ch) / 48000:.1f} s/h")
# 4. Slow MCP calls in the 48 hours, by tool (binding wall time; http is a subphase)
t = collections.defaultdict(list)
for at, tool, m in slow:
    if W0 <= at < W1: t[tool].append(m)
for tool, v in sorted(t.items(), key=lambda x: -sum(m["binding"] for m in x[1]))[:8]:
    print(f"mcp {tool}: {len(v)} calls, binding {sum(m['binding'] for m in v) / 1000:.1f} s, http {sum(m.get('http', 0) for m in v) / 1000:.1f} s, largest {max(m['binding'] for m in v)} ms")
```

`receipt-checks.py`:

```py
# python3 -I receipt-checks.py <state.sqlite copy> <mcp-receipts.sqlite copy>: counts only, no row content is printed
import sqlite3, sys, json, collections
from datetime import datetime
ro = lambda f: sqlite3.connect(f"file:{f}?mode=ro", uri=True)
st, mr = ro(sys.argv[1]), ro(sys.argv[2])
ms = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000
W0, W1 = ms("2026-10-16T14:00:00Z"), ms("2026-10-18T14:00:00Z")
rows = lambda kind: [json.loads(v) for (v,) in st.execute("SELECT value_json FROM state_rows WHERE collection = 'role_memory_curation' AND row_key LIKE ?", (kind + ":%",))]
retained = {r["project"]: len(r["passes"]) for r in rows("p")}
rank = {p: i for i, p in enumerate(sorted(retained, key=lambda p: -retained[p]))}
passes = [(ms(r["claimedAt"]), ms(r["endedAt"]) if r.get("endedAt") else ms(r["claimedAt"]) + 3_600_000, r["project"], r["state"]) for r in rows("r") if r.get("claimedAt")]
window = [p for p in passes if W0 <= p[0] < W1]
print("retained passes per project, by rank:", [retained[p] for p in sorted(retained, key=rank.get)])
print("passes claimed in 48 h:", len(window), dict(collections.Counter(p[3] for p in window)), "per project rank:", dict(sorted(collections.Counter(rank.get(p[2]) for p in window).items())))
def kind(text):
    try: r = json.loads(text)
    except ValueError: return "unparsed"
    return "error" if not isinstance(r, dict) or r.get("ok") is False else "scope-read" if "rules" in r else "overview" if "scopes" in r else "apply"
calls = collections.Counter()
for text, at in mr.execute("SELECT result_json, claimed_at FROM mcp_receipts WHERE receipt_key LIKE 'curate_rules:%' AND claimed_at >= ? AND claimed_at < ?", (W0, W1)):
    owner = [p for p in passes if p[0] - 5_000 <= at <= p[1] + 60_000]
    calls[(kind(text), rank.get(owner[-1][2]) if owner else "none")] += 1
print("curate_rules receipts in 48 h by kind and pass project rank:", dict(sorted(calls.items(), key=str)))
tools = collections.Counter(k.split(":", 1)[0] for (k,) in mr.execute("SELECT receipt_key FROM mcp_receipts WHERE claimed_at >= ? AND claimed_at < ?", (W0, W1)))
print("receipts in 48 h:", sum(tools.values()), tools.most_common(8))
```

Output of both at 16:20Z on the copies of 16:09Z:

```text
13:29:01Z gapMs 2639 profile window ms 5677 samples 553 attribution cF 223
curator pass 15:18:55: calls>=2s 26, binding ms 3032-4098, gap share/≥2s inside (73.0, 24), before (7.7, 0), after (11.8, 1); completion minus previous gap end s 1.98-3.6
curator pass 15:34:00: calls>=2s 27, binding ms 0-5392, gap share/≥2s inside (53.6, 24), before (20.3, 1), after (10.3, 1); completion minus previous gap end s 1.04-3.24
runtime-host fixed 60 s phase ±1.0 s: 2880 of 3076 gaps, 2995.4 of 3128.2 s, 62.4 s/h
viewer 60 s re-arm ±0.25 s: 1086 of 33216 gaps, 1038.6 of 48230.6 s, 21.6 s/h
viewer 60 s re-arm ±0.15 s: 626 of 33216 gaps, 533.6 of 48230.6 s, 11.1 s/h
mcp curate_rules: 589 calls, binding 2872.7 s, http 0.0 s, largest 18214 ms
mcp search_transcripts: 185 calls, binding 1206.9 s, http 1206.6 s, largest 47476 ms
mcp agent_activity: 240 calls, binding 811.7 s, http 0.0 s, largest 16808 ms
retained passes per project, by rank: [49, 23, 16, 12, 7, 3, 1]
passes claimed in 48 h: 38 {'succeeded': 26, 'failed': 12} per project rank: {0: 24, 1: 7, 2: 4, 3: 1, 4: 1, 5: 1}
curate_rules receipts in 48 h by kind and pass project rank: scope reads 624 / 73 / 74 / 23 / 16 / 23, overviews 44 / 7 / 7 / 2 / 2 / 2, applies 44 / 9 / 5 / 1 / 1 / 1, errors 19 / 4 / 0 / 0 / 0 / 0 (ranks 0-5)
receipts in 48 h: 8920; agent_activity 5229, curate_rules 981, stage_report 523, update_task 421, leave_lesson 333, search_memory 273, pipeline_action 208, bridge_report 207
```

The second pass's `binding ms 0-5392` includes its first call (15:34:23Z),
whose line reads `bindingMs=0` with `serviceTotalMs=5755`: the phases the line
lists do not account for that call's time. Receipt retention prunes as it
goes: the same 48-hour window held 8,980 receipts in part 3's copy of 15:02Z,
8,920 at 16:09Z and 8,892 at 16:31Z, the difference all in `search_memory`
(325, 273, 252), so receipt-based counts are lower bounds. The receipt lines are condensed from the script's dictionaries.

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

Never against the operator's state, registry or worktrees. Every timed case in
this document runs from the four files below; save them in one directory
outside the worktree (the stage scratch), then run, from this worktree:

```sh
P="$TMPDIR/probe"; REV=<serving revision, full sha>; INSTALL=<install id>; PORT=<a closed port>
GATE="$HOME/.cache/delegatus/self-update/$INSTALL/releases/${REV:0:12}/scripts/gate-slot.sh"
P=$P REV=$REV INSTALL=$INSTALL bash "$GATE" bash <dir>/prepare.sh
P=$P REV=$REV INSTALL=$INSTALL PORT=$PORT bash "$GATE" bash <dir>/run-probes.sh
python3 -I <dir>/summarize.py "$P/out"
```

The serving revision is the `target` of the newest `kind: apply` row of
`$HOME/.config/delegatus/state/self-update/history.jsonl`; the install id is
the directory under `$HOME/.cache/delegatus/self-update/`. `prepare.sh` reads
production only through read-only SQLite connections (`VACUUM INTO`) and file
copies. Copy it as written: the runtime journal does not open without its key
file, and the role-memory cases need `project-aliases.json` and its siblings so
that project keys resolve as they do in the Viewer. `run-probes.sh` refuses an
open port, then runs each case in a fresh Bun process with HOME, XDG, TMPDIR,
`LLV_STATE_DIR` and `CODEX_HOME` under `$P`, the control URL on the closed port,
and both sweeps in dry-run.

`prepare.sh`:

```sh
#!/usr/bin/env bash
# Usage: P=<stage scratch dir> REV=<serving revision> INSTALL=<install id> bash prepare.sh
set -euo pipefail
: "${P:?}" "${REV:?}" "${INSTALL:?}"
PROD="$HOME/.config/delegatus/state"
REL="$HOME/.cache/delegatus/self-update/$INSTALL/releases/${REV:0:12}"
mkdir -p "$P/export" "$P/state/self-update" "$P/home" "$P/xdg" "$P/cache" "$P/run-tmp" "$P/transcripts"
git -C "$(git rev-parse --show-toplevel)" archive "$REV" | tar -x -C "$P/export"
ln -sfn "$REL/node_modules" "$P/export/node_modules"   # read-only use of the release's dependencies
for db in state.sqlite agent-registry.sqlite mcp-receipts.sqlite memory-index.sqlite delivery-progress.sqlite "runtime-events-$INSTALL.sqlite"; do
  python3 -I -c 'import sqlite3,sys; c=sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True); c.execute("VACUUM INTO ?", (sys.argv[2],)); c.close()' \
    "$PROD/$db" "$P/state/$db"
done
install -m 600 "$PROD/runtime-events-$INSTALL.sqlite.key" "$P/state/"   # the journal refuses to open without its key; never print it
for f in board-summary-bootstrap.bin lifecycle-journal.json orchestrator-seats.json worktree-sweep-report.json \
         operator-asks.json view-presence.json host-retirement-journal.ndjson project-catalog.json self-update/history.jsonl \
         project-aliases.json project-remotes.json worktree-map.json; do
  [ -f "$PROD/$f" ] && cp -p "$PROD/$f" "$P/state/$f"
done
# S2, A1, A2 inputs: the five largest Claude/Codex transcripts changed in the last hour (plus the largest of a missing engine), copied
python3 -I - "$P" <<'PY'
import json, pathlib, shutil, sys, time
p = pathlib.Path(sys.argv[1]); files = json.load(open(p / "state/project-catalog.json"))["files"]; rows = []
for key, value in files.items():
    path = pathlib.Path(key)
    try: st = path.stat()
    except OSError: continue
    if path.suffix == ".jsonl" and st.st_mtime >= time.time() - 3600 and value.get("engine") in ("claude", "codex"):
        rows.append((st.st_size, path, value["engine"], st.st_mtime))
rows.sort(key=lambda r: -r[0]); chosen = rows[:5]
for engine in ("claude", "codex"):
    if not any(r[2] == engine for r in chosen):
        chosen += [r for r in rows if r[2] == engine][:1]
sources = []
for index, (size, path, engine, mtime) in enumerate(chosen):
    target = p / "transcripts" / f"{index}.jsonl"; shutil.copyfile(path, target)
    sources.append({"path": str(target), "size": target.stat().st_size, "mtimeMs": mtime * 1000, "project": "audit-fixture", "engine": engine})
json.dump(sources, open(p / "transcripts.json", "w"))
print(json.dumps({"eligible": len(rows), "copied": [(s["engine"], s["size"]) for s in sources]}))
PY
# T6-evict at 512 MiB: a second export that differs only in the shared read-cache budget
mkdir -p "$P/export512"; git -C "$(git rev-parse --show-toplevel)" archive "$REV" | tar -x -C "$P/export512"
ln -sfn "$REL/node_modules" "$P/export512/node_modules"
sed -i 's/^const MAX_BYTES = 256 \* 1024 \* 1024;/const MAX_BYTES = 512 * 1024 * 1024;/' "$P/export512/src/lib/state/collectionReadCache.ts"
grep -q '^const MAX_BYTES = 512 \* 1024 \* 1024;' "$P/export512/src/lib/state/collectionReadCache.ts"
cp "$(dirname "$0")/probe.ts" "$P/export/probe.ts"; cp "$(dirname "$0")/probe.ts" "$P/export512/probe.ts"
```

`probe.ts` (copied into both exports by `prepare.sh`):

```ts
// bun ./probe.ts <case> [runs]; run from the scratch export so `@/` resolves. Prints one JSON line per run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { heapStats } from "bun:jsc";
import { Database } from "bun:sqlite";

const state = process.env.LLV_STATE_DIR!, root = process.env.PROBE_ROOT!, install = process.env.PROBE_INSTALL!;
const [name = "", runsText = "6"] = process.argv.slice(2);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const io = () => Object.fromEntries(fs.readFileSync("/proc/self/io", "utf8").trim().split("\n").map(line => { const [k, v] = line.split(":"); return [k, Number(v)]; }));
const journalFile = () => path.join(state, `runtime-events-${install}.sqlite`);
const summaryBody = () => {
  const bytes = fs.readFileSync(path.join(state, "board-summary-bootstrap.bin"));
  const head = bytes.readUInt32BE(0), manifest = JSON.parse(bytes.subarray(4, 4 + head).toString());
  return bytes.subarray(4 + head, 4 + head + manifest.bodyBytes).toString();
};
function rawCost(ms: number) { const end = performance.now() + ms; let v = 0; while (performance.now() < end) v += Math.sqrt(v + 1) % 123; return v; }
async function openJournal() {
  const { RuntimeJournal } = await import("./src/runtime-host/journal");
  const journal = await RuntimeJournal.open(journalFile());
  const started = performance.now();
  while (!(journal as any).sessionHostMetadata.ready && performance.now() - started < 30_000) await pause(100);
  return journal;
}
/* The project with the most active rules among the projects of hot pipelines, and its largest scope. */
async function roleTarget() {
  const { projectView } = await import("@/lib/memory/roleStore");
  const { loadPipelinesForList } = await import("@/lib/pipelines/store");
  const projects = [...new Set(loadPipelinesForList().map(p => p.project).filter(Boolean))] as string[];
  const views = projects.map(project => projectView(project));
  const count = (v: (typeof views)[number]) => v.scopes.reduce((n, s) => n + s.active.length, 0);
  const view = views.sort((a, b) => count(b) - count(a))[0]!;
  const scope = [...view.scopes].sort((a, b) => b.active.length - a.active.length)[0]!;
  return { project: view.project, scopes: view.scopes.map(s => s.scope), scope: scope.scope, rules: count(view), scopeRules: scope.active.length };
}

type Case = { run: (index: number) => unknown; reset?: () => unknown | Promise<unknown>; readiness?: unknown; cleanup?: () => void };
const cases: Record<string, () => Promise<Case>> = {
  // D. whole-collection readers and writers
  D1: async () => { const t = await import("@/lib/tasks/store"); return { run: () => t.loadTasks().length }; },
  "D1-write": async () => { const t = await import("@/lib/tasks/store"); return { run: () => t.mutateTasks(() => ({ tasks: undefined, result: 0 })) }; },
  D2: async () => { const p = await import("@/lib/pipelines/store"); return { run: () => p.loadArchivedPipelines().length }; },
  D3: async () => { const p = await import("@/lib/pipelines/store"); return { run: () => p.loadPipelines().length }; },
  "T4-pair": async () => { const p = await import("@/lib/pipelines/store"); return { run: () => p.loadPipelines().length + p.loadPipelines().length }; },
  P2: async () => {
    const p = await import("@/lib/pipelines/store"); const db = new Database(path.join(state, "state.sqlite"), { readonly: true });
    const id = db.query<{ row_key: string }, []>("SELECT row_key FROM state_rows WHERE collection = 'pipelines' ORDER BY length(value_json) DESC LIMIT 1").get()!.row_key; db.close();
    return { run: () => JSON.stringify(p.findPipelineRecord(id)).length };
  },
  D4: async () => { const r = await import("@/lib/agent/registry"); return { run: () => Object.keys(r.agentRegistry().readOnlySnapshot().entries).length }; },
  "D4-incremental": async () => {
    const r = await import("@/lib/agent/registry"); r.agentRegistry().readOnlySnapshot();
    const write = async () => { const child = Bun.spawn([process.execPath, import.meta.path, "registry-write"], { env: process.env, stdout: "ignore", stderr: "inherit" }); if (await child.exited) throw Error("scratch registry write failed"); };
    return { reset: write, run: () => Object.keys(r.agentRegistry().readOnlySnapshot().entries).length, readiness: { condition: "one unchanged entry upserted by a child process before each run" } };
  },
  "registry-write": async () => { const r = await import("@/lib/agent/registry"); const e = Object.values(r.agentRegistry().readOnlySnapshot().entries)[0] as any; const { updatedAt, ...input } = e; r.agentRegistry().upsert(input); process.exit(0); },
  D8: async () => { const j = await import("@/lib/lifecycle/journal"); return { run: () => j.readLifecycleJournal().events.length }; },
  // T, H. timers and request handlers
  T2: async () => { const s = await import("@/lib/tempSweep"); return { run: () => { const r = s.scanProcesses(); return { processes: r.processes.length, paths: r.processes.reduce((n, p) => n + p.paths.length, 0) }; } }; },
  H3: async () => {
    const d = await import("@/lib/state/diskPressure"); const s = await import("@/lib/tempSweep");
    const report = JSON.parse(fs.readFileSync(path.join(state, "worktree-sweep-report.json"), "utf8"));
    const roots = [...new Set(report.kept.map((r: { path: string }) => r.path))] as string[];
    return { readiness: { worktreeRoots: roots.length }, run: () => ({ processes: s.scanProcesses().processes.length, volumes: d.diskVolumes(roots.map(directory => ({ role: "worktrees", directory })) as any).length }) };
  },
  T3: async () => { const p = await import("@/lib/pipelines/store"); return { run: () => p.archiveSettledPipelines(), readiness: { condition: "mutates the copy: run 0 archives what is due" } }; },
  "T6-evict": async () => {
    const p = await import("@/lib/pipelines/store"); const sequence = "L,L,A,A,L,A,L,A,L,A,L,A".split(",");
    const slots = () => { const m = (globalThis as any).__llvCollectionReadCachesV1 as Map<string, { bytes: number }> | undefined; return m ? [...m.entries()].map(([k, v]) => `${JSON.parse(k)[2]}:${(v.bytes / 1048576).toFixed(1)}MiB`).join(",") : "none"; };
    return { run: index => ({ read: sequence[index % sequence.length], rows: (sequence[index % sequence.length] === "L" ? p.loadPipelinesForList() : p.loadArchivedPipelines()).length, slots: slots() }) };
  },
  T7: async () => { const body = summaryBody(); return { readiness: { bodyBytes: body.length }, run: () => Object.keys(JSON.parse(body)).length }; },
  "H2-encode": async () => { const body = JSON.parse(summaryBody()); return { run: () => JSON.stringify(body).length }; },
  S6: async () => { const text = fs.readFileSync(path.join(state, "project-catalog.json"), "utf8"); return { readiness: { bytes: text.length }, run: () => Object.keys(JSON.parse(text).files).length }; },
  "T9-liveness": async () => {
    const l = await import("@/lib/lifecycle/liveness"); const reg = await import("@/lib/agent/registry");
    const catalogue = JSON.parse(fs.readFileSync(path.join(state, "project-catalog.json"), "utf8")).files;
    const seats = JSON.parse(fs.readFileSync(path.join(state, "orchestrator-seats.json"), "utf8")).seats;
    const seat = (Object.values(seats) as any[]).find(s => s.conversationId && s.state === "active");
    const id = seat?.conversationId ?? (Object.values(reg.agentRegistry().readOnlySnapshot().entries) as any[]).find(e => e.conversationId && ["live", "idle"].includes(e.status))?.conversationId;
    if (!id) throw Error("no liveness target");
    const sources = l.productionLivenessSources() as any;
    sources.describeTranscript = async (p: string) => catalogue[p] ? { ...catalogue[p], path: p } : null;
    sources.transcriptEvidence = async () => null; sources.transcriptIdentity = async () => null; sources.readHostTurnRecord = () => null;
    return { readiness: { target: seat ? "first active seat" : "first live entry", condition: "transcript evidence and host turn reads suppressed" },
      run: async () => { const r = await l.agentLivenessSnapshot({ conversationId: id, limit: 1, answerBudgetMs: 5000 } as any, sources); return { count: r.count }; } };
  },
  T19: async () => {
    const dir = process.env.PROBE_RELEASE!; // a verbatim copy of bytesOf, src/lib/selfUpdate/retention.ts:32
    return { run: () => { let bytes = 0, count = 0; const pending = [dir], device = fs.lstatSync(dir).dev;
      while (pending.length && count++ < 200_000) { const file = pending.pop()!, s = fs.lstatSync(file); if (s.dev !== device) continue;
        if (s.isDirectory()) pending.push(...fs.readdirSync(file).map(n => path.join(file, n))); if (s.isDirectory() || s.nlink === 1) bytes += s.blocks * 512; }
      return { bytes, entries: count }; } };
  },
  "T22-trim": async () => {
    const p = await import("@/lib/loopProfiler"); const line = fs.readFileSync(import.meta.path, "utf8").split("\n").findIndex(l => l.startsWith("function rawCost")) + 1;
    const frame = { name: "rawCost", sourceURL: import.meta.path, line }; const raw = { traces: Array.from({ length: 4096 }, () => ({ frames: Array(32).fill(frame) })) };
    return { readiness: { traces: 4096, depth: 32 }, run: () => p.trimLoopProfile(raw as any, path.dirname(import.meta.path)).rows.length };
  },
  // D6, H8. role memory (curation overview, one scope read, the rules window view)
  "D6-overview": async () => { const c = await import("@/lib/memory/curation/read"); const t = await roleTarget(); return { readiness: { rules: t.rules, scopes: t.scopes.length }, run: async () => (await c.readCuration({ id: "audit-local", project: t.project, scopes: t.scopes } as any)).scopes.length }; },
  "D6-scope-read": async () => { const c = await import("@/lib/memory/curation/read"); const t = await roleTarget(); return { readiness: { rules: t.rules, scopeRules: t.scopeRules }, run: async () => ((await c.readCuration({ id: "audit-local", project: t.project, scopes: t.scopes } as any, t.scope)) as any).rules.length }; },
  "role-projects": async () => {   // one line per hot-pipeline project, no keys: the spread of projectView cost
    const r = await import("@/lib/memory/roleStore"); const { loadPipelinesForList } = await import("@/lib/pipelines/store");
    const db = new Database(path.join(state, "state.sqlite"), { readonly: true });
    const passes = new Map(db.query<{ value_json: string }, []>("SELECT value_json FROM state_rows WHERE collection = 'role_memory_curation' AND row_key LIKE 'p:%'").all().map(row => { const v = JSON.parse(row.value_json); return [v.project, v.passes.length]; })); db.close();
    const { canonicalProject } = await import("@/lib/projects/aliases");
    const projects = [...new Set(loadPipelinesForList().map(p => p.project).filter(Boolean).map(p => canonicalProject(p)))] as string[];
    return { run: index => { const project = projects[index % projects.length]!; const started = performance.now(); const v = r.projectView(project);
      return { project: index % projects.length, ms: Math.round(performance.now() - started), rules: v.scopes.reduce((n, s) => n + s.active.length, 0), scopes: v.scopes.length, retainedPasses: passes.get(project) ?? 0 }; } };
  },
  H8: async () => { const r = await import("@/lib/memory/roleStore"); const t = await roleTarget(); return { readiness: { rules: t.rules, scopes: t.scopes.length }, run: () => r.projectView(t.project).scopes.length }; },
  // H1. MCP caller enumeration; run with NODE_ENV=test so the bindings' inbox resolves to a throw-away directory
  "H1-attrib": async () => {
    const { agentRegistry } = await import("@/lib/agent/registry"); const { hostedConversationsFromSnapshot } = await import("@/lib/mcp/bindings");
    const { procBackend } = await import("@/lib/proc"); const { systemBootEpoch } = await import("@/lib/processIdentity");
    const probe = { pidAlive: (pid: number) => procBackend.pidAlive(pid) && !procBackend.processExited(pid), processIdentity: (pid: number) => procBackend.processIdentity(pid), bootEpoch: systemBootEpoch };
    agentRegistry().readOnlySnapshot();
    return { run: () => hostedConversationsFromSnapshot(agentRegistry().readOnlySnapshot(), probe).length, readiness: { condition: "registry snapshot filled before run 0" } };
  },
  // S2, A1, A2. transcript inputs chosen by prepare.sh
  S2: async () => {
    const s = await import("@/lib/search/transcriptSearch"); const sources = JSON.parse(fs.readFileSync(path.join(root, "transcripts.json"), "utf8")); let round = 0;
    return { readiness: { sources: sources.length, bytes: sources.reduce((n: number, x: any) => n + x.size, 0) },
      run: async () => { round++; const r = await s.indexTranscriptSources(sources.map((x: any) => ({ ...x, mtimeMs: x.mtimeMs + round }))); return { filesRead: r.filesRead, messagesIndexed: r.messagesIndexed }; } };
  },
  ...Object.fromEntries((["A1", "A2"] as const).map(id => [id, async (): Promise<Case> => {
    const sources = JSON.parse(fs.readFileSync(path.join(root, "transcripts.json"), "utf8")) as { engine: string; path: string }[];
    const lines = sources.filter(x => x.engine === (id === "A1" ? "claude" : "codex")).flatMap(x => fs.readFileSync(x.path, "utf8").split("\n").filter(Boolean));
    return { readiness: { bytes: lines.reduce((n, l) => n + Buffer.byteLength(l), 0), lines: lines.length, condition: "transcript lines stand in for stdout frames" },
      run: () => { let n = 0; for (const l of lines) { try { JSON.parse(l); n++; } catch {} } return n; } };
  }])),
  // H10, X5. request-path filesystem work found by the route screen
  "H10-write": async () => { const data = Buffer.alloc(16 * 1024 * 1024, 1); const file = path.join(os.tmpdir(), `probe-dictation-${process.pid}.webm`);
    return { readiness: { bytes: data.length, condition: "the 16 MiB upload cap of src/app/api/transcribe/route.ts:21, written and removed" }, run: () => { fs.writeFileSync(file, data); fs.rmSync(file); return data.length; } }; },
  "X5-codex-walk": async () => {
    const root = process.env.PROBE_CODEX_SESSIONS!; // a verbatim copy of recentCodexSessionPaths, src/lib/agent/spawnedTranscript.ts:44-70
    return { run: () => { const minMtime = Date.now() - 60_000; let files = 0, recent = 0;
      const walk = (dir: string, depth: number) => { if (depth > 6) return; let entries: fs.Dirent[]; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) { const pathname = path.join(dir, entry.name); if (entry.isDirectory()) { walk(pathname, depth + 1); continue; }
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue; files++; try { if (fs.statSync(pathname).mtimeMs >= minMtime) recent++; } catch {} } };
      walk(root, 0); return { files, recent }; } };
  },
  // P3, X. synchronous child processes
  "X1-version": async () => { const c = await import("@/lib/accounts/codexPinnedProtocol"); return { run: () => c.installedCodexVersion(process.env.PROBE_CODEX!, process.env) }; },
  "X1-features": async () => { const c = await import("@/lib/agent/codexSpawnPolicy"); return { run: () => c.readCodexFeatures(process.env.PROBE_CODEX!, process.env).length }; },
  X2: async () => { const { execFileSync } = await import("node:child_process"); return { run: () => execFileSync("systemctl", ["--user", "show", "-p", "ControlGroup", "--value", "delegatus-agents.slice"], { encoding: "utf8", timeout: 5000 }).trim().length }; },
  // R. runtime host, on the copied journal
  ...Object.fromEntries((["R1-full", "R1-summary", "R1-cache"] as const).map(id => [id, async (): Promise<Case> => {
    const journal = await openJournal();
    return { readiness: { forced: id !== "R1-cache" }, cleanup: () => journal.close(), reset: () => { if (id !== "R1-cache") (journal as any).snapshotCaches.clear(); },
      run: () => journal.snapshotJson(id === "R1-summary" ? [] : undefined).length };
  }])),
  "R2-maintenance": async () => {
    const journal = await openJournal(); const { registryConversationRetentionStates } = await import("./src/runtime-host/journalRetention"); const r = await import("@/lib/agent/registry");
    return { cleanup: () => journal.close(), run: () => journal.settleStalePendingEffects(registryConversationRetentionStates(r.agentRegistry().readOnlySnapshot())), readiness: { condition: "the tick body of src/runtime-host/main.ts:332-343; run 0 includes the cold registry load" } };
  },
  "R2-map": async () => {
    const { registryConversationRetentionStates } = await import("./src/runtime-host/journalRetention"); const r = await import("@/lib/agent/registry"); const snapshot = r.agentRegistry().readOnlySnapshot();
    return { readiness: { condition: "registry snapshot built before run 0" }, run: () => registryConversationRetentionStates(snapshot).size };
  },
  "R2-settle": async () => {
    const journal = await openJournal(); const { registryConversationRetentionStates } = await import("./src/runtime-host/journalRetention"); const r = await import("@/lib/agent/registry");
    const states = registryConversationRetentionStates(r.agentRegistry().readOnlySnapshot());
    return { cleanup: () => journal.close(), readiness: { stateMapSize: states.size }, run: () => journal.settleStalePendingEffects(states) };
  },
  R3: async () => { const journal = await openJournal(); return { cleanup: () => journal.close(), run: () => journal.maintainProducerReceipts(), readiness: { condition: "mutates the copy: each run removes the page it finds" } }; },
  R4: async () => { const db = new Database(journalFile(), { readonly: true }); return { cleanup: () => db.close(), run: () => ({ freelist: db.query("PRAGMA freelist_count").get() }) }; },
};

const factory = cases[name];
if (!factory) { console.error(`unknown case ${name}; cases: ${Object.keys(cases).join(" ")}`); process.exit(2); }
const probe = await factory();
let last = performance.now(), maxGap = 0;
const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last - 10); last = now; }, 10);
console.log(JSON.stringify({ event: "start", name, utc: new Date().toISOString(), readiness: probe.readiness ?? null, load: os.loadavg(), bun: Bun.version }));
for (let index = 0; index < Number(runsText); index++) {
  await probe.reset?.();
  await pause(300); maxGap = 0; last = performance.now();
  const heap = heapStats().heapSize, rss = process.memoryUsage().rss, cpu = process.cpuUsage(), before = io(), started = performance.now();
  let result: unknown;
  try { result = await probe.run(index); } catch (error) { console.log(JSON.stringify({ event: "failure", name, index, error: (error as Error).message })); process.exitCode = 1; break; }
  const wallMs = performance.now() - started, used = process.cpuUsage(cpu), after = io();
  const heapDeltaBytes = heapStats().heapSize - heap, rssDeltaBytes = process.memoryUsage().rss - rss;
  await pause(80);
  console.log(JSON.stringify({ name, index, utc: new Date().toISOString(), wallMs, cpuMs: (used.user + used.system) / 1000, maxLoopGapMs: maxGap,
    heapDeltaBytes, rssDeltaBytes, rchar: after.rchar - before.rchar, result: typeof result === "string" ? { chars: result.length } : result ?? null, load: os.loadavg() }));
}
clearInterval(timer); probe.cleanup?.();
console.log(JSON.stringify({ event: "end", name, utc: new Date().toISOString() }));
process.exit(process.exitCode ?? 0);
```

`run-probes.sh`:

```sh
#!/usr/bin/env bash
# Usage: P=<stage scratch dir> REV=<serving revision> INSTALL=<install id> PORT=<closed port> bash run-probes.sh
set -euo pipefail
: "${P:?}" "${REV:?}" "${INSTALL:?}" "${PORT:?}"
# X5 input: the Codex sessions directory holding the most rollouts (read-only: readdir and stat)
CODEX_SESSIONS=$(for d in "$HOME"/.config/delegatus/accounts/codex/*/sessions; do printf '%s\t%s\n' "$(find "$d" -name '*.jsonl' | wc -l)" "$d"; done | sort -rn | head -1 | cut -f2)
REL="$HOME/.cache/delegatus/self-update/$INSTALL/releases/${REV:0:12}"
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then echo "port $PORT is open; choose a closed one" >&2; exit 1; fi
mkdir -p "$P/out"
run() { # run <export dir> <NODE_ENV> <case> <runs>
  ( cd "$1" && env HOME="$P/home" XDG_CONFIG_HOME="$P/xdg" XDG_CACHE_HOME="$P/cache" CODEX_HOME="$P/home/.codex" TMPDIR="$P/run-tmp" \
      LLV_STATE_DIR="$P/state" LLV_VIEWER_CONTROL_URL="http://127.0.0.1:$PORT/" LLV_TEMP_SWEEP=dry-run LLV_WORKTREE_SWEEP=dry-run \
      PROBE_ROOT="$P" PROBE_INSTALL="$INSTALL" PROBE_RELEASE="$REL" PROBE_CODEX="$(command -v codex)" PROBE_CODEX_SESSIONS="$CODEX_SESSIONS" NODE_ENV="$2" \
      bun ./probe.ts "$3" "$4" ) > "$P/out/$3${5:-}.ndjson" 2> "$P/out/$3${5:-}.stderr" || echo "case failed: $3${5:-}"
}
# Read-only cases first, each in a fresh process; the cases that write to the copy come last.
for c in D1 D2 D3 T4-pair P2 D4 D8 T2 H3 T7 H2-encode S6 T9-liveness T19 T22-trim D6-overview D6-scope-read H8 H10-write X5-codex-walk \
         A1 A2 X1-version X1-features X2 R1-full R1-summary R1-cache R2-maintenance R2-map R2-settle R4; do
  run "$P/export" production "$c" 6
done
run "$P/export" test H1-attrib 6
run "$P/export" production role-projects 10
run "$P/export" production T6-evict 12 -256
run "$P/export512" production T6-evict 12 -512
for c in D1-write S2 D4-incremental T3 R3; do run "$P/export" production "$c" 6; done
```

`summarize.py`:

```py
# python3 -I summarize.py <out dir>: one line per case; run 0 apart from runs 1..n
import json, pathlib, statistics, sys
def fmt(xs): return f"{statistics.median(xs):.1f} [{min(xs):.1f}-{max(xs):.1f}]" if xs else "-"
for f in sorted(pathlib.Path(sys.argv[1]).glob("*.ndjson")):
    rows = [json.loads(l) for l in f.read_text().splitlines() if l.strip()]
    start = next((r for r in rows if r.get("event") == "start"), {}); runs = [r for r in rows if "index" in r and "wallMs" in r]
    fail = [r for r in rows if r.get("event") == "failure"]
    if not runs: print(f.stem, "NO RUNS", fail); continue
    warm = runs[1:]; loads = [r["load"][0] for r in runs]
    print(f"{f.stem}: first wall {runs[0]['wallMs']:.1f} loop {runs[0]['maxLoopGapMs']:.1f} | warm wall {fmt([r['wallMs'] for r in warm])} loop {fmt([r['maxLoopGapMs'] for r in warm])}"
          f" | heap+ {max(r['heapDeltaBytes'] for r in runs)/1e6:.0f} MB | result {json.dumps(runs[-1]['result'])[:80]} | ready {json.dumps(start.get('readiness'))[:120]} | load {min(loads):.1f}-{max(loads):.1f} | {start.get('utc','')[11:19]}")
```

Each run prints wall time, CPU time, the largest lateness of a 10 ms timer
around the call ("loop"), heap and RSS deltas, bytes read and `/proc/loadavg`.
Run 0 of a fresh process is the cold call (it includes module loading, cache
fills and, for the registry, the full decode); runs 1-5 are warm. A call shorter
than the 10 ms tick can show a loop value below its wall time; one that leaves
garbage collection behind it can show a loop value above it. The whole run takes
about four minutes. Five cases change the copy, so they run last and the
procedure is repeated only from a fresh `prepare.sh`.

| Case | Inventory | One run executes | Input or target | Before each run | Writes to the copy |
| --- | --- | --- | --- | --- | --- |
| `D1` | D1, H5, H9 | `loadTasks()` | every task | — | no |
| `D1-write` | D1 | a no-op `mutateTasks` (`BEGIN IMMEDIATE`, snapshot, diff) | tasks | — | an empty transaction |
| `D2` | D2, T6 | `loadArchivedPipelines()` | the archive | — | no |
| `D3` | D3, P6 | `loadPipelines()` | hot pipelines | — | no |
| `T4-pair` | T4 | two `loadPipelines()` | hot pipelines | — | no |
| `P2` | P2 | `findPipelineRecord` and `JSON.stringify` | the largest hot row (SQL in the case) | — | no |
| `D4` | D4, R2 | `readOnlySnapshot()` | the registry | — (run 0 is the cold full load) | no |
| `D4-incremental` | D4 | `readOnlySnapshot()` | the registry | a child process upserts one unchanged entry | the registry copy |
| `D8` | D8 | `readLifecycleJournal()` | the lifecycle journal | — | no |
| `T2` | T2, H3, T19 | `scanProcesses()` | the machine's `/proc`, read only | — | no |
| `H3` | H3 | `scanProcesses()` and `diskVolumes` | the worktree roots of the sweep report (`stat`, `statfs` only) | — | no |
| `T3` | T3 | `archiveSettledPipelines()` | state | — | run 0 archives what is due |
| `T6-evict` | T6, D2 | hot list and archive reads in the order L, L, A, A, L, A, L, A, L, A, L, A; prints the cache slots | state; `export512` differs only in `MAX_BYTES` | — | no |
| `T7` / `H2-encode` | T7, H4 / H2 | `JSON.parse` of the board summary body / `JSON.stringify` of it | the bootstrap copy | — | no |
| `S6` | S6 | `JSON.parse` of the project catalog | the catalog copy | — | no |
| `T9-liveness` | T9 | `agentLivenessSnapshot` for one conversation | the first active seat; transcript evidence and host turn reads stubbed | — | no |
| `T19` | T19 | a verbatim copy of `bytesOf` | the serving release directory, read only | — | no |
| `T22-trim` | T22 | `trimLoopProfile` at the caps, 4,096 traces × 32 frames | synthetic frames | — | no |
| `D6-overview` / `D6-scope-read` / `H8` | D6, H8, curator calls | `readCuration` without a scope / of the largest scope / `projectView` | the hot-pipeline project with the most active rules (`roleTarget`) | — | no |
| `role-projects` | H8, D6 | `projectView` of each hot-pipeline project in turn | 5 projects, twice | — | no |
| `H1-attrib` | H1 | `hostedConversationsFromSnapshot` with the production process probe | the registry copy and the real `/proc`; `NODE_ENV=test` | — | no |
| `H10-write` | H10 | write and remove a 16 MiB file | the stage temp directory | — | a temporary file |
| `X5-codex-walk` | H11 | a verbatim copy of the Codex session walk | the account sessions directory with the most rollouts, read only | — | no |
| `A1`, `A2` | A1, A2 | `JSON.parse` of every line | the transcripts `prepare.sh` copied | — | no |
| `S2` | S2 | `indexTranscriptSources` | the same transcripts, modification time bumped per run | — | the transcript index |
| `X1-version`, `X1-features`, `X2` | P3, X1, X2 | `codex --version`, `codex features list`, `systemctl --user show` | the installed binary, isolated HOME; the user manager, read only | — | no |
| `R1-full`, `R1-summary`, `R1-cache` | R1 | `snapshotJson()` full, summary, cached | the runtime journal copy | snapshot cache cleared (full, summary) | no |
| `R2-maintenance` | R2 | the minute tick body of `src/runtime-host/main.ts:332-343` | registry and journal copies | — (run 0 includes the cold registry load) | settles stale effects (none here) |
| `R2-map`, `R2-settle` | R2 | the retention map alone; settlement with a built map | as above | — | as above |
| `R3` | R3 | `maintainProducerReceipts()` | the journal copy | — | removes the page it finds |
| `R4` | R4 | the freelist pragmas | the journal copy | — | no |

T1 keeps its own retained driver: `SWEEP_FIXTURE=<scratch dir> bun
scripts/measure-worktree-sweep.ts` at `a25592be` (three runs over a synthetic
fixture of 930 trees; `--in-process` replays the pre-worker sweep).

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
| T6 | M1b re-arm chains; M3 frames in `done/`; M2 `pipeline.copy`; M4 `T6-evict`, `D2` | block per minute |
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
| D4, R2 | M1b phase chains; M2 `registry.snapshot` slices; M4 `D4`, `D4-incremental`, `R2-*` | refresh and full-load time |
| D5 | synchronous `[blocking-wait]` `registry-*` per hour (M2); M1 overlap | wait time |
| D6, H1 | M1b curator passes and receipts; M3 frames in `src/lib/mcp/`, `src/lib/memory/curation/`; M4 `D6-*`, `H8`, `role-projects`, `H1-attrib` | gap share during passes; occupancy by replay |
| D8 | M4 parse of the copied journal | parse time |
| H2-H12 | M2 on `files.*`; M4 per handler (`H3`, `H8`, `H2-encode`, `H10-write`, `X5-codex-walk`, `D1`, `D3`); M7; the [route and tool screen](#route-and-tool-screen) | cost per request and per hour |
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
the same isolation and gate; its revision replaced those probes with the M4
procedure and reran every case (see [Unit costs](#unit-costs-on-copied-state)). A state copy (`VACUUM INTO` at 14:59:24Z) for a cache-eviction probe at 14:59:46-15:00:57Z,
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
| Minute maintenance | runtime host | On `9c889c07`, all 41 host gaps after boot (13:19:54-13:59:54Z) end at second 54.06-54.89 of their minute, 771-1,578 ms. On `a25592be`, 15 of 15 minutes from 15:04:25 to 15:18:25Z end at second 25.5-26.2, 915-1,514 ms; every one carries a `registry.snapshot` sync span (108-456 ms) and 14 of them a `registry.headers` span (60-112 ms). Over 48 hours the host logged 3,076 gaps above 500 ms in 2,880 minutes, median spacing 59.985 s (p10/p90 58.731/60.316 s); 2,880 of those gaps (2,995.4 of 3,128.2 s) sit on fixed 60 s phase chains of at least five ([M1b](#m1b-timer-chains-curator-passes-and-profile-windows)) | R2 (rank 1) |
| Done-sweep minute chain | Viewer | On `a25592be` (Viewer process started 15:03:24.230Z by `/proc`), 17 gaps from 15:03:50.090 to 15:20:09.513Z, 791-1,368 ms each (median 943 ms) except 2,540 ms (15:15:01.538) and 3,541 ms (15:19:08.115, whose profile window also holds role-memory frames). Each gap ends 60 s plus its own duration after the previous one, within 0.14 s for 14 of 16 links (0.38 s and 0.32 s for two): a timer re-armed 60 s after its pass ends, whose pass is the gap. The first pass started about 25 s after the process, which fits the done sweep's 15 s first delay if the controllers started about 10 s after the process (the attention reconcile, the other 60 s re-armed timer, waits 30 s). The largest retained sync slices are `pipeline.copy`, `state.write-wait` and `state.checkpoint`, each at most 25 ms, consistent with per-record clones of a whole-collection snapshot. On `9c889c07` the same chain ran from 13:19:16 to at least 13:29:36Z: seven passes of 1.98-2.49 s, each with an RSS step of +0.6 to +1.3 GiB, then 0.73-0.98 s per pass; its links fit 60 s plus the gap within 0.01-0.85 s, the pass spending part of its time in awaits outside the gap. 2 of the 6 captured profiles in it hold the done and album frames (`projectDoneItems` `done/project.ts:56`, `runDoneSweepOnce` `done/sweep.ts:29`, `lookupDoneFrame`, `readTaskAlbum` `taskAlbum/album.ts:143`; 203-227 samples). Over the 48 hours, re-arm chains of at least five (M1b) hold 626 gaps / 533.6 s at ±0.15 s and 1,086 gaps / 1,038.6 s at ±0.25 s, 1.1-2.2 % of the Viewer's logged gap time: the chain is not present every hour | T6 with the archive cache (rank 3) |
| Curator passes | Viewer | Two passes on `a25592be` (M1b): 15:19:02-15:22:36Z, 26 `curate_rules` calls of at least 2 s with `bindingMs` 3,032-4,098, and 15:34-15:38Z, 27 calls. The Viewer spent 73.0 % and 53.6 % of each pass's wall time in logged gaps (24 gaps of at least 2 s in each), against 7.7 % and 20.3 % in the same length before and 11.8 % and 10.3 % after. Completion lines follow the end of the preceding logged gap by 1.0-3.6 s, so they mark no gap's end, and `bindingMs` is wall time across awaits (`src/lib/mcp/server.ts:3268-3332`; the binding awaits curator admission at `src/lib/mcp/bindings.ts:7922` and, for a scope read, the history projection at `src/lib/memory/curation/read.ts:18`), so neither measures loop occupancy. Of the first pass's 25 captured profile windows, 9 hold the role-memory and curation chunk (`36787.js`) above 20 % of samples and 6 the attribution frames (`25514.js:34 cF`/`cE`) above 5 %; the windows are 1.4-2.6 times as long as their gaps, so those samples are not placed inside the gaps. Production occupancy is unmeasured; the replay estimates it: each read runs `projectView` once, 0.31-3.73 s on the copy by the project's retained curator passes (`role-projects`); the first pass curated the project with 23 retained passes (1.30-2.04 s per view), the second the one with 12 (0.75-0.79 s). Over 48 hours `curate_rules` logged 589 calls of at least 2 s and 2,872.7 s of binding wall time, largest 18.2 s | curator calls through D6, H8 (rank 2) |
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

Part 3's revision reran every case from the procedure in
[M4](#m4-replays-on-scratch-copies) on fresh copies (16:09:06-16:09:10Z,
export `a25592be`, Bun 1.4.0, the supplied gate, 16:09:10-16:13:26Z, load
4.7-6.9, fleet 9 live / 4 running). "First" is run 0 of a fresh process (cold);
"warm" is the median and range of runs 1-5; "loop" is the largest lateness of a
10 ms timer around the call. The part 2 column is the warm value part 2 reported
from its scratch probes on `9c889c07` copies of 14:00Z.

| Case (inventory IDs) | First wall / loop, ms | Warm wall, ms | Warm loop, ms | Part 2 warm, ms | Notes |
| --- | --- | --- | --- | --- | --- |
| `R2-maintenance` (R2) | 1,252 / 1,285 | 715.7 [672.8-732.7] | 784.7 [760.0-809.7] | 763.9 [726.3-869.6] | registry 7,137 entries; 3 pending effects, none settled |
| `R2-map` (R2) | 691.6 / 726.5 | 686.6 [664.2-734.4] | 764.0 [739.2-809.6] | 846.1 [788.4-893.7] | the retention map is the tick's cost; 8,355 states, +111 MB heap |
| `R2-settle` (R2) | 1.2 / 59.2 | 0.9 [0.7-1.2] | 55.8 [47.3-88.7] | 0.40 [0.37-0.44] | settling with a built map; the loop value is collection after the map build |
| `D6-scope-read` (D6, curator calls) | 3,691 / 3,691 | 3,744 [3,628-3,882] | 3,796 [3,680-3,928] | — | the largest scope (42 rules) of the project with the most active rules, 49 retained curator passes |
| `D6-overview` (D6) | 3,783 / 3,831 | 4,035 [3,672-4,209] | 4,080 [3,727-4,271] | 228.1 [219.1-238.3] | same project; part 2 timed a project key with no retained pass (see below) |
| `H8` (H8) | 3,423 / 3,470 | 3,604 [3,456-3,750] | 3,651 [3,492-3,813] | — | `projectView` alone, same project |
| `role-projects` (H8, D6) | — | 310-438 (3 passes), 745-793 (12), 1,003-1,071 (16), 1,304-2,043 (23), 3,480-3,726 (49) | +30 to +50 above wall | — | two runs per hot-pipeline project; cost grows with retained curator passes |
| `T6-evict` at 256 MiB (T6, D2) | 125.7 / 120.7 | archive after a hot read 541.5-617.0; hot after an archive read 89.9-100.6 | 568-631; 99-120 | 591-937; 96-215 | each fill evicts the other slot: hot 64.4 MiB, archive 214.9 MiB |
| `T6-evict` at 512 MiB | 140.2 / 137.6 | archive 201.0-244.2 (first fill 783.3); hot 0.2-0.3 | 217-266; 11-19 | 244-311; 0.27-0.73 | both slots stay resident; the archive read still clones per record |
| `D2` (D2) | 893.9 / 902.2 | 229.7 [204.2-281.8] | 244.4 [221.3-300.6] | 197.8 [192.3-234.0] | 954 records, 112.8 MB of JSON |
| `D3` (D3, P6) / `T4-pair` (T4) | 313.5 / 316.9; 346.4 / 345.3 | 75.5 [52.3-88.1]; 113.6 [96.5-116.6] | 80.3 [54.4-89.5]; 112.2 [101.4-115.7] | 55.0 [53.0-56.8]; 98.7 [96.5-112.4] | 253 records, 33.6 MB |
| `D1` (D1, H5, H9) / `D1-write` (D1) | 142.6 / 140.4; 119.5 / 117.1 | 52.7 [48.4-106.3]; 20.4 [17.2-36.1] | 60.9 [53.1-128.4]; 19.8 [16.0-40.3] | 49.0 [45.4-50.6]; 18.4 [18.3-21.0] | 2,347 tasks; the no-op write logged a 104 ms transaction hold in run 0 |
| `P2` (P2) | 16.5 / 11.4 | 4.0 [3.7-6.2] | 0.1 [0.1-1.1] | 11.4 [3.5-13.3] | largest hot record, 514,685 characters; shorter than the 10 ms tick, so wall is the measure |
| `D4` (D4, R2) / `D4-incremental` | 570.0 / 573.8; 195.9 / 225.4 | 0.4 [0.4-0.5]; 3.8 [3.6-4.6] | 13.9 [12.1-17.8]; 23.6 [20.1-26.8] | cold 565-1,098; 0.41; 1.60-1.90 | cold full decode, cache hit, refresh after one write |
| `H1-attrib` (H1) | 542.7 / 634.9 | 51.9 [31.8-106.1] | 142.8 [102.8-280.2] | 39.4-100.9 | 8,281 conversations; the loop value includes the collection the enumeration leaves |
| `T7` (T7, H4) / `H2-encode` (H2) | 57.7 / 51.5; 110.1 / 108.1 | 46.7 [42.1-51.5]; 110.7 [107.7-118.1] | 43.2 [38.8-53.5]; 110.9 [106.4-117.7] | 56.6 [44.6-66.3]; 136.0 [103.1-148.7] | summary body 33.8 MB |
| `T2` (T2, H3, T19) / `H3` (H3) | 71.7 / 68.1; 88.2 / 85.0 | 71.3 [66.5-98.3]; 75.7 [70.7-97.4] | 70.5 [65.3-102.9]; 75.5 [65.7-95.5] | 65.8 [63.6-68.5]; 63.9 [59.6-77.8] | 336 processes, 44,037 path references; 929 worktree roots |
| `T19` (T19) | 123.8 / 118.1 | 122.1 [107.6-149.3] | 116.2 [101.5-146.4] | 92.2 [88.5-101.7] | one release, 48,809 entries |
| `R1-full` / `R1-summary` / `R1-cache` (R1) | 233.1 / 243.7; 344.8 / 354.7; 219.7 / 228.9 | 225.5 [208.1-236.6]; 304.8 [291.7-314.5]; 0.0 | 259.9 [233.2-278.0]; 349.7 [342.4-369.5]; 27.1 [22.0-34.2] | 211.9 [182.6-219.7]; 303.3 [268.3-314.7]; 0.02 | forced rebuilds log `snapshot-collect` waits of 262-315 ms |
| `T3` (T3) | 274.9 / 56.6 | 261.3 [218.3-380.5] | 30.5 [26.7-70.9] | 220.9 [217.9-245.5] | yields inside: loop lateness stays at 27-71 ms |
| `T9-liveness` (T9) | 60.8 / 62.5 | 14.0 [11.2-24.4] | 19.4 [14.1-31.3] | 11.6 [9.3-15.0] on `eb1535f0` | one conversation, transcript reads stubbed |
| `T22-trim` (T22) | 104.2 / 99.9 | 107.0 [97.5-117.1] | 101.7 [91.5-114.6] | 231.7 [228.7-237.6] on `9c889c07` | at the caps; real captures hold 246-1,504 samples |
| `R3` (R3) / `R4` (R4) | 39.1 / 34.5; 0.3 / 0.1 | 13.1 [4.0-17.9]; 0.0 | 6.1 [0.1-13.4]; 0.1 | 18.8 [4.1-26.3]; 0.009-0.045 | 3,687 receipts scanned per page, none due |
| `X1-version` / `X1-features` / `X2` (P3, X1, X2) | 34.7; 42.1; 4.4 | 34.3 [34.0-35.7]; 41.7 [39.0-42.7]; 4.0 [3.7-5.4] | 31.0; 33.1; 0.1 | 35.2; 41.6; — | per Codex host open; per launch admission |
| `A1` / `A2` (A1, A2) | 73.9; 9.0 | 65.8 [59.5-72.5]; 8.2 [7.4-9.5] | 62.6; 0.2 | 53.2; 9.3 | 83.6 MB of Claude and 7.8 MB of Codex transcript lines: 0.71-0.87 and 0.95-1.22 ms per MB |
| `S2` (S2) / `S6` (S6) / `D8` (D8) | 203.0; 20.2; 12.5 | 151.4 [134.0-187.5]; 17.8 [14.6-27.3]; 4.8 [4.1-8.5] | 2.7; 14.6; 1.5 | 130.7; —; — | five transcripts, 91.4 MB, the reindex yields; 9.5 MB catalog; 1.3 MB journal |
| `H10-write` (H10) / `X5-codex-walk` (H11) | 6.0; 5.0 | 6.8 [6.3-13.8]; 6.5 [4.2-7.0] | 0.1; 0.1 | — | 16 MiB to the stage temp directory; 1,671 rollouts |
| T1 sweep, 930 trees × 101 files, before → `98a23e4f` worker | — | largest loop interval 5,329.5-5,586.8 → 3.36-9.06 | — | same | part 2, `scripts/measure-worktree-sweep.ts`, three runs each |

A second run checked that the document alone suffices: the seven procedure
files were extracted from this document's text into an empty directory and the
M4 commands run as written, on copies made at 16:31:44Z (cases 16:31:48-16:35:56Z,
load 3.6-6.0). Every case completed and kept the shape above, for example
`R2-maintenance` 688.6-832.4 ms warm, `H8` 3,395-3,667 ms, `D6-scope-read`
3,495-3,585 ms, `role-projects` 321-369 ms at 3 passes and 3,517-3,593 ms at 49,
`T6-evict` at 256 MiB archive 581.8-643.1 ms and hot 86.7-101.2 ms against
200.0-274.8 ms and 0.3-0.4 ms at 512 MiB, `H1-attrib` 32.6-37.3 ms.

A third run repeated that from the final text, on export `72866c7d` (the
revision serving from 16:38:04Z), copies made at 16:44:10-16:44:14Z, cases
16:44:14-16:48:44Z, load 6.9-9.2, fleet 7 live / 1 running at 16:43:59Z. All 40
cases completed. Under the higher load the warm values ran up to about 30 %
above the 16:09Z run with the same shape: `R2-maintenance` 726.8-943.0 ms,
`R2-map` 707.1-977.9 ms, `H8` 3,782.6-3,970.4 ms, `D6-scope-read`
3,666.2-4,013.0 ms, `role-projects` 385-461 ms at 3 passes, 975-1,152 at 12,
1,298 at 16, 1,667-1,843 at 23 and 4,425-4,550 at 49, `T6-evict` at 256 MiB
archive 739.7-904.9 ms and hot 94.6-132.8 ms against 247.7-321.3 ms and
0.2-0.4 ms at 512 MiB, `H1-attrib` 32.8-46.8 ms; `profile-view.ts` found 3,400
of 3,582 samples under `curationView` and 3,386 under `readPass`. The journal
and receipt checks of [M1b](#m1b-timer-chains-curator-passes-and-profile-windows)
printed the same lines as above (the journal read returned 39,062 lines), except
the 48-hour receipt total, 8,884 after retention pruned `search_memory` to 245,
and the first version of the [route and tool screen](#route-and-tool-screen)
printed its totals unchanged before the revision extended it. The ranking
keeps the 16:09Z values.

Every warm range has the shape part 2 reported except two. The archive and hot
reads moved by up to a third (larger archive, other load). The role-memory
views did not reproduce part 2's 219-238 ms: part 2's probe passed a fixed
project key that holds no retained curator pass. The same key on these copies
answers in 163-173 ms with or without `project-aliases.json` (132 rules, 15
scopes, 0 passes), while the hot-pipeline projects hold 3-49 retained passes.
`profile-view.ts` (below, run like a case from the export at 16:23Z) samples
`projectView` for the 49-pass project every millisecond: of 3,865 samples, 3,693
sit under `curationView` (`src/lib/memory/curation/store.ts:227-235`), which
calls `readPass` for every retained pass (`:50-61`, 3,675 samples); each
`readPass` reads every scope row of the project through `curationScopes`
(`:95-112`, 2,975 samples in `keyRange`). The 102 scope rows hold 12.6 MB
because each carries its history. The view costs roughly 70 ms per retained
pass on top of about 165 ms, the cost of the key with no pass.

```ts
// bun ./profile-view.ts: 1 ms samples of projectView for the hot-pipeline project with the most retained curator passes
import path from "node:path";
import { profile } from "bun:jsc";
import { Database } from "bun:sqlite";
const r = await import("@/lib/memory/roleStore"); const { loadPipelinesForList } = await import("@/lib/pipelines/store"); const { canonicalProject } = await import("@/lib/projects/aliases");
const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), { readonly: true });
const passes = new Map(db.query<{ value_json: string }, []>("SELECT value_json FROM state_rows WHERE collection = 'role_memory_curation' AND row_key LIKE 'p:%'").all().map(row => { const v = JSON.parse(row.value_json); return [v.project, v.passes.length] as const; }));
const project = [...new Set(loadPipelinesForList().map(p => canonicalProject(p.project)))].sort((a, b) => (passes.get(b) ?? 0) - (passes.get(a) ?? 0))[0]!;
r.projectView(project);
const traces = (profile(() => r.projectView(project), 1000) as any).stackTraces.traces;
const totals = new Map<string, number>();
for (const t of traces) for (const key of new Set<string>(t.frames.filter((f: any) => f.sourceURL?.includes("/src/")).map((f: any) => `${path.relative(process.cwd(), f.sourceURL)}:${f.line} ${f.name}`))) totals.set(key, (totals.get(key) ?? 0) + 1);
console.log(JSON.stringify({ retainedPasses: passes.get(project), samples: traces.length, top: [...totals].sort((a, b) => b[1] - a[1]).slice(0, 8) }));
```

Cache eviction (`T6-evict`): one Bun process per budget reads the hot list
(`loadPipelinesForList()`) and the archive (`loadArchivedPipelines()`) twelve
times in the order L, L, A, A, then alternating, and prints the shared cache
slots (`globalThis.__llvCollectionReadCachesV1`) after each read; the 512 MiB
export changes only `MAX_BYTES` in `src/lib/state/collectionReadCache.ts:11`. At
256 MiB the slots hold only the collection read last: the hot slot is 64.4 MiB
and the archive 214.9 MiB in the cache's UTF-16 units, together above the
budget, so every archive fill evicts the hot rows and every hot fill evicts the
archive. The budget was sized when the archive was 147.5 MiB
(`docs/perf/viewer-heap-gc-fixes.md`).

MCP caller enumeration (`H1-attrib`): on the registry copy,
`hostedConversationsFromSnapshot` with the production process probe (`pidAlive`,
`processIdentity`, boot epoch) after the snapshot is filled. Production runs it
as the first statement of `attentionCallerAuthority`
(`src/lib/attention/callerAuthority.ts:75`, reached through
`attentionCallerSources` at `src/lib/mcp/bindings.ts:1241`) on every call that
resolves its caller. `attributionOf` has 40 call sites in `bindings.ts`:
`curate_rules` resolves twice per call (`:7921` in the binding, `:7937` in
`authorizeReceipt`), `stage_report` (`:2585`), `leave_lesson` (`:2601`) and
`search_memory` (`:7953`) once; `agent_activity` does not resolve its caller.
The MCP receipt copy of 16:09Z holds 8,920 receipts in the 48 hours:
`agent_activity` 5,229, `curate_rules` 981, `stage_report` 523, `update_task`
421, `leave_lesson` 333, `search_memory` 273, `pipeline_action` 208,
`bridge_report` 207.

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
- **A curator pass coincided with 3.6 minutes of near-continuous gaps**
  (15:18:59-15:22:36Z; the "Curator passes" row above). Its first long gap, 3,541 ms at
  15:19:08.115Z, is also a link of the done-sweep chain, and its profile
  window shows the curation frames:
  chunk `36787.js` of the deployed build, whose line 3 holds one `X(a, b =
  Date.now())` that begins with the scope join, the canonical project, the
  scope resolver and all rows, the shape of `projectView`
  (`src/lib/memory/roleStore.ts:499`), 276 samples; the same chunk's line 1
  frames `C`, `v` and `I` (495, 492 and 258 samples) are role-memory and
  curation functions whose names repeat on that line; the MCP bindings chunk
  frame `25514.js:1 m` holds 293. The profile window (7,605 ms, 746 samples)
  is more than twice the 3,541 ms gap, so these counts are window samples.
  Inventory row H8 records the path.
- The temp sweep (T2) wrote its completion line at 15:23:24.403Z (2
  directories removed, 2 errors); its start is not logged. Eleven Viewer gaps
  of 0.7-1.5 s ran from 15:08:35 to 15:09:01Z, about 5 minutes after the
  controllers started, with `memory.discovery`, `seat-tick.check` and
  `runtime.rpc` pending and no label for the sweep, so they cannot be assigned
  to it.

### Loop records silenced from 16:36:57Z (`72866c7d`)

Read at 16:45Z, after the apply of `72866c7d` (#3056) at 16:38:04.273Z:

- **No record since.** From 16:00:00Z the service journal holds 301
  `[viewer loop-gap]` lines (264 Viewer, 37 runtime host, all on `a25592be`)
  and 74 `[performance summary]` lines, the last at 16:36:57Z and 16:36:39Z,
  and none after. `[blocking-wait]`, `[mcp slow]`, `[auto merge]` and
  `[self-update]` lines continue (36, 2, 1,008 and 1 from 16:38:04Z to
  16:45Z). A second read at 16:55:19Z found still none among the 3,024 journal
  lines written since the apply.
- **Cause, from the code and `/proc`.** #3056 made the default loop sink drop
  every line while `LLV_QUIET_DIAGNOSTICS=1` (`src/lib/viewerLoopMonitor.ts:35-38`
  at `72866c7d`); the runtime host runs the same monitor
  (`src/runtime-host/main.ts:33-34`). The CLI sets that variable for every
  child unless `DELEGATUS_DEBUG=1` (`bin/cli.mjs:1124-1127` at `72866c7d`).
  This installation's service runs the CLI as its main process
  (`bin/cli.mjs --no-open --port …`), and the launcher, the Viewer and the
  runtime host each carry `LLV_QUIET_DIAGNOSTICS=1` (read from
  `/proc/<pid>/environ` for the named keys only); the launcher also carries
  systemd's `JOURNAL_STREAM` and `INVOCATION_ID`.
  `docs/verification/fresh-install-startup.md` at `72866c7d` classes both lines
  as debug output under the CLI and says direct service launches keep sending
  diagnostics to their journal; a service that starts the CLI falls outside
  that sentence.
- **Consequence.** Since 16:36:57Z neither process leaves a gap record,
  watchdog site, profile or performance summary on this installation. The
  monitor, and the profiler while armed (T22), still run; only their output is
  dropped. Every
  production measure of the [follow-up window](#follow-up-measured-window)
  reads these lines, so [L0c](#l0c-loop-records-reach-the-service-journal-again)
  must serve before that window starts.

## Ranked list

### Ordering rule

1. **Two lists.** A *measured cause* has a production observation that names
   it: profile frames inside the gap's window, gaps recurring on its exact
   schedule (the fixed phase or re-arm chains of [M1b](#m1b-timer-chains-curator-passes-and-profile-windows)),
   co-occurrence with its own calls, or a synchronous span or wait record at its
   site. A *suspect* has none. A fixed source awaiting production verification
   (T1) is listed apart.
2. **One unit.** Cost is main-loop occupancy in seconds per hour, averaged over
   the 48-hour window (2026-10-16 14:00Z to 2026-10-18 14:00Z). It comes, in
   order of preference, from production durations measured at the source (sync
   span or wait sums; gaps whose start matches the source's timer phase or
   re-arm signature), or from a replayed unit cost (M4, warm runs) times the
   production count of executions (journal lines, receipts, state rows), or
   times the schedule in code when nothing counts executions. A gap's duration
   and a profile window's duration are never exchanged, and MCP binding wall
   time is never counted as occupancy, because it spans awaits.
3. **Two bounds.** Each entry prints a lower and an upper bound and says what
   each assumes. The lower bound uses the smallest warm wall time and the
   smallest defensible count; the upper uses the largest warm wall or loop
   value and the largest count.
4. **Order.** Within a list, by lower bound, descending; ties by upper bound,
   descending. Evidence decides the list, cost the order, so any two adjacent
   rows can be checked from the printed numbers.
5. **Apart from the order.** Entries whose cost scales with an unknown duty
   (open tabs or windows, active timers, launches) are listed per unit of duty
   and not ranked against the others. Entries without a usable cost are listed
   as unquantified. An entry with only a part measured is ranked by that part
   and marked *partial*.
6. **No process weight.** Viewer and runtime-host entries share one order: a
   host stall delays every Viewer request and delivery that waits on a runtime
   RPC (A4).
7. **Peak stall is printed and stays out of the order.** The
   [remediation order](#remediation-slices) puts first the slices that remove
   stalls of at least 2 s or a stall of at least 0.5 s every minute, because the
   requirement names repeated multi-second stalls; it says so where it departs
   from the rank.

### Measured causes

| Rank | ID | Process | Naming evidence | Duration evidence and count | Cost per hour, lower-upper (48 h average) | Peak stall | Slice |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | R2 runtime-host stale-effect maintenance | host | 2,880 of 3,076 host gaps above 500 ms sit on fixed 60 s phase chains (95.8 %, M1b); every minute gap on `a25592be` holds a `registry.snapshot` sync span of 108-456 ms | replay of the tick body 672.8-732.7 ms warm (`R2-maintenance`), 60 ticks per hour; production phase-chained gaps 2,995.4 s in 48 h | 40.4 (replay × 60) - 62.4 (production chained gaps, which also hold anything queued at the same instant, such as the 10 s receipt sweep's every sixth tick) | chained gaps p50 885 ms, p90 1,664 ms | [L1](#l1-runtime-host-maintenance-reads-only-the-pending-effects) |
| 2 | Curator calls: `curate_rules` reads through `projectView` (D6, H8, H1) | Viewer | profile frames in 9 of 25 captured windows of the 15:19Z pass (role-memory and curation chunk above 20 % of samples; windows 1.4-2.6 times their gaps, so the samples are not placed inside gaps); co-occurrence: 73.0 % and 53.6 % of two passes' wall time in logged gaps, against 7.7-20.3 % in the same length before and 10.3-11.8 % after | replay: one read runs `projectView` once, 0.31-3.73 s by the project's retained curator passes (`role-projects`); 897 reads in 48 h (833 scope reads, 64 overviews), each assigned to its pass's project (M1b) | 21.4 (each read at the smallest retained-pass count its project held during the window, smallest warm wall) - 58.0 (today's counts, largest warm wall); the rest of each call (admission, history read, snapshots, attribution) is unmeasured | 3.73 s per view, 3.88 s per scope read (49-pass project); production gaps in the passes up to 3.56 s | [L4](#l4-curator-calls-and-the-role-memory-view-stop-holding-the-loop) |
| 3 | T6 done sweep reading the archive, with hot/archive cache eviction (D2) | Viewer | re-arm chains: 17 consecutive passes on `a25592be` and seven plus on `9c889c07`; over 48 h 626-1,086 chained gaps (±0.15-0.25 s, M1b); done and album frames in 2 of 6 profiles on `9c889c07`; `pipeline.copy` spans | production chained gaps 533.6-1,038.6 s in 48 h; replay: archive read under eviction 541.5-617.0 ms plus the evicted hot read 89.9-100.6 ms | 11.1 (chained gaps at ±0.15 s) - 80.7 (59 passes per hour at the largest steady-state chained pass, 1,368 ms) | 2.49 s (first passes after a start); steady 0.79-1.37 s | [L2](#l2-the-pipeline-archive-leaves-the-minute-timers-and-stops-evicting-the-hot-rows) |
| 4 | R1 runtime snapshot rebuild | host | sync `snapshot-collect` waits (335 in 48 h, largest 762.8 ms); `runtime.collect` spans | production logged waits 143.0 s in 48 h; replay forced rebuild 208.1-314.5 ms | 3.0 - unbounded above (rebuilds under the 250 ms logging threshold are not logged, and the RPC count is not recorded) | 762.8 ms | deferred |
| 5 | D5 synchronous registry write waits | Viewer | sync `registry-lock` and `registry-revision-retry` wait records | production waits 208, 101.8 s in 48 h | 2.1 - unbounded above (waits under the logging threshold) | 1,252.7 ms | [L7](#l7-registry-write-admission-without-synchronous-waits) |
| 6 | H1 MCP caller enumeration | Viewer | attribution frames in 3 of 19 captured windows on `9c889c07`; at 13:29:01.855Z the record's gap is 2,639 ms and its profile window 5,677 ms (`jsProfile.from`-`to`), and the 223 attribution samples of 553 cannot be placed in the gap: between 0 and 2.2 s of them may fall inside it | replay 31.8-106.1 ms wall, 102.8-280.2 ms loop (`H1-attrib`); 3,091 enumerations in 48 h at least (`curate_rules` twice, `stage_report`, `leave_lesson`, `search_memory` once), 4,672 at most (every receipt but `agent_activity`, `curate_rules` twice) | 2.05 (3,091 × 31.8 ms) - 27.3 (4,672 × 280.2 ms) | 106 ms wall per enumeration (280 ms with the collection it leaves) | [L3](#l3-mcp-caller-attribution-reads-only-the-caller) |
| 7 | T9 seat check (*partial*) | Viewer | seat and liveness frames (91 of 507 samples at 13:24:29Z; 106 of 1,504 in the window of the 11.554 s gap) | replay of targeted liveness only, 11.2-24.4 ms warm; 120 checks per hour (10 seat projects every 5 minutes) | 1.3 (liveness part only) - unknown | unknown | [L8](#l8-seat-check-measured-end-to-end-then-bounded) |
| 8 | S3 memory refresh | Viewer | `memory.refresh` sync spans (largest 1,563 ms) | retained spans 41.0 s in 48 h (retained slices are capped) | 0.85 - unknown | 1,563 ms | deferred |
| 9 | T2 temp sweep `/proc` scan | Viewer | `scanProcesses` and `resolvePhysicalPath` frames inside the T1 windows | replay `scanProcesses` 66.5-98.3 ms; at least one per hourly pass | 0.07 (one scan per hour) - unknown (the pass is untimed) | unknown | [L6](#l6-temp-sweep-and-disk-pressure-scans-leave-the-loop) |

**Curator bounds, computed.** Reads per project, by the project's rank in
retained curator passes ([M1b](#m1b-timer-chains-curator-passes-and-profile-windows)
receipts): 668, 80, 81, 25, 18 and 25 (scope reads plus overviews). Retained
passes at the copy: 49, 23, 16, 12, 7 and 3; claimed in the 48 hours: 24, 7, 4,
1, 1 and 1; so the fewest each project held during the window were 25, 16, 12,
11, 6 and 2. The lower bound prices each read at the smallest warm
`role-projects` wall of the largest measured pass count at or below that fewest
count (23 passes 1,304 ms; 16, 1,003 ms; 12, 745 ms; 3, 310 ms for 11 and 6; the
passless key, 163 ms, for 2): 1,029.1 s in 48 h, 21.4 s per hour. The upper bound
prices each read at the largest warm wall of the smallest measured count at or
above the count at the copy (49, 3,726 ms; 23, 2,043 ms; 16, 1,071 ms; 12, 793 ms
for 12 and 7; 3, 438 ms): 2,784.2 s, 58.0 s per hour. Both assume a production
`projectView` costs what the replay measured; production occupancy of these
reads is unmeasured ([coverage gap 2](#coverage-gaps)).

**Fixed, verification pending.** T1 merged-worktree sweep: profiled (11 gaps,
53.0 s of gaps of at least 2 s in the 13:31:43-13:34:31Z pass, up to 1,152 of
1,242 window samples in `sweepMergedWorktreesWithRoots`); fixture replay 5.3-5.6 s
largest loop interval per pass before, 3.4-9.1 ms after #3052; serving since
15:03:24Z; production verdict in [L0](#l0-verify-t1-in-the-follow-up-window).
Before #3052 its cost was 4.5 s per hour at the fixture's single interval and one
pass per about 71 minutes, and up to 44.5 s per hour if all 53 s of that pass's
gaps were its own.

### Duty-dependent costs (per unit of duty, outside the order)

| ID | Process | Unit cost (M4) | Rate per unit of duty | Cost per duty-hour | What is unknown |
| --- | --- | --- | --- | --- | --- |
| H8 rules-window poll (`src/components/roleMemory/LearnedRules.tsx:170`) | Viewer | `projectView` 0.31-3.73 s by project | every 15 s per open window | 74-894 s per open window | how often a rules window is open (no route log) |
| P2 50 ms revalidation timers | Viewer | 3.7-6.2 ms per tick (largest hot row) | 20 per second per active timer | 266-446 s per active timer | activation and job duty (unlabelled until L0b) |
| H5 seat panel `loadTasks()` | Viewer | 48.4-106.3 ms | every 6 s per tab showing a seat | 29-64 s per tab | open tabs |
| H3 resources footer | Viewer | 70.7-97.4 ms (scan and volume probes) | every 30 s per open footer (30 s disk-pressure cache) | 8.5-11.7 s per footer | open footers |
| P3, X1, X2 launch probes | Viewer | 73.0-78.4 ms per Codex host open; 3.7-5.4 ms per launch admission | per launch | — | launches per hour |
| H9 task and pipeline routes | Viewer | 48.4-106.3 ms (tasks), 52.3-88.1 ms (hot pipelines) per action | per action | — | the request mix |
| H11 Codex session walk | Viewer | 4.2-7.0 ms per poll; `codex mcp list` unmeasured | per terminal Codex spawn poll | — | terminal spawns per hour |
| H10 dictation write | Viewer | 6.3-13.8 ms at the 16 MiB cap | per dictation | — | dictations per hour |
| T22 profiler trim | Viewer | 97.5-117.1 ms at the caps | per captured window, only while armed | — | captures per arm window |

### Unquantified

| ID | Process | Evidence | Why no cost |
| --- | --- | --- | --- |
| D1 task transaction holds | unknown | 19,386 holds of at least 50 ms, 5,627.1 s, largest 6,003 ms in 48 h; the no-op write replays at 17.2-36.1 ms | the line carries no process identity: 0 to 117 s per hour on the Viewer depending on who held them (L0b adds `pid` and `role`) |
| H12 `agent_activity` | Viewer | 5,229 calls in 48 h; 240 calls of at least 2 s with 811.7 s of binding wall time, largest 16.8 s | runs the liveness snapshot for a project and refreshes the lifecycle journal per call; only the single-conversation liveness part is replayed (11.2-24.4 ms) |
| Other in-process tool bindings | Viewer | slow calls in 48 h: `stage_report` 58 / 145.0 s, `create_pipeline` 36 / 101.9 s, `agent_fleet` 16 / 66.8 s | binding wall time only |

### Suspects

| Rank | ID | Process | Evidence | Count | Cost per hour, lower-upper | Peak | Next step |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | T19 release retention | Viewer | replay of its parts; code: one `scanProcesses()` per candidate (`src/lib/selfUpdate/retention.ts:160`) and `bytesOf` per kept release (`:164`) | 17 passes in 48 h, 85 kept releases at the last pass | 5.2 (17 × 85 × (66.5 + 107.6) ms) - 7.5 (17 × 85 × (98.3 + 149.3) ms) | about 0.25 s per candidate, between Git awaits | [L10](#l10-release-retention-scans-once-and-counts-bytes-off-the-loop) |
| 2 | T7 attention reconcile summary parse | Viewer | replay | 60 passes per hour from the timer | 2.5 - 3.1 (needs-you reads and seat checks add calls) | 51.5 ms | deferred |
| 3 | R3 producer-receipt sweep | host | replay | 360 ticks per hour | 1.4 - 6.4 | 17.9 ms | deferred |
| 4 | T4 auto-merge clones | Viewer | replay of two hot clones | 10.4 passes per hour at least (500 distinct seconds with `[auto merge]` lines in 48 h) to 240 (15 s debounce) | 1.0 - 28.0 | 116.6 ms | [L9](#l9-read-only-collection-readers-stop-cloning) |
| 5 | A1, A2 agent stdout parsing | Viewer | replay; `/proc` write rates of the agents (310,873 B/s, part 2) | 1,119 MB per hour | 0.79 - 1.36 | per chunk | deferred |
| 6 | D8 lifecycle journal parse | Viewer | replay | 120 seat checks per hour (`agent_activity` refreshes add more) | 0.49 - 1.0 | 8.5 ms | deferred |
| 7 | T3 archive maintenance | Viewer | replay (the pass yields: loop lateness 27-71 ms) | hourly | 0.22 - 0.38 | 71 ms loop | deferred |
| — | Overlap or code only: T8, T10-T18, T20, T21, S1, S2, S4-S6, P1, P4, P5, D7, H2, H6, H7, A3, A4, R4-R6, X3-X5, G1-G3 | — | part 2 records each one's overlap or its stated limit; none has a production observation naming it as a blocker | — | — | — | the follow-up window re-reads them with L0b labels |

### Estimated and unexplained time

The Viewer logged 1,004.8 s of gaps above 500 ms per hour on average over the
48 hours (700.9 s in gaps of at least 1 s). The lower bounds of the measured
Viewer causes sum to 38.9 s per hour (ranks 2, 3, 5, 6, 7, 8 and 9), 43.4 s
with T1's pass before #3052, about 4 % of the logged gap time. That sum is a
conditional estimate that no production measurement confirms. Its curator,
caller-enumeration, seat-check and temp-sweep terms are replayed unit costs
times production counts, whose production occupancy is unmeasured
([coverage gap 2](#coverage-gaps)); its done-sweep term is the length of
chained production gaps, which can hold other work in the same gap (the
3,541 ms gap at 15:19:08Z is a link of the done chain and its profile window
holds curation frames), so terms can overlap. The upper bounds (curator 58.0,
done sweep 80.7, caller enumeration 27.3, T1 44.5 s per hour) are conditional
on their stated assumptions, can overlap each other in the same gaps, and do
not add up to an explained share. One duty-dependent source is large enough
to explain a busy hour alone: a rules window left open on the project with 49 retained passes
would hold the loop up to 894 s per hour, but no record says whether one was
open ([coverage gap 6](#coverage-gaps)). The busy hours (1,000-2,500 s per hour)
remain unexplained: their gaps hold `controller.pipelines`,
`pipelines.controller-job`, `runtime.rpc` and `files.get` as pending operations
and 89 % unnamed watchdog samples. The runtime host logged 65.2 s per hour, of
which R2 accounts for an estimated 40.4 s (its replayed tick, 62 %) to 62.4 s
(its phase-chained gaps, which also hold whatever ran in the same gap, 96 %).

### Covered-by-lane, rechecked

| Lane | Outcome on 2026-10-18 | Does it remove its share? |
| --- | --- | --- |
| `1eb0ab07` (#3052) | merged 14:42Z; measured tip `98a23e4f` equals the merged files (same blob ids for `worktreeSweep.ts`, `worktreeSweepWorker.ts`, `worktreeSweepCache.ts`); serving since 15:03:24Z | On the fixture, yes: largest loop interval 5,329.5-5,586.8 ms before, 3.36-9.06 ms after (same 930 trees, load 4.5-5.4); the cold helper pass takes longer in wall time (6.2-10.9 s against 7.0-7.3 s). In production, no captured long gap during the first helper pass (about 15:13:34 to 15:21:53Z) holds a worktree-sweep frame. The shared `/proc` helpers still run on the Viewer for T2 and H3 (measured rank 9 for the temp sweep; H3 in the duty table) |
| `e9a56ff7` (#3051) | merged and serving since 13:19:58Z | Instrumentation: 19 of 19 Viewer gaps of at least 2 s in its arm window said `captured` (17 distinct profiles). Profiles still last 30 minutes after a deploy and drop the column, leaving `G`/`S` frames ambiguous ([L0a](#l0a-profiler-exact-frames-and-a-window-that-spans-the-hourly-cycle)) |
| `41be75ea` (#3048) | merged 16:29:58Z as `6a1ea0d9`; not serving at 16:46Z (the newest apply is `72866c7d`) | Feature work that adds a usage backfill to S4 (`activity.usage-backfill` label, store opens through `waitForStateLock`); no production measurement possible yet. The follow-up window measures `activity.ingest` and its backfill passes after it deploys |
| `44e9fd13` (#3050) | merged 14:11Z, serving since 15:03:24Z | Better than part 1 assessed: it adds `livenessConversationSnapshot` with indexed reads, and a paired replay measured targeted liveness at 47.00 → 11.61 ms warm (first call 634.8 → 822.2 ms). The M4 case `T9-liveness` reproduces the pair: run from an export of `c91603e0` linked to that release's `node_modules`, on the 16:44Z copies, it took 47.5 [41.6-50.3] ms warm (load 4.1-4.2, 16:54:56Z) against 12.8 [10.3-27.2] ms on `72866c7d` (load 7.5, 16:44:50Z); the loads differ, so this repeats the shape and makes no speed claim. The complete seat check keeps its task, archive and summary reads (measured rank 7, partial) |

## Remediation slices

Each slice is one lane. Every speed claim in an acceptance is a before/after
pair on the same copy, the same Bun, the same gate and six runs per side from
the [M4](#m4-replays-on-scratch-copies) procedure, with load and live/running
agent counts recorded beside the numbers; the cases named under "Before/after"
are M4 cases. Each slice also carries its history-flat test
([RG1](#rg1-history-flat-work-tests)). Runtime-host slices are high risk under
`AGENTS.md`: three review rounds and
`bun scripts/verify-runtime-host.ts --runtime <the pinned bun>`.

Order, by the [ranking rule](#ordering-rule) with its stated peak-stall
priority: L0c, L0a and L0b first, since the follow-up window needs the loop
records, their labels and spans; then L4, L1 and L2 in parallel (ranks 2, 1 and 3; L4 also removes the
largest per-call stall, 0.3-3.9 s, so it leads where lanes are short); then L3
(rank 6; L3 and L4 both touch `src/lib/mcp/bindings.ts` in different functions,
land L3 first if they collide); then L5 (the largest duty-dependent unit); then
L6 and L9; then L7, L8 and L10. Open work touching the same files, checked
at 16:46Z: only draft #2926, which changes how the registry store opens
(`src/lib/agent/sqliteRegistryStore.ts:879`), away from the wait sites L7
changes; `41be75ea` merged as #3048, and #3050, #3052 and #3056 have merged.

### L0. Verify T1 in the follow-up window

No code. The [follow-up window](#follow-up-measured-window) decides whether
#3052 removed T1's share in production.

### L0c. Loop records reach the service journal again

- **Evidence.** [Loop records silenced](#loop-records-silenced-from-163657z-72866c7d):
  no gap record or performance summary from either process since 16:36:57Z.
- **Change.** Recommended: `bin/cli.mjs` leaves `LLV_QUIET_DIAGNOSTICS` unset
  when its stderr is the journal (`JOURNAL_STREAM` set, as systemd sets it for
  this service), which is what `docs/verification/fresh-install-startup.md`
  at `72866c7d` promises service launches; a newcomer's terminal stays quiet. The
  alternative, a loop sink that ignores the quiet flag, would print gap JSON on
  a newcomer's terminal again.
- **Acceptance.** `bin/cli.exposure.integration.test.ts` starts the CLI with
  `JOURNAL_STREAM` set and no debug switch and finds `[viewer loop-gap]` and
  `[performance summary]` lines on the children's stderr; the existing quiet
  test without `JOURNAL_STREAM` still passes. Production: after the deploy, each
  process writes a `[performance summary]` line every minute.
- **Measurement.** Instrumentation; no speed claim.

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
  gap row with columns, which resolves the ambiguous `G`/`S` frames. Profile
  windows stay 5 s windows that can be wider than their gaps (M1b); consumers
  report window samples as window samples.

### L0b. Labels, synchronous spans and process identity

- **Change.** (1) Operation labels for the unlabelled ticks: `done.sweep` (T6,
  `src/lib/done/sweep.ts`), `attention.reconcile` (T7), `temp.sweep` (T2),
  `forge.auto-merge` and `forge.sweep` (T4, T5), `asks.sweep` (T8),
  `hosts.retirement` (T11), `self-update.retention` (T19), the notice prunes
  (T20), `resources.read` (H3), `seat.panel` (H5), `role-memory.view` (H8),
  `pipelines.revalidate` (P2), and in the runtime host
  `runtime-journal.maintenance` (R2) and `runtime-journal.receipt-sweep` (R3).
  (2) Synchronous spans (`performanceSpans.sync`) around the measured heavy
  bodies, so production records their occupancy directly instead of by
  correlation: `memory.project-view` (`projectView`,
  `src/lib/memory/roleStore.ts:499`), `mcp.caller-enumeration`
  (`hostedConversationsFromSnapshot`, `src/lib/mcp/bindings.ts:1187`),
  `runtime-journal.retention-map` (`registryConversationRetentionStates`,
  `src/runtime-host/journalRetention.ts:36`), `liveness.snapshot`
  (`src/lib/lifecycle/liveness.ts:1089`), `proc.scan`
  (`src/lib/tempSweep.ts:124`) and `self-update.bytes`
  (`src/lib/selfUpdate/retention.ts:32`). (3) `pid` and `role` on
  `[state transaction-hold]` (`src/lib/state/sqliteStateStore.ts:539`) and
  `[mcp slow]` (`src/lib/mcp/server.ts:3383`), because the journal's `_PID` is
  the launcher for both children; `[blocking-wait]` already carries `role`
  (`src/lib/blockingWaits.ts:116`), and its registry waits gain the call site
  that L7 needs.
- **Acceptance.** For each label, a test runs the tick with a slow injected port
  under the monitor's test harness and finds the label in the gap record's
  operations; for each span, a test runs the body over a fixture and finds a
  `kind: "sync"` slice with that site; notice tests find `pid` and `role`.
- **Measurement.** Instrumentation; no speed claim. The follow-up window uses
  these labels and spans.

### L1. Runtime-host maintenance reads only the pending effects

- **Evidence.** Measured rank 1.
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
  tick takes at most 10 ms warm (before 672.8-732.7 ms). (4) The runtime-host
  rehearsal passes under the pinned Bun.
- **Before/after.** `R2-maintenance`, `R2-map`, `R2-settle` on one copy;
  production: host gaps on fixed 60 s phase chains (M1b; before: 2,880 of 3,076
  host gaps in 48 h, 15 of 15 minutes on `a25592be`).

### L2. The pipeline archive leaves the minute timers and stops evicting the hot rows

- **Evidence.** Measured rank 3.
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
  of 0.2-0.3 ms and archive reads of 201.0-244.2 ms (the per-record clone that
  (a) removes). A dedicated archive slot with its own bound gives the same
  result and keeps the hot collections safe as the archive grows (147.5 MiB at
  the heap-fix audit, 214.9 MiB now; the hot collection stays near 65 MiB).
  Recommendation: the dedicated slot, bounded at 512 MiB (2.4 times today's
  archive), with the eviction line firing before the archive outgrows it. The
  archive's decoded rows already occupy the heap for most of each minute today;
  keeping them resident removes the per-read churn (+331 to +555 MB of RSS per
  evicting archive read in `T6-evict`).
- **Acceptance.** (1) A test fills hot and archive slots in the measured size
  ratio and finds the hot slot intact after an archive fill and the reverse.
  (2) Done, album and seat paths run on frozen fixtures without writing to
  them. (3) Copy: warm archive and hot reads at most 1 ms each when alternated
  (before 541.5-617.0 and 89.9-100.6 ms); a `runDoneSweepOnce` replay with the
  production world on copied state keeps the loop within 100 ms.
  (4) [RG3](#rg3-native-eslint-restrictions-on-server-code) allows
  `loadArchivedPipelines` only in the archive maintenance and the sweep
  helper.
- **Before/after.** `T6-evict` at both budgets, `D2`, and a new
  `runDoneSweepOnce` case added to `probe.ts`; production: re-arm-chained Viewer
  gaps (M1b; before 626-1,086 in 48 h) and the `done.sweep` pass durations.

### L3. MCP caller attribution reads only the caller

- **Evidence.** Measured rank 6.
- **Change.** In `attentionCallerSources` (`src/lib/mcp/bindings.ts:1241`),
  a caller that presents a capability (every HTTP caller) is resolved through
  the indexed digest lookup (`conversationIdForSpawnCapabilityDigest`), and the
  hosted record is built for that conversation only, from its generations'
  entries by key, before its pids are checked; `attentionCallerAuthority`
  (`src/lib/attention/callerAuthority.ts:75`) stops enumerating first. The full
  enumeration (`hostedConversationsFromSnapshot`, `bindings.ts:1187`) stays for
  capability-less stdio callers, memoized per registry revision and boot epoch.
  Attribution is computed once per tool call and passed to the 40
  `attributionOf` sites, `curate_rules`' `authorizeReceipt` included.
- **Acceptance.** The existing caller-authority and bindings tests decide the
  same (pid conflict, capability conflict, unresolved capability, native
  caller, deputy seat). History-flat: registry rows decoded per HTTP
  attribution stay constant with ten times the unrelated conversations. Copy:
  at most 2 ms warm (before 31.8-106.1 ms wall).
- **Before/after.** `H1-attrib` on one copy; production: the
  `mcp.caller-enumeration` span (L0b) and attribution frames in captured
  windows.

### L4. Curator calls and the role-memory view stop holding the loop

- **Evidence.** Measured rank 2, root cause found by the replay. Every
  `curate_rules` read (`src/lib/mcp/bindings.ts:7919`) runs `readCuration`
  (`src/lib/memory/curation/read.ts:14`), which calls `projectView`
  (`src/lib/memory/roleStore.ts:499`) once. `projectView` ends in
  `curationView` (`src/lib/memory/curation/store.ts:227-235`), which calls
  `readPass` for every retained curator pass of the project (`:50-61`), and each
  `readPass` decodes every scope row of the project through `curationScopes`
  (`:95-112`), only to sum the history counts that belong to that one pass. The
  102 scope rows hold 12.6 MB because each carries its history, so the view
  costs about 70 ms per retained pass plus about 165 ms: 0.31 s at 3 passes,
  3.73 s at 49 (`role-projects`), 95.5 % of samples under `curationView`
  (`profile-view.ts`). Retained passes grow by one per pass (38 passes in 48 h,
  24 for one project), so each pass makes the next one slower. The same view
  answers the rules window and the project menu row every 15 s
  (`src/components/roleMemory/LearnedRules.tsx:146-171`, H8).
- **Change.** (1) `curationView` decodes the project's scope rows once and
  derives every pass's counts from one walk over their histories (or reads
  counts kept on the pass row at write time); `readPass` keeps its single-pass
  path for callers that need one pass. (2) `projectView` builds `rulesById` and
  the per-scope lists in one pass over the rows (today every rule is filtered
  again for each scope) and memoizes per role-memory and curation collection
  revision, which the rules-window poll also reuses. (3) `readCuration` stops
  cloning the whole role-memory collection on every read
  (`roleMemoryCollection()?.snapshot()` at `read.ts:21`); the scope read takes
  its other-project list from the rows of the role's scopes. (4) Each call resolves its caller and the curator snapshot once and
  reuses them in `authorizeReceipt` and the binding (with L3).
- **Acceptance.** Identical `curate_rules` answers and `projectView` output on
  fixtures against the current implementation; history-flat: rows decoded by
  one `projectView` stay the same when the project's retained passes grow
  tenfold and when another project's rules grow tenfold; copy: `H8` at most
  50 ms and `D6-scope-read` at most 100 ms of loop for the 49-pass project
  (before 3,456-3,750 and 3,680-3,928 ms); an unchanged-revision view at most
  1 ms.
- **Before/after.** `H8`, `D6-overview`, `D6-scope-read`, `role-projects` and
  `profile-view.ts` on one copy; production: the `memory.project-view` span
  (L0b), and the Viewer's gap share during curator passes (M1b; before 73.0 %
  and 53.6 %).

### L5. Pipeline revalidation timers read the row revision

- **Evidence.** Duty-dependent, the largest unit per duty-hour (266-446 s per
  active timer).
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
  hot row takes at most 0.1 ms (before 3.7-6.2 ms).
- **Before/after.** `P2` on one copy; production: `pipelines.revalidate`
  (L0b) totals and gap seconds with `pipelines.controller-job` pending.

### L6. Temp sweep and disk-pressure scans leave the loop

- **Evidence.** Measured rank 9; H3 in the duty table.
- **Change.** `runTempSweep` (`src/lib/tempSweep.ts:794`) runs in the leased
  `worktree-sweep` helper that #3052 added, under its lease, deadline and
  bounded reply. The disk-pressure reader (`src/lib/state/diskPressure.ts:285`
  at `a25592be`) takes the process scan from the helper's latest result within
  its 30 s cache, and the per-root `statSync`/`statfsSync` move with it.
- **Acceptance.** No `scanProcesses()` call on a Viewer timer or request path;
  a fixture pass over the measured shape (about 340 processes, 44,000 path
  references) keeps the Viewer loop within 50 ms; a resources request spends
  at most 10 ms on the main thread with a fresh helper result (before
  70.7-97.4 ms).
- **Before/after.** `T2` and `H3`; production: the `temp.sweep` label and
  `proc.scan` spans (L0b), and `resources.read` totals.

### L7. Registry write admission without synchronous waits

- **Evidence.** Measured rank 5.
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

- **Evidence.** Measured rank 7, *partial*: only targeted liveness is timed.
- **Change.** After L2, add a `T9-check` case to `probe.ts` that runs `check`
  (`src/lib/monitor/seatTickController.ts` at `a25592be`) with production
  sources on the copy, `gh` stubbed and transcript evidence suppressed, and
  records time per source; then remove any synchronous source above 50 ms.
  Candidates from the inventory: the `loadTasks()` clone
  (`src/lib/monitor/seatTickSources.ts:681`), the 34 MB summary parse for
  worker asks (`:693-697`), and the lifecycle journal parse
  (`src/lib/lifecycle/journal.ts:208`).
- **Acceptance.** The complete check keeps the loop within 100 ms on the copy.
- **Before/after.** `T9-check` before and after on one copy; production:
  `seat-tick.check` overlap per hour and `liveness.snapshot` spans.

### L9. Read-only collection readers stop cloning

- **Evidence.** Suspect 4 (T4); H5 and H9 in the duty table.
- **Change.** `sweepAutoMerge` and `sweepTaskFinishes`
  (`src/lib/forge/autoMerge.ts:699`, `:919`), the forge sweep
  (`src/lib/forge/sweep.ts:101`, `:107`), the seat panel
  (`src/app/api/orchestrator/seat/route.ts:124`) and the request routes the
  [screen](#route-and-tool-screen) found reading whole collections only to find
  one row or a keep-set (`src/app/api/tasks/route.ts:105`,
  `src/app/api/tasks/[id]/assignment/route.ts:85`,
  `src/app/api/tasks/[id]/send/route.ts:86`,
  `src/lib/attention/dismissals.ts:730`) read
  `loadPipelinesForList()`/`loadTasksForList()` or a keyed row; writes stay
  keyed. `[auto merge] <id>: not admitted: …` is written when a lane's reason
  changes, through a map bounded by the hot lanes.
- **Acceptance.** Frozen-fixture tests show these paths write nothing to rows;
  two passes with unchanged reasons write one line per lane; copy: an
  auto-merge pass takes at most 5 ms without `gh` (before 96.5-116.6 ms) and
  the seat panel's and the routes' task reads at most 1 ms warm (before
  48.4-106.3 ms).
- **Before/after.** `D1`, `D3` and `T4-pair`; production: `[auto merge]`
  lines per hour (before 39,111 in 48 h).

### L10. Release retention scans once and counts bytes off the loop

- **Evidence.** Suspect 1.
- **Change.** `retainReleases` (`src/lib/selfUpdate/retention.ts:63`) scans
  `/proc` once per pass (it now calls `scan()` per candidate at `:160`, 85
  kept releases here) and runs `bytesOf` (`:32`, called at `:164`) in a helper.
- **Acceptance.** A fixture of 85 release directories triggers one scan per
  pass and keeps the Viewer loop within 50 ms during the pass.
- **Before/after.** `T19` extended to a full pass over copies of retained
  releases (read-only); production: the `self-update.retention` label and
  `self-update.bytes` spans after an apply.

## Regression guards

The repository already bounds the serving loop in one place: the candidate
performance gate refuses a release whose Viewer loop exceeds p95 50 ms or max
500 ms while serving (`docs/design/candidate-performance-gate.md`), over a
synthetic registry of 53,299 rows. Its dataset holds no pipeline, task or
role-memory collections, its serving phases last 8-12 s (`WARM_MS`,
`SERVED_AFTER_SWITCH_MS` in `src/runtime-host/candidatePerformanceRun.ts:74-76`),
shorter than the minute timers, and it sets no bound on the runtime host's own
loop. The code already offers asynchronous state-lock admission
(`waitForStateLock`), loop-monitor operation labels and the frozen list readers
this audit names. The guards below close the measured holes; L0c's
integration test keeps the loop records on for service launches.

### RG1. History-flat work tests

Each of L1-L5 and L9 ships a test that counts rows or bytes decoded by the
fixed path through the store's own hook, then grows unrelated history tenfold
(for L4 also the project's own retained curator passes) and asserts the count
is unchanged. The count is deterministic, so it runs in
the ordinary `bun test` by path without timing noise, and it fails the day a
whole-collection read returns to that path.

### RG2. The candidate performance gate covers state history, the minute timers and the host loop

- Add generated state collections at this installation's measured sizes to the
  gate's dataset (`src/runtime-host/candidatePerformanceRun.ts`): about 270 hot
  pipelines (34 MB, largest about 515 KB), 950 archived (111 MB, largest
  about 1.1 MB), 2,450 tasks (9.8 MB), 3,900 role-memory rows (16 MB, one of about 2.9 MB)
  with about 100 scope rows carrying 12.6 MB of history, and one project with
  50 retained curator passes. Generated content only; no copied data.
- Keep the serving window open at least 75 s after warm-up, so the done sweep
  (15 s, then every 60 s), the attention reconcile (30 s, then 60 s) and the
  runtime host's minute maintenance fire inside it.
- Read the runtime host's own loop-gap records and refuse a release whose host
  loop exceeds 250 ms outside boot. The gate's host already runs the
  candidate's `src/runtime-host/main.ts` unchanged
  (`src/runtime-host/candidateRuntimeHost.ts`) over the synthetic registry,
  so its minute maintenance fires once the window passes 60 s; today the gate
  bounds only the Viewer's loop (`src/runtime-host/candidatePerformance.ts:254-269`).
- Exercise one curator read and one rules-window view inside the serving
  window, so `projectView` runs at the measured history size.
- Adoption check: run the extended gate on `a25592be` first; it must refuse for
  R2, the archive read and the curator view (red before), then pass after L1,
  L2 and L4.

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

**When.** After the first deploy that carries L0c, L0a and L0b; then again after
each of L1-L5 deploys. A deploy restarts the hourly timers, so the window
starts at the deploy and ends 15 minutes after the second worktree pass
completes, at most 120 minutes, with `armMinutes: 120`. It spans startup, the
temp pass at +5 min, the worktree pass at +10 min, every done-sweep and
host-maintenance minute, a seat-tick sweep every 5 minutes, and the second
temp and worktree passes, due 1 h after the first ones end (the first helper
pass on `a25592be` was still running 10 minutes after it began). It also needs
one curator pass (38 in the 48 hours); if none starts, the window extends to
the next one, up to the 120 minutes.

**Precondition.** In the first 10 minutes, each process writes a
`[performance summary]` line every minute and the Viewer writes
`[viewer loop-gap]` records; otherwise the window is void and is rescheduled
(on `72866c7d` neither happens, see
[Loop records silenced](#loop-records-silenced-from-163657z-72866c7d)).

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
| R2 (L1) | host gaps above 500 ms on fixed 60 s phase chains (M1b) | 2,880 of 3,076 gaps in 48 h; 15 of 15 minutes on `a25592be` | chained gaps in at most 2 % of the window's minutes |
| T6 (L2) | re-arm-chained Viewer gaps (M1b, ±0.25 s); `done.sweep` pass durations | 626-1,086 chained gaps in 48 h; median 943 ms per pass (791-1,368 ms), 1.98-2.49 s for the first seven after a start | no chain of five after the third pass; `done.sweep` 95th percentile at most 100 ms |
| H1 (L3) | `mcp.caller-enumeration` sync spans (L0b) | replay 31.8-106.1 ms per enumeration | 95th percentile at most 2 ms |
| Curator, H8 (L4) | `memory.project-view` sync spans (L0b); the Viewer's gap share during a curator pass against the same length around it (M1b) | replay 0.31-3.73 s per view; gap share 73.0 % and 53.6 % against 7.7-20.3 % around | span 95th percentile at most 50 ms; gap share during the pass within 5 points of the share around it |
| P2 (L5) | `pipelines.revalidate` seconds per running activation-hour | not labelled yet | measured in the first window; after L5, at most 1 % of the first window's value |
| Attribution | share of Viewer gap seconds (at least 1 s) with a non-umbrella label or a sync span; share of window samples under a mapped source | 89 % unknown watchdog samples | reported; any unlabelled source above 10 % of gap seconds gets an attribution task |

Aggregate seconds per hour are reported beside the 48-hour table for context
and decide nothing: hour-to-hour ratios of 0.36-2.75 with no code change exceed
any effect these slices can show in one window.

## Coverage gaps

1. **Most stall time has no named cause.** 89.28 % (Viewer) and 84.75 % (host)
   of watchdog samples in gaps of at least 1 s are
   `unknown-runtime-or-native`. The lower bounds of the measured Viewer causes
   sum to 38.9 s per hour, 43.4 s with T1 before #3052, of the 1,004.8 s of
   logged gaps per hour (about 4 %): a conditional estimate whose terms can
   overlap, as are the upper bounds; busy hours of 1,000-2,500 s are
   unexplained (see
   [Estimated and unexplained time](#estimated-and-unexplained-time)).
2. **Production occupancy of the curator calls, the caller enumeration and the
   seat check is measured only by replay.** Binding wall time spans awaits,
   completion lines do not mark gap ends, and profile windows are 1.4-2.6 times
   their gaps (M1b), so production gives correlation and frame presence only.
   The replay times the `projectView` part of a curator read (lower bound
   21.4 s per hour); the rest of a call (admission, history projection, curator
   snapshots, attribution, the apply transaction) is untimed. L0b's synchronous
   spans make all three measurable in production.
3. **The largest stall in the arm window is unresolved.** 11.554 s at
   13:30:59.458Z: 118 of 118 watchdog samples unknown, 3.25 ms of retained
   `registry.keyed`, seat frames in 106 and liveness in 27 of 1,504 window
   samples, and an RSS step of +3.2 GB inside the gap. Part 2 does not say
   whether the 48-hour maximum, 35,188 ms, carried a profile.
4. **GC and heap.** Bun exposes no GC entries (`gc-entry-unsupported`) and no
   cheap heap counters; native sampling is blocked (`perf_event_paranoid` 4).
   RSS steps of up to 4.2 GB inside a single gap (2026-10-17 13:57:00Z; 3.2 GB
   in the 11.554 s gap), a 30-minute peak of 6.89 GB and `VmHWM` 11.4 GB are
   context; no allocation is tied to a gap except through the replays' heap and
   RSS deltas (evicting archive read +331 to +555 MB of RSS, R2 +138 MB of heap,
   `projectView` +113 to +322 MB of RSS).
5. **The runtime host has no JS profiler** (R6), and all its gaps report
   `operations: []`. R2's attribution rests on the phase chains, the
   `registry.snapshot` spans inside each minute gap and the copy replay.
6. **Duty is unknown.** Requests carry no route, so the request mix (H6) and the
   duty of every per-view cost are unknown: how often the rules window, the
   project's ⋯ menu or the phone menu sheet is open (H8, up to 894 s per hour
   per open view on the 49-pass project), how many tabs show the seat panel
   (H5) or the resources footer (H3), P2's activation and job duty, and launches
   per hour (P3, H11). One view session was recorded at the inventory read.
7. **No process identity** on `[mcp slow]` and `[state transaction-hold]`
   (so D1's 117 s per hour of holds is unattributed), registry
   `[blocking-wait]` records name their caller only by a minified `subject`,
   and MCP calls under 2 s leave no line (L0b).
8. **What the route and tool screen cannot see, and what it found but did not
   time.** It follows no port whose implementation is assigned elsewhere, no
   call dispatched by name (tool bindings were screened as their own roots), no
   worker message or dynamic import, and nothing deeper than six calls, and it
   counts every branch as taken. Found and untimed: the Telegram session-store
   listing (2,629 files under its state), the external-relay answers listing
   (1,760 files), the memory index source listings, the slug-decoding walk
   (`src/lib/scanner/describe.ts:349`), `codex mcp list` on terminal launches
   (X4), the role-memory lessons poll every 20 s (`stageLessons`), the inline
   board projection's frequency, `agent_activity` per call (H12), and the other
   in-process tool bindings with slow calls.
9. **Unmeasured units.** The complete seat check (T9), a whole temp pass (T2),
   T8, T11 and T20 passes, delivery drains (A3: 1,885 drain-failure and 1,908
   timeout lines, with no replay), and the activity usage backfill (`41be75ea`,
   unserved).
10. **Profiles cover 30 minutes after a deploy**, so the second hourly pass is
    never profiled, and dropped columns leave `11265:1 G`/`S`, `72293:80 h`/`s`,
    `92134:1 p`/`s`, `89508:1 q`/`u` and `36787:1 C`/`v`/`I` ambiguous (L0a).
11. **Several counts are lower bounds.** Chains break where an await displaces a
    link beyond the tolerance; waits and holds under their logging thresholds
    are not logged; retained sync slices are capped; `[auto merge]` lines appear
    only when a lane is blocked.
12. **Replays are single-process.** Unit costs come from one Bun process on
    copied production-sized state under a 300 % CPU cap (load 4.7-6.9 in the
    final run); the serving process runs them beside other work, so they are
    lower bounds for contended runs.
13. **The deployed fixes have a first look only**: one worktree-sweep pass
    (completed 15:21:53Z) and 27 minutes of `a25592be`, inside its arm window.
14. **No loop records since 16:36:57Z.** The release applied at 16:38:04Z
    (`72866c7d`) drops every `[viewer loop-gap]` and `[performance summary]`
    line on this installation
    ([observation](#loop-records-silenced-from-163657z-72866c7d)), so nothing
    after that time can be measured from the journal until
    [L0c](#l0c-loop-records-reach-the-service-journal-again) serves.

## Validation against the requirement

The requirement asks what else blocks the two main loops, again and again. By
the [ranking rule](#ordering-rule): the runtime host's whole-registry read
every minute (40.4-62.4 s per hour); the curator's role-memory reads, each
running a view whose cost grows with every retained curator pass (0.31-3.73 s
per call, 21.4-58.0 s per hour), the same view the rules window and the project
menu poll every 15 s while open; the Viewer's archive read with cache eviction
every minute (11.1-80.7 s per hour); then the runtime snapshot rebuilds, the
synchronous registry waits, the per-call MCP caller enumeration, the seat check,
memory refresh and the `/proc` scans. The hourly worktree sweep is fixed,
verification pending. Suspects with measured unit costs follow, led by release
retention. Every API route and tool binding was screened; what the screen found
and did not time is listed as a coverage gap. The busy-hour share stays
unexplained until L0a and L0b let the follow-up window name it, and since
16:36:57Z the release serving here leaves no loop record at all, so L0c comes
before any further production measurement. No operator
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
- Inventorying every one of the 220 API routes was deferred by the first
  version of part 3. Verification found that deferral contrary to the scope
  (API and MCP handlers and synchronous filesystem work are named in it), so
  the revision screened every route and tool binding
  ([Route and tool screen](#route-and-tool-screen)); timing the families the
  screen found but did not time stays open as a
  [coverage gap](#coverage-gaps).
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
- Caching the board summary parse (T7, H4): 42.1-51.5 ms per read, 2.5-3.1 s
  per hour from the reconcile timer. L8 removes it from the seat check if it
  dominates there.
- Rebuilding the runtime snapshot by changed scope (R1, deferred by `cbaaf29a`
  item 5): 3.0 s per hour of synchronous waits, largest 762.8 ms.
- The receipt sweep (R3, at most 17.9 ms per 10 s, 1.4-6.4 s per hour),
  archive maintenance (T3, 0.22-0.38 s per hour), agent stdout parsing (A1/A2,
  0.79-1.36 s per hour), the lifecycle journal parse (D8, 0.49-1.0 s per hour),
  the Codex launch probes (P3, 73.0-78.4 ms per Codex host open), the dictation
  write (H10, 6.3-13.8 ms at its cap) and the Codex session walk (H11,
  4.2-7.0 ms per poll). Each is bounded per call or below 7 s per hour.
- Memory refresh (S3): 41.0 s of retained spans in 48 hours, single spans up to
  1,563 ms. Revisit if the follow-up window shows spans above 1 s more than
  once per hour.
- Keyed task writes (D1). The holds (19,386, 5,627 s in 48 hours) have no
  process identity; L0b adds it, and the change is justified only if the
  Viewer holds a material share.
- A per-route request log (H6). L0b's labels name the polled handlers that
  cost; a route log adds volume without a measured need yet.
