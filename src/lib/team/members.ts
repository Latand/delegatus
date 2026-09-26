import crypto from "node:crypto";

import {
  cleanMemberName,
  isMemberColor,
  MEMBER_COLORS,
  memberInitials,
  normalizeUserCode,
  USER_CODE_ALPHABET,
  type Member,
  type MemberColor,
  type MemberSession,
  type MemberSummary,
  type SessionBrowser,
  type SessionSurface,
  type SignInMethod,
  type TeamActor,
  type TeamView,
} from "./contract";
import { appendTeamEvent } from "./events";
import { mintSession, randomToken, sha256Hex } from "./sessions";
import type { Challenge, ChallengeKind, ChallengeRequester, TeamStore } from "./store";

/*
 * Members, and every way in that needs no third party (§5.1, §5.2, §5.5): the
 * owner's claim, an invite link, approving a new device from a signed-in one,
 * the phone hand-off, and the host's recovery link. Each one ends by minting a
 * session; each short-lived code is single use, consumed inside the same
 * transaction that acts on it.
 */

export const INVITE_TTL_MS = 7 * 24 * 3_600_000;
export const APPROVAL_TTL_MS = 10 * 60_000;
export const HANDOFF_TTL_MS = 10 * 60_000;
export const RECOVERY_TTL_MS = 15 * 60_000;
/* How many requests nobody signed in opened (device approvals, Telegram and
   passkey sign-ins) may be open at once, per kind. Anyone who reaches the
   address can open one, so without a bound a script fills the store within a
   code's lifetime. Past it a new request is refused and the open ones keep
   working, so a flood cannot push a real person's code out. */
export const OPEN_SIGN_IN_REQUEST_LIMIT = 64;
const APPROVAL_GUESS_LIMIT = 5;
const APPROVAL_GUESS_WINDOW_MS = 10 * 60_000;

export class TeamError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "TeamError";
  }
}

export type Device = { surface: SessionSurface; browser: SessionBrowser };

export interface SignedIn {
  member: Member;
  cookie: string;
  session: MemberSession;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function newMemberId(): string {
  return `m_${crypto.randomBytes(16).toString("hex")}`;
}

function newChallengeId(): string {
  return `c_${crypto.randomBytes(16).toString("hex")}`;
}

/** Colours go round the palette in order, so the first eight people differ. */
export function nextMemberColor(store: TeamStore): MemberColor {
  const used = store.members().map((member) => member.color);
  for (const color of MEMBER_COLORS) if (!used.includes(color)) return color;
  return MEMBER_COLORS[used.length % MEMBER_COLORS.length];
}

export function memberSummary(member: Member): MemberSummary {
  return {
    id: member.id,
    name: member.name,
    color: member.color,
    initials: memberInitials(member.name),
    role: member.role,
    status: member.status,
  };
}

function requireName(value: unknown): string {
  const name = cleanMemberName(value);
  if (!name) throw new TeamError("name_required", "a name is required");
  return name;
}

/* A name is who the chat, the Activity tab and the MCP author line say sent
   something, so no two people may hold the same one: compared without case,
   spaces, invisible characters or compatibility forms, and with the Cyrillic
   and Greek letters that draw like Latin ones folded onto them (a subset of
   the Unicode TR39 skeleton), against every member, revoked ones too (their
   past messages still carry the name). Each letter is folded from its
   lowercase, so a capital's look-alike maps to the letter its capital draws:
   "В" to b, "Н" to h, "Ν" to n. */
const LOOKALIKES: Record<string, string> = {
  // Cyrillic
  "а": "a", "в": "b", "е": "e", "ё": "e", "һ": "h", "н": "h", "і": "i", "ї": "i", "ј": "j", "к": "k", "ӏ": "l",
  "м": "m", "о": "o", "р": "p", "ԛ": "q", "ѕ": "s", "т": "t", "у": "y", "ү": "y", "х": "x", "с": "c", "ԁ": "d", "ԝ": "w",
  // Greek
  "α": "a", "β": "b", "ε": "e", "ζ": "z", "η": "h", "ι": "i", "κ": "k", "μ": "m", "ν": "n", "ο": "o", "ρ": "p",
  "τ": "t", "υ": "y", "χ": "x",
  // Latin and digits
  "ı": "i", "0": "o",
};
const LOOKALIKE_PATTERN = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "gu");

function nameKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{Cf}\p{Default_Ignorable_Code_Point}]+/gu, "")
    .replace(LOOKALIKE_PATTERN, (letter) => LOOKALIKES[letter]);
}

function nameTaken(store: TeamStore, name: string, exceptId: string | null): boolean {
  const key = nameKey(name);
  return store.members().some((member) => member.id !== exceptId && nameKey(member.name) === key);
}

export function requireFreeName(store: TeamStore, name: string, exceptId: string | null = null): string {
  if (nameTaken(store, name, exceptId)) throw new TeamError("name_taken", "another member already has that name", 409);
  return name;
}

/** A name nobody holds yet, for one the joiner did not type (a Telegram
    first name): the name itself, or it followed by the first free number. */
export function freeMemberName(store: TeamStore, name: string): string {
  if (!nameTaken(store, name, null)) return name;
  const base = [...name].slice(0, 56).join("");
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!nameTaken(store, candidate, null)) return candidate;
  }
}

function signIn(store: TeamStore, member: Member, method: SignInMethod, device: Device, nowMs: number, actor?: TeamActor): SignedIn {
  const { value, session } = mintSession(store, member.id, method, device, nowMs);
  appendTeamEvent(store, {
    actor: actor ?? { kind: "member", memberId: member.id },
    action: "session.signed_in",
    subject: { kind: "session", id: session.id.slice(0, 12), title: null },
    detail: { method, surface: device.surface, browser: device.browser },
  }, nowMs);
  return { member, cookie: value, session };
}

/* ---- challenges ----------------------------------------------------------- */

export function issueChallenge(store: TeamStore, input: {
  kind: ChallengeKind;
  ttlMs: number;
  memberId?: string | null;
  createdBy?: string | null;
  invitedName?: string | null;
  userCode?: string | null;
  requester?: ChallengeRequester | null;
  payload?: Record<string, string> | null;
}, nowMs = Date.now()): { challenge: Challenge; code: string } {
  const code = randomToken(16);
  const challenge: Challenge = {
    id: newChallengeId(),
    kind: input.kind,
    secretHash: sha256Hex(code),
    userCode: input.userCode ?? null,
    memberId: input.memberId ?? null,
    createdBy: input.createdBy ?? null,
    createdAt: iso(nowMs),
    expiresAt: iso(nowMs + input.ttlMs),
    consumedAt: null,
    attempts: 0,
    invitedName: input.invitedName ?? null,
    result: null,
    requester: input.requester ?? null,
    payload: input.payload ?? null,
  };
  store.pruneChallenges(nowMs);
  const keyless = input.kind !== "recovery" && !challenge.memberId && !challenge.createdBy;
  if (keyless && store.countOpenKeylessChallenges(input.kind, challenge.createdAt) >= OPEN_SIGN_IN_REQUEST_LIMIT) {
    throw new TeamError("too_many_requests", "too many sign-in requests are open; try again in a few minutes", 429);
  }
  store.insertChallenge(challenge);
  return { challenge, code };
}

export function challengeIsOpen(challenge: Challenge | null, nowMs: number): challenge is Challenge {
  return Boolean(challenge && !challenge.consumedAt && Date.parse(challenge.expiresAt) > nowMs);
}

/** A challenge by its public id, checked against the proof its requester
    holds. The id alone never completes anything. */
export function challengeForRequester(store: TeamStore, id: string, proof: unknown, kind: ChallengeKind): Challenge | null {
  if (typeof proof !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(proof)) return null;
  const challenge = store.challenge(id);
  if (!challenge || challenge.kind !== kind) return null;
  const expected = Buffer.from(challenge.secretHash);
  const given = Buffer.from(sha256Hex(proof));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? challenge : null;
}

/* ---- the owner's claim ---------------------------------------------------- */

export function claimInstall(store: TeamStore, nameInput: unknown, device: Device, nowMs = Date.now()): SignedIn {
  const name = requireName(nameInput);
  return store.transaction(() => {
    if (store.hasActiveOwner()) throw new TeamError("already_claimed", "this Delegatus already has an owner", 409);
    const member: Member = {
      id: newMemberId(),
      name,
      role: "owner",
      status: "active",
      color: nextMemberColor(store),
      telegram: null,
      createdAt: iso(nowMs),
      createdBy: "claim",
      revokedAt: null,
    };
    store.insertMember(member);
    appendTeamEvent(store, { actor: { kind: "member", memberId: member.id }, action: "member.claimed", subject: { kind: "member", id: member.id, title: member.name } }, nowMs);
    return signIn(store, member, "claim", device, nowMs);
  });
}

/* ---- invites -------------------------------------------------------------- */

export function createInvite(store: TeamStore, owner: Member, nameInput: unknown, nowMs = Date.now()): { challenge: Challenge; code: string } {
  const invitedName = cleanMemberName(nameInput);
  return store.transaction(() => {
    const issued = issueChallenge(store, { kind: "invite", ttlMs: INVITE_TTL_MS, createdBy: owner.id, invitedName }, nowMs);
    appendTeamEvent(store, {
      actor: { kind: "member", memberId: owner.id },
      action: "member.invited",
      subject: invitedName ? { kind: "member", id: issued.challenge.id, title: invitedName } : null,
    }, nowMs);
    return issued;
  });
}

export interface OpenInvite {
  id: string;
  invitedName: string | null;
  createdAt: string;
  expiresAt: string;
  createdBy: string | null;
}

export function openInvites(store: TeamStore, nowMs = Date.now()): OpenInvite[] {
  return store.openChallenges("invite", iso(nowMs)).map((challenge) => ({
    id: challenge.id,
    invitedName: challenge.invitedName,
    createdAt: challenge.createdAt,
    expiresAt: challenge.expiresAt,
    createdBy: challenge.createdBy,
  }));
}

export function withdrawInvite(store: TeamStore, id: string, nowMs = Date.now()): boolean {
  const challenge = store.challenge(id);
  if (!challenge || challenge.kind !== "invite") return false;
  return store.consumeChallenge(id, iso(nowMs));
}

/* ---- joining through a link (invite, hand-off, recovery) ------------------ */

export type JoinPreview =
  | { valid: false }
  | { valid: true; kind: "invite"; inviterName: string | null; invitedName: string | null }
  | { valid: true; kind: "handoff"; memberName: string }
  | { valid: true; kind: "recovery"; ownerName: string | null };

const LINK_KINDS: readonly ChallengeKind[] = ["invite", "handoff", "recovery"];
const CODE_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

function linkChallenge(store: TeamStore, code: unknown, nowMs: number): Challenge | null {
  if (typeof code !== "string" || !CODE_SHAPE.test(code)) return null;
  const challenge = store.challengeBySecret(sha256Hex(code));
  if (!challenge || !LINK_KINDS.includes(challenge.kind) || !challengeIsOpen(challenge, nowMs)) return null;
  return challenge;
}

export function previewJoin(store: TeamStore, code: unknown, nowMs = Date.now()): JoinPreview {
  const challenge = linkChallenge(store, code, nowMs);
  if (!challenge) return { valid: false };
  if (challenge.kind === "invite") {
    const inviter = challenge.createdBy ? store.member(challenge.createdBy) : null;
    return { valid: true, kind: "invite", inviterName: inviter?.name ?? null, invitedName: challenge.invitedName };
  }
  if (challenge.kind === "handoff") {
    const member = challenge.memberId ? store.member(challenge.memberId) : null;
    return member && member.status === "active" ? { valid: true, kind: "handoff", memberName: member.name } : { valid: false };
  }
  const owner = store.owner();
  return { valid: true, kind: "recovery", ownerName: owner?.status === "active" ? owner.name : null };
}

export function redeemJoin(store: TeamStore, code: unknown, nameInput: unknown, device: Device, nowMs = Date.now()): SignedIn {
  return store.transaction(() => {
    const challenge = linkChallenge(store, code, nowMs);
    if (!challenge) throw new TeamError("link_invalid", "this link was already used or has expired", 410);
    if (challenge.kind === "invite") {
      const name = requireName(nameInput ?? challenge.invitedName);
      if (!store.hasActiveOwner()) throw new TeamError("link_invalid", "this install has no team", 410);
      requireFreeName(store, name);
      if (!store.consumeChallenge(challenge.id, iso(nowMs))) throw new TeamError("link_invalid", "this link was already used", 410);
      const member: Member = {
        id: newMemberId(),
        name,
        role: "member",
        status: "active",
        color: nextMemberColor(store),
        telegram: null,
        createdAt: iso(nowMs),
        createdBy: challenge.createdBy ?? "invite",
        revokedAt: null,
      };
      store.insertMember(member);
      appendTeamEvent(store, {
        actor: { kind: "member", memberId: member.id },
        action: "member.joined",
        subject: { kind: "member", id: member.id, title: member.name },
        detail: { via: "invite", invite: challenge.id, invitedBy: challenge.createdBy },
      }, nowMs);
      return signIn(store, member, "invite", device, nowMs);
    }
    if (challenge.kind === "handoff") {
      const member = challenge.memberId ? store.member(challenge.memberId) : null;
      if (!member || member.status !== "active") throw new TeamError("link_invalid", "this link was already used or has expired", 410);
      if (!store.consumeChallenge(challenge.id, iso(nowMs))) throw new TeamError("link_invalid", "this link was already used", 410);
      return signIn(store, member, "handoff", device, nowMs);
    }
    /* Recovery: sign this browser in as the owner, or make it the owner. */
    if (!store.consumeChallenge(challenge.id, iso(nowMs))) throw new TeamError("link_invalid", "this link was already used", 410);
    const owner = store.owner();
    if (owner && owner.status === "active") return signIn(store, owner, "recovery", device, nowMs);
    const member: Member = {
      id: newMemberId(),
      name: requireFreeName(store, requireName(nameInput)),
      role: "owner",
      status: "active",
      color: nextMemberColor(store),
      telegram: null,
      createdAt: iso(nowMs),
      createdBy: "recovery",
      revokedAt: null,
    };
    store.insertMember(member);
    appendTeamEvent(store, { actor: { kind: "member", memberId: member.id }, action: "member.claimed", subject: { kind: "member", id: member.id, title: member.name }, detail: { via: "recovery" } }, nowMs);
    return signIn(store, member, "recovery", device, nowMs);
  });
}

export function createHandoff(store: TeamStore, member: Member, nowMs = Date.now()): { challenge: Challenge; code: string } {
  return issueChallenge(store, { kind: "handoff", ttlMs: HANDOFF_TTL_MS, memberId: member.id, createdBy: member.id }, nowMs);
}

export function createRecovery(store: TeamStore, nowMs = Date.now()): { challenge: Challenge; code: string } {
  return issueChallenge(store, { kind: "recovery", ttlMs: RECOVERY_TTL_MS }, nowMs);
}

/* ---- approve from another device ------------------------------------------ */

function newUserCode(): string {
  const bytes = crypto.randomBytes(6);
  return [...bytes].map((byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]).join("");
}

export function startApproval(store: TeamStore, requester: ChallengeRequester, nowMs = Date.now()): { challenge: Challenge; proof: string } {
  return store.transaction(() => {
    let userCode = newUserCode();
    for (let attempt = 0; store.challengeByUserCode(userCode) && attempt < 16; attempt += 1) userCode = newUserCode();
    const { challenge, code } = issueChallenge(store, { kind: "approval", ttlMs: APPROVAL_TTL_MS, userCode, requester }, nowMs);
    return { challenge, proof: code };
  });
}

const approvalGuesses = new Map<string, { count: number; since: number }>();

/** What a signed-in member typed: the request it names, for the "sign in this
    device as you?" step. Five wrong codes within ten minutes stop the member
    from asking again for the rest of that window. */
export function lookupApproval(store: TeamStore, approver: Member, codeInput: unknown, nowMs = Date.now()): Challenge {
  const guesses = approvalGuesses.get(approver.id);
  const current = guesses && nowMs - guesses.since < APPROVAL_GUESS_WINDOW_MS ? guesses : { count: 0, since: nowMs };
  if (current.count >= APPROVAL_GUESS_LIMIT) throw new TeamError("too_many_attempts", "too many wrong codes; wait ten minutes", 429);
  const code = normalizeUserCode(codeInput);
  const challenge = code ? store.challengeByUserCode(code) : null;
  if (!challengeIsOpen(challenge, nowMs) || challenge.result) {
    approvalGuesses.set(approver.id, { count: current.count + 1, since: current.since });
    throw new TeamError("code_wrong", "that code is not right", 404);
  }
  approvalGuesses.delete(approver.id);
  return challenge;
}

export function confirmApproval(store: TeamStore, approver: Member, id: string, approve: boolean, nowMs = Date.now()): void {
  store.transaction(() => {
    const challenge = store.challenge(id);
    if (!challenge || challenge.kind !== "approval" || !challengeIsOpen(challenge, nowMs) || challenge.result) {
      throw new TeamError("code_wrong", "that request has expired", 410);
    }
    challenge.result = approve ? { kind: "approved", memberId: approver.id } : { kind: "denied" };
    store.updateChallenge(challenge);
    if (approve) {
      appendTeamEvent(store, {
        actor: { kind: "member", memberId: approver.id },
        action: "device.approved",
        detail: { surface: challenge.requester?.surface ?? "other", browser: challenge.requester?.browser ?? "other" },
      }, nowMs);
    }
  });
}

export type ApprovalState =
  | { state: "waiting"; expiresAt: string }
  | { state: "approved"; name: string }
  | { state: "denied" }
  | { state: "expired" };

export function approvalState(store: TeamStore, challenge: Challenge, nowMs = Date.now()): ApprovalState {
  if (challenge.result?.kind === "denied") return { state: "denied" };
  if (challenge.consumedAt || Date.parse(challenge.expiresAt) <= nowMs) return { state: "expired" };
  if (challenge.result?.kind === "approved") {
    const member = store.member(challenge.result.memberId);
    return member && member.status === "active" ? { state: "approved", name: member.name } : { state: "expired" };
  }
  return { state: "waiting", expiresAt: challenge.expiresAt };
}

export function completeApproval(store: TeamStore, challenge: Challenge, device: Device, nowMs = Date.now()): SignedIn {
  return store.transaction(() => {
    const fresh = store.challenge(challenge.id);
    if (!fresh || fresh.result?.kind !== "approved" || !challengeIsOpen(fresh, nowMs)) {
      throw new TeamError("not_approved", "this device has not been approved", 409);
    }
    const member = store.member(fresh.result.memberId);
    if (!member || member.status !== "active") throw new TeamError("not_approved", "this device has not been approved", 409);
    if (!store.consumeChallenge(fresh.id, iso(nowMs))) throw new TeamError("not_approved", "already signed in", 409);
    return signIn(store, member, "approval", device, nowMs);
  });
}

/* ---- members -------------------------------------------------------------- */

export function renameMember(store: TeamStore, actor: Member, target: Member, nameInput: unknown, nowMs = Date.now()): Member {
  const name = requireName(nameInput);
  if (name === target.name) return target;
  const next = { ...target, name };
  store.transaction(() => {
    requireFreeName(store, name, target.id);
    store.updateMember(next);
    appendTeamEvent(store, {
      actor: { kind: "member", memberId: actor.id },
      action: "member.renamed",
      subject: { kind: "member", id: target.id, title: name },
      detail: { from: target.name, to: name },
    }, nowMs);
  });
  return next;
}

export function recolorMember(store: TeamStore, actor: Member, target: Member, color: unknown, nowMs = Date.now()): Member {
  if (!isMemberColor(color)) throw new TeamError("color_invalid", "that is not a member colour");
  if (color === target.color) return target;
  const next = { ...target, color };
  store.transaction(() => {
    store.updateMember(next);
    appendTeamEvent(store, { actor: { kind: "member", memberId: actor.id }, action: "member.recolored", subject: { kind: "member", id: target.id, title: target.name }, detail: { color } }, nowMs);
  });
  return next;
}

/** Revoking never deletes: past attribution stays correct. Every live
    session of the member, and every open code that would sign them in, ends
    in the same transaction. */
export function revokeMember(store: TeamStore, owner: Member, target: Member, nowMs = Date.now()): Member {
  if (target.role === "owner") throw new TeamError("owner_protected", "the owner cannot be revoked", 409);
  if (target.status === "revoked") return target;
  const next: Member = { ...target, status: "revoked", revokedAt: iso(nowMs) };
  store.transaction(() => {
    store.updateMember(next);
    const ended = store.revokeSessionsOf(target.id, iso(nowMs));
    /* A hand-off or approval issued before the revocation must not sign them
       in after a restore: restoring gives back the membership, not the links. */
    store.consumeChallengesOf(target.id, iso(nowMs));
    appendTeamEvent(store, { actor: { kind: "member", memberId: owner.id }, action: "member.revoked", subject: { kind: "member", id: target.id, title: target.name }, detail: { sessions: ended.length } }, nowMs);
  });
  return next;
}

export function restoreMember(store: TeamStore, owner: Member, target: Member, nowMs = Date.now()): Member {
  if (target.status === "active") return target;
  const next: Member = { ...target, status: "active", revokedAt: null };
  store.transaction(() => {
    store.updateMember(next);
    appendTeamEvent(store, { actor: { kind: "member", memberId: owner.id }, action: "member.restored", subject: { kind: "member", id: target.id, title: target.name } }, nowMs);
  });
  return next;
}

/* ---- sessions ------------------------------------------------------------- */

export function signOutSession(store: TeamStore, actor: Member, session: MemberSession, nowMs = Date.now(), own = true): void {
  store.transaction(() => {
    if (!store.revokeSession(session.id, iso(nowMs))) return;
    appendTeamEvent(store, {
      actor: { kind: "member", memberId: actor.id },
      action: own && session.memberId === actor.id ? "session.signed_out" : "session.revoked",
      subject: { kind: "session", id: session.id.slice(0, 12), title: null },
      detail: { member: session.memberId, surface: session.surface, browser: session.browser },
    }, nowMs);
  });
}

/* ---- the caller's view ---------------------------------------------------- */

const ONLINE_MS = 2 * 60_000;

export function onlineWithin(lastSeenAt: string | null, nowMs: number): boolean {
  return lastSeenAt !== null && nowMs - Date.parse(lastSeenAt) < ONLINE_MS;
}

export function teamView(store: TeamStore, me: Member | null, methods: TeamView["methods"], nowMs = Date.now()): TeamView {
  const passkeys = store.passkeyCounts();
  /* Ended sessions count too: "seen 2 h ago" is about the person, and a
     member who signed out was still here then. */
  const sessions = store.sessionsFor(null);
  const newest = new Map<string, MemberSession>();
  for (const session of sessions) {
    const held = newest.get(session.memberId);
    if (!held || held.lastSeenAt < session.lastSeenAt) newest.set(session.memberId, session);
  }
  return {
    mode: store.hasActiveOwner() ? "team" : "solo",
    me: me ? { ...memberSummary(me), telegram: me.telegram } : null,
    members: store.members().map((member) => {
      const last = newest.get(member.id) ?? null;
      return {
        ...memberSummary(member),
        telegram: member.telegram ? { username: member.telegram.username, firstName: member.telegram.firstName } : null,
        passkeys: passkeys.get(member.id) ?? 0,
        lastSeenAt: last?.lastSeenAt ?? null,
        lastSurface: last?.surface ?? null,
        online: sessions.some((session) => session.memberId === member.id && !session.revokedAt && onlineWithin(session.lastSeenAt, nowMs)),
        createdAt: member.createdAt,
        revokedAt: member.revokedAt,
      };
    }),
    methods,
  };
}
