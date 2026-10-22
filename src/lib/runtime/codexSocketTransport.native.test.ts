import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "bun:test";
import { CodexSocketTransport, verifiedCodexSocketOwner } from "./codexSocketTransport";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";

const binary = process.env.LLV_CODEX_BINARY ?? "codex";
const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();

for (const mode of ["exit", "wrapped", "large", "boundary", "signal", "missing", "timeout", "ownership", "success"] as const) {
  test.skipIf(process.platform !== "linux")(`callback startup ${mode} preserves a bounded redacted cause on repeated launches`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "callback-"));
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        fs.rmSync(path.join(root, "ready"), { force: true });
        fs.rmSync(path.join(root, "ready.release"), { force: true });
        const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "codexSocketTransport.fixture.ts"), root, mode], {
          env: { ...process.env, DELEGATUS_CPU_PRESSURE: "off" }, stdout: "pipe", stderr: "pipe",
        });
        const output = new Response(child.stdout).text();
        const stderr = new Response(child.stderr).text();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([child.exited, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("owned callback fixture exceeded its parent deadline")), 15_000);
          })]);
          expect(child.exitCode, await stderr).toBe(0);
          const message = JSON.parse(await output).error as string;
          if (mode === "success") {
            expect(message).toBe("connected: probe");
            continue;
          }
          if (mode === "missing") {
            expect(message).toContain("ENOENT");
            expect(message).not.toContain(root);
            expect(message).toStartWith("Codex callback listener failed before dispatch: ");
            continue;
          }
          expect(message).toContain(mode === "ownership" ? "ownership could not be verified"
            : mode === "timeout" ? "timed out after 10000ms" : mode === "signal" ? "exited on signal SIGTERM" : "exited with code 23");
          expect(message).toContain("EADDRINUSE: callback bind refused");
          expect(message).not.toContain("private".repeat(8));
          expect(message).not.toContain(root);
          if (mode === "large" || mode === "boundary") expect(message).toContain("[stderr clipped]");
          expect(message.length).toBeLessThanOrEqual(2400);
          expect(message.startsWith("Codex callback listener failed before dispatch: ")).toBe(mode !== "ownership");
        } finally {
          if (timer) clearTimeout(timer);
          if (child.exitCode === null) child.kill("SIGKILL");
          await child.exited;
        }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 40_000);
}

// Every reviewed pin exposes the native private socket transport.
test.skipIf(process.platform === "win32" || !["codex-cli 0.154.0", "codex-cli 0.159.0", "codex-cli 0.162.1", "codex-cli 0.163.0"].includes(version))("native Codex replays a pending approval on reconnect and resolves its answer once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-native-"));
  // Nested gate homes exceed the Unix socket path limit on older pins.
  // This private home is used only while constructing the listener address.
  const listenerHome = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "cb-home-"));
  const home = path.join(root, "home"); const codex = path.join(root, "codex");
  for (const directory of [home, codex]) fs.mkdirSync(directory, { recursive: true });
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    await request.arrayBuffer();
    const first = calls++ === 0;
    const item = first ? { type: "function_call", name: "exec_command", call_id: "fixture-call", arguments: JSON.stringify({
      cmd: "printf callback-fixture", sandbox_permissions: "require_escalated", justification: "Approve the fixture command?",
    }) } : { type: "message", role: "assistant", id: "fixture-message", content: [{ type: "output_text", text: "Finished" }] };
    const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    return new Response(event("response.created", { response: { id: `response-${calls}` } })
      + event("response.output_item.done", { output_index: 0, item })
      + event("response.completed", { response: { id: `response-${calls}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
    { headers: { "content-type": "text/event-stream" } });
  } });
  fs.writeFileSync(path.join(codex, "config.toml"), `model = "fixture-model"
model_provider = "fixture"
web_search = "disabled"
[model_providers.fixture]
name = "Local fixture"
base_url = "http://127.0.0.1:${server.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[analytics]
enabled = false
[features]
apps = false
plugins = false
`);
  let transport: CodexSocketTransport | undefined;
  let owner: ReturnType<typeof captureProcessIdentity> | undefined;
  const nativeFiles: Array<{ file: string; ino: number; dev: number }> = [];
  const connect = (socket: CodexSocketTransport) => {
    let nextId = 0, buffer = "";
    const received: Record<string, unknown>[] = [];
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    socket.stdout.on("data", chunk => {
      buffer += String(chunk);
      for (;;) {
        const end = buffer.indexOf("\n"); if (end < 0) break;
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        received.push(message);
        const waiting = pending.get(message.id);
        if (waiting && !message.method) {
          pending.delete(message.id); clearTimeout(waiting.timer);
          if (message.error) waiting.reject(new Error(message.error.message)); else waiting.resolve(message.result);
        }
      }
    });
    return { received, rpc: (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`native ${method} timed out`)); }, 10_000);
      pending.set(id, { resolve, reject, timer });
      socket.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    }) };
  };
  const until = async (predicate: () => boolean, detail: () => string) => {
    const end = Date.now() + 15_000;
    while (!predicate()) { if (Date.now() >= end) throw new Error(detail()); await Bun.sleep(20); }
  };
  try {
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = listenerHome;
      transport = await CodexSocketTransport.launch(binary, ["app-server"], { cwd: root, detached: true,
        env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: home, CODEX_HOME: codex, TMPDIR: root, LLV_STATE_DIR: root, XDG_CONFIG_HOME: path.join(root, "config") } });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
    owner = captureProcessIdentity(transport.pid);
    const alias = transport.endpoint.slice("codex-unix:".length);
    if (fs.lstatSync(alias).isSymbolicLink()) {
      const physical = fs.readlinkSync(alias);
      for (const file of [physical, `${physical}.lock`]) {
        const entry = fs.lstatSync(file, { throwIfNoEntry: false });
        if (entry) nativeFiles.push({ file, ino: entry.ino, dev: entry.dev });
      }
    }
    expect(verifiedCodexSocketOwner({ endpoint: transport.endpoint, process: owner })).toBeTrue();
    expect(verifiedCodexSocketOwner({ endpoint: transport.endpoint, process: { ...owner, startIdentity: "another-process" } })).toBeFalse();
    const first = connect(transport);
    const initialize = { clientInfo: { name: "callback-fixture", version: "0" }, capabilities: { experimentalApi: true } };
    await first.rpc("initialize", initialize);
    transport.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const started = await first.rpc("thread/start", { cwd: root, sandbox: "read-only", approvalPolicy: "on-request" }) as { thread: { id: string } };
    await first.rpc("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "Run the fixture command" }] });
    await until(() => first.received.some(message => message.method === "item/commandExecution/requestApproval"), () => `native approval missing: ${JSON.stringify(first.received).slice(-3000)}`);
    const approval = first.received.find(message => message.method === "item/commandExecution/requestApproval")!;
    const endpoint = transport.endpoint;
    transport.disconnect();
    transport = await CodexSocketTransport.reconnect({ endpoint, process: owner });
    const second = connect(transport);
    await second.rpc("initialize", initialize);
    transport.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    await second.rpc("thread/resume", { threadId: started.thread.id });
    await until(() => second.received.some(message => message.id === approval.id && message.method === approval.method), () => "native callback was not replayed");
    const replay = second.received.find(message => message.id === approval.id && message.method === approval.method)!;
    expect(replay.params).toEqual(approval.params);
    transport.stdin.write(`${JSON.stringify({ id: replay.id, result: { decision: "decline" } })}\n`);
    await until(() => second.received.some(message => message.method === "serverRequest/resolved"), () => "native answer was not resolved");
    await until(() => second.received.some(message => message.method === "turn/completed"), () => "native turn did not finish");
    expect(second.received.filter(message => message.method === "serverRequest/resolved")).toHaveLength(1);
  } finally {
    transport?.disconnect();
    if (owner && processIdentityStatus(owner) === "alive") {
      try { process.kill(-owner.pid, "SIGKILL"); } catch { /* already exited */ }
      await until(() => processIdentityStatus(owner!) === "dead", () => "native fixture process did not exit");
    }
    for (const recorded of nativeFiles) {
      const entry = fs.lstatSync(recorded.file, { throwIfNoEntry: false });
      if (entry?.ino === recorded.ino && entry.dev === recorded.dev) fs.unlinkSync(recorded.file);
    }
    server.stop(true);
    fs.rmSync(listenerHome, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
