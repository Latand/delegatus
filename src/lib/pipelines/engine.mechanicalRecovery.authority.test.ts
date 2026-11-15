import { expect, test, loadPipelines, savePipelines, realWorktreeLane, realExec, fs, path, engineModule } from "./engine.fixture";

import { tickPipelinesController } from "./controllerPass";
import { settlePipelineControllerJobs } from "./controllerJobs";

import { pipelineArtifactsDir } from "./store";

import { spyOn } from "bun:test";
import { restartedTick } from "./engine.mechanicalRecovery.fixture";

test.skipIf(process.platform === "win32").each(["settles", "exhausts", "invalid-receipt", "authority-exhausts",
  "authority-paused", "authority-peer", "authority-unreadable", "authority-note-failure"] as const)("real cancelled Git commits retain their retry cap across process restarts: %s", async outcome => {
  const authority = outcome.startsWith("authority-");
  const cancelMode = authority ? "commit-authority-cancel" : "commit-cancel";
  const refusedPark = ["authority-paused", "authority-peer", "authority-unreadable"].includes(outcome);
  const exhausted = outcome === "exhausts" || authority;
  const invalidReceipt = outcome === "invalid-receipt";
  const parked = exhausted && !refusedPark || invalidReceipt;
  savePipelines([]);
  const fixture = await realWorktreeLane("cancelled commit recovery", [{ id: "study", kind: "run",
    role: { roleId: "architect" }, access: "read-only", prompt: "Write the declared output",
    outputs: ["result.txt"], next: null }]);
  try {
    const lane = loadPipelines()[0]!;
    fs.writeFileSync(path.join(fixture.worktree, "result.txt"), "preserved result\n");
    fs.mkdirSync(path.join(fixture.repo, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(fixture.repo, ".git", "hooks", "pre-commit"),
      '#!/bin/sh\nprintf ready > "$(git rev-parse --git-common-dir)/mechanical-hook-ready"\nexec sleep 60\n', { mode: 0o755 });
    lane.cursor!.state = "committing";
    Object.assign(lane.runs[0]!.attempts[0]!, { state: "committing", verdict: { status: "pass" } });
    savePipelines([lane]);
    let now = Date.parse("2026-10-29T08:48:00.000Z");
    let receipt: string | undefined;
    const delays = invalidReceipt ? [30_000] : [30_000, 60_000, 120_000, 240_000];
    for (const [n, delay] of delays.entries()) {
      const retry = await restartedTick(new Date(now).toISOString(), cancelMode, fixture.repo, fixture.id);
      expect(retry.lane.state).toBe("running");
      expect(retry.lane.lastPassedCommit).toBe(lane.lastPassedCommit);
      expect(retry.lane.runs[0]!.attempts[0]!.stageCommitWait?.failures).toBe(n + 1);
      expect(retry.lane.runs[0]!.attempts[0]!.commitRepair).toBeUndefined();
      expect(retry.spawns).toHaveLength(0);
      const files = fs.readdirSync(pipelineArtifactsDir(lane.id)).filter(file => /^stage-commit-.*\.json$/.test(file));
      expect(files).toHaveLength(1);
      const nextReceipt = fs.readFileSync(path.join(pipelineArtifactsDir(lane.id), files[0]!), "utf8");
      receipt ??= nextReceipt;
      expect(nextReceipt).toBe(receipt);
      now += delay;
    }
    if (!exhausted) fs.writeFileSync(path.join(fixture.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const receiptPath = path.join(pipelineArtifactsDir(lane.id), fs.readdirSync(pipelineArtifactsDir(lane.id)).find(file => /^stage-commit-.*\.json$/.test(file))!);
    if (invalidReceipt) fs.writeFileSync(receiptPath, "{}\n");
    const finalMode = outcome === "authority-paused" ? "commit-authority-pause"
      : outcome === "authority-peer" ? "commit-authority-peer"
        : outcome === "authority-unreadable" ? "commit-authority-unreadable"
          : outcome === "authority-note-failure" ? "commit-authority-note" : exhausted ? cancelMode : "commit-free";
    const final = await restartedTick(new Date(now).toISOString(), finalMode, fixture.repo, fixture.id);
    expect(final.lane.state).toBe(outcome === "authority-paused" ? "paused" : refusedPark ? "running" : parked ? "needs_decision" : "completed");
    expect(final.lane.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
    if (exhausted && !refusedPark) {
      expect(final.lane.stateDetail).toContain("after 4 automatic retries");
      expect(final.lane.runs[0]!.attempts[0]!.stageCommitWait?.failures).toBe(5);
    }
    if (refusedPark) expect(final.lane.runs[0]!.attempts[0]!.stageCommitWait?.failures).toBe(4);
    if (invalidReceipt) {
      expect(final.lane.stateDetail).toContain("ownership receipt could not be verified");
      expect(fs.readFileSync(receiptPath, "utf8")).toBe("{}\n");
    }
    expect(await fixture.git(fixture.worktree, "rev-list", "--count", `${fixture.base}..HEAD`)).toBe(parked || refusedPark ? "0" : "1");
    fs.writeFileSync(path.join(fixture.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const after = await restartedTick(new Date(now + 24 * 60 * 60_000).toISOString(), "commit-free", fixture.repo, fixture.id);
    expect(after.lane.state).toBe(outcome === "authority-paused" ? "paused" : parked ? "needs_decision" : "completed");
    expect(after.spawns).toHaveLength(0);
    if (outcome === "authority-exhausts") {
      const manualAt = new Date(now + 24 * 60 * 60_000).toISOString();
      const ports = { ...fixture.h.ports, exec: realExec, now: () => manualAt };
      expect((await engineModule.patchPipeline(fixture.id, { action: "retry-stage" }, ports)).error).toBeUndefined();
      const resumed = await restartedTick(manualAt, "commit-manual", fixture.repo, fixture.id);
      expect(resumed.lane.state).toBe("completed");
      expect(resumed.lane.runs[0]!.attempts).toHaveLength(1);
      expect(resumed.spawns).toHaveLength(0);
      expect(fs.readFileSync(receiptPath, "utf8")).toBe(receipt!);
      expect(await fixture.git(fixture.worktree, "rev-list", "--count", `${fixture.base}..HEAD`)).toBe("1");
    }
    expect(await fixture.git(fixture.worktree, "rev-list", "--count", `${fixture.base}..HEAD`)).toBe(
      parked && outcome !== "authority-exhausts" || outcome === "authority-paused" ? "0" : "1");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
}, 240_000);

test.skipIf(process.platform === "win32")("the production authority signal cancels a real commit and retains its mechanical retry", async () => {
  const fixture = await realWorktreeLane("authority cancellation recovery", [{ id: "study", kind: "run",
    role: { roleId: "architect" }, access: "read-only", prompt: "Write the declared output",
    outputs: ["result.txt"], next: null }]);
  const { h } = fixture;
  const ownership = await import("./stageBranch");
  const buildReader = ownership.stageBranchOwnershipReader;
  let rejectNext = false, armed = false, rejected = 0, cancelled = 0;
  const readerSpy = spyOn(ownership, "stageBranchOwnershipReader").mockImplementation(id => {
    const reader = buildReader(id), read = reader.read;
    reader.read = async () => {
      if (id === fixture.id && rejectNext) { rejectNext = false; rejected++; throw new Error("authority read interrupted"); }
      return read();
    };
    return reader;
  });
  const cleanup = new AbortController();
  const watchdog = setTimeout(() => cleanup.abort(), 30_000);
  const root = path.join(fixture.repo, ".git");
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  const watcher = fs.watch(root, (_event, name) => {
    if (!armed && String(name) === "mechanical-hook-ready") { armed = true; rejectNext = true; }
  });
  try {
    const lane = loadPipelines()[0]!;
    let now = Date.parse(h.ports.now());
    h.ports.now = () => new Date(now).toISOString();
    fs.writeFileSync(path.join(fixture.worktree, "result.txt"), "preserved result\n");
    fs.writeFileSync(path.join(root, "hooks", "pre-commit"),
      '#!/bin/sh\nprintf ready > "$(git rev-parse --git-common-dir)/mechanical-hook-ready"\nexec sleep 60\n', { mode: 0o755 });
    lane.cursor!.state = "committing";
    Object.assign(lane.runs[0]!.attempts[0]!, { state: "committing", verdict: { status: "pass" } });
    savePipelines([lane]);
    h.ports.exec = async (command, args, cwd, env, options) => {
      const result = await realExec(command, args, cwd, env, { ...options,
        signal: options?.signal ? AbortSignal.any([options.signal, cleanup.signal]) : cleanup.signal });
      if (args[0] === "commit" && result.stderr === "command cancelled") {
        expect(options?.signal?.aborted).toBe(true);
        cancelled++;
      }
      return result;
    };
    await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
    expect(rejected).toBe(1);
    expect(cancelled).toBe(1);
    const waiting = loadPipelines()[0]!;
    expect(waiting.runs[0]!.attempts[0]!.stageCommitWait?.failures).toBe(1);
    expect(waiting.runs[0]!.attempts[0]!.commitRepair).toBeUndefined();
    expect(waiting.lastPassedCommit).toBe(lane.lastPassedCommit);
    fs.writeFileSync(path.join(root, "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    now += 30_000;
    await tickPipelinesController([], h.ports); await settlePipelineControllerJobs();
    expect(loadPipelines()[0]!.state).toBe("completed");
    expect(h.spawnInputs).toHaveLength(1);
    expect(await fixture.git(fixture.worktree, "rev-list", "--count", `${fixture.base}..HEAD`)).toBe("1");
  } finally {
    cleanup.abort(); clearTimeout(watchdog); watcher.close();
    await settlePipelineControllerJobs(); readerSpy.mockRestore();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}, 120_000);
