/* Shared check verdict rules for auto-merge and self-update. */
/** Conclusions that make a check red (§4.3). */
const RED = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);


export type CheckVerdict = "pending" | "green" | "red";
export type ReadCheck = { name: string; verdict: CheckVerdict; source?: "status" | "check"; appId?: number | null; workflow?: string | null };

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

type CheckSource = "status" | "check";

function checkOf(entry: Record<string, unknown>): { name: string; source: CheckSource; verdict: CheckVerdict; at: number; appId?: number | null; workflow?: string | null } | null {
  const started = Date.parse(typeof entry.startedAt === "string" ? entry.startedAt : "");
  const at = Number.isFinite(started) ? started : 0;
  if (entry.__typename === "StatusContext" || (typeof entry.context === "string" && entry.name === undefined)) {
    const name = typeof entry.context === "string" ? entry.context : "";
    const state = String(entry.state ?? "").toUpperCase();
    if (!name) return null;
    return { name, source: "status", appId: null, workflow: null, at, verdict: state === "SUCCESS" ? "green" : RED.has(state) ? "red" : "pending" };
  }
  const name = typeof entry.name === "string" ? entry.name : "";
  if (!name) return null;
  /* A pending run answers `conclusion: ""` and a zero `completedAt`. */
  const status = String(entry.status ?? "").toUpperCase();
  const conclusion = String(entry.conclusion ?? "").toUpperCase();
  const app = entry.app && typeof entry.app === "object" ? entry.app as Record<string, unknown> : {};
  const appId = typeof app.id === "number" && Number.isSafeInteger(app.id) ? app.id : null;
  const suite = entry.checkSuite && typeof entry.checkSuite === "object" ? entry.checkSuite as Record<string, unknown> : {};
  const workflowRun = suite.workflowRun && typeof suite.workflowRun === "object" ? suite.workflowRun as Record<string, unknown> : {};
  const workflow = workflowRun.workflow && typeof workflowRun.workflow === "object"
    ? workflowRun.workflow as Record<string, unknown> : {};
  const workflowName = typeof workflow.name === "string" && workflow.name.length ? workflow.name : null;
  const verdict = status !== "COMPLETED" ? "pending"
    : RED.has(conclusion) ? "red" : GREEN.has(conclusion) ? "green" : "pending";
  return { name, source: "check", appId, workflow: workflowName, at, verdict };
}

/** Keep independent sources and workflows separate; only a proved app/workflow rerun supersedes. */
export function rollupChecksWithIdentity(rollup: unknown): ReadCheck[] {
  const byIdentity = new Map<string, NonNullable<ReturnType<typeof checkOf>> & { ambiguous?: boolean }>();
  const unproven: Array<NonNullable<ReturnType<typeof checkOf>>> = [];
  for (const entry of Array.isArray(rollup) ? rollup : []) {
    if (!entry || typeof entry !== "object") continue;
    const check = checkOf(entry as Record<string, unknown>);
    if (!check) continue;
    const identity = check.source === "status" ? `status\0${check.name}`
      : check.appId !== null && check.workflow !== null ? `check\0${check.appId}\0${check.workflow}\0${check.name}` : null;
    if (identity === null) { unproven.push(check); continue; }
    const previous = byIdentity.get(identity);
    if (!previous || check.at > previous.at) byIdentity.set(identity, check);
    else if (check.at === previous.at && check.verdict !== previous.verdict) byIdentity.set(identity, { ...check, verdict: "pending", ambiguous: true });
  }
  const unresolved = new Map<string, number>();
  for (const check of unproven) {
    const identity = `${check.appId ?? "unknown"}\0${check.name}`;
    unresolved.set(identity, (unresolved.get(identity) ?? 0) + 1);
  }
  const checks = [...byIdentity.values(), ...unproven.map(check => ({
    ...check, verdict: (unresolved.get(`${check.appId ?? "unknown"}\0${check.name}`) ?? 0) > 1 ? "pending" as const : check.verdict,
  }))];
  return checks
    .map(({ name, source, appId, workflow, verdict }) => ({ name, verdict, source, appId, workflow }))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.source ?? "").localeCompare(b.source ?? "")
      || (a.workflow ?? "").localeCompare(b.workflow ?? "") || (a.appId ?? -1) - (b.appId ?? -1));
}

/** Compact projection used by consumers that only need names and verdicts. */
export function rollupChecks(rollup: unknown): ReadCheck[] {
  return rollupChecksWithIdentity(rollup).map(({ name, verdict }) => ({ name, verdict }));
}
