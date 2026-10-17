# MCP state writers: production audit and fix design

Audit date: 2026-10-15 UTC. The original audit changed documentation only. Production processes were observed through procfs, descriptor metadata, existing journals and SQLite connections opened with `mode=ro` and `PRAGMA query_only=ON`. No production signals, checkpoints, PRAGMAs that change storage, application mutations, deployments or restarts were issued. Later implementation and isolated measurements follow the audit; the [108-sample study](#acceptance-matrix-with-bounded-task-execution) publishes every required cohort. The strict Viewer loop bounds and nominal-window coverage remain unmet.

## Answer and limits

At **05:10:44.428–05:11:14.442Z**, production had **19 stdio launchers and 19 bundled MCP servers**. All 19 pairs had a live Claude or Codex ancestor: **zero confirmed owner-gone orphans**. Ten servers held **107 main-database descriptors**, of which **97 were opened read/write**, plus 90 WAL and 10 SHM descriptors. Nine servers and all launchers held zero `state.sqlite` descriptors. These are descriptor counts, a connection-footprint proxy; procfs cannot count SQLite connection objects or prove that each writable handle is actively writing. [E1]

Eighteen servers recorded zero `write_bytes` during the sample. Server **3534707** recorded 3,022,848 bytes, or **100,715.1 bytes/s**, across all its files, with 2,813,952 cancelled write bytes. It also owned the one newly claimed durable MCP operation retained for the window: `create_pipeline`, claimed at **05:11:10.267Z**, settled when read at 05:14:52Z. That is **0.0333 attributable new claims/s**, with zero retained new claims for the other sampled servers in this window. A claim, syscall, WAL metadata change and SQLite transaction are different measurements. **Exact per-PID SQL write/commit rates and exact connection-object counts remain unobservable with this passive method.** [E1, E4]

The shared WAL's inode/size/mtime tuple changed **33 times in 30.014 seconds**, sampled every 250 ms. This is a lower bound on observed metadata transitions, about 1.10/s, with no attribution to a writer or collection. The previous investigation's 37 servers and at least 46 WAL changes/30 s describe an earlier release and workload; this sample cannot establish an improvement. [E1, E5]

The audited implementation permits direct MCP domain writes and retains handles per opened collection. Centralizing all managed MCP calls in the existing Viewer MCP service can eliminate the local database footprint while retaining the existing command and receipt implementation. Lifecycle hardening must also cover death of the actual agent while another descendant keeps its stdio descriptor open. No orphan cleanup is justified by this census.

**Accepted measurement boundary:** the controller's decision continuation, settled attempt 1, accepts the passive production baseline and its OS-level counters. Production tracing is prohibited. Exact SQL connection counts, commits and lock waits per process belong to the isolated before/after test with identical synthetic load described below. The audit is complete within that accepted boundary; executing and reviewing the synthetic comparison belongs to the build and review stages. Results were outstanding when the original audit was written. The collected comparison and its remaining acceptance failures are published below.

## Scope, revisions and evidence ledger

Code references in the production-audit sections are at **main `45d25ac796d5824713c9fb57d65f57efea61041b`**. Later implementation and measurement sections name their frozen revisions. Local HEAD, origin/main and a read-only `git ls-remote origin refs/heads/main` agreed at 05:10:56Z. The Viewer PID 1834964 and every sampled server had the release-directory suffix `781ecd4c3348`; the stored self-update pointer named **`781ecd4c33482d7486683d19d61a8b0bc8c14d38`**. A scoped `git diff --stat 781ecd4c33482d7486683d19d61a8b0bc8c14d38 HEAD -- bin/mcp-server.mjs src/lib/mcp src/lib/tasks/store.ts src/lib/state/sqliteStateStore.ts` at 05:12:29Z was empty. The cited MCP/task/store code therefore matches that release's source. This does not attest the rest of the deployment. [E2]

| Evidence | UTC bounds | Command / query and result |
|---|---|---|
| E1 | 05:10:44.428–05:11:14.442 | `rtk proxy python3 -B -`, collector reproduced below: proc stat/cmdline/environ, fd symlinks/fdinfo, I/O counters, WAL stat. 38 processes; no sampled PID exit/reuse; main DB FDs grew from 107 to 108 because 3534707 grew 9→10. Census/I/O reads immediately precede and follow the timed WAL interval sequentially; per-process rates use its duration and have that small, unmeasured sampling skew. |
| E2 | 05:09:36–05:12:29 | `git log -1 --format="%H %cI %s"`, same for origin/main; `git ls-remote origin refs/heads/main`; `readlink /proc/1834964/cwd`; `cat /proc/1834964/cgroup`; Python JSON read of the existing self-update release pointer, selecting only `sha`; scoped diff above. |
| E3 | 05:12:52.084–05:12:52.088 | Read each sampled server's capability in memory, hash it without printing it, SELECT matching launch receipt from existing `agent-registry.sqlite`. All 19 matched exactly one receipt, all recorded `viewerMcpTransport=stdio`. Only engine, role, conversation identity and launch state were returned privately; the table uses agent letters. |
| E4 | 05:14:52.148; 05:15:09.217–05:15:09.974 | Read-only `mcp-receipts.sqlite` query for `claimed_at BETWEEN 1792041044427 AND 1792041074442`, selecting tool prefix, binding owner and whether settled; retained per-PID tool counts also read. Only one row in the sampled window, owned by 3534707 with start identity `3534707:117214002`. |
| E5 | 05:11:27–05:11:42 | `search_transcripts(project:"delegatus", query:"MCP state.sqlite contention", limit:4)`; unscoped `"MCP orphan stdin"`, limit 3. Opened the originating transcript through `conversation_messages(transcriptPath:<returned path>, roles:["assistant"], since:"2026-10-14T22:00:00Z", limit:12, maxChars:5000)`. The 23:43:16Z answer in conversation_79233379 reports the old 61799bbc measurements. Current code was checked independently. |
| E6 | 05:11:29.189–05:11:29.191; follow-up 05:22:01–05:22:27 | Passive memory-index FTS queries for `"MCP" AND "stdio"`, `"MCP" AND "orphan"`, `"state" AND "contention"`, plus direct reads of native/desktop memory and their referenced summaries. Follow-up restricted the same terms to the current project plus global scope and opened the three hits by ID with SELECT. Existing September 27 work covers launcher reconnect and held-open-stdin shutdown; no memory hit established current production orphans. |
| E7 | Log window 00:28:23–05:12:00; query 05:12:29.622 | `journalctl --user -u delegatus.service --since '2026-10-15 00:28:23 UTC' --until '2026-10-15 05:12:00 UTC' -o json --no-pager`, streamed into literal-pattern counts. 2,698 entries; results below. |
| E8 | 05:13:36.112–05:13:36.130 | Full readable procfs rescan: examine all Bun/Node argv positions for exact MCP entry suffixes, classify the state root, count main DB FD targets. 40 production MCP processes; 2 isolated test processes excluded. |
| E9 | 05:14:01–05:14:12 | Rechecked procfs permission failures by UID and command/state. Most belonged to other UIDs; stable same-user denials were system/login/key services and a zombie Codex with no argv. Transient process races also occurred. No sampled production MCP process was unreadable. This is an operator-UID census, not a claim about every inaccessible process in every namespace. |
| E10 | 05:11:14–05:11:15 | `gh pr view 2905 --json state,title,headRefOid,files`: OPEN, head `45a4277a2b356c106c8226422f7858d54d2cdf7b`, including sqliteStateStore, pipeline store/evidence and loop instrumentation. This document avoids those implementation areas. |
| E11 | 05:12:05–05:18:35 | `nl -ba <file>` and `rg -n <symbol> <file>` for the exact code references in the write-path and lifecycle sections. Static audit only; no application module imported against production. |

Memory-tool deviation is deliberate: `search_memory` can normalize projects during a query (`src/lib/memory/index.ts:104,248`), and opening a hit records an outcome (`:279`). Those calls were replaced with read-only FTS/SELECT and source-file reads. Deployment-status GET also calls the self-update snapshot (`src/app/api/runtime/deployments/route.ts:45`); the stored release pointer was used instead. Before transcript search, read-only schema checks confirmed version 5 and both query indexes, avoiding its missing/old-schema initialization path (`src/lib/search/transcriptSearch.ts:342`). Search terms can be widened/ignored by the search service; hits were treated as pointers.

## Owners, lifetimes and orphans

All times in the table are on 2026-10-15 UTC. Kernel start ticks, together with PID and boot identity, protect against PID reuse; wall-clock times are reconstructed from procfs `btime + start_ticks / CLK_TCK` and have the precision of that source. These are process birth times, not database-open times.

| Agent | Engine / role | Agent PID, start UTC | Launcher PID, start UTC | Server PID, start UTC | Server start ticks |
|---|---|---|---|---|---|
| A | claude / orchestrator | 1835939, 00:28:36.020Z | 1836012, 00:28:36.460Z | 1836029, 00:28:36.500Z | 115527250 |
| B | codex / prod-auditor | 1841440, 00:29:38.400Z | 1841622, 00:29:39.270Z | 1841633, 00:29:39.310Z | 115533531 |
| C | codex / maintainer | 1954230, 00:38:36.510Z | 1955218, 00:38:40.330Z | 1955239, 00:38:40.370Z | 115587637 |
| D | codex / maintainer | 2390718, 01:18:40.090Z | 2390890, 01:18:40.570Z | 2390906, 01:18:40.600Z | 115827660 |
| E | codex / maintainer | 3322373, 02:53:46.780Z | 3322511, 02:53:49.570Z | 3322522, 02:53:49.590Z | 116398559 |
| F | codex / maintainer | 3398573, 03:43:36.110Z | 3398709, 03:43:36.690Z | 3398721, 03:43:36.720Z | 116697272 |
| G | codex / merger | 3412531, 03:53:51.400Z | 3412689, 03:53:51.950Z | 3412700, 03:53:51.980Z | 116758798 |
| H | claude / curator | 3436466, 04:08:35.920Z | 3436502, 04:08:36.150Z | 3436517, 04:08:36.180Z | 116847218 |
| I | codex / maintainer | 3456638, 04:23:39.400Z | 3456761, 04:23:39.790Z | 3456772, 04:23:39.830Z | 116937583 |
| J | claude / orchestrator | 3508703, 05:03:04.500Z | 3508750, 05:03:04.750Z | 3508772, 05:03:04.780Z | 117174078 |
| K | codex / prod-auditor | 3511832, 05:04:28.970Z | 3511968, 05:04:29.750Z | 3511980, 05:04:29.810Z | 117182581 |
| L | claude / reviewer | 3513383, 05:04:52.250Z | 3513429, 05:04:52.550Z | 3513445, 05:04:52.590Z | 117184859 |
| M | codex / prod-auditor | 3523029, 05:07:26.750Z | 3523305, 05:07:27.650Z | 3523333, 05:07:27.680Z | 117200368 |
| N | codex / builder | 3526217, 05:07:47.230Z | 3526338, 05:07:47.580Z | 3526366, 05:07:47.610Z | 117202361 |
| O | codex / prod-auditor | 3527914, 05:08:09.320Z | 3528046, 05:08:09.900Z | 3528063, 05:08:09.930Z | 117204593 |
| P | codex / prod-auditor | 3528735, 05:08:26.550Z | 3528862, 05:08:27.010Z | 3528872, 05:08:27.040Z | 117206304 |
| Q | codex / prod-auditor | 3529522, 05:08:38.270Z | 3529710, 05:08:39.060Z | 3529722, 05:08:39.090Z | 117207509 |
| R | codex / prod-auditor | 3532028, 05:09:06.420Z | 3532232, 05:09:07.520Z | 3532242, 05:09:07.550Z | 117210355 |
| S | claude / orchestrator | 3534644, 05:09:43.710Z | 3534693, 05:09:43.990Z | 3534707, 05:09:44.020Z | 117214002 |

There were 5 Claude owners and 14 Codex owners. Each server's immediate parent was its launcher; each launcher was immediately parented by the agent process. Codex has an additional Node CLI parent above that agent. Every chain reached the same live Viewer process, **1834964**, born **00:28:23.200Z**, then the existing supervisor/service. Every receipt matched the observed engine. Receipt state `completed` denotes completed launch admission; it does not prove the agent has exited. [E1, E3]

The oldest servers were about 4 hours 42 minutes old. Their agent owners were still present. The sample observed retained descriptors for 30 seconds; it cannot date each descriptor's first open. All sampled identities survived the measured window, and none was parented directly to PID 1. The actionable orphan list is empty.

At E8, **launcher 3508750 and server 3508772 had disappeared**, and two pairs had been born: **3546816/3546827** and **3548438/3548448**. That is two removals and four births between observations, taking the total from 38 to 40; the reason for the exit was not established. Nine servers then held 93 main DB descriptors. Separate non-MCP holders were the runtime host (1834890, 2 descriptors), Viewer (1834964, 53), account-migration worker (1835169, 13), and files-response worker (3551412, 12). Those concurrent users prevent attribution of global WAL traffic to MCP alone. [E8, E9]

## Descriptor footprint and write counters

These counts are for the named production `state.sqlite` inode path, excluding other databases and isolated tests. Main DB FDs include both RW and read-only handles; the parenthesized value is RW according to fdinfo's access bits. A WAL/SHM handle is not another database connection. SQLite can retain/reuse OS descriptors independently of connection objects, so do not label the sum “107 active writers.”

| Agent / server PID | Main DB FDs (RW) | WAL / SHM FDs | Sockets / pipes | Δ write calls | Δ written characters | Δ write bytes | Δ cancelled write bytes | Write bytes/s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A / 1836029 | 12 (11) | 10 / 1 | 4 / 0 | 1 | 69 | 0 | 0 | 0.0 |
| B / 1841633 | 4 (3) | 3 / 1 | 3 / 1 | 1 | 69 | 0 | 0 | 0.0 |
| C / 1955239 | 10 (9) | 8 / 1 | 3 / 1 | 1 | 69 | 0 | 0 | 0.0 |
| D / 2390906 | 12 (11) | 10 / 1 | 3 / 1 | 1 | 69 | 0 | 0 | 0.0 |
| E / 3322522 | 12 (11) | 10 / 1 | 3 / 1 | 1 | 69 | 0 | 0 | 0.0 |
| F / 3398721 | 12 (11) | 10 / 1 | 3 / 1 | 1 | 69 | 0 | 0 | 0.0 |
| G / 3412700 | 0 (0) | 0 / 0 | 3 / 1 | 1 | 69 | 0 | 0 | 0.0 |
| H / 3436517 | 10 (9) | 8 / 1 | 4 / 0 | 1 | 69 | 0 | 0 | 0.0 |
| I / 3456772 | 10 (9) | 9 / 1 | 3 / 1 | 1 | 69 | 0 | 0 | 0.0 |
| J / 3508772 | 16 (15) | 14 / 1 | 4 / 0 | 1 | 69 | 0 | 0 | 0.0 |
| K / 3511980 | 0 (0) | 0 / 0 | 3 / 1 | 1 | 69 | 0 | 0 | 0.0 |
| L / 3513445 | 0 (0) | 0 / 0 | 4 / 0 | 1 | 69 | 0 | 0 | 0.0 |
| M / 3523333 | 0 (0) | 0 / 0 | 3 / 1 | 1 | 69 | 0 | 0 | 0.0 |
| N / 3526366 | 0 (0) | 0 / 0 | 3 / 1 | 1 | 69 | 0 | 0 | 0.0 |
| O / 3528063 | 0 (0) | 0 / 0 | 3 / 1 | 1 | 69 | 0 | 0 | 0.0 |
| P / 3528872 | 0 (0) | 0 / 0 | 4 / 1 | 9 | 7043 | 0 | 0 | 0.0 |
| Q / 3529722 | 0 (0) | 0 / 0 | 3 / 1 | 1 | 69 | 0 | 0 | 0.0 |
| R / 3532242 | 0 (0) | 0 / 0 | 3 / 1 | 1 | 69 | 0 | 0 | 0.0 |
| S / 3534707 | 9 (8) | 8 / 1 | 4 / 0 | 779 | 2998217 | 3022848 | 2813952 | 100715.1 |

Server 3534707 grew from 9 main DB descriptors to 10 by the sample end. It read 290,713,084 characters in 68,662 read calls in the same interval. The counters do not identify the file being read or written. The other servers' small output mostly coincides with the launcher's protocol ping; server 3528872 additionally handled transport traffic while retaining no state DB descriptor. [E1]

All launchers had zero state DB/WAL/SHM descriptors. Their I/O was:

| Launcher PID | Δ write calls | Δ written characters | Δ write bytes | Write bytes/s |
|---|---:|---:|---:|---:|
| 1836012 | 1 | 209 | 4096 | 136.5 |
| 1841622 | 1 | 209 | 4096 | 136.5 |
| 1955218 | 1 | 209 | 4096 | 136.5 |
| 2390890 | 1 | 209 | 4096 | 136.5 |
| 3322511 | 1 | 209 | 4096 | 136.5 |
| 3398709 | 1 | 209 | 4096 | 136.5 |
| 3412689 | 1 | 209 | 4096 | 136.5 |
| 3436502 | 1 | 209 | 4096 | 136.5 |
| 3456761 | 1 | 209 | 4096 | 136.5 |
| 3508750 | 1 | 209 | 4096 | 136.5 |
| 3511968 | 1 | 209 | 4096 | 136.5 |
| 3513429 | 1 | 187 | 4096 | 136.5 |
| 3523305 | 1 | 209 | 4096 | 136.5 |
| 3526338 | 1 | 187 | 4096 | 136.5 |
| 3528046 | 1 | 209 | 4096 | 136.5 |
| 3528862 | 7 | 7770 | 16384 | 545.9 |
| 3529710 | 1 | 209 | 4096 | 136.5 |
| 3532232 | 1 | 187 | 4096 | 136.5 |
| 3534693 | 7 | 24562 | 16384 | 545.9 |

`syscw` counts write-family calls across files/pipes/sockets; `wchar` counts their bytes; `write_bytes` and `cancelled_write_bytes` are kernel I/O accounting, not committed SQLite bytes. Do not subtract cancelled bytes and call the difference a SQL rate. Launcher heartbeat JSON is written every 30 seconds and after protocol events (`bin/mcp-server.mjs:51,62`), explaining a separate file-write source. No collector read from a live stdin/stdout/socket: only symlink and fdinfo metadata was read. Stdout and stdin were UNIX sockets between launcher and child; Codex's agent-to-launcher link used pipes. Socket counts above include those IPC endpoints and any other held socket; they do not assert a live HTTP connection for each descriptor.

Retained recovery bindings add narrow attribution. In E4, server 1836029 had two historical `create_pipeline` and two `spawn_agent` claims; 3508772 had six `create_pipeline`, one `send_message` and one `spawn_agent`; 3534707 had four `create_pipeline`. Those totals extend beyond E1 and are subject to receipt retention. Only the single 3534707 claim fell inside E1. The remaining tools need not retain a binding owner, so an empty set is not a count of all writes. `server.ts:2698` records owner PID/start identity for recovery bindings; `:1777,1807` claim and settle them in `mcp-receipts.sqlite`, a different database.

## Journal observations

In E7 there were **3 lines containing `database is locked`**, also the same three `[state lease] abandoned` lines, first at **01:26:24.510595Z**, last at **01:33:49.131520Z**. Do not add these overlapping counts. There were zero literal `database is busy` or `state writer is busy during account commit` lines and **504 `[blocking-wait]` lines**, spanning **00:28:37.101381–05:11:48.425421Z**. None of these patterns appeared inside E1. Over the full 283.617-minute log window, that is 0.0106 locked lines/minute and 1.777 blocking-wait lines/minute.

All matching entries carry journal PID **2970622**, the supervisor that forwards output. That field cannot identify the originating MCP writer. Blocking-wait lines cover more than state DB locks; synchronous SQLite retries in `sqliteStateStore.ts:331,486` have different instrumentation from the lease wait recorder at `:2244`. These are log frequencies, not a complete SQL lock-wait frequency. They do not establish a calm 30-minute release window.

## Code paths that create contention

The direct path remains reachable from a stdio server:

`entry.ts → startViewerMcpServer → createProductionViewerMcpService(stdioReads=true) → local service → viewerMcpBindings → domain store → SqliteStateCollection`.

The branch at `src/lib/mcp/server.ts:4610` forwards just `VIEWER_LARGE_READS` when the process has a launch capability. The allowlist at `src/lib/mcp/largeReads.ts:16` covers fleet, conversation messages, resources, snapshots, pipelines, prototype reads, activity, transcript search and lifecycle events. Any other tool lazily constructs the local service at `server.ts:4625`, imports the domain bindings and opens the local receipt store at `:4645`. This is consistent with nine fresh/lightweight servers having zero state descriptors and older/domain-using servers retaining many. It is not proof of the exact call history of every process.

| MCP entry / binding | Persistence reached locally | Main references |
|---|---|---|
| `create_task` | `tasks`: task rows, create receipts, migration markers; linked-board tombstones when applicable | `src/lib/mcp/bindings.ts:2020,2038`; `src/lib/tasks/store.ts:264,624,748` |
| `update_task`, including `refine` | Same task collection; changes/revisions and companion rows | `bindings.ts:2071,2080,2097,2131`; `tasks/store.ts:716,728` |
| `link_task_to_pipeline` | Task assignments under task mutation admission | `bindings.ts:2540,2553` |
| `create_pipeline` | Pipeline creation service, creation admission/queue and pipeline records | `bindings.ts:2244,2257`; `src/lib/pipelines/store.ts` |
| `pipeline_action`, `stage_report` | Pipeline action/report commands, stage/attempt state; tick requested after report | `bindings.ts:2333,2474,2487`; production ports at `:1324,1326` |
| `flow_action` | Flow cancel/close/patch commands and `flows` | `bindings.ts:5498,5511`; `src/lib/flows/store.ts:282` |
| `request_attention`, dismissal/escalation | Attention requests, receipts and resolution state; some steps also dispatch to Viewer | `bindings.ts:6752,6831,6862,7110`; `src/lib/attention/store.ts:133` |
| `suggest_replies` | `reply_suggestions`, sets and admission receipts | `bindings.ts:7168,7201`; `src/lib/suggestions/store.ts:152` |
| `bridge_report` | `bridge_reports`, with channel state in `bridge_channels`; outbound transport is a separate step | `bindings.ts:3654`; `src/lib/bridge/store.ts:95,470,508,527` |
| `leave_lesson`, `curate_rules` | `role_memory` | `bindings.ts:2516,2528,7823`; `src/lib/memory/roleStore.ts:36,61` |
| Settings and administrative tools | Seat settings/release control, role presets/audit, account-project bindings and issue-preview files; these are additional persistence paths, not all `state.sqlite` | `bindings.ts:4456,4502,4739,4890,1916`; `src/lib/roles/store.ts:35,318` |
| Local MCP receipt service | `mcp-receipts.sqlite`: initialization/pruning, claim, settlement and recovery | `src/lib/mcp/server.ts:1747,1766,1777,1807,2698,4645` |
| Caller/policy/domain reads | Registry reads and cached domain collection handles; a “read” tool can instantiate RW collection handles even without a domain mutation | `bindings.ts:1125,1191,1319`; `sqliteStateStore.ts:1005` |

Already forwarded control operations include spawn, send, conversation actions/migration, prototype operations and most orchestrator/Telegram commands (`bindings.ts:1625,1683,5113,5263,6311,6350,7882`). They can still instantiate local policy/receipt machinery on the current path. Moving only task mutation calls leaves those costs and other local writers intact.

The handle and transaction mechanics explain the multiplier:

1. `SqliteStateCollection` retains a `readDb` field opened by `openDatabase` (`src/lib/state/sqliteStateStore.ts:998,1006`). That opens a RW database with schema/WAL initialization, including `BEGIN IMMEDIATE` (`:334,365,370`). The class has no normal disposal method. Collection caches, for example `taskCollections` (`tasks/store.ts:344`), retain these objects. A cold domain read can therefore contend during initialization.
2. A task mutation uses `writeTaskState → patchSync` (`tasks/store.ts:624,631`). Lease acquisition opens another connection, writes `state_leases` with PID/start identity, and commits (`sqliteStateStore.ts:2190,2204,2222`).
3. The domain commit opens a connection, validates authority and lease, writes `state_rows` and `state_changes`, advances `state_collections.revision`, and includes companion tombstones in that same commit (`:2053,2055,2081,2088,2097,2112`). These transient connections do close in `finally` (`:2123,2239`). The retained readers remain.
4. Release deletes the lease through another connection (`:78,2283`). A changed task with one collection therefore normally causes lease-acquire, domain-commit and lease-release write transactions, plus MCP receipt transactions in their own database. Companion leases add work. A no-op callback can still acquire and release a durable lease.
5. RW connection/transaction retries use synchronous `Atomics.wait` (`:343,501`); the separate state-DB lock lane owns that repair. Centralizing calls reduces independent competitors but does not by itself remove a blocking retry in the Viewer.

The MCP owner token is established before imports (`src/lib/mcp/entry.ts:6`). It authorizes state resolution; it is not a ban on ordinary domain writes. Startup migration ownership remains fenced by `assertStateStartupMutation` (`src/lib/stateOwnership.ts:331`). Do not solve connection initialization by giving an MCP process a Viewer owner token.

## Lifecycle assessment

The existing launcher has meaningful cleanup: `ownedChildren` includes displaced release children, `stopChild` ends stdin or sends the selected signal and escalates on a one-second timer, `shutdown` stops restarts/probes, and `finishShutdown` closes the launcher's own streams only after owned children exit (`bin/mcp-server.mjs:190,193,211,277`). EOF and SIGINT/SIGTERM invoke shutdown (`:431,460,463`). The bundled server separately closes on stdin EOF with a one-second exit bound (`src/lib/mcp/server.ts:4653,4664`).

Those mechanisms depend on EOF or a delivered shutdown event. There is no agent PID/start-identity watch in this launcher. If another descendant retains the writing end of the agent's stdio channel, agent death need not produce EOF. If the launcher itself is hard-killed, its signal handlers cannot clean up children; child EOF helps only when no other process holds the pipe. This is a lifecycle test/design obligation, not an observed production orphan in this audit.

Prior work already fixed held-open-stdin SIGTERM shutdown. The existing launcher test at `bin/mcp-server.test.ts:815` exercises that case; `:725,765` cover forwarding/escalation. The server test at `src/lib/mcp/stdio.integration.test.ts:140` deliberately ends the parent pipe. Neither that test nor a static handler review proves actual owner death with inherited descriptors. Existing tests were inspected, not run against production.

## Fix design

**Make the managed stdio process a transport adapter before any domain or receipt import.** Extend the existing forwarding seam at `server.ts:4610` to the entire managed tool surface, carrying the original arguments, client request key, deadline, cancellation and native-work metadata to `/api/mcp`. `src/lib/mcp/http.ts:55` already caches one production service per Viewer; `:128` authenticates the presented capability, resolves the conversation and constructs request-scoped caller context. Preserve that service and the existing bindings as the command implementation.

The adapter's target is **zero direct handles to state, registry, receipt, memory and search databases**, both idle and during calls. It may retain its stdio endpoints and a bounded HTTP transport. A failed Viewer request must never fall back to local mutation. Return the existing retry/unknown disposition, and use the original key after a dropped response. Do not claim success before durable settlement. Forwarding must precede local policy/receipt creation, or even forwarded tools will keep local handles.

Preserve the transactional boundary: task-create receipt and task row together, linked task/tombstone writes together, expected revision/project checks, caller/seat/pipeline fences, maintenance guards, and existing cross-process recovery semantics. The task-create receipt is in the task collection; the global MCP recovery receipt remains in its separate database. The shared receipt store must claim once, not once in the adapter and again in the Viewer. Keep authority checks ahead of replay disclosure. Route through the full MCP service rather than rebuilding each operation as an unguarded generic task HTTP request. Batch only independent observations where a documented coalescing rule exists; never combine unrelated request keys or discard a requested state transition.

For managed agents, prefer native HTTP transport after the existing admission check succeeds. `src/lib/agent/spawnPolicy.ts:179` requires a usable launch capability and HTTP admission; `:154` documents that transport selection affects new spawns. This reduces the normal per-agent launcher/server process count from two to zero. Existing agents can use the stateless stdio bridge until their normal lifecycle ends; do not restart them to make the graph look smaller. Recorded transport in the launch receipt remains the source of truth.

Exercise the real engine configuration path when changing that default. The current Codex host passes the launch transport into `headlessCodexThreadConfig` (`src/lib/runtime/codexAppServerHost.ts:1557`), and `scripts/install-mcp.sh:88` handles registered Viewer tables. Earlier transport work reported incompatible inherited command/URL configurations; verify supported current engines with both existing and fresh account configuration before enabling HTTP by default. Do not infer that a flag changed an already-running agent.

Legacy/native clients that authenticate only through ancestry require explicit compatibility work. Current HTTP rejects an unknown/missing capability (`http.ts:136`), and current stdio derives ancestry locally (`bindings.ts:1191`). Reuse that authority model in an authenticated local admission handshake, binding the MCP peer and agent PID/start identities before issuing a scoped forwarding credential. The Viewer must independently validate the peer and its ancestry; accepting a client-supplied conversation ID would weaken the boundary. Until that path is implemented and exercised, native callers must retain their supported behavior. Any temporary local database access must be explicit, bounded, opened read-only for reads, and disposed after the operation; the all-client zero-local-write claim cannot be made while this compatibility path still writes.

For any retained direct store adapter, provide explicit acquire/release ownership and connection accounting. Use a process-wide bounded connection owner per database instead of one unbounded cache-held RW handle per collection. Reads use readonly/query-only connections. Writer transactions and companion collection operations share the same acquired writer; serialize its use so unrelated requests cannot interleave BEGIN/COMMIT or close a peer's connection. Bound idle lifetime and close on service shutdown. Coordinate this work with the state-DB lock lane and PR #2905 before editing `sqliteStateStore.ts`; first remove the managed MCP import path so pool work does not become a prerequisite for that reduction.

Tie both launcher and bundle to the **actual agent's PID plus start identity**. Use the established platform containment/owner mechanism where available, with an independent guardian on platforms needing it; a child-only timer cannot enforce cleanup after its own hard death. Verify ownership before any cleanup signal. Cover a native launch, Claude broker, Codex app-server and Copilot launch, bundle startup failure, normal EOF, agent termination/hard death, launcher termination/hard death, protocol timeout, and release replacement while old and new children overlap. A keeper process that inherits stdin must be part of the owner-death cases. All these are isolated fixtures; the seat alone decides any production cleanup.

## Before/after method

No candidate implementation or synthetic A/B result is produced by this audit. The following is the builder/reviewer measurement contract accepted in the decision continuation. Instrumentation runs only in isolated fixture processes. The production census retains its original UTC bounds; finishing this document does not refresh that census.

1. Export the pinned baseline and candidate commits to separate scratch checkouts. Baseline for this audit is main `45d25ac`; its relevant code equals production `781ecd4`. When parallel fixes land, record the new merge base and run an additional matched baseline if needed. Hold Bun binary/version, kernel, CPU/memory quota, data, client schedule and measurement boundaries identical. Record both the immediate cold-open interval and a warm interval after scheduled initialization has settled.
2. Extend the existing `src/lib/mcp/stdio.integration.test.ts`, `src/lib/mcp/largeReads.test.ts`, `bin/mcp-server.test.ts` and the existing concurrency fixture `src/lib/mcp/writerConcurrencyChild.ts`. Do not create a per-issue one-shot driver. Use synthetic data seeded once and cloned for each run: for example 1,000 tasks with linked tombstones plus 900 inert pipeline records. Publish the seed, checksum, exact row counts and request schedule. No production data is necessary.
3. Run 1, 19 and 37 simultaneous logical clients as separate load points, **three repeats each**, alternating baseline/candidate order. Use 30 seconds warmup and five minutes measurement at one scheduled request/client/second. Define 60% task reads, 30% task updates and 10% task creates; use deterministic task IDs/keys. Include independent-task writes and a separate shared-task contention case. Record offered/completed/failed/pending calls so slower admission cannot masquerade as lower contention. Use the same protocol mix on both revisions; compare native HTTP as a separate deployment mode.
4. Compare observed logical results and final row content/revisions, normalized only for declared timestamps and generated IDs. Include same-key replay, changed-payload conflict, expected-revision conflict, concurrent creates, linked tombstones, response lost after admission and after commit, Viewer succession, store busy before admission, and cancellation after dispatch. There must be no duplicate side effect, lost update, false not-executed verdict or receipt disclosure to another caller. Replays must use the original key.
5. Instrument every **synthetic** process before its first database import, using the same observer on both revisions. Count successful connection opens, closes, current/peak live connections and each connection's lifetime; include initialization, readonly handles, transient writers and reopened handles. Give every handle an observer ID tied to PID/start identity and database. Instrument successful durable lease acquisition/release and successful transaction boundaries. Count transaction attempts, commits, rollbacks, changed rows, busy returns/retries/refusals and measured wait time by process, database and collection. Keep receipt DB transactions separate. Measure lease holds from the actual committed acquisition through release, including time while an awaited continuation is delayed. The exact event definitions and observer controls below are required before calling a measurement complete.
6. Sample all owned process PID/start identities and main DB/WAL/SHM descriptors at startup, peak, idle, release replacement and teardown. Include syscall/file-byte attribution in the isolated harness if needed. Publish max and final descriptors, peak processes, births/removals, lock-wait counts per 10,000 completed calls, p50/p95/p99/max latency, Viewer event-loop delay, CPU, RSS and collector overhead. Sum Viewer and adapter costs so moving work does not hide it.
7. Acceptance: every managed adapter has zero direct DB descriptors/writes, healthy HTTP clients create no per-agent MCP OS process, any compatibility pool stays within its declared cap and closes at idle/teardown, and owner-death cases leave no owned descendant or DB descriptor after the bounded shutdown budget. Use an explicit three-second fixture bound for the normal one-second escalation stages; record any platform-specific contract separately. Correctness must be identical and the matched contention metrics must decrease without reducing completed work or worsening the Viewer loop.
8. Run real owner-death and every launch/stop path under the required owned runner, with stub agent binaries, no real CLI discovery or provider calls. Each explicit test path gets a fresh `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` under `/tmp`; default `LLV_VIEWER_CONTROL_URL` points to a verified closed loopback port. Only a fixture explicitly exercising control transport substitutes its own port-0 listener. The prescribed invocation is `bash "$GATE" bun test <explicit-test-file>`, where `GATE` is the release's `scripts/gate-slot.sh` supplied by the stage. Run heavy checks one at a time. The runner owns fixture descendants; never signal production.
9. Run the local path-scoped privacy gate and touched tests, then required CI `privacy-publication`, `privacy-tracker-audit`, and `runtime-gate` when a code PR exists. A later release still needs its own calm 30-minute production window. This short, changing-load census does not supply that acceptance.

### Exact SQL measurements in the isolated harness

Collect the following for every process, including the Viewer, adapters and fixture workers. Each record names the full source revision, repeat, load point, phase, process role, PID/start identity and database. Preserve raw events and observation duration so rates can be recomputed. A transaction touching several collections is counted once in the database total; collection attribution can be many-to-one.

| Metric | Required event and accounting |
|---|---|
| Connections | Record each successful underlying SQLite open and completed close, including replacement opens behind `openCurrentDatabase`. Track total opened/closed, current live, peak live, RO/RW mode and lifetime distribution. A cached wrapper, collection object or FD is insufficient as the connection identity. Record failed opens separately. Report handles reclaimed by process exit separately from explicit closes. |
| Commits | Count each successfully completed transaction commit, with BEGIN attempt/success, rollback and failed commit as separate outcomes. Include implicit autocommit writes and transaction-wrapper commits; a SQL-text search for `COMMIT` alone is insufficient. Separate schema/startup, lease acquisition, domain change, lease release and MCP receipt work. Count successful transactions with zero changed rows separately. Keep observer output outside all measured databases. |
| SQL lock contention | Count SQLite BUSY/LOCKED results, calls that encounter contention, retry attempts and terminal refusals separately. Measure actual SQLite busy-handler wait intervals and application retry waits with monotonic timestamps; retain wait duration and call/connection attribution. Preserve the production timeout/retry policy on both revisions. Receipt connections currently use a 5,000 ms SQLite busy timeout (`src/lib/mcp/server.ts:1757`), while state connections use zero (`src/lib/state/sqliteStateStore.ts:338`), so application-visible exceptions alone miss receipt waits that later succeed. |
| Durable collection leases | Record a held-lease refusal independently of a SQLite busy result, every lease retry/wait, successful committed acquisition and committed release. Report acquisition latency and hold duration separately from SQLite lock waits. Include delayed continuations after acquisition. |
| Rates and reconciliation | Publish commits/s and connections opened/s over the exact measured interval, plus contention events and affected calls per 10,000 completed calls. Also retain offered/completed/failed/pending counts and a bounded drain result. Reconcile open/close/exit balances and final rows/receipts. Sum process totals by database without counting WAL/SHM descriptors as additional connections. |

Use observer hooks at the actual connection, commit and busy-wait boundaries. Where the application cannot expose SQLite-internal events, instrument the isolated runtime's SQLite implementation and run the same instrumented runtime for baseline and candidate. Preserve and record its source/build identity and timeout behavior. Statement elapsed time includes SQL work and scheduling; it cannot stand in for exact lock-wait time. A missing internal observation is an incomplete harness measurement and must be resolved before the build/review claims the exact SQL comparison.

Before the load runs, validate the observer against a small deterministic fixture: two open handles, an explicit close and a replacement open; one successful explicit transaction; one autocommit write; one rolled-back transaction; a lock held by another owned process that first causes waiting and later permits success; and a separate timeout/refusal. Include a durable lease held without a SQLite transaction to prove that lease waits and SQL waits stay distinct. Verify expected counts and that successful waits are observed, then measure observer overhead with it enabled and disabled on the same fixture. These controls run only against synthetic databases.

Keep cold initialization, warm steady load, draining and lifecycle faults as separate phases. Use an externally scheduled, deterministic offered load; retain queue delay and pending work when a client cannot keep pace. For the shared-task case, record optimistic-revision conflicts as intended logical outcomes and compare their handling. Report each repeat, partial run and failure. The build handoff must include both exact SQL totals and the comparable OS census, final-state equivalence, and owner-death outcomes. A lower adapter count alone does not satisfy the contention acceptance.

## Reproduction queries

E3 performs the following SELECT with the SHA-256 of the process capability as a bound parameter, without emitting either credential or digest:

```sql
SELECT value_json FROM registry_rows
WHERE collection = 'receipts'
  AND json_extract(value_json, '$.spawnCapabilityDigest') = ?;
```

Only the whitelisted engine/role/conversation/transport/state/createdAt fields are retained for attribution. Receipt identities are joined to the kernel ancestry; receipt age is not used as an orphan detector.

E4 uses:

```sql
SELECT receipt_key, claimed_at, binding_json, result_json IS NOT NULL
FROM mcp_receipts
WHERE claimed_at BETWEEN 1792041044427 AND 1792041074442;
```

Inspect only the tool prefix and owner PID/start identity, never request bodies, capabilities or message content. The same connection runs:

```sql
SELECT json_extract(binding_json, '$.toolName'), count(*),
       min(claimed_at), max(claimed_at)
FROM mcp_receipts
WHERE json_extract(binding_json, '$.owner.pid') = ?
GROUP BY json_extract(binding_json, '$.toolName');
```

E6 uses `sqlite3.connect("file:" + filename + "?mode=ro", uri=True)` and query-only mode; it bypasses the application's normalization/open ledger:

```sql
SELECT e.id, e.title, e.summary, e.body, e.sourcePath, e.project
FROM memory_fts JOIN memory_entries e ON e.id = memory_fts.id
WHERE memory_fts MATCH ?
ORDER BY bm25(memory_fts) LIMIT 3;
```

Memory results were read directly by returned ID/source. The native and desktop archives identified the prior stdio recovery work. No current production orphan conclusion was inherited from them.

E7 streams the journal command in the ledger and counts literal substrings `database is locked`, `database is busy`, `state writer is busy during account commit`, `[state lease] abandoned`, `[blocking-wait]`. Convert `__REALTIME_TIMESTAMP` from microseconds to UTC, retain first/last timestamps and journal PID, and separately restrict the counters to E1's bounds. Do not print raw message bodies.

E1's exact collector follows. It prints metadata only; the environment is read to select the state root, and no credential is printed. It does not open any application database. Its stdout was retained in the audit session and reduced into the tables above.

```python
import os,time,json,datetime,collections
utc=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
hz=os.sysconf('SC_CLK_TCK')
boot=int(next(l.split()[1] for l in open('/proc/stat') if l.startswith('btime ')))
def info(pid):
 s=open(f'/proc/{pid}/stat').read().rsplit(')',1)[1].split()
 a=[x.decode(errors='replace') for x in open(f'/proc/{pid}/cmdline','rb').read().split(b'\0') if x]
 return {'pid':pid,'ppid':int(s[1]),'ticks':int(s[19]),'state':s[0],'start':datetime.datetime.fromtimestamp(boot+int(s[19])/hz,datetime.timezone.utc).isoformat(),'args':a}
def fds(pid):
 out=[]
 for f in os.listdir(f'/proc/{pid}/fd'):
  try:
   target=os.readlink(f'/proc/{pid}/fd/{f}')
   mode=int(next(l.split()[1] for l in open(f'/proc/{pid}/fdinfo/{f}') if l.startswith('flags:')),8)&3
   out.append((int(f),target,mode))
  except OSError:pass
 return out
def io(pid):
 return {k:int(v) for k,v in (l.split(':') for l in open(f'/proc/{pid}/io'))}
pmap={}
for n in os.listdir('/proc'):
 if n.isdigit():
  try:pmap[int(n)]=info(int(n))
  except OSError:pass
rows=[]; live_db=None
for p,i in pmap.items():
 a=i['args']
 if len(a)<2 or not (a[1].endswith('/mcp-server.mjs') or a[1].endswith('/src/lib/mcp/entry.ts')):continue
 e=dict(x.split(b'=',1) for x in open(f'/proc/{p}/environ','rb').read().split(b'\0') if b'=' in x)
 state=e.get(b'LLV_STATE_DIR',b'').decode()
 production=state.endswith('/.config/delegatus/state') or state.endswith('/.config/agent-log-viewer/state')
 if not production:continue
 live_db=state+'/state.sqlite'
 fs=fds(p);chain=[]; q=i['ppid']
 for _ in range(8):
  x=pmap.get(q)
  if not x:break
  chain.append({'pid':q,'ppid':x['ppid'],'start':x['start'],'cmd':os.path.basename(x['args'][0]) if x['args'] else '?','zombie':x['state']=='Z'})
  q=x['ppid']
  if q<1:break
 role='launcher' if '/bin/' in a[1] else 'server'
 owner=next((x for x in chain if x['cmd'] in ['claude','codex','copilot']),None)
 cwd=os.readlink(f'/proc/{p}/cwd')
 row={k:i[k] for k in ['pid','ppid','ticks','state','start']}
 row.update(role=role,owner=owner,chain=chain,release=cwd.split('/releases/')[-1] if '/releases/' in cwd else None,
   db=sum(t==live_db for _,t,m in fs),db_rw=sum(t==live_db and m==2 for _,t,m in fs),
   wal=sum(t==live_db+'-wal' for _,t,m in fs),shm=sum(t==live_db+'-shm' for _,t,m in fs),
   sockets=sum(t.startswith('socket:') for _,t,m in fs),pipes=sum(t.startswith('pipe:') for _,t,m in fs),
   stdio=[(f,t) for f,t,m in fs if f in (0,1)],io=io(p))
 rows.append(row)
begin=utc(); t0=time.monotonic(); prev=None;changes=0;timestamps=[]
while time.monotonic()-t0 < 30:
 try:
  s=os.stat(live_db+'-wal');now=(s.st_ino,s.st_size,s.st_mtime_ns)
  if prev is not None and now!=prev:changes+=1;timestamps.append(round(time.monotonic()-t0,3))
  prev=now
 except OSError:pass
 time.sleep(.25)
end=utc();elapsed=time.monotonic()-t0
for r in rows:
 try:
  i=info(r['pid'])
  if i['ticks']!=r['ticks']:r['exit']='reused';continue
  latest=io(r['pid']);r['delta']={k:latest[k]-r['io'][k] for k in latest};del r['io']
  fs=fds(r['pid']);r['db_end']=sum(t==live_db for _,t,m in fs)
 except OSError:r['exit']='gone'
print(json.dumps({'begin':begin,'end':end,'elapsed':elapsed,'wal_metadata_changes':changes,'wal_sample_times':timestamps,'rows':rows},separators=(',',':')))
```

For E8, rescan all procfs PIDs and descriptor symlinks using the same accessors, accept the exact MCP entry suffix at any argument position for Bun/Node, classify only the production state root, and compare `(pid,start_ticks)` sets. Count non-MCP holders separately. Access denials and process disappearance must be recorded, not silently interpreted as zero.

## Verification of this artifact

Documentation-only stage: no source, configuration or runtime change and no new test behavior. Existing lifecycle/concurrency test paths were reviewed; runtime tests and CI were not run for this audit. The continuation preserves the accepted passive evidence and completes the measurement method. No production tracing, signal or cleanup was performed.

At **05:21:06.615–05:21:07.790Z**, the local privacy gate passed with exit 0. The command was `bun "$SCRATCH/scripts/privacy-publication-gate.ts" --repository "$WORKTREE" --require-known-values --paths docs/perf/mcp-state-writers.md`, run from a fresh `git archive HEAD` export under `/tmp`, with isolated HOME/config/temp/state and the export's committed fingerprint file. No dependencies were installed. At **05:22:19Z**, a direct Python read of the new file found zero trailing-whitespace lines and 19 rows in each server table; `git status --short --untracked-files=all --ignored` showed only this declared output. `git diff --check` was also clean; the direct file check covers the untracked document that Git's diff does not include. The rerun at **05:23:11.783–05:23:12.044Z** also passed. Final continuation checks are recorded below.

At **05:32:38.134–05:32:38.320Z**, the same privacy command passed with exit 0 after the accepted-boundary and exact-SQL-method edits, from another fresh scratch export with isolated HOME/config/cache/temp/state and a disabled production control target. The complete check ran **05:32:37.639–05:32:38.347Z** using `rtk proxy python3 -B -`: it exported HEAD, ran the gate, directly checked the untracked Markdown for trailing whitespace and final newline, and reconciled both 19-row process tables and the 107 total / 97 RW main-DB descriptor counts. `git diff --check` passed; `git status --short --untracked-files=all --ignored` listed only `docs/perf/mcp-state-writers.md`. The script removed only its own recorded scratch directory. The document remains uncommitted for engine collection.

## Implementation and isolated rehearsal (2026-10-15)

The implementation routes ordinary stdio calls through the Viewer's full MCP
service before importing local policy, bindings or receipt storage. The adapter
has at most 32 calls in flight and opens no application SQLite database. It
forwards arguments, the original request key, native-work metadata, cancellation
and the remaining deadline. A transport failure during a mutation returns an
unknown outcome and original-key recovery instructions. The admitted candidate
health probe retains its existing local service.

New managed launches prefer HTTP after the existing capability and endpoint
admission checks. Existing Codex command registrations retain stdio; their
launch receipts record the host's effective transport. The installer removes
managed Codex registrations by default so new threads can supply their admitted
transport. Explicit stdio and operator-owned registrations remain supported.

Linux native calls prove their socket peer to the Viewer with SO_PEERCRED and a
per-call nonce/body challenge. The listener uses the Linux abstract socket
namespace: the host and Viewer container share network and PID namespaces,
while their temporary filesystems differ. The Viewer checks the peer's UID and
PID/start/boot identity, then applies the existing native session proof and
operator approval checks. An HTTP caller never inherits an ambient Viewer
capability. Other platforms retain unidentified caller authority through the
existing authenticated MCP service marker.

The launcher watches the invoking agent's identity. On Linux, its Bun child
arms a kernel parent-death signal before application imports and rechecks the
launcher identity to close the startup race. The same mechanism covers the
normal adapter and native hook. Real tests hard-kill both owners and launchers
while another process retains stdin; launcher-death cases also stop the child
before killing its launcher. The Linux fixture budget is three seconds. Other
platforms retain EOF, signal and parent-change handling; this rehearsal makes
no kernel containment claim for them.

The first long comparison exposed request bursts starving Viewer timers. The
follow-up implementation starts one MCP request per timer turn while allowing
awaited operations to remain concurrent. Caller context survives the wait.
Ordinary task edits avoid a maintenance-only pipeline scan. Each synchronous
task page reads pipeline links from one refreshed selection generation; a later
page refreshes again and observes deletions and reassignment. Task decoding and
commit preparation reuse the existing project-alias resolver within each
synchronous row pass; a later pass refreshes its alias snapshot. These changes
leave the Viewer database lock implementation and the snapshot, heap and board
polling lanes untouched.

### Measurement implementation

The existing `scripts/mcp-call-cost-benchmark.ts` entry accepts
`--state-writer-sample` and `--state-writer-report`. Its fixture code is in
`scripts/mcp-state-writer-benchmark.ts`, reached by the existing
`src/lib/mcp/writerConcurrencyChild.ts`. A private PID namespace contains the
real launcher, source MCP entry and real Viewer MCP service. Each sample copies
one isolated seed and uses a port-0 Viewer. No provider CLI is invoked.

The seed has 1,000 workload tasks, 37 launch-membership tasks, 900 inert pipeline
records and 100 task tombstones. The two task groups belong to separate
projects. Thirty-seven workload cards are shown; the remaining workload cards
and new creates are hidden. The schedule offers one call per client per second:
six task-list calls, three updates and one create in each ten-second cycle.
A shared-task mode supplies expected project and revision guards. HTTP is a
separate transport mode. Raw call results, final rows, process census and SQL
events remain in each isolated sample directory.

`scripts/sqlite-observer.ts` loads `scripts/sqlite-observer.c` into every fixture
SQLite connection. The native extension observes commit/rollback hooks, actual
connection destruction and the existing VFS sleep implementation. It preserves
the runtime's busy policy and reports successful waits as well as refusals.
JavaScript instrumentation records failed opens, BUSY/LOCKED exceptions,
application waits and durable lease attempts. Observer output is external to
the measured databases. Explicit closes and handles reclaimed by process exit
are separate; in-memory index transactions and receipt transactions have their
own database totals. The report streams raw SQL events to bound analysis memory.

Observer controls cover replacement opens, readonly handles, explicit, empty
and autocommit transactions, rollback, a successful SQLite wait, a refusal and
a durable lease held across an awaited delay. The controls also run three
alternating enabled/disabled overhead pairs. A Viewer that cannot emit its
final loop sample has incomplete loop coverage; the report retains that fact
instead of reporting its last earlier histogram as a complete window.

### Verification record

The explicit isolated test runs have passed the packaged MCP suite (50 tests),
forwarding suite (12), Claude broker suite (122) and structured-spawn integration
suite (141). The launcher suite passed 25 tests with one platform skip, including
eight owner/launcher hard-death cases under Node and Bun. The observed owner
shutdowns were at most 1.32 seconds; stopped-child launcher-death cases were at
most 150 ms. Earlier isolated runs also passed transport selection, installation,
Codex configuration, Copilot configuration, HTTP cancellation, state ownership
and concurrent-writer/observer controls. Task list-view, SQLite persistence,
legacy persistence, revision and linked-task suites passed after alias batching.
TypeScript and the MCP bundle build passed before the final request-burst
changes; the final publication checks are recorded in the pull request. The
local path-scoped privacy gate passed before the final evidence update.

The repository-wide child census currently fails two assertions on both the
branch and its matched main export. The branch adds ownership rows for its new
fixture entry points. The historical missing rows and signal sites are retained
in the comparison logs.

### Diagnostic before/after results

**Performance acceptance is not met.** These are single diagnostic samples,
with 30 seconds warmup and 300 seconds measured load, using Bun 1.4.0 and the
same cloned synthetic seed. The matched baseline is the main implementation
merged at `df5d675c1` (main parent `77fc690ea`). The candidate is the working-tree
implementation described above, before publication; these samples do not attest
a later main merge or constitute the three-repeat matrix. Seed checksum:
`9991cbf2821d4057e636b16630152b120c96819cf5ee03fbf983b3ca99726e23`.

| Metric | 1 client before | 1 client after | 37 clients before | 37 clients after |
|---|---:|---:|---:|---:|
| Offered / completed responses | 300 / 300 | 300 / 300 | 11,100 / 11,100 | 11,100 / 11,100 |
| Successful / failed responses | 300 / 0 | 300 / 0 | 1,069 / 10,031 | 10,236 / 864 |
| Pending at window end / after drain | 0 / 0 | 0 / 0 | 811 / 0 | 1,032 / 0 |
| Peak processes, including Viewer | 3 | 3 | 75 | 75 |
| Process births / teardown survivors | 3 / 0 | 3 / 0 | 410 / 0 | 75 / 0 |
| Peak adapter main-DB descriptors | 5 | 0 | 191 | 0 |
| Peak total main-DB descriptors | 5 | 5 | 191 | 5 |
| Measured state.sqlite connection opens | 10,260 | 1,440 | 112,409 | 42,303 |
| Measured state.sqlite commits | 480 | 480 | 3,479 | 13,404 |
| SQLite BUSY/LOCKED results | 0 | 0 | 299,968 | 0 |
| Held collection-lease refusals | 0 | 0 | 184,922 | 0 |
| Measured SQLite busy-handler wait, ms | 0 | 0 | 9,819.0 | 0 |
| Application synchronous retry wait, ms | 0 | 0 | 4,397,659.5 | 0 |
| Calls with observed SQL contention / 10,000 responses | 0 | 0 | 999.1 | 0 |
| Call latency p50 / p95 / p99 / max, ms | 44.8 / 84.8 / 98.7 / 117.7 | 29.3 / 71.0 / 81.9 / 141.6 | 13,412.9 / 40,338.2 / 50,967.8 / 56,983.0 | 18,663.7 / 30,017.9 / 30,032.0 / 30,080.3 |
| Viewer loop p50 / p95 / p99 / max, ms | 0.073 / 0.096 / 0.833 / 5.594 | 0.077 / 0.156 / 6.558 / 117.621 | 2.554 / 30.081 / 66.421 / 270.017 | 9.535 / 83.231 / 154.010 / 382.036 |

Both transports in this table are stdio. Forwarding therefore retains the
launcher/server pair while eliminating adapter database opens entirely. The
HTTP default's process reduction is covered by launch configuration tests; its
separate full-load comparison remains outstanding. State commits cover the
shared database across processes and exclude registry, receipt and in-memory
index commits. More successful mutations account for the higher 37-client
candidate commit count. Wait totals sum concurrent processes; they can exceed
wall-clock duration. SQL contention frequency excludes independent held-lease
refusals, listed separately.

All four loop windows emitted their end sample. The 37-client candidate reset
its histogram 140 ms late; that boundary skew remains part of the diagnostic
record. Its failed responses were unknown-outcome timeouts, requiring original
key recovery. Client drain reached zero and the final observer recorded no
unfinished Viewer calls. The one-client run removes the contention explanation:
forwarding moves synchronous task work onto the Viewer and increases its loop
maximum even at one call per second. Profiling found task decoding and commit
preparation among those synchronous costs. The fenced Viewer lock layer was
left unchanged.

The one-client pair's 330 responses, including warmup, and 2,103 final durable
rows matched. Normalization maps generated create IDs through their original
request keys, revision tokens through the mutation that returned them, and
sample timestamps to one marker. It retains every stored numeric row revision,
all field content, task-create receipts and tombstones. The normalized final-row
SHA-256 is `bec216252d9f39f9fe068fd1d23d9898fd4bcb58087376a418df7ce481c6ddcc`;
normalized response SHA-256 is
`962fa796d9bd94894e6000fec0b682cab3338958a01dd9a17b03a6ae1a2077c2`.
This equivalence result applies to that pair alone.

Earlier failed 37-client variants remain part of the record:

| Diagnostic candidate | Successful / failed responses | Viewer loop result |
|---|---:|---|
| Initial forwarding | 1,467 / 9,633 | Incomplete: 253.830 seconds of tail missing; last observed maximum 28,765.8 ms |
| Dispatch turns and batched page links | 2,771 / 8,329 | Complete window; maximum 530.974 ms |
| Additional alias batching, table above | 10,236 / 864 | Complete window; maximum 382.036 ms |

The original audit revision, three alternating repeats at 1/19/37 clients,
shared-task load, HTTP mode, and final-state reconciliation under timed-out
calls remain outstanding. The loop regression must be resolved before those
runs can establish acceptance. The earlier diagnostic exports were updated
between variants and do not provide an immutable source manifest for each
variant. A final accepted comparison must export committed revisions and save
the source, observer, runtime and quota identities with every sample.

### Resumed comparison on merged main

The interrupted candidate at `4f66016bd` never wrote a summary or final rows.
Its last loop observation missed 172.147 seconds of the scheduled window; that
sample remains incomplete. It is excluded from the following comparison.

Fresh immutable exports compare main `8f2db43e573e446bc9079d8da648b79040f8b8f7`
with candidate `a8dd7b1b49df9ba2340c53e507192d916921dd8c`, which merges that
main revision. Both include the landed lock-wait, snapshot and heap changes.
The same observer and harness ran against the same seed described above, under
Bun 1.4.0, a three-core CPU quota and an 8 GiB memory cap. Each used one stdio
client, 30 seconds warmup and 300 seconds measurement. The complete aggregate,
source/archive/observer/runtime hashes, per-process connection lifetimes, cold
and warm phase counters, and row/response checksums are in
[`evidence/mcp-state-writers.json`](../../evidence/mcp-state-writers.json).

| Metric | Before | After |
|---|---:|---:|
| Offered / completed / successful measured calls | 300 / 300 / 300 | 300 / 300 / 300 |
| Failed / pending at end / pending after drain | 0 / 0 / 0 | 0 / 0 / 0 |
| Peak processes including Viewer / teardown survivors | 3 / 0 | 3 / 0 |
| Peak adapter state.sqlite descriptors | 5 | 0 |
| Peak total state.sqlite descriptors / after teardown | 5 / 0 | 5 / 0 |
| Measured state.sqlite opens / explicit closes | 10,260 / 10,260 | 1,440 / 1,440 |
| Measured state.sqlite commits / commits per second | 570 / 1.90 | 480 / 1.60 |
| Measured state.sqlite opens per second | 34.20 | 4.80 |
| SQLite BUSY/LOCKED results / held-lease refusals | 0 / 0 | 0 / 0 |
| SQL contention calls per 10,000 completed calls | 0 | 0 |
| SQLite busy wait / application synchronous wait, ms | 0 / 0 | 0 / 0 |
| Call latency p50 / p95 / p99 / max, ms | 44.867 / 96.499 / 122.425 / 205.487 | 22.656 / 52.265 / 64.837 / 81.359 |
| Viewer loop p50 / p95 / p99 / max, ms | 0.075 / 0.155 / 1.005 / 5.042 | 0.075 / 0.174 / 4.063 / 68.555 |
| Viewer measured CPU, seconds | 2.711 | 12.852 |
| Total sampled process CPU, ticks (lower bound) | 2,149 | 1,483 |
| Peak sampled total RSS, pages | 105,154 | 85,747 |

The candidate opened no adapter database of any kind. Its Viewer retained the
shared connections. Both loop windows completed; their reset delays were 1 ms
and 0 ms respectively. The 90 fewer state commits are the baseline's empty
pipeline transactions during ordinary task edits: task commits remained 480
on each side, with 660 observed changed rows each. Registry, MCP receipts and
in-memory index transactions remain separately accounted in the JSON artifact.
All explicit-close, process-exit and surviving-handle balances reconcile.

All 330 responses including warmup and all 2,103 final durable rows matched
after the previously declared timestamp/generated-ID normalization. Numeric
row revisions, task-create receipts and tombstones were retained. The final-row
SHA-256 is `823120f2466be96ec02cdc2acb8c91fc3d00ea278b8c2db717831ddeb2fc3b54`;
the response SHA-256 is
`05f6b520ab8bfa5d625e42b223a8da1918261c85a0300fe373a1a4b1abd30cb6`.

**This historical candidate failed performance acceptance.** Its lower call latency and connection
count coexisted with a Viewer loop regression at a load with no SQL contention.
In that candidate, `mutateTasksAsync` yielded while waiting for admission, then called synchronous
`mutateTasks`; `writeTaskState`, `stateFromBody` and `committedRows` decoded
and prepared the task collection on the Viewer thread. Timer-turn dispatch
cannot interrupt an individual synchronous mutation. The SQLite lock layer,
heap, snapshot and board-poll implementations remain untouched by this lane.
At this checkpoint the original-audit comparison, three alternating repeats at 1/19/37 clients,
shared-task and HTTP load modes, and timed-out-call final-state reconciliation
were outstanding. The [collected matrix](#acceptance-matrix-with-bounded-task-execution) below supplies every cohort record for the later executor and documents the remaining coverage gaps.

Recovery verification rebuilt the MCP bundle and passed the launcher suite
(25 tests, one native-CLI skip), forwarding (12), HTTP (13), and TypeScript.
All eight Node/Bun owner/launcher hard-death cases passed again; the slowest
whole owner-death case took 1.28 seconds. The packaged suite passed 50 cases
and exposed a stale assertion in its new contention case: the wait logger
records `state.lease.sqlite` after deferral, while the assertion expected the
outer `tasks.mutation` label. The repaired test waits for the actual in-flight
SQLite wait before releasing its blocker, requires asynchronous completion,
and preserves all 80 ordered edits and same-key replays. It passed three fresh
isolated repetitions. The diagnostic reader now uses an explicit stream reader
accepted by the project's TypeScript configuration. These fixture-only changes
leave the measured product implementation unchanged.

The local privacy gate passed for the changed paths, commits, aggregate evidence
and draft PR text. Final publication-gate and hosted check results belong to the
PR record.


### Executor and protocol setup for the acceptance matrix

Task tools now run in one Viewer-owned executor through a private pipe. The
executor runs the existing full service: policy, caller resolution, durable MCP
receipts, task revisions and task/tombstone commits stay together. The Viewer
sends the authenticated capability or native peer, original arguments and key,
native-work metadata, deadline and cancellation. Other tools retain their
existing service. The executor uses the `mcp` owner token with an explicit state
directory and performs no independent startup migration.

HTTP capability lookup also runs in that executor, reading the current registry
for each request. External rotation and staged handover stay visible without an
authorization cache. The full tool policy still rechecks caller authority before
receipt replay and mutation. Protocol servers construct the SDK's AJV validator
only when elicitation needs it; ordinary tool calls retain their Zod validation.

The shared executor admits 64 calls and 4 MiB of pending input. Direct replies
have a 32 MiB frame bound; HTTP envelopes have a 128 MiB bound to accommodate
the SDK's structured answer and escaped text copy. Both obey pipe backpressure.
The Viewer decodes at most 16 KiB of HTTP frame metadata and forwards body
bytes through a stream with a 64 KiB queue target. A slow consumer pauses the
pipe; cancellation drains the current frame before reading the next reply.
Split UTF-8 sequences pass through unchanged. A cancelled reply retains its
slot until settlement; an executor that has not settled cancellation after one
second is retired before a replacement starts. Sixty seconds idle retires it.
The existing helper lease ends its process group when its Viewer dies. The
Viewer loop monitor labels the wait `mcp.tasks.executor`.

Moving the service alone left protocol setup on the Viewer: every stateless
POST registered the complete tool catalog and rebuilt task transport schemas.
Single known-tool POSTs now register that tool; discovery, unknown names,
batches and other protocol methods keep the full catalog. Fixed transport
schemas are built once. The compiled executor uses the App Router server layer
because the shared binding graph imports App Router APIs. Production build and
source/compiled executor tests exercise this entry.

The first complete executor pair (2026-10-15, candidate starting 12:29:31Z,
main starting 12:35:02Z) still regressed the Viewer loop: p99/max were
0.642/3.078 ms on main and 0.808/3.343 ms on candidate `57cd5ac06431`.
Both completed 300/300 measured calls with no failures or pending work and
no teardown survivors. All 330 responses and all six columns of the final
rows matched after normalization. The immutable aggregate record is
[`mcp-state-writers-executor-diagnostic.json`](../../evidence/mcp-state-writers-executor-diagnostic.json).
It records a failed control, before the final protocol relocation.

Task HTTP protocol dispatch now also runs in the executor, using the same SDK,
schemas, policy and service. The Viewer retains authentication, cancellation
namespaces and bounded admission, then forwards the SDK's serialized answer.
Executor refusal preserves the original unknown-outcome envelope and request
key. Discovery, unknown methods and other tools retain their existing path.

`scripts/mcp-state-writer-matrix.py` exports the audit, matched main and candidate
revisions, freezes Bun, Node, dependencies, observer and seed, and runs the
existing benchmark through one owned admission per sample. The default is all
1/19/37-client load points, three alternating repetitions, independent and
shared tasks under stdio and native HTTP. Optional `--clients`, `--modes`,
`--sides` and `--repeats` select diagnostic subsets. A completed report can be
resumed; a partial sample stays on disk and refuses replacement.

The native observer records successful row statements with transaction and call
identity. The comparer replays committed statements into an in-memory copy of
the seed and requires its complete final rows to match the post-teardown
snapshot. Collection revisions order concurrent commits. Retries of the original mutation tool with its original arguments and key,
final MCP receipts and this row history reconcile lost replies. Protocol
failures remain failures in the measured counters. An unknown reply remains in
the response record even when the history proves its final effect. Direct
normalized hashes retain numeric SQL revisions; concurrent revision ordering,
shared-task guard outcomes and the 100-entry create-receipt cap are also checked
against each sample's committed history.

New snapshots include all six durable columns: collection, key, value, order,
numeric revision and controller flag. Comparer controls reconcile a complete
sample with every mutation reply replaced by unknown, and reject independent
changes to row order and the controller flag. Archived four-column diagnostics
remain readable with their original, narrower comparison boundary.

Run from a clean candidate checkout with its dependencies installed. `BASELINE` names the matched main revision already merged into the candidate. The subshell scopes the isolated environment to these checks. `GATE`
names the supplied owned runner; `SQLITE_INCLUDE` names the directory containing
`sqlite3ext.h`. Omitting `--seed` and `--capabilities` generates a fresh synthetic
seed with the existing concurrency fixture. Supplying both reuses an archived
seed and its matching fixture capabilities.

```sh
RUN_ROOT="$(mktemp -d "${TMPDIR:?set TMPDIR to an owned scratch directory}/delegatus-mcp-study.XXXXXXXX")"
(
mkdir -p "$RUN_ROOT/home" "$RUN_ROOT/config" "$RUN_ROOT/state"
export HOME="$RUN_ROOT/home" XDG_CONFIG_HOME="$RUN_ROOT/config"
export TMPDIR="$RUN_ROOT" LLV_STATE_DIR="$RUN_ROOT/state"
export LLV_VIEWER_CONTROL_URL="http://127.0.0.1:1"
OBSERVER="$RUN_ROOT/observer.so"
rtk proxy bash "$GATE" cc -I "$SQLITE_INCLUDE" -O2 -fPIC -shared scripts/sqlite-observer.c -o "$OBSERVER"
LLV_OWNED_RUN_TIMEOUT_MS=86400000 rtk proxy bash "$GATE" python3 -B scripts/mcp-state-writer-matrix.py --output "$RUN_ROOT/study" --gate "$GATE" --observer "$OBSERVER" --baseline "$BASELINE" --candidate HEAD --audit 45d25ac --sides candidate main audit
LLV_OWNED_RUN_TIMEOUT_MS=3600000 rtk proxy bash "$GATE" python3 -B scripts/mcp-state-writer-matrix.py --compare "$RUN_ROOT/study"
rtk proxy bash "$GATE" python3 -B scripts/mcp-state-writer-matrix.py --verify-comparer "$RUN_ROOT/study"
rtk proxy bash "$GATE" python3 -B scripts/mcp-state-writer-matrix.py --summarize "$RUN_ROOT/study" "$RUN_ROOT/acceptance.json" "$RUN_ROOT/acceptance.md"
)
```

The outer collection has a 24-hour owned-runner deadline; every nested sample retains its own admission and resource quota. The full analysis has a one-hour deadline. The complete alternating matrix is required before performance acceptance.

The Viewer initializes its binding module before its first tool dispatch. The benchmark awaits this initialization before opening its listener. Its inline receipt service remains lazy, and the managed stdio
adapter returns before importing that module. Task calls continue through the
executor. Loading the binding module in isolation opened no SQLite connection.
Two diagnostic repetitions with 30 seconds warmup and 120 seconds measured
load reduced stdio loop p99 from 0.395263/0.407551 ms with deferred binding
initialization to 0.192639/0.195455 ms with initialization before serving.
These shorter probes identify a startup difference; they do not replace the
complete acceptance matrix below.

Before this adjustment, candidate `048535abf` completed twenty full-window
samples against matched main `d395e7c73` and original audit `45d25ac`.
The candidate's independent-stdio median p99/max was 0.509439/2.950696 ms;
matched main was 0.204415/2.814844 ms and audit was 0.193791/3.132405 ms.
Shared-stdio medians were 0.394751/2.114389 ms for candidate,
0.199167/2.710410 ms for main, and 0.203391/2.010166 ms for audit.
This candidate failed performance acceptance. Its first native HTTP sample
recorded 0.577023/3.096848 ms against main's 46.039039/131.001025 ms;
that single pair establishes no cohort verdict.

All twenty samples completed their 300 offered calls with zero failures,
pending calls or surviving processes. All thirteen available candidate/control
pairs have equal normalized response and durable-row hashes, and each history
reproduces its final rows. The owned controller ended between measurements;
all twenty complete records remain in
[`mcp-state-writers-viewer-initialization-diagnostic.json`](../../evidence/mcp-state-writers-viewer-initialization-diagnostic.json).
The changed candidate needs a fresh complete matrix with a new source freeze.

### Acceptance rules for the resumed matrix

The resumed matrix freezes the candidate after merging main. Each of the twelve
client/transport/sharing cohorts uses three repetitions, reversing the order of
candidate, matched main and original audit on the second repetition. Every
sample retains the same 30-second warmup, 300-second offered load, seed,
dependencies, runtimes and observer. The report records the actual sample's
CPU and memory quota hierarchy, in addition to the controller's hierarchy.

For each cohort, compare the median of the three Viewer loop p99 values and
the median of the three loop maxima with each control. Both candidate medians
must be no higher. Publish every repetition, including individual maxima,
failed responses and pending calls. An incomplete loop window, surviving
fixture process, connection imbalance, adapter database access or unreconciled
mutation prevents acceptance. A call offered after the scheduled window also
invalidates that sample. Recovering a timed-out operation keeps its
original measured failure and latency.

The resumed reports scope pending counts to measured calls. They also retain
the total pending work, including warmup, at the observed boundary and after
drain. Reconciliation `queried` counts actual retry attempts; `settled` also
includes replies already known without another request. Older diagnostic
reports retained total pending work and counted all settled replies as queried.
Final matrix reports snapshot pending work immediately after the drain and
again after reconciliation, with both observation times. The earlier complete
one-client diagnostic computed its after-drain fields after reconciliation;
all nine samples had zero pending work at both observations.

Exact normalized response and row hashes remain separate from the committed
history checks. Concurrent writes can settle in different orders and shared-task
revision guards can admit different callers. A different exact hash therefore
requires an explanation from the retained history; every successful or lost
mutation reply must still reconcile with its one committed effect or with no
effect after all owned processes have ended. Numeric row revisions, order and
controller flags remain in the exact row comparison.

Comparer version 2 also decodes task `nextCursor` tokens before normalizing
their generated ID and timestamp; their filter scope remains unchanged. It
checks each original successful mutation response against its committed task,
independently of later receipt recovery. Successful list responses must contain
known committed task versions with the fixture's exact compact fields, valid
counts, filter scope, cursor boundary and an ordering possible from those
versions. Statement and commit observations bound which create counts could
have been visible during the request. Selection and individual row reads may
observe different committed versions, as the existing list API permits.
The report records its analysis-file checksum and normalization version;
previous immutable aggregates retain their original normalization.
The comparer control command copies one complete one-client sample under the
caller's temporary root. It accepts the unchanged record and a record with all
mutation replies replaced by unknown. It rejects independent changes to list
text, counts, filter scope, ordering, a mutation summary, durable row order and
the controller flag. Collected load records stay intact.


### Complete one-client cohort before byte streaming

The complete first cohort freezes candidate `99af6a276`, matched main
`805a790ac` and the original audit product revision `45d25ac`. Each uses
30 seconds warmup and 300 seconds measured load from the same seed. The
revision order is candidate/main/audit, audit/main/candidate, then
candidate/main/audit. This is a failed diagnostic cohort; the remaining
client and transport cohorts cannot establish acceptance for this candidate.

| Revision | Repetition | Loop p99 / max, ms | Offered / completed / failed | Pending at end / after drain | Process births / survivors | Adapter / total DB descriptors | State commits |
|---|---:|---:|---:|---:|---:|---:|---:|
| candidate | 1 | 0.799 / 6.757 | 300 / 300 / 0 | 0 / 0 | 5 / 0 | 0 / 5 | 480 |
| candidate | 2 | 0.984 / 34.316 | 300 / 300 / 0 | 0 / 0 | 5 / 0 | 0 / 5 | 480 |
| candidate | 3 | 0.734 / 20.328 | 300 / 300 / 0 | 0 / 0 | 5 / 0 | 0 / 5 | 480 |
| main | 1 | 1.709 / 11.542 | 300 / 300 / 0 | 0 / 0 | 3 / 0 | 5 / 5 | 570 |
| main | 2 | 3.262 / 34.025 | 300 / 300 / 0 | 0 / 0 | 3 / 0 | 5 / 5 | 570 |
| main | 3 | 0.994 / 7.473 | 300 / 300 / 0 | 0 / 0 | 3 / 0 | 5 / 5 | 570 |
| audit | 1 | 1.377 / 17.561 | 300 / 300 / 0 | 0 / 0 | 3 / 0 | 5 / 5 | 480 |
| audit | 2 | 0.757 / 7.908 | 300 / 300 / 0 | 0 / 0 | 3 / 0 | 5 / 5 | 480 |
| audit | 3 | 1.170 / 10.123 | 300 / 300 / 0 | 0 / 0 | 3 / 0 | 5 / 5 | 480 |

Median loop p99/max are 0.799/20.328 ms for the candidate,
1.709/11.542 ms for matched main, and 1.170/10.123 ms for the audit.
The candidate passes both p99 comparisons and fails both maximum comparisons.
Performance acceptance remains unmet.

All nine loop windows completed. Every process ended; every connection
reconciles through explicit close or process exit, with zero remaining
descriptors. No sample observed SQL contention. All six candidate/control
pairs have identical normalized response and row hashes, retaining all six
durable columns. Their committed histories reproduce every final row and
leave no unresolved mutations. Per-process connections, commits, failure
and pending counts, source/runtime/dependency identities, hashes and history
checks are retained in
[`mcp-state-writers-protocol-diagnostic.json`](../../evidence/mcp-state-writers-protocol-diagnostic.json).

This candidate still assembled complete HTTP reply strings on the Viewer
before encoding them for network pulls. The next change forwards body bytes
from the worker pipe, with backpressure and cancellation that drains the
current frame. Only bounded frame metadata is decoded. The existing service,
request keys, policy and transactional writes remain inside the executor.
The complete 1/19/37-client matrix must be repeated after this change.

The byte-streaming executor suite passes 15 cases, including a real child
that holds its HTTP body tail behind a barrier. The same held-body probe
times out on the frozen executor and returns headers before release on the
changed executor; both run through the owned runner in isolated state.
The body matches after release. HTTP passes 15 cases, forwarding passes 12,
and TypeScript and the local privacy gate pass. These checks verify the wire
and lifecycle changes; performance acceptance still requires new measurements.

### Byte streaming cohort and combined authentication

The byte-streaming candidate `8e40a078770e14ac51eae1eb3bb84d37d93c82b3` completed three one-client stdio repetitions. Their median loop p99/max was **0.631807/2.930454 ms**. Two original-audit repetitions returned p99 values of 0.561151 and 0.628735 ms. Any third audit result leaves its median at or below 0.628735 ms, so the declared p99 criterion was already unreachable. The controller stopped the cohort during the third main sample. That partial window is retained and excluded.

| Source | Repetition | Loop p99 / max, ms | Offered / completed / failed | Pending at end / after drain | Process births / survivors | Peak adapter / total descriptors | State commits |
|---|---:|---:|---:|---:|---:|---:|---:|
| candidate | 1 | 0.653311 / 2.930454 | 300 / 300 / 0 | 0 / 0 | 5 / 0 | 0 / 5 | 480 |
| main | 1 | 0.646143 / 4.076807 | 300 / 300 / 0 | 0 / 0 | 3 / 0 | 5 / 5 | 570 |
| audit | 1 | 0.561151 / 3.958003 | 300 / 300 / 0 | 0 / 0 | 3 / 0 | 5 / 5 | 480 |
| audit | 2 | 0.628735 / 1.780211 | 300 / 300 / 0 | 0 / 0 | 3 / 0 | 5 / 5 | 480 |
| main | 2 | 0.621567 / 2.548013 | 300 / 300 / 0 | 0 / 0 | 3 / 0 | 5 / 5 | 570 |
| candidate | 2 | 0.578047 / 2.890962 | 300 / 300 / 0 | 0 / 0 | 5 / 0 | 0 / 5 | 480 |
| candidate | 3 | 0.631807 / 2.993709 | 300 / 300 / 0 | 0 / 0 | 5 / 0 | 0 / 5 | 480 |

All seven completed windows had zero SQL contention and no teardown survivors. Every connection balances through explicit close or process exit. All seven committed histories reproduce their final rows, with no unresolved mutation. All four available candidate/control pairs have identical normalized response and row hashes, retaining all six durable columns. Source, observer, runtime, quota and seed identities, per-process balances and the partial observation are in [`mcp-state-writers-byte-streaming-diagnostic.json`](../../evidence/mcp-state-writers-byte-streaming-diagnostic.json).

The task endpoint now combines capability lookup and HTTP dispatch in one executor request for declared bodies up to 16 KiB. Larger and unframed requests authenticate before reading their body. The executor checks the current capability before SDK dispatch; per-tool policy still rechecks authority before receipt replay or mutation. Native peer verification, request keys, cancellation, revisions and companion transactions keep their existing paths. Authentication refusals use one shared response formatter.

The new regression covers unknown and externally rotated capabilities through small framed, large framed and unframed requests, malformed JSON refusal order, receipt non-disclosure, and original-key replay through the successor capability. The source and compiled executor suites each pass 16 cases; packaged stdio passes 51, HTTP/cancellation 18, and linked-task/wire suites 20 with one old-release opt-in skip. TypeScript, production build and local privacy pass. Performance acceptance requires a new immutable alternating matrix after this change.

### Combined authentication diagnostic and fixture calibration

Candidate `9e2271531683d4d91b609e7c0c32deb31668a033` combines the small,
framed task request's registry lookup and dispatch in one executor request.
It checks the current capability before protocol dispatch; the full tool policy
still checks authority before replay or mutation. Large and unframed requests
keep authentication before body parsing. Tests cover external capability
rotation, malformed bodies, all three framing cases and original-key replay.

The complete one-client, stdio, independent-task cohort used three alternating
repetitions against matched main `fe18cb41d73481f6b4e4bd105b708cb03e2d3b05`
and audit `45d25ac796d5824713c9fb57d65f57efea61041b`, with the unchanged
30-second warmup and 300-second measurement. All nine samples completed
300/300 measured calls, with zero failures, pending calls, SQL contention or
teardown survivors. Candidate adapter database opens remained zero. All six
candidate/control row and response hashes agreed after the declared
normalization, and every committed history reproduced its final durable rows.
No mutation remained unresolved. The immutable record is
[`mcp-state-writers-combined-auth-diagnostic.json`](../../evidence/mcp-state-writers-combined-auth-diagnostic.json).

| Median loop delay, ms | Candidate | Main | Audit |
|---|---:|---:|---:|
| p99 | 0.642047 | 0.681471 | 0.655871 |
| Maximum | 4.640120 | 3.811877 | 3.832169 |

**Acceptance fails:** the median maximum regressed against both controls.
The third candidate maximum was 133.570566 ms; that observation remains in
the record. Collection stopped after this cohort. The next partial sample is
excluded, and this cohort cannot be combined with later measurements.

A separate 30-second-warmup/120-second diagnostic CPU profile found repeated
synchronous procfs reads from the barrier fixture's 100 ms parent check.
The benchmark Viewer inherited that check through an unused barrier import.
The production Viewer does not run that fixture. The benchmark also imported
the production operation monitor without starting its timer, leaving completed
operations retained until its fixed-size retention path ran on each new one.
Production starts that monitor during Viewer instrumentation.

The calibrated harness enters the benchmark before importing the barrier
fixture and starts/stops the production operation monitor. Its Viewer refuses
to start outside the required private PID namespace; the owned runner and
namespace still end its descendants on owner death. Non-benchmark lifecycle
and barrier fixtures retain their original parent checks. All three source
revisions receive this same harness. The seed, request schedule, repetitions,
load windows and declared no-regression criterion stay unchanged. The earlier
samples remain failed evidence, with their original harness identities.

### Bounded response transfer

A preliminary pair with the calibrated harness used candidate
`9361b0e1cdd4d7671d32054c4313e413de0e13d9` and matched main
`fe18cb41d73481f6b4e4bd105b708cb03e2d3b05`. Each completed 300/300 measured
calls without failures, pending calls, SQL contention or survivors. Normalized
rows and responses matched, and both committed histories reproduced final
state. Candidate p99/max was 0.607231/3.310372 ms; main was
0.216447/5.979864 ms. Viewer CPU was 4.177086/3.898381 seconds respectively.
The higher candidate p99 remains a failed diagnostic comparison. Collection
stopped before the audit sample completed; no full acceptance cohort was
claimed. The immutable pair is
[`mcp-state-writers-calibrated-diagnostic.json`](../../evidence/mcp-state-writers-calibrated-diagnostic.json).

The response reader now pauses the pipe while holding its current chunk,
delivers HTTP headers on one turn, and transfers at most 16 KiB of body bytes
per following turn. Consumer pulls resume the held chunk before requesting
more pipe input. Cancellation drains through the same bounded path; end of
pipe waits for queued bytes before reporting worker loss. Ingress parsing and
executor admission also run on separate turns. Authority, original request
keys, receipts and task transactions retain their existing execution path.

The buffered-answer regression sends one 4 MiB body followed by another reply
and closes its source. An independent timer must advance before consumption
finishes, while bytes and reply order remain exact. The test fails on the
previous response reader because the timer records zero progress; the bounded
reader passes. The executor suite also covers full 128 MiB wire bounds,
metadata bounds, split UTF-8, slow consumers, cancellation, worker loss,
external capability rotation, receipt replay and actual Viewer owner death.

### Task-worker channel

The bounded-transfer candidate `8f8d356d71aebb0fe115230e5fd7fc8c5d622d2f`
still spent time handling every stdio request on the Viewer. Its preliminary
one-client pair returned loop p99/max of 0.601599/4.104558 ms, against
0.207359/2.720363 ms for matched main
`14e3199375a2ca4d1a3646eef52fc231794c7915`. Both samples completed all
300 measured calls, with zero failures, pending calls, SQL contention or
survivors. Collection stopped during the audit sample. This pair remains a
failed diagnostic and cannot establish acceptance.
Normalized rows and responses match, all connections balance and both SQL
histories reproduce final state. The immutable record is
[`mcp-state-writers-bounded-transfer-diagnostic.json`](../../evidence/mcp-state-writers-bounded-transfer-diagnostic.json).

Managed Linux stdio task calls now obtain a delegation through the Viewer's
authenticated HTTP endpoint. Later calls connect directly to the same
Viewer-owned task worker through a random abstract Unix socket. Before sending
credentials, the adapter checks the connected kernel peer's UID and PID and
the issued process start identity and boot epoch. Every call also checks the
delegation nonce, the current launch capability and the Viewer's release
endpoint. The worker runs the existing HTTP SDK and full task service, including
policy, receipts, revisions and companion transactions. Agents retain zero
local database connections.

The adapter caches one descriptor, scoped to the endpoint, launch capability
and control credential. A stale channel retries through the Viewer once with
the identical request body, original key and remaining deadline. Other tools,
native HTTP and other operating systems retain the HTTP boundary. Enabling
the Viewer's access key retires the existing worker before Settings answers;
later delegations pass through the new perimeter. The benchmark retains its
original unprotected configuration for all three source revisions.

Pipe and socket calls share 64 admissions and a 4 MiB input budget, including
socket metadata and delimiters. Each socket accepts one call with a deadline
of at most 30 seconds. Metadata is bounded at 4 KiB and the complete reply at
128 MiB. Partial inputs reserve admission; disconnects cancel their operation,
and dispatched calls retain admission until their reply finishes or fails.
The listener allows at most 128 connections, including refusals and draining
replies. The worker expires after 60 idle seconds, reports heartbeats to an
independent parent watchdog and remains under its existing lifetime guardian.
The parent confirms exit before starting its successor.

The acceptance reports additionally count measured HTTP arrivals on the Viewer,
so the stdio measurements can establish whether requests actually leave its
loop. Reconciliation treats interrupted calls, generic tool failures and HTTP
failures as uncertain alongside timeouts. It retains their original failures
and reports whether a receipt, a recovery reply, one committed effect or no
effect after teardown resolves each original uncertain mutation.
Measured SQL event counters also retain process role, PID and database, so
connection balances, commits and lock waits can be checked per process.

Source and production-compiled executor checks each pass 26 cases; the channel
wire suite passes seven. Forwarding and HTTP checks pass 30 cases, packaged
stdio passes 51, linked-task and wire checks pass 20 with one opt-in old-release
skip, and Settings passes seven. TypeScript, the production build and the local
privacy gate pass. All runs use explicit test paths and isolated state under
the owned runner. Removing access-key withdrawal leaves the old worker alive
after Settings answers; removing idempotent reservation disposal admits an
oversized follow-up and starts another worker. Both regression tests fail with
their guards absent and pass after restoration. The complete alternating measurements for the later initialization change follow below.

### Private task channel diagnostic

Candidate `8f2f1e1fb15d`, matched main `14e3199375a2` and original audit
`45d25ac` use the same frozen seed, runtimes, dependencies and observer. Six
samples completed with 30 seconds warmup and 300 seconds measured load. The
order is candidate/main/audit, then audit/main/candidate. The third candidate
sample was interrupted after the two audit p99 values made the strict cohort
median criterion unreachable; its partial directory is retained and excluded.

| Revision | Repetition | Loop p99 / max, ms | Offered / completed / failed | Pending at end / after drain | Process births / survivors | Adapter / total DB descriptors | State commits |
|---|---:|---:|---:|---:|---:|---:|---:|
| candidate | 1 | 0.394239 / 1.974228 | 300 / 300 / 0 | 0 / 0 | 5 / 0 | 0 / 5 | 480 |
| main | 1 | 0.292095 / 3.086414 | 300 / 300 / 0 | 0 / 0 | 3 / 0 | 5 / 5 | 570 |
| audit | 1 | 0.193023 / 2.029684 | 300 / 300 / 0 | 0 / 0 | 3 / 0 | 5 / 5 | 480 |
| audit | 2 | 0.186495 / 4.571027 | 300 / 300 / 0 | 0 / 0 | 3 / 0 | 5 / 5 | 480 |
| main | 2 | 0.186239 / 2.747161 | 300 / 300 / 0 | 0 / 0 | 3 / 0 | 5 / 5 | 570 |
| candidate | 2 | 0.409855 / 2.186528 | 300 / 300 / 0 | 0 / 0 | 5 / 0 | 0 / 5 | 480 |

Both candidate stdio samples handled zero measured task HTTP calls on the
Viewer and opened no Viewer database connection. Task protocol, policy, receipt
and transaction work ran in the one owned task executor. Adapter database
connections remained zero. SQLite BUSY/LOCKED results, held-lease refusals and
synchronous lock waits were zero in all six samples. Every opened connection
was explicitly closed or reclaimed at its process exit; no process or database
descriptor survived teardown.

All four candidate/control pairs have identical normalized response and row
hashes. Each sample contains 330 responses including warmup and 2,103 final
durable rows, with all six SQL columns retained. Every committed history replays
to its final snapshot, with no unresolved mutation or history violation. There
were no uncertain mutation replies requiring recovery in these samples.

The candidate cohort median p99 must be at least 0.394239 ms, while the audit
median can be no greater than 0.193023 ms, regardless of the third repetition.
**Performance acceptance remains unmet.** At this diagnostic checkpoint the complete 108-sample matrix was
still required. The immutable aggregate and all per-process balances are in
[`mcp-state-writers-task-channel-diagnostic.json`](../../evidence/mcp-state-writers-task-channel-diagnostic.json).

### Acceptance matrix with bounded task execution

Frozen product revisions: candidate `97c1a8bc186abd8d68c0daa8c6063ec3f32604c3`, matched main `75da49d3d60ece7e4e62d11ce4c7a530a3512004`, original audit `45d25ac796d5824713c9fb57d65f57efea61041b`.

Every sample uses 30 seconds warmup and 300 seconds measured load. Revision order alternates candidate/main/audit, audit/main/candidate, candidate/main/audit. The [JSON matrix](../../evidence/mcp-state-writers-matrix.json) includes runtime, dependency, seed and observer identities, actual quotas, per-process connection balances, all observations and normalized equivalence checks.

| Clients / transport / tasks | Candidate p99 / max | Main p99 / max | Audit p99 / max | No loop regression |
|---|---:|---:|---:|---|
| 1-stdio-independent | 0.264959 / 3.001259 | 0.213759 / 2.785111 | 0.204799 / 2.478469 | no |
| 1-stdio-shared | 0.248703 / 3.080855 | 0.242047 / 2.674284 | 0.237311 / 3.037928 | no |
| 1-http-independent | 0.760319 / 4.063445 | 43.876351 / 91.947883 | 14.925823 / 80.481424 | yes |
| 1-http-shared | 0.821247 / 4.019456 | 41.549823 / 96.268349 | 14.868479 / 78.775287 | yes |
| 19-stdio-independent | 0.583167 / 16.361698 | 30.474239 / 108.756693 | 26.296319 / 131.025647 | yes |
| 19-stdio-shared | 0.781823 / 17.951357 | 48.889855 / 188.814542 | 13.213695 / 89.141227 | yes |
| 19-http-independent | 1.157119 / 8.840065 | 28487.712767 / 28487.631448 | 1035.993087 / 4316.429328 | yes |
| 19-http-shared | 1.089535 / 7.091370 | 13337.886719 / 15024.932072 | 391.380991 / 1415.447730 | yes |
| 37-stdio-independent | 3.205119 / 30.554621 | 91.750399 / 270.906988 | 30.081023 / 131.772799 | yes |
| 37-stdio-shared | 2.299903 / 38.036176 | 75.038719 / 288.069228 | 29.278207 / 192.805337 | yes |
| 37-http-independent | 1.287167 / 12.052943 | 35097.935871 / 35093.447451 | 17054.040063 / 17053.284109 | yes |
| 37-http-shared | 1.413119 / 9.051527 | 31977.373695 / 31976.393637 | 13262.389247 / 13258.022845 | yes |

The following rows retain every repetition. Calls are offered/completed/failed; completed includes settled failures, so successful calls equal completed minus failed. Pending counts are at measurement end/after the 35-second drain/after bounded recovery, before teardown. Processes are peak/observed runtime births/derived gone/survivors; gone is births minus survivors, supported by empty private-namespace teardown. Descriptors are peak adapter/total main-database descriptors. Connections are total main-database opens/explicit closes/reclaimed at process exit across all phases; commits and contention frequency use the measured window.

| Sample | Loop p99 / max, ms | Loop start/end lateness, ms | Calls | Pending | Processes | Descriptors | Connections | State commits | SQL contention / 10,000 completed | Lease refusals |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| candidate-1-stdio-independent-1 | 0.265471 / 2.941944 | 0/0 | 300/300/0 | 0/0/0 | 5/5/5/0 | 0/5 | 1592/1589/3 | 480 | 0.000 | 0 |
| main-1-stdio-independent-1 | 0.209663 / 2.566202 | 0/0 | 300/300/0 | 0/0/0 | 3/3/3/0 | 5/5 | 11294/11291/3 | 570 | 0.000 | 0 |
| audit-1-stdio-independent-1 | 0.192511 / 1.924573 | 0/0 | 300/300/0 | 0/0/0 | 3/3/3/0 | 5/5 | 11294/11291/3 | 480 | 0.000 | 0 |
| audit-1-stdio-independent-2 | 0.241151 / 2.478469 | 0/0 | 300/300/0 | 0/0/0 | 3/3/3/0 | 5/5 | 11294/11291/3 | 480 | 0.000 | 0 |
| main-1-stdio-independent-2 | 0.278527 / 3.079738 | 1/0 | 300/300/0 | 0/0/0 | 3/3/3/0 | 5/5 | 11294/11291/3 | 570 | 0.000 | 0 |
| candidate-1-stdio-independent-2 | 0.250111 / 3.853740 | 0/0 | 300/300/0 | 0/0/0 | 5/5/5/0 | 0/5 | 1592/1589/3 | 480 | 0.000 | 0 |
| candidate-1-stdio-independent-3 | 0.264959 / 3.001259 | 1/0 | 300/300/0 | 0/0/0 | 5/5/5/0 | 0/5 | 1592/1589/3 | 480 | 0.000 | 0 |
| main-1-stdio-independent-3 | 0.213759 / 2.785111 | 0/0 | 300/300/0 | 0/0/0 | 3/3/3/0 | 5/5 | 11294/11291/3 | 570 | 0.000 | 0 |
| audit-1-stdio-independent-3 | 0.204799 / 2.594680 | 0/0 | 300/300/0 | 0/0/0 | 3/3/3/0 | 5/5 | 11294/11291/3 | 480 | 0.000 | 0 |
| candidate-1-stdio-shared-1 | 0.200191 / 2.102814 | 0/0 | 300/300/0 | 0/0/0 | 5/5/5/0 | 0/5 | 1592/1589/3 | 480 | 0.000 | 0 |
| main-1-stdio-shared-1 | 0.215807 / 2.563595 | 0/0 | 300/300/0 | 0/0/0 | 3/3/3/0 | 5/5 | 11294/11291/3 | 570 | 0.000 | 0 |
| audit-1-stdio-shared-1 | 0.232447 / 2.425066 | 1/1 | 300/300/0 | 0/0/0 | 3/3/3/0 | 5/5 | 11294/11291/3 | 480 | 0.000 | 0 |
| audit-1-stdio-shared-2 | 0.237311 / 3.037928 | 0/1 | 300/300/0 | 0/0/0 | 3/3/3/0 | 5/5 | 11294/11291/3 | 480 | 0.000 | 0 |
| main-1-stdio-shared-2 | 0.242047 / 2.674284 | 0/0 | 300/300/0 | 0/0/0 | 3/3/3/0 | 5/5 | 11294/11291/3 | 570 | 0.000 | 0 |
| candidate-1-stdio-shared-2 | 0.610303 / 3.173174 | 1/0 | 300/300/0 | 0/0/0 | 5/5/5/0 | 0/5 | 1592/1589/3 | 480 | 0.000 | 0 |
| candidate-1-stdio-shared-3 | 0.248703 / 3.080855 | 0/0 | 300/300/0 | 0/0/0 | 5/5/5/0 | 0/5 | 1592/1589/3 | 480 | 0.000 | 0 |
| main-1-stdio-shared-3 | 0.320511 / 3.804605 | 0/0 | 300/300/0 | 0/0/0 | 3/3/3/0 | 5/5 | 11294/11291/3 | 570 | 0.000 | 0 |
| audit-1-stdio-shared-3 | 0.313087 / 3.119449 | 0/0 | 300/300/0 | 0/0/0 | 3/3/3/0 | 5/5 | 11294/11291/3 | 480 | 0.000 | 0 |
| candidate-1-http-independent-1 | 0.760319 / 3.693526 | 0/0 | 300/300/0 | 0/0/0 | 3/3/3/0 | 0/5 | 1592/1589/3 | 480 | 0.000 | 0 |
| main-1-http-independent-1 | 41.320447 / 91.947883 | 0/0 | 300/300/0 | 0/0/0 | 1/1/1/0 | 0/5 | 11294/11291/3 | 570 | 0.000 | 0 |
| audit-1-http-independent-1 | 14.319615 / 94.061425 | 24/0 | 300/300/0 | 0/0/0 | 1/1/1/0 | 0/5 | 11294/11291/3 | 480 | 0.000 | 0 |
| audit-1-http-independent-2 | 15.278079 / 63.797252 | 24/0 | 300/300/0 | 0/0/0 | 1/1/1/0 | 0/5 | 11294/11291/3 | 480 | 0.000 | 0 |
| main-1-http-independent-2 | 43.876351 / 118.867023 | 60/0 | 300/300/0 | 0/0/0 | 1/1/1/0 | 0/5 | 11294/11291/3 | 570 | 0.000 | 0 |
| candidate-1-http-independent-2 | 0.738815 / 4.063445 | 0/0 | 300/300/0 | 0/0/0 | 3/3/3/0 | 0/5 | 1592/1589/3 | 480 | 0.000 | 0 |
| candidate-1-http-independent-3 | 0.877567 / 4.421020 | 1/1 | 300/300/0 | 0/0/0 | 3/3/3/0 | 0/5 | 1592/1589/3 | 480 | 0.000 | 0 |
| main-1-http-independent-3 | 45.613055 / 83.050115 | 1/0 | 300/300/0 | 0/0/0 | 1/1/1/0 | 0/5 | 11294/11291/3 | 570 | 0.000 | 0 |
| audit-1-http-independent-3 | 14.925823 / 80.481424 | 23/0 | 300/300/0 | 0/0/0 | 1/1/1/0 | 0/5 | 11294/11291/3 | 480 | 0.000 | 0 |
| candidate-1-http-shared-1 | 0.840703 / 4.019456 | 1/1 | 300/300/0 | 0/0/0 | 3/3/3/0 | 0/5 | 1592/1589/3 | 480 | 0.000 | 0 |
| main-1-http-shared-1 | 45.121535 / 96.268349 | 0/0 | 300/300/0 | 0/0/0 | 1/1/1/0 | 0/5 | 11294/11291/3 | 570 | 0.000 | 0 |
| audit-1-http-shared-1 | 15.097855 / 71.982826 | 28/0 | 300/300/0 | 0/0/0 | 1/1/1/0 | 0/5 | 11294/11291/3 | 480 | 0.000 | 0 |
| audit-1-http-shared-2 | 14.852095 / 78.775287 | 27/0 | 300/300/0 | 0/0/0 | 1/1/1/0 | 0/5 | 11294/11291/3 | 480 | 0.000 | 0 |
| main-1-http-shared-2 | 41.549823 / 92.347668 | 60/0 | 300/300/0 | 0/0/0 | 1/1/1/0 | 0/5 | 11294/11291/3 | 570 | 0.000 | 0 |
| candidate-1-http-shared-2 | 0.762367 / 4.245237 | 0/0 | 300/300/0 | 0/0/0 | 3/3/3/0 | 0/5 | 1592/1589/3 | 480 | 0.000 | 0 |
| candidate-1-http-shared-3 | 0.821247 / 3.265647 | 0/1 | 300/300/0 | 0/0/0 | 3/3/3/0 | 0/5 | 1592/1589/3 | 480 | 0.000 | 0 |
| main-1-http-shared-3 | 41.353215 / 106.196032 | 59/1 | 300/300/0 | 0/0/0 | 1/1/1/0 | 0/5 | 11294/11291/3 | 570 | 0.000 | 0 |
| audit-1-http-shared-3 | 14.868479 / 80.188442 | 35/0 | 300/300/0 | 0/0/0 | 1/1/1/0 | 0/5 | 11294/11291/3 | 480 | 0.000 | 0 |
| candidate-19-stdio-independent-1 | 0.642047 / 28.382580 | 1/1 | 5700/5700/0 | 0/0/0 | 41/41/41/0 | 0/5 | 30104/30101/3 | 9120 | 0.000 | 0 |
| main-19-stdio-independent-1 | 51.314687 / 270.139575 | 44/23 | 5700/5700/4586 | 363/0/0 | 39/171/171/0 | 95/95 | 187129/186603/526 | 2709 | 1133.333 | 5950 |
| audit-19-stdio-independent-1 | 26.296319 / 131.025647 | 1/1 | 5700/5700/0 | 45/0/0 | 39/39/39/0 | 95/95 | 218758/218701/57 | 9287 | 3838.596 | 385470 |
| audit-19-stdio-independent-2 | 28.082175 / 229.919333 | 0/0 | 5700/5700/0 | 23/0/0 | 39/39/39/0 | 95/95 | 218181/218124/57 | 8954 | 3664.912 | 374764 |
| main-19-stdio-independent-2 | 30.015487 / 108.756693 | 1/1 | 5700/5700/3117 | 460/0/0 | 39/128/128/0 | 95/95 | 371365/371003/362 | 5888 | 2331.579 | 12012 |
| candidate-19-stdio-independent-2 | 0.583167 / 13.804293 | 0/0 | 5700/5700/0 | 1/0/0 | 41/41/41/0 | 0/5 | 30104/30101/3 | 9118 | 0.000 | 0 |
| candidate-19-stdio-independent-3 | 0.483583 / 16.361698 | 1/0 | 5700/5700/0 | 0/0/0 | 41/41/41/0 | 0/5 | 30104/30101/3 | 9120 | 0.000 | 0 |
| main-19-stdio-independent-3 | 30.474239 / 90.204956 | 3/2 | 5700/5700/2664 | 317/0/0 | 39/123/123/0 | 95/95 | 401214/400882/332 | 6806 | 2656.140 | 14221 |
| audit-19-stdio-independent-3 | 11.583487 / 89.670393 | 0/0 | 5700/5700/0 | 44/0/0 | 39/39/39/0 | 95/95 | 218698/218641/57 | 8897 | 3689.474 | 463504 |
| candidate-19-stdio-shared-1 | 0.781823 / 13.120033 | 1/1 | 5700/5700/1620 | 0/0/0 | 41/41/41/0 | 0/5 | 30104/30101/3 | 9120 | 0.000 | 0 |
| main-19-stdio-shared-1 | 48.889855 / 209.700031 | 1/7 | 5700/5700/3292 | 213/0/0 | 39/111/111/0 | 95/95 | 332011/331701/310 | 7182 | 2770.175 | 14356 |
| audit-19-stdio-shared-1 | 13.082623 / 103.701885 | 1/0 | 5700/5700/1620 | 16/0/0 | 39/39/39/0 | 95/95 | 218210/218153/57 | 8990 | 3742.105 | 335297 |
| audit-19-stdio-shared-2 | 13.213695 / 80.426874 | 1/0 | 5700/5700/1620 | 30/0/0 | 39/39/39/0 | 95/95 | 217983/217926/57 | 8927 | 3726.316 | 320024 |
| main-19-stdio-shared-2 | 49.512447 / 165.562498 | 59/0 | 5700/5700/3854 | 353/0/0 | 39/131/131/0 | 95/95 | 281228/280843/385 | 5722 | 2233.333 | 11661 |
| candidate-19-stdio-shared-2 | 0.763903 / 23.201881 | 0/0 | 5700/5700/1620 | 5/0/0 | 41/41/41/0 | 0/5 | 30104/30101/3 | 9100 | 0.000 | 0 |
| candidate-19-stdio-shared-3 | 1.053695 / 17.951357 | 0/0 | 5700/5700/1620 | 6/0/0 | 41/41/41/0 | 0/5 | 30104/30101/3 | 9098 | 0.000 | 0 |
| main-19-stdio-shared-3 | 40.108031 / 188.814542 | 1/0 | 5700/5700/3276 | 358/0/0 | 39/112/112/0 | 95/95 | 346062/345766/296 | 7219 | 2782.456 | 15143 |
| audit-19-stdio-shared-3 | 14.434303 / 89.141227 | 5/0 | 5700/5700/1620 | 28/0/0 | 39/39/39/0 | 95/95 | 218128/218071/57 | 8911 | 3719.298 | 323403 |
| candidate-19-http-independent-1 | 1.441791 / 8.840065 | 0/0 | 5700/5700/10 | 13/0/0 | 3/3/3/0 | 0/5 | 30084/30081/3 | 9078 | 0.000 | 0 |
| main-19-http-independent-1 | 28487.712767 / 28487.631448 | 12893/6954 | 5700/5700/0 | 1438/1078/0 | 1/1/1/0 | 0/5 | 215279/215276/3 | 8303 | 0.000 | 0 |
| audit-19-http-independent-1 | 1016.070143 / 10041.816943 | 29/1562 | 5700/5700/0 | 171/0/0 | 1/1/1/0 | 0/5 | 214442/214439/3 | 8770 | 0.000 | 0 |
| audit-19-http-independent-2 | 1260.388351 / 2856.262471 | 1060/899 | 5700/5700/0 | 14/0/0 | 1/1/1/0 | 0/5 | 214442/214439/3 | 9136 | 0.000 | 0 |
| main-19-http-independent-2 | 22682.796031 / 22670.371870 | 1038/4234 | 5700/5700/0 | 1497/1079/0 | 1/1/1/0 | 0/5 | 215279/215276/3 | 8180 | 0.000 | 0 |
| candidate-19-http-independent-2 | 1.157119 / 15.597325 | 1/1 | 5700/5700/0 | 14/0/0 | 3/3/3/0 | 0/5 | 30104/30101/3 | 9106 | 0.000 | 0 |
| candidate-19-http-independent-3 | 1.145855 / 4.277701 | 3/1 | 5700/5700/0 | 4/0/0 | 3/3/3/0 | 0/5 | 30104/30101/3 | 9164 | 0.000 | 0 |
| main-19-http-independent-3 | 28756.148223 / 28752.378811 | 1873/10399 | 5700/5700/0 | 2014/1635/0 | 1/1/1/0 | 0/5 | 215697/215694/3 | 7366 | 0.000 | 0 |
| audit-19-http-independent-3 | 1035.993087 / 4316.429328 | 0/3138 | 5700/5700/0 | 33/0/0 | 1/1/1/0 | 0/5 | 214442/214439/3 | 8990 | 0.000 | 0 |
| candidate-19-http-shared-1 | 1.180671 / 10.247171 | 0/0 | 5700/5700/1620 | 7/0/0 | 3/3/3/0 | 0/5 | 30104/30101/3 | 9094 | 0.000 | 0 |
| main-19-http-shared-1 | 13337.886719 / 13334.578833 | 8657/5768 | 5700/5700/1683 | 167/0/0 | 1/1/1/0 | 0/5 | 214442/214439/3 | 10744 | 0.000 | 0 |
| audit-19-http-shared-1 | 391.380991 / 1451.342584 | 116/248 | 5700/5700/1620 | 4/0/0 | 1/1/1/0 | 0/5 | 214442/214439/3 | 9106 | 0.000 | 0 |
| audit-19-http-shared-2 | 390.856703 / 1415.447730 | 242/309 | 5700/5700/1620 | 5/0/0 | 1/1/1/0 | 0/5 | 214442/214439/3 | 9118 | 0.000 | 0 |
| main-19-http-shared-2 | 18303.942655 / 18296.348559 | 131/4144 | 5700/5700/1691 | 764/294/0 | 1/1/1/0 | 0/5 | 214747/214744/3 | 9382 | 0.000 | 0 |
| candidate-19-http-shared-2 | 1.022463 / 3.901507 | 2/0 | 5700/5700/1620 | 0/0/0 | 3/3/3/0 | 0/5 | 30104/30101/3 | 9134 | 0.000 | 0 |
| candidate-19-http-shared-3 | 1.089535 / 7.091370 | 1/1 | 5700/5700/1620 | 9/0/0 | 3/3/3/0 | 0/5 | 30104/30101/3 | 9086 | 0.000 | 0 |
| main-19-http-shared-3 | 6052.380671 / 15024.932072 | 1241/1067 | 5700/5700/1664 | 210/0/0 | 1/1/1/0 | 0/5 | 214442/214439/3 | 10422 | 0.000 | 0 |
| audit-19-http-shared-3 | 404.488191 / 1405.011210 | 31/421 | 5700/5700/1620 | 6/0/0 | 1/1/1/0 | 0/5 | 214442/214439/3 | 9098 | 0.000 | 0 |
| candidate-37-stdio-independent-1 | 2.533375 / 29.290428 | 1/0 | 11100/11100/3636 | 50/0/0 | 77/77/77/0 | 0/5 | 53202/53199/3 | 13670 | 0.000 | 0 |
| main-37-stdio-independent-1 | 110.166015 / 311.910412 | 11/11 | 11100/11100/10531 | 739/0/0 | 75/430/430/0 | 180/180 | 194653/193436/1217 | 878 | 491.892 | 3875 |
| audit-37-stdio-independent-1 | 30.081023 / 110.096515 | 0/0 | 11100/11100/7574 | 882/0/0 | 75/290/290/0 | 185/185 | 249755/248856/899 | 8026 | 1806.306 | 1211026 |
| audit-37-stdio-independent-2 | 30.736383 / 150.967881 | 1/0 | 11100/11100/7781 | 818/0/0 | 75/297/297/0 | 185/185 | 249637/248693/944 | 7752 | 1713.514 | 1176521 |
| main-37-stdio-independent-2 | 91.750399 / 270.906988 | 39/0 | 11100/11100/10611 | 964/0/0 | 75/423/423/0 | 184/184 | 192225/191027/1198 | 857 | 425.225 | 3167 |
| candidate-37-stdio-independent-2 | 4.095999 / 30.554621 | 0/0 | 11100/11100/4702 | 56/0/0 | 77/77/77/0 | 0/5 | 51618/51615/3 | 12448 | 0.000 | 0 |
| candidate-37-stdio-independent-3 | 3.205119 / 35.590529 | 0/0 | 11100/11100/3182 | 54/0/0 | 77/77/77/0 | 0/5 | 54068/54065/3 | 13750 | 0.000 | 0 |
| main-37-stdio-independent-3 | 87.490559 / 250.673788 | 0/5 | 11100/11100/10716 | 897/0/0 | 75/431/431/0 | 168/168 | 137183/135903/1280 | 626 | 300.901 | 1587 |
| audit-37-stdio-independent-3 | 29.999103 / 131.772799 | 1/0 | 11100/11099/8041 | 872/1/1 | 75/304/304/0 | 185/185 | 244552/243585/967 | 7866 | 1767.727 | 1213685 |
| candidate-37-stdio-shared-1 | 2.732031 / 45.565104 | 1/0 | 11100/11100/5021 | 40/0/0 | 77/77/77/0 | 0/5 | 55320/55317/3 | 16920 | 0.000 | 0 |
| main-37-stdio-shared-1 | 88.997887 / 408.942462 | 10/27 | 11100/11100/10655 | 1132/0/0 | 76/392/392/0 | 178/178 | 164141/162978/1163 | 1182 | 394.595 | 2537 |
| audit-37-stdio-shared-1 | 30.408703 / 133.190268 | 0/0 | 11100/11100/7455 | 669/0/0 | 75/242/242/0 | 185/185 | 304107/303351/756 | 10804 | 2366.667 | 1139356 |
| audit-37-stdio-shared-2 | 21.938175 / 192.805337 | 1/2 | 11100/11100/5950 | 832/0/0 | 75/197/197/0 | 185/185 | 349096/348528/568 | 12918 | 2811.712 | 1354942 |
| main-37-stdio-shared-2 | 75.038719 / 288.069228 | 0/0 | 11100/11100/10500 | 793/0/0 | 75/403/403/0 | 185/185 | 223432/222258/1174 | 1827 | 620.721 | 5247 |
| candidate-37-stdio-shared-2 | 2.299903 / 38.036176 | 0/0 | 11100/11100/4963 | 40/0/0 | 77/77/77/0 | 0/5 | 55400/55397/3 | 17114 | 0.000 | 0 |
| candidate-37-stdio-shared-3 | 2.260991 / 33.031488 | 1/0 | 11100/11100/4800 | 25/0/0 | 77/77/77/0 | 0/5 | 55432/55429/3 | 17538 | 0.000 | 0 |
| main-37-stdio-shared-3 | 71.499775 / 211.248284 | 31/7 | 11100/11100/10604 | 876/0/0 | 75/395/395/0 | 180/180 | 186020/184852/1168 | 1353 | 468.468 | 3381 |
| audit-37-stdio-shared-3 | 29.278207 / 209.104783 | 0/0 | 11100/11100/6703 | 630/0/0 | 75/219/219/0 | 185/185 | 322460/321793/667 | 11426 | 2481.982 | 1255986 |
| candidate-37-http-independent-1 | 1.507327 / 18.671434 | 0/0 | 11100/11100/3537 | 51/0/0 | 3/3/3/0 | 0/5 | 53590/53587/3 | 13220 | 0.000 | 0 |
| main-37-http-independent-1 | 35030.827007 / 35012.479239 | 18321/11328 | 11100/5533/0 | 8998/8651/5567 | 1/1/1/0 | 0/5 | 227695/227692/3 | 5295 | 0.000 | 0 |
| audit-37-http-independent-1 | 15879.634943 / 15876.832887 | 14203/11080 | 11100/10991/0 | 5666/4952/109 | 1/1/1/0 | 0/5 | 416670/416667/3 | 9540 | 0.000 | 0 |
| audit-37-http-independent-2 | 17054.040063 / 17053.284109 | 20191/8221 | 11100/10669/0 | 6027/5514/431 | 1/1/1/0 | 0/5 | 404466/404463/3 | 8784 | 0.000 | 0 |
| main-37-http-independent-2 | 37010.538495 / 36992.569047 | 16071/16023 | 11100/5292/0 | 9006/8749/5808 | 1/1/1/0 | 0/5 | 221744/221741/3 | 5224 | 0.000 | 0 |
| candidate-37-http-independent-2 | 1.287167 / 8.513368 | 0/0 | 11100/11100/2922 | 53/0/0 | 3/3/3/0 | 0/5 | 54478/54475/3 | 13984 | 0.000 | 0 |
| candidate-37-http-independent-3 | 1.231871 / 12.052943 | 0/0 | 11100/11100/2712 | 49/0/0 | 3/3/3/0 | 0/5 | 54818/54815/3 | 14018 | 0.000 | 0 |
| main-37-http-independent-3 | 35097.935871 / 35093.447451 | 12933/31010 | 11100/5035/0 | 8586/8341/6065 | 1/1/1/0 | 0/5 | 213928/213924/4 | 6006 | 0.000 | 0 |
| audit-37-http-independent-3 | 19864.223743 / 19856.007114 | 5572/4597 | 11100/9874/0 | 6200/5632/1226 | 1/1/1/0 | 0/5 | 378680/378676/4 | 8554 | 0.000 | 0 |
| candidate-37-http-shared-1 | 1.286143 / 9.051527 | 2/0 | 11100/11100/4591 | 36/0/0 | 3/3/3/0 | 0/5 | 55972/55969/3 | 17457 | 0.000 | 0 |
| main-37-http-shared-1 | 24662.507519 / 24647.078204 | 11509/12965 | 11100/6347/1885 | 7741/7369/4753 | 1/1/1/0 | 0/5 | 256471/256467/4 | 7733 | 0.000 | 0 |
| audit-37-http-shared-1 | 13119.782911 / 13112.553036 | 6619/10891 | 11100/11100/3326 | 4623/3761/0 | 1/1/1/0 | 0/5 | 420521/420518/3 | 10684 | 0.000 | 0 |
| audit-37-http-shared-2 | 13262.389247 / 13258.022845 | 2298/2145 | 11100/11100/3320 | 2170/1268/0 | 1/1/1/0 | 0/5 | 418737/418734/3 | 14334 | 0.000 | 0 |
| main-37-http-shared-2 | 31977.373695 / 31976.393637 | 13391/13920 | 11100/6648/1996 | 8776/8385/4452 | 1/1/1/0 | 0/5 | 265723/265719/4 | 5624 | 0.000 | 0 |
| candidate-37-http-shared-2 | 1.413119 / 8.214622 | 3/2 | 11100/11100/4517 | 32/0/0 | 3/3/3/0 | 0/5 | 55982/55979/3 | 17538 | 0.000 | 0 |
| candidate-37-http-shared-3 | 2.736127 / 10.538776 | 2/1 | 11100/11100/6058 | 33/0/0 | 3/3/3/0 | 0/5 | 53690/53687/3 | 15122 | 0.000 | 0 |
| main-37-http-shared-3 | 34561.064959 / 34539.983726 | 4825/6325 | 11100/6672/1996 | 8182/7716/4428 | 1/1/1/0 | 0/5 | 266803/266799/4 | 6861 | 0.000 | 0 |
| audit-37-http-shared-3 | 13404.995583 / 13404.071820 | 3843/5099 | 11100/11100/3324 | 4032/3161/0 | 1/1/1/0 | 0/5 | 420103/420100/3 | 11840 | 0.000 | 0 |

Loop boundary lateness is the observed histogram reset and final sample relative to the scheduled window. The runtime's completedWindow field checks the nominal tail only. Some controls reset late under load; their histograms exclude early nominal work or include drain work. The JSON retains every boundary and observed interval. These reported histogram comparisons retain that limitation; missing histogram observations are not reconstructed.


Exact normalized row hashes agree in 27/72 pairs; response hashes agree in 27/72 pairs. Committed histories reconcile in 72/72 pairs. Numeric row revisions, row order, controller flags, receipts and tombstones stay in the comparison. Concurrent commit ordering, shared-task guards and failed calls remain observable; the artifact records each exact mismatch and its own history validation.

**Acceptance: unmet.**


| Candidate/control comparison | Common / before-only / after-only committed keys | Common payload mismatches | Paired original successful mutation replies / mismatches | Differing revision guards | Exact rows / replies |
|---|---:|---:|---:|---:|---|
| audit-1-http-independent-1 / candidate-1-http-independent-1 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| main-1-http-independent-1 / candidate-1-http-independent-1 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| audit-1-http-independent-2 / candidate-1-http-independent-2 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| main-1-http-independent-2 / candidate-1-http-independent-2 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| audit-1-http-independent-3 / candidate-1-http-independent-3 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| main-1-http-independent-3 / candidate-1-http-independent-3 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| audit-1-http-shared-1 / candidate-1-http-shared-1 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| main-1-http-shared-1 / candidate-1-http-shared-1 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| audit-1-http-shared-2 / candidate-1-http-shared-2 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| main-1-http-shared-2 / candidate-1-http-shared-2 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| audit-1-http-shared-3 / candidate-1-http-shared-3 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| main-1-http-shared-3 / candidate-1-http-shared-3 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| audit-1-stdio-independent-1 / candidate-1-stdio-independent-1 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| main-1-stdio-independent-1 / candidate-1-stdio-independent-1 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| audit-1-stdio-independent-2 / candidate-1-stdio-independent-2 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| main-1-stdio-independent-2 / candidate-1-stdio-independent-2 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| audit-1-stdio-independent-3 / candidate-1-stdio-independent-3 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| main-1-stdio-independent-3 / candidate-1-stdio-independent-3 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| audit-1-stdio-shared-1 / candidate-1-stdio-shared-1 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| main-1-stdio-shared-1 / candidate-1-stdio-shared-1 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| audit-1-stdio-shared-2 / candidate-1-stdio-shared-2 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| main-1-stdio-shared-2 / candidate-1-stdio-shared-2 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| audit-1-stdio-shared-3 / candidate-1-stdio-shared-3 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| main-1-stdio-shared-3 / candidate-1-stdio-shared-3 | 132/0/0 | 0 | 132/0 | 0 | True / True |
| audit-19-http-independent-1 / candidate-19-http-independent-1 | 2508/0/0 | 0 | 2508/0 | 0 | False / False |
| main-19-http-independent-1 / candidate-19-http-independent-1 | 2508/0/0 | 0 | 2508/0 | 0 | False / False |
| audit-19-http-independent-2 / candidate-19-http-independent-2 | 2508/0/0 | 0 | 2508/0 | 0 | False / False |
| main-19-http-independent-2 / candidate-19-http-independent-2 | 2508/0/0 | 0 | 2508/0 | 0 | False / False |
| audit-19-http-independent-3 / candidate-19-http-independent-3 | 2508/0/0 | 0 | 2508/0 | 0 | False / False |
| main-19-http-independent-3 / candidate-19-http-independent-3 | 2508/0/0 | 0 | 2508/24 | 0 | False / False |
| audit-19-http-shared-1 / candidate-19-http-shared-1 | 726/0/0 | 0 | 726/0 | 0 | True / True |
| main-19-http-shared-1 / candidate-19-http-shared-1 | 638/19/88 | 0 | 638/0 | 1862 | False / False |
| audit-19-http-shared-2 / candidate-19-http-shared-2 | 726/0/0 | 0 | 726/0 | 0 | True / True |
| main-19-http-shared-2 / candidate-19-http-shared-2 | 639/14/87 | 0 | 639/0 | 1843 | False / False |
| audit-19-http-shared-3 / candidate-19-http-shared-3 | 726/0/0 | 0 | 726/0 | 0 | True / True |
| main-19-http-shared-3 / candidate-19-http-shared-3 | 653/27/73 | 0 | 653/0 | 1691 | False / False |
| audit-19-stdio-independent-1 / candidate-19-stdio-independent-1 | 2508/0/0 | 0 | 2508/0 | 0 | False / False |
| main-19-stdio-independent-1 / candidate-19-stdio-independent-1 | 621/0/1887 | 0 | 406/9 | 0 | False / False |
| audit-19-stdio-independent-2 / candidate-19-stdio-independent-2 | 2508/0/0 | 0 | 2508/0 | 0 | False / False |
| main-19-stdio-independent-2 / candidate-19-stdio-independent-2 | 1420/0/1088 | 0 | 1098/0 | 0 | False / False |
| audit-19-stdio-independent-3 / candidate-19-stdio-independent-3 | 2508/0/0 | 0 | 2508/0 | 0 | False / False |
| main-19-stdio-independent-3 / candidate-19-stdio-independent-3 | 1604/0/904 | 0 | 1308/0 | 0 | False / False |
| audit-19-stdio-shared-1 / candidate-19-stdio-shared-1 | 629/97/97 | 0 | 629/0 | 1824 | False / False |
| main-19-stdio-shared-1 / candidate-19-stdio-shared-1 | 373/46/353 | 0 | 362/0 | 1843 | False / False |
| audit-19-stdio-shared-2 / candidate-19-stdio-shared-2 | 635/91/91 | 0 | 635/0 | 1710 | False / False |
| main-19-stdio-shared-2 / candidate-19-stdio-shared-2 | 300/1/426 | 0 | 283/0 | 1862 | False / False |
| audit-19-stdio-shared-3 / candidate-19-stdio-shared-3 | 634/91/92 | 0 | 634/0 | 1748 | False / False |
| main-19-stdio-shared-3 / candidate-19-stdio-shared-3 | 396/54/330 | 0 | 374/0 | 1824 | False / False |
| audit-37-http-independent-1 / candidate-37-http-independent-1 | 4781/0/103 | 0 | 3602/12 | 0 | False / False |
| main-37-http-independent-1 / candidate-37-http-independent-1 | 2654/0/2230 | 0 | 2100/4 | 0 | False / False |
| audit-37-http-independent-2 / candidate-37-http-independent-2 | 4683/0/201 | 0 | 3773/48 | 0 | False / False |
| main-37-http-independent-2 / candidate-37-http-independent-2 | 2516/0/2368 | 0 | 2083/2 | 0 | False / False |
| audit-37-http-independent-3 / candidate-37-http-independent-3 | 4334/0/550 | 0 | 3434/0 | 0 | False / False |
| main-37-http-independent-3 / candidate-37-http-independent-3 | 2382/0/2502 | 0 | 1957/6 | 0 | False / False |
| audit-37-http-shared-1 / candidate-37-http-shared-1 | 1227/2/93 | 0 | 1166/0 | 3626 | False / False |
| main-37-http-shared-1 / candidate-37-http-shared-1 | 743/1/577 | 0 | 736/0 | 3626 | False / False |
| audit-37-http-shared-2 / candidate-37-http-shared-2 | 1232/6/88 | 0 | 1195/0 | 3515 | False / False |
| main-37-http-shared-2 / candidate-37-http-shared-2 | 777/1/543 | 0 | 748/0 | 3626 | False / False |
| audit-37-http-shared-3 / candidate-37-http-shared-3 | 1228/2/83 | 0 | 857/0 | 3626 | False / False |
| main-37-http-shared-3 / candidate-37-http-shared-3 | 780/1/531 | 0 | 625/0 | 3626 | False / False |
| audit-37-stdio-independent-1 / candidate-37-stdio-independent-1 | 2132/0/2752 | 0 | 1248/0 | 0 | False / False |
| main-37-stdio-independent-1 / candidate-37-stdio-independent-1 | 259/0/4625 | 0 | 117/9 | 0 | False / False |
| audit-37-stdio-independent-2 / candidate-37-stdio-independent-2 | 2072/0/2812 | 0 | 1100/0 | 0 | False / False |
| main-37-stdio-independent-2 / candidate-37-stdio-independent-2 | 209/0/4675 | 0 | 63/10 | 0 | False / False |
| audit-37-stdio-independent-3 / candidate-37-stdio-independent-3 | 2085/0/2799 | 0 | 1127/0 | 0 | False / False |
| main-37-stdio-independent-3 / candidate-37-stdio-independent-3 | 164/0/4720 | 0 | 88/8 | 0 | False / False |
| audit-37-stdio-shared-1 / candidate-37-stdio-shared-1 | 628/57/689 | 0 | 521/0 | 3626 | False / False |
| main-37-stdio-shared-1 / candidate-37-stdio-shared-1 | 34/3/1283 | 0 | 29/0 | 3626 | False / False |
| audit-37-stdio-shared-2 / candidate-37-stdio-shared-2 | 832/74/486 | 0 | 750/0 | 3589 | False / False |
| main-37-stdio-shared-2 / candidate-37-stdio-shared-2 | 58/2/1260 | 0 | 48/0 | 3626 | False / False |
| audit-37-stdio-shared-3 / candidate-37-stdio-shared-3 | 721/66/599 | 0 | 650/0 | 3552 | False / False |
| main-37-stdio-shared-3 / candidate-37-stdio-shared-3 | 46/6/1274 | 0 | 43/0 | 3626 | False / False |
Original successful mutation reply field differences across the paired comparisons: `{"changedFields": 132, "changes": 132}`. Each original successful reply is independently checked against its one committed effect. A same-key retry can settle first and make the original return a stored reply with replayed=true. Replay flags and delta differences remain in exact hashes and mismatch counts. Update changedFields and changes must match their own committed predecessor; all remaining paired fields must agree.

Recorded acceptance failures: `[{"loop":"one or more cohort medians regressed or are incomplete"},{"measurementWindow":"histogram boundaries exceed the configured resolution; nominal-window coverage is unverified","samples":39,"probeResolutionMs":10}]`.


Original uncertain mutation replies include warmup and measured calls; their measured failures and latencies remain in each sample. Final disposition counts: `{"committedEffect": 1836, "noEffectAtTeardown": 62262, "receipt": 10482, "recoveryReply": 0, "unresolved": 0}`.

Recovery retries the original mutation tool with its original arguments and request key, at most 19 concurrently under a 300-second budget. It can admit a previously unexecuted mutation after the measured window. Final-state reconciliation proves each key has at most one effect and agrees with the durable rows after retries and teardown; it does not convert an original failed call into a successful measured reply. The legacy queried field counts retry attempts. Per-attempt recovery timestamps were not recorded.

Raw SDK tool errors without a boolean ok field are uncertain replies for forensic reconciliation. The frozen recovery classifier did not retry those completed SDK errors. Their SQL effect or absence after teardown is still checked independently. API recovery unknown counts and final unresolved effects remain separate.

Process counts cover observed fixture runtimes and launchers. All database connection balances, per-process commits, SQLite waits, logical lease refusals and their durations remain in the JSON record. The SQL contention denominator uses completed measured calls; lease refusals are shown separately. Call phases follow offer timestamps, while SQL and HTTP counters follow observation timestamps, so work can cross a window boundary.

Analysis version 4 retains normalization version 2. The comparer controls and any old-oracle red proofs are retained in the JSON record. Whole-millisecond commit and offer observations in the same bin do not establish ordering; the lower visibility bound requires commit < offer.

Method observations: `{"excludedInterSampleDiagnostics":[{"drainedAt":1792123380.25043,"phase":"owner polling diagnostic","reason":"The first cohort is mathematically unable to meet the strict audit p99 bound; drain the current measurement before an isolated attribution-bookkeeping diagnostic.","requestedAt":1792123022.11324,"result":"Neither attribution nor owner polling proved a reliable fix. Product source remains frozen at 97c1a8bc1; complete all scheduled cohorts.","resumedAt":1792124288.8029156,"sample":"candidate-1-stdio-independent-3"},{"phase":"waiting for unchanged sample","reason":"Drain the current unchanged sample before isolating periodic worker-health supervision.","requestedAt":1792124525.5653012,"result":"Heartbeat ablation was not a reliable improvement. Keep verified health supervision and complete all 108 scheduled samples.","resumedAt":1792125318.8770738,"sample":"main-1-stdio-independent-3"},{"phase":"waiting for unchanged sample","reason":"Drain current sample before isolating the separate guardian owner poll.","requestedAt":1792127202.0044699,"result":"Guardian owner-poll ablation was not an improvement. Keep verified ownership and finish all 108 scheduled samples.","resumedAt":1792127878.5942845,"sample":"main-1-stdio-shared-2"}],"progressObserverChange":{"afterCompleteSamples":36,"afterSha256":"e1ff014a8a1ff4eddf9713add4036dc670b43ed48d3197d11593225f9aa38bf8","appliedAt":1792135172063,"beforeSha256":"f6e8252145eacb7b7e8589fe72795cf7bf5a6710cfd92aa259dbe84bbfda2ee8","observedCompleteSamples":36,"reason":"Bounded progress reads after the complete one-client block; source binaries, load and SQL observer stay frozen."}}`.

The matrix contains 615,600 measured offers. The candidate completed 205,200
calls, including 60,371 failures, with none pending after reconciliation.
Matched main completed 174,127 of 205,200 offers, including 95,321 failures,
with 31,073 pending. The audit completed 203,433 of 205,200 offers, including
63,194 failures, with 1,767 pending. All 108 histories reproduce their final
rows, and all 72 pairs have equal common committed task payloads. Fourteen
copied-record controls and three window controls pass. Exact normalized row
and response hashes each agree in 27 of 72 pairs; the tables retain the other
outcomes and their causes.

The two one-client stdio cohorts still fail the strict loop criterion. In the
independent-task cohort, candidate median p99/max is 0.264959/3.001259 ms,
compared with 0.213759/2.785111 ms on matched main and 0.204799/2.478469 ms
on the audit. The shared-task cohort also regresses. Thirty-nine histograms
have start or end lateness beyond the requested 10 ms resolution. These
measurements cannot certify nominal-window coverage, and the acceptance
artifact remains false. The later merges of main and analysis-only changes
have no new performance measurements in this record.

The native SQL observer control now declares its isolated temporary parent as
`MCP_BENCH_SCRATCH_ROOT`. Without that declaration, the observer's default
`/tmp` boundary rejects a test isolated under another temporary tree. The
matrix collector already supplied its boundary explicitly; this fixture fix
changes none of the recorded samples.

## Receipt contention and initialization recovery (2026-10-17)

Focused regressions in `src/lib/mcp/http.test.ts` exercise the production HTTP
handler and a real stdio SDK child, with private home, config, temp and state
directories. Each regression also ran independently against the pre-fix branch
at `d72c31992`, with the same test and lock-holder fixture.

A separate process holds `BEGIN IMMEDIATE` on `mcp-receipts.sqlite` for 1.2
seconds after a stdio `list_flows` warmup. A fresh keyed call completed on both
versions. The pre-fix Viewer timer gap reached 1235.006 ms and failed the 50 ms
bound. With asynchronous receipt admission, the gap was 8.392 ms and the
largest measured synchronous SQL attempt was 0.525 ms. The keyed response
replays, and a subsequent send plus its original-key retry produces one
delivery.

The startup regression first warms a task call, then holds the receipt write
lock for 6.2 seconds while the first inline read and send initialize together.
Both receive explicit errors after the five-second admission budget, with no
delivery. Once the holder exits, the same Viewer serves the original read key,
a fresh read key, and the original send key; replaying that send produces no
second delivery. The pre-fix branch fails the first recovery assertion because
its rejected inline initializer remains cached.

`src/lib/mcp/server.test.ts` also exercises every receipt write transition
under a held lock and verifies that a contended completion retries persistence
without repeating its binding. Its concurrent-start fixture now uses the same
async initializer as production, checks only asynchronous admission diagnostics,
and retains its schema migration, stored receipt and child cleanup assertions.
Failed constructor attempts close their connections before retrying. These
focused observations supplement the historical matrix above; they do not
replace or recalculate its samples.
