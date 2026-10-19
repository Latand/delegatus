# Deployment receipt recovery

`deploy_exact_sha` persists its seat, requested revision and original request
key before sending the control request. Admission can finish while the caller
times out. A reconnect error therefore answers `outcome_unknown`, with
`retryable:false` and `deployment_status` as the next read. The MCP receipt
stays open so a replay of the original key can obtain the admitted deployment.
Legacy stored `tool_failed` reconnect errors also take this recovery path.
Admission retains responsibility for serializing deployments and checking
idempotency; a changed payload under the same MCP key remains a conflict.

The HTTP admission handler attaches the deployment to the pending seat before
returning, for both checkout and managed installs. This preserves the wake if
the control caller disconnects without replaying. It reads the bounded seat
attribution file rather than scanning deployment history. A matching busy SHA
also attaches the seat; a different SHA keeps the busy response. The attribution
store refuses to transfer a recorded deployment to another seat.

Seat writes use asynchronous file transactions. Caller checks run before MCP
receipt replay and again after admission to the attribution transaction. Loop
monitoring labels the wait and write as `orchestrator.deploy-attribution` and
`orchestrator.deploy-attribution.write`. A failed attribution write preserves
the admitted response and reports the missing wake. No performance gain is
claimed.

Regression coverage:

- `src/lib/mcp/bindings.deploy.test.ts`: real HTTP admission with a fake deploy
  adapter, a lost response, fresh-process replay, legacy failures and refusals.
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
