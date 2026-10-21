# Minimum SQLite and schema recovery

## Facts checked on 2026-10-21

`bun -e 'import { Database } from "bun:sqlite"; const db = new Database(":memory:"); console.log(Bun.version, db.query("SELECT sqlite_version()").get()); db.close()'`
reports Bun 1.4.0 and SQLite 3.53.2 on the Linux verification machine.

[Bun's SQLite documentation](https://bun.com/docs/runtime/sqlite) says macOS
uses Apple's system library; Linux and Windows statically link SQLite.
[Bun's installation requirements](https://bun.sh/docs/installation) require
macOS 13.0 or later. The [macOS 13.6.5 sqlite3 manual, mirrored by FreeBSD](https://man.freebsd.org/cgi/man.cgi?apropos=0&manpath=macOS+13.6.5&query=sqlite3&sektion=1)
identifies SQLite 3.39.5. These sources were read on 2026-10-21. The compatibility
floor is the 3.39 feature set. Apple's patch release has no upstream amalgamation;
the guard builds the last upstream 3.39 release,
[3.39.4](https://www.sqlite.org/releaselog/3_39_4.html), from the official
amalgamation and verifies the release's SHA3-256 of `sqlite3.c`.

Calling `Database.setCustomSQLite()` with that library on this Linux Bun
returns true, but `SELECT sqlite_version()` still reports 3.53.2. Consequently
the Linux test harness loads the library with `bun:ffi` and substitutes its
database module for both `bun:sqlite` imports and `process.getBuiltinModule`.
The guard runs that substitution only in an owned child (`minimumSqliteCases.fixture.ts`),
so other collected files keep their native module, process hook and version cache.
Every SQL prepare and step in the child then runs on 3.39.4. Seeding children
keep Bun's SQLite to produce databases written by a newer release.

## SQL audit

The inventory covers production SQL in `src/`, including runtime queries and
schema installers. Discover schema owners with
`rg -l 'CREATE (TABLE|VIRTUAL TABLE|TRIGGER|UNIQUE INDEX|INDEX)|ALTER TABLE' src --glob '*.ts'`;
exclude tests, fixture modules and child programs used only by tests.

| Store / schema owners | Newer feature found / compatible features retained |
| --- | --- |
| `src/lib/state/pipelineControllerReferences.ts` | Aggregate argument `ORDER BY` (3.44) and `jsonb_*` (3.45); replaced by text JSON and ordered subqueries. |
| `src/lib/state/historyProjection.ts` | Same newer features; older SQLite uses ordered subqueries and text JSON. Newer SQLite keeps binary intermediates for query performance. Persisted inputs are text on both. |
| `src/runtime-host/journal.ts` | `unixepoch(...,'subsec')` (3.42) silently yields NULL on 3.39; deployment ordering now uses `julianday()`. The old index stays on 3.42+ for older hosts. On 3.39 it is removed before writes: keys built on newer SQLite disagree with that NULL expression and otherwise fail `integrity_check` and row deletion. |
| `src/lib/state/sqliteStateStore.ts`, `pipelineControllerIndex.ts`, `pipelineControllerSchedule.ts`, `pipelineEvidenceIndex.ts` | JSON1, UPSERT, window functions, materialized CTEs and RETURNING are supported by 3.39. |
| `src/lib/agent/sqliteRegistryStore.ts`, `registryArchive.ts` | JSON1, partial/expression indexes, UPSERT and RETURNING; no later feature. |
| `src/lib/mcp/server.ts`, `boardSelection.ts` | MCP receipts and board-selection schema; no later feature. |
| `src/lib/runtime/handoffQueueStore.ts`, `deliveryProgress.ts`, `cpuAdmission.ts` | Handoff queue, delivery progress and CPU admission; no later feature. |
| `src/runtime-host/journalSessionMetadata.ts`, `nativeQueueJournal.ts` | Runtime journal extensions; no later feature. |
| `src/lib/search/transcriptSearch.ts`, `src/lib/scanner/conversationSearchProjection.ts` | FTS5 and JSON1; no later SQL feature. The minimum library enables FTS5. |
| `src/lib/memory/index.ts`, `deliveryLedger.ts` | Memory index and delivery ledger; no later feature. |
| `src/lib/activity/store.ts`, `tokenStore.ts`, `src/lib/team/store.ts` | Activity and team databases; no later feature. |
| `src/lib/telegram/bot/store.ts`, `outbound.ts` | Telegram store and outbox; no later feature. |

The feature boundaries come from SQLite's release notes for
[3.42](https://www.sqlite.org/releaselog/3_42_0.html),
[3.44](https://www.sqlite.org/releaselog/3_44_0.html) and
[3.45](https://www.sqlite.org/releaselog/3_45_0.html), read on 2026-10-21.

Using the system library requires no extra installation step on macOS. Updating
SQL also keeps a database portable between machines. There is no production
SQLite loader or extra dependency.

## Linux performance check

The [initial compatibility benchmark](../../evidence/sqlite-compatibility/performance.json)
includes its executable source, source hashes and all samples. It alternates
base `4df56467` and the fix in three fresh processes each, under one admitted
gate. Each process writes 48 validated pipelines with 12 attempts and 59,402
bytes per pipeline, then reads the history count and asserts 576 attempts.
Eight cycles include one warmup, leaving 21 samples per variant. Both use Bun
1.4.0 and SQLite 3.53.2 on the same shared Linux machine.

| Median milliseconds per cycle | Base | Fix |
| --- | ---: | ---: |
| 48 writes | 622.65 | 584.23 |
| History projection and count | 150.05 | 144.04 |
| Whole cycle | 770.92 | 736.94 |

This workload shows no regression. The medians are computed independently. Shared-machine timing varies; these results
support retaining current performance and make no claim of a speed gain.

The follow-up retained-history measurement in the same evidence file uses the
unchanged `sqliteStateStore.bounded.test.ts` case, three alternating fresh
processes per revision under one admission, Bun 1.4.0 and SQLite 3.53.2. Each
attempt holds 512 output characters. Ownership updates rebuild references
atomically; output-only updates leave them intact. Root custody fields are
materialized separately from the retained runs before per-attempt projections,
so text JSON on 3.39 avoids repeatedly decoding the full history.

| Attempts per pipeline | Baseline ownership median (ms) | Fix ownership median (ms) |
| --- | ---: | ---: |
| 32 | 2.86 | 2.71 |
| 1,024 | 41.01 | 30.78 |
| 4,096 | 513.90 | 128.57 |

The evidence includes all ownership and output-only samples and source hashes.
The fixed write retains baseline performance at each measured size; these
shared-machine measurements make no claim of a speed gain.

## Reproduction and guard

Run `bun test src/lib/state/minimumSqlite.test.ts` under an isolated HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, with LLV_VIEWER_CONTROL_URL pointing
at a closed loopback port. Locally, use `scripts/gate-slot.sh` for this command,
including its compilation. An existing scratch build can be supplied through
LLV_MINIMUM_SQLITE_LIBRARY. Other store suites run on the same library with
`bun test --preload ./src/lib/state/minimumSqlite.preload.ts <explicit test file>`.
The `Minimum macOS SQLite` job in `.github/workflows/platform-tests.yml` runs
the guard and the explicit store suites in separate isolated environments.
`src/lib/state/minimumSqliteSchema.test.ts` also scans first-party SQL literals
and fragments for newer functions, aggregate argument ordering and numeric
separators. The two capability-selected history queries and their capability
probe are exempt. Transcript search runs its schema migration cases separately;
its project-name ambiguity case has the same failure on the base.

Against base `4df56467`, installing state fails near `ORDER`, and the runtime
journal's deployment-order test fails because every `subsec` value is NULL.
The guard also exercises upgrade from newer SQLite, unsupported foreign schema
in both the Viewer state store and runtime journal, backup selection and recovery
of a previously set-aside database. Its runtime-journal seeding child checks that
newer SQLite retains the older host's index; the parent checks migration,
integrity and deletion on 3.39.4.

## Recovery

Activation handles only the named pipeline triggers the state store rebuilds.
It first keeps a copy, removes those trigger catalogue entries under SQLite's
write lock, and lets the store reinstall them. Other schema compilation failures
stop the open with the SQLite version and object name. An incompatible backup
stops fallback before the damaged live database is changed.

An affected `state.sqlite.corrupt-<timestamp>` is recovered automatically while
the live database has no rows or is absent. The candidate must either reproduce
the compilation failure or have a matching durable incident. Recovery operates
on a copy, repairs only the known triggers, checkpoints its WAL, and requires
`integrity_check` to pass. Both the set-aside original and the displaced empty
database remain on disk. Actual damage and populated live databases are kept
out of automatic schema recovery. Once an eligible candidate is established,
a repair, lock or publication failure stops activation before stores initialize.
The worker carries that refusal back to the Viewer; the original and prepared
copy remain available, and a later successful activation retries recovery. A worker
that cannot launch, exits or times out before answering also stops startup: its missing verdict
might follow a partial recovery. See also
[`state-sqlite-migration.md` §7.4](state-sqlite-migration.md#74-automatic-fallback-and-the-incident-it-raises).

## Verification record, 2026-10-21

- On main `3e6ca3c16dbd`, the transplanted minimum-library state-install and
  runtime-order tests both fail. The static SQL guard also fails there.
- The fix passes all 11 minimum-library regressions, the two static-audit
  tests, and four schema-classification tests. The minimum-library sweep
  exercised 41 store test files plus four transcript-search migration cases;
  the default-timeout case passes with the CI job's 60-second test budget.
- Full `tsc --noEmit --incremental false`, the production Viewer build,
  changed-file lint and publication privacy with commit inspection pass.
- The runtime-host rehearsal passes under Bun 1.4.0 with both endpoints held
  across succession. The built Viewer loads 32/32 server modules and serves
  `GET /` with status 200 and 82,936 bytes.
- Existing native assertions remain red on both base and fix: three history
  alias cases, two index-inventory/fence cases, one deployment-wire case and
  one search project-name ambiguity case. The index failures have the same
  diagnostic differences on both revisions.

The first unmodified pre-push attempt stopped at native Codex exit 69 before
dispatch because its isolated environment dropped `LLV_SIGNAL_SANDBOX`.
The same command, fixture and isolation reproduced exit 69 on base `4df56467`.
The two marker-forwarding lines from PR #3164 are now included in
`scripts/verify-native-codex-runtime.ts` and `scripts/verify-viewer-runtime.ts`.

The full gate on source revision `344ac85b7` passes with exit 0, using
`bash scripts/gate-slot.sh bun scripts/local-gate.ts pre-push` in a committed
scratch export. The gate creates isolated homes, config, temp and state roots
and pins Viewer control to a closed loopback port. Touched tests report zero
new failures, seven pre-existing failures and three intermittent assertions.
Types, changed-file lint, publication privacy, Linux checks, runtime verdict
tests, shared native contracts and all four supported Codex versions pass.
The production Viewer build, MCP size budgets, built Viewer runtime check,
runtime-host succession rehearsal and runtime negative controls also pass.

Two earlier continuation attempts stopped before that completed verdict:
one hit the unchanged queue test's 10 ms deadline (a fresh isolated base/head
control passed on both), and one could not complete a comparator base rerun.
The successful full run retains its normal comparison and refusal rules.


## Review follow-up checks, 2026-10-21

The guard now runs 13 minimum-library regressions in its owned child. Both
explicit collection orders with `schemaCompatibility.test.ts` pass, and the
parent retains its native SQLite module, process hook and cached version.
The retained-history write case also passes on 3.39.4 at 4,096 attempts.

All 29 native durability cases pass, including publication and lock refusal,
worker launch refusal, timeout, a lost worker verdict and a successful retry
in a fresh worker. Removing the production Viewer refusal line in scratch
makes both worker-publication regressions fail. The first hook comparison of
21 explicit files reports zero new failures, seven confirmed pre-existing
failures and two intermittent assertions. Typecheck passes; the publication
gate reruns its checks on the final merged source.
