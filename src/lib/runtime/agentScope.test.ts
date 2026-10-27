import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { captureProcessIdentity, systemBootEpoch } from "@/lib/processIdentity";
import { applyConversationAction } from "@/lib/conversation/actions";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "./client";
import { AgentMemoryCell, GIB, planAgentMemory, wrapAgentCommand } from "./agentMemory";
import { memoryField } from "./agentMemoryState";
import { planAgentCpu } from "./cpuPlacement";
import { codexHostColumns, claudeHostColumns, copilotHostColumns } from "./registry";
import type { HostState } from "./engineHost";
import { agentScopeCommand, recordedAgentScope, stopAgentScope } from "./agentScope";
import { dispatchStructuredControl } from "./structuredControls";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { runStructuredHostRetirementSweep } from "./structuredHostRetirement";
import { determined } from "./determinable";
import { terminateStructuredHostTree } from "./structuredHostControl";

const scope = { unit: "delegatus-agent-fixture.scope", bootEpoch: "fixture-boot" };

test("scope teardown requires collection and addresses all cgroup members", async () => {
  const calls: string[][] = [];
  let reads = 0;
  await stopAgentScope(scope, { authorize() {}, bootEpoch: () => scope.bootEpoch,
    command: async args => { calls.push(args); return args[0] === "show" ? (++reads === 1 ? "loaded" : "not-found") : ""; } });
  expect(calls).toEqual([
    ["show", "--value", "-p", "LoadState", scope.unit],
    ["kill", "--kill-who=all", "--signal=SIGKILL", scope.unit],
    ["stop", "--no-block", scope.unit],
    ["show", "--value", "-p", "LoadState", scope.unit],
  ]);
});

test.each(["unreadable", "kill-refused", "stop-refused", "surviving"])("%s scope keeps teardown unsuccessful", async failure => {
  await expect(stopAgentScope(scope, { authorize() {}, bootEpoch: () => scope.bootEpoch, deadlineMs: 30,
    command: async args => {
      if (failure === "unreadable" || args[0] === failure.split("-")[0]) throw new Error(failure);
      return "loaded";
    } })).rejects.toThrow(failure === "surviving" ? "survived" : failure);
});

test.each([1, 2, 3])("authority lost at command boundary %i prevents later effects", async boundary => {
  let current = true;
  const calls: string[] = [];
  await expect(stopAgentScope(scope, { authorize() { if (!current) throw new Error("replacement"); }, bootEpoch: () => scope.bootEpoch,
    command: async args => { calls.push(args[0]!); if (calls.length === boundary) current = false; return "loaded"; } })).rejects.toThrow("replacement");
  expect(calls).toHaveLength(boundary);
});

test("collected and foreign-boot units never receive a signal", async () => {
  const calls: string[] = [];
  const command = async (args: string[]) => { calls.push(args[0]!); return "not-found"; };
  await stopAgentScope(scope, { authorize() {}, command, bootEpoch: () => scope.bootEpoch });
  expect(calls).toEqual(["show"]);
  await expect(stopAgentScope(scope, { authorize() {}, command, bootEpoch: () => "next-boot" })).rejects.toThrow("boot identity");
  expect(calls).toEqual(["show"]);
});

test.each(["command", "authority"])("a hung %s is bounded by the whole stop deadline", async kind => {
  const never = new Promise<never>(() => {});
  await expect(stopAgentScope(scope, { authorize() {}, bootEpoch: () => scope.bootEpoch, deadlineMs: 30,
    command: async () => kind === "command" ? never : "loaded",
    authorizeAsync: async () => { if (kind === "authority") await never; },
  })).rejects.toThrow("deadline exceeded");
});

(process.platform === "win32" ? test.skip : test)("CPU-only scope evidence survives every host writer and a fresh registry reader", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-codec-"));
  const cpu = planAgentCpu("operator", {}, { probe: () => ({ kind: "available", systemdVersion: 252 }), runner: () => "" })!;
  const plan = planAgentMemory({ engine: "codex", sessionKey: "scope-codec", liveAgents: 1, cpu }, { DELEGATUS_AGENT_MEMORY: "off" })!;
  const cell = new AgentMemoryCell(plan);
  const filename = path.join(root, "registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
  try {
    expect(cell.memoryState()).toBeNull();
    const identity = captureProcessIdentity(process.pid);
    const state: HostState = { status: "dead", sessionKey: "scope-codec", endpoint: "stdio:released", pid: null,
      processStartIdentity: null, exitProcess: identity, eventCursor: 0, protocolVersion: null,
      activeTurnRef: null, pendingAttention: [], activeFlags: [], ...memoryField(cell) };
    for (const [index, writer] of [codexHostColumns, claudeHostColumns, copilotHostColumns].entries()) {
      const key = { engine: "codex" as const, sessionId: `scope-codec-${index}` };
      const columns = writer(state, 1);
      expect(columns.process).toEqual(identity);
      expect(recordedAgentScope(columns)).toEqual(cell.scopeState());
      registry.upsert({ key, artifactPath: "", cwd: root, accountId: null, status: "dead", host: null,
        structuredHost: columns, claimEpoch: 1, claimOwner: null, pendingAction: null });
    }
    registry.close();
    const result = Bun.spawnSync([process.execPath, "-e", `
      const { AgentRegistry } = await import(${JSON.stringify(path.resolve("src/lib/agent/registry.ts"))});
      const r = new AgentRegistry(process.argv[1], undefined, undefined, { sqliteMode: "off" });
      console.log(JSON.stringify(Object.values(r.readOnlySnapshot().entries).map(e => e.structuredHost.scope)));
      r.close();
    `, filename], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual(Array(3).fill(cell.scopeState()));
  } finally { cell.close(); registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a dead-root scope refusal prevents registry retirement", async () => {
  let retired = false;
  const ref = { kind: "structured" as const, pid: 424_242, startIdentity: "fixture-root", bootEpoch: systemBootEpoch(), engine: "codex" as const,
    sessionId: "scope-refusal", conversationId: null, seat: false, turnBusy: false, owned: false, lastActiveAt: null };
  const result = await terminateStructuredHostTree(ref, { scope: { ...scope, bootEpoch: ref.bootEpoch }, pidAlive: () => false, processIdentity: () => null,
    protectedPids: () => new Set(), stopScope: async () => { throw new Error("scope refused"); },
    retireRegistryEntry: () => { retired = true; } });
  expect(result).toMatchObject({ ok: false, error: "scope refused" });
  expect(retired).toBe(false);
});

test.each([1, 2, 3])("replacement claim at scope command %i retains the original scope evidence", async boundary => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-replacement-"));
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const key = { engine: "codex" as const, sessionId: "scope-replacement" };
  const identity = { pid: 424_242, startIdentity: "fixture-root", bootEpoch: systemBootEpoch()! };
  const recorded = { ...scope, bootEpoch: identity.bootEpoch };
  const columns = { kind: "codex-app-server" as const, endpoint: "stdio:released", process: identity, scope: recorded,
    eventCursor: 0, protocolVersion: null, writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] };
  registry.upsert({ key, artifactPath: "", cwd: root, accountId: null, status: "dead", host: null,
    structuredHost: columns, claimEpoch: 1, claimOwner: null, pendingAction: null });
  setAgentRegistryForTests(registry);
  const calls: string[] = [];
  try {
    if (boundary === 1) {
      const stale = await terminateStructuredHostTree({ kind: "structured", ...identity, pid: identity.pid - 1, engine: "codex", sessionId: key.sessionId,
        conversationId: null, seat: false, turnBusy: false, owned: false, lastActiveAt: null }, {
        pidAlive: () => false, processIdentity: () => null, protectedPids: () => new Set(),
        stopScope: async () => { throw new Error("a stale target reached the replacement scope"); },
      });
      expect(stale).toMatchObject({ ok: false, error: "structured scope belongs to a different host" });
    }
    const result = await terminateStructuredHostTree({ kind: "structured", ...identity, engine: "codex", sessionId: key.sessionId,
      conversationId: null, seat: false, turnBusy: false, owned: false, lastActiveAt: null }, {
      pidAlive: () => false, processIdentity: () => null, protectedPids: () => new Set(),
      stopScope: (target, options) => stopAgentScope(target, { ...options, command: async args => {
        calls.push(args[0]!);
        if (calls.length === boundary) registry.upsert({ ...registry.readOnlySnapshot().entries[`codex:${key.sessionId}`]!,
          claimEpoch: 2, claimOwner: "structured-host:replacement", structuredHost: { ...columns, writerClaimEpoch: 2 } });
        return "loaded";
      } }),
    });
    expect(result).toMatchObject({ ok: false, error: "structured scope target changed" });
    expect(calls).toHaveLength(boundary);
    expect(registry.readOnlySnapshot().entries[`codex:${key.sessionId}`]).toMatchObject({ claimEpoch: 2, structuredHost: { scope: recorded } });
    expect(() => registry.setStructuredHost(key, null, "dead")).toThrow("scope must be retired");
    expect(registry.terminateStructuredHost(key)).toBe(false);
    registry.close();
    const reopened = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    try { expect(reopened.readOnlySnapshot().entries[`codex:${key.sessionId}`]?.structuredHost?.scope).toEqual(recorded); }
    finally { reopened.close(); }
  } finally { setAgentRegistryForTests(null); registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

const realScopeTest = process.platform === "linux" && process.env.LLV_AGENT_MEMORY_SCOPE_TEST === "1" ? test : test.skip;
realScopeTest.each([
  ["memory", "controller"], ["cpu", "controller"], ["memory", "tree"], ["cpu", "tree"], ["memory", "retirement"], ["cpu", "retirement"], ["legacy", "controller"], ["legacy", "tree"], ["legacy", "retirement"], ["legacy-sqlite", "controller"], ["legacy-sqlite", "tree"], ["legacy-sqlite", "retirement"],
])("gone conversation removes its private %s scope through %s after restart", async (mode, route) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-kill-"));
  const sqliteMode = mode === "legacy-sqlite" ? "sqlite" : "off";
  const cpu = planAgentCpu("operator", {}, { probe: () => ({ kind: "available", systemdVersion: 252 }), runner: () => "" })!;
  const plan = planAgentMemory({ engine: "codex", sessionKey: "gone-scope", liveAgents: 1, ...(mode === "cpu" ? { cpu } : {}) },
    { DELEGATUS_AGENT_MEMORY: mode === "cpu" ? "off" : "scope", DELEGATUS_AGENT_MEMORY_MAX: "1G" },
    { totalBytes: 8 * GIB, probe: () => 252, runner: () => "" })!;
  // Keep every test-owned unit below its own slice; never configure the serving slice.
  plan.slice = `delegatus-scope-test-${plan.unit!.split("-").at(-1)!.replace(".scope", "")}.slice`;
  if (plan.cpu) plan.cpu = { ...plan.cpu, slice: plan.slice };
  const cell = new AgentMemoryCell(plan);
  const identityModule = path.resolve("src/lib/processIdentity.ts");
  const wrapped = wrapAgentCommand(plan, process.execPath, ["-e", `
    const { spawn } = await import("node:child_process");
    const { captureProcessIdentity } = await import(${JSON.stringify(identityModule)});
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    child.unref();
    console.log(JSON.stringify({ root: captureProcessIdentity(process.pid), child: child.pid }));
  `]);
  const child = Bun.spawn([wrapped.command, ...wrapped.args], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  const errorText = new Response(child.stderr).text();
  let registry: AgentRegistry | null = null;
  let journal: RuntimeJournal | null = null;
  try {
    const output = await new Response(child.stdout).text();
    expect(await child.exited, await errorText).toBe(0);
    const observed = JSON.parse(output.trim()) as { root: ReturnType<typeof captureProcessIdentity>; child: number };
    expect(fs.readFileSync(`/proc/${observed.child}/cgroup`, "utf8")).toContain(plan.unit!);
    expect(await agentScopeCommand(["show", "--value", "-p", "LoadState", plan.unit!])).toBe("loaded");
    const filename = path.join(root, "registry.json");
    registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode });
    const sessionId = ["aaaaaaaa", "aaaa", "4aaa", "8aaa", "aaaaaaaaaaaa"].join("-");
    const artifactPath = path.join(root, `${sessionId}.jsonl`);
    fs.writeFileSync(artifactPath, "");
    registry.reconcileConversations([{ engine: "codex", path: artifactPath, accountId: null,
      launchProfile: emptyLaunchProfile({ cwd: root }), turn: { state: "idle", source: "assistant", terminalAt: null },
      observedAt: "2026-10-27T00:00:00.000Z" }]);
    const conversation = registry.conversationForPath(artifactPath)!;
    const key = { engine: "codex" as const, sessionId };
    const columns = codexHostColumns({ status: "dead", sessionKey: sessionId, endpoint: "stdio:released", pid: null,
      processStartIdentity: null, exitProcess: observed.root, eventCursor: 0, protocolVersion: null,
      activeTurnRef: null, pendingAttention: [], activeFlags: [], ...memoryField(cell) }, 1);
    if (mode.startsWith("legacy")) { delete columns.scope; columns.process = null; }
    registry.upsert({ key, artifactPath, cwd: root, accountId: null, launchProfile: emptyLaunchProfile({ cwd: root }),
      status: "dead", host: null, structuredHost: columns, claimEpoch: 1, claimOwner: null, pendingAction: null });
    registry.close();
    registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode });
    setAgentRegistryForTests(registry);
    journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true });
    const j = journal;
    const client = { snapshot: async () => j.snapshot(), readSession: async identity => j.readSession(identity),
      events: async after => j.replay(after), append: async event => j.append(event), command: async command => j.executeOperation(command),
      operationStatus: async id => j.operationResult(id), effectBatch: async (kinds, after) => j.effectBatch(100, kinds, after),
      transitionOperation: async (id, status, details) => j.transitionOperation(id, status, details) } as RuntimeHostClient;
    journal.append({ scope: { type: "session", id: conversation.id }, kind: "session-status", payload: {
      conversationId: conversation.id, sessionKey: key, hostKind: "codex-app-server", host: "dead", turn: "idle", provenance: "structured", artifactPath,
      capabilities: { steer: true, structuredAttention: true } } });
    await bindStructuredDeliveryQueue([], { registry, client });
    if (route === "tree") {
      const result = await terminateStructuredHostTree({ kind: "structured", pid: observed.root.pid, startIdentity: observed.root.startIdentity,
        bootEpoch: observed.root.bootEpoch ?? null, engine: "codex", sessionId, conversationId: conversation.id,
        seat: false, turnBusy: false, owned: false, lastActiveAt: null });
      expect(result).toMatchObject({ ok: true });
    } else if (route === "retirement") {
      const report = await runStructuredHostRetirementSweep({ idleMs: 1, now: () => Date.parse("2030-01-01T00:00:00Z"),
        snapshot: () => registry!.readOnlySnapshot(), publicationState: () => "ready", handoffRows: () => determined([]),
        orchestratorSeatConversations: () => determined(new Set()), revokedSeatConversations: () => determined(new Set()),
        durableEventTail: () => determined(0), realtimeBound: () => determined(false), record: () => {} });
      expect(report.failed).toEqual([]);
      expect(report.refused).toEqual([]);
      expect(report.retired).toHaveLength(1);
    } else {
    const unexpected = async () => { throw new Error("unexpected legacy action"); };
    const result = await applyConversationAction({ conversationId: conversation.id, transcriptPath: artifactPath, action: "kill", operationId: "gone-scope-kill" }, {
      registry: () => registry!, structuredEnabled: () => true,
      dispatchStructuredControl: request => dispatchStructuredControl(request, { registry: registry!, client, enabled: () => true, kick: () => {} }),
      interruptConversation: unexpected, killConversation: unexpected, resumeConversation: unexpected, compactConversation: unexpected, answerDialogKey: unexpected,
    });
    expect(result.status).toBeLessThan(300);
    await kickStructuredDeliveryQueue();
    expect(journal.operationResult("gone-scope-kill")?.receipt.status).toBe("delivered");
    }
    expect(await agentScopeCommand(["show", "--value", "-p", "LoadState", plan.unit!])).toBe("not-found");
    expect(registry.readOnlySnapshot().entries[`codex:${sessionId}`]?.structuredHost).toBeNull();
  } finally {
    if (registry) await bindStructuredDeliveryQueue([], { registry, client: null });
    setAgentRegistryForTests(null);
    journal?.close(); registry?.close(); cell.close();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await stopAgentScope({ unit: plan.unit!, bootEpoch: systemBootEpoch()! }, { authorize() {} });
    await agentScopeCommand(["stop", plan.slice]);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
