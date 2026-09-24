import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-bot-route-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const operatorRoute = await import("./route");
const agentRoute = await import("./agent/route");
const { TelegramBotService, productionTelegramBotDependencies, setTelegramBotServiceForTests } = await import("@/lib/telegram/bot/service");
const { FakeBotTransport, fakeBotToken, ok } = await import("@/lib/telegram/bot/fakeTransport");
const { setCallerConversationResolverForTests } = await import("@/lib/agent/operatorAuthority");
const { VIEWER_SPAWN_CAPABILITY_HEADER } = await import("@/lib/agent/capabilityHeader");

const BOT_ID = 4242424;
const TOKEN = fakeBotToken(String(BOT_ID));
const TOKEN_TAIL = TOKEN.slice(TOKEN.indexOf(":") + 1);
/* A capability-shaped value for an invented conversation. */
const AGENT_CAPABILITY = "A".repeat(43);
const AGENT = { [VIEWER_SPAWN_CAPABILITY_HEADER]: AGENT_CAPABILITY };
const TEAM = { id: -1000000000101, type: "supergroup", title: "Team Reports" };

let transport: InstanceType<typeof FakeBotTransport>;
let service: InstanceType<typeof TelegramBotService>;

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  transport = new FakeBotTransport();
  service = new TelegramBotService({
    ...productionTelegramBotDependencies(),
    transportFor: () => transport,
    sleep: async () => {},
    conversationTitle: () => "Report writer",
  });
  setTelegramBotServiceForTests(service);
  setCallerConversationResolverForTests((digest) => (digest ? "conversation_writer" : null));
});
afterEach(async () => {
  await service.remove();
  setTelegramBotServiceForTests(null);
  setCallerConversationResolverForTests(null);
});
afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function request(pathname: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(`http://127.0.0.1${pathname}`, {
    method: init.method ?? "GET",
    headers: { host: "127.0.0.1", "content-type": "application/json", ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function text(response: Response): Promise<string> {
  return await response.text();
}

function leaks(body: string): boolean {
  return body.includes(TOKEN_TAIL) || body.includes(TOKEN) || body.includes(String(BOT_ID));
}

async function connected() {
  transport.script("getMe", ok({ id: BOT_ID, is_bot: true, first_name: "Report Bot", username: "report_test_bot" }));
  const response = await operatorRoute.POST(request("/api/telegram/bot", { method: "POST", body: { action: "connect", token: TOKEN } }));
  expect(response.status).toBe(200);
  await service.stopPoller();
  transport.script("getUpdates", ok([
    { update_id: 1, my_chat_member: { chat: TEAM, date: 1, new_chat_member: { status: "administrator" } } },
    { update_id: 2, message: { message_id: 5, date: 2, chat: TEAM, from: { id: 700000505, first_name: "Person" }, text: "hi" } },
  ]));
  await service.pollOnce(new AbortController().signal);
  return response;
}

test("token never serialised: connect, status, chat edits and every agent answer carry no token or bot id", async () => {
  const connect = await connected();
  const bodies = [await text(connect)];
  bodies.push(await text(await operatorRoute.GET(request("/api/telegram/bot"))));
  bodies.push(await text(await operatorRoute.POST(request("/api/telegram/bot", { method: "POST", body: { action: "chat", chatId: String(TEAM.id), alias: "team-reports", postAllowed: true } }))));
  bodies.push(await text(await agentRoute.GET(request("/api/telegram/bot/agent?op=chats"))));
  bodies.push(await text(await agentRoute.GET(request("/api/telegram/bot/agent?op=messages&chat=team-reports"))));
  transport.script("sendMessage", ok({ message_id: 6, date: 3 }));
  bodies.push(await text(await agentRoute.POST(request("/api/telegram/bot/agent", { method: "POST", headers: AGENT, body: { op: "send", clientRequestId: "r1", chat: "team-reports", text: "report" } }))));
  /* A refused connect echoes nothing of what it was given. */
  bodies.push(await text(await operatorRoute.POST(request("/api/telegram/bot", { method: "POST", body: { action: "connect", token: `${TOKEN}x` } }))));
  for (const body of bodies) expect(leaks(body)).toBe(false);
  expect(bodies[1]).toContain("Report Bot");
});

test("an agent capability is refused every operator action, so no agent widens its own allowlist", async () => {
  await connected();
  for (const body of [
    { action: "connect", token: TOKEN },
    { action: "chat", chatId: String(TEAM.id), alias: "team-reports", postAllowed: true },
    { action: "remove" },
  ]) {
    const response = await operatorRoute.POST(request("/api/telegram/bot", { method: "POST", headers: AGENT, body }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "operator_only" });
  }
  expect(service.status().chats[0]).toMatchObject({ alias: null, postAllowed: false });
  expect(service.status().connected).toBe(true);
});

test("a cross-origin request is refused before anything runs", async () => {
  const response = await operatorRoute.POST(request("/api/telegram/bot", { method: "POST", headers: { origin: "https://example.invalid" }, body: { action: "remove" } }));
  expect(response.status).toBe(403);
});

test("the agent route attributes a send to the caller's own conversation and refuses outside the allowlist", async () => {
  await connected();
  const refusedSend = await agentRoute.POST(request("/api/telegram/bot/agent", { method: "POST", headers: AGENT, body: { op: "send", clientRequestId: "r0", chat: String(TEAM.id), text: "x" } }));
  expect(refusedSend.status).toBe(403);
  expect(await refusedSend.json()).toMatchObject({ code: "chat_not_allowed", retryable: false, error: expect.stringContaining("Team Reports") });
  expect(transport.callsOf("sendMessage")).toEqual([]);

  service.setChat(String(TEAM.id), "team-reports", true);
  transport.script("sendMessage", ok({ message_id: 6, date: 3 }));
  /* A conversationId argument is ignored: attribution is the capability's. */
  const sent = await agentRoute.POST(request("/api/telegram/bot/agent", { method: "POST", headers: AGENT, body: { op: "send", clientRequestId: "r1", chat: "team-reports", text: "report", conversationId: "conversation_someone_else" } }));
  expect(await sent.json()).toMatchObject({ chat: "team-reports", messageIds: [6], attributedTo: { conversationId: "conversation_writer" } });

  const unknown = await agentRoute.GET(request("/api/telegram/bot/agent?op=messages&chat=nowhere"));
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toMatchObject({ code: "chat_unknown" });
});

test("with no bot connected the chats read still answers, with a note naming the panel", async () => {
  const response = await agentRoute.GET(request("/api/telegram/bot/agent?op=chats"));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ bot: { connected: false }, chats: [], limits: expect.any(Array) });
  const status = await operatorRoute.GET(request("/api/telegram/bot"));
  expect(await status.json()).toMatchObject({ bot: { connected: false, receiving: "stopped" } });
});
