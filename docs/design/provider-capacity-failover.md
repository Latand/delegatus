# Same-account recovery from model capacity refusals

## Decision

The operator correction of 2026-10-30 supersedes the earlier account-failover
proposal. A model-capacity refusal retries the interrupted stage on the same
account, using the existing persisted recovery loop. Capacity never selects
another account. Authentication failure and exhausted usage limits retain
their existing account-selection rules.

## Diagnosis

At baseline `308ba22a`, the affected build attempt had a saved model-capacity
cut, zero recovery tries and a next-try time of 2026-10-29T02:59:56.534Z.
Its saved definition pinned its account. The recovery history included an
earlier successful continuation. A later manual account change restarted it
at 08:14Z.

At that baseline, `parkExpiredProviderObservation`
(`src/lib/pipelines/engine.ts:12557`) called `park` on observation expiry.
The independent observer's 15-second deadline parked a saved, uncontinued
cut, even while its retry delay was still running. It first checkpointed the
cut, then called `tickRunStage`, which awaited host activity before checking
whether a continuation was due. The saved zero-try record establishes that
the observation deadline parked this attempt before its retry budget ran
out; it does not identify which awaited observation stalled. The ordinary
three-retry guards were at `engine.ts:3291` and `engine.ts:12637` in that
revision.

Main already contains independent observation, durable checkpoints, active-turn
protection and Cloud fallback support from `0dbde7f8`, `4431a1a3`,
`da12b874` and `e1890804`. Recovery continues through that same mechanism.

## Recovery

`openProviderWait` (`src/lib/pipelines/engine.ts:3233`) saves the source account,
cut timestamp, consumed retries and next retry time. `providerBackoffMs`
(`engine.ts:3224`) computes a one-minute exponential delay, capped at fifteen
minutes, then applies jitter between 80% and 100% of that delay. Ordinary
three-retry capacity chains therefore wait 48–60, 96–120 and 192–240 seconds.
The cap also bounds delays when replaying longer counters saved by an earlier
version. The sampled retry time is persisted and survives process restarts.

`recoverProviderCut` (`engine.ts:3289`) serves ordinary controller ticks.
`recoverPipelineProviderTurn` (`engine.ts:12820`) independently observes
terminal transcripts and invokes the same stage-recovery path. Both retain
the existing limit of three automatic continuations per interrupted chain.
While retries remain, the stage stays running, displays its reason and next
retry time, and schedules its own wake. Continued capacity after the third
retry parks with the reason `model at capacity after 3 tries`.

A successful continuation preserves the conversation, checkout, model, tier,
account and launch receipt. If continuation transport is unavailable, the
existing bounded transport wait applies. When a fresh host is required,
`relaunchCutStage` (`engine.ts:3514`) binds the successor to the cut's source
account, model and tier before ordinary spawn admission, preserving the
operator's account-pin setting. A saved migration
retry cannot select another account for a capacity cut. Project authorization,
operator controls, idle-only retirement and generation fences remain
mandatory. Revoked account authorization holds recovery under those existing
rules; it cannot authorize a different account for capacity.
Capacity recovery checks authorization for its source; an excluded target
from an older migration cannot hold that recovery. If the successor carries
quota history, pending admission requests the capacity source explicitly,
preserving an operator pin and rejecting a substituted account.
If that admission is denied or its lookup is unavailable, the successor stays
pending and retries admission after thirty seconds. Admission waits spend no
provider retries and create no quota stage-retry timer, even after prolonged
denial. Restoring authorization admits the same source, model and tier on the
next due tick.

`deferExpiredProviderObservation` (`engine.ts:12796`) handles an expired
observation through a fresh fenced snapshot. A saved, uncontinued cut stays
running and schedules another observation at least thirty seconds later.
Expiry sends nothing. An expired observer's late result cannot dispatch or
write. Reported completion, cancellation, pause, close and intervening
checkpoints retain authority. Actual retry exhaustion still parks.

A capacity cut following an earlier quota failure also stays on its source.
`moveParkedProviderRetry` (`src/lib/pipelines/engine.ts:11016`) hands a new
capacity chain back to ordinary running recovery. `reopenCapacityRetry`
(`engine.ts:11038`) replays older saved capacity timers through that same path,
retaining spent retries. A capacity budget that is exhausted parks directly;
an earlier account's quota-reset timer cannot replenish it or select a new
account. Confirmed quota and authentication failures keep their existing
reset-aware account recovery.

## State and verification

No record shape changes. `openProviderWait`, continuation and relaunch write
the existing `providerWait`, `providerRecoveryBudget` and `providerRecoveries`
fields. The store replays them; controller ticks and the independent observer
consume them. The watchdog uses `resumeAt` after restart. Existing stage and
board projections show the saved reason and next retry time.

`engine.capacity.test.ts` builds production pipeline and recovery inputs and
covers repeated capacity followed by success, bounded exhaustion, jitter,
old-counter capping, older saved timers and same-account spawn admission after
quota recovery through the production account selector. It also covers an
excluded migration target, revoked source authorization and a selector that
returns a different account. Pinned and unpinned stages retain their source.
Prolonged admission denial, lookup failure and a fresh-process replay preserve
the pending capacity budget until the original source can launch.
`providerRecovery.test.ts` covers
persisted retry replay, the three-retry limit, expired observations, late
results and a real observation deadline in a fresh process. No performance
improvement is claimed.

`engine.providerBudgetKinds.test.ts` and `engine.providerReset.part3.test.ts`
cover capacity cuts after quota recovery, including an earlier account's
reset passing after capacity exhaustion. Authentication and generic transient
recovery retain their adjacent controls.
