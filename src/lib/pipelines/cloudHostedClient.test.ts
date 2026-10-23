import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type WebSocket from "ws";
import { createHostedCloudStageClient, type HostedCloudDependencies } from "./cloudHostedClient";
import type { CloudTaskAccess, CloudStageClient } from "./cloudStage";

type Frame = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
const model = "gpt-6.1-sol", environmentId = "asenvcfg_fixture", headSha = "a".repeat(40);
const environment = { environmentId: "ccarenv_fixture", environmentConfigId: environmentId, cwd: "/workspace/project" };
const thread = { id: "thread-fixture", ephemeral: false, environments: [environment] };
const turn = { id: "turn-fixture", model, status: "completed" };
const account = { engine: "codex" as const, accountId: "fixture", kind: "managed" as const, home: "fixture", transcriptRoot: "fixture", env: { NODE_ENV: "test" as const } };

function fixture(overrides: Partial<HostedCloudDependencies> = {}) {
  const frames: Frame[] = [], sockets: FakeSocket[] = [], fetches: { url: string; options?: RequestInit }[] = [];
  let handle: (frame: Frame, socket: FakeSocket) => unknown = frame => {
    switch (frame.method) {
      case "initialize": return {};
      case "thread/start": return { model, thread };
      case "turn/start": return { turn };
      case "command/exec": return { exitCode: 0, stdout: headSha + "\n", stderr: "" };
      case "thread/read": return { model, thread };
      case "thread/turns/list": return { data: [turn], nextCursor: null };
      case "thread/items/list": return { data: [{ turnId: turn.id, item: { type: "agentMessage", text: 'Verdict: pass\n```json\n{"status":"pass","findings":[]}\n```' } }], nextCursor: null };
      default: return {};
    }
  };
  class FakeSocket extends EventEmitter {
    readyState = 1;
    send(value: string, done?: (error?: Error) => void) {
      const frame = JSON.parse(value) as Frame; frames.push(frame); done?.();
      if (frame.id !== undefined && frame.method) queueMicrotask(() => {
        try {
          const result = handle(frame, this);
          if (result !== undefined) this.receive({ id: frame.id, result });
        } catch { this.receive({ id: frame.id, error: { code: -32602, message: "fixture-auth" } }); }
      });
    }
    receive(frame: Frame) { this.emit("message", Buffer.from(JSON.stringify(frame))); }
    terminate() { this.readyState = 3; this.emit("close"); }
  }
  const abort = new AbortController();
  let current = true, authCalls = 0;
  const client = createHostedCloudStageClient({
    authenticate: async () => { authCalls++; return { token: "fixture-auth", account: "fixture-routing" }; },
    socket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; },
    fetch: (async (url: string | URL | Request, options?: RequestInit) => {
      fetches.push({ url: String(url), options });
      return Response.json({ id: environmentId, repositories: [{ mount_path: environment.cwd }] });
    }),
    uuid: () => "command-fixture",
    ...overrides,
  });
  const access: CloudTaskAccess = { taskId: thread.id, thread: { threadId: thread.id, turnId: turn.id,
    hosted: { environmentId: environment.environmentId, cwd: environment.cwd, model } },
    environmentId, branch: "pipeline/fixture", headSha, account, signal: abort.signal,
    assertCurrent: () => { if (!current) throw new Error("lane moved"); } };
  const input: Parameters<CloudStageClient["submit"]>[0] = { ...access, prompt: "Review the lane", model, reasoningEffort: "xhigh", allowProviderModelFallback: false };
  const original = handle;
  return { client, access, input, frames, fetches, sockets, abort, original,
    authCalls: () => authCalls, supersede: () => { current = false; },
    respond: (fn: typeof handle) => { handle = fn; } };
}

test("hosted launch pins model, effort, permissions, ASB configuration and published branch before the work turn", async () => {
  const f = fixture();
  const receipt = await f.client.submit(f.input);
  expect(receipt).toEqual({ taskId: thread.id, taskUrl: `https://chatgpt.com/codex/tasks/${thread.id}`, thread: f.access.thread });
  expect(f.fetches[0]!.url).toEndWith(`/v1/environment-configs/${environmentId}`);
  expect(f.fetches[0]!.options?.redirect).toBe("error");
  expect(f.frames.filter(frame => frame.method).map(frame => frame.method)).toEqual(["initialize", "initialized", "thread/start", "command/exec", "turn/start"]);
  expect(f.frames.find(frame => frame.method === "thread/start")!.params).toMatchObject({ model, allowProviderModelFallback: false,
    ephemeral: false, sandbox: "danger-full-access", approvalPolicy: "never", deferredEnvironment: true,
    config: { model_reasoning_effort: "xhigh" }, environments: [{ environmentConfigId: environmentId, cwd: environment.cwd }] });
  expect(f.frames.find(frame => frame.method === "command/exec")!.params).toMatchObject({ environmentId: environment.environmentId, processId: "command-fixture", outputBytesCap: 8192 });
  expect(String((f.frames.find(frame => frame.method === "command/exec")!.params!.command as string[])[2])).toContain("'refs/heads/pipeline/fixture'");
  expect(f.frames.find(frame => frame.method === "turn/start")!.params).toMatchObject({ threadId: thread.id, model,
    allowProviderModelFallback: false, effort: "xhigh", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
    input: [{ type: "text", text: f.input.prompt, text_elements: [] }] });
  expect(f.sockets.every(socket => socket.readyState === 3)).toBe(true);
});

test.each(["model", "environment", "head", "rpc", "disconnect"])("launch refuses %s mismatch without starting work or replaying a mutation", async failure => {
  const f = fixture();
  f.respond((frame, socket) => {
    if (frame.method === "thread/start") {
      if (failure === "model") return { model: "other-model", thread };
      if (failure === "environment") return { model, thread: { ...thread, environments: [{ ...environment, environmentConfigId: "asenvcfg_other" }] } };
      if (failure === "rpc") throw new Error("fixture-auth");
      if (failure === "disconnect") { socket.terminate(); return undefined; }
    }
    if (failure === "head" && frame.method === "command/exec") return { exitCode: 0, stdout: "b".repeat(40), stderr: "" };
    return f.original(frame, socket);
  });
  const error = await f.client.submit(f.input).then(() => "unexpected success", error => error.message);
  expect(error).toStartWith("Codex Cloud "); expect(error).not.toContain("fixture-auth");
  expect(f.frames.filter(frame => frame.method === "thread/start")).toHaveLength(1);
  expect(f.frames.filter(frame => frame.method === "turn/start")).toHaveLength(0);
});

test("status reads only its recorded turn, ignores foreign activity and makes no permission change", async () => {
  const f = fixture();
  f.respond((frame, socket) => {
    socket.receive({ id: 80, method: "item/commandExecution/requestApproval", params: { threadId: thread.id } });
    socket.receive({ id: 81, method: "item/fileChange/requestApproval", params: { threadId: "foreign" } });
    socket.receive({ method: "model/rerouted", params: { threadId: "foreign" } });
    if (frame.method === "thread/turns/list") return { data: [{ id: "foreign-turn", status: "failed", model: "other-model" }, turn] };
    return f.original(frame, socket);
  });
  expect(await f.client.poll(f.access)).toEqual({ state: "completed", model });
  expect(f.frames.map(frame => frame.method)).toEqual(["initialize", "initialized", "thread/read", "thread/turns/list"]);
});

test.each(["inProgress", "failed", "interrupted", "unknown"])("status maps %s and refuses unknown states", async status => {
  const f = fixture(); f.respond((frame, socket) => frame.method === "thread/turns/list" ? { data: [{ ...turn, status }] } : f.original(frame, socket));
  if (status === "unknown") await expect(f.client.poll(f.access)).rejects.toThrow("turn status unknown");
  else expect((await f.client.poll(f.access)).state).toBe(status === "inProgress" ? "pending" : "failed");
});

test.each(["model", "thread", "environment", "turn", "rerouted", "missing"])("status fails closed for %s", async failure => {
  const f = fixture();
  f.respond((frame, socket) => {
    if (frame.method === "thread/read") {
      if (failure === "model") return { model: "other-model", thread };
      if (failure === "thread") return { model, thread: { ...thread, id: "foreign" } };
      if (failure === "environment") return { model, thread: { ...thread, environments: [{ ...environment, environmentConfigId: "asenvcfg_other" }] } };
      if (failure === "rerouted") socket.receive({ method: "model/rerouted", params: { threadId: thread.id } });
    }
    if (frame.method === "thread/turns/list") {
      if (failure === "turn") return { data: [{ ...turn, model: "other-model" }] };
      if (failure === "missing") return { data: [] };
    }
    return f.original(frame, socket);
  });
  await expect(f.client.poll(f.access)).rejects.toThrow("Codex Cloud");
});

test("only owned launch approval requests receive acceptance, server and client IDs stay separate", async () => {
  const f = fixture();
  f.respond((frame, socket) => {
    if (frame.method === "command/exec") {
      socket.receive({ id: frame.id, method: "item/commandExecution/requestApproval", params: { threadId: "foreign" } });
      socket.receive({ id: 90, method: "item/commandExecution/requestApproval", params: { threadId: thread.id } });
    }
    return f.original(frame, socket);
  });
  await f.client.submit(f.input);
  expect(f.frames.filter(frame => !frame.method && frame.id !== undefined)).toEqual([{ id: 90, result: { decision: "acceptForSession" } }]);
});

test.each(["superseded", "abort"])("a %s response cannot start the next remote effect", async failure => {
  const f = fixture();
  f.respond((frame, socket) => {
    if (frame.method === "thread/start") {
      if (failure === "superseded") f.supersede(); else f.abort.abort();
    }
    return f.original(frame, socket);
  });
  await expect(f.client.submit(f.input)).rejects.toThrow("Codex Cloud");
  expect(f.frames.filter(frame => frame.method === "turn/start" || frame.method === "command/exec")).toHaveLength(0);
});

test("abort releases an unanswered socket read", async () => {
  const f = fixture();
  f.respond((frame, socket) => {
    if (frame.method === "thread/read") { f.abort.abort(); return undefined; }
    return f.original(frame, socket);
  });
  await expect(f.client.poll(f.access)).rejects.toThrow("timed out");
  expect(f.sockets[0]!.readyState).toBe(3);
});

test.each(["success", "foreign", "missing", "changed-head", "cursor"])("final message read handles %s", async failure => {
  const f = fixture();
  f.respond((frame, socket) => {
    if (frame.method === "command/exec" && failure === "changed-head") return { exitCode: 0, stdout: "b".repeat(40) };
    if (frame.method === "thread/items/list") {
      if (failure === "foreign") return { data: [{ turnId: "foreign", item: { type: "agentMessage", text: "foreign" } }] };
      if (failure === "missing") return { data: [] };
      if (failure === "cursor") return { data: [], nextCursor: "repeated" };
      return { data: [{ turnId: turn.id, item: { type: "agentMessage", text: "Verdict: pass fixture-auth" } }] };
    }
    return f.original(frame, socket);
  });
  if (failure === "success") expect(await f.client.readFinalMessage(f.access)).toEqual({ message: "Verdict: pass [redacted]", model });
  else await expect(f.client.readFinalMessage(f.access)).rejects.toThrow("Codex Cloud");
});

test.each(["success", "checksum", "chunk"])("chunked diff export verifies %s without launching a turn", async failure => {
  const f = fixture(), patch = Buffer.from("fixture diff\n"), checksum = createHash("sha256").update(patch).digest("hex");
  let commands = 0;
  f.respond((frame, socket) => {
    if (frame.method === "command/exec") return { exitCode: 0, stdout: commands++ === 0
      ? JSON.stringify({ bytes: patch.length, sha256: failure === "checksum" ? "b".repeat(64) : checksum })
      : failure === "chunk" ? "bad" : patch.toString("base64") };
    return f.original(frame, socket);
  });
  if (failure === "success") expect(await f.client.readDiff(f.access)).toBe(patch.toString());
  else await expect(f.client.readDiff(f.access)).rejects.toThrow("Codex Cloud diff");
  expect(f.frames.some(frame => frame.method === "turn/start" || frame.method === "thread/resume")).toBe(false);
});

test("unsupported models and source-version configuration IDs are refused", async () => {
  const f = fixture();
  expect(f.client.supportsModel("other-model", "xhigh")).toBe(false);
  expect(f.client.supportsModel(model, "unsupported")).toBe(false);
  await expect(f.client.submit({ ...f.input, environmentId: "cecfg_fixture" })).rejects.toThrow("ASB configuration");
  expect(f.frames.some(frame => frame.method === "thread/start")).toBe(false);
});

test("the verified minimal hosted metadata retains launch proof across status reads", async () => {
  const f = fixture();
  const minimal = { ...thread, environments: [{ environmentId: environment.environmentId, cwd: environment.cwd }] };
  f.respond((frame, socket) => {
    if (frame.method === "thread/start") return { model, thread: minimal };
    if (frame.method === "thread/read") return { thread: minimal };
    return f.original(frame, socket);
  });
  const receipt = await f.client.submit(f.input);
  expect(receipt.thread?.hosted).toEqual({ environmentId: environment.environmentId, cwd: environment.cwd, model });
  expect(await f.client.poll({ ...f.access, thread: JSON.parse(JSON.stringify(receipt.thread)) })).toEqual({ state: "completed", model });
  await expect(f.client.poll({ ...f.access, thread: { threadId: thread.id, turnId: turn.id } })).rejects.toThrow("thread receipt missing");
});

test("a known accepted receipt is returned after authority changes without another effect", async () => {
  const f = fixture();
  f.respond((frame, socket) => { if (frame.method === "turn/start") f.supersede(); return f.original(frame, socket); });
  const receipt = await f.client.submit(f.input);
  expect(receipt.thread?.turnId).toBe(turn.id);
  expect(f.frames.at(-1)!.method).toBe("turn/start");
});

test.each(["auth", "http", "catalog", "oversized"])("hosted %s failure is bounded, credential-free and starts no thread", async failure => {
  const f = fixture(failure === "auth" ? { authenticate: async () => { throw new Error("fixture-auth"); } } : {
    fetch: (async () => failure === "http" ? new Response("fixture-auth", { status: 403 })
      : failure === "catalog" ? Response.json({ id: "foreign", repositories: [] }) : new Response("x".repeat(1024 * 1024 + 1))),
  });
  const message = await f.client.submit(f.input).then(() => "unexpected success", error => error.message);
  expect(message).toStartWith("Codex Cloud "); expect(message).not.toContain("fixture-auth");
  expect(f.frames.some(frame => frame.method === "thread/start")).toBe(false);
  expect(f.sockets.every(socket => socket.readyState === 3)).toBe(true);
});

test.each(["command/exec", "thread/read", "thread/turns/list", "thread/items/list"])("authority is checked after the %s await", async seam => {
  const f = fixture();
  f.respond((frame, socket) => { if (frame.method === seam) f.supersede(); return f.original(frame, socket); });
  if (seam === "command/exec") await expect(f.client.submit(f.input)).rejects.toThrow("Codex Cloud");
  else await expect(f.client.readFinalMessage(f.access)).rejects.toThrow("Codex Cloud");
  expect(f.frames.at(-1)!.method).toBe(seam);
});
