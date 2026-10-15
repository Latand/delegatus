import { Database } from "bun:sqlite";
import { scopedOutbound } from "./outbound";
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { TelegramBotService, productionTelegramBotDependencies } from "./service";
import { TelegramBotStore } from "./store";
import { FakeBotTransport, fakeBotToken, ok, refused, unreachable } from "./fakeTransport";
import type { TelegramPublishReceipt } from "@/lib/externalRelay/publish";

test("confirmed parts publish immediately with Telegram ids; pending or failed publication never fails the send", async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "telegram-publish-"));
  const store = new TelegramBotStore(path.join(root, "bot.sqlite"));
  const transport = new FakeBotTransport();
  const receipts: TelegramPublishReceipt[] = [];
  let token: string | null = null;
  let connectedBot = "123";
  let mode = "pending";
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const service = new TelegramBotService({ ...productionTelegramBotDependencies(), openStore: () => store,
    removeStoreFiles: () => {}, transportFor: () => transport, saveToken: value => { token = value; }, removeToken: () => { token = null; },
    withStoredToken: consume => token ? consume(token, connectedBot) : null,
    signInHook: ({ text }) => text?.startsWith("/start") ? "Sign-in confirmed" : null,
    publishMessage: receipt => {
      receipts.push(receipt);
      if (mode === "pending") return pending;
      if (mode === "reject") return Promise.reject(Error("fixture"));
      throw Error("fixture");
    } });
  try {
    transport.script("getMe", ok({ id: 123, is_bot: true, first_name: "Fixture" }));
    await service.connect(fakeBotToken()); await service.stopPoller();
    transport.script("getUpdates", ok([{ update_id: 1, message: { message_id: 1, date: 1,
      text: "Start", chat: { id: 41, type: "private", first_name: "Owner" } } }]));
    await service.pollOnce(new AbortController().signal); service.setChat("41", "owner", true);
    transport.script("sendMessage", ok({ message_id: 17, date: 1791724800, chat: { id: 77 }, text: "A & B" }));
    const input = { conversationId: null, clientRequestId: "first", chat: "owner", text: "<b>A &amp; B</b>", format: "html", topicId: 7 };
    expect(await service.send(input)).toMatchObject({ alreadySent: false });
    expect(receipts).toEqual([{ botId: "123", chatId: "77", messageId: 17, date: 1791724800, topicId: 7, text: "A & B" }]);
    expect(await service.send(input)).toMatchObject({ alreadySent: true }); expect(receipts).toHaveLength(1);
    release(); mode = "reject";
    let testCalls = 0;
    const lastPostBefore = service.status().chats[0]!.lastPostAt;
    transport.handlers.sendMessage = () => {
      connectedBot = "456";
      return testCalls++ === 0 ? refused(400, "fixture migration", { migrateToChatId: "77" })
        : ok({ message_id: 21, date: 1791724800 });
    };
    await service.testPost("owner", "Connection confirmed");
    expect(receipts.at(-1)).toEqual({ botId: "123", chatId: "77", messageId: 21, date: 1791724800, topicId: null, text: "Connection confirmed" });
    expect(service.status().chats[0]!.lastPostAt).toBe(lastPostBefore);
    connectedBot = "123"; delete transport.handlers.sendMessage;
    transport.handlers.getUpdates = () => {
      connectedBot = "456";
      return ok([{ update_id: 2, message: { message_id: 2, date: 1791724800,
        text: "/start fixture", chat: { id: 77, type: "private", first_name: "Owner" } } }]);
    };
    transport.script("sendMessage", ok({ message_id: 22, date: 1791724800 }));
    await service.pollOnce(new AbortController().signal);
    expect(receipts.at(-1)).toEqual({ botId: "123", chatId: "77", messageId: 22, date: 1791724800, topicId: null, text: "Sign-in confirmed" });
    connectedBot = "123";
    transport.script("sendMessage", ok({ message_id: 18, date: 1791724800 }), refused(400, "fixture"));
    await expect(service.send({ ...input, clientRequestId: "parts", text: "A".repeat(4200), format: "plain" })).rejects.toMatchObject({ code: "send_partial" });
    expect(receipts.at(-1)?.messageId).toBe(18);
    mode = "throw";
    transport.script("sendRichMessage", ok({ message_id: 19, date: 1791724800 }));
    expect(await service.sendRichMessage({ clientRequestId: "rich", chat: "owner",
      message: { markdown: "**Review**", plainText: "Review", images: [] } })).toMatchObject({ alreadySent: false });
    expect(receipts.at(-1)?.text).toBe("Review");
    transport.handlers.sendMessage = () => {
      connectedBot = "456";
      return ok({ message_id: 20, date: 1791724800 });
    };
    expect(await service.send({ ...input, clientRequestId: "identity" })).toMatchObject({ alreadySent: false });
    expect(receipts.at(-1)?.botId).toBe("123");
    connectedBot = "123";
    delete transport.handlers.sendMessage;
    const fallback = "Fallback question?\n1) Small\n2) Large";
    transport.script("sendRichMessage", refused(400, "photo rejected"), ok({ message_id: 25, date: 1791724800 }));
    await service.sendRichMessage({ clientRequestId: "fallback", chat: "owner", message: {
      markdown: "Original media question", plainText: "Original wording must not survive fallback", images: [{ id: "image", blob: new Blob(["fixture"]) }] },
      fallbackMarkdown: fallback });
    expect(receipts.at(-1)?.text).toBe(fallback);
    const journal = await scopedOutbound(store.filename, "123", "77", null, 1791724800);
    expect(journal.find(m => m.messageId === 25)?.text).toBe(fallback);
    expect(journal.find(m => m.messageId === 21)?.origin).toBe("operator");
    expect(journal.find(m => m.messageId === 22)?.origin).toBe("system");
    const db = new Database(store.filename);
    db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON relay_outbound WHEN new.message_id=28 BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END"); db.close();
    transport.script("sendMessage", ok({ message_id: 28, date: 1791724800 }));
    const custodyFailure = { ...input, clientRequestId: "custody-refusal" };
    await expect(service.send(custodyFailure)).rejects.toMatchObject({ code: "send_uncertain" });
    const sentCalls = transport.callsOf("sendMessage").length;
    await expect(service.send(custodyFailure)).rejects.toMatchObject({ code: "send_uncertain" });
    expect(transport.callsOf("sendMessage")).toHaveLength(sentCalls);
    const count = receipts.length;
    transport.script("sendMessage", unreachable());
    await expect(service.send({ ...input, clientRequestId: "uncertain" })).rejects.toMatchObject({ code: "send_uncertain" });
    expect(receipts).toHaveLength(count);
  } finally { release(); await service.remove(); fs.rmSync(root, { recursive: true, force: true }); }
});

test.each(["text", "photo", "album", "document"] as const)("%s metadata lookup refusal keeps the original send key retryable", async kind => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "telegram-metadata-"));
  const home = path.join(root, "home");
  const handoff = path.join(home, "handoff");
  fs.mkdirSync(handoff, { recursive: true });
  const image = path.join(handoff, "sample.png");
  await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toFile(image);
  const document = path.join(handoff, "sample.txt");
  fs.writeFileSync(document, "Fixture report.");
  const filename = path.join(root, "bot.sqlite");
  let store = new TelegramBotStore(filename);
  const peer = new Database(filename);
  let contend = true;
  let advanced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const transport = new FakeBotTransport();
  let available = false;
  const createService = () => new TelegramBotService({ ...productionTelegramBotDependencies(),
    openStore: () => store, transportFor: () => transport, removeStoreFiles: () => {},
    saveToken: () => {}, removeToken: () => {},
    withStoredToken: consume => consume(fakeBotToken(), "42"), now: () => new Date(1791724800000),
    documentEnvironment: () => ({ home, stateDir: path.join(root, "state") }),
    publicationTarget: () => {
      if (available) return null;
      if (contend) {
        contend = false;
        peer.exec("BEGIN IMMEDIATE");
        timer = setTimeout(() => { advanced = true; peer.exec("ROLLBACK"); }, 20);
      }
      throw Error("fixture metadata unavailable");
    },
    publishMessage: () => "skipped",
  });
  let service = createService();
  const method = kind === "text" ? "sendMessage" : kind === "photo" ? "sendPhoto" : kind === "album" ? "sendMediaGroup" : "sendDocument";
  const send = (clientRequestId = "original") => {
    const input = { conversationId: "conversation_fixture", clientRequestId, chat: "fixture" };
    return kind === "text" ? service.send({ ...input, text: "Which sample?\n1) Small\n2) Large" })
      : kind === "document" ? service.sendDocument({ ...input, document: { path: document, caption: "Report" } })
      : service.sendMedia({ ...input, images: Array.from({ length: kind === "album" ? 2 : 1 }, () => ({ path: image, caption: "Sample" })) });
  };
  try {
    store.recordLookedUpChat({ id: 41, type: "private", first_name: "Fixture" }, null, new Date(1791724800000));
    store.setChatSettings("41", { alias: "fixture", postAllowed: true });
    await expect(send()).rejects.toThrow("fixture metadata unavailable");
    expect(advanced).toBe(true);
    expect(transport.callsOf(method)).toHaveLength(0);
    await service.stopPublications(); store.close();
    store = new TelegramBotStore(filename); service = createService(); available = true;
    const receipt = { message_id: 18, date: 1791724800 };
    transport.script(method, ok(kind === "album" ? [receipt, { ...receipt, message_id: 19 }] : receipt));
    expect(await send()).toMatchObject({ alreadySent: false, messageIds: kind === "album" ? [18, 19] : [18] });
    available = false;
    expect(await send()).toMatchObject({ alreadySent: true });
    expect(transport.callsOf(method)).toHaveLength(1);
    available = true;
    for (const failure of ["network_failed", "timed_out"] as const) {
      transport.script(method, unreachable(failure));
      await expect(send(failure)).rejects.toMatchObject({ code: "send_uncertain" });
      const calls = transport.callsOf(method).length;
      await expect(send(failure)).rejects.toMatchObject({ code: "send_uncertain" });
      expect(transport.callsOf(method)).toHaveLength(calls);
    }
  } finally {
    clearTimeout(timer); if (peer.inTransaction) peer.exec("ROLLBACK"); peer.close();
    await service.stopPublications(); store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
