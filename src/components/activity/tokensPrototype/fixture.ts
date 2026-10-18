/*
 * Invented token usage for the prototype route of
 * docs/design/activity-token-usage.md §9 (prototype only; removed once the
 * operator has chosen a variant). Deterministic: a seeded generator, a frozen
 * "now", fixed ids. The answer has the §6.2 shape, computed in the browser
 * from day rows, so a filter, a range and a grouping read the same numbers
 * the real endpoint would give. Names are invented; no real project, person,
 * account or path appears here.
 */

export type TokenKind = "cacheRead" | "input" | "cacheWrite" | "output";
export const TOKEN_KINDS: readonly TokenKind[] = ["cacheRead", "input", "cacheWrite", "output"];

export interface TokenCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
  requests: number;
}

export type TokenDimension = "kind" | "model" | "role" | "project" | "member" | "account" | "engine";
export type ListDimension = Exclude<TokenDimension, "kind">;
export type Preset = "today" | "7d" | "30d" | "90d";
export type Bucket = "hour" | "day" | "week";

export interface FixtureRow {
  date: string;
  project: string | null;
  role: string;
  model: string;
  engine: "claude" | "codex";
  account: string;
  member: string;
  /** Invented conversation and lane ids for the top-conversations and lanes extras. */
  conversation: string;
  lane: string | null;
  counts: TokenCounts;
}

export interface TokenQuery {
  from: string;
  to: string;
  preset: Preset | null;
  project: string | null;
  stack: TokenDimension;
  list: ListDimension;
  filters: Partial<Record<ListDimension, string>>;
}

export interface SeriesBucket {
  start: string;
  end: string;
  label: string;
  counted: boolean;
  partial: boolean;
  parts: Array<{ key: string; counts: TokenCounts }>;
}

export interface ListRow {
  key: string;
  counts: TokenCounts;
  /** Per bucket total, for the analysis table's sparkline. */
  trend: number[];
}

export interface TokensAnswer {
  query: TokenQuery;
  bucket: Bucket;
  totals: TokenCounts;
  previous: { from: string; to: string; totals: TokenCounts };
  series: SeriesBucket[];
  list: ListRow[];
  coverage: { countedFrom: string; complete: boolean; pendingGb: number };
  /** Agent and human time for variant 2, invented on the same days. */
  time: { humanHours: number; agentHours: number; days: Array<{ date: string; humanHours: number; agentHours: number }> };
}

/* ------------------------------------------------------------------------ */
/* Clock and calendar                                                       */
/* ------------------------------------------------------------------------ */

/** The frozen "now": 17 October 2026, 14:00 in Kyiv. */
export const NOW_DATE = "2026-10-17";
export const NOW_HOUR = 14;
export const TZ = "Europe/Kyiv";
/** The first day on disk and the first day counted: five days before it were not read. */
export const FIRST_DATE = "2026-09-06";
export const COUNTED_FROM = "2026-09-11";

const DAY_MS = 86_400_000;
export const dayMs = (date: string) => Date.parse(`${date}T12:00:00Z`);
export const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date: string, days: number) => dateOf(dayMs(date) + days * DAY_MS);
export const daysBetween = (from: string, to: string) => Math.round((dayMs(to) - dayMs(from)) / DAY_MS);
const weekday = (date: string) => new Date(dayMs(date)).getUTCDay();

export function presetRange(preset: Preset): { from: string; to: string } {
  const span = preset === "today" ? 0 : preset === "7d" ? 6 : preset === "30d" ? 29 : 89;
  return { from: addDays(NOW_DATE, -span), to: NOW_DATE };
}

/** The design's clamps (§6.1): `to` after today becomes today, a reversed
    range swaps, a span over 366 days moves `from` to `to − 365`. */
export function clampRange(from: string, to: string): { from: string; to: string } {
  let a = from;
  let b = to > NOW_DATE ? NOW_DATE : to;
  if (a > b) [a, b] = [b, a];
  if (daysBetween(a, b) > 365) a = addDays(b, -365);
  return { from: a, to: b };
}

/* ------------------------------------------------------------------------ */
/* Entities                                                                 */
/* ------------------------------------------------------------------------ */

export const PROJECTS: ReadonlyArray<{ key: string | null; name: string; weight: number }> = [
  { key: "repo-orchard-client", name: "orchard-client", weight: 0.27 },
  { key: "repo-lantern-api", name: "lantern-api", weight: 0.2 },
  { key: "repo-kestrel-cli", name: "kestrel-cli", weight: 0.13 },
  { key: "repo-sorrel-bot", name: "sorrel-bot", weight: 0.1 },
  { key: "repo-heron-docs", name: "heron-docs", weight: 0.055 },
  { key: "repo-quill-site", name: "quill-site", weight: 0.045 },
  { key: "repo-marten-infra", name: "marten-infra", weight: 0.04 },
  { key: "repo-wren-sdk", name: "wren-sdk", weight: 0.035 },
  { key: "repo-otter-ml", name: "otter-ml", weight: 0.03 },
  { key: "repo-finch-ops", name: "finch-ops", weight: 0.025 },
  { key: "repo-plover-mobile", name: "plover-mobile", weight: 0.02 },
  { key: null, name: "", weight: 0.03 },
];

/* Weighted like this host's turns: builders and the seat first, then reviewers. */
export const ROLES: ReadonlyArray<{ key: string; weight: number; models: Record<string, number> }> = [
  { key: "builder", weight: 0.29, models: { "claude-opus-5-5": 0.5, "gpt-6-sol": 0.35, "claude-sonnet-5-5": 0.15 } },
  { key: "orchestrator", weight: 0.21, models: { "claude-opus-5-5": 0.75, "claude-fable-5-1": 0.25 } },
  { key: "reviewer", weight: 0.16, models: { "gpt-6-sol": 0.45, "gpt-6-astra": 0.35, "claude-opus-5-5": 0.2 } },
  { key: "none", weight: 0.07, models: { "claude-opus-5-5": 0.6, "claude-sonnet-5-5": 0.4 } },
  { key: "unregistered", weight: 0.06, models: { "claude-opus-5-5": 0.5, "gpt-6-astra": 0.3, "claude-haiku-5-5": 0.2 } },
  { key: "visual-critic", weight: 0.05, models: { "claude-opus-5-5": 0.7, "claude-fable-5-1": 0.3 } },
  { key: "architect", weight: 0.04, models: { "claude-fable-5-1": 0.6, "gpt-6-astra": 0.4 } },
  { key: "merger", weight: 0.035, models: { "gpt-6-luna": 0.7, "claude-haiku-5-5": 0.3 } },
  { key: "fixer", weight: 0.03, models: { "gpt-6-sol": 0.6, "claude-sonnet-5-5": 0.4 } },
  { key: "deployer", weight: 0.02, models: { "gpt-6-luna": 1 } },
  { key: "researcher", weight: 0.025, models: { "gpt-6-astra": 0.6, "claude-sonnet-5-5": 0.4 } },
];

/** Fixed order: the colour of a model follows it, never its rank in a range. */
export const MODELS: readonly string[] = ["claude-opus-5-5", "gpt-6-sol", "claude-fable-5-1", "gpt-6-astra", "claude-sonnet-5-5", "gpt-6-luna", "claude-haiku-5-5"];
export const engineOf = (model: string): "claude" | "codex" => (model.startsWith("gpt-") ? "codex" : "claude");

export const MEMBERS: ReadonlyArray<{ id: string; name: string; initials: string; weight: number; owner?: boolean }> = [
  { id: "m-ada", name: "Ada Quill", initials: "AQ", weight: 0.68, owner: true },
  { id: "m-bo", name: "Bo Tern", initials: "BT", weight: 0.21 },
  { id: "m-cy", name: "Cy Moss", initials: "CM", weight: 0.08 },
  { id: "unattributed", name: "", initials: "?", weight: 0.03 },
];

export const ACCOUNTS: ReadonlyArray<{ id: string; label: string; engine: "claude" | "codex"; plan: string }> = [
  { id: "acct-a", label: "Claude · A", engine: "claude", plan: "Max" },
  { id: "acct-b", label: "Claude · B", engine: "claude", plan: "Pro" },
  { id: "acct-c", label: "Codex · C", engine: "codex", plan: "Pro" },
];

/** Every entity in its fixed colour order, per dimension. */
export function dimensionOrder(dimension: TokenDimension): string[] {
  switch (dimension) {
    case "kind": return [...TOKEN_KINDS];
    case "model": return [...MODELS];
    case "role": return ROLES.map((role) => role.key);
    case "project": return PROJECTS.map((project) => project.key ?? "");
    case "member": return MEMBERS.map((member) => member.id);
    case "account": return ACCOUNTS.map((account) => account.id);
    case "engine": return ["claude", "codex"];
  }
}

/* Invented conversation topics for the top-conversations extra; a
   conversation is one project and one role, so its line names both. */
const CONVERSATION_TOPICS = [
  "Offline sync for the client cache",
  "Rate limiter for public endpoints",
  "Plugin loader",
  "Message queue retries",
  "Settings page redesign",
  "Search index",
  "Flaky integration test",
  "Release train",
  "Billing export",
  "Backlog triage",
  "Onboarding flow",
];

/* ------------------------------------------------------------------------ */
/* Generation                                                               */
/* ------------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(items: ReadonlyArray<T>, weightOf: (item: T) => number, random: () => number): T {
  const total = items.reduce((sum, item) => sum + weightOf(item), 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= weightOf(item);
    if (roll <= 0) return item;
  }
  return items[items.length - 1]!;
}

/** The day's whole volume: weekdays near a billion tokens, a heavy Monday,
    an empty weekend, night runs on the others, Today partial to 14:00. */
function dayVolume(date: string, random: () => number): number {
  const day = weekday(date);
  if (date === "2026-10-10" || date === "2026-10-11") return date === "2026-10-11" ? 0 : 6e6;
  if (date === "2026-10-06") return 3.05e9;
  if (date === "2026-09-29") return 2.2e9;
  const base = day === 0 || day === 6 ? 0.09e9 + random() * 0.12e9 : 0.75e9 + random() * 0.65e9;
  /* A slow upward drift across the month. */
  const drift = 0.82 + 0.3 * (daysBetween(FIRST_DATE, date) / daysBetween(FIRST_DATE, NOW_DATE));
  const today = date === NOW_DATE ? 0.52 : 1;
  return base * drift * today;
}

function kinds(total: number, model: string, random: () => number): TokenCounts {
  const codex = engineOf(model) === "codex";
  const outputShare = 0.0036 + random() * 0.0012;
  const writeShare = codex ? 0 : 0.016 + random() * 0.008;
  const freshShare = 0.008 + random() * 0.008;
  const output = Math.round(total * outputShare);
  const cacheWrite = Math.round(total * writeShare);
  const input = Math.round(total * freshShare);
  const cacheRead = Math.max(0, Math.round(total) - output - cacheWrite - input);
  return {
    input,
    cacheRead,
    cacheWrite,
    cacheWrite1h: Math.round(cacheWrite * (0.55 + random() * 0.15)),
    output,
    reasoning: Math.round(output * (codex ? 0.42 + random() * 0.08 : 0.24 + random() * 0.08)),
    requests: Math.max(1, Math.round(total / (95_000 + random() * 40_000))),
  };
}

let ROWS: FixtureRow[] | null = null;

/** About forty rows per day for 42 days: project × role × model × member × account. */
export function fixtureRows(): FixtureRow[] {
  if (ROWS) return ROWS;
  const random = mulberry32(20261017);
  const rows: FixtureRow[] = [];
  for (let date = FIRST_DATE; date <= NOW_DATE; date = addDays(date, 1)) {
    const volume = dayVolume(date, random);
    if (volume <= 0) continue;
    const pieces = volume < 1e8 ? 6 : 42;
    const weights = Array.from({ length: pieces }, () => 0.2 + random() ** 2 * 2);
    const sum = weights.reduce((a, b) => a + b, 0);
    for (const weight of weights) {
      const project = pick(PROJECTS, (item) => item.weight, random);
      const role = pick(ROLES, (item) => item.weight, random);
      const model = pick(Object.entries(role.models), ([, share]) => share, random)[0];
      const engine = engineOf(model);
      const member = role.key === "unregistered" ? MEMBERS[0]! : pick(MEMBERS, (item) => item.weight, random);
      const account = engine === "codex" ? "acct-c" : random() < 0.78 ? "acct-a" : "acct-b";
      const conversation = `${project.key ?? ""}|${role.key}|${Math.floor(random() * 3)}`;
      const lane = role.key === "orchestrator" || role.key === "unregistered" || role.key === "none" ? null : `lane-${(Math.floor(random() * 9) + 1).toString(16).padStart(2, "0")}`;
      rows.push({ date, project: project.key, role: role.key, model, engine, account, member: member.id, conversation, lane, counts: kinds((volume * weight) / sum, model, random) });
    }
  }
  ROWS = rows;
  return rows;
}

export function conversationTitle(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return CONVERSATION_TOPICS[hash % CONVERSATION_TOPICS.length]!;
}

/* ------------------------------------------------------------------------ */
/* Aggregation                                                              */
/* ------------------------------------------------------------------------ */

export const zeroCounts = (): TokenCounts => ({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, requests: 0 });

export function addCounts(into: TokenCounts, from: TokenCounts): TokenCounts {
  into.input += from.input;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.cacheWrite1h += from.cacheWrite1h;
  into.output += from.output;
  into.reasoning += from.reasoning;
  into.requests += from.requests;
  return into;
}

export const totalOf = (counts: TokenCounts) => counts.input + counts.cacheRead + counts.cacheWrite + counts.output;
export const inputOf = (counts: TokenCounts) => counts.input + counts.cacheRead + counts.cacheWrite;
/** Extra E2: cache reads as a share of all input. */
export const cacheShare = (counts: TokenCounts) => (inputOf(counts) ? counts.cacheRead / inputOf(counts) : 0);

/** Extra E1: invented API list prices in dollars per million tokens, per model
    family and kind (fresh, cache read, cache write, output). A prototype
    stand-in for the dated price table §8 describes. */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [5, 0.5, 6.25, 25],
  "claude-fable-5-1": [15, 1.5, 18.75, 75],
  "claude-sonnet-5-5": [3, 0.3, 3.75, 15],
  "claude-haiku-5-5": [1, 0.1, 1.25, 5],
  "gpt-6-sol": [1.25, 0.125, 0, 10],
  "gpt-6-astra": [2.5, 0.25, 0, 15],
  "gpt-6-luna": [0.25, 0.025, 0, 2],
};

export function costOf(model: string, counts: TokenCounts): number {
  const price = PRICES[model];
  if (!price) return 0;
  return (counts.input * price[0] + counts.cacheRead * price[1] + counts.cacheWrite * price[2] + counts.output * price[3]) / 1e6;
}

const keyOf = (row: FixtureRow, dimension: ListDimension): string => {
  switch (dimension) {
    case "model": return row.model;
    case "role": return row.role;
    case "project": return row.project ?? "";
    case "member": return row.member;
    case "account": return row.account;
    case "engine": return row.engine;
  }
};

export function matches(row: FixtureRow, query: Pick<TokenQuery, "project" | "filters">): boolean {
  if (query.project !== null && row.project !== query.project) return false;
  for (const [dimension, value] of Object.entries(query.filters) as Array<[ListDimension, string]>) {
    if (value !== undefined && keyOf(row, dimension) !== value) return false;
  }
  return true;
}

export function rowsIn(from: string, to: string, query: Pick<TokenQuery, "project" | "filters">): FixtureRow[] {
  return fixtureRows().filter((row) => row.date >= from && row.date <= to && matches(row, query));
}

function bucketOf(from: string, to: string): Bucket {
  const span = daysBetween(from, to) + 1;
  return span <= 2 ? "hour" : span <= 92 ? "day" : "week";
}

/* Today's work over the hours, for the hour buckets. */
const HOUR_PROFILE = [0.3, 0.2, 0.2, 0.2, 0.2, 0.3, 0.5, 0.8, 1.2, 1.6, 1.8, 1.9, 1.7, 1.8, 1.9, 1.8, 1.6, 1.4, 1.2, 1.1, 1, 0.8, 0.6, 0.4];

function scaled(counts: TokenCounts, factor: number): TokenCounts {
  return {
    input: counts.input * factor, cacheRead: counts.cacheRead * factor, cacheWrite: counts.cacheWrite * factor,
    cacheWrite1h: counts.cacheWrite1h * factor, output: counts.output * factor, reasoning: counts.reasoning * factor, requests: counts.requests * factor,
  };
}

function kindParts(counts: TokenCounts): Array<{ key: string; counts: TokenCounts }> {
  return TOKEN_KINDS.map((kind) => {
    const part = zeroCounts();
    part[kind] = counts[kind];
    return { key: kind, counts: part };
  });
}

/** The answer for one query, as `GET /api/activity/tokens` would give it. */
export function tokensAnswer(query: TokenQuery): TokensAnswer {
  const rows = rowsIn(query.from, query.to, query);
  const bucket = bucketOf(query.from, query.to);
  const totals = rows.reduce((sum, row) => addCounts(sum, row.counts), zeroCounts());

  const span = daysBetween(query.from, query.to) + 1;
  const prevTo = addDays(query.from, -1);
  const prevFrom = addDays(prevTo, -(span - 1));
  const previous = { from: prevFrom, to: prevTo, totals: rowsIn(prevFrom, prevTo, query).reduce((sum, row) => addCounts(sum, row.counts), zeroCounts()) };

  /* Buckets. */
  const buckets: Array<{ start: string; end: string; hour?: number }> = [];
  if (bucket === "hour") {
    for (let date = query.from; date <= query.to; date = addDays(date, 1)) {
      for (let hour = 0; hour < 24; hour += 1) buckets.push({ start: date, end: date, hour });
    }
  } else if (bucket === "day") {
    for (let date = query.from; date <= query.to; date = addDays(date, 1)) buckets.push({ start: date, end: date });
  } else {
    let start = query.from;
    while (start <= query.to) {
      const toMonday = (8 - weekday(start)) % 7 || 7;
      const end = addDays(start, toMonday - 1) > query.to ? query.to : addDays(start, toMonday - 1);
      buckets.push({ start, end });
      start = addDays(end, 1);
    }
  }

  const stackKey = (row: FixtureRow) => (query.stack === "kind" ? "" : keyOf(row, query.stack));
  const series: SeriesBucket[] = buckets.map((entry) => {
    const inBucket = rows.filter((row) => row.date >= entry.start && row.date <= entry.end);
    const byKey = new Map<string, TokenCounts>();
    for (const row of inBucket) {
      const key = stackKey(row);
      byKey.set(key, addCounts(byKey.get(key) ?? zeroCounts(), row.counts));
    }
    let parts: Array<{ key: string; counts: TokenCounts }>;
    if (query.stack === "kind") parts = kindParts(byKey.get("") ?? zeroCounts());
    else parts = dimensionOrder(query.stack).filter((key) => byKey.has(key)).map((key) => ({ key, counts: byKey.get(key)! }));
    if (entry.hour !== undefined) {
      const isToday = entry.start === NOW_DATE;
      const weights = HOUR_PROFILE.map((value, hour) => (isToday && hour >= NOW_HOUR ? 0 : value));
      const sum = weights.reduce((a, b) => a + b, 0);
      parts = parts.map((part) => ({ key: part.key, counts: scaled(part.counts, weights[entry.hour!]! / sum) }));
    }
    return {
      start: entry.start,
      end: entry.end,
      label: entry.hour !== undefined ? String(entry.hour).padStart(2, "0") : entry.start,
      counted: entry.end >= COUNTED_FROM,
      partial: entry.end === NOW_DATE && (entry.hour === undefined || entry.hour === NOW_HOUR),
      parts,
    };
  });

  /* The list: top 12 by total, the rest as "other". */
  const byList = new Map<string, TokenCounts>();
  for (const row of rows) {
    const key = keyOf(row, query.list);
    byList.set(key, addCounts(byList.get(key) ?? zeroCounts(), row.counts));
  }
  const ranked = [...byList.entries()].sort((a, b) => totalOf(b[1]) - totalOf(a[1]));
  const head = ranked.slice(0, 12);
  const tail = ranked.slice(12);
  const trendOf = (keys: Set<string>) => buckets.filter((entry) => entry.hour === undefined).map((entry) => rows
    .filter((row) => row.date >= entry.start && row.date <= entry.end && keys.has(keyOf(row, query.list)))
    .reduce((sum, row) => sum + totalOf(row.counts), 0));
  const list: ListRow[] = head.map(([key, counts]) => ({ key, counts, trend: trendOf(new Set([key])) }));
  if (tail.length) {
    list.push({ key: "other", counts: tail.reduce((sum, [, counts]) => addCounts(sum, counts), zeroCounts()), trend: trendOf(new Set(tail.map(([key]) => key))) });
  }

  const time = timeFor(query.from, query.to, query.project === null ? "all" : { project: query.project }, query.filters);
  return {
    query,
    bucket,
    totals,
    previous,
    series,
    list,
    coverage: { countedFrom: COUNTED_FROM, complete: true, pendingGb: 0 },
    time,
  };
}

/** Invented human and agent time on the same days for variant 2: your
    hours share out over projects by their weight, agent hours follow the
    tokens of the scope (about 38 hours per billion). `project: null` is the
    work with no project. */
export function timeFor(from: string, to: string, scope: "all" | { project: string | null }, filters: TokenQuery["filters"]): TokensAnswer["time"] {
  const share = scope === "all" ? 1 : PROJECTS.find((entry) => entry.key === scope.project)?.weight ?? 0;
  const rows = fixtureRows().filter((row) => row.date >= from && row.date <= to && (scope === "all" || row.project === scope.project) && matches(row, { project: null, filters }));
  const days: Array<{ date: string; humanHours: number; agentHours: number }> = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const day = weekday(date);
    const weekend = day === 0 || day === 6;
    const seed = mulberry32(dayMs(date) / DAY_MS);
    const human = weekend ? (date === "2026-10-11" || date === "2026-10-10" ? 0 : seed() * 1.5) : 5 + seed() * 3.5;
    const volume = rows.filter((row) => row.date === date).reduce((sum, row) => sum + totalOf(row.counts), 0);
    days.push({ date, humanHours: Math.round(human * share * 4) / 4, agentHours: Math.round((volume / 1e9) * 38 * 10) / 10 });
  }
  return {
    humanHours: Math.round(days.reduce((sum, day) => sum + day.humanHours, 0) * 2) / 2,
    agentHours: days.reduce((sum, day) => sum + day.agentHours, 0),
    days,
  };
}

/** Extra E3: invented peak window usage per day for an account, in percent. */
export function windowPeaks(account: string, from: string, to: string): Array<{ date: string; fiveHour: number; weekly: number }> {
  const random = mulberry32(account.charCodeAt(5) * 977);
  const out: Array<{ date: string; fiveHour: number; weekly: number }> = [];
  let weekly = 18;
  for (let date = addDays(from, -7); date <= to; date = addDays(date, 1)) {
    const volume = fixtureRows().filter((row) => row.date === date && row.account === account).reduce((sum, row) => sum + totalOf(row.counts), 0);
    const plan = account === "acct-a" ? 8e8 : account === "acct-b" ? 1.6e8 : 7e8;
    const fiveHour = Math.min(100, Math.round((volume / plan) * 55 + random() * 8));
    if (weekday(date) === 4) weekly = 4;
    weekly = Math.min(100, weekly + (volume / plan) * 9);
    if (date >= from) out.push({ date, fiveHour, weekly: Math.round(weekly) });
  }
  return out;
}

/** Extra E4: tokens per lane, with an invented task and pull request. */
export function laneRows(from: string, to: string, query: Pick<TokenQuery, "project" | "filters">): Array<{ lane: string; task: string; pr: number | null; counts: TokenCounts; cost: number }> {
  const byLane = new Map<string, { counts: TokenCounts; cost: number }>();
  for (const row of rowsIn(from, to, query)) {
    if (!row.lane) continue;
    const entry = byLane.get(row.lane) ?? { counts: zeroCounts(), cost: 0 };
    addCounts(entry.counts, row.counts);
    entry.cost += costOf(row.model, row.counts);
    byLane.set(row.lane, entry);
  }
  const TASKS = ["Offline sync for the client cache", "Rate limiter for public endpoints", "Plugin loader", "Message queue retries", "Settings page redesign", "Search index", "Flaky integration test", "Release notes", "Billing export"];
  return [...byLane.entries()]
    .sort((a, b) => totalOf(b[1].counts) - totalOf(a[1].counts))
    .map(([lane, entry]) => {
      const index = parseInt(lane.slice(5), 16) - 1;
      return { lane, task: TASKS[index] ?? lane, pr: index % 3 === 2 ? null : 1400 + index * 37, counts: entry.counts, cost: entry.cost };
    });
}

/** Extra E5: the conversations with the most tokens. */
export function topConversations(from: string, to: string, query: Pick<TokenQuery, "project" | "filters">): Array<{ id: string; title: string; role: string; model: string; project: string | null; counts: TokenCounts }> {
  const byId = new Map<string, { role: string; model: string; project: string | null; counts: TokenCounts }>();
  for (const row of rowsIn(from, to, query)) {
    const entry = byId.get(row.conversation) ?? { role: row.role, model: row.model, project: row.project, counts: zeroCounts() };
    addCounts(entry.counts, row.counts);
    byId.set(row.conversation, entry);
  }
  return [...byId.entries()]
    .sort((a, b) => totalOf(b[1].counts) - totalOf(a[1].counts))
    .map(([id, entry]) => ({ id, title: conversationTitle(id), ...entry }));
}
