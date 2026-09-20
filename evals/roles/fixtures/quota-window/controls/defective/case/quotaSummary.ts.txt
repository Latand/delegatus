import { routeWindowsByHorizon } from "../support/routeWindowsByHorizon";
export type Input = { primary?: { usedPercent: number; windowMinutes?: number | null; resetsAt?: number | null } | null; secondary?: Input["primary"]; capturedAt?: number | null };
export function quotaSummary(input: Input): { session: number | null; weekly: number | null } {
  return { session: input.primary?.usedPercent ?? null, weekly: input.secondary?.usedPercent ?? null };
}
