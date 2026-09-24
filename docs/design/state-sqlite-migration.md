# All persistent Viewer state in SQLite: store audit and migration design (#1870)

Status: design. No product code changes in this document.
Audit date: 2026-09-19, against `main` at `91119894`. Production state was observed read-only.

## Originating requirement

Source: issue #1870, the second seat comment, "Operator decisions, 2026-09-19 (paraphrased in English)". The comment is itself a published English paraphrase, quoted here verbatim:

> - Maximum scope: every Viewer state file with persistent writes moves into SQLite; only what must stay a file stays (pre-database markers read by deploy scripts and the launcher, pure caches, external config).
> - The 63 MB `agent-registry.json` mirror goes away: the registry lives in SQLite only.
> - Migration for existing installs (npm users included): on first boot the new code imports the legacy JSON file into SQLite, verifies the import, then removes the file (a renamed copy is kept for one release as a safety net), and runs on SQLite from then on. The legacy import path is deleted a few months later; a dated follow-up issue tracks that removal.
> - An architect verifies the store list in code before anything is built, and the work runs with priority, in parallel with the other lanes.

The acceptance line from the first seat comment on the same issue: "a writer killed mid-transaction loses at most that transaction, a corrupted database falls back to the newest backup by itself and raises an incident." The issue body adds: "it never serves 500s until a human repairs it."

The pinned stage specification also names agent transcripts as a store that stays a file.

## Decisions in one page

1. **Every durable Viewer store that is not a marker, cache, credential, transcript or artifact joins `state.sqlite`.** They go through the existing `SqliteStateCollection` (`src/lib/state/sqliteStateStore.ts`), one collection per store, keyed per record: 29 store families across 9 PRs (table in §2.1). No new database file is introduced. The existing separate databases stay as they are: the agent registry, MCP receipts, the runtime journal, the handoff queue and transcript search.
2. **The first-boot import reuses one helper, written in slice 1.** The helper holds the legacy file's own write lock, imports in one `BEGIN IMMEDIATE` transaction, and verifies counts plus a row digest before `COMMIT`. It then renames the file to `<name>.imported-<release>` and **leaves a tombstone directory at the old path**. A stale writer (an old release's MCP process or a manual downgrade) then fails with EISDIR, and cannot silently create a file that nothing reads.
3. **For one release after each slice, a rollback release that predates it gets its JSON back.** The existing demotion checkpoint writes the legacy file from SQLite. On roll-forward, a per-row revision merge folds back what the rollback release changed.
4. **`agent-registry.json` goes away in one slice.** Every process that opens the registry currently parses the 63 MB file eagerly and rewrites it on start. Three readers read the file directly. Each gets a SQLite source, and the `off`/`dual-write`/`read` modes lose their default role (§5).
5. **Durability:** keep WAL with `synchronous=FULL` (it is already set). Run a full `integrity_check` at activation (measured at 69–177 ms). Take a `VACUUM INTO` backup every 10 minutes when anything changed (measured at 0.2–0.33 s for each database). Keep 15 generations, within a 2 GB budget. If the database is unreadable, the Viewer falls back to the newest backup that passes its check, keeps the damaged files, and raises a visible incident.
6. **Slice 1 is tasks.** `tasks.pending.json` does not exist, in code or on disk (§3). The task store's three sections (`tasks`, `recentCreates`, `migrations`) move together.
7. The legacy import path is removed under **#1872** (due 2026-12-15). A live defect found during the audit is filed as **#1873**: WakaTime state has been all NUL bytes since the crash, and every sync pass fails on it.

## 1. How the inventory was built

The list comes from code. I searched for `statePath(...)` literals, for every quoted `*.json`, `*.ndjson`, `*.jsonl` and `*.sqlite` name under `src/`, `scripts/` and `bin/`, and for the write primitives in each owner module: `writeFileSync`, `renameSync`, `appendFileSync`, `fsyncSync`, `withFileTransaction*` and `writeJsonDurably`. I then matched the results against a read-only `ls -la` of the production `state/` directory and the config directory. The live directory is written below as `state/`.

Legend for **write pattern**:
- **D**: durable temp file, fsync of the file, rename, fsync of the directory (`writeJsonDurably` or an equivalent).
- **R**: temp file and rename with **no fsync**. A crash after the rename can leave a zero-length or NUL-filled file. This is the #1870 failure.
- **W**: `writeFileSync` **in place** with no temp file. A crash mid-write tears the file even without a power loss.
- **A**: append.
- **S**: already SQLite.

## 2. Inventory and classification

Sizes and last-write times come from the production directory at about 19:30 local time on 2026-09-19. "Readers" lists processes other than the owner's own Viewer request path. "MCP" means the per-session MCP stdio process (`bin/mcp-server.mjs` → `src/lib/mcp/entry.ts`), which runs the store modules in-process on the host. "Host" means the runtime host (`src/runtime-host/main.ts`).

### 2.1 MOVE into `state.sqlite`

| # | Store (path under `state/`) | Owner module | Other readers / writers | Pattern | Size · last write | What is lost if it vanishes | Slice |
|---|---|---|---|---|---|---|---|
| 1 | `tasks.json` (sections `tasks` 1 338, `recentCreates` 100, `migrations`) | `src/lib/tasks/store.ts` (`atomicWriteJson`, L47-51) | MCP (task tools), seat-tick controller (`mutateTasksFile`), `/api/files` projection key (`PROJECTION_STATE_FILES`), project-alias collision scan (`projects/aliases.ts` reads the file raw), 5 capture scripts that seed it | **R**, whole-file rewrite on every task change | 2.1 MB · 19:29 | the whole board: statuses, titles, details, placement, create-idempotency receipts, one-time migration markers | 1 |
| 2 | `board.json` (`projects` ×64: placements, hidden groups, board history) | `src/lib/board/store.ts` | MCP (`boardFor`, `applyBoardCommand`), staging deploy fingerprints it (`scripts/deploy-staging.ts` `PROD_STATE_EVIDENCE_FILES`) | D, whole-file | 2.5 MB · 19:28 | every placement, pin, hidden group and the board history | 3 |
| 3 | `orchestrator-seats.json` (seats 16, pending 2, revocations 113, history 13, `nextSeatEpoch`) | `src/lib/orchestrator/seats.ts` (`atomicWriteJson`, L183) | MCP (seat authority), seat-tick sources | **R** | 0.55 MB · 13:54 | seat designations and epochs; a pending designate-and-inject intent | 4 |
| 4 | `bridge-reports.json` (500 reports, 670 retired ids) | `src/lib/bridge/store.ts` | MCP (`bridge_report`), `/api/files` projection key | D, whole-file journal | 0.6 MB · 17:40 | the manager report log and the dedupe of replayed reports | 4 |
| 5 | `bridge.json` and `bridge-channels/<hash>.json` ×26 (channel cursor state) | `src/lib/bridge/store.ts` | MCP | D | 0.2 MB · Sep 17 | gateway read cursors (re-delivery or skips) | 4 |
| 6 | `attention.json` (50 requests) | `src/lib/attention/store.ts` | MCP (`readAttentionFile`) | D | 88 KB · 17:56 | open attention requests | 5 |
| 7 | `reply-suggestions.json` | `src/lib/suggestions/store.ts` | MCP | D | 28 KB · 19:28 | suggestion sets and admission receipts | 5 |
| 8 | `seat-tick-settings.json` (17 projects) | `src/lib/monitor/seatTickSettings.ts` | MCP | D | 30 KB · 13:24 | per-project tick cadence, off switches, standing notes | 5 |
| 9 | `push-subscriptions.json`, `push-sent.json` | `src/lib/push.ts` | — | **W** | 1.2 KB, 3.3 KB · 08:55, 07:19 | browser push registrations; sent-dedupe (duplicate pushes) | 5 |
| 10 | `review-loop-presets.json`, `workflow-templates.json`, `role-presets.json` (absent on this machine), `spawn-nesting.json` (absent) | `flows/store.ts`, `workflows/store.ts`, `roles/store.ts`, `agent/nestingPolicy.ts` | MCP | **R** | 2–3 KB · Sep 8, Aug 8 | operator-edited presets and policy | 5 |
| 11 | `root-lineage.json` | `src/lib/root/store.ts` | — | D | 160 B · Jul 26 | root-session rollover lineage | 5 |
| 12 | `project-aliases.json` | `src/lib/projects/aliases.ts` (`persistProjectAliases`) | files route key, scanner | **R** | 0.8 KB · Jul 31 | project merges (history fragments into lookalike projects) | 6 |
| 13 | `project-curation.json` | `src/lib/projects/curation.ts` | files route key | **R** | 1.5 KB · Sep 11 | hidden and pinned projects | 6 |
| 14 | `worktree-map.json` (1 585 entries) | `src/lib/scanner/describe.ts` (`persistWorktreeMap`) | files route key, aliases | **W in place** | 0.27 MB · 17:38 | regrouping of deleted sibling worktrees (AGENTS.md recognizer #6); not rebuildable once a checkout is gone | 6 |
| 15 | `session-titles.json` (82) | `src/lib/session/titleStore.ts` | — | **R** | 19 KB · Sep 2 | custom conversation titles | 6 |
| 16 | `claude-accounts.json`, `codex-accounts.json` (includes #1857's removal journal) | `accounts/claude.ts`, `accounts/codex.ts` | MCP, host (spawn), registry (`*-accounts.json` path rewrite) | claude: D; codex: **R** | 0.6 KB each · 16:27, 10:20 | the account list, the active account and in-flight removals | 7 |
| 17 | `account-project-bindings.json`, `account-project-overrides.json` | `accounts/projectBindings.ts`, `accounts/accountOverrides.ts` | MCP, spawn routes | D | 2.7 KB, 1.4 KB | project → account pins | 7 |
| 18 | `spawn-admission-fences.json` | `src/lib/agent/spawnAdmission.ts` | spawn routes | **R** | 5.6 KB · 07:02 | spawn admission fences | 7 |
| 19 | `account-mutation-revision.json` | `src/lib/accounts/accountMutation.ts` | all account writers | D | 32 B · 19:29 | cross-store account revision; becomes the collection revision | 7 |
| 20 | `claude-auth-operations.json`, `codex-login-attempts.json` | `accounts/claudeLogin.ts`, `accounts/codexRuntime.ts` | MCP | D / **R** | 2 B, 1.6 KB · 19:29 | in-flight login operations | 7 |
| 21 | `migration-provider-operations/*.json` (582 dirs), `migration-provider-claude-operations/` | `src/lib/accounts/migration/provider.ts` | — | per-record files | 4.8 MB | conversation-migration operation records | 7 |
| 22 | `limits-history.json` (17 series) | `src/lib/limitsHistoryStore.ts` | — | **R** | 0.34 MB · 19:22 | the 7-day burndown history; polled samples cannot be re-fetched | 8 |
| 23 | `wakatime-state.json` | `src/lib/wakatime/sync.ts` (`writeStateFile`, L980) | — | **R** | 3.05 MB · Sep 10, **all NUL bytes now** (#1873) | stream materialization state (heartbeats re-sent or skipped) | 8 |
| 24 | `reaper-state.json` (`userAuthoredPaths` 4 484, `scannedAt` 1 927) | `src/lib/reaperRuntime.ts` (`atomicWrite`, L95) | files route key, `reaperAuthorship.ts` | **R**, a 1 MB rewrite each cycle | 1.0 MB · 19:29 | `firstObservedAt` and authorship verdicts; reaping stalls until rescans finish | 8 |
| 25 | `handoff-lineage.json` (2 399 edges) | `src/lib/handoffLineage.ts` | scanner | **W in place** | 0.95 MB · Sep 17 | historical handoff edges for old sessions (not rebuildable) | 8 |
| 26 | `lifecycle-journal.json` (2 000 events, 8 000 retired ids), `lifecycle-digests.json` | `src/lib/lifecycle/journal.ts`, `digest.ts` | MCP (`lifecycle_events`) | D, whole-file journal | 1.2 MB · 14:59 | the lifecycle event log and replay dedupe | 8 |
| 27 | `seat-tick/runs.ndjson` | `src/lib/monitor/journalStore.ts` | `/api/monitor/runs` parses it back | A (lock queue) | 0.22 MB · 19:31 | the seat-tick run audit | 8 |
| 28 | `codex-reset-credits.ndjson` | `src/lib/accounts/resetCreditJournal.ts` | accounts UI parses it back | A + rename rotation | 5 KB · Sep 11 | the usage-limit reset credit ledger | 8 |
| 29 | `claude-delivery-ledger/<session>.jsonl` | `src/lib/runtime/claudeStreamBrokerHost.ts` | runtime-image reachability | A, per session | 26 MB | queued and delivered records for Claude structured sessions. **Moves into `runtime-events.sqlite`**, because the runtime host owns it | 9 |

### 2.2 STAY a file (each with the reader or reason that forbids SQLite)

| Store | Reason it stays | Required change |
|---|---|---|
| `viewer-release.json`, `runtime-host-release.json`, `runtime-host-rollback-target.json`, `runtime-host-rollback-intent.json`, `runtime-host-handoff-intent.json`, `viewer-gateway.json`, `runtime-host-startup/*.json`, `viewer-deployment-adapter-process.json`, `deployments/**` | **Read before any database opens** by the launcher. `bin/mcp-server.mjs` reads `viewer-release.json` under Node to pick the bundle to run. The runtime host and the deployment adapter read them to decide which release owns traffic and the socket. | none (already durable) |
| `hot-state-authority.json` | Decides **which process may open `state.sqlite` for writing** (`hotStateSqliteWriterReady`). Moving it inside the database it gates would be circular. | none (already D) |
| `agent-registry.backend.json` | Pre-database marker that tells a reader which registry database to open (`registryBackendIdentity.ts`) | narrowed in §5 |
| `runtime-host.sock.lock`, `wakatime-scheduler-owner.json`, `*.write-locks/`, `agent-registry.json.locks/` (per-session operation locks), `account-selection.lock.queue/` | Cross-process locks and leases. They must be claimable while the database is busy or unhealthy. | stale-directory cleanup (§2.3) |
| `push-keys.json`, `operator-spawn-capability`, `runtime-events.sqlite.key`, `telegram/connector-token`, and the config-level `token`, `service.env`, `soniox-api-key`, `wakatime-api-key` | **Credentials.** Keeping them out of the database keeps them out of every backup generation and every export. | none |
| `telegram/` (`session.json`, `connection.json`, `connector.json`, venv, vendor) | Read by the Python connector and `bin/telegram-session-validator.mjs`, which have no Bun SQLite. | `reports.json` and `registrations.json` are Viewer-only (`telegram/reportStore.ts`, `hostRegistration.ts`). Confirm there is no Python reader, then move them with slice 5. |
| `accounts/<engine>/<name>/` (config level) | External config: the engine CLI's own config homes | none |
| `structured-host-events/*.jsonl` (**7.3 GB**) | Transcript class: the structured host's copy of each agent event stream. The operator exempted transcripts. Writes are append-only with a torn-tail-safe reader (`durableRuntimeEventTailSeq`), so the whole-file rewrite failure does not apply. | none |
| `runtime-images/` (163 MB), config `inbox/` attachments, `flows/<id>/` review artifacts (502 MB), `scratch/`, `orchestrator/handoff-digests/`, `diagnostics/`, `backups/` | Blobs and artifacts that agents and humans read as files | none |
| `events.ndjson` (+`.1`), `reaper-journal.ndjson`, `host-retirement-journal.ndjson` | Diagnostic logs **with no reader in code** (`src/lib/events.ts` says nothing parses it back; the other two are write-only). They are append-only with rotation. People read them with shell tools. | none |
| `project-catalog.json` (7 MB), `files-scan-snapshot.json`, `files-response-cache*.json`, `files-response-results/` (123 MB), `limits-cache.json`, `resources-observation.json`, `host-retirement-report.json`, `reaper-report.json`, `task-inbox-scan.json`, `bg-commands.json`, `compact-chains.json`, `codex-lineage.json` | **Rebuildable caches.** Each is derived from transcripts, the filesystem, a live poll or the last run, and losing it costs one rescan. | slice 10: one durable write helper (temp, fsync, rename, directory fsync). An unparseable cache is discarded and rebuilt. `codex-lineage.json`, `bg-commands.json` and `compact-chains.json` are written **in place** or without fsync today. |
| `view-presence.json`, `flow-pipeline-controller-heartbeat.json` | Cross-process heartbeats with a 2-minute retention. They are rebuilt within one heartbeat interval. | slice 10 helper |

### 2.3 DELETE (dead)

| Store | Evidence | When |
|---|---|---|
| `orchestrator.json` | No reference in product code; only tests mention it | slice 10 |
| `pipelines.sqlite`, `registry.sqlite` (0 bytes) | No reference in `src/`, `scripts/` or `bin/` | slice 10 |
| `mcp-receipts.json` (34 MB, Aug 4) | Imported by `SqliteMcpReceiptStore.importLegacyFile` under the `legacy_import_v2` marker | #1872 |
| `seat-tick.json` (Sep 8) | Migrated into `state.sqlite` collection `seat-tick-v3` (`SeatTickAccounting.migrateLegacy`) | #1872 |
| `flows.json`, `pipelines.json`, `pipelines-archive.json` (23 MB), `workflows.json` | Rollback mirrors, written only at demotion. Every retained release has read these collections from SQLite since 2026-08-08 (#956). | #1872 |
| 28 `agent-registry.json.write-lock.owner.pending-*` directories and `retired-*` symlinks (July) | Left over from the `off`/`dual-write` era; production has been in `sqlite` mode since 2026-07-29 | slice 2 |
| stray `*.tmp` files (a 6.7 MB `.project-catalog.json…tmp`, nine `viewer-deployment-adapter-process.json.phase…tmp`, and others) | Temp files left by killed writers | slice 10: sweep temp files whose owner PID is dead, the rule the registry already applies (`cleanupStaleTempFiles`) |
| `resume-panes.json`, `legacy-tmux-migration-complete*` | tmux era; `src/lib/tmux.ts` still references them | left to the tmux removal work, out of scope |

### 2.4 Already SQLite (no move)

| Database | Contents | Owner |
|---|---|---|
| `state.sqlite` (43 MB + 4.4 MB WAL) | `flows` 332, `pipelines` 201, `pipelines_archive` 1 234, `workflows` 1, `seat-tick-v3` 3 359 rows | Viewer, MCP, workers |
| `agent-registry.sqlite` (95 MB) | the registry | Viewer, host, MCP |
| `mcp-receipts.sqlite` (68 MB) | MCP idempotency receipts | MCP |
| `runtime-events.sqlite` (305 MB) | runtime journal | runtime host |
| `handoff-queue.sqlite` | handoff queue | runtime |
| `transcript-search.sqlite` (1.6 GB) | search index; rebuildable, `synchronous=NORMAL` | Viewer |

## 3. What the seat's census got right and what it missed

The seat's census was right about tasks, board, seats, bridge reports, attention, suggestions, seat-tick settings, accounts, the worktree map, the four journals, the histories, the registry mirror and the caches. The code says differently on these points:

1. **`tasks.pending.json` does not exist.** Nothing in product code names it, and it is not on disk. The only writer is `scripts/capture-issue-1586-task-bands.ts`, which writes its own scratch file. The store's real extra sections are `recentCreates` and `migrations` inside `tasks.json`. Slice 1 covers all three.
2. **Project aliases are not in SQLite.** `project-aliases.json` is still written by temp file and rename with no fsync (`persistProjectAliases`). `state.sqlite` holds flows, pipelines, the archive, workflows and seat-tick only.
3. **The registry mirror is not "rewritten continuously".** In `sqlite` mode the `AgentRegistry` constructor does two things on every process start: it parses the whole 63 MB JSON as `initialSnapshot` (`registry.ts`, the argument to `new SqliteAgentRegistryStore`), and it rewrites the mirror (`mirrorSqliteSnapshot`). Over a 60-second sample the mirror changed at 19:29 and 19:34 and not in between, which fits process starts: Viewer workers, the runtime host, and MCP processes that touch the registry.
4. **Two stores are written in place, with no temp file:** `worktree-map.json` (`describe.ts:430`) and `handoff-lineage.json` (`handoffLineage.ts:132`). A crash mid-write tears them even without a power loss. `codex-lineage.json` does the same.
5. **WakaTime state is still broken.** It is not merely a file that was zeroed in the crash: `wakatime-state.json` is 3 050 588 NUL bytes with a last-write time of Sep 10. `readJson` rethrows the parse error, so every sync pass fails. Filed as #1873.
6. **Stores the census missed:** `bridge.json` and `bridge-channels/*`; `project-curation.json`; `session-titles.json`; `push-subscriptions.json` and `push-sent.json`; the four preset and policy files; `root-lineage.json`; `account-mutation-revision.json`; `claude-auth-operations.json`; `codex-login-attempts.json`; `codex-reset-credits.ndjson`; `migration-provider-*operations/`; `seat-tick/runs.ndjson`; `lifecycle-digests.json`; `claude-delivery-ledger/`; the Telegram report and registration files; the diagnostic ndjson logs; and `structured-host-events/`, which at 7.3 GB is the largest store in the directory.
7. **Readers the census missed**, which would break silently when the file disappears:
   - `/api/files` keys its persisted projection cache on the mtime of `tasks.json`, `project-aliases.json`, `project-curation.json`, `worktree-map.json`, `reaper-state.json` and `bridge-reports.json`.
   - The project-alias collision scan reads `tasks.json` raw.
   - `overlayResourceSessionTitles` reads `agent-registry.json` directly.
   - Runtime-image reachability reads `agent-registry.json`.
   - The staging deploy fingerprints `board.json`, `agent-registry.json`, `pipelines.json` and `flows.json`.
   Every one of these is in the file fence of the slice that moves its store.
8. **Dead files:** `orchestrator.json` and the two zero-byte `.sqlite` files.

## 4. Target design

### 4.1 One database for Viewer-owned collections

Every MOVE row joins `state.sqlite` through `SqliteStateCollection`. That gives one migration ledger (`state_collections`), one backup, one integrity check and one release fence (`hot-state-authority.json`). The existing design (`docs/state-hot-stores-sqlite.md`) chose one shared file for the same reasons, and its "Phase boundary" section already named tasks, attention, aliases and the worktree map as the next wave.

Write volume does not argue for a second file. The busiest new writers are tasks, board and reaper-state, at single-digit transactions per second. With WAL and a 5 ms busy retry, SQLite serializes them in well under the current cost of rewriting a 2 MB file.

The exception is the **Claude delivery ledger**. The runtime host owns it, and the runtime host already owns `runtime-events.sqlite`, so the ledger joins that database (slice 9). A different process owner is the reason the operator's rule allows a separate file.

### 4.2 Schema: reuse the generic tables

No new table is needed for collections. Each store becomes one collection in `state_rows(collection, row_key, value_json, row_order, row_revision, controller_active)`. When a store's sections must commit together, they share one collection and use a key prefix per kind. `seat-tick-v3` already does this, with `project:` and `legacy:` rows. It lets `patchSync` commit a task and its idempotency receipt in one transaction without inventing a multi-collection sync primitive.

| Collection | Keys (prefix: value) | Notes |
|---|---|---|
| `tasks` | `t:<taskId>`: the persisted row exactly as stored (extension fields preserved, as `persistedRows` does today); `r:<clientRequestId>`: RecentCreate; `m:<name>`: `{ name, appliedAt }` | `row_order` = the legacy array order. `controller_active` = status is not `done`. Receipts stay bounded at 100, pruned in the create transaction. |
| `board` | `p:<project>`: that project's board document | An edit rewrites about 40 KB instead of 2.5 MB. |
| `orchestrator_seats` | `meta` (schemaVersion, nextSeatEpoch), `seat:<project>`, `pending:<key>`, `revocation:<id>`, `history:<n>`, `rollback:<id>` | Designate-and-inject stays atomic inside one collection. |
| `bridge_reports` | `meta` (lastSeq, trim marks), `e:<reportId>`: one report, `x:<reportId>`: a retired id in retirement order, `answer:<ref>`, `pending:<ref>` | The journal shape (§4.4), keyed by the report id so a replay is a key lookup. Shipped in slice 4. |
| `bridge_channels` | `manager` (the unscoped `bridge.json`), `channel:<hash>` (each `bridge-channels/<hash>.json`) | A separate collection because the manager appends reports while the gateway advances cursors, and a busy log must not block a cursor write. The legacy source is a file plus a directory of per-record files, so the import digests every file by name and bytes, like the slice 7 journal roots. |
| `attention`, `reply_suggestions`, `seat_tick_settings`, `push`, `presets`, `root_lineage` | one row per request, set, admission, project, endpoint or preset | Today's store-level `revision` field becomes the collection revision. As shipped for attention and reply suggestions (slice 5), it travels in a `meta` row instead: the collection revision restarts at the import, so only a stored field can continue from the file's number and never run backwards. Seat tick settings keep the per-row revision `seat_tick_settings` derives from the row itself. |
| `projects` | `alias:<source>`, `curation:<project>`, `worktree:<cwd>`, `title:<conversationId>` | One scanner-owned collection. The files route keys on its revision. |
| `accounts` | `claude:<id>`, `codex:<id>`, `active:<engine>`, `retired:<engine>:<id>`, `removal:<id>`, `binding:<project>`, `override:<key>`, `fence:<key>`, `authop:<id>`, `login:<id>` | `account-mutation-revision.json` becomes the collection revision. One transaction covers a removal and its journal step, which #1857 does across two files today. |
| `account_migration_ops` | `op:<hash>` | |
| `limits_history`, `wakatime`, `reaper`, `handoff_lineage` | one row per series, stream, path or edge, plus `meta` | The reaper's 1 MB-per-cycle rewrite becomes an upsert of the paths that changed. |
| `lifecycle`, `seat_tick_runs`, `reset_credits` | journal shape (§4.4) | |

Each collection carries `schemaVersion: 1` and a `migrationId` of `<file>-json-v1`.

One small table is added next to the generic tables, for import evidence (§6.2):

```sql
CREATE TABLE IF NOT EXISTS state_imports (
  collection TEXT PRIMARY KEY REFERENCES state_collections(collection) ON DELETE CASCADE,
  source_name TEXT NOT NULL,          -- e.g. "tasks.json"
  source_sha256 TEXT,                 -- raw bytes of the file that was imported; NULL when absent
  source_bytes INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  row_digest TEXT NOT NULL,           -- sha256 over value_json of imported rows in row_order
  gap TEXT,                           -- null, or why the legacy file could not be read
  release TEXT,                       -- importing release revision, when deployed
  imported_at TEXT NOT NULL,
  mirror_sha256 TEXT,                 -- last rollback mirror written at demotion
  mirror_revision INTEGER
);
```

It uses `CREATE TABLE IF NOT EXISTS` and no `ALTER`, so older releases that open the same database simply ignore it.

### 4.3 Cross-process access rules

The writers are the Viewer (in the container, `bun-container`), the runtime host (container), the per-session MCP stdio processes (on the host, under the operator's Bun), and the Viewer's workers (inventory and files-response). All of them already share `state.sqlite` on one local filesystem, so WAL shared memory works today.

- **Writes** go only through `SqliteStateCollection`: the lease, `BEGIN IMMEDIATE`, the bounded busy retry that surfaces `FileTransactionBusyError` (the store's existing "… is busy" message), and `assertSqliteWriteAuthority` on every mutation. New collections inherit the release fence unchanged.
- **Reads** open read-only connections and never create schema (`readStateCollection*`).
- **Schema DDL and first-boot import** run only where `assertSqliteInitializationAuthority` passes: the activated release, or a process with no release target (npm installs, development, tests).
- **Fixtures and tests** pass a legacy path, and the database is derived as `dirname(path)/state.sqlite`. `seatTickState.ts` `accountingFilename` already follows this convention. Tests stay isolated in mkdtemp directories.
- **Cache invalidation** switches from file mtimes to `readStateCollectionRevisions`, following what `/api/files` already does for flows and workflows.

**Observed fact that shapes the migration.** None of the 10 live MCP wrapper processes carries `LLV_HOT_STATE_RELEASE_REVISION` (read from `/proc/<pid>/environ`). #958 treats them as unidentified local clients and admits them once the active release has activated. A session's MCP process therefore keeps running the bundle it loaded at launch, across deploys, and the release fence does not stop an **old-code** MCP process from writing a legacy JSON file after its store moved. The tombstone in §6.2 closes that gap.

### 4.4 Append-only journals

The four journal stores (lifecycle, bridge reports, seat-tick runs, reset credits) share the shape `lifecycle/journal.ts` introduced: a monotonic `seq`, an idempotent append keyed by a caller-stable string, a capacity trim, and a retired-id list that stops a late replay from re-adding a trimmed entry. In SQLite:

- An entry is a row keyed `e:<stable key>` with `{ seq, recordedAt, … }`, and `row_order = seq`. `meta` holds `lastSeq`. An append inserts the entry and bumps `meta` in one transaction. A duplicate key is a no-op, which gives the same idempotency as today.
- **Pruning:** when an append pushes the live count over the store's cap (2 000 lifecycle events, 500 bridge reports, and the others' existing caps), the same transaction replaces the oldest `e:` rows with `x:<key>` retired markers (value `{ seq }`). It also deletes the oldest `x:` rows beyond the retired cap (8 000 lifecycle, 670 bridge). Both steps are bounded to 1 000 rows per transaction, like `CHANGE_PRUNE_BATCH`. Readers page with `keyRange`.
- Diagnostic logs that nothing reads back stay files (§2.2).

## 5. `agent-registry.json`: who reads it and how SQLite becomes the only store

Production has run `mode: "sqlite"` since 2026-07-29 (`agent-registry.backend.json`). What still touches the JSON:

| Site | What it does | Change |
|---|---|---|
| `AgentRegistry` constructor, `initialSnapshot: readFile(filename, …)` | **Parses 63 MB on every process start**, even when SQLite is initialized. The only consumer is `importFirstBoot`. | Pass a lazy loader. It is called only when `registry_meta` has no import marker. |
| Constructor, `read` and `sqlite` modes: `mirrorSqliteSnapshot`, `fenceAheadMirror` | Rewrites the 63 MB mirror on every start. Refuses to start if the mirror revision is ahead. | Delete in `sqlite` mode. An "ahead" check needs a mirror, and there no longer is one. |
| `checkpointRollbackMirror`, `checkpointRollbackMirrorForDemotion`: Viewer `onFenceRequested` and `onDemoted` (`viewerInstrumentation.ts:805-821`), deployment adapter (`scripts/runtime-host-viewer-adapter.ts:981`) | Writes the mirror for a rollback release | Delete. Every retained rollback release runs the registry in `sqlite` mode, and in that mode a missing mirror only means the constructor writes one. `sqliteMirrorRevision` returns null on ENOENT. |
| `off` and `dual-write` modes, the `agent-registry.json.write-lock` directory, `compactAtStartup`, `synchronizeDualWriteStartup` | JSON is the authority | Only meaningful for installs still on `off`, below. |
| `titleProjection.ts` `readOnlyRegistryProjection` (used by `overlayResourceSessionTitles`, the `/api/resources` path) | Reads and parses the JSON directly, keyed on its mtime | Use `agentRegistry().readOnlySnapshot()`, keyed on the SQLite revision (`storageDiagnostics().revision`). |
| `runtimeImageStore.ts` `collectRuntimeImageReachableDigests` | Collects digests from the JSON **and** the SQLite rows | Drop the JSON branch. |
| `scripts/deploy-staging.ts` `PROD_STATE_EVIDENCE_FILES` | Fingerprints the JSON to prove staging left production alone | Replace with `agent-registry.sqlite`. Only `viewer-release.json` is a violation today anyway. |
| `identityWaveStartup.ts` | Names the file for descriptor resolution and compaction | Adjust to the descriptor and SQLite. |
| `agent-registry.json.locks/` (`withOperationLock`) | Per-session operation locks | **Keep the path.** Two releases overlap during a handoff, so they must contend on the same lock directory. The name is historical and harmless. |

**Default mode.** `registryBackendModeFromEnvironment` defaults to `off`, so an npm or source install without `LLV_AGENT_REGISTRY_SQLITE` still keeps the registry in JSON. The docs say the CLI turns SQLite on only when the gate is set. SQLite-only therefore also means changing the default.

**Exact steps (slice 2):**
1. Make `initialSnapshot` lazy.
2. Resolve the mode: the environment value if set, otherwise the published descriptor, otherwise **`sqlite`**. Accept `off`, `dual-write` and `read` only when set explicitly, and log a deprecation warning.
3. **Detect the first boot of a JSON-authoritative install:** the descriptor says `off` or `dual-write`, or there is no descriptor and the JSON exists.
   - If the SQLite file already holds a marker from an earlier experiment, move the SQLite trio aside as `agent-registry.sqlite.stale-<ts>`. This is the documented rebaseline step 6, automated.
   - Import the JSON through the existing `importFirstBoot`.
   - Verify the entity count and the digest of the normalized snapshot against the SQLite snapshot.
   - Rename the JSON to `agent-registry.json.imported-<release>` and publish the descriptor as `sqlite`.
   The step is idempotent because the descriptor flips last.
4. In `sqlite` mode, stop writing the mirror. On the first start after this change, rename an existing `agent-registry.json` to `agent-registry.json.imported-<release>` (production's 63 MB copy). Also delete the 28 dead `write-lock.owner.pending-*` directories and `retired-*` symlinks, but only those whose recorded owner PID is dead.
5. Remove the Viewer and adapter demotion calls to `checkpointRollbackMirrorForDemotion`, and the three direct readers above.
6. Candidate health already compares the configured and observed registry modes (`src/runtime-host/candidateContainer.ts`). Extend its allowed-mode list to accept "unset". Unset resolves to `sqlite`.

**What breaks without the mirror:** nothing in the current code base once the three readers move. A rollback to a release older than this slice runs in `sqlite` mode (the environment is unchanged), finds no mirror, and writes one at start. This was checked in the constructor: `sqliteMirrorRevision` returns null, and the parity assertion runs only in `read` mode. A rollback that set the environment to `off` would come up on the renamed file's absence with an empty registry. The release notes say not to do that. The documented `off` rollback procedure in `docs/agent-registry-sqlite.md` is retired in the same PR.

## 6. Migration

### 6.1 Where the import runs

- **Deployed releases.** `establishHotStateCutoverBoundary` already runs in the promoted release and marks `state.sqlite` cutover-ready. Right after it, the activating release calls `ensureLegacyCollectionsImported()` for every registered legacy store before it starts controllers. A candidate that is not yet promoted cannot import: `assertSqliteInitializationAuthority` throws `FileTransactionBusyError` there, so its task routes answer busy until promotion. This is today's behaviour for the hot collections.
- **npm, source and test.** With no release target, the store's first open imports lazily through the same function.
- **Registry.** Registry-only steps are in §5.

### 6.2 One store's import (the helper written in slice 1)

`importLegacyCollection({ collection, legacyPath, parse, toRows, schemaVersion, migrationId })`:

1. Take the **legacy store's own file-transaction lock** (`withFileTransactionSync(legacyPath)`, the `…json.write-locks` queue). Every legacy writer, including old-release code, runs its read-modify-write under this same lock, so none can interleave with the import.
2. If the `state_imports` row exists, jump to step 6 (reconcile or finish).
3. Read the file.
   - **ENOENT:** import an empty collection with no gap.
   - **Parse failure, NUL-filled or truncated file:** import an empty collection with `gap = "legacy-unreadable"`, rename the file to `<name>.unreadable-<ts>`, and raise the incident (§7.4). The data was already gone; the board serves empty and the incident points at the newest backup.
   - **EIO, EACCES and other I/O errors:** throw a busy error and retry later, because they may be transient.
4. In one `BEGIN IMMEDIATE` transaction:
   - Insert the collection marker and rows. Assert that the keys are non-empty and unique; `insertSeed` already does this.
   - Read the rows back with `SELECT value_json … ORDER BY row_order` and compute `row_digest`.
   - Compare the digest and the count against the values computed from the parsed file. On mismatch, roll back and raise the incident.
   - Insert the `state_imports` row, with the raw-bytes `source_sha256`.
   - `COMMIT`.
5. Rename `<name>` to `<name>.imported-<release-or-timestamp>`. Create the **tombstone directory** `<name>/` containing a `README` that names the collection and the database. fsync the parent directory.
6. **Crash recovery and reconcile.** This step runs on every boot while a legacy path exists as a regular file and `state_imports` has a row.
   - The file's sha256 equals `source_sha256` or `mirror_sha256`: nothing changed since the import or the last mirror. Finish step 5.
   - It differs: a rollback release, or a writer that raced a crash between `COMMIT` and step 5, changed it. **Merge by row revision**: a legacy row wins when its revision is higher or the row is missing from SQLite. SQLite-only rows stay. Receipts and migration markers are unioned: one missing from the file is never deleted. Duplicate receipts for one `clientRequestId`, which the pre-#1870 `createTask` appended when a create was retried after its task was deleted, collapse to the newest entry here and in the first import, and the incident reports how many were dropped. Then finish step 5 and raise an informational incident with the counts. Tasks already carry revisions (`stampTaskRevisions`). A store whose rows carry no revision uses the legacy row when it differs, and the incident lists the keys.
   - A missing row deletes a SQLite row only when the file provably descends from the recorded mirror. Each rollback mirror carries its SQLite revision as a migration marker (`sqlite-mirror-revision`), which older releases carry through every write. A file without the recorded mirror's marker deletes nothing and the incident counts the rows it spared. That file can be the one an old writer creates when it finds the path empty, because an import or a mirror crashed between retiring the file and creating the tombstone after the lock was reclaimed. The marker is never imported as a row.
7. Release the lock.

**Why a tombstone directory.** Once the store is in SQLite, any code still holding the legacy module fails at once with EISDIR: its read throws, and its rename over a directory fails. That code can be an old-release MCP process that §4.3 showed the fence does not stop, the retiring Viewer's last in-flight write, or a manual npm downgrade. A plain rename instead leaves the legacy reader seeing an empty store, and its next create writes a fresh one-task file that nothing reads. A visible error is better than a silent split.

**Idempotence, and two importers at once.** Both importers queue on the legacy lock. The second one sees the `state_imports` row inside its own transaction, because the marker check re-runs after `BEGIN IMMEDIATE` (the `initializeStateCollections` pattern), and it goes to step 6, which finds nothing to do.

### 6.3 Writer switch

Within one PR, each store module swaps its internals and keeps its exported signatures. For tasks, that means `loadTasks`, `loadTasksFile`, `saveTasks`, `saveTasksFile`, `mutateTasks` and `mutateTasksFile`, with `filePath` still accepted. A read-modify-write becomes `collection.patchSync(() => { const current = snapshot(); …; return { records: changed, deleteKeys } })`, which re-reads under the lease, the same guarantee `withFileTransactionSync` gives today. Only changed rows are written. From that commit on, no code path writes the JSON, except the demotion mirror (§6.4).

### 6.4 Staging, rollback and downgrade

- **Staging.** A staging Viewer has its own state directory (`state-staging-*`), so its first boot runs the same import against its own copy. The staging deploy's production fingerprint list stops naming moved files (`board.json` in slice 3, `agent-registry.json` in slice 2).
- **Rollback to a release that predates a slice.** The collection is added to `checkpointHotStateRollbackMirrorsForDemotion`, the Viewer's fence acknowledgement, and to the deployment adapter's fence path. On demotion, the adapter removes the tombstone, writes `<name>` durably from one SQLite revision, and records `mirror_sha256` and `mirror_revision`. The rollback release then runs on its JSON as before. On roll-forward, step 6 merges what it changed.
  - Caveat: during the rollback window, new-code MCP processes (unidentified clients) may still write the SQLite collection, while the old Viewer writes the file. The merge heals this at roll-forward. Until then, the two views can differ.
  - A collection whose legacy form is a **directory of per-record files** (the conversation-migration journal roots of slice 7) mirrors the same way, one file per row: the demotion checkpoint clears each row's tombstone and writes `<record>.json` from one revision, and the root itself stays a directory because the per-operation lease lives in it. There is no single source digest to compare, so `mirror_sha256` stays null and the roll-forward merge compares **row by row** instead: a file the rollback release wrote or changed replaces its row, a file it added becomes one, and the tombstones then return. Keeping the record and dropping those files would lose one fork recovery per journal.
- **Ordering constraint.** The deployment adapter runs in the runtime host, which may be on older code. **Each slice's runtime-host change must be live before its Viewer is promoted**, following the existing practice of bootstrapping the runtime host first. Otherwise a crash-rollback that goes through the adapter alone would leave a tombstone that the rollback release cannot read.
  - `HotStateCheckpoint.revisions` is validated as exactly four keys. New collections record their mirror in `state_imports` and do not extend that record. That keeps old adapters, which parse the authority record, compatible.
- **Manual downgrade (npm).** There is no fence, so no mirror is written. The older version finds the tombstone and **fails closed**: task routes error with EISDIR, which names the path. Recovery is to upgrade again, or to replace the tombstone with the `.imported-*` copy, which loses the changes made since the migration. The release notes for each slice say this. An export command is deferred (§11).

### 6.5 Removing the legacy path

Tracked in **#1872** (https://github.com/Latand/live-log-viewer-next/issues/1872), due **2026-12-15**, and no earlier than two releases after the last slice. It deletes the import helpers, the reconcile step, the tombstones, the demotion mirrors (including those for flows, pipelines, the archive and workflows), and the registry's non-SQLite modes. It also converts fixtures and capture scripts that seed legacy JSON to seed through the store API. A single boot guard remains: it renames any leftover legacy file and raises an incident.

## 7. Durability

### 7.1 WAL and synchronous settings

`state.sqlite`, `agent-registry.sqlite`, `mcp-receipts.sqlite` and `handoff-queue.sqlite` already open with `journal_mode=WAL` and `synchronous=FULL`. Keep `FULL`. Each commit costs one WAL fsync, which is affordable at single-digit commits per second. `NORMAL` would allow the last commits before a power loss to vanish. Add `PRAGMA journal_size_limit = 67108864`, so a WAL that grew under a long reader is truncated back after a checkpoint. Keep the default `wal_autocheckpoint = 1000` pages, confirmed live. `transcript-search.sqlite` stays `NORMAL`, because it is a rebuildable index. I could not find where `runtime-events.sqlite` sets `synchronous`; slice 9 confirms the setting before the ledger moves there.

### 7.2 Integrity check at boot

The activating release runs `PRAGMA integrity_check` on `state.sqlite` and `agent-registry.sqlite` before it initializes collections. It runs `PRAGMA quick_check` on `mcp-receipts.sqlite` and `handoff-queue.sqlite`. Measured read-only on production (warm cache): `state.sqlite` took 69 ms for `integrity_check` and 177 ms for `quick_check`; `agent-registry.sqlite` took 63 ms and 157 ms. That is cheap enough to use the full check on the two databases that matter. Opening a database that fails with `SQLITE_CORRUPT` or `SQLITE_NOTADB`, or a check that does not return `ok`, leads to §7.4.

### 7.3 Backups: cadence and retention

The **active Viewer release** owns the timer. It is the only process that knows the database's migration state and holds write authority, and the timer re-arms at each activation. The timer is `VACUUM INTO 'state/backups/sqlite/<db>-<UTC timestamp>.sqlite.partial'`, followed by `integrity_check` on the copy, fsync, a rename to drop `.partial`, and a directory fsync. It runs every **10 minutes**, and it skips a database whose revision has not changed since its last backup (the sum of collection revisions, or the registry revision).

Measured from production into a temp directory: `state.sqlite` took 329 ms and produced 42 MB; `agent-registry.sqlite` took 218 ms and produced 85 MB. `VACUUM INTO` holds only a read transaction, so writers continue.

Retention, per database: the **newest 6** (one hour at full cadence), then **one per 4 hours for 24 hours** (6), then **one per day for 3 days** (3). That is 15 generations, about 1.9 GB for the two databases today, capped at a **2 GB** total budget: beyond the cap, the oldest daily and 4-hourly generations are evicted first, and the newest 3 are never evicted.

A backup is skipped with an incident when free space on the filesystem is below twice the database size. `mcp-receipts.sqlite` gets a daily backup with 3 generations. The runtime journal keeps its own retention (`docs/runtime-journal-retention.md`).

### 7.4 Automatic fallback and the incident it raises

When a database fails its open or its check at activation:
1. Move the damaged trio aside as `<db>.corrupt-<ts>{,-wal,-shm}`. They are never deleted automatically.
2. Try backups newest first. Copy each to `<db>.restoring`, run `integrity_check`, fsync, and rename into place. The first copy that passes wins.
3. If no backup passes, create a fresh empty database. The Viewer serves an empty store instead of 500s.
4. Raise the incident on two surfaces: a durable inbox task on the board (created after the restore, so it lands in the restored store), and a `systemHealth.storage` entry on `/api/files`. The entry names the database, the damaged file names, the backup used and its age, and whether the fresh-empty path was taken.
5. Rows written after that backup are lost. The incident states the backup's timestamp, so the gap is explicit.

A store whose rows fail to decode at runtime already surfaces through the store's own `onDecodeError`/`strictDecode` path. That behaviour is unchanged.

### 7.5 Loss bound

- **kill -9 of any writer:** at most the transaction in flight, and it rolls back as a whole. The WAL does not depend on the process, and leases held by a dead PID are reclaimed through the process-identity check.
- **Power loss or kernel crash:** committed transactions survive, because `FULL` fsyncs the WAL on every commit, provided the device honours flush. The transaction in flight is lost whole. The #1870 failure, a renamed but unwritten file, cannot happen to a SQLite row.
- **Media or filesystem corruption:** up to one backup interval, 10 minutes plus the time of the last change. The incident names the gap.
- **Stores that stay files:** caches are rebuilt; markers are already written durably; append logs can lose their last line, and their readers skip torn tails.

## 8. Delivery plan

Each slice is one PR. File fences list the files a slice owns. Every slice's tests run by path in mkdtemp state directories and never against the live directory. Each PR adds its collection to one shared list, `src/lib/state/legacyCollections.ts`, created in slice 1. The import driver, the demotion checkpoint and the adapter read that list, so parallel slices touch shared files only with a one-line addition.

**Common failure-inducing tests.** Each MOVE slice repeats this matrix against the production store module:
- (a) A **writer killed mid-transaction**: a child process `kill -9`'d inside `patchSync` loses only that transaction, and the next open sees the previous revision.
- (b) A **NUL-filled legacy file**: the import records a gap, renames the file to `.unreadable-*`, raises the incident, and serves an empty store without 500s.
- (c) A **half-finished import**:
  - crash before `COMMIT`: the retry imports;
  - crash after `COMMIT` but before the rename: finish, with no second import;
  - crash after the rename but before the tombstone: finish.
- (d) **Two processes importing at once**: exactly one import, with the same row digest seen by both.
- (e) A **legacy writer after import**: an old-code write fails with EISDIR, and nothing is lost.
- (f) **Rollback, then roll-forward**: the mirror is written, the legacy-side edits are merged by revision, and the incident carries the counts.
- (g) **Import verification failure**: an injected digest mismatch leaves the database unmarked and the legacy file untouched.

| # | Slice | File fence | Specific tests beyond (a)–(g) | Runs in parallel with |
|---|---|---|---|---|
| 1 | **Tasks** (tasks, receipts, migrations) + the import helper + `state_imports` + the legacy-collections list | `src/lib/tasks/store.ts`; new `src/lib/state/legacyImport.ts` and `src/lib/state/legacyCollections.ts`; `src/lib/state/sqliteStateStore.ts` (the `state_imports` DDL only); `src/lib/viewerInstrumentation.ts` (import call and demotion list); `scripts/runtime-host-viewer-adapter.ts` (fence checkpoint list); `src/app/api/files/route.ts` (`PROJECTION_STATE_FILES` → collection revision); `src/lib/projects/aliases.ts` (`collectionRecords` adds `tasks`); `src/lib/monitor/seatTickController.ts` (path argument only) | create plus receipt replay stays idempotent across the import; a revision-guarded patch (#1545) from two processes; the 1 338-task corpus imports with an equal digest; a files-route projection invalidates on a task write from another process | 2, 10 |
| 2 | **Registry SQLite-only** (§5) | `src/lib/agent/registry.ts` (constructor, mirror and modes), `src/lib/agent/registryBackendIdentity.ts`, `src/lib/session/titleProjection.ts`, `src/lib/runtime/runtimeImageStore.ts`, `scripts/deploy-staging.ts`, `src/lib/agent/identityWaveStartup.ts`, `src/runtime-host/candidateContainer.ts`, `docs/agent-registry-sqlite.md`, and the `viewerInstrumentation.ts` / adapter demotion lines (coordinate the one-line conflict with slice 1) | a registry open never reads the JSON when SQLite is initialized (count `readFileSync` calls); an `off`-mode install with the JSON migrates once and flips its descriptor last; a stale SQLite trio is set aside; a mirror is never rewritten on a restart | 1, 10 |
| 3 | **Board** | `src/lib/board/store.ts`, `scripts/deploy-staging.ts` (fingerprint list, after 2) | a per-project row write leaves other projects' rows untouched; the history cap | 4–8 (after 1) |
| 4 | **Seats and bridge** (seats, `bridge.json`, channels, reports) | `src/lib/orchestrator/seats.ts`, `src/lib/bridge/store.ts`, files route key line | designate-and-inject: a crash between the intent and the delivery; journal pruning with the retired-replay guard | 3, 5–8 |
| 5 | **Operator-facing small stores** (attention, suggestions, seat-tick settings, push, presets, nesting policy, root lineage, Telegram reports and registrations after confirming no Python reader) | the owner modules listed in §2.1 rows 6–11 | the attention revision is monotonic across the import | 3, 4, 6–8 |
| 6 | **Projects** (aliases, curation, worktree map, session titles) | `src/lib/projects/aliases.ts`, `curation.ts`, `src/lib/scanner/describe.ts`, `projectState.ts`, `src/lib/session/titleStore.ts`, files route key lines | AGENTS.md: "deleted worktree still groups under its parent repo" through the SQLite map, after the import | 3–5, 7, 8 |
| 7 | **Accounts** (registries, bindings, overrides, fences, mutation revision, login operations, migration operations) | `src/lib/accounts/*.ts` store modules, `src/lib/agent/spawnAdmission.ts`, `src/lib/accounts/migration/provider.ts` | a #1857 removal is atomic across the account row and its journal; the mutation revision equals the collection revision | 3–6, 8 |
| 8 | **Histories and journals** (limits history, WakaTime, reaper state, handoff lineage, lifecycle, seat-tick runs, reset credits) | `src/lib/limitsHistoryStore.ts`, `src/lib/wakatime/sync.ts`, `src/lib/reaperRuntime.ts` (state only), `src/lib/handoffLineage.ts`, `src/lib/lifecycle/*.ts`, `src/lib/monitor/journalStore.ts`, `src/lib/accounts/resetCreditJournal.ts` | the reaper cycle writes only the paths that changed; lifecycle replay after the trim is still refused; WakaTime's NUL legacy file (#1873) imports as a gap | 3–7 |
| 9 | **Claude delivery ledger → `runtime-events.sqlite`** | `src/lib/runtime/claudeStreamBrokerHost.ts`, the runtime-journal module, `runtimeImageStore.ts` (ledger branch) | a torn-tail legacy `.jsonl` imports its complete records only; the host restart replays delivered and queued state | 3–8 |
| 10 | **Durability** (§7) + **cache helper** + dead-file cleanup | new `src/lib/state/durability.ts` (check, backup, fallback), a hook in `viewerInstrumentation.ts` activation, `src/lib/state/durableJson.ts` (cache variant with discard-and-rebuild), the cache owners in §2.2, and a temp-file sweep | a **corrupted database** (bytes overwritten in a copy) is restored from the newest good backup with the incident; no readable backup yields a fresh database and no 500; backups are skipped without changes and evicted on budget; a NUL-filled cache is rebuilt without an error | 1, 2 |

Order and parallelism: 1, 2 and 10 start together. 3–9 start once slice 1 has merged, because they reuse its helper, and they can then run in parallel with each other. Slice 3 waits for 2 only for the one-line fingerprint list. Each slice's release notes carry the downgrade note from §6.4. The runtime-host part of each slice is deployed before its Viewer (§6.4).

Gates for every PR: `bunx tsc --noEmit --incremental false` (log to a file and read its exit code), the touched test files by path, `bun run build`, and the privacy gate.

## 9. Prior work consulted

- **#956, "move hot stores to SQLite"** (merged 2026-08-08) and `docs/state-hot-stores-sqlite.md`. This is the pattern reused here: one shared `state.sqlite`, per-collection revisions and change log, leases, the release fence, and JSON rollback mirrors written only at demotion. Its "Phase boundary" section lists tasks, attention, aliases and the worktree map as next.
- **The #956 review of 2026-08-06** (a Codex reviewer session, found through `search_transcripts` for "hot state migration sqliteStateStore cutover"). Its critical finding was that a retiring release's legacy write could land after the import and be lost. That led to the coordinated cutover boundary and the demotion checkpoint of every migrated collection. §6.2 closes the same class of bug for stores moved one at a time, using the legacy lock and the tombstone.
- **#958, "a local client is not fenced out of settled hot state"**, and the 2026-08-09 review of the promote-timeout fix. After the #956 wave, every deploy timed out at promote and rolled back until the fence was fixed. This design adds **no new handoff state**: new collections join the existing fence and demotion checkpoint, and mirror evidence lives in `state_imports`, not in the authority record, which old adapters parse.
- **`docs/agent-registry-sqlite.md`** and **#1349, "complete SQLite mirror recovery"**: the mode ladder and the mirror repair that §5 retires.
- `SeatTickAccounting.migrateLegacy` (a per-collection lazy import with a gap label for an unreadable legacy file) and `SqliteMcpReceiptStore.importLegacyFile` (an import-once marker) are the precedents for §6.2's gap handling and markers.
- A search for "agent-registry.json mirror remove rollback mirror" returned nothing, and nothing earlier had proposed removing the mirror.

## 10. What I could not confirm

- **Whether any process outside this repository reads `agent-registry.json`**, such as an operator's ad-hoc script. Inside the repository, the three direct readers in §5 are the whole list.
- **Whether the Telegram Python connector reads `reports.json` or `registrations.json`.** `bin/telegram-session-validator.mjs` reads `session.json` only; I did not audit the vendored connector source. Slice 5 confirms this before moving them.
- **The exact process list behind the registry mirror rewrites.** I observed rewrites at 19:29 and 19:34 and inferred process starts from the constructor code. I did not attribute them to PIDs.
- **Which Bun SQLite versions the host-side MCP processes and `bun-container` link.** WAL files are compatible across SQLite 3.x, and both already share `state.sqlite` today. That is the evidence; I did not check versions.
- **`runtime-events.sqlite`'s `synchronous` setting.** It is not found by grep. Slice 9 checks it.
- **Why `wakatime-state.json` carries a Sep 10 mtime with NUL content.** It fits delayed allocation losing data blocks while keeping metadata. Whether the loss happened on Sep 10 or in today's crash is not established (#1873).
- **Network filesystems.** WAL requires shared memory on one host. An npm user whose state directory is on NFS would already fail with the current `state.sqlite`, and nothing here detects that. See Deferred.

## 11. Deferred — not currently justified

- **A `state export-legacy` CLI for manual npm downgrades.** The tombstone makes a downgrade fail visibly, and re-upgrading recovers. Build it only if a downgrade report arrives.
- **Moving `structured-host-events/` (7.3 GB) into SQLite.** It is transcript class and append-only with a torn-tail-safe reader, so it is outside the operator's scope. Its growth is a retention question for a separate issue.
- **Moving the diagnostic ndjson logs.** Nothing reads them back, and people read them with shell tools.
- **Per-row child tables** (for example, a board table per card). The whole-row JSON with per-record keys already removes the whole-file rewrite, which is the cost that mattered.
- **A separate `journals.sqlite`.** The journal volume is small (below 2 MB in total), and a second file would need its own backup and fence.
- **Detecting unsupported filesystems for WAL**, and **compressed backups** (gzip shrinks the registry copy 6×, measured). Both are worth doing only if an install reports trouble or the 2 GB budget becomes a problem.
- **Salvaging rows from a corrupted database** (`.recover`). `bun:sqlite` does not expose it, and the damaged files are kept for a human.

## 12. Check against the originating requirement

- *"Every Viewer state file with persistent writes moves into SQLite; only what must stay a file stays."* §2.1 moves 29 store families across 9 slices. Every row in §2.2 names the pre-database reader, the credential, the transcript or artifact class, or the rebuildability that keeps it a file. Four rollback mirrors and three dead files go (§2.3).
- *"The 63 MB `agent-registry.json` mirror goes away."* §5, slice 2, with every reader and writer named.
- *"On first boot the new code imports the legacy JSON file, verifies the import, removes the file (renamed copy kept one release) … legacy import path deleted a few months later under a dated follow-up issue."* §6.2 covers the lock, the one-transaction import, the count and digest check, the `.imported-*` copy and the tombstone. §6.5 and #1872 (due 2026-12-15) cover the removal.
- *"An architect verifies the store list in code before anything is built."* §1–§3, including the ways the census differs from the code.
- *"A writer killed mid-transaction loses at most that transaction, a corrupted database falls back to the newest backup by itself and raises an incident … never 500s."* §7.4–§7.5, and tests (a) and slice 10.
- *"Slice 1 is tasks."* §8, slice 1.
