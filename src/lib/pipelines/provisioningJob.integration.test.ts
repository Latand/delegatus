import { FlowPipelineController } from "./controller";
import { StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";
import { settlePipelineControllerJobs, startPipelineControllerJob } from "./controllerJobs";
import { tickPipelinesController } from "./controllerPass";
import { settlePipelineStopReadLanes } from "./controllerStopRead";
import type { ProvisionControllerFixture } from "./fixtures/provisionControllerProcess";
import { BUILD_ONLY, createPipelineFromRequest, expect, fs, path, realWorktreeLane, spyOn, test } from "./engine.fixture";
import { latch, until, withControllerAuditState } from "./fixtures/ownedStageControl";
import { findControllerPipeline, savePipelines, withPipelineMutation } from "./store";
import { settleProvisioningJobsForTests } from "./provisioningJob";
import { removeProvisioningFixture, seedProvisioningPackage } from "../../../scripts/verify-provisioning-release.mjs";

async function driveProvisioning(ports: Parameters<typeof tickPipelinesController>[1], done: () => Promise<boolean>) {
  const stop = performance.now() + 8_000;
  while (!await done()) {
    if (performance.now() >= stop) throw new Error("fixture did not converge");
    await tickPipelinesController([], ports);
    await Bun.sleep(20);
  }
}

test.each(["before dispatch", "after dispatch"] as const)("superseding a provisioning lane around fetch preserves only the admitted-first ordering (%s)", async order => withControllerAuditState(async () => {
  const fixture = await realWorktreeLane(`provision-fetch-${order.replaceAll(" ", "-")}`, BUILD_ONLY as never);
  const { h, repo, root } = fixture;
  const reached = latch(), release = latch();
  let fetches = 0, adds = 0;
  try {
    delete h.ports.provisionExec;
    const execute = h.ports.exec;
    h.ports.exec = async (command, args, cwd, env, options) => {
      if (command === "git" && args[0] === "fetch") {
        fetches++;
        if (order === "after dispatch") { reached.resolve(); await release.promise; }
      }
      if (command === "git" && args[0] === "worktree" && args[1] === "add") adds++;
      return execute(command, args, cwd, env, options);
    };
    h.ports.beforeGitDispatch = async (command, args) => {
      if (order === "before dispatch" && command === "git" && args[0] === "fetch") {
        reached.resolve();
        await release.promise;
      }
    };
    const lane = (await createPipelineFromRequest({ task: "Fence a superseded provisioning fetch", repoDir: repo,
      publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
    const run = driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.state === "closed");
    await until(reached.promise);
    await withPipelineMutation(async (rows, persist) => {
      const current = rows.find(row => row.id === lane.id)!;
      current.state = "closed";
      current.closedAt = h.ports.now();
      current.cursor = null;
      current.controlGeneration = "superseded-fetch-control";
      await persist([current]);
    });
    release.resolve();
    await run;
    await settleProvisioningJobsForTests();
    expect(fetches).toBe(order === "after dispatch" ? 1 : 0);
    expect(adds).toBe(0);
    expect((await findControllerPipeline(lane.id))?.runs[0]?.attempts).toHaveLength(0);
  } finally {
    release.resolve();
    await settleProvisioningJobsForTests();
    await settlePipelineControllerJobs();
    await settlePipelineStopReadLanes();
    await removeProvisioningFixture(root);
  }
}));

test("a repository alias swap at Git dispatch refuses before touching the replacement checkout", () => withControllerAuditState(async () => {
  const fixture = await realWorktreeLane("provision-alias-dispatch", BUILD_ONLY as never);
  const { h, repo, origin, root, base, git } = fixture;
  const alias = path.join(root, "repo-alias"), oldAlias = path.join(root, "repo-alias-old"), replacement = path.join(root, "replacement.git");
  await settleProvisioningJobsForTests();
  savePipelines([]);
  delete h.ports.provisionExec;
  fs.symlinkSync(repo, alias);
  await git(root, "clone", "--bare", origin, replacement);
  const beforeReplacementRefs = await git(replacement, "show-ref");
  let swapped = false;
  h.ports.beforeGitDispatch = async (command, args) => {
    if (swapped || command !== "git" || args[0] !== "worktree" || args[1] !== "add") return;
    swapped = true;
    fs.renameSync(alias, oldAlias);
    fs.symlinkSync(replacement, alias);
  };
  const created = await createPipelineFromRequest({ task: "Refuse a changed repository alias before add",
    repoDir: alias, baseRef: base, publication: "internal", stages: BUILD_ONLY as never }, h.ports);
  const lane = created.pipeline!;
  await withPipelineMutation(async (rows, persist) => {
    const current = rows.find(row => row.id === lane.id)!;
    current.repoDir = alias;
    await persist([current]);
  });
  try {
    await driveProvisioning(h.ports, async () => {
      const state = (await findControllerPipeline(lane.id))?.state;
      return state === "needs_decision" || state === "running";
    });
    const parked = (await findControllerPipeline(lane.id))!;
    expect(swapped).toBe(true);
    expect(parked.stateDetail).toContain("repository or checkout identity changed before Git dispatch");
    expect(fs.existsSync(lane.worktreeDir)).toBe(false);
    expect(await git(replacement, "show-ref")).toBe(beforeReplacementRefs);
    expect(await git(repo, "show-ref", "--verify", `refs/heads/${lane.branch}`).catch(() => "missing")).toBe("missing");
    expect(parked.runs[0]?.attempts).toHaveLength(0);
  } finally {
    await settleProvisioningJobsForTests();
    await settlePipelineControllerJobs();
    await settlePipelineStopReadLanes();
    await removeProvisioningFixture(root);
  }
}));

test("a withdrawn release fence resumes provisioning only after writer authority returns", () => withControllerAuditState(async () => {
  const fixture = await realWorktreeLane("provision-fence-withdrawal", BUILD_ONLY as never);
  const { h, repo, root } = fixture;
  const jobs = await import("./provisioningJob");
  try {
    await settleProvisioningJobsForTests();
    savePipelines([]);
    await jobs.stopProvisioningJobsForDemotion();
    const lane = (await createPipelineFromRequest({ task: "Resume provisioning after a withdrawn fence",
      repoDir: repo, baseRef: fixture.base, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
    expect(jobs.advanceProvisioningJob(lane, h.ports, { parked() {} })).toBeUndefined();
    expect(jobs.resumeProvisioningJobsAfterFenceWithdrawal(() => false)).toBe(false);
    expect(jobs.advanceProvisioningJob(lane, h.ports, { parked() {} })).toBeUndefined();
    expect(jobs.resumeProvisioningJobsAfterFenceWithdrawal(() => true)).toBe(true);
    delete h.ports.provisionExec;
    let adds = 0;
    h.ports.beforeGitDispatch = async (command, args) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "add") adds++;
    };
    await driveProvisioning(h.ports, async () => {
      const current = await findControllerPipeline(lane.id);
      return current?.state === "running" && current.provisioningJob === undefined;
    });
    expect(adds).toBe(1);
    expect((await findControllerPipeline(lane.id))?.lastPassedCommit).toBe(lane.baseRef);
  } finally {
    jobs.resumeProvisioningJobsAfterFenceWithdrawal(() => true);
    await settleProvisioningJobsForTests();
    await settlePipelineControllerJobs();
    await settlePipelineStopReadLanes();
    await removeProvisioningFixture(root);
  }
}));

test.skipIf(process.platform !== "linux")("legacy installer census follows checkout identity through a path alias", () => withControllerAuditState(async () => {
  const { observeLegacyInstaller } = await import("./provisionLegacyInstaller");
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "legacy-cwd-alias-"));
  const checkout = path.join(root, "checkout"), alias = path.join(root, "checkout-alias");
  fs.mkdirSync(checkout);
  fs.symlinkSync(checkout, alias);
  const child = Bun.spawn([process.execPath, "-e", "process.stdin.resume()", "install"], {
    cwd: alias, stdin: "pipe", stdout: "ignore", stderr: "ignore",
  });
  try {
    const stop = performance.now() + 2_000;
    while (performance.now() < stop) {
      const observation = await observeLegacyInstaller(checkout);
      if (observation.kind === "possible-writer") {
        expect(observation.pid).toBe(child.pid);
        return;
      }
      await Bun.sleep(20);
    }
    throw new Error("legacy installer census did not identify the aliased checkout writer");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await child.exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

function startFixtureController(input: Omit<ProvisionControllerFixture, "state">, cwd = process.cwd(), env = {}) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/lib/pipelines/fixtures/provisionControllerProcess.ts"], {
    cwd, env: { ...process.env, ...env,
      LLV_PROVISION_PROCESS_FIXTURE: JSON.stringify({ ...input, state: process.env.LLV_STATE_DIR }) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: (input.timeoutMs ?? 28_000) + 2_000,
  });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(lines => lines.join("\n"));
  return {
    child, output,
    async stop(signal: NodeJS.Signals = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      await child.exited;
      await output;
    },
  };
}

async function waitForFixture(predicate: () => boolean | Promise<boolean>, label: string, timeout = 8_000) {
  const deadline = performance.now() + timeout;
  for (;;) {
    try { if (await predicate()) return; }
    catch (error) { if (!(error instanceof StateSnapshotChangedError)) throw error; }
    if (performance.now() >= deadline) throw new Error(`fixture deadline: ${label}`);
    await Bun.sleep(15);
  }
}

function fixtureLaunchCount(launches: string, checkout: string): number {
  return fs.existsSync(launches) ? fs.readFileSync(launches, "utf8").split("\n").filter(value => value === checkout).length : 0;
}

function replaceFixtureFile(file: string, value: string) {
  const next = file + ".next";
  fs.writeFileSync(next, value);
  fs.renameSync(next, file);
}

test.each(["disk", "repository turn", "executor pool"] as const)("a transient retry survives a long %s hold", blocker =>
  withControllerAuditState(async () => {
    const { advanceProvisioningJob, settleProvisioningJobsForTests } = await import("./provisioningJob");
    const { provisioningStripe, tryProvisioningLock } = await import("./provisionCheckoutCustody");
    const { h, repo, root, git } = await realWorktreeLane("transient-retry-hold", BUILD_ONLY as never);
    let wall = Date.parse("2026-11-25T08:00:00Z");
    h.ports.now = () => new Date(wall).toISOString();
    const lane = (await createPipelineFromRequest({ task: "Retry a transient checkout failure",
      repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
    const run = async () => advanceProvisioningJob((await findControllerPipeline(lane.id))!, h.ports, { parked() {} });
    const exec = h.ports.provisionExec!;
    let adds = 0, diskHeld = false;
    h.ports.provisionExec = async (command, args, cwd, signal, options) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "add" && args.includes(lane.worktreeDir) && ++adds <= 2) {
        throw new Error("connection reset by peer");
      }
      return exec(command, args, cwd, signal, options);
    };
    h.ports.worktreeDiskWait = () => diskHeld ? "waiting for disk space: fixture hold" : null;
    const release = latch(), full = latch();
    const peers: Promise<boolean>[] = [];
    let turn: Awaited<ReturnType<typeof tryProvisioningLock>> = null;
    try {
      await run();
      const first = (await findControllerPipeline(lane.id))!.provisioningJob!;
      expect(first.admittedAdd?.previousWait?.rounds).toBe(1);
      wall = first.retryAt!;
      if (blocker === "repository turn") {
        const common = await git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
        turn = await tryProvisioningLock(process.env.LLV_STATE_DIR!, "repo", provisioningStripe(common), false,
          new AbortController().signal, () => {});
        expect(turn).toBeTruthy();
      } else if (blocker === "disk") diskHeld = true;
      else {
        let entered = 0;
        const peerPorts = { ...h.ports, provisionExec: async () => {
          if (++entered === 4) full.resolve();
          await release.promise;
          return { code: 1, stdout: "", stderr: "fixture finished" };
        } };
        for (let index = 0; index < 4; index++) {
          const peer = (await createPipelineFromRequest({ task: `Occupy provisioning executor ${index}`,
            repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
          peers.push(advanceProvisioningJob(peer, peerPorts, { parked() {} })!);
        }
        await until(full.promise);
      }
      await run();
      expect(adds).toBe(1);
      wall += blocker === "repository turn" ? 400_000 : 181_000;
      await run();
      expect(adds).toBe(1);
      const waiting = (await findControllerPipeline(lane.id))!.provisioningJob!;
      if (blocker === "repository turn") {
        expect(waiting.status).toBe("waiting");
        expect((await findControllerPipeline(lane.id))?.state).toBe("provisioning");
      }
      turn?.close();
      diskHeld = false;
      release.resolve();
      await Promise.all(peers);
      wall = Math.max(wall, waiting.retryAt!);
      await run();
      const retried = (await findControllerPipeline(lane.id))!;
      expect(retried.stateDetail).toBe("provisioning deferred: the network connection failed");
      expect(retried.provisioningJob!.admittedAdd?.previousWait?.rounds).toBe(2);
      expect(retried.provisioningJob!.retryAt! - wall).toBe(10_000);
      wall = retried.provisioningJob!.retryAt!;
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.runs[0]?.attempts[0]?.state === "running");
      expect(adds).toBe(3);
      expect((await findControllerPipeline(lane.id))?.runs[0]?.attempts).toHaveLength(1);
    } finally {
      turn?.close();
      release.resolve();
      await Promise.all(peers);
      await settleProvisioningJobsForTests();
      await settlePipelineControllerJobs();
      await settlePipelineStopReadLanes();
      await removeProvisioningFixture(root);
    }
  }), 20_000);

test("a transient retry keeps its charged backoff across process restart during disk pressure", () => withControllerAuditState(async () => {
  const { h, repo, root } = await realWorktreeLane("retry-disk-restart", BUILD_ONLY as never);
  const lane = (await createPipelineFromRequest({ task: "Keep the retry budget through a restart during disk pressure",
    repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
  const wallFile = path.join(root, "wall-time");
  const marker = path.join(root, "disk-hold");
  const failures = path.join(root, "transient-faults");
  const launches = path.join(root, "first-children");
  const end = path.join(root, "controller-end");
  const input = { lane: lane.id, launches, end, wallFile };
  const faults = { diskHold: { marker }, transientAdd: { checkout: lane.worktreeDir, failures } };
  const controllers: ReturnType<typeof startFixtureController>[] = [];
  const start = (inject: boolean) => {
    const controller = startFixtureController({ ...input, ...(inject ? faults : {}) });
    controllers.push(controller);
    return controller;
  };
  const setWall = (ms: number) => replaceFixtureFile(wallFile, new Date(ms).toISOString());
  const read = () => findControllerPipeline(lane.id);
  try {
    setWall(Date.now());
    const first = start(true);
    await waitForFixture(async () => (await read())?.provisioningJob?.status === "waiting", "first transient retry");
    const failure = (await read())!.provisioningJob!;
    fs.writeFileSync(marker, "");
    setWall(failure.retryAt!);
    await waitForFixture(async () => (await read())?.stateDetail?.includes("waiting for disk space") === true, "recorded disk hold");
    await first.stop("SIGKILL");
    setWall(failure.retryAt! + 181_000);
    const second = start(true);
    await waitForFixture(async () => {
      const slot = (await read())?.provisioningJob;
      return slot?.status === "waiting" && slot.retryAt! > failure.retryAt! + 181_000;
    }, "second controller sees the disk hold");
    const waiting = (await read())!.provisioningJob!;
    expect(fs.readFileSync(failures, "utf8")).toBe("fault\n");
    fs.unlinkSync(marker);
    setWall(waiting.retryAt!);
    await waitForFixture(async () => {
      const current = await read();
      return current?.state === "needs_decision" || current?.provisioningJob?.admittedAdd?.previousWait?.rounds === 2;
    }, "second transient result");
    const retried = (await read())!;
    expect(retried.stateDetail).toBe("provisioning deferred: the network connection failed");
    const retry = retried.provisioningJob!.admittedAdd!.previousWait!;
    expect(Date.parse(retry.startedAt)).toBe(waiting.retryAt! - 5_000);
    expect(Date.parse(retry.retryAfter)).toBe(waiting.retryAt! + 10_000);
    await second.stop("SIGKILL");
    setWall(Date.parse(retry.retryAfter));
    const third = start(false);
    expect(await third.child.exited, await third.output).toBe(0);
    expect(fs.readFileSync(failures, "utf8")).toBe("fault\nfault\n");
    expect(fixtureLaunchCount(launches, lane.worktreeDir)).toBe(1);
    expect((await read())?.runs[0]?.attempts).toHaveLength(1);
  } finally {
    fs.writeFileSync(end, "");
    for (const controller of controllers) await controller.stop();
    await removeProvisioningFixture(root);
  }
}), 32_000);

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
    const ordinary = wall;
    for (const jump of [120_000, -120_000]) {
      wall = ordinary + jump;
      await controller.tick();
      expect((await findControllerPipeline(lane.id))?.provisioningJob?.token).toBe(before!.provisioningJob!.token);
      expect(cancelled?.aborted).toBe(false);
    }
    wall = ordinary;
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
    release.resolve();
    await controller.tick();
    expect(await git(checkout, "rev-parse", "HEAD")).toBe(planned);
    expect(adds).toBe(1);
    expect(launches).toBe(1);
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

test("a held payload scan expires under the sealed-graph step and adopts without another add", () =>
  withControllerAuditState(async () => {
    const { h, git, repo, root } = await realWorktreeLane("held-sealed-graph-scan", BUILD_ONLY as never);
    const { prepareLockedDependencies } = await import("./lockedDependencies");
    const { recordWorktreeProvenance } = await import("./worktreeProvenance");
    const { settleProvisioningJobsForTests } = await import("./provisioningJob");
    const diagnostics = spyOn(await import("./controllerJobs"), "reportProvisioningPhase");
    const release = latch();
    let supply: (() => Promise<void>) | undefined;
    let wall = Date.now(), monotonic = 0, scans = 0, children = 0;
    const timers = new Set<{ at: number; run: () => void }>();
    const advance = (by: number) => {
      wall += by;
      monotonic += by;
      for (const timer of [...timers]) if (timer.at <= monotonic) {
        timers.delete(timer);
        timer.run();
      }
    };
    try {
      supply = await seedProvisioningPackage(repo, root, process.env, process.execPath);
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "fixture inputs for the sealed graph");
      await git(repo, "push", "origin", "main");
      const sha = await git(repo, "rev-parse", "HEAD");
      delete h.ports.provisionExec;
      h.ports.now = () => new Date(wall).toISOString();
      h.ports.provisionClock = {
        wallMs: () => wall, monotonicMs: () => monotonic,
        arm(delay, run) {
          const timer = { at: monotonic + delay, run };
          timers.add(timer);
          return () => { timers.delete(timer); };
        },
      };
      const lane = (await createPipelineFromRequest({ task: "Recover the sealed graph after a lost scan",
        repoDir: repo, baseRef: sha, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      await git(repo, "worktree", "add", "-b", lane.branch, lane.worktreeDir, sha);
      expect(recordWorktreeProvenance(lane.worktreeDir, { creator: "pipeline", id: lane.id })).toBe(true);
      expect(await prepareLockedDependencies(lane.worktreeDir, { repository: repo })).toBe(true);
      const graph = fs.realpathSync(path.join(lane.worktreeDir, "node_modules"));
      const spawn = h.ports.spawnAgent;
      h.ports.spawnAgent = async (input, reserve) => {
        const result = await spawn(input, reserve);
        if (input.cwd === lane.worktreeDir) {
          const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
            cwd: input.cwd, stdout: "ignore", stderr: "ignore", timeout: 3_000,
          });
          expect(await child.exited).toBe(0);
          children++;
        }
        return result;
      };
      h.ports.provisionToolchainReply = async (id, type) => {
        if (id === lane.id && type === "payloadScanComplete" && ++scans === 1) await release.promise;
      };
      await driveProvisioning(h.ports, async () => scans === 1);
      const before = (await findControllerPipeline(lane.id))!;
      expect(before.provisioningJob).toMatchObject({ step: "validatingSealedGraph", status: "running" });
      expect(before.runs[0]?.attempts).toHaveLength(0);
      advance(before.provisioningJob!.deadlineAt - wall - 1);
      await tickPipelinesController([], h.ports);
      expect((await findControllerPipeline(lane.id))?.provisioningJob?.token).toBe(before.provisioningJob?.token);
      advance(1);
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.provisioningJob?.status === "waiting");
      const waiting = (await findControllerPipeline(lane.id))!.provisioningJob!;
      expect(waiting.interruption).toMatchObject({ step: "validatingSealedGraph", reason: "provision-step-timeout" });
      advance(waiting.retryAt! - wall);
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.runs[0]?.attempts[0]?.state === "running");
      release.resolve();
      expect((await findControllerPipeline(lane.id))?.runs[0]?.attempts).toHaveLength(1);
      expect(children).toBe(1);
      expect(fs.realpathSync(path.join(lane.worktreeDir, "node_modules"))).toBe(graph);
      expect(diagnostics.mock.calls.filter(([id, event]) =>
        id === lane.id && event.phase === "git-started" && event.step === "worktree-add")).toHaveLength(0);
    } finally {
      diagnostics.mockRestore();
      release.resolve();
      await settleProvisioningJobsForTests();
      await supply?.();
      await settlePipelineControllerJobs();
      await settlePipelineStopReadLanes();
      await removeProvisioningFixture(root);
    }
  }), 24_000);

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

test("legacy exclusion leaves an expired v1 slot selectable without admitting more Git", () => withControllerAuditState(async () => {
  const { h, repo, root } = await realWorktreeLane("mixed-mode-expiry", BUILD_ONLY as never);
  const { settleProvisioningJobsForTests } = await import("./provisioningJob");
  const original = h.ports.provisionExec!;
  const entered = latch(), reply = latch(), legacy = latch();
  let wall = Date.parse("2026-11-24T10:00:00Z"), reads = 0;
  h.ports.now = () => new Date(wall).toISOString();
  h.ports.provisionExec = async (command, args, cwd, signal, options) => {
    if (command === "git" && args.includes("--git-common-dir") && ++reads === 1) {
      entered.resolve();
      await reply.promise;
    }
    return original(command, args, cwd, signal, options);
  };
  const create = async (task: string) => (await createPipelineFromRequest({
    task, repoDir: repo, publication: "internal", stages: BUILD_ONLY as never,
  }, h.ports)).pipeline!;
  try {
    const held = await create("A lane held by legacy work");
    await tickPipelinesController([], h.ports);
    await until(entered.promise);
    const active = (await findControllerPipeline(held.id))!.provisioningJob!;
    expect(active.status).toBe("running");
    await settleProvisioningJobsForTests();
    reply.resolve();
    expect(startPipelineControllerJob(held.id, () => legacy.promise, async () => "held")).toBe(true);
    wall = active.deadlineAt - 1;
    await tickPipelinesController([], h.ports);
    expect((await findControllerPipeline(held.id))?.provisioningJob?.token).toBe(active.token);
    expect(reads).toBe(1);
    wall++;
    await tickPipelinesController([], h.ports);
    const expired = await findControllerPipeline(held.id);
    expect(expired?.provisioningJob).toMatchObject({ status: "waiting", interruption: {
      reason: "provision-step-timeout", observedAt: wall, step: active.step,
    } });
    expect(expired?.provisioningJob?.token).not.toBe(active.token);
    expect(reads).toBe(1);
    const peer = await create("An independent lane can advance");
    await driveProvisioning(h.ports, async () => (await findControllerPipeline(peer.id))?.state === "running");
    expect((await findControllerPipeline(held.id))?.runs[0]?.attempts).toHaveLength(0);
    expect((await findControllerPipeline(held.id))?.provisioningJob?.token).toBe(expired?.provisioningJob?.token);
  } finally {
    reply.resolve();
    legacy.resolve();
    await settleProvisioningJobsForTests();
    await settlePipelineControllerJobs();
    await settlePipelineStopReadLanes();
    await removeProvisioningFixture(root);
  }
}), 18_000);

test.skipIf(process.platform !== "linux")("a cache waiter identifies the v1 worker that owns the physical fence", () => withControllerAuditState(async () => {
  const { h, git, repo, root } = await realWorktreeLane("identified-cache-holder", BUILD_ONLY as never);
  const received = latch(), finish = latch();
  let armed = false;
  let closeSupply: (() => Promise<void>) | undefined;
  try {
    closeSupply = await seedProvisioningPackage(repo, root, { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(root, "lockfile-cache") }, process.execPath, async () => {
      if (!armed) return;
      received.resolve();
      await finish.promise;
    });
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "fixture cache inputs");
    await git(repo, "push", "origin", "main");
    delete h.ports.provisionExec;
    h.ports.now = () => new Date().toISOString();
    const create = async (task: string) => (await createPipelineFromRequest({
      task, repoDir: repo, publication: "internal", stages: BUILD_ONLY as never,
    }, h.ports)).pipeline!;
    armed = true;
    const owner = await create("Hold the actual dependency install");
    await driveProvisioning(h.ports, async () => (await findControllerPipeline(owner.id))?.provisioningJob?.cacheOwner !== undefined);
    await until(received.promise, 5_000);
    const holder = (await findControllerPipeline(owner.id))!.provisioningJob!;
    const waiter = await create("Wait for the same physical dependency cache");
    await driveProvisioning(h.ports, async () => (await findControllerPipeline(waiter.id))?.provisioningJob?.step === "waitingForCache");
    const waiting = (await findControllerPipeline(waiter.id))!.provisioningJob!;
    expect(waiting.cacheWaitIdentity).toBe(holder.cacheOwner!.identity);
    expect(waiting.waitReason).toBe("waiting-for-cache-holder");
    expect(waiting.deadlineAt - waiting.since).toBe(180_000);
    finish.resolve();
    await driveProvisioning(h.ports, async () => (await findControllerPipeline(owner.id))?.state === "running");
    await driveProvisioning(h.ports, async () => (await findControllerPipeline(waiter.id))?.state === "running");
  } finally {
    finish.resolve();
    await (await import("./provisioningJob")).settleProvisioningJobsForTests();
    await closeSupply?.();
    await settlePipelineControllerJobs();
    await settlePipelineStopReadLanes();
    await removeProvisioningFixture(root);
  }
}), 25_000);

test.skipIf(process.platform !== "linux")("a fresh controller waits for the surviving pre-registration Git writer and adopts its checkout", () =>
  withControllerAuditState(async () => {
    const { h, repo, git, root } = await realWorktreeLane("surviving-add-writer", BUILD_ONLY as never);
    const nativeGit = Bun.which("git", { PATH: "/usr/bin:/bin" });
    if (!nativeGit) throw new Error("native fixture Git is unavailable");
    const shim = path.join(root, "git");
    const writes = path.join(root, "add-dispatches");
    const release = path.join(root, "release-add");
    const launches = path.join(root, "first-children");
    const end = path.join(root, "end-controller");
    const lane = (await createPipelineFromRequest({ task: "Adopt a checkout after the controller exits",
      repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
    fs.writeFileSync(shim, `#!/bin/bash
set -eu
if [[ " $* " == *" worktree add "* && " $* " == *" $FIXTURE_TARGET "* ]]; then
  readlink "/proc/$$/fd/3" > "$FIXTURE_WRITES.fd" || true
  printf '%s\\n' "$$" >> "$FIXTURE_WRITES"
  stop=$((SECONDS + 20))
  until [[ -e "$FIXTURE_RELEASE" ]]; do
    [[ $SECONDS -lt $stop ]] || exit 82
    sleep 0.02
  done
fi
exec "$FIXTURE_GIT" "$@"
`, { mode: 0o700 });
    const start = () => {
      const child = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "fixtures", "provisionControllerProcess.ts")], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH!.split(path.delimiter).filter(part => !part.includes("agent-git-hooks")).join(path.delimiter)}`,
          FIXTURE_TARGET: lane.worktreeDir, FIXTURE_WRITES: writes, FIXTURE_RELEASE: release, FIXTURE_GIT: nativeGit,
          LLV_PROVISION_PROCESS_FIXTURE: JSON.stringify({ lane: lane.id, state: process.env.LLV_STATE_DIR, launches, end }),
        }, stdout: "pipe", stderr: "pipe",
      });
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { child, output };
    };
    const done = async (predicate: () => Promise<boolean> | boolean) => {
      const deadline = performance.now() + 9_000;
      while (!await predicate()) {
        if (performance.now() >= deadline) throw new Error("add writer fixture did not converge");
        await Bun.sleep(20);
      }
    };
    const first = start();
    let successor: ReturnType<typeof start> | undefined;
    let peerId: string | undefined;
    try {
      await done(() => fs.existsSync(writes));
      const slot = (await findControllerPipeline(lane.id))?.provisioningJob;
      expect(slot?.step).toBe("creatingCheckout");
      expect(slot?.admittedAdd).toBeDefined();
      expect(fs.existsSync(lane.worktreeDir)).toBe(false);
      const fence = path.join(process.env.LLV_STATE_DIR!, "controller-locks", "add", String(slot!.admittedAdd!.stripe));
      expect(fs.readFileSync(writes + ".fd", "utf8").trim()).toBe(fence);
      expect(Bun.spawnSync(["flock", "-n", fence, "true"]).exitCode).toBe(1);
      first.child.kill("SIGKILL");
      await first.child.exited;
      expect(Bun.spawnSync(["flock", "-n", fence, "true"]).exitCode).toBe(1);
      successor = start();
      await done(async () => (await findControllerPipeline(lane.id))?.provisioningJob?.step === "waitingForCheckoutWriter");
      expect((await findControllerPipeline(lane.id))?.provisioningJob?.since).toBe(slot?.admittedAdd?.since);
      const peer = (await createPipelineFromRequest({ task: "Start another checkout while Git holds the writer fence",
        repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      peerId = peer.id;
      await done(async () => (await findControllerPipeline(peer.id))?.state === "running");
      expect(fs.readFileSync(writes, "utf8").trim().split("\n")).toHaveLength(1);
      fs.writeFileSync(release, "");
      expect(await successor.child.exited, (await successor.output).join("\n")).toBe(0);
      expect((await findControllerPipeline(lane.id))?.provisioningJob).toBeUndefined();
      expect((await findControllerPipeline(lane.id))?.runs[0]?.attempts).toHaveLength(1);
      expect(await git(lane.worktreeDir, "rev-parse", "HEAD")).toBe(slot!.plan!.expectedHead!);
      expect(fs.readFileSync(writes, "utf8").trim().split("\n")).toHaveLength(1);
      expect(fs.readFileSync(launches, "utf8").trim().split("\n").filter(line => line === lane.worktreeDir)).toHaveLength(1);
    } catch (error) {
      const row = await findControllerPipeline(lane.id);
      const peer = peerId ? await findControllerPipeline(peerId) : null;
      fs.writeFileSync(end, "");
      const output = successor ? (await successor.output).join("\n").split("\n").slice(-28).join("\n") : "";
      throw new Error(`${String(error)}; ${row?.state} ${row?.provisioningJob?.step} ${row?.stateDetail}; peer ${peer?.state} ${peer?.stateDetail}\n${output}`);
    } finally {
      fs.writeFileSync(release, "");
      fs.writeFileSync(end, "");
      for (const process of [first, successor]) {
        if (!process) continue;
        if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGTERM");
        await process.child.exited;
        await process.output;
      }
      await removeProvisioningFixture(root);
    }
  }), 32_000);

test.skipIf(process.platform !== "linux")("a lost cache permit reply reaps the leased worker and releases the native fence", () =>
  withControllerAuditState(async () => {
    const { h, git, repo, root } = await realWorktreeLane("worker-reply-loss", BUILD_ONLY as never);
    const held = latch(), late = latch();
    let closeSupply: (() => Promise<void>) | undefined;
    let wall = Date.now(), monotonic = 0, requests = 0, installs = 0;
    const timers = new Set<{ at: number; run: () => void }>();
    const advance = (ms: number) => {
      wall += ms;
      monotonic += ms;
      for (const timer of [...timers]) if (timer.at <= monotonic) {
        timers.delete(timer);
        timer.run();
      }
    };
    const fence = path.join(repo, ".git", "delegatus-dependencies", "v4", "owner.lock");
    const probe = () => Bun.spawnSync(["flock", "-n", fence, "true"]).exitCode;
    try {
      closeSupply = await seedProvisioningPackage(repo, root,
        { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(root, "lockfile-cache") }, process.execPath, () => { installs++; });
      installs = 0;
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "fixture cache permit inputs");
      await git(repo, "push", "origin", "main");
      delete h.ports.provisionExec;
      h.ports.now = () => new Date(wall).toISOString();
      h.ports.provisionClock = { wallMs: () => wall, monotonicMs: () => monotonic,
        arm(delay, run) {
          const timer = { at: monotonic + delay, run };
          timers.add(timer);
          return () => { timers.delete(timer); };
        } };
      h.ports.provisionToolchainReply = async (_id, type) => {
        if (type !== "cacheAcquired" || ++requests !== 1) return;
        held.resolve();
        await late.promise;
      };
      const lane = (await createPipelineFromRequest({ task: "Recover the leased worker after a lost reply", repoDir: repo,
        publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.provisioningJob?.cacheOwner !== undefined);
      await until(held.promise);
      const original = (await findControllerPipeline(lane.id))!.provisioningJob!;
      expect(original).toMatchObject({ step: "preparingToolchain", status: "running" });
      expect(probe()).toBe(1);
      expect(installs).toBe(0);
      advance(original.deadlineAt - wall - 1);
      expect(probe()).toBe(1);
      advance(1);
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.provisioningJob?.status === "waiting" && probe() === 0);
      const waiting = (await findControllerPipeline(lane.id))!.provisioningJob!;
      expect(waiting.interruption).toMatchObject({ step: "preparingToolchain", reason: "provision-step-timeout" });
      expect(installs).toBe(0);
      advance(waiting.retryAt! - wall);
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.runs[0]?.attempts[0]?.startedAt != null);
      late.resolve();
      await tickPipelinesController([], h.ports);
      expect((await findControllerPipeline(lane.id))?.runs[0]?.attempts).toHaveLength(1);
      expect(requests).toBe(2);
      expect(installs).toBe(1);
      expect((await git(repo, "worktree", "list", "--porcelain")).split("\n")
        .filter(line => line === `worktree ${lane.worktreeDir}`)).toHaveLength(1);
    } finally {
      late.resolve();
      await (await import("./provisioningJob")).settleProvisioningJobsForTests();
      await closeSupply?.();
      await settlePipelineControllerJobs();
      await settlePipelineStopReadLanes();
      await removeProvisioningFixture(root);
    }
  }), 26_000);

const linuxInstall = process.platform === "linux" ? test : test.skip;
linuxInstall.each([
  ["file", "unchanged"], ["workspace", "unchanged"], ["file", "replace-before-write"],
  ["file", "resume"], ["file", "replace-on-rerun"], ["file", "replace-during-write"], ["file", "replace-during-rerun"],
] as const)("the production %s install preserves checkout custody in %s", (inputKind, mode) =>
  withControllerAuditState(async () => {
    const { h, git, repo, root } = await realWorktreeLane("relative-install-custody", BUILD_ONLY as never);
    const firstPermit = latch(), release = latch();
    const requestedPackage = latch(), sendPackage = latch();
    const during = mode === "replace-during-write" || mode === "replace-during-rerun";
    const interrupted = mode === "resume" || mode === "replace-on-rerun" || mode === "replace-during-rerun";
    const replaced = during || mode === "replace-before-write" || mode === "replace-on-rerun";
    let wall = Date.now(), monotonic = 0;
    const timers = new Set<{ at: number; run: () => void }>();
    const advance = (ms: number) => {
      wall += ms;
      monotonic += ms;
      for (const timer of [...timers]) if (timer.at <= monotonic) {
        timers.delete(timer);
        timer.run();
      }
    };
    let installs = 0, launches = 0, holdPackage = false;
    let supply: (() => Promise<void>) | undefined;
    let unrelated: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">> | undefined;
    try {
      const packageEnv = { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(root, "lockfile-cache") };
      if (during) {
        supply = await seedProvisioningPackage(repo, root, packageEnv, process.execPath, async () => {
          if (!holdPackage) return;
          requestedPackage.resolve();
          await sendPackage.promise;
        }, "fixture-relative");
      }
      fs.mkdirSync(path.join(repo, "packages", "fixture"), { recursive: true });
      fs.writeFileSync(path.join(repo, "packages", "fixture", "package.json"), '{"name":"fixture-local","version":"1.0.0"}');
      const remote = during ? JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).dependencies : {};
      fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "fixture-relative",
        dependencies: { ...remote, "fixture-local": inputKind === "file" ? "file:./packages/fixture" : "workspace:*" },
        ...(inputKind === "workspace" ? { workspaces: ["packages/*"] } : {}),
      }));
      fs.appendFileSync(path.join(repo, ".gitignore"), "node_modules\n");
      const freeze = Bun.spawn([process.execPath, "--no-env-file", "install", "--lockfile-only", "--ignore-scripts"], {
        cwd: repo, env: packageEnv, stdout: "ignore", stderr: "pipe", timeout: 5_000,
      });
      const [code, error] = await Promise.all([freeze.exited, new Response(freeze.stderr).text()]);
      expect(code, error).toBe(0);
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "checkout relative fixture inputs");
      await git(repo, "push", "origin", "main");
      delete h.ports.provisionExec;
      h.ports.now = () => new Date(interrupted ? wall : Date.now()).toISOString();
      if (interrupted) h.ports.provisionClock = { wallMs: () => wall, monotonicMs: () => monotonic,
        arm(delay, run) {
          const timer = { at: monotonic + delay, run };
          timers.add(timer);
          return () => { timers.delete(timer); };
        } };
      const lane = (await createPipelineFromRequest({ task: "Install the checkout-relative fixture", repoDir: repo,
        publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      const read = () => findControllerPipeline(lane.id);
      const driveInstall = (done: () => Promise<boolean>) => driveProvisioning(h.ports, async () => {
        const slot = (await read())?.provisioningJob;
        // A shared-host process can exit during the real census. Let the
        // frozen clock deliver the ordinary re-probe for an incomplete read.
        if (interrupted && slot?.step === "waitingForLegacyInstaller" && slot.status === "waiting"
          && !slot.legacyWriter && slot.retryAt !== undefined && slot.retryAt > wall) {
          advance(slot.retryAt - wall);
        }
        return done();
      });
      const target = path.join(lane.worktreeDir, "node_modules");
      const launch = h.ports.spawnAgent;
      h.ports.spawnAgent = async (input, reserve) => {
        const result = await launch(input, reserve);
        if (input.cwd === lane.worktreeDir) {
          const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { cwd: input.cwd, stdout: "ignore", stderr: "ignore" });
          expect(await child.exited).toBe(0);
          launches++;
        }
        return result;
      };
      let foreignInode: bigint | undefined;
      const replace = () => {
        fs.renameSync(target, target + ".previous");
        fs.mkdirSync(path.join(target, "fixture-local"), { recursive: true });
        fs.writeFileSync(path.join(target, "fixture-local", "package.json"), "foreign bytes");
        foreignInode = fs.statSync(target, { bigint: true }).ino;
      };
      h.ports.provisionToolchainReply = async (id, type, effect) => {
        if (id === lane.id && type === "ready" && inputKind === "file" && mode === "unchanged" && !unrelated) {
          unrelated = Bun.spawn(["python3", "-c",
            "import ctypes,sys; assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0; print('ready',flush=True); sys.stdin.read(1)"],
          { cwd: lane.worktreeDir, stdin: "pipe", stdout: "pipe", stderr: "ignore", timeout: 10_000 });
          const reader = unrelated.stdout.getReader();
          try {
            expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
            expect(() => fs.readlinkSync(`/proc/${unrelated!.pid}/cwd`)).toThrow();
          } finally { reader.releaseLock(); }
        }
        if (id !== lane.id || type !== "dispatch" || effect !== "install-in-place") return;
        installs++;
        if (interrupted && installs === 1) {
          firstPermit.resolve();
          await release.promise;
          return;
        }
        if (replaced && !during) replace();
      };
      holdPackage = during;
      if (interrupted) {
        await driveInstall(async () => installs === 1);
        await until(firstPermit.promise);
        const slot = (await findControllerPipeline(lane.id))!.provisioningJob!;
        expect(slot.privateIntent?.inode).toBe(String(fs.statSync(target, { bigint: true }).ino));
        expect(fs.existsSync(path.join(target, ".delegatus-install-receipt.json"))).toBe(false);
        advance(slot.deadlineAt - wall);
        await driveInstall(async () => (await read())?.provisioningJob?.status === "waiting");
        const waiting = (await read())!.provisioningJob!;
        expect(waiting.interruption?.reason).toBe("provision-step-timeout");
        release.resolve();
        advance(waiting.retryAt! - wall);
      }
      if (during) {
        let reachedBun = false;
        void requestedPackage.promise.then(() => { reachedBun = true; });
        await driveInstall(async () => reachedBun);
        replace();
        sendPackage.resolve();
      }
      await driveInstall(async () => {
        const row = await read();
        return row?.state === "needs_decision" || (launches === 1 && row?.runs[0]?.attempts[0]?.state === "running");
      });
      const row = (await findControllerPipeline(lane.id))!;
      const marker = path.join(target, ".delegatus-install-receipt.json");
      if (!replaced) {
        expect(row.state, row.stateDetail ?? "").toBe("running");
        expect(installs).toBe(interrupted ? 2 : 1);
        expect(launches).toBe(1);
        expect(fs.existsSync(marker)).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(target, "fixture-local", "package.json"), "utf8")).name).toBe("fixture-local");
      } else {
        expect(row).toMatchObject({ state: "needs_decision", stateDetail: "private-install-unverified" });
        expect(installs).toBe(interrupted ? 2 : 1);
        expect(launches).toBe(0);
        expect(fs.existsSync(marker)).toBe(false);
        expect(fs.statSync(target, { bigint: true }).ino).toBe(foreignInode!);
        expect(fs.readFileSync(path.join(target, "fixture-local", "package.json"), "utf8")).toBe("foreign bytes");
      }
    } finally {
      release.resolve();
      sendPackage.resolve();
      if (unrelated && unrelated.exitCode === null && unrelated.signalCode === null) {
        unrelated.stdin.end();
        await unrelated.exited;
      }
      await (await import("./provisioningJob")).settleProvisioningJobsForTests();
      await supply?.();
      await settlePipelineControllerJobs();
      await settlePipelineStopReadLanes();
      await removeProvisioningFixture(root);
    }
  }), 26_000);

const legacyTree = process.env.LLV_PROVISION_LEGACY_TREE;

test.skipIf(process.platform !== "linux" || !legacyTree).each([
  "crash before launcher", "initializing registration", "launcher timeout without Viewer",
  "Viewer command timeout", "Viewer step expiry", "Viewer step expiry then forward restart", "launcher output limit",
  "suspended launcher", "escaped descendant", "wall-clock jump",
] as const)("add writer rollback cut: %s", cut => withControllerAuditState(async () => {
  const { h, git, repo, root } = await realWorktreeLane("add-writer-rollback", BUILD_ONLY as never);
  const { patchPipeline } = await import("./engine");
  const { settleProvisioningJobsForTests } = await import("./provisioningJob");
  const writerEntries = path.join(root, "writer-entries");
  const escapedEntry = path.join(root, "escaped-entry");
  const release = path.join(root, "release-add");
  const produceOutput = path.join(root, "produce-output");
  const launches = path.join(root, "first-children");
  const end = path.join(root, "controller-end");
  const wallFile = path.join(root, "wall-time");
  const monotonicFile = path.join(root, "monotonic-time");
  const commands = path.join(root, "commands");
  const setWall = (ms: number) => replaceFixtureFile(wallFile, new Date(ms).toISOString());
  const setMono = (ms: number) => replaceFixtureFile(monotonicFile, String(ms));
  const entries = () => fs.existsSync(writerEntries) ? fs.readFileSync(writerEntries, "utf8").trim().split("\n").filter(Boolean) : [];
  const controllers: ReturnType<typeof startFixtureController>[] = [];
  const nativeGit = Bun.which("git", { PATH: "/usr/bin:/bin" })!;
  fs.mkdirSync(commands);
  fs.writeFileSync(path.join(commands, "git"), `#!/bin/bash
set -eu
if [[ " $* " != *" worktree add "* || " $* " != *" $FIXTURE_CHECKOUT "* ]]; then
  exec "$FIXTURE_GIT" "$@"
fi
if [[ -s "$FIXTURE_WRITERS" ]]; then
  printf '%s %s\\n' "$$" "$PPID" >> "$FIXTURE_WRITERS"
  [[ -e "$FIXTURE_RELEASE_ADD" ]] || exit 91
  exec "$FIXTURE_GIT" "$@"
fi
if [[ "$FIXTURE_ADD_CUT" == "initializing registration" ]]; then
  "$FIXTURE_GIT" "$@" --no-checkout
  "$FIXTURE_GIT" worktree lock --reason initializing "$FIXTURE_CHECKOUT"
fi
if [[ "$FIXTURE_ADD_CUT" == "escaped descendant" ]]; then
  setsid /bin/bash -c '
    printf "%s\\n" "$$" > "$FIXTURE_ESCAPED"
    end=$((SECONDS + 75))
    until [[ -e "$FIXTURE_RELEASE_ADD" ]]; do
      [[ $SECONDS -lt $end ]] || exit 81
      sleep 0.05
    done' </dev/null >/dev/null 2>&1 &
fi
printf '%s %s\\n' "$$" "$PPID" >> "$FIXTURE_WRITERS"
end=$((SECONDS + 75))
until [[ -e "$FIXTURE_RELEASE_ADD" ]]; do
  [[ $SECONDS -lt $end ]] || exit 82
  if [[ -e "$FIXTURE_PRODUCE_OUTPUT" ]]; then head -c 9000000 /dev/zero; exit 83; fi
  sleep 0.05
done
[[ "$FIXTURE_ADD_CUT" != "initializing registration" ]] || exit 81
exec "$FIXTURE_GIT" "$@"
`, { mode: 0o700 });
  const lane = (await createPipelineFromRequest({ task: "Reconcile the admitted worktree writer after a release cut",
    repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
  const env = { PATH: commands + path.delimiter + process.env.PATH!, FIXTURE_GIT: nativeGit, FIXTURE_CHECKOUT: lane.worktreeDir,
    FIXTURE_WRITERS: writerEntries, FIXTURE_RELEASE_ADD: release, FIXTURE_ADD_CUT: cut, FIXTURE_ESCAPED: escapedEntry,
    FIXTURE_PRODUCE_OUTPUT: produceOutput };
  const start = (input: Partial<Omit<ProvisionControllerFixture, "state">> = {}, tree?: string) => {
    const controller = startFixtureController({ lane: lane.id, launches, end, wallFile, ...input }, tree, env);
    controllers.push(controller);
    return controller;
  };
  const read = () => findControllerPipeline(lane.id);
  const longTimer = cut === "launcher timeout without Viewer" || cut === "Viewer command timeout";
  const stepExpiry = cut.startsWith("Viewer step expiry");
  const parkFirst = cut === "suspended launcher" || cut === "escaped descendant" || cut === "wall-clock jump";
  let launcher: number | undefined;
  let launcherStart: string | undefined;
  let gitPid: number | undefined;
  let gitStart: string | undefined;
  let descendant: number | undefined;
  let descendantStart: string | undefined;
  let fence = "";
  const fenceFree = () => Bun.spawnSync(["flock", "-n", fence, "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  try {
    setWall(Date.now());
    setMono(0);
    const first = start({ monotonicFile, timeoutMs: longTimer ? 76_000 : 28_000,
      ...(cut === "crash before launcher" ? { crashBeforeAdd: true } : {}) });
    if (cut === "crash before launcher") expect(await first.child.exited, await first.output).toBe(84);
    else {
      await waitForFixture(() => entries().length === 1, "native Git entry");
      [gitPid, launcher] = entries()[0]!.split(" ").map(Number);
      launcherStart = processStart(launcher!);
      gitStart = processStart(gitPid!);
      expect(launcherStart).toBeTruthy();
      expect(gitStart).toBeTruthy();
    }
    const observedWriterAt = performance.now();
    const admitted = (await read())!;
    const add = admitted.provisioningJob!.admittedAdd!;
    const rollbackWait = admitted.provisioningWait!;
    const horizon = Date.parse(rollbackWait.retryAfter);
    expect(horizon - add.since).toBe(300_000);
    expect(admitted.runs[0]?.attempts).toHaveLength(0);
    fence = path.join(process.env.LLV_STATE_DIR!, "controller-locks", "add", String(add.stripe));
    expect(fenceFree()).toBe(cut === "crash before launcher");
    if (cut === "crash before launcher") {
      expect(entries()).toEqual([]);
      expect(fs.existsSync(lane.worktreeDir)).toBe(false);
    }
    if (cut === "initializing registration") {
      expect(await git(repo, "worktree", "list", "--porcelain")).toContain("locked initializing");
      expect(fs.existsSync(path.join(lane.worktreeDir, ".gitignore"))).toBe(false);
    }
    if (cut === "escaped descendant") {
      await waitForFixture(() => fs.existsSync(escapedEntry) && fs.statSync(escapedEntry).size > 0, "escaped writer identity");
      descendant = Number(fs.readFileSync(escapedEntry, "utf8"));
      descendantStart = processStart(descendant);
      expect(descendantStart).toBeTruthy();
    }
    if (cut === "suspended launcher" || cut === "Viewer command timeout") process.kill(launcher!, "SIGSTOP");
    if (stepExpiry || cut === "escaped descendant") setMono(60_000);
    if (cut === "launcher output limit") fs.writeFileSync(produceOutput, "");
    if (stepExpiry || cut === "escaped descendant" || cut === "Viewer command timeout" || cut === "launcher output limit") {
      await waitForFixture(() => processStart(gitPid!) !== gitStart && processStart(launcher!) !== launcherStart,
        "Viewer reaps its launcher's Git group", longTimer ? 68_000 : 5_000);
    }
    if (cut === "Viewer step expiry") {
      await waitForFixture(async () => (await read())?.provisioningJob?.admittedAdd?.previousWait?.rounds === 1,
        "expired step records a transient retry alongside the rollback deferral");
    }
    await first.stop("SIGKILL");
    if (cut === "launcher timeout without Viewer") {
      expect(processStart(gitPid!)).toBe(gitStart);
      expect(fenceFree()).toBe(false);
      await waitForFixture(() => fenceFree(), "autonomous add launcher timeout", 68_000);
      expect(processStart(gitPid!)).not.toBe(gitStart);
      expect(processStart(launcher!)).not.toBe(launcherStart);
    }
    if (stepExpiry || longTimer || cut === "launcher output limit") expect(fenceFree()).toBe(true);
    if (longTimer) {
      expect(performance.now() - observedWriterAt).toBeGreaterThan(57_000);
      expect(performance.now() - observedWriterAt).toBeLessThan(65_000);
    }
    if (cut === "escaped descendant") {
      expect(processStart(descendant!)).toBe(descendantStart);
      expect(fenceFree()).toBe(false);
    }
    if (cut === "wall-clock jump") setWall(add.since + 180_000);
    const peer = (await createPipelineFromRequest({ task: "Launch another lane during the add deferral",
      repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
    const old = start({ lane: peer.id }, legacyTree!);
    expect(await old.child.exited, await old.output).toBe(0);
    expect(fixtureLaunchCount(launches, peer.worktreeDir)).toBe(1);
    expect(fixtureLaunchCount(launches, lane.worktreeDir)).toBe(0);
    expect(entries()).toHaveLength(cut === "crash before launcher" ? 0 : 1);
    expect((await read())?.provisioningWait?.retryAfter).toBe(rollbackWait.retryAfter);
    if (parkFirst) {
      if (process.env.LLV_PROVISION_UNSAFE_ROLLBACK_CONTROL === "1") {
        setWall(horizon);
        const unsafe = start({}, legacyTree!);
        await waitForFixture(() => entries().length >= 2, "pre-v1 dispatch past the deferral");
        expect(entries()).toHaveLength(1);
        await unsafe.stop();
        return;
      }
      if (cut !== "wall-clock jump") setWall(add.since + 64_999);
      const forward = start();
      if (cut !== "wall-clock jump") {
        await waitForFixture(async () => (await read())?.provisioningJob?.status === "waiting", "writer wait just before its cutoff");
        expect((await read())?.provisioningJob).toMatchObject({
          step: "waitingForCheckoutWriter", since: add.since, deadlineAt: add.since + 65_000,
        });
        setWall(add.since + 65_000);
      }
      await waitForFixture(async () => (await read())?.state === "needs_decision", "park while native writer remains");
      expect((await read())?.stateDetail).toBe("checkout-writer-unverified");
      expect(fenceFree()).toBe(false);
      await forward.stop();
      setWall(horizon);
      const peerAfterPark = (await createPipelineFromRequest({ task: "Launch a peer during supported rollback",
        repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      const rollback = start({ lane: peerAfterPark.id }, legacyTree!);
      expect(await rollback.child.exited, await rollback.output).toBe(0);
      expect(fixtureLaunchCount(launches, peerAfterPark.worktreeDir)).toBe(1);
      expect(fixtureLaunchCount(launches, lane.worktreeDir)).toBe(0);
      expect(entries()).toHaveLength(1);
    }
    let initializingSuccessor: ReturnType<typeof startFixtureController> | undefined;
    if (cut === "initializing registration") {
      initializingSuccessor = start();
      await waitForFixture(async () => (await read())?.provisioningJob?.step === "waitingForCheckoutWriter",
        "forward reader preserves the live initializing registration");
      expect((await read())?.provisioningJob?.since).toBe(add.since);
      expect(await git(repo, "worktree", "list", "--porcelain")).toContain("locked initializing");
      expect(entries()).toHaveLength(1);
    }
    fs.writeFileSync(release, "");
    if (cut === "suspended launcher" && processStart(launcher!) === launcherStart) process.kill(launcher!, "SIGCONT");
    await waitForFixture(() => fenceFree(), "independent add exit proof");
    if (parkFirst) {
      const retried = await patchPipeline(lane.id, { action: "retry-stage" }, h.ports);
      expect(retried.pipeline?.state).toBe("provisioning");
    }
    const useLegacy = longTimer || cut === "Viewer step expiry" || cut === "launcher output limit";
    if (useLegacy) setWall(horizon);
    if (cut === "Viewer step expiry then forward restart") setWall((await read())?.provisioningJob?.retryAt ?? add.since);
    if (initializingSuccessor) setWall(add.since + 5_000);
    const last = initializingSuccessor ?? start({}, useLegacy ? legacyTree : undefined);
    expect(await last.child.exited, await last.output).toBe(0);
    if (useLegacy) {
      expect((await read())?.provisioningWait).toBeUndefined();
      delete h.ports.provisionExec;
      await driveProvisioning(h.ports, async () => (await read())?.provisioningJob === undefined);
    }
    expect((await read())?.provisioningJob).toBeUndefined();
    expect((await read())?.provisioningWait).toBeUndefined();
    expect((await read())?.runs[0]?.attempts).toHaveLength(1);
    expect(fixtureLaunchCount(launches, lane.worktreeDir)).toBe(1);
    expect(await git(lane.worktreeDir, "rev-parse", "HEAD")).toBe(admitted.baseRef);
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("locked initializing");
    expect(entries()).toHaveLength(useLegacy || cut === "escaped descendant" || cut === "Viewer step expiry then forward restart" ? 2 : 1);
  } finally {
    fs.writeFileSync(release, "");
    fs.writeFileSync(end, "");
    if (launcher !== undefined && launcherStart !== undefined && processStart(launcher) === launcherStart) {
      try { process.kill(launcher, "SIGCONT"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    for (const controller of controllers) await controller.stop();
    if (fence) await waitForFixture(fenceFree, "fixture add fence cleanup");
    await settleProvisioningJobsForTests();
    await settlePipelineControllerJobs();
    await settlePipelineStopReadLanes();
    await removeProvisioningFixture(root);
  }
}), 105_000);

test.skipIf(!legacyTree).each(["no private tree", "partial private tree"] as const)(
  "pre-v1 reads the committed plan after origin moves with %s",
  privateTree =>
  withControllerAuditState(async () => {
    const { h, git, repo, root } = await realWorktreeLane("legacy-plan-readback", BUILD_ONLY as never);
    const { settleProvisioningJobsForTests } = await import("./provisioningJob");
    const held = latch(), release = latch();
    let predecessor: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
    try {
      const partial = privateTree === "partial private tree";
      if (partial) {
        fs.appendFileSync(path.join(repo, ".gitignore"), "node_modules\n");
        fs.writeFileSync(path.join(repo, "package.json"), '{"name":"fixture-private","dependencies":{"local":"file:./missing-local"}}\n');
        await git(repo, "add", ".");
        await git(repo, "commit", "-m", "checkout-relative fixture inputs before rollback");
        await git(repo, "push", "origin", "main");
      }
      delete h.ports.provisionExec;
      h.ports.now = () => new Date().toISOString();
      const lane = (await createPipelineFromRequest({ task: "Use the committed checkout plan across releases", repoDir: repo,
        publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      h.ports.provisionToolchainReply = async (id, phase) => {
        if (id !== lane.id || phase !== "ready") return;
        held.resolve();
        await release.promise;
      };
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.provisioningJob?.worker !== undefined);
      await until(held.promise);
      await settleProvisioningJobsForTests();
      release.resolve();
      const stopped = (await findControllerPipeline(lane.id))!;
      expect(stopped.provisioningJob?.admittedAdd).toBeUndefined();
      expect(stopped.provisioningWait).toBeUndefined();
      const planned = stopped.provisioningJob?.plan?.expectedHead;
      expect(stopped.baseRef).toBe(planned!);
      const modules = path.join(lane.worktreeDir, "node_modules");
      const unchecked = path.join(modules, "unfinished");
      if (partial) {
        fs.mkdirSync(modules);
        fs.writeFileSync(unchecked, "partial installation");
      }
      await git(repo, "commit", "--allow-empty", "-m", "move origin after the selected checkout");
      await git(repo, "push", "origin", "main");
      expect(await git(repo, "rev-parse", "HEAD")).not.toBe(planned!);
      const launches = path.join(root, "legacy-first-child");
      predecessor = Bun.spawn([process.execPath, "--no-env-file", "src/lib/pipelines/fixtures/provisionControllerProcess.ts"], {
        cwd: legacyTree!, env: { ...process.env, LLV_PROVISION_PROCESS_FIXTURE: JSON.stringify({
          lane: lane.id, state: process.env.LLV_STATE_DIR, launches, end: path.join(root, "end-legacy-controller"),
        }) }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000,
      });
      const [code, stdout, stderr] = await Promise.all([predecessor.exited, new Response(predecessor.stdout).text(),
        new Response(predecessor.stderr).text()]);
      expect(code, stderr + stdout).toBe(0);
      expect(stdout.split("\n").filter(line => line.includes('"phase":"git-started","step":"fetch"'))).toHaveLength(0);
      expect(stdout.split("\n").filter(line => line.includes('"phase":"git-finished","step":"worktree-add","status":"failed"'))).toHaveLength(1);
      expect(fs.readFileSync(launches, "utf8").trim()).toBe(lane.worktreeDir);
      expect(await git(lane.worktreeDir, "rev-parse", "HEAD")).toBe(planned!);
      if (partial) {
        expect(fs.readFileSync(unchecked, "utf8")).toBe("partial installation");
        expect(fs.existsSync(path.join(modules, ".delegatus-install-receipt.json"))).toBe(false);
        expect(fs.existsSync(path.join(modules, "local"))).toBe(false);
      }
      expect((await findControllerPipeline(lane.id))?.provisioningJob?.token).toBe(stopped.provisioningJob?.token);
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.provisioningJob === undefined);
      expect((await findControllerPipeline(lane.id))?.runs[0]?.attempts).toHaveLength(1);
    } finally {
      release.resolve();
      if (predecessor && predecessor.exitCode === null && predecessor.signalCode === null) {
        predecessor.kill();
        await predecessor.exited;
      }
      await settleProvisioningJobsForTests();
      await settlePipelineControllerJobs();
      await settlePipelineStopReadLanes();
      await removeProvisioningFixture(root);
    }
  }), 42_000);

test("a fresh controller applies the original checkout after a refused state admission", () => withControllerAuditState(async () => {
  const { h, git, repo, root } = await realWorktreeLane("apply-admission-refused", BUILD_ONLY as never);
  const { pipeline: lane } = await createPipelineFromRequest({ task: "Keep the verified checkout after apply refusal",
    repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports);
  const end = path.join(root, "controller-end"), launches = path.join(root, "first-children");
  const entered = path.join(root, "apply-verification-exited"), release = path.join(root, "release-verification");
  const start = (holdApply: boolean) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "fixtures", "provisionControllerProcess.ts")], {
      env: { ...process.env, LLV_PIPELINE_LOCK_WAIT_MS: "40", LLV_PROVISION_PROCESS_FIXTURE: JSON.stringify({
        lane: lane!.id, state: process.env.LLV_STATE_DIR, launches, end, ...(holdApply ? { applyBarrier: { entered, release } } : {}),
      }) }, stdout: "pipe", stderr: "pipe", timeout: 22_000,
    });
    return { child, stdout: new Response(child.stdout).text(), stderr: new Response(child.stderr).text() };
  };
  const held = latch(), unlock = latch();
  const first = start(true);
  let holder: Promise<void> | undefined;
  let second: ReturnType<typeof start> | undefined;
  try {
    const untilBarrier = performance.now() + 7_000;
    while (!fs.existsSync(entered)) {
      if (performance.now() >= untilBarrier) throw new Error("checkout verification did not reach the apply boundary");
      await Bun.sleep(15);
    }
    const pending = (await findControllerPipeline(lane!.id))!;
    expect(pending.provisioningJob?.step).toBe("applyingCheckout");
    expect(pending.runs[0]?.attempts).toHaveLength(0);
    holder = withPipelineMutation(async () => { held.resolve(); await unlock.promise; });
    await until(held.promise);
    fs.writeFileSync(release, "");
    await Bun.sleep(360);
    expect((await findControllerPipeline(lane!.id))?.provisioningJob?.status).toBe("awaitingApply");
    expect(fs.existsSync(launches)).toBe(false);
    first.child.kill("SIGKILL");
    await first.child.exited;
    unlock.resolve();
    await holder;
    expect(await first.stderr).toMatch(/"callSite":"state.lease"[^\n]*"outcome":"timeout"[^\n]*"refused":true/);
    await git(repo, "commit", "--allow-empty", "-m", "move origin after the refused apply");
    await git(repo, "push", "origin", "main");
    second = start(false);
    expect(await second.child.exited, await second.stderr).toBe(0);
    const final = (await findControllerPipeline(lane!.id))!;
    expect(final).toMatchObject({ state: "running", lastPassedCommit: pending.baseRef });
    expect(final.provisioningJob).toBeUndefined();
    expect(final.runs[0]?.attempts).toHaveLength(1);
    expect(await git(lane!.worktreeDir, "rev-parse", "HEAD")).toBe(pending.baseRef);
    expect(fs.readFileSync(launches, "utf8").trim()).toBe(lane!.worktreeDir);
    expect((await second.stdout).split("\n").filter(line => line.includes('"phase":"git-started","step":"worktree-add"'))).toHaveLength(0);
  } finally {
    unlock.resolve();
    await holder;
    fs.writeFileSync(release, "");
    fs.writeFileSync(end, "");
    for (const proc of [first, second]) {
      if (!proc) continue;
      if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill();
      await Promise.all([proc.child.exited, proc.stdout, proc.stderr]);
    }
    await removeProvisioningFixture(root);
  }
}), 32_000);

test("a fresh controller starts one child after the committed apply reply is lost", () => withControllerAuditState(async () => {
  const { h, git, repo, root } = await realWorktreeLane("apply-reply-lost", BUILD_ONLY as never);
  const lane = (await createPipelineFromRequest({ task: "Recover a committed apply after the Viewer exits",
    repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
  const launches = path.join(root, "first-children");
  const input = { lane: lane.id, launches, end: path.join(root, "end-controller") };
  const first = startFixtureController({ ...input, loseApplyReply: true });
  let successor: ReturnType<typeof startFixtureController> | undefined;
  try {
    expect(await first.child.exited, await first.output).toBe(83);
    const consumed = (await findControllerPipeline(lane.id))!;
    expect(consumed.state).toBe("running");
    expect(consumed.provisioningJob).toBeUndefined();
    expect(consumed.provisioningWait).toBeUndefined();
    expect(consumed.runs[0]?.attempts).toHaveLength(0);
    expect(fixtureLaunchCount(launches, lane.worktreeDir)).toBe(0);
    expect((await first.output).match(/"phase":"git-started","step":"worktree-add"/g)).toHaveLength(1);
    await git(repo, "commit", "--allow-empty", "-m", "move origin after the successful apply");
    await git(repo, "push", "origin", "main");
    successor = startFixtureController(input);
    expect(await successor.child.exited, await successor.output).toBe(0);
    expect(await successor.output).not.toContain('"phase":"git-started","step":"worktree-add"');
    const final = (await findControllerPipeline(lane.id))!;
    expect(final.lastPassedCommit).toBe(consumed.baseRef);
    expect(await git(lane.worktreeDir, "rev-parse", "HEAD")).toBe(consumed.baseRef);
    expect(final.runs[0]?.attempts).toHaveLength(1);
    expect(fixtureLaunchCount(launches, lane.worktreeDir)).toBe(1);
  } finally {
    await first.stop();
    await successor?.stop();
    await removeProvisioningFixture(root);
  }
}), 40_000);

test.skipIf(process.platform !== "linux")("a slotless checkout waits for the live legacy frozen installer before handoff", () =>
  withControllerAuditState(async () => {
    const { h, git, repo, root } = await realWorktreeLane("live-legacy-installer", BUILD_ONLY as never);
    const requested = latch(), finish = latch();
    let hold = false;
    let supply: (() => Promise<void>) | undefined;
    let installer: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
    try {
      supply = await seedProvisioningPackage(repo, root,
        { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(root, "lockfile-cache") }, process.execPath,
        async () => { if (hold) { requested.resolve(); await finish.promise; } }, "fixture-private");
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "frozen legacy install inputs");
      await git(repo, "push", "origin", "main");
      const expected = await git(repo, "rev-parse", "HEAD");
      const lane = (await createPipelineFromRequest({ task: "Wait for a legacy installer before writing any dependencies",
        repoDir: repo, baseRef: expected, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      await git(repo, "worktree", "add", "-b", lane.branch, lane.worktreeDir, expected);
      const { recordWorktreeProvenance } = await import("./worktreeProvenance");
      expect(recordWorktreeProvenance(lane.worktreeDir, { creator: "pipeline", id: lane.id })).toBe(true);
      expect((await findControllerPipeline(lane.id))?.provisioningJob).toBeUndefined();
      hold = true;
      installer = Bun.spawn([process.execPath, "--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile"], {
        cwd: lane.worktreeDir, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 16_000,
        env: { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(root, "legacy-cache") },
      });
      const output = Promise.all([new Response(installer.stdout).text(), new Response(installer.stderr).text()]);
      await until(requested.promise, 5_000);
      delete h.ports.provisionExec;
      h.ports.now = () => new Date().toISOString();
      const observed: string[] = [];
      h.ports.provisionToolchainReply = async (id, type, detail) => {
        if (id === lane.id && type === "dispatch" && detail) observed.push(detail);
      };
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.provisioningJob?.step === "waitingForLegacyInstaller");
      const waiting = (await findControllerPipeline(lane.id))!;
      expect(waiting.provisioningJob?.waitReason).toBe("private-install-writer-live (possible-writer)");
      expect(waiting.provisioningJob?.legacyWriter?.pid).toBe(installer.pid);
      expect(waiting.provisioningJob?.legacyWriter?.start).toMatch(/^\d+$/);
      expect(waiting.runs[0]?.attempts).toHaveLength(0);
      expect(observed).not.toContain("private-scratch");
      expect(fs.readdirSync(lane.worktreeDir).some(file => file.startsWith(".delegatus-dependencies-"))).toBe(false);
      hold = false;
      finish.resolve();
      expect(await installer.exited, (await output).join("\n")).toBe(0);
      const local = path.join(lane.worktreeDir, "node_modules");
      const inode = fs.statSync(local, { bigint: true }).ino;
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.runs[0]?.attempts[0]?.state === "running");
      expect(fs.statSync(local, { bigint: true }).ino).toBe(inode);
      expect((await findControllerPipeline(lane.id))?.runs[0]?.attempts).toHaveLength(1);
      expect(await git(lane.worktreeDir, "rev-parse", "HEAD")).toBe(expected);
    } finally {
      finish.resolve();
      if (installer && installer.exitCode === null && installer.signalCode === null) {
        installer.kill();
        await installer.exited;
      }
      await (await import("./provisioningJob")).settleProvisioningJobsForTests();
      await supply?.();
      await settlePipelineControllerJobs();
      await settlePipelineStopReadLanes();
      await removeProvisioningFixture(root);
    }
  }), 24_000);

function processStart(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return ["Z", "X", "x"].includes(fields[0]!) ? undefined : fields[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

test.skipIf(process.platform !== "linux" || !legacyTree).each([
  "before directory creation", "after directory creation", "partial after exit", "expires with writer alive",
  "checkout-relative install", "after v1 staged stop and legacy finish", "after v1 staged stop and legacy partial exit",
] as const)("a complete legacy Viewer shutdown with its installer held %s", cut =>
  withControllerAuditState(async () => {
    const { h, git, repo, root } = await realWorktreeLane("legacy-viewer-shutdown", BUILD_ONLY as never);
    const { settleProvisioningJobsForTests } = await import("./provisioningJob");
    let supplier: (() => Promise<void>) | undefined;
    let old: ReturnType<typeof startFixtureController> | undefined;
    let baseline: ReturnType<typeof startFixtureController> | undefined;
    let initial: ReturnType<typeof startFixtureController> | undefined;
    let writer: number | undefined;
    let writerStart: string | undefined;
    let wall = Date.now();
    const writerLive = () => writer !== undefined && writerStart !== undefined && processStart(writer) === writerStart;
    const release = path.join(root, "release-installer");
    const pidFile = path.join(root, "legacy-installer");
    const afterStagedStop = cut.startsWith("after v1 staged stop");
    const relative = cut === "checkout-relative install";
    const beforeCreate = cut === "before directory creation" || relative;
    const partialExit = cut === "partial after exit" || cut === "after v1 staged stop and legacy partial exit";
    try {
      supplier = await seedProvisioningPackage(repo, root, process.env, process.execPath, undefined, "fixture-private");
      if (relative) {
        const pkg = path.join(repo, "package.json");
        const manifest = JSON.parse(fs.readFileSync(pkg, "utf8"));
        manifest.dependencies["fixture-local"] = "file:./packages/local";
        fs.writeFileSync(pkg, JSON.stringify(manifest));
        fs.mkdirSync(path.join(repo, "packages/local"), { recursive: true });
        fs.writeFileSync(path.join(repo, "packages/local/package.json"), '{"name":"fixture-local","version":"1.0.0"}\n');
        const lock = Bun.spawnSync([process.execPath, "--no-env-file", "install", "--lockfile-only", "--ignore-scripts"],
          { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 8_000 });
        expect(lock.exitCode, lock.stderr.toString()).toBe(0);
      }
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "legacy fixture package inputs");
      await git(repo, "push", "origin", "main");
      delete h.ports.provisionExec;
      h.ports.now = () => new Date(wall).toISOString();
      const lane = (await createPipelineFromRequest({ task: "Wait for the exited legacy Viewer's installer",
        repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      const modules = path.join(lane.worktreeDir, "node_modules");
      const partial = path.join(modules, "partial");
      const launches = path.join(root, "first-children");
      const input = { lane: lane.id, launches, end: path.join(root, "end-controller") };
      const spawnAgent = h.ports.spawnAgent;
      h.ports.spawnAgent = async (request, reserve) => {
        const result = await spawnAgent(request, reserve);
        const observer = Bun.spawn([process.execPath, "-e",
          'require("node:fs").appendFileSync(process.argv[1], process.cwd() + "\\n")', launches],
        { cwd: request.cwd, stdout: "ignore", stderr: "ignore", timeout: 5_000 });
        expect(await observer.exited).toBe(0);
        return result;
      };
      if (afterStagedStop) {
        const holdStagedInstall = path.join(root, "staged-install-held");
        initial = startFixtureController({ ...input, holdStagedInstall });
        await waitForFixture(() => fs.existsSync(holdStagedInstall), "v1 stopped after staged scratch creation");
        const slot = (await findControllerPipeline(lane.id))!.provisioningJob!;
        expect(fs.readdirSync(lane.worktreeDir)).toContain(`.delegatus-dependencies-${slot.token}`);
        expect(fs.existsSync(modules)).toBe(false);
        expect(slot.privateReceipt).toBeUndefined();
        await initial.stop("SIGKILL");
        await waitForFixture(() => processStart(slot.worker!.pid) === undefined, "v1 worker reaped at shutdown");
      }
      const commands = path.join(root, "commands");
      fs.mkdirSync(commands);
      fs.writeFileSync(path.join(commands, "bun"), `#!/bin/bash
set -eu
if [[ $PWD == "$FIXTURE_CHECKOUT" && $# -gt 0 && $1 == install ]]; then
  if [[ "$FIXTURE_CREATE" == yes ]]; then
    mkdir node_modules
    printf 'partial installation' > node_modules/partial
  fi
  printf '%s\\n' "$$" > "$FIXTURE_PID"
  stop=$((SECONDS + 24))
  until [[ -s "$FIXTURE_RELEASE" ]]; do
    [[ $SECONDS -lt $stop ]] || exit 82
    sleep 0.02
  done
  [[ $(<"$FIXTURE_RELEASE") == finish ]] || exit 81
  if [[ "$FIXTURE_CREATE" == yes ]]; then rm node_modules/partial; fi
fi
exec "$FIXTURE_BUN" "$@"
`, { mode: 0o700 });
      old = startFixtureController(input, legacyTree!, { PATH: commands + path.delimiter + process.env.PATH!,
        FIXTURE_CHECKOUT: lane.worktreeDir, FIXTURE_CREATE: beforeCreate ? "no" : "yes",
        FIXTURE_PID: pidFile, FIXTURE_RELEASE: release, FIXTURE_BUN: process.execPath,
        BUN_INSTALL_CACHE_DIR: path.join(root, "legacy-cache"),
      });
      await waitForFixture(() => fs.existsSync(pidFile) && fs.statSync(pidFile).size > 0, "legacy installer launched by pre-v1");
      writer = Number(fs.readFileSync(pidFile, "utf8"));
      writerStart = processStart(writer);
      expect(writer).toBeGreaterThan(1);
      expect(fs.existsSync(modules)).toBe(!beforeCreate);
      const before = fs.existsSync(modules) ? fs.statSync(modules, { bigint: true }) : undefined;
      const scratches = () => fs.readdirSync(lane.worktreeDir).filter(name => name.startsWith(".delegatus-dependencies-")).sort();
      const priorScratch = scratches();
      await old.stop("SIGKILL");
      expect(old.child.signalCode).toBe("SIGKILL");
      expect(writerLive()).toBe(true);
      expect(!!(await findControllerPipeline(lane.id))?.provisioningJob).toBe(afterStagedStop);
      expect(fixtureLaunchCount(launches, lane.worktreeDir)).toBe(0);
      if (process.env.LLV_PROVISION_LEGACY_CENSUS_CONTROL === "1") {
        // Compare the same zero-launch assertion with the pre-v1 readiness predicate.
        baseline = startFixtureController(input, legacyTree!);
        expect(await baseline.child.exited, await baseline.output).toBe(0);
        expect(fixtureLaunchCount(launches, lane.worktreeDir)).toBe(0);
        return;
      }
      const effects: string[] = [];
      h.ports.provisionToolchainReply = async (id, type, detail) => {
        if (id === lane.id && type === "dispatch" && detail) effects.push(detail);
      };
      const read = () => findControllerPipeline(lane.id);
      await driveProvisioning(h.ports, async () => (await read())?.provisioningJob?.step === "waitingForLegacyInstaller");
      const waiting = (await read())!;
      expect(waiting.provisioningJob).toMatchObject({ legacyWriter: { pid: writer, start: writerStart },
        waitReason: "private-install-writer-live (possible-writer)" });
      expect(waiting.runs[0]?.attempts).toHaveLength(0);
      expect(fs.existsSync(modules)).toBe(!!before);
      if (before) {
        expect(fs.statSync(modules, { bigint: true }).ino).toBe(before.ino);
        expect(fs.readdirSync(modules)).toEqual(["partial"]);
      }
      expect(effects.filter(effect => effect.startsWith("private-"))).toEqual([]);
      expect(scratches()).toEqual(priorScratch);
      if (cut === "expires with writer alive") {
        wall = waiting.provisioningJob!.deadlineAt;
        await driveProvisioning(h.ports, async () => (await read())?.state === "needs_decision");
        expect(writerLive()).toBe(true);
        expect((await read())?.stateDetail).toBe("private-install-writer-live (possible-writer)");
        expect(effects.filter(effect => effect.startsWith("private-"))).toEqual([]);
      } else {
        fs.writeFileSync(release, partialExit ? "stop" : "finish");
        await waitForFixture(() => !writerLive(), "legacy installer exit");
        wall = waiting.provisioningJob!.retryAt!;
        if (relative) {
          const inode = fs.statSync(modules, { bigint: true }).ino;
          await driveProvisioning(h.ports, async () => (await read())?.state === "needs_decision");
          expect((await read())?.stateDetail).toBe("private-install-unverified");
          expect(fs.statSync(modules, { bigint: true }).ino).toBe(inode);
          expect(fs.existsSync(path.join(modules, "fixture-local", "package.json"))).toBe(true);
          expect((await read())?.runs[0]?.attempts).toHaveLength(0);
          return;
        } else if (partialExit) {
          await driveProvisioning(h.ports, async () => (await read())?.state === "needs_decision");
          expect((await read())?.stateDetail).toBe("private-install-unverified");
        } else {
          const inode = fs.statSync(modules, { bigint: true }).ino;
          await driveProvisioning(h.ports, async () => (await read())?.runs[0]?.attempts[0]?.state === "running");
          expect(fs.statSync(modules, { bigint: true }).ino).toBe(inode);
          expect((await read())?.runs[0]?.attempts).toHaveLength(1);
          expect(fixtureLaunchCount(launches, lane.worktreeDir)).toBe(1);
          expect(await git(lane.worktreeDir, "rev-parse", "HEAD")).toBe((await read())!.baseRef);
          return;
        }
      }
      expect((await read())?.runs[0]?.attempts).toHaveLength(0);
      expect(fs.readFileSync(partial, "utf8")).toBe("partial installation");
      expect(fs.statSync(modules, { bigint: true }).ino).toBe(before!.ino);
      if (afterStagedStop && partialExit) {
        const { patchPipeline } = await import("./engine");
        // This is the fixture operator removing the inspected partial tree.
        fs.rmSync(modules, { recursive: true });
        expect((await patchPipeline(lane.id, { action: "retry-stage" }, h.ports)).pipeline?.state).toBe("provisioning");
        await driveProvisioning(h.ports, async () => (await read())?.runs[0]?.attempts[0]?.state === "running");
        expect(fs.existsSync(path.join(modules, ".delegatus-install-receipt.json"))).toBe(true);
        expect(fixtureLaunchCount(launches, lane.worktreeDir)).toBe(1);
      }
    } finally {
      fs.writeFileSync(release, "stop");
      await old?.stop();
      await baseline?.stop();
      await initial?.stop();
      await waitForFixture(() => !writerLive(), "fixture installer cleanup");
      await settleProvisioningJobsForTests();
      await supplier?.();
      await settlePipelineControllerJobs();
      await settlePipelineStopReadLanes();
      await removeProvisioningFixture(root);
    }
  }), 29_000);

test.skipIf(process.platform !== "linux")("consume refuses a possible legacy writer with an unreadable working directory", () =>
  withControllerAuditState(async () => {
    const { h, git, repo, root } = await realWorktreeLane("legacy-at-consume", BUILD_ONLY as never);
    const { settleProvisioningJobsForTests } = await import("./provisioningJob");
    let supplier: (() => Promise<void>) | undefined;
    let writer: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">> | undefined;
    let wall = Date.now();
    try {
      supplier = await seedProvisioningPackage(repo, root, process.env, process.execPath, undefined, "fixture-private");
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "fixture inputs for private consume");
      await git(repo, "push", "origin", "main");
      delete h.ports.provisionExec;
      h.ports.now = () => new Date(wall).toISOString();
      const lane = (await createPipelineFromRequest({ task: "Prove private readiness at consume",
        repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      h.ports.observeProvisioningCheckpoint = async (id, view) => {
        if (id !== lane.id || view?.step !== "applyingCheckout" || writer) return;
        writer = Bun.spawn([process.execPath, "--no-env-file", "-e", `
          import { dlopen, FFIType } from "bun:ffi";
          const libc = dlopen("libc.so.6", { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });
          if (libc.symbols.prctl(4, 0n, 0n, 0n, 0n) !== 0) process.exit(1);
          console.log("ready");
          for await (const chunk of Bun.stdin.stream()) if (chunk.length) break;
        `, "--", "install"], { cwd: lane.worktreeDir, stdin: "pipe", stdout: "pipe", stderr: "ignore", timeout: 14_000 });
        const reader = writer.stdout.getReader();
        try {
          await until(reader.read().then(frame => {
            expect(new TextDecoder().decode(frame.value)).toBe("ready\n");
          }), 3_000);
          expect(() => fs.readlinkSync(`/proc/${writer!.pid}/cwd`)).toThrow();
        } finally { reader.releaseLock(); }
      };
      await driveProvisioning(h.ports, async () => {
        const row = await findControllerPipeline(lane.id);
        return row?.provisioningJob?.step === "waitingForLegacyInstaller" || row?.state === "running";
      });
      const waiting = (await findControllerPipeline(lane.id))!;
      expect(waiting.provisioningJob).toMatchObject({
        step: "waitingForLegacyInstaller", status: "waiting", waitReason: "private-install-writer-live (working-directory)",
      });
      expect(waiting.runs[0]?.attempts).toHaveLength(0);
      expect(writer).toBeDefined();
      writer!.stdin.end();
      expect(await writer!.exited).toBe(0);
      wall = waiting.provisioningJob!.retryAt!;
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.runs[0]?.attempts[0]?.state === "running");
      expect((await findControllerPipeline(lane.id))?.runs[0]?.attempts).toHaveLength(1);
    } finally {
      if (writer && writer.exitCode === null && writer.signalCode === null) {
        writer.stdin.end();
        await writer.exited;
      }
      await settleProvisioningJobsForTests();
      await supplier?.();
      await settlePipelineControllerJobs();
      await settlePipelineStopReadLanes();
      await removeProvisioningFixture(root);
    }
  }), 24_000);

test.skipIf(process.platform !== "linux").each(["recovers", "parks at the original cutoff"] as const)(
  "incomplete enumeration %s across a controller restart", outcome => withControllerAuditState(async () => {
    const { h, git, repo, base, root } = await realWorktreeLane("legacy-census-incomplete", BUILD_ONLY as never);
    let supplier: (() => Promise<void>) | undefined;
    const controllers: ReturnType<typeof startFixtureController>[] = [];
    const wallFile = path.join(root, "clock");
    const enumerationFault = path.join(root, "fail-enumeration");
    const end = path.join(root, "controller-end");
    const launches = path.join(root, "first-children");
    const setWall = (ms: number) => replaceFixtureFile(wallFile, new Date(ms).toISOString());
    const now = Date.now();
    setWall(now);
    try {
      // Use the release worker entry with a fault only at its OS enumeration read.
      const release = path.join(root, "release");
      const bundle = path.join(release, ".next", "server", "provision-toolchain-worker.js");
      fs.mkdirSync(path.dirname(bundle), { recursive: true });
      for (const item of ["src", "bin", "tsconfig.json", "node_modules"]) {
        fs.symlinkSync(path.join(process.cwd(), item), path.join(release, item));
      }
      const worker = path.join(process.cwd(), "src/lib/pipelines/provisionToolchain.worker.ts");
      fs.writeFileSync(bundle, `
        import { existsSync, promises as fs } from "node:fs";
        const readdir = fs.readdir;
        fs.readdir = (dir, ...options) => dir === "/proc" && existsSync(${JSON.stringify(enumerationFault)})
          ? Promise.reject(Object.assign(new Error("fixture enumeration refused"), { code: "EACCES" }))
          : readdir(dir, ...options);
        await import(${JSON.stringify(worker)});
      `);
      supplier = await seedProvisioningPackage(repo, root, process.env, process.execPath, undefined, "fixture-private");
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "fixture inputs for the failed census");
      await git(repo, "push", "origin", "main");
      const lane = (await createPipelineFromRequest({ task: "Withhold installs on incomplete enumeration",
        repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      fs.writeFileSync(enumerationFault, "");
      const input = { lane: lane.id, launches, end, wallFile };
      const first = startFixtureController(input, release);
      controllers.push(first);
      const read = () => findControllerPipeline(lane.id);
      await waitForFixture(async () => (await read())?.provisioningJob?.step === "waitingForLegacyInstaller", "incomplete enumeration wait");
      const waiting = (await read())!.provisioningJob!;
      expect(waiting).toMatchObject({ status: "waiting", waitReason: "private-install-writer-live (enumeration)" });
      expect(waiting.deadlineAt - waiting.since).toBe(180_000);
      const peer = (await createPipelineFromRequest({ task: "Start an independent lane during the incomplete census",
        repoDir: repo, baseRef: base, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      await waitForFixture(() => fixtureLaunchCount(launches, peer.worktreeDir) === 1, "peer first child");
      const assertNoInstall = () => {
        expect(fixtureLaunchCount(launches, lane.worktreeDir)).toBe(0);
        expect(fs.existsSync(path.join(lane.worktreeDir, "node_modules"))).toBe(false);
        expect(fs.readdirSync(lane.worktreeDir).some(file => file.startsWith(".delegatus-dependencies-"))).toBe(false);
      };
      assertNoInstall();
      await first.stop("SIGKILL");
      setWall(waiting.since + 179_999);
      const second = startFixtureController(input, release);
      controllers.push(second);
      await waitForFixture(async () => {
        const current = (await read())?.provisioningJob;
        return current?.status === "waiting" && current.token !== waiting.token;
      }, "re-observation after restart");
      expect((await read())?.provisioningJob).toMatchObject({ since: waiting.since, deadlineAt: waiting.deadlineAt });
      assertNoInstall();
      if (outcome === "recovers") fs.unlinkSync(enumerationFault);
      setWall(waiting.deadlineAt);
      if (outcome === "recovers") {
        expect(await second.child.exited, await second.output).toBe(0);
        expect(fixtureLaunchCount(launches, lane.worktreeDir)).toBe(1);
        expect((await read())?.runs[0]?.attempts).toHaveLength(1);
      } else {
        await waitForFixture(async () => (await read())?.state === "needs_decision", "incomplete census park");
        expect((await read())?.stateDetail).toBe("private-install-writer-live (enumeration)");
        expect((await read())?.provisioningJob?.since).toBe(waiting.since);
        assertNoInstall();
      }
    } catch (error) {
      fs.writeFileSync(end, "");
      const diagnostics = await Promise.all(controllers.map(async controller => {
        await controller.stop();
        return (await controller.output).split("\n").slice(-20).join("\n");
      }));
      throw new Error(`${String(error)}\n${diagnostics.join("\n")}`);
    } finally {
      fs.writeFileSync(end, "");
      for (const controller of controllers) await controller.stop();
      await supplier?.();
      await removeProvisioningFixture(root);
    }
  }), 30_000);

test.skipIf(process.platform !== "linux")("a successor does not renew a live foreign claim after a wall-clock step", () =>
  withControllerAuditState(async () => {
    const { h, repo, root } = await realWorktreeLane("foreign-provisioning-clock", BUILD_ONLY as never);
    const { captureProcessIdentity } = await import("@/lib/processIdentity");
    const { provisioningSubject, settleProvisioningJobsForTests } = await import("./provisioningJob");
    const owner = Bun.spawn([process.execPath, "--no-env-file", "-e", "await Bun.sleep(30_000)"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 30_000,
    });
    let now = Date.parse("2026-11-24T10:00:00Z"), monotonic = 0;
    const timers = new Set<{ at: number; run: () => void }>();
    const advance = (target: number) => {
      monotonic = target;
      for (const timer of [...timers]) if (timer.at <= monotonic) {
        timers.delete(timer);
        timer.run();
      }
    };
    try {
      delete h.ports.provisionExec;
      h.ports.now = () => new Date(now).toISOString();
      h.ports.provisionClock = {
        wallMs: () => now, monotonicMs: () => monotonic,
        arm(delay, run) {
          const timer = { at: monotonic + delay, run };
          timers.add(timer);
          return () => { timers.delete(timer); };
        },
      };
      const lane = (await createPipelineFromRequest({ task: "Recover a foreign claim with a stepped clock",
        repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      const originalStart = now + 60_000, originalDeadline = originalStart + 10_000;
      const token = "foreign-clock-fixture";
      const identity = captureProcessIdentity(owner.pid);
      expect(identity.startIdentity).toBeTruthy();
      expect(identity.bootEpoch).toBeTruthy();
      await withPipelineMutation(async (rows, persist) => {
        const current = rows.find(row => row.id === lane.id)!;
        current.provisioningJob = {
          version: 1, kind: "provision", subject: provisioningSubject(current), planSubject: "b".repeat(64),
          generation: 1, token, owner: { ...identity, instance: "earlier-controller", release: "unversioned" },
          since: originalStart, deadlineAt: originalDeadline, executionDeadlineAt: originalStart + 360_000,
          status: "running", step: "checkingDependencies",
        };
        await persist([current]);
      });
      await driveProvisioning(h.ports, async () => [...timers].some(timer => timer.at === 10_000));
      now -= 120_000;
      advance(9_999);
      await tickPipelinesController([], h.ports);
      expect((await findControllerPipeline(lane.id))?.provisioningJob?.token).toBe(token);
      expect(owner.exitCode).toBeNull();
      advance(10_000);
      await tickPipelinesController([], h.ports);
      const expired = (await findControllerPipeline(lane.id))!;
      expect(expired.provisioningJob).toMatchObject({ status: "waiting", retryAt: now + 5_000,
        interruption: { step: "checkingDependencies", since: originalStart, deadlineAt: originalDeadline, reason: "provision-step-timeout" } });
      expect(expired.runs[0]?.attempts).toHaveLength(0);
      now = expired.provisioningJob!.retryAt!;
      advance(15_000);
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.runs[0]?.attempts[0]?.state === "running");
      const recovered = (await findControllerPipeline(lane.id))!;
      expect(recovered.lastProvisioningInterruption).toMatchObject({
        step: "checkingDependencies", since: originalStart, deadlineAt: originalDeadline, reason: "provision-step-timeout",
      });
      expect(recovered.runs[0]?.attempts).toHaveLength(1);
      expect(owner.exitCode).toBeNull();
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill();
      await owner.exited;
      await settleProvisioningJobsForTests();
      await settlePipelineControllerJobs();
      await settlePipelineStopReadLanes();
      await removeProvisioningFixture(root);
    }
  }), 24_000);

test.skipIf(process.platform !== "linux").each(["release before cutoff", "busy at cutoff"] as const)(
  "an unclaimed cache fence survives restart and observes %s",
  atCut => withControllerAuditState(async () => {
    const { h, git, repo, root } = await realWorktreeLane("foreign-cache-bound", BUILD_ONLY as never);
    const { settleProvisioningJobsForTests } = await import("./provisioningJob");
    const { patchPipeline } = await import("./engine");
    const fence = path.join(repo, ".git", "delegatus-dependencies", "v4", "owner.lock");
    const wallFile = path.join(root, "successor-clock"), end = path.join(root, "successor-end");
    const launches = path.join(root, "first-children");
    let supply: (() => Promise<void>) | undefined;
    let holder: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">> | undefined;
    let successor: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
    let output: Promise<string[]> | undefined;
    let now = Date.now();
    const probe = () => Bun.spawnSync(["flock", "-n", fence, "true"]).exitCode;
    try {
      supply = await seedProvisioningPackage(repo, root, process.env, process.execPath);
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "fixture inputs for cache custody");
      await git(repo, "push", "origin", "main");
      fs.mkdirSync(path.dirname(fence), { recursive: true });
      holder = Bun.spawn(["flock", "-n", fence, "sh", "-c", 'printf "locked\\n"; read -r release'], {
        stdin: "pipe", stdout: "pipe", stderr: "ignore", timeout: 24_000,
      });
      const reader = holder.stdout.getReader();
      try {
        await until(reader.read().then(frame => expect(new TextDecoder().decode(frame.value)).toBe("locked\n")));
      } finally { reader.releaseLock(); }
      delete h.ports.provisionExec;
      h.ports.now = () => new Date(now).toISOString();
      const lane = (await createPipelineFromRequest({ task: "Observe the unclaimed dependency fence across restart",
        repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.provisioningJob?.step === "waitingForCache");
      const before = (await findControllerPipeline(lane.id))!.provisioningJob!;
      expect(before.waitReason).toBe("cache-holder-unclaimed");
      expect(before.deadlineAt - before.since).toBe(180_000);
      const inode = fs.statSync(lane.worktreeDir, { bigint: true }).ino;
      await settleProvisioningJobsForTests();
      const halfway = before.since + 90_000;
      fs.writeFileSync(wallFile, new Date(halfway).toISOString());
      successor = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "fixtures", "provisionControllerProcess.ts")], {
        env: { ...process.env, LLV_PROVISION_PROCESS_FIXTURE: JSON.stringify({
          lane: lane.id, state: process.env.LLV_STATE_DIR, launches, end, wallFile,
        }) }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 18_000,
      });
      output = Promise.all([new Response(successor.stdout).text(), new Response(successor.stderr).text()]);
      const stop = performance.now() + 7_000;
      for (;;) {
        const current = (await findControllerPipeline(lane.id))?.provisioningJob;
        if (current?.step === "waitingForCache" && current.retryAt === halfway + 5_000) {
          expect(current).toMatchObject({ since: before.since, deadlineAt: before.deadlineAt, cacheWaitIdentity: before.cacheWaitIdentity });
          break;
        }
        if (performance.now() >= stop) throw new Error("successor did not persist a new probe with the old cache cutoff");
        await Bun.sleep(15);
      }
      expect(probe()).toBe(1);
      expect(fs.existsSync(launches)).toBe(false);
      fs.writeFileSync(end, "");
      const exit = await successor.exited;
      expect(exit, (await output).join("\n")).toBe(0);
      const early = atCut === "release before cutoff";
      now = before.deadlineAt - (early ? 1 : 0);
      if (!early) {
        await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.state === "needs_decision");
        const parked = (await findControllerPipeline(lane.id))!;
        expect(parked.provisioningJob).toMatchObject({
          step: "waitingForCache", since: before.since, deadlineAt: before.deadlineAt, status: "parked", waitReason: "cache-holder-unclaimed",
        });
        expect(parked.runs[0]?.attempts).toHaveLength(0);
        expect(probe()).toBe(1);
      }
      holder.stdin.write("release\n");
      holder.stdin.end();
      expect(await holder.exited).toBe(0);
      if (!early) {
        const retry = await patchPipeline(lane.id, { action: "retry-stage" }, h.ports);
        expect(retry.pipeline?.state).toBe("provisioning");
      }
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.runs[0]?.attempts[0]?.state === "running");
      expect(fs.statSync(lane.worktreeDir, { bigint: true }).ino).toBe(inode);
      expect((await findControllerPipeline(lane.id))?.runs[0]?.attempts).toHaveLength(1);
    } finally {
      fs.writeFileSync(end, "");
      if (holder && holder.exitCode === null && holder.signalCode === null) {
        holder.stdin.write("release\n");
        holder.stdin.end();
      }
      await holder?.exited;
      await successor?.exited;
      await output;
      await settleProvisioningJobsForTests();
      await supply?.();
      await settlePipelineControllerJobs();
      await settlePipelineStopReadLanes();
      await removeProvisioningFixture(root);
    }
  }), 34_000);

test.skipIf(process.platform !== "linux").each(["missing guardian", "early EOF"] as const)(
  "the source supervisor recovers from %s before the toolchain ready frame",
  fault => withControllerAuditState(async () => {
    const { h, repo, root } = await realWorktreeLane("toolchain-start-fault", BUILD_ONLY as never);
    const { settleProvisioningJobsForTests } = await import("./provisioningJob");
    const previousGuardian = process.env.LLV_HELPER_LEASE_ENTRY;
    const guardian = path.join(root, "fixture-guardian.mjs");
    let wall = Date.now();
    let attempts = 0;
    try {
      // The configuration is private to this fixture. The real supervisor
      // resolves and starts the configured guardian through its normal path.
      if (fault === "early EOF") fs.writeFileSync(guardian, "process.exit(0);\n");
      process.env.LLV_HELPER_LEASE_ENTRY = guardian;
      delete h.ports.provisionExec;
      h.ports.now = () => new Date(wall).toISOString();
      h.ports.provisionToolchainReply = async (_id, type) => { if (type === "dispatch") attempts++; };
      const lane = (await createPipelineFromRequest({ task: "Retry the source toolchain after a launch fault",
        repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.provisioningJob?.status === "waiting");
      const waiting = (await findControllerPipeline(lane.id))!;
      expect(waiting.provisioningJob?.interruption).toMatchObject({ step: "startingToolchain", reason: "toolchain-start-failed" });
      expect(waiting.runs[0]?.attempts).toHaveLength(0);
      expect(attempts).toBe(0);
      const inode = fs.statSync(lane.worktreeDir, { bigint: true }).ino;
      if (previousGuardian === undefined) delete process.env.LLV_HELPER_LEASE_ENTRY;
      else process.env.LLV_HELPER_LEASE_ENTRY = previousGuardian;
      wall = waiting.provisioningJob!.retryAt!;
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.runs[0]?.attempts[0]?.state === "running");
      expect((await findControllerPipeline(lane.id))?.runs[0]?.attempts).toHaveLength(1);
      expect(fs.statSync(lane.worktreeDir, { bigint: true }).ino).toBe(inode);
    } finally {
      if (previousGuardian === undefined) delete process.env.LLV_HELPER_LEASE_ENTRY;
      else process.env.LLV_HELPER_LEASE_ENTRY = previousGuardian;
      await settleProvisioningJobsForTests();
      await settlePipelineControllerJobs();
      await settlePipelineStopReadLanes();
      await removeProvisioningFixture(root);
    }
  }), 20_000);

test.skipIf(process.platform !== "linux").each(["step permit", "committed go"] as const)(
  "cross-process close orders against a withheld %s",
  heldFrame => withControllerAuditState(async () => {
    const { h, git, repo, root } = await realWorktreeLane("close-provisioning-permit", BUILD_ONLY as never);
    const { settleProvisioningJobsForTests } = await import("./provisioningJob");
    const { processIdentityStatus } = await import("@/lib/processIdentity");
    const held = latch(), release = latch();
    const nativeInterval = setInterval;
    // Hold the control poll so only keyed dispatch can refuse the stale permit.
    const holdControlPoll = ((...args: Parameters<typeof nativeInterval>) => {
      const [callback, delay, ...rest] = args;
      return nativeInterval(callback, delay === 50 ? 30_000 : delay, ...rest);
    }) as typeof setInterval;
    const poll = spyOn(globalThis, "setInterval").mockImplementation(holdControlPoll);
    let supplier: (() => Promise<void>) | undefined;
    let control: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
    const admitted: string[] = [];
    const refused: string[] = [];
    try {
      supplier = await seedProvisioningPackage(repo, root, process.env, process.execPath);
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "fixture inputs for dispatch ordering");
      await git(repo, "push", "origin", "main");
      delete h.ports.provisionExec;
      h.ports.now = () => new Date().toISOString();
      const lane = (await createPipelineFromRequest({ task: "Close while dependency preparation waits for permission",
        repoDir: repo, publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
      let waiting = false;
      h.ports.provisionToolchainReply = async (id, type, detail) => {
        if (id !== lane.id) return;
        if (type === "dispatch" && detail) admitted.push(detail);
        if (type === "stop" && detail) refused.push(detail);
        const barrier = heldFrame === "step permit" ? type === "step" && detail === "checkingDependencies"
          : type === "dispatch" && detail === "open-cache";
        if (barrier) { waiting = true; held.resolve(); await release.promise; }
      };
      await driveProvisioning(h.ports, async () => waiting);
      await until(held.promise);
      const before = (await findControllerPipeline(lane.id))!.provisioningJob!;
      expect(before.worker).toBeDefined();
      expect(before.effect?.name === "open-cache").toBe(heldFrame === "committed go");
      const cache = path.join(repo, ".git", "delegatus-dependencies");
      expect(fs.existsSync(cache)).toBe(false);
      control = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "fixtures", "provisionControllerProcess.ts")], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 4_000,
        env: { ...process.env, LLV_PROVISION_PROCESS_FIXTURE: JSON.stringify({
          lane: lane.id, state: process.env.LLV_STATE_DIR, pauseAndClose: true,
        }) },
      });
      const [code, stdout, stderr] = await Promise.all([control.exited, new Response(control.stdout).text(), new Response(control.stderr).text()]);
      expect(code, stdout + stderr).toBe(0);
      const closed = (await findControllerPipeline(lane.id))!;
      expect(closed.state).toBe("closed");
      expect(closed.provisioningJob?.token).toBe(before.token);
      release.resolve();
      const end = performance.now() + 5_000;
      while (processIdentityStatus(before.worker!) !== "dead") {
        if (performance.now() >= end) throw new Error("the closed lane kept its worker after the reply was delivered");
        await Bun.sleep(15);
      }
      expect(admitted).toEqual(heldFrame === "committed go" ? ["open-cache"] : []);
      expect(refused).toEqual(heldFrame === "step permit" ? ["open-cache"] : []);
      expect(fs.existsSync(cache)).toBe(heldFrame === "committed go");
      expect(fs.existsSync(path.join(lane.worktreeDir, "node_modules"))).toBe(false);
      await driveProvisioning(h.ports, async () => (await findControllerPipeline(lane.id))?.provisioningJob === undefined);
      const final = (await findControllerPipeline(lane.id))!;
      expect(final.state).toBe("closed");
      expect(final.runs[0]?.attempts).toHaveLength(0);
    } finally {
      release.resolve();
      poll.mockRestore();
      if (control && control.exitCode === null && control.signalCode === null) control.kill();
      await control?.exited;
      await settleProvisioningJobsForTests();
      await supplier?.();
      await settlePipelineControllerJobs();
      await settlePipelineStopReadLanes();
      await removeProvisioningFixture(root);
    }
  }), 23_000);
