# Temporary data lifecycle: why it piles up, and what makes manual cleanup passes unnecessary

Status: design (audit). Read-only investigation; no product code changes, nothing on
the machine deleted, stopped or modified. Written on 2026-11-11 against `main` at
`1037130e`, with the seven-day retention of #3845 installed on this machine since
the 11:17Z deploy of the same day.

## 0. Originating requirement

**Operator, 2026-11-11, a comment on a decision form of the disk task (private;
paraphrased here, never quoted).** Look at every deletion the manual cleanup passes
made, find out why each kind of data multiplies and is not cleaned up, and what that
depends on, so that the regular automatic runs clean all of it from now on.

Context: between 2026-10-29 and 2026-11-11 a series of manual passes (seventeen when
the request was written, eighteen by the end of the same day) removed temporary data
from this machine until at least 400 GiB were free. The operator wants, for every class
of data those passes removed, the reason it accumulates and the reason nothing removes
it automatically, and a plan after which no manual pass is needed.

This document answers that in these parts: the classes (§2), the known failures of the
seven-day retention (§3), the classes with no lifetime and proposed lifetimes (§4), the
disk card (§5), the build plan (§6), the decisions only a person can take (§7), where the
ledgers and the code disagree (§8) and what could not be confirmed (§9).

**Labels.** Factual statements in the class sections (§2), in §3 and in §8 carry **[O]** (observed: read in a ledger,
measured, read in the service journal or a state database opened read-only, or read in
the code at `1037130e`) or **[I]** (inferred from observations; the check that would
settle it is named). Proposals are marked as such. Sizes are GB = 10^9 B unless GiB is
written. Per-path sizes count hardlinks once per path, so sums over paths exceed what
deleting them frees.

**Sources and time bounds.** The ledgers and reports of passes 1 to 18 and the
read-only measurements of 2026-11-11 (retained breakdown at 00:20Z, rest of the volume
at 02:10Z, operator projects at 10:49Z, scratch owners at 12:06Z, stale worktrees at
13:36Z, undetermined worktrees at 14:11Z, post-deploy acceptance at 11:48Z); the board
history of the disk task, the "retention cannot keep up" task and this task; the
service journal from 11:17Z to 14:32Z; read-only (`mode=ro`, `query_only`) reads of the
state, attempt-temp and recorded-check tables between 14:35Z and 14:50Z; the sweep
reports written at 14:03Z (worktrees), 14:24Z (attempt temp) and 14:28Z (releases); a
read-only `/proc` and filesystem probe at about 14:35Z; a read-only listing of the state backup
folder at 16:11Z (§2 C16). These sources are private and
stay on the machine; this document names things by kind only.

## 1. What the passes removed and what the measurements found

| Pass | Date (UTC) | What it removed | Free space before → after, or removed bytes |
|---|---|---|---|
| 1 | 10-29 | 80 clean lane worktrees (85.4 GB per path), one merge-train scratch (5.4 GB), 2 stage scratch roots (31.7 GB); made 9.3 GB of archives | +64.9 GB free [O] |
| 2 | 10-29 | 379 stage scratch roots (412.7 GB), 111 directories under `/var/tmp` (58.9 GB) | 53 → 375 GB free [O, task history] |
| 3 | 10-29 | startup measurements, old evidence and archives (133.6 GiB); 126 scratch directories after 125 host stops; 669 stopped containers and 2,816 anonymous container volumes | 373 → 875 GB free [O, task history] |
| 4 | 10-30 | 29 scratch roots (50.5 GB), 20 lane worktrees (21.0 GB); made 21.25 GB of archives | +38.8 GB [O] |
| 5 | 11-02 | 66 scratch roots (101.5 GB), 11 lane worktrees (10.4 GB), one finished `/var/tmp` directory (5.7 GB); made 33.4 GB of archives | +62.9 GB [O] |
| 6–9 | 11-02 to 11-04 | nothing (liveness reads failed or were stale; one launch failed) | 0 [O] |
| 10 | 11-04 | 163 scratch roots of finished lanes (314.9 GB) plus 2 partial (9.9 GB); made a 25.1 GB evidence backup | 109.7 → 397.8 GB free [O] |
| 11 | 11-11 | 169 scratch roots of finished lanes (114.1 GB), 12 clean worktrees (2.8 GB); made 11.1 GB of backups and 96 backup refs | 55.5 → 133.9 GiB free [O] |
| 12 | 11-11 | 62 held scratch roots of lanes closed > 7 days (98.4 GB), 136 automatic evidence copies (17.2 GB), 94 archives of earlier passes (48.9 GB), one review export (1.9 GB) | 152.4 → 280.4 GiB free [O] |
| 13 | 11-11 | nothing (16 directories, 118 GB, kept: 25 of the operator's own processes unreadable in `/proc`) | 0 [O] |
| 14 | 11-11 | one diagnostic capture (69.3 GB), recovery folders of 25–30 Oct, a migration copy, a verification copy, a performance-release cache, an incident folder, a merge-train scratch: 14 of 15 paths, 113.9 GB; 10 registered worktrees inside them; 788 backup refs | 253.2 → 358.5 GiB free [O] |
| 15 | 11-11 | nothing (23 roots kept: other users' `/proc` unreadable) | 0 [O] |
| 16 | 11-11 | 13 stage scratch roots of lanes closed > 7 days, two of them half-finished trash (28.3 GB); permissions repaired on 7; 4 registered worktrees removed; 25,198 backup refs | about +25 GiB [O] |
| 17 | 11-11 | 160 dependency folders in other projects' checkouts (99.4 GB per path, 23.5 GB unique blocks); 65 unused container images (6.3 GB reported) | to 419.1 GiB free [O] |
| 18 | 11-11 | 40 clean worktrees idle > 30 days in other projects' repositories (6.4 GB); kept 4.7 GB of full-tree backups | — [O] |

Rate of accumulation [O]: from 397.8 GB free on 11-04 21:02Z to 59.6 GB free on 11-10
23:51Z with no manual pass, about 55 GB per day net; on 11-10 the fall reached about
6 GiB per hour. After the deploy of the seven-day retention, the automatic sweep wrote
172 retirement receipts for about 41 GB between 11:19Z and 14:32Z (about 13 GB per
hour) [O, journal]. At 14:32Z the volume had 411.9 GiB free [O].

The passes also made new data: passes 1, 4, 5, 10, 11 and 18 archived what they removed
into the evidence folder outside the state directory, and pass 12 then removed 94 of those
archives (48.9 GB) [O]. Passes 6 to 9 removed nothing because a liveness read failed or was
stale, or the launch failed; passes 13 and 15 removed nothing because they could not prove
that no process used a path: the processes of other users (and some of the operator's own)
cannot be read in `/proc` [O].

## 2. Classes of data, who creates them, and why nothing removed them

Summary (each row condenses the labelled section below it; line numbers are on `1037130e`):

| # | Class | Created by | Growth (orders of magnitude) | Supposed to remove it | Measured reason it stayed |
|---|---|---|---|---|---|
| C1 | Stage scratch roots of finished and closed lanes | `structuredSpawn.ts:200`, registered `:219` | 10–100 GB/day; ~1.2 TB removed by hand in 13 days | attempt-temp sweep each minute (`attemptTempRetention.ts:245`) | throughput and tick kills; lanes that can never finish; holds; unremovable trees (§3) |
| C2 | Scratch roots of agents launched outside lanes and of seats | same, owner `pipelineId: null` (`structuredSpawn.ts:274-278`) | ~10 GB live; ~8 GB created per day | same sweep, one day after creation when unreferenced (`attemptTempRetention.ts:414`) | none found: nothing older than 7 days remained |
| C3 | Lane worktrees in this repository | `store.ts:2564` names `<repo>-pipeline-<id>`, `git.ts:248` adds | ~1 GB per lane, tens of lanes per day | worktree sweep, hourly (`worktreeSweep.ts`) | `.artifacts` holds, backup refusals, sweep budget |
| C4 | Worktrees in other projects' repositories | lanes: same code; others: agents' own `git worktree add` | 397 extra worktrees, 146 GB per path | worktree sweep for lane worktrees; nothing for others | `not-created-by-delegatus`, `uncommitted`, `recent-writes` |
| C5 | Dependency folders in lane and agent-made worktrees, primary checkouts and one-off folders (subtypes D1–D4) | agents and stages installing packages | 174 folders, 102 GB per path, 26 GB unique | trim of top-level build folders in lane worktrees only (`worktreeSweep.ts:1634`) | trim never looks below the top level; nothing looks outside lane worktrees |
| C6 | Automatic copies of check evidence | `attemptTempEvidence.ts:14-120` | 49–62 GB stored | copy sweep at lane expiry (`attemptEvidenceCopies.ts`) | legacy copies kept as "unattributed" forever (`attemptEvidenceCopies.ts:69-74`) |
| C7 | Other evidence (`$LLV_EVIDENCE_DIR` per lane, per agent, recorded-check evidence, worktree backups) | `structuredSpawn.ts:204-208`, `recordedChecks/service.ts:309`, `worktreeBackup.ts:94` | ~60 GB | nothing, by design | "never deleted" (design of 2026-11-04) |
| C8 | Archives and backup refs made by the cleanup passes | the manual passes; product: `git.ts:352` | 21–33 GB per pass; 26,203 refs | nothing | no owner, no lifetime |
| C9 | Built releases | self-update, one per deploy | ~1 per deploy, ~4 GB each (shared blocks) | release retention (`selfUpdate/retention.ts`) | every release marked uncertain by one unreadable root process |
| C10 | Diagnostic captures and recovery folders | agents by hand, under home | one capture 69 GB; recovery 19 GB | nothing | no owner, no lifetime |
| C11 | One-off scratch outside the state directory | agents by hand (`/var/tmp`, home folders) | 59 GB in `/var/tmp` on 10-29; ≥ 60 GB in 3 days | temp sweep only for `llv-*` names (`tempSweep.ts:82-87`) | names are not `llv-*`; "never deleted" by design |
| C12 | Host event journals | `FileRuntimeEventStore` (`eventStore.ts`) | ~1 GB/day; 35 GB | nothing | no pruning code exists |
| C13 | Recorded-check holds on scratch roots | `recordedChecks/store.ts:243` | 68 roots, 98 GB at passes 10 and 11 | acknowledgement, or retention at lane expiry (`store.ts:368-387`) | lane never finishes; EACCES before acknowledgement |
| C14 | Container images, build cache, stopped containers, anonymous volumes | stages and agents in other projects | 53 GB images, 10 GB cache; 669 containers and 2,816 volumes once | nothing | no pruning code exists |
| C15 | Keep-marked roots (`.delegatus-keep`) | agents (the five present markers read as agent-written) | 3 roots 13.9 GB (11-04) → 5 roots 13.5 GB (11-11) | nothing, by design | kept forever; the card does not show them |
| C16 | The product's own state backups (`backups/sqlite` in the state directory) | `backupDatabase` (`state/durability.ts:833`), run by `runBackupPass` (`:1056-1101`) | ~15 GB, tracking three times the size of three databases | `pruneBackups` (`durability.ts:910-943`): per-database retention, then a 2 GiB budget | the three newest generations of each database are never evicted (`:50`, `:933`) and alone exceed the budget; recovery data, by design |

### C1. Stage scratch roots of finished and closed lanes

- **Creator [O].** `materializeStructuredHostAccess` makes `statePath("scratch")/llv-stage-*`
  (or `llv-read-only-stage-*`) with `mkdtemp` (`structuredSpawn.ts:200`), plus a config
  sandbox under the cache, and registers both in the attempt ledger (`:215-219`). The
  stage's `TMPDIR` is its `tmp/` child. Builds, test runs, review exports, browser
  profiles, Go module caches, Python environments and dependency installs land there.
- **Growth [O].** At 12:04Z: 702 roots, 360.1 GB: open lanes of all projects 132.9 GB
  (112 roots), closed lanes younger than 2 days 114.4 GB (216), 2–7 days 51.3 GB (46),
  older than 7 days 44.7 GB (28). Single roots reach 30–55 GB. Manual passes 1, 2, 4, 5,
  10, 11, 12 and 16 removed about 1.2 TB of this class by per-path measurement.
- **Supposed remover [O].** The attempt-temp tick runs every minute in the sweep helper
  (`tempSweep.ts:985-997` → `worktreeSweepWorker.ts` → `attemptTempProduction.ts:78`
  → `attemptTempRetention.ts:245`). A root whose attempt has settled, or whose lane is
  closed, is removed early once nothing references it; a root under a recorded-check hold
  waits for the lane's expiry, seven days after its last terminal event (`laneFinish.ts`).
  Evidence files are copied out first (C6).
- **Why it stayed.** Five separate reasons, each in §3:
  1. Throughput and killed ticks [O]: from 11:17Z to 14:32Z the tick summaries show 141
     removals against 1,009 budget deferrals; 17 ticks were killed at the helper's
     60-second deadline, 6 died on a parse error and 5 never started (§3.6, §3.7).
     Before the deploy one report read 32 roots checked, 3 removed (5.4 GB), 16 held and 13
     errors against 588 GB measured [O, task history, 11-04 19:27Z], while about 55 GB/day
     arrived [O].
  2. Lanes that can never finish [O]: 751 of 3,169 completed or closed lanes have an attempt
     without `completedAt`; the retention treats them as live forever (§3.1). 194 roots of
     such lanes are on disk, at least 43.6 GB by recorded size.
  3. Recorded-check holds [O]: C13.
  4. Trees the sweep cannot remove [O]: read-only directories (Go module cache, a
     dependency cache's `node_modules`), and directories written by containers under other
     user ids (database and browser data) (§3.2, §3.3).
  5. Git pointers to the main repository [O] (§3.4).

### C2. Scratch roots of agents launched outside lanes, and of seats

- **Creator [O].** The same code with an owner whose `pipelineId` is null
  (`tempOwnerForConversation`, `structuredSpawn.ts:274-278`).
- **Lifetime [O].** Authority answers `orphan` (`attemptTempProduction.ts:17`); the sweep
  removes an orphan root one day after **creation** (`attemptTempRetention.ts:413-414`,
  `maxAgeMs` one day at `attemptTempProduction.ts:91`) when no process, socket, checkout
  link or container mount references it. A live host keeps it through its `TMPDIR`
  environment (`tempSweep.ts:80`).
- **Measured [O].** At 12:04Z: 183 roots, 15.7 GB (7 live agents 3.6 GB; 174 finished
  12.1 GB: 82 younger than 1 day, 48 of 1–2 days, 44 of 2–7 days, none older); seat
  conversations 110 roots, 1.1 GB.
- **Ledger and code disagree [O].** The scratch-owners measurement says these roots get no
  seven-day lane clock. The code gives them a one-day clock from creation instead, and no
  finished agent root older than seven days was found. This class does not pile up.

### C3. Lane worktrees in this repository

- **Creator [O].** Each lane gets a sibling checkout `<repo>-pipeline-<id>` (`store.ts:2564`)
  added with `git worktree add` (`git.ts:248`, `:414-430`); it carries its own
  `node_modules` (about 1.1 GB per path, mostly shared blocks).
- **Supposed remover [O].** The hourly worktree sweep (`worktreeSweep.ts`): one hour after a
  lane whose commits a remote advertises settles, four days for other finished lanes
  (`:160-165`). A clean checkout with proven commits goes with `git worktree remove`; a
  dirty one, one with kept ignored files, or one whose commits are not proven elsewhere is
  first backed up into a ref and the lane's evidence folder, verified, and removed with
  `--force` (`:1316-1386`; both paths in §4.1).
- **Why it stayed [O, worktree sweep report 14:03Z, all registered repositories].** 100
  worktrees kept as `ignored-files` (1.6 GB; 65 of them in this repository), in 70 of them
  because of `.artifacts/`; 79 of the 100 are
  younger than four days (expected), 21 are older. 45 kept as `uncommitted` because the
  backup refused: 28 with "unknown ignored file", 14 with "nested repository requires its
  own preservation". 52 `deferred` (the sweep's own time budget). 57 `open-pipeline`, 45 `in-use`.
  Passes 1, 4, 5 and 11 removed 123 such worktrees by hand.

### C4. Worktrees in other projects' repositories

- **Creator [O].** Two kinds. Lane worktrees of other projects use the same code as C3:
  307 of the 397 extra worktrees listed on 11-11 have the `<repo>-pipeline-<id>` layout. The
  other 90 were made by agents themselves: 25 under a `worktrees/` folder of the repository,
  56 in ad hoc places (merge validations, release checks, merge trains under a private data
  folder or `/var/tmp`), and 9 registered in another project's repository but located
  inside a Delegatus stage scratch root (a test that adds worktrees under `TMPDIR`).
- **Supposed remover [O].** The worktree sweep for lane worktrees; nothing for the rest:
  a worktree without a creation record is kept as `not-created-by-delegatus` unless
  `LLV_WORKTREE_SWEEP_FOREIGN=1` (`worktreeSweep.ts:49-58`, `:65-66`).
- **Why it stayed [O].** Sweep report at 14:03Z, other projects: `recent-writes` 48 lane
  worktrees (10.7 GB), `uncommitted` 44 (8.6 GB), `retention` 54, `not-created-by-delegatus`
  116 rows (5.3 GB). The stale-worktree measurement found 41 clean worktrees idle more than
  30 days and 7 holding 13 commits that exist nowhere else (they stay). When a stage
  scratch root is removed, a worktree registered inside it becomes a stale registration in
  the other repository [O: 14 of the 21 undetermined positions were already gone, one of
  them inside a removed scratch root].

### C5. Dependency folders inside worktrees

- **Creator [O].** `uv sync`, `bun install` and similar, run by stages and agents in each
  checkout; in a monorepo they sit below the top level (`apps/<name>/.venv`,
  `apps/<name>/node_modules`).
- **Measured [O].** 174 folders, 102.3 GB per path, 25.9 GB unique blocks (most files are
  hardlinks into the package manager cache). Pass 17 removed 160 of them (99.4 GB per path);
  classified by where each removed path sat (its ledger rows, and `git rev-parse` on the
  surviving parent directory, read-only):

  | Subtype | Folders | GB per path | Owner today |
  |---|---|---|---|
  | D1 inside lane worktrees of other projects (`<repo>-pipeline-<id>`) | 96 | 69.7 | worktree sweep |
  | D2 inside agent-made worktrees under a repository's `worktrees/` folder | 12 | 10.9 | none (C4) |
  | D3 ignored paths of a repository's primary checkout | 12 | 8.6 | none: a person's working copy |
  | D4 outside any Git checkout: agent-made one-off folders under the projects folder, a home data folder and a deploy folder (checkout copies without `.git`, downloaded toolchains, virtual environments), and tool environments in the home cache folder | 40 | 10.2 | none (C11) |

  The 13 dependency folders inside stage scratch were excluded from the pass and left to C1.
  The package manager and model caches the folders hardlink into were not removed by any pass
  (§10).
- **Supposed remover [O].** For D1 only: the worktree sweep trims rebuildable ignored folders
  of a settled lane worktree it keeps (`worktreeSweep.ts:1600-1660`). Nothing for D2 to D4.
- **Why it stayed [O].** D1: the trim lists only the worktree's top-level children
  (`fs.readdirSync(worktree)` at `worktreeSweep.ts:1634`), so a `.venv` below the top level (`<group>/<service>/.venv`) is never a
  candidate. D2: the trim takes only sibling lane worktrees with an owner (`:1607-1612`), never
  agent-made ones. D3 and D4: no code looks at them. The last sweep trimmed 0 bytes.

### C6. Automatic copies of check evidence

- **Creator [O].** Before an early retirement, `preserveAttemptEvidence` copies media and
  `.artifacts` out of the root into `statePath("evidence","attempt-temp",<hash>)`
  (`attemptTempEvidence.ts:14-120`, called at `attemptTempRetention.ts:423`).
- **Lifetime [O].** Since #3845 a copy of a lane root expires with the lane
  (`attemptTempRetention.ts:427`, `:446-449`); an agent copy seven days after creation.
  Older copies are adopted page by page; a copy whose manifest names no lane is registered
  as `unattributed` with no expiry (`attemptEvidenceCopies.ts:47-77`).
- **Measured [O].** 49.4 GB at 12:02Z; unattributed copies counted 26.9 GB at 11:42Z and
  39.1 GB at 14:24Z (the count rises as adoption reads more of the existing backlog). Pass 12 removed 136 copies
  (17.2 GB); 3 were recreated at once because their roots still existed (correct behaviour).
- **Why it stayed [O].** Unattributed copies are kept by rule; lane copies of lanes that
  cannot finish (§3.1) never expire; the copy sweep's checkout-link inventory exceeds its
  10-second budget under load ("copy retained … inventory exceeded its tick budget", journal
  11:56Z–12:41Z).

### C7. Other evidence

- **Creator [O].** Each spawn creates `statePath("evidence",<lane>)` or
  `statePath("evidence","agents",<hash>)` and hands it to the agent as `LLV_EVIDENCE_DIR`
  (`structuredSpawn.ts:204-208`); recorded checks copy their outputs into
  `evidence/recorded-checks/<lane>/<run>` (`recordedChecks/service.ts:309`); the worktree
  sweep backs up a worktree's ignored files into `evidence/<lane>/worktree`
  (`worktreeBackup.ts:94`).
- **Measured [O].** At 12:02Z: agents' folders 12.5 GB, recorded-check evidence 9.9 GB,
  per-lane folders up to 6.7 GB each; 58.6 GB of evidence outside the automatic copies.
- **Two different kinds in one folder [O].** The worktree backup is a **preservation record**,
  unlike the rest of the evidence: untracked files go into a backup commit through a
  temporary index (`worktreeBackup.ts:89`) kept under `refs/delegatus/worktree-backup/…`
  (`:151`), but `git add` respects ignore rules, so ignored files (`.artifacts`, media) are
  copied one by one into `evidence/<lane>/worktree` (`:94`, `:158-175`) with a manifest
  `worktree-backup.json` (`:176`). After the checkout is removed, that copy is the only one.
  Screenshots, frames and check outputs are by-products the lane already reported on.
- **Why it stayed [O].** No code removes these folders. The design of 2026-11-04
  (`docs/design/disk-retention-fix.md` §4) states "never deleted", and the seven-day design
  (`docs/design/scratch-and-evidence-retention.md` §13) deferred them.

### C8. Archives and backup refs made by the cleanup passes

- **Creator [O].** The passes themselves, following the rule to back up before a destructive
  step: compressed archives of removed roots (21.3 GB and 33.4 GB), a 25.1 GB evidence
  backup (pass 10), 11.1 GB of preserved files (pass 11), 4.7 GB of full-tree backups
  (pass 18); Git refs under `refs/backup/`: 25,198 from pass 16, 788 from pass 14, 96 from
  pass 11, about 87 from pass 1. The product adds a few itself
  (`refs/backup/provision-unpublished/…`, `git.ts:352`: 7 refs).
- **Measured [O].** The evidence folder outside the state directory holds 49.1 GB now; the
  repository has 26,203 refs under `refs/backup/` and a 1.43 GiB pack.
- **Why it stayed [O].** Nothing owns them and no ledger gives them an end date.
- **Backup refs hold commits found nowhere else in the repository [O].** Pass 14 stored commits
  reachable from no other ref. Pass 16 found 236 standalone repositories inside the 13 roots it
  removed; before its backup step, 13,241 distinct commits of 230 of them were absent from every
  ref of the main repository (its inspection computed the backup set as each clone's commits
  minus `rev-list --all` of the main repository), and 206 of those repositories had no
  remote-tracking refs at all. The pass fetched those commits into 25,195 refs under
  `refs/backup/` (plus 3 refs for registered worktree heads) before removal. Whether any of
  them was real work or a test fixture is unknown [I]; the refs are now their only copy on this
  machine, so they must never expire automatically.

### C9. Built releases

- **Creator [O].** Self-update installs one release directory per deployed revision.
- **Measured [O].** 76.4 GB on 10-30; 34.5 GB in 47 directories on 11-11 (51.5 GB summed per
  directory: shared blocks); 51 directories at 14:28Z.
- **Supposed remover [O].** `retainReleases` keeps the active, rollback and three newest
  releases and anything a process uses (`selfUpdate/retention.ts`).
- **Why it stayed [O].** The release report at 14:28Z kept 44 of 51 releases with
  `process-unreadable:1:ns/mnt:EACCES`, removed 0. The scan walks every process
  (`retentionInspection.ts:55-125`); a process it cannot read is recorded as uncertain for the
  whole releases root (`:119`), and an uncertain release is kept (`retention.ts:282-283`). PID 1
  (the system's init, run by root) cannot be read, so every release is uncertain. This is
  deliberate: a process of another user, or one behind a private ancestor directory, can hold a
  descriptor it inherited before its credentials changed (`retentionInspection.ts:38-40`), and
  a root process can use a release through a descriptor or working directory without naming it
  on its command line. The only resolver asks `sudo -n` to run the release's own observer
  script (`src/lib/retention.worker.ts:25`), which this machine does not grant; granting it as
  is would let the user run a script it can edit as root. Separately, at
  14:35Z 17 old releases were the working directory of live processes, mostly the shell
  stderr drains of Codex hosts (`sh`, `dd`, `tee`, `wc`), which inherit the spawner's working
  directory (`codexSocketTransport.ts:95`, no `cwd` given) and live as long as the host.
- **Reported wrongly [O].** Kept rows carry `bytes: 0` (`retention.ts:283`), so the card's
  "Збережені релізи" row reads about zero while tens of GB are kept.

### C10. Diagnostic captures and recovery folders

- **Creator [O].** Agents during investigations, as folders they name themselves under the
  user's state, data and cache directories and the projects folder; no product code writes
  these folders (search of `src`, `scripts`, `bin` for the names the ledger lists).
- **Measured [O].** One capture of 10-30: 69.3 GB; recovery folders of 10-25 to 10-30:
  19.2 GB. Pass 14 removed them after a person's decision.
- **Why it stayed [O].** Nothing owns them. [I] Agents put them there because stage scratch
  is removed when the stage settles and the evidence folder is described as the place for
  media only, so an investigation that must outlive its stage has no product place.

### C11. One-off scratch outside the state directory

- **Creator [O].** Agents and seats: merge-train scratch and review exports under `/var/tmp`,
  migration and verification copies, checkpoints, a performance-release cache and an
  incident folder under the home directory.
- **Measured [O].** 111 directories, 58.9 GB under `/var/tmp` on 10-29; `/var/tmp` grew by at
  least 60 GB between 10-30 and 11-02; 30.5 GB of finished one-offs on 11-11.
- **Why it stayed [O].** The temp sweep removes only names starting with `llv-`
  (`tempSweep.ts:82-87`, `tempDirs.ts:28`); other names are "never deleted" by design
  (`disk-retention-fix.md` §4).

### C12. Host event journals

- **Creator [O].** One JSONL ledger per session under `statePath("structured-host-events")`,
  written by `FileRuntimeEventStore` (`eventStore.ts`).
- **Measured [O].** 23.9 GB (10-30), 26.4 GB (11-02), 34.1 GB (11-11 00:20Z), 35.2 GB
  (11-11 12:02Z): about 1 GB per day. At least 9,788 ledgers (17.1 GB) were older than 14 days on 11-11.
- **Why it stayed [O].** No code removes or compacts a ledger (search of `eventStore.ts` and
  `src`; the only truncation repairs a torn tail, `eventStore.ts:661`).

### C13. Recorded-check holds

- **Creator [O].** Writing a recorded check inserts each of its roots with `held=1`
  (`recordedChecks/store.ts:243`); acknowledgement clears it (`:244-245`).
- **Supposed remover [O].** The retention acknowledges the hold when the lane expires
  (`store.ts:368-387`, called from `attemptTempRetention.ts:335-355`).
- **Measured [O].** 68 roots, 98.3 GB held at passes 10 and 11. At 14:45Z: 100 held
  directories; 88 belong to finished lanes with an attempt that has no `completedAt`
  (48 still on disk), 10 to finished lanes with valid clocks (7 on disk: 2 fail on EACCES
  before acknowledgement, 5 small config sandboxes that came due today), 2 to open lanes.
- **Why it stayed [O].** §3.1 and §3.2. Pass 12 removed held roots by hand and left 81 hold
  rows for 59 of them. At 14:45Z, 43 held directories no longer exist; an absent root keeps
  its ledger row while a hold remains (`attemptTempRetention.ts:535-539`), so every pass
  visits it again.

### C14. Container images, build cache, containers, volumes

- **Creator [O].** Stages and agents of other projects building and running containers;
  release images per deploy and test images per check.
- **Measured [O].** 140 image records, 52.9 GB; build cache 10.3 GB (258 entries); 51 volumes
  11.0 GB (11-11). Pass 3 removed 669 stopped containers and 2,816 anonymous volumes; pass 17
  pruned 65 unused images older than 14 days.
- **Why it stayed [O].** No product code prunes containers, images, cache or volumes (search
  of `src`, `scripts`, `bin` for prune commands: none).

### C15. Keep-marked roots

- **Creator [O].** Whoever writes `.delegatus-keep` into a root. The five present markers carry
  texts such as "retain until continuation results are consumed" or an empty file;
  [I] they read as agent-written, one at a person's request.
- **Lifetime [O].** None, by design: a keep marker holds forever because its author cannot be
  proven (`scratch-and-evidence-retention.md` §4.3; `attemptTempFilesystem.ts:477-480`,
  `tempSweep.ts` `pinned`).
- **Why it matters [O].** 13.5 GB in five roots, and the card shows none of them.

### C16. The product's own state backups

- **Creator [O].** The Viewer release that owns traffic arms a one-minute timer
  (`startStateDurability`, `state/durability.ts:1330`); each due pass runs in the backup worker
  (`:1148`) as `runBackupPass` (`:1056-1101`), which copies each database through
  `backupDatabase` (`:833`) into `backups/sqlite` of the state directory (`BACKUP_DIRECTORY`,
  `:46`). Three databases are backed up: `state.sqlite` and `agent-registry.sqlite` hourly when
  changed, `mcp-receipts.sqlite` daily (`:88-107`); `handoff-queue.sqlite` has no backup (`:115`).
- **Growth [O].** 14.7 GB at 02:10Z (rest-of-volume measurement), 15.0 GB at 12:06Z (scratch-owners
  measurement), 15.1 GB at 16:11Z (a read-only listing for this correction). At 16:11Z the folder
  held nine files, three per database: about 2.1 GB each of the registry and the receipts
  database, about 0.95 GB each of the state database; the live databases measured 2.2, 2.1 and
  1.0 GB. The three daily receipts backups grew from 1.90 to 2.06 GB between 11-08 and 11-10. The
  class therefore grows with the databases themselves, about three times their size, and no
  manual pass removed it. The oldest time the scratch-owners measurement saw (10-26) is the
  modification time of the folder itself and of an 8 KB engine-memory import folder beside
  `sqlite`, not of a backup.
- **Owner and retention [O].** `pruneBackups` (`durability.ts:910-943`) runs after every pass.
  It applies each database's retention: the newest three for the receipts database; for the
  two hourly stores the newest three, up to six four-hourly within a day and up to three daily
  within four days (`retained`, `:946-970`). Then it evicts the oldest generations until the total
  is within `BACKUP_BUDGET_BYTES`, 2 GiB (`:48`), but never one of the three newest of a database
  (`PROTECTED_GENERATIONS`, `:50`; `evictable: index >= PROTECTED_GENERATIONS`, `:933`).
- **Why it stays [O].** The protected floor alone is about 15 GB, far over the 2 GiB budget, so the
  budget evicts every generation it may and the folder settles at exactly three generations per
  database, as the listing shows. This is the rule working as written: the backups are the
  recovery copies of the product's own databases. The disk card has no row for them
  (`diskPressure.ts` has no backup category). This document proposes no new lifetime for them;
  [I] the budget constant predates databases of this size (the comment at `:51-53` measured the two
  large stores at 2.85 GB together), which a person may want to revisit, but nothing in the passes
  depended on it.

### Also measured large: history and caches with their own owners

Account stores (50.6 GB: provider histories and sessions), the transcript and registry
databases (2–2.4 GB each) and the scanner's response results (7.7 GB) were measured but are
history or caches with their own owners; this document proposes nothing for them (§10).

## 3. The known failures of the seven-day retention

### 3.1 Attempts with no completion time (case a) — cause confirmed

- **Rule [O].** `laneFinish` answers "not finished" when any attempt lacks a parseable
  `completedAt` (`laneFinish.ts:30-31`), and `attemptTempAuthority` maps "not finished" to
  `live` (`attemptTempProduction.ts:25`). The seven-day design chose this on purpose: an unknown
  clock preserves the data (`scratch-and-evidence-retention.md` §4.2, rule 6).
- **Producer [O].** `parkPipelineState` sets `needs_decision` without stamping `completedAt`
  (`engine.ts:3305`); close settles only `pending` attempts proven never started
  (`closeAttempts.ts:31-39`). The six lanes behind the stuck roots of the 12:06Z measurement
  each have one or two `needs_decision` attempts without `completedAt` [O, state rows].
- **Scale [O].** 751 of 3,169 completed or closed lanes; the attempts without a clock are
  732 `needs_decision`, 177 `pending`, 25 `running`, 6 `spawning`, 4 `committing`.
- **Consequence [O].** The roots, their lane copies and their recorded-check holds never
  expire. The product reports them as "held live" ("live lane or checkout dependency"); the
  wording "attempt completedAt missing/invalid" in the task is the verifier's own label; the
  product never prints it.

### 3.2 A directory without write permission (case b) — cause confirmed

- **Own read-only trees [O].** A Go module cache (directories mode 0555) and a dependency
  cache's `node_modules` (0555) are owned by the same user but not writable. `fs.rm` fails
  with EACCES (`removeAttemptTree`, `attemptTempFilesystem.ts:634-648`); the sweep then
  tries a container namespace with a 12-second `timeout` (`:557`) and a locally installed
  utility image. The journal shows these container removals failing
  (11:50Z–12:12Z). Two of the four trash roots present at 14:35Z contain such 0555
  directories and no foreign files [O, probe].
- **Foreign trees [O].** Containers that ran as other user ids left 0700 directories (database
  data, browser profiles, test locks) inside roots. For an expired root, the protection
  snapshot reads every directory with `opendirSync` (`attemptTempFilesystem.ts:611`) before
  removal and throws EACCES, so the container path is never reached: the 14:24Z report shows
  one such root `failed` with "EACCES: permission denied, scandir"; two held roots fail the
  same way before their hold can be acknowledged.
- **Unknown [I].** The exit status of the failing container removals: the failure text is cut
  at 1,024 characters (`attemptTempRetention.ts:518`) and the command line printed first is
  longer, so `code=` and `stderr=` never reach the log. **Check:** run `removeAttemptTree` on a
  fixture tree with a 0555 module-cache directory in an isolated state directory with a
  utility image present, and read the full error; or read a non-truncated `outcomes[].reason`
  in the attempt-temp report when such a root is on a page.

### 3.3 Roots renamed to trash and never finished (case c) — cause confirmed for one root, inferred for the other

- **Mechanism [O].** Removal writes a journal, renames the root to `.delegatus-trash-…`, then
  deletes (`tempSweep.ts:410-446`). If the delete fails (§3.2) or the helper is killed (§3.6),
  trash and journal stay; only the attempt sweep can finish them, because the journal is
  `disposable` and the hourly temp sweep never passes `allowDisposable`
  (`tempSweep.ts:450`, `:676`), and the attempt sweep visits only roots that still have a
  ledger row (`attemptTempRetention.ts:281`).
- **One root [O].** Its original had **no ledger row** at 14:45Z, so nothing would ever
  revisit its journal. Why the row disappeared is not established [I]; `forget` runs only
  after completion or when no journal exists (`attemptTempRetention.ts:530`, `:535-539`).
- **The other root [I].** Its ledger row exists (recorded size 11.1 GB, measured 6.4 GB) with
  no recorded failure. The journal shows "refused attempt quarantine identity changed"
  retentions (13:02Z), thrown by `restoreRefusedAttemptTrash` (`retirementClaim.ts:34`) when the
  original path exists again or the trash identity changed; this is the likely reason.
  **Check:** keep the reason per root (W7) and read it on the next occurrence; the root itself
  was removed by pass 16.

### 3.4 A nested worktree pointer (case d) — cause confirmed

- **Producer [O].** `scripts/merge-batch.ts:564-567` makes `merge-batch-*` under the batch
  state's directory (a stage `TMPDIR`) and adds a worktree registered in the main repository;
  in another stage a tool copied a lane checkout with its `.git` file, so the copy points at
  the lane's registration in the main repository.
- **Rule [O].** A `.git` file pointing outside the root holds it (`markerHolds`,
  `attemptTempFilesystem.ts:477-490`), and the seven-day design keeps that hold after expiry
  ("outside commits and worktree registrations are never touched", §4.3). Nothing removes
  the registration, so the root stays. Pass 16 removed four such registrations with
  `git worktree remove` after checking that their commits were reachable.

### 3.5 Roots with no reason found (case e) — no fence; queue latency

- **Observed [O].** Both roots belonged to a lane whose expiry fell at 03:36Z on 11-11. The
  retention removed one of them at 12:17:49Z (a receipt of exactly its size), 8.7 hours after
  expiry, during pass 15; pass 16 removed the other by hand. Their empty `.git` files are
  package-cache markers the code explicitly allows (`attemptTempFilesystem.ts:482`).
- **Cause [I].** Due roots wait behind budget deferrals and killed ticks (§3.6, §3.7).

### 3.6 Tick overruns and the queue deadline — cause confirmed

- **Observed [O].** 17 "attempt temp tick exceeded 60000 ms" and 5 "helper queue exceeded
  60000 ms" between 11:17Z and 14:32Z.
- **Code [O].** The parent sets one 60-second deadline per request **before** the request waits
  behind other sweeps in the same helper (`worktreeSweepWorker.ts:15`, `:128`, `:131-152`), and
  does not pass the remaining time to the helper. Inside, the roots get a 40-second budget and
  copies plus reporting 10 seconds (`attemptTempRetention.ts:250`, `attemptEvidenceCopies.ts`
  `deadline = now()+10000`), but single steps carry their own fixed bounds that are not clipped
  to what remains: every command 15 seconds (`attemptTempFilesystem.ts:11`), evidence
  preservation 30 seconds (`attemptTempEvidence.ts:16`), the checkout-link inventory up to 30
  seconds, a container command 12 seconds plus start-up. A step that starts at second 39 can end
  at second 69. On overrun the parent kills the helper (`worktreeSweepWorker.ts:152`), which can
  leave half-finished trash (§3.3) and a state lease that the next owner must take over.

### 3.7 The parse error in the sweep — mechanism confirmed in code, trigger inferred from the journal

- **Observed [O].** Six "tick failed JSON Parse error: Unexpected identifier "state"" between
  11:57Z and 13:40Z.
- **Code [O].** The helper answers on stdout, one JSON line per request, and the parent parses
  each line (`worktreeSweepWorker.ts:66`); the helper's stderr is inherited by the service
  (`:54`). The helper redirects only `console.log` to stderr (`worktreeSweep.worker.ts:11`).
  Bun writes `console.info` to stdout [O: probe with the installed Bun 1.4.0].
  `JSON.parse("[state lease] …")` fails with exactly this message; the parent then fails the
  request and kills the helper. Other helpers already redirect `console.info`
  (`filesResponse.worker.ts:28`, `board/store.sqliteChild.ts:7`, `accountRemoval.worker.ts:8`).
- **The line's producer [O].** `console.info("[state lease] cleared abandoned …")` sits in
  `forgetAbandoned` (`sqliteStateStore.ts:98`), which runs only for a lease recorded in the
  **current process's** in-memory abandoned map (`:84-87`). That map is filled when this
  process's own lease release fails (`releaseLeaseSync` → `abandonLease`, `:3721-3724`,
  `:134-146`, with a `console.warn` on stderr); a retry timer 250 ms later deletes the lease and
  prints the info line (`:113-130`), as does a later takeover by the same process (`:3683-3685`).
  A new helper starts with an empty map, so taking over the lease of a killed helper prints
  nothing on stdout.
- **What the journal shows [O].** Each of the six parse errors is preceded, 0 to 1 second
  earlier, by "[state lease] abandoned pipelines" (once also `pipelines_archive`) with "state
  admission is busy at state.lease.release", and no matching "cleared abandoned" line for that
  collection reaches the journal, while the Viewer's own "cleared" lines do. Both helper and
  Viewer write to the same inherited stream, so the journal names one process id for both.
- **Cause [I, strongly supported].** Under write contention the helper's release of the
  `pipelines` lease fails as busy, the retry succeeds a quarter of a second later and prints
  the info line into the reply channel. Recovery after a killed helper cannot produce the
  line (above). **Check:** the W1 test reproduces it in the real helper.

### 3.8 Stale recorded sizes behind the forecast — cause confirmed

- **Code [O].** The forecast sums `roots.bytes` of roots that have an expiry
  (`attemptRetentionReporting.ts:41-45`, `:105-110`). An expiry is written only when the sweep
  visits a root and reaches its authority (`attemptTempRetention.ts:343`, `:445`); a root that is
  held as live (§3.1), fails earlier, waits in the queue or is pinned (`:418` writes `null`)
  contributes nothing. `allocatedAttemptBytes` runs `du`; when `du` exits non-zero (any
  unreadable subdirectory) or exceeds 15 seconds, and the container measurement also fails, it
  returns the root directory's own 4,096 bytes (`attemptTempFilesystem.ts:650-662`).
- **Observed [O].** One open-lane root whose walk measured at least 38.9 GB, with permission
  refusals and a timeout, had recorded bytes 4,096 [I: the fallback above]; the forecast at
  12:06Z said 0.88 GB due and 14.2 GB upcoming while closed-lane roots younger than seven days
  held 165.7 GB.
- **Consequence.** The forecast is a lower bound and the card does not say so.

### 3.9 Keep markers (case g) — correct to keep, unreported

[O] Five roots, 13.5 GB; the hold is by design (§2 C15); the card shows neither the roots nor
their texts.

### 3.10 Recorded-check holds of long-finished checks (case f) — cause confirmed

[O] 88 of 100 held directories are explained by §3.1, two by §3.2; see C13.

## 4. Classes with no automatic lifetime, and proposed lifetimes

### 4.1 What must never be removed automatically, and how the sweep proves it

| Never removed | Proof the sweep already uses or must use before removal |
|---|---|
| Commits that exist only on this machine | A lane worktree leaves by one of two paths in `worktreeSweep.ts` [O]. **(a) Removal after an external proof** (`:1386-1595`): every commit of HEAD is in a merged pull request's head or in a ref a remote advertises now (`git ls-remote`); the checkout is then removed with `git worktree remove` without force (`:1588`). **(b) Removal after a verified backup** (`retireBackedUp`, `:1316-1386`): it runs for a finished lane whose checkout is dirty or holds kept ignored files, and also, with `force`, when proof (a) fails as `local-only-commits`, `unmerged-commits` or `pr-head-unknown` (`:1481-1482`). There the commits stay reachable because the backup commit has HEAD as its parent and is kept under `refs/delegatus/worktree-backup/<lane>/<commit>` (`worktreeBackup.ts:148-156`); no remote proof is asked for, and the checkout is removed with `git worktree remove --force` (`:1375`). A lane that is not finished, or whose owners changed, is kept (`local-only-commits` and the other reasons). Backup refs are never removed by any sweep. **Gap today [O]:** a standalone repository (a `.git` directory) inside a scratch root is not a marker (`attemptTempFilesystem.ts:474-475` matches only `.git` entries that are not directories), so a root holding a clone with its only copy of a commit, or with uncommitted changes, is retired with no check; pass 16 found 13,241 such commits (§2 C8). Proposed proof (W14): every commit of every ref and HEAD is reachable from the lane repository's refs or from refs its remote advertises now, and the working tree and index are clean; otherwise the repository is preserved first (refs, working tree content and index, see row 2 and W14), or the root is held with a named reason. The proof is repeated at the deletion boundary. |
| Unsaved changes | Path (b) of row 1 [O]: `git status --porcelain=v1 -z --untracked-files=all --ignored=matching` is read before the backup (`worktreeSweep.ts:1321`). `backupWorktree` saves the index as it is (a commit of the tree written from a copy of the index file, `worktreeBackup.ts:143-148`) and the working tree (`read-tree HEAD`, `add -A`, `write-tree` through a temporary index, `:87-93`), so tracked edits, staged-only versions and untracked files are kept in the backup commit; ignored evidence files are copied into the lane's evidence folder and hashed (`:158-175`). An unknown ignored file, a nested repository or a link refuses the backup and keeps the worktree (`uncommitted`). Before removal `backup.verify()` (`:179-200`) rebuilds the working-tree tree through a fresh temporary index and compares its id with the saved one, compares the index file byte for byte with the saved copy, re-hashes every copied file and checks the backup ref, the root's `dev:ino` and the ignored inventory; the sweep then compares a fresh `git status` with the first (`worktreeSweep.ts:1371-1373`). An in-place edit of an already modified file, or a staged-only change, therefore keeps the checkout (existing test `an index edit after backup retains the checkout`, `worktreeSweep.test.ts:4002`; the in-place working-file edit has no test today, W10 adds it). Git's own dirty check does **not** run on this path, because removal is `--force`; [I] after `verify` only synchronous checks run before the `git worktree remove --force` call, so the remaining window is that call itself, and a writer in it is caught only if the guard's process scan just before it saw the writer holding the checkout open. Path (a) has no backup: it keeps any checkout whose status shows a change (`worktreeSweep.ts:1421-1436`, read again at `:1525-1538`; only a resumed deletion-only removal passes), and `git worktree remove` without force refuses a checkout that became dirty after the last read (`:1586-1588`). The copies and the backup commit are **preservation records**: no evidence lifetime may remove them (§4.2). |
| Data of a running lane | `laneFinish` and the authority read again at dispatch with a revision check; a live process's cwd, open files, maps and `TMPDIR`-like environment; Unix sockets; container mounts; symlinks from live checkouts (`attemptTempRetention.ts:362-490`). |
| Anything under a person's keep marker | Any `.delegatus-keep` in the tree holds the whole root or worktree; a protection snapshot is checked again at dispatch. |

Every new removal path in §6 must use the same identity (`dev:ino`), journal-then-rename and
re-check-at-dispatch pattern, and bounded work per tick.

### 4.2 Classes with no automatic lifetime today

| Class | Today | Proposed lifetime | Proposed owner | Decision for a person? |
|---|---|---|---|---|
| Lanes whose attempts lack `completedAt` (C1, C6, C13) | never expire (bug) | the lane's normal seven days, with `closedAt` as the clock of terminal attempts once close teardown has settled | `laneFinish.ts` | no: this restores the rule already decided |
| Expendable evidence: per-lane and per-agent evidence folders and recorded-check evidence, **excluding** preservation records (C7) | never deleted (decision of 2026-11-04) | 30 days after the lane finished; for an agent, 30 days after its host ended | the attempt-temp sweep's copy path, as rows in the existing `copies` ledger | **yes**: it reverses an earlier "never deleted" |
| Preservation records: worktree backups (`evidence/<lane>/worktree`, `worktree-backup.json`, `refs/delegatus/worktree-backup/…`), the bundles of W14, backup refs (C7, C8) | never deleted | none: they hold the only copy of ignored files, untracked files or commits. Removal only by a person, per record, after the card shows it; or automatically only once a verified copy of each file or commit exists elsewhere (another remote, a merged head) | card (W11) | **yes**, per record |
| Unattributed legacy evidence copies (C6) | kept forever | attribute by `launchId` through the registry's spawn receipts; the rest expire 30 days after adoption | copy sweep | **yes** |
| Host event journals (C12) | no pruning | remove a session's ledger 30 days after its last event when the session is not live and its transcript exists | a new bounded page in the attempt-temp tick | **yes**: month-old sessions lose exact replay |
| Container build cache and unused images (C14) | no pruning | the operator's rule of 11-11: build cache and images without containers older than 14 days, daily, with Docker's own `builder prune --filter until=336h` and `image prune -a --filter until=336h`; volumes never | a daily product job | stopped containers and anonymous volumes: **yes** |
| Agent-made worktrees in other repositories (C4) | kept as `not-created-by-delegatus` | the operator's rule of 11-11: clean, no local-only commits, idle more than 30 days, removed with `git worktree remove` | worktree sweep, per project opt-in | **yes**: per project |
| Dependency folders D1, in lane worktrees (C5) | not trimmed below the top level | trimmed with the lane's existing four-day rule | worktree sweep | no |
| Dependency folders D2, in agent-made worktrees (C5) | none | go with the worktree under the agent-made worktree rule above; while the worktree is kept, trimmed under the same per-project opt-in once idle more than 30 days | worktree sweep | **yes**: same decision as agent-made worktrees |
| Dependency folders D3, in a repository's primary checkout (C5) | none | none: the primary checkout is a person's working copy and its environment may be the one they run; the product never trims it | — | **yes**: stays manual (recommended) |
| Dependency folders D4, outside any checkout (C5) | none | none for existing folders: the product cannot tell an agent's one-off environment from a tool's installed one [I]; new ones are prevented with the one-off scratch below | — | existing folders: **yes** |
| Standalone repositories inside scratch roots (C1) | removed with the root, unchecked | the root's own lifetime, after the proof of §4.1 row 1 or a verified bundle | attempt-temp sweep | no: this closes a gap in the never-remove rule |
| Releases (C9) | rule exists, never applies here | the existing rule (three newest, active, rollback, in use), once a complete read of every process is possible | release retention, with a root-owned read-only observer | **yes**: whether to install that observer (§7 item 6) |
| Diagnostic captures, recovery folders, one-off home folders (C10, C11) | none | stop creating them: agents write durable work data into `$LLV_EVIDENCE_DIR`, which gets the 30-day lifetime above (operational recommendation R1, §6) | role mechanics text | existing folders: **yes** |
| Cleanup archives and backups (C8) | none | none needed once manual passes stop; existing archives by a person's decision; backup refs never | — | **yes** |
| Keep markers (C15) | forever | still forever; markers made through a product action carry author, reason and an optional end date | card and marker format | agent-written markers: **yes** |

## 5. What the disk card should show

The card already lists categories (`diskPressure.ts:373-383`) and words the attempt row with
`attemptRetentionCategory` (`:185-189`). Proposal: keep this card and its list, change the rows,
add no new control.

1. **Scratch, one row per state with bytes and count:** removed soon (due), removed by a date
   (upcoming), kept because the lane is open, kept because the lane cannot finish (§3.1), kept
   for a check, kept by a keep marker, kept because a standalone repository is unproven (W14),
   kept because the owner of a trash root cannot be recovered (`owner-unknown`, W5),
   cannot be removed (permissions or Git link, with the count), waiting in the queue. Source: a per-root reason column beside `root_retention`,
   summed incrementally like the existing radix buckets so the card reads a bounded number of
   rows.
2. **Lower bound in words.** The forecast says "at least" whenever the backfill is partial, any
   root's size fell back to an unmeasured value (§3.8), or any finished-lane root has no expiry.
   "Scratch поза обліком розміру" stays and becomes the unmeasured part.
3. **Keep markers:** one row "kept by a keep marker: N folders, X; oldest N days"; the marker's
   first line of text is shown where the card already shows a category's detail.
4. **Releases:** real bytes of kept releases and the reason in words (in use, newest, rollback,
   uncertain because a process could not be read completely, with the kind of process and what
   could not be read, never its command line).
5. **Preservation records:** one row with bytes and count for worktree backups, bundles and backup
   refs, worded as the only copy of files or commits, kept until a person decides.
6. **Classes without a lifetime** (until §4.2 is decided): evidence folders, host event journals,
   unattributed copies, container images and cache (from the Docker API), other projects'
   worktrees Delegatus did not create and their dependency folders, unmanaged temp. One row each, so a person sees what is
   kept with no end date.
7. **Failures:** a count per fixed error class (EACCES, container removal, tick overrun, helper
   reply unreadable), never the raw error text.

The card's strings are Ukrainian literals today [O]; the change ships them in English and
Ukrainian, and its rendered evidence goes through the existing board driver in both languages
and both themes.

## 6. Build plan

Workstreams are independent unless a dependency is named, ordered by space saved against risk.
Deletion code takes three review rounds; tests run against isolated state (`HOME`,
`XDG_CONFIG_HOME`, `TMPDIR`, `LLV_STATE_DIR`, a closed control port), never the operator's.
Every change on the retention path keeps bounded work per tick and carries a before/after
measurement of tick duration on the same fixture.

| # | Workstream | Files | Acceptance (test red on `main` today) | Fences | Size |
|---|---|---|---|---|---|
| W1 | Helper reply channel: route `console.info` and `console.debug` to stderr in the sweep helper | `src/lib/worktreeSweep.worker.ts`, `src/lib/pipelines/worktreeSweepWorker.test.ts` | Start the real helper entry on an isolated state with a test preload that arms the state store's existing write-fault hook (`injectWriteFault("release", "pipelines")`, `sqliteStateStore.ts:58-66`) to fail one `pipelines` lease release, and send an `attempt-temp` request through the real parent (`WorktreeSweepWorker`): the parent receives a report and the helper stays alive for a second request. Today: the 250 ms retry prints the "cleared abandoned" line on stdout and the parent fails with "JSON Parse error: Unexpected identifier "state"" and kills the helper. Separate control, green today and after: a helper that takes over the lease of a killed helper prints nothing on stdout. | none open | trivial |
| W2 | One deadline for the whole tick: the parent sends its absolute deadline with the request; every step's bound inside the helper is clipped to what remains minus a reply margin | `src/lib/pipelines/worktreeSweepWorker.ts`, `src/lib/worktreeSweep.worker.ts`, `src/lib/runtime/attemptTempProduction.ts`, `attemptTempRetention.ts`, `attemptTempFilesystem.ts`, `attemptTempEvidence.ts`, `attemptEvidenceCopies.ts` | Real parent (`WorktreeSweepWorker`) and real helper entry on isolated state; no step depends on wall-clock speed. Both read a monotonic clock injected by the test (the parent through a constructor port beside `timeoutMs`, which today reads `Date.now()` and `setTimeout`, `worktreeSweepWorker.ts:128-152`; the helper through a test preload), and the preload stops the helper at named points behind IPC barriers that only the test releases. Request timeout 6 units: a `temp` request parked at a barrier while the test advances both clocks by 3; then an `attempt-temp` request for one due root whose reference check is parked at a second barrier after it has started one child process, while the test advances both clocks by 2.5 and releases the barrier. Today the helper starts its own budgets at receipt, so it does not stop; the test then advances the parent clock to 6 and the parent fails with "attempt temp tick exceeded" and kills the helper (red). After: on the release the helper sees less than the reply margin left and replies before the parent clock reaches 6, with the root `deferred`; the root keeps its `dev:ino`, no trash and no journal exist; the child process is gone (its recorded pid no longer exists, checked explicitly); a following request in the same helper is answered. A real-time limit of minutes on the whole test only ends a hang. | none open | normal |
| W3 | Lanes finish: `closedAt` is the clock of a terminal attempt without `completedAt` in a lane whose close teardown settled; `parkPipelineState` stamps `completedAt` | `src/lib/pipelines/laneFinish.ts`, `laneFinish.test.ts`; `engine.ts:3305` and an engine test | A completed lane with a `needs_decision` attempt lacking `completedAt` and settled activity is finished at `closedAt`; its expired root is retired and its hold acknowledged. Running, spawning and committing attempts still block. Today `{ finished: false }` forever. | `engine.ts` is changed by open #3668, #3710, #3747, #3749, #3801, #3802; none edits `parkPipelineState`; check with `git merge-file` before building | normal |
| W4 | Removable trees: owner-writable repair (`chmod u+rwX` on own entries, no symlinks, one filesystem) before native removal; the protection snapshot and measurement survive EACCES by using the container namespace with a time bound sized to the tree; failure text keeps `code`, `signal`, `stderr` before the command | `attemptTempFilesystem.ts`, `attemptTempDiagnostics.ts`, `attemptTempRetention.ts:518` | An expired fixture root with a 0555 module-cache directory is removed with no container available; a 000 own directory no longer fails the snapshot. Today: trash left behind / "failed EACCES scandir". | none open | normal |
| W5 | Trash whose ledger row is gone: restore the verified binding to its owner, then let the lane's authority decide; never register it as an orphan. [O] Nothing in the leftovers proves the owner: the disposable journal holds only `directory`, `trash`, `uid`, `identity`, a null snapshot and the `disposable` flag (`tempSweep.ts:421-423`), the owner marker names only the ledger file (`attemptTempRetention.ts:86`), and a null `pipelineId` makes the authority answer `orphan` at once, without reading a lane, its revision or its expiry (`attemptTempProduction.ts:17`); re-registering the path as an orphan would therefore delete the tree of an open or resumed lane. A bounded page per tick looks for the binding only in records that name both the journal's original path and its `dev:ino`: an evidence copy manifest (`original`, `identity`, `pipelineId`, `launchId`, `attemptTempEvidence.ts:118-119`) and a recorded-check root row (`recorded_check_roots` directory and identity, its check's `launch` and `owner`, `recordedChecks/store.ts:108-109`, `:120`). Only when the records found agree on one lane and one launch is the row restored, with the journal's identity and `retainUntilClose` set (no record carries the original value); the replay then runs through the normal retention path, which reads the authority again and checks its revision and expiry at dispatch (`isCurrent`, `attemptTempProduction.ts:19-20`; `finishTreeTrash` under `eligible`, `tempSweep.ts:666-677`). A restored root is replayed only when that authority answers `expired`; any other answer keeps the trash and journal with that answer as the reason. No record, disagreeing records, or a binding with a null `pipelineId` (none of these records carries the root's creation time, which the orphan rule needs) keep the trash and journal under the named reason `owner-unknown`, reported per root (W7) and on the card (§5) | `attemptTempRetention.ts` (a recovery page beside the adoption page), `tempSweep.ts`, `attemptTempRetention.test.ts` | Frozen clock, isolated state, an empty process list and no checkout links; scratch holds trash and a disposable journal and `roots` has no row for the original. (1) An evidence manifest binds it to a lane completed more than seven days ago: trash and journal are gone after the sweep (red today: nothing visits the journal). (2) The same lane is open; (3) the lane was completed and is resumed between the restore and dispatch, so its revision changes; (4) no record names the root; (5) two records name different lanes; (6) the only record has a null `pipelineId`: in (2)–(6) the trash, its content and the journal remain, and the outcome names the authority's answer or `owner-unknown`. Cases (2)–(6) are green today and must stay green. | none open | normal |
| W6 | Nested worktree registrations inside scratch: after the worktree sweep's own proofs (clean, every commit advertised by a remote or in a merged head, not locked), remove the registration with `git worktree remove`, then retire the root; `merge-batch` removes its worktrees when it ends | `attemptTempRetention.ts`, `attemptTempFilesystem.ts`, `worktreeSweep.ts` (reuse its proof), `scripts/merge-batch.ts` | Fixture root with a registered clean worktree whose commit a fake remote advertises: registration and root removed; with a local-only commit: both kept with a named reason. Today: held forever. | none open | design first |
| W7 | Sizes and reasons the card can trust: keep `du`'s total on a non-zero exit, never fall back to the root's own blocks, mark the size unmeasured; store one reason per root; report the forecast as a lower bound | `attemptTempFilesystem.ts:650-662`, `attemptTempRetention.ts`, `attemptRetentionReporting.ts` | Fixture root with an unreadable own subdirectory and a 10 MB file: recorded size ≥ 10 MB and `lowerBound: true`. Today 4,096 B and no flag. | none open | normal |
| W8 | Release working directories: start the Codex stderr drain outside the release directory | `src/lib/runtime/codexSocketTransport.ts:95` and its test | A drain started by a host whose working directory is a release fixture has a working directory outside that release (read from `/proc/<pid>/cwd`). Today it inherits the release directory. | none open | trivial |
| W9 | Nested dependency trim in lane worktrees: rebuildable ignored folders down to three levels, never inside a nested repository or `.artifacts` | `src/lib/pipelines/worktreeSweep.ts:1600-1660`, `worktreeSweep.test.ts` | A settled lane worktree with ignored `.venv` and `node_modules` folders below the top level (`group-a/svc/.venv`, `group-b/node_modules`) is trimmed. Today 0 trimmed. | none open | normal |
| W10 | Worktree backup accepts what it refuses today: unknown ignored files and `.artifacts` are copied as preservation records and verified; a nested repository gets the same commit proof as its parent | `src/lib/pipelines/worktreeBackup.ts`, `worktreeSweep.ts` | Finished lane worktree past four days with an unknown ignored file is backed up and removed, and the copy is recorded in `worktree-backup.json` as a preservation record. Today `uncommitted: backup retained checkout: Error: unknown ignored file`. Refusal controls on the same fixture, each with a change made after the backup and before dispatch through the sweep's Git port: an in-place edit of an already modified tracked file (new test), a staged-only change (existing `an index edit after backup retains the checkout`) and an edit of a copied ignored file; each keeps the checkout with its new content and leaves no removal. [I] Green today because `verify` rebuilds the tree and compares the index bytes (`worktreeBackup.ts:179-200`); they must stay green after the accepted files widen. | none open | normal |
| W11 | Disk card per §5 | `src/lib/state/diskPressure.ts`, `selfUpdate/retention.ts` (kept bytes), the card component, en and uk strings | Reporting test: rows per hold reason, lower-bound wording, keep-marker row, real release bytes. Rendered evidence through the existing board driver, both languages and themes. | `src/lib/resources.ts` is in open #3355 (not needed by this plan) | design first |
| W12a | Expendable evidence lifetime (after §7 item 1): lane and agent evidence folders and recorded-check evidence become rows of the `copies` ledger with an expiry 30 days after the lane finished or the agent's host ended; preservation records are never rows | `src/lib/runtime/attemptEvidenceCopies.ts`, `attemptTempRetention.ts` (one bounded adoption page per tick), `attemptTempRetention.test.ts` | Frozen clock, isolated state: a finished lane with a screenshot in its evidence folder and a worktree backup holding the only copy of an ignored file. Run the worktree sweep, then the evidence sweep, then advance 31 days and run both again: the screenshot is gone, the ignored file's copy and `worktree-backup.json` remain and match their hashes; at 29 days both remain; a live agent's folder remains. Today nothing expires. | none open | normal |
| W12b | Attribute legacy copies (after §7 item 2): adoption reads the copy manifest's `launchId` against the registry's spawn receipts; attributed copies expire with their lane, the rest 30 days after adoption | `src/lib/runtime/attemptEvidenceCopies.ts:47-77` and its test | A legacy copy whose `launchId` has a spawn receipt for a lane finished 8 days ago is retired; one without a receipt is retired 30 days after adoption and kept at 29. Today both are `unattributed` forever. | none open | normal |
| W12c | Host event journal lifetime (after §7 item 3): a bounded page of ledgers per tick; a ledger goes 30 days after its last event when its session is not live and its transcript exists | `src/lib/runtime/eventStore.ts`, a new page in the sweep helper, its test | Fixture ledgers: last event 31 days ago, session ended, transcript present → removed; same with a live session, with the transcript missing, or 29 days → kept; a page never visits more than its bound. Today nothing is removed. | none open | normal |
| W12d | Daily container prune (after §7 item 4): `docker builder prune -f --filter until=336h` and `docker image prune -a -f --filter until=336h`, once per day, nothing else | a new module beside `src/lib/tempSweep.ts`, a new request kind in `src/lib/worktreeSweep.worker.ts`, its test | With a recording fake `docker` first on PATH: one day of ticks calls exactly those two commands once; never `container prune`, `volume prune` or `system prune`; a refused or missing Docker is reported as one fixed error class and retried the next day. Today no call is made. | none open | normal |
| W12e | Agent-made worktrees and their dependency folders (after §7 item 5): in an opted-in project, a worktree without a creation record that is clean, has no local-only commits and has been idle more than 30 days is removed with `git worktree remove`; while one is kept, D2 dependency folders in it are trimmed under the same rule | `src/lib/pipelines/worktreeSweep.ts:49-66`, `:1600-1660`, `worktreeSweep.test.ts` | Fixture repository opted in: a clean agent-made worktree idle 31 days whose commits a fake remote advertises is removed; with a local-only commit, a dirty file, 29 days idle, a live process inside it, or in a project not opted in, it stays with a named reason. Today all stay as `not-created-by-delegatus`. | none open | normal |
| W12f | Complete process reads for releases (after §7 item 6): the resolver calls a fixed root-owned read-only observer instead of the release's own script; without it, releases stay kept with a named uncertainty | `src/lib/retention.worker.ts:25`, `src/lib/selfUpdate/retentionInspection.ts`, `retention.ts`, an installation note | A `/proc` fixture with a root process and a process of another user whose `fd`, `maps` and `cwd` are unreadable and whose command line names nothing: the old release is kept as uncertain (green today, stays green). With a recording fake `sudo` that allows only the fixed observer path and the observer reporting a complete scan with no holder: the old release is removed. Today `sudo -n` is asked for the release-specific script, the fake refuses it, and the release stays. In every case the active release, the rollback release and the three newest stay. | none open | design first |
| W14 | Standalone repositories in scratch roots: `.git` directories become markers that need the proof of §4.1 row 1; an unproven repository is preserved first, the way `backupWorktree` preserves a lane worktree (§4.1 row 2): a commit of the index written from a byte copy of the index file, a commit of the working tree written through a temporary index (`read-tree HEAD`, `add -A`, `write-tree`) with the index commit as second parent, both under a ref, then a verified bundle (`git bundle create` of every ref, HEAD and that ref) under a preservation folder; or the root is held as `standalone-repository-unproven`. At the deletion boundary the sweep compares four things with what it saved: the refs and HEAD (`for-each-ref`), the bundle's `list-heads`, the working-tree tree id rebuilt through a fresh temporary index, and the index file's bytes. Refs alone are not enough: an in-place edit of an existing modified file leaves refs, `list-heads`, `git status` and every directory signature of `snapshotAttemptProtection` (`attemptTempFilesystem.ts:601-623`, which reads directory metadata only) unchanged. The comparison runs inside the quarantine's `held(trash)` check, after the journalled rename into trash and before removal (`tempSweep.ts:423-442`; `:820-822` passes the retention's `eligible` as that check), where no path-based writer can reach the tree and a difference renames the root back and holds it; [I] the remaining window from that check to the removal call is covered only by the open-file and working-directory scan of live processes. Ignored files inside such a repository follow the stage scratch contract and are not preserved | `src/lib/runtime/attemptTempFilesystem.ts:474-490`, `attemptTempRetention.ts`, a new module for the proof and bundle, `attemptTempFilesystem.test.ts` | An expired fixture root with a standalone repository holding a commit no other repository has and an uncommitted file: today the root is retired and both are lost. After: a bundle exists, `git bundle verify` passes, and cloning it yields the commit and the file's content; then the root is retired. If the bundle cannot be written, or between the bundle and dispatch the refs change, the content of an already modified file changes without a commit, or only its staged version changes (`git add` of other content, working file restored), the root stays with the reason and the new content is still in the repository (the test reads it back), or the new content is in a newer verified bundle; both cases are red today because no check runs. A repository whose commits are all in the lane repository is retired without a bundle. More repositories or bytes than the per-tick bound defer the root. | none open; builds on W2's deadline | design first |

**Operational recommendation R1 (not a workstream).** Durable work data belongs in an owned place: role mechanics name `$LLV_EVIDENCE_DIR` for anything that must outlive the stage and say never to create folders under the home directory, the projects folder or `/var/tmp`. Files: `src/lib/roles/defaults.ts`, which open #3870, #3805 and #3762 also change. No test can check this (AGENTS.md forbids phrase tests); its effect is measured on the disk card by the C10, C11 and D4 rows not growing.

**Which workstreams would have made the passes unnecessary.** With the seven-day retention of
#3845 (installed 11-11), by class [I: by class; the throughput after W1 and W2 is not yet
measured, §9]:

| Pass | What it removed, by class | Workstreams, or the decision it still needs |
|---|---|---|
| 1, 4, 5 | stage scratch (C1), lane worktrees (C3), merge-train and `/var/tmp` one-offs (C11) | W1–W5, W7; W9, W10; one-offs: R1 and §7 item 8 |
| 2 | stage scratch (C1), `/var/tmp` one-offs (C11) | W1–W5, W7; R1 and §7 item 8 |
| 3 | old evidence and archives (C7, C8), scratch after host stops (C1), stopped containers and volumes (C14) | W12a; W1–W5; containers and volumes stay manual (§7 item 4) |
| 10, 11 | stage scratch of finished lanes (C1), clean worktrees (C3) | W1–W5, W7; W9, W10 |
| 12 | held roots (C1, C13), automatic copies (C6), archives of earlier passes (C8), a review export (C11) | W3, W4; W3 and W12b; §7 item 8; R1 |
| 13, 14 | diagnostic captures, recovery and one-off folders (C10, C11), worktrees registered inside them, backup refs | R1 for new ones; §7 item 8 for existing ones; backup refs stay (§4.2) |
| 15, 16 | stuck roots of lanes closed over seven days (C1): no clock, read-only trees, trash, Git links, standalone repositories | W3, W4, W5, W6, W14 (bundles in place of 25,198 refs) |
| 17 | D1 dependency folders in lane worktrees | W9 |
| 17 | D2 in agent-made worktrees | W12e |
| 17 | D3 in primary checkouts | none: stays manual (§7 item 9) |
| 17 | D4 outside any checkout | R1 for new ones; §7 item 9 for existing ones |
| 17 | unused container images (C14) | W12d |
| 18 | agent-made worktrees in other projects (C4) | W12e |

Together, W1–W7, W9, W10 and W14, plus W12a–W12e once their decisions are taken, cover every
class the passes removed except D3, the existing D4, C10 and C11 folders, the existing archives,
stopped containers and volumes, and keep markers. Those stay a person's call (§7). The archives the
passes made themselves (C8) stop appearing when the passes stop. Releases (W8, W12f) were never
removed by a pass; W12f frees the space pass 12 had to leave, and it needs a person to install
the observer.

**Program acceptance** (the task's own step): one week with no manual pass and free space never
below 400 GiB, read from the disk card and `df` once a day.

## 7. Decisions for a person

1. **Expendable evidence folders** (C7, without preservation records): keep forever (today), or
   remove 30 days after the lane finished. Recommendation: 30 days. Worktree backups, bundles and
   backup refs are outside this choice: they stay until a person removes a listed record (§4.2).
2. **Unattributed legacy copies** (C6, 39 GB discovered so far): attribute what the registry can,
   remove the rest 30 days after adoption, or keep. Recommendation: attribute, then 30 days.
3. **Host event journals** (C12): keep forever, or remove a ledger 30 days after its session's
   last event when the session is not live and its transcript exists. Recommendation: 30 days.
4. **Containers** (C14): extend the 11-11 rule (cache and unused images older than 14 days) to a
   daily automatic job; whether stopped containers and anonymous volumes older than 14 days may
   go too. Recommendation: cache and images yes; containers and volumes stay manual.
5. **Agent-made worktrees in other projects** (C4, with their D2 dependency folders): per
   project, apply the 11-11 rule (clean, no local-only commits, idle more than 30 days)
   automatically. Recommendation: yes, per project.
6. **Releases and processes this account cannot read** (C9): directory permissions and command
   lines do not prove that a process does not use a release (§2 C9), so the only complete read is
   a privileged one. (a) A person installs a fixed, root-owned observer that only reads `/proc`
   and answers which processes hold paths under a given directory, plus a sudo rule for exactly
   that command; the product never prompts and never runs removal as root (W12f). (b) Keep
   today's rule: releases on this machine are never pruned, and the card shows them as kept for
   an uncertain read with their real bytes. Recommendation: (a), since about 35 GB of releases
   stay otherwise; it needs a person because it needs root.
7. **Agent-written keep markers** (C15): keep forever, or let a marker without an author and an
   end date lapse 30 days after the lane finished. Recommendation: keep, and show them on the card.
8. **Existing cleanup archives and the diagnostic and one-off folders** that remain: one decision
   per list on the card.
9. **Dependency folders outside Delegatus's own worktrees** (C5): D3, in a repository's primary
   checkout, and D4, outside any checkout. Recommendation: no automatic lifetime for either. A
   primary checkout's environment may be the one a person runs, and the product cannot tell an
   agent's one-off environment from an installed tool's. R1 prevents new D4 folders, and existing
   ones are removed by a person from a list. The package manager and model caches stay out of
   every pass, as in pass 17.

## 8. Ledgers and code that disagree

1. The task text names the fence of case (a) "attempt completedAt missing/invalid"; the product
   reports those roots as "held live" (§3.1).
2. The scratch-owners measurement says agents outside lanes get no lifetime; the code gives them
   one day from creation, and none older than seven days was found (§2 C2).
3. Case (e) "no reason found": one of the two roots was removed by the retention itself at
   12:17:49Z, 8.7 hours after it came due (§3.5).
4. One trash root of case (c) had a ledger row with a recorded size of 11.1 GB while its tree
   measured 6.4 GB; the other had no ledger row at all (§3.3).
5. Pass 12 kept all releases "as the brief required"; the product itself would have kept them
   too, for `process-unreadable` (§2 C9), and the card reports them as about zero bytes.
6. The seven-day design (#3845, §4.3) says the ignored-evidence pin of worktrees ends four days
   after the lane finished; the sweep report shows 21 worktrees held by `.artifacts` past four
   days (§2 C3) [O]; why is not established (§9).
7. The pass 16 report says all 32,587 standalone commits of the removed roots were reachable from
   the main repository. That reachability was measured after the pass had fetched 13,241 of them
   into backup refs; before that step they were absent from every ref of the main repository
   (§2 C8). The sentence describes the result of the preservation, so it does not show that the
   clones were redundant.

## 9. What could not be confirmed, and where I looked

- **The exit status of the failing container removals** (§3.2): the logged text is truncated
  before `code=`. Looked in the journal 11:17Z–14:32Z and the 14:24Z report. Check named in §3.2.
- **Why one trash root lost its ledger row** (§3.3): looked in the ledger tables, the journal and
  the code paths that call `forget`. A per-root reason (W7) would record it next time.
- **That the helper itself printed the six lease lines** (§3.7): the info line goes to the parent
  and never reaches the journal, and the stderr warnings before it carry the service's process id
  for both processes. The timing (0 to 1 second before each error, `pipelines` each time, no
  matching "cleared" line in the journal) supports it. Check: the W1 reproduction.
- **Why 21 worktrees past four days stay held by `.artifacts`** and **why 52 finished lane
  worktrees show `recent-writes`** (§2 C3, C4): read the sweep report rows; the rows carry no
  write source. Check: a dry-run sweep on a copy of one such worktree with the decision logged.
- **Whether retention throughput keeps up once W1 and W2 remove the killed ticks**: the
  13 GB/hour after the deploy includes the backlog. Check: removals per hour against new scratch
  per hour over a day after W1 and W2.
- **Whether the 13,241 commits pass 16 preserved were real work** (§2 C8): 206 of the 230
  repositories that held them had no remote-tracking refs, which fits both test fixtures and
  local clones of other repositories. Looked at the pass 16 inspection rows and plans only; the
  clones themselves are gone. Check: for a sample of the backup refs, `git log` of the commit
  and a search for its tree in other local repositories and their remotes. Until then they are
  treated as possibly the only copy (W14, §4.2).
- **Container storage and about 114 GB of the volume** that no walk could read (`/var/lib/docker`,
  other users' trees): measured only through the Docker API.
- **Who wrote each keep marker**: the files carry no author.

## 10. Deferred — not currently justified

- Pruning account stores, transcript and registry databases, and the scanner's response results:
  history and caches with their own owners; nothing in the passes removed them.
- Pruning the package manager and model caches that dependency folders hardlink into: no pass
  removed them, and they are what keeps reinstalls cheap.
- Moving the orphan clock of agent roots from creation to host end: no root of this class
  outlived seven days; the live host's `TMPDIR` already holds its root.
- A rework of the checkout-link inventory for throughput: measure after W1 and W2 first.
- A byte budget per pass and a setting for the seven-day period: nobody asked to change them.
- Packing the 26,203 backup refs: they cost 0.13 s per full ref walk (pass 16) and hold
  commits that may exist nowhere else.

## 11. Validation against the requirement

The requirement asks, for everything the passes removed, why it accumulates, why nothing cleans
it, and how the regular runs can clean it from now on. Every class the passes removed is in §2
with its creator, its growth, its intended remover and the measured reason it stayed; the known
retention failures have confirmed causes or a named check in §3; the classes with no lifetime have
a proposed lifetime and owner in §4, with the never-remove list and its proofs; §5 says what the
card shows; §6 gives the workstreams and which of them would have replaced which passes; §7 lists
what only a person can decide. Nothing in this lane deletes data or changes product code.
