# Recorded check waits across release handover

## Trace and record owners

The foreground tool is `wait_for_check` in `src/lib/runtime/gateCheckTool.ts`.
It observes an existing recording; it takes no admission slot and starts no
command. `scripts/gate-slot.sh --record` delegates to `scripts/gate-wait.ts`,
which writes `owner.json`, the immutable `completion.json` deadline and, after
command cleanup, the atomic `exit` record. Manifest recordings additionally
retain their existing custody descriptor and terminal report. Their custody
admission and acknowledgement paths are unchanged.

The foreground run id is the digest of the canonical log path and completion
ticket, including its physical directory, recorder identity and deadline. The
callback receipt retains that id alongside the existing native generation,
thread, turn, typed RPC id and request digest. The host ledger belongs to that
thread; registry launch and adoption bindings associate it with the waiting
conversation and pipeline attempt. No new attempt or process inherits callback
ownership merely by reusing an RPC id.

| Producer or consumer | Record and behaviour |
| --- | --- |
| `recordGate` in `scripts/gate-wait.ts` | Produces the immutable completion ticket and atomic exit; retains results even without a Viewer connection. |
| `gateCompletionIdentity`, `waitForGateCompletion` in `src/lib/runtime/gateWait.ts` | Validate recorder, boot and physical directory; derive the run id, read an existing result by its bound id and observe only until the original deadline plus the existing cleanup allowance. |
| `prepareGateCheckTool`, `runGateCheckTool` | Check containment in the listener's launch root before any result read, bind/recheck the run id and return terminal or explicit unknown evidence. |
| `CodexAppServerHost.acceptGateCheck` | Produces the pending request receipt before observation. Every gate receipt carries `gateWait`; a refused wait (invalid arguments, a log outside the stage root) has no run id but still retains its dispatched refusal. Duplicate callbacks join that receipt; conflicting request digests or RPC collisions are refused. |
| `CodexAppServerHost.startGateCheck`, `settleGateCheck` | Owns the cancellable in-memory observation, persists the result and dispatch digest before writing the reply, and rechecks turn and writer authority after waiting. Native Codex (0.162.1 to 0.167.0) sends no `serverRequest/resolved` for an answered `item/tool/call`, so the host records its own reply as the terminal `answered` resolution right after the write. |
| `CodexAppServerHost.acceptNotification` | Consumes a `serverRequest/resolved` that arrives before the reply (an interrupted turn) and produces the terminal server-resolution receipt. One arriving after the host settled the wait finds nothing to resolve. |
| `CodexAppServerHost.disconnectSocketConnection`, release and failure paths | Cancel local observations. Demotion closes the Viewer connection while the original native callback process survives; it does not delete the receipt or recorder result. |
| `FileRuntimeEventStore.append/load`, `validCodexRequestReceipt` | Fsync and validate receipt-bearing attention events. Legacy receipts default to having no gate wait; copies retain the optional gate wait and bounded response. |
| `CodexAppServerHost.restoreEvents`, `reconcileAfterOpen`, native callback replay | Restore the receipt from the same ledger. A surviving native generation and active turn resume a pending wait even without callback replay. If dispatch was recorded before the connection closed, reconciliation uses the retained response and original RPC id. Terminal receipts suppress all later deliveries. |
| `projectEngineHostEvent` in `src/lib/runtime/engineHostEvents.ts` | Projects no gate-wait receipt. The wait is the host's automatic callback, not operator attention, so the session's attention set stays empty and idle continuation and retirement are never held by it. |
| Registry persistence, release interruption and startup adoption | Carry the process endpoint, kernel identity, thread and event cursor into the successor. The verified socket owner and its original launch root remain prerequisites for recovery. |

The in-memory map owns watcher cancellation only. Pending identity and dispatch
state live in the existing receipt ledger. Results remain readable through
`waitForGateCompletion` with the log and expected run id retained by that
receipt; observing a result does not consume or remove it. A missing exit after
the original deadline and cleanup allowance returns `outcome: unknown`, the
run id and an explicit reason. Progress and reconnects cannot renew the bound.

For a surviving callback, reconciliation addresses the same RPC request on the
verified native process, including a crash between recording dispatch and
writing the response. A crash after the write and before the terminal record
resends the retained reply once; Codex ignores a reply to a request id it no
longer holds. Ordinary duplicate frames on an attached connection do not resend
a dispatch. The terminal receipt suppresses replay after another process
restart. Native resolution also cancels the local observer and prevents it from
reopening that receipt. A restored wait whose native turn or generation is gone
retires with the existing unavailable or uncertain recovery outcome, since no
callback is left to answer.

This change claims no performance gain. It adds one durable pending write, one
dispatch write and one resolution write per foreground wait, using the existing callback mechanism;
recovery walks only the host's pending callbacks at adoption, never the entire
store on a tick.

## Notes

Releasing admission between expensive leaf commands in a long batch remains a
separate follow-up. This change does not adjust slots, priorities or queueing.
