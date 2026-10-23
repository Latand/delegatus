import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectSetupRecipe, reviewSetupRecipe, setProjectSetupRecipe } from "@/lib/projects/setupRecipe";
import { preparePipelineSetup } from "./setupRecipe";
import { persistProjectAliases } from "@/lib/projects/aliases";
import type { Pipeline, PipelineStage, PipelineStageAttempt } from "./types";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-recipe-test-"));
const state = process.env.LLV_STATE_DIR;
const now = () => "2026-10-23T10:00:00.000Z";
const recipe = { command: ["sh", "setup.sh"], cwd: "." };
const attempt = () => ({ n: 1, effectiveRole: { roleId: "builder" } }) as PipelineStageAttempt;
const stage = { sandbox: "restricted" } as PipelineStage;
let lane: Pipeline;
beforeEach(() => {
  process.env.LLV_STATE_DIR = path.join(root, "state");
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
  fs.rmSync(path.join(process.env.LLV_STATE_DIR, "project-setup.json"), { force: true });
  fs.writeFileSync(path.join(root, "setup.sh"), "echo ready\n");
  lane = { project: "setup-project", worktreeDir: root, runs: [{ stageId: "build", attempts: [] }] } as unknown as Pipeline;
});
afterAll(() => {
  if (state === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = state;
  fs.rmSync(root, { recursive: true, force: true });
});
async function approve() {
  const reviewed = await reviewSetupRecipe(root, recipe);
  await setProjectSetupRecipe(lane.project, { ...recipe, hash: reviewed.hash, approvedAt: now() });
}

test("setup is off by default, and non-builder stages never run it", async () => {
  expect(await projectSetupRecipe(lane.project)).toBeNull();
  let calls = 0;
  const execute = async () => { calls++; return { code: 0, stdout: "ready", stderr: "" }; };
  await preparePipelineSetup(lane, stage, attempt(), now, () => {}, execute);
  await approve();
  const planning = attempt(); planning.effectiveRole.roleId = "architect";
  await preparePipelineSetup(lane, stage, planning, now, () => {}, execute);
  expect(calls).toBe(0);
});

test("a durable start precedes execution; success runs once and retains cwd, output and exit", async () => {
  await approve();
  const current = attempt(); lane.runs[0]!.attempts.push(current);
  const checkpoints: string[] = [];
  let calls = 0;
  await preparePipelineSetup(lane, stage, current, now, () => { checkpoints.push(current.setup!.state); }, async (cwd, reviewed, sandbox) => {
    expect(checkpoints).toEqual(["running", "running"]);
    expect(cwd).toBe(root); expect(sandbox).toBe("restricted");
    expect(reviewed.files["setup.sh"]!.toString()).toBe("echo ready\n");
    calls++; return { code: 0, stdout: "ready\n", stderr: "" };
  });
  expect(current.setup).toMatchObject({ state: "passed", cwd: root, code: 0, stdout: "ready", completedAt: now() });
  await preparePipelineSetup(lane, stage, attempt(), now, () => {}, async () => { calls++; throw new Error("replayed"); });
  expect(calls).toBe(1);
});

test("changed script, command, missing script and unusable settings refuse before execution", async () => {
  await approve();
  const approved = (await projectSetupRecipe(lane.project))!;
  for (const change of ["script", "command", "missing"] as const) {
    fs.writeFileSync(path.join(root, "setup.sh"), change === "script" ? "echo changed\n" : "echo ready\n");
    await setProjectSetupRecipe(lane.project, { ...approved, command: change === "command" ? ["bash", "setup.sh"] : recipe.command });
    if (change === "missing") fs.unlinkSync(path.join(root, "setup.sh"));
    let calls = 0;
    const current = attempt();
    await expect(preparePipelineSetup(lane, stage, current, now, () => {}, async () => { calls++; return { code: 0, stdout: "", stderr: "" }; })).rejects.toThrow();
    expect(calls).toBe(0); expect(current.setup?.state).toBe("failed");
  }
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "project-setup.json"), "broken");
  expect(() => projectSetupRecipe(lane.project)).toThrow("unreadable");
});

test("failed output is retained, a fresh attempt retries, and approval revocation during preparation refuses", async () => {
  await approve();
  const first = attempt(); lane.runs[0]!.attempts.push(first);
  await expect(preparePipelineSetup(lane, stage, first, now, () => {}, async () => ({ code: 7, stdout: "preparing", stderr: "dependency unavailable" }))).rejects.toThrow("exit 7");
  expect(first.setup).toMatchObject({ state: "failed", code: 7, stdout: "preparing", stderr: "dependency unavailable" });
  const retry = attempt(); retry.n = 2;
  await preparePipelineSetup(lane, stage, retry, now, () => {}, async () => ({ code: 0, stdout: "recovered", stderr: "" }));
  expect(first.setup?.code).toBe(7); expect(retry.setup?.state).toBe("passed");
  const current = attempt(); let calls = 0;
  await expect(preparePipelineSetup(lane, stage, current, now, async () => { await setProjectSetupRecipe(lane.project, null); }, async () => { calls++; return { code: 0, stdout: "", stderr: "" }; })).rejects.toThrow("approval changed");
  expect(calls).toBe(0);
});

test("a fresh real process refuses an interrupted start rather than repeating its effects", async () => {
  await approve();
  const current = attempt();
  await expect(preparePipelineSetup(lane, stage, current, now, () => { throw new Error("restart cut"); })).rejects.toThrow("restart cut");
  const saved = path.join(root, "attempt.json"); fs.writeFileSync(saved, JSON.stringify(current));
  const source = `import fs from 'node:fs'; import {preparePipelineSetup} from ${JSON.stringify(path.resolve("src/lib/pipelines/setupRecipe.ts"))};
    const attempt=JSON.parse(fs.readFileSync(process.env.SETUP_ATTEMPT,'utf8'));
    try { await preparePipelineSetup({project:'setup-project',runs:[]}, {}, attempt,()=>${JSON.stringify(now())},()=>{},async()=>{throw new Error('effect repeated')}); process.exit(2); }
    catch(error) { if (!error.message.includes('interrupted or failed') || attempt.setup.state!=='failed') throw error; console.log('retained-start-refused'); }`;
  const child = spawnSync(process.execPath, ["-e", source], { env: { ...process.env, SETUP_ATTEMPT: saved }, encoding: "utf8" });
  expect(child.status).toBe(0); expect(child.stdout).toContain("retained-start-refused");
});

test("cwd traversal, linked scripts and shell expressions are refused", async () => {
  await expect(reviewSetupRecipe(root, { ...recipe, cwd: "../outside" })).rejects.toThrow();
  await expect(reviewSetupRecipe(root, { command: ["sh", "-c", "echo unreviewed"], cwd: "." })).rejects.toThrow();
  fs.symlinkSync("setup.sh", path.join(root, "link.sh"));
  await expect(reviewSetupRecipe(root, { command: ["sh", "link.sh"], cwd: "." })).rejects.toThrow("symbolic links");
});

test("every named script is pinned, and cwd is part of the approval", async () => {
  fs.writeFileSync(path.join(root, "additional.sh"), "echo first\n");
  const command = { command: ["sh", "setup.sh", "additional.sh"], cwd: "." };
  const first = await reviewSetupRecipe(root, command);
  expect(Object.keys(first.files).sort()).toEqual(["additional.sh", "setup.sh"]);
  fs.writeFileSync(path.join(root, "additional.sh"), "echo second\n");
  expect((await reviewSetupRecipe(root, command)).hash).not.toBe(first.hash);
  expect(first.files["additional.sh"]!.toString()).toBe("echo first\n");
  fs.mkdirSync(path.join(root, "subdir"));
  fs.writeFileSync(path.join(root, "subdir/setup.sh"), "echo ready\n");
  expect((await reviewSetupRecipe(root, { ...recipe, cwd: "subdir" })).hash).not.toBe((await reviewSetupRecipe(root, recipe)).hash);
});

test("approval is rechecked at the final dispatch seam and superseded activations cannot start", async () => {
  await approve();
  let effects = 0;
  const current = attempt();
  await expect(preparePipelineSetup(lane, stage, current, now, () => {}, async (_cwd, _recipe, _sandbox, _signal, authorize) => {
    await setProjectSetupRecipe(lane.project, null);
    authorize!(); effects++;
    return { code: 0, stdout: "", stderr: "" };
  })).rejects.toThrow("approval changed");
  expect(effects).toBe(0);
  await approve();
  await expect(preparePipelineSetup(lane, stage, attempt(), now, () => {}, async () => {
    effects++; return { code: 0, stdout: "", stderr: "" };
  }, undefined, () => { throw new Error("activation superseded"); })).rejects.toThrow("superseded");
  expect(effects).toBe(0);
});

test("project moves retain approval, conflicting predecessors refuse, and explicit disable wins", async () => {
  const reviewed = await reviewSetupRecipe(root, recipe);
  const approved = { ...recipe, hash: reviewed.hash, approvedAt: now() };
  await setProjectSetupRecipe("setup-old", approved);
  expect(persistProjectAliases([{ source: "setup-old", target: "setup-new", displayName: "Setup project" }])).toBe(true);
  expect(projectSetupRecipe("setup-new")).toEqual(approved);
  await setProjectSetupRecipe("setup-new", null);
  expect(projectSetupRecipe("setup-old")).toBeNull();
  await setProjectSetupRecipe("setup-source-a", approved);
  await setProjectSetupRecipe("setup-source-b", { ...approved, hash: "b".repeat(64) });
  expect(persistProjectAliases([
    { source: "setup-source-a", target: "setup-conflict", displayName: "Setup project" },
    { source: "setup-source-b", target: "setup-conflict", displayName: "Setup project" },
  ])).toBe(true);
  expect(() => projectSetupRecipe("setup-conflict")).toThrow("conflict");
});

test("adopted historical builders and their setup results cannot mark a new checkout prepared", async () => {
  await approve();
  const historical = attempt();
  historical.historical = true;
  historical.launchId = "previous-launch";
  historical.setup = { command: recipe.command, cwd: root, hash: projectSetupRecipe(lane.project)!.hash,
    state: "passed", startedAt: now(), completedAt: now(), code: 0, stdout: "old output", stderr: "" };
  lane.runs[0]!.attempts.push(historical);
  let calls = 0;
  const current = attempt();
  await preparePipelineSetup(lane, stage, current, now, () => {}, async () => { calls++; return { code: 0, stdout: "new output", stderr: "" }; });
  expect(calls).toBe(1);
  expect(current.setup?.stdout).toBe("new output");
});
