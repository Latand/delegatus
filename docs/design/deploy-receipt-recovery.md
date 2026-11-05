# Deployment receipt recovery

`deploy_exact_sha` persists its seat, requested revision and original request
key before sending the control request. Admission can finish while the caller
times out. After a reconnect error, the same call reconciles the original key
and returns the accepted deployment id when admission is proven. If recovery
cannot prove admission, it answers `outcome_unknown`, with `retryable:false`
and `nextAction: retry-same-key`. Retain the original arguments and
`clientRequestId`. The next call uses a five-second reconciliation budget,
shortened by the caller's deadline, and sends no new admission request.
`deployment_status` remains available for observing admitted work.

Reconciliation returns the admitted deployment or durably closes an absent
key with `deploy_not_admitted`, `outcome: not-executed` and
`evidence: not-admitted`. The MCP service saves that terminal refusal for
replay. Both backends serialize closure with admission and matching-SHA joins:
the runtime journal uses one SQLite transaction; checkout installs use a
SQLite admission lock around the durable ledger write. Target resolution and
green-check waits hold neither lock. A delayed original request checks the
closed key before admission and cannot start a deployment under it. These
records survive process restarts.

The control call uses `POST /api/runtime/deployments/reconcile`; its runtime
RPC is `viewer-deployment-reconcile`. Both addresses force reconciliation.
An older Viewer or runtime host rejects the unknown address instead of
ignoring a new flag on its admission endpoint. When reconciliation is
unsupported or unavailable, the answer remains `outcome_unknown`; its
five-second budget bounds the attempt, and no absence or non-admission is
claimed. Restore the backend and replay the original key to settle it.
Legacy stored `tool_failed` reconnect errors also take this recovery path.
Admission retains responsibility for serializing deployments and checking
idempotency; a changed payload under the same MCP key remains a conflict. A
matching SHA that joins an active deployment is durably bound to that deployment
in the runtime journal or managed checkout ledger before the response is sent,
so a lost join response can be reconciled after the deployment settles without
starting another build.

The HTTP admission handler attaches the deployment to the pending seat before
returning, for both checkout and managed installs. This preserves the wake if
the control caller disconnects without replaying. It reads the bounded seat
attribution file rather than scanning deployment history. A matching SHA join
also attaches the seat; a different SHA keeps the busy response. The attribution
store refuses to transfer a recorded deployment to another seat.

Seat writes use asynchronous file transactions. Caller checks run before MCP
receipt replay and again after admission to the attribution transaction. Loop
monitoring labels the wait and write as `orchestrator.deploy-attribution` and
`orchestrator.deploy-attribution.write`. A failed attribution write preserves
the admitted response and reports the missing wake. No performance gain is
claimed.

Regression coverage:

- `src/lib/mcp/bindings.deploy.test.ts` and
  `src/lib/mcp/bindings.deploy.replay.test.ts`: real HTTP admission with a fake
  deploy adapter, lost and truncated responses, failed attribution, and
  fresh-process replay before and after settlement.
- `src/runtime-host/deployment.test.ts`: a matching SHA join key survives
  settlement and journal reopen; a different SHA stays busy; held resolution,
  durable closure, process restart and older-protocol refusal.
- `src/lib/mcp/callRecovery.http.test.ts`: SDK calls through the exported MCP
  route settle an absent key and fence the original delayed HTTP POST.
- `src/lib/selfUpdate/deploymentAdmission.test.ts`: checkout admission and
  closure survive a real process restart and refuse revoked callers.
- `src/lib/selfUpdate/routes.test.ts`: managed checkout joins persist and replay
  after settlement, with a different SHA staying busy.
- `src/app/api/runtime/deployments/route.test.ts`: attribution before responding,
  including checkout installs, and rejection of invented seats or another SHA.
- `src/lib/monitor/seatTickController.reporting.test.ts`: one delivered
  `deploy-settled` wake for a matching busy deployment.
- `src/lib/orchestrator/seatDeployments.test.ts`: contended writes yield and
  recheck caller authority after obtaining the lock.

Run these files by explicit path through the project gate, each with private
HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, and with
LLV_VIEWER_CONTROL_URL pointing to a closed port. The HTTP regressions replace
that URL only with their own ephemeral server. Every deploy adapter is a fake.
