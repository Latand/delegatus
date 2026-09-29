/* Shared check verdict rules for auto-merge and self-update. */
/** Conclusions that make a check red (§4.3). */
const RED = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);


export type CheckVerdict = "pending" | "green" | "red";
export type ReadCheck = { name: string; verdict: CheckVerdict };

export type PullRequestView = {
  state: string;
  isDraft: boolean;
  headRefOid: string;
  baseRefName: string;
  mergeable: string | null;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  mergeCommit: string | null;
  mergedAt: string | null;
  checks: ReadCheck[];
};

function checkOf(entry: Record<string, unknown>): { name: string; verdict: CheckVerdict; at: number } | null {
  const started = Date.parse(typeof entry.startedAt === "string" ? entry.startedAt : "");
  const at = Number.isFinite(started) ? started : 0;
  if (entry.__typename === "StatusContext" || (typeof entry.context === "string" && entry.name === undefined)) {
    const name = typeof entry.context === "string" ? entry.context : "";
    const state = String(entry.state ?? "").toUpperCase();
    if (!name) return null;
    return { name, at, verdict: state === "SUCCESS" ? "green" : RED.has(state) ? "red" : "pending" };
  }
  const name = typeof entry.name === "string" ? entry.name : "";
  if (!name) return null;
  /* A pending run answers `conclusion: ""` and a zero `completedAt`. */
  const status = String(entry.status ?? "").toUpperCase();
  const conclusion = String(entry.conclusion ?? "").toUpperCase();
  if (status !== "COMPLETED") return { name, at, verdict: "pending" };
  return { name, at, verdict: RED.has(conclusion) ? "red" : GREEN.has(conclusion) ? "green" : "pending" };
}

/** One check per name: the newest run of it, since a re-run supersedes. */
export function rollupChecks(rollup: unknown): ReadCheck[] {
  const byName = new Map<string, { name: string; verdict: CheckVerdict; at: number }>();
  for (const entry of Array.isArray(rollup) ? rollup : []) {
    if (!entry || typeof entry !== "object") continue;
    const check = checkOf(entry as Record<string, unknown>);
    if (!check) continue;
    const previous = byName.get(check.name);
    if (!previous || check.at >= previous.at) byName.set(check.name, check);
  }
  return [...byName.values()].map(({ name, verdict }) => ({ name, verdict })).sort((a, b) => a.name.localeCompare(b.name));
}
