import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assembleStandaloneRuntime } from "./package-standalone.mjs";
import { auditPackagedEntryImports, smokeMcp } from "./npm-package-smoke.mjs";

test("npm preserves assembled entries when Next traces the checkout ignore file", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "llv-standalone-pack-"));
  const standalone = path.join(work, "dist/standalone");
  const env = { PATH: process.env.PATH, HOME: work, XDG_CONFIG_HOME: path.join(work, "config"),
    LLV_STATE_DIR: path.join(work, "state"), TMPDIR: work, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
    npm_config_cache: path.join(work, "cache"), npm_config_prefix: path.join(work, "prefix") };
  const write = (name: string, contents: string) => {
    fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
    fs.writeFileSync(path.join(work, name), contents);
  };
  const command = (args: string[]) => {
    const run = Bun.spawnSync(args, { cwd: work, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    return run.stdout.toString();
  };
  try {
    write(".gitignore", "/dist\n/.next/\n/node_modules/\n.env*\n");
    write("package.json", JSON.stringify({ name: "fixture-standalone", version: "1.0.0", files: ["bin", "dist"], bin: { fixture: "bin/entry.mjs" } }));
    write("bin/entry.mjs", '#!/usr/bin/env bun\nimport "../dist/mcp-server.mjs";');
    write("dist/mcp-server.mjs", `import { createInterface } from "node:readline";
      createInterface({ input: process.stdin }).on("line", line => {
        const m = JSON.parse(line);
        if (m.id) console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "tools/list"
          ? { tools: [{ name: "fixture_tool" }] } : { protocolVersion: "2024-11-05", serverInfo: { name: "fixture" } } }));
      });`);
    for (const name of ["public/audio/cue.mp3", "vendor/fixture.txt", "dist/runtime-host.mjs", "dist/gate/owned-runner.ts", "dist/standalone/.next/server.js"]) write(name, "// fixture");
    write("dist/standalone/.gitignore", "/dist\n/.next/\n");
    write("dist/standalone/.env.local", "fixture configuration");
    write("dist/standalone/.next/cache/compiler.pack", "fixture compiler cache");
    await assembleStandaloneRuntime(work, standalone);
    // Without the assembly's override, real npm loses both deployment trees.
    fs.unlinkSync(path.join(standalone, ".npmignore"));
    const list = () => JSON.parse(command(["npm", "pack", "--ignore-scripts", "--dry-run", "--json"]))[0].files.map((file: { path: string }) => file.path);
    expect(list()).not.toContain("dist/standalone/dist/mcp-server.mjs");
    expect(list()).not.toContain("dist/standalone/.next/server.js");
    await assembleStandaloneRuntime(work, standalone);
    expect(list()).not.toContain("dist/standalone/.env.local");
    expect(list()).not.toContain("dist/standalone/.next/cache/compiler.pack");
    const packed = JSON.parse(command(["npm", "pack", "--ignore-scripts", "--json"]))[0].filename;
    command(["npm", "install", "--prefix", env.npm_config_prefix, "--ignore-scripts", "--no-audit", "--no-fund", path.join(work, packed)]);
    const installed = path.join(env.npm_config_prefix, "node_modules/fixture-standalone");
    expect(fs.readFileSync(path.join(installed, "dist/standalone/.next/server.js"), "utf8")).toBe("// fixture");
    expect(await auditPackagedEntryImports(installed)).toBe(6);
    expect(await smokeMcp(process.execPath, ["bin/entry.mjs"], { cwd: path.join(installed, "dist/standalone"), env }, 5_000)).toBe(1);
    fs.unlinkSync(path.join(installed, "dist/standalone/dist/mcp-server.mjs"));
    await expect(auditPackagedEntryImports(installed)).rejects.toThrow(/packaged (?:import|entry module) missing/);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}, 60_000);
