import { expect, test, fs, path, Database, loadPipelines, realWorktreeLane, finishReported, createPipelineFromRequest, pipelineIdentity, boardTask, loadTasks, saveTasks } from "./engine.fixture";
import { spyOn } from "bun:test";
import * as stateStore from "@/lib/state/sqliteStateStore";
import * as pipelineStore from "./store";
import { withControllerPipelineScope, withoutControllerPipelineScope } from "./controllerScope";
import { patchPipeline, settlePendingStageGit } from "./engine";
import { publishPipelineBranch } from "./git";
import { takeoverPipelineDelivery, withPipelineMutation } from "./store";
import { tickPipelinesController } from "./controllerPass";
import { settlePipelineControllerJobs, startPipelineControllerJob, PIPELINE_CONTROLLER_MAX_JOBS } from "./controllerJobs";
import { realExec } from "@/lib/workflows/provision";

test.each(["clean merge", "paused", "extra lane work"] as const)(
  "a passed stage recovers from a publication refused after HEAD moved (%s)", async (mode) => {
    const box = await realWorktreeLane("moved-publication-head", [
      { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "audit" },
      { id: "audit", kind: "run", role: { roleId: "reviewer" }, prompt: "Audit", next: null },
    ], "remote-branch");
    const { h, git, repo, worktree } = box;
    const read = () => loadPipelines().find(row => row.id === box.id)!;
    const action = (request: Parameters<typeof patchPipeline>[1]) => patchPipeline(box.id, request, h.ports);
    const hostGit = async (...args: string[]) => {
      const date = h.ports.now();
      const result = await realExec("git", args, worktree, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
      expect(result.code, result.stderr).toBe(0);
    };
    const hook = path.join(repo, ".git", "hooks", "pre-push");
    try {
      // Interrupt only the fixture push. The hook is removed before the host push.
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(hook, '#!/bin/sh\nkill -KILL "$PPID"\n', { mode: 0o700 });
      fs.writeFileSync(path.join(worktree, "stage.txt"), "passed output\n");
      await tickPipelinesController([finishReported(h, "/codex/stage-1.jsonl", "pass", "Finished")], h.ports);
      await settlePipelineControllerJobs();
      // The next pass confirms the interrupted push never reached the remote.
      await tickPipelinesController([], h.ports);
      await settlePipelineControllerJobs();
      const first = read();
      const passed = await git(worktree, "rev-parse", "HEAD");
      expect(first).toMatchObject({ state: "running", lastPassedCommit: passed,
        cursor: { stageId: "build", state: "committing" },
        delivery: { operation: { state: "settled", sha: passed, result: { ok: false, failure: { signal: "SIGKILL" } } } } });
      expect(first.runs[0]!.attempts[0]).toMatchObject({ state: "passed", verdict: { status: "pass" } });
      fs.unlinkSync(hook);

      // In the paused case, HEAD moves after the retry has already been queued.
      if (mode === "paused") expect((await action({ action: "publish" })).error).toBeUndefined();
      fs.writeFileSync(path.join(repo, "main.txt"), "upstream output\n");
      await git(repo, "add", "main.txt");
      await git(repo, "commit", "-m", "Advance main");
      const main = await git(repo, "rev-parse", "HEAD");
      await git(repo, "push", "origin", "main");
      // Host Git has no stage receipt binding.
      await hostGit("merge", "--no-ff", "origin/main", "-m", "Merge main");
      if (mode === "extra lane work") {
        fs.writeFileSync(path.join(worktree, "extra.txt"), "unreviewed output\n");
        await hostGit("add", "extra.txt");
        await hostGit("commit", "-m", "Add lane work");
      }
      const moved = await git(worktree, "rev-parse", "HEAD");
      const branch = first.delivery!.target.branch;
      await hostGit("push", "origin", `HEAD:${branch}`);

      if (mode !== "paused") expect((await action({ action: "publish" })).error).toBeUndefined();
      const queued = read();
      if (queued.delivery?.operation?.state === "pending") {
        expect(await publishPipelineBranch(queued, h.ports.exec, { acceptedSha: queued.delivery.operation.sha, now: h.ports.now }))
          .toMatchObject({ ok: false, error: expect.stringContaining("nothing was published") });
      }
      if (mode === "paused") {
        expect((await action({ action: "pause", reason: "Hold publication" })).error).toBeUndefined();
        expect(read().state).toBe("paused");
        expect((await action({ action: "resume" })).error).toBeUndefined();
      }
      // No controller tick between the refusal (or resume) and acceptance.
      expect(read()).toMatchObject({ state: "needs_decision", lastPassedCommit: passed,
        stateDetail: expect.stringContaining("publish acceptedSha="), cursor: { stageId: "build", state: "committing" } });
      const accepted = await action({ action: "publish", acceptedSha: moved });
      if (mode === "extra lane work") {
        expect(accepted).toMatchObject({ status: 409, error: expect.stringContaining("additional lane work beyond clean main merges") });
        expect(read()).toMatchObject({ state: "needs_decision", lastPassedCommit: passed });
        return;
      }
      expect(accepted.error).toBeUndefined();
      const execute = h.ports.exec;
      h.ports.exec = async (...args) => {
        if (args[0] === "git" && args[1][0] === "push") throw new Error("the remote already has the accepted head");
        return execute(...args);
      };
      await tickPipelinesController([], h.ports);
      await settlePipelineControllerJobs();
      await tickPipelinesController([], h.ports);
      await settlePipelineControllerJobs();
      const advanced = read();
      expect(advanced).toMatchObject({ lastPassedCommit: moved, publishedCommit: moved, cursor: { stageId: "audit" },
        delivery: { operation: { state: "settled", result: { ok: true, remote: "published", sha: moved } } } });
      expect(advanced.runs[0]!.attempts).toHaveLength(1);
      expect(advanced.runs[0]!.attempts[0]!.publicationIntegration).toEqual({ passedSha: passed, acceptedSha: moved, mainSha: main });
    } finally {
      await settlePipelineControllerJobs();
      fs.rmSync(box.root, { recursive: true, force: true });
    }
  });

async function passedStagePublication(holdPush?: { entered(): void; ready: Promise<void>; wait: Promise<void> }) {
  const box = await realWorktreeLane("settlement-preparation", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "audit" },
    { id: "audit", kind: "run", role: { roleId: "reviewer" }, prompt: "Audit", next: null },
  ], "remote-branch");
  const { h } = box;
  const execute = h.ports.exec;
  let pushes = 0;
  h.ports.exec = async (...args) => {
    if (args[0] === "git" && args[1][0] === "push") {
      pushes++;
      if (holdPush) { holdPush.entered(); await holdPush.wait; }
    }
    return execute(...args);
  };
  fs.writeFileSync(path.join(box.worktree, "change.txt"), "accepted output\n");
  await tickPipelinesController([finishReported(h, "/codex/stage-1.jsonl", "pass", "Finished")], h.ports);
  if (holdPush) await holdPush.ready;
  else await settlePipelineControllerJobs();
  const accepted = loadPipelines()[0]!;
  expect(accepted.cursor).toMatchObject({ stageId: "build", state: "committing" });
  expect(accepted.runs[0]!.attempts[0]!.state).toBe("passed");
  const published = loadPipelines()[0]!;
  if (!holdPush) expect(published.delivery!.operation!.result).toMatchObject({ ok: true, remote: "published", sha: published.lastPassedCommit });
  expect(pushes).toBe(1);
  const publication = structuredClone(published.delivery!.operation!);
  return { ...box, publication, pushes: () => pushes, current: () => loadPipelines().find(row => row.id === box.id)! };
}

function comparisonFor(owner: NonNullable<ReturnType<typeof loadPipelines>[number]>) {
  return {
    target: owner.delivery?.target ?? { repository: "fixture-repo", remote: "origin", branch: `refs/heads/${owner.branch}` },
    disposition: "comparison" as const, publish: "disabled" as const, active: false,
    ownerId: owner.id, epoch: owner.delivery?.epoch ?? 1, journal: [],
  };
}

/** Finish the real compact read before injecting a concurrent write or a read failure. */
async function racePreparation(box: Pick<Awaited<ReturnType<typeof passedStagePublication>>, "id" | "repo" | "h">,
  mutate?: () => Promise<void>, mode: "authority" | "noop" | "progress" | "unreadable" = "authority") {
  const peer = await createPipelineFromRequest({ task: "Preparation peer", repoDir: box.repo, autoStart: false,
    stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }], publication: "internal" }, box.h.ports);
  if (!peer.pipeline) throw new Error(peer.error);
  await withPipelineMutation(async (rows, persist) => {
    const row = rows.find(item => item.id === peer.pipeline!.id)!;
    row.delivery = comparisonFor(rows.find(item => item.id === box.id)!);
    await persist([row]);
  });
  const original = stateStore.readCompactPipelineEvidence;
  let reads = 0;
  const read = spyOn(stateStore, "readCompactPipelineEvidence").mockImplementation(async (...args) => {
    const ownership = new Error().stack?.includes("stageBranch.ts");
    const result = await original(...args);
    if (!ownership) return result;
    await mutate?.();
    reads++;
    if (mode === "unreadable") throw new Error("pipeline ownership is unreadable");
    if (mode === "authority") await withoutControllerPipelineScope(() => withPipelineMutation(async (rows, persist) => {
      const current = rows.find(row => row.id === peer.pipeline!.id)!;
      current.task = current.task === "Authority peer A" ? "Authority peer B" : "Authority peer A";
      Object.assign(current, pipelineIdentity(current.id, current.task, current.repoDir));
      await persist([current]);
    }));
    else {
      const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
      try {
        const value = mode === "noop" ? "value_json"
          : "json_set(value_json,'$.stateDetail',coalesce(json_extract(value_json,'$.stateDetail'),'') || ' progress')";
        db.query(`UPDATE state_rows SET value_json=${value} WHERE collection='pipelines' AND row_key=?`).run(peer.pipeline!.id);
      } finally { db.close(); }
    }
    return result;
  });
  return { restore: () => read.mockRestore(), reads: () => reads };
}

test.each(["noop", "progress"] as const)("ordinary peer %s writes during compact preparation settle the original pass", async mode => {
  const box = await passedStagePublication();
  const accepted = structuredClone(box.current().runs[0]!.attempts[0]!);
  const race = await racePreparation(box, undefined, mode);
  try {
    await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
    expect(race.reads()).toBeGreaterThan(0);
    expect(box.current().cursor?.stageId).toBe("audit");
    expect(box.current().runs[0]!.attempts).toHaveLength(1);
    expect(box.current().runs[0]!.attempts[0]!.settlementPreparationWait).toBeUndefined();
    for (const key of ["output", "verdict", "report", "n", "launchId", "conversationId", "completedAt"] as const)
      expect(box.current().runs[0]!.attempts[0]![key]).toEqual(accepted[key]);
    expect(box.current().delivery!.operation).toEqual(box.publication);
    expect(box.current().lastPassedCommit).toBe(box.publication.sha);
    expect(box.current().delivery!.epoch).toBe(box.publication.epoch);
    expect(await box.git(box.worktree, "rev-parse", "HEAD")).toBe(box.publication.sha);
    expect(box.pushes()).toBe(1);
  } finally { race.restore(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each([
  ["close", "preparation"], ["takeover", "preparation"], ["claim", "preparation"],
  ["close", "git"], ["takeover", "git"], ["claim", "git"],
  ["close", "checkpoint"], ["takeover", "checkpoint"], ["claim", "checkpoint"],
] as const)("a disjoint %s during %s settles the original pass", async (action, phase) => {
  const box = await passedStagePublication();
  const target = { branch: "refs/heads/disjoint-delivery" };
  const createPeer = async (task: string) => {
    const { pipeline, error } = await createPipelineFromRequest({ task, repoDir: box.repo, autoStart: false,
      stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }],
      publication: "remote-branch", delivery: target }, box.h.ports);
    if (!pipeline) throw new Error(error);
    return pipeline;
  };
  const peer = action === "claim" ? undefined : await createPeer("Disjoint owner");
  const successor = action === "takeover" ? await createPeer("Disjoint successor") : undefined;
  let fired = false;
  const write = async () => {
    if (fired) return;
    fired = true;
    await withoutControllerPipelineScope(async () => {
      if (action === "close") {
        expect((await patchPipeline(peer!.id, { action: "close", reason: "Fixture close" }, box.h.ports)).error).toBeUndefined();
      } else if (action === "takeover") {
        expect((await takeoverPipelineDelivery(successor!.id, peer!.id, peer!.delivery!.epoch, "Fixture takeover", null)).error).toBeUndefined();
      } else {
        const claimed = await createPeer("Disjoint claim");
        expect(claimed.delivery).toMatchObject({ active: true, ownerId: claimed.id });
      }
    });
  };
  const compact = stateStore.readCompactPipelineEvidence;
  let ownershipReads = 0;
  const read = spyOn(stateStore, "readCompactPipelineEvidence").mockImplementation(async (...args) => {
    const ownership = new Error().stack?.includes("stageBranch.ts");
    const result = await compact(...args);
    if (ownership) {
      ownershipReads++;
      if (phase === "preparation") await write();
    }
    return result;
  });
  const execute = box.h.ports.exec;
  let reachedGit = false;
  box.h.ports.exec = async (...args) => {
    const result = await execute(...args);
    if (args[0] === "git" && args[1][0] === "status") {
      reachedGit = true;
      if (phase === "git") await write();
    }
    return result;
  };
  const mutate = pipelineStore.withPipelineMutation;
  const checkpoint = phase === "checkpoint" ? spyOn(pipelineStore, "withPipelineMutation").mockImplementation(async (...args) => {
    if (reachedGit) await write();
    return mutate(...args);
  }) : undefined;
  try {
    await withControllerPipelineScope([box.id], () => settlePendingStageGit(box.h.ports));
    expect(fired).toBe(true);
    expect(ownershipReads).toBe(1);
    expect(box.current().cursor).toMatchObject({ stageId: "audit", state: "pending" });
    expect(box.current().runs[0]!.attempts[0]!.settlementPreparationWait).toBeUndefined();
    expect(box.current().delivery!.operation).toEqual(box.publication);
    expect(box.current().lastPassedCommit).toBe(box.publication.sha);
    expect(await box.git(box.worktree, "rev-parse", "HEAD")).toBe(box.publication.sha);
    expect(box.pushes()).toBe(1);
  } finally { read.mockRestore(); checkpoint?.mockRestore(); box.h.ports.exec = execute; await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["branch", "worktreeDir", "delivery.target"] as const)("a peer entering and leaving the same %s invalidates the proof", async field => {
  const box = await passedStagePublication();
  const { stageBranchOwnershipReader } = await import("./stageBranch");
  const owner = box.current();
  const { pipeline: peer, error } = await createPipelineFromRequest({ task: "Disjoint authority", repoDir: box.repo, autoStart: false,
    stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }],
    publication: "remote-branch", delivery: { branch: "refs/heads/other-delivery" } }, box.h.ports);
  if (!peer) throw new Error(error);
  const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
  try {
    const reader = stageBranchOwnershipReader(owner);
    const token = await reader.read();
    const colliding = structuredClone(peer);
    if (field === "delivery.target") {
      // Keep the differing PR metadata and remote alias out of target identity.
      colliding.delivery!.target = { ...owner.delivery!.target, remote: "other-remote", pr: 17 };
      colliding.delivery!.ownerId = owner.id;
      colliding.delivery!.disposition = "comparison";
      colliding.delivery!.publish = "disabled";
      colliding.delivery!.active = false;
    } else colliding[field] = owner[field];
    const update = db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?");
    update.run(JSON.stringify(colliding), peer.id);
    update.run(JSON.stringify(peer), peer.id);
    expect(reader.current()).toBe(false);
    expect(await reader.read()).not.toBe(token);
    expect(reader.failure("settlement").message).toContain(`pipeline ${peer.id} (update of ${field}`);
  } finally { db.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["replace", "schema", "database"] as const)("settlement rejects an old proof after a raw %s change", async change => {
  const box = await passedStagePublication();
  const { stageBranchOwnershipReader } = await import("./stageBranch");
  const owner = box.current();
  const { pipeline: peer, error } = await createPipelineFromRequest({ task: "Raw authority", repoDir: box.repo, autoStart: false,
    stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }],
    publication: "internal" }, box.h.ports);
  if (!peer) throw new Error(error);
  const filename = path.join(process.env.LLV_STATE_DIR!, "state.sqlite");
  const db = new Database(filename);
  try {
    if (change === "replace") {
      db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?")
        .run(JSON.stringify({ ...peer, delivery: comparisonFor(owner) }), peer.id);
    }
    const reader = stageBranchOwnershipReader(owner);
    const original = await reader.read();
    if (change === "replace") {
      db.exec("PRAGMA recursive_triggers=OFF");
      db.query(`INSERT OR REPLACE INTO state_rows(collection,row_key,value_json,row_order,row_revision,controller_active)
        SELECT collection,row_key,?,row_order,row_revision,controller_active FROM state_rows
        WHERE collection='pipelines' AND row_key=?`).run(JSON.stringify(peer), peer.id);
    } else if (change === "schema") db.exec("CREATE TABLE settlement_schema_probe (id INTEGER)");
    else {
      const replacement = path.join(path.dirname(filename), "replacement.sqlite");
      const retired = path.join(path.dirname(filename), "retired.sqlite");
      fs.writeFileSync(replacement, db.serialize());
      fs.renameSync(filename, retired);
      for (const suffix of ["-wal", "-shm"]) {
        if (fs.existsSync(filename + suffix)) fs.renameSync(filename + suffix, retired + suffix);
      }
      fs.renameSync(replacement, filename);
    }
    expect(reader.current()).toBe(false);
    expect(await stageBranchOwnershipReader(owner).read()).not.toBe(original);
  } finally { db.close(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("the authority clock fences every claim field, raw moves and malformed records while retaining the general clock", async () => {
  const box = await passedStagePublication();
  const { stageBranchOwnershipReader } = await import("./stageBranch");
  const inserted = stageBranchOwnershipReader(box.current()); await inserted.read();
  const peer = await createPipelineFromRequest({ task: "Authority clock peer", repoDir: box.repo, autoStart: false,
    stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }],
    publication: "remote-branch", delivery: { branch: "refs/heads/authority-clock-peer" } }, box.h.ports);
  if (!peer.pipeline) throw new Error(peer.error);
  expect(inserted.current()).toBe(true);
  await withPipelineMutation(async (rows, persist) => {
    const row = rows.find(item => item.id === peer.pipeline!.id)!;
    row.delivery!.target = { ...row.delivery!.target, repository: "other-delivery-repository", branch: `refs/heads/${box.current().branch}` };
    await persist([row]);
  });
  expect(inserted.current()).toBe(false);
  const filename = path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), db = new Database(filename);
  const query = "UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?";
  const id = peer.pipeline.id;
  const owner = db.query<{ value_json: string }, [string]>("SELECT value_json FROM state_rows WHERE collection='pipelines' AND row_key=?").get(box.id)!.value_json;
  const original = db.query<{ value_json: string }, [string]>("SELECT value_json FROM state_rows WHERE collection='pipelines' AND row_key=?").get(id)!.value_json;
  try {
    const changes: Array<(row: NonNullable<typeof peer.pipeline>) => void> = [
      row => { row.id += "-changed"; }, row => { row.repoDir += "/changed"; }, row => { row.worktreeDir += "/changed"; },
      row => { row.branch += "-changed"; }, row => { row.state = "closed"; },
      // Use the real delivery builder's output for all delivery-field probes.
      row => { delete row.delivery; },
    ];
    for (const change of changes) {
      const reader = stageBranchOwnershipReader(box.current()); await reader.read();
      const before = stateStore.pipelineAuthorityRevision(filename), general = stateStore.pipelineEvidenceRevision(filename);
      const record = JSON.parse(original); change(record);
      db.query(query).run(JSON.stringify(record), id);
      expect(stateStore.pipelineAuthorityRevision(filename)).not.toBe(before);
      expect(stateStore.pipelineEvidenceRevision(filename)).not.toBe(general);
      expect(reader.current()).toBe(false);
      db.query(query).run(original, id);
    }
    const delivered = JSON.parse(original);
    delivered.delivery.active = false;
    for (const [field, value] of [["target", { ...delivered.delivery.target, branch: "refs/heads/changed" }],
      ["active", true], ["active", 0], ["ownerId", box.id], ["epoch", delivered.delivery.epoch + 1], ["publish", "disabled"]] as const) {
      db.query(query).run(JSON.stringify(delivered), id);
      const before = stateStore.pipelineAuthorityRevision(filename);
      db.query(query).run(JSON.stringify({ ...delivered, delivery: { ...delivered.delivery, [field]: value } }), id);
      expect(stateStore.pipelineAuthorityRevision(filename)).not.toBe(before);
    }
    db.query(query).run(original, id);
    const reader = stageBranchOwnershipReader(box.current()); await reader.read();
    const general = stateStore.pipelineEvidenceRevision(filename);
    const stable = stateStore.pipelineAuthorityRevision(filename);
    db.query(query).run(original, id);
    expect(stateStore.pipelineEvidenceRevision(filename)).not.toBe(general);
    expect(stateStore.pipelineAuthorityRevision(filename)).toBe(stable);
    expect(reader.current()).toBe(true);
    db.exec("BEGIN IMMEDIATE");
    db.query(query).run(JSON.stringify({ ...JSON.parse(original), branch: "rolled-back" }), id);
    db.exec("ROLLBACK");
    expect(stateStore.pipelineAuthorityRevision(filename)).toBe(stable);
    expect(reader.current()).toBe(true);
    db.query(query).run(JSON.stringify({ ...JSON.parse(original), state: "invalid" }), id);
    expect(stateStore.pipelineAuthorityRevision(filename)).not.toBe(stable);
    expect(reader.current()).toBe(false);
    await expect(stageBranchOwnershipReader(box.current()).read()).rejects.toThrow("pipeline ownership is unreadable");
    db.query(query).run(original, id);
    const moved = stageBranchOwnershipReader(box.current()); await moved.read();
    let before = stateStore.pipelineAuthorityRevision(filename);
    db.query("UPDATE state_rows SET row_key=? WHERE collection='pipelines' AND row_key=?").run(`${id}-moved`, id);
    expect(stateStore.pipelineAuthorityRevision(filename)).not.toBe(before);
    expect(moved.current()).toBe(false);
    db.query("UPDATE state_rows SET row_key=? WHERE collection='pipelines' AND row_key=?").run(id, `${id}-moved`);
    const archived = stageBranchOwnershipReader(box.current()); await archived.read();
    before = stateStore.pipelineAuthorityRevision(filename);
    db.query("UPDATE state_rows SET collection='pipelines_archive' WHERE collection='pipelines' AND row_key=?").run(id);
    expect(stateStore.pipelineAuthorityRevision(filename)).not.toBe(before);
    expect(archived.current()).toBe(false);
    before = stateStore.pipelineAuthorityRevision(filename);
    db.query("DELETE FROM state_rows WHERE collection='pipelines_archive' AND row_key=?").run(id);
    expect(stateStore.pipelineAuthorityRevision(filename)).not.toBe(before);
    const corrupt = stageBranchOwnershipReader(box.current()); await corrupt.read();
    before = stateStore.pipelineAuthorityRevision(filename);
    db.query(query).run("{broken", box.id);
    expect(stateStore.pipelineAuthorityRevision(filename)).not.toBe(before);
    expect(corrupt.current()).toBe(false);
    await expect(stageBranchOwnershipReader(JSON.parse(owner)).read()).rejects.toThrow("corrupt pipelines SQLite row");
  } finally {
    db.query(query).run(original, id); db.query(query).run(owner, box.id); db.close();
    await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true });
  }
});

async function failPreparationInReplacementController(at: string, postPreparation?: { lane: string; peer: string }, expectedReads?: number) {
  const source = `
    import { spyOn } from 'bun:test';
    import { Database } from 'bun:sqlite';
    import * as stateStore from ${JSON.stringify(path.resolve("src/lib/state/sqliteStateStore.ts"))};
    import { defaultPipelinePorts } from ${JSON.stringify(path.resolve("src/lib/pipelines/engine.ts"))};
    import { tickPipelinesController } from ${JSON.stringify(path.resolve("src/lib/pipelines/controllerPass.ts"))};
    import { settlePipelineControllerJobs } from ${JSON.stringify(path.resolve("src/lib/pipelines/controllerJobs.ts"))};
    import { registerPipelineTick } from ${JSON.stringify(path.resolve("src/lib/pipelines/controllerSignal.ts"))};
    import { withPipelineMutation, pipelineIdentity } from ${JSON.stringify(path.resolve("src/lib/pipelines/store.ts"))};
    import { withControllerPipelineScope, withoutControllerPipelineScope } from ${JSON.stringify(path.resolve("src/lib/pipelines/controllerScope.ts"))};
    import { settlePendingStageGit } from ${JSON.stringify(path.resolve("src/lib/pipelines/engine.ts"))};
    registerPipelineTick(async () => {});
    const original = stateStore.readCompactPipelineEvidence;
    let reads = 0;
    const read = spyOn(stateStore, 'readCompactPipelineEvidence').mockImplementation(async (...args) => {
      const ownership = new Error().stack?.includes('stageBranch.ts');
      const result = await original(...args);
      if (ownership) {
        reads++;
        await withoutControllerPipelineScope(() => withPipelineMutation(async (rows, persist) => {
          const peers = rows.filter(row => row.state === 'draft');
          for (const peer of peers) {
            peer.task = peer.task === 'Authority peer A' ? 'Authority peer B' : 'Authority peer A';
            Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
          }
          await persist(peers);
        }));
      }
      return result;
    });
    const postPreparation = ${JSON.stringify(postPreparation ?? null)};
    const defaults = defaultPipelinePorts();
    let invalidated = false;
    let pushes = 0;
    const ports = { ...defaults, now: () => ${JSON.stringify(at)},
      exec: async (...args) => {
        if (postPreparation && args[0] === 'git' && args[1][0] === 'push') { pushes++; throw new Error('unexpected replacement push'); }
        const result = await defaults.exec(...args);
        if (postPreparation && !invalidated && args[0] === 'git' && args[1][0] === 'status') {
          invalidated = true;
          await withoutControllerPipelineScope(() => withPipelineMutation(async (rows, persist) => {
            const peer = rows.find(row => row.id === postPreparation.peer);
            peer.task += ' changed';
            Object.assign(peer, pipelineIdentity(peer.id, peer.task, peer.repoDir));
            await persist([peer]);
          }));
        }
        return result;
      },
      scheduleTick: () => {}, sourcePathAllowed: () => false, conversationAgentActive: async () => false,
      stageHostResident: async () => false, paneAgentAlive: async () => false,
      spawnAgent: async () => { throw new Error('unexpected fixture spawn'); }, stopStageAgent: async () => { throw new Error('unexpected fixture stop'); } };
    try {
      if (postPreparation) {
        read.mockRestore();
        try { await withControllerPipelineScope([postPreparation.lane], () => settlePendingStageGit(ports)); }
        catch (error) { if (error.pipelineId !== postPreparation.lane) throw error; }
        if (!invalidated || pushes) throw new Error('replacement controller did not preserve stale-ownership custody');
      } else { await tickPipelinesController([], ports); await settlePipelineControllerJobs(); }
      const expectedReads = ${JSON.stringify(expectedReads ?? null)};
      if (expectedReads !== null && reads !== expectedReads) throw new Error('replacement ownership reads: ' + reads);
    }
    finally { read.mockRestore(); }
  `;
  const child = await realExec(process.execPath, ["-e", source], process.cwd(), process.env, { timeoutMs: 30_000 });
  expect(child.code, child.stderr).toBe(0);
}

/** A valid peer changes authority after a real, fenced Git read. The adoption
 * variant writes just before the real mutation callback checks its fences. */
async function raceAfterPreparation(box: Pick<Awaited<ReturnType<typeof passedStagePublication>>, "id" | "repo" | "h">,
  point: "git-status" | "adoption" | "same-branch" = "git-status", change?: () => Promise<void>) {
  const peer = await createPipelineFromRequest({ task: "Independent authority", repoDir: box.repo, autoStart: false,
    stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }],
    publication: "internal" }, box.h.ports);
  if (!peer.pipeline) throw new Error(peer.error);
  if (point !== "same-branch") await withPipelineMutation(async (rows, persist) => {
    const row = rows.find(item => item.id === peer.pipeline!.id)!;
    row.delivery = comparisonFor(rows.find(item => item.id === box.id)!);
    await persist([row]);
  });
  const mutate = pipelineStore.withPipelineMutation;
  const execute = box.h.ports.exec;
  let armed = false, writes = 0;
  const invalidate = async () => {
    armed = false;
    if (point === "same-branch") {
      const owner = loadPipelines().find(row => row.id === box.id)!;
      const db = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
      try {
        const update = db.query("UPDATE state_rows SET value_json=? WHERE collection='pipelines' AND row_key=?");
        update.run(JSON.stringify({ ...peer.pipeline, branch: owner.branch }), peer.pipeline!.id);
        update.run(JSON.stringify(peer.pipeline), peer.pipeline!.id);
      } finally { db.close(); }
    } else await withoutControllerPipelineScope(() => mutate(async (rows, persist) => {
      const current = rows.find(row => row.id === peer.pipeline!.id)!;
      current.task = current.task === "Settlement peer A" ? "Settlement peer B" : "Settlement peer A";
      Object.assign(current, pipelineIdentity(current.id, current.task, current.repoDir));
      await persist([current]);
    }));
    writes++;
    await withoutControllerPipelineScope(() => change?.());
  };
  box.h.ports.exec = async (...args) => {
    const result = await execute(...args);
    if (args[0] === "git" && args[1][0] === "status") {
      armed = true;
      if (point !== "adoption") await invalidate();
    }
    return result;
  };
  const guardedMutation: typeof pipelineStore.withPipelineMutation = async (callback, observeHold) => {
    if (armed) await invalidate();
    return mutate(callback, observeHold);
  };
  const mutation = point === "adoption" ? spyOn(pipelineStore, "withPipelineMutation").mockImplementation(guardedMutation) : undefined;
  return { peer: peer.pipeline.id, writes: () => writes,
    restore: () => { box.h.ports.exec = execute; mutation?.mockRestore(); } };
}

async function refuseStaleSettlement(box: Awaited<ReturnType<typeof passedStagePublication>>) {
  let refused = false;
  try { await withControllerPipelineScope([box.id], () => settlePendingStageGit(box.h.ports)); }
  catch (error) { expect(error).toMatchObject({ pipelineId: box.id, operationId: box.publication.id }); refused = true; }
  // Keep the custody assertions first so the pre-fix control diagnoses the
  // missing durable accounting even when the old path returns silently.
  expect(box.current().cursor).toMatchObject({ stageId: "build", state: "committing" });
  expect(box.current().runs[1]!.attempts).toHaveLength(0);
  return refused;
}

test.each(["git-status", "adoption", "same-branch"] as const)("post-preparation invalidation at %s keeps the same pass on capped automatic backoff", async point => {
  const box = await passedStagePublication();
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const accepted = structuredClone(box.current().runs[0]!.attempts[0]!);
  const race = await raceAfterPreparation(box, point);
  const notes = await import("./taskStatusNote");
  const note = spyOn(notes, "writeParkedTaskNote");
  const task = boardTask(`settlement-wait-${point}`, box.current().project);
  try {
    saveTasks([...loadTasks(), task]);
    await withPipelineMutation(async (rows, persist) => {
      const lane = rows.find(row => row.id === box.id)!;
      lane.taskIds = [task.id];
      await persist([lane]);
    });
    await refuseStaleSettlement(box);
    const first = structuredClone(box.current().runs[0]!.attempts[0]!.settlementPreparationWait);
    expect(first).toBeDefined();
    expect(race.writes()).toBe(1);
    expect(box.current().delivery!.operation).toEqual(box.publication);
    clock = Date.parse(first!.retryAfter);
    await refuseStaleSettlement(box);
    const second = box.current().runs[0]!.attempts[0]!.settlementPreparationWait!;
    expect(second.startedAt).toBe(first!.startedAt);
    expect(second.rounds).toBe(first!.rounds + 1);
    expect((await patchPipeline(box.id, { action: "dismiss" }, box.h.ports)).error).toBeUndefined();
    const dismissal = { dismissedAt: box.h.ports.now(), dismissedBy: { kind: "operator" } };
    expect(box.current()).toMatchObject(dismissal);
    clock = Date.parse(first!.startedAt) + 15 * 60_000;
    for (let round = 1; round <= 3; round++) {
      await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
      const waiting = box.current(), retained = waiting.runs[0]!.attempts[0]!;
      expect(race.writes()).toBe(2 + round);
      expect(loadTasks().find(row => row.id === task.id)?.note ?? null).toBeNull();
      expect(note).toHaveBeenCalledTimes(0);
      expect(waiting.state).toBe("running");
      expect(waiting.stateDetail).toContain(`pipeline ${race.peer}`);
      expect(waiting.stateDetail).toContain("automatic retry at");
      expect(waiting).toMatchObject(dismissal);
      expect(retained.settlementPreparationWait).toMatchObject({ identity: first!.identity, startedAt: first!.startedAt,
        rounds: second.rounds + round, retryAfter: new Date(clock + 60_000).toISOString() });
      for (const key of ["state", "output", "verdict", "report", "definition", "n", "launchId", "conversationId", "completedAt"] as const)
        expect(retained[key]).toEqual(accepted[key]);
      expect(waiting.delivery!.operation).toEqual(box.publication);
      expect(waiting.lastPassedCommit).toBe(box.publication.sha);
      expect(waiting.publishedCommit).toBe(box.publication.sha);
      expect(waiting.delivery!.ownerId).toBe(box.id);
      expect(waiting.delivery!.epoch).toBe(box.publication.epoch);
      clock = Date.parse(retained.settlementPreparationWait!.retryAfter);
    }
    race.restore();
    await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
    expect(box.current().cursor?.stageId).toBe("audit");
    expect(box.current()).toMatchObject(dismissal);
    expect(note).toHaveBeenCalledTimes(0);
    expect(box.current().runs[1]!.attempts).toHaveLength(0);
    expect(box.pushes()).toBe(1);
    expect(await box.git(box.worktree, "rev-parse", "HEAD")).toBe(box.publication.sha);
  } finally { race.restore(); note.mockRestore(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["recover", "restart"] as const)("post-preparation recovery retains its original publication (%s)", async outcome => {
  const box = await passedStagePublication();
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const race = await raceAfterPreparation(box);
  try {
    await refuseStaleSettlement(box);
    const first = structuredClone(box.current().runs[0]!.attempts[0]!.settlementPreparationWait);
    expect(first).toBeDefined();
    race.restore();
    if (outcome === "restart") {
      clock = Date.parse(first!.startedAt) + 15 * 60_000;
      await failPreparationInReplacementController(new Date(clock).toISOString(), { lane: box.id, peer: race.peer });
      const waiting = box.current();
      expect(waiting.state).toBe("running");
      expect(waiting.stateDetail).toContain("automatic retry at");
      expect(waiting.runs[0]!.attempts[0]!.settlementPreparationWait).toMatchObject({ startedAt: first!.startedAt, rounds: first!.rounds + 1 });
      expect(waiting.delivery!.operation).toEqual(box.publication);
      expect(waiting.publishedCommit).toBe(box.publication.sha);
      expect(waiting.lastPassedCommit).toBe(box.publication.sha);
      expect(waiting.runs[1]!.attempts).toHaveLength(0);
      const due = Date.parse(waiting.runs[0]!.attempts[0]!.settlementPreparationWait!.retryAfter);
      clock = due - 1;
      await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
      expect(box.current().state).toBe("running");
      clock = due;
      await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
      expect(box.current().runs[0]!.attempts[0]!.settlementPreparationWait).toBeUndefined();
      expect(box.current().cursor).toMatchObject({ stageId: "audit", state: "pending" });
      expect(box.current().runs[0]!.attempts).toHaveLength(1);
      expect(box.current().runs[0]!.attempts[0]!.verdict?.status).toBe("pass");
      expect(box.current().lastPassedCommit).toBe(box.publication.sha);
      expect(await box.git(box.worktree, "rev-parse", "HEAD")).toBe(box.publication.sha);
      expect(box.h.spawnInputs).toHaveLength(1);
    } else {
      clock = Date.parse(first!.retryAfter);
      await withControllerPipelineScope([box.id], () => settlePendingStageGit(box.h.ports));
      expect(box.current().cursor).toMatchObject({ stageId: "audit", state: "pending" });
      expect(box.current().runs[0]!.attempts[0]!.settlementPreparationWait).toBeUndefined();
      for (let n = 0; n < 3; n++) { await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs(); }
      expect(box.current().runs[0]!.attempts).toHaveLength(1);
      expect(box.current().runs[1]!.attempts).toHaveLength(1);
      expect(box.current().delivery!.operation).toEqual(box.publication);
    }
    expect(box.pushes()).toBe(1);
  } finally { race.restore(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["controller pass", "retry-stage"] as const)("a legacy ownership park resumes the accepted pass through %s", async recovery => {
  const box = await passedStagePublication();
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const race = await raceAfterPreparation(box);
  try {
    await refuseStaleSettlement(box);
    race.restore();
    const saved = box.current();
    const wait = saved.runs[0]!.attempts[0]!.settlementPreparationWait!;
    const reason = "pipeline branch ownership changed during settlement";
    const detail = `committing the passed stage: branch ownership preparation did not stabilize within 15 minutes: ${reason}; retry-stage to settle the preserved head`;
    await withPipelineMutation(async (rows, persist) => {
      const lane = rows.find(row => row.id === box.id)!;
      const attempt = lane.runs[0]!.attempts[0]!;
      lane.state = "needs_decision";
      lane.stateDetail = detail;
      lane.delivery!.operation!.passedStage = false;
      attempt.state = "needs_decision";
      attempt.error = detail;
      attempt.settlementPreparationWait!.reason = reason;
      await persist([lane]);
    });
    if (recovery === "controller pass") clock = Date.parse(wait.retryAfter);
    else {
      expect((await patchPipeline(box.id, { action: "retry-stage" }, box.h.ports)).error).toBeUndefined();
      const resumed = box.current().runs[0]!.attempts[0]!;
      expect(resumed.state).toBe("passed");
      expect(resumed.settlementPreparationWait).toBeUndefined();
    }
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    const settled = box.current();
    expect(settled.cursor).toMatchObject({ stageId: "audit", activatedBy: { stageId: "build", attempt: 1, edge: "pass" } });
    expect(settled.runs[0]!.attempts[0]!.completedAt).toBe(saved.runs[0]!.attempts[0]!.completedAt);
    expect(settled.runs[0]!.attempts[0]!.settlementPreparationWait).toBeUndefined();
    expect(settled.delivery!.operation).toEqual({ ...box.publication, passedStage: false });
    expect(settled.lastPassedCommit).toBe(box.publication.sha);
    expect(box.pushes()).toBe(1);
  } finally { race.restore(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("uncommitted passed output settles automatically after an ownership race and controller restart", async () => {
  const box = await realWorktreeLane("uncommitted-ownership", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "audit" },
    { id: "audit", kind: "run", role: { roleId: "reviewer" }, prompt: "Audit", next: null },
  ], "remote-branch");
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const held = Promise.withResolvers<void>();
  const current = () => loadPipelines().find(row => row.id === box.id)!;
  let race: Awaited<ReturnType<typeof raceAfterPreparation>> | undefined;
  try {
    fs.writeFileSync(path.join(box.worktree, "change.txt"), "accepted output\n");
    for (let n = 0; n < PIPELINE_CONTROLLER_MAX_JOBS; n++)
      expect(startPipelineControllerJob(`uncommitted-capacity-${n}`, () => held.promise, async () => "held")).toBe(true);
    await tickPipelinesController([finishReported(box.h, "/codex/stage-1.jsonl", "pass", "Finished")], box.h.ports);
    held.resolve(); await settlePipelineControllerJobs();
    race = await raceAfterPreparation(box);
    await withControllerPipelineScope([box.id], () => settlePendingStageGit(box.h.ports));
    expect(race.writes()).toBe(1);
    const first = structuredClone(current().runs[0]!.attempts[0]!.settlementPreparationWait!);
    expect(first).toBeDefined();
    expect(current().lastPassedCommit).toBe(box.base);
    race.restore();
    clock = Date.parse(first.startedAt) + 15 * 60_000;
    await failPreparationInReplacementController(new Date(clock).toISOString(), { lane: box.id, peer: race.peer });
    expect(current().state).toBe("running");
    expect(current().lastPassedCommit).toBe(box.base);
    expect(fs.readFileSync(path.join(box.worktree, "change.txt"), "utf8")).toBe("accepted output\n");
    clock = Date.parse(current().runs[0]!.attempts[0]!.settlementPreparationWait!.retryAfter);
    await withControllerPipelineScope([box.id], () => settlePendingStageGit(box.h.ports));
    expect(current().runs[0]!.attempts).toHaveLength(1);
    expect(current().lastPassedCommit).not.toBe(box.base);
    expect(await box.git(box.worktree, "show", "HEAD:change.txt")).toBe("accepted output");
    expect(box.h.spawnInputs).toHaveLength(1);
  } finally { race?.restore(); held.resolve(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("post-preparation invalidation cannot dispatch a pending publication", async () => {
  const box = await realWorktreeLane("pending-ownership", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "audit" },
    { id: "audit", kind: "run", role: { roleId: "reviewer" }, prompt: "Audit", next: null },
  ], "remote-branch");
  let clock = Date.parse(box.h.ports.now()), pushes = 0;
  box.h.ports.now = () => new Date(clock).toISOString();
  const held = Promise.withResolvers<void>(), execute = box.h.ports.exec;
  box.h.ports.exec = (...args) => {
    if (args[0] === "git" && args[1][0] === "push") pushes++;
    return execute(...args);
  };
  let race: Awaited<ReturnType<typeof raceAfterPreparation>> | undefined;
  const current = () => loadPipelines().find(row => row.id === box.id)!;
  try {
    fs.writeFileSync(path.join(box.worktree, "change.txt"), "accepted output\n");
    for (let n = 0; n < PIPELINE_CONTROLLER_MAX_JOBS; n++)
      expect(startPipelineControllerJob(`ownership-capacity-${n}`, () => held.promise, async () => "held")).toBe(true);
    await tickPipelinesController([finishReported(box.h, "/codex/stage-1.jsonl", "pass", "Finished")], box.h.ports);
    held.resolve(); await settlePipelineControllerJobs();
    await settlePendingStageGit(box.h.ports);
    const publication = structuredClone(current().delivery!.operation!);
    expect(publication.state).toBe("pending");
    race = await raceAfterPreparation(box);
    await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
    expect(race.writes()).toBeGreaterThan(0);
    expect(current().runs[0]!.attempts[0]!.settlementPreparationWait).toBeDefined();
    expect(current().delivery!.operation).toEqual(publication);
    expect(pushes).toBe(0);
    clock += 15 * 60_000;
    await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
    expect(current().state).toBe("running");
    expect(current().delivery!.operation).toEqual(publication);
    expect(current().runs[1]!.attempts).toHaveLength(0);
    expect(pushes).toBe(0);
  } finally { race?.restore(); held.resolve(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["pause", "close", "owner", "epoch", "head", "reservation"] as const)("post-preparation %s changes supersede the old accounting selection", async change => {
  const box = await passedStagePublication();
  let changed = false;
  const race = await raceAfterPreparation(box, "git-status", async () => {
    if (changed) return;
    changed = true;
    if (change === "pause" || change === "close") {
      expect((await patchPipeline(box.id, { action: change, reason: "Fixture control" }, box.h.ports)).error).toBeUndefined();
    } else if (change === "owner" || change === "epoch") {
      const successor = change === "owner" ? await createPipelineFromRequest({ task: "Successor", repoDir: box.repo, autoStart: false,
        stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }],
        publication: "remote-branch", delivery: { branch: box.current().delivery!.target.branch } }, box.h.ports) : null;
      expect((await takeoverPipelineDelivery(successor?.pipeline?.id ?? box.id, box.id, box.publication.epoch, "Fixture recovery", null)).error).toBeUndefined();
    } else await withPipelineMutation(async (rows, persist) => {
      const current = rows.find(row => row.id === box.id)!;
      if (change === "head") current.lastPassedCommit = box.base;
      else current.delivery!.operation = { ...box.publication, id: "replacement-publication", reservationId: "replacement-reservation" };
      await persist([current]);
    });
  });
  try {
    try { await withControllerPipelineScope([box.id], () => settlePendingStageGit(box.h.ports)); } catch { /* Refusal retains newer controls. */ }
    const current = box.current();
    expect(changed).toBe(true);
    expect(current.runs[0]!.attempts[0]!.settlementPreparationWait).toBeUndefined();
    expect(current.runs[1]!.attempts).toHaveLength(0);
    if (["pause", "close", "owner", "head"].includes(change)) expect(current.delivery!.operation).toEqual(box.publication);
    if (change === "reservation") expect(current.delivery!.operation!.id).toBe("replacement-publication");
    if (change === "epoch") expect(current.delivery!.epoch).toBe(box.publication.epoch + 1);
    expect(box.pushes()).toBe(1);
  } finally { race.restore(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each([false, true])("unreadable authority parks with verified publication even if the task note fails (%s)", async noteUnavailable => {
  const box = await passedStagePublication();
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const race = await racePreparation(box, undefined, "unreadable");
  const logged = spyOn(console, "error");
  const notes = await import("./taskStatusNote");
  const note = noteUnavailable ? spyOn(notes, "writeParkedTaskNote").mockRejectedValue(new Error("fixture task note unavailable")) : undefined;
  try {
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    expect(race.reads()).toBeGreaterThan(0);
    expect(box.current().state).toBe("running");
    clock += 15 * 60_000;
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    const parked = box.current();
    expect(parked.state).toBe("needs_decision");
    expect(parked.delivery!.operation).toEqual({ ...box.publication, passedStage: false });
    expect(parked.publishedCommit).toBe(box.publication.sha);
    expect(box.pushes()).toBe(1);
    expect(parked.runs[1]!.attempts).toHaveLength(0);
    if (note) expect(note).toHaveBeenCalledTimes(1);
    if (noteUnavailable) expect(logged.mock.calls.some(args => args.includes("fixture task note unavailable"))).toBe(true);
    expect(logged.mock.calls.some(([, error]) => error?.pipelineId === box.id && error?.stageId === "build"
      && error?.attempt === 1 && error?.operationId === box.publication.id)).toBe(true);
    race.restore();
    clock = Date.parse(parked.runs[0]!.attempts[0]!.settlementPreparationWait!.retryAfter);
    expect((await patchPipeline(box.id, { action: "retry-stage" }, box.h.ports)).error).toBeUndefined();
    for (let n = 0; n < 3; n++) {
      await tickPipelinesController([], box.h.ports);
      await settlePipelineControllerJobs();
    }
    expect(box.current().cursor?.stageId).toBe("audit");
    expect(box.current().delivery!.operation!.result).toEqual(box.publication.result);
    expect(box.pushes()).toBe(1);
  } finally { race.restore(); note?.mockRestore(); logged.mockRestore(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("failed preparation cannot spend recovery or park an executing publication", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const box = await passedStagePublication({ entered: () => entered.resolve(), ready: entered.promise, wait: release.promise });
  const race = await racePreparation(box);
  try {
    expect(box.current().delivery!.operation!.state).toBe("running");
    await expect(settlePendingStageGit(box.h.ports)).rejects.toThrow();
    expect(race.reads()).toBeGreaterThan(0);
    expect(box.current().state).toBe("running");
    expect(box.current().runs[0]!.attempts[0]!.settlementPreparationWait).toBeUndefined();
    expect(box.current().delivery!.operation).toMatchObject({ id: box.publication.id, epoch: box.publication.epoch,
      sha: box.publication.sha, requestKey: box.publication.requestKey, state: "running" });
    expect(box.current().delivery!.operation!.result).toEqual(box.publication.result);
  } finally {
    race.restore(); release.resolve(); await settlePipelineControllerJobs();
    try {
      expect(box.current().delivery!.operation!.result).toMatchObject({ ok: true, remote: "published", sha: box.publication.sha });
      expect(box.pushes()).toBe(1);
    } finally { fs.rmSync(box.root, { recursive: true, force: true }); }
  }
});

test("preparation retries honor their persisted backoff without renewing the first failure clock", async () => {
  const box = await passedStagePublication();
  const start = Date.parse(box.h.ports.now());
  let clock = start;
  box.h.ports.now = () => new Date(clock).toISOString();
  const race = await racePreparation(box);
  try {
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    const first = box.current().runs[0]!.attempts[0]!.settlementPreparationWait;
    expect(first).toBeDefined();
    expect(box.current().runs[0]!.attempts[0]!.error).toBeNull();
    const reads = race.reads();
    expect(reads).toBeGreaterThan(0);
    await expect(settlePendingStageGit(box.h.ports)).rejects.toThrow();
    expect(race.reads()).toBe(reads);
    expect(box.current().runs[0]!.attempts[0]!.settlementPreparationWait).toEqual(first);
    clock = Date.parse(first!.retryAfter);
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    expect(race.reads()).toBe(reads + 1);
    expect(box.current().runs[0]!.attempts[0]!.settlementPreparationWait?.startedAt).toBe(first!.startedAt);
    clock = start + 15 * 60_000 - 1;
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    expect(box.current().state).toBe("running");
    const retained = box.current().runs[0]!.attempts[0]!.settlementPreparationWait!;
    expect(retained).toMatchObject({ startedAt: first!.startedAt, rounds: 3,
      retryAfter: new Date(clock + 60_000).toISOString(), reason: expect.stringContaining("pipeline ownership changed during preparation by pipeline") });
    clock = Date.parse(retained.retryAfter);
    await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
    expect(box.current().state).toBe("running");
    expect(box.current().runs[0]!.attempts[0]!.settlementPreparationWait).toMatchObject({ startedAt: first!.startedAt,
      rounds: 4, retryAfter: new Date(clock + 60_000).toISOString() });
    expect(box.current().delivery!.operation).toEqual(box.publication);
    expect(box.pushes()).toBe(1);
  } finally { race.restore(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["pause", "close", "owner", "epoch"] as const)("a %s during preparation supersedes its failure accounting", async change => {
  const box = await passedStagePublication();
  let changed = false;
  let successorId: string | undefined;
  const race = await racePreparation(box, async () => {
    if (changed) return;
    changed = true;
    if (change === "pause" || change === "close") {
      const result = await patchPipeline(box.id, { action: change, reason: "Fixture control" }, box.h.ports);
      expect(result.error).toBeUndefined();
    } else {
      if (change === "owner") {
        const successor = await createPipelineFromRequest({ task: "Successor", repoDir: box.repo, autoStart: false,
          stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: null }],
          publication: "remote-branch", delivery: { branch: box.current().delivery!.target.branch } }, box.h.ports);
        expect(successor.error).toBeUndefined();
        successorId = successor.pipeline!.id;
      }
      const taken = await takeoverPipelineDelivery(successorId ?? box.id, box.id, box.publication.epoch, "Fixture recovery", null);
      expect(taken.error).toBeUndefined();
    }
  });
  try {
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    const current = box.current();
    expect(changed).toBe(true);
    expect(current.runs[0]!.attempts[0]!.settlementPreparationWait).toBeUndefined();
    expect(current.runs[1]!.attempts).toHaveLength(0);
    if (change !== "epoch") expect(current.delivery!.operation).toEqual(box.publication);
    if (change === "pause") expect(current.state).toBe("paused");
    if (change === "close") expect(current.state).toBe("closed");
    if (change === "owner") {
      expect(current.delivery!.active).toBe(false);
      expect(loadPipelines().find(row => row.id === successorId)!.delivery).toMatchObject({ active: true, ownerId: successorId, epoch: box.publication.epoch + 1 });
    }
    if (change === "epoch") {
      expect(current.delivery!.epoch).toBe(box.publication.epoch + 1);
      expect(current.delivery!.operation).toBeUndefined();
    }
  } finally { race.restore(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("ownership changes retain the same retry intent in a replacement controller process", async () => {
  const box = await passedStagePublication();
  const initial = box.h.ports.now();
  box.h.ports.now = () => initial;
  const race = await racePreparation(box);
  try {
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
  } finally { race.restore(); }
  try {
    const first = structuredClone(box.current().runs[0]!.attempts[0]!.settlementPreparationWait!);
    await failPreparationInReplacementController(initial, undefined, 0);
    expect(box.current().runs[0]!.attempts[0]!.settlementPreparationWait).toEqual(first);
    const later = new Date(Date.parse(initial) + 15 * 60_000).toISOString();
    await failPreparationInReplacementController(later, undefined, 1);
    const waiting = box.current();
    expect(waiting.state).toBe("running");
    expect(waiting.delivery!.operation).toEqual(box.publication);
    expect(waiting.publishedCommit).toBe(box.publication.sha);
    expect(waiting.runs[0]!.attempts[0]!.settlementPreparationWait).toMatchObject({ startedAt: first.startedAt,
      identity: first.identity, rounds: first.rounds + 1, retryAfter: new Date(Date.parse(later) + 30_000).toISOString(),
      reason: expect.stringContaining("pipeline ownership changed during preparation by pipeline") });
    box.h.ports.now = () => waiting.runs[0]!.attempts[0]!.settlementPreparationWait!.retryAfter;
    for (let n = 0; n < 3; n++) { await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs(); }
    expect(box.current().cursor?.stageId).toBe("audit");
    expect(box.current().runs[0]!.attempts).toHaveLength(1);
    expect(box.current().runs[0]!.attempts[0]!.settlementPreparationWait).toBeUndefined();
    expect(box.current().delivery!.operation!.result).toEqual(box.publication.result);
    expect(box.pushes()).toBe(1);
  } finally { await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a fresh preparation advances the original published pass exactly once", async () => {
  const box = await passedStagePublication();
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const race = await racePreparation(box);
  try {
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
  } finally { race.restore(); }
  try {
    clock += 60_000;
    for (let n = 0; n < 3; n++) {
      await tickPipelinesController([], box.h.ports);
      await settlePipelineControllerJobs();
    }
    const advanced = box.current();
    expect(advanced.cursor?.stageId).toBe("audit");
    expect(advanced.runs[0]!.attempts).toHaveLength(1);
    expect(advanced.runs[1]!.attempts).toHaveLength(1);
    expect(advanced.delivery!.operation).toEqual(box.publication);
    expect(advanced.lastPassedCommit).toBe(box.publication.sha);
    expect(advanced.publishedCommit).toBe(box.publication.sha);
    expect(advanced.delivery!.ownerId).toBe(box.id);
    expect(advanced.delivery!.epoch).toBe(box.publication.epoch);
    expect(box.pushes()).toBe(1);
    expect(await box.git(box.worktree, "rev-parse", "HEAD")).toBe(box.publication.sha);
  } finally { await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test("a foreign head after a preparation failure cannot replace the verified publication", async () => {
  const box = await passedStagePublication();
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const race = await racePreparation(box);
  try {
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
  } finally { race.restore(); }
  try {
    await box.git(box.repo, "commit", "--allow-empty", "-m", "independent work");
    const foreign = await box.git(box.repo, "rev-parse", "HEAD");
    expect(foreign).not.toBe(box.publication.sha);
    await box.git(box.repo, "update-ref", `refs/heads/${box.current().branch}`, foreign, box.publication.sha);
    clock += 60_000;
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    const refused = box.current();
    expect(refused.state).toBe("needs_decision");
    expect(refused.lastPassedCommit).toBe(box.publication.sha);
    expect(refused.publishedCommit).toBe(box.publication.sha);
    expect(refused.delivery!.operation).toEqual({ ...box.publication, passedStage: false });
    expect(refused.runs[1]!.attempts).toHaveLength(0);
    expect(box.pushes()).toBe(1);
    expect(await box.git(box.worktree, "rev-parse", "HEAD")).toBe(foreign);
  } finally { await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});

test.each(["fresh", "exhausted", "deadline", "restart", "replacement"] as const)("a pending publication cannot bypass failed preparation (%s)", async outcome => {
  const box = await realWorktreeLane("pending-preparation", [
    { id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Build", next: "audit" },
    { id: "audit", kind: "run", role: { roleId: "reviewer" }, prompt: "Audit", next: null },
  ], "remote-branch");
  let clock = Date.parse(box.h.ports.now());
  box.h.ports.now = () => new Date(clock).toISOString();
  const held = Promise.withResolvers<void>();
  const execute = box.h.ports.exec;
  let pushes = 0;
  box.h.ports.exec = (...args) => {
    if (args[0] === "git" && args[1][0] === "push") pushes++;
    return execute(...args);
  };
  const current = () => loadPipelines().find(row => row.id === box.id)!;
  let race: Awaited<ReturnType<typeof racePreparation>> | undefined;
  try {
    fs.writeFileSync(path.join(box.worktree, "change.txt"), "accepted output\n");
    for (let n = 0; n < PIPELINE_CONTROLLER_MAX_JOBS; n++)
      expect(startPipelineControllerJob(`preparation-capacity-${n}`, () => held.promise, async () => "held")).toBe(true);
    await tickPipelinesController([finishReported(box.h, "/codex/stage-1.jsonl", "pass", "Finished")], box.h.ports);
    held.resolve(); await settlePipelineControllerJobs();
    await settlePendingStageGit(box.h.ports);
    const operation = structuredClone(current().delivery!.operation!);
    expect(operation.state).toBe("pending");
    expect(pushes).toBe(0);
    race = await racePreparation(box);
    await tickPipelinesController([], box.h.ports);
    await settlePipelineControllerJobs();
    expect(race.reads()).toBeGreaterThan(0);
    expect(current().delivery!.operation).toEqual(operation);
    expect(pushes).toBe(0);
    if (outcome === "fresh" || outcome === "deadline" || outcome === "restart") {
      const window = current().runs[0]!.attempts[0]!.settlementPreparationWait;
      expect(window).toBeDefined();
      race.restore(); race = undefined;
      clock += 60_000;
      await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
      // The native publisher promotes its pending admission to an execution.
      // Once verified, that execution must remain the original publication.
      const executed = structuredClone(current().delivery!.operation!);
      expect(executed.id).not.toBe(operation.id);
      expect(executed).toMatchObject({ requestKey: operation.requestKey, epoch: operation.epoch,
        sha: operation.sha, state: "settled", result: { ok: true, remote: "published" } });
      expect(current().runs[0]!.attempts[0]!.settlementPreparationWait?.startedAt).toBe(window!.startedAt);
      if (outcome !== "fresh") {
        clock = Date.parse(window!.startedAt) + 15 * 60_000;
        const accepted = structuredClone(current().runs[0]!.attempts[0]!);
        if (outcome === "restart") await failPreparationInReplacementController(new Date(clock).toISOString());
        else {
          race = await racePreparation(box);
          await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
          expect(race.reads()).toBeGreaterThan(0);
        }
        const waiting = current();
        expect(waiting.state).toBe("running");
        expect(waiting.delivery!.operation).toEqual(executed);
        expect(waiting.runs[0]!.attempts[0]!.settlementPreparationWait).toMatchObject({ startedAt: window!.startedAt,
          rounds: window!.rounds + 1, retryAfter: new Date(clock + 30_000).toISOString() });
        const retained = waiting.runs[0]!.attempts[0]!;
        for (const key of ["output", "verdict", "report", "definition", "n", "launchId", "conversationId", "completedAt"] as const)
          expect(retained[key]).toEqual(accepted[key]);
        expect(waiting.publishedCommit).toBe(executed.sha);
        expect(waiting.lastPassedCommit).toBe(executed.sha);
        expect(waiting.delivery!.ownerId).toBe(box.id);
        expect(waiting.delivery!.epoch).toBe(executed.epoch);
        expect(waiting.runs[1]!.attempts).toHaveLength(0);
        expect(pushes).toBe(1);
        return;
      }
      for (let n = 0; n < 2; n++) { await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs(); }
      expect(current().cursor?.stageId).toBe("audit");
      expect(current().delivery!.operation).toEqual(executed);
      expect(pushes).toBe(1);
    } else if (outcome === "replacement") {
      const window = structuredClone(current().runs[0]!.attempts[0]!.settlementPreparationWait!);
      await withPipelineMutation(async (rows, persist) => {
        const lane = rows.find(row => row.id === box.id)!;
        lane.delivery!.operation = { ...operation, id: "replacement-reservation" };
        await persist([lane]);
      });
      clock = Date.parse(window.startedAt) + 15 * 60_000;
      await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
      expect(current().state).toBe("running");
      const replacement = current().runs[0]!.attempts[0]!.settlementPreparationWait!;
      expect(replacement.identity).not.toBe(window.identity);
      expect(replacement.startedAt).toBe(new Date(clock).toISOString());
      expect(replacement.rounds).toBe(1);
      expect(current().delivery!.operation).toEqual({ ...operation, id: "replacement-reservation" });
      expect(pushes).toBe(0);
    } else {
      clock += 15 * 60_000;
      await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs();
      expect(current().state).toBe("running");
      expect(current().delivery!.operation).toEqual(operation);
      expect(current().runs[0]!.attempts[0]!.settlementPreparationWait).toMatchObject({ rounds: 2,
        retryAfter: new Date(clock + 30_000).toISOString() });
      expect(pushes).toBe(0);
      race.restore(); race = undefined;
      clock = Date.parse(current().runs[0]!.attempts[0]!.settlementPreparationWait!.retryAfter);
      for (let n = 0; n < 3; n++) { await tickPipelinesController([], box.h.ports); await settlePipelineControllerJobs(); }
      expect(current().cursor?.stageId).toBe("audit");
      expect(current().runs[0]!.attempts).toHaveLength(1);
      expect(current().lastPassedCommit).toBe(operation.sha);
      expect(current().delivery!.operation!.result).toMatchObject({ ok: true, remote: "published", sha: operation.sha });
      expect(pushes).toBe(1);
      expect(box.h.spawnInputs.filter(input => input.clientAttemptId === `pipeline_${box.id}_build_1`)).toHaveLength(1);
    }
  } finally { race?.restore(); held.resolve(); await settlePipelineControllerJobs(); fs.rmSync(box.root, { recursive: true, force: true }); }
});
