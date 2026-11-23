import type { AgentProjection } from "./model";

// Only the serving reconciler writes volatile observation freshness. Persisted
// semantic rows retain their revision and journal identity on a no-op cycle.
const shared = globalThis as typeof globalThis & { __agentStateObservations?: Map<string, AgentProjection> };
const rows = shared.__agentStateObservations ??= new Map<string, AgentProjection>();
export function cacheAgentObservation(row: AgentProjection): void {
  rows.delete(row.subject); rows.set(row.subject, row);
  while (rows.size > 4096) rows.delete(rows.keys().next().value!);
}
export function cachedAgentObservation(subject: string): AgentProjection | null {
  return rows.get(subject) ?? null;
}
/** Current-process evidence can be fresher than the durable semantic row.
 * Callers must still bind it to the current subject revision and validate each
 * fact's validity window before using it to authorize an effect. */
export function cachedAgentObservationForRevision(subject: string, revision: string): AgentProjection | null {
  const row = rows.get(subject) ?? null;
  return row?.facts.revision === revision ? row : null;
}
export function clearAgentObservations(): void { rows.clear(); }
