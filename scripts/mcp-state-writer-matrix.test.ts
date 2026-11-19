import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { fixtureGitEnv } from "./local-gate.fixture";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const matrix = path.join(import.meta.dir, "mcp-state-writer-matrix.py");
const load = `import importlib.util, json, os, pathlib, sys
spec = importlib.util.spec_from_file_location("matrix", ${JSON.stringify(matrix)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;

test("matrix isolation retains one allowance across two fresh owned runners before command dispatch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-budget-")); roots.push(root);
  fs.mkdirSync(path.join(root, "tmp"));
  fs.writeFileSync(path.join(root, "tmp/payload"), Buffer.alloc(2 * 1024 ** 2, 1));
  const stat = fs.statSync(root), marker = path.join(root, "executed");
  const inherited = { ...process.env, LLV_ATTEMPT_TIMING_ROOT: root,
    LLV_ATTEMPT_TIMING_ROOT_IDENTITY: `${stat.dev}:${stat.ino}`, LLV_ATTEMPT_TMP_MAX_BYTES: String(1024 ** 2),
    LLV_GATE_SLOT_LEASE: "fixture-lease", LLV_TOKEN: "fixture-private-value" };
  for (let round = 0; round < 2; round++) {
    const result = spawnSync("python3", ["-B", "-c", load + `
import subprocess
env = m.environment(pathlib.Path(${JSON.stringify(path.join(root, "tmp", `sample-${round}`))}))
assert "LLV_TOKEN" not in env
assert env["LLV_GATE_SLOT_LEASE"] == "fixture-lease"
for key in ["LLV_ATTEMPT_TIMING_ROOT", "LLV_ATTEMPT_TIMING_ROOT_IDENTITY", "LLV_ATTEMPT_TMP_MAX_BYTES", "UV_CACHE_DIR", "BUN_INSTALL_CACHE_DIR"]:
    assert env.get(key) == os.environ.get(key), key
result = subprocess.run(${JSON.stringify([process.execPath, path.join(import.meta.dir, "owned-runner.ts"), process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`])}, env=env)
sys.exit(result.returncode)
`], { env: inherited, encoding: "utf8", timeout: 20_000 });
    expect({ code: result.status, error: result.stderr }).toMatchObject({ code: 73 });
    expect(result.stderr).toContain("Refusing another check/export");
    expect(result.stderr).toContain("1048576 bytes");
    expect(fs.existsSync(marker)).toBeFalse();
  }
});

function fixture(incompatible: boolean, missingAudit = false, privateDependencies = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-setup-")); roots.push(root);
  const source = path.join(root, "source"), output = path.join(root, "output");
  fs.mkdirSync(path.join(source, "scripts"), { recursive: true });
  for (const name of ["source-checkout.ts", "attempt-tmp-budget.ts"])
    fs.copyFileSync(path.join(import.meta.dir, name), path.join(source, "scripts", name));
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ dependencies: {} }));
  fs.writeFileSync(path.join(source, "bun.lock"), "{}");
  fs.writeFileSync(path.join(source, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(source, "payload"), Buffer.alloc(1024 ** 2, 1));
  fs.writeFileSync(path.join(source, "harness.ts"), "original harness");
  const env = { ...fixtureGitEnv(), GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture", GIT_COMMITTER_EMAIL: "fixture" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: source, env, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q"); git("config", "core.hooksPath", "/dev/null"); git("add", "."); git("commit", "-qm", "baseline fixture");
  const baseline = git("rev-parse", "HEAD"), baselineTree = git("rev-parse", "HEAD^{tree}");
  fs.writeFileSync(path.join(source, "harness.ts"), "candidate harness");
  fs.writeFileSync(path.join(source, "payload"), Buffer.alloc(1024 ** 2, 2));
  if (incompatible) fs.writeFileSync(path.join(source, "bun.lock"), '{"changed":true}');
  git("add", "."); git("commit", "-qm", "candidate fixture");
  fs.mkdirSync(path.join(source, "node_modules"));
  fs.writeFileSync(path.join(source, "node_modules/dependency"), Buffer.alloc(4 * 1024 ** 2, 3));
  fs.mkdirSync(path.join(root, "seed")); fs.writeFileSync(path.join(root, "seed/state"), "seed");
  fs.writeFileSync(path.join(root, "capabilities.json"), "{}"); fs.writeFileSync(path.join(root, "observer.so"), "fixture observer");
  // The production setup already supports reusing prepared runtime binaries.
  fs.mkdirSync(path.join(output, "runtime"), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(output, "runtime/bun"));
  fs.symlinkSync(execFileSync("which", ["node"], { encoding: "utf8" }).trim(), path.join(output, "runtime/node"));
  if (privateDependencies) {
    fs.mkdirSync(path.join(output, "node_modules"));
    fs.writeFileSync(path.join(output, "node_modules/preserved"), "old output");
  }
  const result = spawnSync("python3", ["-B", "-c", load + `
m.REPO = pathlib.Path(${JSON.stringify(source)})
m.HARNESS = ["harness.ts"]
class Dispatched(Exception): pass
def stop_at_dispatch(*args): raise Dispatched()
m.run = stop_at_dispatch
sys.argv = ["matrix", "--output", ${JSON.stringify(output)}, "--gate", "unused", "--observer", ${JSON.stringify(path.join(root, "observer.so"))},
    "--seed", ${JSON.stringify(path.join(root, "seed"))}, "--capabilities", ${JSON.stringify(path.join(root, "capabilities.json"))},
    "--baseline", ${JSON.stringify(baseline)}, "--audit", ${JSON.stringify(missingAudit ? "unselected-missing-ref" : baseline)}, "--sides", "candidate", "main", "--smoke", "--clients", "1", "--modes", "stdio-shared"]
try: m.main()
except Dispatched: print("first sample dispatched")
`], { env: { ...process.env, TMPDIR: root }, encoding: "utf8", timeout: 30_000 });
  return { root, source, output, baseline, baselineTree, head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), result, git };
}

test.skipIf(process.platform !== "linux")("real matrix setup shares objects and matching dependencies, exports only selected revisions and retains provenance", () => {
  const f = fixture(false);
  expect({ code: f.result.status, error: f.result.stderr }).toMatchObject({ code: 0 });
  expect(f.result.stdout).toContain("first sample dispatched");
  const modules = path.join(f.source, "node_modules"), dependency = path.join(modules, "dependency");
  expect(fs.lstatSync(path.join(f.output, "node_modules")).isSymbolicLink()).toBeTrue();
  for (const side of ["candidate", "main"]) {
    const target = path.join(f.output, side), manifest = JSON.parse(fs.readFileSync(path.join(f.output, `${side}.manifest.json`), "utf8"));
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).trim()).toBe(side === "candidate" ? f.head : f.baseline);
    expect(manifest.sourceRevision).toBe(side === "candidate" ? f.head : f.baseline);
    expect(manifest.sourceTree).toBe(side === "candidate" ? f.tree : f.baselineTree);
    expect(manifest.harnessRevision).toBe(f.head);
    expect(manifest.dependencySourceRevision).toBe(f.head);
    expect(manifest.harnessFiles["harness.ts"]).toBe(new Bun.CryptoHasher("sha256").update("candidate harness").digest("hex"));
    expect(fs.readFileSync(path.join(target, "harness.ts"), "utf8")).toBe("candidate harness");
    expect(fs.readFileSync(path.join(target, "payload"))[0]).toBe(side === "candidate" ? 2 : 1);
    expect(fs.readFileSync(path.join(target, ".git/objects/info/alternates"), "utf8").trim()).toBe(path.join(f.source, ".git/objects"));
    expect(fs.realpathSync(path.join(target, "node_modules"))).toBe(modules);
    expect(fs.statSync(path.join(target, "node_modules/dependency")).ino).toBe(fs.statSync(dependency).ino);
  }
  expect(fs.existsSync(path.join(f.output, "audit"))).toBeFalse();
  expect(fs.readdirSync(f.output).some(name => name.endsWith(".tar") || name.startsWith("llv-review-export-"))).toBeFalse();
  expect(f.git("status", "--porcelain")).toBe("");
  fs.rmSync(f.output, { recursive: true });
  expect(fs.readFileSync(dependency)).toEqual(Buffer.alloc(4 * 1024 ** 2, 3));
});

test.skipIf(process.platform !== "linux")("historical dependency inputs keep the declared frozen candidate snapshot", () => {
  const f = fixture(true);
  expect({ code: f.result.status, error: f.result.stderr }).toMatchObject({ code: 0 });
  expect(f.result.stdout).toContain("first sample dispatched");
  const manifest = JSON.parse(fs.readFileSync(path.join(f.output, "main.manifest.json"), "utf8"));
  expect(manifest.dependencySourceRevision).toBe(f.head);
  expect(manifest.dependencySnapshotSha256).toBe(JSON.parse(fs.readFileSync(path.join(f.output, "candidate.manifest.json"), "utf8")).dependencySnapshotSha256);
  expect(manifest.dependencyLockSha256).toBe(new Bun.CryptoHasher("sha256").update(fs.readFileSync(path.join(f.source, "bun.lock"))).digest("hex"));
  expect(fs.readFileSync(path.join(f.output, "main/bun.lock"), "utf8")).toBe("{}");
  expect(fs.realpathSync(path.join(f.output, "main/node_modules"))).toBe(path.join(f.source, "node_modules"));
  expect(fs.readdirSync(f.output).some(name => name.startsWith("llv-review-export-"))).toBeFalse();
  expect(f.git("status", "--porcelain")).toBe("");
});

test.skipIf(process.platform !== "linux")("unselected revisions need no ref or checkout", () => {
  const f = fixture(false, true);
  expect({ code: f.result.status, error: f.result.stderr }).toMatchObject({ code: 0 });
  expect(f.result.stdout).toContain("first sample dispatched");
  expect(fs.existsSync(path.join(f.output, "audit"))).toBeFalse();
});

test.skipIf(process.platform !== "linux")("resume refuses an output with private dependencies without changing them", () => {
  const f = fixture(false, false, true);
  expect(f.result.status).toBe(1);
  expect(f.result.stderr).toContain("resume requires the same shared read-only dependency installation");
  expect(f.result.stdout).not.toContain("first sample dispatched");
  expect(fs.readFileSync(path.join(f.output, "node_modules/preserved"), "utf8")).toBe("old output");
});
