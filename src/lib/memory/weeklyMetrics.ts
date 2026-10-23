import { createHash } from "node:crypto";
import { automaticMemoryExcluded, roleIsClean } from "./eligibility";
import { ROLE_MEMORY_HISTORY_LIMIT, type RuleDeparture } from "./roleTypes";
import { ROLE_DEFAULTS } from "@/lib/roles/defaults";
import { defaultRoleParameterValue } from "@/lib/roles/parameters";

/* The weekly memory report (docs/design/memory-source-switch.md §6, slice 6):
   the metrics of §6.2 and the load of §6.4 for any windows, the guards of
   §6.5 and the pre-registered decision of §6.6. Pure: the script
   scripts/memory-weekly-metrics.ts reads a VACUUM INTO copy of the state
   database and the delivery ledger and hands the rows here. The report
   carries counts, ids and project keys only; no finding, rule or note text. */

export interface MetricsWindow { from: string; to: string; label?: string }

type Verdict = { status?: string; findings?: string[]; rankedFindings?: { text: string }[] } | null | undefined;
export interface MetricsAttempt {
  n: number;
  historical?: boolean;
  state?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  sessionId?: string | null;
  conversationId?: string | null;
  effectiveRole?: { roleId?: string | null; engine?: string | null; model?: string | null; effort?: string | null; promptScaffold?: string | null } | null;
  activatedBy?: { edge?: string } | null;
  verdict?: Verdict;
  report?: { at?: string; verdict?: Verdict } | null;
  decisionRequested?: boolean;
  reviewFlowSync?: { verdict?: string | null; synchronizedAt?: string } | null;
}
export interface MetricsPipeline {
  id: string;
  project: string;
  stages: {
    id: string; kind: string; onFail?: unknown; effectiveRole?: { roleId?: string | null } | null; role?: { roleId?: string | null; params?: Record<string, unknown> | null } | null;
    /** A runtime the stage itself chose over its role's preset. */
    engine?: string | null; model?: string | null; effort?: string | null;
  }[];
  runs: { stageId: string; attempts: MetricsAttempt[] }[];
}
export interface MetricsDelivery { at: string; engineMemory?: readonly unknown[] }
export interface MetricsInput {
  pipelines: readonly MetricsPipeline[];
  /** role_memory rows: rules and lesson requests. */
  memory: readonly Record<string, unknown>[];
  /** role_memory_import rows: import records and candidates. */
  imports: readonly Record<string, unknown>[];
  /** Delivery ledger bodies (src/lib/memory/deliveryLedger.ts), or why the ledger could not be read.
      A missing ledger is no evidence that no start loaded engine memory (§6.5). */
  deliveries: readonly MetricsDelivery[] | { unavailable: "missing-file" | "missing-table" };
  /** Install deploy records (deployments.json rows). */
  deployments?: readonly { phase?: string; updatedAt?: string }[];
  /** worker-limit.json. */
  workerLimit?: { machine?: { value: number; changedAt: string } | null; history?: readonly { at: string; scope: string; from: number | null; to: number | null }[] } | null;
  /** Times at which a held-still item (§6.5) changed: lesson request text, curator brief, budgets. */
  heldChanges?: readonly string[];
}

const GRACE_MS = 24 * 60 * 60 * 1000;
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const inside = (iso: string | null | undefined, window: MetricsWindow) => { const t = ms(iso); return t >= ms(window.from) && t < ms(window.to); };

/* Finding keyword classes of §6.2. A finding may hold several; one with none
   counts in the later-round denominator only. */
export const FINDING_CLASSES: Readonly<Record<string, RegExp>> = {
  rendered: /\b(render\w*|screenshot\w*|frames?|viewport\w*|layout\w*|css|visual\w*|theme\w*|dark mode|light mode|locales?|mobile|phone|desktop|clipp\w*)\b/i,
  contract: /\b(contracts?|schemas?|shapes?|api|routes?|payloads?|validat\w*|types?|interfaces?)\b/i,
  seam: /\b(restarts?|race\w*|resum\w*|replay\w*|retr(y|ies|ied)|identit\w*|stale|concurren\w*|locks?|seams?|migrat\w*)\b/i,
  tests: /\b(tests?|tested|testing|coverage|asserts?|assertions?|fixtures?|specs?)\b/i,
  privacy: /\b(privacy|secrets?|tokens?|emails?|leak\w*|redact\w*|credentials?|absolute paths?)\b/i,
  "hot path": /\b(hot path|performance|latency|event loop|blocking|synchronous\w*|per tick|cache\w*|slow\w*)\b/i,
};
export function findingClasses(text: string): string[] {
  return Object.entries(FINDING_CLASSES).filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

/** Wilson 95 % interval for x of n; null without data. */
export function wilson(x: number, n: number, z = 1.96): [number, number] | null {
  if (!n) return null;
  const p = x / n, d = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / d;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Newcombe's hybrid score interval for p1 − p2 (trial minus baseline). */
export function proportionDifference(x1: number, n1: number, x2: number, n2: number): { difference: number; interval: [number, number] } | null {
  const a = wilson(x1, n1), b = wilson(x2, n2);
  if (!a || !b) return null;
  const p1 = x1 / n1, p2 = x2 / n2, d = p1 - p2;
  return { difference: d, interval: [d - Math.sqrt((p1 - a[0]) ** 2 + (b[1] - p2) ** 2), d + Math.sqrt((a[1] - p1) ** 2 + (p2 - b[0]) ** 2)] };
}

/** Seeded, so the same input always gives the same interval. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mean = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
const median = (values: readonly number[]) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const percentile = (sorted: readonly number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];

export function bootstrapMean(values: readonly number[], samples = 2000, seed = 6202): [number, number] | null {
  if (!values.length) return null;
  const random = mulberry32(seed), means: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) sum += values[Math.floor(random() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [percentile(means, 0.025), percentile(means, 0.975)];
}

/** Bootstrap interval of mean(a) − mean(b), each resampled over its own lanes. */
export function bootstrapDifference(a: readonly number[], b: readonly number[], samples = 2000, seed = 6202): { difference: number; interval: [number, number] } | null {
  if (!a.length || !b.length) return null;
  const random = mulberry32(seed), differences: number[] = [];
  const draw = (values: readonly number[]) => { let sum = 0; for (let j = 0; j < values.length; j += 1) sum += values[Math.floor(random() * values.length)]; return sum / values.length; };
  for (let i = 0; i < samples; i += 1) differences.push(draw(a) - draw(b));
  differences.sort((x, y) => x - y);
  return { difference: mean(a) - mean(b), interval: [percentile(differences, 0.025), percentile(differences, 0.975)] };
}

const reviewGate = (stage: MetricsPipeline["stages"][number] | undefined, attempt: MetricsAttempt) =>
  stage?.kind === "review-loop" || Boolean(stage?.onFail) || attempt.effectiveRole?.roleId === "reviewer";

/** One verdict for any writer: stage_report, the fenced JSON fallback, a review-loop outcome. */
export function reviewVerdict(attempt: MetricsAttempt): { status: "pass" | "fail" | "needs_decision"; at: string | null; findings: string[] } | null {
  const verdict = attempt.verdict ?? attempt.report?.verdict ?? null;
  const at = attempt.completedAt ?? attempt.report?.at ?? attempt.reviewFlowSync?.synchronizedAt ?? null;
  if (verdict?.status === "pass" || verdict?.status === "fail" || verdict?.status === "needs_decision") {
    // A needs_decision routed along the fail edge was a failed review (#1785).
    const status = verdict.status === "needs_decision" && attempt.decisionRequested ? "fail" : verdict.status;
    const findings = verdict.findings?.length ? verdict.findings : (verdict.rankedFindings ?? []).map(item => item.text);
    return { status, at, findings };
  }
  const outcome = attempt.reviewFlowSync?.verdict;
  if (outcome === "REQUEST_CHANGES") return { status: "fail", at, findings: [] };
  if (outcome === "APPROVE") return { status: "pass", at, findings: [] };
  return null;
}

export interface LaneMetrics {
  pipelineId: string;
  project: string;
  startedAt: string;
  reviewed: boolean;
  failedFirstReview: boolean;
  fixRounds: number;
  laterFindings: number;
  repeatedLaterFindings: number;
}

function legacyGenerations(imports: MetricsInput["imports"]): Set<string> {
  return new Set(imports.flatMap(row => row.kind === "import" && Array.isArray(row.legacyGenerations) ? row.legacyGenerations as string[] : []));
}

/** When a window's observations end: reviews and fix rounds count until 24 hours after it (§6.1). */
export const observedUntil = (window: MetricsWindow) => ms(window.to) + GRACE_MS;

/** A lane is a pipeline whose first builder attempt that no fail edge activated started in the window.
    Every observation of it (review rounds, their findings, fix rounds) ends at the grace cutoff, so a
    closed window's numbers never change with later work. */
export function laneMetrics(pipeline: MetricsPipeline, window: MetricsWindow): LaneMetrics | null {
  const stages = new Map(pipeline.stages.map(stage => [stage.id, stage]));
  const attempts = pipeline.runs.flatMap(run => run.attempts.filter(attempt => !attempt.historical).map(attempt => ({ stage: stages.get(run.stageId), attempt })));
  const start = attempts.filter(({ stage, attempt }) => attempt.effectiveRole?.roleId === "builder" && !reviewGate(stage, attempt)
    && attempt.activatedBy?.edge !== "fail" && attempt.startedAt).map(({ attempt }) => attempt.startedAt!).sort()[0];
  if (!start || !inside(start, window)) return null;
  const cutoff = observedUntil(window);
  const rounds = attempts.filter(({ stage, attempt }) => reviewGate(stage, attempt))
    .flatMap(({ attempt }) => { const verdict = reviewVerdict(attempt); return verdict?.at && ms(verdict.at) <= cutoff ? [verdict] : []; })
    .sort((a, b) => ms(a.at) - ms(b.at));
  const first = rounds[0];
  const reviewed = !!first;
  let laterFindings = 0, repeatedLaterFindings = 0;
  const seen = new Set<string>();
  rounds.forEach((round, index) => {
    const classes = round.findings.map(findingClasses);
    if (index > 0) for (const found of classes) { laterFindings += 1; if (found.some(name => seen.has(name))) repeatedLaterFindings += 1; }
    for (const found of classes) for (const name of found) seen.add(name);
  });
  return {
    pipelineId: pipeline.id, project: pipeline.project, startedAt: start, reviewed,
    failedFirstReview: reviewed && first.status === "fail",
    fixRounds: attempts.filter(({ attempt }) => attempt.activatedBy?.edge === "fail" && attempt.startedAt && ms(attempt.startedAt) <= cutoff).length,
    laterFindings, repeatedLaterFindings,
  };
}

export interface WindowReport {
  window: MetricsWindow;
  lanes: { counted: number; reviewed: number; excludedLegacy: number };
  failedReview: { failed: number; reviewed: number; share: number | null; interval: [number, number] | null };
  fixRounds: { perLane: number[]; mean: number | null; interval: [number, number] | null; median: number | null };
  repeatedClasses: { repeated: number; later: number; share: number | null; interval: [number, number] | null };
  lessons: { stage: Record<string, number>; fixRound: Record<string, number>; seatRules: number; operatorRules: number };
  evictions: { neverCurated: number; curated: number };
  imports: { adopted: number; dropped: Record<string, number>; adoptedArchived: number };
  load: {
    attemptsStarted: number; nonClean: number;
    byEngine: Record<string, number>; byModel: Record<string, number>; byProject: Record<string, number>;
    meanConcurrent: number; peakConcurrent: number; lanesWithAttempts: number;
    workerLimit: { atStart: number | null; changes: number };
    deploys: number;
    presets: Record<"builder" | "reviewer", Record<string, number>>;
  };
  /** `engineMemoryStarts` is null when the ledger cannot answer for the window. `scaffolds` and
      `presets` count launch variants (project, role and effective parameters) and the variants whose
      scaffold, or whose engine, model and effort, changed inside the window. */
  guards: {
    engineMemoryStarts: number | null; neverCuratedEvictions: number; attemptsChange: number | null; heldChanges: number;
    scaffolds: Record<"builder" | "reviewer", { variants: number; changed: number }>;
    presets: Record<"builder" | "reviewer", { variants: number; changed: number }>;
  };
  /** A window that passed every guard; false when a guard failed or could not be checked. */
  valid: boolean;
  invalidBecause: string[];
  /** Guards the evidence cannot check: the delivery ledger is missing or does not reach back over the window. */
  unverified: string[];
  /** Reviews and fix rounds of the window's lanes count until this time. */
  observedUntil: string;
  byProject: Record<string, { reviewed: number; failed: number }>;
}

const count = (target: Record<string, number>, key: string) => { target[key] = (target[key] ?? 0) + 1; };

/** The parameter values a launch renders its scaffold with, as pipelineRoleLookup resolves them: an
    omitted or blank value takes the role's shipped default, and a key the role does not declare
    renders nothing. So `{}` and `{ domain: "general" }` are one builder variant. */
export function effectiveRoleParams(roleId: string, params: Record<string, unknown> | null | undefined): [string, string][] {
  const given = params ?? {};
  const definition = ROLE_DEFAULTS.find(role => role.id === roleId);
  if (!definition) return Object.keys(given).sort().map(key => [key, String(given[key])]);
  return definition.parameters.map(parameter => {
    const chosen = given[parameter.key];
    const value = chosen !== undefined && chosen !== null && chosen !== "" ? chosen : defaultRoleParameterValue(parameter);
    return [parameter.key, String(value)] as [string, string];
  }).sort(([a], [b]) => a.localeCompare(b));
}

function lessonKind(row: Record<string, unknown>): string {
  if (typeof row.rewrote === "string") return "rewrite";
  if (Array.isArray(row.ruleIds) && row.ruleIds.length) return "lesson";
  if (row.problem) return "problem";
  if (typeof row.none === "string") return "none";
  return "open";
}

function workerLimitAt(input: MetricsInput["workerLimit"], at: string): number | null {
  const history = (input?.history ?? []).filter(row => row.scope === "machine").sort((a, b) => ms(a.at) - ms(b.at));
  const before = history.filter(row => ms(row.at) <= ms(at)).at(-1);
  if (before) return before.to;
  const after = history.find(row => ms(row.at) > ms(at));
  if (after) return after.from;
  return input?.machine && ms(input.machine.changedAt) <= ms(at) ? input.machine.value : null;
}

function concurrency(intervals: readonly [number, number][], window: MetricsWindow): { mean: number; peak: number } {
  const from = ms(window.from), to = ms(window.to);
  const events: [number, number][] = [];
  let covered = 0;
  for (const [start, end] of intervals) {
    const a = Math.max(start, from), b = Math.min(end, to);
    if (b <= a) continue;
    covered += b - a;
    events.push([a, 1], [b, -1]);
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let live = 0, peak = 0;
  for (const [, delta] of events) { live += delta; peak = Math.max(peak, live); }
  return { mean: to > from ? covered / (to - from) : 0, peak };
}

/** Rules that left the injected text in the window, from each rule's append-only departure log
    (roleTypes.ts RuleDeparture): what it was when it left, so a later restore, curation or re-archive
    changes nothing here. `complete` is false when an archive in the window has no logged departure
    (written before the log existed) or a scope's history no longer reaches back over the window:
    the evictions then cannot be counted, which is no evidence that there were none (§6.5). */
export function windowDepartures(memory: MetricsInput["memory"], window: MetricsWindow): { evictions: { neverCurated: number; curated: number }; adoptedArchived: number; complete: boolean } {
  const evictions = { neverCurated: 0, curated: 0 };
  let adoptedArchived = 0, complete = true;
  const logged = new Map<string, readonly RuleDeparture[]>();
  for (const row of memory) {
    if (row.kind !== "rule" || row.versionOf || typeof row.id !== "string") continue;
    const log = Array.isArray(row.departures) ? row.departures as RuleDeparture[] : [];
    logged.set(row.id, log);
    const left = log.filter(departure => inside(departure.at, window));
    for (const departure of left) if (departure.reason === "budget") { if (departure.curated) evictions.curated += 1; else evictions.neverCurated += 1; }
    if (left.length && (row.source as { origin?: string } | undefined)?.origin === "import") adoptedArchived += 1;
    if (row.state === "archived" && inside(row.changedAt as string, window) && !log.some(departure => departure.at === row.changedAt)) complete = false;
  }
  for (const row of memory) {
    if (row.kind !== "scope" || !Array.isArray(row.history)) continue;
    const history = row.history as { at: string; pass?: string; archived?: string[] }[];
    const ordinary = history.filter(entry => !entry.pass);
    if (ordinary.length >= ROLE_MEMORY_HISTORY_LIMIT && !(Math.min(...ordinary.map(entry => ms(entry.at))) <= ms(window.from))) complete = false;
    for (const entry of history) {
      if (!inside(entry.at, window)) continue;
      for (const id of entry.archived ?? []) if (!(logged.get(id) ?? []).some(departure => departure.at === entry.at)) complete = false;
    }
  }
  return { evictions, adoptedArchived, complete };
}

/** Metrics, load and guards for one window. `baselineAttempts` drives the load guard. */
export function windowReport(input: MetricsInput, window: MetricsWindow, baselineAttempts?: number): WindowReport {
  const legacy = legacyGenerations(input.imports);
  const lanes: LaneMetrics[] = [];
  let excludedLegacy = 0;
  for (const pipeline of input.pipelines) {
    const lane = laneMetrics(pipeline, window);
    if (!lane) continue;
    if (pipeline.runs.some(run => run.attempts.some(attempt => attempt.sessionId && legacy.has(attempt.sessionId)))) { excludedLegacy += 1; continue; }
    lanes.push(lane);
  }
  const reviewed = lanes.filter(lane => lane.reviewed);
  const failed = reviewed.filter(lane => lane.failedFirstReview).length;
  const perLane = reviewed.map(lane => lane.fixRounds);
  const later = reviewed.reduce((sum, lane) => sum + lane.laterFindings, 0);
  const repeated = reviewed.reduce((sum, lane) => sum + lane.repeatedLaterFindings, 0);
  const byProject: WindowReport["byProject"] = {};
  for (const lane of reviewed) {
    const row = byProject[lane.project] ??= { reviewed: 0, failed: 0 };
    row.reviewed += 1; if (lane.failedFirstReview) row.failed += 1;
  }

  const fixRoundAttempts = new Set<string>();
  for (const pipeline of input.pipelines) for (const run of pipeline.runs) for (const attempt of run.attempts) {
    if (attempt.activatedBy?.edge === "fail") fixRoundAttempts.add(`${pipeline.id}\u0000${run.stageId}\u0000${attempt.n}`);
  }
  const lessons: WindowReport["lessons"] = { stage: {}, fixRound: {}, seatRules: 0, operatorRules: 0 };
  const departures = windowDepartures(input.memory, window);
  const { evictions, adoptedArchived } = departures;
  for (const row of input.memory) {
    if (row.kind === "request" && inside(row.at as string, window)) {
      count(fixRoundAttempts.has(`${row.pipelineId}\u0000${row.stageId}\u0000${row.attempt}`) ? lessons.fixRound : lessons.stage, lessonKind(row));
    }
    if (row.kind !== "rule" || row.versionOf) continue;
    const source = row.source as { origin?: string } | undefined;
    if (inside(row.createdAt as string, window)) {
      if (source?.origin === "seat") lessons.seatRules += 1;
      if (source?.origin === "operator") lessons.operatorRules += 1;
    }
  }
  const imports: WindowReport["imports"] = { adopted: 0, dropped: {}, adoptedArchived };
  for (const row of input.imports) {
    if (row.kind !== "candidate" || !Array.isArray(row.dispositions)) continue;
    for (const disposition of row.dispositions as { at: string; kind: string; reason?: string }[]) {
      if (!inside(disposition.at, window)) continue;
      if (disposition.kind === "adopt") imports.adopted += 1;
      else count(imports.dropped, disposition.reason ?? "unstated");
    }
  }

  const started: { pipeline: MetricsPipeline; stage: MetricsPipeline["stages"][number] | undefined; attempt: MetricsAttempt }[] = [];
  for (const pipeline of input.pipelines) {
    const stages = new Map(pipeline.stages.map(stage => [stage.id, stage]));
    for (const run of pipeline.runs) for (const attempt of run.attempts) {
      if (!attempt.historical && inside(attempt.startedAt, window)) started.push({ pipeline, stage: stages.get(run.stageId), attempt });
    }
  }
  const flow = concurrency(started.flatMap(({ attempt }) => attempt.startedAt && attempt.completedAt ? [[ms(attempt.startedAt), ms(attempt.completedAt)] as [number, number]] : []), window);
  const load: WindowReport["load"] = {
    attemptsStarted: started.length, nonClean: 0, byEngine: {}, byModel: {}, byProject: {},
    meanConcurrent: Math.round(flow.mean * 100) / 100, peakConcurrent: flow.peak,
    lanesWithAttempts: new Set(started.map(({ pipeline }) => pipeline.id)).size,
    workerLimit: {
      atStart: workerLimitAt(input.workerLimit, window.from),
      changes: (input.workerLimit?.history ?? []).filter(row => row.scope === "machine" && inside(row.at, window)).length,
    },
    deploys: (input.deployments ?? []).filter(row => row.phase === "succeeded" && inside(row.updatedAt, window)).length,
    presets: { builder: {}, reviewer: {} },
  };
  // A role renders a different scaffold and runtime per parameter (a builder's domain, a fix round's
  // mode), so a scaffold or preset is compared only with launches of the same project, role and
  // effective parameters (§6.5); a runtime the stage itself chose is a variant of its own.
  const scaffolds = { builder: new Map<string, Set<string>>(), reviewer: new Map<string, Set<string>>() };
  const presets = { builder: new Map<string, Set<string>>(), reviewer: new Map<string, Set<string>>() };
  for (const { pipeline, stage, attempt } of started) {
    const role = attempt.effectiveRole;
    if (!automaticMemoryExcluded({ roleId: role?.roleId ?? stage?.effectiveRole?.roleId ?? null, stage: stage ?? null }) && !roleIsClean(role?.roleId)) load.nonClean += 1;
    count(load.byEngine, role?.engine ?? "unknown");
    count(load.byModel, role?.model ?? "unknown");
    count(load.byProject, pipeline.project);
    if (role?.roleId === "builder" || role?.roleId === "reviewer") {
      count(load.presets[role.roleId], `${role.engine ?? "unknown"}/${role.model ?? "unknown"}`);
      const variant = JSON.stringify([pipeline.project, effectiveRoleParams(role.roleId, stage?.role?.params), [stage?.engine ?? null, stage?.model ?? null, stage?.effort ?? null]]);
      const hashes = scaffolds[role.roleId].get(variant) ?? new Set<string>();
      hashes.add(createHash("sha256").update(role.promptScaffold ?? "").digest("hex"));
      scaffolds[role.roleId].set(variant, hashes);
      const runtimes = presets[role.roleId].get(variant) ?? new Set<string>();
      runtimes.add(JSON.stringify([role.engine ?? null, role.model ?? null, role.effort ?? null]));
      presets[role.roleId].set(variant, runtimes);
    }
  }

  const ledger = Array.isArray(input.deliveries) ? input.deliveries as readonly MetricsDelivery[] : null;
  const unverified: string[] = departures.complete ? [] : ["departure-log-incomplete"];
  if (!ledger) unverified.push(`delivery-ledger-${(input.deliveries as { unavailable: string }).unavailable}`);
  else {
    // The ledger keeps its newest starts only. A start before its oldest row may have loaded engine memory unseen.
    const firstStart = Math.min(...started.flatMap(({ attempt }) => attempt.startedAt ? [ms(attempt.startedAt)] : []));
    const ledgerFrom = Math.min(...ledger.map(row => ms(row.at)).filter(Number.isFinite));
    if (Number.isFinite(firstStart) && !(ledgerFrom <= firstStart)) unverified.push("delivery-ledger-incomplete");
  }
  const engineMemoryStarts = ledger ? ledger.filter(row => inside(row.at, window) && (row.engineMemory?.length ?? 0) > 0).length : null;
  const attemptsChange = baselineAttempts ? (started.length - baselineAttempts) / baselineAttempts : null;
  const heldChanges = (input.heldChanges ?? []).filter(at => inside(at, window)).length;
  const changed = (variants: Map<string, Set<string>>) => [...variants.values()].filter(hashes => hashes.size > 1).length;
  const scaffoldGuard = { builder: { variants: scaffolds.builder.size, changed: changed(scaffolds.builder) }, reviewer: { variants: scaffolds.reviewer.size, changed: changed(scaffolds.reviewer) } };
  const presetGuard = { builder: { variants: presets.builder.size, changed: changed(presets.builder) }, reviewer: { variants: presets.reviewer.size, changed: changed(presets.reviewer) } };
  const invalidBecause = [
    ...(engineMemoryStarts ? ["engine-memory-loaded"] : []),
    ...(evictions.neverCurated ? ["never-curated-eviction"] : []),
    ...(attemptsChange !== null && Math.abs(attemptsChange) > 0.5 ? ["load-changed"] : []),
    ...(heldChanges || scaffoldGuard.builder.changed || scaffoldGuard.reviewer.changed ? ["held-still-changed"] : []),
    ...(presetGuard.builder.changed || presetGuard.reviewer.changed ? ["preset-changed"] : []),
  ];
  return {
    window,
    lanes: { counted: lanes.length, reviewed: reviewed.length, excludedLegacy },
    failedReview: { failed, reviewed: reviewed.length, share: reviewed.length ? failed / reviewed.length : null, interval: wilson(failed, reviewed.length) },
    fixRounds: { perLane, mean: perLane.length ? mean(perLane) : null, interval: bootstrapMean(perLane), median: perLane.length ? median(perLane) : null },
    repeatedClasses: { repeated, later, share: later ? repeated / later : null, interval: wilson(repeated, later) },
    lessons, evictions, imports, load,
    guards: { engineMemoryStarts, neverCuratedEvictions: evictions.neverCurated, attemptsChange, heldChanges, scaffolds: scaffoldGuard, presets: presetGuard },
    valid: invalidBecause.length === 0 && unverified.length === 0,
    invalidBecause,
    unverified,
    observedUntil: new Date(observedUntil(window)).toISOString(),
    byProject,
  };
}

/** What §6.6 needs from a window; pooling sums two of them. */
export interface DecisionSample { reviewed: number; failed: number; fixRounds: number[]; later: number; repeated: number }
export const decisionSample = (report: WindowReport): DecisionSample => ({
  reviewed: report.failedReview.reviewed, failed: report.failedReview.failed, fixRounds: report.fixRounds.perLane,
  later: report.repeatedClasses.later, repeated: report.repeatedClasses.repeated,
});

export type DecisionOutcome = "delegatus" | "engines" | "extend" | "stop-and-ask" | "pending";
export interface Decision {
  outcome: DecisionOutcome;
  /** Indexes of the windows the outcome rests on; invalid windows never appear here. */
  usedWindows: number[];
  primary: { difference: number; interval: [number, number] } | null;
  corroborating: { fixRounds: { difference: number; interval: [number, number] } | null; repeatedClasses: { difference: number; interval: [number, number] } | null } | null;
  invalidWindows: { index: number; because: string[] }[];
  reason: string;
}

const above = (value: { interval: [number, number] } | null) => !!value && value.interval[0] > 0;
const primaryOf = (trial: DecisionSample, base: DecisionSample) => proportionDifference(trial.failed, trial.reviewed, base.failed, base.reviewed);

/** §6.6, applied to the windows in order; an invalid window contributes nothing. */
export function decide(baseline: DecisionSample, windows: readonly { sample: DecisionSample; valid: boolean; invalidBecause?: string[] }[]): Decision {
  const invalidWindows: Decision["invalidWindows"] = [];
  let consecutiveInvalid = 0;
  let pending: { index: number; sample: DecisionSample } | null = null;
  for (const [index, window] of windows.entries()) {
    if (!window.valid) {
      invalidWindows.push({ index, because: window.invalidBecause ?? [] });
      consecutiveInvalid += 1;
      if (consecutiveInvalid >= 2) return { outcome: "stop-and-ask", usedWindows: [], primary: null, corroborating: null, invalidWindows, reason: "two windows in a row are invalid: the seat stops and asks the operator" };
      continue;
    }
    consecutiveInvalid = 0;
    if (!window.sample.reviewed || !baseline.reviewed) return { outcome: "pending", usedWindows: [], primary: null, corroborating: null, invalidWindows, reason: "a valid window or the baseline has no reviewed lanes" };
    if (pending) {
      const pooled: DecisionSample = {
        reviewed: pending.sample.reviewed + window.sample.reviewed, failed: pending.sample.failed + window.sample.failed,
        fixRounds: [...pending.sample.fixRounds, ...window.sample.fixRounds], later: pending.sample.later + window.sample.later, repeated: pending.sample.repeated + window.sample.repeated,
      };
      const primary = primaryOf(pooled, baseline);
      return { outcome: above(primary) ? "engines" : "delegatus", usedWindows: [pending.index, index], primary, corroborating: null, invalidWindows,
        reason: "two valid weeks pooled against the baseline; the primary metric alone decides" };
    }
    const primary = primaryOf(window.sample, baseline);
    if (!above(primary)) return { outcome: "delegatus", usedWindows: [index], primary, corroborating: null, invalidWindows, reason: "the failed-review difference has no 95 % interval entirely above zero" };
    const corroborating = {
      fixRounds: bootstrapDifference(window.sample.fixRounds, baseline.fixRounds),
      repeatedClasses: proportionDifference(window.sample.repeated, window.sample.later, baseline.repeated, baseline.later),
    };
    if (above(corroborating.fixRounds) || above(corroborating.repeatedClasses)) {
      return { outcome: "engines", usedWindows: [index], primary, corroborating, invalidWindows, reason: "the failed-review share rose and a corroborating metric rose with it" };
    }
    pending = { index, sample: window.sample };
  }
  if (pending) return { outcome: "extend", usedWindows: [pending.index], primary: primaryOf(pending.sample, baseline), corroborating: null, invalidWindows, reason: "inconclusive valid week: one more valid week is pooled with it" };
  return { outcome: "pending", usedWindows: [], primary: null, corroborating: null, invalidWindows, reason: "no valid window yet" };
}

export interface WeeklyReport {
  baseline: WindowReport;
  /** `provisional`: the window's reviews may still complete, so its numbers can change and decide nothing yet. */
  windows: (WindowReport & { provisional: boolean })[];
  decision: Decision & { heldWindows: { index: number; because: string[] }[] };
}

/** The baseline is reported with its guards but never invalidates a trial window. §6.6 runs over the
    windows in order and stops before the first one that cannot decide yet: a window still inside its
    24-hour review grace at `now` (§6.1), or one whose delivery ledger cannot check the §6.5 guard. */
export function weeklyReport(input: MetricsInput, baseline: MetricsWindow, windows: readonly MetricsWindow[], now: string): WeeklyReport {
  const at = ms(now);
  if (!Number.isFinite(at)) throw Error("the report needs the time it is read at");
  const base = windowReport(input, baseline);
  const reports = windows.map(window => windowReport(input, window, base.load.attemptsStarted)).map(report => ({ ...report, provisional: observedUntil(report.window) > at }));
  const heldWindows = reports.flatMap((report, index) => report.provisional || report.unverified.length
    ? [{ index, because: [...report.provisional ? [`reviews-until-${report.observedUntil}`] : [], ...report.unverified] }] : []);
  const held = (reason: string): WeeklyReport["decision"] => ({ outcome: "pending", usedWindows: [], primary: null, corroborating: null, invalidWindows: [], reason, heldWindows });
  if (observedUntil(baseline) > at) return { baseline: base, windows: reports, decision: held(`the baseline's reviews may still complete until ${base.observedUntil}`) };
  const decidable = reports.slice(0, heldWindows[0]?.index ?? reports.length);
  const decision = decide(decisionSample(base), decidable.map(report => ({ sample: decisionSample(report), valid: report.valid, invalidBecause: report.invalidBecause })));
  const next = heldWindows[0];
  if (next && (decision.outcome === "pending" || decision.outcome === "extend")) {
    const why = reports[next.index].provisional ? `its reviews may still complete until ${reports[next.index].observedUntil}` : `the delivery ledger cannot check it (${reports[next.index].unverified.join(", ")})`;
    return { baseline: base, windows: reports, decision: { ...decision, reason: `${decision.reason}; window ${next.index} decides nothing yet: ${why}`, heldWindows } };
  }
  return { baseline: base, windows: reports, decision: { ...decision, heldWindows } };
}
