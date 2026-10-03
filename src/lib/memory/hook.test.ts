import { expect, test } from "bun:test";
import { installCodexMemoryHook, memoryHookOutput, memoryHookSource } from "./hook";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
test("both native hooks emit only additionalContext and never edit or block the prompt", () => {
  for (const engine of ["claude", "codex"]) {
    expect(memoryHookOutput("background", engine)).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "background" } });
    expect(memoryHookOutput("", engine)).toEqual({});
  }
});
test("hook crosses the real bearer perimeter and consumes exact FIFO receipts even when the Viewer declines", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hook-"));
  const oldToken = process.env.LLV_TOKEN; process.env.LLV_TOKEN = "synthetic-hook-token";
  const queue = path.join(root, "queue");
  const prompt = "Identical synthetic prompt";
  fs.writeFileSync(queue, ["operator-old", "machine-new"].map(id => JSON.stringify({ id, digest: crypto.createHash("sha256").update(prompt).digest("hex") })).join("\n") + "\n");
  const received: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const gate = proxy(new NextRequest(request));
    if (gate.status !== 200) return gate;
    received.push((await request.json()).delegatus_delivery_id);
    return Response.json({ block: received.length === 1 ? "" : "Synthetic additional context" });
  } });
  try {
    for (let i = 0; i < 2; i++) {
      const proc = Bun.spawn(["bun", "-e", memoryHookSource(`http://127.0.0.1:${server.port}`, process.env.LLV_TOKEN, queue)], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LLV_SPAWN_CAPABILITY: "synthetic-capability" } });
      proc.stdin.write(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt })); proc.stdin.end();
      expect(await proc.exited).toBe(0);
      const output = await new Response(proc.stdout).text();
      expect(output.length > 0).toBe(i === 1);
    }
    expect(received).toEqual(["operator-old", "machine-new"]);
  } finally {
    server.stop(true); if (oldToken === undefined) delete process.env.LLV_TOKEN; else process.env.LLV_TOKEN = oldToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("the standalone hook exits zero on invalid input and unavailable service", async () => {
  for (const input of ["broken", JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "fixture", session_id: "fixture" })]) {
    const proc = Bun.spawn(["bun", "-e", memoryHookSource("http://127.0.0.1:1")], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LLV_SPAWN_CAPABILITY: "fixture" } });
    proc.stdin.write(input); proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("");
  }
});

for (const mode of ["delayed endpoint", "hung endpoint", "delayed response body", "delayed input"] as const) {
  test(`the standalone hook shares a 1500ms fail-open deadline across ${mode}`, async () => {
    let calls = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch() {
      calls++;
      if (mode === "hung endpoint") return await new Promise<Response>(() => {});
      if (mode === "delayed response body") {
        return new Response(new ReadableStream({ async start(controller) {
          controller.enqueue(new TextEncoder().encode('{"block":"'));
          await Bun.sleep(1650);
          controller.enqueue(new TextEncoder().encode('Late synthetic context"}'));
          controller.close();
        } }));
      }
      await Bun.sleep(mode === "delayed input" ? 750 : 1650);
      return Response.json({ block: "Late synthetic context" });
    } });
    const started = performance.now();
    const proc = Bun.spawn(["bun", "-e", memoryHookSource(`http://127.0.0.1:${server.port}`)], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LLV_SPAWN_CAPABILITY: "synthetic-capability" },
    });
    try {
      if (mode === "delayed input") await Bun.sleep(900);
      proc.stdin.write(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Synthetic prompt" })); proc.stdin.end();
      expect(await proc.exited).toBe(0);
      const elapsed = performance.now() - started;
      expect(await new Response(proc.stdout).text()).toBe("");
      expect(await new Response(proc.stderr).text()).toBe("");
      expect(calls).toBe(1);
      // Allow interpreter startup/scheduling while rejecting the old 1800ms timeout.
      expect(elapsed).toBeLessThan(1700);
    } finally { proc.kill(); await proc.exited; server.stop(true); }
  });
}

test("the standalone hook exits zero with empty output when input never ends", async () => {
  const started = performance.now();
  const proc = Bun.spawn(["bun", "-e", memoryHookSource("http://127.0.0.1:1")], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LLV_SPAWN_CAPABILITY: "synthetic-capability" },
  });
  try {
    proc.stdin.write('{"hook_event_name":');
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(performance.now() - started).toBeLessThan(1700);
  } finally { proc.stdin.end(); proc.kill(); await proc.exited; }
});

test("the standalone hook discards a block when response parsing finishes after expiry before the timer runs", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.json({ block: "Late parsed context" }); } });
  // Keep the timer queued while the parser holds the subprocess event loop.
  const slowParser = `const parse = Response.prototype.json;
    Response.prototype.json = async function() {
      const body = await parse.call(this);
      const until = performance.now() + 1550;
      while (performance.now() < until) {}
      return body;
    };`;
  const proc = Bun.spawn(["bun", "-e", slowParser + memoryHookSource(`http://127.0.0.1:${server.port}`)], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LLV_SPAWN_CAPABILITY: "synthetic-capability" },
  });
  try {
    proc.stdin.write(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Synthetic prompt" })); proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toBe("");
  } finally { proc.kill(); await proc.exited; server.stop(true); }
});

test("Next production compilation preserves the standalone Claude receipt hook", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hook-webpack-"));
  const require = createRequire(import.meta.url);
  const webpack = require("next/dist/compiled/webpack/webpack").webpack;
  let calls = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    expect((await request.json()).delegatus_delivery_id).toBe("synthetic-turn"); calls++;
    return Response.json({ block: "Synthetic compiled context" });
  } });
  try {
    const serialized = memoryHookSource("ENDPOINT", null, "QUEUE");
    const fn = serialized.slice(1, serialized.indexOf(')("ENDPOINT"'));
    const entry = path.join(root, "entry.js");
    fs.writeFileSync(entry, `const runHook = ${fn}; export function memoryHookSource(endpoint, token, queue) { return "(" + runHook.toString() + ")(" + JSON.stringify(endpoint) + "," + JSON.stringify(token) + "," + JSON.stringify(queue) + ").catch(() => {}).finally(() => { process.exitCode = 0; });"; }`);
    await new Promise<void>((resolve, reject) => {
      const compiler = webpack({ mode: "production", target: "node", entry, output: { path: root, filename: "compiled.cjs", library: { type: "commonjs2" } }, externalsPresets: { node: true }, optimization: { minimize: false } });
      compiler.run((error: Error | null, stats: { hasErrors(): boolean; toString(): string }) => {
        compiler.close(() => {});
        if (error || stats.hasErrors()) reject(error ?? Error(stats.toString())); else resolve();
      });
    });
    const queue = path.join(root, "queue");
    fs.writeFileSync(queue, JSON.stringify({ id: "synthetic-turn", digest: crypto.createHash("sha256").update("Synthetic prompt").digest("hex") }) + "\n");
    const compiled = require(path.join(root, "compiled.cjs"));
    const proc = Bun.spawn(["bun", "-e", compiled.memoryHookSource(`http://127.0.0.1:${server.port}`, null, queue)], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, LLV_SPAWN_CAPABILITY: "synthetic-capability" } });
    proc.stdin.write(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Synthetic prompt" })); proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain("Synthetic compiled context");
    expect(calls).toBe(1);
  } finally { server.stop(true); fs.rmSync(root, { recursive: true, force: true }); }
});

test("managed Codex config keeps native hooks and reserves enough tokens for ten thousand Unicode characters", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hook-config-"));
  try {
    const native = { type: "command", command: "synthetic-native-hook" };
    fs.writeFileSync(path.join(root, "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [native] }] } }));
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", LLV_SPAWN_CAPABILITY: "synthetic-capability", LLV_VIEWER_PORT: "8898", LLV_STATE_DIR: root };
    const installed = installCodexMemoryHook(root, env)!;
    // One token per UTF-8 byte bounds any text accepted by the 10K-char block.
    expect(installed.additionalContextLimit).toBeGreaterThanOrEqual(Buffer.byteLength("龘".repeat(10000)));
    installCodexMemoryHook(root, env);
    const config = JSON.parse(fs.readFileSync(path.join(root, "hooks.json"), "utf8"));
    expect(config.hooks.UserPromptSubmit).toEqual([{ hooks: [native] }, { hooks: [installed] }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
