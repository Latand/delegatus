import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- generated fixture records cross many domain unions. */
const runSide = process.argv.includes('--run-side');
const coldFixtures = process.argv.includes('--cold-fixtures');
const coldSample = process.argv.includes('--cold-sample');
const COLD_SAMPLES = 5;
const COLD_CORPUS = { projects: 40, claudePerProject: 45, codex: 700 };
const COLD_LONG = { codexBytes: 100 * 1024 * 1024, claudeBytes: 30 * 1024 * 1024 };

/* Every root a scanner, an account store or tmux resolves from the environment,
   pointed into the run's own sandbox before any product module loads. HOME and
   TMPDIR alone leave the inherited COPILOT_HOME, OPENCLAW_STATE_DIR and the
   operator's tmux server (TMUX, or the /tmp default of TMUX_TMPDIR) reachable. */
const SANDBOX_ROOTS = ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'LLV_STATE_DIR', 'TMPDIR', 'CLAUDE_CODE_TMPDIR', 'TMUX_TMPDIR', 'COPILOT_HOME', 'OPENCLAW_STATE_DIR', 'GH_CONFIG_DIR'];
function isolateEnvironment(sandbox: string, transcriptHomes: { codex: string; claude: string }) {
 for (const key of Object.keys(process.env)) if (key.startsWith('LLV_') || key === 'TMUX' || key === 'TMUX_PANE') delete process.env[key];
 for (const key of SANDBOX_ROOTS) { process.env[key] = path.join(sandbox, key); fs.mkdirSync(process.env[key]!, { recursive: true }); }
 process.env.CODEX_HOME = process.env.LLV_CODEX_HOME = transcriptHomes.codex;
 process.env.CLAUDE_CONFIG_DIR = process.env.LLV_CLAUDE_HOME = transcriptHomes.claude;
 for (const home of Object.values(transcriptHomes)) fs.mkdirSync(home, { recursive: true });
 process.env.LLV_STATE_ACTIVATION = 'sqlite';
}

/* No variable relocates /proc, and the product reads it for real: the command
   line, the environment and the open files of every process it lists. So each
   measured process runs in its own PID namespace under a /proc mounted for that
   namespace, where the only processes are its own. The uid and gid stay the
   caller's. A machine that cannot do this runs no measurement. */
const PRIVATE_PROC = ['unshare', '--user', `--map-user=${process.getuid!()}`, `--map-group=${process.getgid!()}`, '--pid', '--fork', '--kill-child', '--mount-proc'];
const pidNamespace = () => fs.readlinkSync('/proc/self/ns/pid');
function withPrivateProc(argv: string[], env: Record<string, string | undefined>) {
 // A shell stays PID 1, so the measured process is an ordinary pid (the product skips pid 1).
 return { argv: [...PRIVATE_PROC, 'sh', '-c', '"$@"; exit $?', 'sh', ...argv], env: { ...env, COST_HOST_PID_NAMESPACE: pidNamespace() } };
}
function requirePrivateProcSupport() {
 const probe = Bun.spawnSync([...PRIVATE_PROC, 'true'], { stdout: 'pipe', stderr: 'pipe' });
 if (probe.exitCode !== 0) throw new Error(`This benchmark needs an unprivileged PID namespace (unshare --user --pid --mount-proc) and will not read the machine's process table without one:\n${probe.stderr.toString().slice(-400)}`);
}
/** Refuses to load a product module unless /proc is the one mounted for this
    process's own PID namespace, which lists nothing but what it started. */
function assertPrivateProc() {
 const host = process.env.COST_HOST_PID_NAMESPACE;
 if (!host || pidNamespace() === host || fs.readlinkSync('/proc/self') !== String(process.pid)) throw new Error('This process can read the process table of the machine; refusing to measure');
}

/* A cold read is the first call a fresh MCP process answers with an empty
   state directory: no resource observation, no file-scan snapshot, nothing in
   memory. Every sample is its own process over one shared generated corpus. */
/** A session id in the shape the scanners expect, minted here so no literal one is committed. */
const coldId = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-a${digit.repeat(3)}-${digit.repeat(12)}`;
function coldPaths(root: string) {
 const codexHome = path.join(root, 'codex-home'), claudeHome = path.join(root, 'claude-home');
 return {
  codexHome, claudeHome,
  codexLong: path.join(codexHome, 'sessions', '2026', '08', '30', `rollout-2026-08-30T10-00-00-${coldId('1')}.jsonl`),
  claudeLong: path.join(claudeHome, 'projects', '-workspace-fixture', `${coldId('2')}.jsonl`),
 };
}
/** One generated Codex rollout of the corpus, by its index. */
function coldCodexRollout(codexHome: string, index: number) {
 const day = String(1 + index % 28).padStart(2, '0');
 const id = `${index.toString(16).padStart(8, '0')}-1111-4111-a111-${index.toString(16).padStart(12, '0')}`;
 return { id, file: path.join(codexHome, 'sessions', '2026', '09', day, `rollout-2026-09-${day}T10-00-00-${id}.jsonl`) };
}
/* Live hosts whose transcript tails answer slowly: the part of a cold
   agent_activity that follows the catalog wait. */
const COLD_SLOW_HOSTS = { key: 'agent_activity/no-catalog-slow-hosts', hosts: 3, tailMs: 1100 };
const COLD_SCENARIOS: Record<string, (files: ReturnType<typeof coldPaths>, key: string) => [string, Record<string, unknown>]> = {
 'resources/no-observation': () => ['resources', {}],
 'agent_activity/no-catalog': (_files, key) => ['agent_activity', { clientRequestId: key }],
 [COLD_SLOW_HOSTS.key]: (_files, key) => ['agent_activity', { clientRequestId: key }],
 'get_conversation/claude-long': files => ['get_conversation', { transcriptPath: files.claudeLong }],
 'get_conversation/codex-long': files => ['get_conversation', { transcriptPath: files.codexLong }],
 'get_conversation/claude-long-tail40': files => ['get_conversation', { transcriptPath: files.claudeLong, tailLines: 40 }],
 'get_conversation/codex-long-tail40': files => ['get_conversation', { transcriptPath: files.codexLong, tailLines: 40 }],
 'get_conversation/claude-long-full': files => ['get_conversation', { transcriptPath: files.claudeLong, full: true }],
 'conversation_messages/claude-long': files => ['conversation_messages', { transcriptPath: files.claudeLong }],
 'conversation_messages/codex-long': files => ['conversation_messages', { transcriptPath: files.codexLong }],
 'conversation_messages/codex-long-capped-scan': files => ['conversation_messages', { transcriptPath: files.codexLong, roles: ['user'], limit: 200 }],
};

async function writeColdFixtures() {
 const files = coldPaths(process.env.COLD_ROOT!);
 const { generateCodexRollout, generateClaudeTranscript } = await import('./conversation-messages-fixture');
 fs.mkdirSync(path.dirname(files.codexLong), { recursive: true });
 fs.mkdirSync(path.dirname(files.claudeLong), { recursive: true });
 generateCodexRollout(files.codexLong, COLD_LONG.codexBytes, 1311);
 generateClaudeTranscript(files.claudeLong, COLD_LONG.claudeBytes, 1311, coldId('2'));
 let seed = 7;
 const turns = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return 20 + seed % 381; };
 let count = 0;
 for (let project = 0; project < COLD_CORPUS.projects; project++) {
  const directory = path.join(files.claudeHome, 'projects', `-workspace-project-${project}`);
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < COLD_CORPUS.claudePerProject; index++) {
   const id = `${project.toString(16).padStart(8, '0')}-${index.toString(16).padStart(4, '0')}-4000-a000-${(count++).toString(16).padStart(12, '0')}`;
   const lines: string[] = [];
   for (let turn = 0, total = turns(); turn < total; turn++) {
    const timestamp = `2026-09-${String(1 + turn % 28).padStart(2, '0')}T10:${String(turn % 60).padStart(2, '0')}:00.000Z`;
    lines.push(JSON.stringify({ type: 'user', uuid: `u${count}-${turn}`, timestamp, sessionId: id, cwd: `/workspace/project-${project}`, message: { role: 'user', content: [{ type: 'text', text: 'Turn ' + 'word '.repeat(60) }] } }));
    lines.push(JSON.stringify({ type: 'assistant', uuid: `a${count}-${turn}`, timestamp, sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: 'Answer ' + 'word '.repeat(200) }] } }));
   }
   fs.writeFileSync(path.join(directory, `${id}.jsonl`), lines.join('\n') + '\n');
  }
 }
 for (let index = 0; index < COLD_CORPUS.codex; index++) {
  const { id, file } = coldCodexRollout(files.codexHome, index);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [JSON.stringify({ timestamp: '2026-09-01T10:00:00.000Z', type: 'session_meta', payload: { id, cwd: `/workspace/project-${index % COLD_CORPUS.projects}` } })];
  for (let turn = 0, total = turns(); turn < total; turn++) lines.push(JSON.stringify({ timestamp: '2026-09-01T10:00:00.000Z', type: 'response_item', payload: { type: 'message', role: turn % 2 ? 'assistant' : 'user', content: [{ type: 'output_text', text: 'text ' + 'word '.repeat(150) }] } }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
 }
 process.stdout.write(JSON.stringify({ transcripts: count + COLD_CORPUS.codex + 2, codexLongBytes: fs.statSync(files.codexLong).size, claudeLongBytes: fs.statSync(files.claudeLong).size }) + '\n');
}

async function runColdSample() {
 assertPrivateProc();
 const scenario = process.argv[process.argv.indexOf('--cold-sample') + 1]!;
 const files = coldPaths(process.env.COLD_ROOT!), sandbox = process.env.COLD_SANDBOX!;
 isolateEnvironment(sandbox, { codex: files.codexHome, claude: files.claudeHome });
 // A closed port: nothing in a cold sample may reach a running Viewer.
 process.env.LLV_VIEWER_CONTROL_URL = 'http://127.0.0.1:9';
 const serverMod = await import('@/lib/mcp/server');
 const { viewerMcpBindings, productionDomainDependencies, productionViewerControlDependencies, viewerMcpToolPolicy } = await import('@/lib/mcp/bindings');
 const { agentRegistry } = await import('@/lib/agent/registry');
 const { beginLegacySpawnFixture } = await import('@/lib/agent/registryTestFixtures');
 const { runAsMcpHttpCaller } = await import('@/lib/mcp/callerContext');
 const registry = agentRegistry();
 const begun = beginLegacySpawnFixture(registry, { engine: 'codex', cwd: sandbox, role: 'builder', origin: { kind: 'operator' } });
 if (begun.kind !== 'created') throw new Error('fixture admission');
 const capability = registry.rotateSpawnCapabilityForReceipt(begun.receipt.launchId);
 const receipts = new serverMod.SqliteMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!, 'audit-receipts.sqlite'));
 // The slow-host scenario keeps the production catalog, describe and tail read,
 // and adds verified live hosts whose tail takes longer than the answer may.
 const hosted = Array.from({ length: COLD_SLOW_HOSTS.hosts }, (_, index) => coldCodexRollout(files.codexHome, index));
 const domain: any = scenario !== COLD_SLOW_HOSTS.key ? productionDomainDependencies : { ...productionDomainDependencies, livenessSources: (catalog: any) => {
  const sources: any = productionDomainDependencies.livenessSources(catalog);
  return { ...sources,
   registrySnapshot: () => { const snapshot = sources.registrySnapshot(); return { ...snapshot, entries: { ...snapshot.entries, ...Object.fromEntries(hosted.map((host, index) => [`cold-host-${index}`, { key: { engine: 'codex', accountId: null, sessionId: host.id }, artifactPath: host.file, status: 'live', host: null, accountId: null, structuredHost: { process: { pid: process.pid, startIdentity: 'cold-host' } }, updatedAt: new Date().toISOString() }])) } }; },
   probe: { ...sources.probe, pidAlive: () => true, processIdentity: () => 'cold-host' },
   transcriptEvidence: async (...args: any[]) => { if (hosted.some(host => host.file === args[1])) await Bun.sleep(COLD_SLOW_HOSTS.tailMs); return sources.transcriptEvidence(...args); } };
 } };
 const service = serverMod.createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true), domain), receipts, viewerMcpToolPolicy(domain));
 const mcp = serverMod.createViewerMcpServer(service);
 const client = new Client({ name: 'private-audit', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(a), mcp.connect(b)]);
 let seq = 0;
 const call = async () => {
  const [tool, args] = COLD_SCENARIOS[scenario]!(files, `cold-${++seq}`);
  const start = performance.now();
  const answer: any = await runAsMcpHttpCaller({ capability }, () => client.callTool({ name: tool, arguments: args }));
  const ms = performance.now() - start;
  const result = answer.structuredContent ?? JSON.parse(answer.content[0].text);
  const pending = result.freshness?.pending === true || result.catalog === 'pending' || result.evidence === 'pending';
  return { ms, outTok: JSON.stringify(result).length / 4, ok: result.ok === true, pending, rows: Array.isArray(result.conversations) ? result.conversations.length : null };
 };
 const first = await call();
 // A pending first answer is followed until the complete one arrives, so the
 // table shows what the caller waits for in total and per call.
 let completeAfterMs: number | null = null, followUps = 0, worstFollowUpMs = 0;
 if (first.pending) {
  const started = performance.now() - first.ms;
  while (followUps < 40) {
   const next = await call(); followUps++; worstFollowUpMs = Math.max(worstFollowUpMs, next.ms);
   if (!next.pending) { completeAfterMs = performance.now() - started; break; }
  }
 }
 process.stdout.write(JSON.stringify({ scenario, ms: first.ms, outTok: first.outTok, ok: first.ok, pending: first.pending, rows: first.rows, followUps, worstFollowUpMs, completeAfterMs }) + '\n');
 await client.close(); await mcp.close(); receipts.close();
 process.exit(0);
}

function runColdSide(checkout: string, work: string, side: string, coldRoot: string) {
 const samples: any[] = [];
 for (const scenario of Object.keys(COLD_SCENARIOS)) for (let i = 0; i < COLD_SAMPLES; i++) {
  const sandbox = path.join(work, `${side}-cold`, `${scenario.replace(/[^a-z0-9]+/g, '-')}-${i}`);
  const isolated = withPrivateProc(['bun', 'run', 'scripts/mcp-call-cost-benchmark.ts', '--cold-sample', scenario], { ...process.env, NODE_ENV: 'test', COLD_ROOT: coldRoot, COLD_SANDBOX: sandbox });
  const child = Bun.spawnSync(isolated.argv, { cwd: checkout, env: isolated.env, stdout: 'pipe', stderr: 'pipe' });
  if (child.exitCode !== 0) throw new Error(`${side} cold sample ${scenario} failed (exit ${child.exitCode}):\n${child.stderr.toString().slice(-700)}`);
  samples.push(JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!));
  fs.rmSync(sandbox, { recursive: true, force: true });
 }
 const q = (values: number[], p: number) => values.toSorted((x, y) => x - y)[Math.max(0, Math.ceil(values.length * p) - 1)]!;
 return Object.keys(COLD_SCENARIOS).map(key => {
  const rows = samples.filter(sample => sample.scenario === key);
  const complete = rows.filter(row => row.completeAfterMs !== null).map(row => row.completeAfterMs);
  return { key, n: rows.length, ok: rows.filter(row => row.ok).length, pending: rows.filter(row => row.pending).length,
   p50ms: +q(rows.map(row => row.ms), .5).toFixed(2), maxMs: +Math.max(...rows.map(row => row.ms)).toFixed(2), outTokP50: q(rows.map(row => row.outTok), .5),
   ...(rows.every(row => typeof row.rows === 'number') ? { rowsMin: Math.min(...rows.map(row => row.rows)) } : {}),
   ...(complete.length ? { worstFollowUpMs: +Math.max(...rows.map(row => row.worstFollowUpMs)).toFixed(2), completeAfterP50ms: +q(complete, .5).toFixed(2) } : {}) };
 });
}
const OPTIONAL_READ_KEY_TOOLS = new Set([
 'message_receipt', 'list_conversations', 'search_transcripts', 'get_conversation',
 'conversation_deliverability', 'conversation_messages', 'get_pipeline', 'board_snapshot',
 'list_flows', 'get_flow', 'list_pipelines', 'list_tasks', 'get_task',
 'deployment_status', 'resources', 'get_orchestrator', 'account_limits',
]);

async function runPair() {
 const base = process.argv[process.argv.indexOf('--base') + 1];
 if (!base || base.startsWith('--')) throw new Error('Usage: bun run scripts/mcp-call-cost-benchmark.ts --base <exact-commit>');
 const proc = Bun.spawnSync(['git', 'rev-parse', '--verify', `${base}^{commit}`], { stdout: 'pipe', stderr: 'pipe' });
 if (proc.exitCode !== 0) throw new Error(`Base is not an available commit: ${base}`);
 const baseCommit = proc.stdout.toString().trim();
 const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe' }).stdout.toString().trim();
 const work = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'delegatus-mcp-cost-'));
 const script = fs.readFileSync(new URL(import.meta.url), 'utf8');
 const output: Record<string, unknown> = {};
 try {
  requirePrivateProcSupport();
  const coldRoot = path.join(work, 'cold-fixtures');
  const fixtures = Bun.spawnSync(['bun', 'run', 'scripts/mcp-call-cost-benchmark.ts', '--cold-fixtures'], { env: { ...process.env, COLD_ROOT: coldRoot }, stdout: 'pipe', stderr: 'pipe' });
  if (fixtures.exitCode !== 0) throw new Error(`Could not generate cold fixtures:\n${fixtures.stderr.toString().slice(-700)}`);
  const coldSeed = JSON.parse(fixtures.stdout.toString().trim());
  for (const [side, revision] of [['base', baseCommit], ['head', head]] as const) {
   const checkout = path.join(work, side);
   const outputDir = path.join(work, `${side}-output`);
   fs.mkdirSync(checkout);
   const archive = Bun.spawnSync(['git', 'archive', revision], { stdout: 'pipe', stderr: 'pipe' });
   if (archive.exitCode !== 0) throw new Error(`Could not archive ${side} ${revision}`);
   const archiveFile = path.join(work, `${side}.tar`);
   fs.writeFileSync(archiveFile, archive.stdout);
   const unpack = Bun.spawnSync(['tar', '-xf', archiveFile, '-C', checkout], { stdout: 'pipe', stderr: 'pipe' });
   if (unpack.exitCode !== 0) throw new Error(`Could not unpack ${side} source`);
   fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
   fs.writeFileSync(path.join(checkout, 'scripts/mcp-call-cost-benchmark.ts'), script);
   fs.symlinkSync(path.resolve('node_modules'), path.join(checkout, 'node_modules'), 'dir');
   const isolated = withPrivateProc(['bun', 'run', 'scripts/mcp-call-cost-benchmark.ts', '--run-side'],
    { ...process.env, NODE_ENV: 'test', COST_CANDIDATE: side === 'head' ? '1' : '0', AUDIT_OUTPUT: outputDir, LLV_STATE_DIR: path.join(work, `${side}-state`), COST_REPO: process.cwd() });
   const child = Bun.spawnSync(isolated.argv, { cwd: checkout, env: isolated.env, stdout: 'pipe', stderr: 'pipe' });
   if (child.exitCode !== 0) {
    const stderr = child.stderr.toString();
    const stdout = child.stdout.toString();
    const faults = fs.existsSync(path.join(outputDir, 'faults.json')) ? fs.readFileSync(path.join(outputDir, 'faults.json'), 'utf8') : 'fault summary unavailable';
    throw new Error(`${side} harness failed (exit ${child.exitCode}):\nFault rows: ${faults}\n${stderr.slice(-700)}\n${stdout.slice(-500)}`);
   }
   output[side] = {
    profile: JSON.parse(fs.readFileSync(path.join(outputDir, 'profile.json'), 'utf8')),
    faults: JSON.parse(fs.readFileSync(path.join(outputDir, 'faults.json'), 'utf8')),
    cold: runColdSide(checkout, work, side, coldRoot),
   };
   process.stdout.write(`${side} ${revision}: ${child.stdout.toString().trim()}\n`);
  }
  const baseRows = (output.base as any).profile.grouped as any[];
  const headRows = (output.head as any).profile.grouped as any[];
  if (baseRows.reduce((sum, row) => sum + row.n, 0) !== 303 || headRows.reduce((sum, row) => sum + row.n, 0) !== 303) throw new Error('Expected 303 healthy MCP calls per side');
  if ([...baseRows, ...headRows].some(row => row.ok !== row.n)) throw new Error('A healthy fixture call failed');
  const headByKey = new Map(headRows.map(row => [row.key, row]));
  for (const row of baseRows) {
   const paired = headByKey.get(row.key);
   if (!paired || paired.n !== row.n || paired.inputKeys.join(',') !== row.inputKeys.join(',') || paired.inTokP50 !== row.inTokP50) throw new Error(`Healthy request shape or input token count differs between revisions for ${row.key}`);
  }
  const faultRows = [...(output.base as any).faults, ...(output.head as any).faults];
  // A base that predates the bounded search failure (#2478) makes eleven
  // attempts; a later one already makes one. The head always makes one.
  if (faultRows.length !== 18 || faultRows.some(row => row.ok || (row.side === 'head' ? row.attempts !== 1 : row.attempts !== 1 && row.attempts !== 11))) throw new Error('Expected three failed-verdict fault scenarios, n=3 per side, with one HTTP attempt on the head');
  const cold = { base: (output.base as any).cold as any[], head: (output.head as any).cold as any[] };
  if ([...cold.base, ...cold.head].some(row => row.ok !== row.n)) throw new Error('A cold fixture call failed');
  if ([...cold.base, ...cold.head].find(row => row.key === COLD_SLOW_HOSTS.key && row.rowsMin < COLD_SLOW_HOSTS.hosts)) throw new Error('A cold agent_activity answer lost a hosted row');
  const fullKey = 'get_conversation/claude-long-full';
  if (cold.base.find(row => row.key === fullKey)!.outTokP50 !== cold.head.find(row => row.key === fullKey)!.outTokP50) throw new Error('get_conversation full:true no longer returns the complete answer');
  process.stdout.write(JSON.stringify({ base: baseCommit, head, healthyCallsPerSide: 303, scenarios: baseRows.length, profiles: { base: baseRows, head: headRows }, faultRows, coldSeed: { ...coldSeed, samplesPerScenario: COLD_SAMPLES }, cold }, null, 2) + '\n');
 } finally {
  fs.rmSync(work, { recursive: true, force: true });
 }
}

if (coldFixtures) {
 await writeColdFixtures();
} else if (coldSample) {
 await runColdSample();
} else if (!runSide) {
 await runPair();
} else {
assertPrivateProc();
const root=process.env.AUDIT_OUTPUT!,runTag=String(Date.now()),candidate=process.env.COST_CANDIDATE==='1';
fs.mkdirSync(root,{recursive:true});
const warmSandbox=path.join(root,'sandbox-'+runTag);
isolateEnvironment(warmSandbox,{codex:path.join(warmSandbox,'LLV_CODEX_HOME'),claude:path.join(warmSandbox,'LLV_CLAUDE_HOME')});
const serverMod=await import('@/lib/mcp/server');
const {viewerMcpBindings,productionDomainDependencies,productionViewerControlDependencies,viewerMcpToolPolicy}=await import('@/lib/mcp/bindings');
const {pipelineCorpus}=await import('@/lib/pipelines/fixtures/corpus');
const {savePipelines,findPipelineRecord,loadPipelines}=await import('@/lib/pipelines/store');
const {saveTasks}=await import('@/lib/tasks/store');
const {agentRegistry}=await import('@/lib/agent/registry');
const {defaultPipelinePorts,patchPipeline,reportStageCompletion}=await import('@/lib/pipelines/engine');
const {registerPipelineTick}=await import('@/lib/pipelines/controllerSignal');
const {indexTranscriptSources}=await import('@/lib/search/transcriptSearch');
const {GET:filesGET}=await import('@/app/api/files/route');
const {GET:conversationsGET}=await import('@/app/api/conversations/route');
const memoryRoutes=await import('@/app/api/search/memory/route');
const transcriptRoutes=await import('@/app/api/search/transcripts/route');
const {createAttentionRequest}=await import('@/lib/attention/store');
const {awaitAttentionArrival,answerAttentionRequest}=await import('@/lib/attention/service');
const restoreTick=registerPipelineTick(async()=>{});
const at='2026-10-02T00:00:00.000Z',sha='a'.repeat(40),project='audit-project';
const transcripts=path.join(process.env.LLV_CODEX_HOME!,'sessions','2026','10','02');fs.mkdirSync(transcripts,{recursive:true});
const transcript=path.join(transcripts,'audit.jsonl');
const rows=[{timestamp:at,type:'session_meta',payload:{id:'audit-session-0001',cwd:root}}];
for(let i=0;i<1000;i++)rows.push({timestamp:at,type:'response_item',payload:{type:'message',role:i%2?'assistant':'user',content:[{type:'output_text',text:'audit common index text '+i+' '+ 'sample '.repeat(150)}]}} as any);
fs.writeFileSync(transcript,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
const {beginLegacySpawnFixture}=await import('@/lib/agent/registryTestFixtures');
const {runAsMcpHttpCaller}=await import('@/lib/mcp/callerContext');
const registry=agentRegistry();
const begun=beginLegacySpawnFixture(registry,{engine:'codex',cwd:root,role:'builder',origin:{kind:'operator'}});
if(begun.kind!=='created')throw new Error('fixture admission');
const settled=registry.settleSpawn(begun.receipt.launchId,{key:{engine:'codex',sessionId:'audit-session-0001'},artifactPath:transcript,cwd:root,accountId:null,status:'live',host:null,claimEpoch:0,claimOwner:null,pendingAction:null});
if(settled.kind!=='settled')throw new Error('fixture settlement');
const cid=settled.conversation.id,capability=registry.rotateSpawnCapabilityForReceipt(begun.receipt.launchId);
const sources=[{path:transcript,engine:'codex' as const,project,size:fs.statSync(transcript).size,mtimeMs:fs.statSync(transcript).mtimeMs}];
await indexTranscriptSources(sources);
const lanes=pipelineCorpus(27,6);for(const lane of lanes){lane.project=project;lane.taskIds=[];lane.repoDir=root;lane.worktreeDir=path.join(path.dirname(root),`${path.basename(root)}-pipeline-${lane.id}`);lane.publication='internal';}
const reportLane=lanes[1]!;reportLane.runs[0]!.attempts.at(-1)!.conversationId=cid;reportLane.runs[0]!.attempts.at(-1)!.state='running';
reportLane.runs[0]!.attempts.at(-1)!.agentPath=null;
const tasks=Array.from({length:107},(_,i)=>({id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,project,status:i%4?'inbox':'done',text:`Audit task ${i}\n${'Outcome detail. '.repeat(30)}`,details:'Working context. '.repeat(100),placement:'unplaced',assignments:[],createdAt:at,updatedAt:at}));
saveTasks(tasks as any);
savePipelines(lanes);
let externalDelay=0;const execSamples:any[]=[];
const exec=(command:string,args:string[])=>{
 const started=performance.now();let stdout='';const code=0;
 const category=command==='timeout'&&args.includes('gh')?'forge':command==='timeout'?'git-remote':args[0]==='ls-remote'||args[0]==='fetch'?'git-remote':'git-local';
 if(externalDelay&&category!=='git-local')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,externalDelay);
 if(command==='timeout'&&args.includes('gh'))stdout='[]';
 else if(command==='timeout'&&args.includes('ls-remote'))stdout=sha+'\trefs/heads/'+reportLane.branch+'\n';
 else if(args[0]==='branch')stdout=reportLane.branch;
 else if(args[0]==='rev-parse')stdout=sha;
 else if(args[0]==='ls-remote')stdout=sha+'\trefs/heads/'+reportLane.branch+'\n';
 execSamples.push({category,ms:performance.now()-started});return {code,stdout,stderr:''};
};
const ports={...defaultPipelinePorts(),exec,spawnAgent:async()=>{throw new Error('Audit never launches agents')},paneAgentAlive:async()=>false,conversationAgentActive:async()=>false,stageHostResident:async()=>false,stopStageAgent:async()=>({outcome:'not-running'}),stopStagePane:async()=>({outcome:'not-running'}),closeFlow:async()=>({}),durableTurnEvidence:async()=>null,conversationRegistered:()=>true};
const sessionRows=Array.from({length:24},(_,i)=>({target:'fixture-'+i,panePid:i+1,path:null,engine:'codex',title:'Fixture worker '+i,project,activity:'live',lastActiveAt:at,cwd:null,rssBytes:1024*(i+1),swapBytes:0,procCount:2}));
const activityFiles=Array.from({length:10},(_,i)=>({path:path.join(root,'generated-'+i+'.jsonl'),conversationId:'conversation_fixture_'+i,project,engine:'codex',title:'Fixture worker '+i,kind:'session',root:'codex',name:'worker-'+i,fmt:'jsonl',parent:null,mtime:Date.parse(at)/1000,size:1024,activity:'idle',proc:null,pid:null}));
const domain={...productionDomainDependencies,
 readResourcesWithDiagnostic:undefined,readResources:async()=>({system:null,sessions:sessionRows,sessionsCapturedAt:at,sessionsStale:false,viewer:null,viewerUnavailable:'not-the-viewer'}),
 refreshLifecycleJournal:()=>({appended:0}),
 livenessSources:()=>({now:()=>Date.parse(at),probe:{now:()=>Date.parse(at),pidAlive:()=>false,processIdentity:()=>null},registrySnapshot:()=>({entries:{},conversations:{}}),pipelines:()=>[],listFiles:async()=>activityFiles,describeTranscript:async()=>null,transcriptEvidence:async()=>({turn:'idle',lastRecordTs:Date.parse(at),providerProgressAt:null})}),attentionAuthority:()=>({kind:'root',conversationId:cid}),callerAttribution:()=>({kind:'agent',conversationId:cid,role:'reviewer'}),patchPipeline:(id:any,req:any,_p:any,actor:any)=>patchPipeline(id,req,ports as any,actor),reportStageCompletion:(req:any,actor:any)=>reportStageCompletion(req,actor,ports as any)};
let routeRequests=0;
const viewer=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){routeRequests++;const p=new URL(req.url).pathname;try{if(p==='/api/search/memory')return await (req.method==='POST'?memoryRoutes.POST(req):memoryRoutes.GET(req));if(p==='/api/search/transcripts')return await transcriptRoutes.GET(req);if(p==='/api/conversations')return await conversationsGET(req);if(p==='/api/files')return await filesGET(req as any);return Response.json({error:'route not exposed in audit'},{status:404});}catch{return new Response('<html>Internal server error</html>',{status:500});}}});
process.env.LLV_VIEWER_CONTROL_URL=`http://127.0.0.1:${viewer.port}`;
const timings=new serverMod.McpToolTimingAggregate();
const receipts=new serverMod.SqliteMcpReceiptStore(path.join(process.env.LLV_STATE_DIR!,'audit-receipts.sqlite'));
const bindings=viewerMcpBindings(undefined,productionViewerControlDependencies(true),domain as any);
const service=serverMod.createMcpToolService(bindings,receipts,viewerMcpToolPolicy(domain as any),{timings});
const mcp=serverMod.createViewerMcpServer(service);
const client=new Client({name:'private-audit',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([client.connect(a),mcp.connect(b)]);
const listed=await client.listTools();let common=listed.tools[0]!.description??'';for(const t of listed.tools){while(!t.description?.startsWith(common))common=common.slice(0,-1);}
const schemaCost={tools:listed.tools.length,totalTok:JSON.stringify(listed).length/4,commonPrefixChars:common.length,repeatedPrefixTok:common.length*(listed.tools.length-1)/4};
let seq=0;const measurements:any[]=[];
async function call(tool:string,fields:any,scenario:string){const args:any={clientRequestId:`audit-${++seq}`,...fields};
 // Request shape is fixed across revisions so the profile measures server behavior,
 // not a different caller input. The pinned base already supports these options.
 if(OPTIONAL_READ_KEY_TOOLS.has(tool))delete args.clientRequestId;
 if(tool==='create_pipeline')delete args.src;
 const start=performance.now();const answer:any=await runAsMcpHttpCaller({capability},()=>client.callTool({name:tool,arguments:args}));const elapsed=performance.now()-start;const result=answer.structuredContent??JSON.parse(answer.content[0].text);if(result.ok===false)console.log(JSON.stringify({refusalTool:tool,scenario,code:result.code,error:result.error}));measurements.push({tool,scenario,ms:elapsed,inTok:JSON.stringify(args).length/4,outTok:JSON.stringify(result).length/4,ok:result.ok,inputKeys:Object.keys(args).sort(),fieldNames:Object.keys(result)});return result;}
try{
 console.log('Profile: baseline begins');
 for(let i=0;i<20;i++){
  await call('get_pipeline',{pipelineId:reportLane.id,stageId:'build'},'stage');
  await call('get_pipeline',{pipelineId:reportLane.id,compact:true},'compact');
  if(i<3)await call('get_pipeline',{pipelineId:reportLane.id,full:true},'full');
  await call('get_pipeline',{pipelineId:reportLane.id},'default');
  await call('list_tasks',{project,limit:200},'limit200');
  await call('list_tasks',{project,limit:5},'limit5');
  await call('list_pipelines',{project,state:'open',limit:100},'open');
  await call('list_pipelines',{project,state:'open',limit:100,statusOnly:true},'status-only');
  await call('search_transcripts',{query:'audit',project,limit:3},'indexed3');
  await call('conversation_messages',{transcriptPath:transcript,limit:10,maxChars:1200},'page10');
  await call('resources',{},'system-summary');
  await call('agent_activity',{project},'compact');
  await call('update_task',{taskId:tasks[0]!.id,status:i%2?'inbox':'blocked'},'status');
  await call('pipeline_action',{pipelineId:lanes[0]!.id,action:'pause'},'routine');
  await call('stage_report',{verdict:'pass',summary:'Audit fixture'},'forge-fast');
 }
 await call('list_conversations',{query:'audit',limit:3},'isolated-scan');
 for(let i=0;i<3;i++){
  externalDelay=1200;
  await call('stage_report',{verdict:'pass',summary:'Audit fixture'},'forge-delay1200');
  await Promise.all([call('stage_report',{verdict:'pass',summary:'Audit fixture'},'concurrent-forge1200'),call('get_pipeline',{pipelineId:reportLane.id,stageId:'build'},'concurrent-forge1200')]);
  externalDelay=0;
 }
 for(let i=0;i<3;i++){
  const trial=findPipelineRecord(reportLane.id)!;trial.state='needs_decision';trial.cursor={stageId:'review',state:'pending',input:null,activatedBy:null} as any;trial.stages[1]!.kind='review-loop';trial.runs[1]!.attempts.at(-1)!.paneId=null;trial.runs[1]!.attempts.at(-1)!.launchId=null;trial.branch=reportLane.branch;
  trial.publication='remote-branch';trial.delivery={target:{repository:'audit-repo',branch:`refs/heads/${trial.branch}`,remote:'origin'},disposition:'owner',publish:'enabled',ownerId:trial.id,epoch:1,active:true,journal:[]} as any;
  const all=loadPipelines();all[all.findIndex(p=>p.id===trial.id)]=trial;savePipelines(all);
  externalDelay=i===0?0:1200;await call('pipeline_action',{pipelineId:trial.id,action:'retry-stage'},externalDelay?'retry-remote1200':'retry-remote-fast');externalDelay=0;
 }
 for(let i=0;i<5;i++)await call('create_pipeline',{task:'Audit admission fixture '+i,spec:'Acceptance statement. '.repeat(100),src:transcript,repoDir:process.env.COST_REPO,autoStart:false,stages:[{id:'build',kind:'run',prompt:'Audit only',next:null}]},'draft-admission');
 for(let i=0;i<2;i++){
  const target={kind:'point',project,x:0,y:0};
  const created=createAttentionRequest({rootId:'audit-root',origin:'root-agent',target,frameAtCreation:{project,rect:{x:0,y:0,w:400,h:600},boardRevision:null},intent:'show',reason:'Audit arrival',directedAt:'audit-device',directedAtSession:'audit-view'} as any);
  (domain as any).authorizedSeats=()=>[];(domain as any).findAttentionByOperation=()=>created.request;
  (domain as any).awaitAttentionArrival=(id:any,options:any)=>awaitAttentionArrival(id,options);
  const timer=setTimeout(()=>answerAttentionRequest(created.request.id,{kind:'arrive',deviceId:'audit-device',returnPoint:{deviceId:'audit-device',mode:'scheme',camera:{x:0,y:0,zoom:1},focusedPath:null,capturedAt:new Date().toISOString()},resolution:'exact'} as any),1200);
  try{await call('request_attention',{target,reason:'Audit arrival'},'browser-arrival1200');}finally{clearTimeout(timer);}
 }
 const groups=new Map<string,any[]>();for(const m of measurements){const k=m.tool+'/'+m.scenario;if(!groups.has(k))groups.set(k,[]);groups.get(k)!.push(m);}
 const q=(a:number[],p:number)=>a.toSorted((x,y)=>x-y)[Math.max(0,Math.ceil(a.length*p)-1)];
 const grouped=[...groups].map(([key,ms])=>({key,n:ms.length,ok:ms.filter(m=>m.ok).length,inputKeys:[...new Set(ms.flatMap(m=>m.inputKeys))].sort(),p50ms:+q(ms.map(m=>m.ms),.5).toFixed(2),p95ms:+q(ms.map(m=>m.ms),.95).toFixed(2),maxMs:+Math.max(...ms.map(m=>m.ms)).toFixed(2),inTokP50:q(ms.map(m=>m.inTok),.5),outTokP50:q(ms.map(m=>m.outTok),.5)}));
 if(measurements.some(m=>!m.ok))throw new Error('Measurement refused; inspect local log');
 const phases=timings.snapshot().filter(t=>t.calls).map(t=>({tool:t.toolName,calls:t.calls,phases:t.phases,outcomes:t.outcomes}));
 const output={schemaCost,seed:{tasks:107,pipelines:27,stagesPerPipeline:2,attemptsPerStage:6,transcriptMessages:1000,transcriptBytes:fs.statSync(transcript).size},transport:'MCP SDK in-memory plus loopback Viewer route handlers',grouped,phases,externalCommands:execSamples};
 fs.writeFileSync(path.join(root,'profile.json'),JSON.stringify(output,null,2));console.log(JSON.stringify({seed:output.seed,grouped},null,2));
 const faults:any[]=[];
 const originalConsoleError=console.error;
 console.error=()=>{};
 try {
 for(const scenario of ['memory-search','memory-open','transcript-search'])for(let i=0;i<3;i++){
  const state=path.join(root,'fault-state',`${scenario}-${i}`);fs.mkdirSync(state,{recursive:true});process.env.LLV_STATE_DIR=state;
  fs.writeFileSync(path.join(state,scenario.startsWith('memory')?'memory-index.sqlite':'transcript-search.sqlite'),'invalid database fixture');
  const tool=scenario.startsWith('memory')?'search_memory':'search_transcripts';
  const args=scenario==='memory-open'?{id:'m_fixture',clientRequestId:`fault-${scenario}-${i}`}:{query:'widget',clientRequestId:`fault-${scenario}-${i}`};
  routeRequests=0;const started=performance.now();
  const answer:any=await runAsMcpHttpCaller({capability},()=>client.callTool({name:tool,arguments:args}));
  const result=answer.structuredContent??JSON.parse(answer.content[0].text);
  faults.push({side:candidate?'head':'base',scenario,ms:+(performance.now()-started).toFixed(2),attempts:routeRequests,ok:result.ok===true,outputTokens:JSON.stringify(result).length/4});
 }
 } finally { console.error=originalConsoleError; }
 fs.writeFileSync(path.join(root,'faults.json'),JSON.stringify(faults,null,2));
 if(faults.some(row=>row.ok||(candidate&&row.attempts!==1)))throw new Error(`Fault acceptance failed; expected a failed verdict and one route attempt on the head: ${JSON.stringify(faults)}`);
}finally{await client.close();await mcp.close();viewer.stop(true);receipts.close();restoreTick();}
}
