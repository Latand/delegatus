# Finished-agent process retirement

Baseline: `1d0eda9302bfa5c1df7e392f6002091ab0c7c7e9` (`origin/main`, fetched
2026-10-02). Inspection used read-only SQLite connections to the registry and
pipeline store and a `/proc` parent walk. No existing agent was signalled.

## Observed residency

A census found 23 resident registry host trees, including eight idle trees
with approximately 4.4 GiB combined RSS. The largest idle tree held 763 MiB:
304 MiB in its engine and 409 MiB in its MCP server, plus its launcher.
Active trees doing browser work exceeded 2 GiB; they were preserved.

Joining 622 completed attempts to their registry generations found four
resident, idle, terminal conversations whose attempts were already listed in
`terminalReap.settledAttempts`. Two belonged to completed pipelines and two
to still-running pipelines. Their trees held approximately 2.1 GiB RSS.
Completion stamps ranged from 17:26 to 18:09 UTC. This is a point-in-time
observation; it does not classify every idle process as abandoned.

The existing retirement report explained its refusals: live seats, unsettled
turns, and the six-hour transcript-idle threshold. No unexplained process was
used as authority for a signal.

## Causes and changes

1. Terminal reap permanently acknowledged an attempt when the runtime still
   reported it active. A later idle observation could never revisit that
   attempt. Active work now defers settlement without consuming teardown
   rounds. Subsequent ticks retry it; failed siblings retain their own bounded
   retry and unconfirmed-host reporting. Automatic stops require fresh positive
   idle evidence and carry the observed generation, session revision and writer
   claim through journal admission and executor actuation. Unreadable evidence
   or new work remains deferred. Durable pending operations, native queue rows,
   held deliveries and unreplayed handoff messages protect accepted work.
   Capability advertisements use the existing activity-flag classifier.
   The journal atomically acquires the retirement claim before teardown. Work
   admitted first defers retirement; new admissions while teardown owns the
   claim receive a retryable rejection. In-place retries check the same barrier
   before claiming their action or rearming a failed operation. Captured-tree
   cleanup survives the root releasing its writer claim, fenced by the same
   generation, claim epoch and process identities. Finishing or refusing
   teardown releases the barrier. The claim records the exclusive executor
   and its process identity. Competing drains, health failures and deadlines
   cannot release a live executor's barrier. Rebinding revokes its signal
   authority; the barrier stays held until its teardown returns. Recovery may
   take over after the executor process is positively proven dead, or after
   this Viewer's retired executor has completed its final drain. Local custody
   retains unresolved claims across rebind so lost reads or release writes do
   not leave a permanent barrier behind a still-live Viewer PID.
   Older runtime generations without this protocol are deferred.
2. MCP launcher EOF only ended child stdin. A child retaining handles or
   ignoring TERM could stay resident indefinitely. Launcher-owned children
   now receive one second for EOF, then TERM, then KILL after another second.
   Displaced children remain tracked until exit, so replacing a release does
   not discard cleanup ownership. Connected idle clients remain alive.
3. The stdio SDK did not close its server transport on EOF. The dedicated
   stdio server now closes the protocol and exits on client loss, with a
   one-second exit deadline for stalled shutdown. This also covers loss of
   the launcher that owns its stdin pipe.

The existing structured-host tree termination and retirement predicates stay
in place. No runtime-host succession/access code from #2476 changed. Historical
settled-attempt stamps remain governed by the existing six-hour idle sweep;
this change does not rewrite live state. Reducing retained MCP payloads during
an active conversation (#1816) remains a separate task.

## Verification

All process fixtures used private state and recorded fixture PIDs. The new
Node and Bun EOF tests failed before the launcher fix: each child was still
alive after four seconds. Both passed afterward, including preservation of a
connected idle client. The real stdio server with a retained interval also
failed before the EOF fix and passed afterward.

The terminal-reap regression failed before the fix: seven active observations
followed by idle produced no stop. It now preserves all seven active ticks,
reaps on the first idle tick, and does not repeat the stop. A second case
checks that an unconfirmed sibling cannot hide pending live work. Production
socket/journal regressions cover snapshot loss, a resumed turn after snapshot,
a turn or generation changed before actuation, queued work and in-place retry
after the actuation read, and registry busy
state before signals. Each deferred host is subsequently cleaned up within
five seconds once its work settles; capability-bearing idle hosts also exit.
An idle root with real registry persistence exits on TERM; its detached helper
ignores TERM and is still killed within the deadline after the root releases
its writer claim.
The two original busy-turn regressions failed before the safety correction.
Three overlapping-controller regressions fail on the preceding branch head
and pass with exclusive retirement ownership: successor health failure,
expired deadline and loss of the predecessor's durable authority read. They
use a real journal, registry, socket and recorded TERM-resistant fixture PID;
new work remains rejected during teardown and no further signal follows
revocation or admission of new work. Journal-reopen coverage checks that live
and unverified owners retain their barriers while positively dead owners can
be recovered.
Two further replacement regressions cover loss of the claim-acquisition read
and failure of the final claim-release write. Both fail without local executor
completion evidence and pass with recovery after the retired drain returns.

The existing retirement suite checks real tree termination, including a child
in its own process group, retained resume data, identity changes, unreadable
evidence, active turns, queues and live seats. The launcher release-switch
case additionally verifies a stubborn old MCP child exits while its successor
continues answering calls.

`verify-runtime-host.ts` passed under the Dockerfile's Bun 1.4.0: succession
completed in 501 ms and both endpoints answered 27/27 probes over 15 seconds,
including clients abandoning replies. This was an isolated rehearsal.

Run the focused suites with `TMPDIR=/var/tmp` and a private `LLV_STATE_DIR`.
The initial broader stdio run inherited a scratch root inside operator-shaped
state, causing child startup refusals; the runner was stopped by its recorded
PID and its fixtures cleaned up. The corrected run uses a private temp root.
The schema assertion also accepts an omitted JSON Schema `required` array,
which denotes no required properties. Type checking needs more than the
default 2 GiB Node heap on this checkout.
