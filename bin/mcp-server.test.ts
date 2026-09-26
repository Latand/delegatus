import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appDirIn } from "./appDir.mjs";

const sandboxes: string[] = [];

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

test("the MCP launcher selects a published self-update, falls back to the checkout, and gives managed deploy precedence", async () => {
  const { root, launcher } = installedPackage("process.stdout.write('checkout:' + process.env.LLV_STATE_OWNER + '\\n');");
  const stateDir = path.join(root, "state");
  const cacheDir = path.join(root, "cache");
  const home = path.join(root, "home");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(cacheDir);
  fs.mkdirSync(home);
  git(root, "init", "--initial-branch=main");
  git(root, "add", ".");
  git(root, "commit", "-m", "checkout");
  const checkoutHead = git(root, "rev-parse", "HEAD");
  const installId = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
  const releaseRoot = path.join(appDirIn(cacheDir), "self-update", installId, "releases", "release");
  fs.mkdirSync(path.dirname(releaseRoot), { recursive: true });
  git(root, "worktree", "add", "-b", "release", releaseRoot);
  fs.mkdirSync(path.join(releaseRoot, ".next"));
  fs.writeFileSync(path.join(releaseRoot, ".next", "BUILD_ID"), "built\n");
  fs.writeFileSync(path.join(releaseRoot, "dist", "mcp-server.mjs"), "process.stdout.write('release:' + process.env.LLV_STATE_OWNER + '\\n');");
  git(releaseRoot, "add", ".");
  git(releaseRoot, "commit", "-m", "release");
  const sha = git(releaseRoot, "rev-parse", "HEAD");
  const pointer = path.join(stateDir, "self-update", `release-${installId}.json`);
  fs.mkdirSync(path.dirname(pointer), { recursive: true });
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: cacheDir,
    LLV_STATE_DIR: stateDir,
  };
  expect(await launchFrom(root, launcher, env, "", "bun"))
    .toEqual({ exitCode: 0, stdout: "checkout:mcp\n", stderr: "" });

  fs.writeFileSync(pointer, JSON.stringify({ sha, dir: releaseRoot, checkoutHead }));
  expect(await launchFrom(root, launcher, env, "", "bun"))
    .toEqual({ exitCode: 0, stdout: "release:mcp\n", stderr: "" });

  const managedRevision = "7".repeat(40);
  const managedId = `deploy-${managedRevision}`;
  const managedBundle = "process.stdout.write('managed\\n');";
  const managedRoot = path.join(stateDir, "mcp-runtime", "releases", managedId);
  fs.mkdirSync(path.join(managedRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(managedRoot, "dist", "mcp-server.mjs"), managedBundle);
  const target = path.join(stateDir, "viewer-release.json");
  fs.writeFileSync(target, JSON.stringify({
    revision: managedRevision,
    image: "viewer:managed",
    container: "viewer-managed",
    endpoint: "http://127.0.0.1:18001",
    mcpRuntime: {
      source: "managed",
      revision: managedRevision,
      releaseId: managedId,
      artifactDigest: createHash("sha256").update(managedBundle).digest("hex"),
      stagedAt: "2026-07-23T08:00:00.000Z",
    },
  }));
  expect(await launchFrom(root, launcher, env, "", "bun"))
    .toEqual({ exitCode: 0, stdout: "managed\n", stderr: "" });

  fs.rmSync(target);
  fs.rmSync(path.join(releaseRoot, "dist", "mcp-server.mjs"));
  expect(await launchFrom(root, launcher, env, "", "bun"))
    .toEqual({ exitCode: 0, stdout: "checkout:mcp\n", stderr: "" });
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
