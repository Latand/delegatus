import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRegistry, setAgentRegistryForTests, structuredClaimIdentity } from "@/lib/agent/registry";
import { clearAgentObservations } from "@/lib/agentState/projectionCache";
import { fixtureRecords, fixtureRegistry, FIXTURE_CONVERSATION, FIXTURE_NOW, FIXTURE_SESSION, FIXTURE_TURN as FIXTURE_TURN_ID } from "@/lib/agentState/testFixture";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { statePath } from "@/lib/configDir";
import { buildPipeline, savePipelines } from "@/lib/pipelines/store";
import { stopFixtureIdentity, stopFixtureProcess } from "@/lib/testing/fixtureProcess";
import { determined } from "./determinable";
import { durableRuntimeEventTailSeq, FileRuntimeEventStore } from "./eventStore";
import type { HandoffRow } from "./handoffQueue";
import * as control from "./structuredHostControl";
import { runStructuredHostRetirementSweep, trustedMcpCommand, trustedMcpEntry, type StructuredHostRetirementDependencies } from "./structuredHostRetirement";

const identities: ProcessIdentity[] = [], roots: string[] = [], registries: AgentRegistry[] = [];
const children = new Map<ChildProcess, ProcessIdentity>();
const identityKey = (identity: ProcessIdentity) => `${identity.pid}:${identity.startIdentity}`;
const originalMcpRoot = process.env.LLV_MCP_RUNTIME_ROOT;
const originalStateDirectory = process.env.LLV_STATE_DIR;
// Provenance probes have a one-second deadline and can retry. Give recovery
// more than one attempt before fixture teardown ends any remaining children.
const MCP_PROOF_WAIT_MS = 5_000;
afterEach(async () => {
  if (originalMcpRoot === undefined) delete process.env.LLV_MCP_RUNTIME_ROOT;
  else process.env.LLV_MCP_RUNTIME_ROOT = originalMcpRoot;
  if (originalStateDirectory === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDirectory;
  const direct = new Map([...children].map(([child, identity]) => [identityKey(identity), child]));
  const owned = new Map([...children.values(), ...identities.splice(0)].map(identity => [identityKey(identity), identity]));
  children.clear();
  if (process.platform === "linux") {
    const pending = [...owned.values()], visited = new Set<number>();
    while (pending.length && visited.size < 512) {
      const parent = pending.shift()!;
      const { pid } = parent;
      if (visited.has(pid) || processIdentityStatus(parent) !== "alive") continue;
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
          if (procBackend.readPpid(childPid) !== pid || processIdentityStatus(parent) !== "alive") continue;
          owned.set(identityKey(identity), identity);
          pending.push(identity);
        }
      }
    }
  }
  const errors: unknown[] = [];
  for (const [key, identity] of [...owned].reverse()) {
    try {
      const child = direct.get(key);
      if (child) await stopFixtureProcess(child);
      else await stopFixtureIdentity(identity);
    } catch (error) { errors.push(error); }
  }
  clearAgentObservations();
  setAgentRegistryForTests(null);
  for (const registry of registries.splice(0)) registry.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, "abandoned host fixture cleanup failed");
});

function start(args: string[], detached = false): ChildProcess {
  const child = spawn(process.execPath, args, { detached, stdio: ["ignore", "pipe", "pipe"] });
  children.set(child, captureProcessIdentity(child.pid!));
  return child;
}
async function ready(child: ChildProcess): Promise<number> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture readiness deadline")), 4000);
      child.stdout!.once("data", chunk => { clearTimeout(timer); const value = String(chunk).trim();
        const pid = (() => { try { return JSON.parse(value).pid; } catch { return Number(value); } })();
        children.set(child, captureProcessIdentity(child.pid!));
        resolve(pid); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture exited before ready: ${code}`)); });
  });
}
async function waitForTrustedMcpEntry(filename: string): Promise<void> {
  const deadline = Date.now() + MCP_PROOF_WAIT_MS;
  while (Date.now() < deadline) {
    if (trustedMcpEntry(filename)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("historical MCP source proof did not settle");
}

test("historical MCP trust recovers after native Git probes time out", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-probe-retry-")); roots.push(root);
  const entry = path.join(root, "bin", "mcp-server.mjs");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "bin", "mcp-server.mjs"), entry);
  const git = Bun.which("git");
  if (!git) throw new Error("native Git is required for the provenance fixture");
  const revision = Bun.spawnSync([git, "rev-parse", "HEAD"]);
  expect(revision.exitCode).toBe(0);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "delegatus-cli", gitHead: revision.stdout.toString().trim() }));
  const probes = path.join(root, "probes");
  const shim = path.join(root, "probe-bin");
  const originalPath = process.env.PATH;
  fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, "git"), `#!${process.execPath}
    import fs from "node:fs";
    const args = process.argv.slice(2);
    if (args[0] === "cat-file") {
      const counter = ${JSON.stringify(probes)};
      const attempt = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
      fs.writeFileSync(counter, String(attempt));
      // The real verifier ends each stalled probe at its own deadline. These
      // attempts spawn no descendants; the next attempt executes native Git.
      if (attempt <= 2) await new Promise(resolve => setTimeout(resolve, 10_000));
    }
    const child = Bun.spawn([${JSON.stringify(git)}, ...args], {
      env: { ...process.env, PATH: ${JSON.stringify(originalPath)} },
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    process.exit(await child.exited);
  `, { mode: 0o700 });
  process.env.PATH = `${shim}${path.delimiter}${originalPath ?? ""}`;
  try {
    await waitForTrustedMcpEntry(entry);
    expect(Number(fs.readFileSync(probes, "utf8"))).toBeGreaterThanOrEqual(3);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}, 20_000);

// The successor reconciles from disk in a fresh process, with no predecessor
// memory/cache. Its state and all processes in these tests belong to fixtures.
const reconcile = `
  import path from "node:path";
  import { AgentRegistry } from "./src/lib/agent/registry";
  import { AgentStateService } from "./src/lib/agentState/service";
  import { observeAgentProcess } from "./src/lib/agentState/process";
  import fs from "node:fs";
  const originalStat = fs.statSync.bind(fs);
  fs.statSync = (filename, ...args) => {
    if (filename === "/proc/" + process.argv[3]) throw Object.assign(new Error("fixture hidden owner"), { code: "ENOENT" });
    return originalStat(filename, ...args);
  };
  const root = process.argv[1];
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined,
    { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") });
  const service = new AgentStateService({ registry, now: () => Number(process.argv[2]),
    owns: () => true, process: observeAgentProcess, memory: () => null, release: "fixture", publish: async () => true });
  await service.request(); service.stop(); registry.close();
`;

for (const scenario of ["closed-hour", "open-62h", "open-76h", "passed-stage-open", "terminal-lane-open", "running-stage-open", "six-hours", "shipped-mcp", "stable-mcp", "bundled-mcp", "historical-mcp", "absent-owner", "legacy-owner", "legacy-dead-closed", "legacy-dead-open", "legacy-live-closed", "legacy-live-open", "foreign-owner-closed", "foreign-owner-open", "delivery", "held-delivery", "question", "tool", "mcp-tool", "preload-tool", "hidden-live-owner", "live-owner", "owner-proc-denied", "recent", "setup", "flags", "tree-denied", "capture-tool", "capture-delivery", "capture-owner", "capture-transcript", "oversized-stale-terminal", "oversized-stale-terminal-unheld", "oversized-stale-terminal-abandoned", "oversized-unanchored-terminal", "oversized-closed", "oversized-open", "oversized-unknown", "oversized-unknown-recent", "oversized-open-live-owner", "oversized-unknown-live-owner", "oversized-delivered", "oversized-pending-image", "oversized-uncertain-image", "oversized-pending-text", "oversized-invalid", "unflushed-dead-owner", "unflushed-open-dead-owner", "unflushed-live-owner", "unflushed-capture-owner", "unflushed-measurement-exit", "unflushed-already-gone"] as const) {
  test.skipIf(process.platform !== "linux")(`restart retirement: ${scenario}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "abandoned-fixture-")); roots.push(root);
    const pipelineOwnsHost = scenario === "passed-stage-open" || scenario === "terminal-lane-open" || scenario === "running-stage-open";
    fs.mkdirSync(path.join(root, "bin"));
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(path.join(root, "lifetime.mjs"), "setInterval(() => {}, 1000);");
    const childScript = path.join(root, scenario === "tool" ? "tool.mjs" : scenario === "bundled-mcp" ? "dist/mcp-server.mjs" : "bin/mcp-server.mjs");
    fs.writeFileSync(childScript, scenario === "mcp-tool"
      ? 'import {spawn} from "node:child_process"; const c=spawn("sleep",["60"],{stdio:"ignore"}); console.log(c.pid); setInterval(()=>{},1000);'
      : 'console.log(process.pid); setInterval(()=>{},1000);');
    let launchedScript = ["tool", "bundled-mcp"].includes(scenario)
      ? childScript : path.join(process.cwd(), "bin/mcp-server.mjs");
    let lifetimePreload = path.join(process.cwd(), "bin/mcp-lifetime.mjs");
    if (scenario === "stable-mcp") {
      const stableRoot = path.join(root, "stable-runtime");
      fs.mkdirSync(stableRoot);
      fs.cpSync(path.join(process.cwd(), "bin"), path.join(stableRoot, "bin"), { recursive: true });
      for (const name of ["src", "node_modules", "tsconfig.json"]) {
        fs.symlinkSync(path.join(process.cwd(), name), path.join(stableRoot, name));
      }
      process.env.LLV_MCP_RUNTIME_ROOT = stableRoot;
      launchedScript = path.join(stableRoot, "bin/mcp-server.mjs");
      lifetimePreload = path.join(stableRoot, "bin/mcp-lifetime.mjs");
    }
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
      lifetimePreload = path.join(packageRoot, "bin", "mcp-lifetime.mjs");
      await waitForTrustedMcpEntry(launchedScript);
      await waitForTrustedMcpEntry(path.join(packageRoot, "src", "lib", "mcp", "entry.ts"));
      const deadline = Date.now() + MCP_PROOF_WAIT_MS;
      while (!trustedMcpCommand([process.execPath, "--preload", lifetimePreload, launchedScript]) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(trustedMcpCommand([process.execPath, "--preload", lifetimePreload, launchedScript])).toBe(true);
    }
    const mcpToolPreload = path.join(root, "mcp-tool-preload.mjs");
    if (scenario === "mcp-tool") fs.writeFileSync(mcpToolPreload,
      'import { spawn } from "node:child_process"; globalThis.fixtureTool = spawn("sleep", ["60"], { stdio: "ignore" });');
    const hostScript = path.join(root, "host.mjs");
    const mcpReady = path.join(root, "mcp-ready");
    if (scenario === "preload-tool") fs.writeFileSync(mcpToolPreload,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(mcpReady)}, "non-MCP tool active"); await new Promise(() => { setInterval(() => {}, 1000); });`);
    const idleMcp = ["shipped-mcp", "stable-mcp", "historical-mcp"].includes(scenario);
    const childArgs = ["mcp-tool", "preload-tool"].includes(scenario) ? ["--preload", mcpToolPreload, launchedScript]
      : ["--preload", idleMcp ? lifetimePreload : path.join(root, "lifetime.mjs"), launchedScript];
    const realMcp = idleMcp || scenario === "mcp-tool";
    const spawnChild = realMcp || ["tool", "bundled-mcp", "preload-tool"].includes(scenario);
    fs.writeFileSync(hostScript, `import {spawn} from "node:child_process"; import fs from "node:fs";
      const childEnv={...process.env}; delete childEnv.LLV_SPAWN_CAPABILITY;
      const c=${spawnChild ? `spawn(process.execPath,${JSON.stringify(childArgs)},{detached:${!idleMcp},env:childEnv,stdio:${realMcp ? '["pipe","pipe","inherit"]' : '["ignore","pipe","inherit"]'}})` : "null"};
      ${realMcp ? `let pending=""; c.stdout.on("data", chunk => { pending += chunk; for (;;) { const end=pending.indexOf("\\n"); if(end<0) break; const line=pending.slice(0,end); pending=pending.slice(end+1); try { const msg=JSON.parse(line); if(msg.id===1 && msg.result) fs.writeFileSync(${JSON.stringify(mcpReady)},"ready"); } catch {} } });
      c.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"retirement-fixture",version:"1"}}})+"\\n");` : ""}
      process.on("SIGTERM", () => {
        if (!c || c.exitCode !== null || c.signalCode !== null) process.exit(0);
        // The retirement ladder signals the captured child tree. Stay
        // alive to reap the direct child when that ladder ends it.
        c.once("exit", () => process.exit(0));
      });
      console.log(JSON.stringify({pid:c?.pid ?? process.pid}));
      setInterval(()=>{},1000);`);
    // Match the provider's process group for the shipped launcher and worker.
    const host = start([hostScript], idleMcp);
    const mcpPid = await ready(host);
    const identity = children.get(host)!;
    if (mcpPid !== identity.pid) identities.push(captureProcessIdentity(mcpPid));
    if (scenario === "preload-tool") {
      const deadline = Date.now() + 4000;
      while (!fs.existsSync(mcpReady) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(fs.readFileSync(mcpReady, "utf8")).toBe("non-MCP tool active");
      expect(procBackend.pidAlive(mcpPid) && !procBackend.processExited(mcpPid)).toBe(true);
    }
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
    const owner = children.get(predecessor)!;
    if (scenario !== "hidden-live-owner") await stopFixtureProcess(predecessor);
    const file = fixtureRegistry(root, "codex", identity, ["absent-owner", "oversized-stale-terminal-unheld"].includes(scenario) ? null
      : scenario === "hidden-live-owner" ? owner
        : ["legacy-dead-closed", "legacy-dead-open"].includes(scenario) ? { pid: owner.pid, startIdentity: owner.startIdentity }
      : ["live-owner", "unflushed-live-owner", "owner-proc-denied", "oversized-open-live-owner", "oversized-unknown-live-owner"].includes(scenario) ? captureProcessIdentity(process.pid)
        : ["legacy-live-closed", "legacy-live-open"].includes(scenario)
          ? { pid: process.pid, startIdentity: captureProcessIdentity(process.pid).startIdentity }
          : ["legacy-owner", "foreign-owner-closed", "foreign-owner-open"].includes(scenario)
            ? { pid: 2_147_483_647, startIdentity: "owner-from-unrecorded-pid-namespace" }
          : owner);
    const entry = file.entries[`codex:${FIXTURE_SESSION}`]!;
    entry.structuredHostOperationId = null;
    if (pipelineOwnsHost) {
      process.env.LLV_STATE_DIR = path.join(root, "state");
      const lane = buildPipeline({ id: "abandoned-stage", task: "Fixture", project: "fixture", repoDir: "/fixture", srcPath: null, srcConversationId: null,
        now: new Date(FIXTURE_NOW - 1000).toISOString(), stages: [{ id: "review", kind: "run", prompt: "Review", next: null,
          effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null } }] });
      const passed = scenario !== "running-stage-open";
      lane.state = scenario === "terminal-lane-open" ? "completed" : "running";
      if (lane.state === "completed") lane.cursor = null;
      lane.runs[0]!.attempts = [{
        n: 1, state: passed ? "passed" : "running", effectiveRole: lane.stages[0]!.effectiveRole, launchId: null,
        conversationId: FIXTURE_CONVERSATION, sessionId: FIXTURE_SESSION, agentPath: entry.artifactPath, paneId: null,
        flowId: null, startedAt: lane.createdAt, completedAt: passed ? new Date(FIXTURE_NOW).toISOString() : null,
        input: null, activatedBy: null, output: null, error: null, verdict: passed ? { status: "pass", findings: [] } : null,
      }];
      savePipelines([lane]);
    }
    if (scenario === "oversized-stale-terminal-unheld") entry.structuredHost!.activeTurnRef = null;
    if (scenario === "question") entry.structuredHost!.pendingAttention = ["fixture-question"];
    if (scenario === "flags") entry.structuredHost!.activeFlags = ["fixture-active-work"];
    if (scenario === "setup") entry.pendingAction = "resume";
    const events = new FileRuntimeEventStore(path.join(root, "events"));
    if (scenario.startsWith("unflushed-")) {
      for (const seq of [1, 2]) events.append(FIXTURE_SESSION,
        { kind: "delta", turnId: "fixture-turn", text: "retained output", seq });
    }
    const eventsBefore = events.load(FIXTURE_SESSION);
    const records = fixtureRecords("codex");
    // A transcript larger than the 4 MiB acquisition budget: one record past
    // the budget separates earlier openings from the newest records. Closure
    // requires a fresh opening in the tail; unanchored terminals stay unknown.
    const oversized = scenario.startsWith("oversized-");
    const staleTerminal = scenario.startsWith("oversized-stale-terminal");
    const tail = scenario === "oversized-closed" ? [...records.open, ...records.close]
      : staleTerminal || scenario === "oversized-unanchored-terminal" ? records.close : scenario.startsWith("oversized-open")
      ? [{ type: "response_item", timestamp: new Date(FIXTURE_NOW).toISOString(), payload: { type: "custom_tool_call", call_id: "fixture-tail-call" } }] : [];
    const text = [...records.open, ...(staleTerminal ? [{ type: "event_msg", payload: { type: "task_started", turn_id: "fixture-newer-turn" } }] : []), ...(oversized ? [{ type: "metadata", padding: "x".repeat(5 * 1024 * 1024) }, ...tail] : []),
      ...(["closed-hour", "unflushed-dead-owner", "unflushed-live-owner", "unflushed-capture-owner", "unflushed-measurement-exit", "unflushed-already-gone",  "legacy-owner", "legacy-dead-closed", "legacy-live-closed", "foreign-owner-closed"].includes(scenario) ? records.close : [])].map(row => JSON.stringify(row)).join("\n") + (scenario === "oversized-invalid" ? '\n{"type":\n' : "\n");
    fs.writeFileSync(entry.artifactPath!, text);
    fs.utimesSync(entry.artifactPath!, new Date(FIXTURE_NOW), new Date(FIXTURE_NOW));
    fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify(file));
    let fixtureDeliveryId: string | null = null;
    if (["oversized-delivered", "oversized-pending-image", "oversized-uncertain-image", "oversized-pending-text"].includes(scenario)) {
      const writer = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined,
        { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") });
      try {
        const image = scenario.endsWith("image");
        const delivery = writer.holdDelivery(FIXTURE_CONVERSATION, image ? "" : "fixture pending work", "spawn_fixture",
          image ? "runtime-images" : "text", image ? [{ sha256: "c".repeat(64), mime: "image/png", bytes: 67 }] : []);
        fixtureDeliveryId = delivery.id;
        if (scenario === "oversized-delivered") writer.recordDeliveryOutcome(delivery.id, "delivered");
        if (scenario === "oversized-uncertain-image") writer.recordDeliveryOutcome(delivery.id, "delivery-uncertain", "fixture unknown outcome");
      } finally { writer.close(); }
    }
    const hours = ["closed-hour", "unflushed-dead-owner", "unflushed-live-owner", "unflushed-capture-owner", "unflushed-measurement-exit", "unflushed-already-gone",  "legacy-owner", "legacy-dead-closed", "legacy-live-closed", "foreign-owner-closed", "oversized-closed", "oversized-stale-terminal", "oversized-stale-terminal-unheld", "oversized-unanchored-terminal"].includes(scenario) ? 1
      : ["recent", "oversized-unknown-recent"].includes(scenario) ? 6 - 1 / 60
      : scenario === "six-hours" || pipelineOwnsHost ? 6 : scenario === "open-76h" ? 76 : 62;
    const now = FIXTURE_NOW + hours * 3_600_000;
    const successor = Bun.spawn([process.execPath, "--eval", reconcile, root, String(now), scenario === "hidden-live-owner" ? String(owner.pid) : ""], { stdout: "pipe", stderr: "pipe" });
    identities.push(captureProcessIdentity(successor.pid));
    const [exit, stderr] = await Promise.all([successor.exited, new Response(successor.stderr).text()]);
    expect(stderr).toBe(""); expect(exit).toBe(0);
    const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined,
      { sqliteMode: "sqlite", sqliteFilename: path.join(root, "registry.sqlite") });
    registries.push(registry); setAgentRegistryForTests(registry);
    if (scenario === "held-delivery") registry.holdDelivery(FIXTURE_CONVERSATION, "fixture work", "fixture-held-message");
    const original = control.terminateStructuredHostTree;
    let captures = 0, capturedTree: readonly ProcessIdentity[] = [];
    const signalTargets: number[] = [];
    const stop = spyOn(control, "terminateStructuredHostTree").mockImplementation((ref, dependencies) => original(ref, {
      ...dependencies, terminateOwnedHost: async () => false,
      // Allow the real launcher time to reap its worker during group shutdown.
      graceMs: idleMcp ? 2000 : 50, deadlineMs: idleMcp ? 4000 : 2000,
      persistCapturedTree: async tree => {
        capturedTree = tree;
        const accepted = await dependencies!.persistCapturedTree!(tree);
        if (accepted) captures++;
        if (scenario === "capture-tool") {
          const tool = start(["--eval", "console.log(process.pid); setInterval(()=>{},1000)"]);
          await ready(tool);
          // Enrol a fixture-owned tool as a newly retained member, exactly as
          // a child found during captured-tree expansion would be enrolled.
          expect(registry.recordStructuredTerminationSurvivors(entry.key, identity, [...tree, children.get(tool)!])).toBe(true);
        }
        if (["capture-owner", "unflushed-capture-owner"].includes(scenario)) registry.agentStateWrite(rows => {
          rows.entries[`codex:${FIXTURE_SESSION}`]!.claimOwner = `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`;
        });
        if (scenario === "capture-delivery") registry.holdDelivery(FIXTURE_CONVERSATION, "fixture work", "fixture-held-message");
        if (scenario === "capture-transcript") fs.appendFileSync(entry.artifactPath!, '{"type":"fixture-write"}\n');
        return accepted;
      },
      signal: (pid, signal) => { signalTargets.push(pid); process.kill(pid, signal); },
    }));
    const read = fs.readdirSync.bind(fs);
    const denied = scenario === "tree-denied" ? spyOn(fs, "readdirSync").mockImplementation(((pathname: fs.PathLike, ...args: unknown[]) => {
      if (pathname === `/proc/${identity.pid}/task`) throw new Error("fixture denied tree");
      return Reflect.apply(read, fs, [pathname, ...args]);
    }) as typeof fs.readdirSync) : null;
    const stat = fs.statSync.bind(fs);
    const persisted = Object.values(registry.readOnlySnapshot().agentStates ?? {})[0];
    if (pipelineOwnsHost) {
      expect(persisted?.facts.owner).toMatchObject({ determined: true, value: "absent" });
      expect(persisted?.facts.turn).toMatchObject({ determined: true, value: { state: "open", nativeId: FIXTURE_TURN_ID } });
    }
    if (scenario === "oversized-closed") expect(persisted?.facts.turn).toMatchObject({ determined: true, value: { state: "closed", nativeId: FIXTURE_TURN_ID } });
    if (["oversized-open", "oversized-open-live-owner"].includes(scenario)) expect(persisted?.facts.turn).toMatchObject({ determined: true, value: { state: "open", nativeId: null } });
    if (["oversized-unknown", "oversized-unknown-recent", "oversized-unknown-live-owner"].includes(scenario)) {
      expect(persisted?.facts.turn).toMatchObject({ determined: false, why: "native record exceeds acquisition budget" });
    }
    if (scenario === "oversized-invalid") expect(persisted?.facts.turn).toMatchObject({ determined: false, why: "native transcript unreadable or invalid" });
    const ownerProcDenied = ["owner-proc-denied", "hidden-live-owner"].includes(scenario) ? spyOn(fs, "statSync").mockImplementation(((pathname: fs.PathLike, ...args: unknown[]) => {
      if (pathname === `/proc/${scenario === "hidden-live-owner" ? owner.pid : process.pid}`) throw Object.assign(new Error("fixture owner proc denied"), { code: scenario === "hidden-live-owner" ? "ENOENT" : "EACCES" });
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
      const exitHost = () => stopFixtureProcess(host);
      if (scenario === "unflushed-already-gone") await exitHost();
      const sweepDependencies: StructuredHostRetirementDependencies = { snapshot: () => registry.readOnlySnapshot(), requireAgentState: true,
        now: () => now, publicationState: () => "ready", handoffRows: () => determined(scenario === "delivery" ? [row] : []),
        durableEventTail: sessionId => durableRuntimeEventTailSeq(sessionId, path.join(root, "events")), realtimeBound: () => determined(false),
        orchestratorSeatConversations: () => determined(new Set<string>()), revokedSeatConversations: () => determined(new Set<string>()),
        readCursor: () => null, writeCursor: () => {}, graceMs: 50,
        ...(["unflushed-measurement-exit", "unflushed-already-gone"].includes(scenario) ? {
          treePss: async () => {
            expect(scenario).toBe("unflushed-measurement-exit");
            await exitHost();
            return { bytes: null, measuredProcesses: 0 };
          },
        } : {}),
      };
      if (scenario === "passed-stage-open") {
        const kept = await runStructuredHostRetirementSweep({ ...sweepDependencies, idleMs: 7 * 3_600_000 });
        expect(kept.refused).toMatchObject([{ clause: "transcript-idle" }]);
        expect(kept.retired).toEqual([]);
        expect(captures).toBe(0);
        expect(signalTargets).toEqual([]);
      }
      const report = await runStructuredHostRetirementSweep(sweepDependencies);
      if (["hidden-live-owner", "preload-tool", "legacy-dead-closed", "legacy-dead-open"].includes(scenario)) {
        console.log(JSON.stringify({ probe: scenario, retired: report.retired.length, signals: signalTargets.length, captures }));
      }
      if (["unflushed-measurement-exit", "unflushed-already-gone"].includes(scenario)) {
        expect(report.failed).toEqual([]); expect(report.refused).toEqual([]);
        expect(report.retired).toEqual([]); expect(report.gone).toHaveLength(1);
        expect(captures).toBe(0); expect(signalTargets).toEqual([]);
        expect(registry.hostEntry(entry.key)).toMatchObject({ status: "dead", claimOwner: null, structuredHost: null });
        expect(events.load(FIXTURE_SESSION)).toEqual(eventsBefore);
        const unflushed = { cursor: 0, tail: 2, ownerPid: owner.pid,
          reason: `the owner process ${owner.pid} is dead, so events 1-2 can never be flushed` };
        expect(report.gone![0]!.unflushedEvents).toEqual(unflushed);
        const stored = JSON.parse(fs.readFileSync(statePath("host-retirement-report.json"), "utf8"));
        const journal = JSON.parse(fs.readFileSync(statePath("host-retirement-journal.ndjson"), "utf8").trim().split("\n").at(-1)!);
        expect(stored.gone[0].unflushedEvents).toEqual(unflushed);
        expect(journal.gone[0].unflushedEvents).toEqual(unflushed);
        return;
      }
      const eligible = ["closed-hour", "unflushed-dead-owner", "unflushed-open-dead-owner", "open-62h", "open-76h", "passed-stage-open", "terminal-lane-open", "running-stage-open", "six-hours", "shipped-mcp", "stable-mcp", "historical-mcp", "absent-owner",
        "oversized-closed", "oversized-open", "oversized-unknown", "oversized-delivered", "oversized-stale-terminal-abandoned"].includes(scenario);
      if (eligible) {
        expect(report.failed).toEqual([]); expect(report.refused).toEqual([]);
        expect(report.retired).toHaveLength(1); expect(captures).toBeGreaterThan(0); expect(signalTargets.length).toBeGreaterThan(0);
        if (idleMcp) {
          expect(signalTargets).toEqual([-identity.pid]);
          expect(procBackend.pidAlive(mcpPid) && !procBackend.processExited(mcpPid)).toBe(false);
          expect(capturedTree.some(member => member.pid === mcpPid)).toBe(true);
        }
        // The dead owner can never persist the cursor, so the lag is settled as
        // impossible and recorded with the events it left behind.
        expect(report.retired[0]!.unflushedEvents).toEqual(["unflushed-dead-owner", "unflushed-open-dead-owner"].includes(scenario)
          ? { cursor: 0, tail: 2, ownerPid: owner.pid, reason: `the owner process ${owner.pid} is dead, so events 1-2 can never be flushed` }
          : undefined);
        if (["unflushed-dead-owner", "unflushed-open-dead-owner"].includes(scenario)) {
          // Read the real writer's report and journal in a fresh process.
          const reader = Bun.spawn([process.execPath, "--eval", `
            import fs from "node:fs";
            const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            const journal = fs.readFileSync(process.argv[2], "utf8").trim().split("\\n");
            console.log(JSON.stringify([report.retired[0].unflushedEvents,
              JSON.parse(journal.at(-1)).retired[0].unflushedEvents]));
          `, statePath("host-retirement-report.json"), statePath("host-retirement-journal.ndjson")], { stdout: "pipe", stderr: "pipe" });
          const [readerExit, replayed] = await Promise.all([reader.exited, new Response(reader.stdout).text()]);
          expect(readerExit).toBe(0);
          expect(JSON.parse(replayed)).toEqual([report.retired[0]!.unflushedEvents, report.retired[0]!.unflushedEvents]);
        }
        if (!["closed-hour", "unflushed-dead-owner", "oversized-closed"].includes(scenario)) {
          expect(report.retired[0]!.reason).toBe("abandoned turn");
          const stored = JSON.parse(fs.readFileSync(statePath("host-retirement-report.json"), "utf8"));
          expect(stored.retired[0].reason).toBe("abandoned turn");
          const journal = fs.readFileSync(statePath("host-retirement-journal.ndjson"), "utf8").trim().split("\n");
          expect(JSON.parse(journal.at(-1)!).retired[0].reason).toBe("abandoned turn");
        } else expect(report.retired[0]!.reason).toBeUndefined();
        expect(procBackend.pidAlive(identity.pid) && !procBackend.processExited(identity.pid)).toBe(false);
        expect(procBackend.pidAlive(mcpPid) && !procBackend.processExited(mcpPid)).toBe(false);
      } else {
        expect(report.retired).toEqual([]); expect(signalTargets).toEqual([]);
        expect(procBackend.pidAlive(identity.pid)).toBe(true);
        if (scenario === "hidden-live-owner") expect(() => process.kill(owner.pid, 0)).not.toThrow();
        if (scenario === "preload-tool") expect(procBackend.pidAlive(mcpPid) && !procBackend.processExited(mcpPid)).toBe(true);
        if (scenario === "owner-proc-denied") expect(() => process.kill(process.pid, 0)).not.toThrow();
        expect(report.refused.length + report.failed.length).toBeGreaterThan(0);
        if (scenario === "unflushed-live-owner") {
          // Live custody protects this native turn before the flush clause.
          expect(report.refused).toMatchObject([{ clause: "turn-settled" }]);
          expect(captures).toBe(0);
        }
        if (scenario === "unflushed-capture-owner") {
          expect(captures).toBeGreaterThan(0);
          expect(report.failed).toMatchObject([{ error: "scope retirement target changed: claimOwner" }]);
        }
      }
      if (staleTerminal || scenario === "oversized-unanchored-terminal") {
        expect(persisted?.facts.turn).toMatchObject({ determined: false, why: "native record exceeds acquisition budget" });
      }
      if (fixtureDeliveryId) {
        const held = registry.readOnlySnapshot().heldDeliveries[fixtureDeliveryId]!;
        expect(held.state).toBe(scenario === "oversized-delivered" ? "delivered" : scenario === "oversized-uncertain-image" ? "delivery-uncertain" : "assigned");
        expect(held.text).toBe(scenario === "oversized-pending-text" ? "fixture pending work" : "");
        expect(registry.pendingDeliveries(FIXTURE_CONVERSATION).some(row => row.id === fixtureDeliveryId)).toBe(scenario !== "oversized-delivered");
        if (scenario.endsWith("image")) expect(held.runtimeImages).toHaveLength(1);
        if (scenario === "oversized-delivered") expect(Object.values(registry.readOnlySnapshot().deliveryOperationOwners)
          .find(row => row.deliveryId === fixtureDeliveryId)).toMatchObject({ terminalState: "delivered", terminalDisposition: "delivered" });
      }
      expect(fs.readFileSync(entry.artifactPath!, "utf8")).toBe(scenario === "capture-transcript" ? text + '{"type":"fixture-write"}\n' : text);
      expect(events.load(FIXTURE_SESSION)).toEqual(eventsBefore);
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

test("MCP command exemption verifies the lifetime preload and the complete argument list", () => {
  const entry = path.join(process.cwd(), "src/lib/mcp/entry.ts");
  const preload = path.join(process.cwd(), "bin/mcp-lifetime.mjs");
  const command = ["bun", "--preload", preload, entry];
  expect(trustedMcpCommand(command)).toBe(true);
  expect(trustedMcpCommand(["bun", entry])).toBe(true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-preload-lookalike-")); roots.push(root);
  const fake = path.join(root, "mcp-lifetime.mjs");
  fs.copyFileSync(preload, fake);
  for (const argv of [
    [process.execPath, "--preload", fake, entry],
    [process.execPath, "--preload", entry, entry],
    [process.execPath, "--preload", preload, "--preload", preload, entry],
    [process.execPath, "--preload"],
    [process.execPath, "--preload=" + preload, entry],
    [process.execPath, "--eval", entry],
    [...command, "--native-caller-hook"],
    [...command, "--unknown"],
    ["node", "--preload", preload, entry],
  ]) expect(trustedMcpCommand(argv)).toBe(false);
});

test("MCP retirement exemption verifies a previous package entry against its source commit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-previous-package-")); roots.push(root);
  const entry = path.join(root, "bin", "mcp-server.mjs");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.copyFileSync(path.join(process.cwd(), "bin", "mcp-server.mjs"), entry);
  const lifetime = path.join(root, "bin", "mcp-lifetime.mjs");
  fs.copyFileSync(path.join(process.cwd(), "bin", "mcp-lifetime.mjs"), lifetime);
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "delegatus-cli", gitHead: revision }));
  await waitForTrustedMcpEntry(entry);
  const command = ["bun", "--preload", lifetime, entry];
  const deadline = Date.now() + MCP_PROOF_WAIT_MS;
  while (!trustedMcpCommand(command) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(trustedMcpCommand(command)).toBe(true);
  fs.writeFileSync(lifetime, "setInterval(() => {}, 1000);\n");
  expect(trustedMcpCommand(command)).toBe(false);
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
