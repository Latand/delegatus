import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test.skipIf(process.platform !== "linux")("guarded scratch sweep removes only the finished, quiet and unreferenced root", async () => {
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
    savePipelines([closedLane, parked]);
    const store = new AttemptTempStore();
    const cases = ["clear", "live", "recent", "open-fd", "git", "keep"] as const;
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
        store.register({ directory, pipelineId: name === "live" ? parked.id : closedLane.id,
          launchId: "fixture-launch", retainUntilClose: false, createdAt: now - 86400_000 });
        dirs.set(name, directory);
      }
    } finally { store.close(); }
    createCleanerJournal(id);
    writeJsonDurably(diskCleanerStateFile(), { id, startedAt: now, project: "fixture", mode: "on", episode: null, before: [] });
    const result = await runCleanerSweep({ id, class: "attempt-temp", after: "" }, { scan: () => scan, containerReferences: async () => true, now: () => now });
    expect(result.errors, JSON.stringify(result.kept)).toBe(0);
    expect(fs.existsSync(dirs.get("clear")!), JSON.stringify(result.kept)).toBe(false);
    for (const name of cases.slice(1)) expect(fs.existsSync(dirs.get(name)!)).toBe(true);
    expect(result.kept.map(row => row.reason).join("\n")).toContain("touched within three hours");
    const rows = fs.readFileSync(cleanerJournalFile(id), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toEqual(["intent", "removed"].map(phase => expect.objectContaining({
      phase, class: "attempt-temp", path: dirs.get("clear"), bytes: expect.any(Number), proof: expect.stringContaining("settled lane"),
    })));
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
