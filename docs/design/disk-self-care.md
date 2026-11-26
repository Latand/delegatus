# Disk self-care: every machine keeps its own disks clean

Design, 2026-11-25, lane 57c312e6. It builds on PR #4471 (lane 2dd4fda0), the
Cleaner pressure pass merged as #4401, and the designs
[attempt-temp-pressure.md](attempt-temp-pressure.md),
[cleaner-agent.md](cleaner-agent.md),
[closed-lane-scratch-retention.md](closed-lane-scratch-retention.md) and
[worktree-sweep-slices.md](worktree-sweep-slices.md). Line references are to
`main` at `1b63d879a` unless a revision is named.

## 0. Originating requirement

**Operator, 2026-11-25, about 21:57 Kyiv time, relayed to the project seat by the
operator's terminal session (private conversation; paraphrased here). Pinned
task of lane 57c312e6; the scratch fix it follows is task c241c777 / PR #4471.**

That day the workstation's home filesystem reached 99 % (about 14 GB free) and
the work install was losing about 60 GB an hour. The terminal session cleaned up
by hand: it deleted 921 stage scratch directories older than a day that no live
process referenced (home went from 14 to 91 GB free), and a Cleaner agent
removed 29 worktrees of closed lanes after backing them up. The attempt-temp
pressure pass had reported zero removed roots while pressure and low-space mode
were on, with 84 GB recorded and nothing reclaimed. The operator asked that
Delegatus be able to do this itself, without a person, on every machine it runs
on:

1. **Stage scratch** (`$STATE/scratch/llv-stage-*`): delete the directories of
   ended attempts that no live process references (cwd or open file), in the
   ordinary pass as well as under pressure. PR #4471 is the start of this and
   has open review findings.
2. **Attempt-temp cache**: the pressure pass must actually delete expired roots.
3. **Worktrees of closed or merged lanes**: remove them automatically after a
   backup (a binary patch of dirty changes, a tar of untracked files, a bundle
   of any branch whose HEAD is on no remote), written to another disk when one
   exists. Skip and report a worktree with an `index.lock`, a locked
   registration, nested checkouts or an unfinished merge.
4. **Monitoring**: free space per machine (this workstation's home and root
   filesystems, the work install's root, the stage server's root) in the
   System panel and in the seat tick. Below 50 GB free, or when a volume loses
   more than 10 GB in 20 minutes: warn the operator, run parts 1–3 at once, and
   pause new lane admission until the volume recovers.
5. **Journal** every deletion (what, how many bytes, why) and put a summary in
   the seat's report.

Priority: right after #4471. The same day the System panel showed
"worktrees 143 GB" while `du` over the 54 Delegatus worktrees showed about
18 GB. The requirement says the measurement must count shared and hardlinked
bytes once.

Units: GB in this document is 10⁹ bytes, as in the requirement and in
`LLV_CLEANER_FREE_GB`. The panel prints binary GiB (`formatDiskBytes`,
`src/lib/state/diskPressure.ts:185`).

## 1. Earlier answers this design builds on

Searched: the design folder, the open pull requests touching the same files,
lane 2dd4fda0 and its task, the verifier and Cleaner conversations linked to
that task, the transcript index (project and unscoped) and memory. Memory held
nothing on this subject. Nothing earlier explains the hold described in §2.1.

| Source | What it settles here |
|---|---|
| [attempt-temp-pressure.md](attempt-temp-pressure.md) | The scratch ledger, its fences, the pass and report fields. Every fence there stays. |
| [closed-lane-scratch-retention.md](closed-lane-scratch-retention.md) | Scratch becomes due strictly 24 hours after confirmed completion, including under pressure; the effective cap; pressure goes through the Cleaner lease. |
| [cleaner-agent.md](cleaner-agent.md) §"Automatic pressure pass" (#4401) | The Cleaner pass: started by the disk watch, one lease, a 15-minute cooldown, a durable journal under `$STATE/disk-cleaner`, a seat card and a seat wake item. This design extends that pass; it adds no second pressure owner. |
| [worktree-sweep-slices.md](worktree-sweep-slices.md) and `src/lib/pipelines/worktreeSweep.ts:50-140` | The worktree retirement proof and the guards before `git worktree remove`. Part 3 reuses all of them. |
| PR #4471, lane 2dd4fda0, verifier result on `4dfa8f5d` (2026-11-25 19:26Z) | §3. |
| Cleaner run on the workstation, 2026-11-25 19:34–19:40Z | The manual worktree procedure that part 3 automates; its four skipped cases are the skip list of part 3. |
| PR #4475 (open) | Extends the temp sweep to agents' private `/tmp` and `/var/tmp` trees. It touches `tempSweep.ts` and `worktreeSweep.ts`; §6 lists the overlap. |
| [linked-installs.md](linked-installs.md), `src/lib/links/client.ts:223`, `src/app/api/peer/v1/[...path]/route.ts:48-100` | The `boards/sync` exchange already carries optional parts (`sm`, `tp`) that an older peer ignores. §4.7 adds one more part. |

## 2. What happened on the workstation on 2026-11-25

All observations below are read-only: the serving container's log, copies of
`attempt-temp.sqlite` and the JSON reports read into this stage's own directory,
`/proc`, `df` and one `du` run. Times are UTC unless marked.

### 2.1 Why the pressure pass removed 0 roots

The report line *"Pressure pass at 267 of 1912 roots after 7 ticks and 29.9
min; removed 0 roots"* comes from the release that served traffic,
`8bb58bd7` (committed 2026-11-25 08:35 +02:00). That release predates #4401
(merged at 16:16 +02:00 the same day). In it the minute worker ran pressure
passes itself: `pressure = !!options.selection || lowSpace || store.bytes() >
capBytes` (`8bb58bd7:src/lib/runtime/attemptTempRetention.ts:680`). On `main`
the minute worker is `scheduledOnly` and never enters that branch
(`attemptTempRetention.ts:687`, `attemptTempProduction.ts:201`); the Cleaner owns
pressure.

That pass's inventory held the 1,912 expired roots
(`pressurePass`, `attemptTempRetention.ts:351-366`). The ledger's
`pressure_pass_last` row records its end: 7 ticks, 274 visits, 0 removed,
ended `pressure-cleared` at 19:39:53Z, which is when the manual deletion
freed space. The full pass before it (15:08–18:48Z) made 1,970 visits over 44
ticks and also removed nothing. Every tick line in the container log for those
passes reads the same way: *removed 0 directories … 22 / 22 / 33 / 46 / 42 held
for the operator … 0 errors*, with a few large roots *held by evidence*.

Only two paths hold a root for the operator:

- blocked subtrees (`attemptTempRetention.ts:781`), which are recorded in
  `root_blocked`. That table was empty, and the report said *0 roots in the
  ledger … hold directories this user cannot remove*;
- `checkout_unreadable` (`attemptTempRetention.ts:1018-1028`). The report written
  at 19:50:33Z lists 27 of 27 operator holds with *consumer checkout became
  unreadable during retirement: … ENOENT … stat '/proc/2090089/fdinfo'*.

The chain that produces it:

1. `scanProcesses` records each process's cwd first, then its open files, `exe`
   and `root` (`src/lib/tempSweep.ts:136-191`).
2. `attemptReferenceHold` collects every absolute cwd
   (`src/lib/runtime/attemptTempFilesystem.ts:545-551`) and asks
   `RepositoryLinkInventory.repositoryOf` for the checkout enclosing it (`:557`).
3. `discoverRepository` calls `fs.statSync(cwd)` (`:376`).
4. A sandboxed Chromium process (browser renderers, Electron apps) chroots
   into `/proc/<helper pid>/fdinfo` of a helper that exits right afterwards. Its
   cwd and root then name a directory that no longer exists, and the stat fails
   with ENOENT.
5. `repositoryOf` excuses a vanished cwd only when every process holding it
   has exited (`:419`, `allExited` at `:59-60`). The renderer is alive, so the
   error propagates.
6. `observeReferences` turns ENOENT, EACCES or EPERM into disposition
   `operator`, code `checkout_unreadable` (`attemptTempRetention.ts:1018-1028`).
   The root then waits `EXPIRED_HOLD_RETRY_MS`, 30 minutes
   (`attemptTempRetention.ts:77`, applied at `:1349`).

At about 20:00Z, 30 live processes of this user had such a cwd: 18 Edge, 8 Chrome
and 3 belonging to an Electron app. Every visit takes a fresh scan, so every
visit of every root fails while any Chromium-family program runs. The ordinary
minute tick fails the same way (the 19:50Z tick above was an ordinary one). The
Cleaner path on `main` does too, because `runCleanerSweep` falls back to the
same `attemptReferencesClear` (`src/lib/cleaner/diskSweep.ts:110-113`). On a
desktop machine this one condition explains zero removals across more than 2,200
visits. The remaining holds (*held by evidence*, 16.1 and 16.9 GB in single
ticks) are linked report evidence within its seven days, which this design does
not change.

### 2.2 Why the ledger still reports 84 GB

`attempt-temp-report.json` `bytes` is the whole ledger: 1,333 rows under
`$STATE/scratch` (74.3 GB recorded) and 2,113 config roots under
`$HOME/.cache/delegatus/attempt-temp` (9.98 GB recorded). The cache directory
itself holds only the config roots.

After the manual deletion only 325 of the 1,333 scratch rows still exist on
disk. 1,013 rows, 62.3 GB, name directories that are gone. `main`'s allocation
refresh skips a missing path (`attemptTempProduction.ts:211-212`, `continue`), so
those bytes never leave the total, keep the effective cap exceeded, and fill the
pressure inventory. #4471 records 0 bytes for a missing path that has no
quarantine journal, which drains them (§3). 2,217 rows (83.6 GB recorded) were
past their deadline at about 20:00Z.

### 2.3 Why the panel showed 143 GB of worktrees while `du` showed about 18 GB

The panel's figure is the `worktrees` consumer in `disk-pressure-report.json`:
153,661,501,440 bytes measured at 18:52:36Z, which is 143.1 GiB.

- **What it measures.** Every pipeline's `worktreeDir` plus every path the
  worktree sweep keeps (`diskPressure.ts:303-305`). The sweep keeps every linked
  checkout of the 23 repositories it knows, including 355 rows
  `not-created-by-delegatus`. That was 393 existing directories, 384 after
  nested ones were folded.
- **How it measures.** An unbounded walk of allocated blocks
  (`worktreeSweep.ts:535-537`). One identity set shared across the whole
  measurement (`diskPressure.ts:329`) counts each hardlinked inode once
  (`worktreeSweep.ts:576-580`).
- **Check.** A single `du -s --block-size=1` over the same 384 directories
  (GNU `du` also counts a hardlinked inode once per run) finished at 20:21Z
  with 145.5 GB. The cleaner removed 8.07 GB of lane worktrees between the two
  readings (19:34–19:40Z), and 153.66 − 8.07 = 145.6 GB. The panel's number is
  real allocation, each inode counted once, over a much wider set of
  directories than the operator's `du` covered.

| Group of the 384 directories (`du`, 20:21Z) | Count | GB |
|---|---:|---:|
| Checkouts under `$HOME/Projects` (other projects, mostly not created by Delegatus) | 135 | 82.0 |
| Other checkouts under `$HOME/.agents/tools` | 175 | 40.9 |
| Elsewhere under `$HOME` | 33 | 9.4 |
| Delegatus lane worktrees still present | 13 | 7.6 |
| Codex worktrees | 11 | 4.6 |
| Checkouts under `/var/tmp` | 17 | 1.0 |

Three further problems in the same panel matter for part 4:

- The label says "worktrees", yet about 90 % of the bytes are checkouts
  Delegatus did not create and never removes.
- The category *outside Delegatus accounting* subtracts from `used`, which sums
  used bytes over volume rows (`diskPressure.ts:376`). The home filesystem
  appears twice, as device 2049 and device 53, with identical total and free
  bytes, so that category read 2,721 GB on a 1.48 TB disk.
- The sweep's own kept bytes stop after 4,096 entries per tree
  (`worktreeSweep.ts:1827-1828`). The 12.5 GB they add up to is a lower bound.

Shared bytes: a file hardlinked from a package store into several checkouts
is counted once, against whichever tree the walk reached first. Removing that
tree frees nothing while another link remains. Counting once already holds
today; what is missing is the split between bytes a removal would free and
bytes it shares.

### 2.4 Why closed lanes kept their worktrees

Every worktree sweep run that day logged *removed 0 worktree(s)*. It kept 17
`open-pipeline`, 16–17 `uncommitted`, 12–18 `recent-writes`, 5–10 `retention`
and 355 `not-created-by-delegatus`. The current rules
(`worktreeSweep.ts:161-166`, `:1327-1339`, `:1469`) are:

- a finished lane's checkout waits 4 days, unless it is clean with every commit
  on a remote (1 hour) or its HEAD is in a merged pull request;
- even then it waits until nothing in it was written for 24 hours (the quiet
  floor);
- a dirty or unpushed checkout is backed up and removed only after 4 days
  (`retireBackedUp` requires `staleTerminal`, `:1095-1096`, `:1367-1368`).

The manual run removed 29 of 33 such worktrees: 21 clean and 8 dirty; 8 of
the 29 needed a bundle. It kept four. The sweep reports those four under names
that do not say what blocks them:

| Blocker the manual run found | Reason the sweep reported |
|---|---|
| Git `index.lock` present | `ignored-files` (`.next/`, `node_modules/`) |
| Registration locked as *initializing* | `locked` |
| Two nested Git checkouts in `.artifacts/` | `uncommitted`, *linked evidence requires its own preservation* |
| Unfinished merge (`MERGE_HEAD`) | `uncommitted`, `git write-tree` failed on unmerged entries |

### 2.5 A risk found while reading: the manual backups

The manual backups are in `/var/tmp/llv-worktree-backups-20261125/` (3.4 GB).
That name starts with the temp sweep's owned prefix `llv-`
(`src/lib/tempDirs.ts:28`, `isOwnedTempName` at `tempSweep.ts:82-86`), and the
directory has no `.delegatus-keep`. The hourly temp sweep reaches the host's
`/var/tmp` through agent namespace views (`tempSweep.ts:271-287`). It removes
an owned directory once every entry is older than 24 hours and no process
references it (`:63`). These backups therefore become eligible at about
2026-11-26 19:41Z. Adding a keep marker or renaming the directory prevents
that. Part 3's backup root uses a name outside every owned prefix.

## 3. PR #4471: what it covers, and what its findings mean here

#4471 (*Attempt scratch sweep measures real allocation and reaches every
expired stage root*, branch `pipeline/llv-stage-d670496b`, head `4c5001e9` at
19:21Z) covers:

- **Allocation drain.** Registered roots are measured even while retirement is
  backed off. A missing path with no quarantine journal records 0 bytes, and a
  replaced inode advances the queue (`recordAllocation`). §2.2 needs exactly
  this.
- **Ordinary page continuation.** A durable `routine_sweep_cursor` lets the
  32-root page continue through the whole due ledger instead of revisiting its
  head.
- **Deadline repair.** A change-feed gap wakes the deadline audit, and the audit
  now also visits standalone launches.
- **Legacy recovery.** Attributable `$STATE/scratch/llv-stage-*` roots that
  were never registered are recovered; the work install's 427 GB of scratch is
  this case. The ambiguous ones are kept.
- **Shared tick deadline.** Preparation shares the tick's deadline with the
  sweep.

It does not cover the procfs hold (§2.1), the Cleaner's project scope (§4.3),
worktrees, monitoring, the journal of ordinary deletions, or linked installs.
This design leaves all of #4471 to its lane.

The verifier's findings on `4dfa8f5d` (19:26Z), which the lane's review stage
is to confirm:

| Finding | Meaning for this design |
|---|---|
| **P1** A root whose parent was moved into `state/backups`, with a symlink left at the old parent, still matches its ledger inode and is retired; the backup payload is deleted. On `main` the check is a denylist that excludes only `state/evidence` (`attemptTempPathAdmitted`, `attemptTempRetention.ts:83-88`). | Every deletion class here needs an **allowlist** admission: the canonical parent, checked at selection and at dispatch (§4.1). #4471's fix stage owns that fix for scratch and config roots. Slice 1 starts after it lands and adds a regression for the Cleaner path. The worktree backup root must lie outside every admitted parent. |
| **P2** A stale 4 KiB ledger value capped the reported reclaim of a root that freed about 33 MB. | Journal bytes (part 5) come from the visit's own fresh allocation measurement. A free-space delta is reported once per pass and is attributed to no single root. |
| **P2** A tick whose budget is already spent still writes the whole pressure inventory (950 rows, 0 visits). | After the merge with `main` no production caller reaches that branch, because the minute worker is `scheduledOnly`. This design adds no per-tick whole-inventory work and keeps the Cleaner as the pressure owner. The fix stage either checks admission before `pressurePass` or removes the unreachable branch. |

When read at about 19:55Z, lane 2dd4fda0 was in its merge stage with a
publication check running on `5802124b`; review and fix follow.

## 4. The design

### 4.1 One deletion rule for every class

Three classes are in scope:

- **S**: stage scratch roots, `$STATE/scratch/llv-stage-*` and
  `llv-read-only-stage-*`;
- **C**: stage config roots, `$HOME/.cache/delegatus/attempt-temp/llv-stage-config-*`;
- **W**: worktrees of closed or merged lanes.

The Cleaner's evidence and release classes and the temp sweep keep their
present rules.

**Never deleted, whatever a pass or an operator setting says:**

| What | Why it is safe to rely on |
|---|---|
| Anything outside the admitted namespaces below | Allowlist admission, checked again at dispatch |
| The main checkout of any repository; a checkout not recorded as created by Delegatus (`not-created-by-delegatus`); the serving, rollback and in-flight releases | Existing sweep and release-retention rules |
| `$STATE` outside `$STATE/scratch`, including `state.sqlite*`, `backups/`, `evidence/`, `disk-cleaner/` and `worktree-backups/` | Allowlist: only direct children of the two canonical parents are S/C candidates |
| Roots of running or unconfirmed attempts; open lanes' worktrees; a lane whose teardown, delivery or merge has not settled | Authority read per visit and again at dispatch (`attemptTempProduction.ts:24-68`, `worktreeSweep.ts:62-105`) |
| Any tree a live process references through its cwd, an open file, `exe`, `root`, a mapping, an argument or `HOME`/`TMPDIR`/`LLV_STATE_DIR`/`XDG_CONFIG_HOME`/`CLAUDE_CODE_TMPDIR`; a live conversation's cwd; a socket or container mount inside the tree | `/proc` scan per visit, repeated inside the mutation fence |
| Recorded-check custody, linked report evidence within its seven days, explicit `.delegatus-keep` markers | Existing holds |
| Ownership that cannot be proven (`orphan`, unknown launch) | No age, name or owner grants authority |
| A worktree with a Git operation in progress, a locked registration, a nested checkout or a failed backup | Part 3 skip list |

**Liveness proof.** A tree is dead when its owner has ended (attempt or lane
terminal, with the clock in §4.2–4.4) and the reference scan finds no live
consumer. One change to the scan: a process cwd on procfs (a path under the
scanning namespace's `/proc/`) cannot be a checkout and cannot reach a scratch
tree by its cwd. `RepositoryLinkInventory.repositoryOf` records it as "no
repository" instead of throwing. Its open files, `root`, mappings and arguments
still go through `attemptProcessReferencesClear` (`attemptTempFilesystem.ts:484-520`),
whose link walk already tolerates unresolved paths (`followLinkChain`, `:71-99`). A cwd that ends in
` (deleted)` is discovered from its nearest existing ancestor. Every other
unreadable cwd of a live process stays a hold, with disposition `held`, code
`checkout_unreadable`, and the pid and command name in its reason. Today that
case is reported as `operator`, which asks the operator to remove something
that does not exist.

**Canonical-path admission (allowlist).**

- S and C: the root's name matches its pattern, and its parent is exactly
  `$STATE/scratch` or the attempt-config parent (`attemptTempConfigParent`,
  `src/lib/runtime/attemptTempPaths.ts:5-7`).
- `realpath(parent) === parent`, so no component is a symlink.
- The parent's device and inode equal those recorded when the root was
  registered.
- The root itself is a real directory (no symlink) with its recorded identity.

The Cleaner already checks the first two (`diskSweep.ts:39-46`); one shared
predicate replaces both copies. W is admitted only as a registered linked
worktree of a repository Delegatus tracks. Its `realpath` must equal the
registered path; it must not be the main checkout; and it must not lie inside
`$STATE` or the backup root. Every predicate runs at selection, after each
await, and inside the existing mutation fence at dispatch, with the parent in
the fence's watch list.

### 4.2 Part 1: stage scratch in the ordinary pass

- **What deletes.** The minute worker's ordinary tick, as today (scheduled one
  minute after the previous request settles, `tempSweep.ts:1168-1171`).
- **Eligibility.** The root's attempt is `passed`, `failed` or `skipped`, or its
  launch was retired, strictly more than 24 hours ago, also in an open lane.
  A retain-until-close root uses the lane's finish clock
  (`attemptScratchPolicy.ts:14-36`). This 24-hour clock is the "older than a
  day" rule the manual deletion applied.
- **Changes.** #4471 (allocation drain, continuation cursor, legacy recovery)
  plus its P1 fix; the procfs rule of §4.1; the journal of §4.6.
- **Bounds (unchanged).** 32 roots per tick, a 40-second work budget inside the
  60-second helper deadline, 5–30 seconds per root. At 36–60 ticks an hour that
  is up to about 1,900 roots an hour when proofs are cheap. The 921 directories
  of 2026-11-25 fit within one hour.

### 4.3 Part 2: the attempt-temp cache and the pressure pass

Config roots follow the same ledger, clock and fences as scratch. Under
pressure the Cleaner pass (`src/lib/cleaner/diskController.ts:114-197`) remains
the only owner. Four changes:

1. **Machine-wide selection.** `scratchOwnerMatches`
   (`diskSweep.ts:57-73`, applied at `:99-103` and `:123`) keeps every root whose
   lane belongs to a project other than the Viewer's own. A disk is shared by
   every project on the machine, and the ordinary tick already covers all of
   them. The pass instead requires a provable owner: a lane record with exactly
   one matching attempt, or a standalone receipt whose conversation is not
   superseded. It records that owner's canonical project in the journal. The
   pass report still goes to the Viewer's project seat (`actions.project`,
   `src/lib/state/diskPressureActions.ts:26-33`).
2. **Largest expired first.** `cleanerRoots` orders by directory name, 16 per
   slice (`attemptTempRetention.ts:334-336`). The pass instead takes expired
   roots by measured allocation, descending (the `roots_size` index exists). Its
   durable cursor stays (`scratchCursor`). The Cleaner's existing finished-lane
   clock (lane finished and the tree idle for 3 hours, `diskSweep.ts:22`,
   `:108-109`, `:128`) is unchanged.
3. **The procfs rule** (§4.1) makes visits succeed on desktops.
4. **An honest report line.** On `main` the minute worker's `pass` fields stay
   null. When pressure or low space is on, the attempt-temp summary names the
   latest Cleaner pass (id, roots and bytes removed, finish time) instead of a
   stale "last pass … removed 0".

Acceptance for part 2 is behavioural: with an expired, unreferenced root and a
live process whose cwd is `/proc/<missing pid>/fdinfo`, a Cleaner pass in
low-space mode removes the root and journals it.

### 4.4 Part 3: worktrees of closed or merged lanes

The worktree sweep (hourly, first run 10 minutes after start,
`worktreeSweep.ts:175-177`, in 16-candidate slices) gains one retirement path
for class W.

**Eligible when all of these hold:**

- A Delegatus record names the checkout: a pipeline `worktreeDir` (archived
  lanes included), merge-batch state, or a provenance record.
- Every owning lane is `closed` or `completed` with settled teardown and
  delivery, or the branch's pull request is merged and contains HEAD, and no
  open lane owns the checkout.
- The lane settled at least 1 hour ago and nothing in the tree was written in
  the last hour. This is the existing `PUSHED_WORKTREE_RETENTION_MS` and its
  quiet floor (`worktreeSweep.ts:164`). It replaces the 4-day hold for dirty or
  unpushed checkouts and the 24-hour quiet floor for merged ones, because the
  backup below preserves what those holds protected.
- The process, conversation, merge-batch and mount guards pass, as today.

**Skipped and reported, never removed:**

| Code | Condition |
|---|---|
| `git-index-lock` | `index.lock` exists in the worktree's gitdir |
| `locked` | the registration is locked (any reason, including *initializing*) |
| `nested-checkout` | a nested registered worktree, or a `.git` entry, Git repository or gitlink (`160000`) anywhere in the tree |
| `unfinished-git-operation` | `MERGE_HEAD`, `REBASE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` or `BISECT_LOG` in the gitdir |
| `backup-space` | no backup destination has room (below) |
| `backup-failed` | writing or verifying the backup failed; the detail names the step |

**Backup.** It is written before removal into
`<backup root>/<lane id>/<UTC time>-<short HEAD>/`, with files 0600 and
directories 0700:

- `staged.patch` (`git diff --binary --cached HEAD`) and `unstaged.patch`
  (`git diff --binary`), each omitted when empty. Together they are the binary
  patch of dirty changes and restore both the index and the tree.
- `untracked.tar`: untracked files that are not ignored, plus ignored files that
  are neither a disposable class (dependencies, builds, caches,
  `disposableIgnored`) nor evidence. Ignored evidence keeps its existing copy
  into `$STATE/evidence/<lane>/worktree/` (`worktreeBackup.ts:94`), because
  evidence links resolve there.
- `branch.bundle`, written only when some commit of HEAD is in no ref a remote
  advertises at that moment (the sweep's existing fresh `ls-remote` proof). It
  carries the branch ref and `HEAD` and excludes commits reachable from
  advertised refs present locally.
- `manifest.json`: lane ids, repository, branch, HEAD, the remote proof, the
  size and SHA-256 of each file, and a one-line restore command per file.

Verification before removal: hashes match; `git bundle verify` passes in the
repository; `git apply --check` passes for both patches against HEAD in a
temporary index; the tar's listing equals the selected path list. Then come the
existing final checks: HEAD lock, refreshed registration, a second status
equal to the first, guards, the worktree-map record, and `git worktree remove`.
For this class the backup replaces the in-repository
`refs/delegatus/worktree-backup/...` commit (`worktreeBackup.ts:151`), so the
repository's own disk does not grow.

**Destination ("another disk when one exists").** Candidates in order:

1. `/var/tmp/delegatus-worktree-backups` in the host's mount namespace. A native
   install writes it directly. The Docker install writes through the validated
   host view the sweep already uses for role checkouts under host temp
   (`src/lib/state/hostTempViews.ts`); without such a view this candidate is
   unavailable. The root gets a `.delegatus-keep`, and its name is outside
   every owned temp prefix.
2. `$STATE/worktree-backups`.

The sweep chooses the first candidate whose filesystem differs from the
worktree's (a different `st_dev`) and whose free space after the write stays
above that volume's low threshold (§4.5). If no candidate is on another
filesystem, it uses the first one with room. If none has room, the worktree is
kept as `backup-space`. On the workstation candidate 1 is the 404 GB root
filesystem and the worktrees are on the home filesystem. Today's 29 manual
backups took 3.4 GB, mostly ignored files that this rule leaves out.

**Bounds.** The sweep's existing removal cap per run and its 16-candidate slices
stay. Backup writing gets the existing per-candidate command timeouts (30
seconds per Git step). A slice ends after one backed-up removal when a low-space
pass is waiting, so the pass can measure again.

### 4.5 Part 4: free space per machine, the low state and the admission pause

**Volumes.** Each install reads the filesystems it writes to: today's roots
(`diskPressure.ts:310-313` and `stageDiskRoots`, `:149-171`: state, scratch, the attempt-config parent, the
agent config sandbox, worktrees, repositories and temp roots), plus `/` and the
filesystem holding `$HOME`, both in the host namespace (through the existing
host probe, `diskPressure.ts:66-110`, when containerized). Rows are keyed by
the filesystem's device from the host namespace, so the two `/home` rows of
§2.3 become one. Each row is labelled by its host mount point, with a home
prefix shown as `~`. Memory-backed filesystems (`tmpfs`, `ramfs`) keep today's
warning and critical levels and take no part in the low state.

**Signal.** The disk watch, every 30 seconds on the release that owns traffic
(`src/lib/state/diskPressureWatch.ts:105-112`), keeps per volume the
`(at, freeBytes)` samples of the last 20 minutes, at most 41. It persists them in
`disk-pressure-report.json` so a restart keeps the window.
`loss20 = max(free in window) − current free`.

**Thresholds.** These are fixed defaults. The requirement names the values, so
this design adds no setting.

| State | Condition on any disk-backed volume | Recovery |
|---|---|---|
| `low` | free < min(50 GB, 25 % of total), or `loss20` > min(10 GB, 5 % of total) | every volume has free ≥ 1.2 × its free threshold and `loss20` ≤ its loss threshold |
| `warning`, `critical` | unchanged (`diskPressure.ts:30-63`) | unchanged |

Every named volume whose size I could read is at least 404 GB (the workstation's
root is 404 GB, its home 1.48 TB, the work install's root about 1.74 TB), so the
fixed 50 GB and 10 GB apply to them; the stage server's size is unconfirmed (§8). The proportional floor keeps a small disk from being
permanently low.

**On entering `low`** (per machine, by that machine's own Viewer):

1. **Warn the operator.** Send one bridge report and one seat card for the low
   episode, naming the machine, the volume, free bytes, `loss20` and the
   largest consumers already measured. Send one more when the episode ends.
   The low episode is separate from the warning episode, so it fires even
   while a warning episode is open. That removes the one-message-per-episode
   gap noted in [cleaner-agent.md](cleaner-agent.md) §3.5. The seat tick raises
   `disk-low:<install>:<volume>:<episode>`, which leads the agenda the same way
   `disk-space` does (`src/lib/monitor/seatTick.ts:1459-1466`, `:2207-2214`).
2. **Run parts 1–3 now.** The automatic pass starts at once, overriding the
   15-minute cooldown once per low entry (`diskController.ts:22`, `:127`,
   `:148`). It runs the scratch and config class (§4.3), the existing evidence
   and release classes, and a worktree sweep request (§4.4). While the volume
   stays low, passes repeat on the existing 15-minute cooldown within the
   existing 20-minute pass budget. `needsCleaning` (`:32-35`) gains the low
   state; the 150 GB `LLV_CLEANER_FREE_GB` trigger stays.
3. **Pause new lane admission.** `worktreeDiskWait`
   (`diskPressure.ts:180-183`), checked before any Git work and again right
   before `git worktree add` (`src/lib/pipelines/engine.ts:11684-11700`),
   returns a wait while any volume the lane would write to is low. It reads the
   low state from the persisted report. If that report is more than 2 minutes
   old, it applies only the absolute threshold to a fresh probe. The lane
   shows *waiting for disk space: ~ 42 GB free (below 50 GB) …*. Running lanes
   and their later stages continue.

**Lifting.** The engine already retries a waiting lane every 60 seconds without
spending its retry budget (`DISK_SPACE_RETRY_MS`, `engine.ts:11797-11805`).
Once the persisted state leaves `low`, the next retry provisions the lane.
Nobody has to lift anything by hand.

**System panel.** A **Disks** block in the System panel
(`src/components/ResourcesFooter.tsx`; payload at `src/lib/resources.ts:2639-2644`)
is visible at all times. It shows one group per machine (this install first,
then linked installs) with each volume's mount label, free space, its 20-minute
change, its state, and the reading's age. A low or stale row names its state in
words. The consumer list gets three changes:

- the worktrees line splits into *Delegatus lane worktrees* and *other
  checkouts (not removed by Delegatus)*;
- each consumer shows the bytes a removal would free (directories and files
  with one link) next to its shared bytes (files with more links, each inode
  counted once across all consumers);
- *outside Delegatus accounting* is computed once per filesystem.

### 4.6 Part 5: the journal and the seat report line

**Journal.** Every deletion in classes S, C and W, in the ordinary passes and
in Cleaner passes, appends rows in the existing Cleaner format
(`src/lib/cleaner/diskJournal.ts:35-44`). Each row has `phase`
(`intent` | `removed` | `refused`), `path`, `bytes`, `class`, `proof` and `at`,
plus three new fields:

- `reason`, for example `expired-24h`, `lane-closed`, `merged-pr` or `low-space`;
- `project`, the owner's canonical project;
- `kind`, `scratch` or `config` within class `attempt-temp`.

A worktree row also names its backup directory. Cleaner passes keep
`$STATE/disk-cleaner/<pass id>.ndjson`. Ordinary deletions go to
`$STATE/disk-cleaner/ordinary-<UTC date>.ndjson`. An intent is written and
fsynced before the mutation, and a failed intent write blocks it, as today. An
intent left without an outcome is reported as uncertain. `bytes` is the
allocation measured during that same visit (allocated blocks, each hardlinked
inode once; for a worktree, the bytes its removal frees). A partial
measurement adds `partial: true`. The ledger value is never used. The writer
deletes its own daily files older than 30 days when it opens a new day.

**Seat report line.** The wake message's reserved tail, which the length bound
never cuts (`reportLines`, `src/lib/monitor/report.ts:327-330`), gets at most
two lines:

```
Disks: this install ~ 91 GB free (−12 GB/20 min, low), / 183 GB; Stage / 213 GB (2 min ago); work / 235 GB (4 min ago).
Cleanup since the last report: scratch 412 roots 61.2 GB; config 380 roots 1.8 GB; worktrees 6 (2.1 GB, backups on another disk); refused 3. Journal: disk-cleaner/ordinary-2026-11-26.ndjson.
```

The cleanup line is computed from journal rows after a per-seat cursor that
advances when the wake lands, the same acknowledgement the `disk-cleaner:<id>`
signal already uses (`src/lib/cleaner/diskReport.ts:77-99`). It appears only
when something changed. Pass reports keep their own card
(`diskReport.ts:135-149`), which gains the worktree class.

### 4.7 Linked installs report their disks

Each install measures and acts only on its own disks; deletion never crosses a
link. The readings travel in the existing `boards/sync` exchange as a new
optional part, `dk`:

```
dk: { v: 1, at, install: { id, label }, volumes: [{ mount, totalBytes, freeBytes, loss20, state }] }
```

- The caller adds `dk` to its request (`src/lib/links/client.ts:223`), and the
  grant side adds its own to the answer (`route.ts:48-100`). Both sides learn
  both readings in one call.
- An older peer ignores an unknown field and sends none. Its row then shows
  *no disk reading from this version*.
- The receiver keeps the latest reading per peer install in memory, one owner
  (`sharedLinkState`, `src/lib/links/runtimeState.ts`), and on disk at
  `$STATE/links/peer-disks.json`, bounded to one entry per linked peer.
- Sync runs every 10–15 seconds while active and at most 5 minutes apart when
  idle (`src/lib/links/schedule.ts:17-22`). A reading older than 15 minutes
  is shown as stale.
- A peer in `low` raises a seat card and wake item on this board. The bridge
  report comes only from the peer's own install, so the operator gets one
  message per event.
- Privacy: mount labels with any home prefix replaced by `~`, byte counts,
  times and the install label. No paths below the mount point and no host
  names.

Prerequisite: the workstation is linked to one peer today, labelled *Stage*.
For the work install to appear, it has to be linked to this board through the
usual pairing code. Links are peer to peer and nothing is relayed through a
third install.

## 5. Slices, in order

Every test below uses fixtures only, with a private `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` under the OS temp root, a
closed Viewer control URL, and injected process scans and disk probes. No test
reads or writes a real home, the live state directory or a real `/proc` view of
other processes.

### Slice 1: scratch and config deletions happen (parts 1, 2 and the journal for S and C)

Starts after #4471 lands with its P1 fix.

**Corrected scope (2026-11-26).** #4471 shipped and a work install still removed
nothing: its ledger sat under its cap while about a thousand
`state/scratch/llv-stage-*` directories, hundreds of GB, were not in the ledger
at all, and the stage server's ledger was far over its cap with the same effect.
The cap was the only trigger and the ledger the only inventory. Slice 1 therefore
also deletes the directories the ledger holds no owner for and starts on free
space, not on the cap alone. `src/lib/runtime/unregisteredScratch.ts` does this
in the minute tick, before the ledger page, under the ledger sweep's admission
lock:

- **Candidates.** Direct children of `$STATE/scratch` named like stage scratch
  (`llv-stage-*`, `llv-read-only-stage-*`) that have no ledger row, or only the
  ownerless `adopted` row legacy adoption wrote. A root that recorded custody
  names, or that a live ledger row owns, stays with the ledger.
- **A root qualifies** when nothing in its tree was modified for 24 hours (the
  newest `mtime` of the root and every entry, a bounded walk that stops at the
  first newer entry), no live process references it (the ledger's reference
  observer: cwd with the procfs rule, open files, `root`, mappings, arguments,
  environment, sockets, checkout links, container mounts), it passes
  canonical-path admission (a real directory directly under the real scratch
  root, never reached through a link, never under backups or evidence), and no
  `.delegatus-keep` marker, nested Git checkout, linked report picture, recorded
  custody, mount or open lane holds it. The last proofs are repeated
  synchronously before the rename.
- **Kept and counted, with the reason and a time to look again:** every other
  case, including an unreadable or unproven tree. A kept root waits for its own
  deadline (`young` waits until its 24 hours end, a live reference ten minutes,
  a hold on the tree six hours), so roots that cannot go never fill a pass. The
  wait is stored in the ledger database and survives a restart.
- **Trigger.** Each minute tick reads free bytes on the state volume and keeps
  the readings of the last 20 minutes in the ledger. Below 50 GB, or more than
  10 GB lost since the highest reading in the window, the pass runs with the
  larger bound at once: 128 removals, 256 examined and 35 s, against 16, 48
  and 15 s for an ordinary tick. Oldest roots go first in both. A failed
  free-space reading never starts the larger pass and is reported.
- **Crash safety.** The pass records the root's identity in the ledger database
  (its own tables and connection), then the owned remover renames the root into
  a claim tombstone beside it (`.delegatus-trash-claim-<dev>-<ino>-<uuid>`) and
  deletes it with its deadline. A pass finishes only the tombstones whose
  identity it recorded, after checking that the directory is the inode its name
  records and that no live process references it; the attempt ledger's own
  claims are never touched. A tree this user cannot write gets owner write
  access inside the tombstone and one more attempt; otherwise it is kept as
  `unremovable_permissions`.
- **Journal.** `$STATE/disk-cleaner/ordinary-<UTC date>.ndjson`, in the Cleaner's
  row format with `reason`, `ageMs`, `identity`, `trigger` and a state-relative
  `path`. An intent is fsynced before the rename and a failed write leaves the
  tree in place. `bytes` is the allocation counted in the same walk that proved
  the age (blocks, each hardlinked inode once), never the ledger value. A kept
  root is written once per reason. Files older than 30 days go when a new day
  opens.
- **Report.** `attempt-temp-report.json` carries an `unregistered` block (roots
  found, owned by the ledger, examined, removed, observed free-space gain, kept
  by reason with their bytes, totals since the ledger began and the last working
  pass) and the same facts in its summary.

Not in this slice: worktrees (slice 2), the low-space state, operator warning
and lane pause (slice 3), linked installs (slice 4). The 50 GB line here is the
absolute one the requirement names; slice 3 adds the proportional floor for
small disks.

- The procfs and deleted-cwd rule in `RepositoryLinkInventory`, and the
  `checkout_unreadable` disposition change.
- The shared allowlist predicate, used by the minute tick, the Cleaner and the
  approved-manifest path.
- Cleaner machine-wide selection and largest-first order.
- Journal rows from the ordinary tick and the Cleaner for S and C, with bytes
  from the visit's measurement.
- The attempt-temp summary names the latest Cleaner pass.

Acceptance and tests:

- `src/lib/runtime/attemptTempFilesystem.test.ts`: a scan whose process (the
  test's own pid, alive) has cwd `/proc/<unused pid>/fdinfo` lets
  `attemptReferencesClear` clear an unrelated root. The same process holding an
  open file inside the root still holds it with `process_reference`. A cwd
  ending in ` (deleted)` under a checkout that links to the root still holds it.
- `src/lib/runtime/attemptTempRetention.test.ts`: one ordinary tick over three
  expired, unreferenced roots, with that process in the scan, removes all three.
  On `main` the same fixture reports `checkout_unreadable` three times, so the
  test is red there.
- `src/lib/cleaner/diskSweep.test.ts`:
  - a low-space pass with expired roots owned by lanes of two projects removes
    both, and the journal names each project;
  - a root under a parent replaced by a symlink into `state/backups` is kept
    and its payload survives, while a valid sibling is removed;
  - roots are visited largest first.
- Journal: in a removal of a tree of 32 MiB dense data plus a 256 MiB sparse
  file, with a 4 KiB ledger value, the `removed` row records the measured
  allocation of about 32 MiB; a row of 4 KiB or 288 MiB fails the test. An
  intent write that fails leaves the tree in place.

### Slice 2: worktrees of closed or merged lanes (part 3 and its journal rows)

- The 1-hour eligibility for the W class.
- The skip codes.
- The external backup and its verification.
- The destination choice.
- Journal rows naming the backup.

Acceptance and tests, in `src/lib/pipelines/worktreeSweep.test.ts`, with a
fixture repository and linked worktrees, and injected `backupRoots`,
`sameFilesystem` and `freeBytes` ports:

- A closed lane settled 61 minutes ago has a staged change, an unstaged change,
  an untracked file, an ignored `node_modules/` and one local-only commit. The
  run writes `staged.patch`, `unstaged.patch`, `untracked.tar`, `branch.bundle`
  and `manifest.json` to the candidate reported as another filesystem, removes
  the worktree, and journals it. Restoring into a fresh clone (fetch the bundle,
  apply both patches, extract the tar) reproduces the original tracked tree,
  index and untracked files. `node_modules/` is absent from the tar.
- A clean lane whose HEAD is on the fixture remote gets a backup without a
  bundle.
- At 59 minutes the checkout is kept as `retention`.
- `index.lock`, a locked registration, a nested `.git` in `.artifacts/` and
  `MERGE_HEAD` are each kept under their code, with no backup written and the
  tree intact.
- When the only candidate shares the worktree's filesystem, the backup goes to
  `$STATE/worktree-backups`. When no candidate has room, the checkout is kept as
  `backup-space`.
- A checkout without a Delegatus record is kept as `not-created-by-delegatus`.
- A worktree changed between backup and removal is kept, and its backup stays.

### Slice 3: per-machine monitoring, the low state, warning, immediate passes and the pause (parts 4 and 5 locally)

- Volume rows keyed by host device and labelled by mount, with `/` and `$HOME`.
- 20-minute samples, the low state and its recovery.
- Low-episode report and card.
- The immediate pass, with the worktree request.
- The admission pause.
- The System panel Disks block and the consumer split.
- The seat tail lines.

Acceptance and tests:

- `src/lib/state/diskPressure.test.ts`:
  - free 60 → 49 GB enters low; 200 → 189 GB within 20 minutes enters low;
  - recovery at 60 GB with `loss20` ≤ 10 GB;
  - a 40 GB disk uses 10 GB and 2 GB thresholds;
  - `tmpfs` never enters low;
  - samples survive a reload and stay at 41 or fewer;
  - two roots on one device yield one row, and *outside Delegatus accounting*
    counts that filesystem once;
  - two checkouts sharing a hardlinked 10 MB file, each with 5 MB of its own,
    report 10 MB freeable and 10 MB shared.
- `src/lib/state/diskPressureWatch.test.ts`: entering low inside a Cleaner
  cooldown starts a pass at once and requests a worktree sweep. A second low
  entry within the same episode starts nothing. One report and one card go out
  per episode, plus one recovery report.
- Engine, through `engine.fixture.ts` with the `worktreeDiskWait` port: a new
  lane waits while low, without spending its retry budget, and provisions on
  the first retry after recovery. A running lane's next stage still starts.
- `src/lib/monitor/seatTick.test.ts` and the report tests: a low volume leads
  the agenda; the wake's tail carries the disk line and, after a journaled
  removal, one cleanup line that does not repeat once the wake has landed.
- Rendered evidence for the System panel through the existing board geometry
  capture (`scripts/capture-board-geometry.ts`) and phone driver
  (`src/components/mobile/issue1671Evidence.browser.test.tsx`), one added case
  each. It covers ok, low and stale rows, in en and uk, light and dark, at phone
  and desktop widths and one width between.

### Slice 4: linked installs report their disks (part 4 across machines)

- The `dk` part on both sides of `boards/sync`.
- The peer reading store.
- Peer rows in the Disks block and in the seat disk line.
- The peer-low seat item.

Acceptance and tests:

- `src/lib/links/boardSync.test.ts`: two fixture installs exchange readings in
  one call. An older peer without `dk` syncs as before and shows *no disk
  reading*. A reading older than 15 minutes is stale. A revoked grant stores
  nothing.
- A peer reading in low raises one seat item per peer episode and no bridge
  report on this install.
- The serialized part contains no path below a mount point.
- Rendered evidence as in slice 3, with a peer group.

## 6. Shared paths

| Surface | Producers | Consumers | Change |
|---|---|---|---|
| `attempt-temp.sqlite` `roots` and the allowlist predicate | registration (`structuredSpawn.ts`), legacy adoption, #4471 recovery | minute tick, Cleaner, approved manifest (`scripts/attempt-temp-approved.ts`) | one predicate for all three (slice 1) |
| `RepositoryLinkInventory` | `attemptReferenceHold` | minute tick, Cleaner, approved manifest, temporary-data retention | procfs cwd treated as "no repository" (slice 1) |
| `$STATE/disk-cleaner/*.ndjson` | Cleaner pass; slice 1 adds the minute tick, slice 2 the worktree sweep | `readJournal`, `reconcileDiskCleanerReport`, seat signals | new optional fields; readers tolerate them |
| `disk-pressure-report.json` | the disk watch (traffic-owning release only) | resources payload, seat tick, Cleaner admission, `worktreeDiskWait` | samples, low state, device-keyed rows; MCP readers stay read-only (`diskPressure.ts:288-289`) |
| `worktree-sweep-report.json` kept rows | worktree sweep | disk-pressure consumers, MCP status, temp-sweep exclusion | new reason codes; old readers show them as text |
| `boards/sync` | `client.ts` (caller) and the peer route (grant side) | link state | optional `dk` part, both directions |
| PR #4475 | temp sweep for agents' `/tmp` and `/var/tmp` trees | — | must not adopt `delegatus-worktree-backups`; the backup root's keep marker covers that |

## 7. Deferred, not currently justified

- **Foreign checkouts** (355 kept as `not-created-by-delegatus`; 82 GB under
  `$HOME/Projects`): Delegatus did not create them and the requirement covers
  lanes' worktrees only.
- **Backup expiry.** Backups under `/var/tmp` age out under the operating
  system's temp policy. The `$STATE/worktree-backups` fallback grows and is
  shown as a consumer. A retention rule waits for a measured need.
- **A shorter scratch clock** in the ordinary pass. 24 hours after an attempt
  ends matches what the operator deleted by hand. The Cleaner's existing
  3-hour idle rule already covers pressure.
- **Evidence, recorded-check custody, host event journals, releases and Docker
  build cache**: their existing rules stay.
- **Moving Next.js builds out of scratch** (deferred by #4471).
- **Settings for the thresholds**: the requirement fixed the values.
- **Transitive reporting** (work through stage), and any action on another
  machine's disk.
- **A "time until full" forecast** from `loss20`.
- **The manual backups' `llv-` prefix risk** (§2.5): an operational step,
  outside the product change.

## 8. Could not confirm, and where I looked

- **The work install's own hold reasons.** Its ledger and report were not read
  from here. Whether a Chromium-family process runs there (the §2.1 cause) is
  unknown. #4471's legacy recovery addresses its unregistered scratch.
- **The stage server's root filesystem size.** The formula in §4.5 applies the
  fixed values to any volume of 200 GB or more; the server reported 213 GB
  free.
- **Whether the Docker install's host-namespace runner can write backup files**
  (§4.4, candidate 1). I traced the read and probe paths only. If it cannot,
  candidate 2 applies and the backup stays on the state filesystem.
- **Why the home filesystem also appears as device 53.** The two rows had equal
  total and free bytes; the cause was not traced.
- **The exact panel text** was not captured; §2.3 uses the report's bytes.
- **#4471's final fix for P1** is still in its lane.

## 9. Validation against the requirement

| Requirement | Where | How it is met |
|---|---|---|
| 1. Ended attempts' scratch without live references, in the ordinary pass | §4.1, §4.2, slice 1 | #4471 plus the procfs rule. The minute tick removes roots 24 hours after the attempt ends, checking cwd, open files and the other references. |
| 2. The pressure pass actually deletes expired roots | §2.1, §4.3, slice 1 | The cause of zero removals is removed; the Cleaner selection covers all projects, largest first. |
| 3. Closed or merged lanes' worktrees removed with a backup, on another disk when one exists; skip index.lock, locked, nested, unfinished merge | §4.4, slice 2 | Patches, tar, bundle and manifest are verified before `git worktree remove`; the four cases are named codes. |
| 4. Free space per machine in the panel and the seat tick; below 50 GB or more than 10 GB lost in 20 minutes: warn, run 1–3 now, pause new lanes until recovery | §4.5, §4.7, slices 3–4 | Per-volume samples, the low state, report and card, an immediate pass, the admission wait and automatic lifting; peers report over `boards/sync`. |
| 5. Every deletion journaled with what, bytes and why; a summary in the seat report | §4.6, slices 1–3 | Intent and outcome rows with measured bytes and a reason; the cleanup line in the wake's reserved tail. |
| The worktree number counts shared bytes once | §2.3, §4.5 | It already does; the panel now separates lane worktrees from other checkouts and freeable from shared bytes. |
