// destructive-code: head-only; fixture-owned paths and recording process doubles.
import * as publicationSource from "@/lib/git/repositoryCommitIdentity";
import * as telegramLaunch from "./telegramConnectorEnv";
import { SOURCE_STATES, chooseSource, sourceTurnsEnginesOff } from "@/lib/memory/fixtures/source";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { describe, expect, spyOn, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { clearTelegramConnection, saveTelegramSession, writeTelegramConnection, TELEGRAM_CONNECTOR_TOKEN_ENV } from "@/lib/telegram/sessionStore";
import { CodexAppServerHost } from "./codexAppServerHost";
import { CodexSocketTransport } from "./codexSocketTransport";
import { FileRuntimeEventStore } from "./eventStore";
import { projectEngineHostEvent } from "./engineHostEvents";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { stopFixtureProcess } from "../testing/fixtureProcess";
import { gateCheckTool } from "./gateCheckTool";
import { cpuOwnerIdentity } from "./signalSandboxContext";
import { custodyClock, physical } from "../recordedChecks/wire";
import { materializeStructuredHostAccess, READ_ONLY_STAGE_PERMISSION_PROFILE } from "./structuredSpawn";
import { setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import { codexProcessCleanupArgs } from "@/lib/agent/processCleanupPolicy";
import { TELEGRAM_UNAVAILABLE_THIS_RUN_NOTICE } from "./telegramConnectorEnv";
import { observeCodexSubagentEvent } from "./codexSubagentDetection";
import { lifecycleEventId, queryLifecycleEvents } from "@/lib/lifecycle/journal";
import { installCodexHostFixture, DENIED_FEATURE_ARGS, MemoryEventStore, modelNegotiationServer, MODEL_NEGOTIATION_IMAGE, FakeAppServer, fakeSpawn, metadataState } from "./codexAppServerHost.fixture";

installCodexHostFixture();

describe("CodexAppServerHost", () => {
  for (const resumed of [false, true]) test(`memory hook stays in ${resumed ? "resumed" : "fresh"} launch configuration`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "memory-launch-host-"));
    const server = new FakeAppServer("memory-launch-thread");
    const captured: { args?: string[] } = {};
    const options = { cwd: home, codexHome: home, operatorDecisionForms: true,
      env: { ...process.env, LLV_SPAWN_CAPABILITY: "synthetic-capability" },
      eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server, captured) };
    const host = resumed ? await CodexAppServerHost.adopt("memory-launch-thread", options) : await CodexAppServerHost.start(options);
    try {
      expect(captured.args?.some(arg => arg.startsWith("hooks.UserPromptSubmit=["))).toBe(true);
      const config = (server.requests.find(r => r.method === (resumed ? "thread/resume" : "thread/start"))!.params as { config: { hooks: { UserPromptSubmit: unknown[]; state: Record<string, unknown> } } }).config;
      expect(JSON.stringify(config.hooks.UserPromptSubmit)).toContain("memory-launch-");
      expect(Object.keys(config.hooks.state)).toEqual(expect.arrayContaining([
        "/<session-flags>/config.toml:user_prompt_submit:0:0", "/<session-flags>/config.toml:pre_tool_use:0:0", "/<session-flags>/config.toml:pre_tool_use:1:0",
      ]));
      expect(server.requests.filter(r => r.method === "hooks/list" || r.method === "config/value/write")).toEqual([]);
      const accountHooks = JSON.parse(fs.readFileSync(path.join(home, "hooks.json"), "utf8")).hooks;
      expect(accountHooks.PreToolUse).toHaveLength(1);
      expect(accountHooks.UserPromptSubmit).toBeUndefined();
      expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).not.toContain("user_prompt_submit");
      expect(await host.send({ id: "operator-after-hook", text: "Synthetic operator prompt", origin: { kind: "operator" } })).toMatchObject({ outcome: "turn-started" });
    } finally { await host.release(); fs.rmSync(home, { recursive: true, force: true }); }
  });

  test("structured Codex loads Telegram auth only for the granted root host", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-codex-telegram-grant-"));
    const previousState = process.env.LLV_STATE_DIR;
    process.env.LLV_STATE_DIR = path.join(directory, "state");
    try {
      const stored = saveTelegramSession("1ApWapzMBu4placeholder-not-a-real-session");
      writeTelegramConnection({ version: 1, status: "connected", credentialRef: stored.credentialRef,
        identity: null, lastHealthCheckAt: null, errorCode: null, identityIdUpgradedAt: null });
      const rootServer = new FakeAppServer("telegram-root");
      rootServer.mcpServers = {
        viewer: { command: "viewer-mcp", enabled: true },
        telegram: { url: "http://127.0.0.1:8809/mcp", enabled: true },
      };
      const rootCapture: { options?: SpawnOptionsWithoutStdio } = {};
      const root = await CodexAppServerHost.start({
        cwd: "/repo",
        mcpServers: ["viewer", "telegram"],
        env: { NODE_ENV: "test", [TELEGRAM_CONNECTOR_TOKEN_ENV]: "B".repeat(43) },
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(rootServer, rootCapture),
      });
      expect(rootCapture.options?.env?.[TELEGRAM_CONNECTOR_TOKEN_ENV]).toBe(stored.connectorToken);
      await root.release();

      const delegatedServer = new FakeAppServer("telegram-delegated");
      const delegatedCapture: { options?: SpawnOptionsWithoutStdio } = {};
      const delegated = await CodexAppServerHost.start({
        cwd: "/repo",
        mcpServers: ["viewer"],
        env: { NODE_ENV: "test", [TELEGRAM_CONNECTOR_TOKEN_ENV]: stored.connectorToken },
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(delegatedServer, delegatedCapture),
      });
      expect(delegatedCapture.options?.env?.[TELEGRAM_CONNECTOR_TOKEN_ENV]).toBeUndefined();
      await delegated.release();
    } finally {
      if (previousState === undefined) delete process.env.LLV_STATE_DIR;
      else process.env.LLV_STATE_DIR = previousState;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fresh structured threads discover account MCP configuration and allow only Viewer", async () => {
    const server = new FakeAppServer("viewer-thread");
    server.mcpServers = {
      viewer: { command: "agent-log-viewer-mcp", enabled: true, default_tools_approval_mode: "prompt" },
      playwright: { command: "npx", enabled: true, default_tools_approval_mode: "writes" },
    };
    const captured: { args?: string[] } = {};
    const host = await CodexAppServerHost.start({
      cwd: "/repo",
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(server, captured),
    });

    expect(captured.args).toEqual([...DENIED_FEATURE_ARGS, ...codexProcessCleanupArgs(), "app-server", "--enable", "realtime_conversation"]);
    expect(server.requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
      config: {
        mcp_servers: {
          viewer: { enabled: true, default_tools_approval_mode: "approve" },
          playwright: { enabled: false, default_tools_approval_mode: "writes" },
        },
      },
    });
    await host.release();
  });

  test("applies the isolated read-only-stage permission profile to fresh and adopted threads", async () => {
    const permissionProfile = "llv-read-only-stage";
    const permissionProfileConfig = 'permissions.llv-read-only-stage={extends=":read-only",filesystem={"/scratch"="write"}}';
    for (const threadId of [null, "scratch-thread"] as const) {
      const server = new FakeAppServer(threadId ?? "scratch-thread");
      const captured: { args?: string[]; options?: SpawnOptionsWithoutStdio } = {};
      const options = {
        cwd: "/repo",
        permissionProfile,
        permissionProfileConfig,
        forwardGitHubConfig: true,
        env: { NODE_ENV: "test" as const, GH_CONFIG_DIR: "/shared/config/gh" },
        eventStore: new MemoryEventStore(),
        spawnProcess: fakeSpawn(server, captured),
      };
      const host = threadId
        ? await CodexAppServerHost.adopt(threadId, options)
        : await CodexAppServerHost.start(options);

      expect(captured.args).toEqual([
        ...DENIED_FEATURE_ARGS,
        ...codexProcessCleanupArgs(),
        "-c", `default_permissions=${JSON.stringify(permissionProfile)}`,
        "-c", permissionProfileConfig,
        "app-server", "--enable", "realtime_conversation",
      ]);
      expect(captured.options?.env?.GH_CONFIG_DIR).toBe("/shared/config/gh");
      const method = threadId ? "thread/resume" : "thread/start";
      const params = server.requests.find((request) => request.method === method)?.params as Record<string, unknown>;
      expect(params).toMatchObject({ permissions: permissionProfile });
      expect(params).not.toHaveProperty("sandbox");
      await host.release();
    }

    const readWriteServer = new FakeAppServer("read-write-thread");
    const readWriteCapture: { options?: SpawnOptionsWithoutStdio } = {};
    const readWriteHost = await CodexAppServerHost.start({
      cwd: "/repo",
      sandbox: "danger-full-access",
      env: { NODE_ENV: "test", GH_CONFIG_DIR: "/shared/config/gh" },
      eventStore: new MemoryEventStore(),
      spawnProcess: fakeSpawn(readWriteServer, readWriteCapture),
    });
    /* The agent no longer inherits XDG_CONFIG_HOME, which is where `gh` found
       its configuration, so the boundary pins it instead of forwarding it
       (#1905). A source value still wins where the caller forwards one. */
    expect(readWriteCapture.options?.env?.GH_CONFIG_DIR).toBe(path.join(os.homedir(), ".config", "gh"));
    await readWriteHost.release();
  });

  test.each([
    { sandbox: "danger-full-access", approvalPolicy: "never" },
    { sandbox: "workspace-write", approvalPolicy: "on-request" },
    { sandbox: "read-only", approvalPolicy: "untrusted" },
  ])("succession resume replays sandbox=$sandbox and approval=$approvalPolicy, including hydration fallback", async ({ sandbox, approvalPolicy }) => {
    for (const paginated of [false, true]) {
      const threadId = "launch-access-thread";
      const firstServer = new FakeAppServer(threadId);
      const options = { cwd: process.cwd(), sandbox, approvalPolicy, eventStore: new MemoryEventStore() };
      const first = await CodexAppServerHost.start({ ...options, spawnProcess: fakeSpawn(firstServer) });
      await first.release();
      const successorServer = new FakeAppServer(threadId);
      successorServer.paginatedResume = paginated;
      const successor = await CodexAppServerHost.adopt(threadId, { ...options, spawnProcess: fakeSpawn(successorServer) });
      try {
        const fresh = firstServer.requests.find(request => request.method === "thread/start")!.params as Record<string, unknown>;
        const resumed = successorServer.requests.filter(request => request.method === "thread/resume");
        expect(resumed).toHaveLength(paginated ? 2 : 1);
        for (const request of resumed) {
          expect(request.params).toMatchObject({ sandbox: fresh.sandbox, approvalPolicy: fresh.approvalPolicy });
          expect(request.params).not.toHaveProperty("permissions");
        }
      } finally {
        await successor.release();
      }
    }
  });
});

test.each([false, true])("launch observations reach fresh and adopted Codex requests with clean memory=%s", async cleanMemory => {
  const observation = JSON.stringify({ cleanerSandbox: { mode: "unsandboxed", reason: "fixture sandbox unavailable" } });
  for (const resumed of [false, true]) {
    const server = new FakeAppServer("cleaner-observation-thread");
    const options = { cwd: "/repo", cleanMemory, runtimeInstructions: observation,
      eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) };
    const host = resumed ? await CodexAppServerHost.adopt("cleaner-observation-thread", options) : await CodexAppServerHost.start(options);
    try {
      const params = server.requests.find(r => r.method === (resumed ? "thread/resume" : "thread/start"))!.params as { developerInstructions?: string };
      expect(params.developerInstructions).toContain(observation);
    } finally { await host.release(); }
  }
});

test("memory source table reaches fresh and adopted Codex argv and thread overrides", async () => {
  for (const cleanMemory of [false, true]) for (const resumed of [false, true]) {
    let original: { args: string[]; config: { features: { memories?: boolean } } } | undefined;
    for (const state of SOURCE_STATES) {
      chooseSource(state);
      const server = new FakeAppServer("memory-source-thread");
      const captured: { args?: string[]; options?: SpawnOptionsWithoutStdio } = {};
      const options = { cwd: "/repo", allowSubagents: true, cleanMemory, developerInstructions: "Synthetic Delegatus rules.",
        eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server, captured) };
      const host = resumed ? await CodexAppServerHost.adopt("memory-source-thread", options) : await CodexAppServerHost.start(options);
      try {
        const params = server.requests.find(r => r.method === (resumed ? "thread/resume" : "thread/start"))!.params as { config: { features: { memories?: boolean } }; developerInstructions?: string };
        const off = cleanMemory || sourceTurnsEnginesOff(state);
        expect(captured.args?.includes("features.memories=false")).toBe(off);
        expect(params.config.features.memories).toBe(off ? false : undefined);
        if (!resumed && !cleanMemory) expect(params.developerInstructions).toContain("Synthetic Delegatus rules.");
        const output = { args: captured.args!, config: params.config };
        if (state === "unchosen") original = structuredClone(output);
        if (state === "importing" || state === "engines") expect(output).toEqual(original!);
      } finally { await host.release(); }
    }
  }
});

test("every native host offers one gate completion callback without opening operator attention", async () => {
  const server = new FakeAppServer("gate-wait-thread");
  const eventStore = new MemoryEventStore();
  const host = await CodexAppServerHost.start({ cwd: metadataState, env: { ...process.env, TMPDIR: metadataState },
    eventStore, spawnProcess: fakeSpawn(server) });
  try {
    expect((server.requests.find(row => row.method === "thread/start")!.params as { dynamicTools: unknown[] }).dynamicTools).toContainEqual(gateCheckTool);
    await host.send({ id: "gate-opening", text: "run a check" });
    const log = path.join(metadataState, "check.log"), dir = `${log}.gate`;
    fs.mkdirSync(dir); fs.writeFileSync(log, "work\n");
    const recorder = cpuOwnerIdentity(process.pid);
    fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify(recorder));
    fs.writeFileSync(path.join(dir, "completion.json"), JSON.stringify({ recorder, directoryIdentity: physical(dir), deadlineUptimeMs: custodyClock() + 60_000 }));
    const params = { threadId: "gate-wait-thread", turnId: "turn-1", callId: "wait-call", tool: gateCheckTool.name, arguments: { log, reason: "fixture comparator" } };
    const reply = new Promise<Record<string, unknown>>(resolve => {
      const listener = (message: Record<string, unknown>) => { if (message.id === "gate-wait") { server.off("client-request", listener); resolve(message); } };
      server.on("client-request", listener);
    });
    server.request("gate-wait", "item/tool/call", params);
    server.request("gate-wait", "item/tool/call", params);
    expect((await host.health()).pendingAttention).toEqual([]);
    expect(server.requests.filter(row => row.id === "gate-wait")).toHaveLength(0);
    fs.writeFileSync(path.join(dir, "exit"), "37\n");
    expect((await reply).result).toMatchObject({ success: true });
    expect(server.requests.filter(row => row.id === "gate-wait")).toHaveLength(1);
    const foreignReply = new Promise<Record<string, unknown>>(resolve => {
      const listener = (message: Record<string, unknown>) => { if (message.id === "foreign-wait") { server.off("client-request", listener); resolve(message); } };
      server.on("client-request", listener);
    });
    server.request("foreign-wait", "item/tool/call", { ...params, threadId: "foreign-thread" });
    expect((await foreignReply).result).toMatchObject({ success: false });
    expect((await host.health()).pendingAttention).toEqual([]);
    // Native Codex never sends serverRequest/resolved for a dynamic tool call
    // and this server sends none: the host's own reply settles each wait.
    const refusedReply = new Promise<Record<string, unknown>>(resolve => {
      const listener = (message: Record<string, unknown>) => { if (message.id === "refused-wait") { server.off("client-request", listener); resolve(message); } };
      server.on("client-request", listener);
    });
    server.request("refused-wait", "item/tool/call", { ...params, callId: "refused-call", arguments: { log: "relative.log", reason: "fixture comparator" } });
    expect((await refusedReply).result).toMatchObject({ success: false });
    const events = eventStore.load(host.identity.threadId!);
    const settled = events.filter(event => event.kind === "attention-resolved" && event.codexReceipt?.gateWait);
    expect(settled.map(event => event.kind === "attention-resolved" && [event.codexReceipt!.identity.requestId, event.resolution, event.codexReceipt!.serverResolution?.outcome]))
      .toEqual([["gate-wait", "answered", "answered"], ["foreign-wait", "answered", "answered"], ["refused-wait", "answered", "answered"]]);
    const refused = settled.at(-1);
    expect(refused?.kind === "attention-resolved" && refused.codexReceipt?.gateWait).toMatchObject({ result: { success: false } });
    expect(refused?.kind === "attention-resolved" && refused.codexReceipt?.gateWait?.runId).toBeUndefined();
    // None of it reaches the operator's attention projection.
    expect(events.filter(event => event.kind === "attention" || event.kind === "attention-resolved")
      .map(event => projectEngineHostEvent("conversation", "codex:gate-wait-thread", event))).toEqual(events.filter(event => event.kind === "attention" || event.kind === "attention-resolved").map(() => null));
  } finally { await host.release(); }
});

test.each(["allowed", "protocol", "publication", "telegram", "resume-retry", "initialize", "account/read", "model/list", "modelProvider/capabilities/read", "config/read", "thread/resume", "mcpServerStatus/list", "thread/queue/list", "thread/turns/list"] as const)("adoption stops after authority changes at %s", async boundary => {
  const server = new FakeAppServer("adoption-authority");
  let owned = true, reached = false, spawns = 0, writesAtRevocation = 0;
  const revoke = () => { if (reached) return; owned = false; reached = true; writesAtRevocation = server.requests.length; };
  server.paginatedResume = boundary === "resume-retry";
  server.on("client-request", message => { if (message.method === boundary || boundary === "resume-retry" && message.method === "thread/resume") revoke(); });
  const restore: Array<() => void> = [];
  if (boundary === "publication") {
    const original = publicationSource.repositoryPublicationSource;
    const wrapped = spyOn(publicationSource, "repositoryPublicationSource").mockImplementation(async (...args) => {
      const result = await original(...args); revoke(); return result;
    });
    restore.push(() => wrapped.mockRestore());
  }
  if (boundary === "telegram") {
    const original = telegramLaunch.resolveTelegramLaunchGrant;
    const wrapped = spyOn(telegramLaunch, "resolveTelegramLaunchGrant").mockImplementation(async (...args) => {
      const result = await original(...args); revoke(); return result;
    });
    restore.push(() => wrapped.mockRestore());
  }
  let host: CodexAppServerHost | undefined;
  try {
    const opening = CodexAppServerHost.adopt("adoption-authority", { cwd: metadataState, cleanMemory: true,
      readProtocolVersion: () => { if (boundary === "protocol") revoke(); return "0.162.1"; },
      assertCurrent: () => { if (!owned) throw new Error("adoption authority revoked"); },
      eventStore: new MemoryEventStore(), spawnProcess: (...args) => { spawns++; return fakeSpawn(server)(...args); },
    });
    if (boundary === "allowed") { host = await opening; expect(spawns).toBe(1); }
    else {
      await expect(opening).rejects.toThrow("adoption authority revoked");
      expect(reached).toBe(true);
      expect(spawns).toBe(["protocol", "publication", "telegram"].includes(boundary) ? 0 : 1);
      expect(server.requests).toHaveLength(writesAtRevocation);
    }
  } finally { for (const undo of restore.reverse()) undo(); await host?.release(); }
});

test.skipIf(process.platform !== "linux").each([false, true])("socket preparation rechecks launch authority after the drain wait (revoked=%s)", async revoked => {
  const previousHome = process.env.HOME;
  const directory = fs.openSync(metadataState, fs.constants.O_RDONLY);
  process.env.HOME = `/proc/${process.pid}/fd/${directory}`;
  let owned = true, reached = false, spawns = 0;
  const open = fs.openSync;
  const opening = spyOn(fs, "openSync").mockImplementation((file, ...args) => {
    const result = open(file, ...args);
    if (String(file).endsWith("startup.fifo")) { reached = true; if (revoked) owned = false; }
    return result;
  });
  try {
    await expect(CodexAppServerHost.adopt("socket-authority", { cwd: metadataState, cleanMemory: true,
      persistentCallbacks: true, readProtocolVersion: () => "0.162.1",
      assertCurrent: () => { if (!owned) throw new Error("socket authority revoked"); },
      spawnProcess: () => { spawns++; throw new Error("fixture native spawn boundary"); },
    })).rejects.toThrow(revoked ? "socket authority revoked" : "fixture native spawn boundary");
    expect(reached).toBe(true);
    expect(spawns).toBe(revoked ? 0 : 1);
  } finally {
    opening.mockRestore();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    fs.closeSync(directory);
  }
});

test("mocked structured host keeps launch admission out of the installed CLI prefix", async () => {
  const original = fs.mkdirSync, updaterDirectories: string[] = [];
  const mkdir = spyOn(fs, "mkdirSync").mockImplementation((directory, options) => {
    if (path.basename(String(directory)) === ".delegatus-codex") updaterDirectories.push(String(directory));
    return original(directory, options);
  });
  const server = new FakeAppServer("private-launch-binary");
  try {
    const host = await CodexAppServerHost.start({ cwd: "/repo", readProtocolVersion: () => "0.162.1", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
    await host.release();
    expect(updaterDirectories).toEqual([]);
  } finally { mkdir.mockRestore(); }
});

test("rejects a command approval with the wrong decision before writing to Codex", async () => {
  const server = new FakeAppServer("typed-approval");
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
  try {
    server.request("typed-request", "item/commandExecution/requestApproval", { command: "echo approval" });
    const attention = (await host.health()).pendingAttention[0]!;
    const writes = server.requests.length;
    await expect(host.answer(attention, { decision: "approved" })).rejects.toThrow("decision");
    expect(server.requests).toHaveLength(writes);
    expect((await host.health()).pendingAttention).toEqual([attention]);
    await host.answer(attention, { decision: "accept" });
  } finally { await host.release(); }
});

test("negotiates provider and per-model capabilities independently of userAgent", async () => {
  const server = new FakeAppServer("capability-receipt");
  server.userAgent = "opaque future client identifier";
  server.modelList = [
    { id: "text-model", model: "text-model", isDefault: true, inputModalities: ["text"] },
    { id: "image-model", model: "image-model", isDefault: false, inputModalities: ["text", "image"] },
  ];
  const host = await CodexAppServerHost.start({ cwd: "/repo", readProtocolVersion: () => "0.159.0", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server), resolveImagePath: () => "/runtime-images/image.png" });
  try {
    expect((await host.health()).diagnostics?.protocol).toMatchObject({
      schemaVersion: "0.159.0", experimentalApi: true, provider: { webSearch: true, imageGeneration: false },
      models: [{ id: "text-model", inputModalities: ["text"] }, { id: "image-model", inputModalities: ["text", "image"] }],
    });
    const image = { sha256: "a".repeat(64), mime: "image/png" as const, bytes: 67 };
    await expect(host.send({ id: "text-image", text: "inspect", images: [image], runtime: { model: "text-model" } })).rejects.toThrow("does not advertise image input");
    expect(await host.send({ id: "switched-image", text: "inspect", images: [image], runtime: { model: "image-model" } })).toMatchObject({ outcome: "turn-started" });
    expect(await host.send({ id: "inherited-image", text: "inspect again", images: [image], expectedTurnId: "turn-1" })).toMatchObject({ outcome: "steered" });
    server.notify("model/rerouted", { threadId: "capability-receipt", turnId: "turn-1", fromModel: "image-model", toModel: "text-model", reason: "highRiskCyberActivity" });
    await expect(host.send({ id: "steer-cannot-switch-model", text: "inspect", images: [image], expectedTurnId: "turn-1", runtime: { model: "image-model" } })).rejects.toThrow("does not advertise image input");
  } finally { await host.release(); }
});

test.skipIf(process.platform !== "linux").each([false, true])("a second recorded check returns its verdict while the same turn already holds a wait (turn ends=%s)", async turnEnds => {
  const server = new FakeAppServer("overlapping-gates");
  const host = await CodexAppServerHost.start({ cwd: metadataState, env: { ...process.env, TMPDIR: metadataState },
    eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
  let child: ReturnType<typeof spawn> | undefined;
  const reply = (id: string) => new Promise<Record<string, unknown>>(resolve => {
    const listener = (message: Record<string, unknown>) => {
      if (message.id === id) { server.off("client-request", listener); resolve(message); }
    };
    server.on("client-request", listener);
  });
  const call = (id: string, log: string, turnId = "turn-1") => server.request(id, "item/tool/call", {
    threadId: "overlapping-gates", turnId, callId: id, tool: gateCheckTool.name, arguments: { log, reason: "overlapping check" },
  });
  try {
    await host.send({ id: "opening", text: "check both results" });
    const firstLog = path.join(metadataState, "first.log"), firstDir = `${firstLog}.gate`;
    fs.mkdirSync(firstDir); fs.writeFileSync(firstLog, "first check\n");
    const recorder = cpuOwnerIdentity(process.pid);
    fs.writeFileSync(path.join(firstDir, "owner.json"), JSON.stringify(recorder));
    fs.writeFileSync(path.join(firstDir, "completion.json"), JSON.stringify({ recorder, directoryIdentity: physical(firstDir), deadlineUptimeMs: custodyClock() + 60_000 }));
    const firstReply = reply("first-wait");
    call("first-wait", firstLog);
    expect(server.requests.filter(row => row.id === "first-wait")).toHaveLength(0);

    // Run the actual recorder in its own private portable gate. The first
    // callback stays pending throughout this command's start and completion.
    const bin = path.join(metadataState, "bin"); fs.mkdirSync(bin);
    for (const name of ["bash", "date", "mkdir", "flock", "sleep", "dirname", "mktemp", "touch", "rm", "which", "true"])
      fs.symlinkSync(`/usr/bin/${name}`, path.join(bin, name));
    const log = path.join(metadataState, "second.log");
    child = spawn("/bin/bash", [path.resolve(import.meta.dir, "../../../scripts/gate-slot.sh"), "--record", log,
      "/bin/bash", "-c", 'printf "second verdict\\n"; exit 23'], { stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: bin, HOME: metadataState, TMPDIR: metadataState, XDG_CONFIG_HOME: metadataState, LLV_STATE_DIR: metadataState,
      NODE_ENV: "test", LLV_GATE_BUN: process.execPath, LLV_GATE_LOCK_DIR: metadataState, LLV_GATE_SLOTS: "1",
      LLV_GATE_RUNNER: "off", DELEGATUS_CPU_PRESSURE: "off", DELEGATUS_AGENT_CPU: "off",
    } });
    let output = "";
    child.stdout!.on("data", data => { output += data; });
    child.stderr!.on("data", data => { output += data; });
    const code = await new Promise<number | null>((resolve, reject) => { child!.once("error", reject); child!.once("close", resolve); });
    expect(output).toContain("recording started");
    expect(code).toBe(23);
    const secondReply = reply("second-wait");
    call("second-wait", log);
    expect((await secondReply).result).toMatchObject({ success: true, contentItems: [{ text: expect.stringContaining('"code":23') }] });
    expect(server.requests.filter(row => row.id === "first-wait")).toHaveLength(0);

    const foreignReply = reply("foreign-wait");
    call("foreign-wait", log, "foreign-turn");
    expect((await foreignReply).result).toMatchObject({ success: false });
    if (turnEnds) server.notify("turn/completed", { threadId: "overlapping-gates", turn: { id: "turn-1", status: "completed" } });
    fs.writeFileSync(path.join(firstDir, "exit"), "37\n");
    expect((await firstReply).result).toMatchObject(turnEnds
      ? { success: false, contentItems: [{ text: expect.stringContaining("gate wait owner changed; result unknown") }] }
      : { success: true, contentItems: [{ text: expect.stringContaining('"code":37') }] });
    expect((await host.health()).pendingAttention).toEqual([]);
  } finally { if (child) await stopFixtureProcess(child); await host.release(); }
}, 30_000);

test.each(["0.162.7", "0.165.0", "0.166.0", "0.167.0", "0.168.0", "0.169.0", "0.170.0", "0.170.1"])("compatible CLI %s reaches thread/start and turn/start under its reviewed pin", async version => {
  // Exact pins load their own schema; other CLIs stand on a newer real schema above their pin.
  const unpinned: Record<string, { pin: string; schema: string }> = { "0.162.7": { pin: "0.162.1", schema: "0.163.0" }, "0.170.1": { pin: "0.170.0", schema: "0.170.0" } };
  const pin = unpinned[version]?.pin ?? version;
  const schemaVersion = unpinned[version]?.schema ?? version;
  const server = new FakeAppServer("unpinned-cli");
  if (version === "0.170.1") server.threadResponseExtra = { futureHint: "available" };
  const schemas = (name: string) => {
    const raw = fs.readFileSync(path.join(import.meta.dir, `../accounts/protocol/${schemaVersion}`, `${name}.json`), "utf8");
    if (version !== "0.170.1") return raw;
    const bundle = JSON.parse(raw);
    bundle.definitions.v2.ThreadStartResponse.properties.futureHint = { type: ["string", "null"] };
    return JSON.stringify(bundle);
  };
  const generated: string[] = [];
  const writes = spyOn(server.stdout, "write");
  let host: CodexAppServerHost | undefined;
  try {
    host = await CodexAppServerHost.start({
      cwd: "/repo", binary: "codex-fixture", readProtocolVersion: () => version, eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server),
      generateProtocolSchemas: async binary => { generated.push(binary); return { stable: schemas("stable"), experimental: schemas("experimental") }; },
    });
    const health = await host.health();
    // The registry keeps the pin, so a successor reconnects under the same reviewed contract.
    expect(health.protocolVersion).toBe(pin);
    expect(health.diagnostics?.version).toBe(version);
    expect(health.diagnostics?.protocol).toMatchObject({ schemaVersion: pin });
    if (version === pin) {
      expect(health.diagnostics?.protocol).not.toHaveProperty("unpinnedCli");
      expect(generated).toEqual([]);
    } else {
      expect(health.diagnostics?.protocol?.unpinnedCli).toEqual({
        cliVersion: version, cliSchemaDigest: createHash("sha256").update(schemas("experimental")).digest("hex"),
      });
      expect(generated).toEqual(["codex-fixture"]);
    }
    expect(await host.send({ id: "unpinned-turn", text: "continue" })).toMatchObject({ outcome: "turn-started" });
    if (version === "0.170.1") {
      expect(writes.mock.calls.some(([chunk]) => JSON.parse(String(chunk)).result?.futureHint === "available")).toBeTrue();
    }
  } finally {
    try { await host?.release(); } finally { writes.mockRestore(); }
  }
});

test("a self-updated CLI with a breaking schema is refused before spawning", async () => {
  const server = new FakeAppServer("breaking-cli");
  let spawned = false;
  await expect(CodexAppServerHost.start({
    cwd: "/repo", readProtocolVersion: () => "0.162.8", eventStore: new MemoryEventStore(),
    spawnProcess: (...args) => { spawned = true; return fakeSpawn(server)(...args); },
    generateProtocolSchemas: async () => ({ stable: '{"definitions":{}}', experimental: '{"definitions":{}}' }),
  })).rejects.toThrow("CLI 0.162.8; Supported: 0.170.0, 0.169.0, 0.168.0; cause: not an additive extension of pin 0.162.1");
  expect(spawned).toBe(false);
});

test("quarantines unknown notifications and late responses without killing a healthy host", async () => {
  const server = new FakeAppServer("protocol-anomaly");
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
  try {
    server.notify("future/notification", { threadId: "protocol-anomaly" });
    server.stdout.write(JSON.stringify({ id: "unknown-string-id", result: {} }) + "\n");
    server.stdout.write(JSON.stringify({ id: 99999, result: {} }) + "\n");
    expect((await host.health()).diagnostics?.protocol?.anomalies).toBe(3);
    expect(await host.send({ id: "still-healthy", text: "continue" })).toMatchObject({ outcome: "turn-started" });
    server.request("future-request", "future/requestApproval", {});
    const attention = (await host.health()).pendingAttention[0]!;
    await expect(host.answer(attention, {})).rejects.toThrow("raw answers are disabled");
  } finally { await host.release(); }
});

test("model negotiation preserves a reroute received before the turn-start reply", async () => {
  const threadId = "early-model-route";
  const server = modelNegotiationServer(threadId);
  server.beforeTurnStartReply = turnId => server.notify("model/rerouted", { threadId, turnId, fromModel: "image-model", toModel: "text-model", reason: "highRiskCyberActivity" });
  const host = await CodexAppServerHost.start({ cwd: "/repo", model: "text-model", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server), resolveImagePath: () => "/runtime-images/image.png" });
  try {
    await host.send({ id: "first", text: "inspect", images: [MODEL_NEGOTIATION_IMAGE], runtime: { model: "image-model" } });
    await expect(host.send({ id: "second", text: "inspect again", images: [MODEL_NEGOTIATION_IMAGE], expectedTurnId: "turn-1" })).rejects.toThrow("does not advertise image input");
  } finally { await host.release(); }
});

test("model negotiation retains the protocol's model override for subsequent turns", async () => {
  const threadId = "default-model-route";
  const server = modelNegotiationServer(threadId);
  const host = await CodexAppServerHost.start({ cwd: "/repo", model: "text-model", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server), resolveImagePath: () => "/runtime-images/image.png" });
  try {
    await host.send({ id: "first", text: "inspect", runtime: { model: "image-model" } });
    server.notify("turn/completed", { threadId, turn: { id: "turn-1", status: "completed" } });
    await expect(host.send({ id: "default-image", text: "inspect again", images: [MODEL_NEGOTIATION_IMAGE] })).resolves.toMatchObject({ outcome: "turn-started" });
  } finally { await host.release(); }
});

for (const resumed of [false, true]) test(`model negotiation uses the ${resumed ? "resumed" : "new"} thread's selected-model receipt`, async () => {
  const threadId = "thread-model-receipt";
  const server = modelNegotiationServer(threadId, "image-model");
  server.threadModel = "text-model";
  const options = { cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server), resolveImagePath: () => "/runtime-images/image.png" };
  const host = resumed ? await CodexAppServerHost.adopt(threadId, options) : await CodexAppServerHost.start(options);
  try {
    expect((await host.health()).activeFlags).not.toContain("structured-image-v1");
    await expect(host.send({ id: "image", text: "inspect", images: [MODEL_NEGOTIATION_IMAGE] })).rejects.toThrow("does not advertise image input");
  } finally { await host.release(); }
});

test("model negotiation ignores a completed turn's late reroute during a newer turn", async () => {
  const threadId = "late-model-route";
  const server = modelNegotiationServer(threadId, "image-model");
  const host = await CodexAppServerHost.start({ cwd: "/repo", model: "image-model", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server), resolveImagePath: () => "/runtime-images/image.png" });
  try {
    await host.send({ id: "first", text: "inspect" });
    server.notify("turn/completed", { threadId, turn: { id: "turn-1", status: "completed" } });
    await host.send({ id: "second", text: "inspect again" });
    server.notify("model/rerouted", { threadId, turnId: "turn-1", fromModel: "image-model", toModel: "text-model", reason: "highRiskCyberActivity" });
    await expect(host.send({ id: "current-image", text: "inspect", images: [MODEL_NEGOTIATION_IMAGE], expectedTurnId: "turn-2" })).resolves.toMatchObject({ outcome: "steered" });
  } finally { await host.release(); }
});

test("bounds the capability receipt before publishing it into a journal event", async () => {
  const server = new FakeAppServer("bounded-receipt");
  server.modelList = Array.from({ length: 100 }, (_, index) => ({ id: `model-${index}-${"x".repeat(180)}`, inputModalities: ["text", "image", "audio"], isDefault: index === 0 }));
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
  try {
    const receipt = (await host.health()).diagnostics?.protocol;
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(4096);
    expect(receipt?.modelsTruncated).toBe(true);
  } finally { await host.release(); }
});

test("keeps simultaneous string and numeric approval IDs distinct", async () => {
  const server = new FakeAppServer("typed-ids");
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
  try {
    server.request(42, "item/commandExecution/requestApproval", { command: "echo numeric" });
    server.request("42", "item/commandExecution/requestApproval", { command: "echo string" });
    const pending = (await host.health()).pendingAttention;
    expect(pending).toHaveLength(2);
    await host.answer(pending[0]!, { decision: "accept" });
    expect((await host.health()).pendingAttention).toEqual([pending[1]!]);
    await host.answer(pending[1]!, { decision: "decline" });
    expect(server.requests.filter(request => "result" in request).map(request => request.id)).toEqual([42, "42"]);
  } finally { await host.release(); }
});

test("read-only structured hosts receive one writable isolated scratch root", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-read-only-scratch-test-"));
  const stateDirectory = path.join(directory, "state");
  const previousStateDirectory = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = stateDirectory;
  try {
    const access = materializeStructuredHostAccess(
      true,
      {
        NODE_ENV: "test",
        HOME: "/shared/home",
        XDG_CONFIG_HOME: "/shared/config",
        XDG_CACHE_HOME: "/shared/cache",
        TMPDIR: "/container-private/tmp",
      },
      "capability",
    );

    expect(access.env).toMatchObject({
      NODE_ENV: "test",
      LLV_SPAWN_CAPABILITY: "capability",
      HOME: "/shared/home",
      XDG_CONFIG_HOME: "/shared/config",
      XDG_CACHE_HOME: "/shared/cache",
      TMPDIR: path.join(access.scratchDirectory!, "tmp"),
      GH_CONFIG_DIR: "/shared/config/gh",
    });
    expect(path.dirname(access.scratchDirectory!)).toBe(path.join(stateDirectory, "scratch"));
    expect(access.scratchDirectory!.startsWith(`${stateDirectory}${path.sep}`)).toBeTrue();
    expect(access.codex).toEqual({
      permissionProfile: READ_ONLY_STAGE_PERMISSION_PROFILE,
      permissionProfileConfig: `permissions.${READ_ONLY_STAGE_PERMISSION_PROFILE}={extends=":read-only",filesystem={${JSON.stringify(access.scratchDirectory)}="write",${JSON.stringify(access.env.LLV_EVIDENCE_DIR)}="write"}}`,
    });
    expect(access.host).toEqual({
      forwardGitHubConfig: true,
      releaseCleanup: expect.any(Function),
    });
    expect(fs.statSync(access.scratchDirectory!).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(access.scratchDirectory!, "tmp")).mode & 0o777).toBe(0o700);

    access.cleanup();
    expect(fs.existsSync(access.scratchDirectory!)).toBeFalse();

    const sourceEnv: NodeJS.ProcessEnv = { NODE_ENV: "test", HOME: "/shared/home", TMPDIR: "/original/tmp" };
    const readWrite = materializeStructuredHostAccess(false, sourceEnv, "capability", directory);
    expect(readWrite).toMatchObject({
      env: { ...sourceEnv, TMPDIR: path.join(readWrite.scratchDirectory!, "tmp"), LLV_SPAWN_CAPABILITY: "capability" },
      codex: { sandbox: "danger-full-access" },
      scratchDirectory: expect.any(String),
    });
    readWrite.cleanup();
  } finally {
    if (previousStateDirectory === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousStateDirectory;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fresh and adopted app-server hosts enforce native delegation with Telegram connected or left out", async () => {
  for (const connected of [false, true]) for (const allowed of [false, true]) for (const resumed of [false, true]) {
    clearTelegramConnection();
    const session = connected ? saveTelegramSession("placeholder-session-for-policy-grant-test") : null;
    if (session) writeTelegramConnection({ version: 1, status: "connected", credentialRef: session.credentialRef,
      identity: null, lastHealthCheckAt: null, errorCode: null, identityIdUpgradedAt: null });
    const server = new FakeAppServer("policy-thread");
    server.features = { memory_tool: true, telepathy: true, connectors: true, unlisted_worker: true };
    server.mcpServers.telegram = { url: "http://127.0.0.1:8809/mcp", enabled: true };
    const captured: { args?: string[]; options?: SpawnOptionsWithoutStdio } = {};
    const options = { cwd: "/repo", allowSubagents: allowed, mcpServers: ["viewer", "telegram"],
      env: { NODE_ENV: "test" as const, [TELEGRAM_CONNECTOR_TOKEN_ENV]: "B".repeat(43) },
      eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server, captured) };
    const host = resumed ? await CodexAppServerHost.adopt("policy-thread", options) : await CodexAppServerHost.start(options);
    try {
      expect(captured.args).toContain(`agents.enabled=${allowed}`);
      expect(captured.args).toContain("features.hooks=true");
      expect(captured.args?.some(arg => arg.startsWith("hooks.PreToolUse=["))).toBe(true);
      expect(captured.args?.includes('approvals_reviewer="user"')).toBe(!allowed);
      const params = server.requests.find((request) => request.method === (resumed ? "thread/resume" : "thread/start"))?.params as Record<string, unknown> | undefined;
      const config = params?.config;
      const cleanup = config as { features: { hooks: boolean }; hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
      expect(cleanup.features.hooks).toBe(true);
      expect(cleanup.hooks.PreToolUse[0].hooks[0].command.startsWith("LLV_MANAGED_PROCESS_CLEANUP_DENY=1 ")).toBe(true);
      expect(config).toMatchObject({ agents: { enabled: allowed }, features: { multi_agent: allowed },
        mcp_servers: { viewer: { enabled: true }, telegram: { enabled: connected } } });
      expect(captured.options?.env?.[TELEGRAM_CONNECTOR_TOKEN_ENV]).toBe(session?.connectorToken);
      if (!connected) {
        if (resumed) expect(JSON.stringify(server.requests.find(request => request.method === "thread/inject_items")?.params)).toContain(TELEGRAM_UNAVAILABLE_THIS_RUN_NOTICE);
        else expect(params?.developerInstructions).toBe(TELEGRAM_UNAVAILABLE_THIS_RUN_NOTICE);
      }
      if (!allowed) {
        expect(config).toMatchObject({ approvals_reviewer: "user" });
        expect(config).toMatchObject({ features: { memory_tool: false, telepathy: false, connectors: false, unlisted_worker: false } });
        expect(params).toMatchObject({ approvalsReviewer: "user" });
      } else {
        expect(config).not.toHaveProperty("approvals_reviewer");
        expect(params).not.toHaveProperty("approvalsReviewer");
      }
      for (const feature of ["multi_agent_v2", "future_worker"]) {
        expect(captured.args?.includes(`features.${feature}=false`)).toBe(!allowed);
        if (!allowed) expect(config).toMatchObject({ features: { [feature]: false } });
      }
    } finally { await host.release(); }
  }
});

test("failed app-server feature discovery releases scratch and never starts a host", async () => {
  const restore = setCodexFeatureReaderForTest(() => { throw new Error("fixture inventory failure"); });
  let launches = 0;
  let releases = 0;
  try {
    await expect(CodexAppServerHost.start({ cwd: "/repo", releaseCleanup: () => { releases += 1; }, spawnProcess: () => { launches += 1; throw new Error("must not spawn"); } })).rejects.toThrow("fixture inventory failure");
    expect(launches).toBe(0);
    expect(releases).toBe(1);
  } finally { restore(); }
});

test("native Guardian review notifications enter the durable ledger without action contents", async () => {
  const server = new FakeAppServer("guardian-policy-thread");
  const eventStore = new MemoryEventStore();
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore, spawnProcess: fakeSpawn(server) });
  try {
    for (const threadId of ["another-thread", "guardian-policy-thread"]) {
      for (const phase of ["started", "completed"]) server.notify(`item/autoApprovalReview/${phase}`, {
        threadId, turnId: "guardian-policy-turn", reviewId: "guardian-review-fixture",
        action: "PRIVATE GUARDIAN ACTION", review: { status: "inProgress" }, startedAtMs: 0,
      });
    }
    const items = eventStore.load("guardian-policy-thread").filter((event) => event.kind === "item");
    expect(items).toMatchObject([
      { phase: "started", item: { type: "autoApprovalReview", id: "guardian-review-fixture" } },
      { phase: "completed", item: { type: "autoApprovalReview", id: "guardian-review-fixture" } },
    ]);
    expect(JSON.stringify(items)).not.toContain("PRIVATE GUARDIAN ACTION");
  } finally { await host.release(); }
});

test("adopted native history respects pre-admission and allowed times while denied activity alerts", async () => {
  const threadId = randomUUID();
  const artifactPath = path.join(metadataState, `rollout-${threadId}.jsonl`);
  const registry = new AgentRegistry(path.join(metadataState, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  function admit(allowSubagents: boolean) {
    const launchProfile = emptyLaunchProfile({ cwd: metadataState, title: "Exercise native history admission", allowSubagents });
    const begun = registry.beginSpawnRequest({ engine: "codex", cwd: metadataState, origin: { kind: "operator" }, launchProfile });
    if (begun.kind !== "created") throw new Error("expected launch receipt");
    const settled = registry.settleSpawn(begun.receipt.launchId, { key: { engine: "codex", sessionId: threadId },
      artifactPath, cwd: metadataState, accountId: null, launchProfile, status: "live", host: null,
      claimEpoch: 0, claimOwner: null, pendingAction: null });
    if (settled.kind !== "settled") throw new Error("expected settled launch");
    return settled.conversation;
  }
  admit(true);
  const allowedAt = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const conversation = admit(false);
  const deniedAt = new Date().toISOString();
  const history = [
    { id: "pre-admission", at: "2000-01-01T00:00:00.000Z" },
    { id: "allowed-history", at: allowedAt },
    { id: "denied-history", at: deniedAt },
  ];
  fs.writeFileSync(artifactPath, history.map(({ id, at }) => JSON.stringify({ timestamp: at, type: "response_item",
    payload: { type: "function_call", namespace: "multi_agent_v1", name: "spawn_agent", call_id: id, arguments: "{}" } })).join("\n") + "\n");
  const native = (id: string) => ({ type: "collabAgentToolCall", id, tool: "spawnAgent", prompt: "PRIVATE NATIVE CONTENT" });
  const store = new FileRuntimeEventStore(path.join(metadataState, "events"));
  // Older durable ledgers had no activity timestamp.
  store.append(threadId, { kind: "item", turnId: "history-turn", item: native("pre-admission"), phase: "completed", seq: 1 });
  // Timestamped durable items must retain their original permission interval.
  store.append(threadId, { kind: "item", turnId: "history-turn", item: native("allowed-ledger"), phase: "completed", seq: 2,
    activityAt: allowedAt });
  const server = new FakeAppServer(threadId, threadId, false, [{ id: "history-turn", status: "completed",
    items: [...history.map(({ id }) => native(id)), native("unknown-history")] }], { type: "idle" });
  const host = await CodexAppServerHost.adopt(threadId, { cwd: metadataState, allowSubagents: false,
    eventStore: store, spawnProcess: fakeSpawn(server) });
  const reader = host.attach(0)[Symbol.asyncIterator]();
  try {
    for (let remaining = store.load(threadId).length; remaining > 0; remaining--) {
      const next = await reader.next();
      if (!next.done) observeCodexSubagentEvent(registry, artifactPath, next.value);
    }
    const replayed = queryLifecycleEvents({ conversationId: conversation.id }).events;
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.id).toBe(lifecycleEventId(`codex-subagent-policy:${conversation.id}`));
    server.notify("item/completed", { threadId, turnId: "current-turn", item: native("current-denied") });
    const current = await reader.next();
    expect(current.done).toBeFalse();
    if (!current.done) {
      observeCodexSubagentEvent(registry, artifactPath, current.value);
      observeCodexSubagentEvent(registry, artifactPath, current.value);
      expect(current.value).toMatchObject({ kind: "item", activityAt: expect.any(String), item: { id: "current-denied", type: "collabAgentToolCall" } });
    }
    const events = queryLifecycleEvents({ conversationId: conversation.id }).events;
    expect(events).toHaveLength(1);
    expect(events[0]?.at).toBe(deniedAt);
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
  } finally { await reader.return?.(); await host.release(); }
});

test("Codex refuses fresh and adopted launches with missing or empty Viewer tools before queue recovery", async () => {
  for (const resume of [false, true]) for (const status of [[], [{ name: "viewer", tools: {} }]]) {
    const child = new FakeAppServer();
    child.viewerStatus = status;
    const options = { cwd: "/repo", readProtocolVersion: () => "0.162.1", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(child) };
    let host: CodexAppServerHost | null = null;
    const error = await (resume ? CodexAppServerHost.adopt("thread-149", options) : CodexAppServerHost.start(options))
      .then(value => { host = value; return null; }, reason => reason);
    try {
      expect(String(error)).toContain("Viewer MCP launch failed");
      expect(child.requests.some(request => request.method === "thread/queue/start" || request.method === "turn/start")).toBe(false);
    } finally { if (host) await (host as CodexAppServerHost).release(); }
  }
});

test("Codex rejects its failed Viewer runtime status even with a cached catalog and retains toolsError", async () => {
  const cases = [
    { name: "viewer", runtimeStatus: "failed", tools: { stage_report: {} }, toolsError: null },
    { name: "viewer", runtimeStatus: "failed", tools: {}, toolsError: "Viewer release target is missing" },
  ];
  for (const viewer of cases) {
    const child = new FakeAppServer();
    child.viewerStatus = [viewer];
    const outcome = await CodexAppServerHost.start({ cwd: "/repo", readProtocolVersion: () => "0.162.1",
      eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(child) }).then(
      value => ({ host: value, error: null as unknown }), reason => ({ host: null, error: reason as unknown }));
    try {
      expect(String(outcome.error)).toContain("Viewer MCP launch failed");
      expect(String(outcome.error)).toContain(viewer.toolsError ?? "failed");
      expect(child.requests.some(request => request.method === "thread/queue/start" || request.method === "turn/start")).toBe(false);
    } finally { if (outcome.host) await outcome.host.release(); }
  }
});

test("Codex admits a cached Viewer catalog while its runtime connection is starting", async () => {
  const child = new FakeAppServer();
  child.viewerStatus = [{ name: "viewer", runtimeStatus: "starting", tools: { stage_report: {} }, toolsError: null }];
  const host = await CodexAppServerHost.start({ cwd: "/repo", readProtocolVersion: () => "0.162.1",
    eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(child) });
  try {
    expect((await host.health()).status).toBe("idle");
    expect(child.requests.some(request => request.method === "thread/queue/start" || request.method === "turn/start")).toBe(false);
  } finally { await host.release(); }
});

test("Codex verifies Viewer tools from the opened thread", async () => {
  const child = new FakeAppServer();
  child.requireViewerThread = true;
  child.viewerStatus = [{ name: "viewer", tools: {} }];
  let host: CodexAppServerHost | null = null;
  const error = await CodexAppServerHost.start({ cwd: "/repo", readProtocolVersion: () => "0.162.1",
    eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(child) })
    .then(value => { host = value; return null; }, reason => reason);
  try { expect(String(error)).toContain("viewer has no tools"); }
  finally { if (host) await (host as CodexAppServerHost).release(); }
});

test.each([false, true])("skills policy reaches fresh and resumed Codex threads (omit=%s)", async (omitSkillsInstructions) => {
  for (const resumed of [false, true]) {
    const server = new FakeAppServer();
    const options = { cwd: "/repo", omitSkillsInstructions,
      eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) };
    const host = resumed ? await CodexAppServerHost.adopt("thread-149", options) : await CodexAppServerHost.start(options);
    try {
      const params = server.requests.find(request => request.method === (resumed ? "thread/resume" : "thread/start"))!.params as { config: Record<string, unknown> };
      expect(params.config.skills).toEqual(omitSkillsInstructions ? { include_instructions: false } : undefined);
    } finally { await host.release(); }
  }
});

for (const stdioViewer of [false, true])
test.each([false, true])(`socket resume restores the delegated skills decision (stdio=${stdioViewer}, omitted=%s)`, async (omitSkillsInstructions) => {
  const server = new FakeAppServer();
  server.mcpServers = stdioViewer ? { viewer: { command: "fixture-viewer" } } : {};
  const reconnect = spyOn(CodexSocketTransport, "reconnect").mockResolvedValue(server as unknown as CodexSocketTransport);
  let host: CodexAppServerHost | undefined;
  try {
    host = await CodexAppServerHost.adopt("thread-149", { cwd: "/repo", omitSkillsInstructions,
      socketOwner: { endpoint: "codex-unix:/fixture/rpc.sock", process: { pid: 4242, startIdentity: "fixture" } },
      readProtocolVersion: () => "0.162.1", spawnProcess: fakeSpawn(server), eventStore: new MemoryEventStore() });
    const params = server.requests.find(request => request.method === "thread/resume")!.params as Record<string, unknown>;
    const config = params.config as Record<string, unknown> | undefined;
    expect(Object.keys(params).sort()).toEqual(stdioViewer || omitSkillsInstructions ? ["config", "threadId"] : ["threadId"]);
    expect(Object.keys(config ?? {}).sort()).toEqual([
      ...(stdioViewer ? ["mcp_servers"] : []), ...(omitSkillsInstructions ? ["skills"] : []),
    ]);
    expect(config?.skills).toEqual(omitSkillsInstructions ? { include_instructions: false } : undefined);
    if (stdioViewer) expect(config?.mcp_servers).toMatchObject({ viewer: { command: "fixture-viewer" } });
  } finally { await host?.release(); reconnect.mockRestore(); }
});

test("Codex drains resume notifications before awaiting Viewer discovery", async () => {
  const child = new FakeAppServer();
  child.beforeViewerStatus = () => {
    for (let frame = 0; frame < 20; frame++) child.notify("thread/status/changed", {
      threadId: "thread-149", status: { type: "idle", activeFlags: [] }, padding: "x".repeat(256 * 1024),
    });
  };
  const host = await CodexAppServerHost.adopt("thread-149", { cwd: "/repo", readProtocolVersion: () => "0.162.1",
    eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(child) });
  try {
    expect((await host.health()).status).toBe("idle");
    expect(child.requests.some(request => request.method === "turn/start" || request.method === "thread/queue/start")).toBe(false);
  } finally { await host.release(); }
});

test.skipIf(process.platform === "win32")("a replaced startup adapter disconnects without signalling the native Codex listener", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-"));
  fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, "rpc.sock");
  const child = new FakeAppServer();
  const signals: NodeJS.Signals[] = [];
  const disconnected = Promise.withResolvers<void>();
  const listener = Bun.serve({
    unix: socket,
    fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
    websocket: {
      open(connection) { child.stdout.on("data", chunk => { connection.send(String(chunk).trimEnd()); }); },
      message(_connection, message) { child.stdin.write(String(message) + "\n"); },
      close() { disconnected.resolve(); },
    },
  });
  fs.chmodSync(socket, 0o600);
  let host: CodexAppServerHost | undefined;
  try {
    host = await CodexAppServerHost.adopt("thread-149", {
      cwd: directory, eventStore: new MemoryEventStore(),
      socketOwner: { endpoint: `codex-unix:${socket}`, process: captureProcessIdentity(process.pid) },
      signalProcess: (_pid, signal) => { signals.push(signal); },
      shutdownGraceMs: 25,
    });
    host.setWriterFence(() => false);
    host.detachAfterStartupCustodyLoss();
    await host.release();
    await disconnected.promise;
    expect(signals).toEqual([]);
    expect(fs.statSync(socket).isSocket()).toBe(true);
  } finally {
    listener.stop(true);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
