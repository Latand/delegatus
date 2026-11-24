import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { SUPPORTED_CODEX_VERSIONS } from "../src/lib/accounts/codexVersions";
import { gatePlan } from "./gate-plan";
import { createHookFixture } from "./local-gate.fixture";

const roots: string[] = [];
const root = path.resolve(import.meta.dir, "..");
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const fixture = () => createHookFixture(root, roots);
type Fixture = ReturnType<typeof fixture>;

function write(f: Fixture, file: string, content = "// fixture change\n") {
  const target = f.writablePath(file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}
function commit(f: Fixture) {
  f.git("-c", "core.hooksPath=/dev/null", "add", ".");
  f.git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "candidate");
  return f.git("rev-parse", "HEAD").toString().trim();
}
const names = (plan: ReturnType<typeof gatePlan>) => plan.checks.map(check => check.step.name);

const linux = process.platform === "linux" ? ["Linux backend", "Linux tests"] : [];
const runtime = ["runtime verdict tests", "Viewer build", "MCP size budgets", "Viewer runtime", "runtime host", "runtime negative controls",
  ...SUPPORTED_CODEX_VERSIONS.map(version => `native Codex ${version}`), "native Codex shared contracts"];

test.each([
  { profile: "empty", file: "", push: ["privacy"], commit: ["staged whitespace"], batch: ["dependencies", "tsc", "privacy"] },
  { profile: "prose", file: "guide.md", push: ["privacy"], commit: ["staged whitespace"], batch: ["dependencies", "tsc", "privacy"] },
  { profile: "runtime and native matrix", file: "Dockerfile", push: ["privacy", ...runtime], commit: ["staged whitespace"], batch: ["dependencies", "tsc", "privacy"] },
  { profile: "dependency", file: "package.json", push: ["privacy", "frozen install", "types", ...linux, "audit retry tests", "supply chain"], commit: ["staged whitespace"], batch: ["dependencies", "tsc", "privacy"] },
  { profile: "workflow and privacy", file: ".github/workflows/privacy-publication.yml", push: ["privacy", "types", "touched tests"], commit: ["staged whitespace"], batch: ["dependencies", "tsc", "privacy"] },
  { profile: "shared source", file: "example.ts", push: ["privacy", "types", "eslint", "touched tests"], commit: ["staged whitespace", "eslint"], batch: ["dependencies", "tsc", "eslint", "tests", "privacy"] },
])("$profile preserves the ordered obligations of each adapter", ({ file, push, commit: staged, batch }) => {
  const f = fixture();
  if (file.includes("privacy-publication")) {
    write(f, "scripts/privacy-fixture.test.ts");
    commit(f);
    f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  }
  if (file) write(f, file);
  f.git("add", ".");
  expect(names(gatePlan(f.dir, { profile: "pre-commit" }, f.env))).toEqual(staged);
  if (file) commit(f);
  const plan = gatePlan(f.dir, { profile: "pre-push" }, f.env);
  expect(names(plan)).toEqual(push);
  expect(names(gatePlan(f.dir, { profile: "batch", base: "origin/main" }, f.env))).toEqual(batch);
  if (file === "Dockerfile") {
    expect(plan.checks.find(check => check.step.name === "MCP size budgets")?.after).toEqual(["Viewer build"]);
    expect(plan.checks.find(check => check.step.name === "native Codex shared contracts")?.step.selection).toBe("--shared-only");
  }
  if (file === "package.json") {
    expect(plan.checks.find(check => check.step.name === "types")?.after).toEqual(["frozen install"]);
    expect(plan.checks.find(check => check.step.name === "frozen install")?.fresh).toBe(true);
  }
});

test("the engine family is complete and deduplicated, with a separate raw and browser profile", () => {
  const f = fixture();
  const source = "src/lib/pipelines/engine.ts";
  const members = spawnSync("git", ["ls-files", "-z", "src/lib/pipelines/engine.*.test.ts"],
    { cwd: root, encoding: "utf8" }).stdout.split("\0").filter(Boolean).sort();
  expect(members.length).toBeGreaterThanOrEqual(97);
  for (const file of [source, ...members, "src/lib/pipelines/engine.test.ts", "src/lib/pipelines/engine.browser.test.tsx"]) write(f, file);
  commit(f);
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  write(f, source, "// updated implementation\n");
  write(f, members[0]!, "// updated test\n");
  write(f, "src/lib/pipelines/engine.browser.test.tsx", "// updated browser test\n");
  commit(f);

  const hook = gatePlan(f.dir, { profile: "pre-push" }, f.env);
  const tests = hook.checks.find(check => check.step.name === "touched tests")!.files;
  expect([...tests].sort()).toEqual([...members, "src/lib/pipelines/engine.test.ts"].sort());
  const batch = { profile: "batch", base: "origin/main" } as const;
  const raw = gatePlan(f.dir, batch, f.env).checks.find(check => check.step.name === "tests")!.files;
  expect(raw).toEqual([members[0]!, "src/lib/pipelines/engine.test.ts"].sort());
  expect(gatePlan(f.dir, { ...batch, browser: true }, f.env).checks.find(check => check.step.name === "tests")!.files)
    .toEqual([...raw, "src/lib/pipelines/engine.browser.test.tsx"].sort());
});

test("rename and deletion paths stay in the graph while reviewed blobs retain their own scope", () => {
  const f = fixture();
  write(f, "sub/old.ts", "// only this source is renamed\n");
  write(f, "sub/old.test.ts");
  write(f, "sub/deleted.test.ts", "// only this test is deleted\n");
  const base = commit(f);
  f.git("update-ref", "refs/remotes/origin/main", base);
  renameSync(f.writablePath("sub/old.ts"), f.writablePath("sub/new.ts"));
  rmSync(f.writablePath("sub/deleted.test.ts"));
  write(f, "sub/new.test.ts", "// new test has its own content\n");
  const head = commit(f);
  const push = gatePlan(f.dir, { profile: "pre-push" }, f.env);
  expect(push.changedPaths).toEqual(["sub/deleted.test.ts", "sub/new.test.ts", "sub/new.ts", "sub/old.ts"]);
  expect(push.checks.find(check => check.step.name === "touched tests")!.files).toEqual(["sub/new.test.ts"]);

  const batch = gatePlan(f.dir, { profile: "batch", base, reviewed: [{ number: 7, base, head }, { number: 8, base, head: base }] }, f.env);
  expect(batch.changedPaths).toEqual(push.changedPaths);
  expect(batch.detectors?.native.map(entry => entry.file)).toEqual(["sub/new.test.ts"]);
  expect(batch.detectors?.main.map(entry => entry.file)).toEqual(["sub/deleted.test.ts"]);
  expect(batch.detectors?.reviewed.map(row => row.head.map(entry => entry.file))).toEqual([["sub/new.test.ts"], []]);
  expect(batch.detectors?.native[0]?.blob).toBe(f.git("rev-parse", "HEAD:sub/new.test.ts").toString().trim());
  expect(Object.isFrozen(batch.detectors?.native[0])).toBe(true);
  expect(batch.checks.find(check => check.step.name === "privacy")?.environment).toBe("trusted base");
  const nativeOnly = gatePlan(f.dir, { profile: "batch", base }, f.env);
  expect(nativeOnly.planId).not.toBe(batch.planId);
  expect(nativeOnly.checks.find(check => check.step.name === "tsc")?.checkKey)
    .toBe(batch.checks.find(check => check.step.name === "tsc")?.checkKey);
});

test("a valid handoff hits the immutable plan, and damaged, changed-base, or changed-selector plans rebuild", () => {
  const f = fixture();
  write(f, "example.ts");
  commit(f);
  const request = { profile: "pre-push" } as const;
  const first = gatePlan(f.dir, request, f.env);
  const dir = f.writablePath(".git/delegatus-gate/plans");
  const file = path.join(dir, readdirSync(dir)[0]!);
  const earlier = new Date(Date.now() - 60_000);
  utimesSync(file, earlier, earlier);
  const stamp = statSync(file).mtimeMs;
  const hit = gatePlan(f.dir, request, f.env, process.execPath, first.planId);
  expect(hit).toEqual(first);
  expect(statSync(file).mtimeMs).toBe(stamp);
  expect(Object.isFrozen(hit.checks[0]!.step.command)).toBe(true);

  const stored = JSON.parse(readFileSync(file, "utf8"));
  stored.value.version = 42;
  writeFileSync(file, JSON.stringify(stored));
  expect(gatePlan(f.dir, request, f.env, process.execPath, first.planId)).toEqual(first);
  expect(JSON.parse(readFileSync(file, "utf8")).value.version).toBe(1);

  const selector = f.writablePath(".git/selector/scripts/gate-plan.ts");
  mkdirSync(path.dirname(selector), { recursive: true });
  for (const file of ["ci-platform-scope.ts", "gate-cache.ts"])
    symlinkSync(path.join(import.meta.dir, file), path.join(path.dirname(selector), file));
  symlinkSync(path.join(root, "src"), f.writablePath(".git/selector/src"), "dir");
  symlinkSync(path.join(root, "tsconfig.json"), f.writablePath(".git/selector/tsconfig.json"));
  writeFileSync(selector, readFileSync(path.join(import.meta.dir, "gate-plan.ts")) + "\n// distinguish selector revisions\n");
  const revised = spawnSync(process.execPath, ["-e",
    `import { gatePlan } from ${JSON.stringify(selector)}; console.log(JSON.stringify(gatePlan(process.cwd(), { profile: "pre-push" })));`],
    { cwd: f.dir, env: f.env, encoding: "utf8", timeout: 10_000 });
  expect(revised.status, revised.stderr).toBe(0);
  const revisedPlan = JSON.parse(revised.stdout) as typeof first;
  expect(revisedPlan.selector).not.toBe(first.selector);
  expect(revisedPlan.planId).not.toBe(first.planId);
  expect(revisedPlan.checks.map(check => check.step)).toEqual(first.checks.map(check => check.step));

  const other = gatePlan(f.dir, { profile: "batch", base: "origin/main" }, f.env);
  expect(other.planId).not.toBe(first.planId);
  f.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const moved = gatePlan(f.dir, request, f.env, process.execPath, first.planId);
  expect(moved.base).not.toBe(first.base);
  expect(names(moved)).toEqual(["privacy"]);
});

test("image and host obligations match and name different compiler observations", () => {
  const f = fixture();
  write(f, "example.ts");
  commit(f);
  const which = Bun.which;
  const tool = spyOn(Bun, "which").mockImplementation((name, options) =>
    ["bun", "bunx"].includes(name) ? `/usr/local/bin/${name}` : which(name, options));
  try {
    const request = { profile: "pre-push" } as const;
    const host = gatePlan(f.dir, request, f.env, "/usr/local/bin/bun");
    const image = gatePlan(f.dir, request, f.env, "/usr/local/bin/bun-container", host.planId);
    expect(image.checks.map(check => [check.step.name, check.after, check.files]))
      .toEqual(host.checks.map(check => [check.step.name, check.after, check.files]));
    const compiler = (plan: typeof host) => plan.checks.find(check => check.step.name === "types")!;
    expect(compiler(host).step.command).toEqual(["bunx", "tsc", "--noEmit"]);
    expect(compiler(image).step.command).toEqual(["node", "node_modules/typescript/bin/tsc", "--noEmit"]);
    expect(compiler(image).checkKey).not.toBe(compiler(host).checkKey);
    expect(image.planId).not.toBe(host.planId);
  } finally { tool.mockRestore(); }
});

test("check-step and pre-push share the publication selection and refuse a forged subset on reentry", async () => {
  const f = fixture();
  write(f, "example.ts");
  commit(f);
  const cache = f.writablePath(".git/delegatus-gate/plans");
  mkdirSync(cache, { recursive: true });
  const publications: string[] = [];
  const monitor = watch(cache, (event, file) => {
    if (event === "rename" && file?.endsWith(".json")) publications.push(file);
  });
  try {
    const stage = Bun.spawn([process.execPath, "scripts/local-gate.ts", "check-step", "types"], {
      cwd: f.dir, env: f.env, stderr: "pipe", timeout: 25_000,
    });
    const [code, stderr] = await Promise.all([stage.exited, stage.stderr.text()]);
    expect(code, stderr).toBe(0);
    expect(publications).toHaveLength(1);
  } finally { monitor.close(); }
  expect(f.calls().map(call => call.args[0])).toEqual(["tsc"]);
  const native = spawnSync("bash", [".githooks/pre-push"], { cwd: f.dir, env: f.env, encoding: "utf8", timeout: 25_000 });
  expect(native.status, native.stderr).toBe(0);
  expect(f.calls().map(call => call.args[0])).toContain("scripts/privacy-publication-gate.ts");
  const before = f.calls().length;
  const forged = spawnSync(process.execPath, ["scripts/local-gate.ts", "pre-push", "--admitted"], {
    cwd: f.dir, env: { ...f.env, LLV_GATE_PLAN_HANDOFF: JSON.stringify({ version: 1, planId: "a".repeat(64), steps: ["types"] }) },
    encoding: "utf8", timeout: 10_000,
  });
  expect(forged.status).not.toBe(0);
  expect(forged.stderr).toContain("selection is outside");
  expect(f.calls()).toHaveLength(before);
}, 70_000);
