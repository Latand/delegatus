import "@/lib/testing/fixtureLifetime";
import fs from "node:fs";
import http from "node:http";
import { WebSocketServer } from "ws";
import { procBackend } from "@/lib/proc";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { beginCodexFeatureFixture } from "@/lib/agent/codexSpawnPolicyTestFixtures";
import { CodexAppServerHost } from "../codexAppServerHost";
import * as wire from "../../recordedChecks/wire";
import { spyOn } from "bun:test";
import { FileRuntimeEventStore } from "../eventStore";

const [mode, descriptor] = process.argv.slice(2);
let config = JSON.parse(fs.readFileSync(descriptor, "utf8"));
let callbackSent = false, callbackSequence = 0, answers = 0;
const threadId = "gate-reconnect-thread", turnId = "gate-reconnect-turn";
if (mode === "engine") {
  const server = http.createServer();
  server.on("connection", socket => socket.on("error", () => {}));
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", socket => {
    socket.on("error", () => {});
    const send = (value: unknown) => socket.send(JSON.stringify(value));
    socket.on("message", bytes => {
      const message = JSON.parse(bytes.toString());
      if (typeof message.id === "string" && message.id.startsWith("gate-wait") && "result" in message) {
        answers++;
        if (config.count) fs.writeFileSync(config.count, String(answers));
        fs.writeFileSync(config.result, JSON.stringify(message.result));
        // Native Codex 0.162.1-0.167.0 never confirms an answered dynamic tool
        // call; only an explicit opt-in sends the confirmation other callbacks get.
        if (config.confirmResolution) send({ method: "serverRequest/resolved", params: { threadId, requestId: message.id } });
        if (config.duplicate) send({ id: message.id, method: "item/tool/call", params: { threadId, turnId, callId: "gate-call", tool: "wait_for_check", arguments: { log: config.log, reason: "restart check" } } });
        return;
      }
      if (typeof message.id !== "number") return;
      const reply = (result: unknown) => send({ id: message.id, result });
      switch (message.method) {
        case "initialize": reply({ userAgent: "fixture" }); break;
        case "account/read": reply({ account: { type: "chatgpt", planType: "pro" } }); break;
        case "model/list": reply({ data: [] }); break;
        case "mcpServerStatus/list": reply({ data: [{ name: "viewer", tools: { fixture_read: {} } }], nextCursor: null }); break;
        case "config/read": reply({ config: { mcp_servers: {} } }); break;
        case "thread/loaded/list": reply({ data: [threadId] }); break;
        case "thread/resume":
          config = JSON.parse(fs.readFileSync(descriptor, "utf8"));
          reply({ sandbox: { type: "dangerFullAccess" }, approvalPolicy: "never",
            thread: { id: threadId, path: null, turns: [{ id: turnId, status: config.turnEnded ? "completed" : "inProgress", items: [] }],
            status: config.turnEnded ? { type: "idle" } : { type: "active", activeFlags: [] } } });
          if (config.resolveWait) send({ method: "serverRequest/resolved", params: { threadId, requestId: "gate-wait" } });
          const callback = () => {
            if (config.noReplay && callbackSent && !config.forceReplay) return;
            callbackSent = true;
            send({ id: config.noReplay ? "gate-wait" : `gate-wait-${++callbackSequence}`, method: "item/tool/call", params: { threadId, turnId, callId: "gate-call", tool: "wait_for_check", arguments: { log: config.log, reason: "restart check" } } });
          };
          if (config.ready) {
            const watcher = fs.watch(config.directory, () => {
              if (fs.existsSync(config.release)) { watcher.close(); callback(); }
            });
            fs.writeFileSync(config.ready, "bound");
          } else callback();
          break;
        default: send({ id: message.id, error: { code: -32601, message: "fixture method unavailable" } });
      }
    });
  });
  server.listen(config.socket, () => {
    fs.chmodSync(config.socket, 0o600);
    process.stdout.write(`${JSON.stringify({ endpoint: `codex-unix:${config.socket}`, process: captureProcessIdentity(process.pid) })}\n`);
  });
} else {
  beginCodexFeatureFixture();
  if (config.nowUptime !== undefined) spyOn(wire, "custodyClock").mockReturnValue(config.nowUptime);
  if (config.unavailableLaunchEnvironment) {
    const readEnv = procBackend.readEnvVar;
    procBackend.readEnvVar = (pid, name) => name === "TMPDIR" ? null : readEnv(pid, name);
  }
  const result = ["hold", "crash-dispatch", "resolved", "retired"].includes(mode) ? null : new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error("gate callback did not finish")); }, 10_000);
    const read = () => {
      if (!fs.existsSync(config.result)) return;
      clearTimeout(timer); watcher.close(); resolve(fs.readFileSync(config.result, "utf8"));
    };
    const watcher = fs.watch(config.directory, read);
    read();
  });
  const eventStore = new FileRuntimeEventStore(config.events);
  const host = await CodexAppServerHost.adopt(threadId, { cwd: config.directory, env: process.env,
    reconnectAccess: { cwd: config.directory, sandbox: "danger-full-access", approvalPolicy: "never" },
    socketOwner: config.owner, eventStore: { load: id => eventStore.load(id), append: (id, event) => {
      eventStore.append(id, event);
      if (mode === "crash-dispatch" && event.kind === "attention" && event.codexReceipt?.gateWait?.result) {
        process.stdout.write("dispatched\n");
        process.exit(0);
      }
    } },
    launchBinary: "/fixture/codex", readProtocolVersion: () => "0.162.1", requestTimeoutMs: 5_000 });
  try {
    if (mode === "hold" || mode === "crash-dispatch") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { watcher.close(); reject(new Error("pending gate receipt missing")); }, 10_000);
        const read = () => {
          const events = new FileRuntimeEventStore(config.events).load(threadId);
          if (!events.some(event => event.kind === "attention" && event.codexReceipt?.gateWait && !event.codexReceipt.dispatch)) return;
          clearTimeout(timer); watcher.close(); resolve();
        };
        const watcher = fs.watch(config.events, read); read();
      });
      process.stdout.write("held\n");
      await new Promise<void>(resolve => {
        const watcher = fs.watch(config.directory, () => { if (fs.existsSync(config.stop)) { watcher.close(); resolve(); } });
        if (fs.existsSync(config.stop)) { watcher.close(); resolve(); }
      });
    } else {
      const answer = mode === "resolved" || mode === "retired" ? mode : await result;
      if (config.noReplay) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { watcher.close(); reject(new Error("gate resolution receipt missing")); }, 10_000);
        const read = () => {
          const events = new FileRuntimeEventStore(config.events).load(threadId);
          if (!events.some(event => event.kind === "attention-resolved" && (mode === "retired" ? event.codexReceipt?.recovery : event.codexReceipt?.serverResolution))) return;
          clearTimeout(timer); watcher.close(); resolve();
        };
        const watcher = fs.watch(config.events, read); read();
      });
      // A replayed reply needs only microtasks after adoption; drain them so a
      // resend is persisted and written before this process detaches.
      await new Promise(resolve => setTimeout(resolve, 0));
      process.stdout.write(`${answer}\n`);
    }
  }
  finally { host.detachForViewerRestart(); }
}
