Originating requirement: an explicit operator request dated 2026-11-08, supplied
in this lane's pinned specification. The private quotation is withheld under
the publication fence. Its permitted public statement is: one supported MCP
invocation from a currently authorized orchestrator prepares or reuses a local
project, obtains its orchestrator and carries an initial task into work.

# Start a project through one MCP call

## Caller procedure and selected scope

Call `start_project` once with explicit new-project or existing-project intent,
the initial task and the operator request being acted on. Keep its
`clientRequestId`. The server returns a durable operation identity and the
effects it has actually observed. Work can continue asynchronously. Repeat the
identical call with that key to inspect recovery; `recoveryOnly: true` prevents
fresh admission when no claim exists. A timeout requires this lookup.

For a new project, use name allocation under the current default parent, an
explicit missing directory, or an explicitly reused directory. For an existing
project, supply its full canonical project key. An unknown existing project
refuses; it never becomes a new folder. Creating an unrelated lookalike project
requires an explicit new-project request and a noncolliding target.

Add one tool and one cohesive server helper, proposed as
`src/lib/projects/start.ts`. Execute the helper in the serving Viewer's MCP
binding. Ordinary stdio already forwards to this service. There is no additional
HTTP setup endpoint, terminal instruction, client-side sequence, generic job
engine or project template system. Existing browser and voice contracts retain
their own admission rules.

The helper composes existing folder creation, repository preparation, canonical
succession, task creation, seat designation and relay consumers. It creates one
initial task through the existing task writer and sends its identity and brief
to the destination seat. The destination owns subsequent planning and pipeline
creation. This narrow MCP bootstrap transaction is authorized by this request;
it makes no change to the earlier voice research's task-creation decision.

New seats use spawn mode with the current standard mandate and role/account
policy. They start with empty context. An existing verified active seat is
reused. Pending unrelated designations are reported as busy. Adoption, fork,
replacement, rotation and settings changes are absent from this contract.

## Observation and provenance

Source baseline: `66f9cc54e74b060775f1afc8c26a2300ff7ceba4`, observed
2026-11-08. These are source observations and proposed changes; they establish
neither installed behavior nor completed implementation acceptance.

| Existing component | Observed consumer and limitation |
| --- | --- |
| Name-only creation, delivered by #3566 | `src/lib/projects/createByName.ts:60` uses the existing name normalizer, default parent, bounded target, repository-parent refusal, exclusive mkdir and curation writer. It can allocate suffixes through 99. It has no durable operation key. The new tool must reserve one exact candidate and refuse collisions; ordinary browser suffix behavior remains. |
| Explicit directory registration | `src/lib/projects/curation.ts:101` resolves bounded real paths, optionally creates missing directories, derives the existing identity and serializes `manual:` rows. `src/app/api/projects/create/route.ts` additionally checks operator authority, workspace access and member restrictions. Calling the lower helper alone would omit these checks. |
| Safe local Git, delivered by #2962 | `src/lib/pipelines/initializeRepository.ts:228` performs read-only repository preflight, then safely prepares a local main baseline for a definite `not_git`. It stages in a sibling, excludes private/bulk/linked/nested-repository content, preserves existing ignore rules and installs prepared Git metadata. Existing repositories take its preflight branch. It has filesystem race guards, but lacks an originating-seat guard and a durable checkpoint for each ignore append. |
| Initialization evidence | `readRepositoryInitialization` at `initializeRepository.ts:214` reads `.git/delegatus-initialization.json`. A valid marker records a prepared baseline, rather than proving ownership by a particular new MCP operation. The helper also invalidates scanner cache, records succession and appends a bridge report. |
| Canonical identity | `src/lib/projects/succession.ts:84,107` validates path-derived succession and reuses the shared alias/board migration machinery. Board movement precedes alias persistence; an interrupted sequence must be reconciled from both stores. No new project-key algorithm is needed. |
| Seat lifecycle | `src/lib/orchestrator/seatCommand.ts:1048` enters pending intent, spawn/mandate delivery, activation and launch reconciliation. `seats.ts` retains epoch, original key, trigger and history. Unrelated incumbents refuse. `postSpawnInProcess` uses the shared spawn command; the supported server caller must establish authority before reaching it. |
| Attributed handover, delivered by #3709 | `sendMessageToOrchestrator` in `src/lib/mcp/bindings.ts:5911`, the orchestrator message route, `relay.ts` and `nativeRelayHandoff.ts` bind the sender and original recipient. Ordinary seats can relay to existing seats. The missing-seat branch encounters the operator-only seat route. A queued acceptance leaves arrival unconfirmed. |
| Task writes | `src/lib/mcp/bindings.ts:2282` uses `createTask` plus `mutateTasksFile`, with current workspace, actor, due-date and board constraints. `tasks/commands.ts:46,405` retains only 100 recent create receipts. That bounded history alone cannot provide indefinite bootstrap deduplication. |
| MCP custody | `src/lib/mcp/server.ts:672` onwards binds caller, target, digest and downstream key; receipt stores have claim/dispatch/fence/settle CAS transitions. `viewerMcpRecoverableTools` recovers downstream evidence without dispatch. Missing downstream rows yield unknown. |
| Transport and availability | `createProductionViewerMcpService` in `src/lib/mcp/server.ts:5264` forwards ordinary stdio to the Viewer; the HTTP service applies workspace fencing. Tool availability under `toolAllowlist.ts` does not grant execution authority. `workspaceFence.ts` has a closed project-tool vocabulary. |

The current session's actual tool catalog exposes `create_orchestrator`,
`send_message_to_orchestrator` and `create_pipeline`; it exposes no
`start_project` or combined folder/Git/seat/start method. Existing source tests
were inspected, including their production builders, request envelopes and
refusal expectations. No behavioral test or live setup call was run for this
design stage.

Prior-work searches used project-scoped and unscoped transcript/memory queries
with several phrasings. Relevant transcript hits were opened. Completed
component task records were read in full. Their shipment notes are historical
evidence, not a combined-serving proof. The earlier voice artifact was recovered
from `origin/pipeline/voice-delegatus-across-projects-create-a-95ec39f5` at
`a9ea6d5aca4673fbaa3c4fe539316af413863f5a`; its complete design and later saved
decision relay were read. That research selected confirmed voice bootstrap plus
relay, a chosen default parent, a standard mandate plus objective, and creation
for active members subject to that flow's admission. Its research/publication
acceptance remains separate. This explicit MCP request adds executable local
Git preparation and a current-seat server entrypoint. It introduces no voice
confirmation, backend parity or UI campaign.

## Exact input contract

Proposed tool name: `start_project`. All objects reject unknown fields.

```ts
type StartProject = {
  clientRequestId: string;
  recoveryOnly?: boolean;
  operatorRequest: string;
  target:
    | { kind: "existing_project"; project: string }
    | {
        kind: "new_project";
        name: string;
        folder:
          | { mode: "by_name" }
          | { mode: "create"; root: string }
          | { mode: "reuse"; root: string };
      };
  workspaceId?: string;
  task: { text: string; details?: string; dueAt: string; dueTz?: string };
};
```

Use the existing stable-key validator and transport input limits.
`operatorRequest` is nonempty, at most the existing task-text limit. It records
intent and attribution; its presence proves no privilege. The server alone
determines whether the current caller is entitled to act on it. No actor,
capability, account, role, spend, engine, model, tier, limit, environment,
remote-machine, shell, Git argument or replacement option is accepted.

`name` uses the delivered name validation: 1–80 characters after normalization.
`root` uses the existing absolute-directory bound, with the route's 4096-character
input ceiling. `by_name` freezes the current `defaultProjectsParent()` and the
delivered `folderName` result. It creates no settings preference. A collision
refuses before mkdir; it never silently takes a suffix or joins an old alias.
`create` requires an absent target; `reuse` requires a present directory and
explicit authorization to register/import it. Existing registered identities
require `existing_project`. Name or root conflicts return safe typed reasons.

`existing_project.project` is a full canonical key from existing project reads.
Aliases may resolve only with verified identity succession; no display-name
guessing or fuzzy target selection occurs. The root comes from that project's
verified local directory, and must agree with the project and current grant.
An unavailable or ambiguous directory refuses without choosing another clone.

In member scope, omitted workspace means the verified caller's current
workspace. A supplied workspace must be that same authorized workspace. Keep
the current creation route's member restriction to name-only allocation;
explicit roots remain unavailable to ordinary members. Existing targets need
current workspace access. Solo operation has no workspace to invent. An owner
still passes the existing root and workspace checks. Team-store failure never
falls back to solo authority.

`task.text` and `details` retain current 6000/20000-character bounds and task
validation. `dueAt` is required, using existing due-date/time-zone validation;
this entrypoint does not discard the current task gate or invent a deadline.
The calling orchestrator supplies normal task metadata in the same invocation.
Store the normalized values once. Preflight the exact standard mandate with the
live role table and the task relay's structured-byte envelope before effects.
The operator request is retained privately; a bounded instruction can reference
the durable task's full details instead of copying them into every message.

Example of one invocation, with neutral illustrative values:

```json
{
  "clientRequestId": "example-project-start-01",
  "operatorRequest": "Start a new local project and begin its initial task.",
  "target": {
    "kind": "new_project",
    "name": "Sample workspace",
    "folder": { "mode": "by_name" }
  },
  "task": {
    "text": "Prepare the first implementation plan",
    "details": "Inspect the project and begin the requested work through its orchestrator.",
    "dueAt": "2030-01-15T12:00:00Z"
  }
}
```

An existing target replaces only `target` with the `existing_project` variant
and its full returned project key. Replay keeps every semantic input identical;
`recoveryOnly` is transport control excluded from the semantic digest.

## Producer, consumer, authority and custody map

| Boundary | Producer → real consumer | Required current authority and retained custody |
| --- | --- | --- |
| Tool admission | SDK/stdio/HTTP declaration → `createMcpToolService` → the new Viewer binding | Verified native/capability caller must be the original currently designated primary seat. Refuse worker, pipeline stage, deputy, owner-relay-only, gateway-only, unidentified, retired, revoked or conflicting callers for this tool. Existing tools keep their policies. Bind conversation, source project, seat epoch, native generation/claim identity and workspace principal before receipt access. |
| Creation permission | Binding → `projects/start.ts` → delivered folder/curation consumers | Reuse the human route's creation restrictions through a narrow server admission function. Its additional branch admits this verified current seat for this exact operation and explicit request. Do not relax `requireOperatorAuthority`, omit agent headers to impersonate a browser, or grant general designation authority. |
| Directory and import | Frozen target plan → `createProjectByName`/`createManualProject` and `preparePipelineRepository` | Synchronous current-operation assertion at each filesystem write/rename and Git child launch, as well as after awaits. Compare original caller, grant, selected root/parent identities and release/custody generation. Lexical and resolved bounds both hold. No privileged shell in the calling agent. |
| Registration and placement | Existing curation writer → workspace placement → succession/aliases/board writer | Check current membership immediately before persistence and placement, then verify the actual canonical target and destination grant. Directory-to-repository succession is allowed only for the originally proved folder. A newly conflicting alias, remote or placement refuses further work. |
| Initial task | Frozen task input and reserved task id → `createTask` within `mutateTasksFile` | Carry the original agent actor and explicit operator-request evidence. Apply normal due/board/hold/workspace rules. The task is on the target project; it is distinct from seat-notes tasks. Recheck at the transaction's final persist. |
| Fresh seat | Frozen standard mandate and seat subkey → `executeOrchestratorSeatRequest` → production spawn command | Supply a trusted admission assertion and an agent `OrchestratorSeatTrigger` naming the original seat/epoch. Use spawn mode, explicit target cwd and current role defaults. Persist the operation reference in the existing intent/launch custody so restart can reconstruct the same guard. Account selection remains the normal policy's decision. |
| Native launch and first mandate | Existing spawn receipt → structured-host launch and first-message consumer | Reconstruct operation authority from durable links before recovery; compare original caller/grant and the current target/launch/generation immediately before native exec and first enqueue/send. Missing links never classify this as an ordinary unguarded launch. Apply equivalent checks to every supported fallback. |
| Task relay | Frozen recipient/epoch and sender envelope → existing orchestrator relay route → shared delivery command | Reuse the native handoff and send-receipt path, retaining agent authorship. Revalidate the original caller, destination owner/generation and delivery permission at admission and actual delivery, including delayed queue drain/recovery. An invocation-local callback alone cannot authorize a send after restart. |
| First work | Destination receives the existing task id → its ordinary task/pipeline/spawn consumers | The destination reads and works on that task. It uses normal source lineage, task membership, account and launch limits. No automatic pipeline graph or caller-selected worker profile is introduced. |
| Status/replay | Original receipt/binding → read-only recoverable-tool reader | Authenticate before lookup, join, disclosure and result projection. Inspect only the recorded target and subkeys. Existing task/pipeline reads supply subsequent work evidence; recovery never invokes a mutation binding. |

The synchronous assertion is produced by trusted server code, not deserialized
from arguments. It includes original source seat and epoch, native generation
and claim owner, workspace principal and its current grants, operation digest
and owner generation, exact target directory identity and canonical project,
and, once selected, target seat and launch/delivery identities. Release ownership
is checked separately from caller authority. Capture original facts once;
freshly reread their owners after awaits. A changed owner never authorizes a
replacement destination automatically.

Persist only noncredential identity references needed to reconstruct this
assertion. Never persist a native hook proof, browser cookie, provider token or
an internal-service bearer as durable authority. If current native ownership
cannot be established after restart, retain partial/unknown and start no next
effect. Status access itself continues to require current authorization.

Retain the seat consumer's existing cascades: registry role/membership and
lineage stamping, materialization reconciliation, seat-notes tasks and the
normal board-report machinery. Their automatic policy remains in force. Forward
the operation reference and current-authority guard through any cascade that
can admit work; no reuse wrapper may silently omit a production dependency or
change an existing report, account or scheduling default.

## Durable state and forward execution

Extend the existing MCP receipt with an optional, versioned `projectStart`
checkpoint for this tool. Keep one operation in that receipt; reuse its caller,
digest, claim owner/generation and CAS transitions. Add a specifically typed
checkpoint operation to the existing SQLite/file/memory adapters and their
validators. The SQLite production adapter stays authoritative. Stores without
this facility refuse fresh project starts before effects. No second database,
generic step registry, arbitrary payload runner or workflow language is needed.

The private checkpoint contains the frozen target plan and defaults, original
authority references, task id, exact subkeys, phase and per-effect disposition,
directory ownership evidence, prepared-Git manifest reference, observed project,
seat/launch/message identities and a bounded typed cause. File content stays in
the initializer's owned preparation directory, subject to its existing bounds.
The checkpoint holds hashes, sizes and identities rather than copying project
contents into MCP storage.

Derive an opaque operation id from the server's receipt scope and original key.
Allocate distinct folder, seat, task and first-message subkeys once and store
their exact values before dispatch. Scope them to installation, original caller
and operation. Server-reserve the task id before its writer runs. Immutable
request identity includes target intent, operator request, normalized task and
explicit workspace; retries do not recalculate root/profile defaults. A changed
payload under the same key returns `idempotency_conflict` before effects.

Before each consumer, CAS that effect from not-started to dispatching under the
original digest and current driver generation; reassert authority inside that
transition and immediately at effect dispatch. Persist observed outcomes under
the same generation. A late predecessor cannot advance a checkpoint. For task
creation, test the reserved id inside the task writer's transaction before
calling its existing id factory; recover an existing row and never append a
second row with that id.

Use this closed forward sequence:

1. Validate identity, explicit intent, workspace/path/name constraints, task
   shape, normal launch readiness and both message envelopes. Freeze the plan
   and accept the durable receipt before starting the operation's driver.
2. Prepare/reuse the exact folder, register it and place it within the authorized
   workspace using existing writers. Save and verify actual outcomes.
3. Prepare or verify its safe local repository, then reconcile the original
   directory project's canonical succession and placement. Verify every later
   identity against this result.
4. Write the reserved initial task through the normal task command. Keep its
   original status/hold policy. Do not make an Inbox task tick-eligible as a
   hidden substitute for delivering the brief.
5. Reuse a verified active destination seat, or create a fresh empty-context
   seat under the stored seat key. Save recipient and epoch before any task
   send. Await evidence of usable launch and mandate arrival through the
   existing lifecycle, without blocking the MCP request.
6. Deliver one attributed brief referencing the already-created task under the
   stored message key. It instructs the seat to work on that task through its
   normal mechanisms. Confirm arrival from the destination transcript or the
   equivalent production first-message/delivery consumer.

Return accepted/in-progress as soon as durable admission is observable. One
bounded asynchronous driver per operation makes the above forward transitions;
MCP replay only reads. Integrate restart continuation into
`startCurrentReleaseControllers` under existing Viewer release ownership and
retirement. Use an indexed set of unfinished project-start receipts, bounded
pages and the existing operation-lease/owned-child mechanisms. Process one Git
import at a time and yield between operations. Do not scan all projects, seats,
tasks or receipts on each tick. Waits carry the operation and phase label and
obey the existing consumer deadlines. Exhaustion or a held launch is a persisted
waiting/partial outcome, with no repeated native launch or provider fallback.
Retirement aborts scheduling and fences late writes; a successor resumes only
proven unfinished steps with the original custody.

The forward driver may resume a never-started step or an explicitly proved
not-executed downstream admission. A dispatching step without conclusive evidence
stays unknown. It never retries merely because a response or row is missing.
Downstream effects already admitted continue only while their reconstructed
operation and destination guards still hold.

Completed operation identity and anti-duplication disposition have durable
retention, following the MCP mutation receipt's retention. If evidence is later
unavailable/expired, answer history-expired/unknown and prohibit replayed
effects. The 100-entry task-create cache is supplementary: recover by reserved
task id and original create evidence. An evicted receipt, deleted task or
tombstone cannot cause a new task. A contradictory task/project refuses; a
later legitimate task edit is preserved.

## Safe repository preparation

Pass the initializer the same explicit target directory that was admitted;
never substitute a repository ancestor. Only a definite `not_git` may initialize.
An existing safe repository keeps its HEAD, history, index, configuration,
remotes, hooks, working files and ignore bytes. An unborn/bare/corrupt or otherwise
unusable repository returns the existing preflight reason. There is no reset,
checkout, remote creation, fetch, GitHub call or publication in this operation.

Keep `safeRoot`, ancestor discovery with sanitized Git environment, stable root
descriptor/identity checks, no-follow file reads, bounds, ignore evaluation,
secret screening, no-filter object hashing and the controller commit identity.
Do not disable the agent Git guard. The new tool calls the supported server
consumer; it never instructs the agent to clear its environment or run `git init`.

The new operation must extend the initializer's existing prepared-baseline
marker/transaction with a narrow trusted checkpoint and synchronous assertion.
Before target ignore writes, retain the prepared repository plus a manifest of
original root/file identities, original lengths/hashes, exact intended suffixes,
prepared commit and operation reference. Before each append or install, assert
authority and compare the original identity. Record and recover each applied
suffix by original-prefix hash plus exact suffix; append it at most once.
After `.git` installation verify the marker, expected commit and actual root.
Do not use an unrelated/copied initialization marker as operation ownership.

The current initializer's `finally` removes its preparation directory. For an
operation whose target writes may have begun, preserve that owned preparation
and manifest until reconciliation; deleting it would destroy recovery evidence.
Clean only positively owned, no-longer-needed preparation files after a proved
terminal disposition. Foreign directories and the target's data remain intact.
Unknown custody retains evidence. No destructive compensation is added.

Name allocation similarly needs durable ownership evidence across mkdir and
curation. Freeze the selected path before creation, use the existing exclusive
creation mechanism, and persist an operation marker in the already-excluded
`.delegatus-initialization*` namespace plus observed directory identity before
claiming ownership. Recovery recognizes that exact marker and
identity. A crash before ownership evidence exists leaves an ambiguous existing
folder: return unknown and stop; do not adopt it, remove it or choose another
suffix. This is an explicit conservative recovery outcome, rather than an
exactly-once filesystem transaction claim.

## Partial-effect recovery matrix

Every row uses the original operation, frozen target and stored subkey. Before
continuation, the current-owner and current-grant assertion runs again.

| Last possible effect / lost answer | Required observation | Original-key result and allowed continuation |
| --- | --- | --- |
| MCP claim, before driver acceptance | Receipt digest, original binding, claim owner/generation and dispatch phase | Same identity. A proven never-dispatched claim may be fenced by existing CAS. A missing claim after possible admission proves no absence. |
| Parent/folder created | Frozen selected path, ancestor/root identities, exclusive-create/operation marker and curation state | Recognized owned folder is reused. Existing unmarked/changed directory is unknown/conflict; no new folder, suffix or cleanup. An owned parent alone never proves child creation. |
| Curation or workspace placement | Exact manual-project row, canonical identity and current workspace placement | Reconcile only the original row and still-authorized placement. If access was revoked, retain partial and create no Git/seat/task effects. Do not turn `DUPLICATE_PROJECT` into implicit reuse. |
| Git preparation before target writes | Owned prepared repository, manifest, locks and expected commit | Resume the same preparation when custody is proven. Unreadable/missing preparation after dispatch is unknown. Existing foreign `.git` is never overwritten. |
| One or several ignore appends | Manifest original identities/lengths/hashes and exact applied suffixes | Recognize already-applied suffixes and continue only the remaining verified writes. Any contradictory prefix, suffix or identity stops with partial/unknown. No repeated append, truncate or rollback. |
| `.git` install, report or alias write | Installed marker plus expected commit/root, canonical alias, board migration, placement and initialization report key | Repair missing idempotent report/succession under current authority. Conflicting aliases refuse. No second init/commit or new project. Report failure cannot undo installed Git. |
| Initial task write | Reserved task id, original writer receipt/tombstone and target membership | Return the original task. Preserve later edits. Eviction/deletion/absent evidence after dispatch never authorizes recreation. |
| Seat intent or accepted native launch | Original seat key/epoch/trigger/history, launch receipt, registry membership and generation | Reconcile the existing intent/launch. Pending/unknown remains truthful. No second seat or agent; another operation's active/pending seat is never adopted as this operation's creation. |
| Mandate arrival or seat activation | Destination's original first-message identity and launch journal/transcript, active seat epoch | Activate/reconcile the original designation only. Acceptance without prompt arrival remains pending. Replacement/revocation stops the next task send. |
| Task brief accepted; reply lost | Frozen sender/payload, recipient/epoch, delivery reservation, durable send receipt and transcript occurrence | Resolve that exact delivery. Missing/generic replies stay unknown. Never retarget to the latest seat or send with a new key. A proved pre-admission refusal can permit the stored-key continuation only after its admission fence. |
| First work or pipeline admission | Existing task assignments and pipeline creation record with matching task id, target project, destination source and durable admission | Report the actual work identity. No matching record means work unverified/pending. No guessed pipeline and no restart/resubmission by the start operation. A lost pipeline reply is recovered through its own creation key. |
| Caller/grant/release changes at any await | Original actor, principal, target and custody references versus current authoritative stores | Refuse the next effect and preserve completed facts. Release succession may resume under verified custody; changing the caller, seat or authority cannot create a new grant. |

If an uncertain operation cannot progress safely, expose the phase and useful
typed reason with `nextAction: "original-key-lookup"` or `manual-check` as
appropriate. A terminal refusal after partial effects names those effects. It
never reports the whole operation as not-executed. Only a positive no-effect
admission fence can support that statement.

## Result and error contract

Keep the normal MCP envelope, including `toolName`, `clientRequestId`, `ok`,
`replayed` and typed failure details. Successful durable acceptance carries:

```ts
{
  operationId: string;
  accepted: true;
  state: "accepted" | "in-progress" | "started" | "partial" | "unknown";
  phase: "admission" | "folder" | "registration" | "repository" | "identity"
       | "task" | "seat" | "mandate" | "delivery" | "work" | "settled";
  project: string | null;
  taskId: string | null;
  seat: { conversationId: string; seatEpoch: number; reused: boolean } | null;
  launchId: string | null;
  messageOperationId: string | null;
  arrival: "pending" | "confirmed" | "unknown";
  work: { state: "pending" | "admitted" | "unknown";
          pipelineIds: string[]; launchIds: string[] };
  effects: Record<"folder" | "repository" | "registration" | "task" | "seat"
                  | "delivery", EffectDisposition>;
}
```

`EffectDisposition` is the closed union `not-started`, `dispatching`, `observed`,
`reused`, `refused`, `unknown`. Read-only original-key recovery returns the same
operation identity with evidence-based progress using the existing recovery
outcome/next-action vocabulary. Initial acceptance is never described as task
delivery or work admission. `started` requires confirmed brief arrival plus a
real destination-owned work admission; it makes no claim that the task is done.
When a task requires clarification or a hold, report that state without
inventing a pipeline.

Preserve existing typed codes such as `workspace_forbidden`, `INVALID_NAME`,
`OUTSIDE_ROOTS`, `DUPLICATE_NAME`, `DUPLICATE_PROJECT`, `initialization_refused`,
`already_designated`, task validation and launch-hold reasons. New
operation-specific conflicts distinguish target-changed, authority-changed and
partial/unknown custody. Preserve safe `code`, `field`, `status`, `retryable`,
phase, evidence and next action through the MCP service. Generic `tool_failed`
or a timeout cannot erase an admitted effect or permit a new-key retry.

Use an allowlisted response projection before truncation/compaction. Expose safe
display labels, canonical opaque ids, counts and typed reasons. Do not spread
initializer reports, task details, raw filesystem exceptions, roots, private
filenames, transcript paths, account/member identities or the operator request
into public responses/examples. Existing private full reports retain their
current audience; creation must not widen it through artifact roots, shared
workspaces, search, receipt reads or exports. In particular the member route's
explicit-root restriction remains essential because registered roots become
artifact read roots.

## Shared paths and implementation overlap

Additive tool/schema/description/recoverable registration lives in
`mcp/server.ts` and `mcp/bindings.ts`; execution belongs in the new cohesive
helper. Add only the typed receipt checkpoint/accessor needed by this operation,
its workspace-fence branch, the creation/initializer trusted callback options,
the existing task-writer reserved-id seam and seat/spawn admission propagation.
All old producers continue without those optional operation fields. Copies and
normalizers of receipt/intent/launch/delivery records must retain the reference;
missing reference alongside recorded operation evidence refuses recovery.
File/memory/SQLite adapters, legacy receipt import, stdio/HTTP forwarding,
result compaction and docs/examples must agree. Register `start_project` in the
tool-name, mutating, interrupted-recoverable and recoverable-binding tables so
the ordinary orphaned local-dispatch path cannot misclassify it. Keep receipt
SQL compatible with SQLite 3.39. Neither a missing optional field
on an ordinary old launch nor an operation-linked missing field may silently
change the other case's meaning.

The overlapping active decision-recovery line was inspected at its published
reviewed head `15622ea573e71fc19a1660ca1f64f4268c09479f`, including its actual
published changes, and then at fix head
`585d9c7af5f78b253b95d2617dfc20d77031d698`. The latter committed the five-file
diff first observed unpublished. It changes the two typed-refusal catches in
`mcp/server.ts`, `capturePipelineDecisionLaunch` in `pipelines/engine.ts`,
`decisionLaunchAuthorityForReceipt` in `runtime/structuredSpawn.ts`, and their
decision/native tests. Its surrounding published changes also add synchronous
`StructuredSpawnInput.assertCurrent`, native final checks, first-delivery
guards and guarded receipt completion/release.

Final remote-ref observation still matched baseline main and published
`15622ea5`; the fix checkout was clean at `585d9c7a`, with its publication
reported in progress. Its producer's pass does not establish independent
acceptance of this dependency.

Those exact hunks are fenced. This lane must neither edit them nor copy the
decision mechanism into project bootstrap. There is a real dependency: a
project-start launch needs that final native assertion and a durable,
operation-specific reconstruction at fresh/recovered launch and first send.
The decision-specific recovery resolver cannot supply project-start authority.
Implement the reconstruction in the new helper and connect it only through a
disjoint consumer seam after the overlapping native contract is accepted and
available on this lane's base. If the final consumer has no disjoint seam,
preserve this artifact and report that exact native hook integration as blocked
before dependent code. A pre-launch account check or in-memory closure is
insufficient. Apply the same rule to delayed delivery guards.

Tool catalog, schema, new binding and receipt fields are disjoint additions;
do not change the active line's decision branches, receipt-complete/release
bodies, typed catches or decision/native test cases. Final implementation review
must re-read the then-current published and unpublished diff. No inferred
success for that line, its unknown custody or any held neighboring task is
included in this design.

## Exact existing verification files

Extend existing fixtures and production consumers. Create no parallel capture
driver and no test that matches instruction/prompt wording. These are future
behavioral checks, not runs claimed by this design stage.

| Existing complete test file | Required cases |
| --- | --- |
| `src/lib/mcp/orchestratorTools.test.ts` | Main one-call integration: production binding/service and real folder, Git, task, seat and delivery consumers; production registry/role/task builders. New empty/plain folder and existing safe repo/seat; all identities agree; exactly one task/seat/agent/delivery; destination arrival and destination-owned first-work admission. Stub only the external engine boundary with captured production envelopes. |
| `src/lib/mcp/schemaParity.test.ts` | Real SDK tools/list and tools/call expose the exact discriminated input, reject contradictory/extra privilege fields, and retain typed accepted/partial/refused results. |
| `src/lib/mcp/stdio.integration.test.ts` | Packaged stdio → real isolated Viewer MCP service uses one call and forwards the entire native envelope/key. Reconnect/lost response preserves operation identity and arrival proof. |
| `src/lib/mcp/workspaceFence.test.ts` | Owner/member/solo controls, inaccessible workspace, revoked membership, replacement after each awaited boundary, new-project placement and final result scope. Zero prohibited effects and live-grant positive controls. |
| `src/lib/projects/createByName.test.ts` | Frozen name allocation, collision refusal for the new contract, inherited ordinary creation behavior, concurrent keys, mkdir/registration crash windows and original-key ownership recognition. |
| `src/lib/projects/curation.test.ts` | Explicit create/reuse distinction, bounds, aliases, symlink/traversal/collision threats, failed placement and registration recovery. Preserve foreign files. |
| `src/lib/pipelines/repositoryInitialization.test.ts` | Real initializer and Git processes: existing index/history/config/ignore unchanged; plain import excludes private/bulk/nested/linked data. Fault/lost-answer controls before/after every ignore append, Git install, marker/report and authority boundary. Exact original bytes/commit counts and no duplicate append/init. |
| `src/lib/projects/succession.test.ts` | Directory → local-repo identity agrees across curation, workspace, seat, task and scanner. Crash between board and alias writes; contradictory aliases and repo roots refuse. |
| `src/lib/tasks/tasks.test.ts` | Reserved task id through the existing command, due/board gates, lost create reply, 100-receipt eviction, legitimate later edits and deleted/tombstoned task. No recreation. |
| `src/lib/orchestrator/seatCommand.test.ts` | Fresh empty spawn with current default mandate/profile and actor; existing seat reuse; unrelated pending/incumbent refusal; key replay, accepted launch and missing mandate evidence. |
| `src/lib/mcp/server.test.ts` | Typed checkpoint round-trip/CAS in all existing receipt adapters, contradictory digest, competing owner, late completion, missing operation link, non-capable store refusal and typed partial failures. |
| `src/lib/mcp/receiptsStartup.test.ts` | Real startup and legacy receipt import preserve checkpoint version/custody; MCP processes cannot migrate live stores or reinterpret a missing checkpoint as fresh admission. |
| `src/lib/mcp/interruptedCall.test.ts` | Original-key recovery remains read-only and never redispatches after uncertainty, including absent downstream records. |
| `src/lib/mcp/originalKeySendRecovery.test.ts` | Actual relay/send normalization and original sender/recipient recovery; accepted without arrival, reply-only loss after delivery, rotation/replacement, queued drain and no second message. |
| `src/lib/orchestrator/nativeRelayHandoff.test.ts` | Exact-envelope and native-owner guard, expiry, changed caller, copied request, replay and positive controls; preserve the delivered relay contract. |
| `src/lib/viewerInstrumentation.test.ts` | Serving-release restart resumes only indexed eligible operations; demotion/deadline quiesces its own driver and refuses late effects. |

Native final acceptance also requires the existing complete
`src/lib/runtime/structuredSpawn.integration.test.ts` and
`src/lib/runtime/agentSignalSandbox.native.test.ts` with operation-linked
fresh/recovery/fallback cases and actual zero-exec/zero-send markers after owner
or grant replacement. Those cases are added only after the fenced dependency
has a disjoint accepted seam. Exercise both supported orchestrator engines,
grant-positive controls, missing target/link and release succession. Removing
the final operation guard must make the negative controls fail.

For pipeline admission evidence, reuse `buildPipeline` and the real engine
consumers already used in `repositoryInitialization.test.ts`; record the actual
creation key, source seat, task id and admission result. No test fixture may
return an invented success object in place of the destination consumer.

Each selected complete file runs in its own owned direct-gate command from an
export, with fixed isolated HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR,
closed `LLV_VIEWER_CONTROL_URL`, cleared inherited fixture Git overrides and
isolated account roots. Use `bun run test <file>` through the controller's
declared installed `gate-slot.sh`, one owned file per command. Retain full logs,
actual exits and final state in `LLV_EVIDENCE_DIR`; compare only actual failures
with the same base conditions. Do not use recorded-check adoption, broad suites,
manual whole-project typecheck/build or manual push.

## Review, acceptance and deferred scope

Implementation has exactly three independent review/fix rounds with the native
final recheck. Keep the original budget and lane; exhaustion never creates a
successor budget. Controller publication, normal hooks, privacy, required checks
and merge bar follow those reviews. Installed acceptance remains separate and
`finishesTask=false`. Release/rollout hold remains. This stage authorizes no
deploy, actual project/seat creation, external publication, account or settings
change.

Design validation covers one invocation through asynchronous work admission,
explicit target intent, current-owner and workspace checks, safe local import,
existing-seat reuse/fresh creation, every partial-effect boundary, original-key
recovery, truthful unknowns and real transport/destination evidence. No product
performance gain or atomic filesystem/database transaction is claimed.

This design stage changed only this declared document. Reference-path and
whitespace checks passed; the project's explicit-path publication privacy check
with committed known-value fingerprints passed. Behavioral tests, setup calls,
builds, typechecks, commits and production actions were not performed. The
private verification log and actual privacy exit are retained in the stage's
evidence directory.

## Deferred — not currently justified

Voice tools, confirmations, UI, backend parity and changes to old research
acceptance; fuzzy project search or list redesign; custom mandate/objective
lifecycle; templates or generated project instructions; dependency installation;
remote machines/SSH, hardware and serial devices; automatic GitHub creation,
remotes/publication or deployment; account/role/spend/credit/limit settings;
adoption/fork/rotation/replacement of existing sessions; automatic destructive
rollback; a generic workflow engine; independent new pipeline graphs generated
by the bootstrap tool. The destination orchestrator uses the existing product
for work after its task arrives.
