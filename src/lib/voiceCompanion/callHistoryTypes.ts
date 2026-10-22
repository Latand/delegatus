import type { TranscriptEntry } from "./transcriptRecord";

/*
 * What a voice call did, as its owner reads it after the call (GitHub #2975): the retained calls, newest first, each
 * with its actions in the order they happened. Read from the call journals the Viewer keeps (`transcriptRecord.ts`);
 * what was said, sent, read or answered stays in the call's own record, which the session route serves to its owner.
 */

/** A request to an orchestrator, any other tool the voice called, or a report an orchestrator sent into the call. */
export type CallActionKind = "request" | "tool" | "report";
export interface CallAction {
  /** The record entry it comes from: where the action stands in the call's transcript. */
  id: string;
  kind: CallActionKind;
  /** The tool's registry name; null for a request or a report. */
  name: string | null;
  /** Unix milliseconds. */
  at: number;
  /** The display name of the project the action went to or came from, when the record names one. */
  project: string | null;
  /** A request's delivery stage (`requestStage`), a tool's running, done or failed, a report's class. */
  status: string;
  code: string | null;
  /** Why a request was not sent or not delivered, or why a tool failed, as the record keeps it. */
  reason: string | null;
  /** The orchestrator conversation a request went to, or an answer came from. */
  conversationId: string | null;
  /** The request an answer reports on. */
  requestId: string | null;
}
export interface RetainedCall {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  /** The display name of the project the call started in. */
  project: string;
  live: boolean;
  truncated: boolean;
  /** null when the call's record could not be read: unknown, never "nothing happened". */
  actions: CallAction[] | null;
}

/** Each recorded request status by the stage the voice UI names it. */
export const REQUEST_STAGES: Readonly<Record<string, string>> = { proposed: "proposed", sending: "sending", awaiting_confirmation: "awaiting-confirmation", queued: "queued", delivered: "delivered", unknown: "unknown", failed: "failed", refused: "refused", cancelled: "cancelled", sent: "delivered" };
/** A request's recorded status as one of the stages the voice UI names. */
export const requestStage = (status: unknown): string => REQUEST_STAGES[typeof status === "string" ? status : ""] ?? "proposed";

/** An action before its project key has a display name. */
export type DerivedAction = Omit<CallAction, "project"> & { projectKey: string | null; projectName: string | null };
const text = (value: unknown) => (typeof value === "string" && value ? value : null);
type Recipient = { project?: unknown; conversationId?: unknown } | undefined;

/** One call's actions in record order. The tool call a request entry stands for is that request, listed once. */
export function callActions(entries: readonly TranscriptEntry[], createdAt: number): DerivedAction[] {
  const sorted = [...entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const requested = new Set(sorted.filter(entry => entry.kind === "request").map(entry => text(entry.data.callId) ?? entry.id));
  const requests = new Map<string, string>();
  const actions: DerivedAction[] = [];
  for (const entry of sorted) {
    const data = entry.data;
    const at = createdAt + entry.atMs;
    if (entry.kind === "tool") {
      if (requested.has(text(data.callId) ?? "")) continue;
      actions.push({ id: entry.id, kind: "tool", name: text(data.name), at, projectKey: null, projectName: null, status: text(data.status) ?? "running",
        code: text(data.code), reason: text(data.reason), conversationId: null, requestId: null });
    } else if (entry.kind === "request") {
      const recipient = (data.recipient ?? (data.delivery as { recipient?: unknown } | undefined)?.recipient) as Recipient;
      requests.set(text(data.callId) ?? entry.id, entry.id);
      actions.push({ id: entry.id, kind: "request", name: null, at, projectKey: text(recipient?.project), projectName: text(data.projectName), status: requestStage(data.status),
        code: text(data.code), reason: text(data.reason), conversationId: text(recipient?.conversationId), requestId: null });
    } else if (entry.kind === "report") {
      const delivery = data.delivery as { callId?: unknown; recipient?: Recipient } | undefined;
      actions.push({ id: entry.id, kind: "report", name: null, at, projectKey: text(delivery?.recipient?.project) ?? text(data.project), projectName: text(data.projectName),
        status: text(data.status) ?? "message", code: null, reason: null, conversationId: text(delivery?.recipient?.conversationId), requestId: requests.get(text(delivery?.callId) ?? "") ?? null });
    }
  }
  return actions;
}
