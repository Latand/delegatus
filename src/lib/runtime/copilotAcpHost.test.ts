import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { afterAll, describe, expect, test } from "bun:test";

import {
  COPILOT_NATIVE_MULTI_AGENT_TOOLS,
  CopilotAcpHost,
  copilotChildEnv,
  copilotTranscriptPath,
  type CopilotAcpHostOptions,
} from "./copilotAcpHost";
import type { RuntimeEventStore } from "./eventStore";
import type { RuntimeEvent } from "./engineHost";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-copilot-acp-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

class MemoryEventStore implements RuntimeEventStore {
  readonly events = new Map<string, RuntimeEvent[]>();
  load(sessionId: string): RuntimeEvent[] { return structuredClone(this.events.get(sessionId) ?? []); }
  append(sessionId: string, event: RuntimeEvent): void {
    const events = this.events.get(sessionId) ?? [];
    events.push(structuredClone(event));
    this.events.set(sessionId, events);
  }
}

type Rpc = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

/**
 * A scripted `copilot --acp`. It answers `initialize`, `session/new`,
 * `session/load` and `session/close` itself; a `session/prompt` stays open
 * until the test ends it, or until `session/cancel` arrives, which it answers
 * with `end_turn` exactly as CLI 1.0.87 does.
 */
class FakeCopilot extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 424242;
  readonly signals: NodeJS.Signals[] = [];
  readonly inputs: Rpc[] = [];
  readonly prompts: Rpc[] = [];
  sessionId = crypto.randomUUID();
  answerCancel = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) this.accept(JSON.parse(line) as Rpc);
        newline = buffer.indexOf("\n");
      }
    });
  }

  private accept(message: Rpc): void {
    this.inputs.push(message);
    if (message.method === "initialize") return this.reply(message.id!, { protocolVersion: 1, agentInfo: { name: "Copilot", version: "1.0.87" } });
    if (message.method === "session/new") return this.reply(message.id!, { sessionId: this.sessionId });
    if (message.method === "session/load") {
      this.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "replayed history" } });
      this.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed answer" } });
      return this.reply(message.id!, {});
    }
    if (message.method === "session/close") return this.reply(message.id!, {});
    if (message.method === "session/prompt") { this.prompts.push(message); return; }
    if (message.method === "session/cancel" && this.answerCancel) {
      const open = this.prompts.at(-1);
      if (open) queueMicrotask(() => this.reply(open.id!, { stopReason: "end_turn" }));
    }
  }

  reply(id: number | string, result: unknown): void { this.send({ jsonrpc: "2.0", id, result }); }
  update(update: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: this.sessionId, update } });
  }
  send(value: unknown): void { this.stdout.write(`${JSON.stringify(value)}\n`); }

  finishPrompt(stopReason = "end_turn"): void {
    const open = this.prompts.at(-1);
    if (!open) throw new Error("no prompt is open");
    this.reply(open.id!, { stopReason });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

function spawnInto(child: FakeCopilot, captured: { command?: string; args?: string[]; options?: SpawnOptionsWithoutStdio }) {
  return (command: string, args: string[], options: SpawnOptionsWithoutStdio) => {
    captured.command = command;
    captured.args = args;
    captured.options = options;
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

/** Never a real process: a group signal is refused, so the host falls back
    to the fake child's own `kill`. */
const signalled: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
const refuseGroupSignal = (pid: number, signal?: NodeJS.Signals | number) => {
  signalled.push({ pid, signal });
  throw Object.assign(new Error("no such process"), { code: "ESRCH" });
};

function options(child: FakeCopilot, overrides: Partial<CopilotAcpHostOptions> = {}): CopilotAcpHostOptions & { captured: { command?: string; args?: string[]; options?: SpawnOptionsWithoutStdio } } {
  const captured: { command?: string; args?: string[]; options?: SpawnOptionsWithoutStdio } = {};
  const home = fs.mkdtempSync(path.join(sandbox, "home-"));
  return {
    cwd: "/repo",
    copilotHome: home,
    binary: "copilot-fixture",
    eventStore: new MemoryEventStore(),
    viewerMcpServer: null,
    spawnProcess: spawnInto(child, captured),
    signalProcess: refuseGroupSignal as never,
    processIdentity: () => "fixture-start",
    shutdownGraceMs: 5,
    ...overrides,
    captured,
  };
}

async function until(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function kinds(events: RuntimeEvent[] | undefined): string[] {
  return (events ?? []).map((event) => event.kind === "session-status" ? `status:${event.status}`
    : event.kind === "turn-ended" ? `turn-ended:${event.status}`
    : event.kind);
}

describe("CopilotAcpHost", () => {
  test("starts over ACP with the launch flags, strips credentials and attaches the Viewer MCP by file", async () => {
    const child = new FakeCopilot();
    const opts = options(child, {
      model: "gpt-5.4",
      effort: "xhigh",
      allowAll: true,
      viewerMcpServer: { command: "bun", args: ["/pkg/bin/mcp-server.mjs"], env: { LLV_STATE_DIR: "/state" } },
      env: {
        PATH: "/usr/bin",
        HOME: "/srv/fixture",
        GH_TOKEN: "gh-token-must-not-pass",
        GITHUB_TOKEN: "github-token-must-not-pass",
        COPILOT_GITHUB_TOKEN: "copilot-token-must-not-pass",
        COPILOT_PROVIDER_BASE_URL: "http://provider.invalid",
        COPILOT_MODEL: "leaked-model",
        COPILOT_ALLOW_ALL: "true",
        LLV_SPAWN_CAPABILITY: "c".repeat(43),
      } as unknown as NodeJS.ProcessEnv,
    });
    const host = await CopilotAcpHost.start(opts);
    const args = opts.captured.args!;
    expect(opts.captured.command).toBe("copilot-fixture");
    expect(args.slice(0, 4)).toEqual(["--acp", "--no-auto-update", "-C", "/repo"]);
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "gpt-5.4"]);
    expect(args.slice(args.indexOf("--reasoning-effort"), args.indexOf("--reasoning-effort") + 2)).toEqual(["--reasoning-effort", "xhigh"]);
    expect(args).toContain("--disable-builtin-mcps");
    expect(args).toContain("--allow-all");
    expect(args).not.toContain("--session-id");
    const excluded = args.indexOf("--excluded-tools");
    expect(args.slice(excluded + 1, excluded + 1 + COPILOT_NATIVE_MULTI_AGENT_TOOLS.length)).toEqual([...COPILOT_NATIVE_MULTI_AGENT_TOOLS]);
    const env = opts.captured.options!.env!;
    expect(env.COPILOT_HOME).toBe(opts.copilotHome);
    expect(env.COPILOT_AUTO_UPDATE).toBe("false");
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "COPILOT_PROVIDER_BASE_URL", "COPILOT_MODEL", "COPILOT_ALLOW_ALL", "LLV_SPAWN_CAPABILITY"]) {
      expect(env[name]).toBeUndefined();
    }
    expect(opts.captured.options!.detached).toBe(true);
    /* The capability lives only in the 0600 file named by `@path`. */
    expect(args.join(" ")).not.toContain("c".repeat(43));
    const configArg = args[args.indexOf("--additional-mcp-config") + 1]!;
    expect(configArg.startsWith("@")).toBe(true);
    const configPath = configArg.slice(1);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
      mcpServers: {
        viewer: {
          type: "local",
          command: "bun",
          args: ["/pkg/bin/mcp-server.mjs"],
          tools: ["*"],
          env: { LLV_STATE_DIR: "/state", LLV_SPAWN_CAPABILITY: "c".repeat(43) },
        },
      },
    });
    expect(child.inputs.map((input) => input.method)).toEqual(["initialize", "session/new"]);
    expect(child.inputs[1]!.params).toEqual({ cwd: "/repo", mcpServers: [] });
    expect(host.identity).toEqual({
      sessionId: child.sessionId,
      path: copilotTranscriptPath(opts.copilotHome, child.sessionId),
    });
    expect(await host.health()).toMatchObject({ status: "idle", protocolVersion: "1.0.87", pid: child.pid, activeTurnRef: null });
    await host.release();
    expect(fs.existsSync(configPath)).toBe(false);
  });

  test("allowSubagents keeps the native sub-agent tools; a non-bypass profile omits --allow-all", async () => {
    const child = new FakeCopilot();
    const opts = options(child, { allowSubagents: true });
    const host = await CopilotAcpHost.start(opts);
    expect(opts.captured.args).not.toContain("--excluded-tools");
    expect(opts.captured.args).not.toContain("--allow-all");
    expect(opts.captured.args).not.toContain("--reasoning-effort");
    await host.release();
  });

  test("provider variables reach the child only through the explicit test instrument", () => {
    expect(() => copilotChildEnv({} as NodeJS.ProcessEnv, "/srv/copilot", { GH_TOKEN: "x" })).toThrow("not a provider variable");
    const env = copilotChildEnv({ COPILOT_PROVIDER_BASE_URL: "http://ignored" } as unknown as NodeJS.ProcessEnv, "/srv/copilot", {
      COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:1/v1",
      COPILOT_OFFLINE: "true",
    });
    expect(env.COPILOT_PROVIDER_BASE_URL).toBe("http://127.0.0.1:1/v1");
    expect(env.COPILOT_OFFLINE).toBe("true");
  });

  test("send starts a turn, maps updates to runtime events, and ends it on end_turn", async () => {
    const child = new FakeCopilot();
    const opts = options(child);
    const host = await CopilotAcpHost.start(opts);
    const receipt = await host.send({ id: "entry-1", text: "hello" });
    expect(receipt.outcome).toBe("turn-started");
    const turnId = (receipt as { turnId: string }).turnId;
    expect(turnId.startsWith("copilot:")).toBe(true);
    await until(() => child.prompts.length === 1, "the prompt");
    expect(child.prompts[0]!.params).toEqual({ sessionId: child.sessionId, prompt: [{ type: "text", text: "hello" }] });
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: turnId });
    /* A retried send of the same entry is idempotent and writes nothing. */
    expect(await host.send({ id: "entry-1", text: "hello" })).toEqual({ outcome: "turn-started", turnId });
    expect(child.prompts).toHaveLength(1);
    child.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi " } });
    child.update({ sessionUpdate: "tool_call", toolCallId: "call_1", title: "bash", kind: "execute", status: "pending" });
    child.update({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" });
    child.update({ sessionUpdate: "usage_update", used: 10, size: 100 });
    child.finishPrompt("end_turn");
    await until(async () => (await host.health()).status === "idle", "idle");
    const events = (opts.eventStore as MemoryEventStore).events.get(child.sessionId);
    expect(kinds(events)).toEqual(["status:idle", "turn-started", "delta", "item", "item", "turn-ended:completed", "status:idle"]);
    expect(events!.find((event) => event.kind === "delta")).toMatchObject({ turnId, text: "Hi " });
    expect(events!.filter((event) => event.kind === "item").map((event) => (event as { phase: string }).phase)).toEqual(["started", "completed"]);
    await host.release();
  });

  test("a send while a prompt is in flight is refused stale-turn and writes nothing", async () => {
    const child = new FakeCopilot();
    const host = await CopilotAcpHost.start(options(child));
    await host.send({ id: "entry-1", text: "long task" });
    await until(() => child.prompts.length === 1, "the prompt");
    const written = child.inputs.length;
    expect(await host.send({ id: "entry-2", text: "second" })).toEqual({ outcome: "rejected", reason: "stale-turn" });
    await Bun.sleep(5);
    expect(child.inputs).toHaveLength(written);
    expect(child.prompts).toHaveLength(1);
    await host.release();
  });

  test("interrupt cancels and ends the turn interrupted even though the CLI answers end_turn", async () => {
    const child = new FakeCopilot();
    const opts = options(child);
    const host = await CopilotAcpHost.start(opts);
    const receipt = await host.send({ id: "entry-1", text: "long task" }) as { turnId: string };
    await until(() => child.prompts.length === 1, "the prompt");
    await host.interrupt(receipt.turnId);
    expect(child.inputs.at(-1)).toMatchObject({ method: "session/cancel", params: { sessionId: child.sessionId } });
    expect(child.inputs.at(-1)!.id).toBeUndefined();
    expect(await host.health()).toMatchObject({ status: "idle", activeTurnRef: null });
    const events = (opts.eventStore as MemoryEventStore).events.get(child.sessionId);
    expect(kinds(events)).toEqual(["status:idle", "turn-started", "turn-ended:interrupted", "status:idle"]);
    /* The interrupted host takes the next message at once. */
    expect((await host.send({ id: "entry-2", text: "new direction" })).outcome).toBe("turn-started");
    await until(() => child.prompts.length === 2, "the resent prompt");
    expect(child.prompts[1]!.params).toMatchObject({ prompt: [{ type: "text", text: "new direction" }] });
    await host.release();
  });

  test("interrupt past its bound throws and leaves the turn running", async () => {
    const child = new FakeCopilot();
    child.answerCancel = false;
    const host = await CopilotAcpHost.start(options(child, { interruptTimeoutMs: 20 }));
    const receipt = await host.send({ id: "entry-1", text: "long task" }) as { turnId: string };
    await until(() => child.prompts.length === 1, "the prompt");
    await expect(host.interrupt(receipt.turnId)).rejects.toThrow("did not stop within 20ms");
    expect(await host.health()).toMatchObject({ status: "active", activeTurnRef: receipt.turnId });
    await host.release();
  });

  test("interrupt of a turn that is not running is a no-op", async () => {
    const child = new FakeCopilot();
    const host = await CopilotAcpHost.start(options(child));
    await host.interrupt("copilot:gone");
    expect(child.inputs.some((input) => input.method === "session/cancel")).toBe(false);
    await host.release();
  });

  test("a permission request becomes attention and the answer carries the chosen option", async () => {
    const child = new FakeCopilot();
    const opts = options(child);
    const host = await CopilotAcpHost.start(opts);
    await host.send({ id: "entry-1", text: "run a command" });
    await until(() => child.prompts.length === 1, "the prompt");
    child.send({
      jsonrpc: "2.0",
      id: 77,
      method: "session/request_permission",
      params: {
        sessionId: child.sessionId,
        toolCall: { title: "echo hi", kind: "execute" },
        options: [
          { optionId: "allow_once", kind: "allow_once", name: "Allow" },
          { optionId: "reject_once", kind: "reject_once", name: "Reject" },
        ],
      },
    });
    await until(async () => (await host.health()).status === "attention", "attention");
    const state = await host.health();
    expect(state.pendingAttention).toEqual(["copilot-permission:77"]);
    await expect(host.answer("copilot-permission:77", { optionId: "not-offered" })).rejects.toThrow("did not offer");
    await host.answer("copilot-permission:77", { decision: "accept" });
    expect(child.inputs.at(-1)).toEqual({ jsonrpc: "2.0", id: 77, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
    expect(await host.health()).toMatchObject({ status: "active", pendingAttention: [] });
    child.finishPrompt();
    await until(async () => (await host.health()).status === "idle", "idle");
    const events = (opts.eventStore as MemoryEventStore).events.get(child.sessionId)!;
    expect(events.find((event) => event.kind === "attention")).toMatchObject({
      id: "copilot-permission:77",
      method: "session/request_permission",
      attention: { toolCall: { title: "echo hi", kind: "execute" } },
    });
    expect(events.find((event) => event.kind === "attention-resolved")).toMatchObject({ resolution: "answered" });
    await host.release();
  });

  test("a turn that ends with a permission still open resolves it as turn-ended", async () => {
    const child = new FakeCopilot();
    const opts = options(child);
    const host = await CopilotAcpHost.start(opts);
    await host.send({ id: "entry-1", text: "run a command" });
    await until(() => child.prompts.length === 1, "the prompt");
    child.send({ jsonrpc: "2.0", id: 5, method: "session/request_permission", params: { toolCall: {}, options: [] } });
    await until(async () => (await host.health()).status === "attention", "attention");
    child.finishPrompt("end_turn");
    await until(async () => (await host.health()).status === "idle", "idle");
    const events = (opts.eventStore as MemoryEventStore).events.get(child.sessionId)!;
    expect(events.find((event) => event.kind === "attention-resolved")).toMatchObject({ id: "copilot-permission:5", resolution: "turn-ended" });
    await host.release();
  });

  test("adopt passes model and effort again, loads the session, and does not re-emit the replay", async () => {
    const child = new FakeCopilot();
    const store = new MemoryEventStore();
    store.append(child.sessionId, { kind: "session-status", status: "idle", seq: 1 });
    store.append(child.sessionId, { kind: "turn-started", turnId: "copilot:1-dead", seq: 2 });
    const opts = options(child, { model: "claude-sonnet-5", effort: "high", eventStore: store, initialEventCursor: 2 });
    const host = await CopilotAcpHost.adopt(child.sessionId, opts);
    expect(opts.captured.args).toContain("claude-sonnet-5");
    expect(opts.captured.args!.slice(opts.captured.args!.indexOf("--reasoning-effort"), opts.captured.args!.indexOf("--reasoning-effort") + 2)).toEqual(["--reasoning-effort", "high"]);
    expect(child.inputs.map((input) => input.method)).toEqual(["initialize", "session/load"]);
    expect(child.inputs[1]!.params).toEqual({ sessionId: child.sessionId, cwd: "/repo", mcpServers: [] });
    const events = store.events.get(child.sessionId)!;
    /* The turn the previous process left running ended with it; the replayed
       history produced no delta or item. */
    expect(kinds(events)).toEqual(["status:idle", "turn-started", "turn-ended:error", "status:idle"]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(host.identity.sessionId).toBe(child.sessionId);
    await host.release();
  });

  test("release closes the session, then signals the recorded process group", async () => {
    signalled.length = 0;
    const child = new FakeCopilot();
    const opts = options(child);
    const host = await CopilotAcpHost.start(opts);
    await host.release();
    expect(child.inputs.at(-1)).toMatchObject({ method: "session/close", params: { sessionId: child.sessionId } });
    expect(signalled[0]).toEqual({ pid: -child.pid, signal: "SIGTERM" });
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(await host.health()).toMatchObject({ status: "unhosted", pid: null });
    expect(await host.send({ id: "late", text: "x" })).toEqual({ outcome: "rejected", reason: "dead-host" });
  });

  test("a child that exits on its own reports the host dead and fails the running turn", async () => {
    const child = new FakeCopilot();
    const opts = options(child);
    const host = await CopilotAcpHost.start(opts);
    await host.send({ id: "entry-1", text: "long" });
    await until(() => child.prompts.length === 1, "the prompt");
    child.emit("close", 1, null);
    await until(async () => (await host.health()).status === "dead", "dead");
    expect(kinds((opts.eventStore as MemoryEventStore).events.get(child.sessionId)).slice(-2)).toEqual(["turn-ended:error", "status:dead"]);
  });

  test("materialization evidence reads the first user.message from the transcript", async () => {
    const child = new FakeCopilot();
    const opts = options(child);
    const host = await CopilotAcpHost.start(opts);
    expect((await host.sessionMaterializationEvidence("spawn_message_x")).state).toBe("absent");
    fs.mkdirSync(path.dirname(host.identity.path), { recursive: true });
    fs.writeFileSync(host.identity.path, `${JSON.stringify({ type: "session.start", data: {} })}\n${JSON.stringify({ type: "user.message", data: { content: "hi" } })}\n`);
    expect(await host.sessionMaterializationEvidence("spawn_message_x")).toEqual({ state: "materialized" });
    await host.release();
  });
});
