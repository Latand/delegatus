import { FlowPipelineController } from "./controller";
import { settlePipelineControllerJobs, startPipelineControllerJob } from "./controllerJobs";
import { tickPipelinesController } from "./controllerPass";
import { settlePipelineStopReadLanes } from "./controllerStopRead";
import { BUILD_ONLY, createPipelineFromRequest, expect, fs, path, realWorktreeLane, test } from "./engine.fixture";
import { latch, until, withControllerAuditState } from "./fixtures/ownedStageControl";
import { findControllerPipeline, withPipelineMutation } from "./store";
import { removeProvisioningFixture, seedProvisioningPackage } from "../../../scripts/verify-provisioning-release.mjs";

async function driveProvisioning(ports: Parameters<typeof tickPipelinesController>[1], done: () => Promise<boolean>) {
  const stop = performance.now() + 8_000;
  while (!await done()) {
    if (performance.now() >= stop) throw new Error("fixture did not converge");
    await tickPipelinesController([], ports);
    await Bun.sleep(20);
  }
}

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
      expect(await git(lane.worktreeDir, "rev-parse", "HEAD")).toBe(slot?.plan?.expectedHead);
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
linuxInstall.each(["unchanged", "replace-before-write"] as const)("the production checkout-relative install leaves a %s checkout safe", mode =>
  withControllerAuditState(async () => {
    const { h, git, repo, root } = await realWorktreeLane("relative-install-custody", BUILD_ONLY as never);
    let installs = 0, launches = 0;
    try {
      fs.mkdirSync(path.join(repo, "packages", "fixture"), { recursive: true });
      fs.writeFileSync(path.join(repo, "packages", "fixture", "package.json"), '{"name":"fixture-local","version":"1.0.0"}');
      fs.writeFileSync(path.join(repo, "package.json"), '{"name":"fixture-relative","dependencies":{"fixture-local":"file:./packages/fixture"}}');
      fs.appendFileSync(path.join(repo, ".gitignore"), "node_modules\n");
      const freeze = Bun.spawn([process.execPath, "--no-env-file", "install", "--lockfile-only", "--ignore-scripts"], {
        cwd: repo, stdout: "ignore", stderr: "pipe", timeout: 5_000,
      });
      const [code, error] = await Promise.all([freeze.exited, new Response(freeze.stderr).text()]);
      expect(code, error).toBe(0);
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "checkout relative fixture inputs");
      await git(repo, "push", "origin", "main");
      delete h.ports.provisionExec;
      h.ports.now = () => new Date().toISOString();
      const lane = (await createPipelineFromRequest({ task: "Install the checkout-relative fixture", repoDir: repo,
        publication: "internal", stages: BUILD_ONLY as never }, h.ports)).pipeline!;
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
      h.ports.provisionToolchainReply = async (id, type, effect) => {
        if (id !== lane.id || type !== "dispatch" || effect !== "install-in-place") return;
        installs++;
        if (mode === "unchanged") return;
        fs.renameSync(target, target + ".previous");
        fs.mkdirSync(path.join(target, "fixture-local"), { recursive: true });
        fs.writeFileSync(path.join(target, "fixture-local", "package.json"), "foreign bytes");
        foreignInode = fs.statSync(target, { bigint: true }).ino;
      };
      await driveProvisioning(h.ports, async () => {
        const row = await findControllerPipeline(lane.id);
        return row?.state === "needs_decision" || (launches === 1 && row?.runs[0]?.attempts[0]?.state === "running");
      });
      const row = (await findControllerPipeline(lane.id))!;
      const marker = path.join(target, ".delegatus-install-receipt.json");
      if (mode === "unchanged") {
        expect(row.state, row.stateDetail ?? "").toBe("running");
        expect(installs).toBe(1);
        expect(launches).toBe(1);
        expect(fs.existsSync(marker)).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(target, "fixture-local", "package.json"), "utf8")).name).toBe("fixture-local");
      } else {
        expect(row).toMatchObject({ state: "needs_decision", stateDetail: "private-install-unverified" });
        expect(installs).toBe(1);
        expect(launches).toBe(0);
        expect(fs.existsSync(marker)).toBe(false);
        expect(fs.statSync(target, { bigint: true }).ino).toBe(foreignInode);
        expect(fs.readFileSync(path.join(target, "fixture-local", "package.json"), "utf8")).toBe("foreign bytes");
      }
    } finally {
      await (await import("./provisioningJob")).settleProvisioningJobsForTests();
      await settlePipelineControllerJobs();
      await settlePipelineStopReadLanes();
      await removeProvisioningFixture(root);
    }
  }), 18_000);

const legacyTree = process.env.LLV_PROVISION_LEGACY_TREE;
test.skipIf(!legacyTree)("pre-v1 reads the committed plan after origin moves and the forward release retires its slot", () =>
  withControllerAuditState(async () => {
    const { h, git, repo, root } = await realWorktreeLane("legacy-plan-readback", BUILD_ONLY as never);
    const { settleProvisioningJobsForTests } = await import("./provisioningJob");
    const held = latch(), release = latch();
    let predecessor: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
    try {
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
