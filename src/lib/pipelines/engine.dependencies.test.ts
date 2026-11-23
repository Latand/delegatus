import { expect, spyOn, test, fs, path, harness, create, tickPipelines, savePipelines, loadPipelines, rawPatchPipeline } from "./engine.fixture";
import { lockedFixture } from "./fixtures/lockedDependencies";
import { realExec } from "../workflows/provision";
import { prepareWorktreeDependencies } from "./worktreeDependencies";
import { prepareLockedDependencies } from "./lockedDependencies";

async function resumedLane(f: Awaited<ReturnType<typeof lockedFixture>>, h: ReturnType<typeof harness>) {
  const pipeline = await create(h.ports, [
    { id: "build", kind: "run", role: { roleId: "builder" }, access: "read-write", prompt: "Build", next: null },
  ] as never, { repoDir: f.repoDir });
  await f.run(["git", "worktree", "move", f.worktreeDir, pipeline.worktreeDir]);
  f.worktreeDir = pipeline.worktreeDir;
  f.pipeline.worktreeDir = pipeline.worktreeDir;
  await f.run(["git", "branch", "--move", pipeline.branch], f.worktreeDir);
  // Resume a persisted, already-provisioned lane through the real controller.
  Object.assign(pipeline, { baseBranch: f.pipeline.baseBranch, baseRef: f.pipeline.baseRef,
    lastPassedCommit: f.pipeline.baseRef, state: "running" });
  return pipeline;
}

test.each(["missing", "lagging-link", "matching", "unrepairable"])("resumed stage validates %s dependencies before dispatch", async shape => {
  const f = await lockedFixture();
  const h = harness();
  try {
    const pipeline = await resumedLane(f, h);
    const source = path.join(f.repoDir, "node_modules"), local = path.join(f.worktreeDir, "node_modules");
    if (shape === "matching") await prepareWorktreeDependencies(f.pipeline);
    if (shape === "missing") fs.rmSync(source, { recursive: true });
    if (shape === "lagging-link") {
      await f.makeLagging();
      expect(JSON.parse(fs.readFileSync(path.join(source, "fixture-tool/package.json"), "utf8")).version).toBe("1.0.0");
      fs.symlinkSync(source, local, "dir");
    }
    let previousTarget: string | undefined;
    if (shape === "unrepairable") {
      await prepareWorktreeDependencies(f.pipeline);
      previousTarget = fs.realpathSync(local);
      fs.writeFileSync(path.join(f.worktreeDir, "bun.lock"), "invalid lockfile");
    }
    savePipelines([pipeline]);
    h.ports.exec = realExec;
    const spawn = h.ports.spawnAgent;
    let dispatches = 0;
    const observed: { version?: string; linked?: boolean } = {};
    h.ports.spawnAgent = async (input, reserved) => {
      dispatches++;
      if (fs.existsSync(local)) {
        observed.linked = fs.lstatSync(local).isSymbolicLink();
        observed.version = JSON.parse(fs.readFileSync(path.join(local, "fixture-tool/package.json"), "utf8")).version;
      }
      return spawn(input, reserved);
    };
    await tickPipelines([], h.ports);
    const current = loadPipelines().find(row => row.id === pipeline.id)!;
    if (shape === "unrepairable") {
      expect(dispatches).toBe(0);
      expect(current.stateDetail).toContain("stage environment: dependency preparation failed");
      expect(current.stateDetail).toContain("ParserError");
      expect(current.stateDetail).toContain("bun.lock:1:1");
      expect(fs.realpathSync(local)).toBe(previousTarget!);
      expect(JSON.parse(fs.readFileSync(path.join(local, "fixture-tool/package.json"), "utf8")).version).toBe("2.0.0");
    } else {
      expect(dispatches).toBe(1);
      expect(observed.version).toBe("2.0.0");
      expect(observed.linked).toBe(true);
      expect(current.runs[0]!.attempts.at(-1)?.state).toBe("running");
    }
  } finally { savePipelines([]); f.close(); }
}, 30_000);

test("a registered worktree from a second clone cannot dispatch for the lane's repository", async () => {
  const f = await lockedFixture();
  const h = harness();
  try {
    const pipeline = await resumedLane(f, h);
    const original = pipeline.worktreeDir, saved = path.join(f.root, "original-checkout");
    const foreignRepo = path.join(f.root, "foreign-repo"), foreign = path.join(f.root, "foreign-checkout");
    await f.run(["git", "clone", f.repoDir, foreignRepo]);
    await f.run(["git", "worktree", "move", original, saved], f.repoDir);
    await f.run(["git", "worktree", "add", "--detach", foreign], foreignRepo);
    await f.run(["git", "worktree", "move", foreign, original], foreignRepo);
    f.worktreeDir = original;
    f.pipeline.worktreeDir = original;
    await prepareLockedDependencies(original);
    const link = path.join(original, "node_modules"), target = fs.readlinkSync(link);
    savePipelines([pipeline]);
    h.ports.exec = realExec;
    await tickPipelines([], h.ports);
    const current = loadPipelines().find(row => row.id === pipeline.id)!;
    expect(h.spawnInputs).toHaveLength(0);
    expect(current.stateDetail).toContain("dependency worktree belongs to a different repository");
    expect(fs.readlinkSync(link)).toBe(target);
    expect(current.runs[0]!.attempts.at(-1)?.state).not.toBe("running");
  } finally { savePipelines([]); f.close(); }
}, 30_000);

test("a controller launch survives a lost link result and dispatches its original attempt once", async () => {
  const f = await lockedFixture();
  const h = harness();
  let restore: (() => void) | undefined;
  const previous = process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
  try {
    const pipeline = await resumedLane(f, h);
    const local = path.join(pipeline.worktreeDir, "node_modules");
    savePipelines([pipeline]);
    h.ports.exec = realExec;
    const rename = fs.renameSync;
    let commits = 0;
    const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (to === local) {
        commits++;
        throw new Error("link result lost by fixture");
      }
    });
    restore = () => hook.mockRestore();
    process.env.LLV_PIPELINE_ACTIVATION_DRAIN = "1";
    await tickPipelines([], h.ports);
    const inode = fs.lstatSync(local).ino;
    await tickPipelines([], h.ports);
    expect(commits).toBe(1);
    expect(fs.lstatSync(local).ino).toBe(inode);
    expect(h.spawnInputs.map(input => input.clientAttemptId)).toEqual([`pipeline_${pipeline.id}_build_1`]);
    const attempts = loadPipelines().find(row => row.id === pipeline.id)!.runs[0]!.attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ n: 1, spawnCalls: 1, state: "running", conversationId: "conversation_stage_1", error: null });
  } finally {
    restore?.();
    if (previous === undefined) delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; else process.env.LLV_PIPELINE_ACTIVATION_DRAIN = previous;
    savePipelines([]); f.close();
  }
}, 30_000);

test.each(["writer wait", "link commit"] as const)("pause supersedes a real activation during dependency %s", async phase => {
  const f = await lockedFixture();
  const h = harness();
  const reached = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const previous = process.env.LLV_PIPELINE_ACTIVATION_DRAIN;
  let ticking: Promise<unknown> | undefined, release: (() => void) | undefined, restore: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const pipeline = await resumedLane(f, h);
    const warm = await f.addWorktree("cached");
    await prepareLockedDependencies(warm);
    const local = path.join(pipeline.worktreeDir, "node_modules");
    savePipelines([pipeline]);
    h.ports.exec = realExec;
    if (phase === "writer wait") {
      release = f.holdWriter();
      const open = fs.promises.open;
      const hook = spyOn(fs.promises, "open").mockImplementation(async (...args) => {
        const fd = await open(...args);
        if (args[0] === path.join(f.cache, "owner.lock")) reached.resolve();
        return fd;
      });
      restore = () => hook.mockRestore();
    } else {
      const symlink = fs.promises.symlink;
      const hook = spyOn(fs.promises, "symlink").mockImplementation(async (...args) => {
        await symlink(...args);
        reached.resolve();
        await proceed.promise;
      });
      restore = () => hook.mockRestore();
    }
    process.env.LLV_PIPELINE_ACTIVATION_DRAIN = "1";
    ticking = tickPipelines([], h.ports);
    void ticking.then(() => reached.reject(new Error("activation ended before the dependency barrier")), reached.reject);
    await reached.promise;
    const running = () => loadPipelines().find(row => row.id === pipeline.id)!;
    const activeId = running().runs[0]!.attempts[0]?.activation?.id;
    expect(activeId).toBeDefined();
    expect((await rawPatchPipeline(pipeline.id, { action: "pause", reason: "dependency test barrier" }, h.ports)).pipeline?.state).toBe("paused");
    proceed.resolve();
    await Promise.race([ticking, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("superseded activation continued waiting for dependencies")), 3_000);
    })]);
    expect(h.spawnInputs).toHaveLength(0);
    expect(fs.existsSync(local)).toBe(false);
    const paused = running();
    expect(paused.state).toBe("paused");
    expect(paused.runs[0]!.attempts[0]).toMatchObject({ n: 1, state: "pending", error: null });
    expect(paused.runs[0]!.attempts[0]?.activation).toBeUndefined();

    release?.();
    restore?.(); restore = undefined;
    expect((await rawPatchPipeline(pipeline.id, { action: "resume" }, h.ports)).pipeline?.state).toBe("running");
    const spawn = h.ports.spawnAgent;
    let replacement: string | undefined;
    h.ports.spawnAgent = (input, reserve) => {
      replacement = running().runs[0]!.attempts[0]?.activation?.id;
      return spawn(input, reserve);
    };
    await tickPipelines([], h.ports);
    await tickPipelines([], h.ports);
    expect(h.spawnInputs.map(input => input.clientAttemptId)).toEqual([`pipeline_${pipeline.id}_build_1`]);
    expect(fs.realpathSync(local)).toBe(fs.realpathSync(path.join(warm, "node_modules")));
    const attempts = running().runs[0]!.attempts;
    expect(attempts).toHaveLength(1);
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(activeId);
    expect(attempts[0]).toMatchObject({ n: 1, spawnCalls: 1, state: "running", error: null });
  } finally {
    clearTimeout(deadline);
    release?.(); proceed.resolve(); restore?.();
    await ticking?.catch(() => {});
    if (previous === undefined) delete process.env.LLV_PIPELINE_ACTIVATION_DRAIN; else process.env.LLV_PIPELINE_ACTIVATION_DRAIN = previous;
    savePipelines([]); f.close();
  }
}, 30_000);
