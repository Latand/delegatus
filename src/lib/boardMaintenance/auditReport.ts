import fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { findSeatRound } from "@/lib/prototypeReview/seatRounds";
import type { BoardTask } from "@/lib/tasks/types";
import type { MaintenanceAuditInput, MaintenanceAuditOccurrence, MaintenanceAuditResult, MaintenanceAuditSource } from "./types";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const auditRequestKey = (occurrence: string, index: number) => `request-v1:${hash(occurrence)}:${index}`;
const auditSourceMarker = (key: string) => `Maintenance request: ${key}`;
const AUDIT_ROW_LIMIT = 200;
const AUDIT_BLOCK_BYTES = 32768;
const artifactIdentity = (file: string) => { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) throw Error("artifact unavailable"); return { artifact: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, size: stat.size }; };
const sameProject = (a: string, b: string) => canonicalOrchestratorProject(a) === canonicalOrchestratorProject(b);
function decisionPayload(round: { questions: unknown; variants: Array<{ number: number; name: string; description: string }>; decision?: unknown }) {
  return JSON.stringify({ questions: round.questions, variants: round.variants.map(v => ({ number: v.number, name: v.name, description: v.description })), decision: { ...(round.decision as Record<string, unknown>), delivery: undefined, telegramUserId: undefined } });
}
function currentAuditDecision(source: MaintenanceAuditSource, tasks: readonly BoardTask[]) {
  const reference = source.decision;
  if (!reference) return null;
  return reference.taskId ? tasks.find(t => t.id === reference.taskId)?.prototypeReviews?.find(r => r.id === reference.roundId) ?? null : findSeatRound(reference.roundId);
}
const instant = z.string().datetime({ offset: true });
const preview = z.string().max(300);
const rowSchema = z.object({ key: z.string().min(1), occurrence: z.string().min(1), requestIndex: z.number().int().nonnegative(), at: instant, request: preview,
  outcome: z.enum(["done", "running", "filed", "updated", "cancelled", "unverified"]), taskId: z.string().min(1).nullable(), code: preview, merge: preview, install: preview, acceptance: preview, checkedAt: instant, next: preview,
  dueAt: instant.nullable(), dueTz: z.string().max(100).nullable(), mutation: z.object({ key: z.string().min(1), state: z.enum(["readback", "uncertain"]) }).strict().nullable() }).strict();
const manifestSchema = z.object({ version: z.literal(1), runId: z.string(), revision: z.number().int().nonnegative(), lower: instant, upper: instant, rows: z.number().int().min(0).max(AUDIT_ROW_LIMIT), occurrences: z.array(z.object({ key: z.string(), requests: z.number().int().min(0).max(100000), nextIndex: z.number().int().min(0).max(100000) }).strict()).max(AUDIT_ROW_LIMIT) }).strict();

export function parseMaintenanceAudit(text: string, input: MaintenanceAuditInput, tasks: readonly BoardTask[]): MaintenanceAuditResult {
  const result: MaintenanceAuditResult = { version: 1, rows: [], manifest: null, complete: false, error: null, window: structuredClone(input.window) };
  const refuse = (reason: string) => ({ ...result, error: reason });
  if (Buffer.byteLength(text) > 100 * 1024 || Buffer.byteLength(JSON.stringify(text)) > 112 * 1024) return refuse("final-transport-budget");
  const lines = (text.match(/.*(?:\n|$)/g) ?? []).filter(l => /^audit-/i.test(l.trimStart()));
  if (Buffer.byteLength(lines.join("")) > AUDIT_BLOCK_BYTES) {
    let bytes = 0;
    for (const line of lines) { bytes += Buffer.byteLength(line); if (bytes > AUDIT_BLOCK_BYTES) {
      try { const locator = JSON.parse(line.slice(line.indexOf(":") + 1)).occurrence; result.refusedOccurrence = input.occurrences.find(o => o.key === locator)?.key ?? input.occurrences[0]?.key ?? null; } catch { result.refusedOccurrence = input.occurrences[0]?.key ?? null; }
      break;
    } }
    return refuse("audit-byte-budget");
  }
  try {
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("audit-row:") && !line.startsWith("audit-manifest:")) return refuse("unknown-audit-record");
      const payload = JSON.parse(line.slice(line.indexOf(":") + 1));
      if (line.startsWith("audit-row:")) {
        if (result.manifest || result.rows.length >= AUDIT_ROW_LIMIT) return refuse("row-order-or-limit");
        result.rows.push(rowSchema.parse(payload));
      } else {
        if (result.manifest) return refuse("duplicate-manifest");
        result.manifest = manifestSchema.parse(payload);
      }
    }
  } catch { return refuse("malformed-audit-record"); }
  const m = result.manifest;
  if (!m || m.runId !== input.runId || m.revision !== input.revision || m.lower !== input.window.lower || m.upper !== input.window.upper || m.rows !== result.rows.length) return refuse("manifest-identity-or-count");
  if (m.occurrences.length !== input.occurrences.length || new Set(m.occurrences.map(o => o.key)).size !== m.occurrences.length) return refuse("occurrence-manifest-incomplete");
  const keys = new Set<string>();
  for (const row of result.rows) {
    const occurrence = input.occurrences.find(o => o.key === row.occurrence);
    if (!occurrence || row.key !== auditRequestKey(occurrence.key, row.requestIndex) || row.at !== occurrence.at || Date.parse(row.checkedAt) < Date.parse(input.snapshotAt) || keys.has(row.key)) return refuse("row-identity-conflict");
    keys.add(row.key);
    if (!occurrence.verified && row.outcome !== "unverified") return refuse("row-author-unverified");
    if (row.mutation && row.mutation.key !== row.key) return refuse("mutation-identity-conflict");
    if (row.outcome === "filed" || row.outcome === "updated" || row.mutation?.state === "readback") {
      const task = tasks.find(t => t.id === row.taskId);
      if (!task || !sameProject(task.project, input.project) || !task.details?.split("\n").includes(auditSourceMarker(row.key)) || row.mutation?.key !== row.key || row.mutation.state !== "readback" || row.dueAt !== (task.dueAt ?? null) || row.dueTz !== (task.dueTz ?? null)) return refuse("task-effect-unverified");
    }
    if (row.dueTz) { try { new Intl.DateTimeFormat("en", { timeZone: row.dueTz }); } catch { return refuse("invalid-due-zone"); } }
  }
  for (const occurrence of input.occurrences) {
    const entry = m.occurrences.find(o => o.key === occurrence.key);
    if (!entry || entry.nextIndex < occurrence.requestIndex || entry.nextIndex > entry.requests) return refuse("occurrence-prefix-invalid");
    const rows = result.rows.filter(r => r.occurrence === occurrence.key).sort((a, b) => a.requestIndex - b.requestIndex);
    if (rows.length !== entry.nextIndex - occurrence.requestIndex || rows.some((r, i) => r.requestIndex !== occurrence.requestIndex + i)) return refuse("request-prefix-gap");
  }
  for (const source of result.window.sources) {
    if (source.complete || source.gap) continue;
    if (source.kind === "transcript") {
      try {
        const current = artifactIdentity(source.path!);
        if (current.artifact !== source.artifact || current.size < source.size) { source.gap = "artifact-replaced"; continue; }
      } catch { source.gap = "artifact-unavailable"; continue; }
    }
    if (source.kind === "decision") {
      const current = currentAuditDecision(source, tasks);
      if (!current?.decision || (current.decision.revision ?? 0) !== source.decision?.revision || hash(decisionPayload(current)) !== source.artifact) { source.gap = "decision-replaced"; continue; }
    }
    const occurrences = input.occurrences.filter(o => o.source === source.key);
    let blocked = false;
    for (const o of occurrences) {
      const entry = m.occurrences.find(e => e.key === o.key)!;
      const unverified = result.rows.find(r => r.occurrence === o.key && (r.outcome === "unverified" || r.mutation?.state === "uncertain"));
      if (o.gap || !o.verified || unverified || entry.nextIndex < entry.requests) {
        source.from = { seq: o.seq, ...(o.part ? { part: o.part } : {}), requestIndex: unverified?.requestIndex ?? (o.gap || !o.verified ? o.requestIndex : entry.nextIndex) }; blocked = true; break;
      }
    }
    if (!blocked) { source.from = structuredClone(input.unread[source.key] ?? null);
      const last = occurrences.at(-1);
      if (source.from && last?.seq === source.from.seq && (source.from.part ?? 0) === last.part) source.from.requestIndex = m.occurrences.find(e => e.key === last.key)!.requests;
      source.complete = source.from === null; }
  }
  result.complete = result.window.decisionScanComplete !== false && !result.window.gaps.length && result.window.sources.every(s => s.complete && !s.gap);
  return result;
}
