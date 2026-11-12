# Runtime image writer gate: publish the owner by hard link, drop the staging directory

Status: design, 2026-11-12, read-only design stage on PR #3931. Code claims cite
`src/lib/runtime/runtimeImageStore.ts` (below: "the store") on `7cab7bd4` (head
of the first successor, with the quarantine cleanup) and on `e9016ee4` (the fix
the earlier reviews accepted), and on `main` at `a706416942` where marked.
`main` has not changed the store, its test file or its writer fixture since the
branch's merge base. A prototype of this design ran in a scratch copy of
`7cab7bd4` (§8). Nothing in the repository changed except this file.

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

Keep the directory gate exactly where `main` keeps it, created in place with
`mkdir`. Publish its `owner.json` with one `link()` from the writer's own queue
ticket, which `e9016ee4` already publishes complete (partial file plus
`rename`). Keep `e9016ee4`'s reader rule: a gate without a readable owner is
retired only after `writerLockStaleMs`. Delete the staging directory, its
cleanup, its quarantine and their tests.

Against `main`, the store change is 37 added and 6 removed lines, all in
`withWriterAcquisitionGate` apart from `e9016ee4`'s two-line `lstat` change in
`removeAgedPartials` (the diff is in §5.1). Against `7cab7bd4`, the store loses
77 lines and gains 22, three test blocks go, and none of the deletion machinery
the reviews objected to remains.

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
| **E. In-place `mkdir(gate)`, owner published by `link(ticket, gate/owner.json)`, `e9016ee4`'s reader rule** | **Chosen** | No staging object exists, so nothing needs cleanup. The owner file is complete when it first appears, and `link()` never replaces one. The ticket already holds the same owner JSON (:705: the same `owner` object as the gate at :711). The store already relies on hard links for every blob (:991). |

## 5. Design

### 5.1 Writer, reader and release

The complete change to `withWriterAcquisitionGate` against `main`, as
prototyped (§8):

```diff
-    fs.writeFileSync(ticket, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
+    // Queue readers retire invalid tickets. Publish only complete owner JSON: …
+    const partial = path.join(root.path, `.writer-ticket.${owner.token}.partial`);
     let acquired = false;
     try {
+      fs.writeFileSync(partial, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
+      fs.renameSync(partial, ticket);
       while (!acquired) {
 …
         if (liveTickets[0] === ticket) {
+          let created = false;
           try {
             fs.mkdirSync(gate, { mode: 0o700 });
-            fs.writeFileSync(path.join(gate, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
-            acquired = true;
+            created = true;
           } catch (error) {
             if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
-            if (!writerLockOwnerIsAlive(readWriterLockOwner(gate))) {
+          }
+          if (created) {
+            try {
+              // The published ticket already holds this owner's complete JSON.
+              // A hard link places it at gate/owner.json in one step, so no
+              // reader sees an empty owner and no owner is ever replaced.
+              fs.linkSync(ticket, path.join(gate, "owner.json"));
+              acquired = true;
+            } catch (error) {
+              // ENOENT: an older writer retired the gate before the link.
+              // EEXIST: another writer's owner landed first. Both retry.
+              const code = (error as NodeJS.ErrnoException).code;
+              if (code !== "ENOENT" && code !== "EEXIST") throw error;
+            }
+          } else {
+            const gateOwner = readWriterLockOwner(gate);
+            let gateAgeMs = 0;
+            try { gateAgeMs = this.now() - fs.lstatSync(gate).mtimeMs; }
+            catch (statError) {
+              if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
+            }
+            // An ownerless gate can be mid-publication; retire it only once stale.
+            if (!writerLockOwnerIsAlive(gateOwner)
+              && (gateOwner !== null || gateAgeMs > this.writerLockStaleMs)) {
               fs.rmSync(gate, { recursive: true, force: true });
             }
 …
     } finally {
       if (acquired && readWriterLockOwner(gate)?.token === owner.token) {
         fs.rmSync(gate, { recursive: true, force: true });
       }
+      fs.rmSync(partial, { force: true });
       fs.rmSync(ticket, { force: true });
```

Plus `e9016ee4`'s `lstat` change in `removeAgedPartials`: `lstatSync(filename,
{ throwIfNoEntry: false })` and an optional-chained `stat?.isFile()`, because a peer can rename its ticket partial away
between the directory scan and the `lstat` (`7cab7bd4` :847–849).

Rules, in order:

1. **Ticket** (unchanged from `e9016ee4`): write the owner JSON to the root
   partial with `"wx"`, then `rename` it to the unique queue name. Readers only
   ever see a complete ticket. This is the original fix.
2. **Gate, writer side**: at the queue head, `mkdir(gate)`. On success,
   `link(ticket, gate/owner.json)`. Success means this writer holds the gate.
   `ENOENT` (an older reader retired the fresh gate) or `EEXIST` (another
   writer's owner is already inside) means retry in the same loop, under the
   same deadline. Neither is an error, so neither can turn into exit 1.
3. **Gate, reader side** (`e9016ee4`'s rule): when `mkdir` reports `EEXIST`,
   read the owner. A complete owner that is dead is retired at once. A gate
   without a readable owner is retired only when its directory mtime is older
   than `writerLockStaleMs` (30 s). A live owner is never retired.
4. **Release**: remove the gate only if its owner token is ours, then the
   partial (normally already gone), then the ticket. Removing the gate unlinks
   only the `gate/owner.json` name. The ticket inode survives under its queue
   name until the next line removes it.

### 5.2 Why each requirement holds

- **A live writer never loses its queue place**: rule 1 is untouched. A
  complete, live ticket fails both retirement tests at :718 (it parses and its
  owner is alive), whichever release does the scan.
- **A live gate is never retired by a current writer**: at the moment
  `owner.json` appears it is complete, because `link()` publishes an existing
  inode. Between `mkdir` and `link` the gate is ownerless and less than 30 s
  old, so rule 3 leaves it alone. This is the first review's race. The new
  regression in §7 holds the writer at that exact point.
- **Older writers keep working**: they find a directory with a complete
  `owner.json` at the path they read (`main` :707). This is the second review's
  case, and the review's mixed-version probe passes (§8).
- **No unbounded leftovers**: §5.3.
- **No new deletion**: §5.4.

### 5.3 What an interruption leaves behind

A SIGKILL at each step of an attempt:

| Killed after | Left behind | Who removes it, and when |
|---|---|---|
| partial written, before the ticket rename | `.writer-ticket.<token>.partial` (root file) | Startup cleanup, once older than an hour (:845–851). Same contract as blob partials (:978). |
| ticket rename | dead ticket in the queue | The next queue scan, at once (:718–719). |
| `mkdir(gate)`, before `link` | empty `.writer-lock-gate/` | The next queue head, once it is older than 30 s (rule 3). Until then writers wait and can time out (§9.2). |
| `link` | gate whose owner is dead | The next queue head, at once (rule 3). |
| release | dead ticket and/or gate | As above. |

Every leftover has a fixed name or a name whose class an existing rule already
retires. Repeated crashes cannot accumulate anything that no rule removes. The
staging directory and the `.writer-lock-retire.<uuid>` quarantine no longer
exist.

### 5.4 Every deletion in the writer path after the change

| Site (`7cab7bd4`) | Acts on | Why it cannot hit a live owner or leave the root |
|---|---|---|
| :719 retire ticket | an unreadable or dead ticket | Ticket names carry a UUID and are created once by one writer. A retired name never comes back, so the path names only the ticket that was read, or nothing. Current writers' tickets are complete when they appear. Unchanged from `main`. |
| :742 retire gate | dead-owner gate, or ownerless gate older than 30 s | Same deletion `main` has at :707–708. `e9016ee4` narrowed it, and this design keeps that narrowing. §9.3 covers its residual race. |
| :753–755 own gate release | the gate, only if its owner token is ours | No peer retires a live-owner gate, so the path still names our gate. Unchanged. |
| :757–758 own partial and ticket | this writer's unique names | Unchanged. |
| :845–851 aged partial files | files ending in `.partial`, older than an hour | `lstat` refuses symlinks and directories, and partial names carry a UUID. Unchanged from `e9016ee4`. |
| :766–790 stale writer-lock reclaim | `.writer-lock` | Unchanged from `main`. Not in this design's scope (Deferred). |

The design **adds no deletion**. The quarantine's `rename`/`unlinkSync`/
`rmdirSync` (:812–841) goes away with the object it cleaned.

**Reading of acceptance 2.** Read literally, "never by re-resolving a path"
would also forbid `main`'s own ticket and gate retirement and the partial
cleanup. The specification itself names that partial cleanup as an acceptable
home for staging, so the clause governs the deletion this work would add to
recover from an interruption. Under that reading, it holds trivially: there is
none. Hardening `main`'s existing deletions is listed under Deferred with its
cost.

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

Added, two process-level regressions, each naming the branch whose removal
turns it red:

1. «an earlier queue head leaves a fresh gate alone until its owner links».
   Writer A is held inside its ticket write with clock 1000. Writer B, with
   clock 2000, reaches the head, creates the gate and is held before the link.
   A's ticket is then released, so A heads the queue and inspects the ownerless
   gate. The test waits for A's *second* inspection of the gate, so one full
   decision has run, then asserts the gate still exists. B is released, and the
   two results are exit 0 and exit 2 with empty output. **Red when** rule 3's
   age condition is removed, reverting to `main`'s immediate retirement.
2. «a gate left ownerless by a killed writer is retired once stale». B is
   SIGKILLed between `mkdir` and `link`. A store opened at once with a 100 ms
   wait refuses with `RuntimeImageWriterBusyError`. After the gate's mtime is
   aged past 30 s, a write succeeds, and the gate, queue and partials are gone.
   **Red when** the stale arm of rule 3 is removed, so an ownerless gate is
   never retired.

Review probes: the quarantine safety probe (four cases, both root modes) and
the quarantine recovery probe pass unchanged. They pass because the quarantine
they attack no longer exists, so their swap and kill hooks never fire. That is
the intended result: the mechanism they found unsafe is gone. The mixed-version
probe from the second review needs one change to its writer fixture: its hold
point "after the gate is published" also has to match `link` to
`.writer-lock-gate/owner.json`. It then passes in both of its cases.

## 8. Prototype evidence

Source: `git archive 7cab7bd4` into the stage's scratch directory, with §5.1,
§6 and §7 applied there. The review probes were copied byte for byte (SHA-256
prefixes match the evidence copies), and `main`'s store was used as the older
release for the mixed-version probe. Run through the stage's `gate-slot.sh` one
command at a time, with a private HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, TMPDIR
and LLV_STATE_DIR, `LLV_VIEWER_CONTROL_URL` on a closed port and
`LLV_GATE_RUNNER=off`.

Bun 1.4.0, 2026-11-12. "Probes" means the quarantine safety probe, the
quarantine recovery probe and the mixed-version probe.

| Run (finished, UTC) | What ran | Result |
|---|---|---|
| 1 (14:52) | Default SQLite: full store file plus the three probes | 46 pass / 0 fail, 153 expect() calls, exit 0. Safety probe: `swapped:false` in all four cases, outside sentinel and live owner survive. Recovery probe: `quarantineCreated:false`, nothing retained. Mixed-version probe: older writer plus older publisher gives exits {0, 2}, older writer plus this design gives {0, 2}, and the older writer opened `gate/owner.json` in both. |
| 1 | Minimum SQLite preload: full store file | 39 pass / 0 fail, 140 expect() calls, exit 0 |
| 1 | Default SQLite: the eight writer-race tests ×10 (quota, two ticket-publication cases, legacy layout, interrupted ticket, the two new regressions, cleanup during publication) | 80 pass / 0 fail, 610 expect() calls, exit 0 |
| 2 (15:00) | Minimum SQLite preload: SQLite version print plus full store file | `{"version":"3.39.4"}`, 40 pass / 0 fail, exit 0 |
| 2 | Default SQLite (`3.53.2`): full store file plus the three probes | 46 pass / **1 fail**, exit 1: the legacy-layout test read an empty `ticket-published` milestone (`Received: ""`). The cause is the harness race described in §6. Probes as in run 1. |
| 2 | Default SQLite: the two new regressions ×10 | 20 pass / 0 fail, exit 0 |
| 2 | Fault f1: rule 3 reverted to `main`'s immediate retirement | Both new regressions red, exit 1. Test 1: the earlier head retired the gate and finished (exit 0) before a second inspection. Test 2: no `RuntimeImageWriterBusyError` on a fresh ownerless gate. |
| 2 | Fault f2: rule 3 never retires an ownerless gate | Test 2 red ("runtime image writer lock timed out"), test 1 green, exit 1 |
| 3 (15:11), milestone published by rename | Default SQLite: full store file plus the three probes | 47 pass / 0 fail, 154 expect() calls, exit 0. Probe output as in run 1. |
| 3 | Default SQLite: the eight writer-race tests ×20 | 160 pass / 0 fail, 1220 expect() calls, exit 0 |
| 3 | Minimum SQLite preload: version print plus full store file | `{"version":"3.39.4"}`, 40 pass / 0 fail, exit 0 |

Also run: ESLint on the three changed files of the prototype, exit 0 with no
findings; the project's privacy gate on this document
(`--require-known-values --paths`), PASS. Not run here: typecheck. It belongs
to the build stage with the committed change (specification item 4).

Logs, the prototype patch against `7cab7bd4`, the store diff against `main`
and the adapted probes are kept with this stage's evidence.

These runs prove the mechanism. The build stage still owes the committed
version of the checks in specification items 3 and 4.

## 9. Residual risks

1. **Mixed releases**: §5.5, second row. The worst case is a retry, with the
   quota held by `.writer-lock`.
2. **A writer killed between `mkdir` and `link`** blocks writers for up to 30 s,
   and those with the default 5 s wait refuse with
   `RuntimeImageWriterBusyError`. The window is a few system calls. `e9016ee4`
   applies the same 30 s rule to ownerless gates from older writers.
3. **Gate retirement by path** (:742, `main` :707–708). If two writers both
   believe they head the queue (a ticket computed earlier but renamed later),
   both can judge the same dead gate retirable. One retires it and links a new
   one, and the other's `rmSync` then removes the new gate. Both proceed, and
   `.writer-lock` keeps the quota exact. This race predates the branch, needs a
   crash leftover plus that ordering, and the design neither widens nor
   narrows it.
4. **Hard links**: the store already requires them for every blob (:991). The
   queue and the gate sit in the same root directory, so `EXDEV` cannot occur.
   Any other `link` error propagates as before and leaves an empty gate, which
   rule 3 retires after 30 s.

## Deferred — not currently justified

- **Descriptor-proven retirement of the gate and the stale writer lock**
  (`unlinkat`/`renameat` against a held directory descriptor). Node and Bun do
  not expose `unlinkat`, so this needs FFI on Linux and Darwin, and §9.3 shows
  the quota does not depend on it. Worth doing only if a same-user process
  swapping store entries becomes part of the threat model.
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
