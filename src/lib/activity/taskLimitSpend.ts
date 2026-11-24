import type { Database, SQLQueryBindings } from "bun:sqlite";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { agentRegistry } from "@/lib/agent/registry";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { findPipelineRecord, pipelineTaskBindingSource } from "@/lib/pipelines/store";
import { loadTasksByIds, taskFeedSource } from "@/lib/tasks/store";
import type { EngineLimits } from "@/lib/types";
import type { BoardTask } from "@/lib/tasks/types";
import { waitForStateLock } from "@/lib/state/lockWait";
import { readHistory } from "@/lib/limitsHistoryStore";
import { ActivityStore, activityStorePath, conversationDigest } from "./store";
import { countsFromRow, DAY, HOUR, usageMeta } from "./tokenStore";
import { tokenTotal } from "./tokenUsage";
import { invalidateUnattributedCodexRates, LIMIT_RATE_SCHEMA, nearestRate, refreshLimitRates, utcDay, type LimitRate, type SpendObservations } from "./limitRates";
import { apiCost, ESTIMATE_VERSION, estimateShare, meterCost, planBudget, planWithoutFixedLimit, shareBasis } from "./subscriptionEstimate";
import { priceTier } from "./tokenPrices";
import { activityOperation } from "./operation";
import type { TaskSpendAccount, TaskSpendProvider, TaskSpendResponse, SpendEngine } from "./taskLimitSpendTypes";

export interface SpendDependencies {
  now(): number;
  source(): Pick<NonNullable<ReturnType<typeof taskFeedSource>>, "revision" | "get" | "keyRange" | "changesAfter" | "parse"> | null;
  tasks(ids: ReadonlySet<string>): BoardTask[];
  pipelineTasks(id: string): readonly string[];
  pipelineSource?(): Pick<ReturnType<typeof pipelineTaskBindingSource>, "revision" | "changesAfter" | "parse"> | null;
  observations(): SpendObservations;
  labels(): ReadonlyMap<string, string>;
  history(): ReturnType<typeof readHistory> | Pick<ReturnType<typeof readHistory>, "series">;
}
const production: SpendDependencies = {
  now: Date.now, source: taskFeedSource, tasks: loadTasksByIds,
  pipelineTasks: id => findPipelineRecord(id)?.taskIds ?? [], pipelineSource: pipelineTaskBindingSource, history: readHistory,
  observations: () => new Map((["claude", "codex"] as const).flatMap(engine => agentRegistry().quotaObservations(engine)
    .flatMap(o => o.limits ? [[`${engine}:${o.accountId}`, o.limits] as const] : []))),
  labels: () => new Map([...listClaudeAccounts().map(a => [`claude:${a.id}`, a.label] as const),
    ...listCodexAccounts().map(a => [`codex:${a.id}`, a.label] as const)]),
};
interface Meta { seed: string; task_revision: number; task_key: string; rates_hour: number;
  pipeline_revision: number; pipeline_key: string; pipeline_seed: string; aggregate_schema: number; aggregate_cursor: string; rate_schema: number; estimate_version: string; estimate_cursor: string | null }
interface Dirty { key: string; at: number }
export interface SpendRow {
  task: string; account: string; engine: SpendEngine; tokens: number; unpriced_tokens: number; weight: number; rated_weight: number;
  weekly_pp: number | null; window_start: number | null; window_pp: number | null; session_start: number | null; session_pp: number | null;
  first_hour: number; last_hour: number; floor: "before-counting" | "uncounted" | null; computed_at: number;
  api_usd: number | null; api_priced_tokens: number; unpriced_models: string;
}
export type SpendHour = Parameters<typeof countsFromRow>[0] & { hour: number; conversation: string; model: string; tier: string;
  account: string; engine: string; pipeline: string | null; role: string };
const metaRead = (db: Database) => db.query<Meta, []>("SELECT * FROM limit_spend_meta WHERE singleton=1").get()!;
const dirty = (db: Database, key: string, at: number) => db.query(`INSERT INTO limit_spend_dirty VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET at=MAX(at+1,excluded.at)`).run(key, at);
const clearDirty = (db: Database, row: Dirty) => db.query("DELETE FROM limit_spend_dirty WHERE key=? AND at=?").run(row.key,row.at);
export const TASK_SPEND_DUE_SQL = "SELECT key,at FROM limit_spend_dirty INDEXED BY limit_spend_dirty_tasks WHERE key >= 't:' AND key < 't;' ORDER BY at,key LIMIT 100";
const assignmentOwners = (task: BoardTask) => [...new Set(task.assignments.flatMap(a => a.conversationId ? [`c:${conversationDigest(a.conversationId)}`] : []))].sort();
const ownerTasks = (db: Database, owner: string) => db.query<{ task: string }, [string]>("SELECT task FROM task_spend_owners WHERE owner=?").all(owner).map(r => r.task);
function replaceOwner(db: Database, owner: string, tasks: readonly string[], now: number, forceTasks = true) {
  const old = ownerTasks(db,owner).sort(), next = [...new Set(tasks)].sort();
  const changed = JSON.stringify(old) !== JSON.stringify(next);
  if (changed) {
    db.query("DELETE FROM task_spend_owners WHERE owner=?").run(owner);
    for (const task of next) db.query("INSERT OR IGNORE INTO task_spend_owners VALUES(?,?)").run(owner,task);
  }
  if (changed || forceTasks) for (const task of new Set([...old,...next])) dirty(db,`t:${task}`,now);
}
function mapTask(db: Database, task: BoardTask, now: number, force = false) {
  const old = db.query<{ owner: string }, [string]>("SELECT owner FROM task_spend_owners WHERE task=? AND owner >= 'c:' AND owner < 'c;' ORDER BY owner").all(task.id).map(r=>r.owner);
  const next = assignmentOwners(task);
  if (JSON.stringify(old) !== JSON.stringify(next)) {
    db.query("DELETE FROM task_spend_owners WHERE task=? AND owner >= 'c:' AND owner < 'c;'").run(task.id);
    for (const owner of next) db.query("INSERT OR IGNORE INTO task_spend_owners VALUES(?,?)").run(owner,task.id);
  }
  if (force || JSON.stringify(old) !== JSON.stringify(next)) dirty(db,`t:${task.id}`,now);
}
function deleteTask(db: Database, id: string) {
  for (const table of ["task_spend_owners", "task_limit_spend", "task_spend_progress"]) db.query(`DELETE FROM ${table} WHERE task=?`).run(id);
  db.query("DELETE FROM limit_spend_dirty WHERE key=?").run(`t:${id}`);
}
export function windowStart(observation: EngineLimits,
  window: "weekly" | "session", now: number): number | null {
  const value = observation[window];
  return value?.resetsAt != null && value.resetsAt > now / 1000 ? value.resetsAt - (value.windowMinutes ?? (window === "weekly" ? 10080 : 300))*60 : null;
}

/** Pure page reducer. Previously persisted partials let a large task cross pass and process boundaries. */
export function computeTaskRows(task: BoardTask, hours: readonly SpendHour[], rates: readonly LimitRate[], observations: SpendObservations,
  countedFrom: number | null, now: number, previous: SpendRow[] = []): SpendRow[] {
  const result = new Map(previous.map(r => [r.account,r]));
  const weeklyRates = new Map<string, LimitRate>();
  const sessionRates = new Map<string, LimitRate[]>();
  for (const rate of rates) {
    if (rate.window === "weekly") {
      if (rate.source === "own" && rate.rate !== null) weeklyRates.set(`${rate.account}|${rate.day}`, rate);
    } else {
      const days = sessionRates.get(rate.account) ?? [];
      days.push(rate);
      sessionRates.set(rate.account, days);
    }
  }
  for (const h of hours) {
    if (h.engine !== "claude" && h.engine !== "codex") continue;
    // Unknown attribution is kept separate per provider in the aggregate's key.
    const account = h.account === "unknown" ? `${h.engine}:unknown` : h.account;
    const observation = observations.get(account);
    const week = observation ? windowStart(observation,"weekly",now) : null;
    const session = observation && h.engine === "claude" ? windowStart(observation,"session",now) : null;
    let row = result.get(account);
    if (!row) {
      row = { task: task.id, account, engine: h.engine, tokens: 0, unpriced_tokens: 0, weight: 0, rated_weight: 0,
        weekly_pp: null, window_start: week, window_pp: null, session_start: session, session_pp: null,
        first_hour: h.hour, last_hour: h.hour, floor: countedFrom !== null && Date.parse(task.createdAt) < countedFrom
          ? "before-counting" : null, computed_at: now,
        api_usd: null, api_priced_tokens: 0, unpriced_models: "[]" };
      result.set(account,row);
    }
    const counts = countsFromRow(h), tokens = tokenTotal(counts);
    const cost = apiCost(h.model, h.tier, counts);
    const weight = meterCost(h.model, h.tier, h.engine, counts, cost);
    row.tokens += tokens; row.first_hour = Math.min(row.first_hour,h.hour); row.last_hour = Math.max(row.last_hour,h.hour);
    if (cost !== null) {
      row.api_usd = (row.api_usd ?? 0) + cost;
      row.api_priced_tokens += tokens;
    } else if (tokens > 0) {
      row.unpriced_tokens += tokens;
      // A bounded sample names unpriced models even when a task has many.
      const models: string[] = JSON.parse(row.unpriced_models);
      if (models.length < 4 && /^[a-z0-9][a-z0-9._-]{0,119}$/i.test(h.model)
        && h.model !== "unknown" && !models.includes(h.model)) row.unpriced_models = JSON.stringify([...models, h.model]);
    }
    if (weight === null) continue;
    row.weight += weight;
    const day = utcDay(h.hour*HOUR);
    const weekly = weeklyRates.get(`${account}|${day}`);
    if (weekly?.rate != null) {
      // Older Codex rates were calibrated in API dollars, with Ultrafast
      // weighted at Fast. Keep their measured contribution in that unit.
      const calibratedWeight = h.engine === "codex" && weekly.meter_version === null
        ? apiCost(h.model, priceTier(h.tier) === "ultrafast" ? "fast" : h.tier, counts) : weight;
      if (calibratedWeight !== null) {
        const points = calibratedWeight * weekly.rate;
        row.rated_weight += weight;
        row.weekly_pp = (row.weekly_pp ?? 0) + points;
        if (week !== null && h.hour >= Math.floor(week*1000/HOUR)) row.window_pp = (row.window_pp ?? 0) + points;
      }
    }
    const sessionRate = nearestRate(sessionRates.get(account) ?? [],day);
    if (sessionRate !== null && session !== null && h.hour >= Math.floor(session*1000/HOUR)) row.session_pp = (row.session_pp ?? 0) + weight*sessionRate;
  }
  return [...result.values()];
}

function sumOptional(a: number | null | undefined, b: number | null | undefined): number | null {
  return a == null && b == null ? null : (a ?? 0) + (b ?? 0);
}

function retainExpiredContributions(current: SpendRow[], expired: readonly SpendRow[]): SpendRow[] {
  const merged = new Map(current.map(row => [row.account,row]));
  for (const prior of expired) {
    const next = merged.get(prior.account);
    if (!next) { merged.set(prior.account,prior); continue; }
    merged.set(prior.account,{
      ...next, tokens: prior.tokens + next.tokens, unpriced_tokens: prior.unpriced_tokens + next.unpriced_tokens,
      weight: prior.weight + next.weight, rated_weight: prior.rated_weight + next.rated_weight,
      weekly_pp: sumOptional(prior.weekly_pp, next.weekly_pp),
      api_usd: sumOptional(prior.api_usd, next.api_usd),
      api_priced_tokens: prior.api_priced_tokens + next.api_priced_tokens,
      unpriced_models: JSON.stringify([...new Set<string>([...JSON.parse(prior.unpriced_models), ...JSON.parse(next.unpriced_models)])].slice(0, 4)),
      first_hour: Math.min(prior.first_hour,next.first_hour), last_hour: Math.max(prior.last_hour,next.last_hour),
      floor: prior.floor === "before-counting" || next.floor === "before-counting" ? "before-counting" : null,
    });
  }
  return [...merged.values()];
}

/** The explicit owner index is required: SQLite otherwise chooses a host-wide primary-key scan. */
export function ownerHoursSql(owner: string, cursor: SQLQueryBindings[] | null, limit: number) {
  const pipeline = owner.startsWith("p:");
  const index = pipeline ? "usage_hours_pipeline" : "usage_hours_conversation";
  const filter = pipeline ? "pipeline=?" : "conversation=? AND pipeline IS NULL AND role != 'orchestrator'";
  return { sql: `SELECT * FROM usage_hours INDEXED BY ${index} WHERE host='' AND ${filter}
    ${cursor ? "AND (hour,conversation,model,tier,account) > (?,?,?,?,?)" : ""}
    ORDER BY hour,conversation,model,tier,account LIMIT ?`, binds: [owner.slice(2),...(cursor ?? []),limit] as SQLQueryBindings[] };
}

/** Work is durable and bounded: 200 seed rows, 256 changes, 500 dirty owners,
 * 100 tasks, 2k owner pages and 50k hour rows. */
export function refreshTaskLimitSpend(store: ActivityStore, overrides: Partial<SpendDependencies> = {}) {
  return activityOperation("activity.limit-spend", async () => {
    const deps = { ...production,...overrides }, db = store.db, now = deps.now(), source = deps.source(), pipelineSource = deps.pipelineSource?.() ?? null;
    let meta = metaRead(db);
    const hour = Math.floor(now/HOUR);
    const versionChanged = meta.estimate_version !== ESTIMATE_VERSION;
    if (meta.seed === "done" && !db.query("SELECT 1 FROM limit_spend_dirty LIMIT 1").get()
      && (!source || (source.revision() === meta.task_revision && !meta.task_key))
      && (!pipelineSource || (meta.pipeline_seed === "done" && pipelineSource.revision() === meta.pipeline_revision && !meta.pipeline_key))
      && !versionChanged && meta.estimate_cursor === null && meta.aggregate_schema >= 2 && meta.rate_schema >= LIMIT_RATE_SCHEMA && !db.query("SELECT 1 FROM limit_spend_rate_changes LIMIT 1").get() && meta.rates_hour === hour) return { tasks: 0, rows: 0 };
    const write = async (work: () => void) => { await waitForStateLock("activity.limit-spend", () => store.transaction(work)); await yieldLoop(); };
    if (meta.rate_schema < LIMIT_RATE_SCHEMA && !await invalidateUnattributedCodexRates(db, write)) return { tasks: 0, rows: 0 };
    const estimateCursor = versionChanged ? "" : meta.estimate_cursor;
    if (estimateCursor !== null) {
      const rows = db.query<{ task: string }, [string]>(
        "SELECT DISTINCT task FROM task_limit_spend WHERE task>? ORDER BY task LIMIT 200").all(estimateCursor);
      await write(() => {
        for (const row of rows) dirty(db, `t:${row.task}`, now);
        db.query("UPDATE limit_spend_meta SET estimate_version=?,estimate_cursor=?,rates_hour=CASE WHEN estimate_version<>? THEN -1 ELSE rates_hour END WHERE singleton=1")
          .run(ESTIMATE_VERSION, rows.length < 200 ? null : rows.at(-1)!.task, ESTIMATE_VERSION);
      });
      meta = metaRead(db);
    }
    if (meta.aggregate_schema < 2 && meta.aggregate_cursor !== "~") {
      const rows=db.query<{task:string},[string]>("SELECT DISTINCT task FROM task_limit_spend WHERE task>? ORDER BY task LIMIT 200").all(meta.aggregate_cursor);
      await write(()=>{
        for(const row of rows) dirty(db,`t:${row.task}`,now);
        db.query("UPDATE limit_spend_meta SET aggregate_cursor=? WHERE singleton=1").run(rows.length<200?"~":rows.at(-1)!.task);
      });
      meta=metaRead(db);
    }
    if (meta.seed.startsWith("tasks:")) {
      const revision = source?.revision() ?? 0;
      const after = meta.seed.slice(6) || "t:", rows = source?.keyRange(after,"t:\uffff",200) ?? [];
      await write(() => {
        if (meta.task_revision < 0) db.query("UPDATE limit_spend_meta SET task_revision=?,task_key='' WHERE singleton=1").run(revision);
        for (const task of rows) mapTask(db,task,now,true);
        db.query("UPDATE limit_spend_meta SET seed=? WHERE singleton=1").run(rows.length < 200 ? "lanes:" : `tasks:t:${rows.at(-1)!.id}`);
      });
    } else if (meta.seed.startsWith("lanes:")) {
      const rows = db.query<{ pipeline: string }, [string]>(`SELECT DISTINCT pipeline FROM usage_hours INDEXED BY usage_hours_pipeline
        WHERE host='' AND pipeline IS NOT NULL AND pipeline > ? ORDER BY pipeline LIMIT 200`).all(meta.seed.slice(6));
      await write(() => {
        for (const r of rows) dirty(db,`p:${r.pipeline}`,now);
        db.query("UPDATE limit_spend_meta SET seed=? WHERE singleton=1").run(rows.length < 200 ? "sweep:" : `lanes:${rows.at(-1)!.pipeline}`);
      });
    } else if (meta.seed.startsWith("sweep:")) {
      // A change-log truncation can hide deletions; revisit old mappings in key order as well.
      const rows = db.query<{ task: string }, [string,string]>(`SELECT task FROM (
        SELECT task FROM (SELECT DISTINCT task FROM task_spend_owners INDEXED BY task_spend_owners_task WHERE task > ? ORDER BY task LIMIT 200)
        UNION SELECT task FROM (SELECT DISTINCT task FROM task_limit_spend WHERE task > ? ORDER BY task LIMIT 200)
      ) ORDER BY task LIMIT 200`).all(meta.seed.slice(6),meta.seed.slice(6));
      await write(() => {
        for (const r of rows) db.query("INSERT OR IGNORE INTO limit_spend_dirty VALUES(?,?)").run(`t:${r.task}`,now);
        db.query("UPDATE limit_spend_meta SET seed=? WHERE singleton=1").run(rows.length < 200 ? "done" : `sweep:${rows.at(-1)!.task}`);
      });
    }
    meta = metaRead(db);
    if (source && meta.seed === "done") {
      const page = source.changesAfter(meta.task_revision,meta.task_key,256);
      await write(() => {
        if (meta.task_revision < page.changeFloor) {
          db.exec("UPDATE limit_spend_meta SET seed='tasks:',task_revision=-1,task_key='' WHERE singleton=1"); return;
        }
        for (const e of page.entries) {
          if (!e.key.startsWith("t:")) continue;
          const task = e.valueJson && e.operation !== "delete" ? source.parse(e.valueJson) : null;
          if (task) mapTask(db,task,now); else deleteTask(db,e.key.slice(2));
        }
        const last = page.entries.at(-1);
        db.query("UPDATE limit_spend_meta SET task_revision=?,task_key=? WHERE singleton=1").run(
          page.entries.length < 256 ? page.revision : last!.revision, page.entries.length < 256 ? "" : last!.key);
      });
    }
    if (pipelineSource) {
      meta = metaRead(db);
      if (meta.pipeline_seed.startsWith("seed:")) {
        if (meta.pipeline_revision < 0) {
          const revision = pipelineSource.revision();
          await write(() => db.query("UPDATE limit_spend_meta SET pipeline_revision=?,pipeline_key='',pipeline_seed='seed:' WHERE singleton=1").run(revision));
          meta = metaRead(db);
        }
        const after = meta.pipeline_seed.slice(5);
        const rows = db.query<{ pipeline: string }, [string]>(`SELECT DISTINCT pipeline FROM usage_hours INDEXED BY usage_hours_pipeline
          WHERE host='' AND pipeline IS NOT NULL AND pipeline > ? ORDER BY pipeline LIMIT 200`).all(after);
        await write(() => {
          for (const row of rows) dirty(db,`p:${row.pipeline}`,now);
          db.query("UPDATE limit_spend_meta SET pipeline_seed=? WHERE singleton=1").run(rows.length < 200 ? "done" : `seed:${rows.at(-1)!.pipeline}`);
        });
      }
      meta = metaRead(db);
      if (meta.pipeline_seed === "done") {
        const page = pipelineSource.changesAfter(meta.pipeline_revision,meta.pipeline_key,256);
        await write(() => {
          if (meta.pipeline_revision < page.changeFloor) {
            db.query("UPDATE limit_spend_meta SET pipeline_revision=?,pipeline_key='',pipeline_seed='seed:' WHERE singleton=1").run(page.revision);
            return;
          }
          for (const entry of page.entries) {
            if (entry.operation === "upsert" && entry.valueJson) pipelineSource.parse(entry.valueJson);
            dirty(db,`b:${entry.key}`,now);
          }
          const last = page.entries.at(-1);
          db.query("UPDATE limit_spend_meta SET pipeline_revision=?,pipeline_key=? WHERE singleton=1").run(
            page.entries.length < 256 ? page.revision : last!.revision,
            page.entries.length < 256 ? "" : last!.key);
        });
      }
    }
    const owners = db.query<Dirty, []>("SELECT key,at FROM limit_spend_dirty WHERE key < 't:' ORDER BY key LIMIT 500").all();
    for (const owner of owners) {
      await waitForStateLock("activity.limit-spend", () => {
        // Each lock attempt reads state before entering the activity transaction.
        const binding = owner.key.startsWith("b:"), pipelineOwner = owner.key.startsWith("p:") || binding;
        const pipelineId = owner.key.slice(2), tasks = pipelineOwner ? deps.pipelineTasks(pipelineId) : null;
        store.transaction(() => {
          if (tasks) replaceOwner(db,binding ? `p:${pipelineId}` : owner.key,tasks,now,!binding);
          else for (const task of ownerTasks(db,owner.key)) dirty(db,`t:${task}`,now);
          clearDirty(db,owner);
        });
      });
      await yieldLoop();
    }
    const observations = deps.observations(), coverage = usageMeta(db);
    if (meta.rates_hour !== hour || meta.rate_schema < LIMIT_RATE_SCHEMA) {
      await refreshLimitRates(db,now,{ history: deps.history,observations,
        coverageComplete: coverage?.complete === 1 && coverage.pending_bytes === 0, revalidateFrozen: meta.rate_schema < 3, reprice: meta.rates_hour < 0 },write);
      await write(() => { db.query("UPDATE limit_spend_meta SET rates_hour=?,rate_schema=? WHERE singleton=1").run(hour, LIMIT_RATE_SCHEMA); });
      meta = metaRead(db);
    }
    const rateChanges = db.query<{ account: string; day: string; task_cursor: string }, []>("SELECT * FROM limit_spend_rate_changes ORDER BY account,day LIMIT 20").all();
    for (const change of rateChanges) {
      const dayStart = Math.floor(Date.parse(`${change.day}T00:00:00Z`) / HOUR), dayEnd = dayStart + DAY/HOUR;
      const tasks = change.day === "*"
        ? db.query<{ task: string }, [string,string]>(`SELECT task FROM task_limit_spend INDEXED BY task_limit_spend_account
          WHERE account=? AND task>? ORDER BY task LIMIT 100`).all(change.account, change.task_cursor)
        : db.query<{ task: string }, [string,number,number,string]>(`SELECT task FROM task_limit_spend INDEXED BY task_limit_spend_account
          WHERE account=? AND first_hour < ? AND last_hour >= ? AND task>? ORDER BY task LIMIT 100`).all(change.account,dayEnd,dayStart,change.task_cursor);
      await write(() => {
        for (const row of tasks) {
          dirty(db,`t:${row.task}`,now);
          if (change.day === "*") db.query(`UPDATE task_limit_spend SET rated_weight=0,weekly_pp=NULL,window_pp=NULL,session_pp=NULL
            WHERE task=? AND account=?`).run(row.task,change.account);
        }
        if (tasks.length < 100) db.query("DELETE FROM limit_spend_rate_changes WHERE account=? AND day=? AND task_cursor=?").run(change.account,change.day,change.task_cursor);
        else db.query("UPDATE limit_spend_rate_changes SET task_cursor=? WHERE account=? AND day=? AND task_cursor=?")
          .run(tasks.at(-1)!.task,change.account,change.day,change.task_cursor);
      });
    }
    const rateCache = new Map<string, LimitRate[]>();
    const accountRates = (account: string) => {
      const hit = rateCache.get(account); if (hit) return hit;
      const since = utcDay(now-93*DAY);
      const rows = db.query<LimitRate,[string,string]>("SELECT * FROM usage_limit_rates WHERE account=? AND window IN ('weekly','session') AND day>=?").all(account,since);
      for (const window of ["weekly", "session"]) {
        const prior = db.query<LimitRate,[string,string,string]>("SELECT * FROM usage_limit_rates WHERE account=? AND window=? AND day<? ORDER BY day DESC LIMIT 1").get(account,window,since);
        if (prior) rows.push(prior);
      }
      if (rateCache.size >= 128) rateCache.delete(rateCache.keys().next().value!);
      rateCache.set(account,rows); return rows;
    };
    const todo = db.query<Dirty, []>(TASK_SPEND_DUE_SQL).all();
    const tasks = new Map(deps.tasks(new Set(todo.map(d=>d.key.slice(2)))).map(t=>[t.id,t]));
    const countedFrom = coverage?.counted_from ?? null;
    const signature = JSON.stringify([hour, meta.rate_schema, ESTIMATE_VERSION, countedFrom,
      [...observations].sort(([a],[b])=>a.localeCompare(b)).map(([key,o])=>[key,o.weekly?.resetsAt,o.session?.resetsAt])]);
    let visited = 0, completed = 0, ownerBudget = 2000;
    for (const item of todo) {
      if (visited >= 50000 || ownerBudget <= 0) break;
      const id = item.key.slice(2), task = tasks.get(id);
      if (!task) { await write(() => deleteTask(db,id)); continue; }
      const progress = db.query<{ stamp: number; signature: string; owner: string; cursor: string | null; rows: string }, [string]>("SELECT * FROM task_spend_progress WHERE task=?").get(id);
      let owner = "", cursor: SQLQueryBindings[] | null = null, result: SpendRow[] = [];
      if (progress?.stamp === item.at && progress.signature === signature) {
        owner = progress.owner; cursor = progress.cursor ? JSON.parse(progress.cursor) : null; result = JSON.parse(progress.rows);
      }
      let done = false;
      while (visited < 50000 && ownerBudget-- > 0) {
        if (!cursor) owner = db.query<{ owner: string }, [string,string]>("SELECT owner FROM task_spend_owners WHERE task=? AND owner > ? ORDER BY owner LIMIT 1").get(id,owner)?.owner ?? "";
        if (!owner) { done = true; break; }
        const limit = Math.min(1000,50000-visited), query = ownerHoursSql(owner,cursor,limit);
        const hours = db.query<SpendHour,SQLQueryBindings[]>(query.sql).all(...query.binds);
        visited += hours.length;
        const rates = [...new Set(hours.map(h => h.account === "unknown" ? `${h.engine}:unknown` : h.account))].flatMap(accountRates);
        result = computeTaskRows(task,hours,rates,observations,countedFrom,now,result);
        const last = hours.at(-1);
        cursor = hours.length === limit && last ? [last.hour,last.conversation,last.model,last.tier,last.account] : null;
        await yieldLoop();
      }
      await waitForStateLock("activity.limit-spend", () => {
        const latest = deps.tasks(new Set([id]))[0];
        store.transaction(() => {
          if (!latest) { deleteTask(db,id); return; }
          if (latest.createdAt !== task.createdAt || JSON.stringify(assignmentOwners(latest)) !== JSON.stringify(assignmentOwners(task))) {
            mapTask(db,latest,now,true); db.query("DELETE FROM task_spend_progress WHERE task=?").run(id); return;
          }
          const current = db.query<Dirty,[string]>("SELECT key,at FROM limit_spend_dirty WHERE key=?").get(item.key);
          if (current?.at !== item.at) return;
          const currentCoverage = usageMeta(db);
          if ((currentCoverage?.counted_from ?? null) !== countedFrom) {
            dirty(db,item.key,now); db.query("DELETE FROM task_spend_progress WHERE task=?").run(id); return;
          }
          if (db.query(`SELECT 1 FROM task_spend_owners o JOIN limit_spend_dirty d ON d.key=o.owner WHERE o.task=? LIMIT 1`).get(id)) {
            // An owner gained tokens after this pass took its dirty-owner page.
            dirty(db,item.key,now); db.query("DELETE FROM task_spend_progress WHERE task=?").run(id); return;
          }
          if (!done) {
            db.query("INSERT OR REPLACE INTO task_spend_progress VALUES(?,?,?,?,?,?)").run(id,item.at,signature,owner,cursor ? JSON.stringify(cursor) : null,JSON.stringify(result)); return;
          }
          const retained = db.query<SpendRow,[string,number]>("SELECT * FROM task_limit_spend WHERE task=? AND last_hour < ?")
            .all(id,Math.floor((now-92*DAY)/HOUR));
          const finalRows = retainExpiredContributions(result,retained);
          db.query("DELETE FROM task_limit_spend WHERE task=?").run(id);
          const put = db.query(`INSERT INTO task_limit_spend
            (task,account,engine,tokens,unpriced_tokens,weight,rated_weight,weekly_pp,window_start,window_pp,session_start,session_pp,
             first_hour,last_hour,floor,computed_at,api_usd,api_priced_tokens,unpriced_models) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
          for (const r of finalRows) put.run(r.task,r.account,r.engine,r.tokens,r.unpriced_tokens,r.weight,r.rated_weight,r.weekly_pp,
            r.window_start,r.window_pp,r.session_start,r.session_pp,r.first_hour,r.last_hour,r.floor === "before-counting" ? r.floor : null,
            now,r.api_usd,r.api_priced_tokens,r.unpriced_models);
          db.query("DELETE FROM task_spend_progress WHERE task=?").run(id); clearDirty(db,item); completed++;
        });
      });
      await yieldLoop();
    }
    meta=metaRead(db);
    if(meta.aggregate_schema<2&&meta.aggregate_cursor==="~"&&!db.query("SELECT 1 FROM limit_spend_dirty LIMIT 1").get())
      await write(()=>db.query("UPDATE limit_spend_meta SET aggregate_schema=2,aggregate_cursor='' WHERE singleton=1").run());
    return { tasks: completed, rows: visited };
  });
}

/** One primary-key read for the requested cards. Account detail is removed on the server. */
export function readTaskLimitSpend(db: Database | null, ids: readonly string[], viewer: { canChoose?: boolean }, overrides: Partial<SpendDependencies> = {}): TaskSpendResponse {
  const deps = { ...production,...overrides }, now = deps.now();
  const body: TaskSpendResponse = { generatedAt: now, tasks: Object.create(null) };
  if (!db || !ids.length || db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('task_limit_spend','limit_spend_meta')").get()!.n !== 2) return body;
  const metaColumns=new Set(db.query<{name:string},[]>("PRAGMA table_info(limit_spend_meta)").all().map(row=>row.name));
  if(!metaColumns.has("aggregate_schema")||!db.query("SELECT 1 FROM limit_spend_meta WHERE singleton=1 AND schema=1 AND aggregate_schema>=2").get()) return body;
  const unique = [...new Set(ids)].slice(0,400), known = deps.tasks(new Set(unique));
  const observations = deps.observations(), labels = viewer.canChoose ? deps.labels() : new Map<string,string>();
  for (const task of known) body.tasks[task.id] = { providers: [] };
  const rows = db.query<SpendRow,SQLQueryBindings[]>(`SELECT * FROM task_limit_spend WHERE task IN (${unique.map(()=>"?").join(",")})`).all(...unique);
  const planByAccount = new Map<string, { plan: string | null; tier: string | null }>();
  // Read-only requests can arrive before the background writer adds columns.
  const lastPlan = metaColumns.has("estimate_version")
    ? db.query<{ plan: string; plan_tier: string | null }, [string]>(`SELECT plan,plan_tier FROM usage_limit_rates
      WHERE account=? AND plan IS NOT NULL ORDER BY day DESC, computed_at DESC LIMIT 1`) : null;
  const accountPlan = (account: string) => {
    let info = planByAccount.get(account);
    if (info) return info;
    const observation = observations.get(account);
    const prior = observation?.plan && observation.planTier ? null : lastPlan?.get(account);
    const plan = observation?.plan ?? prior?.plan ?? null;
    info = { plan, tier: observation?.planTier ?? (prior?.plan === plan ? prior?.plan_tier ?? null : null) };
    planByAccount.set(account, info);
    return info;
  };
  const contributions = new Map<TaskSpendProvider, { measured: number; planned: number }>();
  for (const row of rows) {
    const into = body.tasks[row.task];
    if (!into || row.tokens <= 0) continue;
    let provider = into.providers.find(p => p.engine === row.engine);
    if (!provider) {
      provider = { engine: row.engine, weeklyPp: 0, tokens: 0, bound: "tokens", floor: null, basis: null, range: null,
        budgets: [], outsideBudget: false, apiUsd: null, apiPricedTokens: 0, unpricedModels: [], unpricedTokens: 0, issues: [],
        accounts: viewer.canChoose ? [] : null };
      into.providers.push(provider);
      contributions.set(provider, { measured: 0, planned: 0 });
    }
    const { plan, tier } = accountPlan(row.account);
    const budget = planBudget(row.engine, plan, tier);
    const fixed = !planWithoutFixedLimit(plan);
    const share = estimateShare(row.weight, fixed ? row.rated_weight : 0, fixed ? row.weekly_pp : null, budget);
    const weights = contributions.get(provider)!;
    weights.measured += share.measured;
    weights.planned += share.planned;
    if (share.weeklyPp !== null) provider.weeklyPp += share.weeklyPp;
    if (share.range) {
      provider.range ??= { low: 0, high: 0 };
      provider.range.low += share.range.low;
      provider.range.high += share.range.high;
    }
    if (budget && !provider.budgets.some(b => b.low === budget.low && b.high === budget.high && b.grade === budget.grade)) provider.budgets.push(budget);
    if (share.missingBudget && (row.weight > 0 || row.unpriced_tokens < row.tokens)) {
      const issue = !fixed ? "noFixedLimit" : plan ? "noPlanBudget" : "planMissing";
      if (!provider.issues.includes(issue)) provider.issues.push(issue);
    }
    provider.outsideBudget ||= share.outsideBudget;
    provider.tokens += row.tokens;
    provider.apiUsd = sumOptional(provider.apiUsd, row.api_usd);
    provider.apiPricedTokens += row.api_priced_tokens ?? 0;
    provider.unpricedTokens += row.unpriced_tokens;
    const unpricedModels: string[] = row.unpriced_tokens > 0 ? JSON.parse(row.unpriced_models ?? "[]") : [];
    for (const model of unpricedModels) {
      if (provider.unpricedModels.length < 4 && !provider.unpricedModels.includes(model)) provider.unpricedModels.push(model);
    }
    if (row.floor === "before-counting") provider.floor = "before-counting";
    if (!provider.accounts) continue;
    const observation = observations.get(row.account), start = observation ? windowStart(observation,"weekly",now) : null;
    const session = observation ? windowStart(observation,"session",now) : null;
    const same = (a: number | null,b: number | null) => a !== null && b !== null && Math.abs(a-b) <= 300;
    const account: TaskSpendAccount = {
      key: row.account.endsWith(":unknown") ? "unknown" : row.account,
      label: labels.get(row.account) ?? row.account.slice(row.account.indexOf(":")+1),
      plan, planTier: tier, weeklyPp: share.weeklyPp, basis: share.basis, range: share.range, budget, apiUsd: row.api_usd ?? null, tokens: row.tokens,
      week: observation?.weekly ? { usedPercent: observation.weekly.usedPercent,
        taskPp: start === null ? null : same(start,row.window_start) ? row.window_pp : (row.last_hour+1)*3600 <= start ? 0 : null } : null,
      sessionPp: row.engine === "claude" && same(session,row.session_start) ? row.session_pp : null,
    };
    provider.accounts.push(account);
  }
  for (const summary of Object.values(body.tasks)) {
    summary.providers.sort((a,b)=>a.engine === b.engine ? 0 : a.engine === "claude" ? -1 : 1);
    for (const p of summary.providers) {
      const weights = contributions.get(p)!;
      p.basis = shareBasis(weights.measured, weights.planned);
      if (p.basis) p.bound = p.floor ? "floor" : "approx";
      p.accounts?.sort((a,b)=>Number(b.weeklyPp !== null)-Number(a.weeklyPp !== null) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
    }
  }
  return body;
}
export function taskSpendResponse(ids: readonly string[], viewer: { canChoose?: boolean }): TaskSpendResponse {
  const store = ActivityStore.openReadOnly(activityStorePath());
  try { return readTaskLimitSpend(store?.db ?? null,ids,viewer); } finally { store?.close(); }
}
