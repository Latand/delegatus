/*
 * The team module's vocabulary (docs/design/sign-in-and-team.md §3).
 *
 * Client-safe: no Node imports, so the browser, the proxy and the routes share
 * these types and the pure helpers below. Everything that reads or writes state
 * lives beside this file under `src/lib/team/`, and the rest of the product
 * reaches it through `src/lib/team/index.ts` only (§11, the seam).
 */

export const MEMBER_COLORS = ["coral", "amber", "lime", "teal", "sky", "violet", "pink", "slate"] as const;
export type MemberColor = (typeof MEMBER_COLORS)[number];

export type MemberRole = "owner" | "member";
export type MemberStatus = "active" | "revoked";

export interface MemberTelegram {
  userId: string;
  username: string | null;
  firstName: string | null;
  linkedAt: string;
}

export interface Member {
  /** "m_" + 16 random bytes, hex. Never reused. */
  id: string;
  /** 1–60 characters: what the chat shows. Renamable. */
  name: string;
  role: MemberRole;
  status: MemberStatus;
  color: MemberColor;
  telegram: MemberTelegram | null;
  createdAt: string;
  /** How the member came to exist: the inviting member's id, or a method. */
  createdBy: string;
  revokedAt: string | null;
}

export type SignInMethod = "claim" | "invite" | "approval" | "telegram" | "passkey" | "handoff" | "recovery";
export const SIGN_IN_METHODS: readonly SignInMethod[] = ["claim", "invite", "approval", "telegram", "passkey", "handoff", "recovery"];

export type SessionSurface = "desktop" | "phone" | "tablet" | "other";
export type SessionBrowser = "chrome" | "safari" | "firefox" | "edge" | "other";

export interface MemberSession {
  /** sha256 hex of the cookie value; the value itself is never stored. */
  id: string;
  memberId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  surface: SessionSurface;
  browser: SessionBrowser;
  method: SignInMethod;
  revokedAt: string | null;
}

/** Who did something. `operator` is the unnamed local human of a solo
    install, exactly today's single principal; `anonymous` is a human request
    in team mode without a live session, refused wherever a human acts. */
export type TeamActor =
  | { kind: "member"; memberId: string }
  | { kind: "agent"; conversationId: string }
  | { kind: "service"; service: string }
  | { kind: "operator" }
  | { kind: "anonymous" };

export type TeamMode = "solo" | "team";

export const TEAM_EVENT_ACTIONS = [
  "message.sent", "question.answered",
  "agent.started",
  "task.created", "task.changed",
  "member.claimed", "member.invited", "member.joined", "member.renamed", "member.recolored", "member.revoked", "member.restored",
  "join.requested", "join.approved", "join.denied",
  "session.signed_in", "session.signed_out", "session.revoked", "device.approved",
  "passkey.added", "passkey.removed",
  "telegram.linked", "telegram.unlinked",
] as const;
export type TeamEventAction = (typeof TEAM_EVENT_ACTIONS)[number];

export type TeamEventSubject = {
  kind: "conversation" | "task" | "member" | "session" | "passkey";
  id: string;
  /** Bounded to 120 characters; never message text. */
  title: string | null;
};

export type TeamEventDetail = Record<string, string | number | boolean | null>;

export interface TeamEvent {
  /** `<unix ms, 13 digits>-<8 random hex>`: sorts by time. */
  id: string;
  at: string;
  actor: TeamActor;
  action: TeamEventAction;
  project: string | null;
  subject: TeamEventSubject | null;
  detail: TeamEventDetail | null;
}

/** What a browser is told about a member: enough to draw a name and an avatar. */
export interface MemberSummary {
  id: string;
  name: string;
  color: MemberColor;
  initials: string;
  role: MemberRole;
  status: MemberStatus;
}

/** The sender line above a human message in the chat (§6.7). */
export interface MessageSender {
  memberId: string;
  name: string;
  color: MemberColor;
  initials: string;
}

/** The public face of an install, answered to anyone past the perimeter. */
export interface TeamPublicInfo {
  mode: TeamMode;
  hostName: string;
  methods: {
    approval: boolean;
    telegram: { available: boolean; botUsername: string | null };
    passkey: { available: boolean };
  };
}

/** `GET /api/team`: the caller's view of the team. */
export interface TeamView {
  mode: TeamMode;
  me: (MemberSummary & { telegram: MemberTelegram | null }) | null;
  members: Array<MemberSummary & {
    telegram: { username: string | null; firstName: string | null } | null;
    passkeys: number;
    lastSeenAt: string | null;
    lastSurface: SessionSurface | null;
    /** A live session was used in the last two minutes. */
    online: boolean;
    createdAt: string;
    revokedAt: string | null;
  }>;
  methods: TeamPublicInfo["methods"];
}

export const MEMBER_REQUIRED_CODE = "member_required";

/* ---- the seam ------------------------------------------------------------- */

type RequestHeaders = { headers: Headers; cookies: { get(name: string): { value: string } | undefined } };

export interface SubjectAuthorshipView {
  startedBy: MessageSender | null;
  changedBy: MessageSender | null;
  changedAt: string | null;
}

/** What the delivery record knows about a submission id before the send. */
export type PriorSubmission = "admitted" | "unknown" | "not-executed";

/** A member's claim to a message they are about to send (§7.1). */
export interface MessageAuthorClaim {
  actor: Extract<TeamActor, { kind: "member" }>;
  clientMessageId: string;
  conversationId: string;
  text: string;
  path: string | null;
}

/** Everything the rest of the product asks of the team module (§11.1). */
export interface TeamModule {
  teamMode(): TeamMode;
  teamActor(req: RequestHeaders): TeamActor;
  /** The 401 a human write gets in team mode without a session, or null. */
  refuseAnonymous(actor: TeamActor): Response | null;
  recordTeamEvent(input: {
    actor: TeamActor;
    action: TeamEventAction;
    project?: string | null;
    subject?: TeamEventSubject | null;
    detail?: TeamEventDetail | null;
  }): void;
  recordMessageAuthor(input: { actor: TeamActor; clientMessageId: string; conversationId: string | null; text: string }): void;
  /** Taken before a send, for a submission id nothing knows yet; null when it may not be claimed. */
  claimMessageAuthor(input: {
    actor: TeamActor;
    clientMessageId: string;
    conversationId: string | null;
    text: string;
    path?: string | null;
    priorSubmission: () => PriorSubmission;
  }): MessageAuthorClaim | null;
  /** Records a claim once the host admitted the submission. */
  settleMessageAuthor(claim: MessageAuthorClaim | null): void;
  messageSenders(clientMessageIds: readonly string[], inConversation?: (conversationId: string) => boolean): Record<string, MessageSender>;
  subjectAuthorship(subjectIds: readonly string[]): Record<string, SubjectAuthorshipView>;
  teamTelegramHook(input: { from: { id: number; first_name?: string; username?: string; is_bot?: boolean } | undefined; chatType: string; text: string | undefined }): string | null;
}

/** The module as an install without it answers: always solo, nobody named. */
export const nullTeam: TeamModule = {
  teamMode: () => "solo",
  teamActor: () => ({ kind: "operator" }),
  refuseAnonymous: () => null,
  recordTeamEvent: () => {},
  recordMessageAuthor: () => {},
  claimMessageAuthor: () => null,
  settleMessageAuthor: () => {},
  messageSenders: () => ({}),
  subjectAuthorship: () => ({}),
  teamTelegramHook: () => null,
};

/* ---- pure helpers --------------------------------------------------------- */

export function isMemberColor(value: unknown): value is MemberColor {
  return typeof value === "string" && (MEMBER_COLORS as readonly string[]).includes(value);
}

/** One or two letters from a name: the first letters of its first two words,
    or its first two characters. Grapheme-safe for Cyrillic and emoji alike. */
export function memberInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = (word: string) => [...word];
  if (words.length >= 2) return (letters(words[0])[0] + letters(words[1])[0]).toUpperCase();
  const only = letters(words[0] ?? "");
  return only.slice(0, only.length > 1 && /\p{L}/u.test(only[1]) ? 2 : 1).join("").toUpperCase() || "?";
}

/** A name as stored: collapsed whitespace, 1–60 characters, no control bytes. */
export function cleanMemberName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return null;
  return [...name].slice(0, 60).join("");
}

/** The first word of a name, for tight places (a card's meta row). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** The approval code shown on a new device: six characters from an alphabet
    with no look-alikes, drawn as `KJ7-4MP`. */
export const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function formatUserCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

/** What a person typed back: case and separators do not matter. */
export function normalizeUserCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) return null;
  for (const char of code) if (!USER_CODE_ALPHABET.includes(char)) return null;
  return code;
}

/** The ink drawn on a member colour: whichever of the two reads better on it
    (≥ 3.9:1 on all eight, pinned in `contract.test.ts`). */
export const MEMBER_COLOR_HEX: Record<MemberColor, string> = {
  coral: "#e07a5f",
  amber: "#d9a400",
  lime: "#7cb342",
  teal: "#1a9e8f",
  sky: "#3d7fd6",
  violet: "#8a63d2",
  pink: "#d64f8a",
  slate: "#7b8a99",
};
export const MEMBER_INK_DARK = "#1f2328";
export const MEMBER_INK_LIGHT = "#ffffff";
export const MEMBER_COLOR_INK: Record<MemberColor, string> = {
  coral: MEMBER_INK_DARK,
  amber: MEMBER_INK_DARK,
  lime: MEMBER_INK_DARK,
  teal: MEMBER_INK_DARK,
  sky: MEMBER_INK_LIGHT,
  violet: MEMBER_INK_LIGHT,
  pink: MEMBER_INK_DARK,
  slate: MEMBER_INK_DARK,
};

/** A same-origin path to return to after signing in; anything else is `/`. */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (value.startsWith("/sign-in") || value.startsWith("/join/")) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) return "/";
  return value.slice(0, 2048);
}
