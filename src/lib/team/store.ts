import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { openCurrentDatabase } from "@/lib/state/currentDatabase";

import {
  isMemberColor,
  SIGN_IN_METHODS,
  TEAM_EVENT_ACTIONS,
  type Member,
  type MemberSession,
  type SessionBrowser,
  type SessionSurface,
  type SignInMethod,
  type TeamActor,
  type TeamEvent,
  type TeamEventAction,
  type TeamEventDetail,
  type TeamEventSubject,
} from "./contract";

/*
 * The team's own record (docs/design/sign-in-and-team.md §3.5, as built):
 * one SQLite file, `<state>/team/team.sqlite`, 0600, beside the Telegram bot's
 * `telegram/bot.sqlite` and opened the same way.
 *
 * Nothing secret is stored. A session row is keyed by the sha256 of its cookie
 * value; a link code by the sha256 of the code; a passkey holds its public key.
 *
 * The file's absence IS solo mode: a request on an install that never set up a
 * team costs one `stat` and creates nothing (#1905: a build, a test or a route
 * import must not create state). The file is created by the first write that
 * needs it, which is claiming the install.
 */

const SCHEMA_VERSION = 1;
export const SESSION_IDLE_MS = 30 * 24 * 3_600_000;
export const SESSION_ABSOLUTE_MS = 180 * 24 * 3_600_000;
export const EVENT_RETENTION_MS = 90 * 24 * 3_600_000;
export const EVENT_MAX_ROWS = 20_000;
const PRUNE_SESSIONS_AFTER_MS = 30 * 24 * 3_600_000;
const PRUNE_CHALLENGES_AFTER_MS = 24 * 3_600_000;
const MESSAGE_AUTHOR_RETENTION_MS = 365 * 24 * 3_600_000;

export type ChallengeKind = "invite" | "approval" | "telegram" | "handoff" | "passkey" | "recovery";

export type ChallengeResult =
  | { kind: "telegram"; telegramUserId: string; firstName: string | null; username: string | null; memberId: string | null }
  | { kind: "approved"; memberId: string }
  | { kind: "denied" };

export interface ChallengeRequester {
  surface: SessionSurface;
  browser: SessionBrowser;
}

export interface Challenge {
  id: string;
  kind: ChallengeKind;
  secretHash: string;
  userCode: string | null;
  memberId: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  attempts: number;
  invitedName: string | null;
  result: ChallengeResult | null;
  requester: ChallengeRequester | null;
  /** Kind-specific extras: the WebAuthn challenge and its purpose, the
      purpose of a Telegram link. Never a secret. */
  payload: Record<string, string> | null;
}

export interface StoredPasskey {
  id: string;
  memberId: string;
  rpId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface MessageAuthorRow {
  clientMessageId: string;
  conversationId: string | null;
  memberId: string;
  at: string;
  textDigest: string | null;
}

type Db = import("bun:sqlite").Database;
type Row = Record<string, string | number | null>;

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function memberFrom(row: Row): Member {
  const color = isMemberColor(row.color) ? row.color : "slate";
  const telegramUserId = str(row.telegram_user_id);
  return {
    id: String(row.id),
    name: String(row.name),
    role: row.role === "owner" ? "owner" : "member",
    status: row.status === "revoked" ? "revoked" : "active",
    color,
    telegram: telegramUserId ? {
      userId: telegramUserId,
      username: str(row.telegram_username),
      firstName: str(row.telegram_first_name),
      linkedAt: str(row.telegram_linked_at) ?? String(row.created_at),
    } : null,
    createdAt: String(row.created_at),
    createdBy: String(row.created_by),
    revokedAt: str(row.revoked_at),
  };
}

function sessionFrom(row: Row): MemberSession {
  const method = SIGN_IN_METHODS.includes(row.method as SignInMethod) ? row.method as SignInMethod : "invite";
  return {
    id: String(row.id),
    memberId: String(row.member_id),
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
    expiresAt: String(row.expires_at),
    surface: (["desktop", "phone", "tablet", "other"].includes(String(row.surface)) ? row.surface : "other") as SessionSurface,
    browser: (["chrome", "safari", "firefox", "edge", "other"].includes(String(row.browser)) ? row.browser : "other") as SessionBrowser,
    method,
    revokedAt: str(row.revoked_at),
  };
}

function challengeFrom(row: Row): Challenge {
  return {
    id: String(row.id),
    kind: row.kind as ChallengeKind,
    secretHash: String(row.secret_hash),
    userCode: str(row.user_code),
    memberId: str(row.member_id),
    createdBy: str(row.created_by),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    consumedAt: str(row.consumed_at),
    attempts: Number(row.attempts ?? 0),
    invitedName: str(row.invited_name),
    result: parseJson<ChallengeResult>(row.result_json),
    requester: parseJson<ChallengeRequester>(row.requester_json),
    payload: parseJson<Record<string, string>>(row.payload_json),
  };
}

function passkeyFrom(row: Row): StoredPasskey {
  return {
    id: String(row.id),
    memberId: String(row.member_id),
    rpId: String(row.rp_id),
    publicKey: String(row.public_key),
    counter: Number(row.counter ?? 0),
    transports: parseJson<string[]>(row.transports_json) ?? [],
    deviceType: String(row.device_type ?? "singleDevice"),
    backedUp: Number(row.backed_up ?? 0) === 1,
    label: String(row.label ?? ""),
    createdAt: String(row.created_at),
    lastUsedAt: str(row.last_used_at),
  };
}

function eventFrom(row: Row): TeamEvent | null {
  const actor = parseJson<TeamActor>(row.actor_json);
  const action = row.action as TeamEventAction;
  if (!actor || !(TEAM_EVENT_ACTIONS as readonly string[]).includes(action)) return null;
  const subjectKind = str(row.subject_kind);
  const subject: TeamEventSubject | null = subjectKind && row.subject_id !== null
    ? { kind: subjectKind as TeamEventSubject["kind"], id: String(row.subject_id), title: str(row.subject_title) }
    : null;
  return {
    id: String(row.id),
    at: String(row.at),
    actor,
    action,
    project: str(row.project),
    subject,
    detail: parseJson<TeamEventDetail>(row.detail_json),
  };
}

export interface EventQuery {
  before?: string | null;
  memberId?: string | null;
  project?: string | null;
  subjectId?: string | null;
  actions?: readonly TeamEventAction[] | null;
  limit: number;
}

export class TeamStore {
  private readonly db: Db;

  constructor(readonly filename: string) {
    const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
    if (!sqlite) throw new Error("the team store requires the Bun runtime");
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    /* Created owner-only BEFORE SQLite opens it; the -wal and -shm files take
       the database file's mode. */
    fs.closeSync(fs.openSync(filename, "a", 0o600));
    fs.chmodSync(filename, 0o600);
    this.db = openCurrentDatabase(filename, () => {
      const db = new sqlite.Database(filename, { create: true, strict: true });
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS members (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          status TEXT NOT NULL,
          color TEXT NOT NULL,
          telegram_user_id TEXT UNIQUE,
          telegram_username TEXT,
          telegram_first_name TEXT,
          telegram_linked_at TEXT,
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          member_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          surface TEXT NOT NULL,
          browser TEXT NOT NULL,
          method TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS sessions_member ON sessions(member_id);
        CREATE TABLE IF NOT EXISTS challenges (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          secret_hash TEXT NOT NULL UNIQUE,
          user_code TEXT,
          member_id TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          invited_name TEXT,
          result_json TEXT,
          requester_json TEXT,
          payload_json TEXT
        );
        CREATE INDEX IF NOT EXISTS challenges_user_code ON challenges(user_code);
        CREATE TABLE IF NOT EXISTS passkeys (
          id TEXT PRIMARY KEY,
          member_id TEXT NOT NULL,
          rp_id TEXT NOT NULL,
          public_key TEXT NOT NULL,
          counter INTEGER NOT NULL DEFAULT 0,
          transports_json TEXT NOT NULL DEFAULT '[]',
          device_type TEXT NOT NULL,
          backed_up INTEGER NOT NULL DEFAULT 0,
          label TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_used_at TEXT
        );
        CREATE INDEX IF NOT EXISTS passkeys_member ON passkeys(member_id);
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          at TEXT NOT NULL,
          actor_json TEXT NOT NULL,
          actor_member_id TEXT,
          action TEXT NOT NULL,
          project TEXT,
          subject_kind TEXT,
          subject_id TEXT,
          subject_title TEXT,
          detail_json TEXT
        );
        CREATE INDEX IF NOT EXISTS events_member ON events(actor_member_id, id);
        CREATE INDEX IF NOT EXISTS events_subject ON events(subject_id, id);
        CREATE INDEX IF NOT EXISTS events_project ON events(project, id);
        CREATE TABLE IF NOT EXISTS message_authors (
          client_message_id TEXT PRIMARY KEY,
          conversation_id TEXT,
          member_id TEXT NOT NULL,
          at TEXT NOT NULL,
          text_digest TEXT
        );
        CREATE INDEX IF NOT EXISTS message_authors_conversation ON message_authors(conversation_id, at);
      `);
      const version = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema'").get();
      if (!version) db.query("INSERT INTO meta(key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
      else if (Number(version.value) > SCHEMA_VERSION) {
        db.close();
        throw new Error(`the team store was written by a newer release (schema ${version.value})`);
      }
      return db;
    });
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }

  transaction<R>(operation: () => R): R {
    return this.db.transaction(operation).immediate();
  }

  /* ---- members ---------------------------------------------------------- */

  hasActiveOwner(): boolean {
    return this.db.query<{ one: number }, []>("SELECT 1 AS one FROM members WHERE role = 'owner' AND status = 'active' LIMIT 1").get() !== null;
  }

  owner(): Member | null {
    const row = this.db.query<Row, []>("SELECT * FROM members WHERE role = 'owner' ORDER BY created_at LIMIT 1").get();
    return row ? memberFrom(row) : null;
  }

  member(id: string): Member | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM members WHERE id = ?").get(id);
    return row ? memberFrom(row) : null;
  }

  memberByTelegram(userId: string): Member | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM members WHERE telegram_user_id = ?").get(userId);
    return row ? memberFrom(row) : null;
  }

  members(): Member[] {
    return this.db.query<Row, []>("SELECT * FROM members ORDER BY created_at, id").all().map(memberFrom);
  }

  insertMember(member: Member): void {
    this.db.query(`INSERT INTO members(id, name, role, status, color, telegram_user_id, telegram_username, telegram_first_name,
      telegram_linked_at, created_at, created_by, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      member.id, member.name, member.role, member.status, member.color,
      member.telegram?.userId ?? null, member.telegram?.username ?? null, member.telegram?.firstName ?? null, member.telegram?.linkedAt ?? null,
      member.createdAt, member.createdBy, member.revokedAt,
    );
  }

  updateMember(member: Member): void {
    this.db.query(`UPDATE members SET name = ?, role = ?, status = ?, color = ?, telegram_user_id = ?, telegram_username = ?,
      telegram_first_name = ?, telegram_linked_at = ?, revoked_at = ? WHERE id = ?`).run(
      member.name, member.role, member.status, member.color,
      member.telegram?.userId ?? null, member.telegram?.username ?? null, member.telegram?.firstName ?? null, member.telegram?.linkedAt ?? null,
      member.revokedAt, member.id,
    );
  }

  /* ---- sessions --------------------------------------------------------- */

  insertSession(session: MemberSession): void {
    this.db.query(`INSERT INTO sessions(id, member_id, created_at, last_seen_at, expires_at, surface, browser, method, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      session.id, session.memberId, session.createdAt, session.lastSeenAt, session.expiresAt,
      session.surface, session.browser, session.method, session.revokedAt,
    );
  }

  session(id: string): MemberSession | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? sessionFrom(row) : null;
  }

  sessionsFor(memberId: string | null): MemberSession[] {
    const rows = memberId
      ? this.db.query<Row, [string]>("SELECT * FROM sessions WHERE member_id = ? ORDER BY last_seen_at DESC").all(memberId)
      : this.db.query<Row, []>("SELECT * FROM sessions ORDER BY last_seen_at DESC").all();
    return rows.map(sessionFrom);
  }

  touchSession(id: string, at: string): void {
    this.db.query("UPDATE sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id);
  }

  revokeSession(id: string, at: string): boolean {
    return this.db.query("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id).changes > 0;
  }

  revokeSessionsOf(memberId: string, at: string, exceptId: string | null = null): string[] {
    const ids = this.db.query<{ id: string }, [string, string]>(
      "SELECT id FROM sessions WHERE member_id = ? AND revoked_at IS NULL AND id != ?",
    ).all(memberId, exceptId ?? "").map((row) => row.id);
    for (const id of ids) this.revokeSession(id, at);
    return ids;
  }

  revokeAllSessions(at: string): number {
    return this.db.query("UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL").run(at).changes;
  }

  pruneSessions(nowMs: number): void {
    const cutoff = new Date(nowMs - PRUNE_SESSIONS_AFTER_MS).toISOString();
    this.db.query("DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR expires_at < ? OR last_seen_at < ?")
      .run(cutoff, cutoff, new Date(nowMs - SESSION_IDLE_MS - PRUNE_SESSIONS_AFTER_MS).toISOString());
  }

  /* ---- challenges ------------------------------------------------------- */

  insertChallenge(challenge: Challenge): void {
    this.db.query(`INSERT INTO challenges(id, kind, secret_hash, user_code, member_id, created_by, created_at, expires_at, consumed_at,
      attempts, invited_name, result_json, requester_json, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      challenge.id, challenge.kind, challenge.secretHash, challenge.userCode, challenge.memberId, challenge.createdBy,
      challenge.createdAt, challenge.expiresAt, challenge.consumedAt, challenge.attempts, challenge.invitedName,
      challenge.result ? JSON.stringify(challenge.result) : null,
      challenge.requester ? JSON.stringify(challenge.requester) : null,
      challenge.payload ? JSON.stringify(challenge.payload) : null,
    );
  }

  challenge(id: string): Challenge | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM challenges WHERE id = ?").get(id);
    return row ? challengeFrom(row) : null;
  }

  challengeBySecret(secretHash: string): Challenge | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM challenges WHERE secret_hash = ?").get(secretHash);
    return row ? challengeFrom(row) : null;
  }

  challengeByUserCode(code: string): Challenge | null {
    const row = this.db.query<Row, [string]>(
      "SELECT * FROM challenges WHERE user_code = ? AND kind = 'approval' AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1",
    ).get(code);
    return row ? challengeFrom(row) : null;
  }

  openChallenges(kind: ChallengeKind, nowIso: string): Challenge[] {
    return this.db.query<Row, [string, string]>(
      "SELECT * FROM challenges WHERE kind = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
    ).all(kind, nowIso).map(challengeFrom);
  }

  updateChallenge(challenge: Challenge): void {
    this.db.query(`UPDATE challenges SET member_id = ?, expires_at = ?, consumed_at = ?, attempts = ?, result_json = ?,
      requester_json = ?, payload_json = ? WHERE id = ?`).run(
      challenge.memberId, challenge.expiresAt, challenge.consumedAt, challenge.attempts,
      challenge.result ? JSON.stringify(challenge.result) : null,
      challenge.requester ? JSON.stringify(challenge.requester) : null,
      challenge.payload ? JSON.stringify(challenge.payload) : null,
      challenge.id,
    );
  }

  /** Marks a challenge consumed only if nobody did first: the single-use
      guarantee, one conditional UPDATE inside the caller's transaction. */
  consumeChallenge(id: string, at: string): boolean {
    return this.db.query("UPDATE challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(at, id).changes === 1;
  }

  pruneChallenges(nowMs: number): void {
    this.db.query("DELETE FROM challenges WHERE expires_at < ?").run(new Date(nowMs - PRUNE_CHALLENGES_AFTER_MS).toISOString());
  }

  /* ---- passkeys --------------------------------------------------------- */

  insertPasskey(passkey: StoredPasskey): void {
    this.db.query(`INSERT INTO passkeys(id, member_id, rp_id, public_key, counter, transports_json, device_type, backed_up, label,
      created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      passkey.id, passkey.memberId, passkey.rpId, passkey.publicKey, passkey.counter, JSON.stringify(passkey.transports),
      passkey.deviceType, passkey.backedUp ? 1 : 0, passkey.label, passkey.createdAt, passkey.lastUsedAt,
    );
  }

  passkey(id: string): StoredPasskey | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM passkeys WHERE id = ?").get(id);
    return row ? passkeyFrom(row) : null;
  }

  passkeysFor(memberId: string): StoredPasskey[] {
    return this.db.query<Row, [string]>("SELECT * FROM passkeys WHERE member_id = ? ORDER BY created_at").all(memberId).map(passkeyFrom);
  }

  passkeyCounts(): Map<string, number> {
    return new Map(this.db.query<{ member_id: string; n: number }, []>("SELECT member_id, COUNT(*) AS n FROM passkeys GROUP BY member_id").all()
      .map((row) => [row.member_id, row.n] as const));
  }

  usePasskey(id: string, counter: number, at: string): void {
    this.db.query("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(counter, at, id);
  }

  deletePasskey(id: string): boolean {
    return this.db.query("DELETE FROM passkeys WHERE id = ?").run(id).changes > 0;
  }

  /* ---- events ----------------------------------------------------------- */

  insertEvent(event: TeamEvent): void {
    this.db.query(`INSERT OR IGNORE INTO events(id, at, actor_json, actor_member_id, action, project, subject_kind, subject_id,
      subject_title, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.id, event.at, JSON.stringify(event.actor), event.actor.kind === "member" ? event.actor.memberId : null,
      event.action, event.project, event.subject?.kind ?? null, event.subject?.id ?? null, event.subject?.title ?? null,
      event.detail ? JSON.stringify(event.detail) : null,
    );
  }

  events(query: EventQuery): TeamEvent[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (query.before) { where.push("id < ?"); params.push(query.before); }
    if (query.memberId) { where.push("actor_member_id = ?"); params.push(query.memberId); }
    if (query.project) { where.push("project = ?"); params.push(query.project); }
    if (query.subjectId) { where.push("subject_id = ?"); params.push(query.subjectId); }
    if (query.actions?.length) {
      where.push(`action IN (${query.actions.map(() => "?").join(", ")})`);
      params.push(...query.actions);
    }
    params.push(query.limit);
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    return this.db.query<Row, Array<string | number>>(sql).all(...params).flatMap((row) => {
      const event = eventFrom(row);
      return event ? [event] : [];
    });
  }

  eventProjects(): string[] {
    return this.db.query<{ project: string }, []>("SELECT DISTINCT project FROM events WHERE project IS NOT NULL ORDER BY project")
      .all().map((row) => row.project);
  }

  pruneEvents(nowMs: number): void {
    this.db.query("DELETE FROM events WHERE at < ?").run(new Date(nowMs - EVENT_RETENTION_MS).toISOString());
    this.db.query(`DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id DESC LIMIT -1 OFFSET ?)`).run(EVENT_MAX_ROWS);
    this.db.query("DELETE FROM message_authors WHERE at < ?").run(new Date(nowMs - MESSAGE_AUTHOR_RETENTION_MS).toISOString());
  }

  /* ---- message authors -------------------------------------------------- */

  recordMessageAuthor(row: MessageAuthorRow): void {
    /* A retried send reuses its client message id; the first author stands. */
    this.db.query(`INSERT OR IGNORE INTO message_authors(client_message_id, conversation_id, member_id, at, text_digest)
      VALUES (?, ?, ?, ?, ?)`).run(row.clientMessageId, row.conversationId, row.memberId, row.at, row.textDigest);
  }

  messageAuthors(clientMessageIds: readonly string[]): Map<string, string> {
    const result = new Map<string, string>();
    for (let offset = 0; offset < clientMessageIds.length; offset += 400) {
      const batch = clientMessageIds.slice(offset, offset + 400);
      if (!batch.length) continue;
      const rows = this.db.query<{ client_message_id: string; member_id: string }, string[]>(
        `SELECT client_message_id, member_id FROM message_authors WHERE client_message_id IN (${batch.map(() => "?").join(", ")})`,
      ).all(...batch);
      for (const row of rows) result.set(row.client_message_id, row.member_id);
    }
    return result;
  }

  messageAuthorsForConversation(conversationId: string): MessageAuthorRow[] {
    return this.db.query<Row, [string]>(
      "SELECT * FROM message_authors WHERE conversation_id = ? ORDER BY at",
    ).all(conversationId).map((row) => ({
      clientMessageId: String(row.client_message_id),
      conversationId: str(row.conversation_id),
      memberId: String(row.member_id),
      at: String(row.at),
      textDigest: str(row.text_digest),
    }));
  }
}

/* ---- the process's handle ------------------------------------------------- */

const host = globalThis as typeof globalThis & { __llvTeamStore?: { filename: string; store: TeamStore } };

export function teamStoreFile(): string {
  return statePath("team", "team.sqlite");
}

/** The store if this install has one, else null — solo mode. Never creates
    the file. */
export function existingTeamStore(): TeamStore | null {
  const filename = teamStoreFile();
  const cached = host.__llvTeamStore;
  if (cached && cached.filename === filename) {
    if (fs.existsSync(filename)) return cached.store;
    cached.store.close();
    delete host.__llvTeamStore;
    return null;
  }
  if (!fs.existsSync(filename)) return null;
  const store = new TeamStore(filename);
  host.__llvTeamStore = { filename, store };
  return store;
}

/** The store, created on first use. Only a write that sets up a team calls it. */
export function teamStore(): TeamStore {
  const existing = existingTeamStore();
  if (existing) return existing;
  const filename = teamStoreFile();
  const store = new TeamStore(filename);
  host.__llvTeamStore = { filename, store };
  return store;
}

/** Tests only: forget the cached handle so a new state directory is read. */
export function resetTeamStoreForTests(): void {
  host.__llvTeamStore?.store.close();
  delete host.__llvTeamStore;
}
