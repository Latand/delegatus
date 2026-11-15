import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { afterAll, expect, test } from "bun:test";

import { FIXTURE_SESSION } from "@/lib/agentState/testFixture";
import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { buildPipeline, PIPELINES_SCHEMA_VERSION } from "@/lib/pipelines/store";
import { ClaudeStreamBrokerHost, FileClaudeDeliveryLedger } from "./claudeStreamBrokerHost";
import { FileRuntimeEventStore } from "./eventStore";
import type { RuntimeEvent } from "./engineHost";
import os from "node:os";
import { pathIsInside, prepareClaudeIntegrationTestHome } from "./integrationTestHome";

const claudeBinary = process.env.LLV_CLAUDE_BINARY ?? "claude";
const resumeHome = prepareClaudeIntegrationTestHome(claudeBinary);
const permissionHome = prepareClaudeIntegrationTestHome(claudeBinary);
const bypassHome = prepareClaudeIntegrationTestHome(claudeBinary);
const mcpDefaultHome = prepareClaudeIntegrationTestHome(claudeBinary);
const mcpCustomHome = prepareClaudeIntegrationTestHome(claudeBinary);

afterAll(() => {
  resumeHome?.cleanup();
  permissionHome?.cleanup();
  bypassHome?.cleanup();
  mcpDefaultHome?.cleanup();
  mcpCustomHome?.cleanup();
});

test.skipIf(process.env.LLV_CLAUDE_MCP_STARTUP_TEST !== "1")("native Claude verifies its Viewer catalog before any model turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mcp-startup-"));
  const account = path.join(root, "account");
  fs.mkdirSync(account);
  const server = path.join(root, "server.mjs");
  fs.writeFileSync(server, `
    import { createInterface } from "node:readline";
    createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      const result = request.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "viewer", version: "1" } }
        : { tools: process.env.EMPTY_TOOLS === "1" ? [] : [{ name: "stage_report", inputSchema: { type: "object" } }] };
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
  `);
  try {
    for (const empty of [false, true]) {
      fs.writeFileSync(path.join(account, ".claude.json"), JSON.stringify({ mcpServers: { viewer: {
        command: process.execPath, args: [server], env: { EMPTY_TOOLS: empty ? "1" : "0" },
      } } }));
      let host: ClaudeStreamBrokerHost | null = null;
      const sessionId = ["00000000", "0000", "4000", "8000", empty ? "000000000002" : "000000000001"].join("-");
      const error = await ClaudeStreamBrokerHost.start({ cwd: root, claudeConfigDir: account,
        sessionId,
        env: { PATH: process.env.PATH, HOME: root, NODE_ENV: "test" }, requestTimeoutMs: 15_000,
        eventStore: new FileRuntimeEventStore(path.join(root, `events-${empty}`)),
        deliveryLedger: new FileClaudeDeliveryLedger(path.join(root, `deliveries-${empty}`)),
        readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
      }).then(value => { host = value; return null; }, reason => reason);
      try {
        if (empty) expect(String(error)).toContain("Viewer MCP launch failed");
        else expect(error).toBeNull();
      } finally { if (host) await (host as ClaudeStreamBrokerHost).release(); }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 45_000);

async function waitFor(
  iterator: AsyncIterator<RuntimeEvent>,
  predicate: (event: RuntimeEvent) => boolean,
  timeoutMs = 60_000,
): Promise<RuntimeEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const next = await iterator.next();
          if (next.done) throw new Error("Claude event stream ended early");
          if (predicate(next.value)) return next.value;
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude integration event timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function containsText(event: RuntimeEvent, expected: string): boolean {
  if (event.kind === "delta") return event.text.includes(expected);
  if (event.kind !== "item") return false;
  return JSON.stringify(event.item).includes(expected);
}

function processIdentity(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return `${pid}:${fields[19] ?? ""}`;
  } catch {
    return null;
  }
}

function processTree(rootPid: number): Map<number, string> {
  const identities = new Map<number, string>();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (identities.has(pid)) continue;
    const identity = processIdentity(pid);
    if (!identity) continue;
    identities.set(pid, identity);
    try {
      const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
      for (const child of children.split(/\s+/)) if (child) pending.push(Number(child));
    } catch { /* the process exited during the snapshot */ }
  }
  return identities;
}

function addRecordedProcess(processes: Map<number, string>, markerPath: string): void {
  const pid = Number(fs.readFileSync(markerPath, "utf8"));
  const identity = processIdentity(pid);
  if (!Number.isInteger(pid) || !identity) throw new Error(`recorded MCP process is unavailable: ${markerPath}`);
  processes.set(pid, identity);
  for (const [childPid, childIdentity] of processTree(pid)) processes.set(childPid, childIdentity);
}

async function expectProcessesReaped(processes: ReadonlyMap<number, string>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ([...processes].every(([pid, identity]) => processIdentity(pid) !== identity)) return;
    await Bun.sleep(25);
  }
  const survivors = [...processes].filter(([pid, identity]) => processIdentity(pid) === identity).map(([pid]) => pid);
  throw new Error(`Claude MCP processes survived release: ${survivors.join(",")}`);
}

function nativeClaudeTool(event: RuntimeEvent, name: string): boolean {
  if (event.kind !== "item") return false;
  const serialized = JSON.stringify(event.item);
  return serialized.includes('"type":"tool_use"') && serialized.includes(`\"name\":\"${name}\"`);
}

function nativeClaudeToolResult(event: RuntimeEvent, expectedResult: string): boolean {
  if (event.kind !== "item") return false;
  const serialized = JSON.stringify(event.item);
  return serialized.includes('"tool_use_result"')
    && serialized.includes(expectedResult)
    && !serialized.includes("Permission to use")
    && !serialized.includes("has been denied");
}

async function exerciseClaudeTool(host: ClaudeStreamBrokerHost, input: {
  name: string;
  request: string;
  expectedResult: string;
}): Promise<void> {
  const events = host.attach((await host.health()).eventCursor)[Symbol.asyncIterator]();
  const sent = await host.send({ id: `issue-607-${crypto.randomUUID()}`, text: input.request });
  expect(sent.outcome).toBe("turn-started");
  const observed: RuntimeEvent[] = [];
  await waitFor(events, (event) => {
    observed.push(event);
    return event.kind === "turn-ended";
  }, 120_000);
  const sawTool = observed.some((event) => nativeClaudeTool(event, input.name));
  const sawResult = observed.some((event) => nativeClaudeToolResult(event, input.expectedResult));
  if (!sawTool || !sawResult) {
    throw new Error(`native Claude MCP evidence is incomplete: ${JSON.stringify(observed.filter((event) => event.kind === "item").map((event) => event.item))}`);
  }
}

function configureClaudeMcpFixture(home: NonNullable<typeof mcpDefaultHome>): {
  pipelineId: string;
  cwd: string;
  viewerPidPath: string;
  optionalPidPath: string;
  unrelatedPath: string;
  hookPath: string;
} {
  const pipeline = buildPipeline({
    id: `claude-mcp-${path.basename(home.directory)}`,
    task: "Prove native Claude MCP isolation",
    project: "live-log-viewer-next",
    repoDir: process.cwd(),
    stages: [{
      id: "proof",
      kind: "run",
      "prompt": "Exercise Viewer MCP",
      next: null,
      onFail: null,
      effectiveRole: { roleId: null, engine: "claude", model: "haiku", effort: "low", access: "read-only", promptScaffold: null },
    }],
    srcPath: null,
    srcConversationId: null,
    now: "2026-07-23T00:00:00.000Z",
    state: "draft",
  });
  const stateDir = path.join(home.directory, "viewer-state");
  const viewerPidPath = path.join(home.directory, "viewer-pid");
  const optionalPidPath = path.join(home.directory, "optional-pid");
  const unrelatedPath = path.join(home.directory, "unrelated-started");
  const hookPath = path.join(home.directory, "viewer-hook-ran");
  const viewerWrapperPath = path.join(home.directory, "viewer-mcp.ts");
  const optionalServerPath = path.join(home.directory, "optional-mcp.ts");
  const unrelatedServerPath = path.join(home.directory, "unrelated-mcp.ts");
  const hookScriptPath = path.join(home.directory, "viewer-hook.sh");
  const projectRoot = path.join(home.directory, "project");
  const viewerLauncher = path.resolve(import.meta.dir, "../../../bin/mcp-server.mjs");
  fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "pipelines.json"), JSON.stringify({
    schemaVersion: PIPELINES_SCHEMA_VERSION,
    pipelines: [pipeline],
  }), { mode: 0o600 });
  fs.writeFileSync(viewerWrapperPath, [
    `await Bun.write(${JSON.stringify(viewerPidPath)}, String(process.pid));`,
    `const child = Bun.spawn({ cmd: [${JSON.stringify(Bun.which("bun") ?? "bun")}, ${JSON.stringify(viewerLauncher)}], stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });`,
    'process.on("SIGTERM", () => child.kill("SIGTERM"));',
    'process.on("SIGINT", () => child.kill("SIGINT"));',
    "process.exitCode = await child.exited;",
    "",
  ].join("\n"), { mode: 0o600 });
  fs.writeFileSync(optionalServerPath, [
    `await Bun.write(${JSON.stringify(optionalPidPath)}, String(process.pid));`,
    `const child = Bun.spawn({ cmd: [${JSON.stringify(Bun.which("bun") ?? "bun")}, ${JSON.stringify(viewerLauncher)}], stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });`,
    'process.on("SIGTERM", () => child.kill("SIGTERM"));',
    'process.on("SIGINT", () => child.kill("SIGINT"));',
    "process.exitCode = await child.exited;",
    "",
  ].join("\n"), { mode: 0o600 });
  fs.writeFileSync(unrelatedServerPath, `await Bun.write(${JSON.stringify(unrelatedPath)}, String(process.pid));\nprocess.stdin.resume();\n`, { mode: 0o600 });
  fs.writeFileSync(hookScriptPath, `#!/bin/sh\nprintf hook > ${JSON.stringify(hookPath)}\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(home.claudeConfigDir, "settings.json"), JSON.stringify({
    enabledMcpjsonServers: ["agent-browser"],
    hooks: { PreToolUse: [{ matcher: "mcp__viewer__get_pipeline", hooks: [{ type: "command", command: hookScriptPath }] }] },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(home.directory, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    mcpServers: {
      viewer: { type: "stdio", command: Bun.which("bun") ?? "bun", args: [viewerWrapperPath], env: { LLV_STATE_DIR: stateDir } },
    },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(projectRoot, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "agent-browser": {
        type: "stdio",
        command: Bun.which("bun") ?? "bun",
        args: [optionalServerPath],
        env: { LLV_STATE_DIR: stateDir, PROJECT_AUTH: "preserved" },
        timeout: 120_000,
        alwaysLoad: true,
      },
      "project-unrelated": { type: "stdio", command: Bun.which("bun") ?? "bun", args: [unrelatedServerPath] },
    },
  }), { mode: 0o600 });
  return { pipelineId: pipeline.id, cwd: projectRoot, viewerPidPath, optionalPidPath, unrelatedPath, hookPath };
}

test.skipIf(!resumeHome)("real Claude subscription supports late attach and restart resume", async () => {
  if (!resumeHome) throw new Error("isolated Claude subscription home is unavailable");
  const directory = resumeHome.directory;
  const eventStore = new FileRuntimeEventStore(path.join(directory, "events"));
  const deliveryLedger = new FileClaudeDeliveryLedger(path.join(directory, "deliveries"));
  let host: ClaudeStreamBrokerHost | null = null;
  let recovered: ClaudeStreamBrokerHost | null = null;
  try {
    host = await ClaudeStreamBrokerHost.start({
      cwd: process.cwd(),
      binary: claudeBinary,
      claudeConfigDir: resumeHome.claudeConfigDir,
      claudeProjectsDir: resumeHome.claudeProjectsDir,
      env: resumeHome.env,
      model: "haiku",
      permissionMode: "dontAsk",
      tools: [],
      systemPrompt: "Follow each user request exactly. Do not inspect files or use tools.",
      eventStore,
      deliveryLedger,
    });
    const owner = host.attach(0)[Symbol.asyncIterator]();
    const sent = await host.send({
      id: `issue-150-original-${crypto.randomUUID()}`,
      text: "Remember marker ORCHID-150, then reply with exactly ACK-150.",
    });
    expect(sent.outcome).toBe("turn-started");
    const late = host.attach(0)[Symbol.asyncIterator]();
    await waitFor(owner, (event) => containsText(event, "ACK-150"));
    await waitFor(late, (event) => containsText(event, "ACK-150"));
    const sessionId = host.identity.sessionId;
    const sessionPath = claudeTranscriptPath(process.cwd(), sessionId, resumeHome.claudeProjectsDir);
    expect(pathIsInside(resumeHome.directory, sessionPath)).toBeTrue();
    expect(fs.existsSync(sessionPath)).toBeTrue();
    await host.release();
    const releasedCursor = (await host.health()).eventCursor;
    host = null;

    recovered = await ClaudeStreamBrokerHost.adopt(sessionId, {
      cwd: process.cwd(),
      binary: claudeBinary,
      claudeConfigDir: resumeHome.claudeConfigDir,
      claudeProjectsDir: resumeHome.claudeProjectsDir,
      env: resumeHome.env,
      model: "haiku",
      permissionMode: "dontAsk",
      tools: [],
      systemPrompt: "Follow each user request exactly. Do not inspect files or use tools.",
      initialEventCursor: releasedCursor,
      eventStore,
      deliveryLedger,
    });
    expect(recovered.identity.sessionId).toBe(sessionId);
    const recovery = recovered.attach((await recovered.health()).eventCursor)[Symbol.asyncIterator]();
    const recall = await recovered.send({
      id: `issue-150-recall-${crypto.randomUUID()}`,
      text: "Reply with only the marker I asked you to remember.",
    });
    expect(recall.outcome).toBe("turn-started");
    await waitFor(recovery, (event) => containsText(event, "ORCHID-150"));
  } finally {
    await host?.release();
    await recovered?.release();
    resumeHome.cleanup();
  }
}, 180_000);

test.skipIf(!permissionHome)("real Claude permission requests reach EngineHost.answer", async () => {
  if (!permissionHome) throw new Error("isolated Claude subscription home is unavailable");
  const directory = permissionHome.directory;
  const eventStore = new FileRuntimeEventStore(path.join(directory, "events"));
  const deliveryLedger = new FileClaudeDeliveryLedger(path.join(directory, "deliveries"));
  let host: ClaudeStreamBrokerHost | null = null;
  try {
    host = await ClaudeStreamBrokerHost.start({
      cwd: process.cwd(),
      binary: claudeBinary,
      claudeConfigDir: permissionHome.claudeConfigDir,
      claudeProjectsDir: permissionHome.claudeProjectsDir,
      env: permissionHome.env,
      model: "haiku",
      permissionMode: "default",
      tools: ["Bash"],
      systemPrompt: "Follow the user request exactly and use the requested tool.",
      eventStore,
      deliveryLedger,
    });
    const events = host.attach(0)[Symbol.asyncIterator]();
    const probePath = path.join(directory, "permission-probe");
    const sent = await host.send({
      id: `issue-150-permission-${crypto.randomUUID()}`,
      text: `Use the Bash tool once to run \`touch ${probePath}\`. Do not answer before attempting the tool.`,
    });
    expect(sent.outcome).toBe("turn-started");
    const attention = await waitFor(events, (event) => event.kind === "attention" && event.method === "can_use_tool");
    if (attention.kind !== "attention") throw new Error("expected Claude permission attention");
    const sessionPath = claudeTranscriptPath(process.cwd(), host.identity.sessionId, permissionHome.claudeProjectsDir);
    expect(pathIsInside(permissionHome.directory, sessionPath)).toBeTrue();
    expect(fs.existsSync(sessionPath)).toBeTrue();
    await host.answer(attention.id, { behavior: "deny", message: "Denied by the runtime integration test." });
    await waitFor(events, (event) => event.kind === "turn-ended");
  } finally {
    await host?.release();
    permissionHome.cleanup();
  }
}, 180_000);

test.skipIf(!bypassHome)("real Claude bypass executes Bash without pending attention", async () => {
  if (!bypassHome) throw new Error("isolated Claude subscription home is unavailable");
  const directory = bypassHome.directory;
  const eventStore = new FileRuntimeEventStore(path.join(directory, "events"));
  const deliveryLedger = new FileClaudeDeliveryLedger(path.join(directory, "deliveries"));
  let host: ClaudeStreamBrokerHost | null = null;
  try {
    host = await ClaudeStreamBrokerHost.start({
      cwd: directory,
      binary: claudeBinary,
      claudeConfigDir: bypassHome.claudeConfigDir,
      claudeProjectsDir: bypassHome.claudeProjectsDir,
      env: bypassHome.env,
      model: "haiku",
      permissionMode: "bypassPermissions",
      tools: ["Bash"],
      systemPrompt: "Follow the user request exactly and use the requested tool.",
      eventStore,
      deliveryLedger,
    });
    const events = host.attach(0)[Symbol.asyncIterator]();
    const probePath = path.join(directory, "bypass-probe");
    const sent = await host.send({
      id: `issue-243-bypass-${crypto.randomUUID()}`,
      text: `Use the Bash tool once to run \`touch ${probePath}\`. Reply after the tool completes.`,
    });
    expect(sent.outcome).toBe("turn-started");
    let sawAttention = false;
    await waitFor(events, (event) => {
      if (event.kind === "attention") sawAttention = true;
      return event.kind === "turn-ended";
    });
    expect(fs.existsSync(probePath)).toBeTrue();
    expect(sawAttention).toBeFalse();
    expect((await host.health()).pendingAttention).toEqual([]);
  } finally {
    await host?.release();
    bypassHome.cleanup();
  }
}, 180_000);

test.skipIf(!mcpDefaultHome)("real Claude default MCP policy exposes Viewer, preserves hooks, excludes sentinels, and reaps the fleet", async () => {
  if (!mcpDefaultHome) throw new Error("isolated Claude subscription home is unavailable");
  const fixture = configureClaudeMcpFixture(mcpDefaultHome);
  let host: ClaudeStreamBrokerHost | null = null;
  try {
    host = await ClaudeStreamBrokerHost.start({
      cwd: fixture.cwd,
      binary: claudeBinary,
      claudeConfigDir: mcpDefaultHome.claudeConfigDir,
      claudeProjectsDir: mcpDefaultHome.claudeProjectsDir,
      mcpStatePath: path.join(mcpDefaultHome.directory, ".claude.json"),
      env: mcpDefaultHome.env,
      model: "haiku",
      permissionMode: "bypassPermissions",
      systemPrompt: "Use the exact native MCP tool requested by the user. Shell execution is prohibited.",
      eventStore: new FileRuntimeEventStore(path.join(mcpDefaultHome.directory, "mcp-events")),
      deliveryLedger: new FileClaudeDeliveryLedger(path.join(mcpDefaultHome.directory, "mcp-deliveries")),
    });
    await exerciseClaudeTool(host, {
      name: "mcp__viewer__get_pipeline",
      request: `Call the native Viewer MCP tool get_pipeline with clientRequestId "claude-default" and pipelineId "${fixture.pipelineId}". Reply after the successful result.`,
      expectedResult: fixture.pipelineId,
    });
    expect((await host.health()).account).toMatchObject({ type: "claude.ai" });
    expect(fs.existsSync(fixture.hookPath)).toBeTrue();
    expect(fs.existsSync(fixture.optionalPidPath)).toBeFalse();
    expect(fs.existsSync(fixture.unrelatedPath)).toBeFalse();
    const health = await host.health();
    if (!health.pid) throw new Error("Claude host pid is unavailable");
    const processes = processTree(health.pid);
    addRecordedProcess(processes, fixture.viewerPidPath);
    await host.release();
    host = null;
    await expectProcessesReaped(processes);
    expect(fs.existsSync(fixture.unrelatedPath)).toBeFalse();
  } finally {
    await host?.release();
  }
}, 300_000);

test.skipIf(!mcpCustomHome)("real Claude custom MCP policy force-includes Viewer across fresh and adopted hosts with complete cleanup", async () => {
  if (!mcpCustomHome) throw new Error("isolated Claude subscription home is unavailable");
  const fixture = configureClaudeMcpFixture(mcpCustomHome);
  const eventStore = new FileRuntimeEventStore(path.join(mcpCustomHome.directory, "mcp-events"));
  const deliveryLedger = new FileClaudeDeliveryLedger(path.join(mcpCustomHome.directory, "mcp-deliveries"));
  const options = {
    cwd: fixture.cwd,
    binary: claudeBinary,
    claudeConfigDir: mcpCustomHome.claudeConfigDir,
    claudeProjectsDir: mcpCustomHome.claudeProjectsDir,
    mcpStatePath: path.join(mcpCustomHome.directory, ".claude.json"),
    mcpServers: ["agent-browser"],
    env: mcpCustomHome.env,
    model: "haiku",
    permissionMode: "bypassPermissions",
    systemPrompt: "Use the exact native MCP tool requested by the user. Shell execution is prohibited.",
    eventStore,
    deliveryLedger,
  };
  let fresh: ClaudeStreamBrokerHost | null = null;
  let adopted: ClaudeStreamBrokerHost | null = null;
  try {
    fresh = await ClaudeStreamBrokerHost.start(options);
    const profileId = `structured-${crypto.createHash("sha256").update(fresh.identity.sessionId).digest("hex").slice(0, 24)}`;
    const freshMcpConfig = JSON.parse(fs.readFileSync(path.join(
      mcpCustomHome.claudeConfigDir,
      ".llv",
      "spawn-mcp",
      `${profileId}.json`,
    ), "utf8")) as { mcpServers: Record<string, unknown> };
    const freshSettings = JSON.parse(fs.readFileSync(path.join(
      mcpCustomHome.claudeConfigDir,
      ".llv",
      "spawn-settings",
      `${profileId}.json`,
    ), "utf8")) as { enabledMcpjsonServers: string[]; disabledMcpjsonServers: string[] };
    /* The allowlist names a project-scoped server; the grant bound admits none,
       so the exclusive config carries Viewer alone and the optional server's
       process is never started (#739). */
    expect(Object.keys(freshMcpConfig.mcpServers)).toEqual(["viewer"]);
    expect(freshSettings.enabledMcpjsonServers ?? []).not.toContain("agent-browser");
    expect(freshSettings.disabledMcpjsonServers ?? []).toContain("project-unrelated");
    await exerciseClaudeTool(fresh, {
      name: "mcp__viewer__get_pipeline",
      request: `Call the exact native tool mcp__viewer__get_pipeline with clientRequestId "claude-custom-fresh" and pipelineId "${fixture.pipelineId}". Shell execution is prohibited. Reply after the successful result.`,
      expectedResult: fixture.pipelineId,
    });
    expect(fs.existsSync(fixture.viewerPidPath)).toBeTrue();
    expect(fs.existsSync(fixture.optionalPidPath)).toBeFalse();
    expect(fs.existsSync(fixture.unrelatedPath)).toBeFalse();
    const sessionId = fresh.identity.sessionId;
    const cursor = (await fresh.health()).eventCursor;
    const freshPid = (await fresh.health()).pid;
    if (!freshPid) throw new Error("fresh Claude host pid is unavailable");
    const freshProcesses = processTree(freshPid);
    addRecordedProcess(freshProcesses, fixture.viewerPidPath);
    await fresh.release();
    fresh = null;
    await expectProcessesReaped(freshProcesses);

    fs.rmSync(fixture.viewerPidPath);
    adopted = await ClaudeStreamBrokerHost.adopt(sessionId, { ...options, initialEventCursor: cursor });
    await exerciseClaudeTool(adopted, {
      name: "mcp__viewer__get_pipeline",
      request: `Call the exact native tool mcp__viewer__get_pipeline with clientRequestId "claude-adopted-viewer" and pipelineId "${fixture.pipelineId}". Shell execution is prohibited. Reply after the successful result.`,
      expectedResult: fixture.pipelineId,
    });
    expect(fs.existsSync(fixture.viewerPidPath)).toBeTrue();
    expect(fs.existsSync(fixture.optionalPidPath)).toBeFalse();
    expect(fs.existsSync(fixture.unrelatedPath)).toBeFalse();
    expect(fs.existsSync(fixture.hookPath)).toBeTrue();
    const adoptedPid = (await adopted.health()).pid;
    if (!adoptedPid) throw new Error("adopted Claude host pid is unavailable");
    const adoptedProcesses = processTree(adoptedPid);
    addRecordedProcess(adoptedProcesses, fixture.viewerPidPath);
    await adopted.release();
    adopted = null;
    await expectProcessesReaped(adoptedProcesses);
    expect(fs.existsSync(fixture.unrelatedPath)).toBeFalse();
  } finally {
    await fresh?.release();
    await adopted?.release();
  }
}, 420_000);


test.each(["silent", "foreground", "background", "permission", "retry", "fence", "quota", "reasoning"])("re-hosted broker bounds silence and protects %s", async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "broker-silence-"));
  const sessionId = FIXTURE_SESSION;
  const store = new FileRuntimeEventStore(path.join(root, "events"));
  let now = Date.parse("2026-11-01T00:00:00Z");
  let deadline: (() => Promise<void>) | undefined;
  const completion = path.join(root, "complete");
  const childProgram = `
    const { createInterface } = require("node:readline");
    const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
    createInterface({ input: process.stdin }).on("line", line => {
      const input = JSON.parse(line);
      if (input.type === "control_request") {
        emit({ type: "control_response", response: { subtype: "success", request_id: input.request_id } });
        return;
      }
      emit({ type: "user", uuid: "user-" + JSON.stringify(input.message.content), message: input.message });
      emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tool", name: "Bash", input: { command: "true" } }] } });
      const initial = JSON.stringify(input.message.content).includes("initial");
      const mode = initial ? "initial" : ${JSON.stringify(mode)};
      if (mode !== "foreground") emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "done" }] } });
      if (initial) emit({ type: "result", subtype: "success" });
      else if (mode === "quota") {
        emit({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", message: { role: "assistant", content: [{ type: "text", text: "Provider capacity is exhausted" }] } });
        emit({ type: "result", subtype: "error_during_execution", is_error: true });
      } else {
        const fs = require("node:fs");
        const work = ["foreground", "background"].includes(mode) ? require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]) : null;
        if (work) fs.writeFileSync(${JSON.stringify(path.join(root, "work.pid"))}, String(work.pid));
        if (mode === "background") emit({ type: "system", subtype: "task_started", task_id: "work" });
        if (mode === "permission") emit({ type: "control_request", request_id: "question", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } });
        if (mode === "retry") emit({ type: "system", subtype: "api_retry", retry_delay_ms: 30 * 60_000 });
        let thought = false;
        const timer = setInterval(() => {
          if (!thought && fs.existsSync(${JSON.stringify(path.join(root, "think"))})) {
            thought = true;
            emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "reasoning in progress" } } });
          }
          if (!fs.existsSync(${JSON.stringify(completion)})) return;
          clearInterval(timer); work?.kill();
          emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "done" }] } });
          emit({ type: "system", subtype: "task_notification", task_id: "work" });
          emit({ type: "control_cancel_request", request_id: "question" });
          emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "completed" }] } });
          emit({ type: "result", subtype: "success" });
        }, 5);
      }
    });`;
  const options = { cwd: root, sessionId, eventStore: store, requestTimeoutMs: 2000,
    deliveryLedger: new FileClaudeDeliveryLedger(path.join(root, "deliveries")),
    readTranscript: () => [],
    readAuthStatus: () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
    spawnProcess: (_command: string, _args: string[], spawnOptions: import("node:child_process").SpawnOptionsWithoutStdio) =>
      spawn(process.execPath, ["-e", childProgram], { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"], detached: true }),
    turnSilence: { now: () => now, schedule: (callback: () => Promise<void>) => {
      deadline = callback; return () => { if (deadline === callback) deadline = undefined; };
    } },
  };
  let host: ClaudeStreamBrokerHost | null = null;
  const until = async (predicate: () => boolean) => {
    const end = performance.now() + 4000;
    while (!predicate()) { if (performance.now() >= end) throw new Error("broker fixture handshake expired"); await Bun.sleep(5); }
  };
  try {
    host = await ClaudeStreamBrokerHost.start(options);
    await host.send({ id: "initial", text: "initial" });
    await until(() => store.load(sessionId).some(event => event.kind === "turn-ended"));
    await host.release();
    host = await ClaudeStreamBrokerHost.adopt(sessionId, options);
    await host.send({ id: "silent", text: "silent" });
    await until(() => store.load(sessionId).some(event => event.kind === "item" && event.turnId === "silent" && JSON.stringify(event.item).includes(mode === "foreground" ? "tool_use" : "tool_result")));
    if (mode === "quota") {
      await until(() => store.load(sessionId).some(event => event.kind === "turn-ended" && event.turnId === "silent"));
      for (const id of ["later-notice", "later-wake"]) {
        expect((await host.health()).status).toBe("idle");
        await host.send({ id, text: id });
        await until(() => store.load(sessionId).some(event => event.kind === "turn-ended" && event.turnId === id));
      }
      expect(store.load(sessionId).filter(event => event.kind === "turn-ended" && event.status === "error").map(event => event.kind === "turn-ended" ? event.turnId : null)).toEqual(["silent", "later-notice", "later-wake"]);
      expect((await host.health()).status).toBe("idle"); return;
    }
    if (mode === "reasoning") {
      const originalDeadline = deadline;
      now += 14 * 60_000; fs.writeFileSync(path.join(root, "think"), "think");
      await until(() => deadline !== originalDeadline);
      now += 60_000; await deadline!();
      expect((await host.health()).status).toBe("active");
      now += 14 * 60_000; await deadline!();
      expect((await host.health()).status).toBe("dead"); return;
    }
    if (["foreground", "background"].includes(mode)) await until(() => fs.existsSync(path.join(root, "work.pid")));
    if (mode === "permission") await until(() => store.load(sessionId).some(event => event.kind === "attention"));
    if (mode === "background") await until(() => store.load(sessionId).some(event => event.kind === "item" && JSON.stringify(event.item).includes("task_started")));
    if (mode === "retry") {
      const end = performance.now() + 4000;
      while (!(await host.health()).providerRetry) { if (performance.now() >= end) throw new Error("provider retry handshake expired"); await Bun.sleep(5); }
    }
    if (mode === "fence") host.setWriterFence(() => false);
    expect((await host.health()).status).toBe(mode === "permission" ? "attention" : "active");
    expect(deadline).toBeFunction();
    now += 15 * 60_000;
    await deadline!();
    if (mode !== "silent") {
      expect((await host.health()).status).toBe(mode === "permission" ? "attention" : "active");
      expect(store.load(sessionId).filter(event => event.kind === "turn-ended" && event.turnId === "silent")).toHaveLength(0);
      if (["foreground", "background"].includes(mode)) expect(() => process.kill(Number(fs.readFileSync(path.join(root, "work.pid"), "utf8")), 0)).not.toThrow();
      host.setWriterFence(() => true);
      fs.writeFileSync(completion, "complete");
      await until(() => store.load(sessionId).some(event => event.kind === "turn-ended" && event.turnId === "silent"));
      expect((await host.health()).status).toBe("idle"); return;
    }
    expect(store.load(sessionId)).toContainEqual(expect.objectContaining({ kind: "item", turnId: "silent", item: expect.objectContaining({ reason: "turn-silence-timeout" }) }));
    expect((await host.health()).status).toBe("dead");
    expect(store.load(sessionId).filter(event => event.kind === "turn-ended" && event.turnId === "silent")).toMatchObject([{ status: "error" }]);
    await host.release();
    host = await ClaudeStreamBrokerHost.adopt(sessionId, options);
    expect(store.load(sessionId).filter(event => event.kind === "turn-ended" && event.turnId === "silent")).toHaveLength(1);
  } finally { await host?.release(); fs.rmSync(root, { recursive: true, force: true }); }
}, 15000);
