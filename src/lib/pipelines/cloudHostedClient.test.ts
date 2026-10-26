import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type WebSocket from "ws";
import { createHostedCloudStageClient, CloudSubmissionNotStartedError, type HostedCloudDependencies } from "./cloudHostedClient";
import type { CloudTaskAccess, CloudStageClient } from "./cloudStage";

type Frame = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
const model = "gpt-6.1-sol", environmentId = "asenvcfg_fixture", headSha = "a".repeat(40);
const environment = { environmentId: "ccarenv_fixture", environmentConfigId: environmentId, cwd: "/workspace/project" };
const thread = { id: "00000000-0000-0000-0000-000000000000", ephemeral: false, environments: [environment] };
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

test.each([200, 403, 404] as const)("account catalog admission handles HTTP %i before any Cloud work", async status => {
  const f = fixture({ fetch: async () => status === 200 ? Response.json({ id: environmentId, repositories: [{ mount_path: environment.cwd }] }) : new Response(null, { status }) });
  expect(await f.client.hasEnvironment(f.access)).toBe(status === 200);
  expect(f.frames).toHaveLength(0);
  expect(f.sockets).toHaveLength(0);
  expect(f.authCalls()).toBe(1);
});

test.each(["initialize", "turn/start"])("a lost %s reply preserves whether any model turn could have started", async seam => {
  const f = fixture();
  f.respond((frame, socket) => {
    if (frame.method === seam) { socket.terminate(); return undefined; }
    return f.original(frame, socket);
  });
  const error = await f.client.submit(f.input).catch(error => error);
  expect(error.category).toBe("unavailable");
  expect(error instanceof CloudSubmissionNotStartedError).toBe(seam === "initialize");
  expect(f.frames.filter(frame => frame.method === "turn/start")).toHaveLength(seam === "initialize" ? 0 : 1);
  expect(f.sockets.every(socket => socket.readyState === 3)).toBe(true);
});

test("account catalog admission keeps an unavailable cause and refuses withdrawal during authentication", async () => {
  const unavailable = fixture({ fetch: async () => { throw Object.assign(new Error("private diagnostic"), { code: "ECONNRESET" }); } });
  const error = await unavailable.client.hasEnvironment(unavailable.access).catch(error => error);
  expect(error.category).toBe("unavailable");
  expect(error.message).not.toContain("private diagnostic");
  const withdrawn = fixture({ authenticate: async () => { withdrawn.supersede(); return { token: "fixture-auth" }; } });
  await expect(withdrawn.client.hasEnvironment(withdrawn.access)).rejects.toThrow("lane moved");
  expect(withdrawn.fetches).toHaveLength(0);
});

test("hosted launch pins model, effort, permissions, ASB configuration and published branch before the work turn", async () => {
  const f = fixture();
  const receipt = await f.client.submit(f.input);
  expect(receipt).toEqual({ taskId: thread.id, taskUrl: `codex://threads/${thread.id}?hostId=durable`, thread: f.access.thread });
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

test.each(["default", "priority", "ultrafast"])("hosted submission refuses explicit %s tiers before authentication or remote I/O", async serviceTier => {
  const f = fixture();
  await expect(f.client.submit({ ...f.input, serviceTier })).rejects.toThrow("service tier unsupported");
  expect(f.authCalls()).toBe(0);
  expect(f.sockets).toHaveLength(0);
  expect(f.fetches).toHaveLength(0);
  expect(f.frames).toHaveLength(0);
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

test.each([
  { error: { message: "Environment setup failed: missing dependency", code: "environment_setup_failed" },
    diagnostic: "Codex Cloud turn failed (environment_setup_failed): Environment setup failed: missing dependency" },
  { error: { message: "Provider connection failed", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503, body: "fixture-auth" } }, additionalDetails: "fixture-auth" },
    diagnostic: "Codex Cloud turn failed (httpConnectionFailed): Provider connection failed" },
  { error: { message: "Quota exhausted", codexErrorInfo: "usageLimitExceeded" }, diagnostic: "Codex Cloud turn failed (usageLimitExceeded): Quota exhausted" },
  { error: { message: "Setup unavailable", code: "fixture-auth", payload: "fixture-auth" }, diagnostic: "Codex Cloud turn failed: Setup unavailable" },
  { error: { message: JSON.stringify({ headers: "fixture-auth" }) }, diagnostic: "Codex Cloud turn failed" },
])("failed turns retain only sanitized messages and recognized cause codes: $diagnostic", async ({ error, diagnostic }) => {
  const f = fixture();
  f.respond((frame, socket) => frame.method === "thread/turns/list" ? { data: [{ ...turn, status: "failed", error }] } : f.original(frame, socket));
  expect(await f.client.poll(f.access)).toEqual({ state: "failed", error: diagnostic, model });
});

test("cloud failure messages redact credentials and raw payload fields before bounding the diagnostic", async () => {
  const f = fixture();
  const secrets = ["fixture-auth", "fixture-routing", "header-credential", "cookie-credential", "quoted-credential", "url-credential", "inline-credential"];
  const authorization = ["Author", "ization"].join("");
  const bearer = ["Bear", "er"].join("");
  const apiKey = ["api", "key"].join("_");
  const message = ["Environment setup failed: missing dependency; fixture-auth fixture-routing",
    `${authorization}: ${bearer} ${secrets[2]}`, "Cookie: session=cookie-credential",
    `Configuration ${JSON.stringify({ [apiKey]: secrets[4] + '"escaped-tail' })}`, `Provider refused ${authorization}: ${bearer} ${secrets[6]}`,
    "See https://example.com/setup?key=url-credential", "x".repeat(3000), "fixture-auth"].join("\n");
  f.respond((frame, socket) => frame.method === "thread/turns/list" ? { data: [{ ...turn, status: "failed",
    error: { message, code: "environment_setup_failed", additionalDetails: "raw-payload", cause: { headers: "raw-payload" } } }] } : f.original(frame, socket));
  const result = await f.client.poll(f.access);
  expect(result.state).toBe("failed");
  if (result.state !== "failed") throw new Error("expected failure");
  expect(result.error).toStartWith("Codex Cloud turn failed (environment_setup_failed): Environment setup failed: missing dependency;");
  expect(result.error).toContain("[redacted]");
  expect(result.error).toEndWith("…");
  expect(result.error.length).toBeLessThan(1600);
  expect(result.error).not.toMatch(/[\r\n]/);
  for (const secret of [...secrets, "escaped-tail", "raw-payload"]) expect(result.error).not.toContain(secret);
});

test.each([false, 0, "", [], "fixture-auth", {}, { message: "" }, { message: { headers: "fixture-auth" } }].map(error => ({ error })))("malformed turn errors never confirm failure: $error", async ({ error }) => {
  const f = fixture();
  for (const status of ["inProgress", "completed", "failed", "interrupted", "unknown"]) {
    f.respond((frame, socket) => frame.method === "thread/turns/list" ? { data: [{ ...turn, status, error }] } : f.original(frame, socket));
    await expect(f.client.poll(f.access)).rejects.toThrow("Codex Cloud");
  }
  await expect(f.client.readFinalMessage(f.access)).rejects.toThrow("turn is not completed");
  await expect(f.client.readDiff(f.access)).rejects.toThrow("turn is not completed");
});

test.each(["inProgress", "completed", "unknown"])("%s with a valid error never confirms terminal failure", async status => {
  const f = fixture();
  f.respond((frame, socket) => frame.method === "thread/turns/list" ? { data: [{ ...turn, status, error: { message: "Provider failure" } }] } : f.original(frame, socket));
  await expect(f.client.poll(f.access)).rejects.toThrow("Codex Cloud");
});

test.each(["readFinalMessage", "readDiff"] as const)("%s refuses a failed turn without emitting its credential-bearing payload", async method => {
  const f = fixture();
  f.respond((frame, socket) => frame.method === "thread/turns/list" ? { data: [{ ...turn, status: "failed", error: { message: "fixture-auth", additionalDetails: "raw-payload" } }] } : f.original(frame, socket));
  const error = await f.client[method](f.access).then(() => "unexpected success", error => error.message);
  expect(error).toBe("Codex Cloud turn is not completed");
  expect(error).not.toContain("fixture-auth");
  expect(error).not.toContain("raw-payload");
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

test("an already cancelled operation opens no authentication client or socket", async () => {
  const f = fixture(); f.abort.abort();
  await expect(f.client.submit(f.input)).rejects.toThrow("timed out");
  expect(f.authCalls()).toBe(0);
  expect(f.sockets).toHaveLength(0);
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

test.each(["success", "unicode", "invalid-utf8", "checksum", "chunk"])("chunked diff export verifies %s without launching a turn", async failure => {
  const f = fixture();
  const content = Buffer.from((failure === "unicode" ? "файл diff\n" : "fixture diff\n").repeat(600));
  const patch = failure === "invalid-utf8" ? Buffer.concat([content, Buffer.from([0xff])]) : content;
  const checksum = createHash("sha256").update(patch).digest("hex");
  let commands = 0;
  f.respond((frame, socket) => {
    if (frame.method === "command/exec") {
      if (commands++ === 0) return { exitCode: 0, stdout: JSON.stringify({ bytes: patch.length, sha256: failure === "checksum" ? "b".repeat(64) : checksum }) };
      const offset = (commands - 2) * 3072;
      return { exitCode: 0, stdout: failure === "chunk" ? "bad" : patch.subarray(offset, offset + 3072).toString("base64") };
    }
    return f.original(frame, socket);
  });
  if (["success", "unicode"].includes(failure)) expect(await f.client.readDiff(f.access)).toBe(patch.toString());
  else await expect(f.client.readDiff(f.access)).rejects.toThrow("Codex Cloud diff");
  expect(commands).toBe(failure === "chunk" ? 2 : 4);
  expect(f.frames.some(frame => frame.method === "turn/start" || frame.method === "thread/resume")).toBe(false);
});

test("unsupported models and source-version configuration IDs are refused", async () => {
  const f = fixture();
  expect(f.client.supportsModel("other-model", "xhigh")).toBe(false);
  expect(f.client.supportsModel(model, "unsupported")).toBe(false);
  await expect(f.client.submit({ ...f.input, environmentId: "cecfg_fixture" })).rejects.toThrow("ASB configuration");
  expect(f.frames.some(frame => frame.method === "thread/start")).toBe(false);
});

test("qualified ASB configuration IDs retain their exact identity", async () => {
  const qualified = "region~asenvcfg_fixture-config";
  const f = fixture({ fetch: async () => Response.json({ id: qualified, repositories: [{ mount_path: environment.cwd }] }) });
  f.respond((frame, socket) => frame.method === "thread/start"
    ? { model, thread: { ...thread, environments: [{ ...environment, environmentConfigId: qualified }] } }
    : f.original(frame, socket));
  await f.client.submit({ ...f.input, environmentId: qualified });
  expect(f.frames.find(frame => frame.method === "thread/start")!.params!.environments).toEqual([{ environmentConfigId: qualified, cwd: environment.cwd }]);
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

test.each(["success", "http", "invalid-name", "revoked"])("empty environment mounts resolve through the shared repository catalog: %s", async outcome => {
  const calls: string[] = [];
  const f: ReturnType<typeof fixture> = fixture({ fetch: async url => {
    calls.push(url);
    if (url.includes("/environment-configs/")) return Response.json({ id: environmentId,
      repositories: [{ repository_id: "repository-fixture", mount_path: "" }] });
    if (outcome === "http") return new Response("fixture-auth", { status: 403 });
    if (outcome === "revoked") f.supersede();
    return Response.json({ repository_full_name: outcome === "invalid-name" ? "fixture/../other" : "fixture/project" });
  } });
  if (outcome === "success") {
    await f.client.submit(f.input);
    expect(f.frames.find(frame => frame.method === "thread/start")!.params!.environments).toEqual([{ environmentConfigId: environmentId, cwd: environment.cwd }]);
  } else {
    await expect(f.client.submit(f.input)).rejects.toThrow("Codex Cloud");
    expect(f.frames.some(frame => frame.method === "thread/start")).toBe(false);
  }
  expect(calls).toHaveLength(2);
  expect(calls[1]).toBe("https://chatgpt.com/backend-api/wham/github/repositories/repository-fixture");
});

test("a known accepted receipt is returned after authority changes without another effect", async () => {
  const f = fixture();
  f.respond((frame, socket) => { if (frame.method === "turn/start") f.supersede(); return f.original(frame, socket); });
  const receipt = await f.client.submit(f.input);
  expect(receipt.thread?.turnId).toBe(turn.id);
  expect(f.frames.at(-1)!.method).toBe("turn/start");
});

test.each(["authentication", "configuration"])("authority is checked after asynchronous %s preparation", async seam => {
  const f: ReturnType<typeof fixture> = fixture(seam === "authentication" ? {
    authenticate: async () => { f.supersede(); return { token: "fixture-auth" }; },
  } : {
    fetch: async () => { f.supersede(); return Response.json({ id: environmentId, repositories: [{ mount_path: environment.cwd }] }); },
  });
  await expect(f.client.submit(f.input)).rejects.toThrow("Codex Cloud");
  expect(f.frames.some(frame => frame.method === "thread/start")).toBe(false);
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
