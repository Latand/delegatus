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
calls, so comparison includes the full fixture.
The default changed-catalog case changes 32 paths; `--single-change` changes
one path. The driver also records the controller's inventory-call trace, cold
runtime collection and the first full and summary frames. Run each condition
for three alternating pairs against the same seeded corpus.
The commands inside each isolated, admitted export are:

```sh
bun scripts/measure-history-projections.ts seed "$CORPUS_DIR"
bun scripts/measure-history-projections.ts run "$CORPUS_DIR"
bun scripts/measure-history-projections.ts run "$CORPUS_DIR" --single-change
```

Seed once; give each run a fresh isolated state directory. `CORPUS_DIR` names
the stage-owned synthetic corpus, outside either source checkout.

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
The cache-limit fixtures also restart a real process over the same stored data:
8,200 rows, eighteen 1 MiB payloads, and one 17 MiB payload. Each restart checks
the complete output digest, fresh payload reads, both cache bounds and SQL key
membership. These fixtures insert oversized stored rows directly; the ordinary
event API limits payloads to 16 KiB. The peer/restart case separately uses the
public journal writer.
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

The focused checks pass 75 cases; the SQLite 3.39 checks pass 51. All fourteen
guard-removal controls reject their mutations, including the real-writer
revision row, metadata boundaries, indexed readers, local and peer invalidation,
cache bounds, maintenance counters and failed-read cleanup.

All 429 importer and adjacent files completed. The initial campaign records
11,542 passing cases, 465 failures and 299 skips. Ninety-one red files reproduce
their failures in two complete main observations, with matching assertion
locations where a test frame is available and matching setup-error origins.
The three MCP launcher files additionally use freshly built bundles on both
revisions for their authoritative comparisons.

One registry caller initially missed a 50 ms timer-gap assertion, then missed
it in several cases on a recheck. Main missed the same helper in another case
and subsequently passed. Three fresh alternating whole-file pairs pass on both
revisions without changing that test or production code. The ledger retains
every earlier observation. With the latest complete observations it records
338 passing files, 91 pre-existing red files, 11,543 passing cases, 464 failures
and 299 skips. These counts disclose the remaining main failures.

Production-file hashes identify the measured implementation. The restart
fixture records its production revision and the digest of its strengthened
test overlay. The final merged-head typecheck is recorded in the stage report.

## Recorded costs

The measurements compare the merged main base and the tested implementation
identified in `evidence/perf/history-read-projections.json`. Each condition has
three alternating base/candidate pairs using identical copies of the corpus.
The process runs serially under Bun 1.4.0 on Linux x64, with three effective CPU
cores and a 14 GiB memory limit. The host has 24 logical CPUs. Global host load
varies during the samples and is recorded for each operation; external load is
not controlled. Each process retains its registry and journal objects for the
same sequential workload, so allocation and garbage collection also affect
elapsed time. These measurements support the work reductions and the observed
costs below; they do not establish an interactive latency guarantee.

Values are median milliseconds, with the three-sample range in parentheses.
The primary condition changes 32 catalog paths.

| Read | Before | After |
| --- | ---: | ---: |
| JSON registry: cold | 1946.762 (1566.520–2826.739) | 1122.320 (667.219–1261.584) |
| JSON registry: unchanged | 1.882 (1.695–2.641) | 1.458 (1.071–1.578) |
| Compatibility routing: cold | 2318.993 (1447.684–2654.921) | 2.399 (2.222–3.419) |
| SQLite registry: unchanged | 0.309 (0.250–0.388) | 0.508 (0.493–0.691) |
| SQLite registry: metadata-change | 7.732 (4.771–9.599) | 0.775 (0.771–1.028) |
| Compatibility routing: unchanged | 0.213 (0.212–0.318) | 2.527 (2.344–3.260) |
| Migration controller: unchanged | 307.322 (147.312–334.761) | 186.117 (137.618–224.261) |
| Migration controller: changed-catalog | 368.175 (174.807–376.819) | 265.209 (178.021–317.713) |
| Deferred worktree projection: unchanged | 1686.339 (613.198–1780.818) | 1149.505 (834.809–1396.525) |
| Runtime object: cold | 109.873 (91.807–114.826) | 152.262 (117.871–176.048) |
| Runtime full JSON: first-frame-after-object | 138.788 (101.613–143.832) | 26.628 (25.893–30.479) |
| Runtime summary JSON: first-frame | 177.245 (127.936–193.379) | 207.337 (190.768–227.716) |
| Runtime object: unchanged | 164.423 (77.648–180.286) | 26.236 (19.023–32.208) |
| Runtime full JSON: unchanged | 0.126 (0.073–0.128) | 0.142 (0.097–0.171) |
| Runtime summary JSON: unchanged | 0.124 (0.093–0.234) | 0.115 (0.084–0.136) |
| Runtime object: one-row-change | 97.853 (70.821–123.706) | 23.051 (18.202–29.953) |
| Runtime full JSON: one-row-change | 105.310 (70.122–130.911) | 30.029 (23.251–31.043) |
| Runtime summary JSON: one-row-change | 164.573 (126.499–225.906) | 18.913 (15.318–22.653) |

The one-path-change condition gives controller medians of 116.170 → 254.798 ms;
its idle pass measures 143.059 → 186.783 ms. The corresponding 32-path condition
above improves both medians. Context reads provide the deterministic work
bound: idle 64 → 32, one changed path 65 → 64, and 32 changed paths 96 → 64.
An await still forces a fresh context phase. The inventory-call traces match in
every sample. The single-path samples establish no controller latency gain.

Cold compatibility routing reads 9,103 registry payload rows and parses 5,660
before the change; the keyed metadata read does neither. A warm full snapshot
was already cached, so the paired keyed transaction raises warm routing cost
from 0.213 to 2.527 ms in the primary condition. SQLite metadata refresh already
avoided payload parsing on this base; its improvement removes the remaining
historical header/order projection. The focused native-query guard verifies
that a real metadata writer, including its revision row, causes no historical
row or header reads.

The runtime selects the same 1,219 sessions. After population, an unchanged
object snapshot reads no payloads; a one-row update reads one. The full JSON
frame after that object reuses its parsed projections, while the summary variant
loads that changed row once. Complete public results still require copying or
encoding. Cold object population and first summary population are slower in
these measurements; those costs remain visible above. Existing unchanged
encoded-frame hits remain roughly 0.1 ms.

All corresponding returned-value digests match across three pairs in both
conditions, including the full 286,932,593-byte JSON and SQLite registry answers.
The evidence retains all timing, CPU, userspace-read, load and work-counter
samples, corpus hashes, source hashes and test-file receipts.

## Notes

`src/lib/pipelines/worktreeSweep.ts` remains unchanged in this lane. Its read-only
synthetic projection measures 1,686.339 → 1,149.505 ms in the primary condition
and 580.750 → 928.023 ms in the one-path condition. These are costs of the same
unmodified projection under the recorded workloads; no improvement is claimed.
Its bounded-read change belongs in the agreed follow-up after the disk-cleanup
lane merges.
