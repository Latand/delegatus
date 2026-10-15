import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CodexAppServerHost } from "./codexAppServerHost";
import { ClaudeStreamBrokerHost, FileClaudeDeliveryLedger } from "./claudeStreamBrokerHost";
import { prepareCodexIntegrationTestHome } from "./integrationTestHome";
import { FileRuntimeEventStore } from "./eventStore";
import { materializeStructuredHostAccess } from "./structuredSpawn";
import { AgentMemoryCell, GIB, viewerUnitFromCgroup, type AgentMemoryPlan } from "./agentMemory";
import type { EngineHost } from "./engineHost";
import { spawnSignalSandbox, signalAgentDomain } from "./agentSignalSandbox";
import { once } from "node:events";

const enabled = process.env.LLV_SIGNAL_SANDBOX_PERFORMANCE_TEST === "1";
const profiles: Array<"full" | "restricted" | "read-only"> = ["full", "restricted", "read-only"];
const samples = 30;
const transport = (command: string, args: string[], options: import("node:child_process").SpawnOptionsWithoutStdio) => spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
const quantile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
function report(value: unknown): void {
  console.log("signal performance: " + JSON.stringify(value));
  if (process.env.LLV_SIGNAL_PERFORMANCE_REPORT) fs.appendFileSync(process.env.LLV_SIGNAL_PERFORMANCE_REPORT, JSON.stringify(value) + "\n");
}
function memory(): AgentMemoryCell {
  const plan: AgentMemoryPlan = { mechanism: "scope", platform: "linux", limitBytes: 2 * GIB, budgetBytes: 4 * GIB, reserveBytes: GIB, totalBytes: 8 * GIB,
    score: 500, unit: `delegatus-agent-perf-${crypto.randomUUID()}.scope`, slice: "app.slice", systemdVersion: 255,
    viewerUnit: viewerUnitFromCgroup(fs.readFileSync("/proc/self/cgroup", "utf8")),
    cpu: { workload: "work", slice: "app.slice", weight: 100, quotaPercent: 200, periodMs: 20, systemdVersion: 255 } };
  return new AgentMemoryCell(plan);
}
function helperMemory(state: Awaited<ReturnType<EngineHost["health"]>>): number {
  const domain = state.signalDomain;
  if (!domain) return 0;
  return [domain.monitor, domain.bubblewrap, domain.init].reduce((total, identity) => {
    const status = fs.readFileSync(`/proc/${identity.pid}/status`, "utf8");
    return total + Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
  }, 0);
}
async function sample(open: (protectedRun: boolean, cell: AgentMemoryCell) => Promise<EngineHost>, ready: (host: EngineHost) => Promise<void>, engine: string, profile: string) {
  const elapsed: number[][] = [[], []], rss: number[] = [];
  for (let round = -2; round < samples; round++) {
    for (const mode of round % 2 === 0 ? [0, 1] : [1, 0]) {
      const cell = memory();
      let host: EngineHost | undefined;
      try {
        const started = performance.now();
        host = await open(mode === 1, cell);
        await ready(host);
        const duration = performance.now() - started;
        const state = await host.health();
        expect(Boolean(state.signalDomain)).toBe(mode === 1);
        if (round >= 0) {
          elapsed[mode]!.push(duration);
          if (mode === 1) rss.push(helperMemory(state));
        }
      } finally { await host?.release(); cell.close(); }
    }
  }
  const baseline = { medianMs: quantile(elapsed[0]!, .5), p95Ms: quantile(elapsed[0]!, .95) };
  const protectedRun = { medianMs: quantile(elapsed[1]!, .5), p95Ms: quantile(elapsed[1]!, .95) };
  report({ engine, profile, samplesPerMode: samples, cpuPercent: 200, memoryBytes: 2 * GIB, baseline, protected: protectedRun,
    addedMedianMs: protectedRun.medianMs - baseline.medianMs, idleHelperRssMedianKiB: quantile(rss, .5) });
}

test.skipIf(!enabled || !process.env.LLV_CODEX_BINARY).each(profiles)("30 paired native Codex launches: %s", async profile => {
  const binary = process.env.LLV_CODEX_BINARY!;
  const home = prepareCodexIntegrationTestHome(binary);
  if (!home) throw new Error("performance fixture needs an isolated Codex subscription credential");
  try {
    await sample(async (protectedRun, memoryCell) => {
      const access = materializeStructuredHostAccess(profile === "read-only" ? true : { readOnly: false, sandbox: profile === "restricted" ? "restricted" : "full" }, home.env, null, home.directory);
      return await CodexAppServerHost.start({ binary, cwd: home.directory, codexHome: home.codexHome, env: access.env, ...access.codex, ...access.host,
        mcpServers: [], fileAuthCredentials: true, approvalPolicy: "never", memoryCell,
        ...(protectedRun ? {} : { spawnProcess: transport }), eventStore: new FileRuntimeEventStore(path.join(home.directory, "events")) });
    }, async () => {}, "codex", profile);
  } finally { home.cleanup(); }
}, 300_000);

test.skipIf(!enabled)("paired gate build/test throughput and bounded parallel namespaces", async () => {
  const sustained = process.env.LLV_SIGNAL_TYPECHECK_PERFORMANCE === "1";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signal-throughput-"));
  const gate = path.resolve("scripts/gate-slot.sh");
  const slice = `llvsignalperf${crypto.randomUUID().replaceAll("-", "")}.slice`;
  const script = path.join(root, "workload.ts");
  const result = path.join(root, "result.json");
  const events = path.join(root, "parallel.jsonl");
  const commands = sustained ? [[Bun.which("node")!, "node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"]]
    : [[process.execPath, "scripts/build-gate.ts"], [process.execPath, "test", "src/lib/runtime/cpuAdmission.test.ts"]];
  fs.writeFileSync(script, `import fs from "node:fs";
const started = performance.now();
if (process.env.PARALLEL_EVENTS) {
  fs.appendFileSync(process.env.PARALLEL_EVENTS, JSON.stringify({ event: "start", at: Date.now() }) + "\\n");
  while (fs.readFileSync(process.env.PARALLEL_EVENTS, "utf8").trim().split("\\n").filter(line => JSON.parse(line).event === "start").length < 2) await Bun.sleep(10);
  const end = performance.now() + 1000; while (performance.now() < end) Math.sqrt(Math.random());
  fs.appendFileSync(process.env.PARALLEL_EVENTS, JSON.stringify({ event: "end", at: Date.now() }) + "\\n");
} else {
  for (const command of ${JSON.stringify(commands)}) {
    const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0) throw new Error("representative workload failed");
  }
  fs.writeFileSync(process.env.WORKLOAD_RESULT, JSON.stringify({ elapsedMs: performance.now() - started }));
}
`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: path.join(root, "state"),
    LLV_GATE_LOCK_DIR: path.join(root, "slots"), LLV_GATE_SLOTS: "1", LLV_GATE_MEM: sustained ? "8G" : "2G", LLV_GATE_SLICE: slice,
    LLV_OWNED_RUN_TIMEOUT_MS: sustained ? "1200000" : "90000", DELEGATUS_AGENT_CPU: "auto", DELEGATUS_CPU_PRESSURE: "off", DELEGATUS_WORK_SCOPE_CPU_QUOTA: "200", WORKLOAD_RESULT: result };
  delete env.LLV_GATE_SLOT_LEASE;
  const live = new Set<import("node:child_process").ChildProcess>();
  const run = async (protectedRun: boolean, parallel = false) => {
    const options = { env: { ...env, ...(parallel ? { PARALLEL_EVENTS: events, LLV_GATE_SLOTS: "2" } : {}) }, stdio: ["ignore", "pipe", "pipe"] as import("node:child_process").StdioOptions };
    const args = [gate, process.execPath, script];
    const child = protectedRun ? await spawnSignalSandbox("bash", args, options) : spawn("bash", args, options);
    live.add(child);
    let errors = "", output = "";
    child.stderr!.on("data", chunk => { errors = (errors + chunk).slice(-4000); });
    child.stdout!.on("data", chunk => { output = (output + chunk).slice(-4000); });
    await once(child, "close"); live.delete(child);
    expect(child.exitCode, errors + output).toBe(0);
    return parallel ? 0 : Number(JSON.parse(fs.readFileSync(result, "utf8")).elapsedMs);
  };
  try {
    const times: number[][] = [[], []];
    const count = sustained ? 1 : 3;
    for (let round = sustained ? 0 : -1; round < count; round++) for (const mode of round % 2 === 0 ? [0, 1] : [1, 0]) {
      const elapsed = await run(mode === 1);
      if (round >= 0) times[mode]!.push(elapsed);
    }
    const baseline = quantile(times[0]!, .5), protectedRun = quantile(times[1]!, .5);
    report({ workload: sustained ? "full TypeScript check" : "gate bundle plus CPU admission tests", samplesPerMode: count, baselineMedianMs: baseline, protectedMedianMs: protectedRun, slowdownPercent: (protectedRun / baseline - 1) * 100 });
    if (sustained) return;
    const started = performance.now();
    await Promise.all([run(true, true), run(true, true), run(true, true), run(true, true)]);
    const observations = fs.readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line) as { event: string; at: number }).sort((a, b) => a.at - b.at || (a.event === "end" ? -1 : 1));
    let active = 0, maximum = 0;
    for (const row of observations) { active += row.event === "start" ? 1 : -1; maximum = Math.max(maximum, active); }
    expect(observations).toHaveLength(8); expect(active).toBe(0); expect(maximum).toBe(2);
    report({ workload: "four parallel protected gates", slots: 2, completed: 4, maximumActive: maximum, wallMs: performance.now() - started });
  } finally {
    for (const child of live) {
      if (signalAgentDomain(child, "SIGKILL") === undefined) child.kill("SIGKILL");
      await once(child, "close");
    }
    const stop = spawn("systemctl", ["--user", "stop", slice], { stdio: "ignore" }); await once(stop, "close");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, process.env.LLV_SIGNAL_TYPECHECK_PERFORMANCE === "1" ? 1_500_000 : 300_000);

test.skipIf(!enabled || !process.env.LLV_CLAUDE_BINARY).each(profiles)("30 paired native Claude launches: %s", async profile => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-signal-performance-"));
  const config = path.join(root, ".claude"); fs.mkdirSync(config);
  fs.writeFileSync(path.join(root, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
  const api = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("count_tokens")) return Response.json({ input_tokens: 10 });
    await request.json();
    const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    const message = { id: "msg_performance", type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
    return new Response([
      event("message_start", { type: "message_start", message }),
      event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ready" } }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
      event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
      event("message_stop", { type: "message_stop" }),
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  const token = "local-performance-fixture";
  const provider = { baseUrl: `http://127.0.0.1:${api.port}`, model: "fixture-model", smallFastModel: null };
  fs.writeFileSync(path.join(config, ".provider-token"), token, { mode: 0o600 });
  fs.writeFileSync(path.join(config, ".provider-runtime"), JSON.stringify({ config: provider, token, headers: {} }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: root, TMPDIR: root, XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: path.join(root, "state"),
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    ANTHROPIC_BASE_URL: provider.baseUrl, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: provider.model };
  try {
    await sample(async (protectedRun, memoryCell) => ClaudeStreamBrokerHost.start({ binary: process.env.LLV_CLAUDE_BINARY!, cwd: root, env, claudeConfigDir: config,
      claudeProjectsDir: path.join(config, "projects"), providerAccount: true, model: provider.model, memoryCell,
      readOnly: profile === "read-only", restricted: profile === "restricted", permissionMode: profile === "full" ? "bypassPermissions" : "auto",
      mcpServers: [], tools: [], ...(protectedRun ? {} : { spawnProcess: transport }),
      eventStore: new FileRuntimeEventStore(path.join(root, "events")), deliveryLedger: new FileClaudeDeliveryLedger(path.join(root, "deliveries")), requestTimeoutMs: 30_000 }), async host => {
      const reader = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
      const finished = (async () => { for (;;) { const event = await reader.next(); if (event.done) throw new Error("native performance host ended early"); if (event.value.kind === "turn-ended") return; } })();
      await host.send({ id: crypto.randomUUID(), text: "Reply Ready." });
      await Promise.race([finished, Bun.sleep(10_000).then(() => { throw new Error("native performance readiness expired"); })]);
      await reader.return?.();
    }, "claude", profile);
  } finally { api.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
}, 300_000);
