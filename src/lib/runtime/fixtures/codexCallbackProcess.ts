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

const [mode, directory, writeLog, descriptor, delivery] = process.argv.slice(2);
if (!directory || !writeLog) throw new Error("callback fixture needs isolated paths");
let thread = "callback-process-thread";
const method = "item/commandExecution/requestApproval";

if (mode === "engine-socket") {
  const config = JSON.parse(fs.readFileSync(descriptor, "utf8"));
  if (config.threadId) thread = config.threadId;
  const server = http.createServer();
  server.on("connection", connection => connection.on("error", () => {}));
  server.on("error", error => { throw error; });
  const sockets = new WebSocketServer({ server });
  let pending = !config.recipient;
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
          } else reply({ config: { mcp_servers: { viewer: { command: "bun", args: ["fixture-viewer"] } } } });
          break;
        case "model/list": reply({ data: [] }); break;
        case "mcpServerStatus/list": reply({ data: [{ name: "viewer", tools: { fixture_read: {} } }], nextCursor: null }); break;
        case "thread/read":
          reply({ thread: { id: thread, path: config.transcriptPath ?? null, turns: [] } }); break;
        case "turn/start": {
          if (!config.recipient) { send({ id: message.id, error: { code: -32601, message: "fixture method unavailable" } }); break; }
          fs.appendFileSync(config.transcriptPath, JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T00:00:00Z",
            payload: { type: "user_message", id: message.params.clientUserMessageId, input: message.params.input } }) + "\n");
          const turnId = `recipient-turn-${message.params.clientUserMessageId}`;
          reply({ turn: { id: turnId } });
          send({ method: "item/completed", params: { threadId: thread, turnId,
            item: { type: "userMessage", clientId: message.params.clientUserMessageId, content: message.params.input } } });
          if (config.completeRecipientTurns) send({ method: "turn/completed", params: {
            threadId: thread, turn: { id: turnId, status: "completed" },
          } });
          break;
        }
        case "thread/resume": {
          if (Object.keys(message.params).some(key => key !== "threadId" && key !== "config")) throw new Error("reconnect changed the existing thread policy");
          const restored = message.params.config?.mcp_servers?.viewer;
          if (!restored?.env?.LLV_STATE_DIR || !restored.env_vars?.includes("LLV_SPAWN_CAPABILITY")) throw new Error("reconnect lost Viewer MCP installation or caller binding");
          if (Object.keys(message.params.config).some(key => key !== "mcp_servers")
            || Object.keys(message.params.config.mcp_servers).some(key => key !== "viewer")) throw new Error("reconnect changed unrelated thread configuration");
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
} else if (mode === "engine" || mode === "engine-mcp") {
  let batch: unknown[] | null = null;
  let held: unknown[] = [];
  const write = (values: unknown[]) => process.stdout.write(values.map(value => `${JSON.stringify(value)}\n`).join(""));
  const send = (value: unknown) => batch ? batch.push(value) : write([value]);
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
        case "config/read": reply({ config: { mcp_servers: { viewer: { command: "bun", args: ["fixture-viewer"] } } } }); break;
        case "mcpServerStatus/list":
          // Discovery follows ledger restoration and snapshot reconciliation.
          write(held); held = [];
          reply({ data: [{ name: "viewer", tools: { stage_report: {} } }], nextCursor: null }); break;
        case "model/list": reply({ data: [] }); break;
        case "mcpServerStatus/list": reply({ data: [{ name: "viewer", tools: { fixture_read: {} } }], nextCursor: null }); break;
        case "thread/start":
        case "thread/resume":
          if (message.method === "thread/resume") thread = message.params.threadId;
          if (mode === "engine-mcp" && delivery) batch = [];
          // The same unfinished turn continues across the producer's hard stop.
          reply({ thread: { id: thread, path: null,
            turns: mode === "engine-mcp" ? [{ id: "mcp-turn", status: "inProgress", items: [] }] : [],
            status: { type: mode === "engine-mcp" ? "active" : "idle" } } });
          if (mode === "engine-mcp") {
            const item = (phase: string, fields: Record<string, unknown>) => send({ method: `item/${phase}`,
              params: { threadId: thread, turnId: "mcp-turn", item: { type: "mcpToolCall", server: "viewer", tool: "get_task", ...fields } } });
            const success = { status: "completed", result: { content: [], structuredContent: { ok: true } } };
            const denial = { status: "failed", error: { message: "MCP tool call requires approval, but approval policy is never" } };
            if (descriptor?.startsWith("healthy-")) {
              if (message.method === "thread/start") {
                item("completed", { id: "initial-denial", ...denial });
                for (let index = 1; index < Number(descriptor.slice(8)); index++) {
                  item("started", { id: `healthy-${index}` });
                  item("completed", { id: `healthy-${index}`, ...success });
                }
                item("started", { id: "before-restart" });
              } else {
                item("started", { id: "continuation" });
                item("completed", { id: "continuation", ...success });
                item("completed", { id: "before-restart", ...success });
              }
            } else if (descriptor === "pending-denial" || descriptor?.startsWith("starts-")) {
              if (message.method === "thread/start") {
                const count = descriptor === "pending-denial" ? 1 : Number(descriptor.slice(7));
                for (let index = 1; index < count; index++) item("started", { id: `pending-${index}` });
                item("started", { id: "before-restart" });
              } else if (descriptor === "pending-denial") {
                item("completed", { id: "before-restart", ...denial });
              } else {
                item("completed", { id: "later-denial", ...denial });
                item("started", { id: "before-restart" });
                item("completed", { id: "before-restart", ...success });
                item("started", { id: "fresh-recovery" });
                item("completed", { id: "fresh-recovery", ...success });
              }
            } else if (message.method === "thread/start") {
              item("completed", { id: "initial-denial", status: "failed", error: { message: "MCP tool call requires approval, but approval policy is never" } });
              const count = Number(descriptor ?? 1);
              for (let index = 0; index < count; index++) {
                item("started", { id: `terminal-${index}` });
                item("completed", { id: `terminal-${index}`, ...success });
              }
              item("completed", { id: "denied", status: "failed", error: { message: "MCP tool call requires approval, but approval policy is never" } });
              item("started", { id: "before-restart" });
            } else {
              item("started", { id: "terminal-0" });
              item("completed", { id: "terminal-0", ...success });
              item("completed", { id: "before-restart", ...success });
            }
          } else if (message.method === "thread/start") send({ jsonrpc: "2.0", id: "approval", method, params: { threadId: thread, turnId: "turn", itemId: "item", startedAtMs: 1 } });
          if (batch) {
            // Buffer one producer item before restore, or deliver all producer
            // items live. Resume uses the same delivery choice for its full replay.
            const prefix = delivery === "live" ? 1 : message.method === "thread/start"
              ? batch.findIndex(frame => (frame as { method?: string }).method?.startsWith("item/")) + 1
              : batch.length;
            const frames = batch; batch = null;
            held = frames.slice(prefix);
            write(frames.slice(0, prefix));
          }
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
      [import.meta.filename, mode.startsWith("mcp-") ? "engine-mcp" : "engine", directory, writeLog, ...(descriptor ? [descriptor] : []), ...(delivery ? [delivery] : [])], { ...options, stdio: ["pipe", "pipe", "pipe"] }),
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
    host = mode === "dispatch" || mode === "mcp-produce" ? await CodexAppServerHost.start(options) : await CodexAppServerHost.adopt(thread, options);
    if (registry) {
      registry.upsert({ key, artifactPath: path.join(directory, "thread.jsonl"), cwd: process.cwd(), accountId: "default", status: "idle", host: null,
        claimEpoch: 0, claimOwner: null, pendingAction: null, structuredHost: { ...codexHostColumns(await host.health(), 0), process: null } });
      const claimed = registry.claimStructuredHost(key, captureProcessIdentity(process.pid), { allowUnhosted: true });
      if (!claimed?.claimOwner) throw new Error("fixture writer claim unavailable");
      await bindCodexHostPersistence(registry, key, host, claimed.claimOwner, claimed.claimEpoch);
    }
  }
  if (mode.startsWith("mcp-")) {
    const events = host.attach(0);
    const lastItem = mode === "mcp-resume" && descriptor?.startsWith("starts-") ? "fresh-recovery" : "before-restart";
    for await (const event of events) {
      if (event.kind !== "item" || (event.item as { id?: string })?.id !== lastItem
        || event.phase !== (mode === "mcp-produce" ? "started" : "completed")) continue;
      process.stdout.write(`${JSON.stringify({ observation: host.readViewerMcpObservation(), enginePid: (await host.health()).pid, activeTurnRef: (await host.health()).activeTurnRef })}\n`);
      break;
    }
    if (mode === "mcp-produce") await new Promise<void>(() => {});
    await host.release();
    process.exit(0);
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
