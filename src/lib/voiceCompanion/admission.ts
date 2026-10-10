import { randomUUID } from "node:crypto";
import type { BridgeReportV1 } from "@/lib/bridge/types";
import { canonicalProject } from "@/lib/projects/aliases";
import { reportHeaderName } from "@/lib/projects/settings";
import type { CompanionCommand, CompanionEvent, Delivery, Locale, Payload, Proposal, Recipient } from "./contract";
import { admitDelegationProposal, type OperatorInput } from "./gate";
import { liveProposalRefusal, waitingConfirmationWithdrawn, requestText, type EarlierRequest } from "./liveGate";
import { cleanStrings, withoutCredentials, withoutLocalPaths } from "./redaction";
import { DELEGATION_REASONS, deliveryFailureReason, type DelegationCode } from "./delegationOutcome";
import { CompanionTranscriptRecords, type TranscriptEntry } from "./transcriptRecord";
import { LIVE_VOICE } from "./sessionConfig";
import { CompanionStorage, type SessionStarter, type StoredProposal, type StoredSession } from "./storage";

export interface CompanionDeliveryPaths {
  recipient(project: string): Recipient | null;
  /** Existing orchestrator send path. It owns durable receipt idempotency. */
  send(binding: { sessionId: string; proposalId: string; delivery: Delivery; text: string; startedBy?: SessionStarter }): Promise<{ status: "delivered" | "queued" | "unknown" | "failed"; operationId: string | null; code?: string }>;
  reports(project: string): BridgeReportV1[];
  receipt?(delivery: Delivery): Promise<"delivered" | "failed" | "pending">;
}
/** One logical request: the same words from the same completed operator turn,
 * whatever Live delegation named it. Without a turn the delegation is all
 * there is to tell two requests apart. */
const sameRequest = (row: StoredProposal, sourceItemId: string, instruction: string, sourceTurn?: number, project?: string | null) =>
  requestText(row.proposal.instruction) === requestText(instruction)
  && (project === undefined || (project !== null && canonicalProject(row.proposal.recipient.project) === canonicalProject(project)))
  && (sourceTurn !== undefined && row.sourceTurn !== undefined ? row.sourceTurn === sourceTurn : row.proposal.sourceItemId === sourceItemId);
/** Every request the session holds but `except`, for the gate's look back. */
const earlierRequests = (session: StoredSession, except?: string, project?: string): EarlierRequest[] => Object.values(session.proposals)
  .filter(row => row.proposal.proposalId !== except && (project === undefined || canonicalProject(row.proposal.recipient.project) === canonicalProject(project))).map(row => ({ turn: row.sourceTurn, instruction: row.proposal.instruction }));
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

function appendEvent(session: StoredSession, payload: Payload, now: number, clean: (text: string) => string): CompanionEvent {
  const event = { ...cleanStrings(payload, clean), version: 1 as const, sessionId: session.id, generation: session.generation,
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
  return session && binding?.state === "admitted" && canonicalProject(binding.proposal.recipient.project) === canonicalProject(input.project) && binding.delivery
    && binding.delivery.clientMessageId === input.key && binding.delivery.recipient.conversationId === input.recipient
    && binding.text === input.text ? binding : null;
}

/** The server authority seam. Live may raise a delegation without a completed
 * transcript. An admitted delegation is sent at once; one the model asked to
 * confirm waits for the operator's spoken answer or tap. Prototype sessions
 * retain their completed-input policy for deterministic demo fixtures. */
export type DelegationOutcome =
  | { state: "awaiting"; proposal: Proposal }
  | { state: "sent"; status: "delivered" | "queued" | "unknown" | "failed"; failureCode?: string }
  | { state: "refused"; code: DelegationCode };
type Admit = { proposalId: string; decision: "send" | "cancel"; via: "auto" | "tap" | "speech"; sourceTurn?: number };
export class CompanionAdmission {
  private readonly records = new CompanionTranscriptRecords();
  private readonly sending = new Map<string, Promise<void>>();
  private readonly secrets = new Set<string>();
  constructor(readonly storage: CompanionStorage, private readonly paths: CompanionDeliveryPaths, private readonly now = Date.now) {}
  create(options: { project: string; locale: Locale; authority?: "live-model"; startedBy?: SessionStarter }): StoredSession {
    const session: StoredSession = { id: randomUUID(), project: canonicalProject(options.project), locale: options.locale, generation: 1,
      createdAt: this.now(), closed: false, inputs: [], proposals: {}, events: [], seq: 0,
      currentProject: canonicalProject(options.project), reportWatermarks: {}, spokenReports: [],
      ...(options.startedBy ? { startedBy: options.startedBy } : {}),
      ...(options.authority ? { authority: options.authority } : {}) };
    this.storage.change(document => {
      if (Object.values(document.sessions).filter(row => !row.closed).length >= 8) throw new Error("SESSION_LIMIT");
      this.baseline(session, session.project);
      document.sessions[session.id] = session;
    });
    this.records.begin(session, LIVE_VOICE, this.storage.read().sessions, this.now());
    return session;
  }
  private baseline(session: StoredSession, project: string): void {
    const canonical = canonicalProject(project);
    const marks = session.reportWatermarks ??= {};
    if (Object.keys(marks).some(key => canonicalProject(key) === canonical)) return;
    marks[canonical] = this.paths.reports(canonical).reduce((seq, report) => Math.max(seq, report.seq), 0);
  }
  setProject(id: string, project: string | null): void {
    if (project !== null && (!project.trim() || project.length > 200)) throw new Error("PROJECT_REFUSED");
    this.storage.change(document => {
      const session = document.sessions[id];
      if (!session || session.closed) throw new Error(session ? "SESSION_CLOSED" : "SESSION_UNAVAILABLE");
      session.currentProject = project === null ? null : canonicalProject(project);
      if (session.currentProject) this.baseline(session, session.currentProject);
    });
  }
  /** A credential in use that the key file and the environment do not hold. */
  protect(secret: string): void { if (secret.trim()) this.secrets.add(secret.trim()); }
  /** Transcripts, tool names and results, proposals and reports are supplied
   * by a provider, a model or an agent. All of them pass here before they are
   * stored or answered to the browser. */
  private cleaner(): (text: string) => string {
    const secrets = [...this.secrets, ...this.storage.credentials()];
    return text => withoutCredentials(text, secrets);
  }
  session(id: string) { return sessionIn(this.storage, id); }
  emit(id: string, payload: Payload): CompanionEvent {
    const clean = this.cleaner();
    return this.storage.change(document => {
      const session = document.sessions[id];
      if (!session) throw new Error("SESSION_UNAVAILABLE");
      return this.append(session, payload, this.now(), clean);
    });
  }
  /** Every persisted and served transcript string crosses this boundary. */
  record(id: string, entry: TranscriptEntry, settled = true): void {
    const clean = this.cleaner();
    this.records.put(id, cleanStrings(entry, text => withoutLocalPaths(clean(text))), settled);
  }
  transcriptRecord(id: string) { this.session(id); return this.records.read(id); }
  private append(session: StoredSession, payload: Payload, now: number, clean: (text: string) => string): CompanionEvent {
    const event = appendEvent(session, payload, now, clean);
    if (event.type === "session.closed") {
      session.endedAt = now;
      this.record(session.id, { id: "end", kind: "session_end", atMs: event.atMs,
        data: { reason: event.reason, seconds: session.usage?.seconds ?? 0, endedAt: now, incomplete: event.incomplete } });
      this.records.finish(session.id);
    } else if (event.type === "delegation.tool.called") {
      this.requestRecord(session.id, { id: `request-${event.callId}`, kind: "request", atMs: event.atMs,
        data: { callId: event.callId, delegationId: event.sourceItemId, instruction: event.instruction, status: "proposed" } });
    } else if (event.type === "delegation.sending" || event.type === "delegation.confirmation.required") {
      this.requestRecord(session.id, { id: `request-${event.proposal.callId}`, kind: "request", atMs: event.atMs,
        data: { ...event.proposal, status: event.type === "delegation.sending" ? "sending" : "awaiting_confirmation" } });
    } else if (event.type === "delegation.tool.result" || event.type === "delegation.delivery.settled") {
      const callId = event.type === "delegation.tool.result" ? event.callId : event.delivery.callId;
      const delivery = event.type === "delegation.tool.result" ? ("delivery" in event.result ? event.result.delivery : null) : event.delivery;
      const held = delivery ? session.proposals[delivery.proposalId] : null;
      if (delivery?.operationId && held?.delivery?.clientMessageId === delivery.clientMessageId && held.delivery.operationId === delivery.operationId)
        held.publishedReceipt = { clientMessageId: delivery.clientMessageId, operationId: delivery.operationId };
      const previous = this.records.read(session.id).entries.find(entry => entry.id === `request-${callId}`);
      this.requestRecord(session.id, { id: `request-${callId}`, kind: "request", atMs: previous?.atMs ?? event.atMs,
        data: { ...previous?.data, ...(event.type === "delegation.tool.result" ? event.result : { status: event.status, code: event.code, delivery: event.delivery }), updatedAtMs: event.atMs } });
    } else if (event.type === "orchestrator.answer" || event.type === "orchestrator.report") {
      this.record(session.id, { id: `report-${event.reportId}`, kind: "report", atMs: event.atMs,
        data: { status: event.status, text: event.text, ...(event.type === "orchestrator.answer" ? { delivery: event.delivery }
          : { at: event.at, project: event.project, projectName: reportHeaderName(event.project, session.locale) }) } });
    }
    return event;
  }
  private requestRecord(id: string, entry: TranscriptEntry): void {
    const previous = this.records.read(id).entries.find(row => row.id === entry.id);
    const code = entry.data.code as string | undefined;
    const reason = entry.data.status === "failed" ? deliveryFailureReason(code) : code ? DELEGATION_REASONS[code as DelegationCode] : undefined;
    const states = Array.isArray(previous?.data.states) ? previous.data.states : [];
    const atMs = typeof entry.data.updatedAtMs === "number" ? entry.data.updatedAtMs : entry.atMs;
    this.record(id, { ...entry, atMs: previous?.atMs ?? entry.atMs,
      data: { ...previous?.data, ...entry.data, ...(reason ? { reason } : {}), states: [...states, { atMs, status: entry.data.status, ...(code ? { code, reason } : {}) }] } });
  }
  events(id: string, after: number): CompanionEvent[] { return this.session(id).events.filter(event => event.seq > after); }
  /** Trusted transcript normalization only; the browser command API cannot
   * submit text. Live's finals mark display boundaries and grant no authority. */
  input(id: string, raw: OperatorInput, timing: { startMs?: number; endMs?: number } = {}): void {
    const input = cleanStrings(raw, this.cleaner());
    const cancelled = this.storage.change(document => {
      const session = document.sessions[id];
      if (!session || session.closed) throw new Error("SESSION_CLOSED");
      const previous = session.inputs.find(row => row.itemId === input.itemId);
      if (previous) Object.assign(previous, input);
      else session.inputs.push(input);
      session.inputs = session.inputs.slice(-64);
      const removed: StoredProposal[] = [];
      for (const row of Object.values(session.proposals)) {
        if (row.state === "pending" && this.now() > row.expiresAt) { row.state = "cancelled"; row.cancelCode = "confirmation_expired"; removed.push(row); }
        else if (row.state === "pending" && (session.authority === "live-model" ? waitingConfirmationWithdrawn(session.inputs, row.sourceTurn)
          : !admitDelegationProposal({ ...row.proposal, inputs: session.inputs, frozenSourceText: row.sourceText, waiting: true }).admit)) {
          row.state = "cancelled"; row.cancelCode = "source_changed"; removed.push(row);
        }
      }
      return removed;
    });
    this.emit(id, this.session(id).authority === "live-model" ? { type: "transcript.snapshot", speaker: "operator", itemId: input.itemId, text: input.text, final: input.final, ...timing }
      : input.final ? { type: "transcript.final", speaker: "operator", itemId: input.itemId, text: input.text }
      : { type: "input.speech.started", itemId: input.itemId });
    for (const row of cancelled) this.emit(id, { type: "delegation.tool.result", callId: row.proposal.callId, proposalId: row.proposal.proposalId,
      result: { status: "cancelled", code: row.cancelCode ?? "source_changed" } });
  }
  /** A confirmation nobody answered in time sends nothing and says so. */
  expire(id: string): Proposal[] {
    const expired = this.storage.change(document => Object.values(document.sessions[id]?.proposals ?? {}).filter(row => {
      if (row.state !== "pending" || this.now() <= row.expiresAt) return false;
      row.state = "cancelled"; row.cancelCode = "confirmation_expired";
      return true;
    }).map(row => row.proposal));
    for (const proposal of expired) this.emit(id, { type: "delegation.tool.result", callId: proposal.callId, proposalId: proposal.proposalId,
      result: { status: "cancelled", code: "confirmation_expired" } });
    return expired;
  }
  /** The delegation tool's whole effect. With no confirmation asked the request
   * is admitted and sent before this returns; a retry of the same call finds
   * its first outcome and never sends again. `confirmation` is the model's own
   * reason for asking first: nothing here reads the request to decide that. */
  async delegate(id: string, callId: string, sourceItemId: string, instruction: string, options: { sourceTurn?: number; confirmation?: string; renewed?: boolean; project?: string } = {}): Promise<DelegationOutcome> {
    const clean = this.cleaner();
    const logicalInstruction = clean(instruction).trim();
    const session = this.session(id);
    const project = options.project ?? (session.currentProject === undefined ? session.project : session.currentProject);
    const duplicate = Object.values(session.proposals).find(row => row.proposal.callId === clean(callId)
      || sameRequest(row, clean(sourceItemId), logicalInstruction, options.sourceTurn, project));
    if (duplicate) {
      // Recover older two-commit records when a caller retries after restart.
      if (duplicate.state === "pending" && !duplicate.proposal.confirmation) {
        await this.confirm(id, { proposalId: duplicate.proposal.proposalId, decision: "send", via: "auto" });
      } else if (duplicate.state === "admitted" && duplicate.status === "unknown") {
        await this.confirm(id, { proposalId: duplicate.proposal.proposalId, decision: "send", via: "auto" });
      }
      return this.outcome(id, duplicate.proposal.proposalId);
    }
    const proposal = this.propose(id, callId, sourceItemId, instruction, { ...options, autosend: !options.confirmation?.trim() });
    const row = Object.values(this.session(id).proposals).find(held => held.proposal.callId === clean(callId)
      || sameRequest(held, clean(sourceItemId), logicalInstruction, options.sourceTurn, project));
    if (!row) {
      const last = this.events(id, 0).at(-1);
      return { state: "refused", code: last?.type === "delegation.tool.result" && "code" in last.result ? last.result.code as DelegationCode : "not_admitted" };
    }
    if (proposal?.confirmation) return { state: "awaiting", proposal };
    if (row.state === "pending" || row.status === "unknown") await this.confirm(id, { proposalId: row.proposal.proposalId, decision: "send", via: "auto" });
    return this.outcome(id, row.proposal.proposalId);
  }
  /** Where a decided delegation stands. */
  outcome(id: string, proposalId: string): DelegationOutcome {
    const row = this.session(id).proposals[proposalId];
    if (!row || row.state === "cancelled") return { state: "refused", code: row?.cancelCode ?? "proposal_unavailable" };
    return row.state === "pending" ? { state: "awaiting", proposal: row.proposal } : { state: "sent", status: row.status ?? "unknown", ...(row.failureCode ? { failureCode: row.failureCode } : {}) };
  }
  /** The confirmation included in the backend round that received this answer. */
  awaiting(id: string, proposalId?: string | null): Proposal | null {
    const row = proposalId !== undefined ? (proposalId ? this.session(id).proposals[proposalId] : undefined)
      : Object.values(this.session(id).proposals).findLast(held => held.state === "pending" && !!held.proposal.confirmation);
    return row?.state === "pending" && !!row.proposal.confirmation && this.now() <= row.expiresAt ? row.proposal : null;
  }
  /** The confirmation asked last, whatever became of it: a spoken answer that finds none waiting reports this one. */
  lastAsked(id: string): Proposal | null {
    return Object.values(this.session(id).proposals).findLast(row => !!row.proposal.confirmation)?.proposal ?? null;
  }
  /** `sourceTurn` binds this model request to the operator's Live turn. */
  propose(id: string, rawCallId: string, rawSourceItemId: string, rawInstruction: string, options: { sourceTurn?: number; confirmation?: string; autosend?: boolean; renewed?: boolean; project?: string } = {}): Proposal | null {
    const { sourceTurn } = options;
    const [callId, sourceItemId, instruction, asked] = [rawCallId, rawSourceItemId, rawInstruction, options.confirmation?.trim().slice(0, 240) ?? ""].map(this.cleaner());
    const existing = Object.values(this.session(id).proposals).find(row => row.proposal.callId === callId);
    if (existing) return existing.state === "pending" ? existing.proposal : null;
    let refusal: DelegationCode = "not_admitted";
    let reusedLogicalRequest = false;
    const proposal = this.storage.change(document => {
      const session = document.sessions[id];
      if (!session || session.closed) { refusal = "session_closed"; return null; }
      const project = options.project ?? (session.currentProject === undefined ? session.project : session.currentProject);
      if (!project?.trim() || project.length > 200) { refusal = "no_orchestrator"; return null; }
      const logicalDuplicate = Object.values(session.proposals).find(row => sameRequest(row, sourceItemId, instruction, sourceTurn, project));
      if (logicalDuplicate) { reusedLogicalRequest = true; return logicalDuplicate.proposal; }
      const reason = session.authority === "live-model" ? liveProposalRefusal(instruction, session.inputs, sourceTurn, earlierRequests(session, undefined, project), options.renewed)
        : (() => { const gate = admitDelegationProposal({ sourceItemId, instruction, inputs: session.inputs }); return gate.admit ? null : gate.reason; })();
      if (reason) { refusal = reason; return null; }
      const recipient = this.paths.recipient(project);
      if (!recipient) { refusal = "no_orchestrator"; return null; }
      this.baseline(session, recipient.project);
      if (Object.values(session.proposals).some(row => row.state === "pending" && row.proposal.sourceItemId === sourceItemId)) { refusal = "duplicate_proposal"; return null; }
      const proposal: Proposal = { proposalId: randomUUID(), callId, sourceItemId, instruction: instruction.trim(), recipient,
        ...(session.authority ? { authority: session.authority } : {}), ...(asked ? { confirmation: { reason: asked } } : {}) };
      const row: StoredProposal = { proposal, sourceText: session.inputs.at(-1)?.text ?? "", expiresAt: this.now() + 120_000,
        state: options.autosend && !asked ? "admitted" : "pending", reports: [], ...(sourceTurn !== undefined ? { sourceTurn } : {}), ...(options.renewed ? { renewed: true } : {}) };
      if (options.autosend && !asked) {
        // Commit the proposal, admission decision and retry identity together.
        row.via = "auto";
        row.status = "unknown";
        row.delivery = { proposalId: proposal.proposalId, callId: proposal.callId,
          clientMessageId: `voice-${randomUUID()}`, operationId: null, recipient: proposal.recipient };
        row.text = `${proposal.instruction}\n\n[Voice Delegatus reply: report progress or the result using bridge_report with correlatesDirective equal to ${row.delivery.clientMessageId}. Keep the report tied to this request.]`;
      }
      session.proposals[proposal.proposalId] = row;
      // The projection's first card event shares the admission commit. A
      // restart can therefore replay the admitted delivery even if the
      // process stops before it emits the later sending/result events.
      this.append(session, { type: "delegation.tool.called", callId, sourceItemId, instruction: instruction.slice(0, 2_000) }, this.now(), this.cleaner());
      if (proposal.confirmation) this.append(session, { type: "delegation.confirmation.required", proposal }, this.now(), this.cleaner());
      return proposal;
    });
    if (reusedLogicalRequest) return proposal;
    // Failed admission has no proposal commit to carry its card event.
    if (!proposal) {
      this.emit(id, { type: "delegation.tool.called", callId, sourceItemId, instruction: instruction.slice(0, 2_000) });
      this.emit(id, { type: "delegation.tool.result", callId, result: { status: "refused", code: refusal } });
    }
    return proposal;
  }
  /** Admits or declines one delegation. The page can only tap; the spoken
   * answer arrives through the model's tool, and "auto" from `delegate`. */
  async confirm(id: string, command: Extract<CompanionCommand, { type: "confirmation" }> | Admit): Promise<DelegationOutcome | void> {
    const refused: { code: DelegationCode } = { code: "proposal_unavailable" };
    const binding = this.storage.change(document => {
      const session = document.sessions[id];
      const row = session?.proposals[command.proposalId];
      if (!row || row.state === "cancelled") return null;
      // Recovery remains available after closure/restart. A retry recovers its
      // original key and target; it cannot admit new work to the current seat.
      if (row.state === "admitted") return row;
      if (command.decision === "cancel") { row.state = "cancelled"; row.cancelCode = refused.code = "operator_cancelled"; return null; }
      const allowed = session.authority === "live-model" ? liveProposalRefusal(row.proposal.instruction, session.inputs, row.sourceTurn, earlierRequests(session, row.proposal.proposalId, row.proposal.recipient.project), row.renewed) === null
        : admitDelegationProposal({ ...row.proposal, inputs: session.inputs, frozenSourceText: row.sourceText, waiting: true }).admit;
      if (session.authority === "live-model" && command.via === "speech" && row.sourceTurn !== undefined
        && (("sourceTurn" in command ? command.sourceTurn : undefined) ?? session.inputs.at(-1)?.turn ?? row.sourceTurn) <= row.sourceTurn) { refused.code = "not_confirmed"; return null; }
      if (session.closed || this.now() > row.expiresAt || !allowed) {
        row.state = "cancelled"; row.cancelCode = refused.code = "proposal_changed"; return null;
      }
      const recipient = this.paths.recipient(row.proposal.recipient.project);
      if (!recipient) { row.state = "cancelled"; row.cancelCode = refused.code = "no_orchestrator"; return null; }
      if (!sameRecipient(recipient, row.proposal.recipient)) {
        row.proposal.recipient = recipient;
        this.append(session, { type: "delegation.retargeted", proposalId: row.proposal.proposalId, recipient }, this.now(), this.cleaner());
      }
      row.state = "admitted";
      row.via = command.via;
      // The outcome is unknown until the send path answers. Recorded with the
      // key in one commit, so a restart in between recovers this very send.
      row.status = "unknown";
      row.delivery = { proposalId: row.proposal.proposalId, callId: row.proposal.callId,
        clientMessageId: `voice-${randomUUID()}`, operationId: null, recipient: row.proposal.recipient };
      row.text = `${row.proposal.instruction}\n\n[Voice Delegatus reply: report progress or the result using bridge_report with correlatesDirective equal to ${row.delivery.clientMessageId}. Keep the report tied to this request.]`;
      return row;
    });
    if (!binding) {
      if (refused.code === "not_confirmed") return { state: "refused", code: refused.code };
      const row = this.session(id).proposals[command.proposalId];
      if (row) this.emit(id, { type: "delegation.tool.result", callId: row.proposal.callId, proposalId: command.proposalId,
        result: { status: "cancelled", code: row.cancelCode ?? refused.code } });
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
    // A request nobody was asked about announces its own send; a confirmed one names how it was answered.
    this.emit(id, row.proposal.confirmation ? { type: "delegation.confirmed", proposalId, via: row.via === "speech" ? "speech" : "tap" }
      : { type: "delegation.sending", proposal: row.proposal });
    let settled: { status: "delivered" | "queued" | "unknown" | "failed"; operationId: string | null; code?: string } = { status: row.status ?? "unknown", operationId: row.delivery!.operationId };
    if (!row.status || row.status === "unknown") {
      try { settled = await this.paths.send({ sessionId: id, proposalId, delivery: row.delivery!, text: row.text!, startedBy: this.session(id).startedBy }); }
      catch { settled = { status: "unknown", operationId: row.delivery!.operationId }; }
    }
    if (settled.status === "failed" && settled.code === "voice_seat_changed" && settled.operationId === null && row.delivery!.operationId === null) {
      const retry = this.storage.change(document => {
        const session = document.sessions[id];
        const held = session.proposals[proposalId];
        if (held.delivery!.clientMessageId !== row.delivery!.clientMessageId || held.delivery!.operationId !== null
          || held.status !== "unknown" || (held.retargetCount ?? 0) >= 1) return null;
        const recipient = this.paths.recipient(held.proposal.recipient.project);
        if (!recipient) { settled.code = "no_orchestrator"; return null; }
        if (sameRecipient(recipient, held.proposal.recipient)) return null;
        held.retargetCount = (held.retargetCount ?? 0) + 1;
        held.proposal.recipient = recipient;
        held.delivery = { ...held.delivery!, recipient, clientMessageId: `voice-${randomUUID()}`, operationId: null };
        held.text = `${held.proposal.instruction}\n\n[Voice Delegatus reply: report progress or the result using bridge_report with correlatesDirective equal to ${held.delivery.clientMessageId}. Keep the report tied to this request.]`;
        delete held.failureCode;
        this.append(session, { type: "delegation.retargeted", proposalId, recipient }, this.now(), this.cleaner());
        return held;
      });
      if (retry) return this.deliver(id, retry);
    }
    const receipt = this.storage.change(document => {
      const held = document.sessions[id].proposals[proposalId];
      // Another process may have recovered this receipt while the original
      // transport was still waiting. Durable evidence only moves forward.
      const stronger = held.status === "delivered" || held.status === "failed" || (held.status === "queued" && settled.status === "unknown");
      const conflicting = held.delivery!.operationId !== null && settled.operationId !== null && held.delivery!.operationId !== settled.operationId;
      if (!stronger && !conflicting && held.delivery!.clientMessageId === row.delivery!.clientMessageId) {
        held.delivery!.operationId ??= settled.operationId;
        held.status = settled.status;
        if (settled.code) held.failureCode = this.cleaner()(withoutLocalPaths(settled.code)).slice(0, 120);
      }
      return { delivery: held.delivery!, status: held.status ?? "unknown", failureCode: held.failureCode };
    });
    if (receipt.status === "failed") this.emit(id, { type: "delegation.delivery.settled", delivery: receipt.delivery, status: "failed", code: receipt.failureCode });
    else this.emit(id, { type: "delegation.tool.result", callId: row.proposal.callId, proposalId,
      result: { status: receipt.status, delivery: receipt.delivery } });
  }
  async pollReceipts(id: string): Promise<void> {
    if (!this.paths.receipt) return;
    for (const row of Object.values(this.session(id).proposals)) {
      if (!row.delivery?.operationId || row.status === "delivered" || row.status === "failed") continue;
      const status = await this.paths.receipt(row.delivery);
      if (status === "pending") continue;
      const clean = this.cleaner();
      this.storage.change(document => {
        const session = document.sessions[id];
        const held = session.proposals[row.proposal.proposalId];
        if (held.status === "delivered" || held.status === "failed") return;
        held.status = status;
        this.append(session, { type: "delegation.delivery.settled", delivery: held.delivery!, status }, this.now(), clean);
      });
    }
  }
  private hasPublishedReceipt(session: StoredSession, row: StoredProposal): boolean {
    if (!row.delivery?.operationId) return false;
    const matches = (delivery: Delivery | undefined) => delivery?.clientMessageId === row.delivery!.clientMessageId
      && delivery.operationId === row.delivery!.operationId;
    if (!row.publishedReceipt) {
      // Base-version sessions retain publication in the event ring or request
      // journal. Recover only the same operation, never an uncertain send.
      const retained = session.events.some(event => event.type === "delegation.tool.result" ? "delivery" in event.result && matches(event.result.delivery)
        : event.type === "delegation.delivery.settled" && matches(event.delivery));
      const request = retained ? undefined : this.records.read(session.id).entries.find(entry => entry.id === `request-${row.proposal.callId}`);
      if (retained || matches(request?.data.delivery as Delivery | undefined))
        row.publishedReceipt = { clientMessageId: row.delivery.clientMessageId, operationId: row.delivery.operationId };
    }
    return row.publishedReceipt?.clientMessageId === row.delivery.clientMessageId && row.publishedReceipt.operationId === row.delivery.operationId;
  }
  pollReports(id: string): CompanionEvent[] {
    const clean = this.cleaner();
    return this.storage.change(document => {
      const session = document.sessions[id];
      if (!session) throw new Error("SESSION_UNAVAILABLE");
      const projects = new Set<string>();
      const current = session.currentProject === undefined ? session.project : session.currentProject;
      if (current) projects.add(canonicalProject(current));
      for (const row of Object.values(session.proposals)) if (row.state === "admitted" && row.status !== "failed") projects.add(canonicalProject(row.proposal.recipient.project));
      const reports: BridgeReportV1[] = [];
      const legacy = session.reportWatermarks === undefined;
      const baselines = new Map<string, number>();
      const rowFor = (report: BridgeReportV1) => Object.values(session.proposals).find(held => held.state === "admitted" && held.delivery && held.status !== "failed"
        && canonicalProject(held.proposal.recipient.project) === canonicalProject(report.project!)
        && held.delivery.clientMessageId === report.correlatesDirective);
      const marks = session.reportWatermarks ??= {};
      for (const project of projects) {
        // Alias succession retains the highest watermark already recorded.
        const keys = Object.keys(marks).filter(key => canonicalProject(key) === project);
        if (!keys.length) {
          const existing = this.paths.reports(project).filter(report => report.project && canonicalProject(report.project) === project);
          const baseline = existing.reduce((seq, report) => Math.max(seq, report.seq), 0);
          marks[project] = legacy ? 0 : baseline;
          if (legacy) {
            baselines.set(project, baseline);
            reports.push(...existing.filter(report => {
              const row = rowFor(report);
              return row && !row.reports.includes(report.id) && this.hasPublishedReceipt(session, row);
            }));
          }
          continue;
        }
        const after = Math.max(...keys.map(key => marks[key]));
        marks[project] = after;
        reports.push(...this.paths.reports(project).filter(report => report.project
          && canonicalProject(report.project) === project && report.seq > after));
      }
      const events: CompanionEvent[] = [];
      const spoken = session.spokenReports ??= [];
      for (const report of reports.sort((a, b) => a.seq - b.seq)) {
        const project = canonicalProject(report.project!);
        if (report.seq <= marks[project]) continue;
        // Advance even past rows that are not spoken. The bounded id ring is
        // a second guard; the durable sequence is what prevents old replay.
        marks[project] = report.seq;
        const status = reportStatus(report);
        if (report.synthetic || report.origin?.kind !== "manager" || !status || spoken.includes(report.id)) continue;
        spoken.push(report.id);
        const text = withoutLocalPaths(clean(report.body)).slice(0, 1_200).replace(/[\uD800-\uDBFF]$/u, "");
        const row = rowFor(report);
        if (row) row.reports.push(report.id);
        // A card can join only a receipt already published to the client. A
        // report arriving during a send or after a lost transport reply still
        // gets its own visible card, without inventing an operation identity.
        const published = row && this.hasPublishedReceipt(session, row);
        if (row && published) {
          events.push(this.append(session, { type: "orchestrator.answer", delivery: row.delivery!, reportId: report.id, status, text }, this.now(), clean));
        } else {
          const at = Date.parse(report.at);
          events.push(this.append(session, { type: "orchestrator.report", reportId: report.id, status, text,
            at: Number.isFinite(at) ? at : this.now(), project }, this.now(), clean));
        }
      }
      // Migration recovers pending correlated replies before fencing off old
      // unrelated reports. First visits in current calls only set a baseline.
      for (const [project, seq] of baselines) marks[project] = Math.max(marks[project], seq);
      session.spokenReports = spoken.slice(-256);
      return events;
    });
  }
  /** Compatibility for callers that still consume only correlated answers. */
  pollReplies(id: string): CompanionEvent[] { return this.pollReports(id).filter(event => event.type === "orchestrator.answer"); }
  retire(id: string): void {
    this.storage.change(document => {
      const session = document.sessions[id];
      if (!session) return;
      session.closed = true;
      for (const row of Object.values(session.proposals)) if (row.state === "pending") { row.state = "cancelled"; row.cancelCode = "session_closed"; }
    });
  }
}
