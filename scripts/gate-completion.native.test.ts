import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { bindGateCheckRoot, gateCheckTool, runGateCheckTool } from "../src/lib/runtime/gateCheckTool";
import { checkEnvironment } from "./gate-cache";
import { isolatedEnvironment } from "./local-gate";
import { withoutInheritedGate } from "../src/lib/testing/inheritedGateEnv";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";

const binary = process.env.NATIVE_CODEX_QUEUE_TEST_BINARY;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// The local provider drives the real interpreter, with no credentials or model.
// Recorder startup and work completion are held by file events beyond exec's
// yield; neither receipt depends on fitting inside the exec output window.
for (const mode of ["normal", "delayed recorder", "missed completion"] as const) for (const exit of [0, 37]) test.skipIf(!binary)(`native stage uses one exec and one completion wait (exit ${exit}, ${mode})`, async () => {
  const delayedStartup = mode === "delayed recorder";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-"));
  const env = withoutInheritedGate(isolatedEnvironment(root, checkEnvironment(process.env)));
  env.TMPDIR = root;
  env.CODEX_HOME = path.join(root, "codex"); fs.mkdirSync(env.CODEX_HOME);
  env.PATH = [path.dirname(process.execPath), path.dirname(Bun.which("node")!), "/usr/bin", "/bin"].join(path.delimiter);
  Object.assign(env, { LLV_GATE_BUN: process.execPath, LLV_GATE_RUNNER: "off", DELEGATUS_AGENT_CPU: "off", DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_LOCK_DIR: root });
  const first = deferred<ServerResponse>(), second = deferred<{ body: string; response: ServerResponse }>(), third = deferred<string>(), waiting = deferred<void>(), finished = deferred<void>();
  const abort = new AbortController();
  const rootBinding = bindGateCheckRoot(root);
  const toolCalls: string[] = [];
  let requests = 0;
  const backend = createServer((request, response) => {
    let body = "";
    request.on("data", data => { body += data; });
    request.on("end", () => {
      requests++;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"fixture"}}\n\n');
      if (requests === 1) first.resolve(response);
      else if (requests === 2) second.resolve({ body, response });
      else {
        third.resolve(body);
        response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "fixture", status: "completed", output: [] } })}\n\n`);
      }
    });
  });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address(); if (!address || typeof address === "string") throw Error("no fixture port");
  fs.writeFileSync(path.join(env.CODEX_HOME, "config.toml"), `model = "fixture-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "danger-full-access"
web_search = "disabled"
[model_providers.fixture]
name = "Completion fixture"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[analytics]
enabled = false
[features]
apps = false
plugins = false
`);
  const fixture = path.join(root, "work.mjs");
  fs.writeFileSync(fixture, `import fs from 'node:fs';
const root = process.argv[2];
const watcher = fs.watch(root, () => { if (fs.existsSync(root + '/release')) { watcher.close(); console.log('completed work'); process.exit(${exit}); } });
fs.writeFileSync(root + '/ready', 'ready');
`);
  const launcher = path.join(root, "launch.mjs");
  fs.writeFileSync(launcher, `import fs from 'node:fs';
const root = process.argv[2];
await new Promise(resolve => {
  const check = () => { if (fs.existsSync(root + '/start-recorder')) { watcher.close(); resolve(); } };
  const watcher = fs.watch(root, check); check();
});
const child = Bun.spawn(process.argv.slice(3), { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited);
`);
  const child = spawn(binary!, ["app-server", "--stdio"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let diagnostics = "";
  child.stderr.on("data", data => { diagnostics = (diagnostics + data).slice(-8000); });
  const pending = new Map<number, (result: unknown) => void>(); let serial = 0;
  const lines = createInterface({ input: child.stdout });
  let readyWatcher: fs.FSWatcher | undefined;
  const notifications: string[] = [];
  lines.on("line", line => {
    const message = JSON.parse(line);
    if (message.method) notifications.push(message.method + (message.params?.run ? ":" + JSON.stringify(message.params.run) : ""));
    if (message.method === "item/tool/call") {
      toolCalls.push(message.params.tool);
      const watch = fs.watch;
      const notifications = mode === "missed completion" ? spyOn(fs, "watch").mockImplementation(((...args: Parameters<typeof fs.watch>) =>
        args[0] === path.join(root, "check.log.gate") ? watch(args[0], () => {}) : watch(...args)) as typeof fs.watch) : null;
      let held: ReturnType<typeof runGateCheckTool>;
      try { held = runGateCheckTool(message.params.arguments, rootBinding, abort.signal); }
      finally { notifications?.mockRestore(); }
      waiting.resolve();
      void held.then(result => {
        child.stdin.write(JSON.stringify({id: message.id, result}) + "\n");
      });
    } else if (typeof message.id === "number") pending.get(message.id)?.(message);
    if (message.method === "turn/completed") finished.resolve();
  });
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(JSON.stringify({ diagnostics, notifications, requests }))), 20_000);
    })]); } finally { clearTimeout(timer); }
  };
  const rpc = async (method: string, params: unknown) => {
    const id = ++serial;
    const response = new Promise<unknown>(resolve => pending.set(id, resolve));
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    const reply = await bounded(response) as { result?: Record<string, unknown>; error?: unknown };
    pending.delete(id);
    if (reply.error) throw Error(JSON.stringify(reply.error));
    return reply.result!;
  };
  try {
    await rpc("initialize", { clientInfo: { name: "gate-completion-fixture", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    const opened = await rpc("thread/start", { cwd: root, model: "fixture-model", approvalPolicy: "never", sandbox: "danger-full-access", dynamicTools: [gateCheckTool] });
    const thread = opened.thread as { id: string };
    await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "run the check", text_elements: [] }] });
    const response = await bounded(first.promise);
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const record = ["/bin/bash", path.join(import.meta.dir, "gate-slot.sh"), "--record", path.join(root, "check.log"), process.execPath, fixture, root];
    const cmd = (delayedStartup ? [process.execPath, launcher, root, ...record] : record).map(quote).join(" ");
    const item = { id: "one-check", type: "function_call", call_id: "one-check", name: "exec_command", arguments: JSON.stringify({ cmd, yield_time_ms: 1 }) };
    response.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`);
    response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "fixture", status: "completed", output: [item] } })}\n\n`);
    const yielded = await bounded(second.promise);
    const output = JSON.parse(yielded.body).input.find((item: { type: string }) => item.type === "function_call_output");
    expect(output.output).toContain("Process running with session ID");
    if (delayedStartup) {
      expect(fs.existsSync(path.join(root, "check.log.gate/completion.json"))).toBe(false);
      fs.writeFileSync(path.join(root, "start-recorder"), "start");
    }
    if (!fs.existsSync(path.join(root, "ready"))) await bounded(new Promise<void>(resolve => {
      const check = () => { if (fs.existsSync(path.join(root, "ready"))) { readyWatcher?.close(); resolve(); } };
      readyWatcher = fs.watch(root, check); check();
    }));
    expect(fs.existsSync(path.join(root, "check.log.gate/completion.json"))).toBe(true);
    const waitItem = { id: "one-wait", type: "function_call", call_id: "one-wait", name: gateCheckTool.name,
      arguments: JSON.stringify({ log: path.join(root, "check.log"), reason: "fixture comparator" }) };
    yielded.response.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: waitItem })}\n\n`);
    yielded.response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "fixture", status: "completed", output: [waitItem] } })}\n\n`);
    await bounded(Promise.race([waiting.promise, third.promise.then(() => { throw Error("native wait tool did not reach its handler"); })]));
    expect(requests, diagnostics).toBe(2);
    expect(fs.existsSync(path.join(root, "check.log.gate/exit"))).toBe(false);
    for (let i = 0; i < 1000; i++) fs.appendFileSync(path.join(root, "check.log"), `progress ${i}\n`);
    await Promise.resolve();
    expect(requests).toBe(2);
    fs.writeFileSync(path.join(root, "release"), "release");
    const resumed = await bounded(third.promise);
    expect(resumed).toContain(`finished exit=${exit}`);
    expect(resumed).toContain("completed work");
    expect(requests).toBe(3);
    expect(toolCalls).toEqual([gateCheckTool.name]);
    expect(fs.readFileSync(path.join(root, "check.log.gate/exit"), "utf8")).toBe(`${exit}\n`);
    await bounded(finished.promise);
  } finally {
    readyWatcher?.close();
    fs.writeFileSync(path.join(root, "start-recorder"), "start");
    fs.writeFileSync(path.join(root, "release"), "release");
    abort.abort();
    await stopFixtureProcess(child);
    backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
