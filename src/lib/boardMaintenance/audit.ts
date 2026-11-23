import fs from "node:fs";
import { createHash } from "node:crypto";
import { readMessageAuthorContext, type ConversationMessage } from "@/lib/session/messagesPage";
import { heldDeliveryOccurrences } from "@/lib/runtime/deliveredMessageOccurrences";
import { assignDeliveredOccurrences } from "@/components/feed/deliveredOccurrences";
import type { Item } from "@/components/feed/parse";
import { decodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText.server";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";
import { redactMonitorText } from "@/lib/monitor/redact";
import { canonicalOrchestratorProject, readOrchestratorSeatFileOrNull } from "@/lib/orchestrator/seats";
import { existingTeamStore } from "@/lib/team/store";
import { teamMode } from "@/lib/team";
import { conversationWorkspacePrincipal, workspacePrincipalAllows } from "@/lib/team/workspacePrincipal";
import { seatRoundPageWithCursor, findSeatRound } from "@/lib/prototypeReview/seatRounds";
import type { PrototypeReviewRound } from "@/lib/prototypeReview/types";
import type { SeatTickSources } from "@/lib/monitor/seatTickSources";
import type { BoardTask } from "@/lib/tasks/types";
import type { RegistryFile } from "@/lib/agent/registry";
import type { MaintenanceRun, MaintenanceAuditInput, MaintenanceAuditSource, MaintenanceAuditOccurrence, MaintenanceAuditState, MaintenanceAuditResult } from "./types";

export const AUDIT_ROW_LIMIT = 200;
export const AUDIT_BLOCK_BYTES = 32768;
export const AUDIT_DECISION_CHARS = 24000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const auditRequestKey = (occurrence: string, index: number) => `request-v1:${hash(occurrence)}:${index}`;
export const auditSourceMarker = (key: string) => `Maintenance request: ${key}`;
export const auditOccurrenceKey = (source: string, seq: number, part: number, at: string) => JSON.stringify([source, seq, part, at]);
const artifactIdentity = (file: string) => { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error("artifact unavailable"); return { artifact: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, size: stat.size }; };
const inWindow = (at: string, lower: string, upper: string) => Number.isFinite(Date.parse(at)) && Date.parse(at) >= Date.parse(lower) && Date.parse(at) < Date.parse(upper);
const sameProject = (a: string, b: string) => canonicalOrchestratorProject(a) === canonicalOrchestratorProject(b);

interface MessageRecord {
  seq: number; ts: string | null; text: string; truncated?: boolean;
  author?: { kind: string; memberId?: string };
  deliveryKey?: string;
  parts?: Array<{ operationId?: string; textStart: number; textEnd: number; author: { kind: string; memberId?: string } }>;
}
export interface AuditSourcePorts {
  read(path: string, since: string, cursor?: string): Promise<{ records: MessageRecord[]; hasMore: boolean; cursor?: string | null; cursorReset?: boolean; scanned?: { capped: boolean } }>;
  artifact(path: string): { artifact: string; size: number };
}
/** Same normalized records, provenance joins, pinned descriptors and audience as MCP. */
async function productionSourcePorts(sources: SeatTickSources): Promise<AuditSourcePorts> {
  const { viewerReadTools, openPinnedTranscript } = await import("@/lib/mcp/bindings");
  const reader = viewerReadTools();
  return { artifact: artifactIdentity, read: async (transcriptPath, since, cursor) => {
    const page = await reader.conversation_messages({ transcriptPath, since, cursor, kinds: ["message"], roles: ["user"], full: true, limit: 200, maxChars: 16000 }) as unknown as Awaited<ReturnType<AuditSourcePorts["read"]>>;
    const pinned = openPinnedTranscript(transcriptPath);
    if (!pinned) return page;
    try {
      const engine = pinned.rootName === "codex-sessions" ? "codex" : pinned.rootName === "claude-projects" ? "claude" : "copilot";
      const context = readMessageAuthorContext({ descriptor: pinned.descriptor, size: pinned.stat.size, engine }, page.records as unknown as ConversationMessage[]);
      if (!context || !pinned.sameIdentity()) return page;
      const deliveries = heldDeliveryOccurrences(transcriptPath, sources.registry().readOnlySnapshot());
      const digests = new Set(deliveries.map(d => d.textDigest));
      const candidates = new Map<Item, number>();
      for (const record of context) {
        if (record.role !== "user" || !record.ts) continue;
        let text = record.sourceText ?? record.text;
        if (engine === "codex" && !digests.has(messageTextDigest(text))) {
          try { const decoded = decodeCodexStructuredUserText(text); if (decoded.structured) text = decoded.text; } catch { /* no positive origin is inferred */ }
        }
        candidates.set({ kind: "user", ts: record.ts, text }, record.seq);
      }
      const anchors = new Map<number, { kind: string; deliveryKey?: string }>();
      // Use the existing one-occurrence join and consume each native record once.
      for (const delivery of deliveries.sort((a, b) => a.deliveredAt.localeCompare(b.deliveredAt))) {
        for (const [item] of assignDeliveredOccurrences(candidates.keys(), [delivery])) {
          anchors.set(candidates.get(item)!, { kind: delivery.origin, deliveryKey: delivery.clientMessageId });
          candidates.delete(item);
        }
      }
      return { ...page, records: page.records.map(record => {
        const anchor = anchors.get(record.seq);
        return anchor ? { ...record, deliveryKey: anchor.deliveryKey, ...(!record.author && !record.parts && anchor.kind === "operator" ? { author: { kind: "operator" } } : {}) } : record;
      }) };
    } finally { fs.closeSync(pinned.descriptor); }
  } };
}

/** Called only for an admitted due run, never by an ordinary tick read. */
export async function buildMaintenanceAuditInput(run: MaintenanceRun, sources: SeatTickSources, prior?: MaintenanceAuditState, injected?: AuditSourcePorts): Promise<MaintenanceAuditInput> {
  const ports = injected ?? await productionSourcePorts(sources);
  const registry = sources.registry().readOnlySnapshot();
  const store = existingTeamStore();
  const owner = store?.owner();
  const operator: MaintenanceAuditInput["operator"] = owner?.status === "active" ? { kind: "member", memberId: owner.id } : teamMode() === "solo" ? { kind: "operator" } : null;
  const verified = (author: { kind: string; memberId?: string } | undefined) => !!operator && (operator.kind === "member" ? author?.kind === "member" && author.memberId === operator.memberId : author?.kind === "operator");
  const permitted = (id: string) => {
    const principal = conversationWorkspacePrincipal(registry, id);
    return !principal || workspacePrincipalAllows(principal, run.project);
  };
  const gaps: string[] = [];
  const decisionAliases = new Set(prior?.window?.decisionAliases ?? []);
  let roster: MaintenanceAuditSource[] = [];
  let decisionCursor = prior?.window?.decisionCursor ?? "";
  let decisionScanComplete = prior?.window?.decisionScanComplete ?? false;
  const ids = new Set([run.seat.conversationId, ...(prior?.window?.sources.filter(source => source.kind === "transcript").map(source => source.conversationId) ?? [])]);
  const lower = prior?.window?.lower ?? prior?.through ?? "1970-01-01T00:00:00.000Z";
  const upper = prior?.window?.upper ?? run.claimedAt;
  if (prior?.window) {
    roster = structuredClone(prior.window.sources);
    const recoverable = (gap: string) => gap === "operator-anchor-unverified" || gap === "seat-lineage-unavailable" || gap.startsWith("seat-source-unverified:") || gap === "read-budget-exhausted";
    gaps.push(...prior.window.gaps.filter(gap => !recoverable(gap)));
    if (prior.window.gaps.includes("seat-lineage-unavailable") || prior.window.gaps.some(gap => gap.startsWith("seat-source-unverified:"))) {
      const seats = readOrchestratorSeatFileOrNull();
      if (!seats) gaps.push("seat-lineage-unavailable");
      for (const seat of seats?.seatLineage ?? []) if (sameProject(seat.project, run.project)) ids.add(seat.conversationId);
      for (const gap of prior.window.gaps.filter(g => g.startsWith("seat-source-unverified:"))) {
        const id = gap.slice("seat-source-unverified:".length);
        if (!ids.has(id)) ids.add(id);
      }
      for (const id of ids) {
        if (roster.some(source => source.conversationId === id && source.kind === "transcript")) continue;
        const conversation = registry.conversations[id as `conversation_${string}`];
        if (!conversation || !conversation.projectOwnership?.project || !sameProject(conversation.projectOwnership.project, run.project) || !permitted(id) || !conversation.generations.length) { if (prior.window.gaps.some(g => g === `seat-source-unverified:${id}`)) gaps.push(`seat-source-unverified:${id}`); continue; }
        for (const generation of conversation.generations) {
          let file: { artifact: string | null; size: number } = { artifact: null, size: 0 };
          try { file = ports.artifact(generation.path); } catch { /* explicit source gap below */ }
          const key = JSON.stringify([id, generation.id, generation.path, file.artifact]);
          const audience = generation.launchProfile.workspace;
          const wrongProject = generation.launchProfile.project && !sameProject(generation.launchProfile.project, run.project);
          roster.push({ key, kind: "transcript", conversationId: id, generation: generation.id, path: generation.path, ...file, from: null, scanThrough: null, complete: false, gap: wrongProject || audience && !workspacePrincipalAllows(audience, run.project) ? "generation-audience-unverified" : file.artifact ? null : "artifact-unavailable" });
        }
      }
    }
    for (const source of roster) if (source.gap === "read-budget-exhausted" || source.gap === "artifact-unavailable") source.gap = null;
  }
  else {
    const seats = readOrchestratorSeatFileOrNull();
    if (!seats) gaps.push("seat-lineage-unavailable");
    for (const seat of seats?.seatLineage ?? []) if (sameProject(seat.project, run.project)) ids.add(seat.conversationId);
    for (const id of [...ids].sort()) {
      const conversation = registry.conversations[id as `conversation_${string}`];
      if (!conversation || !conversation.projectOwnership?.project || !sameProject(conversation.projectOwnership.project, run.project) || !permitted(id) || !conversation.generations.length) { gaps.push(`seat-source-unverified:${id}`); continue; }
      for (const generation of conversation.generations) {
        let file: { artifact: string | null; size: number } = { artifact: null, size: 0 };
        try { file = ports.artifact(generation.path); } catch { /* explicit source gap below */ }
        const key = JSON.stringify([id, generation.id, generation.path, file.artifact]);
        const audience = generation.launchProfile.workspace;
        const wrongProject = generation.launchProfile.project && !sameProject(generation.launchProfile.project, run.project);
        roster.push({ key, kind: "transcript", conversationId: id, generation: generation.id, path: generation.path, ...file, from: null, scanThrough: null, complete: false, gap: wrongProject || audience && !workspacePrincipalAllows(audience, run.project) ? "generation-audience-unverified" : file.artifact ? null : "artifact-unavailable" });
      }
    }
  }
  const addRound = (round: PrototypeReviewRound) => {
    const decision = round.decision;
    if (!decision || !sameProject(round.project, run.project)) return;
    const id = round.source.conversationId;
    const conversation = id ? registry.conversations[id] : null;
    if (!id || !conversation?.projectOwnership?.project || !sameProject(conversation.projectOwnership.project, run.project) || !permitted(id) || !round.taskId && !ids.has(id)) { if (inWindow(decision.at, lower, upper)) gaps.push(`decision-source-unverified:${round.id}`); return; }
    if (verified(decision.decidedBy)) { decisionAliases.add(decision.delivery.clientMessageId); if (decision.delivery.operationId) decisionAliases.add(decision.delivery.operationId); }
    if (!inWindow(decision.at, lower, upper)) return;
    if (roster.some(source => source.decision?.roundId === round.id)) return;
    const payload = decisionPayload(round);
    roster.push({ key: JSON.stringify([round.id, decision.revision ?? 0]), kind: "decision", conversationId: id, generation: String(decision.revision ?? 0), path: null, artifact: hash(payload), size: payload.length, from: null, complete: false, gap: null, decision: { roundId: round.id, revision: decision.revision ?? 0, taskId: round.taskId, deliveryKey: decision.delivery.clientMessageId, operationId: decision.delivery.operationId } });
  };
  if (!prior?.window) sources.tasks().filter(t => sameProject(t.project, run.project)).sort((a, b) => a.id.localeCompare(b.id)).forEach(t => [...(t.prototypeReviews ?? [])].sort((a, b) => a.id.localeCompare(b.id)).forEach(addRound));
  if (!decisionScanComplete) {
    for (let i = gaps.length - 1; i >= 0; i--) if (gaps[i].startsWith("seat-decisions-unread")) gaps.splice(i, 1);
    for (let page = 0; page < 16; page++) {
      const read = seatRoundPageWithCursor(decisionCursor);
      read.rounds.forEach(addRound);
      decisionCursor = read.cursor;
      if (read.scanned < 16) { decisionScanComplete = true; break; }
    }
    if (!decisionScanComplete) gaps.push("seat-decisions-unread");
  }
  if (!operator) gaps.push("operator-anchor-unverified");
  const decisionDeliveries = new Set([...decisionAliases, ...roster.flatMap(source => source.decision ? [source.decision.deliveryKey, source.decision.operationId].filter((key): key is string => !!key) : [])]);
  let currentDecisionTasks: ReadonlyMap<string, BoardTask> | null = null;
  const occurrences: MaintenanceAuditOccurrence[] = [];
  const unread: MaintenanceAuditInput["unread"] = {};
  let decisionChars = 0;
  let manifestBytes = 512;
  for (const source of roster) {
    unread[source.key] = source.from;
    if (source.complete || source.gap === "generation-audience-unverified") continue;
    if (!permitted(source.conversationId)) { source.gap = "source-audience-unavailable"; continue; }
    const push = (record: MessageRecord, part: number, text: string, author: MessageRecord["author"]) => {
      if (!record.ts || !inWindow(record.ts, lower, upper)) return true;
      if (source.from && (record.seq > source.from.seq || record.seq === source.from.seq && part < (source.from.part ?? 0))) return true;
      const key = auditOccurrenceKey(source.key, record.seq, part, record.ts);
      const cost = Buffer.byteLength(JSON.stringify({ key, requests: 100000, nextIndex: 100000 })) + 1;
      if (occurrences.length >= AUDIT_ROW_LIMIT || manifestBytes + cost > 12000) {
        unread[source.key] = { seq: record.seq, ...(part ? { part } : {}), requestIndex: source.from?.seq === record.seq && (source.from.part ?? 0) === part ? source.from.requestIndex : 0 };
        if (cost > 12000 - 512) { source.gap = "occurrence-locator-oversize"; source.from = unread[source.key]; }
        return false;
      }
      manifestBytes += cost;
      const isVerified = verified(author);
      const gap = record.truncated ? "record-truncated" : !isVerified ? "author-unverified" : null;
      occurrences.push({ key, source: source.key, seq: record.seq, part, at: record.ts, requestIndex: source.from?.seq === record.seq && (source.from.part ?? 0) === part ? source.from.requestIndex : 0, text, verified: isVerified, gap });
      return true;
    };
    if (source.kind === "decision") {
      currentDecisionTasks ??= new Map(sources.tasks().filter(t => sameProject(t.project, run.project)).map(t => [t.id, t]));
      const round = source.decision?.taskId ? currentDecisionTasks.get(source.decision.taskId)?.prototypeReviews?.find(r => r.id === source.decision?.roundId) : source.decision ? findSeatRound(source.decision.roundId) : null;
      if (!round?.decision) { source.gap = "decision-unavailable"; continue; }
      const decision = round.decision;
      const payload = decisionPayload(round);
      if (hash(payload) !== source.artifact) { source.gap = "decision-replaced"; continue; }
      if (occurrences.length >= AUDIT_ROW_LIMIT || decisionChars + payload.length > AUDIT_DECISION_CHARS) {
        unread[source.key] = { seq: 0, requestIndex: source.from?.requestIndex ?? 0 };
        if (payload.length > AUDIT_DECISION_CHARS) source.gap = `decision-record-oversize:${source.key}`;
        continue;
      }
      decisionChars += payload.length;
      if (push({ seq: 0, ts: decision.at, text: payload }, 0, payload, decision.decidedBy)) unread[source.key] = null;
      continue;
    }
    try {
      const file = ports.artifact(source.path!);
      if (file.artifact !== source.artifact || file.size < source.size) { source.gap = "artifact-replaced"; continue; }
      source.gap = null;
      let cursor: string | undefined;
      let found = source.from === null;
      let exhausted = false;
      let readBudgetReached = false;
      let physicalBoundary = source.scanThrough ?? null;
      for (let page = 0; page < 16; page++) {
        const result = await ports.read(source.path!, source.scanThrough?.at ?? lower, cursor);
        if (result.cursorReset) { source.gap = "cursor-reset"; break; }
        for (const record of result.records) {
          if (!physicalBoundary || record.seq > physicalBoundary.seq) physicalBoundary = { seq: record.seq, at: record.ts ?? physicalBoundary?.at ?? lower };
          if (source.scanThrough && record.seq <= source.scanThrough.seq) continue;
          if (source.from?.seq === record.seq) found = true;
          if (!record.ts || !Number.isFinite(Date.parse(record.ts))) { source.gap = "occurrence-time-unverified"; continue; }
          if (record.seq >= source.size || !inWindow(record.ts, lower, upper) || source.from && record.seq > source.from.seq) continue;
          if (record.deliveryKey && decisionDeliveries.has(record.deliveryKey)) continue;
          if (occurrences.length >= AUDIT_ROW_LIMIT) { unread[source.key] = { seq: record.seq, requestIndex: 0 }; exhausted = true; break; }
          if (record.parts) {
            for (let i = 0; i < record.parts.length; i++) {
              const part = record.parts[i];
              if (source.from?.seq === record.seq && i < (source.from.part ?? 0)) continue;
              if (occurrences.length >= AUDIT_ROW_LIMIT) { unread[source.key] = { seq: record.seq, part: i, requestIndex: 0 }; exhausted = true; break; }
              if (part.textStart < 0 || part.textEnd > record.text.length || part.textEnd <= part.textStart) { source.gap = "part-range-unverified"; break; }
              if (part.author.kind === "agent" || part.operationId && decisionDeliveries.has(part.operationId)) continue;
              if (!push(record, i, record.text.slice(part.textStart, part.textEnd), part.author)) { exhausted = true; break; }
            }
          } else if (record.author?.kind !== "agent" && !push(record, 0, record.text, record.author)) exhausted = true;
          if (exhausted) break;
        }
        if (exhausted) break;
        if (!result.hasMore) {
          if (result.scanned?.capped) { source.gap = "page-continuation-missing"; break; }
          exhausted = true; unread[source.key] = null; break;
        }
        if (!result.cursor) { source.gap = "page-continuation-missing"; break; }
        cursor = result.cursor;
        if (page === 15) readBudgetReached = true;
      }
      if (readBudgetReached && physicalBoundary) source.scanThrough = physicalBoundary;
      if (!exhausted && !source.gap) {
        const last = occurrences.filter(o => o.source === source.key).at(-1);
        if (last) unread[source.key] = { seq: last.seq, ...(last.part ? { part: last.part } : {}), requestIndex: 0 };
        else source.gap = "read-budget-exhausted";
      }
      if (!found) source.gap = "occurrence-unavailable";
      if (ports.artifact(source.path!).artifact !== source.artifact) source.gap = "artifact-replaced";
    } catch (error) { source.gap = `source-read-unavailable: ${redactMonitorText(error instanceof Error ? error.message : "unknown read error").slice(0, 300)}`; }
  }
  // Revalidate source audiences after asynchronous reads before disclosing their text.
  if (!injected) {
    const current = sources.registry().readOnlySnapshot();
    for (const source of roster) {
      if (!occurrences.some(o => o.source === source.key) || auditSourceAudienceCurrent({ project: run.project }, source, current)) continue;
      source.gap = "source-audience-unavailable";
      for (let i = occurrences.length - 1; i >= 0; i--) if (occurrences[i].source === source.key) occurrences.splice(i, 1);
      unread[source.key] = source.from;
    }
  }
  return { version: 1, runId: run.runId, project: run.project, revision: prior?.revision ?? 0, seat: structuredClone(run.seat), operator, snapshotAt: new Date(sources.now()).toISOString(), authority: maintenanceAuditAuthority(run, sources), window: { lower, upper, sources: roster, gaps: [...new Set(gaps)], decisionAliases: [...decisionAliases], decisionCursor, decisionScanComplete }, occurrences, unread };
}

function decisionPayload(round: PrototypeReviewRound): string {
  return JSON.stringify({ questions: round.questions, variants: round.variants.map(v => ({ number: v.number, name: v.name, description: v.description })), decision: { ...round.decision, delivery: undefined, telegramUserId: undefined } });
}

function currentAuditDecision(source: MaintenanceAuditSource, tasks: readonly BoardTask[]) {
  const reference = source.decision;
  if (!reference) return null;
  return reference.taskId ? tasks.find(t => t.id === reference.taskId)?.prototypeReviews?.find(r => r.id === reference.roundId) ?? null : findSeatRound(reference.roundId);
}
export function auditSourceStillCurrent(input: MaintenanceAuditInput, occurrence: MaintenanceAuditOccurrence, tasks: readonly BoardTask[]): boolean {
  const source = input.window.sources.find(s => s.key === occurrence.source);
  if (!source || source.gap || !occurrence.verified || occurrence.gap) return false;
  if (source.kind === "transcript") { try { return artifactIdentity(source.path!).artifact === source.artifact; } catch { return false; } }
  const round = currentAuditDecision(source, tasks);
  return !!round?.decision && (round.decision.revision ?? 0) === source.decision?.revision && hash(decisionPayload(round)) === source.artifact && sameProject(round.project, input.project);
}


/** Ordinary writes keep their existing authority. Only explicit audit evidence is checked here. */
export function auditTaskWriteRefusal(input: MaintenanceAuditInput | undefined, args: Record<string, unknown>, tasks: readonly BoardTask[], task?: BoardTask, registry?: RegistryFile): string | null {
  const markerText = [args.details, args.appendLine, (args.replaceLine as { text?: unknown } | undefined)?.text].filter(v => typeof v === "string").join("\n");
  const markers = markerText.split("\n").filter(l => /^Maintenance request: request-v1:[a-f0-9]{64}:(?:0|[1-9][0-9]{0,5})$/.test(l));
  const auditKey = (value: unknown): value is string => typeof value === "string" && value.startsWith("request-v1:");
  const keyed = auditKey(args.findingKey) || auditKey(args.clientRequestId);
  if (!markers.length && !keyed) return null;
  if (!input) return "audit input unavailable";
  if (markers.length !== 1 || args.clientRequestId !== markers[0].slice("Maintenance request: ".length)
    || !task && args.findingKey !== args.clientRequestId) return "audit mutation requires one atomic source marker and its original request key";
  for (const marker of markers) {
    const key = marker.slice("Maintenance request: ".length);
    const [, digest, indexText] = /^request-v1:([a-f0-9]{64}):(0|[1-9][0-9]{0,5})$/.exec(key)!;
    const index = Number(indexText);
    const occurrence = input.occurrences.find(o => hash(o.key) === digest && index >= o.requestIndex && index < o.requestIndex + AUDIT_ROW_LIMIT);
    if (!occurrence || !auditOperatorCurrent(input) || !auditSourceStillCurrent(input, occurrence, tasks)) return "audit source authority changed";
    const source = input.window.sources.find(s => s.key === occurrence.source)!;
    if (!registry || !auditSourceAudienceCurrent(input, source, registry)) return "audit source audience changed";
    if (!task && tasks.some(t => sameProject(t.project, input.project) && t.details?.split("\n").includes(marker))) continue;
    if (task && (args.expectedProject !== task.project || typeof args.expectedRevision !== "string")) return "audit updates require the current project and revision";
    if (task && (args.hold !== undefined || args.assignments !== undefined || args.findingKey !== undefined && args.findingKey !== task.findingKey || task.dueAt && (args.dueAt !== undefined && args.dueAt !== task.dueAt || args.dueTz !== undefined && args.dueTz !== task.dueTz))) return "preserve existing outcome date, hold, owner and finding key";
    if (!task?.dueAt) {
      const date = typeof args.dueAt === "string" ? Date.parse(args.dueAt) : NaN;
      if (!Number.isFinite(date) || (date < Date.parse(input.snapshotAt) || date > Date.parse(input.snapshotAt) + 86400000) && args.dueReason !== `Operator deadline: ${key}` || typeof args.dueTz !== "string") return "audit task requires a date and zone within 24 hours of planning";
    }
  }
  return null;
}

/** A seat's native succession can replace authority without changing its logical id. */
export function maintenanceAuditAuthority(run: Pick<MaintenanceRun, "seat">, sources: Pick<SeatTickSources, "registry">): string | null {
  const conversation = sources.registry().conversation(run.seat.conversationId as `conversation_${string}`);
  if (!conversation) return null;
  const generation = conversation.generations.at(-1);
  return JSON.stringify([conversation.id, conversation.projectOwnership, generation?.id, generation?.path, generation?.host?.identity, generation?.host?.epoch, generation?.launchProfile.workspace]);
}

export function auditOperatorCurrent(input: MaintenanceAuditInput): boolean {
  if (!input.operator) return false;
  const owner = existingTeamStore()?.owner();
  return input.operator.kind === "member" ? owner?.id === input.operator.memberId && owner.status === "active" : teamMode() === "solo";
}

export function auditAudienceCurrent(input: MaintenanceAuditInput, sources: Pick<SeatTickSources, "registry">): boolean {
  const snapshot = sources.registry().readOnlySnapshot();
  const principal = conversationWorkspacePrincipal(snapshot, input.seat.conversationId);
  return (!principal || workspacePrincipalAllows(principal, input.project))
    && input.window.sources.filter(source => input.occurrences.some(o => o.source === source.key)).every(source => auditSourceAudienceCurrent(input, source, snapshot));
}

function auditSourceAudienceCurrent(input: Pick<MaintenanceAuditInput, "project">, source: MaintenanceAuditSource, snapshot: RegistryFile): boolean {
  const conversation = snapshot.conversations[source.conversationId];
  if (!conversation?.projectOwnership?.project || !sameProject(conversation.projectOwnership.project, input.project)) return false;
  const principal = conversationWorkspacePrincipal(snapshot, source.conversationId);
  if (principal && !workspacePrincipalAllows(principal, input.project)) return false;
  if (source.kind === "decision") return true;
  const generation = conversation.generations.find(g => g.id === source.generation && g.path === source.path);
  return !!generation && (!generation.launchProfile.workspace || workspacePrincipalAllows(generation.launchProfile.workspace, input.project));
}
