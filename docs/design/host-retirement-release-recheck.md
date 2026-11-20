# Idle host retirement across tree capture

The retirement sweep evaluated central agent state against the whole registry
entry revision (`entryRevision` hashes the complete entry). Before reaching
runtime release, `persistCapturedTree` writes `structuredTerminationSurvivors`,
`structuredTerminationCaptureId` and `updatedAt`. The next scope authorizer
rejected the original central projection because that write changed the hash.
Its turn became undetermined and retirement returned a generic conflict.
No runtime release or signal had been reached. Restart-orphaned idle hosts
with dead former owners consequently accumulated.

The authorizer reuses this sweep's verified central evidence when the current
entry differs only in those three termination-capture fields. The global
whole-entry revision and all other CAS consumers remain unchanged. Reusing
that evidence requires all other entry fields to match. Independently, PID,
start identity, boot identity, scope, owner, claim epoch and writer epoch must
still match the original eligible target. Hosts with and without a scope use
the same authorizer during capture and before each later effect.

Eligibility pins the original transcript path and file signature before memory
measurement. A refreshed central projection cannot replace that proof with a
moved or replaced closed transcript. Every check rereads seats, attention,
flags, queues, operations, event cursors and publication authority. A changed
conversation turn refuses. No release contract or owner transition is relaxed.

Conflicts identify publication, missing entry, process identity, claimEpoch,
claimOwner, writerClaimEpoch, scope, transcript path or signature, or the failed
verdict clause and reason. The report preserves that diagnostic, including the
first capture refusal when its condition clears before the response settles. An
already-exited tree can still take read-only reconciliation for lost process custody or the legacy unhosted-status
refusal, after proving that no descendants remain and the scope was collected.
Other verdict refusals retain their cause.

The sweep credits a stop after an accepted runtime release or process signal,
confirmed exit of the captured tree, and successful reconciliation of the
latest durable capture for that same target. A changed target, failed registry
write, or retained descendant that is alive or unverifiable keeps the stop
uncredited until a later sweep proves cleanup. Runtime writer failures retain
the accepted stop method and their diagnostic through reconciliation. A tree
that exited on its own appears in `gone` and contributes no reclaim totals.

## Verification

The lifecycle regression uses real isolated process trees, engine-specific
native transcript fixtures, the real central-state reconciler, registry writes,
sweep authorizer and termination ladder. On the main baseline, both Codex and
Claude fail after capture with a conflict and a live tree, before runtime
release or signals.
The fixed path stops the full tree. Race cases cover writer admission, capture,
runtime release and scope awaits, including a dead former owner, plus changed
ownership, process identity, scope, turn, attention, live seats, queued events
and transcript changes. Both engines run these cases with and without a scope;
transcript replacement cases refresh the real central projection. Tests also
publish a retained live descendant during reconciliation admission and verify
that the sweep refuses cleanup without crediting a stop. An unchanged
transcript still retires after capture and central reconciliation. The existing
five-minute schedule and grace-bounded eight-host batch remain unchanged.

Deployment and verification of the installed fleet belong to the release owner.
