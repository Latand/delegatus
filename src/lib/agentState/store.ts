import crypto from "node:crypto";
import type { AgentRegistry, AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import { registryCollectionPage, registryConversationsForEntryKey } from "@/lib/agent/sqliteRegistryStore";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { AGENT_STATE_POLICY, emptyAgentStateMetrics, evaluateAgentState, fact, validAgentFacts, validAgentEvidence, type AgentProjection, type AgentStateJournal, type AgentStateMetrics } from "./model";

export function copyAgentStateRow<T>(row: T): T { return JSON.parse(JSON.stringify(row)) as T; }
const hash = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function subjectId(entry: AgentRegistryEntry): string {
  return hash([sessionKeyId(entry.key), entry.structuredHost?.process ?? entry.structuredHost?.exitProcess ?? entry.hostExitProcess]).slice(0, 48);
}
/** All writers, copies, defaults and CAS inputs meet at this tuple. */
export function entryRevision(entry: AgentRegistryEntry): string {
  return hash(entry);
}
export function artifactRevision(entry: AgentRegistryEntry): string {
  return hash([entry.key, entry.artifactPath, entry.structuredHost?.process, entry.structuredHost?.agentStateNativePromptAnchor]);
}

export function normalizeAgentStateRows(value: unknown, kind: "projection"): Record<string, AgentProjection>;
export function normalizeAgentStateRows(value: unknown, kind: "journal"): Record<string, AgentStateJournal>;
export function normalizeAgentStateRows(value: unknown, kind: "metrics"): Record<string, AgentStateMetrics>;
export function normalizeAgentStateRows(value: unknown, kind: "projection" | "journal" | "metrics"): Record<string, AgentProjection | AgentStateJournal | AgentStateMetrics> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid agent-state collection");
  const rows: Record<string, AgentProjection | AgentStateJournal | AgentStateMetrics> = {};
  for (const [key, row] of Object.entries(value)) {
    if (!row || row.version !== 1 || key.length > 128 || Buffer.byteLength(JSON.stringify(row)) > 8192
      || (kind === "projection" && (!validAgentFacts(row.facts) || row.subject !== row.facts.subject || !row.verdict || !Number.isSafeInteger(row.revision)))
      || (kind === "journal" && (row.id !== key || typeof row.at !== "number" || !Array.isArray(row.evidence) || row.evidence.length > 16 || !row.evidence.every(validAgentEvidence)))
      || (kind === "metrics" && !validAgentStateMetrics(row))) throw new Error("invalid agent-state row");
    rows[key] = row;
  }
  return rows;
}
export function validAgentStateMetrics(v: unknown): v is AgentStateMetrics {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const row = v as Record<string, unknown>;
  return Object.entries(emptyAgentStateMetrics()).every(([key, sample]) => {
    const value = row[key];
    if (key === "version") return value === 1;
    if (key === "stuckByEngine" || key === "stuckByReason") return Boolean(value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === Object.keys(sample!).length
      && Object.keys(sample!).every(bucket => typeof (value as Record<string, unknown>)[bucket] === "number"
        && Number.isSafeInteger((value as Record<string, number>)[bucket]) && (value as Record<string, number>)[bucket]! >= 0));
    if (key === "afterKey") return value === null || typeof value === "string" && value.length <= 128;
    if (sample === null) return value === null || typeof value === "number" && Number.isFinite(value) && value >= 0;
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }) && (row.physicalSubjects === undefined || Array.isArray(row.physicalSubjects) && row.physicalSubjects.length <= 16 && row.physicalSubjects.every(id => typeof id === "string" && /^[a-f0-9]{48}$/.test(id)))
    && Object.keys(row).length === Object.keys(emptyAgentStateMetrics()).length + Number(row.physicalSubjects !== undefined);
}

export interface StateObservation {
  entry: AgentRegistryEntry;
  conversationRevision: string;
  projection: AgentProjection;
  journal: AgentStateJournal;
  repair: boolean;
  repairConversation?: boolean;
}
export function conversationRevision(file: RegistryFile, entry: AgentRegistryEntry): string {
  return hash(registryConversationsForEntryKey(file, sessionKeyId(entry.key)).map(row => [row.id, row.generations, row.turn]));
}
function contribution(row?: AgentProjection): Record<"unownedHosts" | "unownedRssMeasured" | "unownedRssUnknown" | "stuckTurns" | "subjectsObserved" | "subjectsUnverified" | "pendingProjectionPublications" | "registryTranscriptDivergencesCurrent", number> {
  const unowned = row?.verdict.state === "unowned";
  return { unownedHosts: Number(unowned), unownedRssMeasured: Number(unowned && row?.rssBytes !== null),
    unownedRssUnknown: Number(unowned && row?.rssBytes === null), stuckTurns: Number(row?.verdict.stuck ?? false),
    subjectsObserved: Number(Boolean(row)), subjectsUnverified: Number(Boolean(row && row.verdict.missing.length)),
    pendingProjectionPublications: Number(row?.pendingPublication ?? false), registryTranscriptDivergencesCurrent: Number(Boolean(row?.divergence)) };
}
function changeMetrics(file: RegistryFile, metrics: AgentStateMetrics, old: AgentProjection | undefined, next: AgentProjection): void {
  const before = contribution(old), after = contribution(next);
  for (const key of ["subjectsObserved", "subjectsUnverified", "pendingProjectionPublications", "registryTranscriptDivergencesCurrent"] as const)
    metrics[key] = Math.max(0, metrics[key] + after[key] - before[key]);
  const identity = next.facts.process.determined ? next.facts.process.value.identity : null;
  if (!identity) return;
  const key = `process:${hash(identity).slice(0, 48)}`;
  const prior = file.agentStateMetrics[key] ?? emptyAgentStateMetrics();
  const members = [...new Set([...(prior.physicalSubjects ?? []), next.subject])];
  const rows = members.flatMap(id => {
    const row = id === next.subject ? next : file.agentStates[id];
    return row?.facts.process.determined && row.facts.process.value.status === "alive" ? [row] : [];
  });
  const physical = emptyAgentStateMetrics();
  physical.physicalSubjects = rows.map(row => row.subject).slice(0, 16);
  physical.at = next.verdict.evaluatedAt;
  physical.physicalAliasesUnverified = Number(prior.physicalAliasesUnverified > 0 || members.length > 16);
  physical.unownedHosts = Number(rows.length > 0 && !physical.physicalAliasesUnverified
    && rows.every(row => row.facts.owner.determined && row.facts.owner.value === "absent"));
  const stuck = rows.filter(row => row.verdict.stuck).sort((a, b) => a.subject.localeCompare(b.subject))[0];
  physical.stuckTurns = Number(Boolean(stuck));
  if (stuck) {
    physical.stuckByEngine[stuck.facts.engine] = 1;
    const activity = stuck.facts.activity.determined ? stuck.facts.activity.value : null;
    physical.stuckByReason[activity?.providerRetry ? "providerWait" : activity?.flags.length ? "checking" : "silent"] = 1;
  }
  for (const group of ["stuckByEngine", "stuckByReason"] as const) {
    for (const key of Object.keys(physical[group])) {
      const aggregate = metrics[group] as Record<string, number>;
      aggregate[key] = Math.max(0, (aggregate[key] ?? 0) + (physical[group] as Record<string, number>)[key]! - ((prior[group] as Record<string, number>)[key] ?? 0));
    }
  }
  const measured = rows.filter(row => row.rssBytes !== null && row.rssCapturedAt !== undefined
    && next.verdict.evaluatedAt - row.rssCapturedAt < AGENT_STATE_POLICY.reconcileMs).sort((a, b) => (b.rssCapturedAt ?? 0) - (a.rssCapturedAt ?? 0))[0];
  physical.unownedRssMeasured = Number(physical.unownedHosts > 0 && measured !== undefined);
  physical.unownedRssUnknown = Number(physical.unownedHosts > 0 && measured === undefined);
  physical.unownedRssBytes = physical.unownedRssMeasured ? measured!.rssBytes : null;
  const bytes = (metrics.unownedRssBytes ?? 0) + (physical.unownedRssBytes ?? 0) - (prior.unownedRssBytes ?? 0);
  for (const gauge of ["unownedHosts", "stuckTurns", "unownedRssMeasured", "unownedRssUnknown", "physicalAliasesUnverified"] as const)
    metrics[gauge] = Math.max(0, metrics[gauge] + physical[gauge] - prior[gauge]);
  metrics.unownedRssBytes = metrics.unownedRssMeasured ? Math.max(0, bytes) : null;
  if (rows.length) file.agentStateMetrics[key] = physical;
  else delete file.agentStateMetrics[key];
}
function semantic(row: AgentProjection): string {
  return JSON.stringify([row.facts.revision, row.verdict.state, row.verdict.reason, row.verdict.stuck, row.verdict.missing,
    row.facts.turn.determined ? row.facts.turn.value : row.facts.turn.why, row.facts.transcript.determined ? row.facts.transcript.value.signature : null, row.divergence, row.rssBytes]);
}
/** The repair, conversation axis, journal and totals have one commit boundary. */
export function commitAgentObservation(registry: AgentRegistry, observation: StateObservation, guard: () => boolean): AgentProjection | null {
  return registry.agentStateWrite(file => {
    const key = sessionKeyId(observation.entry.key);
    const current = file.entries[key];
    if (!current || entryRevision(current) !== entryRevision(observation.entry)
      || conversationRevision(file, current) !== observation.conversationRevision || !guard()) return null;
    const old = file.agentStates[observation.projection.subject];
    const next = copyAgentStateRow(observation.projection);
    const open = next.facts.turn.determined && next.facts.turn.value.state === "open";
    if (observation.repair) {
      current.structuredHost!.activeTurnRef = null;
      current.status = open ? "live" : "idle";
      next.facts.revision = entryRevision(current);
      next.divergence = null;
    }
    if (observation.repair || observation.repairConversation) {
      for (const conversation of registryConversationsForEntryKey(file, key)) {
        if (conversation.generations.at(-1)?.id !== current.key.sessionId) continue;
        const terminal = next.facts.turn.determined ? next.facts.turn.value.at : null;
        const state = open ? "busy" : next.facts.turn.determined && next.facts.turn.value.state === "absent" ? "idle" : "terminal";
        const terminalAt = open || terminal === null ? null : new Date(terminal).toISOString();
        if (conversation.turn.state === state && conversation.turn.terminalAt === terminalAt) continue;
        conversation.turn = { state, source: "lifecycle", terminalAt, observedAt: new Date(observation.journal.at).toISOString() };
        file.conversationRevision[conversation.engine]++;
      }
      next.divergence = null;
    }
    if (old && !observation.repair && !observation.repairConversation && semantic(old) === semantic(next)) return copyAgentStateRow(old);
    const metrics = file.agentStateMetrics.current ?? emptyAgentStateMetrics();
    metrics.revision++;
    metrics.at = observation.journal.at;
    next.revision = metrics.revision;
    next.verdict.projectionRevision = next.revision;
    next.pendingPublication = next.conversationId !== null && next.publishable !== false;
    const journal: AgentStateJournal = { ...observation.journal, from: old?.verdict.state ?? null, to: next.verdict.state,
      conversationId: next.conversationId, entryKey: next.entryKey,
      effectiveAt: next.facts.turn.determined ? next.facts.turn.value.at : null,
      fromTurn: { state: old?.facts.turn.determined ? old.facts.turn.value.state : null,
        nativeId: old?.facts.turn.determined ? old.facts.turn.value.nativeId : null, cacheRef: observation.entry.structuredHost?.activeTurnRef ?? null },
      toTurn: { state: next.facts.turn.determined ? next.facts.turn.value.state : null,
        nativeId: next.facts.turn.determined ? next.facts.turn.value.nativeId : null, cacheRef: current.structuredHost?.activeTurnRef ?? null } };
    normalizeAgentStateRows({ [next.subject]: next }, "projection");
    normalizeAgentStateRows({ [journal.id]: journal }, "journal");
    if (!file.agentStateJournal[journal.id]) {
      // A failure inserting this row rolls back the repaired cache too.
      file.agentStateJournal[journal.id] = journal;
      metrics.journalRows++;
      for (const stale of registryCollectionPage(file, "agentStateJournal", "", 2)) {
        if (metrics.journalRows <= 16384) break;
        if (stale !== journal.id) { delete file.agentStateJournal[stale]; metrics.journalRows--; }
      }
      if (journal.divergence && old?.divergenceKey !== next.divergenceKey) metrics.registryTranscriptDivergencesTotal++;
    }
    changeMetrics(file, metrics, old, next);
    file.agentStates[next.subject] = next;
    file.agentStateMetrics.current = metrics;
    return copyAgentStateRow(next);
  });
}

export function readAgentStateMetrics(registry: AgentRegistry): AgentStateMetrics {
  return registry.agentStateRead(file => copyAgentStateRow(file.agentStateMetrics.current ?? emptyAgentStateMetrics()));
}
export function readAgentProjection(registry: AgentRegistry, subject: string): AgentProjection | null {
  return registry.agentStateRead(file => copyAgentStateRow(file.agentStates[subject] ?? null));
}
export function readAgentStatePage(registry: AgentRegistry, collection: "agentStateJournal" | "agentStateMetrics", after = "", limit = 32) {
  return registry.agentStateRead(file => {
    const keys = registryCollectionPage(file, collection, after, limit);
    return { rows: keys.map(key => copyAgentStateRow(file[collection][key])), nextCursor: keys.length === limit ? keys.at(-1) : null };
  });
}
export function acknowledgeAgentProjection(registry: AgentRegistry, subject: string, revision: number, at = Date.now()): boolean {
  return registry.agentStateWrite(file => {
    const row = file.agentStates[subject];
    if (!row || row.revision !== revision || !row.pendingPublication) return false;
    row.pendingPublication = false;
    const metrics = file.agentStateMetrics.current;
    if (metrics) { metrics.pendingProjectionPublications = Math.max(0, metrics.pendingProjectionPublications - 1); metrics.revision++; metrics.at = at; }
    return true;
  });
}

/** Ending one physical identity never mutates a replacement's registry row. */
export function recordAgentProcessEnded(registry: AgentRegistry, observed: AgentProjection, journal: AgentStateJournal, guard: () => boolean): boolean {
  return registry.agentStateWrite(file => {
    const row = file.agentStates[observed.subject];
    if (!row || row.revision !== observed.revision || row.verdict.state === "dead" || !row.facts.process.determined || !guard()) return false;
    const metrics = file.agentStateMetrics.current ?? emptyAgentStateMetrics();
    const before = copyAgentStateRow(row);
    row.facts.process = fact({ ...row.facts.process.value, status: "dead" }, {
      ...row.facts.process.evidence, observedAt: journal.at, validUntil: undefined,
    });
    row.verdict = evaluateAgentState(row.facts, journal.at);
    row.revision = ++metrics.revision;
    row.verdict.projectionRevision = row.revision;
    row.pendingPublication = false;
    file.agentStateJournal[journal.id] = { ...journal, from: before.verdict.state, to: "dead" };
    metrics.journalRows++;
    changeMetrics(file, metrics, before, row);
    file.agentStateMetrics.current = metrics;
    return true;
  });
}

/** Terminal diagnostics are disposable only after registry custody settled. */
export function pruneTerminalAgentProjection(registry: AgentRegistry, subject: string, at: number, guard: () => boolean): void {
  registry.agentStateWrite(file => {
    const row = file.agentStates[subject];
    if (!row || row.verdict.state !== "dead" || row.pendingPublication || !guard()) return;
    const entry = file.entries[row.entryKey];
    if (entry?.structuredHost?.process || entry?.structuredHost?.scope || entry?.structuredHost?.memory?.unit
      || entry?.structuredTerminationSurvivors?.length || entry?.pendingHostExits?.length
      || entry?.structuredHost?.signalDomain && entry.structuredHost.signalDomain.retired !== true) return;
    const metrics = file.agentStateMetrics.current ?? emptyAgentStateMetrics();
    if (row.terminalAt === undefined) { row.terminalAt = at; metrics.terminalSubjects++; }
    if (at - row.terminalAt >= 86400_000 || metrics.terminalSubjects > 4096) {
      const old = contribution(row);
      metrics.subjectsObserved = Math.max(0, metrics.subjectsObserved - 1);
      metrics.subjectsUnverified = Math.max(0, metrics.subjectsUnverified - old.subjectsUnverified);
      metrics.registryTranscriptDivergencesCurrent = Math.max(0, metrics.registryTranscriptDivergencesCurrent - old.registryTranscriptDivergencesCurrent);
      metrics.terminalSubjects = Math.max(0, metrics.terminalSubjects - 1);
      delete file.agentStates[subject];
    }
    file.agentStateMetrics.current = metrics;
  });
}
