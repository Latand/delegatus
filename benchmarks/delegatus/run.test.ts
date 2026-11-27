import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import design from './pilot-manifest.json';
import {
  appendRun, checkBlock, digest, expandRequest, expandSealedRequest, gateRefusals, gateRequirements, launchRefusal,
  reportRun, sampleDelivery, sealRun, validateManifest, type Binding, type RequestInputs,
} from './run';
import { calibrationPassed, oracleControls, score, violationRates, type Calibration, type Checks, type Observation, type Requirement } from './score';

const entrypoint = new URL('./run.ts', import.meta.url).pathname;
const manifestFile = new URL('./pilot-manifest.json', import.meta.url);
const task = design.tasks[0].id;
const solver = design.cells[0].id;
const proof = (label: string) => digest(`harness-only:${label}`);
const roots = new Set<string>();
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true });
  roots.clear();
});
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-harness-'));
  roots.add(root);
  return root;
}

test('validates the exact plan and registered denominators', () => {
  expect(validateManifest(structuredClone(design)).plannedTotals.allSubscriptionSessionsMax).toBe(252);
  const changes: [string, (m: typeof design) => void][] = [
    ['cells', m => { [m.cells[0], m.cells[1]] = [m.cells[1], m.cells[0]]; }],
    ['cells', m => { m.cells[0].id = m.cells[1].id; }],
    ['cells', m => { m.cells[1].comparisonControl = m.cells[2].id; }],
    ['cells', m => { m.cells[21].memory = 'Q2-MA-after-L1'; }],
    ['cells', m => { m.cells[30].codeInput = 'sealed-base'; }],
    ['ordering', m => { m.ordering.orchestrationBlocks[0].contrasts[1].maxFirstModelWorkSeparationSeconds++; }],
    ['ordering', m => { m.ordering.productPairDrift.allowInterleavedSolverCell = true; }],
    ['ordering', m => { m.ordering.orchestrationDrift.causalEligibilityOnUnknownOrViolation = true; }],
    ['judgingCells', m => { m.judgingCells.pop(); }],
    ['curationCells', m => { m.curationCells[0].retainForSolver = true; }],
    ['workflows', m => { m.workflows.team.reviewFailEdge.maxRounds = 2; }],
    ['plannedTotals', m => { m.plannedTotals.solverSessionsMax++; }],
    ['scoring', m => { m.scoring.primaryDenominator--; }],
    ['retrospectiveEvidence', m => { m.retrospectiveEvidence.schema.required.pop(); }],
    ['processMeasurement', m => { m.processMeasurement.sharedOpportunityViolations.boundaryCases.arms.MA.primary.denominator--; }],
    ['humanAssistance', m => { m.humanAssistance.categories.pop(); }],
  ];
  for (const [section, edit] of changes) {
    const copy = structuredClone(design);
    edit(copy);
    expect(() => validateManifest(copy)).toThrow(section);
  }
});

const verified = (): Binding => ({
  manifestDigest: digest(readFileSync(manifestFile)),
  gates: Object.fromEntries(Object.entries(gateRequirements).map(([gate, proofs]) => [
    gate, { status: 'verified', proofs: Object.fromEntries(proofs.map(p => [p, proof(p)])) },
  ])),
  independentVerdict: { approved: true, evidenceDigest: proof('synthetic-verdict') },
});

for (const gate of Object.keys(gateRequirements) as (keyof typeof gateRequirements)[]) {
  test(`${gate} missing and malformed proof refuse in a fresh offline process`, () => {
    const b = verified();
    b.gates![gate]!.proofs![gateRequirements[gate][0]] = '';
    expect(gateRefusals(b).map(r => r.gate)).toEqual([gate]);
    delete b.gates![gate];
    const file = join(scratch(), 'binding.json');
    writeFileSync(file, JSON.stringify(b));
    const result = Bun.spawnSync([process.execPath, entrypoint, 'preflight', file], { timeout: 3000 });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout.toString())).toEqual({ allowed: false, modelLaunches: 0, refusal: expect.stringContaining(gate) });
  });
}

test('stale manifest and unresolved private bindings keep the launch closed', () => {
  const b = verified();
  expect(launchRefusal(b)).toContain('launchAllowed is false');
  b.unresolved = ['fixture-binding'];
  expect(launchRefusal(b)).toContain('unresolved static bindings');
  b.manifestDigest = proof('stale');
  expect(gateRefusals(b)).toHaveLength(7);
});

const requestInputs: RequestInputs = {
  repoDir: '/fixture/repo', baseRef: 'a'.repeat(40), src: '/fixture/source', taskIds: ['fixture-task'],
  brief: 'Visible requirements', planner: 'Plan the current task', review: 'Review the submitted tree', fix: 'Apply reviewed findings',
};

test('renders deterministic supported requests with a bounded review graph and no model fallback', () => {
  const request = expandRequest(solver, requestInputs);
  expect(expandRequest(solver, requestInputs)).toEqual(request);
  expect(request.stages.map(s => [s.id, s.next])).toEqual([['solve', 'review'], ['review', null], ['fix', 'review']]);
  expect(request.stages[1]).toMatchObject({ access: 'read-only', onFail: { to: 'fix', maxRounds: 1, onExhausted: 'park' } });
  expect(request).toMatchObject({ publication: 'internal', finishesTask: false, taskIds: ['fixture-task'] });
  expect(request).not.toHaveProperty('env');
  const routed = design.cells.find(c => c.arm === 'HA')!;
  expect(() => expandRequest(routed.id, requestInputs)).toThrow('Missing counted planner route');
  const assigned = expandRequest(routed.id, { ...requestInputs, route: { solve: 'H', fix: 'M' } });
  expect(assigned.stages.map(s => s.engine)).toEqual(['codex', 'claude', 'codex', 'codex']);
  expect(() => expandRequest(design.cells[1].id, requestInputs)).toThrow('Unbound product runtime');
  expect(expandRequest(design.curationCells[0].id, requestInputs).stages[0].role.roleId).toBe('curator');
  expect(expandRequest(design.judgingCells[1].id, requestInputs).stages[0].engine).toBe('claude');
});

test('memory digests, byte limits and matched previous trees fence dependent requests', () => {
  const heldOut = design.cells.filter(c => c.memory === 'Q1-MA-after-L2');
  const bytes = 'synthetic lesson';
  const memory = { id: heldOut[0].memory, bytes, digest: digest(bytes) };
  for (const c of heldOut) {
    expect(expandRequest(c.id, { ...requestInputs, memory }).stages.map(s => s.prompt.includes(bytes))).toEqual([false, true, false, false]);
    expect(() => expandRequest(c.id, { ...requestInputs, memory: { ...memory, bytes: 'changed' } })).toThrow('learned pack');
  }
  const oversized = 'é'.repeat(4097);
  expect(() => expandRequest(heldOut[0].id, { ...requestInputs, memory: { ...memory, bytes: oversized, digest: digest(oversized) } })).toThrow('learned pack');
  const c = design.cells.find(c => c.phase === 'E' && c.step === 1)!;
  const previous = { cellId: c.codeInput!.split(':')[0], commit: requestInputs.baseRef, treeDigest: proof('tree'), delivered: true, matchedPairDelivered: true };
  expect(expandRequest(c.id, { ...requestInputs, previous }).baseRef).toBe(previous.commit);
  expect(() => expandRequest(c.id, { ...requestInputs, previous: { ...previous, matchedPairDelivered: false } })).toThrow('matched E predecessor');
});

test('SDK round trip preserves the full request and treats duplicate and unknown delivery as reconciliation states', async () => {
  const { TOOL_INPUT_SCHEMAS } = await import('../../src/lib/mcp/server');
  const request = expandRequest(solver, requestInputs);
  const responses = [
    { payload: { ok: true, pipelineId: 'fixture-pipeline', clientRequestId: request.clientRequestId }, status: 'accepted' },
    { payload: { ok: true, replayed: true, pipelineId: 'fixture-pipeline', clientRequestId: request.clientRequestId }, status: 'duplicate' },
    { payload: { ok: true, replayed: true, pipelineId: 'fixture-pipeline', clientRequestId: 'other' }, status: 'unknown' },
    { payload: { ok: true, pipelineId: 'fixture-pipeline', clientRequestId: 'other' }, status: 'unknown' },
    { payload: 'truncated', status: 'unknown' },
  ] as const;
  for (const { payload, status } of responses) {
    const [client, server] = InMemoryTransport.createLinkedPair();
    const mcp = new McpServer({ name: 'harness-only', version: '1' });
    const received: unknown[] = [];
    mcp.registerTool('create_pipeline', { inputSchema: TOOL_INPUT_SCHEMAS.create_pipeline }, args => {
      received.push(args);
      return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] };
    });
    await mcp.connect(server);
    try {
      expect((await sampleDelivery(client, request)).status).toBe(status);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject(request);
    } finally { await mcp.close(); }
  }
});

const reqs: Requirement[] = Object.keys(design.scoring.behaviorGroupWeights).map(group => ({
  id: group, group: group as Requirement['group'], critical: group === 'securityPrivacy',
}));
const pass: Checks = Object.fromEntries(reqs.map(r => [r.id, 'pass']));
const residuals = ['evidence'];
const usage = { units: 400, activeSeconds: 20, queueSeconds: 1, sessions: 2 };
const good = (): Observation => ({
  status: 'delivered', first: { timely: true, tree: 'first-tree', checks: { ...pass, core: 'fail' } },
  final: { timely: true, tree: 'final-tree', checks: pass },
  terminalReceipt: 'terminal', cleanupReceipt: 'clean', usage, invalid: false, fixRounds: 1,
  judgments: [{ session: 'blind-a', rating: [3, 3, 2], coverage: residuals }, { session: 'blind-b', rating: [3, 3, 2], coverage: residuals }],
  human: [],
});
const scoreRow = (observation: Observation) => score(observation, reqs, residuals, 4, false, true);

test('scores first and final separately, retains conservative judge bounds and enforces acceptance guards', () => {
  const result = scoreRow(good());
  expect(result).toMatchObject({ fullyAccepted: true, firstFunctionalAccepted: false, finalFunctionalAccepted: true, autonomousAccepted: true });
  expect(result.Q).toBeCloseTo(98.6667, 3);
  expect(scoreRow({ ...good(), usage: undefined }).fullyAccepted).toBe(false);
  expect(scoreRow({ ...good(), status: 'timeout' }).Q).toBe(0);
  expect(scoreRow({ ...good(), usage: { ...usage, units: 128001 } }).Q).toBe(0);
  expect(scoreRow({ ...good(), final: { timely: true, tree: 'x', checks: { ...pass, securityPrivacy: 'fail' } } }).Q).toBe(0);
  const truncated = good();
  truncated.judgments![1]!.truncated = true;
  const limited = scoreRow(truncated);
  expect(limited.fullyAccepted).toBe(false);
  expect(limited.ratings[1]).toBeNull();
  expect(limited.QBounds[1]).toBeGreaterThan(limited.QBounds[0]);
  const dispute = good();
  dispute.judgments![1]!.rating = [2, 3, 2];
  expect(scoreRow(dispute)).toMatchObject({ dispute: true, fullyAccepted: false });
});

test('necessary clarification preserves autonomy and deduplicated defects preserve unknown coverage', () => {
  const input = good();
  input.human = [{ id: 'h', at: 1, actor: 'human', category: 'business-clarification', necessity: 'necessary-business-fact',
    fact: 'batch policy', script: 'sealed-fact', reason: 'requested', minutes: 2, artifact: 'first-tree' }];
  input.findings = [{ defect: 'defect-a', verdict: 'true' }, { defect: 'defect-a', verdict: 'true' }, { defect: 'defect-b', verdict: 'unknown' }];
  input.census = { defects: ['defect-a', 'defect-b'], complete: true };
  expect(scoreRow(input)).toMatchObject({ autonomousAccepted: true, strictGoalOnlyAccepted: false,
    reviewer: { confirmed: 1, unknown: 1, precisionBounds: [0.5, 1], recallBounds: [0.5, 1] } });
  input.human[0].script = null;
  expect(() => scoreRow(input)).toThrow('Unbound clarification');
  input.human[0].category = 'manual-repair';
  expect(scoreRow(input).autonomousAccepted).toBe(false);
  input.human = undefined;
  expect(scoreRow(input).autonomousAccepted).toBe(false);
});

test('calibration rejects red gold promotion and oracle controls require their intended failures', () => {
  const golds = Object.fromEntries(design.judgingCells.filter(j => j.kind === 'calibration').map(j => [j.gold!, j.gold === 'complete' ? [] : ['defect']]));
  const judgments: Calibration[] = design.judgingCells.filter(j => j.kind === 'calibration').map(j => ({
    gold: j.gold!, judge: j.judge as Calibration['judge'], session: j.id, rating: j.gold === 'complete' ? [3, 3, 3] : [2, 2, 2],
    detected: golds[j.gold!], usage: { ...usage, sessions: 1 }, cleanupReceipt: 'stopped',
  }));
  expect(calibrationPassed(golds, judgments)).toBe(true);
  judgments[7].rating = [3, 3, 3];
  expect(calibrationPassed(golds, judgments)).toBe(false);
  const refs: Record<string, Checks> = { correct: pass, unchanged: { core: 'fail' },
    partial: { ...pass, crossCallerRegression: 'fail' }, unsafe: { ...pass, securityPrivacy: 'fail' } };
  const expectedRed = { unchanged: ['core'], partial: ['crossCallerRegression'], unsafe: ['securityPrivacy'] };
  expect(oracleControls(reqs, refs, expectedRed)).toBe(true);
  expect(oracleControls(reqs, { ...refs, partial: pass }, expectedRed)).toBe(false);
  expect(oracleControls(reqs, { ...refs, unsafe: { securityPrivacy: 'missing' } }, expectedRed)).toBe(false);
});

function preflights(id: string) {
  const block = [...design.ordering.orchestrationBlocks, ...design.ordering.productPairedBlocks].find(b => b.id === id)!;
  return block.orderedCells.map((cellId, i) => {
    const snap = (at: number, capacityBudgets: number) => ({
      at, capacityBudgets, quotaStart: 0, quotaEnd: 18000, providerRevision: 'provider-1',
      sharedInputs: proof('sealed-inputs'), roles: {
        review: proof('review-baseline'), solve: proof('solve-baseline'), fix: proof('fix-baseline'),
        ...(cellId.endsWith('-S-r1') ? {} : { planner: proof('planner-baseline') }),
      },
    });
    const checkpoint = Object.fromEntries(design.ordering.instrumentationCheckpoint.continueOnlyAfter.map(key => [key, proof(key)]));
    return { id: cellId, before: snap(i * 1000, 4 - i), firstModelWork: i * 1000 + 100, after: snap(i * 1000 + 200, 3 - i), checkpoint };
  });
}

test('O and P/S admission guards retain unknown and invalid comparisons', () => {
  const rows = preflights('O-export');
  expect(checkBlock('O-export', rows)).toMatchObject({ eligible: true, stop: false });
  expect(checkBlock('O-export', rows.slice(0, 2))).toMatchObject({ eligible: false, stop: false });
  const failures: [(r: typeof rows) => void, string][] = [
    [r => { r[0].before.capacityBudgets = 3; }, 'capacity'],
    [r => { r[1].after.quotaEnd++; }, 'Quota'],
    [r => { r[1].before.providerRevision = ''; }, 'Provider'],
    [r => { r[1].after.roles.review = proof('fallback-model'); }, 'Role runtime'],
    [r => { r[1].after.sharedInputs = proof('changed-inputs'); }, 'Shared inputs'],
    [r => { r[1].checkpoint = {}; }, 'instrumentation checkpoint'],
    [r => { [r[1], r[2]] = [r[2], r[1]]; }, 'Interleaved'],
    [r => { for (const row of r.slice(2)) { row.before.at += 8000; row.firstModelWork += 8000; row.after.at += 8000; } }, 'Block exceeded'],
  ];
  for (const [change, word] of failures) {
    const altered = structuredClone(rows);
    change(altered);
    expect(checkBlock('O-export', altered)).toMatchObject({ eligible: false, stop: true, reason: expect.stringContaining(word) });
  }
  const pair = preflights('PS-archive');
  pair[1].firstModelWork = 3701;
  pair[1].after.at = 3800;
  expect(checkBlock('PS-archive', pair)).toMatchObject({ eligible: false, stop: true, reason: 'Block exceeded first-model-work separation' });
});

const contracts = Object.fromEntries(design.tasks.map(t => [t.id, {
  requirements: reqs, residuals, opportunities: [{ id: t.id, task: t.id, principle: 'boundary', applicability: 'applicable' as const, proof: proof(t.id), version: '1' }],
}]));
const event = (id: string) => ({ id, rowId: solver, evidenceDigest: proof(id) });

test('both held-out requests require the same immutable curator output', () => {
  const dir = join(scratch(), 'run');
  sealRun(dir, 'harness-only', contracts);
  const heldOut = design.cells.filter(c => c.memory === 'Q1-MA-after-L2');
  const curator = design.curationCells.find(c => c.memoryOutput === heldOut[0].memory)!;
  const rowId = curator.id;
  const bytes = 'synthetic frozen pack';
  const memory = { id: heldOut[0].memory, bytes, digest: digest(bytes) };
  expect(() => expandSealedRequest(dir, heldOut[0].id, { ...requestInputs, memory })).toThrow('ledger seal');
  expect(() => appendRun(dir, { ...event('pack'), rowId, kind: 'curator', status: 'completed', packDigest: memory.digest }))
    .toThrow('Missing completed learn artifact');
  const requestKey = `${design.campaign}:${curator.afterCell}`;
  appendRun(dir, { ...event('learn-receipt'), rowId: curator.afterCell, kind: 'receipt', status: 'accepted', requestKey, pipelineId: 'learn-pipeline' });
  appendRun(dir, { ...event('learn-artifact'), rowId: curator.afterCell, kind: 'solver', observation: good() });
  appendRun(dir, { ...event('pack'), rowId, kind: 'curator', status: 'completed', packDigest: memory.digest });
  for (const cell of heldOut) expect(expandSealedRequest(dir, cell.id, { ...requestInputs, memory }).stages[1].prompt).toContain(bytes);
  const replacement = { ...memory, bytes: 'fresh data', digest: digest('fresh data') };
  expect(() => expandSealedRequest(dir, heldOut[1].id, { ...requestInputs, memory: replacement })).toThrow('ledger seal');
});

test('sealed run survives process restart, retains every failed row and allows durable delivery reconciliation only', () => {
  const root = scratch();
  const dir = join(root, 'run');
  sealRun(dir, 'harness-only', contracts);
  expect(() => sealRun(dir, 'harness-only', contracts)).toThrow();
  const requestKey = expandRequest(solver, requestInputs).clientRequestId;
  appendRun(dir, { ...event('lost'), kind: 'receipt', status: 'unknown', requestKey });
  expect(() => appendRun(dir, { ...event('retry'), kind: 'receipt', status: 'accepted', requestKey, pipelineId: 'fixture' })).toThrow('reconciliation');
  appendRun(dir, { ...event('duplicate'), kind: 'receipt', status: 'duplicate', requestKey, pipelineId: 'fixture' });
  appendRun(dir, { ...event('proof'), kind: 'receipt', status: 'reconciled', requestKey, pipelineId: 'fixture' });
  appendRun(dir, { ...event('timeout'), kind: 'solver', observation: { status: 'timeout', reason: 'guard', usage } });
  const replacement = { ...event('new'), kind: 'solver' as const, observation: good() };
  expect(() => appendRun(dir, replacement)).toThrow('outcome already sealed');
  const replay = Bun.spawnSync([process.execPath, entrypoint, 'report', dir], { timeout: 4000 });
  expect(replay.exitCode).toBe(0);
  const report = JSON.parse(replay.stdout.toString());
  expect(report).toMatchObject({ classification: 'harness-only', performanceResults: null, intendedSolverRows: 34 });
  expect(report.rows).toHaveLength(118);
  expect(report.rows[0].status).toBe('timeout');
  expect(report.endpoints.O.S).toMatchObject({ intended: 2, accepted: 0, unitsPerAccepted: null });
  expect(report.endpoints['M-held-out'].MR.primaryViolations).toMatchObject({ denominator: 4, unknown: 4, bounds: [0, 1] });
  expect(report.prefixes[2].prefixes[2].arms.EA.intended).toBe(3);
  unlinkSync(join(dir, '000002.json'));
  expect(() => reportRun(dir)).toThrow('Ledger sequence gap');
});

test('common opportunities retain missing outcomes independently from own-correction recurrence', () => {
  const [item] = contracts[task].opportunities;
  expect(violationRates([item]).primary).toEqual({ numerator: 0, denominator: 1, unknown: 1, bounds: [0, 1] });
  expect(violationRates([item]).conditionalRecurrence).toEqual({ numerator: 0, denominator: 0, unknown: 0, bounds: null });
  const cut = { ...item, id: 'second', principle: 'different', applicability: 'unknown' as const };
  expect(violationRates([item, cut], { [item.id]: { outcome: 'violating', evidence: 'finding', at: 3, priorCorrection: 'prior' } }))
    .toMatchObject({ primary: { numerator: 1, denominator: 1 }, conditionalRecurrence: { numerator: 1, denominator: 1 },
      unknownApplicability: { denominator: 1, unknown: 1 } });
});
