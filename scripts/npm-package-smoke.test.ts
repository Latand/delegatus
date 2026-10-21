import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { stop, signalRuntimeHost, smokeMcp, auditStandaloneAssets } from "./npm-package-smoke.mjs";
import { captureProcessIdentity, processIdentityStatus } from "../src/lib/processIdentity";
import { stopFixtureProcess } from "../src/lib/testing/fixtureProcess";

test("MCP package smoke requires initialize followed by a non-empty real tools/list", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "llv-package-protocol-"));
  const env = { PATH: process.env.PATH, HOME: work, XDG_CONFIG_HOME: work, TMPDIR: work, LLV_STATE_DIR: work, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" };
  const source = (mode: string) => `
    const { createInterface } = require('node:readline');
    let initialized = false;
    createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      const send = result => console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      if (m.method === 'initialize') send({ protocolVersion: '2024-11-05', serverInfo: { name: 'fixture' } });
      if (m.method === 'notifications/initialized') initialized = true;
      if (m.method === 'tools/list') {
        if (!initialized) process.exit(2);
        if (${JSON.stringify(mode)} === 'exit') process.exit(3);
        if (${JSON.stringify(mode)} === 'hang') return;
        if (${JSON.stringify(mode)} === 'malformed') { console.log('broken'); return; }
        if (${JSON.stringify(mode)} === 'error') { console.log(JSON.stringify({ id: m.id, error: { message: 'refused' } })); return; }
        send({ tools: ${mode === "empty" ? "[]" : "[{ name: 'fixture_tool' }]"} });
      }
    });
  `;
  try {
    await expect(smokeMcp(path.join(work, "absent"), [], { env }, 5_000)).rejects.toThrow("ENOENT");
    expect(await smokeMcp(process.execPath, ["-e", source("ok")], { env }, 5_000)).toBe(1);
    for (const [mode, expected] of [["empty", "no valid tools"], ["exit", "exited before tools/list"], ["malformed", "non-JSON"], ["error", "request 2 failed"], ["hang", "timed out"]]) {
      await expect(smokeMcp(process.execPath, ["-e", source(mode!)], { env }, mode === "hang" ? 500 : 5_000)).rejects.toThrow(expected!);
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}, 15_000);

test("standalone audit covers every public asset and launcher dependency byte", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "llv-package-assets-"));
  const standalone = path.join(work, "dist", "standalone");
  const files = ["public/audio/cues/launch.mp3", "public/audio/ambient/loop.wav", "public/question-push-sw.js", "bin/mcp-server.mjs", "bin/envAlias.mjs", "vendor/connector/entry.py", "dist/gate/owned-runner.ts", "dist/mcp-server.mjs", "dist/runtime-host.mjs"];
  try {
    for (const name of files) {
      for (const base of [work, standalone]) {
        fs.mkdirSync(path.dirname(path.join(base, name)), { recursive: true });
        fs.writeFileSync(path.join(base, name), `fixture ${name}`);
      }
    }
    expect(await auditStandaloneAssets(work, work)).toBe(files.length);
    for (const name of files) {
      fs.writeFileSync(path.join(standalone, name), "changed");
      await expect(auditStandaloneAssets(work, work)).rejects.toThrow(/differs/);
      fs.writeFileSync(path.join(standalone, name), `fixture ${name}`);
      fs.unlinkSync(path.join(standalone, name));
      await expect(auditStandaloneAssets(work, work)).rejects.toThrow();
      fs.writeFileSync(path.join(standalone, name), `fixture ${name}`);
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test("required package smoke refuses an absent standalone build", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "llv-package-required-"));
  try {
    fs.mkdirSync(path.join(work, "scripts"));
    fs.copyFileSync(path.join(import.meta.dir, "npm-package-smoke.mjs"), path.join(work, "scripts", "npm-package-smoke.mjs"));
    fs.cpSync(path.join(import.meta.dir, "..", "bin"), path.join(work, "bin"), { recursive: true });
    const result = Bun.spawnSync([process.execPath, "scripts/npm-package-smoke.mjs", "--mcp-assets"], {
      cwd: work, env: { PATH: process.env.PATH, HOME: work, XDG_CONFIG_HOME: work, TMPDIR: work, LLV_STATE_DIR: path.join(work, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("requires a standalone build");
    expect(result.stdout.toString()).not.toContain("SKIP");
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test("package smoke stop refuses an exited child without signalling its old group", async () => {
  const signals: unknown[] = [];
  for (const ended of [{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: "SIGTERM" }]) {
    await stop({ ...ended, pid: 999, kill: (signal: unknown) => signals.push(signal) } as unknown as ChildProcess);
  }
  expect(signals).toEqual([]);
});

test("package smoke restart refuses a reused or missing runtime-host identity", () => {
  const signals: unknown[] = [];
  const send = (pid: number, signal?: string | number): true => { signals.push([pid, signal]); return true; };
  const original = { pid: 999, startIdentity: "999:original" };
  expect(signalRuntimeHost(original, "SIGTERM", () => "999:reused", send)).toBe(false);
  expect(signalRuntimeHost(original, "SIGTERM", () => null, send)).toBe(false);
  expect(signalRuntimeHost({ ...original, startIdentity: null }, "SIGTERM", () => null, send)).toBe(false);
  expect(signals).toEqual([]);
  expect(signalRuntimeHost(original, "SIGTERM", () => original.startIdentity, send)).toBe(true);
  expect(signals).toEqual([[999, "SIGTERM"]]);
});

test("package smoke stop escalates only its original handle and preserves a same-argv bystander", async () => {
  const argv = ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"];
  const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "ignore"], detached: true });
  const identity = captureProcessIdentity(child.pid!);
  const bystander = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "ignore"], detached: true });
  const other = captureProcessIdentity(bystander.pid!);
  const ready = (handle: ChildProcess) => new Promise<void>((resolve, reject) => {
    handle.once("error", reject);
    handle.stdout!.once("data", () => resolve());
  });
  try {
    await Promise.all([ready(child), ready(bystander)]);
    await stop(child, 50, 1_000);
    expect(child.signalCode).toBe("SIGKILL");
    expect(processIdentityStatus(identity)).toBe("dead");
    expect(processIdentityStatus(other)).toBe("alive");
    await stop(child);
    expect(processIdentityStatus(other)).toBe("alive");
  } finally {
    await stopFixtureProcess(child, 50);
    await stopFixtureProcess(bystander, 50);
  }
}, 5_000);

test("the packed standalone server starts with every worker available", async () => {
  const nodeSearchPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((directory) => !path.basename(directory).startsWith("bun-node-"))
    .join(path.delimiter);
  const nodeExecutable = Bun.which("node", { PATH: nodeSearchPath });
  if (!nodeExecutable) throw new Error("the npm package smoke requires Node");
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "npm-package-smoke.mjs")], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: { ...process.env, LLV_NODE_EXECUTABLE: nodeExecutable },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode, `${stdout}\n${stderr}`.trim()).toBe(0);
}, 150_000);

test("all five bins of the packed package run, and the legacy names say so on stderr only", async () => {
  /* rename-delegatus.md §3.3. Packed with --ignore-scripts so this runs without
     the standalone build; the MCP server bundle is replaced by a stub that
     answers one JSON-RPC frame, because what is under test is what the
     launchers write around it. */
  const root = path.resolve(import.meta.dir, "..");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "llv-package-bins-"));
  try {
    const packed = Bun.spawnSync({
      cmd: ["npm", "pack", "--ignore-scripts", "--silent", "--pack-destination", work],
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: work, npm_config_cache: path.join(work, "npm-cache") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(packed.exitCode, packed.stderr.toString()).toBe(0);
    const tarball = fs.readdirSync(work).find((name) => name.endsWith(".tgz"))!;
    expect(tarball).toStartWith("delegatus-cli-");
    const extract = path.join(work, "extract");
    fs.mkdirSync(extract);
    expect(Bun.spawnSync({ cmd: ["tar", "-xzf", path.join(work, tarball), "-C", extract] }).exitCode).toBe(0);
    const pkg = path.join(extract, "package");
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")) as { name: string; version: string; bin: Record<string, string> };
    expect(manifest.name).toBe("delegatus-cli");
    /* `bunx delegatus-cli` runs the FIRST bin of a package none of whose bins
       is named after it (observed on Bun 1.4.0), so the order is the contract. */
    expect(Object.keys(manifest.bin)).toEqual(["delegatus", "dlg", "delegatus-mcp", "agent-log-viewer", "agent-log-viewer-mcp"]);
    for (const target of Object.values(manifest.bin)) expect(fs.existsSync(path.join(pkg, target))).toBeTrue();

    fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "dist", "mcp-server.mjs"), `
      process.stdin.once("data", () => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "viewer" } } }) + "\\n");
        process.exit(0);
      });
    `);
    const node = Bun.which("node");
    const bun = Bun.which("bun");
    if (!node || !bun) throw new Error("Node and Bun are required for the bin smoke");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: path.join(work, "home"),
      XDG_CONFIG_HOME: path.join(work, "config"),
      LLV_STATE_DIR: path.join(work, "state"),
      LLV_BUN_EXECUTABLE: bun,
      TMPDIR: work,
    };
    const run = (bin: string, args: string[], stdin?: string) => {
      const child = Bun.spawnSync({
        cmd: [node, path.join(pkg, manifest.bin[bin]!), ...args],
        cwd: pkg,
        env,
        stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      return { status: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
    };

    for (const bin of ["delegatus", "dlg", "agent-log-viewer"]) {
      const version = run(bin, ["--version"]);
      expect(version.status, version.stderr).toBe(0);
      expect(version.stdout.trim()).toBe(manifest.version);
      const notices = version.stderr.split("\n").filter((line) => line.includes("is now delegatus"));
      expect(notices).toHaveLength(bin === "agent-log-viewer" ? 1 : 0);
      expect(run(bin, ["--help"]).stdout).toContain("Usage: delegatus");
    }

    const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";
    for (const bin of ["delegatus-mcp", "agent-log-viewer-mcp"]) {
      const mcp = run(bin, [], initialize);
      expect(mcp.status, mcp.stderr).toBe(0);
      /* stdout is the protocol channel: its first byte is the first frame's. */
      expect(mcp.stdout.startsWith('{"jsonrpc":"2.0","id":1,')).toBeTrue();
      expect(mcp.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "viewer" } } },
        { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
      ]);
      const notices = mcp.stderr.split("\n").filter((line) => line.includes("is now delegatus"));
      expect(notices).toHaveLength(bin === "agent-log-viewer-mcp" ? 1 : 0);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}, 150_000);
