import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Telegram sign-in through the bot the install runs (sign-in-and-team §5.3),
 * driven through the bot service's own poller with a scripted transport:
 * nothing reaches the network, and the `/start <code>` update takes exactly
 * the path a real one does.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-team-telegram-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { TelegramBotService, productionTelegramBotDependencies } = await import("@/lib/telegram/bot/service");
const { FakeBotTransport, fakeBotToken, ok } = await import("@/lib/telegram/bot/fakeTransport");
const { resetTeamStoreForTests, teamStore, teamStoreFile } = await import("./store");
const { claimInstall } = await import("./members");
const { answerJoinRequest, completeTelegram, pendingJoinRequests, startTelegram, startParameter, telegramDeepLink, telegramState } = await import("./telegramSignIn");
const { resetOperatorSettingsForTests, updateOperatorSettings } = await import("@/lib/operator/settings");

import type { TgUpdate } from "@/lib/telegram/bot/store";

const BOT_ID = 4242424;
const TOKEN = fakeBotToken(String(BOT_ID));
const TOKEN_TAIL = TOKEN.slice(TOKEN.indexOf(":") + 1);
const DESKTOP = { surface: "desktop" as const, browser: "chrome" as const };
const PHONE = { surface: "phone" as const, browser: "safari" as const };
/* Invented Telegram users; none of these ids exists. */
const OLEH = { id: 700000901, is_bot: false, first_name: "Oleh", username: "oleh_example" };
const MIRA = { id: 700000902, is_bot: false, first_name: "Mira", username: "mira_example" };

let transport: InstanceType<typeof FakeBotTransport>;
let service: InstanceType<typeof TelegramBotService>;
let updateId = 1;

function started(from: typeof OLEH, text: string): TgUpdate {
  updateId += 1;
  return { update_id: updateId, message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: from.id, type: "private", first_name: from.first_name }, from, text } };
}

async function deliver(update: TgUpdate): Promise<string[]> {
  const before = transport.callsOf("sendMessage").length;
  transport.script("getUpdates", ok([update]));
  await service.pollOnce(new AbortController().signal);
  return transport.callsOf("sendMessage").slice(before).map((call) => String(call.params.text));
}

beforeEach(async () => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  resetTeamStoreForTests();
  resetOperatorSettingsForTests();
  transport = new FakeBotTransport();
  service = new TelegramBotService({ ...productionTelegramBotDependencies(), transportFor: () => transport, sleep: async () => {} });
  transport.script("getMe", ok({ id: BOT_ID, is_bot: true, first_name: "Team Bot", username: "team_test_bot" }));
  await service.connect(TOKEN);
  await service.stopPoller();
  transport.handlers.sendMessage = (params) => ok({ message_id: 1, date: 0, chat: { id: Number(params.chat_id), type: "private" } });
});

afterEach(async () => {
  await service.remove();
  resetTeamStoreForTests();
});

afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe("the deep link", () => {
  test("carries a code Telegram accepts and the bot reads back", () => {
    const store = teamStore();
    claimInstall(store, "Mira", DESKTOP);
    const { code } = startTelegram(store, "sign-in", null, PHONE);
    expect(code).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(telegramDeepLink("team_test_bot", code)).toBe(`https://t.me/team_test_bot?start=${code}`);
    expect(startParameter(`/start ${code}`)).toBe(code);
    expect(startParameter(`/start@team_test_bot ${code}`)).toBe(code);
    expect(startParameter("/start")).toBeNull();
    expect(startParameter("hello")).toBeNull();
  });
});

describe("signing in through the bot", () => {
  test("an unknown person becomes a join request, and the owner's approval signs them in", async () => {
    const store = teamStore();
    claimInstall(store, "Mira", DESKTOP);
    const { challenge, code } = startTelegram(store, "sign-in", null, PHONE);
    expect(await deliver(started(OLEH, `/start ${code}`))).toEqual(["Delegatus does not know you yet. Mira can approve you from the Team page."]);
    expect(telegramState(store, store.challenge(challenge.id)!)).toMatchObject({ state: "needs_approval", firstName: "Oleh", ownerName: "Mira" });
    expect(pendingJoinRequests(store).map((request) => request.username)).toEqual(["oleh_example"]);

    const owner = store.owner()!;
    const member = answerJoinRequest(store, owner, challenge.id, true, undefined)!;
    expect(member).toMatchObject({ name: "Oleh", role: "member", telegram: { userId: String(OLEH.id), username: "oleh_example" } });
    expect(telegramState(store, store.challenge(challenge.id)!)).toEqual({ state: "confirmed", name: "Oleh" });
    const signedIn = completeTelegram(store, store.challenge(challenge.id)!, PHONE);
    expect(signedIn.member.id).toBe(member.id);
    expect(signedIn.session.method).toBe("telegram");
    expect(pendingJoinRequests(store)).toEqual([]);
  });

  test("a linked member is confirmed by the bot itself", async () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    const link = startTelegram(store, "link", mira.id, DESKTOP);
    expect(await deliver(started(MIRA, `/start ${link.code}`))).toEqual(["Telegram linked to Mira."]);
    expect(store.member(mira.id)?.telegram?.userId).toBe(String(MIRA.id));

    const signIn = startTelegram(store, "sign-in", null, PHONE);
    expect(await deliver(started(MIRA, `/start ${signIn.code}`))).toEqual(["Signed in to Delegatus as Mira."]);
    expect(completeTelegram(store, store.challenge(signIn.challenge.id)!, PHONE).member.id).toBe(mira.id);
  });

  test("a Telegram account links to one member only", async () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    await deliver(started(MIRA, `/start ${startTelegram(store, "link", mira.id, DESKTOP).code}`));
    const request = startTelegram(store, "sign-in", null, PHONE);
    await deliver(started(OLEH, `/start ${request.code}`));
    const oleh = answerJoinRequest(store, mira, request.challenge.id, true, "Oleh")!;
    const stolen = startTelegram(store, "link", oleh.id, PHONE);
    expect(await deliver(started(MIRA, `/start ${stolen.code}`))).toEqual(["That Telegram account is already linked to Mira."]);
    expect(telegramState(store, store.challenge(stolen.challenge.id)!)).toEqual({ state: "taken" });
    /* Oleh keeps the account he joined with; Mira's is not moved onto him. */
    expect(store.member(oleh.id)?.telegram?.userId).toBe(String(OLEH.id));
    expect(store.member(mira.id)?.telegram?.userId).toBe(String(MIRA.id));
  });

  test("a code that is not ours, or a message in a group, is an ordinary message and gets no reply", async () => {
    const store = teamStore();
    claimInstall(store, "Mira", DESKTOP);
    expect(await deliver(started(OLEH, "/start AAAAAAAAAAAAAAAAAAAAAA"))).toEqual([]);
    expect(await deliver(started(OLEH, "hello"))).toEqual([]);
    const { code } = startTelegram(store, "sign-in", null, PHONE);
    const group = started(OLEH, `/start ${code}`);
    group.message!.chat = { id: -1000000000909, type: "supergroup", title: "Somewhere" };
    expect(await deliver(group)).toEqual([]);
  });

  test("the bot answers in the install's language", async () => {
    updateOperatorSettings({ locale: "uk", source: "chosen" });
    const store = teamStore();
    claimInstall(store, "Міра", DESKTOP);
    const { code } = startTelegram(store, "sign-in", null, PHONE);
    expect(await deliver(started(OLEH, `/start ${code}`))).toEqual(["Delegatus вас ще не знає. Міра може схвалити вас на сторінці Команда."]);
  });

  test("the bot token appears in no team record", async () => {
    const store = teamStore();
    claimInstall(store, "Mira", DESKTOP);
    const { code } = startTelegram(store, "sign-in", null, PHONE);
    await deliver(started(OLEH, `/start ${code}`));
    for (const suffix of ["", "-wal"]) {
      const file = `${teamStoreFile()}${suffix}`;
      if (fs.existsSync(file)) expect(fs.readFileSync(file).includes(Buffer.from(TOKEN_TAIL))).toBe(false);
    }
  });
});
