import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { updateRelayStore } from "@/lib/externalRelay/store";
import { destinationRelay, destinationTarget } from "@/lib/externalRelay/ownerDestination.fixture";
import * as bot from "@/lib/telegram/bot/service";
import { TelegramBotStore } from "@/lib/telegram/bot/store";
import { FakeBotTransport, fakeBotToken, ok, refused, unreachable } from "@/lib/telegram/bot/fakeTransport";
import { createBotApiTransport } from "@/lib/telegram/bot/transport";
import { publishPOST, resendTelegramPOST } from "./http";
import { NextRequest } from "next/server";
import { saveTasks, loadTasks } from "@/lib/tasks/store";
import { findPrototypeRound, roundDirectory, storedMediaPath, prototypeRoot } from "./store";
import { clearSeatRoundsForTests, loadSeatRounds } from "./seatRounds";
import { prototypeWorld, type PrototypeWorld } from "./world";
import { criticLane } from "./criticGate.fixture";
import { telegramRound, telegramTask } from "./telegram.fixture";
import { prototypeSlides, renderPrototypeTelegram, postPrototypeReviewToTelegram } from "./telegramPost";
import { telegramPostSignals } from "./telegramPostSignals";
import { readPrototypeReviews } from "./read";

const roots: string[] = [];
const restores: Array<() => void> = [];
const services: bot.TelegramBotService[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const service of services.splice(0)) { await service.waitForReviewPolls(); await service.remove(); }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function connected(publicationTarget?: bot.TelegramBotDependencies["publicationTarget"]) {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "rich-post-")); roots.push(root);
  const store = new TelegramBotStore(path.join(root, "bot.sqlite"));
  const transport = new FakeBotTransport();
  let token: string | null = null;
  const service = new bot.TelegramBotService({ ...bot.productionTelegramBotDependencies(), openStore: () => store,
    removeStoreFiles: () => {}, transportFor: () => transport, now: () => new Date("2026-10-11T13:00:00Z"), saveToken: t => { token = t; }, removeToken: () => { token = null; },
    withStoredToken: consume => token ? consume(token, "42") : null, publishMessage: () => {},
    ...(publicationTarget ? { publicationTarget } : {}) });
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

describe("pipeline and seat Telegram destinations", () => {
  const seat: PrototypeWorld = { ...prototypeWorld,
    caller: () => ({ conversationId: "conversation_seat", project: "project-a" }),
    stage: () => null, orchestrator: () => "conversation_seat" };
  const stage: PrototypeWorld = { ...seat,
    caller: () => ({ conversationId: "conversation_stage", project: "project-a" }),
    stage: () => ({ taskIds: ["task-prototype"], project: "project-a",
      source: { conversationId: "conversation_stage", pipelineId: "prototype-lane", stageId: "publish", attempt: 1 } }),
    pipeline: () => criticLane() };
  const request = (body: unknown) => new NextRequest("http://localhost/api/prototype-reviews", {
    method: "POST", headers: { host: "localhost" }, body: JSON.stringify(body) });
  const form = (key: string) => ({ clientRequestId: key, title: "Review", questions: telegramRound().questions });
  const pairing = () => destinationRelay([
    { ...destinationTarget("hosted"), answered_by: "service" },
    destinationTarget("owner", true),
    { ...destinationTarget("unconfigured"), answered_by: "service", engine: null, model: null },
  ]);
  beforeEach(() => {
    setSystemTime(new Date("2026-10-20T11:00:00Z"));
    saveTasks([telegramTask([])]);
    clearSeatRoundsForTests();
    updateRelayStore(s => ({ ...s, relays: [pairing()] }));
  });
  afterEach(() => { setSystemTime(); });
  async function sender() {
    const fixture = await connected();
    fixture.transport.handlers.getChat = () => ok({ id: 41, type: "private", first_name: "Owner" });
    let messageId = 10;
    fixture.transport.handlers.sendRichMessage = () => ok({ message_id: messageId++, date: 1 });
    fixture.transport.handlers.sendPoll = () => ok({ message_id: messageId++, date: 1 });
    return fixture;
  }
  async function publish(world: PrototypeWorld, input: ReturnType<typeof form> & Record<string, unknown>) {
    const response = await publishPOST(request(input), world);
    expect(response.status).toBe(200);
    const { taskId, reviewId } = await response.json();
    return findPrototypeRound(taskId, reviewId)!;
  }
  test("a stage carousel and seat forms with and without a task reach the same owner", async () => {
    const { service, transport } = await sender();
    const root = await fs.mkdtemp(path.join(process.env.HOME!, "stage-review-")); roots.push(root);
    const image = path.join(root, "frame.png");
    await sharp({ create: { width: 40, height: 40, channels: 3, background: "white" } }).png().toFile(image);
    const round = await publish(stage, { ...form("stage-carousel"), variants: [{ number: 1, name: "Compact",
      description: "Keeps controls together.", frames: [{ path: image, caption: "Layout" }] }] });
    expect(round.source).toEqual({ conversationId: "conversation_stage", pipelineId: "prototype-lane", stageId: "publish", attempt: 1 });
    expect(round.telegramPost?.state).toBe("sent");
    expect((await publish(seat, form("seat-form"))).telegramPost?.state).toBe("sent");
    expect((await publish(seat, { ...form("seat-task-form"), taskId: "task-prototype" })).telegramPost?.state).toBe("sent");
    await service.waitForReviewPolls();
    expect(transport.callsOf("sendRichMessage").map(call => call.params.chat_id)).toEqual([41, 41, 41]);
    expect((transport.callsOf("sendRichMessage")[0]!.params.rich_message as { media: unknown[] }).media).toHaveLength(1);
  });
  test("stage and seat resend a stage review after its target returns, with replay sending once", async () => {
    const { service, transport } = await sender();
    updateRelayStore(s => ({ ...s, relays: [destinationRelay([])] }));
    const round = await publish(stage, form("initially-no-target"));
    expect(round.telegramPost).toMatchObject({ state: "failed", reason: "no_target" });
    updateRelayStore(s => ({ ...s, relays: [pairing()] }));
    for (const [caller, world] of [["stage", stage], ["seat", seat]] as const) {
      const body = { reviewId: round.id, clientRequestId: `resend-${caller}` };
      for (let replay = 0; replay < 2; replay++) {
        const response = await resendTelegramPOST(request(body), world);
        expect(response.status).toBe(200);
        expect((await response.json()).telegramPost).toMatchObject({ state: "sent" });
      }
      await service.waitForReviewPolls();
    }
    expect(transport.callsOf("sendRichMessage").map(call => call.params.chat_id)).toEqual([41, 41]);
  });
  test.each(["no_relay", "paused", "no_target", "not_configured", "invalid_owner"] as const)(
    "destination configuration %s stays out of wake signals across publications and fresh-key resends", async reason => {
      const { service, transport } = await sender();
      const relay = destinationRelay();
      if (reason === "paused") relay.paused = true;
      if (reason === "no_target") relay.targets = [];
      if (reason === "not_configured") relay.targets = [{ ...destinationTarget("unconfigured"), engine: null, model: null }];
      if (reason === "invalid_owner") relay.owner.id = "0";
      updateRelayStore(s => ({ ...s, relays: reason === "no_relay" ? [] : [relay] }));
      const rounds = [
        await publish(stage, form(`missing-${reason}-stage`)),
        await publish(seat, form(`missing-${reason}-seat`)),
        await publish(seat, { ...form(`missing-${reason}-task`), taskId: "task-prototype" }),
      ];
      const signals = () => telegramPostSignals("project-a", loadTasks(), loadSeatRounds("project-a"));
      for (const round of rounds) expect(round.telegramPost).toMatchObject({ state: "failed", reason });
      expect(signals()).toEqual([]);
      for (const round of rounds) {
        for (const [caller, world] of [["stage", stage], ["seat", seat]] as const) {
          const clientRequestId = `still-missing-${reason}-${caller}`;
          const response = await resendTelegramPOST(request({ reviewId: round.id, clientRequestId }), world);
          expect(response.status).toBe(200);
          expect((await response.json()).telegramPost).toMatchObject({ state: "failed", reason, key: `${round.id}:resend:${clientRequestId}` });
          expect(findPrototypeRound(round.taskId, round.id)!.questions).toEqual(round.questions);
          expect(signals()).toEqual([]);
        }
      }
      expect(transport.callsOf("getChat")).toHaveLength(0);
      expect(transport.callsOf("sendRichMessage")).toHaveLength(0);
      updateRelayStore(s => ({ ...s, relays: [pairing()] }));
      const response = await resendTelegramPOST(request({ reviewId: rounds[0]!.id, clientRequestId: `configured-${reason}` }), seat);
      expect(response.status).toBe(200);
      expect((await response.json()).telegramPost.state).toBe("sent");
      await service.waitForReviewPolls();
      expect(transport.callsOf("sendRichMessage")).toHaveLength(1);
      expect(signals()).toEqual([]);
    });
  test.each(["forbidden", "send_uncertain", "unavailable", "destination_unavailable", "future_reason", "constructor", "__proto__", undefined])(
    "delivery failure %s keeps its task and seat wake signals", reason => {
      const taskRound = telegramRound("delivery-task");
      const seatRound = { ...telegramRound("delivery-seat"), taskId: null };
      taskRound.telegramPost = { key: "task-send", state: "failed", at: "2026-10-20T11:00:00.000Z", reason };
      seatRound.telegramPost = { key: "seat-send", state: "uncertain", at: "2026-10-20T11:00:00.000Z", reason };
      const signals = telegramPostSignals("project-a", [telegramTask([taskRound])], [seatRound]);
      expect(signals).toHaveLength(2);
      expect(signals.map(signal => signal.id)).toEqual([
        `prototype-telegram:${taskRound.id}:task-send`, `prototype-telegram:${seatRound.id}:seat-send`,
      ]);
      for (const signal of signals) {
        expect(signal.actionable).toBe(true);
        expect(signal.label).toContain("resend_prototype_review_telegram");
      }
      expect(telegramPostSignals("project-b", [telegramTask([taskRound])], [seatRound])).toEqual([]);
    });
  test("genuinely missing, disabled or service-only targets report no_target for both callers and resend", async () => {
    const { transport } = await sender();
    const targets = [[], [{ ...destinationTarget("disabled"), enabled: false }],
      [{ ...destinationTarget("hosted"), answered_by: "service" as const }],
      [{ ...destinationTarget("disabled-owner"), enabled: false }, { ...destinationTarget("hosted"), answered_by: "service" as const }]];
    const details = ["no_destination", "destination_disabled", "service_only", "not_answered_by_owner"] as const;
    for (const [index, absent] of targets.entries()) {
      updateRelayStore(s => ({ ...s, relays: [destinationRelay(absent)] }));
      for (const [caller, world] of [["stage", stage], ["seat", seat]] as const) {
        const round = await publish(world, form(`no-target-${index}-${caller}`));
        const expected = { state: "failed", reason: "no_target", destinationDetail: details[index] } as const;
        expect(round.telegramPost).toEqual({ ...expected, key: round.id, at: "2026-10-20T11:00:00.000Z" });
        const response = await resendTelegramPOST(request({ reviewId: round.id, clientRequestId: `missing-${index}-${caller}` }), seat);
        expect(response.status).toBe(200);
        expect((await response.json()).telegramPost).toEqual({ ...expected, key: `${round.id}:resend:missing-${index}-${caller}`, at: "2026-10-20T11:00:00.000Z" });
        expect(findPrototypeRound(round.taskId, round.id)!.telegramPost).toMatchObject(expected);
      }
    }
    expect(transport.callsOf("getChat")).toHaveLength(0);
    expect(transport.callsOf("sendRichMessage")).toHaveLength(0);
  });
  test("a refusal records the selection that refused even if the destination returns before recording", async () => {
    const { service, transport } = await sender();
    const send = service.sendOwnerReview.bind(service);
    const refusal = spyOn(service, "sendOwnerReview").mockImplementation(async (...args) => {
      const result = await send(...args);
      updateRelayStore(s => ({ ...s, relays: [pairing()] }));
      return result;
    });
    try {
      updateRelayStore(s => ({ ...s, relays: [destinationRelay([])] }));
      const round = await publish(stage, form("refusal-snapshot"));
      expect(round.telegramPost).toMatchObject({ state: "failed", reason: "no_target", destinationDetail: "no_destination" });
      const response = await resendTelegramPOST(request({ reviewId: round.id, clientRequestId: "recovered-snapshot" }), stage);
      expect((await response.json()).telegramPost).toMatchObject({ state: "sent" });
      expect(findPrototypeRound(round.taskId, round.id)!.telegramPost).not.toHaveProperty("destinationDetail");
      await service.waitForReviewPolls();
      expect(transport.callsOf("sendRichMessage")).toHaveLength(1);
    } finally { refusal.mockRestore(); }
  });
});

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
  expect(rendered.markdown).toContain("відповідь своїми словами");
  expect(rendered.plainText).toContain("Застереження теж збережуться");
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
  const read = spyOn(fs, "readFile");
  let slides;
  try {
    slides = await prototypeSlides(round);
    expect(read).toHaveBeenCalledTimes(50);
  } finally { read.mockRestore(); }
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

test("publication sends a schema-valid questionnaire when escaped Markdown exceeds Telegram's text limit", async () => {
  const { transport } = await connected();
  updateRelayStore(s => ({ ...s, relays: [destinationRelay()] }));
  transport.handlers.getChat = () => ok({ id: 41, type: "private", first_name: "Owner" });
  saveTasks([telegramTask([])]);
  transport.script("sendRichMessage", ok({ message_id: 12, date: 3 }));
  const questions = Array.from({ length: 7 }, (_, i) => ({
    id: `question-${i + 1}`,
    text: "<&".repeat(150),
    options: Array.from({ length: 6 }, (_, j) => ({ label: `${j}` + "<&".repeat(59), recommended: j === 0 })),
  }));
  const response = await publishPOST(new NextRequest("http://localhost/api/prototype-reviews", { method: "POST", headers: { host: "localhost" },
    body: JSON.stringify({ clientRequestId: "long-questionnaire", taskId: "task-prototype", title: "T".repeat(120), variants: [], questions }) }));
  expect(response.status).toBe(200);
  for (let n = 0; n < 100 && !transport.callsOf("sendRichMessage").length; n++) await Bun.sleep(10);
  const sends = transport.callsOf("sendRichMessage");
  expect(sends).toHaveLength(1);
  const rich = sends[0]!.params.rich_message as { markdown: string };
  expect(rich.markdown.length).toBeGreaterThan(32768);
  for (let i = 1; i <= 7; i++) expect(rich.markdown).toContain(`Питання ${i}/7`);
  expect(rich.markdown).toContain("&lt;&amp;".repeat(150));
  expect(rich.markdown).toContain("a) 0&lt;&amp;&lt;&amp;");
  expect(rich.markdown).toContain("Скопіювати рекомендовані");
  expect(rich.markdown).toContain("type=\"copy_text\"");
});

test("owner review sends nothing with no target, a paused relay or a changed destination during lookup", async () => {
  const { service, transport, store } = await connected();
  const input = { clientRequestId: "owner-review", message: renderPrototypeTelegram(telegramRound(), []) };
  for (const relay of [destinationRelay([]), { ...destinationRelay(), paused: true },
    destinationRelay([{ ...destinationRelay().targets[0]!, model: null }])]) {
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

test("a failed automatic post is durable and readable, including a missing destination", async () => {
  const { transport } = await connected();
  updateRelayStore(s => ({ ...s, relays: [destinationRelay()] }));
  transport.handlers.getChat = () => ok({ id: 41, type: "private" });
  const round = telegramRound("failed-post"); saveTasks([telegramTask([round])]);
  transport.script("sendRichMessage", refused(403, "Forbidden"));
  await postPrototypeReviewToTelegram(round);
  const stored = loadTasks()[0]!.prototypeReviews![0]!;
  expect(stored).toMatchObject({ telegramPost: { state: "failed", reason: "forbidden" } });
  expect(readPrototypeReviews(loadTasks()[0]!).rounds[0]).toMatchObject({ telegramPost: { state: "failed", reason: "forbidden" } });
  expect(telegramPostSignals("project-a", loadTasks(), [])).toMatchObject([{ actionable: true, label: expect.stringContaining("forbidden") }]);
  expect(telegramPostSignals("project-b", loadTasks(), [])).toEqual([]);
  updateRelayStore(s => ({ ...s, relays: [] }));
  const absent = telegramRound("absent-destination"); saveTasks([telegramTask([absent])]);
  await postPrototypeReviewToTelegram(absent);
  expect(loadTasks()[0]!.prototypeReviews![0]!).toMatchObject({ telegramPost: { state: "failed", reason: "no_relay" } });
});

test("a 238-frame nine-variant round survives a definite Telegram size refusal as a rich summary with a link", async () => {
  const { transport } = await connected();
  updateRelayStore(s => ({ ...s, relays: [destinationRelay()] }));
  transport.handlers.getChat = () => ok({ id: 41, type: "private" });
  const round = telegramRound("large-round");
  const directory = roundDirectory(round.id); await fs.mkdir(directory, { recursive: true }); roots.push(directory);
  const bytes = await sharp({ create: { width: 40, height: 40, channels: 3, background: "white" } }).png().toBuffer();
  const image = { id: createHash("sha256").update(bytes).digest("hex"), mime: "image/png" as const, bytes: bytes.length };
  await fs.writeFile(storedMediaPath(await fs.realpath(prototypeRoot()), round.id, image), bytes);
  round.variants = Array.from({ length: 9 }, (_, i) => ({ number: i + 1, name: `Choice ${i + 1}`, description: "A detailed layout. ".repeat(20),
    frames: Array.from({ length: i < 4 ? 27 : 26 }, (_, j) => ({ image, caption: `Frame ${j + 1}` })), videos: [] }));
  saveTasks([telegramTask([round])]);
  transport.script("sendRichMessage", refused(400, "Bad Request: rich message text is too long"), ok({ message_id: 20, date: 4 }));
  await postPrototypeReviewToTelegram(round);
  expect(transport.callsOf("sendRichMessage")).toHaveLength(2);
  const initial = transport.callsOf("sendRichMessage")[0]!.params.rich_message as { markdown: string; media: unknown[] };
  expect(initial.media).toHaveLength(50);
  expect(initial.markdown).toContain("Кадри: 50/238");
  const summary = transport.callsOf("sendRichMessage")[1]!.params.rich_message as { markdown: string; media: unknown[] };
  expect(summary.markdown.length).toBeLessThan(10000);
  expect(summary.markdown).toContain("http://localhost:");
  expect(summary.markdown).toContain("238");
  expect(summary.media).toHaveLength(9);
  expect(summary.markdown).toContain("Скопіювати рекомендовані");
  for (let n = 1; n <= 9; n++) expect(summary.markdown).toContain(`Варіант ${n}`);
  expect(loadTasks()[0]!.prototypeReviews![0]!).toMatchObject({ telegramPost: { state: "sent" } });
});

test("owner review admits new sends before transport and optional poll metadata cannot fail a confirmed form", async () => {
  let unavailable = true;
  const { service, transport, store } = await connected(() => {
    if (unavailable) throw Error("fixture metadata unavailable");
    return null;
  });
  updateRelayStore(s => ({ ...s, relays: [destinationRelay()] }));
  transport.handlers.getChat = () => ok({ id: 41, type: "private" });
  const round = telegramRound("poll-metadata"); saveTasks([telegramTask([round])]);
  const input = { clientRequestId: round.id, message: renderPrototypeTelegram(round, []) };
  await expect(service.sendOwnerReview(input)).rejects.toThrow("fixture metadata unavailable");
  expect(transport.callsOf("sendRichMessage")).toHaveLength(0);
  expect(store.sendRow("prototype-review", round.id)).toMatchObject({ state: "failed", messageIds: [] });
  unavailable = false;
  transport.handlers.sendRichMessage = () => {
    unavailable = true;
    return ok({ message_id: 21, date: 5 });
  };
  expect(await service.sendOwnerReview(input)).toMatchObject({ alreadySent: false, messageIds: [21] });
  expect(await service.sendOwnerReview(input)).toMatchObject({ alreadySent: true, messageIds: [21] });
  await service.waitForReviewPolls();
  expect(transport.callsOf("sendPoll")).toHaveLength(0);
  expect(transport.callsOf("sendRichMessage")).toHaveLength(1);
  expect(store.sendRow("prototype-review", round.id)?.state).toBe("sent");
});

test.each(["available", "refused"] as const)("a pending post after a lost completion replays its bot receipt with %s metadata; uncertain sends stay visible without another send", async metadata => {
  let unavailable = false;
  const { service, transport, store } = await connected(() => {
    if (unavailable) throw Error("fixture metadata unavailable");
    return null;
  });
  const { mutatePrototypeRound } = await import("./store");
  const { sweepPrototypeDeliveries } = await import("./deliveryWorker");
  updateRelayStore(s => ({ ...s, relays: [destinationRelay()] }));
  transport.handlers.getChat = () => ok({ id: 41, type: "private" });
  const round = telegramRound("lost-completion"); saveTasks([telegramTask([round])]);
  transport.script("sendRichMessage", ok({ message_id: 21, date: 5 }));
  await postPrototypeReviewToTelegram(round);
  await service.waitForReviewPolls();
  const pollCalls = transport.callsOf("sendPoll").length;
  const receipt = store.sendRow("prototype-review", round.id)!;
  unavailable = metadata === "refused";
  mutatePrototypeRound(round.taskId, round.id, held => { held.telegramPost!.state = "pending"; });
  await sweepPrototypeDeliveries();
  expect(loadTasks()[0]!.prototypeReviews![0]!.telegramPost?.state).toBe("sent");
  expect(await service.sendOwnerReview({ clientRequestId: round.id, message: renderPrototypeTelegram(round, []) }))
    .toMatchObject({ alreadySent: true, messageIds: [21], sentAt: receipt.sentAt });
  await service.waitForReviewPolls();
  expect(transport.callsOf("sendPoll")).toHaveLength(pollCalls);
  expect(store.sendRow("prototype-review", round.id)).toEqual(receipt);
  expect(transport.callsOf("sendRichMessage")).toHaveLength(1);
  updateRelayStore(s => ({ ...s, relays: [{ ...destinationRelay(), paused: true }] }));
  expect(await service.sendOwnerReview({ clientRequestId: round.id, message: renderPrototypeTelegram(round, []) })).toBeNull();
  updateRelayStore(s => ({ ...s, relays: [destinationRelay()] }));
  unavailable = false;
  const uncertain = telegramRound("uncertain-post"); saveTasks([telegramTask([uncertain])]);
  transport.script("sendRichMessage", unreachable("timed_out"));
  await postPrototypeReviewToTelegram(uncertain); await postPrototypeReviewToTelegram(uncertain);
  expect(transport.callsOf("sendRichMessage")).toHaveLength(2);
  expect(loadTasks()[0]!.prototypeReviews![0]!.telegramPost).toMatchObject({ state: "uncertain", reason: "send_uncertain" });
});

test("media and size refusals in either order reach a text summary without dangling photo references", async () => {
  const { service, transport, store } = await connected();
  const { renderPrototypeTelegramSummary } = await import("./telegramPost");
  const round = telegramRound();
  const slides = [{ id: "v1f1", variantNumber: 1, caption: "Preview", blob: new Blob(["frame"]) }];
  const mediaError = refused(400, "Bad Request: invalid photo dimensions");
  const sizeError = refused(400, "Bad Request: rich message text is too long");
  for (const [index, refusals] of [[mediaError, sizeError], [sizeError, mediaError]].entries()) {
    transport.script("sendRichMessage", ...refusals, ok({ message_id: 30 + index, date: 6 }));
    const key = `combined-refusals-${index}`;
    await service.sendRichMessage({ chat: "reports", topicId: 7, clientRequestId: key,
      message: renderPrototypeTelegram(round, slides), fallbackMarkdown: renderPrototypeTelegram(round, []).markdown,
      limitFallback: renderPrototypeTelegramSummary(round, slides) });
    const final = transport.callsOf("sendRichMessage").at(-1)!.params;
    expect(final.message_thread_id).toBe(7);
    expect(final.rich_message).not.toHaveProperty("media");
    expect((final.rich_message as { markdown: string }).markdown).not.toContain("tg://photo");
    expect((final.rich_message as { markdown: string }).markdown).toContain("Повне рев’ю у Delegatus");
    expect(store.sendRow("prototype-review", key)?.state).toBe("sent");
  }
  expect(transport.callsOf("sendRichMessage")).toHaveLength(6);
});
