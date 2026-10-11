import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
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
    const count = receipts.length;
    transport.script("sendMessage", unreachable());
    await expect(service.send({ ...input, clientRequestId: "uncertain" })).rejects.toMatchObject({ code: "send_uncertain" });
    expect(receipts).toHaveLength(count);
  } finally { release(); await service.remove(); fs.rmSync(root, { recursive: true, force: true }); }
});
