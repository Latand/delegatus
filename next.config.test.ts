import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import ts from "typescript";

import configureNext from "./next.config";

const nextConfig = configureNext(PHASE_DEVELOPMENT_SERVER);

test("the production config gives Next's TypeScript child enough heap", () => {
  const probe = fs.mkdtempSync(path.join(tmpdir(), "build-heap-"));
  try {
    const child = path.join(probe, "heap.cjs");
    fs.writeFileSync(child, 'console.log(JSON.stringify({ limit: require("node:v8").getHeapStatistics().heap_size_limit, warnings: process.env.NODE_OPTIONS.includes("--no-warnings") }))');
    const script = `
      const { default: loadConfig } = require('next/dist/server/config');
      const { PHASE_PRODUCTION_BUILD } = require('next/constants');
      const { runTypeScriptCli } = require('next/dist/lib/typescript/runTypeScriptCli');
      (async () => {
        const config = await loadConfig(PHASE_PRODUCTION_BUILD, process.cwd());
        if (config.typescript.ignoreBuildErrors) throw new Error('type checking is disabled');
        const child = await runTypeScriptCli({ cwd: process.cwd(), tscPath: process.argv[1], args: [], captureOutput: true });
        if (child.exitCode) throw new Error(child.stderr);
        console.log(JSON.stringify({ configPath: config.typescript.tsconfigPath, ...JSON.parse(child.stdout) }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    for (const heap of ["--max-old-space-size=4096", "--max_old_space_size=8192"]) {
      const result = spawnSync("node", ["-e", script, child], {
        cwd: import.meta.dir,
        env: { ...process.env, NODE_OPTIONS: `${heap} --no-warnings` },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      const observed = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      expect(observed.configPath).toBe("tsconfig.production.json");
      expect(observed.warnings).toBe(true);
      expect(observed.limit).toBeGreaterThanOrEqual((heap.includes("8192") ? 8192 : 6144) * 1024 * 1024);
    }
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}, 30_000);

test("production checks every source root while tooling retains the full repository check", () => {
  expect(nextConfig.typescript?.tsconfigPath).toBeUndefined();
  const parse = (file: string) => {
    const config = ts.readConfigFile(path.join(import.meta.dir, file), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, import.meta.dir);
    expect(parsed.errors).toEqual([]);
    return parsed.fileNames.map(file => path.relative(import.meta.dir, file).split(path.sep).join("/"));
  };
  const full = parse("tsconfig.json");
  const production = parse("tsconfig.production.json");
  expect(full).toContain("next.config.test.ts");
  expect(full).toContain("scripts/build-mcp.ts");
  expect(production).toContain("src/runtime-host/main.ts");
  expect(production).toContain("src/instrumentation.ts");
  expect(production).toContain("src/app/page.tsx");
  expect(production.filter(file => /\.(test|spec)\./.test(file))).toEqual([]);
  expect(production.filter(file => /^(docs|scripts|evals|spikes)\//.test(file))).toEqual([]);
  for (const file of full.filter(file => file.startsWith("src/") && !/\.(test|spec)\.|\/__(tests|mocks)__\//.test(file))) {
    expect(production).toContain(file);
  }
});

test("the production TypeScript check rejects an error in an imported file outside its roots", () => {
  const probe = fs.mkdtempSync(path.join(tmpdir(), "build-types-"));
  try {
    for (const file of ["tsconfig.json", "tsconfig.production.json"]) {
      fs.copyFileSync(path.join(import.meta.dir, file), path.join(probe, file));
    }
    fs.mkdirSync(path.join(probe, "src"));
    fs.mkdirSync(path.join(probe, "shared"));
    fs.writeFileSync(path.join(probe, "src", "entry.ts"), 'import "../shared/value";');
    fs.writeFileSync(path.join(probe, "shared", "value.ts"), 'export const value: string = 42;');
    fs.writeFileSync(path.join(probe, "src", "entry.test.ts"), 'const testOnly: string = 42;');
    const result = spawnSync("node", [
      require.resolve("typescript/bin/tsc"), "-p", path.join(probe, "tsconfig.production.json"), "--incremental", "false",
    ], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("shared/value.ts");
    expect(result.stdout).toContain("TS2322");
    expect(result.stdout).not.toContain("entry.test.ts");
    fs.writeFileSync(path.join(probe, "shared", "value.ts"), 'export const value: string = "ok";');
    const green = spawnSync("node", [
      require.resolve("typescript/bin/tsc"), "-p", path.join(probe, "tsconfig.production.json"), "--incremental", "false",
    ], { encoding: "utf8" });
    expect(green.status, green.stdout + green.stderr).toBe(0);
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}, 30_000);

test("every library worker is bundled and traced into standalone output", async () => {
  const workerFiles = fs.readdirSync(path.join(import.meta.dir, "src/lib"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".worker.ts"))
    .map((entry) => entry.name)
    .sort();

  if (!nextConfig.webpack) throw new Error("next config has no webpack hook");
  const configured = nextConfig.webpack(
    { entry: {} },
    { isServer: true, nextRuntime: "nodejs" } as Parameters<NonNullable<typeof nextConfig.webpack>>[1],
  );
  if (typeof configured.entry !== "function") throw new Error("webpack entries are not configurable");
  const entries = await configured.entry();
  const tracingIncludes = nextConfig.outputFileTracingIncludes?.["/*"] ?? [];

  expect(workerFiles.length).toBeGreaterThan(0);
  expect(tracingIncludes).toContain(".next/server/chunks/**");
  for (const workerFile of workerFiles) {
    const source = `./src/lib/${workerFile}`;
    const workerEntry = Object.entries(entries).find(([, entry]) => entry === source);
    if (!workerEntry) throw new Error(`${workerFile} has no webpack entry`);
    expect(
      tracingIncludes,
      `${workerFile} has no standalone tracing include`,
    ).toContain(`.next/server/${workerEntry[0]}.js`);
  }
});
