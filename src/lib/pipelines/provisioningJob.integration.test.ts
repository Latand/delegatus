import { FlowPipelineController } from "./controller";
import { settlePipelineControllerJobs } from "./controllerJobs";
import { tickPipelinesController } from "./controllerPass";
import { settlePipelineStopReadLanes } from "./controllerStopRead";
import { BUILD_ONLY, createPipelineFromRequest, expect, fs, path, realWorktreeLane, test } from "./engine.fixture";
import { latch, until, withControllerAuditState } from "./fixtures/ownedStageControl";
import { findControllerPipeline } from "./store";
import { removeProvisioningFixture, seedProvisioningPackage } from "../../../scripts/verify-provisioning-release.mjs";

test("a held dependency reply expires and the controller adopts the original checkout", () => withControllerAuditState(async () => {
  const fixture = await realWorktreeLane("held-dependency-reply", BUILD_ONLY as never);
  const { h, repo, git, root } = fixture;
  const remoteExec = h.ports.provisionExec!;
  const held = latch(), release = latch();
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 0, monotonic = 0, wall = Date.parse("2026-11-24T10:00:00Z");
  Object.assign(h.ports, {
    now: () => new Date(wall).toISOString(),
    provisionClock: {
      wallMs: () => wall,
      monotonicMs: () => monotonic,
      arm(delay: number, callback: () => void) {
        const key = nextTimer++;
        timers.set(key, { at: monotonic + delay, callback });
        return () => { timers.delete(key); };
      },
    },
  });
  const advance = (by: number) => {
    wall += by;
    monotonic += by;
    for (const [key, timer] of timers) if (timer.at <= monotonic) {
      timers.delete(key);
      timer.callback();
    }
  };
  let adds = 0, checks = 0, launches = 0;
  let checkout = "";
  let laneId = "";
  let cancelled: AbortSignal | undefined;
  const controller = new FlowPipelineController({
    tickPipelines: entries => tickPipelinesController(entries, h.ports),
    scan: async () => ({ files: [], complete: false }),
    scheduleTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: () => {},
  }, { phaseDeadlineMs: 15_000, maxPasses: 1 });
  const tickUntil = async (predicate: () => Promise<boolean>) => {
    const stop = performance.now() + 4_000;
    while (!await predicate()) {
      if (performance.now() >= stop) {
        const row = await findControllerPipeline(laneId);
        throw new Error(`controller fixture did not converge: ${row?.state} ${row?.stateDetail} ${row?.provisioningJob?.step}`);
      }
      await controller.tick();
      await Bun.sleep(15);
    }
  };
  try {
    fs.appendFileSync(path.join(repo, ".gitignore"), "node_modules\n");
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "delegatus-cli" }));
    fs.writeFileSync(path.join(repo, "bun.lock"), JSON.stringify({
      lockfileVersion: 1, configVersion: 1, workspaces: { "": { name: "delegatus-cli" } }, packages: {},
    }));
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "fixture dependency inputs");
    await git(repo, "push", "origin", "main");
    const planned = await git(repo, "rev-parse", "HEAD");
    const spawn = h.ports.spawnAgent;
    h.ports.spawnAgent = async (input, reserve) => {
      const result = await spawn(input, reserve);
      if (input.cwd === checkout) {
        launches++;
        const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { cwd: checkout, stdio: ["ignore", "ignore", "ignore"] });
        try { expect(await child.exited).toBe(0); }
        finally { if (child.exitCode === null) { child.kill(); await child.exited; } }
      }
      return result;
    };
    h.ports.provisionExec = async (command, args, cwd, signal, options) => {
      // A sealed empty graph is enough to exercise adoption after the fault.
      // Bun itself deletes empty lockfiles; the real install runs below.
      if (command === "bun" && args[0] === "install") return { code: 0, stdout: "", stderr: "" };
      if (command === "git" && args[0] === "worktree" && args[1] === "add") adds++;
      const result = await remoteExec(command, args, cwd, signal, options);
      if (cwd === checkout && command === "git" && args[0] === "check-ignore" && args.at(-1) === "node_modules" && ++checks === 1) {
        expect(result.code).toBe(0);
        cancelled = signal;
        held.resolve();
        await release.promise;
      }
      return result;
    };
    const created = await createPipelineFromRequest({ task: "Recover a held dependency reply", publication: "internal",
      repoDir: repo, stages: BUILD_ONLY as never }, h.ports);
    const lane = created.pipeline!;
    laneId = lane.id;
    checkout = lane.worktreeDir;
    await controller.tick();
    await until(held.promise);
    expect(await git(checkout, "rev-parse", "HEAD")).toBe(planned);
    const before = await findControllerPipeline(lane.id);
    expect(before?.runs[0]?.attempts).toHaveLength(0);
    expect(before).toMatchObject({ provisioningJob: { step: "checkingDependencies", status: "running" } });
    const window = before!.provisioningJob!.deadlineAt - wall;
    advance(window - 1);
    expect(cancelled?.aborted).toBe(false);
    advance(1);
    await tickUntil(async () => (await findControllerPipeline(lane.id))?.provisioningJob?.status === "waiting");
    expect(cancelled?.aborted).toBe(true);
    const after = await findControllerPipeline(lane.id);
    expect(after).toMatchObject({ provisioningJob: { interruption: { step: "checkingDependencies", reason: "provision-step-timeout" } } });
    await git(repo, "commit", "--allow-empty", "-m", "advance the followed base");
    await git(repo, "push", "origin", "main");
    advance(after!.provisioningJob!.retryAt! - wall);
    await tickUntil(async () => launches === 1);
    expect(await git(checkout, "rev-parse", "HEAD")).toBe(planned);
    expect(adds).toBe(1);
    expect((await findControllerPipeline(lane.id))?.runs[0]?.attempts).toHaveLength(1);
  } finally {
    release.resolve();
    // The base comparator has only the legacy controller pool.
    const job = await import("./provisioningJob").catch(() => null);
    await job?.settleProvisioningJobsForTests();
    await settlePipelineControllerJobs();
    await settlePipelineStopReadLanes();
    await removeProvisioningFixture(root);
  }
}), 20_000);

test("the checkout release starts a leased worker and consumes a cold shared graph", () => withControllerAuditState(async () => {
  const fixture = await realWorktreeLane("cold-toolchain-worker", BUILD_ONLY as never);
  const { h, git, repo, root } = fixture;
  let closeSupply: (() => Promise<void>) | undefined;
  try {
    closeSupply = await seedProvisioningPackage(repo, root, process.env, process.execPath);
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "fixture dependency inputs");
    await git(repo, "push", "origin", "main");
    const planned = await git(repo, "rev-parse", "HEAD");
    delete h.ports.provisionExec;
    h.ports.now = () => new Date().toISOString();
    const created = await createPipelineFromRequest({ task: "Prepare a cold shared graph", publication: "internal", repoDir: repo,
      stages: BUILD_ONLY as never }, h.ports);
    const lane = created.pipeline!;
    const stop = performance.now() + 12_000;
    let current = await findControllerPipeline(lane.id);
    while (current?.state === "provisioning" && performance.now() < stop) {
      await tickPipelinesController([], h.ports);
      await Bun.sleep(20);
      current = await findControllerPipeline(lane.id);
    }
    expect(current?.stateDetail, current?.provisioningJob?.step).toBeNull();
    expect(current).toMatchObject({ state: "running", lastPassedCommit: planned });
    expect(current?.provisioningJob).toBeUndefined();
    const linked = fs.realpathSync(path.join(lane.worktreeDir, "node_modules"));
    const receipt = JSON.parse(fs.readFileSync(path.join(linked, "..", "installed.json"), "utf8"));
    expect(receipt.key).toBe(path.basename(path.dirname(linked)));
    expect(await git(lane.worktreeDir, "rev-parse", "HEAD")).toBe(planned);
  } finally {
    await (await import("./provisioningJob")).settleProvisioningJobsForTests();
    await closeSupply?.();
    await settlePipelineControllerJobs();
    await settlePipelineStopReadLanes();
    await removeProvisioningFixture(root);
  }
}), 18_000);

test("the leased worker borrows matching source tools without an install lockfile", () => withControllerAuditState(async () => {
  const { h, git, repo, root } = await realWorktreeLane("matching-private-source", BUILD_ONLY as never);
  try {
    fs.appendFileSync(path.join(repo, ".gitignore"), "node_modules\n");
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "fixture-tools" }));
    const source = path.join(repo, "node_modules");
    fs.mkdirSync(path.join(source, "fixture"), { recursive: true });
    fs.mkdirSync(path.join(source, ".bin"));
    fs.writeFileSync(path.join(source, "fixture", "cli.js"), "fixture executable\n", { mode: 0o755 });
    fs.symlinkSync("../fixture/cli.js", path.join(source, ".bin", "fixture"));
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "fixture matching source dependency inputs");
    await git(repo, "push", "origin", "main");
    delete h.ports.provisionExec;
    h.ports.now = () => new Date().toISOString();
    const { pipeline: lane } = await createPipelineFromRequest({ task: "Borrow matching source tools", publication: "internal",
      repoDir: repo, stages: BUILD_ONLY as never }, h.ports);
    const stop = performance.now() + 8_000;
    let current = await findControllerPipeline(lane!.id);
    while (current?.state === "provisioning" && performance.now() < stop) {
      await tickPipelinesController([], h.ports);
      await Bun.sleep(20);
      current = await findControllerPipeline(lane!.id);
    }
    expect(current?.stateDetail, current?.provisioningJob?.step).toBeNull();
    expect(current?.state).toBe("running");
    const local = path.join(lane!.worktreeDir, "node_modules");
    expect(fs.lstatSync(local).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(local, ".bin", "fixture"), "utf8")).toBe("fixture executable\n");
    fs.writeFileSync(path.join(local, "fixture", "cli.js"), "lane tools\n");
    expect(fs.readFileSync(path.join(source, "fixture", "cli.js"), "utf8")).toBe("fixture executable\n");
  } finally {
    await (await import("./provisioningJob")).settleProvisioningJobsForTests();
    await settlePipelineControllerJobs();
    await settlePipelineStopReadLanes();
    await removeProvisioningFixture(root);
  }
}), 14_000);
