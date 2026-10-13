# Automatic update waiting

The 2026-10-13 requirement for #2515 / #2381 changes automatic waiting while
preserving the per-process attribution and accepted-deployment custody rules.
The release policy and the scanner are unchanged.

The automatic probe uses the same owner census and `evaluateLiveness` threshold
as agent activity: a proven gone host and a host silent for ten minutes contribute
zero running turns. Missing owner or tail evidence is reported separately as
`unresolved`, with a five-minute launch grace. It never inflates `turns`. A stale
pipeline cursor cannot reinstate a turn the same probe released. Setup and
reviewer processes retain their recorded ownership protection.

An automatic waiting cycle holds new launches for at most ten minutes. The lease
contains an absolute `waitingUntil`; readers admit launches at that time even if
the controller is waiting on I/O or has stopped. Renewal cannot extend the
deadline. The controller records `deferred` with `launch-hold-expired` and a retry
time, wakes pipeline and delivery admission, and gives new work ten minutes
before beginning another bounded cycle. The target, cumulative wait, and any
six-hour operator decision survive the cooldown and Viewer reconstruction.

A minute with no work admits normally. A busy machine also gets a window after
two minutes with no new starts: the observed dispatch version and complete set
of work identities must stay unchanged or shrink. Turn ids catch a new turn in
an existing conversation. The final admission rereads this evidence; new work
invalidates the window. This permits the supervised restart/reconnect/resume
path to carry the existing cohort across the update. It can interrupt a live
turn, as the operator-authorized requirement permits.

This window never overrides green checks, current main ancestry, operator
activity, active controllers, unreadable evidence, unresolved launch grace,
process health or memory admission. When those cannot pass, the update is
deferred and launches reopen. The policy bounds waiting for workload quiet;
it cannot guarantee deployment through a failing health or resource check.

Accepted deployments keep the existing custody boundary through successful
health observation or rollback. A deadline cannot open admission between
restarting the web server and transferring the runtime host. Manual managed
recovery that has already been accepted retains the same protection.
