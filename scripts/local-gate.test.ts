import { SUPPORTED_CODEX_VERSIONS } from "../src/lib/accounts/codexVersions";
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discover, isolatedEnvironment, pinnedBunVersion, plan, viewerBuildEnvironment } from "./local-gate";
import { type ProcessIdentity } from "../src/lib/processIdentity";
import { stopFixtureIdentity } from "../src/lib/testing/fixtureProcess";
import { publicationHookDeadline, publicationPushBudgetMs } from "../src/lib/pipelines/gateBudget";
import { createGateTestFixtures } from "./gateTest.fixture";
const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
const owned: ProcessIdentity[] = [];
const { context } = createGateTestFixtures(roots, owned);
afterEach(async () => {
  for (const identity of owned.splice(0)) await stopFixtureIdentity(identity);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
test("overlapping Linux and touched tests run once under the same comparator", () => {
  const shared = "src/example.test.ts";
  const c = context({ linux: true, linuxTests: [shared, "src/platform.test.ts"] });
  const checks = plan("pre-push", [shared], c);
  expect(checks.filter(step => step.command[1] === "scripts/local-gate-tests.ts" && step.command.includes("./" + shared)).map(step => step.name)).toEqual(["Linux tests"]);
  expect(checks.find(step => step.name === "Linux tests")?.command).toContain("./src/platform.test.ts");
});

test("privacy tool, catalog and imported source changes select the self-tests", () => {
  const suite = "scripts/privacy-canonical-text.test.ts";
  for (const file of ["scripts/privacy-known-value-fingerprints.json", "src/lib/privacy/canonicalText.ts", ".github/workflows/privacy-publication.yml"]) {
    const selected = discover(root, "HEAD", [file]);
    expect(selected.privacySelfTests).toContain(suite);
    expect(plan("pre-push", [file], selected).find(step => step.name === "touched tests")?.command).toContain("./" + suite);
  }
  expect(discover(root, "HEAD", ["docs/operator-guide.md"]).privacySelfTests).toEqual([]);
  expect(discover(root, "HEAD", [suite], "pre-commit").privacySelfTests).toEqual([]);
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
test("media-only pushes inspect the full commit selection", () => {
  const steps = plan("pre-push", ["image.png"], context());
  const privacy = steps.find(step => step.name === "privacy")!.command;
  expect(privacy).not.toContain("image.png"); expect(privacy).toContain("--check-commits");
  expect(privacy).toContain("--added-lines");
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
  expect(host.codexVersions).toEqual(SUPPORTED_CODEX_VERSIONS);
  expect(host.codexVersions).toHaveLength(3);
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

test("the hook prints the admitted runner refusal before preserving its exit", () => {
  const script = `import { runAdmittedChecks, endHook } from ${JSON.stringify(path.join(root, "scripts/local-gate.ts"))};
try { await runAdmittedChecks(["bash", "-c", "exit 17"], ${JSON.stringify(root)}, process.env, null); }
catch (error) { endHook("pre-push", error); }`;
  const result = spawnSync(process.execPath, ["-e", script], { env: process.env, encoding: "utf8", timeout: 10_000 });
  expect(result.status).toBe(17);
  expect(result.stderr).toContain("admitted checks exited 17");
});
