# Delivery cold storage retention: the registry archive and its hourly backups

## Originating requirement

On 2026-11-17 the operator asked to shrink the agent registry's archived records
and the hourly database copies, while keeping the evidence of every delivery that
has not finished. Issue #4154 is the specification. It follows #4138 (terminal
delivery retention) and #907 (registry snapshot lifecycle). It asks for
measurements and a bound on cold storage for `heldDeliveries`,
`deliveryOperationOwners` and `receipts`. It requires that replay, custody,
receipt and uncertain-delivery evidence stays retrievable. It also says
production deletion needs a separate operator decision.

## Decision in one paragraph

Build a bounded, restartable, dry-run-first pass that retires **superseded
archive versions**. These are rows of `registry_archive` that no cold mapping
names, so no reader can reach them through `registry_records`. On a copy of the
production registry they are 321,240 of 484,358 archive rows and 543,975,136
payload bytes. Retiring them shrinks one hourly backup from 3,057,246,208 to
2,239,971,328 bytes (−26.7%). Every reachable row, every unsettled-delivery
record and 7,203 product-level replay reads stayed identical, including across a
`SIGKILL` and a restart. The pass changes no row that any reader can see, so the
retained set stays whole by construction. The production dry-run, the
first catch-up and the recurring pass wait for operator approval. Two
categories that would delete or trim reachable records are measured and listed
for a separate decision: old reservations under the existing 7-day rule, and the
message text kept on old delivered owners. Neither is built.

## Measurements

### Conditions

- Source: the newest hourly backup of the production registry at the time,
  `$STATE/backups/sqlite/agent-registry-2026-11-17T21-46-05-408Z.sqlite`
  (3,057,246,208 bytes). It was copied byte for byte into the stage's scratch
  directory and opened only there. The live database and the backup were only
  read: `cp`, plus one `od` read of the live file's 100-byte header.
- A second copy of the `2026-11-17T19-44-56-631Z` backup served as the growth
  baseline.
- Interpreter: Bun 1.4.0 with its bundled SQLite 3.53.2, page size 4096. Each
  timing is one run on an otherwise busy workstation. No speed claim rests on
  a single timing. Reads 2026-11-17 22:26Z to 22:50Z.
- Scripts and raw outputs are retained in the stage's evidence directory under
  `registry-cold-storage/`. The essential SQL is in the appendix.

Commands (`$TMPDIR` is the stage scratch directory, `$E` the retained script copy):

```
cp $STATE/backups/sqlite/agent-registry-2026-11-17T21-46-05-408Z.sqlite $TMPDIR/measure/registry-copy.sqlite
bun $E/measure.ts  $TMPDIR/measure/registry-copy.sqlite          # rows, bytes, b-tree pages
bun $E/pages.ts    $TMPDIR/measure/registry-copy.sqlite          # page attribution per collection
bun $E/policy.ts   $TMPDIR/measure/registry-copy.sqlite 2026-11-17T21:46:05Z
bun $E/backupcost.ts $TMPDIR/measure/registry-copy.sqlite $TMPDIR/measure/baseline-backup.sqlite
bun $E/retire.ts   $TMPDIR/measure/registry-copy.sqlite dry-run
cp $TMPDIR/measure/registry-copy.sqlite $TMPDIR/sim/agent-registry.sqlite
bun $E/retire.ts   $TMPDIR/sim/agent-registry.sqlite apply --batch 250 --kill-after 3   # exits 137
bun $E/retire.ts   $TMPDIR/sim/agent-registry.sqlite apply --batch 250                  # restart
bun $E/preserve.ts $TMPDIR/measure/registry-copy.sqlite > before.json
bun $E/preserve.ts $TMPDIR/sim/agent-registry.sqlite    > after.json
bun $E/backupcost.ts $TMPDIR/sim/agent-registry.sqlite $TMPDIR/sim/after-backup.sqlite
HOME=$TMPDIR/home XDG_CONFIG_HOME=$TMPDIR/home/.config LLV_STATE_DIR=$TMPDIR/prod-<side> \
  LLV_VIEWER_CONTROL_URL=http://127.0.0.1:9 bun $E/replay.ts <worktree> $TMPDIR/prod-<side> keys.json out.json
```

### How rows are counted

A cold row exists three times on disk. It has a mapping in `registry_cold`, a
live version in `registry_archive`, and a compatibility copy in `registry_rows`
(`src/lib/agent/registryArchive.ts:29-33`). On this copy every compatibility copy
is byte-identical to its live version. Each cold row is therefore counted once
as a logical row, and its bytes are reported per physical copy. A **superseded**
version is an archive row that no mapping names. Archive versions = live
versions (= cold rows) + superseded versions. Logical rows = hot rows + cold
rows = rows of `registry_rows`. The columns of the issue's table must not be
added together.

The copy agrees with the issue's 19:01Z table. The cold and archive counts of
the three named collections are identical (34,273 / 38,140, 39,889 vs 39,893 /
40,137, 23,173 / 29,842). Only their hot rows grew, by 84, 88 and 65.

### Per collection: rows and stored bytes

Bytes are stored `value_json` octets, in MiB. "Superseded split" counts versions
whose key is now cold under a newer version / hot again / deleted from
`registry_rows`.

| Collection | Logical rows | Hot | Cold | Hot bytes | Compat copies | Archive versions | Live archive | Superseded | Superseded bytes | Superseded split |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| heldDeliveries | 34,653 | 380 | 34,273 | 0.4 | 40.6 | 38,140 | 40.6 | 3,867 | 4.4 | 175 / 1 / 3,691 |
| deliveryOperationOwners | 40,330 | 441 | 39,889 | 5.3 | 429.6 | 40,137 | 429.6 | 248 | 1.2 | 183 / 65 / 0 |
| receipts | 23,564 | 391 | 23,173 | 3.1 | 186.3 | 29,842 | 186.3 | 6,669 | 41.7 | 6,664 / 5 / 0 |
| conversations | 22,842 | 11,987 | 10,855 | 19.4 | 17.2 | 319,275 | 17.2 | 308,420 | 468.4 | 126,130 / 182,290 / 0 |
| entries | 21,267 | 338 | 20,929 | 0.6 | 28.2 | 22,939 | 28.2 | 2,010 | 3.2 | 2,002 / 8 / 0 |
| lineageEdges | 19,103 | 1,426 | 17,677 | 1.1 | 15.6 | 17,701 | 15.6 | 24 | 0.0 | 19 / 5 / 0 |
| memberships | 17,510 | 1,395 | 16,115 | 0.4 | 5.0 | 16,115 | 5.0 | 0 | 0.0 | — |
| migrationIntents | 281 | 74 | 207 | 0.0 | 0.1 | 209 | 0.1 | 2 | 0.0 | 1 / 1 / 0 |
| agentState* (3) | 18,348 | 18,348 | 0 | 23.0 | — | 0 | — | 0 | — | — |
| **Total** | **197,898** | **34,780** | **163,118** | **53.3** | **722.5** | **484,358** | **722.5** | **321,240** | **518.8** | |

Two payload fields dominate the named collections. `evidenceText` is 395.9 MiB
of the owners' 435 MiB, and `launchDisplay` is 137.1 MiB of the receipts'
189 MiB.

### Allocated pages

`dbstat` over the copy (746,398 pages, 0 free):

| B-tree | Pages | MiB |
| --- | ---: | ---: |
| `registry_archive` table | 377,835 | 1,475.9 |
| its 21 indexes | 52,485 | 205.0 |
| `registry_rows` table | 223,403 | 872.7 |
| its 38 indexes | 60,890 | 237.9 |
| every other table and index | 31,785 | 124.2 |

`dbstat` cannot say which collection owns a page. The table below attributes
pages per collection and class. Overflow pages use SQLite's cell-size formula per
row; it predicts 130,800 and 136,612 overflow pages where `dbstat` counts 130,777
and 136,593. Leaf and interior pages follow each class's local cell bytes. Index
pages follow entry counts, and a partial index counts only its collection.

| Collection | `registry_rows` hot | `registry_rows` compat | archive live | archive superseded |
| --- | ---: | ---: | ---: | ---: |
| heldDeliveries | 279 | 26,516 | 17,671 | 1,950 |
| deliveryOperationOwners | 1,574 | 129,725 | 121,251 | 370 |
| receipts | 1,002 | 59,984 | 55,415 | 12,834 |
| conversations | 9,810 | 8,780 | 6,915 | 189,984 |
| entries | 281 | 15,323 | 11,760 | 1,276 |
| lineageEdges | 789 | 10,455 | 7,238 | 9 |
| memberships | 541 | 6,256 | 3,612 | 0 |
| migrationIntents | 29 | 84 | 51 | 0 |
| agentState* | 12,887 | — | — | — |

Superseded versions are attributed 206,423 pages. Retiring them on the copy
freed 195,514 pages into the freelist, and the next backup was 199,530 pages
smaller. These numbers are measured, see below.

### What one backup writes

Each due pass of `backupDatabase` (`src/lib/state/durability.ts:833-907`) is a
full `VACUUM INTO` of the registry followed by `integrity_check` of the copy.
Nothing in it is incremental. It runs hourly because the registry revision
changes every hour (`durability.ts:54`, `:95-101`). The same sequence, replayed on
the copy (`backupcost.ts`, `/proc/self/io` of the process):

| | Before | After retirement |
| --- | ---: | ---: |
| Backup file | 3,057,246,208 B (746,398 pages) | 2,239,971,328 B (546,868 pages) |
| Bytes written by the process | 3,057,700,864 | 2,240,479,232 |
| `VACUUM INTO` duration | 10.8 s | 11.6 s |
| `integrity_check` duration / read syscalls | 45.6 s / 35.6 GB | 44.7 s / 25.4 GB |

The live file is 3,223,875,584 bytes. Its header auto-vacuum field is 0 and it
has 7 free pages, so freed pages stay in the file for reuse until a full
`VACUUM`. The backup directory held 21,247,021,056 bytes at 22:25Z. The 2 GiB
budget (`durability.ts:48`) is far below what the three protected generations per
database need (`:50`). The 4-hourly and daily tiers of `retained()` (`:946`) are
therefore always evicted, and only the newest three registry backups survive
(9,090,846,720 bytes). Retirement leaves that count unchanged and makes each
generation 817,274,880 bytes smaller. That is 2.45 GB less on disk and about
19.6 GB less written per day.

### Growth and its driver

Between the 19:44:56Z and 21:46:05Z backups the registry grew from 733,226 to
746,398 pages, about 26.7 MB an hour. In that window the archive gained 21,500
versions; 21,483 of them were conversation versions of only 1,749 conversations.
The cold and archive counts of `heldDeliveries`, `deliveryOperationOwners` and
`receipts` did not change.

Pairs of consecutive conversation versions differ only in `updatedAt`,
`migrationOptOut.updatedAt` and `migrationOptOut.order` (3,000 of 3,000 sampled
pairs). None of 297,063 pairs is byte-identical. One sampled conversation was
re-archived every five to seven minutes with a new order from
`nextMigrationDecisionOrder` (`src/lib/agent/registry.ts:1576`). No migration stop
was stamped in the window, so the writer is one of the other opt-out writers
(`registry.ts:1715`, `:10953`, `:13341`). Each write promotes a cold conversation
(`registry_promote_cold_*` triggers), and the archive pass
(`src/lib/reaperRuntime.ts:579`, at most 250 rows per 60 s cycle,
`src/lib/agent/sqliteRegistryStore.ts:3221`) re-archives it under a new id. The
churn uses most of that pass's budget: hot delivery rows rose from 322 to 380 in
the same two hours. Naming the exact writer is a separate diagnosis (see
Follow-ups). Without retirement, the superseded archive grows by roughly
10.6 thousand versions, about 17 MB of payload, an hour.

## The retained set

The pass below retires only versions that no mapping names, so it touches no
member of this set. The table names each class, where it is kept and the code
that relies on it. The "Copy" column gives the class's count on the measured copy.

| Class | Kept as | Code that relies on it | Copy |
| --- | --- | --- | ---: |
| Idempotent replay of a send | Every owner row (bounded to 200 terminal per conversation, uncertain ones last, `registry.ts:3915`, `:3964-3998`); reservations under the 7-day / 100 / 50 rule (`:4004`, `:4022`); every `deliveryEvidenceCompactions` row, never cleared (`:3930`) | `deliverySnapshotForOperation` (`registry.ts:6939`), `deliverySnapshotForMessageKey` (`:6982`), absence semantics (`:12284`) | 40,330 owners, 34,653 reservations, 0 compactions |
| Idempotent replay of a launch | Every receipt; launch idempotency has no time expiry (`registryArchive.ts:33`) | `spawnReceiptForClientAttempt` (`registry.ts:7161`), `pipelineSpawnHistory` (`:7170`), `pipelineSpawnHistorySelection` (`sqliteRegistryStore.ts:337`) | 23,564 |
| Custody and ownership | Entries with a host, process, claim owner, pending action or termination survivors stay hot (`registryArchive.ts:109-114`); receipts a live entry still names stay hot (`:115-126`); owners with `terminalState` null read as custody `pending` (`sqliteRegistryStore.ts` `LOOKUP_PATHS.custodyState`) | registry lookups by `custodyState`, the archive candidate rules | 8 open owners |
| Journal receipts | The runtime journal keeps unprojected terminal receipts (`src/runtime-host/journal.ts:110-122`, cap 512); after journal compaction the owner's settlement answers `message_receipt` (`registry.ts:936-941`) | `message_receipt`, delivery settlement | in the owners above |
| Unresolved switches | Conversations with `migration`, `reconfigure` or `switchHold` stay hot (`registryArchive.ts:127-131`); intents not complete or stopped, with a pending stop sweep, or named by a hot conversation stay hot (`:145-147`) | migration controller and coordinator, switch cancel and rollback | 116 conversations, 1 open intent |
| Pending sends | Reservations `held`, `assigned`, `delivery-uncertain` stay hot (`registryArchive.ts:148`); conversations with open deliveries or receipts stay hot (`:135-140`); owners without a terminal state stay hot (`:149`) | structured delivery controller, held drain, `rearmUncertainDeliveryForOperation` (`registry.ts:13180`) | 8 reservations, 8 owners |
| Uncertain deliveries | Failed owners with disposition `unverified` or none (legacy) stay retained and re-armable, with their `evidenceText` | `confirmedSend` (`src/lib/runtime/confirmedSend.ts:26-31`, `:71-80`), `rearmUncertainDeliveryForOperation` | 421 |
| Every cold row's live version and compatibility copy | The version a `registry_cold` mapping names; the `registry_rows` copy | `registry_records` (`registryArchive.ts:9-12`); selectors on `registry_rows` (`sqliteRegistryStore.ts:321-350`; `docs/design/delivery-controller-peak-load.md`, Shared contracts) | 163,118 |
| Collection order high-water mark | The largest `row_order` per collection | row order allocation (`sqliteRegistryStore.ts:6218-6224`) | every collection's maximum is in `registry_rows` |

**Outside the set:** superseded archive versions. `registry_records` joins
through the mapping, so it cannot reach them. A mapping is only ever created by
the archive pass, with the id its own insert returned
(`registryArchive.ts:220-224`). An unmapped version therefore never becomes
reachable again. The one remaining reader is a view built before the version was
superseded, which reads by id: `sqliteRegistryStore.ts:3562-3568`, `:3938`,
`:4263`. The grace period below covers that reader.

## Options considered

1. **Retire superseded versions.** Chosen. Reclaims 26.7% of each backup and
   changes nothing a reader can see.
2. **Deduplicate at archive time.** Rejected: 0 of 297,063 successor pairs are
   byte-identical, so it would reclaim nothing.
3. **Stop the conversation churn.** Complementary. It cuts new superseded
   versions and archive-pass starvation, but leaves the 519 MiB already
   written. Listed under Follow-ups.
4. **Drop compatibility copies.** Deferred. 722.5 MiB, but current selectors and
   older releases read them.
5. **Expire or trim reachable delivery records.** Needs the operator. Measured
   below as categories B1 and B2.

## Design: category A, retire superseded archive versions

**Where it runs.** In the existing hygiene owner, right after the archive pass
in `runReaperCycle` (`src/lib/reaperRuntime.ts:579`). It runs under
`registry.deliveryWrite({ label: "registry.retire" })` through a new
`AgentRegistry.retireSupersededArchive()`, which calls
`SqliteRegistryStore.retireSupersededArchive()`. Both start with
`assertStateStartupMutation(path.dirname(filename), "agent registry archive retirement")`,
as `archiveInactive` does (`sqliteRegistryStore.ts:3223`). The pass does nothing
until an approval record exists (see Hand-off).

**Schema.** Installed inside `installRegistryArchive`'s startup transaction:

- `registry_archive_retirements(id INTEGER PRIMARY KEY, collection TEXT NOT NULL, bytes INTEGER NOT NULL, observed_at INTEGER NOT NULL)`
  holds the versions observed and waiting out the grace period.
- `registry_archive_retirement_state(key TEXT PRIMARY KEY, value INTEGER NOT NULL)`
  holds the observe cursor.
- `registry_archive_retirement_totals(collection TEXT PRIMARY KEY, retired INTEGER NOT NULL, bytes INTEGER NOT NULL)`.
- `CREATE INDEX registry_cold_archive ON registry_cold(archive_id)`. Measured
  need: the store runs with `foreign_keys = ON`
  (`sqliteRegistryStore.ts:1539`), so every archive delete checks
  `registry_cold` for referencing rows. Without the index that check scans all
  163,118 mappings: 13.7 ms per deleted row, 3.4 s per 250-row batch. With it,
  0.365 ms.
- `registry_archive_immutable_delete` is replaced under the same name by a
  guarded trigger. It aborts unless the version is in the ledger **and** no
  mapping names it. A live version therefore cannot be deleted by any caller,
  whatever its SQL. The update trigger stays as it is.

The installed-schema check compares object names only
(`registryArchiveSchemaInstalled`, `sqliteRegistryStore.ts:75-97`). The new
tables are what make an upgraded file read as not yet installed, so the trigger
replacement runs exactly once, together with them. Older releases keep the
guarded trigger, because they only run `CREATE TRIGGER IF NOT EXISTS`; they
never retire anything. The retirement step refuses to run while the installed
trigger text is not the guarded one.

**Eligibility.** One exported predicate, named in code beside the archive
candidate rules (`registryArchive.ts`):

```sql
NOT EXISTS (SELECT 1 FROM registry_cold c
            WHERE c.collection=a.collection AND c.row_key=a.row_key AND c.archive_id=a.id)
AND a.row_order < (SELECT MAX(r.row_order) FROM registry_rows r WHERE r.collection=a.collection)
```

The second clause keeps each collection's order high-water mark, so row-order
allocation (`sqliteRegistryStore.ts:6218-6224`) never reuses a value. On the copy
it keeps 0 versions. Query plans on the full schema: the dry-run walks
`registry_archive_order`, the observe step seeks the primary key (`rowid>?`), the
mapping check uses `sqlite_autoindex_registry_cold_1`, and the high-water mark
uses the covering `registry_rows_collection_order`. Product code must use
`length(CAST(value_json AS BLOB))`. The prototype's `octet_length` needs SQLite
3.43, and macOS ships 3.39 (`AGENTS.md`).

**Observe step.** Eligibility only ever grows: a version, once unmapped, stays
unmapped. Observation therefore runs in a read transaction, outside the write
lock, as the archive candidates do (`registryArchive.ts:187-197`). It examines at
most 2,000 existing archive rows after the persisted cursor (`id > cursor
ORDER BY id LIMIT 2000`) and records the eligible ones with `observed_at` in a
short write. The bound counts existing rows examined, including retained rows;
deleted AUTOINCREMENT gaps do not consume the page or delay discovery. The
cursor advances to the last examined id and wraps when the page is short or
empty. The prototype counted eligible rows found, and a cycle with nothing to
find then held the lock for 620 ms. Versions superseded behind the cursor are
found on the next sweep.

**Retire step.** In each `BEGIN IMMEDIATE` transaction:

1. Take up to 250 ledger rows with `observed_at` older than the grace period
   (default one hour).
2. Recheck eligibility; the trigger checks it again.
3. Delete the versions, add them to the totals, and drop the ledger rows.

At most four such transactions run per reaper cycle, with a yield to the event
loop between them. Nothing visible changes, so the step writes no
`registry_changes` entry and does not bump the revision. Measured on the copy
with batches of 250: delete lock p50 42.3 ms, p99 104.9 ms, max 147.1 ms over
1,282 batches; observe lock p99 12.5 ms. The archive pass keeps 250 rows per pass
because 1,000 rows held the lock about 160 ms idle and 0.8 s loaded
(`sqliteRegistryStore.ts:3218-3220`).

**Rate.** Four batches per 60 s cycle retire about 60,000 versions an hour,
against churn of about 10,600 an hour. The 321,240-version backlog clears in
roughly 6.5 hours. Discovery examines 120,000 existing archive rows an hour,
so its delay depends on the physical row count, not the largest historical id.
Using the measured 163,118 live archive rows, 10,600 versions/hour of churn and
the 1,693-byte mean superseded payload, a conservative full-sweep estimate is
`S = 10,600 × (1 hour + (163,118 + S) / 120,000 per hour)`: about 27,400
superseded versions or 46 MB at steady state. Recalculate this estimate when
the live archive count or churn changes; the earlier 10,600-row / 17 MB figure
counted only the grace hour and omitted discovery delay.

**Held views.** A missing version read through a view currently throws a plain
`Error("registry archive version is missing")` (`sqliteRegistryStore.ts:3568`); the
batch reads at `:3938` and `:4263` assume the row exists. All three must throw
`DatabaseReplacedError` ("request a fresh snapshot"), the error the same reader
already throws when the database file is replaced. A view held across the grace
period is then a retryable miss and never corruption. A view inside an open read
transaction keeps its WAL snapshot and still sees the version.

**Space.** The live file has auto-vacuum off, so retired pages go to the freelist
and later writes reuse them. With the recurring pass, churn refills the freelist
and the live file stops growing. Backups shrink at the next hourly copy, because
`VACUUM INTO` does not copy free pages. Shrinking the live file itself is
deferred.

**Dry run.** `bun scripts/registry-archive-retirement.ts --dry-run` claims the
`tool` owner as its first import (`@/lib/state/owner/tool`) and opens the
registry read-only. It prints a report:

- category A eligible rows and bytes per collection, rows kept as the high-water
  mark, and rows already observed and retired;
- B1 and B2 counts and bytes, read-only;
- the report's SHA-256.

It takes 6.0 s on the copy and writes nothing.

## Categories that need a separate decision (measured only)

| Category | Rows | Bytes per physical copy | What it is | Effect on the retained set |
| --- | ---: | ---: | --- | --- |
| B1: reservations past the existing 7-day rule | 27,398 | 34,306,555 | Delivered, and failed except migration cancellations, settled more than 7 days ago. The rule exists (`registry.ts:4004`, `:4022`) but runs only when the same conversation gets a new send; the periodic sweep was removed on 2026-10-16 (#2963, "an idle controller must not open a whole-registry mutation for hygiene"). | Every one of them that carries a message key has an owner holding the same key, so dropping them writes no evidence-compaction record (0 of 27,398); replay by key is still answered from the owner. Each drop also turns its archive version into a superseded one that A retires. |
| B2: `evidenceText` on delivered owners settled more than 7 days ago | 32,376 | 325,967,473 | The full message text copied into the owner (`registry.ts:12224`, `:4068`). Delivered reservations already blank their text (`:4094`, `:13008`). | Replay compares digests and keeps working. `confirmedSend` needs the text only for owners not yet settled as delivered. The seat-channel withdrawal payload (`src/lib/orchestrator/seatChannel.ts:249`) reads it for captured sends. Trimming rewrites each owner, creating a superseded version that A retires; with the compatibility copy that is about 650 MB physical. It removes the record of what was sent, so it is the operator's call. |

Neither is built in this lane. The dry run reports both so the decision can be
taken on current production numbers.

## Preservation checks

The implementation proves each of these on a production-shaped fixture, and the
seat repeats the read-only ones on a copy of a production backup after a catch-up.

1. A multiset digest of every `registry_records` row (collection, key, order,
   payload) is unchanged.
2. Digests of `registry_rows` and of every `registry_cold` mapping are unchanged.
3. Digests of each unsettled class are unchanged: pending reservations, open
   owners, uncertain owners, all owners, open receipts (non-terminal, repair
   pending or queued pin), all receipts, conversations with a switch or
   migration, open intents, evidence-compaction rows.
4. No mapping names a missing or mismatched version (`malformedRegistryColdMappings`
   = 0). `PRAGMA foreign_key_check` is empty and `integrity_check` is `ok`.
5. Product replay answers are identical:
   - `deliverySnapshotForOperation(op, { recipientEvidence: true })` for every
     owner not delivered and a sample of delivered owners;
   - `deliverySnapshotForMessageKey` for every open reservation and a sample of
     keyed ones;
   - `spawnReceiptForClientAttempt` for every receipt not completed and a
     sample of the rest.
6. Retired totals equal the dry run taken before the first batch. A dry run
   afterwards reports only versions observed inside the grace period. A second
   apply is a no-op.

Prototype result on the copy (the prototype lives in the evidence directory and
is not product code). Every digest in checks 1 to 3 was identical before and
after: 197,898 records, 163,118 mappings, 8 / 8 / 421 / 40,330 / 487 / 23,564 /
116 / 1 / 0 for the unsettled classes. Check 4: 0, 0 and `ok`. Check 5: 7,203
reads (2,905 operation snapshots, 1,620 message keys, 2,678 launch attempts) with
identical answers, opened through `AgentRegistry` in SQLite mode under an isolated
HOME, state directory and closed control URL. Check 6: totals of 321,240 rows and
543,975,136 bytes, matching the dry run; the rerun retired 0.

## Restart test

A new test file, `src/lib/agent/registryArchiveRetirement.test.ts` (named by
behaviour), with an isolated HOME, `XDG_CONFIG_HOME`, `TMPDIR` and
`LLV_STATE_DIR`.

**Fixture.** Seed retained history the way `src/lib/agent/receiptRead.fixture.ts`
does (`archiveInactive` until empty). Add one row of every unsettled class above.
Then create superseded versions three ways:

- rewrite a cold conversation's `migrationOptOut` and archive it again;
- re-archive a receipt;
- delete a cold reservation.

**Kill and restart.**

1. Dry run, and keep the report.
2. A child process applies with a test-only `afterCommit` hook that sends itself
   `SIGKILL` after the second committed retire transaction.
3. The parent opens the file and checks that it is consistent: the ledger plus
   the totals equal the dry-run count, and checks 1 to 4 hold.
4. A new process completes the run. Checks 1 to 6 hold, and a third run is a
   no-op.

**Edges.**

- A view built before a version was superseded reads it after retirement: it
  gets `DatabaseReplacedError`, and a fresh snapshot succeeds.
- Inside the grace period nothing is retired.
- A direct `DELETE` of a mapped version is refused by the trigger.
- Running `installRegistryArchive` again, as an older release would, keeps the
  guarded trigger.
- The collection's high-water version is kept.
- The file also runs under `--preload ./src/lib/state/minimumSqlite.preload.ts`.

**Which branch must fail.** Dropping the mapping clause makes the trigger refuse,
so the apply fails; with the trigger also removed, check 1 fails. Ignoring the
grace makes the held-view case delete inside the grace and fail. Not persisting
the cursor or the ledger makes the restart's totals disagree with the dry run.
Throwing a plain `Error` for a missing version fails the held-view case.

Prototype demonstration on the copy: the first apply was killed with `SIGKILL`
after three batches (exit 137, 750 versions retired, 320,490 observed and
pending). A dry run on the killed file reported 320,490 eligible and totals of
375 + 375. The restart retired the remaining 320,490.

## Hand-off and rollout

- **This lane:** design and measurements only. It made no product change, ran
  nothing against live state, and deleted nothing in production.
- **Implementation lane:** registry data migration, high risk, three review
  rounds. Its checks are the touched tests on the committed tree with no new
  failures against main, the minimum-SQLite run, the state-ownership rules
  (`assertStateStartupMutation` for the schema install and for the retire step)
  and the privacy gate.
- **After deploy, for the seat:**
  1. Run `bun scripts/registry-archive-retirement.ts --dry-run` on the
     production installation (read-only). On the copy it reported 321,240
     versions and 543,975,136 payload bytes, about 817 MB less per hourly backup,
     plus B1 = 27,398 rows / 34.3 MB and B2 = 32,376 owners / 326 MB.
  2. Present the report to the operator. Category A is approved by its report
     digest: `--approve <sha256>` writes
     `$STATE/registry-archive-retirement.json`, holding the digest, the
     category, the grace and the per-cycle cap. From then on the reaper runs
     the recurring pass. Deleting the file stops it.
  3. Verify on production across the next 24 hours:
     - hourly backup sizes, which should fall by the reported amount after the
       backlog clears;
     - the `registry.retire` spans in the loop monitor during busy hours, with a
       per-transaction p99 bound of 150 ms;
     - the dry-run totals against the retired totals.
  B1 and B2 stay off until a separately approved list exists.

## Follow-ups (separate tasks, recommended)

- **Conversation opt-out churn.** Find the writer that restamps
  `migrationOptOut` on about 1,750 cold conversations every few minutes, and stop
  it from promoting rows whose decision is unchanged. It is the source of about
  27 MB/h of growth, and it starves the archive pass of delivery rows.
- **Archive pass starvation.** Candidates are ordered by `row_order` across all
  collections (`registryArchive.ts:175-185`), so old conversations always come
  before new delivery rows.

## Deferred — not currently justified

- **Removing compatibility copies from `registry_rows`** (722.5 MiB).
  Current selectors (`sqliteRegistryStore.ts:321-350`, the delivery page
  selectors) and older releases read them, and a delete fires
  `registry_promote_cold_delete`, which removes the mapping. It would be a
  contract change across readers.
- **A one-time `VACUUM` of the live file**, or a switch to incremental
  auto-vacuum. Measured at 31.3 s under an exclusive lock on the copy (3.07 GB
  to 2.24 GB). Freelist reuse already stops growth, and backups shrink without
  it.
- **Backup policy:** the ineffective 2 GiB budget, the hourly full copy and the
  45 s, 25–36 GB-read `integrity_check`. This applies equally to
  `state.sqlite` (1.5 GB hourly) and `mcp-receipts.sqlite` (2.2 GB daily),
  which are outside this specification.
- **Trimming `launchDisplay` on old receipts** (127.4 MiB on completed cold
  receipts). Display data that the specification does not ask about.
- **Time-based expiry of owners or receipts.** Both are replay evidence with no
  expiry today. Only the operator can set an idempotency window.

## Appendix: measurement SQL

```sql
-- live vs superseded archive versions per collection
SELECT a.collection, COUNT(*),
  SUM(EXISTS (SELECT 1 FROM registry_cold k WHERE k.collection=a.collection AND k.row_key=a.row_key AND k.archive_id=a.id)) AS live,
  SUM(length(CAST(a.value_json AS BLOB))) AS bytes
FROM registry_archive a GROUP BY a.collection;
-- hot vs compatibility copies
SELECT r.collection, COUNT(*), SUM(c.row_key IS NOT NULL) AS cold
FROM registry_rows r LEFT JOIN registry_cold c USING (collection,row_key) GROUP BY r.collection;
-- allocated pages per b-tree
SELECT name, pageno FROM dbstat WHERE aggregate = TRUE;
-- one backup, as durability.ts takes it
VACUUM INTO '<target>';  -- then PRAGMA journal_mode=DELETE; PRAGMA integrity_check; on the copy
```
