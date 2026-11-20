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
  AntigravityAcpHost,
  type AntigravityAcpHostOptions,
} from "./antigravityAcpHost";
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
      GH_TOKEN: "secret-gh",
      ANTHROPIC_API_KEY: "secret-ant",
      OPENAI_API_KEY: "secret-oai",
      [VIEWER_SPAWN_CAPABILITY_ENV]: "cap-token-should-not-leak",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe(root);
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
});
