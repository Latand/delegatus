import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NextRequest } from "next/server";
import { checkEnvironment } from "../../../scripts/gate-cache";
import { createGateSandbox, isolatedEnvironment } from "../../../scripts/local-gate";
import type { PipelineStageAttempt } from "@/lib/pipelines/types";
import type { PipelinePorts } from "@/lib/pipelines/engine";
import type { RecordedCheckExclusion } from "@/lib/recordedChecks/reportGate";

const original = { ...process.env };
const root = createGateSandbox();
Object.assign(process.env, isolatedEnvironment(root, checkEnvironment(process.env)));
delete process.env.LLV_SPAWN_CAPABILITY;
const { POST } = await import("@/app/api/mcp/route");
const { setMcpHttpDependenciesForTests } = await import("./http");
const { agentRegistry, closeAgentRegistryForTests } = await import("@/lib/agent/registry");
const { spawnCapabilityDigest } = await import("@/lib/agent/callerClaims");
const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
const { viewerMcpBindings, viewerMcpToolPolicy, productionDomainDependencies } = await import("./bindings");
const { createMcpToolService, SqliteMcpReceiptStore } = await import("./server");
const { registerPipelineTick } = await import("@/lib/pipelines/controllerSignal");
const { buildPipeline, savePipelines, findPipelineRecord } = await import("@/lib/pipelines/store");
const { defaultPipelinePorts, reportStageCompletion } = await import("@/lib/pipelines/engine");
const { resolvePipelineRole } = await import("@/lib/pipelines/roles");
const { RecordedCheckStore, rowSchema, recordedRootHeld } = await import("@/lib/recordedChecks/store");
const { retainResult } = await import("@/lib/recordedChecks/service");
const { descriptorSchema, terminalSchema, readEnvelope, digest } = await import("@/lib/recordedChecks/wire");
const identity = await import("@/lib/processIdentity");
const custody = await import("@/lib/runtime/signalSandboxContext");
const NOW = Date.parse("2026-11-01T12:00:00Z");
let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
  setMcpHttpDependenciesForTests(null);
  closeAgentRegistryForTests();
});
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(name: string, live: "recorder" | "wrapper" | "command" | "not-started" | null = null) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  Object.assign(process.env, isolatedEnvironment(directory, checkEnvironment(original)));
  delete process.env.LLV_SPAWN_CAPABILITY;
  const clock = spyOn(Date, "now").mockReturnValue(NOW);
  cleanups.push(() => clock.mockRestore());
  cleanups.push(registerPipelineTick(async () => {}));
  const role = resolvePipelineRole({ role: { roleId: "builder" }, engine: "codex", model: null, effort: null }, "run",
    () => ({ engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: "Fixture" })).role!;
  const pipeline = buildPipeline({ id: "report-lane", task: "Report directly verified work", project: "report-fixture", repoDir: directory,
    stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, effectiveRole: role, prompt: "Fixture", next: null }],
    srcPath: null, srcConversationId: null, now: new Date(NOW).toISOString() });
  const registry = agentRegistry();
  const conversationId = "conversation_report_worker";
  const launch = registry.beginSpawnRequest({ engine: "codex", cwd: directory, transport: "structured", conversationId,
    clientAttemptId: name, role: "builder", launchProfile: emptyLaunchProfile({ cwd: directory, project: pipeline.project, title: "Report fixture", role: "worker" }) });
  if (launch.kind !== "created") throw new Error("fixture launch refused");
  const transcript = path.join(directory, "session.jsonl");
  registry.settleSpawn(launch.receipt.launchId, { key: { engine: "codex", sessionId: "report-session" }, artifactPath: transcript,
    cwd: directory, accountId: "default", status: "unhosted", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  const capability = registry.rotateSpawnCapabilityForReceipt(launch.receipt.launchId);
  const attempt: PipelineStageAttempt = { n: 1, state: "running", effectiveRole: role, launchId: launch.receipt.launchId, conversationId,
    sessionId: "report-session", agentPath: transcript, paneId: null, flowId: null, startedAt: new Date(NOW).toISOString(),
    completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null };
  pipeline.state = "running";
  pipeline.cursor = { stageId: "build", state: "running", input: null, activatedBy: null };
  pipeline.runs = [{ stageId: "build", attempts: [attempt] }];
  savePipelines([pipeline]);

  // Real manifest, descriptor, producer report and retention writer. The child
  // exits before registration; no fabricated pid or cleanup-by-name is used.
  const log = path.join(directory, "check.log"), gate = `${log}.gate`;
  fs.mkdirSync(gate);
  const source = path.join(directory, "producer.ts");
  fs.writeFileSync(source, `
import fs from "node:fs";
import path from "node:path";
import { buildManifest, descriptorDigest, writeEnvelope, physical, custodyClock, producerReport, digest } from ${JSON.stringify(import.meta.resolve("@/lib/recordedChecks/wire"))};
import { cpuOwnerIdentity as captureProcessIdentity } from ${JSON.stringify(import.meta.resolve("@/lib/runtime/signalSandboxContext"))};
Date.now = () => ${NOW};
const directory = process.argv[2], gate = path.join(directory, "check.log.gate");
const parent = JSON.parse(process.argv[3]), live = process.argv[4];
const manifest = await buildManifest({ cwd: directory, deadline: ${NOW + 60000}, executionMs: 1000, selection: ["focused.test.ts"],
  executionEnvironment: {}, configurationDigest: digest({fixture:true}), roots: [{directory,purpose:"evidence"}],
  inputs: [{root:directory,file:"producer.ts"}], outputs: [{root:directory,file:"check.log"}], completion: {root:directory,file:"complete.json"} });
const own = captureProcessIdentity(process.pid);
const body = { version:1, runId:digest(${JSON.stringify(name)}), manifest, argv:["fixture"], recorder:live === "recorder" ? parent : own,
  directoryIdentity:physical(gate), startedAt:Date.now(), startedUptimeMs:custodyClock(), deadlineUptimeMs:manifest.deadlineUptimeMs };
const descriptor = {...body, wrapper:live === "wrapper" ? parent : own, descriptorDigest:descriptorDigest(body)};
writeEnvelope(path.join(gate,"descriptor.json"),descriptor);
writeEnvelope(path.join(gate,"owner.json"),own);
process.env.LLV_RECORDED_CHECK_DIRECTORY=gate; process.env.LLV_RECORDED_CHECK_ID=body.runId;
const report = live === "not-started" ? null : producerReport("portable", live === "command" ? parent : own, {phase:"close",cleanup:"confirmed",commandExit:1});
writeEnvelope(path.join(gate,"result.json"),{version:1,runId:body.runId,descriptorDigest:descriptor.descriptorDigest,
  wrapperExit:1,wrapperSignal:null,cancellation:null,closedAt:Date.now(),closedUptimeMs:custodyClock(),report,reports:report ? [report] : [],
  ...(live === "not-started" ? {dispatch:"not-started"} : {})});
fs.writeFileSync(path.join(gate,"exit"),"1\\n");
fs.writeFileSync(path.join(directory,"check.log"),"interrupted before visiting files\\n");
writeEnvelope(path.join(directory,"complete.json"),{selection:manifest.selection,visited:0,completed:0,outcomes:[]});
`);
  const child = spawnSync(process.execPath, [source, directory, JSON.stringify(custody.cpuOwnerIdentity(process.pid)), live ?? ""],
    { env: checkEnvironment(process.env), encoding: "utf8", timeout: 15000 });
  expect(child.status, child.stderr).toBe(0);
  const descriptor = descriptorSchema.parse(readEnvelope(path.join(gate, "descriptor.json")));
  fs.writeFileSync(path.join(directory, "direct-evidence.log"), "Isolated producer check: exit 0; descriptor decoded successfully.\n");
  let row = rowSchema.parse({ id: descriptor.runId, request: name, descriptor, log, revision: 1, admission: "refused",
    reason: "EBADF: bad file descriptor, close", result: null, notification: null, acknowledgement: null,
    binding: { project: pipeline.project, pipeline: pipeline.id, stage: "build", attempt: 1, launch: attempt.launchId,
      conversation: conversationId, session: "report-session", runtimeFence: "fixture", endpoint: "fixture",
      host: identity.captureProcessIdentity(process.pid) } });
  row = { ...row, result: (await retainResult(row)).result };
  const filename = path.join(process.env.LLV_STATE_DIR!, "state.sqlite");
  const write = () => { const store = new RecordedCheckStore(filename); try { const current = store.get(row.id); store.put(row, current?.revision ?? null); } finally { store.close(); } };
  write();
  const read = () => { const store = new RecordedCheckStore(filename, false); try { return store.get(row.id)!; } finally { store.close(); } };
  let receipts = new SqliteMcpReceiptStore(path.join(directory, "mcp.sqlite"));
  cleanups.push(() => receipts.close());
  const ports: PipelinePorts = { ...defaultPipelinePorts(), now: () => new Date(NOW).toISOString(), durableTurnEvidence: async () => null };
  const dependencies = { ...productionDomainDependencies,
    reportStageCompletion: (request: Parameters<typeof reportStageCompletion>[0], actor: Parameters<typeof reportStageCompletion>[1]) => reportStageCompletion(request, actor, ports) };
  const buildService = () => createMcpToolService(viewerMcpBindings(undefined, undefined, dependencies), receipts, viewerMcpToolPolicy(dependencies));
  let service = buildService();
  setMcpHttpDependenciesForTests({ service: async () => service,
    conversationForCapability: value => registry.conversationIdForSpawnCapabilityDigest(spawnCapabilityDigest(value)) });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => POST(new NextRequest(request)) });
  cleanups.push(() => { listener.stop(true); });
  const client = new Client({ name: "stage-report-fixture", version: "1" });
  cleanups.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", listener.url), { requestInit: { headers: { "x-llv-spawn-capability": capability } } }));
  const call = async (verdict: "pass" | "fail", key = "report", full = true) => (await client.callTool({ name: "stage_report", arguments: {
    clientRequestId: key, verdict, full, summary: "Direct isolated producer check exited 0; descriptor decoded. Evidence: direct-evidence.log.",
    ...(verdict === "fail" ? { findings: [{ severity: "P1", text: "Direct verification found an implementation defect." }] } : {}),
  } })).structuredContent as Record<string, unknown> & { excludedRecordedChecks?: RecordedCheckExclusion[] };
  return { row, read, call, pipeline, directory, ports, update: (change: Partial<typeof row>) => { row = { ...row, ...change, revision: row.revision + 1 }; write(); },
    restart: () => { receipts.close(); receipts = new SqliteMcpReceiptStore(path.join(directory, "mcp.sqlite")); service = buildService(); },
    report: () => findPipelineRecord(pipeline.id)!.runs[0].attempts[0].report };
}

for (const verdict of ["pass", "fail"] as const) {
  test(`MCP ${verdict} excludes a zero-visited EBADF receipt with confirmed cleanup and retains its evidence hold`, async () => {
    const f = await fixture(`closed-${verdict}`);
    expect(f.row.result).toMatchObject({ state: "unknown", visited: 0, completed: 0, complete: false, terminal: null });
    const before = f.read();
    const response = await f.call(verdict);
    expect(response).toMatchObject({ ok: true, report: { verdict: { status: verdict } }, excludedRecordedChecks: [{
      id: f.row.id, resultRevision: f.row.result!.revision, custody: "cleanup-confirmed", reason: expect.stringContaining("EBADF"),
    }] });
    expect(f.report()?.excludedRecordedChecks).toEqual(response.excludedRecordedChecks);
    const restartedReader = spawnSync(process.execPath, ["--eval", `
      const { findPipelineRecord } = await import(${JSON.stringify(import.meta.resolve("@/lib/pipelines/store"))});
      console.log(JSON.stringify(findPipelineRecord("report-lane").runs[0].attempts[0].report.excludedRecordedChecks));
    `], { env: checkEnvironment(process.env), encoding: "utf8", timeout: 15000 });
    expect(restartedReader.status, restartedReader.stderr).toBe(0);
    expect(JSON.parse(restartedReader.stdout)).toEqual(response.excludedRecordedChecks);
    expect(f.read()).toEqual(before);
    expect(recordedRootHeld(f.directory)).toBe(true);
    f.restart();
    expect(await f.call(verdict)).toMatchObject({ ok: true, replayed: true, excludedRecordedChecks: response.excludedRecordedChecks });
    expect(f.report()?.excludedRecordedChecks).toEqual(response.excludedRecordedChecks);
    expect(await f.call(verdict, "compact-report", false)).toMatchObject({ ok: true, excludedRecordedChecks: [{
      id: f.row.id.slice(0, 8), reason: expect.stringContaining("EBADF"), custody: "cleanup-confirmed",
    }] });
  });
  for (const live of ["recorder", "wrapper", "command"] as const) test(`MCP ${verdict} refuses a receipt with a possibly live ${live}`, async () => {
    const f = await fixture(`live-${live}-${verdict}`, live);
    expect(await f.call(verdict)).toMatchObject({ ok: false, details: { code: "STAGE_REPORT_BACKGROUND_WORK", status: 409 } });
    expect(f.report()).toBeUndefined();
    expect(f.read().acknowledgement).toBeNull();
  });
  test(`MCP ${verdict} also refuses a retained close receipt while its wrapper is live`, async () => {
    const f = await fixture(`retained-live-${verdict}`, "wrapper");
    const result = (await retainResult({ ...f.row, admission: "accepted" })).result;
    expect(result.terminal?.report).toMatchObject({ phase: "close", cleanup: "confirmed" });
    f.update({ admission: "accepted", result });
    expect(await f.call(verdict)).toMatchObject({ ok: false, details: { code: "STAGE_REPORT_BACKGROUND_WORK" } });
    expect(f.report()).toBeUndefined();
  });
  test(`MCP ${verdict} accepts retained producer cleanup custody when the terminal envelope is unavailable`, async () => {
    const f = await fixture(`retained-custody-${verdict}`);
    const { reportSchema } = await import("@/lib/recordedChecks/wire");
    const proof = reportSchema.parse(readEnvelope(path.join(`${f.row.log}.gate`, "supervisor.json")));
    f.update({ custody: [proof] });
    fs.unlinkSync(path.join(`${f.row.log}.gate`, "result.json"));
    expect(await f.call(verdict)).toMatchObject({ ok: true, excludedRecordedChecks: [{ id: f.row.id, custody: "cleanup-confirmed" }] });
  });
  test(`MCP ${verdict} uses the recorder's supported not-started proof and refuses an unsupported protocol`, async () => {
    const f = await fixture(`not-started-${verdict}`, "not-started");
    // #3558 owns this protocol addition. Run this same file with that change
    // integrated to exercise its proof, without duplicating its wire changes.
    if ("dispatch" in terminalSchema.shape) {
      expect(await f.call(verdict)).toMatchObject({ ok: true, excludedRecordedChecks: [{ id: f.row.id, custody: "not-started" }] });
    } else {
      expect(await f.call(verdict)).toMatchObject({ ok: false, details: { code: "STAGE_REPORT_BACKGROUND_WORK" } });
    }
  });
}

for (const variant of ["absent", "unknown-cleanup", "foreign", "visited", "completed", "no-result"] as const) {
  test(`MCP keeps a ${variant} receipt blocking`, async () => {
    const f = await fixture(variant);
    const file = path.join(`${f.row.log}.gate`, "result.json");
    const terminal = readEnvelope(file) as Record<string, unknown>;
    if (variant === "absent") fs.unlinkSync(file);
    else if (variant === "foreign") fs.writeFileSync(file, JSON.stringify({ ...terminal, runId: digest("foreign") }));
    else if (variant === "unknown-cleanup") {
      const report = { ...(terminal.report as object), cleanup: "unknown" };
      fs.writeFileSync(file, JSON.stringify({ ...terminal, report, reports: [report] }));
    } else if (variant === "no-result") f.update({ result: null });
    else f.update({ result: { ...f.row.result!, [variant]: 1 } });
    expect(await f.call("pass")).toMatchObject({ ok: false, details: { code: "STAGE_REPORT_BACKGROUND_WORK" } });
    expect(f.report()).toBeUndefined();
  });
}

test("unverified process identity stays blocking despite a close receipt", async () => {
  const f = await fixture("unverified", "wrapper");
  const status = spyOn(custody, "cpuOwnerStatus").mockReturnValue("unverified");
  try { expect(await f.call("pass")).toMatchObject({ ok: false, details: { code: "STAGE_REPORT_BACKGROUND_WORK" } }); }
  finally { status.mockRestore(); }
  expect(f.report()).toBeUndefined();
});

test("a retained terminal receipt with an incomplete zero-visited selection is excluded without becoming complete", async () => {
  const f = await fixture("terminal-incomplete");
  const result = (await retainResult({ ...f.row, admission: "accepted" })).result;
  expect(result).toMatchObject({ state: "terminal", complete: false, visited: 0, completed: 0 });
  f.update({ admission: "accepted", result });
  expect(await f.call("pass")).toMatchObject({ ok: true, excludedRecordedChecks: [{ id: f.row.id, custody: "cleanup-confirmed" }] });
  expect(f.read().result?.complete).toBe(false);
});

test("custody becoming unknown during the report's await refuses the final write", async () => {
  const f = await fixture("custody-race");
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.ports.durableTurnEvidence = async () => { entered(); await held; return null; };
  const response = f.call("pass");
  try {
    await waiting;
    fs.unlinkSync(path.join(`${f.row.log}.gate`, "result.json"));
    release();
    expect(await response).toMatchObject({ ok: false, details: { code: "STAGE_REPORT_BACKGROUND_WORK" } });
    expect(f.report()).toBeUndefined();
  } finally { release(); await response; }
});
