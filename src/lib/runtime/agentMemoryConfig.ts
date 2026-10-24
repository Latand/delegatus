/** Shared by server validation and browser cap displays; no state imports. */
export const MIN_AGENT_MEMORY_BYTES = 2 ** 30;
export const MAX_AGENT_MEMORY_BYTES = 2 ** 40;
export function validAgentMemoryMax(value: unknown): value is number | null | undefined {
  return value == null || (typeof value === "number" && Number.isSafeInteger(value)
    && value >= MIN_AGENT_MEMORY_BYTES && value <= MAX_AGENT_MEMORY_BYTES);
}
export function assertAgentMemoryMax(value: unknown): asserts value is number | null | undefined {
  if (!validAgentMemoryMax(value)) throw new Error("agentMemoryMaxBytes must be null or integer bytes from 1 GiB through 1 TiB");
}
export type AgentMemoryScopes = { project?: number | null; role?: number | null; stage?: number | null };
export type AgentMemoryCap = {
  limitBytes: number | null;
  requestedBytes: number | null;
  source: "automatic" | "installation" | "project" | "role" | "stage";
  clamped: boolean;
  enforced: boolean;
  note?: string;
};
export function normalizeAgentMemoryCap(value: unknown): AgentMemoryCap | null {
  if (!value || typeof value !== "object") return null;
  const cap = value as AgentMemoryCap;
  const bytes = (n: unknown) => n === null || (typeof n === "number" && Number.isSafeInteger(n) && n > 0);
  if (!bytes(cap.limitBytes) || !bytes(cap.requestedBytes)
    || !["automatic", "installation", "project", "role", "stage"].includes(cap.source)
    || typeof cap.clamped !== "boolean" || typeof cap.enforced !== "boolean"
    || (cap.enforced && cap.limitBytes === null)) return null;
  return { limitBytes: cap.limitBytes, requestedBytes: cap.requestedBytes, source: cap.source,
    clamped: cap.clamped, enforced: cap.enforced,
    ...(cap.clamped ? { note: "Requested memory cap clamped to the shared machine budget." } : !cap.enforced ? { note: "Agent memory containment is off or unavailable." } : {}) };
}
