# Attempt temp under disk pressure

The serving Viewer's [Cleaner](cleaner-agent.md#automatic-pressure-pass) owns
automatic pressure-triggered retirement. The minute timer keeps its ordinary
expiry page and reports the working reserve and effective cap. The pressure
cursor described below belongs to the lower-level retention sweep.

## Persistent pressure passes

The scheduler follows the worktree sweep's pass and continuation pattern
(#4091). One SQLite inventory fixes the root identities and order for a pass:
recorded bytes descending, creation time ascending and path. This gives large
finished roots their place even while their expiry metadata is being backfilled.
Legacy scratch discovery runs at the pass boundary. A newly registered root
waits for the next pass. Each visit checkpoints its position before awaiting
work, so helper restarts resume the same inventory. Missing or replaced
identities do not enter that old pass.

Measurement and deletion happen together for the visited root. The scheduler
does not measure the rest of the inventory before reclaiming space. A tick has
the existing 40-second deadline, at most 1,024 visits, and stops at a 32-visit
page once it has removed a root. A root gets five seconds plus one second per
recorded GiB, capped at 30 seconds and the remaining tick. A truncated final
window gets one complete retry; interrupted quarantines have at most eight
resumptions per root per pass. Fully unavailable proofs advance the cursor.

For each visited root, the sweep builds a bounded proof of its descendant
directories and protection markers. Repeated checks on the same path reuse
the proof while it remains current. Quarantine renames, changed directory
metadata and proofs aged 30 seconds require a fresh observation. Traversal
checkpoints after 16,384 directories in a private SQLite inventory and resumes
after helper restarts. The directory count limits each preparation slice;
larger trees continue through further slices. Before a completed inventory
becomes a proof, every saved directory and marker version is revalidated.
An inventory change restarts that proof, and descendant pins still hold the
entire root. A continuing inventory receives up to the existing 30-second
root window, within the tick's deadline. At dispatch, native mutation watches
cover that proof while the sweep checks ownership, checkout links and process
inputs again. Explicit keep and Git markers, recorded custody, linked report
evidence, sockets and mounts remain removal guards. Every lane-owned removal
holds the existing retirement claim until the remover and journal cleanup
settle during pressure cleanup. Pipeline activation
writers honor that claim. Physical ancestry is checked at retirement as well
as registration; an unchanged leaf inode beneath a rebound ancestor grants
no authority. Stable ancestor aliases remain valid while their physical parent
binding stays unchanged. Command arguments, relative flag values and embedded
absolute input values use the
checkout link resolver's component-wise traversal, preserving symlink/`..`
semantics.

Disposable finished-lane roots with a recorded measurement reuse it before
deletion. These outcomes carry `allocation: "recorded"`.
Reclaimed bytes are attributed from that ledger measurement. A root explicitly
held for evidence or by a top-level keep marker still gets its measurement.
Before unlink, descriptor-pinned permission repair restores owner read, write
and execute bits on owned directories, the directory semantics of `u+rwX`.
Group/other bits, regular files, hardlinks and symlink targets are unchanged:
unlink needs a writable parent directory. Permission repair watches the root
and the directory undergoing repair. The disposable walk skips regular files
before opening descriptors and retains only traversal-depth descriptors.
Additive owner-bit repairs survive a budget cut. Full ownership, process and
preservation checks repeat after repair before any data deletion. Permission
dispatch rechecks pinned bindings inside its mutation fence and rejects stale
modes that would change group or other permissions.
Permission failures keep a reason in the ledger; partial native removals keep their
quarantine journal, and later roots continue. Scheduling and allocation records
grant no deletion authority.

Attempt retention has its own leased helper and coalesced request queue, so a
long worktree pass cannot consume its 60-second admission window. A busy state
database on one root defers that root and preserves the already-checkpointed
cursor. Busy diagnostic or final bookkeeping writes cannot abort later visits.
An unavailable shared ledger at connection setup defers the tick safely.

### Finished and missing owners

`completed` and `closed` both count as finished through `laneFinish`;
`engine.ts` stamps `closedAt` on completion. A valid finish clock, settled
activity and no running/unconfirmed attempts or active delivery/merge remain
required. Scratch becomes eligible strictly more than 24 hours after the latest
authoritative terminal event, including under pressure. Evidence copies and
recorded-check custody keep their independent seven-day lifetimes. Archiving changes visibility,
and the underlying lane state still decides retention.

A missing lane record is `orphan` and grants no production scratch retirement
authority. Creation time and mtime cannot establish a completion. A root
without a pipeline binding checks its durable standalone launch/host: live,
starting, pending-resume and missing-receipt owners stay protected.
`LLV_ATTEMPT_TEMP_MAX_AGE_DAYS` is the legacy orphan-age setting and does not
replace the strict completion-age policy.

`attempt-temp-report.json` and the tick line expose `pass` progress, tick and
visit counts, cumulative removed roots/bytes and elapsed time. `lastPass`
distinguishes completion from pressure clearing early; `lastFullPass` retains
the latest full-pass duration even after a later partial pressure episode.

Outside pressure, a scheduled tick admits up to 32 roots by recorded expiry
and directory. The helper has a 60-second request deadline, including
admission and reply. Root work has a 40-second soft budget inside that
deadline. Each root gets a size-based window of 5–30 seconds, bounded by what
remains of the tick. A saved traversal can use up to 30 seconds on the next
visit. The Viewer awaits the helper asynchronously and schedules the next
request one minute after the attempt and maintenance requests settle.

Every reported root decision has `outcomes[].reasonCode` and a human-readable
`reason`. `retryAt`, when present, is the next ledger admission time in epoch
milliseconds.

| Decision | Reason codes |
| --- | --- |
| Deadline or contention | `tick_budget`, `root_budget`, `checkout_budget`, `protection_budget`, `allocation_budget`, `mutation_fence_budget`, `permission_budget`, `namespace_budget`, `ledger_busy`, `admission_busy` |
| Proof or recovery deferred | `protection_checkpoint`, `protection_marker_limit`, `protection_changed`, `checkout_changed`, `proof_unavailable`, `proof_changed`, `recovery_binding_scan` |
| Live reference or unavailable inventory | `process_reference`, `unix_socket_reference`, `checkout_link_reference`, `checkout_unknown`, `checkout_unreadable`, `container_mount_reference`, `container_inventory_unknown` |
| Retained data | `mount_boundary`, `git_boundary`, `keep_marker`, `namespace_tree_hold`, `recorded_evidence_hold`, `recorded_evidence_lifetime`, `linked_evidence_hold`, `declared_evidence_hold`, `operator_permissions` |
| Ownership or a changed guard | `owner_*`, `expiry_unconfirmed`, `expiry_admission`, `expiry_revoked`, `authority_changed`, `root_identity_changed`, `root_ancestry_changed`, `evidence_changed`, `recovery_owner_unknown`, `recovery_restored_before_expiry`, `dispatch_refused`, `dispatch_reference_or_changed` |

Outside pressure, an expired
root whose proof must start over normally waits 15 minutes before the next
visit. A saved checkpoint, journaled removal or tick that ran out of time can
resume sooner.
Allocation refresh skips expired roots during their retry interval.

`cleanup.oldestEligibleRootAgeSeconds` reads the oldest expired deadline
currently due for a visit. A visit still has to prove identity, authority and
the absence of holds. `adopted` counts root ownership recovered this tick.
`copies.adopted` counts newly discovered evidence copies.
`copies.sourceAttributed` counts existing legacy copies matched to a
registered scratch source. A bounded repair cursor examines existing copies,
and a retiring root checks for its copy before dropping its ledger entry.
The legacy copy keeps its owner and retention clock. Its allocation leaves
the `copies.unattributed` count and bytes.

The root ledger is written by registration, release, bounded retention
backfill and visited-root measurement. The sweep owns the new pass tables
under its process-shared sweep lock. Production reads the returned fields into
the existing JSON report and log; fixture helpers exercise the same ledger
reader after process restarts. The report adds fields without changing its
existing accounting fields or removal controls.

The partial protection inventory has one writer and reader,
`src/lib/runtime/attemptProtectionInventory.ts`, called only by the descendant
snapshot builder under the sweep lock. It stores pending directories, completed
directory versions and marker bytes; directory completion and discovered
children commit together. A root metadata binding invalidates replacement
roots, and recovered paths must remain canonical descendants. Completed
snapshots feed the existing tree inspector and native mutation fence. Retirement
forgets both original and quarantine inventories; forgetting a vanished root
also removes its partial inventory. These records grant no removal permission.
Each registered owner has at most two inventory files, for its original and
current quarantine names; retiring or forgetting the owner removes both.
After quarantine renames a proven root, its completed inventory is translated
to the new name only while identity, mode and mtime agree. The new root ctime
is sampled, and every translated descendant and marker is checked again before
dispatch. Refused quarantines discard their temporary inventory after restore.

## Historical page scheduler

The sections below record the earlier scheduler and its original evidence.
The persistent pass above replaces its fractional windows and wrapping page.

This change is stacked on #4033. Its base already carries the shared parent/helper
deadline; #4033 leaves deletion policy and the four/32-root page sizes unchanged.

## Base causes

These citations name `47fbd4a6`, the #4033 head used for the cause analysis,
before the subsequent merge of main:

- `src/lib/runtime/attemptTempRetention.ts:333` raises the page size from four to
  32 above the cap. It does not change the evidence-hold admission at lines
  423–442 or its required expiry at lines 374–376. Closed-lane roots without a
  hold already qualify at line 522, but take the evidence-preservation path at
  lines 532–542 until expiry. A retained copy can consume the reclaimed space.
- Lines 350–358 spend the shared inventory budget reading authority before
  visiting a root; lines 509 and 550 read it again. Authority for an ended stage
  in an open lane walks its producer checkout
  (`src/lib/runtime/attemptTempProduction.ts:38–54`). Consumer checkouts and the
  protection snapshot add their own work. Hence a bounded page can remove none.
- Lines 360–365 restore unvisited candidates' old scheduling positions when the
  budget ends. `AttemptTempStore.due` at lines 141–166 combines expired and
  released prefixes. An inventory cursor is missing, so the same expensive
  roots can lead subsequent passes.
- The helper gives root work 40 seconds
  (`src/lib/runtime/attemptTempProduction.ts:97`); the parent allows 60 seconds
  (`src/lib/pipelines/worktreeSweepWorker.ts:16`). #4033 clips work to the
  shared deadline with a one-second reply margin. Checkout inventory gets up
  to 30 seconds (`attemptTempRetention.ts:338`); protection snapshots get up to
  30 seconds and 10,000 directories (`attemptTempFilesystem.ts:839–858`).

## Safety and scheduling

Recorded custody, explicit keep markers, linked report evidence, running
attempts, process references, checkout links, sockets and container mounts remain
deletion fences. An ended stage alone cannot prove an idle producer checkout
has stopped using its scratch: its link inventory is still necessary. All
asynchronous observations are revalidated at quarantine and deletion dispatch.

A bounded largest-due prefix now leads pressure selection; ordinary pages also
prefer recorded allocation. The remaining pressure cursor is durable, ordered
by creation time and path, and advances
before a candidate's full-window asynchronous observation. Fractional probes
and the reserved tail do not advance it: after restart, the roots they passed
receive full windows in turn. The default search finishes the suffix after the
cursor before wrapping. A protected suffix without deferred proofs wraps in
the same bounded search, so earlier available roots cannot cause an empty pass.
Deferred suffixes retain their retry reserve before the next pass.
After retirement makes progress without any
deferred proof, a partial page can fill from the wrapped inventory within the
same deadline and page limit.
Explicit diagnostic pages keep their existing
wrapping behaviour. Failed or deferred full-window roots move behind
the rest of the inventory. A finite unchanged inventory of N roots is visited in
at most N pressure passes when each pass can admit one root; when a page fits,
the cursor share has a bound of ceil(N/16), alongside the largest-due share.
Newer arrivals join behind older cursor inventory. Each root
visit gets at most five seconds of the existing 40-second work budget. The first
candidate gets the full five-second window, clipped to the remaining tick.
Completed holds leave that window available to the next candidate. After a
retirement, subsequent candidates also get full windows. Once a proof exhausts
its window, half the remaining tick is reserved for subsequent full proofs;
the other half funds traversal past further timeouts. Full proofs spend that
credit by their actual elapsed time. Once it cannot fund another full window,
visits share the traversal time, retaining up to five seconds for the last
candidate and another five for a fractional-proof retry in the bounded search.
Thus one timeout leaves full windows for
finite checks, while a long timeout prefix still leaves time to reach later
roots. Unused time stays available to later roots. If the search ends without
a retirement, the retry reserve funds up to 32 retries
of fractional probes, nearest the tail first. A root-level `.delegatus-keep`
marker skips retry admission without spending a full proof window or one of
the 32 retries. Its provisional deferral and allocation estimate remain until
a later measurement. This cheap positive hold lets retries reach an available
ended root even behind many expensive protected roots. An absent marker grants
no deletion authority; admitted retries still repeat every retirement fence.
Full-window timeout roots are
excluded from those retries. Each retry repeats all deletion fences and keeps
the durable cursor at its earlier position. The original deadline still clips
every visit; the bounded search examines at most 1,024 distinct roots plus 32
retry visits. A retry replaces its provisional deferred outcome, while
`checked` counts both visits.
Fresh accounting that clears cap pressure stops retries; low-space mode keeps
its existing independent admission.
Physical I/O or a protection refusal can defer deletion; reports
retain that reason.
If the first page completes no deletion, the default pressure sweep searches
further pages, up to 1,024 distinct roots and the same deadline, until a page
removes something. A bounded indexed selection chooses the suffix before visits
start. A completed protected suffix can append a bounded wrapped selection;
the combined search still contains at most 1,024 distinct roots and reserves
full windows for its tail and a fractional-proof retry.
Explicit diagnostic page limits still apply. A cleared
pressure episode resets the cursor so the next episode starts oldest first.

A pressure pass in removal mode guarantees at least one completed retirement
when its bounded search reaches an ended, unpinned root whose measurement,
authority, reference and protection checks, quarantine, removal and receipt can
finish inside its assigned window, while all fences remain current. The window
is `min(5000 ms, remaining tick)` before a timeout, while full-proof credit
remains, for the last search candidate, for a reserved retry, and after a retirement; other visits
share the traversal budget described above. The original deadline clips every
window, including the last one. Earlier checks that respect their bounds
cannot consume the reserved traversal budget.
In particular, a page of 33 ended roots with identical 1,500 ms allocation or
protection checks makes progress on every nonempty pass across helper restarts,
including when a completed operator hold precedes the removable roots or an
exhausted proof precedes finite checks. One timeout before 32 finite checks,
and timeout prefixes of eight and 32 roots before eight finite checks, make progress across restarts in
over-cap and low-space modes. This covers eight exhausted checks followed by
an available ninth root and a full exhausted page followed by an available
root. Protected-tail regressions also cover four or eight timeouts before 32
finite checks and a keep root, in both pressure modes and both proof phases.
The separate retry reserve lets a deferred finite check finish, including when
the protected tail needs a 3,000 ms allocation proof. Restarting with
proof available drains the ended roots and preserves the keep root. Zero removals remain valid
in dry-run mode, if fresh measurements clear cap pressure before a retirement,
if admission/recovery or unavoidable I/O/cleanup exhausts the
deadline, if every visited root is protected or fails to finish in its share,
or if the only eligible roots lie beyond the 1,024-root search ceiling (or an
explicit smaller page limit). Those roots retain their reasons and durable
cursor position for a later pass; no proof or deadline is relaxed.

Above the cap, closed lanes and ended stages without an explicit evidence hold
qualify at any age. Pressure removes unlinked scratch captures with their root.
Linked report evidence
and recorded-check holds stay protected. Below the cap, the existing evidence
preservation and retention policy continues. A pressure pass stops at the cap,
unless the filesystem is low on space.

`AttemptTempStore.register` and legacy adoption produce root ownership rows;
release is only a scheduling hint. The sweep reads the binding again at every
dispatch. `pressure_cursor` has one writer (`checkpointPressure`) and one reader
(`pressurePage`), under the existing process-shared sweep lock. It stores the
last visited creation time and path, so deleting that root needs no cursor
cascade. Older ledgers start without a cursor. Neither evidence copies nor
recorded-check manifests inherit or write the cursor. Space observation uses
`statfs.bavail * statfs.bsize` on scratch, never the checkout's filesystem.
Cap accounting uses the ledger's measurements; unvisited roots retain their
last measurement. The low-space switch observes filesystem availability directly.
An unreadable measurement is a lower bound: it can increase a recorded size,
and cannot reduce it. Only a complete measurement or physical removal can
reduce that root's pressure accounting. Outcomes retain the unreadable flag.

Standalone roots resolve their launch through keyed registry facts. Starting,
live, pending-resume and incompletely terminated hosts remain protected even
when the process snapshot is empty. The existing `finishedAgent` proof checks
pending actions, claims, exits, termination survivors and recorded process
identities. A proven ended host receives the usual retention deadline and
qualifies immediately under pressure. The exact observed facts must still
match at quarantine and deletion dispatch; registry files participate in the
mutation fence. Missing receipts retain the existing orphan grace period.

The existing ownership producers are `structuredSpawn.ts` (scratch and config
roots with the same owner and a creation timestamp) and legacy adoption.
`structuredSpawn` cleanup marks release. `viewerInstrumentation.ts` initializes
the ledger at startup. Recorded-check admission validates `owner`; the generic
temp sweep treats registered roots as held by this sweep. Automatic evidence
copies and temporary-data retention read `owner`/`copy` and keep their separate
lifetimes. None copies the pressure cursor. The report writer remains
`attemptTempProduction.ts`; `state/diskPressure.ts` reads its allocation and
retention forecast and tolerates the additional pressure fields.

Main's W5 recovery is preserved. Restored trash keeps its existing owner and
expiry proof, plus the recovery watches at dispatch. Recovery retry timestamps
remain calendar values; its enumeration window is clipped to the shared
monotonic remainder. Pressure scheduling uses the same restored ownership rows.

Below 20 GiB available to the current user on the scratch filesystem, pressure
cleanup continues below the cap. This fixed default reserves working space for
checks, SQLite and recovery writes without a new setting. It also activates
before available space falls into the low tens of GiB. A failed filesystem
space observation is reported explicitly and leaves low-space mode disabled.

The effective cap also accounts for available scratch-filesystem space. See
[Closed lane scratch deadlines](closed-lane-scratch-retention.md) for the
current reserve, metadata backfill and source-export lifecycle.
# Approved manifest execution

`bun scripts/attempt-temp-approved.ts --review <full-review-id> --manifest <retained-json>`
requests a bounded page from the existing leased attempt-temp helper. This local
operations entry belongs to the authorized cleanup executor after the reviewed
release is deployed. It performs no discovery or deletion outside the manifest.
The ordinary timer and the exact selection share the attempt-temp sweep lock,
retirement claims, fresh authority and reference checks, protection inventory,
native mutation fence and remover. The manifest path grants no authority itself.

Before execution, the release/operations owner installs the reviewed private
binding as `$STATE/attempt-temp-approvals/<full-review-id>.json`, owned by the
installation uid and without group/other write permission. Its version-1 fields
are `taskId`, `project`, `reviewId`, the stored form's full `inputDigest`, the
retained artifact's full `manifestSha256`, `manifestName`, `count`,
`scopeQuestionId` and `executeQuestionId`. The retained evidence must establish
that exact artifact/form association. The executor cannot create bindings through
this command. This supports historical approvals whose form named the retained
file and observation window while their primary inventory report held its hash;
installing the binding preserves the existing decision. No live binding is
installed by development tests.

The helper reads the local primary task round and verifies its project, task,
form digest and explicit human answers to both scope and execution questions.
Agent decisions, recommendations, skipped/custom/declined answers and changed
forms fail closed. Binding/decision changes revoke dispatch across awaited
observations. The manifest is limited to 4 MiB and 1,024 unique direct physical
scratch children; its exact bytes, count and basename must match the binding.
Each row uses the retained inventory's `path`, `laneId`, `launchId` and
`evidence.registry` fields `devInode`, `createdAt`, `released`,
`retainUntilClose` and `uid`. Fresh directory identity and registry ownership
must agree. Standalone roots are reported as held because this executor cannot
take a lane retirement claim for them; their lifecycle owner retains custody.
An approved selection requires the same strict completion age over 24 hours;
it grants no evidence or live-owner exemption. Shared recorded-check holds are
kept because releasing them could affect another root.

Each invocation visits at most 32 rows within the existing helper deadline and
writes intent and per-row results durably to
`$STATE/attempt-temp-approved/<full-review-id>.json`. It reports allocated bytes
retired and free bytes before/after on the same filesystem. `removed` and
`removedBytes` are cumulative for the manifest; `removedThisRun` and
`removedBytesThisRun` count only this invocation. `freeBefore` belongs to the
first execution page and `freeBeforeThisRun` to the current one. Other disk activity
may also affect free space. Exit 2 means pending rows remain; reconcile their
native retirement journals with the attempt-temp owner before retrying. Exit 0
means every row has a terminal result, including skips, and does not imply every
row was removed. A fresh invocation resumes the journal. A completed removal
receipt never authorizes a replacement at the same path. Dry-run previews can
later be executed under the same unchanged approval. The command never runs
global recovery, adoption, copy retention or a pressure-cursor transition.

The ordinary owner upgrades legacy seven-day scratch scheduling dates once in
an atomic ledger transaction (`user_version=1`), requeues old deferred rows and
resets the retention-backfill cursor. Fresh authority is still required at
deletion. Copy expiries and recorded-check required-expiry admissions are
unchanged. Reports expose `scratchPeriodDays: 1` and `evidencePeriodDays: 7`;
the existing aggregate forecast remains a seven-day lookahead across both
classes. Held manifest rows rotate through durable journal order on later invocations;
completed removal receipts remain sealed against replacement names.
