// Credential-free cold-resume comparison. Run once per CLI and shutdown signal.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import http from "node:http";

const [binary, signal = "SIGTERM"] = process.argv.slice(2);
if (!binary || !path.isAbsolute(binary) || !fs.existsSync(binary)) throw new Error("Pass an absolute fixture CLI binary");
if (!["SIGTERM", "SIGKILL"].includes(signal)) throw new Error("Use SIGTERM or SIGKILL");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cold-probe-"));
const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NODE_ENV: "test" };
for (const key of ["HOME", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
  env[key] = path.join(root, key.toLowerCase());
  fs.mkdirSync(env[key]);
}
const version = spawnSync(binary, ["--version"], { env, encoding: "utf8", timeout: 8000 });
if (version.status !== 0) throw new Error("Fixture version query failed");
console.log(JSON.stringify({ cli: version.stdout.trim(), signal }));
let requests = 0;
const responses = [];
const server = http.createServer((request, response) => {
  request.resume();
  requests++;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"fixture"}}\n\n');
  responses.push(response);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
fs.writeFileSync(path.join(env.CODEX_HOME, "config.toml"), `model="fixture-model"
model_provider="fixture"
approval_policy="never"
sandbox_mode="danger-full-access"
web_search="disabled"
[model_providers.fixture]
name="Fixture"
base_url="http://127.0.0.1:${server.address().port}/v1"
wire_api="responses"
requires_openai_auth=false
supports_websockets=false
[analytics]
enabled=false
[features]
apps=false
plugins=false
`);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const clients = [];
function start() {
  const child = spawn(binary, ["app-server", "--stdio"], { env, cwd: env.HOME, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("close", resolve));
  let serial = 0;
  const pending = new Map();
  const events = [];
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (message.method) events.push(message);
    const waiter = pending.get(message.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });
  child.stderr.resume();
  const client = {
    pid: child.pid,
    events,
    rpc(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 8000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
    async close(shutdown = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null) child.kill(shutdown);
      const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
      await exited;
      clearTimeout(timer);
      lines.close();
      for (const waiter of pending.values()) clearTimeout(waiter.timer);
      pending.clear();
    },
  };
  clients.push(client);
  return client;
}
const init = client => client.rpc("initialize", { clientInfo: { name: "cold_probe", version: "1" }, capabilities: { experimentalApi: true } });
try {
  let client = start();
  await init(client);
  const { thread } = await client.rpc("thread/start", { cwd: env.HOME, model: "fixture-model", modelProvider: "fixture", sandbox: "danger-full-access", approvalPolicy: "never" });
  await client.rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "held active", text_elements: [] }], clientUserMessageId: "probe-active" });
  await client.rpc("thread/queue/add", { threadId: thread.id, clientUserMessageId: "probe-queued", input: [{ type: "text", text: "cold queued", text_elements: [] }] });
  const deadline = Date.now() + 8000;
  while (requests < 1 && Date.now() < deadline) await sleep(20);
  if (requests !== 1) throw new Error("Held provider request did not arrive");
  console.log(JSON.stringify({ phase: "before-close", queue: (await client.rpc("thread/queue/list", { threadId: thread.id })).data.map(item => item.clientUserMessageId), requests }));
  await client.close(signal);
  client = start();
  await init(client);
  const resumed = await client.rpc("thread/resume", { threadId: thread.id });
  console.log(JSON.stringify({ phase: "resume", status: resumed.thread.status, turns: resumed.thread.turns.map(turn => ({ status: turn.status })) }));
  await sleep(12000);
  const queue = await client.rpc("thread/queue/list", { threadId: thread.id });
  console.log(JSON.stringify({ phase: "after-12s", queue: queue.data.map(item => item.clientUserMessageId), requests, events: client.events.filter(event => /turn\/|queue\//.test(event.method)).map(event => event.method) }));
  if (queue.data.length) {
    const result = await client.rpc("thread/queue/start", { threadId: thread.id, queuedSubmissionId: queue.data[0].id });
    console.log(JSON.stringify({ phase: "explicit-start", status: result.turn.status }));
  }
  await sleep(1000);
  console.log(JSON.stringify({ phase: "final", requests }));
} finally {
  for (const client of clients) await client.close();
  for (const response of responses) response.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
