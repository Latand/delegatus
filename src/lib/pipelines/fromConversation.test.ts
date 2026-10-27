import { afterEach, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { Database } from "bun:sqlite";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { soloBrowserSession, OPERATOR_COOKIE } from "@/lib/agent/operatorSession";
import { projectForCwd } from "@/lib/scanner/describe";
import { openPinnedTranscript } from "@/lib/mcp/bindings";
import { StoreBusyBeforeAdmissionError } from "@/lib/state/fileTransaction";
import { statePath } from "@/lib/configDir";
import * as pipelineStore from "./store";
import * as messagePages from "@/lib/session/messagesPage";
import { listQueuedPipelineCreations } from "./creationQueue";
import { stageDigest } from "./stageDigest";
import { conversationExcerpt, createConversationDraft, previewConversationDraft, validateConversationDraftInput, type ConversationDraftPorts } from "./fromConversation";
import { AgentRegistry, fs, os, path, realProvisioningRepo, harness, savePipelines, saveTasks, boardTask, loadPipelines, patchPipeline, tickPipelines, realExec } from "./engine.fixture";

const owned: string[] = [];
afterEach(() => { savePipelines([]); saveTasks([]); for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

async function fixture() {
  savePipelines([]);
  const native = await realProvisioningRepo("conversation-draft");
  owned.push(native.root);
  const { repo, git } = native;
  fs.writeFileSync(path.join(repo, "tracked.txt"), "original\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "Initial fixture");
  await git(repo, "checkout", "-b", "fix/conversation-source");
  fs.appendFileSync(path.join(repo, "tracked.txt"), "source commit\n");
  await git(repo, "commit", "-am", "Source fixture");
  const head = await git(repo, "rev-parse", "HEAD");
  const transcript = path.join(native.root, "source.jsonl");
  fs.writeFileSync(transcript, [
    { type: "session_meta", payload: { cwd: repo } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Keep the original export format." }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "I inspected the exporter." }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Correction: support streaming too." }] } },
  ].map(line => JSON.stringify(line)).join("\n") + "\n");
  const registry = new AgentRegistry(path.join(native.root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const reviewed = registry.ensureConversation("codex", path.join(native.root, "reviewed.jsonl"), null).id;
  const begun = registry.beginSpawnRequest({ reviewsConversationId: reviewed, parentConversationId: reviewed, engine: "codex", cwd: repo, role: "reviewer", origin: { kind: "operator" },
    launchProfile: emptyLaunchProfile({ cwd: repo, title: "Review export handling" }) });
  if (begun.kind !== "created") throw new Error("source reservation failed");
  const settled = registry.settleSpawn(begun.receipt.launchId, { key: { engine: "codex", sessionId: "source-session" }, artifactPath: transcript,
    cwd: repo, accountId: null, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  if (settled.kind !== "settled") throw new Error("source settlement failed");
  const conversationId = settled.conversation.id;
  const project = projectForCwd(repo)!;
  const task = { ...boardTask("source-task", project), text: "Repair export handling\nKeep task details", assignments: [{
    conversationId, path: transcript, panePid: null, state: "linked" as const, error: null, at: "2026-10-27T00:00:00.000Z",
  }] };
  saveTasks([task]);
  const h = harness();
  h.ports.exec = realExec;
  h.ports.projectForCwd = projectForCwd;
  h.ports.preflightRepo = (directory) => import("./preflight").then(module => module.preflightPipelineRepo(directory));
  const ports: ConversationDraftPorts = {
    registry, exec: realExec, pipeline: h.ports, now: () => "2026-10-27T00:00:00.000Z",
    open: async pathname => openPinnedTranscript(pathname, { roots: [["codex-sessions", native.root]], pathAllowed: candidate => candidate.startsWith(native.root + path.sep) }),
    metadata: async () => ({ cwd: repo }),
  };
  const sourceGitCalls: string[][] = [];
  ports.exec = async (...args) => { sourceGitCalls.push(args[1]); return realExec(...args); };
  const request = new NextRequest("http://localhost/api/pipelines/from-conversation", { headers: { cookie: `${OPERATOR_COOKIE}=${soloBrowserSession()}` } });
  const input = { conversationId, taskId: task.id };
  const preview = () => previewConversationDraft(request, input, ports);
  const createInput = async () => ({ ...input, sourceRevision: (await preview()).source.sourceRevision, clientRequestId: "draft-request" });
  return { ...native, ...h, ports, request, input, task, registry, transcript, head, preview, createInput, sourceGitCalls };
}

test("a Reviewer conversation creates a remote-less, pinned draft on its held task without creator authority or launch", async () => {
  const f = await fixture();
  const before = JSON.stringify(f.task);
  const preview = await f.preview();
  expect(preview.source).toMatchObject({ conversationId: f.input.conversationId, branch: "fix/conversation-source", head: f.head, canCreate: true });
  expect(JSON.stringify(preview)).not.toContain("Correction:");
  const result = await createConversationDraft(f.request, await f.createInput(), f.ports);
  expect(result.status).toBe(201);
  const p = result.pipeline!;
  expect(p).toMatchObject({ state: "draft", taskIds: [f.task.id], srcPath: null, srcConversationId: null, baseBranch: "fix/conversation-source", baseRef: f.head, lastPassedCommit: f.head,
    conversationSource: { conversationId: f.input.conversationId, head: f.head, branch: "fix/conversation-source", capturedAt: "2026-10-27T00:00:00.000Z" } });
  expect(p.spec).toBeUndefined();
  expect(p.finishesTaskIds ?? []).toEqual([]);
  expect(p.stages.map(s => [s.id, s.role?.roleId, s.next])).toEqual([["builder", "builder", "reviewer"], ["reviewer", "reviewer", null]]);
  expect(p.stages[1]!.onFail).toEqual({ to: "builder", maxRounds: 2, onExhausted: "advance" });
  const text = p.stages[0]!.prompt;
  expect(text.indexOf("original export")).toBeLessThan(text.indexOf("Correction:"));
  expect(text.length).toBeLessThanOrEqual(8000);
  expect(p.runs.every(run => run.attempts.length === 0)).toBe(true);
  expect(fs.existsSync(p.worktreeDir)).toBe(false);
  expect(f.spawnInputs).toHaveLength(0);
  expect(f.sourceGitCalls.some(args => ["fetch", "push", "worktree", "init", "commit"].includes(args[0]!))).toBe(false);
  expect((await import("@/lib/tasks/store")).loadTasksByIds(new Set([f.task.id]))).toEqual([JSON.parse(before)]);
  expect((await f.git(f.repo, "rev-parse", "HEAD"))).toBe(f.head);
  const child = Bun.spawn(["bun", "-e", 'import { loadPipelines } from "./src/lib/pipelines/store.ts"; process.stdout.write(JSON.stringify(loadPipelines()[0]));'], {
    cwd: process.cwd(), env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [output, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(JSON.parse(output).conversationSource).toEqual(p.conversationSource);
});

test("Start uses commit A after the source advances to B, with one normal generated worktree and one Builder", async () => {
  const f = await fixture();
  const result = await createConversationDraft(f.request, await f.createInput(), f.ports);
  const p = result.pipeline!;
  fs.appendFileSync(path.join(f.repo, "tracked.txt"), "later\n");
  await f.git(f.repo, "commit", "-am", "Later source fixture");
  const b = await f.git(f.repo, "rev-parse", "HEAD");
  expect(b).not.toBe(f.head);
  const start = await patchPipeline(p.id, { action: "start" }, { ...f.ports.pipeline, preflightRepo: async () => ({ ok: true, repoDir: f.repo, gitCommonDir: path.join(f.repo, ".git"), worktreeParent: f.root }) });
  expect(start.error).toBeUndefined();
  await tickPipelines([], f.ports.pipeline);
  await tickPipelines([], f.ports.pipeline);
  expect(await f.git(p.worktreeDir, "rev-parse", "HEAD")).toBe(f.head);
  expect(await f.git(p.worktreeDir, "branch", "--show-current")).toBe(p.branch);
  expect(f.spawnInputs).toHaveLength(1);
  expect(f.spawnInputs[0]).toMatchObject({ cwd: p.worktreeDir, creatorConversationId: null });
  await patchPipeline(p.id, { action: "start" }, f.ports.pipeline);
  await tickPipelines([], f.ports.pipeline);
  expect(f.spawnInputs).toHaveLength(1);
});

test.each(["tracked", "untracked", "detached", "unborn", "bare", "missing", "plain", "file"])("source refusal leaves no draft or source mutation: %s", async kind => {
  const f = await fixture();
  if (kind === "tracked") fs.appendFileSync(path.join(f.repo, "tracked.txt"), "unfinished");
  if (kind === "untracked") fs.writeFileSync(path.join(f.repo, "new.txt"), "unfinished");
  if (kind === "detached") await f.git(f.repo, "checkout", "--detach");
  if (kind === "unborn") await f.git(f.repo, "checkout", "--orphan", "unborn");
  if (kind === "bare") await f.git(f.repo, "config", "core.bare", "true");
  if (kind === "plain") fs.renameSync(path.join(f.repo, ".git"), path.join(f.root, "saved-git"));
  if (kind === "missing") fs.renameSync(f.repo, path.join(f.root, "moved-repo"));
  if (kind === "file") { fs.renameSync(f.repo, path.join(f.root, "moved-repo")); fs.writeFileSync(f.repo, "regular file"); }
  if (["tracked", "untracked"].includes(kind)) {
    const preview = await f.preview();
    expect(preview.source.canCreate).toBe(false);
    await expect(createConversationDraft(f.request, { ...f.input, clientRequestId: "dirty", sourceRevision: preview.source.sourceRevision }, f.ports)).rejects.toMatchObject({ code: "SOURCE_HAS_CHANGES" });
  } else await expect(f.preview()).rejects.toMatchObject({ code: ["detached", "unborn"].includes(kind) ? "SOURCE_BRANCH_UNAVAILABLE" : "SOURCE_WORKING_COPY_UNAVAILABLE" });
  expect(loadPipelines()).toEqual([]);
  expect(f.spawnInputs).toHaveLength(0);
  if (kind === "plain") expect(fs.existsSync(path.join(f.repo, ".git"))).toBe(false);
});

test("changed branch, transcript append and inode replacement invalidate a preview", async () => {
  const f = await fixture();
  const input = await f.createInput();
  await f.git(f.repo, "checkout", "-b", "other-source");
  await expect(createConversationDraft(f.request, input, f.ports)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  await f.git(f.repo, "checkout", "fix/conversation-source");
  fs.appendFileSync(f.transcript, "\n");
  await expect(createConversationDraft(f.request, input, f.ports)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  const next = await f.createInput();
  const open = f.ports.open;
  f.ports.open = async pathname => { const pinned = await open(pathname); fs.renameSync(pathname, pathname + ".old"); fs.copyFileSync(pathname + ".old", pathname); return pinned; };
  await expect(createConversationDraft(f.request, next, f.ports)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(loadPipelines()).toEqual([]);
});

test("preview reports a tracked edit that arrives between its two Git status reads", async () => {
  const f = await fixture();
  const exec = f.ports.exec;
  let statuses = 0;
  f.ports.exec = async (...args) => {
    if (args[1][0] === "status" && ++statuses === 2) fs.appendFileSync(path.join(f.repo, "tracked.txt"), "late edit\n");
    return exec(...args);
  };
  expect((await f.preview()).source).toMatchObject({ canCreate: false, refusal: { code: "SOURCE_HAS_CHANGES" } });
});

test("rechecking after creation's asynchronous probes refuses a moved branch and revoked membership", async () => {
  for (const change of ["branch", "membership", "tracked"] as const) {
    const f = await fixture();
    const input = await f.createInput();
    const original = f.ports.exec;
    let changed = false;
    f.ports.exec = async (...args) => {
      const result = await original(...args);
      if (!changed && args[1][0] === "remote") {
        changed = true;
        if (change === "branch") await f.git(f.repo, "checkout", "-b", "moved-during-create");
        else if (change === "membership") saveTasks([{ ...f.task, assignments: [] }]);
        else fs.appendFileSync(path.join(f.repo, "tracked.txt"), "edit during creation\n");
      }
      return result;
    };
    await expect(createConversationDraft(f.request, input, f.ports)).rejects.toMatchObject({ code: change === "branch" ? "SOURCE_CHANGED" : change === "membership" ? "SOURCE_NOT_ON_TASK" : "SOURCE_HAS_CHANGES" });
    expect(changed).toBe(true);
    expect(loadPipelines()).toEqual([]);
  }
});

test("concurrent identical creates and lost-response replay preserve one saved draft and its edits after source movement", async () => {
  const f = await fixture();
  const input = await f.createInput();
  const results = await Promise.all([createConversationDraft(f.request, input, f.ports), createConversationDraft(f.request, input, f.ports)]);
  expect(new Set(results.map(r => r.pipeline?.id)).size).toBe(1);
  expect(results.map(r => r.status).sort()).toEqual([200, 201]);
  const p = loadPipelines()[0]!;
  const digest = stageDigest(p.stages[0]!);
  const saved = await patchPipeline(p.id, { action: "override-stage", stageId: "builder", expectedStageDigest: digest, prompt: "Edited saved brief" }, f.ports.pipeline);
  expect(saved.error).toBeUndefined();
  expect(saved.pipeline!.conversationSource).toEqual(p.conversationSource);
  const conflict = await patchPipeline(p.id, { action: "override-stage", stageId: "builder", expectedStageDigest: digest, prompt: "Stale edit" }, f.ports.pipeline);
  expect(conflict).toMatchObject({ status: 409, code: "STAGE_CHANGED" });
  fs.appendFileSync(f.transcript, "\n");
  await f.git(f.repo, "checkout", "-b", "later-branch");
  const replay = await createConversationDraft(f.request, input, f.ports);
  expect(replay.status).toBe(200);
  expect(replay.pipeline!.stages[0]!.prompt).toBe("Edited saved brief");
  expect(loadPipelines()).toHaveLength(1);
  expect(f.spawnInputs).toHaveLength(0);
  await expect(createConversationDraft(f.request, { ...input, sourceRevision: "f".repeat(64) }, f.ports)).rejects.toMatchObject({ code: "idempotency_conflict" });
});

test("pre-admission busy refuses without a queue or draft; identical retry creates once", async () => {
  const f = await fixture();
  const input = await f.createInput();
  const busy = spyOn(pipelineStore, "createPipelineWithDelivery").mockRejectedValueOnce(new StoreBusyBeforeAdmissionError("fixture lock busy"));
  try { await expect(createConversationDraft(f.request, input, f.ports)).rejects.toBeInstanceOf(StoreBusyBeforeAdmissionError); }
  finally { busy.mockRestore(); }
  expect(loadPipelines()).toEqual([]);
  expect(listQueuedPipelineCreations()).toEqual([]);
  expect((await createConversationDraft(f.request, input, f.ports)).status).toBe(201);
  expect(loadPipelines()).toHaveLength(1);
});

test("real storage admission rechecks task membership after all asynchronous source probes", async () => {
  const f = await fixture();
  const input = await f.createInput();
  const create = pipelineStore.createPipelineWithDelivery;
  const admission = spyOn(pipelineStore, "createPipelineWithDelivery").mockImplementation(async (...args) => {
    saveTasks([{ ...f.task, assignments: [] }]);
    return create(...args);
  });
  try { await expect(createConversationDraft(f.request, input, f.ports)).rejects.toMatchObject({ code: "SOURCE_NOT_ON_TASK" }); }
  finally { admission.mockRestore(); }
  expect(loadPipelines()).toEqual([]);
});

test("a branch switched while waiting for real storage admission cannot land a stale source", async () => {
  const f = await fixture();
  const input = await f.createInput();
  const create = pipelineStore.createPipelineWithDelivery;
  const admission = spyOn(pipelineStore, "createPipelineWithDelivery").mockImplementation(async (...args) => {
    await f.git(f.repo, "checkout", "-b", "switched-at-storage");
    return create(...args);
  });
  try { await expect(createConversationDraft(f.request, input, f.ports)).rejects.toMatchObject({ code: "SOURCE_CHANGED" }); }
  finally { admission.mockRestore(); }
  expect(loadPipelines()).toEqual([]);
});

test.each(["tracked", "untracked"])("real storage admission refuses a late %s edit without changing the source", async kind => {
  const f = await fixture();
  const input = await f.createInput();
  const file = path.join(f.repo, kind === "tracked" ? "tracked.txt" : "late-new.txt");
  const create = pipelineStore.createPipelineWithDelivery;
  const admission = spyOn(pipelineStore, "createPipelineWithDelivery").mockImplementation(async (...args) => {
    fs.appendFileSync(file, "unfinished source work\n");
    return create(...args);
  });
  try {
    await expect(createConversationDraft(f.request, input, f.ports)).rejects.toMatchObject({ status: 409, code: "SOURCE_HAS_CHANGES" });
  } finally { admission.mockRestore(); }
  expect(loadPipelines()).toEqual([]);
  expect(listQueuedPipelineCreations()).toEqual([]);
  expect(fs.readFileSync(file, "utf8")).toEndWith("unfinished source work\n");
  expect(await f.git(f.repo, "rev-parse", "HEAD")).toBe(f.head);
  expect(await f.git(f.repo, "status", "--porcelain")).toContain(kind === "tracked" ? "M tracked.txt" : "?? late-new.txt");
  expect(f.spawnInputs).toHaveLength(0);
});

test.each(["tracked", "untracked"])("a real SQLite wait repeats source validation and refuses a %s edit", async kind => {
  const f = await fixture();
  const input = await f.createInput();
  const database = new Database(statePath("state.sqlite"));
  const file = path.join(f.repo, kind === "tracked" ? "tracked.txt" : "late-new.txt");
  const exec = f.ports.exec;
  f.ports.exec = async (...args) => {
    expect(database.query("SELECT owner_token FROM state_leases WHERE collection = 'pipelines'").get()).toBeNull();
    return exec(...args);
  };
  const create = pipelineStore.createPipelineWithDelivery;
  let preparations = 0;
  let held = false;
  let change: ReturnType<typeof setImmediate> | undefined;
  const admission = spyOn(pipelineStore, "createPipelineWithDelivery").mockImplementation(async (...args) => {
    const options = args[3]!;
    const prepare = options.prepare!;
    args[3] = { ...options, prepare: async () => {
      await prepare();
      if (++preparations === 1) {
        database.exec("BEGIN IMMEDIATE");
        held = true;
        change = setImmediate(() => {
          fs.appendFileSync(file, "edit during storage wait\n");
          database.exec("ROLLBACK");
          held = false;
        });
      }
    } };
    return create(...args);
  });
  try {
    await expect(createConversationDraft(f.request, input, f.ports)).rejects.toMatchObject({ code: "SOURCE_HAS_CHANGES", status: 409 });
    expect(preparations).toBe(1); // The repeated real Git check refuses before preparation completes again.
    expect(fs.readFileSync(file, "utf8")).toEndWith("edit during storage wait\n");
    expect(loadPipelines()).toEqual([]);
    expect(listQueuedPipelineCreations()).toEqual([]);
  } finally {
    admission.mockRestore();
    if (change) clearImmediate(change);
    if (held) database.exec("ROLLBACK");
    database.close();
  }
});

test.each(["capture", "admission", "preparation"])("a duplicate waiting at %s replays the saved draft after its peer commits and the source moves", async phase => {
  const f = await fixture();
  const input = await f.createInput();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const create = pipelineStore.createPipelineWithDelivery;
  if (phase === "capture") {
    const open = f.ports.open;
    let opened = false;
    f.ports.open = async pathname => {
      const pinned = await open(pathname);
      if (!opened) { opened = true; entered.resolve(); await release.promise; }
      return pinned;
    };
  }
  let calls = 0;
  const storageErrors: unknown[] = [];
  const admission = spyOn(pipelineStore, "createPipelineWithDelivery").mockImplementation(async (...args) => {
    if (++calls === 1) {
      if (phase === "admission") { entered.resolve(); await release.promise; }
      else if (phase === "preparation") {
        const options = args[3]!;
        const prepare = options.prepare!;
        args[3] = { ...options, prepare: async () => { entered.resolve(); await release.promise; await prepare(); } };
      }
    }
    try { return await create(...args); }
    catch (error) { storageErrors.push(error); throw error; }
  });
  const waiting = createConversationDraft(f.request, input, f.ports);
  // Observe rejection immediately, including when an assertion below fails.
  const settled = waiting.then(value => ({ value }), error => ({ error }));
  try {
    await entered.promise;
    const winner = await createConversationDraft(f.request, input, f.ports);
    expect(winner.status).toBe(201);
    const saved = await patchPipeline(winner.pipeline!.id, { action: "override-stage", stageId: "builder",
      expectedStageDigest: stageDigest(winner.pipeline!.stages[0]!), prompt: "Saved while the duplicate waits" }, f.ports.pipeline);
    expect(saved.error).toBeUndefined();
    fs.appendFileSync(f.transcript, "\n");
    fs.appendFileSync(path.join(f.repo, "tracked.txt"), "source moved\n");
    release.resolve();
    const outcome = await settled;
    expect(outcome).not.toHaveProperty("error");
    if (!("value" in outcome)) throw outcome.error;
    expect(outcome.value.status).toBe(200);
    expect(outcome.value.pipeline!.id).toBe(winner.pipeline!.id);
    expect(outcome.value.pipeline!.stages[0]!.prompt).toBe("Saved while the duplicate waits");
    expect(storageErrors).toEqual([]);
    expect(loadPipelines()).toHaveLength(1);
    expect(listQueuedPipelineCreations()).toEqual([]);
    expect(f.spawnInputs).toHaveLength(0);
  } finally { release.resolve(); await settled; admission.mockRestore(); }
});

test.each(["operator", "task"])("a committed replay still rechecks live %s authority at storage admission", async kind => {
  const f = await fixture();
  const input = await f.createInput();
  const create = pipelineStore.createPipelineWithDelivery;
  let winner: string | undefined;
  let replayReturned = false;
  const admission = spyOn(pipelineStore, "createPipelineWithDelivery").mockImplementation(async (...args) => {
    const stored = await create(...args);
    winner = stored.id;
    if (kind === "operator") f.request.headers.delete("cookie");
    else saveTasks([{ ...f.task, assignments: [] }]);
    fs.appendFileSync(f.transcript, "\n");
    const replay = await create(...args);
    replayReturned = true;
    return replay;
  });
  try {
    await expect(createConversationDraft(f.request, input, f.ports)).rejects.toMatchObject({
      code: kind === "operator" ? "operator_required" : "SOURCE_NOT_ON_TASK",
    });
  } finally { admission.mockRestore(); }
  expect(loadPipelines().map(pipeline => pipeline.id)).toEqual([winner!]);
  expect(replayReturned).toBe(false);
  expect(listQueuedPipelineCreations()).toEqual([]);
});

test("cancellation after opening closes the owned descriptor and creates nothing", async () => {
  const f = await fixture();
  const input = await f.createInput();
  const controller = new AbortController();
  const req = new NextRequest(f.request.url, { headers: f.request.headers, signal: controller.signal });
  const open = f.ports.open;
  let descriptor: number | undefined;
  f.ports.open = async pathname => { const pinned = await open(pathname); descriptor = pinned?.descriptor; controller.abort(); return pinned; };
  await expect(createConversationDraft(req, input, f.ports)).rejects.toMatchObject({ code: "SOURCE_READ_TIMEOUT", status: 503 });
  expect(descriptor).toBeDefined();
  expect(() => fs.fstatSync(descriptor!)).toThrow();
  expect(loadPipelines()).toEqual([]);
});

test("an unfinished Git probe is retryable and retains no draft or creation queue", async () => {
  const f = await fixture();
  const input = await f.createInput();
  f.ports.exec = async () => ({ code: null, stdout: "", stderr: "fixture probe deadline" });
  await expect(createConversationDraft(f.request, input, f.ports)).rejects.toMatchObject({ status: 503, code: "SOURCE_READ_TIMEOUT", retryable: true });
  expect(loadPipelines()).toEqual([]);
  expect(listQueuedPipelineCreations()).toEqual([]);
});

test("source identity and task binding refuse unknown, unbound and foreign-project requests before opening content", async () => {
  const f = await fixture();
  let reads = 0;
  f.ports.open = async () => { reads++; throw new Error("must not open"); };
  await expect(previewConversationDraft(f.request, { ...f.input, conversationId: "conversation_missing" }, f.ports)).rejects.toMatchObject({ status: 404 });
  await expect(previewConversationDraft(f.request, { ...f.input, taskId: "missing-task" }, f.ports)).rejects.toMatchObject({ status: 404 });
  saveTasks([{ ...f.task, assignments: [] }]);
  await expect(f.preview()).rejects.toMatchObject({ code: "SOURCE_NOT_ON_TASK" });
  saveTasks([{ ...f.task, project: "repo-other" }]);
  await expect(f.preview()).rejects.toMatchObject({ code: "SOURCE_PROJECT_MISMATCH" });
  expect(reads).toBe(0);
});

test("canonical aliases and the latest resumed generation retain durable task membership", async () => {
  const f = await fixture();
  const snapshot = f.registry.snapshot();
  const conversation = snapshot.conversations[f.input.conversationId]!;
  const original = conversation.generations.at(-1)!;
  const latestPath = path.join(f.root, "resumed.jsonl");
  fs.copyFileSync(f.transcript, latestPath);
  conversation.generations.push({ ...original, id: "resumed-generation", path: latestPath });
  const alias = "conversation_retired_generation";
  snapshot.conversationAliases[alias] = conversation.id;
  fs.writeFileSync(f.registry.filename, JSON.stringify(snapshot));
  f.ports.registry = new AgentRegistry(f.registry.filename, undefined, undefined, { sqliteMode: "off" });
  saveTasks([{ ...f.task, assignments: f.task.assignments.map(assignment => ({ ...assignment, conversationId: alias })) }]);
  const preview = await previewConversationDraft(f.request, { ...f.input, conversationId: alias }, f.ports);
  expect(preview.source.conversationId).toBe(f.input.conversationId);
  const result = await createConversationDraft(f.request, { ...f.input, conversationId: alias, sourceRevision: preview.source.sourceRevision, clientRequestId: "alias-create" }, f.ports);
  expect(result.pipeline!.conversationSource!.conversationId).toBe(f.input.conversationId);
});

test("legacy missing cwd hydrates only the registered transcript and never falls back to the project folder", async () => {
  const f = await fixture();
  const snapshot = f.registry.snapshot();
  snapshot.conversations[f.input.conversationId]!.generations.at(-1)!.launchProfile.cwd = "";
  fs.writeFileSync(f.registry.filename, JSON.stringify(snapshot));
  f.ports.registry = new AgentRegistry(f.registry.filename, undefined, undefined, { sqliteMode: "off" });
  const paths: string[] = [];
  f.ports.metadata = async pathname => { paths.push(pathname); return undefined; };
  await expect(f.preview()).rejects.toMatchObject({ code: "SOURCE_WORKING_COPY_UNAVAILABLE" });
  expect(paths).toEqual([f.transcript]);
  f.ports.metadata = async pathname => { paths.push(pathname); return { cwd: f.repo }; };
  expect((await f.preview()).source.canCreate).toBe(true);
});

test("a registered Copilot source with launch cwd uses the same draft path", async () => {
  const f = await fixture();
  const transcript = path.join(f.root, "copilot.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "user.message", data: { content: "Preserve the Copilot export constraint" } }) + "\n");
  const conversation = f.registry.ensureConversation("copilot", transcript, null);
  const snapshot = f.registry.snapshot();
  snapshot.conversations[conversation.id]!.generations.at(-1)!.launchProfile = emptyLaunchProfile({ cwd: f.repo, title: "Copilot export review" });
  fs.writeFileSync(f.registry.filename, JSON.stringify(snapshot));
  f.ports.registry = new AgentRegistry(f.registry.filename, undefined, undefined, { sqliteMode: "off" });
  f.ports.open = async pathname => openPinnedTranscript(pathname, { roots: [["copilot-sessions", f.root]], pathAllowed: () => true });
  saveTasks([{ ...f.task, assignments: [{ ...f.task.assignments[0]!, conversationId: conversation.id, path: transcript }] }]);
  const input = { taskId: f.task.id, conversationId: conversation.id };
  const preview = await previewConversationDraft(f.request, input, f.ports);
  const result = await createConversationDraft(f.request, { ...input, sourceRevision: preview.source.sourceRevision, clientRequestId: "copilot-draft" }, f.ports);
  expect(result.pipeline!.conversationSource!.conversationId).toBe(conversation.id);
  expect(result.pipeline!.stages[0]!.prompt).toContain("Preserve the Copilot export constraint");
});

test("a parent symlink swapped after opening cannot redirect transcript capture", async () => {
  const f = await fixture();
  const originalDirectory = path.join(f.root, "original"), replacementDirectory = path.join(f.root, "replacement"), link = path.join(f.root, "linked");
  fs.mkdirSync(originalDirectory); fs.mkdirSync(replacementDirectory);
  for (const dir of [originalDirectory, replacementDirectory]) fs.copyFileSync(f.transcript, path.join(dir, "source.jsonl"));
  fs.symlinkSync(originalDirectory, link);
  const linkedPath = path.join(link, "source.jsonl");
  const snapshot = f.registry.snapshot();
  snapshot.conversations[f.input.conversationId]!.generations.at(-1)!.path = linkedPath;
  fs.writeFileSync(f.registry.filename, JSON.stringify(snapshot));
  f.ports.registry = new AgentRegistry(f.registry.filename, undefined, undefined, { sqliteMode: "off" });
  const open = f.ports.open;
  f.ports.open = async pathname => { const pinned = await open(pathname); fs.unlinkSync(link); fs.symlinkSync(replacementDirectory, link); return pinned; };
  await expect(f.preview()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(loadPipelines()).toEqual([]);
});

test("a removed source working copy makes ordinary Start refuse while retaining its saved pin", async () => {
  const f = await fixture();
  const result = await createConversationDraft(f.request, await f.createInput(), f.ports);
  fs.renameSync(f.repo, path.join(f.root, "gone-repo"));
  const start = await patchPipeline(result.pipeline!.id, { action: "start" }, f.ports.pipeline);
  expect(start.error).toBeDefined();
  expect(loadPipelines()[0]).toMatchObject({ state: "draft", baseRef: f.head, conversationSource: { head: f.head } });
});

test.each(["claude", "codex", "copilot"] as const)("visible excerpt normalizes %s with role filtering, redaction, Unicode and bounded hostile input", async engine => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-excerpt-")); owned.push(root);
  const pathname = path.join(root, "source.jsonl");
  const message = (role: string, text: string) => engine === "claude" ? { type: role, message: { role, content: [{ type: "text", text }] } }
    : engine === "copilot" ? { type: `${role}.message`, data: { content: text } }
    : { type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } };
  const sensitive = `${["api", "key"].join("_")}=fixture-value`;
  fs.writeFileSync(pathname, [message("user", `Keep Unicode 😀 and {{task}} literal. ${sensitive}`),
    message("system", "private system record"),
    message("assistant", "😀".repeat(1200)), message("user", "Latest correction")].map(line => JSON.stringify(line)).join("\n") + "\n");
  const pinned = openPinnedTranscript(pathname, { roots: [["codex-sessions", root]], pathAllowed: () => true })!;
  try {
    const result = conversationExcerpt(pinned, engine);
    expect(result.recent.some(record => record.text.includes("Latest correction"))).toBe(true);
    expect(result.recent.some(record => record.role === "system")).toBe(false);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("{{task}}");
    expect(JSON.stringify(result)).not.toContain("fixture-value");
    expect(JSON.stringify(result)).toContain("[redacted]");
    expect(result.recent.every(record => record.text.length <= 700 && !/[\uD800-\uDBFF]$/.test(record.text))).toBe(true);
  } finally { fs.closeSync(pinned.descriptor); }
  fs.writeFileSync(pathname, JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "private tool evidence".repeat(100_000) } }) + "\n");
  const hostile = openPinnedTranscript(pathname, { roots: [["codex-sessions", root]], pathAllowed: () => true })!;
  const reads = spyOn(messagePages, "readMessagesPage");
  try {
    expect(() => conversationExcerpt(hostile, engine)).toThrow("source has no visible");
    const charged = reads.mock.results.reduce((sum, value) => sum + (value.value as messagePages.MessagesPage).scanned.bytes, 0);
    expect(charged + Math.min(hostile.stat.size, 64 * 1024)).toBeLessThanOrEqual(1024 * 1024);
  } finally { reads.mockRestore(); fs.closeSync(hostile.descriptor); }
});

test("strict request fields refuse client-selected source content and malformed identifiers", () => {
  const valid = { conversationId: "conversation_source", taskId: "task-source", sourceRevision: "a".repeat(64), clientRequestId: "request-a" };
  expect(validateConversationDraftInput(valid, true)).toEqual(valid);
  for (const key of ["repoDir", "path", "branch", "task", "stages", "autoStart"]) expect(() => validateConversationDraftInput({ ...valid, [key]: "injected" }, true)).toThrow("unsupported");
  for (const value of [null, 4, [], {}, "", "a".repeat(129)]) expect(() => validateConversationDraftInput({ ...valid, clientRequestId: value }, true)).toThrow();
});

test("excerpt pages share a one MiB allowance and preserve the first request beside the latest correction", async () => {
  const f = await fixture();
  const original = fs.readFileSync(f.transcript, "utf8");
  const row = (role: string, text: string) => JSON.stringify({ type: "event_msg", payload: { type: role === "user" ? "user_message" : "agent_message", message: text } }) + "\n";
  fs.appendFileSync(f.transcript, Array.from({ length: 10 }, (_, index) => row("assistant", `Observation ${index}`)).join("") + row("user", "Final correction"));
  const pinned = await f.ports.open(f.transcript);
  const read = spyOn(messagePages, "readMessagesPage");
  try {
    const result = conversationExcerpt(pinned!, "codex");
    expect(result.first).toContain("original export format");
    expect(result.recent.at(-1)!.text).toBe("Final correction");
    expect(result.recent).toHaveLength(6);
    expect(result.truncated).toBe(true);
    expect(read.mock.calls.length).toBeLessThanOrEqual(4);
    const charged = read.mock.results.reduce((sum, value) => sum + (value.value as messagePages.MessagesPage).scanned.bytes, 0);
    expect(charged + Math.min(fs.fstatSync(pinned!.descriptor).size, 64 * 1024)).toBeLessThanOrEqual(1024 * 1024);
    expect(original).toContain("original export format");
  } finally { read.mockRestore(); fs.closeSync(pinned!.descriptor); }
});

test("empty visible rows cannot make excerpt capture read more than four pages", async () => {
  const f = await fixture();
  fs.appendFileSync(f.transcript, Array.from({ length: 40 }, () => JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: " ".repeat(701) + "outside the excerpt" } })).join("\n") + "\n");
  const pinned = await f.ports.open(f.transcript);
  const read = spyOn(messagePages, "readMessagesPage");
  try {
    const result = conversationExcerpt(pinned!, "codex");
    expect(read.mock.calls).toHaveLength(4);
    expect(result.first).toContain("original export format");
    expect(result.truncated).toBe(true);
    expect(result.recent).toEqual([]);
  } finally { read.mockRestore(); fs.closeSync(pinned!.descriptor); }
});
