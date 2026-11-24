# Startup host census without retired rows

## Originating requirement

On 2026-11-24 the operator asked for the 3,643 dead structured-host records to
be taken out of the path that Viewer startup and post-start pickup walk, so
that neither goes back to reading thousands of rows. If no safe tool existed,
the operator asked for a task to build one. The requirement reached this lane
through the designated seat, together with a read-only production audit of the
same day (prod revision `43fab846`). The audit's evidence is private to this
installation and is summarised below.

The pinned acceptance for this lane, restated:

- design first: which rows startup needs, whether to exclude archived or
  terminal rows from the census (preferred, no deletion) or retire them, and
  how the 67 hot rows that still carry `pendingAction="spawn"` are settled
  through their owning code;
- any data change takes a dry run, a verified and restorable backup of the
  exact registry revision, per-row terminal and liveness proof, settlement of
  pending spawns, receipts and delivery references by their owners, a recheck
  under the release generation and the writer fence, resumable bounded
  batches, skipped rows reported with reasons, and runs only inside the
  Viewer or runtime-host owners (`assertStateStartupMutation`), never from a
  build or a test;
- a production-sized synthetic replay (about 3,700 rows, about 3,650
  terminal) that compares selected rows, census time and recovery outcomes
  before and after, in isolated state;
- touched tests by path through `scripts/gate-slot.sh` with isolated state,
  full TypeScript, and the privacy gate from the merge base. Nothing runs
  against the live registry.

**Recommendation.** Option (a): startup selects host rows by a rule that
excludes archived rows unless outstanding work names them. No row is deleted
or moved. The stale spawn markers are settled by the spawn owner's own
entry-side failure settlement and by the staged-launch recovery, extended to
closed pipelines. Option (b), a backup-first retirement, is rejected: the
schema deliberately cannot delete archived history, and deleting the
compatibility copies would delete keyed history (§4).

## 1. What production holds

Two read-only observations, both from 2026-11-24.

**The audit** (08:57:26–08:57:27 UTC, registry revision 4183344, SQLite opened
`mode=ro`, `query_only`, write access denied by Landlock):

| Structured-host rows (four kinds) | Count |
| --- | ---: |
| all | 3,694 |
| dead, no live recorded process, archived | 3,580 |
| dead, no live recorded process, hot, `pendingAction="spawn"` | 67 |
| hot idle / live / unhosted | 23 / 7 / 17 |

| Startup phase | Attempt 1 | Attempt 2 |
| --- | ---: | ---: |
| reading structured startup registry | 28.867 s | 0.571 s |
| reading startup memberships | 5.232 s | 0.023 s |
| refreshing transcripts | 3.210 s | 2.495 s |
| reading runtime startup signals | 6.095 s | 3.381 s |
| full pass | ≈44.6 s to refusal | 66.385 s to ready |

The two attempts ran different work under different load, so the timings
show only where each pass spent its time.

**This design's read** of the hourly verified registry backup taken at
08:42:19 UTC (revision 4181613). The backup is a self-contained copy that the
durability owner integrity-checks before publishing it
(`src/lib/state/durability.ts:843-905`). It was opened read-only and immutable,
so the live database was not touched:

- 3,706 structured-host rows: 3,577 archived dead; hot: 67 dead, 40 idle, 5
  live, 17 unhosted. Archived payloads total 7.7 MB of JSON and hot payloads
  0.29 MB.
- All 3,577 archived rows and all 67 hot dead rows are in the released form
  that startup demotion skips (`src/lib/runtime/registry.ts:1352-1359`):
  status dead, no process, no claim, endpoint `stdio:released`, no active
  turn, attention or flags.
- No archived row's current conversation has an outstanding held delivery.
  Two have an open launch receipt on their conversation (receipt recovery
  owns those). 35 are no longer the current generation of any conversation.
  2,408 still record a memory unit; one records an unretired signal domain.
- All 65 interruption obligations name archived rows, and all are settled
  (discharged, delivered or failed). Two startup row retry records exist; both
  name archived rows and have not changed since 2026-10-30. The orphan alarm
  file is empty.
- 83 hot structured rows carry `pendingAction="spawn"`. Every one names its
  own launch receipt through `structuredHostOperationId`, which
  `stageStructuredSpawn` writes (`src/lib/agent/registry.ts:9017-9028`), with
  the same key and transcript path:

| Class | Status | Receipt | Count |
| --- | --- | --- | ---: |
| M1 | dead | failed | 61 |
| M2 | unhosted | failed | 16 |
| M3 | dead | `path-pending` (open) | 6 |

  Every pipeline behind them is closed (completed or closed); four rows
  belong to no pipeline. None records a process, claim, survivor or scope
  unit; 48 record a memory unit (32 dead, all 16 unhosted), and every signal
  domain they record is retired. None has an outstanding delivery. Their
  last writes date from 2026-10-06 to 2026-11-13. The failure reasons are
  first-message delivery outcomes (`src/lib/runtime/sendSettlement.ts:119-122`,
  `src/lib/memory/roleStore.ts:161`). Inference (the stored rows do not
  establish it): the receipts were failed by a path that changes only the
  receipt and its first delivery, `failSpawnInFile`
  (`src/lib/agent/registry.ts:9313-9346`). That path does not run the
  entry-side settlement that `failStructuredSpawnInFile` applies when it
  claims a failure (`src/lib/agent/registry.ts:9461-9528`). Once a receipt is
  failed, the second path returns early (`:9429-9431`), so nothing clears the
  marker afterwards.

The 16 unhosted rows were outside the audit's "terminal" count. They are the
same defect and are read on every startup, so this design settles them too.

## 2. Where startup reads host rows today

Every startup and post-start consumer obtains structured-host rows from one
of three lookups on `structuredHost.kind`. All three return archived rows,
because the store answers that lookup from the hot rows and from the archive
together (`src/lib/agent/sqliteRegistryStore.ts:4692-4715`):

1. `startupStructuredHostEntries` (`src/lib/runtime/startupSnapshot.ts:58-71`)
   decodes and clones every selected row;
2. the membership census (`src/lib/runtime/startup.ts:2614`);
3. the delivery controller's marker repair, whose key list also drives
   historical publication (`src/lib/runtime/structuredDeliveryController.ts:2431`,
   `:2473-2497`).

The archive keeps a compatibility copy of every archived row in
`registry_rows` and leaves it there (`src/lib/agent/registryArchive.ts:29-45`).
Archiving therefore removes nothing from these selections.

What each consumer does with every selected row, per pass:

| Consumer | Site | Per-row work over the whole selection |
| --- | --- | --- |
| census and row retries | `startup.ts:3321-3327`, `startupRowRetries.ts:48-66` | decode; one retry-file read per key |
| restart-cut recognition, interruption answers, Codex nudges, transcript refresh, runtime-read selection, adoption filter | `startup.ts:876, 1630, 1654, 1953, 2110, 2388`, all via `startupHostedConversationRows` (`:827-836`) | resolve each row's conversations; transcript refresh takes a keyed snapshot per row |
| runtime signals | `startup.ts:2110-2137, 2158-2230` | batched stamp pages over every selected conversation, one evidence request per conversation on a fresh boot, and a second stamp sweep before adoption |
| membership census | `startup.ts:2614-2622` | project memberships and aliases per row |
| adoption candidates and adopters | `startup.ts:3663`, `runtime/registry.ts:1481, 1660` | filter |
| dead-host reconcile (startup and every reaper cycle) | `runtime/registry.ts:1818-1845`, `reaperRuntime.ts:616` | decode; acts only on rows with a process |
| demotion | `runtime/registry.ts:1310-1372` | keyed snapshot per non-adopted row when the view is reused; skips released dead rows |
| unresolved-host check | `startup.ts:1561-1610` | keyed snapshot per non-adopted row |
| pass tail: retries, notices, orphan scan | `startup.ts:4230-4296` | keyed snapshot per row; retry notice and alarm handling |
| marker repair | `structuredDeliveryController.ts:2431-2443` | decode, keyed snapshot per row, one writer admission per `spawn` marker; the repair then refuses every dead or unhosted row (`agent/registry.ts:10248-10252`) |
| historical fallback publication | `structuredDeliveryController.ts:2473-2497` | `readSession` per conversation, plus an append when the runtime projection differs |

With 3,706 selected rows this amounts to thousands of decodes, thousands of
keyed snapshots per phase, about 3,700 retry-file probes, and two sweeps of
roughly 3,600 per-conversation runtime-host requests per boot (signals and
historical publication). An earlier acceptance
record measured historical publication alone at about 35 s
(`docs/acceptance/serving-readiness-1566.md:73`). Which of these dominated
attempt 1's 28.9 s is not established; the replay in §8 measures it.

## 3. Which rows startup must still see

The archive moves an entry only when it is dead with no host, structured
process, claim, pending action or survivors
(`src/lib/agent/registryArchive.ts:114-120`). Any later write to the row
promotes it back to hot (`registryArchive.ts:60-64`). Each consumer above acts
on a row only through one of these branches:

| Branch | Can it act on an archived row? |
| --- | --- |
| adoption, adopters, Codex nudge (gated by `shouldAdopt`) | only through the adoption filter's work clauses (`startup.ts:2416-2486`): an unresolved interruption obligation, a current seat recovery target, an outstanding held delivery on the current conversation, a pending runtime operation, or `pendingAction="handoff"`. The last cannot be archived. A live-turn claim needs status live and is excluded. |
| dead-host reconcile | no: it needs a recorded process |
| demotion | no for released rows; a non-released archived row would be cosmetically normalized (case 13 in §7) |
| marker repair | no: the marker blocks archiving |
| checkout merger recovery | only through captured or waiting checkout keys, which are keyed |
| row retries and notices | only for a key with a retry record |
| orphan alarm close | only for a key with a recorded alarm |
| pipeline deferral | marks every pipeline-member conversation in the selection as deferred while its pipeline evidence is unavailable or fenced |
| historical fallback | republishes when the runtime projection differs from the registry |

So startup must see **H ∪ W**:

- **H**: the hot structured-host rows of the view (every row on the JSON
  backend, which has no archive);
- **W**: archived structured-host rows named by outstanding work, each read
  by key:
  - **W1** hostKeys of unresolved interruption obligations (`owed` or
    `submitted`, `interruptionObligations.ts:498-500`);
  - **W2** current-generation keys of active seats' conversations (the seat
    recovery targets);
  - **W3** checkout-merger captured and waiting keys;
  - **W4** current-generation keys of conversations with a hot held delivery
    in `held`, `assigned` or `delivery-uncertain`, the same states the
    adoption filter reads (`startup.ts:2392-2396`);
  - **W5** current-generation keys of conversations with a pending runtime
    effect or a pending, queued, delivering or applying operation
    (`startup.ts:2342-2348`);
  - **W6** keys with a startup row retry record (list the retry directory);
  - **W7** keys with a recorded orphan alarm (the alarm file).

Two consumers need a keyed rule, so that they do not enumerate archived rows:
pipeline deferral (§5.4) and historical fallback publication (§5.5).

At 08:42 this rule selects 129 hot rows plus 3 archived rows: the current
host row of one active seat (W2) and the two retry-record rows (W6). No
archived row had an outstanding delivery, an unresolved obligation or an
alarm. That is 132 rows against 3,706 selected today.

## 4. Options

| | (a) Selection rule, no data change | (b) Backup-first retirement |
| --- | --- | --- |
| What changes | the three lookups return H ∪ W; two consumers decide by key | delete archived host rows after a verified full backup |
| Keyed history | kept: every archived version stays readable through `registry_records` | lost: deleting a `registry_rows` copy fires `registry_promote_cold_delete`, which deletes its cold mapping, and the row vanishes from `registry_records` (`registryArchive.ts:9-12, 60-64`). The archive versions themselves cannot be deleted (`registryArchive.ts:82-83`: "registry archive versions have no expiry"). |
| Older release during handover | unaffected: it reads `registry_rows` with its own selection | broken: `registry_rows` keeps the copies for exactly that reader (`registryArchive.ts:29-31`) |
| Does it remove the census cost? | yes, for every consumer at once | only if the cold mapping goes too, which is the history loss above |
| Backup, fences, batches, restore | not needed for the selection; needed only for the 83 marker settlements (§6) | a 3.7 GB exact-revision backup, a cross-process stop fence, trigger and schema changes in a shared table |
| Reversibility | revert the code | restore from backup |

(b) cannot meet "keyed history stays available" without a schema change that
contradicts two installed triggers and the handover contract. It is deferred
below. (a) is the smaller and the safe option.

## 5. Design of option (a)

### 5.1 One selection primitive

Add `registryHotKeysMatching(file, collection, field, values)` in
`src/lib/agent/sqliteRegistryStore.ts`. It returns the view's keyed lookup
(`registryKeysMatching`, which keeps the pinned-journal reconciliation of
`:4404-4411` and `:4606-4637`) filtered by the view's own cold-key map, the
one `hotRegistryRows` already uses (`:896-901`). Archived payloads are never
decoded. Plain registry files, which have no archive, answer every row as
before. The builder may instead drop the archive half of the SQL for this
lookup. Either way the answer must stay consistent with the view.

`startupStructuredHostEntries(snapshot, assertActive, work?)` selects
`registryHotKeysMatching(...) ∪ work` and decodes only those rows. The
membership census (`startup.ts:2614`) and the marker repair
(`structuredDeliveryController.ts:2431`) use the same union. Marker repair
also skips dead and unhosted rows before taking a writer admission, because
`repairCompletedStructuredSpawnMarkers` refuses them anyway
(`agent/registry.ts:10248-10252`).

### 5.2 The work set of a pass

The pass builds one `StartupWorkKeys` set. Every consumer reached from that
pass reads it, through a parameter or through the pass scope that
`startupSnapshot.ts:10-22` already carries. The one caller outside a pass,
the reaper's dead-host reconcile (`reaperRuntime.ts:616`), gets H alone,
which is exact for it because it acts only on rows with a recorded process.

- W1, W2, W4, W6 and W7 are known when the census is read
  (`startup.ts:3321`). W3 is known after checkout recognition (`:3371`). W5
  is known after the runtime signals (`:3596-3611`).
- The set only grows during a pass. Every consumer after a point uses the
  set as it stands at that point. The pass tail iterates the final union, so
  a W3 or W5 row that fails adoption still gets its retry record
  (`startup.ts:4253-4279`).
- Full passes and per-row retry passes compute W the same way.

### 5.3 Runtime signals

`startupRuntimeConversationIds` (`startup.ts:2095-2117`) selects the
conversations of H ∪ W, the owed conversations, and every conversation with a
journal-wide pending effect (`readStartupRuntimeEffects`). The effects page
already covers the whole journal. The builder must read the runtime host's
operation lifecycle and state whether every operation in `pending`,
`queued`, `delivering` or `applying` has a pending effect. If one can exist
without an effect, the builder adds those conversations through a keyed or
journal-wide read; selecting all archived conversations is not an
acceptable fix.

As built: a native queue receipt can stay `queued` after its outbox effect
completes, so the runtime host also pages every active operation receipt
(`startupSessionEvidence` with `pendingOperationsAfter`), and the effect
revision moves with active receipts. A runtime host of the preceding release
keeps serving until host handoff, after this Viewer is promoted. It answers
without operation pages, and its journal has no receipt triggers, so its
effect revision does not move with receipts. Startup then reads every active
receipt from that host's journal in one read transaction, and proves the
answer current by reading the same set again before use. Unrelated session
writes, which a live agent produces continuously, leave both answers equal.

### 5.4 Pipeline deferral by key

Today every pipeline-member conversation in the selection is marked deferred
while its pipeline evidence is unavailable or fenced
(`startup.ts:3509-3512`, `structuredDeliveryController.ts:2803-2806`). The
controller then refuses recovery for it until the re-probe clears it
(`structuredDeliveryController.ts:1059-1066`). Conversations outside H ∪ W
would lose that deferral. Keep it at the point of use: while the pass's
deferral regime is active, `deferTarget` and `canRecoverDeferredTarget`
evaluate a conversation outside the selection with the same single-entry
evidence the claim path already uses
(`pipelineStartupEvidence(registry, available, entry)`, `startup.ts:3452-3456,
3689-3692`), under pipeline admission, and defer it when that evidence would
have deferred it. The cost is one keyed read per message to such a
conversation during startup. Nothing is enumerated.

### 5.5 Historical fallback publication by watermark

Historical publication checks every structured conversation's runtime
projection on every boot. #3236 included archived rows on purpose
(`structuredDeliveryController.ts:2475-2476`). For an archived row the
projection can be wrong only after a publication failed before the row was
archived, or after the runtime journal file was replaced. The runtime journal
persists across processes; its `generation` is a per-process UUID
(`src/runtime-host/journal.ts:2333`) and cannot serve as a durable key.

The phase publishes for H ∪ W ∪ A_new, where A_new is the set of archived
structured rows whose `registry_archive.id` exceeds a watermark. The
watermark lives in `registry_meta` as `{ journal, archiveId }`:

- `journal` is `databaseFileIdentity` (`src/lib/state/currentDatabase.ts:42-49`)
  of the runtime journal path (`src/lib/runtime/deploymentLedger.ts:35`);
- `archiveId` is the largest archive id the last completed sweep covered,
  read when that sweep started.

A missing watermark or a changed journal identity makes A_new every archived
structured row, once. That is today's cost, paid on the first boot after
release and after a journal restore. The sweep writes the watermark after
its last batch, under the writer. A row archived again after promotion gets
a new id and is covered again. Because the watermark sits in the registry,
restoring the registry from a backup restores a watermark consistent with
that backup's archive.

### 5.6 Selection changes during a pass

The startup selection proof compares `entries` facts (kind, legacy host
kind, engine, session, path; `sqliteRegistryStore.ts:935-949`). Whether a row
is archived is not among those facts. Required semantics:

- a row promoted from archived to hot after the view was taken changes the
  selection, exactly as a new row does;
- a row archived after the view was taken does not change it, because its
  decisions in the pass are inert.

The builder extends the proof for `entries` keys in the change journal by
comparing their archived state in the view with their current state, and
counts only archived-to-hot as a change. Promotion during startup is rare:
sends to unhosted conversations are deferred while startup is pending
(`structuredDeliveryController.ts:1059-1062`).

### 5.7 What does not change

No schema object, trigger or archive predicate changes. No row is written by
the selection change. The JSON backend selects every row. A predecessor
release reading during handover keeps its own selection. The archive pass,
the liveness projection and the backups are untouched.

## 6. Settling the stale spawn markers through their owners

### 6.1 Owners and outcomes

**M1 and M2 (failed receipt).** The owner of an entry's spawn marker after
its launch fails is `failStructuredSpawnInFile`
(`src/lib/agent/registry.ts:9461-9528`). Factor its entry-side decision into
one function, `settleFailedLaunchEntry(file, receipt)`, and call it from the
existing path, whose behaviour stays unchanged, and from a new convergence
for receipts that are already `failed` or `conflicted`. Its two branches
apply as written:

- **retain**: the row records survivors, a recorded agent scope (scope or
  memory unit, `src/lib/runtime/agentScope.ts:18-26`), an unretired signal
  domain, or a registered live process. Only `pendingAction` is cleared.
  This covers 48 rows at 08:42.
- **release**: `host` null; `structuredHost` becomes the released copy for a
  resume successor that keeps its cursor, otherwise null; status dead;
  `claimOwner` and `pendingAction` null. The migration scope revision is
  advanced as the owner does.

The convergence never announces the failure, opens a task or writes a
lifecycle event. It does not touch the receipt.

A narrower "clear the marker only" settlement was considered and rejected. It
would leave a third terminal shape for a failed launch that no owner path
produces.

**M3 (`path-pending` receipt of a closed pipeline).** The owner is
staged-launch recovery (`src/lib/runtime/structuredSpawn.ts:2580-2615`,
`:2705-2790`). It leaves pipeline members to the engine's probe
(`:2588`, `:2608`, `:2757`), which never runs for a closed pipeline. Extend that
gate: a pipeline membership whose pipeline record is closed (state
`completed`, `closed` or `failed` with `closedAt`, read the way
`deadStageHostReason` reads it, `structuredRecovery.ts:61-75`) no longer
reserves the launch. The existing outcomes then apply: transcript evidence
of a user message leads to `recoverStructuredSpawnFromEvidence`; otherwise
`failStagedResume` fails the receipt through `failStructuredLaunchAndReap`
and `failStructuredSpawnOffLoop` (`structuredSpawn.ts:676-684, 2629-2644`),
which run `failStructuredSpawnInFile` and clear the marker. For a launch of
a closed pipeline the call passes `announce: false`: the pipeline has
already closed, and announcing weeks-old failures was not requested. A
running, paused or unreadable pipeline keeps the reservation.

**Effect of settlement.** The rows stop reading "synchronizing" (the durable
host record is still publishing ownership) in deliverability
(`src/lib/conversation/deliverability.ts:161-169`) and read "reclaimed", the
state every other failed launch reads. Orphan stops, retirement and temporary
data cleanup stop refusing them for "a pending spawn"
(`runtime/registry.ts:1227`, `structuredHostRetirement.ts:625-627`,
`temporaryDataProduction.ts:69`). The reaper's archive pass can then move them
(`registryArchive.ts:119`).

### 6.2 Safety envelope for this data change

The convergence `settleStaleSpawnMarkers` runs in the reaper's stale-spawn
step (`reaperRuntime.ts:620-639`, owner `terminalizeStaleStructuredSpawns`,
`structuredSpawn.ts:1309`) of the serving Viewer. It does not run in the
inventory sidecar (`reaperRuntime.ts:625-634`). Each requirement and its
mechanism:

| Requirement | Mechanism |
| --- | --- |
| owner-only | `assertStateStartupMutation(directory, "registry spawn marker settlement")` at entry, as `archiveInactive` does (`sqliteRegistryStore.ts:3574`). Against the operator's state directory, `apply` also requires the serving Viewer: owner `viewer`, an open release activation, no build phase, no test environment and not the inventory sidecar. A sandboxed state directory, which a test builds for itself, admits the same apply path, so the tests drive it end to end (`src/lib/stateOwnership.ts`). |
| dry run | the same function with `apply: false` returns the per-row plan without writing. The builder runs it against copies of the newest registry backup, the newest state backup (for pipeline records) and the runtime journal (`VACUUM INTO` from a read-only connection), with an operation-status source that reads the journal copy, in isolated state before release. Every row ends in a `would-*` decision or a named skip, recorded per row in private evidence only. |
| verified backup of the exact revision | the newest durability backup is verified before publication (`durability.ts:891-899`). A row is settled only if its current `value_json` is byte-identical to its value in that backup, compared inside the write transaction. The backup therefore holds every changed row exactly as it stood at the moment of the write. Otherwise the row is skipped with `changed-since-backup` and retried after the next hourly backup. |
| restorable | the convergence appends each row's before-image, the backup's name and revision, and the registry revision read in the write transaction to a 0600 settlement journal beside the registry. `restoreSettledSpawnMarkers(journal)` writes a before-image back only while the row still equals its after-image, and reports any other row. |
| per-row terminal and liveness proof | receipt `failed` or `conflicted` (M1, M2); key, path and `structuredHostOperationId` match; no process and no claim. Every recorded identity (`hostExitProcess`, `structuredHost.exitProcess`, `pendingHostExits[*]`, `previousHostExit`, survivors) is `processIdentityStatus === "dead"` by PID, start token and boot or PID-namespace epoch. A recorded scope or memory unit is not an active unit; the signal domain is absent or retired. |
| pending spawns, receipts, deliveries | skip `outstanding-delivery` when the conversation has a held delivery in a non-terminal state or a pending delivery-operation owner. Skip `operation-open` when the runtime host reports the launch operation non-terminal, and `runtime-unavailable` when it cannot answer. Skip `completed-receipt` for a completed receipt; `repairCompletedStructuredSpawnMarkers` owns live ones. |
| recheck under generation and writer fence | the decision is recomputed inside `registry.deliveryWrite({ label: "spawn.marker-settlement" })` from the current row and receipt. The runtime operation status is read in the same reaper cycle from the current runtime-host client. A refused admission writes nothing. |
| resumable bounded batches | at most `STALE_STRUCTURED_SPAWN_ACTUATION_CAP` rows per cycle; each row is idempotent; candidates come from H (markers block archiving), so selection is bounded. |
| skipped rows with reasons | every skip is logged once per row and reason. The sweep logs the batch's outcomes by class and reason whenever they change. An error keeps a bounded reason code (`authority-lost`, `owner-refused`, `runtime-refused`, `release-fence-busy`, the error's class) and the first line of its message, both for a deferred row and for a failed batch. |

M3 settles through the staged-launch path, which already runs under the
writer, rechecks with a recovery fence (`structuredSpawn.ts:2748-2753`) and
runs in the same reaper step. It adds the same owner assertion, the
before-image journal and the backup equality check on the entry row before
`failStagedResume` writes.

## 7. Outcomes by kind of row

Each case is an acceptance case for the builder's tests. "Catches" names the
broken branch the test must fail on.

| # | Row | Outcome after the change | Catches |
| --- | --- | --- | --- |
| 1 | hot live, idle, starting or unhosted | selected; adoption and demotion as before | selection dropping hot rows |
| 2 | hot dead released, not yet archived | selected until archived; demotion skips it | over-filtering by status |
| 3 | archived dead, no work | not selected; nothing done (as before) | selection still returning archived rows |
| 4 | archived + outstanding held delivery on its current conversation | selected through W4; adopted as before | missing W4 |
| 5 | archived + unresolved interruption obligation | W1; adopted as before | missing W1 |
| 6 | archived + active seat recovery target | W2; adopted as before | missing W2 |
| 7 | archived + checkout merger capture | W3; recovered as before | missing W3 |
| 8 | archived + pending runtime effect or operation | W5; its conversation is read; adopted as before | runtime read limited to H |
| 9 | archived + startup retry record | W6; tail clears, keeps or notices the record as before | missing W6 or a tail iterating only H |
| 10 | archived + recorded orphan alarm | W7; alarm closed as before | sweep leaving the alarm open (`orphanedHostAlarm.ts:161-172`) |
| 11 | archived pipeline member, evidence deferred | send stays deferred until the re-probe | deferral lost for rows outside the selection |
| 12 | archived, runtime projection differs | republished once through A_new; all once after a journal replacement | watermark advanced past an unconfirmed row |
| 13 | archived, not in the released form | not selected; today's demotion would only normalize endpoint and turn fields. Documented difference; 0 rows at 08:42 | none; the replay reports the count |
| 14 | promoted to hot during a pass | selection change, re-read; never skipped while carrying work | proof ignoring promotion |
| 15 | archived during a pass | no selection change; pass completes | proof counting archival |
| 16 | JSON backend or plain fixture | every row selected | hot filter applied without an archive |
| 17 | M1 or M2 meeting §6.2 | owner settlement (retain or release branch); archivable next cycle | marker left, wrong branch, announcement sent |
| 18 | M3 of a closed pipeline | recovered from transcript evidence or failed; marker cleared | closed pipeline still reserving |
| 19 | M3 of a running, paused or unreadable pipeline | untouched | gate opened too wide |
| 20 | marker row with a live or unproven identity, an active unit or an unretired domain | skipped with reason | liveness proof missing |
| 21 | marker row with an outstanding delivery or open runtime operation | skipped with reason | delivery references ignored |
| 22 | marker row changed since the backup | skipped `changed-since-backup` | write without a restorable before-image |
| 23 | settlement from a build, a test or the sidecar | refused | missing owner assertion |
| 24 | restore of a settled row | before-image restored when the row still equals its after-image; otherwise reported | restore overwriting a later write |

## 8. Tests and the production-sized replay

All runs use `scripts/gate-slot.sh`, a private HOME, XDG_CONFIG_HOME, TMPDIR
and `LLV_STATE_DIR` under the stage scratch, and `LLV_VIEWER_CONTROL_URL` on a
closed port. Nothing opens the live registry; the dry run opens a copy.

**Unit and integration tests (by path):**

- `src/lib/agent/sqliteRegistryStore.archivedOwner.test.ts`:
  `registryHotKeysMatching` returns hot keys only; pinned-journal
  reconciliation holds; cases 14, 15 and 16.
- `src/lib/runtime/startup.test.ts`: cases 1–11 through
  `adoptStructuredHostsAtStartup`, each class seeded beside 200 archived rows,
  asserting adopted, demoted, nudged and deferred keys and that archived rows
  without work are never decoded (`onRowPayloadRead`).
- `src/lib/runtime/startupRowRetries.test.ts` and
  `src/lib/runtime/startup.orphanAlarm.test.ts`: cases 9 and 10.
- `src/lib/runtime/structuredDeliveryController.test.ts`: marker repair over
  H only; historical publication over H ∪ W ∪ A_new; watermark write, reset
  on journal identity change, case 12; deferral by key, case 11.
- `src/lib/runtime/structuredSpawn.terminalize.test.ts`: cases 17–24,
  including the dry-run plan, the backup equality check against a real
  `VACUUM INTO` copy made in the test's state directory, and the restore.
- `src/lib/conversation/deliverability.test.ts`: a settled M1 row reads
  `reclaimed`.

**Replay.** Extend `RegistryPerformanceDatasetShape` in
`src/lib/agent/registryPerformanceDataset.ts`; do not write a new generator.
The new optional counts are: 3,580 archived structured rows, 61 M1, 16 M2,
6 M3 (closed pipelines), 7 live, 23 idle and 17 unhosted rows, and one
archived row of each work class W1–W7, case 11 and case 13. Payloads average
about 2.2 KB, as in production. Add one replay file,
`src/lib/runtime/startupHostCensus.replay.test.ts`, that drives
`adoptStructuredHostsAtStartup` with a port-0 fake runtime client and
records, per run:

- rows selected per consumer, archived payload decodes, keyed snapshots,
  retry-file probes, `readSession` calls and fallback appends;
- census phase and full pass elapsed time;
- an outcome digest: adopted, demoted, nudged, deferred, retry and alarm
  results, and marker settlements by class and reason.

By default it runs the dataset at one tenth scale and asserts the counts and
the outcome table, so it fits the five-minute file budget. With
`LLV_STARTUP_CENSUS_REPLAY=1` it runs full size.

Before and after: build the full dataset once with the head code, record its
sha256, and run the replay file five times on each side through
`gate-slot.sh --record`. The head side runs the branch. The base side runs a
`git clone --shared` scratch at the merge base with the replay file copied
in; the file uses only APIs present at `43fab846`. Every run reads a fresh
copy of the same dataset file. Report medians and p95, and the digests.
Accept when:

- head selects at most |H| + |W| rows in every consumer;
- the digests are equal apart from cases 13, 17 and 18;
- the base selects about 3,700.

Timings are diagnostic: report them and claim only what they show.

**Other checks:** full `bunx tsc --noEmit` once through
`bun scripts/local-gate.ts check-step types`, and the privacy gate from the
merge base as a recorded run.

## 9. Risks and limits

- W must stay complete. A future adoption clause that lets a dead row be
  adopted on new evidence must add its key source to W. The builder adds a
  comment at the adoption predicate (`startup.ts:2416`) naming
  `StartupWorkKeys`, and case 4–10 tests fail when a source is missing.
- The settlement changes 83 rows once. Their before-images stay in the
  settlement journal and in the verified backup.
- This design makes no claim about attempt 1's 28.9 s until the replay
  measures it. The runtime-evidence refusal that ended attempt 1 is not
  attributed here.

## Deferred — not currently justified

- **Option (b), backup-first retirement or purge** of archived host rows.
  History is the operator's record, and the selection rule removes the
  startup cost without deleting anything.
- **Changing the archive predicate** to require the released form. It would
  only keep cosmetic normalization (case 13); no row needed it at 08:42.
- **The liveness projection** keeps every dead row that records a memory
  unit (`sqliteRegistryStore.ts:1802-1823`), about 2,400 rows. It serves
  liveness readers, which are outside this requirement.
- **The deferral re-probe's conversation scan** (`startup.ts:4540`) reads
  every conversation while restart-cut rows are held. It is outside the host
  census.
- **`memberHostEntries` and the agent-state kind lookups**
  (`agent/registry.ts:7528-7531`, `agentState/service.ts:155`) still read archived
  rows. They are not startup paths.
- **Failure reporting** for the 73 failed receipts in M1 and M2 still marked
  `failureRepairState: pending`. Settling their markers neither needs nor
  performs it; announcing weeks-old failures was not requested.
- **The two retry records of archived rows** that have not changed since
  2026-10-30 are kept and handled as today through W6. Why the pass tail did
  not clear them is not established here.

## Validation against the requirement

- **The census and pickup stop reading thousands of rows.** Every startup
  and post-start consumer selects H ∪ W, 132 rows at 08:42 against 3,706.
  Historical publication reads only rows archived since its watermark.
- **Keyed history stays available.** No row is deleted, and archived versions
  stay readable by key.
- **The 67 rows are settled through their owners.** The failed-launch
  owner's entry-side settlement covers M1 and M2, and staged-launch recovery
  covers M3 for closed pipelines, inside the §6.2 envelope.
- **A safe tool exists.** The marker settlement and its restore form that
  tool; the purge stays deferred.
