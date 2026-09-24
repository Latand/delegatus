import crypto from "node:crypto";
import fs from "node:fs";

import { normalizeRegistry } from "@/lib/agent/registry";
import { defaultRegistrySqliteFilename, resolveRegistryBackend } from "@/lib/agent/registryBackendIdentity";
import { SqliteAgentRegistryStore } from "@/lib/agent/sqliteRegistryStore";
import { statePath } from "@/lib/configDir";
import { canonicalProject } from "@/lib/projects/aliases";

const REPORT_BYTES = 1024 * 1024;
export const RETIREMENT_SCAN_LIMIT = 100;
export const RETIREMENT_MAX_PAGES = 20;
type Subject = ReturnType<SqliteAgentRegistryStore["retirementSubject"]>;
type Row = { key: string; conversationId: string | null; clause?: string; reason?: string; error?: string; undetermined?: true; via?: string };
type Report = { version: 1; startedAt: string; finishedAt: string; retired: Row[]; refused: Row[]; failed: Row[] };
export type RetirementStatusRequest = { project: string; limit?: number; cursor?: string };
export type RetirementStatusSources = {
  readReport(): Buffer;
  subject(conversationId: string, key: string): Subject;
  now(): number;
};

function subjectProject(subject: Subject): string | null {
  // Legacy cwd resolution can persist worktree mappings. An observation does
  // not run that writer or infer project authority from a launch hint.
  const project = subject.conversation?.projectOwnership?.project;
  return project ? canonicalProject(project) : null;
}

function readReport(): Buffer {
  const fd = fs.openSync(statePath("host-retirement-report.json"), "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > REPORT_BYTES) throw new Error("report exceeds the byte budget");
    const buffer = Buffer.alloc(REPORT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = fs.readSync(fd, buffer, size, buffer.length - size, size);
      if (!read) break;
      size += read;
    }
    if (size > REPORT_BYTES) throw new Error("report exceeds the byte budget");
    return buffer.subarray(0, size);
  } finally { fs.closeSync(fd); }
}

function parseReport(bytes: Buffer): Report {
  if (bytes.length > REPORT_BYTES) throw new Error("report exceeds the byte budget");
  const value = JSON.parse(bytes.toString("utf8")) as Report;
  if (value?.version !== 1 || typeof value.startedAt !== "string" || typeof value.finishedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))
    || !Number.isFinite(Date.parse(value.finishedAt))
    || !Array.isArray(value.refused) || !Array.isArray(value.failed) || !Array.isArray(value.retired)) {
    throw new Error("retirement report is invalid");
  }
  return value;
}

/** The latest sweep is the authority behind the seat-tick signal. The journal
    discards individual refusals; searching it cannot reconstruct their targets.
    A report's session key survives, but it records no operation or PID/start
    identity. Current registry facts are deliberately a separate observation. */
export function projectRetirementStatus(request: RetirementStatusRequest, sources: RetirementStatusSources) {
  request = { ...request, project: canonicalProject(request.project) };
  const requestedAt = new Date(sources.now()).toISOString();
  const limit = Math.max(1, Math.min(100, Number.isFinite(request.limit) ? Math.trunc(request.limit!) : 25));
  const base = { kind: "host-retirement" as const, project: request.project, requestedAt, limit,
    source: "latest-retirement-report" as const, maxPages: RETIREMENT_MAX_PAGES };
  let bytes: Buffer;
  let report: Report;
  try { bytes = sources.readReport(); report = parseReport(bytes); }
  catch {
    return { ...base, status: "unknown", reason: "retirement report is missing, unreadable, invalid or over budget",
      observedAt: new Date(sources.now()).toISOString(), capturedAt: null, ageMs: null, refreshSucceeded: false,
      items: [], cursor: null, hasMore: false, coverage: "unknown" };
  }
  const fingerprint = crypto.createHash("sha256").update(request.project).update("\0").update(bytes).digest("hex");
  let offset = 0;
  let page = 0;
  if (request.cursor) {
    if (request.cursor.length > 512) throw new Error("retirement cursor is invalid");
    let parsed: { fingerprint?: unknown; offset?: unknown; page?: unknown };
    try { parsed = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")); }
    catch { throw new Error("retirement cursor is invalid"); }
    if (parsed?.fingerprint !== fingerprint) throw new Error("retirement report or project changed; restart without the cursor");
    if (!Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0
      || !Number.isSafeInteger(parsed.page) || Number(parsed.page) < 1 || Number(parsed.page) >= RETIREMENT_MAX_PAGES) {
      throw new Error("retirement cursor is invalid");
    }
    offset = Number(parsed.offset);
    page = Number(parsed.page);
  }
  const groups = [report.refused, report.failed, report.retired];
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  if (offset > total) throw new Error("retirement cursor is invalid");
  const items: Record<string, unknown>[] = [];
  const deadline = sources.now() + 1000;
  let scanned = 0;
  let scopeUnknown = false;
  while (offset < total && scanned < RETIREMENT_SCAN_LIMIT && items.length < limit && sources.now() < deadline) {
    let index = offset++;
    scanned++;
    let group = 0;
    while (index >= groups[group]!.length) index -= groups[group++]!.length;
    const row = groups[group]![index];
    if (!row || typeof row.key !== "string" || typeof row.conversationId !== "string") { scopeUnknown = true; continue; }
    if (group === 0 && (typeof row.reason !== "string" || typeof row.clause !== "string"
      || (row.undetermined !== undefined && row.undetermined !== true))
      || group === 1 && typeof row.error !== "string"
      || group === 2 && !["runtime", "process-group", "already-exited"].includes(row.via ?? "")) {
      scopeUnknown = true; continue;
    }
    const key = /^(claude|codex|copilot):([0-9a-f-]{36})$/i.exec(row.key);
    if (!key) { scopeUnknown = true; continue; }
    let subject: Subject;
    try { subject = sources.subject(row.conversationId, row.key); }
    catch { scopeUnknown = true; continue; }
    const conversation = subject.conversation;
    // A missing project or generation is never permission to disclose a target.
    const project = subjectProject(subject);
    if (!project || conversation?.id !== row.conversationId || conversation.engine !== key[1]
      || !conversation.generations.some((generation) => generation.id === key[2])) { scopeUnknown = true; continue; }
    if (project !== request.project) continue;
    const observedAt = new Date(sources.now()).toISOString();
    const result = group === 0 ? row.undetermined === true ? "undetermined" : "refused" : group === 1 ? "failed" : "retired";
    const entry = subject.entry?.key.engine === key[1] && subject.entry.key.sessionId === key[2] ? subject.entry : null;
    const process = entry?.structuredHost?.process;
    items.push({
      project: request.project, conversationId: row.conversationId, sessionKey: row.key, generationId: key[2],
      operationId: null, process: null,
      identityReason: "the sweep report does not record an operation ID or a pinned process identity",
      phase: group === 0 ? "evaluation" : "termination", result,
      clause: typeof row.clause === "string" ? row.clause : null,
      reason: String(row.reason ?? row.error ?? "retirement recorded by the sweep").slice(0, 2000),
      startedAt: report.startedAt, finishedAt: report.finishedAt, timestampScope: "sweep", observedAt,
      current: { source: "registry", observedAt, generationId: key[2], conversationGenerationId: conversation.generations.at(-1)?.id ?? null,
        registryStatus: entry?.status ?? null, registryUpdatedAt: entry?.updatedAt ?? null,
        process: process ? { pid: process.pid, startIdentity: process.startIdentity, bootEpoch: process.bootEpoch ?? null } : null,
        ownership: "unknown", ownershipReason: "registry identity does not establish current process ownership or liveness" },
    });
  }
  const exhausted = offset < total && page + 1 >= RETIREMENT_MAX_PAGES;
  const hasMore = offset < total && !exhausted;
  return { ...base, status: scopeUnknown || exhausted ? "unknown" : "observed", observedAt: new Date(sources.now()).toISOString(),
    capturedAt: report.finishedAt, ageMs: Math.max(0, sources.now() - Date.parse(report.finishedAt)), refreshSucceeded: true,
    refreshMeaning: "report reread; no sweep requested", items, hasMore,
    cursor: hasMore ? Buffer.from(JSON.stringify({ fingerprint, offset, page: page + 1 })).toString("base64url") : null,
    coverage: exhausted ? "page-budget-exhausted" : scopeUnknown ? "project-attribution-incomplete" : "latest-report-only",
    history: "earlier individual refusals are not retained; absence does not prove completion" };
}

/** Attributed identities are accepted only from the authenticated MCP control
    hop. Seat authority was checked against the same designation as seat tools;
    worker authority still requires a keyed receipt belonging to that session. */
export type RetirementReadAuthentication =
  | { launchId: string; capability: string }
  | { conversationId: string; launchId: string }
  | { conversationId: string; seatProject: string };

export function readRetirementStatus(request: RetirementStatusRequest, authentication: RetirementReadAuthentication) {
  request = { ...request, project: canonicalProject(request.project) };
  let store: SqliteAgentRegistryStore | null = null;
  try {
    if ("capability" in authentication && !/^[A-Za-z0-9_-]{43}$/.test(authentication.capability)) throw new Error("retirement observation requires a Viewer spawn capability");
    const filename = statePath("agent-registry.json");
    const backend = resolveRegistryBackend(filename, process.env);
    if ((backend.mode !== "sqlite" && backend.mode !== "read") || backend.pendingJsonImport) {
      throw new Error("bounded retirement authorization is unavailable for this registry backend");
    }
    const sqlite = backend.sqliteFilename ?? defaultRegistrySqliteFilename(filename);
    if (!fs.existsSync(sqlite)) throw new Error("retirement registry is unavailable");
    store = new SqliteAgentRegistryStore(sqlite, { readOnly: true, normalize: normalizeRegistry,
      initialSnapshot: () => { throw new Error("retirement observation never imports state"); } });
    const callerId = "seatProject" in authentication ? authentication.conversationId
      : store.retirementCaller(authentication.launchId, "capability" in authentication
        ? crypto.createHash("sha256").update(authentication.capability).digest("hex")
        : { conversationId: authentication.conversationId });
    const caller = callerId ? store.retirementSubject(callerId, "").conversation : null;
    const ownProject = caller?.projectOwnership?.project ? canonicalProject(caller.projectOwnership.project) : null;
    const project = "seatProject" in authentication ? canonicalProject(authentication.seatProject) : ownProject;
    if (!caller || project !== request.project || (ownProject && ownProject !== request.project)) {
      throw new Error("retirement observation requires the authenticated caller's project and spawn receipt");
    }
    const reader = store;
    return projectRetirementStatus(request, {
      readReport, now: Date.now,
      subject: (conversationId, key) => reader.retirementSubject(conversationId, key),
    });
  } finally { store?.close(); }
}
