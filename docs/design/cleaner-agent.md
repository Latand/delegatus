# A cleaner agent that removes provably dead temporary work

Status: design. Read-only investigation of `main` at `cb408fce` (2026-11-12). No product
code changed, nothing on any machine deleted, stopped or modified. Written for the
build, review and fix stages of this lane; the reviewers judge the build against it.

## 0. Originating requirement

**Operator, 2026-11-12, a brief relayed to the orchestrator seat from the operator's own
session about performance and disk on the audited workstation (private; paraphrased here,
never quoted). Board task e208851f.**

The operator wants an agent that cleans up. It may keep the existing cleaner's icon, but it
must run on a strong model. It gets everything it needs to find, with certainty, what is no
longer needed (all temporary work), and it deletes it. About files owned by root: the
operator did not create them; if an agent created them, an agent may delete them.

The pinned specification adds:

- a role, or the updated cleaner, on a strong model, that knows every temporary-work
  location and the proof rules for "dead", deletes what the deterministic sweepers cannot
  prove themselves, and reports what it deleted and why (path, size, proof) and what it
  kept and why;
- two triggers: the disk-pressure wake and a daily run;
- root-owned and container-uid files that agents or containers created are removed through
  the standard container path (`docker --user=0`), keep markers checked first, with no sudo
  from the operator;
- unconditional fences: live owners (cwd, exe, open files, process environment), user
  data, foreign names, open lanes and keep markers placed on purpose. Only paths whose
  creation is recorded, or that a retained manifest lists, or that the proof rules classify
  as dead, may be deleted; a name, a pattern, an age or an owner alone never grants
  authority;
- a dry-run mode, and an operator "yes" through a decision form before the first real run
  on the operator's machine;
- three neighbouring tasks own the evidence copy policy, the test keep markers and the
  reconciliation of unconfirmed hosts; the operator's own session owns #3945, #3946, #3941
  and JSON-to-SQLite slice 8; lane d7065a7c (#3894) owns the attempt-temp retention fences.
  None of them is duplicated here.

**Answer in one paragraph.** The existing `cleaner` role gains a `disk` mode, moves to
`codex / gpt-6.1-sol / high`, and runs as an autonomous agent the Viewer launches on the
disk-pressure wake and once a day. The agent reads one inventory of every temporary-work
location with each sweeper's own hold reasons, decides which proof rule applies to each
held item, and asks one tool, `cleanup_remove`, to remove it. The tool enforces the
fences and re-proves the rule from first-hand reads before it removes anything; the
agent's shell runs in a read-only sandbox and cannot delete. Root and
container-uid trees go through the existing uid-0 cleanup container. Items under a ledger
the attempt sweep owns are never removed by the cleaner; the cleaner removes only the
obstacle that sweep cannot prove (a worktree link into another repository, a zero-byte
`.git` file) and the sweep retires the root by its own proofs.

## 1. Earlier answers and open work this builds on

Searched first: board tasks (`list_tasks` for "прибирати", "keep", "evidence",
"непідтвердженими хостами", project tasks updated since 2026-11-12), transcripts of the
seat and stage conversations (`search_transcripts`, Ukrainian and English phrasings),
memory (`search_memory`: nothing relevant), the design folder, and the diffs of every open
pull request that touches a file this design changes (§13).

| Source | What it settles here |
|---|---|
| `docs/design/temporary-data-lifecycle.md` (merged 2026-11-11, #3883) | Classes C1–C16 of temporary data, the never-remove table (§4.1), proposed lifetimes (§4.2), workstreams W1–W14 and nine decisions for a person (§7). W6 (worktree registrations inside scratch) is not built; it is the largest scratch residue this design picks up (§6, rule S1). W14 (standalone repositories in scratch roots) is not built either and stays deferred (§16); a repository the cleaner cannot prove is kept as `unproven-repository`. |
| `docs/design/scratch-and-evidence-retention.md` (#3845) | The seven-day lane retention the attempt sweep enforces; #3945 extends it (§16 of that document on its branch). |
| Operator decision, 2026-11-12 06:53Z, on the disk task's form (private; paraphrased) | Lane evidence, host event journals and ownerless legacy copies: seven days. Docker build cache and unused images older than 14 days: removed daily; containers and volumes not touched by that job. Old releases: the operator accepts one sudo command installing a read-only release observer. **All three are built by lane 6923ad99, PR #3943** (`docs/design/temporary-data-retention-operations.md` on its branch). This design adds no rule for any of them. |
| PR #3945 (operator's session) | Scratch retention: lanes closed on a decision finish, the namespace no-evidence proof counts only ledger-linked pictures, roots with directories another user owns retire through the uid-0 container, a root whose container cannot run is held as `operator` and listed in a new `root_blocked` table, partial `du` sizes, page order. Its own forecast lists what stays held after it: worktree links into other repositories and empty `.git` files (34 roots, 40.1 GB), keep markers (29 roots, 37.7 GB), linked evidence until day seven (29.3 GB), open lanes (28.0 GB), unconfirmed hosts (66 roots, 23.3 GB), unowned roots younger than a day. |
| PR #3894 (lane d7065a7c, successor af9834e2) | Attempt-temp permission repair, removal fences and the `containerCommand` signature (adds a `snapshot` operation and a namespace budget). |
| PR #3946, #3941 (operator's session) | Host event window in memory, registry views. No file overlap with this design. |
| Task 3aabcf74 | JSON-to-SQLite slice 9 moves the Claude delivery ledger into a database after slice 8. The cleaner does not touch `claude-delivery-ledger`. |
| Tasks c5e50d92 (lane 3b4123f3), 44efaa1c (lane c63c21f9), dc426371 | Unconfirmed-host reconciliation; test fixtures that leave «operator pin» keep markers (the operator removed 105 by hand on 2026-11-12); evidence copy policy. Each is report-only here. |
| Task 795cd144 (blocked, hidden) | A general scheduled-run record for agents. Not built; the cleaner keeps its own daily clock like the board maintainer does (§9) and does not wait for it. |
| `boardMaintenance/run.ts`, `memory/curation/guard.ts`, `issueReports/approvalForm.ts` | The precedents reused: an autonomous agent launched by the Viewer with a durable run record (`run.ts:151-243`), a tool callable only by the live run's conversation (`guard.ts:15-30`), and an operator approval bound to a digest of exactly what was shown (`approvalForm.ts:32-54`). |

"A retained manifest": no such manifest exists in the repository (searched `docs`, `src`,
`scripts`, `AGENTS.md`, `CONTRIBUTING.md`). This design uses the other two authorities the
requirement allows: a recorded creation, and a proof rule.

## 2. Today, in one table

| Mechanism | Cadence | Where |
|---|---|---|
| Temp sweep | hourly, first after 5 min | `tempSweep.ts:64`, `:970-997` |
| Attempt-temp retention | every minute | `tempSweep.ts:999-1014`, `attemptTempProduction.ts:78-118` |
| Worktree sweep | hourly, first after 10 min | `worktreeSweep.ts:174-176` |
| Release retention | every minute, after the self-update tick | `selfUpdate/service.ts:303`, `:311-322` |
| Files-response results (#3942) | inside the hourly temp sweep | `tempSweep.ts:895-911` |
| State backups | per database interval, tiered | `state/durability.ts:910-971` |
| Disk-pressure watch | every 30 s | `state/diskPressureWatch.ts:8-26` |
| Cleaner role | never starts by itself | `roles/defaults.ts:319-328` |

## 3. What each deterministic mechanism proves, and what it cannot

### 3.1 Temp sweep (`src/lib/tempSweep.ts`)

Proves: a direct child of `/tmp`, `/var/tmp`, this process's temp dir or `$STATE/scratch`
(`:243-246`, `:920-921`) is dead when its name is owned (`llv-*` or three legacy test
prefixes, never `llv-spawn-sandbox`, `llv-tmux-cwd`, `llv-gate`; `:76-86`), it belongs to
this uid (`:718`), every entry is older than 24 hours (`:62`, `:752`), no process uses it
as cwd, open file, exe, root, cmdline path, mapping or `HOME`/`TMPDIR`/`LLV_STATE_DIR`/
`XDG_CONFIG_HOME`/`CLAUDE_CODE_TMPDIR` (`:80`, `:131-188`, `:756-760`), no live
conversation runs there (`:620-622`), no pipeline worktree overlaps it (`:762-776`), and it
holds no `.delegatus-keep` (`:746`). Removal is journal-then-rename-then-recheck
(`:410-445`).

Cannot prove, and holds or skips instead:

- **Names it did not choose.** `delegatus-test-comparison-*` (`scripts/local-gate-tests.ts:483`),
  `delegatus-gate-record-*` (`scripts/gateSandboxRecords.ts:45`) and `hooks-e2e-*`
  (`scripts/local-gate.fixture.ts:13`) are not owned names, so they are never candidates
  (`:82-86`), however dead.
- **Any Git data.** A `.git` entry, or `objects` with `HEAD`/`config`/`refs`, holds the
  whole tree as `git-checkout` (`:385-393`). A killed test run's `llv-test-run-*` root that
  contains a fixture repository, and every `llv-cli-self-update-*` root (the fixture makes a
  repository with its own commit, `bin/__fixtures__/cli-self-update.ts:141-166`), stay forever.
- **Trees it cannot read.** An unreadable subtree, such as one a container created as uid
  0, 101 or 999, is held as `unreadable-tree` (`:396-397`); a top-level directory of another
  uid is skipped without a report row (`:718`). Its only removal is `fs.promises.rm`
  (`:442`); it has no container path.
- **Large trees.** Over 200 000 entries the tree is held as `entry-limit` (`:72`, `:376`).
- **Pictures anywhere in the tree** hold it as `evidence` (`:383-384`), whether or not any
  record links them.
- **Marked roots the ledger forgot.** A root with `.delegatus-attempt-owner` that the
  attempt ledger does not list is held as `attempt-owner-unlisted` (`:739-743`).

### 3.2 Worktree sweep (`src/lib/pipelines/worktreeSweep.ts`)

Proves: a linked worktree of a registered repository is dead when a merged pull request
contains its HEAD, or, for a finished lane, after retention every commit is in a ref a
remote advertises now, or a verified backup preserves it (`:31-141`, retention `:157-165`);
open pipelines, live processes, live conversations, merge-batch state, uncommitted changes
and non-rebuildable ignored files hold it (`:62-105`, guards `:1085-1112`).

Cannot prove:

- **Repositories it does not know.** It lists worktrees only of repositories a pipeline ran
  in or a project registered (`:1150-1156`). A checkout an agent added from another
  repository into a stage scratch root is never listed there.
- **Checkouts nobody recorded creating.** Without a pipeline, merge-batch or creation record,
  a checkout is kept as `not-created-by-delegatus` unless the operator sets
  `LLV_WORKTREE_SWEEP_FOREIGN=1` (`:56-58`, `:166-172`, `:214`).
- **Dangling links.** A checkout whose `.git` file points at an administrative directory
  that no longer exists is invisible to `git worktree list` in any repository.

### 3.3 Attempt-temp retention (`src/lib/runtime/attemptTempRetention.ts`, `attemptTempProduction.ts`, `attemptTempFilesystem.ts`)

Proves: a registered stage root (`llv-stage-*`, `llv-read-only-stage-*`,
`llv-stage-config-*`; registration `:78-88`, adoption of legacy scratch roots `:91-122`) is
retired when its lane's authority is `closed`, `expired`, `settled` without
`retainUntilClose`, or `orphan` older than a day (`attemptTempRetention.ts:414-415`,
authority `attemptTempProduction.ts:16-56`, lane finish `laneFinish.ts:17-36`), no recorded
check holds it (`:407`), no marker holds it (`:419`), no live reference holds it (`:421`),
evidence is preserved (`:423-436`); removal falls back to the uid-0 container on `EACCES`
or `EPERM` (`attemptTempFilesystem.ts:634-648`, container `:528-559`).

Cannot prove:

- **Links into other repositories.** `markerHolds` holds any `.git` file or
  `worktrees/*/gitdir` whose pointer resolves outside the root (`attemptTempFilesystem.ts:474-492`),
  and the container classifier refuses the same (`:506-513`). It never asks the other
  repository whether the checkout is clean and its commits are kept there.
- **Zero-byte `.git` files.** A `.git` regular file of size zero has no pointer, so it holds
  (`:483-485`), unless it sits in uv's source-distribution cache (`:482`). It is not a Git
  repository at all.
- **Lanes that cannot finish.** `laneFinish` refuses while `unconfirmedHosts` is non-empty
  (`laneFinish.ts:22`): owned by task c5e50d92.
- **Keep markers** (`:478`, classifier `:498`): owned by task 44efaa1c for the ones tests
  leave; deliberate ones stay by requirement.
- **A container that cannot run.** No `docker`, no installed utility image
  (`attemptTempUtilityImage`, `:515-523`, `--pull=never` at `:554`): after #3945 the root is
  held as `operator` and listed in `root_blocked`.

### 3.4 Release retention (`src/lib/selfUpdate/retention.ts`, `service.ts`)

Proves: a release under the current installation's `releasesDir` is removable when it is
not active, rollback, in flight or serving, no process holds it, it is not locked, it is
older than a day, and it is beyond the newest three (`retention.ts:151-169`, `:234-264`);
Git status and generated output are checked through a gated quarantine (`:179-204`).
#3942 judges unreadable processes by lineage; #3943 adds a read-only root observer.

Cannot prove:

- **Other installations.** Each installation's releases live under
  `$CACHE/delegatus/self-update/<installId>/releases` (`bin/self-update-supervisor.mjs:48-61`),
  where `installId` is a hash of the checkout path (`bin/cli.mjs:1673`). The tick passes only
  the current installation's record (`service.ts:311-322`), so a directory left by an old
  checkout location is never visited.
- **Standalone clones.** A directory in `releasesDir` that `git worktree list` does not
  register is kept as `unregistered` for ever (`retention.ts:225-226`); names outside the
  release pattern are skipped (`:224`). Earlier deploys created such clones; #3942 changed the
  deploy procedure so new ones are worktrees.
- **An incomplete process read** keeps everything (`:96`, `:131-136`) until the observer of
  #3943 is installed.

### 3.5 Disk-pressure wake (`src/lib/state/diskPressure.ts`, `diskPressureActions.ts`, `diskPressureWatch.ts`, `monitor/seatTickSources.ts`)

Proves nothing about any path; it observes. Every 30 s the release that owns traffic reads
free space on the state, worktree, repository and temp volumes (`diskPressureWatch.ts:13-25`,
volumes `diskPressure.ts:122-143`); a warning starts at 10 % free capped at 100 GiB
(`:53-63`), a critical level at 2 GiB scaled (`:31`), recovery needs 120 % of the threshold
(`:213`). Once per episode, after the consumer categories are measured or 15 minutes pass
(`:37-39`, `:220-223`), it opens one seat card and one bridge report
(`diskPressureActions.ts:91-101`) and the seat tick raises a `disk-space` item
(`seatTickSources.ts:1653-1665`). Every 15 minutes in an episode it advances the idle timers
of the four sweeps (`diskPressureActions.ts:88-90`, `diskPressureSweeps.ts:1-13`).

Cannot do: remove anything a sweep holds; start any agent (the seat decides, and with no
seat or wakes off nothing acts); wake anyone a second time in the same episode, so a pass
that frees too little stays unanswered until the volume recovers past 120 % and falls again
(`diskPressure.ts:200-216`).

## 4. Inventory of temporary-work locations

Sizes are from the 2026-11-12 audit of the workstation (1.8 TB, 77 % used) unless marked
otherwise. `$STATE` is the Viewer's state directory, `$CACHE` the user cache directory.

| # | Location | Deterministic owner, its proof | What the cleaner does |
|---|---|---|---|
| L1 | `$STATE/scratch/llv-stage-*`, `llv-read-only-stage-*`, `llv-stage-config-*` (309 GB, 524 roots) | Attempt-temp retention (§3.3), with #3945 and #3894 | Rule **S1** for worktree links into other repositories, rule **S2** for zero-byte `.git` files: it removes the obstacle and leaves the root to the sweep. Reports: keep-marked roots (task 44efaa1c), unconfirmed hosts (task c5e50d92), `root_blocked` roots (#3945), `attempt-owner-unlisted` roots (never treated as orphans, lifecycle W5), dangling links, open lanes. |
| L2 | `$STATE/scratch/<other llv-* names>`, `/tmp`, `/var/tmp`, the host temp views in the Docker install | Temp sweep (§3.1) | Rules **T1** (recorded gate sandboxes), **T2** (dead test-run roots), **T3** (fixture roots), **T4** (unreadable or container-uid subtrees through the container). Reports anything else held. |
| L3 | `$STATE/evidence` (117 GB: attempt-temp 55, agents 19, recorded checks 9.3) | #3945 (linked evidence), #3943 (seven days after termination; ownerless copies seven days after adoption); copy policy is task dc426371 | Report only: bytes per class, and what the seven-day rule still keeps (unknown termination clock, live owner). |
| L4 | `$STATE/structured-host-events` (34 GB, 18.5 k ledgers) | #3943 (seven days after the last write, session dead, transcript present). Readers: replay and timing (`runtime/eventStore.ts:341-343`, `attemptTiming.ts:79`), image retention roots (`runtimeImageStore.ts:444-445`) | Report only. A ledger without a transcript is the only record of its session and stays. |
| L5 | `$STATE/backups/sqlite` (16 GB) | `pruneBackups`: tiered or newest-N per declared database, 2 GiB budget, never below three generations each (`durability.ts:46-50`, `:910-971`). Kept copy for the role-history drain, released after 30 days by its own code (`memory/roleHistoryDrain.ts:62-95`) | Report only. Observed on this machine (read-only listing, 2026-11-12 13:40Z): 16 GB = three generations each of the three backed-up databases plus the role-history kept copy, all within those rules. No orphaned prefix was found, so no rule is built (§16). |
| L6 | `$CACHE/delegatus/self-update/<installId>/releases` (about 3 GB each, 56 releases on the workstation) | Release retention for the current installation (§3.4), with #3942 and #3943 | Rule **R1** for installations that no longer exist, rule **R2** for standalone clones the current installation keeps as `unregistered`. Reports the current installation's kept reasons. |
| L7 | `$STATE/files-response-results` | Hourly sweep since #3942 (`scanner/filesResponseResults.ts:24-41`) | Report only (`unrecognized`, `foreign-owner` residue). |
| L8 | Docker: `llv-deploy-*`, `llv-staging-*`, rehearsal and performance-gate containers; old images | Docker deploy adapter retains only listed releases and removes obsolete managed containers during a deploy (`scripts/runtime-host-viewer-adapter.ts:456-475`); failed candidates are removed at once (`src/runtime-host/main.ts:258`); staging containers deliberately lack the managed label (`stagingContainer.ts:23-28`); #3943 prunes images without containers and build cache older than 14 days | Rule **D1** for stopped product containers. Images then fall to #3943's daily prune. Volumes never. |
| L9 | `$STATE/claude-delivery-ledger` (134 MB) | Delivery replay (`claudeStreamBrokerHost.ts:123`) and image retention roots (`runtimeImageStore.ts:444`); moves to SQLite in slice 9 | Report only. |
| L10 | `.delegatus-keep` markers anywhere | Every sweeper honours them | Never removed. Reported with the first line of the marker and the root's lane. |

## 5. Unconditional fences

The tool (§8.2) enforces the fences; the prompt only describes them. The tool checks every
fence for every target twice: when it selects it, and at the removal boundary after the journalled rename
into trash (the `held` and `validate` callbacks of `removeTreeViaTrash`, `tempSweep.ts:410-445`).
A target that fails a fence is refused with the fence's name and left byte-for-byte as it was.

| Fence | Mechanical check |
|---|---|
| F1 live owner | One fresh `/proc` scan per check (`scanProcesses`, `tempSweep.ts:131-188`: cwd, fds, exe, root, cmdline paths, mappings, the in-use environment variables), compared on both the canonical path and the physical path (`resolvePhysicalPath`, `:228-241`); live and waiting conversation cwds (`liveOrWaitingConversationCwds`, `worktreeSweep.ts:704`); running container mounts (`containerMountsClear`, `attemptTempFilesystem.ts:448-472`) for every target that holds an entry of another uid. A process scan that fails, or a container inventory that fails, refuses. |
| F2 user data | The target is under one of the cleaner roots: direct children of `$STATE/scratch`, of the attempt config parent, of `/tmp` and `/var/tmp` (and their validated host views), `$CACHE/delegatus/self-update/<installId>` other than the current one, a registered administrative entry whose `gitdir` points into a cleaner root, or a Docker container with a product label. Everything else is refused: the home directory, any repository's main checkout or `.git` directory, `$STATE` children other than `scratch` (evidence, host events, ledgers, backups, databases), package-manager and model caches. A top-level directory must belong to this uid. |
| F3 foreign names | A direct child of a temp root is a candidate only when its name maps to an entry of the creator registry (§6.1), which cites the creating file and line in the serving release's source. The registry never grants authority by itself; each rule adds liveness, age and content proofs. |
| F4 open lanes | Refused when the target is inside, or contains, a worktree or repository of an open pipeline or one whose close or delivery has not settled (`pipelineHoldsCheckout`, `worktreeSweep.ts:321-323`, `:1092-1093`), merge-batch state that owns it (`mergeBatchOwnership`, `:758`), or an attempt root whose authority is `live` or `unknown` (`attemptTempProduction.ts:16-56`). |
| F5 keep markers | Any `.delegatus-keep` in the target or in an ancestor up to its cleaner root refuses. Readable trees are searched with `find -xdev`; for an unreadable part the uid-0 container classifier exits 75 on a marker at dispatch (`attemptTempFilesystem.ts:496-514`). Markers are never removed, never edited. |
| F6 evidence and preservation records | `.artifacts`, a file the evidence ledger links (`ledgerLinkedEvidence`, #3945), a worktree backup, a bundle or a `refs/delegatus/worktree-backup/*` ref refuses. |
| F7 unproven Git work | Git data whose commits or uncommitted changes the rule has not proven kept elsewhere refuses. |
| F8 work owned by another task | A lane with `unconfirmedHosts` (`laneFinish.ts:22`), a recorded-check hold (`recordedRootHeld`), an attempt root the ledger lists (removal of the whole root stays with the attempt sweep), the current installation's releases (release retention), evidence and host-event ledgers (#3943), the delivery ledger (slice 9): refused. |

## 6. Proof rules

### 6.1 The creator registry

One committed table in the cleaner module: prefix → creating file and line → creator kind
(`process-root`, `gate-sandbox`, `test-fixture`, `process-scratch`) → expected top-level layout
when the creator writes one. Initial rows, each verified in this tree:

| Prefix | Creator | Kind |
|---|---|---|
| `llv-test-run-` | `claimProcessTempRoot` from `test-preload.ts:42`, `:130`; `tempDirs.ts:31`, `:53-60` | process-root: the process holds an open descriptor on it until it exits, including a kill (`tempDirs.ts:33-38`) |
| `delegatus-test-comparison-` | `scripts/local-gate-tests.ts:483`, recorded by `recordGateSandbox` (`scripts/gateSandboxRecords.ts:12-20`) | gate-sandbox |
| `delegatus-gate-record-` | `scripts/gateSandboxRecords.ts:45` | gate-sandbox record |
| `hooks-e2e-` | `scripts/local-gate.fixture.ts:13`; layout `.githooks/`, `scripts/`, `shims/`, `.github/workflows/` (`:15`); it holds symbolic links into the real checkout and its `node_modules` (`:17`, `:22`) | test-fixture |
| `llv-cli-self-update-` | `bin/__fixtures__/cli-self-update.ts:141`; layout `checkout/`, `home/`, `state/`, `cache/`, `tmp/` (`:143-149`) | test-fixture |
| `llv-claude-json-` | `src/lib/agent/claudeHeadless.ts:45` | process-scratch (the temp sweep already owns it; listed so the report names its creator) |

A prefix that no longer appears at its cited line in the serving release's source is
dropped from the registry at load; a test reads each row's file and line. Every removal
unlinks symbolic links and never follows them (`fs.rm` and the container's `find -delete`
both remove the link itself), so a fixture's links into a real checkout cost nothing.

### 6.2 Rules

Each rule's preconditions are all checked by the tool from its own reads; agent-supplied
fields are pointers (which repository, which remote) and prove nothing. F1–F8 apply to every rule.

**S1. Worktree link into another repository, inside a ledger root.**
Preconditions: the root's ledger authority is `expired`, `closed`, or `settled` without
`retainUntilClose` (the attempt sweep's own eligibility, `attemptTempRetention.ts:414-415`),
and the only markers in it are links of this kind or S2's zero-byte files; the link's administrative directory
exists in its repository and `git worktree list --porcelain -z` there lists this checkout,
unlocked; `git status --porcelain=v1 -z --untracked-files=all --ignored=matching` in the
checkout shows no tracked or untracked change and only ignored entries that
`disposableIgnoredPath` accepts (`worktreeSweep.ts:399-401`); HEAD is reachable from a
branch or tag of that repository other than this worktree's own HEAD, or from a ref one of
its remotes advertises now (the same `ls-remote` read as `worktreeSweep.ts:1175-1190`).
Removal: `git -C <repository> worktree remove <checkout>` without `--force` (Git itself
refuses a tree that became dirty), recorded in the worktree map first as the worktree sweep
does. No ref is deleted. The attempt sweep then retires the root by its own proofs.
A dangling link (administrative directory missing) is kept as `dangling-worktree-link`:
nothing can show its uncommitted changes are kept.

**S2. Zero-byte `.git` files, inside a ledger root.** Preconditions: the root's ledger
eligibility as in S1; every `.git` entry in the tree is a regular, single-link, zero-byte
file outside uv's cache; no other marker. A zero-byte file has no `gitdir:` line, so Git
cannot open it as a repository and it holds no commit. Removal: unlink those files only.
The attempt sweep retires the root.

**T1. Recorded gate sandbox.** Preconditions: a row `{directory, dev, ino, generation}` in
a `delegatus-gate-record-*/sandboxes.ndjson` journal has no `released` row
(`gateSandboxRecords.ts:12-20`, `:24-41`); the directory has that `dev:ino`; no process holds
the sandbox or the journal (the outer runner's exit handler, `:43-60`, is gone); every entry
is older than 24 hours. Removal: the sandbox tree, then the record directory once all its
rows are released or removed. This is the "creation recorded" authority.

**T2. Dead test-run root.** Preconditions: the name is `llv-test-run-*`; no process holds
the root (its creator held an open descriptor on it until it exited, `tempDirs.ts:33-38`);
every readable entry is older than 24 hours; the temp sweep's latest report holds it as
`git-checkout`, `unreadable-tree`, `entry-limit` or `evidence`; Git data inside has no
remote configured and no worktree registration whose `gitdir` points outside the root;
pictures inside are not ledger-linked. A test run's root holds only what that run's tests
wrote (the preload points `TMPDIR` at it before anything else runs, `tempDirs.ts:5-25`).
Removal: the whole root, natively or through the container (§7).

**T3. Fixture root outside a test-run root.** Preconditions: the name maps to a
`test-fixture` row of the registry and the top level matches that row's layout; mode
`0700`; this uid; no process holds it; every readable entry older than 24 hours; every
repository inside has no remote and no registration pointing outside the root; pictures
not ledger-linked. This is the weakest rule (it rests on the creator's layout and has no
per-directory record), so the report lists T3 removals separately and each T3 creator
becomes a follow-up to make the fixture clean up on failure, after which the row leaves the
registry.

**T4. Unreadable or container-uid subtree in an owned stale root.** Preconditions: an
owned name (`llv-*`, or a T1–T3 root), top-level owned by this uid, the readable part older
than 24 hours, no process and no running container holds it, the temp sweep holds it as
`unreadable-tree` or native removal failed with `EACCES`/`EPERM`. Removal: §7. A subtree
another uid owns is treated as written by a container the agent started; with no running
container mounting it and no live process holding it, nothing can be writing it. The
residual assumption, a host process of another user writing into a 0700 directory of this
uid, is the one the temp sweep already makes (`tempSweep.ts:129-130`).

**R1. Releases of an installation that no longer exists.** Preconditions: `<installId>` is
not the current installation's; the launcher record `launcher-<installId>.json`
(`bin/self-update-supervisor.mjs:48-56`) is absent, or names a checkout path that no longer
exists; no process holds any path under the directory, by a complete scan (incomplete reads
refuse, as `retention.ts:96` does; the #3943 observer answers when installed); each release
is clean; for a registered worktree its checkout's `git worktree remove` without `--force`
removes it, for a standalone clone HEAD is reachable from the canonical remote's advertised
refs or from the current checkout's refs. Removal: each release, then the instance
directory. An installation whose checkout still exists is kept as `install-present`.

**R2. Unregistered standalone clone in the current installation's releases.**
Preconditions: release retention's latest report keeps it as `unregistered`
(`retention.ts:226`); it has a `.git` directory; it is not active, rollback, in flight or
serving (the same inputs as `protect`, `retention.ts:151-169`, read from the owner as the
retention pass reads them); no process holds it; older than a day; clean; HEAD reachable as
in R1. Removal: native, after the gated quarantine pattern.

**D1. Stopped product container.** Preconditions: a product label
(`dev.live-log-viewer.managed`, `.staging`, `.runtime-host-rehearsal`,
`.candidate-performance`); a name alone (`isProductContainer`, `dockerNames.ts:55-58`) is
never enough; state `exited`, `created` or `dead`, finished more than 14 days ago (the
horizon the operator set for images on 2026-11-12, applied to the containers the later brief
of the same day hands to the cleaner); not a retained release or rollback slot of the
deploy adapter (`runtime-host-viewer-adapter.ts:456-475`), whose records the tool reads, and
an unreadable record refuses every D1; no deployment in progress (the deployment ledger's
latest record is terminal, `runtime/deploymentLedger.ts:149`); writable layer at most
64 MiB (`SizeRw`), since product state lives in bind mounts and a larger layer means
something wrote data inside. Removal: `docker container rm <id>` without `-f` and without
`-v`. Images follow #3943's daily prune; volumes are never touched.

### 6.3 Promotion

A rule whose proof is fully mechanical belongs in its sweeper. S2, and the T1 and T2
prefixes, are such rules; they live in the cleaner now only because `tempSweep.ts` and
`attemptTempFilesystem.ts` are in three open pull requests (#3943, #3945, #3894). Each report
counts removals per rule; the build files one follow-up task to move S2, T1 and T2 into the
sweepers after those merge.

## 7. Root and container-uid files: the container path

The cleaner adds no container code. It calls the exported `removeAttemptTree`
(`attemptTempFilesystem.ts:634-648`; its signature changes in #3894, and the build calls the
signature `main` has when it starts), which removes natively and, on `EACCES` or `EPERM`,
runs the existing uid-0 cleanup container (`:528-559`): `--user=0`, `--cap-drop=ALL` plus
`DAC_OVERRIDE` and `FOWNER`, `--network=none`, `--read-only`, `--pull=never`, a 128 MB and
32-process limit, only the target bind-mounted, a 12-second timeout. Before it runs, the
container classifier refuses any `.delegatus-keep` and any Git pointer leaving the tree
(exit 75, `:496-514`), running containers that mount the tree refuse
(`containerMountsClear`, `:448-472`), and the root's `dev:ino` is compared inside the
container (`:545`).

Keep markers are checked first in two places: natively over every readable entry before the
call (F5), and by the container classifier over the unreadable part in the same run that
deletes.

In the Docker install the daemon resolves bind sources on the host, so the tool passes the
canonical host path of a temp view (`TempSweepRoot.path`) and never its `/proc/<pid>/root`
alias, and refuses when the view's namespace changed (`namespaceStill`, `tempSweep.ts:564-567`).

When the container cannot run (no `docker`, no installed utility image), the target is kept
as `container-unavailable` with its owner uid, mode and readable size, the way #3945 lists
`root_blocked`. The operator runs no sudo; the cleaner never pulls an image.

## 8. Role, tools and sandbox

### 8.1 The role

The existing `cleaner` role (`roles/defaults.ts:319-328`) keeps its id, its name and its
icon (`components/RoleFrameMark.tsx:17`, `Brush`) and gains a `mode` parameter: `checkout`
(default; today's recovery under a backup contract) and `disk`. The scaffold's disk part
says, in substance: read the inventory, classify each held item under one rule or a kept
reason, ask `cleanup_remove` once per target with the rule and the pointers it needs, never
remove with a shell command, and end with the report block of §11. Safety fences become:
checkout mode backs up before each destructive step; disk mode removes only through
`cleanup_remove`; sibling worktrees and user data stay untouched.

Shared path: the review-loop fixer default is derived from the cleaner's config and clamped
to low effort (`workflows/store.ts:39-46`). Moving the cleaner would silently move every
seeded fixer from `gpt-6-luna` to `gpt-6.1-sol`. The build pins the fixer default to its
current value, `codex / gpt-6-luna / low`, and keeps its codex-only contract; the existing
test (`workflows/store.test.ts:68`) stays green. Other readers of the role (role registry,
Settings mapping, `pipelines/store.ts:64`, `pipelines/roles.ts:18`, `displayNames.ts:89`,
`i18n/uk.ts:1789`, the `role_presets` description `mcp/server.ts:4061`) read the id and
config only and need no change.

### 8.2 Tools

Both are Viewer MCP tools, callable only by the conversation of the live cleaner run: the
caller is resolved from the registry and its spawn receipt to the run's `clientAttemptId`,
as `curatorOwnerOf` does (`memory/curation/guard.ts:15-30`); any other caller is refused
before anything is read. Both post to Viewer routes (`viewerControlForCall`, as
`deploy_exact_sha` does, `mcp/bindings.ts:8804-8807`); only the release that owns traffic
answers, and the work runs in the leased sweep helper off the Viewer loop
(`pipelines/worktreeSweepWorker.ts`), each call under one deadline.

- **`cleanup_inventory`** (read). Pages of at most 500 items, cursor-based. Per location of
  §4: the latest sweeper report rows with their hold reasons and bytes (temp sweep, worktree
  sweep, attempt-temp report including `root_blocked`, release retention, files-response),
  the disk-pressure volumes and categories, and the locations no sweeper visits (other
  installations, gate sandbox journals, product containers with labels, state and size).
  It reads reports and bounded listings; it walks no tree of unbounded size.
- **`cleanup_remove`** (write). `{ target: { kind: "path", path } | { kind: "container", id },
  rule, pointers?, clientRequestId }`, one target per call. The tool resolves the run's mode,
  checks F1–F8, re-proves the rule, writes the intent to the run record, renames into trash,
  re-checks, removes, and answers `removed` (bytes, via, proof facts), `would-remove` in
  dry-run, or `refused` with the fence or the failed precondition. Idempotent per
  `clientRequestId`.

### 8.3 The sandbox

A disk-mode launch runs the agent's shell read-only: on Codex the legacy read-only host
profile, which extends `:read-only` and allows writes only to the agent's own scratch and
evidence directories (`runtime/structuredSpawn.ts:253-259`). Today a spawn outside a
pipeline does not derive `readOnly` from a role (`agent/spawnCommand.ts:1070-1104` builds the
spec and the profile without it; the body type `:374` has no such field). The build adds one narrow rule
where that profile is built: role `cleaner` with `mode: "disk"` launches with
`readOnly: true`. Removal authority therefore exists only in `cleanup_remove`.

### 8.4 Model choice

`codex / gpt-6.1-sol / high`.

- **Strong.** `gpt-6.1-sol` is the model the shipped defaults give the reviewer (at
  `xhigh`), the verifier, the production auditor, the merger, the maintainer and the curator
  (`role_presets` read of 2026-11-12); `gpt-6-luna`, today's cleaner model, is otherwise used
  only by the trivial reviewer and the apply-fixes builder.
- **Read-only by the operating system.** The Codex host enforces the read-only profile on
  every shell command (§8.3). The Claude path maps read-only to `--permission-mode plan`
  with `Edit,Write,NotebookEdit` disallowed (`agent/cli.ts:449-451`), which either blocks the
  read commands the agent needs (`du`, `find`, `stat`, `git status`) or, with a weaker mode,
  leaves `rm` reachable from Bash.
- **One role, one engine.** The workflow fixer's codex-only contract is tied to this role
  (`workflows/store.ts:39-46`); staying on Codex keeps that contract trivially true.
- **Effort `high`.** The irreversible step is fenced and re-proved by the tool;
  the agent's judgement is classification over many similar items, the curator's and
  verifier's profile. A disk-pressure run also benefits from finishing sooner. The operator
  can raise it in the role mapping.

Claude Opus was the alternative: rejected for the sandbox reason above. Fable is not used
for stage work (operator, 2026-11-11).

## 9. Triggers and the run controller

A new module `src/lib/cleaner/` follows the board maintainer (`boardMaintenance/run.ts`):

- **Run record.** One `SqliteStateCollection` `cleaner-runs` in `state.sqlite` (the operator
  asked on 2026-11-12 for one SQLite store, no new JSON files). Row: `runId`, `trigger`
  (`disk-pressure:<episode>` or `daily:<date>`), `mode`, `claimedAt`, `launchedAt`,
  `taskId`, `conversationId`, the launch body (persisted before dispatch, replayed with the
  same `clientAttemptId` after a restart, as `run.ts:162-175`), the removal journal, the
  parsed report, `settledAt`, `failure`. The newest 60 rows are kept.
- **Disk-pressure trigger.** `reconcileDiskPressure` (`diskPressureActions.ts:59-102`) gains a
  third effect beside `card` and `report`: once the wake is ready (`:91`), it claims one run
  keyed by the episode (the `Notice` row gains `cleaner: boolean`, written under the same
  file transaction, so overlapping readers and a replacement Viewer claim it once). The
  seat's card text gains one line naming the run's card. The seat still decides everything
  else.
- **Daily trigger.** The same 30-second watch (`diskPressureWatch.ts:13-16`) calls
  `launchCleanerIfDue(now)`, which claims a daily run when the last daily claim is 24 hours
  old or absent, first 10 minutes after the release takes traffic.
- **One at a time.** A claim is refused while a run is live; a pressure claim refused this
  way is retried by the next watch tick until the episode has a run. Every claim needs the
  release that owns traffic (`viewerReleaseOwnsTraffic`), no self-update drain
  (`activeDrain`), and the Viewer's own project
  (`productionDiskPressureActions().project`, `diskPressureActions.ts:22-29`). The spawn's
  worker limit and account binding apply as for any agent.
- **Launch and observe.** `launchAutonomousConversation` (`agent/autonomousConversation.ts:10-29`)
  with `{ role: "cleaner", roleParams: { mode: "disk" }, cwd: <the Viewer's checkout>,
  project, prompt: <brief>, taskId, clientAttemptId: runId, mcpServers: ["viewer"],
  notifyLauncher: false }`; `observeSpawnedTurn` (`:41-58`); a run over 90 minutes is
  settled as `timed-out`, as maintenance does (`run.ts:223`). The brief carries the trigger,
  the volumes and categories, the mode, the previous run's summary and, for the first real
  run, the approved candidate digest.
- **Card.** One board card per run, as maintenance does, in the operator's language; closed
  as done when the run succeeds, left open with the failure otherwise.

## 10. Modes and the first real run

- `LLV_CLEANER` = `off` stops claiming runs; `dry-run` forces dry-run. It can only lower the
  durable mode; raising it needs the approval below.
- The durable mode is `dry-run` until the operator approves. In dry-run the tool evaluates
  every fence and every precondition exactly as in a real run, including the container
  classifier in its read-only `inspect` operation, and records `would-remove`; it renames,
  unlinks, runs `git worktree remove` and calls `docker container rm` never.
- **Approval.** After the first dry-run that finds at least one candidate, the controller
  adds a decision round to that run's card, through the same store `publish_prototype_review`
  writes (`docs/design/operator-decision-forms.md` §2), modelled on the bug-report approval
  (`issueReports/approvalForm.ts:32-54`): one question naming the count, the bytes and the
  rules; the approving option carries the whole digest of the candidate list (`Так, вмикай
  прибирання <digest>`); the others keep dry-run. The controller reads the stored answer and
  the member who decided it; an agent's account of the answer counts for nothing.
- **First real run.** It may remove only targets in the approved list whose proof still
  holds at dispatch; anything new is reported as `would-remove`. From the second real run the
  rules alone decide.

## 11. Report shape

The removed rows come only from the tool's journal; the agent's text adds kept rows and
notes only.

```text
CleanerReport {
  runId, trigger, mode: "dry-run" | "on", startedAt, endedAt,
  volumes: [{ roles, freeBefore, freeAfter, total }],
  removed: [{ target, location: "L1".."L10", bytes, rule, via: "native" | "container"
              | "git-worktree-remove" | "unlink" | "docker", proof: [fact], at }],
  wouldRemove: [same shape, dry-run and first-run extras],
  kept: [{ target, location, bytes, reason: <fence id> | "unproven:<rule>"
           | "owned-by:<task or PR>" | <named reason>, detail }],
  refused: [{ target, fence | precondition, detail }],
  byRule: { [rule]: { count, bytes } },
  promotion: [{ rule, count, bytes }],
  errors: [{ class, count }]
}
```

`bytes` is allocated size with hard links counted once. A `proof` fact is one first-hand
read with its source (for S1: the status line count, the reachable ref, the repository's
worktree list entry). The card shows the totals per rule and per kept reason in Ukrainian
or English with the operator's locale; the full report is stored with the run and written
to the run's evidence folder.

The agent's final message ends with one fenced JSON block `{ verdict, kept, notes }`, parsed
like the maintenance report (`boardMaintenance/text.ts`, `parseMaintenanceReport`).

## 12. Bounds, failures, restarts, concurrency

- One target per tool call, a per-call deadline of 60 seconds, tree walks bounded at the
  temp sweep's 200 000 entries (`tempSweep.ts:72`), at most 500 removals per run.
- Every removal is journal, rename into trash, recheck, remove (`removeTreeViaTrash`); the
  journal lives in the run record. At each run's start the controller replays unfinished
  journals with `finishTreeTrash` (`tempSweep.ts:448-469`) under fresh fences, or renames the
  trash back.
- The sweepers and the cleaner never remove the same tree: ledger roots stay with the attempt
  sweep (S1 and S2 remove only the obstacle), current releases stay with release retention,
  and every other target is renamed before removal, so a concurrent sweep sees either the
  original path or nothing.
- A failed proof read, an unreadable process, an unavailable Docker or forge read refuses
  the target and names the cause. A run never retries a refused target in the same run.

## 13. Shared paths and open pull requests

Files the build changes, with the open pull requests that also change them (read on
2026-11-12 from `gh pr list --state open`, intersected with this list):

| File | Change | Open PRs on it | Result |
|---|---|---|---|
| `roles/defaults.ts` | cleaner block | #3944, #3805, #3762 | `git merge-file` of the planned cleaner edit with #3944's version on scratch copies: exit 0, no conflict. #3805 and #3762 change the maintainer text only. |
| `workflows/store.ts` | pin the fixer | none | — |
| `agent/spawnCommand.ts` | readOnly for disk mode at `:1070-1104` | #3710 (hunks near `:599`) | no overlap |
| `state/diskPressureActions.ts`, `diskPressureWatch.ts` | third effect, daily check | none | — |
| `mcp/bindings.ts`, `mcp/server.ts` | two tools | #3944, #3937, #3928, #3802, #3795, #3749, #3731, #3710, #3585 | additive entries; rebase at build time |
| `attemptTempFilesystem.ts`, `tempSweep.ts`, `worktreeSweepWorker.ts`, `worktreeSweep.worker.ts` | **not changed**; only imported | #3945, #3894, #3943 | the container slice waits for #3894 and #3945 to merge; the helper request kind is added after #3943 merges |

## 14. Build slices and acceptance

Deletion code: three review rounds. Every test runs with its own `HOME`, `XDG_CONFIG_HOME`,
`TMPDIR`, `LLV_STATE_DIR`, `LLV_VIEWER_CONTROL_URL` on a closed port and
`LLV_GATE_RUNNER=off`, by explicit file path. Docker is a recording fake first on `PATH`
that refuses any call unless the fixture enabled it, following #3943's test safety; an
isolated daemon is used only by an opt-in suite. No test reads the operator's state, Docker
or processes.

| Slice | Files | Acceptance |
|---|---|---|
| 1. Role, sandbox, fixer | `roles/defaults.ts`, `workflows/store.ts`, `agent/spawnCommand.ts` | A disk-mode launch's Codex host gets the read-only permission profile and a shell `rm` of a fixture file outside its scratch fails, while a checkout-mode launch is unchanged; the seeded fixer stays `codex / gpt-6-luna / low` with the cleaner on sol. |
| 2. Controller and triggers | `src/lib/cleaner/{store,run,brief,text}.ts`, `state/diskPressureActions.ts`, `diskPressureWatch.ts` | One run per pressure episode across two overlapping readers and a restart; a daily run 24 hours after the last; no claim while a run is live, in a drain, or without traffic ownership; a 90-minute run settles `timed-out`; replay after restart reuses the same `clientAttemptId`. |
| 3. Inventory and remove tools, dry-run | `src/lib/cleaner/{inventory,remove,fences,rules,registry}.ts`, Viewer routes, `mcp/bindings.ts`, `mcp/server.ts` | One test per fence F1–F8: a target that satisfies its rule but violates the fence is refused with that fence's name and its `dev:ino` and content digest are unchanged. Per rule, the positive case and its key negatives (S1 dirty, S1 local-only commit, S1 dangling; S2 non-empty `.git`; T1 released row, T1 live recorder; T2 live descriptor holder, T2 remote configured; T3 layout mismatch; R1 install present; R2 active release; D1 running, retained slot, deployment in progress, large writable layer). Dry-run runs the same cases and changes nothing; the fake Docker records no `rm`. A caller other than the live run is refused. The registry test fails when a row's cited line no longer creates its prefix. |
| 4. Container path (after #3894, #3945) | `src/lib/cleaner/remove.ts` | T4 on a fixture with a mode-000 subtree: the fake Docker records one `run --rm … --user=0 … --mount type=bind,source=<target>`; a keep marker inside the unreadable part makes the classifier exit 75 and the target is kept; Docker absent gives `container-unavailable`. |
| 5. Approval and report | `src/lib/cleaner/{approval,report}.ts` | Real removal stays off until a decided round with the digest option exists; another answer, or a changed candidate list, keeps dry-run; the first real run removes only approved targets; removed rows equal the journal and a removed row in the agent's text is ignored. |

The project's checks: typecheck, ESLint on changed files, the privacy gate, and each touched
test file by path in an isolated command.

## 15. Could not confirm, and where I looked

- **Sizes on the audited workstation** come from the relayed audit and #3945's forecast; this
  stage runs on another machine and measured only the backup folder here (§4 L5).
- **Whether Codex's read-only profile admits the Viewer MCP calls** for a non-pipeline launch:
  maintainer and curator are `read-only` roles but, outside a pipeline, are not launched
  read-only (§8.3), so no running agent proves it. Slice 1's acceptance proves it before any
  removal code exists; if it fails, the fallback is the restricted pipeline profile with the
  agent's cwd set to its own empty scratch.
- **Whether product containers keep data in their writable layer**: inferred from the
  deploy adapter's bind mounts; D1's 64 MiB bound turns a wrong inference into a kept item.
- **How many T3 roots exist on the workstation**: the relayed map names the prefixes, not
  counts.

## 16. Deferred — not currently justified

- A Settings control for the cleaner's mode: the environment switch and the form cover the
  requirement.
- Moving S2, T1 and T2 into the sweepers: filed as a follow-up once #3943, #3945 and #3894
  merge (§6.3).
- A preservation path (bundle or backup) for dangling worktree links and standalone
  repositories with unique commits (lifecycle W14): kept and reported.
- A rule for backups of databases no release declares: none observed.
- Agent-made worktrees in other projects outside scratch (lifecycle C4): the operator's
  per-project decision (lifecycle §7 item 5) has not been taken.
- Removing anything under `$STATE/evidence`, host-event ledgers, the delivery ledger, Docker
  images or volumes: owned by #3943, slice 9, or never.
- A retained manifest: none exists and the two other authorities suffice.
- A Telegram summary of each run: the card and the existing disk bridge report suffice.
- A general scheduled-run record (task 795cd144): the cleaner keeps its own clock.

## 17. Validation against the requirement

| Requirement | Where |
|---|---|
| A role on a strong model that knows every temporary-work location and the proof rules | §4, §6, §8.1, §8.4 |
| Deletes what the sweepers cannot prove, and only that | §3 (what each cannot prove), §6, F8 |
| Reports path, size, proof, and what it kept and why | §11 |
| Triggers: disk-pressure wake and a daily run | §9 |
| Root and container-uid files through the standard container path, keep markers first, no sudo | §7, F5, T4 |
| Fences: live owners, user data, foreign names, open lanes, keep markers | §5 F1–F5, enforced in the tool |
| Only recorded creations or proven-dead paths; no name, pattern, age or owner alone | §5 F3, §6.1, §6.2 |
| Dry-run, and the operator's yes through a form before the first real run | §10 |
| Tests in sandboxes, no live state, no real Docker against the operator's containers | §14 |
| No duplication of #3945, #3946, #3941, slice 8, #3894, the three neighbouring tasks, #3943 | §1, §4, F8, §13 |
