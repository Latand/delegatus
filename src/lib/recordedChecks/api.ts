import { recordedCheckInput } from "./input";
import { openRecordedChecks } from "./store";
import { handoffRecordedCheck, callingAttempt, verifyLiveCustody, consumerPermitted, acknowledgeRecordedCheck } from "./service";
import { observeRecordedCheck } from "./observer";
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
  const evidence = row.result?.evidence ?? [];
  const start = Math.min(evidence.length, input.cursor ?? 0), page = [];
  let bytes = 0, cursor = start;
  for (; cursor < evidence.length; cursor++) {
    const entry = evidence[cursor]!;
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (bytes > 4096) break;
    page.push(entry);
  }
  return ({ receiptId: row.id, status: row.admission === "accepted" ? "custody-accepted" : "interrupted-unknown",
    deadline: row.descriptor.manifest.deadline, sourceDigest: row.descriptor.descriptorDigest, reason: row.reason,
    result: row.result ? { ...row.result, history: undefined, evidence: page } : null,
    acknowledgement: row.acknowledgement, notification: row.notification ? { state: row.notification.state, operation: row.notification.operation } : null,
    truncated: cursor < evidence.length, nextCursor: cursor < evidence.length ? cursor : null });
}
