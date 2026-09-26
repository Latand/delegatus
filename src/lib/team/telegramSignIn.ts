import crypto from "node:crypto";

import { operatorLocale } from "@/lib/operator/settings";

import { cleanMemberName, type Member } from "./contract";
import { appendTeamEvent } from "./events";
import {
  challengeIsOpen,
  freeMemberName,
  issueChallenge,
  newMemberId,
  nextMemberColor,
  requireFreeName,
  TeamError,
  type Device,
  type SignedIn,
} from "./members";
import { mintSession, randomToken, sha256Hex } from "./sessions";
import { existingTeamStore, type Challenge, type ChallengeRequester, type TeamStore } from "./store";

/*
 * Telegram, through the bot the install already runs (§5.3, D5). A one-time
 * code rides a deep link, `t.me/<bot>?start=<code>`; pressing Start delivers
 * `/start <code>` to the bot's poller as an ordinary private message whose
 * `from` is the Telegram user.
 *
 * Pressing Start is not consent. A deep link can be forwarded, so whoever
 * presses Start may be someone other than the person at the requesting
 * browser — and "press Start to check the bot" is an easy thing to ask of an
 * owner. So Start only makes the bot answer, in that person's own chat, what
 * is being asked (sign in as whom, link to whom, or join; from which browser,
 * at which host, how long ago) and a six-digit code. Nothing is granted until
 * the requesting browser types that code back: the person at the browser has
 * to be the person holding the Telegram account, or has to be handed a code
 * the bot told its holder never to share. Three secrets keep the halves apart:
 * the link code (only finds the request), the browser's proof (only polls and
 * completes it), and the confirmation code (only Telegram delivers it).
 *
 * Nothing here reads the member's chats or acts as them, and the bot token
 * never leaves its transport — the poller hands this module `from` and the
 * code.
 */

export const TELEGRAM_TTL_MS = 10 * 60_000;
export const TELEGRAM_PENDING_TTL_MS = 60 * 60_000;
/** Wrong confirmation codes a request survives; the fifth voids it. */
export const TELEGRAM_CODE_ATTEMPTS = 5;

export type TelegramPurpose = "sign-in" | "link";

export interface TelegramFrom {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}

export function telegramDeepLink(botUsername: string, code: string): string {
  return `https://t.me/${encodeURIComponent(botUsername)}?start=${code}`;
}

/**
 * Opens a request. `proof` stays with the requesting browser; `link` goes
 * into the deep link and only finds the request.
 */
export function startTelegram(
  store: TeamStore,
  purpose: TelegramPurpose,
  memberId: string | null,
  requester: ChallengeRequester,
  hostName: string | null = null,
  nowMs = Date.now(),
): { challenge: Challenge; proof: string; link: string } {
  const link = randomToken(16);
  const { challenge, code } = issueChallenge(store, {
    kind: "telegram",
    ttlMs: TELEGRAM_TTL_MS,
    memberId,
    requester,
    userCode: sha256Hex(link),
    payload: { purpose, ...(hostName ? { host: hostName.slice(0, 120) } : {}) },
  }, nowMs);
  return { challenge, proof: code, link };
}

/* ---- the bot's side -------------------------------------------------------- */

interface Asked {
  host: string | null;
  device: string;
  ago: string;
  code: string;
}

const REPLIES = {
  en: {
    signIn: (name: string, asked: Asked) => [
      `Someone is signing in to Delegatus${asked.host ? ` at ${asked.host}` : ""} as ${name}.`,
      `${asked.device}, ${asked.ago}.`,
      "",
      `If that browser is in front of you, type this code into it: ${asked.code}`,
      "",
      "If someone sent you this link, do not share the code: whoever types it signs in as you.",
    ].join("\n"),
    join: (owner: string, asked: Asked) => [
      `Someone is asking to join Delegatus${asked.host ? ` at ${asked.host}` : ""} with this Telegram account.`,
      `${asked.device}, ${asked.ago}.`,
      "",
      `If that browser is in front of you, type this code into it: ${asked.code}`,
      `Then ${owner} approves you from the Team page.`,
      "",
      "If someone sent you this link, do not share the code.",
    ].join("\n"),
    link: (name: string, asked: Asked) => [
      `Someone is linking this Telegram account to ${name} in Delegatus${asked.host ? ` at ${asked.host}` : ""}.`,
      `${asked.device}, ${asked.ago}.`,
      "",
      `If you are ${name} and that browser is in front of you, type this code into it: ${asked.code}`,
      "",
      "If someone sent you this link, do not share the code: whoever types it links your Telegram to their member.",
    ].join("\n"),
    taken: (name: string) => `That Telegram account is already linked to ${name}.`,
    expired: "This sign-in link has expired or was already used. Start again from the sign-in page.",
    owner: "The owner",
    justNow: "just now",
    minutesAgo: (minutes: number) => `${minutes} min ago`,
    device: (browser: string, surface: string) => `${browser} ${surface}`,
    surface: { desktop: "on a desktop", phone: "on a phone", tablet: "on a tablet", other: "on another device" },
    browser: { chrome: "Chrome", safari: "Safari", firefox: "Firefox", edge: "Edge", other: "A browser" },
  },
  uk: {
    signIn: (name: string, asked: Asked) => [
      `Хтось входить у Delegatus${asked.host ? ` на ${asked.host}` : ""} як ${name}.`,
      `${asked.device}, ${asked.ago}.`,
      "",
      `Якщо цей браузер перед вами, введіть у ньому код: ${asked.code}`,
      "",
      "Якщо це посилання вам хтось надіслав, не передавайте код: хто його введе, увійде як ви.",
    ].join("\n"),
    join: (owner: string, asked: Asked) => [
      `Хтось просить приєднатися до Delegatus${asked.host ? ` на ${asked.host}` : ""} з цим акаунтом Telegram.`,
      `${asked.device}, ${asked.ago}.`,
      "",
      `Якщо цей браузер перед вами, введіть у ньому код: ${asked.code}`,
      `Потім ${owner} підтвердить вас на сторінці «Команда».`,
      "",
      "Якщо це посилання вам хтось надіслав, не передавайте код.",
    ].join("\n"),
    link: (name: string, asked: Asked) => [
      `Хтось прив’язує цей акаунт Telegram до учасника ${name} у Delegatus${asked.host ? ` на ${asked.host}` : ""}.`,
      `${asked.device}, ${asked.ago}.`,
      "",
      `Якщо ви — ${name} і цей браузер перед вами, введіть у ньому код: ${asked.code}`,
      "",
      "Якщо це посилання вам хтось надіслав, не передавайте код: хто його введе, прив’яже ваш Telegram до свого учасника.",
    ].join("\n"),
    taken: (name: string) => `Цей Telegram уже прив’язано до ${name}.`,
    expired: "Це посилання для входу спливло або вже використане. Почніть знову зі сторінки входу.",
    owner: "Власник",
    justNow: "щойно",
    minutesAgo: (minutes: number) => `${minutes} хв тому`,
    device: (browser: string, surface: string) => `${browser} ${surface}`,
    surface: { desktop: "на комп’ютері", phone: "на телефоні", tablet: "на планшеті", other: "на іншому пристрої" },
    browser: { chrome: "Chrome", safari: "Safari", firefox: "Firefox", edge: "Edge", other: "Браузер" },
  },
} as const;

function replies() {
  let locale: "en" | "uk" = "en";
  try {
    locale = operatorLocale() ?? "en";
  } catch {
    /* the install's language is decoration here */
  }
  return REPLIES[locale];
}

const START_COMMAND = /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{16,64})\s*$/;

/** The code a `/start` message carries, or null for any other text. */
export function startParameter(text: string | undefined): string | null {
  return text ? START_COMMAND.exec(text)?.[1] ?? null : null;
}

function newConfirmationCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function confirmationHash(challengeId: string, code: string): string {
  return sha256Hex(`${challengeId}:${code}`);
}

function askedAbout(challenge: Challenge, code: string, nowMs: number, text: ReturnType<typeof replies>): Asked {
  const minutes = Math.floor((nowMs - Date.parse(challenge.createdAt)) / 60_000);
  const surface = challenge.requester?.surface ?? "other";
  const browser = challenge.requester?.browser ?? "other";
  return {
    host: challenge.payload?.host ?? null,
    device: text.device(text.browser[browser] ?? text.browser.other, text.surface[surface] ?? text.surface.other),
    ago: minutes < 1 ? text.justNow : text.minutesAgo(minutes),
    code: `${code.slice(0, 3)} ${code.slice(3)}`,
  };
}

/**
 * Consumes one `/start <code>` from a private chat. Answers the reply the bot
 * sends back, or null when the code is none of ours (someone else's deep
 * link, a stale code) — the message is then an ordinary message and nothing
 * is said. It grants nothing: it describes the request to whoever pressed
 * Start and hands them the code the requesting browser must type back
 * (`confirmTelegram`). The first Telegram account to press Start holds the
 * request; pressing again from it sends a fresh code, and any other account
 * is told the link is used.
 */
export function handleTelegramStart(store: TeamStore, from: TelegramFrom, link: string, nowMs = Date.now()): string | null {
  if (from.is_bot) return null;
  const text = replies();
  return store.transaction(() => {
    const challenge = store.telegramChallengeByLink(sha256Hex(link));
    if (!challenge) return null;
    if (!challengeIsOpen(challenge, nowMs) || challenge.result) return text.expired;
    const telegramUserId = String(from.id);
    const holder = challenge.payload?.telegramUserId;
    if (holder && holder !== telegramUserId) return text.expired;
    const known = store.memberByTelegram(telegramUserId);
    const purpose = challenge.payload?.purpose === "link" ? "link" : "sign-in";
    const member = purpose === "link" && challenge.memberId ? store.member(challenge.memberId) : null;

    if (purpose === "link") {
      if (!member || member.status !== "active") return text.expired;
      if (known && known.id !== member.id) {
        challenge.result = { kind: "denied" };
        store.updateChallenge(challenge);
        return text.taken(known.name);
      }
    }

    const code = newConfirmationCode();
    const firstName = from.first_name?.trim();
    const username = from.username?.trim();
    challenge.payload = {
      ...challenge.payload,
      telegramUserId,
      ...(firstName ? { firstName } : {}),
      ...(username ? { username } : {}),
      confirmHash: confirmationHash(challenge.id, code),
    };
    store.updateChallenge(challenge);
    const asked = askedAbout(challenge, code, nowMs, text);
    if (member) return text.link(member.name, asked);
    if (known && known.status === "active") return text.signIn(known.name, asked);
    return text.join(store.owner()?.name ?? text.owner, asked);
  });
}

/**
 * The poller's hook: a private-chat message from `from` with this text. Never
 * throws — a sign-in problem must not stop the bot receiving.
 */
export function teamTelegramHook(input: { from: TelegramFrom | undefined; chatType: string; text: string | undefined }): string | null {
  if (input.chatType !== "private" || !input.from) return null;
  const code = startParameter(input.text);
  if (!code) return null;
  try {
    const store = existingTeamStore();
    if (!store || !store.hasActiveOwner()) return null;
    return handleTelegramStart(store, input.from, code);
  } catch (error) {
    console.error("[team] telegram sign-in hook failed", { reason: (error as NodeJS.ErrnoException)?.code ?? "unavailable" });
    return null;
  }
}

/* ---- the requesting browser's side ---------------------------------------- */

export type TelegramState =
  | { state: "waiting"; expiresAt: string }
  | { state: "code_sent"; expiresAt: string }
  | { state: "confirmed"; name: string }
  | { state: "linked"; name: string }
  | { state: "needs_approval"; firstName: string | null; ownerName: string | null }
  | { state: "taken" }
  | { state: "denied" }
  | { state: "expired" };

export function telegramState(store: TeamStore, challenge: Challenge, nowMs = Date.now()): TelegramState {
  const result = challenge.result;
  if (result?.kind === "denied") return challenge.payload?.purpose === "link" ? { state: "taken" } : { state: "denied" };
  if (challenge.consumedAt || Date.parse(challenge.expiresAt) <= nowMs) return { state: "expired" };
  if (!result) return challenge.payload?.confirmHash ? { state: "code_sent", expiresAt: challenge.expiresAt } : { state: "waiting", expiresAt: challenge.expiresAt };
  if (result.kind === "telegram") {
    const member = result.memberId ? store.member(result.memberId) : null;
    if (challenge.payload?.purpose === "link") return member ? { state: "linked", name: member.name } : { state: "expired" };
    if (member && member.status === "active") return { state: "confirmed", name: member.name };
    return { state: "needs_approval", firstName: result.firstName ?? result.username, ownerName: store.owner()?.name ?? null };
  }
  return { state: "expired" };
}

function codeMatches(challenge: Challenge, input: unknown): boolean {
  const expected = challenge.payload?.confirmHash;
  const digits = typeof input === "string" ? input.replace(/\D/g, "") : "";
  if (!expected || digits.length !== 6) return false;
  const given = Buffer.from(confirmationHash(challenge.id, digits));
  const want = Buffer.from(expected);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

/**
 * The requesting browser types back the code the bot sent to whoever pressed
 * Start. Only this grants anything: a link binds the Telegram account, a
 * known member's sign-in becomes completable, and an unknown person's becomes
 * a join request the owner sees. A wrong code counts against the request and
 * the fifth voids it.
 */
export function confirmTelegram(store: TeamStore, challenge: Challenge, codeInput: unknown, nowMs = Date.now()): TelegramState {
  /* A wrong code is refused after the transaction commits, so the attempt it
     spent is kept. */
  const answer = store.transaction((): TelegramState | TeamError => {
    const fresh = store.challenge(challenge.id);
    if (!fresh || !challengeIsOpen(fresh, nowMs) || fresh.result) return fresh ? telegramState(store, fresh, nowMs) : { state: "expired" };
    const payload = fresh.payload ?? {};
    if (!payload.confirmHash || !payload.telegramUserId) throw new TeamError("not_started", "press Start in the chat with the bot first", 409);
    if (!codeMatches(fresh, codeInput)) {
      fresh.attempts += 1;
      const spent = fresh.attempts >= TELEGRAM_CODE_ATTEMPTS;
      if (spent) fresh.consumedAt = new Date(nowMs).toISOString();
      store.updateChallenge(fresh);
      return spent
        ? new TeamError("too_many_attempts", "too many wrong codes; start again", 429)
        : new TeamError("code_wrong", "that code is not right", 400);
    }

    const telegramUserId = payload.telegramUserId;
    const firstName = payload.firstName ?? null;
    const username = payload.username ?? null;
    const kept = { ...payload };
    delete kept.confirmHash;
    fresh.payload = kept;
    const known = store.memberByTelegram(telegramUserId);

    if (kept.purpose === "link") {
      const member = fresh.memberId ? store.member(fresh.memberId) : null;
      if (!member || member.status !== "active") {
        fresh.consumedAt = new Date(nowMs).toISOString();
        store.updateChallenge(fresh);
        return { state: "expired" };
      }
      if (known && known.id !== member.id) {
        fresh.result = { kind: "denied" };
        store.updateChallenge(fresh);
        return { state: "taken" };
      }
      store.updateMember({ ...member, telegram: { userId: telegramUserId, username, firstName, linkedAt: new Date(nowMs).toISOString() } });
      fresh.result = { kind: "telegram", telegramUserId, firstName, username, memberId: member.id };
      store.updateChallenge(fresh);
      appendTeamEvent(store, { actor: { kind: "member", memberId: member.id }, action: "telegram.linked", subject: { kind: "member", id: member.id, title: member.name }, detail: { username } }, nowMs);
      return telegramState(store, fresh, nowMs);
    }

    const member = known && known.status === "active" ? known : null;
    fresh.result = { kind: "telegram", telegramUserId, firstName, username, memberId: member?.id ?? null };
    if (!member) {
      /* An unknown person asked to join: the owner has an hour to answer. */
      fresh.expiresAt = new Date(nowMs + TELEGRAM_PENDING_TTL_MS).toISOString();
      appendTeamEvent(store, {
        actor: { kind: "service", service: "telegram" },
        action: "join.requested",
        subject: { kind: "member", id: fresh.id, title: firstName ?? username ?? telegramUserId },
        detail: { username },
      }, nowMs);
    }
    store.updateChallenge(fresh);
    return telegramState(store, fresh, nowMs);
  });
  if (answer instanceof TeamError) throw answer;
  return answer;
}

export function completeTelegram(store: TeamStore, challenge: Challenge, device: Device, nowMs = Date.now()): SignedIn {
  return store.transaction(() => {
    const fresh = store.challenge(challenge.id);
    if (!fresh || !challengeIsOpen(fresh, nowMs) || fresh.result?.kind !== "telegram" || fresh.payload?.purpose === "link") {
      throw new TeamError("not_confirmed", "Telegram has not confirmed this sign-in", 409);
    }
    const member = fresh.result.memberId ? store.member(fresh.result.memberId) : null;
    if (!member || member.status !== "active") throw new TeamError("not_confirmed", "Telegram has not confirmed this sign-in", 409);
    if (!store.consumeChallenge(fresh.id, new Date(nowMs).toISOString())) throw new TeamError("not_confirmed", "already signed in", 409);
    const { value, session } = mintSession(store, member.id, "telegram", device, nowMs);
    appendTeamEvent(store, {
      actor: { kind: "member", memberId: member.id },
      action: "session.signed_in",
      subject: { kind: "session", id: session.id.slice(0, 12), title: null },
      detail: { method: "telegram", surface: device.surface, browser: device.browser },
    }, nowMs);
    return { member, cookie: value, session };
  });
}

/** "That's not me": the person who asked voids the request. */
export function voidTelegram(store: TeamStore, challenge: Challenge, nowMs = Date.now()): void {
  store.transaction(() => {
    if (!store.consumeChallenge(challenge.id, new Date(nowMs).toISOString())) return;
    appendTeamEvent(store, { actor: { kind: "service", service: "telegram" }, action: "join.denied", subject: null, detail: { by: "requester" } }, nowMs);
  });
}

/* ---- join requests (the owner's side) -------------------------------------- */

export interface JoinRequest {
  id: string;
  firstName: string | null;
  username: string | null;
  requestedAt: string;
  expiresAt: string;
}

export function pendingJoinRequests(store: TeamStore, nowMs = Date.now()): JoinRequest[] {
  return store.openChallenges("telegram", new Date(nowMs).toISOString()).flatMap((challenge) => {
    const result = challenge.result;
    if (result?.kind !== "telegram" || result.memberId || challenge.payload?.purpose === "link") return [];
    return [{ id: challenge.id, firstName: result.firstName, username: result.username, requestedAt: challenge.createdAt, expiresAt: challenge.expiresAt }];
  });
}

export function answerJoinRequest(store: TeamStore, owner: Member, id: string, approve: boolean, nameInput: unknown, nowMs = Date.now()): Member | null {
  return store.transaction(() => {
    const challenge = store.challenge(id);
    const result = challenge?.result;
    if (!challenge || challenge.kind !== "telegram" || !challengeIsOpen(challenge, nowMs) || result?.kind !== "telegram" || result.memberId) {
      throw new TeamError("request_gone", "that request has expired or was answered", 410);
    }
    if (!approve) {
      challenge.result = { kind: "denied" };
      store.updateChallenge(challenge);
      appendTeamEvent(store, { actor: { kind: "member", memberId: owner.id }, action: "join.denied", subject: { kind: "member", id: challenge.id, title: result.firstName ?? result.username }, detail: null }, nowMs);
      return null;
    }
    if (store.memberByTelegram(result.telegramUserId)) throw new TeamError("telegram_taken", "that Telegram account is already a member", 409);
    /* The owner's name is used as typed and refused if someone holds it; a
       Telegram first name is the requester's own choice, so a taken one gets
       a number rather than making a second person look like the first. */
    const typed = cleanMemberName(nameInput);
    const name = typed
      ? requireFreeName(store, typed)
      : freeMemberName(store, cleanMemberName(result.firstName) ?? cleanMemberName(result.username) ?? "Telegram");
    const member: Member = {
      id: newMemberId(),
      name,
      role: "member",
      status: "active",
      color: nextMemberColor(store),
      telegram: { userId: result.telegramUserId, username: result.username, firstName: result.firstName, linkedAt: new Date(nowMs).toISOString() },
      createdAt: new Date(nowMs).toISOString(),
      createdBy: owner.id,
      revokedAt: null,
    };
    store.insertMember(member);
    challenge.result = { ...result, memberId: member.id };
    store.updateChallenge(challenge);
    appendTeamEvent(store, { actor: { kind: "member", memberId: owner.id }, action: "join.approved", subject: { kind: "member", id: member.id, title: member.name }, detail: { via: "telegram" } }, nowMs);
    appendTeamEvent(store, { actor: { kind: "member", memberId: member.id }, action: "member.joined", subject: { kind: "member", id: member.id, title: member.name }, detail: { via: "telegram" } }, nowMs);
    return member;
  });
}

export function unlinkTelegram(store: TeamStore, member: Member, nowMs = Date.now()): Member {
  if (!member.telegram) return member;
  const next = { ...member, telegram: null };
  store.transaction(() => {
    store.updateMember(next);
    appendTeamEvent(store, { actor: { kind: "member", memberId: member.id }, action: "telegram.unlinked", subject: { kind: "member", id: member.id, title: member.name } }, nowMs);
  });
  return next;
}
