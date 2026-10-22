import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { FileSendConfirmations, FILE_CONFIRMATION_TTL_MS } from "./fileConfirmations";
import { isFileConfirmationUrl, readFileConfirmationLink } from "./fileConfirmationContract";
import { TelegramBotStore } from "./store";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-confirmations-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
async function child(directory: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(directory, "home"), XDG_CONFIG_HOME: path.join(directory, "config"), TMPDIR: path.join(directory, "tmp"), LLV_STATE_DIR: path.join(directory, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" };
  delete env.LLV_STATE_OWNER;
  for (const folder of [env.HOME!, env.XDG_CONFIG_HOME!, env.TMPDIR!, env.LLV_STATE_DIR!]) fs.mkdirSync(folder, { recursive: true });
  const processChild = Bun.spawn([process.execPath, "src/lib/telegram/bot/fileConfirmation.fixture.ts", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => processChild.kill(9), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(processChild.stdout).text(), new Response(processChild.stderr).text(), processChild.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return JSON.parse(stdout);
  } finally { clearTimeout(timer); if (processChild.exitCode === null) { processChild.kill(); await processChild.exited; } }
}
test.each(["pending", "sent"])("a real process restart cannot approve or replay a %s request, even with edited audit rows", async mode => {
  const directory = fs.mkdtempSync(path.join(root, "restart-"));
  const first = await child(directory, mode);
  expect(first.state).toBe(mode);
  const replay = await child(directory, "replay", first.id, first.digest);
  expect(replay).toMatchObject({ code: "confirmation_invalid", sends: 0 });
  const db = new Database(path.join(directory, "state/telegram/bot.sqlite"));
  try {
    const row = db.query<{ value_json: string }, [string]>("SELECT value_json FROM file_send_confirmations WHERE id=?").get(first.id)!;
    const value = JSON.parse(row.value_json); value.state = "pending";
    db.query("UPDATE file_send_confirmations SET value_json=? WHERE id=?").run(JSON.stringify(value), first.id);
  } finally { db.close(); }
  expect(await child(directory, "replay", first.id, first.digest)).toMatchObject({ code: "confirmation_invalid", state: "unavailable", sends: 0 });
});

test("pending authority and audit storage are bounded; expiration releases pending capacity", () => {
  const directory = fs.mkdtempSync(path.join(root, "bounds-"));
  const store = new TelegramBotStore(path.join(directory, "bot.sqlite"));
  let now = Date.parse("2026-10-22T12:00:00Z"), sequence = 0;
  const confirmations = new FileSendConfirmations(() => store, () => new Date(now), () => `fixture-${++sequence}`);
  const snapshot = { kind: "document" as const, botId: "fixture-bot", chatId: "-1000000000101", chatTitle: "Fixture reports", topicId: null,
    options: { conversationId: null, clientRequestId: "fixture", chat: "-1000000000101", topicId: null, replyToMessageId: null, format: "plain" as const, silent: false },
    files: [{ path: "/sandbox/report.md", filename: "report.md", sha256: "a".repeat(64), bytes: 10 }], reasons: [{ code: "document_secret" as const, reason: "Secret detector" }] };
  try {
    expect(() => confirmations.request({ ...snapshot, options: { ...snapshot.options, clientRequestId: "x".repeat(128_001) } })).toThrow("confirmation");
    for (let i = 0; i < 128; i++) confirmations.request(snapshot);
    expect(() => confirmations.request(snapshot)).toThrow("confirmation");
    for (let round = 0; round < 3; round++) {
      now += FILE_CONFIRMATION_TTL_MS;
      for (let i = 0; i < 128; i++) confirmations.request(snapshot);
    }
    expect(confirmations.read("fixture-384").state).toBe("expired");
    expect(store.postingState(db => db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM file_send_confirmations").get()!.count)).toBe(256);
  } finally { store.close(); }
});


test("only an exact app confirmation path crosses the MCP and transcript link boundary", () => {
  const valid = { id: "fixture-id", url: "/telegram-file-confirmation?id=fixture-id", expiresAt: "2026-10-22T12:10:00.000Z" };
  expect(readFileConfirmationLink(valid)).toEqual(valid);
  expect(isFileConfirmationUrl(valid.url)).toBe(true);
  for (const entry of [{ ...valid, url: "https://example.invalid/approval" }, { ...valid, id: "../fixture" }, { ...valid, expiresAt: "invalid" }, { ...valid, url: "/telegram-file-confirmation?id=other" }]) expect(readFileConfirmationLink(entry)).toBeNull();
  for (const href of ["https://example.invalid/approval", "/sandbox/report.md", "/telegram-file-confirmation?id=../other", "/telegram-file-confirmation?id=fixture&approve=true"]) expect(isFileConfirmationUrl(href)).toBe(false);
});
