import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openPublicationRepairFixtures } from "./stagePublicationRepair.fixture";

const { close, fixture, reviewedFixture, defaultPipelinePorts, settlePendingStageGit, savePipelines, findPipelineRecord, realExec } = await openPublicationRepairFixtures();
afterAll(close);

test("the original stage Git binding survives a restart but a passed attempt cannot rehost it", async () => {
  const h = fixture();
  const { AgentRegistry } = await import("@/lib/agent/registry");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { prepareStageGitGuard } = await import("@/lib/git/stageAttemptGuard");
  const registryFile = path.join(h.root, "registry.json");
  const registry = new AgentRegistry(registryFile);
  try {
    const conversation = registry.ensureForkedConversation("codex", path.join(h.root, "producer.jsonl"), null, emptyLaunchProfile({ cwd: h.repo }));
    registry.rememberMembership(conversation.id, { kind: "pipeline", containerId: h.lane.id, stageId: "build", round: 1,
      role: "builder", slot: "build:1", stageOrder: 0, parentConversationId: null });
    const lane = h.current();
    Object.assign(lane.runs[0]!.attempts[0]!, { state: "running", launchId: "rehost-producer", conversationId: conversation.id });
    savePipelines([lane]);
    await prepareStageGitGuard("rehost-producer", h.repo, h.ports.exec, h.ports.now(), async () => {});
    registry.close();
    for (const stageState of ["running", "passed"] as const) {
      const lane = h.current(); lane.runs[0]!.attempts[0]!.state = stageState; savePipelines([lane]);
      const child = spawnSync(process.execPath, ["-e", `
        const { AgentRegistry } = await import("./src/lib/agent/registry");
        const { stageGitEnvironment } = await import("./src/lib/runtime/stageGitEnvironment");
        const registry = new AgentRegistry(${JSON.stringify(registryFile)});
        try {
          const env = await stageGitEnvironment(registry, ${JSON.stringify(conversation.id)}, "resume-operation", ${JSON.stringify(h.repo)});
          console.log(JSON.stringify({ restored: !!env.LLV_STAGE_GIT_RECEIPT }));
        } catch (error) { console.log(JSON.stringify({ error: error.message })); }
        finally { registry.close(); }
      `], { env: process.env, cwd: process.cwd(), encoding: "utf8", timeout: 20_000 });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual(stageState === "running" ? { restored: true }
        : { error: "stage Git rehost cannot prove its original attempt" });
    }
    expect(h.git("rev-parse", "HEAD")).toBe(h.accepted);
  } finally { registry.close(); h.cleanup(); }
});


test.each([false, true])("a dirty declined repair restores its accepted checkout before retry (declared outputs: %s)", async outputs => {
  const h = fixture();
  try {
    if (outputs) {
      const lane = h.current();
      lane.stages[0]!.outputs = ["src/work.ts", "repair.txt"];
      lane.stages[0]!.effectiveRole.access = "read-only";
      lane.runs[0]!.attempts[0]!.effectiveRole.access = "read-only";
      savePipelines([lane]);
    }
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    expect(h.requests).toHaveLength(1);
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    h.git("add", "src/work.ts");
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 3;\n");
    fs.writeFileSync(path.join(h.repo, "repair.txt"), "unfinished repair\n");
    fs.writeFileSync(path.join(h.repo, "scratch.txt"), "untracked repair\n");
    fs.writeFileSync(path.join(h.repo, "added.txt"), "staged repair\n");
    h.git("add", "added.txt");
    fs.writeFileSync(path.join(h.repo, ":(glob)*.txt"), "literal path\n");
    h.endTurn('```json\n{"status":"fail","blocked":true,"blockedReason":"outside the producer scope"}\n```');
    await settlePendingStageGit(h.ports);
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().stateDetail).toContain("outside the producer scope");
    expect(h.git("status", "--porcelain")).toBe("");
    expect(h.git("rev-parse", "HEAD")).toBe(h.accepted);
    expect(h.git("show", ":src/work.ts")).toBe("export const work = 1;");
    expect(fs.existsSync(path.join(h.repo, "repair.txt"))).toBe(false);
    fs.writeFileSync(h.hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const { patchPipeline } = await import("./engine");
    expect((await patchPipeline(h.lane.id, { action: "retry-stage" }, h.ports)).error).toBeUndefined();
    await h.tick();
    expect(h.current().state).toBe("completed");
    expect(h.current().publishedCommit).toBe(h.accepted);
    expect(h.requests).toHaveLength(1);
  } finally { h.cleanup(); }
});

test.each(["controller", "takeover"])("a superseded admission records no failed check or spent budget through %s and restart", async consumer => {
  const h = fixture();
  try {
    const lane = h.current();
    lane.delivery!.operation = { id: "superseded-admission", epoch: 1, sha: h.accepted, state: "pending",
      requestKey: "pass:build:1", passedStage: true };
    const { publishPipelineBranch, pipelinePublicationFence } = await import("./git");
    lane.delivery!.operation.fence = pipelinePublicationFence(lane);
    savePipelines([lane]);
    const { patchPipeline } = await import("./engine");
    expect((await patchPipeline(lane.id, { action: "pause", reason: "Suspend publication admission" }, h.ports)).error).toBeUndefined();
    const result = await publishPipelineBranch(h.current(), h.ports.exec, { acceptedSha: h.accepted, now: h.ports.now });
    expect(result).toMatchObject({ ok: false, outcome: "superseded" });
    expect(h.current().delivery!.operation!.result).toEqual(result);
    expect(h.pushes()).toBe(0);
    await settlePendingStageGit(h.ports);
    expect(h.current().state).toBe("paused");
    expect(h.current().delivery!.operation!.id).toBe("superseded-admission");
    let recordId = lane.id;
    if (consumer === "takeover") {
      const { buildPipeline, createPipelineWithDelivery, takeoverPipelineDelivery } = await import("./store");
      const successor = await createPipelineWithDelivery(buildPipeline({ id: "supersession-successor", task: "Continue publication",
        project: lane.project, repoDir: lane.repoDir, stages: lane.stages, srcPath: null, srcConversationId: null,
        now: h.ports.now(), state: "draft" }), lane.delivery!.target);
      expect((await takeoverPipelineDelivery(successor.id, lane.id, 1, "continue publication", null)).error).toBeUndefined();
      recordId = successor.id;
    } else {
      expect((await patchPipeline(lane.id, { action: "resume" }, h.ports)).error).toBeUndefined();
      await settlePendingStageGit(h.ports);
      expect(h.current().state).toBe("running");
      expect(h.current().delivery!.operation).toMatchObject({ state: "pending", sha: h.accepted });
      expect(h.current().delivery!.operation!.id).not.toBe("superseded-admission");
      expect(h.requests).toHaveLength(0);
      expect(h.current().runs[0]!.attempts[0]!.publicationRetry).toBeUndefined();
    }
    const recovery = findPipelineRecord(recordId)!.publicationRecovery![h.accepted]!;
    expect(recovery).toMatchObject({ failures: 0, totalAttempts: 0, history: [{ cause: "superseded", retryAt: null }] });
    const reopened = spawnSync(process.execPath, ["-e", `
      const { findPipelineRecord } = await import("./src/lib/pipelines/store");
      console.log(JSON.stringify(findPipelineRecord(${JSON.stringify(recordId)}).publicationRecovery));
    `], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30_000 });
    expect(reopened.status, reopened.stderr).toBe(0);
    expect(JSON.parse(reopened.stdout)).toEqual({ [h.accepted]: recovery });
    expect(h.pushes()).toBe(0);
  } finally { h.cleanup(); }
});


test.each(["restore", "partial restore", "clean", "partial clean"])("refused repair cleanup resumes its durable intent in a new controller after %s interruption", async boundary => {
  const h = fixture();
  try {
    if (boundary === "partial restore") {
      fs.writeFileSync(path.join(h.repo, "src/other.ts"), "export const other = 1;\n");
      h.git("add", "src/other.ts"); h.git("commit", "-q", "-m", "accepted second file");
      h.accepted = h.git("rev-parse", "HEAD");
      const lane = h.current(); lane.lastPassedCommit = h.accepted; savePipelines([lane]);
    }
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    h.git("add", "src/work.ts");
    if (boundary === "partial restore") {
      fs.writeFileSync(path.join(h.repo, "src/other.ts"), "export const other = 2;\n");
      h.git("add", "src/other.ts");
    }
    fs.writeFileSync(path.join(h.repo, "first.txt"), "first\n");
    fs.writeFileSync(path.join(h.repo, "second.txt"), "second\n");
    h.endTurn('```json\n{"status":"fail","blocked":true,"blockedReason":"cannot repair"}\n```');
    const originalExec = h.ports.exec;
    h.ports.exec = async (...args: Parameters<typeof realExec>) => {
      const rollback = h.current().runs[0]!.attempts[0]!.publicationRepair?.rollback;
      const mutation = args[0] === process.execPath && rollback?.phase === (boundary.includes("restore") ? "restore" : "clean");
      if (mutation) {
        if (boundary === "partial clean") fs.unlinkSync(path.join(h.repo, "first.txt"));
        if (boundary === "partial restore") h.git("restore", `--source=${h.accepted}`, "--staged", "--worktree", "--", "src/work.ts");
        return { code: 1, stdout: "", stderr: "fixture cleanup interrupted" };
      }
      return originalExec(...args);
    };
    await settlePendingStageGit(h.ports);
    const intent = h.current().runs[0]!.attempts[0]!.publicationRepair!.rollback!;
    expect(intent.phase).toBe(boundary.includes("restore") ? "restore" : "clean");
    expect(h.git("show", `${intent.tree}:second.txt`)).toBe("second");
    expect(h.git("show", `${intent.index}:src/work.ts`)).toBe("export const work = 2;");
    expect(h.current().state).toBe("running");
    expect(h.current().stateDetail).toContain("cannot repair");
    const restarted = spawnSync(process.execPath, ["-e", `
      const { findPipelineRecord, savePipelines } = await import("./src/lib/pipelines/store");
      const { defaultPipelinePorts, settlePendingStageGit } = await import("./src/lib/pipelines/engine");
      const lane = findPipelineRecord(${JSON.stringify(h.lane.id)});
      const ports: PipelinePorts = { ...defaultPipelinePorts(), now: () => "2026-10-11T04:04:00.000Z",
        scheduleTick: () => {}, conversationAgentActive: async () => false,
        publicationRepairProducerState: async () => "idle",
        conversationDeliveryOutstanding: () => false,
        durableTurnEvidence: async () => ({ turn: "terminal", message: { text: "declined", ts: Date.parse("2026-10-11T04:03:00.000Z") } }),
      };
      await settlePendingStageGit(ports);
      console.log(JSON.stringify(findPipelineRecord(lane.id).runs[0].attempts[0].publicationRepair));
    `], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30_000 });
    expect(restarted.status, restarted.stderr).toBe(0);
    const repair = JSON.parse(restarted.stdout);
    expect(repair.rollback.phase).toBe("done");
    expect(repair.outcome).toMatchObject({ status: "rejected", reason: expect.stringContaining("cannot repair") });
    expect(h.git("status", "--porcelain")).toBe("");
    expect(h.git("rev-parse", "HEAD")).toBe(h.accepted);
    expect(h.requests).toHaveLength(1);
    expect(h.pushes()).toBe(1);
  } finally { h.cleanup(); }
});

test.each(["active", "native active", "native blocked", "native unknown", "branch", "head", "files"])("refused repair cleanup preserves a concurrent %s change", async race => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    h.git("add", "src/work.ts");
    h.endTurn('```json\n{"status":"fail","blocked":true,"blockedReason":"cannot repair"}\n```');
    const originalExec = h.ports.exec;
    let changed = false, active = false;
    let native: "unknown" | "active" | "blocked" | "idle" = "idle";
    h.ports.conversationAgentActive = async () => active;
    h.ports.publicationRepairProducerState = async () => native;
    h.ports.exec = async (...args: Parameters<typeof realExec>) => {
      const result = await originalExec(...args);
      // Change the premise after the cleanup intent has reached storage.
      if (!changed && h.current().runs[0]!.attempts[0]!.publicationRepair?.rollback && args[1][0] === "write-tree") {
        changed = true;
        if (race === "active") { active = true; native = "unknown"; }
        else if (race === "native active") native = "active";
        else if (race === "native blocked") native = "blocked";
        else if (race === "native unknown") native = "unknown";
        else if (race === "branch") h.git("checkout", "-q", "-b", "foreign");
        else if (race === "head") h.git("commit", "-q", "-m", "concurrent work");
        else fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 4;\n");
      }
      return result;
    };
    await settlePendingStageGit(h.ports);
    expect(changed).toBe(true);
    expect(fs.readFileSync(path.join(h.repo, "src/work.ts"), "utf8")).toContain(race === "files" ? "work = 4" : "work = 2");
    expect(h.current().runs[0]!.attempts[0]!.publicationRepair!.rollback!.phase).not.toBe("done");
    if (race === "native unknown") {
      expect(await h.requests[0]!.continuationAllowed?.()).toBe(false);
      h.advance(30 * 60_000);
      await settlePendingStageGit(h.ports);
      expect(fs.readFileSync(path.join(h.repo, "src/work.ts"), "utf8")).toContain("work = 2");
      expect(h.current().state).toBe("running");
      native = "idle";
      await settlePendingStageGit(h.ports);
      expect(h.git("status", "--porcelain")).toBe("");
      expect(h.current().state).toBe("needs_decision");
      expect(h.current().stateDetail).toContain("cannot repair");
    }
    expect(h.requests).toHaveLength(1);
    expect(h.pushes()).toBe(1);
  } finally { h.cleanup(); }
});


test("refusal cleanup preserves ignored files and private controller handoffs", async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    const privateDir = path.join(h.repo, ".artifacts/pipeline-stage-inputs/private");
    fs.mkdirSync(privateDir, { recursive: true });
    fs.writeFileSync(path.join(privateDir, "context.txt"), "controller handoff\n");
    fs.appendFileSync(path.join(h.root, "repo/.git/info/exclude"), "\nignored.txt\n");
    fs.writeFileSync(path.join(h.repo, "ignored.txt"), "ignored context\n");
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    h.git("add", "src/work.ts");
    // The worktree matches HEAD while its index still holds a rejected change.
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 1;\n");
    h.endTurn('```json\n{"status":"fail","blocked":true,"blockedReason":"cannot repair"}\n```');
    await settlePendingStageGit(h.ports);
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().runs[0]!.attempts[0]!.publicationRepair!.rollback!.phase).toBe("done");
    expect(h.git("show", ":src/work.ts")).toBe("export const work = 1;");
    expect(fs.readFileSync(path.join(privateDir, "context.txt"), "utf8")).toBe("controller handoff\n");
    expect(fs.readFileSync(path.join(h.repo, "ignored.txt"), "utf8")).toBe("ignored context\n");
  } finally { h.cleanup(); }
});


test.each(["index", "untracked", "executor"])("cleanup preserves a concurrent %s edit after its last Git snapshot", async kind => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    h.git("add", "src/work.ts");
    fs.writeFileSync(path.join(h.repo, "repair.txt"), "original repair\n");
    h.endTurn('```json\n{"status":"fail","blocked":true,"blockedReason":"cannot repair"}\n```');
    const originalExec = h.ports.exec;
    let changed = false, indexReads = 0;
    h.ports.exec = async (...args: Parameters<typeof realExec>) => {
      if (!changed && kind === "executor" && args[0] === process.execPath) {
        changed = true;
        fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 4;\n");
        h.git("add", "src/work.ts");
        fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
      }
      const result = await originalExec(...args);
      const rollback = h.current().runs[0]!.attempts[0]!.publicationRepair?.rollback;
      if (!changed && rollback && !args[3]?.GIT_INDEX_FILE) {
        if (kind === "index" && rollback.phase === "restore" && args[1][0] === "write-tree" && ++indexReads === 2) {
          changed = true;
          fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 4;\n");
          h.git("add", "src/work.ts");
          fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
        } else if (kind === "untracked" && args[1][0] === "diff-tree") {
          changed = true;
          fs.writeFileSync(path.join(h.repo, "repair.txt"), "concurrent edit\n");
        }
      }
      return result;
    };
    await settlePendingStageGit(h.ports);
    expect(changed).toBe(true);
    if (kind !== "untracked") expect(h.git("show", ":src/work.ts")).toBe("export const work = 4;");
    else expect(fs.readFileSync(path.join(h.repo, "repair.txt"), "utf8")).toBe("concurrent edit\n");
    expect(h.git("rev-parse", "HEAD")).toBe(h.accepted);
    expect(h.current().stateDetail).toContain("cannot repair");
  } finally { h.cleanup(); }
});


test("a cleanup write deadline retains its snapshot and automatically recovers without a new repair turn", async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    h.git("add", "src/work.ts");
    h.endTurn('```json\n{"status":"fail","blocked":true,"blockedReason":"cannot repair"}\n```');
    const directory = path.join(h.root, "slow-git"); fs.mkdirSync(directory);
    const { shellQuote } = await import("@/lib/agent/cli");
    const delegatePath = process.env.PATH!;
    const delegateGit = Bun.which("git", { PATH: delegatePath })!;
    const entered = path.join(h.root, "cleanup-entered");
    // A launcher wrapper may search PATH again; delegate without this shim.
    fs.writeFileSync(path.join(directory, "git"), `#!/bin/sh\nif [ "$1" = restore ]; then touch "$CLEANUP_ENTERED"; exec sleep 30; fi\nPATH=${shellQuote(delegatePath)} exec ${shellQuote(delegateGit)} "$@"\n`, { mode: 0o700 });
    const originalExec = h.ports.exec;
    h.ports.exec = async (...args: Parameters<typeof realExec>) => originalExec(args[0], args[1], args[2],
      args[0] === process.execPath ? { ...args[3], PATH: `${directory}${path.delimiter}${process.env.PATH}`, CLEANUP_ENTERED: entered } : args[3], args[4]);
    await settlePendingStageGit(h.ports);
    expect(fs.existsSync(entered)).toBe(true);
    expect(h.current().state).toBe("running");
    expect(h.current().runs[0]!.attempts[0]!.publicationRepair!.rollback!.phase).toBe("restore");
    expect(h.git("show", ":src/work.ts")).toBe("export const work = 2;");
    h.ports.exec = originalExec;
    await settlePendingStageGit(h.ports);
    expect(h.current().state).toBe("needs_decision");
    expect(h.current().stateDetail).toContain("cannot repair");
    expect(h.git("status", "--porcelain")).toBe("");
    expect(h.requests).toHaveLength(1);
    expect(h.pushes()).toBe(1);
  } finally { h.cleanup(); }
});


test("repair cleanup keeps full-record reads bounded while revalidating its writes", async () => {
  const h = fixture();
  try {
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    h.git("add", "src/work.ts");
    h.endTurn('```json\n{"status":"fail","blocked":true,"blockedReason":"cannot repair"}\n```');
    const { spyOn } = await import("bun:test");
    const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
    const original = SqliteStateCollection.prototype.get;
    let reads = 0;
    const probe = spyOn(SqliteStateCollection.prototype, "get").mockImplementation(function (this: typeof SqliteStateCollection.prototype, key: string) {
      if (key === h.lane.id) reads++;
      return original.call(this, key);
    });
    try { await settlePendingStageGit(h.ports); }
    finally { probe.mockRestore(); }
    expect(h.current().state).toBe("needs_decision");
    expect(h.git("status", "--porcelain")).toBe("");
    expect(reads).toBeLessThan(20);
  } finally { h.cleanup(); }
});

test.each(["published", "uncertain", "declined"])("repair settlement retains publisher custody through restart (%s)", async outcome => {
  const h = fixture();
  let release: (() => void) | undefined, publisher: Promise<unknown> | undefined;
  try {
    reviewedFixture(h);
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    fs.writeFileSync(h.hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const { patchPipeline } = await import("./engine");
    expect((await patchPipeline(h.lane.id, { action: "publish" }, h.ports)).error).toBeUndefined();
    const { publishPipelineBranch, reconcilePipelinePublication } = await import("./git");
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    publisher = publishPipelineBranch(h.current(), async (...args: Parameters<typeof realExec>) => {
      if (args[0] === "git" && args[1][0] === "push") { entered(); await held; if (outcome === "uncertain") return { code: null, stdout: "", stderr: "interrupted push" }; }
      return h.ports.exec(...args);
    }, { acceptedSha: h.accepted, now: h.ports.now });
    await ready;
    const runningId = h.current().delivery!.operation!.id;
    expect(h.current().delivery!.operation!.state).toBe("running");
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    h.endTurn(outcome === "declined" ? '```json\n{"status":"fail","blocked":true,"blockedReason":"cannot repair"}\n```' : "repaired");
    await settlePendingStageGit(h.ports);
    expect(h.current().delivery!.operation!.id).toBe(runningId);
    expect(h.current().delivery!.operation!.state).toBe("running");
    expect(h.git("rev-parse", "HEAD")).toBe(h.accepted);
    const restart = () => spawnSync(process.execPath, ["-e", `
      const { defaultPipelinePorts, settlePendingStageGit } = await import("./src/lib/pipelines/engine");
      const { findPipelineRecord } = await import("./src/lib/pipelines/store");
      const ports = { ...defaultPipelinePorts(), now: () => "2026-10-11T04:04:00.000Z", scheduleTick: () => {},
        conversationAgentActive: async () => false, publicationRepairProducerState: async () => "idle",
        conversationDeliveryOutstanding: () => false };
      await settlePendingStageGit(ports);
      console.log(JSON.stringify(findPipelineRecord(${JSON.stringify(h.lane.id)}).delivery.operation));
    `], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30_000 });
    let reopened = restart();
    expect(reopened.status, reopened.stderr).toBe(0);
    expect(JSON.parse(reopened.stdout)).toMatchObject({ id: runningId, state: "running" });
    release!();
    const result = await publisher; publisher = undefined;
    expect(result).not.toMatchObject({ error: expect.stringContaining("reservation changed") });
    if (outcome === "uncertain") {
      expect(result).toMatchObject({ ok: true, uncertain: true });
      const receipt = h.current().delivery!.operation!.executor!.result;
      reopened = restart();
      expect(reopened.status, reopened.stderr).toBe(0);
      expect(JSON.parse(reopened.stdout)).toMatchObject({ id: runningId, state: "running", executor: { finished: true, result: receipt } });
      expect(h.git("rev-parse", "HEAD")).toBe(h.accepted);
      expect(await reconcilePipelinePublication(h.lane.id, 1, h.ports.exec, null)).toBeNull();
    } else expect(result).toMatchObject({ ok: true, remote: "published" });
    await settlePendingStageGit(h.ports);
    expect(h.git("status", "--porcelain")).toBe("");
    if (outcome === "declined") {
      expect(h.git("rev-parse", "HEAD")).toBe(h.accepted);
      expect(h.current().state).toBe("needs_decision");
    } else {
      expect(h.current().runs[1]!.attempts[0]!.publicationRepair).toMatchObject({ reviewRequired: true, committedSha: h.git("rev-parse", "HEAD") });
      expect(h.current().lastPassedCommit).not.toBe(h.accepted);
      const repaired = h.current().lastPassedCommit!;
      expect((await publishPipelineBranch(h.current(), h.ports.exec, { acceptedSha: repaired, now: h.ports.now })).ok).toBe(true);
      await settlePendingStageGit(h.ports);
      expect(h.current().cursor).toMatchObject({ stageId: "review", state: "pending" });
      expect(h.current().runs[1]!.attempts[0]!.reviewHeadSha).toBe(h.accepted);
    }
  } finally { release?.(); if (publisher) await publisher; h.cleanup(); }
});


test("a repair supersedes a pending replacement admission without spending its attempt budget", async () => {
  const h = fixture();
  try {
    reviewedFixture(h);
    fs.writeFileSync(h.hook, "#!/bin/sh\necho 'pre-push: privacy' >&2\nexit 1\n", { mode: 0o700 });
    await h.tick();
    const { patchPipeline } = await import("./engine");
    expect((await patchPipeline(h.lane.id, { action: "publish" }, h.ports)).error).toBeUndefined();
    const pending = h.current().delivery!.operation!;
    expect(pending.state).toBe("pending");
    fs.writeFileSync(path.join(h.repo, "src/work.ts"), "export const work = 2;\n");
    h.endTurn();
    await settlePendingStageGit(h.ports);
    expect(h.current().publicationRecovery![h.accepted]!.history).toContainEqual(expect.objectContaining({
      operationId: pending.id, cause: "superseded", retryAt: null }));
    expect(h.current().publicationRecovery![h.accepted]!.totalAttempts).toBe(1);
    expect(h.current().runs[1]!.attempts[0]!.publicationRepair!.reviewRequired).toBe(true);
    expect(h.pushes()).toBe(1);
  } finally { h.cleanup(); }
});
