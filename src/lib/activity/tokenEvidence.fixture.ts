import { zonedDays } from "./method";
import { ActivityStore } from "./store";
import { commitUsage, HOUR } from "./tokenStore";
import { accountKey, type TokenCounts, type UsageRecord } from "./tokenUsage";

/*
 * The token store the rendered evidence draws (docs/design/activity-token-usage.md
 * §9.6), written through the ingest's own commit: invented projects, members,
 * accounts and roles over the last 30 days of a 35-day window, with cache
 * reads near 97 % of input, output near 0.45 % of input and reasoning a third
 * of output; one heavy day, one empty weekend, today partial to 14:00, and
 * the five oldest days before anything was counted. Deterministic for a
 * given `now`.
 */

export const EVIDENCE_TZ = "Europe/Kyiv";
export const EVIDENCE_DAYS = 35;
export const EVIDENCE_COUNTED_DAYS = 30;
/** The free range the frames apply: window days 1 to 16. */
export function evidenceRange(now: number): { from: string; to: string } {
  const days = zonedDays(now, EVIDENCE_DAYS, EVIDENCE_TZ);
  return { from: days[1]!.date, to: days[16]!.date };
}

/** Four days at the window's start, all before anything was counted. */
export function evidenceUncountedRange(now: number): { from: string; to: string } {
  const days = zonedDays(now, EVIDENCE_DAYS, EVIDENCE_TZ);
  return { from: days[0]!.date, to: days[3]!.date };
}

const MODELS: ReadonlyArray<[string, "claude" | "codex", number]> = [
  ["claude-opus-5-5", "claude", 0.4], ["gpt-6.1-sol", "codex", 0.18], ["claude-sonnet-5-5", "claude", 0.12], ["gpt-6-astra", "codex", 0.1],
  ["claude-fable-5-1", "claude", 0.1], ["gpt-6-luna", "codex", 0.06], ["claude-haiku-5-5", "claude", 0.03], ["claude-opus-4-1", "claude", 0.01],
];
const ROLES: ReadonlyArray<[string, number]> = [
  ["builder", 0.34], ["orchestrator", 0.18], ["reviewer", 0.14], ["none", 0.1], ["unregistered", 0.06], ["visual-critic", 0.06],
  ["architect", 0.05], ["merger", 0.04], ["fixer", 0.03],
];
export const EVIDENCE_PROJECTS: ReadonlyArray<[string, number]> = [
  ["orchard-client", 0.3], ["lantern-api", 0.22], ["kestrel-cli", 0.16], ["sorrel-bot", 0.12], ["harbor-ledger", 0.05], ["quill-docs", 0.04],
  ["marten-sync", 0.03], ["juniper-web", 0.03], ["osprey-etl", 0.02], ["tamarack-ui", 0.02], ["wren-infra", 0.01],
];
/** Member ids of the capture driver's team, and one share left unattributed. */
export const EVIDENCE_MEMBERS: ReadonlyArray<[string, number]> = [
  ["m_ada0000000000000000000000000000", 0.55], ["m_bo00000000000000000000000000000", 0.3], ["m_cy00000000000000000000000000000", 0.12], ["", 0.03],
];

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(entries: ReadonlyArray<readonly [T, ...unknown[]]>, weightAt: number, roll: number): T {
  const total = entries.reduce((sum, entry) => sum + (entry[weightAt] as number), 0);
  let left = roll * total;
  for (const entry of entries) {
    left -= entry[weightAt] as number;
    if (left <= 0) return entry[0];
  }
  return entries.at(-1)![0];
}

/** Seeds `file` and returns the first counted moment and the record count. */
export function seedTokenEvidence(file: string, now: number): { countedFrom: number; records: number } {
  const days = zonedDays(now, EVIDENCE_DAYS, EVIDENCE_TZ);
  const roll = random(Math.floor(now / 86_400_000));
  const today = days.length - 1;
  /* The free range the evidence frames (days 1–16 of the window) holds four
     uncounted days, the heavy day and, before it, the empty weekend. */
  const heavy = days.length - EVIDENCE_COUNTED_DAYS + 7;
  const emptyWeekend = new Set(days.map((day, index) => ({ index, weekday: new Date(`${day.date}T12:00:00Z`).getUTCDay() }))
    .filter((entry) => entry.index < heavy && entry.index >= 7 && (entry.weekday === 0 || entry.weekday === 6)).map((entry) => entry.index));
  const records: Array<{ owner: Parameters<typeof commitUsage>[1]["owner"]; record: UsageRecord; member: string; account: string }> = [];
  let countedFrom = Number.POSITIVE_INFINITY;
  for (let index = days.length - EVIDENCE_COUNTED_DAYS; index < days.length; index++) {
    if (emptyWeekend.has(index)) continue;
    const day = days[index]!;
    const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay();
    const scale = (index === heavy ? 2.2 : weekday === 0 || weekday === 6 ? 0.3 : 1) * (0.75 + roll() * 0.5);
    for (let hour = 8; hour < 20; hour++) {
      const at = day.start + hour * HOUR + 17 * 60_000;
      if (index === today && (hour >= 14 || at > now)) break;
      for (let n = 0; n < 6; n++) {
        const chosen = pick(MODELS, 2, roll());
        const [model, engine] = MODELS.find((entry) => entry[0] === chosen)!;
        const role = pick(ROLES, 1, roll());
        const project = pick(EVIDENCE_PROJECTS, 1, roll());
        const member = pick(EVIDENCE_MEMBERS, 1, roll());
        const account = engine === "codex" ? accountKey("codex", "default") : accountKey("claude", roll() < 0.6 ? "default" : "claude-b");
        const input = Math.round(scale * (2.5e6 + roll() * 6e6));
        const cacheWrite = engine === "claude" ? Math.round(input * 0.015) : 0;
        const output = Math.round(input * (0.0035 + roll() * 0.002));
        const counts: TokenCounts = {
          input: Math.round(input * 0.02),
          cacheRead: input - Math.round(input * 0.02) - cacheWrite,
          cacheWrite,
          cacheWrite1h: Math.round(cacheWrite * 0.4),
          output,
          reasoning: Math.round(output * 0.34),
          requests: 1,
        };
        const id = `evidence-${day.date}-${hour}-${n}`;
        const tier = model === "claude-opus-5-5" && roll() < 0.1 ? "fast" : "standard";
        const record: UsageRecord = { engine, id, at, model, tier, counts, ...(engine === "codex" ? { cumulative: {
          total: counts.input + counts.cacheRead + counts.cacheWrite + counts.output, input: counts.input + counts.cacheRead + counts.cacheWrite,
          cached: counts.cacheRead, cacheWrite: counts.cacheWrite, output: counts.output, reasoning: counts.reasoning,
        } } : {}) };
        records.push({ owner: { conversation: id, project, engine, role, pipelineId: null, stageId: null }, record, member, account });
        countedFrom = Math.min(countedFrom, at);
      }
    }
  }
  const store = ActivityStore.open(file);
  try {
    store.transaction(() => {
      for (const entry of records) {
        commitUsage(store.db, { owner: entry.owner, records: [entry.record], attribution: () => ({ member: entry.member, account: entry.account, model: null, tier: null }), malformed: 0, now });
      }
    });
  } finally {
    store.close();
  }
  return { countedFrom, records: records.length };
}

/** The coverage the amber frames are drawn in: a backfill still to read. */
export function markTokenBackfill(file: string, pendingBytes: number): void {
  const store = ActivityStore.open(file);
  try {
    store.db.query("UPDATE usage_meta SET pending_bytes=?, complete=?, version=version+1 WHERE singleton=1").run(pendingBytes, pendingBytes > 0 ? 0 : 1);
  } finally {
    store.close();
  }
}
