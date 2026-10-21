import "@/lib/testing/fixtureLifetime";
import fs from "node:fs";
import path from "node:path";
import { AgentRegistry } from "@/lib/agent/registry";
import { adoptCodexRegistryHosts, bindCodexHostPersistence, codexHostColumns, detachCodexHostForViewerRestart } from "../registry";
import http from "node:http";
import { WebSocketServer } from "ws";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { spawn } from "node:child_process";
import { beginCodexFeatureFixture } from "@/lib/agent/codexSpawnPolicyTestFixtures";
import { CodexAppServerHost } from "../codexAppServerHost";
import { FileRuntimeEventStore } from "../eventStore";
import { projectEngineHostEvent } from "../engineHostEvents";
import { applyEvent, installSnapshot, openAttentions, type RuntimeSession } from "@/components/runtime/runtimeModel";

const [mode, directory, writeLog, descriptor] = process.argv.slice(2);
if (!directory || !writeLog) throw new Error("callback fixture needs isolated paths");
const thread = "callback-process-thread";
const method = "item/commandExecution/requestApproval";

if (mode === "engine-socket") {
  const config = JSON.parse(fs.readFileSync(descriptor, "utf8"));
  const server = http.createServer();
  server.on("connection", connection => connection.on("error", () => {}));
  server.on("error", error => { throw error; });
  const sockets = new WebSocketServer({ server });
  let pending = true;
  let connections = 0;
  sockets.on("connection", socket => {
    const connection = ++connections;
    socket.on("error", () => {});
    const send = (value: unknown) => socket.send(JSON.stringify(value));
    const resolution = setInterval(() => {
      if (!config.resolutionFile || !fs.existsSync(config.resolutionFile)) return;
      clearInterval(resolution);
      pending = false;
      const notification = { method: "serverRequest/resolved", params: { threadId: thread, requestId: "approval" } };
      send(notification); send(notification);
    }, 10);
    socket.on("close", () => clearInterval(resolution));
    socket.on("message", bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.id === "approval" && "result" in message) {
        fs.appendFileSync(writeLog, `${JSON.stringify(message)}\n`);
        pending = false;
        if (!config.hold) send({ method: "serverRequest/resolved", params: { threadId: thread, requestId: "approval" } });
        return;
      }
      if (typeof message.id !== "number") return;
      const reply = (result: unknown) => send({ id: message.id, result });
      switch (message.method) {
        case "initialize": reply({ userAgent: "fixture" }); break;
        case "account/read": reply({ account: { type: "chatgpt", planType: "pro" } }); break;
        case "config/read":
          if (connection === 2 && config.reconnectFailure) {
            if (config.reconnectFailure === "disconnect") socket.terminate();
            else send({ id: message.id, error: { code: -32000, message: "fixture transient config failure" } });
          } else reply({ config: { mcp_servers: {} } });
          break;
        case "model/list": reply({ data: [] }); break;
        case "thread/resume": {
          if (Object.keys(message.params).some(key => key !== "threadId")) throw new Error("reconnect changed the existing thread policy");
          const replay = () => {
            if (!pending) return;
            const request = { id: "approval", method, params: { threadId: thread, turnId: "turn", itemId: "item", startedAtMs: 1 } };
            send(request); send(request); // Native reconnect can replay more than once.
          };
          if (config.replayFirst) replay();
          reply({ thread: { id: thread, path: null, turns: [], status: { type: "idle" } } });
          if (!config.replayFirst) replay();
          break;
        }
        default: send({ id: message.id, error: { code: -32601, message: "fixture method unavailable" } });
      }
    });
  });
  server.listen(config.socket, () => {
    fs.chmodSync(config.socket, 0o600);
    process.stdout.write(`${JSON.stringify({ endpoint: `codex-unix:${config.socket}`, process: captureProcessIdentity(process.pid) })}\n`);
  });
} else if (mode === "engine") {
  const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  process.stdout.on("error", () => process.exit(0));
  let buffer = "";
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("data", data => {
    buffer += String(data);
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (message.id === "approval" && "result" in message) {
        fs.appendFileSync(writeLog, `${JSON.stringify(message)}\n`);
        continue; // Hold confirmation across the test's hard process stop.
      }
      if (typeof message.id !== "number") continue;
      const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result });
      switch (message.method) {
        case "initialize": reply({ userAgent: "fixture" }); break;
        case "account/read": reply({ account: { type: "chatgpt", planType: "pro" } }); break;
        case "config/read": reply({ config: { mcp_servers: {} } }); break;
        case "mcpServerStatus/list": reply({ data: [{ name: "viewer", tools: { stage_report: {} } }], nextCursor: null }); break;
        case "model/list": reply({ data: [] }); break;
        case "thread/start":
        case "thread/resume":
          reply({ thread: { id: thread, path: null, turns: [], status: { type: "idle" } } });
          if (message.method === "thread/start") send({ jsonrpc: "2.0", id: "approval", method, params: { threadId: thread, turnId: "turn", itemId: "item", startedAtMs: 1 } });
          break;
        default: send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "fixture method unavailable" } });
      }
    }
  });
} else {
  beginCodexFeatureFixture();
  const store = new FileRuntimeEventStore(directory);
  const config = mode.startsWith("socket-") ? JSON.parse(fs.readFileSync(descriptor, "utf8")) : {};
  const options = {
    ...(mode.startsWith("socket-") ? { socketOwner: config.owner } : {}),
    cwd: process.cwd(), mcpServers: [], eventStore: {
      load: (id: string) => store.load(id),
      append: (id: string, event: import("../engineHost").RuntimeEvent) => {
        store.append(id, event);
        if (mode === "socket-crash-dispatch" && event.kind === "attention" && event.codexReceipt?.dispatch) process.kill(process.pid, "SIGKILL");
      },
    }, readProtocolVersion: () => "0.162.1", requestTimeoutMs: 10_000,
    spawnProcess: (_binary: string, _args: string[], options: import("node:child_process").SpawnOptionsWithoutStdio) => spawn(process.execPath,
      [import.meta.filename, "engine", directory, writeLog], { ...options, stdio: ["pipe", "pipe", "pipe"] }),
  };
  const registry = mode.startsWith("socket-") ? new AgentRegistry(path.join(directory, "registry.json")) : null;
  const key = { engine: "codex" as const, sessionId: thread };
  let host: CodexAppServerHost;
  if (mode === "socket-resume") {
    if (config.reconnectFailure) {
      const failed = await adoptCodexRegistryHosts(registry!, () => options, { ...process.env, LLV_STRUCTURED_HOSTS: "1" }, () => true, undefined, { admit: () => null });
      const retained = registry!.readOnlySnapshot().entries[`codex:${thread}`];
      if (failed.length || retained?.structuredHost?.process?.pid !== options.socketOwner.process.pid
        || retained.claimOwner || processIdentityStatus(options.socketOwner.process) !== "alive") {
        throw new Error("failed reconnect discarded the surviving callback owner");
      }
    }
    const adopted = await adoptCodexRegistryHosts(registry!, () => ({ ...options, readProtocolVersion: () => { throw new Error("reconnect must use the retained process protocol pin"); } }), { ...process.env, LLV_STRUCTURED_HOSTS: "1" }, () => true, undefined, { admit: () => null });
    if (adopted.length !== 1) throw new Error("registry did not reconnect its surviving callback owner");
    host = adopted[0]!.host;
  } else {
    host = mode === "dispatch" ? await CodexAppServerHost.start(options) : await CodexAppServerHost.adopt(thread, options);
    if (registry) {
      registry.upsert({ key, artifactPath: path.join(directory, "thread.jsonl"), cwd: process.cwd(), accountId: "default", status: "idle", host: null,
        claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: { ...codexHostColumns(await host.health(), 0), process: null } });
      const claimed = registry.claimStructuredHost(key, captureProcessIdentity(process.pid), { allowUnhosted: true });
      if (!claimed?.claimOwner) throw new Error("fixture writer claim unavailable");
      await bindCodexHostPersistence(registry, key, host, claimed.claimOwner, claimed.claimEpoch);
    }
  }
  const id = (await host.health()).pendingAttention[0]!;
  if (!id) throw new Error("fixture callback identity missing");
  if (mode === "dispatch" || mode === "socket-wait" || mode === "socket-dispatch" || mode === "socket-detach" || mode === "socket-crash-dispatch") {
    process.stdout.write(`${JSON.stringify({ ready: true, enginePid: (await host.health()).pid, id })}\n`);
    if (mode !== "socket-wait" && mode !== "socket-detach") void host.answer(id, { decision: "accept" }).catch(() => {});
    if (mode === "socket-detach") {
      if (!await detachCodexHostForViewerRestart(registry!, key, host)) throw new Error("native callback owner could not detach");
      process.exit(0);
    }
    process.on("SIGTERM", () => { void host.release().then(() => process.exit(0)); });
    await new Promise<void>(() => {});
  } else {
    let refusal = "";
    try { await host.answer(id, { decision: "accept" }); } catch (error) { refusal = (error as Error).message; }
    const events = store.load(thread);
    const receipt = events.findLast(event => (event.kind === "attention" || event.kind === "attention-resolved") && event.id === id);
    let visible: number | undefined;
    let closed: boolean | undefined;
    if (config.resolutionFile) {
      const projected = receipt && projectEngineHostEvent("callback-conversation", `codex:${thread}`, receipt);
      if (!projected || projected.kind !== "attention") throw new Error("recovered callback is missing");
      const session: RuntimeSession = { conversationId: "callback-conversation", sessionKey: key, hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured", revision: 1,
        attentionIds: [id], recentReceipts: [], accountId: "default", parentConversationId: null, flowId: null, workflowId: null, cwd: process.cwd(), artifactPath: null,
        capabilities: { steer: true, structuredAttention: true }, activeTurnId: null, drift: null };
      const snapshot = { schemaVersion: 1 as const, snapshotSeq: 1, retentionFloorSeq: 0, runtime: { hostEpoch: 1, health: "ready" as const }, filesRevision: 0,
        sessions: [session], attentions: [], recentOperations: [], edges: [], flows: [], workflows: [], tasks: [] };
      const scope = { type: "session" as const, id: session.conversationId };
      const recovered = applyEvent(installSnapshot(snapshot), { ...projected, scope, schemaVersion: 1, seq: 2, revision: 2, eventId: "callback-recovery" });
      if (recovered.outcome !== "applied") throw new Error("callback recovery was not applied");
      let view = recovered.store;
      visible = openAttentions(view, session).length;
      fs.writeFileSync(config.resolutionFile, "resolve");
      const deadline = Date.now() + 5_000;
      while ((await host.health()).pendingAttention.length && Date.now() < deadline) await Bun.sleep(10);
      const terminal = store.load(thread).findLast(event => event.kind === "attention-resolved" && event.id === id);
      const resolved = terminal && projectEngineHostEvent("callback-conversation", `codex:${thread}`, terminal);
      if (resolved) {
        const result = applyEvent(view, { ...resolved, scope, schemaVersion: 1, seq: 3, revision: 3, eventId: "callback-resolution" });
        if (result.outcome !== "applied") throw new Error("late callback resolution was not applied");
        view = result.store;
      }
      closed = (await host.health()).pendingAttention.length === 0 && openAttentions(view, session).length === 0;
    }
    process.stdout.write(`${JSON.stringify({ refusal, receipt, visible, closed })}\n`);
    await host.release();
  }
}
