# Self-update retention under restricted procfs

## Read-only incident observation

At 2026-10-20 22:49:50Z, the unmodified scanner at `ac8cce4f3`
refused its inventory with `partial retention process scan`. Its error cause
was `EACCES`, syscall `readlink`, path `/proc/1/ns/mnt`.
The existing retention report was dated 2026-10-20 18:46:52.073Z and contained
zero removals, zero keep decisions and that same error. The release directory
contained 123 checkouts.

A read-only replay of the scanner's proc operations recorded 591 first
failures, all at `ns/mnt`, all `EACCES`, all with the process still live:

| Process ownership | Count |
| --- | ---: |
| Root | 385 |
| Another unprivileged user | 203 |
| Same user | 3 |

The same-user examples were PIDs 6783, 265693 and 3279198. Each had all four
UID fields equal to the scanner's UID and no effective capabilities.
Their PID directories belonged to the current user, while their `ns/mnt`
links and `status` files belonged to root.
PID 1 was sleeping and still present after the failed read. This establishes a
permission failure independently of process-exit races. No namespace value
was readable for those failed operations, so their namespace membership was
not inferred from the error.

The release tree was below an owner-only `0700` cache directory. A
noninteractive privileged read of the same proc operations, excluding kernel
threads and exited processes, found no live-process read failures. It also
observed 52 cwd/open-file references into release checkouts. The serving
checkout occurred among those references.

The probes read only procfs metadata, directory permissions, the existing
report and release names. They printed no command lines or environment
values. They ran no removal, Git mutation, cache cleanup or live retention
pass. Fixture tests use private release directories.

## Retention contract

`retentionInspection.ts` produces a complete inventory with optional
`uncertain` entries (`pid`, operation/error reason and absolute root scopes).
`retentionWorker.ts` validates this wire shape; `retention.ts` applies each
scope to release, cache and recovery guards. Missing process evidence has
installation-wide scope. UID differences and private directory permissions
alone cannot exclude inherited descriptors. Bind mounts are translated through
the process's mount table into the observer's filesystem view.

The leased inspection worker first scans without privilege. If references are
inaccessible, it tries `sudo -n` for one read-only proc inventory, with a
20-second deadline and a 1 MiB output bound. This uses existing noninteractive
permission only: it changes no policy and opens no password prompt. The
privileged mode accepts no retention or byte-count requests. Git, trash
operations and removal run as the installation user. If observation fails or
its reply is invalid, the original uncertainty remains and protects every
affected release, with a `process-unreadable:<pid>:<operation>:<error>` reason.
Unrelated foreign processes whose complete inventory names no release have
no effect on the keep set.

`SelfUpdateService.startAuto()` starts retention independently of the update
switch and repeats on its existing minute timer. The persisted report clock
prevents another pass within a minute across process replacement. Busy builds,
restart requests and unsettled applies still hold admission. The entire pass
runs in a leased helper under `self-update.retention`; the Viewer supplies
fresh safety inputs over IPC before guards. Shutdown cancels the helper and
waiters await its teardown. The pass has a two-minute deadline and considers
at most four candidate trees plus four recovery journals. Every other release
gets its protection reason or `pass-budget`, with zero denoting unmeasured
bytes. The report's optional cursor resumes after the last considered tree so
permanent holds cannot starve later candidates.

`RetentionPorts.current` accepts synchronous or asynchronous readers. Its
production caller, helper bridge and fixture readers retain the same safety
inputs; the read-only replay driver explicitly selects its 87-tree budget.
`RetentionReport.cursor` is additive: `releaseRetentionStatus()` continues
reading the existing counts, and previous reports without a cursor begin at
the oldest candidate. The shared `tempSweep.ProcessScan` contract is unchanged.

## Removal behind a closed gate

Every retention removal (a release checkout, a package container, a webpack
cache, generated release output, and the replay of an interrupted one) goes
through `src/lib/selfUpdate/gatedTrash.ts`:

1. A durable journal is written, then the tree is renamed into
   `<parent>/.delegatus-trash-<name>-<uuid>/<name>`. Its own path is gone, so
   a new start, open, map or module load by that path fails.
2. A checkout release's Git content is checked again at that location.
3. The retention process moves its cwd into the tree and closes the gate
   directory (mode 000). From then on, no process of the installation user can
   reach the tree by any path, its trash path included. A holder found after
   this point held the tree before it closed.
4. Two process scans run, then the owner's serving, rollback and in-flight
   holds are read. The read follows the last scan, so a hold added while a
   scan ran is seen. A hold added after that read names a path that no longer
   exists.
5. Any holder, hold or failed check restores the tree to its path. Otherwise
   the journal records that deletion began, the release's ready marker goes
   first, and the entries are removed relative to the cwd. A partial tree is
   never restored; it waits behind its gate for the next pass.
6. A removed checkout's own worktree registration is dropped; no other
   registration is pruned.

A journal written before gates existed is adopted on replay: its trash moves
behind a gate after the snapshot, identity and owner checks its own replay
made. When held, it returns to the path that journal named, with that journal.

The gate is a directory permission. A root process bypasses it, so a root
holder is detected only if it held the tree before the gate closed.

## Regression checks

On the starting source, explicit-path tests for an inaccessible process and a
scoped uncertainty both failed: the first threw `partial retention process
scan`, and the second removed the release it should have kept. The same two
cases pass after the change. Tests also cover installation-wide uncertainty,
observer refusal and invalid replies, missing cwd/executable/fd/maps/environment,
PID replacement, exited processes, kernel-thread file holders, bind mounts,
bounded continuation through fresh helper processes, startup with updates off,
service-process restart cadence, late safety inputs and owner cancellation.

Two counterexamples were confirmed on `8027da01` and are pinned in
`src/lib/selfUpdate/retention.test.ts`, for both release layouts. Each test
first counts every process scan of an unheld pass, then repeats the pass once
per scan point. An active, rollback, serving or in-flight hold acquired during
the final scan was ignored and its release removed. A real holder started
after the final scan's snapshot (cwd, open file, mapped file, Bun module) kept
running while its release was removed. With the gate, every such hold keeps
the release; every such holder is refused (`EACCES` at the gate, `ENOENT` at
the old path) or, when it arrived before the gate closed, keeps the release.
A third test replies to each owner read with the state from before its hold:
a release removed anyway was already off its path when that hold landed.

Checks run in scratch exports with private HOME, config, temp and state roots,
a closed Viewer control URL, and the required shared gate wrapper. No latency
or throughput improvement is claimed by this change.
