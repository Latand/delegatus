import { randomUUID } from "node:crypto";
import type { BridgeReportV1 } from "@/lib/bridge/types";
import { canonicalProject } from "@/lib/projects/aliases";
import { reportHeaderName } from "@/lib/projects/settings";
import type { CompanionCommand, CompanionEvent, Delivery, Locale, Payload, Proposal, Recipient } from "./contract";
import { admitDelegationProposal, type OperatorInput } from "./gate";
import { askGist, VOICE_ASK_ENVELOPE_CHARS, liveProposalRefusal, waitingConfirmationWithdrawn, requestText, type EarlierRequest } from "./liveGate";
import { cleanStrings, withoutCredentials, withoutLocalPaths } from "./redaction";
import { DELEGATION_REASONS, deliveryFailureReason, type DelegationCode } from "./delegationOutcome";
import { CompanionTranscriptRecords, type TranscriptEntry } from "./transcriptRecord";
import { LIVE_VOICE } from "./sessionConfig";
import { CompanionStorage, type ReportSpeech, type SessionStarter, type StoredProposal, type StoredSession } from "./storage";
import { voiceReportText } from "./reportSpeech";

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
  && sameAttempt(row, sourceItemId, sourceTurn);
/** One operator attempt: the same completed operator turn or, when either side
 * has no transcribed turn, the same Live delegation. */
const sameAttempt = (row: StoredProposal, sourceItemId: string, sourceTurn?: number) =>
  sourceTurn !== undefined && row.sourceTurn !== undefined ? row.sourceTurn === sourceTurn : row.proposal.sourceItemId === sourceItemId;
/** One operator attempt: its transcribed turn, if any, and the Live delegation that raised it. */
export interface OperatorAttempt { sourceTurn?: number; sourceItemId: string }
/** The request a renewal sends once more, followed back to the first send. */
const lineageRoot = (session: StoredSession, row: StoredProposal) => {
  let root = row;
  for (let depth = 0; root.renews && session.proposals[root.renews] && depth < 64; depth += 1) root = session.proposals[root.renews]!;
  return root.proposal.proposalId;
};
/** Every request the session holds but `except`, for the gate's look back. */
const earlierRequests = (session: StoredSession, except?: string, project?: string): EarlierRequest[] => Object.values(session.proposals)
  .filter(row => row.proposal.proposalId !== except && (project === undefined || canonicalProject(row.proposal.recipient.project) === canonicalProject(project))).map(row => ({ turn: row.sourceTurn, instruction: row.proposal.instruction }));
/** How long a raised confirmation waits for the operator's answer. */
const CONFIRMATION_MS = 120_000;
/** A request the orchestrator received or may still receive, whose answering report has not arrived. */
const awaitingReport = (row: StoredProposal) => row.state === "admitted" && !!row.delivery && row.status !== "failed" && !row.answered;
/** Short handles the backend names this call's requests by, in the order they were raised. */
const requestHandles = (session: StoredSession) => new Map(Object.keys(session.proposals).map((id, index) => [id, `r${index + 1}`]));
export interface CallRequest { handle: string; proposalId: string; project: string; instruction: string; sentMinutesAgo: number; progressReports: number;
  /** The orchestrator asked back or named a blocker about this request, and has not answered it. */
  askedBack: boolean }
const callRequest = (session: StoredSession, row: StoredProposal, now: number): CallRequest => ({ handle: requestHandles(session).get(row.proposal.proposalId)!,
  proposalId: row.proposal.proposalId, project: canonicalProject(row.proposal.recipient.project), instruction: row.proposal.instruction,
  sentMinutesAgo: Math.max(0, Math.floor((now - row.expiresAt + CONFIRMATION_MS) / 60_000)), progressReports: row.reports.filter(id => id !== row.answered).length,
  askedBack: !row.answered && !!row.askedBack });
/** What a request carries to the orchestrator: the operator's ask and how to report back on it. */
const directiveText = (instruction: string, key: string) => `${instruction}\n\n[Voice Delegatus wrote this request from the operator's speech; a last line naming the operator quotes them word for word. Reply: report progress or the result using bridge_report with correlatesDirective equal to ${key}. Set answersDirective true on the report that answers this request in full, and false on progress, a partial answer or a question back. Keep the report tied to this request.]`;
/** The text of a report this session relayed, by its id. */
const reportText = (session: StoredSession, reportId: string | undefined) => {
  const event = reportId ? session.events.find(row => (row.type === "orchestrator.answer" || row.type === "orchestrator.report") && row.reportId === reportId) : undefined;
  return event?.type === "orchestrator.answer" || event?.type === "orchestrator.report" ? { status: event.status, text: event.text } : null;
};
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
/** Whether a correlated report answers its request. The seat says so with
 * answersDirective; without it, a result or a failure answers, while progress,
 * a question back and a blocker leave the request waiting. */
const answersRequest = (report: BridgeReportV1) => report.answersDirective ?? (report.class === "completed" || report.class === "review_verdict" || report.class === "failed");
/** Reports owed to the voice that one scan fills the queue up to; it scans on only after the voice has taken some. */
const REPORT_SPEECH_CAPACITY = 64;
/** Only an open Live call has a voice to owe reports to; prototype sessions read them from their events. */
const owesSpeech = (session: StoredSession) => !session.closed && session.authority === "live-model";

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
  /** Nothing sent: the orchestrator already has this ask and its report has not arrived. */
  | { state: "awaiting_report"; request: CallRequest; report: { status: string; text: string } | null }
  /** Nothing sent: the orchestrator already answered this ask. */
  | { state: "answered"; request: CallRequest; report: { status: string; text: string } | null }
  | { state: "sent"; status: "delivered" | "queued" | "unknown" | "failed"; failureCode?: string }
  | { state: "refused"; code: DelegationCode };
type Admit = { proposalId: string; decision: "send" | "cancel"; via: "auto" | "tap" | "speech"; sourceTurn?: number };
export class CompanionAdmission {
  readonly records = new CompanionTranscriptRecords();
  private readonly sending = new Map<string, Promise<void>>();
  private readonly secrets = new Set<string>();
  /** Requests awaiting a report that the backend was shown, per session and delegation. */
  private readonly shown = new Map<string, Set<string>>();
  /** Reports a backend delegation already asked to hear again, per session and delegation. */
  private readonly reread = new Map<string, Set<string>>();
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
   * reason for asking first: nothing here reads the request to decide that.
   * `attempt` is the operator attempt an explicit ask again belongs to, when it
   * is later than the turn the backend delegation was raised for: a backing
   * turn that later operator words were steered into keeps its own source turn. */
  async delegate(id: string, callId: string, rawSourceItemId: string, instruction: string, options: { sourceTurn?: number; confirmation?: string; renewed?: boolean; project?: string; pendingRequest?: string; attempt?: OperatorAttempt } = {}): Promise<DelegationOutcome> {
    const clean = this.cleaner();
    const logicalInstruction = clean(instruction).trim();
    const session = this.session(id);
    const project = options.project ?? (session.currentProject === undefined ? session.project : session.currentProject);
    const { attempt, ...rest } = options;
    const [sourceItemId, sourceTurn] = options.renewed && attempt ? [attempt.sourceItemId, attempt.sourceTurn] : [rawSourceItemId, options.sourceTurn];
    const duplicate = Object.values(session.proposals).find(row => row.proposal.callId === clean(callId)
      || sameRequest(row, clean(sourceItemId), logicalInstruction, sourceTurn, project));
    if (duplicate) {
      // Recover older two-commit records when a caller retries after restart.
      if (duplicate.state === "pending" && !duplicate.proposal.confirmation) {
        await this.confirm(id, { proposalId: duplicate.proposal.proposalId, decision: "send", via: "auto" });
      } else if (duplicate.state === "admitted" && duplicate.status === "unknown") {
        await this.confirm(id, { proposalId: duplicate.proposal.proposalId, decision: "send", via: "auto" });
      }
      return this.outcome(id, duplicate.proposal.proposalId);
    }
    // An ask the orchestrator already has is not sent again while its report
    // is on the way: the backend names it, or it repeats one in the same words.
    // A handle names a request to the project this ask goes to, never another.
    const sameWords = Object.values(session.proposals).filter(row => requestText(row.proposal.instruction) === requestText(logicalInstruction)
      && !!project && canonicalProject(row.proposal.recipient.project) === canonicalProject(project));
    const held = options.pendingRequest !== undefined
      ? Object.values(session.proposals).find(row => requestHandles(session).get(row.proposal.proposalId) === options.pendingRequest)
      : sameWords.find(awaitingReport) ?? sameWords.findLast(row => !!row.answered);
    if (held && options.pendingRequest !== undefined && project && canonicalProject(held.proposal.recipient.project) !== canonicalProject(project))
      return { state: "refused", code: "request_other_project" };
    if (held && !options.renewed && awaitingReport(held))
      return { state: "awaiting_report", request: callRequest(session, held, this.now()), report: reportText(session, held.askedBack ?? held.reports.at(-1)) };
    if (held?.answered && !options.renewed) return { state: "answered", request: callRequest(session, held, this.now()), report: reportText(session, held.answered) };
    if (options.pendingRequest !== undefined && !options.renewed) return { state: "refused", code: "request_not_waiting" };
    // The operator explicitly asked to send it once more: it goes again under its
    // own delivery key, once per operator attempt whatever the model's wording or
    // which handle of the request it names, the original or a renewal.
    const renews = held && options.renewed && (awaitingReport(held) || held.answered) ? lineageRoot(session, held) : undefined;
    const resent = renews ? Object.values(session.proposals).find(row => lineageRoot(session, row) === renews
      && sameAttempt(row, clean(sourceItemId), sourceTurn)) : undefined;
    if (resent) return this.outcome(id, resent.proposal.proposalId);
    const proposal = this.propose(id, callId, sourceItemId, instruction, { ...rest, sourceTurn, autosend: !options.confirmation?.trim(), ...(renews ? { renews } : {}) });
    const row = Object.values(this.session(id).proposals).find(held => held.proposal.callId === clean(callId)
      || sameRequest(held, clean(sourceItemId), logicalInstruction, sourceTurn, project));
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
  /** This call's requests whose answering report has not arrived, oldest first. */
  awaitingReports(id: string): CallRequest[] {
    const session = this.session(id);
    return Object.values(session.proposals).filter(awaitingReport).map(row => callRequest(session, row, this.now()));
  }
  /** Records that one backend delegation knows these waiting requests: it was shown them, or sent them itself. */
  showAwaiting(id: string, delegationId: string, proposalIds: readonly string[]): void {
    const key = `${id}\0${delegationId}`;
    const seen = this.shown.get(key) ?? new Set<string>();
    for (const proposalId of proposalIds) seen.add(proposalId);
    this.shown.delete(key); this.shown.set(key, seen);
    while (this.shown.size > 1_024) this.shown.delete(this.shown.keys().next().value!);
  }
  /** Waiting requests to the project this delegation has not been shown yet. */
  unseenAwaiting(id: string, delegationId: string, project: string): CallRequest[] {
    const seen = this.shown.get(`${id}\0${delegationId}`);
    return this.awaitingReports(id).filter(request => request.project === canonicalProject(project) && !seen?.has(request.proposalId));
  }
  /** What this call asked the orchestrator and what came back, for the backend's read. */
  callReports(id: string): { requests: Array<Record<string, unknown>>; reports: Array<Record<string, unknown>>; more: number } {
    const session = this.session(id);
    const handles = requestHandles(session);
    const minutes = (atMs: number) => Math.max(0, Math.floor((this.now() - atMs) / 60_000));
    const label = (project: string) => withoutLocalPaths(reportHeaderName(project, session.locale));
    const reported = session.events.flatMap(event => event.type === "orchestrator.answer" || event.type === "orchestrator.report" ? [event] : []);
    const reportHandles = new Map(this.relayedReports(id).map(row => [row.reportId, row.handle]));
    const handled = (reportId: string) => reportHandles.has(reportId) ? { report: reportHandles.get(reportId) } : {};
    const requests = Object.values(session.proposals).filter(row => row.state === "admitted" && row.delivery).map(row => {
      const request = callRequest(session, row, this.now());
      const answer = row.answered ? reported.find(event => event.reportId === row.answered) : undefined;
      const asked = !answer && row.askedBack ? reported.find(event => event.reportId === row.askedBack) : undefined;
      return { request: request.handle, project: label(request.project), ask: askGist(request.instruction), sentMinutesAgo: request.sentMinutesAgo,
        state: row.status === "failed" ? "delivery_failed" : row.answered ? "answered" : asked ? "orchestrator_asked_back" : "waiting_for_report", progressReports: request.progressReports,
        ...(answer ? { answer: { status: answer.status, text: answer.text, ...handled(answer.reportId) } } : {}),
        ...(asked ? { askedBack: { status: asked.status, text: asked.text, ...handled(asked.reportId) } } : {}) };
    });
    // Answers and questions back travel with their requests; the latest other reports follow, whole, within a bound.
    const answering = new Set(Object.values(session.proposals).flatMap(row => [row.answered, row.answered ? undefined : row.askedBack]).filter(Boolean));
    const reports: Array<Record<string, unknown>> = [];
    let size = JSON.stringify(requests).length;
    const others = reported.filter(event => !answering.has(event.reportId)).reverse();
    for (const event of others) {
      const row = event.type === "orchestrator.answer" ? session.proposals[event.delivery.proposalId] : undefined;
      const report = { ...handled(event.reportId), status: event.status, project: label(event.type === "orchestrator.answer" ? event.delivery.recipient.project : event.project),
        minutesAgo: minutes(session.createdAt + event.atMs), text: event.text, ...(row ? { about: handles.get(row.proposal.proposalId) } : {}) };
      size += JSON.stringify(report).length;
      if (reports.length >= 5 || size > 12_000) break;
      reports.unshift(report);
    }
    return { requests, reports, more: others.length - reports.length };
  }
  /** `sourceTurn` binds this model request to the operator's Live turn. */
  propose(id: string, rawCallId: string, rawSourceItemId: string, rawInstruction: string, options: { sourceTurn?: number; confirmation?: string; autosend?: boolean; renewed?: boolean; project?: string; renews?: string } = {}): Proposal | null {
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
      const row: StoredProposal = { proposal, sourceText: session.inputs.at(-1)?.text ?? "", expiresAt: this.now() + CONFIRMATION_MS,
        state: options.autosend && !asked ? "admitted" : "pending", reports: [], ...(sourceTurn !== undefined ? { sourceTurn } : {}), ...(options.renewed ? { renewed: true } : {}),
        ...(options.renews ? { renews: options.renews } : {}) };
      if (options.autosend && !asked) {
        // Commit the proposal, admission decision and retry identity together.
        row.via = "auto";
        row.status = "unknown";
        row.delivery = { proposalId: proposal.proposalId, callId: proposal.callId,
          clientMessageId: `voice-${randomUUID()}`, operationId: null, recipient: proposal.recipient };
        row.text = directiveText(proposal.instruction, row.delivery.clientMessageId);
      }
      session.proposals[proposal.proposalId] = row;
      // The projection's first card event shares the admission commit. A
      // restart can therefore replay the admitted delivery even if the
      // process stops before it emits the later sending/result events.
      this.append(session, { type: "delegation.tool.called", callId, sourceItemId, instruction: [...instruction].slice(0, VOICE_ASK_ENVELOPE_CHARS).join("") }, this.now(), this.cleaner());
      if (proposal.confirmation) this.append(session, { type: "delegation.confirmation.required", proposal }, this.now(), this.cleaner());
      return proposal;
    });
    if (reusedLogicalRequest) return proposal;
    // Failed admission has no proposal commit to carry its card event.
    if (!proposal) {
      this.emit(id, { type: "delegation.tool.called", callId, sourceItemId, instruction: [...instruction].slice(0, VOICE_ASK_ENVELOPE_CHARS).join("") });
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
      row.text = directiveText(row.proposal.instruction, row.delivery.clientMessageId);
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
        held.text = directiveText(held.proposal.instruction, held.delivery.clientMessageId);
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
        // A full speech queue stops the scan before the next report, so nothing
        // owed is ever dropped: the rest stay past the watermark for a later poll,
        // once the voice has taken what waits. Migration recovery is bounded by its requests.
        if (!legacy && owesSpeech(session) && (session.reportSpeech?.length ?? 0) >= REPORT_SPEECH_CAPACITY) break;
        // Advance even past rows that are not spoken. The bounded id ring is
        // a second guard; the durable sequence is what prevents old replay.
        marks[project] = report.seq;
        const status = reportStatus(report);
        if (report.synthetic || report.origin?.kind !== "manager" || !status || spoken.includes(report.id)) continue;
        spoken.push(report.id);
        // The whole report: the voice relays every item the seat filed.
        const text = withoutLocalPaths(clean(voiceReportText(report)));
        const row = rowFor(report);
        if (row) row.reports.push(report.id);
        // Only a report that answers closes its request; progress, a question back and a blocker leave it waiting.
        if (row && !row.answered) {
          if (answersRequest(report)) { row.answered = report.id; delete row.askedBack; }
          else if (status === "question" || status === "blocked") row.askedBack = report.id;
        }
        // Owed to the voice in the same commit that moves the scan past it.
        if (owesSpeech(session)) (session.reportSpeech ??= []).push({ reportId: report.id, project, status, text, handed: 0 });
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
  /** Owes the voice a report this call relayed, once more, whole: it is read from
   * the report text through the same parts as a new report, never retold by a
   * model. `report` is a report handle, a request handle (its answer, else its
   * latest report) or null for the latest report of the call. */
  rereadReport(id: string, report: string | null, delegationId?: string): { status: "reading" | "already_owed"; report: string } | { status: "not_found" } {
    const relayed = this.relayedReports(id);
    const asked = delegationId === undefined ? undefined : `${id}\0${delegationId}`;
    return this.storage.change(document => {
      const session = document.sessions[id];
      if (!session || session.closed) return { status: "not_found" as const };
      const request = report === null ? undefined : Object.values(session.proposals).find(row => requestHandles(session).get(row.proposal.proposalId) === report);
      const reportId = request ? request.answered ?? request.askedBack ?? request.reports.at(-1) : undefined;
      const found = report === null ? relayed.at(-1) : relayed.find(row => request ? row.reportId === reportId : row.handle === report);
      if (!found) return { status: "not_found" as const };
      const queue = session.reportSpeech ??= [];
      // Once per delegation: a model asking twice in one answer hears it once.
      if (queue.some(row => row.reportId === found.reportId) || (asked && this.reread.get(asked)?.has(found.reportId))) return { status: "already_owed" as const, report: found.handle };
      if (asked) {
        this.reread.set(asked, new Set([...this.reread.get(asked) ?? [], found.reportId]));
        while (this.reread.size > 1_024) this.reread.delete(this.reread.keys().next().value!);
      }
      queue.push({ reportId: found.reportId, project: found.project, status: found.status, text: found.text, handed: 0, reread: true });
      return { status: "reading" as const, report: found.handle };
    });
  }
  /** Every report this call relayed, in order, each with its handle. The
   * transcript keeps them all; the bounded event ring covers a record that
   * reached the transcript's size limit. */
  private relayedReports(id: string): Array<{ handle: string; reportId: string; status: string; text: string; project: string }> {
    const rows = new Map<string, { status: string; text: string; project: string }>();
    for (const entry of this.records.read(id).entries) {
      const delivery = entry.data.delivery as Delivery | undefined;
      const project = delivery?.recipient.project ?? entry.data.project;
      if (entry.kind === "report" && entry.id.startsWith("report-") && typeof entry.data.text === "string" && typeof entry.data.status === "string" && typeof project === "string")
        rows.set(entry.id.slice("report-".length), { status: entry.data.status, text: entry.data.text, project: canonicalProject(project) });
    }
    for (const event of this.session(id).events) if ((event.type === "orchestrator.answer" || event.type === "orchestrator.report") && !rows.has(event.reportId))
      rows.set(event.reportId, { status: event.status, text: event.text, project: canonicalProject(event.type === "orchestrator.answer" ? event.delivery.recipient.project : event.project) });
    return [...rows].map(([reportId, row], index) => ({ handle: `k${index + 1}`, reportId, ...row }));
  }
  /** Reports owed to the voice, oldest first, each with the parts already handed to the provider. */
  reportSpeech(id: string): ReportSpeech[] { return this.session(id).reportSpeech ?? []; }
  /** Records how many parts of a report the provider took. Its parts are fixed
   * at the first hand-off; a report is dropped once all of them are handed. */
  speechHanded(id: string, reportId: string, parts: readonly string[], handed: number): void {
    this.storage.change(document => {
      const session = document.sessions[id];
      const entry = session?.reportSpeech?.find(row => row.reportId === reportId);
      if (!entry) return;
      entry.parts ??= [...parts];
      entry.handed = Math.max(entry.handed, handed);
      if (entry.handed >= entry.parts.length) session.reportSpeech = session.reportSpeech!.filter(row => row !== entry);
    });
  }
  /** Compatibility for callers that still consume only correlated answers. */
  pollReplies(id: string): CompanionEvent[] { return this.pollReports(id).filter(event => event.type === "orchestrator.answer"); }
  retire(id: string): void {
    this.storage.change(document => {
      const session = document.sessions[id];
      if (!session) return;
      session.closed = true;
      session.endedAt ??= this.now();
      // Nobody is left to hear them; the transcript keeps every report.
      delete session.reportSpeech;
      for (const row of Object.values(session.proposals)) if (row.state === "pending") { row.state = "cancelled"; row.cancelCode = "session_closed"; }
    });
    for (const map of [this.shown, this.reread]) for (const key of map.keys()) if (key.startsWith(`${id}\0`)) map.delete(key);
  }
}
