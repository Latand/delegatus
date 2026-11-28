import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
type GateProof = { status: 'verified' | 'failed' | 'unverified'; bindingDigest: string; artifactDigest: string; observationsDigest: string; observations: Record<string, 'pass' | 'fail' | 'unknown'>; artifact: { schemaVersion: 1; classification: 'observed-gate-evidence'; gate: Gate; proof: string; manifestDigest: string; observations: Record<string, 'pass' | 'fail' | 'unknown'>; sourceDigest: string } };
type GateEvidence = { status: 'verified' | 'unresolved'; proofs?: Record<string, GateProof> };
export type Binding = {
  classification: 'observed' | 'harness-only';
  manifestDigest: string;
  gates?: Partial<Record<Gate, GateEvidence>>;
  independentVerdict?: { approved: boolean; artifactDigest: string; bindingDigest: string; observationsDigest: string; observations: Record<string, 'pass' | 'fail' | 'unknown'>; artifact: { schemaVersion: 1; classification: 'independent-gate-review'; manifestDigest: string; observations: Record<string, 'pass' | 'fail' | 'unknown'>; sourceDigest: string } };
  unresolved?: string[];
  taskProjectLinks?: { task: string; taskProject: string; canonicalProject: string; packageProject: string; worktreeProject: string }[];
};
const manifestDigest = () => digest(source('./pilot-manifest.json'));
const PINNED_MANIFEST_DIGEST = '1073e077d7955a21b19655690e3e38801b78d7f3b78004c680b672da81e64abd';

export function verifyManifestPin(bytes: Uint8Array, pin = PINNED_MANIFEST_DIGEST) {
  assert(sha(pin) && digest(bytes) === pin, 'Bundled manifest differs from the reviewed pin');
}

export function gateRefusals(binding?: Binding) {
  const taskKeys = new Set(binding?.taskProjectLinks?.map(link => link?.task));
  const linksValid = binding?.taskProjectLinks?.length === design.tasks.length && taskKeys.size === design.tasks.length
    && design.tasks.every(task => taskKeys.has(task.id))
    && binding!.taskProjectLinks!.every(link => !!link && typeof link === 'object' && !!link.taskProject && link.taskProject === link.canonicalProject
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
        || proof.artifact?.schemaVersion !== 1 || proof.artifact.classification !== 'observed-gate-evidence'
        || proof.artifact.gate !== gate || proof.artifact.proof !== name
        || proof.artifact.manifestDigest !== binding?.manifestDigest
        || !isDeepStrictEqual(proof.artifact.observations, proof.observations) || !sha(proof.artifact.sourceDigest)
        || digest(json(proof.artifact)) !== proof.artifactDigest;
    });
    if (binding?.manifestDigest !== manifestDigest() || evidence?.status !== 'verified' || missing.length
      || (gate === 'G6' && !linksValid)) {
      return [{ gate, missing: missing.length ? missing : gate === 'G6' && !linksValid ? ['thirteen exact task/project links'] : ['verified proof for this manifest'] }];
    }
    return [];
  });
}

export function launchRefusal(binding?: Binding) {
  const gates = gateRefusals(binding);
  if (gates.length) return `${gates[0].gate}: ${gates[0].missing.join(', ')}`;
  if (binding?.unresolved?.length) return 'G1–G7: unresolved static bindings';
  const verdict = binding?.independentVerdict;
  if (!verdict?.approved || verdict.bindingDigest !== binding?.manifestDigest || !sha(verdict.artifactDigest)
    || !sha(verdict.observationsDigest) || !Object.keys(verdict.observations ?? {}).length
    || Object.values(verdict.observations).some(value => value !== 'pass')
    || digest(json(verdict.observations)) !== verdict.observationsDigest || verdict.artifact?.schemaVersion !== 1
    || verdict.artifact.classification !== 'independent-gate-review' || verdict.artifact.manifestDigest !== binding?.manifestDigest
    || !isDeepStrictEqual(verdict.artifact.observations, verdict.observations) || !sha(verdict.artifact.sourceDigest)
    || digest(json(verdict.artifact)) !== verdict.artifactDigest) return 'G1–G7: independent verification required';
  return 'G1–G7: manifest launchAllowed is false; offline driver';
}

export type RequestInputs = {
  repoDir: string; baseRef: string; src: string; taskIds: string[];
  brief: string; review: string; fix: string; planner?: string;
  roles?: Partial<Record<'planner' | 'solve' | 'review' | 'fix', Runtime>>;
  route?: { solve: 'M' | 'H'; fix: 'M' | 'H'; plannerCellId: string; plannerPipelineId: string; plannerSessionId: string; outputDigest: string; completed: boolean };
  memory?: { id: string; bytes: string; digest: string };
  fixtureDigest: string; promptDigest: string; taskDigest: string; runtimeDigest: string; dependencyDigest: string;
  bindingDigest: string;
  previous?: { cellId: string; commit: string; treeDigest: string; delivered: boolean; matchedPairDelivered: boolean };
};

export function expandRequest(id: string, inputs: RequestInputs) {
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
    const planned = cell.arm !== 'S';
    if (cell.arm === 'HA') {
      const route = inputs.route;
      assert(route && route.completed === true && route.plannerCellId === cell.id && route.plannerPipelineId && route.plannerSessionId
        && sha(route.outputDigest) && ['M', 'H'].includes(route.solve) && ['M', 'H'].includes(route.fix), 'Missing counted planner route receipt');
    }
    const forRole = (role: 'planner' | 'solve' | 'review' | 'fix') => {
      if (cell.arm === 'P') {
        const selected = inputs.roles?.[role];
        assert(selected && ['codex', 'claude'].includes(selected.engine) && selected.model && selected.effort, 'Unbound product runtime');
        return selected;
      }
      const selectable = role === 'solve' || role === 'fix';
      return runtime(selectable && cell.arm === 'HF' ? 'H' : selectable && cell.arm === 'HA' ? inputs.route![role] : 'M');
    };
    if (planned) stages.push(stage('planner', 'architect', forRole('planner'), inputs.planner ?? '', 'solve', 'read-only'));
    stages.push(
      stage('solve', 'builder', forRole('solve'), [inputs.brief, memory?.bytes].filter(Boolean).join('\n\n'), 'review', 'read-write'),
      { ...stage('review', 'reviewer', forRole('review'), inputs.review, null, 'read-only'), onFail: { ...design.workflows.team.reviewFailEdge } },
      stage('fix', 'builder', forRole('fix'), inputs.fix, 'review', 'read-write'),
    );
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
  runtimeBindings?: Record<string, { declared: 'M' | 'H'; requested: Runtime; resolved: Runtime }>;
};
type DriftRecord = {
  id: string; before: DriftSnapshot; after: DriftSnapshot; firstModelWork: number;
  checkpoint?: Record<string, string>;
};

export function checkBlock(blockId: string, rows: DriftRecord[]) {
  const orchestration = design.ordering.orchestrationBlocks.find(b => b.id === blockId);
  const product = design.ordering.productPairedBlocks.find(b => b.id === blockId);
  const block = orchestration ?? product;
  assert(block, 'Unknown drift block');
  const fail = (reason: string) => ({ eligible: false, stop: true, reason });
  if (rows.length > block.orderedCells.length || rows.some((row, i) => row.id !== block.orderedCells[i])) return fail('Interleaved or reordered solver');
  const initial = rows[0]?.before;
  if (!initial) return fail('Missing block preflight');
  const roles = new Map<string, string>();
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
        const declared = design.runtimePool[binding.declared];
        const expectedProfile = { engine: declared.engine, model: declared.model, effort: declared.effort };
        if (!isDeepStrictEqual(binding.requested, expectedProfile) || !isDeepStrictEqual(binding.resolved, expectedProfile)) {
          return fail('Requested or resolved runtime differs from declared model binding');
        }
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
  const expectedRows = [...design.ordering.orchestrationBlocks, ...design.ordering.productPairedBlocks]
    .flatMap(block => block.orderedCells).sort((a, b) => design.cells.find(c => c.id === a)!.ordinal - design.cells.find(c => c.id === b)!.ordinal);
  return rows.length === expectedRows.length && rows.every((row, index) => row.id === expectedRows[index]);
}

type Contract = { requirements: Requirement[]; residuals: string[]; opportunities: Opportunity[]; predecessors?: string[] };
type Seal = {
  schemaVersion: number;
  classification: 'harness-only';
  sources: Record<string, string>;
  rows: { id: string; kind: 'solver' | 'curator' | 'judge' }[];
  contracts: Record<string, Contract>;
  golds: Record<string, string[]>;
  bindingDigest: string;
  requestBindings: Record<string, string>;
};
type Entry = {
  id: string;
  rowId: string;
  evidenceDigest: string;
} & (
  | { kind: 'receipt'; status: 'accepted' | 'unknown' | 'duplicate' | 'reconciled'; requestKey: string; pipelineId?: string }
  | { kind: 'solver'; observation: Observation; drift?: DriftRecord }
  | { kind: 'curator'; status: 'completed' | 'failed' | 'not_run_after_stop'; usage?: Observation['usage']; packDigest?: string; queuedAt?: number; deadlineAt?: number; completedAt?: number; deliveredArtifactDigest?: string }
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

const checkpointName = (index: number) => `checkpoint-${String(index).padStart(6, '0')}.json`;
const checkpointBody = (index: number, count: number, headDigest: string, previous: string) => ({ index, count, digest: headDigest, previous });

export function sealRun(directory: string, classification: 'harness-only', contracts: Record<string, Contract>,
  golds: Record<string, string[]> = {}, bindingDigest?: string, requestBindings?: Record<string, string>) {
  validateManifest(design);
  assert(classification === 'harness-only' && sha(bindingDigest), 'Missing sealed treatment binding');
  expected(Object.keys(requestBindings ?? {}).sort(), intendedRows().map(row => row.id).sort(), 'sealed request bindings');
  assert(Object.values(requestBindings!).every(sha), 'Invalid request input digest');
  expected(Object.keys(contracts).sort(), design.tasks.map(t => t.id).sort(), 'sealed contracts');
  if (Object.keys(golds).length) {
    expected(Object.keys(golds).sort(), [...new Set(design.judgingCells.flatMap(j => j.gold ? [j.gold] : []))].sort(), 'judge golds');
    assert(Object.values(golds).every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && id)), 'Invalid gold defect registry');
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
    }
  }
  mkdirSync(directory, { mode: 0o700 });
  const seal: Seal = { schemaVersion: design.schemaVersion, classification, sources: sourceDigests(), rows: intendedRows(), contracts, golds, bindingDigest, requestBindings: requestBindings! };
  const id = digest(json(seal));
  publishFile(directory, 'seal.json', { id, seal });
  const checkpoint = checkpointBody(0, 0, id, id);
  publishFile(directory, checkpointName(0), { ...checkpoint, id: digest(json(checkpoint)) });
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
  let previous = id;
  const entries: Entry[] = [];
  const names = readdirSync(directory).filter(n => /^\d{6}\.json$/.test(n)).sort();
  for (const [index, name] of names.entries()) {
    assert(name === eventName(index + 1), 'Ledger sequence gap');
    const data = readFileSync(join(directory, name));
    const record = JSON.parse(data.toString()) as LedgerRecord;
    assert(record.previous === previous, 'Ledger predecessor changed');
    validateEntry(seal, entries, record.entry);
    entries.push(record.entry);
    previous = digest(data);
  }
  const checkpoints = readdirSync(directory).filter(n => /^checkpoint-\d{6}\.json$/.test(n)).sort();
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
  return { id, seal, entries, previous };
}

const eventName = (index: number) => `${String(index).padStart(6, '0')}.json`;

function validateEntry(seal: Seal, entries: Entry[], entry: Entry) {
  const row = seal.rows.find(r => r.id === entry.rowId);
  assert(row && entry.id && sha(entry.evidenceDigest), 'Unbound row or evidence');
  assert(!entries.some(e => e.id === entry.id), 'Duplicate ledger event');
  const history = entries.filter(e => e.rowId === entry.rowId);
  if (entry.kind === 'receipt') {
    assert(entry.requestKey === `${design.campaign}:${entry.rowId}`, 'Changed request key');
    assert(['accepted', 'unknown', 'duplicate', 'reconciled'].includes(entry.status), 'Invalid receipt status');
    const previous = history.filter(e => e.kind === 'receipt');
    const confirmed = previous.find(e => e.status === 'accepted' || e.status === 'reconciled');
    assert(!confirmed || (entry.status === 'duplicate' && confirmed.pipelineId === entry.pipelineId), 'Conflicting durable delivery');
    assert(entry.status !== 'accepted' || previous.length === 0, 'Use durable reconciliation after unknown delivery');
    assert(entry.status !== 'reconciled' || previous.length && !confirmed, 'Unexpected reconciliation');
    assert(!['accepted', 'reconciled'].includes(entry.status) || entry.pipelineId, 'Missing durable pipeline identity');
    return;
  }
  assert(!history.some(e => e.kind === entry.kind), 'Row outcome already sealed');
  assert(row.kind === entry.kind, 'Wrong row kind');
  if (entry.kind === 'solver') {
    const cell = design.cells.find(c => c.id === row.id)!;
    const observation = entry.observation;
    assert(['delivered', 'timeout', 'infrastructure_failure', 'blocked', 'not_run_after_stop', 'undelivered'].includes(observation.status), 'Invalid solver outcome');
    assert(observation.status === 'delivered' || observation.reason, 'Missing failure reason');
    if (observation.status === 'delivered') {
      assert(history.some(e => e.kind === 'receipt' && ['accepted', 'reconciled'].includes(e.status)), 'Missing durable solver receipt');
    }
    const contract = seal.contracts[cell.task];
    if (observation.status === 'delivered' && cell.phase === 'E' && cell.step! > 0) {
      const required = contract.predecessors ?? [];
      assert(required.length === cell.step && new Set(required).size === required.length, 'E cumulative predecessor contract is missing');
      for (const predecessor of required) {
        const prior = seal.contracts[predecessor];
          const oracle = observation.predecessorOracles?.[predecessor];
          assert(prior && observation.final?.tree && oracle && sha(oracle.evidenceDigest)
            && oracle.treeDigest === digest(observation.final.tree)
            && prior.requirements.every(r => oracle.checks[r.id] === 'pass')
            && Object.keys(oracle.checks).length === prior.requirements.length, `E predecessor oracle regressed: ${predecessor}`);
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
      assert(entry.usage && entry.usage.sessions === 1 && Number.isSafeInteger(entry.queuedAt)
        && Number.isSafeInteger(entry.deadlineAt) && Number.isSafeInteger(entry.completedAt)
        && entry.queuedAt! <= entry.completedAt! && entry.completedAt! <= entry.deadlineAt!
        && sha(entry.deliveredArtifactDigest), 'Curator missed or lacks its registered queue deadline or artifact receipt');
      const learned = entries.find(e => e.kind === 'solver' && e.rowId === curator.afterCell);
      assert(learned?.kind === 'solver' && learned.observation.status === 'delivered'
        && learned.observation.final?.tree && learned.observation.cleanupReceipt
        && entry.deliveredArtifactDigest === digest(learned.observation.final.tree), 'Missing completed learn artifact');
    }
    if (entry.kind === 'judge' && entry.status === 'completed') {
      const judge = design.judgingCells.find(j => j.id === entry.rowId)!;
      if (judge.kind === 'calibration') {
        assert(entry.calibration?.gold === judge.gold && entry.calibration?.judge === judge.judge && !entry.judgment, 'Calibration identity mismatch');
      } else {
        assert(!entry.calibration && entry.judgment, 'Missing score judgment');
        const goldResults = entries.flatMap(e => e.kind === 'judge' && e.status === 'completed' && e.calibration ? [e.calibration] : []);
        assert(calibrationPassed(seal.golds, goldResults), 'Calibration did not pass');
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
  validateEntry(seal, entries, entry);
  // The exclusive link claims the next sequence number. A concurrent writer
  // must reread the winner before proposing another event.
  const name = eventName(entries.length + 1);
  publishFile(directory, name, { previous, entry });
  const bytes = readFileSync(join(directory, name));
  const checkpointIndex = entries.length + 1;
  const prior = JSON.parse(readFileSync(join(directory, checkpointName(entries.length)), 'utf8')) as { id: string };
  const body = checkpointBody(checkpointIndex, checkpointIndex, digest(bytes), prior.id);
  publishFile(directory, checkpointName(checkpointIndex), { ...body, id: digest(json(body)) });
}

export function expandSealedRequest(directory: string, id: string, inputs: RequestInputs) {
  const { entries, seal } = readRun(directory);
  assert(inputs.bindingDigest === seal.bindingDigest && seal.requestBindings[id] === digest(json(inputs)), 'Request treatment inputs differ from the sealed row binding');
  const cell = design.cells.find(c => c.id === id);
  if (cell && (cell.phase === 'O' || cell.phase === 'P')) {
    const scheduled = [...design.ordering.orchestrationBlocks, ...design.ordering.productPairedBlocks]
      .flatMap(block => block.orderedCells).sort((a, b) => design.cells.find(c => c.id === a)!.ordinal - design.cells.find(c => c.id === b)!.ordinal);
    const targetIndex = scheduled.indexOf(cell.id);
    if (targetIndex >= 0) {
      const priorIds = scheduled.slice(0, targetIndex);
      const prior = priorIds.map(priorId => entries.find(e => e.kind === 'solver' && e.rowId === priorId));
      assert(prior.every(e => e?.kind === 'solver' && e.drift?.id === e.rowId), 'Missing scheduled solver start evidence before admission');
      const priorDrift = prior.flatMap(e => e?.kind === 'solver' && e.drift ? [e.drift] : []);
      for (const block of [...design.ordering.orchestrationBlocks, ...design.ordering.productPairedBlocks]) {
        const blockRows = priorDrift.filter(row => block.orderedCells.includes(row.id));
        if (blockRows.length) assert(!checkBlock(block.id, blockRows).stop, `Causal admission stopped at ${block.id}`);
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
  return expandRequest(id, inputs);
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
  const calibrated = calibrationPassed(seal.golds, calibration);
  const rows = seal.rows.map(row => {
    const evidence = entries.filter(e => e.rowId === row.id);
    const result = evidence.find(e => e.kind === row.kind);
    return { ...row, status: !result ? 'not_run' : result.kind === 'solver' ? result.observation.status : result.status, evidence };
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
  const chronologicalDrift = drift;
  const chronologyValid = campaignChronologyValid(chronologicalDrift);
  const blocks = [...design.ordering.orchestrationBlocks, ...design.ordering.productPairedBlocks].map(block => ({
    id: block.id, ...(!chronologyValid ? { eligible: false, stop: true, reason: 'Interleaved or reordered campaign solver start ledger' }
      : checkBlock(block.id, drift.filter(r => block.orderedCells.includes(r.id)))),
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
        console.log(json({ allowed: false, modelLaunches: 0, refusal: launchRefusal(input ? read(input) : undefined) }));
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
        const request = expandSealedRequest(context, input, read(extra));
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
