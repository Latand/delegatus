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

## Regression checks

On the starting source, explicit-path tests for an inaccessible process and a
scoped uncertainty both failed: the first threw `partial retention process
scan`, and the second removed the release it should have kept. The same two
cases pass after the change. Tests also cover installation-wide uncertainty,
observer refusal and invalid replies, missing cwd/executable/fd/maps/environment,
PID replacement, exited processes, kernel-thread file holders, bind mounts,
bounded continuation through fresh helper processes, startup with updates off,
service-process restart cadence, late safety inputs and owner cancellation.

Checks run in scratch exports with private HOME, config, temp and state roots,
a closed Viewer control URL, and the required shared gate wrapper. No latency
or throughput improvement is claimed by this change.
