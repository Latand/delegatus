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

Release immediately records a finished lane's seven-day deadline. A separate
128-root metadata page refreshes released ownership on each attempt-temp tick.
Its primary-key cursor is durable and rotates over open lanes too, so closing
a lane after release still supplies its deadline. It reads no directory
contents and tolerates a root already removed by its owner. Per-root authority
read failures are reported and do not starve later roots. Ownership revisions
and root bindings are checked again after awaited reads. Schema/index creation
uses `assertStateStartupMutation`.

Ordinary pages order known allocations largest first, retaining a share for
expired roots. Pressure pages put a bounded largest-due prefix before the
existing durable cursor traversal; the cursor continues to fund roots outside
that prefix. Temporary preservation holds suppress the allocation forecast
while retaining the owner's deadline. That date nominates a future visit;
identity, live consumers, check custody, keep markers and ownership still fence
every destructive dispatch. A matching attempt in an open or paused lane stays
live even after the individual stage has settled.

The effective scratch cap is the smaller of its configured cap and half the
sum of measured scratch allocation and available filesystem space, leaving at
least the existing 20 GiB working reserve. With 80 GiB of scratch and 75 GiB
free, the effective cap is 77.5 GiB. Pressure cleanup can retire closed-lane
scratch before seven days without making another evidence copy. A failed
free-space observation is reported and preserves the configured cap.

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
