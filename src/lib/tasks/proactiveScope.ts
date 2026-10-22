import { createHash } from "node:crypto";
import type { BoardTask } from "./types";

export function validProactiveProvenance(value: unknown): value is NonNullable<BoardTask["proactive"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as NonNullable<BoardTask["proactive"]>;
  return typeof row.episode === "string" && Number.isFinite(Date.parse(row.episode))
    && typeof row.candidateKey === "string" && !!row.candidateKey.trim() && row.candidateKey.length <= 200
    && Array.isArray(row.sources) && row.sources.length > 0 && row.sources.length <= 5
    && row.sources.every(source => typeof source === "string" && !!source.trim() && source.length <= 500)
    && Array.isArray(row.score) && row.score.length === 4 && row.score.every(score => Number.isInteger(score) && score >= 0 && score <= 2)
    && typeof row.scopeHash === "string" && /^[a-f0-9]{64}$/.test(row.scopeHash)
    && Number.isSafeInteger(row.scopeRevision) && row.scopeRevision >= 0;
}

/** Progress and presentation cannot authorize a different requested outcome. */
export function proactiveScopeHash(task: Pick<BoardTask, "project" | "text" | "details" | "steps" | "attachments">): string {
  return createHash("sha256").update(JSON.stringify({
    project: task.project, text: task.text, details: task.details ?? null,
    steps: (task.steps ?? []).map(step => ({ id: step.id, text: step.text, ref: step.ref ?? null })),
    attachments: (task.attachments ?? []).map(attachment => attachment.sha256),
  })).digest("hex");
}

export function proactiveScopeCurrent(task: BoardTask): boolean {
  return !!task.proactive && task.proactive.scopeRevision === 0 && task.proactive.scopeHash === proactiveScopeHash(task);
}

/** A restored old scope never revives a prior grant (including edit/restore ABA). */
export function retainProactiveScope(task: BoardTask, previous: BoardTask | undefined): void {
  if (!previous?.proactive) return;
  task.proactive = { ...previous.proactive, scopeRevision: previous.proactive.scopeRevision
    + (proactiveScopeHash(task) === proactiveScopeHash(previous) ? 0 : 1) };
}
