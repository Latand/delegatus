/*
 * Reads chosen lanes and their tasks from a Delegatus state store, read-only,
 * and writes them as the prototype's card data with nothing that names a
 * person, an account, a path, a commit or a conversation
 * (docs/design/calm-task-cards.md §6.1).
 *
 *   bun docs/design/calm-task-cards/extract.ts <state.sqlite> <snapshot ISO> <out.json> <laneId>=<label> ...
 *
 * The snapshot instant rewinds a lane that moved after it: attempts that
 * started later, and pending attempts with no start, are dropped, and a lane
 * whose latest remaining attempt parked is parked again, as the board read it.
 * Every lane on a chosen lane's task comes along, so the card is whole.
 */
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

const [store, snapshotIso, out, ...picks] = process.argv.slice(2);
if (!store || !snapshotIso || !out || !picks.length) throw new Error("usage: extract.ts <state.sqlite> <snapshot ISO> <out.json> <laneId>=<label> ...");
const SNAPSHOT = Date.parse(snapshotIso);
const db = new Database(store, { readonly: true });

type Json = Record<string, unknown>;
const rows = (collection: string) => (db.query("select value_json from state_rows where collection = ?").all(collection) as { value_json: string }[]).map((row) => JSON.parse(row.value_json) as Json);
const pipelines = rows("pipelines");
const tasks = new Map(rows("tasks").map((task) => [task.id as string, task]));

const labels = new Map(picks.map((pick) => pick.split("=") as [string, string]));
const chosen = pipelines.filter((pipeline) => labels.has(pipeline.id as string));
const taskIds = new Set(chosen.flatMap((pipeline) => (pipeline.taskIds as string[] | undefined) ?? []));
const lanes = pipelines.filter((pipeline) => ((pipeline.taskIds as string[] | undefined) ?? []).some((id) => taskIds.has(id)));
for (const lane of lanes) if (!labels.has(lane.id as string)) labels.set(lane.id as string, `${labels.get(chosen.find((pick) => (pick.taskIds as string[]).some((id) => ((lane.taskIds as string[]) ?? []).includes(id)))!.id as string)}-earlier-${labels.size}`);
const taskLabel = new Map([...taskIds].map((id) => [id, `t-${labels.get(chosen.find((pick) => (pick.taskIds as string[]).includes(id))!.id as string)}`]));

/* The names this machine's accounts go by and the forge owners its lanes
   publish to, read from the store and the account folders beside it, so no
   name is written into this file. */
const PRIVATE_WORDS = new Set<string>();
for (const row of rows("accounts")) {
  const key = typeof row.k === "string" ? row.k : "";
  const value = (row.v ?? {}) as Json;
  if (/^(claude|codex):/.test(key)) for (const name of [value.id, value.label]) if (typeof name === "string") PRIVATE_WORDS.add(name);
}
const accountsRoot = path.join(path.dirname(path.dirname(path.resolve(store))), "accounts");
for (const engine of fs.existsSync(accountsRoot) ? fs.readdirSync(accountsRoot) : []) {
  const folder = path.join(accountsRoot, engine);
  if (fs.statSync(folder).isDirectory()) for (const name of fs.readdirSync(folder)) PRIVATE_WORDS.add(name);
}
for (const pipeline of pipelines) {
  const remote = ((pipeline.delivery as Json | undefined)?.target as Json | undefined)?.remote;
  const owner = typeof remote === "string" ? /[:/]([^/:]+)\/[^/]+$/.exec(remote)?.[1] : undefined;
  if (owner) PRIVATE_WORDS.add(owner);
}
for (const word of [...PRIVATE_WORDS]) if (word.length < 4 || word === "default") PRIVATE_WORDS.delete(word);

/* Words that would name a person, an account, a machine path or a record. */
function scrub(text: unknown, max = 700): string | null {
  if (typeof text !== "string") return null;
  let value = text
    .replace(/\/home\/[^\s"'`)\]]+/g, "$HOME/…")
    .replace(/\/(?:tmp|var\/tmp)\/[^\s"'`)\]]+/g, "/tmp/…")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/conversation_[0-9a-f-]{8,}/gi, "a conversation")
    .replace(/\bpr_[0-9a-f]{6,}…?/gi, "a review round")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/gi, "<id>")
    .replace(/github\.com\/[\w.-]+/gi, "forge/owner");
  for (const word of PRIVATE_WORDS) value = value.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "account");
  for (const [real, label] of labels) value = value.replaceAll(real, label);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const at = (value: unknown): number => Date.parse(typeof value === "string" ? value : "");
const role = (value: unknown) => {
  const source = (value ?? {}) as Json;
  return { roleId: source.roleId ?? null, engine: source.engine ?? null, model: source.model ?? null, effort: source.effort ?? null, access: source.access ?? null, promptScaffold: null };
};
const verdict = (value: unknown) => {
  if (!value || typeof value !== "object") return null;
  const source = value as Json;
  return {
    status: source.status,
    ...(Array.isArray(source.findings) ? { findings: source.findings.map((finding) => scrub(finding, 240)) } : {}),
    ...(Array.isArray(source.rankedFindings) ? { rankedFindings: (source.rankedFindings as Json[]).map((finding) => ({ severity: finding.severity ?? null, text: scrub(finding.text, 240) })) } : {}),
  };
};

function attempt(source: Json) {
  const report = source.report as Json | undefined;
  return {
    n: source.n, state: source.state, effectiveRole: role(source.effectiveRole),
    launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
    startedAt: source.startedAt ?? null, completedAt: source.completedAt ?? null,
    input: null, activatedBy: source.activatedBy ?? null, output: null,
    verdict: verdict(source.verdict), error: scrub(source.error, 400),
    ...(report ? { report: { seq: report.seq ?? 0, at: report.at ?? null, actor: { kind: ((report.actor ?? {}) as Json).kind ?? "agent" }, verdict: verdict(report.verdict), summary: scrub(report.summary, 360), provenance: {}, calls: report.calls ?? 1 } } : {}),
  };
}

function lane(source: Json) {
  const runs = ((source.runs as Json[]) ?? []).map((run) => ({
    stageId: run.stageId,
    attempts: ((run.attempts as Json[]) ?? []).filter((entry) => {
      const started = at(entry.startedAt);
      return Number.isFinite(started) ? started <= SNAPSHOT : entry.state !== "pending";
    }).map(attempt),
  }));
  let { state, stateDetail } = source as { state: unknown; stateDetail: unknown };
  const stored = source.cursor as Json | null;
  let cursor: Json | null = stored ? { stageId: stored.stageId, state: stored.state, input: null, activatedBy: null } : null;
  const dropped = runs.reduce((n, run) => n + run.attempts.length, 0) < ((source.runs as Json[]) ?? []).reduce((n, run) => n + ((run.attempts as Json[]) ?? []).length, 0);
  if (dropped) {
    const latest = runs.flatMap((run) => run.attempts.map((entry) => ({ run, entry }))).sort((a, b) => at(a.entry.startedAt) - at(b.entry.startedAt)).at(-1);
    if (latest?.entry.state === "needs_decision") {
      state = "needs_decision";
      cursor = { stageId: latest.run.stageId, state: latest.entry.verdict?.status === "pass" ? "committing" : "pending", input: null, activatedBy: null };
      stateDetail = latest.entry.error;
    }
  }
  const merge = source.merge as Json | undefined;
  return {
    id: labels.get(source.id as string), task: scrub(source.task, 300), taskIds: ((source.taskIds as string[]) ?? []).map((id) => taskLabel.get(id) ?? "t-other"),
    project: "delegatus", repoDir: "/repo", worktreeDir: "/repo-lane", branch: "pipeline/sample", baseBranch: "main", baseRef: "main", lastPassedCommit: "",
    stages: ((source.stages as Json[]) ?? []).map((stage) => ({
      id: stage.id, kind: stage.kind, role: stage.role ?? null, next: stage.next ?? null, onFail: stage.onFail ?? null, access: stage.access ?? undefined,
      engine: stage.engine ?? undefined, prompt: `Stage ${stage.id as string}.`, effectiveRole: role(stage.effectiveRole),
    })),
    runs, cursor, state, pausedState: null, stateDetail: scrub(stateDetail, 400),
    srcPath: null, srcConversationId: source.srcConversationId ? "a seat conversation" : null,
    createdAt: source.createdAt, closedAt: source.closedAt ?? null,
    ...(source.dismissedAt ? { dismissedAt: source.dismissedAt, dismissedBy: { kind: ((source.dismissedBy ?? { kind: "operator" }) as Json).kind } } : {}),
    ...(source.mergeOnReview !== undefined ? { mergeOnReview: source.mergeOnReview } : {}),
    ...(Array.isArray(source.finishesTaskIds) ? { finishesTaskIds: (source.finishesTaskIds as string[]).map((id) => taskLabel.get(id) ?? "t-other") } : {}),
    ...(merge ? { merge: {
      state: merge.state, by: merge.by ?? null, repository: "owner/delegatus", prNumber: merge.prNumber ?? null, reason: merge.reason ?? null,
      requestedAt: merge.requestedAt ?? null, blockedAt: merge.blockedAt ?? null, updatedAt: merge.updatedAt ?? null, mergedAt: merge.mergedAt ?? null,
      chain: [], updates: [], seenChecks: [], attempts: merge.attempts ?? 0, readFailures: 0,
    } } : {}),
    stageReports: ((source.stageReports as Json[]) ?? []).filter((entry) => at(entry.at) <= SNAPSHOT).map((entry) => ({
      seq: entry.seq, at: entry.at, actor: { kind: ((entry.actor ?? {}) as Json).kind ?? "agent" }, stageId: entry.stageId, attempt: entry.attempt,
      status: entry.status, findings: entry.findings ?? 0, replaces: entry.replaces ?? null, summary: scrub(entry.summary, 360),
    })),
  };
}

const data = {
  snapshot: new Date(SNAPSHOT).toISOString(),
  tasks: [...taskIds].map((id) => {
    const task = tasks.get(id)!;
    return {
      id: taskLabel.get(id), project: "delegatus", status: task.status, text: scrub(task.text, 400), placement: "unplaced", origin: { kind: "operator" },
      assignments: [], createdAt: task.createdAt, updatedAt: at(task.updatedAt) > SNAPSHOT ? new Date(SNAPSHOT).toISOString() : task.updatedAt, revision: "task-v1:fixture", color: task.color ?? null, icon: task.icon ?? null,
      priority: task.priority ?? undefined, doneAt: task.doneAt ?? undefined,
    };
  }),
  pipelines: lanes.filter((source) => at(source.createdAt) <= SNAPSHOT).map(lane),
};
fs.writeFileSync(out, `${JSON.stringify(data, null, 1)}\n`);
console.log(`wrote ${data.tasks.length} tasks and ${data.pipelines.length} lanes to ${out}`);
