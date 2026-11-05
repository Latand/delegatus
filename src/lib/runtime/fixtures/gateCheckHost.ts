import "@/lib/testing/fixtureLifetime";
import fs from "node:fs";
import http from "node:http";
import { WebSocketServer } from "ws";
import { procBackend } from "@/lib/proc";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { beginCodexFeatureFixture } from "@/lib/agent/codexSpawnPolicyTestFixtures";
import { CodexAppServerHost } from "../codexAppServerHost";
import { FileRuntimeEventStore } from "../eventStore";

const [mode, descriptor] = process.argv.slice(2);
let config = JSON.parse(fs.readFileSync(descriptor, "utf8"));
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
      if (message.id === "gate-wait" && "result" in message) {
        fs.writeFileSync(config.result, JSON.stringify(message.result));
        return;
      }
      if (typeof message.id !== "number") return;
      const reply = (result: unknown) => send({ id: message.id, result });
      switch (message.method) {
        case "initialize": reply({ userAgent: "fixture" }); break;
        case "account/read": reply({ account: { type: "chatgpt", planType: "pro" } }); break;
        case "model/list": reply({ data: [] }); break;
        case "config/read": reply({ config: { mcp_servers: {} } }); break;
        case "thread/resume":
          reply({ thread: { id: threadId, path: null, turns: [{ id: turnId, status: "inProgress", items: [] }], status: { type: "active", activeFlags: [] } } });
          config = JSON.parse(fs.readFileSync(descriptor, "utf8"));
          const callback = () => send({ id: "gate-wait", method: "item/tool/call", params: { threadId, turnId, callId: "gate-call", tool: "wait_for_check", arguments: { log: config.log, reason: "restart check" } } });
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
  if (config.unavailableLaunchEnvironment) {
    const readEnv = procBackend.readEnvVar;
    procBackend.readEnvVar = (pid, name) => name === "TMPDIR" ? null : readEnv(pid, name);
  }
  const result = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error("gate callback did not finish")); }, 10_000);
    const read = () => {
      if (!fs.existsSync(config.result)) return;
      clearTimeout(timer); watcher.close(); resolve(fs.readFileSync(config.result, "utf8"));
    };
    const watcher = fs.watch(config.directory, read);
    read();
  });
  const host = await CodexAppServerHost.adopt(threadId, { cwd: config.directory, env: process.env,
    socketOwner: config.owner, eventStore: new FileRuntimeEventStore(config.events),
    launchBinary: "/fixture/codex", readProtocolVersion: () => "0.162.1", requestTimeoutMs: 5_000 });
  try { process.stdout.write(`${await result}\n`); }
  finally { host.detachForViewerRestart(); }
}
