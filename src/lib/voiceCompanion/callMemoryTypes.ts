/** Local call-journal data; never part of agent memory or bridge reports. */
export interface CallSummary {
  version: 1;
  state: "checkpoint" | "final" | "failed" | "cleared";
  through: number;
  startedAt: number;
  endedAt: number | null;
  projects: string[];
  asked: string[];
  done: string[];
  decided: string[];
  open: string[];
  privateOmitted: boolean;
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
  pending?: boolean;
  code?: "account" | "timeout" | "invalid" | "failed";
}
export interface CallMemoryRow { sessionId: string; summary: CallSummary }
export const summaryText = (summary: Pick<CallSummary, "asked" | "done" | "decided" | "open">): string =>
  ([["Asked", summary.asked], ["Done", summary.done], ["Decided", summary.decided], ["Still open", summary.open]] as const)
    .filter(([, items]) => items.length).map(([label, items]) => `${label}: ${items.join("; ")}`).join(". ");

export function validCallSummary(value: unknown): value is CallSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string,unknown>;
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (row.version !== 1 || !["checkpoint","final","failed","cleared"].includes(String(row.state))
    || !Number.isSafeInteger(row.through) || (row.through as number) < -1 || !Number.isFinite(row.startedAt)
    || !(row.endedAt === null || Number.isFinite(row.endedAt)) || typeof row.privateOmitted !== "boolean"
    || typeof row.model !== "string" || row.model.length > 80 || !Number.isFinite(row.durationMs) || (row.durationMs as number) < 0
    || !count(row.inputTokens) || !count(row.outputTokens) || !count(row.attempts) || (row.attempts as number) > 3
    || (row.pending !== undefined && typeof row.pending !== "boolean")
    || (row.code !== undefined && !["account","timeout","invalid","failed"].includes(String(row.code)))) return false;
  for (const key of ["asked","done","decided","open","projects"]) {
    const items = row[key];
    if (!Array.isArray(items) || items.length > 4 || items.some(item => typeof item !== "string" || item.length > (key === "projects" ? 120 : 160))) return false;
  }
  return summaryText(row as unknown as CallSummary).length <= 600;
}
