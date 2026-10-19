import "./engineEnvironment.fixture";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, spyOn, test } from "bun:test";
import { create, harness, tickPipelines, loadPipelines, savePipelines, defaultPipelinePorts, AgentRegistry, setAgentRegistryForTests, accountManager } from "./engine.fixture";
import { roleMemoryCollection } from "@/lib/memory/roleStore";
import { TaskPageWorker, shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";
import { sharedLinkState } from "@/lib/links/runtimeState";

const oldRule = "Preserve fixtureword receipts until the owning operation completes";
const newRule = "Verify silver orchard evidence before the operation completes";
function write(rule: string) {
  roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({
    kind: "rule", id: "r_launch_race", scope: "machine", rule, why: "", state: "active", hints: [],
    source: { project: "fixture", pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_fixture" },
    createdAt: "2026-10-14T00:00:00Z", changedAt: "2026-10-14T00:00:00Z",
  }));
}
afterEach(shutdownTaskPageWorker);

test.each([
  { boundary: "composition", fileBacked: false }, { boundary: "worker", fileBacked: false },
  { boundary: "composition", fileBacked: true }, { boundary: "worker", fileBacked: true },
] as const)("launch re-reads a role-memory write during $boundary (file-backed=$fileBacked)", async ({ boundary, fileBacked }) => {
  savePipelines([]);
  write(oldRule);
  const h = harness();
  let changed = false;
  const change = () => { if (!changed) { changed = true; write(newRule); } };
  if (boundary === "composition") {
    const exec = h.ports.exec;
    h.ports.exec = async (...args) => {
      if (args[1][0] === "rev-parse" && args[1][1] === "--show-toplevel") { change(); return { code: 1, stdout: "", stderr: "plain fixture directory" }; }
      return await exec(...args);
    };
  } else {
    const pool = sharedLinkState("taskPages.worker", () => ({ directory: "", worker: null as TaskPageWorker | null }));
    pool.directory = process.env.LLV_STATE_DIR!;
    pool.worker = new TaskPageWorker({ onPhase: change });
  }
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: `Build. ${oldRule}. ${newRule}`, next: null }] as never, { repoDir: path.join(process.env.LLV_STATE_DIR!, "repo") });
  if (fileBacked) {
    const lane = loadPipelines()[0]!;
    lane.spec = `${oldRule}. ${newRule}. ` + "Context ".repeat(5_000);
    savePipelines([lane]);
  }
  await tickPipelines([], h.ports);
  const prepared = loadPipelines()[0]!;
  fs.mkdirSync(prepared.worktreeDir!, { recursive: true });
  await tickPipelines([], h.ports);
  const pipeline = loadPipelines()[0]!;
  expect(changed).toBe(true);
  expect(pipeline.stateDetail).toBeNull();
  expect(pipeline.state).toBe("running");
  expect(h.spawnInputs).toHaveLength(1);
  const sent = h.spawnInputs[0]!.prompt;
  const artifact = sent.match(/Full (?:stage prompt|specification) file: (.+)\n/)?.[1];
  expect(Boolean(artifact)).toBe(fileBacked);
  const full = artifact ? fs.readFileSync(artifact, "utf8") : sent;
  expect(full).not.toContain(newRule);
  expect(full).toContain(oldRule);
  expect(full).toContain("[learned rule]");
}, 30_000);


test.each(["reclassify", "file-reclassify", "churn", "corrupt", "pause"] as const)("admission rechecks privacy and activation before dispatch: %s", async mode => {
  savePipelines([]);
  write(oldRule);
  const h = harness();
  let preparePrompt: (() => Promise<string>) | undefined;
  const recordSpawn = h.ports.spawnAgent;
  h.ports.spawnAgent = (input, reserved, prepare) => {
    preparePrompt = prepare;
    return recordSpawn(input, reserved);
  };
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: `Build. ${newRule}`, next: null }] as never, { repoDir: path.join(process.env.LLV_STATE_DIR!, "admission-repo") });
  if (mode === "file-reclassify") {
    const lane = loadPipelines()[0]!;
    lane.spec = `${newRule}. ` + "Context ".repeat(5_000);
    savePipelines([lane]);
  }
  await tickPipelines([], h.ports);
  fs.mkdirSync(loadPipelines()[0]!.worktreeDir!, { recursive: true });
  await tickPipelines([], h.ports);
  const input = h.spawnInputs[0]!;
  expect(input.prompt).toContain(newRule);
  input.cwd = path.join(process.env.LLV_STATE_DIR!, `dispatch-cwd-${mode}`);
  fs.mkdirSync(input.cwd);
  const binary = path.join(process.env.LLV_STATE_DIR!, "codex-fixture");
  fs.writeFileSync(binary, "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o700 });
  const priorBinary = process.env.LLV_CODEX_BINARY;
  process.env.LLV_CODEX_BINARY = binary;
  const registry = new AgentRegistry(path.join(process.env.LLV_STATE_DIR!, `dispatch-registry-${mode}.json`));
  setAgentRegistryForTests(registry);
  const clientModule = await import("@/lib/runtime/client");
  const spawnModule = await import("@/lib/runtime/structuredSpawn");
  const guardModule = await import("@/lib/git/stageAttemptGuard");
  const resolve = spyOn(accountManager, "resolveProjectSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture-account", kind: "managed", home: process.env.LLV_STATE_DIR!,
    transcriptRoot: process.env.LLV_STATE_DIR!, env: { NODE_ENV: "test" },
  }});
  const client = spyOn(clientModule, "runtimeHostClient").mockReturnValue({} as never);
  const guard = spyOn(guardModule, "prepareStageGitGuard").mockResolvedValue({});
  const sent: string[] = [];
  const spawn = spyOn(spawnModule, "spawnStructuredConversation").mockImplementation(async input => {
    sent.push(input.prompt);
    return { path: null } as never;
  });
  let reservations = 0;
  try {
    const launch = defaultPipelinePorts().spawnAgent(input, () => {
      ++reservations;
      if (reservations < 2) return;
      if (mode === "pause") throw new Error("activation superseded in fixture");
      if (mode === "churn") write(`${newRule} revision ${reservations}`);
      if ((mode === "reclassify" || mode === "file-reclassify") && reservations === 2) write(newRule);
      if (mode === "corrupt") {
        roleMemoryCollection(true)!.boundedPatch(1, tx => tx.put({ kind: "rule", id: 7, rule: newRule } as never));
      }
    }, preparePrompt);
    if (mode === "reclassify" || mode === "file-reclassify") {
      await launch;
      expect(reservations).toBe(3);
      expect(sent).toHaveLength(1);
      expect(sent[0]).not.toContain(newRule);
      expect(sent[0]).toContain("[learned rule]");
      if (mode === "file-reclassify") {
        const file = sent[0]!.match(/Full (?:stage prompt|specification) file: (.+)\n/)?.[1];
        expect(file).toBeDefined();
        expect(fs.readFileSync(file!, "utf8").includes(newRule)).toBe(false);
      }
    } else {
      await expect(launch).rejects.toThrow(mode === "churn" ? "retrying before dispatch" : mode === "pause" ? "activation superseded" : "role memory could not be read");
      expect(sent).toHaveLength(0);
      expect(reservations).toBe(mode === "churn" ? 4 : 2);
      if (mode === "churn") {
        // Exercise the controller's retirement of its own failed reservation.
        const pending = harness();
        const defaults = defaultPipelinePorts();
        let changing = true;
        let changes = 0;
        pending.ports.spawnReceipt = defaults.spawnReceipt;
        pending.ports.claimSpawnRetry = defaults.claimSpawnRetry;
        pending.ports.spawnAgent = (request, onReserved) => defaults.spawnAgent({ ...request, cwd: input.cwd }, async reservation => {
          await onReserved(reservation);
          if (changing) write(`${newRule} controller revision ${++changes}`);
        });
        await create(pending.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build safely", next: null }] as never);
        await tickPipelines([], pending.ports);
        await tickPipelines([], pending.ports);
        const deferred = loadPipelines()[0]!;
        expect(deferred.state).toBe("running");
        expect(deferred.cursor?.state).toBe("pending");
        expect(deferred.runs[0]!.attempts.at(-1)?.retiredLaunches).toHaveLength(1);
        expect(sent).toHaveLength(0);
        changing = false;
        await tickPipelines([], pending.ports);
        expect(sent).toHaveLength(1);
        expect(loadPipelines()[0]!.cursor?.state).toBe("running");
      }
    }
  } finally {
    resolve.mockRestore(); client.mockRestore(); guard.mockRestore(); spawn.mockRestore(); setAgentRegistryForTests(null);
    if (priorBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = priorBinary;
    if (mode === "corrupt") roleMemoryCollection(true)!.boundedPatch(1, tx => tx.delete("r:7"));
  }
}, 30_000);

test("continuous memory writes defer the launch and the next stable tick sends once", async () => {
  write(oldRule);
  const h = harness();
  const root = path.join(process.env.LLV_STATE_DIR!, "churn-repo");
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build with current privacy", next: null }] as never, { repoDir: root });
  await tickPipelines([], h.ports);
  fs.mkdirSync(loadPipelines()[0]!.worktreeDir!, { recursive: true });
  const exec = h.ports.exec;
  let writes = 0;
  let changing = true;
  h.ports.exec = async (...args) => {
    if (args[1][0] === "rev-parse" && args[1][1] === "--show-toplevel") {
      if (changing) write(`${newRule} version ${++writes}`);
      return { code: 1, stdout: "", stderr: "plain fixture directory" };
    }
    return await exec(...args);
  };
  await tickPipelines([], h.ports);
  expect(writes).toBe(3);
  expect(loadPipelines()[0]!.state).toBe("running");
  expect(loadPipelines()[0]!.cursor?.state).toBe("pending");
  expect(h.spawnInputs).toHaveLength(0);
  changing = false;
  const resumed = spawnSync(process.execPath, ["test", import.meta.path, "-t", "resume deferred privacy"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
    env: { ...process.env, LLV_ROLE_PRIVACY_RESUME_STATE: process.env.LLV_STATE_DIR },
  });
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(resumed.stderr).toContain("1 pass");
  expect(loadPipelines()[0]!.cursor?.state).toBe("running");
  expect(h.spawnInputs).toHaveLength(0);
}, 30_000);

test.skipIf(!process.env.LLV_ROLE_PRIVACY_RESUME_STATE)("resume deferred privacy after a controller process restart", async () => {
  const ownState = process.env.LLV_STATE_DIR!;
  process.env.LLV_STATE_DIR = process.env.LLV_ROLE_PRIVACY_RESUME_STATE!;
  try {
    const h = harness();
    expect(loadPipelines()[0]!.cursor?.state).toBe("pending");
    await tickPipelines([], h.ports);
    expect(loadPipelines()[0]!.cursor?.state).toBe("running");
    expect(h.spawnInputs).toHaveLength(1);
  } finally { process.env.LLV_STATE_DIR = ownState; }
});

test("corrupt role memory remains a visible launch refusal", async () => {
  write(oldRule);
  const { Database } = await import("bun:sqlite");
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
  db.query("UPDATE state_rows SET value_json = ? WHERE collection = 'role_memory' AND row_key = 'r:r_launch_race'")
    .run(JSON.stringify({ kind: "rule", id: 7, rule: oldRule }));
  db.close();
  const h = harness();
  await create(h.ports, [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build with current privacy", next: null }] as never);
  await tickPipelines([], h.ports);
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.state).toBe("needs_decision");
  expect(loadPipelines()[0]!.stateDetail).toContain("role memory could not be read");
  expect(loadPipelines()[0]!.stateDetail).not.toContain(oldRule);
  expect(h.spawnInputs).toHaveLength(0);
}, 30_000);
