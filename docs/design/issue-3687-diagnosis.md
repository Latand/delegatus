# Engine MCP refusal and management-channel health

> “A tool-call failure with this engine text is classified as a lost management channel, separately from Viewer rejections, and surfaces within one wake interval even when the host is alive.”

Originating public requirement: [issue #3687](https://github.com/Latand/delegatus/issues/3687), updated 5 November 2026 at 12:33:18 UTC. Its other requirements are an external recovery route, preservation or explicit accounting of pending approvals and deliveries, and usable read-only tools under the existing permissions. The private dispatch instruction dated 6 November authorizes this diagnosis; its conversation text is excluded from this public document.

## Decision and boundary

The current source has a reproduced detection gap. A recorded engine approval refusal reaches the real Codex adapter and its event store, while the seat health reader still reports a fresh stdio launcher as healthy. The real tick consumer then resolves its MCP incident and admits a wake. HTTP seats have no equivalent launcher observation. This justifies carrying a small, generation-bound engine observation into the existing health decision.

The cause of the engine requiring approval is **unresolved**. The evidence does not justify changing approval policy, sandbox access, credentials, capabilities, automatic recovery policy, or tool permissions. The initial diagnosis and baseline probes below establish the implementation boundary. The authorized source continuation is documented at the end; independent review, installation acceptance and task completion remain outstanding.

## Primary records and source

The complete current issue body and the paginated comments endpoint were read on 6 November. There are zero comments. The assigned source and GitHub main both resolve to `423bf964ed98d9dde744ad0f2c4f2dbf92ae146b`. The approved twelve-row matrix, D5 and overlap/unknown sections were read from `b8c5744b80cfdd21012b932372a844e76d8ed6f8:docs/audits/recent-issue-dispatch-followthrough-2026-11-06.md`. Its final originating audit turn was opened as well.

Project-scoped transcript searches for the issue, the exact refusal and the unavailable-seat condition were followed by an unscoped exact-phrase search. The latter located the affected seat in another project's conversation. Full relevant messages were opened through `conversation_messages`; the local original JSONL supplied the exact event envelopes. An earlier seat and a sandbox-startup incident were also examined and excluded as causal evidence for this seat. Task searches across statuses for the exact issue path, approval-policy wording and the current outcome found this lane as the matching outcome owner; the broader MCP page was partial and supplies no global absence claim.

The affected transcript contains **23 actual failed `McpToolCall` completion events** with the exact error, across the four reported batches: 30 October 22:22 and 23:59, and 31 October 05:55 and 07:52–07:54 UTC. The sample at 22:22:49.574 is a `conversation_messages` call. These are direct failed events, excluding successful reads that merely quote the error. The 23:59 result is now independently confirmed, extending the issue reporter's narrower observation. No uninterrupted outage between batches is inferred.

The retained shape is:

```json
{
  "type": "McpToolCall",
  "server": "viewer",
  "tool": "conversation_messages",
  "arguments": {},
  "status": "failed",
  "error": { "message": "MCP tool call requires approval, but approval policy is never" },
  "duration": { "secs": 0, "nanos": 0 }
}
```

Arguments and identifiers above are sanitized. The original private envelopes remain outside the repository. This is a rollout event, not a captured app-server wire frame. The probe converts the discriminant to `mcpToolCall` and duration to `durationMs`, retaining the failure status and error object. The installed CLI's locally generated experimental schema documents that wire shape. It does not explain why the historical engine demanded approval.

CLI: `codex-cli 0.166.0`. Generated with a private scratch `CODEX_HOME` using `codex app-server generate-json-schema --experimental --out <scratch-schema>`. The combined schema SHA-256 is `8aabf260bb66e9ca9ae5d20253f443971834644fe4659c85f8b1cc9e1d22dd5c`. `McpToolCallError` requires a message; `McpToolCallResult` carries content and optional structured content. The adapter fixture uses its established protocol pin, 0.162.1. This stage ran no native provider turn and claims no version-equivalence proof.

## Discriminating probes

All probes used a scratch export of the assigned commit, existing production imports and established fake transports. Only diagnostic tests were appended in that export. Each explicit test file ran separately through the stage's designated gate wrapper, with a fresh log and actual exit. The driver applies `checkEnvironment` and `isolatedEnvironment`, isolates home/config/state/temp roots, and points Viewer control at loopback port 1. It creates its sandbox under the stage-owned scratch root as required by this stage. No live MCP canary, model request or real message was sent.

Private evidence is under `$LLV_EVIDENCE_DIR/diagnosis/`: retained probe sources, `run-check.ts`, original/sanitized envelopes, generated schema, logs and `.exit` files. Raw records have private file permissions. Source digests and original line locators are retained there rather than published with identities.

| Probe | Real boundary exercised | Observed result |
| --- | --- | --- |
| `adapter-probe.log` | Recorded-shape refusal → established fake app-server transport → `CodexAppServerHost` → event store; `seatMcpHealth` reads a fresh heartbeat | Refusal retained; host idle; stdio `healthy`; HTTP `untracked`. Structured refusal, success, unknown error and malformed error controls have the same launcher health. Startup 503 is refused by `assertViewerMcpTools`. 1 pass, 17 assertions, exit 0. |
| `controller-probe.log` | Real `seatMcpHealth` → existing tick fixture → `runSeatTickCheck`, with a live host | Fresh launcher: one delivery and resolved MCP card. Three transport failures: zero deliveries, open card and `seat-mcp-unavailable`. 1 pass, 4 assertions, exit 0. |
| `service-probe.log` | Real `createMcpToolService` policy/receipts → production-shaped tool results → actual Codex adapter | Server policy refusal: `forbidden`, `retryable:false`, zero binding effects. Permitted synthetic binding plus same-key replay: one effect, replay acknowledged, three adapter events retained. 1 pass, 6 assertions, exit 0. |
| `requirement-red.log` | Same adapter refusal input, assertion changed to the required unavailable verdict | Expected `dead`, received `healthy`; 1 failed test, exit 1. This is the intended baseline failure, not a passing repair check. |

These probes compose producer, adapter and consumer observations. They do **not** constitute a new end-to-end production recovery test: the adapter has no health writer to connect to the controller today. The service control injects a synthetic binding behind the real policy and receipt machinery. It proves that local control's idempotency, not the historical publication outcome or every production authorization path.

## Established mechanism and remaining unknowns

1. `src/lib/runtime/codexAppServerHost.ts:1690` retains the requested approval policy, defaulting to `never`. Socket-owner adoption preserves its thread policy. Discovery at `verifyViewerMcp` checks the tool catalog; catalog presence does not prove permission to invoke a tool later.
2. The `item/completed` handler around line 4785 emits the failed MCP item into the ordinary runtime event path. The error is available at ingestion. No management-health observation is projected from it.
3. `bin/mcp-server.mjs:451` changes transport-failure counters only for replies to calls the launcher saw. A refusal before MCP dispatch cannot update those counters. Its structured business-refusal branch correctly preserves a working transport; changing that branch would misclassify ordinary authorization failures.
4. `src/lib/monitor/seatMcpHealth.ts:16` reads only launcher liveness and transport counters, and returns early for HTTP. `seatTickController.ts:1746` supplies that result; around line 2128 the card resolves for a non-dead result, and around line 2282 wake admission checks for `dead`.
5. The existing host checkpoint path already enforces the writer claim and coalesces pending state. `codexHostColumns`, `sameMaterialHostState` and `normalizeStructuredHost` currently carry no MCP capability observation. Merely adding an in-memory host field would lose the signal before the monitor reads it.

The historical launcher record at the failure timestamps, server request logs, exact engine/config revision and pre/post configuration layers were not recovered. The current heartbeat cannot reconstruct them. Therefore the probes establish a present source defect and a compatible incident mechanism, without proving the historical controller first raised its card late or identifying a deployment-induced configuration change.

The next safe historical observation is a retained, time-correlated app-server request/notification trace plus the matching launch receipt/heartbeat and effective MCP approval configuration for one failed batch. Inspect saved artifacts only. If those artifacts do not exist, record that fact and keep the configuration cause open; neither a paid model probe nor a live retry is authorized. The required health repair can proceed independently because its source failure is reproduced.

## Minimal implementation contract

Use the existing host-state checkpoint and seat tick. Add no polling loop, transcript scan, replay executor, recovery framework or new database schema.

At authenticated current-thread `item/completed` ingress, classify only Viewer MCP items. Recognize the exact engine-reported approval refusal in the typed error field; never search arbitrary result bodies, assistant prose or tool arguments for it. Label its provenance as an engine-reported refusal: absent server logs do not prove that no server request occurred. Preserve unknown/malformed inputs as unverified evidence. A structured Viewer refusal remains a server decision with its original code and retryability. Startup 503 stays on the existing launch-failure path.

Carry a bounded management observation as an optional host-state field. It records a fixed error class, observed sequence/time, and affected tool names, with its current host generation and writer claim supplied by the owning registry row. No raw error body, arguments, capability, account information or request payload is copied into the health projection. Limit tool names to 128 ASCII characters and outstanding denied capabilities to 32; overflow remains explicitly unverified and cannot clear to healthy by eviction. These are proposed bounds, requiring the extremes below before implementation acceptance.

A known engine denial makes the affected management capability unavailable immediately, independently of transport liveness and startup grace. Multiple denied tools remain individually outstanding. A later successful **same-tool** result can clear that tool's denial only when its matching start was observed after the denial in the same current generation. Completion order alone cannot establish that. An unrelated successful call, catalog refresh, heartbeat, ordinary server refusal, unknown error or replayed old success cannot clear it. Bound the in-flight recovery correlation to the same 32-item limit; missing or overflowed correlation leaves recovery unverified. An overflow stays unverified until independently established successor recovery. A positive observation describes the tool that answered; it does not claim every management action is authorized.

Persist a material change through `bindStructuredHostPersistence`; include it in `sameMaterialHostState` so a denial does not wait behind cursor-only debounce. Use its existing bounded asynchronous write/retry path. Reconstruct evidence from the adapter's existing event restoration, without treating an old generation or older success as fresh recovery. Failure to persist or validate a previously known denial must remain unverified, rather than silently authorizing a wake.

Extend the existing keyed seat projection to return the current generation's normalized observation. Resolve its entry using the conversation engine and last generation ID, verify its artifact identity and current writer claim, and read only that named entry. SQLite and JSON implementations must agree. Preserve the existing alias traversal and SQLite 3.39 compatibility. The monitor reads this projection once per decision; it does not enumerate sessions or read entire transcripts.

Combine capability evidence with launcher evidence before the HTTP early return. Expose the fixed reason through the existing `mcp-unavailable` card and wake refusal. Keep host reachability separate: a live host with engine-denied MCP receives no automatic death classification, release or restart. Recheck seat epoch, generation and ownership after awaits and immediately before wake dispatch, using the existing guards. An unavailable management observation is not an instruction to retry an original effect.

## Exact file fence and checks

The following is the proposed implementation fence. The diagnostic stage changes only this document. Test additions belong in these existing files; no issue-specific driver or new abstraction is needed.

| Product file and hunk | Required test file, run separately |
| --- | --- |
| `src/lib/runtime/engineHost.ts`: optional management observation type on `HostState`; `src/lib/runtime/codexAppServerHost.ts`: completed MCP ingress, restoration and `currentState` | `src/lib/runtime/codexAppServerHost.test.ts` |
| `src/lib/runtime/registry.ts`: `codexHostColumns`, material-state comparison and checkpoint behavior | `src/lib/runtime/registryPersistence.test.ts` |
| `src/lib/agent/registry.ts`: `StructuredHostColumns`, normalization and `seatTickConversation` projection | `src/lib/agent/registry.test.ts`; `src/lib/agent/registry.sqlite.test.ts` |
| `src/lib/agent/sqliteRegistryStore.ts`: keyed `seatTickConversation` entry projection | `src/lib/agent/registry.sqlite.test.ts`; `src/lib/state/minimumSqlite.test.ts` if SQL changes |
| `src/lib/monitor/seatMcpHealth.ts`: combine capability and launcher evidence | `src/lib/monitor/seatMcpHealth.test.ts` |
| `src/lib/monitor/seatTickController.ts`: `mcpHealthFor`, existing incident and final admission checks | `src/lib/monitor/seatTickController.delivery.test.ts`; `src/lib/monitor/seatTickController.policy.test.ts` |
| `docs/design/mcp-stdio-survival.md`: explain the additional engine signal, health labels and supported external recovery | Document privacy/whitespace checks |

Use the designated wrapper with `bun test --timeout=60000 <one-explicit-file>` and fresh isolated roots/log/actual exit for each row. The builder first transfers the narrow baseline reproduction into the established fixtures, verifies red on the unchanged base and green on the candidate, then runs the complete touched files. The existing publication hook and CI remain authoritative; this stage authorizes no broad suite, build or standalone typecheck. Runtime/security changes require the assigned three review rounds, preserving the existing lane budget.

The host observation's producers are completed current-thread engine items and existing persisted event restoration. Its copies are `HostState`, Codex checkpoint columns, normalized registry JSON, SQLite row storage, and the keyed monitor projection. Its consumers are the health combiner and existing tick incident/admission paths. Other engines and older stored rows omit the field and retain their current behavior. Host APIs already expose `HostState`; the new field must remain safe for every existing snapshot reader. No request API accepts caller-authored health evidence. Clearing/releasing a host and moving to another generation must not transfer old success as a new generation's proof.

## Keep-list, ownership and conflicts

Keep approval policy and sandbox materialization unchanged, including socket-owner adoption; all MCP authorization, workspace/caller fences, grant resolution, server schemas and receipt retention remain unchanged. Keep pending forms, approved digests, original request keys, unknown delivery outcomes, duplicate-risk indicators, successor lineage and recovery budgets. Preserve #3725's merged startup diagnostics and #3710's unresolved original delivery. No original action is replayed by this repair.

Actual published diffs were read for the overlapping open PRs, and registered relevant worktrees were inspected for unpublished hunks:

| Adjacent work | Observed overlap and coordination |
| --- | --- |
| #3692, head `5e4e02a8` | Changes tick journal flush, sweep/curation coordination and scheduling. Its controller health/admission block is unchanged. Both extant owner/continuation worktrees matched this head with no working changes. Preserve their existing unresolved result and budget; combine controller tests before integration. |
| #3710, head `edb2bf06` | Changes MCP request recovery, caller authority, registry recovery lookup and SQLite receipt lookup. The proposed host normalization/seat projection is a distinct hunk, with shared ownership semantics. Local tree clean. Coordinate registry tests and preserve its original UNKNOWN operation; do not alter its server or receipt paths. |
| #2926, head `9ba35560` | Historical signal/process ownership diff touches Codex host creation, `currentState` and termination. The proposed state projection overlaps `currentState` conceptually. Read the actual current integration before insertion; retain all signal-domain and process-identity fields. An old open PR does not reserve the whole host file. |
| #3585, head `d58c4c0a` | Server document-send description only in the shared MCP file; server changes are outside this brief. |
| Current #3698 / #3720 work | Initial source-field plan head `5f42c2fb` was clean; the final read found new unpublished `set-src` hunks in `mcp/server.ts`, `mcp/bindings.ts`, `pipelines/engine.ts` and `mcp/pipelineSource.integration.test.ts`. The actual diff adds schema fields, caller revalidation and transactional source writes. These files remain outside this repair. The board-name design had no product working hunks. |
| Console and recent seat-context work | Inspected local heads `c5f755b0`, `a2eb535d` and `50a653af` had no uncommitted hunks in the inspected host/controller/registry-adjacent selection. Retain reconnect and context-injection behavior. |

These are captured observations, not a promise that concurrent branches will remain conflict-free. Re-read published and working hunks immediately before editing and before review. No source merge or combined-candidate test was performed in this document-only stage.

## Acceptance and external recovery

1. Recorded denial traverses actual adapter, claimed persistence, keyed registry projection and real tick. Within one ordinary decision cycle, the existing incident names engine approval denial and the affected management capability; the wake is withheld while the host remains alive. Exercise stdio and HTTP, startup grace and a previously healthy seat.
2. Real service authorization refusal remains structured, non-retryable where the server says so, and causes no binding effect. It never becomes an engine denial. Startup 503 follows launch failure. Unknown/malformed errors cannot manufacture success or erase a prior denial.
3. Same-tool permitted control calls establish recovery independently. Exercise concurrent different tools, multiple outstanding denials, repeated completion frames, old-success replay and out-of-order completion. Test 0/1/32/33 outstanding tools, 128/129-character names, oversized multibyte error/result bodies and malformed fields. The health record stays bounded and contains no synthetic private sentinel.
4. Restart/reconnect and registry reload retain current evidence. Replace the writer, generation and seat between every awaited boundary; late failures cannot poison a successor and late successes cannot clear its incident. Prove the final dispatch check matters by removing it in the scratch test and observing failure.
5. A same-key synthetic mutation and a lost-answer replay cause exactly one effect through the actual tool service. The detector itself performs zero tool mutations or retries and adopts no UNKNOWN outcome.
6. The external recovery route is the authenticated operator's existing Viewer rotation control, backed by `POST /api/orchestrator/rotate` and `executeOrchestratorSeatRequest`. It remains usable independently of the failed seat's MCP connection. The stage does not invoke it. Preserve the authority behavior covered by `src/lib/orchestrator/rotationAuthority.test.ts`.
7. The successor retains project-lineage approval forms and exact approved digests according to `docs/design/issue-report-approval.md`. Verify existing `src/lib/mcp/issueReport.test.ts` rotation cases with the injected publisher, and delivery preservation through the tick delivery fixture. Explicitly report stale-generation/duplicate-risk/verify-first outcomes; never infer nonexecution or silently republish an approved report.
8. Existing card text is the only proposed visible surface. Reuse its state/reason layout and shipped English/Ukrainian behavior. Render any changed visible wording in the existing board/conversation drivers, both themes and supported widths; no new browser driver. Report actual supported coverage before acceptance.

The historical engine configuration cause and installed behavior remain separate open acceptance items. A source pass cannot certify that read-only tools are usable in the affected installation. Later authorized acceptance must observe a permitted call under the intended identity and verify the installed revision; this stage provides neither permission nor evidence for a live canary.

## Deferred — not currently justified

Approval-policy changes, automatic seat rotation, forced release/restart, credential or capability changes, speculative fixes for deployment rollback, broader Claude recovery, a transcript-scanning monitor, new telemetry infrastructure, full registry scans, arbitrary server-refusal escalation, additional retry clocks, original-operation replay and production acceptance are deferred. The missing historical configuration and heartbeat evidence remain explicit. An ADR is unnecessary for this additive observation in the existing checkpoint path.

## Diagnostic-stage verification (historical)

At 21:07 UTC on 6 November, main remained `423bf964`; a later issue/main recheck confirmed the same revision, issue timestamp and zero comments. The assigned worktree had no changes before this document was written. Three isolated observation/control probes exited 0; the requirement probe deliberately exited 1 with `healthy` versus expected `dead`. No product-source check is represented as a fixed-head pass. The first document scan lacked the required fingerprint configuration and exited 1 with `configuration_error`; supplying the repository's committed fingerprint catalog produced PASS, exit 0. The final scan is repeated after this edit, with its log and actual exit retained in stage evidence. No bypass was used.


## Builder checkpoint: reproduced write-failure gap (historical)

The scoped implementation now carries a bounded engine observation through
Codex host state, claimed checkpoints, the keyed JSON/SQLite seat projection and
the existing tick health decision. A recorded-shape refusal opens the existing
incident and withholds a wake for either transport. Same-tool recovery needs a
start observed after the denial; unrelated success and structured server refusal
leave the denial outstanding. The implementation preserves permission policy.

An additional actual-adapter fault probe invalidates a stronger claim in the
proposed contract. After a previously healthy checkpoint, force
`AgentRegistry.setStructuredHostClaimed` to throw while a new denial arrives.
`host.health()` retains one denied tool; explicit persistence flush rejects;
the keyed registry still contains the earlier healthy observation. The health
combiner therefore returns `healthy`. Both JSON and SQLite cases fail the
required `dead` assertion, with exit 1. Restoring the writer and flushing allows
ordinary recovery. Private evidence: `$LLV_EVIDENCE_DIR/builder/checkpoint-failure-red.log`
and its adjacent actual-exit file and retained test source.

The checkpoint retry path cannot by itself establish management health while
that checkpoint is unavailable. The existing runtime `session-read` handler in
`src/runtime-host/host.ts` reads the journal projection; its current session
contract has no direct pending engine observation. Merely copying another field
into that journal would retain an analogous write-failure window.

The recommended follow-up is to authorize a bounded, current-generation runtime
observation at the existing keyed read/admission boundary, with explicit
unavailable evidence and writer/seat revalidation. Its complete producer and
consumer surface extends beyond this document's checkpoint-only file fence.
Keep this implementation as an unpublished draft until that boundary is settled
and the fault probe passes. No source completion or installed acceptance is
claimed. The three review rounds and original uncertain operations remain due.


## Authorized continuation: live owner read and final wake admission

The continuation authorizes the minimum owner read and delivery guard needed
for the reproduced checkpoint failure. The process inventory establishes that
`bindStructuredDeliveryQueue` in the Viewer holds the actual Codex adapter.
The separate runtime-host `session-read` method serves a journal projection.
A synchronous keyed read from the existing delivery controller therefore reaches
the live producer without adding a socket request, runtime-host handler or journal
copy. Permission and approval configuration remain unchanged.

| Boundary | Producer, copy and consumer |
| --- | --- |
| `engineHost.ts`, `codexAppServerHost.ts` | Optional synchronous adapter observation reads bounded owner memory; retired, unreadable or fenced adapters return unverified evidence. Other engines retain their existing behavior. |
| `agent/registry.ts`, `agent/sqliteRegistryStore.ts` | The existing keyed seat projection supplies the current native key and a fence over artifact, writer, epoch, endpoint and process identity. JSON and SQLite use the same builder. A live legacy pane retains transport-only behavior. No new schema is introduced. |
| `structuredDeliveryController.ts` | Registration captures the owner fence and carries it through controller succession. A read checks the named registration, current registry and generation before and after accessing adapter memory. Missing ownership, a read error or evidence older than a retained checkpoint is unverified. No checkpoint failure can authorize fallback to an old healthy row. |
| `structuredDeliveryQueue.ts` | The existing synchronous authorization callback receives durable message origin for individual sends, coalesced inbox members and context injection. Only automatic `seat-tick` messages acquire the additional health guard. A refusal retains the original operation in the existing queue. Operator controls retain their existing authorization path. |
| `monitor/seatTickController.ts` | The existing incident and wake guard read the owner observation. Host reachability and ordinary dead-host recovery remain separate. |
| Existing tests, `fixtures/codexCallbackProcess.ts` and the board browser driver | Adapter tests inject the real checkpoint failure for JSON and SQLite; controller tests exercise ownership, succession and final-write refusal; the board driver renders the persisted incident in both locales and themes. |

The fresh primary issue still has zero comments and its requirement timestamp is
5 November 2026 at 12:33:18 UTC. Current main was reread as `9e445fa305` before
editing; its changes do not overlap this continuation's product hunks. Adjacent
nested-read work at `24eea15541` changes `SqliteAgentRegistryStore.read()`, while
this lane retains transaction ownership in `seatTickConversation()`. The native
queue work changes event-proof restoration and settlement, and the retained
sender-notice work changes delivery progress. Their actual hunks were read;
this continuation leaves those mechanisms intact. No branches were merged,
rewritten or pushed.

The baseline checkpoint probe still returns `healthy` instead of `dead` for both
storage backends. The continuation's actual adapter/owner/tick path detects that
same pending denial while the persisted row remains healthy. Controller tests
also replace the owner, epoch, endpoint and artifact, carry a registration through
succession, refuse unreadable state, and inject denial after a send enters its
host callback. The operation keeps its key, then delivers once after an eligible
same-tool recovery. An ordinary operator control remains permitted.

All checks use isolated exports and one explicit test file per owned wrapper
command, with separate logs and actual exits. Evidence is retained under
`$LLV_EVIDENCE_DIR/continuation/`. The existing three independent review rounds
remain required. Historical configuration cause, original unknown operations
and installed acceptance remain open; source verification does not finish the
task or authorize a live canary.


### Source verification and review handoff

The final adapter file passes 318 tests, including the real service refusal and
same-key control, an owned process restart, the JSON/SQLite checkpoint fault and
independent 32/33-entry and 128/129-character bounds. Persistence passes 92 tests,
registry 147, SQLite 69, health 6, delivery controller 16, send queue 178,
context queue 25 and injection queue 15. Approval rotation and lineage pass all
10 selected cases. Each file has its own wrapper run and
actual exit. No standalone typecheck, full repository suite or production build
was run by this stage.

The complete delivery file has 64 passes and one failure; the complete policy
file has 87 passes and five failures; rotation authority has 17 passes and two
failures. All eight failures reproduce in fresh complete-file baseline runs.
The policy and rotation failures have the same diagnostics; the delivery failure
has the same diagnostic after replacing its generated fixture operation ID.
These inherited failures remain visible. The baseline checkpoint fault has two
expected failures (`healthy` instead of `dead`). Disabling the final synchronous
health guard in a separate scratch export causes both wake regressions to fail
with one write where zero is required; the unchanged candidate passes both.

Rendered coverage uses the existing kanban driver at 1280 × 700 and 390 × 844,
English and Ukrainian interfaces, both themes, and actual touch input on the
phone. The persisted incident uses the existing English diagnostic body in both
interface languages. The board preview retains its existing truncation; opening
the description exposes the full denial and recovery guidance. This is fixture
rendering evidence, with no installed or live-seat acceptance claim.

The source candidate is ready for the lane's three independent review rounds.
Publication hooks and installation verification remain subsequent boundaries;
no push, live message, provider request, seat rotation or original-operation replay
was performed. No performance improvement is claimed.

### Publication repair: authentication fixture ownership

The later publication gate exposed three new failures in
`src/lib/monitor/seatTickController.test.ts`. A complete isolated run reproduced
all three at `45e6c884d0` (103 passed, three failed); the same complete file at
the matching base `9e445fa305` passed all 106 tests. Each failure occurred after
the credential repair had correctly cleared its authentication incident: the
fixture had no registered Codex MCP owner, so the independent health guard held
the wake. Its registry wrapper also lacked the owner's object identity.

The repair changes test setup only. The fixture adopts the real Codex adapter
through the existing isolated protocol process, builds its registry columns
with `codexHostColumns`, registers it with the delivery controller and supplies
that same registry to the tick. The protocol fixture now returns the requested
thread identity on resume. Credential readers, incident recovery, policy and
production admission guards retain their existing behavior and assertions.

The complete repaired controller file passes 107 tests, including a new control:
credential repair with the MCP owner disconnected still withholds every wake;
registering that owner again permits one wake. The complete adapter file passes
318 tests, including checkpoint failure, process restart and same-key controls.
The explicitly authorized whole-project `bunx tsc --noEmit` check also passes
from a fresh tracked export with the repaired fixture files.
Each file ran separately through the designated gate with fresh logs and actual
exit codes. Evidence is retained under `$LLV_EVIDENCE_DIR/auth-repair/`.
An initial scratch-root run produced additional child-process ownership warnings;
it is retained separately. The comparable runs use the project's
`createGateSandbox()` and `isolatedEnvironment()` for their private state roots.

The latest main advance contains only an unrelated research document. Published
adjacent tick and idle-delivery changes do not edit these two fixture files;
the only observed working-file overlap is whole-file deletion in a closed lane,
which remains untouched. The earlier gate's 40 pre-existing failures and one
flaky result remain separate notes. Three independent review rounds and
installed acceptance remain outstanding.


### Review repair: completed-call replay

An independently reproduced sequence exposed a recovery error: denial, a
successful same-tool call, another denial, then replay of that successful call's
start and completion. The replay received a new event sequence and cleared the
later denial. The real JSON and SQLite owner/tick paths consequently admitted a
wake.

The adapter now retains up to 32 terminal turn/item identities, including calls
completed before any denial. Replayed identities cannot establish recovery.
Restoration rebuilds that bound from the existing journal and fences predecessor
starts. Eviction, missing identities or incomplete event history prevent later
recovery correlation; the observation retains its denial and becomes unverified.
This conservative overflow requires independently established successor recovery.
It adds no journal schema, permission change or effect replay.

The regression fixture covers the actual claimed persistence, live owner and tick
for both stores, before and after restoration, with a fresh same-tool call as the
positive wake control. Process fixtures also exercise retained terminal identity
and overflow after killing and replacing the fixture process. The existing
32/33 denial/start and tool-length controls remain in place. Publication and
installation acceptance remain separate, and no performance gain is claimed.

### Review repair: pending-call correlation

Two further sequences exposed gaps in the terminal-call fence. A call started
before adapter restoration lost its first denial because restoration treated
its start as a completion. A call started while healthy could acquire a later
start sequence through replay and clear a newer same-tool denial.

The adapter now remembers each first start while healthy, with the existing
32-entry bound. Repeated starts retain their original ordering. Restored pending
starts carry no recovery sequence; their first completion can record a denial,
and their success cannot prove recovery. Only completed identities enter the
terminal fence. Missing or conflicting identities and overflow retain the
existing conservative recovery behavior. The event journal and observation
schema are unchanged.

The regression cases traverse the actual adapter, claimed JSON/SQLite
checkpoint, reopened registry reader, live owner and tick. Both defect cases
fail on the previous source. New distinct calls clear only their own tool, and
the tick resumes after all denials clear. Separate process fixtures kill and
replace the adapter process with a pending call and with 32/33 pending starts.
The complete adapter file passes 339 tests, including the existing completed
replay, history-gap, permission, checkpoint-failure and same-key controls.
Historical cause, prior UNKNOWN operations and installed acceptance remain open.
