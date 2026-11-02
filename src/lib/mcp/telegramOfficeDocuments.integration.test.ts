import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextRequest } from "next/server";
import { legacyWorkbook, officeParts, officeZip } from "@/lib/telegram/bot/officeDocuments.fixture";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-office-"));
const original = { ...process.env };
process.env.LLV_STATE_DIR = path.join(root, "state");
const home = path.join(root, "home"), handoff = path.join(home, "handoff");
const { TelegramBotService, productionTelegramBotDependencies, setTelegramBotServiceForTests } = await import("@/lib/telegram/bot/service");
const { FakeBotTransport, fakeBotToken, ok } = await import("@/lib/telegram/bot/fakeTransport");
const { setCallerConversationResolverForTests } = await import("@/lib/agent/operatorAuthority");
const { VIEWER_SPAWN_CAPABILITY_ENV } = await import("@/lib/agent/spawnPolicy");
const { productionViewerControlDependencies, viewerMcpBindings } = await import("./bindings");
const { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore } = await import("./server");
const { POST } = await import("@/app/api/telegram/bot/agent/route");
const { DOCUMENT_MAX_BYTES } = await import("@/lib/telegram/bot/contracts");
const transport = new FakeBotTransport();
const now = new Date("2026-10-30T12:00:00Z");
let confirmationSequence = 0, messageSequence = 100, requestSequence = 0;
const bot = new TelegramBotService({ ...productionTelegramBotDependencies(), transportFor: () => transport,
  now: () => now, sleep: async () => {}, conversationTitle: () => "Report writer",
  fileConfirmationId: () => `office-${++confirmationSequence}`,
  documentEnvironment: () => ({ home, stateDir: process.env.LLV_STATE_DIR! }) });
const viewer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => POST(new NextRequest(req)) });
const client = new Client({ name: "office-document-test", version: "1" });
const server = createViewerMcpServer(createMcpToolService(
  viewerMcpBindings(undefined, productionViewerControlDependencies(true)), new MemoryMcpReceiptStore()));
const chat = { id: -1000000000101, type: "supergroup", title: "Fixture reports", is_forum: true };
const publicChat = { id: -1000000000202, type: "channel", title: "Fixture releases", username: "fixture_public_reports" };

beforeAll(async () => {
  fs.mkdirSync(handoff, { recursive: true });
  setTelegramBotServiceForTests(bot);
  setCallerConversationResolverForTests(() => "conversation_office");
  process.env[VIEWER_SPAWN_CAPABILITY_ENV] = "O".repeat(43);
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${viewer.port}`;
  transport.script("getMe", ok({ id: 4242424, is_bot: true, first_name: "Fixture bot" }));
  await bot.connect(fakeBotToken()); await bot.stopPoller();
  transport.script("getUpdates", ok([
    { update_id: 1, my_chat_member: { chat, date: 1, new_chat_member: { status: "administrator" } } },
    { update_id: 2, my_chat_member: { chat: publicChat, date: 1, new_chat_member: { status: "administrator" } } },
  ]));
  await bot.pollOnce(new AbortController().signal);
  bot.setChat(String(chat.id), "reports", true);
  bot.setChat(String(publicChat.id), "public-reports", false);
  transport.handlers.sendDocument = () => ok({ message_id: ++messageSequence, date: 1 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
});
afterAll(async () => {
  await client.close(); await server.close(); await viewer.stop(true);
  await bot.remove(); await bot.stopPublications();
  setTelegramBotServiceForTests(null); setCallerConversationResolverForTests(null);
  for (const key of ["LLV_STATE_DIR", "LLV_VIEWER_CONTROL_URL", VIEWER_SPAWN_CAPABILITY_ENV]) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function file(name: string, bytes: Buffer, outside = false): string {
  const filename = path.join(outside ? home : handoff, name); fs.writeFileSync(filename, bytes); return filename;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected structured tool answer");
  return value as Record<string, unknown>;
}
async function send(filename: string, extra: Record<string, unknown> = {}, shown?: string) {
  const result = await client.callTool({ name: "telegram_bot_send_document", arguments: {
    clientRequestId: `office-request-${++requestSequence}`, chat: "reports", topicId: 7,
    document: { path: filename, caption: "Neutral report", ...(shown ? { filename: shown } : {}) }, ...extra,
  } });
  return object(result.structuredContent);
}
const formats = [
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["xls", "application/vnd.ms-excel"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
] as const;
const content = (kind: typeof formats[number][0], text?: string) => kind === "xls" ? legacyWorkbook(text) : officeZip(officeParts(kind, text));

test.each(formats)("%s reaches sendDocument with its MIME through SDK, tool service and real agent HTTP route", async (kind, mime) => {
  const bytes = content(kind), name = `report.${kind}`;
  const before = transport.callsOf("sendDocument").length;
  expect(await send(file(name, bytes), { replyToMessageId: 9, silent: true })).toMatchObject({ ok: true, attributedTo: { conversationId: "conversation_office" } });
  const calls = transport.callsOf("sendDocument"); expect(calls).toHaveLength(before + 1);
  expect(calls.at(-1)!.params).toMatchObject({ chat_id: chat.id, message_thread_id: 7, caption: "Neutral report", disable_notification: true, reply_parameters: { message_id: 9 } });
  const document = calls.at(-1)!.params.document;
  expect(document).toBeInstanceOf(File);
  if (!(document instanceof File)) throw new Error("Missing uploaded File");
  expect([document.name, document.type]).toEqual([name, mime]);
  expect(Buffer.from(await document.arrayBuffer())).toEqual(bytes);
});

test.each(formats)("%s retains size, roots, destination opt-in and filename guards", async kind => {
  const before = transport.callsOf("sendDocument").length;
  const normal = file(`guard.${kind}`, content(kind));
  expect(await send(file(`outside.${kind}`, content(kind), true))).toMatchObject({ ok: false, code: "document_outside_roots", details: { confirmation: { id: expect.any(String) } } });
  const large = file(`large.${kind}`, content(kind)); fs.truncateSync(large, DOCUMENT_MAX_BYTES + 1);
  expect(await send(large)).toMatchObject({ ok: false, code: "document_too_large" });
  expect(await send(normal, {}, "renamed.txt")).toMatchObject({ ok: false, code: "document_type" });
  expect(await send(normal, {}, kind === "docx" ? "renamed.xlsx" : "renamed.docx")).toMatchObject({ ok: false, code: "document_type" });
  expect(await send(normal, { chat: "unknown" })).toMatchObject({ ok: false, code: "chat_unknown" });
  expect(bot.status().chats.find(row => row.chatId === String(publicChat.id))).toMatchObject({ type: "channel", postAllowed: false });
  expect(await send(normal, { chat: "public-reports" })).toMatchObject({ ok: false, code: "chat_not_allowed" });
  bot.setChat(String(chat.id), "reports", false);
  try { expect(await send(normal)).toMatchObject({ ok: false, code: "chat_not_allowed" }); }
  finally { bot.setChat(String(chat.id), "reports", true); }
  expect(transport.callsOf("sendDocument")).toHaveLength(before);
  bot.setChat(String(publicChat.id), "public-reports", true);
  try { expect(await send(normal, { chat: "public-reports" })).toMatchObject({ ok: true }); }
  finally { bot.setChat(String(publicChat.id), "public-reports", false); }
  expect(transport.callsOf("sendDocument")).toHaveLength(before + 1);
  expect(transport.callsOf("sendDocument").at(-1)!.params.chat_id).toBe(publicChat.id);
});

test.each(formats)("%s secrets remain held for the owner's exact per-send consent", async kind => {
  const secret = ["gh", "p_", "Ab9".repeat(12)].join("");
  const bytes = content(kind, secret), filename = file(`held.${kind}`, bytes);
  const before = transport.callsOf("sendDocument").length;
  const answer = await send(filename);
  expect(answer).toMatchObject({ ok: false, code: "document_secret" });
  const confirmation = object(object(answer.details).confirmation);
  if (typeof confirmation.id !== "string") throw new Error("Missing confirmation id");
  const pending = bot.fileConfirmation(confirmation.id);
  expect(pending.files[0]?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(pending.reasons).toMatchObject([{ code: "document_secret" }]);
  expect(JSON.stringify(answer)).not.toContain(secret);
  expect(await send(filename)).toMatchObject({ ok: false, code: "document_secret" });
  expect(transport.callsOf("sendDocument")).toHaveLength(before);
  expect(await bot.decideFileConfirmation(confirmation.id, pending.digest, true, () => {})).toMatchObject({ parts: 1 });
  await expect(bot.decideFileConfirmation(confirmation.id, pending.digest, true, () => {})).rejects.toMatchObject({ code: "confirmation_invalid" });
  expect(transport.callsOf("sendDocument")).toHaveLength(before + 1);
  expect(await send(filename)).toMatchObject({ ok: false, code: "document_secret" });
});

test("OOXML inspection covers stored entries, metadata, UTF-16, XML entities and split text runs", async () => {
  const secret = ["gh", "p_", "Ab9".repeat(12)].join("");
  const variants: Record<string, string | Buffer>[] = [
    officeParts("xlsx", `&#103;${secret.slice(1)}`),
    officeParts("docx", `${secret.slice(0, 10)}</w:t></w:r><w:r><w:t>${secret.slice(10)}`),
    { ...officeParts("xlsx"), "docProps/custom.xml": `<p>${secret}</p>` },
    { ...officeParts("xlsx"), "docProps/custom.xml": Buffer.from(`<p>${secret}</p>`, "utf16le") },
    officeParts("xlsx", `${["pass", "word"].join("")}: ${["orchid", "harbor", "violet"].join("")}`),
  ];
  const before = transport.callsOf("sendDocument").length;
  for (const [index, parts] of variants.entries()) {
    const kind = index === 1 ? "docx" : "xlsx";
    expect(await send(file(`encoded-${index}.${kind}`, officeZip(parts, index !== 2)))).toMatchObject({ ok: false, code: "document_secret" });
  }
  expect(transport.callsOf("sendDocument")).toHaveLength(before);
});

test.each([false, true])("OOXML accepts clean stored and data-descriptor ZIP members (%s)", async descriptor => {
  expect(await send(file(`stored-${descriptor}.xlsx`, officeZip(officeParts("xlsx"), false, descriptor)))).toMatchObject({ ok: true });
});

test("uninspectable and oversized expanded Office packages cannot send or gain a consent bypass", async () => {
  const valid = officeZip(officeParts("xlsx"));
  const encrypted = Buffer.from(valid); encrypted.writeUInt16LE(1, 6);
  const checksum = officeZip(officeParts("xlsx"), false);
  checksum[checksum.indexOf(Buffer.from("Neutral report"))] ^= 1;
  const variants = [Buffer.from("invalid"), valid.subarray(0, valid.length - 8), encrypted,
    officeZip({ ...officeParts("xlsx"), "large.xml": Buffer.alloc(DOCUMENT_MAX_BYTES + 1, 32) }),
    officeZip(officeParts("docx")), checksum];
  const before = transport.callsOf("sendDocument").length;
  for (const [index, bytes] of variants.entries()) {
    const answer = await send(file(`invalid-${index}.xlsx`, bytes));
    expect(answer).toMatchObject({ ok: false, code: "document_invalid" });
    expect(object(answer.details)).not.toHaveProperty("confirmation");
  }
  expect(await send(file("invalid.xls", Buffer.from("invalid")))).toMatchObject({ ok: false, code: "document_type" });
  expect(transport.callsOf("sendDocument")).toHaveLength(before);
});
