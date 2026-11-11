# Seven-day retention for finished lanes' scratch and evidence copies

Install administrators read `FINISHED_LANE_RETENTION_DAYS` in
`src/lib/pipelines/laneFinish.ts` for the period. After an ordinary release,
the existing sweep drains due roots and copies in bounded pages; inspect
`attempt-temp-report.json` for retained paths, reclaimed bytes and errors.
No new interface control or manual cleanup command is required.

Status: implemented, 2026-11-11. Validation and deployment checks are in §15.
Historical observations below describe the design-stage read.
Code citations are on `origin/main` at `ec82e477` (#3835 merged at 00:51Z on
2026-11-11, after this lane's base `2449d4c3`). #3835 changed only
`tempSweep.ts` and `attemptTempFilesystem.ts`, so those two files are cited at
`ec82e477`; every other cited file is identical on both revisions (`git diff
--quiet` per file). Live numbers were read on the operator's machine between
00:40Z and 01:10Z by read-only commands (`ls`, `du`, `df`, SQLite opened with
`mode=ro` and `query_only`, the sweep report files). Nothing was swept, removed
or written outside this document.

## 0. Originating requirement

Operator decision, 2026-11-11, given in a decision form on the disk task. The
form asked how many days after a lane finishes Delegatus should keep that
lane's temporary folder and its evidence copies, and noted that today there is
no limit, so everything stays until someone cleans by hand. The operator chose
**7 days**. The same form set the disk target to at least 400 GiB free. (The
wording of the form is private and is paraphrased here because this repository
is public.)

What the lane must achieve, from the pinned specification: seven days after a
lane is completed or closed, its stage scratch roots and the automatic copies
of its attempts' evidence are removed by Delegatus itself, with no manual pass,
and everything that points at them is settled in the same step.

- The period is 7 days, one value in one place, readable by an install's
  administrator without a UI change. No new interface control.
- What starts the clock is stated and tested; a lane that is reopened, resumed
  or still has a running attempt is not finished.
- A recorded-check hold, an evidence link and an ignored-evidence pin stop
  protecting a root when the period has passed; the store rows, links and
  registry entries that referred to the removed root are settled, including
  rows a manual pass already left pointing at removed roots.
- Never removed by this mechanism: anything of an open lane; evidence a waiting
  decision form or prototype review still shows the operator; a keep marker set
  by a person; ledgers and reports of cleanup passes; branches, refs and
  commits; account stores and transcripts.
- Work per controller pass is bounded and resumable after a restart; removal
  never runs while holding the registry write lock or the state lease; a path is
  re-proved finished right before it is removed; a failure on one path does not
  stop the others and is reported once.
- The disk-pressure card names what retention will free and when, only where an
  existing surface already carries that text.
- Tests with an injected clock (§9).

**How this document reads "7 days".** The operator's question was about data
that today never goes. The period is therefore the longest any hold may keep a
finished lane's scratch or evidence copy. A root that nothing holds keeps
today's behaviour: it is retired as soon as its attempt or lane settles
(§2). Keeping such roots for seven days instead would add up to a week of
finished-lane scratch (live lanes add several GB within minutes) and work
against the stated purpose, a disk that stops filling. The automatic evidence
copy made when such a root is retired lives until seven days after the lane
finished, so a finished lane's captures stay available for the full period
either way.

## 1. Where each kind of retained data is created and what pins it today

| Kind | Created at | What keeps it today |
|---|---|---|
| Stage scratch root `statePath("scratch")/llv-stage-*` or `llv-read-only-stage-*` (the agent's `TMPDIR` is its `tmp/`) | `src/lib/runtime/structuredSpawn.ts:201` (`mkdtemp`); registered in the attempt ledger at `:220` (`AttemptTempStore.register`, `attemptTempRetention.ts:57-67`, owner marker `.delegatus-attempt-owner` at `:66`); host cleanup only marks it released (`structuredSpawn.ts:223-229`, `attemptTempRetention.ts:104`) | Retired by the attempt tick (§2). Pinned forever by any of the holds in this table. |
| Agent config root `$HOME/.cache/delegatus/attempt-temp/llv-stage-config-*` | `structuredSpawn.ts:217`, registered at `:220` | Same ledger and same rules. |
| Unregistered scratch roots (before #3217, or without an owner) | Adopted into the ledger, 32 names per tick, as orphans (`attemptTempRetention.ts:70-101`) | The orphan rule: one day after adoption (`:272-273`, `attemptTempProduction.ts:83`). |
| **Recorded-check hold** | `src/lib/recordedChecks/store.ts:243` inserts one `recorded_check_roots` row per manifest root with `held` defaulting to 1 (schema `:120`) when a stage hands off a recorded check | Cleared only at `:244-245`, when the row is acknowledged. Acknowledgement exists only as the `recorded_check` MCP action (`recordedChecks/api.ts:35` → `service.ts:421-450`), which requires a consumer in the binding conversation, its seat or the operator (`service.ts:418-420`). The attempt sweep refuses a held root at `attemptTempRetention.ts:221`, `:264`, `:290`, `:303`, and never forgets an absent root that is still held (`:363-366`). Root retirement records refuse an unacknowledged root (`store.ts:321-323`). Nothing expires the hold. |
| **Evidence link** inside a root (a symlinked `.artifacts` or a symlinked screenshot/video) | Written by the agent | `preserveAttemptEvidence` throws `linked attempt evidence` (`attemptTempEvidence.ts:25`) or `not a regular file` (`:37`); the sweep records the root as failed on every visit (`attemptTempRetention.ts:367-376`, a log line each time). |
| Checkout link into a root from a live process's checkout | Written by the agent in a worktree | `attemptReferencesClear` (`attemptTempFilesystem.ts:405` at `ec82e477`) holds the root as live. This is a running consumer, not a stale pin. |
| **Keep marker** `.delegatus-keep` anywhere in a root | `touch` by an operator or a capture driver, the purpose `bounded-cleanup.md` §4.1 gave it; agents also write it | `inspectAttemptTree` → `markerHolds` (`attemptTempFilesystem.ts:474`, `:478`, `:572`): held for ever. The legacy temp sweep honours it at the root (`tempSweep.ts:630`, `:746` at `ec82e477`). |
| Git link to a repository outside the root | Agents checking out other repositories inside scratch | `markerHolds` (`attemptTempFilesystem.ts:476-491`): held for ever. A repository wholly inside the root is disposable since #3473. |
| **Quarantine directory** `.delegatus-trash-<root>-<uuid>` with journal `.delegatus-sweep-<sha256(root)>.json` | `removeTreeViaTrash` writes the journal, then renames (`tempSweep.ts:410-424` at `ec82e477`; journal name `:560`) | Replayed by the attempt sweep through `sweepStaleTempDirs({ onlyDirectories })` while the ledger row exists (`attemptTempRetention.ts:210`, `tempSweep.ts:448`). A held row never reaches the replay (`attemptTempRetention.ts:221` runs first). |
| **Automatic copy of attempt evidence** `statePath("evidence","attempt-temp",<sha256(root,identity)>)` with `manifest.json {original, identity, files}` | `preserveAttemptEvidence` (`attemptTempEvidence.ts:14`, destination `:63-64`, manifest `:116`), called by the sweep before every retirement (`attemptTempRetention.ts:280`) | Nothing removes it. The ledger refuses evidence paths (`attemptTempRetention.ts:58-60`), no sweep lists `statePath("evidence")`, and the copy records **no lane**: once the root's ledger row is forgotten (`:358`) nothing ties the copy to a pipeline. |
| Recorded-check evidence copy `statePath("evidence","recorded-checks",<pipeline>,<run>)` | `retainResult` (`recordedChecks/service.ts:305-313`) | Nothing removes it. (Out of scope, §13.) |
| Per-lane evidence folder `statePath("evidence",<pipelineId>)` (`$LLV_EVIDENCE_DIR`) | `structuredSpawn.ts:205-209` | Durable by design (`disk-retention-fix.md` §4). Not an automatic copy; untouched here. |
| Worktree of a finished lane holding ignored evidence | Lane checkout | The worktree sweep keeps `ignored-files` (`worktreeSweep.ts:1419`), and after four days removes it behind a backup ref and an evidence copy (`:1318-1364`, `worktreeBackup.ts:21-60`, #3473). |

What starts nothing today: no record of when a lane finished is consulted by
any of the holds above. `attemptTempAuthority` (`attemptTempProduction.ts:14-49`)
answers `closed` for every completed or closed lane at `:20` without reading
its finish time.

## 2. What the automatic sweep removes today, and what stops it

The attempt tick runs once a minute in the sweep helper process
(`tempSweep.ts:985-989` at `ec82e477` → `worktreeSweepWorker.ts` →
`worktreeSweep.worker.ts:19-22` → `runAttemptTempSweep`,
`attemptTempProduction.ts:70-101`). The helper runs as state owner `tool`
(`worktreeSweepWorker.ts:49-53`). A pass takes the attempt-sweep admission
(`attemptTempRetention.ts:145`), adopts up to 32 unregistered names, selects 4
due rows (32 over the 100 GiB cap or during a disk-pressure episode, `:171`,
`attemptTempProduction.ts:77-80`) under a 40 s run budget (`:150`), and for
each: measures, refuses on a recorded hold, reads lane authority, inspects the
tree for keep and Git markers, checks process, socket, checkout-link and
container references, copies evidence, re-checks everything at dispatch,
quarantines and removes, records the retirement and forgets the row.

It removes, without any period:

- roots of settled attempts of open lanes, once their own checkout holds no
  link to them (`attemptTempProduction.ts:29-46`);
- roots of completed or closed lanes (`:20`);
- orphan roots one day after registration or adoption (`attemptTempRetention.ts:272-273`).

It never removes a root held by a recorded check, a keep marker, an outside
Git link, or a symlinked evidence entry; an absent root that is still held is
never forgotten.

Live, read-only, 2026-11-11:

| Observation | Value | Source |
|---|---|---|
| Last attempt report | 01:02:07Z: checked 25, removed 0; 12 held `checkout changed during final authority read` (the defect #3835 fixed), 3 `recorded check evidence hold`, 2 failed `linked attempt evidence`, 1 `tree evidence, mount or Git boundary`; ledger 483.5 GB, cap 107.4 GB | `attempt-temp-report.json` |
| Ledger rows | 1 400: 739 present with a lane, 481 present without a lane, 180 absent (128.6 GB of last-measured bytes still counted) | `attempt-temp.sqlite`, read-only |
| Recorded-check root rows | held: 211 present, 26 absent (every held row has a ledger row); released: 76 | `state.sqlite` `recorded_check_roots`, read-only |
| Recorded-check runs | 122 unacknowledged, 6 acknowledged awaiting delivery, 38 in history | `recorded_checks`, `recorded_checks_history` |
| Automatic evidence copies | 789 directories, 59 GB; 773 have no ledger row for their `original` root, 16 do | `evidence/attempt-temp/*/manifest.json` against the ledger |
| Recorded-check evidence copies | 67 lane directories, 9.3 GB | `du` |
| Read-only breakdown after manual pass 11 (00:19Z–00:21Z) | 120 scratch roots of completed or closed lanes, 161.5 GB: 68 recorded-check holds (98.3 GB), 47 evidence links (49.7 GB), 5 keep markers (13.5 GB). By lane close time: under 2 days 12 roots (7.0 GB), 2–7 days 31 (37.9 GB), 7–30 days 77 (116.6 GB). Seven quarantine directories (11.5 GB), each traced to a completed or closed lane | breakdown report kept outside the repository |
| Free space | 196.9 GB free, 89% used, at 01:09Z (after pass 11, with the operator-approved pass 12 running) | `df -B1 /` |

## 3. Earlier work this builds on

| Source | What it did | What it left |
|---|---|---|
| `docs/design/bounded-cleanup.md` (#2889, #2886) | Rename-then-remove with a journal, the 24 h quiet floor, `.delegatus-keep` as the operator's pin (§4.1) | No age limit for any hold |
| `docs/design/disk-retention-fix.md`, PR #3473 (merged 2026-11-04) | Fixed four sweep defects; adoption of unregistered roots; `preserveAttemptEvidence` before every retirement; durable `$LLV_EVIDENCE_DIR`; four-day backup-then-remove for finished worktrees; the disk-pressure card (§5 D) | Deferred any age limit on evidence (§8); added the copies that now hold 59 GB |
| `docs/design/recorded-check-handoff.md` (#3558, #3575, #3772) | Recorded checks hold their roots until an explicit acknowledgement (line 9); lock order host lock → attempt-sweep lease → short state transaction (line 86) | No path for a hold whose consumer never returns |
| PR #3792 (merged 2026-11-09) | Shared checkout inventory across a pass, fair paging under the cap, final fences at dispatch, the empty-root fence that admits the sweep's own changes (`evidence/attempt-temp-retention/README.md`) | Holds unchanged |
| PR #3835 (merged 2026-11-11 00:51Z) | Discovery signature without ancestor timestamps, so settled roots stop failing the final fence; the hourly temp sweep no longer walks ledger-owned roots | Holds unchanged |
| Eleven manual cleanup passes, 2026-10-29 to 2026-11-11 (the disk task's record) | Each removed finished-lane roots by registry key; pass 10 kept 68 evidence holds, 5 linked evidence, 3 keep markers, 4 Git markers; pass 11 removed 169 roots (114 GB) and kept the 120 held roots above | The same classes return after each pass because nothing expires them |

Searches for an earlier retention period (`search_transcripts`, project scope,
"recorded check evidence hold … expire retention period" and "held scratch
roots … cleaner pass"; `search_memory` "scratch retention evidence copies keep
marker cleanup") found the cleanup passes and no earlier design of an expiry.
`disk-retention-fix.md` §8 deferred "a size cap or age limit on the evidence
folder" until the operator could be asked with numbers; this is that answer.

## 4. The rule, made exact

### 4.1 The period

`FINISHED_LANE_RETENTION_DAYS = 7`, one constant in a new
`src/lib/pipelines/laneFinish.ts`. The sweep options carry it as
`retentionMs` (tests inject it); production passes the constant. The effective
value is written into `attempt-temp-report.json` as `retention.periodDays` and
appears in the disk-pressure card text (§8), which is where an administrator
reads it. No setting, no UI.

### 4.2 Finished, and when the clock starts

`laneFinish(pipeline, retentionMs)` in `laneFinish.ts` answers
`{ finished: false }` or `{ finished: true, finishedAt, expiresAt }`.

A lane is **finished** only when all hold:

1. `state` is `completed` or `closed` and `closedAt` is set. Any other state,
   including a state added later, is open (fail closed, like
   `SETTLED_STATES`, `worktreeSweep.ts:310`).
2. `pipelineActivitySettled(pipeline)` (`pipelines/types.ts:1181-1189`): close
   teardown settled with no host still running or unconfirmed, no pending
   activation close, no delivery in flight.
3. No `unconfirmedHosts`.
4. No attempt with `activation`, `unresolvedTermination`, or a state among
   `spawning`, `running`, `reviewing`, `committing`.
5. No `merge` in `PIPELINE_MERGE_LIVE_STATES` (`types.ts:1377`) or `refreshing`.
6. Every attempt has a nonempty, parseable `completedAt`; every release has
   a parseable `at`; close and merge clocks are also valid. An unknown clock
   preserves the hold, root and automatic copy until it can be proved.

`finishedAt` is the latest of `closedAt`, every attempt's `completedAt`, every
delivery `release` journal time, and `merge.updatedAt` when a merge record
exists. This is `latestTerminalTime` (`worktreeSweep.ts:317-324`) plus the merge
time; `latestTerminalTime` moves into `laneFinish.ts` and the worktree sweep
imports it from there (a two-line change, no behaviour change). `expiresAt =
finishedAt + retentionMs`.

Reopening and resuming: a completed or closed lane routes nothing again
(`engine.ts:15085-15092`), `resume` requires `paused` (`engine.ts:17625`), and
no code clears `closedAt`. The one later activity on a completed lane is a
merge retry (`engine.ts:18575-18625`): it makes the merge live (not finished),
and its settlement moves `merge.updatedAt` (the clock restarts). Because the
rule is evaluated from the record at every visit and again at dispatch, any
future reopen path is covered without listing it: the lane stops being finished
the moment its state, attempts or merge say so. A durable retirement claim
also fences all pipeline writers throughout asynchronous expired-data
removal (§7), closing the interval after the last revision check.

"Merged" therefore starts the clock only through `merge.updatedAt` of a
completed lane; a merge is never a reason to start it earlier.

### 4.3 What expires on day 7, and what never does

When `now ≥ expiresAt` the lane is **expired**, and for its roots and copies:

| Hold | Before expiry | After expiry |
|---|---|---|
| Recorded-check hold (`recorded_check_roots.held=1`) | Holds | Settled by a system acknowledgement (§5.3); stops protecting |
| Evidence link inside the root (symlinked `.artifacts` or media) | Holds (reported once, §7) | Stops protecting; the link is removed with the root, its target is never followed or touched |
| Automatic evidence copy of the root | Made before retirement | Not made (it would expire at once); existing copies of the lane go (§5.4) |
| Keep marker | Holds | **Holds.** Its author cannot be proven: agents and people share the UID, and the marker was designed as the operator's pin. Treated as a person's |
| Git link to an outside repository | Holds | **Holds**: outside commits and worktree registrations are never touched |
| Live process, socket, container mount, or a checkout link from a live process's checkout | Holds | **Holds**: a running consumer |
| Lane not finished (§4.2) | Holds | not applicable |

The ignored-evidence pin of the specification has two forms today. On a
worktree it already ends four days after the lane finished, behind a backup ref
and an evidence copy (`worktreeSweep.ts:1078-1079`, `:1318-1364`, #3473); this
design leaves that rule alone. In a temp tree it is the legacy temp sweep's
`.artifacts`/media hold (`tempSweep.ts:383` at `ec82e477`), which applies only
to roots outside the attempt ledger; the stage roots this design covers are in
the ledger (registered or adopted), where evidence is copied rather than
pinned, and the only remaining pin is the evidence link above.

Never touched by this mechanism, by construction: anything not registered in
the attempt ledger or the new `copies` table; `statePath("evidence",<pipelineId>)`
(`$LLV_EVIDENCE_DIR`, worktree backups); `statePath("evidence","recorded-checks")`;
`statePath("prototype-reviews")`; account stores and transcript roots; any
worktree, branch, ref or commit; the sweep reports and the cleanup passes'
ledgers (they live outside state). Prototype reviews and decision forms copy
their media into their own store when published (`prototypeReview/copy.ts:24`,
`prototypeReview/store.ts:17`) and their question links are server-built
GitHub actions (`prototypeReview/types.ts:27`), so a waiting form or review
never reads a scratch root or an attempt copy; a test pins that (§9, T13).

## 5. The mechanism: an expiry inside the existing attempt tick

No new process, timer or sweep. Five changes.

### 5.1 Authority knows the finish (`attemptTempProduction.ts:14-49`)

`attemptTempAuthority(owner, inventory, now, retentionMs)` keeps every current
branch and changes only the completed/closed branch at `:20`: it calls
`laneFinish`; a finished lane answers `"expired"` when `now ≥ expiresAt`,
otherwise `"closed"` with `expiresAt`; a completed or closed lane that is not
finished answers `"live"`. This also protects unheld roots while a launch,
teardown or merge remains unresolved. `AttemptTempState` gains `"expired"`;
`AttemptTempAuthority` gains `expiresAt`. `isCurrent()` additionally requires
`now() ≥ expiresAt` for `"expired"`, so a clock moved backwards between the
read and dispatch refuses.

### 5.2 The sweep treats expiry as the end of the expiring holds (`attemptTempRetention.ts`)

- At `:221` (and the rechecks at `:229`, `:264`, `:290`, `:303`): when
  `recordedRootHeld` is true, read authority once. `"expired"` → settle the
  hold (§5.3) and continue the visit; anything else → keep as today, and when
  authority answered `"closed"` with an `expiresAt`, `defer(directory,
  expiresAt)` and record `root_retention(directory, expiresAt)` (§5.5) so the
  row is not re-read every page cycle and the card can count it.
- Before settling a hold, persist its expiry prerequisite separately in
  `root_expiry_admission`. Keep checking it after acknowledgement, at dispatch
  and after restart; a rollback to `"closed"` cannot authorize immediate
  retirement of a previously held root (§15).
- In `eligible()` (`:261-326`): `"expired"` counts as settled at `:272`; for
  `"expired"`, `preserveAttemptEvidence` is skipped and the evidence fence is
  an independent directory snapshot, so symlinked or irregular evidence no
  longer throws. Directory identity, mode, mtime and ctime are checked
  synchronously after the last await and at dispatch. A nested keep marker
  added during reference or authority observations invalidates that snapshot.
  The ordinary marker inspector still protects markers already present.
  In every other state that copies evidence, the copy is registered first with
  the `expiresAt` the authority answered, or none (§5.4).
- The absent-root path (`:207-212`, `:363-366`) runs after the hold
  settlement, so a held row whose root a manual pass removed is settled and
  forgotten in the same visit, and a held quarantine is replayed by the
  existing journal path.
- Under pressure, `"expired"` ranks with `"closed"` at `:193-195`, largest
  first.
- The outcome label for an absent row with no journal becomes `absent;
  forgotten` (today it reads `identity changed`, the default at `:202`).

### 5.3 Settling a recorded-check hold (`recordedChecks/store.ts`, `service.ts`)

`expireRecordedRootHolds(directory, pipelineId)`, called only by the sweep and
only for an `"expired"` lane:

1. Read `recorded_check_roots` rows for `directory` with `held=1`. For each run
   id, read its row; skip rows already acknowledged.
2. Refuse (record a failure, keep the root) unless the row's
   `binding.pipeline` equals the root owner's `pipelineId`. Handoff already
   requires that (`service.ts:93-99`); the check only guards corrupt rows.
3. Write the row with `acknowledgement = { actor: "retention", disposition:
   "expired-with-lane", resultRevision, resultDigest, evidenceDigest, at }`
   through the existing `store.write` CAS (`store.ts:254-256`), taking the
   current result's revision and digests, or `0` and empty digests when no
   result exists. The existing `put` then moves it to history, clears `held`
   for its roots, and drops the active row and its event row unless a
   notification is still being delivered (`store.ts:232-249`); `wakeRecordedChecks()`
   lets the observer release it (`observer.ts:217-227`).
4. `rowSchema.acknowledgement.disposition` (`store.ts:39-40`) accepts the new
   value; the MCP input schema (`recordedChecks/input.ts:8`) does not, so no
   agent can use it.

`retirement()` (`store.ts:316-331`) then accepts the root as acknowledged and
the existing `admitted` and `completed` records follow. The write goes through
the same store opening and writer authority that `recordRootRetirement`
(`store.ts:353-358`) already uses from the sweep helper. One short state
transaction per run; no I/O inside it. The settlement runs inside the
attempt-sweep admission, which is also what serializes an agent's own
acknowledgement (`service.ts:425`), so a hold cannot be acknowledged twice.
Handoff to a finished lane is impossible (`callingAttempt` refuses a lane
that is not running or parked, or has `closedAt`, `service.ts:34-35`), so no
new hold can appear after settlement; the
dispatch recheck of `recordedRootHeld` stays and would refuse one.

### 5.4 Automatic evidence copies get a lane and an end

New table `copies` in `attempt-temp.sqlite` (§5.5).

- **Registration.** Before `preserveAttemptEvidence` copies its first file,
  the sweep inserts `copies(destination, pipelineId, launchId, kind, createdAt,
  expiresAt, checkedAt)` for the root it is retiring, with `kind = "lane"`
  (owner has a pipeline) or `"agent"` (no pipeline), and `expiresAt` from §5.1
  (`null` while the lane is open or not yet finished; `createdAt + retentionMs`
  for `"agent"`), and `checkedAt` = `expiresAt` when known, otherwise now + 1 h.
  `manifest.json` also records `pipelineId` and `launchId`
  (`attemptTempEvidence.ts:116`), so a lost row can be rebuilt.
- **Expiry page.** After `sweepAttemptTemps` returns and outside its admission,
  `runAttemptTempSweep` calls `sweepEvidenceCopies` with its own 10 s budget:
  1. replay journals of copies being removed (a copy row whose directory is
     gone and whose journal exists) through `finishTreeTrash`;
  2. legacy adoption, while unfinished: up to 32 directory records after a persisted cursor
     in `statePath("evidence","attempt-temp")`, only names matching
     `^[0-9a-f]{64}$` that are real directories (no symlink) directly in that
     real directory. A name with no row is attributed from its manifest's
     `pipelineId` (new format) or from a ledger row for its `original`;
     otherwise it is registered as `kind = "unattributed"`, which is never
     removed and is counted in the report. `attemptCopyDiscovery.ts` reads
     at most 4 KiB of native directory records, without a whole-directory
     list or sort. The kernel position and unconsumed bounded tail survive
     restart; libc `telldir` tokens are deliberately avoided because they
     belong to one stream. The position is bound to the directory's device, inode and
     timestamps. A changed parent restarts one bounded page. The page commits
     its cookie after registration; interruption replays at most that page,
     and the destination primary key makes replay idempotent. Legacy lexical
     checkpoints restart safely. Unsupported native discovery retains legacy
     data with a reported error; registered rows still retire independently;
  3. up to 8 due rows (`checkedAt ≤ now`, not `unattributed`): read authority
     for the lane; `"expired"` (or an `"agent"` copy past `expiresAt`) →
     `removeTreeViaTrash` (`tempSweep.ts:410-446`) with a journal beside it,
     `disposable: true`, `held` checks markers and references,
     `validate` checks current expired authority, directory identity and the
     independent protection snapshot after the last await, including replay;
     then delete the row. Finished but not expired →
     `checkedAt = expiresAt`. Open → `checkedAt = now + 1 h`.

### 5.5 Schema and where it is installed

All in `attempt-temp.sqlite`, all `CREATE TABLE IF NOT EXISTS`, the same
precedent as the `adoption` table (`attemptTempRetention.ts:53`); no `ALTER` of
`roots`:

- `copies(destination TEXT PRIMARY KEY, pipelineId TEXT, launchId TEXT NOT NULL, kind TEXT NOT NULL, createdAt REAL NOT NULL, expiresAt REAL, checkedAt REAL NOT NULL DEFAULT 0, bytes REAL NOT NULL DEFAULT 0)`
- `root_retention(directory TEXT PRIMARY KEY, expiresAt REAL, failure TEXT)` —
  the expiry of a held root of a finished lane, and its last reported failure
- `copy_retention_failures(destination TEXT PRIMARY KEY, failure TEXT NOT NULL)`
- `copy_adoption(id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL, done INTEGER NOT NULL)`

Declared indexes through the existing `attemptTempIndexes` (`:26-28`):
`copies(checkedAt, destination)` and `root_retention(expiresAt)`. Index repair
needs the startup authority (`state/declaredIndexes.ts:14-25`), and the sweep
helper runs as `tool` (`worktreeSweepWorker.ts:49-53`). So the Viewer that
holds the release fence opens and closes `AttemptTempStore` once before it
arms the sweeps (`viewerInstrumentation.ts:537`, beside `startTempSweep`),
which installs the indexes under its authority. Rows are removed with what
they describe: `root_retention` when its root row is forgotten, `copies` when
its directory is gone. The ledger tables are additive. Recorded-check rows
also gain the `expired-with-lane` acknowledgement value: a rollback reader
must understand that value before it reads the new history or pending
notification rows. An older strict acknowledgement schema cannot do so.

## 6. The first run after upgrade

The backlog is drained by the same bounded page; there is no startup migration
step and no one-shot cleanup.

| Backlog at upgrade | What happens |
|---|---|
| Held roots of lanes finished more than 7 days ago (77 roots, 116.6 GB at the breakdown, fewer after the operator-approved pass 12) | Each visit settles the hold and retires the root under every existing fence. Pressure mode (over the cap, which the ledger is) takes 32 rows per tick under the 40 s budget, expired first and largest first. A full cycle of today's 1 400 rows is about 44 ticks. |
| Held roots of lanes finished under 7 days ago | Deferred to their own `expiresAt`, counted in the card |
| 26 held rows whose roots a manual pass already removed | Hold settled when the lane is expired, row forgotten in the same visit; until then they hold 0 bytes |
| 180 absent rows still counting 128.6 GB | Measured to 0 and forgotten on their next visit (existing path), now also when held and expired |
| Seven quarantine directories | Replayed by the existing journal path once their hold is settled |
| Keep-marker and outside-Git-link roots | Stay, reported with bytes |
| 789 automatic copies (59 GB) | Adopted 32 per tick (about 25 ticks). The 16 attributable ones follow their lane; the 773 unattributable ones are registered as `unattributed`, kept and counted. The operator already approved removing all existing copies by hand (pass 12); the mechanism does not repeat that judgement without a lane record |

## 7. Bounds, restarts, locks, failures

- **Per pass.** Roots: unchanged page (4, or 32 under pressure) and 40 s
  budget; expiry adds one authority read (already done per row) and at most a
  few short state transactions per expired held root. Copies: ≤ 32 adoption
  directory records, ≤ 8 removals, 10 s. Every query is a key or index seek.
  Copy discovery reads at most 32 records, including dot entries, per page;
  at most one native 4 KiB chunk is read and its tail is persisted. Its work
  and memory do not grow with the first backlog. Directory protection
  snapshots stream entries, stop at 10,000 directories or 30 s, and retain
  an unreadable or over-budget tree. Root legacy adoption retains its existing
  implementation; this change bounds automatic-copy discovery.
- **Restart.** Root progress is persisted before the first await
  (`attemptTempRetention.ts:204`); a settled hold is durable and idempotent
  (an acknowledged row is skipped); a quarantine is finished from its journal;
  a copy removal from its journal; adoption from its cursor. A helper killed at
  any point loses at most the current item's progress, never a fence.
- **Locks.** Removal runs inside the attempt-sweep admission
  (`attemptTempRetention.ts:145`), as today, and never while holding the
  state write lock (`waitForStateLock`), a collection lease or the registry
  write lock: the hold settlement and the retirement records are each one
  synchronous transaction that completes before removal starts. The copies
  page reacquires the existing attempt-sweep admission after the root page
  releases it, so overlapping serving generations cannot retire a copy
  concurrently. No new lock namespace is introduced. The lock order of
  `recorded-check-handoff.md` (line 86) is unchanged. All of it runs in the
  sweep helper, never on the Viewer's main thread.
- **Retry admission.** `claimAttemptRetirement` in `pipelines/store.ts`
  creates a durable lane claim under a short bounded pipeline transaction
  holding both active and archive collection leases in their existing order.
  Every pipeline writer checks it in the common validator, allowing an
  unchanged row and independent lanes while refusing changes to the claimed
  lane. The sweep's existing admission owns claims across root/copy awaits.
  No collection lease or registry lock is held during removal. The claim
  lists pending journal namespaces, so one failed path does not prevent
  independent paths in the same lane from retiring. Success releases its
  namespace; an interrupted journal retains the fence across process death.
  A later sweep reclaims it under the same admission and replays the journal.
  If protection refuses replay, the sweep restores the proved tree and
  cancels the journal before releasing the claim (§15). A restored root stays
  registered; absent-root reconciliation cannot forget its ledger row.
  A claim left before journal creation is safely reacquired on the next visit.
  Claims also record the helper's boot-aware process identity. If it dies
  after forgetting its ledger row, a pipeline mutation can release a claim
  with no pending journal after proving that owner dead; a live or unknown
  owner continues to fence admission.
- **Re-proved before removal.** Roots: the existing dispatch fences
  (`attemptTempRetention.ts:284-325`, `:227-235`) now include `"expired"` in
  the authority revision and the time check of §5.1. Copies: the `validate`
  callback re-reads authority and identity after the rename.
  Both paths also validate their independent directory snapshots. Expired
  paths skip evidence preservation, so validation cannot recreate old copies.
- **One failure stops nothing.** Each root and copy is in its own `try`, as
  today (`:367-376`). The failure text is stored in `root_retention.failure` or
  `copy_retention_failures`; the log line is written only when the text
  changes, and the stored text is cleared on success, so a path that fails on
  every visit is logged once.

## 8. The disk-pressure card

An existing surface already carries this text: the card's first category,
built at `diskPressure.ts:368`, reads the attempt report's live-held and
over-cap bytes ("Тимчасові дані агентів (утримує активність, перевірена
частина: …; понад ліміт: …)"), a count nobody acts on. Its parenthetical
changes to what retention frees and when, from new report fields
`retention: { periodDays, dueBytes, upcomingBytes, until }`: roots joined with
`root_retention` through its `expiresAt` index, plus `copies` through the
`checkedAt` index (a finished lane's copy waits with `checkedAt = expiresAt`).
The number of days comes from `periodDays`:

`Тимчасові дані агентів (лінії, завершені понад 7 днів тому, звільнять X найближчими проходами; ще Y — до <YYYY-MM-DD>)`

Bytes use the existing `formatDiskBytes`. The seat's wake label
(`diskPressure.ts:185-191`) carries consumer totals, not this count, and stays
as it is. No other surface changes.

## 9. Acceptance tests

Every test runs by path through `scripts/gate-slot.sh` with private `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`, `LLV_VIEWER_CONTROL_URL` on a
closed port, roots under the test's own temp directory, an injected clock and
`retentionMs`. Lane records are written with the production pipeline store in
the sandbox (the precedent in `attemptTempProduction.test.ts`); recorded-check
rows through the real `RecordedCheckStore` (the precedent in
`recordedChecks/lifecycle.integration.test.ts`).

| # | Case | Expected | File |
|---|---|---|---|
| T1 | Root with a recorded hold, lane finished 7 d + 1 s ago | Removed; run in history with `disposition: "expired-with-lane"`; root row `held=0` with a completed retirement; ledger row forgotten | `attemptTempProduction.test.ts` |
| T2 | Same, finished 6 d ago | Stays held; row unchanged; `checkedAt` = `expiresAt` | same |
| T3 | Unheld root of a lane finished 1 h ago | Removed at once (unchanged behaviour); its copy has `expiresAt` = finish + 7 d | same |
| T4 | Root with a symlinked `.artifacts` pointing outside, finished 7 d + 1 s / 6 d | Removed, link target intact / kept, one log line across three ticks | `attemptTempRetention.test.ts` |
| T5 | Keep marker, outside Git link, live process cwd, checkout link from a live process's checkout, at 30 d | Each stays | same |
| T6 | Open lane (running, paused, needs_decision), completed with teardown pending, with a queued merge, with a running attempt or an unconfirmed host; each with a 30-day-old hold | Each stays | `attemptTempProduction.test.ts` |
| T7 | Clock: later attempt, release and merge clocks; absent or invalid terminal clocks | Clock from the latest valid proof; unknown clocks and live merges keep data | `src/lib/pipelines/laneFinish.test.ts`, `src/lib/runtime/attemptTempProduction.test.ts` |
| T8 | Absent root with a hold (manual pass removed it), lane expired | Hold settled and row forgotten in one visit, nothing removed | `attemptTempRetention.test.ts` |
| T9 | Held quarantine (trash plus journal), lane expired | Trash removed, journal gone, row forgotten | same |
| T10 | Copies: lane expired / finished 6 d / open / `agent` copy at 7 d + 1 s / legacy without attribution | Removed / kept / kept / removed / kept and counted | same |
| T11 | Restart: a fresh store and sweep after (a) hold settled before removal, (b) rename to trash, (c) copy renamed, (d) adoption cursor mid-directory | Each finishes on the next pass; nothing removed twice; no row lost | same |
| T12 | 40 expired held roots and 20 expired copies, budgets 4/32 and 8 | Each pass removes at most its budget; all gone after enough passes; selection order survives a restart | same |
| T13 | A prototype review published from a frame inside a root, then the lane expires | The root goes; the review still serves its stored frame | `prototypeReview` store test with the real sweep |
| T14 | Never touched: files under `evidence/<pipelineId>/`, `evidence/recorded-checks/`, `prototype-reviews/`, and a ledger file beside the state directory, all for an expired lane | All remain | `attemptTempRetention.test.ts` |
| T15 | Removal port called after settlement | Inside it, the recorded-check state lock is acquirable at once (no lock held) | same, with an injected `remove` port |
| T16 | Card | Category names due and upcoming bytes and the date; no live-held or over-cap text | `src/lib/state/diskPressure.test.ts` |
| T17 | MCP acknowledgement with `expired-with-lane` | Refused by the input schema | `recordedChecks` input test |

## 10. Options considered

| Option | Verdict |
|---|---|
| Expiry inside the existing attempt tick: authority learns the finish, expiring holds end, copies get a ledger row | **Chosen.** Reuses every fence, budget and journal already proved by #3473, #3792 and #3835 |
| Keep every finished-lane root for 7 days, held or not | Rejected: keeps data that today goes at once; works against the disk target |
| A separate retention service or timer | Rejected: a second owner of the same roots would duplicate the authority, reference and dispatch fences |
| Acknowledge recorded checks automatically when the stage settles | Rejected: removes the adoption window the hold exists for; the operator chose a period |
| Remove `evidence/attempt-temp/*` by directory age | Rejected: age alone cannot prove the lane finished (`disk-retention-fix.md` §0 forbids deletion by age alone) |
| Copy the root's evidence before an expiry removal | Rejected: the copy would itself be expired |
| Treat agent-written keep markers as expiring | Rejected: the author cannot be proven (§12) |
| Apply 7 days to worktrees too | Rejected: they already go after four days behind a backup ref (#3473) |

## 11. Open work on the same files

- Lane 6d26bde0 (Viewer stalls) has published its diagnosis in
  `docs/design/viewer-stalls-root-cause.md` on its branch. Its proposed fixes
  concern `migration.stop`, MCP lock waits, curator applies and main-thread
  slices. The report and overlapping diffs were reread for this fix. Retirement
  uses only short pipeline admissions; content removal holds no state lease
  or registry write lock.
- PRs #3710, #3802, #3801 (launch recovery) change `engine.ts`, `store.ts`,
  `types.ts`, and #3802 `structuredSpawn.ts` (other functions). This design
  keeps their lifecycle transitions in place. The fix adds the common
  pipeline-write validator fence and a bounded claim admission in `store.ts`;
  additive imports are the shared integration point.
- #3835 is on main; the builder starts from a base that contains it.

## 12. Could not confirm, and where I looked

- **Who wrote each keep marker.** All five live markers carry the Delegatus
  UID; three of their texts read like agent notes. No record names the
  author. Looked at the breakdown and `markerHolds`.
- **Links outside Delegatus's code into `evidence/attempt-temp`** (a bridge
  report or task text naming a copied screenshot). Such a link breaks after
  the period. Only code readers were searched (`evidenceRoots`,
  `localFile.ts:42-44`, prototype review input); message texts were not.
- **Who created the 47 symlinked evidence entries**, and whether any target
  is unique. The removal never follows a link, so a target survives; the
  breakdown could not name the writer.
- **Whether #3835 is deployed.** Deployment status was not read; it decides
  how fast unheld finished roots go today, not this design.
- **Why 154 absent unheld ledger rows were not yet forgotten.** Most likely
  not yet revisited after pass 11 removed their roots less than an hour
  earlier; not proved.
- **That `merge.updatedAt` moves only on merge activity.** Read from
  `retryMerge` and the auto-merge writers; not traced through every writer.
- **Lane attribution of the 773 legacy copies.** Their roots' ledger rows are
  gone; no other durable record maps a scratch path to a launch (searched
  `scratchDirectory` writers).

## 13. Deferred — not currently justified

- Recorded-check evidence copies (`evidence/recorded-checks/<pipeline>/<run>`,
  9.3 GB live). Attributable by path, and `copies` could take them; the
  specification's "automatic copies" are the attempt copies (62 GB), and their
  history rows index those files.
- Keep markers written by agents. Needs an authored pin (who wrote it, why,
  until when) before any marker may expire.
- Scratch roots holding a linked checkout of an outside repository: a
  backup-ref-then-remove like `worktreeBackup.ts`. Four roots at pass 10.
- The 773 unattributed legacy copies: kept and counted; the operator-approved
  manual pass covers them.
- Worktree sweep progress (in its last pass it visited one candidate with 268
  pending) and a due time for `ignored-files` rows of lanes not yet four days
  finished (`keep()` drops their due time, `worktreeSweep.ts:1051-1058`). That
  is the sweep's throughput, the area of lane 6d26bde0 and #3835.
- A byte budget per pass, beyond the root count and time budget.
- A setting to change the period. One constant reported in the card and the
  report answers "readable"; nobody asked to change it.
- `$LLV_EVIDENCE_DIR` folders, `/tmp` and `/var/tmp` roots, host-event
  stores, account stores: outside "scratch roots and automatic copies".

## 14. Validation against the requirement

The requirement is that a finished lane's scratch and automatic evidence
copies go seven days after it finished, without a manual pass. Every hold that
today keeps such data for ever either ends at day 7 (recorded-check hold,
evidence link, the copies themselves) or is one the specification protects
(open lanes, keep markers, outside Git, live consumers). The clock and the
"finished" predicate are stated (§4.2) and tested (T6, T7). Rows that point at
removed roots are settled in the same visit (T1, T8, T9). The work is bounded
and resumable (T11, T12), removal holds no state or registry lock (T15), each
path is re-proved at dispatch, and one failing path neither stops the others
nor repeats in the log (T4). The card names what retention will free and when
on the one surface that already carried the count (T16). Nothing outside the
ledger and the new `copies` table can be removed (T14).

## 15. Implementation and verification

The period is `FINISHED_LANE_RETENTION_DAYS` in
`src/lib/pipelines/laneFinish.ts`. The root sweep and
`src/lib/runtime/attemptEvidenceCopies.ts` use the same period. The Viewer
installs the new ledger indexes before starting its sweep timers; the tool
helper requires those indexes to be present.

The copy producer is `preserveAttemptEvidence` in
`src/lib/runtime/attemptTempEvidence.ts`, called on each root-retirement
eligibility check. If preservation succeeds but a later reference or removal
check refuses retirement, a later attempt copies the same source again.
Removing only the destination can therefore create a new directory generation
on the next retry. Expired lanes skip preservation, including during quarantine
replay and permission-denied cleanup, so the retention consumer cannot fight
this producer. A regression test removes a test-owned copy namespace, observes
its recreation through the real producer before expiry, then verifies three
expired retries never recreate it. No other production writer of these copies
exists in this tree.

Missing-root reconciliation uses real persisted recorded-check rows: expiry
acknowledges their holds through the ordinary CAS writer even when the source
directory is absent, then forgets the root ledger row. A cleanup observation
alone never substitutes for the lane-finish and binding checks.

Before expiry acknowledgement can release a recorded-check hold, the attempt
ledger persists the root's expiry prerequisite in `root_expiry_admission`.
This prerequisite belongs to the registered root until it is forgotten;
reporting updates cannot clear it. Eligibility, final dispatch and removal
require both expired lane authority and the recorded cutoff. A clock rollback
after acknowledgement therefore retains the root, including across a helper
restart; ordinary immediate retirement of unheld roots cannot bypass it.

A refused quarantine replay has a cancellation path. Once the serialized
sweep has returned without a removal or an uncertain removal error,
`restoreRefusedAttemptTrash` proves the journal's original path, same-parent
trash name, disposable intent, owner and directory identity. It renames the
surviving tree back, cancels the journal and then releases the retirement
claim. This also applies to automatic copies and a dead helper's recovered
claim. Keep markers and payloads survive while merge retry and reopening can
proceed. An occupied original or changed trash identity refuses cancellation
and retains the recovery fence. A restart between restoration and journal
cancellation recognizes the restored identity and completes cancellation.

Regression cases in `attemptTempProduction.test.ts` move the clock backwards
after acknowledgement, at quarantine rename and before removal, then start a
new process before expiry and finally retire after expiry. Root and copy cases
recover a dead owner's protected quarantine, repeat three passes and exercise
the supported merge retry (`blocked` to `queued`) and reopening transitions.

Run the explicit test files with isolated state through `scripts/gate-slot.sh`:
`laneFinish.test.ts`, `attemptTempProduction.test.ts`,
`attemptTempRetention.test.ts`, `attemptTempFilesystem.test.ts`,
`prototypeReview/fences.test.ts`, `recordedChecks/wire.test.ts`,
`state/diskPressure.test.ts`, `viewerInstrumentation.test.ts` and
`pipelines/worktreeSweep.test.ts`, each under its source directory. Add
`runtime/attemptCopyDiscovery.test.ts` for 65/513-directory restart pages,
late marker tests at root/copy reference and authority boundaries, and live,
dead and journaled claim recovery in the retention and production files.
Run the typecheck and privacy publication gate. Hosted checks, including
`bun-runtime`, run on the published commit.

After deployment, read successive `attempt-temp-report.json` files. Check
`retention.periodDays`, due/upcoming bytes and the copies page's counts; verify
that expired missing-root holds have `expired-with-lane` acknowledgements, and
that the bounded pages reduce the attributable backlog. Check repeated root
retries do not recreate expired copies. Unattributed legacy copies remain
counted and retained. Read the protected-path outcomes before attributing a
remaining root to a retention defect. No manual cleanup or deployment is part
of this implementation stage.
