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
  for (const identity of identities.splice(0).reverse()) await stopFixtureIdentity(identity);
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
    child.stdout!.once("data", chunk => { clearTimeout(timer); resolve(Number(String(chunk).trim())); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture exited before ready: ${code}`)); });
  });
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

for (const scenario of ["closed-hour", "open-62h", "open-76h", "six-hours", "bundled-mcp", "absent-owner", "legacy-owner", "delivery", "held-delivery", "question", "tool", "mcp-tool", "live-owner", "recent", "setup", "flags", "tree-denied", "capture-tool", "capture-delivery", "capture-owner", "capture-transcript"] as const) {
  test.skipIf(process.platform !== "linux")(`restart retirement: ${scenario}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "abandoned-fixture-")); roots.push(root);
    fs.mkdirSync(path.join(root, "bin"));
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "lifetime.mjs"), "setInterval(() => {}, 1000);");
    const childScript = path.join(root, scenario === "tool" ? "tool.mjs" : scenario === "bundled-mcp" ? "dist/mcp-server.mjs" : "bin/mcp-server.mjs");
    fs.writeFileSync(childScript, scenario === "mcp-tool"
      ? 'import {spawn} from "node:child_process"; const c=spawn("sleep",["60"],{stdio:"ignore"}); console.log(c.pid); setInterval(()=>{},1000);'
      : 'console.log(process.pid); setInterval(()=>{},1000);');
    const launchedScript = ["tool", "mcp-tool", "bundled-mcp"].includes(scenario)
      ? childScript : path.join(process.cwd(), "src/lib/mcp/entry.ts");
    const hostScript = path.join(root, "host.mjs");
    const childArgs = scenario === "bundled-mcp" ? ["--preload", path.join(root, "lifetime.mjs"), launchedScript]
      : ["tool", "mcp-tool"].includes(scenario) ? [launchedScript]
        : ["--preload", path.join(root, "lifetime.mjs"), launchedScript];
    fs.writeFileSync(hostScript, `import {spawn} from "node:child_process";
      const c=spawn(process.execPath,${JSON.stringify(childArgs)},{detached:true,stdio:["ignore","pipe","inherit"]});
      ${scenario === "mcp-tool" ? 'c.stdout.once("data", () => console.log(c.pid));' : "console.log(c.pid);"}
      setInterval(()=>{},1000);`);
    const host = start([hostScript]);
    const mcpPid = await ready(host);
    const identity = identities[identities.length - 1]!;
    identities.push(captureProcessIdentity(mcpPid));
    if (scenario === "mcp-tool") {
      // Capture only the child this fixture MCP started, before any teardown.
      await new Promise(resolve => setTimeout(resolve, 50));
      const children = fs.readdirSync(`/proc/${mcpPid}/task`).flatMap(tid =>
        fs.readFileSync(`/proc/${mcpPid}/task/${tid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number));
      expect(children).toHaveLength(1);
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
      : scenario === "live-owner" ? captureProcessIdentity(process.pid)
        : scenario === "legacy-owner" ? { pid: owner.pid, startIdentity: owner.startIdentity }
          : owner);
    const entry = file.entries[`codex:${FIXTURE_SESSION}`]!;
    entry.structuredHostOperationId = null;
    if (scenario === "question") entry.structuredHost!.pendingAttention = ["fixture-question"];
    if (scenario === "flags") entry.structuredHost!.activeFlags = ["fixture-active-work"];
    if (scenario === "setup") entry.pendingAction = "resume";
    const records = fixtureRecords("codex");
    const text = [...records.open, ...(scenario === "closed-hour" ? records.close : [])].map(row => JSON.stringify(row)).join("\n") + "\n";
    fs.writeFileSync(entry.artifactPath!, text);
    fs.utimesSync(entry.artifactPath!, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
    fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify(file));
    const hours = scenario === "closed-hour" ? 1 : scenario === "recent" ? 6 - 1 / 60
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
    let captures = 0, signals = 0;
    const stop = spyOn(control, "terminateStructuredHostTree").mockImplementation((ref, dependencies) => original(ref, {
      ...dependencies, terminateOwnedHost: async () => false, graceMs: 50, deadlineMs: 2000,
      persistCapturedTree: async tree => {
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
    try {
      const row: HandoffRow = { operationId: "fixture-delivery", engine: "codex", engineSessionId: FIXTURE_SESSION,
        conversationId: Object.keys(file.conversations)[0]!, kind: "root", parentConversationId: null,
        hostGeneration: "fixture-predecessor", accountId: null, turnState: "busy", status: "pending",
        pendingDeliveries: [{ deliveryId: "fixture-message", clientMessageId: null, seq: 1 }],
        predecessorGeneration: null, successorGeneration: null, replayedDeliveryIds: [], interruptionOutcome: null,
        lastError: null, enqueuedAt: new Date(FIXTURE_NOW).toISOString(), updatedAt: new Date(FIXTURE_NOW).toISOString() };
      const report = await runStructuredHostRetirementSweep({ snapshot: () => registry.readOnlySnapshot(), requireAgentState: true,
        now: () => now, publicationState: () => "ready", handoffRows: () => determined(scenario === "delivery" ? [row] : []),
        durableEventTail: () => determined(0), realtimeBound: () => determined(false),
        orchestratorSeatConversations: () => determined(new Set<string>()), revokedSeatConversations: () => determined(new Set<string>()),
        readCursor: () => null, writeCursor: () => {}, graceMs: 50,
      });
      const eligible = ["closed-hour", "open-62h", "open-76h", "six-hours", "absent-owner"].includes(scenario);
      if (eligible) {
        expect(report.failed).toEqual([]); expect(report.refused).toEqual([]);
        expect(report.retired).toHaveLength(1); expect(captures).toBeGreaterThan(0); expect(signals).toBeGreaterThan(0);
        if (scenario !== "closed-hour") {
          expect(report.retired[0]!.reason).toBe("abandoned turn");
          const stored = JSON.parse(fs.readFileSync(statePath("host-retirement-report.json"), "utf8"));
          expect(stored.retired[0].reason).toBe("abandoned turn");
          const journal = fs.readFileSync(statePath("host-retirement-journal.ndjson"), "utf8").trim().split("\n");
          expect(JSON.parse(journal.at(-1)!).retired[0].reason).toBe("abandoned turn");
        }
        expect(procBackend.pidAlive(identity.pid) && !procBackend.processExited(identity.pid)).toBe(false);
        expect(procBackend.pidAlive(mcpPid) && !procBackend.processExited(mcpPid)).toBe(false);
      } else {
        expect(report.retired).toEqual([]); expect(signals).toBe(0);
        expect(procBackend.pidAlive(identity.pid)).toBe(true);
        expect(report.refused.length + report.failed.length).toBeGreaterThan(0);
      }
      expect(fs.readFileSync(entry.artifactPath!, "utf8")).toBe(scenario === "capture-transcript" ? text + '{"type":"fixture-write"}\n' : text);
    } finally { denied?.mockRestore(); stop.mockRestore(); }
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
  expect(structuredClaimIdentity(claim!.claimOwner!)).toEqual(self);
});

test("MCP retirement exemption recognizes the canonical shipped entry and rejects lookalike paths", () => {
  expect(trustedMcpEntry(path.join(process.cwd(), "bin", "mcp-server.mjs"))).toBe(true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lookalike-")); roots.push(root);
  const fake = path.join(root, "bin", "mcp-server.mjs");
  fs.mkdirSync(path.dirname(fake), { recursive: true }); fs.writeFileSync(fake, "setInterval(() => {}, 1000);");
  expect(trustedMcpEntry(fake)).toBe(false);
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
