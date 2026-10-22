# Worktree sweep slices and controller settlement

The existing sweep helper owns discovery, accounting and retirement. Each request
selects at most 16 candidates and stops selecting one second after its first
candidate, so a slow discovery (a cold forge cache, `gh`, a loaded host) still
visits at least one. Once a slice is spent, later repositories are only
fingerprinted; their merged pull requests are read on their own turn. It yields
between candidates. A final retirement already in progress
finishes its safety checks under the existing command and helper deadlines;
the selection budget never interrupts a removal halfway through its protocol.
Trim operations share the selection budget and have their own removal-count cap.

`worktree-sweep-report.json` now carries an optional advisory `progress` field:
a dirty-path queue, discovery fingerprints, repository rotation, a fair cursor
for each repository and the number visited.
The report writer persists it atomically with the existing retention observations.
A restarted helper continues that queue. Older reports start discovery again.
Git registration metadata and lane headers are compared on each slice; changes
to HEAD, branch, locking or lane activity enqueue that path. Each kept row whose
verdict can change with time alone records when:
- `retention`: the end of its retention (the lane's hour, then four days);
- `recent-writes`: its newest write plus the quiet floor;
- `in-use` and `live-conversation`: the next hourly sweep;
- `forge-unavailable`: the next hourly sweep, or the end of the lane's hour or
  four days when that is earlier, since the remote proof then stands without
  the forge;
- a failed read or removal: the next hourly sweep. This covers
  `unreadable-tree`, `changed-during-inspection`, `map-write-failed`,
  `remove-failed`, `uncommitted` when `git status`, `git ls-files`, the
  registration refresh or an interrupted removal's restore failed,
  `unmerged-commits` when HEAD was unreadable, and `locked` when HEAD could not
  be held through removal.

Other reasons wait for a registration change or the fair cursor. The first
slice at or after a recorded time enqueues the path, so expiry is a delta too. These times only schedule a visit; the visit decides from fresh
reads. Initial ownership is
indexed once by lexical and physical checkout path. A slice reads process and
conversation guards once for selection; candidates approaching an effect refresh
them through the existing retirement protocol. Repository discovery deduplicates
identical input paths.

Only selected paths enter filesystem accounting. Each retained-tree measurement
visits at most 4,096 entries and remains a lower bound. Deferred rows retain their
previous advisory bytes and retention observations. These observations never
supply deletion authority. Allocation-cache eviction cannot schedule a walk of
every retained tree; the production helper discards old allocation inventories
and keeps the small trim-candidate cache. Completed discovery returns to the
hourly schedule; a pending queue resumes after five seconds, unless the slice
visited nothing, which waits the hourly interval. Discovery,
candidate work and accounting have separate loop-monitor labels, forwarded by
the helper protocol. Existing loop-gap and performance-summary logs remain.

## Retirement proof

A merged PR must contain the current HEAD. Otherwise freshly advertised network
remote refs must contain every commit reachable from HEAD. A saved base equal to
HEAD supplies no preservation proof. Local remotes, stale tracking refs and
unreadable remotes cannot authorize retirement. Existing retention periods apply.

The existing path checks tracked and untracked changes with Git status, inventories
ignored contents and preserves unknown output, source and evidence. It checks
pipeline activity, process working directories and open files, conversation claims,
merge-batch custody, nested registrations, mounts and recent writes. Measurement
is followed by fresh guards. HEAD locks, a refreshed registration, tracked inode
snapshots, another status and ignored inventory, and final activity and retention
checks precede plain `git worktree remove`. A recorded interrupted removal keeps
its existing recovery protocol. No safety decision comes from cached accounting.

## Controller jobs

A nested job inherits the calling scope's attempt references when narrowing that
scope. Mutable copies and comparison fingerprints retain that bounded window;
checkpointing still preserves the complete history. Settlement polling reads the
indexed row and scheduling generation, plus database-change and peer-ownership
tokens. Changed ownership reads use the existing pipeline evidence journal and
cooperative compact projection shared across jobs, bounded to one database and
32,768 compact rows. Branch, repository, delivery authority, terminal
state, deletion and archive changes invalidate settlement; peer turn progress
keeps the same ownership token. Checks run again after asynchronous preparation
and before dispatch or adoption. Concurrent validations coalesce, and teardown
awaits the final validation before releasing the inherited lock.

## Shared surfaces and verification

The sweep and report writer produce the report; the worker transports it. Resource
and disk-pressure readers, MCP status and temp-sweep exclusion accounting consume
its existing kept paths and byte totals. They continue to treat bytes as advisory.
Old reports and worker fixtures may omit `progress`; no reader needs it for safety.
The scheduler alone uses `progress.complete` to choose the continuation delay.
The controller pass produces attempt references; nested scope entry, mutable store
copies and stage settlement consume them. Explicit unscoped callers retain their
existing complete-history behavior. No state schema changes are required.

Regression cases live in `worktreeSweep.test.ts`, `worktreeSweepWorker.test.ts`
and `engine.controllerPass.test.ts`; the existing sweep fixture exercises real
process restarts. Remote checks isolate home, configuration, temp and state roots
and use a closed Viewer control URL. Performance probes compare the assigned base
and candidate on the same synthetic inventory and record three samples with load.
Only aggregate measurements belong in the stage summary. The seat owns the live
post-deploy measurement and retirement counts.

Earlier foundations are the off-thread helper (#3052), bounded conversation-owner
proofs (#3154), and published-lane retention (#3173). This change retains those
proofs and retention rules while bounding how much work enters them per request.
