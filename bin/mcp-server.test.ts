import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { seatMcpHealth } from "../src/lib/monitor/seatMcpHealth";
import { appDirIn } from "./appDir.mjs";
import { headlessCodexThreadConfig } from "../src/lib/codexHeadlessConfig";

const sandboxes: string[] = [];

/** Result fields consumed by these fixture-specific RPC assertions. */
interface TestRpcResponse {
  id?: number | string;
  error?: unknown;
  result: {
    serverInfo: { name: string };
    tools: { name: string }[];
    content: { text: string }[];
    isError?: boolean;
    thread: { id: string };
    data: { name: string; tools: Record<string, unknown> }[];
  };
}

function stdioSession(command: string, launcher: string, root: string, env: Record<string, string>) {
  const process = spawn(command, [launcher], { cwd: root, env: { ...globalThis.process.env, ...env, LLV_BUN_EXECUTABLE: globalThis.process.execPath }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const messages: TestRpcResponse[] = [];
  const waiting = new Set<() => void>();
  process.stdout.setEncoding("utf8");
  process.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n");
      messages.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
    for (const wake of waiting) wake();
  });
  async function responseFor(id: number, timeoutMs = 5_000): Promise<TestRpcResponse> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const at = messages.findIndex((message) => message.id === id);
      if (at >= 0) return messages.splice(at, 1)[0]!;
      if (process.exitCode !== null) throw new Error(`MCP launcher exited before response ${id}`);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { waiting.delete(wake); reject(new Error(`MCP response ${id} timed out`)); }, Math.max(1, until - Date.now()));
        const wake = () => { clearTimeout(timeout); waiting.delete(wake); resolve(); };
        waiting.add(wake);
      });
    }
    throw new Error(`MCP response ${id} timed out`);
  }
  function call(id: number, method: string, params: object = {}) {
    process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return responseFor(id);
  }
  return { process, call, responseFor };
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function installedPackage(serverSource = `
  process.stdout.write(JSON.stringify({ bun: process.versions.bun ?? null }) + "\\n");
  process.stdin.pipe(process.stdout);
`): { root: string; launcher: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-installed-mcp-"));
  sandboxes.push(root);
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dir, "mcp-server.mjs"), path.join(root, "bin", "mcp-server.mjs"));
  for (const name of ["server-runtime.mjs", "appDir.mjs", "envAlias.mjs", "self-update-supervisor.mjs"]) {
    fs.copyFileSync(path.join(import.meta.dir, name), path.join(root, "bin", name));
  }
  fs.writeFileSync(path.join(root, "dist", "mcp-server.mjs"), serverSource, "utf8");
  return { root, launcher: path.join(root, "bin", "mcp-server.mjs") };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=noreply", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function selfUpdateFixture(checkoutBundle: string) {
  const { root, launcher } = installedPackage(checkoutBundle);
  const stateDir = path.join(root, "state");
  const cacheDir = path.join(root, "cache");
  const home = path.join(root, "home");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(cacheDir);
  fs.mkdirSync(home);
  git(root, "init", "--initial-branch=main");
  git(root, "add", "bin", "dist");
  git(root, "commit", "-m", "checkout");
  const checkoutHead = git(root, "rev-parse", "HEAD");
  const installId = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
  const pointer = path.join(stateDir, "self-update", `release-${installId}.json`);
  const releasesDir = path.join(appDirIn(cacheDir), "self-update", installId, "releases");
  fs.mkdirSync(path.dirname(pointer), { recursive: true });
  fs.mkdirSync(releasesDir, { recursive: true });
  function release(name: string, bundle: string) {
    const dir = path.join(releasesDir, name);
    git(root, "worktree", "add", "-b", name, dir);
    fs.mkdirSync(path.join(dir, ".next"));
    fs.writeFileSync(path.join(dir, ".next", "BUILD_ID"), "built\n");
    fs.writeFileSync(path.join(dir, "dist", "mcp-server.mjs"), bundle);
    git(dir, "add", ".next", "dist");
    git(dir, "commit", "-m", name);
    const sha = git(dir, "rev-parse", "HEAD");
    return { dir, sha, checkoutHead };
  }
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: cacheDir, LLV_STATE_DIR: stateDir };
  return { root, launcher, stateDir, pointer, release, env };
}

function mcpBundle(label: string) {
  return `
    process.stdin.setEncoding("utf8");
    let input = "";
    process.stdin.on("data", chunk => {
      input += chunk;
      while (input.includes("\\n")) {
        const at = input.indexOf("\\n");
        const request = JSON.parse(input.slice(0, at)); input = input.slice(at + 1);
        if (request.id === undefined) continue;
        const result = request.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "viewer", version: "1" } }
          : request.method === "tools/list"
            ? { tools: [{ name: "release", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "${label}" }] };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      }
    });
  `;
}

test.skipIf(process.env.LLV_CODEX_MCP_ENV_TEST !== "1")("native Codex forwards the seat capability to its Viewer launcher", async () => {
  const { root, launcher } = installedPackage(mcpBundle("seat-tools-available"));
  const stateDir = path.join(root, "state");
  const capability = "S".repeat(43);
  fs.mkdirSync(path.join(root, ".codex"));
  const digest = createHash("sha256").update(capability).digest("hex");
  const receipt = { spawnCapabilityDigest: digest, createdAt: new Date(Date.now() - 30 * 60_000).toISOString() };
  const config = headlessCodexThreadConfig({ config: { mcp_servers: {
    viewer: { command: process.execPath, args: [launcher], env: { LLV_STATE_DIR: stateDir } },
  } } });
  const session = stdioSession(process.env.LLV_CODEX_BINARY ?? "codex", "app-server", root, {
    HOME: root, CODEX_HOME: path.join(root, ".codex"), XDG_CONFIG_HOME: path.join(root, "config"),
    LLV_STATE_DIR: stateDir, LLV_SPAWN_CAPABILITY: capability,
    LLV_VIEWER_DEPLOY_TARGET: path.join(stateDir, "viewer-release.json"), OPENAI_API_KEY: "",
  });
  let diagnostics = "";
  session.process.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
  try {
    expect((await session.call(1, "initialize", { clientInfo: { name: "seat-mcp-test", version: "1" } })).error).toBeUndefined();
    session.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    const thread = await session.call(2, "thread/start", { cwd: root, config });
    expect(thread.error).toBeUndefined();
    let available = false;
    for (let id = 3; id < 23; id++) {
      const status = await session.call(id, "mcpServerStatus/list", { threadId: thread.result.thread.id, serverName: "viewer" });
      available = status.result?.data?.some((server: { name: string; tools: Record<string, unknown> }) =>
        server.name === "viewer" && Object.keys(server.tools).length > 0) ?? false;
      if (available) break;
      await Bun.sleep(100);
    }
    expect(available).toBe(true);
    const call = await session.call(23, "mcpServer/tool/call", {
      threadId: thread.result.thread.id, server: "viewer", tool: "release", arguments: {},
    });
    expect(call.error).toBeUndefined();
    expect(call.result.content[0].text).toBe("seat-tools-available");
    expect(seatMcpHealth(receipt, null, stateDir, Date.now())).toMatchObject({ status: "healthy" });
  } catch (error) {
    throw new Error(`${String(error)}\n${diagnostics}`);
  } finally {
    session.process.stdin.end();
    if (session.process.exitCode === null) await new Promise<void>((resolve) => session.process.once("close", () => resolve()));
  }
}, 30_000);

test("self-update pointer selects the installed MCP bundle and falls back only as installedRelease decides", async () => {
  const fixture = selfUpdateFixture("process.stdout.write('checkout:' + (process.env.LLV_HOT_STATE_RELEASE_REVISION || 'none') + '\\n');");
  const { root, launcher, stateDir, pointer, release, env } = fixture;
  const installed = release("first", "process.stdout.write('release\\n');");
  const run = () => launchFrom(root, launcher, env, "", "bun");
  expect(await run()).toMatchObject({ exitCode: 0, stdout: "checkout:none\n", stderr: "" });
  fs.writeFileSync(pointer, "{invalid json");
  expect(await run()).toMatchObject({ exitCode: 0, stdout: "checkout:none\n", stderr: "" });
  fs.writeFileSync(pointer, JSON.stringify(installed));
  expect(await run()).toMatchObject({ exitCode: 0, stdout: "release\n", stderr: "" });

  const revision = "7".repeat(40);
  const releaseId = `deploy-${revision}`;
  const managedBundle = "process.stdout.write('managed:' + process.env.LLV_HOT_STATE_RELEASE_REVISION + '\\n');";
  const managedRoot = path.join(stateDir, "mcp-runtime", "releases", releaseId, "dist");
  fs.mkdirSync(managedRoot, { recursive: true });
  fs.writeFileSync(path.join(managedRoot, "mcp-server.mjs"), managedBundle);
  fs.writeFileSync(path.join(stateDir, "viewer-release.json"), JSON.stringify({
    revision, image: "viewer:managed", container: "viewer-managed", endpoint: "http://127.0.0.1:1",
    mcpRuntime: { source: "managed", revision, releaseId, artifactDigest: createHash("sha256").update(managedBundle).digest("hex"), stagedAt: "2026-07-23T08:00:00.000Z" },
  }));
  expect(await run()).toMatchObject({ exitCode: 0, stdout: `managed:${revision}\n`, stderr: "" });
  fs.writeFileSync(path.join(stateDir, "viewer-release.json"), JSON.stringify({
    revision, image: "viewer:managed", container: "viewer-managed", endpoint: "http://127.0.0.1:1",
  }));
  expect(await run()).toMatchObject({ exitCode: 0, stdout: `checkout:${revision}\n`, stderr: "" });

  fs.unlinkSync(path.join(stateDir, "viewer-release.json"));
  git(root, "commit", "--allow-empty", "-m", "checkout moved");
  expect(await run()).toMatchObject({ exitCode: 0, stdout: "checkout:none\n", stderr: "" });
}, 15_000);

test("one MCP session starts the next installed release when the self-update pointer changes", async () => {
  const { root, launcher, pointer, release, env } = selfUpdateFixture(mcpBundle("checkout"));
  const first = release("first", mcpBundle("first"));
  const second = release("second", mcpBundle("second"));
  fs.writeFileSync(pointer, JSON.stringify(first));
  const session = stdioSession(process.execPath, launcher, root, env);
  try {
    expect((await session.call(1, "initialize")).result.serverInfo.name).toBe("viewer");
    session.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    expect((await session.call(2, "tools/call", { name: "release", arguments: {} })).result.content[0].text).toBe("first");
    fs.writeFileSync(pointer, JSON.stringify(second));
    let switched = false;
    for (let id = 3; id < 23; id++) {
      const answer = await session.call(id, "tools/call", { name: "release", arguments: {} });
      if (answer.result?.content?.[0]?.text === "second") { switched = true; break; }
      expect(answer.result?.isError).toBe(true);
      await Bun.sleep(50);
    }
    expect(switched).toBe(true);
    expect(session.process.exitCode).toBeNull();
  } finally {
    session.process.stdin.end();
    if (session.process.exitCode === null) await new Promise<void>((resolve) => session.process.once("close", () => resolve()));
  }
}, 15_000);

async function launchInstalled(env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { root, launcher } = installedPackage();
  return launchFrom(root, launcher, env, "initialize-handshake\n");
}

async function launchFrom(
  root: string,
  launcher: string,
  env: Record<string, string>,
  input: string,
  runtime: "node" | "bun" = "node",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const node = Bun.which("node");
  const bun = Bun.which("bun");
  if (!node || !bun) throw new Error("Node and Bun are required for the launcher test");
  const child = Bun.spawn({
    cmd: [runtime === "bun" ? bun : node, launcher],
    cwd: root,
    env: { ...process.env, ...env, LLV_BUN_EXECUTABLE: bun },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(input);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("fresh Claude and Codex hosts load the exact MCP runtime named by the promoted release", async () => {
  const previousRevision = "8".repeat(40);
  const candidateRevision = "7".repeat(40);
  const { root, launcher } = installedPackage(`
    process.stdout.write(JSON.stringify({
      revision: "${previousRevision}",
      tools: ["deploy_exact_sha", "get_pipeline"],
      host: process.env.LLV_TEST_HOST,
    }) + "\\n");
    process.stdin.pipe(process.stdout);
  `);
  const stateDir = path.join(root, "state");
  const releaseId = `deploy-${candidateRevision}`;
  const releaseRoot = path.join(stateDir, "mcp-runtime", "releases", releaseId);
  const candidateBundle = `
    process.stdout.write(JSON.stringify({
      revision: "${candidateRevision}",
      tools: ["deployment_status", "board_snapshot"],
      host: process.env.LLV_TEST_HOST,
      hotStateRevision: process.env.LLV_HOT_STATE_RELEASE_REVISION,
    }) + "\\n");
    process.stdin.pipe(process.stdout);
  `;
  fs.mkdirSync(path.join(releaseRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(releaseRoot, "dist", "mcp-server.mjs"), candidateBundle, "utf8");
  const targetFile = path.join(root, "targets", "viewer-release.json");
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, JSON.stringify({
    revision: candidateRevision,
    image: `viewer:${candidateRevision}`,
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:18001",
    mcpRuntime: {
      source: "managed",
      revision: candidateRevision,
      releaseId,
      artifactDigest: createHash("sha256").update(candidateBundle).digest("hex"),
      stagedAt: "2026-07-23T08:00:00.000Z",
    },
  }), "utf8");

  for (const host of ["claude", "codex"]) {
    const result = await launchFrom(root, launcher, {
      LLV_TEST_HOST: host,
      LLV_STATE_DIR: stateDir,
      LLV_VIEWER_DEPLOY_TARGET: targetFile,
    }, `${host}-initialize\n`, "bun");
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const [runtime, handshake] = result.stdout.trim().split("\n");
    expect(JSON.parse(runtime!)).toEqual({
      revision: candidateRevision,
      tools: ["deployment_status", "board_snapshot"],
      host,
      hotStateRevision: candidateRevision,
    });
    expect(handshake).toBe(`${host}-initialize`);
  }
}, 15_000);

test("a fresh host rejects a managed MCP runtime whose bundle differs from the published digest", async () => {
  const revision = "7".repeat(40);
  const { root, launcher } = installedPackage();
  const stateDir = path.join(root, "state");
  const releaseId = `deploy-${revision}`;
  const releaseRoot = path.join(stateDir, "mcp-runtime", "releases", releaseId);
  fs.mkdirSync(path.join(releaseRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(releaseRoot, "dist", "mcp-server.mjs"), "process.stdout.write('tampered\\n');", "utf8");
  const targetFile = path.join(stateDir, "viewer-release.json");
  fs.writeFileSync(targetFile, JSON.stringify({
    revision,
    image: `viewer:${revision}`,
    container: "viewer-candidate",
    endpoint: "http://127.0.0.1:18001",
    mcpRuntime: {
      source: "managed",
      revision,
      releaseId,
      artifactDigest: "a".repeat(64),
      stagedAt: "2026-07-23T08:00:00.000Z",
    },
  }), "utf8");

  const result = await launchFrom(root, launcher, {
    LLV_STATE_DIR: stateDir,
    LLV_VIEWER_DEPLOY_TARGET: targetFile,
  }, "", "bun");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("MCP runtime bundle digest does not match the active release");
});

test("an existing malformed release target fails closed instead of loading the legacy runtime", async () => {
  const { root, launcher } = installedPackage("process.stdout.write('legacy\\n');");
  const stateDir = path.join(root, "state");
  const targetFile = path.join(stateDir, "viewer-release.json");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(targetFile, "{}\n", "utf8");

  const result = await launchFrom(root, launcher, {
    LLV_STATE_DIR: stateDir,
    LLV_VIEWER_DEPLOY_TARGET: targetFile,
  }, "", "bun");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("active Viewer release target is invalid");
});

test("a missing published bundle recovers initialization on the original Node and Bun stdio pipes", async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required for the launcher test");
  const bundle = `
    process.stdin.setEncoding("utf8");
    let input = "";
    process.stdin.on("data", chunk => {
      input += chunk;
      while (input.includes("\\n")) {
        const at = input.indexOf("\\n");
        const request = JSON.parse(input.slice(0, at)); input = input.slice(at + 1);
        if (request.id === undefined) continue;
        const result = request.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "viewer", version: "1" } }
          : request.method === "tools/list"
            ? { tools: [{ name: "release", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "published" }] };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      }
    });
  `;
  for (const command of [node, process.execPath]) {
    const { root, launcher } = installedPackage();
    const stateDir = path.join(root, "state");
    const revision = "4".repeat(40);
    const releaseId = `deploy-${revision}`;
    const targetFile = path.join(stateDir, "viewer-release.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(targetFile, JSON.stringify({
      revision, image: `viewer:${revision}`, container: "viewer-candidate", endpoint: "http://127.0.0.1:18001",
      mcpRuntime: { source: "managed", revision, releaseId, artifactDigest: createHash("sha256").update(bundle).digest("hex"), stagedAt: new Date().toISOString() },
    }));
    const session = stdioSession(command, launcher, root, { LLV_STATE_DIR: stateDir, LLV_VIEWER_DEPLOY_TARGET: targetFile });
    try {
      session.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) + "\n");
      await Bun.sleep(300);
      expect(session.process.exitCode).toBeNull();
      const releaseRoot = path.join(stateDir, "mcp-runtime", "releases", releaseId, "dist");
      fs.mkdirSync(releaseRoot, { recursive: true });
      fs.writeFileSync(path.join(releaseRoot, "mcp-server.mjs"), bundle);
      expect((await session.responseFor(1)).result.serverInfo.name).toBe("viewer");
      session.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      expect((await session.call(2, "tools/list")).result.tools[0].name).toBe("release");
      expect((await session.call(3, "tools/call", { name: "release", arguments: {} })).result.content[0].text).toBe("published");
      expect(session.process.exitCode).toBeNull();
    } finally {
      session.process.stdin.end();
      await new Promise<void>((resolve) => session.process.once("close", () => resolve()));
    }
  }
}, 15_000);

test("a buffered child pipe failure keeps the original stdio session and call identity through a release switch", async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required for the launcher test");
  const crashingBundle = `
    let input = "", exitOnNextChunk = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      if (exitOnNextChunk) process.exit(7);
      input += chunk;
      while (input.includes("\\n")) {
        const at = input.indexOf("\\n");
        const request = JSON.parse(input.slice(0, at)); input = input.slice(at + 1);
        if (request.id === undefined) continue;
        const result = request.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "viewer", version: "1" } }
          : { tools: [{ name: "check", inputSchema: { type: "object" } }] };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
        if (request.method === "tools/list") exitOnNextChunk = true;
      }
    });
  `;
  const recoveredBundle = `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
      input += chunk;
      while (input.includes("\\n")) {
        const at = input.indexOf("\\n");
        const request = JSON.parse(input.slice(0, at)); input = input.slice(at + 1);
        if (request.id === undefined) continue;
        const result = request.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "viewer", version: "2" } }
          : request.method === "tools/list"
            ? { tools: [{ name: "check", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "recovered" }] };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      }
    });
  `;
  for (const command of [node, process.execPath]) {
    const { root, launcher } = installedPackage();
    const stateDir = path.join(root, "state");
    const targetFile = path.join(stateDir, "viewer-release.json");
    const capability = "C".repeat(43);
    const heartbeatFile = path.join(stateDir, "mcp-runtime", "sessions", `${createHash("sha256").update(capability).digest("hex")}.json`);
    function publish(revision: string, bundle: string) {
      const releaseId = `deploy-${revision}`;
      const releaseRoot = path.join(stateDir, "mcp-runtime", "releases", releaseId, "dist");
      fs.mkdirSync(releaseRoot, { recursive: true });
      fs.writeFileSync(path.join(releaseRoot, "mcp-server.mjs"), bundle);
      fs.writeFileSync(targetFile, JSON.stringify({
        revision, image: `viewer:${revision}`, container: "viewer-candidate", endpoint: "http://127.0.0.1:1",
        mcpRuntime: { source: "managed", revision, releaseId, artifactDigest: createHash("sha256").update(bundle).digest("hex"), stagedAt: new Date().toISOString() },
      }));
    }
    publish("5".repeat(40), crashingBundle);
    const session = stdioSession(command, launcher, root, { LLV_STATE_DIR: stateDir, LLV_VIEWER_DEPLOY_TARGET: targetFile, LLV_SPAWN_CAPABILITY: capability });
    try {
      expect((await session.call(1, "initialize")).result.serverInfo.name).toBe("viewer");
      expect((await session.call(2, "tools/list")).result.tools[0].name).toBe("check");
      const failed = await session.call(3, "tools/call", { name: "check", arguments: { payload: "x".repeat(1024 * 1024) } });
      expect(failed.id).toBe(3);
      expect(failed.result.isError).toBe(true);
      expect(failed.result.content[0].text).toContain("retry");
      expect(session.process.exitCode).toBeNull();
      expect(JSON.parse(fs.readFileSync(heartbeatFile, "utf8")).failedCalls).toBe(1);
      publish("6".repeat(40), recoveredBundle);
      let recovered = false;
      for (let id = 4; id < 24; id++) {
        const answer = await session.call(id, "tools/call", { name: "check", arguments: {} });
        if (answer.result?.content?.[0]?.text === "recovered") { recovered = true; break; }
        expect(answer.result.isError).toBe(true);
        await Bun.sleep(50);
      }
      expect(recovered).toBe(true);
      expect((await session.call(24, "tools/list")).result.tools[0].name).toBe("check");
      expect(session.process.exitCode).toBeNull();
      expect(JSON.parse(fs.readFileSync(heartbeatFile, "utf8")).failedCalls).toBe(0);
    } finally {
      session.process.stdin.end();
      if (session.process.exitCode === null) await new Promise<void>((resolve) => session.process.once("close", () => resolve()));
    }
  }
}, 20_000);

test("the production launcher records transport failure, excludes business refusals, and clears on a recovered call", async () => {
  const { root, launcher } = installedPackage(`
    const fs = await import("node:fs");
    process.stdin.setEncoding("utf8");
    let input = "";
    process.stdin.on("data", async chunk => {
      input += chunk;
      while (input.includes("\\n")) {
        const at = input.indexOf("\\n");
        const request = JSON.parse(input.slice(0, at)); input = input.slice(at + 1);
        if (request.id === undefined) continue;
        let result;
        if (request.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "viewer", version: "1" } };
        else if (request.method === "tools/list") result = { tools: [{ name: "check", inputSchema: { type: "object" } }] };
        else if (request.method === "ping") result = {};
        else if (request.params.name === "invalid") result = { isError: true, structuredContent: { ok: false, code: "TASK_INVALID_FIELD", error: "invalid field" }, content: [{ type: "text", text: "invalid field" }] };
        else if (request.params.name === "unstructured") result = { isError: true, content: [{ type: "text", text: "ECONNREFUSED while contacting Viewer" }] };
        else {
          try {
            const endpoint = fs.readFileSync(process.env.LLV_TEST_ENDPOINT_FILE, "utf8");
            await fetch(endpoint);
            result = { content: [{ type: "text", text: "connected" }] };
          } catch {
            result = { isError: true, structuredContent: { ok: false, code: "tool_failed", error: "Viewer control did not reconnect after 3 attempts (connection failed)" }, content: [{ type: "text", text: "Viewer control did not reconnect" }] };
          }
        }
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      }
    });
  `);
  const stateDir = path.join(root, "state");
  const endpointFile = path.join(root, "endpoint.txt");
  fs.writeFileSync(endpointFile, "http://127.0.0.1:1/");
  const capability = "A".repeat(43);
  const digest = createHash("sha256").update(capability).digest("hex");
  const heartbeatFile = path.join(stateDir, "mcp-runtime", "sessions", `${digest}.json`);
  const session = stdioSession(process.execPath, launcher, root, { LLV_STATE_DIR: stateDir, LLV_SPAWN_CAPABILITY: capability, LLV_TEST_ENDPOINT_FILE: endpointFile });
  const receipt = { spawnCapabilityDigest: digest, createdAt: new Date(Date.now() - 30 * 60_000).toISOString() };
  const designatedAt = new Date(Date.now() - 20 * 60_000).toISOString();
  try {
    expect((await session.call(1, "initialize")).result.serverInfo.name).toBe("viewer");
    for (let id = 2; id <= 3; id++) expect((await session.call(id, "tools/call", { name: "check" })).result.isError).toBe(true);
    expect(JSON.parse(fs.readFileSync(heartbeatFile, "utf8")).failedCalls).toBe(2);
    expect(seatMcpHealth(receipt, designatedAt, stateDir, Date.now()).status).toBe("healthy");
    expect((await session.call(4, "tools/call", { name: "invalid" })).result.isError).toBe(true);
    expect(JSON.parse(fs.readFileSync(heartbeatFile, "utf8")).failedCalls).toBe(0);
    for (let id = 5; id <= 7; id++) expect((await session.call(id, "tools/call", { name: id === 6 ? "unstructured" : "check" })).result.isError).toBe(true);
    expect(JSON.parse(fs.readFileSync(heartbeatFile, "utf8")).failedCalls).toBe(3);
    expect(seatMcpHealth(receipt, designatedAt, stateDir, Date.now()).status).toBe("dead");
    const endpoint = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      fs.writeFileSync(endpointFile, `http://127.0.0.1:${endpoint.port}/`);
      expect((await session.call(8, "tools/call", { name: "check" })).result.content[0].text).toBe("connected");
      expect(seatMcpHealth(receipt, designatedAt, stateDir, Date.now()).status).toBe("healthy");
    } finally { endpoint.stop(true); }
  } finally {
    session.process.stdin.end();
    if (session.process.exitCode === null) await new Promise<void>((resolve) => session.process.once("close", () => resolve()));
  }
}, 15_000);

test("a silent child fails the protocol probe, blocks an old seat, and reconnects after it exits", async () => {
  const { root, launcher } = installedPackage(`
    const fs = await import("node:fs");
    let hung = false;
    setInterval(() => { if (hung && !fs.existsSync(process.env.LLV_TEST_HANG_FLAG)) process.exit(0); }, 50).unref();
    process.stdin.setEncoding("utf8");
    let input = "";
    process.stdin.on("data", chunk => {
      input += chunk;
      while (input.includes("\\n")) {
        const at = input.indexOf("\\n");
        const request = JSON.parse(input.slice(0, at)); input = input.slice(at + 1);
        if (request.id === undefined) continue;
        if (fs.existsSync(process.env.LLV_TEST_HANG_FLAG)) { hung = true; continue; }
        const result = request.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "viewer", version: "1" } }
          : request.method === "tools/list" ? { tools: [{ name: "check", inputSchema: { type: "object" } }] }
          : request.method === "ping" ? {} : { content: [{ type: "text", text: "recovered" }] };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      }
    });
  `);
  const stateDir = path.join(root, "state");
  const flag = path.join(root, "hang.flag");
  const capability = "B".repeat(43);
  const digest = createHash("sha256").update(capability).digest("hex");
  const heartbeatFile = path.join(stateDir, "mcp-runtime", "sessions", `${digest}.json`);
  const session = stdioSession(process.execPath, launcher, root, { LLV_STATE_DIR: stateDir, LLV_SPAWN_CAPABILITY: capability, LLV_TEST_HANG_FLAG: flag });
  const receipt = { spawnCapabilityDigest: digest, createdAt: new Date(Date.now() - 30 * 60_000).toISOString() };
  const designatedAt = new Date(Date.now() - 20 * 60_000).toISOString();
  try {
    expect((await session.call(1, "initialize")).result.serverInfo.name).toBe("viewer");
    fs.writeFileSync(flag, "hang");
    session.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check" } }) + "\n");
    expect((await session.responseFor(2, 50_000)).result.isError).toBe(true);
    const heartbeatDeadline = Date.now() + 2_000;
    let heartbeat = JSON.parse(fs.readFileSync(heartbeatFile, "utf8"));
    while (heartbeat.ready && Date.now() < heartbeatDeadline) {
      await Bun.sleep(10);
      heartbeat = JSON.parse(fs.readFileSync(heartbeatFile, "utf8"));
    }
    expect(heartbeat.ready).toBe(false);
    const thresholdNow = Date.parse(heartbeat.unreadySince) + 2 * 60_000 + 1;
    fs.writeFileSync(heartbeatFile, JSON.stringify({ ...heartbeat, checkedAt: new Date(thresholdNow).toISOString() }));
    expect(seatMcpHealth(receipt, designatedAt, stateDir, thresholdNow).status).toBe("dead");
    fs.unlinkSync(flag);
    let recovered = false;
    for (let id = 3; id < 25; id++) {
      const response = await session.call(id, "tools/call", { name: "check" });
      if (response.result?.content?.[0]?.text === "recovered") { recovered = true; break; }
      await Bun.sleep(100);
    }
    expect(recovered).toBe(true);
    expect(seatMcpHealth(receipt, designatedAt, stateDir, Date.now()).status).toBe("healthy");
  } finally {
    if (fs.existsSync(flag)) fs.unlinkSync(flag);
    session.process.stdin.end();
    if (session.process.exitCode === null) await new Promise<void>((resolve) => session.process.once("close", () => resolve()));
  }
}, 65_000);

test("the installed MCP launcher selects Bun for Bun-only Viewer configuration and preserves stdio", async () => {
  const configurations: Record<string, string>[] = [
    { LLV_AGENT_REGISTRY_SQLITE: "read" },
    { LLV_STRUCTURED_HOSTS: "1" },
  ];
  for (const env of configurations) {
    const result = await launchInstalled(env);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const [runtime, handshake] = result.stdout.trim().split("\n");
    expect(JSON.parse(runtime!)).toMatchObject({ bun: expect.any(String) });
    expect(handshake).toBe("initialize-handshake");
  }
}, 15_000);

test("the installed MCP launcher forwards termination to its Bun child", async () => {
  const readyPath = path.join(os.tmpdir(), `llv-mcp-ready-${crypto.randomUUID()}`);
  const signalPath = path.join(os.tmpdir(), `llv-mcp-signal-${crypto.randomUUID()}`);
  sandboxes.push(readyPath, signalPath);
  const { root, launcher } = installedPackage(`
    const fs = await import("node:fs");
    fs.writeFileSync(process.env.LLV_TEST_READY, "ready\\n", "utf8");
    process.once("SIGTERM", () => {
      fs.writeFileSync(process.env.LLV_TEST_SIGNAL, "SIGTERM\\n", "utf8");
      process.exit(0);
    });
    setInterval(() => {}, 1_000);
  `);
  const node = Bun.which("node");
  const bun = Bun.which("bun");
  if (!node || !bun) throw new Error("Node and Bun are required for the launcher test");
  const child = Bun.spawn({
    cmd: [node, launcher],
    cwd: root,
    env: {
      ...process.env,
      LLV_STRUCTURED_HOSTS: "1",
      LLV_BUN_EXECUTABLE: bun,
      LLV_TEST_READY: readyPath,
      LLV_TEST_SIGNAL: signalPath,
    },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(readyPath)) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the Bun MCP child");
    await Bun.sleep(5);
  }
  child.kill("SIGTERM");
  await child.exited;
  expect(fs.readFileSync(signalPath, "utf8")).toBe("SIGTERM\n");
}, 15_000);

test("the installed MCP launcher forwards escalating signals until its Bun child exits", async () => {
  const readyPath = path.join(os.tmpdir(), `llv-mcp-ready-${crypto.randomUUID()}`);
  const signalPath = path.join(os.tmpdir(), `llv-mcp-signals-${crypto.randomUUID()}`);
  sandboxes.push(readyPath, signalPath);
  const { root, launcher } = installedPackage(`
    const fs = await import("node:fs");
    fs.writeFileSync(process.env.LLV_TEST_READY, "ready\\n", "utf8");
    process.on("SIGINT", () => fs.appendFileSync(process.env.LLV_TEST_SIGNAL, "SIGINT\\n", "utf8"));
    process.on("SIGTERM", () => {
      fs.appendFileSync(process.env.LLV_TEST_SIGNAL, "SIGTERM\\n", "utf8");
      process.exit(0);
    });
    setTimeout(() => process.exit(7), 1_500);
    setInterval(() => {}, 1_000);
  `);
  const node = Bun.which("node");
  const bun = Bun.which("bun");
  if (!node || !bun) throw new Error("Node and Bun are required for the launcher test");
  const child = Bun.spawn({
    cmd: [node, launcher],
    cwd: root,
    env: {
      ...process.env,
      LLV_STRUCTURED_HOSTS: "1",
      LLV_BUN_EXECUTABLE: bun,
      LLV_TEST_READY: readyPath,
      LLV_TEST_SIGNAL: signalPath,
    },
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(readyPath)) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the Bun MCP child");
    await Bun.sleep(5);
  }
  child.kill("SIGINT");
  while (!fs.existsSync(signalPath) || !fs.readFileSync(signalPath, "utf8").includes("SIGINT\n")) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for SIGINT forwarding");
    await Bun.sleep(5);
  }
  child.kill("SIGTERM");
  const exitCode = await child.exited;
  const stderr = await new Response(child.stderr).text();
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(fs.readFileSync(signalPath, "utf8")).toBe("SIGINT\nSIGTERM\n");
}, 15_000);

for (const runtime of ["node", "bun"] as const) {
  test(`${runtime} MCP launcher exits after SIGTERM with client stdin held open`, async () => {
    const { root, launcher } = installedPackage(`
      const fs = await import("node:fs");
      fs.appendFileSync(process.env.LLV_TEST_STARTS, "start\\n");
      process.once("SIGTERM", () => {
        fs.appendFileSync(process.env.LLV_TEST_SIGNALS, "SIGTERM\\n");
        process.exit(0);
      });
      setInterval(() => {}, 1_000);
    `);
    const starts = path.join(root, "starts");
    const signals = path.join(root, "signals");
    const node = Bun.which("node");
    const bun = Bun.which("bun");
    if (!node || !bun) throw new Error("Node and Bun are required for the launcher test");
    const launcherProcess = spawn(runtime === "node" ? node : bun, [launcher], {
      cwd: root,
      env: { ...process.env, LLV_BUN_EXECUTABLE: bun, LLV_TEST_STARTS: starts, LLV_TEST_SIGNALS: signals },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let outputClosed = false;
    launcherProcess.stdout.on("end", () => { outputClosed = true; });
    try {
      const readyDeadline = Date.now() + 5_000;
      while (!fs.existsSync(starts)) {
        if (Date.now() >= readyDeadline) throw new Error("timed out waiting for the MCP child");
        await Bun.sleep(5);
      }
      expect(launcherProcess.stdin.writableEnded).toBe(false);
      launcherProcess.kill("SIGTERM");
      const exited = new Promise<number | null>((resolve) => launcherProcess.once("close", resolve));
      const code = await Promise.race([
        exited,
        Bun.sleep(3_000).then(() => { throw new Error("MCP launcher did not exit after SIGTERM"); }),
      ]);
      expect(code).toBe(0);
      expect(outputClosed).toBe(true);
      expect(fs.readFileSync(signals, "utf8")).toBe("SIGTERM\n");
      expect(fs.readFileSync(starts, "utf8")).toBe("start\n");
    } finally {
      if (launcherProcess.exitCode === null && launcherProcess.signalCode === null) launcherProcess.kill("SIGKILL");
    }
  }, 10_000);
}

test("one stdio MCP session keeps its tools through endpoint loss and a newly published runtime", async () => {
  const { root, launcher } = installedPackage();
  const stateDir = path.join(root, "state");
  const targetFile = path.join(stateDir, "viewer-release.json");
  fs.mkdirSync(stateDir, { recursive: true });
  const endpoint = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
  const firstPort = endpoint.port!;
  const firstRevision = "1".repeat(40);
  const secondRevision = "2".repeat(40);
  function publish(revision: string, port: number) {
    const releaseId = `deploy-${revision}`;
    const bundle = `
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", async (chunk) => {
        buffer += chunk;
        while (buffer.includes("\\n")) {
          const at = buffer.indexOf("\\n");
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          const request = JSON.parse(line);
          if (request.id === undefined) continue;
          let result;
          if (request.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "viewer", version: "1" } };
          else if (request.method === "tools/list") result = { tools: [{ name: "release", description: "active release", inputSchema: { type: "object" } }] };
          else if (request.method === "tools/call") {
            if (request.params.name === "crash") process.exit(7);
            try {
              const response = await fetch("http://127.0.0.1:${port}/health");
              if (!response.ok) throw new Error("endpoint unavailable");
              result = { content: [{ type: "text", text: "${revision}" }] };
            } catch { result = { content: [{ type: "text", text: "endpoint unavailable; retry" }], isError: true }; }
          } else result = {};
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
        }
      });
    `;
    const releaseRoot = path.join(stateDir, "mcp-runtime", "releases", releaseId);
    fs.mkdirSync(path.join(releaseRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(releaseRoot, "dist", "mcp-server.mjs"), bundle);
    fs.writeFileSync(targetFile, JSON.stringify({
      revision, image: `viewer:${revision}`, container: "viewer-candidate", endpoint: `http://127.0.0.1:${port}`,
      mcpRuntime: { source: "managed", revision, releaseId, artifactDigest: createHash("sha256").update(bundle).digest("hex"), stagedAt: new Date().toISOString() },
    }));
  }
  publish(firstRevision, firstPort);
  const bun = process.execPath;
  const session = Bun.spawn({ cmd: [bun, launcher], cwd: root,
    env: { ...process.env, LLV_STATE_DIR: stateDir, LLV_VIEWER_DEPLOY_TARGET: targetFile, LLV_SPAWN_CAPABILITY: "A".repeat(43), LLV_BUN_EXECUTABLE: bun },
    stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = session.stdout.getReader();
  let buffered = "";
  async function responseFor(id: number): Promise<TestRpcResponse> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const at = buffered.indexOf("\n");
      if (at >= 0) {
        const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
        const message = JSON.parse(line);
        if (message.id === id) return message;
        continue;
      }
      const next = await Promise.race([reader.read(), Bun.sleep(5_000).then(() => { throw new Error("MCP response timed out"); })]);
      if (next.done) throw new Error("stdio MCP pipe closed");
      buffered += new TextDecoder().decode(next.value);
    }
    throw new Error("MCP response timed out");
  }
  function call(id: number, method: string, params: object = {}) {
    session.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return responseFor(id);
  }
  try {
    expect((await call(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })).result.serverInfo.name).toBe("viewer");
    session.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    expect((await call(2, "tools/list")).result.tools[0].name).toBe("release");
    expect((await call(3, "tools/call", { name: "release", arguments: {} })).result.content[0].text).toBe(firstRevision);
    endpoint.stop(true);
    expect((await call(4, "tools/call", { name: "release", arguments: {} })).result.isError).toBe(true);
    const successor = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
    try {
      publish(secondRevision, successor.port!);
      let recovered = false;
      for (let id = 5; id < 25; id++) {
        const answer = await call(id, "tools/call", { name: "release", arguments: {} });
        if (answer.result?.content?.[0]?.text === secondRevision) { recovered = true; break; }
        expect(answer.result?.isError).toBe(true);
        await Bun.sleep(50);
      }
      expect(recovered).toBe(true);
      expect((await call(25, "tools/list")).result.tools[0].name).toBe("release");
      expect((await call(26, "tools/call", { name: "crash", arguments: {} })).result.isError).toBe(true);
      let restarted = false;
      for (let id = 27; id < 47; id++) {
        const answer = await call(id, "tools/call", { name: "release", arguments: {} });
        if (answer.result?.content?.[0]?.text === secondRevision) { restarted = true; break; }
        expect(answer.result?.isError).toBe(true);
        await Bun.sleep(50);
      }
      expect(restarted).toBe(true);
      expect(session.exitCode).toBeNull();
    } finally { successor.stop(true); }
  } finally {
    session.stdin.end();
    await session.exited;
    reader.releaseLock();
  }
}, 20_000);
