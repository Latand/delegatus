import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { checkSource } from "./check-source";
import { fixtureGitEnv } from "./local-gate.fixture";

const roots: string[] = [], children: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && !child.signalCode) { child.kill(); await child.exited; }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.each([0, 1])("a source check removes its export immediately after command exit %s", async code => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-check-fixture-")); roots.push(root);
  const source = path.join(root, "source"), observed = path.join(root, "observed.json"); fs.mkdirSync(source);
  execFileSync("git", ["init", "-q"], { cwd: source, env: fixtureGitEnv() });
  fs.writeFileSync(path.join(source, "input.txt"), "current input");
  fs.mkdirSync(path.join(source, "node_modules"));
  fs.writeFileSync(path.join(source, "node_modules", "dependency.txt"), "shared dependency");
  fs.writeFileSync(path.join(source, ".gitignore"), "node_modules/\n");
  const command = [process.execPath, "-e", `
    const fs = require('node:fs');
    if (fs.readFileSync('input.txt', 'utf8') !== 'current input') throw new Error('missing input');
    if (fs.readFileSync('node_modules/dependency.txt', 'utf8') !== 'shared dependency') throw new Error('missing dependency');
    fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ cwd: process.cwd(), env: Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "LLV_STATE_DIR", "TMPDIR", "LLV_STATE_OWNER", "LLV_OWNED_RUN_COMPLETION_RECEIPT", "LLV_OWNED_RUN_COMPLETION_TOKEN", "NODE_ENV", "LLV_VIEWER_CONTROL_URL"].map(key => [key, process.env[key]])) }));
    process.exitCode = ${code};
  `];
  if (code) await expect(checkSource(source, command)).rejects.toThrow("failed (1)");
  else await checkSource(source, command);
  const result = JSON.parse(fs.readFileSync(observed, "utf8"));
  expect(fs.existsSync(result.cwd)).toBeFalse();
  expect(fs.readFileSync(path.join(source, "node_modules", "dependency.txt"), "utf8")).toBe("shared dependency");
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "LLV_STATE_DIR", "TMPDIR"])
    expect(result.env[key]).toStartWith(path.dirname(result.cwd) + path.sep);
  expect(result.env.LLV_STATE_OWNER).toBeUndefined(); expect(result.env.NODE_ENV).toBe("test");
  expect(result.env.LLV_OWNED_RUN_COMPLETION_RECEIPT).toBeUndefined(); expect(result.env.LLV_OWNED_RUN_COMPLETION_TOKEN).toBeUndefined();
  expect(result.env.LLV_VIEWER_CONTROL_URL).toBe("http://127.0.0.1:1");
}, 30_000);

test.skipIf(process.platform === "win32")("keeps a source export until its active consumer finishes after supervisor loss", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-check-supervisor-fixture-")); roots.push(root);
  const source = path.join(root, "source"), ready = path.join(root, "ready.json"), finished = path.join(root, "finished.json");
  fs.mkdirSync(source); execFileSync("git", ["init", "-q"], { cwd: source, env: fixtureGitEnv() });
  fs.writeFileSync(path.join(source, "input.txt"), "source retained until command exit");
  const command = [process.execPath, "-e", `
    require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ supervisor: process.ppid, cwd: process.cwd() }));
    setTimeout(() => {}, 30_000);
  `];
  const consumer = Bun.spawn([process.execPath, "-e", `
    const fs = require('node:fs'), path = require('node:path');
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(${JSON.stringify(ready)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    const started = JSON.parse(fs.readFileSync(${JSON.stringify(ready)}, 'utf8'));
    setTimeout(() => fs.writeFileSync(${JSON.stringify(finished)}, JSON.stringify({
      exportExists: fs.existsSync(started.cwd), input: fs.readFileSync(path.join(started.cwd, 'input.txt'), 'utf8')
    })), 1200);
  `], { stdout: "ignore", stderr: "pipe" });
  children.push(consumer);
  const checking = checkSource(source, command);
  const waitFor = async (file: string) => {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(file) && Date.now() < deadline) await Bun.sleep(20);
    expect(fs.existsSync(file)).toBeTrue();
    return JSON.parse(fs.readFileSync(file, "utf8"));
  };
  const started = await waitFor(ready);
  roots.push(path.dirname(started.cwd));
  process.kill(started.supervisor, "SIGKILL");
  await expect(checking).rejects.toThrow("completion is unconfirmed");
  expect(fs.existsSync(started.cwd)).toBeTrue();
  const result = await waitFor(finished);
  expect(result).toEqual({ exportExists: true, input: "source retained until command exit" });
  expect(await consumer.exited).toBe(0);
}, 30_000);

test.skipIf(process.platform === "win32")("keeps a source export when its supervisor exits 1 before the command settles", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-check-exit1-fixture-")); roots.push(root);
  const source = path.join(root, "source"), ready = path.join(root, "ready.json"), finished = path.join(root, "finished.json");
  fs.mkdirSync(source); execFileSync("git", ["init", "-q"], { cwd: source, env: fixtureGitEnv() });
  fs.writeFileSync(path.join(source, "input.txt"), "source retained until command exit");
  const preload = path.join(root, "supervisor-exit.cjs");
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    if (process.argv.some(value => value.endsWith('/owned-runner.ts')) && !process.argv.includes('--service')) {
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(ready)})) { clearInterval(timer); process.exit(1); }
      }, 10);
    }
  `);
  const consumer = Bun.spawn([process.execPath, "-e", `
    const fs = require('node:fs'), path = require('node:path');
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(${JSON.stringify(ready)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    const started = JSON.parse(fs.readFileSync(${JSON.stringify(ready)}, 'utf8'));
    setTimeout(() => fs.writeFileSync(${JSON.stringify(finished)}, JSON.stringify({
      exportExists: fs.existsSync(started.cwd), input: fs.readFileSync(path.join(started.cwd, 'input.txt'), 'utf8')
    })), 1200);
  `], { stdout: "ignore", stderr: "pipe" });
  children.push(consumer);
  const originalOptions = process.env.BUN_OPTIONS;
  process.env.BUN_OPTIONS = [originalOptions, `--preload=${preload}`].filter(Boolean).join(" ");
  try {
    const command = [process.execPath, "-e", `
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ cwd: process.cwd() }));
      setTimeout(() => {}, 30_000);
    `];
    const checking = checkSource(source, command).then(() => null, error => error);
    const waitFor = async (file: string) => {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(file) && Date.now() < deadline) await Bun.sleep(20);
      expect(fs.existsSync(file)).toBeTrue();
      return JSON.parse(fs.readFileSync(file, "utf8"));
    };
    const started = await waitFor(ready);
    roots.push(path.dirname(started.cwd));
    expect(String(await checking)).toContain("completion is unconfirmed");
    expect(fs.existsSync(started.cwd)).toBeTrue();
    expect(await waitFor(finished)).toEqual({ exportExists: true, input: "source retained until command exit" });
    expect(await consumer.exited).toBe(0);
  } finally {
    if (originalOptions === undefined) delete process.env.BUN_OPTIONS;
    else process.env.BUN_OPTIONS = originalOptions;
  }
}, 30_000);
