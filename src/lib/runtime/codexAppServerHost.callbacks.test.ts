// destructive-code: head-only; fixture-owned paths and recording process doubles.
import { hostExitText, readHostExit, withHostStopOrigin } from "./hostExit";
import { fakeAgentMemory, fakeHostMemory } from "./fixtures/agentMemory";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, spyOn, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { CodexAppServerHost } from "./codexAppServerHost";
import { encodeCodexStructuredUserText, decodeCodexStructuredUserText as decodeStoredUser } from "./codexStructuredUserText.server";
import { FileRuntimeEventStore, type RuntimeEventStore } from "./eventStore";
import { projectEngineHostEvent } from "./engineHostEvents";
import type { DeliveryTimingMark } from "./engineHost";
import { codexHostColumns } from "./registry";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "./client";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { questionsResolution } from "@/components/runtime/ConversationAttention";
import type { RuntimeAttention } from "@/components/runtime/runtimeModel";
import { installCodexHostFixture, deliveryDedup, MemoryEventStore, FakeAppServer, fakeSpawn, waitForCondition, ownedFakeProcess, metadataState } from "./codexAppServerHost.fixture";

installCodexHostFixture();

test.each([false, true, undefined, null, "false"])("native question flag %j retains answer IDs and only false permits steer", async (flag) => {
  const server = new FakeAppServer("async-question-thread");
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
  await host.send({ id: "active-question-turn", text: "start" });
  server.request("question-one", "item/tool/requestUserInput", { threadId: "async-question-thread", turnId: "turn-1", isBlocking: flag, questions: [{ id: "q", question: "Continue?" }] });
  expect((await host.health()).status).toBe(flag === false ? "active" : "attention");
  expect((await host.health()).pendingAttention).toEqual([expect.stringContaining("item/tool/requestUserInput:question-one:")]);
  if (flag === false) {
    expect(await host.send({ id: "matching-steer", text: "keep going", expectedTurnId: "turn-1" })).toMatchObject({ outcome: "steered" });
    server.request("approval-one", "item/commandExecution/requestApproval", { isBlocking: false, command: "date" });
    expect((await host.health()).status).toBe("attention");
    await host.answer((await host.health()).pendingAttention[0]!, { answers: { q: { answers: ["yes"] } } });
    expect((await host.health()).pendingAttention).toEqual([expect.stringContaining("item/commandExecution/requestApproval:approval-one:")]);
  }
  await host.release();
});

test("Codex operation timing observes preparation and RPC; diagnostic refusal leaves delivery intact", async () => {
  const server = new FakeAppServer("timing-thread");
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
  try {
    const marks: DeliveryTimingMark[] = [];
    expect(await host.send({ id: "timing-first", text: "start" }, undefined, undefined, mark => marks.push(mark))).toMatchObject({ outcome: "turn-started" });
    expect(marks).toEqual(["codex-prepare", "codex-confirmed-read", "codex-confirmed", "codex-input-ready", "codex-rpc-start", "codex-rpc-end"]);
    marks.length = 0;
    server.steerError = { code: -32000, message: "active turn changed" };
    expect(await host.send({ id: "timing-refused", text: "steer" }, undefined, undefined, mark => marks.push(mark))).toMatchObject({ outcome: "rejected" });
    expect(marks).toEqual(["codex-prepare", "codex-confirmed-read", "codex-confirmed", "codex-input-ready", "codex-rpc-start"]);
    server.steerError = null;
    expect(await host.send({ id: "timing-second", text: "steer" }, undefined, undefined, () => { throw new Error("observer refused"); })).toMatchObject({ outcome: "steered" });
  } finally { await host.release(); }
});

test("Codex stdout preserves Unicode split inside a completed user echo", async () => {
  const server = new FakeAppServer("unicode-wire");
  const eventStore = new MemoryEventStore();
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore, spawnProcess: fakeSpawn(server) });
  await host.send({ id: "unicode-original", text: "Привіт 🌍" });
  const encoded = await encodeCodexStructuredUserText("Привіт 🌍", undefined, undefined, undefined, deliveryDedup("unicode-original"));
  const bytes = Buffer.from(JSON.stringify({ method: "item/completed", params: { threadId: "unicode-wire", turnId: "turn-1", item: { type: "userMessage", id: "unicode-item", clientId: "unicode-original", content: [{ type: "text", text: encoded }] } } }) + "\n");
  const split = bytes.indexOf(Buffer.from("П")) + 1;
  const beforeEcho = Date.now();
  server.stdout.write(bytes.subarray(0, split)); server.stdout.write(bytes.subarray(split));
  expect(await host.send({ id: "unicode-original", text: "Привіт 🌍" })).toMatchObject({ turnId: "turn-1" });
  const echo = eventStore.load("unicode-wire").findLast(event => event.kind === "item" && event.phase === "completed") as { deliveryEcho?: { operationId: string; at: string; attachedAt: string } };
  expect(echo.deliveryEcho?.operationId).toBe("unicode-original");
  expect(echo.deliveryEcho?.at).toBeString();
  expect(Date.parse(echo.deliveryEcho!.at)).toBeGreaterThanOrEqual(beforeEcho);
  expect(Date.parse(echo.deliveryEcho!.at)).toBeLessThanOrEqual(Date.now());
  expect(Date.parse(echo.deliveryEcho!.attachedAt)).toBeGreaterThanOrEqual(Date.parse(echo.deliveryEcho!.at));
  await expect(host.send({ id: "unicode-original", text: "wrong payload" })).rejects.toThrow("different payload");
  await host.release();
});

test("malformed nonblocking requests stay blocking; auth recovery remains bounded and unverified", async () => {
  const server = new FakeAppServer("diagnostic-thread");
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
  await host.send({ id: "diagnostic-turn", text: "start" });
  server.request("malformed-question", "item/tool/requestUserInput", { threadId: "diagnostic-thread", turnId: "turn-1", isBlocking: false, questions: [{ question: "Missing identity" }] });
  expect((await host.health()).status).toBe("attention");
  server.notify("modelProvider/authRecoveryCompleted", {});
  expect((await host.health()).diagnostics?.authRecovery).toBe("unknown");
  server.notify("modelProvider/authRecoveryStarted", { threadId: "diagnostic-thread", turnId: "turn-1", provider: "fixture", message: "retrying" });
  expect((await host.health()).diagnostics?.authRecovery).toBe("started");
  server.notify("modelProvider/authRecoveryCompleted", { threadId: "diagnostic-thread", turnId: "turn-1", provider: "fixture", message: "complete" });
  expect((await host.health()).diagnostics).toMatchObject({ executable: "codex", authRecovery: "completed-unverified" });
  expect((await host.health()).pendingAttention).toEqual([expect.stringContaining("item/tool/requestUserInput:malformed-question:")]);
  expect(server.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
  await host.release();
});

test("a replayed native question retains its pending answer and rejects a duplicate answer", async () => {
  const server = new FakeAppServer("question-replay-thread");
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
  server.autoResolveServerRequests = false;
  const params = { threadId: "question-replay-thread", turnId: "turn-1", isBlocking: false, questions: [{ id: "q", question: "Choose" }] };
  server.request("question-replay", "item/tool/requestUserInput", params);
  const attentionId = (await host.health()).pendingAttention[0]!;
  const answer = host.answer(attentionId, { answers: { q: { answers: ["yes"] } } });
  server.request("question-replay", "item/tool/requestUserInput", params);
  await expect(host.answer(attentionId, {})).rejects.toThrow("already awaiting confirmation");
  server.notify("serverRequest/resolved", { threadId: "question-replay-thread", requestId: "question-replay" });
  await answer;
  expect(server.requests.filter(request => request.id === "question-replay")).toHaveLength(1);
  expect((await host.health()).pendingAttention).toEqual([]);
  await host.release();
});

describe("two-phase steering", () => {
  for (const scenario of ["item", "rollout", "absent", "unreadable"] as const) test(`turn ending with ${scenario} adjudicates accepted input`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "steer-host-"));
    const server = new FakeAppServer();
    server.threadPath = path.join(directory, "rollout.jsonl");
    fs.writeFileSync(server.threadPath, "");
    const host = await CodexAppServerHost.start({ cwd: directory, eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
    try {
      const opening = await host.send({ id: "opening", text: "begin" });
      if (!("turnId" in opening)) throw new Error("opening refused");
      server.autoCompleteUserMessage = scenario === "item";
      server.persistUserMessages = scenario === "rollout";
      const origin = { kind: "agent" as const, conversationId: "conversation_sender", role: "builder" };
      const accepted = await host.steer({ id: "supplement", text: "agent note", origin });
      const request = server.requests.findLast(r => r.method === "turn/steer")!;
      const params = request.params as { clientUserMessageId: string; input: Array<{text: string}> };
      expect(params.clientUserMessageId).toBe("supplement");
      expect(decodeStoredUser(params.input[0]!.text)).toMatchObject({ text: "agent note", origin });
      expect(decodeStoredUser(params.input[0]!.text)).toMatchObject({ deliveryDedup: deliveryDedup("supplement") });
      if (scenario === "unreadable") { fs.rmSync(server.threadPath); fs.mkdirSync(server.threadPath); }
      server.notify("turn/completed", { threadId: host.identity.threadId, turn: { id: opening.turnId, status: "completed" } });
      expect(await accepted.observe()).toBe(scenario === "absent" ? "dropped" : scenario === "unreadable" ? "unknown" : "landed");
      expect((await host.health()).status).toBe("idle");
    } finally { await host.release(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  for (const end of ["release", "writer-fence"] as const) test(`a running steer outlives the start confirmation timer and ${end} makes it unknown`, async () => {
    const server = new FakeAppServer();
    const host = await CodexAppServerHost.start({ cwd: "/repo", deliveryConfirmationTimeoutMs: 10,
      eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
    try {
      await host.send({ id: "opening", text: "begin" });
      server.autoCompleteUserMessage = false;
      const accepted = await host.steer({ id: "pending", text: "waiting for tools" });
      await new Promise(r => setTimeout(r, 35));
      expect((await host.health()).status).toBe("active");
      expect(server.signals).toEqual([]);
      if (end === "release") await host.release();
      else {
        host.setWriterFence(() => false);
        expect((await host.health()).status).toBe("active");
        expect(server.signals).toEqual([]);
      }
      expect(await accepted.observe()).toBe("unknown");
    } finally { await host.release(); }
  });

  for (const code of [-32601, -32600]) test(`steer RPC error ${code} is a definite refusal`, async () => {
    const server = new FakeAppServer();
    const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
    try {
      await host.send({ id: "opening", text: "begin" });
      server.steerError = { code, message: "cannot steer a compact turn", data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: "compact" } } } };
      await expect(host.steer({ id: "refused", text: "note" })).rejects.toMatchObject({ code });
      expect((await host.health()).status).toBe("active");
    } finally { await host.release(); }
  });

  test("an unanswered mutating steer is unknown and fails the wedged host", async () => {
    const server = new FakeAppServer();
    const host = await CodexAppServerHost.start({ cwd: "/repo", requestTimeoutMs: 30,
      eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
    try {
      await host.send({ id: "opening", text: "begin" });
      server.holdSteer = true;
      await expect(host.steer({ id: "unknown", text: "note" })).rejects.toThrow();
      expect((await host.health()).status).toBe("dead");
    } finally { await host.release(); }
  });
});

describe("Codex launch service tier", () => {
  test("fresh and resumed threads set ultrafast and every send inherits", async () => {
    for (const threadId of [undefined, "tier-thread"]) {
      const server = new FakeAppServer("tier-thread");
      server.modelList = [{ id: "gpt-6-astra", isDefault: true, serviceTiers: [{ id: "priority" }, { id: "ultrafast" }] }];
      const options = { cwd: "/repo", model: "gpt-6-astra", serviceTier: "ultrafast", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server, {}) };
      const host = await (threadId ? CodexAppServerHost.adopt(threadId, options) : CodexAppServerHost.start(options));
      try {
        expect(server.requests.find(request => request.method === (threadId ? "thread/resume" : "thread/start"))?.params).toMatchObject({ serviceTier: "ultrafast" });
        await host.send({ id: "tier-first", text: "begin" });
        await host.send({ id: "tier-steer", text: "continue", expectedTurnId: "turn-1" });
        server.notify("turn/completed", { threadId: host.identity.threadId, turn: { id: "turn-1", status: "completed" } });
        await new Promise(resolve => setTimeout(resolve, 0));
        await host.send({ id: "tier-later", text: "next turn" });
        const sends = server.requests.filter(request => request.method === "turn/start" || request.method === "turn/steer");
        expect(sends.map(request => request.method)).toEqual(["turn/start", "turn/steer", "turn/start"]);
        for (const send of sends) { expect(send.params).not.toHaveProperty("serviceTier"); expect(send.params).not.toHaveProperty("serviceTierForTurn"); }
      } finally { await host.release(); }
    }
  });
  test("catalog without the tier or an unavailable catalog refuses before thread start", async () => {
    for (const unavailable of [false, true]) {
      const server = new FakeAppServer("tier-refused");
      server.modelList = [{ id: "gpt-6-astra", serviceTiers: [{ id: "priority" }] }];
      if (unavailable) server.modelListFailuresRemaining = 1;
      await expect(CodexAppServerHost.start({ cwd: "/repo", model: "gpt-6-astra", serviceTier: "ultrafast", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server, {}) })).rejects.toThrow(unavailable ? "catalog unavailable" : "priority");
      expect(server.requests.some(request => request.method === "thread/start")).toBeFalse();
    }
  });
});

test("Codex host records injected OOM SIGKILL on its terminal row", async () => {
  const memory = fakeAgentMemory();
  const child = new FakeAppServer("memory-thread");
  const captured: { args?: string[] } = {};
  const host = await CodexAppServerHost.start({ cwd: "/repo", mcpServers: [], eventStore: new MemoryEventStore(), ...ownedFakeProcess,
    memoryCell: memory.cell, spawnProcess: fakeSpawn(child, captured) });
  try {
    expect(captured.args).toContain("MemorySwapMax=0");
    memory.kill();
    child.emit("exit", null, "SIGKILL");
    expect((await host.health()).status).toBe("dead");
    expect((await host.health()).memory?.lastKill?.fatal).toBe(true);
    child.emit("close", null, "SIGKILL");
    expect((await host.health()).status).toBe("dead");
    expect((await host.health()).memory?.lastKill?.fatal).toBe(true);
  } finally { await host.release(); memory.dispose(); }
});

test("auto scope admission failure is explicit and forced scope keeps the runner diagnostic", async () => {
  const { AgentMemoryCell, GIB } = await import("./agentMemory");
  for (const mode of ["auto", "scope"] as const) {
    const server = new FakeAppServer("scope-failure", "scope-failure", false, [], undefined, null, ["initialize"]);
    const cell = new AgentMemoryCell({ mechanism: "scope", mode, platform: "linux", limitBytes: GIB, budgetBytes: 2 * GIB, reserveBytes: GIB, totalBytes: 3 * GIB,
      score: 500, unit: "delegatus-agent-rejected.scope", slice: "delegatus-agents-test.slice", viewerUnit: null, systemdVersion: 255 }, { cgroupForPid: () => null });
    const start = CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), memoryCell: cell, ...ownedFakeProcess,
      spawnProcess: (...args) => {
        const child = fakeSpawn(server)(...args);
        setTimeout(() => { server.stderr.write("Failed to create bus connection: Connection refused"); server.emit("exit", 1, null); server.emit("close", 1, null); }, 1);
        return child;
      } });
    try {
      await expect(start).rejects.toThrow(mode === "auto" ? "agent memory scope launch failed before exec; retry shortly" : "Connection refused");
      expect(server.requests.some(request => request.method === "turn/start")).toBeFalse();
    } finally { cell.close(); }
  }
});

for (const mechanism of ["scope", "watchdog"] as const) for (const platform of ["linux", "darwin"] as const) for (const reused of [false, true]) test(`Codex fatal ${mechanism} exit on ${platform} skips group cleanup after root ${reused ? "reuse" : "disappearance"}`, async () => {
  const child = new FakeAppServer("watchdog-thread");
  const memory = fakeHostMemory(child.pid, platform, mechanism);
  const groupSignals: number[] = [];
  const host = await CodexAppServerHost.start({ cwd: "/repo", mcpServers: [], eventStore: new MemoryEventStore(),
    memoryCell: memory.cell, spawnProcess: fakeSpawn(child), processIdentity: memory.processIdentity, pidAlive: memory.pidAlive,
    shutdownGraceMs: 2, signalProcess: (pid) => { groupSignals.push(pid); } });
  try {
    memory.kill();
    memory.rootExit(reused);
    Object.assign(child, { signalCode: "SIGKILL" });
    child.emit("exit", null, "SIGKILL");
    expect((await host.health()).memory?.lastKill?.fatal).toBe(true);
    await host.release();
    await Bun.sleep(5);
    child.emit("close", null, "SIGKILL");
    expect(memory.signals).toEqual(mechanism === "watchdog"
      ? platform === "linux" ? [child.pid + 2, child.pid + 1] : [child.pid + 2, child.pid + 1, child.pid]
      : []);
    expect(memory.scopeReaps).toHaveLength(mechanism === "scope" ? 1 : 0);
    expect(groupSignals).toEqual([]);
    expect(child.signals).toEqual([]);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  } finally { child.emit("close", null, "SIGKILL"); await host.release(); memory.dispose(); }
});

test("Codex transport confirmation waits for delayed native provenance before restart", async () => {
  const { durableStageTurnEvidence } = await import("@/lib/pipelines/durableEvidence");
  const file = path.join(metadataState, "delayed-native-prompt.jsonl");
  fs.writeFileSync(file, "");
  const server = new FakeAppServer();
  server.threadPath = file;
  const host = await CodexAppServerHost.start({ cwd: metadataState, eventStore: new FileRuntimeEventStore(), spawnProcess: fakeSpawn(server) });
  let sendSettled = false;
  let sendOutcome: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
  try {
    sendOutcome = host.send({ id: "late-native-write", text: "Continue interrupted work", origin: { kind: "agent", role: "startup-recovery" } })
      .then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
      .then(outcome => { sendSettled = true; return outcome; });
    await waitForCondition(() => server.requests.some(row => row.method === "turn/start"), "Codex turn/start request was not observed");
    const request = server.requests.find(row => row.method === "turn/start");
    if (!request) throw new Error("Codex turn/start request disappeared after readiness");
    const wire = (request.params as { input: Array<{ text: string }> }).input[0]!.text;
    const outcome = await sendOutcome;
    if (!outcome.ok) throw outcome.error;
    fs.appendFileSync(file, JSON.stringify({ type: "event_msg", timestamp: "2026-10-05T16:01:00Z",
      payload: { type: "user_message", message: wire } }) + "\n");
  } finally {
    if (sendOutcome && !sendSettled) {
      await host.release();
      await sendOutcome;
    } else {
      await sendOutcome;
      await host.release();
    }
  }
  expect((await durableStageTurnEvidence("codex", file))?.prompts).toEqual([{ ts: Date.parse("2026-10-05T16:01:00Z"), origin: "pipeline" }]);
});

for (const transport of ["send", "steer"] as const) {
  test(`Codex automatic ${transport} into an active turn binds its own native row`, async () => {
    const { durableStageTurnEvidence } = await import("@/lib/pipelines/durableEvidence");
    const file = path.join(metadataState, `steered-${transport}.jsonl`);
    fs.writeFileSync(file, "");
    const server = new FakeAppServer();
    server.threadPath = file;
    server.persistUserMessages = true;
    const host = await CodexAppServerHost.start({ cwd: metadataState, eventStore: new FileRuntimeEventStore(), spawnProcess: fakeSpawn(server) });
    try {
      await host.send({ id: "initial-send", text: "Initial operator input", origin: { kind: "operator" } });
      const entry = { id: "automatic-steer", text: "Continue this turn", origin: { kind: "agent" as const, role: "pipeline" } };
      if (transport === "send") expect(await host.send(entry)).toMatchObject({ outcome: "steered", turnId: "turn-1" });
      else expect(await (await host.steer(entry)).observe()).toBe("landed");
      expect((await durableStageTurnEvidence("codex", file))?.prompts?.map(row => row.origin)).toEqual(["external", "pipeline"]);
    } finally { await host.release(); }
  });
}

for (const firstDispatch of [false, true]) test(`owner dispatch cutoff survives Codex's internal confirmation await (first dispatch: ${firstDispatch})`, async () => {
  const server = new FakeAppServer(`owner-native-cutoff-${firstDispatch}`);
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) });
  let allowed = true;
  const entry = { id: "owner-native-cutoff", text: "Owner instruction" };
  try {
    const pending = host.send(entry, firstDispatch ? { operationId: entry.id, writerClaim: "fixture", firstDispatch: true } : undefined,
      () => { if (!allowed) throw Error("owner first prompt revoked"); });
    allowed = false;
    await expect(pending).rejects.toThrow("owner first prompt revoked");
    expect(server.requests.some(request => request.method === "turn/start" || request.method === "turn/steer")).toBeFalse();
  } finally { await host.release(); }
});

test("seat launches disable native questions while workers keep them on fresh and adopted Codex", async () => {
  for (const seat of [false, true]) for (const resumed of [false, true]) {
    const server = new FakeAppServer("seat-question-policy");
    const captured: { args?: string[] } = {};
    const options = { cwd: "/repo", operatorDecisionForms: seat, eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server, captured) };
    const host = resumed ? await CodexAppServerHost.adopt("seat-question-policy", options) : await CodexAppServerHost.start(options);
    try {
      expect(captured.args!.includes("tools.experimental_request_user_input.enabled=false")).toBe(seat);
      const request = server.requests.find(r => r.method === (resumed ? "thread/resume" : "thread/start"))!;
      const config = (request.params as { config: Record<string, unknown> }).config;
      if (seat) {
        expect(config).toMatchObject({ tools: { experimental_request_user_input: { enabled: false } } });
        const hooks = (config.hooks as { PreToolUse: Array<{ matcher: string }> }).PreToolUse;
        expect(hooks.some(group => group.matcher.includes("request_user_input_async"))).toBe(true);
        expect(hooks.some(group => group.matcher.includes("exec_command"))).toBe(true);
      }
      else expect(config).not.toHaveProperty("tools.experimental_request_user_input.enabled");
    } finally { await host.release(); }
  }
});

describe("durable Codex callbacks", () => {
  const method = "item/commandExecution/requestApproval";
  const response = { decision: "accept" };
  const rows = (store: RuntimeEventStore, thread: string) => store.load(thread).filter(event => event.kind === "attention" || event.kind === "attention-resolved");

  for (const scenario of ["long-label", "permission-scope", "policy-amendment"] as const) test(`oversized ${scenario} survives controller journal restart, answers exactly and allows the turn to end`, async () => {
    const thread = randomUUID();
    const server = new FakeAppServer(thread);
    const store = new FileRuntimeEventStore(metadataState);
    const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
    const registry = new AgentRegistry(path.join(metadataState, "registry.json"));
    const artifactPath = path.join(metadataState, `${thread}.jsonl`);
    const key = { engine: "codex" as const, sessionId: thread };
    const conversation = registry.ensureConversation("codex", artifactPath, "default");
    registry.upsert({ key, artifactPath, cwd: "/repo", accountId: "default", status: "live", host: null,
      claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: { ...codexHostColumns(await host.health(), 0), process: null } });
    const filename = path.join(metadataState, "runtime.sqlite");
    let journal = new RuntimeJournal(filename, { structuredHosts: true });
    const client = {
      snapshot: async () => journal.snapshot(), readSession: async identity => journal.readSession(identity),
      events: async after => journal.replay(after), append: async event => journal.append(event),
      command: async command => journal.executeOperation(command), operationStatus: async id => journal.operationResult(id),
      producerCursor: async (kind, prefix) => journal.producerCursor(kind, prefix),
      effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
      transitionOperation: async (id, status, details) => journal.transitionOperation(id, status, details),
    } as RuntimeHostClient;
    const label = "x".repeat(17_000);
    const paths = Array.from({ length: 110 }, (_, i) => `/workspace/${"p".repeat(70)}${i}`);
    const amendment = ["echo", "\\\n\"".repeat(6_000)];
    const method = scenario === "long-label" ? "item/tool/requestUserInput"
      : scenario === "permission-scope" ? "item/permissions/requestApproval" : "item/commandExecution/requestApproval";
    const params = scenario === "long-label" ? { questions: [{ id: "choice", question: "Choose a value", isOther: false,
      options: [{ label: " ", description: "Hidden" }, { label, description: "Full value retained" }] }] }
      : scenario === "permission-scope" ? { cwd: "/workspace", environmentId: null, reason: null, permissions: { fileSystem: { read: paths } } }
        : { availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } }] };
    const expected = scenario === "long-label" ? { answers: { choice: { answers: [label] } } }
      : scenario === "permission-scope" ? { permissions: { fileSystem: { read: paths } }, scope: "session" }
        : { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } };
    const attention = () => journal.snapshot().attentions.find(row => row.conversationId === conversation.id)!;
    try {
      await bindStructuredDeliveryQueue([{ key, host }], { registry, client });
      server.request("large-request", method, params);
      await waitForCondition(() => !!attention(), "oversized request did not reach the journal");
      expect(attention().unowned).toBe(false);
      expect(attention().state).toBe("open");
      if (scenario === "long-label") expect(attention().request.question?.options).toMatchObject([{ label: expect.stringContaining("…") }]);
      else expect(attention().request.protocol?.actions?.[0]?.detail).toEndWith("…");
      const id = attention().id;
      // Restart the journal/controller while the callback owner survives.
      await bindStructuredDeliveryQueue([], { registry, client: null });
      journal.close();
      journal = new RuntimeJournal(filename, { structuredHosts: true });
      await bindStructuredDeliveryQueue([{ key, host }], { registry, client });
      const restored = attention();
      expect(restored.id).toBe(id);
      const resolution = scenario === "long-label" ? questionsResolution(restored as RuntimeAttention, [[0]])
        : restored.request.protocol!.actions![scenario === "permission-scope" ? 1 : 0]!.response;
      expect(Buffer.byteLength(JSON.stringify(resolution))).toBeLessThan(256);
      const command = { kind: "answer" as const, conversationId: conversation.id, attentionId: id, resolution,
        operationId: "large-answer", idempotencyKey: "large-answer" };
      expect(journal.executeOperation(command).receipt.status).toBe("pending");
      await kickStructuredDeliveryQueue();
      await waitForCondition(() => {
        const receipt = journal.operationResult("large-answer")?.receipt;
        if (receipt?.status === "failed" || receipt?.status === "rejected") throw new Error(`answer ${receipt.status}: ${receipt.reason}`);
        return receipt?.status === "answered";
      }, "large answer was not confirmed");
      const writes = () => server.requests.filter(message => message.id === "large-request" && "result" in message);
      expect(writes()).toHaveLength(1);
      expect(writes()[0]!.result).toEqual(expected);
      await host.answer(id, resolution);
      await host.answer(id, expected);
      expect(writes()).toHaveLength(1);
      expect(journal.executeOperation({ ...command, operationId: "confirmed-retry", idempotencyKey: "confirmed-retry" }).receipt.status).toBe("answered");
      server.notify("turn/completed", { threadId: thread, turn: { id: "turn-1", status: "completed" } });
      await waitForCondition(() => journal.replay(0).events.some(event => event.kind === "turn-ended"), "turn end was blocked by the request");
      for (const event of journal.replay(0).events.filter(event => event.kind === "attention")) {
        expect(Buffer.byteLength(JSON.stringify(event.payload))).toBeLessThanOrEqual(16 * 1024);
      }
      await bindStructuredDeliveryQueue([], { registry, client: null });
      journal.close();
      journal = new RuntimeJournal(filename, { structuredHosts: true });
      // A fresh journal replays the full host ledger, including the original
      // oversized request and dispatch, as startup after projection loss does.
      const replayJournal = new RuntimeJournal(path.join(metadataState, "replay.sqlite"), { structuredHosts: true });
      try {
        for (const event of new FileRuntimeEventStore(metadataState).load(thread)) {
          const projection = projectEngineHostEvent(conversation.id, `codex:${thread}`, event);
          if (projection) replayJournal.append(projection);
        }
        expect(replayJournal.snapshot().attentions.find(row => row.id === id)?.state).toBe("resolved");
        expect(replayJournal.replay(0).events.some(event => event.kind === "turn-ended")).toBe(true);
      } finally { replayJournal.close(); }
      expect(journal.executeOperation({ ...command, operationId: "restart-retry", idempotencyKey: "restart-retry" }).receipt.status).toBe("answered");
      expect(writes()).toHaveLength(1);
      await host.release();
      const successor = new FakeAppServer(thread);
      const replacement = await CodexAppServerHost.adopt(thread, { cwd: "/repo", eventStore: new FileRuntimeEventStore(metadataState), spawnProcess: fakeSpawn(successor) });
      try {
        await replacement.answer(id, resolution);
        await replacement.answer(id, expected);
        expect(successor.requests.filter(message => message.id === "large-request")).toHaveLength(0);
      } finally { await replacement.release(); }
    } finally {
      await bindStructuredDeliveryQueue([], { registry, client: null });
      await host.release();
      journal.close();
    }
  }, 15_000);

  test("concurrent callback owners cannot alias the same RPC ID in the shared journal", async () => {
    const servers = [new FakeAppServer("callback-a"), new FakeAppServer("callback-b")];
    const hosts: CodexAppServerHost[] = [];
    try {
      for (const server of servers) hosts.push(await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server) }));
      for (const server of servers) server.request(1, method, {});
      const ids = await Promise.all(hosts.map(async host => (await host.health()).pendingAttention[0]!));
      expect(new Set(ids).size).toBe(2);
      await expect(hosts[1]!.answer(ids[0]!, response)).rejects.toThrow("missing");
      await hosts[0]!.answer(ids[0]!, response);
      expect((await hosts[1]!.health()).pendingAttention).toEqual([ids[1]!]);
      expect(servers[1]!.requests.filter(request => request.id === 1 && "result" in request)).toHaveLength(0);
    } finally { for (const host of hosts) await host.release(); }
  });

  test("persists the full typed identity before dispatch and joins identical concurrent answers", async () => {
    const server = new FakeAppServer("durable-identity");
    server.autoResolveServerRequests = false;
    const store = new FileRuntimeEventStore(metadataState);
    const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
    try {
      server.request(17, method, { approvalId: "approval-one", availableDecisions: ["accept", "decline"] });
      const id = (await host.health()).pendingAttention[0]!;
      const first = host.answer(id, response);
      const second = host.answer(id, response);
      await expect(host.answer(id, { decision: "decline" })).rejects.toThrow("different answer");
      const persisted = new FileRuntimeEventStore(metadataState).load("durable-identity").findLast(event => event.kind === "attention");
      expect(persisted).toMatchObject({ codexReceipt: { identity: { requestId: 17, threadId: "durable-identity", turnId: "turn-1", itemId: "item-17", approvalId: "approval-one", method }, dispatch: { digest: expect.any(String) } } });
      server.request(17, method, { approvalId: "approval-one", availableDecisions: ["accept", "decline"] });
      expect(server.requests.filter(message => message.id === 17 && "result" in message)).toHaveLength(1);
      server.notify("serverRequest/resolved", { threadId: "foreign", requestId: 17 });
      expect(rows(store, "durable-identity").filter(event => event.kind === "attention-resolved")).toHaveLength(0);
      server.notify("serverRequest/resolved", { threadId: "durable-identity", requestId: 17 });
      await Promise.all([first, second]);
      await host.answer(id, response);
      expect(server.requests.filter(message => message.id === 17 && "result" in message)).toHaveLength(1);
      expect(rows(store, "durable-identity").filter(event => event.kind === "attention-resolved")).toHaveLength(1);
    } finally { await host.release(); }
  });

  test("resolution before the answer and repeated late notifications have one durable terminal", async () => {
    const server = new FakeAppServer("automatic-resolution");
    const store = new FileRuntimeEventStore(metadataState);
    const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
    try {
      server.request("auto", method, {});
      const id = (await host.health()).pendingAttention[0]!;
      server.notify("serverRequest/resolved", { threadId: "automatic-resolution", requestId: "auto" });
      await expect(host.answer(id, response)).rejects.toThrow("was not delivered");
      server.request("auto", method, {});
      server.notify("serverRequest/resolved", { threadId: "automatic-resolution", requestId: "auto" });
      expect((await host.health()).pendingAttention).toEqual([]);
      expect(server.requests.filter(message => message.id === "auto")).toHaveLength(0);
      const terminals = rows(new FileRuntimeEventStore(metadataState), "automatic-resolution").filter(event => event.kind === "attention-resolved");
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({ codexReceipt: { serverResolution: { outcome: "server-resolved" } } });
      expect(terminals[0]?.codexReceipt?.dispatch).toBeUndefined();
    } finally { await host.release(); }
  });

  test("a timeout retains dispatch uncertainty, refuses redelivery and admits one late resolution", async () => {
    const server = new FakeAppServer("late-resolution");
    server.autoResolveServerRequests = false;
    const store = new FileRuntimeEventStore(metadataState);
    const host = await CodexAppServerHost.start({ cwd: "/repo", requestTimeoutMs: 40, eventStore: store, spawnProcess: fakeSpawn(server) });
    try {
      server.request("late", method, {});
      const id = (await host.health()).pendingAttention[0]!;
      await expect(host.answer(id, response)).rejects.toThrow("uncertain");
      await expect(host.answer(id, response)).rejects.toThrow("will not be delivered again");
      expect(rows(new FileRuntimeEventStore(metadataState), "late-resolution").at(-1)).toMatchObject({ codexReceipt: { recovery: { outcome: "delivery-uncertain", reason: "timeout" } } });
      server.notify("serverRequest/resolved", { threadId: "late-resolution", requestId: "late" });
      server.notify("serverRequest/resolved", { threadId: "late-resolution", requestId: "late" });
      await host.answer(id, response);
      expect(rows(store, "late-resolution").filter(event => event.kind === "attention-resolved")).toHaveLength(1);
      expect(server.requests.filter(message => message.id === "late")).toHaveLength(1);
      expect((await host.health()).status).not.toBe("dead");
    } finally { await host.release(); }
  });

  test.each([false, true])("process loss and resume retain unresolved callbacks, dispatched=%s", async dispatched => {
    const thread = "lost-callback";
    const server = new FakeAppServer(thread);
    server.autoResolveServerRequests = false;
    const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new FileRuntimeEventStore(metadataState), spawnProcess: fakeSpawn(server) });
    server.request("same-rpc", method, {});
    const id = (await host.health()).pendingAttention[0]!;
    const pending = dispatched ? host.answer(id, response).catch(error => error as Error) : Promise.resolve(null);
    await host.release();
    if (dispatched) expect(await pending).toBeInstanceOf(Error);
    const successor = new FakeAppServer(thread);
    const replacement = await CodexAppServerHost.adopt(thread, { cwd: "/repo", eventStore: new FileRuntimeEventStore(metadataState), spawnProcess: fakeSpawn(successor) });
    try {
      await expect(replacement.answer(id, response)).rejects.toThrow("previous host generation");
      const restored = rows(new FileRuntimeEventStore(metadataState), thread).findLast(event => event.kind === "attention" && event.id === id);
      expect(restored).toMatchObject({ codexReceipt: { recovery: { outcome: dispatched ? "delivery-uncertain" : "callback-unavailable" } } });
      successor.request("same-rpc", method, {});
      const newId = (await replacement.health()).pendingAttention.find(value => value !== id)!;
      expect(newId).toBeTruthy();
      await replacement.answer(newId, response);
      expect(successor.requests.filter(message => message.id === "same-rpc")).toHaveLength(1);
      expect(rows(new FileRuntimeEventStore(metadataState), thread).filter(event => event.kind === "attention-resolved" && event.id === id)).toHaveLength(0);
    } finally { await replacement.release(); }
  });

  test("malformed ingress is visible and cannot write a raw answer", async () => {
    const server = new FakeAppServer("bad-ingress");
    const store = new FileRuntimeEventStore(metadataState);
    const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
    try {
      server.rawRequest("bad", method, { command: "echo missing identity" });
      const id = (await host.health()).pendingAttention[0]!;
      await expect(host.answer(id, response)).rejects.toThrow("cannot be answered");
      expect(server.requests.filter(message => message.id === "bad")).toEqual([]);
      expect(rows(store, "bad-ingress").at(-1)?.codexReceipt?.protocolError).toContain("server-params");
    } finally { await host.release(); }
  });

  test("a failed dispatch journal write prevents stdin delivery", async () => {
    const server = new FakeAppServer("dispatch-persist-failure");
    const persisted = new MemoryEventStore();
    const store: RuntimeEventStore = { load: thread => persisted.load(thread), append: (thread, event) => {
      if (event.kind === "attention" && event.codexReceipt?.dispatch) throw new Error("fixture disk failure");
      persisted.append(thread, event);
    } };
    const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: store, spawnProcess: fakeSpawn(server) });
    try {
      server.request("blocked", method, {});
      const id = (await host.health()).pendingAttention[0]!;
      await expect(host.answer(id, response)).rejects.toThrow("ledger failed");
      expect(server.requests.filter(message => message.id === "blocked")).toEqual([]);
      expect(rows(persisted, "dispatch-persist-failure").some(event => event.codexReceipt?.dispatch)).toBeFalse();
    } finally { await host.release(); }
  });
});

test("a hard Viewer process restart in the middle of an answer keeps the fsynced dispatch and never redelivers", async () => {
  const fixture = path.join(import.meta.dir, "fixtures/codexCallbackProcess.ts");
  const writeLog = path.join(metadataState, "answers.jsonl");
  const directory = path.join(metadataState, "events");
  const children: ReturnType<typeof spawn>[] = [];
  let enginePid: number | null = null;
  const launch = (mode: string) => {
    const child = spawn(process.execPath, [fixture, mode, directory, writeLog], { cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "", errors = "";
    child.stdout!.on("data", chunk => { output += String(chunk); });
    child.stderr!.on("data", chunk => { errors += String(chunk); });
    return { child, output: () => output, errors: () => errors };
  };
  const waitFor = async (predicate: () => boolean, detail: () => string) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(detail());
      await Bun.sleep(10);
    }
  };
  try {
    const first = launch("dispatch");
    await waitFor(() => first.output().includes("\n") || first.child.exitCode !== null, first.errors);
    if (first.child.exitCode !== null) throw new Error(first.errors() || "fixture Viewer exited before readiness");
    expect(first.child.exitCode).toBeNull();
    const ready = JSON.parse(first.output().trim());
    enginePid = ready.enginePid;
    await waitFor(() => fs.existsSync(writeLog) && fs.readFileSync(writeLog, "utf8").includes("accept"), first.errors);
    first.child.kill("SIGKILL");
    await waitFor(() => first.child.signalCode !== null, () => "fixture Viewer did not exit");
    // Its stdio app-server exits on EOF. Only this fixture's recorded child is observed.
    await waitFor(() => enginePid !== null && !procBackend.pidAlive(enginePid), () => "fixture app-server did not exit on EOF");
    enginePid = null;
    const second = launch("resume");
    await waitFor(() => second.child.exitCode !== null, second.errors);
    if (second.child.exitCode !== 0) throw new Error(second.errors() || "fixture successor failed");
    expect(second.child.exitCode).toBe(0);
    const restored = JSON.parse(second.output().trim());
    expect(restored.refusal).toContain("previous host generation");
    expect(restored.receipt).toMatchObject({ codexReceipt: { dispatch: { digest: expect.any(String) }, recovery: { outcome: "delivery-uncertain", reason: "resumed-without-callback" } } });
    expect(fs.readFileSync(writeLog, "utf8").trim().split("\n")).toHaveLength(1);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (enginePid !== null && procBackend.pidAlive(enginePid)) process.kill(enginePid, "SIGKILL");
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child.once("close", () => resolve()));
  }
}, 30_000);

for (const { midAnswer = false, graceful = false, reconnectFailure, crashBeforeWrite = false, replayFirst = false } of [
  {}, { midAnswer: true }, { graceful: true },
  { reconnectFailure: "rpc" }, { reconnectFailure: "disconnect" },
  { midAnswer: true, crashBeforeWrite: true }, { midAnswer: true, crashBeforeWrite: true, replayFirst: true },
]) test.skipIf(process.platform === "win32")(`Viewer restart reconnects through the registry to the exact callback owner (mid-answer=${midAnswer}, graceful=${graceful}, failure=${reconnectFailure}, crash-before-write=${crashBeforeWrite}, replay-first=${replayFirst})`, async () => {
  const fixture = path.join(import.meta.dir, "fixtures/codexCallbackProcess.ts");
  // Keep the Unix path below the kernel limit even under the gate's nested roots.
  const socketRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-"));
  fs.chmodSync(socketRoot, 0o700);
  const descriptor = path.join(socketRoot, "owner.json");
  const writeLog = path.join(metadataState, "socket-answers.jsonl");
  const directory = path.join(metadataState, "socket-events");
  const config = { socket: path.join(socketRoot, "rpc.sock"), hold: midAnswer, reconnectFailure, replayFirst,
    ...(crashBeforeWrite ? { resolutionFile: path.join(socketRoot, "resolve") } : {}) };
  fs.writeFileSync(descriptor, JSON.stringify(config));
  const children: ReturnType<typeof spawn>[] = [];
  const launch = (mode: string) => {
    const child = spawn(process.execPath, [fixture, mode, directory, writeLog, descriptor], { cwd: process.cwd(), env: { ...process.env }, detached: mode === "engine-socket", stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "", errors = "";
    child.stdout!.on("data", chunk => { output += String(chunk); });
    child.stderr!.on("data", chunk => { errors += String(chunk); });
    return { child, output: () => output, errors: () => errors };
  };
  const waitFor = async (predicate: () => boolean, detail: () => string) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(detail() || "callback fixture timed out");
      await Bun.sleep(10);
    }
  };
  const ready = async (fixture: ReturnType<typeof launch>) => {
    await waitFor(() => fixture.output().includes("\n") || fixture.child.exitCode !== null, fixture.errors);
    if (fixture.child.exitCode !== null && !fixture.output().includes("\n")) throw new Error(fixture.errors());
    return JSON.parse(fixture.output().trim());
  };
  try {
    const engine = launch("engine-socket");
    const owner = await ready(engine);
    fs.writeFileSync(descriptor, JSON.stringify({ ...config, owner }));
    const first = launch(crashBeforeWrite ? "socket-crash-dispatch" : graceful ? "socket-detach" : midAnswer ? "socket-dispatch" : "socket-wait");
    const initial = await ready(first);
    expect(initial.enginePid).toBe(owner.process.pid);
    if (midAnswer && !crashBeforeWrite) await waitFor(() => fs.existsSync(writeLog), first.errors);
    if (crashBeforeWrite) await waitFor(() => first.child.signalCode !== null, first.errors);
    const before = new FileRuntimeEventStore(directory).load("callback-process-thread");
    const request = before.find(event => event.kind === "attention");
    expect(request?.kind === "attention" && request.codexReceipt?.identity.generation).toBeTruthy();
    if (!graceful && !crashBeforeWrite) first.child.kill("SIGKILL");
    await waitFor(() => first.child.signalCode !== null || first.child.exitCode !== null, first.errors);
    expect(engine.child.exitCode).toBeNull();
    const second = launch("socket-resume");
    await waitFor(() => second.child.exitCode !== null, second.errors);
    if (second.child.exitCode !== 0) throw new Error(second.errors());
    const restored = JSON.parse(second.output().trim());
    expect(restored.receipt.codexReceipt.identity).toEqual(request && "codexReceipt" in request ? request.codexReceipt?.identity : null);
    if (midAnswer) {
      expect(restored.refusal).toBeTruthy();
      expect(restored.receipt.codexReceipt.recovery.outcome).toBe("delivery-uncertain");
    } else {
      expect(restored.refusal).toBe("");
      expect(restored.receipt.kind).toBe("attention-resolved");
      expect(restored.receipt.codexReceipt.serverResolution.outcome).toBe("answered");
    }
    const writes = fs.existsSync(writeLog) ? fs.readFileSync(writeLog, "utf8").trim().split("\n") : [];
    expect(writes).toHaveLength(crashBeforeWrite ? 0 : 1);
    if (crashBeforeWrite) {
      expect(restored.visible).toBe(1);
      expect(restored.closed).toBeTrue();
      const reopened = new FileRuntimeEventStore(directory).load("callback-process-thread");
      expect(reopened.findLast(event => event.kind === "attention-resolved")).toMatchObject({ codexReceipt: { serverResolution: { outcome: "answered" } } });
    }
    const terminal = new FileRuntimeEventStore(directory).load("callback-process-thread").filter(event => event.kind === "attention-resolved");
    expect(terminal).toHaveLength(midAnswer && !crashBeforeWrite ? 0 : 1);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise<void>(resolve => child.once("close", () => resolve()))));
    fs.rmSync(socketRoot, { recursive: true, force: true });
  }
}, 30_000);

test("Codex records its stop before EOF can end the native host", async () => {
  const server = new FakeAppServer("host-eof-thread");
  let nativeAlive = true;
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: () => server as never,
    processIdentity: () => nativeAlive ? "fixture-codex-eof" : null, pidAlive: () => nativeAlive, signalProcess: () => {} });
  const process = (await host.health()).exitProcess!;
  const beforeEof: { value: ReturnType<typeof readHostExit> } = { value: null };
  let deliveredEof = false;
  const end = spyOn(server.stdin, "end").mockImplementation(() => {
    if (!deliveredEof) {
      deliveredEof = true;
      beforeEof.value = readHostExit(process);
      nativeAlive = false;
      queueMicrotask(() => { server.emit("exit", 0, null); server.emit("close", 0, null); });
    }
    return server.stdin;
  });
  try {
    await withHostStopOrigin({ path: "deploy-cut", operationId: "eof-operation" }, () => host.release());
    expect(end).toHaveBeenCalled();
    expect(beforeEof.value?.stop).toMatchObject({ path: "deploy-cut", operationId: "eof-operation", signal: "EOF" });
    expect(readHostExit(process)?.exit).toMatchObject({ code: 0, signal: null });
  } finally { end.mockRestore(); await host.release(); }
});

for (const ending of ["release", "external", "code"] as const) test(`Codex host exit observer retains ${ending} status and source after release`, async () => {
  const server = new FakeAppServer("host-exit-thread");
  const host = await CodexAppServerHost.start({ cwd: "/repo", eventStore: new MemoryEventStore(), spawnProcess: fakeSpawn(server),
    processIdentity: () => "fixture-codex-host-exit", pidAlive: () => true, shutdownGraceMs: 10,
    signalProcess: (_pid, signal) => {
      queueMicrotask(() => server.emit("close", null, signal));
    } });
  const process = (await host.health()).exitProcess!;
  try {
    expect(process.startIdentity).toBe("fixture-codex-host-exit");
    if (ending === "release") await withHostStopOrigin({ path: "deploy-cut", operationId: "deploy-fixture-operation" }, () => host.release());
    else {
      server.emit("exit", ending === "code" ? 23 : null, ending === "external" ? "SIGKILL" : null);
      server.emit("close", ending === "code" ? 23 : null, ending === "external" ? "SIGKILL" : null);
    }
    const evidence = readHostExit(process)!;
    expect(evidence.exit).toMatchObject({ code: ending === "code" ? 23 : null, signal: ending === "external" ? "SIGKILL" : ending === "release" ? "SIGTERM" : null });
    expect(evidence.stop).toEqual(ending === "release" ? expect.objectContaining({ path: "deploy-cut", operationId: "deploy-fixture-operation" }) : null);
    expect(hostExitText(evidence)).toContain(ending === "release" ? "stopped by deploy-cut" : "no Delegatus stop recorded");
    expect((await host.health()).exitProcess).toEqual(process);
  } finally { await host.release(); }
});
