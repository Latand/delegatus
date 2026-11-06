# Claude recovery: terminal evidence and original-message delivery

Originating requirement, 5 November 2026, [issue #3677](https://github.com/Latand/delegatus/issues/3677), verbatim:

> 1. When a host is stopped while its turn is open, the launcher gets a failure or finish notice, and the turn is not left open.
> 2. A host recovered for a queued message receives that message as its first user turn. If it cannot, the receipt settles `failed` with resend `safe`.
> 3. A resume never starts an empty turn that the agent answers with "No response requested."

The dispatch request of 6 November authorizes diagnosis of this outcome. This document follows D3 and the dispatch matrix in `docs/audits/recent-issue-dispatch-followthrough-2026-11-06.md` at exact commit `b8c5744b80cfdd21012b932372a844e76d8ed6f8`. D6 was also read to preserve the separate background-turn owner. Private dispatch conversation text is excluded.

## Conclusion and implementation boundary

A current-source defect is reproduced: when an owned Claude child dies during an acknowledged active turn, `ClaudeStreamBrokerHost.fail()` clears the turn and publishes only a dead session status. The previous turn has no terminal event. Passing these actual broker events through `projectEngineHostEvent()` and `consumeRuntimeEvent()` produces zero completion-notice callbacks. This supports a small repair to terminal bookkeeping.

The historical empty-resume and missing-delivery cause remains unproven. In the isolated production queue/recovery/broker path, the original message reaches the successor exactly once. A result without its user echo produces a failed, uncertain receipt with `resend: verify-first`; replay sends nothing again. Moving the queued payload into the recovery launch prompt is therefore unjustified.

Implement only the reproduced terminal-event defect after coordinating the shared broker file with #3689. Preserve the delivery path. The historical orphan-stop decision, native background-job continuation, authenticated native MCP continuity, and the original delivery's final outcome remain acceptance work for this same task. A source patch cannot close the full issue on this evidence.

## Primary evidence and revision

- Source and forge main were `423bf964ed98d9dde744ad0f2c4f2dbf92ae146b` at intake and the 21:06 UTC recheck on 6 November. The assigned branch stayed unchanged.
- The complete current issue body and paginated comments endpoint were read twice. The issue remains open, with zero comments and `updated_at` of 5 November 08:18:12 UTC.
- The exact approved audit's D3, D6, matrix and limits were read. Its originating conversation's full final and relevant handoff turns were opened. Project-scoped and unscoped transcript searches led to the original issue reporter and the affected conversation, rather than relying on snippets.
- Original reporter envelopes establish a prior SIGKILL at 04:11:01 UTC attributed to `structured-orphan-stop`; the later send was accepted at 08:06:47. Its observed receipt had attempt zero, no terminal settlement, and phases `recovering-host`, `wake-lost`, and `evidence-unreadable`. These observations precede its recorded deadline. They do not establish its eventual outcome.
- The affected transcript's complete requested interval contains a tool result at 04:10:59, an assistant no-response record at 08:06:51, and an orphan-summary task notification at 08:06:52. That notification says three background tasks have no completion record and were marked stopped. It does not establish which component first invalidated the old writer.
- No original broker stdin/stdout trace, contemporaneous claim-transition record, or incident source revision was recovered from those envelopes. The transcript alone cannot establish an empty user input. No production key was replayed or changed.

## Discriminating probe

The probe extends the existing `structuredDelivery.integration.test.ts` recovery fixture in a scratch export. Product sources remain byte-for-byte from the pinned revision. It uses the real `AgentRegistry`, `RuntimeJournal`, `enqueueStructuredMessage`, held-delivery drain, `recoverDeadStructuredConversation`, publication controller, and `ClaudeStreamBrokerHost`. Host options come from `claudeStructuredHostOptions`.

The fixture launch callback performs real registry claim/stage/finalization and host publication; it substitutes the full production launcher and does not exercise its `resumeAdmission` callback handshake. The native executable is an owned local JSONL peer, launched through the broker's normal child-process seam. It answers the existing initialization/catalog envelope, records actual stdin, echoes selected user inputs, and emits controlled results. Authentication is synthetic. The background variant emits a synthetic task-start frame; it runs no real background workload and does not establish native support for that frame. This is adapter evidence, with explicit limits on native-provider and MCP claims.

Each case starts its own predecessor child, observes its turn identity, exits that child, and recovers the same session for a new original message. The late-result control lets the owned child emit its result during termination. Each child is retained by its spawn handle and reaped. Final logs record successful cleanup for every case.

| Case | Observed result |
| --- | --- |
| Idle predecessor exits | One successor; first successor user frame contains the admitted payload; delivered receipt |
| Active predecessor exits | Same successful queued delivery; previous acknowledged turn lacks a terminal event |
| Background-frame predecessor exits | Same delivery; previous acknowledged turn lacks a terminal event |
| Native peer accepts input but drops only the echo | Exactly one stdin write; failed receipt, duplicate risk true, `verify-first`; replay produces no additional write |
| Late ordinary result before child close | Exactly one terminal event for the original turn; next message still delivered once |
| Duplicate original request | Original operation/key retained; no second user frame |
| Owner, claim epoch, or permission changes after an await | Broker's final supplied dispatch guard refuses; zero refused-payload writes |
| Original terminal event passed to real consumer | Active and background death cases yield zero notice callbacks, failing the expected terminal obligation |

The final dispatch probe supplies the guard and mutates the isolated registry owner/epoch or local permission flag. It proves invocation of that guard before stdin. It does not independently prove every production permission producer. The epoch test is not a native-generation replacement test.

Four existing integration controls separately pass: stale synchronization-held steer across both engines; a published Claude migration successor receiving the original held message once; ownership loss during successor projection; and late discarded-successor cleanup preserving the committed target. These provide production migration/generation controls alongside the broker probe. They do not simulate every last-await replacement in a real native Claude process.

### Recorded runs

All commands use the stage's designated `gate-slot.sh` wrapper, one explicit file per command. The runner calls `checkEnvironment` and `isolatedEnvironment`, with private HOME, XDG directories, TMPDIR and LLV_STATE_DIR, a closed Viewer control endpoint, and local gate execution. No recorded-check handoff was used.

The project command was `bun run test src/lib/runtime/structuredDelivery.integration.test.ts -t <selection>`.

| Private log | Selection | Actual exit and result |
| --- | --- | --- |
| `probe-01.log` | `diagnosis recovery broker` | 0; 4 passed; 35 assertions; 2.31 s |
| `probe-02.log` | Terminal obligation and dispatch authority | 1; 3 passed, 2 expected regression failures; 22 assertions; 2.36 s |
| `probe-03.log` | `diagnosis` | 1; 8 passed, 2 expected regression failures; 68 assertions; 4.73 s |
| `generation-controls.log` | Four existing controls named above | 0; 4 passed; 23 assertions; 1.66 s |

The two final failures compare the expected error terminal event for the previous turn with an empty array. There is no patched-product green result. Bun was 1.4.0, build `34cbb9a40`. The log durations are observations, with no performance claim.

Probe sources, the runner, earlier fixture variant, raw logs, exit files and overlap snapshots are retained privately under the stage evidence directory. The final integration probe SHA-256 is `3d191d5b5cc6e2b6a50b72250f6f1dbc22dad59d5ef3d3742ddee0af1242ef1a`. Restore that scratch test over an export of the pinned source, together with `diagnosticNative.mjs`, to reproduce; it is diagnostic material rather than a new committed driver.

## Source mechanism and consumers

1. `structuredRecovery.ts:633` calls the existing spawn path with an empty prompt. `structuredSpawn.ts:2341` does not send an empty initial message. The recovered host is then published, and the accepted message continues through its existing delivery record.
2. `claudeStreamBrokerHost.ts:1080` validates queue identity and duplicate payloads. Its synchronous authorization check precedes ledger insertion and stdin writing. User echo confirmation at `:1618` establishes delivery; an ordinary `result` is insufficient for that confirmation.
3. The child's exit records its cause; its close handler invokes `fail()`. At `:1858–1867`, that function clears `activeTurnId`, rejects pending requests, publishes dead status and closes subscribers, without a terminal turn event. `finishRelease()` at `:1830` also clears an active turn without one.
4. `restore()` at `:1479–1490` can close a saved open turn, but a saved dead/unhosted status clears its candidate first. The fixture's persisted death therefore suppresses that fallback on adoption.
5. `engineHostEvents.ts:434` projects terminal events. `consumers.ts:83` invokes the completion obligation only for `turn-ended`. `serverConsumers.ts:39` applies the existing launcher, notification and containment checks, then writes the existing notice store. `spawnNotice/store.ts` inserts once per child and turn. `spawnNotice/production.ts` and `sweep.ts` own delivery and original notice-attempt replay.
6. A dead session status carries no equivalent obligation. A successful successor send cannot retrospectively supply the missing predecessor terminal event.

The orphan-stop admission at `registry.ts:856` requires a terminal row or a proven-dead engine, followed by writer and process-identity checks. Its destructive tree cleanup is deliberate. The missing historical fact is why the live background worker became eligible for that path. This diagnosis does not change those predicates or authorize preserving an unowned live writer beside a successor.

## Minimal builder brief

### Exact file scope

| File | Permitted intent and boundary |
| --- | --- |
| `src/lib/runtime/claudeStreamBrokerHost.ts` | Repair terminal bookkeeping in `fail`, verified `finishRelease`, and narrowly necessary `restore` handling. Retain original turn identity and existing event storage. Coordinate any common terminal helper with #3689 before editing. |
| `src/lib/runtime/claudeStreamBrokerHost.test.ts` | Add death/release/restore and late-result regressions to the existing broker fixtures. No standalone issue driver. |
| `src/lib/runtime/structuredDelivery.integration.test.ts` | Add a bounded Claude broker variant to the existing recovery fixture; prove original-message behavior and terminal-consumer obligation together. Use the existing owned-process utilities. |
| `docs/design/spawn-completion-notice.md` | Correct its claim that the crash path already emits a terminal event, and document the actual repaired boundary and remaining limits. |
| `docs/design/issue-3677-diagnosis.md` | Append final implementation/test evidence and unresolved acceptance; preserve deferred scope. |

Capture the real active turn before clearing it. Publish one error terminal event on an unexpected child death while the event store remains usable, before publishing dead status and closing subscribers. Clear its queue/partial/interrupt bookkeeping consistently. A queued but unacknowledged message must retain its delivery uncertainty and must not acquire a fabricated completed turn.

For an intentional release, terminal settlement follows verified termination, preserving the existing refusal when cleanup cannot be proved. Preserve a prior ordinary completed/interrupted result if it won the race. A late result, repeated exit/close, release after failure, and adoption must not create additional terminal events for the same turn.

Use the existing stored-event replay to reconcile the latest unmatched started turn when a recorded dead/unhosted status would otherwise suppress its terminal outcome. Distinguish a genuinely open start from already terminal history. Do not scan all retained sessions, invent turn identifiers, or replay historical user payloads. If the bounded retained event sequence cannot identify the turn, report that evidence gap. Ledger write failure must remain explicit; it cannot be represented as a persisted notice.

No new receipt schema, lifecycle service, poller, watchdog, queue, retry policy or ADR is justified. The existing terminal event and notice consumer are sufficient for the reproduced defect. If a required behavior cannot be expressed within these boundaries, return the new failing fixture and revise this brief before expanding source scope.

### Keep-list

- Preserve `structuredRecovery.ts`, `structuredSpawn.ts`, `structuredMessageDelivery.ts`, `structuredDeliveryQueue.ts` and `structuredDeliveryController.ts` product behavior. The probe does not justify changing their queue/recovery contract.
- Preserve native session ID, conversation lineage, account continuity, launch profile, tool/MCP configuration, original client key, operation ID, admission time, deadline and delivery evidence. A successor host reservation is separate from the original message receipt.
- Preserve provider/auth boundaries, claim ownership and epoch, latest-generation checks, update-drain/restart-cut holds, account permission checks, containment and process-tree identity fences.
- Keep the existing notice opt-out, pipeline/flow/seat containment, launcher audience and deduplication. A terminal event must not become a new authority to deliver to an obsolete launcher.
- Keep `verify-first` for an effect that may have landed. `resend: safe` requires evidence that delivery did not occur and cannot occur later. The issue's safe-resend wording cannot justify erasing known uncertainty.
- Preserve #3689's spontaneous background-turn identity work, the separate Codex explicit-resume review, and every original UNKNOWN operation. Do not copy an adjacent repair into this lane.

## Overlap and sequencing

Open PR file patches and registered worktrees were inspected, including working changes. The current #3689 lane `bbc46c26` was clean at the same base on recheck; its task remains active. Its approved scope is unqueued native background start/result identity in `acceptMessage`/`acceptResult`, whereas this reproduction concerns death of an already identified turn. Both may need common terminal bookkeeping: sequence their edits and review the resulting shared helper once. This stage made no coordination send or board mutation; the builder must obtain the current actual diff before changing that shared code.

| Existing work | Actual overlap | Required disposition |
| --- | --- | --- |
| #2926, head `9ba35560` | Broker process identity, managed spawn, health and signal paths; registry signal-domain checks | Preserve all signal-domain and termination logic. Proposed terminal emission does not justify rewriting those hunks. Some equivalent code is already on main; compare against the refreshed base. |
| #3355, head `ac447bea` | `structuredDeliveryQueue.ts`, native-queue parsing with durable-replay compatibility | Keep untouched. Include its behavior if queue scope later changes. |
| #3668, observed head `25783bad` | Controller dispatch context and pipeline authorization for native queue and ordinary sends | Preserve final dispatch authority. No controller product edit is proposed here. |
| #3710 / lane `83306a33`, observed head `edb2bf06` | Adjacent admission/registry recovery ownership; no diff in this brief's broker terminal methods | Keep the lane and its uncertain operations separate. |
| Existing local recovery/context work | Reconnect tool configuration, expected-host release identity, generation/injection binding, and delivery uncertainty | Retain these behaviors. The inspected older worktrees are comparison evidence, not source to import. |

An incomplete-index worktree exposed tracked deletions plus replacement untracked files. Comparing its actual broker bytes showed an older version missing later publication-source, echo and timing changes; it supplied no repair to `fail()` or `restore()`. Those index deletions are not a removal proposal for this task.

There is no proposed product patch in this stage, so a merge simulation would not validate a real combined implementation. Before builder publication, re-read #3689's current hunks, perform the scratch combined-tree conflict check, and run both owners' behavioral tests. Preserve all existing review budgets; runtime lifecycle work requires three independent review rounds.

## Acceptance and per-file checks

Run each file separately through the designated wrapper with fresh isolation, log and actual exit. Start with the current-base reproduction, then run the same case on the implementation. No full suite, typecheck or build is authorized by this diagnostic stage. Publication retains the required hooks and CI.

| Check file | Required assertions |
| --- | --- |
| `src/lib/runtime/claudeStreamBrokerHost.test.ts` | Idle death produces no invented turn. Active/attention/background-associated death closes the actual turn once. Verified release, failed release, late result, repeated close, adoption and ledger failure retain honest outcomes. Unknown/compaction results do not acquire a user turn. |
| `src/lib/runtime/structuredDelivery.integration.test.ts` | Owned child exit → real recovery → first user input → original receipt. Include the production `spawnStructuredConversation` and `resumeAdmission` handshake behind an isolated runtime client. Confirmed input once; reply-only loss uncertain; duplicate original key before/after controller and broker restart never reexecutes. Terminal event reaches real consumer/store once and produces one authorized launcher notice. Test latest generation, writer replacement and permission revocation at the last awaited boundary. |
| `src/lib/runtime/structuredRecovery.test.ts` | Original lineage/account/profile retained; no duplicate successor; owner changes during admission and cleanup retain the current owner. Restrict this task's new cases to Claude; preserve the existing Codex work. |
| `src/lib/runtime/structuredRecoveryBinding.test.ts` | Existing recorded-account and project-binding controls remain green. These existing tests use a Codex fixture and do not alone establish Claude coverage. |
| `src/lib/spawnNotice/sweep.test.ts` | Completion obligation replay and delivery-answer loss preserve one notice; opt-out, contained stages, superseded/archived recipients and current-seat resolution stay enforced. |
| `src/lib/runtime/claudeStreamBrokerHost.compact.test.ts` | Required if shared terminal handling changes: compact result without a user turn remains command evidence and creates no launcher notice. |
| The two design documents | Whitespace, manual factual/privacy review, and the repository privacy gate over explicit paths. |

Final acceptance must separately establish the real native tool/MCP identity after recovery, using the intended fixture identity, and retain the original native turn/session evidence. The local catalog double does not prove authentication. Real background-job survival requires an owned background process and the actual orphan eligibility chain; a task-start frame cannot prove it. No live agent, production receipt, provider account or paid request is an acceptable substitute for that fixture.

The full task remains open until the historical delivery branch is discriminated and the installed revision is separately accepted. The safe next observation is an isolated replay using captured native resume envelopes and a recorded registry/claim sequence: compare host-only resume before any user input with queued first-input delivery, then compare rightful live-writer retention with terminal orphan admission. If those original bytes cannot be recovered, record the missing evidence and retain the explicit reproduction limit; do not infer that the empty prompt caused the incident.

## Deferred — not currently justified

- Changing the launch prompt to carry the queued message, or allocating a replacement message key.
- Altering orphan retirement, preserving arbitrary detached jobs after a dead owner, or broadening recovery to unverified live writers.
- Implementing spontaneous background-turn identity here; #3689 owns that outcome.
- Changing notice schemas, adding a second terminal journal, adding global polling, or repairing historical rows in bulk.
- Repeating the separate Codex explicit-resume review or adopting any original UNKNOWN operation.
- Real-provider execution, installation, restart, deployment and production message replay. These require their own authorized acceptance step.

This diagnosis changes only this document. It establishes a reproducible terminal-bookkeeping defect and a constrained implementation brief, with the empty-resume cause and native acceptance gaps retained explicitly.
