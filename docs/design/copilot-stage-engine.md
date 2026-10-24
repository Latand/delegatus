# Copilot as a pipeline stage engine

Status: proposed. Scope: issue #2173. Source: Codex Cloud (GPT-6.1 Sol), result `24.diff`, collected 2026-10-23. Code references checked against `adce57649`. Implementation is separate work.

## The operator's problem

When Claude or Codex runs out, I want a third quota pool that can keep pipeline work moving. Copilot CLI already runs an individual agent through ACP. I need to choose it for a stage and trust the same completion report, worktree checks and recovery rules that protect other stages. I also need to know which model and account will spend that allowance, and when Delegatus will refuse to proceed.

A successful first release lets an operator select Copilot for a builder, reviewer or verifier **run stage**, including a run stage in a verdict-driven review graph. A mixed graph can build on one engine and review on another. Copilot receives the normal stage contract, reports through `stage_report`, and passes the existing controller checks before an edge advances. Selecting Copilot does not authorize automatic engine changes, paid overage, deployment, or an orchestrator seat.

This narrows the combined pipeline/seat scope of [the earlier slice plan](copilot-slices-2-4-plan.md#5-slice-4--pipelines-and-the-orchestrator-seat-later-pr-waits). Its line numbers are historical. References below describe the current checkout; no fresh live CLI or billing experiment was run for this design.

## Three variants

| Variant | Operator experience | Benefits | Costs and limits |
| --- | --- | --- | --- |
| 1. Explicit Copilot run stages | Choose Copilot, a model and optionally an account on a stage. After another engine exhausts its pool, explicitly retry or hand off to Copilot. | Smallest useful scope; spending and stage ownership stay visible; reuses the graph controller. | Recovery still needs an operator choice. Restricted execution and legacy review-loop stages remain unavailable. |
| 2. Policy-driven third pool | Configure an ordered engine/model fallback list. Exhaustion can select Copilot without intervention. | Unattended progress through quota exhaustion. | Needs cross-engine sizing, spending limits, transition history and proven writer retirement. An ambiguous transport error must never trigger a second writer. |
| 3. Copilot throughout orchestration | Extend variant 2 to seats, task fan-out and legacy review flows. | One engine can run the whole workflow. | Adds context-window policy, handoff digests, every automated sender and flow-specific verdict handling to the critical path. Much larger verification surface. |

**Recommend variant 1.** Implement the shared contracts properly, then expose it as opt-in. Do not widen a global union and interpret every newly compiling path as supported. Keep explicit capability checks for run stages, legacy flows, seats and restricted execution. Variant 2 needs its own design and operator spending policy; variant 3 should follow evidence from real stage use.

## What exists, and which state changes

The table separates working single-agent support from gaps that stage admission must close.

| Current code | Current behavior and proposed change |
| --- | --- |
| `src/lib/roles/types.ts:19`, `src/lib/agent/runtimeConfig.ts:3`, `src/lib/pipelines/types.ts:1` | Role/runtime/stage configuration inherits a two-engine union. Extend stage-capable configuration and its validators, saved role settings and UI mappings. Audit consumers instead of casting Copilot through Claude or Codex. |
| `src/lib/mcp/server.ts:3907`, `src/lib/pipelines/engine.ts:603`, `src/lib/accounts/engineConnection.ts:22` | Stage schema and readiness remain two-engine. Add Copilot to the stage request schema and binary/auth checks; retain `ENGINE_NOT_CONNECTED` and stage-specific reasons. Recheck before dispatch. |
| `src/lib/agent/spawnCommand.ts:844`, `src/lib/agent/spawnCommand.ts:1210` | Single-agent spawn deliberately omits Copilot pipeline membership/adoption. Enable these only after the same stage capability validation as controller launches. Preserve creator and parent attribution. |
| `src/lib/pipelines/engine.ts:682`, `src/lib/pipelines/engine.ts:703` | Parent transcript recognition is two-engine; the stage spawn adapter already reserves a structured launch and membership. Recognize Copilot parents, supply its selected home/profile, and preserve the reservation callback and request digest. |
| `src/lib/accounts/projectBindings.ts:41`, `src/lib/accounts/manager.ts:667`, `src/lib/accounts/projectSelection.ts:192` | Bindings are two-engine. Copilot project selection currently passes `project: null` and `bindings: []`. Extend binding validation/storage and use the actual project pool before admitting stages. The shared selector also explicitly bypasses Copilot bindings today; changing only the manager is insufficient. |
| `src/lib/accounts/copilot.ts:88`, `src/lib/accounts/copilot.ts:325` | Managed home and account context already exist; metadata uses `copilot-accounts.json`. Reuse these homes and login state. No pipeline-specific credentials or copied token files. |
| `src/lib/agent/copilotModels.ts:15`, `src/lib/agent/copilotModels.ts:168` | Per-account catalog records model options, effort metadata, source and capture time in `copilot-model-catalogs.json`. Use it for the picker and validation; validate entitlement separately from catalog discovery. |
| `src/lib/limits/copilotQuota.ts:11`, `src/lib/limits/copilotQuota.ts:37`, `src/lib/accounts/manager.ts:670` | Native quota snapshots already feed account selection through registry observations. Reuse them; expose unknown/stale capacity honestly and keep exhaustion separate from authentication failure. |
| `src/lib/pipelines/store.ts:42`, `src/lib/pipelines/store.ts:482` | Pipeline persistence uses `state.sqlite`, JSON mirrors/archives and pipeline artifacts; stored reports already validate actor, verdict and provenance. Extend engine validation without losing old rows or unknown future records. Require a migration only when the persisted shape changes. |
| `src/lib/pipelines/types.ts:362`, `src/lib/pipelines/types.ts:447` | Attempts already retain runtime choice, account, usage-limited accounts and switch history. Record Copilot through the same fields; preserve the original attempt and every replacement's lineage. |
| `src/lib/runtime/copilotAcpHost.ts:160`, `src/lib/runtime/registry.ts:103`, `src/lib/runtime/registry.ts:523` | Native `session-state/<session>/events.jsonl`, ACP host identity and host persistence already exist. Reuse native session identity and generation fences; add stage recovery coverage. |
| `src/lib/pipelines/durableEvidence.ts:675` | Durable evidence currently branches on Codex and otherwise reads Claude records. Add an explicit Copilot decoder for messages, tool work, turn boundaries and terminal errors. Never route Copilot through the Claude fallback. |
| `src/lib/mcp/server.ts:1656`, `src/lib/pipelines/engine.ts:15555`, `src/lib/pipelines/engine.ts:15756` | MCP receipts and actor-bound reports already exist. Preserve tool replay semantics, current-conversation authorization, report sequencing and asynchronous provenance collection. |
| `src/lib/pipelines/stageSandbox.ts:10`, `src/lib/runtime/structuredSpawn.ts:175`, `src/lib/runtime/structuredSpawn.ts:2053` | Repository access and execution sandbox are separate axes. Shared scratch/config isolation exists, but Copilot host options translate permissions to `allowAll`; restricted sandbox enforcement remains unverified. Refuse restricted Copilot stages until enforcement exists. |

Local records can retain internal account IDs and runtime paths where required for recovery. Public docs, diagnostics exported as evidence, examples and fixtures must use anonymous account labels and relative paths. Never include credentials or copied account configuration in a receipt.

## Stage execution contract

### Admission and model choice

Validate a complete effective runtime before reserving a launch: supported stage kind, engine, model, effort, account policy, sandbox and MCP availability. Preserve explicit selections in the attempt's effective role and durable launch profile. A caller choosing a Copilot model does not choose the identically named model on another provider.

The picker uses the selected account's catalog. Prefer an explicit model for pipeline reproducibility; allow `auto` only as an explicit operator choice and show that the provider chooses the model. Do not replace an absent model with `auto` or a static default. A static/stale catalog can offer discovery hints; it cannot certify an explicit model's availability. Validate against fresh ACP configuration where available, and otherwise let a bounded launch establish support. A provider rejection parks the attempt with the requested model intact.

Effort must be supported by that model's discovered metadata. Reject an explicitly unsupported effort; do not invent reasoning support from the model name. Preserve model and effort on resume because the child process fixes those flags (`src/lib/runtime/structuredSpawn.ts:2048`). Reject Codex-only `serviceTier` and fast-mode settings on Copilot. Record the requested model, catalog source/time and any provider-observed model separately; `auto` is not proof of the actual model used.

Widening role types also reaches sizing and equivalence tables. Add deliberate Copilot entries for offered models. An unknown model or `auto` has unknown size; it must not silently satisfy a stronger model requirement. Keep existing role defaults until an operator changes them.

### Account and quota policy

For an unpinned stage, select an eligible signed-in account from the project's allowed Copilot pool using current capacity observations and the existing selector. For a pinned stage, either use that account or report why it cannot start. Pipeline account requests must respect the pipeline's project constraints. Apply this policy at stage launch while preserving the existing explicitly attributed account-override controls (`src/lib/accounts/projectSelection.ts:208`). A separate operator override remains explicit and recorded; fallback never acquires that authority. Preserve the existing distinction between an absent binding, an empty allowed set and an unreadable binding record; none authorizes silently widening a configured pool.

Persist the chosen account at reservation, before sending the first message. An ACP session belongs to that account's `COPILOT_HOME`; changing accounts requires a new conversation. A retry replays the original receipt and its account choice. If the selected home was removed, park with a repairable account error instead of adopting another home.

Treat the Copilot allowance as independent of Claude/Codex allowances, while acknowledging that its models may share a Copilot quota bucket. Existing snapshots map the most constrained finite chat/premium bucket into common limits. Validate spending authority separately; these snapshots only report observed allowance. Unknown capacity may permit one normal launch under the existing policy; it must not cause repeated probes or claims of available quota. Observed exhaustion holds the attempt until a known reset or an operator selects a different eligible account/runtime. With no reset timestamp, require fresh evidence or operator action.

Variant 1 does not rotate accounts or engines underneath a running attempt. Do not enable paid overage, alter a subscription setting, or treat an overage-enabled snapshot as spending authorization. Retain existing paid-credit controls; provider-side spending configuration must be reviewed separately if the CLI cannot enforce a hard budget. Authentication, unavailable-model, transport and quota errors need distinct reasons.

### Launch, reporting and settlement

1. Reserve the normal launch receipt with engine, account, effective profile, request digest, conversation, pipeline membership and attempt identity. Persist the reservation before native dispatch. Stage preparation retains its Git guard and activation recheck (`src/lib/pipelines/engine.ts:885`, `src/lib/pipelines/engine.ts:892`).
2. Start the existing ACP host with a stage-scoped Viewer MCP attachment. Its server identity supplies the conversation actor; a pipeline ID or stage ID in model-generated text grants no authority. The Copilot adapter already builds the CLI MCP configuration (`src/lib/runtime/copilotAcpHost.ts:199`). Verify the granted tools include `stage_report` and required stage reads.
3. Deliver the normal role prompt, stage contract, declared outputs and test-state isolation instructions. Require `stage_report` with pass/fail, findings and a concise summary. Its `clientRequestId` is stable on retransmission of the same call. A revised report is a new call, using the existing replacement rules.
4. A successful tool acknowledgement means the report was saved. It does not mean the stage passed. The existing report path records pending provenance; the controller obtains Git/output evidence and waits for terminal work before settling. Preserve background-work holds, read-only output checks, commit/publication checks and verdict-driven edges.
5. A terminal ACP response without a report is not success. Use the existing bounded missing-verdict recovery after proving the turn idle. For initial Copilot support, require a recovered MCP report; do not infer a pass from prose, an exit code or a fenced text verdict. If the report still cannot be obtained, park with the native outcome and missing-report reason.

A reviewer or verifier is a run stage with its existing role/access contract. Legacy `review-loop` is a separate flow executor: the current report resolver explicitly refuses it (`src/lib/pipelines/engine.ts:15613`). Keep that refusal for Copilot in variant 1. Normal run-stage pass/fail edges support review rounds without pretending the legacy flow was implemented.

### Receipts and recovery

Keep three records distinct: the spawn receipt proves launch/identity; the durable delivery operation proves what happened to a particular message; the MCP/report receipt proves accepted intent. None alone proves a clean worktree or a settled stage.

The Copilot evidence adapter must read native prompt, assistant, tool and terminal/error events and correlate them with the registry's operation, generation and event cursor. Native `session/load` history replay must not create a new completion or make an old report current. Use the existing bounded stable-tail and identity checks; truncated or raced evidence stays unknown. Retain native transcripts for diagnosis rather than synthesizing Claude-shaped files.

On controller or runtime restart, reconcile the original launch and message operation first. If delivery is uncertain, retain the original reservation and park after bounded recovery; never launch another writer just because the stream disappeared. Resume the same account/session only when identity and ownership are proven. Replays of an accepted `stage_report` return its receipt without adding another report sequence or taking another edge. A report from a superseded conversation remains refused.

An explicit switch from Claude/Codex to Copilot, or between Copilot accounts, must use a fresh conversation and the existing runtime-switch lineage. Stop and verify the old writer, preserve the worktree and accepted findings, then reserve the successor. If that handoff is not yet verified for Copilot, expose only a safe fresh-attempt retry after retirement; keep live switching disabled. Do not erase dirty work or start competing writers to make fallback look seamless.

Copilot has no in-turn steer. Stage reminders, verdict requests, repair messages and automated relays must explicitly queue or use a verified idle continuation. Audit callers of the generic send seam (`src/lib/pipelines/engine.ts:2268`); its optional policy can inherit an interrupting default. Interrupt-and-resend is reserved for an explicit stop/change-course action. A cancelled turn is never reported as successfully steered.

### Sandbox and publication boundaries

Admit `sandbox: full` only in variant 1. Display that it permits host tools/network and uses Copilot's broad permission mode. Keep `access: read-only` independent: it is the pipeline's repository mutation contract, with declared-output exceptions, checked at settlement. It is not an operating-system read-only boundary. A read-only reviewer may need commands and output writes just as other stage engines do; do not accidentally disable all tools by mapping role access to Copilot's single-agent permission setting.

Refuse `sandbox: restricted` before dispatch with a capability reason. Removing `--allow-all`, waiting for permission prompts, isolating XDG config, or putting work in a worktree does not implement the restricted filesystem/network contract. A future restricted adapter requires an enforceable boundary and escape tests, including shell, symlinks, network and MCP tools.

Reuse the shared attempt scratch lifetime and `withAgentConfigSandbox` (`src/lib/runtime/copilotAcpHost.ts:165`). Preserve the real MCP endpoint's scoped identity and selected authentication home while commands resolve disposable application state. Stage verification isolates HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR as required by repository instructions. Config isolation protects application state; it does not make a full-access process secure against hostile code.

Publication stays in the existing pipeline publisher. Copilot must not skip privacy scans, hooks, review gates or release approval. Existing deployment-role restrictions remain. Native subagents remain disabled for the initial release; otherwise background writers would need evidence and retirement coverage before settlement.

## Refusals the operator should see

| Condition | Result |
| --- | --- |
| CLI absent, runtime unavailable, no eligible signed-in account | Refuse before dispatch with the stage and repair action; never substitute another engine. |
| Disallowed pinned account, damaged binding store, removed account home | Refuse/park with the binding or account reason; do not broaden the pool. |
| Unsupported model/effort, Copilot service tier, unsatisfied sizing rule | Preserve the request and ask for a supported runtime choice. |
| Restricted sandbox, legacy review-loop, seat or unsupported live switch | Capability refusal before starting a child. An enum accepting Copilot is insufficient admission. |
| Exhausted quota, unknown reset, unapproved paid spending | Hold with observed evidence; no busy retry loop and no automatic paid fallback. |
| Missing/misattributed report, stale generation, unresolved delivery or writer teardown | Preserve receipts and worktree; bounded recovery then park. No assumed pass or duplicate launch. |
| Repository/output violation, failed checks, unfinished background work | Apply existing settlement rules. A Copilot report cannot waive them. |

## Implementation slices and acceptance criteria

### 1. Admission, configuration and account constraints

Extend stage configuration, parsers, persistence validation, MCP schema, readiness, model/effort choices and project bindings. Add capability refusals before exposing unsupported paths. Keep default role mappings unchanged.

Acceptance: API/MCP/UI round-trip the same explicit runtime; a stored mixed-engine graph survives reload. Missing CLI/auth, disallowed accounts, damaged bindings, unsupported effort/service tier and restricted sandbox all refuse without dispatch. Unpinned selection stays in the allowed pool; pinned selection never drifts. Existing Claude/Codex fixtures still deserialize. Seats and legacy flows remain refused.

### 2. One run stage with trustworthy completion

Connect Copilot to the reserved structured spawn path and pipeline membership. Attach scoped MCP; implement explicit native evidence decoding; adapt full-access permission mapping without confusing repository access with sandbox.

Acceptance: a Copilot run stage reports pass and fail through real MCP serialization and takes each edge once. Wrong-conversation and superseded reports refuse. Duplicate request IDs replay. A report with pending provenance, active tool work, missing output or forbidden mutation does not advance. Native completion without a report parks after bounded recovery. A mixed builder/reviewer run graph retains findings and provenance across engines.

### 3. Failure recovery, exhaustion and safe operator replacement

Exercise receipt replay, ACP load, restart, account removal, queue policy, quota holds and old-writer retirement. Enable explicit handoff only after its acceptance tests pass; otherwise ship the narrower fresh-attempt retry.

Acceptance: cut the connection before dispatch, after native session creation, after first delivery and after report persistence. Each restart yields one owned launch, one delivered operation and at most one edge transition. Unknown delivery never creates a second writer. Replayed history cannot revive an old report. A missing home parks; an exhausted account retains its reset evidence. An operator replacement preserves dirty work and refuses to proceed until the predecessor is proven stopped. Automated reminders to a busy Copilot stage do not cancel its turn.

### 4. Opt-in exposure and operational evidence

Enable the picker only after slices 1–3. Show requested engine/model/effort, selected anonymous account label, quota freshness, full-access status and actionable refusal text. Keep native paths and credentials out of public evidence. Provide an admission kill switch that blocks new Copilot stages while allowing existing receipts to reconcile.

Acceptance: render the stage picker, attempt detail and a parked stage through the repository's existing browser drivers, in both supported languages and themes. Verify no unsupported option is offered. Run an opt-in real Copilot smoke stage on a disposable repository with a preselected account and model; capture sanitized launch, report, settlement and quota observations. A local provider stub proves protocol behavior. Subscription entitlement and billing require provider observations. No paid smoke run or live-state mutation is implicit in this design.

For implementation, extend focused suites such as `src/lib/accounts/manager.copilotSelection.test.ts`, `src/lib/pipelines/stageAccountBinding.test.ts`, `src/lib/pipelines/stageCompletion.test.ts`, `src/lib/pipelines/durableEvidence.test.ts`, `src/lib/pipelines/stageVerdictRequest.test.ts`, `src/lib/runtime/copilotAcpHost.test.ts` and its opt-in integration suite. Run named files with private HOME/XDG_CONFIG_HOME/LLV_STATE_DIR/TMPDIR through the repository's gate procedure. Changes to runtime-host code require its mandated three review rounds and process-specific verification; a passing Viewer check is not host evidence.

## Decisions for the operator

1. **How much fallback should the first release automate?** Recommended: explicit Copilot stage selection and explicit safe replacement only (variant 1). Add ordered cross-engine fallback after spending and retirement policies have their own design.
2. **Which stage forms should launch first?** Recommended: ordinary run stages, including run-stage review graphs. Keep legacy review-loop, seats and task fan-out out of this issue.
3. **Is full host access acceptable for opt-in Copilot stages?** Recommended: yes where the operator already permits full-access stages, clearly labeled; refuse restricted requests until an enforceable adapter is tested. Do not relabel permission prompts as a sandbox.
4. **Should `auto` be the default model?** Recommended: no. Require an explicit supported model for saved pipeline choices; permit an intentional `auto` choice with provider selection shown as unknown until observed.
5. **Should Copilot accounts rotate during a running attempt?** Recommended: no. Resolve and persist an allowed account at launch; an account change creates an explicitly attributed successor conversation after retirement.
6. **What should happen when capacity is unknown or exhausted?** Recommended: one normal attempt may establish unknown capacity; known exhaustion holds for a verified reset or operator choice. Never enable paid overage automatically.
7. **Can a terminal text answer substitute for `stage_report`?** Recommended: no for initial Copilot stages. Allow bounded report recovery, then park. Retain the same provenance and publication gates after the report arrives.
8. **When is live runtime switching ready to expose?** Recommended: only after slice 3 proves old-writer retirement, receipt replay and dirty-work preservation. Ship fresh-attempt retry first if those proofs are incomplete.
