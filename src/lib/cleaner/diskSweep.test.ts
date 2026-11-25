import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { closeAgentRegistryForTests } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { pipelineIdentity, savePipelines } from "@/lib/pipelines/store";
import { AttemptTempStore } from "@/lib/runtime/attemptTempRetention";
import { finishedLane } from "@/lib/runtime/attemptTempRetention.testSupport";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { createCleanerJournal, cleanerJournalFile, diskCleanerStateFile } from "./diskJournal";
import { runCleanerSweep } from "./diskSweep";
import { createTask } from "@/lib/tasks/commands";
import { saveTasks } from "@/lib/tasks/store";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { projectAliasStore } from "@/lib/projects/persistence";

test.skipIf(process.platform !== "linux")("guarded scratch sweep removes only quiet, unreferenced roots owned by the pass project", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-cleaner-scratch-"));
  const saved = { state: process.env.LLV_STATE_DIR, port: process.env.PORT, cleaner: process.env.LLV_CLEANER };
  process.env.LLV_STATE_DIR = path.join(root, "state");
  delete process.env.PORT;
  delete process.env.LLV_CLEANER;
  const now = Date.UTC(2031, 10, 23), closed = new Date(now - 5 * 3600_000).toISOString();
  const id = createHash("sha256").update("cleaner scratch fixture").digest("hex").slice(0, 36);
  const scan = { ownNamespace: "fixture", processes: [] as Array<{ pid: number; namespace: string; stamped: boolean; paths: string[] }> };
  let openFd: number | undefined;
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const closedLane = finishedLane(repo, closed);
    closedLane.runs = [{ stageId: "build", attempts: [{
      n: 1, state: "passed", launchId: "fixture-launch", effectiveRole: closedLane.stages[0]!.effectiveRole,
      conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null, startedAt: closed, completedAt: closed,
      input: null, activatedBy: null, output: null, verdict: null, error: null,
    }] }];
    const parked = { ...closedLane, ...pipelineIdentity("parked-fixture", closedLane.task, repo),
      id: "parked-fixture", state: "paused", pausedState: "running", closedAt: null } as const;
    const foreign = { ...closedLane, ...pipelineIdentity("foreign-fixture", closedLane.task, repo),
      id: "foreign-fixture", project: "foreign-project" };
    const alias = { ...closedLane, ...pipelineIdentity("alias-fixture", closedLane.task, repo),
      id: "alias-fixture", project: "old-fixture-project" };
    const rebound = { ...closedLane, ...pipelineIdentity("rebound-fixture", closedLane.task, repo),
      id: "rebound-fixture", project: "moving-fixture-project" };
    expect(persistProjectAliases([alias, rebound].map(lane => ({
      source: lane.project, target: closedLane.project, displayName: "Fixture",
    })))).toBeTrue();
    savePipelines([closedLane, parked, foreign, alias, rebound]);
    const store = new AttemptTempStore();
    const cases = ["clear", "alias", "live", "recent", "open-fd", "git", "keep", "foreign", "unknown", "rebound"] as const;
    const lanes: Partial<Record<typeof cases[number], typeof closedLane>> = { live: parked, foreign, alias, rebound };
    const dirs = new Map<typeof cases[number], string>();
    try {
      for (const [index, name] of cases.entries()) {
        const directory = statePath("scratch", `llv-stage-${String(index).padStart(6, "0")}`);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, "payload");
        fs.writeFileSync(file, "data");
        if (name === "git") fs.mkdirSync(path.join(directory, ".git"));
        if (name === "keep") fs.writeFileSync(path.join(directory, ".delegatus-keep"), "");
        if (name === "recent") fs.utimesSync(file, new Date(now - 1000), new Date(now - 1000));
        if (name === "open-fd") {
          openFd = fs.openSync(file, "r");
          scan.processes.push({ pid: process.pid, namespace: "fixture", stamped: false,
            paths: [repo, fs.readlinkSync(`/proc/self/fd/${openFd}`)] });
        }
        const lane = lanes[name] ?? closedLane;
        store.register({ directory, pipelineId: lane.id,
          launchId: name === "unknown" ? "unbound-launch" : "fixture-launch", retainUntilClose: false, createdAt: now - 86400_000 });
        dirs.set(name, directory);
      }
    } finally { store.close(); }
    createCleanerJournal(id);
    writeJsonDurably(diskCleanerStateFile(), { id, startedAt: now, project: "fixture", mode: "on", episode: null, before: [] });
    const movingRoot = dirs.get("rebound")!, inode = fs.lstatSync(movingRoot).ino;
    let reboundWhileQuarantined = false;
    const result = await runCleanerSweep({ id, class: "attempt-temp", after: "" }, {
      scan: () => scan, now: () => now, containerReferences: async roots => {
        if (!reboundWhileQuarantined && roots.includes(movingRoot) && !fs.existsSync(movingRoot)) {
          projectAliasStore.mutate(statePath("project-aliases.json"), current => ({
            next: { ...current, aliases: { ...current.aliases, [rebound.project]: foreign.project } }, result: undefined,
          }));
          reboundWhileQuarantined = true;
        }
        return true;
      },
    });
    expect(result.errors, JSON.stringify(result.kept)).toBe(0);
    expect(reboundWhileQuarantined).toBeTrue();
    expect(fs.lstatSync(movingRoot).ino).toBe(inode);
    expect(fs.existsSync(dirs.get("clear")!), JSON.stringify(result.kept)).toBe(false);
    expect(fs.existsSync(dirs.get("alias")!), JSON.stringify(result.kept)).toBe(false);
    for (const name of cases.slice(2)) expect(fs.existsSync(dirs.get(name)!)).toBe(true);
    for (const name of ["foreign", "unknown"] as const) expect(result.kept).toContainEqual(expect.objectContaining({
      path: dirs.get(name), reason: "scratch owner project unproven or outside Cleaner pass",
    }));
    expect(result.kept.map(row => row.reason).join("\n")).toContain("touched within three hours");
    const rows = fs.readFileSync(cleanerJournalFile(id), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.slice(0, 4)).toEqual((["clear", "alias"] as const).flatMap(name => ["intent", "removed"].map(phase => expect.objectContaining({
      phase, class: "attempt-temp", path: dirs.get(name), bytes: expect.any(Number), proof: expect.stringContaining("settled lane"),
    }))));
    expect(rows.slice(4)).toEqual(["intent", "refused"].map(phase => expect.objectContaining({ phase, path: movingRoot })));
  } finally {
    if (openFd !== undefined) fs.closeSync(openFd);
    closeAgentRegistryForTests();
    for (const [key, value] of Object.entries({ LLV_STATE_DIR: saved.state, PORT: saved.port, LLV_CLEANER: saved.cleaner })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(process.platform !== "linux")("aged evidence is reclaimed while a task link and a recent write keep their copies", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-cleaner-evidence-"));
  const saved = { LLV_STATE_DIR: process.env.LLV_STATE_DIR, PORT: process.env.PORT, LLV_CLEANER: process.env.LLV_CLEANER };
  process.env.LLV_STATE_DIR = path.join(root, "state");
  delete process.env.PORT;
  delete process.env.LLV_CLEANER;
  const now = Date.UTC(2031, 10, 23), day = 86400_000;
  const closed = new Date(now - 8 * day).toISOString();
  const id = createHash("sha256").update("cleaner evidence fixture").digest("hex").slice(0, 36);
  try {
    const cases = ["old", "task-linked", "recent"];
    const lanes = cases.map(name => {
      const lane = finishedLane(root, closed), id = `lane-${name}`;
      return { ...lane, ...pipelineIdentity(id, lane.task, lane.repoDir), id };
    });
    savePipelines(lanes);
    const evidence = Object.fromEntries(lanes.map((lane, index) => {
      const directory = statePath("evidence", lane.id, "build");
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, "screen.txt");
      fs.writeFileSync(file, "fixture");
      const age = new Date(index === 2 ? now - day : now - 8 * day);
      fs.utimesSync(file, age, age);
      fs.utimesSync(directory, age, age);
      return [cases[index]!, directory];
    }));
    const task = createTask([], { project: "fixture", text: "Review retained evidence", placement: "unplaced",
      details: "See evidence/lane-task-linked/build/screen.txt" }, [], { id: () => "open-fixture-task", now: () => closed });
    if (!task.ok) throw new Error(task.error);
    saveTasks(task.tasks, statePath("tasks.json"));
    createCleanerJournal(id);
    writeJsonDurably(diskCleanerStateFile(), { id, startedAt: now, project: "fixture", mode: "on", episode: null, before: [] });
    const holds = [];
    for (let i = 0; i < 4; i++) {
      const report = await runCleanerSweep({ id, class: "evidence" }, { scan: () => ({ ownNamespace: "fixture", processes: [] }),
        containerReferences: async () => true, now: () => now + i * 1000 });
      expect(report.errors, JSON.stringify(report.kept)).toBe(0);
      holds.push(...report.kept);
    }
    expect(fs.existsSync(evidence.old!), JSON.stringify(holds)).toBe(false);
    expect(fs.existsSync(evidence["task-linked"]!)).toBe(true);
    expect(fs.existsSync(evidence.recent!)).toBe(true);
    expect(holds).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: evidence["task-linked"], reason: "referenced by an open task" }),
      expect.objectContaining({ path: evidence.recent, reason: "evidence touched within seven days" }),
    ]));
    const oldLaneFolder = path.dirname(evidence.old!);
    expect(fs.existsSync(oldLaneFolder)).toBe(false);
    expect(fs.readFileSync(cleanerJournalFile(id), "utf8").trim().split("\n").map(line => JSON.parse(line)))
      .toEqual([evidence.old, oldLaneFolder].flatMap(directory => ["intent", "removed"].map(phase =>
        expect.objectContaining({ phase, class: "evidence", path: directory }))));
  } finally {
    closeAgentRegistryForTests();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(process.platform !== "linux")("a bare Git evidence repository is preserved while adjacent aged evidence is reclaimed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-cleaner-bare-evidence-"));
  const saved = { LLV_STATE_DIR: process.env.LLV_STATE_DIR, PORT: process.env.PORT, LLV_CLEANER: process.env.LLV_CLEANER };
  process.env.LLV_STATE_DIR = path.join(root, "state"); delete process.env.PORT; delete process.env.LLV_CLEANER;
  const now = Date.UTC(2031, 10, 23), closed = new Date(now - 8 * 86400_000).toISOString();
  const id = createHash("sha256").update("bare evidence fixture").digest("hex").slice(0, 36);
  try {
    const lane = finishedLane(root, closed);
    savePipelines([{ ...lane, ...pipelineIdentity("lane-bare", lane.task, lane.repoDir), id: "lane-bare" },
      { ...lane, ...pipelineIdentity("lane-capture", lane.task, lane.repoDir), id: "lane-capture" }]);
    const bare = statePath("evidence", "lane-bare", "git-data");
    const capture = statePath("evidence", "lane-capture", "capture");
    fs.mkdirSync(path.dirname(bare), { recursive: true }); fs.mkdirSync(capture, { recursive: true });
    expect(spawnSync("git", ["init", "--bare", bare], { encoding: "utf8" }).status).toBe(0);
    const object = spawnSync("git", [`--git-dir=${bare}`, "hash-object", "-w", "--stdin"], { input: "retained object", encoding: "utf8" });
    expect(object.status).toBe(0); expect(fs.existsSync(path.join(bare, "objects", object.stdout.trim().slice(0, 2), object.stdout.trim().slice(2)))).toBeTrue();
    fs.writeFileSync(path.join(capture, "screen.txt"), "old capture");
    const aged = new Date(now - 8 * 86400_000);
    for (const directory of [bare, capture]) fs.utimesSync(directory, aged, aged);
    fs.utimesSync(path.join(capture, "screen.txt"), aged, aged);
    createCleanerJournal(id); writeJsonDurably(diskCleanerStateFile(), { id, startedAt: now, project: "fixture", mode: "on", episode: null, before: [] });
    const reports = [];
    for (let i = 0; i < 4; i++) reports.push(await runCleanerSweep({ id, class: "evidence" }, { scan: () => ({ ownNamespace: "fixture", processes: [] }),
      containerReferences: async () => true, now: () => now + i * 1000 }));
    expect(reports.reduce((total, report) => total + report.errors, 0), JSON.stringify(reports.flatMap(report => report.kept))).toBe(0);
    expect(fs.existsSync(path.join(bare, "objects", object.stdout.trim().slice(0, 2), object.stdout.trim().slice(2)))).toBeTrue();
    expect(fs.existsSync(capture)).toBeFalse();
    expect(reports.flatMap(report => report.kept)).toContainEqual(expect.objectContaining({ path: bare, reason: expect.stringContaining("git-data") }));
    const journal = fs.readFileSync(cleanerJournalFile(id), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(journal.filter(row => row.path === capture).map(row => row.phase)).toEqual(["intent", "removed"]);
    expect(journal.some(row => row.path === bare)).toBeFalse();
  } finally {
    closeAgentRegistryForTests();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
