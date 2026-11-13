# SQLite histories and journals: remaining work

Inventory: 2026-10-23, starting at `134a29c6`, against the continuation of
`state-sqlite-migration.md` §2.1 and §8. The predecessor records slices 1–7
as shipped, including slices 5b and 6. This change delivers the lifecycle
digest cursor portion of slice 8. The other portions remain open.

## Lifecycle digest cursor contract

`src/lib/lifecycle/digest.ts` owns `lifecycle-digests.json`. Its only product
caller is the `lifecycle_events` MCP binding's digest mode in
`src/lib/mcp/bindings.ts`.
Acknowledging polls advance a cursor and a rate-limit timestamp; dry polls
read them; `seedLifecycleDigestCursor` initializes an absent unscoped cursor
at the journal head; `readDigestSubscriber` reads that unscoped cursor.
There is no other direct file reader or writer in tracked sources or scripts.

The default is version 1 with no subscribers. Each key is the existing
length-prefixed serialization of subscriber, project, pipeline and
conversation, including empty scope fields. Import preserves normalized
`cursorSeq`, `lastRelayAt` and `updatedAt` values. The existing normalizer
supplies cursor zero, a null last relay and the epoch timestamp for missing
fields. An unreadable legacy file starts an empty subscriber set, preserves
the damaged bytes and records the import gap. This can replay a digest.

The `lifecycle_digests` collection in `state.sqlite` holds one row per scope.
SQLite keys use JSON string encoding so arbitrary UTF-16 strings, including
lone surrogates, round-trip through row revision queries. Legacy imports and
rollback mirrors retain the original length-prefixed JSON object keys.
Reads use a keyed lookup. Empty and rate-held polls evaluate without writer
admission. A due acknowledgment reads and evaluates again inside its writer
transaction so a competing acknowledgment cannot emit the same relay twice.
Seeding and acknowledgment use a transaction with
a two-row-operation budget: one lookup and at most one upsert. No subscriber
snapshot is read during a poll, and no application cursor cache is added.
The journal content and relay policy remain unchanged. Busy journal reads
defer through the shared admission helper under `lifecycle.digest.journal`.

The shared `smallStore` and `LegacyDocumentStore` implementation provides
zero-timeout lock admission, release authority checks, count and digest
verification, import recovery, retained source bytes, tombstones and
revision-aware reconciliation. A storage refusal returns no successful
acknowledgment. `LEGACY_COLLECTIONS` registers activation import and the
demotion mirror, including the deployment adapter's existing checkpoint
path. A rollback release receives the original JSON document shape.
Roll-forward preserves rows SQLite changed after that mirror and merges
legacy edits to other rows.

## Remaining inventory

| Portion | Current source and remaining work |
|---|---|
| Limits history | Shipped: collection `limits_history` (`src/lib/limitsHistoryStore.ts`), one row per series and UTC day plus `meta` and the quarantined `unattributed:` series. A poll writes only the current day of the series it extends and nothing inside the five-minute gap; a roll-forward merges samples by timestamp. |
| Reaper state | Shipped: collection `reaper` (`src/lib/reaperState.ts`), one row per transcript path with its sticky authorship and path-scoped stamp. A cycle writes only the paths whose evidence changed; the board and the files projection key read the collection revision. The always-empty `firstObservedAt` and the file-mtime `observedAtSec` signal had no reader and are gone. |
| Handoff lineage | Shipped: collection `handoff_lineage` (`src/lib/handoffLineage.ts`), one row per pane, transcript or conversation edge. Every process reads the same rows; the oldest child edges past 20,000 and exited panes are removed at the next write. |
| Lifecycle events | Moved (slice 8b): collection `lifecycle`, layout in `src/lib/lifecycle/journal.ts` and the migration design §4.2. Sequence, events, retired ids and spawn-failure receipts move together; recovery events still join on read and fold in with the next append; a trimmed event's replay is refused. An unparseable legacy file is refused at import, so the journal never restarts at sequence 0. |
| Run journals | The seat tick journal moved (slice 8b): collection `seat_tick_runs` (another path is its own collection, named after the path), one row per check plus its timing, both legacy rings imported into one ordered list and mirrored back as both rings. In the Viewer the async append runs on a worker thread (`src/lib/monitor/seatTickJournalWorker.ts`), and seat tick commits use process durability, as the legacy rings were appended without an fsync. `conversation-monitor/runs.ndjson` stays a file: nothing writes it since the CLI monitor retired (#1245), the busiest installation has none, and its ring holds 200 small lines. |
| Reset credits | Moved (slice 8b): collection `reset_credits`, the newest 4,096 entries in redemption order. The import reads the current file, which is all the legacy reader showed, and leaves the rotated `.1` beside it. A failed append still answers `recorded: false`. |
| Claude delivery ledger | `src/lib/runtime/claudeStreamBrokerHost.ts` still owns per-session files in `claude-delivery-ledger`; `src/lib/runtime/runtimeImageStore.ts` includes them in reachability. Move complete records into `runtime-events.sqlite` and verify restart replay and reachability together. `src/runtime-host/journal.ts` already explicitly sets `synchronous = FULL`; retain it. |
| Durability and cleanup already shipped | `src/lib/state/durability.ts` implements checks, backups, retention, fallback incidents, `sweepStaleTempFiles` and `removeDeadStateFiles`; activation starts them. The dead-file list already covers `orchestrator.json` and empty `pipelines.sqlite` / `registry.sqlite`. Preserve this implementation. |
| Cache work still needed | `src/app/api/files/operatorProjection.ts:363` persists response bodies and metadata with asynchronous write/rename pairs that have no file or directory fsync. Finish that durable publication protocol without blocking the serving loop. Audit direct readers' discard/rebuild semantics, including `src/lib/runtime/structuredHostRetirementStatus.ts` and `src/lib/accounts/subscriptionApiConsent.ts`. |

The cache helper itself already exists in `src/lib/state/durableJson.ts`.
`src/lib/scanner/links.ts` uses it for background-command, compact-chain and
Codex-lineage writes. Limits, reaper reports, host-retirement reports,
view-presence and controller heartbeats also use it. Project catalogs and
scan snapshots use their own temp/file-fsync/rename/directory-fsync sequence;
resource observations do the same. Keep these already-durable writers.
No tracked product writer remains for `task-inbox-scan.json`.

Issues #1870, #1872, #1873 and #1904 were still open at inventory time.
The task store's first-touch marker probe in `src/lib/tasks/store.ts` still
calls `readStateImport` directly; #1904 remains separate. No WakaTime sync
implementation or `wakatime-state.json` reference exists in tracked product
sources, scripts or launchers at this revision; retain #1873 for reconciliation
with the retired integration.

## Compatibility and concurrent work

Retain imports, source archives, rollback mirrors, backups and fallback
incidents. #1872 removes compatibility on 2026-12-15, after at least two
releases following the last migration slice. Do not remove it in this lane.
The existing runtime-host deployment ordering in the migration plan applies.

At inventory time, none of the 36 open pull requests touched
`src/lib/lifecycle/digest.ts` or `src/lib/state/legacyCollections.ts`.
The group-chat lane's actual diff concerned bridge report presentation and
the legacy-flow lane's diff concerned frontend consumers. Their files are
outside this change.
