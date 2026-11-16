import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { checkSource } from "./check-source";
import { fixtureGitEnv } from "./local-gate.fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

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
    fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ cwd: process.cwd(), env: Object.fromEntries(["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "LLV_STATE_DIR", "TMPDIR", "LLV_STATE_OWNER", "NODE_ENV", "LLV_VIEWER_CONTROL_URL"].map(key => [key, process.env[key]])) }));
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
  expect(result.env.LLV_VIEWER_CONTROL_URL).toBe("http://127.0.0.1:1");
}, 30_000);
