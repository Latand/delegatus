# Codex Cloud stage runtime

A pipeline run stage selects `runtime: "local"` or `runtime: "codex-cloud"`.
Cloud supports Codex reviewer, verifier and writable builder stages, including
builders reached by a fail edge. Worktree output declarations remain local.
An explicit Cloud stage names its model; a stage inheriting Cloud from the
project binds the resolved role model into its definition.

The project setting `pipelineStageRuntime` defaults to `local`. Creation freezes
the default into new Cloud definitions. `create_pipeline` and `override-stage`
accept the runtime field; the voice gateway uses those same MCP schemas. An
override affects the next attempt; an active attempt keeps its bound definition.
Changing an active attempt between local and Cloud requires a new attempt.

`codexCloudEnvironmentId` selects the project's environment and defaults to an
empty string. An empty environment makes a new Cloud attempt fall back locally.
Changing or clearing the environment during a Cloud attempt withdraws that
attempt's authority. `GET /api/projects/settings` reads both settings. The
same-origin, operator-authorized `PUT` sets them. Other setting writers and
canonical project aliases preserve both fields.

Example stage definition:

```json
{
  "id": "review",
  "kind": "run",
  "runtime": "codex-cloud",
  "role": { "roleId": "reviewer" },
  "engine": "codex",
  "model": "gpt-6.1-sol",
  "effort": "xhigh",
  "prompt": "Review the changes against the pinned specification.",
  "next": null
}
```

## Transport boundary

`src/lib/pipelines/cloudStage.ts` defines `CloudStageClient`, supplied through
`PipelinePorts.cloudClient` in `src/lib/pipelines/engine.ts`. The default is the
hosted transport in `src/lib/pipelines/cloudHostedClient.ts`. A missing transport
gets bounded retries and local fallback. A transport whose
`supportsModel(model, reasoningEffort)` cannot honour the explicit configuration
refuses execution. Legacy cloud execution has no adapter here. The transport supports
GPT-6.1 Sol, including an explicit reasoning effort. The project setting keeps
all remote work disabled until an operator supplies an ASB configuration ID.

Hosted service-tier fidelity is unverified. An explicit tier,
including `default`, is refused at execution before submission. Saved stage
definitions remain readable. The adapter also refuses direct submissions carrying a tier
before authentication. An inherited role tier remains a preference: cloud runs
use the provider default and record `preferredServiceTier` with no applied
`serviceTier`, using the existing visible fallback label. Local tier handling
is unchanged.

Failed-turn diagnostics retain a bounded, credential-redacted message and
recognized error cause name. Raw provider bodies, headers and additional error
fields are discarded; unknown shapes use the generic cloud failure. Redaction
precedes truncation, and the engine persists this sanitized diagnostic through
the existing failure path.

The interface isolates these operations from pipeline orchestration:

- Submit the environment, published branch, role scaffold and prompt, explicit
  model and reasoning effort through the selected account's ChatGPT authentication.
- Return an opaque task ID and task URL. The hosted adapter uses the current
  app's `codex://threads/<thread>?hostId=durable` link; it selects the cloud host
  explicitly. The receipt validator allows only that native action, thread and
  host selector, alongside credential-free HTTPS URLs for other transports.
  A hosted adapter also returns the
  thread and turn ID pair in `thread`; it is persisted on the attempt and passed
  back to poll, final-message and diff reads after restarts. Poll pending, completed and failed
  outcomes with actionable, credential-free errors.
- Honour the server-supplied `allowProviderModelFallback: false`. Confirm the
  resolved thread model before starting the paid turn. Read the final assistant
  message and confirm the actual model. Both a reported
  poll model and the final model must match the explicit stage model.
- Export the writable stage's complete diff; read-only stages never request it.
- Honour the provided abort signal, bound response sizes, refuse untrusted
  redirects, call `assertCurrent` immediately before remote effects after any
  asynchronous preparation, and remove credentials from every response and error.
  Tokens must stay inside the transport and must never reach logs or durable state.

### Verified hosted app-server path and protocol risk

The spike used a local Codex app-server's `getAuthStatus` response directly in
memory, then read the hosted environment-config catalog. The adapter must resolve
an ASB `asenvcfg_` configuration ID; a `cecfg_` source version ID is refused by
hosted `thread/start`. The project setting supplies the selected configuration;
no account resource identifier is embedded in product source.

The hosted WebSocket uses the app-server sequence `initialize`, `initialized`,
`thread/start`, then `turn/start`. The thread request selects the explicit model,
sets `allowProviderModelFallback: false`, `serviceName: "codex_cloud"`,
`deferredEnvironment: true`, and an `environments` entry containing the resolved
`environmentConfigId` and remote `cwd`. Under the operator's permission decision,
cloud threads use `sandbox: "danger-full-access"` and turns use
`sandboxPolicy: {type: "dangerFullAccess"}`, both with `approvalPolicy: "never"`.
The reviewer/verifier role still instructs the agent to preserve the checkout.
The adapter derives that remote working
directory from the verified configuration; a local lane path cannot supply it.
Authentication, including credential-bearing handshake subprotocols, remains
inside the adapter's memory. There is no API-key fallback.

The ASB detail endpoint supplies the single repository's mount path. When that
path is empty, the adapter follows the desktop app's shared repository-catalog
lookup and derives the default workspace directory from `repository_full_name`.
An inaccessible repository or unknown name fails before a work turn starts. After
thread creation the client validates the resolved model and execution instance,
fetches the published lane branch, checks it out, and requires the resulting
commit to equal the accepted lane head before starting the work turn. Git
arguments are quoted and no branch comes from a default environment ref.
Account-wide socket messages are filtered by the returned thread and recorded
turn. Only requests for the newly launched thread can receive approval replies.
Status uses `thread/read` and bounded `thread/turns/list` pages; final output uses
`thread/items/list` and rechecks the cloud checkout's head. These reads neither
resume a thread nor change an active turn's permissions. The durable
`CloudThreadReference` carries identities across restart without credentials.
It also retains the resolved execution instance, mount and model because the
verified minimal thread metadata omits the configuration ID and later reads can
omit model metadata. Any returned model or configuration must still agree with
that launch proof; status must match the persisted execution instance and mount.

Each operation opens and closes its own socket and native auth client under a
deadline. Mutating RPCs are sent once. An unanswered launch remains ambiguous;
the pipeline refuses automatic resubmission. Diff retrieval is available behind
the interface, with 3,072-byte chunks, canonical base64, a 16 MiB bound and a
cloud-computed SHA-256 checked before returning any patch. It includes new,
unignored files with intent-to-add and reads all changes relative to the
accepted head. It launches no follow-up model turn. Writable stages leave their
changes uncommitted for the lane controller.

**Compatibility risk:** this is the desktop application's protocol, with no
verified public API stability guarantee. The implementation adapts the verified
hosted client and tests its wire contract with a fake socket. No live task is
launched by the test suite. A backend protocol change, unavailable native
`getAuthStatus`, unknown response shape, model rerouting, missing ASB mount or
loss of execution identity fails the stage. Credentials remain in memory; raw
RPC errors and auth stderr are discarded. No performance gain is claimed.

The existing account resolver enforces the project pool, capacity and explicit
account. Each candidate's authenticated catalog must contain the project's
environment. A durable cursor in project settings reserves accounts in rotation
among the eligible accounts, under the asynchronous settings file transaction.
Its bounded wait yields the Viewer loop. Fresh submissions, including recovery
accounts, always check the catalog; only an existing task receipt reuses its
admitted account without a catalog read. Reservations survive
restarts and concurrent controllers; selection scans no pipeline history. The
Cloud receipt retains its account after a fallback selects a local account.
Local account recovery cannot replace an unresolved Cloud task's account;
authority recovery reconciles the original receipt.
The runtime rechecks lane and account authority around transport calls. It binds
the stage definition at activation and includes the pinned specification,
previous output, lane branch, base and exact accepted head in the cloud prompt.
Cloud instructions replace local MCP and host mechanics and request the local
fenced JSON verdict contract.

## Shared contract paths

| Contract | Producers and copies | Consumers and defaults |
| --- | --- | --- |
| Stage runtime and explicit model | MCP stage schema and pipeline HTTP inputs; `normalizeStages`; draft copies and role overrides; activation binds runtime and effective model | Store validation, stage digest and cloud dispatch; omitted runtime inherits the project setting when a new definition is created |
| Project settings | Operator settings PUT, `setCodexCloudEnvironmentId`, `setPipelineStageRuntime`; other writers spread the entry | Canonical project reads and settings GET; absent environment is empty and absent runtime is local |
| Account rotation | `reserveCloudStageAccount` under the shared settings lock | Cloud launch after catalog admission; absent cursor selects the first eligible account |
| Cloud attempt | Scoped controller-job checkpoints, serialized by the existing pipeline store | Attempt validation, indexed controller deadlines, API record reads and existing verdict settlement; absent for local attempts and before cloud admission |

## Controller and persistence

An attempt's `cloud` field retains environment, branch, exact head, task ID and
URL, account, actual model, poll count, next due time, deadline and terminal
result/error. `executionRuntime` is `local`, `cloud` or `cloud-then-local`.
`cloud.fallback` retains its server timestamp and bounded, redacted reason.
`stageDigest.ts` includes the optional runtime; `store.ts` validates it and the
receipt. Draft copies, role overrides and bound attempt definitions retain and
validate the same stage contract. `controllerPass.ts` indexes the next poll and
deadline so waiting cloud work does not trigger a whole-store scan.

Submission and polls run in bounded controller jobs outside the lane mutation
lease. Delays grow from two seconds to thirty seconds. A persisted thirty minute
deadline spans restarts; each job additionally has a thirty second deadline.
The Viewer tick never sleeps waiting for cloud work. This change claims no
performance gain. The clean accepted head must match the published branch before
submission and completion. Internal, released or moved lanes fail. A first Cloud stage publishes the
accepted base through the existing publication journal before remote checkout.

The existing verdict parser and settlement path normalize findings and handle
pass, fail, decision requests and fail edges into local or Cloud fix stages.
Confirmed failed Cloud turns, missing environments, Cloud limits and exhausted
availability retries before execution fall back to the same stage locally once.
Transport reads retry at two and four seconds, retaining the task receipt and a
durable limit of three failures. Exhausted reads and an expired observation
budget park with the original receipt; they never authorize local execution.
A confirmed failed poll stores `failureConfirmed`; a legacy eligibility flag
without that proof cannot release a known task. An explicit retry reconciles
that receipt under a fresh observation budget,
without submitting another turn. Expiry before submission can fall back safely. The persisted
fallback marker prevents a restarted controller from resubmitting to Cloud.
Model, receipt, authority, patch and custody failures retain their refusal. Interrupted
submission with no receipt refuses automatic resubmission because its outcome is
unknown. `submissionUnresolved` preserves that custody when an interrupted
submission parks; a confirmed pre-turn refusal clears it. Legacy records with their account stored only on the attempt retain the same
custody; reconciliation copies that account into the Cloud receipt before
fallback. A receipt
resumes polling after restart. Superseded replies cannot
replace another receipt or advance a paused lane. Delivery takeover can clear the
old lane's active publication claim without advancing its old epoch; cloud jobs
also fence the owner, active flag, publication policy and disposition, and the
controller refuses later polling or settlement after that withdrawal.
Clearing or changing the project environment setting also withdraws authority
before another remote effect. A known submission receipt can still be retained
for inspection; the attempt fails instead of polling or accepting a verdict.

Writable results pass through `cloudStagePatch.ts`. It stores the patch and a
SHA-256 receipt outside the worktree and computes the expected tree in a private
index. Application first uses the local launch path's prior-writer fence,
including its bounded stop, wait and park sequence. An earlier surviving writer
keeps the patch unapplied and unaccepted. Application then requires the accepted
head and an unchanged lane index and worktree. The applying intent is persisted before `git apply --index`. After an
interruption, the exact expected index tree and matching worktree prove that the
apply landed; a partial apply or unrelated edit refuses recovery and preserves
the files. The normal stage settlement then commits with hooks and publishes
through its existing custody path. A failed hook preserves the lane's refusal.

`src/lib/pipelines/cloudStage.test.ts` covers the transport contract and durable
record validation. `src/lib/pipelines/cloudHostedClient.test.ts` uses a fake
socket and fake auth/catalog to exercise hosted launch, status, final-message
reads, identity guards, permission handling, aborts and chunk checksums.
`src/lib/pipelines/engine.cloud.test.ts` uses only fake
transports to check arguments, model fidelity, polling, real-process restart
receipts, races, verdicts and errors. It also uses real Git repositories,
pre-commit hooks and bare remotes for Cloud builder/fix settlement.
`cloudStagePatch.test.ts` checks refusal paths and fresh-process apply recovery. `src/app/api/projects/settings/route.test.ts`
checks setting persistence, defaults and authority refusals. No live cloud task
or account credential is needed for these checks.

`evidence/cloud-stage-runtime.json` records the verification commands, source
fingerprints, explicit importer paths, raw check exit codes and repeated
whole-file observations on the implementation and its starting revision.
