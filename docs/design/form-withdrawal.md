# Form withdrawal and delivery retirement

Every waiting round has an exact withdrawal target. The operator opens its form or saved answer in Decisions and presses **Withdraw form**. A failed write keeps the form and shows a localized retry message. Withdrawal preserves the question and saved answer in history.

Scoped workspace operators send the project with the withdrawal request. The server checks the stored round's project and the current browser membership again immediately before writing; a caller-supplied project cannot grant access to a foreign round. Capability-bearing agents use the MCP tool.

The project seat uses `dismiss_attention` with the row's `target`, a fresh `clientRequestId`, and an optional one-line reason. A taskless form has `{kind:"prototype", taskId:null, reviewId}`. A task round supplies its task id. The same target with `undo:true` restores the withdrawal mark. A later round remains independently actionable. Current project and seat authority are checked before receipt replay and after asynchronous store preparation.

The Decisions badge counts the same waiting forms and undelivered answer cards as the panel's prototype rows. Settled deliveries leave both waiting projections. Completed tasks use the same waiting-round filter in the Decisions list as the panel.

A saved answer has a persisted 30-minute delivery age limit. The next worker visit checks any delivered receipt before retiring an unresolved delivery with `delivery-expired`. A verified late receipt or a verified complete wake can settle the answer as delivered before retirement. Retirement preserves the answer, original operation id and original delivery outcome. It removes the waiting obligation and disables automatic retries; the answer's record shows the retirement reason. A process restart cannot reset the age. Retirement metadata remains local; the strict linked-installation replica reader continues to accept the public writer's output.

## Clearing the three reported legacy rows

After this change reaches the installation, the operator can withdraw each of the three legacy rows directly in Decisions. The seat can instead read `dismiss_attention` with `kinds:["prototype"]` and `full:true`, then submit each returned target under its own fresh request id. Copy each target from that read, including a null task id; escalation Undo is a different operation. Re-read the panel and Decisions after the writes. The old undelivered answer also retires automatically on the first delivery-worker visit that cannot confirm it. No database editing or one-off migration is required.

This change performs no live-state cleanup or deployment from the builder stage.

## Verification

Focused tests, baseline comparisons, browser evidence and commands are recorded in `docs/verification/form-withdrawal.md`. No performance improvement is claimed.
