# Runtime image writer gate: descriptor-bound owner, no staging directory

Status: implementation design, updated 2026-11-12 for the two gate-path review
findings on PR #3931. Historical round details remain below; §5 describes the
accepted descriptor-bound gate protocol.

## 0. Originating requirement

Board task, 2026-11-12, opened after the «Minimum macOS SQLite» job failed at
07:47Z on an unrelated pull request (#3915): the test «concurrent runtime image
writers cannot exceed the global byte quota» fails intermittently on that job,
and the flaky check blocks merges that never touch image storage. The fix lives
on PR #3931.

The pinned specification for this second successor (2026-11-12), paraphrased:

1. Design first: the smallest mechanism that keeps the `e9016ee4` fix (a live
   writer never loses its queue place) and leaves no unbounded hidden leftovers
   after an interruption. Candidates named: a single-file gate created
   exclusively plus a rename; staging inside the store's own temp area, which
   the existing partial-file cleanup covers; or dropping the directory gate if
   the fix does not need it. Removing machinery is a good result.
2. Any deletion that remains acts only on the object the code examined, never
   on a live owner's files or anything outside the store root. The two review
   probes from the first successor (quarantine safety, quarantine recovery)
   pass, together with `e9016ee4`'s recovery regression.
3. The original quota assertions keep their strength: four writers, exactly one
   success, three quota refusals, the same byte limit. The full store test file
   passes on the default SQLite and on SQLite 3.39.4.
4. Typecheck, lint and privacy pass.

The specification also states the reason for this round: each earlier round
added deletion machinery, and each added a hazard. Prefer the simplest
mechanism.

## 1. Decision

Keep the directory gate layout for mixed-version readers. Create it in place
with `mkdir`, open it using `O_DIRECTORY | O_NOFOLLOW`, and compare its opened
device/inode with the current gate entry. Publish `owner.json` by linking the
complete queue ticket through that held directory descriptor (`/proc/self/fd`
on Linux, `/dev/fd` on the portable path). Read and unlink a dead owner through
the same descriptor. Release only our owner file through the descriptor and
keep the now-empty fixed-name gate directory for reuse. This bounds crash
debris to one directory and removes path-based gate deletion. Delete the
staging directory, its cleanup, its quarantine and their tests.

The final change keeps ticket publication intact, replaces path-based gate
operations with descriptor-relative owner operations, and removes staging and
quarantine cleanup. The fixed empty gate directory is reused across writers.

## 2. How writers queue today

A write passes two locks (store, `7cab7bd4`):

- **The acquisition queue and gate** (`withWriterAcquisitionGate`, :684–760).
  Each attempt publishes a ticket `<now>-<pid>-<uuid>.json` in
  `.writer-lock-gate.queue/` (:693–706). It scans the queue and retires tickets
  whose owner is unreadable or dead (:715–723, `rmSync` at :719). The first
  live ticket takes the gate directory `.writer-lock-gate` with `owner.json`
  inside it (:724–745). Older releases read the gate's owner at exactly that
  path (`main` :702–708).
- **The writer lock** `.writer-lock/` (`withWriterLock`, :621–682): `mkdir`
  plus `owner.json`, stale reclamation (:656–661, :766–790), and a final token
  check before the quota-critical section (:672–674). The gate serialises the
  reclamation (comment at :762–765). The quota itself is safe as long as this
  lock is exclusive, and no round changed it.

`readOwnerFile` (:476–493) returns `null` for a missing file, a symlink and
unparseable JSON, and throws on any other error, including `ENOTDIR`.

## 3. What each round fixed and broke

| Round | Change | Result |
|---|---|---|
| `main` | Ticket written in place with `writeFileSync(ticket, …, "wx")` (`main` :685). Gate written as `mkdir(gate)` then `writeFileSync(gate/owner.json)` (`main` :702–703). An ownerless gate is retired at once (`main` :707–708). | **The flake.** `writeFileSync` creates an empty file before it writes. A peer that scans the queue in that interval reads `null` (:484) and retires the live ticket (:719). That writer never reaches the head and times out after `writerLockWaitMs`. |
| `0c122ec8` | Ticket staged as `.writer-ticket.<token>.partial` in the root, then renamed into the queue (`e9016ee4` :701–705). | Fixes the flake. The partial is a root file ending in `.partial`, so the startup cleanup already retires it after an hour (`e9016ee4` :791–800). |
| first review | A queue head held before its ticket rename becomes head later and finds a gate whose owner is not written yet. `main`'s rule retires it, and the gate's writer fails with `ENOENT`, exit 1. | Second race, same quota test. |
| `dcdb689a` | Gate as a single file published with `link()`. Reader retires an ownerless gate only once older than `writerLockStaleMs`. | Fixes the second race. |
| second review | An older release still running (for example an MCP process finishing a call after an update) opens `gate/owner.json` and gets `ENOTDIR`. Its write fails with exit 1 where it should succeed or refuse on quota. | **The gate has to stay a directory with `owner.json` in it.** |
| `e9016ee4` | Directory gate staged as `.writer-lock-gate.<token>.partial/owner.json`, renamed into place (:696, :709–710, :728). Reader rule kept (:733–742). | Fixes both races. The staging directory is created at the start of every attempt. A writer killed after :709 and before the rename at :728 or the removal at :755 leaves it, and the startup cleanup skips directories (:794). **P2: unbounded leftovers.** |
| `10335db9`, `7cab7bd4` | Directory branch in `removeAgedPartials` (`7cab7bd4` :795–844): token regex, owner proven dead, rename to `.writer-lock-retire.<uuid>`, inode check, `unlinkSync`, `rmdirSync`, restore. | **P1** at :829: the quarantine path can be swapped after the last read at :825, so `unlinkSync` removes a foreign or live `owner.json`, and :831 removes the live directory. **P2** at :812: a SIGKILL after the rename at :814 leaves `.writer-lock-retire.<uuid>` forever, because the matcher at :798 never matches that name. |

The outcome to keep has two halves. Tickets are published complete (the
original fix). A gate is never retired while its writer is still publishing the
owner (the first review). The constraint is the directory layout that older
writers read (the second review). The staging directory is the only source of
the leftover, and the quarantine exists only to clean it up.

## 4. Options weighed

| Option | Verdict | Reason |
|---|---|---|
| A. File gate created exclusively (`link()` or `O_EXCL` plus `rename`), no directories | Rejected | That was `dcdb689a`. An older writer reads `gate/owner.json`, gets `ENOTDIR`, and `readOwnerFile` rethrows it (:483). The second review reproduced this as exit 1. |
| B. Stage the gate in the store's temp area so the existing partial cleanup covers it | Rejected for the gate | The existing cleanup removes files only (:845–851). A staged *directory* needs directory deletion again, which is how P1 and P2 arose. The file half of this idea is already in place: the ticket partial (:702, :705–706, :757) is covered by :845–851, and this design keeps it. |
| C. Drop the gate entirely | Rejected | Older releases still take the gate and read its owner (`main` :702–708), and the gate serialises stale writer-lock reclamation (:762–765). Dropping it changes the locking protocol shared with running older releases. That is a larger change than this flake needs. |
| D. Fixed-name staging directory reused by the next writer | Rejected | Bounds the leftover at one directory, but needs a second retirement rule for the staging name with the same path-based deletion. More code than E, for no gain. |
| **E. In-place directory gate, opened and validated once; publish and retire its owner through that descriptor** | **Chosen** | No staging object exists, so nothing needs cleanup. The owner file is complete when it first appears, and `link()` never replaces one. The fixed empty directory is reused, so there is no directory retirement. The ticket already holds the same owner JSON (:705: the same `owner` object as the gate at :711). The store already relies on hard links for every blob (:991). |

## 5. Design

### 5.1 Writer, reader and release

The implementation keeps the complete-ticket publication and the directory
layout consumed by older releases. All gate-owner operations use a validated
directory descriptor. The descriptor path is selected for the supported host
(`/proc/self/fd` on Linux and `/dev/fd` on the portable path); no gate-owner
operation falls back to resolving `.writer-lock-gate` again.

Rules, in order:

1. **Ticket** (unchanged from `e9016ee4`): write the owner JSON to the root
   partial with `"wx"`, then `rename` it to the unique queue name. Readers only
   ever see a complete ticket. This is the original fix.
2. **Gate, writer side**: at the queue head, create the fixed directory if it
   is absent, open it with `O_DIRECTORY | O_NOFOLLOW`, and compare its `fstat`
   device/inode with `lstat(gate)`. A symlink or replaced entry fails closed.
   Link the complete ticket to `owner.json` through the held descriptor. A
   successful link means this writer holds the gate; `EEXIST` and a replaced
   gate retry under the same deadline.
3. **Gate, reader side**: read `owner.json` through the opened descriptor. A
   complete dead owner may be unlinked through that descriptor. An ownerless
   gate is reusable when it carries the fixed `.released` marker, or once its
   directory mtime is older than `writerLockStaleMs` (30 s). A fresh mtime
   without the marker after `mkdir` means publication may still be in progress.
   A live owner is never retired.
4. **Release**: unlink only our `owner.json`, after checking its token, through
   the held descriptor. Close the descriptor and remove the ticket. The empty
   fixed-name gate directory remains for the next queue head.

### 5.2 Why each requirement holds

- **A live writer never loses its queue place**: rule 1 is untouched. A
  complete, live ticket fails both retirement tests at :718 (it parses and its
  owner is alive), whichever release does the scan.
- **Gate operations stay on the examined object**: the code opens the gate
  without following symlinks, verifies its device/inode, and performs owner
  reads, links and unlinks through that descriptor. Replacing the public gate
  name cannot redirect an owner operation to another directory.
- **Older writers keep working**: they find a directory with a complete
  `owner.json` at the path they read (`main` :707). This is the second review's
  case, and the review's mixed-version probe passes (§8).
- **No unbounded leftovers**: §5.3.
- **No unbounded gate debris**: the only gate directory has a fixed name and is
  reused. Its owner file is removed through the held descriptor (§5.4).

### 5.3 What an interruption leaves behind

A SIGKILL at each step of an attempt:

| Killed after | Left behind | Who removes it, and when |
|---|---|---|
| partial written, before the ticket rename | `.writer-ticket.<token>.partial` (root file) | Startup cleanup, once older than an hour (:845–851). Same contract as blob partials (:978). |
| ticket rename | dead ticket in the queue | The next queue scan, at once (:718–719). |
| `mkdir(gate)`, before `link` | empty `.writer-lock-gate/` with a fresh mtime | The next queue head reuses it after 30 s (rule 3). Until then writers wait and can time out (§9.2). |
| `link` | dead owner file in the fixed gate | The next queue head unlinks that file through the opened gate descriptor and reuses the directory. |
| release | dead ticket and fixed `.released` marker in the gate directory | The next queue head removes the marker and ticket, then reuses the gate. |

Every leftover has a fixed name or a name whose class an existing rule already
retires. Repeated crashes cannot accumulate anything that no rule removes. The
staging directory and the `.writer-lock-retire.<uuid>` quarantine no longer
exist.

### 5.4 Every deletion in the writer path after the change

| Site (`7cab7bd4`) | Acts on | Why it cannot hit a live owner or leave the root |
|---|---|---|
| :719 retire ticket | an unreadable or dead ticket | Ticket names carry a UUID and are created once by one writer. A retired name never comes back, so the path names only the ticket that was read, or nothing. Current writers' tickets are complete when they appear. Unchanged from `main`. |
| dead-owner cleanup | only `owner.json`, read and unlinked through the opened gate fd | The gate directory itself is never removed. The held fd prevents a changed pathname or symlink from redirecting the unlink. |
| gate release | only our `owner.json`, after token check, through the held gate fd | The fixed empty directory remains; no recursive removal or path re-resolution occurs. |
| :757–758 own partial and ticket | this writer's unique names | Unchanged. |
| :845–851 aged partial files | files ending in `.partial`, older than an hour | `lstat` refuses symlinks and directories, and partial names carry a UUID. Unchanged from `e9016ee4`. |
| :766–790 stale writer-lock reclaim | `.writer-lock` | Unchanged from `main`. Not in this design's scope (Deferred). |

The quarantine's `rename`/`unlinkSync`/`rmdirSync` (:812–841) goes away with
the object it cleaned. Remaining gate deletion is limited to an owner file
opened, checked and unlinked relative to the held directory descriptor,
matching acceptance 2.

### 5.5 Mixed releases

An older release still running alongside this one:

| Older writer meets | Older writer does | Result |
|---|---|---|
| a current gate with its owner linked | reads a complete live owner and waits (`main` :707) | Correct. This is the review's mixed-version probe. |
| a current gate between `mkdir` and `link` (a window of a few system calls) | retires it at once (`main` :707–708) | The current writer's `link` gets `ENOENT` (retry), or `EEXIST` once the older writer's own owner is inside (retry). If the older writer retires the gate just after the link, both believe they hold a gate. Both then race for `.writer-lock`, which `mkdir` keeps exclusive, so the quota stays exact. No path ends in exit 1 for either writer. |
| a current queue ticket | reads it complete | Correct. |

The reverse direction: a current writer that scans the queue while an older
writer is still inside its in-place ticket write (`main` :685) reads an empty or
partial ticket and retires it (:718–719). That older writer never reaches the
head and times out. This is the original flake, limited to older writers during
the overlap. Older writers already do the same to each other, and it ends when
the older release exits.

`e9016ee4`'s staging rename closed the second row's window as well. This design
reopens it for older readers only, during the overlap of two releases, and the
row shows the outcome is a retry with the quota intact. `main` has the same
window, and a wider one, between any two of its own writers.

## 6. What to remove

In the store, `7cab7bd4`:

- :11 `import { processIdentityProvenDead }`, used only by the quarantine branch.
- :499–508 `readAcquisitionGateOwner`. Its non-directory branch reads the file
  gate of `dcdb689a`, which never reached `main`. Its callers (:734, :753) go
  back to `readWriterLockOwner`, as on `main`.
- :697 the `gateStage` name.
- :707–711 the staging `mkdir`, its `owner.json` write and their comment.
- :725–730 `renameSync(gateStage, gate)` and its comment. Replaced by `mkdir`
  plus `link` (§5.1).
- :733 the `ENOTEMPTY`/`EISDIR` codes, which only the rename produced.
- :756 `rmSync(gateStage, …)`.
- :795–844 the whole directory branch of `removeAgedPartials`: token regex,
  owner and liveness checks, quarantine rename, inode recheck, `unlinkSync`,
  `rmdirSync`, restore.

Keep: :698–702 and :705–706 (ticket partial and rename), :757 (partial
removal), :735–743 (reader rule, now under `else` and reading
`readWriterLockOwner`), :845–851 with :848's `throwIfNoEntry`.

In `src/lib/runtime/runtimeImageStore.test.ts`, `7cab7bd4`:

- remove :649–686 «gate staging recovery protects a live publisher and retires
  an interrupted one»;
- remove :849–883 «gate staging cleanup confines deletion to proven abandoned
  store paths» (ten cases);
- remove :885–933 «gate staging retirement is safe when its path changes before
  quarantine»;
- remove :613, the assertion that no `.writer-lock-gate.*.partial` exists, since
  nothing produces that name any more.

In `src/lib/runtime/fixtures/runtimeImageStoreWriter.ts`, `7cab7bd4`:

- :44–62 the `gate-owner`/`gate-stage` modes hook `renameSync` of the staging
  directory. Replace them with a `linkSync` hook on `.writer-lock-gate/owner.json`:
  `gate-owner` holds after the link (used by the legacy-layout test at :571),
  and `gate-unowned` holds after `mkdir` and before the link (the new
  regressions). Drop `gate-stage`.
- :71 writes the `ticket-published` milestone with a plain `writeFileSync`, and
  the legacy-layout test reads its contents as soon as the file exists
  (`runtimeImageStore.test.ts` :599–601). Read in the gap between create and
  write, it is empty: the prototype hit this once, as `Received: ""` (§8). It
  is the original bug's shape inside the test harness, and it is present on
  `e9016ee4` (fixture :69) and `7cab7bd4` independently of this design. Publish
  the milestone as `.partial` plus `rename`, the way `publication-paused`
  already is (:85–89).
- In the default held-ticket mode (:63 onward), add one milestone: write
  `gate-evaluated` on the second `lstat` of `.writer-lock-gate`. Under this
  design that `lstat` happens only while inspecting a gate someone else holds
  (§5.1), so the second one proves a full inspection has finished.

## 7. Tests

Unchanged, byte for byte:

- :511–534, the four-writer quota test: `maxBytes = 4 * 1024 * 1024 + 128`,
  exactly one exit 0, three exit 2, empty output, stored bytes within the limit.
- :536–569, the `empty`/`partial` ticket-publication tests (the original race).
- :622–647, `e9016ee4`'s recovery regression «an interrupted image ticket
  publication permits another process and its partial is retired».
- :688–719, publication during partial cleanup.
- :571–620, the legacy-layout test. Only its fixture hook moves from the rename
  to the link, and :613 goes.

Added, two queue regressions and four deterministic descriptor-race cases
(both fd routes for each finding):

1. «an earlier queue head leaves a fresh gate alone until its owner links».
   Writer A is held inside its ticket write with clock 1000. Writer B, with
   clock 2000, reaches the head, creates the gate and is held before the link.
   A's ticket is then released, so A heads the queue and inspects the ownerless
   gate. The test waits for A's *second* inspection of the gate, so one full
   decision has run, then asserts the gate still exists. B is released, and the
   two results are exit 0 and exit 2 with empty output. **Red when** rule 3's
   age condition is removed, reverting to `main`'s immediate retirement.
2. «a gate left ownerless by a killed writer is reused once stale». B is
   SIGKILLed between `mkdir` and `link`. A store opened at once with a 100 ms
   wait refuses with `RuntimeImageWriterBusyError`. After the gate's mtime is
   aged past 30 s, a write succeeds, leaving an empty reusable gate and no
   queue ticket or partial.
   **Red when** the stale arm of rule 3 is removed, so an ownerless gate is
   never retired.

The review regressions exercise live-owner replacement during stale gate
cleanup and symlink replacement between gate creation and owner publication,
with both `/proc/self/fd` and `/dev/fd` routes. Cleanup unlinks only through the
held directory descriptor; a changed public name either preserves the live
replacement or safely refuses the writer. The earlier quarantine probes remain
useful for proving the removed quarantine machinery is absent.

## 8. Verification

Final tree, 2026-11-12, Bun 1.4.0. Test and typecheck commands ran through
`scripts/gate-slot.sh` with isolated HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME,
TMPDIR and LLV_STATE_DIR, a closed Viewer control URL, and
`LLV_GATE_RUNNER=off`. Logs were retained outside the worktree.

| Check | Result |
|---|---|
| `bun test --timeout=60000 ./src/lib/runtime/runtimeImageStore.test.ts` | 43 pass / 0 fail, 154 assertions. This includes four-writer quota admission and both gate replacement findings in `/proc/self/fd` and `/dev/fd` modes. |
| Minimum SQLite: version query, then `bun test --preload ./src/lib/state/minimumSqlite.preload.ts --timeout=60000 ./src/lib/runtime/runtimeImageStore.test.ts` | SQLite 3.39.4; 43 pass / 0 fail, 154 assertions. |
| `bunx tsc --noEmit` | Exit 0. |
| ESLint on the three changed TypeScript files | Exit 0. |
| `privacy-publication-gate.ts --require-known-values --paths` on all four changed files | `PRIVACY GATE: PASS`. |

## 9. Residual risks

1. **Mixed releases**: §5.5, second row. The worst case is a retry, with the
   quota held by `.writer-lock`.
2. **A writer killed between `mkdir` and `link`** blocks writers for up to 30 s,
   and those with the default 5 s wait refuse with
   `RuntimeImageWriterBusyError`. The window is a few system calls. `e9016ee4`
   applies the same 30 s rule to ownerless gates from older writers.
3. **Hard links**: the store already requires them for every blob (:991). The
   queue and the gate sit in the same root directory, so `EXDEV` cannot occur.
   Any other `link` error propagates and leaves at most the one fixed empty gate.

## Deferred — not currently justified

- **`reclaimStaleWriterLock`'s graveyard** (`main` :731, `7cab7bd4` :767): a
  SIGKILL after its rename leaves `.writer-lock-reclaim.<uuid>`. This is the
  same class as the quarantine P2. It predates this branch and is reached only
  while reclaiming an already stale lock. Track it separately if it is ever
  observed.
- **A shorter ownerless-gate threshold** than `writerLockStaleMs`. Slow CI
  runners can stall a process for seconds between `mkdir` and `link`, so a
  shorter threshold would bring back the first review's race.
- **Replacing the queue, gate and writer lock with one OS file lock.** Simpler
  in isolation, but it is a protocol change shared with releases already
  running.
