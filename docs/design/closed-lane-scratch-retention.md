# Closed lane scratch deadlines

## Accumulation and ownership

Repeated source preparation and build retries can each leave a complete export
under an attempt's temporary directory. The root's release callback in
`src/lib/runtime/structuredSpawn.ts` marks the root released; it delegates
content retirement to `AttemptTempStore`. Previously, release recorded no lane
deadline. Only a later filesystem visit recorded it, so a root outside the
bounded visit page could remain without a retention record. The root page also
favoured scheduling age over allocation. This explains how many retained
exports can accumulate inside one released root while small roots receive visits.

The reported collection of roughly seventy exports is consistent with repeated
stage-local preparation. Repository search found no built-in writer for those
custom export labels; the precise sequence of historical preparation commands
was unavailable in the inspected transcript index. This is an accumulation
explanation, with the historical count supplied by the originating report.

Use the reusable command for intermediate exports:

```sh
bash scripts/gate-slot.sh bun scripts/check-source.ts -- bun run build
```

It exports current tracked and untracked source inputs, excludes generated
build output, and shares installed dependencies. Its owned command finishes
before the export is removed, including on an ordinary command failure.
Unconfirmed process containment preserves the export. Each retry therefore has
one export for its command's lifetime. The existing local hook also releases
its shared runtime build immediately after its last consumer, before unrelated
check lanes finish. Shared builds remain available to all their consumers.

## Deadline repair and selection

Release and the terminal change feed record a scratch deadline from confirmed
completion. Stage scratch becomes due strictly after 24 hours. Pressure takes
one thing earlier: a root of a closed or completed lane whose tree has been idle
for three hours, in the Cleaner's pass on low free space and in
[over-cap reclaim](attempt-temp-pressure.md#over-cap-reclaim) when the ledger is
over its cap. Roots marked retain-until-close use the lane's finish clock.
An independent 128-root metadata audit repairs older ledger entries without
reading directory contents. It visits open lanes and standalone launches.
Allocation measurement cannot use the audit's share of the preparation budget.
A change-feed gap wakes the audit. An audit already in progress finishes its
current page sequence and starts another to cover earlier keys. The feed
resumes above the retained history floor.
Ownership revisions and root bindings are checked again after awaited reads.
Schema and index creation uses `assertStateStartupMutation`.

The ordinary tick selects up to 32 due roots in expiry and directory order.
It checkpoints each visit before awaiting the root so successive ticks reach
the rest of the backlog, even when earlier roots are ready to retry. A root
that would get a partial window after another visit starts on the next tick.
The cursor wraps after the due range ends.
An independent allocation queue visits up to four registered roots per tick
within a five-second preparation window inside the 40-second root tick.
Live roots and roots with zero allocation or measurements at least an hour
old remain measurable during retirement backoff.
Absent paths, replaced inodes and refused observations advance that queue.
An absent path with surviving quarantine custody keeps its recorded allocation
until recovery resolves it. A removal visit that uses recorded bytes leaves the
last measurement time available to the allocation queue.
The disk watch sends pressure-triggered retirement through the leased Cleaner
pass. That pass visits registered roots in directory order, 16 per page, and
measures each visited root. A pass outside the Cleaner lease orders its
inventory by the recorded ledger size, which can be stale; every visit still
measures the root again. The inventory is built a page at a time across ticks,
never in one transaction, and a tick whose budget is spent builds none of it.
A root is admitted only when its canonical parent is the real scratch
namespace or the real config namespace: a parent redirected through a symlink
(for example into the backups directory) holds the root under a reason code at
registration and at every dispatch.
A process whose working directory lies under `/proc` (a sandboxed browser
renderer keeps one inside the entry of an exited helper) or no longer exists
names no checkout and holds no root; its open files, command line and any
working directory inside the root still count. A discovery recorded earlier
for a live process stays, so the final dispatch fence still sees a change.
A removal reports the filesystem space it freed apart from the root's
attributed ledger bytes, so a stale ledger value neither shrinks nor inflates
the reclaim figure.
Temporary preservation holds suppress the allocation forecast while
retaining the owner's deadline. That date nominates a future visit.
Identity, live consumers, check custody, keep markers and ownership fence
every destructive dispatch. The report records each visit's reason code
and any ledger retry time. See [Attempt temp under disk pressure](attempt-temp-pressure.md).

The effective scratch cap is the smaller of its configured cap and half the
sum of measured scratch allocation and available filesystem space, leaving at
least the existing 20 GiB working reserve. With 80 GiB of scratch and 75 GiB
free, the effective cap is 77.5 GiB. This cap and the working reserve are
reported by the ordinary tick. A failed free-space observation preserves
the configured cap.

## Finished host event journals

`temporaryDataProduction.ts` already discovers structured-host event journals
and retains them for seven days after their last write. Retirement requires a
finished durable host, its retained transcript and no open owning lane. Pending
actions, exits, process identities and custody keep a host unfinished. New
discovery/restart tests exercise that existing path for dead and live hosts;
open-lane tests keep old journals protected. Unknown owners remain held.

## Verification and release handoff

Tests use explicit file paths with separate private state, home, XDG directories
and temporary roots. The changed-file selection from the pre-push hook judges
the committed tree against main. Production backfill, deployment and subsequent
disk measurements belong to the release and operations owner; no operator
database or data directory is changed during implementation.
