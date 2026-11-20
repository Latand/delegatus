import { expect, test } from "bun:test";
import { runCloudChecks, type CloudJob, type CloudResult } from "./cloud-checks";

const job: CloudJob = { head: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), inputs: {}, bundle: "bundle", timeoutMs: 1000 };
const verdict = (code: number): CloudResult => ({ kind: "verdict", head: job.head, tree: job.tree, base: job.base, inputs: cloudInputDigest(job.inputs), code });
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
test("a receipt for different check inputs cannot authorize publication", async () => {
  let local = 0;
  expect(await runCloudChecks({ ...job, inputs: { CHECK_PROBE_FAIL: "1" } }, { run: async () => verdict(0) }, async () => { local++; return 0; })).toBe(1);
  expect(local).toBe(0);
});
test("a receipt missing its input binding cannot authorize publication", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} 0\n`);
  let local = 0;
  expect(await runCloudChecks(job, new AppServerCloudTransport(config, async () => fake.rpc), async () => { local++; return 0; })).toBe(1);
  expect(local).toBe(0);
});
test("Cloud time limits are confirmed before fallback", async () => {
  let calls = 0, local = 0;
  expect(await runCloudChecks(job, { run: async () => { calls++; return { kind: "cloud-limit" }; } }, async () => { local++; return 0; })).toBe(0);
  expect([calls, local]).toEqual([2, 1]);
});

import { AppServerCloudTransport, CloudRpcError, cloudCheckInputs, cloudInputDigest, cloudCommand, connectCloud, rpcFailure, type CloudRpc } from "./cloud-checks";
import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import type { HostedCloudDependencies } from "../src/lib/pipelines/cloudHostedClient";
const account = { engine: "codex" as const, accountId: "fixture", kind: "managed" as const, home: "/fixture/account", transcriptRoot: "/fixture/transcripts", env: { NODE_ENV: "test" as const } };
const config = { account, environmentId: "asenvcfg_fixture" };
const cwd = "/workspace/repository";
function dependencies(url: string, protocols = ["codex-app-server"]): HostedCloudDependencies {
  return { authenticate: async selected => { expect(selected).toEqual(account); return { token: "fixture-auth" }; },
    socket: () => new WebSocket(url, protocols, { handshakeTimeout: 1000 }),
    fetch: async () => Response.json({ id: config.environmentId, repositories: [{ mount_path: cwd }] }), uuid: () => "fixture" };
}
function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}
function fakeRpc(output: string, code = 0) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let uploadCommand = "", command = "";
  const rpc: CloudRpc = {
    cwd,
    async call(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { model: "gpt-6.2-sol", thread: { id: "thread-fixture", environments: [{ environmentId: "ccarenv_fixture", environmentConfigId: config.environmentId, cwd: cwd }] } };
      if (method === "command/exec") { uploadCommand = String((params.command as string[])[2]); return { exitCode: 0, stdout: "", stderr: "" }; }
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
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} 0\n`);
  const transport = new AppServerCloudTransport(config, async () => fake.rpc);
  expect(await transport.run(job)).toEqual(verdict(0));
  expect(fake.calls.find(call => call.method === "thread/start")?.params).toMatchObject({
    model: "gpt-6.2-sol", approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: false, allowProviderModelFallback: false,
    environments: [{ environmentConfigId: config.environmentId, cwd: cwd }],
  });
  expect(fake.calls.find(call => call.method === "turn/start")?.params).toMatchObject({ threadId: "thread-fixture", sandboxPolicy: { type: "dangerFullAccess" } });
  expect(cloudCommand(job)).toContain("scripts/local-gate.ts pre-push --admitted");
  expect(cloudCommand(job)).toContain("LLV_GATE_RUNNER=off");
});
test("model prose cannot supply a Cloud verdict", async () => {
  const fake = fakeRpc("All checks passed");
  expect(await new AppServerCloudTransport(config, async () => fake.rpc).run(job)).toMatchObject({ kind: "invalid" });
});
test("command exit and receipt must agree", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} 0\n`, 1);
  expect(await new AppServerCloudTransport(config, async () => fake.rpc).run(job)).toMatchObject({ kind: "invalid" });
});
for (const code of [undefined, 1, 75]) test(`upload without a successful command exit is decisive: ${code}`, async () => {
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  let connects = 0, local = 0;
  fake.rpc.call = async (method, params) => method === "command/exec" ? { exitCode: code } : original(method, params);
  expect(await runCloudChecks(job, new AppServerCloudTransport(config, async () => { connects++; return fake.rpc; }), async () => { local++; return 0; })).toBe(1);
  expect([connects, local]).toEqual([1, 0]);
  expect(fake.calls.some(call => call.method === "turn/start")).toBe(false);
});

for (const catalog of ["environment", "repository"]) for (const phase of ["connection", "body"]) test(`${catalog} catalogue ${phase} reset retries twice and preserves the local verdict`, async () => {
  let resets = 0, local = 0;
  const server = createServer((_request, response) => {
    resets++;
    if (phase === "connection") response.destroy();
    else {
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "9999" });
      response.write('{"id":');
      response.flushHeaders();
      setImmediate(() => response.destroy());
    }
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", socket => socket.on("message", bytes => {
    const request = JSON.parse(String(bytes));
    if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, result: {} }));
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    const deps = dependencies(url.replace("http:", "ws:"));
    deps.fetch = async (requested, options) => catalog === "repository" && requested.includes("environment-configs")
      ? Response.json({ id: config.environmentId, repositories: [{ repository_id: "fixture" }] })
      : fetch(url, options);
    const transport = new AppServerCloudTransport(config, (config, signal, timeout) => connectCloud(config, signal, timeout, deps));
    expect(await runCloudChecks({ ...job, timeoutMs: 10_000 }, transport, async () => { local++; return 19; })).toBe(19);
    expect([resets, local]).toEqual([2, 1]);
  } finally {
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

for (const catalog of ["environment", "repository"]) for (const refusal of [401, 403, 429, 400, 404, "malformed", "tls", "unknown"] as const) test(`${catalog} catalogue ${refusal} never authorizes local fallback`, async () => {
  let connects = 0, reads = 0, local = 0;
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", socket => socket.on("message", bytes => {
    const request = JSON.parse(String(bytes));
    if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, result: {} }));
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    const deps = dependencies(`ws://127.0.0.1:${address.port}`);
    deps.fetch = async requested => {
      reads++;
      if (catalog === "repository" && requested.includes("environment-configs")) return Response.json({ id: config.environmentId, repositories: [{ repository_id: "fixture" }] });
      if (typeof refusal === "number") return new Response("refused", { status: refusal });
      if (refusal === "malformed") return new Response("{");
      throw Object.assign(new Error("private diagnostic"), { code: refusal === "tls" ? "CERT_HAS_EXPIRED" : "UNKNOWN" });
    };
    const transport = new AppServerCloudTransport(config, (config, signal, timeout) => { connects++; return connectCloud(config, signal, timeout, deps); });
    expect(await runCloudChecks(job, transport, async () => { local++; return 0; })).toBe(typeof refusal === "number" && [401, 403, 429].includes(refusal) ? 75 : 1);
    expect([connects, reads, local]).toEqual([1, catalog === "repository" ? 2 : 1, 0]);
  } finally {
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("a verified provider execution limit permits one local run after confirmation", async () => {
  let attempts = 0, local = 0;
  const fake = fakeRpc("");
  fake.rpc.call = async method => {
    expect(method).toBe("thread/start");
    attempts++;
    throw rpcFailure({ data: { codexErrorInfo: "environmentTimeLimitExceeded" } }, { method });
  };
  const transport = new AppServerCloudTransport(config, async () => fake.rpc, () => {});
  expect(await runCloudChecks(job, transport, async () => { local++; return 19; }, undefined, () => {})).toBe(19);
  expect([attempts, local]).toEqual([2, 1]);
});

test("verified transfer outages retry twice before one local run", async () => {
  let connects = 0, local = 0;
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    if (method === "command/exec") throw new CloudRpcError("transfer lost", "unavailable");
    return original(method, params);
  };
  const transport = new AppServerCloudTransport(config, async () => { connects++; return fake.rpc; });
  expect(await runCloudChecks(job, transport, async () => { local++; return 23; })).toBe(23);
  expect([connects, local]).toEqual([2, 1]);
});
test("a completed failing command retains its exit code", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} 1\n`, 1);
  expect(await new AppServerCloudTransport(config, async () => fake.rpc).run(job)).toMatchObject(verdict(1));
});
test("cancellation does not start local checks", async () => {
  let local = 0;
  expect(await runCloudChecks(job, { run: async () => verdict(0) }, async () => { local++; return 0; }, AbortSignal.abort())).toBe(75);
  expect(local).toBe(0);
});

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkEnvironment } from "./gate-cache";
import { isolatedEnvironment } from "./local-gate";
for (const value of ["1", "0", null]) test(`declared check input has the same local and Cloud verdict: ${value}`, () => {
  const root = mkdtempSync(path.join(tmpdir(), "cloud-input-"));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "noreply@example.invalid" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git("init", "-q");
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(path.join(root, "probe-input"), "input bytes\n");
    writeFileSync(path.join(root, "scripts/local-gate.ts"), `import { readFileSync } from "node:fs";\nif (readFileSync(process.env.PROBE_FILE!, "utf8") !== "input bytes\\n" || process.env.PROBE_LITERAL !== ${JSON.stringify("quotes ' \" $() ` é\nnext")}) process.exit(29);\nprocess.exit(process.env.CHECK_PROBE_FAIL === "1" ? 17 : 0);\n`);
    git("add", "."); git("commit", "-qm", "Fixture");
    const head = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
    const bundle = path.join(root, "source.bundle"); git("bundle", "create", bundle, "HEAD");
    const bin = path.join(root, "bin"); mkdirSync(bin);
    writeFileSync(path.join(bin, "bun"), `#!/bin/sh\nif [ "$1" = scripts/cloud-check-dependencies.ts ]; then exit 0; fi\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    const inputs = { LLV_GATE_CHECK_ENV: "CHECK_PROBE_FAIL,PROBE_FILE,PROBE_LITERAL", PROBE_FILE: path.join(root, "probe-input"), PROBE_LITERAL: "quotes ' \" $() ` é\nnext", CHECK_PROBE_FAIL: value ?? undefined };
    const inherited: NodeJS.ProcessEnv = { ...env, ...inputs };
    delete inherited.CHECK_PROBE_FAIL;
    if (value !== null) inherited.CHECK_PROBE_FAIL = value;
    const local = spawnSync(process.execPath, ["scripts/local-gate.ts"], { cwd: root, env: isolatedEnvironment(path.join(root, "local"), checkEnvironment(inherited)) });
    const candidate = { ...job, head, tree, base: head, bundle: readFileSync(bundle).toString("base64"),
      inputs: cloudCheckInputs(root, inputs) };
    const result = spawnSync("bash", ["-c", cloudCommand(candidate)], {
      env: { ...env, PATH: `${bin}:${env.PATH}`, CHECK_PROBE_FAIL: value === "1" ? "0" : "1" }, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(local.status);
    expect(result.stdout).toContain(`DELEGATUS_GATE ${head} ${tree} ${head}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cloud maps tracked file inputs and refuses unavailable host paths and executor overrides", () => {
  const roots: string[] = [];
  const fixture = createHookFixture(process.cwd(), roots);
  try {
    const input = path.join(fixture.dir, "example.ts");
    const untracked = path.join(fixture.dir, "untracked-input");
    writeFileSync(untracked, "untracked");
    expect(cloudCheckInputs(fixture.dir, { LLV_GATE_CHECK_ENV: "PROBE_FILE,ABSENT", PROBE_FILE: input, LLV_TOKEN: "private", LANG: "uk_UA.UTF-8" })).toEqual({
      ABSENT: null, LANG: "uk_UA.UTF-8", LLV_GATE_CHECK_ENV: "PROBE_FILE,ABSENT", PROBE_FILE: { file: "example.ts" },
    });
    for (const name of ["HOME", "PATH", "LLV_STATE_DIR", "LLV_GATE_EXECUTION", "GIT_DIR", "GIT_CONFIG_COUNT", "LLV_SKIP_HOOKS", "XDG_CONFIG_HOME", "BAD-NAME"]) {
      expect(() => cloudCheckInputs(fixture.dir, { LLV_GATE_CHECK_ENV: name, [name]: "1" })).toThrow("input name");
    }
    for (const file of [process.execPath, fixture.dir, untracked]) {
      expect(() => cloudCheckInputs(fixture.dir, { LLV_GATE_CHECK_ENV: "PROBE_FILE", PROBE_FILE: file })).toThrow();
    }
    expect(() => cloudCheckInputs(fixture.dir, { NODE_OPTIONS: "--require /outside/input.cjs" })).toThrow("input path");
    expect(() => cloudCommand({ ...job, inputs: { LLV_GATE_CHECK_ENV: "MISSING" } })).toThrow("Missing declared");
    expect(cloudCheckInputs(fixture.dir, { LLV_GATE_CHECK_ENV: "constructor,__proto__,toString" })).toEqual({
      LLV_GATE_CHECK_ENV: "constructor,__proto__,toString", constructor: null, ["__proto__"]: null, toString: null,
    });
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});
for (const stale of [false, true]) test(`the bundled command gates the exact candidate with a stale source: ${stale}`, () => {
  const root = mkdtempSync(path.join(tmpdir(), "cloud-bundle-"));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "noreply@example.invalid", GIT_AUTHOR_DATE: "2026-10-24T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-24T00:00:00Z" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q"); writeFileSync(path.join(root, "source"), "base"); git("add", "."); git("commit", "-qm", "Base");
    const source = path.join(root, "base-checkout");
    execFileSync("git", ["clone", "-q", root, source]);
    if (stale) { writeFileSync(path.join(root, "source"), "new base"); git("commit", "-qam", "Updated base"); }
    const base = git("rev-parse", "HEAD");
    writeFileSync(path.join(root, "source"), "candidate"); git("commit", "-qam", "Candidate");
    const head = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
    const bundle = path.join(root, "source.bundle"); git("bundle", "create", bundle, "HEAD", `^${base}`);
    const bin = path.join(root, "bin"); mkdirSync(bin);
    writeFileSync(path.join(bin, "bun"), '#!/bin/sh\nif [ "$1" = scripts/cloud-check-dependencies.ts ]; then exit 0; fi\ntest "$1 $2 $3" = "scripts/local-gate.ts pre-push --admitted" || exit 99\ntest "$(cat source)" = candidate || exit 98\ntest "$LLV_SKIP_HOOKS" = 0 || exit 97\ntest "$LLV_GATE_PUSH_HEAD" = "$(git rev-parse HEAD)" || exit 96\nif [ "$BUNDLE_MUTATION" = tracked ]; then echo repaired > source; fi\nif [ "$BUNDLE_MUTATION" = untracked ]; then echo repaired > extra.ts; fi\nexit 0\n', { mode: 0o755 });
    for (const mutation of ["none", "tracked", "untracked"]) {
      const upload = path.join(root, "upload"); mkdirSync(upload);
      writeFileSync(path.join(upload, "bundle"), readFileSync(bundle).toString("base64"));
      const candidate = { head, tree, base, inputs: { BUNDLE_MUTATION: mutation, LLV_GATE_CHECK_ENV: "BUNDLE_MUTATION" }, bundle: "", timeoutMs: 1000 };
      const result = spawnSync("bash", ["-c", cloudCommand(candidate, { directory: upload, source })], { env: { ...env, PATH: `${bin}:${env.PATH}`, BUNDLE_MUTATION: mutation, LLV_SKIP_HOOKS: "1", LLV_GATE_PUSH_HEAD: "wrong-head" }, encoding: "utf8" });
      if (mutation === "none") {
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`DELEGATUS_GATE ${head} ${tree} ${base} ${cloudInputDigest(candidate.inputs)} 0`);
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stdout).not.toContain("DELEGATUS_GATE");
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a different recorded command cannot forge a receipt", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} 0\n`);
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => method === "thread/items/list" && params.turnId
    ? { data: [{ turnId: "turn-fixture", item: { type: "commandExecution", status: "completed", command: "echo passed", exitCode: 0, aggregatedOutput: `DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} 0\n` } }] }
    : original(method, params);
  expect(await new AppServerCloudTransport(config, async () => fake.rpc).run(job)).toMatchObject({ kind: "invalid" });
});
test("a time-limited job without terminal command evidence refuses fallback", async () => {
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  let interrupted = false;
  fake.rpc.call = async (method, params) => {
    if (method === "turn/interrupt") { interrupted = true; return {}; }
    if (method === "thread/turns/list" && !interrupted) return { data: [{ id: "turn-fixture", status: "inProgress" }] };
    const result = await original(method, params);
    if (method === "thread/items/list" && params.turnId) (result.data as { item: { status: string } }[])[0]!.item.status = "inProgress";
    return result;
  };
  expect(await new AppServerCloudTransport(config, async () => fake.rpc, () => {}, clock()).run(job)).toMatchObject({
    kind: "invalid", diagnostic: { category: "timeout", reason: expect.stringContaining("termination not confirmed") },
  });
  expect(interrupted).toBe(true);
});
test("transport loss during the deadline interruption stays a timeout without a second attempt", async () => {
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  let connects = 0, runs = 0, local = 0;
  fake.rpc.call = async (method, params) => {
    if (method === "turn/interrupt") throw new CloudRpcError("lost acknowledgement", "unavailable");
    if (method === "thread/turns/list") return { data: [{ id: "turn-fixture", status: "inProgress" }] };
    const result = await original(method, params);
    if (method === "thread/items/list" && params.turnId) (result.data as { item: { status: string } }[])[0]!.item.status = "inProgress";
    return result;
  };
  const transport = new AppServerCloudTransport(config, async () => { connects++; return fake.rpc; }, () => {}, clock());
  let result: Awaited<ReturnType<typeof transport.run>> | undefined;
  expect(await runCloudChecks(job, { run: async (job, signal) => { runs++; return result = await transport.run(job, signal); } }, async () => { local++; return 0; }, undefined, () => {})).toBe(1);
  expect(result).toMatchObject({ kind: "invalid", diagnostic: { category: "timeout" } });
  expect(result!.diagnostic!.reason).toContain("cleanup unresolved");
  // The lost acknowledgement never dispatched, so cleanup asks once on its own connection.
  expect([runs, connects, local]).toEqual([1, 2, 0]);
  expect(fake.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
});
test("command evidence is read through every page and bound to its turn", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} 0\n`);
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    if (method === "thread/items/list" && params.turnId && !params.cursor) return { data: [], nextCursor: "next-page" };
    return original(method, params);
  };
  expect(await new AppServerCloudTransport(config, async () => fake.rpc, () => {}).run(job)).toEqual(verdict(0));
  expect(fake.calls.find(call => call.method === "thread/items/list" && call.params.turnId)?.params.cursor).toBe("next-page");
});

test("source bytes upload in bounded chunks and never enter the model prompt", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} 0\n`);
  const source = "YQ==".repeat(20_000);
  expect(await new AppServerCloudTransport(config, async () => fake.rpc, () => {}).run({ ...job, bundle: source })).toEqual(verdict(0));
  const uploads = fake.calls.filter(call => call.method === "command/exec");
  expect(uploads).toHaveLength(3);
  expect(fake.calls.findIndex(call => call.method === "command/exec")).toBeLessThan(fake.calls.findIndex(call => call.method === "turn/start"));
  expect(uploads.every(call => String((call.params.command as string[])[2]).length < 34_000)).toBe(true);
  const input = fake.calls.find(call => call.method === "turn/start")!.params.input as { text: string }[];
  expect(input[0]!.text).not.toContain(source.slice(0, 100));
  expect(input[0]!.text.length).toBeLessThan(5000);
});

import { createHookFixture } from "./local-gate.fixture";

test("a completed command is decisive while the model turn is still running", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} 0\n`);
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
      model: mismatch === "model" ? "other-model" : "gpt-6.2-sol",
      thread: { id: "thread-fixture", environments: [{ environmentId: "ccarenv_fixture", environmentConfigId: mismatch === "environment" ? "other" : config.environmentId,
        cwd: mismatch === "cwd" ? "/workspace/other" : cwd }] },
    };
    return original(method, params);
  };
  expect(await new AppServerCloudTransport(config, async () => fake.rpc).run(job)).toMatchObject({ kind: "invalid" });
  expect(fake.calls.some(call => call.method === "command/exec")).toBe(false);
});

test("an unconfigured hook preserves the local privacy refusal", () => {
  const roots: string[] = [];
  const fixture = createHookFixture(process.cwd(), roots);
  try {
    writeFileSync(path.join(fixture.dir, "example.ts"), "export const value = 2;\n");
    const result = spawnSync("bash", [".githooks/pre-push"], { cwd: fixture.dir,
      env: { ...fixture.env, LLV_GATE_EXECUTION: "cloud", HOOK_FAIL: "scripts/privacy-publication-gate.ts" }, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(fixture.calls().some(call => call.args[0] === "scripts/privacy-publication-gate.ts")).toBe(true);
    expect(result.stderr).toContain("pre-push: privacy");
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

for (const [status, category] of [[401, "account-limit"], [403, "account-limit"], [429, "account-limit"], [400, "invalid"], [404, "invalid"], [426, "invalid"], [418, "invalid"], [503, "unavailable"]] as const) {
  test(`real WebSocket handshake ${status} is classified as ${category}`, async () => {
    const server = createServer((_request, response) => { response.writeHead(status); response.end(); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const error = await connectCloud(config, undefined, 5000, dependencies(`ws://127.0.0.1:${address.port}`)).then(() => null, error => error);
      expect(error).toBeInstanceOf(CloudRpcError);
      expect(error.category).toBe(category);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
}

test("missing turn records are invalid evidence", async () => {
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    if (method === "thread/turns/list") return {};
    const result = await original(method, params);
    if (method === "thread/items/list" && params.turnId) (result.data as { item: { status: string } }[])[0]!.item.status = "inProgress";
    return result;
  };
  let local = 0;
  expect(await runCloudChecks(job, new AppServerCloudTransport(config, async () => fake.rpc, () => {}, clock()), async () => { local++; return 0; })).toBe(1);
  expect(local).toBe(0);
});

test("an account refusal during outage recovery blocks fallback", async () => {
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    if (method === "turn/start") throw new CloudRpcError("lost acknowledgement", "unavailable");
    const result = await original(method, params);
    if (method === "thread/start") (result.thread as { id: string }).id = diagnosticThread;
    return result;
  };
  let connections = 0, local = 0;
  const reports: string[] = [];
  const transport = new AppServerCloudTransport(config, async () => {
    if (++connections % 2 === 1) return fake.rpc;
    throw new CloudRpcError("account refused", "account-limit");
  }, () => {});
  const direct = await transport.run(job);
  expect(direct).toMatchObject({ kind: "account-limit", diagnostic: { category: "account-limit", taskUrl: diagnosticUrl } });
  expect(direct.diagnostic?.reason).toContain("account refused");
  connections = 0;
  expect(await runCloudChecks(job, transport, async () => { local++; return 0; }, undefined, line => reports.push(line))).toBe(75);
  expect([connections, local]).toEqual([2, 0]);
  expect(reports[0]).toContain("[account-limit]");
  expect(reports[0]).toContain("account refused");
  expect(reports[0]).toContain(diagnosticUrl);
});

test("a permanent configuration refusal during outage recovery blocks fallback", async () => {
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    if (method === "turn/start") throw new CloudRpcError("lost acknowledgement", "unavailable");
    const result = await original(method, params);
    if (method === "thread/start") (result.thread as { id: string }).id = diagnosticThread;
    return result;
  };
  let connections = 0, local = 0;
  const reports: string[] = [];
  const transport = new AppServerCloudTransport(config, async () => {
    if (++connections % 2 === 1) return fake.rpc;
    throw rpcFailure({ code: -32600, message: "private configuration details", data: { code: "badRequest" } }, { method: "thread/start" });
  });
  const direct = await transport.run(job);
  expect(direct).toMatchObject({ kind: "invalid", diagnostic: { category: "environment", taskUrl: diagnosticUrl } });
  expect(direct.diagnostic?.reason).toContain("category configuration");
  expect(direct.diagnostic?.reason).toContain("lost acknowledgement");
  expect(direct.diagnostic?.reason).not.toContain("private configuration details");
  connections = 0;
  expect(await runCloudChecks(job, transport, async () => { local++; return 0; }, undefined, line => reports.push(line))).toBe(1);
  expect([connections, local]).toEqual([2, 0]);
  expect(reports[0]).toContain("[environment]");
  expect(reports[0]).toContain("category configuration");
  expect(reports[0]).toContain(diagnosticUrl);
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
    rpc = await connectCloud(config, undefined, 5000, dependencies(`ws://127.0.0.1:${address.port}`));
    expect(await rpc.call("probe", {})).toEqual({ protocol: "codex-app-server" });
  } finally {
    rpc?.close();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("invalid WebSocket configuration cannot enable local fallback", async () => {
  let local = 0;
  const transport = new AppServerCloudTransport(config, (config, signal, timeout) => connectCloud(config, signal, timeout, dependencies("ws://127.0.0.1:1", ["invalid protocol"])));
  expect(await runCloudChecks(job, transport, async () => { local++; return 0; })).toBe(1);
  expect(local).toBe(0);
});

test("missing Cloud setup refuses without connecting or invoking local checks", async () => {
  let connects = 0, local = 0;
  const transport = new AppServerCloudTransport(null, async () => { connects++; throw new CloudRpcError("lost", "unavailable"); });
  expect(await runCloudChecks(job, transport, async () => { local++; return 0; })).toBe(1);
  expect([connects, local]).toEqual([0, 0]);
});

for (const status of ["failed", "completed", "declined"]) test(`terminal ${status} without a receipt blocks before later transport loss`, async () => {
  const fake = fakeRpc("pre-push: types: failed (1)", 1);
  const original = fake.rpc.call;
  let connects = 0, turnReads = 0, local = 0;
  fake.rpc.call = async (method, params) => {
    if (method === "thread/turns/list") { turnReads++; throw new CloudRpcError("lost", "unavailable"); }
    const result = await original(method, params);
    if (method === "thread/items/list" && params.turnId) (result.data as { item: { status: string } }[])[0]!.item.status = status;
    return result;
  };
  const transport = new AppServerCloudTransport(config, async () => {
    if (++connects === 1) return fake.rpc;
    throw new CloudRpcError("lost", "unavailable");
  });
  expect(await runCloudChecks(job, transport, async () => { local++; return 0; })).toBe(1);
  expect([connects, turnReads, local]).toEqual([1, 0, 0]);
});

test("terminal failed evidence blocks before reading a later command page", async () => {
  const fake = fakeRpc("pre-push: types: failed (1)", 1);
  const original = fake.rpc.call;
  let lateReads = 0, local = 0;
  fake.rpc.call = async (method, params) => {
    if (method === "thread/items/list" && params.cursor) { lateReads++; throw new CloudRpcError("lost", "unavailable"); }
    const result = await original(method, params);
    return method === "thread/items/list" && params.turnId ? { ...result, nextCursor: "later" } : result;
  };
  expect(await runCloudChecks(job, new AppServerCloudTransport(config, async () => fake.rpc), async () => { local++; return 0; })).toBe(1);
  expect([lateReads, local]).toEqual([0, 0]);
});

test("a failed command cannot supply a successful receipt", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} 0\n`);
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    const result = await original(method, params);
    if (method === "thread/items/list" && params.turnId) (result.data as { item: { status: string } }[])[0]!.item.status = "failed";
    return result;
  };
  let local = 0;
  expect(await runCloudChecks(job, new AppServerCloudTransport(config, async () => fake.rpc), async () => { local++; return 0; })).toBe(1);
  expect(local).toBe(0);
});

for (const status of [400, 404, 426, 418, 503]) test(`HTTP ${status} controls retry and local execution through the shared transport`, async () => {
  let handshakes = 0, local = 0;
  const server = createServer((_request, response) => { handshakes++; response.writeHead(status); response.end(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    const transport = new AppServerCloudTransport(config, (config, signal, timeout) => connectCloud(config, signal, timeout, dependencies(`ws://127.0.0.1:${address.port}/wrong-path`)));
    expect(await runCloudChecks(job, transport, async () => { local++; return 0; })).toBe(status === 503 ? 0 : 1);
    expect([handshakes, local]).toEqual(status === 503 ? [2, 1] : [1, 0]);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

for (const method of ["item/commandExecution/requestApproval", "", null]) test(`a server request with method ${String(method)} and a colliding id leaves the genuine RPC response pending`, async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", socket => socket.on("message", bytes => {
    const request = JSON.parse(String(bytes));
    if (request.id === undefined || !request.method) return;
    socket.send(JSON.stringify({ id: request.id, method, params: { threadId: "another-thread" } }));
    socket.send(JSON.stringify({ id: request.id, result: { expected: "actual RPC response" } }));
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let rpc: CloudRpc | undefined;
  try {
    const address = server.address() as { port: number };
    rpc = await connectCloud(config, undefined, 5000, dependencies(`ws://127.0.0.1:${address.port}`));
    expect(await rpc.call("probe", {})).toEqual({ expected: "actual RPC response" });
  } finally {
    rpc?.close();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("managed default configuration contacts the hosted service and completes Cloud checks", async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} 0\n`);
  let local = 0, authentications = 0, catalogReads = 0;
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", socket => socket.on("message", async bytes => {
    const request = JSON.parse(String(bytes));
    if (request.id === undefined || !request.method) return;
    const result = await fake.rpc.call(request.method, request.params);
    socket.send(JSON.stringify({ id: request.id, result }));
  }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    const deps = dependencies(`ws://127.0.0.1:${address.port}`);
    const auth = deps.authenticate, fetch = deps.fetch;
    deps.authenticate = async (...args) => { authentications++; return auth(...args); };
    deps.fetch = async (...args) => { catalogReads++; return fetch(...args); };
    const { selectCloudCheckConfig } = await import("./cloud-check-config");
    const selected = selectCloudCheckConfig("/fixture/checkout", undefined, undefined, {
      lane: () => null, project: () => "repo-fixture", environment: () => config.environmentId,
      account: () => ({ kind: "available", account }),
    });
    const transport = new AppServerCloudTransport(selected!, (config, signal, timeout) => connectCloud(config, signal, timeout, deps), () => {});
    expect(await runCloudChecks(job, transport, async () => { local++; return 0; })).toBe(0);
    expect([authentications, catalogReads, local]).toEqual([1, 1, 0]);
    expect(fake.calls.filter(call => call.method === "initialize")).toHaveLength(1);
    expect(fake.calls.some(call => call.method === "turn/start")).toBe(true);
  } finally {
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

for (const selection of ["default", "cloud", "local"]) for (const failure of [false, true]) test(`unconfigured ${selection} pre-push runs the local plan once: ${failure ? "red" : "green"}`, () => {
  const roots: string[] = [];
  const fixture = createHookFixture(process.cwd(), roots);
  try {
    writeFileSync(path.join(fixture.dir, "example.ts"), "export const value = 2;\n");
    fixture.git("commit", "-am", "Candidate");
    // This routing fixture records check commands; native admission has its own suites.
    // Its caller already owns the test run's gate and lifetime.
    const routing = path.join(fixture.dir, ".git", "routing-shims");
    mkdirSync(routing);
    writeFileSync(path.join(routing, "bash"), '#!/bin/bash\nif [[ "$1" == scripts/gate-slot.sh ]]; then shift; exec "$@"; fi\nexec /bin/bash "$@"\n', { mode: 0o755 });
    writeFileSync(path.join(fixture.dir, ".git", "commands.jsonl"), "");
    const env: NodeJS.ProcessEnv = { ...fixture.env, ...(failure ? { HOOK_FAIL: "tsc" } : {}) };
    env.PATH = `${routing}${path.delimiter}${env.PATH}`;
    if (selection === "default") delete env.LLV_GATE_EXECUTION;
    else env.LLV_GATE_EXECUTION = selection;
    const result = spawnSync("bash", [".githooks/pre-push"], { cwd: fixture.dir, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(failure ? 1 : 0);
    expect(result.stderr).not.toContain("pre-push: Cloud checks");
    expect(result.stderr).not.toContain("Cloud unavailable");
    const calls = fixture.calls();
    expect(calls.filter(call => call.args[0] === "scripts/privacy-publication-gate.ts")).toHaveLength(1);
    expect(calls.filter(call => call.args[0] === "tsc")).toHaveLength(1);
    if (!failure) {
      expect(calls.some(call => call.args[0] === "scripts/eslint-changes.ts")).toBe(true);
      expect(calls.some(call => call.args[0] === "scripts/local-gate-tests.ts")).toBe(true);
    }
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});

// Each case crosses the public coordinator; publication must retain its cause.
const diagnosticThread = "00000000-0000-0000-0000-000000000000";
const diagnosticUrl = `codex://threads/${diagnosticThread}?hostId=durable`;
for (const scenario of ["connect", "environment", "task", "test", "timeout", "missing", "invalid", "account", "capacity", "cancelled", "prerequisite", "bun"] as const) {
  test(`Cloud diagnostic survives the coordinator: ${scenario}`, async () => {
    const fake = fakeRpc(scenario === "test" ? `pre-push: touched tests: failed (17)\nDELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} 17\n`
      : scenario === "prerequisite" ? "error: Repository lacks these prerequisite commits"
      : scenario === "bun" ? "bun: command not found" : "untrusted output", scenario === "test" ? 17 : 1);
    const original = fake.rpc.call;
    fake.rpc.call = async (method, params) => {
      const result = await original(method, params);
      if (method === "thread/start") {
        const thread = result.thread as { id: string };
        thread.id = diagnosticThread;
        if (scenario === "environment") result.model = "other";
      }
      if (method === "thread/items/list" && params.turnId && ["task", "timeout", "capacity"].includes(scenario)) return { data: [] };
      if (method === "thread/turns/list") return { data: [{ id: "turn-fixture", status: scenario === "timeout" ? "inProgress" : "failed",
        ...(scenario === "capacity" ? { error: { code: "cloudCapacityExceeded" } } : {}) }] };
      if (method === "thread/items/list" && params.turnId && scenario === "invalid") {
        const item = (result.data as { item: { aggregatedOutput: string } }[])[0]!.item;
        item.aggregatedOutput = `DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} 0\n`;
      }
      return result;
    };
    const reports: string[] = [], transportReports: string[] = [];
    let local = 0;
    const transport = new AppServerCloudTransport(config, async () => {
      if (scenario === "connect") throw new Error("forced connect error");
      if (scenario === "account") throw new CloudRpcError("account limit exceeded", "account-limit");
      return fake.rpc;
    }, line => transportReports.push(line), clock());
    const code = await runCloudChecks(job, transport, async () => { local++; return 0; }, scenario === "cancelled" ? AbortSignal.abort() : undefined, line => reports.push(line));
    const category = { connect: "connect/transport", environment: "environment", task: "task failed", test: "test failure", timeout: "timeout",
      missing: "missing receipt", invalid: "invalid receipt", account: "account-limit", capacity: "cloud-limit", cancelled: "cancelled", prerequisite: "environment", bun: "environment" }[scenario];
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0]).toContain(`[${category}]`);
    expect(reports.every(line => !/[\r\n]/.test(line) && !line.includes("private") && !line.includes("untrusted"))).toBe(true);
    if (!["connect", "account", "cancelled"].includes(scenario)) expect(reports[0]).toContain(diagnosticUrl);
    if (scenario === "test") expect(reports[0]).toContain("exited 17 (touched tests)");
    if (scenario === "connect") expect(reports[0]).toContain("forced connect error");
    expect(local).toBe(scenario === "capacity" ? 1 : 0);
    expect(code).toBe(scenario === "capacity" ? 0 : ["account", "cancelled"].includes(scenario) ? 75 : scenario === "test" ? 17 : 1);
  });
}

test("Cloud diagnostic returns a scrubbed RPC refusal and task link", async () => {
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    if (method === "command/exec") throw rpcFailure({ code: -32601, message: "private provider body", data: {} }, { method });
    const result = await original(method, params);
    if (method === "thread/start") (result.thread as { id: string }).id = diagnosticThread;
    return result;
  };
  const result = await new AppServerCloudTransport(config, async () => fake.rpc, () => {}).run(job);
  expect(result).toMatchObject({ kind: "invalid", diagnostic: { category: "task failed", taskUrl: diagnosticUrl } });
  expect(result.diagnostic?.reason).toContain("code -32601");
  expect(result.diagnostic?.reason).not.toContain("private");
});

for (const alternate of [false, true]) test(`Cloud diagnostic recognises the exact shell-quoted command: ${alternate}`, async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} 0\n`);
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    const result = await original(method, params);
    if (method === "thread/items/list" && params.turnId) {
      const item = (result.data as { item: { command: string } }[])[0]!.item;
      item.command = "/bin/bash -lc '" + item.command.replaceAll("'", alternate ? `'"'"'` : "'\\''") + "'";
    }
    return result;
  };
  expect(await new AppServerCloudTransport(config, async () => fake.rpc, () => {}).run(job)).toEqual(verdict(0));
});

for (const failure of ["offline", "conflict", "lost reply"] as const) test(`source upload only retries a proven no-effect refusal: ${failure}`, async () => {
  const { HostedEnvironmentOffline, HostedRegistryConnectRefusal } = await import("../src/lib/pipelines/cloudHostedErrors");
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${job.tree} ${job.base} ${cloudInputDigest(job.inputs)} 0\n`);
  const original = fake.rpc.call;
  const processIds: unknown[] = [];
  fake.rpc.call = async (method, params) => {
    if (method === "command/exec") {
      processIds.push(params.processId);
      if (processIds.length === 1) throw failure === "offline" ? new HostedEnvironmentOffline() : failure === "conflict" ? new HostedRegistryConnectRefusal(false) : new CloudRpcError("lost reply", "unavailable");
    }
    return original(method, params);
  };
  const result = await new AppServerCloudTransport(config, async () => fake.rpc, () => {}, clock()).run({ ...job, timeoutMs: 10_000 });
  expect(result.kind).toBe(failure === "offline" ? "verdict" : failure === "conflict" ? "cloud-limit" : "unavailable");
  expect(processIds).toHaveLength(failure === "offline" ? 2 : 1);
  if (failure === "offline") expect(processIds[0]).toBe(processIds[1]);
});

test("Cloud diagnostic discards hostile error payloads and malformed task links", async () => {
  const privateAccount = ["private", "account"].join("-"), privatePath = path.join(path.sep, "fixture", privateAccount);
  const privateEmail = `${privateAccount}@example.invalid`, credential = ["private", "credential"].join("-");
  const reports: string[] = [];
  const transport = new AppServerCloudTransport({ ...config, account: { ...account, accountId: privateAccount, home: privatePath, env: { ...account.env, AUTH_TOKEN: credential } } },
    async () => { throw new Error(`forced failure ${privateAccount} ${privatePath} ${privateEmail} Bearer ${credential}\nsecond line`); }, line => reports.push(line));
  const result = await transport.run(job);
  expect(result).toMatchObject({ kind: "invalid", diagnostic: { category: "connect/transport" } });
  expect(reports[0]).not.toMatch(/[\r\n]/);
  for (const value of [privateAccount, privatePath, privateEmail, credential]) expect(reports.join("\n")).not.toContain(value);
  const fake = fakeRpc("");
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    const reply = await original(method, params);
    if (method === "thread/start") (reply.thread as { id: string }).id = `bad\n${privateAccount}`;
    return reply;
  };
  const malformed = await new AppServerCloudTransport(config, async () => fake.rpc, () => {}).run(job);
  expect(malformed.diagnostic?.taskUrl).toBeUndefined();
});

test("Cloud diagnostics redact an entire UNC path including its hostname", async () => {
  const uncPath = String.raw`\\synthetic-host\private-share\sensitive folder\failure.log`;
  const reports: string[] = [];
  const result = await new AppServerCloudTransport(config,
    async () => { throw new Error(`spawn failed for ${uncPath}`); },
    line => reports.push(line)).run(job);
  expect(result.diagnostic?.reason).toContain("path redacted");
  for (const value of ["synthetic-host", "private-share", "sensitive folder", "failure.log"]) {
    expect(result.diagnostic?.reason).not.toContain(value);
    expect(reports.join("\n")).not.toContain(value);
  }
  expect(reports).toHaveLength(1);
  expect(reports[0]).not.toMatch(/[\r\n]/);
});

test("Cloud diagnostics redact quoted Windows and POSIX paths with spaces", async () => {
  const privateSegments = [
    "private-project",
    "sensitive report.txt",
    "private-posix-project",
    "sensitive posix report.txt",
  ];
  const windowsPath = "\"C:\\Synthetic Folder\\private-project\\sensitive report.txt\"";
  const posixPath = "'/synthetic root/private-posix-project/sensitive posix report.txt'";
  const reports: string[] = [];
  const result = await new AppServerCloudTransport(config,
    async () => { throw new Error("connect failed for " + windowsPath + "; retry failed for " + posixPath); },
    line => reports.push(line)).run(job);
  expect(result.diagnostic?.reason).toContain("path redacted");
  expect(reports).toHaveLength(1);
  expect(reports[0]).not.toMatch(/[\r\n]/);
  for (const segment of privateSegments) {
    expect(result.diagnostic?.reason).not.toContain(segment);
    expect(reports[0]).not.toContain(segment);
  }
});

for (const [platform, message, privateParts] of [
  ["POSIX", "spawn /synthetic root/private-posix-project/sensitive report.txt ENOENT", ["private-posix-project", "sensitive report.txt"]],
  ["Windows", String.raw`spawn C:\Synthetic Folder\private-project\sensitive report.txt ENOENT`, ["Folder", "private-project", "sensitive report.txt"]],
] as const) test(`Cloud coordinator removes unquoted ${platform} paths with spaces`, async () => {
  const transportReports: string[] = [], coordinatorReports: string[] = [];
  const transport = new AppServerCloudTransport(config, async () => { throw new Error(message); }, line => transportReports.push(line));
  expect(await runCloudChecks(job, transport, async () => 0, undefined, line => coordinatorReports.push(line))).toBe(1);
  const reason = transportReports[0]!;
  expect(coordinatorReports).toHaveLength(1);
  for (const privatePart of privateParts) {
    expect(reason).not.toContain(privatePart);
    expect(transportReports.join("\n")).not.toContain(privatePart);
    expect(coordinatorReports.join("\n")).not.toContain(privatePart);
  }
  expect(reason).toContain("path redacted");
  expect(coordinatorReports[0]).toContain("[connect/transport]");
});

test("real spawn ENOENT keeps its safe operation and native code through publication", async () => {
  const missingExecutable = path.join(process.cwd(), "scripts", "private missing executable");
  const transportReports: string[] = [], coordinatorReports: string[] = [];
  const transport = new AppServerCloudTransport(config, async () => await new Promise((_, reject) => {
    const child = spawn(missingExecutable, []);
    child.once("error", reject);
  }), line => transportReports.push(line));
  expect(await runCloudChecks(job, transport, async () => 0, undefined, line => coordinatorReports.push(line))).toBe(1);
  for (const report of [transportReports[0]!, coordinatorReports[0]!]) {
    expect(report).toContain("spawn failed (ENOENT)");
    expect(report).not.toContain(missingExecutable);
    expect(report).not.toContain("private missing executable");
  }
  expect(coordinatorReports[0]).toContain("[environment]");
});

for (const refusal of ["connect", "input"] as const) test(`Cloud ${refusal} refusal reaches publication hook output without a receipt`, async () => {
  const { createPublicationFixtures } = await import("./publicationHook.fixture");
  const roots: string[] = [];
  const { nativeFixture, touchedChecks } = createPublicationFixtures(process.cwd(), roots);
  const fixture = nativeFixture();
  try {
    Object.assign(fixture.env, { LLV_GATE_EXECUTION: "cloud", LLV_GATE_CHECK_ENV: refusal === "input" ? "HOME" : "HOOK_FAIL",
      NODE_OPTIONS: "--max-old-space-size=1024", SHELL: "/bin/sh" });
    for (const name of Object.keys(fixture.env)) if (/^(?:BUN_|GIT_CONFIG_)/.test(name) || ["LLV_GATE_BUN", "CHROME_BIN", "PLAYWRIGHT_BROWSERS_PATH"].includes(name)) delete fixture.env[name];
    const preload = path.join(fixture.dir, ".git", "cloud-refusal.ts");
    writeFileSync(preload, `import { mock } from "bun:test";
const cloud = await import(${JSON.stringify(path.join(process.cwd(), "scripts/cloud-checks.ts"))});
mock.module(${JSON.stringify(path.join(process.cwd(), "scripts/cloud-check-config.ts"))}, () => ({ cloudCheckConfig: async () => (${JSON.stringify(config)}) }));
mock.module(${JSON.stringify(path.join(process.cwd(), "scripts/cloud-checks.ts"))}, () => ({ ...cloud, AppServerCloudTransport: class extends cloud.AppServerCloudTransport {
  constructor(config, _connect, report) { super(config, async () => { throw new Error("forced connect error"); }, report); }
} }));`);
    const result = spawnSync(process.execPath, ["--preload", preload, "scripts/local-gate.ts", "pre-push", "--publication-prepare"], {
      cwd: fixture.dir, env: fixture.env, encoding: "utf8", timeout: 45_000,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(refusal === "connect" ? "Cloud checks refused [connect/transport]: forced connect error" : "Cloud checks refused [environment]: Unsupported Cloud check input name");
    expect(result.stderr).not.toContain(account.home);
    expect(result.stderr).not.toContain(account.transcriptRoot);
    expect(touchedChecks(fixture)).toHaveLength(0);
    expect(existsSync(fixture.receipt)).toBe(false);
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
}, 60_000);


for (const code of [0, 17]) test(`a mismatched Cloud receipt retains its invalid category and task link (exit ${code})`, async () => {
  const fake = fakeRpc(`DELEGATUS_GATE ${job.head} ${"d".repeat(40)} ${job.base} ${cloudInputDigest(job.inputs)} ${code}\n`, code);
  const original = fake.rpc.call;
  fake.rpc.call = async (method, params) => {
    const result = await original(method, params);
    if (method === "thread/start") (result.thread as { id: string }).id = diagnosticThread;
    return result;
  };
  const result = await new AppServerCloudTransport(config, async () => fake.rpc, () => {}).run(job);
  expect(result.diagnostic).toMatchObject({ category: "invalid receipt", taskUrl: diagnosticUrl });
  const lines: string[] = [];
  let local = 0;
  expect(await runCloudChecks(job, { run: async () => result }, async () => { local++; return 0; }, undefined, line => lines.push(line))).toBe(1);
  expect(lines[0]).toContain("[invalid receipt]");
  expect(lines[0]).toContain(diagnosticUrl);
  expect(local).toBe(0);
});
