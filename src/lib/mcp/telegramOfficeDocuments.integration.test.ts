import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextRequest } from "next/server";
import { officeParts, officeZip } from "@/lib/telegram/bot/officeDocuments.fixture";

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
    { update_id: 2, my_chat_member: { chat: publicChat, date: 1, new_chat_member: { status: "administrator", can_post_messages: true } } },
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
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
] as const;
const content = (kind: typeof formats[number][0], text?: string) => officeZip(officeParts(kind, text));

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
  expect(Buffer.from(await document.arrayBuffer()).equals(bytes)).toBe(true);
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

test.each(formats)("%s sends a secret with its MIME only after exact per-send consent", async (kind, mime) => {
  const secret = ["gh", "p_", "Ab9".repeat(12)].join("");
  const name = `held.${kind}`, bytes = content(kind, secret), filename = file(name, bytes);
  const before = transport.callsOf("sendDocument").length;
  const answer = await send(filename);
  expect(answer).toMatchObject({ ok: false, code: "document_secret" });
  const confirmation = object(object(answer.details).confirmation);
  if (typeof confirmation.id !== "string") throw new Error("Missing confirmation id");
  const pending = bot.fileConfirmation(confirmation.id);
  expect(pending.files[0]?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(pending.reasons).toMatchObject([{ code: "document_secret" }]);
  expect(pending).toMatchObject({ chatId: String(chat.id), topicId: 7 });
  expect(JSON.stringify(answer)).not.toContain(secret);

  fs.writeFileSync(filename, content(kind, secret + "A"));
  await expect(bot.decideFileConfirmation(confirmation.id, pending.digest, true, () => {})).rejects.toMatchObject({ code: "confirmation_invalid" });
  expect(transport.callsOf("sendDocument")).toHaveLength(before);

  fs.writeFileSync(filename, bytes);
  const retry = await send(filename);
  // Read the id first: an asymmetric matcher in toMatchObject replaces the matched value.
  const retryId = object(object(retry.details).confirmation).id;
  if (typeof retryId !== "string") throw new Error("Missing confirmation id");
  expect(retryId).not.toBe(confirmation.id);
  expect(retry).toMatchObject({ ok: false, code: "document_secret" });
  expect(transport.callsOf("sendDocument")).toHaveLength(before);
  const { digest } = bot.fileConfirmation(retryId);
  expect(await bot.decideFileConfirmation(retryId, digest, true, () => {})).toMatchObject({ parts: 1 });
  await expect(bot.decideFileConfirmation(retryId, digest, true, () => {})).rejects.toMatchObject({ code: "confirmation_invalid" });
  expect(await send(filename)).toMatchObject({ ok: false, code: "document_secret" });
  const calls = transport.callsOf("sendDocument");
  expect(calls).toHaveLength(before + 1);
  expect(calls.at(-1)!.params).toMatchObject({ chat_id: chat.id, message_thread_id: 7 });
  const upload = calls.at(-1)!.params.document;
  expect(upload).toBeInstanceOf(File);
  if (!(upload instanceof File)) throw new Error("Missing uploaded File");
  expect([upload.name, upload.type]).toEqual([name, mime]);
  expect(Buffer.from(await upload.arrayBuffer()).equals(bytes)).toBe(true);
});

test.each(["docx", "xlsx"] as const)("formatted %s rich text still needs secret consent", async kind => {
  const secret = ["gh", "p_", "Ab9".repeat(12)].join("");
  const split = kind === "docx"
    ? `${secret.slice(0, 10)}</w:t></w:r>\n  <w:r><w:t>${secret.slice(10)}`
    : `${secret.slice(0, 10)}</t></r>\n  <r><t>${secret.slice(10)}`;
  const parts = officeParts(kind, kind === "docx" ? split : "Neutral report");
  if (kind === "xlsx") parts["xl/worksheets/sheet1.xml"] = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><r><t>${split}</t></r></is></c></row></sheetData></worksheet>`;
  const before = transport.callsOf("sendDocument").length;
  const answer = await send(file(`formatted.${kind}`, officeZip(parts)));
  expect(answer).toMatchObject({ ok: false, code: "document_secret", details: { confirmation: { id: expect.any(String) } } });
  expect(transport.callsOf("sendDocument")).toHaveLength(before);
});

test("PPTX joins indented runs after a separate paragraph", async () => {
  const secret = ["gh", "p_", "Ab9".repeat(12)].join("");
  const text = `Heading</a:t></a:r></a:p>\n<a:p><a:r><a:t>${secret.slice(0, 10)}</a:t></a:r>\n  <a:r><a:t>${secret.slice(10)}`;
  const before = transport.callsOf("sendDocument").length;
  expect(await send(file("formatted.pptx", content("pptx", text)))).toMatchObject({
    ok: false, code: "document_secret", details: { confirmation: { id: expect.any(String) } },
  });
  expect(transport.callsOf("sendDocument")).toHaveLength(before);
});

test("DOCX keeps spaces inside text runs while dropping the surrounding XML indentation", async () => {
  const secret = ["gh", "p_", "Ab9".repeat(12)].join("");
  const text = `Heading</w:t></w:r>\n  <w:r><w:t xml:space="preserve"> </w:t></w:r>\n  <w:r><w:t>${secret.slice(0, 10)}</w:t></w:r>\n  <w:r><w:t>${secret.slice(10)}`;
  const before = transport.callsOf("sendDocument").length;
  expect(await send(file("space.docx", content("docx", text)))).toMatchObject({
    ok: false, code: "document_secret", details: { confirmation: { id: expect.any(String) } },
  });
  expect(transport.callsOf("sendDocument")).toHaveLength(before);
});

test.each([
  ["docx", "</w:t></w:r><w:r><w:t> </w:t></w:r><w:r><w:t>"],
  ["xlsx", "</t></r><r><t>\n  </t></r><r><t>"],
  ["pptx", "</a:t></a:r><a:r><a:t>\t</a:t></a:r><a:r><a:t>"],
] as const)("%s whitespace-only runs outside xml:space=preserve cannot split a token from consent", async (kind, run) => {
  const secret = ["gh", "p_", "Ab9".repeat(12)].join("");
  const split = secret.slice(0, 10) + run + secret.slice(10);
  const parts = officeParts(kind, kind === "xlsx" ? "Neutral report" : split);
  if (kind === "xlsx") parts["xl/worksheets/sheet1.xml"] = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><r><t>${split}</t></r></is></c></row></sheetData></worksheet>`;
  const before = transport.callsOf("sendDocument").length;
  expect(await send(file(`blank-run.${kind}`, officeZip(parts)))).toMatchObject({
    ok: false, code: "document_secret", details: { confirmation: { id: expect.any(String) } },
  });
  expect(transport.callsOf("sendDocument")).toHaveLength(before);
});

test("DOCX keeps a preserved space between runs as a word boundary", async () => {
  const secret = ["gh", "p_", "Ab9".repeat(12)].join("");
  const text = `${secret.slice(0, 10)}</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>${secret.slice(10)}`;
  const before = transport.callsOf("sendDocument").length;
  expect(await send(file("preserved-space.docx", content("docx", text)))).toMatchObject({ ok: true });
  expect(transport.callsOf("sendDocument")).toHaveLength(before + 1);
});

test.each([
  ["docx", "</w:t></w:r></w:p><w:p><w:r><w:t>"],
  ["xlsx", '</t></is></c><c r="B1" t="inlineStr"><is><t>'],
  ["pptx", "</a:t></a:r></a:p><a:p><a:r><a:t>"],
] as const)("%s keeps separate paragraphs or cells from forming one token", async (kind, boundary) => {
  const secret = ["gh", "p_", "Ab9".repeat(12)].join("");
  const before = transport.callsOf("sendDocument").length;
  const text = secret.slice(0, 10) + boundary + secret.slice(10);
  expect(await send(file(`separate.${kind}`, content(kind, text)))).toMatchObject({ ok: true });
  expect(transport.callsOf("sendDocument")).toHaveLength(before + 1);
});

test("OOXML inspection covers stored entries, metadata, UTF-16, XML entities and split text runs", async () => {
  const secret = ["gh", "p_", "Ab9".repeat(12)].join("");
  const variants: Record<string, string | Buffer>[] = [
    officeParts("xlsx", `&#103;${secret.slice(1)}`),
    officeParts("docx", `${secret.slice(0, 10)}</w:t></w:r><w:r><w:t>${secret.slice(10)}`),
    { ...officeParts("xlsx"), "docProps/custom.xml": `<p>${secret}</p>` },
    { ...officeParts("xlsx"), "docProps/custom.xml": Buffer.from(`<p>${secret}</p>`, "utf16le") },
    officeParts("xlsx", `${["pass", "word"].join("")}: ${["orchid", "harbor", "violet"].join("")}`),
    { ...officeParts("xlsx"), "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Earlier cell</t></is></c><c r="B1" t="inlineStr"><is><r><t>${secret.slice(0, 10)}</t></r><r><t>${secret.slice(10)}</t></r></is></c></row></sheetData></worksheet>` },
  ];
  const before = transport.callsOf("sendDocument").length;
  for (const [index, parts] of variants.entries()) {
    const kind = index === 1 ? "docx" : "xlsx";
    expect(await send(file(`encoded-${index}.${kind}`, officeZip(parts, index !== 2)))).toMatchObject({ ok: false, code: "document_secret" });
  }
  expect(transport.callsOf("sendDocument")).toHaveLength(before);
});

test.each([
  ["line break", "<w:r><w:t>Notes</w:t><w:br/></w:r>"],
  ["tab", "<w:r><w:t>Notes</w:t><w:tab/></w:r>"],
] as const)("DOCX %s boundaries keep a following provider token under per-send confirmation", async (label, prefix) => {
  const secret = ["gh", "p_", "Ab9".repeat(12)].join("");
  const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>${prefix}<w:r><w:t>${secret.slice(0, 10)}</w:t></w:r><w:r><w:t>${secret.slice(10)}</w:t></w:r></w:p></w:body></w:document>`;
  const bytes = officeZip({ ...officeParts("docx"), "word/document.xml": documentXml });
  const before = transport.callsOf("sendDocument").length;
  const answer = await send(file(`boundary-${label}.docx`, bytes));
  expect(answer).toMatchObject({ ok: false, code: "document_secret", details: { confirmation: { id: expect.any(String) } } });
  expect(transport.callsOf("sendDocument")).toHaveLength(before);
});

test("DOCX comments end at their closing delimiter while visible text runs stay joined for secret scanning", async () => {
  const secret = ["gh", "p_", "Ab9".repeat(12)].join("");
  const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${secret.slice(0, 10)}</w:t></w:r><!-- invisible >annotation --><w:r><w:t>${secret.slice(10)}</w:t></w:r></w:p></w:body></w:document>`;
  const bytes = officeZip({ ...officeParts("docx"), "word/document.xml": documentXml });
  const before = transport.callsOf("sendDocument").length;
  const answer = await send(file("commented-secret.docx", bytes));
  expect(answer).toMatchObject({ ok: false, code: "document_secret", details: { confirmation: { id: expect.any(String) } } });
  expect(transport.callsOf("sendDocument")).toHaveLength(before);
});

test.each([
  ["carriage return", "<w:r><w:t>Notes</w:t><w:cr/></w:r><w:r><w:t>"],
  ["processing instruction", "<w:r><w:t>"],
  ["quoted style attribute", "<w:r><w:t>"],
] as const)("DOCX %s syntax cannot hide a split provider token from confirmation", async (label, beforeToken) => {
  const secret = ["gh", "p_", "Ab9".repeat(12)].join("");
  const split = label === "carriage return"
    ? `${secret.slice(0, 10)}</w:t></w:r><w:r><w:t>${secret.slice(10)}`
    : label === "processing instruction"
      ? `${secret.slice(0, 10)}</w:t></w:r><?annotation invisible > note?><w:r><w:t>${secret.slice(10)}`
      : `${secret.slice(0, 10)}</w:t></w:r><w:r><w:rPr><w:rStyle w:val=">annotation"/></w:rPr><w:t>${secret.slice(10)}`;
  const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>${beforeToken}${split}</w:t></w:r></w:p></w:body></w:document>`;
  const bytes = officeZip({ ...officeParts("docx"), "word/document.xml": documentXml });
  const before = transport.callsOf("sendDocument").length;
  const answer = await send(file(`lexical-${label}.docx`, bytes));
  expect(answer).toMatchObject({ ok: false, code: "document_secret", details: { confirmation: { id: expect.any(String) } } });
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
  const missingRelationships = officeParts("xlsx");
  delete missingRelationships["_rels/.rels"];
  const secret = ["gh", "p_", "Ab9".repeat(12)].join("");
  const variants = [Buffer.from("invalid"), valid.subarray(0, valid.length - 8), encrypted,
    officeZip({ ...officeParts("xlsx"), "large.xml": Buffer.alloc(DOCUMENT_MAX_BYTES + 1, 32) }),
    officeZip(officeParts("docx")), checksum, officeZip(missingRelationships),
    officeZip({ ...officeParts("xlsx", secret), "docProps/custom.xml": "<property><value></property>" }),
    officeZip({ ...officeParts("xlsx"), "docProps/custom.xml": "<property><!-- unfinished" }),
    officeZip({ ...officeParts("xlsx"), "docProps/custom.xml": "<!DOCTYPE property><property/>" }),
    officeZip({ ...officeParts("xlsx"), "docProps/custom.xml": Buffer.from([0x3c, 0xc0, 0x3e]) }),
    officeZip({ ...officeParts("xlsx"), "docProps/custom.xml": '<?xml version="1.0" encoding="windows-1252"?><property/>' })];
  const before = transport.callsOf("sendDocument").length;
  for (const [index, bytes] of variants.entries()) {
    const answer = await send(file(`invalid-${index}.xlsx`, bytes));
    expect(answer).toMatchObject({ ok: false, code: "document_invalid" });
    expect(object(answer.details)).not.toHaveProperty("confirmation");
  }
  expect(await send(file("invalid.xls", Buffer.from("invalid")))).toMatchObject({ ok: false, code: "document_type" });
  expect(transport.callsOf("sendDocument")).toHaveLength(before);
});

test.each(["docx", "pptx"] as const)("%s packages that are truncated or hold malformed XML refuse without a confirmation", async kind => {
  const valid = officeZip(officeParts(kind));
  const main = kind === "docx" ? "word/document.xml" : "ppt/presentation.xml";
  const variants = [valid.subarray(0, Math.floor(valid.length / 2)), valid.subarray(0, valid.length - 8),
    officeZip({ ...officeParts(kind), [main]: "<unclosed>" }),
    officeZip({ ...officeParts(kind), "docProps/app.xml": "<Properties><Company>Neutral</Properties>" })];
  const before = transport.callsOf("sendDocument").length;
  for (const [index, bytes] of variants.entries()) {
    const answer = await send(file(`broken-${index}.${kind}`, bytes));
    expect(answer).toMatchObject({ ok: false, code: "document_invalid" });
    expect(object(answer.details)).not.toHaveProperty("confirmation");
  }
  expect(transport.callsOf("sendDocument")).toHaveLength(before);
});
