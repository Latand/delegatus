/** Read-only maintainer metrics. No Viewer imports, install pings or scheduler. */
import { execFile } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { APP_DIR_NAMES } from "../bin/appDir.mjs";

export const TIMEOUT_MS = 30_000;
const command = promisify(execFile);
const number = z.number().finite().nonnegative();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
const npmRange = z.object({ start: date, end: date, downloads: z.array(z.object({ day: date, downloads: number })) });
const npmVersions = z.object({ downloads: z.record(version, number) });
const npmPoint = z.object({ start: date, end: date, downloads: number });
const npmMetadata = z.object({ time: z.record(z.string(), z.string()) });
const githubViews = z.object({ count: number, uniques: number, views: z.array(z.object({ timestamp: z.string().datetime(), count: number, uniques: number })) });
const githubReferrers = z.array(z.object({ referrer: z.string(), count: number, uniques: number }));
const githubStars = z.object({ stargazers_count: number });
const cloudflareGroups = z.object({ errors: z.array(z.unknown()).nullish(), data: z.object({ viewer: z.object({ accounts: z.array(z.object({ rumPageloadEventsAdaptiveGroups: z.array(z.object({ dimensions: z.object({ date }), sum: z.object({ visits: number }), avg: z.object({ sampleInterval: number }) })) })).min(1) }) }) });

export type Options = { from: string; to: string; day?: string; line: boolean; history: string; tokenFile: string };
type Npm = { range: z.infer<typeof npmRange>; versions: z.infer<typeof npmVersions> & { start: string; end: string }; releases: Record<string, string[]> };
type Github = { views: z.infer<typeof githubViews> | null; referrers: z.infer<typeof githubReferrers> | null; stars: number | null };
type Site = { days: { day: string; visits: number; sampleInterval: number }[] };
export type Report = { observedAt: string; from: string; to: string; npm: Npm | null; github: Github | null; site: Site | null; failures: string[] };
export type IO = { json: (url: string, init?: RequestInit) => Promise<unknown>; run: (args: string[]) => Promise<string>; token: (path: string) => Promise<string> };

function safeReferrer(value: string): string {
  if (["Google", "Microsoft Teams"].includes(value)) return value;
  const host = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(value) ? value : (() => {
    try { return new URL(value).hostname; } catch { return ""; }
  })();
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(host) ? host.toLowerCase() : "інше джерело";
}

export const liveIO: IO = {
  async json(url, init) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    if (!response.ok) throw new Error("request failed");
    return response.json();
  },
  async run([binary, ...args]) {
    const { stdout } = await command(binary, args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  },
  async token(path) { return (await readFile(path, "utf8")).trim(); },
};

export function parseOptions(args: string[], now = new Date()): Options {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 29 * 86400_000).toISOString().slice(0, 10);
  const options: Options = { from, to, line: false, history: join(homedir(), ".local/share/delegatus-metrics/history.jsonl"), tokenFile: join(homedir(), ".secrets/cloudflare-delegatus.env") };
  const flags: Record<string, "from" | "to" | "day" | "history" | "tokenFile"> = { "--from": "from", "--to": "to", "--date": "day", "--history": "history", "--cloudflare-token-file": "tokenFile" };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--line") options.line = true;
    else {
      const key = flags[flag];
      if (!key || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("invalid arguments");
      options[key] = args[++i];
    }
  }
  for (const day of [options.from, options.to, options.day].filter((d): d is string => !!d)) {
    date.parse(day);
    if (new Date(day).toISOString().slice(0, 10) !== day) throw new Error("invalid date");
  }
  if (options.from > options.to || options.to > to || (options.day && (options.day < options.from || options.day > options.to))) throw new Error("invalid date range");
  // Cloudflare's Web Analytics query window is bounded; older npm data can be read in separate runs.
  if ((Date.parse(options.to) - Date.parse(options.from)) / 86400_000 > 30) throw new Error("range exceeds 31 days");
  return options;
}

/** Mirrors/scanners estimate from the pinned design, including its known audit window. */
export function people(day: string, raw: number, releases: string[]): [number, number] {
  if (releases.includes("0.0.0")) return [0, 0];
  const wave = releases.length * 110;
  // The design identified one agent's 1–4 registry fetches on this date.
  const agents = day === "2026-09-24" ? [1, 4] : [0, 0];
  return [Math.max(0, raw - wave - 20 - agents[1]), Math.max(0, raw - wave - 10 - agents[0])];
}

export async function collect(options: Options, io: IO = liveIO, now = new Date()): Promise<Report> {
  const failures: string[] = [];
  async function source<T>(name: string, read: () => Promise<T>): Promise<T | null> {
    try { return await read(); } catch { failures.push(name); return null; }
  }
  const [npm, github, site] = await Promise.all([
    source("npm", async () => {
      const [window, versions, metadata] = await Promise.all([
        io.json("https://api.npmjs.org/downloads/point/last-week/delegatus-cli").then(v => npmPoint.parse(v)),
        io.json("https://api.npmjs.org/versions/delegatus-cli/last-week").then(v => npmVersions.parse(v)),
        io.json("https://registry.npmjs.org/delegatus-cli").then(v => npmMetadata.parse(v)),
      ]);
      const end = options.to < window.end ? options.to : window.end;
      if (options.from > end) throw new Error("npm data not available yet");
      const range = npmRange.parse(await io.json(`https://api.npmjs.org/downloads/range/${options.from}:${end}/delegatus-cli`));
      const releases: Record<string, string[]> = {};
      for (const [v, timestamp] of Object.entries(metadata.time)) {
        if (version.safeParse(v).success && z.string().datetime().safeParse(timestamp).success) {
          const day = timestamp.slice(0, 10);
          (releases[day] ??= []).push(v);
        }
      }
      return { range, versions: { ...versions, start: window.start, end: window.end }, releases };
    }),
    source("GitHub", async () => {
      // gh resolves redirects after the repository rename and supplies its existing credential.
      const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/).parse(await io.run(["gh", "repo", "view", "Latand/delegatus", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]));
      const api = async (suffix: string) => JSON.parse(await io.run(["gh", "api", `repos/${repo}${suffix}`]));
      const [views, referrers, stars] = await Promise.all([
        source("GitHub views", async () => githubViews.parse(await api("/traffic/views?per=day"))),
        source("GitHub referrers", async () => githubReferrers.parse(await api("/traffic/popular/referrers")).map(referrer => ({ ...referrer, referrer: safeReferrer(referrer.referrer) }))),
        source("GitHub stars", async () => githubStars.parse(await api("")).stargazers_count),
      ]);
      return { views, referrers, stars };
    }),
    source("Cloudflare Web Analytics", async () => {
      const token = await io.token(options.tokenFile);
      if (!token || /\s/.test(token)) throw new Error("invalid credential");
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const base = "https://api.cloudflare.com/client/v4";
      const accounts = z.object({ success: z.literal(true), result: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) })) }).parse(await io.json(`${base}/accounts`, { headers }));
      let selected: { account: string; site: string } | undefined;
      for (const account of accounts.result) {
        const sites = z.object({ success: z.literal(true), result: z.array(z.object({ site_tag: z.string().regex(/^[a-f0-9]{32}$/), ruleset: z.object({ zone_name: z.string() }).nullish() })) }).parse(await io.json(`${base}/accounts/${account.id}/rum/site_info/list`, { headers }));
        const match = sites.result.find(s => s.ruleset?.zone_name === "delegatus.org");
        if (match) { selected = { account: account.id, site: match.site_tag }; break; }
      }
      if (!selected) throw new Error("site unavailable");
      const query = `query($account:String!,$site:String!,$from:String!,$to:String!){viewer{accounts(filter:{accountTag:$account}){rumPageloadEventsAdaptiveGroups(limit:32,filter:{siteTag:$site,date_geq:$from,date_leq:$to,requestPath:"/",userAgentBrowser_neq:"ChromeHeadless"},orderBy:[date_ASC]){dimensions{date} sum{visits} avg{sampleInterval}}}}}`;
      const response = cloudflareGroups.parse(await io.json(`${base}/graphql`, { method: "POST", headers, body: JSON.stringify({ query, variables: { account: selected.account, site: selected.site, from: options.from, to: options.to } }) }));
      if (response.errors?.length) throw new Error("query failed");
      return { days: response.data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups.map(g => ({ day: g.dimensions.date, visits: g.sum.visits, sampleInterval: g.avg.sampleInterval })) };
    }),
  ]);
  return { observedAt: now.toISOString(), from: options.from, to: options.to, npm, github, site, failures: failures.sort() };
}

const value = (n: number | null | undefined) => n == null ? "—" : String(n);
const shortDate = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const rangeText = (r: [number, number]) => `${r[0]}–${r[1]}`;
function daily(report: Report, day: string) {
  const npm = report.npm?.range.downloads.find(d => d.day === day);
  const releases = report.npm?.releases[day] ?? [];
  const site = report.site?.days.find(d => d.day === day);
  const github = report.github?.views?.views.find(d => d.timestamp.slice(0, 10) === day);
  return { raw: npm?.downloads, estimate: npm ? rangeText(people(day, npm.downloads, releases)) : "—", releases, site, github };
}

export function render(report: Report, options: Options): string {
  if (options.line) {
    const day = options.day ?? report.npm?.range.downloads.at(-1)?.day ?? report.to;
    const d = daily(report, day);
    const release = d.releases.length ? ` (реліз ${d.releases.join(", ")})` : "";
    const errors = report.failures.length ? ` · недоступно: ${report.failures.join(", ")}` : "";
    return `📈 Delegatus ${shortDate(day)} · npm ${value(d.raw)}, з них людей ≈${d.estimate}${release} · встановлення: — · сайт: ${value(d.site?.visits)} візитів, копій промпту: — · GitHub: ${value(d.github?.uniques)} відвідувачів${errors}`;
  }
  const rows = ["| Джерело / UTC | Метрика | Значення |", "| --- | --- | ---: |"];
  const row = (source: string, metric: string, n: string | number) => rows.push(`| ${source} | ${metric} | ${n} |`);
  const days = [...new Set([...(report.npm?.range.downloads.map(d => d.day) ?? []), ...(report.site?.days.map(d => d.day) ?? []), ...(report.github?.views?.views.map(d => d.timestamp.slice(0, 10)) ?? [])])].sort();
  for (const day of days) {
    const d = daily(report, day);
    if (d.raw != null) row(`npm ${day}`, `завантаження; людей ≈${d.estimate}; релізи ${d.releases.join(", ") || "—"}`, d.raw);
    if (d.site) row(`сайт ${day}`, `візити / без ChromeHeadless; крок вибірки ≈${d.site.sampleInterval}`, d.site.visits);
    if (d.github) row(`GitHub ${day}`, `перегляди; відвідувачі ${d.github.uniques}`, d.github.count);
  }
  if (report.npm) {
    const n = report.npm;
    const estimates = n.range.downloads.map(d => people(d.day, d.downloads, n.releases[d.day] ?? []));
    row(`npm ${n.range.start}…${n.range.end}`, `завантаження; людей ≈${rangeText([estimates.reduce((s, r) => s + r[0], 0), estimates.reduce((s, r) => s + r[1], 0)])}`, n.range.downloads.reduce((s, d) => s + d.downloads, 0));
    for (const [v, count] of Object.entries(n.versions.downloads)) row(`npm ${n.versions.start}…${n.versions.end}`, `версія ${v}`, count);
  }
  const g = report.github;
  if (g?.views) {
    const dates = g.views.views.map(v => v.timestamp.slice(0, 10)).sort();
    row(`GitHub ${dates[0] ?? "—"}…${dates.at(-1) ?? "—"}`, `перегляди; унікальні відвідувачі ${g.views.uniques} за вікно`, g.views.count);
  }
  if (g?.stars != null) row("GitHub", "зірки загалом", g.stars);
  for (const r of g?.referrers ?? []) {
    // Referrer strings are untrusted API data; print hostnames and known labels only.
    const name = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(r.referrer) || ["Google", "Microsoft Teams"].includes(r.referrer) ? r.referrer : "інше джерело";
    row("GitHub 14 днів", `${name}: перегляди; відвідувачі ${r.uniques}`, r.count);
  }
  if (report.site) row(`сайт ${report.from}…${report.to}`, "візити / без ChromeHeadless (вибірка)", report.site.days.reduce((s, d) => s + d.visits, 0));
  for (const failure of report.failures) row(failure, "недоступно (доступ / мережа / відповідь)", "—");
  row("оцінка npm", "≈110 на реліз + хвіст 10–20/день; встановлення, оновлення та перевстановлення разом", "≈");
  return rows.join("\n");
}

async function canonical(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // realpath reports ENOENT for a dangling symlink too. Do not reconstruct
    // the link's own path: appending there could create a file at its target.
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("unsafe history location");
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
    }
    return join(await canonical(dirname(path)), basename(path));
  }
}
const inside = (root: string, path: string) => { const r = relative(root, path); return !r || (!r.startsWith("..") && !isAbsolute(r)); };

export async function appendHistory(path: string, report: Report, systemHome = homedir()): Promise<void> {
  const target = await canonical(resolve(path));
  const repo = await canonical(resolve(import.meta.dir, ".."));
  const homes = [...new Set([systemHome, process.env.HOME].filter((home): home is string => !!home))];
  const configRoots = [...new Set([...homes.map(home => join(home, ".config")), process.env.XDG_CONFIG_HOME || join(homedir(), ".config")])];
  const protectedRoots = [
    repo,
    ...configRoots.flatMap(root => APP_DIR_NAMES.map(name => join(root, name))),
    ...homes.flatMap(home => [join(home, ".claude/viewer-state"), join(home, ".claude/viewer-inbox")]),
    process.env.LLV_STATE_DIR,
  ].filter((p): p is string => !!p);
  for (const root of protectedRoots) if (inside(await canonical(resolve(root)), target)) throw new Error("unsafe history location");
  // Also refuse another checkout. A home-level dotfiles repository must not
  // disallow the specification's default ~/.local/share history location.
  let ancestor = dirname(target);
  while (ancestor !== dirname(ancestor)) {
    try { await realpath(join(ancestor, ".git")); if (ancestor !== await canonical(homedir())) throw new Error("unsafe history location"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    ancestor = dirname(ancestor);
  }
  // A hard link can name a protected state inode from outside every protected
  // path. Refuse shared inodes so appending history cannot mutate that state.
  try {
    if ((await stat(target)).nlink > 1) throw new Error("unsafe history location");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  // Append snapshots, including every available GitHub day. Window uniques are never summed.
  await appendFile(target, JSON.stringify(report) + "\n", { mode: 0o600 });
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help")) {
    console.log("bun scripts/usage-metrics.ts [--line] [--date YYYY-MM-DD] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--history FILE] [--cloudflare-token-file FILE]\nDates are UTC; default range is the last 30 days. --date selects the message day; default is the latest npm day. History defaults to ~/.local/share/delegatus-metrics/history.jsonl. Cloudflare reads the landing deploy token from ~/.secrets/cloudflare-delegatus.env; GitHub uses gh auth. Each request is bounded at 30 seconds. Source failures print unavailable and leave the other numbers visible.");
    return;
  }
  let options: Options;
  try { options = parseOptions(args); } catch { console.error("usage-metrics: invalid arguments; use --help"); process.exitCode = 1; return; }
  const report = await collect(options);
  console.log(render(report, options));
  try { await appendHistory(options.history, report); }
  catch { console.error("usage-metrics: history unavailable or unsafe; choose a file outside repositories and Viewer state"); process.exitCode = 1; }
  if (report.failures.length) process.exitCode = 1;
}

if (import.meta.main) await main();
