import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexFixture, createRuntimeCheckTree, discover, endingOf, fetchMain, isolatedEnvironment, NATIVE_GROUP, NoVerdict, pinnedBunVersion, plan, pushDeadline, runAdmittedChecks, runSteps, supervisorTimeoutMs, viewerBuildEnvironment, type Step } from "./local-gate";
import { createHookFixture, fixtureGitEnv } from "./local-gate.fixture";
import { cpuWaitBudget } from "../src/lib/runtime/cpuAdmissionBudget";
import { nativeBatches } from "./verify-native-codex-runtime";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { stopFixtureIdentity } from "../src/lib/testing/fixtureProcess";
import { publicationHookDeadline, publicationPushBudgetMs } from "../src/lib/pipelines/gateBudget";
import configureNext from "../next.config";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import { publicationDeadlineOnly } from "../src/lib/pipelines/publication";
import { createGateTestFixtures } from "./gateTest.fixture";
const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const owned: ProcessIdentity[] = [];
const { recordFixtureIdentities, context, stepRunner, grouped, soon } = createGateTestFixtures(roots, owned);
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
test("commit plan checks staged whitespace/lint and leaves types and tests to push", () => {
  const steps = plan("pre-commit", ["src/example.ts"], context());
  expect(steps.map(step => step.name)).toEqual(["staged whitespace", "eslint"]);
  expect(steps[1]!.command).toEqual(["bun", "scripts/eslint-changes.ts", "--base", "base", "./src/example.ts"]);
  expect(steps[1]!.capped).toBeFalse();
});
test("push checks commits, types and all sibling test variants, excluding browsers and deleted files", () => {
  const steps = plan("pre-push", ["src/example.ts", "src/deleted.test.ts"], context());
  expect(steps.find(step => step.name === "privacy")!.command).toContain("--check-commits");
  const tests = steps.find(step => step.name === "touched tests")!;
  expect(tests.command).toEqual(["bun", "scripts/local-gate-tests.ts", "--base", "base", "./src/example.test.ts", "./src/example.integration.test.ts"]);
  expect(tests.isolated).toBeTrue();
  for (const step of steps.filter(step => step.command[1] === "test")) for (const file of step.command.slice(2)) expect(file).toMatch(/\.test\.[jt]sx?$/);
});
test("the measured pipeline file families reserve comparison time without changing selection", () => {
  const now = 1_000;
  for (const file of ["src/lib/pipelines/engine.ts", "src/lib/pipelines/engine.fixture.ts", "src/lib/pipelines/engine.providerBudget.test.ts", "src/lib/pipelines/git.ts", "src/lib/pipelines/parkedPublication.test.ts"]) {
    expect(publicationPushBudgetMs([file]), file).toBe(1_500_000);
    expect(publicationHookDeadline(publicationPushBudgetMs([file]), now)).toBe(1_441_000);
  }
  for (const files of [[], ["docs/pipelines.md"], ["src/engine.ts"], ["prefix/src/lib/pipelines/engine.ts"], ["src/lib/pipelines/engine.ts/other.ts"]]) {
    expect(publicationPushBudgetMs(files)).toBe(900_000);
    expect(publicationHookDeadline(publicationPushBudgetMs(files), now)).toBe(841_000);
  }
  for (const file of ["Dockerfile", "bin/cli.mjs", "src/runtime-host/main.ts"]) expect(publicationPushBudgetMs([file])).toBe(1_800_000);
  expect(publicationPushBudgetMs(null)).toBe(1_800_000);
  const tests = Array.from({ length: 27 }, (_, index) => `src/lib/pipelines/engine.variant${index}.test.ts`);
  const file = "src/lib/pipelines/engine.ts";
  const step = plan("pre-push", [file], context({ existing: new Set([file]), tests })).find(step => step.name === "touched tests")!;
  expect(step.command.slice(4)).toEqual(tests.map(file => `./${file}`));
});

test.each([undefined, "8G", "20G"])("Viewer build memory budget preserves caller overrides: %s", memory => {
  const input: NodeJS.ProcessEnv = { NODE_ENV: "test", LLV_GATE_MEM: memory, NODE_OPTIONS: "--no-warnings" };
  const env = viewerBuildEnvironment(input);
  expect(env).toMatchObject({ NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_RUNTIME_UI: "1",
    LLV_GATE_MEM: memory ?? "14G", NODE_OPTIONS: "--no-warnings" });
  expect(input).toEqual({ NODE_ENV: "test", LLV_GATE_MEM: memory, NODE_OPTIONS: "--no-warnings" });
});

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
  for (const file of ["tsconfig.json", "tsconfig.production.json", "bin/envAlias.mjs"])
    { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), readFileSync(path.join(root, file))); }
  writeFileSync(path.join(dir, "production.config.ts"), readFileSync(path.join(root, "next.config.ts")));
  // App-specific worker entries need the full repository. Keep production's
  // type configuration and disable those entries for this minimal app.
  writeFileSync(path.join(dir, "next.config.ts"), 'import configure from "./production.config"; export default (phase: string) => ({ ...configure(phase), webpack: undefined });\n');
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
      prepare: () => ({ env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", LLV_GATE_TYPES_CHECKED: "1", LLV_GATE_FULL_TYPES: realpathSync(dir) }, command: ["node", path.join(root, "node_modules/next/dist/bin/next"), "build", "--webpack"] }),
    }).then(() => null, (error: unknown) => error);
    expect(result === null, lines.join("\n")).toBe(kind === "valid");
    if (kind === "route" || kind === "page") expect(lines.join("\n")).toContain(".next/types/");
    if (kind === "tooling") expect(lines.join("\n")).toContain("scripts/tool.test.ts");
  }
}, 480_000);

test("supervision covers the remaining execution budget and completed CPU wait with cleanup margin", () => {
  const budget = cpuWaitBudget({ NODE_ENV: "test" });
  try {
    const ledger = JSON.parse(budget.env.LLV_CPU_WAIT_ROOTS!)[0];
    writeFileSync(path.join(ledger, "queue.json"), JSON.stringify({ start: 100, end: 600 }));
    // A stale inherited cap must not govern the next child.
    expect(supervisorTimeoutMs(1000, { ...budget.env, LLV_OWNED_RUN_TIMEOUT_MS: "1" }, 800)).toBe(30_700);
    expect(supervisorTimeoutMs(1000, { NODE_ENV: "test" }, 800)).toBe(30_200);
    expect(supervisorTimeoutMs(1000, { NODE_ENV: "test" }, 1200)).toBe(30_001);
    expect(publicationHookDeadline(publicationPushBudgetMs(["Dockerfile"]), 0)).toBeGreaterThan(894_000);
    expect(publicationHookDeadline(publicationPushBudgetMs(["scripts/example.ts"]), 0)).toBeGreaterThan(562_000);
  } finally { budget.close(); }
});

test("a phase child receives its current allowance instead of a stale inherited supervisor cap", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-supervisor-cap-")); roots.push(dir);
  const record = path.join(dir, "allowance");
  const now = Date.now;
  Date.now = () => 1000;
  try {
    await runSteps("pre-push", [{ name: "types", command: [] }], {
      root: dir, deadline: { startedAt: 1000, at: 2000 }, logDir: dir, say: () => {},
      prepare: () => ({ env: { ...process.env, LLV_OWNED_RUN_TIMEOUT_MS: "1" }, command: [process.execPath, "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(record)}, process.env.LLV_OWNED_RUN_TIMEOUT_MS);`] }),
    });
    expect(readFileSync(record, "utf8")).toBe("31000");
  } finally { Date.now = now; }
});

test.each([0, 1, 124])("a fresh admitted runner preserves success, refusal and deadline outcomes (%s)", async code => {
  const deadline = soon(10_000);
  const outcome = await runAdmittedChecks(["bash", "-c", `exit ${code}`], root, process.env, deadline).then(() => null, (error: unknown) => error);
  if (code === 0) expect(outcome).toBeNull();
  else if (code === 124) {
    expect(outcome).toBeInstanceOf(NoVerdict);
    expect(endingOf("pre-push", outcome).code).toBe(75);
    expect(endingOf("pre-push", outcome).line).toContain('"push checks"');
  } else expect(outcome).not.toBeInstanceOf(NoVerdict);
});

test.each([false, true])("a phase runner's deadline status remains retryable (grouped: %s)", async grouped => {
  const runner = stepRunner(soon(10_000), () => ({ types: "exit 124" }));
  const error = await runner.run([{ name: "types", command: [], ...(grouped ? { group: "push checks" } : {}) }]);
  expect(error).toBeInstanceOf(NoVerdict);
  expect(endingOf("pre-push", error).code).toBe(75);
  expect(endingOf("pre-push", error).line).toContain('"types"');
});

for (const grouped of [false, true]) test.each(["pure", "assertion", "cleanup"] as const)(`owned timeout retains earlier refusal evidence (grouped: ${grouped}): %s`, async kind => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-deadline-evidence-")); roots.push(dir);
  const subject = path.join(dir, "pending.test.ts");
  writeFileSync(subject, `import { test, expect } from "bun:test";
    test("first result", () => { ${kind === "assertion" ? "expect(1).toBe(2);" : kind === "cleanup" ? 'console.error("owned runner: budget cleanup failed: fixture refusal");' : "expect(1).toBe(1);"} });
    test("pending result", async () => { setInterval(() => {}, 1000); await new Promise(() => {}); }, 60000);`);
  const lines: string[] = [];
  const error = await runSteps("pre-push", [{ name: "types", command: [], ...(grouped ? { group: "checks" } : {}) }], {
    root: dir, deadline: soon(20_000), logDir: dir, say: line => lines.push(line),
    prepare: () => ({ env: process.env, command: [process.execPath, path.join(root, "scripts/owned-runner.ts"), "--budget", "3000", process.execPath, "test", subject] }),
  }).then(() => null, (error: unknown) => error);
  const ending = endingOf("pre-push", error);
  expect(ending.code, lines.join("\n")).toBe(kind === "pure" ? 75 : 1);
  expect(publicationDeadlineOnly([...lines, ending.line].join("\n"))).toBe(kind === "pure");
}, 30_000);

test.skipIf(process.platform !== "linux" || !process.env.LLV_OWNED_TEST_RUN_CGROUP).each(["pure", "assertion", "leak"] as const)("native service cleanup preserves the hook verdict: %s", async kind => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-native-deadline-")); roots.push(dir);
  const record = path.join(dir, "child.json");
  const lines: string[] = [];
  const subject = path.join(dir, kind === "leak" ? "leak.ts" : "pending.test.ts");
  writeFileSync(subject, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { captureProcessIdentity } from ${JSON.stringify(path.join(root, "src/lib/processIdentity.ts"))};
    ${kind === "leak" ? `
      const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
      child.unref();
      writeFileSync(${JSON.stringify(record)}, JSON.stringify(captureProcessIdentity(child.pid)));
      process.exit(0);
    ` : `
      import { test, expect } from "bun:test";
      test("decisive native assertion", () => {
        writeFileSync(${JSON.stringify(record)}, JSON.stringify(captureProcessIdentity(process.pid)));
        expect(1).toBe(${kind === "assertion" ? 2 : 1});
      });
      test("pending native result", async () => { await new Promise(() => {}); }, 60000);
    `}`);
  const error = await runSteps("pre-push", [{ name: "types", command: [] }], {
    root: dir, deadline: soon(20_000), logDir: dir, say: line => lines.push(line),
    prepare: () => ({ env: process.env, command: ["bash", "-c", 'export LLV_OWNED_RUN_TIMEOUT_MS=2500; exec "$@"', "native-deadline",
      process.execPath, path.join(root, "scripts/owned-runner.ts"), process.execPath, ...(kind === "leak" ? [subject] : ["test", subject])] }),
  }).then(() => null, (caught: unknown) => caught);
  const output = lines.join("\n");
  expect(existsSync(record), output).toBeTrue();
  const identity: ProcessIdentity = JSON.parse(readFileSync(record, "utf8")); owned.push(identity);
  // The real systemd --wait client must finish containment before the hook
  // accepts a retry, including a detached child left by a successful command.
  expect(processIdentityStatus(identity), output).toBe("dead");
  const ending = endingOf("pre-push", error);
  expect(ending.code, output).toBe(kind === "pure" ? 75 : 1);
  if (kind === "pure") expect(error).toBeInstanceOf(NoVerdict);
  expect(output).toContain(kind === "leak" ? "surviving owned processes:" : "processes awaiting deadline cleanup:");
  if (kind === "assertion") expect(output).toContain("(fail) decisive native assertion");
  expect(publicationDeadlineOnly([...lines, ending.line].join("\n"))).toBe(kind === "pure");
}, 30_000);

test("a peer timeout cannot erase a named assertion from a cancelled lane", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-peer-deadline-")); roots.push(dir);
  const ready = path.join(dir, "ready"), subject = path.join(dir, "assertion.test.ts");
  writeFileSync(subject, `import { test, expect } from "bun:test"; import { writeFileSync } from "node:fs";
    test("decisive assertion", () => expect(1).toBe(2));
    test("pending", async () => { writeFileSync(${JSON.stringify(ready)}, "ready"); setInterval(() => {}, 1000); await new Promise(() => {}); }, 60000);`);
  const lines: string[] = [];
  const result = await runSteps("pre-push", ["timeout", "assertion"].map(name => ({ name, command: [], group: "checks" })), {
    root: dir, deadline: soon(10_000), logDir: dir, say: line => lines.push(line), prepare: step => ({ env: process.env,
      command: step.name === "assertion" ? [process.execPath, "test", subject] : [process.execPath, "-e", `const fs = require("node:fs"); while (!fs.existsSync(${JSON.stringify(ready)})) await Bun.sleep(5); process.exit(124);`],
    }),
  }).then(() => null, (error: unknown) => error);
  const ending = endingOf("pre-push", result);
  expect(ending.code, lines.join("\n")).toBe(1);
  expect(lines.join("\n")).toContain("(fail) decisive assertion");
  expect(publicationDeadlineOnly([...lines, ending.line].join("\n"))).toBe(false);
});

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

test("a caller's deadline is authoritative and must be a Unix time in milliseconds", () => {
  expect(pushDeadline({}, 1_000)).toBeNull();
  expect(pushDeadline({ LLV_GATE_PUSH_DEADLINE: "" }, 1_000)).toBeNull();
  expect(pushDeadline({ LLV_GATE_PUSH_DEADLINE: "5000" }, 1_000)).toEqual({ at: 5_000, startedAt: 1_000 });
  for (const bad of ["soon", "-1", "1.5"]) expect(() => pushDeadline({ LLV_GATE_PUSH_DEADLINE: bad }, 1_000)).toThrow("LLV_GATE_PUSH_DEADLINE");
});

test.each(["recovers", "repeats", "assertion", "runner", "cleanup", "incomplete", "cancel-retry"] as const)("a comparator-authorized phase retry is bounded across real hook processes: %s", mode => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-flaky-phase-")); roots.push(dir);
  const counter = path.join(dir, "attempts"), subject = path.join(dir, "check.ts"), harness = path.join(dir, "hook.ts");
  writeFileSync(subject, `import { existsSync, readFileSync, writeFileSync } from "node:fs";
    const counter = ${JSON.stringify(counter)};
    const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
    writeFileSync(counter, String(n));
    if (${JSON.stringify(mode)} === "recovers" && n > 1) process.exit(0);
    if (${JSON.stringify(mode)} === "cancel-retry" && n > 1) { setInterval(() => {}, 1000); await new Promise(() => {}); }
    console.log("FLAKY example.test.ts: <between-tests error> first diagnostic");
    console.log(${JSON.stringify(mode)} === "assertion" ? "NEW example.test.ts: reproducible assertion" : ${JSON.stringify(mode)} === "runner" ? "NEW example.test.ts: <runner error> incomplete report" : "NEW example.test.ts: <between-tests error> second diagnostic");
    if (${JSON.stringify(mode)} === "cleanup") console.log("owned runner: budget cleanup failed: fixture refusal");
    if (${JSON.stringify(mode)} !== "incomplete") console.log("touched-tests: 1 new failures, 0 pre-existing failures, 0 fixed, 0 removed/skipped, 1 flaky");
    process.exitCode = 1;`);
  for (const grouped of [false, true]) {
    writeFileSync(harness, `import { existsSync, readFileSync } from "node:fs";
      import { runSteps } from ${JSON.stringify(path.join(root, "scripts/local-gate.ts"))};
      const cancel = new AbortController(); let done = false;
      const result = runSteps("pre-push", [{ name: "touched tests", command: [], ${grouped ? 'group: "tests", lane: "tests"' : ""} }], {
        root: ${JSON.stringify(dir)}, deadline: null, logDir: ${JSON.stringify(dir)}, cancel: cancel.signal,
        prepare: () => ({ command: [process.execPath, ${JSON.stringify(subject)}], env: process.env }),
      }).then(() => true, () => false).finally(() => { done = true; });
      if (${JSON.stringify(mode)} === "cancel-retry") {
        while (!done && (!existsSync(${JSON.stringify(counter)}) || Number(readFileSync(${JSON.stringify(counter)}, "utf8")) < 2)) await Bun.sleep(10);
        if (!done) cancel.abort();
      }
      if (!await result) process.exitCode = 1;`);
    for (let restart = 0; restart < 2; restart++) {
      writeFileSync(counter, "0");
      const result = spawnSync(process.execPath, [harness], { cwd: dir, env: process.env, encoding: "utf8", timeout: 25_000, killSignal: "SIGKILL" });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(mode === "recovers" ? 0 : 1);
      expect(readFileSync(counter, "utf8")).toBe(["recovers", "repeats", "cancel-retry"].includes(mode) ? "2" : "1");
      if (mode === "cancel-retry") expect(result.stderr).toContain("retaining the comparator refusal");
    }
  }
}, 60_000);

function alive(pid: number): boolean {
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
}
/** Live processes whose command line names `needle`; read-only. */
function processesNaming(needle: string): number[] {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle) && alive(pid); } catch { return false; }
  });
}
function ownCgroup(): string {
  return readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::"))!.slice(3);
}
function scopeProcesses(scope: string): string[] {
  try { return readFileSync(path.join("/sys/fs/cgroup", scope, "cgroup.procs"), "utf8").split("\n").filter(Boolean); } catch { return []; }
}

test("a group's steps run at once and report each verdict", async () => {
  const runner = stepRunner(soon(60_000), () => ({ a: "sleep 1.5", b: "sleep 1.5", c: "sleep 1.5" }));
  const started = performance.now();
  expect(await runner.run([grouped("a"), grouped("b"), grouped("c", true)])).toBeNull();
  expect(performance.now() - started).toBeLessThan(4_000);
  expect(runner.lines[0]).toBe(`pre-push: ${NATIVE_GROUP}`);
  for (const name of ["a", "b", "c"]) expect(runner.lines).toContainEqual(expect.stringMatching(new RegExp(`^pre-push: ${name}: passed in \\d+ s$`)));
}, 20_000);
test("a caller's deadline leaves a deferrable check to the hosted job and says so; a decisive one that finished keeps its verdict", async () => {
  const runner = stepRunner(soon(2_500), () => ({ engine: "sleep 0.5", tail: "sleep 60" }));
  const started = performance.now();
  expect(await runner.run([grouped("engine"), grouped("tail", true)])).toBeNull();
  expect(performance.now() - started).toBeLessThan(15_000);
  expect(runner.lines).toContainEqual(expect.stringMatching(/^pre-push: left to the hosted job: "tail" was stopped after it had run \d+ s, when the push budget of \d+ s ran out; its verdict comes from the "Bun runtime pin" workflow/));
  expect(runner.lines).toContainEqual(expect.stringMatching(/^pre-push: engine: passed in \d+ s$/));
  expect(runner.lines.at(-1)).toBe("pre-push: passed; left to the hosted job: tail");
  // After the group's own marker, no verdict or deferral reads as a phase marker to the publication.
  for (const line of runner.lines.slice(1)) expect(line).not.toMatch(/^pre-push: [^;:]{1,60}$/);
}, 30_000);
test("without a caller's deadline nothing is stopped: a person's push waits for every verdict", async () => {
  const runner = stepRunner(null, () => ({ engine: "sleep 1", tail: "sleep 1" }));
  expect(await runner.run([grouped("engine"), grouped("tail", true)])).toBeNull();
  expect(runner.lines.filter(line => line.includes("hosted job"))).toEqual([]);
  expect(runner.lines).toContainEqual(expect.stringMatching(/^pre-push: tail: passed in \d+ s$/));
}, 30_000);
test("a caller's deadline stops a decisive step and everything it started, with no verdict", async () => {
  const runner = stepRunner(soon(1_500), dir => ({ "touched tests": `sleep 60 & echo $! > '${dir}/helper.pid'; wait` }));
  const started = performance.now();
  const error = await runner.run([{ name: "touched tests", command: [] }]);
  expect(error).toBeInstanceOf(NoVerdict);
  expect((error as Error).message).toMatch(/^no verdict within the push budget of \d+ s: "touched tests" was still running after \d+ s and was stopped; nothing was judged$/);
  expect(performance.now() - started).toBeLessThan(15_000);
  const helper = Number(readFileSync(path.join(runner.dir, "helper.pid"), "utf8"));
  for (let wait = 0; wait < 40 && alive(helper); wait++) await Bun.sleep(50);
  expect(alive(helper)).toBeFalse();
  // A step the deadline already passed never starts.
  const lateRunner = stepRunner(soon(-1), dir => ({ "touched tests": `touch '${dir}/started'` }));
  const late = await lateRunner.run([{ name: "touched tests", command: [] }]);
  expect((late as Error).message).toContain('"touched tests" could not start');
  expect(existsSync(path.join(lateRunner.dir, "started"))).toBeFalse();
}, 30_000);
test("a red verdict in a group fails the push with its log, even while the long tail is deferred", async () => {
  const runner = stepRunner(soon(2_500), () => ({ "native Codex 0.154.0": "echo '(fail) installed Codex: adapter pagination [3.00ms]'; exit 1", tail: "sleep 60" }));
  const error = await runner.run([grouped("native Codex 0.154.0"), grouped("tail", true)]);
  expect((error as Error).message).toContain("native Codex 0.154.0");
  expect(runner.lines).toContain("(fail) installed Codex: adapter pagination [3.00ms]");
  expect(runner.lines).toContainEqual(expect.stringMatching(/^pre-push: native Codex 0\.154\.0: failed \(1\)$/));
}, 30_000);
test("a deadline that passed before a step starts prepares nothing, alone or in a group", async () => {
  const prepared: string[] = [];
  const runner = stepRunner(soon(-1), () => ({}));
  const prepare = (step: Step) => { prepared.push(step.name); return { command: ["true"], env: process.env }; };
  for (const steps of [[{ name: "touched tests", command: [] }], [grouped("native Codex 0.154.0"), grouped("tail", true)]]) {
    const error = await runSteps("pre-push", steps, { root: runner.dir, deadline: soon(-1), logDir: runner.dir, say: () => {}, prepare }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoVerdict);
    expect((error as Error).message).toContain(`"${steps[0]!.name}" could not start`);
  }
  expect(prepared).toEqual([]);
});
test.skipIf(process.platform !== "linux")("a cold fixture install excludes CPU queue time and reaches its verdict after the original deadline", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-cold-")); roots.push(dir);
  writeFileSync(path.join(dir, "pressure"), "some avg10=99.00 avg60=99.00 avg300=99.00 total=1\n");
  const bin = path.join(dir, "bin"); mkdirSync(bin);
  const relative = `node_modules/@openai/codex-linux-${process.arch}/vendor/${process.arch === "x64" ? "x86_64" : "aarch64"}-unknown-linux-musl/bin`;
  writeFileSync(path.join(bin, "npm"), `#!/bin/bash\nwhile [[ "$1" != --prefix ]]; do shift; done\nshift\nmkdir -p "$1/${relative}"\nprintf fixture > "$1/${relative}/codex"\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DELEGATUS_CPU_PRESSURE: "on", DELEGATUS_AGENT_CPU: "off", LLV_GATE_PSI_FILE: path.join(dir, "pressure"), LLV_GATE_PSI_RELEASE_SECONDS: "0", LLV_GATE_LOCK_DIR: dir, LLV_GATE_POLL_SECONDS: "0.02" };
  const cache = path.join(dir, "cold-cache");
  const pending = runSteps("pre-push", [grouped("native Codex 0.154.0"), grouped("native Codex shared contracts", true)], {
    root, deadline: soon(1_500), logDir: dir, say: () => {},
    prepare: async (_step, until, cancel, waitEnv) => ({ command: ["true", await codexFixture(root, cache, "0.154.0", until, { ...env, LLV_CPU_WAIT_ROOTS: waitEnv!.LLV_CPU_WAIT_ROOTS }, cancel)], env }),
  });
  try {
    const { Database } = await import("bun:sqlite");
    let queued = false;
    for (let poll = 0; poll < 250 && !queued; poll++) {
      if (existsSync(path.join(dir, "admission.sqlite"))) {
        const db = new Database(path.join(dir, "admission.sqlite"), { readonly: true });
        try { queued = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tickets").get()!.n === 2; }
        catch { /* The waiting helper is still creating its queue schema. */ }
        finally { db.close(); }
      }
      if (!queued) await Bun.sleep(20);
    }
    expect(queued).toBe(true);
    await Bun.sleep(1_600);
    expect(existsSync(cache)).toBe(false);
    writeFileSync(path.join(dir, "pressure"), "some avg10=0.00 total=1\n");
    expect(await pending).toEqual([]);
    expect(processesNaming(cache)).toEqual([]);
  } finally { writeFileSync(path.join(dir, "pressure"), "some avg10=0.00 total=1\n"); await pending.catch(() => {}); }
}, 30_000);
test("the fetch before planning ends at the deadline", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-fetch-")); roots.push(dir);
  const remote = path.join(dir, "remote.git"), work = path.join(dir, "work");
  const env = fixtureGitEnv();
  execFileSync("git", ["init", "-q", "--bare", remote], { env });
  execFileSync("git", ["init", "-q", work], { env });
  // An upload-pack that never answers stands in for a remote that hangs.
  const hang = path.join(dir, "hang.sh");
  writeFileSync(hang, `#!/bin/sh\necho $$ > '${dir}/upload.pid'\nexec sleep 60\n`); chmodSync(hang, 0o755);
  execFileSync("git", ["-C", work, "remote", "add", "origin", remote], { env });
  execFileSync("git", ["-C", work, "config", "remote.origin.uploadpack", hang], { env });
  const started = performance.now();
  expect(await fetchMain(work, Date.now() + 1_000)).toBe("stopped");
  expect(performance.now() - started).toBeLessThan(5_000);
  const upload = Number(readFileSync(path.join(dir, "upload.pid"), "utf8"));
  for (let wait = 0; wait < 40 && alive(upload); wait++) await Bun.sleep(50);
  expect(alive(upload)).toBeFalse();
  expect(await fetchMain(work, Date.now() - 1)).toBe("stopped");
}, 20_000);
const userManager = process.platform === "linux" && Bun.which("systemd-run") !== null
  && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0;
test.skipIf(!userManager)("a stopped step's own work scope goes with it, helpers that left the tree included, and no other scope is touched", async () => {
  // A neighbour scope this run must leave alone.
  const neighbourDir = mkdtempSync(path.join(tmpdir(), "gate-neighbour-")); roots.push(neighbourDir);
  const neighbourFile = path.join(neighbourDir, "pid");
  const neighbour = Bun.spawn({ cmd: ["systemd-run", "--user", "--scope", "-q", "--collect", "--", "bash", "-c", `echo $$ > '${neighbourFile}'; exec sleep 60`], stdio: ["ignore", "ignore", "ignore"] });
  try {
    const [neighbourIdentity] = await recordFixtureIdentities([neighbourFile]);
    // Exercise actual transient scopes directly and below an intermediate.
    // gate-slot now owns a service; its lifetime is verified by owned-runner.
    for (const wrapped of [false, true]) {
      const dir = mkdtempSync(path.join(tmpdir(), "gate-scope-")); roots.push(dir);
      const env = { ...process.env };
      // One helper keeps the step's environment and one starts from an empty
      // one; both are reparented away from the step's process tree.
      const script = `echo $$ > '${dir}/root.pid'; cat /proc/$$/cgroup > '${dir}/scope'; ( sleep 60 & echo $! > '${dir}/kept.pid' ) ; ( env -i sleep 60 & echo $! > '${dir}/bare.pid' ) ; touch '${dir}/ready'; sleep 60`;
      const scoped = ["systemd-run", "--user", "--scope", "-q", "--collect", "--", "bash", "-c", script];
      const command = wrapped ? ["bash", "-c", `"$@"; exit $?`, "step", ...scoped] : scoped;
      const started = performance.now();
      const pending = runSteps("pre-push", [{ name: "touched tests", command: [] }], { root, deadline: soon(4_000), logDir: dir, say: () => {},
        prepare: () => ({ command, env }) }).then(() => null, (caught: unknown) => caught);
      try { await recordFixtureIdentities(["root", "kept", "bare"].map(name => path.join(dir, `${name}.pid`))); }
      finally { await pending; }
      const error = await pending;
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(existsSync(path.join(dir, "ready")), "the work started before the deadline").toBeTrue();
      expect(error).toBeInstanceOf(NoVerdict);
      const scope = readFileSync(path.join(dir, "scope"), "utf8").split("\n").find(line => line.startsWith("0::"))!.slice(3);
      // The work ran in a scope of its own, which is the case the cleanup must reach.
      expect(scope).toMatch(/\.scope$/);
      expect(scope).not.toBe(ownCgroup());
      for (const helper of ["kept", "bare"]) expect(alive(Number(readFileSync(path.join(dir, `${helper}.pid`), "utf8"))), `${helper}, wrapped: ${wrapped}`).toBeFalse();
      expect(scopeProcesses(scope)).toEqual([]);
      expect(alive(neighbour.pid)).toBeTrue();
      expect(processIdentityStatus(neighbourIdentity!)).toBe("alive");
    }
  } finally {
    neighbour.kill("SIGKILL");
    await neighbour.exited;
  }
}, 40_000);
test("a root that refuses the stop is reported within the cleanup allowance, and the hook exits without waiting for it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-refused-")); roots.push(dir);
  const harness = path.join(dir, "harness.ts"), output = path.join(dir, "stderr"), rootPid = path.join(dir, "root.pid");
  // The hook's own ending, with SIGKILL refused for the step's root alone: the
  // stand-in for a child stuck in uninterruptible I/O.
  writeFileSync(harness, `import { readFileSync } from "node:fs";
import { endHook, runSteps } from ${JSON.stringify(path.join(root, "scripts/local-gate.ts"))};
const kill = process.kill.bind(process);
process.kill = ((pid: number, signal?: string | number) => {
  if (signal === "SIGKILL" && String(pid) === readFileSync(${JSON.stringify(rootPid)}, "utf8").trim()) throw Object.assign(new Error("refused"), { code: "EPERM" });
  return kill(pid, signal);
}) as typeof process.kill;
const startedAt = Date.now();
await runSteps("pre-push", [{ name: "touched tests", command: [] }], { root: ${JSON.stringify(dir)}, deadline: { at: startedAt + 300, startedAt }, logDir: ${JSON.stringify(dir)}, say: () => {},
  prepare: () => ({ command: ["bash", "-c", "echo $$ > ${rootPid}; exec sleep 9"], env: process.env }) }).catch((error: unknown) => endHook("pre-push", error));
`);
  const started = performance.now();
  const hook = Bun.spawn({ cmd: [process.execPath, harness], cwd: dir, stdio: ["ignore", "ignore", Bun.file(output)] });
  const [identity] = await recordFixtureIdentities([rootPid]);
  const code = await hook.exited;
  const elapsed = performance.now() - started;
  const pid = identity!.pid;
  try {
    // The deadline, the three-second cleanup allowance and Bun's start-up; never the child's own nine seconds.
    expect(elapsed).toBeLessThan(5_500);
    expect(code).toBe(1);
    const said = readFileSync(output, "utf8");
    expect(said).toContain(`pre-push: "touched tests" was stopped at the push deadline, but 1 of its processes (${pid}) are still running; stop them before pushing again; gate failed`);
    // A refusal, never a hook the budget stopped: the publication must not retry beside the survivor.
    const { hookBudgetStop } = await import("../src/lib/pipelines/git");
    expect(hookBudgetStop(said)).toBeNull();
    expect(alive(pid), "the survivor really was left running").toBeTrue();
  } finally {
    await stopFixtureIdentity(identity!);
  }
}, 30_000);
for (const budget of [null, 60_000]) test(`a group member that cannot be prepared stops the rest of its group before the hook exits (deadline: ${budget ?? "none"})`, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-prepare-")); roots.push(dir);
  const harness = path.join(dir, "harness.ts"), output = path.join(dir, "stderr");
  const pidFile = (name: string) => path.join(dir, `${name}.pid`);
  const helper = path.join(dir, "helper.ts"), helperExit = path.join(dir, "allow-helper-exit"), naturalExit = path.join(dir, "natural-exit");
  writeFileSync(helper, `import { existsSync, writeFileSync } from "node:fs";
    import { checkFixtureParent } from ${JSON.stringify(path.join(root, "src/lib/testing/fixtureLifetime.ts"))};
    while (!existsSync(${JSON.stringify(helperExit)})) { checkFixtureParent(); await Bun.sleep(20); }
    checkFixtureParent(); writeFileSync(${JSON.stringify(naturalExit)}, "released");`);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const command = `echo $$ > ${quote(pidFile("root"))}; ${quote(process.execPath)} ${quote(helper)} & echo $! > ${quote(pidFile("helper"))}; wait`;
  // The helper can end only through cancellation or our supervising watchdog.
  writeFileSync(harness, `import { existsSync } from "node:fs";
import { NATIVE_GROUP, endHook, runSteps } from ${JSON.stringify(path.join(root, "scripts/local-gate.ts"))};
const startedAt = Date.now(), budget = ${JSON.stringify(budget)};
const members = ["native Codex 0.154.0", "native Codex 0.159.0"].map(name => ({ name, command: [], group: NATIVE_GROUP }));
await runSteps("pre-push", members, { root: ${JSON.stringify(dir)}, deadline: budget === null ? null : { at: startedAt + budget, startedAt }, logDir: ${JSON.stringify(dir)},
  prepare: async step => {
    if (step.name.endsWith("0.154.0")) return { command: ["bash", "-c", ${JSON.stringify(command)}], env: process.env };
    while (!existsSync(${JSON.stringify(path.join(dir, "release"))})) await Bun.sleep(10);
    throw new Error("installing @openai/codex@0.159.0 failed (1)");
  } }).catch((error: unknown) => endHook("pre-push", error));
`);
  const hook = Bun.spawn({ cmd: [process.execPath, harness], cwd: dir, stdio: ["ignore", "ignore", Bun.file(output)] });
  const hookIdentity = captureProcessIdentity(hook.pid); owned.push(hookIdentity);
  let watchdogExpired = false;
  const watchdog = setTimeout(() => {
    watchdogExpired = true;
    writeFileSync(helperExit, "supervising deadline");
    writeFileSync(path.join(dir, "release"), "ready");
  }, 20_000);
  let identities: ProcessIdentity[] = [];
  try {
    identities = await recordFixtureIdentities(["root", "helper"].map(pidFile), 20_000);
    writeFileSync(path.join(dir, "release"), "ready");
    const code = await hook.exited;
    const pids = identities.map(identity => identity.pid);
    expect(watchdogExpired).toBe(false);
    expect(existsSync(naturalExit), "cancellation ended the helper before its release").toBe(false);
    expect(code).toBe(1);
    // Nothing the running member started outlives the hook.
    for (const pid of pids) expect(alive(pid), String(pid)).toBeFalse();
    const said = readFileSync(output, "utf8");
    expect(said).toContain("pre-push: native Codex 0.159.0: failed (installing @openai/codex@0.159.0 failed (1))");
    expect(said).toContain('pre-push: native Codex 0.154.0: stopped when "native Codex 0.159.0" failed; nothing was judged');
    expect(said.trimEnd().split("\n").at(-1)).toBe('pre-push: "native Codex 0.159.0" failed: installing @openai/codex@0.159.0 failed (1); gate failed');
    // The publication names the member that failed, and reads a refusal, never a budget stop.
    const { hookBudgetStop, publicationFailurePhase } = await import("../src/lib/pipelines/git");
    expect(publicationFailurePhase({ step: "publishing the pipeline branch", code: 1, signal: null, durationMs: 1_000, outputTail: said })).toBe("native Codex 0.159.0");
    expect(hookBudgetStop(said)).toBeNull();
  } finally {
    clearTimeout(watchdog);
    writeFileSync(helperExit, "cleanup");
    writeFileSync(path.join(dir, "release"), "ready");
    await stopFixtureIdentity(hookIdentity);
    await hook.exited;
    for (const identity of identities) await stopFixtureIdentity(identity);
  }
}, 30_000);
test("a native Codex group names its unfinished or failed version, never a member that passed", async () => {
  const { hookBudgetStop, publicationFailureCause, publicationInterruptionCause } = await import("../src/lib/pipelines/git");
  const dir = mkdtempSync(path.join(tmpdir(), "hook-group-")); roots.push(dir);
  const hook = async (scripts: Record<string, string>, budgetMs: number) => {
    const lines: string[] = [];
    const startedAt = Date.now();
    const members = ["native Codex 0.154.0", "native Codex 0.159.0", "native Codex shared contracts"]
      .map((name): Step => ({ name, command: [], group: NATIVE_GROUP, ...(name.endsWith("contracts") ? { deferrable: true } : {}) }));
    await runSteps("pre-push", members, { root: dir, deadline: { at: startedAt + budgetMs, startedAt }, logDir: dir, say: (line) => lines.push(line),
      prepare: (step) => ({ command: ["bash", "-c", scripts[step.name]!], env: process.env }) }).catch((error: unknown) => lines.push(endingOf("pre-push", error).line));
    return lines.join("\n");
  };
  // 0.154.0 and the shared contracts finish; 0.159.0 is still running at the deadline.
  const stopped = await hook({ "native Codex 0.154.0": "true", "native Codex 0.159.0": "sleep 60", "native Codex shared contracts": "true" }, 2_000);
  const stop = hookBudgetStop(stopped)!;
  expect(stop.check).toBe("native Codex 0.159.0");
  const interrupted = { step: "publishing the pipeline branch", code: 75, signal: null, durationMs: 2_000, outputTail: stopped, hookBudgetMs: 840_000, hookStoppedCheck: stop.check };
  expect(publicationInterruptionCause(interrupted)).toBe("the pre-push hook's 14-minute budget ran out before its \"native Codex 0.159.0\" check reached a verdict, and the push did not reach the remote");
  // Without the retained check, the group is named, still never a member that passed.
  expect(publicationInterruptionCause({ ...interrupted, hookStoppedCheck: undefined })).toContain(`"${NATIVE_GROUP}" phase`);
  // 0.159.0 fails while the others pass.
  const failed = await hook({ "native Codex 0.154.0": "true", "native Codex 0.159.0": "echo '(fail) installed Codex: adapter pagination [3.00ms]'; exit 1", "native Codex shared contracts": "true" }, 60_000);
  expect(hookBudgetStop(failed)).toBeNull();
  expect(publicationFailureCause({ step: "publishing the pipeline branch", code: 1, signal: null, durationMs: 1_000, outputTail: failed }))
    .toBe("the repository's pre-push hook failed in its \"native Codex 0.159.0\" phase (exit 1, 1 failing test, first: installed Codex: adapter pagination)");
}, 30_000);
test("Viewer sources leave runtime verification to every PR CI run", () => {
  for (const file of ["src/app/page.tsx", "src/app/layout.tsx", "src/components/Viewer.tsx"]) {
    const discovered = discover(root, "HEAD", [file]);
    expect(discovered.runtime).toBeFalse();
    const steps = plan("pre-push", [file], discovered);
    expect(steps.some(step => step.name === "Viewer build")).toBeFalse();
    expect(steps.some(step => step.name === "Viewer runtime")).toBeFalse();
  }
  const doc = ["CONTRIBUTING.md"] as const;
  expect(plan("pre-push", doc, discover(root, "HEAD", doc)).some(step => step.pinned)).toBeFalse();
}, 20_000);
test("deleted Viewer sources also leave runtime verification to PR CI", () => {
  const deletedRoot = mkdtempSync(path.join(tmpdir(), "deleted-viewer-input-")); roots.push(deletedRoot);
  symlinkSync(path.join(root, ".github"), path.join(deletedRoot, ".github"), "dir");
  symlinkSync(path.join(root, "scripts"), path.join(deletedRoot, "scripts"), "dir");
  for (const file of ["src/app/page.tsx", "src/app/layout.tsx"]) {
    const discovered = discover(deletedRoot, "HEAD", [file]);
    expect(discovered.existing.has(file)).toBeFalse();
    expect(discovered.runtime).toBeFalse();
    expect(plan("pre-push", [file], discovered).some(step => step.name === "Viewer runtime")).toBeFalse();
  }
});
test("dependency candidate installs the frozen graph before later verification", () => {
  const steps = plan("pre-push", ["package.json"], context());
  expect(steps[0]?.name).toBe("privacy");
  expect(steps[1]?.name).toBe("frozen install");
  expect(steps[1]?.command).toEqual(["bun", "install", "--frozen-lockfile", "--ignore-scripts"]);
});
test("media deferral preserves the commit selection when the whole diff is media", () => {
  const steps = plan("pre-push", ["image.png"], context({ skippedMedia: ["image.png"] }));
  const privacy = steps.find(step => step.name === "privacy")!.command;
  expect(privacy).not.toContain("image.png"); expect(privacy).toContain("--check-commits");
  expect(privacy).toContain("--added-lines");
  expect(privacy).toContain("--defer-unavailable-media");
  expect(privacy).not.toContain("--paths");
});
test("state isolation replaces inherited roots and removes the live owner claim", () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "gate-env-")); roots.push(sandbox);
  const env = isolatedEnvironment(sandbox, { GIT_DIR: "operator", GIT_INDEX_FILE: "operator", GIT_WORK_TREE: "operator", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null", XDG_RUNTIME_DIR: sandbox, NODE_ENV: "test", HOME: "operator", LLV_STATE_DIR: "operator", LLV_STATE_OWNER: "viewer", LLV_INBOX_DIR: "operator" });
  for (const key of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "TMPDIR", "CODEX_HOME", "LLV_CLAUDE_HOME"]) {
    expect(env[key]).toStartWith(sandbox + path.sep); expect(existsSync(env[key]!)).toBeTrue();
  }
  expect(env.LLV_STATE_OWNER).toBeUndefined(); expect(env.LLV_INBOX_DIR).toBeUndefined();
  for (const key of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) expect(env[key]).toBeUndefined();
  expect(env.LLV_GATE_LOCK_DIR).toBeUndefined();
  expect(isolatedEnvironment(sandbox, { NODE_ENV: "test", LLV_GATE_LOCK_DIR: sandbox }).LLV_GATE_LOCK_DIR).toBe(sandbox);
  expect(env.LLV_VIEWER_CONTROL_URL).toBe("http://127.0.0.1:1");
});
test("scope uses executed import closure and the workflow test lists", () => {
  const doc = discover(root, "HEAD", ["CONTRIBUTING.md"]);
  expect([doc.linux, doc.runtime, doc.native]).toEqual([false, false, false]);
  const host = discover(root, "HEAD", ["src/runtime-host/main.ts"]);
  expect(host.runtime).toBeTrue();
  const workflow = Bun.YAML.parse(readFileSync(path.join(root, ".github/workflows/bun-runtime.yml"), "utf8")) as { jobs: Record<string, { strategy: { matrix: { codex: string[] } } }> };
  expect(host.codexVersions).toEqual(workflow.jobs["native-queue-campaign"]!.strategy.matrix.codex);
  expect(host.codexVersions).toContain("0.162.1");
  expect(plan("pre-push", ["src/runtime-host/main.ts"], host).filter(step => step.codex).map(step => step.codex))
    .toEqual([...host.codexVersions]);
  const native = discover(root, "HEAD", ["src/lib/runtime/nativeCodexQueue.ts"]);
  expect(native.native).toBeFalse();
  const linux = discover(root, "HEAD", ["src/lib/proc/index.ts"]);
  expect(linux.linux).toBe(process.platform === "linux");
  expect(linux.linuxTests).toContain("src/runtime-host/runtimeHostFence.test.ts");
  expect(host.runtimeTests).toContain("src/runtime-host/hostRehearsalRun.test.ts");
  expect(pinnedBunVersion("RUN npm install -g bun@1.4.0\nRUN npm install -g bun@1.4.0")).toBe("1.4.0");
  expect(() => pinnedBunVersion("bun@1.4.0")).toThrow();
  expect(() => pinnedBunVersion("npm install -g bun@1.4.0\nnpm install -g bun@1.3.3")).toThrow();
}, 20_000);
