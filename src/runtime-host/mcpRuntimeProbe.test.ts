import { expect, spyOn, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { VIEWER_CONTROL_TOKEN_ENV } from "@/lib/mcp/controlEndpoint";
import { MCP_HEALTH_PROBE_CAPABILITY_ENV } from "@/lib/mcp/healthProbeAdmission";
import { MCP_TOOL_NAMES } from "@/lib/mcp/server";

import { RuntimeHost } from "./host";
import { RuntimeJournal } from "./journal";
import { McpHealthProbeAdmissions } from "./mcpHealthProbeAdmission";
import { McpProbeStdioTransport } from "./mcpProbeStdioTransport";
import { mcpProbeCallFailures, mcpProbeFailureDetail, probeControlUrl, probeMcpRuntime, VIEWER_CONTROL_URL_ENV } from "./mcpRuntimeProbe";
import { serveRuntimeHost } from "./socket";

async function candidateCatalogProbe(declared: unknown, registered: string[]) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-candidate-catalog-"));
  const worker = path.join(sandbox, "candidate.mjs");
  fs.writeFileSync(worker, `
    import { Server } from ${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/index.js"))};
    import { StdioServerTransport } from ${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
    import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/types.js"))};
    const server = new Server({name:"candidate-catalog",version:"1"},{capabilities:{tools:{},experimental:{"delegatus/tool-catalog":${JSON.stringify(declared)}}}});
    server.setRequestHandler(ListToolsRequestSchema,()=>({tools:${JSON.stringify(registered)}.map(name=>({name,inputSchema:{type:"object"}}))}));
    server.setRequestHandler(CallToolRequestSchema,(request)=>{
      if (!${JSON.stringify(registered)}.includes(request.params.name)) throw new Error("Tool is not registered");
      return {content:[],structuredContent:{ok:true}};
    });
    await server.connect(new StdioServerTransport());
  `);
  try {
    return await probeMcpRuntime({
      command: process.execPath, args: [worker], cwd: process.cwd(),
      env: { [VIEWER_CONTROL_URL_ENV]: "http://127.0.0.1:1" },
      runtime: { source: "managed", revision: "7".repeat(40), releaseId: "candidate-catalog", artifactDigest: "a".repeat(64), stagedAt: "2026-10-16T08:00:00.000Z" },
      timeoutMs: 2_000,
    });
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}

test("candidate catalog: intentionally removed tools pass independently of the prober catalog", async () => {
  const tools = ["deployment_status", "board_snapshot", "candidate_only_read"];
  expect(await candidateCatalogProbe({ version: 1, tools }, tools)).toMatchObject({ ok: true, tools: [...tools].sort() });
});

test("candidate catalog: a pre-declaration release uses its own list for rollback and bootstrap", async () => {
  const tools = ["deployment_status", "board_snapshot"];
  expect(await candidateCatalogProbe(undefined, tools)).toMatchObject({ ok: true });
});

test("candidate catalog: an unregistered declaration fails even when the prober never shipped that tool", async () => {
  const evidence = await candidateCatalogProbe({ version: 1, tools: [...MCP_TOOL_NAMES, "candidate_only_read"] }, [...MCP_TOOL_NAMES]);
  expect(evidence.ok).toBe(false);
  expect(evidence.detail).toContain("MCP candidate did not register declared tools: candidate_only_read");
});

test("candidate catalog: the stable deploy contract cannot be removed by the candidate", async () => {
  const tools = MCP_TOOL_NAMES.filter(name => name !== "board_snapshot");
  const evidence = await candidateCatalogProbe({ version: 1, tools }, tools);
  expect(evidence.ok).toBe(false);
  expect(evidence.detail).toContain("MCP candidate is missing deployment contract tools: board_snapshot");
});

test.each([{}, { version: 2, tools: [] }, { version: 1, tools: "deployment_status" }, { version: 1, tools: [] }, { version: 1, tools: [" "] }, { version: 1, tools: ["board_snapshot", "board_snapshot"] }])(
  "candidate catalog: a malformed declaration fails closed (%j)", async (declared) => {
    const evidence = await candidateCatalogProbe(declared, [...MCP_TOOL_NAMES]);
    expect(evidence.ok).toBe(false);
    expect(evidence.detail).toContain("MCP candidate tool catalog is invalid");
  },
);

/* Every probe reads its own port-0 control stub. A missing control endpoint
   is rejected before spawning the runtime. */
function candidateControl() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/api/runtime/deployments"
        ? Response.json({ count: 0, deployments: [] })
        : Response.json({ error: "not found" }, { status: 404 });
    },
  });
}

async function coldCatalogProbe(mode: "warming" | "never-ready" | "permanent") {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-catalog-ready-"));
  const worker = path.join(sandbox, "probe.mjs");
  const attempts = path.join(sandbox, "attempts.jsonl");
  const serverModule = require.resolve("@modelcontextprotocol/sdk/server/index.js");
  const transportModule = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  const typesModule = require.resolve("@modelcontextprotocol/sdk/types.js");
  fs.writeFileSync(worker, `
    import fs from "node:fs";
    import { Server } from ${JSON.stringify(serverModule)};
    import { StdioServerTransport } from ${JSON.stringify(transportModule)};
    import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(typesModule)};
    const server = new Server({name:"catalog-warmup-fixture",version:"1"},{capabilities:{tools:{}}});
    server.setRequestHandler(ListToolsRequestSchema,()=>({tools:${JSON.stringify(MCP_TOOL_NAMES)}.map(name=>({name,inputSchema:{type:"object"}}))}));
    let reads=0;
    server.setRequestHandler(CallToolRequestSchema,request=>{
      fs.appendFileSync(${JSON.stringify(attempts)}, JSON.stringify(request.params)+"\\n");
      const board=request.params.name==="board_snapshot";
      if(board) reads++;
      const waiting=board && (${JSON.stringify(mode)}!=="warming" || reads<3);
      const code=${JSON.stringify(mode)}==="permanent" ? "tool_failed" : "scan_incomplete";
      const result=waiting ? {ok:false,code,retryable:true,error:"catalog fixture is warming",details:{retryAfterSeconds:0.001}}
        : {ok:true,payload:{conversations:[]}};
      return {isError:waiting,structuredContent:result,content:[{type:"text",text:JSON.stringify(result)}]};
    });
    await server.connect(new StdioServerTransport());
  `);
  let pid: number | null = null;
  try {
    const evidence = await probeMcpRuntime({
      command: process.execPath, args: [worker], cwd: process.cwd(),
      env: { [VIEWER_CONTROL_URL_ENV]: "http://127.0.0.1:19106" },
      runtime: { source: "managed", revision: "7".repeat(40), releaseId: "catalog-ready", artifactDigest: "a".repeat(64), stagedAt: "2026-10-13T12:00:00.000Z" },
      timeoutMs: 2_000,
      readinessTimeoutMs: mode === "never-ready" ? 150 : 2_000,
      onProcessReady: (value) => { pid = value; },
    });
    const calls = fs.readFileSync(attempts, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { name: string; arguments: { clientRequestId: string } });
    expect(pid).not.toBeNull();
    expect(() => process.kill(pid!, 0)).toThrow();
    return { evidence, calls };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

test("a cold MCP catalog becomes healthy in the same probe process with fresh read ids", async () => {
  const { evidence, calls } = await coldCatalogProbe("warming");
  expect(evidence).toMatchObject({ ok: true, calls: { deploymentStatus: true, boardSnapshot: true } });
  const boards = calls.filter((call) => call.name === "board_snapshot");
  expect(boards).toHaveLength(3);
  expect(new Set(boards.map((call) => call.arguments.clientRequestId)).size).toBe(3);
  expect(evidence.callFailures).toBeUndefined();
});

test("a catalog that never finishes still fails the bounded MCP health gate", async () => {
  const { evidence, calls } = await coldCatalogProbe("never-ready");
  expect(evidence).toMatchObject({ ok: false, processReady: true, calls: { boardSnapshot: false }, callFailures: [{ tool: "board_snapshot", code: "scan_incomplete" }] });
  expect(calls.filter((call) => call.name === "board_snapshot").length).toBeGreaterThan(1);
});

test("ordinary MCP failures are refused without a catalog warmup retry", async () => {
  const { evidence, calls } = await coldCatalogProbe("permanent");
  expect(evidence).toMatchObject({ ok: false, callFailures: [{ tool: "board_snapshot", code: "tool_failed" }] });
  expect(calls.filter((call) => call.name === "board_snapshot")).toHaveLength(1);
});

async function healthPolicyCalls(
  environment: Record<string, string>,
  capability?: string,
  admissions?: McpHealthProbeAdmissions,
) {
  const env = { ...environment };
  delete env[MCP_HEALTH_PROBE_CAPABILITY_ENV];
  if (capability) env[MCP_HEALTH_PROBE_CAPABILITY_ENV] = capability;
  const transport = new McpProbeStdioTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "bin", "mcp-server.mjs")],
    cwd: process.cwd(),
    env,
    ...(admissions ? { healthAdmissions: admissions } : {}),
  });
  const client = new Client({ name: "health-policy-fixture", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: 2_000 });
    for (const name of ["deployment_status", "board_snapshot"]) {
      let result;
      for (let attempt = 0; attempt < 20; attempt++) {
        result = await client.callTool({ name, arguments: { limit: 1, clientRequestId: `policy-read-${name}-${attempt}` } }, undefined, { timeout: 2_000 });
        if ((result.structuredContent as { code?: unknown } | undefined)?.code !== "scan_incomplete") break;
        // This fixture grades tool admission after the empty catalog warms.
        // Other refusals still reach the policy assertion immediately.
        await Bun.sleep(20);
      }
      expect(result).toBeDefined();
      expect(result!.isError).not.toBe(true);
      expect(result!.structuredContent).toMatchObject({ ok: true });
    }
    return await client.callTool({ name: "list_tasks", arguments: { limit: 1 } }, undefined, { timeout: 2_000 });
  } finally {
    await client.close();
    await transport.close();
  }
}

test("host-admitted managed MCP probes discover the complete surface, call required reads, and exit", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-probe-"));
  const socketPath = path.join(sandbox, "runtime.sock");
  const journal = new RuntimeJournal(path.join(sandbox, "runtime.sqlite"));
  const admissions = new McpHealthProbeAdmissions();
  const server = serveRuntimeHost(socketPath, new RuntimeHost(
    journal,
    undefined,
    undefined,
    undefined,
    undefined,
    admissions,
  ));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  environment.LLV_STATE_DIR = sandbox;
  environment.LLV_RUNTIME_EVENTS = "1";
  environment.LLV_RUNTIME_HOST_SOCKET = socketPath;
  environment.LLV_AGENT_REGISTRY_SQLITE = "off";
  environment.LLV_CODEX_HOME = path.join(sandbox, "codex");
  environment.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
  const control = candidateControl();
  environment[VIEWER_CONTROL_URL_ENV] = control.url.origin;

  try {
    for (const host of ["claude", "codex"]) {
      let processId: number | null = null;
      const evidence = await probeMcpRuntime({
        command: host === "claude" ? process.execPath : "node",
        args: [path.join(process.cwd(), "bin", "mcp-server.mjs")],
        cwd: process.cwd(),
        env: { ...environment, LLV_TEST_HOST: host },
        runtime: {
          source: "managed",
          revision: "7".repeat(40),
          releaseId: "deploy-probe",
          artifactDigest: "a".repeat(64),
          stagedAt: "2026-07-23T08:00:00.000Z",
        },
        healthProbeCapability: admissions.issue(),
        healthProbeAdmissions: admissions,
        onProcessReady: (pid) => { processId = pid; },
      });

      expect(evidence).toMatchObject({
        ok: true,
        revision: "7".repeat(40),
        artifactDigest: "a".repeat(64),
        processReady: true,
        calls: { deploymentStatus: true, boardSnapshot: true },
      });
      expect(evidence.tools).toEqual([...MCP_TOOL_NAMES, "suggest_replies"].sort());
      expect(evidence.tools).toContain("deployment_status");
      expect(evidence.tools).toContain("board_snapshot");
      expect(evidence.callFailures).toBeUndefined();
      expect(processId).not.toBeNull();
      expect(() => process.kill(processId!, 0)).toThrow();
    }
  } finally {
    control.stop(true);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    journal.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 20_000);

test("a missing published runtime is refused within the configured probe timeout", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-probe-missing-"));
  const socketPath = path.join(sandbox, "runtime.sock");
  const journal = new RuntimeJournal(path.join(sandbox, "runtime.sqlite"));
  const admissions = new McpHealthProbeAdmissions();
  const server = serveRuntimeHost(socketPath, new RuntimeHost(
    journal,
    undefined,
    undefined,
    undefined,
    undefined,
    admissions,
  ));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const revision = "7".repeat(40);
  const runtime = {
    source: "managed" as const,
    revision,
    releaseId: "deploy-retired",
    artifactDigest: "a".repeat(64),
    stagedAt: "2026-07-23T08:00:00.000Z",
  };
  /* The named release root is absent, exactly as after a retire or a state
     directory that never carried it. */
  fs.writeFileSync(path.join(sandbox, "viewer-release.json"), JSON.stringify({
    image: `viewer:${revision}`,
    container: "viewer-active",
    endpoint: "http://127.0.0.1:8898",
    revision,
    mcpRuntime: runtime,
  }));
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  environment.LLV_STATE_DIR = sandbox;
  environment.LLV_RUNTIME_EVENTS = "1";
  environment.LLV_RUNTIME_HOST_SOCKET = socketPath;
  environment.LLV_AGENT_REGISTRY_SQLITE = "off";
  environment.LLV_CODEX_HOME = path.join(sandbox, "codex");
  environment.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
  const control = candidateControl();
  environment[VIEWER_CONTROL_URL_ENV] = control.url.origin;

  let processId: number | null = null;
  const startTransport = McpProbeStdioTransport.prototype.start;
  const started = spyOn(McpProbeStdioTransport.prototype, "start").mockImplementation(async function (this: McpProbeStdioTransport) {
    await startTransport.call(this);
    processId = this.pid;
  });
  try {
    const startedAt = performance.now();
    const evidence = await probeMcpRuntime({
      command: "node",
      args: [path.join(process.cwd(), "bin", "mcp-server.mjs")],
      cwd: process.cwd(),
      env: environment,
      runtime,
      healthProbeCapability: admissions.issue(),
      healthProbeAdmissions: admissions,
      timeoutMs: 500,
    });
    expect(evidence).toMatchObject({ ok: false, processReady: false,
      calls: { deploymentStatus: false, boardSnapshot: false }, tools: [] });
    expect(evidence.detail).toContain("timed out");
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(processId).not.toBeNull();
    expect(() => process.kill(processId!, 0)).toThrow();
  } finally {
    started.mockRestore();
    control.stop(true);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    journal.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 20_000);

for (const scenario of ["termination", "inherited pipes", "cleanup deadline"] as const) {
  test(scenario === "termination"
    ? "a timed-out probe awaits SIGKILL termination through every shared close"
    : `a timed-out probe handles ${scenario} through every shared close`, async () => {
    let processId: number | null = null;
    let descendantId: number | null = null;
    let closeStartedTransport: (() => Promise<void>) | undefined;
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    const childIsRunning = () => {
      if (processId === null) throw new Error("probe did not spawn its child");
      try { process.kill(processId, 0); return true; } catch { return false; }
    };
    const startTransport = McpProbeStdioTransport.prototype.start;
    const closeTransport = McpProbeStdioTransport.prototype.close;
    const closeObservations: boolean[] = [];
    const started = spyOn(McpProbeStdioTransport.prototype, "start").mockImplementation(async function (this: McpProbeStdioTransport) {
      closeStartedTransport = () => closeTransport.call(this);
      // The child announces readiness after installing its TERM handler, so
      // even a slow launcher must exercise escalation rather than an early exit.
      const ready = new Promise<void>((resolve) => this.stderr.once("data", (chunk: Buffer) => {
        if (scenario === "inherited pipes") descendantId = Number(chunk.toString().trim());
        resolve();
      }));
      await startTransport.call(this);
      processId = this.pid;
      await ready;
    });
    const closed = spyOn(McpProbeStdioTransport.prototype, "close").mockImplementation(function (this: McpProbeStdioTransport) {
      return closeTransport.call(this).then(() => { closeObservations.push(childIsRunning()); });
    });
    const killChild = ChildProcess.prototype.kill;
    const killed = spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess, signal) {
      // Windows terminates on SIGTERM even with a handler installed. Refuse
      // both termination attempts to exercise the deadline on every platform.
      if (scenario === "cleanup deadline" && this.pid === processId
        && (signal === "SIGTERM" || signal === "SIGKILL")) return false;
      return killChild.call(this, signal);
    });
    try {
      const startedAt = performance.now();
      const evidence = await probeMcpRuntime({
        command: "node",
        args: ["-e", "process.on('SIGTERM',()=>{});process.stdin.on('data',()=>{});setInterval(()=>{},1000);"
          + (scenario === "inherited pipes"
            ? "const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},12000)'],{stdio:['ignore',1,2]});child.once('spawn',()=>process.stderr.write(child.pid+'\\n'));"
            : "process.stderr.write('ready\\n');")],
        cwd: process.cwd(),
        env: { [VIEWER_CONTROL_URL_ENV]: "http://127.0.0.1:1" },
        runtime: {
          source: "managed",
          revision: "7".repeat(40),
          releaseId: "deploy-unresponsive",
          artifactDigest: "a".repeat(64),
          stagedAt: "2026-07-23T08:00:00.000Z",
        },
        timeoutMs: 500,
      });
      expect(evidence.ok).toBe(false);
      expect(evidence.detail).toContain("timed out");
      expect(childIsRunning()).toBe(scenario === "cleanup deadline");
      expect(closeObservations.length).toBeGreaterThanOrEqual(2);
      expect(closeObservations.every((running) => running === (scenario === "cleanup deadline"))).toBe(true);
      if (scenario === "inherited pipes") {
        expect(descendantId).not.toBeNull();
        expect(() => process.kill(descendantId!, 0)).not.toThrow();
      }
      if (scenario === "cleanup deadline") {
        expect(evidence.detail).toContain("MCP probe child did not exit after SIGKILL");
      }
      expect(performance.now() - startedAt).toBeLessThan(8_000);
      await Bun.sleep(0);
      expect(unhandled).toEqual([]);
    } finally {
      started.mockRestore();
      closed.mockRestore();
      killed.mockRestore();
      await closeStartedTransport?.().catch(() => {});
      if (descendantId !== null) {
        try { process.kill(descendantId, "SIGKILL"); } catch { /* already exited */ }
      }
      if (processId !== null && childIsRunning()) {
        process.kill(processId, "SIGKILL");
        const until = performance.now() + 2_000;
        while (childIsRunning() && performance.now() < until) await Bun.sleep(10);
      }
      process.off("unhandledRejection", onUnhandled);
    }
  }, 20_000);
}

test("only an admitted health probe is limited to the two health reads", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-probe-adversarial-"));
  const socketPath = path.join(sandbox, "runtime.sock");
  const journal = new RuntimeJournal(path.join(sandbox, "runtime.sqlite"));
  let now = 100;
  const admissions = new McpHealthProbeAdmissions(() => now, 10);
  const server = serveRuntimeHost(socketPath, new RuntimeHost(
    journal,
    undefined,
    undefined,
    undefined,
    undefined,
    admissions,
  ));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  environment.LLV_STATE_DIR = sandbox;
  environment.LLV_RUNTIME_EVENTS = "1";
  environment.LLV_RUNTIME_HOST_SOCKET = socketPath;
  environment.LLV_AGENT_REGISTRY_SQLITE = "off";
  environment.LLV_CODEX_HOME = path.join(sandbox, "codex");
  environment.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
  const control = candidateControl();
  environment[VIEWER_CONTROL_URL_ENV] = control.url.origin;
  const run = async (healthProbeCapability?: string) => {
    return healthPolicyCalls(environment, healthProbeCapability, admissions);
  };

  try {
    expect((await run()).structuredContent).toMatchObject({ ok: true });
    expect((await run("A".repeat(43))).structuredContent).toMatchObject({ ok: true });

    const expired = admissions.issue();
    now = 110;
    expect((await run(expired)).structuredContent).toMatchObject({ ok: true });

    const legitimate = admissions.issue();
    const bounded = await run(legitimate);
    expect(bounded.isError).toBe(true);
    expect(bounded.structuredContent).toMatchObject({ ok: false, code: "tool_not_permitted" });
    expect((await run(legitimate)).structuredContent).toMatchObject({ ok: true });
  } finally {
    control.stop(true);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    journal.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 20_000);

test("a caller-selected runtime socket cannot impose the health-probe identity", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-probe-forged-socket-"));
  const socketPath = path.join(sandbox, "forged-runtime.sock");
  let admissionRequests = 0;
  const server = serveRuntimeHost(socketPath, {
    async handle(request) {
      if (request.method === "mcp-health-probe-admission") {
        admissionRequests += 1;
        return { id: request.id, ok: true, result: true };
      }
      if (request.method === "snapshot") {
        return { id: request.id, ok: true, result: { deployments: [] } };
      }
      return { id: request.id, ok: false, error: "unsupported" };
    },
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  environment.LLV_STATE_DIR = sandbox;
  environment.LLV_RUNTIME_EVENTS = "1";
  environment.LLV_RUNTIME_HOST_SOCKET = socketPath;
  environment.LLV_AGENT_REGISTRY_SQLITE = "off";
  environment.LLV_CODEX_HOME = path.join(sandbox, "codex");
  environment.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
  const control = candidateControl();
  environment[VIEWER_CONTROL_URL_ENV] = control.url.origin;

  try {
    const tasks = await healthPolicyCalls(environment, "A".repeat(43));
    expect(tasks.structuredContent).toMatchObject({ ok: true });
    expect(admissionRequests).toBe(0);
  } finally {
    control.stop(true);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 20_000);

/* `deploymentStatus: false` and nothing else is what #790 had to work from. */
test("a refused candidate MCP read names the read, its refusal and the control surface it used", () => {
  expect(mcpProbeFailureDetail({
    controlUrl: "http://127.0.0.1:19106",
    calls: [
      {
        name: "deployment_status",
        ok: false,
        result: {
          isError: true,
          structuredContent: { ok: false, error: "Viewer control request failed with status 405", status: 405 },
        },
      },
      { name: "board_snapshot", ok: true, result: { structuredContent: { ok: true } } },
    ],
  })).toBe(
    "MCP runtime read probes failed against http://127.0.0.1:19106 - "
    + "deployment_status: Viewer control request failed with status 405",
  );
});

test("a read refused without a structured error still reports its text and status", () => {
  expect(mcpProbeFailureDetail({
    controlUrl: undefined,
    calls: [{
      name: "board_snapshot",
      ok: false,
      result: { isError: true, structuredContent: { ok: false, status: 503 }, content: [{ type: "text", text: "runtime host is unavailable" }] },
    }],
  })).toBe("MCP runtime read probes failed - board_snapshot: runtime host is unavailable (status 503)");
});

/* #790 is a gate that graded the Viewer already serving: a candidate differing
   from it can then neither pass nor fail on its own behalf. */
test("a probe handed no control endpoint refuses by name instead of addressing the serving Viewer", async () => {
  const runtime = {
    source: "managed" as const,
    revision: "7".repeat(40),
    releaseId: "deploy-untargeted",
    artifactDigest: "a".repeat(64),
    stagedAt: "2026-07-23T08:00:00.000Z",
  };
  let spawned = false;

  for (const control of [undefined, "", "   ", "127.0.0.1:8898"]) {
    const evidence = await probeMcpRuntime({
      /* A command that cannot exist: if the probe reached the spawn, the
         evidence would name that failure and this test would say so. */
      command: path.join(os.tmpdir(), "llv-probe-never-executed"),
      args: [],
      cwd: process.cwd(),
      env: control === undefined ? {} : { [VIEWER_CONTROL_URL_ENV]: control },
      runtime,
      onProcessReady: () => { spawned = true; },
    });

    expect(evidence).toMatchObject({
      ok: false,
      processReady: false,
      tools: [],
      calls: { deploymentStatus: false, boardSnapshot: false },
      revision: runtime.revision,
      artifactDigest: runtime.artifactDigest,
    });
    expect(evidence.detail).toContain(VIEWER_CONTROL_URL_ENV);
  }

  expect(spawned).toBe(false);
});

test("a probe keeps the control endpoint it was handed", () => {
  expect(probeControlUrl(" http://127.0.0.1:19106 ")).toBe("http://127.0.0.1:19106");
  expect(probeControlUrl("https://viewer.invalid/base")).toBe("https://viewer.invalid/base");
  expect(probeControlUrl("ftp://viewer.invalid")).toBeNull();
  expect(probeControlUrl(undefined)).toBeNull();
});


/* Three deploys failed on `boardSnapshot: false` and a sentence that named no
   reason. The refusal the candidate's own runtime produced is the only account
   of it there will ever be - the candidate is retired seconds later. */
test("every refused read is kept with the tool's own reason and its failure code", () => {
  expect(mcpProbeCallFailures([
    { name: "deployment_status", ok: true, result: { structuredContent: { ok: true } } },
    {
      name: "board_snapshot",
      ok: false,
      result: {
        isError: true,
        structuredContent: {
          ok: false,
          code: "tool_failed",
          error: "file scanner worker exited before completion (1)",
        },
      },
    },
  ])).toEqual([{
    tool: "board_snapshot",
    code: "tool_failed",
    error: "file scanner worker exited before completion (1)",
  }]);
});

test("a refusal with no code, and one that answered nothing at all, are both still kept", () => {
  expect(mcpProbeCallFailures([
    {
      name: "board_snapshot",
      ok: false,
      result: { isError: true, content: [{ type: "text", text: "the corpus could not be read" }] },
    },
    { name: "deployment_status", ok: false, result: undefined },
  ])).toEqual([
    { tool: "board_snapshot", error: "the corpus could not be read" },
    { tool: "deployment_status", error: "no result" },
  ]);
});

/* The record is durable and the operator pastes it into issues, so the capture
   redacts and clamps exactly where `containerLog` does. The refusal that
   blocked these deploys named a filesystem path, which is precisely the shape
   that must not survive into a published artifact. */
test("a refusal naming a home path is redacted and clamped before it is recorded", () => {
  const refusal = `Module not found ${["", "home", "someone", "checkout", "fileScanner.worker.ts"].join("/")}\n`
    + `${"scan detail. ".repeat(60)}`;
  const [failure] = mcpProbeCallFailures([{
    name: "board_snapshot",
    ok: false,
    result: { isError: true, structuredContent: { ok: false, code: "tool_failed", error: refusal } },
  }]);

  expect(failure!.error).not.toContain(["", "home", "someone"].join("/"));
  expect(failure!.error).toContain("Module not found");
  expect(failure!.error).toContain("fileScanner.worker.ts");
  expect(failure!.error).not.toContain("\n");
  expect(failure!.error.endsWith("...")).toBe(true);
  expect(failure!.error.length).toBeLessThan(refusal.length / 2);
});

/** #1511: once a token is configured the Viewer authenticates every connection,
    loopback included (#1496), so a probe whose reads carry nothing is refused by
    the very candidate it is grading and the deploy fails one gate after
    readiness. This stub refuses exactly as the real gate does, so the credential
    has to travel from the adapter's probe environment, through the spawned MCP
    server, to the read. */
function gatedCandidateControl(token: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${token}`) {
        return Response.json({ error: "access denied: key required" }, { status: 403 });
      }
      return new URL(request.url).pathname === "/api/runtime/deployments"
        ? Response.json({ count: 0, deployments: [] })
        : Response.json({ error: "not found" }, { status: 404 });
    },
  });
}

test("a candidate that authenticates every connection is probed with the credential it was handed", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-probe-gated-"));
  const socketPath = path.join(sandbox, "runtime.sock");
  const journal = new RuntimeJournal(path.join(sandbox, "runtime.sqlite"));
  const admissions = new McpHealthProbeAdmissions();
  const server = serveRuntimeHost(socketPath, new RuntimeHost(
    journal,
    undefined,
    undefined,
    undefined,
    undefined,
    admissions,
  ));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  environment.LLV_STATE_DIR = sandbox;
  environment.LLV_RUNTIME_EVENTS = "1";
  environment.LLV_RUNTIME_HOST_SOCKET = socketPath;
  environment.LLV_AGENT_REGISTRY_SQLITE = "off";
  environment.LLV_CODEX_HOME = path.join(sandbox, "codex");
  environment.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
  const control = gatedCandidateControl("candidate-key");
  environment[VIEWER_CONTROL_URL_ENV] = control.url.origin;
  environment[VIEWER_CONTROL_TOKEN_ENV] = "candidate-key";

  try {
    const evidence = await probeMcpRuntime({
      command: process.execPath,
      args: [path.join(process.cwd(), "bin", "mcp-server.mjs")],
      cwd: process.cwd(),
      env: environment,
      runtime: {
        source: "managed",
        revision: "8".repeat(40),
        releaseId: "deploy-probe-gated",
        artifactDigest: "b".repeat(64),
        stagedAt: "2026-09-04T08:00:00.000Z",
      },
      healthProbeCapability: admissions.issue(),
      healthProbeAdmissions: admissions,
    });

    expect(evidence).toMatchObject({
      ok: true,
      processReady: true,
      calls: { deploymentStatus: true, boardSnapshot: true },
    });
    expect(evidence.callFailures).toBeUndefined();
  } finally {
    control.stop(true);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    journal.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 20_000);
