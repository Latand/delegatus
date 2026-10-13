# Automatic update waiting

The 2026-10-13 requirement for #2515 / #2381 changes automatic waiting while
preserving the per-process attribution and accepted-deployment custody rules.
The release policy and the scanner are unchanged.

The automatic probe uses the same owner census and activity-aware liveness
verdict as agent activity. A proven gone host or a turn silent for ten minutes
without active-check evidence contributes zero running turns. Long tools and
verified descendant checks retain their protection. The evidence belongs to the
owner's own transcript and process. A current busy handle, active turn reference
or own journal claim protects a newly accepted turn before its transcript start;
the previous turn's idle tail supplies no age or completion for that new turn.
Without a first turn record or verified check, that acceptance has a five-minute
grace. Its own retained start event supplies the clock; when that event is
unavailable, the first probe of the current owner and acceptance identity does.
Unchanged handles, references and journal heartbeats cannot renew it. A new
acceptance gets its own grace; an aged silent claim remains diagnosed as
`unresolved` and contributes zero blocking turns.
Once an open turn is recorded, its activity supplies the shared stall clock.
Missing owner or tail evidence is reported separately as `unresolved`, with a
five-minute launch grace. It never inflates `turns`. A stale pipeline cursor
cannot reinstate a turn the same probe released. Setup and reviewer processes
retain their recorded ownership protection.

An automatic waiting cycle holds new launches for at most ten minutes. The lease
contains an absolute `waitingUntil`; readers admit launches at that time even if
the controller is waiting on I/O or has stopped. Renewal cannot extend the
deadline. The controller records `deferred` with `launch-hold-expired` and a retry
time, wakes pipeline and delivery admission, and gives new work ten minutes
before beginning another bounded cycle. The target, cumulative wait, and any
six-hour operator decision survive the cooldown and Viewer reconstruction.

A minute with no work admits normally. On a busy machine, holding new starts
lets the current cohort finish. After two minutes without new starts, the update
can proceed at that safe boundary without another quiet minute. The observed
admission identities and complete set of work identities must stay unchanged or
shrink. Completion and removal preserve the cohort's no-start age. Turn and
acceptance ids catch new work in an existing conversation. The stronger dispatch
fingerprint still fences every awaited final-admission read. Both managed
admission and the launcher's final reread require zero live turns and stages;
the timer never authorizes interrupting running work. Only the explicit operator
choice to deploy now retains that override. If work stays live through the
ten-minute deadline, the update is deferred and launches reopen.

This window never overrides green checks, current main ancestry, operator
activity, active controllers, unreadable evidence, unresolved launch grace,
process health or memory admission. When those cannot pass, the update is
deferred and launches reopen. The policy bounds waiting for workload quiet;
it cannot guarantee deployment through a failing health or resource check.

Accepted deployments keep the existing custody boundary through successful
health observation or rollback. A deadline cannot open admission between
restarting the web server and transferring the runtime host. Manual managed
recovery that has already been accepted retains the same protection.
