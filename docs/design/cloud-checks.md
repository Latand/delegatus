# Pipeline checks in Codex Cloud

Status: operator decisions accepted, 2026-10-24. The first implementation
routes pre-push heavy checks through one Cloud job. Later work extends the same
transport to explicitly selected stage and browser checks.

## Execution policy

Cloud is the default for a project. Each lane can inherit that default or choose
Cloud or local execution. A stage can override its lane. The lane action menu exposes
lane and project settings. MCP's `pipeline_checks` tool changes those settings and
stage overrides using `scope: stage` with `stageId`; the voice companion can ask
the project's orchestrator to use that tool. Settings live in the repository's
local Git configuration, shared by its worktrees. Stage choices take precedence over
lane choices, which take precedence over the project default. Publication passes the
current stage ID to the hook. `LLV_GATE_EXECUTION=local` selects local execution for
one command.

Code may reach Codex Cloud before the full local pre-push gate. Cloud is trusted
and may receive the source history and the committed privacy fingerprint
catalog. The Delegatus privacy gate may run there. The privacy boundary is
publication to GitHub: privacy must pass before that push. The earlier proposal
for a sanitized Git history, local-only fingerprints, advisory results and a
second full local verification is superseded.

A complete Cloud verdict is decisive immediately. Cloud and local execution
must run the same selected checks and preserve their pass/fail semantics,
including touched-test comparison against the same merge base. A red assertion,
privacy refusal or failed cleanup cannot become an infrastructure retry.
Missing evidence never means success. Required CI checks remain in force.

Use the maximum parallelism the applicable Cloud limits permit. Do not impose
the earlier proposed limits of two lanes, three shards or two test workers.
The first slice submits one job per publication and retains the existing
parallel lanes inside the admitted gate. Independent publications need no new
application-wide Cloud semaphore. Provider limits remain authoritative.

The rented check server is retired. Local fallback explicitly disables SSH
runner dispatch. It does not provision or re-enable a rented server.

## First slice: pre-push publication

The pre-push hook requires local privacy to pass before sending source to Cloud.
Privacy uses the existing trusted inputs and retains its refusal text.
Explicit local execution retains concurrent privacy and heavy checks.
The heavy half selects Cloud unless the stage, lane, project or command requests
local execution. Types, changed-file lint, touched tests and the selected push
checks run together through the existing admitted pre-push entry point.
Prose-only and no-change selection rules remain those of the local planner.

The hook reads the actual outgoing SHA from Git's pre-push input. Multiple
distinct outgoing heads require separate pushes. Pipeline publication also
passes its accepted SHA and lane ID. With Cloud configured, the checkout must
be clean and match that SHA. The job carries an incremental Git bundle from the comparison base to the exact
head. The configured Cloud checkout must contain that base. Source chunks travel
through `thread/shellCommand`, each with a checked command exit, so source bytes
do not consume the model context. Before the check turn, `thread/revert` removes
only the upload history while retaining its files. Cloud clones the configured checkout, imports
the bundle, checks out that head detached, verifies its tree,
sets the same comparison base, installs frozen dependencies, and invokes:

```sh
bun scripts/local-gate.ts pre-push --admitted
```

Checks get isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR before the
runner starts. Hook skipping, SSH dispatch and recursive Cloud dispatch are disabled. Cloud
uses the same repository planner and execution code as local fallback. The
command checks the tree and tracked working files again before emitting its
terminal receipt. Local publication rechecks the source after receiving it.
A changed tree invalidates the result.

The transport is `scripts/cloud-checks.ts`. Its private JSON configuration is
selected by `LLV_GATE_CLOUD_CONFIG` and contains `url`, optional authenticated
`headers` and WebSocket `protocols`, `environmentId` and `cwd`. Credentials and environment routing values
must stay out of repository documentation and fixtures.

The current app-server WebSocket lifecycle is:

1. `initialize`, then the `initialized` notification.
2. `thread/start` with model `gpt-6.1-sol`, provider fallback disabled,
   `approvalPolicy: never`, `sandbox: danger-full-access`,
   `serviceName: codex_cloud`, an `environmentConfigId` and
   `deferredEnvironment: false` so uploads can run before
   the check turn.
3. Verify the resolved model and environment. Then `turn/start` with
   `sandboxPolicy: { type: dangerFullAccess }` and the exact
   check command.
4. Paginated `thread/turns/list` state and `thread/items/list`
   command records. Only a completed command record with a matching head,
   tree, base and exit code supplies the verdict. Model prose supplies none.

The adapter is injectable. Tests use fake RPC and loopback WebSocket servers,
without live Cloud calls. They exercise green and red commands, mismatched trees,
missing evidence, launch fields, outages, Cloud limits, account limits and cancellation.

## Failures and local fallback

When Cloud is unavailable or a Cloud-specific resource or execution-time limit
is exhausted, retry once to confirm the failure. Then execute the same checks
locally once. A successful retry is decisive and needs no local run. Account
limits do not permit this fallback; return no verdict and retain the existing
publication retry/park behavior.

Interrupt timed-out work and give Cloud time to record termination. After a
connection loss, reconnect once to interrupt the old job where possible. A
confirmed transport outage still follows the retry and single local fallback
rule; it never supplies a passing verdict. A missing command record after an
otherwise completed turn is invalid evidence and blocks publication.

The existing publication deadline remains authoritative. Retry does not reset
it. Local fallback uses normal local CPU admission and isolation with SSH
execution disabled. A check refusal remains a refusal even if transport also
fails. Preserve the existing head ownership fence, remote-write reconciliation
and repair behavior.

## Browser checks and subsequent work

The policy also places browser drivers in Cloud, including kanban and phone.
Use the existing drivers, installed Chromium through `CHROME_BIN`, and the same
language/theme cases. A Cloud time-limit interruption follows the confirmed
retry and local fallback rule above. Browser frames remain required evidence
for visual claims. The first slice changes the pre-push heavy half; explicit
stage/browser dispatch still needs integration with this transport.

Broader stage dispatch must retain the same source binding, terminal command
records, isolation, cancellation and fallback semantics. Add provider-specific
limit codes as those responses are verified. Unknown errors fail closed; do not
classify an account allowance as Cloud capacity. Do not replace these checks
with an agent summary or a second, weaker Cloud-only plan.
