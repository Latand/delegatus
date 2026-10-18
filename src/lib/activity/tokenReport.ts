import type { SQLQueryBindings } from "bun:sqlite";
import { statePath } from "@/lib/configDir";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { memberInitials } from "@/lib/team/contract";
import { existingTeamStore } from "@/lib/team/store";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { ActivityStore, activityStorePath } from "./store";
import { ActivityMemberForbidden, catalogProjectNames, type ActivityRequestViewer } from "./report";
import { readActivitySettings } from "./settings";
import { parseActivityDates, shiftDay, dateRangeDays, weekOfDay, type TokenPreset } from "./range";
import { addTokens, emptyTokens, tokenTotal, type TokenCounts } from "./tokenUsage";
import { countsFromRow, DAY, HOUR, SUM_TOKENS, usageMeta, usageZones, type UsageMeta } from "./tokenStore";

export const TOKEN_DIMENSIONS = ["kind", "model", "role", "project", "member", "account", "engine"] as const;
export type TokenDimension = typeof TOKEN_DIMENSIONS[number];
type GroupDimension = Exclude<TokenDimension, "kind">;
export interface TokenCostBasis { model: string; tier: string; engine: string; counts: TokenCounts }
export interface TokenListRow { key: string; name: string | null; counts: TokenCounts }
export interface ActivityTokensResponse {
  generatedAt: number;
  params: { from: string; to: string; preset: TokenPreset | null; tz: string; bucket: "hour" | "day" | "week";
    stack: TokenDimension; list: GroupDimension; filters: Partial<Record<"role" | "model" | "account" | "engine", string>> };
  scope: { project: string; name: string | null } | null;
  member: { selection: "all" | "member"; memberId: string | null; canChoose: boolean;
    members: Array<{ id: string; name: string | null; color: string | null; initials: string | null; self: boolean }> };
  coverage: { countedFrom: number | null; complete: boolean; pendingBytes: number; skippedOld: number; malformed: number; branchSkipped: number;
    engines: Array<{ engine: string; read: boolean }>; unrecorded: Array<"claude-compaction">; memberRule: "launch-chain";
    daysZone?: { zone: string; before: string }; roundedHourEdges?: boolean };
  totals: TokenCounts;
  /** Per model AND tier AND kind, so clients can apply dated API prices without guessing. */
  costBasis: TokenCostBasis[];
  series: Array<{ start: number; end: number; counted: boolean; parts: Array<{ key: string; counts: TokenCounts }> }>;
  /** Top 12 by total (500 with `top=all`), then one row keyed "other". */
  list: TokenListRow[];
  previous?: { from: string; to: string; totals: TokenCounts; costBasis: TokenCostBasis[] };
}
interface Dependencies {
  now(): number;
  file(): string;
  tz(): string;
  aliases(): Record<string, string>;
  canonical(project: string): string;
  projectNames(): Promise<ReadonlyMap<string, string>>;
  roster(): ActivityTokensResponse["member"]["members"];
  accounts(): ReadonlyMap<string, string>;
  measured?(query: "totals" | "series" | "list" | "previous", ms: number, plan: () => unknown,
    scheduling: { cpuMs: number; involuntarySwitches: number }): void;
}
const production: Dependencies = {
  now: Date.now, file: activityStorePath, tz: () => readActivitySettings(statePath("activity")).tz,
  aliases: () => projectAliasSnapshot().aliases, canonical: canonicalProject, projectNames: catalogProjectNames,
  roster: () => (existingTeamStore()?.members() ?? []).map(m => ({ id: m.id, name: m.name, color: m.color, initials: memberInitials(m.name), self: false })),
  accounts: () => new Map([...listClaudeAccounts(), ...listCodexAccounts()].map(a => [a.id, a.label])),
};
type CacheEntry = { key: string; body: ActivityTokensResponse; at: number };
const shared = globalThis as typeof globalThis & { __delegatusActivityTokensCache?: Map<string, CacheEntry> };
const cache = shared.__delegatusActivityTokensCache ??= new Map();
const CACHE_LIMIT = 16;
const LIST_LIMIT = 12;
const LIST_ALL_LIMIT = 500;
// Decoration and coverage age also refresh without a token write.
const CACHE_TTL_MS = 60_000;
const safeValue = (v: string | null) => v && v.length <= 300 && !/[\p{Cc}]/u.test(v) ? v : null;
const sqlString = (v: string) => `'${v.replaceAll("'", "''")}'`;
type CountRow = { requests: number; input: number; cache_read: number; cache_write: number; cache_write_1h: number; output: number; reasoning: number };
type BasisRow = CountRow & { model: string; tier: string; engine: string; key?: string; bucket?: string | number };
const basis = (r: BasisRow): TokenCostBasis => ({ model: r.model, tier: r.tier, engine: r.engine, counts: countsFromRow(r) });
const sum = (rows: readonly TokenCostBasis[]) => { const counts = emptyTokens(); for (const row of rows) addTokens(counts, row.counts); return counts; };

/** Three indexed aggregate queries; request-time work never opens a transcript. */
export async function activityTokensResponse(search: URLSearchParams, viewer: ActivityRequestViewer, overrides: Partial<Dependencies> = {}): Promise<ActivityTokensResponse> {
  const deps = { ...production, ...overrides };
  const stackRaw = search.get("stack"), listRaw = search.get("list");
  const stack: TokenDimension = TOKEN_DIMENSIONS.includes(stackRaw as TokenDimension) ? stackRaw as TokenDimension : "kind";
  const list: GroupDimension = listRaw !== "kind" && TOKEN_DIMENSIONS.includes(listRaw as TokenDimension) ? listRaw as GroupDimension : "model";
  const member = safeValue(search.get("member"));
  /* `top=all` names every listed entry (the project picker's rows), up to a bound. */
  const listLimit = search.get("top") === "all" ? LIST_ALL_LIMIT : LIST_LIMIT;
  const canChoose = viewer.canChoose === true;
  // Authority is checked before opening the store or consulting the shared cache.
  if (!canChoose && (search.has("member") || search.has("account") || stack === "member" || stack === "account" || list === "member" || list === "account")) throw new ActivityMemberForbidden();
  const now = deps.now();
  const range = parseActivityDates(search, now, deps.tz());
  const hoursRetainedFrom = Math.floor((now - 92 * DAY) / HOUR) * HOUR;
  const hourlyAvailable = range.days.length <= 2 && range.days[0]!.start >= hoursRetainedFrom;
  const bucket = hourlyAvailable ? "hour" : range.days.length <= 92 ? "day" : "week";
  const aliases = deps.aliases();
  const project = safeValue(search.get("project"));
  const scoped = project ? deps.canonical(project) : null;
  const filters: ActivityTokensResponse["params"]["filters"] = {};
  for (const dimension of ["role", "model", "account", "engine"] as const) {
    const value = safeValue(search.get(dimension)); if (value) filters[dimension] = value;
  }
  const file = deps.file();
  const store = ActivityStore.openReadOnly(file);
  try {
    // A single WAL snapshot binds the metadata version to all three queries.
    store?.db.exec("BEGIN");
    const meta = store ? usageMeta(store.db) : null;
    const storeId = store?.db.query<{ store_id: string }, []>("SELECT store_id FROM activity_meta WHERE singleton=1").get()?.store_id ?? null;
    const key = JSON.stringify([file, storeId, meta, range.from, range.to, range.tz, range.preset, bucket, stack, list, filters, scoped, member,
      search.get("compare") === "previous", listLimit, aliases, canChoose, viewer.memberId]);
    const cached = cache.get(key);
    if (cached && now - cached.at >= 0 && now - cached.at < CACHE_TTL_MS) {
      cache.delete(key); cache.set(key, cached);
      return structuredClone(cached.body);
    }
    const projectExpression = (column: string) => Object.keys(aliases).length ? `CASE ${column} ${Object.keys(aliases).sort().map(from => `WHEN ${sqlString(from)} THEN ${sqlString(deps.canonical(from))}`).join(" ")} ELSE COALESCE(${column}, '') END` : `COALESCE(${column}, '')`;
    const dimension = (dim: TokenDimension) => dim === "kind" ? "'all'" : dim === "project" ? projectExpression("project") : dim;
    const summaryRead=!hourlyAvailable&&!scoped&&(!member||member==="all")&&Object.keys(filters).length===0;
    const query = <T>(name: "totals" | "series" | "list" | "previous", sql: string, bindings: SQLQueryBindings[]): T[] => {
      const cpu=deps.measured?process.cpuUsage():null;
      const switches=deps.measured?process.resourceUsage().involuntaryContextSwitches:0;
      const start = performance.now();
      const rows = store!.db.query<T, SQLQueryBindings[]>(sql).all(...bindings);
      const elapsed=performance.now()-start;
      if(deps.measured) {
        const used=process.cpuUsage(cpu!);
        deps.measured(name,elapsed,()=>store!.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings),{
          cpuMs:(used.user+used.system)/1000,involuntarySwitches:process.resourceUsage().involuntaryContextSwitches-switches });
      }
      return rows;
    };
    const where = (hours: boolean, from: string, to: string) => {
      const clauses = ["host = ''"];
      const binds: SQLQueryBindings[] = [];
      if (hours) {
        const days = dateRangeDays({ from, to }, range.tz);
        clauses.push("hour >= ? AND hour < ?"); binds.push(Math.floor(days[0]!.start / HOUR), Math.ceil(days.at(-1)!.end / HOUR));
      } else {
        clauses.push("day >= ? AND day <= ?"); binds.push(from, to);
        const zones=meta?usageZones(meta):[range.tz];
        const zoneTerms: string[] = [];
        for (const zone of zones) {
          if (meta?.zone_since && zone !== meta.zone) {
            zoneTerms.push("(zone = ? AND day < ?)"); binds.push(zone, meta.zone_since);
          } else if (!meta?.zone_since && meta?.target_zone === zone && meta.rebuild_since) {
            zoneTerms.push("(zone = ? AND day < ?)"); binds.push(zone, meta.rebuild_since);
          } else {
            zoneTerms.push("zone = ?"); binds.push(zone);
          }
        }
        clauses.push(`(${zoneTerms.join(" OR ")})`);
      }
      if (scoped) {
        const raw = [...new Set([scoped, ...Object.keys(aliases).filter(p => deps.canonical(p) === scoped)])];
        clauses.push(`project IN (${raw.map(() => "?").join(",")})`); binds.push(...raw);
      }
      if (member && member !== "all") { clauses.push("member = ?"); binds.push(member); }
      for (const [field, value] of Object.entries(filters)) { clauses.push(`${field} = ?`); binds.push(value); }
      return { sql: clauses.join(" AND "), binds };
    };
    const totalsRead = (from: string, to: string, name: "totals" | "previous") => {
      if (!meta) return [];
      const useHours = hourlyAvailable && dateRangeDays({ from, to }, range.tz)[0]!.start >= hoursRetainedFrom;
      const w = where(useHours, from, to);
      if (useHours) return query<BasisRow>(name, `SELECT model, tier, engine, ${SUM_TOKENS} FROM usage_hours WHERE ${w.sql} GROUP BY model, tier, engine`, w.binds).map(basis);
      if(summaryRead) return query<BasisRow>(name,`SELECT model,tier,engine,${SUM_TOKENS} FROM usage_summaries
        WHERE ${w.sql} AND dimension='price' GROUP BY key`,w.binds).map(basis);
      return query<BasisRow>(name, `SELECT model, tier, engine, ${SUM_TOKENS} FROM (
        SELECT day, price_key, model, tier, engine, ${SUM_TOKENS} FROM usage_days WHERE ${w.sql} GROUP BY day, price_key
      ) GROUP BY price_key`, w.binds).map(basis);
    };
    const costBasis = totalsRead(range.from, range.to, "totals");
    const totals = sum(costBasis);
    const listRows: TokenListRow[] = [];
    const buckets = new Map<string | number, Map<string, TokenCounts>>();
    if (meta) {
      const w = where(hourlyAvailable, range.from, range.to);
      const listRollup=list==="model"||list==="engine"||list==="project";
      const listSource=listRollup ? `(SELECT day, model, engine, project, ${SUM_TOKENS} FROM usage_days WHERE ${w.sql}
        GROUP BY day, price_key${list==="project"?", project":""})` : "usage_days";
      const listExpression=summaryRead?(list==="project"?projectExpression("key"):"key"):dimension(list);
      const listSQL=hourlyAvailable?`SELECT ${listExpression} AS group_key,${SUM_TOKENS} FROM usage_hours WHERE ${w.sql} GROUP BY group_key`
        :summaryRead?`SELECT ${listExpression} AS group_key,${SUM_TOKENS} FROM usage_summaries WHERE ${w.sql}
        AND dimension=${sqlString(list)} GROUP BY group_key`:`SELECT ${listExpression} AS group_key, ${SUM_TOKENS} FROM ${listSource}
        ${listRollup?"":`WHERE ${w.sql}`} GROUP BY group_key`;
      const rows = query<CountRow & { group_key: string }>("list",listSQL,w.binds);
      for (const row of rows) listRows.push({ key: row.group_key, name: null, counts: countsFromRow(row) });
      listRows.sort((a, b) => tokenTotal(b.counts) - tokenTotal(a.counts) || a.key.localeCompare(b.key));
      const hours = bucket === "hour";
      const seriesWhere = where(hours, range.from, range.to);
      const bucketSQL = hours ? "hour" : bucket === "week" ? "week" : "day";
      const rollup = !hours && (stack === "kind" || stack === "model" || stack === "engine" || stack === "project");
      const source = rollup
        ? `(SELECT day, week, model, engine, project, ${SUM_TOKENS} FROM usage_days WHERE ${seriesWhere.sql}
          GROUP BY day${stack === "kind" ? "" : ", price_key"}${stack === "project" ? ", project" : ""})` : hours ? "usage_hours" : "usage_days";
      const seriesSummary=summaryRead&&!hours;
      const seriesExpression=stack==="project"?projectExpression("key"):"key";
      const seriesSQL=seriesSummary?`SELECT ${bucketSQL} AS bucket,${seriesExpression} AS key,${SUM_TOKENS}
        FROM usage_summaries WHERE ${seriesWhere.sql} AND dimension=${sqlString(stack==="kind"?"all":stack)} GROUP BY bucket,${seriesExpression}`
        :`SELECT ${bucketSQL} AS bucket, ${dimension(stack)} AS key, ${SUM_TOKENS}
        FROM ${source} ${rollup ? "" : `WHERE ${seriesWhere.sql}`} GROUP BY bucket${stack === "kind" ? "" : ", key"}`;
      const series = query<CountRow & { bucket: string | number; key: string }>("series",seriesSQL,seriesWhere.binds);
      const ranks = new Map<string, number>();
      for (const row of series) ranks.set(row.key, (ranks.get(row.key) ?? 0) + tokenTotal(countsFromRow(row)));
      const leaders = new Set([...ranks].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([key]) => key));
      for (const row of series) {
        const parts = buckets.get(row.bucket) ?? new Map<string, TokenCounts>(); buckets.set(row.bucket, parts);
        const key = leaders.has(row.key) ? row.key : "other";
        const into = parts.get(key) ?? emptyTokens(); addTokens(into, countsFromRow(row)); parts.set(key, into);
      }
    }
    const selected = listRows.slice(0, listLimit);
    if (listRows.length > listLimit) { const counts=emptyTokens(); for(const row of listRows.slice(listLimit)) addTokens(counts,row.counts); selected.push({ key: "other", name: null, counts }); }
    const series: ActivityTokensResponse["series"] = [];
    const ranges = new Map<string | number, { start: number; end: number }>();
    if (bucket === "hour") {
      const first = Math.floor(range.days[0]!.start / HOUR);
      const afterLast = Math.ceil(range.days.at(-1)!.end / HOUR);
      for (let key = first; key < afterLast; key++) ranges.set(key, { start: key * HOUR, end: (key + 1) * HOUR });
    } else for (const day of range.days) {
      const key = bucket === "week" ? weekOfDay(day.date) : day.date; const into = ranges.get(key); ranges.set(key, { start: into?.start ?? day.start, end: day.end });
    }
    for (const [key, span] of ranges) series.push({ ...span, counted: meta?.counted_from != null && span.end > meta.counted_from,
      parts: [...(buckets.get(key) ?? [])].sort(([a],[b]) => a.localeCompare(b)).map(([key, counts]) => ({ key, counts })) });
    const previous = search.get("compare") === "previous" ? (() => {
      const to = shiftDay(range.from, -1), from = shiftDay(to, 1 - range.days.length);
      const costBasis = totalsRead(from, to, "previous"); return { from, to, totals: sum(costBasis), costBasis };
    })() : undefined;
    // Release the WAL snapshot before resolving asynchronous display decoration.
    store?.db.exec("COMMIT");
    const names = await deps.projectNames();
    const roster = canChoose ? deps.roster().map(m => ({ ...m, self: m.id === viewer.memberId })) : [];
    const accounts = canChoose && list === "account" ? deps.accounts() : new Map<string, string>();
    for (const row of selected) row.name = list === "project" ? names.get(row.key) ?? null : list === "member" ? roster.find(m => m.id === row.key)?.name ?? null : list === "account" ? accounts.get(row.key) ?? null : null;
    const body: ActivityTokensResponse = { generatedAt: now, params: { from: range.from, to: range.to, preset: range.preset, tz: range.tz, bucket, stack, list, filters },
      scope: scoped ? { project: scoped, name: names.get(scoped) ?? null } : null,
      member: { selection: member && member !== "all" ? "member" : "all", memberId: member && member !== "all" ? member : null, canChoose, members: roster },
      coverage: coverage(meta, range.from, range.tz), totals, costBasis, series, list: selected, ...(previous ? { previous } : {}) };
    cache.set(key, { key, body: structuredClone(body), at: now });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return body;
  } finally {
    if (store) { try { store.db.exec("ROLLBACK"); } catch { /* Snapshot already closed. */ } store.close(); }
  }
}
function coverage(meta: UsageMeta | null, from: string, tz: string): ActivityTokensResponse["coverage"] {
  return { countedFrom: meta?.counted_from ?? null, complete: meta?.complete === 1, pendingBytes: meta?.pending_bytes ?? 0,
    skippedOld: meta?.skipped_old ?? 0, malformed: meta?.malformed ?? 0, branchSkipped: meta?.branch_skipped ?? 0,
    engines: ["claude", "codex", "copilot", "openclaw"].map(engine => ({ engine, read: engine === "claude" || engine === "codex" })),
    unrecorded: ["claude-compaction"], memberRule: "launch-chain",
    ...(meta?.zone_since && from < meta.zone_since ? { daysZone: { zone: meta.previous_zone ?? meta.zone, before: meta.zone_since } }
      : meta && meta.zone !== tz ? { daysZone: { zone: meta.zone, before: "9999-12-31" } } : {}),
    ...(dateRangeDays({ from: "2026-01-01", to: "2026-01-01" }, tz)[0]!.start % HOUR ? { roundedHourEdges: true } : {}) };
}
