import { randomUUID } from "node:crypto";
import type { BridgeReportV1 } from "@/lib/bridge/types";
import { canonicalProject } from "@/lib/projects/aliases";
import type { CompanionCommand, CompanionEvent, Delivery, Locale, Payload, Proposal, Recipient } from "./contract";
import { admitDelegationProposal, type OperatorInput } from "./gate";
import { liveProposalRefusal } from "./liveGate";
import { CompanionStorage, type StoredProposal, type StoredSession } from "./storage";

export interface CompanionDeliveryPaths {
  recipient(project: string): Recipient | null;
  /** Existing orchestrator send path. It owns durable receipt idempotency. */
  send(binding: { sessionId: string; proposalId: string; delivery: Delivery; text: string }): Promise<{ status: "delivered" | "queued" | "unknown"; operationId: string | null }>;
  reports(project: string): BridgeReportV1[];
  receipt?(delivery: Delivery): Promise<"delivered" | "failed" | "pending">;
}
const sameRecipient = (left: Recipient | null, right: Recipient) => !!left && canonicalProject(left.project) === canonicalProject(right.project)
  && left.conversationId === right.conversationId && left.seatEpoch === right.seatEpoch && left.engine === right.engine;
const reportStatus = (report: BridgeReportV1): "progress" | "result" | "question" | "blocked" | null => {
  switch (report.class) {
    case "status": return "progress";
    case "completed": case "review_verdict": return "result";
    case "question": return "question";
    case "blocked": case "failed": return "blocked";
    default: return null;
  }
};

function appendEvent(session: StoredSession, payload: Payload, now: number): CompanionEvent {
  const event = { ...payload, version: 1 as const, sessionId: session.id, generation: session.generation,
    seq: ++session.seq, eventId: randomUUID(), atMs: now - session.createdAt } as CompanionEvent;
  session.events.push(event);
  session.events = session.events.slice(-512);
  return event;
}

function sessionIn(storage: CompanionStorage, id: string): StoredSession {
  const session = storage.read().sessions[id];
  if (!session) throw new Error("SESSION_UNAVAILABLE");
  return session;
}
/** This binding is checked again by the shared HTTP relay admission. A body
 * field alone can never stamp voice provenance or invent a delivery. */
export function admittedVoiceBinding(input: { sessionId: string; proposalId: string; project: string; recipient?: string; key?: string; text: string }, storage = new CompanionStorage()): StoredProposal | null {
  const session = storage.read().sessions[input.sessionId];
  const binding = session?.proposals[input.proposalId];
  return session && canonicalProject(session.project) === canonicalProject(input.project) && binding?.state === "admitted" && binding.delivery
    && binding.delivery.clientMessageId === input.key && binding.delivery.recipient.conversationId === input.recipient
    && binding.text === input.text ? binding : null;
}

/** The server authority seam. Live may raise a proposal without a completed
 * transcript; delivery always consumes the operator's tap. Prototype sessions
 * retain their completed-input policy for deterministic demo fixtures. */
export class CompanionAdmission {
  private readonly sending = new Map<string, Promise<void>>();
  constructor(readonly storage: CompanionStorage, private readonly paths: CompanionDeliveryPaths, private readonly now = Date.now) {}
  create(options: { project: string; locale: Locale; authority?: "live-model" }): StoredSession {
    const session: StoredSession = { id: randomUUID(), project: canonicalProject(options.project), locale: options.locale, generation: 1,
      createdAt: this.now(), closed: false, inputs: [], proposals: {}, events: [], seq: 0,
      ...(options.authority ? { authority: options.authority } : {}) };
    this.storage.change(document => {
      if (Object.values(document.sessions).filter(row => !row.closed).length >= 8) throw new Error("SESSION_LIMIT");
      document.sessions[session.id] = session;
    });
    return session;
  }
  session(id: string) { return sessionIn(this.storage, id); }
  emit(id: string, payload: Payload): CompanionEvent {
    return this.storage.change(document => {
      const session = document.sessions[id];
      if (!session) throw new Error("SESSION_UNAVAILABLE");
      return appendEvent(session, payload, this.now());
    });
  }
  events(id: string, after: number): CompanionEvent[] { return this.session(id).events.filter(event => event.seq > after); }
  /** Trusted transcript normalization only; the browser command API cannot
   * submit text. Live's finals mark display boundaries and grant no authority. */
  input(id: string, input: OperatorInput, timing: { startMs?: number; endMs?: number } = {}): void {
    const cancelled = this.storage.change(document => {
      const session = document.sessions[id];
      if (!session || session.closed) throw new Error("SESSION_CLOSED");
      const previous = session.inputs.find(row => row.itemId === input.itemId);
      if (previous) Object.assign(previous, input);
      else session.inputs.push(input);
      session.inputs = session.inputs.slice(-64);
      const removed: StoredProposal[] = [];
      for (const row of Object.values(session.proposals)) {
        if (row.state === "pending" && (session.authority === "live-model" ? liveProposalRefusal(row.proposal.instruction, session.inputs) !== null
          : !admitDelegationProposal({ ...row.proposal, inputs: session.inputs, frozenSourceText: row.sourceText }).admit)) {
          row.state = "cancelled"; removed.push(row);
        }
      }
      return removed;
    });
    this.emit(id, this.session(id).authority === "live-model" ? { type: "transcript.snapshot", speaker: "operator", itemId: input.itemId, text: input.text, final: input.final, ...timing }
      : input.final ? { type: "transcript.final", speaker: "operator", itemId: input.itemId, text: input.text }
      : { type: "input.speech.started", itemId: input.itemId });
    for (const row of cancelled) this.emit(id, { type: "delegation.tool.result", callId: row.proposal.callId, proposalId: row.proposal.proposalId,
      result: { status: "cancelled", code: "source_changed" } });
  }
  propose(id: string, callId: string, sourceItemId: string, instruction: string): Proposal | null {
    const existing = Object.values(this.session(id).proposals).find(row => row.proposal.callId === callId);
    if (existing) return existing.state === "pending" ? existing.proposal : null;
    this.emit(id, { type: "delegation.tool.called", callId, sourceItemId, instruction: instruction.slice(0, 2_000) });
    let refusal = "not_admitted";
    const proposal = this.storage.change(document => {
      const session = document.sessions[id];
      if (!session || session.closed) { refusal = "session_closed"; return null; }
      const reason = session.authority === "live-model" ? liveProposalRefusal(instruction, session.inputs)
        : (() => { const gate = admitDelegationProposal({ sourceItemId, instruction, inputs: session.inputs }); return gate.admit ? null : gate.reason; })();
      if (reason) { refusal = reason; return null; }
      const recipient = this.paths.recipient(session.project);
      if (!recipient) { refusal = "no_orchestrator"; return null; }
      if (Object.values(session.proposals).some(row => row.state === "pending" && row.proposal.sourceItemId === sourceItemId)) { refusal = "duplicate_proposal"; return null; }
      const proposal: Proposal = { proposalId: randomUUID(), callId, sourceItemId, instruction: instruction.trim(), recipient,
        ...(session.authority ? { authority: session.authority } : {}) };
      session.proposals[proposal.proposalId] = { proposal, sourceText: session.inputs.at(-1)?.text ?? "", expiresAt: this.now() + 120_000, state: "pending", reports: [] };
      return proposal;
    });
    this.emit(id, proposal ? { type: "delegation.confirmation.required", proposal }
      : { type: "delegation.tool.result", callId, result: { status: "refused", code: refusal } });
    return proposal;
  }
  async confirm(id: string, command: Extract<CompanionCommand, { type: "confirmation" }>): Promise<void> {
    if (command.via !== "tap") return;
    let refusal = "proposal_unavailable";
    const binding = this.storage.change(document => {
      const session = document.sessions[id];
      const row = session?.proposals[command.proposalId];
      if (!row || row.state === "cancelled") return null;
      // Recovery remains available after closure/restart. A retry recovers its
      // original key and target; it cannot admit new work to the current seat.
      if (row.state === "admitted") return row;
      if (command.decision === "cancel") { row.state = "cancelled"; refusal = "operator_cancelled"; return null; }
      const allowed = session.authority === "live-model" ? liveProposalRefusal(row.proposal.instruction, session.inputs) === null
        : admitDelegationProposal({ ...row.proposal, inputs: session.inputs, frozenSourceText: row.sourceText }).admit;
      if (session.closed || this.now() > row.expiresAt || !allowed || !sameRecipient(this.paths.recipient(session.project), row.proposal.recipient)) {
        row.state = "cancelled"; refusal = "proposal_changed"; return null;
      }
      row.state = "admitted";
      row.delivery = { proposalId: row.proposal.proposalId, callId: row.proposal.callId,
        clientMessageId: `voice-${randomUUID()}`, operationId: null, recipient: row.proposal.recipient };
      row.text = `${row.proposal.instruction}\n\n[Voice Delegatus reply: report progress or the result using bridge_report with correlatesDirective equal to ${row.delivery.clientMessageId}. Keep the report tied to this request.]`;
      return row;
    });
    if (!binding) {
      const row = this.session(id).proposals[command.proposalId];
      if (row) this.emit(id, { type: "delegation.tool.result", callId: row.proposal.callId, proposalId: command.proposalId,
        result: { status: "cancelled", code: refusal } });
      return;
    }
    if (command.decision === "cancel") return; // already-admitted work cannot be undone
    const key = binding.delivery!.clientMessageId;
    const current = this.sending.get(key);
    if (current) return current;
    const promise = this.deliver(id, binding);
    this.sending.set(key, promise);
    try { await promise; } finally { this.sending.delete(key); }
  }
  private async deliver(id: string, row: StoredProposal): Promise<void> {
    if (row.status === "failed") return;
    const proposalId = row.proposal.proposalId;
    this.emit(id, { type: "delegation.confirmed", proposalId, via: "tap" });
    let settled = { status: row.status ?? "unknown", operationId: row.delivery!.operationId };
    if (!row.status || row.status === "unknown") {
      try { settled = await this.paths.send({ sessionId: id, proposalId, delivery: row.delivery!, text: row.text! }); }
      catch { settled = { status: "unknown", operationId: row.delivery!.operationId }; }
    }
    const receipt = this.storage.change(document => {
      const held = document.sessions[id].proposals[proposalId];
      // Another process may have recovered this receipt while the original
      // transport was still waiting. Durable evidence only moves forward.
      const stronger = held.status === "delivered" || held.status === "failed" || (held.status === "queued" && settled.status === "unknown");
      const conflicting = held.delivery!.operationId !== null && settled.operationId !== null && held.delivery!.operationId !== settled.operationId;
      if (!stronger && !conflicting) {
        held.delivery!.operationId ??= settled.operationId;
        held.status = settled.status;
      }
      return { delivery: held.delivery!, status: held.status ?? "unknown" };
    });
    if (receipt.status === "failed") this.emit(id, { type: "delegation.delivery.settled", delivery: receipt.delivery, status: "failed" });
    else this.emit(id, { type: "delegation.tool.result", callId: row.proposal.callId, proposalId,
      result: { status: receipt.status, delivery: receipt.delivery } });
  }
  async pollReceipts(id: string): Promise<void> {
    if (!this.paths.receipt) return;
    for (const row of Object.values(this.session(id).proposals)) {
      if (!row.delivery?.operationId || row.status === "delivered" || row.status === "failed") continue;
      const status = await this.paths.receipt(row.delivery);
      if (status === "pending") continue;
      this.storage.change(document => {
        const session = document.sessions[id];
        const held = session.proposals[row.proposal.proposalId];
        if (held.status === "delivered" || held.status === "failed") return;
        held.status = status;
        appendEvent(session, { type: "delegation.delivery.settled", delivery: held.delivery!, status }, this.now());
      });
    }
  }
  pollReplies(id: string): CompanionEvent[] {
    const session = this.session(id);
    const events: CompanionEvent[] = [];
    for (const row of Object.values(session.proposals)) {
      if (!row.delivery?.operationId || (row.status !== "queued" && row.status !== "delivered")) continue;
      for (const report of this.paths.reports(session.project)) {
        const status = reportStatus(report);
        if (report.correlatesDirective !== row.delivery.clientMessageId || !report.project || canonicalProject(report.project) !== canonicalProject(session.project)
          || report.origin?.kind !== "manager" || report.origin.conversationId !== row.delivery.recipient.conversationId
          || !status) continue;
        const fresh = this.storage.change(document => {
          const session = document.sessions[id];
          const held = session.proposals[row.proposal.proposalId];
          if (held.reports.includes(report.id)) return null;
          held.reports.push(report.id);
          // Persist correlation and its replay event in one atomic commit.
          return appendEvent(session, { type: "orchestrator.answer", delivery: held.delivery!, reportId: report.id,
            status, text: report.body.slice(0, 1_200) }, this.now());
        });
        if (fresh) events.push(fresh);
      }
    }
    return events;
  }
  retire(id: string): void {
    this.storage.change(document => {
      const session = document.sessions[id];
      if (!session) return;
      session.closed = true;
      for (const row of Object.values(session.proposals)) if (row.state === "pending") row.state = "cancelled";
    });
  }
}
