import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";

import { AgentRegistry } from "@/lib/agent/registry";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { RuntimeOperationCommand, RuntimeReceiptStatus, RuntimeTransitionDetails, RuntimeTransitionOptions } from "@/lib/runtime/contracts";
import { AntigravityAcpHost, type AntigravityAcpHostOptions } from "@/lib/runtime/antigravityAcpHost";
import { FileRuntimeEventStore } from "@/lib/runtime/eventStore";
import { dispatchStructuredControl } from "@/lib/runtime/structuredControls";
import { structuredContent } from "@/lib/runtime/structuredContent";
import { StructuredDeliveryQueue } from "@/lib/runtime/structuredDeliveryQueue";
import { defaultStructuredSendPolicy } from "@/lib/runtime/structuredMessageDelivery";
import { applyStructuredReconfigure } from "@/lib/runtime/structuredReconfigure";
import { resolveSendReceipt } from "@/lib/runtime/sendSettlement";
import { pathAllowed } from "@/lib/scanner/roots";
import { antigravityDefaultSessionsDir } from "@/lib/accounts/antigravity";
import { RuntimeJournal } from "@/runtime-host/journal";

type JsonObject = Record<string, unknown>;

function makeFakeAcpChild(
  onRequest: (message: JsonObject, api: { sendToHost: (msg: JsonObject) => void; closeChild: (code?: number) => void }) => void,
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
  };
  let closed = false;
  let exitCode: number | null = null;
  let buffer = "";
  const received: JsonObject[] = [];

  const sendToHost = (msg: JsonObject) => {
    if (closed) return;
    stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const closeChild = (code = 0) => {
    if (closed) return;
    closed = true;
    exitCode = code;
    child.exitCode = code;
    stdout.end();
    stderr.end();
    child.emit("exit", code, null);
    child.emit("close", code, null);
  };

  stdin.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        const parsed = JSON.parse(line) as JsonObject;
        received.push(parsed);
        onRequest(parsed, { sendToHost, closeChild });
      }
      nl = buffer.indexOf("\n");
    }
  });

  Object.assign(child, {
    pid: 44000 + Math.floor(Math.random() * 10000),
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, null, null],
    exitCode,
    signalCode: null,
    killed: false,
    kill: () => {
      child.killed = true;
      closeChild(0);
      return true;
    },
  });

  return { child, received, sendToHost, closeChild };
}

function journalPort(journal: RuntimeJournal, owner = "claim-antigravity:1") {
  return {
    effects: async (kinds: readonly string[], afterEventSeq: number) => journal.effectBatch(100, kinds, afterEventSeq),
    status: async (operationId: string) => journal.operationResult(operationId)?.receipt ?? null,
    hostClaim: async () => owner,
    transition: async (
      operationId: string,
      status: Exclude<RuntimeReceiptStatus, "pending">,
      details?: RuntimeTransitionDetails,
      options?: RuntimeTransitionOptions,
    ) => {
      journal.transitionOperation(operationId, status, details, options);
    },
  };
}

describe("Antigravity Slice 2 conversation control", () => {
  let root: string;
  let cwd: string;
  let stateDir: string;
  let antigravityHome: string;
  let savedStateDir: string | undefined;

  beforeEach(() => {
    savedStateDir = process.env.LLV_STATE_DIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ag-s2-"));
    cwd = path.join(root, "repo");
    stateDir = path.join(root, "state");
    antigravityHome = path.join(root, "accounts", "antigravity", "default");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(antigravityHome, { recursive: true });
    process.env.LLV_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (savedStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = savedStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("handles stale-turn, permission answer, interrupt cancellation, 3-strike release, live reconfigure, and adopt via session/resume", async () => {
    const sessionId = crypto.randomUUID();
    const eventStore = new FileRuntimeEventStore(path.join(stateDir, "events"));
    const setConfigCalls: Array<{ configId: string; value: string }> = [];
    const permissionResponses: JsonObject[] = [];
    let cancelCount = 0;
    let promptHandler: ((id: number, api: { sendToHost: (msg: JsonObject) => void }) => void) | null = null;
    let fake!: ReturnType<typeof makeFakeAcpChild>;

    const makeOpts = (overrides: Partial<AntigravityAcpHostOptions> = {}): AntigravityAcpHostOptions => ({
      cwd,
      antigravityHome,
      accountId: "default",
      model: "gemini-3.8-flash",
      effort: "low",
      allowAll: false,
      viewerMcpServer: null,
      eventStore,
      interruptTimeoutMs: 40,
      shutdownGraceMs: 40,
      processIdentity: () => "start-ag-s2",
      signalProcess: ((_pid: number) => {
        fake.closeChild(0);
        return true;
      }) as typeof process.kill,
      spawnProcess: () => {
        fake = makeFakeAcpChild((msg, api) => {
          const id = msg.id as number | undefined;
          const method = msg.method as string | undefined;
          if (!method && id !== undefined) {
            permissionResponses.push(msg);
            return;
          }
          if (method === "initialize") {
            api.sendToHost({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { version: "1.5.14" } } });
          } else if (method === "session/new" || method === "session/resume") {
            api.sendToHost({
              jsonrpc: "2.0",
              id,
              result: {
                sessionId,
                models: { currentModelId: "gemini-4-neon-high" },
              },
            });
          } else if (method === "session/set_config_option") {
            const params = msg.params as { configId: string; value: string };
            setConfigCalls.push({ configId: params.configId, value: params.value });
            api.sendToHost({ jsonrpc: "2.0", id, result: {} });
          } else if (method === "session/prompt" && id !== undefined) {
            promptHandler?.(id, api);
          } else if (method === "session/cancel") {
            cancelCount += 1;
          } else if (method === "session/close") {
            api.sendToHost({ jsonrpc: "2.0", id, result: {} });
          }
        });
        return fake.child;
      },
      ...overrides,
    });

    const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

    // 1. Start host, verify stale-turn refusal during active prompt, and answer permission request.
    let activePromptId = 0;
    promptHandler = (id, api) => {
      activePromptId = id;
      api.sendToHost({
        jsonrpc: "2.0",
        id: 7001,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "tc-1", kind: "execute", title: "Run command" },
          options: [
            { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
            { optionId: "reject-once", kind: "reject_once", name: "Reject once" },
          ],
        },
      });
    };

    const host = await AntigravityAcpHost.start(makeOpts());
    const first = await host.send({ id: "op-1", text: "Do work" });
    expect(first.outcome).toBe("turn-started");
    if (first.outcome !== "turn-started") throw new Error("expected turn-started");
    await tick();

    // Concurrent send during active turn MUST be refused as stale-turn (no steer).
    expect(await host.send({ id: "op-concurrent", text: "Busy" })).toEqual({ outcome: "rejected", reason: "stale-turn" });
    // Live reconfigure MUST be refused during active turn.
    await expect(host.reconfigure({ model: "gemini-4-neon", effort: "high" })).rejects.toThrow(/active turn/i);

    // Permission surfaced as attention -> answer with decision "accept".
    const attnHealth = await host.health();
    expect(attnHealth.status).toBe("attention");
    expect(attnHealth.pendingAttention).toEqual(["antigravity-permission:7001"]);
    // Mutating returned health() object MUST NOT mutate internal host state.
    attnHealth.pendingAttention.push("tampered");
    expect((await host.health()).pendingAttention).toEqual(["antigravity-permission:7001"]);

    await expect(host.answer("antigravity-permission:7001", { optionId: "nonexistent" })).rejects.toThrow(/did not offer/);
    await host.answer("antigravity-permission:7001", { decision: "accept" });
    expect(permissionResponses).toContainEqual({
      jsonrpc: "2.0",
      id: 7001,
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    });

    // Complete turn 1, then run live idle reconfigure via session/set_config_option.
    fake.sendToHost({ jsonrpc: "2.0", id: activePromptId, result: { stopReason: "end_turn" } });
    await tick();
    expect((await host.health()).status).toBe("idle");

    setConfigCalls.length = 0;
    await host.reconfigure({ model: "gemini-4-neon", effort: "high" });
    expect(setConfigCalls).toEqual([
      { configId: "model", value: "gemini-4-neon" },
      { configId: "thought_level", value: "high" },
    ]);
    const transcriptLines = fs.readFileSync(host.identity.path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; data: JsonObject });
    expect(transcriptLines.some((r) => r.type === "session.model_change" && r.data.model === "gemini-4-neon-high")).toBe(true);

    // 2. Interrupt with open permission request -> cancels permission, settles on stopReason="cancelled", writes abort.
    promptHandler = (id, api) => {
      activePromptId = id;
      api.sendToHost({
        jsonrpc: "2.0",
        id: 7002,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "tc-2", kind: "execute", title: "Second tool" },
          options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow once" }],
        },
      });
    };
    const second = await host.send({ id: "op-2", text: "Interrupt me" });
    if (second.outcome !== "turn-started") throw new Error("expected turn-started");
    await tick();
    const cancelBefore = cancelCount;
    const interruptPromise = host.interrupt(second.turnId);
    expect(cancelCount).toBe(cancelBefore + 1);
    expect(permissionResponses).toContainEqual({
      jsonrpc: "2.0",
      id: 7002,
      result: { outcome: { outcome: "cancelled" } },
    });
    fake.sendToHost({ jsonrpc: "2.0", id: activePromptId, result: { stopReason: "cancelled" } });
    await interruptPromise;
    expect((await host.health()).status).toBe("idle");

    // 3. 3-strike interrupt timeout releases host cleanly.
    promptHandler = (id) => { activePromptId = id; };
    const hung = await host.send({ id: "op-hung", text: "Hang forever" });
    if (hung.outcome !== "turn-started") throw new Error("expected turn-started");
    await expect(host.interrupt(hung.turnId)).rejects.toThrow(/did not stop within/);
    await expect(host.interrupt(hung.turnId)).rejects.toThrow(/did not stop within/);
    await expect(host.interrupt(hung.turnId)).rejects.toThrow(/after 3 session\/cancel requests; host released/);
    expect(["dead", "unhosted"]).toContain((await host.health()).status);

    // 4. Adopt via session/resume re-applies model & thought_level config options and appends session.resume.
    setConfigCalls.length = 0;
    const resumed = await AntigravityAcpHost.adopt(sessionId, makeOpts({ model: "gemini-4-neon", effort: "xhigh" }));
    expect(fake.received.some((m) => m.method === "session/resume")).toBe(true);
    expect(setConfigCalls).toEqual([
      { configId: "model", value: "gemini-4-neon" },
      { configId: "thought_level", value: "xhigh" },
    ]);
    const resumedRecords = fs.readFileSync(resumed.identity.path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string });
    expect(resumedRecords.some((r) => r.type === "session.resume")).toBe(true);
    await resumed.release();
  });

  it("routes busy sends through interrupt-then-turn-started (never steered), enforces automated-sender queue default, and admits durable kill/reconfigure", async () => {
    const sessionId = crypto.randomUUID();
    const conversationId = `conversation_${crypto.randomUUID()}` as const;
    const eventStore = new FileRuntimeEventStore(path.join(stateDir, "events-queue"));
    const journalPath = path.join(stateDir, "runtime.sqlite");
    const journal = new RuntimeJournal(journalPath, { structuredHosts: true });

    let fake!: ReturnType<typeof makeFakeAcpChild>;
    let activePromptId: number | null = null;
    const sentPrompts: Array<{ id: number; text: string }> = [];
    let cancelCount = 0;

    const host = await AntigravityAcpHost.start({
      cwd,
      antigravityHome,
      accountId: "default",
      model: "gemini-3.8-flash",
      effort: "low",
      allowAll: true,
      viewerMcpServer: null,
      eventStore,
      interruptTimeoutMs: 500,
      shutdownGraceMs: 40,
      processIdentity: () => "start-ag-queue",
      signalProcess: ((_pid: number) => { fake.closeChild(0); return true; }) as typeof process.kill,
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
            activePromptId = id;
            const blocks = (msg.params as { prompt?: Array<{ text?: string }> }).prompt ?? [];
            sentPrompts.push({ id, text: blocks.map((b) => b.text ?? "").join("") });
            api.sendToHost({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } },
              },
            });
          } else if (method === "session/cancel") {
            cancelCount += 1;
            if (activePromptId !== null) {
              const cancelledId = activePromptId;
              activePromptId = null;
              api.sendToHost({ jsonrpc: "2.0", id: cancelledId, result: { stopReason: "cancelled" } });
            }
          }
        });
        return fake.child;
      },
    });

    const killedKeys: Array<{ engine: string; sessionId: string }> = [];
    const queue = new StructuredDeliveryQueue(
      journalPort(journal),
      () => host,
      async (_convId, sessionKey) => {
        killedKeys.push(sessionKey);
        await host.release();
        return true;
      },
    );

    try {
      journal.append({
        scope: { type: "session", id: conversationId },
        kind: "session-status",
        payload: {
          conversationId,
          sessionKey: { engine: "antigravity", sessionId },
          hostKind: "antigravity-acp",
          host: "hosted",
          turn: "idle",
          activeTurnId: null,
          writerClaim: "claim-ag:1",
          provenance: "structured",
          capabilities: { steer: false, steerMode: "interrupt", structuredAttention: true },
        },
      });

      // A. Automated-sender default policy matrix.
      expect(defaultStructuredSendPolicy({ origin: { kind: "agent", role: "pipeline", conversationId } }, "antigravity")).toBe("queue");
      expect(defaultStructuredSendPolicy({ origin: { kind: "agent", role: "seat-tick" } }, "antigravity")).toBe("queue");
      expect(defaultStructuredSendPolicy({ origin: { kind: "operator" } }, "antigravity")).toBe("interrupt-active");
      expect(defaultStructuredSendPolicy({}, "antigravity")).toBe("interrupt-active");
      expect(defaultStructuredSendPolicy({ kind: "steer", origin: { kind: "agent", role: "pipeline" } }, "antigravity")).toBe("interrupt-active");
      expect(defaultStructuredSendPolicy({ policy: "interrupt-active", origin: { kind: "agent", role: "pipeline" } }, "antigravity")).toBe("interrupt-active");
      expect(defaultStructuredSendPolicy({ origin: { kind: "agent", role: "pipeline" } }, "codex")).toBe("interrupt-active");

      // B. Start turn 1 via queue.
      const op1 = `op-t1-${crypto.randomUUID().slice(0, 8)}`;
      journal.executeOperation({
        kind: "send",
        operationId: op1,
        idempotencyKey: op1,
        conversationId,
        text: "First long turn",
        contentDigest: structuredContent("First long turn", []).contentDigest,
        policy: "interrupt-active",
      });
      await queue.drain();
      const t1Receipt = journal.operationResult(op1)!.receipt;
      expect(t1Receipt.status).toBe("delivered");
      expect(t1Receipt.turnId).toBeTruthy();
      const firstTurnId = t1Receipt.turnId!;

      // C. Automated-sender queued send (`policy: "queue"`) MUST NOT interrupt active turn 1.
      const opQueued = `op-q-${crypto.randomUUID().slice(0, 8)}`;
      journal.executeOperation({
        kind: "send",
        operationId: opQueued,
        idempotencyKey: opQueued,
        conversationId,
        text: "Automated queued note",
        contentDigest: structuredContent("Automated queued note", []).contentDigest,
        policy: defaultStructuredSendPolicy({ origin: { kind: "agent", role: "pipeline" } }, "antigravity"),
        origin: { kind: "agent", role: "pipeline" },
      });
      await queue.drain();
      expect(cancelCount).toBe(0);
      expect(journal.operationResult(opQueued)!.receipt.status).toBe("queued");

      // D. `policy: "steer-or-queue"` MUST ALSO queue without interrupting (`supportsSteer === false`).
      const opSteerOrQueue = `op-soq-${crypto.randomUUID().slice(0, 8)}`;
      journal.executeOperation({
        kind: "send",
        operationId: opSteerOrQueue,
        idempotencyKey: opSteerOrQueue,
        conversationId,
        text: "Steer or queue note",
        contentDigest: structuredContent("Steer or queue note", []).contentDigest,
        policy: "steer-or-queue",
      });
      await queue.drain();
      expect(cancelCount).toBe(0);
      expect(journal.operationResult(opSteerOrQueue)!.receipt.status).toBe("queued");

      // Finish turn 1 -> queued sends drain cleanly in order without interruption.
      fake.sendToHost({ jsonrpc: "2.0", id: activePromptId!, result: { stopReason: "end_turn" } });
      await new Promise((r) => setTimeout(r, 20));
      await queue.drain();
      expect(journal.operationResult(opQueued)!.receipt.status).toBe("delivered");
      expect(journal.operationResult(opQueued)!.receipt.delivery ?? null).toBeNull();
      const secondTurnId = journal.operationResult(opQueued)!.receipt.turnId!;
      expect(secondTurnId).not.toBe(firstTurnId);

      // E. Concurrent mid-turn `steer` + `interrupt-active` -> interrupts active turn, reports
      //    `delivery: "interrupt-then-turn-started"` + `interruptedTurnId`, NEVER `steered`.
      const opInterrupt = `op-int-${crypto.randomUUID().slice(0, 8)}`;
      journal.executeOperation({
        kind: "steer",
        operationId: opInterrupt,
        idempotencyKey: opInterrupt,
        conversationId,
        text: "Urgent steer via interrupt",
        contentDigest: structuredContent("Urgent steer via interrupt", []).contentDigest,
        policy: "steer-if-active",
      });
      // Drain `opSteerOrQueue` first? Let's complete opQueued so opSteerOrQueue starts, then interrupt opSteerOrQueue!
      fake.sendToHost({ jsonrpc: "2.0", id: activePromptId!, result: { stopReason: "end_turn" } });
      await new Promise((r) => setTimeout(r, 20));
      await queue.drain();
      const opSoqReceipt = journal.operationResult(opSteerOrQueue)!.receipt;
      expect(opSoqReceipt.status).toBe("delivered");
      const interruptedTargetTurn = opSoqReceipt.turnId!;

      // Drain opInterrupt while opSteerOrQueue's turn is active!
      await queue.drain();
      const intReceipt = journal.operationResult(opInterrupt)!.receipt;
      expect(cancelCount).toBe(1);
      expect(intReceipt.status).toBe("delivered");
      expect(intReceipt.delivery).toBe("interrupt-then-turn-started");
      expect(intReceipt.interruptedTurnId).toBe(interruptedTargetTurn);
      expect(intReceipt.status as string).not.toBe("steered");

      // Second SQLite connection sees committed `delivery` and `interruptedTurnId` immediately.
      const reader = new Database(journalPath, { readonly: true });
      try {
        const row = reader.query<{ receipt_json: string }, [string]>(
          "SELECT receipt_json FROM operations WHERE operation_id = ?",
        ).get(opInterrupt);
        expect(row).not.toBeNull();
        const parsed = JSON.parse(row!.receipt_json) as { status?: string; delivery?: string; interruptedTurnId?: string };
        expect(parsed.status).toBe("delivered");
        expect(parsed.delivery).toBe("interrupt-then-turn-started");
        expect(parsed.interruptedTurnId).toBe(interruptedTargetTurn);
      } finally {
        reader.close();
      }

      // F. Durable `runtime.kill` with `{ engine: "antigravity", sessionId }` passes journal + queue!
      const opKill = `op-kill-${crypto.randomUUID().slice(0, 8)}`;
      const killAdmitted = journal.executeOperation({
        kind: "kill",
        operationId: opKill,
        idempotencyKey: opKill,
        conversationId,
        sessionKey: { engine: "antigravity", sessionId },
        origin: { kind: "operator" },
      });
      expect(killAdmitted.receipt.status).toBe("queued");
      await queue.drain();
      expect(killedKeys).toEqual([{ engine: "antigravity", sessionId }]);
      expect(journal.operationResult(opKill)!.receipt.status).toBe("delivered");

      // G. `pathAllowed` permits Antigravity transcripts under the isolated default sessions root.
      const expectedTranscript = path.join(antigravityDefaultSessionsDir(), sessionId, "events.jsonl");
      fs.mkdirSync(path.dirname(expectedTranscript), { recursive: true });
      fs.writeFileSync(expectedTranscript, `${JSON.stringify({ type: "session.start" })}\n`);
      expect(pathAllowed(expectedTranscript)).toBe(true);
    } finally {
      await host.release().catch(() => {});
      journal.close();
    }
  });

  it("admits Antigravity reconfigure, refuses Antigravity account switch & compact with 409, and resolves message_receipt", async () => {
    const registry = new AgentRegistry(path.join(stateDir, "agent-registry.json"), undefined, undefined, {
      sqliteMode: "sqlite",
      sqliteFilename: path.join(stateDir, "agent-registry.sqlite"),
    });
    const journal = new RuntimeJournal(path.join(stateDir, "runtime-controls.sqlite"), { structuredHosts: true });
    const sessionId = crypto.randomUUID();
    const transcriptPath = path.join(antigravityDefaultSessionsDir(), sessionId, "events.jsonl");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: "session.start", data: { sessionId, cwd } })}\n`);

    try {
      const conv = registry.ensureConversation("antigravity", transcriptPath, "default");
      registry.upsert({
        key: { engine: "antigravity", sessionId },
        artifactPath: transcriptPath,
        cwd,
        accountId: "default",
        status: "live",
        host: null,
        structuredHost: {
          kind: "antigravity-acp",
          endpoint: "stdio:12345",
          process: { pid: 12345, startIdentity: "12345:ag", bootEpoch: "test" },
          protocolVersion: "1.5.14",
          writerClaimEpoch: 1,
          eventCursor: 2,
          activeTurnRef: null,
          pendingAttention: [],
          activeFlags: [],
        },
        claimEpoch: 1,
        claimOwner: "structured-host:antigravity",
        pendingAction: null,
      });

      const inProcessClient = {
        command: async (cmd: RuntimeOperationCommand) => journal.executeOperation(cmd),
        operationStatus: async (id: string) => journal.operationResult(id),
        effectBatch: async (kinds: readonly string[], afterSeq: number) => journal.effectBatch(100, kinds, afterSeq),
        readSession: async (target: { conversationId?: string }) => journal.readSession(target),
      } as unknown as RuntimeHostClient;

      journal.append({
        scope: { type: "session", id: conv.id },
        kind: "session-status",
        payload: {
          conversationId: conv.id,
          sessionKey: { engine: "antigravity", sessionId },
          hostKind: "antigravity-acp",
          host: "hosted",
          turn: "idle",
          activeTurnId: null,
          writerClaim: "structured-host:antigravity",
          provenance: "structured",
          capabilities: { steer: false, steerMode: "interrupt", structuredAttention: true },
        },
      });

      // 1. Account switch on Antigravity refused with 409 unsupported-capability (both at route control & executor).
      const acctSwitch = await dispatchStructuredControl({
        path: transcriptPath,
        conversationId: conv.id,
        action: "reconfigure",
        reconfiguration: { model: "gemini-4-neon", effort: "high", accountId: "other-account" },
      }, { registry, client: inProcessClient, enabled: () => true, kick: () => {} });
      expect(acctSwitch?.status).toBe(409);
      expect((acctSwitch?.body as { code?: string }).code).toBe("unsupported-capability");

      await expect(applyStructuredReconfigure({
        operationId: "op-reconf-acct",
        conversationId: conv.id,
        kind: "reconfigure",
        sessionKey: { engine: "antigravity", sessionId },
        model: "gemini-4-neon",
        effort: "high",
        fast: null,
        accountId: "other-account",
        eventSeq: 1,
      }, { registry })).rejects.toThrow(/signed-in account; account changes are not supported/i);

      // 2. Compact on Antigravity refused with 409 unsupported-capability.
      const compactRes = await dispatchStructuredControl({
        path: transcriptPath,
        conversationId: conv.id,
        action: "compact",
      }, { registry, client: inProcessClient, enabled: () => true, kick: () => {} });
      expect(compactRes?.status).toBe(409);
      expect((compactRes?.body as { code?: string }).code).toBe("unsupported-capability");

      // 3. Valid model/effort reconfigure on Antigravity admitted into RuntimeJournal!
      const reconfRes = await dispatchStructuredControl({
        path: transcriptPath,
        conversationId: conv.id,
        action: "reconfigure",
        operationId: "op-reconf-ok",
        reconfiguration: { model: "gemini-4-neon", effort: "high" },
      }, { registry, client: inProcessClient, enabled: () => true, kick: () => {} });
      expect(reconfRes?.status).toBe(202);
      expect(journal.operationResult("op-reconf-ok")?.receipt.status).toBe("queued");

      // 3b. Kill control on Antigravity admitted into RuntimeJournal with a queued runtime.kill effect!
      const killRes = await dispatchStructuredControl({
        path: transcriptPath,
        conversationId: conv.id,
        action: "kill",
      }, { registry, client: inProcessClient, enabled: () => true, kick: () => {} });
      expect(killRes?.status).toBe(202);
      const killOpId = (killRes?.body as { operationId?: string }).operationId;
      expect(killOpId).toBeTruthy();
      expect(journal.effectBatch(100, ["runtime.kill"], 0).some((e) => e.payload.operationId === killOpId)).toBe(true);

      // 4. Send receipt settlement (`resolveSendReceipt`) reads `delivery: "interrupt-then-turn-started"` + `interruptedTurnId`.
      const { enqueueStructuredMessage } = await import("./structuredMessageDelivery");
      const enqueued = await enqueueStructuredMessage({
        conversationId: conv.id,
        path: transcriptPath,
        clientMessageId: "client-msg-receipt-ag",
        text: "Check receipt",
        policy: "interrupt-active",
      }, {
        registry: () => registry,
        client: () => inProcessClient,
        kick: () => {},
        republish: async () => true,
      });
      expect(enqueued?.ok).toBe(true);
      const opSend = enqueued && enqueued.ok ? enqueued.operationId : undefined;
      if (!opSend) throw new Error("expected enqueued operationId");
      journal.transitionOperation(opSend, "delivering", {
        delivery: "interrupt-then-turn-started",
        interruptedTurnId: "antigravity:1-aaaa",
      });
      journal.transitionOperation(opSend, "delivered", {
        turnId: "antigravity:2-bbbb",
        delivery: "interrupt-then-turn-started",
        interruptedTurnId: "antigravity:1-aaaa",
      });
      const resolved = await resolveSendReceipt(opSend, { registry, client: inProcessClient });
      expect(resolved?.state).toBe("delivered");
      expect(resolved?.delivery).toBe("interrupt-then-turn-started");
      expect(resolved?.interruptedTurnId).toBe("antigravity:1-aaaa");

      // 5. Structured host control ref & inventory admit "antigravity" and isolate mutated copies + second SQLite connection.
      const { readStructuredHostRecords, structuredHostKillRefFromRegistry } = await import("./structuredHostControl");
      const { captureProcessIdentity } = await import("@/lib/processIdentity");
      const selfIdentity = captureProcessIdentity(process.pid);
      registry.upsert({
        key: { engine: "antigravity", sessionId },
        artifactPath: transcriptPath,
        cwd,
        accountId: "default",
        status: "live",
        host: null,
        structuredHost: {
          kind: "antigravity-acp",
          endpoint: "in-process",
          process: selfIdentity,
          protocolVersion: "1.5.14",
          writerClaimEpoch: 1,
          eventCursor: 2,
          activeTurnRef: null,
          pendingAttention: [],
          activeFlags: [],
        },
        claimEpoch: 1,
        claimOwner: "structured-host:antigravity",
        pendingAction: null,
      });
      const reader = new AgentRegistry(path.join(stateDir, "agent-registry.json"), undefined, undefined, {
        sqliteMode: "sqlite",
        sqliteFilename: path.join(stateDir, "agent-registry.sqlite"),
      });
      try {
        const refResult = structuredHostKillRefFromRegistry(
          { engine: "antigravity", sessionId },
          { snapshot: () => reader.readOnlySnapshot(), owned: () => true },
        );
        expect(refResult.ok).toBe(true);
        if (refResult.ok) {
          expect(refResult.ref.engine).toBe("antigravity");
          expect(refResult.ref.sessionId).toBe(sessionId);
          expect(refResult.ref.conversationId).toBe(conv.id);
        }
        const records = readStructuredHostRecords({ snapshot: () => reader.readOnlySnapshot(), owned: () => true });
        expect(records.some((r) => r.engine === "antigravity" && r.sessionId === sessionId)).toBe(true);
        records.pop();
        const recordsAgain = readStructuredHostRecords({ snapshot: () => reader.readOnlySnapshot(), owned: () => true });
        expect(recordsAgain.some((r) => r.engine === "antigravity" && r.sessionId === sessionId)).toBe(true);
      } finally {
        reader.close();
      }
    } finally {
      registry.close();
      journal.close();
    }
  });

  it("defers delivered until ACP confirms acceptance and handles rejections, mid-turn rejections, lost replies, and deliveryEcho EIO", async () => {
    const scenarios = ["positive", "rejection", "mid-positive", "mid-rejection", "lost", "eio"] as const;
    for (const scenario of scenarios) {
      const subRoot = fs.mkdtempSync(path.join(root, `scenario-${scenario}-`));
      const subState = path.join(subRoot, "state");
      const subHome = path.join(subRoot, "antigravity");
      fs.mkdirSync(subState, { recursive: true });
      fs.mkdirSync(subHome, { recursive: true });
      process.env.LLV_STATE_DIR = subState;

      const sessionId = crypto.randomUUID();
      const eventStore = new FileRuntimeEventStore(path.join(subState, "structured-host-events"));
      const registry = new AgentRegistry(path.join(subState, "agent-registry.json"), undefined, undefined, {
        sqliteMode: "sqlite",
        sqliteFilename: path.join(subState, "agent-registry.sqlite"),
      });
      const journal = new RuntimeJournal(path.join(subState, "runtime.sqlite"), { structuredHosts: true });

      let fake!: ReturnType<typeof makeFakeAcpChild>;
      let lastPromptId = 0;
      let cancels = 0;
      let echoFailed = 0;
      let targetOpId = "";
      const prompts: string[] = [];

      const spawnFake = () => {
        fake = makeFakeAcpChild((msg, api) => {
          const id = msg.id as number | undefined;
          const method = msg.method as string | undefined;
          if (method === "initialize") api.sendToHost({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { version: "1.5.14" } } });
          else if (method === "session/new" || method === "session/resume") api.sendToHost({ jsonrpc: "2.0", id, result: { sessionId } });
          else if (method === "session/set_config_option" || method === "session/close") api.sendToHost({ jsonrpc: "2.0", id, result: {} });
          else if (method === "session/prompt" && id !== undefined) {
            lastPromptId = id;
            const text = ((msg.params as { prompt?: Array<{ text?: string }> }).prompt ?? []).map((b) => b.text ?? "").join("");
            prompts.push(text);
            if (text === "hold turn") {
              api.sendToHost({
                jsonrpc: "2.0",
                method: "session/update",
                params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "holding" } } },
              });
            }
          } else if (method === "session/cancel") {
            cancels += 1;
            api.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "cancelled" } });
          }
        });
        return fake.child;
      };

      const rawAppend = eventStore.append.bind(eventStore);
      eventStore.append = (sid, event) => {
        if (scenario === "eio" && targetOpId && event.kind === "item" && event.deliveryEcho?.operationId === targetOpId) {
          echoFailed += 1;
          throw Object.assign(new Error("fixture lost deliveryEcho"), { code: "EIO" });
        }
        rawAppend(sid, event);
      };

      let host: AntigravityAcpHost | null = await AntigravityAcpHost.start({
        cwd,
        antigravityHome: subHome,
        accountId: "default",
        model: "gemini-3.8-flash",
        effort: "low",
        allowAll: true,
        viewerMcpServer: null,
        eventStore,
        shutdownGraceMs: 40,
        interruptTimeoutMs: 500,
        processIdentity: () => `start-${scenario}`,
        signalProcess: (() => { fake.closeChild(0); return true; }) as typeof process.kill,
        spawnProcess: spawnFake,
      });

      const conv = registry.ensureConversation("antigravity", host.identity.path, "default");

      const inProcessClient = {
        command: async (command: RuntimeOperationCommand) => journal.executeOperation(command),
        operationStatus: async (operationId: string) => journal.operationResult(operationId),
        readSession: async (target: { conversationId?: string }) => journal.readSession(target),
        transitionOperation: async (
          id: string,
          status: Exclude<RuntimeReceiptStatus, "pending">,
          details?: RuntimeTransitionDetails,
          options?: RuntimeTransitionOptions,
        ) => journal.transitionOperation(id, status, details, options),
      } as unknown as RuntimeHostClient;

      journal.append({
        scope: { type: "session", id: conv.id },
        kind: "session-status",
        payload: {
          conversationId: conv.id,
          sessionKey: { engine: "antigravity", sessionId },
          hostKind: "antigravity-acp",
          host: "hosted",
          turn: "idle",
          activeTurnId: null,
          writerClaim: `claim-${scenario}:1`,
          provenance: "structured",
          capabilities: { steer: false, steerMode: "interrupt", structuredAttention: true },
        },
      });

      const queue = new StructuredDeliveryQueue(journalPort(journal, `claim-${scenario}:1`), () => host);
      const { enqueueStructuredMessage } = await import("./structuredMessageDelivery");
      const ports = {
        registry: () => registry,
        client: () => inProcessClient,
        kick: () => {},
        republish: async () => true,
      };

      try {
        let interruptedTurnId: string | null = null;
        if (scenario.startsWith("mid-")) {
          const parent = await enqueueStructuredMessage({
            conversationId: conv.id,
            path: host.identity.path,
            clientMessageId: `parent-${scenario}`,
            text: "hold turn",
            policy: "interrupt-active",
          }, ports);
          expect(parent?.ok).toBe(true);
          await queue.drain({ freshAdmission: true });
          interruptedTurnId = (await host.health()).activeTurnRef;
          expect(interruptedTurnId).toBeTruthy();
        }

        const admitted = await enqueueStructuredMessage({
          conversationId: conv.id,
          path: host.identity.path,
          clientMessageId: `key-${scenario}`,
          text: "target followup",
          policy: "interrupt-active",
        }, ports);
        expect(admitted?.ok).toBe(true);
        targetOpId = admitted && admitted.ok ? admitted.operationId : "";
        expect(targetOpId).toBeTruthy();

        await queue.drain({ freshAdmission: true });

        // BEFORE ACP replies: MUST NOT be terminal `delivered`.
        const beforeReceipt = await resolveSendReceipt(targetOpId, { registry, client: inProcessClient });
        expect(beforeReceipt?.state).toBe("in-flight");
        expect(journal.operationResult(targetOpId)?.receipt.status).toBe("delivering");

        // Trigger the ACP outcome.
        if (scenario === "rejection" || scenario === "mid-rejection") {
          fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, error: { code: -32000, message: "explicit decline" } });
        } else if (scenario === "lost") {
          fake.closeChild(1);
        } else {
          fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
        }
        await new Promise((r) => setTimeout(r, 40));

        const ownerEvidence = (await host.sessionMaterializationEvidence(targetOpId)).state;
        const afterReceipt = await resolveSendReceipt(targetOpId, { registry, client: inProcessClient });
        const runtimeStatus = journal.operationResult(targetOpId)?.receipt.status;
        const echoes = eventStore.load(sessionId).filter((e) => e.kind === "item" && e.deliveryEcho?.operationId === targetOpId).length;

        await host.release();
        host = await AntigravityAcpHost.adopt(sessionId, {
          cwd,
          antigravityHome: subHome,
          accountId: "default",
          eventStore,
          viewerMcpServer: null,
          shutdownGraceMs: 40,
          processIdentity: () => `adopted-${scenario}`,
          signalProcess: (() => { fake.closeChild(0); return true; }) as typeof process.kill,
          spawnProcess: spawnFake,
        });
        const adoptedEvidence = (await host.sessionMaterializationEvidence(targetOpId)).state;

        // Replay under same idempotency key never dispatches a second native prompt.
        const replay = await enqueueStructuredMessage({
          conversationId: conv.id,
          path: host.identity.path,
          clientMessageId: `key-${scenario}`,
          text: "target followup",
          policy: "interrupt-active",
        }, ports);
        if (scenario === "positive" || scenario === "mid-positive") {
          expect(replay).toMatchObject({ ok: true, operationId: targetOpId });
        } else if (scenario === "lost" || scenario === "eio") {
          expect(replay).toMatchObject({ ok: false, status: 409 });
          if (replay && "operationId" in replay && replay.operationId) {
            expect(replay.operationId).toBe(targetOpId);
          }
        } else {
          expect(replay && "operationId" in replay ? replay.operationId : "").toBe(targetOpId);
        }
        await queue.drain({ freshAdmission: true });
        expect(prompts.filter((p) => p === "target followup")).toHaveLength(1);

        if (scenario === "positive" || scenario === "mid-positive") {
          expect(ownerEvidence).toBe("materialized");
          expect(adoptedEvidence).toBe("materialized");
          expect(echoes).toBe(1);
          expect(runtimeStatus).toBe("delivered");
          expect(afterReceipt?.state).toBe("delivered");
          if (scenario === "mid-positive") {
            expect(cancels).toBe(1);
            expect(afterReceipt?.delivery).toBe("interrupt-then-turn-started");
            expect(afterReceipt?.interruptedTurnId).toBe(interruptedTurnId ?? undefined);
          }
        } else if (scenario === "rejection" || scenario === "mid-rejection") {
          expect(ownerEvidence).toBe("failed");
          expect(adoptedEvidence).toBe("failed");
          expect(echoes).toBe(0);
          expect(runtimeStatus).toBe("failed");
          expect(afterReceipt?.state).toBe("failed");
          expect(afterReceipt?.delivery).toBeUndefined();
          expect(afterReceipt?.interruptedTurnId).toBeUndefined();
        } else {
          // `lost` and `eio` remain uncertain: NEVER delivered, NEVER safe blind resend.
          expect(ownerEvidence).toBe("unavailable");
          expect(adoptedEvidence).toBe("unavailable");
          expect(echoes).toBe(0);
          if (scenario === "eio") expect(echoFailed).toBe(1);
          expect(runtimeStatus).toBe("uncertain");
          expect(afterReceipt?.state).toBe("failed");
          expect(afterReceipt?.resend).toBe("verify-first");
          expect(afterReceipt?.duplicateRisk).toBe(true);
        }
      } finally {
        if (host) await host.release();
        registry.close();
        journal.close();
      }
    }
    process.env.LLV_STATE_DIR = stateDir;
  });

  it("reconciles an accepted Antigravity delivery via confirmedSend when a predecessor loses its final journal transition", async () => {
    const sessionId = crypto.randomUUID();
    const eventStore = new FileRuntimeEventStore(path.join(stateDir, "structured-host-events"));
    const registry = new AgentRegistry(path.join(stateDir, "agent-registry.json"), undefined, undefined, {
      sqliteMode: "sqlite",
      sqliteFilename: path.join(stateDir, "agent-registry.sqlite"),
    });
    const journal = new RuntimeJournal(path.join(stateDir, "runtime.sqlite"), { structuredHosts: true });

    let fake!: ReturnType<typeof makeFakeAcpChild>;
    let lastPromptId = 0;
    const prompts: string[] = [];
    const spawnFake = () => {
      fake = makeFakeAcpChild((msg, api) => {
        const id = msg.id as number | undefined;
        const method = msg.method as string | undefined;
        if (method === "initialize") api.sendToHost({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { version: "1.5.14" } } });
        else if (method === "session/new" || method === "session/resume") api.sendToHost({ jsonrpc: "2.0", id, result: { sessionId } });
        else if (method === "session/set_config_option" || method === "session/close") api.sendToHost({ jsonrpc: "2.0", id, result: {} });
        else if (method === "session/prompt" && id !== undefined) {
          lastPromptId = id;
          prompts.push(((msg.params as { prompt?: Array<{ text?: string }> }).prompt ?? []).map((b) => b.text ?? "").join(""));
        }
      });
      return fake.child;
    };

    let host = await AntigravityAcpHost.start({
      cwd,
      antigravityHome,
      accountId: "default",
      model: "gemini-3.8-flash",
      effort: "low",
      allowAll: true,
      viewerMcpServer: null,
      eventStore,
      shutdownGraceMs: 40,
      processIdentity: () => "start-handoff",
      signalProcess: (() => { fake.closeChild(0); return true; }) as typeof process.kill,
      spawnProcess: spawnFake,
    });

    const conv = registry.ensureConversation("antigravity", host.identity.path, "default");

    const inProcessClient = {
      command: async (command: RuntimeOperationCommand) => journal.executeOperation(command),
      operationStatus: async (operationId: string) => journal.operationResult(operationId),
      readSession: async (target: { conversationId?: string }) => journal.readSession(target),
      transitionOperation: async (
        id: string,
        status: Exclude<RuntimeReceiptStatus, "pending">,
        details?: RuntimeTransitionDetails,
        options?: RuntimeTransitionOptions,
      ) => journal.transitionOperation(id, status, details, options),
    } as unknown as RuntimeHostClient;

    journal.append({
      scope: { type: "session", id: conv.id },
      kind: "session-status",
      payload: {
        conversationId: conv.id,
        sessionKey: { engine: "antigravity", sessionId },
        hostKind: "antigravity-acp",
        host: "hosted",
        turn: "idle",
        activeTurnId: null,
        writerClaim: "predecessor:1",
        provenance: "structured",
        capabilities: { steer: false, steerMode: "interrupt", structuredAttention: true },
      },
    });

    const { enqueueStructuredMessage } = await import("./structuredMessageDelivery");
    const { readConfirmedSendEvidence } = await import("./confirmedSend");

    try {
      const admitted = await enqueueStructuredMessage({
        conversationId: conv.id,
        path: host.identity.path,
        clientMessageId: "handoff-op-key",
        text: "handoff message",
        policy: "interrupt-active",
      }, { registry: () => registry, client: () => inProcessClient, kick: () => {}, republish: async () => true });
      expect(admitted?.ok).toBe(true);
      const opId = admitted && admitted.ok ? admitted.operationId : "";

      // Predecessor queue drops the final `delivered` journal transition after ACP accepted + wrote deliveryEcho.
      const predecessor = new StructuredDeliveryQueue({
        ...journalPort(journal, "predecessor:1"),
        transition: async (id, status, details, options) => {
          if (id === opId && status === "delivered") {
            throw new Error("fixture predecessor crash before final delivered transition");
          }
          journal.transitionOperation(id, status, details, options);
        },
      }, () => host);

      await predecessor.drain({ freshAdmission: true });
      fake.sendToHost({ jsonrpc: "2.0", id: lastPromptId, result: { stopReason: "end_turn" } });
      await new Promise((r) => setTimeout(r, 40));

      expect(journal.operationResult(opId)?.receipt.status).toBe("delivering");
      expect((await host.sessionMaterializationEvidence(opId)).state).toBe("materialized");

      const proof = await readConfirmedSendEvidence(registry.readOnlySnapshot(), opId, true);
      expect(proof).toMatchObject({ source: "antigravity-ledger", sessionId });
      const proofTurnId = proof?.turnId ?? "";
      expect(proofTurnId).toBeTruthy();

      await host.release();

      // Append 4,096 extra deliveries to the session ledger, adopt(), and verify BOTH
      // readConfirmedSendEvidence and resolveSendReceipt resolve in O(1) with 0 ledger scans!
      const recorded = eventStore.load(sessionId);
      const turnEvents = recorded.filter((e) => "turnId" in e && e.turnId === proofTurnId);
      expect(turnEvents.some((e) => e.kind === "item" && e.deliveryEcho?.operationId === opId)).toBe(true);
      const extraLines: string[] = [];
      let nextSeq = recorded.at(-1)!.seq;
      for (let i = 0; i < 4096; i += 1) {
        for (const ev of turnEvents) {
          extraLines.push(
            JSON.stringify({ ...ev, seq: ++nextSeq })
              .replaceAll(proofTurnId, `handoff-later-turn-${i}`)
              .replaceAll(opId, `handoff-later-op-${i}`),
          );
        }
      }
      fs.appendFileSync(path.join(stateDir, "structured-host-events", `${sessionId}.jsonl`), `${extraLines.join("\n")}\n`);

      host = await AntigravityAcpHost.adopt(sessionId, {
        cwd,
        antigravityHome,
        accountId: "default",
        eventStore,
        viewerMcpServer: null,
        shutdownGraceMs: 40,
        processIdentity: () => "successor-handoff",
        signalProcess: (() => { fake.closeChild(0); return true; }) as typeof process.kill,
        spawnProcess: spawnFake,
      });

      const scanCalls: number[] = [];
      const origProtoScan = FileRuntimeEventStore.prototype.scan;
      FileRuntimeEventStore.prototype.scan = async function scanSpy(sid, visit) {
        let count = 0;
        const result = await origProtoScan.call(this, sid, (ev) => { count += 1; visit(ev); });
        scanCalls.push(count);
        return result;
      };
      try {
        const fastProof = await readConfirmedSendEvidence(registry.readOnlySnapshot(), opId, true);
        expect(fastProof).toMatchObject({ source: "antigravity-ledger", sessionId, turnId: proof!.turnId });
        const fastReceipt = await resolveSendReceipt(opId, { registry, client: inProcessClient });
        expect(fastReceipt?.state).toBe("delivered");
        expect(scanCalls).toEqual([]);
      } finally {
        FileRuntimeEventStore.prototype.scan = origProtoScan;
      }

      const successor = new StructuredDeliveryQueue({
        ...journalPort(journal, "successor:2"),
        confirmedDelivery: (id) => readConfirmedSendEvidence(registry.readOnlySnapshot(), id, true),
      }, () => host);
      await successor.drain({ freshAdmission: true });

      expect(journal.operationResult(opId)?.receipt.status).toBe("delivered");
      const receipt = await resolveSendReceipt(opId, { registry, client: inProcessClient });
      expect(receipt?.state).toBe("delivered");
      expect(prompts).toEqual(["handoff message"]);
      expect(eventStore.load(sessionId).filter((e) => e.kind === "item" && e.deliveryEcho?.operationId === opId)).toHaveLength(1);
    } finally {
      await host.release();
      registry.close();
      journal.close();
    }
  });

  it("applies idle Antigravity reconfigure in place without restarting, rolls back on partial ACP refusal (or restarts if rollback fails), and falls back to restart when unhosted", async () => {
    const sessionId = crypto.randomUUID();
    const eventStore = new FileRuntimeEventStore(path.join(stateDir, "structured-host-events"));
    const registry = new AgentRegistry(path.join(stateDir, "agent-registry.json"), undefined, undefined, {
      sqliteMode: "sqlite",
      sqliteFilename: path.join(stateDir, "agent-registry.sqlite"),
    });
    const journal = new RuntimeJournal(path.join(stateDir, "runtime.sqlite"), { structuredHosts: true });

    let fake!: ReturnType<typeof makeFakeAcpChild>;
    let starts = 0;
    let resumes = 0;
    let releases = 0;
    let rejectConfigRule: ((configId: string, value: string) => boolean) | null = null;
    const activeNative: { model: string | null; effort: string | null } = { model: null, effort: null };
    const seenPromptSettings: Array<{ model: string | null; effort: string | null }> = [];
    const configCalls: Array<{ configId: string; value: string }> = [];

    const spawnFake = () => {
      starts += 1;
      activeNative.model = null;
      activeNative.effort = null;
      fake = makeFakeAcpChild((msg, api) => {
        const id = msg.id as number | undefined;
        const method = msg.method as string | undefined;
        if (method === "initialize") api.sendToHost({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { version: "1.5.14" } } });
        else if (method === "session/new") api.sendToHost({ jsonrpc: "2.0", id, result: { sessionId } });
        else if (method === "session/resume") { resumes += 1; api.sendToHost({ jsonrpc: "2.0", id, result: { sessionId } }); }
        else if (method === "session/set_config_option") {
          const params = msg.params as { configId: string; value: string };
          if (rejectConfigRule?.(params.configId, params.value)) {
            api.sendToHost({ jsonrpc: "2.0", id, error: { code: -32602, message: `unsupported ${params.configId}` } });
            return;
          }
          configCalls.push({ configId: params.configId, value: params.value });
          if (params.configId === "model") activeNative.model = params.value;
          if (params.configId === "thought_level") activeNative.effort = params.value;
          api.sendToHost({ jsonrpc: "2.0", id, result: {} });
        } else if (method === "session/prompt" && id !== undefined) {
          seenPromptSettings.push({ model: activeNative.model, effort: activeNative.effort });
          api.sendToHost({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
        } else if (method === "session/close") api.sendToHost({ jsonrpc: "2.0", id, result: {} });
      });
      return fake.child;
    };

    let liveHost: AntigravityAcpHost | null = await AntigravityAcpHost.start({
      cwd,
      antigravityHome,
      accountId: "default",
      model: "gemini-3.8-flash",
      effort: "low",
      allowAll: true,
      viewerMcpServer: null,
      eventStore,
      shutdownGraceMs: 40,
      processIdentity: () => "reconf-init",
      signalProcess: (() => { fake.closeChild(0); return true; }) as typeof process.kill,
      spawnProcess: spawnFake,
    });
    const begun = registry.beginSpawnRequest({
      engine: "antigravity",
      cwd,
      transport: "structured",
      accountId: "default",
      launchProfile: { title: "Antigravity reconfigure fixture", model: "gemini-3.8-flash", effort: "low", fast: false },
    });
    if (begun.kind !== "created") throw new Error("reconfigure fixture spawn admission failed");
    const convId = begun.receipt.conversationId;
    const startHost = (resume: boolean) => {
      const opts: AntigravityAcpHostOptions = {
        cwd,
        antigravityHome,
        accountId: "default",
        model: registry.conversation(convId)?.generations.at(-1)?.launchProfile?.model ?? "gemini-3.8-flash",
        effort: registry.conversation(convId)?.generations.at(-1)?.launchProfile?.effort ?? "low",
        allowAll: true,
        viewerMcpServer: null,
        eventStore,
        shutdownGraceMs: 40,
        processIdentity: () => `reconf-${starts}`,
        signalProcess: (() => { fake.closeChild(0); return true; }) as typeof process.kill,
        spawnProcess: spawnFake,
      };
      return resume ? AntigravityAcpHost.adopt(sessionId, opts) : AntigravityAcpHost.start(opts);
    };
    const transcriptPath = liveHost.identity.path;
    registry.completeSpawn(begun.receipt.launchId, {
      key: { engine: "antigravity", sessionId },
      artifactPath: transcriptPath,
      cwd,
      accountId: "default",
      launchProfile: begun.receipt.launchProfile,
      status: "live",
      host: null,
      structuredHost: {
        kind: "antigravity-acp",
        endpoint: "stdio:12346",
        process: { pid: 12346, startIdentity: "reconf-init", bootEpoch: "test" },
        protocolVersion: "1.5.14",
        writerClaimEpoch: 1,
        eventCursor: 2,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 1,
      claimOwner: "reconf:1",
      pendingAction: null,
    });

    const inProcessClient = {
      command: async (cmd: RuntimeOperationCommand) => journal.executeOperation(cmd),
      operationStatus: async (id: string) => journal.operationResult(id),
      effectBatch: async (kinds: readonly string[], afterSeq: number) => journal.effectBatch(100, kinds, afterSeq),
      readSession: async (target: { conversationId?: string }) => journal.readSession(target),
    } as unknown as RuntimeHostClient;

    journal.append({
      scope: { type: "session", id: convId },
      kind: "session-status",
      payload: {
        conversationId: convId,
        sessionKey: { engine: "antigravity", sessionId },
        hostKind: "antigravity-acp",
        host: "hosted",
        turn: "idle",
        activeTurnId: null,
        writerClaim: "reconf:1",
        provenance: "structured",
        capabilities: { steer: false, steerMode: "interrupt", structuredAttention: true },
      },
    });

    const queue = new StructuredDeliveryQueue(
      journalPort(journal, "reconf:1"),
      () => liveHost,
      undefined,
      () => {},
      null,
      (effect, ownership) => applyStructuredReconfigure(effect, {
        registry,
        ownsOperation: ownership.isCurrent,
        carriedSends: ownership.carriedSends,
        pipelineSwitch: async () => null,
        releaseHost: async () => {
          releases += 1;
          if (liveHost) { await liveHost.release(); liveHost = null; return true; }
          return false;
        },
        recover: (async () => {
          liveHost = await startHost(true);
          return { ok: true, spawned: true, reconnected: false, conversationId: convId, path: liveHost.identity.path };
        }) as unknown as NonNullable<Parameters<typeof applyStructuredReconfigure>[1]>["recover"],
      }),
    );

    const admitReconfigure = async (operationId: string, model: string, effort: string) => {
      const res = await dispatchStructuredControl({
        path: transcriptPath,
        conversationId: convId,
        action: "reconfigure",
        operationId,
        reconfiguration: { model, effort },
      }, { registry, client: inProcessClient, enabled: () => true, kick: () => {} });
      expect(res?.status).toBe(202);
    };

    try {
      // 1. Live idle reconfigure -> 0 releases, 0 restarts, 0 resumes!
      const startsBeforeLive = starts;
      configCalls.length = 0;
      const opLive = `op-reconf-live-${crypto.randomUUID().slice(0, 8)}`;
      await admitReconfigure(opLive, "gemini-4-neon", "high");
      await queue.drain({ freshAdmission: true });
      expect(journal.operationResult(opLive)?.receipt).toMatchObject({ status: "applied" });
      expect(registry.conversation(convId)?.reconfigure?.status).toBe("applied");
      expect(registry.conversation(convId)?.generations.at(-1)?.launchProfile).toMatchObject({ model: "gemini-4-neon", effort: "high" });
      expect(releases).toBe(0);
      expect(starts - startsBeforeLive).toBe(0);
      expect(resumes).toBe(0);
      expect(configCalls).toEqual([
        { configId: "model", value: "gemini-4-neon" },
        { configId: "thought_level", value: "high" },
      ]);

      // 2. Explicit ACP refusal on first option (`model`) -> fails, rolls back launchProfile, 0 restarts!
      rejectConfigRule = (configId) => {
        if (configId === "model") {
          rejectConfigRule = null;
          return true;
        }
        return false;
      };
      const opBad = `op-reconf-bad-${crypto.randomUUID().slice(0, 8)}`;
      await admitReconfigure(opBad, "gemini-4-argon", "medium");
      await queue.drain({ freshAdmission: true });
      expect(journal.operationResult(opBad)?.receipt.status).toBe("failed");
      expect(registry.conversation(convId)?.reconfigure?.status).toBe("failed");
      expect(registry.conversation(convId)?.generations.at(-1)?.launchProfile).toMatchObject({ model: "gemini-4-neon", effort: "high" });
      expect(releases).toBe(0);
      expect(starts - startsBeforeLive).toBe(0);
      await liveHost!.send({ id: "probe-after-model-refusal", text: "probe settings" });
      await new Promise((r) => setTimeout(r, 25));
      expect(seenPromptSettings.at(-1)).toEqual({ model: "gemini-4-neon", effort: "high" });

      // 2b. Partial live-reconfigure refusal (`model` accepted, `thought_level` refused):
      //     host rolls live ACP model + effort back to previous profile with 0 restarts so
      //     the next prompt never drifts from the rolled-back registry profile.
      rejectConfigRule = (configId, value) => {
        if (configId === "thought_level" && value === "medium") {
          rejectConfigRule = null;
          return true;
        }
        return false;
      };
      const opPartial = `op-reconf-partial-${crypto.randomUUID().slice(0, 8)}`;
      await admitReconfigure(opPartial, "gemini-3.8-flash", "medium");
      await queue.drain({ freshAdmission: true });
      expect(journal.operationResult(opPartial)?.receipt.status).toBe("failed");
      expect(registry.conversation(convId)?.reconfigure?.status).toBe("failed");
      expect(registry.conversation(convId)?.generations.at(-1)?.launchProfile).toMatchObject({ model: "gemini-4-neon", effort: "high" });
      expect(releases).toBe(0);
      expect(starts - startsBeforeLive).toBe(0);
      expect({ model: activeNative.model, effort: activeNative.effort }).toEqual({ model: "gemini-4-neon", effort: "high" });
      await liveHost!.send({ id: "probe-after-partial-rollback", text: "probe settings" });
      await new Promise((r) => setTimeout(r, 25));
      expect(seenPromptSettings.at(-1)).toEqual({ model: "gemini-4-neon", effort: "high" });

      // 2c. Partial live-reconfigure where live rollback ALSO fails:
      //     executor releases drifted host and recovers onto the rolled-back registry profile!
      let rejectedEffortOnce = false;
      rejectConfigRule = (configId, value) => {
        if (configId === "thought_level" && value === "medium" && !rejectedEffortOnce) {
          rejectedEffortOnce = true;
          return true;
        }
        if (rejectedEffortOnce && configId === "model" && value === "gemini-4-neon") {
          rejectConfigRule = null;
          return true;
        }
        return false;
      };
      const releasesBeforeFallback = releases;
      const resumesBeforeFallback = resumes;
      const opRollbackFail = `op-reconf-rollback-fail-${crypto.randomUUID().slice(0, 8)}`;
      await admitReconfigure(opRollbackFail, "gemini-3.8-flash", "medium");
      await queue.drain({ freshAdmission: true });
      expect(journal.operationResult(opRollbackFail)?.receipt.status).toBe("failed");
      expect(registry.conversation(convId)?.reconfigure?.status).toBe("failed");
      expect(registry.conversation(convId)?.generations.at(-1)?.launchProfile).toMatchObject({ model: "gemini-4-neon", effort: "high" });
      expect(releases - releasesBeforeFallback).toBe(1);
      expect(resumes - resumesBeforeFallback).toBe(1);
      expect({ model: activeNative.model, effort: activeNative.effort }).toEqual({ model: "gemini-4-neon", effort: "high" });
      await liveHost!.send({ id: "probe-after-rollback-restart", text: "probe settings" });
      await new Promise((r) => setTimeout(r, 25));
      expect(seenPromptSettings.at(-1)).toEqual({ model: "gemini-4-neon", effort: "high" });

      // 3. Stopped / unhosted conversation -> falls back to recovery with session/resume!
      await liveHost!.release();
      liveHost = null;
      registry.terminateStructuredHost({ engine: "antigravity", sessionId });
      journal.append({
        scope: { type: "session", id: convId },
        kind: "session-status",
        payload: {
          conversationId: convId,
          sessionKey: { engine: "antigravity", sessionId },
          hostKind: "antigravity-acp",
          host: "unhosted",
          turn: "idle",
          activeTurnId: null,
          writerClaim: "reconf:1",
          provenance: "structured",
          capabilities: { steer: false, steerMode: "interrupt", structuredAttention: true },
        },
      });
      const startsBeforeRestart = starts;
      const resumesBeforeRestart = resumes;
      configCalls.length = 0;
      const opRestart = `op-reconf-restart-${crypto.randomUUID().slice(0, 8)}`;
      await admitReconfigure(opRestart, "gemini-4-argon", "medium");
      await queue.drain({ freshAdmission: true });
      expect(journal.operationResult(opRestart)?.receipt).toMatchObject({ status: "applied" });
      expect(registry.conversation(convId)?.generations.at(-1)?.launchProfile).toMatchObject({ model: "gemini-4-argon", effort: "medium" });
      expect(starts - startsBeforeRestart).toBe(1);
      expect(resumes - resumesBeforeRestart).toBe(1);
    } finally {
      if (liveHost) await liveHost.release();
      registry.close();
      journal.close();
    }
  });

  it("keeps host agentState promptOrdinal aligned with AgentTranscriptCache across rejected prompts and adopt()", async () => {
    const { AgentTranscriptCache } = await import("@/lib/agentState/transcript");
    const sessionId = crypto.randomUUID();
    const eventStore = new FileRuntimeEventStore(path.join(stateDir, "events-ordinal"));
    let fake!: ReturnType<typeof makeFakeAcpChild>;
    let promptHandler: ((id: number, api: { sendToHost: (msg: JsonObject) => void }) => void) | null = null;

    const makeOpts = (): AntigravityAcpHostOptions => ({
      cwd,
      antigravityHome,
      accountId: "default",
      model: "gemini-3.8-flash",
      effort: "low",
      allowAll: true,
      viewerMcpServer: null,
      eventStore,
      shutdownGraceMs: 40,
      processIdentity: () => "start-ordinal",
      signalProcess: (() => { fake.closeChild(0); return true; }) as typeof process.kill,
      spawnProcess: () => {
        fake = makeFakeAcpChild((msg, api) => {
          const id = msg.id as number | undefined;
          const method = msg.method as string | undefined;
          if (method === "initialize") api.sendToHost({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentInfo: { version: "1.5.14" } } });
          else if (method === "session/new" || method === "session/resume") api.sendToHost({ jsonrpc: "2.0", id, result: { sessionId } });
          else if (method === "session/set_config_option" || method === "session/close") api.sendToHost({ jsonrpc: "2.0", id, result: {} });
          else if (method === "session/prompt" && id !== undefined) promptHandler?.(id, api);
        });
        return fake.child;
      },
    });

    const tick = () => new Promise((r) => setTimeout(r, 25));
    const cache = new AgentTranscriptCache();
    let host = await AntigravityAcpHost.start(makeOpts());
    const compare = async (id: string) => {
      const h = await host.health();
      const proof = await cache.acquire({
        engine: "antigravity",
        path: host.identity.path,
        revision: `rev-${id}`,
        localRef: h.activeTurnRef,
        observedAt: Date.now(),
        anchor: h.agentStateNativePromptAnchor,
      });
      return {
        memory: host.agentStateMemory().promptOrdinal,
        health: h.agentStateNativePromptOrdinal,
        cachedOrdinal: proof.turn.determined ? proof.turn.value.promptOrdinal : null,
      };
    };

    try {
      let frame = 0;
      promptHandler = (id, api) => {
        frame = id;
        api.sendToHost({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first" } } } });
      };
      await host.send({ id: "ord-1", text: "first prompt" });
      await tick();
      expect(await compare("ord-1")).toEqual({ memory: 1, health: 1, cachedOrdinal: 1 });
      fake.sendToHost({ jsonrpc: "2.0", id: frame, result: { stopReason: "end_turn" } });
      await tick();

      // Explicit ACP rejection MUST NOT advance confirmed promptOrdinal.
      promptHandler = (id, api) => api.sendToHost({ jsonrpc: "2.0", id, error: { code: -32000, message: "fixture rejection" } });
      await host.send({ id: "ord-rejected", text: "rejected prompt" });
      await tick();

      promptHandler = (id, api) => {
        frame = id;
        api.sendToHost({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second" } } } });
      };
      await host.send({ id: "ord-2", text: "accepted after refusal" });
      await tick();
      expect(await compare("ord-2")).toEqual({ memory: 2, health: 2, cachedOrdinal: 2 });
      fake.sendToHost({ jsonrpc: "2.0", id: frame, result: { stopReason: "end_turn" } });
      await tick();

      // Across adopt() (session/resume), readNativePromptAnchor anchors at the
      // current transcript EOF so both host memory and AgentTranscriptCache count
      // confirmed starts after that anchor (starting at 1 for the first resumed turn).
      await host.release();
      host = await AntigravityAcpHost.adopt(sessionId, makeOpts());
      promptHandler = (id, api) => {
        frame = id;
        api.sendToHost({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "third" } } } });
      };
      await host.send({ id: "ord-3", text: "after adopt" });
      await tick();
      expect(await compare("ord-3")).toEqual({ memory: 1, health: 1, cachedOrdinal: 1 });
      fake.sendToHost({ jsonrpc: "2.0", id: frame, result: { stopReason: "end_turn" } });
      await tick();
    } finally {
      await host.release();
    }
  });
});
