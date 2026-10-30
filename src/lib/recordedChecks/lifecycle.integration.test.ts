import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { statePath } from "@/lib/configDir";
import { publishHotStateAuthority } from "@/lib/state/hotStateAuthority";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextRequest } from "next/server";
import { buildManifest, writeEnvelope, digest, readEnvelope, descriptorSchema, descriptorDigest } from "./wire";
import { RecordedCheckStore, recordedExecutionState, recordedHostHeld, recordedRootHeld } from "./store";
import { handoffRecordedCheck, callingAttempt, verifyLiveCustody, acknowledgeRecordedCheck, cancelRecordedHost } from "./service";
import { procBackend } from "@/lib/proc";
import { RecordedCheckObserver, productionObserverPorts, startRecordedCheckObserver, stopRecordedCheckObserver, type ObserverPorts } from "./observer";
import { materializeStructuredHostAccess } from "@/lib/runtime/structuredSpawn";
import { CodexAppServerHost, readCodexConfirmedDelivery } from "@/lib/runtime/codexAppServerHost";
import { normalizeQueueEntry } from "@/lib/runtime/engineHost";
import { codexHostColumns, detachCodexHostForViewerRestart, bindCodexHostPersistence, flushStructuredHostPersistence, type StructuredHostPersistenceStop } from "@/lib/runtime/registry";
import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import type { RuntimeHostStartupRecord } from "@/runtime-host/runtimeHostStartup";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { AgentRegistry, agentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { buildPipeline, findPipelineRecord, savePipelines } from "@/lib/pipelines/store";
import { defaultPipelinePorts, reportStageCompletion, tickPipelines } from "@/lib/pipelines/engine";
import { registerPipelineTick } from "@/lib/pipelines/controllerSignal";
import type { PipelineStageAttempt } from "@/lib/pipelines/types";
import { resolvePipelineRole } from "@/lib/pipelines/roles";
import { AttemptTempStore, sweepAttemptTemps } from "@/lib/runtime/attemptTempRetention";
import { attemptTempState } from "@/lib/runtime/attemptTempProduction";
import { signalFixtureIdentity, stopFixtureIdentity, stopFixtureProcess, ownFixtureTree } from "@/lib/testing/fixtureProcess";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { waitForGate } from "../../../scripts/gate-wait";
import { checkEnvironment } from "../../../scripts/gate-cache";
import { createGateSandbox, isolatedEnvironment } from "../../../scripts/local-gate";
import { withoutInheritedGate } from "@/lib/testing/inheritedGateEnv";
import { credentialFreeSocketFixture } from "./native.fixture";
import * as wire from "./wire";
import * as ledger from "./store";
import { recordedCheck } from "./api";
import * as delivery from "@/lib/delivery";
import { enqueueStructuredMessage } from "@/lib/runtime/structuredMessageDelivery";

const original = { ...process.env };
const roots: string[] = [], children: ChildProcess[] = [], hosts: CodexAppServerHost[] = [], observers: RecordedCheckObserver[] = [];
const logs: string[] = [], nativeOwners: ProcessIdentity[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
const persistence: StructuredHostPersistenceStop[] = [];
const projections: Array<() => void> = [];
const controllerIdentities = new WeakMap<ChildProcess, ProcessIdentity>();
const controllerDiagnostics = new WeakMap<ChildProcess, () => string>();
afterEach(async () => {
  stopRecordedCheckObserver();
  for (const observer of observers.splice(0)) observer.stop();
  for (const log of logs.splice(0)) {
    try {
      const descriptor = descriptorSchema.parse(readEnvelope(path.join(`${log}.gate`, "descriptor.json")));
      if (signalFixtureIdentity(descriptor.recorder, "SIGTERM")) await waitForGate(log, 5000);
    } catch { /* Failed fixtures still stop only the native identities recorded below. */ }
  }
  for (const host of hosts.splice(0)) await host.release().catch(() => {});
  for (const owner of nativeOwners.splice(0)) await stopFixtureIdentity(owner, 5000);
  for (const child of children.splice(0)) await stopFixtureProcess(child);
  for (const stop of persistence.splice(0)) await stop();
  for (const server of servers.splice(0)) server.stop(true);
  for (const restore of projections.splice(0)) restore();
  setAgentRegistryForTests(null);
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function observed(directory: string, predicate: () => boolean, budget = 30_000, label = "fixture") {
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); watcher?.close(); error ? reject(error) : resolve(); };
    const check = () => { try { if (predicate()) finish(); } catch (error) { finish(error as Error); } };
    const timer = setTimeout(() => finish(new Error(`isolated recorded-check ${label} observation expired`)), budget);
    const watcher = fs.watch(directory, check); watcher.on("error", finish); check();
  });
}
async function idle(host: CodexAppServerHost) {
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {}, settled = false;
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("native fixture turn did not finish")); }, 30_000);
    unsubscribe = host.onStateChange(state => {
      if (!state.activeTurnRef) { settled = true; clearTimeout(timer); unsubscribe(); resolve(); }
    });
    if (settled) unsubscribe();
  });
}
const detail = (error: unknown) => error instanceof Error ? error.stack ?? error.message : String(error);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function fixture(queued: boolean, bootRuntime = false) {
  projections.push(credentialFreeSocketFixture());
  const sandbox = createGateSandbox(); roots.push(sandbox);
  const env = withoutInheritedGate(isolatedEnvironment(sandbox, checkEnvironment(process.env)));
  env.LLV_CODEX_HOME = env.CODEX_HOME;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recorded-native-")); roots.push(root);
  const role = resolvePipelineRole({ role: { roleId: "builder" }, engine: "codex", model: null, effort: null }, "run",
    () => ({ engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: "Fixture build contract." })).role;
  if (!role) throw new Error("fixture build role was not resolved");
  const pipeline = buildPipeline({ id: "recorded-lane", task: "Recorded custody", project: "fixture", repoDir: root,
    stages: [{ id: "build", kind: "run", role: { roleId: "builder" }, prompt: "Fixture", next: null, effectiveRole: role }], srcPath: null, srcConversationId: null, now: "2026-10-29T12:00:00Z" });
  fs.mkdirSync(pipeline.worktreeDir); roots.push(pipeline.worktreeDir);
  const runtime = bootRuntime ? await runtimeFixture(root) : null;
  const registry = new AgentRegistry(undefined, undefined, undefined, { resolveBackendIdentity: true }); setAgentRegistryForTests(registry);
  const capability = randomBytes(32).toString("base64url");
  const created = registry.beginSpawnRequest({ engine: "codex", cwd: pipeline.worktreeDir, transport: "structured", explicitProject: "fixture",
    spawnCapabilityDigest: createHash("sha256").update(capability).digest("hex"),
    launchProfile: { cwd: pipeline.worktreeDir, role: "worker", title: "Recorded check fixture" } });
  if (created.kind !== "created") throw new Error("fixture spawn admission failed");
  const launch = created.receipt;
  const access = materializeStructuredHostAccess({ readOnly: false, sandbox: "full" }, env, null, pipeline.worktreeDir,
    { pipelineId: "recorded-lane", launchId: launch.launchId, retainUntilClose: false });
  if (access.env.LLV_AGENT_SANDBOX_ROOT) roots.push(access.env.LLV_AGENT_SANDBOX_ROOT);
  const work = access.scratchDirectory!, tmp = access.env.TMPDIR!;
  const locks = path.join(root, "locks"); fs.mkdirSync(locks);
  let lock: ChildProcess | undefined;
  if (queued) {
    lock = spawn("/bin/bash", ["-c", 'exec 9>"$1"; /usr/bin/flock 9; echo ready; read -r release', "holder", path.join(locks, "llv-heavy-gate.slot1.lock")], { stdio: ["pipe", "pipe", "pipe"] });
    children.push(lock); lock.stderr!.resume(); await once(lock.stdout!, "data");
  }
  const script = path.join(tmp, "command.ts"), log = path.join(tmp, "check.log"), manifestFile = path.join(tmp, "manifest.json");
  logs.push(log);
  fs.writeFileSync(script, `import fs from "node:fs";import path from "node:path";
const directory=import.meta.dir;
fs.appendFileSync(path.join(directory,"executions"),"run\\n");
fs.writeFileSync(path.join(directory,"started"),"ready");
await new Promise<void>((resolve,reject)=>{const watcher=fs.watch(directory,()=>check());const timer=setTimeout(()=>{watcher.close();reject(new Error("fixture command deadline"))},180000);function check(){if(fs.existsSync(path.join(directory,"release"))){clearTimeout(timer);watcher.close();resolve()}}check()});
fs.writeFileSync(path.join(directory,"final.patch"),"retained late patch\\n");
fs.writeFileSync(path.join(directory,"complete.tmp"),JSON.stringify({selection:["owned-check"],visited:1,completed:1,outcomes:[{name:"owned-check",exit:23}]}));
fs.renameSync(path.join(directory,"complete.tmp"),path.join(directory,"complete.json"));
console.log("RAN_COUNT 1/1");process.exitCode=23;`);
  const manifest = await buildManifest({ cwd: work, deadline: Date.now() + 240_000, executionMs: 180_000, selection: ["owned-check"],
    executionEnvironment: access.env,
    configurationDigest: digest({ fixture: true }), roots: [{ directory: work, purpose: "evidence" }],
    inputs: [{ root: work, file: "tmp/command.ts" }], outputs: [{ root: work, file: "tmp/final.patch" }], completion: { root: work, file: "tmp/complete.json" } });
  writeEnvelope(manifestFile, manifest);
  let calls = 0;
  let finishTurn = () => {};
  const finalReply = new Promise<void>(resolve => { finishTurn = resolve; });
  const fixtureGate = `env LLV_GATE_BUN=${quote(process.execPath)} LLV_GATE_LOCK_DIR=${quote(locks)} LLV_GATE_SLOTS=1 LLV_GATE_POLL_SECONDS=0.02 DELEGATUS_CPU_PRESSURE=off DELEGATUS_AGENT_CPU=off`;
  const cmd = `cd ${quote(work)} && ${fixtureGate} ${quote("/bin/bash")} ${quote(path.resolve("scripts/gate-slot.sh"))} --record ${quote(log)} --manifest ${quote(manifestFile)} -- ${quote(process.execPath)} ${quote(script)}`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    await request.arrayBuffer();
    const first = calls++ === 0;
    if (!first) await finalReply;
    const item = first ? { type: "function_call", name: "exec_command", call_id: "recorded-fixture", arguments: JSON.stringify({ cmd, yield_time_ms: 1000, max_output_tokens: 1000 }) }
      : { type: "message", role: "assistant", id: `fixture-message-${calls}`, content: [{ type: "output_text", text: "Checkpoint" }] };
    const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
    return new Response(event("response.created", { response: { id: `response-${calls}` } }) + event("response.output_item.done", { output_index: 0, item })
      + event("response.completed", { response: { id: `response-${calls}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }), { headers: { "content-type": "text/event-stream" } });
  } });
  servers.push(server);
  const codex = env.CODEX_HOME!;
  fs.writeFileSync(path.join(codex, "config.toml"), `model="fixture-model"\nmodel_provider="fixture"\nweb_search="disabled"\n[model_providers.fixture]\nname="Local fixture"\nbase_url="http://127.0.0.1:${server.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n[analytics]\nenabled=false\n[features]\napps=false\nplugins=false\n`);
  const binary = process.env.LLV_CODEX_BINARY ?? Bun.which("codex");
  if (!binary) throw new Error("native Codex binary is required for custody acceptance");
  const options = { cwd: pipeline.worktreeDir, codexHome: codex, binary, model: "fixture-model", approvalPolicy: "never", cleanMemory: true,
    ...access.codex, ...access.host, env: { ...access.env, LLV_GATE_BUN: process.execPath, LLV_GATE_LOCK_DIR: locks, LLV_GATE_SLOTS: "1",
      LLV_GATE_POLL_SECONDS: "0.02", DELEGATUS_CPU_PRESSURE: "off", DELEGATUS_AGENT_CPU: "off" } };
  const host = await CodexAppServerHost.start(options); hosts.push(host);
  const nativeOwner = codexHostColumns(await host.health(), 1).process;
  if (!nativeOwner) throw new Error("native fixture owner was not captured");
  nativeOwners.push(nativeOwner);
  await host.send({ id: "fixture-command", text: "Run the owned fixture command once and checkpoint." });
  await observed(tmp, () => fs.existsSync(`${log}.gate`));
  try {
    await observed(`${log}.gate`, () => fs.existsSync(path.join(`${log}.gate`, queued ? "queued" : "supervisor.json")));
    if (!queued) await observed(tmp, () => fs.existsSync(path.join(tmp, "started")));
  } catch (error) { throw new Error(detail(error) + "\n" + fs.readFileSync(log, "utf8").slice(-16_384)); }
  const identity = host.identity;
  if (!identity.path) throw new Error("native fixture did not publish its transcript");
  const key = { engine: "codex" as const, sessionId: identity.threadId };
  const settled = registry.settleSpawn(launch.launchId, { key, artifactPath: identity.path, cwd: pipeline.worktreeDir, accountId: null, status: "live", host: null,
    structuredHost: codexHostColumns(await host.health(), 1), claimEpoch: 0, claimOwner: null, pendingAction: null });
  if (settled.kind === "conflict") throw new Error(settled.code);
  const columns = codexHostColumns(await host.health(), 1);
  const claimed = registry.claimStructuredHost(key, captureProcessIdentity(process.pid), {
    reconnectCodex: { endpoint: columns.endpoint, process: nativeOwner },
  });
  if (!claimed?.claimOwner) throw new Error("fixture native writer claim was refused");
  persistence.push(await bindCodexHostPersistence(registry, key, host, claimed.claimOwner, claimed.claimEpoch));
  registry.rememberMembership(launch.conversationId, { kind: "pipeline", containerId: "recorded-lane", role: "builder", slot: "build:1", stageId: "build", stageOrder: 0, round: 1, parentConversationId: null });
  pipeline.state = "running"; pipeline.cursor = { stageId: "build", state: "running", input: null, activatedBy: null };
  const attempt: PipelineStageAttempt = { n: 1, state: "running", launchId: launch.launchId, effectiveRole: role,
    conversationId: launch.conversationId, sessionId: identity.threadId, agentPath: identity.path, paneId: null, flowId: null,
    startedAt: "2026-10-29T12:00:00Z", completedAt: null, input: null, activatedBy: null, output: null, verdict: null, error: null };
  pipeline.runs = [{ stageId: "build", attempts: [attempt] }]; savePipelines([pipeline]);
  return { root, work, tmp, log, manifest, launch, host, options, pipeline, attempt, registry, lock, server, capability, runtime, finishTurn, calls: () => calls,
    cleanup: () => { finishTurn(); server.stop(true); } };
}

async function checkpoint(f: Awaited<ReturnType<typeof fixture>>, ports = defaultPipelinePorts()) {
  let pending = Promise.resolve();
  const tick = () => pending = pending.then(async () => { await tickPipelines([], ports); });
  const unregister = registerPipelineTick(tick);
  try {
    const report = await reportStageCompletion({ verdict: "needs_decision", summary: "Owned check held by a durable custody receipt." },
      { kind: "agent", role: "builder", conversationId: f.launch.conversationId });
    expect(report.report).toBeDefined();
    f.finishTurn(); await idle(f.host); await flushStructuredHostPersistence(f.host);
    await tick();
    // The real provenance completion wakes the registered controller. A file
    // event observes settlement without inventing repeated controller ticks.
    await observed(path.dirname(statePath("state.sqlite")), () => findPipelineRecord(f.pipeline.id)?.state === "needs_decision");
  } finally { unregister(); await pending; }
}

function fixtureChild(file: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = ownFixtureTree(spawn(process.execPath, [file, ...args], { env, stdio: ["pipe", "pipe", "pipe"] }));
  if (child.pid) controllerIdentities.set(child, captureProcessIdentity(child.pid));
  children.push(child);
  let errors = "";
  child.stderr!.on("data", chunk => { errors = (errors + String(chunk)).slice(-16_384); });
  controllerDiagnostics.set(child, () => errors);
  child.stdout!.resume();
  return { child, errors: () => errors };
}

async function runtimeFixture(root: string) {
  const socket = path.join(root, "runtime.sock"), ready = path.join(root, "runtime-ready.json");
  const client = new UnixRuntimeHostClient(socket);
  const env = { ...process.env, LLV_RUNTIME_HOST_SOCKET: socket, LLV_RUNTIME_HOST_FENCE: path.join(root, "runtime.fence"),
    LLV_RUNTIME_JOURNAL: path.join(root, "runtime.sqlite"), LLV_RUNTIME_HOST_STARTUP_TARGET: ready,
    LLV_VIEWER_DEPLOYMENTS: "0", LLV_RUNTIME_LEGACY_SCHEDULER: "0" };
  const boot = async () => {
    const run = fixtureChild(path.resolve("src/runtime-host/main.ts"), [], env);
    try {
      await observed(root, () => {
        if (run.child.exitCode !== null) throw new Error(run.errors());
        if (!fs.existsSync(ready)) return false;
        const state = JSON.parse(fs.readFileSync(ready, "utf8")) as RuntimeHostStartupRecord;
        return state.pid === run.child.pid && state.phases.some(phase => phase.phase === "ready");
      });
    } catch (error) { throw new Error(detail(error) + "\n" + run.errors()); }
    return run.child;
  };
  let child = await boot();
  process.env.LLV_RUNTIME_HOST_SOCKET = socket;
  await client.append({ scope: "system:recorded-fixture", kind: "reconcile.drift", payload: { retained: true },
    producer: { kind: "recorded-fixture", eventKey: "one-checkpoint" } });
  return { client, async restart() {
    const before = await client.snapshot();
    await stopFixtureProcess(child); child = await boot();
    expect((await client.snapshot()).runtime.hostEpoch).toBeGreaterThan(before.runtime.hostEpoch);
    expect((await client.events(0)).events.filter(event => event.producer.eventKey === "one-checkpoint")).toHaveLength(1);
  } };
}

for (const queued of [true, false]) test(`native ${queued ? "queued" : "running"} check retains late evidence across a checkpoint and process restarts`, async () => {
  const f = await fixture(queued);
  let receiptId: string | undefined;
  const delivered: string[] = [];
  const ports: ObserverPorts = { active: () => true, recipient: () => ({ conversation: f.launch.conversationId, path: f.host.identity.path! }),
    async deliver(row) {
      const notice = row.notification!;
      const entry = normalizeQueueEntry({ id: notice.key, text: notice.text });
      const existing = await readCodexConfirmedDelivery(f.host.identity.path!, entry);
      if (!existing) await f.host.send({ id: notice.key, text: notice.text });
      const confirmed = await readCodexConfirmedDelivery(f.host.identity.path!, entry);
      if (confirmed) delivered.push(notice.key);
      return { operation: notice.key, state: confirmed ? "delivered" : "uncertain", reason: null };
    } };
  const observer = new RecordedCheckObserver(ports); observers.push(observer);
  try {
    const row = await handoffRecordedCheck(f.launch.conversationId, "native-check", f.log,
      { binding: callingAttempt, verify: verifyLiveCustody, observe: id => observer.observe(id) });
    receiptId = row.id;
    expect(row.admission, row.reason).toBe("accepted");
    expect(recordedExecutionState(row)).toBe("active");
    expect(recordedExecutionState(null)).toBe("unknown");
    expect(recordedHostHeld(f.launch.conversationId)).toBeTrue();
    await expect(f.host.release()).rejects.toThrow("recorded check custody");
    expect(recordedRootHeld(f.work)).toBeTrue();
    const premature = await reportStageCompletion({ verdict: "pass", summary: "Fixture checks complete." },
      { kind: "agent", role: "builder", conversationId: f.launch.conversationId });
    expect(premature.code).toBe("STAGE_REPORT_BACKGROUND_WORK");
    if (queued) {
      // Capacity is durable; a fresh writer receives the same refusal. These
      // copied protocol rows never become process-custody admissions.
      for (const sharedLaunch of [true, false]) {
        const configuration = path.join(f.root, "store-input.json"), output = path.join(f.root, "store-output.json");
        const filename = path.join(f.root, sharedLaunch ? "attempt-cap.sqlite" : "installation-cap.sqlite");
        const limit = sharedLaunch ? 4 : 128;
        for (const [start, count] of [[0, limit], [limit, 1]]) {
          writeEnvelope(configuration, { filename, output, row, start, count, sharedLaunch });
          const run = fixtureChild(path.resolve("src/lib/recordedChecks/store.process.fixture.ts"), [configuration], process.env);
          const [code] = await once(run.child, "exit");
          expect(code, run.errors()).toBe(0);
          const answer = readEnvelope(output) as { count: number; refusal: string | null; rootsHeld: boolean };
          expect(answer.count).toBe(limit);
          expect(answer.rootsHeld).toBeTrue();
          if (start) expect(answer.refusal).toContain("capacity"); else expect(answer.refusal).toBeNull();
        }
      }
    }
    await checkpoint(f);
    expect(findPipelineRecord(f.pipeline.id)?.state).toBe("needs_decision");
    observer.stop();
    // The isolated seat and stage share a native fixture thread. Completion
    // still goes through the production seat resolver and journal sender.
    beginOrchestratorSeatIntent({ project: "fixture", mandate: "coordinate", mode: "existing", clientRequestId: "fixture-seat" });
    completeOrchestratorSeatIntent({ project: "fixture", clientRequestId: "fixture-seat", conversationId: f.launch.conversationId, path: f.host.identity.path! });
    expect(await detachCodexHostForViewerRestart(f.registry, { engine: "codex", sessionId: f.host.identity.threadId }, f.host)).toBeTrue();
    const runtime = await runtimeFixture(f.root);
    const ready = path.join(f.root, "observer-ready.json"), deliveries = path.join(f.root, "deliveries");
    const deliveredBeforeReceipt = path.join(f.root, "delivered-before-receipt.json");
    const configuration = path.join(f.root, "observer.json");
    writeEnvelope(configuration, { options: f.options, ready, deliveries, conversation: f.launch.conversationId,
      pauseAfterDelivery: queued ? deliveredBeforeReceipt : undefined });
    const boot = async () => {
      const run = fixtureChild(path.resolve("src/lib/recordedChecks/observer.process.fixture.ts"), [configuration], process.env);
      try {
        await observed(f.root, () => {
          if (run.child.exitCode !== null) throw new Error(run.errors());
          return fs.existsSync(ready) && (readEnvelope(ready) as { controller: number }).controller === run.child.pid;
        });
      } catch (error) { throw new Error(detail(error) + "\n" + run.errors()); }
      if (recordedHostHeld(f.launch.conversationId))
        expect((readEnvelope(ready) as { owner: ProcessIdentity }).owner).toEqual(nativeOwners.at(-1)!);
      const ledger = new RecordedCheckStore();
      try {
        await observed(path.dirname(ledger.filename), () => ledger.get(row.id)?.observation?.owner.pid === run.child.pid, 30_000, "controller observation claim");
        expect(ledger.get(row.id)?.observation?.owner.pid).toBe(run.child.pid!);
      }
      finally { ledger.close(); }
      return run.child;
    };
    const firstController = await boot();
    expect(signalFixtureIdentity(controllerIdentities.get(firstController)!, "SIGKILL")).toBeTrue();
    await once(firstController, "exit");
    await runtime.restart();
    let controller = await boot();
    expect(f.calls()).toBe(2);
    const temps = new AttemptTempStore();
    try {
      const before = await sweepAttemptTemps(temps, { state: attemptTempState, capBytes: 0, scan: () => ({ ownNamespace: null, processes: [] }) });
      expect(before.removed).toBe(0); expect(fs.existsSync(f.work)).toBeTrue();
      f.lock?.stdin!.end("release\n");
      await observed(f.tmp, () => fs.existsSync(path.join(f.tmp, "started")));
      if (!queued) await stopFixtureProcess(controller, 5000, 10_000);
      fs.writeFileSync(path.join(f.tmp, "release"), "release");
      await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
      if (queued) {
        await observed(f.root, () => fs.existsSync(deliveredBeforeReceipt), 30_000, "native delivery before receipt commit");
        const pending = new RecordedCheckStore();
        try { expect(pending.get(row.id)?.notification?.state).not.toBe("delivered"); }
        finally { pending.close(); }
        expect(signalFixtureIdentity(controllerIdentities.get(controller)!, "SIGKILL")).toBeTrue();
        await once(controller, "exit"); await runtime.restart(); controller = await boot();
      }
      if (!queued) {
        const terminal = path.join(`${f.log}.gate`, "result.json"), held = path.join(f.root, "withheld-result.json");
        fs.renameSync(terminal, held);
        controller = await boot();
        await observed(f.root, () => fs.existsSync(deliveries), 30_000, "unknown result delivery");
        const store = new RecordedCheckStore();
        let stale: NonNullable<ReturnType<RecordedCheckStore["get"]>>;
        try {
          stale = store.get(row.id)!;
          expect(stale.result?.state).toBe("unknown");
          expect(stale.result?.terminal).toBeNull();
          expect(recordedRootHeld(f.work)).toBeTrue();
          fs.renameSync(held, terminal);
          await observed(path.dirname(store.filename), () => store.get(row.id)?.result?.state === "terminal", 30_000, "late terminal revision");
          await expect(acknowledgeRecordedCheck(stale, f.launch.conversationId, {
            resultRevision: stale.result!.revision, resultDigest: stale.result!.digest,
            evidenceDigest: stale.result!.evidenceDigest, disposition: "adopt-retained",
          })).rejects.toThrow("stale");
        } finally { store.close(); }
      }
      await observed(f.root, () => fs.existsSync(deliveries), 30_000, "completion delivery");
      await stopFixtureProcess(controller, 5000, 10_000);
      await runtime.restart();
      // A fresh process must recover the completed notification without sending it again.
      const replayController = await boot();
      await stopFixtureProcess(replayController, 5000, 10_000);
      expect(f.calls()).toBe(3);
      const store = new RecordedCheckStore();
      try {
        const finished = store.get(row.id)!;
        expect(finished.result?.terminal?.wrapperExit).toBe(23);
        expect(finished.result?.terminal?.report?.commandExit).toBe(23);
        expect(finished.result?.terminal?.report?.cleanup).toBe("confirmed");
        expect(finished.result?.complete, finished.result?.reason).toBeTrue();
        expect(finished.result?.completed).toBe(1);
        expect(recordedExecutionState(finished)).toBe("completed");
        expect(finished.result?.failed).toBe(1);
        expect(fs.readFileSync(path.join(f.tmp, "executions"), "utf8")).toBe("run\n");
        expect(fs.readFileSync(path.join(f.tmp, "final.patch"), "utf8")).toBe("retained late patch\n");
        expect(recordedHostHeld(f.launch.conversationId)).toBeFalse();
        expect(recordedRootHeld(f.work)).toBeTrue();
        expect(fs.readFileSync(deliveries, "utf8")).toBe(`recorded-check:${row.id}\n`);
        const unread = await sweepAttemptTemps(temps, { state: attemptTempState, capBytes: 0,
          now: () => Date.now() + 120_000, scan: () => ({ ownNamespace: null, processes: [] }) });
        expect(unread.removed).toBe(0);
        expect(fs.existsSync(f.work)).toBeTrue();
        const result = store.get(row.id)!.result!;
        await expect(acknowledgeRecordedCheck(store.get(row.id)!, f.launch.conversationId,
          { resultRevision: result.revision - 1, resultDigest: result.digest, evidenceDigest: result.evidenceDigest, disposition: "adopt-retained" })).rejects.toThrow("stale");
        const acknowledged = await acknowledgeRecordedCheck(store.get(row.id)!, f.launch.conversationId,
          { resultRevision: result.revision, resultDigest: result.digest, evidenceDigest: result.evidenceDigest, disposition: "adopt-retained" });
        expect(acknowledged.acknowledgement).not.toBeNull();
        expect(recordedRootHeld(f.work)).toBeFalse();
        expect(store.page()).toEqual([]);
        expect(store.get(row.id)?.notification?.state).toBe("delivered");
        // The original owner is stopped only after its own terminal receipt.
        await stopFixtureIdentity(nativeOwners.at(-1)!, 5000);
        const after = await sweepAttemptTemps(temps, { state: attemptTempState, capBytes: 0,
          now: () => Date.now() + 240_000, scan: () => ({ ownNamespace: null, processes: [] }) });
        expect(after.errors).toBe(0);
        expect(fs.existsSync(f.work)).toBeFalse();
        const retirement = store.rootRetirement(f.work, f.manifest.roots.find(root => root.directory === f.work)!.identity) as {
          intent: { state: string; journal: string }; outcome: { state: string; reason: string; resultRevision: number };
        };
        expect(retirement.intent.state).toBe("admitted");
        expect(retirement.intent.journal).not.toBe("");
        expect(retirement.outcome.state).toBe("completed");
        expect(retirement.outcome.reason.length).toBeLessThanOrEqual(1024);
        expect(retirement.outcome.resultRevision).toBe(result.revision);
        expect(store.get(row.id)?.result?.digest).toBe(result.digest);
      } finally { store.close(); }
    } finally { temps.close(); }
  } catch (error) {
    const store = new RecordedCheckStore();
    try {
      const row = receiptId ? store.get(receiptId) : null;
      throw new Error(`${detail(error)}\n${JSON.stringify({ result: row?.result?.state, complete: row?.result?.complete,
        reason: row?.result?.reason, notification: row?.notification, nativeCalls: f.calls() })}\n${children.map(child => controllerDiagnostics.get(child)?.() ?? "").join("\n").slice(-16_384)}`);
    } finally { store.close(); }
  } finally { f.cleanup(); }
}, 270_000);

test("an unread terminal result retains its production roots through a real scratch sweep", async () => {
  const f = await fixture(false);
  const observer = new RecordedCheckObserver({ active: () => true, recipient: () => null,
    deliver: async () => { throw new Error("unreserved completion must not send"); } });
  observers.push(observer);
  const temps = new AttemptTempStore(), store = new RecordedCheckStore();
  try {
    const row = await handoffRecordedCheck(f.launch.conversationId, "unread-check", f.log,
      { binding: callingAttempt, verify: verifyLiveCustody, observe: id => observer.observe(id) });
    expect(row.admission, row.reason).toBe("accepted");
    await checkpoint(f);
    expect(findPipelineRecord(f.pipeline.id)?.state).toBe("needs_decision");
    fs.writeFileSync(path.join(f.tmp, "release"), "release");
    await observed(path.dirname(store.filename), () => store.get(row.id)?.result?.complete === true);
    expect(store.get(row.id)?.result?.terminal?.report?.commandExit).toBe(23);
    expect(fs.readFileSync(path.join(f.tmp, "executions"), "utf8")).toBe("run\n");
    await stopFixtureIdentity(row.binding.host, 5000);
    const sweep = await sweepAttemptTemps(temps, { state: attemptTempState, capBytes: 0,
      now: () => Date.now() + 120_000, scan: () => ({ ownNamespace: null, processes: [] }) });
    expect(sweep.removed).toBe(0);
    expect(fs.existsSync(f.work)).toBeTrue();
    expect(recordedRootHeld(f.work)).toBeTrue();
    expect(fs.readFileSync(path.join(f.tmp, "final.patch"), "utf8")).toBe("retained late patch\n");
    await observer.observe(row.id); observer.stop();
    const authorityDirectory = path.dirname(statePath("state.sqlite"));
    const beforeEpoch = publishHotStateAuthority(authorityDirectory, "sqlite", null);
    fs.appendFileSync(path.join(f.tmp, "final.patch"), "late epoch evidence\n");
    const writeBeforeEpoch = RecordedCheckStore.prototype.write;
    let changedEpoch = false;
    const epochRace = spyOn(RecordedCheckStore.prototype, "write").mockImplementation(async function (this: RecordedCheckStore, updated, expected, authority) {
      if (updated.id === row.id && updated.result && updated.result.revision > store.get(row.id)!.result!.revision) {
        publishHotStateAuthority(authorityDirectory, "sqlite", null, { epoch: beforeEpoch.epoch + 1 }); changedEpoch = true;
      }
      return writeBeforeEpoch.call(this, updated, expected, authority);
    });
    const epochObserver = new RecordedCheckObserver({ active: () => true, recipient: () => null,
      deliver: async () => { throw new Error("unreserved completion must not send"); } });
    observers.push(epochObserver);
    try {
      await expect(epochObserver.observe(row.id)).rejects.toThrow("observer epoch changed");
      expect(changedEpoch).toBeTrue();
      expect(recordedRootHeld(f.work)).toBeTrue();
    } finally { epochRace.mockRestore(); epochObserver.stop(); }
    for (const location of ["original", "canonical"] as const) {
      const reconcile = new RecordedCheckObserver({ active: () => true, recipient: () => null,
        deliver: async () => { throw new Error("unreserved completion must not send"); } });
      observers.push(reconcile); await reconcile.observe(row.id); reconcile.stop();
      const current = store.get(row.id)!, result = current.result!;
      const file = location === "original" ? path.join(f.tmp, "final.patch")
        : statePath("evidence", "recorded-checks", current.binding.pipeline, row.id, digest(path.join(f.tmp, "final.patch")));
      const write = RecordedCheckStore.prototype.write;
      let mutated = false;
      const race = spyOn(RecordedCheckStore.prototype, "write").mockImplementation(async function (this: RecordedCheckStore, updated, expected, authority) {
        if (updated.id === row.id && updated.acknowledgement) {
          fs.appendFileSync(file, "late evidence change\n"); mutated = true;
        }
        return write.call(this, updated, expected, authority);
      });
      try {
        await expect(acknowledgeRecordedCheck(current, f.launch.conversationId, {
          resultRevision: result.revision, resultDigest: result.digest, evidenceDigest: result.evidenceDigest, disposition: "adopt-retained",
        })).rejects.toThrow("changed after retention");
        expect(mutated).toBeTrue();
        expect(store.get(row.id)?.acknowledgement).toBeNull();
        expect(recordedRootHeld(f.work)).toBeTrue();
      } finally { race.mockRestore(); }
      const refresh = new RecordedCheckObserver({ active: () => true, recipient: () => null,
        deliver: async () => { throw new Error("unreserved completion must not send"); } });
      observers.push(refresh); await refresh.observe(row.id); refresh.stop();
    }
    const current = store.get(row.id)!, result = current.result!;
    await acknowledgeRecordedCheck(current, f.launch.conversationId, {
      resultRevision: result.revision, resultDigest: result.digest, evidenceDigest: result.evidenceDigest, disposition: "adopt-retained",
    });
    expect(recordedRootHeld(f.work)).toBeFalse();
  } finally { store.close(); temps.close(); f.cleanup(); }
}, 150_000);

test("a real registration process crash leaves the original preparing reservation recoverable by a fresh process", async () => {
  const f = await fixture(true), configuration = path.join(f.root, "preparation.json"), ready = path.join(f.root, "preparation-ready.json");
  const file = path.resolve("src/lib/recordedChecks/handoff.process.fixture.ts");
  const descriptor = descriptorSchema.parse(readEnvelope(path.join(`${f.log}.gate`, "descriptor.json")));
  const store = new RecordedCheckStore();
  try {
    const input = { mode: "prepare", conversation: f.launch.conversationId, log: f.log, request: "preparing-check", id: descriptor.runId, ready };
    writeEnvelope(configuration, input);
    const preparing = fixtureChild(file, [configuration], process.env);
    await observed(f.root, () => {
      if (preparing.child.exitCode !== null) throw new Error(preparing.errors());
      return fs.existsSync(ready);
    });
    expect(store.get(descriptor.runId)?.admission).toBe("preparing");
    expect(recordedRootHeld(f.work)).toBeTrue();
    expect(recordedHostHeld(f.launch.conversationId)).toBeTrue();
    expect(signalFixtureIdentity(controllerIdentities.get(preparing.child)!, "SIGKILL")).toBeTrue();
    await once(preparing.child, "exit");
    await checkpoint(f);
    const recoveredFile = path.join(f.root, "recovered-preparation.json");
    writeEnvelope(configuration, { ...input, mode: "recover", ready: recoveredFile });
    const recovering = fixtureChild(file, [configuration], process.env);
    const [code] = await once(recovering.child, "exit");
    expect(code, recovering.errors()).toBe(0);
    const recovered = store.get(descriptor.runId)!;
    expect(recovered.admission, recovered.reason).toBe("accepted");
    expect(recovered.descriptor.descriptorDigest).toBe(descriptor.descriptorDigest);
    expect(recovered.descriptor.deadlineUptimeMs).toBe(descriptor.deadlineUptimeMs);
    expect(recovered.observation?.owner.pid).toBe(recovering.child.pid!);
    expect(fs.existsSync(path.join(f.tmp, "executions"))).toBeFalse();
    f.lock!.stdin!.end("release\n"); fs.writeFileSync(path.join(f.tmp, "release"), "release");
    await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
    const observer = new RecordedCheckObserver({ active: () => true, recipient: () => null,
      deliver: async () => { throw new Error("unreserved completion must not send"); } });
    observers.push(observer); await observer.observe(descriptor.runId); observer.stop();
    expect(store.get(descriptor.runId)?.result?.terminal?.report?.commandExit).toBe(23);
    expect(fs.readFileSync(path.join(f.tmp, "executions"), "utf8")).toBe("run\n");
  } finally { store.close(); f.cleanup(); }
}, 150_000);

test("a proved pre-admission seat refusal delivers the original key to a real successor seat", async () => {
  const f = await fixture(false, true);
  const { bindStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryController");
  const key = { engine: "codex" as const, sessionId: f.host.identity.threadId };
  await bindStructuredDeliveryQueue([{ key, host: f.host }], { registry: f.registry, client: f.runtime!.client,
    watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
  const designate = (conversationId: string, pathname: string, request: string) => {
    beginOrchestratorSeatIntent({ project: "fixture", mandate: "coordinate", mode: "existing", clientRequestId: request });
    completeOrchestratorSeatIntent({ project: "fixture", clientRequestId: request, conversationId, path: pathname });
  };
  designate(f.launch.conversationId, f.host.identity.path!, "completion-original-seat");
  const row = await handoffRecordedCheck(f.launch.conversationId, "refused-completion", f.log,
    { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} });
  fs.writeFileSync(path.join(f.tmp, "release"), "release");
  await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
  f.finishTurn(); await idle(f.host);
  let recipient = { conversation: f.launch.conversationId, host: f.host, key };
  {
    const host = await CodexAppServerHost.start(f.options); hosts.push(host);
    const owner = codexHostColumns(await host.health(), 1).process;
    if (!owner) throw new Error("successor native fixture owner is unavailable");
    nativeOwners.push(owner);
    await host.send({ id: "successor-ready", text: "Ready for the owned completion." }); await idle(host);
    const started = f.registry.beginSpawnRequest({ engine: "codex", cwd: f.pipeline.worktreeDir, transport: "structured", explicitProject: "fixture",
      launchProfile: { cwd: f.pipeline.worktreeDir, role: "worker", title: "Successor completion fixture" } });
    if (started.kind !== "created") throw new Error("successor fixture admission failed");
    const successorKey = { engine: "codex" as const, sessionId: host.identity.threadId };
    f.registry.settleSpawn(started.receipt.launchId, { key: successorKey, artifactPath: host.identity.path!, cwd: f.pipeline.worktreeDir,
      accountId: null, status: "live", host: null, structuredHost: codexHostColumns(await host.health(), 1), claimEpoch: 0, claimOwner: null, pendingAction: null });
    const claimed = f.registry.claimStructuredHost(successorKey, captureProcessIdentity(process.pid), {
      reconnectCodex: { endpoint: codexHostColumns(await host.health(), 1).endpoint, process: owner },
    });
    if (!claimed?.claimOwner) throw new Error("successor fixture claim failed");
    persistence.push(await bindCodexHostPersistence(f.registry, successorKey, host, claimed.claimOwner, claimed.claimEpoch));
    recipient = { conversation: started.receipt.conversationId, host, key: successorKey };
    await bindStructuredDeliveryQueue([{ key, host: f.host }, { key: successorKey, host }], { registry: f.registry, client: f.runtime!.client,
      watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
  }
  const calls = f.calls(), store = new RecordedCheckStore();
  let revoked = false, refused = false;
  const observer = new RecordedCheckObserver({ ...productionObserverPorts, async deliver(current) {
    const first = !revoked;
    if (first) { revoked = true; designate(recipient.conversation, recipient.host.identity.path!, "completion-next-seat"); }
    const outcome = await productionObserverPorts.deliver(current);
    if (first) refused = outcome.noDispatch === true && outcome.operation === null && outcome.state === "reserved";
    return outcome;
  } });
  observers.push(observer);
  try {
    await observer.start(); await observer.observe(row.id);
    await observed(path.dirname(store.filename), () => store.get(row.id)?.notification?.state === "delivered", 30_000, "successor recipient completion");
    expect(refused).toBeTrue();
    await idle(recipient.host);
    expect(f.calls()).toBe(calls + 1);
    expect(fs.readFileSync(path.join(f.tmp, "executions"), "utf8")).toBe("run\n");
    const notice = store.get(row.id)!.notification!;
    expect(notice.key).toBe(`recorded-check:${row.id}`);
    expect(notice.conversation).toBe(recipient.conversation);
    expect(await readCodexConfirmedDelivery(recipient.host.identity.path!, normalizeQueueEntry({ id: notice.operation!, text: notice.text }))).not.toBeNull();
    const confirmed = store.get(row.id)!;
    await expect(store.write({ ...confirmed, revision: confirmed.revision + 1,
      notification: { ...notice, conversation: f.launch.conversationId } }, confirmed.revision)).rejects.toThrow("completion reservation changed");
    await expect(store.write({ ...confirmed, revision: confirmed.revision + 1,
      notification: { ...notice, state: "reserved", noDispatch: true } }, confirmed.revision)).rejects.toThrow("dispatch evidence");
    await expect(store.write({ ...confirmed, revision: confirmed.revision + 1,
      notification: { ...notice, state: "uncertain" } }, confirmed.revision)).rejects.toThrow("terminal state changed");
    observer.stop();
    const recovered = new RecordedCheckObserver(productionObserverPorts); observers.push(recovered);
    await recovered.start(); await recovered.observe(row.id); recovered.stop();
    expect(f.calls()).toBe(calls + 1);
  } finally { observer.stop(); store.close(); await bindStructuredDeliveryQueue([], { registry: f.registry, client: null }); f.cleanup(); }
}, 90_000);

test("observer startup publishes readiness while a real retained result awaits delivery", async () => {
  const f = await fixture(false);
  const row = await handoffRecordedCheck(f.launch.conversationId, "startup-delivery", f.log,
    { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} });
  fs.writeFileSync(path.join(f.tmp, "release"), "release");
  await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
  f.finishTurn(); await idle(f.host);
  let entered!: () => void, release!: () => void, ready = false;
  const deliveryEntered = new Promise<void>(resolve => { entered = resolve; });
  const deliveryBarrier = new Promise<void>(resolve => { release = resolve; });
  const observer = new RecordedCheckObserver({ active: () => true,
    recipient: () => ({ conversation: f.launch.conversationId, path: f.host.identity.path! }),
    deliver: async () => { entered(); await deliveryBarrier; return { operation: null, state: "uncertain", reason: "fixture delivery held" }; } });
  observers.push(observer);
  const startup = observer.start().then(() => { ready = true; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([deliveryEntered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("startup result was not reconciled")), 30_000); })]);
    expect(ready).toBeTrue();
    expect(recordedRootHeld(f.work)).toBeTrue();
  } finally { clearTimeout(timer); release(); await startup; await observer.observe(row.id); observer.stop(); f.cleanup(); }
}, 60_000);

test("acknowledgement before seat designation keeps one completion recoverable after the original sidecar retires", async () => {
  const f = await fixture(false, true);
  const { bindStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryController");
  const observer = new RecordedCheckObserver(productionObserverPorts); observers.push(observer);
  const row = await handoffRecordedCheck(f.launch.conversationId, "acknowledged-outbox", f.log,
    { binding: callingAttempt, verify: verifyLiveCustody, observe: id => observer.observe(id) });
  fs.writeFileSync(path.join(f.tmp, "release"), "release");
  await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
  await observer.observe(row.id); observer.stop(); f.finishTurn(); await idle(f.host);
  const store = new RecordedCheckStore();
  try {
    const current = store.get(row.id)!, result = current.result!;
    expect(current.notification).toBeNull();
    await acknowledgeRecordedCheck(current, f.launch.conversationId, { resultRevision: result.revision,
      resultDigest: result.digest, evidenceDigest: result.evidenceDigest, disposition: "adopt-retained" });
    expect(recordedRootHeld(f.work)).toBeFalse();
    expect(store.page().map(row => row.id)).toEqual([row.id]);
    const acknowledged = store.get(row.id)!;
    const evidence: ReturnType<RecordedCheckStore["evidencePage"]> = [];
    for (let cursor = 0; cursor < result.evidenceCount;) {
      const page = store.evidencePage(row.id, result.revision, cursor); expect(page.length).toBeGreaterThan(0);
      evidence.push(...page); cursor += page.length;
    }
    // Storage-only copies exercise the bounded completion backlog across
    // writer restarts; they admit no process and execute no command.
    const configuration = path.join(f.root, "ack-cap-input.json"), output = path.join(f.root, "ack-cap-output.json");
    for (const sharedLaunch of [true, false]) {
      const limit = sharedLaunch ? 4 : 128;
      for (const [start, count] of [[0, limit], [limit, 1]]) {
        writeEnvelope(configuration, { filename: path.join(f.root, sharedLaunch ? "ack-attempt-cap.sqlite" : "ack-installation-cap.sqlite"), output,
          row: { ...acknowledged, result: { ...acknowledged.result!, evidence } }, start, count, sharedLaunch });
        const run = fixtureChild(path.resolve("src/lib/recordedChecks/store.process.fixture.ts"), [configuration], process.env);
        const [code] = await once(run.child, "exit"); expect(code, run.errors()).toBe(0);
        const answer = readEnvelope(output) as { count: number; refusal: string | null; rootsHeld: boolean };
        expect(answer.count).toBe(limit); expect(answer.rootsHeld).toBeFalse();
        if (start) expect(answer.refusal).toContain("capacity"); else expect(answer.refusal).toBeNull();
      }
    }
    fs.renameSync(`${f.log}.gate`, `${f.log}.acknowledged`);
    const key = { engine: "codex" as const, sessionId: f.host.identity.threadId };
    await bindStructuredDeliveryQueue([{ key, host: f.host }], { registry: f.registry, client: f.runtime!.client,
      watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
    const calls = f.calls(), recovered = new RecordedCheckObserver(productionObserverPorts); observers.push(recovered);
    await recovered.start();
    beginOrchestratorSeatIntent({ project: "fixture", mandate: "coordinate", mode: "existing", clientRequestId: "ack-outbox-seat" });
    completeOrchestratorSeatIntent({ project: "fixture", clientRequestId: "ack-outbox-seat", conversationId: f.launch.conversationId, path: f.host.identity.path! });
    await observed(path.dirname(store.filename), () => store.get(row.id)?.notification?.state === "delivered", 30_000, "acknowledged completion delivery");
    await idle(f.host); recovered.stop();
    const delivered = store.get(row.id)!;
    expect(delivered.result?.digest).toBe(result.digest);
    expect(delivered.acknowledgement).not.toBeNull();
    expect(delivered.notification?.key).toBe(`recorded-check:${row.id}`);
    expect(await readCodexConfirmedDelivery(f.host.identity.path!, normalizeQueueEntry({ id: delivered.notification!.operation!, text: delivered.notification!.text }))).not.toBeNull();
    expect(store.page()).toEqual([]);
    const replay = new RecordedCheckObserver(productionObserverPorts); observers.push(replay);
    await replay.start(); await replay.observe(row.id); replay.stop();
    expect(f.calls()).toBe(calls + 1);
  } finally { store.close(); await bindStructuredDeliveryQueue([], { registry: f.registry, client: null }); f.cleanup(); }
}, 90_000);

test("failed observer initialization is evicted before a fresh startup", async () => {
  const f = await fixture(false);
  await handoffRecordedCheck(f.launch.conversationId, "startup-refusal", f.log,
    { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} });
  const watch = fs.watch;
  const failed = spyOn(fs, "watch").mockImplementation(() => { throw new Error("fixture watcher admission refused"); });
  try { await expect(startRecordedCheckObserver()).rejects.toThrow("fixture watcher admission refused"); }
  finally { failed.mockRestore(); }
  let installations = 0;
  const recovered = spyOn(fs, "watch").mockImplementation(((...args: Parameters<typeof fs.watch>) => {
    installations++; return watch(...args);
  }) as typeof fs.watch);
  try {
    const observer = await startRecordedCheckObserver();
    expect(installations).toBeGreaterThan(0);
    expect(await startRecordedCheckObserver()).toBe(observer);
    expect(recordedHostHeld(f.launch.conversationId)).toBeTrue();
  } finally { recovered.mockRestore(); stopRecordedCheckObserver(); f.cleanup(); }
}, 60_000);

test("one coalesced receipt hint reconciles every indexed changed run", async () => {
  const f = await fixture(false);
  const row = await handoffRecordedCheck(f.launch.conversationId, "coalesced-events", f.log,
    { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} });
  const store = new RecordedCheckStore(), seen = new Set<string>();
  const ids = Array.from({ length: 70 }, (_, index) => digest(["receipt-event", index]));
  let finished!: () => void;
  const complete = new Promise<void>(resolve => { finished = resolve; });
  const observer = new RecordedCheckObserver({ active: () => true, recipient: () => null,
    deliver: async () => { throw new Error("index observation must not dispatch a command or completion"); } });
  observers.push(observer);
  const observation = spyOn(observer, "observe").mockImplementation(async id => {
    if (id === ids[0]) throw new Error("fixture observation failed");
    seen.add(id); if (ids.slice(1).every(id => seen.has(id))) finished();
  });


  const rename = fs.renameSync, eventFile = `${store.filename}.recorded-check-event`;
  const publication = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === eventFile) fs.rmSync(from); else rename(from, to);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await observer.start(); seen.clear();
    for (const id of ids) {
      const { descriptorDigest: _old, wrapper, ...input } = { ...row.descriptor, runId: id };
      await store.write({ ...row, id, request: digest(["event-request", id]), revision: 1,
        binding: { ...row.binding, launch: `fixture-event-${id}` },
        descriptor: { ...input, wrapper, descriptorDigest: descriptorDigest(input) } }, null);
    }
    expect(seen.has(ids[0]!)).toBeFalse();
    expect(store.changed(0).map(event => event.id)).toEqual([row.id, ...ids].slice(0, 32));
    publication.mockRestore();
    // Only the final filesystem hint survives. The indexed cursor must still
    // deliver every committed change across bounded pages.
    writeEnvelope(eventFile, { id: ids[1], revision: 1 });
    await Promise.race([complete, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("coalesced receipt change was lost")), 5000);
    })]);
    expect(ids.slice(1).every(id => seen.has(id))).toBeTrue();
    expect(store.get(ids[0]!)?.observerFault).toBe("fixture observation failed");
    expect(store.changed(store.version())).toEqual([]);
  } finally { clearTimeout(timer); publication.mockRestore(); observation.mockRestore(); observer.stop(); store.close(); f.cleanup(); }
}, 60_000);

for (const restart of [false, true]) test(`a temporary proven no-dispatch completion recovers for the same seat on ${restart ? "delivery controller process restart" : "native readiness"}`, async () => {
  const f = await fixture(false, true);
  const { bindStructuredDeliveryQueue } = await import("@/lib/runtime/structuredDeliveryController");
  const key = { engine: "codex" as const, sessionId: f.host.identity.threadId };
  const bind = () => bindStructuredDeliveryQueue([{ key, host: f.host }], { registry: f.registry, client: f.runtime!.client,
    watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
  await bind();
  beginOrchestratorSeatIntent({ project: "fixture", mandate: "coordinate", mode: "existing", clientRequestId: "temporary-completion-seat" });
  completeOrchestratorSeatIntent({ project: "fixture", clientRequestId: "temporary-completion-seat",
    conversationId: f.launch.conversationId, path: f.host.identity.path! });
  const row = await handoffRecordedCheck(f.launch.conversationId, "temporary-completion", f.log,
    { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} });
  fs.writeFileSync(path.join(f.tmp, "release"), "release");
  await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
  f.finishTurn(); await idle(f.host);
  const client = f.runtime!.client;
  const session = (await client.snapshot()).sessions.find(session => session.conversationId === f.launch.conversationId)!;
  expect(session).toBeDefined();
  await bindStructuredDeliveryQueue([], { registry: f.registry, client: null });
  await new Promise<void>(resolve => setImmediate(resolve));
  const project = (available: boolean) => client.append({ scope: { type: "session", id: f.launch.conversationId }, kind: "session-status",
    producer: { kind: "recorded-fixture", eventKey: available ? "completion-owner-ready" : "completion-owner-synchronizing" },
    payload: { ...session, ...(!available ? { hostKind: "unhosted", host: "unhosted" } : {}) } });
  await project(false);
  // Exercise the production structured refusal before the generic transport
  // resolver repairs this deliberately unavailable projection.
  const structuredRefusal = spyOn(delivery, "deliverConversationMessage").mockImplementation(async request => {
    const outcome = await enqueueStructuredMessage(request);
    if (!outcome) throw new Error("fixture structured transport was not selected");
    return outcome;
  });
  const store = new RecordedCheckStore(), calls = f.calls();
  let attempts = 0, controllerPid: number | undefined;
  let firstOutcome!: (value: Awaited<ReturnType<ObserverPorts["deliver"]>>) => void;
  const firstDelivery = new Promise<Awaited<ReturnType<ObserverPorts["deliver"]>>>(resolve => { firstOutcome = resolve; });
  const observer = new RecordedCheckObserver({ ...productionObserverPorts, async deliver(current) {
    attempts++;
    const outcome = await productionObserverPorts.deliver(current);
    firstOutcome(outcome);
    return outcome;
  } });
  observers.push(observer);
  try {
    await observer.start();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([firstDelivery, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("temporary completion attempt was not observed")), 30_000);
      })]);
      expect(outcome).toMatchObject({ state: "reserved", operation: null, noDispatch: true });
    } finally { clearTimeout(timeout); }
    await observed(path.dirname(store.filename), () => store.get(row.id)?.notification?.noDispatch === true, 30_000, "temporary completion refusal");
    const refused = store.get(row.id)!.notification!;
    expect(refused).toMatchObject({ state: "reserved", operation: null, noDispatch: true });
    // Indexed receipt hints can reconcile the refusal without retrying it.
    for (let index = 0; index < 3; index++) await observer.observe(row.id, false, false);
    expect(attempts).toBe(1);
    expect(f.calls()).toBe(calls);
    structuredRefusal.mockRestore();
    if (restart) {
      observer.stop();
      expect(await detachCodexHostForViewerRestart(f.registry, key, f.host)).toBeTrue();
    }
    await project(true);
    if (restart) {
      const configuration = path.join(f.root, "same-seat-observer.json"), ready = path.join(f.root, "same-seat-ready.json");
      writeEnvelope(configuration, { options: f.options, ready, conversation: f.launch.conversationId,
        adoptTerminalOwner: true, deliveries: path.join(f.root, "same-seat-deliveries") });
      const run = fixtureChild(path.resolve("src/lib/recordedChecks/observer.process.fixture.ts"), [configuration], process.env);
      controllerPid = run.child.pid;
      await observed(f.root, () => { if (run.child.exitCode !== null) throw new Error(run.errors()); return fs.existsSync(ready); });
      expect((readEnvelope(ready) as { owner: ProcessIdentity }).owner).toEqual(row.binding.host);
    } else {
      // The native registration event is the readiness hint; no model wait or
      // receipt polling drives a retry.
      await bind();
    }
    await observed(path.dirname(store.filename), () => store.get(row.id)?.notification?.state === "delivered", 30_000, "same-seat confirmed completion");
    const delivered = store.get(row.id)!.notification!;
    if (restart) expect(store.get(row.id)!.observation?.owner.pid).toBe(controllerPid!);
    expect(delivered.conversation).toBe(refused.conversation);
    expect(delivered.seatEpoch).toBe(refused.seatEpoch);
    expect(delivered.key).toBe(refused.key);
    expect(delivered.operation).not.toBeNull();
    expect(await readCodexConfirmedDelivery(delivered.path, normalizeQueueEntry({ id: delivered.operation!, text: delivered.text }))).not.toBeNull();
    expect(f.calls()).toBe(calls + 1);
    observer.stop();
    const replay = new RecordedCheckObserver(productionObserverPorts); observers.push(replay);
    await replay.observe(row.id);
    if (!restart) await bind();
    await replay.observe(row.id); replay.stop();
    expect(f.calls()).toBe(calls + 1);
    expect(fs.readFileSync(path.join(f.tmp, "executions"), "utf8")).toBe("run\n");
  } finally { structuredRefusal.mockRestore(); observer.stop(); store.close(); await bindStructuredDeliveryQueue([], { registry: f.registry, client: null }); f.cleanup(); }
}, 120_000);

test("pending and unread recorded roots measure late files without releasing evidence holds", async () => {
  const f = await fixture(true);
  const row = await handoffRecordedCheck(f.launch.conversationId, "held-root-pressure", f.log,
    { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} });
  let now = Date.now() + 120_000;
  const temps = new AttemptTempStore(), store = new RecordedCheckStore();
  const sweep = () => sweepAttemptTemps(temps, { now: () => now, maxRoots: 32, capBytes: 0,
    state: async () => { throw new Error("held evidence cannot enter retirement admission"); },
    scan: () => { throw new Error("held evidence cannot enter deletion scan"); } });
  const observer = new RecordedCheckObserver({ active: () => true, recipient: () => null,
    deliver: async () => { throw new Error("unreserved completion must not send"); } });
  observers.push(observer);
  try {
    fs.writeFileSync(path.join(f.tmp, "late-pending-log"), Buffer.alloc(1024 * 1024, 1));
    const pending = await sweep();
    expect(pending).toMatchObject({ removed: 0, errors: 0 });
    expect(pending.held).toBeGreaterThan(0);
    expect(pending.bytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(pending.overCapBytes).toBe(pending.bytes);
    expect(recordedRootHeld(f.work)).toBeTrue();
    f.lock!.stdin!.end("release\n"); fs.writeFileSync(path.join(f.tmp, "release"), "release");
    await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
    await observer.observe(row.id); observer.stop();
    expect(store.get(row.id)?.result?.terminal?.report?.commandExit).toBe(23);
    fs.writeFileSync(path.join(f.tmp, "late-unread-result"), Buffer.alloc(2 * 1024 * 1024, 1));
    now += 60_000;
    const unread = await sweep();
    expect(unread).toMatchObject({ removed: 0, errors: 0 });
    expect(unread.bytes).toBeGreaterThan(pending.bytes);
    expect(unread.overCapBytes).toBe(unread.bytes);
    expect(recordedRootHeld(f.work)).toBeTrue();
    expect(fs.existsSync(path.join(`${f.log}.gate`, "exit"))).toBeTrue();
    expect(temps.owner(f.work)?.bytes).toBeGreaterThanOrEqual(3 * 1024 * 1024);
  } finally {
    if (!f.lock!.stdin!.writableEnded) f.lock!.stdin!.end("release\n");
    fs.writeFileSync(path.join(f.tmp, "release"), "release");
    await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
    f.finishTurn(); await idle(f.host);
    await stopFixtureProcess(f.lock!);
    observer.stop(); temps.close(); store.close(); f.cleanup();
  }
}, 120_000);

for (const queued of [true, false]) test(`the production terminal reaper preserves an idle native owner with a ${queued ? "queued" : "running"} recorded obligation`, async () => {
  const f = await fixture(queued, true), runtime = f.runtime!;
  const { bindStructuredDeliveryQueue, republishStructuredDeliveryHost, terminateStructuredDeliveryHost } = await import("@/lib/runtime/structuredDeliveryController");
  const key = { engine: "codex" as const, sessionId: f.host.identity.threadId };
  await bindStructuredDeliveryQueue([{ key, host: f.host }], { registry: f.registry, client: runtime.client,
    watchdogIntervalMs: 0, hostlessSettleIntervalMs: 0, settlementSweepMs: 0 });
  try {
    const row = await handoffRecordedCheck(f.launch.conversationId, "reaper-check", f.log,
      { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} });
    expect(row.admission, row.reason).toBe("accepted");
    const reaperPorts = defaultPipelinePorts();
    if (!queued) reaperPorts.stopStageAgent = async target => {
      // Exercise the real native signal boundary when selected. An unrelated
      // deferred idle journal admission must not mask lost running custody.
      expect(target.conversationId).toBe(f.launch.conversationId);
      return { outcome: await terminateStructuredDeliveryHost(key, row.binding.host) ? "stopped" : "deferred" };
    };
    await checkpoint(f, reaperPorts);
    expect(findPipelineRecord(f.pipeline.id)?.state).toBe("needs_decision");
    await republishStructuredDeliveryHost(key);
    await tickPipelines([], reaperPorts);
    expect(codexHostColumns(await f.host.health(), 1).process).toEqual(row.binding.host);
    expect(processIdentityStatus(row.binding.host)).toBe("alive");
    expect(recordedHostHeld(f.launch.conversationId)).toBeTrue();
    expect(fs.existsSync(path.join(f.tmp, "executions"))).toBe(!queued);
    if (queued) f.lock!.stdin!.end("release\n");
    fs.writeFileSync(path.join(f.tmp, "release"), "release");
    await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
    const resultObserver = new RecordedCheckObserver({ active: () => true, recipient: () => null,
      deliver: async () => { throw new Error("unreserved completion must not send"); } });
    observers.push(resultObserver); await resultObserver.observe(row.id); resultObserver.stop();
    expect(recordedHostHeld(f.launch.conversationId)).toBeFalse();
    if (!queued) {
      // The queued case below exercises automatic idle retirement. Also prove
      // that a running command's verified close releases explicit native teardown.
      expect(await terminateStructuredDeliveryHost(key, row.binding.host)).toBeTrue();
      expect(processIdentityStatus(row.binding.host)).toBe("dead");
      expect(recordedRootHeld(f.work)).toBeTrue();
      return;
    }
    await republishStructuredDeliveryHost(key);
    const ports = defaultPipelinePorts(), stops: unknown[] = [];
    const resident = ports.stageHostResident.bind(ports);
    ports.stageHostResident = async target => {
      const result = await resident(target);
      stops.push({ resident: result, sameRegistry: agentRegistry() === f.registry, target,
        conversation: f.registry.conversation(f.launch.conversationId), entry: f.registry.readOnlySnapshot().entries[sessionKeyId(key)] });
      return result;
    };
    const stop = ports.stopStageAgent.bind(ports);
    ports.stopStageAgent = async (target, options) => {
      const result = await stop(target, options); stops.push(result); return result;
    };
    const tick = await tickPipelines([], ports);
    const session = await runtime.client.readSession!({ conversationId: f.launch.conversationId });
    expect(processIdentityStatus(row.binding.host), JSON.stringify({ stops, session, tick,
      reap: findPipelineRecord(f.pipeline.id)?.terminalReap, state: await f.host.health() })).toBe("dead");
    expect(recordedRootHeld(f.work)).toBeTrue();
  } finally { await bindStructuredDeliveryQueue([], { registry: f.registry, client: null }); f.cleanup(); }
}, 150_000);

test("SDK tool dispatch reaches the authenticated route, replays the admission and refuses foreign consumption", async () => {
  const f = await fixture(false);
  const { POST } = await import("@/app/api/recorded-check/route");
  const { viewerMcpBindings, viewerMcpToolPolicy, productionViewerControlDependencies } = await import("@/lib/mcp/bindings");
  const { createMcpToolService, createViewerMcpServer, FileMcpReceiptStore } = await import("@/lib/mcp/server");
  const requests: string[] = [];
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests.push(new URL(request.url).pathname);
    return POST(new NextRequest(request));
  } });
  process.env.LLV_VIEWER_CONTROL_URL = `http://127.0.0.1:${http.port}`;
  process.env.LLV_SPAWN_CAPABILITY = f.capability;
  let receiptPath = path.join(f.root, "mcp-receipts.json");
  const connect = async () => {
    const server = createViewerMcpServer(createMcpToolService(viewerMcpBindings(undefined, productionViewerControlDependencies(true)),
      new FileMcpReceiptStore(receiptPath), viewerMcpToolPolicy()));
    const client = new Client({ name: "recorded-check-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(left), server.connect(right)]);
    return { client, server };
  };
  let connected = await connect();
  try {
    const args = { action: "handoff", ticket: f.log, clientRequestId: "sdk-handoff" };
    const call = async (arguments_: Record<string, unknown>) => (await connected.client.callTool({ name: "recorded_check", arguments: arguments_ })).structuredContent as Record<string, unknown>;
    const accepted = await call(args);
    expect(accepted.status, JSON.stringify(accepted)).toBe("custody-accepted");
    expect(accepted.execution).toBe("active");
    expect(accepted.executionScope).toBe("this-registered-run");
    expect(String(accepted.receiptId)).toHaveLength(64);
    expect(String(accepted.sourceDigest)).toHaveLength(64);
    f.finishTurn(); await idle(f.host);
    expect(requests).toEqual(["/api/recorded-check"]);
    await connected.client.close(); await connected.server.close();
    connected = await connect();
    const replay = await call(args);
    expect(replay.receiptId).toBe(accepted.receiptId);
    expect(requests).toHaveLength(1);
    delete process.env.LLV_SPAWN_CAPABILITY;
    expect((await call(args)).ok).toBeFalse();
    process.env.LLV_SPAWN_CAPABILITY = randomBytes(32).toString("base64url");
    const foreign = await call(args);
    expect(foreign.ok).toBeFalse();
    expect(foreign.receiptId).toBeUndefined();
    process.env.LLV_SPAWN_CAPABILITY = f.capability;
    const hostile = await connected.client.callTool({ name: "recorded_check", arguments: { ...args, clientRequestId: "hostile-command", command: ["true"] } });
    expect(hostile.isError).toBeTrue();
    const refused = await POST(new NextRequest(`http://127.0.0.1:${http.port}/api/recorded-check`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "read", receiptId: accepted.receiptId, clientRequestId: "unattributed" }) }));
    expect(refused.status).toBe(403);
    fs.writeFileSync(path.join(f.tmp, "release"), "release");
    await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
    expect(fs.readFileSync(path.join(f.tmp, "executions"), "utf8")).toBe("run\n");
    const store = new RecordedCheckStore();
    try {
      await observed(path.dirname(store.filename), () => store.get(String(accepted.receiptId))?.result?.complete === true);
      const read = await call({ action: "read", receiptId: accepted.receiptId, clientRequestId: "sdk-read" });
      expect(read.execution).toBe("completed");
      expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThan(16_384);
      const result = read.result as { revision: number; digest: string; evidenceDigest: string; evidence: Array<{ sha256: string }> };
      expect(result.digest).toHaveLength(64); expect(result.evidenceDigest).toHaveLength(64);
      expect(result.evidence.every(entry => entry.sha256.length === 64)).toBeTrue();
      const acknowledge = { action: "acknowledge", receiptId: accepted.receiptId, resultRevision: result.revision,
        resultDigest: result.digest, evidenceDigest: result.evidenceDigest, disposition: "adopt-retained" };
      const stale = await call({ ...acknowledge, resultRevision: result.revision + 1, clientRequestId: "sdk-stale-ack" });
      expect(stale.ok).toBeFalse();
      expect(recordedRootHeld(f.work)).toBeTrue();
      const acknowledged = await call({ ...acknowledge, clientRequestId: "sdk-ack" });
      expect(acknowledged.acknowledgement).not.toBeNull();
      expect(recordedRootHeld(f.work)).toBeFalse();
      const history = store.get(String(accepted.receiptId))!;
      const sqlite = process.getBuiltinModule("bun:sqlite") as typeof import("bun:sqlite");
      const database = new sqlite.Database(store.filename);
      try {
        const insert = database.query("INSERT INTO recorded_checks_history VALUES(?,?,?,?)");
        database.transaction(() => {
          for (let index = 0; index < 2048; index++) {
            const id = digest(["fixture-cold-history", index]), request = digest(["fixture-cold-request", index]);
            insert.run(id, request, history.binding.pipeline, JSON.stringify({ ...history, id, request }));
          }
        })();
        const plan = database.query<{ detail: string }, [string, number]>(
          "EXPLAIN QUERY PLAN SELECT value FROM recorded_checks WHERE id>? ORDER BY id LIMIT ?",
        ).all("", 32);
        expect(plan.some(row => row.detail.includes("USING INDEX") && row.detail.includes("id>?"))).toBeTrue();
        expect(store.page().map(row => row.id)).toEqual([history.id]);
        expect(store.byRequest(history.request)?.id).toBe(history.id);
        expect(store.evidencePage(history.id, history.result!.revision, 0)).toHaveLength(Math.min(16, history.result!.evidenceCount));
      } finally { database.close(); }
      // The command and lower admission committed even if the adapter's own
      // reply receipt is lost. A settled stage still replays that admission.
      f.pipeline.state = "closed"; f.pipeline.cursor = null; f.pipeline.closedAt = "2026-10-29T12:10:00Z"; savePipelines([f.pipeline]);
      await connected.client.close(); await connected.server.close();
      receiptPath = path.join(f.root, "reopened-mcp-receipts.json"); connected = await connect();
      const recovered = await call(args);
      expect(recovered.receiptId).toBe(accepted.receiptId);
      expect(recovered.acknowledgement).not.toBeNull();
      expect(fs.readFileSync(path.join(f.tmp, "executions"), "utf8")).toBe("run\n");
    } finally { store.close(); }
  } finally { await connected.client.close(); await connected.server.close(); http.stop(true); f.cleanup(); }
}, 150_000);

test("a seat revoked during asynchronous receipt-read admission receives no result", async () => {
  const f = await fixture(false);
  const row = await handoffRecordedCheck(f.launch.conversationId, "read-authority", f.log,
    { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} });
  const other = f.registry.ensureConversation("codex", path.join(f.root, "reader-seat.jsonl"), null);
  const designate = (conversation: string, pathname: string, request: string) => {
    beginOrchestratorSeatIntent({ project: "fixture", mandate: "coordinate", mode: "existing", clientRequestId: request });
    completeOrchestratorSeatIntent({ project: "fixture", clientRequestId: request, conversationId: conversation, path: pathname });
  };
  designate(other.id, other.generations.at(-1)!.path, "read-original-seat");
  const open = ledger.openRecordedChecks; let calls = 0;
  const race = spyOn(ledger, "openRecordedChecks").mockImplementation(async (...args) => {
    const store = await open(...args);
    if (++calls === 2) designate(f.launch.conversationId, f.host.identity.path!, "read-successor-seat");
    return store;
  });
  try {
    await expect(recordedCheck({ action: "read", receiptId: row.id, clientRequestId: "revoked-read" }, other.id)).rejects.toThrow("consumer changed during read");
    expect(calls).toBe(2); expect(recordedRootHeld(f.work)).toBeTrue();
  } finally { race.mockRestore(); f.cleanup(); }
}, 60_000);

test("canonical parent links refuse retention and acknowledgement without writing outside the owned evidence root", async () => {
  const f = await fixture(false);
  const row = await handoffRecordedCheck(f.launch.conversationId, "canonical-parent", f.log,
    { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} });
  fs.writeFileSync(path.join(f.tmp, "release"), "release");
  await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
  const outside = path.join(f.root, "foreign-output"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "existing"), "keep\n");
  const parent = statePath("evidence", "recorded-checks", f.pipeline.id);
  fs.mkdirSync(path.dirname(parent), { recursive: true }); fs.symlinkSync(outside, parent);
  const observer = new RecordedCheckObserver({ active: () => true, recipient: () => null,
    deliver: async () => { throw new Error("unreserved completion must not send"); } });
  observers.push(observer); const store = new RecordedCheckStore();
  try {
    await observer.observe(row.id);
    const current = store.get(row.id)!;
    expect(current.result?.complete).toBeFalse();
    expect(current.result?.evidenceCount).toBe(0);
    expect(current.result?.terminal?.report?.commandExit).toBe(23);
    await expect(acknowledgeRecordedCheck(current, f.launch.conversationId, {
      resultRevision: current.result!.revision, resultDigest: current.result!.digest,
      evidenceDigest: current.result!.evidenceDigest, disposition: "adopt-retained",
    })).rejects.toThrow("incomplete");
    expect(fs.readdirSync(outside)).toEqual(["existing"]);
    expect(fs.readFileSync(path.join(outside, "existing"), "utf8")).toBe("keep\n");
    expect(recordedRootHeld(f.work)).toBeTrue();
    const original = row.descriptor;
    const insert = async (pipeline: string, label: string) => {
      const id = digest(["identity-admission", label]);
      const { descriptorDigest: _digest, wrapper, ...input } = { ...original, runId: id };
      return store.write({ ...row, id, request: digest(["identity-request", label]), revision: 1,
        binding: { ...row.binding, pipeline }, descriptor: { ...input, wrapper, descriptorDigest: descriptorDigest(input) } }, null);
    };
    // Copied protocol rows exercise the actual storage writer, without
    // admitting another process or repeating the original command.
    await insert(row.binding.pipeline, "valid");
    for (const pipeline of ["..", "../outside", "nested/child", "nested\\child"])
      await expect(insert(pipeline, pipeline)).rejects.toThrow();
  } finally { store.close(); observer.stop(); f.cleanup(); }
}, 60_000);

test("a canonical directory swap after awaited source verification aborts copying and recovers only its original owned directory", async () => {
  const f = await fixture(false);
  const row = await handoffRecordedCheck(f.launch.conversationId, "canonical-race", f.log,
    { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} });
  fs.writeFileSync(path.join(f.tmp, "release"), "release");
  await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
  const destination = statePath("evidence", "recorded-checks", f.pipeline.id, row.id), originalDirectory = `${destination}.held`;
  const outside = path.join(f.root, "foreign-output"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "existing"), "keep\n");
  const verify = wire.verifyManifest; let changed = false;
  const race = spyOn(wire, "verifyManifest").mockImplementation(async (...args) => {
    const guard = await verify(...args);
    if (!changed && fs.existsSync(destination)) {
      fs.renameSync(destination, originalDirectory); fs.symlinkSync(outside, destination); changed = true;
    }
    return guard;
  });
  const observer = new RecordedCheckObserver({ active: () => true, recipient: () => null,
    deliver: async () => { throw new Error("unreserved completion must not send"); } });
  observers.push(observer); const store = new RecordedCheckStore();
  try {
    await expect(observer.observe(row.id)).rejects.toThrow("retention root changed");
    expect(changed).toBeTrue();
    expect(fs.readdirSync(outside)).toEqual(["existing"]);
    expect(recordedRootHeld(f.work)).toBeTrue();
    expect(store.get(row.id)?.result).toBeNull();
    race.mockRestore(); fs.unlinkSync(destination); fs.renameSync(originalDirectory, destination);
    await observer.observe(row.id);
    expect(store.get(row.id)?.result?.complete).toBeTrue();
    expect(store.get(row.id)?.result?.terminal?.report?.commandExit).toBe(23);
  } finally { race.mockRestore(); store.close(); observer.stop(); f.cleanup(); }
}, 60_000);

test("cancellation refuses unverified recorder identity and signals its original process once proof returns", async () => {
  const f = await fixture(true);
  const row = await handoffRecordedCheck(f.launch.conversationId, "cancel-proof", f.log,
    { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} });
  const identity = procBackend.processIdentity, kill = process.kill;
  let signals = 0;
  const probe = spyOn(procBackend, "processIdentity").mockImplementation(pid => pid === row.descriptor.recorder.pid ? null : identity.call(procBackend, pid));
  const signal = spyOn(process, "kill").mockImplementation(((pid: number, requested?: number | NodeJS.Signals) => {
    if (pid === row.descriptor.recorder.pid && requested === "SIGTERM") signals++;
    return kill.call(process, pid, requested);
  }) as typeof process.kill);
  try {
    await expect(cancelRecordedHost(f.launch.conversationId)).rejects.toThrow("awaits verified recorder identity");
    expect(signals).toBe(0);
    expect(recordedRootHeld(f.work)).toBeTrue();
    expect(fs.existsSync(path.join(`${f.log}.gate`, "exit"))).toBeFalse();
    probe.mockRestore();
    await cancelRecordedHost(f.launch.conversationId);
    expect(signals).toBe(1);
    await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
    expect(fs.existsSync(path.join(f.tmp, "executions"))).toBeFalse();
  } finally { probe.mockRestore(); signal.mockRestore(); f.cleanup(); }
}, 60_000);

test("a refused custody admission retains a late real command result without releasing its evidence", async () => {
  const f = await fixture(false);
  const descriptor = descriptorSchema.parse(readEnvelope(path.join(`${f.log}.gate`, "descriptor.json")));
  const identity = procBackend.processIdentity;
  const probe = spyOn(procBackend, "processIdentity").mockImplementation(pid => pid === descriptor.recorder.pid ? null : identity.call(procBackend, pid));
  try {
    const row = await handoffRecordedCheck(f.launch.conversationId, "refused-late-result", f.log,
      { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} });
    expect(row.admission).toBe("refused"); probe.mockRestore();
    fs.writeFileSync(path.join(f.tmp, "release"), "release");
    await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
    const observer = new RecordedCheckObserver({ active: () => true, recipient: () => null,
      deliver: async () => { throw new Error("unreserved completion must not send"); } });
    observers.push(observer); await observer.observe(row.id); observer.stop();
    const store = new RecordedCheckStore();
    try {
      const current = store.get(row.id)!, result = current.result!;
      expect(result.state).toBe("unknown"); expect(result.terminal).toBeNull();
      expect(recordedExecutionState(current)).toBe("unknown");
      const retained = wire.terminalSchema.parse(readEnvelope(statePath("evidence", "recorded-checks", row.binding.pipeline, row.id,
        digest(path.join(`${f.log}.gate`, "result.json")))));
      expect(retained.report?.commandExit).toBe(23);
      expect(result.completed).toBe(1); expect(result.complete).toBeFalse();
      await expect(acknowledgeRecordedCheck(current, f.launch.conversationId, { resultRevision: result.revision,
        resultDigest: result.digest, evidenceDigest: result.evidenceDigest, disposition: "adopt-retained" })).rejects.toThrow("incomplete");
      expect(fs.readFileSync(path.join(f.tmp, "executions"), "utf8")).toBe("run\n");
      expect(recordedRootHeld(f.work)).toBeTrue();
    } finally { store.close(); }
  } finally { probe.mockRestore(); f.cleanup(); }
}, 60_000);

test("a cancelled check acknowledges retained partial evidence and direct absences without accepting a missing symlink target", async () => {
  const f = await fixture(false);
  const row = await handoffRecordedCheck(f.launch.conversationId, "cancelled-evidence", f.log,
    { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} });
  await checkpoint(f);
  await cancelRecordedHost(f.launch.conversationId);
  await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
  const outside = path.join(f.root, "foreign-output"); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "existing"), "keep\n");
  const output = path.join(f.tmp, "final.patch"); fs.symlinkSync(path.join(outside, "absent"), output);
  const observer = new RecordedCheckObserver({ active: () => true, recipient: () => null,
    deliver: async () => { throw new Error("unreserved completion must not send"); } });
  observers.push(observer); const store = new RecordedCheckStore();
  const acknowledge = async () => {
    const current = store.get(row.id)!, result = current.result!;
    return acknowledgeRecordedCheck(current, f.launch.conversationId, { resultRevision: result.revision,
      resultDigest: result.digest, evidenceDigest: result.evidenceDigest, disposition: "adopt-retained" });
  };
  try {
    await observer.observe(row.id);
    expect(store.get(row.id)?.result?.complete).toBeFalse();
    await expect(acknowledge()).rejects.toThrow("incomplete");
    expect(recordedRootHeld(f.work)).toBeTrue();
    expect(fs.readdirSync(outside)).toEqual(["existing"]);
    fs.unlinkSync(output); await observer.observe(row.id);
    const current = store.get(row.id)!;
    expect(current.result?.terminal?.cancellation).not.toBeNull();
    expect(current.result?.terminal?.report?.cleanup).toBe("confirmed");
    expect(recordedExecutionState(current)).toBe("completed");
    expect(current.result?.complete).toBeFalse();
    expect(current.result?.completed).toBe(0);
    expect((await acknowledge()).acknowledgement).not.toBeNull();
    expect(recordedRootHeld(f.work)).toBeFalse();
    expect(store.get(row.id)?.result?.complete).toBeFalse();
    const temps = new AttemptTempStore();
    try {
      await stopFixtureIdentity(row.binding.host, 5000);
      const swept = await sweepAttemptTemps(temps, { state: attemptTempState, capBytes: 0,
        now: () => Date.now() + 120_000, scan: () => ({ ownNamespace: null, processes: [] }) });
      expect(swept.errors).toBe(0); expect(fs.existsSync(f.work)).toBeFalse();
    } finally { temps.close(); }
    expect(fs.readFileSync(path.join(outside, "existing"), "utf8")).toBe("keep\n");
  } finally { store.close(); observer.stop(); f.cleanup(); }
}, 90_000);

for (const change of ["wrapper", "stage", "source", "unverified", "unverified-wrapper"] as const) test(`handoff refuses ${change} custody changes and keeps incomplete evidence`, async () => {
  const f = await fixture(true);
  let probe: { mockRestore(): void } | undefined;
  try {
    const descriptor = descriptorSchema.parse(readEnvelope(path.join(`${f.log}.gate`, "descriptor.json")));
    verifyLiveCustody(callingAttempt(f.launch.conversationId), descriptor, `${f.log}.gate`);
    if (change === "wrapper") writeEnvelope(path.join(`${f.log}.gate`, "descriptor.json"), {
      ...descriptor, wrapper: captureProcessIdentity(process.pid),
    });
    if (change === "unverified" || change === "unverified-wrapper") {
      const identity = procBackend.processIdentity;
      const uncertain = change === "unverified" ? descriptor.recorder.pid : descriptor.wrapper!.pid;
      probe = spyOn(procBackend, "processIdentity").mockImplementation(pid => pid === uncertain ? null : identity.call(procBackend, pid));
    }
    const row = await handoffRecordedCheck(f.launch.conversationId, "refused-check", f.log, {
      binding: callingAttempt, observe: async () => {}, verify(binding, current, directory) {
        verifyLiveCustody(binding, current, directory);
        if (change === "stage") {
          f.pipeline.controlGeneration = "fixture-control-changed";
          savePipelines([f.pipeline]);
        }
        if (change === "source") fs.appendFileSync(path.join(f.tmp, "command.ts"), "\n// modified after verification\n");
      },
    });
    probe?.mockRestore();
    expect(row.admission).toBe("refused");
    expect(row.reason).toContain(change === "wrapper" || change.startsWith("unverified") ? "custody is unknown" : change === "source" ? "source changed" : "owner changed");
    expect(recordedRootHeld(f.work)).toBeTrue();
    expect(fs.existsSync(path.join(f.tmp, "executions"))).toBeFalse();
    expect(signalFixtureIdentity(descriptor.recorder, "SIGTERM")).toBeTrue();
    await observed(`${f.log}.gate`, () => fs.existsSync(path.join(`${f.log}.gate`, "exit")));
    const observer = new RecordedCheckObserver({ active: () => true, recipient: () => null,
      deliver: async () => { throw new Error("unreserved completion must not send"); } });
    observers.push(observer); await observer.observe(row.id);
    const store = new RecordedCheckStore();
    try {
      const finished = store.get(row.id)!;
      expect(finished.result?.terminal?.report?.commandExit ?? null).toBeNull();
      expect(finished.result?.complete).toBeFalse();
      await expect(acknowledgeRecordedCheck(finished, f.launch.conversationId, {
        resultRevision: finished.result!.revision, resultDigest: finished.result!.digest,
        evidenceDigest: finished.result!.evidenceDigest, disposition: "adopt-retained",
      })).rejects.toThrow("incomplete");
    } finally { store.close(); }
  } finally { probe?.mockRestore(); f.cleanup(); }
}, 150_000);
