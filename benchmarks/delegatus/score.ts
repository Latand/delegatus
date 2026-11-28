import { createHash } from 'node:crypto';
import design from './pilot-manifest.json';

const groups = design.scoring.behaviorGroupWeights;
type Group = keyof typeof groups;
export type Requirement = { id: string; group: Group; critical: boolean };
export type Checks = Record<string, 'pass' | 'fail' | 'missing' | 'waived'>;
type Rating = [number, number, number];
export type Judgment = { session: string; artifactDigest: string; terminalReceipt: string; cleanupReceipt: string; rating: Rating; coverage: string[]; truncated?: boolean };
type Resources = { units: number; activeSeconds: number; queueSeconds: number; sessions: number };
type HumanEvent = {
  id: string;
  at: number;
  actor: string;
  category: string;
  necessity: string;
  fact: string;
  script: string | null;
  reason: string;
  minutes: number;
  artifact: string;
};
type Outcome = 'compliant' | 'violating' | 'unknown';
export type Opportunity = { id: string; task: string; principle: string; applicability: 'applicable' | 'unknown'; proof: string; version: string };
type Action = { outcome: Outcome; evidence: string; at: number; priorCorrection?: string };

export type Observation = {
  status: 'delivered' | 'timeout' | 'infrastructure_failure' | 'blocked' | 'not_run_after_stop' | 'undelivered';
  reason?: string;
  first?: { timely: boolean; tree: string; captureReceipt: string; valid: boolean; checks: Checks };
  final?: { timely: boolean; tree: string; commit?: string; captureReceipt: string; valid: boolean; checks: Checks };
  predecessorOracles?: Record<string, { treeDigest: string; evidenceDigest: string; checks: Checks }>;
  terminalReceipt?: string;
  cleanupReceipt?: string;
  usage?: Resources;
  curatorUsage?: Resources;
  invalid?: boolean;
  judgments?: (Judgment | null)[];
  human?: HumanEvent[];
  findings?: { defect: string; verdict: 'true' | 'false' | 'unknown'; checkpoint: string; evidence: string; severity: 'critical' | 'high' | 'medium' | 'low'; disposition: 'accepted' | 'rejected' | 'unknown' }[];
  census?: { defects: string[]; complete: boolean };
  escapes?: { critical: number; other: number };
  regressions?: number;
  fixRounds?: number;
  workflow?: { reviewers: { checkpoint: string; evidenceDigest: string; completedAt: number }[]; fixes: { checkpoint: string; evidenceDigest: string; completedAt: number }[]; reReviews: { checkpoint: string; evidenceDigest: string; completedAt: number }[] };
  correctiveMinutes?: number;
  actions?: Record<string, Action>;
};

export function assert(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}

const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const artifactDigest = (value: string) => createHash('sha256').update(value).digest('hex');
const rating = (value: unknown): value is Rating =>
  Array.isArray(value) && value.length === 3 && value.every(n => count(n) && n <= 3);

function disputed(a: Rating, b: Rating) {
  return (a[0] === 3) !== (b[0] === 3) || a.some((v, i) => Math.abs(v - b[i]) >= 2);
}

export function fullyAccepted(flags: Record<string, boolean>, judgments: readonly unknown[]) {
  return design.scoring.fullyAccepted.requiredTrue.every(flag => flags[flag] === true)
    && judgments.length === 2 && judgments.every(j => rating(j) && j[0] === 3 && j[1] === 3 && j[2] >= 2);
}

function behavior(requirements: Requirement[], checks: Checks = {}) {
  assert(new Set(requirements.map(r => r.id)).size === requirements.length, 'Duplicate requirement');
  assert(Object.keys(checks).every(id => requirements.some(r => r.id === id)), 'Unsealed requirement');
  assert(Object.values(checks).every(v => ['pass', 'fail', 'missing', 'waived'].includes(v)), 'Invalid check verdict');
  assert(requirements.every(r => Object.hasOwn(groups, r.group) && typeof r.critical === 'boolean'), 'Invalid requirement');
  const groupScores = Object.entries(groups).map(([group, weight]) => {
    const members = requirements.filter(r => r.group === group);
    assert(members.length, 'Empty behavioral group');
    const passed = members.filter(r => checks[r.id] === 'pass').length;
    return [group, { weight, expected: members.length, passed, rate: passed / members.length }] as const;
  });
  return {
    groups: Object.fromEntries(groupScores),
    B: groupScores.reduce((sum, [, g]) => sum + g.weight * g.rate, 0),
    allPassed: requirements.every(r => checks[r.id] === 'pass'),
    critical: requirements.filter(r => r.critical && checks[r.id] === 'fail').map(r => r.id),
  };
}

export type Calibration = {
  judge: 'J1' | 'J2';
  gold: string;
  artifactDigest: string;
  session: string;
  rating: Rating;
  detected: string[];
  usage: Resources;
  terminalReceipt: string;
  cleanupReceipt: string;
};

export function calibrationPassed(golds: Record<string, string[]>, rows: Calibration[]) {
  const expected = design.judgingCells.flatMap(j => 'gold' in j && j.gold ? [j.gold] : []);
  if (rows.length !== expected.length || new Set(rows.map(x => x.session)).size !== rows.length) return false;
  return (['J1', 'J2'] as const).every(judge => {
    const own = rows.filter(x => x.judge === judge);
    const complete = own.find(x => x.gold === 'complete');
    if (!complete || !rating(complete.rating) || complete.rating[0] !== 3 || complete.rating[1] !== 3
      || !sha256(complete.artifactDigest) || !complete.session || !sha256(complete.terminalReceipt)
      || !sha256(complete.cleanupReceipt) || !judgeUsageCovered(complete.usage)) return false;
    return [...new Set(expected)].every(gold => {
      const matches = own.filter(x => x.gold === gold);
      if (matches.length !== 1) return false;
      const row = matches[0];
      if (!rating(row.rating) || !row.session || !sha256(row.artifactDigest) || !sha256(row.terminalReceipt)
        || !sha256(row.cleanupReceipt) || !judgeUsageCovered(row.usage)) return false;
      if (gold === 'complete') return true;
      const defects = golds[gold];
      return !!defects && defects.every(id => row.detected.includes(id))
        && contribution(complete.rating) > contribution(row.rating)
        && row.rating[0] < 3 && row.rating[1] < 3;
    });
  });
}

export function oracleControls(requirements: Requirement[], references: Record<string, Checks>, intended: Record<string, string[]>) {
  return ['correct', 'unchanged', 'partial', 'unsafe'].every(name => {
    const checks = references[name];
    if (!checks) return false;
    const result = behavior(requirements, checks);
    if (name === 'correct') return result.allPassed;
    const expected = intended[name];
    return !!expected?.length && expected.every(id => requirements.some(r => r.id === id) && checks[id] === 'fail');
  });
}

const contribution = ([c, e, m]: Rating) => (
  c * design.scoring.residualJudgeWeights.completeness
  + e * design.scoring.residualJudgeWeights.evidenceAccuracy
  + m * design.scoring.residualJudgeWeights.justifiedMaintainability
) / 3;

function validUsage(usage: Resources | undefined): usage is Resources {
  return !!usage && [usage.units, usage.activeSeconds, usage.queueSeconds, usage.sessions].every(count);
}

export function judgeUsageCovered(usage?: Resources) {
  const cap = design.budgets.judge;
  return validUsage(usage) && usage.sessions === 1 && usage.units <= cap.maxChargedUnits
    && usage.activeSeconds <= cap.maxActiveSeconds && usage.queueSeconds <= cap.maxQueueSeconds;
}

export function score(row: Observation, requirements: Requirement[], residuals: string[], maxSessions: number, learn: boolean, calibrated: boolean) {
  const first = behavior(requirements, row.first?.checks);
  const final = behavior(requirements, row.final?.checks);
  const firstValid = row.first?.valid === true && Boolean(sha256(row.first.captureReceipt) && sha256(row.first.tree) && row.first.timely);
  const finalValid = row.final?.valid === true && Boolean(sha256(row.final.captureReceipt) && sha256(row.final.tree) && row.final.timely);
  const delivered = row.status === 'delivered' && finalValid && row.invalid === false;
  const usage = row.usage;
  const curator = row.curatorUsage;
  const knownUsage = validUsage(usage) && usage.sessions >= 1 && (!learn || validUsage(curator));
  const cap = design.budgets.B;
  const reserve = design.budgets['B-learn'];
  const withinBudget = knownUsage && usage.units <= cap.maxChargedUnits && usage.activeSeconds <= cap.maxAggregateActiveSeconds
    && usage.queueSeconds <= cap.maxQueueSeconds && usage.sessions <= maxSessions + Number(learn)
    && (!learn || (!!curator && curator.sessions === 1 && usage.sessions >= 2 && curator.units <= reserve.curatorUnits
      && curator.activeSeconds <= reserve.curatorActiveSeconds
      && curator.queueSeconds <= cap.maxQueueSeconds
      && usage.units >= curator.units && usage.units - curator.units <= reserve.solverUnits
      && usage.activeSeconds >= curator.activeSeconds && usage.activeSeconds - curator.activeSeconds <= reserve.solverActiveSeconds));
  const judges = (row.judgments ?? []).slice(0, 2);
  const ratings = [0, 1].map(i => {
    const j = judges[i];
    return j?.session && j.session !== judges[1 - i]?.session && sha256(j.artifactDigest)
      && row.final?.tree && j.artifactDigest === artifactDigest(row.final.tree)
      && sha256(j.terminalReceipt) && sha256(j.cleanupReceipt)
      && !j.truncated && rating(j.rating) && Array.isArray(j.coverage)
      && residuals.every(id => j.coverage.includes(id)) ? j.rating : null;
  });
  const [a, b] = ratings;
  const dispute = !!a && !!b && disputed(a, b);
  const independent = row.judgments?.length === 2 && !!a && !!b && judges[0]?.session !== judges[1]?.session;
  const jBounds = ratings.map(j => j ? [contribution(j), contribution(j)] : [0, 1]);
  const jLower = dispute ? Math.min(jBounds[0][0], jBounds[1][0]) : (jBounds[0][0] + jBounds[1][0]) / 2;
  const jUpper = dispute ? Math.max(jBounds[0][1], jBounds[1][1]) : (jBounds[0][1] + jBounds[1][1]) / 2;
  const quality = (j: number) => delivered && withinBudget && !final.critical.length ? 100 * (0.8 * final.B + 0.2 * j) : 0;
  const accepted = firstValid && fullyAccepted({
    allBehavioralRequirementsExecutedAndPassed: final.allPassed,
    artifactDelivered: delivered,
    terminalAndCleanupReceiptsComplete: Boolean(row.terminalReceipt && row.cleanupReceipt),
    usageKnown: knownUsage,
    allResourceDeadlineSessionLimitsMet: withinBudget && (row.fixRounds ?? 0) <= 1,
    noCriticalFailure: final.critical.length === 0,
    noContaminationOrProtocolInvalidity: row.invalid === false,
    calibrationPassed: calibrated,
    bothJudgmentsIndependentParseableAndCompleteCoverage: independent,
    observedReviewFixFloor: !!row.workflow && row.workflow.reviewers.length >= 1
      && row.workflow.fixes.length >= (row.fixRounds ?? 0)
      && row.workflow.reReviews.length >= (row.fixRounds ?? 0)
      && [...row.workflow.reviewers, ...row.workflow.fixes, ...row.workflow.reReviews]
        .every(event => !!event.checkpoint && sha256(event.evidenceDigest) && count(event.completedAt)),
    noUnresolvedDispute: !dispute && !!a && !!b,
  }, ratings);

  const human = row.human ?? [];
  assert(new Set(human.map(e => e.id)).size === human.length, 'Duplicate human event');
  for (const e of human) {
    assert(design.humanAssistance.categories.includes(e.category) && design.humanAssistance.necessity.includes(e.necessity)
      && e.id && e.actor && e.fact && e.reason && e.artifact && count(e.at)
      && Number.isFinite(e.minutes) && e.minutes >= 0, 'Invalid human event');
    assert(e.necessity !== 'necessary-business-fact' || e.category !== 'business-clarification' || e.script, 'Unbound clarification');
  }
  const autonomous = accepted && row.human !== undefined && human.every(e =>
    !['unknown', 'avoidable-corrective-help'].includes(e.necessity)
      && !['technical-prescription', 'manual-repair'].includes(e.category));
  return {
    fullyAccepted: accepted,
    firstFunctionalAccepted: row.invalid === false && firstValid && first.allPassed,
    finalFunctionalAccepted: delivered && final.allPassed,
    autonomousAccepted: autonomous,
    strictGoalOnlyAccepted: autonomous && human.every(e => e.category === 'goal-only'),
    first, final, judgments: judges, dispute, ratings, Q: quality(jLower), QBounds: [quality(jLower), quality(jUpper)],
    resources: validUsage(usage) ? usage : null,
    curatorResources: curator ?? null,
    human: row.human ?? null, reviewer: reviewerMeasures(row), escapes: row.escapes ?? null,
    fixRounds: row.fixRounds ?? null, regressions: row.regressions ?? null, correctiveMinutes: row.correctiveMinutes ?? null,
  };
}

function reviewerMeasures(row: Observation) {
  const verdicts = new Map<string, string>();
  for (const finding of row.findings ?? []) {
    assert(finding.checkpoint && sha256(finding.evidence) && finding.severity && finding.disposition, 'Reviewer finding lacks checkpoint, evidence, severity or disposition');
    const previous = verdicts.get(finding.defect);
    verdicts.set(finding.defect, previous && previous !== finding.verdict ? 'unknown' : finding.verdict);
  }
  const confirmed = [...verdicts.values()].filter(v => v === 'true').length;
  const falseFindings = [...verdicts.values()].filter(v => v === 'false').length;
  const unknown = verdicts.size - confirmed - falseFindings;
  const census = new Set(row.census?.defects);
  const detected = [...census].filter(id => verdicts.get(id) === 'true').length;
  const uncertain = [...census].filter(id => verdicts.get(id) === 'unknown').length;
  return {
    coverage: row.findings ? 'observed' : 'unknown',
    confirmed, falseFindings, unknown,
    precision: confirmed + falseFindings ? confirmed / (confirmed + falseFindings) : null,
    precisionBounds: verdicts.size ? [confirmed / verdicts.size, (confirmed + unknown) / verdicts.size] : null,
    detected, census: census.size, censusComplete: row.census?.complete === true,
    recallBounds: census.size ? [detected / census.size, (detected + uncertain) / census.size] : null,
    recallCoverage: census.size ? (row.census?.complete ? 'complete-census' : 'coverage-limited-census') : 'unknown',
  };
}

export function violationRates(registry: Opportunity[], actions: Record<string, Action> = {}) {
  assert(new Set(registry.map(o => o.id)).size === registry.length, 'Duplicate opportunity ID');
  assert(new Set(registry.map(o => JSON.stringify([o.task, o.principle]))).size === registry.length, 'Duplicate task principle');
  assert(registry.every(o => o.id && o.task && o.principle && o.proof && o.version
    && ['applicable', 'unknown'].includes(o.applicability)), 'Unsealed opportunity');
  assert(Object.entries(actions).every(([id, a]) => registry.some(o => o.id === id)
    && ['compliant', 'violating', 'unknown'].includes(a.outcome) && a.evidence && count(a.at)), 'Unproven opportunity outcome');
  const applicable = registry.filter(o => o.applicability === 'applicable');
  const sensitivity = registry.filter(o => o.applicability === 'unknown');
  const rate = (rows: Opportunity[]) => {
    const n = rows.length;
    const violations = rows.filter(o => actions[o.id]?.outcome === 'violating').length;
    const unknown = rows.filter(o => !actions[o.id] || actions[o.id].outcome === 'unknown').length;
    return { numerator: violations, denominator: n, unknown, bounds: n ? [violations / n, (violations + unknown) / n] : null };
  };
  return {
    primary: rate(applicable), unknownApplicability: rate(sensitivity),
    conditionalRecurrence: rate(applicable.filter(o => actions[o.id]?.priorCorrection)),
  };
}
