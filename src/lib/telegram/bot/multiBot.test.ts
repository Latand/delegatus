import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-multi-bot-"));
const previous = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(root, "state");
const { TelegramBotService, TelegramBotError, productionTelegramBotDependencies } = await import("./service");
const { FakeBotTransport, fakeBotToken, ok, refused, unreachable } = await import("./fakeTransport");
const { outboundState } = await import("./outbound");
const { sendFailure } = await import("./errors");
const { telegramBotFailure } = await import("./http");

const ids = ["4242424", "5151515"];
const names = ["Receiving bot", "Sending bot"];
const usernames = ["receiving_fixture_bot", "sending_fixture_bot"];
const group = { id: -1000000000101, type: "supergroup", title: "Reports", is_forum: true };
const privateChat = { id: 700000101, type: "private", first_name: "Owner" };
const t0 = Date.parse("2026-10-20T12:00:00Z");
let clock = t0;
let fakes: InstanceType<typeof FakeBotTransport>[];
let service: InstanceType<typeof TelegramBotService>;
let store: ReturnType<ReturnType<typeof productionTelegramBotDependencies>["openStore"]>;
function makeService(extra = new Map<string, InstanceType<typeof FakeBotTransport>>()) {
  return new TelegramBotService({ ...productionTelegramBotDependencies(),
    now: () => new Date(clock), conversationTitle: () => null,
    transportFor: token => {
      const index = ids.indexOf(token.split(":")[0]);
      const fake = index < 0 ? extra.get(token.split(":")[0]!) : fakes[index];
      if (!fake) throw new Error("unexpected test bot");
      return Object.freeze({ call: fake.call.bind(fake) });
    }, documentEnvironment: () => ({ home: root, stateDir: process.env.LLV_STATE_DIR! }),
  });
}
function sent(id = 101) { return ok({ message_id: id, date: Math.floor(clock / 1000) }); }
const send = (key: string, text = "Report") => service.send({ conversationId: "conversation_writer", clientRequestId: key, chat: "reports", text, topicId: 12 });
const sendTo = (key: string, topicId?: number) => service.send({ conversationId: "conversation_writer", clientRequestId: key, chat: "reports", text: "Report", ...(topicId === undefined ? {} : { topicId }) });
const count = (index: number) => fakes[index]!.callsOf("sendMessage").length;
async function failure(run: () => Promise<unknown>) {
  try { await run(); } catch (e) { if (e instanceof TelegramBotError) return e; throw e; }
  throw new Error("expected refusal");
}
beforeEach(async () => {
  clock = t0;
  fakes = ids.map((id, index) => {
    const fake = new FakeBotTransport();
    fake.handlers.getMe = () => ok({ id: Number(id), is_bot: true, first_name: names[index], username: usernames[index] });
    fake.handlers.getWebhookInfo = () => ok({ url: "https://example.invalid/other-reader" });
    fake.handlers.getChatMember = () => ok({ status: "administrator", can_manage_topics: true });
    fake.handlers.getChat = () => ok({ ...group, permissions: { can_send_messages: true, can_send_photos: true, can_send_documents: true } });
    return fake;
  });
  service = makeService();
  await service.connect(fakeBotToken(ids[0]));
  store = productionTelegramBotDependencies().openStore();
  store.recordLookedUpChat(group, "member", new Date(clock));
  service.setChat(String(group.id), "reports", true);
  await service.addBot(fakeBotToken(ids[1]));
  await service.refresh();
});
afterEach(async () => { store.close(); await service.remove(); });
afterAll(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

test("assigned bot delivers in the report topic and replays its persisted receipt", async () => {
  await service.assignBot(String(group.id), usernames[1]);
  fakes[1]!.script("sendMessage", sent());
  expect(await send("assigned")).toMatchObject({ sentBy: { name: names[1] }, messageIds: [101] });
  expect(count(0)).toBe(0);
  expect(count(1)).toBe(1);
  expect(fakes[1]!.callsOf("sendMessage")[0]!.params.message_thread_id).toBe(12);
  expect(store.sendRow("text:conversation_writer", "assigned")?.botId).toBe(ids[1]);
  expect((await send("assigned")).alreadySent).toBe(true);
  expect(count(1)).toBe(1);
});

test("kicked assigned bot commits refusal before the next bot delivers once", async () => {
  await service.assignBot(String(group.id), usernames[0]);
  fakes[0]!.script("sendMessage", refused(403, "Forbidden: bot was kicked from the supergroup chat"));
  fakes[0]!.handlers.getChatMember = () => ok({ status: "kicked" });
  fakes[1]!.handlers.sendMessage = () => {
    expect(store.sendRow("text:conversation_writer", "fallback")?.attempts.map(a => a.code)).toEqual(["forbidden"]);
    return sent(100 + count(1));
  };
  const answer = await send("fallback");
  expect(answer).toMatchObject({ sentBy: { name: names[1] }, refusals: [{ bot: { name: names[0] }, code: "forbidden" }] });
  expect([count(0), count(1)]).toEqual([1, 1]);
  expect((await send("fallback")).sentBy?.name).toBe(names[1]);
  expect([count(0), count(1)]).toEqual([1, 1]);
  await send("after-refusal");
  expect(count(0)).toBe(1);
  expect(service.listChats().chats[0]?.bots?.[0]).toMatchObject({ member: false, status: "kicked", canPost: false });
  expect(store.chat(String(group.id))?.botStatus).toBe("kicked");
});

test("refresh checks sending bot identities even when the receiving token is rejected", async () => {
  fakes[0]!.handlers.getMe = () => refused(401, "Unauthorized");
  fakes[1]!.handlers.getMe = () => refused(401, "Unauthorized");
  await service.refresh();
  expect(service.status().bots?.map(bot => bot.tokenState)).toEqual(["rejected", "rejected"]);
  fakes[1]!.handlers.getMe = () => ok({ id: Number(ids[1]), is_bot: true, first_name: names[1], username: usernames[1] });
  await service.refresh();
  expect(service.status().bots?.[1]?.tokenState).toBe("ok");
});

test("a rejected old token cannot mark its replacement rejected after membership I/O", async () => {
  await service.assignBot(String(group.id), usernames[1]);
  await outboundState(store.filename, true, db => { db.query("DELETE FROM chat_bots WHERE bot_id=?").run(ids[1]); });
  fakes[1]!.handlers.getChatMember = async () => {
    fakes[1]!.handlers.getChatMember = () => ok({ status: "administrator" });
    await service.addBot(fakeBotToken(ids[1]) + "x");
    return refused(401, "Unauthorized");
  };
  fakes[0]!.script("sendMessage", sent());
  expect((await send("replacement-token")).sentBy?.name).toBe(names[0]);
  expect(service.status().bots?.[1]?.tokenState).toBe("ok");
});

test("an old membership check cannot overwrite its replacement token's refreshed rights", async () => {
  await service.assignBot(String(group.id), usernames[1]);
  await outboundState(store.filename, true, db => { db.query("DELETE FROM chat_bots WHERE bot_id=?").run(ids[1]); });
  fakes[1]!.handlers.getChatMember = async () => {
    fakes[1]!.handlers.getChatMember = () => ok({ status: "administrator" });
    await service.addBot(fakeBotToken(ids[1]) + "x");
    return ok({ status: "kicked" });
  };
  fakes[0]!.script("sendMessage", sent());
  await send("replacement-membership");
  expect(service.status().bots?.[1]?.tokenState).toBe("ok");
  expect(service.status().chats[0]?.bots?.[1]).toMatchObject({ member: true, canPost: true });
});

test("add checks at most sixteen chats of the new bot; refresh advances sixty-four oldest pairs", async () => {
  await service.removeBot(usernames[1]);
  for (let i = 0; i < 40; i++) {
    const id = group.id - 10 - i;
    store.recordLookedUpChat({ ...group, id }, "member", new Date(clock));
    service.setChat(String(id), `reports-${i}`, true);
  }
  const before = fakes.map(fake => fake.callsOf("getChatMember").length);
  await service.addBot(fakeBotToken(ids[1]));
  expect(fakes[0]!.callsOf("getChatMember").length - before[0]!).toBe(0);
  expect(fakes[1]!.callsOf("getChatMember").length - before[1]!).toBe(16);
  const checks = () => fakes.reduce((sum, fake) => sum + fake.callsOf("getChatMember").length, 0);
  const count = checks();
  clock += 1000;
  await service.refresh();
  expect(checks() - count).toBe(64);
  clock += 1000;
  await service.refresh();
  const rows = await outboundState(store.filename, false, db => db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM chat_bots").get()!.count);
  expect(rows).toBe(82);
});

test("both refused: durable reasons, HTTP details and the panel retain the chat", async () => {
  fakes[0]!.script("sendMessage", refused(403, "Forbidden"));
  fakes[1]!.script("sendMessage", refused(400, "not enough rights to send text messages to the chat"));
  const error = await failure(() => send("both-refused"));
  expect(error.code).toBe("forbidden");
  expect(error.retryable).toBe(false);
  expect(error.extra.refusals?.map(r => r.code)).toEqual(["forbidden", "not_enough_rights"]);
  expect(await telegramBotFailure(error).json()).toMatchObject({ code: "forbidden", refusals: [{ code: "forbidden" }, { code: "not_enough_rights" }] });
  expect(store.sendRow("text:conversation_writer", "both-refused")).toMatchObject({ state: "failed", messageIds: [], attempts: [{ code: "forbidden" }, { code: "not_enough_rights" }] });
  expect(service.status().chats[0]?.lastDelivery).toMatchObject({ state: "refused", refusals: [{ bot: { name: names[0] } }, { bot: { name: names[1] } }] });
  expect(store.chat(String(group.id))?.storedMessages).toBe(0);
});

for (const kind of ["timed_out", "network_failed"] as const) {
  test(`${kind}: pending claim survives a real process restart and no other bot resends`, async () => {
    fakes[0]!.script("sendMessage", unreachable(kind));
    expect((await failure(() => send("ambiguous"))).code).toBe("send_uncertain");
    expect([count(0), count(1)]).toEqual([1, 0]);
    expect(store.sendRow("text:conversation_writer", "ambiguous")).toMatchObject({ state: "pending", botId: ids[0] });
    const child = Bun.spawn([process.execPath, "-e", `
      const {TelegramBotService,productionTelegramBotDependencies} = await import('./src/lib/telegram/bot/service');
      const {FakeBotTransport} = await import('./src/lib/telegram/bot/fakeTransport');
      const fake = new FakeBotTransport();
      const s = new TelegramBotService({...productionTelegramBotDependencies(),transportFor:()=>fake,conversationTitle:()=>null});
      try { await s.send({conversationId:'conversation_writer',clientRequestId:'ambiguous',chat:'reports',text:'Report'}); }
      catch(e) { process.stdout.write(JSON.stringify({code:e.code,calls:fake.calls.length})); }
    `], { cwd: process.cwd(), env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({ code: "send_uncertain", calls: 0 });
  });
}

test("membership positives expire at six hours; refusal refresh and negatives expire at ten minutes", async () => {
  fakes[0]!.handlers.sendMessage = () => sent(101 + count(0));
  fakes[1]!.handlers.sendMessage = () => sent(201 + count(1));
  const initial = fakes[0]!.callsOf("getChatMember").length;
  clock = t0 + 6 * 3600_000 - 1000;
  await send("warm");
  expect(fakes[0]!.callsOf("getChatMember").length).toBe(initial);
  clock += 2000;
  await send("expired");
  expect(fakes[0]!.callsOf("getChatMember").length).toBe(initial + 1);
  fakes[0]!.script("sendMessage", refused(403, "bot was kicked"));
  fakes[0]!.handlers.getChatMember = () => ok({ status: "kicked" });
  await service.assignBot(String(group.id), usernames[0]);
  await send("refreshed");
  const checked = fakes[0]!.callsOf("getChatMember").length;
  clock += 9 * 60_000;
  await send("negative-warm");
  expect(fakes[0]!.callsOf("getChatMember").length).toBe(checked);
  clock += 2 * 60_000;
  fakes[0]!.handlers.getChatMember = () => ok({ status: "administrator" });
  await send("negative-expired");
  expect(fakes[0]!.callsOf("getChatMember").length).toBe(checked + 1);
});

test("a closed topic refusal preserves chat-wide posting rights for other topics and the general chat", async () => {
  for (const fake of fakes) {
    fake.handlers.getChatMember = () => ok({ status: "member" });
    fake.handlers.getChat = () => ok({ ...group, permissions: { can_send_messages: true, can_send_photos: true, can_send_documents: true } });
    fake.handlers.sendMessage = params => params.message_thread_id === 12
      ? refused(400, "TOPIC_CLOSED")
      : sent(100 + fake.callsOf("sendMessage").length);
  }

  expect((await failure(() => sendTo("closed-topic", 12))).code).toBe("not_enough_rights");
  expect([count(0), count(1)]).toEqual([1, 1]);
  expect(service.listChats().chats[0]?.bots).toMatchObject([
    { member: true, canPost: true },
    { member: true, canPost: true },
  ]);

  expect((await sendTo("open-topic", 13)).sentBy?.name).toBe(names[0]);
  expect((await sendTo("general-chat")).sentBy?.name).toBe(names[0]);
  expect([count(0), count(1)]).toEqual([3, 1]);
});

test("a chat-wide rights refusal keeps its negative membership cache for ten minutes", async () => {
  for (const fake of fakes) {
    fake.handlers.getChatMember = () => ok({ status: "restricted", is_member: true, can_send_messages: false, can_send_photos: false, can_send_documents: false });
    fake.handlers.sendMessage = () => refused(400, "CHAT_WRITE_FORBIDDEN");
  }

  expect((await failure(() => sendTo("chat-wide-rights", 12))).code).toBe("not_enough_rights");
  const checked = fakes.map(fake => fake.callsOf("getChatMember").length);
  expect(service.listChats().chats[0]?.bots).toMatchObject([
    { member: true, canPost: false, reason: "not_enough_rights" },
    { member: true, canPost: false, reason: "not_enough_rights" },
  ]);
  clock += 9 * 60_000;
  expect((await failure(() => sendTo("chat-wide-warm", 13))).code).toBe("not_enough_rights");
  expect(fakes.map(fake => fake.callsOf("getChatMember").length)).toEqual(checked);

  clock += 2 * 60_000;
  fakes.forEach(fake => {
    fake.handlers.getChatMember = () => ok({ status: "administrator", can_manage_topics: true });
    fake.handlers.getChat = () => ok({ ...group, permissions: { can_send_messages: true, can_send_photos: true, can_send_documents: true } });
    fake.handlers.sendMessage = () => sent();
  });
  await sendTo("chat-wide-expired", 13);
  expect(fakes.map(fake => fake.callsOf("getChatMember").length)).toEqual([checked[0]! + 1, checked[1]!]);
});

test("an ambiguous getChat rights check preserves the cached fact and tries a known member first", async () => {
  const initial = service.listChats().chats[0]!.bots![0]!.checkedAt;
  clock += 6 * 3600_000 + 1000;
  fakes[0]!.handlers.getChatMember = () => ok({ status: "member" });
  fakes[0]!.handlers.getChat = () => unreachable("timed_out");
  fakes[1]!.script("sendMessage", sent());
  expect((await send("ambiguous-rights")).sentBy?.name).toBe(names[1]);
  expect(count(0)).toBe(0);
  expect(service.listChats().chats[0]!.bots![0]!.checkedAt).toBe(initial);
});

test("multipart text stays on the accepting bot and never falls back after a delivered part", async () => {
  fakes[0]!.script("sendMessage", sent(), refused(403, "Forbidden"));
  const error = await failure(() => send("partial", "x".repeat(5000)));
  expect(error.code).toBe("send_partial");
  expect(error.extra.sentMessageIds).toEqual([101]);
  expect(count(1)).toBe(0);
});

test("private rich review uses the receiving bot alone; sending bot removal preserves chats and receipts", async () => {
  store.recordLookedUpChat(privateChat, "member", new Date(clock));
  service.setChat(String(privateChat.id), "owner", true);
  fakes[0]!.script("sendRichMessage", refused(403, "Forbidden"));
  const error = await failure(() => service.sendRichMessage({ clientRequestId: "private", chat: "owner", message: { markdown: "Review", images: [] } }));
  expect(error.extra.refusals?.length).toBe(1);
  expect(fakes[1]!.callsOf("sendRichMessage")).toHaveLength(0);
  await service.assignBot(String(group.id), usernames[1]);
  fakes[1]!.script("sendMessage", sent());
  await send("retained");
  await service.removeBot(usernames[1]);
  expect(service.status().bots).toHaveLength(1);
  expect(service.status().chats.find(c => c.chatId === String(group.id))?.assignedBot).toBeNull();
  expect((await send("retained")).sentBy?.name).toBe(names[1]);
});

test("JSON and inspection expose neither token nor numeric bot id", () => {
  const visible = JSON.stringify(service.status()) + JSON.stringify(service.listChats()) + inspect(service, { depth: 10 });
  for (const id of ids) {
    expect(visible).not.toContain(fakeBotToken(id));
    expect(visible).not.toContain(id);
  }
});

test("all fresh negative memberships settle the claim without a send", async () => {
  fakes.forEach(f => { f.handlers.getChatMember = () => ok({ status: "kicked" }); });
  await service.refresh();
  const error = await failure(() => send("negative"));
  expect(error.extra.refusals?.map(r => r.source)).toEqual(["check", "check"]);
  expect([count(0), count(1)]).toEqual([0, 0]);
  expect(store.sendRow("text:conversation_writer", "negative")?.state).toBe("failed");
});

test("membership permission fields use each bot's own token and admin/channel/restricted rules", async () => {
  fakes[0]!.handlers.getChatMember = () => ok({ status: "member" });
  fakes[0]!.handlers.getChat = () => ok({ ...group, permissions: { can_send_messages: true, can_send_photos: false, can_send_documents: true, can_manage_topics: false } });
  fakes[1]!.handlers.getChatMember = () => ok({ status: "restricted", is_member: false, can_send_messages: true });
  await service.refresh();
  expect(service.listChats().chats[0]?.bots).toMatchObject([
    { member: true, canPost: true, canSendPhotos: false, canSendDocuments: true, canManageTopics: false },
    { member: false, canPost: false },
  ]);
  ids.forEach((id, index) => expect(fakes[index]!.callsOf("getChatMember").at(-1)?.params.user_id).toBe(Number(id)));
  store.recordLookedUpChat({ ...group, type: "channel" }, "administrator", new Date(clock));
  fakes[0]!.handlers.getChatMember = () => ok({ status: "administrator", can_post_messages: false });
  await service.refresh();
  expect(service.listChats().chats[0]?.bots?.[0]?.canPost).toBe(false);
});

for (const [status, description, code, fallback] of [
  [403, "unknown wording", "forbidden", true], [401, "Unauthorized", "token_rejected", true], [404, "Not found", "token_rejected", true],
  [400, "chat not found", "bot_not_in_chat", true], [400, "TOPIC_CLOSED", "not_enough_rights", true],
  [400, "CHAT_SEND_PHOTOS_FORBIDDEN", "not_enough_rights", true],
  [400, "cannot parse entities", "format_invalid", false], [400, "unknown wording", "bad_request", false],
  [429, "Too many requests", "rate_limited", false], [500, "server failed", "telegram_failed", false],
] as const) {
  test(`explicit refusal ${status}/${code} fallback=${fallback}`, async () => {
    const result = refused(status, description);
    expect(sendFailure(result as Extract<typeof result, { ok: false }>, store.chat(String(group.id))!).code).toBe(code);
    fakes[0]!.script("sendMessage", result);
    fakes[1]!.script("sendMessage", sent());
    if (fallback) expect((await send("classification")).sentBy?.name).toBe(names[1]);
    else expect((await failure(() => send("classification"))).code).toBe(code);
    expect(count(1)).toBe(fallback ? 1 : 0);
  });
}

test("permission revoked during membership I/O cannot reach any send", async () => {
  await outboundState(store.filename, true, db => { db.query("DELETE FROM chat_bots").run(); });
  fakes[0]!.handlers.getChatMember = () => {
    service.setChat(String(group.id), "reports", false);
    return ok({ status: "administrator" });
  };
  expect((await failure(() => send("revoked"))).code).toBe("chat_not_allowed");
  expect([count(0), count(1)]).toEqual([0, 0]);
});

for (const kind of ["photo", "document", "rich"] as const) {
  test(`${kind} uses the same assigned-bot fallback and receipt`, async () => {
    await service.assignBot(String(group.id), usernames[0]);
    const method = kind === "photo" ? "sendPhoto" : kind === "document" ? "sendDocument" : "sendRichMessage";
    fakes[0]!.script(method, refused(403, "Forbidden"));
    fakes[1]!.script(method, sent());
    const handoff = path.join(root, "handoff"); fs.mkdirSync(handoff, {recursive:true});
    const common = { conversationId: "conversation_writer", clientRequestId: kind, chat: "reports", topicId: 12 };
    let answer;
    if (kind === "photo") {
      const sharp = (await import("sharp")).default;
      const filename = path.join(handoff, "frame.png");
      await sharp({create:{width:2,height:2,channels:3,background:"white"}}).png().toFile(filename);
      answer = await service.sendMedia({...common, images:[{path:filename,caption:"Frame"}]});
    } else if (kind === "document") {
      const filename = path.join(handoff, "report.md"); fs.writeFileSync(filename,"A clean report.");
      answer = await service.sendDocument({...common, document:{path:filename}});
    } else answer = await service.sendRichMessage({clientRequestId:kind,chat:"reports",topicId:12,message:{markdown:"Review",images:[]}});
    expect(answer).toMatchObject({sentBy:{name:names[1]},refusals:[{code:"forbidden"}]});
    expect(fakes[0]!.callsOf(method)).toHaveLength(1);
    expect(fakes[1]!.callsOf(method)).toHaveLength(1);
    expect(fakes[1]!.callsOf(method)[0]!.params.message_thread_id).toBe(12);
  });
}

test("a rich media refusal followed by a rights refusal falls back only after both refusals", async () => {
  fakes[1]!.handlers.getChatMember = () => ok({ status: "restricted", is_member: true, can_send_messages: true, can_send_photos: false });
  await service.refresh();
  fakes[0]!.script("sendRichMessage", refused(400, "invalid photo dimensions"), refused(403, "Forbidden"));
  fakes[1]!.handlers.sendRichMessage = params => {
    expect(store.sendRow("prototype-review", "rich-text-fallback")?.attempts).toMatchObject([{ code: "forbidden" }]);
    expect(params).not.toHaveProperty("frame");
    return sent();
  };
  const answer = await service.sendRichMessage({ clientRequestId: "rich-text-fallback", chat: "reports",
    message: { markdown: "Review with frame", images: [{ id: "frame", blob: new Blob(["fixture"]) }] }, fallbackMarkdown: "Review" });
  expect(answer.sentBy?.name).toBe(names[1]);
  expect(fakes[0]!.callsOf("sendRichMessage")).toHaveLength(2);
  expect(fakes[1]!.callsOf("sendRichMessage")).toHaveLength(1);
});

test("an incomplete Telegram success retains its claim and never selects a second bot", async () => {
  fakes[0]!.script("sendMessage", ok(null));
  expect((await failure(() => send("unreadable"))).code).toBe("send_uncertain");
  expect([count(0),count(1)]).toEqual([1,0]);
  expect(store.sendRow("text:conversation_writer","unreadable")?.state).toBe("pending");
  expect(service.status().chats[0]?.lastDelivery?.state).toBe("uncertain");
});

test("a refusal that cannot commit never permits fallback", async () => {
  await outboundState(store.filename,true,db=>{db.exec("CREATE TRIGGER refuse_attempt BEFORE UPDATE OF attempts ON sends BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END");});
  fakes[0]!.script("sendMessage",refused(403,"Forbidden"));
  await expect(send("durability")).rejects.toThrow("fixture refusal");
  expect([count(0),count(1)]).toEqual([1,0]);
  expect(store.sendRow("text:conversation_writer","durability")?.state).toBe("pending");
});

test("concurrent calls with the same logical key cannot dispatch a second bot", async () => {
  let ready!:()=>void, release!:()=>void;
  const entered = new Promise<void>(r=>{ready=r;});
  const held = new Promise<void>(r=>{release=r;});
  fakes[0]!.handlers.sendMessage = async ()=>{ready();await held;return sent();};
  const first = send("race");
  try {
    await entered;
    expect((await failure(()=>send("race"))).code).toBe("send_uncertain");
    expect([count(0),count(1)]).toEqual([1,0]);
  } finally {release();}
  expect((await first).messageIds).toEqual([101]);
  expect((await send("race")).alreadySent).toBe(true);
});

test("an ambiguous membership check defers that bot behind a known member", async () => {
  await outboundState(store.filename,true,db=>{db.query("DELETE FROM chat_bots WHERE bot_id=?").run(ids[0]!);});
  fakes[0]!.handlers.getChatMember=()=>unreachable("timed_out");
  fakes[1]!.script("sendMessage",sent());
  expect((await send("unknown-membership")).sentBy?.name).toBe(names[1]);
  expect([count(0),count(1)]).toEqual([0,1]);
});

test("sending tokens are owner-only and removing one preserves the receiving token", async () => {
  const directory=path.dirname(store.filename);
  expect(fs.statSync(path.join(directory,"bot-tokens.json")).mode & 0o777).toBe(0o600);
  await service.removeBot(usernames[1]);
  expect(fs.existsSync(path.join(directory,"bot-token.json"))).toBe(true);
  expect(fs.existsSync(path.join(directory,"bot-tokens.json"))).toBe(false);
  expect(store.chat(String(group.id))?.alias).toBe("reports");
});

test("eight additional bots is the durable bound, and replacing a connected bot keeps its place", async () => {
  await service.stopPublications();
  Reflect.get(service,"storeCache")?.close();
  const extra = new Map<string,InstanceType<typeof FakeBotTransport>>();
  for (let i=0;i<8;i++) {
    const id=String(6000000+i);
    const fake=new FakeBotTransport();
    fake.handlers.getMe=()=>ok({id:Number(id),is_bot:true,first_name:`Sending bot ${i}`,username:`extra_${i}_fixture_bot`});
    fake.handlers.getChatMember=()=>ok({status:"administrator"});
    extra.set(id,fake);
  }
  service=makeService(extra);
  for (const id of [...extra.keys()].slice(0,7)) await service.addBot(fakeBotToken(id));
  expect(service.status().bots).toHaveLength(9);
  expect((await failure(()=>service.addBot(fakeBotToken([...extra.keys()][7]!)))).code).toBe("bad_request");
  await service.addBot(fakeBotToken(ids[1]));
  expect(service.status().bots?.[1]?.username).toBe(usernames[1]);
  expect(service.status().bots).toHaveLength(9);
});

test("migration retries the same assigned bot at the new chat id and still permits a refused-bot fallback", async () => {
  await service.assignBot(String(group.id),usernames[1]);
  const next="-1000000000202";
  fakes[1]!.script("sendMessage",refused(400,"group upgraded",{migrateToChatId:next}),refused(403,"Forbidden"));
  fakes[0]!.script("sendMessage",sent());
  const answer=await send("migration-fallback");
  expect(answer).toMatchObject({chatId:next,sentBy:{name:names[0]},refusals:[{code:"forbidden"}]});
  expect(fakes[1]!.callsOf("sendMessage").map(c=>c.params.chat_id)).toEqual([group.id,Number(next)]);
  expect(fakes[0]!.callsOf("sendMessage")[0]!.params.chat_id).toBe(Number(next));
  expect(service.status().chats[0]?.lastDelivery?.state).toBe("sent");
});

test("a last-delivery write failure after a confirmed post cannot become a retryable duplicate", async () => {
  await outboundState(store.filename,true,db=>{db.exec("CREATE TRIGGER refuse_delivery BEFORE UPDATE OF last_delivery ON chats BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END");});
  fakes[0]!.script("sendMessage",sent());
  expect((await failure(()=>send("delivery-write"))).code).toBe("send_uncertain");
  expect(store.sendRow("text:conversation_writer","delivery-write")?.state).toBe("sent");
  expect((await send("delivery-write")).alreadySent).toBe(true);
  expect([count(0),count(1)]).toEqual([1,0]);
});

test("an ambiguous second bot keeps the first bot's refusal in the answer", async () => {
  fakes[0]!.script("sendMessage",refused(403,"Forbidden"));
  fakes[1]!.script("sendMessage",unreachable("timed_out"));
  const error=await failure(()=>send("fallback-uncertain"));
  expect(error.code).toBe("send_uncertain");
  expect(error.extra.refusals).toMatchObject([{bot:{name:names[0]},code:"forbidden"}]);
  expect([count(0),count(1)]).toEqual([1,1]);
  expect(store.sendRow("text:conversation_writer","fallback-uncertain")?.state).toBe("pending");
});
