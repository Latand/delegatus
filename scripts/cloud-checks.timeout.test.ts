import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { AppServerCloudTransport, connectCloud, runCloudChecks } from "./cloud-checks";
import { openHostedCloudSession, type HostedCloudDependencies } from "../src/lib/pipelines/cloudHostedClient";
import { HostedSessionTimeout } from "../src/lib/pipelines/cloudHostedErrors";

const taskId = "00000000-0000-0000-0000-000000000001", cwd = "/workspace/repository";
const config = { account: { engine: "codex" as const, accountId: "fixture", kind: "managed" as const, home: "/fixture", transcriptRoot: "/fixture", env: { NODE_ENV: "test" as const } }, environmentId: "asenvcfg_fixture" };
const job = { head: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), inputs: {}, bundle: "bundle", timeoutMs: 100 };
function fixture(status: "interrupted" | "completed" | "failed" | "inProgress" | "refused" | "pending" = "interrupted", held = "thread/items/list", whenHeld?: () => void,
  commandEvidence: "completed" | "inProgress" | "missing" | "refused" = "completed", finishOnInterrupt = false) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let connections = 0, closes = 0, launchedCommand = "", interrupted = false;
  class Socket extends EventEmitter {
    readyState = 1;
    constructor(private recovery: boolean) { super(); }
    send(raw: string, callback?: (error?: Error) => void) {
      const request = JSON.parse(raw);
      if (request.id === undefined) return;
      calls.push({ method: request.method, params: request.params }); callback?.();
      if (request.method === "turn/interrupt") interrupted = true;
      if ((!this.recovery && request.method === held) || (this.recovery && status === "pending" && request.method === "thread/turns/list")) { whenHeld?.(); return; }
      let result: Record<string, unknown> = {};
      if (request.method === "thread/start") result = { model: "gpt-6.2-sol", thread: { id: taskId, environments: [{ environmentId: "ccarenv_fixture", environmentConfigId: config.environmentId, cwd }] } };
      if (request.method === "command/exec") result = { exitCode: 0 };
      if (request.method === "turn/start") {
        launchedCommand = (request.params.input as { text: string }[])[0]!.text.split("\n").slice(1).join("\n");
        result = { turn: { id: "turn-fixture" } };
      }
      if (request.method === "thread/items/list") result = { data: this.recovery && commandEvidence === "missing" ? [] : [{ turnId: "turn-fixture", item: {
        type: "commandExecution", status: this.recovery ? commandEvidence : "inProgress", command: launchedCommand,
      } }] };
      if (request.method === "thread/turns/list") result = { data: [{ id: "unrelated", status: "interrupted" }, { id: "turn-fixture", status: this.recovery ? status : finishOnInterrupt && interrupted ? "interrupted" : "inProgress" }] };
      const response = this.recovery && ((status === "refused" && request.method === "turn/interrupt")
        || (commandEvidence === "refused" && request.method === "thread/items/list"))
        ? { id: request.id, error: { code: -32602, message: "refused" } } : { id: request.id, result };
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify(response))));
    }
    terminate() { if (this.readyState === 3) return; this.readyState = 3; closes++; this.emit("close"); }
  }
  const dependencies: HostedCloudDependencies = { authenticate: async () => ({ token: "fixture" }),
    socket: () => new Socket(connections++ > 0) as unknown as WebSocket,
    fetch: async () => Response.json({ id: config.environmentId, repositories: [{ mount_path: cwd }] }), uuid: () => "fixture" };
  return { dependencies, calls, connections: () => connections, closes: () => closes };
}

test("real hosted session timer preserves its typed deadline cause for pending RPCs", async () => {
  const f = fixture();
  const session = await openHostedCloudSession({ account: config.account, signal: new AbortController().signal, assertCurrent() {} }, 50, f.dependencies);
  try { await expect(session.client.rpc("thread/items/list", { threadId: taskId })).rejects.toBeInstanceOf(HostedSessionTimeout); }
  finally { session.close(); }
  expect(f.closes()).toBe(1);
});

for (const held of ["thread/items/list", "thread/turns/list"]) for (const status of ["interrupted", "completed", "failed", "inProgress", "refused", "pending"] as const) {
  test(`session timeout during ${held}: one interrupt, cleanup ${status}, no publication or local fallback`, async () => {
    const f = fixture(status, held);
    const transport = new AppServerCloudTransport(config, (config, signal, timeout) => connectCloud(config, signal, timeout, f.dependencies), () => {},
      // Polling uses a frozen clock; the real session and cleanup timers run.
      { now: () => 0, sleep: async () => {} });
    const result = await transport.run(job);
    expect(result).toMatchObject({ kind: "invalid", diagnostic: { category: "timeout", taskUrl: `codex://threads/${taskId}?hostId=durable` } });
    expect(result.diagnostic!.reason).toContain(["interrupted", "completed", "failed"].includes(status) ? "cleanup confirmed" : "cleanup unresolved");
    expect(f.connections()).toBe(2);
    expect(f.calls.filter(call => call.method === "turn/interrupt")).toEqual([{ method: "turn/interrupt", params: { threadId: taskId, turnId: "turn-fixture" } }]);
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    expect(f.closes()).toBe(2);
    let local = 0;
    expect(await runCloudChecks(job, { run: async () => result }, async () => { local++; return 0; }, undefined, () => {})).toBe(1);
    expect(local).toBe(0);
  }, 15000);
}

test("timeout awaiting a turn identity records unresolved cleanup and never interrupts another turn", async () => {
  const f = fixture("interrupted", "turn/start");
  const result = await new AppServerCloudTransport(config, (config, signal, timeout) => connectCloud(config, signal, timeout, f.dependencies), () => {}).run(job);
  expect(result).toMatchObject({ kind: "invalid", diagnostic: { category: "timeout" } });
  expect(result.diagnostic!.reason).toContain("unresolved (no bound turn identity)");
  expect(f.calls.filter(call => call.method === "turn/interrupt")).toHaveLength(0);
});

test("a terminal model turn with a running command keeps timeout cleanup unresolved", async () => {
  const f = fixture("completed", "thread/items/list", undefined, "inProgress");
  const result = await new AppServerCloudTransport(config,
    (config, signal, timeout) => connectCloud(config, signal, timeout, f.dependencies), () => {},
    { now: () => 0, sleep: async () => {} }).run(job);
  expect(result).toMatchObject({ kind: "invalid", diagnostic: {
    category: "timeout", taskUrl: `codex://threads/${taskId}?hostId=durable`,
  } });
  expect(result.diagnostic!.reason).toContain("cleanup unresolved");
  expect(f.calls.filter(call => call.method === "turn/interrupt")).toHaveLength(1);
  expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  let local = 0;
  expect(await runCloudChecks(job, { run: async () => result }, async () => { local++; return 0; }, undefined, () => {})).toBe(1);
  expect(local).toBe(0);
});

test("polling deadline with terminal turn and running exact command refuses fallback", async () => {
  const f = fixture("interrupted", "not-held", undefined, "inProgress", true);
  let now = 0;
  const transport = new AppServerCloudTransport(config, (config, signal, timeout) => connectCloud(config, signal, timeout, f.dependencies), () => {}, {
    now: () => now, sleep: async () => { now = job.timeoutMs; },
  });
  const result = await transport.run(job);
  expect(result).toMatchObject({ kind: "invalid", diagnostic: { category: "timeout", taskUrl: `codex://threads/${taskId}?hostId=durable` } });
  expect(result.diagnostic!.reason).toContain("no bound command receipt");
  expect(result.diagnostic!.reason).toContain("cleanup unresolved");
  let local = 0;
  expect(await runCloudChecks(job, { run: async () => result }, async () => { local++; return 0; }, undefined, () => {})).toBe(1);
  expect(local).toBe(0);
});

for (const commandEvidence of ["missing", "refused"] as const) test(`terminal turn with ${commandEvidence} command records keeps cleanup unresolved`, async () => {
  const f = fixture("completed", "thread/items/list", undefined, commandEvidence);
  const result = await new AppServerCloudTransport(config,
    (config, signal, timeout) => connectCloud(config, signal, timeout, f.dependencies), () => {},
    { now: () => 0, sleep: async () => {} }).run(job);
  expect(result).toMatchObject({ kind: "invalid", diagnostic: {
    category: "timeout", taskUrl: `codex://threads/${taskId}?hostId=durable`,
  } });
  expect(result.diagnostic!.reason).toContain("cleanup unresolved");
  expect(f.calls.filter(call => call.method === "turn/interrupt")).toHaveLength(1);
});

for (const boundary of ["poll sleep", "interrupt acknowledgement"]) test(`deadline at ${boundary} sends exactly one interrupt`, async () => {
  const f = fixture("interrupted", boundary === "poll sleep" ? "not-held" : "turn/interrupt");
  let now = 0;
  const transport = new AppServerCloudTransport(config, (config, signal, timeout) => connectCloud(config, signal, timeout, f.dependencies), () => {}, {
    now: () => now,
    sleep: async () => {
      now = job.timeoutMs;
      if (boundary === "poll sleep") await new Promise(resolve => setTimeout(resolve, 150));
    },
  });
  const result = await transport.run(job);
  expect(result).toMatchObject({ kind: "invalid", diagnostic: { category: "timeout" } });
  expect(result.diagnostic!.reason).toContain("cleanup confirmed");
  expect(f.calls.filter(call => call.method === "turn/interrupt")).toHaveLength(1);
  expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  expect(f.closes()).toBe(2);
});

test("caller cancellation of a pending receipt remains cancelled", async () => {
  const abort = new AbortController();
  const f = fixture("interrupted", "thread/items/list", () => abort.abort());
  const result = await new AppServerCloudTransport(config,
    (config, signal, timeout) => connectCloud(config, signal, timeout, f.dependencies), () => {}).run({ ...job, timeoutMs: 5000 }, abort.signal);
  expect(result).toMatchObject({ kind: "invalid", diagnostic: { category: "cancelled", taskUrl: `codex://threads/${taskId}?hostId=durable` } });
  expect(f.connections()).toBe(1);
  expect(f.closes()).toBe(1);
});

// The polling deadline passes (frozen clock) while the hosted session is still
// alive; the provider then answers the interrupt, or a confirmation read that
// follows it (the turn status, or the command record once the turn is
// terminal), with a refusal, an account limit or a lost socket.
function failingAfterDeadline(failing: "turn/interrupt" | "thread/turns/list" | "thread/items/list", error: Record<string, unknown> | "close", recoveryStatus: "inProgress" | "interrupted") {
  const calls: { connection: number; method: string }[] = [];
  let connections = 0, command = "", interrupted = false;
  class Socket extends EventEmitter {
    readyState = 1;
    constructor(private connection: number) { super(); }
    send(raw: string, callback?: (error?: Error) => void) {
      const request = JSON.parse(raw);
      if (request.id === undefined) return;
      calls.push({ connection: this.connection, method: request.method }); callback?.();
      if (this.connection === 0 && request.method === "turn/interrupt") interrupted = true;
      if (this.connection === 0 && request.method === failing && (failing === "turn/interrupt" || interrupted)) {
        if (error === "close") { queueMicrotask(() => this.terminate()); return; }
        queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ id: request.id, error })))); return;
      }
      const status = this.connection > 0 ? recoveryStatus : failing === "thread/items/list" && interrupted ? "interrupted" : "inProgress";
      let result: Record<string, unknown> = {};
      if (request.method === "thread/start") result = { model: "gpt-6.2-sol", thread: { id: taskId, environments: [{ environmentId: "ccarenv_fixture", environmentConfigId: config.environmentId, cwd }] } };
      if (request.method === "command/exec") result = { exitCode: 0 };
      if (request.method === "turn/start") { command = (request.params.input as { text: string }[])[0]!.text.split("\n").slice(1).join("\n"); result = { turn: { id: "turn-fixture" } }; }
      if (request.method === "thread/items/list") result = { data: [{ turnId: "turn-fixture", item: { type: "commandExecution", status: status === "inProgress" ? "inProgress" : "completed", command } }] };
      if (request.method === "thread/turns/list") result = { data: [{ id: "turn-fixture", status }] };
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ id: request.id, result }))));
    }
    terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit("close"); }
  }
  const dependencies: HostedCloudDependencies = { authenticate: async () => ({ token: "fixture" }), socket: () => new Socket(connections++) as unknown as WebSocket,
    fetch: async () => Response.json({ id: config.environmentId, repositories: [{ mount_path: cwd }] }), uuid: () => "fixture" };
  return { dependencies, calls };
}
const failures = [["generic refusal", { code: -32602, message: "no active turn" }], ["account-limit refusal", { code: -32000, message: "x", data: { code: "usageLimitExceeded" } }], ["socket loss", "close"]] as const;
for (const failing of ["turn/interrupt", "thread/turns/list", "thread/items/list"] as const) for (const [name, error] of failures) for (const recoveryStatus of ["inProgress", "interrupted"] as const) {
  test(`deadline then ${failing} ${name}, recovery sees ${recoveryStatus}: timeout with task URL, one interrupt, no second attempt or local fallback`, async () => {
    const f = failingAfterDeadline(failing, error, recoveryStatus);
    let now = 0, local = 0;
    const lines: string[] = [], results: Awaited<ReturnType<AppServerCloudTransport["run"]>>[] = [];
    const transport = new AppServerCloudTransport(config, (config, signal, timeout) => connectCloud(config, signal, timeout, f.dependencies), () => {},
      { now: () => now, sleep: async () => { now += 1_000_000; } });
    const code = await runCloudChecks({ ...job, timeoutMs: 5000 }, { run: async (job, signal) => { const result = await transport.run(job, signal); results.push(result); return result; } },
      async () => { local++; return 0; }, undefined, line => lines.push(line));
    expect(code).not.toBe(0);
    expect(local).toBe(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "invalid", diagnostic: { category: "timeout", taskUrl: `codex://threads/${taskId}?hostId=durable` } });
    expect(results[0]!.diagnostic!.reason).toContain(recoveryStatus === "interrupted" ? "cleanup confirmed" : "cleanup unresolved");
    expect(lines.join("\n")).toContain(`[timeout]`);
    expect(lines.join("\n")).toContain(`codex://threads/${taskId}?hostId=durable`);
    expect(f.calls.filter(call => call.method === "turn/interrupt")).toHaveLength(1);
    expect(f.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  }, 20000);
}
