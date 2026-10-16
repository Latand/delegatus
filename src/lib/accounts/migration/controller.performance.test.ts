import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { AgentRegistry, agentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { forEachCooperatively } from "@/lib/cooperative";
import { holdBeforeEachWrite, registryLockHolder, sqliteRegistryFixture, loopProgressProbe } from "@/lib/agent/registryLockHolderFixture";
import { runReaperCycle } from "@/lib/reaperRuntime";
import * as membership from "@/lib/tasks/membership";
import * as taskStore from "@/lib/tasks/store";
import { legacyDatabasePath } from "@/lib/state/legacyImport";
import { stateLockWaitsInFlight } from "@/lib/state/lockWait";
import { reconcileFileControllers } from "@/lib/scanner";
import type { FileEntry } from "@/lib/types";

import { reconcileMigrationInventory } from "./coordinator";
import { AccountMigrationController } from "./controller";

const LARGE_INVENTORY_SIZE = 800;

async function eventLoopLagsWhile(work: () => Promise<void>): Promise<number[]> {
  const lags: number[] = [];
  let running = true;
  let progress = 0;
  let expectedAt = performance.now();
  const sample = () => {
    const now = performance.now();
    lags.push(now - expectedAt);
    if (running) progress++;
    expectedAt = now;
    if (running) setImmediate(sample);
  };
  setImmediate(sample);
  try { await work(); }
  finally { running = false; }
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(progress, "the runtime must get a turn while the measured work is pending").toBeGreaterThan(0);
  return lags;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

test("durable inventory reconciliation stays responsive with a production-shaped catalog", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-large-inventory-lag-"));
  try {
    const transcriptRoot = path.join(base, "sessions");
    await mkdir(transcriptRoot, { recursive: true });
    const files = await Promise.all(Array.from({ length: LARGE_INVENTORY_SIZE }, async (_, index): Promise<FileEntry> => {
      const pathname = path.join(transcriptRoot, `session-${String(index).padStart(4, "0")}.jsonl`);
      const content = `${JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/large-inventory" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "ready" } })}\n`;
      await writeFile(pathname, content);
      return {
        path: pathname,
        root: "codex-sessions",
        name: path.basename(pathname),
        project: "large-inventory",
        title: `Session ${index}`,
        engine: "codex",
        kind: "session",
        fmt: "codex",
        parent: null,
        mtime: Date.now() / 1_000,
        size: Buffer.byteLength(content),
        activity: "idle",
        proc: null,
        pid: null,
        model: null,
        pendingQuestion: null,
        waitingInput: null,
      };
    }));
    const registry = new AgentRegistry(path.join(base, "agent-registry.json"));
    await reconcileMigrationInventory(registry, files);

    let reconciliationFinished = false;
    let mutationRanDuringReconciliation = false;
    const lags = await eventLoopLagsWhile(async () => {
      const reconciliation = reconcileMigrationInventory(registry, files);
      const mutation = new Promise<void>((resolve) => {
        setImmediate(() => {
          mutationRanDuringReconciliation = !reconciliationFinished;
          registry.reconcileConversations([{
            engine: "codex",
            path: files[0]!.path,
            accountId: null,
            launchProfile: emptyLaunchProfile({ cwd: "/repo/large-inventory" }),
            turn: { state: "busy", source: "assistant", terminalAt: null },
            observedAt: new Date().toISOString(),
          }]);
          resolve();
        });
      });
      await reconciliation;
      reconciliationFinished = true;
      await mutation;
    });

    expect(Object.keys(registry.snapshot().conversations)).toHaveLength(LARGE_INVENTORY_SIZE);
    expect(mutationRanDuringReconciliation).toBe(true);
    expect(registry.conversationForPath(files[0]!.path)?.turn.state).toBe("busy");
    console.info({ reconciliationLagP95Ms: percentile(lags, 0.95), reconciliationLagMaxMs: Math.max(...lags) });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);

test("a complete initial controller cycle yields during every cooperative phase", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-full-controller-lag-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(base, "state");
  try {
    const transcriptRoot = path.join(base, "sessions");
    await mkdir(transcriptRoot, { recursive: true });
    const files = await Promise.all(Array.from({ length: LARGE_INVENTORY_SIZE }, async (_, index): Promise<FileEntry> => {
      const pathname = path.join(transcriptRoot, `controller-${String(index).padStart(4, "0")}.jsonl`);
      const content = [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/full-controller" } }),
        ...Array.from({ length: 63 }, () => JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "r".repeat(1_900) },
        })),
      ].join("\n") + "\n";
      await writeFile(pathname, content);
      return {
        path: pathname,
        root: "codex-sessions",
        name: path.basename(pathname),
        project: "full-controller",
        title: `Controller session ${index}`,
        engine: "codex",
        kind: "session",
        fmt: "codex",
        parent: null,
        mtime: Date.now() / 1_000,
        size: Buffer.byteLength(content),
        activity: "idle",
        proc: null,
        pid: null,
        model: null,
        pendingQuestion: null,
        waitingInput: null,
      };
    }));
    const registry = new AgentRegistry(path.join(base, "agent-registry.json"));
    const visited: string[] = [];
    const cooperativePhase = async (name: string): Promise<void> => {
      visited.push(name);
      let completed = false;
      const progress = new Promise<boolean>(resolve => setImmediate(() => resolve(!completed)));
      try {
        await forEachCooperatively(files, (file) => {
          JSON.parse(JSON.stringify({ path: file.path, title: file.title, size: file.size }));
        });
      } finally { completed = true; }
      expect(await progress, `${name} must yield while its batch remains pending`).toBe(true);
    };
    const controller = new AccountMigrationController(
      registry,
      { tick: async () => undefined },
      null,
      {
        scan: async () => {
          await cooperativePhase("scan");
          return { files, projectCatalog: [], complete: true };
        },
        reconcileFlowOwnership: async () => cooperativePhase("flows"),
        reconcileWorkflowOwnership: async () => cooperativePhase("workflows"),
        reconcileHandoffOwnership: async () => cooperativePhase("handoffs"),
        reconcileFiles: async () => cooperativePhase("file-controllers"),
        reconcileRuntime: async (currentRegistry, currentFiles) => {
          visited.push("runtime");
          await runReaperCycle({
            registry: currentRegistry,
            hosts: [],
            files: currentFiles,
            actuation: { loadFlows: () => [] },
          });
        },
        reconcileTaskStore: async () => cooperativePhase("tasks"),
        syncRouting: async () => cooperativePhase("routing"),
        reconcileMigrationCycle: async () => cooperativePhase("migrations"),
      },
    );

    const lags = await eventLoopLagsWhile(() => controller.tick());

    expect(visited).toEqual([
      "scan",
      "flows",
      "workflows",
      "handoffs",
      "file-controllers",
      "runtime",
      "tasks",
      "routing",
      "migrations",
    ]);
    expect(Object.keys(registry.snapshot().conversations)).toHaveLength(LARGE_INVENTORY_SIZE);
    console.info({ controllerLagP95Ms: percentile(lags, 0.95), controllerLagMaxMs: Math.max(...lags) });
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);

test("authorship scanning yields while reading one large transcript", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-large-authorship-lag-"));
  const previousStateDir = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(base, "state");
  try {
    const pathname = path.join(base, "large.jsonl");
    const sessionRecord = JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/large-authorship" } }) + "\n";
    const assistantRecord = JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "a".repeat(1_900) },
    }) + "\n";
    const targetBytes = 65 * 1024 * 1024;
    const content = sessionRecord + assistantRecord.repeat(Math.ceil((targetBytes - sessionRecord.length) / assistantRecord.length));
    await writeFile(pathname, content);
    const file: FileEntry = {
      path: pathname,
      root: "codex-sessions",
      name: path.basename(pathname),
      project: "large-authorship",
      title: "Large authorship transcript",
      engine: "codex",
      kind: "session",
      fmt: "codex",
      parent: null,
      mtime: Date.now() / 1_000,
      size: Buffer.byteLength(content),
      activity: "idle",
      proc: null,
      pid: null,
      model: null,
      pendingQuestion: null,
      waitingInput: null,
    };
    const registry = new AgentRegistry(path.join(base, "agent-registry.json"));
    const probe = loopProgressProbe();
    const open = fs.promises.open;
    let heldRead = false;
    const reads: Array<{ mockRestore: () => void }> = [];
    const opening = spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]) === pathname) {
        const read = file.read;
        reads.push(spyOn(file, "read").mockImplementation((function (...readArgs: Parameters<typeof read>) {
          if (heldRead) return read.apply(file, readArgs);
          heldRead = true;
          const release = new Promise<void>(resolve => { probe.arm(resolve); });
          return release.then(() => read.apply(file, readArgs));
        }) as typeof read));
      }
      return file;
    });
    let lags: number[];
    try {
      lags = await eventLoopLagsWhile(() => probe.run(() => runReaperCycle({
        registry,
        hosts: [],
        files: [file],
        actuation: { loadFlows: () => [] },
      })).then(() => undefined));
    } finally { opening.mockRestore(); for (const read of reads) read.mockRestore(); }

    expect(heldRead).toBe(true);
    console.info({ authorshipLagP95Ms: percentile(lags, 0.95), authorshipLagMaxMs: Math.max(...lags) });
  } finally {
    if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDir;
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);


test("a scanner delta uses keyed conversations without hydrating retained registry history", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-keyed-inventory-"));
  const registry = new AgentRegistry(path.join(base, "agent-registry.json"), undefined, undefined, { sqliteMode: "sqlite" });
  const pathname = path.join(base, "changed.jsonl");
  await writeFile(pathname, JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/delta" } }) + "\n");
  const file = { path: pathname, root: "codex-sessions", name: "changed", engine: "codex", kind: "session", fmt: "codex",
    parent: null, project: "delta", title: "Changed", mtime: 1, size: (await fs.promises.stat(pathname)).size,
    activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null } as FileEntry;
  registry.reconcileConversations([{ engine: "codex", path: pathname, accountId: null, launchProfile: emptyLaunchProfile(),
    turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: "2026-10-16T00:00:00Z" }], { snapshot: false });
  const full = spyOn(registry, "readOnlySnapshot").mockImplementation(() => { throw new Error("whole registry read"); });
  try {
    await reconcileMigrationInventory(registry, [file], { readOnlySnapshot: true, incrementalInventory: true });
    expect(registry.conversationForPath(pathname)).not.toBeNull();
  } finally { full.mockRestore(); registry.close(); await rm(base, { recursive: true, force: true }); }
});


test("inventory acknowledgement starts fresh in each real process", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "llv-inventory-restart-"));
  const program = `
    const { AccountMigrationController } = await import(${JSON.stringify(new URL("./controller.ts", import.meta.url).href)});
    const { AgentRegistry } = await import(${JSON.stringify(new URL("../../agent/registry.ts", import.meta.url).href)});
    const registry = new AgentRegistry(process.env.LLV_STATE_DIR + "/registry.json");
    let batches = 0;
    const controller = new AccountMigrationController(registry, {tick: async () => {}}, null, {
      scan: async () => ({files: [], projectCatalog: [], complete: true}),
      reconcileInventory: async () => { batches++; return registry.readOnlySnapshot(); },
      reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {}, reconcileHandoffOwnership: async () => {},
      reconcileFiles: async () => {}, reconcileRuntime: async () => {}, reconcileTaskStore: async () => {}, syncRouting: async () => {},
      reconcileMigrationCycle: async () => {},
    });
    await controller.poll(); await controller.poll();
    registry.close();
    process.stdout.write(JSON.stringify({batches}));
  `;
  try {
    for (let restart = 0; restart < 2; restart++) {
      const child = spawnSync(process.execPath, ["--eval", program], { encoding: "utf8", timeout: 10000,
        env: { ...process.env, LLV_STATE_DIR: base, HOME: path.join(base, "home"), XDG_CONFIG_HOME: path.join(base, "config"), TMPDIR: base } });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ batches: 1 });
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});


test("incremental inventory waits off its loop for a peer-held registry writer", async () => {
  const made = sqliteRegistryFixture("llv-inventory-writer");
  const pathname = path.join(made.root, "changed.jsonl");
  const content = JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/writer" } }) + "\n";
  await writeFile(pathname, content);
  made.registry.reconcileConversations([{ engine: "codex", path: pathname, accountId: null, launchProfile: emptyLaunchProfile(),
    turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: "2026-10-16T00:00:00Z" }], { snapshot: false });
  const file = { path: pathname, engine: "codex", size: Buffer.byteLength(content), mtime: 1, parent: null } as FileEntry;
  const holder = registryLockHolder(made.sqliteFilename);
  const guard = holdBeforeEachWrite(made.registry, holder, 80, /coordinator/);
  let pulses = 0;
  const timer = setInterval(() => { pulses++; }, 5);
  try {
    await reconcileMigrationInventory(made.registry, [file], { readOnlySnapshot: true, incrementalInventory: true });
    expect(guard.unwrapped).toEqual([]);
    expect(pulses).toBeGreaterThan(0);
  } finally { clearInterval(timer); guard.restore(); await holder.close(); made.registry.close(); made.cleanup(); }
});


test("unchanged controller inventory leaves registry-wide link recovery out of the deadline pass", async () => {
  const made = sqliteRegistryFixture("llv-links-inventory");
  const original = agentRegistry();
  setAgentRegistryForTests(made.registry);
  // Complete the existing once-per-process recovery before measuring a warm pass.
  await reconcileFileControllers([]);
  const fullReads: string[] = [];
  const full = spyOn(made.registry, "readOnlySnapshot").mockImplementation(() => {
    const error = new Error("unchanged inventory hydrated history"); fullReads.push(error.stack!); throw error;
  });
  try {
    await reconcileFileControllers([], { inventoryChanged: false });
    expect(fullReads).toEqual([]);
  } finally { full.mockRestore(); setAgentRegistryForTests(original); made.registry.close(); made.cleanup(); }
});


test("idle file reconciliation opens no task admission writer", async () => {
  const admission = spyOn(membership, "admitScannedConversations");
  try {
    await reconcileFileControllers([]);
    expect(admission).not.toHaveBeenCalled();
  } finally { admission.mockRestore(); }
});

test("idle controller tasks open no mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llv-task-idle-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  const mutation = spyOn(taskStore, "mutateTasks");
  try {
    const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
      scan: async () => ({ files: [], projectCatalog: [], complete: true }),
      reconcileInventory: async () => registry.readOnlySnapshot(),
      reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {}, reconcileHandoffOwnership: async () => {},
      reconcileFiles: async () => {}, reconcileRuntime: async () => {}, syncRouting: async () => {}, reconcileMigrationCycle: async () => {},
    });
    await controller.poll();
    expect(mutation).not.toHaveBeenCalled();
  } finally { mutation.mockRestore(); registry.close(); await rm(root, { recursive: true, force: true }); }
});


test("task admission waits asynchronously for a peer and notices removed membership", async () => {
  const prior = taskStore.loadTasks();
  const holder = registryLockHolder(legacyDatabasePath(taskStore.TASKS_FILE));
  const labels: string[][] = [];
  const original = membership.admitScannedConversations;
  const admission = spyOn(membership, "admitScannedConversations").mockImplementation((...args) => {
    labels.push(stateLockWaitsInFlight().map(wait => wait.callSite));
    return original(...args);
  });
  const file = { path: "/fixture/task-admission.jsonl", root: "codex-sessions", name: "task-admission", project: "fixture",
    title: "Task admission fixture", engine: "codex", kind: "session", fmt: "codex", parent: null,
    mtime: 1, size: 1, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null } as FileEntry;
  let pulses = 0;
  const timer = setInterval(() => { pulses++; }, 5);
  try {
    taskStore.saveTasks([]);
    await holder.hold(80);
    await reconcileFileControllers([file], { inventoryChanged: false });
    expect(taskStore.loadTasks().some(task => task.assignments.some(assignment => assignment.path === file.path))).toBe(true);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every(label => label.includes("controller.task-admission"))).toBe(true);
    expect(pulses).toBeGreaterThan(0);
    admission.mockClear();
    await reconcileFileControllers([file], { inventoryChanged: false });
    expect(admission).not.toHaveBeenCalled();
    taskStore.saveTasks([]);
    await reconcileFileControllers([file], { inventoryChanged: false });
    expect(admission).toHaveBeenCalledTimes(1);
  } finally { clearInterval(timer); admission.mockRestore(); await holder.close(); taskStore.saveTasks(prior); }
});


test("controller task preflight preserves real changes and retries a refused writer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "llv-task-preflight-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  const prior = taskStore.loadTasks();
  const pathname = "/fixture/task-preflight.jsonl";
  const conversation = registry.ensureConversation("codex", pathname, null);
  const at = "2026-10-16T00:00:00Z";
  const original = taskStore.mutateTasks;
  let refuse = true;
  const mutation = spyOn(taskStore, "mutateTasks").mockImplementation(((...args: Parameters<typeof original>) => {
    expect(stateLockWaitsInFlight().some(wait => wait.callSite === "controller.tasks")).toBe(true);
    if (refuse) throw new Error("fixture write refused");
    return original(...args);
  }) as typeof original);
  const controller = new AccountMigrationController(registry, { tick: async () => {} }, null, {
    scan: async () => ({ files: [], projectCatalog: [], complete: true }), reconcileInventory: async () => registry.readOnlySnapshot(),
    reconcileFlowOwnership: async () => {}, reconcileWorkflowOwnership: async () => {}, reconcileHandoffOwnership: async () => {},
    reconcileFiles: async () => {}, reconcileRuntime: async () => {}, syncRouting: async () => {}, reconcileMigrationCycle: async () => {},
  });
  try {
    taskStore.saveTasks([{ id: "task-preflight", project: "fixture", status: "inbox", text: "Task preflight", placement: "unplaced",
      assignments: [{ path: pathname, panePid: null, state: "linked", error: null, at }], createdAt: at, updatedAt: at }]);
    await expect(controller.poll()).rejects.toThrow("fixture write refused");
    expect(taskStore.loadTasks()[0]!.assignments[0]!.conversationId).toBeUndefined();
    refuse = false;
    await controller.poll();
    expect(taskStore.loadTasks()[0]!.assignments[0]!.conversationId).toBe(conversation.id);
    expect(mutation).toHaveBeenCalledTimes(2);
    await controller.poll();
    expect(mutation).toHaveBeenCalledTimes(2);
  } finally { mutation.mockRestore(); taskStore.saveTasks(prior); registry.close(); await rm(root, { recursive: true, force: true }); }
});
