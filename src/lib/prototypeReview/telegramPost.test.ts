import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { updateRelayStore } from "@/lib/externalRelay/store";
import { destinationRelay } from "@/lib/externalRelay/ownerDestination.fixture";
import * as bot from "@/lib/telegram/bot/service";
import { TelegramBotStore } from "@/lib/telegram/bot/store";
import { FakeBotTransport, fakeBotToken, ok, refused, unreachable } from "@/lib/telegram/bot/fakeTransport";
import { createBotApiTransport } from "@/lib/telegram/bot/transport";
import { publishPOST } from "./http";
import { NextRequest } from "next/server";
import { saveTasks } from "@/lib/tasks/store";
import { roundDirectory, storedMediaPath, prototypeRoot } from "./store";
import { telegramRound, telegramTask } from "./telegram.fixture";
import { prototypeSlides, renderPrototypeTelegram, postPrototypeReviewToTelegram } from "./telegramPost";

const roots: string[] = [];
const restores: Array<() => void> = [];
const services: bot.TelegramBotService[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const service of services.splice(0)) await service.remove();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function connected() {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "rich-post-")); roots.push(root);
  const store = new TelegramBotStore(path.join(root, "bot.sqlite"));
  const transport = new FakeBotTransport();
  let token: string | null = null;
  const service = new bot.TelegramBotService({ ...bot.productionTelegramBotDependencies(), openStore: () => store,
    removeStoreFiles: () => {}, transportFor: () => transport, saveToken: t => { token = t; }, removeToken: () => { token = null; },
    withStoredToken: consume => token ? consume(token, "42") : null });
  services.push(service);
  transport.script("getMe", ok({ id: 42, is_bot: true, first_name: "Fixture" }));
  await service.connect(fakeBotToken()); await service.stopPoller();
  transport.script("getUpdates", ok([{ update_id: 1, message: { message_id: 1, date: 1, text: "Fixture", chat: { id: -42, type: "group", title: "Reports" } } }]));
  await service.pollOnce(new AbortController().signal);
  service.setChat("-42", "reports", true);
  const factory = spyOn(bot, "telegramBotService").mockReturnValue(service);
  restores.push(() => factory.mockRestore());
  return { service, transport, store };
}

test("rich rendering labels slides, recommendations and bounded copy buttons and escapes input", () => {
  const round = telegramRound(); round.title = 'Layout <tg-button type="url">';
  round.questions![0]!.options[1]!.label = "Second | option <script>";
  round.variants[0]!.description = "A complete description with all words preserved ".repeat(5).trim();
  const rendered = renderPrototypeTelegram(round, [
    { id: "v1f1", variantNumber: 1, caption: "1 · Compact", blob: new Blob() },
    { id: "v2f1", variantNumber: 2, caption: "2 · Spacious", blob: new Blob() },
    { id: "v1f2", variantNumber: 1, caption: "1 · Detail", blob: new Blob() },
  ], "Task");
  expect(rendered.markdown).toContain('<tg-slideshow>\n![](tg://photo?id=v1f1 "1 · Compact")');
  const carousels = [...rendered.markdown.matchAll(/<tg-slideshow>([\s\S]*?)<\/tg-slideshow>/g)].map(match => match[1]!);
  expect(carousels).toHaveLength(2);
  expect(carousels[0]).toContain("v1f2");
  expect(carousels[0]).not.toContain("v2f1");
  expect(carousels[1]).toContain("v2f1");
  expect(carousels[1]).not.toContain("v1f");
  expect(rendered.markdown).toContain(`**1 · Choice 1**\n\n${round.variants[0]!.description}`);
  expect(rendered.markdown).toContain('<p><b>Питання 1/3');
  expect(rendered.markdown).toContain("<br>a) ");
  expect(rendered.markdown).toContain(" ✅<br>b)");
  expect(rendered.markdown).not.toContain("|:--");
  expect(rendered.markdown).not.toContain("## Питання");
  expect(rendered.markdown).toContain("+ Інше — у коментарі");
  expect(rendered.markdown).toContain("Скопіювати рекомендовані");
  expect(rendered.markdown.match(/type="copy_text"/g)).toHaveLength(4);
  expect(rendered.markdown).toContain("1a 2a 3a");
  expect(rendered.markdown).not.toContain("<script>");
  expect(rendered.markdown).toContain("Second | option &lt;script&gt;");
  delete round.questions;
  expect(renderPrototypeTelegram(round, []).markdown).not.toContain("Скопіювати рекомендовані");
  round.variants = Array.from({ length: 9 }, (_, i) => ({ ...round.variants[0]!, number: i + 1 }));
  expect(renderPrototypeTelegram(round, []).markdown.match(/<tg-button-row/g)).toHaveLength(2);
});

test("stored media honors 50 slides, variant coverage, WebP, invalid dimensions and unavailable copies", async () => {
  const round = telegramRound();
  const directory = roundDirectory(round.id); await fs.mkdir(directory, { recursive: true }); roots.push(directory);
  const bytes = await sharp({ create: { width: 40, height: 40, channels: 3, background: "white" } }).webp().toBuffer();
  const image = { id: createHash("sha256").update(bytes).digest("hex"), mime: "image/webp" as const, bytes: bytes.length };
  await fs.writeFile(storedMediaPath(await fs.realpath(prototypeRoot()), round.id, image), bytes);
  for (const variant of round.variants) variant.frames = Array.from({ length: 25 }, (_, i) => ({ image, caption: `Frame ${i}` }));
  const slides = await prototypeSlides(round);
  expect(slides).toHaveLength(50);
  expect(slides.slice(0, 3).map(s => s.caption[0])).toEqual(["1", "2", "3"]);
  expect(slides[0]!.blob.type).toBe("image/webp");
  const wide = await sharp({ create: { width: 100, height: 1, channels: 3, background: "white" } }).png().toBuffer();
  const invalid = { id: createHash("sha256").update(wide).digest("hex"), mime: "image/png" as const, bytes: wide.length };
  await fs.writeFile(storedMediaPath(await fs.realpath(prototypeRoot()), round.id, invalid), wide);
  round.variants[0]!.frames.unshift({ image: invalid, caption: "Invalid" });
  expect((await prototypeSlides(round))[0]!.id).toBe("v1f2");
  round.mediaRemovedAt = round.createdAt; expect(await prototypeSlides(round)).toEqual([]);
});

test("one rich send per round, multipart photo objects, topic, receipt and replay", async () => {
  const { service, transport, store } = await connected();
  const round = telegramRound();
  const message = renderPrototypeTelegram(round, [{ id: "v1f1", variantNumber: 1, caption: "1 · Compact", blob: new Blob(["frame"], { type: "image/webp" }) }]);
  transport.script("sendRichMessage", ok({ message_id: 10, date: 1 }));
  const input = { chat: "reports", topicId: 7, clientRequestId: round.id, message };
  expect(await service.sendRichMessage(input)).toMatchObject({ alreadySent: false, messageIds: [10], parts: 1 });
  expect(await service.sendRichMessage(input)).toMatchObject({ alreadySent: true, messageIds: [10] });
  expect(transport.callsOf("sendRichMessage")).toHaveLength(1);
  expect(transport.callsOf("sendRichMessage")[0]!.params).toMatchObject({ message_thread_id: 7, rich_message: {
    media: [{ id: "v1f1", media: { type: "photo", media: "attach://v1f1" } }] } });
  expect(store.sendRow("prototype-review", round.id)?.state).toBe("sent");
  const upload = createBotApiTransport(fakeBotToken(), async (_url, init) => {
    const form = init.body as FormData;
    expect((form.get("v1f1") as File).name).toBe("v1f1.webp");
    expect(JSON.parse(form.get("rich_message") as string).media[0].media.type).toBe("photo");
    return Response.json({ ok: true, result: { message_id: 11, date: 1 } });
  });
  expect((await upload.call("sendRichMessage", transport.callsOf("sendRichMessage")[0]!.params)).ok).toBe(true);
});

test("only definite media errors resend without slides; uncertain sends and malformed receipts retain their claim", async () => {
  const { service, transport, store } = await connected();
  const round = telegramRound();
  const input = { chat: "reports", clientRequestId: round.id, message: renderPrototypeTelegram(round,
    [{ id: "v1f1", variantNumber: 1, caption: "1 · Compact", blob: new Blob(["frame"]) }]), fallbackMarkdown: renderPrototypeTelegram(round, []).markdown };
  transport.script("sendRichMessage", refused(400, "invalid photo dimensions"), ok({ message_id: 10, date: 1 }));
  await service.sendRichMessage(input);
  expect(transport.callsOf("sendRichMessage")).toHaveLength(2);
  expect(transport.callsOf("sendRichMessage")[1]!.params.rich_message).toEqual({ markdown: input.fallbackMarkdown });
  for (const [i, result] of [unreachable("timed_out"), unreachable(), ok({})].entries()) {
    const key = `uncertain-${i}`;
    transport.script("sendRichMessage", result);
    await expect(service.sendRichMessage({ ...input, clientRequestId: key })).rejects.toMatchObject({ code: "send_uncertain" });
    await expect(service.sendRichMessage({ ...input, clientRequestId: key })).rejects.toMatchObject({ code: "send_uncertain" });
    expect(store.sendRow("prototype-review", key)?.state).toBe("pending");
  }
  expect(transport.callsOf("sendRichMessage")).toHaveLength(5);
});

test("publication posts to the paired owner's private chat once and an unpaired install posts nothing", async () => {
  const { transport } = await connected();
  updateRelayStore(s => ({ ...s, relays: [destinationRelay()] }));
  transport.handlers.getChat = () => ok({ id: 41, type: "private", first_name: "Owner" });
  saveTasks([telegramTask([])]);
  transport.script("sendRichMessage", ok({ message_id: 10, date: 1 }));
  const publish = (key = "publication") => publishPOST(new NextRequest("http://localhost/api/prototype-reviews", { method: "POST", headers: { host: "localhost" },
    body: JSON.stringify({ clientRequestId: key, taskId: "task-prototype", title: "Review", questions: telegramRound().questions }) }));
  expect((await publish()).status).toBe(200);
  for (let n = 0; n < 100 && !transport.callsOf("sendRichMessage").length; n++) await Bun.sleep(10);
  expect((await publish()).status).toBe(200);
  await Bun.sleep(30);
  expect(transport.callsOf("sendRichMessage")).toHaveLength(1);
  expect(transport.callsOf("sendRichMessage")[0]!.params.chat_id).toBe(41);
  transport.script("sendRichMessage", ok({ message_id: 11, date: 2 }));
  expect((await publish("next-publication")).status).toBe(200);
  for (let n = 0; n < 100 && transport.callsOf("sendRichMessage").length < 2; n++) await Bun.sleep(10);
  expect((await publish("next-publication")).status).toBe(200);
  await Bun.sleep(30);
  expect(transport.callsOf("sendRichMessage")).toHaveLength(2);
  updateRelayStore(s => ({ ...s, relays: [] }));
  await postPrototypeReviewToTelegram(telegramRound("no-destination"));
  expect(transport.callsOf("sendRichMessage")).toHaveLength(2);
});

test("owner review sends nothing with no target, a paused relay or a changed destination during lookup", async () => {
  const { service, transport, store } = await connected();
  const input = { clientRequestId: "owner-review", message: renderPrototypeTelegram(telegramRound(), []) };
  for (const relay of [destinationRelay([]), { ...destinationRelay(), paused: true }]) {
    updateRelayStore(s => ({ ...s, relays: [relay] }));
    expect(await service.sendOwnerReview(input)).toBeNull();
  }
  expect(transport.callsOf("getChat")).toHaveLength(0);
  updateRelayStore(s => ({ ...s, relays: [destinationRelay()] }));
  transport.handlers.getChat = () => {
    updateRelayStore(s => ({ ...s, relays: [{ ...destinationRelay(), paused: true }] }));
    return ok({ id: 41, type: "private", first_name: "Owner" });
  };
  await expect(service.sendOwnerReview(input)).rejects.toMatchObject({ code: "chat_not_allowed" });
  expect(transport.callsOf("sendRichMessage")).toHaveLength(0);
  expect(store.chat("41")).toBeNull();
  updateRelayStore(s => ({ ...s, relays: [destinationRelay()] }));
  transport.handlers.getChat = () => ok({ id: 77, type: "private" });
  await expect(service.sendOwnerReview(input)).rejects.toMatchObject({ code: "chat_not_allowed" });
  expect(transport.callsOf("sendRichMessage")).toHaveLength(0);
});

test("rich sends follow chat migrations within the same journal claim", async () => {
  const { service, transport, store } = await connected();
  transport.script("sendRichMessage", refused(400, "migrated", { migrateToChatId: "-43" }), ok({ message_id: 10, date: 1 }));
  await service.sendRichMessage({ chat: "reports", clientRequestId: "migration", message: renderPrototypeTelegram(telegramRound(), []) });
  expect(transport.callsOf("sendRichMessage")[1]!.params.chat_id).toBe(-43);
  expect(store.sendRow("prototype-review", "migration")?.chatId).toBe("-43");
});
