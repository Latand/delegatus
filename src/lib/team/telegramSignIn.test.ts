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
const { challengeForRequester, claimInstall } = await import("./members");
const {
  answerJoinRequest, completeTelegram, confirmTelegram, pendingJoinRequests, startTelegram, startParameter, telegramDeepLink, telegramState,
  TELEGRAM_CODE_ATTEMPTS,
} = await import("./telegramSignIn");
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

/** The six digits the bot's reply hands to whoever pressed Start. */
function sentCode(reply: string | undefined): string {
  const match = /(\d{3}) (\d{3})/.exec(reply ?? "");
  if (!match) throw new Error(`no code in ${JSON.stringify(reply)}`);
  return `${match[1]}${match[2]}`;
}

function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

function refused(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "thrown";
  }
}

describe("the deep link", () => {
  test("carries a code Telegram accepts and the bot reads back, which is not the browser's proof", () => {
    const store = teamStore();
    claimInstall(store, "Mira", DESKTOP);
    const { challenge, link, proof } = startTelegram(store, "sign-in", null, PHONE);
    expect(link).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(link).not.toBe(proof);
    expect(telegramDeepLink("team_test_bot", link)).toBe(`https://t.me/team_test_bot?start=${link}`);
    expect(startParameter(`/start ${link}`)).toBe(link);
    expect(startParameter(`/start@team_test_bot ${link}`)).toBe(link);
    expect(startParameter("/start")).toBeNull();
    expect(startParameter("hello")).toBeNull();
    /* Whoever holds the link cannot poll or complete the request with it. */
    expect(challengeForRequester(store, challenge.id, link, "telegram")).toBeNull();
    expect(challengeForRequester(store, challenge.id, proof, "telegram")?.id).toBe(challenge.id);
  });
});

describe("signing in through the bot", () => {
  test("an unknown person types the bot's code back, becomes a join request, and the owner's approval signs them in", async () => {
    const store = teamStore();
    claimInstall(store, "Mira", DESKTOP);
    const { challenge, link } = startTelegram(store, "sign-in", null, PHONE, "dev.example.net");
    const [reply] = await deliver(started(OLEH, `/start ${link}`));
    expect(reply).toStartWith("Someone is asking to join Delegatus at dev.example.net with this Telegram account.\nSafari on a phone, just now.");
    expect(reply).toContain("Then Mira approves you from the Team page.");
    /* Start alone asks the owner nothing. */
    expect(telegramState(store, store.challenge(challenge.id)!)).toMatchObject({ state: "code_sent" });
    expect(pendingJoinRequests(store)).toEqual([]);

    expect(confirmTelegram(store, challenge, sentCode(reply))).toMatchObject({ state: "needs_approval", firstName: "Oleh", ownerName: "Mira" });
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

  test("a linked member signs in once the browser types back the code, and so does the link itself", async () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    const link = startTelegram(store, "link", mira.id, DESKTOP);
    const [linkReply] = await deliver(started(MIRA, `/start ${link.link}`));
    expect(linkReply).toStartWith("Someone is linking this Telegram account to Mira in Delegatus.");
    expect(store.member(mira.id)?.telegram).toBeNull();
    expect(confirmTelegram(store, link.challenge, sentCode(linkReply))).toEqual({ state: "linked", name: "Mira" });
    expect(store.member(mira.id)?.telegram?.userId).toBe(String(MIRA.id));

    const signIn = startTelegram(store, "sign-in", null, PHONE);
    const [reply] = await deliver(started(MIRA, `/start ${signIn.link}`));
    expect(reply).toStartWith("Someone is signing in to Delegatus as Mira.");
    expect(reply).toContain("If someone sent you this link, do not share the code");
    expect(refused(() => completeTelegram(store, store.challenge(signIn.challenge.id)!, PHONE))).toBe("not_confirmed");
    expect(confirmTelegram(store, signIn.challenge, sentCode(reply))).toEqual({ state: "confirmed", name: "Mira" });
    expect(completeTelegram(store, store.challenge(signIn.challenge.id)!, PHONE).member.id).toBe(mira.id);
  });

  test("a forwarded sign-in link: the owner pressing Start signs nobody in without the code", async () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    const link = startTelegram(store, "link", mira.id, DESKTOP);
    confirmTelegram(store, link.challenge, sentCode((await deliver(started(MIRA, `/start ${link.link}`)))[0]));

    /* Someone past the perimeter opens the sign-in page and sends the owner
       its deep link; the owner presses Start. */
    const phished = startTelegram(store, "sign-in", null, PHONE);
    const [reply] = await deliver(started(MIRA, `/start ${phished.link}`));
    expect(reply).toContain("as Mira");
    expect(telegramState(store, store.challenge(phished.challenge.id)!)).toMatchObject({ state: "code_sent" });
    expect(refused(() => completeTelegram(store, store.challenge(phished.challenge.id)!, PHONE))).toBe("not_confirmed");

    /* A second account pressing Start does not take the request over. */
    expect(await deliver(started(OLEH, `/start ${phished.link}`))).toEqual(["This sign-in link has expired or was already used. Start again from the sign-in page."]);

    /* Guessing spends the request. */
    const code = sentCode(reply);
    for (let attempt = 1; attempt < TELEGRAM_CODE_ATTEMPTS; attempt += 1) {
      expect(refused(() => confirmTelegram(store, phished.challenge, wrongCode(code)))).toBe("code_wrong");
    }
    expect(refused(() => confirmTelegram(store, phished.challenge, wrongCode(code)))).toBe("too_many_attempts");
    expect(confirmTelegram(store, phished.challenge, code)).toEqual({ state: "expired" });
    expect(refused(() => completeTelegram(store, store.challenge(phished.challenge.id)!, PHONE))).toBe("not_confirmed");
    expect(store.sessionsFor(mira.id)).toHaveLength(1);
  });

  test("a forwarded link request moves no Telegram account without the code", async () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    const request = startTelegram(store, "sign-in", null, PHONE);
    confirmTelegram(store, request.challenge, sentCode((await deliver(started(OLEH, `/start ${request.link}`)))[0]));
    const oleh = answerJoinRequest(store, mira, request.challenge.id, true, "Oleh")!;

    /* Oleh asks to link "his" Telegram and sends the link to Mira. */
    const lure = startTelegram(store, "link", oleh.id, PHONE);
    const [reply] = await deliver(started(MIRA, `/start ${lure.link}`));
    expect(reply).toStartWith("Someone is linking this Telegram account to Oleh in Delegatus.");
    expect(refused(() => confirmTelegram(store, lure.challenge, wrongCode(sentCode(reply))))).toBe("code_wrong");
    expect(telegramState(store, store.challenge(lure.challenge.id)!)).toMatchObject({ state: "code_sent" });
    expect(store.member(oleh.id)?.telegram?.userId).toBe(String(OLEH.id));
    expect(store.memberByTelegram(String(MIRA.id))).toBeNull();
  });

  test("a Telegram account links to one member only", async () => {
    const store = teamStore();
    const mira = claimInstall(store, "Mira", DESKTOP).member;
    const own = startTelegram(store, "link", mira.id, DESKTOP);
    confirmTelegram(store, own.challenge, sentCode((await deliver(started(MIRA, `/start ${own.link}`)))[0]));
    const request = startTelegram(store, "sign-in", null, PHONE);
    confirmTelegram(store, request.challenge, sentCode((await deliver(started(OLEH, `/start ${request.link}`)))[0]));
    const oleh = answerJoinRequest(store, mira, request.challenge.id, true, "Oleh")!;
    const stolen = startTelegram(store, "link", oleh.id, PHONE);
    expect(await deliver(started(MIRA, `/start ${stolen.link}`))).toEqual(["That Telegram account is already linked to Mira."]);
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
    const { link, proof } = startTelegram(store, "sign-in", null, PHONE);
    const group = started(OLEH, `/start ${link}`);
    group.message!.chat = { id: -1000000000909, type: "supergroup", title: "Somewhere" };
    expect(await deliver(group)).toEqual([]);
    /* The browser's proof is not a deep-link code either. */
    expect(await deliver(started(OLEH, `/start ${proof}`))).toEqual([]);
  });

  test("the bot answers in the install's language", async () => {
    updateOperatorSettings({ locale: "uk", source: "chosen" });
    const store = teamStore();
    claimInstall(store, "Міра", DESKTOP);
    const { link } = startTelegram(store, "sign-in", null, PHONE);
    const [reply] = await deliver(started(OLEH, `/start ${link}`));
    expect(reply).toStartWith("Хтось просить приєднатися до Delegatus з цим акаунтом Telegram.\nSafari на телефоні, щойно.");
    expect(reply).toContain("Потім Міра підтвердить вас на сторінці «Команда».");
  });

  test("the bot token and the deep-link code appear in no team record", async () => {
    const store = teamStore();
    claimInstall(store, "Mira", DESKTOP);
    const { link } = startTelegram(store, "sign-in", null, PHONE);
    const code = sentCode((await deliver(started(OLEH, `/start ${link}`)))[0]);
    for (const suffix of ["", "-wal"]) {
      const file = `${teamStoreFile()}${suffix}`;
      if (!fs.existsSync(file)) continue;
      const bytes = fs.readFileSync(file);
      expect(bytes.includes(Buffer.from(TOKEN_TAIL))).toBe(false);
      expect(bytes.includes(Buffer.from(link))).toBe(false);
    }
    expect(code).toMatch(/^\d{6}$/);
  });
});
