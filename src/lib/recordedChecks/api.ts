import { recordedCheckInput } from "./input";
import { openRecordedChecks } from "./store";
import { handoffRecordedCheck, callingAttempt, verifyLiveCustody, consumerPermitted, acknowledgeRecordedCheck } from "./service";
import { observeRecordedCheck } from "./observer";
import { statePath } from "@/lib/configDir";
export class RecordedCheckRefusal extends Error {
  readonly status: number;
  constructor(message: string, options: { status: number }) { super(message); this.status = options.status; }
}

export async function recordedCheck(args: Record<string, unknown>, caller: string): Promise<Record<string, unknown>> {
  if (!caller) throw new RecordedCheckRefusal("recorded checks require an attributed conversation", { status: 403 });
  const { clientRequestId, ...body } = args;
  if (typeof clientRequestId !== "string" || !clientRequestId || clientRequestId.length > 256) throw new RecordedCheckRefusal("a bounded request identity is required", { status: 400 });
  const input = recordedCheckInput.strict().parse(body);
  let row;
  if (input.action === "handoff") {
    if (!input.ticket) throw new RecordedCheckRefusal("handoff requires the existing recorded ticket", { status: 400 });
    row = await handoffRecordedCheck(caller, String(clientRequestId), input.ticket, { binding: callingAttempt, verify: verifyLiveCustody, observe: observeRecordedCheck });
  } else {
    const store = await openRecordedChecks();
    try { row = input.receiptId ? store.get(input.receiptId) : null; } finally { store.close(); }
    if (!row || !consumerPermitted(row, caller)) throw new RecordedCheckRefusal("recorded check receipt is unavailable to this consumer", { status: 403 });
    if (input.action === "acknowledge") {
      if (input.resultRevision === undefined || !input.resultDigest || !input.evidenceDigest || !input.disposition) throw new RecordedCheckRefusal("acknowledgement requires the current result and evidence revision", { status: 400 });
      row = await acknowledgeRecordedCheck(row, caller, { resultRevision: input.resultRevision, resultDigest: input.resultDigest,
        evidenceDigest: input.evidenceDigest, disposition: input.disposition });
    }
  }
  const count = row.result?.evidenceCount ?? 0;
  const start = Math.min(count, input.cursor ?? 0);
  const store = await openRecordedChecks();
  let page;
  try { page = row.result ? store.evidencePage(row.id, row.result.revision, start) : []; }
  finally { store.close(); }
  const cursor = start + page.length;
  const terminal = row.result?.terminal;
  const report = terminal?.report;
  return ({ receiptId: row.id, status: row.admission === "accepted" ? "custody-accepted" : "interrupted-unknown",
    deadline: row.descriptor.manifest.deadline, sourceDigest: row.descriptor.descriptorDigest, reason: row.reason,
    result: row.result ? { ...row.result, history: undefined, evidence: page,
      terminal: terminal ? { wrapperExit: terminal.wrapperExit, wrapperSignal: terminal.wrapperSignal,
        cancellation: terminal.cancellation, closedAt: terminal.closedAt,
        report: report ? { commandExit: report.commandExit, commandSignal: report.commandSignal, cleanup: report.cleanup, phase: report.phase, kind: report.kind } : null } : null } : null,
    evidenceDirectory: statePath("evidence", "recorded-checks", row.binding.pipeline, row.id),
    acknowledgement: row.acknowledgement, notification: row.notification ? { state: row.notification.state, operation: row.notification.operation } : null,
    cursorClamped: input.cursor !== undefined && start !== input.cursor,
    truncated: cursor < count, nextCursor: cursor < count ? cursor : null });
}
