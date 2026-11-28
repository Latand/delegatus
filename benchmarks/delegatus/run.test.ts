import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import design from './pilot-manifest.json';
import {
  appendRun, campaignChronologyValid, checkBlock, digest, expandPlannerRequest, expandPlannerSealedRequest, expandRequest, expandSealedRequest, gateRefusals, gateRequirements, launchRefusal, sealedInputDigest,
  reportRun, sampleDelivery, sealRun, validateManifest, verifyManifestPin, type Binding, type Contract, type RequestInputs,
} from './run';
import { calibrationPassed, oracleControls, score, violationRates, type Calibration, type Checks, type Observation, type Requirement } from './score';

const entrypoint = new URL('./run.ts', import.meta.url).pathname;
const manifestFile = new URL('./pilot-manifest.json', import.meta.url);
const task = design.tasks[0].id;
const solver = design.cells[0].id;
const proof = (label: string) => digest(`harness-only:${label}`);
const BINDING = proof('sealed-binding');
const oracleCommand = (taskId: string) => proof(`oracle-command:${taskId}`);
const oracleEvidence = (taskId: string, tree: string, checks: Checks) => {
  const record = { schemaVersion: 1, classification: 'oracle-run-result', taskId, treeDigest: digest(tree),
    commandDigest: oracleCommand(taskId), exitCode: 0, checks };
  const bytes = JSON.stringify(record) + '\n';
  const path = join(scratch(), `oracle-${taskId}-${digest(bytes).slice(0, 8)}.json`);
  writeFileSync(path, bytes, { mode: 0o600 });
  const evidenceDigest = digest(bytes);
  return { treeDigest: digest(tree), commandDigest: oracleCommand(taskId), exitCode: 0,
    evidence: { path, digest: evidenceDigest }, evidenceDigest, checks };
};
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
    ['scoring', m => { m.scoring.fullyAccepted.requiredTrue.pop(); }],
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

test('bundled manifest is checked against an independent reviewed digest in the normal CLI', () => {
  const bytes = readFileSync(manifestFile);
  verifyManifestPin(bytes);
  expect(() => verifyManifestPin(Buffer.from(bytes.toString().replace('"solverOrder": "', '"solverOrder": "mutated-')))).toThrow('reviewed pin');
  const copy = scratch();
  mkdirSync(join(copy, 'benchmarks/delegatus'), { recursive: true });
  symlinkSync(new URL('../../node_modules', import.meta.url).pathname, join(copy, 'node_modules'));
  copyFileSync(new URL('./run.ts', import.meta.url), join(copy, 'benchmarks/delegatus/run.ts'));
  copyFileSync(new URL('./score.ts', import.meta.url), join(copy, 'benchmarks/delegatus/score.ts'));
  writeFileSync(join(copy, 'benchmarks/delegatus/pilot-manifest.json'), bytes.toString().replace('"solverOrder": "', '"solverOrder": "mutated-'));
  const result = Bun.spawnSync([process.execPath, join(copy, 'benchmarks/delegatus/run.ts'), 'validate'], { timeout: 3000 });
  expect(result.exitCode).not.toBe(0);
});

const selfAttested = () => {
  const manifestDigest = digest(readFileSync(manifestFile));
  const gates = Object.fromEntries(Object.entries(gateRequirements).map(([gate, proofs]) => [
    gate, { status: 'verified', proofs: Object.fromEntries(proofs.map(p => {
      const observations = Object.fromEntries(proofs.map(name => [name, 'pass' as const]));
      const path = join(scratch(), `${gate}-${p}.json`);
      const checkedBindingDigest = proof(`checked:${gate}:${p}`);
      const observationId = `synthetic-observation-${gate}-${p}`;
      const sourceDigest = proof(`source:${gate}:${p}`);
      const result = { gate, proof: p, manifestDigest, checkedBindingDigest, observationId, sourceDigest, outcome: 'pass' };
      const evidence = { schemaVersion: 1, classification: 'observed-gate-evidence', gate, proof: p, manifestDigest,
        checkedBindingDigest, observationId, sourceDigest, observations, result,
        ...(gate === 'G6' && p === 'thirteen-package-and-worktree-links'
          ? { taskProjectLinks: design.tasks.map(task => ({ task: task.id, taskProject: 'canonical', canonicalProject: 'canonical', packageProject: 'canonical', worktreeProject: 'canonical' })) }
          : {}) };
      writeFileSync(path, JSON.stringify(evidence) + '\n', { mode: 0o600 });
      const artifact = { schemaVersion: 1 as const, classification: 'observed-gate-evidence' as const, gate: gate as keyof typeof gateRequirements,
        proof: p, manifestDigest, checkedBindingDigest, observationId, sourceDigest, observations, evidence: { path, digest: digest(readFileSync(path)) } };
      return [p, { status: 'verified' as const, bindingDigest: manifestDigest, checkedBindingDigest, observationId, sourceDigest,
        artifactDigest: digest(JSON.stringify(artifact) + '\n'), observations,
        observationsDigest: digest(JSON.stringify(observations) + '\n'), artifact }];
    })) },
  ]));
  const gateEvidenceDigests = Object.fromEntries(Object.entries(gates ?? {}).map(([gate, evidence]) => [gate,
    digest(JSON.stringify(Object.fromEntries(Object.entries(evidence?.proofs ?? {}).map(([name, p]) => [name, p.artifactDigest]).sort(([a], [b]) => a.localeCompare(b)))) + '\n')]));
  return {
  classification: 'harness-only' as Binding['classification'],
  manifestDigest,
  gates,
  independentVerdict: (() => { const observations = Object.fromEntries(Object.keys(gateRequirements).map(g => [g, 'pass' as const]));
    const path = join(scratch(), 'review.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, classification: 'independent-gate-review', manifestDigest, observations, gateEvidenceDigests,
      result: { manifestDigest, gateEvidenceDigests, observations, approved: true } }) + '\n', { mode: 0o600 });
    const artifact = { schemaVersion: 1 as const, classification: 'independent-gate-review' as const, manifestDigest, observations, gateEvidenceDigests,
      evidence: { path, digest: digest(readFileSync(path)) } };
    return { approved: true, artifactDigest: digest(JSON.stringify(artifact) + '\n'), bindingDigest: manifestDigest,
      observations, gateEvidenceDigests, observationsDigest: digest(JSON.stringify(observations) + '\n'), artifact };
  })(),
  taskProjectLinks: design.tasks.map(task => ({ task: task.id, taskProject: 'canonical', canonicalProject: 'canonical', packageProject: 'canonical', worktreeProject: 'canonical' })),
  };
};

const missingGateResults = Object.entries(gateRequirements).map(([gate, missing]) => ({ gate, missing }));

function privateJson(path: string, value: unknown) {
  const bytes = JSON.stringify(value) + '\n';
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, digest: digest(bytes) };
}

function preflight(file?: string, env = process.env) {
  const result = Bun.spawnSync([process.execPath, entrypoint, 'preflight', ...(file ? [file] : [])], { env, timeout: 5000 });
  expect(result.exitCode).toBe(2);
  const output = JSON.parse(result.stdout.toString());
  expect(output).toMatchObject({ allowed: false, modelLaunches: 0 });
  return output.refusal as string;
}

test('all 24 missing results refuse across all seven gates', async () => {
  expect(await gateRefusals()).toEqual(missingGateResults);
  expect(missingGateResults.flatMap(row => row.missing)).toHaveLength(24);
  const refusal = preflight();
  for (const { gate, missing } of missingGateResults) {
    expect(refusal).toContain(`${gate}: ${missing.join(', ')}`);
  }
});

test('changing only the classification of self-attested gates and review refuses', async () => {
  const binding = selfAttested();
  expect(await gateRefusals(binding)).toEqual(missingGateResults);
  binding.classification = 'observed';
  expect(await gateRefusals(binding)).toEqual(missingGateResults);
  expect(preflight(privateJson(join(scratch(), 'binding.json'), binding).path)).toBe(await launchRefusal());
});

test('unresolved private bindings keep the launch closed', async () => {
  expect(await launchRefusal({ classification: 'observed', manifestDigest: proof('stale'), unresolved: ['fixture-binding'] }))
    .toContain('Unresolved static bindings');
});

test('persisted G6 receipts must match real task, namespace, and worktree reads', async () => {
  const root = scratch();
  const state = join(root, 'state');
  mkdirSync(state);
  const env = { ...process.env, TMPDIR: root, LLV_STATE_DIR: state };
  const exec = (cmd: string[]) => {
    const result = Bun.spawnSync(cmd, { env, timeout: 5000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `Fixture command exit ${result.exitCode}`);
    return result.stdout.toString();
  };
  const origin = 'https://example.invalid/benchmark/namespace.git';
  const otherOrigin = 'https://example.invalid/benchmark/unrelated.git';
  const git = (dir: string, ...args: string[]) => exec(['git', '-C', dir, '-c', 'core.hooksPath=/dev/null', ...args]);
  const repo = (name: string, remote: string) => {
    const dir = join(root, name);
    mkdirSync(dir);
    git(dir, 'init', '-q', '--initial-branch=main');
    git(dir, 'remote', 'add', 'origin', remote);
    return dir;
  };
  const parentRepoDir = repo('parent', origin);
  const wrongRepoDir = repo('wrong-project', otherOrigin);
  const packages = design.tasks.map(({ id }) => {
    const repoDir = repo(id, origin);
    const worktreeDir = join(root, `${id}-checkout`);
    git(repoDir, '-c', 'user.name=Benchmark', '-c', 'user.email=noreply', 'commit', '--allow-empty', '-qm', 'Fixture base');
    git(repoDir, 'worktree', 'add', '--quiet', '--detach', worktreeDir);
    return { task: id, repoDir, worktreeDir };
  });
  const taskIds = ['fixture-seat-task'];
  const seed = (dir: string, ids: string[]) => exec([process.execPath, '-e', `
    import { projectForCwd } from './src/lib/scanner/describe';
    import { saveTasks } from './src/lib/tasks/store';
    const [dir, ...ids] = process.argv.slice(1);
    const at = '2026-01-01T00:00:00.000Z';
    saveTasks(ids.map(id => ({ id, project: projectForCwd(dir), status: 'inbox',
      text: 'Fixture task', placement: 'unplaced', assignments: [], createdAt: at, updatedAt: at })));
  `, dir, ...ids]);
  seed(parentRepoDir, taskIds);
  const binding: Binding = { classification: 'observed', manifestDigest: digest(readFileSync(manifestFile)),
    taskLinks: { src: 'fixture-conversation', taskIds, parentRepoDir, packages } };
  const file = join(root, 'binding.json');
  const links = 'thirteen-package-and-worktree-links';
  const controls = 'wrong-project-missing-task-controls';
  const allMissing = await launchRefusal();
  const checks = () => JSON.parse(exec([process.execPath, entrypoint, 'check-task-links', privateJson(file, binding).path]));
  const refusal = () => preflight(privateJson(file, binding).path, env);
  const checked = checks();
  expect(checked[links].passed).toBe(true);
  expect(checked[links].observations.links).toHaveLength(13);
  expect(checked[controls]).toMatchObject({ passed: true, observations: {
    wrongProject: 'task project does not match pipeline project: fixture-seat-task',
    missingTask: 'task not found: benchmark-missing-task-control',
  } });
  const receipts = {
    [links]: privateJson(join(root, 'links.json'), checked[links]),
    [controls]: privateJson(join(root, 'controls.json'), checked[controls]),
  };
  binding.gateResults = receipts;
  expect(refusal()).toContain('G6: current-seat-visible-lineage; G7:');

  binding.classification = 'harness-only';
  expect(refusal()).toBe(allMissing);
  binding.classification = 'observed';
  binding.taskLinks!.src = 'different-conversation';
  expect(refusal()).toBe(allMissing);
  binding.taskLinks!.src = 'fixture-conversation';
  binding.manifestDigest = proof('stale-manifest');
  expect(refusal()).toBe(allMissing);
  binding.manifestDigest = digest(readFileSync(manifestFile));

  const fabricated = structuredClone(checked[links]);
  fabricated.readers = [];
  binding.gateResults = { ...receipts, [links]: privateJson(join(root, 'lookalike.json'), fabricated) };
  expect(refusal()).toContain(`G6: ${links}, current-seat-visible-lineage;`);
  binding.gateResults = { ...receipts, [links]: { ...receipts[links], digest: proof('wrong-content') } };
  expect(refusal()).toContain(`G6: ${links}, current-seat-visible-lineage;`);
  binding.gateResults = { ...receipts, [links]: privateJson(join(root, 'control-copy.json'), checked[controls]) };
  expect(refusal()).toContain(`G6: ${links}, current-seat-visible-lineage;`);
  binding.gateResults = { ...receipts, [links]: undefined };
  expect(refusal()).toContain(`G6: ${links}, current-seat-visible-lineage;`);
  binding.gateResults = { ...receipts, 'current-seat-visible-lineage': receipts[links] };
  expect(refusal()).toContain('G6: current-seat-visible-lineage; G7:');
  binding.gateResults = receipts;

  binding.taskLinks!.packages[0].worktreeDir = repo('same-namespace-lookalike', origin);
  expect(checks()[links].observations.links[0]).toMatchObject({
    worktree: false, worktreeTaskError: null,
  });
  expect(refusal()).toBe(allMissing);
  binding.taskLinks!.packages[0].worktreeDir = join(root, `${task}-checkout`);

  git(packages[0].repoDir, 'remote', 'set-url', 'origin', otherOrigin);
  const failed = checks();
  expect(failed[links].passed).toBe(false);
  expect(failed[links].observations.links[0].packageTaskError).toBe('task project does not match pipeline project: fixture-seat-task');
  binding.gateResults = { ...receipts, [links]: privateJson(join(root, 'failed.json'), failed[links]) };
  expect(refusal()).toContain(`G6: ${links}, current-seat-visible-lineage;`);
  failed[links].passed = true;
  binding.gateResults = { ...receipts, [links]: privateJson(join(root, 'forged-pass.json'), failed[links]) };
  expect(refusal()).toContain(`G6: ${links}, current-seat-visible-lineage;`);
  git(packages[0].repoDir, 'remote', 'set-url', 'origin', origin);

  seed(wrongRepoDir, taskIds);
  expect(refusal()).toBe(allMissing);
  seed(parentRepoDir, []);
  expect(checks()[links].observations.links[0].packageTaskError).toBe('task not found: fixture-seat-task');
  expect(refusal()).toBe(allMissing);
}, 30_000);

const requestInputs: RequestInputs = {
  repoDir: '/fixture/repo', baseRef: 'a'.repeat(40), src: '/fixture/source', taskIds: ['fixture-task'],
  brief: 'Visible requirements', planner: 'Plan the current task', review: 'Review the submitted tree', fix: 'Apply reviewed findings',
  fixtureDigest: proof('fixture'), promptDigest: proof('prompt'), taskDigest: proof('task'), runtimeDigest: proof('runtime'), dependencyDigest: proof('dependencies'), bindingDigest: BINDING,
};
const requestBinding = (id: string, inputs: RequestInputs) => sealedInputDigest(id, inputs);
const bindings = (overrides: Record<string, RequestInputs> = {}) => Object.fromEntries([
  ...design.cells.map(c => [c.id, overrides[c.id] ?? requestInputs]),
  ...design.curationCells.map(c => [c.id, overrides[c.id] ?? requestInputs]),
  ...design.judgingCells.map(c => [c.id, overrides[c.id] ?? requestInputs]),
].map(([id, inputs]) => [id, requestBinding(id as string, inputs as RequestInputs)]));

test('renders deterministic supported requests with a bounded review graph and no model fallback', () => {
  const request = expandRequest(solver, requestInputs);
  expect(expandRequest(solver, requestInputs)).toEqual(request);
  expect(request.stages.map(s => [s.id, s.next])).toEqual([['solve', 'review'], ['review', null], ['fix', 'review']]);
  expect(request.stages[1]).toMatchObject({ access: 'read-only', onFail: { to: 'fix', maxRounds: 1, onExhausted: 'park' } });
  expect(request).toMatchObject({ publication: 'internal', finishesTask: false, taskIds: ['fixture-task'] });
  expect(request).not.toHaveProperty('env');
  const routed = design.cells.find(c => c.arm === 'HA')!;
  expect(() => expandRequest(routed.id, requestInputs)).toThrow('durable planner ledger event');
  const planner = expandPlannerRequest(routed.id, requestInputs);
  expect(planner.clientRequestId).toBe(`${design.campaign}:${routed.id}:planner`);
  expect(planner.stages.map(s => [s.id, s.next, s.engine])).toEqual([['planner', null, 'codex']]);
  const dir = join(scratch(), 'planner-run');
  sealRun(dir, 'harness-only', contracts, {}, BINDING, bindings());
  expect(() => expandSealedRequest(dir, routed.id, requestInputs)).toThrow('Admission stopped');
  appendScheduledPrefix(dir, routed.id);
  appendRun(dir, { ...event('planner-preflight'), rowId: routed.id, kind: 'preflight',
    snapshot: preflights('O-export')[0]!.before });
  expect(expandPlannerSealedRequest(dir, routed.id, requestInputs).stages).toHaveLength(1);
  expect(() => expandSealedRequest(dir, routed.id, requestInputs)).toThrow('route is unresolved');
  const output = JSON.stringify({ solve: 'H', fix: 'M' });
  const plannerResult = { schemaVersion: 1, classification: 'planner-terminal-result', pipelineId: 'planner-pipeline', sessionId: 'planner-session',
    stageId: 'planner', terminalReceipt: proof('planner-terminal'), cleanupReceipt: proof('planner-cleanup'),
    usage: { ...usage, sessions: 1 }, output, outputDigest: digest(output) };
  const plannerResultPath = join(scratch(), 'planner-result.json');
  writeFileSync(plannerResultPath, JSON.stringify(plannerResult) + '\n', { mode: 0o600 });
  const route = { solve: 'H' as const, fix: 'M' as const, plannerCellId: routed.id, plannerPipelineId: 'planner-pipeline',
    plannerSessionId: 'planner-session', terminalStageId: 'planner' as const, terminalReceipt: proof('planner-terminal'),
    cleanupReceipt: proof('planner-cleanup'), usage: { ...usage, sessions: 1 }, output, outputDigest: digest(output),
    evidence: { path: plannerResultPath, digest: digest(readFileSync(plannerResultPath)) } };
  appendRun(dir, { ...event('planner-receipt'), rowId: routed.id, kind: 'receipt', status: 'accepted',
    requestKey: `${design.campaign}:${routed.id}:planner`, pipelineId: route.plannerPipelineId });
  appendRun(dir, { ...event('planner-route-event'), rowId: routed.id, kind: 'planner-route', status: 'completed', route });
  const assigned = expandSealedRequest(dir, routed.id, requestInputs);
  expect(assigned.stages.map(s => s.engine)).toEqual(['claude', 'codex', 'codex']);
  const invalidRouteDir = join(scratch(), 'invalid-planner-run');
  sealRun(invalidRouteDir, 'harness-only', contracts, {}, BINDING, bindings());
  appendScheduledPrefix(invalidRouteDir, routed.id);
  appendRun(invalidRouteDir, { ...event('bad-planner-preflight'), rowId: routed.id, kind: 'preflight',
    snapshot: preflights('O-export')[0]!.before });
  appendRun(invalidRouteDir, { ...event('bad-planner-receipt'), rowId: routed.id, kind: 'receipt', status: 'accepted',
    requestKey: `${design.campaign}:${routed.id}:planner`, pipelineId: 'bad-planner' });
  const mismatchedOutput = JSON.stringify({ solve: 'M', fix: 'M' });
  expect(() => appendRun(invalidRouteDir, { ...event('bad-planner-route'), rowId: routed.id, kind: 'planner-route', status: 'completed',
    route: { ...route, plannerPipelineId: 'bad-planner', output: mismatchedOutput, outputDigest: digest(mismatchedOutput) } }))
    .toThrow('Planner route lacks');
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
  status: 'delivered', first: { timely: true, tree: proof('first-tree'), captureReceipt: proof('first-capture'), valid: true, checks: { ...pass, core: 'fail' } },
  final: { timely: true, tree: proof('final-tree'), captureReceipt: proof('final-capture'), valid: true, checks: pass },
  terminalReceipt: proof('terminal'), cleanupReceipt: proof('clean'), usage, invalid: false, fixRounds: 1,
  queueStartedAt: 10, queueDeadlineAt: 100,
  workflow: { reviewers: [{ checkpoint: 'review-1', evidenceDigest: proof('review'), artifactDigest: digest(proof('final-tree')), completedAt: 2 }],
    fixes: [{ checkpoint: 'fix-1', evidenceDigest: proof('fix'), artifactDigest: digest(proof('final-tree')), completedAt: 3 }],
    reReviews: [{ checkpoint: 'review-2', evidenceDigest: proof('rereview'), artifactDigest: digest(proof('final-tree')), completedAt: 4 }] },
  judgments: [{ session: 'blind-a', artifactDigest: digest(proof('final-tree')), terminalReceipt: proof('judge-terminal-a'), cleanupReceipt: proof('judge-clean-a'), rating: [3, 3, 2], coverage: residuals }, { session: 'blind-b', artifactDigest: digest(proof('final-tree')), terminalReceipt: proof('judge-terminal-b'), cleanupReceipt: proof('judge-clean-b'), rating: [3, 3, 2], coverage: residuals }],
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
  expect(scoreRow({ ...good(), final: { timely: true, tree: proof('x'), captureReceipt: proof('capture'), valid: true, checks: { ...pass, securityPrivacy: 'fail' } } }).Q).toBe(0);
  expect(scoreRow({ ...good(), status: 'timeout', first: { timely: true, tree: proof('first-tree'), captureReceipt: proof('first'), valid: false, checks: pass } }).firstFunctionalAccepted).toBe(false);
  expect(scoreRow({ ...good(), final: { ...good().final!, valid: false } }).finalFunctionalAccepted).toBe(false);
  expect(scoreRow({ ...good(), workflow: undefined }).fullyAccepted).toBe(false);
  const reusedJudge = good();
  reusedJudge.judgments![1]!.session = reusedJudge.judgments![0]!.session;
  expect(scoreRow(reusedJudge).fullyAccepted).toBe(false);
  const invalidJudgeEvidence = good();
  invalidJudgeEvidence.judgments![0]!.cleanupReceipt = 'unsealed';
  expect(scoreRow(invalidJudgeEvidence).fullyAccepted).toBe(false);
  expect(scoreRow({ ...good(), first: undefined, usage: { ...usage, sessions: 0 } })).toMatchObject({ firstFunctionalAccepted: false, fullyAccepted: false });
  const truncated = good();
  truncated.judgments![1]!.truncated = true;
  const limited = scoreRow(truncated);
  expect(limited.fullyAccepted).toBe(false);
  expect(limited.ratings[1]).toBeNull();
  expect(limited.QBounds[1]).toBeGreaterThan(limited.QBounds[0]);
  const dispute = good();
  dispute.judgments![1]!.rating = [2, 3, 2];
  expect(scoreRow(dispute)).toMatchObject({ dispute: true, fullyAccepted: false });
  const twoFixes = good();
  twoFixes.workflow!.fixes.push({ checkpoint: 'fix-2', evidenceDigest: proof('fix-2'), artifactDigest: digest(proof('final-tree')), completedAt: 5 });
  expect(scoreRow(twoFixes).fullyAccepted).toBe(false);
  const beforeReview = good();
  beforeReview.workflow!.fixes[0]!.completedAt = 1;
  expect(scoreRow(beforeReview).fullyAccepted).toBe(false);
  const staleRereview = good();
  staleRereview.workflow!.reReviews[0]!.artifactDigest = digest(proof('stale-tree'));
  expect(scoreRow(staleRereview).fullyAccepted).toBe(false);
  const missingRereview = good();
  missingRereview.workflow!.reReviews = [];
  expect(scoreRow(missingRereview).fullyAccepted).toBe(false);
});

test('necessary clarification preserves autonomy and deduplicated defects preserve unknown coverage', () => {
  const input = good();
  input.human = [{ id: 'h', at: 1, actor: 'human', category: 'business-clarification', necessity: 'necessary-business-fact',
    fact: 'batch policy', script: 'sealed-fact', reason: 'requested', minutes: 2, artifact: 'first-tree' }];
  input.findings = [
    { defect: 'defect-a', verdict: 'true', checkpoint: 'review', evidence: proof('evidence-a'), severity: 'high', disposition: 'accepted' },
    { defect: 'defect-a', verdict: 'true', checkpoint: 'review', evidence: proof('evidence-a'), severity: 'high', disposition: 'accepted' },
    { defect: 'defect-b', verdict: 'unknown', checkpoint: 'review', evidence: proof('evidence-b'), severity: 'medium', disposition: 'unknown' },
  ];
  input.census = { defects: ['defect-a', 'defect-b'], complete: true };
  expect(scoreRow(input)).toMatchObject({ autonomousAccepted: true, strictGoalOnlyAccepted: false,
    reviewer: { confirmed: 1, unknown: 1, precisionBounds: [0.5, 1], recallBounds: [0.5, 1] } });
  input.census!.complete = false;
  expect(scoreRow(input).reviewer).toMatchObject({ recallCoverage: 'coverage-limited-census', recallBounds: [0.5, 1] });
  input.human[0].script = null;
  expect(() => scoreRow(input)).toThrow('Unbound clarification');
  input.human[0].script = 'sealed-fact';
  input.human[0].category = 'manual-repair';
  expect(scoreRow(input).autonomousAccepted).toBe(false);
  input.human[0].category = 'business-clarification';
  input.human = undefined;
  expect(scoreRow(input).autonomousAccepted).toBe(false);
  input.findings![0]!.evidence = 'missing-evidence';
  expect(() => scoreRow(input)).toThrow('Reviewer finding lacks');
});

test('calibration rejects red gold promotion and oracle controls require their intended failures', () => {
  const golds = Object.fromEntries(design.judgingCells.filter(j => j.kind === 'calibration').map(j => [j.gold!, j.gold === 'complete' ? [] : ['defect']]));
  const goldArtifactDigests = Object.fromEntries(Object.keys(golds).map(gold => [gold, proof(`gold:${gold}`)]));
  const judgments: Calibration[] = design.judgingCells.filter(j => j.kind === 'calibration').map(j => ({
    gold: j.gold!, artifactDigest: goldArtifactDigests[j.gold!], judge: j.judge as Calibration['judge'], session: j.id, rating: j.gold === 'complete' ? [3, 3, 3] : [2, 2, 2],
    detected: golds[j.gold!], usage: { ...usage, sessions: 1 }, terminalReceipt: proof(`terminal-${j.id}`), cleanupReceipt: proof('stopped'),
  }));
  expect(calibrationPassed(golds, judgments, goldArtifactDigests)).toBe(true);
  const swapped = judgments.map(row => ({ ...row }));
  [swapped[2]!.artifactDigest, swapped[4]!.artifactDigest] = [swapped[4]!.artifactDigest, swapped[2]!.artifactDigest];
  expect(calibrationPassed(golds, swapped, goldArtifactDigests)).toBe(false);
  const duplicatedGoldArtifact = { ...goldArtifactDigests, stub: goldArtifactDigests.complete! };
  expect(calibrationPassed(golds, judgments, duplicatedGoldArtifact)).toBe(false);
  judgments[7].rating = [3, 3, 3];
  expect(calibrationPassed(golds, judgments, goldArtifactDigests)).toBe(false);
  const refs: Record<string, Checks> = { correct: pass, unchanged: { core: 'fail' },
    partial: { ...pass, crossCallerRegression: 'fail' }, unsafe: { ...pass, securityPrivacy: 'fail' } };
  const expectedRed = { unchanged: ['core'], partial: ['crossCallerRegression'], unsafe: ['securityPrivacy'] };
  expect(oracleControls(reqs, refs, expectedRed)).toBe(true);
  expect(oracleControls(reqs, { ...refs, partial: pass }, expectedRed)).toBe(false);
  expect(oracleControls(reqs, { ...refs, unsafe: { securityPrivacy: 'missing' } }, expectedRed)).toBe(false);
});

function preflights(id: string) {
  const block = [...design.ordering.orchestrationBlocks, ...design.ordering.productPairedBlocks].find(b => b.id === id)!;
  type FixtureRuntime = { engine: 'codex' | 'claude'; model: string; effort: 'high' };
  const profile: FixtureRuntime = { engine: design.runtimePool.M.engine as FixtureRuntime['engine'],
    model: design.runtimePool.M.model, effort: 'high' };
  const runtimeBindings = (roles: Record<string, string>) => Object.fromEntries(Object.keys(roles).map(role => {
    const binding = { declared: 'M' as const, requested: { ...profile }, resolved: { ...profile } };
    return [role, { ...binding, bindingDigest: digest(JSON.stringify({ roleHash: roles[role], ...binding }) + '\n') }];
  })) as Record<string, { declared: 'M' | 'H'; requested: FixtureRuntime; resolved: FixtureRuntime; bindingDigest: string }>;
  return block.orderedCells.map((cellId, i) => {
    const snap = (at: number, capacityBudgets: number) => {
      const roles = {
        review: proof('review-baseline'), solve: proof('solve-baseline'), fix: proof('fix-baseline'),
        ...(cellId.endsWith('-S-r1') ? {} : { planner: proof('planner-baseline') }),
      };
      return { at, capacityBudgets, quotaStart: 0, quotaEnd: 18000, providerRevision: 'provider-1',
        sharedInputs: proof('sealed-inputs'), roles, runtimeBindings: runtimeBindings(roles) };
    };
    const before = snap(i * 1000, 4 - i);
    const after = snap(i * 1000 + 200, 3 - i);
    const checkpoint = Object.fromEntries(design.ordering.instrumentationCheckpoint.continueOnlyAfter.map(key => [key, proof(key)]));
    return { id: cellId, before, firstModelWork: i * 1000 + 100, after, checkpoint };
  });
}

const rebindRuntime = (snapshot: ReturnType<typeof preflights>[number]['before'], role: string) => {
  const bindings = snapshot.runtimeBindings as Record<string, { declared: 'M' | 'H'; requested: { engine: string; model: string; effort: string }; resolved: { engine: string; model: string; effort: string }; bindingDigest: string }>;
  const roles = snapshot.roles as Record<string, string>;
  const binding = bindings[role]!;
  binding.bindingDigest = digest(JSON.stringify({ roleHash: roles[role], declared: binding.declared,
    requested: binding.requested, resolved: binding.resolved }) + '\n');
};

test('O and P/S admission guards retain unknown and invalid comparisons', () => {
  const rows = preflights('O-export');
  expect(checkBlock('O-export', rows)).toMatchObject({ eligible: true, stop: false });
  expect(checkBlock('O-export', rows.slice(0, 2))).toMatchObject({ eligible: false, stop: false });
  const failures: [(r: typeof rows) => void, string][] = [
    [r => { r[0].before.capacityBudgets = 3; }, 'capacity'],
    [r => { r[1].after.quotaEnd++; }, 'Quota'],
    [r => { r[1].before.providerRevision = ''; }, 'Provider'],
    [r => { r[1].after.runtimeBindings!.review!.resolved.model = 'fallback-model'; rebindRuntime(r[1].after, 'review'); }, 'runtime differs'],
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
  const modelSwitch = preflights('PS-archive');
  const selected = modelSwitch[0]!.after.runtimeBindings!.solve!;
  selected.declared = 'H';
  selected.requested = { engine: design.runtimePool.H.engine as 'claude', model: design.runtimePool.H.model, effort: 'high' };
  selected.resolved = { ...selected.requested };
  rebindRuntime(modelSwitch[0]!.after, 'solve');
  expect(checkBlock('PS-archive', modelSwitch)).toMatchObject({ eligible: false, stop: true, reason: 'Role runtime changed within causal pair' });
});

test('campaign chronology rejects an interleaved solver and unresolved runtime fallback', () => {
  const ids = design.cells.filter(c => c.phase === 'O' || c.phase === 'P').sort((a, b) => a.ordinal - b.ordinal).map(c => c.id);
  expect(campaignChronologyValid(ids.map(id => ({ id })))).toBe(true);
  const interleaved = ids.map(id => ({ id }));
  interleaved.splice(1, 0, { id: design.cells.find(c => c.phase === 'R')!.id });
  expect(campaignChronologyValid(interleaved)).toBe(false);
  const rows = preflights('O-export');
  const ledger = [{ id: rows[0]!.id }, { id: design.cells.find(c => c.phase === 'R')!.id }, ...rows.slice(1).map(r => ({ id: r.id }))];
  expect(checkBlock('O-export', rows, ledger)).toMatchObject({ eligible: false, stop: true, reason: expect.stringContaining('outside solver') });
  rows[0].before.runtimeBindings!.solve!.resolved = { engine: 'codex', model: 'fallback', effort: 'high' };
  rebindRuntime(rows[0].before, 'solve');
  expect(checkBlock('O-export', rows)).toMatchObject({ eligible: false, stop: true, reason: expect.stringContaining('declared model binding') });
});

test('report excludes a causal block when an outside solver row is interleaved in the append ledger', () => {
  const dir = join(scratch(), 'interleaved-run');
  sealRun(dir, 'harness-only', contracts, {}, BINDING, bindings());
  const ordered = design.cells.filter(c => c.phase === 'O' || c.phase === 'P').sort((a, b) => a.ordinal - b.ordinal).map(c => c.id);
  const driftByCell = new Map([...design.ordering.orchestrationBlocks, ...design.ordering.productPairedBlocks]
    .flatMap(block => preflights(block.id)).map(row => [row.id, row]));
  let inserted = false;
  for (const id of ordered) {
    if (!inserted && id === design.ordering.orchestrationBlocks.find(b => b.id === 'O-export')!.orderedCells[1]) {
      const outsider = design.cells.find(c => c.phase === 'R')!;
      appendRun(dir, { ...event(`interleaver-receipt`), rowId: outsider.id, kind: 'receipt', status: 'accepted',
        requestKey: `${design.campaign}:${outsider.id}`, pipelineId: 'interleaver' });
      appendRun(dir, { ...event(`interleaver-result`), rowId: outsider.id, kind: 'solver', observation: good() });
      inserted = true;
    }
    appendCausalRow(dir, id, driftByCell.get(id)!);
  }
  const report = reportRun(dir);
  expect(report.blocks.find(block => block.id === 'O-export')).toMatchObject({
    eligible: false, stop: true, reason: expect.stringContaining('outside solver'),
  });
  expect(report.paired.filter(pair => pair.task === design.tasks[0]!.id && pair.contrast !== 'HA-HF')
    .every(pair => pair.causalEligible === false)).toBe(true);
});

test('E cumulative oracle rejects a later tree that regresses an earlier operation', () => {
  const dir = join(scratch(), 'e-run');
  sealRun(dir, 'harness-only', contracts, {}, BINDING, bindings());
  const c2 = design.cells.find(c => c.task === 'E1-C2' && c.arm === 'EA')!;
  const requestKey = `${design.campaign}:${c2.id}`;
  appendRun(dir, { ...event('e2-receipt'), rowId: c2.id, kind: 'receipt', status: 'accepted', requestKey, pipelineId: 'e2' });
  const regressed: Observation = { ...good(), predecessorOracles: {
    'E1-C0': oracleEvidence('E1-C0', proof('final-tree'), { ...pass, core: 'fail' }),
    'E1-C1': oracleEvidence('E1-C1', proof('final-tree'), pass),
  } };
  expect(() => appendRun(dir, { ...event('e2-result'), rowId: c2.id, kind: 'solver', observation: regressed })).toThrow('E predecessor oracle regressed');
  const missingEarlierOracle = { ...good(), predecessorOracles: {
    'E1-C1': oracleEvidence('E1-C1', proof('final-tree'), pass),
  } };
  expect(() => appendRun(dir, { ...event('e2-result-missing-prior'), rowId: c2.id, kind: 'solver', observation: missingEarlierOracle }))
    .toThrow('E cumulative predecessor oracle set is incomplete');
  const passing = { ...good(), predecessorOracles: {
    'E1-C0': oracleEvidence('E1-C0', proof('final-tree'), pass),
    'E1-C1': oracleEvidence('E1-C1', proof('final-tree'), pass),
  } };
  expect(() => appendRun(dir, { ...event('e2-result-pass'), rowId: c2.id, kind: 'solver', observation: passing })).not.toThrow();
});

test('curator completion requires the registered learner, delivery and original queue deadline; judges cannot reuse calibration sessions', () => {
  const dir = join(scratch(), 'curator-run');
  sealRun(dir, 'harness-only', contracts, {}, BINDING, bindings());
  const curator = design.curationCells[0]!;
  const learn = curator.afterCell;
  appendRun(dir, { ...event('learn-receipt'), rowId: learn, kind: 'receipt', status: 'accepted', requestKey: `${design.campaign}:${learn}`, pipelineId: 'learn' });
  appendRun(dir, { ...event('learn-result'), rowId: learn, kind: 'solver', observation: good() });
  const missingCurator = reportRun(dir).solvers.find(row => row.cell.id === learn)!;
  expect(missingCurator.metrics).toMatchObject({ fullyAccepted: false, curatorResources: null });
  appendRun(dir, { ...event('curator-receipt'), rowId: curator.id, kind: 'receipt', status: 'accepted',
    requestKey: `${design.campaign}:${curator.id}`, pipelineId: 'curator-pipeline' });
  expect(() => appendRun(dir, { ...event('curator-late'), rowId: curator.id, kind: 'curator', status: 'completed', packDigest: proof('pack'),
    usage: { units: 1, activeSeconds: 1, queueSeconds: 1, sessions: 1 }, queuedAt: 1, deadlineAt: 5, completedAt: 6,
    deliveredArtifactDigest: digest(proof('final-tree')), queueReceipt: 'curator-pipeline', terminalReceipt: proof('curator-terminal'),
    cleanupReceipt: proof('curator-cleanup') })).toThrow('queue deadline');
  const golds = Object.fromEntries(design.judgingCells.filter(j => j.kind === 'calibration').map(j => [j.gold!, j.gold === 'complete' ? [] : ['defect']]));
  const judgeRun = join(scratch(), 'judge-run');
  const goldArtifactDigests = Object.fromEntries(Object.keys(golds).map(gold => [gold, proof(`sealed-gold:${gold}`)]));
  sealRun(judgeRun, 'harness-only', contracts, golds, BINDING, bindings(), goldArtifactDigests);
  const calibrationRows = design.judgingCells.filter(j => j.kind === 'calibration').slice(0, 2);
  const first = calibrationRows[0]!;
  appendRun(judgeRun, { ...event('calibration-one'), rowId: first.id, kind: 'judge', status: 'completed', calibration: {
    gold: first.gold!, artifactDigest: goldArtifactDigests[first.gold!], judge: first.judge as 'J1'|'J2', session: 'reused-session', rating: [3,3,3], detected: [], usage: { ...usage, sessions: 1 }, terminalReceipt: proof('terminal'), cleanupReceipt: proof('cleanup'),
  } });
  const second = calibrationRows[1]!;
  expect(() => appendRun(judgeRun, { ...event('calibration-two'), rowId: second.id, kind: 'judge', status: 'completed', calibration: {
    gold: second.gold!, artifactDigest: goldArtifactDigests[second.gold!], judge: second.judge as 'J1'|'J2', session: 'reused-session', rating: [2,2,2], detected: ['defect'], usage: { ...usage, sessions: 1 }, terminalReceipt: proof('terminal'), cleanupReceipt: proof('cleanup'),
  } })).toThrow('Judge session reused');
});

const contracts = Object.fromEntries(design.tasks.map(t => [t.id, {
  requirements: reqs, residuals, opportunities: [{ id: t.id, task: t.id, principle: 'boundary', applicability: 'applicable' as const, proof: proof(t.id), version: '1' }],
  ...(t.id === 'E1-C1' ? { predecessors: ['E1-C0'], oracleCommands: { 'E1-C0': oracleCommand('E1-C0') } }
    : t.id === 'E1-C2' ? { predecessors: ['E1-C0', 'E1-C1'], oracleCommands: { 'E1-C0': oracleCommand('E1-C0'), 'E1-C1': oracleCommand('E1-C1') } } : {}),
}])) as Record<string, Contract>;
const event = (id: string) => ({ id, rowId: solver, evidenceDigest: proof(id) });

function appendCausalRow(dir: string, id: string, driftInput: ReturnType<typeof preflights>[number]) {
  const blockId = [...design.ordering.orchestrationBlocks, ...design.ordering.productPairedBlocks]
    .find(block => block.orderedCells.includes(id))!.id;
  const preflightId = `${id}-preflight`;
  const startId = `${id}-start`;
  const pipelineId = `pipeline-${id}`;
  appendRun(dir, { ...event(preflightId), rowId: id, kind: 'preflight', snapshot: driftInput.before, blockId });
  appendRun(dir, { ...event(`${id}-receipt`), rowId: id, kind: 'receipt', status: 'accepted',
    requestKey: `${design.campaign}:${id}`, pipelineId });
  appendRun(dir, { ...event(startId), rowId: id, kind: 'start', preflightId, startedAt: driftInput.firstModelWork,
    pipelineId, sessionId: `session-${id}`, terminalStageId: 'solve' });
  const drift = { ...driftInput, preflightId, startId };
  appendRun(dir, { ...event(`${id}-result`), rowId: id, kind: 'solver', observation: good(), drift });
}

function appendScheduledPrefix(dir: string, stopBefore: string, frozenPack?: { id: string; digest: string }) {
  const targets = design.cells.filter(c => c.ordinal < design.cells.find(x => x.id === stopBefore)!.ordinal);
  for (const cell of targets) {
    const priorEvents = readdirSync(dir).filter(name => /^\d{6}\.json$/.test(name))
      .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')).entry as { rowId: string; kind: string });
    if (priorEvents.some(entry => entry.rowId === cell.id && entry.kind === 'solver')) continue;
    const pipelineId = `prefix-pipeline-${cell.id}`;
    let drift: (ReturnType<typeof preflights>[number] & { preflightId?: string; startId?: string }) | undefined;
    if (cell.phase === 'O' || cell.phase === 'P') {
      const block = [...design.ordering.orchestrationBlocks, ...design.ordering.productPairedBlocks].find(b => b.orderedCells.includes(cell.id))!;
      drift = preflights(block.id).find(row => row.id === cell.id)!;
      const preflightId = `${cell.id}-preflight`;
      const startId = `${cell.id}-start`;
      appendRun(dir, { ...event(preflightId), rowId: cell.id, kind: 'preflight', snapshot: drift.before, blockId: block.id });
      appendRun(dir, { ...event(`${cell.id}-receipt`), rowId: cell.id, kind: 'receipt', status: 'accepted',
        requestKey: `${design.campaign}:${cell.id}`, pipelineId });
      appendRun(dir, { ...event(startId), rowId: cell.id, kind: 'start', preflightId, startedAt: drift.firstModelWork,
        pipelineId, sessionId: `session-${cell.id}`, terminalStageId: 'solve' });
      drift = { ...drift, preflightId, startId };
    } else {
      appendRun(dir, { ...event(`${cell.id}-receipt`), rowId: cell.id, kind: 'receipt', status: 'accepted',
        requestKey: `${design.campaign}:${cell.id}`, pipelineId });
    }
    appendRun(dir, { ...event(`${cell.id}-result`), rowId: cell.id, kind: 'solver', observation: good(), ...(drift ? { drift } : {}) });
    const curator = design.curationCells.find(c => c.afterCell === cell.id);
    if (curator) {
      if (priorEvents.some(entry => entry.rowId === curator.id && entry.kind === 'curator')) continue;
      const packDigest = frozenPack && curator.memoryOutput === frozenPack.id ? frozenPack.digest : proof(`pack:${curator.id}`);
      const curatorPipeline = `curator-pipeline-${curator.id}`;
      appendRun(dir, { ...event(`${curator.id}-receipt`), rowId: curator.id, kind: 'receipt', status: 'accepted',
        requestKey: `${design.campaign}:${curator.id}`, pipelineId: curatorPipeline });
      appendRun(dir, { ...event(`${curator.id}-result`), rowId: curator.id, kind: 'curator', status: 'completed', packDigest,
        usage: { units: 20, activeSeconds: 10, queueSeconds: 2, sessions: 1 }, queuedAt: 10, deadlineAt: 100, completedAt: 20,
        deliveredArtifactDigest: digest(proof('final-tree')), queueReceipt: curatorPipeline,
        terminalReceipt: proof(`terminal:${curator.id}`), cleanupReceipt: proof(`cleanup:${curator.id}`) });
    }
  }
}

test('both held-out requests require the same immutable curator output', () => {
  const dir = join(scratch(), 'run');
  const heldOut = design.cells.filter(c => c.memory === 'Q1-MA-after-L2');
  const bytes = 'synthetic frozen pack';
  const memory = { id: heldOut[0].memory, bytes, digest: digest(bytes) };
  const inputs = { ...requestInputs, memory };
  sealRun(dir, 'harness-only', contracts, {}, BINDING, bindings(Object.fromEntries(heldOut.map(c => [c.id, inputs]))));
  appendScheduledPrefix(dir, heldOut[0]!.id, memory);
  const acquisition = reportRun(dir);
  expect(acquisition.endpoints['M-acquisition'].MR.intended).toBe(4);
  expect(acquisition.endpoints['M-acquisition'].MA.intended).toBe(4);
  expect(acquisition.rows.filter(row => design.cells.some(cell => cell.id === row.id && cell.phase === 'M' && cell.kind === 'learn')
    && row.status === 'delivered').length).toBeGreaterThanOrEqual(4);
  appendRun(dir, { ...event('heldout-one-preflight'), rowId: heldOut[0]!.id, kind: 'preflight', snapshot: preflights('O-export')[0]!.before });
  expect(expandSealedRequest(dir, heldOut[0]!.id, inputs).stages[1].prompt).toContain(bytes);
  appendRun(dir, { ...event('heldout-one-receipt'), rowId: heldOut[0]!.id, kind: 'receipt', status: 'accepted',
    requestKey: `${design.campaign}:${heldOut[0]!.id}`, pipelineId: 'heldout-one' });
  appendRun(dir, { ...event('heldout-one-result'), rowId: heldOut[0]!.id, kind: 'solver', observation: good() });
  appendScheduledPrefix(dir, heldOut[1]!.id, memory);
  appendRun(dir, { ...event('heldout-two-preflight'), rowId: heldOut[1]!.id, kind: 'preflight', snapshot: preflights('O-export')[0]!.before });
  expect(expandSealedRequest(dir, heldOut[1]!.id, inputs).stages[1].prompt).toContain(bytes);
  const replacement = { ...memory, bytes: 'fresh data', digest: digest('fresh data') };
  expect(() => expandSealedRequest(dir, heldOut[1].id, { ...inputs, memory: replacement })).toThrow('ledger seal');
});

test('sealed run survives process restart, retains every failed row and allows durable delivery reconciliation only', () => {
  const root = scratch();
  const dir = join(root, 'run');
  sealRun(dir, 'harness-only', contracts, {}, BINDING, bindings());
  expect(() => sealRun(dir, 'harness-only', contracts, {}, BINDING, bindings())).toThrow();
  const requestKey = expandRequest(solver, requestInputs).clientRequestId;
  appendRun(dir, { ...event('lost'), kind: 'receipt', status: 'unknown', requestKey });
  expect(() => appendRun(dir, { ...event('retry'), kind: 'receipt', status: 'accepted', requestKey, pipelineId: 'fixture' })).toThrow('reconciliation');
  appendRun(dir, { ...event('duplicate'), kind: 'receipt', status: 'duplicate', requestKey, pipelineId: 'fixture' });
  appendRun(dir, { ...event('proof'), kind: 'receipt', status: 'reconciled', requestKey, pipelineId: 'fixture' });
  const firstDrift = preflights('O-export')[0]!;
  appendRun(dir, { ...event('timeout-preflight'), rowId: solver, kind: 'preflight', snapshot: firstDrift.before, blockId: 'O-export' });
  appendRun(dir, { ...event('timeout-start'), rowId: solver, kind: 'start', preflightId: 'timeout-preflight',
    startedAt: firstDrift.firstModelWork, pipelineId: 'fixture', sessionId: 'timeout-session', terminalStageId: 'solve' });
  appendRun(dir, { ...event('timeout'), kind: 'solver', observation: { status: 'timeout', reason: 'guard' },
    drift: { ...firstDrift, preflightId: 'timeout-preflight', startId: 'timeout-start' } });
  const productCell = design.cells.find(cell => cell.arm === 'P')!;
  expect(() => expandSealedRequest(dir, productCell.id, requestInputs)).toThrow('Admission stopped');
  const replacement = { ...event('new'), kind: 'solver' as const, observation: good() };
  expect(() => appendRun(dir, replacement)).toThrow('outcome already sealed');
  const replay = Bun.spawnSync([process.execPath, entrypoint, 'report', dir], { timeout: 4000 });
  expect(replay.exitCode).toBe(0);
  const report = JSON.parse(replay.stdout.toString());
  expect(report).toMatchObject({ classification: 'harness-only', performanceResults: null, intendedSolverRows: 34 });
  expect(report.rows).toHaveLength(118);
  expect(report.rows[0].status).toBe('timeout');
  expect(report.endpoints.O.S).toMatchObject({ intended: 2, accepted: 0, unitsPerAccepted: null });
  expect(report.endpoints['M-acquisition'].MR).toMatchObject({ intended: 4, accepted: 0 });
  expect(report.endpoints['M-acquisition'].MA).toMatchObject({ intended: 4, accepted: 0 });
  expect(report.endpoints['M-held-out'].MR.intended).toBe(4);
  expect(report.endpoints['M-held-out'].MR.primaryViolations).toMatchObject({ denominator: 4, unknown: 4, bounds: [0, 1] });
  expect(report.prefixes[2].prefixes[2].arms.EA.intended).toBe(3);
  unlinkSync(join(dir, '000004.json'));
  expect(() => reportRun(dir)).toThrow('Accepted ledger head was rolled back');
});

test('deleting the final terminal row is detected against its retained checkpoint', () => {
  const dir = join(scratch(), 'tail-run');
  sealRun(dir, 'harness-only', contracts, {}, BINDING, bindings());
  const safeCell = design.cells.find(c => c.phase === 'R')!;
  const requestKey = `${design.campaign}:${safeCell.id}`;
  appendRun(dir, { ...event('tail-receipt'), rowId: safeCell.id, kind: 'receipt', status: 'accepted', requestKey, pipelineId: 'tail-pipeline' });
  appendRun(dir, { ...event('tail-solver'), rowId: safeCell.id, kind: 'solver', observation: good() });
  unlinkSync(join(dir, '000002.json'));
  expect(() => reportRun(dir)).toThrow('Accepted ledger head was rolled back');
});

test('interrupted ledger append recovers idempotently and the accepted head rejects tail loss', () => {
  const dir = join(scratch(), 'recover-run');
  const sealId = sealRun(dir, 'harness-only', contracts, {}, BINDING, bindings());
  const partial = { ...event('interrupted-receipt'), kind: 'receipt' as const, status: 'unknown' as const,
    requestKey: `${design.campaign}:${solver}` };
  writeFileSync(join(dir, '000001.json'), JSON.stringify({ previous: sealId, entry: partial }) + '\n', { mode: 0o600 });
  appendRun(dir, partial);
  expect(reportRun(dir).rows[0]!.status).toBe('not_run');
  unlinkSync(join(dir, '000001.json'));
  unlinkSync(join(dir, 'checkpoint-000001.json'));
  expect(() => reportRun(dir)).toThrow('Accepted ledger head was rolled back');
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
