import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextRequest } from "next/server";
import { saveTasks, loadTasks } from "@/lib/tasks/store";
import { prototypeReviewNotices, prototypeReviewReplica } from "@/lib/prototypeReview/model";
import { localRoundViews, seatDecisionNotices, withPrototypeReviewSummaries } from "@/lib/prototypeReview/read";
import { isPrototypeReplica } from "@/lib/prototypeReview/replica";
import { attemptPrototypeDelivery, refreshPrototypeDelivery } from "@/lib/prototypeReview/decision";
import { prototypeWorld } from "@/lib/prototypeReview/world";
import { mutatePrototypeRound, decisionLock } from "@/lib/prototypeReview/store";
import { insertSeatRound, findSeatRound, clearSeatRoundsForTests } from "@/lib/prototypeReview/seatRounds";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { readNeedsYou, type NeedsYouReadSources } from "@/lib/attention/needsYouRead";
import { readAttentionDismissals } from "@/lib/attention/dismissals";
import { defaultSeatTickSources, gatherSeatTickInput } from "@/lib/monitor/seatTickSources";
import { DEFAULT_SEAT_TICK_POLICY } from "@/lib/monitor/seatTick";
import { emptySeatTickState } from "@/lib/monitor/types";
import { reviewReadPOST, reviewScopePOST } from "@/lib/prototypeReview/http";
import { runAsMcpHttpCaller } from "./callerContext";
import { telegramPostSignals } from "@/lib/prototypeReview/telegramPostSignals";
import { normalizeRegistry } from "@/lib/agent/registry";
import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";
import type { PrototypeReviewRound } from "@/lib/prototypeReview/types";
import { callerAttributionFrom, viewerMcpBindings } from "./bindings";
import { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore } from "./server";

const NOW = "2026-10-20T10:00:00.000Z";
const PROJECT = "ack-project";
const ID = "pr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const seat: AttentionCallerAuthority = { kind: "worker", conversationId: "conversation_seat", role: "orchestrator" };
const target = { kind: "prototype", taskId: "task-a", reviewId: ID };
const stored = () => loadTasks()[0]!;
const notices = () => prototypeReviewNotices(withPrototypeReviewSummaries(loadTasks()));
const signals = () => telegramPostSignals(PROJECT, loadTasks(), []);
async function tickSignals() {
  const sources = { ...defaultSeatTickSources(), prepareRead: undefined, prepareMemoryProblems: undefined,
    memoryProblems: () => [], seatFor: () => ({ active: null, pending: null, history: [] }), activeSeats: () => [],
    pipelines: () => [], archivedPipelines: () => [], tasks: loadTasks, refreshLifecycle: undefined, workerCounts: undefined,
    reports: undefined, overdueTasks: () => [],
    openPullRequests: async () => ({ ok: true as const, pullRequests: [] }), diskPressure: undefined,
    latestDeployment: () => ({ state: "unreadable" as const, error: "fixture" }), now: () => Date.parse(NOW) };
  return (await gatherSeatTickInput(PROJECT, emptySeatTickState(), DEFAULT_SEAT_TICK_POLICY, sources)).signals
    .filter(signal => signal.id.startsWith("prototype-answer:"));
}

function seed() {
  setSystemTime(new Date(NOW));
  const round: PrototypeReviewRound = { id: ID, taskId: "task-a", project: PROJECT, title: "Choose delivery", createdAt: NOW,
    publicationKey: "fixture", inputDigest: "fixture", variants: [],
    questions: ["where", "when", "how"].map(id => ({ id, text: "Proceed?", options: [{ label: "Yes", recommended: true }, { label: "Later" }] })), source: { conversationId: "conversation_source" },
    decision: { chosen: [], answers: ["where", "when", "how"].map(questionId => ({ questionId, options: [0] })), originalReply: "Carry out the correction", comment: "", at: NOW, revision: 1,
      delivery: { state: "failed", conversationId: "conversation_source", clientMessageId: "fixture-answer", text: "Carry out the correction",
        operationId: "operation-failed", failures: 10, attempts: 10, failingSince: NOW } } };
  saveTasks([{ id: "task-a", project: PROJECT, text: "Carry out correction", status: "assigned", placement: "unplaced", assignments: [],
    createdAt: NOW, updatedAt: NOW, prototypeReviews: [round] }]);
}

async function protocol(authority = seat, seats = [{ conversationId: "conversation_seat", project: PROJECT }, { conversationId: "conversation_foreign-seat", project: "elsewhere" }], receipts = new MemoryMcpReceiptStore()) {
  const bindings = viewerMcpBindings(undefined, { get: async () => { throw new Error("unexpected transport read"); },
    post: async (url: string, body: Record<string, unknown>, headers?: Record<string, string>) => {
      if (url === "/api/prototype-reviews/read" || url === "/api/prototype-reviews/scope") {
        const world = { ...prototypeWorld, caller: () => ({ conversationId: "conversation_seat", project: PROJECT }), orchestrator: () => "conversation_seat" };
        const request = new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { host: "localhost", "sec-fetch-site": "same-origin", ...headers } });
        const result = await (url.endsWith("/scope") ? reviewScopePOST(request, world) : reviewReadPOST(request, world));
        const answer = await result.json();
        if (!result.ok) throw new Error(answer.error);
        return answer;
      }
      if (url !== "/api/attention/needs-you") throw new Error("unexpected delivery");
      return { ...await readNeedsYou(PROJECT, { kinds: ["prototype"], locale: "en" }, "panel", {
        board: async () => ({ files: [], pipelines: [], tasks: withPrototypeReviewSummaries(loadTasks()), seatDecisions: seatDecisionNotices(PROJECT) }),
        tasks: async () => loadTasks(), pipelines: async () => [], dismissals: async () => readAttentionDismissals().records,
      } as unknown as NeedsYouReadSources) };
    } }, {
    attentionAuthority: () => authority,
    authorizedSeats: () => seats,
    callerAttribution: () => callerAttributionFrom(authority, id => id === "conversation_seat"),
    registrySnapshot: () => normalizeRegistry({ version: 2, entries: {}, receipts: {} }),
    loadTasks, callerProject: () => PROJECT,
  } as never);
  const service = createMcpToolService(bindings, receipts);
  const server = createViewerMcpServer(service);
  const client = new Client({ name: "ack-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  let seq = 0;
  return { call: async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { clientRequestId: `ack-${++seq}`, ...args } });
    return result.structuredContent ?? { ok: false, isError: result.isError };
  },
  read: (taskId: string | null) => runAsMcpHttpCaller({ capability: "fixture-read" }, () => service.callTool("read_prototype_review", { ...(taskId ? { taskId } : {}) })),
  bindings, close: async () => { await client.close(); await server.close(); } };
}
afterEach(() => { saveTasks([]); clearSeatRoundsForTests(); setSystemTime(); });

test("current main: failed delivery blocks completion; dismissal clears the row but leaves the wake signal", async () => {
  seed();
  const p = await protocol();
  try {
    expect(notices()).toHaveLength(1);
    expect(signals()).toHaveLength(1);
    expect(await tickSignals()).toHaveLength(1);
    expect(await p.call("update_task", { taskId: "task-a", status: "done" })).toMatchObject({ ok: false, details: { code: "TASK_DECISION_UNDELIVERED" } });
    expect(await p.call("dismiss_attention", { target })).toMatchObject({ ok: true, dismissed: [{ kind: "prototype", taskId: "task-a" }] });
    expect(notices()).toHaveLength(0);
    expect(signals()).toHaveLength(1);
    expect(await tickSignals()).toHaveLength(1);
    expect(stored().prototypeReviews![0]!.decision!.delivery.state).toBe("failed");
    await p.call("dismiss_attention", { target, undo: true });
  } finally { await p.close(); }
});

const evidence = "The correction was delivered separately; its durable delivery receipt confirms completion.";
test.each(["seat", "operator", "taskless"])("%s acknowledges carried-out work once and releases every delivery consumer", async kind => {
  seed();
  const taskless = kind === "taskless";
  if (taskless) { insertSeatRound({ ...stored().prototypeReviews![0]!, taskId: null }); saveTasks([]); }
  const named = { ...target, taskId: taskless ? null : target.taskId };
  const p = await protocol(kind === "operator" ? { kind: "root", conversationId: "conversation_root" } : seat);
  try {
    expect(await p.call("dismiss_attention", { project: PROJECT })).toMatchObject({ ok: true, count: 1 });
    const args = { target: named, acknowledge: { evidence }, clientRequestId: "ack-carried-out", by: { kind: "operator" }, at: "forged" };
    const result = await p.call("dismiss_attention", args);
    const by = kind === "operator" ? { kind: "gateway", conversationId: "conversation_root", role: null }
      : { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" };
    expect(result).toMatchObject({ ok: true, acknowledgement: { evidence, at: NOW, by } });
    expect(await p.call("dismiss_attention", args)).toMatchObject({ ok: true, replayed: true });
    const round = taskless ? findSeatRound(ID)! : stored().prototypeReviews![0]!;
    expect(round.decision!.delivery).toMatchObject({ state: "acknowledged", operationId: "operation-failed", clientMessageId: "fixture-answer", acknowledgement: { evidence, at: NOW, by } });
    expect(localRoundViews([round], named.taskId)[0]!.decision!.delivery).toMatchObject({ state: "acknowledged", phase: "retired", retryable: false, acknowledgement: { evidence, at: NOW, by } });
    expect(await p.read(named.taskId)).toMatchObject({ ok: true, rounds: [{ decision: { delivery: { state: "acknowledged", retryable: false, acknowledgement: { evidence, at: NOW, by } } } }] });
    // A fresh service has no in-memory receipt: the round itself retains replay identity.
    const fresh = await protocol({ kind: "root", conversationId: "conversation_root" });
    try {
      expect(await fresh.call("dismiss_attention", { ...args, target: { ...named, reviewId: ID.slice(0, 11) }, clientRequestId: "ack-after-restart" })).toMatchObject({ ok: true, replay: true, acknowledgement: { at: NOW, by } });
      expect(await fresh.call("dismiss_attention", { target: named, acknowledge: { evidence: "Different proof" } })).toMatchObject({ ok: false, details: { code: "ACKNOWLEDGEMENT_CONFLICT" } });
    } finally { await fresh.close(); }
    let effects = 0;
    const delivery = { send: async () => { effects++; return { state: "failed" as const }; },
      retry: async () => { effects++; return { state: "failed" as const }; }, recover: async () => { effects++; return null; } };
    for (const live of [true, false]) {
      await attemptPrototypeDelivery(named.taskId, ID, { world: { ...prototypeWorld, orchestrator: () => live ? "conversation_source" : null }, now: () => Date.parse(NOW), delivery });
      await refreshPrototypeDelivery(named.taskId, ID, delivery);
    }
    expect(effects).toBe(0);
    if (taskless) {
      expect(telegramPostSignals(PROJECT, [], [findSeatRound(ID)!])).toEqual([]);
    } else {
      expect(notices()).toEqual([]);
      expect(signals()).toEqual([]);
      expect(await p.call("dismiss_attention", { project: PROJECT })).toMatchObject({ ok: true, count: 0 });
      expect(await p.call("update_task", { taskId: "task-a", status: "done" })).toMatchObject({ ok: true });
      expect(stored().status).toBe("done");
      expect(isPrototypeReplica(prototypeReviewReplica(stored()), "task-a", PROJECT)).toBe(true);
    }
    expect(await tickSignals()).toEqual([]);
  } finally { await p.close(); }
});

test.each(["worker", "foreign-seat", "unidentified"])("%s cannot acknowledge or replay another seat's acknowledgement", async kind => {
  seed();
  const receipts = new MemoryMcpReceiptStore();
  const owner = await protocol(seat, undefined, receipts);
  try { expect(await owner.call("dismiss_attention", { clientRequestId: "shared-ack", target, acknowledge: { evidence } })).toMatchObject({ ok: true }); }
  finally { await owner.close(); }
  const before = JSON.stringify(stored());
  const authority: AttentionCallerAuthority = kind === "unidentified" ? { kind: "unidentified" }
    : { kind: "worker", conversationId: `conversation_${kind}`, role: kind === "worker" ? "builder" : "orchestrator" };
  const p = await protocol(authority, undefined, receipts);
  try {
    expect(await p.call("dismiss_attention", { clientRequestId: "shared-ack", target, acknowledge: { evidence } })).toMatchObject({ ok: false, details: { code: "DISMISS_NOT_PERMITTED" } });
    expect(JSON.stringify(stored())).toBe(before);
  } finally { await p.close(); }
});

test.each(["undecided", "sent", "pending"])("%s refuses acknowledgement with a reason and retains its delivery", async kind => {
  seed();
  mutatePrototypeRound("task-a", ID, round => {
    if (kind === "undecided") delete round.decision;
    else round.decision!.delivery.state = kind as "sent" | "pending";
  });
  const before = JSON.stringify(stored());
  const p = await protocol();
  try {
    const code = kind === "undecided" ? "ROUND_UNDECIDED" : kind === "sent" ? "DELIVERY_ALREADY_SENT" : "DELIVERY_IN_PROGRESS";
    expect(await p.call("dismiss_attention", { target, acknowledge: { evidence } })).toMatchObject({ ok: false, details: { code } });
    expect(JSON.stringify(stored())).toBe(before);
    if (kind === "pending") expect(await p.call("update_task", { taskId: "task-a", status: "done" })).toMatchObject({ ok: false, details: { code: "TASK_DECISION_UNDELIVERED" } });
  } finally { await p.close(); }
});

test.each(["designation", "delivered", "project", "answer"])("a %s change while waiting for delivery's lock refuses the write", async change => {
  seed();
  const seats = [{ conversationId: "conversation_seat", project: PROJECT }];
  const p = await protocol(seat, seats);
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const owner = withFileTransaction(decisionLock(ID), "fixture lock", async () => { locked(); await hold; });
  try {
    await ready;
    // The binding's synchronous admission has passed when it yields to the
    // owned lock. Change precisely the state it admitted before releasing it.
    const pending = p.bindings.dismiss_attention({ clientRequestId: "ack-race", target, acknowledge: { evidence } });
    if (change === "designation") seats.splice(0);
    else mutatePrototypeRound("task-a", ID, round => {
      if (change === "delivered") round.decision!.delivery.state = "sent";
      else if (change === "answer") round.decision!.delivery.clientMessageId = "replacement-answer";
      else round.project = "elsewhere";
    });
    release(); await owner;
    await expect(pending).rejects.toMatchObject({ details: { code: change === "delivered" ? "DELIVERY_ALREADY_SENT" : change === "answer" ? "DECISION_CHANGED" : "DISMISS_NOT_PERMITTED" } });
    expect(stored().prototypeReviews![0]!.decision!.delivery.state).toBe(change === "delivered" ? "sent" : "failed");
  } finally { release(); await owner; await p.close(); }
});

test.each(["", " ", "x".repeat(2001), null, false])("invalid evidence is refused atomically: %j", async invalid => {
  seed();
  const before = JSON.stringify(stored());
  const p = await protocol();
  try {
    const result = await p.call("dismiss_attention", { target, acknowledge: { evidence: invalid } });
    expect(result).not.toMatchObject({ ok: true });
    expect(JSON.stringify(stored())).toBe(before);
  } finally { await p.close(); }
});

test("a new process replays the persisted acknowledgement and reads its evidence", async () => {
  seed();
  const p = await protocol();
  try {
    expect(await p.call("dismiss_attention", { target, acknowledge: { evidence } })).toMatchObject({ ok: true });
    const moduleUrl = (name: string) => JSON.stringify(new URL(name, import.meta.url).pathname);
    const code = `
      import { viewerMcpBindings, callerAttributionFrom } from ${moduleUrl("./bindings.ts")};
      import { createMcpToolService, MemoryMcpReceiptStore } from ${moduleUrl("./server.ts")};
      import { loadTasks } from ${moduleUrl("../tasks/store.ts")};
      import { localRoundViews } from ${moduleUrl("../prototypeReview/read.ts")};
      import { telegramPostSignals } from ${moduleUrl("../prototypeReview/telegramPostSignals.ts")};
      const authority = ${JSON.stringify(seat)};
      const service = createMcpToolService(viewerMcpBindings(undefined, undefined, {
        attentionAuthority: () => authority,
        authorizedSeats: () => [{conversationId: "conversation_seat", project: "ack-project"}],
        callerAttribution: () => callerAttributionFrom(authority, () => true), loadTasks,
      }), new MemoryMcpReceiptStore());
      const answer = await service.callTool("dismiss_attention", {
        clientRequestId: "ack-new-process", target: ${JSON.stringify(target)}, acknowledge: { evidence: ${JSON.stringify(evidence)} }
      });
      const task = loadTasks()[0];
      console.log(JSON.stringify({answer, delivery: localRoundViews(task.prototypeReviews, task.id)[0].decision.delivery,
        signals: telegramPostSignals("ack-project", [task], [])}));
    `;
    const child = Bun.spawn([process.execPath, "--eval", code], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, stderr: exit ? stderr : "" }).toEqual({ exit: 0, stderr: "" });
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result).toMatchObject({ answer: { ok: true, replay: true }, delivery: { state: "acknowledged", retryable: false,
        acknowledgement: { evidence, at: NOW, by: { kind: "manager", conversationId: "conversation_seat" } } }, signals: [] });
    } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); await child.exited; }
  } finally { await p.close(); }
});

test.each([{ undo: true }, { escalate: {} }, { reason: "Ordinary dismissal" }, { target: { kind: "task", taskId: "task-a" } },
  { acknowledge: { evidence, by: { kind: "operator" } } }])("conflicting or forged acknowledgement options refuse: %j", async extra => {
  seed();
  const before = JSON.stringify(stored());
  const p = await protocol();
  try {
    expect(await p.call("dismiss_attention", { target, acknowledge: { evidence }, ...extra })).toMatchObject({ ok: false });
    expect(JSON.stringify(stored())).toBe(before);
  } finally { await p.close(); }
});
