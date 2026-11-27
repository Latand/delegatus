import { countryCode, DAY, isInstallPing, isSiteEvent, type InstallPing, type SiteEvent } from "./metrics";

export type Row = Record<string, string | number | null>;
export type QueryResult = { rows: Row[]; failed: boolean };
export type HistoryEnv = { STATS_ACCOUNT_ID?: string; STATS_AE_TOKEN?: string };
export type ImportFailure = "http" | "network" | "shape" | "limit";
type Query = { rows: Row[] } | { error: ImportFailure };

export function historyConfigured(env: HistoryEnv) {
  return Boolean(env.STATS_ACCOUNT_ID && /^[a-f0-9]{32}$/.test(env.STATS_ACCOUNT_ID) && env.STATS_AE_TOKEN);
}

async function statsQuery(env: HistoryEnv, sql: string, limit: number): Promise<Query> {
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.STATS_ACCOUNT_ID}/analytics_engine/sql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.STATS_AE_TOKEN}`, "Content-Type": "text/plain" },
      body: `${sql} FORMAT JSON`, signal: AbortSignal.timeout(10_000), redirect: "manual",
    });
  } catch {
    return { error: "network" };
  }
  if (!response.ok) return { error: "http" };
  try {
    const body = await response.json() as { data?: Row[]; rows?: number };
    if (!Array.isArray(body?.data)) return { error: "shape" };
    if (body.data.length >= limit) return { error: "limit" };
    if ((body.rows !== undefined && body.rows !== body.data.length) ||
      body.data.some(row => !row || typeof row !== "object" || Array.isArray(row) ||
        Object.values(row).some(value => value !== null && typeof value !== "string" && typeof value !== "number"))) {
      return { error: "shape" };
    }
    return { rows: body.data };
  } catch {
    return { error: "shape" };
  }
}

export async function readHistoryDay(env: HistoryEnv, day: string) {
  const window = `timestamp >= toDateTime('${day} 00:00:00') AND timestamp < toDateTime('${day} 00:00:00') + INTERVAL '1' DAY`;
  const [installs, events] = await Promise.all([
    statsQuery(env, `SELECT blob1 AS id, blob2 AS v, blob3 AS os, blob4 AS arch, blob5 AS kind, blob6 AS country,
      formatDateTime(timestamp, '%Y-%m-%d %H:%M:%S') AS at
      FROM installs WHERE ${window} ORDER BY at LIMIT 10000`, 10000),
    statsQuery(env, `SELECT blob1 AS event, blob2 AS agent, blob3 AS lang, blob4 AS country,
      sum(_sample_interval * double1) AS total
      FROM site_events WHERE ${window} GROUP BY event, agent, lang, country LIMIT 1000`, 1000),
  ]);
  if ("error" in installs) return installs;
  if ("error" in events) return events;

  const midnight = Date.parse(day);
  const pings: { ping: InstallPing; country: string; at: number }[] = [];
  const actions: { event: SiteEvent; country: string; total: number }[] = [];
  let skipped = 0;
  for (const { id, v, os, arch, kind, country, at } of installs.rows) {
    const ping = { id, v, os, arch, kind };
    const time = typeof at === "string" && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(at)
      ? Date.parse(at.replace(" ", "T") + "Z") : NaN;
    if (isInstallPing(ping) && time >= midnight && time < midnight + DAY) {
      pings.push({ ping, country: countryCode(country), at: time });
    } else skipped++;
  }
  for (const { event: name, agent, lang, country, total } of events.rows) {
    const event = name === "copy_prompt" || agent !== "" ? { event: name, lang, agent } : { event: name, lang };
    const value = typeof total === "string" && total.trim() !== "" ? Number(total) : total;
    if (isSiteEvent(event) && typeof value === "number" && Number.isFinite(value) && value > 0) {
      actions.push({ event, country: countryCode(country), total: value });
    } else skipped++;
  }
  return { pings, actions, skipped };
}
