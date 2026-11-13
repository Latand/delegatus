import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as store from "@/lib/bridge/store";
import { setBridgeReports, setReportTelegram } from "@/lib/projects/settings";
import { StateLockDeferredError } from "@/lib/state/lockWait";
import { shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";
import { productionDomainDependencies, viewerMcpBindings, type ReportTelegramSend } from "./bindings";
import { createMcpToolService, createViewerMcpServer, SqliteMcpReceiptStore, type McpToolResult } from "./server";

const PROJECT = "repo-report-delivery";
const MANAGER = { kind: "manager" as const, conversationId: "conversation_report_seat", role: "orchestrator" };
const ARGS = { clientRequestId: "report-call", key: "report-key", class: "completed", summary: "The lane finished.", coversOwed: true };
const busy = () => new StateLockDeferredError("state.lease.sqlite");
type Answer = McpToolResult & {
  recorded?: boolean;
  alreadyRecorded?: boolean;
  seq?: number;
  destinations?: { telegram?: { state: string; messageIds?: number[]; bookkeeping?: { state: string } } };
};
let directory: string;
let previousState: string | undefined;
let sends: ReportTelegramSend[];
let delivered: Map<string, number[]>;
let sendBusy: boolean;
let sendGate: (() => Promise<void>) | undefined;
let policyAllowed: boolean;
let closes: Array<() => Promise<void>>;
const restores: Array<() => void> = [];

beforeEach(() => {
  previousState = process.env.LLV_STATE_DIR;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-report-delivery-"));
  process.env.LLV_STATE_DIR = path.join(directory, "state");
  setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
  sends = [];
  delivered = new Map();
  sendBusy = false;
  sendGate = undefined;
  policyAllowed = true;
  closes = [];
  setReportTelegram(PROJECT, { chat: "report-room", name: "Project" }, "operator");
  store.readBridgeReportLog();
  store.readBridgeChannel();
});

afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const close of closes.reverse()) await close();
  await shutdownTaskPageWorker();
  setSystemTime();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(directory, { recursive: true, force: true });
});

async function protocol(manager = true) {
  const bindings = viewerMcpBindings(undefined, {
    get: async () => { throw new Error("unexpected control read"); },
    post: async () => { throw new Error("unexpected control post"); },
  }, {
    ...productionDomainDependencies,
    callerProject: () => PROJECT,
    callerAttribution: () => manager ? MANAGER : { kind: "agent", conversationId: "conversation_worker", role: "builder" },
    authorizedSeats: () => [{ conversationId: MANAGER.conversationId, path: null, project: PROJECT }],
    operatorLocale: () => "en",
    operatorTimeZone: () => "UTC",
    publicDenyList: () => ({ accounts: [], people: [], local: [], projects: [] }),
    sendReportTelegram: async (input: ReportTelegramSend) => {
      sends.push(input);
      await sendGate?.();
      if (sendBusy) throw busy();
      // The fake models the bot service's durable send-key deduplication.
      if (!delivered.has(input.clientRequestId)) delivered.set(input.clientRequestId, [71]);
      return { ok: true as const, messageIds: delivered.get(input.clientRequestId)! };
    },
  });
  const receipts = new SqliteMcpReceiptStore(path.join(directory, "receipts.sqlite"));
  const server = createViewerMcpServer(createMcpToolService(bindings, receipts, {
    permit: () => policyAllowed ? { allowed: true } : { allowed: false, code: "tool_not_permitted", error: "fixture policy refusal" },
  }));
  const client = new Client({ name: "bridge-report-delivery-test", version: "1" });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    receipts.close();
  };
  closes.push(close);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const call = async (overrides: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: "bridge_report", arguments: { ...ARGS, ...overrides } });
    const answer = result.structuredContent as Answer;
    expect(result.isError === true).toBe(answer.ok === false);
    return answer;
  };
  return { call, close };
}

function deferBookkeeping(error: Error = busy()) {
  const fault = spyOn(store, "recordBridgeReportTelegram").mockImplementation(() => { throw error; });
  restores.push(() => fault.mockRestore());
  return fault;
}

test("a stored report answers success when Telegram bookkeeping is busy; retry reconciles the sent copy", async () => {
  const p = await protocol();
  const fault = deferBookkeeping();
  const answer = await p.call();
  expect(store.readBridgeReportLog().reports).toHaveLength(1);
  expect(store.readBridgeReportLog().reports[0]!.telegram!.state).toBe("pending");
  expect(delivered.size).toBe(1);
  expect(answer).toMatchObject({ ok: true, recorded: true, seq: 1,
    destinations: { telegram: { state: "sent", messageIds: [71], bookkeeping: { state: "pending" } } } });
  fault.mockRestore();
  await p.close();
  const restarted = await protocol();
  expect(await restarted.call()).toMatchObject({ ok: true, alreadyRecorded: true, seq: 1, destinations: { telegram: { state: "sent" } } });
  expect(sends[1]!.clientRequestId).toBe(sends[0]!.clientRequestId);
  expect(store.readBridgeReportLog().reports[0]!.telegram).toMatchObject({ state: "sent", messageIds: [71] });
  expect(delivered.size).toBe(1);
  const count = sends.length;
  await restarted.call();
  await restarted.call({ clientRequestId: "report-new-call" });
  expect(sends).toHaveLength(count);
  expect(store.readBridgeReportLog().reports).toHaveLength(1);
});

for (const sameRequest of [true, false]) {
  test(`a pending copy is delivered once after recovery with a ${sameRequest ? "same" : "new"} request id`, async () => {
    const p = await protocol();
    sendBusy = true;
    const fault = deferBookkeeping();
    expect(await p.call()).toMatchObject({ ok: true, recorded: true, seq: 1, destinations: { telegram: { state: "failed", bookkeeping: { state: "pending" } } } });
    expect(delivered.size).toBe(0);
    fault.mockRestore();
    sendBusy = false;
    await p.close();
    const restarted = await protocol();
    const retry = { clientRequestId: sameRequest ? ARGS.clientRequestId : "report-new-call" };
    expect(await restarted.call(retry)).toMatchObject({ ok: true, alreadyRecorded: true, seq: 1, destinations: { telegram: { state: "sent" } } });
    await restarted.call(retry);
    expect(delivered.size).toBe(1);
    expect(sends).toHaveLength(2);
    expect(sends[1]!.clientRequestId).toBe(sends[0]!.clientRequestId);
    expect(sends[1]!.html).toBe(sends[0]!.html);
    expect(store.readBridgeReportLog().reports).toHaveLength(1);
  });
}

test("a busy send keeps the recorded row and retries a failed copy once", async () => {
  const p = await protocol();
  sendBusy = true;
  expect(await p.call()).toMatchObject({ ok: true, recorded: true, seq: 1, destinations: { telegram: { state: "failed" } } });
  expect(delivered.size).toBe(0);
  sendBusy = false;
  await p.close();
  const restarted = await protocol();
  expect(await restarted.call()).toMatchObject({ ok: true, alreadyRecorded: true, seq: 1, destinations: { telegram: { state: "sent" } } });
  expect(sends[1]!.clientRequestId).toBe(`${sends[0]!.clientRequestId}:r1`);
  await restarted.call();
  expect(sends).toHaveLength(2);
  expect(delivered.size).toBe(1);
  expect(store.readBridgeReportLog().reports).toHaveLength(1);
});

test("a refusal before storing has zero effects and a new request stores the report once", async () => {
  const p = await protocol();
  const fault = spyOn(store, "appendBridgeReports").mockImplementation(() => { throw busy(); });
  restores.push(() => fault.mockRestore());
  expect(await p.call()).toMatchObject({ ok: false, retryable: true });
  expect(store.readBridgeReportLog().reports).toHaveLength(0);
  expect(sends).toHaveLength(0);
  fault.mockRestore();
  // Preserve the existing pre-write refusal receipt behaviour (#2151).
  expect(await p.call()).toMatchObject({ ok: false, replayed: true });
  expect(await p.call({ clientRequestId: "report-new-call" })).toMatchObject({ ok: true, recorded: true, seq: 1 });
  await p.call({ clientRequestId: "report-new-call" });
  expect(store.readBridgeReportLog().reports).toHaveLength(1);
  expect(sends).toHaveLength(1);
});

test("a failed copy whose successful retry cannot be recorded keeps that retry's bot key", async () => {
  const p = await protocol();
  sendBusy = true;
  await p.call();
  sendBusy = false;
  const fault = deferBookkeeping();
  expect(await p.call()).toMatchObject({ ok: true, alreadyRecorded: true, seq: 1,
    destinations: { telegram: { state: "sent", bookkeeping: { state: "pending" } } } });
  expect(store.readBridgeReportLog().reports[0]!.telegram).toMatchObject({ state: "failed", attempts: 1 });
  fault.mockRestore();
  await p.close();
  const restarted = await protocol();
  expect(await restarted.call()).toMatchObject({ ok: true, seq: 1, destinations: { telegram: { state: "sent" } } });
  expect(sends[2]!.clientRequestId).toBe(sends[1]!.clientRequestId);
  expect(delivered.size).toBe(1);
});

test("an ordinary bookkeeping failure preserves the observed delivery and its sequence", async () => {
  const p = await protocol();
  deferBookkeeping(new Error("fixture bookkeeping failure"));
  expect(await p.call()).toMatchObject({ ok: true, recorded: true, seq: 1,
    destinations: { telegram: { state: "sent", messageIds: [71], bookkeeping: { state: "pending" } } } });
  expect(store.readBridgeReportLog().reports[0]!.telegram!.state).toBe("pending");
  expect(delivered.size).toBe(1);
});

test("concurrent report-key retries share the pending copy's bot key", async () => {
  const p = await protocol();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  sendGate = async () => {
    if (sends.length === 2) entered.resolve();
    await release.promise;
  };
  const first = p.call();
  const second = p.call({ clientRequestId: "report-concurrent-call" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([entered.promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("both send calls did not enter")), 5_000);
    })]);
  } finally { clearTimeout(timer); release.resolve(); }
  expect(await first).toMatchObject({ ok: true, seq: 1 });
  expect(await second).toMatchObject({ ok: true, seq: 1 });
  expect(sends).toHaveLength(2);
  expect(sends[1]!.clientRequestId).toBe(sends[0]!.clientRequestId);
  expect(delivered.size).toBe(1);
  expect(store.readBridgeReportLog().reports).toHaveLength(1);
});

test("policy refusal on a same-request recovery sends nothing and does not replace the recorded acknowledgement", async () => {
  const p = await protocol();
  sendBusy = true;
  const fault = deferBookkeeping();
  await p.call();
  fault.mockRestore();
  sendBusy = false;
  expect(await p.call({ summary: "Changed arguments" })).toMatchObject({ ok: false, code: "idempotency_conflict" });
  expect(sends).toHaveLength(1);
  policyAllowed = false;
  expect(await p.call()).toMatchObject({ ok: false, code: "tool_not_permitted" });
  expect(sends).toHaveLength(1);
  policyAllowed = true;
  expect(await p.call()).toMatchObject({ ok: true, seq: 1, destinations: { telegram: { state: "sent" } } });
  expect(delivered.size).toBe(1);
});

for (const change of ["log-only", "chat", "topic", "reports-off", "worker"] as const) {
  test(`a pending copy is not delivered after ${change}`, async () => {
    const p = await protocol();
    sendBusy = true;
    const fault = deferBookkeeping();
    await p.call();
    fault.mockRestore();
    sendBusy = false;
    if (change === "log-only") setReportTelegram(PROJECT, null, "operator");
    if (change === "chat") setReportTelegram(PROJECT, { chat: "other-room", name: "Project" }, "operator");
    if (change === "topic") setReportTelegram(PROJECT, { chat: "report-room", name: "Project", topicId: 42 }, "operator");
    if (change === "reports-off") setBridgeReports(PROJECT, false, "operator");
    await p.close();
    const restarted = await protocol(change !== "worker");
    expect(await restarted.call({ clientRequestId: "report-new-call" })).toMatchObject({ ok: true });
    expect(sends).toHaveLength(1);
    expect(delivered.size).toBe(0);
    expect(store.readBridgeReportLog().reports[0]!.telegram!.state).toBe("pending");
  });
}
