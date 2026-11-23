import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { CodexAppServerHost } from "./codexAppServerHost";
import { FileRuntimeEventStore, type RuntimeEventStore } from "./eventStore";
import { projectEngineHostEvent } from "./engineHostEvents";
import { codexHostColumns } from "./registry";
import { RuntimeJournal } from "@/runtime-host/journal";
import type { RuntimeHostClient } from "./client";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { questionsResolution } from "@/components/runtime/ConversationAttention";
import type { RuntimeAttention } from "@/components/runtime/runtimeModel";
import { installCodexHostFixture, MemoryEventStore, FakeAppServer, fakeSpawn, waitForCondition } from "./codexAppServerHost.fixture";

let metadataState: string;
installCodexHostFixture(directory => { metadataState = directory; });

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
