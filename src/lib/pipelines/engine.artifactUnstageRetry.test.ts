import { createPipelineFromRequest, expect, finishReported, fs, loadPipelines, path, realExec, realWorktreeLane, test } from "./engine.fixture";
import { patchPipeline, reportStageCompletion } from "./engine";
import { tickPipelinesController } from "./controllerPass";
import { settlePipelineControllerJobs } from "./controllerJobs";
import { settlePendingStageProvenance } from "./stageProvenance";
import { takeoverPipelineDelivery, withPipelineMutation } from "./store";

const retry = { action: "retry-stage", expectedStageId: "merge", expectedAttempt: 5 } as const;

async function parkedPass() {
  const box = await realWorktreeLane("artifact-unstage", [
    { id: "merge", kind: "run", role: { roleId: "builder" }, prompt: "Integrate", next: "audit" },
    { id: "audit", kind: "run", role: { roleId: "reviewer" }, prompt: "Audit {{prev.output}}", next: null },
  ], "remote-branch");
  const current = () => loadPipelines().find(row => row.id === box.id)!;
  const attempt = () => current().runs[0]!.attempts[4]!;
  const { h, git, worktree } = box;
  const launch = current().runs[0]!.attempts[0]!;
  const now = h.ports.now();
  h.ports.now = () => now;
  h.setConversationActive(false);
  await withPipelineMutation(async (rows, persist) => {
    const lane = rows.find(row => row.id === box.id)!;
    lane.runs[0]!.attempts = [
      ...[1, 2, 3, 4].map(n => ({ ...launch, n, state: "failed" as const, launchId: null,
        conversationId: null, agentPath: null, paneId: null, completedAt: now, accounting: undefined })),
      { ...launch, n: 5, accounting: undefined },
    ];
    await persist([lane]);
  });
  fs.writeFileSync(path.join(worktree, "integration.txt"), "Integrated change\n");
  await git(worktree, "add", "integration.txt");
  await git(worktree, "commit", "-m", "Integrate verified change");
  const sha = await git(worktree, "rev-parse", "HEAD");
  const lock = await git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "index.lock");
  const descriptor = fs.openSync(lock, "wx");
  const release = () => {
    if (!fs.existsSync(lock)) return;
    expect(fs.statSync(lock).ino).toBe(fs.fstatSync(descriptor).ino);
    fs.unlinkSync(lock);
  };
  const cleanup = async () => {
    await settlePipelineControllerJobs();
    fs.closeSync(descriptor);
    fs.rmSync(box.root, { recursive: true, force: true });
  };
  try {
    const report = await reportStageCompletion({ verdict: "pass", summary: "Integration checks passed" },
      { kind: "agent", role: "builder", conversationId: launch.conversationId! }, h.ports);
    expect(report.error).toBeUndefined();
    await settlePendingStageProvenance(h.ports);
    const saved = structuredClone(attempt().report!);
    expect(saved.provenance).toMatchObject({ head: sha, branch: current().branch, uncommitted: [] });
    const execute = h.ports.exec;
    let pushes = 0;
    h.ports.exec = (...args) => {
      if (args[0] === "git" && args[1][0] === "push") pushes++;
      return execute(...args);
    };
    const drive = async (entries: Parameters<typeof tickPipelinesController>[0] = []) => {
      await tickPipelinesController(entries, h.ports);
      await settlePipelineControllerJobs();
    };
    await drive([finishReported(h, "/codex/stage-1.jsonl", "pass", "Verified integration")]);
    const parked = current();
    expect(parked.state).toBe("needs_decision");
    expect(parked.cursor).toMatchObject({ stageId: "merge", state: "committing" });
    expect(attempt().error).toMatch(/^unstaging controller pipeline artifacts:[\s\S]*index\.lock/);
    expect(attempt().report).toEqual(saved);
    expect(parked.delivery!.operation).toBeUndefined();
    return { ...box, current, attempt, saved, sha, lock, descriptor, release, cleanup, drive, pushes: () => pushes };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test("retry-stage settles a saved fifth pass through the index lock and controller restart", async () => {
  const box = await parkedPass();
  const { h, git, worktree, origin, sha, current, attempt, saved } = box;
  const target = current().delivery!.target.branch;
  const checkPreserved = async () => {
    expect(current().runs[0]!.attempts).toHaveLength(5);
    expect(attempt().report).toEqual(saved);
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(sha);
  };
  try {
    // Persist the old writer's diagnostic and provenance shape.
    await withPipelineMutation(async (rows, persist) => {
      const lane = rows.find(row => row.id === box.id)!;
      const stage = lane.runs[0]!.attempts[4]!;
      stage.error = stage.error!.split("\nAfter the index is available")[0]!;
      lane.stateDetail = stage.error;
      delete stage.report!.provenance.state;
      await persist([lane]);
    });
    delete saved.provenance.state;
    const admitted = await patchPipeline(box.id, retry, h.ports);
    expect(admitted.error).toBeUndefined();
    expect(admitted.pipeline?.cursor).toMatchObject({ stageId: "merge", state: "committing" });
    expect(admitted.pipeline?.runs[0]!.attempts[4]!.state).toBe("committing");
    await box.drive();
    expect(current().state).toBe("needs_decision");
    expect(attempt().error).toMatch(/^unstaging controller pipeline artifacts:[\s\S]*index\.lock/);
    expect(fs.statSync(box.lock).ino).toBe(fs.fstatSync(box.descriptor).ino);
    await checkPreserved();
    expect(await git(origin, "for-each-ref", "--format=%(refname)", target)).toBe("");
    expect(box.pushes()).toBe(0);
    expect(h.spawnInputs).toHaveLength(1);

    box.release();
    expect((await patchPipeline(box.id, retry, h.ports)).error).toBeUndefined();
    expect((await patchPipeline(box.id, retry, h.ports)).status).toBe(409);
    // Start a fresh process with the admitted intent already on disk.
    const restarted = await realExec(process.execPath, ["-e", `
      import { defaultPipelinePorts, settlePendingStageGit } from "./src/lib/pipelines/engine.ts";
      import { registerPipelineTick } from "./src/lib/pipelines/controllerSignal.ts";
      registerPipelineTick(async () => {});
      await settlePendingStageGit({
        ...defaultPipelinePorts(), now: () => ${JSON.stringify(h.ports.now())},
        scheduleTick: () => {}, spawnAgent: async () => { throw new Error("unexpected launch"); },
      });
    `], process.cwd(), process.env, { timeoutMs: 20_000 });
    expect(restarted.code, restarted.stderr).toBe(0);
    expect(current().delivery?.operation).toMatchObject({ state: "pending", sha, requestKey: "pass:merge:5" });
    await checkPreserved();
    for (let n = 0; n < 4; n++) await box.drive();
    const published = current();
    expect(published.delivery?.operation).toMatchObject({
      state: "settled", sha, requestKey: "pass:merge:5", result: { ok: true, sha, remote: "published" },
    });
    expect(await git(box.repo, "ls-remote", "--refs", origin, target)).toBe(`${sha}\t${target}`);
    expect(published.lastPassedCommit).toBe(sha);
    expect(published.publishedCommit).toBe(sha);
    expect(published.cursor?.stageId).toBe("audit");
    expect(h.spawnInputs.map(input => input.membership.stageId)).toEqual(["merge", "audit"]);
    expect(h.spawnInputs[1]!.prompt).toContain("Integration checks passed");
    expect((await patchPipeline(box.id, retry, h.ports)).status).toBe(409);
    await box.drive();
    await checkPreserved();
    expect(current().delivery?.operation).toEqual(published.delivery?.operation);
    expect(h.spawnInputs).toHaveLength(2);
    expect(box.pushes()).toBe(1);
  } finally { await box.cleanup(); }
}, 30_000);

test.each(["report", "head", "owner", "publication", "head race", "pause"] as const)(
  "artifact cleanup retry holds the pass when %s evidence conflicts", async conflict => {
    const box = await parkedPass();
    const { current, attempt, h, git, worktree } = box;
    const delivery = current().delivery!;
    try {
      box.release();
      if (conflict === "owner") {
        const peer = await createPipelineFromRequest({ task: "Peer delivery", repoDir: box.repo, autoStart: false,
          stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }],
          publication: "remote-branch", delivery: { branch: delivery.target.branch } }, h.ports);
        expect(peer.error).toBeUndefined();
        expect((await takeoverPipelineDelivery(peer.pipeline!.id, box.id, delivery.epoch, "Fixture transfer", null)).error).toBeUndefined();
      } else if (conflict === "pause") {
        expect((await patchPipeline(box.id, { action: "pause", reason: "Fixture hold" }, h.ports)).error).toBeUndefined();
      } else if (conflict === "report" || conflict === "publication") {
        await withPipelineMutation(async (rows, persist) => {
          const row = rows.find(lane => lane.id === box.id)!;
          if (conflict === "report") row.runs[0]!.attempts[4]!.report!.actor = { kind: "operator" };
          else row.delivery!.operation = { id: "fixture-operation", epoch: delivery.epoch, sha: box.sha,
            requestKey: "pass:merge:5", state: "pending" };
          await persist([row]);
        });
        if (conflict === "report") expect(attempt().report!.actor).toEqual({ kind: "operator" });
        else expect(current().delivery!.operation?.state).toBe("pending");
      }
      const moved = async () => await git(worktree, "reset", "--hard", box.base);
      if (conflict === "head") await moved();
      const beforeRetry = current();
      const result = await patchPipeline(box.id, retry, h.ports);
      const refusal = { report: "matching saved pass report", owner: "explicit takeover",
        publication: "another publication owns settlement", head: "differs from the saved pass report",
        "head race": "differs from the saved pass report", pause: "paused" }[conflict];
      if (conflict === "head" || conflict === "head race") {
        expect(result.error).toBeUndefined();
        const execute = h.ports.exec;
        let raced = false;
        h.ports.exec = async (...args) => {
          const value = await execute(...args);
          if (conflict === "head race" && !raced && args[0] === "git" && args[1][0] === "reset"
            && args[1][2] === box.sha) {
            raced = true;
            await moved();
          }
          return value;
        };
        await box.drive();
        if (conflict === "head race") expect(raced).toBe(true);
        expect(current().state).toBe("needs_decision");
        expect(attempt().error).toContain(refusal);
        expect((await patchPipeline(box.id, retry, h.ports)).error).toBeUndefined();
        await box.drive();
        expect(attempt().error).toContain(refusal);
      } else {
        expect(result.status).toBe(409);
        expect(result.error).toContain(refusal);
        expect(current()).toEqual(beforeRetry);
      }
      expect(current().cursor).toMatchObject({ stageId: "merge", state: "committing" });
      expect(current().runs[0]!.attempts).toHaveLength(5);
      expect(h.spawnInputs).toHaveLength(1);
      expect(box.pushes()).toBe(0);
      expect(await git(box.origin, "for-each-ref", "--format=%(refname)", delivery.target.branch)).toBe("");
    } finally { await box.cleanup(); }
  },
);
