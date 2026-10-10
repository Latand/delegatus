import type { MaintenanceAttention } from "./types";

/** A decision names the next step waiting for an answer. Routine alternatives
    stay in the report history. Shared by server and browser projections. */
export function maintenanceDecision(row: MaintenanceAttention): boolean {
  return Boolean(row.nextStep?.trim() && row.options.filter(option => option.trim()).length >= 2);
}
