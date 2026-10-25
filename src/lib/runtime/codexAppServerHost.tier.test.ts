import { parseCodexFeatures, setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, beforeEach, expect, test } from "bun:test";

import { CodexAppServerHost } from "./codexAppServerHost";
import { hostSupportsTier, type RuntimeEvent } from "./engineHost";
import type { RuntimeEventStore } from "./eventStore";

/* Turbo's live tier switch (docs/design/turbo-mode.md §1.5, §2.6) as a
   credential-free fixture of the probe: the app-server double records every
   request the host sends, echoes `thread/settings/updated` the way the
   0.162.1 server does, and runs turns and tool items on command. */

let restoreFeatureReader: () => void;
beforeEach(() => {
  restoreFeatureReader = setCodexFeatureReaderForTest(() => parseCodexFeatures("multi_agent stable true\nmulti_agent_v2 stable true"));
});
afterEach(() => restoreFeatureReader());

class MemoryEventStore implements RuntimeEventStore {
  private readonly events = new Map<string, RuntimeEvent[]>();
  load(threadId: string): RuntimeEvent[] { return structuredClone(this.events.get(threadId) ?? []); }
  append(threadId: string, event: RuntimeEvent): void {
    const events = this.events.get(threadId) ?? [];
    events.push(structuredClone(event));
    this.events.set(threadId, events);
  }
}

class TierAppServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 6161;
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** What `thread/settings/updated` reports back; the 0.162.1 server echoes the request. */
  echo: (tier: unknown) => unknown = tier => tier;
  echoBeforeResponse = true;
  holdSettingsUpdate = false;
  private heldSettingsUpdate: { id: number; tier: unknown } | null = null;
  holdInterrupt = false;
  private heldInterrupt: { id: number; params: Record<string, unknown> } | null = null;
  private turn = 0;

  constructor(readonly threadId = "tier-thread", readonly tiers: string[] = ["priority", "ultrafast"]) {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) this.accept(JSON.parse(line) as Record<string, unknown>);
        newline = buffer.indexOf("\n");
      }
    });
  }

  kill(): boolean { queueMicrotask(() => this.emit("close", 0, "SIGTERM")); return true; }
  notify(method: string, params: Record<string, unknown>): void { this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); }
  serverRequest(id: number, method: string, params: Record<string, unknown>): void { this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
  methods(): string[] { return this.requests.map(request => request.method); }
  releaseInterrupt(): void {
    const held = this.heldInterrupt;
    if (!held) throw new Error("no interrupt is held");
    this.heldInterrupt = null;
    this.respond(held.id, {});
  }
  releaseSettingsUpdate(): void {
    const held = this.heldSettingsUpdate;
    if (!held) throw new Error("no settings update is held");
    this.heldSettingsUpdate = null;
    this.notify("thread/settings/updated", { threadId: this.threadId, threadSettings: { serviceTier: this.echo(held.tier) } });
    this.respond(held.id, {});
  }

  private accept(message: Record<string, unknown>): void {
    if (typeof message.id !== "number" || typeof message.method !== "string") return;
    const method = message.method;
    const params = (message.params ?? {}) as Record<string, unknown>;
    this.requests.push({ method, params });
    if (method === "initialize") return this.respond(message.id, { userAgent: "codex_desktop_app/0.162.1 (Linux)" });
    if (method === "account/read") return this.respond(message.id, { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false });
    if (method === "model/list") {
      return this.respond(message.id, { data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", isDefault: true, inputModalities: ["text"], serviceTiers: this.tiers.map(id => ({ id, name: id })) }] });
    }
    if (method === "modelProvider/capabilities/read") return this.respond(message.id, { webSearch: false, imageGeneration: false });
    if (method === "config/read") return this.respond(message.id, { config: { mcp_servers: {} } });
    if (method === "mcpServerStatus/list") return this.respond(message.id, { data: [{ name: "viewer", tools: { stage_report: {} } }], nextCursor: null });
    if (method === "thread/start" || method === "thread/read") {
      return this.respond(message.id, { thread: { id: this.threadId, path: `/sessions/${this.threadId}.jsonl`, turns: [] } });
    }
    if (method === "thread/turns/list" || method === "thread/queue/list") {
      this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } })}\n`);
      return;
    }
    if (method === "turn/start") {
      const turnId = `turn-${++this.turn}`;
      this.respond(message.id, { turn: { id: turnId } });
      this.notify("turn/started", { threadId: this.threadId, turn: { id: turnId } });
      return;
    }
    if (method === "thread/settings/update") {
      if (this.holdSettingsUpdate) { this.heldSettingsUpdate = { id: message.id as number, tier: params.serviceTier }; return; }
      const echoed = () => this.notify("thread/settings/updated", { threadId: this.threadId, threadSettings: { serviceTier: this.echo(params.serviceTier) } });
      if (this.echoBeforeResponse) echoed();
      this.respond(message.id, {});
      if (!this.echoBeforeResponse) echoed();
      return;
    }
    if (method === "turn/interrupt") {
      if (this.holdInterrupt) { this.heldInterrupt = { id: message.id as number, params }; return; }
      this.respond(message.id, {});
      this.notify("turn/completed", { threadId: this.threadId, turn: { id: params.turnId, status: "interrupted" } });
    }
    if (method === "thread/compact/start") return this.respond(message.id, {});
  }

  private respond(id: number, result: Record<string, unknown>): void { this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
}

async function startHost(server: TierAppServer) {
  return CodexAppServerHost.start({
    cwd: "/repo", model: "gpt-6.1-sol", readProtocolVersion: () => "0.162.1", requestTimeoutMs: 500,
    eventStore: new MemoryEventStore(),
    spawnProcess: () => server as unknown as ChildProcessWithoutNullStreams,
    pidAlive: () => true, processIdentity: () => "6161:owned",
  });
}

async function startTurn(host: CodexAppServerHost, server: TierAppServer, turn = "turn-1") {
  server.notify("turn/started", { threadId: server.threadId, turn: { id: turn } });
  expect((await host.health()).activeTurnRef).toBe(turn);
}

const tierUpdates = (server: TierAppServer) => server.requests.filter(request => request.method === "thread/settings/update");

test("a cut records its turn before interrupting and interrupted history can recover its outcome", async () => {
  const server = new TierAppServer();
  const host = await startHost(server);
  try {
    await startTurn(host, server);
    const recorded: string[] = [];
    await host.setTier({ operationId: "turbo-durable-cut", serviceTier: "ultrafast", cut: "boundary",
      beforeCut: async (turnId: string) => {
        expect(server.methods()).not.toContain("turn/interrupt");
        recorded.push(turnId);
      },
    } as Parameters<typeof host.setTier>[0]);
    expect(recorded).toEqual(["turn-1"]);
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: "turn-1", status: "interrupted" } });
    expect(host.tierCutEvidence("turn-1")).toBe("cut");
    expect(host.tierCutEvidence("unobserved-turn")).toBe("unknown");
    await startTurn(host, server, "turn-2");
    expect(host.tierCutEvidence("turn-1")).toBe("turn-ended");
  } finally { await host.release(); }
});

test("authority withdrawn while a cut intent is persisted prevents the interrupt", async () => {
  const server = new TierAppServer();
  const host = await startHost(server);
  try {
    await startTurn(host, server);
    let allowed = true;
    const outcome = await host.setTier({ operationId: "turbo-cut-revoked", serviceTier: "ultrafast", cut: "boundary",
      authorizeDispatch: () => { if (!allowed) throw new Error("Turbo ended"); },
      beforeCut: async () => { allowed = false; },
    } as Parameters<typeof host.setTier>[0]);
    expect(outcome.cut).toBe("none");
    expect(server.methods()).not.toContain("turn/interrupt");
  } finally { await host.release(); }
});

test("an idle thread gets thread/settings/update with the tier; nothing is cut and the echo is recorded", async () => {
  const server = new TierAppServer();
  const host = await startHost(server);
  try {
    expect(hostSupportsTier(host)).toBe(true);
    const outcome = await host.setTier({ operationId: "turbo-1", serviceTier: "ultrafast", cut: "boundary" });
    expect(tierUpdates(server)).toEqual([{ method: "thread/settings/update", params: { threadId: server.threadId, serviceTier: "ultrafast" } }]);
    expect(outcome).toMatchObject({ appliedTier: "ultrafast", echoed: true, cut: "none", reason: "no turn is running" });
    expect(server.methods()).not.toContain("turn/interrupt");
    expect(server.methods()).not.toContain("thread/resume");
  } finally { await host.release(); }
});

test("replaying a tier operation never interrupts a second turn", async () => {
  const server = new TierAppServer();
  const host = await startHost(server);
  try {
    await startTurn(host, server);
    const request = { operationId: "turbo-replay", serviceTier: "ultrafast", cut: "boundary" as const };
    expect((await host.setTier(request)).cut).toBe("cut");
    await startTurn(host, server, "turn-2");
    await host.setTier(request);
    expect(tierUpdates(server)).toHaveLength(1);
    expect(server.methods().filter(method => method === "turn/interrupt")).toHaveLength(1);
    expect((await host.health()).activeTurnRef).toBe("turn-2");
    await expect(host.setTier({ ...request, serviceTier: "priority" })).rejects.toThrow("already names another request");
  } finally { await host.release(); }
});

test("an armed cut rechecks authority when its tool finishes", async () => {
  const server = new TierAppServer();
  const host = await startHost(server);
  let allowed = true;
  try {
    await startTurn(host, server);
    const item = { id: "command-1", type: "commandExecution" };
    server.notify("item/started", { threadId: server.threadId, turnId: "turn-1", item });
    const outcome = await host.setTier({ operationId: "turbo-authority", serviceTier: "ultrafast", cut: "boundary",
      authorizeDispatch: () => { if (!allowed) throw new Error("episode expired"); } });
    expect(outcome.cut).toBe("armed");
    allowed = false;
    server.notify("item/completed", { threadId: server.threadId, turnId: "turn-1", item });
    expect(await outcome.settled).toBe("cancelled");
    expect(server.methods()).not.toContain("turn/interrupt");
  } finally { await host.release(); }
});

test("the echoed tier is recorded as applied even when it differs from the request", async () => {
  const server = new TierAppServer();
  server.echo = () => "priority";
  const host = await startHost(server);
  try {
    expect(await host.setTier({ operationId: "turbo-1", serviceTier: "ultrafast", cut: "none" })).toMatchObject({ appliedTier: "priority", echoed: true });
  } finally { await host.release(); }
});

test("a tier missing from the live catalog is refused before any call", async () => {
  const server = new TierAppServer("tier-thread", ["priority"]);
  const host = await startHost(server);
  try {
    await expect(host.setTier({ operationId: "turbo-1", serviceTier: "ultrafast", cut: "boundary" })).rejects.toThrow('serviceTier ultrafast for model gpt-6.1-sol; evaluated selected account "default"');
    expect(tierUpdates(server)).toHaveLength(0);
  } finally { await host.release(); }
});

test("null clears the tier and `none` never interrupts a running turn", async () => {
  const server = new TierAppServer();
  const host = await startHost(server);
  try {
    await startTurn(host, server);
    const outcome = await host.setTier({ operationId: "turbo-off", serviceTier: null, cut: "none" });
    expect(tierUpdates(server)[0]!.params).toEqual({ threadId: server.threadId, serviceTier: null });
    expect(outcome).toMatchObject({ appliedTier: null, cut: "none" });
    expect(server.methods()).not.toContain("turn/interrupt");
    expect((await host.health()).activeTurnRef).toBe("turn-1");
  } finally { await host.release(); }
});

test("a turn generating text is cut at once at the boundary", async () => {
  const server = new TierAppServer();
  const host = await startHost(server);
  try {
    await startTurn(host, server);
    const outcome = await host.setTier({ operationId: "turbo-1", serviceTier: "ultrafast", cut: "boundary" });
    expect(outcome.cut).toBe("cut");
    expect(server.requests.find(request => request.method === "turn/interrupt")!.params).toEqual({ threadId: server.threadId, turnId: "turn-1" });
  } finally { await host.release(); }
});

test("boundary waits for an in-progress command to complete, then interrupts before the next inference", async () => {
  const server = new TierAppServer();
  const host = await startHost(server);
  try {
    await startTurn(host, server);
    server.notify("item/started", { threadId: server.threadId, turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution", command: "bun test" } });
    await Bun.sleep(10);
    const outcome = await host.setTier({ operationId: "turbo-1", serviceTier: "ultrafast", cut: "boundary" });
    expect(outcome.cut).toBe("armed");
    await Bun.sleep(20);
    expect(server.methods()).not.toContain("turn/interrupt");
    // An unrelated message item does not release the cut while the command runs.
    server.notify("item/completed", { threadId: server.threadId, turnId: "turn-1", item: { id: "msg-1", type: "agentMessage", text: "running tests" } });
    await Bun.sleep(10);
    expect(server.methods()).not.toContain("turn/interrupt");
    server.notify("item/completed", { threadId: server.threadId, turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution", command: "bun test", exitCode: 0 } });
    expect(await outcome.settled).toBe("cut");
    expect(server.methods().filter(method => method === "turn/interrupt")).toHaveLength(1);
  } finally { await host.release(); }
});

test("a sent boundary interrupt stays owed when cancellation races its reply", async () => {
  const server = new TierAppServer();
  server.holdInterrupt = true;
  const host = await startHost(server);
  try {
    await startTurn(host, server);
    server.notify("item/started", { threadId: server.threadId, turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution" } });
    const armed = await host.setTier({ operationId: "turbo-owed", serviceTier: "ultrafast", cut: "boundary" });
    server.notify("item/completed", { threadId: server.threadId, turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution" } });
    await Bun.sleep(0);
    expect(server.methods().filter(method => method === "turn/interrupt")).toHaveLength(1);
    expect(host.cancelArmedTierCut("turbo-owed")).toBe(false);
    const next = host.setTier({ operationId: "turbo-after-owed", serviceTier: "priority", cut: "none" });
    await Bun.sleep(0);
    expect(tierUpdates(server)).toHaveLength(1);
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: "turn-1", status: "interrupted" } });
    expect(await armed.settled).toBe("cut");
    server.releaseInterrupt();
    expect((await next).appliedTier).toBe("priority");
    expect(tierUpdates(server)).toHaveLength(2);
  } finally { await host.release(); }
});

test("tier settings wait for compaction settlement and proceed after either outcome", async () => {
  for (const status of ["completed", "failed"] as const) {
    const server = new TierAppServer();
    const host = await startHost(server);
    try {
      const compact = host.compact({ operationId: `compact-${status}`, threadId: server.threadId });
      while (!server.methods().includes("thread/compact/start")) await Bun.sleep(0);
      server.notify("turn/started", { threadId: server.threadId, turn: { id: `compact-turn-${status}` } });
      server.notify("item/started", { threadId: server.threadId, turnId: `compact-turn-${status}`, item: { id: `compact-item-${status}`, type: "contextCompaction" } });
      const switchWork = host.setTier({ operationId: `turbo-after-compact-${status}`, serviceTier: "ultrafast", cut: "none" });
      await Bun.sleep(0);
      expect(tierUpdates(server)).toHaveLength(0);
      server.notify("item/completed", { threadId: server.threadId, turnId: `compact-turn-${status}`, item: { id: `compact-item-${status}`, type: "contextCompaction", status } });
      await compact;
      expect((await switchWork).appliedTier).toBe("ultrafast");
      expect(server.methods().indexOf("thread/settings/update")).toBeGreaterThan(server.methods().indexOf("thread/compact/start"));
    } finally { await host.release(); }
  }
});

test("compaction and tier changes share one control queue", async () => {
  const server = new TierAppServer();
  server.holdSettingsUpdate = true;
  const host = await startHost(server);
  try {
    const switchWork = host.setTier({ operationId: "tier-before-compact", serviceTier: "ultrafast", cut: "none" });
    while (!server.methods().includes("thread/settings/update")) await Bun.sleep(0);
    const compact = host.compact({ operationId: "compact-after-tier", threadId: server.threadId });
    await Bun.sleep(0);
    expect(server.methods()).not.toContain("thread/compact/start");
    server.releaseSettingsUpdate();
    expect((await switchWork).appliedTier).toBe("ultrafast");
    while (!server.methods().includes("thread/compact/start")) await Bun.sleep(0);
    server.notify("turn/started", { threadId: server.threadId, turn: { id: "compact-turn" } });
    server.notify("item/started", { threadId: server.threadId, turnId: "compact-turn", item: { id: "compact-item", type: "contextCompaction" } });
    server.notify("item/completed", { threadId: server.threadId, turnId: "compact-turn", item: { id: "compact-item", type: "contextCompaction", status: "completed" } });
    await compact;
    expect(server.methods().indexOf("thread/settings/update")).toBeLessThan(server.methods().indexOf("thread/compact/start"));
  } finally { await host.release(); }
});

test("an armed cut is abandoned when the turn ends first, on cancel and when the host goes", async () => {
  const server = new TierAppServer();
  const host = await startHost(server);
  try {
    await startTurn(host, server);
    server.notify("item/started", { threadId: server.threadId, turnId: "turn-1", item: { id: "cmd-1", type: "commandExecution" } });
    await Bun.sleep(10);
    const ended = await host.setTier({ operationId: "turbo-1", serviceTier: "ultrafast", cut: "boundary" });
    server.notify("turn/completed", { threadId: server.threadId, turn: { id: "turn-1", status: "completed" } });
    expect(await ended.settled).toBe("turn-ended");
    expect(server.methods()).not.toContain("turn/interrupt");
  } finally { await host.release(); }

  const second = new TierAppServer();
  const other = await startHost(second);
  await startTurn(other, second);
  second.notify("item/started", { threadId: second.threadId, turnId: "turn-1", item: { id: "cmd-1", type: "fileChange" } });
  await Bun.sleep(10);
  const cancelled = await other.setTier({ operationId: "turbo-2", serviceTier: "priority", cut: "boundary" });
  expect(other.cancelArmedTierCut("turbo-2")).toBe(true);
  expect(await cancelled.settled).toBe("cancelled");
  const gone = await other.setTier({ operationId: "turbo-3", serviceTier: "priority", cut: "boundary" });
  await other.release();
  expect(await gone.settled).toBe("host-gone");
  expect(second.methods()).not.toContain("turn/interrupt");
});

test("a turn waiting for an approval is never cut", async () => {
  const server = new TierAppServer();
  const host = await startHost(server);
  try {
    await startTurn(host, server);
    server.serverRequest(77, "item/commandExecution/requestApproval", { threadId: server.threadId, turnId: "turn-1", itemId: "item-77", startedAtMs: 1, command: "rm -rf build" });
    await Bun.sleep(20);
    expect((await host.health()).pendingAttention.length).toBe(1);
    const outcome = await host.setTier({ operationId: "turbo-1", serviceTier: "ultrafast", cut: "now" });
    expect(outcome).toMatchObject({ cut: "none", reason: "the turn is waiting for an answer" });
    expect(server.methods()).not.toContain("turn/interrupt");
  } finally { await host.release(); }
});
