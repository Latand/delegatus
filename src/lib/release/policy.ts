export interface ReleaseDeployment { revision: string; at: number }
export interface ReleaseChange { subject: string; files: string[] }
export interface ReleaseInput {
  now: number; enabled: boolean; requested: boolean; tickEnabled: boolean; mergeEnabled: boolean;
  live: boolean; mainVersion: string; lastTag: { name: string; version: string; at: number };
  registryHasTag: boolean; checks: "green" | "red" | "pending"; hold: string | null;
  draining: boolean; deploying: boolean; tools: string[]; minChanges: number; minGapHours: number;
  changes: ReleaseChange[]; deployments: ReleaseDeployment[];
  isAncestor: (a: string, b: string) => boolean | Promise<boolean>;
  settled?: { cut: string; at: number; outcome: "published" | "failed" | "declined" } | null;
}
export interface ReleaseDecision {
  state: "due" | "not-due" | "blocked" | "in-flight";
  blocker: number | null; reason: string; cut: ReleaseDeployment | null; count: number;
}
export function classifyPaths(files: string[], subject = ""): "visible" | "internal" | "docs" | "release" {
  if (/^Release\s+\d+\.\d+\.\d+/i.test(subject)) return "release";
  const docs = (f: string) => /^(docs|evidence)\//.test(f) || /\.(md|mdx|txt)$/.test(f);
  const internal = (f: string) => docs(f) || /^(scripts|\.github|\.githooks|security|landing)\//.test(f)
    || /\.(test|fixture)\./.test(f) || /(^|\/)__fixtures__\//.test(f);
  return files.every(docs) ? "docs" : files.every(internal) ? "internal" : "visible";
}
/** Newest revision served for six hours and retained by every later success. */
export async function releaseCut(deployments: ReleaseDeployment[], isAncestor: ReleaseInput["isAncestor"], now: number): Promise<ReleaseDeployment | null> {
  const sorted = [...deployments].sort((a, b) => b.at - a.at);
  for (let i = 0; i < sorted.length; i++) {
    const candidate = sorted[i];
    if (!Number.isFinite(candidate.at) || now - candidate.at < 6 * 3_600_000) continue;
    let retained = true;
    for (const later of sorted.slice(0, i)) if (!await isAncestor(candidate.revision, later.revision)) { retained = false; break; }
    if (retained) return candidate;
  }
  return null;
}
export async function releaseState(input: ReleaseInput): Promise<ReleaseDecision> {
  const count = input.changes.filter(c => classifyPaths(c.files, c.subject) === "visible").length;
  const cut = await releaseCut(input.deployments, input.isAncestor, input.now);
  const answer = (state: ReleaseDecision["state"], blocker: number | null, reason: string): ReleaseDecision => ({ state, blocker, reason, cut, count });
  if (!input.enabled && !input.requested) return answer("blocked", 1, "releases-off");
  if (!input.tickEnabled) return answer("blocked", 2, "tick-off");
  if (!input.mergeEnabled) return answer("blocked", 3, "merge-off");
  if (input.live || input.mainVersion !== input.lastTag.version || !input.registryHasTag) return answer("in-flight", 4, "release-in-flight");
  if (input.checks !== "green") return answer("blocked", 5, input.checks === "red" ? "checks-red" : "checks-pending");
  const serving = [...input.deployments].sort((a, b) => b.at - a.at)[0];
  for (const d of input.deployments) {
    if (serving && d.at >= input.lastTag.at && !await input.isAncestor(d.revision, serving.revision)) return answer("blocked", 6, "rollback");
  }
  if (input.hold) return answer("blocked", 7, "hold");
  if (!cut) return answer("blocked", 8, "no-cut");
  if (input.deploying || input.draining) return answer("blocked", 9, input.draining ? "draining" : "deploying");
  if (input.tools.length) return answer("blocked", 10, `capture-tools: ${input.tools.join(", ")}`);
  if (!input.requested) {
    if (input.settled?.outcome === "declined" && input.settled.cut === cut.revision) return answer("not-due", null, "declined-cut");
    const gapFrom = Math.max(input.lastTag.at, input.settled?.at ?? 0);
    if (input.now - gapFrom < input.minGapHours * 3_600_000) return answer("not-due", null, "gap");
    if (count < input.minChanges) return answer("not-due", null, "changes");
  }
  return answer("due", null, input.requested ? "requested" : "amount");
}
