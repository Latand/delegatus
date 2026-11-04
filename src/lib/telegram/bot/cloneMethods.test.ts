import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { POST as agentPost } from "@/app/api/telegram/bot/agent/route";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { setMcpHttpDependenciesForTests } from "@/lib/mcp/http";
import { createMcpToolService, MemoryMcpReceiptStore } from "@/lib/mcp/server";
import { viewerMcpBindings, viewerMcpToolPolicy, productionViewerControlDependencies } from "@/lib/mcp/bindings";
import { clonePairing, cloneReceipt, cloneTargets } from "@/lib/externalRelay/clone.fixture";
import { cloneMethodDescriptor, cloneMethodLimits, cloneMethodRights, cloneMethodsNow, clonePdfBytes, decodeCloneMultipart } from "@/lib/externalRelay/cloneMethods.fixture";
import type { CloneSendRights } from "@/lib/externalRelay/cloneMethods";
import { CloneDirectory } from "@/lib/externalRelay/cloneDirectory";
import { sendAsClone } from "@/lib/externalRelay/cloneSend";
import { startTestRelay } from "@/lib/externalRelay/testRelay";
import { externalRelayFile, updateRelayStore, writeRelayFile } from "@/lib/externalRelay/store";
import { TelegramBotService, productionTelegramBotDependencies, setTelegramBotServiceForTests } from "./service";
import { FakeBotTransport, fakeBotToken, ok } from "./fakeTransport";
import { outboundState } from "./outbound";
import { telegramBotTokenPath } from "./transport";
import type { ClonePostingPort } from "./clone";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "clone-methods-")), prior = process.env.LLV_STATE_DIR;
const group = { id: -1000000000101, type: "supergroup", title: "Fixture reports", is_forum: true };
let service: TelegramBotService, bot: FakeBotTransport, server: Awaited<ReturnType<typeof startTestRelay>>;
let directory: CloneDirectory, port: ClonePostingPort, relay: ReturnType<typeof clonePairing>;
let store: ReturnType<ReturnType<typeof productionTelegramBotDependencies>["openStore"]>;
let sends: Array<{ input: Record<string, unknown>; files: Map<string, File>; raw: Buffer | null }>;
let limits: ReturnType<typeof cloneMethodLimits>, rights: CloneSendRights | null, now: number, sequence = 0;
let answer: () => { status?: number; body?: unknown; drop?: boolean };
let pdf: string, photo: string, descriptors: number, rightsReads: number;
let advertised: boolean, limitsPresent: boolean;
let beforeReply: (() => Promise<void>) | null;
beforeEach(async () => {
  now = cloneMethodsNow; sends = []; limits = cloneMethodLimits(); rights = cloneMethodRights(); descriptors = 0; rightsReads = 0;
  beforeReply = null;
  advertised = true;
  limitsPresent = true;
  const home = path.join(root, String(++sequence), "home"), state = path.join(root, String(sequence), "state"); process.env.LLV_STATE_DIR = state;
  answer = () => ({ body: { ...cloneReceipt(100 + sends.length), message_ids: [100 + sends.length] } });
  server = await startTestRelay(async (req, body) => {
    if (req.url === "/.well-known/delegatus-relay.json") {
      descriptors++; const descriptor = cloneMethodDescriptor(server.origin, limits);
      return { body: { ...descriptor, features: advertised ? ["clone_send_methods"] : [], limits: limitsPresent ? descriptor.limits : relay.limits } };
    }
    if (req.url!.includes("include=rights")) { rightsReads++; return { body: { chats: [{ chat_id: group.id, send_rights: rights }], next_cursor: null } }; }
    if (req.url!.includes("include=chats")) return { body: cloneTargets() };
    if (!req.url!.endsWith("/send")) throw new Error("unexpected route");
    const decoded = Buffer.isBuffer(body) ? await decodeCloneMultipart(req.headers, body) : { input: body as Record<string, unknown>, files: new Map<string, File>() };
    if (Buffer.isBuffer(body)) expect(Number(req.headers["content-length"])).toBe(body.length);
    // The exact key must already be durable when the first byte reaches HTTP.
    const keys = await outboundState(store.filename, false, db => db.query<{ clone_keys: string }, []>("SELECT clone_keys FROM sends WHERE state='pending'").all());
    expect(keys.some(row => Object.values(JSON.parse(row.clone_keys)).includes(decoded.input.client_key))).toBe(true);
    sends.push({ ...decoded, raw: Buffer.isBuffer(body) ? body : null });
    await beforeReply?.();
    return answer();
  });
  relay = clonePairing(server.origin); relay.features = ["clone_send_methods"];
  directory = new CloneDirectory({ file: path.join(state, "clones.json"), relays: () => [relay], now: () => now, origin: server.origin });
  port = { route: chat => directory.route(chat), peek: chat => directory.peek(chat), valid: (r, chat) => directory.valid(r, chat),
    invalidate: (r, kind) => directory.invalidate(r, kind),
    send: (r, input, options) => sendAsClone(r.relay, r.targetId, input, { ...options, now: () => now, deadline: now + 500,
      sleep: async ms => { now += ms; } }) };
  bot = new FakeBotTransport();
  bot.handlers.getMe = () => ok({ id: 4242424, is_bot: true, first_name: "Fixture bot", username: "fixture_bot" });
  bot.handlers.getWebhookInfo = () => ok({ url: "https://example.invalid/webhook" });
  bot.handlers.getChatMember = () => ok({ status: "administrator" });
  for (const [index, method] of ["sendMessage", "sendDocument", "sendPhoto", "sendRichMessage"].entries()) bot.handlers[method] = () => ok({ message_id: 200 + index, date: Math.floor(now / 1000) });
  bot.handlers.sendMediaGroup = () => ok([101, 102].map(message_id => ({ message_id, date: Math.floor(now / 1000) })));
  service = new TelegramBotService({ ...productionTelegramBotDependencies(), clones: port, now: () => new Date(now),
    fileConfirmationId: () => "clone-methods-confirmation",
    transportFor: () => bot, documentEnvironment: () => ({ home, stateDir: state }) });
  await service.connect(fakeBotToken("4242424"));
  store = productionTelegramBotDependencies().openStore();
  store.recordLookedUpChat(group, "member", new Date(now)); service.setChat(String(group.id), "reports", true);
  const handoff = path.join(home, "handoff"); fs.mkdirSync(handoff, { recursive: true });
  pdf = path.join(handoff, "report.pdf"); fs.writeFileSync(pdf, clonePdfBytes());
  photo = path.join(handoff, "frame.png");
  await (await import("sharp")).default({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toFile(photo);
});
afterEach(async () => { store.close(); await service.remove(); await server.close(); });
afterAll(() => { if (prior === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = prior; fs.rmSync(root, { recursive: true, force: true }); });
const common = (key: string) => ({ conversationId: "fixture-writer", clientRequestId: key, chat: "reports", topicId: 12, replyToMessageId: 17, silent: true });
const document = (key = "pdf") => service.sendDocument({ ...common(key), document: { path: pdf, caption: "Fixture PDF" } });
const media = (key = "photo", album = false) => service.sendMedia({ ...common(key), images: (album ? [photo, photo] : [photo]).map(path => ({ path, caption: "Fixture photo" })) });
async function restartDocument(key: string) {
  const script = `import {TelegramBotService,productionTelegramBotDependencies} from './src/lib/telegram/bot/service';
    import {FakeBotTransport} from './src/lib/telegram/bot/fakeTransport';
    const bot=new FakeBotTransport();
    const service=new TelegramBotService({...productionTelegramBotDependencies(),transportFor:()=>bot,now:()=>new Date(${cloneMethodsNow})});
    try { const result=await service.sendDocument(JSON.parse(process.env.CLONE_FIXTURE_SEND)); console.log(JSON.stringify({result,calls:bot.calls})); }
    catch(error) {console.log(JSON.stringify({code:error.code,calls:bot.calls}));}
    finally {await service.stopPublications();service['store']().close();}`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, CLONE_FIXTURE_SEND: JSON.stringify({ ...common(key), document: { path: pdf } }) }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ error, exit }).toEqual({ error: "", exit: 0 }); return JSON.parse(output);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); await child.exited; }
}

test("PDF and photo use the clone with exact bytes, topic, reply, silence and real rights", async () => {
  bot.handlers.getChatMember = () => ok({ status: "kicked" });
  expect(await document()).toMatchObject({ messageIds: [101], sentBy: { name: "Report clone" } });
  expect(await media()).toMatchObject({ messageIds: [102], sentBy: { name: "Report clone" } });
  expect(sends).toHaveLength(2);
  for (const [index, method, field, filename] of [[0, "sendDocument", "document", pdf], [1, "sendPhoto", "photo", photo]] as const) {
    expect(sends[index]!.input).toMatchObject({ method, [field]: `attach://${field}`, chat_id: group.id, silent: true,
      message_thread_id: 12, reply_to_message_id: 17 });
    expect(Buffer.from(await sends[index]!.files.get(field)!.arrayBuffer())).toEqual(fs.readFileSync(filename));
    expect(bot.callsOf(method)).toHaveLength(0);
  }
  expect(service.listChats().chats[0]!.bots?.[0]).toMatchObject({ canPost: true, canSendPhotos: true, canSendDocuments: true, checkedAt: rights!.read_at, status: "member" });
  expect(descriptors).toBe(1); expect(rightsReads).toBe(1);
  expect(await document()).toMatchObject({ alreadySent: true }); expect(sends).toHaveLength(2);
  expect(await restartDocument("pdf")).toMatchObject({ result: { alreadySent: true, messageIds: [101] }, calls: [] });
});
test("a pairing alone sends files without a local bot token", async () => {
  fs.rmSync(telegramBotTokenPath());
  const before = bot.calls.length;
  expect(await document()).toMatchObject({ messageIds: [101], sentBy: { name: "Report clone" } });
  expect(await media()).toMatchObject({ messageIds: [102], sentBy: { name: "Report clone" } });
  expect(bot.calls).toHaveLength(before); expect(sends).toHaveLength(2);
});
test("without the feature, a pairing-only file send retains its disconnected refusal", async () => {
  fs.rmSync(telegramBotTokenPath()); relay.features = [];
  await expect(document()).rejects.toMatchObject({ code: "bot_not_connected" });
  expect(sends).toEqual([]); expect(descriptors).toBe(0); expect(rightsReads).toBe(0);
  expect(await service.send({ ...common("legacy-pairing-text"), text: "Legacy" })).toMatchObject({ sentBy: { name: "Report clone" } });
});
test.each(["approve", "revoke"] as const)("pairing-only file confirmation can %s under current clone custody", async mode => {
  fs.rmSync(telegramBotTokenPath());
  const filename = path.join(path.dirname(path.dirname(pdf)), "outside.md"); fs.writeFileSync(filename, "Fixture report");
  let id = "";
  try { await service.sendDocument({ ...common("pairing-confirmation"), document: { path: filename } }); }
  catch (error) { id = (error as { extra: { confirmation: { id: string } } }).extra.confirmation.id; }
  expect(id).not.toBe(""); expect(sends).toEqual([]);
  const confirmation = service.fileConfirmation(id);
  if (mode === "revoke") relay.paused = true;
  const decision = service.decideFileConfirmation(id, confirmation.digest, true, () => {});
  if (mode === "approve") { expect(await decision).toMatchObject({ sentBy: { name: "Report clone" } }); expect(sends).toHaveLength(1); }
  else { await expect(decision).rejects.toMatchObject({ code: "bot_not_connected" }); expect(sends).toEqual([]); }
});
test("album receipts keep Telegram order and rich-message media are JSON", async () => {
  answer = () => ({ body: { ...cloneReceipt(107), message_ids: [107, 103] } });
  expect(await media("album", true)).toMatchObject({ messageIds: [107, 103], parts: 2, sentBy: { name: "Report clone" } });
  expect(sends[0]!.input.media).toEqual([0, 1].map(i => ({ type: "photo", media: `attach://photo${i}`, caption: "Fixture photo", parse_mode: null })));
  expect([...sends[0]!.files.keys()]).toEqual(["photo0", "photo1"]);
  answer = () => ({ body: { ...cloneReceipt(), message_ids: [101] } });
  await service.sendRichMessage({ clientRequestId: "rich", chat: "reports", message: { markdown: "Fixture image", images: [{ id: "frame", blob: new Blob([fs.readFileSync(photo)], { type: "image/png" }) }] } });
  expect(sends[1]!.input.rich_message).toEqual({ markdown: "Fixture image", media: [{ id: "frame", media: { type: "photo", media: "attach://frame" } }] });
  expect(bot.callsOf("sendMediaGroup")).toHaveLength(0); expect(bot.callsOf("sendRichMessage")).toHaveLength(0);
});
test.each(["absent", "denied", "expired"] as const)("%s file rights never authorize clone media", async mode => {
  if (mode === "absent") rights = null;
  else if (mode === "denied") rights = cloneMethodRights({ can_send_photos: false, can_send_documents: false });
  else rights = cloneMethodRights({ read_at: new Date(now - 60001).toISOString() });
  expect(await document()).toMatchObject({ sentBy: { name: "Fixture bot" } });
  expect(await media()).toMatchObject({ sentBy: { name: "Fixture bot" } });
  expect(sends).toEqual([]); expect(bot.callsOf("sendDocument")).toHaveLength(1); expect(bot.callsOf("sendPhoto")).toHaveLength(1);
  expect(await service.send({ ...common("text-without-file-rights"), text: "Fixture text" })).toMatchObject({ sentBy: { name: "Report clone" } });
  expect(sends).toHaveLength(1); expect(sends[0]!.input.method).toBe("sendMessage");
});
test.each(["method", "file-size", "mime", "total", "body", "caption", "pixels", "html"] as const)("descriptor %s limit keeps the local file route", async mode => {
  if (mode === "method") limits.methods = ["sendMessage"];
  if (mode === "file-size") limits.files.document.max_bytes = 1;
  if (mode === "mime") limits.files.document.mime_types = ["text/plain"];
  if (mode === "total") limits.max_total_file_bytes = 1;
  if (mode === "body") limits.max_body_bytes = 1;
  if (mode === "caption") limits.max_caption_utf16 = 1;
  if (mode === "pixels") limits.files.photo.max_pixels = 1;
  if (mode === "html") { pdf = pdf.replace(/pdf$/, "html"); fs.writeFileSync(pdf, "<html><body>Fixture</body></html>"); limits.files.document.mime_types.push("text/html"); }
  expect(await (mode === "pixels" ? media() : document())).toMatchObject({ sentBy: { name: "Fixture bot" } });
  expect(sends).toEqual([]);
});
test.each(["unused", "pending", "uncertain", "taken", "absent"] as const)("key_state %s owns fallback and durable replay", async state => {
  answer = () => ({ status: state === "unused" ? 403 : 409, body: { error: { code: state === "unused" ? "not_enough_rights" : "send_uncertain",
    ...(state === "absent" ? {} : { key_state: state }) } } });
  if (state === "unused") {
    expect(await document()).toMatchObject({ messageIds: [201], sentBy: { name: "Fixture bot" }, refusals: [expect.objectContaining({ code: "not_enough_rights" })] });
    expect(bot.callsOf("sendDocument")).toHaveLength(1);
  } else {
    await expect(document()).rejects.toMatchObject({ code: "send_uncertain" });
    await expect(document()).rejects.toMatchObject({ code: "send_uncertain" });
    expect(store.sendRow("document:fixture-writer", "pdf")?.state).toBe("pending");
    expect(bot.callsOf("sendDocument")).toHaveLength(0);
    expect(await restartDocument("pdf")).toMatchObject({ code: "send_uncertain", calls: [] });
  }
  expect(sends).toHaveLength(1);
});
test("each text part persists its own key before HTTP", async () => {
  await service.send({ ...common("parts"), text: "x".repeat(5000) });
  expect(sends).toHaveLength(2);
  const row = await outboundState(store.filename, false, db => db.query<{ clone_keys: string }, []>("SELECT clone_keys FROM sends WHERE client_request_id='parts'").get());
  expect(JSON.parse(row!.clone_keys)).toEqual({ 0: sends[0]!.input.client_key, 1: sends[1]!.input.client_key });
  expect(sends[0]!.input.client_key).not.toBe(sends[1]!.input.client_key);
});
test.each(["roots", "detector"] as const)("%s confirmation gates stay before clone transport", async mode => {
  const filename = path.join(path.dirname(path.dirname(pdf)), mode === "roots" ? "outside.md" : "handoff/secret.md");
  fs.writeFileSync(filename, mode === "roots" ? "Fixture outside roots" : ["-----BEGIN ", "PRIVATE KEY-----"].join(""));
  const input = { ...common("confirmation"), document: { path: filename } };
  let id = "";
  try { await service.sendDocument(input); throw new Error("confirmation was bypassed"); }
  catch (error) {
    const refusal = error as { code: string; extra?: { confirmation?: { id: string } } };
    expect(refusal.code).toBe(mode === "roots" ? "document_outside_roots" : "document_secret");
    id = refusal.extra!.confirmation!.id;
  }
  expect(sends).toEqual([]); expect(bot.callsOf("sendDocument")).toHaveLength(0);
  const confirmation = service.fileConfirmation(id);
  expect(await service.decideFileConfirmation(id, confirmation.digest, true, () => {})).toMatchObject({ messageIds: [101] });
  expect(service.fileConfirmation(id).state).toBe("sent");
  expect(sends).toHaveLength(1); expect(sends[0]!.input.method).toBe("sendDocument");
});
test("lost reply retries the same multipart bytes and key, then adopts the replay", async () => {
  answer = () => sends.length === 1 ? { drop: true } : { body: { ...cloneReceipt(101, true), message_ids: [101] } };
  expect(await document()).toMatchObject({ messageIds: [101], sentBy: { name: "Report clone" } });
  expect(sends).toHaveLength(2); expect(sends[0]!.raw).toEqual(sends[1]!.raw);
  expect(bot.callsOf("sendDocument")).toHaveLength(0);
});
test.each(["file-default", "file-short", "text-default"] as const)("%s keeps its pinned deadline while the real relay reply is held", async mode => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  beforeReply = async () => { entered(); await held; };
  port.send = (route, input, options) => sendAsClone(route.relay, route.targetId, input, { ...options, now: () => now,
    ...(mode === "file-short" ? { deadline: now + 25000 } : {}) });
  const send = () => mode === "text-default" ? service.send({ ...common("held-deadline"), text: "Fixture text" }) : document("held-deadline");
  const pending = send();
  try {
    await Promise.race([started, pending.then(() => { throw new Error("send finished before the relay read"); })]);
    now += 125000;
    release();
    if (mode === "file-default") expect(await pending).toMatchObject({ messageIds: [101], sentBy: { name: "Report clone" } });
    else { await expect(pending).rejects.toMatchObject({ code: "send_uncertain" }); await expect(send()).rejects.toMatchObject({ code: "send_uncertain" }); }
    expect(sends).toHaveLength(1); expect(bot.callsOf(mode === "text-default" ? "sendMessage" : "sendDocument")).toHaveLength(0);
  } finally { release(); await pending.catch(() => {}); }
});
test("a later explicit unused state permits fallback after a lost reply", async () => {
  answer = () => sends.length === 1 ? { drop: true } : { status: 413, body: { error: { code: "too_large", key_state: "unused" } } };
  expect(await document()).toMatchObject({ sentBy: { name: "Fixture bot" }, refusals: [expect.objectContaining({ code: "document_too_large" })] });
  expect(sends).toHaveLength(2); expect(sends[0]!.raw).toEqual(sends[1]!.raw);
  expect(bot.callsOf("sendDocument")).toHaveLength(1);
});
test.each(["missing", "short", "duplicate", "first", "extra"] as const)("%s album receipt remains uncertain without another bot", async mode => {
  const ids = mode === "short" ? [101] : mode === "duplicate" ? [101, 101] : mode === "first" ? [102, 101]
    : mode === "extra" ? [101, 102, 103] : undefined;
  answer = () => ({ body: { ...cloneReceipt(), ...(ids ? { message_ids: ids } : {}) } });
  await expect(media("bad-receipt", true)).rejects.toMatchObject({ code: "send_uncertain" });
  await expect(media("bad-receipt", true)).rejects.toMatchObject({ code: "send_uncertain" });
  expect(sends).toHaveLength(1); expect(bot.callsOf("sendMediaGroup")).toHaveLength(0);
});
test.each(["pairing", "descriptor", "limits"] as const)("feature absent in %s preserves legacy text wire and local files", async source => {
  if (source === "pairing") relay.features = [];
  else if (source === "descriptor") advertised = false;
  else limitsPresent = false;
  expect(await document()).toMatchObject({ sentBy: { name: "Fixture bot" } });
  expect(await media()).toMatchObject({ sentBy: { name: "Fixture bot" } });
  await service.send({ ...common("text"), text: "Legacy text", format: "html" });
  expect(sends[0]!.input).toEqual({ client_key: expect.any(String), chat_id: group.id, text: "Legacy text", parse_mode: "HTML", silent: true, reply_to_message_id: 17, message_thread_id: 12 });
  expect(sends[0]!.raw).toBeNull(); expect(descriptors).toBe(source === "pairing" ? 0 : 1); expect(rightsReads).toBe(0);
});
test("allowlist, assignment, pairing and expired rights are rechecked before emission", async () => {
  const send = port.send;
  port.send = async (r, input, options) => { relay.paused = true; return send(r, input, options); };
  expect(await document("paused")).toMatchObject({ sentBy: { name: "Fixture bot" } });
  relay.paused = false; port.send = send;
  const route = port.route;
  port.route = async chat => { const result = await route(chat); service.setChat(chat, "reports", false); return result; };
  await expect(document("revoked")).rejects.toMatchObject({ code: "chat_not_allowed" });
  expect(sends).toEqual([]);
});
test.each(["document", "media", "album"] as const)("SDK MCP %s reaches real service, transport and port-0 relay", async kind => {
  const date = spyOn(Date, "now").mockReturnValue(cloneMethodsNow);
  writeRelayFile(externalRelayFile("relays"), { v: 1, installId: "fixture-install", label: "Fixture", relays: [relay], pending: [] });
  let tick = 0, timerId = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  const scheduler = { setTimeout: (fn: () => void, ms: number) => { const id = ++timerId; timers.set(id, { due: tick + ms, fn }); return id; },
    clearTimeout: (id: unknown) => { timers.delete(id as number); } };
  let releaseReply = () => {}, arrived = Promise.resolve(), finished = Promise.resolve(), backendStarted = false;
  if (kind === "document") {
    let entered!: () => void, finish!: () => void;
    arrived = new Promise<void>(resolve => { entered = resolve; });
    finished = new Promise<void>(resolve => { finish = resolve; });
    const held = new Promise<void>(resolve => { releaseReply = resolve; });
    beforeReply = async () => { entered(); await held; };
    const sendDocument = service.sendDocument.bind(service);
    service.sendDocument = input => { backendStarted = true; return sendDocument(input).finally(finish); };
  }
  const capability = "C".repeat(43), oldControl = process.env.LLV_VIEWER_CONTROL_URL, oldToken = process.env.LLV_VIEWER_CONTROL_TOKEN;
  process.env.LLV_VIEWER_CONTROL_TOKEN = "D".repeat(43);
  setTelegramBotServiceForTests(service); setCallerConversationResolverForTests(() => "fixture-writer");
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => new URL(req.url).pathname === "/api/mcp" ? mcpPost(new NextRequest(req)) : agentPost(new NextRequest(req)) });
  process.env.LLV_VIEWER_CONTROL_URL = listener.url.origin;
  const mcp = createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true, scheduler)), new MemoryMcpReceiptStore(), viewerMcpToolPolicy());
  const callBudgets: number[] = [], callTool = mcp.callTool.bind(mcp);
  mcp.callTool = (name, args, context) => { callBudgets.push((context?.deadlineAt ?? cloneMethodsNow) - cloneMethodsNow); return callTool(name, args, context); };
  setMcpHttpDependenciesForTests({ service: async () => mcp, conversationForCapability: value => value === capability ? "fixture-writer" : null });
  const client = new Client({ name: "clone-methods-fixture", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", listener.url), { requestInit: { headers: { "x-llv-spawn-capability": capability } } }));
    if (kind === "album") answer = () => ({ body: { ...cloneReceipt(), message_ids: [101, 102] } });
    const args = { clientRequestId: "mcp-file", chat: "reports", topicId: 12, ...(kind === "document" ? { document: { path: pdf } }
      : { images: (kind === "album" ? [photo, photo] : [photo]).map(path => ({ path, caption: "Fixture" })) }) };
    const call = () => client.callTool({ name: kind === "document" ? "telegram_bot_send_document" : "telegram_bot_send_media", arguments: args }, undefined, { timeout: 480000 });
    const pending = call();
    if (kind === "document") {
      await Promise.race([arrived, pending.then(() => { throw new Error("file call ended before relay admission"); })]);
      tick += 6000;
      for (const [id, timer] of [...timers]) if (timer.due <= tick) { timers.delete(id); timer.fn(); }
      releaseReply();
    }
    const receipt = await pending; await finished;
    expect(receipt.structuredContent).toMatchObject({ ok: true, messageIds: kind === "album" ? [101, 102] : [101], sentBy: { name: "Report clone" } });
    expect(callBudgets[0]).toBe(480000);
    expect((await call()).structuredContent).toMatchObject({ ok: true, replayed: true }); expect(sends).toHaveLength(1);
    service.setChat(String(group.id), "reports", false);
    expect((await client.callTool({ name: kind === "document" ? "telegram_bot_send_document" : "telegram_bot_send_media",
      arguments: { ...args, clientRequestId: "not-allowed" } })).structuredContent).toMatchObject({ ok: false, code: "chat_not_allowed" });
    expect(sends).toHaveLength(1);
    expect((await client.callTool({ name: kind === "document" ? "telegram_bot_send_document" : "telegram_bot_send_media",
      arguments: { ...args, clientRequestId: "short-caller" }, _meta: { "delegatus/deadlineAt": cloneMethodsNow + 2000 } })).structuredContent).toMatchObject({ ok: false, code: "chat_not_allowed" });
    expect(callBudgets.at(-1)).toBe(2000);
    service.setChat(String(group.id), "reports", true); relay.features = [];
    updateRelayStore(store => ({ ...store, relays: [relay] }));
    expect((await client.callTool({ name: kind === "document" ? "telegram_bot_send_document" : "telegram_bot_send_media",
      arguments: { ...args, clientRequestId: "feature-absent" } })).structuredContent).toMatchObject({ ok: true, sentBy: { name: "Fixture bot" } });
    expect(sends).toHaveLength(1);
    expect(callBudgets.at(-1)).toBe(30000);
  } finally {
    releaseReply(); if (backendStarted) await finished;
    await client.close(); await listener.stop(true);
    setMcpHttpDependenciesForTests(null); setTelegramBotServiceForTests(null); setCallerConversationResolverForTests(null);
    if (oldControl === undefined) delete process.env.LLV_VIEWER_CONTROL_URL; else process.env.LLV_VIEWER_CONTROL_URL = oldControl;
    if (oldToken === undefined) delete process.env.LLV_VIEWER_CONTROL_TOKEN; else process.env.LLV_VIEWER_CONTROL_TOKEN = oldToken;
    date.mockRestore();
  }
});
