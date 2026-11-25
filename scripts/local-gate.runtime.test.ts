import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeCheckTree, discover, NATIVE_GROUP, plan, runSteps, type Step } from "./local-gate";
import { createHookFixture, fixtureGitEnv } from "./local-gate.fixture";
import { nativeBatches } from "./verify-native-codex-runtime";
import { type ProcessIdentity } from "../src/lib/processIdentity";
import { stopFixtureIdentity } from "../src/lib/testing/fixtureProcess";
import configureNext from "../next.config";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import { createGateTestFixtures } from "./gateTest.fixture";
const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const owned: ProcessIdentity[] = [];
const { context, soon } = createGateTestFixtures(roots, owned);
afterEach(async () => {
  for (const identity of owned.splice(0)) await stopFixtureIdentity(identity);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("each runtime check tree preserves current source and owns its build output", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-runtime-tree-")); roots.push(dir);
  const source = path.join(dir, "source"); mkdirSync(source);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: source, env: fixtureGitEnv(), stdio: "pipe" });
  git("init", "-q");
  writeFileSync(path.join(source, "tracked.ts"), "old");
  writeFileSync(path.join(source, "deleted.ts"), "removed");
  writeFileSync(path.join(source, ".gitignore"), "node_modules/\n.next/\ndist/\n");
  git("add", ".");
  writeFileSync(path.join(source, "tracked.ts"), "current");
  rmSync(path.join(source, "deleted.ts"));
  writeFileSync(path.join(source, "untracked.ts"), "new");
  for (const leaf of ["node_modules", ".next", "dist"]) {
    mkdirSync(path.join(source, leaf)); writeFileSync(path.join(source, leaf, "sentinel"), "untouched");
  }
  const first = createRuntimeCheckTree(source, dir), second = createRuntimeCheckTree(source, dir);
  expect(first).not.toBe(second);
  for (const tree of [first, second]) {
    expect(readFileSync(path.join(tree, "tracked.ts"), "utf8")).toBe("current");
    expect(readFileSync(path.join(tree, "untracked.ts"), "utf8")).toBe("new");
    for (const leaf of ["deleted.ts", ".next", "dist"]) expect(existsSync(path.join(tree, leaf))).toBe(false);
    expect(readFileSync(path.join(tree, "node_modules", "sentinel"), "utf8")).toBe("untouched");
    mkdirSync(path.join(tree, ".next")); writeFileSync(path.join(tree, ".next", "lock"), "private lock");
  }
  expect(readFileSync(path.join(source, ".next", "sentinel"), "utf8")).toBe("untouched");
  expect(existsSync(path.join(source, ".next", "lock"))).toBe(false);
});

test.each([false, true])("build consumers execute in the prepared tree (grouped=%s)", async grouped => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-prepared-root-")); roots.push(dir);
  const tree = path.join(dir, "private"); mkdirSync(tree);
  writeFileSync(path.join(dir, "artifact"), "another build");
  const steps: Step[] = ["build", "consumer"].map(name => ({ name, command: [], ...(grouped ? { group: "runtime", lane: "runtime" } : {}) }));
  await runSteps("pre-push", steps, { root: dir, deadline: null, logDir: dir, say: () => {},
    prepare: step => ({ root: tree, env: process.env, command: [process.execPath, "-e", `
      import { readFileSync, realpathSync, writeFileSync } from "node:fs";
      if (realpathSync(process.cwd()) !== realpathSync(${JSON.stringify(tree)})) throw new Error("wrong build root");
      ${step.name === "build" ? 'writeFileSync("artifact", "this build");' : 'if (readFileSync("artifact", "utf8") !== "this build") throw new Error("foreign artifact");'}
    `] }),
  });
  expect(readFileSync(path.join(dir, "artifact"), "utf8")).toBe("another build");
  expect(readFileSync(path.join(tree, "artifact"), "utf8")).toBe("this build");
}, 20_000);
test("runtime builds own one full-project check with fresh Next validators", () => {
  const before = process.env.LLV_GATE_FULL_TYPES, options = process.env.NODE_OPTIONS;
  try {
    const steps = plan("pre-push", ["src/example.ts"], context({ runtime: true }));
    expect(steps.filter(step => step.command.includes("tsc"))).toHaveLength(0);
    expect(steps.filter(step => step.name === "Viewer build")).toHaveLength(1);
    expect(plan("pre-push", ["src/example.ts"], context()).filter(step => step.command.includes("tsc"))).toHaveLength(1);
    for (const marker of [undefined, "0", "1", "/another-checkout", process.cwd()]) {
      if (marker === undefined) delete process.env.LLV_GATE_FULL_TYPES;
      else process.env.LLV_GATE_FULL_TYPES = marker;
      const config = configureNext(PHASE_PRODUCTION_BUILD);
      expect(config.typescript?.ignoreBuildErrors).toBeUndefined();
      expect(config.typescript?.tsconfigPath).toBe(marker === process.cwd() ? "tsconfig.json" : "tsconfig.production.json");
      expect(configureNext(PHASE_DEVELOPMENT_SERVER).typescript?.tsconfigPath).toBeUndefined();
    }
  } finally {
    if (before === undefined) delete process.env.LLV_GATE_FULL_TYPES; else process.env.LLV_GATE_FULL_TYPES = before;
    if (options === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = options;
  }
});

test.each(["bin/guide.md", "src/runtime-host/guide.md"])("runtime prose plans execute without a types prerequisite: %s", async file => {
  for (const present of [false, true]) {
    const dir = mkdtempSync(path.join(tmpdir(), "gate-runtime-prose-")); roots.push(dir);
    mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
    for (const workflow of ["platform-tests.yml", "bun-runtime.yml"]) writeFileSync(path.join(dir, ".github/workflows", workflow), readFileSync(path.join(root, ".github/workflows", workflow)));
    if (present) { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), "Guide\n"); }
    const steps = plan("pre-push", [file], discover(dir, "HEAD", [file]));
    expect(steps.find(step => step.name === "types")).toBeUndefined();
    await runSteps("pre-push", steps, { root: dir, deadline: soon(10_000), logDir: dir, say: () => {},
      prepare: () => ({ env: process.env, command: [process.execPath, "-e", "process.exit(0)"] }),
    });
  }
});

test("cold runtime builds reject invalid dynamic route/page contracts and tooling errors", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-next-contracts-")); roots.push(dir);
  symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  for (const file of ["tsconfig.json", "tsconfig.production.json", "bin/envAlias.mjs", "public/audio/dictation-capture.js"])
    { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), readFileSync(path.join(root, file))); }
  writeFileSync(path.join(dir, "production.config.ts"), readFileSync(path.join(root, "next.config.ts")));
  // App-specific worker entries need the full repository. Keep production's
  // type configuration and disable those entries for this minimal app.
  // Keep this compiler-contract fixture independent of live upgrade reminders.
  writeFileSync(path.join(dir, "next.config.ts"), 'import configure from "./production.config"; export default (phase: string) => { const config = configure(phase); return { ...config, experimental: { ...config.experimental, agentUpgrade: false }, webpack: undefined }; };\n');
  mkdirSync(path.join(dir, "src/app/[slug]"), { recursive: true });
  mkdirSync(path.join(dir, "src/app/api/[slug]"), { recursive: true });
  mkdirSync(path.join(dir, "scripts"));
  writeFileSync(path.join(dir, "src/app/layout.tsx"), "export default function Layout({children}: {children: React.ReactNode}) { return <html><body>{children}</body></html> }\n");
  writeFileSync(path.join(dir, "package.json"), '{"private":true}');
  for (const kind of ["route", "page", "tooling", "valid"] as const) {
    rmSync(path.join(dir, ".next"), { recursive: true, force: true });
    writeFileSync(path.join(dir, "src/app/api/[slug]/route.ts"), kind === "route" ? 'export function GET() { return "invalid" }\n' : 'export function GET() { return new Response("valid") }\n');
    writeFileSync(path.join(dir, "src/app/[slug]/page.tsx"), kind === "page" ? 'export default function Page({params}: {params: {slug: string}}) { return <p>{params.slug}</p> }\n' : 'export default async function Page({params}: {params: Promise<{slug: string}>}) { return <p>{(await params).slug}</p> }\n');
    writeFileSync(path.join(dir, "scripts/tool.test.ts"), kind === "tooling" ? 'export const value: number = "invalid";\n' : 'export const value: number = 1;\n');
    const lines: string[] = [];
    const result = await runSteps("pre-push", [{ name: "Viewer build", command: [] }], { root: dir, deadline: soon(120_000), logDir: dir, say: line => lines.push(line),
      prepare: () => ({ env: { ...process.env, __NEXT_AGENT_UPGRADE: undefined, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", LLV_GATE_TYPES_CHECKED: "1", LLV_GATE_FULL_TYPES: realpathSync(dir) }, command: ["node", path.join(root, "node_modules/next/dist/bin/next"), "build", "--webpack"] }),
    }).then(() => null, (error: unknown) => error);
    expect(result === null, lines.join("\n")).toBe(kind === "valid");
    if (kind === "route" || kind === "page") expect(lines.join("\n")).toContain(".next/types/");
    if (kind === "tooling") expect(lines.join("\n")).toContain("scripts/tool.test.ts");
  }
}, 480_000);

test("fresh runtime hooks leave the full type check to the build and preserve its refusal", () => {
  const f = createHookFixture(root, roots);
  const cache = path.join(f.dir, "fixture-cache");
  const runtime = discover(root, "HEAD", ["Dockerfile"]);
  const binary = path.join(cache, "delegatus-gate/bun-9.9.9/node_modules/.bin/bun");
  mkdirSync(path.dirname(binary), { recursive: true });
  writeFileSync(binary, '#!/bin/bash\nif [[ "$1" == --version ]]; then echo 9.9.9; else exec "$HOOK_BUN" "$HOOK_RECORD" "$@"; fi\n', { mode: 0o755 });
  for (const version of runtime.codexVersions) {
    const target = process.arch === "x64" ? "x86_64" : "aarch64";
    const codex = path.join(cache, `delegatus-gate/codex-${version}/node_modules/@openai/codex-linux-${process.arch}/vendor/${target}-unknown-linux-musl/bin/codex`);
    mkdirSync(path.dirname(codex), { recursive: true }); writeFileSync(codex, "fixture");
  }
  for (const file of [...runtime.runtimeTests, "src/lib/mcp/answerSizes.test.ts"]) {
    mkdirSync(path.dirname(path.join(f.dir, file)), { recursive: true }); writeFileSync(path.join(f.dir, file), "// fixture\n");
  }
  writeFileSync(path.join(f.dir, "Dockerfile"), "RUN npm install -g bun@9.9.9\n");
  // The real recorder already captures every environment name without values.
  const env: NodeJS.ProcessEnv = { ...f.env, XDG_CACHE_HOME: cache, LLV_GATE_TYPES_CHECKED: "inherited" };
  for (const fails of [false, true, false]) {
    const before = existsSync(env.HOOK_LOG!) ? f.calls().length : 0;
    const result = spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env: { ...env, HOOK_FAIL: fails ? "build" : "" }, encoding: "utf8", timeout: 90_000 });
    expect(result.status, result.stderr).toBe(fails ? 1 : 0);
    const calls = f.calls().slice(before);
    expect(calls.filter(call => call.args[0] === "tsc")).toHaveLength(0);
    const builds = calls.filter(call => call.args[0] === "run" && call.args[1] === "build");
    expect(builds).toHaveLength(1);
    expect(calls.some(call => call.args[0] === "scripts/verify-viewer-runtime.ts")).toBe(!fails);
    for (const call of calls) {
      if (call.args[0] === "scripts/privacy-publication-gate.ts") continue;
      expect(call.names.includes("LLV_GATE_TYPES_CHECKED"), call.args.join(" ")).toBe(false);
      expect(call.names.includes("LLV_GATE_FULL_TYPES"), call.args.join(" ")).toBe(builds.includes(call));
    }
  }
}, 300_000);
test("scoped heavy steps retain pin, host interpreter and both native fixture versions", () => {
  const steps = plan("pre-push", ["package.json"], context({ linux: true, runtime: true, native: true }));
  expect(steps.some(step => step.name === "Linux backend")).toBeTrue();
  expect(steps.find(step => step.name === "Viewer build")!.pinned).toBeTrue();
  expect(steps.find(step => step.name === "runtime host")!.pinned).toBeTrue();
  expect(steps.find(step => step.name === "runtime negative controls")!.pinned).toBeTrue();
  expect(steps.filter(step => step.codex).map(step => step.codex)).toEqual(["0.154.0", "0.159.0"]);
  expect(steps.some(step => step.name === "supply chain")).toBeTrue();
  expect(plan("pre-push", ["src/example.ts"], context()).some(step => step.pinned)).toBeFalse();
});
test("native Codex runs its engine files once per version and its shared contracts once, as one group", () => {
  const steps = plan("pre-push", ["src/example.ts"], context({ native: true }));
  const native = steps.filter(step => step.name.startsWith(NATIVE_GROUP));
  expect(native.map(step => [step.name, step.codex, step.selection, step.deferrable === true])).toEqual([
    ["native Codex 0.154.0", "0.154.0", "--engine-only", false],
    ["native Codex 0.159.0", "0.159.0", "--engine-only", false],
    ["native Codex shared contracts", undefined, "--shared-only", true],
  ]);
  // One contiguous group: the runner starts all three at once.
  const first = steps.indexOf(native[0]!);
  expect(steps.slice(first, first + native.length)).toEqual(native);
  for (const step of native) expect(step).toMatchObject({ command: ["bun", "scripts/verify-native-codex-runtime.ts"], capped: true, isolated: true, pinned: true });
  expect(plan("pre-push", ["src/example.ts"], context()).some(step => step.name.startsWith(NATIVE_GROUP))).toBeFalse();
});
test("the engine and shared selections are exactly the hosted job's selection, split by who starts Codex", () => {
  const all = nativeBatches().flat(), engine = nativeBatches("--engine-only").flat(), shared = nativeBatches("--shared-only").flat();
  expect(new Set(all).size).toBe(all.length);
  expect([...engine, ...shared].sort()).toEqual([...all].sort());
  const startsCodex = /NATIVE_CODEX_QUEUE_TEST_BINARY|LLV_CODEX_HISTORY_CLI|LLV_CODEX_BINARY/;
  // A shared file that starts the executable would be judged under one
  // version only: it belongs in the engine lists.
  for (const file of shared) expect(readFileSync(path.join(root, file), "utf8"), file).not.toMatch(startsCodex);
  for (const file of engine) expect(readFileSync(path.join(root, file), "utf8"), file).toMatch(startsCodex);
});
test("the shared native runner needs no Codex fixture and exposes no executable to its tests", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-shared-native-")); roots.push(dir);
  const shared = nativeBatches("--shared-only").flat();
  for (const file of shared) {
    const target = path.join(dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `import { expect, test } from "bun:test";
      import { existsSync, writeFileSync } from "node:fs";
      import path from "node:path";
      test("shared contracts have no Codex executable", () => {
        for (const key of ["NATIVE_CODEX_QUEUE_TEST_BINARY", "LLV_CODEX_HISTORY_CLI", "LLV_CODEX_BINARY"])
          expect(process.env[key]).toBeUndefined();
        for (const [key, value] of Object.entries(${JSON.stringify(Object.fromEntries(["LLV_OWNED_RUN_CPU_SLICE", "LLV_OWNED_RUN_CPU_QUOTA", "LLV_GATE_MEM", "LLV_CPU_WAIT_ROOTS", "LLV_GATE_SLOT_LEASE", "LLV_GATE_STEP"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])))}))
          expect(process.env[key]).toBe(value);
        const marker = path.join(process.env.LLV_STATE_DIR!, "previous-file");
        expect(existsSync(marker)).toBe(false);
        writeFileSync(marker, "owned by this file");
      });`);
  }
  const result = spawnSync(process.execPath, [path.join(root, "scripts/verify-native-codex-runtime.ts"), "--shared-only"], {
    cwd: dir, env: { ...process.env, NATIVE_CODEX_QUEUE_TEST_BINARY: "inherited-fixture", LLV_CODEX_HISTORY_CLI: "inherited-fixture", LLV_CODEX_BINARY: "inherited-fixture" }, encoding: "utf8", timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect((result.stderr.match(/\(pass\) shared contracts have no Codex executable/g) ?? []).length).toBe(shared.length);
}, 40_000);

test("native engine and hosted selections still require an executable fixture", () => {
  for (const args of [[], ["--engine-only"], ["--steering-only"]]) {
    const result = spawnSync(process.execPath, [path.join(root, "scripts/verify-native-codex-runtime.ts"), ...args], {
      env: process.env, encoding: "utf8", timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Pass an absolute Codex fixture executable");
  }
});
