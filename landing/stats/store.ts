import { DAY, utcDay, type InstallPing, type SiteEvent } from "./metrics";
import { historyConfigured, readHistoryDay, type HistoryEnv, type QueryResult } from "./history";
import { base64url, bytes, ceremony, hex, makeChallenge, publicKey, randomBytes, sha256, utf8, verifyAssertion } from "./webauthn";

export interface StatsSettings extends HistoryEnv {
  STATS_ORIGIN: string;
  STATS_RP_ID: string;
  STATS_ENROLLMENT?: string;
  STATS_VERSION?: { id: string };
}

type SqlValue = string | number | null | ArrayBuffer;
export interface StatsStorage {
  exec(sql: string, ...params: SqlValue[]): { toArray(): object[] };
  transactionSync<T>(action: () => T): T;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}

const schema = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS install_days (day TEXT NOT NULL, id TEXT NOT NULL, v TEXT NOT NULL,
  os TEXT NOT NULL, arch TEXT NOT NULL, kind TEXT NOT NULL, country TEXT NOT NULL,
  last_at INTEGER NOT NULL, PRIMARY KEY (day, id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS install_days_id ON install_days (id, day);
CREATE TABLE IF NOT EXISTS site_event_days (day TEXT NOT NULL, event TEXT NOT NULL, agent TEXT NOT NULL,
  lang TEXT NOT NULL, country TEXT NOT NULL, total REAL NOT NULL,
  PRIMARY KEY (day, event, agent, lang, country)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS swarm_usage_days (day TEXT NOT NULL, rule TEXT NOT NULL,
  reports INTEGER NOT NULL, delivered INTEGER NOT NULL, applied INTEGER NOT NULL,
  misled INTEGER NOT NULL, misled_reports INTEGER NOT NULL, PRIMARY KEY (day, rule)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, public_key BLOB NOT NULL, alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, credential_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS used_enrollments (hash TEXT PRIMARY KEY, used_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS used_challenges (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS imported_days (day TEXT PRIMARY KEY, imported_at INTEGER NOT NULL);
`;

export const SESSION_SECONDS = 90 * DAY / 1000;
const KEEP_DAYS = 92;
const importErrors = ["http", "network", "shape", "limit"];
type Credential = { public_key: ArrayBuffer; alg: number; sign_count: number };
type Access = { currentCredentialId: string; passkeys: { id: string; created_at: number; last_used_at: number | null }[]; importStatus: string };
export type Snapshot = { now: number; days: string[]; results: QueryResult[]; access: Access };

export class StatsCore {
  #key!: CryptoKey;
  #rpHash!: Uint8Array;
  #userHandle!: string;

  constructor(
    private readonly db: StatsStorage,
    private readonly env: StatsSettings,
    private readonly timingSafeEqual: (a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>) => boolean,
    private readonly now = Date.now,
  ) {}

  async start() {
    const version = this.env.STATS_VERSION?.id ?? "";
    const changedVersion = this.db.transactionSync(() => {
      this.db.exec(schema);
      if (this.#meta("schema_version") === undefined) {
        this.#set("schema_version", "1");
        this.#set("live_since", String(this.now()));
        this.#set("challenge_key", base64url(randomBytes(32)));
        this.#set("user_handle", base64url(randomBytes(32)));
      }
      // A cold instance of the same release must keep the per-day retry budget.
      const changed = this.#meta("import_version") !== version;
      if (changed) {
        this.#set("import_version", version);
        if (this.#meta("import_error")) {
          this.#set("import_error", "");
          this.#set("import_attempts", "0");
        }
      }
      return changed;
    });
    this.#userHandle = this.#meta("user_handle")!;
    [this.#key, this.#rpHash] = await Promise.all([
      crypto.subtle.importKey("raw", bytes(this.#meta("challenge_key"), 32), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
      sha256(utf8(this.env.STATS_RP_ID)),
    ]);
    if ((changedVersion && this.#pendingImport()) || await this.db.getAlarm() === null) await this.#schedule();
  }

  #rows<T extends object>(sql: string, ...params: SqlValue[]) {
    return this.db.exec(sql, ...params).toArray() as T[];
  }

  #meta(key: string) {
    return this.#rows<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)[0]?.value;
  }

  #set(key: string, value: string) {
    this.db.exec("INSERT INTO meta VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  #unusedEnrollment(hash: string, expires: number) {
    return expires > this.now() && this.#rows("SELECT 1 FROM used_enrollments WHERE hash = ?", hash).length === 0;
  }

  async #enrollment(token: unknown) {
    const fields = /^v1\.(\d{1,12})\.([a-f0-9]{64})$/.exec(this.env.STATS_ENROLLMENT ?? "");
    if (!fields) return null;
    const expires = Number(fields[1]) * 1000;
    if (expires <= this.now()) return null;
    const digest = await sha256(bytes(token, 32));
    const expected = Uint8Array.from(fields[2].match(/../g)!, pair => parseInt(pair, 16));
    const hash = hex(digest);
    return this.timingSafeEqual(digest, expected) && this.#unusedEnrollment(hash, expires) ? { hash, expires } : null;
  }

  async enrollmentOptions(token: unknown) {
    try {
      const enrollment = await this.#enrollment(token);
      if (!enrollment) return null;
      const challenge = await makeChallenge(this.#key, "enroll", this.now(), enrollment.hash);
      if (!this.#unusedEnrollment(enrollment.hash, enrollment.expires)) return null;
      const user = { id: this.#userHandle, name: "stats", displayName: "Delegatus stats" };
      return {
        challenge, rp: { id: this.env.STATS_RP_ID, name: "Delegatus" }, user,
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        attestation: "none", timeout: 300_000,
      };
    } catch {
      return null;
    }
  }

  async loginOptions() {
    return {
      challenge: await makeChallenge(this.#key, "login", this.now()),
      rpId: this.env.STATS_RP_ID, userVerification: "required", timeout: 120_000,
    };
  }

  async #newSession() {
    const token = randomBytes(32);
    return { token: base64url(token), hash: hex(await sha256(token)) };
  }

  #insertSession(hash: string, id: string, now: number) {
    this.db.exec("INSERT INTO sessions VALUES (?, ?, ?, ?, NULL)", hash, id, now, now + SESSION_SECONDS * 1000);
  }

  #consumeChallenge(nonce: string, expires: number, now: number) {
    if (expires <= now || this.#rows("SELECT 1 FROM used_challenges WHERE nonce = ?", nonce).length) return false;
    this.db.exec("INSERT INTO used_challenges VALUES (?, ?)", nonce, expires);
    return true;
  }

  async enroll(input: Record<string, unknown>) {
    try {
      const link = await this.#enrollment(input.token);
      if (!link) return null;
      const proof = await ceremony(input, this.#key, "enroll", this.env.STATS_ORIGIN, this.#rpHash, this.now(), link.hash);
      const spki = bytes(input.publicKey, 1, 600);
      const alg = input.alg;
      await publicKey(alg, spki);
      const id = base64url(bytes(input.id, 16, 1023));
      const session = await this.#newSession();
      return this.db.transactionSync(() => {
        const now = this.now();
        if (!this.#unusedEnrollment(link.hash, link.expires) ||
          this.#rows("SELECT 1 FROM credentials WHERE id = ?", id).length ||
          !this.#consumeChallenge(proof.nonce, proof.expires, now)) return null;
        this.db.exec("INSERT INTO used_enrollments VALUES (?, ?)", link.hash, now);
        this.db.exec("INSERT INTO credentials VALUES (?, ?, ?, ?, ?, NULL, NULL)", id, spki.buffer, alg as number, proof.count, now);
        this.#insertSession(session.hash, id, now);
        return session.token;
      });
    } catch {
      return null;
    }
  }

  #credential(id: string) {
    return this.#rows<Credential>("SELECT public_key, alg, sign_count FROM credentials WHERE id = ? AND revoked_at IS NULL", id)[0];
  }

  async login(input: Record<string, unknown>) {
    try {
      const id = base64url(bytes(input.id, 16, 1023));
      const credential = this.#credential(id);
      if (!credential || input.userHandle !== this.#userHandle) return null;
      const proof = await ceremony(input, this.#key, "login", this.env.STATS_ORIGIN, this.#rpHash, this.now());
      if (!await verifyAssertion(credential.alg, credential.public_key, proof.client, proof.auth, input.signature)) return null;
      const session = await this.#newSession();
      return this.db.transactionSync(() => {
        const now = this.now();
        const current = this.#credential(id);
        if (!current || (current.sign_count && proof.count && proof.count <= current.sign_count) ||
          !this.#consumeChallenge(proof.nonce, proof.expires, now)) return null;
        // A zero counter never erases a previous non-zero observation.
        this.db.exec("UPDATE credentials SET sign_count = max(sign_count, ?), last_used_at = ? WHERE id = ?", proof.count, now, id);
        this.#insertSession(session.hash, id, now);
        return session.token;
      });
    } catch {
      return null;
    }
  }

  #session(hash: string, now: number) {
    return this.#rows(`SELECT 1 FROM sessions JOIN credentials ON credentials.id = sessions.credential_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
      AND sessions.revoked_at IS NULL AND credentials.revoked_at IS NULL`, hash, now).length > 0;
  }

  async session(token: string) {
    const hash = hex(await sha256(bytes(token, 32)));
    return this.#session(hash, this.now());
  }

  async revoke(token: string, mode: "current" | "all" | "passkey", id: string) {
    const hash = hex(await sha256(bytes(token, 32)));
    return this.db.transactionSync(() => {
      const now = this.now();
      if (!this.#session(hash, now)) return null;
      const query = "UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL";
      if (mode === "current") this.db.exec(query + " AND token_hash = ?", now, hash);
      if (mode === "all") this.db.exec(query, now);
      if (mode === "passkey") {
        this.db.exec("UPDATE credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", now, id);
        this.db.exec(query + " AND credential_id = ?", now, id);
      }
      return this.#session(hash, now);
    });
  }

  recordPing(ping: InstallPing, country: string, now: number) {
    this.db.exec(`INSERT INTO install_days VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (day, id) DO UPDATE SET v = excluded.v, os = excluded.os, arch = excluded.arch,
      kind = excluded.kind, country = excluded.country, last_at = excluded.last_at
      WHERE excluded.last_at >= install_days.last_at`, utcDay(now), ping.id, ping.v, ping.os, ping.arch, ping.kind, country, now);
  }

  recordEvent(event: SiteEvent, country: string, now: number, total = 1) {
    this.db.exec(`INSERT INTO site_event_days VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (day, event, agent, lang, country) DO UPDATE SET total = site_event_days.total + excluded.total`,
    utcDay(now), event.event, event.agent ?? "", event.lang, country, total);
  }

  async snapshot(token: string): Promise<Snapshot | null> {
    const hash = hex(await sha256(bytes(token, 32)));
    const now = this.now();
    const currentCredential = this.#rows<{ id: string }>(`SELECT credentials.id FROM sessions
      JOIN credentials ON credentials.id = sessions.credential_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
      AND sessions.revoked_at IS NULL AND credentials.revoked_at IS NULL`, hash, now)[0];
    if (!currentCredential) return null;
    const days = Array.from({ length: 30 }, (_, index) => utcDay(now - (29 - index) * DAY));
    const today = days[29];
    const retained = utcDay(now - KEEP_DAYS * DAY);
    const query = (sql: string, ...params: SqlValue[]): QueryResult => {
      try { return { rows: this.#rows(sql, ...params), failed: false }; }
      catch { return { rows: [], failed: true }; }
    };
    const range = "day BETWEEN ? AND ? AND last_at <= ?";
    const last30 = [days[0], today, now] as const;
    const results = [
      ...[today, days[23], days[0]].map(day => query(
        `SELECT count(DISTINCT id) AS total FROM install_days WHERE ${range}`, day, today, now)),
      query(`SELECT day, count(*) AS total FROM install_days WHERE ${range} GROUP BY day ORDER BY day`, ...last30),
      query(`SELECT day, count(*) AS total FROM (SELECT min(day) AS day FROM install_days WHERE ${range}
        GROUP BY id) WHERE day >= ? GROUP BY day ORDER BY day`, retained, today, now, days[0]),
      query(`SELECT v AS label, count(DISTINCT id) AS total FROM install_days WHERE ${range}
        GROUP BY v ORDER BY total DESC, label LIMIT 100`, ...last30),
      query(`SELECT os, arch, count(DISTINCT id) AS total FROM install_days WHERE ${range}
        GROUP BY os, arch ORDER BY total DESC, os, arch LIMIT 100`, ...last30),
      query(`SELECT kind AS label, count(DISTINCT id) AS total FROM install_days WHERE ${range}
        GROUP BY kind ORDER BY total DESC, label LIMIT 100`, ...last30),
      query(`SELECT day, event, sum(total) AS total FROM site_event_days WHERE day BETWEEN ? AND ?
        GROUP BY day, event ORDER BY day, event LIMIT 120`, days[0], today),
      query(`SELECT strftime('%Y-%m-%d %H:%M:%S', max(last_at) / 1000, 'unixepoch') AS newest
        FROM install_days WHERE ${range}`, retained, today, now),
      query(`SELECT rule, sum(reports) AS reports, sum(delivered) AS delivered, sum(applied) AS applied,
        sum(misled) AS misled, sum(misled_reports) AS misled_reports FROM swarm_usage_days WHERE day BETWEEN ? AND ?
        GROUP BY rule ORDER BY delivered DESC, rule LIMIT 1000`, days[0], today),
    ];
    const passkeys = this.#rows<Access["passkeys"][number]>(`SELECT id, created_at, last_used_at FROM credentials
      WHERE revoked_at IS NULL ORDER BY created_at, id`);
    const error = this.#meta("import_error");
    const importStatus = this.#meta("import_done") ? "History import complete."
      : error && importErrors.includes(error) ? `History import stopped (${error}).`
        : historyConfigured(this.env) ? "Importing history…" : "History import unavailable.";
    return { now, days, results, access: { currentCredentialId: currentCredential.id, passkeys, importStatus } };
  }

  #pendingImport() {
    return historyConfigured(this.env) && !this.#meta("import_done") && !this.#meta("import_error");
  }

  async #schedule(retry = 1000) {
    const now = this.now();
    const todayAt3 = Date.parse(utcDay(now)) + 3 * 3_600_000;
    await this.db.setAlarm(this.#pendingImport() ? now + retry : todayAt3 + (todayAt3 <= now ? DAY : 0));
  }

  #retain(now: number) {
    const before = utcDay(now - KEEP_DAYS * DAY);
    this.db.transactionSync(() => {
      this.db.exec("DELETE FROM install_days WHERE day < ?", before);
      this.db.exec("DELETE FROM site_event_days WHERE day < ?", before);
      this.db.exec("DELETE FROM swarm_usage_days WHERE day < ?", before);
      this.db.exec("DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL", now);
      this.db.exec("DELETE FROM used_challenges WHERE expires_at <= ?", now);
      this.db.exec("DELETE FROM credentials WHERE revoked_at < ?", now - KEEP_DAYS * DAY);
    });
  }

  async alarm() {
    const now = this.now();
    if (!this.#pendingImport()) {
      this.#retain(now);
      await this.#schedule();
      return;
    }
    const live = Number(this.#meta("live_since"));
    const last = this.#rows<{ day: string | null }>("SELECT max(day) AS day FROM imported_days")[0].day;
    const day = utcDay(last ? Date.parse(last) + DAY : live - KEEP_DAYS * DAY);
    const finalDay = utcDay(live);
    if (day === finalDay && now < live + 600_000) {
      await this.db.setAlarm(live + 600_000);
      return;
    }
    const result = await readHistoryDay(this.env, day);
    if ("error" in result) {
      const { error } = result;
      const attempts = Number(this.#meta("import_attempts") ?? "0") + 1;
      this.db.transactionSync(() => {
        this.#set("import_attempts", String(attempts));
        if (attempts >= 3) this.#set("import_error", error);
      });
      if (attempts >= 3) console.log(`stats-import stopped ${error}`);
      await this.#schedule(60_000);
      return;
    }
    const count = this.db.transactionSync(() => {
      if (this.#rows("SELECT 1 FROM imported_days WHERE day = ?", day).length) return null;
      this.db.exec("INSERT INTO imported_days VALUES (?, ?)", day, this.now());
      for (const ping of result.pings) this.recordPing(ping.ping, ping.country, ping.at);
      for (const event of result.actions) this.recordEvent(event.event, event.country, Date.parse(day), event.total);
      this.#set("import_attempts", "0");
      this.#set("import_skipped", String(Number(this.#meta("import_skipped") ?? "0") + result.skipped));
      if (day !== finalDay) return 0;
      this.#set("import_done", "1");
      return this.#rows<{ total: number }>("SELECT count(*) AS total FROM imported_days")[0].total;
    });
    if (count !== null) console.log(`stats-import day=${day} ok`);
    if (count) {
      console.log(`stats-import complete days=${count}`);
      this.#retain(this.now());
    }
    await this.#schedule();
  }
}

type StatsMethods = Pick<StatsCore, "enrollmentOptions" | "enroll" | "loginOptions" | "login" |
  "session" | "snapshot" | "revoke" | "recordPing" | "recordEvent">;
export type StatsClient = {
  [K in keyof StatsMethods]: (...args: Parameters<StatsMethods[K]>) => Promise<Awaited<ReturnType<StatsMethods[K]>>>;
};
