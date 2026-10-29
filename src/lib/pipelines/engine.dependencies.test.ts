import { expect, test, fs, path, harness, create, tickPipelines, savePipelines, loadPipelines } from "./engine.fixture";
import { lockedFixture } from "./fixtures/lockedDependencies";
import { realExec } from "../workflows/provision";
import { prepareWorktreeDependencies } from "./worktreeDependencies";

test.each(["missing", "lagging-link", "matching", "unrepairable"])("resumed stage validates %s dependencies before dispatch", async shape => {
  const f = await lockedFixture();
  const h = harness();
  try {
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
    const source = path.join(f.repoDir, "node_modules"), local = path.join(f.worktreeDir, "node_modules");
    if (shape === "matching") await prepareWorktreeDependencies(f.pipeline);
    if (shape === "missing") fs.rmSync(source, { recursive: true });
    if (shape === "lagging-link") {
      await f.makeLagging();
      expect(JSON.parse(fs.readFileSync(path.join(source, "fixture-tool/package.json"), "utf8")).version).toBe("1.0.0");
      fs.symlinkSync(source, local, "dir");
    }
    if (shape === "unrepairable") fs.writeFileSync(path.join(f.worktreeDir, "bun.lock"), "invalid lockfile");
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
    } else {
      expect(dispatches).toBe(1);
      expect(observed.version).toBe("2.0.0");
      expect(observed.linked).toBe(true);
      expect(current.runs[0]!.attempts.at(-1)?.state).toBe("running");
    }
  } finally { savePipelines([]); f.close(); }
}, 30_000);
