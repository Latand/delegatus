# Keyed task writes

Use `mutateTasks` with `patchTask`, or `mutateTasksFile` with `createTask`.
Inside a mutation use `readMutationTask(tasks, id)` for an authorization or
acknowledgement lookup. Keep the callback synchronous. The task list read API
remains unchanged, including the API consumed by the seat tick.

The serving Viewer prepares legacy rows during collection activation. It takes
a fresh SQLite backup, runs the previous writer's normalization under the
existing release and collection fences, commits the rows atomically, and then
writes a dependency marker. A task worker requests this preparation over its
existing owned pipe. It receives no startup authority or destination path.
Cancellation and worker generation are checked after module loading and lock
admission. An abandoned waiter cannot enter its mutation callback.

The marker includes the database identity, effective aliases, linked project
membership and local linked identity. Changed dependencies repeat the fenced
preparation. Losing the marker repeats an idempotent pass. A legacy row arriving
later is normalized when that row is touched. No schema change is required.

## Reproduction

Export the reference revision and the candidate to separate scratch directories
with installed dependencies. Isolate `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and
`LLV_STATE_DIR`; set `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1` and
`LLV_GATE_RUNNER=off`. Run one admitted command at a time.

For measurement only, in **both scratch exports**, change the existing
`withImmediateTransaction` logger in `src/lib/state/sqliteStateStore.ts` to
emit every transaction and retain the unrounded `heldMs`. The timer interval
itself stays unchanged. The benchmark requires exactly one tasks interval
per operation and refuses a changed input row count.

```sh
bash scripts/gate-slot.sh bun scripts/compare-task-writes.ts "$BEFORE" "$AFTER"
bash scripts/gate-slot.sh bun scripts/measure-task-writes.ts "$BEFORE" "$AFTER"
# Optional: positive row byte lengths only, with no task content:
bash scripts/gate-slot.sh bun scripts/measure-task-writes.ts "$BEFORE" "$AFTER" --sizes "$SIZES"
```

The measurement driver starts two persistent isolated processes and alternates
their operations; only one writer runs at a time. Each operation starts with
4599 task rows. Created cards are removed outside the measured interval.
Preparation, import, a list read and a no-op mutation precede measurement.
Patch and note target the last card. Note uses the general `patchTask` path.
The existing dedicated local-field writer remains keyed as well.

## Scope and retained behavior

The SQLite write lease and `patchSync` transaction remain authoritative.
Commands identify their input rows before producing a write plan; persistence
compares only those rows, receipts and migration markers. Finding guards seek
the existing finding index. Board admission reads the relevant project's
evidence through the existing project index. A single shared cache retains at
most 256 project summaries and 64 MiB of serialized UTF-16 content. It fills
on a cold read, eviction or journal expiry; later revisions update only journaled
rows. Admission keeps visibility counts, expiration deadlines and assignment
references. Production seat snapshots supply their current conversation/path
references, so only matching expired tasks need a seat check. Custom membership
and seat callbacks retain their dynamic checks on the relevant candidates.
Hidden creates skip board admission entirely. Accounting reads named parents;
completed findings select only their own group, preserving collection order
for timestamp ties. A synchronous alias snapshot removes per-row metadata probes.

Callers that explicitly enumerate history retain an array view and the old
ordering, replacement, deletion and nested mutation behavior. Scalar
`find`/`findLast` predicates inspect lazy row views; a match, nested field
read, enumeration or edit opens the row's mutable shallow copy. A command
shares those drafts with its input and output arrays, including assignment
arrays read before the command. Structural array edits end the command
shortcut; subsequent commands consume the actual reordered array.

The immutable array-reader projection is keyed by database identity and
aliases, with at most two database views and a 64 MiB byte bound under one
process-wide owner. It reuses an existing list or state snapshot on its first
read. Preparation warms these projections after releasing the tasks
transaction; list readers also warm each new snapshot, including admission
facts, before the next command. Repeated reads of that snapshot skip this work.
Warming verifies the database identity, revision and aliases before publishing
its caches; a concurrent change discards the unverified projections.
Later revisions decode only journaled rows, and seek their order and
byte metadata by key. Ordinary patches keep the existing index; insertions,
deletions and moved rows rebuild the ordered reference array once per changed
reader revision. A previous array view retains its own revision. Journal
expiry, alias changes, file replacement and eviction cause a fresh reader
snapshot. Only nested values that a callback reads get mutable copies. Explicit full-state saves
remain full-state operations. The alarm controller and tick scheduling remain
outside this change.

The differential sequence checks exact persisted JSON, row ordering, row and
task revisions, receipts, migration markers and command refusals through mixed
patches, notes, replay, finding matches, alias changes, done admissions,
presentation edits, deletion and recreation. Separate two-process cases check
different-row writers and a killed preparation before commit. A two-store
linked test compares preparation and peer edit ordering with the old first
write at the same frozen instant.

The write surface was traced before changing it:

| Callers or readers | Contract retained |
| --- | --- |
| Task HTTP create/update, MCP create/update | Command results, placement/revision guards, receipt replay and finding uniqueness |
| Assignment/send routes, task membership, Telegram reporting | Synchronous array callbacks, assignment/done admission and server note attribution |
| Board maintenance, curator, system runs, seat recovery, forge auto-merge, onboarding | Existing mutation callbacks and canonical project predicates |
| Finished-work and memory curation cleanup, account migration, runtime startup retries/consumers, production release | Explicit scans, replacements, deletions and no-write results |
| Linked apply/repair | Tasks and tombstones in the same commit; existing stamps and watermark order |
| Legacy activation, durability and rollback mirrors | Full saves and import/export shapes, extension fields and migration markers |
| List, keyed selection, task feed, project-key index and seat-tick evidence readers | Read signatures, frozen list projections, ordering and stored revisions |

The default destination remains `TASKS_FILE` from the process's declared state
root; explicit file arguments still select the adjacent SQLite database. Create
receipts keep their existing 100-entry cap and insertion order. The board limit
remains 300 visible bands; admission still evaluates the existing membership,
seat and time rules. Existing pure-array commands remain usable by adapters.

## Lazy effects moved to preparation

| Effect | Trigger retained | Source in reference release |
| --- | --- | --- |
| Completion fields | Status, stored updatedAt, assignments and preceding row | `src/lib/tasks/completion.ts:9`, `src/lib/tasks/store.ts:93` |
| Accounting readiness and hold history | Hold, status and stored updatedAt | `src/lib/tasks/accounting.ts:45` |
| Proactive scope | Row scope fields and effective project aliases | `src/lib/tasks/proactiveScope.ts:31` |
| Project canonicalization | Effective durable and recovered aliases | `src/lib/tasks/store.ts:264` |
| Finding ownership and counts | Finding group and effective aliases | `src/lib/tasks/finding.ts:30` |
| Status actor clearing | Status transition and previous actor | `src/lib/tasks/store.ts:97` |
| Field coercion | The row's stored fields | `src/lib/tasks/store.ts:234` |
| Derived linked stamps | Stored updatedAt, local identity and linked membership | `src/lib/links/taskStamp.ts:111` |
| Fresh machine/group stamps and tombstones | One preparation time and existing project watermark | `src/lib/links/taskStamp.ts:91`, `:101`, `:118` |
| Opaque revision tokens | Actual row change | `src/lib/tasks/revision.ts:67` |

The time-dependent linked effect uses the old function with one fixed time for
the preparation transaction. Stamps remain until the corresponding semantic
group changes. Expected-revision checks retain every refusal caused by an
actual preparation change.

## Reference stack mapping

Five token contexts in compiled chunk `57539.js` were checked against four
byte-identical source blobs of release `4931ed1d`. No adjacent source map was
available, so these are verified token-context mappings.

| Compiled line:column | Source in that release |
| --- | --- |
| 1587:25034 | `src/lib/tasks/store.ts:846` — task clone |
| 1711:166806 | `src/lib/tasks/revision.ts:17` — sorted JSON hash |
| 1587:10230 | `src/lib/tasks/store.ts:58` — completion/finding comparison |
| 1064:409 | `src/lib/state/sqliteStateStore.ts:1345` — SQLite/WAL signature |
| 475:43270 | `src/lib/projects/persistence.ts:83` — project revision signature |

## Reference whole-collection work

The following inventory uses file positions in release `4931ed1d`, before this
change. N counts task rows; C also includes receipts and migration markers.
Conditions distinguish alternative passes. Keyed command writes avoid these
collection passes; readers and explicit full-state replacements retain the
work they request.

| Pass | Source | Condition |
| --- | --- | --- |
| Decode all persisted rows | src/lib/state/sqliteStateStore.ts:3504 | Cold or stale change journal |
| Copy cached row map | src/lib/state/sqliteStateStore.ts:2976 | Incremental refresh after a commit |
| Rebuild ordered row vector | src/lib/state/sqliteStateStore.ts:3580 | Incremental refresh without order change |
| Sort/map row keys and values | src/lib/state/sqliteStateStore.ts:3568 | An insertion/deletion/order change |
| Sum source bytes over cached rows | src/lib/state/sqliteStateStore.ts:2194 | Publish refreshed read cache |
| Split all collection rows into tasks/receipts/markers | src/lib/tasks/store.ts:393 | A new write snapshot |
| Coerce every task; missing legacy revisions hash whole row JSON | src/lib/tasks/store.ts:367 | A new write snapshot |
| Group open findings | src/lib/tasks/finding.ts:32 | A new write snapshot |
| Rebuild finding-projected vector | src/lib/tasks/finding.ts:53 | A new write snapshot |
| Retain raw mapping and stamp projected finding revisions | src/lib/tasks/store.ts:374 | A new write snapshot |
| Map every task id for duplicate detection | src/lib/tasks/store.ts:380 | A new write snapshot |
| Recursively freeze new wrappers and their values | src/lib/deepFreeze.ts:17 | A new write snapshot |
| Define one draft accessor per task | src/lib/tasks/store.ts:853 | Every array mutation callback |
| Snapshot revision/status/statusBy for every task | src/lib/tasks/revision.ts:30 | Every array mutation callback |
| Snapshot all linked task groups and fingerprints | src/lib/links/taskStamp.ts:48 | Linked projects only |
| Find task index; accessors clone visited tasks | src/lib/tasks/commands.ts:600 | Patch; worst case N visited |
| Slice the task array; remaining accessors clone their rows | src/lib/tasks/commands.ts:859 | Successful patch/note command |
| Count project board tasks | src/lib/tasks/boardVisibility.ts:99 | New visible card; restoration |
| Find existing open finding | src/lib/tasks/commands.ts:455 | Keyed create |
| Find latest completed finding | src/lib/tasks/commands.ts:516 | Keyed create |
| Append by spreading existing tasks | src/lib/tasks/commands.ts:554 | New card |
| Find the task of a create receipt | src/lib/tasks/commands.ts:439 | Create replay with an existing receipt |
| Replace the matched finding occurrence in the result vector | src/lib/tasks/commands.ts:463 | Create matching an open finding |
| Reject another open holder of findingKey | src/lib/tasks/commands.ts:809 | Patch with a resulting open findingKey |
| Validate accounting parent references | src/lib/tasks/accounting.ts:31 | Create with originalTaskId/correctsTaskId, up to two scans |
| Find the accounting original task | src/lib/tasks/accounting.ts:34 | Create with originalTaskId |
| Scan draft slots to classify settled tasks | src/lib/tasks/store.ts:78 | Original draft returned; unlinked |
| Collect non-settled/all drafts | src/lib/tasks/store.ts:86 | Every successful array mutation |
| Canonicalize, retain fields and completion | src/lib/tasks/store.ts:88 | Every non-settled task; all for slice/spread |
| Compare persisted completion/finding to baseline | src/lib/tasks/store.ts:104 | Every baseline task not settled |
| Compare every linked task fingerprint and stamp its changed groups | src/lib/links/taskStamp.ts:96 | Linked projects only |
| Scan every linked baseline for deletions/tombstones | src/lib/links/taskStamp.ts:115 | Linked projects only |
| Scan all next tasks for a project watermark | src/lib/links/taskStamp.ts:77 | Once per project needing a fresh linked stamp |
| Compare revisions, deep JSON equality and fingerprint changed content | src/lib/tasks/revision.ts:68 | Every non-settled task |
| Select persisted row versus normalized task | src/lib/tasks/store.ts:113 | Every non-settled task |
| Merge settled and changed slots | src/lib/tasks/store.ts:122 | At least one settled draft slot |
| Spread task rows into complete state row vector | src/lib/tasks/store.ts:355 | Every successful array mutation |
| Build complete next-key set | src/lib/tasks/store.ts:816 | Every successful array mutation |
| Map committed keys | src/lib/tasks/store.ts:817 | Every successful array mutation |
| Filter committed keys for deletions | src/lib/tasks/store.ts:817 | Every successful array mutation |
| Build unchanged object set | src/lib/tasks/store.ts:822 | Every successful array mutation |
| Map complete committed key-to-row index | src/lib/tasks/store.ts:823 | Every successful array mutation |
| Filter complete next vector; compare rebuilt row JSON | src/lib/tasks/store.ts:824 | Every successful array mutation |

## Initial measurements and checks

Both final paired runs used Bun 1.4.0, three available CPUs, one active writer,
17 synthetic projects, 3942 done rows, nine repetitions per operation and
unlinked stores. Semantic timestamps were fixed at 2026-11-01T00:00:00.000Z;
transaction timing used the monotonic clock. Other machine work remained
present. Each table compares alternating operations in the same run.

The original fixture has 4599 tasks and 25,165,834 envelope bytes, SHA-256
`07594f5cb1eb5975e3dd53656e1c43ff7705624e3ca5f490c9f874a1f2ae337d`.
Starting load averages were 38.32 / 43.83 / 39.65. Times below are transaction
minimum / median / maximum in milliseconds.

| Operation | Before, 9 runs | After, 9 runs | After below 50 ms |
| --- | --- | --- | --- |
| Patch | 135.295 / 175.711 / 220.830 | 2.128 / 3.573 / 19.294 | 9/9 |
| Note through patch | 177.255 / 194.536 / 242.644 | 2.409 / 3.228 / 3.820 | 9/9 |
| Create | 151.261 / 198.997 / 226.668 | 5.679 / 9.576 / 29.703 | 9/9 |

A private read-only SQLite transaction exported the accessible installation's
tasks and aliases to read-only scratch files. It contained 4529 tasks and
26,710,482 payload bytes, differing from the incident's earlier 4599-row
snapshot. Row sizes were minimum 582, median 2651, p95 22147 and maximum
218707 bytes. The old full writer changed zero rows on this copy: completion,
finding, accounting, proactive/project and linked effects were all zero.

Only byte lengths from that copy were used to resample a second **synthetic**
4599-row fixture at the same 25,165,834 envelope bytes. Its row sizes were
567 / 2496 / 20379 / 200832 bytes (minimum / median / p95 / maximum), SHA-256
`d11d800c2914eb304eacc853643b1b5f89871940476d1f7552f7aa5cb7e5fd2a`.
Starting load averages were 36.20 / 43.21 / 39.49.

| Operation | Before, 9 runs | After, 9 runs | After below 50 ms |
| --- | --- | --- | --- |
| Patch | 122.055 / 142.157 / 180.811 | 5.745 / 6.924 / 16.644 | 9/9 |
| Note through patch | 143.614 / 165.185 / 197.847 | 5.664 / 6.950 / 12.688 | 9/9 |
| Create | 143.532 / 158.005 / 220.702 | 5.425 / 8.630 / 18.702 | 9/9 |

Before: 0/54 transactions below 50 ms; after: 54/54. Root task clones per
operation fell from 4599 to one for patch/note and zero for create. The list
reader supplies a project index to admission through at most eight weak
references to existing projections. Journal refresh reuses it across changed
revisions without decoding project history again.

The final protocol removes each newly created card with the same single keyed
deletion on both versions, outside timing. Earlier development runs using
full-array cleanup recorded create outliers of 58.491 and 84.907 ms on the
distribution fixture; those complete observations remain in retained evidence.
No repetition within either final paired run was discarded. These measurements
describe prepared stores under the stated conditions.

Preparation includes a fresh backup and is charged separately. The final
benchmark's initial preparation took 590.048 ms for the original fixture and
441.507 ms for the distribution fixture, changing zero rows in each. On the
private 4529-row copy, initial preparation took 1187.906 ms and an unused alias
change triggered an 834.605 ms re-run; both changed zero rows and preserved
exact stored JSON and row revisions. Immediate repeats took 2.194 and 0.479 ms.
The already-written accessible store therefore needed no backfill.

Separate probes on the identical synthetic fixtures measured the complete
backup/preparation call and the alias-triggered re-run:

| Fixture | Initial ms | Alias re-run ms | Immediate repeat ms | Changed rows |
| --- | ---: | ---: | ---: | ---: |
| Original, 4599 rows | 616.332 | 321.403 | 0.309 / 0.230 | 0 |
| Distribution, 4599 rows | 510.064 | 350.865 | 0.306 / 0.283 | 0 |

The final verification command window was 2026-11-13 17:50:51–17:53:03 UTC;
the separate preparation/API window was 17:56:11–17:56:23 UTC. These bounds
include their serial checks and cleanup. The benchmark commands both exited 0,
as did both preparation probes. Preparation changes no extension content,
ordering or stored revisions on these already-settled inputs.

The final differential replay passed 18 checkpoints, including a late legacy
finding duplicate and an alias transition. Exact opaque revisions were compared
with deterministic UUIDs. New store safety tests passed 13/13 (56 assertions),
SQLite store tests 36/36 (174 assertions), and diagnostic filtering tests 10/10
(99 assertions). The real task executor passed 36/36 (281 assertions). Types
and changed-file lint exited 0.

Two existing files remain red on the reference as well: `bindings.test.ts`
has three catalog/pipeline validation failures; `taskSync.test.ts` has two
stale index-count assertions (nine expected, eleven present). These matching
reference failures are retained separately from changed behavior. Command
receipts retain each command, exit status, test/assertion counts and measurement
rows; scratch probes that failed during development remain in that ledger.
The final commit's unmodified pre-push result is reported with the stage.

Each row below is one explicit file command under the wrapper and private
HOME/config/temp/state roots described above. Counts are the final observation
of that file, retaining matching reference failures.

| `bun test --timeout=60000 ./<file>` | Exit | Pass / fail / skip | Assertions |
| --- | ---: | --- | ---: |
| `src/app/api/tasks/activityLedger.test.ts` | 0 | 4 / 0 / 0 | 18 |
| `src/app/api/tasks/boardBandLimit.test.ts` | 0 | 5 / 0 / 0 | 22 |
| `src/app/api/tasks/finding.test.ts` | 0 | 2 / 0 / 0 | 27 |
| `src/app/api/tasks/route.test.ts` | 0 | 7 / 0 / 0 | 46 |
| `src/lib/links/taskFeed.test.ts` | 0 | 13 / 0 / 0 | 81 |
| `src/lib/links/taskSync.test.ts` | 1 | 21 / 2 / 1 | 1177 |
| `src/lib/mcp/bindings.test.ts` | 1 | 113 / 3 / 0 | 2027 |
| `src/lib/mcp/taskExecutor.test.ts` | 0 | 36 / 0 / 0 | 281 |
| `src/lib/mcp/taskFinding.integration.test.ts` | 0 | 4 / 0 / 0 | 56 |
| `src/lib/mcp/taskLineEdits.integration.test.ts` | 0 | 8 / 0 / 0 | 72 |
| `src/lib/projects/aliases.test.ts` | 0 | 10 / 0 / 0 | 29 |
| `src/lib/state/legacyCollections.test.ts` | 0 | 6 / 0 / 0 | 99 |
| `src/lib/state/sqliteStateStore.bounded.test.ts` | 0 | 25 / 0 / 0 | 868 |
| `src/lib/state/sqliteStateStore.lifecycle.test.ts` | 0 | 5 / 0 / 0 | 147 |
| `src/lib/state/sqliteStateStore.readCache.test.ts` | 0 | 16 / 0 / 0 | 58 |
| `src/lib/state/stateChildResult.test.ts` | 0 | 10 / 0 / 0 | 99 |
| `src/lib/tasks/accounting.test.ts` | 0 | 5 / 0 / 0 | 26 |
| `src/lib/tasks/boardTaskLimit.test.ts` | 0 | 13 / 0 / 0 | 44 |
| `src/lib/tasks/doneVisibility.test.ts` | 0 | 16 / 0 / 0 | 108 |
| `src/lib/tasks/finding.test.ts` | 0 | 7 / 0 / 0 | 66 |
| `src/lib/tasks/membership.test.ts` | 0 | 25 / 0 / 0 | 175 |
| `src/lib/tasks/proactive.test.ts` | 0 | 23 / 0 / 0 | 139 |
| `src/lib/tasks/revision.test.ts` | 0 | 6 / 0 / 0 | 74 |
| `src/lib/tasks/store.keyed.test.ts` | 0 | 13 / 0 / 0 | 56 |
| `src/lib/tasks/store.legacyFile.test.ts` | 0 | 4 / 0 / 0 | 13 |
| `src/lib/tasks/store.listView.test.ts` | 0 | 5 / 0 / 0 | 38 |
| `src/lib/tasks/store.sqlite.test.ts` | 0 | 36 / 0 / 0 | 174 |
| `src/lib/tasks/taskColorGroupHide.test.ts` | 0 | 12 / 0 / 0 | 62 |
| `src/lib/tasks/taskCreate.test.ts` | 0 | 27 / 0 / 0 | 84 |
| `src/lib/tasks/taskDetails.test.ts` | 0 | 5 / 0 / 0 | 35 |
| `src/lib/tasks/taskHold.test.ts` | 0 | 22 / 0 / 0 | 548 |
| `src/lib/tasks/taskNote.test.ts` | 0 | 3 / 0 / 0 | 13 |

## Review fixes and refreshed verification

The composed-edit regression adds an assignment through the mutable array and
then patches that same task. It checks both edits, completion admissions,
untouched rows and callback rollback. The one-project regression seeds 4599
rows, rejects whole-history reads and multi-task ordering, and bounds admission
fact updates across repeated writes. Both reproductions fail on the reviewed
implementation. Additional cases cover strict expiration, seat retention,
capacity released by hiding, completed-finding ties and accounting refusals.
These cases live in `src/lib/tasks/store.keyed.test.ts`.

The committed differential now compares 22 exact states with the reference:
the original 18 plus reverse/list/selection ordering, callback rollback, two
composed commands, and a nested assignment edit followed by a command.
All 22 match, including stored task and row revisions.

Eight explicit test-file commands passed: keyed store 17 tests/88 assertions,
SQLite store 36/174, state child results 10/99, done visibility 16/108,
board limit 13/44, task creation 27/84, accounting 5/26 and findings 7/66.
Total: 131 tests and 689 assertions. Changed-file ESLint and the clean source
export's `bunx tsc --noEmit` exited 0. An initial typecheck included a private
measurement probe accidentally copied into the export; that scratch-only input
was removed before the successful source check. No product code changed for it.

The refreshed paired measurements reused the two exact fixture hashes above,
each with 4599 rows and 25,165,834 bytes. Both remain synthetic; the second
uses only recorded row lengths. Conditions: Bun 1.4.0, three available CPUs,
nine repetitions per operation, one active writer, alternating versions,
prepared unlinked stores and keyed cleanup outside timing. Starting load
averages were 36.70/33.51/29.98 and 36.61/33.61/30.05. The reference was
`fbc7d2474b3c`. All observations are retained; no repetition was discarded.

| Fixture | Operation | Before median / max, ms | After median / max, ms |
| --- | --- | ---: | ---: |
| Original | Patch | 221.893 / 294.673 | 4.349 / 35.065 |
| Original | Note | 244.565 / 321.791 | 5.291 / 6.712 |
| Original | Create | 245.034 / 294.067 | 4.440 / 42.997 |
| Recorded size distribution | Patch | 243.362 / 316.505 | 11.302 / 48.776 |
| Recorded size distribution | Note | 255.932 / 315.053 | 8.240 / 12.160 |
| Recorded size distribution | Create | 246.475 / 310.045 | 5.510 / 38.357 |

The one-project control uses the same count and total bytes, hash
`2c90edbfa806b394538d9c5a0f79b75f25e90c9de3468e0274b9ecdfae84a54b`.
It compares the reviewed implementation `c9f7d5dbdec0` with the fix, with hidden
creates. Load averages started at 34.83/33.35/30.02. Create median/max fell
from 31.048/103.045 ms to 3.701/17.508 ms; patch and note maxima were
10.990 and 9.001 ms after the fix. Before, each create ordered 4599 task keys
plus 0–8 receipt keys; after, it ordered only those receipt keys. Across all
three fixtures the candidate completed 81/81 measured transactions below 50 ms.
Task-root clones stayed at one for patch/note and zero for create.

The retained reviewer probes add identical clone/hash/stat/order counters to
both scratch exports and use the measurement protocol above. Their commands
are:

```sh
bash "$GATE" bun scripts/reviewer-measure.ts "$REFERENCE" "$CANDIDATE"
bash "$GATE" bun scripts/reviewer-measure.ts "$REFERENCE" "$CANDIDATE" --sizes "$SIZES"
bash "$GATE" bun scripts/reviewer-oneproject.ts "$REVIEWED" "$CANDIDATE"
```

The scripts and command receipts are retained with the stage evidence, outside
the source tree. Every nested check proved reuse of its parent's admitted CPU
lease, and test files ran serially with fresh HOME/config/temp/state roots.
The final commit's unmodified pre-push exit is reported in the stage result.

## Mutable lookup and project rotation controls

The regression file now exercises nested assignments before and after a
command through both its input and output arrays, rollback, subsequent done
admissions, peer edits, finding ownership and cache invalidation during reader
warming. The four handed reproduction cases fail on the reviewed revision
`eb48635230a1` and pass on the fix. The maintained differential replay compares
30 exact states against the original writer, including command-then-nested
edits, reversal and project moves; the review's separate 30-state replay also
matches. Five explicit test files pass: 135 tests and 1428 assertions.

The final measurement window was 2026-11-13 21:14:20–21:14:45 UTC. Each fixture
has 4599 rows and 25,165,834 bytes. The two hashes and size distributions above
are unchanged: both fixtures are synthetic; the distribution fixture uses only
4529 recorded row lengths. No board content was copied. Conditions: Bun 1.4.0,
three admitted CPUs, nine alternating repetitions per operation, one active
writer, prepared unlinked stores, and keyed cleanup outside timing. The
reference writer is `d040eef4955f`; its task-store source matches `fbc7d2474b3c`.

| Fixture / lookup | Operation | Before median / max, ms | After median / max, ms |
| --- | --- | ---: | ---: |
| Original / keyed | Patch | 133.789 / 335.257 | 2.427 / 20.834 |
| Original / keyed | Note | 151.064 / 213.515 | 2.800 / 4.524 |
| Original / keyed | Create | 155.456 / 212.959 | 3.093 / 21.242 |
| Original / array find | Patch | 147.285 / 181.888 | 10.832 / 15.208 |
| Original / array find | Note | 144.776 / 162.149 | 11.065 / 13.294 |
| Original / array find | Create | 152.355 / 204.471 | 3.826 / 20.444 |
| Recorded sizes / array find | Patch | 131.709 / 196.874 | 12.096 / 17.036 |
| Recorded sizes / array find | Note | 127.706 / 161.643 | 12.679 / 14.350 |
| Recorded sizes / array find | Create | 134.694 / 165.925 | 4.130 / 11.492 |

All 81 candidate transactions above are below 50 ms. The lookup control counts
one shallow task copy and one task-root deep clone per patch/note, two task
fingerprints and five task-root serializations; create has zero task copies
and two task-root serializations. The predicate scans cached references, and
only the changed row's payload is refreshed.

Two rotations through 17 projects compare the reviewed writer with the fix.
Create median/max moves from 7.100/29.613 ms to 3.275/19.582 ms, with all
34 candidate transactions below 50 ms. Every candidate create performs zero
admission puts and two task-root serializations after preparation. The
reviewed writer repeats 270–271 puts and 272–273 serializations per create,
including its second rotation. This control removes its created card outside
timing; the committed regression also keeps the new cards to verify journal
updates.

```sh
bash "$GATE" bun scripts/compare-task-writes.ts "$REFERENCE" "$CANDIDATE"
bash "$GATE" bun scripts/measure-task-writes.ts "$REFERENCE" "$CANDIDATE"
bash "$GATE" bun scripts/measure-task-writes.ts "$REFERENCE" "$CANDIDATE" --lookup --sizes "$SIZES"
bash "$GATE" bun scripts/reviewer-array-lookup.ts "$REFERENCE" "$CANDIDATE"
bash "$GATE" bun scripts/reviewer-rotation.ts "$REVIEWED" "$CANDIDATE"
```

The reviewer drivers, raw measurements and identical counter/logger patches
are retained outside the source tree. An intermediate implementation retained
a 74.392 ms first lookup and a 50.092 ms cold rotation sample; those runs stay
in evidence. The final run warms the reusable projections during preparation
and genuine list reads, after the tasks transaction has ended. Its 115/115
transactions meet the bound without dropping a repetition.
