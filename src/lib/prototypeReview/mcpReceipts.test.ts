/*
 * The prototype tools through the MCP service and its durable SQLite receipts,
 * dispatched into the production Viewer handlers. Two agents may pick the same
 * clientRequestId: the receipt belongs to the caller and the task the Viewer
 * resolved for it, so neither can read, or publish as, the other. A publication
 * whose process stopped before its receipt settled is answered from the round
 * it recorded, even once its source files are gone.
 */
import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import * as bot from "@/lib/telegram/bot/service";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Database } from "bun:sqlite";
import { NextRequest } from "next/server";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { loadTasks, saveTasks } from "@/lib/tasks/store";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import { viewerMcpBindings, productionViewerControlDependencies } from "@/lib/mcp/bindings";
import { deadlineSignal } from "@/lib/deadline";
import { viewerLoopMonitor } from "@/lib/viewerLoopMonitor";
import { stateLockWaitsInFlight } from "@/lib/state/lockWait";
import { runAsMcpHttpCaller } from "@/lib/mcp/callerContext";
import { createMcpToolService, SqliteMcpReceiptStore, type McpReceiptStore, type McpToolResult } from "@/lib/mcp/server";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { publishPOST, reviewPOST, reviewReadPOST, reviewScopePOST, resendTelegramPOST } from "./http";
import { prototypeWorld, type PrototypeWorld } from "./world";
import { criticLane } from "./criticGate.fixture";
import { insertSeatRound } from "./seatRounds";

const PNG = Buffer.from([137,80,78,71,13,10,26,10]);
const CAPABILITY = { a: "a".repeat(43), b: "b".repeat(43) } as const;
const CALLERS: Record<string, { conversationId: string; project: string }> = {
  [CAPABILITY.a]: { conversationId: "conversation_agent_a", project: "project-a" },
  [CAPABILITY.b]: { conversationId: "conversation_agent_b", project: "project-b" },
};
const roots: string[] = [];
let sandbox = "";
let dispatches: string[] = [];

function task(id: string, project: string) {
  return { id, project, status: "inbox" as const, placement: "unplaced" as const, text: id, assignments: [], sources: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" };
}
function request(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { host: "localhost", "sec-fetch-site": "same-origin", ...headers } });
}
function world(callers = CALLERS): PrototypeWorld {
  return { ...prototypeWorld, orchestrator: () => null, caller: req => {
    const capability = req.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER);
    if (!capability) return { conversationId: null, project: null };
    const caller = callers[capability];
    if (!caller) throw new Error("unknown capability");
    return caller;
  } };
}
/** The Viewer routes the MCP bindings reach, answering as the HTTP control does. */
function control(prototype = world()) {
  return { post: async (url: string, body: Record<string, unknown>, headers?: Record<string, string>) => {
    const req = request(url, body, headers);
    const route = url.endsWith("/telegram") ? resendTelegramPOST : url.endsWith("/read") ? reviewReadPOST : url.endsWith("/scope") ? reviewScopePOST : publishPOST;
    dispatches.push(url);
    const caller = prototype.caller(req);
    const heldStage = caller.conversationId ? prototype.stage(caller.conversationId) : null;
    const stage = heldStage ?? { taskIds: [String(body.taskId)], project: caller.project!, source: { conversationId: caller.conversationId, pipelineId: "prototype-lane", stageId: "publish" } };
    const publication = { ...prototype, stage: () => stage, pipeline: (id: string) => {
      const lane = criticLane(); lane.id = id;
      if (!lane.stages.some(s => s.id === stage.source.stageId)) lane.stages.push({ ...lane.stages[0]!, id: stage.source.stageId! });
      return lane;
    } };
    const response = await route(req, route === publishPOST ? publication : prototype);
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error ?? `HTTP ${response.status}`);
    return answer;
  } };
}
const receiptFile = () => path.join(sandbox, "mcp-receipts.sqlite");
function service(store: McpReceiptStore = new SqliteMcpReceiptStore(receiptFile()), prototype = world()) {
  return createMcpToolService(viewerMcpBindings(undefined, control(prototype)), store);
}
/** One call as the agent presenting `capability`, read as the plain answer it is. */
const as = (capability: string, call: () => Promise<McpToolResult>) => runAsMcpHttpCaller({ capability }, call) as Promise<Record<string, unknown>>;
async function frames(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.HOME!, "prototype-receipt-source-")); roots.push(root);
  await fs.writeFile(path.join(root, "new.png"), PNG);
  return root;
}
async function input(key: string, taskId?: string) {
  const root = await frames();
  return { clientRequestId: key, ...(taskId ? { taskId } : {}), title: "Layout", variants: [
    { number: 1, name: "Compact", description: "Keeps the controls together.", frames: [{ path: path.join(root, "new.png"), caption: "Compact controls" }] },
  ] };
}
const rounds = (taskId: string) => loadTasks().find(t => t.id === taskId)?.prototypeReviews ?? [];

async function reached(phase: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([phase, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("publication phase was not reached")), 5_000); })]);
  } finally { clearTimeout(timer!); }
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "prototype-receipts-")); roots.push(sandbox);
  dispatches = [];
  saveTasks([task("task-a", "project-a"), task("task-b", "project-b"), task("task-a2", "project-a")]);
});
afterEach(async () => { savePipelines([]); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

test("another project's caller replaying a review read under the same key learns nothing of it", async () => {
  const published = await as(CAPABILITY.a, async () => service().callTool("publish_prototype_review", await input("publish-a", "task-a")));
  expect(published).toMatchObject({ ok: true, taskId: "task-a" });
  const decided = await reviewPOST(request("/api/tasks/task-a/prototypes", { reviewId: published.reviewId, chosen: [1], comment: "Private comment of project A" }, { cookie: `llv_operator=${soloBrowserSession()}` }), "task-a", world());
  expect(decided.status).toBe(200);
  const args = { clientRequestId: "read-review", taskId: "task-a" };
  const first = await as(CAPABILITY.a, () => service().callTool("read_prototype_review", args));
  expect(JSON.stringify(first)).toContain("Private comment of project A");

  // A new MCP service over the reopened receipt store, as another agent's process would be.
  const foreign = await as(CAPABILITY.b, () => service().callTool("read_prototype_review", args));
  expect(foreign.ok).toBe(false);
  expect(foreign.replayed).not.toBe(true);
  expect(JSON.stringify(foreign)).not.toContain("Private comment of project A");
  const fresh = await as(CAPABILITY.b, () => service().callTool("read_prototype_review", { taskId: "task-a" }));
  expect(fresh.ok).toBe(false);

  // The caller that read it gets the same answer again.
  const again = await as(CAPABILITY.a, () => service().callTool("read_prototype_review", args));
  expect(again).toMatchObject({ ok: true, replayed: true });
  expect(JSON.stringify(again)).toContain("Private comment of project A");
});

test("MCP publication posts and resend is fenced before receipt replay and idempotent across processes", async () => {
  const keys: string[] = [];
  const sender = spyOn(bot.TelegramBotService.prototype, "sendOwnerReview").mockImplementation(async input => {
    keys.push(input.clientRequestId);
    return { alreadySent: false, sentAt: "2026-10-13T00:00:00Z", parts: 1, messageIds: [10], chat: "fixture", chatId: "41", attributedTo: { unidentified: true } };
  });
  try {
    const published = await as(CAPABILITY.a, async () => service().callTool("publish_prototype_review", await input("telegram-publication", "task-a")));
    expect(published.ok).toBe(true);
    expect(keys).toEqual([String(published.reviewId)]);
    expect(rounds("task-a")[0]).toMatchObject({ telegramPost: { state: "sent" } });
    const args = { clientRequestId: "resend-one", reviewId: published.reviewId };
    const first = await as(CAPABILITY.a, () => service().callTool("resend_prototype_review_telegram", args));
    expect(first).toMatchObject({ ok: true, telegramPost: { state: "sent" } });
    const again = await as(CAPABILITY.a, () => service().callTool("resend_prototype_review_telegram", args));
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(keys).toHaveLength(2);
    const foreign = await as(CAPABILITY.b, () => service().callTool("resend_prototype_review_telegram", args));
    expect(foreign.ok).toBe(false);
    expect(JSON.stringify(foreign)).not.toContain("telegramPost");
    expect(keys).toHaveLength(2);
    // A fresh request intentionally sends another copy.
    expect((await as(CAPABILITY.a, () => service().callTool("resend_prototype_review_telegram", { ...args, clientRequestId: "resend-two" }))).ok).toBe(true);
    expect(keys).toHaveLength(3);
    const seatRound = { ...rounds("task-a")[0]!, id: `pr_${"c".repeat(32)}`, taskId: null, publicationKey: "seat-telegram", inputDigest: "seat-telegram" };
    insertSeatRound(seatRound);
    expect((await as(CAPABILITY.a, () => service().callTool("resend_prototype_review_telegram", { reviewId: seatRound.id, clientRequestId: "seat-resend" }))).ok).toBe(true);
    expect((await as(CAPABILITY.b, () => service().callTool("resend_prototype_review_telegram", { reviewId: seatRound.id, clientRequestId: "seat-resend" }))).ok).toBe(false);
    expect(keys).toHaveLength(4);
  } finally { sender.mockRestore(); }
});

test("each pipeline publishes on its own task under the same key, sequentially and in parallel", async () => {
  const role = { roleId: "builder" as const, engine: "codex" as const, model: null, effort: null, access: "read-write" as const, promptScaffold: "Build" };
  const pipeline = (id: string, taskId: string, conversationId: string) => {
    const built = buildPipeline({ id, task: id, taskIds: [taskId], project: "project-a", repoDir: "/repo",
      stages: [{ id: "design", kind: "run", role: { roleId: "builder" }, prompt: "Design", next: null, effectiveRole: role }], srcPath: null, srcConversationId: null, now: new Date().toISOString() });
    built.runs[0]!.attempts.push({ n: 1, state: "running", conversationId, launchId: `launch_${id}`, effectiveRole: role,
      sessionId: null, agentPath: null, paneId: null, flowId: null, expectedReviewHeadSha: null, reviewHeadSha: null,
      startedAt: new Date().toISOString(), completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null });
    return built;
  };
  savePipelines([pipeline("pipeline-a", "task-a", "conversation_agent_a"), pipeline("pipeline-a2", "task-a2", "conversation_agent_b")]);
  const sameProject = world({ ...CALLERS, [CAPABILITY.b]: { conversationId: "conversation_agent_b", project: "project-a" } });
  const args = await input("publish-design");

  const a = await as(CAPABILITY.a, () => service(undefined, sameProject).callTool("publish_prototype_review", args));
  const b = await as(CAPABILITY.b, () => service(undefined, sameProject).callTool("publish_prototype_review", args));
  expect(a).toMatchObject({ ok: true, taskId: "task-a" });
  expect(b).toMatchObject({ ok: true, taskId: "task-a2", replayed: false });
  expect(rounds("task-a")).toHaveLength(1);
  expect(rounds("task-a2")).toHaveLength(1);
  expect(rounds("task-a2")[0]!.id).toBe(b.reviewId as string);

  const replay = await as(CAPABILITY.a, () => service(undefined, sameProject).callTool("publish_prototype_review", args));
  expect(replay).toMatchObject({ ok: true, replayed: true, reviewId: a.reviewId, taskId: "task-a" });
  expect(rounds("task-a")).toHaveLength(1);

  // Both callers in flight at once in one service under one key.
  const parallelArgs = await input("publish-parallel");
  const shared = service(undefined, sameProject);
  const [pa, pb] = await Promise.all([
    as(CAPABILITY.a, () => shared.callTool("publish_prototype_review", parallelArgs)),
    as(CAPABILITY.b, () => shared.callTool("publish_prototype_review", parallelArgs)),
  ]);
  expect(pa).toMatchObject({ ok: true, taskId: "task-a" });
  expect(pb).toMatchObject({ ok: true, taskId: "task-a2" });
  expect(rounds("task-a")).toHaveLength(2);
  expect(rounds("task-a2")).toHaveLength(2);
});

class StoppedProcess extends Error {}
/** The receipt store as a process sees it that stops at `at`: the row it wrote stays exactly as SQLite holds it. */
function stoppingAt(at: "claim" | "complete"): SqliteMcpReceiptStore {
  const store = new SqliteMcpReceiptStore(receiptFile());
  if (at === "claim") {
    const claim = store.claim.bind(store);
    store.claim = (...args) => { claim(...args); throw new StoppedProcess("stopped after its claim, before dispatch"); };
  } else {
    store.complete = () => { throw new StoppedProcess("stopped between the round's write and the receipt's completion"); };
  }
  return store;
}

test("a publication whose process stopped after the round was written answers with that round, once its sources are gone", async () => {
  const args = await input("publish-stopped", "task-a");
  const stopped = stoppingAt("complete");
  await expect(as(CAPABILITY.a, () => service(stopped).callTool("publish_prototype_review", args))).rejects.toBeInstanceOf(StoppedProcess);
  stopped.close();
  expect(rounds("task-a")).toHaveLength(1);
  const recorded = rounds("task-a")[0]!.id;
  for (const root of roots.filter(root => root !== sandbox)) await fs.rm(root, { recursive: true, force: true });

  const recovered = await as(CAPABILITY.a, () => service().callTool("publish_prototype_review", args));
  expect(recovered).toMatchObject({ ok: true, reviewId: recorded, taskId: "task-a" });
  const replayed = await as(CAPABILITY.a, () => service().callTool("publish_prototype_review", args));
  expect(replayed).toMatchObject({ ok: true, replayed: true, reviewId: recorded });
  expect(rounds("task-a")).toHaveLength(1);

  const changed = await as(CAPABILITY.a, () => service().callTool("publish_prototype_review", { ...args, title: "Another layout" }));
  expect(changed).toMatchObject({ ok: false, code: "idempotency_conflict" });
  expect(rounds("task-a")).toHaveLength(1);
});

test("a publication whose process stopped before dispatch publishes once on the retry", async () => {
  const args = await input("publish-before-dispatch", "task-a");
  const stopped = stoppingAt("claim");
  await expect(as(CAPABILITY.a, () => service(stopped).callTool("publish_prototype_review", args))).rejects.toBeInstanceOf(StoppedProcess);
  stopped.close();
  expect(rounds("task-a")).toHaveLength(0);
  expect(dispatches.filter(url => url === "/api/prototype-reviews")).toHaveLength(0);

  const first = await as(CAPABILITY.a, () => service().callTool("publish_prototype_review", args));
  expect(first).toMatchObject({ ok: true, taskId: "task-a" });
  const second = await as(CAPABILITY.a, () => service().callTool("publish_prototype_review", args));
  expect(second).toMatchObject({ ok: true, replayed: true, reviewId: first.reviewId });
  expect(rounds("task-a")).toHaveLength(1);
});

/** Real fetch/abort handling, an ephemeral listener, and the production route
    and SQLite receipts. No request can reach an installed Viewer. */
async function overHttp(run: (call: (args: Record<string, unknown>, budgetMs: number) => Promise<Record<string, unknown>>) => Promise<void>,
  respond: (url: string, answer: Record<string, unknown>) => Response = (_url, answer) => Response.json(answer)) {
  const previous = process.env.LLV_VIEWER_CONTROL_URL;
  const pending = new Set<Promise<Response>>();
  const routes = control();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, fetch(req) {
    const response = (async () => {
      const body = await req.json() as Record<string, unknown>;
      const url = new URL(req.url).pathname;
      try { return respond(url, await routes.post(url, body, Object.fromEntries(req.headers))); }
      catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
    })();
    pending.add(response);
    void response.finally(() => pending.delete(response));
    return response;
  } });
  process.env.LLV_VIEWER_CONTROL_URL = server.url.origin;
  const stores: SqliteMcpReceiptStore[] = [];
  try {
    await run(async (args, budgetMs) => {
      const deadline = deadlineSignal(budgetMs);
      const store = new SqliteMcpReceiptStore(receiptFile()); stores.push(store);
      // Each retry reopens the durable receipt, like a reconnected MCP client.
      const client = createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true)), store);
      try { return await as(CAPABILITY.a, () => client.callTool("publish_prototype_review", args, { deadlineAt: Date.now() + budgetMs, signal: deadline.signal })); }
      finally { deadline.release(); }
    });
  } finally {
    await Promise.all(pending);
    await server.stop(true);
    for (const store of stores) store.close();
    if (previous === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
    else process.env.LLV_VIEWER_CONTROL_URL = previous;
  }
}

async function largeInput() {
  const root = await frames();
  const raw = Buffer.alloc(256 * 200 * 3);
  let seed = 123456;
  for (let i = 0; i < raw.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; raw[i] = seed >>> 24; }
  const variants = Array.from({ length: 4 }, (_, i) => ({ number: i + 1, name: `Layout ${i + 1}`, description: "A complete layout.", frames: [] as { path: string; caption: string }[] }));
  let bytes = 0;
  for (let i = 0; i < 135; i++) {
    raw.writeUInt32LE(i, 0);
    const png = await sharp(raw, { raw: { width: 256, height: 200, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    const filename = path.join(root, `frame-${i}.png`);
    await fs.writeFile(filename, png); bytes += png.length;
    variants[i % 4]!.frames.push({ path: filename, caption: `Frame ${i + 1}` });
  }
  expect(bytes).toBeGreaterThanOrEqual(20_000_000);
  return { clientRequestId: "large-publication", taskId: "task-a", title: "Large layout review", variants };
}

test("135 PNG frames totaling 20 MB publish successfully while Telegram takes longer than the old control budget", async () => {
  const args = await largeInput();
  let sends = 0, pulses = 0;
  let phase: string | undefined;
  const pulse = setInterval(() => { pulses++; }, 10);
  const sender = spyOn(bot.TelegramBotService.prototype, "sendOwnerReview").mockImplementation(async () => {
    sends++; phase = viewerLoopMonitor.current();
    await Bun.sleep(13_000);
    return { alreadySent: false, sentAt: "2026-10-15T00:00:00Z", parts: 1, messageIds: [10], chat: "fixture", chatId: "41", attributedTo: { unidentified: true } };
  });
  try {
    await overHttp(async call => {
      const first = await call(args, 30_000);
      expect(first).toMatchObject({ ok: true, frames: 135, variants: 4 });
      expect(first.reviewId).toBe(rounds("task-a")[0]!.id);
      expect(rounds("task-a")).toHaveLength(1);
      expect(rounds("task-a")[0]!.telegramPost?.state).toBe("sent");
      expect(await call(args, 30_000)).toMatchObject({ ok: true, replayed: true, reviewId: first.reviewId });
    });
    expect(sends).toBe(1);
    expect(phase).toBe("prototype.telegram");
    expect(pulses).toBeGreaterThan(0);
  } finally { clearInterval(pulse); sender.mockRestore(); }
}, 40_000);

test("a timed out publication stays recoverable under its original key and returns exactly one review", async () => {
  const args = await input("wait-expired", "task-a");
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const sending = new Promise<void>(resolve => { entered = resolve; });
  const sender = spyOn(bot.TelegramBotService.prototype, "sendOwnerReview").mockImplementation(async () => {
    entered(); await held;
    return { alreadySent: false, sentAt: "2026-10-15T00:00:00Z", parts: 1, messageIds: [10], chat: "fixture", chatId: "41", attributedTo: { unidentified: true } };
  });
  try {
    await overHttp(async call => {
      try {
        const first = call(args, 1_000);
        await reached(sending);
        const waiting = await first;
        expect(waiting).toMatchObject({ ok: false, code: "publication_in_progress", retryable: true, details: { nextAction: "retry-same-key", outcome: "unknown" } });
        const recorded = rounds("task-a")[0]!.id;
        // A retry while the same send is still held remains open too.
        expect(await call(args, 1_000)).toMatchObject({ ok: false, code: "publication_in_progress", retryable: true });
        const db = new Database(receiptFile(), { readonly: true });
        try { expect(db.query("SELECT result_json FROM mcp_receipts").all()).toEqual([{ result_json: null }]); }
        finally { db.close(); }
        release();
        const retry = await call(args, 30_000);
        expect(retry).toMatchObject({ ok: true, reviewId: recorded });
        expect(await call(args, 30_000)).toMatchObject({ ok: true, replayed: true, reviewId: recorded });
        expect(rounds("task-a")).toHaveLength(1);
        expect(sender).toHaveBeenCalledTimes(1);
      } finally { release(); }
    });
  } finally { sender.mockRestore(); }
}, 15_000);

test("a wait expiring during media copy is recovered after the original request commits", async () => {
  const args = await input("copy-wait-expired", "task-a");
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const copying = new Promise<void>(resolve => { entered = resolve; });
  const write = fs.writeFile.bind(fs);
  let copies = 0;
  const slowCopy = spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
    if (String(file).includes(`${path.sep}.publish-`) && String(file).endsWith(".png")) { copies++; entered(); await held; }
    return write(file, data, options);
  });
  const sender = spyOn(bot.TelegramBotService.prototype, "sendOwnerReview").mockResolvedValue(null);
  try {
    await overHttp(async call => {
      try {
        const first = call(args, 1_000);
        await reached(copying);
        expect(await first).toMatchObject({ ok: false, code: "publication_in_progress" });
        expect(rounds("task-a")).toHaveLength(0);
        const retry = call(args, 30_000);
        release();
        const result = await retry;
        expect(result).toMatchObject({ ok: true });
        expect(rounds("task-a")).toHaveLength(1);
        expect(result.reviewId).toBe(rounds("task-a")[0]!.id);
        expect(copies).toBe(1);
      } finally { release(); }
    });
  } finally { slowCopy.mockRestore(); sender.mockRestore(); }
}, 15_000);

test("legacy retryable publication errors recover the stored round without its source files", async () => {
  const args = await input("legacy-wait-expired", "task-a");
  const store = new SqliteMcpReceiptStore(receiptFile());
  const complete = store.complete.bind(store);
  store.complete = (key, digest, result, retention) => complete(key, digest, {
    ok: false, toolName: "publish_prototype_review", clientRequestId: args.clientRequestId, replayed: false,
    code: "tool_failed", error: "Viewer control did not reconnect after 3 attempts (attempt timed out)", retryable: true,
  }, retention);
  const original = await as(CAPABILITY.a, () => service(store).callTool("publish_prototype_review", args));
  store.close();
  for (const root of roots.filter(root => root !== sandbox)) await fs.rm(root, { recursive: true, force: true });
  expect(await as(CAPABILITY.a, () => service().callTool("publish_prototype_review", args))).toMatchObject({ ok: true, reviewId: original.reviewId });
  expect(await as(CAPABILITY.a, () => service().callTool("publish_prototype_review", args))).toMatchObject({ ok: true, replayed: true, reviewId: original.reviewId });
  expect(rounds("task-a")).toHaveLength(1);
});

test("a lost publication response remains open until a retry receives the real review id", async () => {
  const args = await input("lost-publication-response", "task-a");
  let loseResponse = true;
  await overHttp(async call => {
    expect(await call(args, 30_000)).toMatchObject({ ok: false, code: "publication_in_progress" });
    const recorded = rounds("task-a")[0]!.id;
    expect(await call(args, 30_000)).toMatchObject({ ok: true, reviewId: recorded });
    expect(rounds("task-a")).toHaveLength(1);
  }, (url, answer) => {
    if (url === "/api/prototype-reviews" && loseResponse) { loseResponse = false; return Response.json(null); }
    return Response.json(answer);
  });
});

test("publication state writes wait for a peer SQLite lock while an independent timer advances", async () => {
  const args = await input("contended-publication", "task-a");
  const ready = path.join(sandbox, "holder.ready");
  const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../state/lockWait.fixture.ts"), "hold",
    path.join(process.env.LLV_STATE_DIR!, "state.sqlite"), ready, path.join(sandbox, "go"), "500"],
  { env: { ...process.env, NODE_ENV: "test", LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stdout: "pipe", stderr: "pipe" });
  let waitingTicks = 0;
  const timer = setInterval(() => { if (stateLockWaitsInFlight().length) waitingTicks++; }, 5);
  try {
    const deadline = Date.now() + 5_000;
    while (!await fs.stat(ready).then(() => true, () => false)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error("SQLite peer did not become ready");
      await Bun.sleep(5);
    }
    const result = await as(CAPABILITY.a, () => service().callTool("publish_prototype_review", args));
    expect(result).toMatchObject({ ok: true });
    expect(waitingTicks).toBeGreaterThan(5);
    expect(await child.exited).toBe(0);
  } finally {
    clearInterval(timer);
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 10_000);
