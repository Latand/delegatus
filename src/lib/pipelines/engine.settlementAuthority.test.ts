import { expect, test, fs, path, Database, loadPipelines, realWorktreeLane, finishReported, createPipelineFromRequest } from "./engine.fixture";
import { spyOn } from "bun:test";
import * as stateStore from "@/lib/state/sqliteStateStore";
import { isStoredPipeline } from "./store";
import { settlePendingStageGit } from "./engine";
import { tickPipelinesController } from "./controllerPass";
import { settlePipelineControllerJobs, startPipelineControllerJob, PIPELINE_CONTROLLER_MAX_JOBS } from "./controllerJobs";

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
