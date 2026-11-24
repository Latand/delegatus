import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { antigravityModelCatalog } from "@/lib/agent/antigravityModels";
import { VIEWER_SPAWN_CAPABILITY_ENV, VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import {
  antigravityChildEnv,
  antigravityLaunchArgs,
  antigravityMcpServers,
  antigravityNativeHome,
  antigravityTranscriptPath,
  AntigravityAcpHost,
  validateAntigravitySessionId,
  type AntigravityAcpHostOptions,
} from "./antigravityAcpHost";
import type { DeliveryReceipt } from "./engineHost";
import { FileRuntimeEventStore } from "./eventStore";

interface ScriptedAcpServer {
  child: ChildProcessWithoutNullStreams;
  received: Array<Record<string, unknown>>;
  sendToHost(message: Record<string, unknown>): void;
  closeChild(code?: number): void;
  signals: Array<NodeJS.Signals | number>;
}

function makeFakeAcpChild(
  onClientMessage: (msg: Record<string, unknown>, api: ScriptedAcpServer) => void,
  pid = 424242,
): ScriptedAcpServer {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const received: Array<Record<string, unknown>> = [];
  const signals: Array<NodeJS.Signals | number> = [];
  let closed = false;

  const child = Object.assign(emitter, {
    pid,
    stdin,
    stdout,
    stderr,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    kill(signal?: NodeJS.Signals | number) {
      signals.push(signal ?? "SIGTERM");
      closeChild(0);
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;

  const sendToHost = (message: Record<string, unknown>) => {
    if (!closed) stdout.write(`${JSON.stringify(message)}\n`);
  };

  const closeChild = (code = 0) => {
    if (closed) return;
    closed = true;
    (child as unknown as { exitCode: number }).exitCode = code;
    stdout.end();
    stderr.end();
    emitter.emit("exit", code, null);
    emitter.emit("close", code, null);
  };

  const api: ScriptedAcpServer = { child, received, sendToHost, closeChild, signals };
  let buf = "";
  stdin.on("data", (chunk: Buffer | string) => {
    buf += chunk.toString();
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        received.push(parsed);
        onClientMessage(parsed, api);
      }
      nl = buf.indexOf("\n");
    }
  });
  return api;
}

describe("AntigravityAcpHost", () => {
  let root: string;
  let cwd: string;
  let antigravityHome: string;
  let stateDir: string;
  let prevStateDir: string | undefined;
  let prevOwner: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-agy-host-"));
    cwd = path.join(root, "repo");
    antigravityHome = path.join(root, "accounts", "antigravity", "default");
    stateDir = path.join(root, "state");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(antigravityHome, { recursive: true });
    prevStateDir = process.env.LLV_STATE_DIR;
    prevOwner = process.env.LLV_STATE_OWNER;
    prevHome = process.env.HOME;
    process.env.LLV_STATE_DIR = stateDir;
    process.env.LLV_STATE_OWNER = "test";
    process.env.HOME = root;
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = prevStateDir;
    if (prevOwner === undefined) delete process.env.LLV_STATE_OWNER;
    else process.env.LLV_STATE_OWNER = prevOwner;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("builds pure launch args, allowlisted child env, and native ACP MCP server payloads", () => {
    expect(antigravityLaunchArgs({ allowAll: true, additionalDirectories: ["/tmp/extra"] })).toEqual([
      "acp",
      "--disable-telemetry",
      "--dangerously-skip-permissions",
      "--add-dir",
      "/tmp/extra",
    ]);
    expect(antigravityLaunchArgs({ allowAll: false })).toEqual(["acp", "--disable-telemetry"]);

    const env = antigravityChildEnv({
      NODE_ENV: "test",
      PATH: "/usr/bin",
      HOME: root,
      TMPDIR: root,
      XDG_CONFIG_HOME: path.join(root, "operator-config"),
      XDG_CACHE_HOME: path.join(root, "operator-cache"),
      XDG_DATA_HOME: path.join(root, "operator-data"),
      XDG_STATE_HOME: path.join(root, "operator-state"),
      LLV_STATE_DIR: stateDir,
      LLV_STATE_OWNER: "test",
      GH_TOKEN: "secret-gh",
      ANTHROPIC_API_KEY: "secret-ant",
      OPENAI_API_KEY: "secret-oai",
      [VIEWER_SPAWN_CAPABILITY_ENV]: "cap-token-should-not-leak",
    }, antigravityHome);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe(antigravityNativeHome(antigravityHome));
    expect(env.HOME).not.toBe(root);
    expect(env.XDG_CONFIG_HOME).not.toBe(path.join(root, "operator-config"));
    expect(env.XDG_CACHE_HOME).not.toBe(path.join(root, "operator-cache"));
    expect(env.XDG_DATA_HOME).not.toBe(path.join(root, "operator-data"));
    expect(env.XDG_STATE_HOME).not.toBe(path.join(root, "operator-state"));
    expect(env.LLV_STATE_DIR).not.toBe(stateDir);
    expect(env.LLV_STATE_OWNER).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env[VIEWER_SPAWN_CAPABILITY_ENV]).toBeUndefined();

    const stdioServers = antigravityMcpServers(
      { command: "bun", args: ["mcp.mjs"], env: { LLV_STATE_DIR: stateDir } },
      "cap-123",
      {
        telegram: { command: "node", args: ["srv.js"], env: { FOO: "bar" } },
        ungranted: { command: "node", args: ["nope.js"] },
      },
      ["viewer", "telegram", "ungranted"],
    );
    expect(stdioServers).toHaveLength(2);
    expect(stdioServers.find((s) => s.name === "ungranted")).toBeUndefined();
    const viewerStdio = stdioServers.find((s) => s.name === "viewer")!;
    expect(viewerStdio.env).toEqual([
      { name: "LLV_STATE_DIR", value: stateDir },
      { name: VIEWER_SPAWN_CAPABILITY_ENV, value: "cap-123" },
    ]);

    const httpServers = antigravityMcpServers(
      { url: "http://127.0.0.1:8899/mcp", headers: { "X-Test": "1" } },
      "cap-http",
      {},
      ["viewer"],
    );
    expect(httpServers).toEqual([{
      type: "http",
      name: "viewer",
      url: "http://127.0.0.1:8899/mcp",
      headers: [
        { name: "X-Test", value: "1" },
        { name: VIEWER_SPAWN_CAPABILITY_HEADER, value: "cap-http" },
      ],
    }]);
  });

  it("handshakes, sets model and thought_level, writes NDJSON transcript, handles tools, cancels, and resumes via session/resume", async () => {
    const mintedSessionId = crypto.randomUUID();
    const spawnCalls: Array<{ cmd: string; args: string[]; opts: SpawnOptionsWithoutStdio }> = [];
    let currentPromptId: number | null = null;
    let fake!: ScriptedAcpServer;
    let closeSent = false;

    const makeOptions = (extra: Partial<AntigravityAcpHostOptions> = {}): AntigravityAcpHostOptions => ({
      cwd,
      antigravityHome,
      accountId: "default",
      model: "gemini-4-neon-xhigh",
      allowAll: true,
      appendSystemPrompt: "Follow repo rules.",
      viewerMcpServer: { command: "bun", args: ["mcp.mjs"], env: {} },
      eventStore: new FileRuntimeEventStore(path.join(stateDir, "runtime-events")),
      processIdentity: () => "start-id-1",
      signalProcess: ((_pid: number, signal?: NodeJS.Signals | number) => {
        fake.signals.push(signal ?? "SIGTERM");
        fake.closeChild(0);
        return true;
      }) as typeof process.kill,
      spawnProcess: (cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        fake = makeFakeAcpChild((msg, api) => {
          const id = msg.id as number | undefined;
          const method = msg.method as string | undefined;
          if (method === "initialize") {
            api.sendToHost({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: 1,
                agentInfo: { name: "Antigravity ACP Server", version: "1.5.13" },
              },
            });
          } else if (method === "session/new" || method === "session/resume") {
            api.sendToHost({
              jsonrpc: "2.0",
              id,
              result: {
                sessionId: mintedSessionId,
                models: {
                  currentModelId: "gemini-4-neon-high",
                  availableModels: [
                    { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
                    { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
                  ],
                },
                configOptions: [
                  {
                    id: "model",
                    category: "model",
                    currentValue: "gemini-4-neon",
                    options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }],
                  },
                  {
                    id: "thought_level",
                    category: "thought_level",
                    currentValue: "high",
                    options: [
                      { value: "low", name: "Low" },
                      { value: "xhigh", name: "Extra" },
                    ],
                  },
                ],
                _meta: { antigravity: { tier: { name: "Google AI Pro", id: "g1-pro-tier" } } },
              },
            });
          } else if (method === "session/set_config_option") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { configOptions: [] } });
          } else if (method === "session/prompt") {
            currentPromptId = id ?? null;
            const params = msg.params as { prompt: Array<{ text?: string }> };
            const text = params.prompt[0]?.text ?? "";
            if (text.includes("HOLD")) {
              api.sendToHost({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId: mintedSessionId,
                  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working..." } },
                },
              });
              return;
            }
            api.sendToHost({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: mintedSessionId,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "call_1",
                  name: "mcp_viewer_list_tasks",
                  status: "in_progress",
                  kind: "other",
                  title: "list_tasks",
                  args: {},
                },
              },
            });
            api.sendToHost({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: mintedSessionId,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: "call_1",
                  name: "mcp_viewer_list_tasks",
                  status: "completed",
                  rawOutput: { output: "OK_TOOL", exit_code: 0 },
                },
              },
            });
            api.sendToHost({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: mintedSessionId,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello from agy!" } },
              },
            });
            api.sendToHost({
              jsonrpc: "2.0",
              id,
              result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
            });
          } else if (method === "session/cancel") {
            if (currentPromptId !== null) {
              const promptId = currentPromptId;
              currentPromptId = null;
              api.sendToHost({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
            }
          } else if (method === "session/close") {
            closeSent = true;
            api.sendToHost({ jsonrpc: "2.0", id, result: {} });
          }
        });
        return fake.child;
      },
      ...extra,
    });

    const host = await AntigravityAcpHost.start(makeOptions());
    expect(host.supportsSteer).toBe(false);
    expect(host.steerFallback).toBe("interrupt");
    expect(host.identity.sessionId).toBe(mintedSessionId);
    expect(spawnCalls[0]?.args).toEqual(["acp", "--disable-telemetry", "--dangerously-skip-permissions"]);

    // Verify session/new received _meta.antigravity.systemPrompt.append and mcpServers
    const newReq = fake.received.find((m) => m.method === "session/new")!;
    expect((newReq.params as Record<string, unknown>)._meta).toEqual({
      antigravity: { systemPrompt: { append: "Follow repo rules." } },
    });
    expect(Array.isArray((newReq.params as Record<string, unknown>).mcpServers)).toBe(true);

    // Verify combined model id split into model + thought_level config options
    const configReqs = fake.received.filter((m) => m.method === "session/set_config_option");
    expect(configReqs.map((r) => r.params)).toEqual([
      { sessionId: mintedSessionId, configId: "model", value: "gemini-4-neon" },
      { sessionId: mintedSessionId, configId: "thought_level", value: "xhigh" },
    ]);

    // Verify model catalog was persisted from ACP handshake
    expect(antigravityModelCatalog("default").models.find((m) => m.id === "gemini-4-neon")?.efforts).toEqual(["low", "xhigh"]);

    // Unknown server->client request gets -32601
    fake.sendToHost({ jsonrpc: "2.0", id: 999, method: "fs/read_text_file", params: { path: "x" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.received.find((m) => m.id === 999 && (m.error as Record<string, unknown>)?.code === -32601)).toBeDefined();

    // Send a turn with tool call + prose
    const receipt = await host.send({ id: "entry-1", text: "Say hi" });
    expect(receipt.outcome).toBe("turn-started");
    await new Promise((r) => setTimeout(r, 20));
    expect((await host.health()).status).toBe("idle");
    expect(await host.sessionMaterializationEvidence("entry-1")).toEqual({ state: "materialized" });

    // Send a long turn, verify concurrent send is rejected as stale-turn, then interrupt
    const held = await host.send({ id: "entry-2", text: "HOLD please" });
    expect(held.outcome).toBe("turn-started");
    const concurrent = await host.send({ id: "entry-3", text: "Do not overlap" });
    expect(concurrent).toEqual({ outcome: "rejected", reason: "stale-turn" });
    await host.interrupt(held.outcome === "turn-started" ? held.turnId : "");
    expect((await host.health()).status).toBe("idle");

    // Live reconfigure when idle
    await host.reconfigure({ model: "gemini-3.8-flash", effort: "low" });

    // Release -> session/close + session.shutdown
    await host.release();
    expect(closeSent).toBe(true);

    // Adopt in fresh process -> session/resume + re-applies model & effort
    const adopted = await AntigravityAcpHost.adopt(mintedSessionId, makeOptions({ model: "gemini-4-neon", effort: "low" }));
    expect(fake.received.some((m) => m.method === "session/resume")).toBe(true);
    expect(fake.received.some((m) => m.method === "session/load")).toBe(false);
    const adoptedConfigs = fake.received.filter((m) => m.method === "session/set_config_option");
    expect(adoptedConfigs.map((r) => r.params)).toEqual([
      { sessionId: mintedSessionId, configId: "model", value: "gemini-4-neon" },
      { sessionId: mintedSessionId, configId: "thought_level", value: "low" },
    ]);
    await adopted.release();

    // Verify NDJSON transcript records written by host
    const records = fs.readFileSync(host.identity.path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
    const types = records.map((r) => r.type);
    expect(types).toContain("session.start");
    expect(types).toContain("user.message");
    expect(types).toContain("tool.execution_start");
    expect(types).toContain("tool.execution_complete");
    expect(types).toContain("assistant.message");
    expect(types).toContain("assistant.turn_end");
    expect(types).toContain("abort");
    expect(types).toContain("session.model_change");
    expect(types).toContain("session.shutdown");
    expect(types).toContain("session.resume");
  });

  it("answers session/request_permission via attention and releases host after 3 timed-out interrupts", async () => {
    const mintedSessionId = crypto.randomUUID();
    let fake!: ScriptedAcpServer;

    const host = await AntigravityAcpHost.start({
      cwd,
      antigravityHome,
      accountId: "default",
      allowAll: false,
      interruptTimeoutMs: 25,
      shutdownGraceMs: 25,
      viewerMcpServer: null,
      eventStore: new FileRuntimeEventStore(path.join(stateDir, "runtime-events")),
      processIdentity: () => "start-id-2",
      signalProcess: ((_pid: number, signal?: NodeJS.Signals | number) => {
        fake.signals.push(signal ?? "SIGTERM");
        fake.closeChild(0);
        return true;
      }) as typeof process.kill,
      spawnProcess: () => {
        fake = makeFakeAcpChild((msg, api) => {
          const id = msg.id as number | undefined;
          const method = msg.method as string | undefined;
          if (method === "initialize") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { version: "1.5.13" } } });
          } else if (method === "session/new") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { sessionId: mintedSessionId } });
          } else if (method === "session/prompt") {
            // Emit permission request and deliberately ignore session/cancel
            api.sendToHost({
              jsonrpc: "2.0",
              id: 77,
              method: "session/request_permission",
              params: {
                sessionId: mintedSessionId,
                toolCall: { title: "rm -f file", kind: "execute" },
                options: [
                  { optionId: "allow_1", kind: "allow_once", name: "Allow once" },
                  { optionId: "deny_1", kind: "reject_once", name: "Deny" },
                ],
              },
            });
          } else if (method === "session/close") {
            api.sendToHost({ jsonrpc: "2.0", id, result: {} });
          }
        });
        return fake.child;
      },
    });

    const sent = await host.send({ id: "perm-1", text: "Run command" });
    expect(sent.outcome).toBe("turn-started");
    await new Promise((r) => setTimeout(r, 15));
    const state = await host.health();
    expect(state.status).toBe("attention");
    expect(state.pendingAttention).toEqual(["antigravity-permission:77"]);

    await host.answer("antigravity-permission:77", { decision: "approve" });
    expect(fake.received.find((m) => m.id === 77 && (m.result as { outcome?: { optionId?: string } })?.outcome?.optionId === "allow_1")).toBeDefined();

    const turnId = sent.outcome === "turn-started" ? sent.turnId : "";
    await expect(host.interrupt(turnId)).rejects.toThrow("did not stop within");
    await expect(host.interrupt(turnId)).rejects.toThrow("did not stop within");
    await expect(host.interrupt(turnId)).rejects.toThrow("host released");
    expect(["dead", "unhosted"]).toContain((await host.health()).status);
    expect(fake.signals.length).toBeGreaterThan(0);
  });

  it("binds delivery materialization to owner-verified ACP acceptance by delivery id without reading events.jsonl", async () => {
    const mintedSessionId = crypto.randomUUID();
    let fake!: ScriptedAcpServer;
    const pendingPrompts = new Map<number, string>();
    const eventStore = new FileRuntimeEventStore(path.join(stateDir, "runtime-events"));

    const makeOpts = (): AntigravityAcpHostOptions => ({
      cwd,
      antigravityHome,
      accountId: "default",
      allowAll: true,
      viewerMcpServer: null,
      eventStore,
      processIdentity: () => "start-id-delivery",
      signalProcess: ((_pid: number, signal?: NodeJS.Signals | number) => {
        fake.signals.push(signal ?? "SIGTERM");
        fake.closeChild(0);
        return true;
      }) as typeof process.kill,
      spawnProcess: () => {
        fake = makeFakeAcpChild((msg, api) => {
          const id = msg.id as number | undefined;
          const method = msg.method as string | undefined;
          if (method === "initialize") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { version: "1.5.14" } } });
          } else if (method === "session/new" || method === "session/resume") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { sessionId: mintedSessionId } });
          } else if (method === "session/prompt" && id !== undefined) {
            const text = ((msg.params as { prompt?: Array<{ text?: string }> })?.prompt?.[0]?.text) ?? "";
            pendingPrompts.set(id, text);
          } else if (method === "session/close") {
            api.sendToHost({ jsonrpc: "2.0", id, result: {} });
          }
        });
        return fake.child;
      },
    });

    const host = await AntigravityAcpHost.start(makeOpts());

    // Delivery 1: send, do NOT let ACP respond yet.
    const d1 = await host.send({ id: "delivery-1", text: "First prompt" });
    expect(d1.outcome).toBe("turn-started");
    await new Promise((r) => setTimeout(r, 15));

    // Passive config_option_update must NOT count as acceptance of delivery-1.
    fake.sendToHost({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: mintedSessionId, update: { sessionUpdate: "config_option_update", configOptions: [] } },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect((await host.sessionMaterializationEvidence("delivery-1")).state).toBe("absent");
    // No premature user.message written before ACP confirms!
    expect(fs.readFileSync(host.identity.path, "utf8")).not.toContain("\"user.message\"");

    // Now ACP streams a turn update and finishes delivery-1.
    const prompt1Id = [...pendingPrompts.keys()][0]!;
    fake.sendToHost({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: mintedSessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done 1" } },
      },
    });
    fake.sendToHost({ jsonrpc: "2.0", id: prompt1Id, result: { stopReason: "end_turn" } });
    await new Promise((r) => setTimeout(r, 20));

    // Prove sessionMaterializationEvidence NEVER reads events.jsonl from disk.
    const origReadFileSync = fs.readFileSync;
    let transcriptReads = 0;
    fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === host.identity.path) transcriptReads += 1;
      return origReadFileSync.apply(fs, args);
    }) as typeof fs.readFileSync;
    try {
      expect(await host.sessionMaterializationEvidence("delivery-1")).toEqual({ state: "materialized" });
      // An older user.message in events.jsonl MUST NOT satisfy a brand-new delivery id!
      expect((await host.sessionMaterializationEvidence("delivery-2")).state).toBe("absent");
      expect((await host.sessionMaterializationEvidence("never-sent")).state).toBe("absent");
      expect(transcriptReads).toBe(0);
    } finally {
      fs.readFileSync = origReadFileSync;
    }

    // Delivery 2: send, then ACP REJECTS session/prompt with a JSON-RPC error.
    const d2 = await host.send({ id: "delivery-2", text: "Rejected prompt" });
    expect(d2.outcome).toBe("turn-started");
    await new Promise((r) => setTimeout(r, 15));
    expect((await host.sessionMaterializationEvidence("delivery-2")).state).toBe("absent");
    const prompt2Id = [...pendingPrompts.keys()].at(-1)!;
    fake.sendToHost({ jsonrpc: "2.0", id: prompt2Id, error: { code: -32000, message: "provider rejected" } });
    await new Promise((r) => setTimeout(r, 20));
    const rejectedEvidence = await host.sessionMaterializationEvidence("delivery-2");
    expect(rejectedEvidence.state).toBe("failed");
    // No fabricated user.message for delivery-2.
    const recordsAfterReject = fs.readFileSync(host.identity.path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
    expect(recordsAfterReject.filter((r) => r.type === "user.message").map((r) => r.data.entryId)).toEqual(["delivery-1"]);

    // Delivery 3: send and confirm via prompt result directly (no intermediate chunks).
    const d3 = await host.send({ id: "delivery-3", text: "Second accepted prompt" });
    expect(d3.outcome).toBe("turn-started");
    await new Promise((r) => setTimeout(r, 15));
    expect((await host.sessionMaterializationEvidence("delivery-3")).state).toBe("absent");
    const prompt3Id = [...pendingPrompts.keys()].at(-1)!;
    fake.sendToHost({ jsonrpc: "2.0", id: prompt3Id, result: { stopReason: "end_turn" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(await host.sessionMaterializationEvidence("delivery-3")).toEqual({ state: "materialized" });

    // Release and adopt: restored owner keeps accepted ids and still rejects unseen delivery ids without reading transcript.
    await host.release();
    const adopted = await AntigravityAcpHost.adopt(mintedSessionId, makeOpts());
    expect(await adopted.sessionMaterializationEvidence("delivery-1")).toEqual({ state: "materialized" });
    expect(await adopted.sessionMaterializationEvidence("delivery-3")).toEqual({ state: "materialized" });
    expect((await adopted.sessionMaterializationEvidence("delivery-4")).state).toBe("absent");
    await adopted.release();
  });

  it("validates session ids, rejects mismatched resume ids, refuses transcript symlinks, and stays bound to one open fd", async () => {
    expect(() => validateAntigravitySessionId("")).toThrow("invalid");
    expect(() => validateAntigravitySessionId("../escape")).toThrow("invalid");
    expect(() => validateAntigravitySessionId("a/b")).toThrow("invalid");
    expect(() => validateAntigravitySessionId("a..b")).toThrow("invalid");
    expect(() => antigravityTranscriptPath(antigravityHome, "../escape")).toThrow("invalid");

    const baseOpts = (onMsg: (msg: Record<string, unknown>, api: ScriptedAcpServer) => void): AntigravityAcpHostOptions => {
      let fake!: ScriptedAcpServer;
      return {
        cwd,
        antigravityHome,
        accountId: "default",
        viewerMcpServer: null,
        eventStore: new FileRuntimeEventStore(path.join(stateDir, "runtime-events")),
        processIdentity: () => "start-id-sec",
        signalProcess: ((_pid: number, signal?: NodeJS.Signals | number) => {
          fake.signals.push(signal ?? "SIGTERM");
          fake.closeChild(0);
          return true;
        }) as typeof process.kill,
        spawnProcess: () => {
          fake = makeFakeAcpChild(onMsg);
          return fake.child;
        },
      };
    };

    // 1. session/new returning a traversal session id is refused before creating files.
    await expect(AntigravityAcpHost.start(baseOpts((msg, api) => {
      if (msg.method === "initialize") api.sendToHost({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
      else if (msg.method === "session/new") api.sendToHost({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "../pwn" } });
    }))).rejects.toThrow("invalid");

    // 2. session/resume returning a different session id is refused.
    await expect(AntigravityAcpHost.adopt("expected-session", baseOpts((msg, api) => {
      if (msg.method === "initialize") api.sendToHost({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
      else if (msg.method === "session/resume") api.sendToHost({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "different-session" } });
    }))).rejects.toThrow("different session id");

    // 3. Symlink at events.jsonl is refused (O_NOFOLLOW).
    const symlinkSession = "symlink-session-1";
    const symlinkDir = path.join(antigravityHome, "sessions", symlinkSession);
    const outsideTarget = path.join(root, "outside.jsonl");
    fs.mkdirSync(symlinkDir, { recursive: true });
    fs.writeFileSync(outsideTarget, "", "utf8");
    fs.symlinkSync(outsideTarget, path.join(symlinkDir, "events.jsonl"));
    await expect(AntigravityAcpHost.start(baseOpts((msg, api) => {
      if (msg.method === "initialize") api.sendToHost({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
      else if (msg.method === "session/new") api.sendToHost({ jsonrpc: "2.0", id: msg.id, result: { sessionId: symlinkSession } });
    }))).rejects.toThrow();
    expect(fs.readFileSync(outsideTarget, "utf8")).toBe("");

    // 4. Verified open fd stays pinned to the original inode even if path is renamed after open.
    const pinnedSession = "pinned-fd-session-1";
    const host = await AntigravityAcpHost.start(baseOpts((msg, api) => {
      if (msg.method === "initialize") api.sendToHost({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } });
      else if (msg.method === "session/new") api.sendToHost({ jsonrpc: "2.0", id: msg.id, result: { sessionId: pinnedSession } });
      else if (msg.method === "session/prompt") api.sendToHost({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      else if (msg.method === "session/close") api.sendToHost({ jsonrpc: "2.0", id: msg.id, result: {} });
    }));
    const originalPath = host.identity.path;
    const movedPath = `${originalPath}.moved`;
    fs.renameSync(originalPath, movedPath);
    await host.send({ id: "pinned-1", text: "Write to pinned fd" });
    await new Promise((r) => setTimeout(r, 20));
    await host.release();
    // Original path must NOT have been recreated; writes landed strictly on the original open inode!
    expect(fs.existsSync(originalPath)).toBe(false);
    const movedContent = fs.readFileSync(movedPath, "utf8");
    expect(movedContent).toContain("\"user.message\"");
    expect(movedContent).toContain("\"session.shutdown\"");
  });

  it("deduplicates accepted delivery ids across adopt() and reports consistent unavailable state on ledger EIO", async () => {
    const mintedSessionId = crypto.randomUUID();
    let fake!: ScriptedAcpServer;
    let lastPromptId = 0;
    const outboundPrompts: string[] = [];
    let failDeliveryEcho = false;
    let failedWrites = 0;

    const eventStore = new FileRuntimeEventStore(path.join(stateDir, "runtime-events-recovery"));
    const originalAppend = eventStore.append.bind(eventStore);
    eventStore.append = (session, event) => {
      if (failDeliveryEcho && event.kind === "item" && event.deliveryEcho) {
        failedWrites += 1;
        throw Object.assign(new Error("simulated ledger EIO"), { code: "EIO" });
      }
      originalAppend(session, event);
    };

    const makeOpts = (): AntigravityAcpHostOptions => ({
      cwd,
      antigravityHome,
      accountId: "default",
      allowAll: true,
      viewerMcpServer: null,
      eventStore,
      shutdownGraceMs: 50,
      processIdentity: () => "start-id-recovery",
      signalProcess: ((_pid: number, signal?: NodeJS.Signals | number) => {
        fake.signals.push(signal ?? "SIGTERM");
        fake.closeChild(0);
        return true;
      }) as typeof process.kill,
      spawnProcess: () => {
        fake = makeFakeAcpChild((msg, api) => {
          const id = msg.id as number | undefined;
          const method = msg.method as string | undefined;
          if (method === "initialize") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { version: "1.5.14" } } });
          } else if (method === "session/new" || method === "session/resume") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { sessionId: mintedSessionId } });
          } else if (method === "session/prompt" && id !== undefined) {
            lastPromptId = id;
            outboundPrompts.push(String(id));
          } else if (method === "session/close") {
            api.sendToHost({ jsonrpc: "2.0", id, result: {} });
          }
        });
        return fake.child;
      },
    });

    // 1. Accept delivery-one normally and release.
    let host = await AntigravityAcpHost.start(makeOpts());
    const firstReceipt = await host.send({ id: "delivery-one", text: "First message" });
    expect(firstReceipt.outcome).toBe("turn-started");
    if (firstReceipt.outcome !== "turn-started") throw new Error("expected turn-started");
    expect((await host.sessionMaterializationEvidence("delivery-one")).state).toBe("absent");
    fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(await host.sessionMaterializationEvidence("delivery-one")).toEqual({ state: "materialized" });
    expect((await host.sessionMaterializationEvidence("never-sent")).state).toBe("absent");
    await host.release();

    // 2. Adopt and retry delivery-one with the SAME delivery id: MUST be idempotent (0 native prompts, 1 echo).
    host = await AntigravityAcpHost.adopt(mintedSessionId, makeOpts());
    expect(await host.sessionMaterializationEvidence("delivery-one")).toEqual({ state: "materialized" });
    expect((await host.sessionMaterializationEvidence("delivery-two")).state).toBe("absent");
    const promptsBeforeRetry = outboundPrompts.length;
    const retryReceipt = await host.send({ id: "delivery-one", text: "First message" });
    expect(retryReceipt).toEqual({ outcome: "turn-started", turnId: firstReceipt.turnId });
    await new Promise((r) => setTimeout(r, 20));
    expect(outboundPrompts.length - promptsBeforeRetry).toBe(0);
    const echoesForOne = eventStore.load(mintedSessionId)
      .filter((event) => event.kind === "item" && event.deliveryEcho?.operationId === "delivery-one");
    expect(echoesForOne).toHaveLength(1);
    expect(await host.sessionMaterializationEvidence("delivery-one")).toEqual({ state: "materialized" });

    // 3. Inject EIO when persisting deliveryEcho for delivery-two:
    //    Current host MUST NOT report materialized; MUST report unavailable and write no user.message/echo.
    failDeliveryEcho = true;
    const secondReceipt = await host.send({ id: "delivery-two", text: "Second message" });
    expect(secondReceipt.outcome).toBe("turn-started");
    expect((await host.sessionMaterializationEvidence("delivery-two")).state).toBe("absent");
    fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
    await new Promise((r) => setTimeout(r, 20));

    expect(failedWrites).toBe(1);
    expect((await host.sessionMaterializationEvidence("delivery-two")).state).toBe("unavailable");
    const echoIdsAfterFailure = eventStore.load(mintedSessionId)
      .filter((event): event is Extract<typeof event, { kind: "item" }> => event.kind === "item" && Boolean(event.deliveryEcho))
      .map((event) => event.deliveryEcho!.operationId);
    expect(echoIdsAfterFailure).toEqual(["delivery-one"]);
    const userMessageIds = fs.readFileSync(host.identity.path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
      .filter((record) => record.type === "user.message")
      .map((record) => record.data.entryId);
    expect(userMessageIds).toEqual(["delivery-one"]);
    await host.release();

    // 4. Re-adopt (twice!): BOTH adopted generations agree on unavailable for delivery-two,
    //    keep materialized for delivery-one, keep absent for unseen ids, and refuse blind resend.
    failDeliveryEcho = false;
    for (let generation = 0; generation < 2; generation += 1) {
      const recovered = await AntigravityAcpHost.adopt(mintedSessionId, makeOpts());
      expect(await recovered.sessionMaterializationEvidence("delivery-one")).toEqual({ state: "materialized" });
      expect((await recovered.sessionMaterializationEvidence("delivery-two")).state).toBe("unavailable");
      expect((await recovered.sessionMaterializationEvidence("never-sent")).state).toBe("absent");
      const promptsBeforeUncertain = outboundPrompts.length;
      const resendUncertain = await recovered.send({ id: "delivery-two", text: "Second message" });
      expect(resendUncertain.outcome).toBe("rejected");
      expect(outboundPrompts.length).toBe(promptsBeforeUncertain);
      await recovered.release();
    }
  });

  it("reconciles retry EIO by latest attempt turnId, keeps lost ACP replies unavailable, and point-reads evicted deliveries past 4096", async () => {
    const mintedSessionId = `ag_edge_${crypto.randomUUID().slice(0, 8)}`;
    const baseEventStore = new FileRuntimeEventStore(path.join(stateDir, "runtime-events-edge"));
    let failDeliveryEcho = false;
    let failedWrites = 0;
    const originalAppend = baseEventStore.append.bind(baseEventStore);
    baseEventStore.append = (id, event) => {
      if (failDeliveryEcho && event.kind === "item" && event.deliveryEcho) {
        failedWrites += 1;
        throw Object.assign(new Error("simulated ledger EIO"), { code: "EIO" });
      }
      originalAppend(id, event);
    };
    const eventStore = baseEventStore;

    const outboundPrompts: string[] = [];
    let lastPromptId = 0;
    let fake!: ReturnType<typeof makeFakeAcpChild>;
    const makeOpts = (sessionId = mintedSessionId) => ({
      cwd,
      antigravityHome,
      accountId: "default",
      allowAll: true,
      viewerMcpServer: null,
      eventStore,
      shutdownGraceMs: 50,
      processIdentity: () => "start-id-edge",
      signalProcess: ((_pid: number, signal?: NodeJS.Signals | number) => {
        fake.signals.push(signal ?? "SIGTERM");
        fake.closeChild(0);
        return true;
      }) as typeof process.kill,
      spawnProcess: () => {
        fake = makeFakeAcpChild((msg, api) => {
          const id = msg.id as number | undefined;
          const method = msg.method as string | undefined;
          if (method === "initialize") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { version: "1.5.14" } } });
          } else if (method === "session/new" || method === "session/resume") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { sessionId } });
          } else if (method === "session/prompt" && id !== undefined) {
            lastPromptId = id;
            outboundPrompts.push(String(id));
          } else if (method === "session/close") {
            api.sendToHost({ jsonrpc: "2.0", id, result: {} });
          }
        });
        return fake.child;
      },
    });

    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

    // A. Retry after explicit ACP error followed by EIO on second attempt's deliveryEcho:
    //    First attempt's `failed` MUST NOT mask the second attempt's uncertain outcome.
    const retryEntry = { id: "edge-retry-eio", text: "Retry message" };
    let host = await AntigravityAcpHost.start(makeOpts());
    expect((await host.send(retryEntry)).outcome).toBe("turn-started");
    fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, error: { code: -32000, message: "first attempt rejected" } });
    await tick();
    expect((await host.sessionMaterializationEvidence(retryEntry.id)).state).toBe("failed");
    await host.release();

    host = await AntigravityAcpHost.adopt(mintedSessionId, makeOpts());
    failDeliveryEcho = true;
    expect((await host.send(retryEntry)).outcome).toBe("turn-started");
    fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
    await tick();
    expect(failedWrites).toBe(1);
    expect((await host.sessionMaterializationEvidence(retryEntry.id)).state).toBe("unavailable");
    await host.release();

    failDeliveryEcho = false;
    host = await AntigravityAcpHost.adopt(mintedSessionId, makeOpts());
    expect((await host.sessionMaterializationEvidence(retryEntry.id)).state).toBe("unavailable");
    const promptsBeforeRetryEio = outboundPrompts.length;
    const thirdTry = await host.send(retryEntry);
    expect(thirdTry.outcome).toBe("rejected");
    expect(outboundPrompts.length - promptsBeforeRetryEio).toBe(0);
    await host.release();

    // B. Lost ACP reply (child disconnects after receiving session/prompt with no reply):
    //    MUST stay `unavailable` on both live host and successor, refusing blind resend.
    const lostSessionId = `ag_lost_${crypto.randomUUID().slice(0, 8)}`;
    const lostEntry = { id: "edge-lost-reply", text: "Lost reply message" };
    host = await AntigravityAcpHost.start(makeOpts(lostSessionId));
    const promptsBeforeLost = outboundPrompts.length;
    expect((await host.send(lostEntry)).outcome).toBe("turn-started");
    expect(outboundPrompts.length - promptsBeforeLost).toBe(1);
    fake.closeChild(1);
    await tick();
    expect((await host.sessionMaterializationEvidence(lostEntry.id)).state).toBe("unavailable");
    await host.release();

    host = await AntigravityAcpHost.adopt(lostSessionId, makeOpts(lostSessionId));
    expect((await host.sessionMaterializationEvidence(lostEntry.id)).state).toBe("unavailable");
    const promptsBeforeLostRetry = outboundPrompts.length;
    const lostRetry = await host.send(lostEntry);
    expect(lostRetry.outcome).toBe("rejected");
    expect(outboundPrompts.length - promptsBeforeLostRetry).toBe(0);
    await host.release();

    // C. Eviction beyond 4,096 accepted deliveries: point-read durable ledger on cache miss.
    const retentionSessionId = `ag_ret_${crypto.randomUUID().slice(0, 8)}`;
    const firstEntry = { id: "edge-retention-first", text: "First of 4097" };
    host = await AntigravityAcpHost.start(makeOpts(retentionSessionId));
    const firstReceipt = await host.send(firstEntry);
    expect(firstReceipt.outcome).toBe("turn-started");
    if (firstReceipt.outcome !== "turn-started") throw new Error("expected turn-started");
    const firstTurnId = firstReceipt.turnId;
    fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
    await tick();
    expect((await host.sessionMaterializationEvidence(firstEntry.id)).state).toBe("materialized");
    await host.release();

    const stored = baseEventStore.load(retentionSessionId);
    const turnEvents = stored.filter((event) => "turnId" in event && event.turnId === firstTurnId);
    expect(turnEvents.some((event) => event.kind === "item" && event.deliveryEcho)).toBe(true);
    let seq = stored.at(-1)!.seq;
    const extraLines: string[] = [];
    for (let n = 0; n < 4096; n += 1) {
      for (const ev of turnEvents) {
        extraLines.push(
          JSON.stringify({ ...ev, seq: ++seq })
            .replaceAll(firstTurnId, `edge-later-turn-${n}`)
            .replaceAll(firstEntry.id, `edge-later-delivery-${n}`),
        );
      }
    }
    fs.appendFileSync(
      path.join(stateDir, "runtime-events-edge", `${retentionSessionId}.jsonl`),
      `${extraLines.join("\n")}\n`,
    );

    host = await AntigravityAcpHost.adopt(retentionSessionId, makeOpts(retentionSessionId));
    const totalEchoes = baseEventStore.load(retentionSessionId).filter((ev) => ev.kind === "item" && ev.deliveryEcho).length;
    expect(totalEchoes).toBe(4097);

    // Instrument baseEventStore.scan & load AFTER adopt() to prove keyed O(1) lookup (0 ledger scans!).
    let scanVisits = 0;
    let loadCalls = 0;
    const origScan = baseEventStore.scan.bind(baseEventStore);
    const origLoad = baseEventStore.load.bind(baseEventStore);
    baseEventStore.scan = async (session, visit) => origScan(session, (event) => {
      scanVisits += 1;
      visit(event);
    });
    baseEventStore.load = (session) => {
      loadCalls += 1;
      return origLoad(session);
    };

    const evFirst = await host.sessionMaterializationEvidence(firstEntry.id);
    expect(evFirst).toEqual({ state: "materialized" });
    // Caller mutating returned evidence object MUST NOT mutate internal host state.
    (evFirst as { state: string }).state = "tampered";
    expect(await host.sessionMaterializationEvidence(firstEntry.id)).toEqual({ state: "materialized" });
    expect((await host.sessionMaterializationEvidence("edge-never-sent")).state).toBe("absent");
    const promptsBeforeRetentionRetry = outboundPrompts.length;
    const retentionRetry = await host.send(firstEntry);
    expect(retentionRetry).toEqual({ outcome: "turn-started", turnId: firstReceipt.turnId });
    expect(outboundPrompts.length - promptsBeforeRetentionRetry).toBe(0);

    // Cold send after eviction: 0 ledger scans, 0 full loads.
    const coldEntry = { id: "edge-cold-after-eviction", text: "Cold message after eviction" };
    const coldReceipt = await host.send(coldEntry);
    expect(coldReceipt.outcome).toBe("turn-started");
    fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
    await tick();
    expect(await host.sessionMaterializationEvidence(coldEntry.id)).toEqual({ state: "materialized" });
    expect(scanVisits).toBe(0);
    expect(loadCalls).toBe(0);

    // Receipt confirmation reader (`readAntigravityConfirmedDelivery`) MUST also use O(1) SQLite point reads
    // (0 ledger scans, 0 full loads) for both accepted and absent IDs when the index fingerprint matches,
    // and fall back cleanly to the canonical JSONL ledger on busy DB or external ledger modification.
    const { readAntigravityConfirmedDelivery } = await import("./antigravityAcpHost");
    const confirmedAccepted = await readAntigravityConfirmedDelivery(retentionSessionId, firstEntry.id, { eventStore: baseEventStore });
    expect(confirmedAccepted?.turnId).toBe(firstTurnId);
    const confirmedAbsent = await readAntigravityConfirmedDelivery(retentionSessionId, "edge-never-sent", { eventStore: baseEventStore });
    expect(confirmedAbsent).toBeNull();
    expect(scanVisits).toBe(0);
    expect(loadCalls).toBe(0);

    // Concurrent WAL writer (`BEGIN IMMEDIATE`) neither blocks nor forces a full scan.
    const { Database } = await import("bun:sqlite");
    const lockerDb = new Database(path.join(antigravityHome, "delivery-acceptance.sqlite"));
    try {
      lockerDb.exec("BEGIN IMMEDIATE");
      const walConcurrent = await readAntigravityConfirmedDelivery(retentionSessionId, firstEntry.id, { eventStore: baseEventStore });
      expect(walConcurrent?.turnId).toBe(firstTurnId);
      expect(scanVisits).toBe(0);
    } finally {
      try { lockerDb.exec("ROLLBACK"); } catch { /* ignore */ }
      lockerDb.close();
    }

    // Second SQLite connection sees committed indexed rows immediately without lock contention.
    const readerDb = new Database(path.join(antigravityHome, "delivery-acceptance.sqlite"), { readonly: true });
    try {
      const rowFirst = readerDb.query<{ state: string; turn_id: string }, [string, string]>(
        "SELECT state, turn_id FROM antigravity_delivery_acceptance WHERE session_id = ? AND delivery_id = ?",
      ).get(retentionSessionId, firstEntry.id);
      const rowCold = readerDb.query<{ state: string }, [string, string]>(
        "SELECT state FROM antigravity_delivery_acceptance WHERE session_id = ? AND delivery_id = ?",
      ).get(retentionSessionId, coldEntry.id);
      expect(rowFirst).toEqual({ state: "accepted", turn_id: firstTurnId });
      expect(rowCold).toEqual({ state: "accepted" });
    } finally {
      readerDb.close();
    }

    // Concurrent send() of the same cold ID after eviction (including across an async refill yield):
    // MUST dispatch at most 1 prompt and return the same turnId to both callers.
    const coldRaceEntry = { id: "edge-concurrent-cold", text: "Concurrent cold send" };
    let releaseRefill!: () => void;
    const refillGate = new Promise<void>((resolve) => { releaseRefill = resolve; });
    let signalRefillEntered!: () => void;
    const refillEntered = new Promise<void>((resolve) => { signalRefillEntered = resolve; });
    let interceptFirstScan = true;
    baseEventStore.scan = async (session, visit) => {
      const result = await origScan(session, visit);
      if (interceptFirstScan) {
        interceptFirstScan = false;
        signalRefillEntered();
        await refillGate;
      }
      return result;
    };
    const oldTime = new Date(Date.now() - 15 * 60_000);
    fs.utimesSync(host.identity.path, oldTime, oldTime);
    expect(await host.releaseIdleEventWindow(() => true)).toBe(true);
    const promptsBeforeRace = outboundPrompts.length;
    const firstRace = host.send(coldRaceEntry);
    await refillEntered;
    const secondRacePromise = host.send(coldRaceEntry);
    releaseRefill();
    const [raceA, raceB] = await Promise.all([firstRace, secondRacePromise]);
    expect(raceA.outcome).toBe("turn-started");
    expect(raceB.outcome).toBe("turn-started");
    if (raceA.outcome !== "turn-started" || raceB.outcome !== "turn-started") throw new Error("expected turn-started");
    expect(raceA.turnId).toBe(raceB.turnId);
    expect(outboundPrompts.length - promptsBeforeRace).toBe(1);
    fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
    await tick();

    // Concurrent miss on fallback scan path (simulated index fallback where call 1 pauses mid-scan
    // while call 2 dispatches and completes the same delivery ID): MUST NOT double-send!
    const fallbackRaceEntry = { id: "edge-concurrent-fallback", text: "Concurrent fallback scan" };
    let releaseFallbackScan!: () => void;
    const fallbackGate = new Promise<void>((resolve) => { releaseFallbackScan = resolve; });
    let signalFallbackEntered!: () => void;
    const fallbackEntered = new Promise<void>((resolve) => { signalFallbackEntered = resolve; });
    let fallbackScanCount = 0;
    baseEventStore.scan = async (session, visit) => {
      fallbackScanCount += 1;
      const result = await origScan(session, visit);
      if (fallbackScanCount === 1) {
        signalFallbackEntered();
        await fallbackGate;
      }
      return result;
    };
    (host as unknown as { deliveryIndexHealthy: boolean }).deliveryIndexHealthy = false;
    const promptsBeforeFallbackRace = outboundPrompts.length;
    const firstFallback = host.send(fallbackRaceEntry);
    await fallbackEntered;
    const secondFallback = await host.send(fallbackRaceEntry);
    expect(secondFallback.outcome).toBe("turn-started");
    fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
    await tick();
    expect(await host.sessionMaterializationEvidence(fallbackRaceEntry.id)).toEqual({ state: "materialized" });
    releaseFallbackScan();
    const resumedFallback = await firstFallback;
    expect(resumedFallback.outcome).toBe("turn-started");
    if (resumedFallback.outcome !== "turn-started" || secondFallback.outcome !== "turn-started") {
      throw new Error("expected turn-started");
    }
    expect(resumedFallback.turnId).toBe(secondFallback.turnId);
    expect(outboundPrompts.length - promptsBeforeFallbackRace).toBe(1);
    const echoesForFallback = origLoad(retentionSessionId)
      .filter((ev) => ev.kind === "item" && ev.deliveryEcho?.operationId === fallbackRaceEntry.id);
    expect(echoesForFallback).toHaveLength(1);

    baseEventStore.scan = origScan;
    baseEventStore.load = origLoad;

    const echoesForFirst = baseEventStore.load(retentionSessionId)
      .filter((ev) => ev.kind === "item" && ev.deliveryEcho?.operationId === firstEntry.id);
    expect(echoesForFirst).toHaveLength(1);

    // Replacing the canonical JSONL with a same-length alternate-ID file while the
    // host is alive MUST invalidate both FileRuntimeEventStore's cache and the
    // derived SQLite delivery index before host.release() appends `session-status`.
    const canonicalLedger = path.join(stateDir, "runtime-events-edge", `${retentionSessionId}.jsonl`);
    const altId = `X${firstEntry.id.slice(1)}`;
    const beforeBytes = fs.readFileSync(canonicalLedger, "utf8");
    const replacedBytes = beforeBytes.replaceAll(firstEntry.id, altId);
    expect(replacedBytes.length).toBe(beforeBytes.length);
    expect(replacedBytes).not.toBe(beforeBytes);
    fs.writeFileSync(`${canonicalLedger}.replace`, replacedBytes);
    fs.renameSync(`${canonicalLedger}.replace`, canonicalLedger);

    expect(await readAntigravityConfirmedDelivery(retentionSessionId, firstEntry.id, { eventStore: baseEventStore, antigravityHome })).toBeNull();
    expect((await readAntigravityConfirmedDelivery(retentionSessionId, altId, { eventStore: baseEventStore, antigravityHome }))?.turnId).toBe(firstTurnId);

    await host.release();

    // After release appends session-status, BOTH the in-process eventStore cache AND
    // cold/same-process confirmed-delivery readers MUST agree with the physical file.
    const postReleaseEvents = baseEventStore.load(retentionSessionId);
    expect(postReleaseEvents.filter((ev) => ev.kind === "item" && ev.deliveryEcho?.operationId === firstEntry.id)).toHaveLength(0);
    expect(postReleaseEvents.filter((ev) => ev.kind === "item" && ev.deliveryEcho?.operationId === altId)).toHaveLength(1);
    expect(await readAntigravityConfirmedDelivery(retentionSessionId, firstEntry.id, { eventStore: baseEventStore, antigravityHome })).toBeNull();
    expect((await readAntigravityConfirmedDelivery(retentionSessionId, altId, { eventStore: baseEventStore, antigravityHome }))?.turnId).toBe(firstTurnId);
    const coldEventStore = new FileRuntimeEventStore(path.join(stateDir, "runtime-events-edge"));
    expect(await readAntigravityConfirmedDelivery(retentionSessionId, firstEntry.id, { eventStore: coldEventStore, antigravityHome })).toBeNull();
    expect((await readAntigravityConfirmedDelivery(retentionSessionId, altId, { eventStore: coldEventStore, antigravityHome }))?.turnId).toBe(firstTurnId);

    // External ledger append after release invalidates the stored fingerprint and forces
    // canonical JSONL fallback so the newly appended acceptance is observed accurately.
    const externalId = "edge-external-after-index";
    const externalTurn = "antigravity:external-turn";
    const latestSeq = baseEventStore.load(retentionSessionId).at(-1)!.seq;
    fs.appendFileSync(
      canonicalLedger,
      `${JSON.stringify({
        seq: latestSeq + 1,
        kind: "item",
        turnId: externalTurn,
        phase: "completed",
        item: { type: "userMessage", content: [{ type: "text", text: "external" }] },
        deliveryEcho: { operationId: externalId, acceptedAt: new Date().toISOString() },
      })}\n`,
    );
    let fallbackScansAfterExternal = 0;
    baseEventStore.scan = async (session, visit) => origScan(session, (event) => {
      fallbackScansAfterExternal += 1;
      visit(event);
    });
    try {
      const externalProof = await readAntigravityConfirmedDelivery(retentionSessionId, externalId, { eventStore: baseEventStore });
      expect(externalProof?.turnId).toBe(externalTurn);
      expect(fallbackScansAfterExternal).toBeGreaterThan(0);
    } finally {
      baseEventStore.scan = origScan;
    }
  });

  it("reconciles direct send() retries against same-length replaced, in-place overwritten, and identical-copy ledgers for evicted deliveries", async () => {
    const ledgerDir = path.join(stateDir, "runtime-events-direct-replace");
    const baseEventStore = new FileRuntimeEventStore(ledgerDir);
    const { readAntigravityConfirmedDelivery } = await import("./antigravityAcpHost");
    const outboundPrompts: string[] = [];
    let lastPromptId = 0;
    let fake!: ReturnType<typeof makeFakeAcpChild>;
    const makeOpts = (sessionId: string): AntigravityAcpHostOptions => ({
      cwd,
      antigravityHome,
      accountId: "default",
      allowAll: true,
      viewerMcpServer: null,
      eventStore: baseEventStore,
      shutdownGraceMs: 50,
      processIdentity: () => "start-id-direct-replace",
      signalProcess: ((_pid: number, signal?: NodeJS.Signals | number) => {
        fake.signals.push(signal ?? "SIGTERM");
        fake.closeChild(0);
        return true;
      }) as typeof process.kill,
      spawnProcess: () => {
        fake = makeFakeAcpChild((msg, api) => {
          const id = msg.id as number | undefined;
          const method = msg.method as string | undefined;
          if (method === "initialize") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { version: "1.5.14" } } });
          } else if (method === "session/new" || method === "session/resume") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { sessionId } });
          } else if (method === "session/prompt" && id !== undefined) {
            lastPromptId = id;
            outboundPrompts.push(String(id));
          } else if (method === "session/close") {
            api.sendToHost({ jsonrpc: "2.0", id, result: {} });
          }
        });
        return fake.child;
      },
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

    const seedEvictedSession = async (tag: string) => {
      const sessionId = `ag_${tag}_${crypto.randomUUID().slice(0, 8)}`;
      const firstEntry = { id: `edge-${tag}-first`, text: "First of 4097" };
      let host = await AntigravityAcpHost.start(makeOpts(sessionId));
      const firstReceipt = await host.send(firstEntry);
      expect(firstReceipt.outcome).toBe("turn-started");
      if (firstReceipt.outcome !== "turn-started") throw new Error("expected turn-started");
      const firstTurnId = firstReceipt.turnId;
      fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
      await tick();
      await host.release();

      const stored = baseEventStore.load(sessionId);
      const turnEvents = stored.filter((event) => "turnId" in event && event.turnId === firstTurnId);
      let seq = stored.at(-1)!.seq;
      const extraLines: string[] = [];
      for (let n = 0; n < 4096; n += 1) {
        for (const ev of turnEvents) {
          extraLines.push(
            JSON.stringify({ ...ev, seq: ++seq })
              .replaceAll(firstTurnId, `edge-${tag}-turn-${n}`)
              .replaceAll(firstEntry.id, `edge-${tag}-later-${n}`),
          );
        }
      }
      const ledgerFile = path.join(ledgerDir, `${sessionId}.jsonl`);
      fs.appendFileSync(ledgerFile, `${extraLines.join("\n")}\n`);
      host = await AntigravityAcpHost.adopt(sessionId, makeOpts(sessionId));
      return { sessionId, firstEntry, firstTurnId, ledgerFile, host };
    };

    const physicalEchoCount = (ledgerFile: string, deliveryId: string) => fs.readFileSync(ledgerFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { deliveryEcho?: { operationId?: string } })
      .filter((event) => event.deliveryEcho?.operationId === deliveryId)
      .length;

    // 1. Atomic same-length replacement where the retried ID IS already on disk:
    //    direct send() MUST return the original turn with 0 new prompts and 1 echo.
    {
      const { firstEntry, firstTurnId, ledgerFile, host } = await seedEvictedSession("already");
      const altId = `X${firstEntry.id.slice(1)}`;
      const originalBytes = fs.readFileSync(ledgerFile, "utf8");
      const replacedBytes = originalBytes.replaceAll(firstEntry.id, altId);
      expect(replacedBytes.length).toBe(originalBytes.length);
      fs.writeFileSync(`${ledgerFile}.restore`, replacedBytes);
      fs.renameSync(`${ledgerFile}.restore`, ledgerFile);

      const promptsBefore = outboundPrompts.length;
      const receipt = await host.send({ id: altId, text: firstEntry.text });
      await tick();
      expect(receipt).toEqual({ outcome: "turn-started", turnId: firstTurnId });
      expect(outboundPrompts.length - promptsBefore).toBe(0);
      expect(physicalEchoCount(ledgerFile, altId)).toBe(1);
      await host.release();
    }

    // 2. Atomic same-length replacement where the retried ID was EVICTED from disk:
    //    direct send() MUST NOT falsely confirm it and MUST dispatch exactly once.
    {
      const { firstEntry, firstTurnId, ledgerFile, host } = await seedEvictedSession("missing");
      const altId = `X${firstEntry.id.slice(1)}`;
      const originalBytes = fs.readFileSync(ledgerFile, "utf8");
      const replacedBytes = originalBytes.replaceAll(firstEntry.id, altId);
      expect(replacedBytes.length).toBe(originalBytes.length);
      fs.writeFileSync(`${ledgerFile}.restore`, replacedBytes);
      fs.renameSync(`${ledgerFile}.restore`, ledgerFile);

      const promptsBefore = outboundPrompts.length;
      const receipt = await host.send({ id: firstEntry.id, text: firstEntry.text });
      expect(receipt.outcome).toBe("turn-started");
      if (receipt.outcome !== "turn-started") throw new Error("expected turn-started");
      expect(receipt.turnId).not.toBe(firstTurnId);
      expect(outboundPrompts.length - promptsBefore).toBe(1);
      fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
      await tick();
      expect(physicalEchoCount(ledgerFile, firstEntry.id)).toBe(1);
      expect(physicalEchoCount(ledgerFile, altId)).toBe(1);
      await host.release();
    }

    // 3. Atomic byte-identical copy-rename (same history, new inode):
    //    must preserve materialized evidence and deduplicate direct send().
    {
      const { sessionId, firstEntry, firstTurnId, ledgerFile, host } = await seedEvictedSession("same");
      fs.copyFileSync(ledgerFile, `${ledgerFile}.identical`);
      fs.renameSync(`${ledgerFile}.identical`, ledgerFile);

      expect(await host.sessionMaterializationEvidence(firstEntry.id)).toEqual({ state: "materialized" });
      const promptsBefore = outboundPrompts.length;
      const retry = await host.send(firstEntry);
      await host.release();
      const confirmed = await readAntigravityConfirmedDelivery(sessionId, firstEntry.id, {
        eventStore: baseEventStore,
        antigravityHome,
      });
      expect(retry).toEqual({ outcome: "turn-started", turnId: firstTurnId });
      expect(confirmed?.turnId).toBe(firstTurnId);
      expect(outboundPrompts.length - promptsBefore).toBe(0);
      expect(physicalEchoCount(ledgerFile, firstEntry.id)).toBe(1);
    }

    // 4. In-place same-inode same-length overwrite preserving mtime:
    //    content sample digest detects the rewrite and reconciles before send().
    {
      const { firstEntry, firstTurnId, ledgerFile, host } = await seedEvictedSession("inplace");
      const altId = `X${firstEntry.id.slice(1)}`;
      const statBefore = fs.statSync(ledgerFile);
      const originalBuf = fs.readFileSync(ledgerFile);
      const replacedBuf = Buffer.from(originalBuf.toString("utf8").replaceAll(firstEntry.id, altId), "utf8");
      expect(replacedBuf.length).toBe(originalBuf.length);
      const fd = fs.openSync(ledgerFile, "r+");
      try {
        fs.writeSync(fd, replacedBuf, 0, replacedBuf.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      fs.utimesSync(ledgerFile, statBefore.atime, statBefore.mtime);

      const promptsBefore = outboundPrompts.length;
      const altReceipt = await host.send({ id: altId, text: firstEntry.text });
      expect(altReceipt).toEqual({ outcome: "turn-started", turnId: firstTurnId });
      expect(outboundPrompts.length - promptsBefore).toBe(0);

      const missingReceipt = await host.send({ id: firstEntry.id, text: firstEntry.text });
      expect(missingReceipt.outcome).toBe("turn-started");
      if (missingReceipt.outcome !== "turn-started") throw new Error("expected turn-started");
      expect(missingReceipt.turnId).not.toBe(firstTurnId);
      expect(outboundPrompts.length - promptsBefore).toBe(1);
      fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
      await tick();
      expect(physicalEchoCount(ledgerFile, firstEntry.id)).toBe(1);
      expect(physicalEchoCount(ledgerFile, altId)).toBe(1);
      await host.release();
    }

    // 5. EIO while reconciling a replaced ledger MUST NOT serve stale cached delivery state:
    //    both send() and sessionMaterializationEvidence() withhold confirmation until disk recovers.
    {
      const { ledgerFile, host } = await seedEvictedSession("eio");
      const cachedId = "edge-eio-later-4095";
      const altId = `X${cachedId.slice(1)}`;
      const originalBytes = fs.readFileSync(ledgerFile, "utf8");
      const replacedBytes = originalBytes.replaceAll(cachedId, altId);
      expect(replacedBytes).not.toBe(originalBytes);
      fs.writeFileSync(`${ledgerFile}.restore`, replacedBytes);
      fs.renameSync(`${ledgerFile}.restore`, ledgerFile);

      const origReadFileSync = fs.readFileSync;
      let faults = 0;
      fs.readFileSync = function (filePath: fs.PathOrFileDescriptor, ...rest: unknown[]) {
        if (String(filePath) === ledgerFile) {
          faults += 1;
          throw Object.assign(new Error("fixture recoverable read error"), { code: "EIO" });
        }
        return (origReadFileSync as (...args: unknown[]) => unknown).call(fs, filePath, ...rest);
      } as typeof fs.readFileSync;

      const promptsBefore = outboundPrompts.length;
      let receiptDuringEio: DeliveryReceipt;
      let evidenceDuringEio: { state: string; reason?: string };
      try {
        receiptDuringEio = await host.send({ id: cachedId, text: "fixture" });
        evidenceDuringEio = await host.sessionMaterializationEvidence(cachedId);
      } finally {
        fs.readFileSync = origReadFileSync;
      }

      expect(faults).toBeGreaterThan(0);
      expect(receiptDuringEio.outcome).toBe("rejected");
      expect(evidenceDuringEio.state).toBe("unavailable");
      expect(outboundPrompts.length - promptsBefore).toBe(0);
      expect(physicalEchoCount(ledgerFile, cachedId)).toBe(0);

      // Once disk reads recover, the same host reconciles cleanly against canonical disk truth.
      expect((await host.sessionMaterializationEvidence(cachedId)).state).toBe("absent");
      expect((await host.sessionMaterializationEvidence(altId)).state).toBe("materialized");
      await host.release();
    }

    // 6. EIO during replaced-ledger check while another prompt is IN-FLIGHT:
    //    completing the in-flight prompt MUST NOT stamp a fresh fingerprint onto an
    //    unreconciled empty cache or cause a duplicate dispatch of an accepted ID.
    for (const withFault of [false, true]) {
      const { ledgerFile, host } = await seedEvictedSession(withFault ? "inflight-fault" : "inflight-ctrl");
      const pending = await host.send({ id: "inflight-pending-prompt", text: "normal running prompt" });
      expect(pending.outcome).toBe("turn-started");
      await tick();

      const oldId = withFault ? "edge-inflight-fault-later-4095" : "edge-inflight-ctrl-later-4095";
      const altId = `X${oldId.slice(1)}`;
      const canonical = fs.readFileSync(ledgerFile, "utf8");
      const replaced = canonical.replaceAll(oldId, altId);
      expect(replaced).not.toBe(canonical);
      fs.writeFileSync(`${ledgerFile}.restore`, replaced);
      fs.renameSync(`${ledgerFile}.restore`, ledgerFile);

      const origReadFileSync = fs.readFileSync;
      let faults = 0;
      if (withFault) {
        fs.readFileSync = function (filePath: fs.PathOrFileDescriptor, ...rest: unknown[]) {
          if (String(filePath) === ledgerFile) {
            faults += 1;
            throw Object.assign(new Error("fixture temporary read error"), { code: "EIO" });
          }
          return (origReadFileSync as (...args: unknown[]) => unknown).call(fs, filePath, ...rest);
        } as typeof fs.readFileSync;
      }
      let duringState: string;
      try {
        duringState = (await host.sessionMaterializationEvidence(altId)).state;
      } finally {
        fs.readFileSync = origReadFileSync;
      }
      if (withFault) {
        expect(faults).toBeGreaterThan(0);
        expect(duringState).toBe("unavailable");
      } else {
        expect(duringState).toBe("materialized");
      }

      // Now complete the in-flight prompt cleanly via ACP.
      fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
      await tick();

      // Accepted ID from the restored ledger MUST still read materialized and MUST NOT resend.
      expect((await host.sessionMaterializationEvidence(altId)).state).toBe("materialized");
      const promptsBefore = outboundPrompts.length;
      const retry = await host.send({ id: altId, text: "original delivery" });
      await tick();
      expect(retry.outcome).toBe("turn-started");
      expect(outboundPrompts.length - promptsBefore).toBe(0);
      expect(physicalEchoCount(ledgerFile, altId)).toBe(1);
      await host.release();
    }
  });

  it("bases delivery acceptance on ACP's actual response when interrupt races end_turn, and keeps release-mid-prompt unavailable", async () => {
    const baseEventStore = new FileRuntimeEventStore(path.join(stateDir, "runtime-events-interrupt-race"));
    const outboundPrompts: string[] = [];
    let lastPromptId = 0;
    let fake!: ReturnType<typeof makeFakeAcpChild>;
    const makeOpts = (sessionId: string): AntigravityAcpHostOptions => ({
      cwd,
      antigravityHome,
      accountId: "default",
      allowAll: true,
      viewerMcpServer: null,
      eventStore: baseEventStore,
      shutdownGraceMs: 50,
      processIdentity: () => "start-id-interrupt-race",
      signalProcess: ((_pid: number, signal?: NodeJS.Signals | number) => {
        fake.signals.push(signal ?? "SIGTERM");
        fake.closeChild(0);
        return true;
      }) as typeof process.kill,
      spawnProcess: () => {
        fake = makeFakeAcpChild((msg, api) => {
          const id = msg.id as number | undefined;
          const method = msg.method as string | undefined;
          if (method === "initialize") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { version: "1.5.14" } } });
          } else if (method === "session/new" || method === "session/resume") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { sessionId } });
          } else if (method === "session/prompt" && id !== undefined) {
            lastPromptId = id;
            outboundPrompts.push(String(id));
          } else if (method === "session/close") {
            api.sendToHost({ jsonrpc: "2.0", id, result: {} });
          }
        });
        return fake.child;
      },
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

    // A. Interrupt raced with ACP completing end_turn: MUST record materialized (NOT failed)
    //    and deduplicate retries on both the same host and after adopt().
    const raceSessionId = `ag_int_race_${crypto.randomUUID().slice(0, 8)}`;
    const raceEntry = { id: "interrupt-raced-end-turn", text: "Complete before cancel" };
    let host = await AntigravityAcpHost.start(makeOpts(raceSessionId));
    const initial = await host.send(raceEntry);
    expect(initial.outcome).toBe("turn-started");
    if (initial.outcome !== "turn-started") throw new Error("expected turn-started");
    const interruption = host.interrupt(initial.turnId);
    expect(fake.received.some((req) => req.method === "session/cancel")).toBe(true);
    fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
    await interruption;

    expect(await host.sessionMaterializationEvidence(raceEntry.id)).toEqual({ state: "materialized" });
    const promptsBeforeSameHostRetry = outboundPrompts.length;
    const sameHostRetry = await host.send(raceEntry);
    expect(sameHostRetry).toEqual({ outcome: "turn-started", turnId: initial.turnId });
    expect(outboundPrompts.length - promptsBeforeSameHostRetry).toBe(0);
    await host.release();

    host = await AntigravityAcpHost.adopt(raceSessionId, makeOpts(raceSessionId));
    expect(await host.sessionMaterializationEvidence(raceEntry.id)).toEqual({ state: "materialized" });
    const promptsBeforeAdoptRetry = outboundPrompts.length;
    const adoptRetry = await host.send(raceEntry);
    expect(adoptRetry).toEqual({ outcome: "turn-started", turnId: initial.turnId });
    expect(outboundPrompts.length - promptsBeforeAdoptRetry).toBe(0);

    // B. Paired control: ACP explicitly answers stopReason="cancelled" before any updates -> failed, retry allowed.
    const cancelledEntry = { id: "explicit-acp-cancelled", text: "Cancel before acceptance" };
    const cancelledInitial = await host.send(cancelledEntry);
    if (cancelledInitial.outcome !== "turn-started") throw new Error("expected turn-started");
    const cancelledInt = host.interrupt(cancelledInitial.turnId);
    fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "cancelled" } });
    await cancelledInt;
    expect((await host.sessionMaterializationEvidence(cancelledEntry.id)).state).toBe("failed");
    const promptsBeforeCancelRetry = outboundPrompts.length;
    const cancelRetry = await host.send(cancelledEntry);
    expect(cancelRetry.outcome).toBe("turn-started");
    expect(outboundPrompts.length - promptsBeforeCancelRetry).toBe(1);
    fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
    await tick();
    expect(await host.sessionMaterializationEvidence(cancelledEntry.id)).toEqual({ state: "materialized" });
    await host.release();

    // C. Host released mid-prompt before ACP answers: MUST stay unavailable (never blind resend).
    const releaseSessionId = `ag_rel_mid_${crypto.randomUUID().slice(0, 8)}`;
    const releaseEntry = { id: "release-mid-prompt", text: "Unanswered before release" };
    host = await AntigravityAcpHost.start(makeOpts(releaseSessionId));
    expect((await host.send(releaseEntry)).outcome).toBe("turn-started");
    await host.release();
    expect((await host.sessionMaterializationEvidence(releaseEntry.id)).state).toBe("unavailable");
    const adoptedAfterRelease = await AntigravityAcpHost.adopt(releaseSessionId, makeOpts(releaseSessionId));
    expect((await adoptedAfterRelease.sessionMaterializationEvidence(releaseEntry.id)).state).toBe("unavailable");
    const promptsBeforeReleaseRetry = outboundPrompts.length;
    expect((await adoptedAfterRelease.send(releaseEntry)).outcome).toBe("rejected");
    expect(outboundPrompts.length - promptsBeforeReleaseRetry).toBe(0);
    await adoptedAfterRelease.release();
  });

  it("reconciles the delivery SQLite index completely when an older JSONL ledger backup is restored and forked past synced_seq", async () => {
    const forkSessionId = `ag_fork_${crypto.randomUUID().slice(0, 8)}`;
    const eventsDir = path.join(stateDir, "runtime-events-fork");
    const ledger = new FileRuntimeEventStore(eventsDir);
    const ledgerFile = path.join(eventsDir, `${forkSessionId}.jsonl`);
    const backupFile = path.join(stateDir, `${forkSessionId}.backup.jsonl`);
    const outboundPrompts: string[] = [];
    let lastPromptId = 0;
    let fake!: ReturnType<typeof makeFakeAcpChild>;
    const makeOpts = (): AntigravityAcpHostOptions => ({
      cwd,
      antigravityHome,
      accountId: "default",
      allowAll: true,
      viewerMcpServer: null,
      eventStore: ledger,
      shutdownGraceMs: 50,
      processIdentity: () => "start-id-fork",
      signalProcess: ((_pid: number) => { fake.closeChild(0); return true; }) as typeof process.kill,
      spawnProcess: () => {
        fake = makeFakeAcpChild((msg, api) => {
          const id = msg.id as number | undefined;
          const method = msg.method as string | undefined;
          if (method === "initialize") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { version: "1.5.14" } } });
          } else if (method === "session/new" || method === "session/resume") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { sessionId: forkSessionId } });
          } else if (method === "session/prompt" && id !== undefined) {
            lastPromptId = id;
            outboundPrompts.push(String(id));
          } else if (method === "session/close") {
            api.sendToHost({ jsonrpc: "2.0", id, result: {} });
          }
        });
        return fake.child;
      },
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
    const appendFillers = (turnId: string, sourceId: string, count: number, prefix: string) => {
      const events = ledger.load(forkSessionId);
      const shape = events.filter((ev) => "turnId" in ev && ev.turnId === turnId);
      let seq = events.at(-1)!.seq;
      const lines: string[] = [];
      for (let i = 0; i < count; i += 1) {
        for (const row of shape) {
          lines.push(JSON.stringify({ ...row, seq: ++seq }).replaceAll(turnId, `${prefix}-turn-${i}`).replaceAll(sourceId, `${prefix}-entry-${i}`));
        }
      }
      fs.appendFileSync(ledgerFile, `${lines.join("\n")}\n`);
    };

    // 1. Create anchor delivery and back up the JSONL ledger right after anchor.
    let host = await AntigravityAcpHost.start(makeOpts());
    expect((await host.send({ id: "anchor", text: "anchor" })).outcome).toBe("turn-started");
    fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
    await tick();
    await host.release();
    fs.copyFileSync(ledgerFile, backupFile);

    // 2. Extend ledger on branch A with `old-middle` + 4100 fillers and populate SQLite index via adopt().
    host = await AntigravityAcpHost.adopt(forkSessionId, makeOpts());
    const oldMid = await host.send({ id: "old-middle", text: "old-middle" });
    if (oldMid.outcome !== "turn-started") throw new Error("expected turn-started");
    fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
    await tick();
    await host.release();
    appendFillers(oldMid.turnId, "old-middle", 4100, "branch-a");
    host = await AntigravityAcpHost.adopt(forkSessionId, makeOpts());
    expect(await host.sessionMaterializationEvidence("old-middle")).toEqual({ state: "materialized" });
    await host.release();

    // 3. Restore backup JSONL (leaving delivery-acceptance.sqlite intact!) and extend longer on branch B
    //    with `alternate-middle` + 4120 fillers (> 4100 so seq and count BOTH exceed synced_seq/synced_count).
    fs.copyFileSync(backupFile, ledgerFile);
    const rawEvents = ledger.load(forkSessionId);
    const altSeqBase = rawEvents.at(-1)!.seq;
    const altTurn = "antigravity:99-alt";
    const altEvents = [
      { kind: "turn-started", turnId: altTurn, seq: altSeqBase + 1 },
      { kind: "item", turnId: altTurn, phase: "started", item: { type: "antigravity.delivery_dispatched", entryId: "alternate-middle", turnId: altTurn }, seq: altSeqBase + 2 },
      { kind: "item", turnId: altTurn, phase: "completed", item: { type: "user.message", entryId: "alternate-middle", turnId: altTurn }, deliveryEcho: { operationId: "alternate-middle", at: new Date().toISOString() }, seq: altSeqBase + 3 },
      { kind: "turn-ended", turnId: altTurn, status: "completed", seq: altSeqBase + 4 },
    ];
    fs.appendFileSync(ledgerFile, `${altEvents.map((e) => JSON.stringify(e)).join("\n")}\n`);
    appendFillers(altTurn, "alternate-middle", 4120, "branch-b");

    // 4. Adopt on branch B: SQLite index MUST remove stale `old-middle` and index `alternate-middle`!
    host = await AntigravityAcpHost.adopt(forkSessionId, makeOpts());
    expect((await host.sessionMaterializationEvidence("old-middle")).state).toBe("absent");
    expect(await host.sessionMaterializationEvidence("alternate-middle")).toEqual({ state: "materialized" });
    const promptsBefore = outboundPrompts.length;
    const replay = await host.send({ id: "alternate-middle", text: "alternate-middle" });
    expect(replay).toEqual({ outcome: "turn-started", turnId: altTurn });
    expect(outboundPrompts.length - promptsBefore).toBe(0);
    await host.release();

    // 5. Held BEGIN IMMEDIATE write lock on shared delivery-acceptance.sqlite MUST NOT stall
    //    the event loop during adopt()/start() — fail fast on SQLITE_BUSY and fall back to JSONL.
    const { Database } = await import("bun:sqlite");
    const indexPath = path.join(antigravityHome, "delivery-acceptance.sqlite");
    const blocker = new Database(indexPath);
    blocker.exec("BEGIN IMMEDIATE");
    try {
      const startAt = performance.now();
      let timerFiredAt = 0;
      const timerDone = new Promise<void>((resolve) => {
        setTimeout(() => {
          timerFiredAt = performance.now() - startAt;
          resolve();
        }, 15);
      });
      const contended = await AntigravityAcpHost.adopt(forkSessionId, makeOpts());
      const adoptMs = performance.now() - startAt;
      await timerDone;
      expect(adoptMs).toBeLessThan(200);
      expect(timerFiredAt).toBeLessThan(150);
      // Fallback ledger lookup still proves `alternate-middle` materialized and `old-middle` absent.
      expect(await contended.sessionMaterializationEvidence("alternate-middle")).toEqual({ state: "materialized" });
      expect((await contended.sessionMaterializationEvidence("old-middle")).state).toBe("absent");
      await contended.release();
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

  it("intercepts RESOURCE_EXHAUSTED prompt errors, appends session.quota_exhausted, emits limits event, and records durable observation", async () => {
    const { readAntigravityTranscriptLimits } = await import("@/lib/limits/antigravityTranscriptLimits");
    const { buildFeed } = await import("@/components/feed/parse");
    const sessionId = `ag_quota_${crypto.randomUUID().slice(0, 8)}`;
    const eventStore = new FileRuntimeEventStore(path.join(stateDir, "runtime-events-quota"));
    const recorded: import("@/lib/accounts/migration/contracts").DurableQuotaObservation[] = [];
    let fake!: ReturnType<typeof makeFakeAcpChild>;

    const fixtureEmail = ["fixture-account", "example.invalid"].join("@");
    const host = await AntigravityAcpHost.start({
      cwd,
      antigravityHome,
      accountId: "default",
      model: "gemini-4-neon",
      effort: "high",
      allowAll: true,
      viewerMcpServer: null,
      eventStore,
      shutdownGraceMs: 40,
      processIdentity: () => "start-quota",
      signalProcess: (() => { fake.closeChild(0); return true; }) as typeof process.kill,
      recordQuotaObservation: (obs) => { recorded.push(obs); },
      spawnProcess: () => {
        fake = makeFakeAcpChild((msg, api) => {
          const id = msg.id as number | undefined;
          const method = msg.method as string | undefined;
          if (method === "initialize") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { version: "1.5.14" } } });
          } else if (method === "session/new") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { sessionId } });
          } else if (method === "session/set_config_option" || method === "session/close") {
            api.sendToHost({ jsonrpc: "2.0", id, result: {} });
          } else if (method === "session/prompt" && id !== undefined) {
            api.sendToHost({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32000,
                message: `RESOURCE_EXHAUSTED: Individual quota reached for ${fixtureEmail}. Resets in 3h 20m 15s`,
              },
            });
          }
        });
        return fake.child;
      },
    });

    try {
      const receipt = await host.send({ id: "quota-delivery-1", text: "trigger quota" });
      expect(receipt.outcome).toBe("turn-started");
      await new Promise((r) => setTimeout(r, 40));

      const events = eventStore.load(sessionId);
      const limitsEvent = events.find((event) => event.kind === "limits");
      expect(limitsEvent).toBeDefined();
      expect(limitsEvent && limitsEvent.kind === "limits" ? limitsEvent.snapshot : null).toMatchObject({
        engine: "antigravity",
        exhausted: true,
        windowMinutes: 300,
      });
      const snapshotMsg = String(limitsEvent && limitsEvent.kind === "limits"
        ? (limitsEvent.snapshot as Record<string, unknown>).message ?? ""
        : "");
      expect(snapshotMsg).toContain("Individual quota reached");
      expect(snapshotMsg).not.toContain(fixtureEmail);

      const transcriptLines = fs.readFileSync(host.identity.path, "utf8").trim().split("\n");
      const quotaRecord = transcriptLines
        .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
        .find((row) => row.type === "session.quota_exhausted");
      expect(quotaRecord).toBeDefined();
      expect(quotaRecord?.data.windowMinutes).toBe(300);
      expect(quotaRecord?.data.usedPercent).toBe(100);
      expect(typeof quotaRecord?.data.resetsAt).toBe("number");
      expect(String(quotaRecord?.data.message ?? "")).not.toContain(fixtureEmail);

      // Feed parser displays the quota exhaustion stop reason on the card.
      const feed = buildFeed(
        { path: host.identity.path, engine: "antigravity", fmt: "antigravity", activity: "recent" } as import("@/lib/types").FileEntry,
        transcriptLines,
        false,
        "",
      ).items;
      expect(feed.some((item) => item.kind === "note" && item.text.includes("Individual quota reached"))).toBe(true);

      // Durable QuotaObservation recorded by identity with no process spawn.
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        engine: "antigravity",
        accountId: "default",
        authenticated: true,
        limitReached: true,
        provenance: { source: "transcript" },
        limits: { session: { usedPercent: 100, windowMinutes: 300 } },
      });

      // Bounded transcript reader reads back the exact same exhaustion.
      const read = readAntigravityTranscriptLimits(path.join(antigravityHome, "sessions"));
      expect(read.source).toBe("transcript");
      expect(read.data?.session?.usedPercent).toBe(100);
      expect(read.data?.session?.windowMinutes).toBe(300);
    } finally {
      await host.release();
    }
  });

  it("treats transient per-minute RESOURCE_EXHAUSTED rate limits as session.error without recording 5-hour quota exhaustion", async () => {
    const { readAntigravityTranscriptLimits } = await import("@/lib/limits/antigravityTranscriptLimits");
    const sessionId = `ag_rpm_${crypto.randomUUID().slice(0, 8)}`;
    const isolatedHome = path.join(stateDir, "ag-home-transient");
    fs.mkdirSync(isolatedHome, { recursive: true });
    const eventStore = new FileRuntimeEventStore(path.join(stateDir, "runtime-events-transient"));
    const recorded: import("@/lib/accounts/migration/contracts").DurableQuotaObservation[] = [];
    let fake!: ReturnType<typeof makeFakeAcpChild>;

    const host = await AntigravityAcpHost.start({
      cwd,
      antigravityHome: isolatedHome,
      accountId: "default",
      model: "gemini-4-neon",
      effort: "high",
      allowAll: true,
      viewerMcpServer: null,
      eventStore,
      shutdownGraceMs: 40,
      processIdentity: () => "start-transient",
      signalProcess: (() => { fake.closeChild(0); return true; }) as typeof process.kill,
      recordQuotaObservation: (obs) => { recorded.push(obs); },
      spawnProcess: () => {
        fake = makeFakeAcpChild((msg, api) => {
          const id = msg.id as number | undefined;
          const method = msg.method as string | undefined;
          if (method === "initialize") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { version: "1.5.14" } } });
          } else if (method === "session/new") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { sessionId } });
          } else if (method === "session/set_config_option" || method === "session/close") {
            api.sendToHost({ jsonrpc: "2.0", id, result: {} });
          } else if (method === "session/prompt" && id !== undefined) {
            api.sendToHost({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32000,
                message: "RESOURCE_EXHAUSTED: requests per minute exceeded; retry after 10 seconds",
              },
            });
          }
        });
        return fake.child;
      },
    });

    try {
      const receipt = await host.send({ id: "rpm-delivery-1", text: "trigger rpm throttle" });
      expect(receipt.outcome).toBe("turn-started");
      await new Promise((r) => setTimeout(r, 40));

      const events = eventStore.load(sessionId);
      expect(events.some((event) => event.kind === "limits")).toBe(false);
      expect(recorded).toHaveLength(0);

      const transcriptRecords = fs.readFileSync(host.identity.path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
      expect(transcriptRecords.some((row) => row.type === "session.quota_exhausted")).toBe(false);
      expect(transcriptRecords.some((row) => row.type === "session.error")).toBe(true);

      const read = readAntigravityTranscriptLimits(path.join(isolatedHome, "sessions"));
      expect(read.source).toBe("unavailable");
      expect(read.data).toBeNull();
    } finally {
      await host.release();
    }
  });
});
