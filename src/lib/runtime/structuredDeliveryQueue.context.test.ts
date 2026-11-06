import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RuntimeJournal } from "@/runtime-host/journal";
import { parseRuntimeCommand } from "./commands";
import { StructuredDispatchDeferredError, StructuredInjectError, StructuredSendRefusedError, type HostState } from "./engineHost";
import { FakeEngineHost, createFakeDeliveryLedger } from "./fixtures/fakeEngineHost";
import { StructuredDeliveryQueue, type StructuredDeliveryQueuePort } from "./structuredDeliveryQueue";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function rig(active = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-context-"));
  roots.push(root);
  let journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true, now: () => 1_000 });
  journal.append({ scope: { type: "session", id: "conv-context" }, kind: "session-status", payload: {
    conversationId: "conv-context", sessionKey: { engine: "codex", sessionId: "thread-context" },
    hostKind: "codex-app-server", host: "hosted", turn: active ? "running" : "idle",
    activeTurnId: active ? "turn-context" : null, writerClaim: "owner-context", provenance: "structured",
    capabilities: { steer: true, inject: true, nativeQueue: true, structuredAttention: true },
  } });
  const command = parseRuntimeCommand("send", { operationId: "op-context", conversationId: "conv-context",
    idempotencyKey: "key-context", text: "worker update", policy: "context-or-queue" });
  journal.executeOperation(command);
  const state: HostState = { status: active ? "active" : "idle", sessionKey: "thread-context",
    activeTurnRef: active ? "turn-context" : null, activeFlags: ["native-inject"], pendingAttention: [],
    endpoint: "fixture:context", pid: 1, processStartIdentity: "1", eventCursor: 0, protocolVersion: "fixture", account: null };
  const ledger = createFakeDeliveryLedger();
  const host = new FakeEngineHost(ledger, state);
  let interrupts = 0;
  host.interrupt = async () => { interrupts++; };
  const binding = { threadId: "thread-context", accountId: null, writerClaim: "owner-context" };
  const port: StructuredDeliveryQueuePort = {
    effects: async (kinds, after) => journal.effectBatch(100, kinds, after),
    status: async id => journal.operationResult(id)?.receipt ?? null,
    transition: async (id, status, details, options) => { journal.transitionOperation(id, status, details, options); },
    hostClaim: () => binding.writerClaim,
    injectionBinding: () => ({ ...binding }),
  };
  const queue = () => new StructuredDeliveryQueue(port, () => host);
  const idle = () => { state.status = "idle"; state.activeTurnRef = null; };
  return { root, get journal() { return journal; }, command, state, ledger, host, binding, port, queue, idle, interrupts: () => interrupts,
    reopen: () => { journal.close(); journal = new RuntimeJournal(path.join(root, "runtime.sqlite"), { structuredHosts: true, now: () => 1_000 }); },
    receipt: () => journal.operationResult("op-context")!.receipt };
}

test("context admission stays a send even with native queue support; dispatch injects once", async () => {
  const r = rig();
  try {
    expect(r.journal.effectBatch(10, ["runtime.native-queue"])).toEqual([]);
    await r.queue().drain();
    expect(r.ledger.injections.map(input => [input.operationId, input.expectedTurnId])).toEqual([["op-context", "turn-context"]]);
    expect(r.receipt()).toMatchObject({ status: "delivered", reason: expect.stringContaining("injected input"), idempotencyKey: "key-context" });
    r.idle();
    expect(r.journal.executeOperation(r.command).replayed).toBe(true);
    await r.queue().drain();
    expect(r.ledger.writes).toEqual([]);
    expect(r.ledger.injections).toHaveLength(1);
    expect(r.interrupts()).toBe(0);
  } finally { r.journal.close(); }
});

test("an idle context notification starts one ordinary wake", async () => {
  const r = rig(false);
  try {
    await r.queue().drain();
    await r.queue().drain();
    expect(r.ledger.writes.map(entry => entry.id)).toEqual(["op-context"]);
    expect(r.ledger.injections).toEqual([]);
    expect(r.receipt().status).toBe("delivered");
    expect(r.interrupts()).toBe(0);
  } finally { r.journal.close(); }
});

test.each(["fresh", "unknown", "revoked", "transport"] as const)("idle wake pre-write refusal preserves the %s outcome", async scenario => {
  const r = rig(false);
  try {
    if (scenario === "unknown") {
      r.journal.transitionOperation("op-context", "delivering");
      r.journal.transitionOperation("op-context", "queued", { deliveryUnverified: true });
      expect(r.receipt().deliveryUnverified).toBe(true);
    }
    r.host.send = async () => {
      r.state.status = "active";
      r.state.activeTurnRef = "turn-context";
      if (scenario === "transport") throw new Error("stale-turn");
      throw new StructuredSendRefusedError(scenario === "revoked" ? "authority revoked" : "stale-turn");
    };
    const queue = r.queue();
    await queue.drain();
    expect(r.receipt().status).toBe(scenario === "fresh" ? "queued" : scenario === "revoked" ? "failed" : "uncertain");
    expect(r.journal.executeOperation(r.command).replayed).toBe(true);
    await queue.drain();
    expect(r.ledger.injections).toHaveLength(scenario === "fresh" ? 1 : 0);
    expect(r.ledger.writes).toEqual([]);
    expect(r.interrupts()).toBe(0);
  } finally { r.journal.close(); }
});

test.each(["stale-turn", "unsupported-injection"])("a proven %s refusal retries the original wake without a pinned ended turn", async reason => {
  const r = rig();
  try {
    r.host.inject = async () => { r.idle(); throw new StructuredInjectError(reason, "refused"); };
    await r.queue().drain();
    expect(r.receipt().status).toBe("queued");
    expect(r.journal.effectBatch(10, ["runtime.send"])[0]!.payload.turnId).toBeUndefined();
    await r.queue().drain();
    expect(r.receipt().status).toBe("delivered");
    expect(r.ledger.writes.map(entry => entry.id)).toEqual(["op-context"]);
    expect(r.ledger.injections).toEqual([]);
  } finally { r.journal.close(); }
});

test.each(["unknown", "unobserved", "read-error"])("%s injection acknowledgement is absorbing and never falls back to a wake", async failure => {
  const r = rig();
  try {
    r.host.inject = async request => {
      r.ledger.injections.push(request);
      if (failure === "unknown") throw new StructuredInjectError("socket closed after write", "unverified");
      return { placement: "pending-input", turnId: "turn-context", observe: async () => {
        if (failure === "read-error") throw new Error("history unavailable");
        return false;
      } };
    };
    await r.queue().drain();
    expect(r.receipt().status).toBe("uncertain");
    r.idle();
    expect(r.journal.executeOperation(r.command).replayed).toBe(true);
    await r.queue().drain();
    expect(r.ledger.writes).toEqual([]);
    expect(r.ledger.injections).toHaveLength(1);
  } finally { r.journal.close(); }
});

test("canonical observation runs outside the delivery pass and keeps its delivering fence", async () => {
  const r = rig();
  let observed!: (value: boolean) => void;
  try {
    const evidence = new Promise<boolean>(resolve => { observed = resolve; });
    r.host.inject = async request => { r.ledger.injections.push(request); return {
      placement: "pending-input", turnId: "turn-context", observe: () => evidence,
    }; };
    const queue = r.queue();
    await queue.drain();
    expect(r.receipt()).toMatchObject({ status: "delivering", reason: expect.stringContaining("context:") });
    r.idle();
    await queue.drain();
    expect(r.ledger.writes).toEqual([]);
    expect(r.ledger.injections).toHaveLength(1);
    observed(true);
    await queue.drain();
    expect(r.receipt().status).toBe("delivered");
  } finally { observed?.(false); r.journal.close(); }
});

test.each(["capability", "claude", "attention"])("%s fallback waits for idle and never interrupts", async unavailable => {
  const r = rig();
  try {
    r.state.activeFlags = [];
    if (unavailable === "claude") Object.defineProperty(r.host, "supportsSteer", { value: false });
    if (unavailable === "attention") r.state.status = "attention";
    await r.queue().drain();
    expect(r.ledger.writes).toEqual([]);
    expect(r.ledger.injections).toEqual([]);
    r.idle();
    await r.queue().drain();
    expect(r.ledger.writes).toHaveLength(1);
    expect(r.interrupts()).toBe(0);
  } finally { r.journal.close(); }
});

test.each(["revoked", "drain", "binding-change", "binding-unreadable"])("%s at dispatch fences context writes", async fence => {
  const r = rig();
  try {
    if (fence === "revoked") r.port.seatRecipient = () => ({ kind: "revoked", reason: "seat retired" });
    if (fence === "drain") r.port.autonomousTurnHeld = () => true;
    if (fence === "drain") {
      // The real seat producer marks its notifications as agent work.
      const effects = r.port.effects;
      r.port.effects = async (...args) => (await effects(...args)).map(effect => ({ ...effect,
        payload: { ...effect.payload, origin: { kind: "agent", role: "seat-tick" } } }));
    }
    let reads = 0;
    if (fence === "binding-change") r.port.injectionBinding = () => ({ ...r.binding, writerClaim: ++reads === 1 ? "owner-context" : "successor-owner" });
    if (fence === "binding-unreadable") r.port.injectionBinding = () => { throw new Error("binding unavailable"); };
    await r.queue().drain();
    expect(r.ledger.writes).toEqual([]);
    expect(r.ledger.injections).toEqual([]);
  } finally { r.journal.close(); }
});

test.each(["seat", "account", "drain", "generation"])("%s changing during the delivering write prevents injection", async change => {
  const r = rig();
  let blocked = false;
  try {
    const effects = r.port.effects;
    r.port.effects = async (...args) => (await effects(...args)).map(effect => ({ ...effect,
      payload: { ...effect.payload, origin: { kind: "agent", role: "seat-tick" } } }));
    r.port.seatRecipient = () => blocked && change === "seat" ? { kind: "revoked", reason: "seat retired" } : { kind: "open" };
    r.port.autonomousTurnHeld = () => blocked && change === "drain";
    r.port.authorizeDispatch = () => {
      if (blocked && change === "account") throw new StructuredDispatchDeferredError("account switch pending");
    };
    const transition = r.port.transition;
    r.port.transition = async (...args) => {
      await transition(...args);
      if (args[1] === "delivering") {
        blocked = true;
        if (change === "generation") r.binding.writerClaim = "successor-owner";
      }
    };
    await r.queue().drain();
    expect(r.ledger.injections).toEqual([]);
    expect(r.ledger.writes).toEqual([]);
    expect(r.receipt().status).toBe(change === "seat" ? "failed" : "queued");
  } finally { r.journal.close(); }
});

test("context policy rejects inputs that cannot be injected with identical semantics", () => {
  const input = { conversationId: "conv-context", idempotencyKey: "key-context", text: "context", policy: "context-or-queue" };
  expect(parseRuntimeCommand("send", input)).toMatchObject(input);
  for (const extra of [{ turnId: null }, { turnId: "turn-context" }, { runtime: { model: "fixture-model" } }]) {
    expect(() => parseRuntimeCommand("send", { ...input, ...extra })).toThrow("context-or-queue requires");
  }
  expect(() => parseRuntimeCommand("steer", input)).toThrow("context-or-queue requires");
});

test("a real executor restart after injection acknowledgement cannot issue a wake or a second insertion", async () => {
  const r = rig();
  const writes = path.join(r.root, "native-writes");
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "structuredDelivery.crashChild.ts"),
    path.join(r.root, "runtime.sqlite"), writes, "owner-context", "context"], { stdout: "pipe", stderr: "pipe" });
  try {
    const deadline = performance.now() + 10_000;
    while (!fs.existsSync(writes) && performance.now() < deadline && child.exitCode === null) await Bun.sleep(5);
    expect(fs.existsSync(writes)).toBe(true);
    expect(r.receipt().status).toBe("delivering");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  try {
    r.reopen();
    r.binding.writerClaim = "successor-owner";
    r.idle();
    await r.queue().drain();
    expect(r.receipt().status).toBe("uncertain");
    expect(r.journal.executeOperation(r.command).replayed).toBe(true);
    await r.queue().drain();
    expect(fs.readFileSync(writes, "utf8")).toBe("op-context\n");
    expect(r.ledger.writes).toEqual([]);
    expect(r.ledger.injections).toEqual([]);
  } finally { r.journal.close(); }
});
