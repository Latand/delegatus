import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { admitProactiveTask, readProactiveAllowance, rejectProactiveCandidate } from "./proactive";
import { checkpointTaskRollbackMirrorForDemotion, importLegacyTasks, loadTasks, mutateTasks, saveTasks } from "./store";
import { BOARD_TASKS_PER_PROJECT_LIMIT, createTask, patchTask } from "./commands";
import type { BoardTask } from "./types";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { proactiveScopeCurrent } from "./proactiveScope";
import { compactTask, taskAcknowledgement } from "@/lib/mcp/listAnswers";
import { encodeTask } from "@/lib/links/taskWire";
import { legacyDatabasePath } from "@/lib/state/legacyImport";
import { taskShowsOnBoard } from "./boardVisibility";
import { candidate, context, NOW, authority } from "./proactive.fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function file() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "proactive-tasks-")); roots.push(root); return path.join(root, "tasks.json"); }

async function runChild(target: string, key: string, action = "admit", project = "atlas", startedAt = context().startedAt) {
  const root = path.dirname(target);
  for (const name of ["home", "config", "tmp"]) fs.mkdirSync(path.join(root, name), { recursive: true });
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "proactive.fixture.ts"), target, key, action, project, startedAt], {
    env: { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: path.join(root, "tmp"), LLV_STATE_DIR: root },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`child exit ${code}: ${err}`);
    const result = out.split("\n").find(line => line.startsWith("RESULT "));
    if (!result) throw new Error(`child omitted its result: ${out} ${err}`);
    return JSON.parse(result.slice(7)) as { id?: string; replay?: boolean; error?: string; episodeUsed?: number; rollingUsed?: number };
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

function boardRow(index: number, project = "atlas"): BoardTask {
  return { id: `band-${index}`, project, text: `Recorded outcome ${index}`, status: "assigned", board: "shown", placement: "unplaced", assignments: [],
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() };
}

test("atomic admission counts hidden, done and failed outcomes; stable keys replay one card", async () => {
  const target = file();
  const first = await admitProactiveTask(candidate("fold"), context(), target, authority());
  expect(first.replay).toBe(false);
  expect(first.task.dueAt).toBeUndefined(); expect(first.task.dueTz).toBeUndefined();
  expect(first.task.board).not.toBe("hidden");
  expect(taskShowsOnBoard(loadTasks(target)[0]!, false, { now: NOW })).toBe(true);
  expect(first.task.proactive?.candidateKey).toBe("fold");
  expect(first.task.proactive?.scopeHash).toMatch(/^[a-f0-9]{64}$/);
  expect(proactiveScopeCurrent(first.task)).toBe(true);
  const again = await admitProactiveTask(candidate("fold"), context(), target, authority());
  expect(again.task.id).toBe(first.task.id);
  expect(again.replay).toBe(true);
  mutateTasks(tasks => ({ tasks: tasks.map(task => ({ ...task, status: "done", board: "hidden" })), result: null }), target);
  await admitProactiveTask(candidate("retry"), context(), target, authority());
  mutateTasks(tasks => ({ tasks: tasks.map(task => task.id === first.task.id ? task : { ...task,
    assignments: [{ path: null, panePid: null, state: "failed", error: "fixture failure", at: new Date(NOW).toISOString() }] }), result: null }), target);
  await expect(admitProactiveTask(candidate("third"), context(), target, authority())).rejects.toThrow("episode allowance");
  expect(loadTasks(target)).toHaveLength(2);
  expect(readProactiveAllowance("atlas", context().startedAt, NOW, target)).toMatchObject({ episodeUsed: 2, rollingUsed: 2 });
});

test("a new episode and a permission toggle cannot replenish the rolling day", async () => {
  const target = file();
  await admitProactiveTask(candidate("one"), context(), target, authority());
  await admitProactiveTask(candidate("two"), context(), target, authority());
  const disabled = { ...authority(), settings: () => ({ ...authority().settings(), autonomy: { ...authority().settings().autonomy, proactive: { enabled: false } } }) };
  await expect(admitProactiveTask(candidate("three"), context(), target, disabled)).rejects.toThrow("permission");
  await expect(admitProactiveTask(candidate("three"), context(), target, authority())).rejects.toThrow("episode allowance");
  const later = NOW + 3_600_000;
  const next = context(new Date(later).toISOString());
  await expect(admitProactiveTask(candidate("three"), next, target, authority(later, next.startedAt))).rejects.toThrow("rolling 24-hour allowance");
  const tomorrow = NOW + 86_400_001;
  await expect(admitProactiveTask(candidate("three"), context(), target, authority(tomorrow))).rejects.toThrow("episode allowance");
  await admitProactiveTask(candidate("three"), next, target, authority(tomorrow, next.startedAt));
  expect(readProactiveAllowance("atlas", next.startedAt, tomorrow, target)).toMatchObject({ episodeUsed: 1, rollingUsed: 1 });
});

test("scope edits and restoring content invalidate admission; notes, status and step progress retain it", async () => {
  const target = file();
  const { task } = await admitProactiveTask(candidate("scope"), context(), target, authority());
  const patch = (input: Parameters<typeof patchTask>[2]) => mutateTasks(tasks => {
    const result = patchTask(tasks, task.id, input, new Date(NOW + 1).toISOString());
    if (!result.ok) throw new Error(result.error);
    return { tasks: result.tasks, result: null };
  }, target);
  patch({ note: "Review in progress", status: "assigned" });
  expect(proactiveScopeCurrent(loadTasks(target)[0]!)).toBe(true);
  patch({ details: "A different outcome" });
  expect(proactiveScopeCurrent(loadTasks(target)[0]!)).toBe(false);
  patch({ details: task.details });
  expect(proactiveScopeCurrent(loadTasks(target)[0]!)).toBe(false);
  expect(loadTasks(target)[0]!.proactive?.scopeRevision).toBe(2);
});

test("rejection survives rename, another episode, replay and ordinary saves", async () => {
  const target = file();
  const { task } = await admitProactiveTask(candidate("reject"), context(), target, authority());
  await rejectProactiveCandidate("atlas", "reject", target);
  saveTasks(loadTasks(target).map(row => ({ ...row, text: "Renamed outcome" })), target);
  await expect(admitProactiveTask(candidate("reject"), context(), target, authority())).rejects.toThrow("rejected");
  const next = context("2026-10-23T00:00:00.000Z");
  await expect(admitProactiveTask(candidate("reject"), next, target, authority(NOW + 86_400_000, next.startedAt))).rejects.toThrow("rejected");
  expect(loadTasks(target)[0]!.id).toBe(task.id);
  mutateTasks(tasks => ({ tasks: tasks.map(row => ({ ...row, status: "done", board: "hidden" })), result: null }), target);
  await expect(admitProactiveTask(candidate("reject"), next, target, authority(NOW + 86_400_000, next.startedAt))).rejects.toThrow("rejected");
  expect(loadTasks(target)).toHaveLength(1);
});

test("ordinary writes and rollback mirrors cannot add provenance to a task admission never created", async () => {
  const target = file();
  const { task: admitted } = await admitProactiveTask(candidate("genuine"), context(), target, authority());
  const forged = structuredClone(admitted.proactive!);
  const plain = createTask(loadTasks(target), { project: "atlas", text: "Ordinary accepted work", placement: "unplaced" });
  if (!plain.ok) throw new Error(plain.error);
  saveTasks(plain.tasks, target);
  const plainId = plain.task.id;
  const provenance = (id: string) => loadTasks(target).find(row => row.id === id)?.proactive;
  mutateTasks(tasks => { tasks.find(row => row.id === plainId)!.proactive = forged; return { tasks, result: null }; }, target);
  expect(provenance(plainId)).toBeUndefined();
  mutateTasks(tasks => ({ tasks: tasks.map(row => row.id === plainId ? { ...row, proactive: forged } : row), result: null }), target);
  expect(provenance(plainId)).toBeUndefined();
  const copy = { ...structuredClone(admitted), id: "copied-candidate" };
  saveTasks([...loadTasks(target), copy], target);
  expect(loadTasks(target).find(row => row.id === "copied-candidate")).toBeDefined();
  expect(provenance("copied-candidate")).toBeUndefined();
  checkpointTaskRollbackMirrorForDemotion(target);
  const mirror = JSON.parse(fs.readFileSync(target, "utf8"));
  for (const row of mirror.tasks) if (row.id === plainId) row.proactive = forged;
  mirror.tasks.push({ ...structuredClone(mirror.tasks.find((row: BoardTask) => row.id === admitted.id)), id: "mirror-added" });
  fs.writeFileSync(target, JSON.stringify(mirror));
  importLegacyTasks(target, { reconcile: true });
  expect(loadTasks(target).find(row => row.id === "mirror-added")).toBeDefined();
  for (const id of [plainId, "mirror-added"]) expect(provenance(id)).toBeUndefined();
  expect(provenance(admitted.id)).toEqual(admitted.proactive);
  expect(readProactiveAllowance("atlas", context().startedAt, NOW, target)).toEqual({ episodeUsed: 1, rollingUsed: 1 });
});

test("invalid candidates and stale authority leave no task or spent allowance", async () => {
  const target = file();
  for (const input of [{ ...candidate("bad"), score: [2, 2, 2, 9] }, { ...candidate("bad"), sources: [] }, { ...candidate("bad"), findingKey: "observed" }]) {
    await expect(admitProactiveTask(input, context(), target, authority())).rejects.toThrow();
  }
  await expect(admitProactiveTask(candidate("off"), context(), target, { ...authority(), settings: () => ({ enabled: true, autonomy: null }) })).rejects.toThrow("permission");
  await expect(admitProactiveTask(candidate("rotated"), context(), target, { ...authority(), seat: () => ({ conversationId: "seat", epoch: 2 }) })).rejects.toThrow("seat");
  expect(loadTasks(target)).toHaveLength(0);
  expect(readProactiveAllowance("atlas", context().startedAt, NOW, target).episodeUsed).toBe(0);
});

test("ordinary observed findings never consume the invention allowance", async () => {
  const target = file();
  const { createTask } = await import("./commands");
  const result = createTask([], { project: "atlas", text: "Fix reproduced failure", findingKey: "reproduced-failure", placement: "unplaced" });
  if (!result.ok) throw new Error(result.error);
  saveTasks(result.tasks, target);
  expect(readProactiveAllowance("atlas", context().startedAt, NOW, target)).toMatchObject({ episodeUsed: 0, rollingUsed: 0 });
});

test("compact reads omit private sources and linked boards carry no invention authority", async () => {
  const target = file();
  const { task } = await admitProactiveTask(candidate("projection"), context(), target, authority());
  expect(compactTask(task).proactive?.candidateKey).toBe("projection");
  expect(compactTask(task).proactive).not.toHaveProperty("sources");
  expect(taskAcknowledgement(task, {}, ["proactive"]).changes.proactive).not.toHaveProperty("sources");
  const extended = { ...task, proactive: { ...task.proactive!, privateContext: "Local source text" } };
  expect(compactTask(extended).proactive).not.toHaveProperty("privateContext");
  expect(encodeTask(task, { id: "install", prefix: "abcdef12" }).row).not.toHaveProperty("proactive");
});

test("admission rechecks permission after its asynchronous preparation", async () => {
  const target = file();
  let enabled = true;
  const ports = { ...authority(), settings: () => ({ ...authority().settings(), enabled }) };
  const pending = admitProactiveTask(candidate("late"), context(), target, ports);
  enabled = false;
  await expect(pending).rejects.toThrow("permission");
  expect(loadTasks(target)).toHaveLength(0);
  expect(readProactiveAllowance("atlas", context().startedAt, NOW, target).episodeUsed).toBe(0);
});

test("preparation freezes submitted content and identity before yielding", async () => {
  const target = file();
  const request = candidate("frozen");
  const identity = context();
  const pending = admitProactiveTask(request, identity, target, authority());
  request.text = "Changed while preparing";
  request.sources.length = 0;
  identity.conversationId = "another-seat";
  const { task } = await pending;
  expect(task.text).toBe(candidate("frozen").text);
  expect(task.proactive?.sources).toEqual(candidate("frozen").sources);
  expect(proactiveScopeCurrent(task)).toBe(true);
});

test("in-place edits, attachment and step scope invalidate; provenance is store-owned", async () => {
  const target = file();
  const { task } = await admitProactiveTask({ ...candidate("mutate"), steps: [{ id: "check", text: "Open and close", state: "open" }] }, context(), target, authority());
  mutateTasks(tasks => {
    tasks[0]!.steps![0]!.state = "done";
    tasks[0]!.proactive!.candidateKey = "spoofed";
    return { tasks, result: null };
  }, target);
  expect(loadTasks(target)[0]!.proactive?.candidateKey).toBe("mutate");
  expect(proactiveScopeCurrent(loadTasks(target)[0]!)).toBe(true);
  mutateTasks(tasks => { tasks[0]!.steps![0]!.text = "Changed requested step"; return { tasks, result: null }; }, target);
  expect(proactiveScopeCurrent(loadTasks(target)[0]!)).toBe(false);
  saveTasks([task], target);
  expect(loadTasks(target)[0]!.proactive?.scopeRevision).toBe(2);
  mutateTasks(tasks => {
    tasks[0]!.attachments = [{ id: "image", sha256: "a".repeat(64), ext: "png", mime: "image/png", bytes: 1, createdAt: new Date(NOW).toISOString() }];
    return { tasks, result: null };
  }, target);
  expect(loadTasks(target)[0]!.proactive?.scopeRevision).toBe(3);
});

test("a failed allowance write rolls back the inserted task and candidate; the same key then succeeds", async () => {
  const target = file();
  saveTasks([], target);
  const database = new Database(legacyDatabasePath(target));
  try {
    database.exec(`CREATE TRIGGER refuse_allowance BEFORE INSERT ON state_rows
      WHEN NEW.collection = 'proactive_allowance' AND json_extract(NEW.value_json, '$.kind') = 'allowance'
      BEGIN SELECT RAISE(ABORT, 'fixture allowance refusal'); END`);
    await expect(admitProactiveTask(candidate("atomic"), context(), target, authority())).rejects.toThrow();
    expect(loadTasks(target)).toHaveLength(0);
    expect(readProactiveAllowance("atlas", context().startedAt, NOW, target).episodeUsed).toBe(0);
    database.exec("DROP TRIGGER refuse_allowance");
    const retry = await admitProactiveTask(candidate("atomic"), context(), target, authority());
    expect(retry.replay).toBe(false);
    expect(loadTasks(target)).toHaveLength(1);
    expect(readProactiveAllowance("atlas", context().startedAt, NOW, target).episodeUsed).toBe(1);
  } finally { database.close(); }
});

test("legacy rollback edits and restores retain provenance and cannot restore an old scope grant", async () => {
  const target = file();
  const { task } = await admitProactiveTask(candidate("rollback"), context(), target, authority());
  for (const text of ["A rollback edit", task.text]) {
    checkpointTaskRollbackMirrorForDemotion(target);
    const mirror = JSON.parse(fs.readFileSync(target, "utf8"));
    mirror.tasks[0].text = text;
    delete mirror.tasks[0].proactive;
    fs.writeFileSync(target, JSON.stringify(mirror));
    importLegacyTasks(target, { reconcile: true });
    const current = loadTasks(target)[0]!;
    expect(current.proactive?.candidateKey).toBe("rollback");
    expect(proactiveScopeCurrent(current)).toBe(false);
  }
  expect(loadTasks(target)[0]!.proactive?.scopeRevision).toBe(2);
});

test("parallel real processes admit at most two and restart retains receipts and rejection", async () => {
  const target = file();
  const run = (key: string, action = "admit") => runChild(target, key, action);
  const settled = await Promise.allSettled([run("a"), run("b"), run("c"), run("d")]);
  const results = settled.map(result => { if (result.status === "rejected") throw result.reason; return result.value; });
  expect(results.filter(result => result.id)).toHaveLength(2);
  expect(results.filter(result => result.error?.includes("allowance"))).toHaveLength(2);
  const tasks = loadTasks(target);
  const key = tasks[0]!.proactive!.candidateKey;
  expect((await run(key)).id).toBe(tasks[0]!.id);
  await run(key, "reject");
  expect((await run(key)).error).toContain("rejected");
  expect(loadTasks(target)).toHaveLength(2);
});

test("project succession and restart preserve both quotas, replay and rejected candidate keys", async () => {
  const target = file();
  expect((await runChild(target, "one")).id).toBeDefined();
  const second = await runChild(target, "two");
  expect(second.id).toBeDefined();
  expect(await runChild(target, "one", "reject")).toEqual({});
  expect(await runChild(target, "atlas-renamed", "alias")).toEqual({});
  for (const project of ["atlas", "atlas-renamed"]) {
    expect(await runChild(target, "", "allowance", project)).toEqual({ episodeUsed: 2, rollingUsed: 2 });
    expect((await runChild(target, "three", "admit", project)).error).toContain("episode allowance");
    expect((await runChild(target, "one", "admit", project)).error).toContain("rejected");
    expect(await runChild(target, "two", "admit", project)).toEqual({ id: second.id, replay: true });
  }
  const next = new Date(NOW + 3_600_000).toISOString();
  expect((await runChild(target, "three", "admit", "atlas-renamed", next)).error).toContain("rolling 24-hour allowance");
  expect(await runChild(target, "atlas-final", "alias", "atlas-renamed")).toEqual({});
  expect(await runChild(target, "", "allowance", "atlas-final")).toEqual({ episodeUsed: 2, rollingUsed: 2 });
  expect((await runChild(target, "one", "admit", "atlas-final")).error).toContain("rejected");
  expect(loadTasks(target)).toHaveLength(2);
});

test("coexisting predecessor and successor receipts combine usage and rejection wins a candidate collision", async () => {
  const target = file();
  expect((await runChild(target, "same")).id).toBeDefined();
  expect(await runChild(target, "same", "reject")).toEqual({});
  expect((await runChild(target, "same", "admit", "atlas-renamed")).id).toBeDefined();
  expect(await runChild(target, "atlas-renamed", "alias")).toEqual({});
  expect(await runChild(target, "atlas-renamed", "alias")).toEqual({});
  expect(await runChild(target, "", "allowance", "atlas-renamed")).toEqual({ episodeUsed: 2, rollingUsed: 2 });
  expect((await runChild(target, "third", "admit", "atlas-renamed")).error).toContain("episode allowance");
  expect((await runChild(target, "same", "admit", "atlas-renamed")).error).toContain("rejected");
  expect(await runChild(target, "same", "reject", "atlas-renamed")).toEqual({});
  expect((await runChild(target, "same", "admit")).error).toContain("rejected");
  expect(loadTasks(target)).toHaveLength(2);
});

test("succession during asynchronous preparation uses the current canonical project and all predecessor usage", async () => {
  const target = file();
  const source = "preparing-project", successor = "prepared-project";
  const input = (key: string) => ({ ...candidate(key), project: source });
  const ctx = { ...context(), project: source };
  await admitProactiveTask(input("first"), ctx, target, authority());
  const pending = admitProactiveTask(input("second"), ctx, target, authority());
  expect(persistProjectAliases([{ source, target: successor, displayName: "Prepared project" }])).toBe(true);
  expect((await pending).task.project).toBe(successor);
  expect(readProactiveAllowance(successor, ctx.startedAt, NOW, target)).toEqual({ episodeUsed: 2, rollingUsed: 2 });
  await expect(admitProactiveTask(input("third"), ctx, target, authority())).rejects.toThrow("episode allowance");
});

test("an oversized alias family refuses reads, admission and rejection without losing existing receipts", async () => {
  const target = file(), project = "many-predecessors";
  const input = { ...candidate("held"), project };
  const ctx = { ...context(), project };
  await admitProactiveTask(input, ctx, target, authority());
  expect(persistProjectAliases(Array.from({ length: 127 }, (_, n) => ({ source: `predecessor-${n}`, target: project, displayName: "Project" })))).toBe(true);
  expect(readProactiveAllowance(project, ctx.startedAt, NOW, target)).toEqual({ episodeUsed: 1, rollingUsed: 1 });
  expect((await admitProactiveTask(input, ctx, target, authority())).replay).toBe(true);
  expect(persistProjectAliases([{ source: "predecessor-overflow", target: project, displayName: "Project" }])).toBe(true);
  expect(() => readProactiveAllowance(project, ctx.startedAt, NOW, target)).toThrow("alias evidence");
  await expect(admitProactiveTask({ ...input, candidateKey: "new" }, ctx, target, authority())).rejects.toThrow("alias evidence");
  await expect(rejectProactiveCandidate(project, "held", target)).rejects.toThrow("alias evidence");
  expect(loadTasks(target)).toHaveLength(1);
});

test("a full board spends no allowance; hiding one band permits exactly one concurrent admission", async () => {
  const target = file();
  saveTasks(Array.from({ length: BOARD_TASKS_PER_PROJECT_LIMIT }, (_, n) => boardRow(n)), target);
  const ordinary = createTask(loadTasks(target), { project: "atlas", text: "Ordinary outcome", placement: "unplaced" });
  expect(ordinary.ok).toBe(false);
  if (!ordinary.ok) expect(ordinary.code).toBe("TASK_BOARD_FULL");
  expect((await runChild(target, "first")).error).toContain("300 task bands");
  expect(readProactiveAllowance("atlas", context().startedAt, NOW, target)).toEqual({ episodeUsed: 0, rollingUsed: 0 });
  expect(loadTasks(target)).toHaveLength(300);
  mutateTasks(tasks => ({ tasks: tasks.map((task, n) => n === 0 ? { ...task, board: "hidden" } : task), result: null }), target);
  const results = await Promise.all([runChild(target, "first"), runChild(target, "second")]);
  expect(results.filter(row => row.id)).toHaveLength(1);
  expect(results.filter(row => row.error?.includes("300 task bands"))).toHaveLength(1);
  expect(loadTasks(target).filter(task => task.board !== "hidden")).toHaveLength(300);
  expect(readProactiveAllowance("atlas", context().startedAt, NOW, target)).toEqual({ episodeUsed: 1, rollingUsed: 1 });
  const winner = results[0]!.id ? "first" : "second";
  expect((await runChild(target, winner)).replay).toBe(true);
});

test("board evidence includes predecessor task keys after succession", async () => {
  const target = file();
  saveTasks(Array.from({ length: 300 }, (_, n) => boardRow(n, n < 150 ? "atlas" : "atlas-renamed")), target);
  expect(await runChild(target, "atlas-renamed", "alias")).toEqual({});
  expect((await runChild(target, "full", "admit", "atlas-renamed")).error).toContain("300 task bands");
  expect(await runChild(target, "", "allowance", "atlas-renamed")).toEqual({ episodeUsed: 0, rollingUsed: 0 });
});

test("board admission rechecks a board filled during asynchronous preparation", async () => {
  const target = file();
  saveTasks(Array.from({ length: 299 }, (_, n) => boardRow(n)), target);
  const pending = admitProactiveTask(candidate("late-board"), context(), target, authority());
  mutateTasks(tasks => ({ tasks: [...tasks, boardRow(299)], result: null }), target);
  await expect(pending).rejects.toThrow("300 task bands");
  expect(loadTasks(target)).toHaveLength(300);
  expect(readProactiveAllowance("atlas", context().startedAt, NOW, target)).toEqual({ episodeUsed: 0, rollingUsed: 0 });
});

test("board evidence uses shared visibility for hidden and expired tasks and ignores other projects", async () => {
  const target = file();
  saveTasks([
    ...Array.from({ length: 299 }, (_, n) => boardRow(n)),
    { ...boardRow(299), board: "hidden" },
    { ...boardRow(300), status: "done", doneAt: new Date(NOW - 3 * 86_400_000 - 1).toISOString(), doneAdmissions: [] },
    ...Array.from({ length: 1_100 }, (_, n) => boardRow(n + 301, "other-project")),
  ], target);
  await admitProactiveTask(candidate("last"), context(), target, authority());
  await expect(admitProactiveTask(candidate("full"), context(), target, authority())).rejects.toThrow("300 task bands");
  expect(readProactiveAllowance("atlas", context().startedAt, NOW, target)).toEqual({ episodeUsed: 1, rollingUsed: 1 });
});

test("unreadable and oversized board evidence refuse without a task or allowance write", async () => {
  const target = file();
  saveTasks([{ ...boardRow(0), board: "hidden" }], target);
  const db = new Database(legacyDatabasePath(target));
  try { db.query("UPDATE state_rows SET value_json=json_remove(value_json,'$.text') WHERE collection='tasks' AND row_key='t:band-0'").run(); }
  finally { db.close(); }
  await expect(admitProactiveTask(candidate("unreadable"), context(), target, authority())).rejects.toThrow("invalid persisted task");
  expect(readProactiveAllowance("atlas", context().startedAt, NOW, target)).toEqual({ episodeUsed: 0, rollingUsed: 0 });
  const oversized = file();
  saveTasks(Array.from({ length: 1_100 }, (_, n) => ({ ...boardRow(n), board: "hidden" })), oversized);
  await expect(admitProactiveTask(candidate("oversized"), context(), oversized, authority())).rejects.toThrow("budget");
  expect(loadTasks(oversized)).toHaveLength(1_100);
  expect(readProactiveAllowance("atlas", context().startedAt, NOW, oversized)).toEqual({ episodeUsed: 0, rollingUsed: 0 });
});
