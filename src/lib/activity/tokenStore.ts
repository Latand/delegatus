import type { Database, SQLQueryBindings } from "bun:sqlite";
import { conversationDigest, type TurnOwner } from "./store";
import { shiftDay, weekOfDay } from "./range";
import { type CodexCounters, type TokenCounts, type UsageAttribution, type UsageRecord } from "./tokenUsage";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const USAGE_RETENTION_DAYS = 92;
export const USAGE_MAINTENANCE_LIMIT = 10_000;
export const USAGE_REBUILD_SCAN_LIMIT = 500;
const USAGE_REBUILD_COPY_LIMIT = 5_000;
const columns = "requests, input, cache_read, cache_write, cache_write_1h, output, reasoning";
const increments = columns.split(", ").map(key => `${key} = ${key} + excluded.${key}`).join(", ");
export const tokenBindings = (c: TokenCounts) => [c.requests, c.input, c.cacheRead, c.cacheWrite, c.cacheWrite1h, c.output, c.reasoning];
export interface UsageMeta {
  schema: number; version: number; zone: string; zone_since: string | null; previous_zone: string | null;
  counted_from: number | null; skipped_old: number; malformed: number; branch_skipped: number;
  pending_bytes: number; complete: number; maintenance_day: number; target_zone: string | null; rebuild_cursor: string | null;
  rebuild_phase: string | null; rebuild_final_cursor: string | null; rebuild_since: string | null; zones: string;
}
const dayDefinition = `host TEXT NOT NULL, zone TEXT NOT NULL, day TEXT NOT NULL,
  project TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, tier TEXT NOT NULL,
  account TEXT NOT NULL, member TEXT NOT NULL, engine TEXT NOT NULL,
  week TEXT NOT NULL, price_key INTEGER NOT NULL,
  requests INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL,
  PRIMARY KEY(host, zone, day, price_key, project, role, model, tier, account, member, engine)`;
const summaryDefinition=`host TEXT NOT NULL, zone TEXT NOT NULL, day TEXT NOT NULL, dimension TEXT NOT NULL, key TEXT NOT NULL,
  model TEXT NOT NULL, tier TEXT NOT NULL, engine TEXT NOT NULL, week TEXT NOT NULL,
  requests INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
  cache_write_1h INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL,
  PRIMARY KEY(host, zone, dimension, day, key)`;

/** Called inside the activity writer's schema transaction. Its user_version stays 3. */
export function migrateUsage(db: Database): void {
  const statements = [
    `CREATE TABLE IF NOT EXISTS usage_hours (
      host TEXT NOT NULL, hour INTEGER NOT NULL, conversation TEXT NOT NULL,
      model TEXT NOT NULL, tier TEXT NOT NULL, account TEXT NOT NULL,
      engine TEXT NOT NULL, project TEXT, role TEXT NOT NULL, member TEXT NOT NULL, pipeline TEXT, stage TEXT,
      requests INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL,
      PRIMARY KEY(host, hour, conversation, model, tier, account)) WITHOUT ROWID`,
    "CREATE INDEX IF NOT EXISTS usage_hours_pipeline ON usage_hours(host, pipeline, hour) WHERE pipeline IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS usage_hours_conversation ON usage_hours(host, conversation, hour)",
    "CREATE TABLE IF NOT EXISTS limit_spend_dirty (key TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS limit_spend_dirty_tasks ON limit_spend_dirty(at,key) WHERE key >= 't:' AND key < 't;'",
    "CREATE TABLE IF NOT EXISTS task_spend_owners (owner TEXT NOT NULL, task TEXT NOT NULL, PRIMARY KEY(owner, task)) WITHOUT ROWID",
    `CREATE TABLE IF NOT EXISTS task_spend_progress (task TEXT PRIMARY KEY, stamp INTEGER NOT NULL, signature TEXT NOT NULL,
      owner TEXT NOT NULL, cursor TEXT, rows TEXT NOT NULL) WITHOUT ROWID`,
    "CREATE INDEX IF NOT EXISTS task_spend_owners_task ON task_spend_owners(task, owner)",
    `CREATE TABLE IF NOT EXISTS usage_limit_rates (account TEXT NOT NULL, window TEXT NOT NULL, day TEXT NOT NULL,
      rate REAL, rise REAL NOT NULL, weight REAL NOT NULL, source TEXT NOT NULL, plan TEXT,
      frozen INTEGER NOT NULL DEFAULT 0, computed_at INTEGER NOT NULL, PRIMARY KEY(account, window, day)) WITHOUT ROWID`,
    "CREATE INDEX IF NOT EXISTS usage_limit_rates_day ON usage_limit_rates(day, account, window)",
    `CREATE TABLE IF NOT EXISTS task_limit_spend (task TEXT NOT NULL, account TEXT NOT NULL, engine TEXT NOT NULL,
      tokens INTEGER NOT NULL, unpriced_tokens INTEGER NOT NULL, weight REAL NOT NULL, rated_weight REAL NOT NULL,
      weekly_pp REAL, window_start INTEGER, window_pp REAL, session_start INTEGER, session_pp REAL,
      first_hour INTEGER NOT NULL, last_hour INTEGER NOT NULL, floor TEXT, computed_at INTEGER NOT NULL,
      PRIMARY KEY(task, account)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS limit_spend_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema INTEGER NOT NULL,
      seed TEXT NOT NULL DEFAULT 'tasks:', task_revision INTEGER NOT NULL DEFAULT -1, task_key TEXT NOT NULL DEFAULT '',
      rates_hour INTEGER NOT NULL DEFAULT -1)`,
    "INSERT OR IGNORE INTO limit_spend_meta(singleton, schema) VALUES(1, 1)",
    `CREATE TABLE IF NOT EXISTS usage_days (${dayDefinition}) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS usage_days_rebuild (${dayDefinition}) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS usage_summaries (${summaryDefinition}) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS usage_summaries_rebuild (${summaryDefinition}) WITHOUT ROWID`,
    "CREATE TABLE IF NOT EXISTS usage_claude_seen (k INTEGER PRIMARY KEY, at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS usage_claude_seen_at ON usage_claude_seen(at)",
    `CREATE TABLE IF NOT EXISTS usage_codex_threads (thread TEXT PRIMARY KEY, total INTEGER NOT NULL, at INTEGER NOT NULL,
      input INTEGER NOT NULL, cached INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL) WITHOUT ROWID`,
    "CREATE INDEX IF NOT EXISTS usage_codex_threads_at ON usage_codex_threads(at)",
    `CREATE TABLE IF NOT EXISTS usage_meta (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), schema INTEGER NOT NULL,
      version INTEGER NOT NULL, zone TEXT NOT NULL, zone_since TEXT, previous_zone TEXT, counted_from INTEGER,
      skipped_old INTEGER NOT NULL DEFAULT 0, malformed INTEGER NOT NULL DEFAULT 0, branch_skipped INTEGER NOT NULL DEFAULT 0,
      pending_bytes INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0, maintenance_day INTEGER NOT NULL DEFAULT -1,
      target_zone TEXT, rebuild_cursor TEXT, rebuild_phase TEXT, rebuild_final_cursor TEXT, rebuild_since TEXT, zones TEXT NOT NULL DEFAULT '[]')`,
    "INSERT OR IGNORE INTO usage_meta(singleton, schema, version, zone) VALUES(1, 1, 0, 'Europe/Kyiv')",
  ];
  for (const statement of statements) db.exec(statement);
  const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(activity_files)").all().map(r => r.name));
  if (!cols.has("usage_offset")) db.exec("ALTER TABLE activity_files ADD COLUMN usage_offset INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("usage_facts")) db.exec("ALTER TABLE activity_files ADD COLUMN usage_facts TEXT");
  const metaCols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(usage_meta)").all().map(r => r.name));
  if (!metaCols.has("rebuild_phase")) db.exec("ALTER TABLE usage_meta ADD COLUMN rebuild_phase TEXT");
  if (!metaCols.has("rebuild_final_cursor")) db.exec("ALTER TABLE usage_meta ADD COLUMN rebuild_final_cursor TEXT");
  if (!metaCols.has("rebuild_since")) db.exec("ALTER TABLE usage_meta ADD COLUMN rebuild_since TEXT");
}

export function usageMeta(db: Database): UsageMeta | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_meta'").get()) return null;
  const row = db.query<UsageMeta, []>("SELECT * FROM usage_meta WHERE singleton = 1").get();
  return row?.schema === 1 ? row : null;
}
export function usageZones(meta: UsageMeta): string[] {
  return [...new Set([meta.zone, ...JSON.parse(meta.zones) as string[]])];
}

export type UsageBatch = { owner: TurnOwner; records: readonly UsageRecord[]; attribution(at: number): UsageAttribution; malformed: number; now: number };
type CountsRow = { requests: number; input: number; cache_read: number; cache_write: number; cache_write_1h: number; output: number; reasoning: number };
export const countsFromRow = (r: CountsRow): TokenCounts => ({ requests: r.requests ?? 0, input: r.input ?? 0, cacheRead: r.cache_read ?? 0,
  cacheWrite: r.cache_write ?? 0, cacheWrite1h: r.cache_write_1h ?? 0, output: r.output ?? 0, reasoning: r.reasoning ?? 0 });
export const SUM_TOKENS = columns.split(", ").map(k => `COALESCE(SUM(${k}), 0) AS ${k}`).join(", ");
/** Grouping one integer keeps the per-model/tier cost split inside the read budget. */
export function usagePriceKey(model: string, tier: string, engine: string): bigint {
  return BigInt.asIntN(64, BigInt(`0x${conversationDigest(JSON.stringify([model, tier, engine])).slice(0,16)}`));
}

type HourRow = CountsRow & { hour: number; conversation: string; model: string; tier: string; account: string; engine: string; project: string | null; role: string; member: string };
const hourKey = (row: Pick<HourRow, "hour" | "conversation" | "model" | "tier" | "account">): SQLQueryBindings[] => [row.hour, row.conversation, row.model, row.tier, row.account];
const keyExpression = "(hour, conversation, model, tier, account)";
const keyBinds = "(?, ?, ?, ?, ?)";
const dates = new Map<string, Intl.DateTimeFormat>();
export function usageDay(at: number, zone: string): string {
  let format = dates.get(zone);
  if (!format) { format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }); if (dates.size >= 8) dates.clear(); dates.set(zone, format); }
  return format.format(at);
}

function addDay(db: Database, table: "usage_days" | "usage_days_rebuild", zone: string, row: HourRow, counts: TokenCounts): void {
  const day = usageDay(row.hour * HOUR, zone);
  const week=weekOfDay(day);
  db.query(`INSERT INTO ${table}(host, zone, day, project, role, model, tier, account, member, engine, week, price_key, ${columns})
    VALUES('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET ${increments}`).run(zone, day, row.project ?? "", row.role, row.model, row.tier, row.account, row.member, row.engine,
      week, usagePriceKey(row.model,row.tier,row.engine), ...tokenBindings(counts));
  const summary=table==="usage_days"?"usage_summaries":"usage_summaries_rebuild";
  const add=db.query(`INSERT INTO ${summary}(host,zone,day,dimension,key,model,tier,engine,week,${columns})
    VALUES('',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET ${increments}`);
  for(const [dimension,key] of [["all","all"],["price",JSON.stringify([row.model,row.tier,row.engine])],
    ["model",row.model],["role",row.role],["project",row.project??""],["member",row.member],["account",row.account],["engine",row.engine]]) {
    add.run(zone,day,dimension!,key!,dimension==="price"?row.model:"",dimension==="price"?row.tier:"",dimension==="price"?row.engine:"",week,...tokenBindings(counts));
  }
}

/** The caller owns the same transaction as the transcript cursor. */
export function commitUsage(db: Database, batch: UsageBatch): void {
  const meta = usageMeta(db)!;
  let changed = false, skipped = 0, branch = 0, oldest: number | null = null;
  const hours = new Map<string, HourRow>();
  for (const rec of batch.records) {
    if (rec.at < batch.now - USAGE_RETENTION_DAYS * DAY) { skipped++; continue; }
    const counts = { ...rec.counts };
    const digest = conversationDigest(`${rec.engine}:${rec.id}`);
    if (rec.engine === "claude") {
      const hash = BigInt.asIntN(64, BigInt(`0x${digest.slice(0, 16)}`));
      if (!db.query("INSERT OR IGNORE INTO usage_claude_seen(k, at) VALUES(?, ?)").run(hash, rec.at).changes) continue;
    } else {
      const previous = db.query<{ total: number; at: number; input: number; cached: number; cache_write: number; output: number; reasoning: number }, [string]>(
        "SELECT * FROM usage_codex_threads WHERE thread = ?").get(digest);
      const next = rec.cumulative!;
      if (previous && next.total <= previous.total) { if (rec.at > previous.at) branch++; continue; }
      if (rec.legacy) {
        const baseline: CodexCounters = previous ? { ...previous, cacheWrite: previous.cache_write } : rec.baseline!;
        counts.cacheRead = Math.max(0, next.cached - baseline.cached);
        counts.cacheWrite = Math.max(0, next.cacheWrite - baseline.cacheWrite);
        counts.input = Math.max(0, next.input - baseline.input - counts.cacheRead - counts.cacheWrite);
        counts.output = Math.max(0, next.output - baseline.output);
        counts.reasoning = Math.min(counts.output, Math.max(0, next.reasoning - baseline.reasoning));
      }
      db.query(`INSERT INTO usage_codex_threads VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread) DO UPDATE SET total=excluded.total, at=excluded.at, input=excluded.input, cached=excluded.cached,
          cache_write=excluded.cache_write, output=excluded.output, reasoning=excluded.reasoning`).run(digest, next.total, rec.at, next.input, next.cached, next.cacheWrite, next.output, next.reasoning);
    }
    const attr = batch.attribution(rec.at);
    const row: HourRow = { hour: Math.floor(rec.at / HOUR), conversation: conversationDigest(batch.owner.conversation),
      model: rec.model ?? attr.model ?? "unknown", tier: rec.tier ?? attr.tier ?? "standard", account: attr.account,
      engine: rec.engine, project: batch.owner.project, role: batch.owner.role, member: attr.member, ...countsFromCounts(counts) };
    const key = JSON.stringify(hourKey(row));
    const prior = hours.get(key);
    if (prior) { for (const column of columns.split(", ") as Array<keyof CountsRow>) prior[column] += row[column]; }
    else hours.set(key, row);
    oldest = Math.min(oldest ?? rec.at, rec.at); changed = true;
  }
  for (const row of hours.values()) {
    const counts = countsFromRow(row);
    db.query(`INSERT INTO usage_hours(host, hour, conversation, model, tier, account, engine, project, role, member, pipeline, stage, ${columns})
      VALUES('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET ${increments}`).run(...hourKey(row), row.engine, row.project, row.role, row.member, batch.owner.pipelineId, batch.owner.stageId, ...tokenBindings(counts));
    addDay(db, "usage_days", meta.zone, row, counts);
    const phase = meta.rebuild_phase ?? (meta.target_zone ? "scan" : null);
    if (meta.target_zone && (phase === "copy-days" || phase === "copy-summaries")) {
      // Live deltas and the resumable copy share one key, so either ordering preserves the exact total.
      addDay(db, "usage_days_rebuild", meta.target_zone, row, counts);
      if (!meta.rebuild_since || usageDay(row.hour * HOUR, meta.target_zone) >= meta.rebuild_since) {
        addDay(db, "usage_days", meta.target_zone, row, counts);
      }
    } else if (meta.target_zone && phase === "scan" && meta.rebuild_cursor) {
      // Only previously scanned keys need dual writes. Later keys are read with their new values.
      const scanned = db.query<{ ok: number }, SQLQueryBindings[]>(`SELECT ${keyBinds} <= ${keyBinds} AS ok`).get(...hourKey(row), ...JSON.parse(meta.rebuild_cursor));
      if (scanned?.ok) addDay(db, "usage_days_rebuild", meta.target_zone, row, counts);
    }
  }
  if (changed && (batch.owner.pipelineId || batch.owner.role !== "orchestrator")) {
    const key = batch.owner.pipelineId ? `p:${batch.owner.pipelineId}` : `c:${conversationDigest(batch.owner.conversation)}`;
    db.query("INSERT INTO limit_spend_dirty(key, at) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET at=MAX(at+1, excluded.at)").run(key, batch.now);
  }
  if (changed || skipped || branch || batch.malformed) db.query(`UPDATE usage_meta SET version=version+1,
    counted_from=CASE WHEN ? IS NULL THEN counted_from ELSE MIN(COALESCE(counted_from, ?), ?) END,
    skipped_old=skipped_old+?, malformed=malformed+?, branch_skipped=branch_skipped+? WHERE singleton=1`).run(oldest, oldest, oldest, skipped, batch.malformed, branch);
}
function countsFromCounts(c: TokenCounts): CountsRow {
  return { requests: c.requests, input: c.input, cache_read: c.cacheRead, cache_write: c.cacheWrite, cache_write_1h: c.cacheWrite1h, output: c.output, reasoning: c.reasoning };
}

/** Bounded, resumable maintenance. Progress is durable across Viewer restarts. */
export function maintainUsage(db: Database, now: number, zone: string): void {
  let meta = usageMeta(db)!;
  const today = Math.floor(now / DAY);
  if (meta.maintenance_day !== today) {
    let remaining = false;
    for (const [table, column, cutoff] of [
      ["usage_hours", "hour", Math.floor((now - 92 * DAY) / HOUR)],
      ["usage_days", "day", usageDay(now - 760 * DAY, meta.zone)],
      ["usage_claude_seen", "at", now - 92 * DAY], ["usage_codex_threads", "at", now - 92 * DAY],
      ["usage_limit_rates", "day", usageDay(now - 760 * DAY, "UTC")],
    ] as const) {
      const keys = table === "usage_hours" ? "host, hour, conversation, model, tier, account" : table === "usage_days"
        ? "host, zone, day, price_key, project, role, model, tier, account, member, engine" : table === "usage_claude_seen" ? "k" : table === "usage_limit_rates" ? "account, window, day" : "thread";
      const zones=usageZones(meta);
      const scoped = table === "usage_days" ? `host='' AND zone IN (${zones.map(()=>"?").join(",")}) AND ` : table === "usage_hours" ? "host='' AND " : "";
      const bindings=table==="usage_days"?[...zones,cutoff]:[cutoff];
      db.query(`DELETE FROM ${table} WHERE (${keys}) IN (SELECT ${keys} FROM ${table} WHERE ${scoped}${column} < ? LIMIT ${USAGE_MAINTENANCE_LIMIT})`).run(...bindings);
      remaining ||= !!db.query(`SELECT 1 FROM ${table} WHERE ${scoped}${column} < ? LIMIT 1`).get(...bindings);
    }
    db.query("UPDATE usage_meta SET maintenance_day=?, version=version+1 WHERE singleton=1").run(remaining ? -1 : today);
    const zones=usageZones(meta);
    const expiry=usageDay(now-760*DAY,meta.zone);
    const dimensions=["all","price","model","role","project","member","account","engine"];
    db.query(`DELETE FROM usage_summaries WHERE (host,zone,dimension,day,key) IN (
      SELECT host,zone,dimension,day,key FROM usage_summaries WHERE host='' AND zone IN (${zones.map(()=>"?").join(",")})
      AND dimension IN (${dimensions.map(()=>"?").join(",")}) AND day < ? LIMIT ${USAGE_MAINTENANCE_LIMIT})`).run(...zones,...dimensions,expiry);
    if(db.query(`SELECT 1 FROM usage_summaries WHERE host='' AND zone IN (${zones.map(()=>"?").join(",")})
      AND dimension IN (${dimensions.map(()=>"?").join(",")}) AND day < ? LIMIT 1`).get(...zones,...dimensions,expiry)) {
      db.exec("UPDATE usage_meta SET maintenance_day=-1 WHERE singleton=1");
    }
  }
  if (zone !== meta.zone && !meta.target_zone) {
    db.query("UPDATE usage_meta SET target_zone=?, rebuild_phase='prepare-days', rebuild_cursor=NULL, rebuild_final_cursor=NULL, rebuild_since=NULL WHERE singleton=1").run(zone);
    meta = usageMeta(db)!;
  }
  if (!meta.target_zone) return;
  const phase = meta.rebuild_phase ?? "scan";
  if (phase === "prepare-days" || phase === "prepare-summaries") {
    const table = phase === "prepare-days" ? "usage_days_rebuild" : "usage_summaries_rebuild";
    const keys = phase === "prepare-days" ? "host,zone,day,price_key,project,role,model,tier,account,member,engine" : "host,zone,day,dimension,key";
    const removed = db.query(`DELETE FROM ${table} WHERE (${keys}) IN (SELECT ${keys} FROM ${table} LIMIT ${USAGE_MAINTENANCE_LIMIT})`).run().changes;
    if (removed < USAGE_MAINTENANCE_LIMIT) {
      db.query("UPDATE usage_meta SET rebuild_phase=? WHERE singleton=1").run(phase === "prepare-days" ? "prepare-summaries" : "scan");
    }
    return;
  }
  if (phase === "scan") {
    const cursor = meta.rebuild_cursor ? JSON.parse(meta.rebuild_cursor) as SQLQueryBindings[] : null;
    const rows = db.query<HourRow, SQLQueryBindings[]>(`SELECT * FROM usage_hours WHERE host='' ${cursor ? `AND ${keyExpression} > ${keyBinds}` : ""}
      ORDER BY hour, conversation, model, tier, account LIMIT ${USAGE_REBUILD_SCAN_LIMIT}`).all(...(cursor ?? []));
    for (const row of rows) addDay(db, "usage_days_rebuild", meta.target_zone, row, countsFromRow(row));
    if (rows.length === USAGE_REBUILD_SCAN_LIMIT) {
      db.query("UPDATE usage_meta SET rebuild_cursor=? WHERE singleton=1").run(JSON.stringify(hourKey(rows.at(-1)!)));
    } else {
      db.query("UPDATE usage_meta SET rebuild_phase='copy-days', rebuild_cursor=NULL, rebuild_since=? WHERE singleton=1")
        .run(shiftDay(usageDay(now - 92 * DAY, meta.target_zone), 1));
    }
    return;
  }
  if (phase === "copy-days") {
    const cursor = meta.rebuild_final_cursor ? JSON.parse(meta.rebuild_final_cursor) as SQLQueryBindings[] : null;
    const rows = db.query<DayRow, SQLQueryBindings[]>(`SELECT *, CAST(price_key AS TEXT) AS cursor_price_key FROM usage_days_rebuild WHERE host='' AND zone=? AND day >= ? ${cursor ? `AND (day,price_key,project,role,model,tier,account,member,engine) > (?,CAST(? AS INTEGER),?,?,?,?,?,?,?)` : ""}
      ORDER BY day,price_key,project,role,model,tier,account,member,engine LIMIT ${USAGE_REBUILD_COPY_LIMIT}`)
      .all(meta.target_zone, meta.rebuild_since, ...(cursor ?? []));
    if (rows.length) copyDayBatch(db, meta.rebuild_since!, cursor);
    if (rows.length === USAGE_REBUILD_COPY_LIMIT) {
      db.query("UPDATE usage_meta SET rebuild_final_cursor=? WHERE singleton=1").run(JSON.stringify(dayCursor(rows.at(-1)!)));
    } else {
      db.query("UPDATE usage_meta SET rebuild_phase='copy-summaries', rebuild_final_cursor=NULL WHERE singleton=1").run();
    }
    return;
  }
  if (phase === "copy-summaries") {
    const cursor = meta.rebuild_final_cursor ? JSON.parse(meta.rebuild_final_cursor) as SQLQueryBindings[] : null;
    const rows = db.query<SummaryRow, SQLQueryBindings[]>(`SELECT * FROM usage_summaries_rebuild WHERE host='' AND zone=? AND day>=? ${cursor ? `AND (dimension,day,key) > (?,?,?)` : ""}
      ORDER BY dimension,day,key LIMIT ${USAGE_REBUILD_COPY_LIMIT}`).all(meta.target_zone,meta.rebuild_since,...(cursor ?? []));
    for (const row of rows) copySummary(db, row);
    if (rows.length === USAGE_REBUILD_COPY_LIMIT) {
      db.query("UPDATE usage_meta SET rebuild_final_cursor=? WHERE singleton=1")
        .run(JSON.stringify([rows.at(-1)!.dimension, rows.at(-1)!.day, rows.at(-1)!.key]));
    } else {
      db.query(`UPDATE usage_meta SET zones=?, previous_zone=zone, zone=target_zone, zone_since=rebuild_since,
        rebuild_phase='prune-days', rebuild_final_cursor=NULL, version=version+1 WHERE singleton=1`)
        .run(JSON.stringify([...new Set([...usageZones(meta),meta.target_zone])]));
    }
    return;
  }
  if (phase === "prune-days" || phase === "prune-summaries") {
    const table = phase === "prune-days" ? "usage_days" : "usage_summaries";
    const keys = phase === "prune-days" ? "host,zone,day,price_key,project,role,model,tier,account,member,engine" : "host,zone,day,dimension,key";
    const oldZones=usageZones(meta).filter(value=>value!==meta.target_zone);
    if (!oldZones.length) {
      db.query("UPDATE usage_meta SET rebuild_phase=? WHERE singleton=1").run(phase === "prune-days" ? "prune-summaries" : "cleanup-days");
      return;
    }
    const zoneClause=oldZones.map(()=>"?").join(",");
    const dimensions=phase === "prune-summaries" ? ` AND dimension IN ('all','price','model','role','project','member','account','engine')` : "";
    const removed = db.query(`DELETE FROM ${table} WHERE (${keys}) IN (SELECT ${keys} FROM ${table}
      WHERE host='' AND zone IN (${zoneClause})${dimensions} AND day>=? LIMIT ${USAGE_MAINTENANCE_LIMIT})`).run(...oldZones,meta.rebuild_since).changes;
    if (removed < USAGE_MAINTENANCE_LIMIT) {
      db.query("UPDATE usage_meta SET rebuild_phase=? WHERE singleton=1").run(phase === "prune-days" ? "prune-summaries" : "cleanup-days");
    }
    return;
  }
  if (phase === "cleanup-days" || phase === "cleanup-summaries") {
    const table = phase === "cleanup-days" ? "usage_days_rebuild" : "usage_summaries_rebuild";
    const keys = phase === "cleanup-days" ? "host,zone,day,price_key,project,role,model,tier,account,member,engine" : "host,zone,day,dimension,key";
    const removed = db.query(`DELETE FROM ${table} WHERE (${keys}) IN (SELECT ${keys} FROM ${table} LIMIT ${USAGE_MAINTENANCE_LIMIT})`).run().changes;
    if (removed < USAGE_MAINTENANCE_LIMIT) {
      if (phase === "cleanup-days") db.query("UPDATE usage_meta SET rebuild_phase='cleanup-summaries' WHERE singleton=1").run();
      else db.query("UPDATE usage_meta SET target_zone=NULL, rebuild_phase=NULL, rebuild_final_cursor=NULL, rebuild_since=NULL WHERE singleton=1").run();
    }
    return;
  }
}

type DayRow = CountsRow & { host: string; zone: string; day: string; project: string; role: string; model: string; tier: string; account: string; member: string; engine: string; week: string; price_key: number | bigint; cursor_price_key: string };
type SummaryRow = CountsRow & { host: string; zone: string; day: string; dimension: string; key: string; model: string; tier: string; engine: string; week: string };
const dayColumns = "host,zone,day,project,role,model,tier,account,member,engine,week,price_key,requests,input,cache_read,cache_write,cache_write_1h,output,reasoning";
const summaryColumns = "host,zone,day,dimension,key,model,tier,engine,week,requests,input,cache_read,cache_write,cache_write_1h,output,reasoning";
const dayCursor = (row: DayRow): SQLQueryBindings[] => [row.day, row.cursor_price_key, row.project, row.role, row.model, row.tier, row.account, row.member, row.engine];
function copyDayBatch(db: Database, since: string, cursor: SQLQueryBindings[] | null): void {
  const after = cursor ? `AND (day,price_key,project,role,model,tier,account,member,engine) > (?,CAST(? AS INTEGER),?,?,?,?,?,?,?)` : "";
  db.query(`INSERT OR REPLACE INTO usage_days(${dayColumns}) SELECT ${dayColumns} FROM usage_days_rebuild
    WHERE host='' AND zone=(SELECT target_zone FROM usage_meta WHERE singleton=1) AND day >= ? ${after}
    ORDER BY day,price_key,project,role,model,tier,account,member,engine LIMIT ${USAGE_REBUILD_COPY_LIMIT}`)
    .run(since, ...(cursor ?? []));
}
function copySummary(db: Database, row: SummaryRow): void {
  db.query(`INSERT OR REPLACE INTO usage_summaries(${summaryColumns}) VALUES(${Array(16).fill("?").join(",")})`).run(
    row.host,row.zone,row.day,row.dimension,row.key,row.model,row.tier,row.engine,row.week,
    row.requests,row.input,row.cache_read,row.cache_write,row.cache_write_1h,row.output,row.reasoning);
}
