# Codex Cloud stage runtime — slice 1

A pipeline run stage with `runtime: "codex-cloud"` selects cloud execution for a
read-only Codex reviewer or verifier with no declared worktree outputs. It must
name an explicit `model`; inherited defaults cannot select its model. Omission
of `runtime` preserves local execution. Builder and fix stages, diff application,
and cloud runtime switching are deferred.

The project setting `codexCloudEnvironmentId` defaults to an empty string,
which disables cloud execution. `GET /api/projects/settings?project=<project>`
reads it; an operator-authorized, same-origin `PUT /api/projects/settings` sets
or clears it. Other setting writes and canonical project aliases preserve it.

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
hosted transport in `src/lib/pipelines/cloudHostedClient.ts`. A cloud stage refuses execution when
there is no transport or its `supportsModel(model, reasoningEffort)` capability
cannot honour the explicit configuration. Legacy cloud execution cannot honour
that contract and has no adapter or fallback here. The transport supports
GPT-6.1 Sol, including an explicit reasoning effort. The project setting keeps
all remote work disabled until an operator supplies an ASB configuration ID.

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
- Expose diff retrieval for the next slice. Slice 1 never reads or applies it.
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
cloud-computed SHA-256 checked before returning any patch. It reads tracked
changes relative to the accepted head and launches no follow-up model turn.
Slice 1 never calls it. Staging untracked build/fix changes and applying patches
belong to slice 2.

**Compatibility risk:** this is the desktop application's protocol, with no
verified public API stability guarantee. The implementation adapts the verified
hosted client and tests its wire contract with a fake socket. No live task is
launched by the test suite. A backend protocol change, unavailable native
`getAuthStatus`, unknown response shape, model rerouting, missing ASB mount or
loss of execution identity fails the stage. Credentials remain in memory; raw
RPC errors and auth stderr are discarded. No performance gain is claimed.

The existing account resolver enforces the project pool and explicit account.
The runtime rechecks lane and account authority around transport calls. It binds
the stage definition at activation and includes the pinned specification,
previous output, lane branch, base and exact accepted head in the cloud prompt.
Cloud instructions replace local MCP and host mechanics and request the local
fenced JSON verdict contract.

## Shared contract paths

| Contract | Producers and copies | Consumers and defaults |
| --- | --- | --- |
| Stage runtime and explicit model | MCP stage schema and pipeline HTTP inputs; `normalizeStages`; draft copies and role overrides; activation binds runtime and effective model | Store validation, stage digest and cloud dispatch; omitted runtime uses the existing local path |
| Project environment | Settings HTTP PUT and `setCodexCloudEnvironmentId`; other setting writers spread the existing entry | Canonical project reads, settings GET and cloud admission; absent or cleared value is empty |
| Cloud attempt | Scoped controller-job checkpoints, serialized by the existing pipeline store | Attempt validation, indexed controller deadlines, API record reads and existing verdict settlement; absent for local attempts and before cloud admission |

## Controller and persistence

An attempt's `cloud` field retains environment, branch, exact head, task ID and
URL, actual model, poll count, next due time, deadline and terminal result/error.
`stageDigest.ts` includes the optional runtime; `store.ts` validates it and the
receipt. Draft copies, role overrides and bound attempt definitions retain and
validate the same stage contract. `controllerPass.ts` indexes the next poll and
deadline so waiting cloud work does not trigger a whole-store scan.

Submission and polls run in bounded controller jobs outside the lane mutation
lease. Delays grow from two seconds to thirty seconds. A persisted thirty minute
deadline spans restarts; each job additionally has a thirty second deadline.
The Viewer tick never sleeps waiting for cloud work. This change claims no
performance gain. The clean accepted head must match the published branch before
submission and completion. Internal, released, unpublished or moved lanes fail.

The existing verdict parser and settlement path normalize findings and handle
pass, fail, decision requests and fail edges into local fix stages. Cloud errors,
model mismatches and timeouts fail the attempt with their cause. Interrupted
submission with no receipt refuses automatic resubmission because its outcome is
unknown. A receipt resumes polling after restart. Superseded replies cannot
replace another receipt or advance a paused lane. Delivery takeover can clear the
old lane's active publication claim without advancing its old epoch; cloud jobs
also fence the owner, active flag, publication policy and disposition, and the
controller refuses later polling or settlement after that withdrawal.
Clearing or changing the project environment setting also withdraws authority
before another remote effect. A known submission receipt can still be retained
for inspection; the attempt fails instead of polling or accepting a verdict.

`src/lib/pipelines/cloudStage.test.ts` covers the transport contract and durable
record validation. `src/lib/pipelines/cloudHostedClient.test.ts` uses a fake
socket and fake auth/catalog to exercise hosted launch, status, final-message
reads, identity guards, permission handling, aborts and chunk checksums.
`src/lib/pipelines/engine.cloud.test.ts` uses only fake
transports to check arguments, model fidelity, polling, real-process restart
receipts, races, verdicts and errors. `src/app/api/projects/settings/route.test.ts`
checks setting persistence, defaults and authority refusals. No live cloud task
or account credential is needed for these checks.

`evidence/cloud-stage-runtime.json` records the verification commands, source
fingerprints, explicit importer paths, raw check exit codes and repeated
whole-file observations on the implementation and its starting revision.
