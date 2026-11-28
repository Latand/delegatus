import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import design from './pilot-manifest.json';
import { assert, calibrationPassed, fullyAccepted, judgeUsageCovered, score, violationRates, type Calibration, type Judgment, type Observation, type Opportunity, type Requirement } from './score';

type Cell = typeof design.cells[number];
type Arm = keyof typeof design.arms;
type Runtime = { engine: 'codex' | 'claude'; model: string; effort: 'high' };
const arm = (cell: Cell) => design.arms[cell.arm as Arm];
const source = (file: string) => readFileSync(new URL(file, import.meta.url));
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const expected = (actual: unknown, wanted: unknown, label: string) =>
  assert(isDeepStrictEqual(actual, wanted), `Invalid manifest ${label}`);

// The driver implements the pinned v2 design. A different schedule or policy requires a reviewed revision.
export function validateManifest(value: unknown) {
  verifyManifestPin(source('./pilot-manifest.json'));
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid manifest object');
  const sections = value as Record<string, unknown>;
  expected(Object.keys(sections).sort(), Object.keys(design).sort(), 'sections');
  for (const [key, registered] of Object.entries(design)) expected(sections[key], registered, key);

  const { cells, curationCells, judgingCells, tasks, budgets, ordering, plannedTotals, scoring } = design;
  const count = (phase: string) => cells.filter(c => c.phase === phase).length;
  expected(['O', 'R', 'M', 'E', 'P'].map(count), [6, 4, 16, 6, 2], 'phase counts');
  expected(design.phases.map(p => p.intendedCells), design.phases.map(p => count(p.id)), 'phase totals');
  expected(cells.map(c => c.ordinal), cells.map((_, i) => i + 1), 'ordinals');
  const ids = [...cells, ...curationCells, ...judgingCells].map(c => c.id);
  assert(new Set(ids).size === ids.length, 'Duplicate intended row');
  assert(cells.every(c => c.intended && c.repeat === 1 && Object.hasOwn(design.arms, c.arm)
    && tasks.some(t => t.id === c.task && t.use.includes(c.phase))), 'Invalid cell binding');
  expected(new Set(cells.map(c => c.task)).size, 13, 'task count');
  expected(tasks.map(t => t.id).sort(), [...new Set(cells.map(c => c.task))].sort(), 'task identities');
  const byId = new Map(cells.map(c => [c.id, c]));
  expected(cells.slice(0, 8).map(c => c.id), ordering.orchestrationBlocks.flatMap(b => b.orderedCells), 'O compact order');
  for (const [i, block] of ordering.orchestrationBlocks.entries()) {
    const blockCells = block.orderedCells.map(id => byId.get(id));
    expected(blockCells.map(c => c?.arm), i === 0 ? ['S', 'P', 'F', 'A'] : ['A', 'F', 'P', 'S'], 'O counterbalance');
    assert(blockCells.every(c => c?.task === block.task), 'O block task mismatch');
    const pair = ordering.productPairedBlocks[i];
    const [s, p] = blockCells.filter(c => c?.arm === 'S' || c?.arm === 'P');
    expected(pair.orderedCells, [s?.id, p?.id], 'P/S order');
    const product = s?.arm === 'P' ? s : p;
    expected(product?.comparisonControl, s?.arm === 'S' ? s.id : p?.id, 'P control');
    expected(block.contrasts.map(c => c.maxFirstModelWorkSeparationSeconds), [7200, 3600], 'O contrast limits');
  }
  expected(ordering.productPairDrift.maxFirstModelWorkSeparationSeconds, 3600, 'P/S time limit');
  expected(ordering.orchestrationDrift.maxBlockFirstModelWorkSeparationSeconds, 10800, 'O block time limit');
  expected(cells.slice(8, 12).map(c => `${c.task}:${c.arm}`), ['T-export:HF', 'T-export:HA', 'T-archive:HA', 'T-archive:HF'], 'routing order');

  for (const [i, step] of ['L1', 'L2', 'H1', 'H2'].entries()) {
    for (const [j, sequence] of design.memorySequences.entries()) {
      const task = `${sequence.id}-${step}`;
      const pair = cells.slice(12 + 4 * i + 2 * j, 14 + 4 * i + 2 * j);
      expected(pair.map(c => c.arm), (i + j) % 2 ? ['MA', 'MR'] : ['MR', 'MA'], 'M counterbalance');
      const snapshot = i === 0 ? 'empty' : i === 1 ? `${sequence.id}-MA-after-L1` : sequence.freezeAfter;
      assert(sequence.tasks[i] === task && sequence.freshSessionsEveryTask && sequence.repoResetEveryTask
        && !sequence.feedbackDuringHeldOut, 'Invalid M sequence');
      const learn = i < 2;
      for (const c of pair) {
        expected([c.task, c.sequence, c.step, c.kind, c.budget, c.memory],
          [task, sequence.id, i + 1, ['learn', 'learn', 'near', 'far'][i], learn ? 'B-learn' : 'B', c.arm === 'MA' ? snapshot : 'empty'], 'M dependencies');
        const assigned = curationCells.filter(x => x.afterCell === c.id);
        expected(assigned.length, Number(learn), 'curator coverage');
        if (learn) {
          const [curator] = assigned;
          expected([curator.sequence, curator.arm, curator.step, curator.memoryOutput, curator.retainForSolver, curator.hiddenFeedback],
            [sequence.id, c.arm, i + 1, `${sequence.id}-${c.arm}-after-L${i + 1}`, c.arm === 'MA', false], 'curation output');
        }
      }
      if (i >= 2) expected(task, sequence.evaluateSameFrozenSnapshotOn[i - 2], 'frozen evaluation task');
      if (snapshot !== 'empty') assert(curationCells.some(x => x.memoryOutput === snapshot && x.retainForSolver
        && byId.get(x.afterCell)!.ordinal < pair[0].ordinal), 'M pack dependency is unavailable');
    }
  }
  const evolving = design.evolvingCodeSequences[0];
  for (const [i, task] of evolving.tasks.entries()) {
    const pair = cells.slice(28 + 2 * i, 30 + 2 * i);
    expected(pair.map(c => c.arm), i % 2 ? ['EA', 'ER'] : ['ER', 'EA'], 'E order');
    for (const c of pair) expected([c.sequence, c.step, c.task, c.memory, c.codeInput],
      [evolving.id, i, task, 'empty', i ? `E-E1-${i - 1}-${c.arm}-r1:final-tree` : 'sealed-base'], 'E dependency');
  }
  for (const wf of [design.workflows.team, design.workflows['single-reviewed']]) {
    expected([wf.maxFixes, wf.maxReviews, wf.reviewFailEdge, wf.fixNext, wf.publicCheckAccess, wf.hiddenCheckAccess, wf.nativeSubagents],
      [1, 2, { to: 'fix', maxRounds: 1, onExhausted: 'park' }, 'reviewer', true, false, false], 'review floor');
  }
  assert(Object.values(design.arms).every(a => a.safetyFloor === 'common-review-fix'), 'Missing floor');
  for (const c of cells) expected(judgingCells.filter(j => j.cell === c.id).map(j => j.judge), ['J1', 'J2'], 'scoring judges');
  const golds = judgingCells.filter(j => j.kind === 'calibration');
  expected(golds.map(j => j.judge), ['J1', 'J2', 'J1', 'J2', 'J1', 'J2', 'J1', 'J2'], 'calibration pairs');
  const stages = cells.reduce((sum, c) => sum + arm(c).maxSolverSessions, 0);
  const solverUnits = cells.length * budgets.B.maxChargedUnits;
  const judgeUnits = judgingCells.length * budgets.judge.maxChargedUnits;
  expected([
    plannedTotals.solverSessionsMax, plannedTotals.curatorSessionsMax, plannedTotals.judgeSessionsMax, plannedTotals.allSubscriptionSessionsMax,
    plannedTotals.solverAndCurationChargedUnitsMax, plannedTotals.judgeChargedUnitsMax, plannedTotals.allChargedUnitsMax,
    plannedTotals.allAggregateActiveSecondsMax, plannedTotals.solverQueueSecondsMax, plannedTotals.judgeQueueSecondsMax,
    scoring.primaryDenominator, scoring.endpointDenominators,
  ], [
    stages, curationCells.length, judgingCells.length, stages + curationCells.length + judgingCells.length,
    solverUnits, judgeUnits, solverUnits + judgeUnits,
    cells.length * budgets.B.maxAggregateActiveSeconds + judgingCells.length * budgets.judge.maxActiveSeconds,
    cells.length * budgets.B.maxQueueSeconds, judgingCells.length * budgets.judge.maxQueueSeconds, cells.length,
    {
      O: { cellsPerArm: count('O') / 3, independentTaskClusters: 2 },
      R: { cellsPerArm: count('R') / 2, independentTaskClusters: 2 },
      'M-held-out': { cellsPerArm: count('M') / 4, independentSequenceClusters: 2, acquisitionCellsPerArmExcludedFromHeldOutContrast: curationCells.length / 2 },
      'M-acquisition': { cellsPerArm: cells.filter(c => c.phase === 'M' && c.kind === 'learn').length / 2,
        independentSequenceClusters: 2, includesFailuresAndNotRun: true },
      P: { cellsPerArm: count('P'), independentTaskClusters: 2, reuseControlFrom: 'O-S-r1-reviewed' },
      E: { cellsPerArm: count('E') / 2, independentSequenceClusters: 1 },
    },
  ], 'registered denominators and budgets');
  expected(budgets['B-learn'].solverUnits + budgets['B-learn'].curatorUnits, budgets.B.maxChargedUnits, 'curation unit reservation');
  expected(budgets['B-learn'].solverActiveSeconds + budgets['B-learn'].curatorActiveSeconds, budgets.B.maxAggregateActiveSeconds, 'curation time reservation');
  for (const sample of scoring.fullyAccepted.boundaryCases) {
    const flags = Object.fromEntries(scoring.fullyAccepted.requiredTrue.map(key => [key, key !== sample.falseFlag]));
    expected(fullyAccepted(flags, sample.judgeRatings), sample.fullyAccepted, 'acceptance boundary');
  }
  const shared = design.processMeasurement.sharedOpportunityViolations.boundaryCases;
  const registry = shared.opportunityIds.map(id => ({ id, task: 'synthetic', principle: id, proof: 'synthetic', version: '1', applicability: 'applicable' as const }));
  for (const example of Object.values(shared.arms)) {
    const actions = Object.fromEntries(Object.entries(example.outcomes).map(([id, outcome]) => [id, {
      outcome: outcome as 'compliant' | 'violating', evidence: 'synthetic', at: 0,
      priorCorrection: example.priorCorrections.includes(id) ? 'synthetic' : undefined,
    }]));
    const rates = violationRates(registry, actions);
    for (const [actual, wanted] of [[rates.primary, example.primary], [rates.conditionalRecurrence, example.conditional]] as const) {
      expected({ numerator: actual.numerator, denominator: actual.denominator }, wanted, 'opportunity boundary');
    }
  }
  assert(design.retrospectiveEvidence.classification === 'development-calibration-observational'
    && 'quarantineRegistryDigest' in design.retrospectiveEvidence.schema.properties
    && design.retrospectiveEvidence.metrics.causalMemoryAttributionAllowed === false, 'Invalid retrospective quarantine policy');
  return design;
}

export const gateRequirements = {
  G1: ['effective-roots', 'subscription-auth', 'sterile-instructions', 'live-state-denied'],
  G2: ['composed-input-inventory', 'positive-parent-canary', 'negative-role-canaries', 'start-resume-fence', 'memory-and-write-isolation'],
  G3: ['reader-inventory', 'all-reader-negative-canaries', 'cross-arm-and-future-isolation'],
  G4: ['paid-provider-denied', 'local-whole-pack-retrieval'],
  G5: ['actual-usage-parser', 'retry-aggregate-caps', 'owned-interrupt-cleanup'],
  G6: ['thirteen-package-and-worktree-links', 'wrong-project-missing-task-controls', 'current-seat-visible-lineage'],
  G7: ['retrospective-quarantine', 'locked-disposable-fixtures', 'reference-oracle-controls', 'blind-judge-payloads'],
} as const;
type Gate = keyof typeof gateRequirements;
type GateObservation = Record<string, 'pass' | 'fail' | 'unknown'>;
type EvidencePointer = { path: string; digest: string };
type GateProof = { status: 'verified' | 'failed' | 'unverified'; bindingDigest: string; checkedBindingDigest: string;
  observationId: string; sourceDigest: string; artifactDigest: string; observationsDigest: string; observations: GateObservation;
  artifact: { schemaVersion: 1; classification: 'observed-gate-evidence' | 'harness-only'; gate: Gate; proof: string;
    manifestDigest: string; checkedBindingDigest: string; observationId: string; sourceDigest: string;
    observations: GateObservation; evidence: EvidencePointer } };
type GateEvidence = { status: 'verified' | 'unresolved'; proofs?: Record<string, GateProof> };
export type Binding = {
  classification: 'observed' | 'harness-only';
  manifestDigest: string;
  gates?: Partial<Record<Gate, GateEvidence>>;
  independentVerdict?: { approved: boolean; artifactDigest: string; bindingDigest: string; observationsDigest: string;
    observations: Record<string, 'pass' | 'fail' | 'unknown'>; gateEvidenceDigests: Record<string, string>;
    artifact: { schemaVersion: 1; classification: 'independent-gate-review' | 'harness-only'; manifestDigest: string;
      observations: Record<string, 'pass' | 'fail' | 'unknown'>; gateEvidenceDigests: Record<string, string>; evidence: EvidencePointer } };
  unresolved?: string[];
  taskProjectLinks?: { task: string; taskProject: string; canonicalProject: string; packageProject: string; worktreeProject: string }[];
};
const manifestDigest = () => digest(source('./pilot-manifest.json'));
const PINNED_MANIFEST_DIGEST = 'b033ecde6a981da6c51326b00f4ffd2d7525280054f76ffcaa508eda8b745c9f';

export function verifyManifestPin(bytes: Uint8Array, pin = PINNED_MANIFEST_DIGEST) {
  assert(sha(pin) && digest(bytes) === pin, 'Bundled manifest differs from the reviewed pin');
}

export function gateRefusals(binding?: Binding) {
  const links = Array.isArray(binding?.taskProjectLinks) ? binding.taskProjectLinks : [];
  const taskKeys = new Set(links.map(link => link?.task));
  const linksValid = links.length === design.tasks.length && taskKeys.size === design.tasks.length
    && design.tasks.every(task => taskKeys.has(task.id))
    && links.every(link => !!link && typeof link === 'object' && !!link.taskProject && link.taskProject === link.canonicalProject
      && link.taskProject === link.packageProject && link.taskProject === link.worktreeProject);
  return (Object.keys(gateRequirements) as Gate[]).flatMap(gate => {
    const evidence = binding?.gates?.[gate];
    const missing = gateRequirements[gate].filter(name => {
      const proof = evidence?.proofs?.[name];
      return binding?.classification !== 'observed' || !proof || proof.status !== 'verified' || !sha(proof.artifactDigest)
        || !sha(proof.observationsDigest) || proof.bindingDigest !== binding?.manifestDigest
        || !proof.observations || Object.keys(proof.observations).length === 0
        || Object.values(proof.observations).some(value => value !== 'pass')
        || digest(json(proof.observations)) !== proof.observationsDigest
        || !isDeepStrictEqual(Object.keys(proof.observations).sort(), [...gateRequirements[gate]].sort())
        || proof.artifact?.schemaVersion !== 1 || proof.artifact.classification !== 'observed-gate-evidence'
        || proof.artifact.gate !== gate || proof.artifact.proof !== name
        || proof.artifact.manifestDigest !== binding?.manifestDigest
        || !sha(proof.checkedBindingDigest) || proof.artifact.checkedBindingDigest !== proof.checkedBindingDigest
        || !proof.observationId || proof.artifact.observationId !== proof.observationId
        || !sha(proof.sourceDigest) || proof.artifact.sourceDigest !== proof.sourceDigest
        || !isDeepStrictEqual(proof.artifact.observations, proof.observations)
        || !verifiedEvidenceFile(proof.artifact.evidence, gate, name, binding!.manifestDigest, proof.checkedBindingDigest,
          proof.observationId, proof.sourceDigest, proof.observations)
        || digest(json(proof.artifact)) !== proof.artifactDigest;
    });
    const linkProof = binding?.gates?.G6?.proofs?.['thirteen-package-and-worktree-links'];
    const linkEvidence = gate === 'G6' && linkProof?.artifact?.evidence ? readEvidenceFile(linkProof.artifact.evidence) : null;
    const linkedTasks = linkEvidence?.taskProjectLinks;
    const exactLinksObserved = Array.isArray(linkedTasks) && isDeepStrictEqual(linkedTasks, binding?.taskProjectLinks);
    if (binding?.manifestDigest !== manifestDigest() || evidence?.status !== 'verified' || missing.length
      || (gate === 'G6' && (!linksValid || !exactLinksObserved))) {
      return [{ gate, missing: missing.length ? missing : gate === 'G6' && !linksValid
        ? ['thirteen exact task/project links'] : gate === 'G6' && !exactLinksObserved
          ? ['content-addressed G6 evidence does not bind the observed task/project links'] : ['verified proof for this manifest'] }];
    }
    return [];
  });
}

function readEvidenceFile(pointer: EvidencePointer | undefined): Record<string, unknown> | null {
  try {
    if (!pointer || !sha(pointer.digest) || !pointer.path) return null;
    const stat = lstatSync(pointer.path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) return null;
    const bytes = readFileSync(pointer.path);
    if (digest(bytes) !== pointer.digest) return null;
    return JSON.parse(bytes.toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function verifiedOracleFile(pointer: EvidencePointer | undefined, taskId: string, treeDigest: string, commandDigest: string,
  checks: Record<string, string>, evidenceDigest: string) {
  const record = readEvidenceFile(pointer);
  return !!record && pointer?.digest === evidenceDigest && record.schemaVersion === 1 && record.classification === 'oracle-run-result'
    && isDeepStrictEqual(record, { schemaVersion: 1, classification: 'oracle-run-result', taskId, treeDigest, commandDigest,
      exitCode: 0, checks });
}

function verifiedEvidenceFile(pointer: EvidencePointer | undefined, gate: Gate, proof: string, manifest: string,
  checkedBindingDigest: string, observationId: string, sourceDigest: string, observations: GateObservation) {
  const record = readEvidenceFile(pointer);
  return !!record && record.schemaVersion === 1 && record.classification === 'observed-gate-evidence'
      && record.gate === gate && record.proof === proof && record.manifestDigest === manifest
      && record.checkedBindingDigest === checkedBindingDigest && record.observationId === observationId
      && record.sourceDigest === sourceDigest && isDeepStrictEqual(record.observations, observations)
      && record.result && typeof record.result === 'object'
      && isDeepStrictEqual(record.result, { gate, proof, manifestDigest: manifest, checkedBindingDigest, observationId, sourceDigest, outcome: 'pass' });
}

export function launchRefusal(binding?: Binding) {
  if (Array.isArray(binding?.unresolved) && binding.unresolved.length) return `Unresolved static bindings: ${binding.unresolved.slice(0, 8).join(', ')}`;
  const gates = gateRefusals(binding);
  if (gates.length) return gates.map(item => `${item.gate}: ${item.missing.join(', ')}`).join('; ').slice(0, 1000);
  const verdict = binding?.independentVerdict;
  const gateEvidenceDigests = Object.fromEntries((Object.keys(gateRequirements) as Gate[]).map(gate => [gate,
    digest(json(Object.fromEntries(Object.entries(binding?.gates?.[gate]?.proofs ?? {})
      .map(([name, proof]) => [name, proof.artifactDigest]).sort(([a], [b]) => String(a).localeCompare(String(b))))))]));
  if (!verdict?.approved || verdict.bindingDigest !== binding?.manifestDigest || !sha(verdict.artifactDigest)
    || !sha(verdict.observationsDigest) || !Object.keys(verdict.observations ?? {}).length
    || Object.values(verdict.observations).some(value => value !== 'pass')
    || !isDeepStrictEqual(Object.keys(verdict.observations).sort(), (Object.keys(gateRequirements) as Gate[]).sort())
    || !isDeepStrictEqual(verdict.gateEvidenceDigests, gateEvidenceDigests)
    || digest(json(verdict.observations)) !== verdict.observationsDigest || verdict.artifact?.schemaVersion !== 1
    || verdict.artifact.classification !== 'independent-gate-review' || verdict.artifact.manifestDigest !== binding?.manifestDigest
    || !isDeepStrictEqual(verdict.artifact.observations, verdict.observations)
    || !isDeepStrictEqual(verdict.artifact.gateEvidenceDigests, verdict.gateEvidenceDigests)
    || !verifiedReviewFile(verdict.artifact.evidence, binding?.manifestDigest, verdict.observations, verdict.gateEvidenceDigests)
    || digest(json(verdict.artifact)) !== verdict.artifactDigest) return 'G1–G7: independent verification required';
  return 'G1–G7: manifest launchAllowed is false; offline driver';
}

function verifiedReviewFile(pointer: EvidencePointer | undefined, manifest: string | undefined, observations: GateObservation, gateEvidenceDigests: Record<string, string>) {
  const record = readEvidenceFile(pointer);
  return !!record && record.schemaVersion === 1 && record.classification === 'independent-gate-review'
    && record.manifestDigest === manifest && isDeepStrictEqual(record.observations, observations)
    && isDeepStrictEqual(record.gateEvidenceDigests, gateEvidenceDigests)
    && record.result && typeof record.result === 'object'
    && isDeepStrictEqual(record.result, { manifestDigest: manifest, gateEvidenceDigests, observations, approved: true });
}

export type RequestInputs = {
  repoDir: string; baseRef: string; src: string; taskIds: string[];
  brief: string; review: string; fix: string; planner?: string;
  roles?: Partial<Record<'planner' | 'solve' | 'review' | 'fix', Runtime>>;
  memory?: { id: string; bytes: string; digest: string };
  fixtureDigest: string; promptDigest: string; taskDigest: string; runtimeDigest: string; dependencyDigest: string;
  bindingDigest: string;
  previous?: { cellId: string; commit: string; treeDigest: string; delivered: boolean; matchedPairDelivered: boolean };
};

/** Runtime-derived pack/tree fields are bound from ledger records after sealing. */
export function sealedInputDigest(rowId: string, inputs: RequestInputs) {
  const cell = design.cells.find(c => c.id === rowId);
  const staticInputs = { ...inputs };
  if (cell?.memory && cell.memory !== 'empty') delete (staticInputs as { memory?: RequestInputs['memory'] }).memory;
  if (cell?.codeInput && cell.codeInput !== 'sealed-base') {
    delete (staticInputs as { previous?: RequestInputs['previous'] }).previous;
    staticInputs.baseRef = '<ledger-bound-predecessor>';
  }
  return digest(json(staticInputs));
}

type PlannerRoute = { solve: 'M' | 'H'; fix: 'M' | 'H'; plannerCellId: string; plannerPipelineId: string; plannerSessionId: string;
  terminalStageId: 'planner'; terminalReceipt: string; cleanupReceipt: string; usage: Observation['usage']; output: string;
  outputDigest: string; evidence: EvidencePointer };

function routeOutputMatches(route: PlannerRoute) {
  try {
    const output = JSON.parse(route.output) as Record<string, unknown>;
    return isDeepStrictEqual(Object.keys(output).sort(), ['fix', 'solve'])
      && output.solve === route.solve && output.fix === route.fix;
  } catch {
    return false;
  }
}

function verifiedPlannerResult(route: PlannerRoute) {
  const record = readEvidenceFile(route.evidence);
  return !!record && isDeepStrictEqual(record, { schemaVersion: 1, classification: 'planner-terminal-result',
    pipelineId: route.plannerPipelineId, sessionId: route.plannerSessionId, stageId: route.terminalStageId,
    terminalReceipt: route.terminalReceipt, cleanupReceipt: route.cleanupReceipt, usage: route.usage,
    output: route.output, outputDigest: route.outputDigest });
}

function buildRequest(id: string, inputs: RequestInputs, verifiedRoute?: PlannerRoute, plannerOnly = false) {
  const cell = design.cells.find(c => c.id === id);
  const judge = design.judgingCells.find(c => c.id === id);
  const curator = design.curationCells.find(c => c.id === id);
  assert(cell || judge || curator, 'Unknown intended row');
  assert(inputs && typeof inputs === 'object' && Array.isArray(inputs.taskIds) && inputs.src && inputs.repoDir
    && /^[a-f0-9]{40}$/.test(inputs.baseRef) && inputs.taskIds.length
    && inputs.taskIds.every(Boolean) && new Set(inputs.taskIds).size === inputs.taskIds.length && inputs.brief, 'Unresolved request inputs');
  assert([inputs.fixtureDigest, inputs.promptDigest, inputs.taskDigest, inputs.runtimeDigest, inputs.dependencyDigest, inputs.bindingDigest].every(sha),
    'Missing sealed fixture, prompt, task, runtime, dependency or run binding');
  if (cell?.codeInput && cell.codeInput !== 'sealed-base') {
    assert(inputs.previous?.cellId === cell.codeInput.split(':')[0] && inputs.previous.commit === inputs.baseRef
      && inputs.previous.delivered && inputs.previous.matchedPairDelivered && sha(inputs.previous.treeDigest), 'Missing matched E predecessor');
  }
  const memory = inputs.memory;
  if (cell && cell.memory !== 'empty') {
    assert(memory?.id === cell.memory && memory.digest === digest(memory.bytes)
      && Buffer.byteLength(memory.bytes) <= design.budgets.memoryPack.maxUtf8Bytes, 'Missing or changed learned pack');
  } else assert(!memory, 'Unexpected memory input');

  const runtime = (key: 'M' | 'H') => {
    const { engine, model, effort } = design.runtimePool[key];
    return { engine, model, effort };
  };
  const stage = (stageId: string, roleId: string, roleRuntime: ReturnType<typeof runtime>, prompt: string,
    next: string | null, access: 'read-only' | 'read-write') => {
    assert(prompt, 'Missing sealed stage brief');
    return { id: stageId, kind: 'run', role: { roleId }, ...roleRuntime, access, sandbox: 'restricted', prompt, next };
  };
  const stages = [];
  if (cell) {
    const planned = cell.arm !== 'S' && cell.arm !== 'HA';
    if (cell.arm === 'HA' && !plannerOnly) {
      const route = verifiedRoute;
      assert(route && route.plannerCellId === cell.id && route.plannerPipelineId && route.plannerSessionId
        && sha(route.outputDigest) && ['M', 'H'].includes(route.solve) && ['M', 'H'].includes(route.fix), 'Missing counted planner route receipt');
    }
    const forRole = (role: 'planner' | 'solve' | 'review' | 'fix') => {
      if (cell.arm === 'P') {
        const selected = inputs.roles?.[role];
        assert(selected && ['codex', 'claude'].includes(selected.engine) && selected.model && selected.effort, 'Unbound product runtime');
        return selected;
      }
      const selectable = role === 'solve' || role === 'fix';
      return runtime(selectable && cell.arm === 'HF' ? 'H' : selectable && cell.arm === 'HA' ? verifiedRoute![role] : 'M');
    };
    if (plannerOnly) {
      stages.push(stage('planner', 'architect', runtime('M'), inputs.planner ?? '', null, 'read-only'));
    } else {
    if (planned) stages.push(stage('planner', 'architect', forRole('planner'), inputs.planner ?? '', 'solve', 'read-only'));
    stages.push(
      stage('solve', 'builder', forRole('solve'), [inputs.brief, memory?.bytes].filter(Boolean).join('\n\n'), 'review', 'read-write'),
      { ...stage('review', 'reviewer', forRole('review'), inputs.review, null, 'read-only'), onFail: { ...design.workflows.team.reviewFailEdge } },
      stage('fix', 'builder', forRole('fix'), inputs.fix, 'review', 'read-write'),
    );
    }
  } else if (judge) {
    stages.push(stage('judge', 'verifier', runtime(judge.judge === 'J1' ? 'M' : 'H'), inputs.brief, null, 'read-only'));
  } else {
    stages.push(stage('curate', 'curator', runtime('M'), inputs.brief, null, 'read-only'));
  }
  return {
    clientRequestId: `${design.campaign}:${id}`,
    repoDir: inputs.repoDir, baseRef: inputs.baseRef, src: inputs.src, taskIds: [...inputs.taskIds],
    task: judge ? 'Blind benchmark judgment' : curator ? 'Benchmark memory curation' : 'Benchmark task',
    publication: 'internal', finishesTask: false, stages,
  };
}

export function expandRequest(id: string, inputs: RequestInputs) {
  assert(design.cells.find(c => c.id === id)?.arm !== 'HA', 'HA routing requires a durable planner ledger event');
  return buildRequest(id, inputs);
}

export function expandPlannerRequest(id: string, inputs: RequestInputs) {
  const cell = design.cells.find(c => c.id === id);
  assert(cell?.arm === 'HA', 'Planner-only request is reserved for HA rows');
  const request = buildRequest(id, { ...inputs, planner: inputs.planner || 'Choose M or H for solve and fix from this sealed planner task.' }, undefined, true);
  return { ...request, clientRequestId: `${design.campaign}:${id}:planner`, stages: request.stages.slice(0, 1) };
}

// The only transport used here is the SDK's in-process harness transport.
export async function sampleDelivery(transport: InMemoryTransport, request: ReturnType<typeof expandRequest>) {
  assert(transport instanceof InMemoryTransport, 'Only an in-process harness transport is supported');
  const client = new Client({ name: 'delegatus-benchmark-harness', version: '2' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'create_pipeline', arguments: request }, undefined, { timeout: 500 });
    const block = Array.isArray(result.content) ? result.content[0] : undefined;
    const receipt = result.structuredContent ?? (block?.type === 'text' ? JSON.parse(block.text) : null);
    if (result.isError || receipt?.ok !== true || typeof receipt?.pipelineId !== 'string'
      || receipt?.clientRequestId !== request.clientRequestId) return { status: 'unknown' as const, receipt };
    if (receipt.replayed === true || receipt.duplicate === true) return { status: 'duplicate' as const, receipt };
    return { status: 'accepted' as const, receipt };
  } catch {
    return { status: 'unknown' as const, receipt: null };
  } finally {
    await client.close();
  }
}

type DriftSnapshot = {
  at: number; capacityBudgets: number; quotaStart: number; quotaEnd: number;
  sharedInputs: string; roles: Record<string, string>; providerRevision: string | null;
  runtimeBindings?: Record<string, { declared: 'M' | 'H'; requested: Runtime; resolved: Runtime; bindingDigest: string }>;
};
type DriftRecord = {
  id: string; before: DriftSnapshot; after: DriftSnapshot; firstModelWork: number;
  checkpoint?: Record<string, string>; preflightId?: string; startId?: string;
};

export function checkBlock(blockId: string, rows: DriftRecord[], allSolverRows: Pick<DriftRecord, 'id'>[] = rows) {
  const orchestration = design.ordering.orchestrationBlocks.find(b => b.id === blockId);
  const product = design.ordering.productPairedBlocks.find(b => b.id === blockId);
  const block = orchestration ?? product;
  assert(block, 'Unknown drift block');
  const fail = (reason: string) => ({ eligible: false, stop: true, reason });
  if (rows.length > block.orderedCells.length || rows.some((row, i) => row.id !== block.orderedCells[i])) return fail('Interleaved or reordered solver');
  if (rows.length) {
    const first = allSolverRows.findIndex(row => row.id === rows[0]!.id);
    const last = allSolverRows.findIndex(row => row.id === rows.at(-1)!.id);
    if (first < 0 || last < first || !isDeepStrictEqual(allSolverRows.slice(first, last + 1).map(row => row.id), rows.map(row => row.id))) {
      return fail('Interleaved outside solver in complete campaign ledger');
    }
  }
  const initial = rows[0]?.before;
  if (!initial) return fail('Missing block preflight');
  const roles = new Map<string, string>();
  const profiles = new Map<string, Runtime>();
  let previousEnd = initial.at;
  for (const [i, row] of rows.entries()) {
    const [before, first, after] = [row.before.at, row.firstModelWork, row.after.at];
    if (![before, first, after].every(Number.isSafeInteger) || before < previousEnd || first < before || after < first) return fail('Missing or nonmonotonic timing');
    previousEnd = after;
    if (!Number.isSafeInteger(row.before.capacityBudgets) || !Number.isSafeInteger(row.after.capacityBudgets)
      || row.before.capacityBudgets < block.orderedCells.length - i
      || row.after.capacityBudgets < block.orderedCells.length - i - 1) return fail('Insufficient or unknown capacity');
    const cell = design.cells.find(c => c.id === row.id)!;
    const expectedRoles = cell.arm === 'S' ? ['fix', 'review', 'solve'] : ['fix', 'planner', 'review', 'solve'];
    for (const s of [row.before, row.after]) {
      if (!Number.isSafeInteger(s.quotaStart) || !Number.isSafeInteger(s.quotaEnd)
        || s.quotaStart !== initial.quotaStart || s.quotaEnd !== initial.quotaEnd
        || s.at < s.quotaStart || s.at >= s.quotaEnd) return fail('Quota window changed or unknown');
      if (!s.providerRevision || s.providerRevision !== initial.providerRevision) return fail('Provider revision changed or unknown');
      if (!sha(s.sharedInputs) || s.sharedInputs !== initial.sharedInputs) return fail('Shared inputs changed or unknown');
      if (!s.roles || !isDeepStrictEqual(Object.keys(s.roles).sort(), expectedRoles)) return fail('Incomplete role binding inventory');
      if (!s.runtimeBindings || !isDeepStrictEqual(Object.keys(s.runtimeBindings).sort(), expectedRoles)) return fail('Missing requested/resolved runtime observations');
      for (const [role, hash] of Object.entries(s.roles)) {
        if (!sha(hash) || (roles.has(role) && roles.get(role) !== hash)) return fail('Role runtime or containment binding changed');
        roles.set(role, hash);
        const binding = s.runtimeBindings[role]!;
        if (!binding || !['M', 'H'].includes(binding.declared)) return fail('Unknown declared runtime binding');
        if (binding.bindingDigest !== digest(json({ roleHash: hash, declared: binding.declared,
          requested: binding.requested, resolved: binding.resolved }))) return fail('Runtime observation is not bound to the sealed role identity');
        const declared = design.runtimePool[binding.declared];
        const expectedProfile = { engine: declared.engine, model: declared.model, effort: declared.effort };
        if (!isDeepStrictEqual(binding.requested, expectedProfile) || !isDeepStrictEqual(binding.resolved, expectedProfile)) {
          return fail('Requested or resolved runtime differs from declared model binding');
        }
        const previousProfile = profiles.get(role);
        if (previousProfile && !isDeepStrictEqual(previousProfile, binding.resolved)) return fail('Role runtime changed within causal pair');
        profiles.set(role, binding.resolved);
        if ((cell.arm === 'HF' && ['solve', 'fix'].includes(role) && binding.declared !== 'H')
          || (cell.arm === 'HF' && ['planner', 'review'].includes(role) && binding.declared !== 'M')
          || ((cell.arm === 'S' || cell.arm === 'F' || cell.arm === 'A') && binding.declared !== 'M')) {
          return fail('Role runtime differs from assigned arm');
        }
      }
    }
    const checkpoint = design.ordering.instrumentationCheckpoint;
    if (row.id === checkpoint.afterCell && !checkpoint.continueOnlyAfter.every(name => sha(row.checkpoint?.[name]))) {
      return fail('Missing instrumentation checkpoint evidence');
    }
  }
  const times = new Map(rows.map(row => [row.id, row.firstModelWork]));
  const elapsed = rows.at(-1)!.firstModelWork - rows[0].firstModelWork;
  const max = orchestration ? design.ordering.orchestrationDrift.maxBlockFirstModelWorkSeparationSeconds
    : design.ordering.productPairDrift.maxFirstModelWorkSeparationSeconds;
  if (elapsed > max) return fail('Block exceeded first-model-work separation');
  for (const contrast of orchestration?.contrasts ?? []) {
    const [a, b] = contrast.orderedCells.map(id => times.get(id));
    if (a !== undefined && b !== undefined && b - a > contrast.maxFirstModelWorkSeparationSeconds) return fail(`${contrast.id} exceeded separation`);
  }
  return { eligible: rows.length === block.orderedCells.length, stop: false, reason: null };
}

export function campaignChronologyValid(rows: Pick<DriftRecord, 'id'>[]) {
  const expectedRows = design.cells.filter(cell => cell.phase === 'O' || cell.phase === 'P')
    .sort((a, b) => a.ordinal - b.ordinal).map(cell => cell.id);
  return rows.length === expectedRows.length && rows.every((row, index) => row.id === expectedRows[index]);
}

type Contract = { requirements: Requirement[]; residuals: string[]; opportunities: Opportunity[]; predecessors?: string[]; oracleCommands?: Record<string, string> };
type Seal = {
  schemaVersion: number;
  classification: 'harness-only';
  sources: Record<string, string>;
  rows: { id: string; kind: 'solver' | 'curator' | 'judge' }[];
  contracts: Record<string, Contract>;
  golds: Record<string, string[]>;
  goldArtifactDigests: Record<string, string>;
  bindingDigest: string;
  requestBindings: Record<string, string>;
};
type Entry = {
  id: string;
  rowId: string;
  evidenceDigest: string;
} & (
  | { kind: 'receipt'; status: 'accepted' | 'unknown' | 'duplicate' | 'reconciled'; requestKey: string; pipelineId?: string }
  | { kind: 'preflight'; snapshot: DriftSnapshot; blockId?: string }
  | { kind: 'start'; preflightId: string; startedAt: number; pipelineId: string; sessionId: string; terminalStageId: string }
  | { kind: 'planner-route'; status: 'completed'; route: PlannerRoute }
  | { kind: 'solver'; observation: Observation; drift?: DriftRecord }
  | { kind: 'curator'; status: 'completed' | 'failed' | 'not_run_after_stop'; usage?: Observation['usage']; packDigest?: string; queuedAt?: number; deadlineAt?: number; completedAt?: number; deliveredArtifactDigest?: string; queueReceipt?: string; terminalReceipt?: string; cleanupReceipt?: string }
  | { kind: 'judge'; status: 'completed' | 'failed' | 'not_run_after_stop'; usage?: Observation['usage']; calibration?: Calibration; judgment?: Judgment }
);
type LedgerRecord = { previous: string; entry: Entry };

const intendedRows = (): Seal['rows'] => [
  ...design.cells.flatMap(c => [
    { id: c.id, kind: 'solver' as const },
    ...design.curationCells.filter(x => x.afterCell === c.id).map(x => ({ id: x.id, kind: 'curator' as const })),
  ]),
  ...design.judgingCells.map(c => ({ id: c.id, kind: 'judge' as const })),
];
const sourceDigests = () => ({
  manifest: manifestDigest(),
  protocol: digest(source('../../docs/design/delegatus-benchmark.md')),
  driver: digest(source('./run.ts')),
  scoring: digest(source('./score.ts')),
  ...Object.fromEntries(Object.entries(design.sources).map(([name, spec]) => [name, digest(JSON.stringify(spec))])),
});
const json = (value: unknown) => JSON.stringify(value) + '\n';

function publishFile(directory: string, name: string, value: unknown) {
  const scratch = join(directory, `.pending-${randomUUID()}`);
  const fd = openSync(scratch, 'wx', 0o400);
  try {
    try {
      writeFileSync(fd, json(value));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    linkSync(scratch, join(directory, name));
  } finally {
    unlinkSync(scratch);
  }
  const dir = openSync(directory, 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function replaceFile(directory: string, name: string, value: unknown) {
  const scratch = join(directory, `.replace-${randomUUID()}`);
  const fd = openSync(scratch, 'wx', 0o400);
  try { writeFileSync(fd, json(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(scratch, join(directory, name));
  const dir = openSync(directory, 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

const checkpointName = (index: number) => `checkpoint-${String(index).padStart(6, '0')}.json`;
const checkpointBody = (index: number, count: number, headDigest: string, previous: string) => ({ index, count, digest: headDigest, previous });

export function sealRun(directory: string, classification: 'harness-only', contracts: Record<string, Contract>,
  golds: Record<string, string[]> = {}, bindingDigest?: string, requestBindings?: Record<string, string>, goldArtifactDigests: Record<string, string> = {}) {
  validateManifest(design);
  assert(classification === 'harness-only' && sha(bindingDigest), 'Missing sealed treatment binding');
  expected(Object.keys(requestBindings ?? {}).sort(), intendedRows().map(row => row.id).sort(), 'sealed request bindings');
  assert(Object.values(requestBindings!).every(sha), 'Invalid request input digest');
  expected(Object.keys(contracts).sort(), design.tasks.map(t => t.id).sort(), 'sealed contracts');
  if (Object.keys(golds).length) {
    expected(Object.keys(golds).sort(), [...new Set(design.judgingCells.flatMap(j => j.gold ? [j.gold] : []))].sort(), 'judge golds');
    assert(Object.values(golds).every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && id)), 'Invalid gold defect registry');
    expected(Object.keys(goldArtifactDigests).sort(), Object.keys(golds).sort(), 'judge gold artifact digests');
    assert(Object.values(goldArtifactDigests).every(sha) && new Set(Object.values(goldArtifactDigests)).size === Object.keys(goldArtifactDigests).length,
      'Judge gold artifacts must have distinct sealed content digests');
  } else expected(Object.keys(goldArtifactDigests), [], 'unexpected judge gold artifact digests');
  for (const [gold, defects] of Object.entries(golds)) {
    assert(new Set(defects).size === defects.length, `Duplicate defect in ${gold} gold`);
  }
  for (const [task, contract] of Object.entries(contracts)) {
    assert(contract.residuals.length && new Set(contract.residuals).size === contract.residuals.length, 'Unsealed residual requirements');
    score({ status: 'not_run_after_stop' }, contract.requirements, contract.residuals, 0, false, false);
    assert(contract.opportunities.every(o => o.task === task), 'Opportunity belongs to another task');
    violationRates(contract.opportunities);
    const cell = design.cells.find(c => c.task === task && c.phase === 'E');
    if (cell && cell.step! > 0) {
      const expectedPredecessors = design.evolvingCodeSequences.find(s => s.id === cell.sequence)!.tasks.slice(0, cell.step);
      expected(contract.predecessors, expectedPredecessors, 'cumulative E predecessor contracts');
      expected(Object.keys(contract.oracleCommands ?? {}).sort(), [...expectedPredecessors].sort(), 'cumulative E oracle command bindings');
      assert(Object.values(contract.oracleCommands!).every(sha), 'Invalid E oracle command digest');
    }
  }
  mkdirSync(directory, { mode: 0o700 });
  const seal: Seal = { schemaVersion: design.schemaVersion, classification, sources: sourceDigests(), rows: intendedRows(), contracts, golds, goldArtifactDigests, bindingDigest, requestBindings: requestBindings! };
  const id = digest(json(seal));
  publishFile(directory, 'seal.json', { id, seal });
  const checkpoint = checkpointBody(0, 0, id, id);
  const initialCheckpoint = { ...checkpoint, id: digest(json(checkpoint)) };
  publishFile(directory, checkpointName(0), initialCheckpoint);
  publishFile(directory, 'head.json', { index: 0, checkpointId: initialCheckpoint.id, entryDigest: id });
  return id;
}

function readRun(directory: string) {
  const stat = lstatSync(directory);
  assert(stat.isDirectory() && !(stat.mode & 0o077) && stat.uid === process.getuid?.(), 'Run directory must be private');
  const { id, seal } = JSON.parse(readFileSync(join(directory, 'seal.json'), 'utf8')) as { id: string; seal: Seal };
  assert(sha(id) && digest(json(seal)) === id, 'Run seal changed');
  assert(seal.classification === 'harness-only', 'Unsupported evidence classification');
  expected(seal.schemaVersion, design.schemaVersion, 'sealed schema');
  expected(seal.sources, sourceDigests(), 'sealed sources');
  expected(seal.rows, intendedRows(), 'sealed intended rows');
  assert(existsSync(join(directory, 'head.json')), 'Missing accepted ledger head anchor');
  let head = JSON.parse(readFileSync(join(directory, 'head.json'), 'utf8')) as { index: number; checkpointId: string; entryDigest: string };
  assert(Number.isSafeInteger(head.index) && head.index >= 0, 'Invalid ledger head anchor');
  let previous = id;
  const entries: Entry[] = [];
  const names = readdirSync(directory).filter(n => /^\d{6}\.json$/.test(n)).sort();
  assert(head.index <= names.length, 'Accepted ledger head was rolled back');
  for (const [index, name] of names.entries()) {
    assert(name === eventName(index + 1), 'Ledger sequence gap');
    const data = readFileSync(join(directory, name));
    const record = JSON.parse(data.toString()) as LedgerRecord;
    assert(record.previous === previous, 'Ledger predecessor changed');
    validateEntry(seal, entries, record.entry);
    entries.push(record.entry);
    previous = digest(data);
  }
  let checkpoints = readdirSync(directory).filter(n => /^checkpoint-\d{6}\.json$/.test(n)).sort();
  // Recover the one event that may have reached disk before its checkpoint/head update.
  if (entries.length === checkpoints.length && head.index === entries.length - 1 && entries.length > 0) {
    const previousCheckpoint = JSON.parse(readFileSync(join(directory, checkpointName(entries.length - 1)), 'utf8')) as { id: string };
    const checkpoint = checkpointBody(entries.length, entries.length, digest(readFileSync(join(directory, eventName(entries.length)))), previousCheckpoint.id);
    const committed = { ...checkpoint, id: digest(json(checkpoint)) };
    publishFile(directory, checkpointName(entries.length), committed);
    head = { index: entries.length, checkpointId: committed.id, entryDigest: checkpoint.digest };
    replaceFile(directory, 'head.json', head);
    checkpoints = [...checkpoints, checkpointName(entries.length)];
  }
  if (checkpoints.length === entries.length + 1 && head.index === entries.length - 1 && entries.length > 0) {
    const committed = JSON.parse(readFileSync(join(directory, checkpointName(entries.length)), 'utf8')) as { id: string; digest: string };
    head = { index: entries.length, checkpointId: committed.id, entryDigest: committed.digest };
    replaceFile(directory, 'head.json', head);
  }
  assert(head.index === entries.length, 'Accepted ledger head was rolled back');
  assert(checkpoints.length === entries.length + 1, 'Ledger checkpoint count mismatch');
  let previousCheckpoint = id;
  for (const [index, name] of checkpoints.entries()) {
    assert(name === checkpointName(index), 'Ledger checkpoint sequence gap');
    const checkpoint = JSON.parse(readFileSync(join(directory, name), 'utf8')) as { index: number; count: number; digest: string; previous: string; id: string };
    const body = checkpointBody(index, index, index ? digest(readFileSync(join(directory, eventName(index)))) : id, previousCheckpoint);
    assert(checkpoint.index === index && checkpoint.count === index && checkpoint.previous === previousCheckpoint
      && checkpoint.digest === body.digest && checkpoint.id === digest(json(body)), 'Ledger checkpoint mismatch');
    previousCheckpoint = checkpoint.id;
  }
  assert(previous === JSON.parse(readFileSync(join(directory, checkpointName(entries.length)), 'utf8')).digest, 'Ledger head checkpoint mismatch');
  const anchoredCheckpoint = JSON.parse(readFileSync(join(directory, checkpointName(head.index)), 'utf8')) as { id: string; digest: string };
  assert(head.index === entries.length && head.checkpointId === anchoredCheckpoint.id
    && head.entryDigest === anchoredCheckpoint.digest, 'Accepted ledger head was rolled back');
  return { id, seal, entries, previous };
}

const eventName = (index: number) => `${String(index).padStart(6, '0')}.json`;

function validateEntry(seal: Seal, entries: Entry[], entry: Entry) {
  const row = seal.rows.find(r => r.id === entry.rowId);
  assert(row && entry.id && sha(entry.evidenceDigest), 'Unbound row or evidence');
  assert(!entries.some(e => e.id === entry.id), 'Duplicate ledger event');
  const history = entries.filter(e => e.rowId === entry.rowId);
  if (entry.kind === 'receipt') {
    const baseKey = `${design.campaign}:${entry.rowId}`;
    const plannerKey = `${baseKey}:planner`;
    assert(entry.requestKey === baseKey || (design.cells.find(c => c.id === entry.rowId)?.arm === 'HA' && entry.requestKey === plannerKey), 'Changed request key');
    assert(['accepted', 'unknown', 'duplicate', 'reconciled'].includes(entry.status), 'Invalid receipt status');
    const previous = history.filter((e): e is Extract<Entry, { kind: 'receipt' }> => e.kind === 'receipt' && e.requestKey === entry.requestKey);
    const confirmed = previous.find(e => e.status === 'accepted' || e.status === 'reconciled');
    assert(!confirmed || (entry.status === 'duplicate' && confirmed.pipelineId === entry.pipelineId), 'Conflicting durable delivery');
    assert(entry.status !== 'accepted' || previous.length === 0, 'Use durable reconciliation after unknown delivery');
    assert(entry.status !== 'reconciled' || previous.length && !confirmed, 'Unexpected reconciliation');
    assert(!['accepted', 'reconciled'].includes(entry.status) || entry.pipelineId, 'Missing durable pipeline identity');
    return;
  }
  if (entry.kind === 'preflight') {
    const cell = design.cells.find(c => c.id === entry.rowId);
    assert(row.kind === 'solver' && cell && !history.some(e => e.kind === 'preflight')
      && Number.isSafeInteger(entry.snapshot.at) && entry.snapshot.at >= 0
      && sha(entry.snapshot.sharedInputs) && entry.snapshot.providerRevision
      && entry.blockId === ([...design.ordering.orchestrationBlocks, ...design.ordering.productPairedBlocks]
        .find(block => block.orderedCells.includes(cell.id))?.id), 'Invalid or unregistered solver preflight');
    const prior = design.cells.filter(c => c.ordinal < cell.ordinal);
    assert(prior.every(c => entries.some(e => e.kind === 'solver' && e.rowId === c.id
      && e.observation.status === 'delivered' && e.observation.usage && !e.observation.invalid)), 'Preflight is outside the registered schedule or follows a stop');
    return;
  }
  if (entry.kind === 'start') {
    const preflight = history.find(e => e.kind === 'preflight' && e.id === entry.preflightId);
    const receipt = history.find(e => e.kind === 'receipt' && e.pipelineId === entry.pipelineId
      && ['accepted', 'reconciled'].includes(e.status));
    assert(row.kind === 'solver' && preflight?.kind === 'preflight' && receipt?.kind === 'receipt'
      && !history.some(e => e.kind === 'start') && Number.isSafeInteger(entry.startedAt)
      && entry.startedAt >= preflight.snapshot.at && entry.sessionId && entry.terminalStageId
      && entry.terminalStageId.length <= 80, 'Start lacks durable preflight or accepted pipeline receipt');
    return;
  }
  if (entry.kind === 'planner-route') {
    assert(row.kind === 'solver' && design.cells.find(c => c.id === row.id)?.arm === 'HA'
      && !history.some(e => e.kind === 'planner-route')
      && entry.status === 'completed' && entry.route?.plannerCellId === row.id
      && entry.route.plannerPipelineId && entry.route.plannerSessionId && sha(entry.route.outputDigest)
      && entry.route.terminalStageId === 'planner' && sha(entry.route.terminalReceipt) && sha(entry.route.cleanupReceipt)
      && judgeUsageCovered(entry.route.usage) && entry.route.usage?.sessions === 1
      && verifiedPlannerResult(entry.route)
      && entry.route.output && digest(entry.route.output) === entry.route.outputDigest
      && routeOutputMatches(entry.route)
      && ['M', 'H'].includes(entry.route.solve) && ['M', 'H'].includes(entry.route.fix)
      && history.some(e => e.kind === 'receipt' && e.requestKey === `${design.campaign}:${entry.rowId}:planner`
        && ['accepted', 'reconciled'].includes(e.status) && e.pipelineId === entry.route.plannerPipelineId),
    'Planner route lacks its completed counted pipeline result');
    return;
  }
  assert(!history.some(e => e.kind === entry.kind), 'Row outcome already sealed');
  assert(row.kind === entry.kind, 'Wrong row kind');
  if (entry.kind === 'solver') {
    const cell = design.cells.find(c => c.id === row.id)!;
    const observation = entry.observation;
    assert(['delivered', 'timeout', 'infrastructure_failure', 'blocked', 'not_run_after_stop', 'undelivered'].includes(observation.status), 'Invalid solver outcome');
    assert(observation.status === 'delivered' || observation.reason, 'Missing failure reason');
    if (observation.status === 'delivered') assert(observation.usage && [observation.usage.units, observation.usage.activeSeconds,
      observation.usage.queueSeconds, observation.usage.sessions].every(Number.isSafeInteger)
      && [observation.usage.units, observation.usage.activeSeconds, observation.usage.queueSeconds, observation.usage.sessions].every(value => value >= 0),
    'Delivered solver row lacks nonnegative usage');
    if (observation.status === 'delivered' && cell.kind === 'learn') assert(Number.isSafeInteger(observation.queueStartedAt)
      && Number.isSafeInteger(observation.queueDeadlineAt) && observation.queueStartedAt! <= observation.queueDeadlineAt!
      && observation.queueDeadlineAt! - observation.queueStartedAt! <= design.budgets.B.maxQueueSeconds,
    'Learning row lacks its original bounded queue budget');
    if (observation.status === 'delivered') {
      assert(history.some(e => e.kind === 'receipt' && e.requestKey === `${design.campaign}:${entry.rowId}`
        && ['accepted', 'reconciled'].includes(e.status)), 'Missing durable solver receipt');
    }
    if (cell.phase === 'O' || cell.phase === 'P') {
      const preflight = history.find(e => e.kind === 'preflight');
      const start = history.find(e => e.kind === 'start');
      assert(entry.drift && preflight?.kind === 'preflight' && start?.kind === 'start'
        && entry.drift.preflightId === preflight.id && entry.drift.startId === start.id
        && isDeepStrictEqual(entry.drift.before, preflight.snapshot) && entry.drift.firstModelWork === start.startedAt
        && start.pipelineId === history.find(e => e.kind === 'receipt' && ['accepted', 'reconciled'].includes(e.status))?.pipelineId,
      'Causal solver outcome lacks its durable preflight/start evidence');
    }
    const contract = seal.contracts[cell.task];
    if (observation.status === 'delivered' && cell.phase === 'E' && cell.step! > 0) {
      const required = contract.predecessors ?? [];
      assert(required.length === cell.step && new Set(required).size === required.length, 'E cumulative predecessor contract is missing');
      assert(isDeepStrictEqual(Object.keys(observation.predecessorOracles ?? {}).sort(), [...required].sort()), 'E cumulative predecessor oracle set is incomplete');
      for (const predecessor of required) {
        const prior = seal.contracts[predecessor];
        const oracle = observation.predecessorOracles?.[predecessor];
        assert(prior && observation.final?.tree && oracle && sha(oracle.evidenceDigest)
          && oracle.treeDigest === digest(observation.final.tree) && oracle.commandDigest === contract.oracleCommands?.[predecessor]
          && oracle.exitCode === 0 && prior.requirements.every(r => oracle.checks[r.id] === 'pass')
          && Object.keys(oracle.checks).length === prior.requirements.length
          && verifiedOracleFile(oracle.evidence, predecessor, oracle.treeDigest, oracle.commandDigest, oracle.checks, oracle.evidenceDigest),
        `E predecessor oracle regressed or lacks bound run evidence: ${predecessor}`);
      }
    }
    score(observation, contract.requirements, contract.residuals, arm(cell).maxSolverSessions, cell.kind === 'learn', false);
    violationRates(contract.opportunities, observation.actions);
    assert(!entry.drift || entry.drift.id === entry.rowId, 'Drift row mismatch');
  } else {
    assert(['completed', 'failed', 'not_run_after_stop'].includes(entry.status), 'Invalid stage outcome');
    if (entry.kind === 'curator' && entry.status === 'completed') {
      const curator = design.curationCells.find(c => c.id === entry.rowId)!;
      assert(sha(entry.packDigest), 'Missing curator pack seal');
      assert(entry.usage && entry.usage.sessions === 1 && [entry.usage.units, entry.usage.activeSeconds, entry.usage.queueSeconds].every(Number.isSafeInteger)
        && [entry.usage.units, entry.usage.activeSeconds, entry.usage.queueSeconds].every(value => value >= 0)
        && entry.usage.units <= design.budgets['B-learn'].curatorUnits
        && entry.usage.activeSeconds <= design.budgets['B-learn'].curatorActiveSeconds
        && entry.usage.queueSeconds <= design.budgets.B.maxQueueSeconds && Number.isSafeInteger(entry.queuedAt)
        && Number.isSafeInteger(entry.deadlineAt) && Number.isSafeInteger(entry.completedAt)
        && entry.queuedAt! <= entry.completedAt! && entry.completedAt! <= entry.deadlineAt!
        && entry.deadlineAt! - entry.queuedAt! <= design.budgets.B.maxQueueSeconds
        && sha(entry.deliveredArtifactDigest) && !!entry.queueReceipt && entry.queueReceipt.length <= 160
        && sha(entry.terminalReceipt) && sha(entry.cleanupReceipt),
      'Curator missed or lacks its registered queue deadline or artifact receipt');
      const delivery = entries.find(e => e.kind === 'receipt' && e.rowId === entry.rowId && e.requestKey === `${design.campaign}:${entry.rowId}`
        && ['accepted', 'reconciled'].includes(e.status));
      assert(delivery?.kind === 'receipt' && delivery.pipelineId === entry.queueReceipt, 'Curator completion lacks its durable delivery receipt');
      const learned = entries.find(e => e.kind === 'solver' && e.rowId === curator.afterCell);
      assert(learned?.kind === 'solver' && learned.observation.status === 'delivered'
        && learned.observation.final?.tree && sha(learned.observation.terminalReceipt) && sha(learned.observation.cleanupReceipt)
        && entry.deliveredArtifactDigest === digest(learned.observation.final.tree)
        && Number.isSafeInteger(learned.observation.queueStartedAt) && Number.isSafeInteger(learned.observation.queueDeadlineAt)
        && learned.observation.queueDeadlineAt! - learned.observation.queueStartedAt! <= design.budgets.B.maxQueueSeconds
        && entry.queuedAt === learned.observation.queueStartedAt && entry.deadlineAt === learned.observation.queueDeadlineAt,
      'Missing completed learn artifact or original queue budget');
    }
    if (entry.kind === 'judge' && entry.status === 'completed') {
      const judge = design.judgingCells.find(j => j.id === entry.rowId)!;
      if (judge.kind === 'calibration') {
        assert(entry.calibration?.gold === judge.gold && entry.calibration?.judge === judge.judge && !entry.judgment
          && entry.calibration.session && sha(entry.calibration.artifactDigest) && sha(entry.calibration.terminalReceipt)
          && entry.calibration.artifactDigest === seal.goldArtifactDigests[judge.gold!]
          && sha(entry.calibration.cleanupReceipt) && judgeUsageCovered(entry.calibration.usage), 'Calibration identity or evidence mismatch');
      } else {
        assert(!entry.calibration && entry.judgment && judgeUsageCovered(entry.usage)
          && sha(entry.judgment.artifactDigest) && sha(entry.judgment.terminalReceipt) && sha(entry.judgment.cleanupReceipt), 'Missing score judgment evidence or bounded usage');
        const goldResults = entries.flatMap(e => e.kind === 'judge' && e.status === 'completed' && e.calibration ? [e.calibration] : []);
        assert(calibrationPassed(seal.golds, goldResults, seal.goldArtifactDigests), 'Calibration did not pass');
        assert(design.memorySequences.every(s => entries.some(e => e.kind === 'curator' && e.status === 'completed'
          && design.curationCells.some(c => c.id === e.rowId && c.memoryOutput === s.freezeAfter))), 'Learning snapshots are unfrozen');
        assert(entries.some(e => e.kind === 'solver' && e.rowId === judge.cell && e.observation.status === 'delivered'
          && e.observation.final?.tree), 'No artifact to judge');
      }
      const session = entry.calibration?.session ?? entry.judgment?.session;
      assert(session && !entries.some(e => e.kind === 'judge' && e.status === 'completed'
        && (e.calibration?.session === session || e.judgment?.session === session)), 'Judge session reused');
      if (entry.judgment) {
        const solver = entries.find(e => e.kind === 'solver' && e.rowId === design.judgingCells.find(j => j.id === entry.rowId)?.cell);
        assert(entry.judgment.artifactDigest && entry.judgment.terminalReceipt && entry.judgment.cleanupReceipt
          && solver?.kind === 'solver' && solver.observation.final?.tree
          && entry.judgment.artifactDigest === digest(solver.observation.final.tree), 'Judge artifact, terminal or cleanup evidence missing');
      }
    }
  }
}

export function appendRun(directory: string, entry: Entry) {
  const { seal, entries, previous } = readRun(directory);
  const replay = entries.find(existing => existing.id === entry.id);
  if (replay) {
    assert(isDeepStrictEqual(replay, entry), 'Ledger retry changed an accepted event');
    return;
  }
  validateEntry(seal, entries, entry);
  // The exclusive link claims the next sequence number. A concurrent writer
  // must reread the winner before proposing another event.
  const name = eventName(entries.length + 1);
  publishFile(directory, name, { previous, entry });
  const bytes = readFileSync(join(directory, name));
  const checkpointIndex = entries.length + 1;
  const prior = JSON.parse(readFileSync(join(directory, checkpointName(entries.length)), 'utf8')) as { id: string };
  const body = checkpointBody(checkpointIndex, checkpointIndex, digest(bytes), prior.id);
  const checkpoint = { ...body, id: digest(json(body)) };
  publishFile(directory, checkpointName(checkpointIndex), checkpoint);
  replaceFile(directory, 'head.json', { index: checkpointIndex, checkpointId: checkpoint.id, entryDigest: checkpoint.digest });
}

export function expandSealedRequest(directory: string, id: string, inputs: RequestInputs) {
  const { entries, seal } = readRun(directory);
  assert(inputs.bindingDigest === seal.bindingDigest && seal.requestBindings[id] === sealedInputDigest(id, inputs), 'Request static inputs differ from the sealed row binding');
  const cell = design.cells.find(c => c.id === id);
  if (cell && cell.arm !== 'HA') assert(!entries.some(e => e.rowId === id && (e.kind === 'start'
    || (e.kind === 'receipt' && e.requestKey === `${design.campaign}:${id}` && ['accepted', 'reconciled'].includes(e.status))
    || e.kind === 'solver')), `Row ${id} has already started or has an outcome`);
  if (cell) {
    for (const prior of design.cells.filter(candidate => candidate.ordinal < cell.ordinal)) {
      const result = entries.find(e => e.kind === 'solver' && e.rowId === prior.id);
      assert(result?.kind === 'solver' && result.observation.status === 'delivered' && result.observation.usage
        && !result.observation.invalid, `Admission stopped before ${cell.id}: prior row ${prior.id} is incomplete`);
      const curator = design.curationCells.find(c => c.afterCell === prior.id);
      if (curator) assert(entries.some(e => e.kind === 'curator' && e.rowId === curator.id && e.status === 'completed'),
        `Admission stopped before ${cell.id}: curator ${curator.id} is incomplete`);
    }
    assert(entries.some(e => e.kind === 'preflight' && e.rowId === id), `Admission requires durable ${id} preflight first`);
  }
  if (cell && (cell.phase === 'O' || cell.phase === 'P')) {
    const scheduled = design.cells.filter(c => c.phase === 'O' || c.phase === 'P')
      .sort((a, b) => a.ordinal - b.ordinal).map(c => c.id);
    const targetIndex = scheduled.indexOf(cell.id);
    if (targetIndex >= 0) {
      const priorIds = scheduled.slice(0, targetIndex);
      const prior = priorIds.map(priorId => entries.find(e => e.kind === 'solver' && e.rowId === priorId));
      assert(prior.every(e => e?.kind === 'solver' && e.drift?.id === e.rowId
        && entries.some(start => start.kind === 'start' && start.rowId === e.rowId)
        && entries.some(preflight => preflight.kind === 'preflight' && preflight.rowId === e.rowId)),
      'Missing scheduled durable solver start/preflight evidence before admission');
      const priorDrift = prior.flatMap(e => e?.kind === 'solver' && e.drift ? [e.drift] : []);
      const allSolverRows = entries.filter((e): e is Extract<Entry, { kind: 'solver' }> => e.kind === 'solver').map(e => ({ id: e.rowId }));
      const block = [...design.ordering.orchestrationBlocks, ...design.ordering.productPairedBlocks].find(b => b.orderedCells.includes(cell.id))!;
      const blockPrefix = block.orderedCells.slice(0, block.orderedCells.indexOf(cell.id));
      if (blockPrefix.length) {
        const blockStart = allSolverRows.findIndex(row => row.id === block.orderedCells[0]);
        const blockStarts = blockStart < 0 ? [] : allSolverRows.slice(blockStart);
        assert(isDeepStrictEqual(blockStarts.map(row => row.id), blockPrefix), `Causal admission stopped at ${block.id}: interleaved outside solver`);
      }
      for (const block of [...design.ordering.orchestrationBlocks, ...design.ordering.productPairedBlocks]) {
        const blockRows = priorDrift.filter(row => block.orderedCells.includes(row.id));
        if (blockRows.length) assert(!checkBlock(block.id, blockRows, allSolverRows).stop, `Causal admission stopped at ${block.id}`);
      }
    }
  }
  if (cell?.memory && cell.memory !== 'empty') {
    const sourceCell = design.curationCells.find(c => c.memoryOutput === cell.memory && c.retainForSolver);
    const curator = entries.find(e => e.kind === 'curator' && e.rowId === sourceCell?.id);
    assert(curator?.kind === 'curator' && curator.status === 'completed' && curator.packDigest === inputs.memory?.digest, 'Learned pack has no matching ledger seal');
  }
  if (cell?.codeInput && cell.codeInput !== 'sealed-base') {
    const pair = design.cells.filter(c => c.sequence === cell.sequence && c.step === cell.step! - 1);
    const done = pair.map(c => entries.find(e => e.kind === 'solver' && e.rowId === c.id));
    assert(done.every(e => e?.kind === 'solver' && e.observation.status === 'delivered' && e.observation.final?.tree
      && e.observation.terminalReceipt && e.observation.cleanupReceipt && !e.observation.invalid), 'Missing matched E ledger outcomes');
    const sameArm = done.find(e => e?.rowId === inputs.previous?.cellId);
    assert(sameArm?.kind === 'solver' && sameArm.observation.final?.tree === inputs.previous?.treeDigest
      && sameArm.observation.final?.commit === inputs.baseRef, 'E predecessor tree changed');
  }
  if (cell?.arm === 'HA') {
    const planner = entries.find(e => e.kind === 'planner-route' && e.rowId === id);
    assert(planner?.kind === 'planner-route', 'HA route is unresolved; complete and append the counted planner result first');
    return buildRequest(id, inputs, planner.route);
  }
  return expandRequest(id, inputs);
}

export function expandPlannerSealedRequest(directory: string, id: string, inputs: RequestInputs) {
  const { entries, seal } = readRun(directory);
  const cell = design.cells.find(c => c.id === id);
  assert(cell?.arm === 'HA' && inputs.bindingDigest === seal.bindingDigest
    && seal.requestBindings[id] === sealedInputDigest(id, inputs), 'Unbound HA planner inputs');
  assert(entries.some(e => e.kind === 'preflight' && e.rowId === id), 'Admission requires durable HA preflight first');
  assert(!entries.some(e => e.rowId === id && e.kind === 'receipt' && e.requestKey === `${design.campaign}:${id}:planner`),
    'HA planner request already has a receipt');
  assert(!entries.some(e => e.kind === 'planner-route' && e.rowId === id), 'Planner route already resolved');
  return expandPlannerRequest(id, inputs);
}

function summarize(rows: ReturnType<typeof score>[], rates: ReturnType<typeof violationRates>[]) {
  const n = rows.length;
  const accepted = rows.filter(r => r.fullyAccepted).length;
  const usage = rows.flatMap(r => r.resources ? [r.resources] : []);
  const curation = rows.flatMap(r => r.curatorResources ? [r.curatorResources] : []);
  const sumKnown = (values: (number | null)[]) => ({
    known: values.filter(v => v !== null).length,
    total: values.reduce<number>((total, value) => total + (value ?? 0), 0),
  });
  const axes = ['units', 'sessions', 'activeSeconds', 'queueSeconds'] as const;
  const resources = Object.fromEntries(axes.map(key => [key, {
    observed: usage.reduce((sum, u) => sum + u[key], 0), missing: n - usage.length,
  }]));
  const combine = (key: keyof ReturnType<typeof violationRates>) => {
    const { numerator, denominator, unknown } = rates.reduce((total, r) => ({
      numerator: total.numerator + r[key].numerator,
      denominator: total.denominator + r[key].denominator,
      unknown: total.unknown + r[key].unknown,
    }), { numerator: 0, denominator: 0, unknown: 0 });
    return { numerator, denominator, unknown, bounds: denominator ? [numerator / denominator, (numerator + unknown) / denominator] : null };
  };
  const assistance = rows.flatMap(r => r.human ?? []);
  return {
    intended: n, accepted, completeAcceptanceRate: n ? accepted / n : null,
    autonomous: rows.filter(r => r.autonomousAccepted).length, strictGoalOnly: rows.filter(r => r.strictGoalOnlyAccepted).length,
    firstFunctional: rows.filter(r => r.firstFunctionalAccepted).length, finalFunctional: rows.filter(r => r.finalFunctionalAccepted).length,
    criticalEscapes: sumKnown(rows.map(r => r.escapes?.critical ?? null)),
    otherEscapes: sumKnown(rows.map(r => r.escapes?.other ?? null)),
    regressions: sumKnown(rows.map(r => r.regressions)), correctiveMinutes: sumKnown(rows.map(r => r.correctiveMinutes)),
    fixRounds: sumKnown(rows.map(r => r.fixRounds)),
    humanMissing: rows.filter(r => r.human === null).length,
    humanMinutes: assistance.reduce((total, e) => total + e.minutes, 0),
    humanEvents: Object.fromEntries(design.humanAssistance.categories.map(category => [category,
      Object.fromEntries(design.humanAssistance.necessity.map(necessity => [necessity,
        assistance.filter(e => e.category === category && e.necessity === necessity).length]))])),
    primaryViolations: combine('primary'), unknownApplicability: combine('unknownApplicability'),
    descriptiveConditionalRecurrence: combine('conditionalRecurrence'),
    resources, curationUnits: sumKnown(curation.map(u => u.units)),
    unitsPerAccepted: accepted && usage.length === n ? resources.units.observed / accepted : null,
  };
}

export function reportRun(directory: string) {
  const { id, seal, entries } = readRun(directory);
  const judgeEntries = entries.filter(e => e.kind === 'judge');
  const calibration = judgeEntries.flatMap(e => e.status === 'completed' && e.calibration ? [e.calibration] : []);
  const calibrated = calibrationPassed(seal.golds, calibration, seal.goldArtifactDigests);
  const firstStoppedCell = design.cells.find(cell => {
    const outcome = entries.find(e => e.kind === 'solver' && e.rowId === cell.id);
    return outcome?.kind === 'solver' && (outcome.observation.status !== 'delivered' || !outcome.observation.usage || outcome.observation.invalid === true);
  });
  const stopOrdinal = firstStoppedCell?.ordinal ?? Infinity;
  const rows = seal.rows.map(row => {
    const evidence = entries.filter(e => e.rowId === row.id);
    const result = evidence.find(e => e.kind === row.kind);
    const cell = design.cells.find(c => c.id === row.id);
    const afterStop = firstStoppedCell && (cell ? cell.ordinal > stopOrdinal : row.kind !== 'solver');
    return { ...row, status: !result ? afterStop ? 'not_run_after_stop' : 'not_run'
      : result.kind === 'solver' ? result.observation.status : result.status, evidence };
  });
  const solvers = design.cells.map(cell => {
    const contract = seal.contracts[cell.task];
    const result = entries.find(e => e.kind === 'solver' && e.rowId === cell.id);
    const original = result?.kind === 'solver' ? result.observation : undefined;
    const judgments = design.judgingCells.filter(j => j.cell === cell.id).map(j => {
      const record = judgeEntries.find(e => e.rowId === j.id && e.status === 'completed');
      return record?.judgment && judgeUsageCovered(record.usage) ? record.judgment : null;
    });
    const curatorCell = design.curationCells.find(c => c.afterCell === cell.id);
    const curatorEntry = curatorCell && entries.find(e => e.kind === 'curator' && e.rowId === curatorCell.id && e.status === 'completed');
    const observation = original && { ...original,
      curatorUsage: curatorEntry?.kind === 'curator' ? curatorEntry.usage : undefined,
      invalid: original.invalid === true || (!!curatorCell && curatorEntry?.kind !== 'curator'),
      judgments,
    };
    const metrics = score(observation ?? { status: 'not_run_after_stop' }, contract.requirements, contract.residuals,
      arm(cell).maxSolverSessions, cell.kind === 'learn', calibrated);
    const rates = violationRates(contract.opportunities, observation?.status === 'delivered' ? observation.actions : undefined);
    return { cell, metrics, rates };
  });
  const describe = (selected: typeof solvers) => summarize(selected.map(r => r.metrics), selected.map(r => r.rates));
  const endpoints = Object.fromEntries(Object.keys(design.scoring.endpointDenominators).map(phase => {
    const selected = solvers.filter(({ cell }) => cell.phase === phase || (
      phase === 'M-held-out' && cell.phase === 'M' && cell.kind !== 'learn') || (
      phase === 'M-acquisition' && cell.phase === 'M' && cell.kind === 'learn') || (
      phase === 'P' && cell.phase === 'O' && cell.arm === 'S'));
    return [phase, Object.fromEntries([...new Set(selected.map(r => r.cell.arm))].map(a =>
      [a, describe(selected.filter(r => r.cell.arm === a))]))];
  }));
  const prefixes = [...design.memorySequences, ...design.evolvingCodeSequences].map(sequence => {
    const measure = (tasks: string[]) => sequence.arms.map(a => describe(solvers.filter(({ cell }) =>
      cell.sequence === sequence.id && cell.arm === a && tasks.includes(cell.task))));
    const prefixes = sequence.tasks.map((task, i) => {
      const [control, treatment] = measure(sequence.tasks.slice(0, i + 1));
      return { task, arms: { [sequence.arms[0]]: control, [sequence.arms[1]]: treatment },
        differences: {
          accepted: treatment.accepted - control.accepted,
          autonomous: treatment.autonomous - control.autonomous,
          firstFunctional: treatment.firstFunctional - control.firstFunctional,
          finalFunctional: treatment.finalFunctional - control.finalFunctional,
        } };
    });
    const amortized = sequence.id === 'E1' && prefixes.find(prefix => {
      const a = prefix.arms.EA;
      const r = prefix.arms.ER;
      return a.accepted >= r.accepted && a.criticalEscapes.known === a.intended && r.criticalEscapes.known === r.intended
        && a.criticalEscapes.total <= r.criticalEscapes.total && !a.humanMissing && !r.humanMissing && a.humanMinutes <= r.humanMinutes
        && Object.keys(a.resources).every(key => !a.resources[key].missing && !r.resources[key].missing
          && a.resources[key].observed <= r.resources[key].observed);
    });
    return { id: sequence.id, independentUnit: sequence.independentUnit, prefixes,
      ...(sequence.id === 'E1' ? { amortizationPoint: amortized ? amortized.task : null } : { frozenTransfer: measure(sequence.tasks.slice(2)) }) };
  });
  const drift = entries.flatMap(e => e.kind === 'solver' && e.drift ? [e.drift] : []);
  const solverLedgerRows = entries.filter((e): e is Extract<Entry, { kind: 'solver' }> => e.kind === 'solver').map(e => ({ id: e.rowId }));
  const causalLedgerRows = solverLedgerRows.filter(row => design.ordering.orchestrationBlocks.some(b => b.orderedCells.includes(row.id))
    || design.ordering.productPairedBlocks.some(b => b.orderedCells.includes(row.id)));
  const startRows = entries.filter((e): e is Extract<Entry, { kind: 'start' }> => e.kind === 'start')
    .map(e => ({ id: e.rowId })).filter(row => design.ordering.orchestrationBlocks.some(b => b.orderedCells.includes(row.id))
      || design.ordering.productPairedBlocks.some(b => b.orderedCells.includes(row.id)));
  const chronologyValid = campaignChronologyValid(causalLedgerRows) && campaignChronologyValid(startRows);
  const blocks = [...design.ordering.orchestrationBlocks, ...design.ordering.productPairedBlocks].map(block => ({
    id: block.id, ...(!chronologyValid ? { eligible: false, stop: true, reason: 'Interleaved or reordered campaign solver start ledger' }
      : checkBlock(block.id, drift.filter(r => block.orderedCells.includes(r.id)), solverLedgerRows)),
  }));
  const paired = ['F-S', 'A-F', 'HA-HF', 'P-S'].flatMap(contrast => {
    const [treatment, control] = contrast.split('-');
    return design.tasks.filter(t => t.use.includes('O')).map(task => {
      const left = solvers.find(r => r.cell.arm === treatment && r.cell.task === task.id)!;
      const right = solvers.find(r => r.cell.arm === control && r.cell.task === task.id)!;
      const block = [...design.ordering.orchestrationBlocks, ...design.ordering.productPairedBlocks].find(b =>
        b.orderedCells.includes(left.cell.id) && b.orderedCells.includes(right.cell.id)
          && (contrast === 'P-S' ? b.id.startsWith('PS-') : b.id.startsWith('O-')));
      return { contrast, task: task.id, treatment: left.cell.id, control: right.cell.id,
        causalEligible: block ? blocks.find(b => b.id === block.id)!.eligible : null,
        difference: { accepted: Number(left.metrics.fullyAccepted) - Number(right.metrics.fullyAccepted),
          autonomous: Number(left.metrics.autonomousAccepted) - Number(right.metrics.autonomousAccepted), Q: left.metrics.Q - right.metrics.Q } };
    });
  });
  const judgeUsage = judgeEntries.flatMap(entry => entry.calibration?.usage ?? entry.usage ?? []);
  return {
    id, classification: seal.classification, performanceResults: null,
    intendedSolverRows: design.cells.length, rows, solvers, endpoints, prefixes, blocks, paired,
    judgeResources: { recordedRows: judgeUsage.length, units: judgeUsage.reduce((sum, row) => sum + row.units, 0),
      activeSeconds: judgeUsage.reduce((sum, row) => sum + row.activeSeconds, 0), queueSeconds: judgeUsage.reduce((sum, row) => sum + row.queueSeconds, 0) },
    calibration: calibration.length ? calibrated : null, sharedPreparationCost: null,
  };
}

if (import.meta.main) {
  try {
    const [command, input, extra, context] = process.argv.slice(2);
    const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
    switch (command) {
      case 'validate':
        if (input) {
          const bytes = readFileSync(input);
          validateManifest(JSON.parse(bytes.toString()));
          assert(digest(bytes) === manifestDigest(), 'Manifest bytes differ from the pinned release');
        } else validateManifest(design);
        console.log(json({ manifestDigest: manifestDigest(), plannedTotals: design.plannedTotals }));
        break;
      case 'preflight':
        {
          let refusal: string;
          try { refusal = launchRefusal(input ? read(input) : undefined); }
          catch { refusal = 'G1–G7: malformed gate evidence artifact'; }
          console.log(json({ allowed: false, modelLaunches: 0, refusal: refusal.slice(0, 1000) }));
        }
        process.exitCode = 2;
        break;
      case 'seal':
        {
          const payload = read(extra);
          console.log(sealRun(input, 'harness-only', payload.contracts, payload.golds ?? {}, payload.bindingDigest, payload.requestBindings));
        }
        break;
      case 'append':
        appendRun(input, read(extra));
        break;
      case 'report':
        process.stdout.write(json(reportRun(input)));
        break;
      case 'expand': {
        assert(context, 'A sealed run is required before request expansion');
        const cell = design.cells.find(c => c.id === input);
        const inputs = read(extra) as RequestInputs;
        if (cell?.arm === 'HA') {
          try {
            const request = expandSealedRequest(context, input, inputs);
            process.stdout.write(json({ classification: 'harness-only', routeStatus: 'resolved-from-ledger', request }));
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('route is unresolved')) throw error;
            const request = expandPlannerSealedRequest(context, input, inputs);
            process.stdout.write(json({ classification: 'harness-only', routeStatus: 'unresolved', request }));
          }
          break;
        }
        const request = expandSealedRequest(context, input, inputs);
        process.stdout.write(json({ classification: 'harness-only', request }));
        break;
      }
      default:
        throw new Error('Use validate [manifest], preflight [binding], seal <run> <contracts> [golds], append <run> <event>, report <run> or expand <row> <inputs> [run]');
    }
  } catch (error) {
    console.error(error instanceof Error && !('path' in error) && !(error instanceof SyntaxError) ? error.message.slice(0, 400) : 'Benchmark input or file operation failed');
    process.exitCode = 1;
  }
}
