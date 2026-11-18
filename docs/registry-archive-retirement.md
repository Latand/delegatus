# Registry archive retirement

Implements category A of [the pinned design](design/delivery-cold-storage-retention.md).
The implementation retires only immutable archive versions that no cold mapping
names and whose order is below the current collection high-water mark. Every
reachable reservation, operation owner, receipt, custody record, journal receipt,
unresolved switch, pending send and uncertain delivery remains retrievable.
There is no new expiry for any of those records. Compatibility copies remain.

## Production hand-off

The seat runs this from the installed revision with its normal installation
environment, after deployment:

```sh
bun scripts/registry-archive-retirement.ts --dry-run
```

This command opens the registry read-only and prints JSON containing:

- `category: "A"`, `graceMs: 3600000`, `batchSize: 250`, `cycleBatches: 4`;
- per collection: `logicalRows`, `coldRows`, `hotBytes`, `compatibilityBytes`,
  `liveArchiveBytes`, `eligibleRows`, `eligibleBytes`, and `highWaterRows`;
- `observed` rows/bytes and per-collection cumulative `retired` rows/bytes;
- read-only measurements `B1` (terminal reservations past the existing seven-day
  rule) and `B2` (evidence text on delivered owners settled over seven days ago);
- database `pages` (`pageSize`, `allocated`, `free`), a backup-method explanation,
  a SHA-256 `digest`, and `approved: false`.

Sum `eligibleRows` and `eligibleBytes` across the collections for category A's
reclaimable versions and payload bytes. Those payload bytes describe one archive
copy. They are distinct from filesystem pages and actual backup write bytes.
The backup explanation states that the current hourly backup is a full
`VACUUM INTO`; the product has no incremental database backup.

A pending JSON import is refused until the serving writer publishes SQLite.

The dry run installs no schema and writes no registry records, ledger or approval.
SQLite may create its normal WAL reader sidecars when opening a WAL database;
it reads the committed WAL snapshot, including commits absent from the main file.
It never opens with `immutable`, which would omit concurrent WAL commits.

No production dry run, approval or deletion was performed in this implementation
lane. Historical production-copy amounts are in the pinned design; current
production amounts must come from the seat's report. After a separate operator
decision approving category A and that report digest, the seat runs:

```sh
bun scripts/registry-archive-retirement.ts --approve <report-sha256>
```

This rechecks the report and refuses a changed digest. It writes
`$STATE/registry-archive-retirement.json` with the approved category, digest,
database file identity, grace and caps. It does not delete data. The existing
reaper then observes eligible versions and waits at least one hour before
retirement. Removing that approval file stops subsequent batches, including
batches waiting for writer admission. A database file replacement invalidates
the approval. B1 and B2 have no apply path; each still needs its own approved list.

The seat verifies the next 24 hours of hourly backup sizes, `registry.retire`
operation spans during busy hours, and the ledger/totals against the approved
report. The deployed pass's production behaviour and these observations belong
to the release/operations owner. A full live-file `VACUUM`, dropping compatibility
copies, changing backup policy and diagnosing opt-out churn remain deferred.

## Shared contracts and bounds

| Surface | Producers, consumers and safeguards |
| --- | --- |
| `registry_archive` | `archiveInactiveRegistryRows` inserts immutable versions. Retirement is the only product delete path. The guarded trigger requires ledger membership, no mapping of any identity and a lower order than the collection maximum. The immutable update guard remains. |
| `registry_cold` | The archive writer inserts mappings; compatibility-row promotion/deletion triggers remove them. `registry_records`, lazy readers, projectors and grant readers consume their exact version IDs. `registry_cold_archive(archive_id)` bounds both the guard lookup and SQLite foreign-key child checks. |
| `registry_rows` | All existing logical writers and compatibility readers retain their existing rows, copies, defaults and promotion triggers. Their maximum order fences retirement; a collection without current rows keeps every archive version because its high-water mark is unknown. |
| Startup | `installRegistryArchive` installs the ledger, cursor, totals, due index and replacement guard inside the store's existing startup transaction and `assertStateStartupMutation` fence. Added objects invalidate the old name-based installation proof. An older installer using `IF NOT EXISTS` preserves the guard. |
| Approval | The operator tool writes the separate approval record. The reaper reads it before observation and at every admitted batch. Missing, malformed, wrong-category, wrong-file, undersized-grace or oversized-cap approvals disable retirement. |
| Observation | One read transaction examines an interval of at most 2,000 IDs outside the writer lock. A short admitted write rechecks candidates and commits their first observation time with the cursor. A stale observer cannot rewind a changed cursor. Empty intervals still advance; the end wraps to zero. |
| Retirement | At most four admitted transactions per cycle, each selecting up to 250 due ledger entries through the due index. Eligibility is rechecked; deletes, totals and ledger cleanup commit together. Each transaction releases its lock before the asynchronous yield. The pass writes no logical revision or registry change-journal entry. |
| Held views | Lazy row reads, grant hydration and batched projections raise `DatabaseReplacedError` on a retired version. Callers request a fresh snapshot. Existing SQLite read transactions retain their WAL snapshot. |
| Backup | Existing `durability.ts` backup ownership and retention remain. Retired pages enter the freelist; subsequent writes can reuse them. The next full `VACUUM INTO` omits free pages. |

The sweep includes ID gaps and retained versions in its bound. Grace plus sweep
latency determines the recurring retained-history floor. The pass does not claim
to shrink the live file. A missing or changed guarded trigger refuses retirement.

## Disposable verification

```sh
bun scripts/measure-registry-archive-retirement.ts --fixture
```

Run through the gate wrapper with private HOME, XDG_CONFIG_HOME, LLV_STATE_DIR,
and TMPDIR, and a closed Viewer control URL. This command accepts no database
input: it creates a fresh synthetic fixture below TMPDIR, preserving the measured
production collection distribution. It reports per-collection physical payloads,
logical rows, allocated/free pages, two full backup file/write-byte measurements
on each side, preservation digests, and transaction timings. It removes only the
fixture root it created. Filesystem write-byte counters use Linux `/proc/self/io`;
other systems report them as null.

`registryArchiveRetirement.test.ts` exercises the actual controller and storage
path. Its child process kills itself with SIGKILL after its second committed
retirement batch. Another child resumes the persisted ledger; a third is a no-op.
Raw reachable/compatibility/mapping digests, every unsettled class and product
operation/message-key/launch-attempt replay reads remain equal. Tests cover the
grace, trigger refusal, rollback, high-water marks, ID gaps, concurrent observers,
approval withdrawal, a missing guard, held views and the cycle cap. The same file
runs against the minimum supported SQLite 3.39, including the child processes.
The CLI tests cover pre-upgrade read-only reporting, stale approval, bad arguments,
a missing database and a pending import in default or explicit SQLite mode. `stateOwnership.entryPoints.test.ts` starts the real CLI
with an operator-shaped disposable home and no owner token preset.

### Measured fixture result

The retained record is [evidence/registry-archive-retirement.json](../evidence/registry-archive-retirement.json).
The synthetic fixture matches production logical/cold/version counts; its
payloads are generated and its byte totals differ from the production copy.
The same recorded fixture supplied both before and after observations.

| Measurement | Before | After |
| --- | ---: | ---: |
| Logical rows | 197,898 | 197,898 |
| Cold logical rows, counted once | 163,118 | 163,118 |
| Superseded eligible versions | 321,240 | 0 |
| Eligible archive payload bytes | 552,988,136 | 0 |
| Allocated database pages, 4,096 bytes each | 703,751 | 707,979 |
| Free pages | 0 | 202,898 |
| Used pages | 703,751 | 505,081 |
| Full backup file bytes, both samples | 2,837,069,824 | 2,028,945,408 |
| Process bytes written, sample 1 | 2,837,204,992 | 2,029,215,744 |
| Process bytes written, sample 2 | 2,837,204,992 | 2,028,957,696 |

The backup file is 808,124,416 bytes smaller (28.5%). The live file retains its
allocated pages, including the ledger's temporary allocation; 202,898 pages
become reusable. All preservation digests match, with zero malformed mappings,
no foreign-key violations and an `ok` integrity check. Totals record exactly
321,240 retired versions and 552,988,136 payload bytes. One run of 1,286 delete
transactions, including the final empty transaction, observed p50 17.2 ms,
p99 34.0 ms and maximum 51.0 ms. These timings describe this disposable run;
production busy-hour verification remains with the seat.
