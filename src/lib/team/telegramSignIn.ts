import { operatorLocale } from "@/lib/operator/settings";

import { cleanMemberName, type Member } from "./contract";
import { appendTeamEvent } from "./events";
import {
  challengeIsOpen,
  issueChallenge,
  newMemberId,
  nextMemberColor,
  TeamError,
  type Device,
  type SignedIn,
} from "./members";
import { mintSession, sha256Hex } from "./sessions";
import { existingTeamStore, type Challenge, type ChallengeRequester, type TeamStore } from "./store";

/*
 * Telegram, through the bot the install already runs (§5.3, D5). A one-time
 * code rides a deep link, `t.me/<bot>?start=<code>`; pressing Start delivers
 * `/start <code>` to the bot's poller as an ordinary private message whose
 * `from` is the Telegram user. That message is the whole proof: Telegram
 * delivered it from that user, with that code, within ten minutes. Nothing
 * here reads the member's chats or acts as them, and the bot token never
 * leaves its transport — the poller hands this module `from` and the code.
 */

export const TELEGRAM_TTL_MS = 10 * 60_000;
export const TELEGRAM_PENDING_TTL_MS = 60 * 60_000;

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

export function startTelegram(
  store: TeamStore,
  purpose: TelegramPurpose,
  memberId: string | null,
  requester: ChallengeRequester,
  nowMs = Date.now(),
): { challenge: Challenge; code: string } {
  return issueChallenge(store, {
    kind: "telegram",
    ttlMs: TELEGRAM_TTL_MS,
    memberId,
    requester,
    payload: { purpose },
  }, nowMs);
}

/* ---- the bot's side -------------------------------------------------------- */

const REPLIES = {
  en: {
    signedIn: (name: string) => `Signed in to Delegatus as ${name}.`,
    unknown: (owner: string) => `Delegatus does not know you yet. ${owner} can approve you from the Team page.`,
    linked: (name: string) => `Telegram linked to ${name}.`,
    taken: (name: string) => `That Telegram account is already linked to ${name}.`,
    expired: "This sign-in link has expired. Start again from the sign-in page.",
    owner: "The owner",
  },
  uk: {
    signedIn: (name: string) => `Ви увійшли в Delegatus як ${name}.`,
    unknown: (owner: string) => `Delegatus вас ще не знає. ${owner} може підтвердити вас на сторінці «Команда».`,
    linked: (name: string) => `Telegram прив’язано до ${name}.`,
    taken: (name: string) => `Цей Telegram уже прив’язано до ${name}.`,
    expired: "Це посилання для входу спливло. Почніть знову зі сторінки входу.",
    owner: "Власник",
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

/**
 * Consumes one `/start <code>` from a private chat. Answers the reply the bot
 * sends back, or null when the code is none of ours (someone else's deep
 * link, a stale code) — the message is then an ordinary message and nothing
 * is said.
 */
export function handleTelegramStart(store: TeamStore, from: TelegramFrom, code: string, nowMs = Date.now()): string | null {
  if (from.is_bot) return null;
  const text = replies();
  return store.transaction(() => {
    const challenge = store.challengeBySecret(sha256Hex(code));
    if (!challenge || challenge.kind !== "telegram") return null;
    if (!challengeIsOpen(challenge, nowMs) || challenge.result) return text.expired;
    const telegramUserId = String(from.id);
    const firstName = from.first_name?.trim() || null;
    const username = from.username?.trim() || null;
    const known = store.memberByTelegram(telegramUserId);
    const purpose = challenge.payload?.purpose === "link" ? "link" : "sign-in";

    if (purpose === "link") {
      const member = challenge.memberId ? store.member(challenge.memberId) : null;
      if (!member || member.status !== "active") return text.expired;
      if (known && known.id !== member.id) {
        challenge.result = { kind: "denied" };
        store.updateChallenge(challenge);
        return text.taken(known.name);
      }
      const linked: Member = { ...member, telegram: { userId: telegramUserId, username, firstName, linkedAt: new Date(nowMs).toISOString() } };
      store.updateMember(linked);
      challenge.result = { kind: "telegram", telegramUserId, firstName, username, memberId: member.id };
      store.updateChallenge(challenge);
      appendTeamEvent(store, { actor: { kind: "member", memberId: member.id }, action: "telegram.linked", subject: { kind: "member", id: member.id, title: member.name }, detail: { username } }, nowMs);
      return text.linked(member.name);
    }

    const member = known && known.status === "active" ? known : null;
    challenge.result = { kind: "telegram", telegramUserId, firstName, username, memberId: member?.id ?? null };
    if (!member) {
      /* An unknown person asked to join: the owner has an hour to answer. */
      challenge.expiresAt = new Date(nowMs + TELEGRAM_PENDING_TTL_MS).toISOString();
      store.updateChallenge(challenge);
      appendTeamEvent(store, {
        actor: { kind: "service", service: "telegram" },
        action: "join.requested",
        subject: { kind: "member", id: challenge.id, title: firstName ?? username ?? telegramUserId },
        detail: { username },
      }, nowMs);
      return text.unknown(store.owner()?.name ?? text.owner);
    }
    store.updateChallenge(challenge);
    return text.signedIn(member.name);
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
  if (!result) return { state: "waiting", expiresAt: challenge.expiresAt };
  if (result.kind === "telegram") {
    const member = result.memberId ? store.member(result.memberId) : null;
    if (challenge.payload?.purpose === "link") return member ? { state: "linked", name: member.name } : { state: "expired" };
    if (member && member.status === "active") return { state: "confirmed", name: member.name };
    return { state: "needs_approval", firstName: result.firstName ?? result.username, ownerName: store.owner()?.name ?? null };
  }
  return { state: "expired" };
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
    const name = cleanMemberName(nameInput) ?? cleanMemberName(result.firstName) ?? cleanMemberName(result.username) ?? "Telegram";
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
