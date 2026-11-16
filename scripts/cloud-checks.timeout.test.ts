import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { AppServerCloudTransport, connectCloud, runCloudChecks } from "./cloud-checks";
import { openHostedCloudSession, type HostedCloudDependencies } from "../src/lib/pipelines/cloudHostedClient";
import { HostedSessionTimeout } from "../src/lib/pipelines/cloudHostedErrors";

const taskId = "00000000-0000-0000-0000-000000000001", cwd = "/workspace/repository";
const config = { account: { engine: "codex" as const, accountId: "fixture", kind: "managed" as const, home: "/fixture", transcriptRoot: "/fixture", env: {} }, environmentId: "asenvcfg_fixture" };
const job = { head: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), inputs: {}, bundle: "bundle", timeoutMs: 100 };
function fixture(status: "interrupted" | "completed" | "failed" | "inProgress" | "refused" | "pending" = "interrupted", held = "thread/items/list") {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let connections = 0, closes = 0;
  class Socket extends EventEmitter {
    readyState = 1;
    constructor(private recovery: boolean) { super(); }
    send(raw: string, callback?: (error?: Error) => void) {
      const request = JSON.parse(raw);
      if (request.id === undefined) return;
      calls.push({ method: request.method, params: request.params }); callback?.();
      if ((!this.recovery && request.method === held) || (this.recovery && status === "pending" && request.method === "thread/turns/list")) return;
      let result: Record<string, unknown> = {};
      if (request.method === "thread/start") result = { model: "gpt-6.1-sol", thread: { id: taskId, environments: [{ environmentId: "ccarenv_fixture", environmentConfigId: config.environmentId, cwd }] } };
      if (request.method === "command/exec") result = { exitCode: 0 };
      if (request.method === "turn/start") result = { turn: { id: "turn-fixture" } };
      if (request.method === "thread/items/list") result = { data: [] };
      if (request.method === "thread/turns/list") result = { data: [{ id: "unrelated", status: "interrupted" }, { id: "turn-fixture", status: this.recovery ? status : "inProgress" }] };
      const response = this.recovery && status === "refused" && request.method === "turn/interrupt"
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
