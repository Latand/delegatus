import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, setAgentRegistryForTests, structuredClaimIdentity } from "@/lib/agent/registry";
import { clearAgentObservations } from "@/lib/agentState/projectionCache";
import { fixtureRecords, fixtureRegistry, FIXTURE_CONVERSATION, FIXTURE_NOW, FIXTURE_SESSION } from "@/lib/agentState/testFixture";
import { captureProcessIdentity, type ProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { statePath } from "@/lib/configDir";
import { stopFixtureIdentity } from "@/lib/testing/fixtureProcess";
import { determined } from "./determinable";
import type { HandoffRow } from "./handoffQueue";
import * as control from "./structuredHostControl";
import { runStructuredHostRetirementSweep, trustedMcpEntry } from "./structuredHostRetirement";

const identities: ProcessIdentity[] = [], roots: string[] = [], registries: AgentRegistry[] = [];
afterEach(async () => {
  const owned = new Map(identities.splice(0).map(identity => [`${identity.pid}:${identity.startIdentity}`, identity]));
  if (process.platform === "linux") {
    const pending = [...owned.values()].map(identity => identity.pid), visited = new Set<number>();
    while (pending.length && visited.size < 512) {
      const pid = pending.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);
      let tids: string[];
      try { tids = fs.readdirSync(`/proc/${pid}/task`).filter(tid => /^\d+$/.test(tid)); } catch { continue; }
      for (const tid of tids) {
        let children: string[];
        try { children = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim().split(/\s+/).filter(Boolean); } catch { continue; }
        for (const child of children) {
          const childPid = Number(child);
          if (!Number.isSafeInteger(childPid) || childPid <= 0 || visited.has(childPid)) continue;
          const identity = captureProcessIdentity(childPid);
          owned.set(`${identity.pid}:${identity.startIdentity}`, identity);
          pending.push(childPid);
        }
      }
    }
  }
  for (const identity of [...owned.values()].reverse()) await stopFixtureIdentity(identity);
  clearAgentObservations();
  setAgentRegistryForTests(null);
  for (const registry of registries.splice(0)) registry.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function start(args: string[]): ChildProcess {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  identities.push(captureProcessIdentity(child.pid!));
  return child;
}
async function ready(child: ChildProcess): Promise<number> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture readiness deadline")), 4000);
      child.stdout!.once("data", chunk => { clearTimeout(timer); const value = String(chunk).trim();
        const pid = (() => { try { return JSON.parse(value).pid; } catch { return Number(value); } })();
        const tracked = identities.findIndex(identity => identity.pid === child.pid);
        if (tracked >= 0) identities[tracked] = captureProcessIdentity(child.pid!);
        resolve(pid); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture exited before ready: ${code}`)); });
  });
}
async function waitForTrustedMcpEntry(filename: string): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    if (trustedMcpEntry(filename)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("historical MCP source proof did not settle");
}

// The successor reconciles from disk in a fresh process, with no predecessor
// memory/cache. Its state and all processes in these tests belong to fixtures.
const reconcile = `
  import path from "node:path";
  import { AgentRegistry } from "./src/lib/agent/registry";
  import { AgentStateService } from "./src/lib/agentState/service";
  import { observeAgentProcess } from "./src/lib/agentState/process";
  const root = process.argv[1];
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined,
    { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") });
  const service = new AgentStateService({ registry, now: () => Number(process.argv[2]),
    owns: () => true, process: observeAgentProcess, memory: () => null, release: "fixture", publish: async () => true });
  await service.request(); service.stop(); registry.close();
`;

for (const scenario of ["closed-hour", "open-62h", "open-76h", "six-hours", "bundled-mcp", "historical-mcp", "absent-owner", "legacy-owner", "legacy-live-closed", "legacy-live-open", "foreign-owner-closed", "foreign-owner-open", "delivery", "held-delivery", "question", "tool", "mcp-tool", "live-owner", "owner-proc-denied", "recent", "setup", "flags", "tree-denied", "capture-tool", "capture-delivery", "capture-owner", "capture-transcript"] as const) {
  test.skipIf(process.platform !== "linux")(`restart retirement: ${scenario}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "abandoned-fixture-")); roots.push(root);
    fs.mkdirSync(path.join(root, "bin"));
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "lifetime.mjs"), "setInterval(() => {}, 1000);");
    const childScript = path.join(root, scenario === "tool" ? "tool.mjs" : scenario === "bundled-mcp" ? "dist/mcp-server.mjs" : "bin/mcp-server.mjs");
    fs.writeFileSync(childScript, scenario === "mcp-tool"
      ? 'import {spawn} from "node:child_process"; const c=spawn("sleep",["60"],{stdio:"ignore"}); console.log(c.pid); setInterval(()=>{},1000);'
      : 'console.log(process.pid); setInterval(()=>{},1000);');
    let launchedScript = ["tool", "bundled-mcp", "mcp-tool"].includes(scenario)
      ? childScript : path.join(process.cwd(), "bin/mcp-server.mjs");
    if (scenario === "historical-mcp") {
      const packageRoot = path.join(root, "previous-package");
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.cpSync(path.join(process.cwd(), "bin"), path.join(packageRoot, "bin"), { recursive: true });
      fs.cpSync(path.join(process.cwd(), "src"), path.join(packageRoot, "src"), { recursive: true });
      fs.copyFileSync(path.join(process.cwd(), "tsconfig.json"), path.join(packageRoot, "tsconfig.json"));
      fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(packageRoot, "node_modules"), "dir");
      const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
      fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "delegatus-cli", gitHead: revision }));
      launchedScript = path.join(packageRoot, "bin", "mcp-server.mjs");
      await waitForTrustedMcpEntry(launchedScript);
      await waitForTrustedMcpEntry(path.join(packageRoot, "src", "lib", "mcp", "entry.ts"));
    }
    const mcpToolPreload = path.join(root, "mcp-tool-preload.mjs");
    if (scenario === "mcp-tool") fs.writeFileSync(mcpToolPreload,
      'import { spawn } from "node:child_process"; globalThis.fixtureTool = spawn("sleep", ["60"], { stdio: "ignore" });');
    const hostScript = path.join(root, "host.mjs");
    const mcpReady = path.join(root, "mcp-ready");
    const childArgs = scenario === "mcp-tool" ? ["--preload", mcpToolPreload, launchedScript]
      : ["--preload", path.join(root, "lifetime.mjs"), launchedScript];
    const realMcp = ["open-62h", "open-76h", "six-hours", "historical-mcp", "mcp-tool"].includes(scenario);
    const spawnChild = realMcp || ["tool", "bundled-mcp"].includes(scenario);
    fs.writeFileSync(hostScript, `import {spawn} from "node:child_process"; import fs from "node:fs";
      const childEnv={...process.env}; delete childEnv.LLV_SPAWN_CAPABILITY;
      const c=${spawnChild ? `spawn(process.execPath,${JSON.stringify(childArgs)},{detached:true,env:childEnv,stdio:${realMcp ? '["pipe","pipe","inherit"]' : '["ignore","pipe","inherit"]'}})` : "null"};
      ${realMcp ? `let pending=""; c.stdout.on("data", chunk => { pending += chunk; for (;;) { const end=pending.indexOf("\\n"); if(end<0) break; const line=pending.slice(0,end); pending=pending.slice(end+1); try { const msg=JSON.parse(line); if(msg.id===1 && msg.result) fs.writeFileSync(${JSON.stringify(mcpReady)},"ready"); } catch {} } });
      c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"retirement-fixture",version:"1"}}})+"\\n");` : ""}
      console.log(JSON.stringify({pid:c?.pid ?? process.pid}));
      process.on("SIGTERM", () => { if (c?.stdin && !c.stdin.destroyed) c.stdin.end(); if (c) c.once("exit", () => process.exit(0)); else process.exit(0); });
      setInterval(()=>{},1000);`);
    const host = start([hostScript]);
    const mcpPid = await ready(host);
    const identity = identities[identities.length - 1]!;
    identities.push(captureProcessIdentity(mcpPid));
    if (realMcp) {
      const deadline = Date.now() + 12_000;
      while (!fs.existsSync(mcpReady) && host.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      expect(fs.existsSync(mcpReady)).toBe(true);
    }
    if (scenario === "mcp-tool") {
      // Capture only the child this fixture MCP started, before any teardown.
      await new Promise(resolve => setTimeout(resolve, 50));
      const children = fs.readdirSync(`/proc/${mcpPid}/task`).flatMap(tid =>
        fs.readFileSync(`/proc/${mcpPid}/task/${tid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number));
      expect(children.some(pid => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("sleep"))).toBe(true);
      identities.push(...children.map(pid => captureProcessIdentity(pid)));
    }
    const predecessor = start(["--eval", "console.log(process.pid); setInterval(()=>{},1000)"]);
    await ready(predecessor);
    const owner = identities[identities.length - 1]!;
    await stopFixtureIdentity(owner);
    if (predecessor.exitCode === null && predecessor.signalCode === null) {
      await new Promise<void>(resolve => predecessor.once("exit", () => resolve()));
    }
    const file = fixtureRegistry(root, "codex", identity, scenario === "absent-owner" ? null
      : ["live-owner", "owner-proc-denied"].includes(scenario) ? captureProcessIdentity(process.pid)
        : ["legacy-live-closed", "legacy-live-open"].includes(scenario)
          ? { pid: process.pid, startIdentity: captureProcessIdentity(process.pid).startIdentity }
          : ["legacy-owner", "foreign-owner-closed", "foreign-owner-open"].includes(scenario)
            ? { pid: 2_147_483_647, startIdentity: "owner-from-unrecorded-pid-namespace" }
          : owner);
    const entry = file.entries[`codex:${FIXTURE_SESSION}`]!;
    entry.structuredHostOperationId = null;
    if (scenario === "question") entry.structuredHost!.pendingAttention = ["fixture-question"];
    if (scenario === "flags") entry.structuredHost!.activeFlags = ["fixture-active-work"];
    if (scenario === "setup") entry.pendingAction = "resume";
    const records = fixtureRecords("codex");
    const text = [...records.open, ...(["closed-hour", "legacy-owner", "legacy-live-closed", "foreign-owner-closed"].includes(scenario) ? records.close : [])].map(row => JSON.stringify(row)).join("\n") + "\n";
    fs.writeFileSync(entry.artifactPath!, text);
    fs.utimesSync(entry.artifactPath!, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
    fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify(file));
    const hours = ["closed-hour", "legacy-owner", "legacy-live-closed", "foreign-owner-closed"].includes(scenario) ? 1 : scenario === "recent" ? 6 - 1 / 60
      : scenario === "six-hours" ? 6 : scenario === "open-76h" ? 76 : 62;
    const now = FIXTURE_NOW + hours * 3_600_000;
    const successor = Bun.spawn([process.execPath, "--eval", reconcile, root, String(now)], { stdout: "pipe", stderr: "pipe" });
    identities.push(captureProcessIdentity(successor.pid));
    const [exit, stderr] = await Promise.all([successor.exited, new Response(successor.stderr).text()]);
    expect(stderr).toBe(""); expect(exit).toBe(0);
    const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined,
      { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") });
    registries.push(registry); setAgentRegistryForTests(registry);
    if (scenario === "held-delivery") registry.holdDelivery(FIXTURE_CONVERSATION, "fixture work", "fixture-held-message");
    const original = control.terminateStructuredHostTree;
    let captures = 0, signals = 0, capturedTree: readonly ProcessIdentity[] = [];
    const stop = spyOn(control, "terminateStructuredHostTree").mockImplementation((ref, dependencies) => original(ref, {
      ...dependencies, terminateOwnedHost: async () => false, graceMs: 50, deadlineMs: 2000,
      persistCapturedTree: async tree => {
        capturedTree = tree;
        const accepted = await dependencies!.persistCapturedTree!(tree);
        if (accepted) captures++;
        if (scenario === "capture-tool") {
          const tool = start(["--eval", "console.log(process.pid); setInterval(()=>{},1000)"]);
          await ready(tool);
          // Enrol a fixture-owned tool as a newly retained member, exactly as
          // a child found during captured-tree expansion would be enrolled.
          expect(registry.recordStructuredTerminationSurvivors(entry.key, identity, [...tree, identities[identities.length - 1]!])).toBe(true);
        }
        if (scenario === "capture-owner") registry.agentStateWrite(rows => {
          rows.entries[`codex:${FIXTURE_SESSION}`]!.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
        });
        if (scenario === "capture-delivery") registry.holdDelivery(FIXTURE_CONVERSATION, "fixture work", "fixture-held-message");
        if (scenario === "capture-transcript") fs.appendFileSync(entry.artifactPath!, '{"type":"fixture-write"}\n');
        return accepted;
      },
      signal: (pid, signal) => { signals++; process.kill(pid, signal); },
    }));
    const read = fs.readdirSync.bind(fs);
    const denied = scenario === "tree-denied" ? spyOn(fs, "readdirSync").mockImplementation(((pathname: fs.PathLike, ...args: unknown[]) => {
      if (pathname === `/proc/${identity.pid}/task`) throw new Error("fixture denied tree");
      return Reflect.apply(read, fs, [pathname, ...args]);
    }) as typeof fs.readdirSync) : null;
    const stat = fs.statSync.bind(fs);
    const ownerProcDenied = scenario === "owner-proc-denied" ? spyOn(fs, "statSync").mockImplementation(((pathname: fs.PathLike, ...args: unknown[]) => {
      if (pathname === `/proc/${process.pid}`) throw Object.assign(new Error("fixture owner proc denied"), { code: "EACCES" });
      return Reflect.apply(stat, fs, [pathname, ...args]);
    }) as typeof fs.statSync) : null;
    try {
      const row: HandoffRow = { operationId: "fixture-delivery", engine: "codex", engineSessionId: FIXTURE_SESSION,
        conversationId: Object.keys(file.conversations)[0]!, kind: "root", parentConversationId: null,
        hostGeneration: "fixture-predecessor", accountId: null, turnState: "busy", status: "pending",
        pendingDeliveries: [{ deliveryId: "fixture-message", clientMessageId: null, seq: 1 }],
        predecessorGeneration: null, successorGeneration: null, replayedDeliveryIds: [], interruptionOutcome: null,
        lastError: null, enqueuedAt: new Date(FIXTURE_NOW).toISOString(), updatedAt: new Date(FIXTURE_NOW).toISOString() };
      if (realMcp) expect(procBackend.pidAlive(mcpPid) && !procBackend.processExited(mcpPid)).toBe(true);
      const report = await runStructuredHostRetirementSweep({ snapshot: () => registry.readOnlySnapshot(), requireAgentState: true,
        now: () => now, publicationState: () => "ready", handoffRows: () => determined(scenario === "delivery" ? [row] : []),
        durableEventTail: () => determined(0), realtimeBound: () => determined(false),
        orchestratorSeatConversations: () => determined(new Set<string>()), revokedSeatConversations: () => determined(new Set<string>()),
        readCursor: () => null, writeCursor: () => {}, graceMs: 50,
      });
      const eligible = ["closed-hour", "open-62h", "open-76h", "six-hours", "historical-mcp", "absent-owner"].includes(scenario);
      if (eligible) {
        expect(report.failed).toEqual([]); expect(report.refused).toEqual([]);
        expect(report.retired).toHaveLength(1); expect(captures).toBeGreaterThan(0); expect(signals).toBeGreaterThan(0);
        if (realMcp) {
          expect(procBackend.pidAlive(mcpPid) && !procBackend.processExited(mcpPid)).toBe(false);
          expect(capturedTree.some(member => member.pid === mcpPid)).toBe(true);
        }
        if (scenario !== "closed-hour") {
          expect(report.retired[0]!.reason).toBe("abandoned turn");
          const stored = JSON.parse(fs.readFileSync(statePath("host-retirement-report.json"), "utf8"));
          expect(stored.retired[0].reason).toBe("abandoned turn");
          const journal = fs.readFileSync(statePath("host-retirement-journal.ndjson"), "utf8").trim().split("\n");
          expect(JSON.parse(journal.at(-1)!).retired[0].reason).toBe("abandoned turn");
        } else expect(report.retired[0]!.reason).toBeUndefined();
        expect(procBackend.pidAlive(identity.pid) && !procBackend.processExited(identity.pid)).toBe(false);
        expect(procBackend.pidAlive(mcpPid) && !procBackend.processExited(mcpPid)).toBe(false);
      } else {
        expect(report.retired).toEqual([]); expect(signals).toBe(0);
        expect(procBackend.pidAlive(identity.pid)).toBe(true);
        if (scenario === "owner-proc-denied") expect(() => process.kill(process.pid, 0)).not.toThrow();
        expect(report.refused.length + report.failed.length).toBeGreaterThan(0);
      }
      expect(fs.readFileSync(entry.artifactPath!, "utf8")).toBe(scenario === "capture-transcript" ? text + '{"type":"fixture-write"}\n' : text);
    } finally { ownerProcDenied?.mockRestore(); denied?.mockRestore(); stop.mockRestore(); }
  }, 20_000);
}

test("the real claim writer publishes the boot domain for a legacy local caller and its decoder reads it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claim-fixture-")); roots.push(root);
  const file = fixtureRegistry(root, "codex", captureProcessIdentity(process.pid), null);
  const entry = file.entries[`codex:${FIXTURE_SESSION}`]!;
  entry.structuredHost!.process = null;
  fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify(file));
  const registry = new AgentRegistry(path.join(root, "registry.json")); registries.push(registry);
  const self = captureProcessIdentity(process.pid);
  const claim = registry.claimStructuredHost(entry.key, { pid: self.pid, startIdentity: self.startIdentity }, { allowUnhosted: true });
  expect(claim).not.toBeNull();
  expect(claim!.claimOwner).toContain(`"bootEpoch":"${self.bootEpoch}"`);
  expect(structuredClaimIdentity(claim!.claimOwner!)).toEqual(self);
});

test("MCP retirement exemption recognizes the canonical shipped entry and rejects lookalike paths", () => {
  expect(trustedMcpEntry(path.join(process.cwd(), "bin", "mcp-server.mjs"))).toBe(true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lookalike-")); roots.push(root);
  const fake = path.join(root, "bin", "mcp-server.mjs");
  fs.mkdirSync(path.dirname(fake), { recursive: true }); fs.writeFileSync(fake, "setInterval(() => {}, 1000);");
  expect(trustedMcpEntry(fake)).toBe(false);
});

test("MCP retirement exemption verifies a previous package entry against its source commit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-previous-package-")); roots.push(root);
  const entry = path.join(root, "bin", "mcp-server.mjs");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "bin", "mcp-server.mjs"), entry);
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "delegatus-cli", gitHead: revision }));
  await waitForTrustedMcpEntry(entry);
  fs.writeFileSync(entry, "setInterval(() => {}, 1000);\n");
  expect(trustedMcpEntry(entry)).toBe(false);
});

test("MCP retirement exemption verifies a managed release digest", () => {
  const root = path.join(statePath("mcp-runtime/releases"), `deploy-${"a".repeat(24)}`);
  const bundle = path.join(root, "dist", "mcp-server.mjs");
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  const source = "export {};\n";
  fs.writeFileSync(bundle, source);
  fs.writeFileSync(path.join(root, "runtime-release.json"), JSON.stringify({ source: "managed",
    releaseId: path.basename(root), artifactDigest: createHash("sha256").update(source).digest("hex") }));
  expect(trustedMcpEntry(bundle)).toBe(true);
  fs.writeFileSync(bundle, "export const changed = true;\n");
  expect(trustedMcpEntry(bundle)).toBe(false);
});
