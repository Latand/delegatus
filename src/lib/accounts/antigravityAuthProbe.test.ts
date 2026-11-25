import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { readAntigravityAuthState, recordAntigravityAuthState } from "./antigravity";
import { probeAntigravityAuth, type AntigravityProbeSpawn } from "./antigravityAuthProbe";

/*
 * The "Check sign-in" probe: `initialize` then `session/new` against a stubbed
 * `agy`, never a real one. The stub child has no pid, so the probe's group
 * signal falls through to `child.kill` and nothing outside the test is touched.
 */

type Reply = { result?: unknown; error?: { code: number; message: string } } | "silent";
type Script = (method: string, params: Record<string, unknown>) => Reply;

let root: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-probe-test-"));
  for (const name of ["LLV_STATE_DIR", "LLV_ANTIGRAVITY_BIN", "XDG_CONFIG_HOME"]) saved[name] = process.env[name];
  process.env.LLV_STATE_DIR = path.join(root, "state");
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  /* An existing executable stands for an installed agy; the spawn itself is stubbed. */
  process.env.LLV_ANTIGRAVITY_BIN = process.execPath;
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function stub(script: Script) {
  const launches: { command: string; args: string[]; cwd: string | undefined }[] = [];
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const kills: (NodeJS.Signals | number | undefined)[] = [];
  const spawnProcess: AntigravityProbeSpawn = (command, args, options) => {
    launches.push({ command, args, cwd: options.cwd?.toString() });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin, stdout, stderr, pid: undefined, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      kill: (signal?: NodeJS.Signals | number) => { kills.push(signal); child.exitCode = 0; emitter.emit("exit", 0, null); return true; },
    });
    let buffer = "";
    stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
        requests.push({ method: message.method, params: message.params });
        const reply = script(message.method, message.params);
        if (reply !== "silent") stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply })}\n`);
      }
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawnProcess, launches, requests, kills };
}

const signedIn: Script = (method) => method === "session/new"
  ? { result: { sessionId: "probe-session-1", _meta: { antigravity: { tier: { name: "Google AI Pro", id: "g1-pro-tier" } } } } }
  : { result: {} };

test("a session that opens means signed in, and the tier is recorded", async () => {
  const agy = stub(signedIn);
  const result = await probeAntigravityAuth({ spawnProcess: agy.spawnProcess });
  expect(result).toMatchObject({ cli: "found", auth: "signed_in", plan: "Google AI Pro" });
  expect(agy.launches).toHaveLength(1);
  expect(agy.launches[0]!.args).toEqual(["acp", "--disable-telemetry"]);
  expect(agy.requests.map((request) => request.method).slice(0, 2)).toEqual(["initialize", "session/new"]);
  /* A scratch directory, never the operator's folder, and no MCP servers. */
  expect(agy.requests[1]!.params.mcpServers).toEqual([]);
  expect(agy.requests[1]!.params.cwd).toBe(agy.launches[0]!.cwd!);
  expect(agy.launches[0]!.cwd!.startsWith(os.tmpdir())).toBe(true);
  expect(fs.existsSync(agy.launches[0]!.cwd!)).toBe(false);
  expect(readAntigravityAuthState()).toMatchObject({ authenticated: true, tierName: "Google AI Pro", tierId: "g1-pro-tier" });
  /* The child is stopped. */
  expect(agy.kills.length).toBeGreaterThan(0);
});

test("the ACP auth-required error (-32000) records signed out and clears a stale tier", async () => {
  recordAntigravityAuthState({ authenticated: true, tierName: "Google AI Pro", tierId: null, checkedAt: "2026-11-01T00:00:00.000Z" });
  const agy = stub((method) => method === "session/new" ? { error: { code: -32000, message: "Authentication required" } } : { result: {} });
  const result = await probeAntigravityAuth({ spawnProcess: agy.spawnProcess });
  expect(result).toMatchObject({ cli: "found", auth: "signed_out", plan: null });
  expect(readAntigravityAuthState()).toMatchObject({ authenticated: false, tierName: null });
  expect(agy.kills.length).toBeGreaterThan(0);
});

test("an error whose words say the account is not signed in also records signed out", async () => {
  const agy = stub((method) => method === "session/new" ? { error: { code: -32603, message: "no OAuth credentials found, please sign in" } } : { result: {} });
  const result = await probeAntigravityAuth({ spawnProcess: agy.spawnProcess });
  expect(result.auth).toBe("signed_out");
});

test("another error proves nothing: the recorded state stays and the answer is inconclusive", async () => {
  recordAntigravityAuthState({ authenticated: true, tierName: "Google AI Pro", tierId: null, checkedAt: "2026-11-01T00:00:00.000Z" });
  const agy = stub((method) => method === "session/new" ? { error: { code: -32603, message: "internal error" } } : { result: {} });
  const result = await probeAntigravityAuth({ spawnProcess: agy.spawnProcess });
  expect(result).toMatchObject({ cli: "found", auth: "signed_in", plan: "Google AI Pro", inconclusive: true });
  expect(readAntigravityAuthState()).toMatchObject({ authenticated: true, checkedAt: "2026-11-01T00:00:00.000Z" });
});

test("a timeout leaves the record untouched and kills the child", async () => {
  const agy = stub(() => "silent");
  const result = await probeAntigravityAuth({ spawnProcess: agy.spawnProcess, timeoutMs: 60 });
  expect(result).toMatchObject({ cli: "found", auth: "unknown", inconclusive: true });
  expect(readAntigravityAuthState()).toBeNull();
  expect(agy.kills.length).toBeGreaterThan(0);
});

test("a child that exits before answering is inconclusive", async () => {
  const spawnProcess: AntigravityProbeSpawn = () => {
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, exitCode: null, signalCode: null, kill: () => true });
    queueMicrotask(() => emitter.emit("exit", 1, null));
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  const result = await probeAntigravityAuth({ spawnProcess });
  expect(result).toMatchObject({ auth: "unknown", inconclusive: true });
  expect(readAntigravityAuthState()).toBeNull();
});

test("concurrent checks share one child", async () => {
  const agy = stub(signedIn);
  const [first, second] = await Promise.all([probeAntigravityAuth({ spawnProcess: agy.spawnProcess }), probeAntigravityAuth({ spawnProcess: agy.spawnProcess })]);
  expect(agy.launches).toHaveLength(1);
  expect(first).toEqual(second);
  /* The next check starts its own. */
  await probeAntigravityAuth({ spawnProcess: agy.spawnProcess });
  expect(agy.launches).toHaveLength(2);
});

test("a missing agy is answered without starting anything", async () => {
  process.env.LLV_ANTIGRAVITY_BIN = path.join(root, "no-such-agy");
  const agy = stub(signedIn);
  const result = await probeAntigravityAuth({ spawnProcess: agy.spawnProcess });
  expect(result).toMatchObject({ cli: "missing", auth: "unknown" });
  expect(agy.launches).toHaveLength(0);
  expect(readAntigravityAuthState()).toBeNull();
});
