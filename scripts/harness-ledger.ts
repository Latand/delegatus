/**
 * Harness ledger (docs/design/rrsi-lessons.md, proposal 1): one row per
 * recorded stage attempt, one table per harness version, the week-to-week
 * noise band, and the pre-registered replay of three scaffold changes.
 *
 *   bun scripts/harness-ledger.ts --db <copy of state.sqlite> --out <dir> [--no-tokens]
 *
 * Read-only. It opens the one database file it is handed, read-only, and never
 * resolves a state directory: pass a COPY (`sqlite3 <live> ".backup <copy>"`)
 * made into a scratch directory. A path inside an `agent-log-viewer/state`
 * directory is refused. Besides the copy it reads `git log` and, for tokens,
 * the transcript each attempt names when that file is still on disk.
 */
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { failEdgeRoundsUsed } from "@/lib/pipelines/failEdgeBudget";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";

// ---------------------------------------------------------------------------
// Rows

export type LedgerVerdict = "pass" | "fail" | "needs_decision" | "none";
export type ProjectSplit = "this" | "other";
export type SeverityCounts = { P0: number; P1: number; P2: number; P3: number; unranked: number };

export type LedgerRow = {
  pipelineId: string;
  stageId: string;
  attempt: number;
  role: string;
  /** First 12 hex of sha256 over the rendered scaffold; "none" when absent. */
  scaffoldHash: string;
  /** `<engine>/<model>` — the stratum. */
  model: string;
  effort: string;
  project: string;
  split: ProjectSplit;
  week: string;
  startedAt: string | null;
  /** A settled attempt that carries no verdict is `none`, counted as a failure. */
  verdict: LedgerVerdict;
  findings: SeverityCounts;
  wrongPremise: number;
  overBuilt: number;
  /** The pipeline's fail-edge rounds, summed over its fail edges with the same
      count the engine uses (`failEdgeRoundsUsed` → `edgeRoundsUsed`). */
  pipelineFailEdgeRounds: number;
  pipelineHasFailEdge: boolean;
  pipelineState: string;
  /** The pipeline passed: it completed, or every final stage's last own
      attempt passed. A lane closed after its merge reads `closed`, so the
      state alone undercounts. */
  pipelinePassed: boolean;
  pipelineWeek: string;
  tokens: { total: number; output: number } | null;
};

/** Attempt states that settled. In-flight attempts are left out, and so are
    skipped ones, which never ran. */
const SETTLED = new Set(["passed", "failed", "needs_decision"]);
const TERMINAL_PIPELINE = new Set(["completed", "closed"]);

export const WRONG_PREMISE = /WRONG[-_ ]?PREMISE/i;
export const OVER_BUILT = /OVER[-_ ]?BUILT/i;

export function scaffoldHash(text: string | null | undefined): string {
  if (!text) return "none";
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/** ISO-8601 week, `YYYY-Www`, of an ISO timestamp (UTC). */
export function isoWeek(iso: string): string {
  const date = new Date(iso);
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Findings by severity. Ranked records win; otherwise the rendered
    `P1 — text` prefix; anything else is unranked. */
export function countFindings(verdict: PipelineStageAttempt["verdict"]): { counts: SeverityCounts; texts: string[] } {
  const counts: SeverityCounts = { P0: 0, P1: 0, P2: 0, P3: 0, unranked: 0 };
  if (!verdict) return { counts, texts: [] };
  if (verdict.rankedFindings?.length) {
    for (const finding of verdict.rankedFindings) counts[finding.severity ?? "unranked"]++;
    return { counts, texts: verdict.rankedFindings.map((finding) => finding.text) };
  }
  const texts: string[] = [];
  for (const raw of verdict.findings ?? []) {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const match = /^\s*(P[0-3])\b/.exec(text);
    counts[(match?.[1] as keyof SeverityCounts | undefined) ?? "unranked"]++;
    texts.push(text);
  }
  return { counts, texts };
}

export function pipelineFailEdgeRounds(pipeline: Pipeline): { rounds: number; hasFailEdge: boolean } {
  let rounds = 0;
  let hasFailEdge = false;
  for (const stage of pipeline.stages ?? []) {
    if (!stage.onFail) continue;
    hasFailEdge = true;
    rounds += failEdgeRoundsUsed(pipeline, stage);
  }
  return { rounds, hasFailEdge };
}

export function pipelinePassed(pipeline: Pipeline): boolean {
  if (pipeline.state === "completed") return true;
  const finals = (pipeline.stages ?? []).filter((stage) => !stage.next);
  if (!finals.length) return false;
  return finals.every((stage) => {
    const run = pipeline.runs?.find((candidate) => candidate.stageId === stage.id);
    const last = run?.attempts.filter((attempt) => !attempt.historical && !attempt.legacyReview).at(-1);
    return last?.verdict?.status === "pass";
  });
}

export type TokenReader = (transcriptPath: string) => { total: number; output: number } | null;

export function ledgerRows(
  pipelines: Pipeline[],
  isThisProject: (pipeline: Pipeline) => boolean,
  readTokens: TokenReader | null,
): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const pipeline of pipelines) {
    const { rounds, hasFailEdge } = pipelineFailEdgeRounds(pipeline);
    const passed = pipelinePassed(pipeline);
    const split: ProjectSplit = isThisProject(pipeline) ? "this" : "other";
    for (const run of pipeline.runs ?? []) {
      for (const attempt of run.attempts ?? []) {
        if (attempt.historical || attempt.legacyReview || !SETTLED.has(attempt.state)) continue;
        const role = attempt.effectiveRole;
        const { counts, texts } = countFindings(attempt.verdict);
        const startedAt = attempt.startedAt ?? null;
        rows.push({
          pipelineId: pipeline.id,
          stageId: run.stageId,
          attempt: attempt.n,
          role: role?.roleId ?? "custom",
          scaffoldHash: scaffoldHash(role?.promptScaffold),
          model: `${role?.engine ?? "?"}/${role?.model ?? "?"}`,
          effort: role?.effort ?? "?",
          project: pipeline.project,
          split,
          week: isoWeek(startedAt ?? pipeline.createdAt),
          startedAt,
          verdict: attempt.verdict?.status ?? "none",
          findings: counts,
          wrongPremise: texts.filter((text) => WRONG_PREMISE.test(text)).length,
          overBuilt: texts.filter((text) => OVER_BUILT.test(text)).length,
          pipelineFailEdgeRounds: rounds,
          pipelineHasFailEdge: hasFailEdge,
          pipelineState: pipeline.state,
          pipelinePassed: passed,
          pipelineWeek: isoWeek(pipeline.createdAt),
          tokens: readTokens && attempt.agentPath ? readTokens(attempt.agentPath) : null,
        });
      }
    }
  }
  return rows;
}

/** Tokens a transcript spent. Claude: the usage of each assistant message
    (input, cache writes, cache reads and output), once per message id. Codex:
    the last cumulative `token_count`. Null when the file is gone or holds no
    usage. The whole file is counted: every stage attempt has its own. */
export function transcriptTokens(transcriptPath: string): { total: number; output: number } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const claude = new Map<string, { total: number; output: number }>();
  let codex: { total: number; output: number } | null = null;
  for (const line of raw.split("\n")) {
    if (line.includes('"token_count"')) {
      try {
        const usage = JSON.parse(line)?.payload?.info?.total_token_usage;
        if (usage && typeof usage.total_tokens === "number") {
          codex = { total: usage.total_tokens, output: (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0) };
        }
      } catch { /* a torn line */ }
    } else if (line.includes('"usage"') && line.includes('"assistant"')) {
      try {
        const message = JSON.parse(line)?.message;
        const usage = message?.usage;
        if (!usage || typeof message.id !== "string") continue;
        const output = usage.output_tokens ?? 0;
        claude.set(message.id, {
          total: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + output,
          output,
        });
      } catch { /* a torn line */ }
    }
  }
  if (codex) return codex;
  if (!claude.size) return null;
  let total = 0;
  let output = 0;
  for (const usage of claude.values()) {
    total += usage.total;
    output += usage.output;
  }
  return { total, output };
}

// ---------------------------------------------------------------------------
// Bootstrap

/** Deterministic PRNG, so a rerun on the same copy prints the same intervals. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** One resampling unit: a cluster of observations (a pipeline's attempts) as
    its sum and count, so correlated attempts are resampled together. */
export type Cluster = { sum: number; n: number };

export type Estimate = { value: number; lo: number; hi: number; n: number; clusters: number };

function resample<T>(units: T[], rng: () => number): T[] {
  const out: T[] = new Array(units.length);
  for (let index = 0; index < units.length; index++) out[index] = units[Math.floor(rng() * units.length)];
  return out;
}

function mean(clusters: Cluster[]): { value: number; n: number } {
  let sum = 0;
  let n = 0;
  for (const cluster of clusters) {
    sum += cluster.sum;
    n += cluster.n;
  }
  return { value: n ? sum / n : NaN, n };
}

/** A ratio mean (a rate, or rounds per pipeline) with a percentile cluster
    bootstrap interval. */
export function bootstrapMean(clusters: Cluster[], iterations: number, rng: () => number, level = 0.95): Estimate | null {
  const point = mean(clusters);
  if (!point.n) return null;
  const draws: number[] = [];
  for (let index = 0; index < iterations; index++) draws.push(mean(resample(clusters, rng)).value);
  draws.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return { value: point.value, lo: percentile(draws, tail), hi: percentile(draws, 1 - tail), n: point.n, clusters: clusters.length };
}

export type StratifiedArms = { before: Map<string, Cluster[]>; after: Map<string, Cluster[]> };

/** After minus before, averaged over the strata present in both arms with
    weight nB·nA/(nB+nA) (observations). Strata present in one arm only are
    dropped. Null when no stratum is shared. */
export function stratifiedEffect(arms: StratifiedArms): number | null {
  let weighted = 0;
  let weights = 0;
  for (const [stratum, before] of arms.before) {
    const after = arms.after.get(stratum);
    if (!after?.length || !before.length) continue;
    const b = mean(before);
    const a = mean(after);
    if (!b.n || !a.n) continue;
    const weight = (b.n * a.n) / (b.n + a.n);
    weighted += weight * (a.value - b.value);
    weights += weight;
  }
  return weights ? weighted / weights : null;
}

export type EffectEstimate = {
  value: number;
  lo: number;
  hi: number;
  nBefore: number;
  nAfter: number;
  strata: string[];
};

/** The stratified effect with a bootstrap interval: clusters are resampled
    within each arm and stratum. */
export function bootstrapStratifiedEffect(arms: StratifiedArms, iterations: number, rng: () => number, level = 0.95): EffectEstimate | null {
  const shared = [...arms.before.keys()].filter((stratum) => arms.before.get(stratum)?.length && arms.after.get(stratum)?.length).sort();
  const restricted: StratifiedArms = {
    before: new Map(shared.map((stratum) => [stratum, arms.before.get(stratum)!])),
    after: new Map(shared.map((stratum) => [stratum, arms.after.get(stratum)!])),
  };
  const value = stratifiedEffect(restricted);
  if (value === null) return null;
  const draws: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const draw = stratifiedEffect({
      before: new Map(shared.map((stratum) => [stratum, resample(restricted.before.get(stratum)!, rng)])),
      after: new Map(shared.map((stratum) => [stratum, resample(restricted.after.get(stratum)!, rng)])),
    });
    if (draw !== null) draws.push(draw);
  }
  draws.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  const count = (side: Map<string, Cluster[]>) => [...side.values()].reduce((sum, clusters) => sum + mean(clusters).n, 0);
  return { value, lo: percentile(draws, tail), hi: percentile(draws, 1 - tail), nBefore: count(restricted.before), nAfter: count(restricted.after), strata: shared };
}

// ---------------------------------------------------------------------------
// Outcomes and the noise band

/** The three outcomes of the replay (rrsi-lessons.md §3.1). None of them is
    the reviewer's own verdict. */
export const OUTCOMES = ["roundsToPass", "noVerdict", "wrongPremise"] as const;
export type Outcome = typeof OUTCOMES[number];
export const OUTCOME_LABEL: Record<Outcome, string> = {
  roundsToPass: "rounds-to-pass (rounds)",
  noVerdict: "no-verdict rate (points)",
  wrongPremise: "WRONG-PREMISE rate (points)",
};
/** Rates are compared in percentage points; rounds in rounds. */
export const OUTCOME_SCALE: Record<Outcome, number> = { roundsToPass: 1, noVerdict: 100, wrongPremise: 100 };
export const RATE_OUTCOMES: readonly Outcome[] = ["noVerdict", "wrongPremise"];

/** A pipeline-or-attempt observation of one outcome, keyed for stratification. */
export type Observation = { pipelineId: string; version: string; model: string; split: ProjectSplit; week: string; sum: number; n: number };

/**
 * The observations of each outcome for one role, each attributed to the
 * version and model of that role in the pipeline:
 * - rounds-to-pass: a passed pipeline (`pipelinePassed`) with a fail edge,
 *   valued at its fail-edge rounds; attributed by the pipeline's first attempt of the role;
 * - WRONG-PREMISE: a finished (completed or closed) pipeline, 1 when any of its
 *   findings carries the marker; attributed the same way;
 * - no-verdict: each settled attempt of the role, 1 when it carries no verdict;
 *   clustered by pipeline.
 */
export function outcomeObservations(rows: LedgerRow[], role: string): Record<Outcome, Observation[]> {
  const byPipeline = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const list = byPipeline.get(row.pipelineId);
    if (list) list.push(row);
    else byPipeline.set(row.pipelineId, [row]);
  }
  const result: Record<Outcome, Observation[]> = { roundsToPass: [], noVerdict: [], wrongPremise: [] };
  for (const [pipelineId, pipelineRows] of byPipeline) {
    const own = pipelineRows
      .filter((row) => row.role === role)
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || a.attempt - b.attempt);
    if (!own.length) continue;
    const first = own[0];
    const pipelineKey = { pipelineId, version: first.scaffoldHash, model: first.model, split: first.split, week: first.pipelineWeek };
    if (first.pipelinePassed && first.pipelineHasFailEdge) {
      result.roundsToPass.push({ ...pipelineKey, sum: first.pipelineFailEdgeRounds, n: 1 });
    }
    if (TERMINAL_PIPELINE.has(first.pipelineState)) {
      result.wrongPremise.push({ ...pipelineKey, sum: pipelineRows.some((row) => row.wrongPremise > 0) ? 1 : 0, n: 1 });
    }
    const clusters = new Map<string, Observation>();
    for (const row of own) {
      const key = `${row.scaffoldHash}|${row.model}|${row.week}`;
      const cluster = clusters.get(key) ?? { pipelineId, version: row.scaffoldHash, model: row.model, split: row.split, week: row.week, sum: 0, n: 0 };
      cluster.sum += row.verdict === "none" ? 1 : 0;
      cluster.n += 1;
      clusters.set(key, cluster);
    }
    result.noVerdict.push(...clusters.values());
  }
  return result;
}

export type NoiseBand = {
  /** Pooled week-to-week standard deviation, in the outcome's scale. */
  delta: number | null;
  cells: number;
  weeks: number;
  units: number;
};

/** Minimum observations for a week to count toward the noise band. */
export const NOISE_MIN_WEEK_N = 5;

/**
 * δ for one outcome: within each cell of an unchanged harness (version, model,
 * project split), the per-week mean of every week holding at least
 * NOISE_MIN_WEEK_N observations; δ is the standard deviation of those weekly
 * means around their cell's mean, pooled over every cell with two or more such
 * weeks (Σ squared deviations / Σ (weeks − 1)). Scaled to points for rates.
 */
export function noiseBand(observations: Observation[], scale: number): NoiseBand {
  const cells = new Map<string, Map<string, Cluster>>();
  for (const observation of observations) {
    const cellKey = `${observation.version}|${observation.model}|${observation.split}`;
    const weeks = cells.get(cellKey) ?? new Map<string, Cluster>();
    const week = weeks.get(observation.week) ?? { sum: 0, n: 0 };
    week.sum += observation.sum;
    week.n += observation.n;
    weeks.set(observation.week, week);
    cells.set(cellKey, weeks);
  }
  let squares = 0;
  let freedom = 0;
  let usedCells = 0;
  let usedWeeks = 0;
  let units = 0;
  for (const weeks of cells.values()) {
    const means = [...weeks.values()].filter((week) => week.n >= NOISE_MIN_WEEK_N).map((week) => (week.sum / week.n) * scale);
    if (means.length < 2) continue;
    const average = means.reduce((sum, value) => sum + value, 0) / means.length;
    squares += means.reduce((sum, value) => sum + (value - average) ** 2, 0);
    freedom += means.length - 1;
    usedCells += 1;
    usedWeeks += means.length;
    units += [...weeks.values()].filter((week) => week.n >= NOISE_MIN_WEEK_N).reduce((sum, week) => sum + week.n, 0);
  }
  return { delta: freedom ? Math.sqrt(squares / freedom) : null, cells: usedCells, weeks: usedWeeks, units };
}

// ---------------------------------------------------------------------------
// The pre-registered experiment (rrsi-lessons.md §3.1)

export type ScaffoldChange = { id: string; label: string; role: string; before: string; after: string; adds: string };

/**
 * The three recorded changes, fixed before any outcome was computed. Each pair
 * is the rendered scaffold in force immediately before and immediately after
 * the change, and the two texts differ only by the sentences named in `adds`.
 * A change "of 2026-09-19" is the version in force when that day began against
 * the version in force when it ended; the hour-long intermediate version that
 * day (between #1770 and #1843 landing) belongs to neither arm.
 */
export const PREREGISTERED_CHANGES: readonly ScaffoldChange[] = [
  { id: "reviewer-1428", label: "#1428 search sentence (reviewer)", role: "reviewer", before: "6203210e5e2f", after: "f2b931775daf", adds: "the #1428 prior-conversation search sentence" },
  { id: "builder-0919", label: "2026-09-19 builder change", role: "builder", before: "b36fadf4d3f7", after: "c64f933672dc", adds: "the #1770 process-cleanup rule and the #1843 human-in-the-loop paragraph" },
  { id: "architect-0919", label: "2026-09-19 architect change", role: "architect", before: "bdeecbae2d0b", after: "6d25f06c4803", adds: "the #1770 process-cleanup rule and the #1843 human-in-the-loop paragraph" },
];

/** δ above this many points makes a rate outcome unable to guide us. */
export const DELTA_CAP_POINTS = 10;
export const BOOTSTRAP_ITERATIONS = 2000;
export const BOOTSTRAP_SEED = 20260925;

export type ChangeResult = {
  change: ScaffoldChange;
  outcome: Outcome;
  delta: number | null;
  /** δ is known and, for a rate, at most DELTA_CAP_POINTS. */
  usable: boolean;
  bySplit: Record<ProjectSplit, EffectEstimate | null>;
  /** |effect| > δ in both splits with the same sign, on a usable outcome. */
  exceedsDeltaBothSplits: boolean;
};

export type ExperimentVerdict = "value proven" | "value disproved" | "value not proven (neither condition holds)";

/** Collapse a version's observations into clusters per model stratum. */
function armClusters(observations: Observation[], version: string, split: ProjectSplit, scale: number): Map<string, Cluster[]> {
  const strata = new Map<string, Cluster[]>();
  for (const observation of observations) {
    if (observation.version !== version || observation.split !== split) continue;
    const list = strata.get(observation.model) ?? [];
    list.push({ sum: observation.sum * scale, n: observation.n });
    strata.set(observation.model, list);
  }
  return strata;
}

/** Same pipeline's clusters of one version merge into one resampling unit. */
function mergeByPipeline(observations: Observation[]): Observation[] {
  const merged = new Map<string, Observation>();
  for (const observation of observations) {
    const key = `${observation.pipelineId}|${observation.version}|${observation.model}`;
    const existing = merged.get(key);
    if (existing) {
      existing.sum += observation.sum;
      existing.n += observation.n;
    } else merged.set(key, { ...observation });
  }
  return [...merged.values()];
}

export function runChange(
  change: ScaffoldChange,
  observations: Record<Outcome, Observation[]>,
  noise: Record<Outcome, NoiseBand>,
  iterations = BOOTSTRAP_ITERATIONS,
  seed = BOOTSTRAP_SEED,
): ChangeResult[] {
  return OUTCOMES.map((outcome, index) => {
    const scale = OUTCOME_SCALE[outcome];
    const units = mergeByPipeline(observations[outcome]);
    const bySplit = {} as Record<ProjectSplit, EffectEstimate | null>;
    (["this", "other"] as const).forEach((split, splitIndex) => {
      const rng = mulberry32(seed + index * 7 + splitIndex);
      bySplit[split] = bootstrapStratifiedEffect(
        { before: armClusters(units, change.before, split, scale), after: armClusters(units, change.after, split, scale) },
        iterations,
        rng,
      );
    });
    const delta = noise[outcome].delta;
    const usable = delta !== null && (!RATE_OUTCOMES.includes(outcome) || delta <= DELTA_CAP_POINTS);
    const here = bySplit.this;
    const there = bySplit.other;
    const exceedsDeltaBothSplits = usable && here !== null && there !== null
      && Math.abs(here.value) > delta! && Math.abs(there.value) > delta!
      && Math.sign(here.value) === Math.sign(there.value);
    return { change, outcome, delta, usable, bySplit, exceedsDeltaBothSplits };
  });
}

/**
 * The doc's rule, with the readings it leaves open fixed here before any data:
 * - "value disproved" when every effect interval that could be computed
 *   straddles zero (includes it), or when δ exceeds DELTA_CAP_POINTS on every
 *   rate outcome of every changed role (no rate outcome could guide us);
 * - otherwise "value proven" when some change, on a usable outcome, shows an
 *   effect larger than δ in this repository and in the others, same sign;
 * - otherwise neither condition holds, reported as such.
 * Disproval is checked first: the doc's default answer is no.
 */
export function decide(results: ChangeResult[]): { verdict: ExperimentVerdict; reasons: string[] } {
  const reasons: string[] = [];
  const intervals = results.flatMap((result) => [result.bySplit.this, result.bySplit.other]).filter((estimate): estimate is EffectEstimate => estimate !== null);
  const allStraddle = intervals.length > 0 && intervals.every((estimate) => estimate.lo <= 0 && estimate.hi >= 0);
  const rateResults = results.filter((result) => RATE_OUTCOMES.includes(result.outcome));
  const deltaTooWide = rateResults.length > 0 && rateResults.every((result) => result.delta === null || result.delta > DELTA_CAP_POINTS);
  if (!intervals.length) reasons.push("no effect interval could be computed");
  if (allStraddle) reasons.push(`every one of the ${intervals.length} effect intervals includes zero`);
  if (deltaTooWide) reasons.push(`δ exceeds ${DELTA_CAP_POINTS} points (or is unmeasured) on every rate outcome of every changed role`);
  if (allStraddle || deltaTooWide || !intervals.length) return { verdict: "value disproved", reasons };
  const proving = results.filter((result) => result.exceedsDeltaBothSplits);
  for (const result of proving) reasons.push(`${result.change.label}: ${OUTCOME_LABEL[result.outcome]} moves by more than δ in both splits, same direction`);
  if (proving.length) return { verdict: "value proven", reasons };
  reasons.push("some interval excludes zero and some rate δ is within the cap, but no change moves an outcome by more than δ in both splits in the same direction");
  return { verdict: "value not proven (neither condition holds)", reasons };
}

// ---------------------------------------------------------------------------
// Version tables

const RATE_COLUMNS = [
  ["pass", (row: LedgerRow) => row.verdict === "pass"],
  ["fail", (row: LedgerRow) => row.verdict === "fail"],
  ["needs_decision", (row: LedgerRow) => row.verdict === "needs_decision"],
  ["no verdict", (row: LedgerRow) => row.verdict === "none"],
  ["WRONG-PREMISE", (row: LedgerRow) => row.wrongPremise > 0],
  ["OVER-BUILT", (row: LedgerRow) => row.overBuilt > 0],
] as const;

function clustersOf(rows: LedgerRow[], predicate: (row: LedgerRow) => boolean): Cluster[] {
  const byPipeline = new Map<string, Cluster>();
  for (const row of rows) {
    const cluster = byPipeline.get(row.pipelineId) ?? { sum: 0, n: 0 };
    cluster.sum += predicate(row) ? 1 : 0;
    cluster.n += 1;
    byPipeline.set(row.pipelineId, cluster);
  }
  return [...byPipeline.values()];
}

const pct = (value: number) => (Number.isFinite(value) ? (value * 100).toFixed(0) : "–");
const formatRate = (estimate: Estimate | null) => (estimate ? `${pct(estimate.value)} [${pct(estimate.lo)}, ${pct(estimate.hi)}]` : "–");

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

export type VersionKey = { role: string; scaffoldHash: string };
export type VersionSummary = VersionKey & { n: number; first: string; last: string };

export function versionSummaries(rows: LedgerRow[]): VersionSummary[] {
  const versions = new Map<string, VersionSummary>();
  for (const row of rows) {
    const key = `${row.role}|${row.scaffoldHash}`;
    const time = row.startedAt ?? "";
    const version = versions.get(key) ?? { role: row.role, scaffoldHash: row.scaffoldHash, n: 0, first: time, last: time };
    version.n += 1;
    if (time && (!version.first || time < version.first)) version.first = time;
    if (time > version.last) version.last = time;
    versions.set(key, version);
  }
  return [...versions.values()].sort((a, b) => a.role.localeCompare(b.role) || a.first.localeCompare(b.first));
}

/** One markdown table for one harness version: a row per model × split
    stratum plus the pooled row, rates in percent with 95 % cluster-bootstrap
    intervals, n beside every rate. */
export function versionTable(rows: LedgerRow[], version: VersionKey, iterations: number, seed: number): string {
  const own = rows.filter((row) => row.role === version.role && row.scaffoldHash === version.scaffoldHash);
  const strata = new Map<string, LedgerRow[]>();
  for (const row of own) {
    const key = `${row.model} · ${row.split}`;
    const list = strata.get(key) ?? [];
    list.push(row);
    strata.set(key, list);
  }
  const lines = [
    `| stratum | n (pipelines) | ${RATE_COLUMNS.map(([label]) => `${label} %`).join(" | ")} | findings P0/P1/P2/P3/unranked per attempt | median tokens (n) |`,
    `|---|---|${RATE_COLUMNS.map(() => "---").join("|")}|---|---|`,
  ];
  const entries = [...[...strata.entries()].sort((a, b) => b[1].length - a[1].length), ["all", own] as [string, LedgerRow[]]];
  entries.forEach(([label, stratumRows], index) => {
    const rng = mulberry32(seed + index);
    const pipelines = new Set(stratumRows.map((row) => row.pipelineId)).size;
    const cells = RATE_COLUMNS.map(([, predicate]) => formatRate(bootstrapMean(clustersOf(stratumRows, predicate), iterations, rng)));
    const findings = (["P0", "P1", "P2", "P3", "unranked"] as const)
      .map((severity) => (stratumRows.reduce((sum, row) => sum + row.findings[severity], 0) / stratumRows.length).toFixed(2))
      .join("/");
    const tokens = stratumRows.flatMap((row) => (row.tokens ? [row.tokens.total] : []));
    const tokenMedian = median(tokens);
    lines.push(`| ${label} | ${stratumRows.length} (${pipelines}) | ${cells.join(" | ")} | ${findings} | ${tokenMedian === null ? "–" : `${Math.round(tokenMedian / 1000)}k`} (${tokens.length}) |`);
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Provenance: which commit introduced each version's text

export type Provenance = { added: number; commits: Array<{ sha: string; date: string; issues: string[] }>; unmatched: number };

export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

/** A literal window of a rendered sentence that source code would carry
    verbatim: no quotes, escapes, template syntax or rendered parameters. */
export function searchableChunk(sentence: string, width = 40): string | null {
  const clean = /^[^"\\`${}]+$/;
  for (let start = 0; start + width <= sentence.length; start += 8) {
    const chunk = sentence.slice(start, start + width);
    if (clean.test(chunk)) return chunk;
  }
  return null;
}

function gitIntroducing(repo: string, chunk: string, cache: Map<string, Provenance["commits"][number] | null>) {
  if (cache.has(chunk)) return cache.get(chunk)!;
  let found: Provenance["commits"][number] | null = null;
  try {
    const out = execFileSync("git", ["-C", repo, "log", "--reverse", `-S${chunk}`, "--format=%h|%as|%s", "--", "src/lib/roles", "src/lib/pipelines", "src/lib/orchestrator"], { encoding: "utf8", maxBuffer: 16 << 20 }).trim();
    const first = out.split("\n")[0];
    if (first) {
      const [sha, date, subject = ""] = first.split("|");
      found = { sha, date, issues: [...new Set(subject.match(/#\d+/g) ?? [])] };
    }
  } catch { /* git unavailable: provenance stays unknown */ }
  cache.set(chunk, found);
  return found;
}

/** For each version: the sentences it adds over the closest version of the
    same role seen earlier, and the oldest commit whose diff carries each. */
export function scaffoldProvenance(repo: string, texts: Map<string, { role: string; text: string; first: string }>): Map<string, Provenance> {
  const cache = new Map<string, Provenance["commits"][number] | null>();
  const result = new Map<string, Provenance>();
  const entries = [...texts.entries()].sort((a, b) => a[1].first.localeCompare(b[1].first));
  entries.forEach(([hash, version], index) => {
    const own = sentences(version.text);
    let closest: string[] = [];
    let overlap = -1;
    for (const [, earlier] of entries.slice(0, index)) {
      if (earlier.role !== version.role) continue;
      const earlierSentences = sentences(earlier.text);
      const shared = own.filter((sentence) => earlierSentences.includes(sentence)).length;
      if (shared > overlap) {
        overlap = shared;
        closest = earlierSentences;
      }
    }
    const added = own.filter((sentence) => !closest.includes(sentence));
    const commits = new Map<string, Provenance["commits"][number]>();
    let unmatched = 0;
    for (const sentence of added) {
      const chunk = searchableChunk(sentence);
      const commit = chunk ? gitIntroducing(repo, chunk, cache) : null;
      if (commit) commits.set(commit.sha, commit);
      else unmatched += 1;
    }
    result.set(hash, { added: added.length, commits: [...commits.values()].sort((a, b) => a.date.localeCompare(b.date)), unmatched });
  });
  return result;
}

// ---------------------------------------------------------------------------
// Input

/** Refuse anything that looks like a live state directory. A string check on
    the path handed in; nothing is resolved. */
export function assertNotLiveState(dbPath: string): void {
  const resolved = path.resolve(dbPath);
  if (/[\\/]agent-log-viewer[\\/]state[\\/]/.test(resolved) || /[\\/]agent-log-viewer[\\/]state$/.test(path.dirname(resolved))) {
    throw new Error(`refusing ${resolved}: that is a live state directory. Copy it first: sqlite3 <live> ".backup <scratch>/state.sqlite"`);
  }
}

export function readPipelines(dbPath: string): Pipeline[] {
  assertNotLiveState(dbPath);
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query("SELECT collection, value_json FROM state_rows WHERE collection IN ('pipelines', 'pipelines_archive')").all() as Array<{ collection: string; value_json: string }>;
    const byId = new Map<string, Pipeline>();
    for (const row of rows) {
      const pipeline = JSON.parse(row.value_json) as Pipeline;
      // The live collection wins over an archived copy of the same pipeline.
      if (!byId.has(pipeline.id) || row.collection === "pipelines") byId.set(pipeline.id, pipeline);
    }
    return [...byId.values()];
  } finally {
    db.close();
  }
}

/** This repository: every project key held by a pipeline whose repoDir is
    the main checkout (or a checkout nested under it), plus sibling worktree
    paths `<main>-…`. */
export function thisProjectMatcher(pipelines: Pipeline[], mainCheckout: string, extraKeys: string[] = []): (pipeline: Pipeline) => boolean {
  const underMain = (dir: string) => dir === mainCheckout || dir.startsWith(`${mainCheckout}/`) || dir.startsWith(`${mainCheckout}-`);
  const keys = new Set(extraKeys);
  for (const pipeline of pipelines) if (underMain(pipeline.repoDir ?? "")) keys.add(pipeline.project);
  return (pipeline) => keys.has(pipeline.project) || underMain(pipeline.repoDir ?? "");
}

function mainCheckoutOf(repo: string): string {
  const common = execFileSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  return path.dirname(common);
}

// ---------------------------------------------------------------------------
// Report

function formatDelta(outcome: Outcome, band: NoiseBand): string {
  if (band.delta === null) return "unmeasured";
  return outcome === "roundsToPass" ? band.delta.toFixed(2) : band.delta.toFixed(1);
}

function formatEffect(outcome: Outcome, estimate: EffectEstimate | null): string {
  if (!estimate) return "– (no shared model stratum)";
  const digits = outcome === "roundsToPass" ? 2 : 1;
  const sign = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
  return `${sign(estimate.value)} [${sign(estimate.lo)}, ${sign(estimate.hi)}] (n ${estimate.nBefore}→${estimate.nAfter}; ${estimate.strata.length} strata)`;
}

export type LedgerReport = {
  markdown: string;
  verdict: ExperimentVerdict;
};

export function buildReport(rows: LedgerRow[], provenance: Map<string, Provenance> | null, options: { iterations: number; seed: number; minVersionN: number }): LedgerReport {
  const out: string[] = [];
  const roles = [...new Set(rows.map((row) => row.role))].sort();
  const splitCount = (split: ProjectSplit) => rows.filter((row) => row.split === split).length;
  const verdicts = (["pass", "fail", "needs_decision", "none"] as const).map((verdict) => `${verdict} ${rows.filter((row) => row.verdict === verdict).length}`).join(", ");
  out.push("## Ledger", "", `${rows.length} settled stage attempts in ${new Set(rows.map((row) => row.pipelineId)).size} pipelines (this repository ${splitCount("this")}, other repositories ${splitCount("other")}); verdicts: ${verdicts}. ${rows.filter((row) => row.tokens).length} attempts have token counts from a transcript still on disk.`, "");

  // Noise band: every attempt-level rate for every role, then the three outcomes.
  out.push("## Noise band", "");
  out.push(`Pooled week-to-week standard deviation of each rate inside cells of an unchanged harness (role, scaffold version, model, project split). Weeks with fewer than ${NOISE_MIN_WEEK_N} observations are left out; a cell counts when two or more weeks remain. Rates in percentage points.`, "");
  out.push("### Attempt verdict rates", "", "| role | pass | fail | needs_decision | no verdict | cells | weeks | attempts |", "|---|---|---|---|---|---|---|---|");
  for (const role of roles) {
    const own = rows.filter((row) => row.role === role);
    const bands = (["pass", "fail", "needs_decision", "none"] as const).map((verdict) =>
      noiseBand(own.map((row) => ({ pipelineId: row.pipelineId, version: row.scaffoldHash, model: row.model, split: row.split, week: row.week, sum: row.verdict === verdict ? 1 : 0, n: 1 })), 100));
    if (!bands[0].cells) continue;
    out.push(`| ${role} | ${bands.map((band) => (band.delta === null ? "–" : band.delta.toFixed(1))).join(" | ")} | ${bands[0].cells} | ${bands[0].weeks} | ${bands[0].units} |`);
  }
  out.push("", "### The replay's outcomes, per changed role", "", "| role | outcome | δ | cells | weeks | n |", "|---|---|---|---|---|---|");
  const changedRoles = [...new Set(PREREGISTERED_CHANGES.map((change) => change.role))];
  const observationsByRole = new Map(changedRoles.map((role) => [role, outcomeObservations(rows, role)]));
  const noiseByRole = new Map<string, Record<Outcome, NoiseBand>>();
  for (const role of changedRoles) {
    const observations = observationsByRole.get(role)!;
    const bands = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, noiseBand(observations[outcome], OUTCOME_SCALE[outcome])])) as Record<Outcome, NoiseBand>;
    noiseByRole.set(role, bands);
    for (const outcome of OUTCOMES) {
      const band = bands[outcome];
      out.push(`| ${role} | ${OUTCOME_LABEL[outcome]} | ${formatDelta(outcome, band)} | ${band.cells} | ${band.weeks} | ${band.units} |`);
    }
  }

  // The experiment.
  out.push("", "## The pre-registered replay", "");
  out.push("Effect = after − before, averaged over the model strata present in both arms, with a 95 % cluster-bootstrap interval (pipelines resampled within arm and stratum). Rates in percentage points, rounds in rounds.", "");
  out.push("| change | outcome | δ | this repository | other repositories | > δ in both, same sign |", "|---|---|---|---|---|---|");
  const results: ChangeResult[] = [];
  for (const change of PREREGISTERED_CHANGES) {
    const changeResults = runChange(change, observationsByRole.get(change.role)!, noiseByRole.get(change.role)!, options.iterations, options.seed);
    results.push(...changeResults);
    for (const result of changeResults) {
      const delta = result.delta === null ? "unmeasured" : `${formatDelta(result.outcome, { delta: result.delta, cells: 0, weeks: 0, units: 0 })}${result.usable ? "" : " (unusable)"}`;
      out.push(`| ${change.label} | ${OUTCOME_LABEL[result.outcome]} | ${delta} | ${formatEffect(result.outcome, result.bySplit.this)} | ${formatEffect(result.outcome, result.bySplit.other)} | ${result.exceedsDeltaBothSplits ? "yes" : "no"} |`);
    }
  }
  out.push("", "Arm sizes before stratification (observations; strata dropped when a model ran in one arm only):", "");
  for (const change of PREREGISTERED_CHANGES) {
    const observations = observationsByRole.get(change.role)!;
    const sizes = OUTCOMES.map((outcome) => {
      const size = (version: string, split: ProjectSplit) => observations[outcome].filter((observation) => observation.version === version && observation.split === split).reduce((sum, observation) => sum + observation.n, 0);
      return `${OUTCOME_LABEL[outcome].replace(/ \(.*\)/, "")}: this ${size(change.before, "this")}→${size(change.after, "this")}, other ${size(change.before, "other")}→${size(change.after, "other")}`;
    });
    out.push(`- ${change.label} (\`${change.before}\` → \`${change.after}\`, adds ${change.adds}): ${sizes.join("; ")}.`);
  }
  const decision = decide(results);
  out.push("", `**Verdict by the pre-registered rule: ${decision.verdict}.**`, "");
  for (const reason of decision.reasons) out.push(`- ${reason}`);

  // Version tables.
  const summaries = versionSummaries(rows);
  const shown = summaries.filter((version) => version.n >= options.minVersionN);
  out.push("", "## Harness versions", "");
  out.push(`${summaries.length} role × scaffold versions; the ${shown.length} with at least ${options.minVersionN} settled attempts have a table below, the rest are listed after them. Rates are percent of attempts with a 95 % cluster-bootstrap interval; a missing verdict counts as "no verdict", never as a pass.`, "");
  shown.forEach((version, index) => {
    const origin = provenance?.get(version.scaffoldHash);
    const originText = origin
      ? origin.commits.length
        ? `introduced by ${origin.commits.map((commit) => `${commit.sha} (${commit.date}${commit.issues.length ? `, ${commit.issues.join(" ")}` : ""})`).join(", ")}${origin.unmatched ? `; ${origin.unmatched} added sentence(s) not found in git (a rendered parameter or an operator override)` : ""}`
        : origin.added ? `${origin.added} added sentence(s), none found in git (a rendered parameter or an operator override)` : "no sentence added over the closest earlier version (parameter variant)"
      : "provenance not computed";
    out.push(`### ${version.role} \`${version.scaffoldHash}\``, "", `${version.n} attempts, ${version.first.slice(0, 10)} → ${version.last.slice(0, 10)}; ${originText}.`, "", versionTable(rows, version, options.iterations, options.seed + index * 101), "");
  });
  const rest = summaries.filter((version) => version.n < options.minVersionN);
  if (rest.length) {
    out.push(`Versions under ${options.minVersionN} attempts: ${rest.map((version) => `${version.role} \`${version.scaffoldHash}\` (${version.n})`).join(", ")}.`, "");
  }
  return { markdown: out.join("\n"), verdict: decision.verdict };
}

// ---------------------------------------------------------------------------
// CLI

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const dbPath = argValue(args, "--db");
  const outDir = argValue(args, "--out");
  if (!dbPath || !outDir) {
    console.error("usage: bun scripts/harness-ledger.ts --db <copy of state.sqlite> --out <dir> [--no-tokens] [--this-project <key>]… [--min-version-n 20] [--iterations 2000]");
    process.exit(2);
  }
  const repo = path.resolve(import.meta.dir, "..");
  const pipelines = readPipelines(dbPath);
  const extraKeys = args.flatMap((arg, index) => (arg === "--this-project" && args[index + 1] ? [args[index + 1]] : []));
  const isThis = thisProjectMatcher(pipelines, mainCheckoutOf(repo), extraKeys);
  const rows = ledgerRows(pipelines, isThis, args.includes("--no-tokens") ? null : transcriptTokens);

  const texts = new Map<string, { role: string; text: string; first: string }>();
  for (const pipeline of pipelines) for (const run of pipeline.runs ?? []) for (const attempt of run.attempts ?? []) {
    const text = attempt.effectiveRole?.promptScaffold;
    if (!text || attempt.historical) continue;
    const hash = scaffoldHash(text);
    const first = attempt.startedAt ?? pipeline.createdAt;
    const known = texts.get(hash);
    if (!known || first < known.first) texts.set(hash, { role: attempt.effectiveRole.roleId ?? "custom", text, first });
  }
  const provenance = scaffoldProvenance(repo, texts);
  const report = buildReport(rows, provenance, {
    iterations: Number(argValue(args, "--iterations") ?? BOOTSTRAP_ITERATIONS),
    seed: BOOTSTRAP_SEED,
    minVersionN: Number(argValue(args, "--min-version-n") ?? 20),
  });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "ledger.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "report.md"), report.markdown + "\n");
  console.log(`${rows.length} rows → ${path.join(outDir, "ledger.jsonl")}\nreport → ${path.join(outDir, "report.md")}\nverdict: ${report.verdict}`);
}

if (import.meta.main) main();
