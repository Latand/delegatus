import type { Database } from "bun:sqlite";
import { setImmediate as yieldLoop } from "node:timers/promises";
import type { EngineLimits, LimitSample } from "@/lib/types";
import { tokenCost, priceTier } from "./tokenPrices";
import type { TokenCounts } from "./tokenUsage";
import { countsFromRow, DAY, HOUR, SUM_TOKENS } from "./tokenStore";

export type RateWindow = "weekly" | "session";
export interface LimitRate { account: string; window: RateWindow; day: string; rate: number | null; rise: number;
  weight: number; source: "own" | "plan" | "none"; plan: string | null; frozen: number; computed_at: number }
export type SpendObservations = ReadonlyMap<string, EngineLimits>;
export interface RateDependencies { history(): { series: Record<string, LimitSample[]> }; observations: SpendObservations }
export const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

export function limitWeight(model: string, tier: string, engine: string, counts: TokenCounts): number | null {
  return tokenCost(model, engine === "codex" && priceTier(tier) === "ultrafast" ? "fast" : tier, counts);
}
export function risesFromSamples(samples: readonly LimitSample[]): Array<{ t: number; rise: number }> {
  if (!samples.length) return [];
  let level = 100 - samples[0]!.remaining;
  const rises: Array<{ t: number; rise: number }> = [];
  for (let i = 1; i < samples.length; i++) {
    const sample = samples[i]!, v = 100 - sample.remaining;
    const next = samples[i + 1] ? 100 - samples[i + 1]!.remaining : null;
    if (v > level) { rises.push({ t: sample.t, rise: v - level }); level = v; }
    else if (v >= level - 2) continue;
    else if (v <= 5 && next !== null && next <= 8) { rises.push({ t: sample.t, rise: v }); level = v; }
    else if (next !== null && Math.abs(next - level) <= 1) continue;
    else level = v;
  }
  return rises;
}
export const dayRate = (rise: number, weight: number): number | null => rise >= 10 && weight > 0 ? rise / weight : null;
export function planMedian(values: readonly number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a,b) => a-b), mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[mid]! : (ordered[mid-1]! + ordered[mid]!) / 2;
}
/** A stored unknown day remains unknown; only absent days borrow a neighbour. */
export function nearestRate(rows: readonly Pick<LimitRate, "day" | "rate">[], day: string): number | null {
  let earlier: Pick<LimitRate, "day" | "rate"> | undefined, later: typeof earlier;
  for (const row of rows) {
    if (row.day === day) return row.rate;
    if (row.day < day && (!earlier || row.day > earlier.day)) earlier = row;
    if (row.day > day && (!later || row.day < later.day)) later = row;
  }
  return (earlier ?? later)?.rate ?? null;
}

/** Hourly calibration. Only this bounded pass owns rate state; there is no process cache. */
export async function refreshLimitRates(db: Database, now: number, deps: RateDependencies,
  write: (work: () => void) => Promise<void>): Promise<Set<string>> {
  const series = deps.history().series;
  const rises = new Map<string, ReturnType<typeof risesFromSamples>>();
  const accounts = new Set(deps.observations.keys());
  let oldest = now;
  for (const [key, samples] of Object.entries(series)) {
    const [engine, id, window] = key.split("|");
    if ((engine !== "claude" && engine !== "codex") || !id || (window !== "weekly" && window !== "session")) continue;
    const ordered = samples.filter(s => s.t * 1000 >= now - 8 * DAY && s.t * 1000 <= now).sort((a,b) => a.t-b.t);
    if (!ordered.length) continue;
    accounts.add(`${engine}:${id}`);
    oldest = Math.min(oldest, ordered[0]!.t * 1000);
    rises.set(`${engine}:${id}|${window}`, risesFromSamples(ordered));
  }
  const today = utcDay(now), changed = new Set<string>();
  // At most nine UTC days, including the current partial day.
  for (let start = Date.parse(utcDay(oldest)); start <= Date.parse(today); start += DAY) {
    const day = utcDay(start), end = Math.min(now, start + DAY), from = start - 6 * DAY;
    const existing = db.query<LimitRate, [string]>("SELECT * FROM usage_limit_rates WHERE day=?").all(day);
    const previous = new Map(existing.map(r => [`${r.account}|${r.window}`, r]));
    const needed = [...accounts].filter(account => ["weekly", "session"].some(window => !previous.get(`${account}|${window}`)?.frozen));
    if (!needed.length) continue;
    const weights = new Map<string, number>();
    type WeightRow = Parameters<typeof countsFromRow>[0] & { account: string; model: string; tier: string; engine: string };
    const rows = db.query<WeightRow, [number, number]>(`SELECT account, model, tier, engine, ${SUM_TOKENS} FROM usage_hours
      WHERE host='' AND hour >= ? AND hour < ? GROUP BY account, model, tier, engine`).all(Math.floor(from/HOUR), Math.ceil(end/HOUR));
    for (const row of rows) weights.set(row.account, (weights.get(row.account) ?? 0) + (limitWeight(row.model, row.tier, row.engine, countsFromRow(row)) ?? 0));
    const pending: LimitRate[] = [];
    for (const account of accounts) for (const window of ["weekly", "session"] as const) {
      const prior = previous.get(`${account}|${window}`);
      if (prior?.frozen) { pending.push(prior); continue; }
      const rise = (rises.get(`${account}|${window}`) ?? []).filter(s => s.t*1000 >= from && s.t*1000 < end).reduce((n,s) => n+s.rise,0);
      const weight = weights.get(account) ?? 0, rate = dayRate(rise, weight);
      pending.push({ account, window, day, rate, rise, weight, source: rate === null ? "none" : "own",
        plan: deps.observations.get(account)?.plan ?? null, frozen: day < today ? 1 : 0, computed_at: now });
    }
    for (const row of pending) {
      if (row.frozen && previous.get(`${row.account}|${row.window}`)?.frozen) continue;
      if (row.rate === null && row.plan) {
        row.rate = planMedian(pending.filter(r => r.source === "own" && r.window === row.window && r.plan === row.plan
          && r.account.split(":")[0] === row.account.split(":")[0]).map(r => r.rate!));
        if (row.rate !== null) row.source = "plan";
      }
      const prior = previous.get(`${row.account}|${row.window}`);
      if (day === today && (!prior || row.source !== prior.source || (row.rate !== null && (prior.rate === null
        || Math.abs(row.rate - prior.rate) > Math.abs(prior.rate) * 0.02)))) changed.add(row.account);
    }
    await write(() => {
      const put = db.query(`INSERT INTO usage_limit_rates VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account,window,day) DO UPDATE SET rate=excluded.rate, rise=excluded.rise, weight=excluded.weight,
        source=excluded.source, plan=excluded.plan, frozen=excluded.frozen, computed_at=excluded.computed_at WHERE frozen=0`);
      for (const r of pending) if (!previous.get(`${r.account}|${r.window}`)?.frozen) put.run(r.account,r.window,r.day,r.rate,r.rise,r.weight,r.source,r.plan,r.frozen,r.computed_at);
    });
    await yieldLoop();
  }
  return changed;
}
