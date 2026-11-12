import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Database } from "bun:sqlite";
import { beginLegacySpawnFixture, structuredHostFixture } from "@/lib/agent/registryTestFixtures";
import { captureProcessIdentity, systemBootEpoch, type ProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import type { Pipeline, PipelineStageAttempt } from "./types";

// The owned gate supplies all four isolated roots. No host control is used.
process.env.LLV_STRUCTURED_HOSTS = "0";
const inheritedRoot = process.env.LLV_STATE_DIR;
const worker = process.env.LLV_HOST_RECONCILE_WORKER === "1";
const root = worker ? inheritedRoot! : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-reconcile-")));
process.env.LLV_STATE_DIR = root;
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { defaultPipelinePorts } = await import("./engine");
const { tickPipelinesController } = await import("./controllerPass");
const { registerPipelineTick } = await import("./controllerSignal");
const { isStoredPipeline, loadPipelines, pipelineIdentity, savePipelines } = await import("./store");
const { laneFinish } = await import("./laneFinish");
const { attemptTempAuthority } = await import("@/lib/runtime/attemptTempProduction");
const { pipelineStageHostTerminated, recordedProcessTerminated, probePipelineStageHostTermination } = await import("./hostTermination");
const { sessionKeyId } = await import("@/lib/agent/sessionKey");
const NOW = new Date(Date.parse("2026-11-12T12:00:00.000Z")
  + 31_000 * Number(process.env.LLV_HOST_RECONCILE_PHASE ?? 0)).toISOString();
const OLD = "2026-11-01T00:00:00.000Z";
const MISSING_PID = 2147483647;
const registry = new AgentRegistry(path.join(root, "hosts.json"), undefined, undefined, { sqliteMode: "off" });
setAgentRegistryForTests(registry);
registerPipelineTick(async () => {});
afterAll(async () => {
  setAgentRegistryForTests(null);
  const { resetStateReadonlyReaderForTests } = await import("@/lib/state/sqliteStateStore");
  resetStateReadonlyReaderForTests();
  if (inheritedRoot === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = inheritedRoot;
  if (!worker) fs.rmSync(root, { recursive: true, force: true });
});
afterEach(() => { for (const restore of restores.splice(0)) restore(); });
const restores: Array<() => void> = [];

function host(n: number, identity: ProcessIdentity) {
  const key = { engine: "codex" as const, sessionId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` };
  const artifact = path.join(root, `${key.sessionId}.jsonl`);
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: root, transport: "structured",
    conversationId: `conversation_host-${n}`, clientAttemptId: `host-${n}` });
  if (begun.kind !== "created") throw new Error("fixture launch not created");
  expect(registry.settleSpawn(begun.receipt.launchId, { key, artifactPath: artifact, cwd: root, accountId: null,
    status: "live", host: null, structuredHost: structuredHostFixture(identity, "codex-app-server"),
    claimEpoch: 1, claimOwner: "structured-host:fixture", pendingAction: null }).kind).toBe("settled");
  expect(registry.conversation(begun.receipt.conversationId)?.generations.at(-1)?.id).toBe(key.sessionId);
  const stored = registry.livenessConversationSnapshot(begun.receipt.conversationId).entries[sessionKeyId(key)]?.structuredHost?.process;
  expect(stored).toMatchObject({ pid: identity.pid, startIdentity: identity.startIdentity });
  expect(stored?.bootEpoch ?? null).toBe(identity.bootEpoch ?? null);
  return { key, target: { stageId: "build", attempt: n, conversationId: begun.receipt.conversationId,
    agentPath: artifact, paneId: null, launchId: begun.receipt.launchId } };
}

const ROLE = { roleId: null, engine: "codex", model: "gpt-fixture", effort: null, access: "read-write", promptScaffold: null } as const;
function lane(hosts: ReturnType<typeof host>[], state: "closed" | "completed" = "completed", cause = "terminal reap budget expired") {
  hosts.forEach(({ target }, index) => { target.attempt = index + 1; });
  const attempts: PipelineStageAttempt[] = hosts.map(({ target }) => ({ n: target.attempt, state: "passed",
    effectiveRole: { ...ROLE }, launchId: target.launchId, conversationId: target.conversationId, sessionId: null,
    agentPath: target.agentPath, paneId: null, flowId: null, startedAt: OLD, completedAt: OLD,
    input: null, activatedBy: null, output: "done", verdict: { status: "pass" }, error: null }));
  const record: Pipeline = { id: "finished-hosts", task: "Reconcile finished hosts", taskIds: [], project: "fixture",
    repoDir: root, ...pipelineIdentity("finished-hosts", "Reconcile finished hosts", root), publication: "internal",
    baseBranch: "main", baseRef: "a".repeat(40), lastPassedCommit: "a".repeat(40), publishedCommit: null,
    stages: [{ id: "build", kind: "run", prompt: "fixture", next: null, onFail: null, effectiveRole: { ...ROLE } }],
    runs: [{ stageId: "build", attempts }], cursor: null, state, pausedState: null, stateDetail: null,
    srcPath: path.join(root, "creator.jsonl"), srcConversationId: "conversation_creator", createdAt: OLD, closedAt: OLD, hiddenAt: null,
    terminalReap: { rounds: 5, stopped: 0, lastAt: OLD, settledAt: OLD, settledAttempts: [] },
    unconfirmedHosts: hosts.map(({ target }) => ({ ...target, operationId: "queued-stop", detail: cause, at: OLD })) };
  if (state === "closed") {
    record.closeTeardown = { id: "finished-close", phase: "settled", waitingForActivation: false, acknowledgeHosts: false, flow: null };
    record.closeReport = { status: "settled", pending: [], stopped: [], alreadyStopped: [], unconfirmed: [],
      stillRunning: hosts.map(({ target }) => ({ ...target, error: cause })), reviewers: [], acknowledged: [], notes: [], worktree: null };
  }
  expect(isStoredPipeline(record)).toBeTrue();
  return record;
}

function ports() {
  return { ...defaultPipelinePorts(), now: () => NOW, monotonicNow: () => 0, worktreePresent: () => false,
    exec: () => ({ code: 0, stdout: "", stderr: "" }), conversationAgentActive: async () => false,
    stopStageAgent: async () => { throw new Error("reconciliation must send no kill"); } };
}

const cases = ["absent", "reused", "live", "unknown-start", "unknown-boot", "other-boot", "other-boot-unknown-start",
  "other-namespace-unknown-start", "other-namespace-start", "other-namespace-absent"] as const;
test.each(cases.filter(kind => process.platform === "linux" || !kind.startsWith("other-namespace") && !kind.startsWith("other-boot")))(
  "recorded %s process reconciles conservatively through the controller", async kind => {
  expect(fs.existsSync(`/proc/${MISSING_PID}`)).toBeFalse();
  const identity = captureProcessIdentity(process.pid);
  const otherBoot = identity.bootEpoch?.replace(/^linux:([a-f0-9])/, (_match, digit: string) => `linux:${digit === "0" ? "1" : "0"}`)
    ?? "earlier-boot";
  const otherNamespace = identity.bootEpoch?.replace(/pid:\[\d+\]$/, "pid:[0]") ?? null;
  const n = cases.indexOf(kind) + 1;
  const f = host(n, kind === "absent" ? { ...identity, pid: MISSING_PID }
    : kind === "reused" ? { ...identity, startIdentity: "earlier-start" }
    : kind === "unknown-start" ? { ...identity, startIdentity: null }
    : kind === "unknown-boot" ? { ...identity, bootEpoch: null }
    : kind === "other-boot" ? { ...identity, bootEpoch: otherBoot }
    : kind === "other-boot-unknown-start" ? { ...identity, startIdentity: null, bootEpoch: otherBoot }
    : kind === "other-namespace-unknown-start" ? { ...identity, startIdentity: null, bootEpoch: otherNamespace }
    : kind === "other-namespace-start" ? { ...identity, bootEpoch: otherNamespace }
    : kind === "other-namespace-absent" ? { ...identity, pid: MISSING_PID, bootEpoch: otherNamespace } : identity);
  const terminated = ["absent", "reused", "other-boot", "other-boot-unknown-start"].includes(kind);
  expect(await pipelineStageHostTerminated(f.target)).toBe(terminated);
  const record = lane([f]);
  expect(laneFinish(record).finished).toBeFalse();
  savePipelines([record]);
  await tickPipelinesController([], ports());
  const final = loadPipelines()[0]!;
  expect(final.unconfirmedHosts?.length ?? 0).toBe(terminated ? 0 : 1);
  expect(laneFinish(final).finished).toBe(terminated);
  expect(final.state).toBe("completed");
  if (terminated) expect(final.terminalReap?.settledAttempts).toContain(`build:${f.target.attempt}`);
});

test.each(["kill accepted as queued but termination was not confirmed", "terminal reap budget expired"])(
  "an old closed lane reconciles all copies after %s", async cause => {
    const f = host(cause.startsWith("kill") ? 50 : 51, { pid: MISSING_PID, startIdentity: "old-start" });
    const record = lane([f], "closed", cause);
    savePipelines([record]);
    const owner = { directory: path.join(root, "scratch"), launchId: f.target.launchId,
      pipelineId: record.id, retainUntilClose: true, createdAt: Date.parse(OLD) };
    expect((await attemptTempAuthority(owner, undefined, () => Date.parse(NOW))).state).toBe("live");
    await tickPipelinesController([], ports());
    const final = loadPipelines()[0]!;
    expect(final.unconfirmedHosts).toBeUndefined();
    expect(final.closeReport).toMatchObject({ stillRunning: [], unconfirmed: [], alreadyStopped: [f.target] });
    expect(final.hiddenAt).toBe(OLD);
    expect(laneFinish(final)).toEqual({ finished: true, finishedAt: Date.parse(OLD), expiresAt: Date.parse(OLD) + 7 * 86400000 });
    const authority = await attemptTempAuthority(owner, undefined, () => Date.parse(NOW));
    expect(authority.state).toBe("expired");
    expect(authority.isCurrent()).toBeTrue();
  });

test("a missing registry record cannot prove that an addressed host is gone", async () => {
  expect(await pipelineStageHostTerminated({ stageId: "build", attempt: 1, conversationId: "conversation_missing",
    agentPath: null, paneId: null })).toBeFalse();
});

test.each(["scope", "legacy memory unit"] as const)("a live or unreadable recorded %s keeps its host unconfirmed", async kind => {
  const f = host(60 + (kind === "scope" ? 0 : 1), { pid: MISSING_PID, startIdentity: "old-start" });
  const snapshot = structuredClone(registry.readOnlySnapshot());
  const hostRecord = snapshot.entries[sessionKeyId(f.key)]!.structuredHost!;
  if (kind === "scope") hostRecord.scope = { unit: "delegatus-agent-fixture.scope", bootEpoch: systemBootEpoch() };
  else hostRecord.memory = { mechanism: "scope", unit: "delegatus-agent-fixture.scope", limitBytes: 1, kills: 0, lastKill: null };
  fs.writeFileSync(registry.filename, JSON.stringify(snapshot));
  const target = { ...f.target, conversationId: f.target.conversationId! };
  const unavailable = await probePipelineStageHostTermination(target, { owner: "scope-test", identities: [],
    scopeState: async () => { throw new Error("scope query unavailable"); } });
  expect(unavailable.terminated).toBeFalse();
  const live = await probePipelineStageHostTermination(target, { owner: "scope-test", identities: [],
    scopeState: async () => "loaded" });
  expect(live.terminated).toBeFalse();
  const gone = await probePipelineStageHostTermination(target, { owner: "scope-test", identities: [],
    scopeState: async () => "not-found" });
  expect(gone.terminated).toBeTrue();
});

test("large identity inputs read only the current durable cursor page and reset on a new owner", async () => {
  const f = host(62, { pid: MISSING_PID, startIdentity: "old-start" });
  const identities = Array.from({ length: 4096 }, (_, index) => ({ pid: MISSING_PID, startIdentity: `missing-${index}` }));
  let pidReads = 0;
  const counted = identities.map(identity => Object.defineProperty({ startIdentity: identity.startIdentity }, "pid", {
    enumerable: true, get() { pidReads++; return identity.pid; },
  }) as ProcessIdentity);
  const target = f.target;
  const first = await probePipelineStageHostTermination(target, { owner: "large-tree", identities: counted, limit: 16 });
  expect(first.checked).toBe(16);
  expect(pidReads).toBeLessThanOrEqual(16 * 8);
  const restarted = await probePipelineStageHostTermination(target, { owner: "large-tree", identities: counted,
    progress: first.progress, limit: 16 });
  expect(restarted.progress?.next).toBe(32);
  expect(pidReads).toBeLessThanOrEqual(32 * 8);
  const changedSource = await probePipelineStageHostTermination(target, { owner: "changed-large-tree", identities: counted,
    progress: restarted.progress, limit: 16 });
  expect(changedSource.progress?.next).toBe(16);
  expect(pidReads).toBeLessThanOrEqual(48 * 8);
});

test("same-length survivor replacement changes the durable proof source", async () => {
  const f = host(63, { pid: MISSING_PID, startIdentity: "old-start" });
  const old = Array.from({ length: 100 }, (_, index) => ({ pid: MISSING_PID, startIdentity: `old-${index}` }));
  const first = await probePipelineStageHostTermination(f.target, { owner: "same-length", identities: [],
    identitySources: [old], identitySourceRevision: "source-a", limit: 64 });
  expect(first.progress?.next).toBe(64);
  const replacement = [captureProcessIdentity(process.pid), ...old.slice(1)];
  const next = await probePipelineStageHostTermination(f.target, { owner: "same-length", identities: [],
    identitySources: [replacement], identitySourceRevision: "source-b", progress: first.progress, limit: 64 });
  expect(next.terminated).toBeFalse();
  expect(next.progress?.next).toBe(0);
  expect(next.checked).toBe(1);
});

test("registry replacement during scope await cannot certify the old snapshot", async () => {
  const f = host(64, { pid: MISSING_PID, startIdentity: "old-start" });
  const snapshot = structuredClone(registry.readOnlySnapshot());
  snapshot.entries[sessionKeyId(f.key)]!.structuredHost!.scope = { unit: "delegatus-agent-fixture.scope", bootEpoch: systemBootEpoch() };
  fs.writeFileSync(registry.filename, JSON.stringify(snapshot));
  const result = await probePipelineStageHostTermination(f.target, { owner: "scope-race", identities: [],
    scopeState: async () => {
      const replacement = structuredClone(registry.readOnlySnapshot());
      replacement.entries[sessionKeyId(f.key)]!.structuredHost!.process = captureProcessIdentity(process.pid);
      fs.writeFileSync(registry.filename, JSON.stringify(replacement));
      return "not-found";
    } });
  expect(result.terminated).toBeFalse();
  expect(result.checked).toBe(0);
});

test.each([64, 4096])("zero identity budget does not read elements from a %i survivor list", async size => {
  const f = host(5000 + size, { pid: MISSING_PID, startIdentity: "old-start" });
  let reads = 0;
  const survivors = Array.from({ length: size }, (_, index) => Object.defineProperty({ startIdentity: `child-${index}` }, "pid", {
    enumerable: true, get() { reads++; return MISSING_PID; },
  }) as ProcessIdentity);
  const result = await probePipelineStageHostTermination(f.target, { owner: "zero-budget", identities: [],
    identitySources: [survivors], identitySourceRevision: "zero-budget-source", limit: 0 });
  expect(result.checked).toBe(0);
  expect(reads).toBe(0);
});

test("an old lane without delivery custody still reconciles its hosts", async () => {
  const f = host(15, { pid: MISSING_PID, startIdentity: "old-start" });
  const record = lane([f], "closed");
  delete record.publication;
  savePipelines([record]);
  await tickPipelinesController([], ports());
  const final = loadPipelines()[0]!;
  expect(final.unconfirmedHosts).toBeUndefined();
  expect(laneFinish(final).finished).toBeTrue();
});

test("a legacy close report without the root copy still reconciles", async () => {
  const f = host(21, { pid: MISSING_PID, startIdentity: "old-start" });
  const record = lane([f], "closed");
  record.closeReport!.unconfirmed = record.unconfirmedHosts!.map(item => ({ ...item }));
  record.closeReport!.stillRunning = [];
  delete record.unconfirmedHosts;
  savePipelines([record]);
  await tickPipelinesController([], ports());
  const final = loadPipelines()[0]!;
  expect(final.closeReport!.unconfirmed).toEqual([]);
  expect(laneFinish(final).finished).toBeTrue();
});

test.each(["completed", "closed"] as const)("an old %s row with a stale inactive flag is still reconciled", async state => {
  const f = host(state === "closed" ? 22 : 23, { pid: MISSING_PID, startIdentity: "old-start" });
  savePipelines([lane([f], state)]);
  const db = new Database(path.join(root, "state.sqlite"));
  try { db.exec("UPDATE state_rows SET controller_active=0 WHERE collection='pipelines'"); }
  finally { db.close(); }
  await tickPipelinesController([], ports());
  const final = loadPipelines()[0]!;
  expect(final.unconfirmedHosts).toBeUndefined();
  expect(laneFinish(final).finished).toBeTrue();
});

test.each(["completed", "closed"] as const)("a %s lane records termination of an attempt left running", async state => {
  const f = host(state === "closed" ? 19 : 20, { pid: MISSING_PID, startIdentity: "old-start" });
  const record = lane([f], state);
  const attempt = record.runs[0]!.attempts[0]!;
  attempt.state = "running";
  attempt.verdict = null;
  attempt.completedAt = null;
  savePipelines([record]);
  await tickPipelinesController([], ports());
  const final = loadPipelines()[0]!;
  expect(final.unconfirmedHosts).toBeUndefined();
  expect(final.runs[0]!.attempts[0]).toMatchObject({ state: "failed", completedAt: NOW,
    error: "recorded stage host termination confirmed" });
  expect(laneFinish(final).finished).toBeTrue();
});

test("unreadable kernel identity and registry reads preserve the host", async () => {
  const f = host(12, captureProcessIdentity(process.pid));
  const read = spyOn(procBackend, "processIdentity").mockReturnValue(null);
  restores.push(() => read.mockRestore());
  expect(await pipelineStageHostTerminated(f.target)).toBeFalse();
  read.mockRestore();
  const snapshot = spyOn(registry, "livenessConversationSnapshot").mockImplementation(() => { throw new Error("read refused"); });
  restores.push(() => snapshot.mockRestore());
  expect(await pipelineStageHostTerminated(f.target)).toBeFalse();
  savePipelines([lane([f])]);
  await tickPipelinesController([], ports());
  expect(loadPipelines()[0]!.unconfirmedHosts).toHaveLength(1);
});

test.skipIf(process.platform !== "linux")("a denied proc read is unknown even when the recorded start token differs", async () => {
  const f = host(16, { ...captureProcessIdentity(process.pid), startIdentity: "earlier-start" });
  const stat = fs.statSync;
  const denied = spyOn(fs, "statSync").mockImplementation(((pathname: fs.PathLike, ...args: unknown[]) => {
    if (pathname === `/proc/${process.pid}`) throw Object.assign(new Error("read refused"), { code: "EACCES" });
    return Reflect.apply(stat, fs, [pathname, ...args]);
  }) as typeof fs.statSync);
  restores.push(() => denied.mockRestore());
  expect(await pipelineStageHostTerminated(f.target)).toBeFalse();
});

test.each(["child", "pane", "waiter", "pending-waiter", "exit-process"] as const)("a live %s preserves a host whose native pid is absent", async kind => {
  const f = host(30 + ["child", "pane", "waiter", "pending-waiter", "exit-process"].indexOf(kind),
    { pid: MISSING_PID, startIdentity: "old-start" });
  const snapshot = structuredClone(registry.readOnlySnapshot());
  const entry = snapshot.entries[sessionKeyId(f.key)]!;
  const live = captureProcessIdentity(process.pid);
  if (kind === "child") entry.structuredTerminationSurvivors = [live];
  if (kind === "pane") entry.paneAgent = live;
  if (kind === "waiter") entry.hostExitProcess = live;
  if (kind === "pending-waiter") entry.pendingHostExits = [{ process: live, launchId: null }];
  if (kind === "exit-process") entry.structuredHost!.exitProcess = live;
  fs.writeFileSync(registry.filename, JSON.stringify(snapshot));
  expect(await pipelineStageHostTerminated(f.target)).toBeFalse();
});

test("a live shared Viewer writer does not keep its dead native host unconfirmed", async () => {
  const f = host(57, { pid: MISSING_PID, startIdentity: "old-native" });
  const snapshot = structuredClone(registry.readOnlySnapshot());
  snapshot.entries[sessionKeyId(f.key)]!.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
  fs.writeFileSync(registry.filename, JSON.stringify(snapshot));
  savePipelines([lane([f])]);
  await tickPipelinesController([], ports());
  expect(loadPipelines()[0]!.unconfirmedHosts).toBeUndefined();
  expect(laneFinish(loadPipelines()[0]!).finished).toBeTrue();
});

test("a host restored during the awaited pane observation stays unconfirmed", async () => {
  const f = host(14, { pid: MISSING_PID, startIdentity: "old-start" });
  const record = lane([f]);
  record.unconfirmedHosts![0]!.paneId = "%fixture";
  savePipelines([record]);
  const p = ports();
  p.paneAgentAlive = async () => {
    const snapshot = structuredClone(registry.readOnlySnapshot());
    snapshot.entries[sessionKeyId(f.key)]!.structuredHost!.process = captureProcessIdentity(process.pid);
    fs.writeFileSync(registry.filename, JSON.stringify(snapshot));
    return false;
  };
  await tickPipelinesController([], p);
  expect(loadPipelines()[0]!.unconfirmedHosts).toHaveLength(1);
});

test("a later awaited host observation renews earlier termination proofs", async () => {
  const earlier = host(17, { pid: MISSING_PID, startIdentity: "old-start" });
  const later = host(18, { pid: MISSING_PID, startIdentity: "old-start" });
  const record = lane([earlier, later]);
  record.unconfirmedHosts![1]!.paneId = "%later";
  record.runs[0]!.attempts[1]!.paneId = "%later";
  savePipelines([record]);
  const p = ports();
  p.paneAgentAlive = async pane => {
    if (pane === "%later") {
      const snapshot = structuredClone(registry.readOnlySnapshot());
      snapshot.entries[sessionKeyId(earlier.key)]!.structuredHost!.process = captureProcessIdentity(process.pid);
      fs.writeFileSync(registry.filename, JSON.stringify(snapshot));
    }
    return false;
  };
  await tickPipelinesController([], p);
  // The later pane await changed registry evidence for the first host, so the
  // shared revision fence conservatively retains both proofs for a later tick.
  expect(loadPipelines()[0]!.unconfirmedHosts?.map(host => host.attempt)).toEqual([earlier.target.attempt, later.target.attempt]);
});

test.skipIf(process.env.LLV_HOST_RECONCILE_WORKER !== "1")("restart worker", async () => {
  await tickPipelinesController([], ports());
  await tickPipelinesController([], ports());
});

test.skipIf(process.platform !== "linux")("hidden live pids and an unavailable proc view cannot prove absence", () => {
  const identity = captureProcessIdentity(process.pid);
  const stat = fs.statSync;
  const hidden = spyOn(fs, "statSync").mockImplementation(((pathname: fs.PathLike, ...args: unknown[]) => {
    if (pathname === `/proc/${process.pid}`) throw Object.assign(new Error("hidden"), { code: "ENOENT" });
    return Reflect.apply(stat, fs, [pathname, ...args]);
  }) as typeof fs.statSync);
  restores.push(() => hidden.mockRestore());
  expect(recordedProcessTerminated(identity)).toBeFalse();
  hidden.mockRestore();
  const link = fs.readlinkSync;
  const unavailable = spyOn(fs, "readlinkSync").mockImplementation(((pathname: fs.PathLike, ...args: unknown[]) => {
    if (pathname === "/proc/self/ns/pid") throw Object.assign(new Error("unavailable"), { code: "ENOENT" });
    return Reflect.apply(link, fs, [pathname, ...args]);
  }) as typeof fs.readlinkSync);
  restores.push(() => unavailable.mockRestore());
  expect(recordedProcessTerminated({ ...identity, pid: MISSING_PID })).toBeFalse();
});

test("frozen close evidence preserves its surviving child across warm and replaced indexes", async () => {
  const f = host(53, { pid: MISSING_PID, startIdentity: "old-start" });
  const g = host(54, { pid: MISSING_PID, startIdentity: "old-start" });
  const record = lane([f, g], "closed");
  record.closeTeardown!.hosts = record.runs[0]!.attempts.map((attempt, index) => ({ target: [f, g][index]!.target,
    evidence: { ...attempt, unresolvedTermination: index === 0 ? { survivors: [captureProcessIdentity(process.pid)],
      error: "captured child remains", recordedAt: OLD } : undefined } }));
  const { indexControllerGuards, controllerClosedHosts } = await import("./controllerScope");
  indexControllerGuards(record);
  // Simulate the pre-upgrade cache shape retained by a development reload.
  const caches = (globalThis as unknown as { __llvPipelineGuardIndexes: WeakMap<Pipeline, { version?: number }> }).__llvPipelineGuardIndexes;
  delete caches.get(record)!.version;
  expect(controllerClosedHosts(record, f.target)?.[0]?.evidence.unresolvedTermination?.survivors).toHaveLength(1);
  savePipelines([record]);
  await tickPipelinesController([], ports());
  const held = loadPipelines()[0]!;
  expect(held.unconfirmedHosts?.map(host => host.attempt)).toEqual([f.target.attempt]);
  expect(laneFinish(held).finished).toBeFalse();
  held.project = "replacement-project";
  held.closeTeardown!.hosts!.reverse();
  held.closeTeardown!.hosts!.find(host => host.target.attempt === f.target.attempt)!.evidence.unresolvedTermination!.survivors
    = [{ pid: MISSING_PID, startIdentity: "captured-old-child" }];
  savePipelines([held]);
  await tickPipelinesController([], ports());
  const final = loadPipelines()[0]!;
  expect(final.unconfirmedHosts).toBeUndefined();
  expect(final.closeTeardown!.hosts!.every(host => !host.evidence.unresolvedTermination)).toBeTrue();
  expect(laneFinish(final).finished).toBeTrue();
});

test("checkpoint admission renews proof after a registry host replacement", async () => {
  const f = host(55, { pid: MISSING_PID, startIdentity: "old-start" });
  savePipelines([lane([f])]);
  const { SqliteStateCollection } = await import("@/lib/state/sqliteStateStore");
  const reconcile = SqliteStateCollection.prototype.reconcileSnapshot;
  let restored = false;
  const hook = spyOn(SqliteStateCollection.prototype, "reconcileSnapshot").mockImplementation(function (this: unknown, operation, ...args) {
    return Reflect.apply(reconcile, this, [(records: Pipeline[], persist: (records?: readonly Pipeline[]) => Promise<void>, assertCurrent: (record: Pipeline) => void) =>
      operation(records, async selected => {
        if (!restored && selected?.some(record => record.id === "finished-hosts" && !record.unconfirmedHosts)) {
          restored = true;
          const snapshot = structuredClone(registry.readOnlySnapshot());
          snapshot.entries[sessionKeyId(f.key)]!.structuredHost!.process = captureProcessIdentity(process.pid);
          fs.writeFileSync(registry.filename, JSON.stringify(snapshot));
        }
        await persist(selected);
      }, assertCurrent), ...args]);
  });
  restores.push(() => hook.mockRestore());
  await tickPipelinesController([], ports());
  expect(restored).toBeTrue();
  expect(loadPipelines()[0]!.unconfirmedHosts).toHaveLength(1);
  expect(laneFinish(loadPipelines()[0]!).finished).toBeFalse();
});

test.skipIf(worker)("large retained trees persist bounded proof progress through restart and source changes", async () => {
  const f = host(56, { pid: MISSING_PID, startIdentity: "native-old" });
  const snapshot = structuredClone(registry.readOnlySnapshot());
  snapshot.entries[sessionKeyId(f.key)]!.structuredTerminationSurvivors = Array.from({ length: 100 }, (_, index) =>
    ({ pid: MISSING_PID, startIdentity: `child-${String(index).padStart(3, "0")}` }));
  fs.writeFileSync(registry.filename, JSON.stringify(snapshot));
  savePipelines([lane([f])]);
  const p = ports();
  let checked = 0;
  p.stageHostTermination = async (target, input) => {
    const result = await probePipelineStageHostTermination(target, input);
    checked += result.checked;
    return result;
  };
  await tickPipelinesController([], p);
  expect(checked).toBe(64);
  let held = loadPipelines()[0]!;
  expect(held.unconfirmedHosts).toHaveLength(1);
  const first = Object.values(held.hostTerminationProofs!)[0]!;
  expect(first.next).toBe(64);
  const failed = spyOn(registry, "livenessConversationSnapshot").mockImplementation(() => { throw new Error("temporarily unavailable"); });
  restores.push(() => failed.mockRestore());
  await tickPipelinesController([], ports());
  expect(Object.values(loadPipelines()[0]!.hostTerminationProofs!)[0]).toEqual(first);
  failed.mockRestore();
  held = loadPipelines()[0]!;
  held.project = "other-proof-namespace";
  savePipelines([held]);
  checked = 0;
  await tickPipelinesController([], p);
  expect(checked).toBe(64);
  const replaced = Object.values(loadPipelines()[0]!.hostTerminationProofs!)[0]!;
  expect(replaced.source).not.toBe(first.source);
  expect(replaced.next).toBe(64);
  const live = structuredClone(snapshot);
  live.entries[sessionKeyId(f.key)]!.structuredTerminationSurvivors!.push(captureProcessIdentity(process.pid));
  fs.writeFileSync(registry.filename, JSON.stringify(live));
  await tickPipelinesController([], ports());
  expect(loadPipelines()[0]!.unconfirmedHosts).toHaveLength(1);
  fs.writeFileSync(registry.filename, JSON.stringify(snapshot));
  await tickPipelinesController([], ports());
  const child = Bun.spawn(["bash", process.env.LLV_TEST_GATE_WRAPPER ?? path.resolve("scripts/gate-slot.sh"), process.execPath, "test", "src/lib/pipelines/unconfirmedHosts.test.ts", "--test-name-pattern", "^restart worker$"], {
    env: { ...process.env, LLV_HOST_RECONCILE_WORKER: "1", LLV_HOST_RECONCILE_PHASE: "20" }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout: code ? stdout : "", stderr: code ? stderr : "" }).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(loadPipelines()[0]!.unconfirmedHosts).toBeUndefined();
  expect(loadPipelines()[0]!.hostTerminationProofs).toBeUndefined();
  expect(laneFinish(loadPipelines()[0]!).finished).toBeTrue();
});

test.skipIf(process.env.LLV_HOST_RECONCILE_WORKER === "1")("bounded windows pass a live prefix and resume in a fresh process", async () => {
  const hosts = Array.from({ length: 40 }, (_, index) => host(100 + index, index < 16 ? captureProcessIdentity(process.pid)
    : { pid: MISSING_PID, startIdentity: "old-start" }));
  savePipelines([lane(hosts)]);
  const p = ports();
  let probes = 0;
  p.stageHostTermination = async (target, input) => { probes++; return probePipelineStageHostTermination(target, input); };
  await tickPipelinesController([], p);
  expect(probes).toBeLessThanOrEqual(16);
  expect(loadPipelines()[0]!.unconfirmedHosts).toHaveLength(40);
  for (let phase = 0; phase < 8; phase++) {
    const child = Bun.spawn(["bash", process.env.LLV_TEST_GATE_WRAPPER ?? path.resolve("scripts/gate-slot.sh"), process.execPath, "test", "src/lib/pipelines/unconfirmedHosts.test.ts", "--test-name-pattern", "^restart worker$"], {
      env: { ...process.env, LLV_HOST_RECONCILE_WORKER: "1", LLV_HOST_RECONCILE_PHASE: String(phase + 1) }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout: code ? stdout : "", stderr: code ? stderr : "" }).toEqual({ code: 0, stdout: "", stderr: "" });
  }
  const final = loadPipelines()[0]!;
  expect(final.unconfirmedHosts?.map(host => host.attempt)).toEqual(hosts.slice(0, 16).map(({ target }) => target.attempt));
  expect(laneFinish(final).finished).toBeFalse();
});
