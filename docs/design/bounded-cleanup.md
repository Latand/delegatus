# Bounded cleanup: temp and worktree sweeps keep fresh trees, self-update releases stay bounded

Issues: #2889 (temp and merged-worktree cleanup), #2886 (self-update release
storage). Implementation policy and protected-case coverage.

## Originating requirement

Operator, 2026-10-14, Ukrainian, verbatim (Delegatus seat conversation):

> «після деплою розбирай іш'ю нові … спочатку агент має переконатися що все актуальне»

("after the deploy, work through the new issues … first the agent must make sure
everything is current".) A verifier confirmed both issues live on `main`
`f746d7f2` before this lane was opened. This stage re-read the code at that
commit; `origin/main` had not moved when this document was written.

The two issues are the work. Their acceptance criteria are quoted where a
rule below answers them.

## 1. What deletes today

Every path in the named files that removes something on disk, what it keys
on, and what triggers it.

| # | Deletion | Where | Keys on | Triggered by |
|---|---|---|---|---|
| D1 | Stale owned temp directory, `fs.promises.rm(recursive, force)` | `src/lib/tempSweep.ts:558` | `llv-*` or three legacy prefixes, a direct child of `/tmp`, `/var/tmp`, `os.tmpdir()`, `$TMPDIR` or `state/scratch` (also through `/proc/<pid>/root` of a stamped agent's namespace); same uid; **newest mtime of the directory and its immediate entries** older than 24 h (`newestMtimeMs`, `:290-306`); no process path (cwd, fd, `HOME`/`TMPDIR`/`TMP`/`TEMP`/`LLV_STATE_DIR`/`XDG_CONFIG_HOME`/`CLAUDE_CODE_TMPDIR`) inside; no pipeline worktree inside or around; no Git metadata anywhere inside (`containsGitCheckout`, `:384-407`); ≤ 500 per sweep | `startTempSweep` (hourly, first after 5 min) from the Viewer that owns the release fence (`viewerInstrumentation.ts`) |
| D2 | Merged or retained linked worktree, `git worktree remove <dir>` (never `--force`) | `src/lib/pipelines/worktreeSweep.ts:1138` | a linked worktree of a registered repository that Delegatus created: a pipeline record naming it as its `worktreeDir`, merge-batch state naming it, or the creation record a pipeline, workflow or merge batch writes into its Git registration when it adds it (`worktreeProvenance.ts`), never a name, age or path layout; any other checkout is kept as `not-created-by-delegatus` unless `LLV_WORKTREE_SWEEP_FOREIGN=1` (off by default) opts in; merged PR whose head contains HEAD (squash-safe), or past the 4-day retention with HEAD on an advertised remote ref or equal to the lane base, or a finished pipeline lane one hour after it settled with every commit on an advertised remote ref and no write inside it for that hour; no open pipeline, process, live conversation, merge-batch hold, lock, nested worktree, change, unknown ignored file; HEAD and Git locks held through the last checks (`:1072`) | `startWorktreeSweep` (hourly, first after 10 min), same Viewer; `LLV_WORKTREE_SWEEP=dry-run` reports only |
| D3 | Build-cache trim inside a settled lane, `fs.promises.rm(recursive)` | `worktreeSweep.ts:1240` | the lane's own `<repo>-pipeline-<id>` checkout; a top-level rebuildable directory (`node_modules`, `.next`, …) Git ignores, or an `.artifacts/**/bundle` holding only `*.fixture.js`; no tracked files; identity unchanged | same sweep |
| D4 | Own HEAD/ref lock files | `worktreeSweep.ts:659-676` | inodes the sweep recorded in `state/worktree-sweep-locks/*.json` | same sweep, and recovery after a dead sweeper |
| D5 | Old self-update release: rename behind a gate, final scans and owner read with the gate closed, removal from inside it, then `git worktree remove` of the missing path for its registration ([verification](../verification/self-update-retention.md#removal-behind-a-closed-gate)) | `src/lib/selfUpdate/retention.ts`, `gatedTrash.ts` | a registered SHA-named worktree whose tracked contents are unchanged, whose HEAD is contained by a head or remote ref, whose ignored output passes the bounded generated-content proof, and which is outside active, rollback, serving, in-flight, process and mount protection | after an apply; release-owner startup and minute cadence, independent of automatic updates; four candidate trees and four recovery journals per pass |
| D6 | `git worktree prune` of the **whole install repository** | `auto.ts:158` | every registration in that repository whose directory is missing | right after D5 |
| D7 | The ready marker of a release about to be rebuilt | `steps.ts:405` | `markBuilt(dir, null)` at build start | build step |
| D8 | Preflight scratch made by `mkdtemp` in the same call | `service.ts:1615` | its own path | operator/seat apply preflight |
| D9 | Control files (requests, temporaries, pointer restore) | `apply.ts`, `auto.ts:92-117`, `service.ts` | exact own file names | self-update state machine |

D7–D9 delete only files the same call created or exact control files; they
are out of scope and stay as they are.

Nothing in `steps.ts` or `package.ts` deletes a build cache or a release.
`package.ts` creates `releasesDir/npm-<version>` containers (`:81`) that no
path ever removes.

## 2. Why each issue is live

### #2889 — a stale-looking tree with fresh deep writes is removed

`newestMtimeMs` (`tempSweep.ts:290-306`) reads the directory and its first
1 000 immediate entries. A write at depth two or more changes only its own
parent's mtime, so a tree created 48 hours ago whose `tmp/run/out.log` was
written a minute ago dates as 48 hours old, passes every other guard when no
process holds it at that instant (an agent between turns), and is removed. The
recheck before removal (`:544`) uses the same shallow function, so it cannot
catch it either. Three further gaps:

- `rm(recursive)` (D1, D3) and `git worktree remove` (D2) descend into a
  mount point under the candidate. Nothing checks for one.
- D1 and D3 delete in place: an interrupted removal leaves a half-deleted
  directory under its original name, which a resumed user of that name then
  reads as if it were whole.
- The temp sweep has no preview and no pin. The worktree sweep has both
  (`LLV_WORKTREE_SWEEP=dry-run`; `git worktree lock` keeps a checkout as
  `locked`).

### #2886 — releases and their build caches are never reclaimed on this install

- D5 runs only from `finishCheckoutDrain`, which only an automatic checkout
  drain reaches. On the production install automatic updates are off and every
  deploy is a seat apply (`history.jsonl` rows `by: "seat", kind: "build"`
  then `kind: "apply"`). A seat or operator apply settles at
  `service.ts:2039-2048`, which writes history and releases credentials and
  never prunes. The earlier design recorded this on purpose: "Manual-only
  installs keep today's behaviour (Deferred)" (`self-update-auto.md` §6.3).
  The deferral no longer holds: 50 release directories exist on this machine
  today, all 50 registered worktrees of the install checkout.
- No path reclaims `.next/cache`. The ready step (`steps.ts:313-321`) marks
  and publishes the build and leaves `.next/cache/webpack` in place. Measured
  read-only on the current release: `.next/cache/webpack` 2.0 GB,
  `.next/cache/fetch-cache` 192 KB, `swc` 12 KB, the rest of `.next` 76 MB,
  `node_modules` 796 MB. Next documents `.next/cache` as the cache "shared
  between builds" (`node_modules/next/dist/docs/01-app/02-guides/ci-build-caching.md`).
  Each release is its own worktree, so no later build ever reads an earlier
  release's cache; the serving `next start` process (its argv and maps were
  read) holds nothing under `cache/webpack`.
- D5 aborts on the first failed removal and logs only `error.name`
  (`service.ts:793`), so a failure is invisible.
- D6 prunes every missing registration of the install repository, and pipeline
  worktrees of Delegatus are registered in that same repository. A pipeline
  checkout unreachable from the Viewer's mount namespace at that moment (a host
  temp view, a role checkout in another namespace) loses its registration.
- "A release a running process uses" is approximated by three revisions in the
  launcher record. Long-lived processes run from older releases too: the
  process scan this stage ran found 89 processes referencing the current
  release through argv, cwd, environment (`LLV_TELEGRAM_*` paths) and mapped
  files; stage briefs cite `<release>/scripts/gate-slot.sh` by absolute path
  for the life of the stage.

## 3. Shared primitives

Four small pieces, used by every deletion path below. They live beside the
sweeps (`tempSweep.ts` exports them; no new module for them).

### 3.1 `inspectTree(directory, { limit })` — one bounded walk

Replaces `newestMtimeMs` and `containsGitCheckout` with a single walk (one
pass, not two) that answers `{ newestMs, entries, hold }`:

- Walks with `lstat`, never follows a symlink (a symlink's own times count,
  its target is not visited).
- **Freshness**: `newestMs` is the maximum over every entry of `mtimeMs`, and
  of `ctimeMs` for directories and for files with `nlink === 1`. `ctime`
  catches a write whose mtime was restored (`cp -p`, `tar -x`, `touch -d`).
  It is ignored for hard-linked files because Bun installs `node_modules` as
  hard links into its global cache: every new `bun install` anywhere bumps the
  `ctime` of those shared inodes, which would keep every old tree with
  dependencies young for ever.
- **Early exit**: the walk stops as soon as an entry is younger than the
  threshold; the answer is "young". An active tree costs a few entries.
- **Holds** (any one stops the walk and preserves the tree):
  - `git-checkout` — the existing Git metadata rules, unchanged
    (`.git` directory or non-disposable marker, bare/damaged repository
    markers, the uv `sdists-v*` empty-marker exception).
  - `mount-boundary` — an entry whose `st_dev` differs from the root's, or a
    path listed as a mount point at or below the candidate in the reading
    namespace's `mountinfo` (§3.2). Bind mounts of the same filesystem keep
    `st_dev`, so the `mountinfo` read is the primary check.
  - `unreadable-tree` — `EACCES`/`EPERM`/`EIO` on any directory read.
  - `entry-limit` — more than `TREE_INSPECTION_ENTRY_LIMIT` (200 000, the
    existing measurement limit) entries.
  - `changed-during-inspection` — `ENOENT` for an entry the walk just listed.
    Something is deleting or rewriting the tree now; that is activity.
- **Bound**: a checkout plus `node_modules` is 40 000–50 000 entries
  (counted read-only on the install checkout and the current release), so the
  limit covers four of them. A tree past the limit is **preserved**, reported
  as held with reason `entry-limit` and its measured lower-bound bytes, and
  left for the operator; the sweep never guesses at its age.

### 3.2 `mountPointsUnder(directory, via)`

Reads `/proc/self/mountinfo` (or `/proc/<pid>/mountinfo` for a root read
through another namespace, under the same `namespaceStill` anchor check),
decodes field 5 (octal escapes), and answers the mount points equal to or below
the candidate. Read once per sweep and again immediately before each removal.
Off Linux there is no `mountinfo`: the `st_dev` check in §3.1 is the only
boundary check, and a candidate whose root `st_dev` differs from its parent's
is held.

### 3.3 Rename, then remove

For every recursive `fs.rm` (D1, D3, the cache reclamation in §6.4):

1. Re-run the final guards.
2. `rename(candidate, <same parent>/<trash name>)`, an atomic same-directory
   rename. Trash names: `.delegatus-trash-<name>-<uuid>` beside the original
   directory in temp roots, worktrees and releases.
3. Re-scan processes (§3.4) for a holder of the trash path: a cwd or open
   descriptor follows the inode, so a process that entered the tree between
   the last check and the rename now shows the trash path. If one does,
   rename back and keep the tree as `inUse`.
4. Remove the trash path recursively.

An interrupted removal leaves only a trash-named directory. Its original name
no longer exists, so no later user can mistake a half-deleted tree for a whole
one. Each sweep replays trash only after rechecking the original policy,
current ownership, pins, Git metadata, mounts, freshness, inspection bounds
and process holders. The journal records a bounded path and file identity
snapshot; missing entries are allowed after an interrupted recursive remove,
while additions or changed extant files hold the trash. A journal explains a
rename and preserves evidence to check it again; it never grants lasting
permission to delete later contents.

### 3.4 Process scan, widened

`scanProcesses` (`tempSweep.ts:120-159`) adds, per process: `exe`, `root`
when it differs from `/`, the file paths in `maps`, and every `cmdline`
token that is an absolute path. Environment values for the listed variables
stay as they are. One extra read per process per sweep; the sweeps are hourly.
Release retention (§6.3) uses the same scan and also matches any `cmdline`
token or **any** environment value that contains the release path as a
substring, because releases are named inside larger values
(`LLV_TELEGRAM_VENDOR_DIR=<release>/…`, `bun <release>/bin/…`).
A process this user cannot read answers nothing and cannot be using a
directory of ours (unchanged rule).

## 4. Temp sweep (#2889)

### 4.1 Freshness and preservation rules

A candidate (owned name, direct child of a sweep root, same uid, a real
directory) is removed only when **all** of these hold, checked in this order:

1. Not pinned: no `.delegatus-keep` entry (any type) at the candidate's root.
   Held as `pinned`. This is the one new pin mechanism; it is a file an
   operator or a capture driver can create with `touch`. Worktrees and releases
   keep using `git worktree lock` (§5, §6).
2. `inspectTree` answers a `newestMs` older than the threshold and no hold.
   Young → `young`; a hold → `held` with its reason (the existing `held[]`
   report rows gain `mount-boundary`, `changed-during-inspection`, `pinned`).
3. No process holds it (§3.4), and no live or waiting conversation
   (`liveOrWaitingConversationCwds`, already used by the worktree sweep) has
   its cwd inside it. The second guard covers a spawn whose launch profile names
   the directory but whose process has not started yet.
4. Not a pipeline worktree, not inside or around one (unchanged).
5. Within the removal budget (500 per sweep, unchanged); otherwise `deferred`.
6. **Immediately before removal**, after the measurement: identity unchanged
   (`dev:ino`, realpath), a fresh process scan, a fresh conversation read, a
   fresh `inspectTree` (the full freshness walk again, not the shallow read),
   fresh worktree list, fresh `mountPointsUnder`, namespace anchor unchanged.
   Then rename, rescan and remove (§3.3).

### 4.2 Threshold, settings and preview

- `LLV_TEMP_SWEEP_MAX_AGE_HOURS`: default 24. A value below 24 is raised to 24
  with one warning. #2889 sets 24 hours as the minimum. `0` still turns the
  sweep off, as today.
- `LLV_TEMP_SWEEP`: `on` (default) | `off` | `dry-run`, parsed exactly like
  `worktreeSweepMode`. A dry run runs every guard, reports `removed` as "would
  remove" with bytes, renames nothing and deletes nothing. The report records
  `mode`.
- The report keeps its shape, adds `mode`, the new held reasons and
  `trashFinished`. `tempSweepStatus` (resources surface) shows the mode and held
  counts by reason. No new UI.

### 4.3 Beyond the bound

A tree past 200 000 entries, an unreadable tree, a tree with a mount point
under it, and a tree changing during inspection all stay, every sweep, as
`held` with reason and bytes. Nothing escalates them to deletion. They reach
the operator through the resources summary, which already reads "held N for
Git preservation or tree inspection". This is the answer to "a tree whose
freshness is uncertain or exceeds the inspection bound is preserved".

### 4.4 Serialization and the activation race

The sweep runs in the one Viewer that owns the release fence, on its own timer
that re-arms only after a sweep finishes, so two temp sweeps never overlap
(unchanged). The race with something starting to use a candidate has four
layers, each already present or added above:

1. Fresh activity: any write makes the tree young (§3.1).
2. Live processes and starting conversations (§4.1, item 3), read again last.
3. The rename (§3.3): a process that opens the old path after the rename gets
   `ENOENT` and fails loudly, never writing into a tree being deleted. A process
   that got in before the rename is caught by the post-rename scan, and the
   rename is undone.
4. Stage scratch directories are created fresh by `mkdtemp` per host
   (`structuredSpawn.ts:186`), and roots claimed later hold an open descriptor
   (`tempDirs.ts`), so a new activation never adopts an old candidate by name.

No lock is shared with the spawn path. The guards above reach the same result
without one, and a lock would make spawn depend on a sweep that can run for
minutes.

## 5. Worktree sweep (#2889)

The worktree sweep's policy stays: the 4-day finished-lane retention
(`FINISHED_WORKTREE_RETENTION_MS`), the squash-safe merged-PR containment proof,
remote-ref and base proofs, never forcing `git worktree remove`, keeping local
branch refs, `LLV_WORKTREE_SWEEP=dry-run`, and `git worktree lock` as the pin.
It changes in four places:

1. **24-hour quiet floor for every removal and trim.** Before a removal is
   attempted (after the existing proofs, before measurement) and again in the
   final block (`:1119` area, after `finalBusy`), `inspectTree(worktree)`
   must answer older than 24 h with no hold. Otherwise the checkout is kept as
   `recent-writes`, or with the hold's reason. Merged lanes, which today go at
   once, now wait until 24 h after their last write, as #2889 asks ("reclaim
   abandoned owned artifacts after at least 24 hours", "preserve any directory
   with recent descendant writes"). `recent-writes` joins `BUSY_REASONS`, so
   activity also restarts the retention clock of a finished lane. The same
   check runs on each trim target (D3) before its removal. The new kept
   reasons are `recent-writes`, `mount-boundary`, `entry-limit` (it already
   exists in the temp report) and `interrupted-removal`.
2. **Mount boundary.** `mountPointsUnder(worktree)` before measurement and
   again last; any mount point keeps it as `mount-boundary`. `git worktree
   remove` would otherwise delete inside a bind mount. The same check covers
   each trim target.
3. **Trim renames first.** D3 uses §3.3 (`.delegatus-trash-<name>-<uuid>`
   inside the worktree root, which Git ignores like the original rebuildable
   directory; the next sweep finishes it under the same identity checks).
4. **Interrupted removal is recorded and resumed narrowly.** Before
   `git worktree remove`, durably write `{path, root, head, preservation, at}`
   to `state/worktree-sweep-removals/<path-sha256>.json`; after success,
   remove that intent. Each path has one atomic record, so completed removals
   leave no growing journal. At sweep start, an open intent whose checkout is
   still listed is resumed only when HEAD still equals the recorded `head`,
   `git status` reports nothing but deletions of tracked files, every live guard
   passes and no mount point is under it. The sweep restores those missing
   tracked paths from the index and then runs ordinary `git worktree remove`.
   Anything else keeps it as `interrupted-removal`, a decision reason. The
   branch ref is never touched, so the recorded preservation proof still stands.

## 6. Self-update release retention (#2886)

### 6.1 Where it runs

One function, `retainReleases(record, inputs, ports)`, in a new
`src/lib/selfUpdate/retention.ts`, replaces `pruneReleaseWorktrees`. It is
called:

- after a seat or operator apply settles **done** and not rolled back
  (`service.ts:2039-2048`, after the history row and credential release);
- after an automatic checkout drain finishes (`finishCheckoutDrain`, which
  already calls the old function).

It never runs after an apply settles `failed` or `fell-back`, so a failed
activation keeps every directory, including the candidate and the rollback
target. Runs after a later success clean up.

### 6.2 Serialization

The service holds a `retaining` flag for the duration of the call. `reserve()`
(`service.ts:1395`) answers `busy("update")` while it is set, so no build,
apply or restart request is admitted until retention ends. Retention itself
starts only when the runner is not running, no apply is in
`building | ready | switching`, no managed deployment is active, and no
restart is pending. Otherwise it does nothing that time; the next settled
apply runs it. Both checks are synchronous in the one Viewer that holds the
release fence, so no await separates the check from the flag. Only that Viewer
runs self-update at all.

The first run after this ships removes the backlog (about 44 directories on
this machine). Each removal checks worktree contents and protected state; the
flag keeps updates out while retention runs. A seat
deploy that asks during it gets `busy` and retries, as it does for any
other busy state.

### 6.3 What is kept

Candidates are the registered worktrees of the install checkout directly under
`releasesDir` named `<sha12>` (unchanged), plus, for a package install
(`record.checkout === null`), the `npm-<semver>` containers directly under
`releasesDir`. Everything else under `releasesDir` is never touched. A
`<sha12>` directory Git does not list is reported as `unregistered` and kept.

Protected, never removed:

| Rule | Detected from |
|---|---|
| **Active**: the release the pointer names | `release-<installId>.json` `dir` (for a package install, its container). An unreadable or invalid pointer while the file exists aborts the whole pass with an error: nothing is removed when the active release cannot be named |
| **Serving**: what web, runtime host and launcher run | launcher record `web.revision`, `runtimeHost.revision`, `launcher.revision` as sha prefixes (unchanged rule) |
| **Rollback target** | the last apply intent's `rollbackPointer` (`apply.json`, kept after the apply settles) and `auto.rollbackPointer`; for a package install, `rollbackPackage` |
| **In flight** | the runner's `state.releaseDir` whenever its state is `running` or `failed` (a retry reuses it), and `releaseDirFor(apply.current.target)` |
| **Used by a running process** | §3.4 scan: any process whose cwd, exe, root, open file, mapped file, argv token or environment value is inside or names the release path. Read once to choose, and again immediately before each removal |
| **Pinned** | `git worktree lock` on the release (the porcelain `locked` line). A locked release is skipped and reported |
| **Recent** | built within the last 24 h. Age is the newest of `.next/DELEGATUS_RELEASE_READY`, `.next/BUILD_ID` and the directory's own mtime (package: the container's `package.json`) |
| **Newest K** | the `K` most recent remaining candidates by the same age, `K = LLV_SELF_UPDATE_KEEP_RELEASES`, default 3, minimum 1 |

The "recent" and "newest K" rules cover processes that use a release
without a visible reference at the moment of the scan. A pipeline stage's brief
names `<release>/scripts/gate-slot.sh`, resolved when the stage started
(`testGuidance.ts:19`), and its agent runs that path only when it runs a
check. On the busiest recent day there were eight deploys, so 24 hours plus
three covers any stage that lives less than a day past the deploy that
superseded its release.

**Bound.** Retained releases = protected ∪ recent ∪ newest K. With eight
deploys a day that is about ten directories. After cache reclamation each is
about 0.9 GB (sources, `node_modules`, `.next` without `cache/webpack`, `dist`),
so about 9 GB, against 91 GB and 49 releases on 2026-10-14. Past the bound,
for example many processes holding old releases, nothing protected is
removed. The report names each kept release with its reason and bytes, so a
large protected set is visible.

### 6.4 Build-cache reclamation point

In the same pass, for every **retained** release whose ready marker equals its
HEAD (`builtRevision(dir) === git rev-parse HEAD`), remove
`.next/cache/webpack` by rename-then-remove (§3.3, trash name
`.next/cache/.delegatus-trash-webpack-<uuid>`). The active and serving
releases are included. `fetch-cache` and any `images` cache are runtime data
and stay. A release whose marker is missing or names another commit is being
built, or failed its build, and keeps its cache so a retry builds faster.

One place handles both future builds and the accumulated backlog. A build that
is published but never applied keeps its 2 GB until the next successful apply;
that bounds the waste to one release. The alternative of reclaiming inside the
ready step (`steps.ts:313-321`) would add a failure path to a step whose only
job is to prove the build ready.

### 6.5 Removal

For each non-protected candidate, in oldest-first order:

1. Re-read the protected set (process scan, runner, apply, pointer) and
   `mountPointsUnder(dir)`. A change keeps the candidate.
2. Inspect Git status including ignored paths and index flags. Tracked changes,
   untracked files, hidden tracked edits and commits absent from relevant head
   or remote refs keep the release. Ignored output is removed only after the
   shared bounded generated-content proof and quarantine checks.
3. Withdraw the ready marker (`markBuilt(dir, null)`) and call ordinary
   `git worktree remove <dir>`. Git's final dirty-worktree check remains active
   for changes that arrive after the last status read. For a package container,
   rename-then-remove (§3.3) and re-read the complete protected set after rename.
4. **No `git worktree prune`.** `remove` deletes its own registration; the
   repository-wide prune (D6) is dropped. A release directory deleted by
   someone else leaves a stale registration that Git's own
   `gc.worktreePruneExpire` handles.

An interrupted removal can leave a partial worktree with its ready marker
withdrawn. A retry checks its contents first. When its only changes are missing
tracked files and the ready marker is absent, the retry restores those paths
from the index, verifies the checkout is clean, then checks out the target
without force. Any tracked edit, untracked obstruction or uncertain recovery
state refuses the retry and preserves the directory.

### 6.6 Failure handling

- Each candidate's failure is caught, recorded with its message, and the pass
  continues with the next candidate. The old code aborted on the first one.
- The pass writes `state/self-update/retention.json`
  `{ at, removed: [{dir, sha, bytes}], reclaimedCacheBytes, kept: [{dir, reason, bytes}], errors: [string] }`
  and prints one summary line. The resources payload gains
  `releaseRetention` beside `tempSweep` and `worktreeSweep`, with counts,
  bytes and an error count. No new UI.
- Retention runs after the apply's history row is written and its outcome
  stored, inside its own try/catch. A cleanup failure can never change an
  apply's `done` outcome, the snapshot's update state or the pointer.
- An unreadable pointer, an unreadable launcher record or a failed
  `git worktree list` removes nothing and records the error.

## 7. Failure handling, all paths

| Situation | Outcome |
|---|---|
| Tree unreadable, too large, mounted under, changing during inspection | kept, `held` with reason and bytes |
| Process scan unavailable (no `/proc`, scan throws) | temp sweep: falls back to the portable scan as today; release retention: removes nothing, records `scan-unavailable` |
| Rename fails | kept, error recorded |
| Remove of a trash path fails partway | trash stays and is finished next sweep; error recorded |
| Holder found after rename | renamed back, kept `inUse` |
| `git worktree remove` fails | worktree: `remove-failed` (unchanged); release: its tree is already removed, the registration stays, error recorded |
| Viewer killed mid-removal | temp/trim: a trash name remains and is revalidated next sweep; worktree: intent journal resumes or holds as `interrupted-removal`; release: the ready marker goes first, the partial tree waits behind its gate, and the next pass finishes it after the same gated checks only when every remaining entry matches the inventory recorded before deletion began (a changed partial tree stays in quarantine), never restoring it to its path; until then its registration stays, so `git worktree add` of that same revision is refused. An apply reaching a tree an older release's removal left partial restores only proven missing tracked paths |
| Retention throws after a successful apply | apply stays `done`; error in `retention.json` and the log |

## 8. Must-not-delete cases, each with a test

All tests use temp fixtures only: roots made by `mkdtemp` under the test's own
`TMPDIR`, injected `scan`, `mountinfo`, `now` and Git ports, and real Git only
in throw-away repositories. Run each file by path through `gate-slot.sh` with
isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, `LLV_STATE_DIR` and
`LLV_VIEWER_CONTROL_URL` on a closed port. They add local helpers only; shared
test fixtures and teardown (`test-preload.ts` and the like) are fenced by lane
60a2fd5c and stay untouched. A case that needs a real process spawns its own
child and stops it by the handle it kept, as `tempSweep.test.ts` does today.

### Temp sweep — `src/lib/tempSweep.test.ts`

| # | Must not delete | Test |
|---|---|---|
| T1 | a 48 h tree with a file written now at depth ≥ 3 | `a stale-looking tree with a fresh deep write is young` (red today: the isolated reproduction gives survives=false) |
| T2 | a 48 h tree whose deep file had its mtime restored but ctime is fresh | `a restored mtime with a fresh ctime is young` |
| T3 | (control) a tree whose only fresh times are `ctime` of hard-linked files is **removed** | `hard-linked dependency ctimes do not keep a stale tree` |
| T4 | a tree past the entry limit | `a tree past the inspection bound is held as entry-limit` (limit injected small) |
| T5 | a tree with an unreadable subdirectory | existing `an unreadable temp tree stays…`, extended to depth 3 |
| T6 | a tree with a mount point under it (injected `mountinfo`) and one whose child `st_dev` differs (injected stat port) | `a mount point under a candidate holds it; nothing under the mount is touched` |
| T7 | a symlink to an outside directory with fresh content, inside a stale tree | `a symlink inside a removed tree is unlinked and its target survives` |
| T8 | a pinned stale tree | `a .delegatus-keep file pins a stale tree` |
| T9 | a stale tree used by a live child via cwd, via an open fd at depth, via argv token, via a mapped file | `every process reference keeps a stale tree` (real child for cwd/argv; injected scan for maps) |
| T10 | a stale tree that is a starting conversation's cwd | `a starting conversation's cwd keeps a stale tree` |
| T11 | a tree written to between measurement and removal | `the full freshness walk runs again right before removal` (write injected through the measure seam) |
| T12 | a tree a process enters after the last check | `a holder found after the rename restores the tree` (scan port answers the trash path once) |
| T13 | anything in dry-run | `dry-run reports what it would remove and renames nothing` |
| T14 | a half-removed tree under its original name | `an interrupted removal leaves only a trash name, finished next sweep` (remove port throws after the rename) |
| T15 | a git checkout, a foreign name, `llv-spawn-sandbox`, another uid | existing tests, kept green |
| T16 | a threshold below 24 h | `LLV_TEMP_SWEEP_MAX_AGE_HOURS below 24 is raised to 24` |

### Worktree sweep — `src/lib/pipelines/worktreeSweep.test.ts`

| # | Must not delete | Test |
|---|---|---|
| W1 | a squash-merged clean worktree with a write in the last 24 h at depth | `a merged checkout with a recent deep write waits for the quiet floor` |
| W2 | a worktree with a mount point under it | `a mount point under a merged checkout keeps it as mount-boundary` |
| W3 | a trim target with a fresh write, or with a mount under it | `a build cache with recent writes or a mount is not trimmed` |
| W4 | a half-removed worktree with an untracked file, a new commit or a live holder | `an interrupted removal resumes only for pure deletions at the proven HEAD` (and its positive control removes the deletions-only case) |
| W5 | a trim interrupted mid-removal leaves the original name | `an interrupted trim leaves a trash name the next sweep finishes` |
| W6 | dirty, untracked, unmerged, locked, open-pipeline, live conversation, squash-merge proof, stale upstream, 4-day retention | existing tests, kept green; the quiet floor is satisfied in their fixtures by aging the tree |

### Self-update releases — `src/lib/selfUpdate/retention.test.ts` (new), `steps.test.ts`, `auto.test.ts`

| # | Must not delete | Test |
|---|---|---|
| R1 | the pointer's release | `the active release is never removed` |
| R2 | releases web, host and launcher run | `serving revisions are kept` (the existing `release cleanup only removes…` case moves here) |
| R3 | the rollback target from `apply.json` and from `auto.json` | `the last apply's rollback target is kept after the apply settles` |
| R4 | the runner's target (running and failed) and the apply's in-flight target | `an in-flight or retryable build directory is kept` |
| R5 | a release used by a live child through cwd, argv token, environment value, mapped file | `a release any running process names is kept` (real child for cwd/argv/env, injected scan for maps) |
| R6 | a release a process starts using between selection and removal | `the process scan is read again before each removal` |
| R7 | a locked release | `a locked release is skipped and reported` |
| R8 | releases built within 24 h, and the newest K | `recent and newest-K releases are kept; K follows LLV_SELF_UPDATE_KEEP_RELEASES` |
| R9 | anything when the pointer is unreadable, the launcher record is unreadable, or the listing fails | `an unreadable pointer or listing removes nothing` |
| R10 | a pipeline worktree registration whose directory is momentarily missing, in the same repository | `retention never prunes other registrations` (real Git: add a worktree, move its directory away, retain, the registration is still listed) |
| R11 | a non-release directory, an unregistered `<sha12>`, an entry outside `releasesDir`, a symlink named like a release | `only registered release worktrees and npm containers are candidates` |
| R12 | runtime caches (`.next/cache/fetch-cache`, `images`), `.next/BUILD_ID`, `.next/server`, `node_modules`, `dist` of any retained release | `cache reclamation removes only .next/cache/webpack` |
| R13 | `.next/cache/webpack` of a release without a matching ready marker | `a release being built or failed keeps its build cache` |
| R14 | a release with a mount point under it | `a mount point under a release keeps it` |
| R15 | the package install's active and rollback containers | `package containers follow the same protected set` |
| R16 | a half-removed release reused as an update target (steps) | `steps.test.ts`: `checkout of an existing release directory restores deleted tracked files` |
| R17 | anything after a failed or fell-back apply | `auto.test.ts`: `a failed activation runs no retention and keeps the candidate and rollback` |

### Acceptance coverage beyond must-not-delete

| Criterion | Test |
|---|---|
| repeated updates stay bounded | `retention.test.ts`: `ten successive applies leave protected + recent + K releases` |
| cleanup errors visible, success not misreported | `auto.test.ts`: `a retention failure leaves the apply done and records the error` |
| concurrent update and cleanup serialized | `auto.test.ts`: `an update request during retention answers busy; retention skips while a build runs` |
| seat/operator path reclaims (the live bug) | `auto.test.ts`: `a settled seat apply runs retention` (red today: no prune call) |
| backlog reclaimed | `retention.test.ts`: `the first pass removes every unprotected old release and reclaims retained caches` |
| removal counts, bytes, reasons, errors reported | assertions inside each test above on `retention.json`, the temp and worktree reports |

The application still serving after retention is covered by protection R1/R2,
R5 and R12. A live check on the operator's install is the deploy's job, not a
test's.

## 9. Options considered

- **Count-only release retention (protected + newest K).** Simplest, and
  what the old prune did with K=1. It fails the stage-brief case: on an
  eight-deploy day, K=3 reaches back about nine hours, while stages run
  longer. Chosen: K plus the 24-hour window, both settings with defaults.
- **Delete `.next/cache` in the ready step.** Rejected (§6.4): it puts a
  failure path into a proof step, and it would not reclaim the backlog.
- **Carry the previous release's `.next/cache` into the next build.** Faster
  builds, zero accumulation. Not demanded by either issue; deferred.
- **A machine-wide cleanup lock shared with spawn and build.** Rejected:
  freshness, process scans, the rename and the self-update `retaining` flag
  give the same guarantees without making spawn wait on a sweep.
- **A time budget per sweep in addition to the entry bound.** Not needed: the
  freshness walk stops at the first young entry, and stale trees were already
  walked in full by the existing size measurement.
- **mtime only (today's signal) for freshness.** Misses restored-mtime writes;
  ctime added for directories and single-link files only (§3.1).

## 10. Rollout

1. Ship. The temp sweep only becomes more conservative. The worktree sweep
   gains a 24 h floor, so merged checkouts leave a day later. Release retention
   starts at the next settled apply and preserves dirty or unpublished work.
2. The first settled apply after deploy removes only registered releases whose
   contents and commits pass the preservation checks and which are outside the
   protected set.
3. The operator can preview the temp sweep with `LLV_TEMP_SWEEP=dry-run` and
   the worktree sweep with `LLV_WORKTREE_SWEEP=dry-run`; their reports are
   on the resources surface.

## 11. Deferred — not currently justified

- Seeding a new release's build cache from the previous one (§9).
- A dry-run mode for release retention. Releases are generated and
  reproducible, and every removal is reported.
- Reclaiming `held` temp trees (past the bound, unreadable, mounted). They
  wait for the operator by design.
- A UI for pins or retention settings. Pins are a file and `git worktree
  lock`; settings are environment variables like the existing sweep knobs.
- Removing unregistered `<sha12>` directories under `releasesDir` (none exist
  today; they are reported).
- A stable path for `gate-slot.sh` in stage briefs, which would let release
  retention drop its 24 h window.

## 12. Validation against the requirement

The requirement is to work through the new issues on current code. Both issues
were re-read against `main` at `f746d7f2`. Their root causes were found in the
code: a shallow date at `tempSweep.ts:290-306`, and a prune reachable only
from the automatic drain while production deploys through seat applies.
Production state was read without writing to confirm both. Every acceptance
criterion of #2889 and #2886 maps to a rule in §4–§6 and to a test in §8.
Nothing beyond the two issues is built; the cut items are in §11.
