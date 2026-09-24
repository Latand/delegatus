import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-bot-transport-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { createBotApiTransport, removeBotToken, saveBotToken, scrubTokenText, storedBotId, telegramBotTokenPath, withStoredBotToken } = await import("./transport");
const { UnsafeTelegramSessionError } = await import("../sessionStore");
const { fakeBotToken } = await import("./fakeTransport");

const TOKEN = fakeBotToken();
const SECRET = TOKEN.slice(TOKEN.indexOf(":") + 1);

beforeEach(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});
afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("token never serialised: the transport exposes only call, and stringifies to nothing", () => {
  const transport = createBotApiTransport(TOKEN, async () => jsonResponse({ ok: true, result: true }));
  expect(Object.keys(transport)).toEqual(["call"]);
  expect(JSON.stringify(transport)).toBe("{}");
  const inspected = util.inspect(transport, { depth: 10, showHidden: true });
  expect(inspected).not.toContain(SECRET);
  expect(inspected).not.toContain(TOKEN);
  expect(String(transport)).not.toContain(SECRET);
});

test("the token reaches only the request URL, and a successful answer passes through", async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  const transport = createBotApiTransport(TOKEN, async (url, init) => {
    seen.push({ url, body: JSON.parse(String(init.body)) });
    return jsonResponse({ ok: true, result: { id: 4242424, is_bot: true } });
  });
  const result = await transport.call("getMe", { probe: 1 });
  expect(result).toEqual({ ok: true, result: { id: 4242424, is_bot: true } });
  expect(seen).toEqual([{ url: `https://api.telegram.org/bot${TOKEN}/getMe`, body: { probe: 1 } }]);
});

test("a fetch rejection that quotes the request URL comes back as a bare code", async () => {
  const transport = createBotApiTransport(TOKEN, async (url) => {
    throw new TypeError(`fetch failed: request to ${url} failed, reason: connect ECONNREFUSED`);
  });
  const result = await transport.call("getUpdates", {});
  expect(result).toEqual({ ok: false, kind: "network_failed", status: null, description: null, retryAfterSeconds: null, migrateToChatId: null });
  expect(JSON.stringify(result)).not.toContain(SECRET);
});

test("a request that outlives its timeout is timed_out, and an outer abort ends it too", async () => {
  const hanging = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error(`aborted https://api.telegram.org/bot${TOKEN}/getUpdates`)));
  });
  const transport = createBotApiTransport(TOKEN, hanging);
  expect(await transport.call("getUpdates", {}, { timeoutMs: 10 })).toMatchObject({ ok: false, kind: "timed_out" });
  const controller = new AbortController();
  const pending = transport.call("getUpdates", {}, { signal: controller.signal, timeoutMs: 60_000 });
  controller.abort();
  expect(await pending).toMatchObject({ ok: false, kind: "network_failed" });
});

test("Telegram's description is passed through with the token cut out, and its parameters are read", async () => {
  const transport = createBotApiTransport(TOKEN, async () => jsonResponse({
    ok: false,
    error_code: 429,
    description: `Too Many Requests for bot${TOKEN} (secret ${SECRET})`,
    parameters: { retry_after: 7 },
  }, 429));
  const result = await transport.call("sendMessage", {});
  expect(result).toEqual({
    ok: false,
    kind: "http",
    status: 429,
    description: "Too Many Requests for bot[token] (secret [token])",
    retryAfterSeconds: 7,
    migrateToChatId: null,
  });
  const migrating = createBotApiTransport(TOKEN, async () => jsonResponse({
    ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: -1001234567890 },
  }, 400));
  expect(await migrating.call("sendMessage", {})).toMatchObject({ status: 400, migrateToChatId: "-1001234567890" });
  expect(scrubTokenText("x".repeat(500), TOKEN)).toHaveLength(300);
});

test("a malformed token is refused before a transport exists", () => {
  expect(() => createBotApiTransport("not-a-token", async () => jsonResponse({}))).toThrow("invalid shape");
});

test("the token file is owner-only, read back only through a callback, and a symlink is refused", () => {
  saveBotToken(TOKEN, "4242424", new Date("2026-09-24T08:00:00Z"));
  const file = telegramBotTokenPath();
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  expect(storedBotId()).toBe("4242424");
  expect(withStoredBotToken((token) => token === TOKEN)).toBe(true);

  removeBotToken();
  expect(storedBotId()).toBeNull();

  const elsewhere = path.join(SANDBOX, "elsewhere.json");
  fs.writeFileSync(elsewhere, JSON.stringify({ version: 1, botId: "4242424", token: TOKEN, savedAt: "x" }), { mode: 0o600 });
  fs.symlinkSync(elsewhere, file);
  expect(() => storedBotId()).toThrow(UnsafeTelegramSessionError);
  expect(() => saveBotToken(TOKEN, "4242424")).toThrow(UnsafeTelegramSessionError);
});

test("the bot's token file never collides with the personal account's files", () => {
  expect(path.basename(telegramBotTokenPath())).toBe("bot-token.json");
});
