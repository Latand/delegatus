import { expect, test } from "bun:test";
import { runCloudChecks, type CloudJob, type CloudResult } from "./cloud-checks";

const job: CloudJob = { head: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), bundle: "bundle", timeoutMs: 1000 };
const verdict = (code: number): CloudResult => ({ kind: "verdict", head: job.head, tree: job.tree, base: job.base, code });
test("a Cloud refusal is decisive and never retried locally", async () => {
  let local = 0, calls = 0;
  expect(await runCloudChecks(job, { run: async () => { calls++; return verdict(1); } }, async () => { local++; return 0; })).toBe(1);
  expect([calls, local]).toEqual([1, 0]);
});
test("confirmed Cloud unavailability falls back exactly once", async () => {
  let local = 0, calls = 0;
  expect(await runCloudChecks(job, { run: async () => { calls++; return { kind: "unavailable" }; } }, async () => { local++; return 0; })).toBe(0);
  expect([calls, local]).toEqual([2, 1]);
});
test("account limits never trigger local fallback", async () => {
  let local = 0;
  expect(await runCloudChecks(job, { run: async () => ({ kind: "account-limit" }) }, async () => { local++; return 0; })).toBe(75);
  expect(local).toBe(0);
});
test("a receipt for another tree cannot authorize publication", async () => {
  expect(await runCloudChecks(job, { run: async () => ({ ...verdict(0), tree: "d".repeat(40) }) }, async () => 0)).toBe(1);
});
test("Cloud time limits are confirmed before fallback", async () => {
  let calls = 0, local = 0;
  expect(await runCloudChecks(job, { run: async () => { calls++; return { kind: "cloud-limit" }; } }, async () => { local++; return 0; })).toBe(0);
  expect([calls, local]).toEqual([2, 1]);
});

import { AppServerCloudTransport, CloudRpcError, cloudCommand, connectCloud, rpcFailure, type CloudRpc } from "./cloud-checks";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
const config = { url: "wss://example.invalid", environmentId: "environment-fixture", cwd: "/workspace/repository" };
function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}
function fakeRpc(output: string, code = 0) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let uploadCommand = "", command = "";
  const rpc: CloudRpc = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { model: "gpt-6.1-sol", thread: { id: "thread-fixture", environments: [{ environmentConfigId: config.environmentId, cwd: config.cwd }] } };
      if (method === "thread/shellCommand") { uploadCommand = String(params.command); return {}; }
      if (method === "turn/start") {
        const text = (params.input as { text: string }[])[0]!.text;
        command = text.slice(text.indexOf("\n") + 1);
        return { turn: { id: "turn-fixture" } };
      }
      if (method === "thread/turns/list") return { data: [{ id: "other", status: "failed" }, { id: "turn-fixture", status: "completed" }] };
      if (method === "thread/items/list") return { data: [{ turnId: params.turnId ? "turn-fixture" : "upload-turn", item: { type: "commandExecution", status: !params.turnId || code === 0 ? "completed" : "failed", command: params.turnId ? command : uploadCommand, exitCode: params.turnId ? code : 0, aggregatedOutput: params.turnId ? output : "" } }] };
      return {};
    }, close() {},
  };
  return { rpc, calls };
}
test("hosted launch uses the required Cloud profile and exact tree command", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} 0\n`);
  const transport = new AppServerCloudTransport(config, async () => fake.rpc);
  expect(await transport.run(job)).toEqual(verdict(0));
  expect(fake.calls.find(call => call.method === "initialize")?.params).toMatchObject({ capabilities: { experimentalApi: true } });
  expect(fake.calls.find(call => call.method === "thread/start")?.params).toMatchObject({
    model: "gpt-6.1-sol", approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: false, allowProviderModelFallback: false,
    environments: [{ environmentConfigId: config.environmentId, cwd: config.cwd }],
  });
  expect(fake.calls.find(call => call.method === "turn/start")?.params).toMatchObject({ threadId: "thread-fixture", sandboxPolicy: { type: "dangerFullAccess" } });
  expect(cloudCommand(job)).toContain("scripts/local-gate.ts pre-push --admitted");
  expect(cloudCommand(job)).toContain("LLV_GATE_RUNNER=off");
});
test("model prose cannot supply a Cloud verdict", async () => {
  const fake = fakeRpc("All checks passed");
  expect(await new AppServerCloudTransport(config, async () => fake.rpc).run(job)).toEqual({ kind: "invalid" });
});
test("command exit and receipt must agree", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} 0\n`, 1);
  expect(await new AppServerCloudTransport(config, async () => fake.rpc).run(job)).toEqual({ kind: "invalid" });
});
test("a completed failing command retains its exit code", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} 1\n`, 1);
  expect(await new AppServerCloudTransport(config, async () => fake.rpc).run(job)).toEqual(verdict(1));
});
test("cancellation does not start local checks", async () => {
  let local = 0;
  expect(await runCloudChecks(job, { run: async () => verdict(0) }, async () => { local++; return 0; }, AbortSignal.abort())).toBe(75);
  expect(local).toBe(0);
});

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
test("the bundled command checks out and gates the exact candidate without network", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cloud-bundle-"));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "noreply@example.invalid", GIT_AUTHOR_DATE: "2026-10-24T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-24T00:00:00Z" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q"); writeFileSync(path.join(root, "source"), "base"); git("add", "."); git("commit", "-qm", "Base");
    const base = git("rev-parse", "HEAD");
    const source = path.join(root, "base-checkout");
    execFileSync("git", ["clone", "-q", root, source]);
    writeFileSync(path.join(root, "source"), "candidate"); git("commit", "-qam", "Candidate");
    const head = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
    const bundle = path.join(root, "source.bundle"); git("bundle", "create", bundle, "HEAD", `^${base}`);
    const bin = path.join(root, "bin"); mkdirSync(bin);
    writeFileSync(path.join(bin, "bun"), '#!/bin/sh\nif [ "$1" = install ]; then exit 0; fi\ntest "$1 $2 $3" = "scripts/local-gate.ts pre-push --admitted" || exit 99\ntest "$(cat source)" = candidate || exit 98\ntest "$LLV_SKIP_HOOKS" = 0 || exit 97\ntest "$LLV_GATE_PUSH_HEAD" = "$(git rev-parse HEAD)" || exit 96\nif [ "$BUNDLE_MUTATION" = tracked ]; then echo repaired > source; fi\nif [ "$BUNDLE_MUTATION" = untracked ]; then echo repaired > extra.ts; fi\nexit 0\n', { mode: 0o755 });
    for (const mutation of ["none", "tracked", "untracked"]) {
      const upload = path.join(root, "upload"); mkdirSync(upload);
      writeFileSync(path.join(upload, "bundle"), readFileSync(bundle).toString("base64"));
      const result = spawnSync("bash", ["-c", cloudCommand({ head, tree, base, bundle: "", timeoutMs: 1000 }, { directory: upload, source })], { env: { ...env, PATH: `${bin}:${env.PATH}`, BUNDLE_MUTATION: mutation, LLV_SKIP_HOOKS: "1", LLV_GATE_PUSH_HEAD: "wrong-head" }, encoding: "utf8" });
      if (mutation === "none") {
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`DELEGATUS_GATE ${head} ${tree} ${base} 0`);
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain("DELEGATUS_GATE");
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a different recorded command cannot forge a receipt", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} 0\n`);
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => method === "thread/items/list" && params.turnId
    ? { data: [{ turnId: "turn-fixture", item: { type: "commandExecution", status: "completed", command: "echo passed", exitCode: 0, aggregatedOutput: `DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} 0\n` } }] }
    : original(method, params);
  expect(await new AppServerCloudTransport(config, async () => fake.rpc).run(job)).toEqual({ kind: "invalid" });
});
test("a time-limited job must acknowledge termination before fallback", async () => {
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  let interrupted = false;
  fake.rpc.call = async (method, params) => {
    if (method === "turn/interrupt") { interrupted = true; return {}; }
    if (method === "thread/turns/list" && !interrupted) return { data: [{ id: "turn-fixture", status: "inProgress" }] };
    return original(method, params);
  };
  expect(await new AppServerCloudTransport(config, async () => fake.rpc, () => {}, clock()).run(job)).toEqual({ kind: "cloud-limit" });
  expect(interrupted).toBe(true);
});
test("transport loss during interruption follows the confirmed outage path", async () => {
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    if (method === "turn/interrupt") throw new CloudRpcError("lost acknowledgement", "unavailable");
    if (method === "thread/turns/list") return { data: [{ id: "turn-fixture", status: "inProgress" }] };
    return original(method, params);
  };
  expect(await new AppServerCloudTransport(config, async () => fake.rpc, () => {}, clock()).run(job)).toEqual({ kind: "unavailable" });
});
test("command evidence is read through every page and bound to its turn", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} 0\n`);
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    if (method === "thread/items/list" && params.turnId && !params.cursor) return { data: [], nextCursor: "next-page" };
    return original(method, params);
  };
  expect(await new AppServerCloudTransport(config, async () => fake.rpc, () => {}).run(job)).toEqual(verdict(0));
  expect(fake.calls.find(call => call.method === "thread/items/list" && call.params.turnId)?.params.cursor).toBe("next-page");
});

test("source bytes upload in bounded chunks and never enter the model prompt", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} 0\n`);
  const source = "YQ==".repeat(20_000);
  expect(await new AppServerCloudTransport(config, async () => fake.rpc, () => {}).run({ ...job, bundle: source })).toEqual(verdict(0));
  const uploads = fake.calls.filter(call => call.method === "thread/shellCommand");
  expect(uploads).toHaveLength(3);
  const reverted = fake.calls.findIndex(call => call.method === "thread/revert");
  expect(reverted).toBeGreaterThan(fake.calls.findIndex(call => call.method === "thread/shellCommand"));
  expect(reverted).toBeLessThan(fake.calls.findIndex(call => call.method === "turn/start"));
  expect(uploads.every(call => String(call.params.command).length < 34_000)).toBe(true);
  const input = fake.calls.find(call => call.method === "turn/start")!.params.input as { text: string }[];
  expect(input[0]!.text).not.toContain(source.slice(0, 100));
  expect(input[0]!.text.length).toBeLessThan(5000);
});

import { createHookFixture } from "./local-gate.fixture";
test("the Cloud hook refuses a dirty source before dispatch or local fallback", () => {
  const roots: string[] = [];
  const fixture = createHookFixture(process.cwd(), roots);
  try {
    writeFileSync(path.join(fixture.dir, "example.ts"), "export const value = 2;\n");
    const result = spawnSync("bash", [".githooks/pre-push"], { cwd: fixture.dir, env: { ...fixture.env, LLV_GATE_EXECUTION: "cloud" }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cloud publication checks require a clean checkout");
    expect(result.stderr).not.toContain("running the same checks locally");
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});


test("a completed command is decisive while the model turn is still running", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} 0\n`);
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    if (method === "thread/turns/list") throw new Error("The completed command already decided the gate");
    return original(method, params);
  };
  expect(await new AppServerCloudTransport(config, async () => fake.rpc, () => {}).run(job)).toEqual(verdict(0));
});

test("a successful Cloud retry decides without local work", async () => {
  let calls = 0, local = 0;
  expect(await runCloudChecks(job, { run: async () => ++calls === 1 ? { kind: "unavailable" } : verdict(0) }, async () => { local++; return 1; })).toBe(0);
  expect([calls, local]).toEqual([2, 0]);
});

test("a failed local fallback keeps its refusal", async () => {
  let local = 0;
  expect(await runCloudChecks(job, { run: async () => ({ kind: "unavailable" }) }, async () => { local++; return 19; })).toBe(19);
  expect(local).toBe(1);
});

test("account handshake refusals never permit local fallback", async () => {
  let local = 0;
  const transport = new AppServerCloudTransport(config, async () => { throw new CloudRpcError("refused", "account-limit"); });
  expect(await runCloudChecks(job, transport, async () => { local++; return 0; })).toBe(75);
  expect(local).toBe(0);
});

test("structured account limits stay distinct from Cloud capacity", () => {
  expect(rpcFailure({ data: { codexErrorInfo: { usageLimitExceeded: {} } }, message: "private response" }).category).toBe("account-limit");
  expect(rpcFailure({ data: { codexErrorInfo: { serverOverloaded: {} } } }).category).toBe("cloud-limit");
  expect(rpcFailure({ data: { codexErrorInfo: { unrecognized: {} } } }).category).toBe("invalid");
});

for (const mismatch of ["model", "environment", "cwd"]) test(`a resolved ${mismatch} mismatch refuses before source upload`, async () => {
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    if (method === "thread/start") return {
      model: mismatch === "model" ? "other-model" : "gpt-6.1-sol",
      thread: { id: "thread-fixture", environments: [{ environmentConfigId: mismatch === "environment" ? "other" : config.environmentId,
        cwd: mismatch === "cwd" ? "/workspace/other" : config.cwd }] },
    };
    return original(method, params);
  };
  expect(await new AppServerCloudTransport(config, async () => fake.rpc).run(job)).toEqual({ kind: "invalid" });
  expect(fake.calls.some(call => call.method === "thread/shellCommand")).toBe(false);
});

test("a privacy refusal prevents Cloud dispatch and local fallback", () => {
  const roots: string[] = [];
  const fixture = createHookFixture(process.cwd(), roots);
  try {
    writeFileSync(path.join(fixture.dir, "example.ts"), "export const value = 2;\n");
    const result = spawnSync("bash", [".githooks/pre-push"], { cwd: fixture.dir,
      env: { ...fixture.env, LLV_GATE_EXECUTION: "cloud", HOOK_FAIL: "scripts/privacy-publication-gate.ts" }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(fixture.calls().map(call => call.args[0])).toEqual(["scripts/privacy-publication-gate.ts"]);
    expect(result.stderr).not.toContain("pre-push: Cloud checks");
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});

for (const malformed of ["missing-data", "repeated-cursor", "page-limit"]) test(`invalid ${malformed} evidence cannot enable fallback`, async () => {
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  let pages = 0, local = 0;
  fake.rpc.call = async (method, params) => {
    if (method === "thread/items/list" && params.turnId) {
      pages++;
      return malformed === "missing-data" ? {} : { data: [], nextCursor: { page: malformed === "repeated-cursor" ? 1 : pages } };
    }
    return original(method, params);
  };
  expect(await runCloudChecks(job, new AppServerCloudTransport(config, async () => fake.rpc), async () => { local++; return 0; })).toBe(1);
  expect(local).toBe(0);
  expect(pages).toBeLessThanOrEqual(100);
});

for (const [status, category] of [[401, "account-limit"], [403, "account-limit"], [429, "account-limit"], [503, "unavailable"]] as const) {
  test(`real WebSocket handshake ${status} is classified as ${category}`, async () => {
    const server = createServer((_request, response) => { response.writeHead(status); response.end(); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const error = await connectCloud({ ...config, url: `ws://127.0.0.1:${address.port}` }).then(() => null, error => error);
      expect(error).toBeInstanceOf(CloudRpcError);
      expect(error.category).toBe(category);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
}

test("missing turn records are invalid evidence", async () => {
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => method === "thread/turns/list" ? {} : original(method, params);
  let local = 0;
  expect(await runCloudChecks(job, new AppServerCloudTransport(config, async () => fake.rpc, () => {}, clock()), async () => { local++; return 0; })).toBe(1);
  expect(local).toBe(0);
});

test("an account refusal during outage recovery blocks fallback", async () => {
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    if (method === "turn/start") throw new CloudRpcError("lost acknowledgement", "unavailable");
    return original(method, params);
  };
  let connections = 0, local = 0;
  const transport = new AppServerCloudTransport(config, async () => {
    if (++connections === 1) return fake.rpc;
    throw new CloudRpcError("account refused", "account-limit");
  });
  expect(await runCloudChecks(job, transport, async () => { local++; return 0; })).toBe(75);
  expect([connections, local]).toEqual([2, 0]);
});

test("the real transport negotiates the configured app-server subprotocol", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server, handleProtocols: protocols => protocols.has("codex-app-server") ? "codex-app-server" : false });
  sockets.on("connection", socket => socket.on("message", bytes => {
    const request = JSON.parse(String(bytes));
    socket.send(JSON.stringify({ id: request.id, result: { protocol: socket.protocol } }));
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let rpc: CloudRpc | undefined;
  try {
    const address = server.address() as { port: number };
    rpc = await connectCloud({ ...config, url: `ws://127.0.0.1:${address.port}`, protocols: ["codex-app-server"] });
    expect(await rpc.call("probe", {})).toEqual({ protocol: "codex-app-server" });
  } finally {
    rpc?.close();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("invalid WebSocket configuration cannot enable local fallback", async () => {
  let local = 0;
  const transport = new AppServerCloudTransport({ ...config, protocols: ["invalid protocol"] });
  expect(await runCloudChecks(job, transport, async () => { local++; return 0; })).toBe(1);
  expect(local).toBe(0);
});
