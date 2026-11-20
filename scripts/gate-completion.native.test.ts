import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { bindGateCheckRoot, gateCheckTool, runGateCheckTool } from "../src/lib/runtime/gateCheckTool";
import { GATE_CHECK_EVIDENCE_ENV, GATE_CHECK_LAUNCH_ROOT_ENV, GATE_CHECK_ROOT_ENV, GATE_CHECK_ROOT_IDENTITY_ENV } from "../src/lib/runtime/gateCheckRecord";
import { agentCodexPublicationPolicy } from "../src/lib/git/agentPublicationIdentity";
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
const cases = [
  ...(["normal", "delayed recorder", "missed completion"] as const).flatMap(mode => [0, 37].map(exit => ({ mode, exit }))),
  { mode: "include_only", exit: 0 },
  { mode: "keyed filters", exit: 37 },
] as const;
for (const { mode, exit } of cases) test.skipIf(!binary)(`native stage uses one exec and one completion wait (exit ${exit}, ${mode})`, async () => {
  const filtered = mode === "include_only" || mode === "keyed filters";
  const delayedStartup = mode === "delayed recorder" || filtered;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gc-"));
  const root = path.join(directory, "stage"), evidence = path.join(directory, "evidence");
  fs.mkdirSync(root); fs.mkdirSync(evidence);
  const env = withoutInheritedGate(isolatedEnvironment(directory, checkEnvironment(process.env)));
  for (const key of [GATE_CHECK_EVIDENCE_ENV, GATE_CHECK_LAUNCH_ROOT_ENV, GATE_CHECK_ROOT_ENV, GATE_CHECK_ROOT_IDENTITY_ENV]) env[key] = undefined;
  env.TMPDIR = root;
  env.CODEX_HOME = path.join(root, "codex"); fs.mkdirSync(env.CODEX_HOME);
  env.PATH = [path.dirname(process.execPath), path.dirname(Bun.which("node")!), "/usr/bin", "/bin"].join(path.delimiter);
  Object.assign(env, { LLV_GATE_BUN: process.execPath, LLV_GATE_RUNNER: "off", DELEGATUS_AGENT_CPU: "off", DELEGATUS_CPU_PRESSURE: "off", LLV_GATE_LOCK_DIR: root });
  const first = deferred<ServerResponse>(), second = deferred<{ body: string; response: ServerResponse }>(), third = deferred<string>(), waiting = deferred<void>(), finished = deferred<void>();
  const verdict = deferred<Awaited<ReturnType<typeof runGateCheckTool>>>();
  const abort = new AbortController();
  const rootBinding = bindGateCheckRoot(root, filtered ? evidence : undefined);
  const nested = path.join(root, "nested");
  const log = path.join(filtered ? nested : root, "check.log");
  if (filtered) {
    fs.mkdirSync(nested);
    env.PRIVATE_SETTING = "excluded";
  }
  const toolCalls: string[] = [];
  let suppressedWatches = 0, suppressedCompletionNotifications = 0;
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
${mode === "include_only" ? '[shell_environment_policy]\ninclude_only = ["PATH", "HOME"]' : ""}
${mode === "keyed filters" ? '[shell_environment_policy.filters]\nPATH = "include"\nHOME = "include"\n"PRIVATE_*" = "exclude"' : ""}
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
      const notifications = mode === "missed completion" ? spyOn(fs, "watch").mockImplementation(((...args: Parameters<typeof fs.watch>) => {
        // Descriptor paths and ordinary paths must select the same directory.
        if (fs.realpathSync(args[0]) !== fs.realpathSync(`${log}.gate`)) return watch(...args);
        suppressedWatches++;
        return watch(args[0], (_event, name) => {
          if (!name || name.toString() === "exit") suppressedCompletionNotifications++;
        });
      }) as typeof fs.watch) : null;
      let held: ReturnType<typeof runGateCheckTool>;
      try { held = runGateCheckTool(message.params.arguments, rootBinding, abort.signal); }
      finally { notifications?.mockRestore(); }
      waiting.resolve();
      void held.then(result => {
        verdict.resolve(result);
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
    const currentConfig = filtered ? (await rpc("config/read", { cwd: root, includeLayers: false })).config as Record<string, unknown> : null;
    const config = currentConfig ? { shell_environment_policy: agentCodexPublicationPolicy(currentConfig.shell_environment_policy, env, rootBinding) } : undefined;
    const opened = await rpc("thread/start", { cwd: root, model: "fixture-model", approvalPolicy: "never", sandbox: "danger-full-access", dynamicTools: [gateCheckTool], config });
    const thread = opened.thread as { id: string };
    await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "run the check", text_elements: [] }] });
    const response = await bounded(first.promise);
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const record = ["/bin/bash", path.join(import.meta.dir, "gate-slot.sh"), "--record", log, process.execPath, fixture, root];
    const gateOptions = ["LLV_GATE_BUN", "LLV_GATE_RUNNER", "DELEGATUS_AGENT_CPU", "DELEGATUS_CPU_PRESSURE", "LLV_GATE_LOCK_DIR", "LLV_STATE_DIR", "XDG_CONFIG_HOME"];
    const recordedCommand = filtered ? ["/usr/bin/env", `TMPDIR=${nested}`, ...gateOptions.map(key => `${key}=${env[key]}`), ...record] : record;
    const launch = delayedStartup ? [process.execPath, launcher, root, ...recordedCommand] : recordedCommand;
    const cmd = (filtered ? 'test -z "${PRIVATE_SETTING+x}" && ' : "") + launch.map(quote).join(" ");
    const item = { id: "one-check", type: "function_call", call_id: "one-check", name: "exec_command", arguments: JSON.stringify({ cmd, yield_time_ms: filtered ? 3000 : 1 }) };
    response.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`);
    response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "fixture", status: "completed", output: [item] } })}\n\n`);
    const yielded = await bounded(second.promise);
    const output = JSON.parse(yielded.body).input.find((item: { type: string }) => item.type === "function_call_output");
    expect(output.output).toContain("Process running with session ID");
    let runId = filtered ? output.output.match(/runId=([a-f0-9]{64})/)?.[1] : undefined;
    if (filtered) expect(runId).toBeUndefined();
    if (delayedStartup) {
      expect(fs.existsSync(path.join(`${log}.gate`, "completion.json"))).toBe(false);
      fs.writeFileSync(path.join(root, "start-recorder"), "start");
    }
    if (!fs.existsSync(path.join(root, "ready"))) await bounded(new Promise<void>(resolve => {
      const check = () => { if (fs.existsSync(path.join(root, "ready"))) { readyWatcher?.close(); resolve(); } };
      readyWatcher = fs.watch(root, check); check();
    }));
    if (filtered) {
      const completion = JSON.parse(fs.readFileSync(path.join(`${log}.gate`, "completion.json"), "utf8"));
      runId = completion.runId;
      expect(runId).toMatch(/^[a-f0-9]{64}$/);
      const localIndex = path.join(root, ".gate-runs", `${runId}.json`);
      const retainedIndex = path.join(evidence, ".gate-runs", `${runId}.json`);
      expect(fs.readFileSync(retainedIndex, "utf8")).toBe(fs.readFileSync(localIndex, "utf8"));
      fs.unlinkSync(localIndex);
    }
    expect(fs.existsSync(path.join(`${log}.gate`, "completion.json"))).toBe(true);
    const waitItem = { id: "one-wait", type: "function_call", call_id: "one-wait", name: gateCheckTool.name,
      arguments: JSON.stringify({ ...(filtered ? { runId } : { log }), reason: "fixture comparator" }) };
    yielded.response.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: waitItem })}\n\n`);
    yielded.response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "fixture", status: "completed", output: [waitItem] } })}\n\n`);
    await bounded(Promise.race([waiting.promise, third.promise.then(() => { throw Error("native wait tool did not reach its handler"); })]));
    expect(suppressedWatches).toBe(mode === "missed completion" ? 1 : 0);
    expect(requests, diagnostics).toBe(2);
    expect(fs.existsSync(path.join(`${log}.gate`, "exit"))).toBe(false);
    for (let i = 0; i < 1000; i++) fs.appendFileSync(log, `progress ${i}\n`);
    await Promise.resolve();
    expect(requests).toBe(2);
    fs.writeFileSync(path.join(root, "release"), "release");
    const resumed = await bounded(third.promise);
    if (mode === "missed completion") expect(suppressedCompletionNotifications).toBeGreaterThan(0);
    expect(resumed).toContain(`finished exit=${exit}`);
    expect(resumed).toContain("completed work");
    if (filtered) {
      const receipt = await bounded(verdict.promise);
      expect(receipt.success).toBe(true);
      expect(JSON.parse(receipt.contentItems[0].text)).toMatchObject({ terminal: true, code: exit, runId });
      expect(resumed).toContain(runId!);
      expect(fs.existsSync(path.join(nested, ".gate-runs"))).toBe(false);
    }
    expect(requests).toBe(3);
    expect(toolCalls).toEqual([gateCheckTool.name]);
    expect(fs.readFileSync(path.join(`${log}.gate`, "exit"), "utf8")).toBe(`${exit}\n`);
    await bounded(finished.promise);
  } finally {
    readyWatcher?.close();
    fs.writeFileSync(path.join(root, "start-recorder"), "start");
    fs.writeFileSync(path.join(root, "release"), "release");
    abort.abort();
    await stopFixtureProcess(child);
    backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
