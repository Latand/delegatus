> “A lane in `provisioning` with a null error and no journal events should not be possible for tens of minutes.”
>
> Originating requirement: [issue #3684](https://github.com/Latand/delegatus/issues/3684), 5 November 2026, 11:44:55 UTC.

# Provisioning diagnosis and implementation brief

The 6 November dispatch asks for diagnosis of accepted work before its first attempt, followed by the smallest justified repair. The outcome is one checkout and one first attempt, or a specific wait/refusal with a bounded next action, preserving the accepted lane across restart. This document completes the diagnostic stage. Implementation, independent review and installed acceptance remain outstanding; this stage does not finish the task.

## Decision and evidence boundary

Repair the two demonstrated losses of provisioning failure information in `src/lib/pipelines/engine.ts`. Preserve the existing creation queue, detached job scheduler, Git provisioner and launch recovery. Both queued and direct healthy creation work in the isolated production path on current main. Rebuilding creation or adding another watchdog has no support from these observations.

The historical incident's exact cause remains unproven. A failed authority reread reproduces its defining combination of no checkout, no attempt and no recorded cause. A failed result write reproduces stale provisioning with a checkout already present, so that failure alone cannot explain the reported absent checkout. These are distinct measured source defects.

Inputs read:

- Assigned base and observed GitHub main: `423bf964ed98d9dde744ad0f2c4f2dbf92ae146b`.
- Full current issue and complete comments endpoint: zero comments; update remains 5 November, 11:44:55 UTC.
- Full relevant matrix and D4 at `b8c5744b80cfdd21012b932372a844e76d8ed6f8:docs/audits/recent-issue-dispatch-followthrough-2026-11-06.md`.
- Original create request/result envelopes, recovered from the originating conversation. The first request at 10:38:58 UTC omitted the base pin; its 10:39:07 answer was queued because state admission was busy. The second request at 11:14:35 supplied an exact pin; its 11:14:44 answer was accepted without queuing and had **null `stateDetail`**. This corrects the issue's description of the second create answer. Both requests contained five run stages: build, review, fix, merge and final verification, with a two-round failure edge. No original operation was replayed.
- Several project-scoped and unscoped transcript searches, with relevant audit and issue-report turns opened. Semantic task search identifies this outcome's own lane and the separate macOS owner. Current published and unpublished source is compared below.

Missing historical facts are the provisioning job's start/abort record, failing read/write call site and contemporaneous serving revision. The safe next observation is to join retained controller diagnostics and deployment records to the original accepted operations and times. An acceptance envelope contains no execution trace. Source presence and successful probes cannot establish installed acceptance.

## Discriminating probe

The retained probe drives `createPipelineFromRequest`, real durable stores, `tickPipelinesController`, detached jobs, `provisionPipelineWorktreeAsync` and native Git. Each case uses a local fixture repository with one committed base and an absent lane checkout. The final five-stage graph matches the original structure. Prompts and role lookup are synthetic; the existing reservation-aware fake replaces agent launch. Explicit Codex Astra model fields cause no paid calls.

The real create path enters the queue after an injected `StoreBusyBeforeAdmissionError`. Fault cases use real queue admission before provisioning. Failures are injected at `pipelineRecordReader().version()` and the result mutation's `persist` callback. The surrounding consumer, Git commands and stores remain real. This models precise failure boundaries; it does not reproduce the original operating system lock holder.

| Case | Observation on the base | Meaning |
| --- | --- | --- |
| Direct pinned create | Zero attempts and no checkout at acceptance; checkout after the detached job; one attempt and fake launch on the following controller pass | Ordinary direct creation works |
| Queued pinned create | One queue entry drains; checkout and then one attempt/launch appear | Ordinary queued creation works |
| Revalidation read fails, direct and queued | Three injected failures separated by ten-minute clock advances; provisioning, null detail, no wait record, no checkout, zero attempts | Cause disappears before Git |
| Result write fails, direct and queued | Three failures; provisioning, null detail, no wait record; checkout exists, zero attempts | Cause disappears during result application |
| Fresh process after each fault is removed | Same stored lane provisions or adopts its checkout; subsequent controller passes make one launch at the original base | Existing durable intent survives these cuts |
| Git lock result | Concrete reason, first retry after five seconds; parking with cause after advancing past three minutes | Existing classified retry works |
| Critical disk result | Concrete reason and sixty-second observation; still waits after seven days of fixture time, then resumes when pressure clears | Resource policy deliberately has no exhaustion deadline |
| Unknown command result | Specific needs-decision reason; another pass makes no launch | Unknown failure grants no launch permission |
| Queue admission commits but loses its reply | One row plus the original queue file; fresh process drains it and creates one checkout/launch | Existing identity and deduplication survive answer loss |

Clock advances are state-machine inputs, not measured outage durations. The initial smallest control used one read-only stage; the final matrix uses five stages. Exact checkout HEAD is verified. Native engine startup, task-board rendering and installation behavior are outside this probe.

## First missing transitions

Line numbers refer to the assigned base.

1. **P1 — authority-read failure loses its diagnostic outcome.** `engine.ts:11254–11261` catches a revalidation exception, aborts the job and discards the exception. The guarded executor refuses further effects. Result branches at `11293–11313` omit outcomes for aborted jobs. `applyProvisionOutcome` at `11327` consequently makes no change. With an unchanged row revision, `controllerJobs.ts:75–83` requests no changed-row follow-up. Fair observations can repeat this without a durable failure budget. Both revalidation cases fail their cause-retention assertion and create no checkout.
2. **P1 — result checkpoint failure reaches only the job log.** At `engine.ts:14316–14319`, completed Git work reaches persistence. A refused checkpoint exits to `controllerJobs.ts:74`, which logs and retains the old row without a lane-specific reason. Both write cases fail the cause assertion. The checkout already exists, distinguishing this cut from case 1. A repair must also distinguish failure before commit from commit success followed by answer loss.

Healthy controls did not reproduce lost restart enumeration or scheduler starvation. Existing selected tests independently exercise four-job provisioning capacity, repository waits that release capacity, restart and ownership replacement.

## Minimal implementation contract

| File | Exact permitted implementation boundary |
| --- | --- |
| `src/lib/pipelines/engine.ts` | Local `PipelineProvisionOutcome` failure classification; revalidation/error construction in `provisionPendingPipelines`; `applyProvisionOutcome` and `deferOrParkProvisioning`; scoped provisioning callback around `14311–14322` |
| `src/lib/pipelines/engine.controllerPass.test.ts` | Read/write failure and restart regressions beside detached provisioning tests, with real-repository fixture setup |
| `src/lib/pipelines/engine.creation.test.ts` | Direct/queued producer and post-commit answer-loss cases beside handover/queue tests |

Carry an explicit local failure class and bounded sanitized cause through the existing outcome. Distinguish unreadable authority from affirmative close, deletion, changed base/branch or changed delivery ownership. Both stop effects immediately. Only an unreadable-record failure supplies a diagnostic candidate; a later successful mutation must compare the original complete provisioning fence before recording it. A stale diagnostic must never park or overwrite a replacement owner.

For recoverable state-read refusal, reuse `provisioningWait` and `nextBoundedWait` with the existing three-minute budget, five-second first retry and sixty-second maximum delay. Record failed step, first failure time, count and retry time in existing state fields. Preserve that budget across restart; exhaustion parks with the cause. Keep database classification local and typed where available; do not broaden the shared Git classifier to retry arbitrary errors.

For an outcome checkpoint error, perform a bounded authoritative read before selecting the next action. If the transition committed, preserve it and request the ordinary follow-up. If the same fenced row is still provisioning, record a specific result-write/reconciliation wait when writing is admitted. Reconcile the original checkout through existing identity/head checks. Preserve the resolved base, accepted head, operation and target; never select a new base because an answer was lost.

Failure reporting itself can be refused. Keep that attempt within existing state-lock admission bounds and preserve the original durable intent. Do not recursively replay the whole operation or write an unfenced side file. While all status writes are unavailable, no new durable diagnostic can be guaranteed. Existing read-unavailable/controller diagnostics must remain honest. Once an authoritative read and status write are possible, retain the cause and original retry budget before another effect. Test failure of this handler explicitly. This brief makes no claim to solve permanently unreadable storage.

Reuse the ordinary follow-up wake after recording a transition. Git stays outside the scheduler lease and repository waiting stays asynchronous. No schema migration, job framework, additional polling service or new timeout policy is proposed. No throughput or memory improvement is claimed.

### Producers, consumers and keep-list

`createPipelineFromRequest` constructs the lane/key. `createPipelineWithDelivery` owns its atomic row and delivery/task associations. `queuePipelineCreation` retains the request refused before admission; `admitQueuedPipelineCreations` resolves it into the same row. `tickPipelinesController` selects work; `provisionPendingPipelines` executes outside the lease; `applyProvisionOutcome` writes its state transition. Existing pipeline reads and lifecycle projection consume that state. The queued-card owner retains its separate read contract.

Keep all of the following:

- Task membership and completion ownership; no placeholder task or replacement lane.
- Original key/digest, prepared operation, base pin, accepted head, delivery target, owner and epoch.
- Final authority checks, close/delete cancellation, repository serialization and four-job capacity.
- Existing Git adoption validation; no checkout reset, reconstruction or cleanup.
- Disk policy and unknown spawn receipts. Busy-looking errors after reservation never authorize another launch.
- Adjacent publication, admission and queued-card work, original uncertain operations and fixed review budgets.

## Acceptance and per-file checks

First reproduce the four red assertions with the retained probe on the builder's exact starting source. Move them into the existing files above and require green results after repair. Each check uses one explicit file per designated wrapper invocation, fresh logs, actual exits and isolated HOME/configuration/state/temp roots.

1. Direct and queued five-stage requests create one checkout at the accepted pin and one first attempt. Repeated passes preserve launch identity and task ownership. Remove a queue entry only after storing the original row.
2. A read refusal before Git records the failed step and bounded retry when a fresh fenced write is possible. Repeated refusal exhausts the original budget, including across a new process. Unreadable authority permits no Git/launch effect.
3. Outcome persistence covers before-commit failure and commit-success/answer-loss. Record a reconciliation reason, preserve the original checkout/head and reach one attempt. Never roll a stored running row back to provisioning.
4. Replace close state, branch, base pin, accepted head and delivery owner at awaited boundaries. Reject stale success and failure outcomes; a fresh valid control succeeds. Independently prove the final authority check prevents effects.
5. Refusal while reporting an error stays bounded and preserves intent. Recovery records the cause before further effects. No recursive error handling or second operation is permitted.
6. Git contention retains its exhaustion behavior, disk pressure its observation interval, and unknown post-reservation state its original receipt with no automatic duplicate launch.
7. Restart before queue cleanup, after checkout creation and after outcome persistence keeps the same lane. A stored row plus retained queue file produces no duplicate.

| Explicit file | Required verification |
| --- | --- |
| `src/lib/pipelines/engine.controllerPass.test.ts` | Complete file after adding fault/restart cases; retain authority, scheduling and concurrency controls |
| `src/lib/pipelines/engine.creation.test.ts` | Complete file after adding producer/answer-loss coverage; retain base provenance and cancel/adoption checks |
| `src/lib/pipelines/engine.provisioning.test.ts` | Unknown-after-reservation control; complete file if its behavior or shared fixture changes |
| `src/lib/pipelines/engine.containment.test.ts` | Disk deferral coverage when changing the shared deferral helper |

Run `bun run test <explicit-file>` through the designated `gate-slot.sh`. Publication follows required native hooks and CI. No build, typecheck, full suite or push is part of this diagnosis. Keep three independent review rounds. Later installed acceptance verifies the actual serving revision and ordinary restart under its own authority.

## Actual conflicts and adjacent ownership

| Owner | Captured source | Boundary |
| --- | --- | --- |
| #3668, lane `810f75d7` | Local clean `baeb2d5ee3df99be228d050fcba7b5498ee1ab64`; published draft `25783bad3409d324eba222159b60dde76820235b` | Direct overlap in `provisionFence`, job construction/revalidation and `applyProvisionOutcome`. Preserve integration scope, requirement revision, policy decision, owner epoch and expected remote head guards. Coordinate these exact hunks before implementation. Policy revocation must never become a retry. |
| #3710, lane `83306a33` | Clean local/published `edb2bf0664e74444627a40418581db77d9e80109` | Creation authority and guarded queue admission: `.admission` files, immutable witness, key/digest/candidate checks, guarded cleanup. Leave producers intact. Legacy queue controls do not certify the new admission protocol. |
| #3715, lane `828da1d1` | Clean unpublished `ece4cc79585611c564b65b0055f6542c26442413` | Actual engine hunks around `5116`, `5139`, `5156`, `5200`, `5881` cover publication refusal/recovery. Distinct from provisioning. Preserve accepted-head and remote-refusal behavior. The lane reported no PR; #3715 is the issue. |
| #3643 / PR #3727, lane `25324cf9` | Local `5b2f36e21c4d10369c5a934b3104d6335ad9cf69`, published plan `c24e3d30a572b75d2414836e3cea92183f0d7833`, active working edits | Unpublished `creationQueue.ts` adds bounded `readPipelineCreationReceipt` over four exact paths and redacted fields. API/client/board files also change. Preserve these hunks and UI ownership; supply the existing stored-lane reason contract. |
| macOS bounds, lane `3e02b05c` | Final `23c0c415515e1a52c94fb9b109e94f23c0893a12`; only its implementation document added | GNU-timeout replacement is separate. The pinned failing probe performs no remote fetch. |
| Missing existing checkout, lanes `2358644f` / `b29c74b9` | `0f920233f994ffc9b8ad1b77059e38a86c7e06bb` / `da29f9f2b269865cc6f4f471b379d1b04a9c4ae9` | Later spawn/reconstruction contract; preserve its uncertainty. It cannot explain a checkout never created. |

The probe also runs on scratch exports of the #3668 local head and #3710 published head. It checks their ordinary paths without claiming integration-specific or guarded-admission acceptance. No combined candidate or automatic conflict-free merge is claimed. Re-read #3668's unpublished head and #3643's working diff before coding, then test integrated hunks with the owners' affected regressions. Never restart an uncertain owner operation to obtain coordination.

## Verification and retained evidence

Private evidence resides under the stage's `LLV_EVIDENCE_DIR/diagnosis`: `diagnosis.probe.test.ts`, `run-diagnosis.ts`, logs and `.exit` records, original request envelopes and `manifest.json`. Source and log digests survive scratch removal. The runner applies `checkEnvironment` and `isolatedEnvironment`, a closed Viewer control port, the designated gate wrapper and the repository preload/owned runner. Dependencies are read through the existing installation.

The principal matrix has six passing controls and four intentional cause-retention failures. Existing selected controller coverage: 17 pass, 57 filtered, exit 0. Existing unknown-reservation coverage: one pass, 86 filtered, exit 0. Earlier probe iterations are retained and labelled: an interleaved log, invalid synthetic lock wording, missing synthetic merger role and strict empty-stderr assumption are superseded. Those fixture failures are excluded from source findings.

Final identical-source comparisons under Bun 1.4.0:

| Export | Log | Counts and actual exit |
| --- | --- | --- |
| Assigned base `423bf964` | `base-final.log` | 6 pass, 4 expected diagnostic failures, exit 1; 10 tests |
| #3668 local head `baeb2d5e` | `integration-final.log` | 6 pass, same 4 diagnostic failures, exit 1; 10 tests |
| #3710 head `edb2bf06` | `admission-final.log` | 6 pass, same 4 diagnostic failures, exit 1; 10 tests |

The command in each export was the designated gate wrapper followed by `bun run test src/lib/pipelines/diagnosis.probe.test.ts`. The two existing-file commands selected `engine.controllerPass.test.ts -t "provisioning|repository waiters"` and `engine.provisioning.test.ts -t "busy-looking failure after reservation"`. Filtering and all actual exits are retained; these are not full-suite passes. No repaired source or green implementation verdict is claimed.

The final source/issue recheck began at 21:13:37 UTC on 6 November. Main and the issue remained unchanged. The listed owner heads remained unchanged except the macOS plan commit above. The queued-card owner's working reader removed its task-ID array-length ceiling; the exact delta was inspected and leaves the same reader boundary. Its file-size bound and element validation remain. The report's scoped privacy check passed with required committed fingerprints. Only this document is changed in the assigned worktree; product source, board and live services remain unchanged.

## Deferred — not currently justified

Historical causal attribution without the missing trace; a new watchdog or broad controller rewrite; queue/UI redesign; a new admission protocol; macOS command replacement; automatic worktree reconstruction; scheduler tuning; schema changes; auth/account changes; UNKNOWN replay; review-budget resets; and deployment are outside this brief. Both demonstrated diagnostic losses remain required work in this outcome.
