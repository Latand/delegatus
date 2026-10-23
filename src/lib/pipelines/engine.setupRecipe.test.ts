import { afterAll, expect, test, fs, os, path, spawnSync, harness, create, loadPipelines, savePipelines, tickPipelines, patchPipeline } from "./engine.fixture";
import { reviewSetupRecipe, setProjectSetupRecipe } from "@/lib/projects/setupRecipe";
import { DEFAULT_CPU_PRESSURE_POLICY } from "@/lib/runtime/cpuPressure";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "engine-setup-"));
const recipe = { command: ["sh", "setup.sh"], cwd: "." };
const stages = [{ id: "build", kind: "run", role: { roleId: "builder" }, sandbox: "restricted", prompt: "Build", next: null }];
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function ready(defaultBuilder = false) {
  const h = harness();
  const created = await create(h.ports, (defaultBuilder ? stages.map(stage => ({ ...stage, role: undefined })) : stages) as never, { repoDir: path.join(root, "repo") });
  await tickPipelines([], h.ports);
  const lane = loadPipelines().find(item => item.id === created.id)!;
  fs.mkdirSync(lane.worktreeDir, { recursive: true });
  fs.writeFileSync(path.join(lane.worktreeDir, "setup.sh"), "echo ready\n");
  const reviewed = await reviewSetupRecipe(lane.worktreeDir, recipe);
  await setProjectSetupRecipe(lane.project, { ...recipe, hash: reviewed.hash, approvedAt: h.ports.now() });
  savePipelines([lane]);
  return { h, lane };
}

test("stage admission precedes setup, failure parks without spawning, and explicit retry keeps failed evidence", async () => {
  const { h, lane } = await ready();
  let setupCalls = 0;
  h.ports.executeProjectSetup = async (cwd, reviewed, sandbox) => {
    expect(cwd).toBe(lane.worktreeDir); expect(sandbox).toBe("restricted"); expect(reviewed.command).toEqual(recipe.command);
    expect(h.spawnInputs).toHaveLength(0);
    setupCalls++;
    return setupCalls === 1 ? { code: 9, stdout: "preparing", stderr: "dependency unavailable" } : { code: 0, stdout: "ready", stderr: "" };
  };
  h.ports.cpuPressureHold = () => ({ since: 0, avg10: 90, deferred: false, policy: DEFAULT_CPU_PRESSURE_POLICY });
  await tickPipelines([], h.ports);
  expect(setupCalls).toBe(0);
  delete h.ports.cpuPressureHold;
  await tickPipelines([], h.ports);
  let current = loadPipelines()[0]!;
  expect(current.state).toBe("needs_decision");
  expect(current.stateDetail).toContain("project setup failed (exit 9)");
  expect(current.runs[0]!.attempts[0]!.setup).toMatchObject({ code: 9, stderr: "dependency unavailable", state: "failed" });
  const read = `import {findPipelineRecord} from ${JSON.stringify(path.resolve("src/lib/pipelines/store.ts"))};
    const setup=findPipelineRecord(${JSON.stringify(lane.id)}).runs[0].attempts[0].setup;
    console.log(JSON.stringify({state:setup.state,code:setup.code,stdout:setup.stdout}));`;
  const fresh = spawnSync(process.execPath, ["-e", read], { env: { ...process.env }, encoding: "utf8" });
  expect(fresh.status).toBe(0);
  expect(JSON.parse(fresh.stdout.trim())).toEqual({ state: "failed", code: 9, stdout: "preparing" });
  expect(h.spawnInputs).toHaveLength(0);
  const retried = await patchPipeline(lane.id, { action: "retry-stage", expectedStageId: "build", expectedAttempt: 1 }, h.ports);
  expect(retried.error).toBeUndefined();
  await tickPipelines([], h.ports);
  current = loadPipelines()[0]!;
  expect(setupCalls).toBe(2);
  expect(current.runs[0]!.attempts[0]!.setup?.code).toBe(9);
  expect(current.runs[0]!.attempts.at(-1)!.setup?.state).toBe("passed");
  expect(h.spawnInputs).toHaveLength(1);
});

test("changed content parks the real stage until a fresh operator approval and retry", async () => {
  const { h, lane } = await ready();
  fs.writeFileSync(path.join(lane.worktreeDir, "setup.sh"), "echo changed\n");
  let calls = 0;
  h.ports.executeProjectSetup = async () => { calls++; return { code: 0, stdout: "ready", stderr: "" }; };
  await tickPipelines([], h.ports);
  expect(loadPipelines()[0]!.stateDetail).toContain("operator must review and approve");
  expect(calls).toBe(0); expect(h.spawnInputs).toHaveLength(0);
  const reviewed = await reviewSetupRecipe(lane.worktreeDir, recipe);
  await setProjectSetupRecipe(lane.project, { ...recipe, hash: reviewed.hash, approvedAt: h.ports.now() });
  await patchPipeline(lane.id, { action: "retry-stage", expectedStageId: "build", expectedAttempt: 1 }, h.ports);
  await tickPipelines([], h.ports);
  expect(calls).toBe(1); expect(h.spawnInputs).toHaveLength(1);
});

test("a stage using the implicit Builder defaults also prepares its worktree", async () => {
  const { h } = await ready(true);
  let calls = 0;
  h.ports.executeProjectSetup = async () => { calls++; return { code: 0, stdout: "ready", stderr: "" }; };
  await tickPipelines([], h.ports);
  expect(calls).toBe(1); expect(h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.setup?.state).toBe("passed");
});
