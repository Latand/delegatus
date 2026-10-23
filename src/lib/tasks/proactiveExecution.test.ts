import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { admitProactiveTask, decideProactiveTask as decide, proactiveCandidateDecision, proactiveDecisionToken, readProactiveAllowance } from "./proactive";
import { candidate, context, NOW, authority } from "./proactive.fixture";
import { assertProactiveTaskExecution, proactiveConversationTaskIds, proactiveExecutionError } from "./proactiveExecution";
import { loadTasks, mutateTasks } from "./store";
import { patchTask } from "./commands";
import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { legacyDatabasePath } from "@/lib/state/legacyImport";

const decideProactiveTask = (taskId: string, decision: "adopt" | "reject", actor: "operator" | "agent", file: string) =>
  decide(taskId, decision, actor, proactiveDecisionToken(loadTasks(file).find(task => task.id === taskId)!, file), file, () => new Date(NOW).toISOString());

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function prepared() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proactive-execution-"));
  roots.push(root);
  const file = path.join(root, "tasks.json");
  const { task } = await admitProactiveTask(candidate("filter"), context(), file, authority());
  return { root, file, task };
}

test("preparation grants no dispatch or effect authority, including replay", async () => {
  const { file, task } = await prepared();
  expect(proactiveExecutionError([task], file)).toContain("disabled");
  const replay = await admitProactiveTask(candidate("filter"), context(), file, authority());
  expect(replay.replay).toBe(true);
  expect(() => assertProactiveTaskExecution([replay.task.id], file)).toThrow("disabled");
});

test("only operator adoption transfers authority; ordinary status, reopen and edits cannot", async () => {
  const { file, task } = await prepared();
  for (const decision of ["adopt", "reject"] as const) {
    await expect(decideProactiveTask(task.id, decision, "agent", file)).rejects.toThrow("only the operator");
  }
  mutateTasks(tasks => {
    const result = patchTask(tasks, task.id, { status: "done" });
    if (!result.ok) throw new Error(result.error);
    return { tasks: result.tasks, result: null };
  }, file);
  mutateTasks(tasks => {
    const result = patchTask(tasks, task.id, { status: "inbox", text: "Retitled outcome" });
    if (!result.ok) throw new Error(result.error);
    return { tasks: result.tasks, result: null };
  }, file);
  expect(proactiveExecutionError(loadTasks(file), file)).toContain("disabled");
  const before = loadTasks(file);
  await decideProactiveTask(task.id, "adopt", "operator", file);
  expect(proactiveExecutionError(loadTasks(file), file)).toBeNull();
  expect(loadTasks(file)).toEqual(before);
  expect(readProactiveAllowance(task.project, context().startedAt, NOW, file)).toEqual({ episodeUsed: 1, rollingUsed: 1 });
});

test("rejection revokes an earlier adoption; adopting retained work preserves suppression and allowance", async () => {
  const { file, task } = await prepared();
  await decideProactiveTask(task.id, "adopt", "operator", file);
  await decideProactiveTask(task.id, "reject", "operator", file);
  expect(proactiveExecutionError([task], file)).toContain("rejected");
  expect(loadTasks(file)).toHaveLength(1);
  await expect(admitProactiveTask({ ...candidate("filter"), text: "Renamed candidate" }, context(), file, authority())).rejects.toThrow("rejected");
  await decideProactiveTask(task.id, "adopt", "operator", file);
  expect(proactiveCandidateDecision(task, file)).toEqual({ rejected: true, adopted: true });
  expect(proactiveExecutionError([task], file)).toBeNull();
  await expect(admitProactiveTask(candidate("filter"), context(), file, authority())).rejects.toThrow("rejected");
  expect(readProactiveAllowance(task.project, context().startedAt, NOW, file).rollingUsed).toBe(1);
});

test("a delayed adoption cannot supersede rejection or accept a changed scope", async () => {
  const { file, task } = await prepared();
  const original = proactiveDecisionToken(task, file);
  await decideProactiveTask(task.id, "adopt", "operator", file);
  await decideProactiveTask(task.id, "reject", "operator", file);
  await expect(decide(task.id, "adopt", "operator", original, file)).rejects.toThrow("decision changed");
  expect(proactiveCandidateDecision(task, file)).toEqual({ rejected: true, adopted: false });
  const expected = proactiveDecisionToken(task, file);
  const blocker = new SqliteStateCollection<{ key: string }>(legacyDatabasePath(file), { collection: "proactive_allowance", schemaVersion: 1,
    key: row => row.key, decode: value => value as { key: string }, clone: structuredClone, busyMessage: "fixture decision lease is held" });
  let pending: ReturnType<typeof decide> | undefined;
  try {
    blocker.withSnapshotSync(() => {
      pending = decide(task.id, "adopt", "operator", expected, file);
      mutateTasks(tasks => ({ tasks: tasks.map(row => ({ ...row, details: "A different requested outcome" })), result: null }), file);
      // The pending command must own its submitted tuple, including while its
      // companion lease is held by another writer.
      Object.assign(expected, proactiveDecisionToken(loadTasks(file)[0]!, file));
    });
    await expect(pending!).rejects.toThrow("scope changed");
    expect(proactiveCandidateDecision(loadTasks(file)[0]!, file)).toEqual({ rejected: true, adopted: false });
    mutateTasks(tasks => ({ tasks: tasks.map(row => ({ ...row, details: task.details })), result: null }), file);
    const restored = proactiveDecisionToken(loadTasks(file)[0]!, file);
    expect(restored.scopeHash).toBe(original.scopeHash);
    await expect(decide(task.id, "adopt", "operator", { ...original, decisionRevision: restored.decisionRevision }, file)).rejects.toThrow("scope changed");
    await decideProactiveTask(task.id, "adopt", "operator", file);
    expect(proactiveCandidateDecision(loadTasks(file)[0]!, file)).toEqual({ rejected: true, adopted: true });
    expect(readProactiveAllowance(task.project, context().startedAt, NOW, file).rollingUsed).toBe(1);
  } finally { blocker.close(); }
});

test("an unrelated task cannot launder authority and failed assignments preserve inherited provenance", async () => {
  const { file, task } = await prepared();
  mutateTasks(tasks => ({ tasks: tasks.map(row => ({ ...row, assignments: [{ conversationId: "invented-worker", path: null, panePid: null, state: "failed", error: "fixture failure", at: new Date(NOW).toISOString() }] })), result: null }), file);
  const registry = { conversationRetentionSnapshot: () => ({ conversations: {}, entries: {}, conversationAliases: {},
    receipts: { "retained-launch": { failureReporting: { taskIds: [task.id] } } } }) } as unknown as
      Pick<import("@/lib/agent/registry").AgentRegistry, "conversationRetentionSnapshot">;
  expect(proactiveConversationTaskIds(["invented-worker"], registry, file)).toEqual([task.id]);
  expect(proactiveExecutionError([{ ...task, id: "ordinary", proactive: undefined }, task], file)).toContain("disabled");
  expect(proactiveExecutionError([{ ...task, id: "unrecorded" }], file)).toContain("unreadable");
});

test("decisions survive a fresh process and rejection races do not reset artifacts", async () => {
  const { root, file, task } = await prepared();
  await decideProactiveTask(task.id, "adopt", "operator", file);
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "proactive.fixture.ts"), file, "filter", "decision"], {
    env: { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root, LLV_STATE_DIR: path.join(root, "state") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`child exit ${code}: ${err}`);
    expect(out).toContain('"adopted":true');
    expect(out).toContain('"decisionRevision":1');
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  // This is the last-boundary recheck used by publication and merge: an
  // earlier observation cannot authorize the operation after rejection.
  expect(proactiveExecutionError([task], file)).toBeNull();
  const artifacts = loadTasks(file);
  await decideProactiveTask(task.id, "reject", "operator", file);
  expect(() => assertProactiveTaskExecution([task.id], file)).toThrow("rejected");
  expect(loadTasks(file)).toEqual(artifacts);
});
