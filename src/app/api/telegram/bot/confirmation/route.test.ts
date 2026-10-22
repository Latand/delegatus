import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-file-route-"));
const previousState = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(root, "state");
const { GET, POST } = await import("./route");
const { POST: agentPOST } = await import("../agent/route");
const { TelegramBotService, productionTelegramBotDependencies, setTelegramBotServiceForTests } = await import("@/lib/telegram/bot/service");
const { FakeBotTransport, fakeBotToken, ok } = await import("@/lib/telegram/bot/fakeTransport");
const { claimInstall } = await import("@/lib/team/members");
const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
const { MEMBER_COOKIE, mintSession } = await import("@/lib/team/sessions");
const { updateRelayStore } = await import("@/lib/externalRelay/store");
const { knownRelay } = await import("@/lib/externalRelay/knownRelays");
const { internalServiceHeaders } = await import("@/lib/agent/callerClaims");
const { setCallerConversationResolverForTests } = await import("@/lib/agent/operatorAuthority");
const { VIEWER_SPAWN_CAPABILITY_HEADER } = await import("@/lib/agent/capabilityHeader");
const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-22T12:00:00Z"));
const CHAT = { id: -1000000000101, type: "supergroup", title: "Fixture reports" };
const OWNER = "700001";
const home = path.join(root, "home");
let service: InstanceType<typeof TelegramBotService>;
let transport: InstanceType<typeof FakeBotTransport>;
let cookie: string;
let sessionId: string;
let bootstrap: string;

beforeEach(async () => {
  clock.mockReturnValue(Date.parse("2026-10-22T12:00:00Z"));
  transport = new FakeBotTransport();
  service = new TelegramBotService({ ...productionTelegramBotDependencies(), transportFor: () => transport,
    now: () => new Date(Date.now()), sleep: async () => {}, documentEnvironment: () => ({ home, stateDir: process.env.LLV_STATE_DIR! }) });
  setTelegramBotServiceForTests(service);
  setCallerConversationResolverForTests(digest => digest ? "conversation_fixture" : null);
  const claimed = claimInstall(teamStore(), "Owner", { surface: "desktop", browser: "chrome" });
  bootstrap = claimed.cookie;
  teamStore().updateMember({ ...claimed.member, telegram: { userId: OWNER, username: "fixture", firstName: "Owner", linkedAt: claimed.session.createdAt } });
  const session = mintSession(teamStore(), claimed.member.id, "telegram", { surface: "desktop", browser: "chrome" });
  cookie = session.value; sessionId = session.session.id;
  updateRelayStore(store => ({ ...store, relays: [{ id: "file-send-fixture", origin: knownRelay("celestia")!.origin, api_base: "https://relay.example.test/v1", name: "Fixture pairing", description: "", credential: "x".repeat(43),
    owner: { namespace: "telegram", id: OWNER, display_name: "Owner", handle: null }, pairedAt: "2026-01-01T00:00:00Z", paused: false,
    limits: { max_response_bytes: 1_048_576, max_wait_s: 25, max_answer_chars: 4000 },
    targets: [{ id: "fixture-target", name: "Fixture", answered_by: "install", fallback: "none", enabled: true, engine: "codex", model: "test", effort: "low", project: null, concurrency: 1, hardCapMinutes: 1 }] }] }));
  transport.script("getMe", ok({ id: 4242424, is_bot: true, first_name: "Fixture bot" }));
  await service.connect(fakeBotToken()); await service.stopPoller();
  transport.script("getUpdates", ok([{ update_id: 1, my_chat_member: { chat: CHAT, date: 1, new_chat_member: { status: "administrator" } } }]));
  await service.pollOnce(new AbortController().signal);
  service.setChat(String(CHAT.id), "reports", true);
});
afterEach(async () => {
  await service.remove(); setTelegramBotServiceForTests(null); setCallerConversationResolverForTests(null); resetTeamStoreForTests();
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});
afterAll(() => {
  clock.mockRestore();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(root, { recursive: true, force: true });
});
function request(method: string, body?: unknown, headers: Record<string, string> = {}, id = "") {
  return new NextRequest(`http://127.0.0.1/api/telegram/bot/confirmation?id=${id}`, { method,
    headers: { host: "127.0.0.1", "sec-fetch-site": "same-origin", cookie: `${MEMBER_COOKIE}=${cookie}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function pending(kind: "document" | "media" = "document") {
  const filename = path.join(home, ".private", kind === "document" ? "credentials.md" : "frame.png");
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  if (kind === "document") fs.writeFileSync(filename, ["-----BEGIN ", "PRIVATE KEY-----"].join(""));
  else await sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).png().toFile(filename);
  const input = { op: kind === "document" ? "send_document" : "send_media", clientRequestId: "fixture-request", chat: "reports", topicId: 7,
    ...(kind === "document" ? { document: { path: filename, caption: "Requested file" } } : { images: [{ path: filename, caption: "Requested frame" }] }) };
  const response = await agentPOST(request("POST", input, { [VIEWER_SPAWN_CAPABILITY_HEADER]: "A".repeat(43) }));
  expect(response.status).toBe(403);
  const body = await response.json();
  expect(structuredClone(body)).toMatchObject({ code: "document_forbidden_path", retryable: false, confirmation: { id: expect.any(String), url: expect.stringContaining("/telegram-file-confirmation?id=") } });
  const viewResponse = await GET(request("GET", undefined, {}, body.confirmation.id));
  expect({ status: viewResponse.status, body: await viewResponse.clone().json() }).toMatchObject({ status: 200 });
  return { view: await viewResponse.json(), input, filename };
}

test.each(["document", "media"] as const)("only the paired owner approves %s; a browser-shaped agent request never self-approves", async kind => {
  const { view, input } = await pending(kind);
  const decision = { id: view.id, digest: view.digest, approve: true };
  for (const [headers, status, code] of [
    [{ cookie: "" }, 401, "MEMBER_REQUIRED"],
    [{ cookie: `${MEMBER_COOKIE}=${bootstrap}` }, 401, "OPERATOR_REQUIRED"],
    [{ [VIEWER_SPAWN_CAPABILITY_HEADER]: "invalid" }, 403, "OPERATOR_REQUIRED"],
    [internalServiceHeaders("mcp"), 403, "OPERATOR_REQUIRED"],
  ] as const) {
    const response = await POST(request("POST", decision, headers));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  }
  const selfApproved = await agentPOST(request("POST", { ...input, clientRequestId: "self-approval", confirmation: decision, approve: true }, { [VIEWER_SPAWN_CAPABILITY_HEADER]: "A".repeat(43) }));
  expect(selfApproved.status).toBe(403);
  expect(await selfApproved.json()).toMatchObject({ code: "document_forbidden_path" });
  for (const extra of [{ chat: "another-chat" }, { topicId: 8 }, { document: { path: "/sandbox/other.md" } }]) {
    const response = await POST(request("POST", { ...decision, ...extra }));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
  }
  const method = kind === "document" ? "sendDocument" : "sendPhoto";
  expect(transport.callsOf(method)).toHaveLength(0);
  transport.script(method, ok({ message_id: 100, date: 1 }));
  const responses = await Promise.all([POST(request("POST", decision)), POST(request("POST", decision))]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  expect(transport.callsOf(method)).toHaveLength(1);
  expect(transport.callsOf(method)[0]!.params).toMatchObject({ chat_id: CHAT.id, message_thread_id: 7 });
  expect((await POST(request("POST", decision))).status).toBe(409);
});

test("a revoked owner is refused after the body wait", async () => {
  const { view } = await pending();
  let finish!: () => void;
  let reading!: () => void;
  const read = new Promise<void>(resolve => { reading = resolve; });
  const body = new ReadableStream<Uint8Array>({ pull(controller) { reading(); finish = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ id: view.id, digest: view.digest, approve: true }))); controller.close(); }; } });
  const original = request("POST");
  const streamed = new NextRequest(original.url, { method: "POST", headers: original.headers, body, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1]);
  const result = POST(streamed);
  await read;
  teamStore().revokeSession(sessionId, new Date(Date.now()).toISOString());
  finish();
  const response = await result;
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: "MEMBER_REQUIRED" });
  expect(transport.callsOf("sendDocument")).toHaveLength(0);
});

test("owner revocation while the bot checks rights prevents the file transport", async () => {
  const { view } = await pending();
  service["store"]().postingState(db => db.query("DELETE FROM chat_bots").run());
  let checked = false;
  transport.handlers.getChatMember = () => {
    checked = true;
    teamStore().revokeSession(sessionId, new Date(Date.now()).toISOString());
    return ok({ status: "administrator", can_post_messages: true, can_send_documents: true });
  };
  const response = await POST(request("POST", { id: view.id, digest: view.digest, approve: true }));
  expect(checked).toBe(true);
  expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 403, body: { code: "forbidden" } });
  expect(transport.callsOf("sendDocument")).toHaveLength(0);
});


test.each(["changed", "expired", "chat-revoked", "migrated", "uncertain"] as const)("owner confirmation refuses %s and never resends", async mode => {
  const { view, filename } = await pending();
  if (mode === "changed") fs.writeFileSync(filename, "Changed contents");
  if (mode === "expired") clock.mockReturnValue(Date.parse(view.expiresAt));
  if (mode === "chat-revoked") service.setChat(String(CHAT.id), "reports", false);
  if (mode === "migrated") transport.script("sendDocument", { ok: false, kind: "http", status: 400, description: "migrated", migrateToChatId: "-1000000000202", retryAfterSeconds: null });
  if (mode === "uncertain") transport.script("sendDocument", { ok: false, kind: "network_failed", status: null, description: null, migrateToChatId: null, retryAfterSeconds: null });
  const decision = { id: view.id, digest: view.digest, approve: true };
  const response = await POST(request("POST", decision));
  expect(response.status).toBe(mode === "chat-revoked" ? 403 : 409);
  expect(await response.json()).toMatchObject({ code: mode === "chat-revoked" ? "chat_not_allowed" : mode === "uncertain" ? "send_uncertain" : "confirmation_invalid" });
  expect(transport.callsOf("sendDocument")).toHaveLength(mode === "migrated" || mode === "uncertain" ? 1 : 0);
  const replay = await POST(request("POST", decision));
  expect(replay.status).toBe(409);
  expect(await replay.json()).toMatchObject({ code: "confirmation_invalid" });
  expect(transport.callsOf("sendDocument")).toHaveLength(mode === "migrated" || mode === "uncertain" ? 1 : 0);
});

test("a changed photo album is refused before any image leaves", async () => {
  const { view, filename } = await pending("media");
  await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toFile(filename);
  const response = await POST(request("POST", { id: view.id, digest: view.digest, approve: true }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "confirmation_invalid" });
  expect(transport.callsOf("sendPhoto")).toHaveLength(0);
  expect(transport.callsOf("sendMediaGroup")).toHaveLength(0);
});

test("a failed audit write consumes authority without contacting Telegram", async () => {
  const { view } = await pending();
  const { Database } = await import("bun:sqlite");
  const lock = new Database(path.join(process.env.LLV_STATE_DIR!, "telegram/bot.sqlite"));
  const decision = { id: view.id, digest: view.digest, approve: true };
  try {
    lock.exec("BEGIN IMMEDIATE");
    const response = await POST(request("POST", decision));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "action_failed" });
  } finally { lock.exec("ROLLBACK"); lock.close(); }
  expect((await POST(request("POST", decision))).status).toBe(409);
  expect(transport.callsOf("sendDocument")).toHaveLength(0);
});
