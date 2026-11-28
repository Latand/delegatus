# Stage scratch: shared package caches, honest accounting, prompt release

## Originating requirement

On 2026-11-28 the operator reported a defect: a review stage had copied the
machine's whole Bun install cache and uv cache into its own scratch, about
27 GB for one attempt. It should have used the shared cache or hardlinks.
A few such reviews in parallel would fill the disk within hours. The operator
also asked that an attempt's scratch be freed once the attempt finishes,
because their temporary manual cleanup only removes directories idle for six
hours. The source is the operator's defect report relayed to the orchestrator
seat on 2026-11-28, filed as the pinned task "Stages: shared package cache,
honest accounting and fast scratch release". The task is high risk, because
the sweeper deletes data on the production machine.

The pinned acceptance, in short:

1. Stages keep state isolation (HOME, XDG_CONFIG_HOME, LLV_STATE_DIR, TMPDIR).
   Bun and uv still reuse one shared machine cache, or hardlink or reflink from
   it. Delegatus sets no per-attempt package cache and no copy link mode by
   default, and the guidance says so. A stage that needs a clean cache may opt
   in.
2. The ledger measures each root's real allocation while it lives and once
   after its attempt ends, so the recorded total and the over-cap check match
   the disk.
3. Within minutes, the sweeper removes an ended, released root that nothing
   retains. The ownership and identity guards stay, and a live attempt's root
   is never removed.
4. Tests prove 1–3 and their red paths, file by file, in isolated state,
   through `scripts/gate-slot.sh`.
5. Required checks are the per-file runs, typecheck, the privacy gate and the
   pre-push hook. Production verification after deploy belongs to the seat.

This document makes no product edits. Each section names where the current
behaviour comes from, the smallest change, and the tests that prove it.

## 1. What happened, from the primary records

Observations made read-only on the production machine on 2026-11-27 between
23:00 and 23:40 UTC, from the attempt-temp ledger (`$STATE/attempt-temp.sqlite`,
opened `mode=ro`), its last report (`attempt-temp-report.json`, 23:20:31Z),
`du` and `bun pm cache`:

| Fact | Value |
| --- | --- |
| Shared Bun install cache (`$HOME/.bun/install/cache`) | 19 GB, 214,838 entries |
| Shared uv cache (`$HOME/.cache/uv`) | 7.8 GB, 159,325 entries |
| The incident root's two caches (from the task record) | 19.3 GB and 7.9 GB: whole copies of the two shared caches |
| Ledger rows | 3,387 (113 scratch roots on disk, 715 scratch rows whose directory is gone, 2,559 config roots) |
| Recorded total | 86.07 GB; effective cap 107.37 GB |
| Real allocation | 103,204,792 KiB in `$STATE/scratch`, 151,496 KiB in config roots |
| Recorded bytes of scratch rows whose directory is gone | about 33 GB |
| Rows in the allocation queue's eligible set at one instant | 3,351, served 4 per tick |
| Age of the last measurement | mean 742–779 minutes, max 1,570 minutes |
| Released, expired roots still on disk | 25 rows, 33.6 GB recorded |
| `trash_recovery` rows | 1,875: 1,639 whose original exists with its recorded identity and no quarantine journal, 236 whose original is gone and no journal |
| Last routine page | 32 visits: 29 `recovery_owner_unknown`, 3 `checkout_changed`; 0 removed |

The incident root's ledger row recorded 12,288 bytes. That is the root
directory, its `tmp/` and its owner marker, measured once right after
registration. The queue then needed about 3,351 / 4 ≈ 840 ticks to come back to
it, roughly fourteen hours. The attempt lasted 38 minutes. Release set the row's
expiry to completion plus 24 hours, so the routine page had nothing to remove.
The over-cap reclaim saw 85 GB under a 107 GB cap. The Cleaner starts below
150 GB free (`src/lib/cleaner/diskController.ts:21`), and 554 GB were free.
No path could have reclaimed the root.

Warm `du` costs about 3.8 µs per entry: 459,735 entries in 1.73 s,
235,090 in 0.81 s. A root holding both cache copies (about 500,000 entries)
fits the allocation window when it is reached. The window was never the
bottleneck; the 14-hour cycle was.

## 2. Acceptance 1: shared package caches

### Where the per-attempt cache came from

- Every structured host copies HOME and XDG_CACHE_HOME from the Viewer
  through its allowlist. These are `codexAppServerHost.ts:320-351`,
  `claudeStreamBrokerHost.ts:535-548`, `copilotAcpHost.ts:160-184` and
  `antigravityAcpHost.ts:704-811`. Each calls `withAgentConfigSandbox`
  (`agentConfigSandbox.ts:86-140`), which replaces only XDG_CONFIG_HOME,
  LLV_STATE_DIR and GH_CONFIG_DIR. A stage that touches nothing uses the shared
  caches.
- The stage brief tells every stage to run tests with "isolated HOME,
  XDG_CONFIG_HOME, TMPDIR and any state-directory variable"
  (`src/lib/pipelines/testGuidance.ts:11,14`). `AGENTS.md:218-221` says the
  same for this repository. The resolution order, measured with `bun pm cache`
  and `uv cache dir` under Bun 1.4.0 and uv 0.12.21, is:
  - Bun: `BUN_INSTALL_CACHE_DIR`, then `$BUN_INSTALL/install/cache`, then
    `$XDG_CACHE_HOME/.bun/install/cache`, then `$HOME/.bun/install/cache`.
  - uv: `UV_CACHE_DIR`, then `$XDG_CACHE_HOME/uv`, then `$HOME/.cache/uv`.

  An isolated HOME therefore moves both caches into the attempt and starts
  them cold. According to the task record, the incident reviewer's script
  then set `UV_LINK_MODE=copy` and pointed `UV_CACHE_DIR` and
  `UV_PROJECT_ENVIRONMENT` at its scratch. Its Bun cache carried the shared
  cache's older modification times: it had been copied from the machine cache.
- Delegatus itself moves the caches for one engine. `antigravityChildEnv` sets
  `XDG_CACHE_HOME` to `<sandbox root>/cache` (`antigravityAcpHost.ts:812-816`).
  For a pipeline stage that root is the attempt's own `llv-stage-config-*`
  directory (`agentConfigSandbox.ts:59-62`). So both package caches of an
  Antigravity stage are per attempt by default.
- No Delegatus code sets `UV_LINK_MODE`, `UV_CACHE_DIR` or
  `UV_PROJECT_ENVIRONMENT`; a repository-wide search finds none.
- `src/lib/pipelines/provisionPrivateDependencies.ts:600` sets
  `BUN_INSTALL_CACHE_DIR` for the in-place private install. That directory is
  `<checkout>/.delegatus-dependencies-<claim>/cache` (`:439-441`), inside the
  lane checkout and outside stage scratch. It belongs to lane provisioning,
  once per lane, and is removed by the same call (`:512-517`). It is private
  because the bound installer may write only to the descriptors it is handed
  (`provisionToolchain.worker.ts:130`).
  The staged private install (`:497-500`) already uses the shared download
  cache. Both use `--backend=copyfile` for the lane's `node_modules`, so a
  stage's writes into its dependencies never reach the shared cache
  (`docs/design/pipeline-package-installs.md`). Those copies are the lane's
  installed dependencies, made once per lane, and they stay.

### Smallest change

1. **Pin package caches for every stage.** In
   `materializeStructuredHostAccess`, on the full-access branch
   (`structuredSpawn.ts:264-303`), set `BUN_INSTALL_CACHE_DIR`, `UV_CACHE_DIR`
   and `GOMODCACHE` from the Viewer environment. Go defaults its module cache
   to `$GOPATH/pkg/mod`, or `$HOME/go/pkg/mod` when GOPATH is unset; pin that
   resolved path before the stage HOME changes. Existing explicit values win. On
   Windows, uv uses `%LOCALAPPDATA%\uv\cache`; the #4167 branch already has
   that form in `agentArtifactCacheEnv`. Both variables outrank XDG_CACHE_HOME
   and HOME, so a test that isolates HOME or XDG keeps the shared cache. The
   Antigravity keeps private XDG roots for native app data while package cache
   variables point at the shared machine roots.
2. **Carry them through the one seam every host shares.** In
   `withAgentConfigSandbox`, copy the two names from `source` when they are
   set. All four hosts and the headless reviewer pass through it, so no
   allowlist changes.
3. **Keep restricted writes blocked.** Restricted stages also receive the
   shared cache paths. The sandbox grants no write access to those roots, so
   package managers cannot silently create attempt-local cache trees under the
   private XDG cache. A restricted stage that must install explicitly selects
   its own cache under TMPDIR.
4. **Keep check reuse stable.** `scripts/gate-cache.ts` keys every `BUN_*`
   variable (`:126`), and the Viewer's publication runs the hook without the
   stage's variables. A check step a stage passed would otherwise get a new
   fingerprint and not be reused. Add both names to `ROOTS` (`:118-119`): they
   names name locations and do not change what a check checks. Also skip `ROOTS`
   names in `checkInputEnvironment` (`:162`), which feeds the baseline-sample
   key (`scripts/local-gate-tests.ts:536`) and the cloud canonical environment
   (`scripts/cloud-checks.ts:134`). The remote gate runner never sends unlisted
   names (`scripts/gate-runner/env-classes.ts:83-86`) and needs no change.
5. **Guidance.** Change the two isolation sentences in `testGuidance.ts:11,14`.
   That text is appended to every stage brief, builder and reviewer included.
   Isolation covers HOME, the XDG directories, TMPDIR and state directories.
   It does not cover package caches:
   - keep `BUN_INSTALL_CACHE_DIR`, `UV_CACHE_DIR` and `GOMODCACHE` as the stage environment
     sets them;
   - never copy a package cache into scratch;
   - leave uv's link mode at its default;
   - a check that needs a clean cache names its own cache directory under
     TMPDIR and says so in its report;
   - a check that modifies installed files uses `UV_LINK_MODE=copy` for that
     environment only;
   - a restricted stage uses the shared cache as read-only and selects a cache
     under TMPDIR explicitly if it must install.

   Add the same rule after `AGENTS.md:221`. Hardlinks are free here: uv's
   default hardlinked an installed file from the cache (link count 2), and
   scratch and the caches share one filesystem.

### Tests (behaviour only)

| File | Case | Red path |
| --- | --- | --- |
| `src/lib/runtime/structuredHostAccess.test.ts` | Full and restricted env resolve shared Bun, uv and Go module caches across two isolated homes | Restricted env must not fall back to its attempt-local XDG cache |
| same | Neither value lies under the attempt's scratch or config root | Fails on main for an Antigravity child env |
| `src/lib/runtime/agentConfigSandbox.test.ts` | Values in `source` reach the child env; absent values stay absent | — |
| `src/lib/runtime/antigravityAcpHost.test.ts` | Full and restricted `antigravityChildEnv`: real `bun pm cache` and `uv cache dir` resolve the shared path after HOME and XDG isolation | Both commands must avoid `<attempt config root>/cache` |
| `scripts/gate-cache.test.ts` | `environmentFingerprint(checkEnvironment(env))` is equal with and without the two variables; `checkEnvironment` still passes their values | — |

## 3. Acceptance 2: measured while it lives and once after it ends

### Where the current numbers come from

- Registration writes `bytes=0`, `measuredAt=0`, `allocationAttemptAt=0` and `checkedAt=createdAt`
  (`attemptTempRetention.ts:153-154,224-225`).
- The minute tick's preparation measures up to 64 due roots in one `du`
  invocation within a 5-second window (`attemptTempProduction.ts:28,233-262`).
  Grouping the page lets GNU `du` count a hardlinked inode once across roots.
  The queue orders by `allocationAttemptAt` and
  admits every row whose last attempt is at least a minute old and whose size
  is zero, stale or otherwise due (`attemptTempRetention.ts:561-568`). Live
  roots, ended roots, config roots and rows of vanished directories share a
  bounded round robin.
- Release sets `released=1, checkedAt=0`, resets the full sample and queues a
  new observation. A separate attempt timestamp prevents a timeout from
  masquerading as a successful sample.
- An expiry-page visit of a finished root with a recorded size reuses that
  size (`recordedOnly`, `attemptTempRetention.ts:1072-1076`). Its window
  follows that size (`attemptTempRootWindow`, `:78-80`), so a 29 GB root
  recorded at 12 KiB gets the 5-second window.
- Phantom bytes come from two places. A missing directory keeps its bytes while
  a `trash_recovery` row exists (`attemptTempProduction.ts:249-250`; over-cap at
  `attemptTempOverCap.ts:105-111`). The recovery page drops a row only when the
  original still exists with its identity (`attemptTrashRecovery.ts:179-185`).
  A row for a vanished original and no journal is held for good (`:187`). The
  236 such rows carry 14.8 GB that can never be measured to zero. They are
  directories someone else removed after an intent was queued (§4).

### Smallest change

1. **Separate successful observations from attempts.** `measuredAt` advances
   only with a complete allocation sample. `allocationAttemptAt` schedules
   retries without replacing the last full size. Release clears both timestamps
   so the post-completion sample is due. Compare-and-set still rejects a release
   or owner change that races the walk.
2. **Measure shared inodes once and keep the queue fair.** The production page
   sends up to 64 valid roots to one `du` command, which deduplicates hardlinks
   across its operands. A timed-out command records no full sample; attempt
   timestamps are staggered so the same slow first root cannot pin later roots
   at the head of the next page. Preparation remains bounded by five seconds.
3. **Stop charging vanished directories.** Apply the stale-intent rule of §4.
   It clears a recovery row that has no quarantine journal. The existing
   missing-root paths then record zero (`attemptTempProduction.ts:249-250`)
   and forget the row (`attemptTempRetention.ts:1517-1522`).

The ledger adds an indexed `allocationAttemptAt` column alongside the
successful-sample timestamp. Existing rows backfill their attempt time from
`measuredAt`.

### Tests

| File | Case | Red path |
| --- | --- | --- |
| `src/lib/runtime/attemptTempProduction.backfill.test.ts` | A large live root beyond 40 older rows is measured in one production page | The root remains at its first size |
| same | An incomplete attempt leaves `measuredAt` unchanged and cannot satisfy the post-release full sample | A timeout advances `measuredAt` and retirement accepts the old size |
| same | Two roots sharing an 8 MiB hardlink are charged once; removing one name keeps the charge while the other remains | Independent `du` walks double count or drop the remaining allocation |
| same | A directory removed by someone else, with a stale intent row and no journal, counts zero after one tick and its row is gone | On main its bytes stay in `store.bytes()` |
| same | A pending quarantine (journal present) keeps its recorded bytes | Guards the existing custody rule |

## 4. Acceptance 3: prompt release of ended, released roots

### Where the 24 hours and the zero removals come from

- **The clock.** `attemptScratchExpiry` returns completion plus
  `ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS`, 24 hours and 1 ms
  (`attemptScratchPolicy.ts:6-7,27-35`). The expiry page needs `expired`
  (`attemptTempRetention.ts:1060-1062,1259-1262`; `requireExpired` and
  `scheduledOnly` at `attemptTempProduction.ts:231`). Over-cap reclaim and the
  Cleaner take an ended root earlier only under pressure, only for a closed or
  completed lane, and only after three idle hours
  (`attemptTempOverCap.ts:13,64-70`; `diskSweep.ts:21`).
  `docs/design/disk-self-care.md:850-852` deferred a shorter clock because 24
  hours matched the operator's manual practice then. This requirement reverses
  that deferral.
- **The stale intent.** Before a routine dispatch the sweep queues a trash
  intent (`attemptTempRetention.ts:1395`). That way a cut quarantine of a config
  root, whose journal lies outside the scratch discovery scan, can still be
  recovered. Dispatch is often refused after that point (§1: every visit that
  reached dispatch was refused with `checkout_changed`). The intent then stays.
  `recoveredTrash()` is true for any row (`attemptTrashRecovery.ts:54`), so each
  later visit holds the root as `recovery_owner_unknown`
  (`attemptTempRetention.ts:1003,1027-1031`). The only cleanup is the recovery
  page, one candidate per tick (`attemptTrashRecovery.ts:164-166`). With 1,875
  rows that is more than a day per root, and the 236 rows for vanished
  originals never clear. This is why 25 released roots holding 33.6 GB were
  still on disk 7 to 200 hours after expiry, and why 29 of the 32 routine
  visits were spent on such holds.
- **The retry.** A visit held after its expiry steps back
  `EXPIRED_HOLD_RETRY_MS`, 30 minutes (`attemptTempRetention.ts:89,1553-1568`).
  That includes `checkout_changed` (`:1378-1383`), a refusal that only says a
  live checkout's directories changed while the visit ran. On a machine with
  many writing agents that is frequent, and every retry costs another half
  hour.

### Smallest change

1. **Clock.** In `attemptScratchExpiry`'s per-attempt branch
   (`attemptScratchPolicy.ts:27-35`), a released root expires at completion
   plus 1 ms; an unreleased root keeps 24 hours. The function gains an optional
   `released` field on its owner argument. Every caller already passes the
   ledger row: `release()` (`:357-361`), `schedulePipeline`, the audit and
   each visit's authority read. The legacy recovery path passes no flag and
   keeps 24 hours. Standalone agents' roots use a separate clock
   (`attemptTempProduction.ts:34-51`) and are unchanged. `release()` writes the
   new expiry, so the root is due at the next tick. Rows released before the
   deploy get the new expiry from the hourly audit
   (`attemptTempProduction.ts:238-241`, 128 rows per page).
2. **One stale-intent rule, two call sites.** A `trash_recovery` row with
   `restored=0` and no quarantine journal is stale in two cases. Either the
   original exists with the recorded identity (nothing was moved), or the
   original is gone (nothing is left to recover). The journal is written
   durably before the rename (`src/lib/tempSweep.ts:844-847`), so "no journal"
   means no quarantine is in flight. Outside dry-run, delete such rows:
   - at the start of every visit, before `recoveredTrash` is read
     (`attemptTempRetention.ts:1003`);
   - in the recovery page in place of its present-only rule
     (`attemptTrashRecovery.ts:179-187`).

   This removes a leftover and adds no state. The present case is the rule the
   recovery page already applies, run where the visit can see it.
3. **Retry consumer release and repair progress promptly.** An open lane's
   durable worktree/repository checkout is observed at retirement admission and
   again at dispatch. When that checkout releases its scratch link, or a bounded
   permission-repair slice made progress, the root is due on the next minute
   sweep. Permission-repair continuation gets the 30-second root window. Each
   visit still repeats every authority, identity and mutation proof.

The routine page's order, cursor and 32-visit budget stay. Once the
stale-intent rule has cleared the backlog, the due set is small and each tick
reaches new releases.

### Safety: why a live or retained root is never removed

The change moves one clock, for one class of row, and removes a leftover row.
It changes no proof that runs before deletion. Each guard below is unchanged
and runs on every visit.

**A live attempt.**

- The authority returns no expiry while the attempt is running or spawning, or
  has an activation or an unresolved termination (`attemptScratchPolicy.ts:20`).
  It returns none while a passed attempt still holds the stage cursor (`:26`).
  These returns come before the per-attempt branch, so `released` cannot create
  an expiry for them. Without an expiry the state is `live` or `unknown`
  (`attemptTempProduction.ts:62-67`), and the expiry page refuses it
  (`attemptTempRetention.ts:1060-1062,1259-1262`). A host re-hosted after a
  restart gets a new root from `mkdtemp` (`structuredSpawn.ts:230`). Its old,
  released root still belongs to a running attempt and stays held.
- `released` is set only by `release()` (`attemptTempRetention.ts:356`). Hosts
  call it after the leader process is reaped: Claude at
  `claudeStreamBrokerHost.ts:2846-2890,2907-2921`, Codex after its signal
  domain has retired at `codexAppServerHost.ts:3885-3913`. No writer sets it
  back to 0. A row re-created after it was forgotten starts at 0, and a stale
  read of 0 only keeps the 24 hours.
- Any surviving process of the attempt carries `TMPDIR=<root>/tmp`
  (`structuredSpawn.ts:268,293`). The process scan records every environment
  value (`tempSweep.ts:328-334`), and a value containing the root is a
  reference (`attemptTempFilesystem.ts:584`). That gives `process_reference`
  at observation (`:654`) and again at dispatch (`processInputsClear`,
  `attemptTempRetention.ts:1175-1182`). Working directories, open and mapped
  files, arguments, Unix sockets and container mounts are checked the same way.
- Identity, physical ancestry and the canonical scratch or config namespace are
  checked at selection, after every await and inside the mutation fence
  (`attemptTempRetention.ts:1009-1017,1140-1160,1183-1189`), together with the
  lane's retirement claim (`:948-951,1356`).

**A retained root.**

- *Declared evidence until close* (`retainUntilClose`) skips the per-attempt
  branch (`attemptScratchPolicy.ts:27`) and keeps the lane-finish clock.
- *A lane close in progress, unconfirmed hosts, or a pending remote action*
  skip the same branch (`:27-28`).
- *Recorded-check custody* is checked at `attemptTempRetention.ts:1092-1133`,
  `1274`, `1342`, `1361`, and in `ownerAuthorityCurrent`, `:1147`.
- *Report pictures linked into the root* hold it (`:1292-1295,1148`).
- *A `.delegatus-keep` marker, a Git or mount boundary, or tree evidence* hold
  it (`:1296-1305,1485-1488`).
- *An open lane whose checkout links into the root* holds it even when no
  consumer process is running (`:1350`, `1191-1205`); checkout state is read at
  admission and again at dispatch. Any live process checkout with such a link
  (`attemptTempFilesystem.ts:661-700`).
- *Permissions the sweep cannot clear* hold the root for the operator
  (`attemptTempRetention.ts:955-972`).

**The stale-intent rule.** It never deletes a directory. It deletes a row only
in two states: a missing journal with an unmoved original, or a missing journal
with a vanished original. In both, recovery has nothing to restore. A row with
a journal, or one the recovery page has bound (`restored=1`), is kept. The visit
that follows runs the full proof or the existing missing-root path.

**What the faster clock gives up.** Files an ended stage left in its TMPDIR
disappear within minutes; they used to last a day. That is the stage contract:
TMPDIR is removed when the stage settles. Evidence belongs under `LLV_EVIDENCE_DIR`,
which is outside scratch, or in a linked report, which holds the root.

### Tests

These live in `src/lib/runtime/attemptTempRetention.scheduling.test.ts` and
`attemptTempProduction.test.ts`. They drive real production ticks with a
supplied process scan and no live scanner, in private state.

| Case | Expected | Red path on main |
| --- | --- | --- |
| Passed attempt, root released 2 minutes after completion | Removed by the next tick (`retired`) | Held until 24 hours |
| Same root not released | Kept until 24 hours | Guards the unreleased path |
| Running attempt, root released (re-host) | Kept, `owner_live` | — |
| Ended, released root whose supplied scan lists a process with `TMPDIR` inside it | Kept, `process_reference` | — |
| A paused lane's persisted checkout links a released producer payload with an empty process scan | Payload stays until the checkout link is removed, then the next sweep retires it | Process-only inventory misses the paused consumer and leaves a dangling link |
| `retainUntilClose` root of an open lane; recorded-check custody; linked report picture; keep marker; passed attempt with the stage cursor still on it | Each kept, with its existing reason code | — |
| Intent row with unmoved original and no journal | Root removed by the next tick | Held `recovery_owner_unknown` |
| Intent row, original gone, no journal | Row forgotten; bytes leave the total | Held forever |
| Quarantine cut with its journal present | Intent kept; the existing replay finishes or restores it | Guards custody |
| Dispatch refused with `checkout_changed` | Next visit due within 60 seconds | Due after 30 minutes |
| Permission repair makes bounded additive progress through 3,395 read-only Go-cache directories | Retry next minute with a 30-second continuation budget and retire within minutes | Retry waits 15 minutes between short slices |

## 5. Existing tests that enter the changed paths

Released roots now expire at completion. Cases that release a root and expect
the 24-hour or over-cap behaviour change outcome:

- `attemptTempOverCap.test.ts`: the fixture `make()` releases every root (`:61`).
  Cases from `:109` to `:413` rely on a finish "inside its 24 hours". The
  fixture gains a `released` flag, false for those cases, so they keep testing
  the 24-hour path that unreleased roots still use. New cases cover released
  roots.
- `attemptTempProduction.test.ts`: the cases at `:59`, `:142`, `:192` and
  `:498` ("before expiry"), plus `:1357`, `:1440` and `:1487`.
  `attemptTempProduction.backfill.test.ts:35-83`.
  `attemptTempRetention.scheduling.test.ts:71`. `attemptTempApproved.test.ts:31`,
  because an approved list follows the same scratch authority. Each runs by
  path on head and on main; a case that tests the 24-hour path stops releasing
  its root.
- A case that calls `measure()` before `release()` and then runs a production
  tick now gets its fake size replaced by the real `du`
  (`attemptTempProduction.test.ts:1357,1440,1487`). Such fixtures measure after
  release. `attemptTempRetention.test.ts` calls
  `sweepAttemptTemps` without preparation and is unaffected.

Every case builds its own state root (`mkdtemp` plus `LLV_STATE_DIR`), so no
ledger or cursor crosses cases. The module-level `checkoutReads` map
(`attemptTempProduction.ts:27`) lives for the test process; its keys are
per-case paths.

## 6. The open #4167 branch

`pipeline/scratch-4167-*` (last commit 2026-11-21, no pull request, issue open)
adds `agentArtifactCacheEnv` to `withAgentConfigSandbox` for every stage, and
keys `UV_CACHE_DIR` in `gate-cache.ts`. `git merge-file` on scratch copies, with
the merge base `6b17236960` and this design's planned edits, gave:

- `agentConfigSandbox.ts`: one line conflict at the same insertion point, caused
  by this design.
- `gate-cache.ts`: two conflicts, both already present between main and the
  branch (`KEYED`, `TRANSPORT`); the `ROOTS` edit adds none.
- `AGENTS.md`: the branch edits a different section.

The branch's test "fresh attempts reuse package artifact caches"
(`agentConfigSandbox.test.ts`) needs two behaviours this design changes. It
expects derivation inside `withAgentConfigSandbox` for any source; here,
derivation happens for full-access stages only. It expects
`$HOME/.bun/install/cache` while `XDG_CACHE_HOME` is set, where Bun itself uses
`$XDG_CACHE_HOME/.bun/install/cache`. The combined tree cannot be built until
the branch's two existing conflicts are resolved, so its tests were not run
against it. This lane takes the cache slice. If #4167 resumes, it drops its copy
of the pin and keeps its other scope.

## 7. Checks and rollout

- Run the named test files by path with
  `bash scripts/gate-slot.sh bun test <file>`. Use a private HOME,
  XDG_CONFIG_HOME, XDG_CACHE_HOME, TMPDIR and LLV_STATE_DIR under the stage
  TMPDIR, and `LLV_VIEWER_CONTROL_URL` on a closed port. Never run whole
  runtime or registry directories.
- Run `bun scripts/local-gate.ts check-step types`, the privacy gate
  (`bun scripts/privacy-publication-gate.ts --require-known-values
  --check-commits --base origin/main`) and the pre-push hook.
- On the first ticks after deploy, the stale rows clear and the expired backlog
  goes: about 1,600 config roots (0.11 GB) and the released scratch roots that
  pass their proofs. That is at most 32 visits a tick, within the existing
  40-second budget. The seat verifies afterwards:
  - the ledger total against `du`;
  - removals per tick;
  - hold reasons, especially `checkout_changed`;
  - that a fresh released root is gone within minutes.

  The operator's temporary six-hour cleanup can then be retired.

## 8. Validation against the requirement

| Requirement | Section | How it is met |
| --- | --- | --- |
| A review stage never copies the machine caches into its scratch | §2 | Full-access stages carry the two cache variables, so HOME or XDG isolation no longer moves the caches. The brief and AGENTS.md forbid copies and copy link mode. Antigravity loses its per-attempt default. |
| Parallel reviews do not exhaust the disk | §2, §3 | No per-attempt caches; venvs hardlink from the shared uv cache; the ledger sees growth within a lap of minutes, so the over-cap check fires on real sizes |
| An attempt's scratch is freed when the attempt finishes | §4 | A released root expires at completion. Stale intents no longer hold it, and a changed checkout retries the next minute. Every guard stays. |
| A live root is never removed | §4 safety | Authority, monotonic release after reap, environment and file references, identity and claim, all unchanged |

## 9. Deferred — not currently justified

- **A shared cache for the in-place private install**
  (`provisionPrivateDependencies.ts:600`). It is transient, once per lane, and
  removed in the same call. Sharing would widen a write-restricted installer to
  the machine cache. Its cost is one download per provisioning; it leaves no
  lasting allocation.
- **Hardlinked lane `node_modules`.** The copy keeps a stage's writes out of the
  cache every lane reads.
- **A writable shared cache for restricted stages.** The sandbox keeps shared
  package roots read-only; a restricted installer chooses a cache in TMPDIR.
- **The prompt clock for standalone agents and seats** (no lane). Their
  conversations resume across hosts, and the requirement names stage attempts.
- **A resumable `du` or an inode side index.** Grouped page measurements count
  hardlinks once. Reconsider if a production allocation page still exceeds its
  time bound after the queue drains.
- **Fresh-release priority in the routine page**, if the due set stays large
  after the drain.
- **A per-attempt disk allowance** (the #4167 branch). It is no longer needed to
  stop cache copies.
- **Limiting parallel dependency-installing reviews.** The seat schedules that;
  the product needs no rule for it.

## 10. Could not confirm

- **How often `checkout_changed` refuses over a day.** Only the last report was
  available. The service journal lines found belong to another installation
  (their ledger totals did not match).
- **Whether a read-only Claude stage can write the shared caches.** The
  read-only rule above applies to every engine.
- **The incident reviewer's own script.** Its settings come from the task
  record; that lane's files were not read.
