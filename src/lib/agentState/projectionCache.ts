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
export function clearAgentObservations(): void { rows.clear(); }
