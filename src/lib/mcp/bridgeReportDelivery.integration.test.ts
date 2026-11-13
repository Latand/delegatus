import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as telegramPost } from "@/app/api/telegram/bot/agent/route";
import * as deputies from "@/lib/orchestrator/deputies";
import * as authority from "@/lib/orchestrator/authority";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_ENV, VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as store from "@/lib/bridge/store";
import { setBridgeReports, setReportTelegram } from "@/lib/projects/settings";
import { StateLockDeferredError } from "@/lib/state/lockWait";
import { shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";
import { productionDomainDependencies, productionViewerControlDependencies, viewerMcpBindings, type ReportTelegramSend } from "./bindings";
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
let sendRefusal: string | null;
let sendGate: (() => Promise<void>) | undefined;
let policyAllowed: boolean;
let wireControl: boolean;
let activeManagerId: string;
let activeDeputyId: string | null;
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
  sendRefusal = null;
  sendGate = undefined;
  policyAllowed = true;
  closes = [];
  activeManagerId = MANAGER.conversationId;
  activeDeputyId = null;
  wireControl = false;
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
  const bindings = viewerMcpBindings(undefined, wireControl ? productionViewerControlDependencies(true) : {
    get: async () => { throw new Error("unexpected control read"); },
    post: async () => { throw new Error("unexpected control post"); },
  }, {
    ...productionDomainDependencies,
    callerProject: () => PROJECT,
    callerAttribution: () => manager ? { ...MANAGER, conversationId: activeManagerId, ...(activeDeputyId ? { via: { deputy: activeDeputyId } } : {}) } : { kind: "agent", conversationId: "conversation_worker", role: "builder" },
    authorizedSeats: () => [{ conversationId: activeManagerId, path: null, project: PROJECT }],
    operatorLocale: () => "en",
    operatorTimeZone: () => "UTC",
    publicDenyList: () => ({ accounts: [], people: [], local: [], projects: [] }),
    ...(wireControl ? {} : { sendReportTelegram: async (input: ReportTelegramSend) => {
      sends.push(input);
      await sendGate?.();
      if (sendBusy) throw busy();
      if (sendRefusal) return { ok: false as const, code: sendRefusal };
      // The fake models the bot service's durable send-key deduplication.
      if (!delivered.has(input.clientRequestId)) delivered.set(input.clientRequestId, [71 + delivered.size]);
      return { ok: true as const, messageIds: delivered.get(input.clientRequestId)! };
    } }),
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
  expect(sends[1]!.clientRequestId).toBe(sends[0]!.clientRequestId);
  await restarted.call();
  expect(sends).toHaveLength(2);
  expect(delivered.size).toBe(1);
  expect(store.readBridgeReportLog().reports).toHaveLength(1);
});

test("a settled retryable bot refusal advances the attempt key and reconciles once", async () => {
  const p = await protocol();
  sendRefusal = "network_failed";
  expect(await p.call()).toMatchObject({ ok: true, recorded: true, seq: 1, destinations: { telegram: { state: "failed", retryable: true } } });
  expect(store.readBridgeReportLog().reports[0]!.telegram).toMatchObject({ state: "failed", attempts: 1 });
  sendRefusal = null;
  const fault = deferBookkeeping();
  expect(await p.call()).toMatchObject({ ok: true, seq: 1, destinations: { telegram: { state: "sent", bookkeeping: { state: "pending" } } } });
  fault.mockRestore();
  await p.close();
  const restarted = await protocol();
  expect(await restarted.call()).toMatchObject({ ok: true, seq: 1, destinations: { telegram: { state: "sent" } } });
  expect(sends[1]!.clientRequestId).toBe(`${sends[0]!.clientRequestId}:r1`);
  expect(sends[2]!.clientRequestId).toBe(sends[1]!.clientRequestId);
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
  expect(store.readBridgeReportLog().reports[0]!.telegram).toMatchObject({ state: "failed", attempts: 0 });
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

for (const busyFirst of [false, true]) {
  test(`parallel busy recovery preserves sent with busy ${busyFirst ? "first" : "last"}`, async () => {
    const p = await protocol();
    const firstEntered = Promise.withResolvers<void>();
    const bothEntered = Promise.withResolvers<void>();
    const releaseLast = Promise.withResolvers<void>();
    let calls = 0;
    sendGate = async () => {
      const turn = ++calls;
      if (turn === 1) { firstEntered.resolve(); await bothEntered.promise; if (busyFirst) throw busy(); }
      if (turn === 2) { bothEntered.resolve(); await releaseLast.promise; if (!busyFirst) throw busy(); }
    };
    const first = p.call();
    await firstEntered.promise;
    const second = p.call({ clientRequestId: "report-concurrent-busy" });
    try {
      expect(await first).toMatchObject({ ok: true, seq: 1 });
      if (busyFirst) {
        expect(await p.call({ clientRequestId: "report-during-race" })).toMatchObject({ ok: true, seq: 1 });
      }
    }
    finally { releaseLast.resolve(); }
    expect(await second).toMatchObject({ ok: true, seq: 1 });
    expect(store.readBridgeReportLog().reports[0]!.telegram).toMatchObject({ state: "sent", attempts: 1, messageIds: [71] });
    await p.close();
    const restarted = await protocol();
    expect(await restarted.call({ clientRequestId: "report-after-race" })).toMatchObject({ ok: true, seq: 1, destinations: { telegram: { state: "sent" } } });
    expect(delivered.size).toBe(1);
    expect(sends).toHaveLength(busyFirst ? 3 : 2);
    expect(store.readBridgeReportLog().reports).toHaveLength(1);
  });
}

test("disabling reports preserves the stored acknowledgement and same-request recovery", async () => {
  const p = await protocol();
  sendBusy = true;
  const fault = deferBookkeeping();
  const first = await p.call();
  expect(first).toMatchObject({ ok: true, recorded: true, seq: 1 });
  fault.mockRestore();
  sendBusy = false;
  setBridgeReports(PROJECT, false, "operator");
  const disabled = await p.call();
  expect(delivered.size).toBe(0);
  expect(sends).toHaveLength(1);
  expect(disabled).toMatchObject({ destinations: { telegram: { state: "pending" } } });
  await p.close();
  setBridgeReports(PROJECT, true, "operator");
  const restarted = await protocol();
  const enabled = await restarted.call();
  await restarted.call();
  expect(disabled).toMatchObject({ ok: true, alreadyRecorded: true, seq: 1 });
  expect(enabled).toMatchObject({ ok: true, alreadyRecorded: true, seq: 1, destinations: { telegram: { state: "sent" } } });
  expect(delivered.size).toBe(1);
});


for (const { previouslySent, bookkeepingBusy, race, deputy } of [
  ...[true, false].flatMap(previouslySent => [true, false].map(bookkeepingBusy => ({ previouslySent, bookkeepingBusy, race: null, deputy: false }))),
  ...["reports-off", "chat", "topic", "seat"].map(race => ({ previouslySent: false, bookkeepingBusy: true, race, deputy: false })),
  ...[true, false].map(previouslySent => ({ previouslySent, bookkeepingBusy: true, race: null, deputy: true })),
]) {
  test(`successor recovers the original bot receipt (sent=${previouslySent}, bookkeeping busy=${bookkeepingBusy}, admission race=${race}, deputy=${deputy})`, async () => {
    const { TelegramBotService, productionTelegramBotDependencies, setTelegramBotServiceForTests } = await import("@/lib/telegram/bot/service");
    const { FakeBotTransport, fakeBotToken, ok } = await import("@/lib/telegram/bot/fakeTransport");
    const transport = new FakeBotTransport();
    const now = new Date("2026-09-25T12:00:00Z");
    const dependencies = { ...productionTelegramBotDependencies(), clones: undefined, publicationTarget: () => null, publishMessage: () => "skipped" as const, signInHook: () => null, reportReplies: undefined, transportFor: () => transport,
      now: () => now, sleep: async () => {}, conversationTitle: () => null };
    let bot = new TelegramBotService(dependencies);
    const chat = { id: -1000000000101, type: "supergroup", title: "Report room" };
    transport.script("getMe", ok({ id: 4242424, is_bot: true, first_name: "Report Bot", username: "report_test_bot", can_join_groups: true, can_read_all_group_messages: false }));
    const savedUrl = process.env.LLV_VIEWER_CONTROL_URL;
    const savedCapability = process.env[VIEWER_SPAWN_CAPABILITY_ENV];
    const capability = "a".repeat(43);
    process.env[VIEWER_SPAWN_CAPABILITY_ENV] = capability;
    activeDeputyId = deputy ? "conversation_report_deputy" : null;
    const originalSender = activeDeputyId ?? activeManagerId;
    setCallerConversationResolverForTests(() => activeDeputyId ?? activeManagerId);
    const principal = spyOn(deputies, "productionDeputyPrincipal").mockImplementation(id => activeDeputyId && id === activeDeputyId
      ? { project: PROJECT, seatConversationId: activeManagerId, seatPath: null, seatEpoch: 1, deputyConversationId: activeDeputyId, askId: "report-ask" } : null);
    restores.push(() => principal.mockRestore());
    const seats = spyOn(authority, "authorizedManagerSeats").mockImplementation(() => [{ conversationId: activeManagerId, path: null, project: PROJECT }]);
    restores.push(() => seats.mockRestore());
    setTelegramBotServiceForTests(bot);
    const routeCalls: Record<string, unknown>[] = [];
    const viewer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      expect(new URL(req.url).pathname).toBe("/api/telegram/bot/agent");
      const body = await req.clone().json();
      routeCalls.push(body);
      // A caller cannot replace the stored sender, content or destination.
      if (routeCalls.length === 2) {
        if (race === "reports-off") setBridgeReports(PROJECT, false, "operator");
        if (race === "chat") setReportTelegram(PROJECT, { chat: "other-room", name: "Project" }, "operator");
        if (race === "topic") setReportTelegram(PROJECT, { chat: "report-room", name: "Project", topicId: 42 }, "operator");
        if (race === "seat") setCallerConversationResolverForTests(() => "conversation_worker");
        return telegramPost(new NextRequest(req.url, { method: "POST", headers: req.headers,
          body: JSON.stringify({ ...body, conversationId: "conversation_worker", chat: "other-room", text: "Untrusted replacement" }) }));
      }
      return telegramPost(new NextRequest(req));
    } });
    process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${viewer.port}`;
    wireControl = true;
    try {
      await bot.connect(fakeBotToken("4242424"));
      await bot.stopPoller();
      transport.script("getUpdates", ok([{ update_id: 1, my_chat_member: { chat, date: Math.floor(now.getTime()/1000)-10, new_chat_member: { status: "member" } } }]));
      await bot.pollOnce(new AbortController().signal);
      bot.setChat(String(chat.id), "report-room", true);
      for (const message_id of [71, 72]) transport.script("sendMessage", ok({ message_id, date: Math.floor(now.getTime()/1000), chat, text: "The lane finished." }));
      const first = await protocol();
      const fault = bookkeepingBusy ? deferBookkeeping() : null;
      const deferredSend = previouslySent ? null : spyOn(bot, "send").mockRejectedValueOnce(busy());
      expect(await first.call()).toMatchObject({ ok: true, recorded: true, seq: 1 });
      deferredSend?.mockRestore();
      fault?.mockRestore();
      expect(transport.callsOf("sendMessage")).toHaveLength(previouslySent ? 1 : 0);
      await first.close();
      // Restart both receipt consumers and change the designated conversation.
      bot = new TelegramBotService(dependencies);
      setTelegramBotServiceForTests(bot);
      const recoveredSend = spyOn(bot, "send");
      restores.push(() => recoveredSend.mockRestore());
      activeDeputyId = null;
      activeManagerId = "conversation_successor_seat";
      const successor = await protocol();
      const recovered = await successor.call({ clientRequestId: "report-successor-call" });
      if (race) {
        expect(recovered).toMatchObject({ ok: true, alreadyRecorded: true, seq: 1, destinations: { telegram: { state: "failed", retryable: true } } });
        expect(transport.callsOf("sendMessage")).toHaveLength(0);
        expect(recoveredSend).not.toHaveBeenCalled();
        setBridgeReports(PROJECT, true, "operator");
        setReportTelegram(PROJECT, { chat: "report-room", name: "Project" }, "operator");
        setCallerConversationResolverForTests(() => activeManagerId);
        expect(await successor.call({ clientRequestId: "report-successor-call" })).toMatchObject({ ok: true, seq: 1, destinations: { telegram: { state: "sent", messageIds: [71] } } });
      } else {
        expect(recovered).toMatchObject({ ok: true, alreadyRecorded: true, seq: 1, destinations: { telegram: { state: "sent", messageIds: [71] } } });
      }
      await successor.call({ clientRequestId: "report-successor-call" });
      expect(transport.callsOf("sendMessage")).toHaveLength(1);
      expect(routeCalls).toHaveLength(race ? 3 : previouslySent && !bookkeepingBusy ? 1 : 2);
      if (!(previouslySent && !bookkeepingBusy)) expect(recoveredSend).toHaveBeenCalledWith(expect.objectContaining({ conversationId: originalSender, chat: "report-room", format: "html", silent: true }));
      expect(transport.callsOf("sendMessage")[0]!.params.text).toBe(store.readBridgeReportLog().reports[0]!.telegram!.html);
      for (const call of routeCalls.slice(1)) expect(call.clientRequestId).toBe(routeCalls[0]!.clientRequestId);
      expect(store.readBridgeReportLog().reports).toHaveLength(1);
      expect(store.readBridgeReportLog().reports[0]!.telegram).toMatchObject({ state: "sent", attempts: 1 });
      // The posting helper refuses hostile callers and settings changes even
      // when reached directly, before returning a saved bot receipt.
      const direct = async (body: Record<string, unknown> = {}, headers: Record<string, string> = { [VIEWER_SPAWN_CAPABILITY_HEADER]: capability }) => telegramPost(new NextRequest(`${viewer.url}api/telegram/bot/agent`, {
        method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ ...routeCalls[0], ...body }),
      }));
      if (deputy) {
        setCallerConversationResolverForTests(() => originalSender);
        expect((await direct()).status).toBe(403);
        principal.mockReturnValue({ project: "other-project", seatConversationId: activeManagerId, seatPath: null,
          seatEpoch: 1, deputyConversationId: originalSender, askId: "report-ask" });
        expect((await direct()).status).toBe(403);
        principal.mockReturnValue(null);
      }
      setCallerConversationResolverForTests(() => "conversation_worker");
      expect((await direct()).status).toBe(403);
      setCallerConversationResolverForTests(() => activeManagerId);
      expect((await direct({}, {})).status).toBe(403);
      expect((await direct({ reportId: "missing" })).status).toBe(403);
      setBridgeReports(PROJECT, false, "operator");
      expect((await direct()).status).toBe(403);
      setBridgeReports(PROJECT, true, "operator");
      setReportTelegram(PROJECT, { chat: "other-room", name: "Project" }, "operator");
      expect((await direct()).status).toBe(403);
      expect(transport.callsOf("sendMessage")).toHaveLength(1);
    } finally {
      await viewer.stop(true);
      await bot.remove();
      setTelegramBotServiceForTests(null);
      setCallerConversationResolverForTests(null);
      if (savedUrl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
      else process.env.LLV_VIEWER_CONTROL_URL = savedUrl;
      if (savedCapability === undefined) delete process.env[VIEWER_SPAWN_CAPABILITY_ENV];
      else process.env[VIEWER_SPAWN_CAPABILITY_ENV] = savedCapability;
    }
  });
}
