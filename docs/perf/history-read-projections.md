# Registry, migration and runtime history reads

## Read sites and cadence

The registry entry points are demand-driven reads. They run when their
callers need a registry view, including requests and background controller
passes. They have no timer of their own.

| Site | Input and existing selection | Change |
| --- | --- | --- |
| `src/lib/agent/registry.ts`, `readOnlySnapshot` | JSON fallback: normalized registry, cached by device, inode, size and nanosecond modification/change times | Freeze the newly parsed, privately owned value directly; remove the second whole-history clone. The signature check and retry remain. |
| `src/lib/agent/sqliteRegistryStore.ts`, `readOnlySnapshot` / `refreshSnapshotSteps` | Immutable hot rows and lazy archived rows; replay the existing registry change journal | A journal containing only recognized metadata changes replaces those normalized metadata values and keeps the immutable row collections. The new envelope receives fresh indexed readers through the existing binding code. Row, archive, missing-journal and unrecognized changes retain the existing recovery paths. |
| `src/lib/accounts/migration/controller.ts`, `syncCompatibilityRouting` | Compatibility account selection at controller cadence | Read the routing metadata through one keyed transaction, including the recheck under account admission. |
| `src/lib/accounts/migration/controller.ts`, `run` | Completed scanner catalog, file signatures and up to 32 rotating registry contexts | Reuse a context within a synchronous phase. After an awaited inventory write, obtain a fresh context before acknowledging it. An idle pass performs one context read per selected path. |
| `src/runtime-host/journal.ts`, `snapshot` / `snapshotAt` | All active sessions and the existing inactive-session window, attention/edge/task/flow/workflow projections | Select identities first, then reuse bounded cached payload projections for unchanged entities. Public object results remain detached copies. |
| `src/runtime-host/journal.ts`, `snapshotJson` | Full or voice-summary snapshot requested through runtime transport | Keep the existing encoded frame cache and expiry. Rebuild collection reuses entity projections; its stamp now includes peer commits. |
| `src/runtime-host/journal.ts`, `snapshotSessionValues` | Same selected sessions for full, summary and targeted voice reads | Cache full and summary projections by entity identity. Summary SQL runs only for cache misses. Targeted reads reuse those two variants. |

The account migration interval is 60 seconds, scheduled after a pass settles;
explicit requests can also request a pass. Runtime snapshots run on transport
requests (`src/runtime-host/host.ts`). `snapshot()` is also used during host
startup; unchanged `snapshotJson()` requests retain the encoded cache fast
path. The worktree sweep projection remains deferred to the disk-retention
lane's follow-up.

## Ownership, invalidation and compatibility

Registry metadata still has its existing writers and defaults. `setEngineRouting`,
account retirement and conversation reconciliation continue to write the same
metadata through registry mutations. `engineRoutingSnapshot` reads all engine
routes in one transaction, preserving a consistent pair for compatibility
routing. It changes neither the metadata schema nor its default engine slots.
Each production registry mutation also journals its `revision` control row.
The metadata fast path admits that counter and updates the snapshot revision;
it does not add a `revision` property to the registry file. Unknown metadata
keys and row changes retain the existing refresh path.

Each `RuntimeJournal` owns its parsed-entity LRU. It retains at most 8,192
variants and 16 MiB of encoded payload; JavaScript object and key overhead is
additional. A payload larger than that byte budget is returned without being
cached. Eviction removes the corresponding SQL invalidation key. Full and
summary variants share this budget. No per-conversation encoded frames are
retained.

Connection-local temporary triggers cover every entity insert, update and
delete, including `upsertEntity`, direct legacy SQL updates and retention
deletes. They record only currently cached keys, so outstanding invalidations
are bounded by cache membership. The trigger excludes an already-recorded key
before inserting it: an outer upsert's conflict policy can override a trigger's
`OR IGNORE` policy. Temporary cache-maintenance writes are excluded from the
journal's existing write counter. Actual entity writes still invalidate encoded
frames and effect-reader witnesses.

A main-database read pins each snapshot transaction before its peer-commit
witness is checked. A changed `PRAGMA data_version` clears the entity cache;
peer writes take the conservative cold-projection path. Rollback preserves
database truth, and a failed snapshot clears its registrations before retry.
Temporary tables and triggers vanish when their owning connection closes.
There is no durable schema migration or second state writer.

Session caching removes only stale live-turn text that the existing presentation
already omits. Receipt filtering and retry presentation still run once on the
original receipt identities. Durable session reads, events, receipts, voice
selection, inactive selection/order, edge expiry and public output fields retain
their existing semantics.

The full-object and encoded APIs still assemble their complete selected output.
Serialization and output copying scale with that output. These changes remove
repeated historical payload reads and decoding; they introduce no asynchronous
snapshot API or hard event-loop latency guarantee. Cold reads, peer invalidation,
and cache populations larger than either budget can still reload selected
payloads.

## Measurement procedure

`scripts/measure-history-projections.ts` creates a synthetic corpus using the
production registry performance dataset builder. Registry counts follow the
diagnosis: 13,204 conversations, 11,986 entries, 13,368 receipts and 20,376
delivery owners. The controller reads 3,150 paths belonging to that registry.
Runtime data has 11,958 sessions, with 1,091 hosted rows, four
running turns and retained text on idle rows. Together with the existing
128-inactive-session window this reproduces the diagnosis's 1,219 selected
sessions; the hosted/idle distribution is synthetic. The same seeded files are copied for each measurement;
their digests are recorded once. No live state is read.

Run the driver through the project gate wrapper in detached exports of the base
and candidate. Use `checkEnvironment` followed by `isolatedEnvironment` for each
process: private HOME, XDG, temporary and state roots, test environment, and
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. Finish session-host metadata backfill
before measuring steady-state runtime reads. Run one process at a time,
alternating base and candidate for three pairs. Each process performs the same
warmup, unchanged reads and deterministic mutations. Record elapsed time, CPU,
Linux userspace read bytes and host load. Output digests compare corresponding
answers outside the timed section.
Complete JSON and SQLite registry answers are also hashed after all timed
calls, so comparison includes the full fixture rather than only selected keys.
The default changed-catalog case changes 32 paths; `--single-change` changes
one path. The driver also records the controller's inventory-call trace, cold
runtime collection and the first full and summary frames. Run each condition
for three alternating pairs against the same seeded corpus.

The driver's worktree projection measurement uses this synthetic copy and a
deterministic process-proof callback. It changes no worktree-sweep source and
signals no process. Its cost is a follow-up note, with no optimization claimed.

## Validation

Focused tests cover immutable registry history across metadata changes, equality
with a fresh full reader, subsequent row changes, keyed routing, bounded context
reads and existing inventory races. Runtime tests cover output mutation,
one-entity invalidation, full/summary/targeted voice equivalence, peer edits that
keep their revision, deletion, reinsertion, rollback, failed reads, cache limits,
retry receipt presentation and a fresh-process read of the same database.
Metadata work bounds use the real writer, including its revision journal row,
and reject historical row/header queries during refresh. A receipt key that
matches a metadata field and an unknown metadata key exercise the fallback
boundaries. The interprocess compatibility-routing race pauses the paired
routing read before concurrent selection and verifies the admission recheck.

The importer campaign runs explicit test files serially, with a new isolated
environment for each file. Each file retains its complete output and exit status;
the campaign records its final ran count. A red file is rerun in the pinned base
under the same isolation before attribution.
The inventory contains 417 directly resolved importer files plus 12 explicit
child-script, evaluation and adjacent controls. Discovery resolves relative
imports and the `@/` alias across static, literal dynamic and `require` imports.
