import { expect, test, fs, path, Database, loadPipelines, realWorktreeLane, finishReported, createPipelineFromRequest } from "./engine.fixture";
import { spyOn } from "bun:test";
import * as stateStore from "@/lib/state/sqliteStateStore";
import { isStoredPipeline } from "./store";
import { settlePendingStageGit } from "./engine";
import { tickPipelinesController } from "./controllerPass";
import { settlePipelineControllerJobs, startPipelineControllerJob, PIPELINE_CONTROLLER_MAX_JOBS } from "./controllerJobs";
import { takeoverPipelineDelivery } from "./store";
import { withoutControllerPipelineScope } from "./controllerScope";

test("a peer delivery takeover after a failed push cannot stall the preserved pass", async () => {
  const box = await realWorktreeLane("passed-stage-delivery", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "audit" },
    { id: "audit", kind: "run", role: { roleId: "reviewer" }, prompt: "Audit", next: null },
  ], "remote-branch");
  const current = () => loadPipelines().find(row => row.id === box.id)!;
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const execute = box.h.ports.exec;
  let pushes = 0, transfers = 0;
  let peerId: string | undefined;
  box.h.ports.exec = async (...args) => {
    const [command, argv, cwd, , options] = args;
    if (command === "git" && argv[0] === "push" && cwd === box.worktree && ++pushes === 1) {
      return { code: 1, stdout: "", stderr: "pre-push: privacy\nPRIVACY GATE: PASS\npre-push: touched tests\ntouched-tests: no verdict: head test budget expired; nothing was judged\npre-push: touched tests: failed (75)" };
    }
    const result = await execute(...args);
    if (peerId && command === "git" && argv[0] === "status" && cwd === box.worktree && options?.inheritFd !== undefined) {
      const id = peerId;
      await withoutControllerPipelineScope(async () => {
        const peer = loadPipelines().find(row => row.id === id)!;
        expect((await takeoverPipelineDelivery(id, id, peer.delivery!.epoch, "Refresh peer delivery", null)).error).toBeUndefined();
        transfers++;
      });
    }
    return result;
  };
  try {
    fs.writeFileSync(path.join(box.repo, "upstream.txt"), "main advanced\n");
    await box.git(box.repo, "add", "upstream.txt");
    await box.git(box.repo, "commit", "-m", "Advance main");
    await box.git(box.repo, "push", "origin", "main");
    expect(await box.git(box.worktree, "merge-base", "HEAD", "origin/main")).toBe(box.base);
    fs.writeFileSync(path.join(box.worktree, "accepted.txt"), "passed output\n");
    await tickPipelinesController([finishReported(box.h, "/codex/stage-1.jsonl", "pass", "Finished")], box.h.ports);
    await settlePipelineControllerJobs();
    const failed = current();
    expect(failed.delivery!.operation).toMatchObject({ state: "settled", result: { ok: false, failure: { retryableDeadline: true } } });
    expect(failed.runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
    expect(failed.lastPassedCommit).not.toBe(box.base);
    const peer = await createPipelineFromRequest({ task: "Disjoint delivery peer", repoDir: box.repo, autoStart: false,
      stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }],
      publication: "remote-branch", delivery: { branch: "refs/heads/disjoint-delivery" } }, box.h.ports);
    if (!peer.pipeline) throw new Error(peer.error);
    peerId = peer.pipeline.id;
    for (const minutes of [0, 1, 5, 15, 16]) {
      clock = Date.parse(failed.runs[0]!.attempts[0]!.completedAt!) + minutes * 60_000;
      await tickPipelinesController([], box.h.ports);
      await settlePipelineControllerJobs();
      if (current().cursor?.stageId === "audit") break;
    }
    expect(transfers).toBeGreaterThan(0);
    expect(loadPipelines().find(row => row.id === peerId)!.delivery!.epoch).toBe(peer.pipeline.delivery!.epoch + transfers);
    expect(current().cursor).toMatchObject({ stageId: "audit", activatedBy: { stageId: "build", attempt: 1, edge: "pass" } });
    expect(current().runs[0]!.attempts).toHaveLength(1);
    expect(current().lastPassedCommit).toBe(failed.lastPassedCommit);
    expect(await box.git(box.worktree, "rev-parse", "HEAD")).toBe(failed.lastPassedCommit);
    expect(current().delivery).toMatchObject({ ownerId: box.id, epoch: failed.delivery!.epoch,
      operation: { state: "settled", sha: failed.lastPassedCommit, result: { ok: true, remote: "published" } } });
    expect(pushes).toBe(2);
  } finally {
    await settlePipelineControllerJobs();
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

// Reproduce the independent review with real Git, a pending reservation and a
// valid peer whose last duplicate target changes after the compact snapshot.
test("a raw duplicate delivery target cannot let a stale owner publish the passed head", async () => {
  const box = await realWorktreeLane("pending-duplicate-target", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "audit" },
    { id: "audit", kind: "run", role: { roleId: "reviewer" }, prompt: "Audit", next: null },
  ], "remote-branch");
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const current = () => loadPipelines().find(row => row.id === box.id)!;
  const held = Promise.withResolvers<void>();
  const execute = box.h.ports.exec;
  let pushes = 0;
  box.h.ports.exec = (...args) => {
    if (args[0] === "git" && args[1][0] === "push") pushes++;
    return execute(...args);
  };
  let db: Database | undefined;
  let read: ReturnType<typeof spyOn> | undefined;
  try {
    fs.writeFileSync(path.join(box.worktree, "accepted.txt"), "passed output\n");
    for (let n = 0; n < PIPELINE_CONTROLLER_MAX_JOBS; n++)
      expect(startPipelineControllerJob(`duplicate-target-capacity-${n}`, () => held.promise, async () => "held")).toBe(true);
    await tickPipelinesController([finishReported(box.h, "/codex/stage-1.jsonl", "pass", "Finished")], box.h.ports);
    held.resolve();
    await settlePipelineControllerJobs();
    await settlePendingStageGit(box.h.ports);
    const operation = structuredClone(current().delivery!.operation!);
    expect(operation.state).toBe("pending");
    expect(pushes).toBe(0);
    const peer = await createPipelineFromRequest({ task: "Duplicate target peer", repoDir: box.repo, autoStart: false,
      stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }],
      publication: "remote-branch", delivery: { branch: "refs/heads/duplicate-peer" } }, box.h.ports);
    if (!peer.pipeline) throw new Error(peer.error);
    db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
    const source = (db.query("SELECT value_json FROM state_rows WHERE collection='pipelines' AND row_key=?")
      .get(peer.pipeline.id) as { value_json: string }).value_json;
    const record = JSON.parse(source);
    const delivery = JSON.stringify(record.delivery);
    const raw = (target: unknown) => source.replace(`"delivery":${delivery}`,
      `"delivery":${delivery.slice(0, -1)},"target":${JSON.stringify(target)}}`);
    const update = (target: unknown) => db!.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?")
      .run(raw(target), peer.pipeline!.id);
    expect(record.delivery.active).toBe(true);
    expect(isStoredPipeline(JSON.parse(raw(record.delivery.target)))).toBe(true);
    expect(isStoredPipeline(JSON.parse(raw(current().delivery!.target)))).toBe(true);
    update(record.delivery.target);
    let changed = false;
    const original = stateStore.readCompactPipelineEvidence;
    read = spyOn(stateStore, "readCompactPipelineEvidence").mockImplementation(async (...args) => {
      const ownership = new Error().stack?.includes("stageBranch.ts");
      const result = await original(...args);
      if (!changed && ownership) { changed = true; update(current().delivery!.target); }
      return result;
    });
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    expect(changed).toBe(true);
    expect(pushes).toBe(0);
    expect(current().delivery!.operation).toEqual(operation);
    expect(current().runs[0]!.attempts[0]!.settlementPreparationWait?.reason).toContain("ownership changed during preparation");
    expect(current().runs[0]!.attempts[0]!.settlementPreparationWait?.reason).toContain(`pipeline ${peer.pipeline.id} (update of record)`);
    // Once the ambiguity is removed, retry uses fresh ownership and the same
    // reservation; only that admitted retry can publish the accepted head.
    read.mockRestore(); read = undefined;
    db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?").run(source, peer.pipeline.id);
    clock = Date.parse(current().runs[0]!.attempts[0]!.settlementPreparationWait!.retryAfter);
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    expect(pushes).toBe(1);
    expect(current().delivery!.operation).toMatchObject({ reservationId: operation.id, sha: operation.sha,
      state: "settled", result: { ok: true, remote: "published" } });
  } finally {
    read?.mockRestore(); db?.close(); held.resolve();
    await settlePipelineControllerJobs();
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});
