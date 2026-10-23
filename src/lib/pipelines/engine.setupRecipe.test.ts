import { afterAll, expect, test, fs, os, path, spawnSync, harness, create, loadPipelines, savePipelines, tickPipelines, patchPipeline } from "./engine.fixture";
import { reviewSetupRecipe, setProjectSetupRecipe } from "@/lib/projects/setupRecipe";
import { settlePipelineControllerJobs } from "./controllerJobs";
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
  await settlePipelineControllerJobs();
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
  await settlePipelineControllerJobs();
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
  await settlePipelineControllerJobs();
  expect(loadPipelines()[0]!.stateDetail).toContain("operator must review and approve");
  expect(calls).toBe(0); expect(h.spawnInputs).toHaveLength(0);
  const reviewed = await reviewSetupRecipe(lane.worktreeDir, recipe);
  await setProjectSetupRecipe(lane.project, { ...recipe, hash: reviewed.hash, approvedAt: h.ports.now() });
  await patchPipeline(lane.id, { action: "retry-stage", expectedStageId: "build", expectedAttempt: 1 }, h.ports);
  await tickPipelines([], h.ports);
  await settlePipelineControllerJobs();
  expect(calls).toBe(1); expect(h.spawnInputs).toHaveLength(1);
});

test("a stage using the implicit Builder defaults also prepares its worktree", async () => {
  const { h } = await ready(true);
  let calls = 0;
  h.ports.executeProjectSetup = async () => { calls++; return { code: 0, stdout: "ready", stderr: "" }; };
  await tickPipelines([], h.ports);
  await settlePipelineControllerJobs();
  expect(calls).toBe(1); expect(h.spawnInputs).toHaveLength(1);
  expect(loadPipelines()[0]!.runs[0]!.attempts[0]!.setup?.state).toBe("passed");
});

test("blocked setup leaves ticks returning and another lane spawning", async () => {
  const { h, lane } = await ready();
  const other = structuredClone(lane);
  other.id = "other-setup-lane"; other.project = "other-setup-project";
  other.worktreeDir = path.join(path.dirname(other.repoDir), `${path.basename(other.repoDir)}-pipeline-${other.id}`);
  other.branch = lane.branch.slice(0, -lane.id.length) + other.id;
  if (other.delivery) {
    other.delivery.ownerId = other.id;
    other.delivery.target.branch = `refs/heads/${other.branch}`;
  }
  savePipelines([lane, other]);
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  h.ports.executeProjectSetup = async () => { entered(); await blocked; return { code: 0, stdout: "ready", stderr: "" }; };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const tick = tickPipelines([], h.ports);
  try {
    // The deadline only catches a stuck controller; readiness proves setup ran.
    await Promise.race([tick, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("controller waited for project setup")), 3000); deadline.unref();
    })]);
    clearTimeout(deadline);
    await started;
    await tickPipelines([], h.ports);
    expect(h.spawnInputs.some(input => input.cwd === other.worktreeDir)).toBe(true);
    expect(h.spawnInputs.some(input => input.cwd === lane.worktreeDir)).toBe(false);
    expect(loadPipelines().find(item => item.id === lane.id)!.runs[0]!.attempts[0]!.setup?.state).toBe("running");
  } finally { clearTimeout(deadline); release(); await tick; await settlePipelineControllerJobs(); }
  expect(h.spawnInputs.filter(input => input.cwd === lane.worktreeDir)).toHaveLength(1);
});

test("pausing a background setup aborts it and fences the builder launch", async () => {
  const { h, lane } = await ready();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const finished = new Promise<void>(resolve => { release = resolve; });
  let aborted = false;
  h.ports.executeProjectSetup = async (_root, _recipe, _sandbox, signal) => {
    entered();
    const cancel = () => { aborted = true; release(); };
    signal!.addEventListener("abort", cancel, { once: true });
    if (signal!.aborted) cancel();
    try { await finished; return { code: null, stdout: "partial setup", stderr: "setup cancelled" }; }
    finally { signal!.removeEventListener("abort", cancel); }
  };
  try {
    await tickPipelines([], h.ports); await started;
    const paused = await patchPipeline(lane.id, { action: "pause" }, h.ports);
    expect(paused.error).toBeUndefined();
    await settlePipelineControllerJobs();
    expect(aborted).toBe(true); expect(h.spawnInputs).toHaveLength(0);
    expect(loadPipelines()[0]!.state).toBe("paused");
  } finally { release(); await settlePipelineControllerJobs(); }
});
