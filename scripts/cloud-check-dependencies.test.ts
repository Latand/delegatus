import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reuseCloudDependencies } from "./cloud-check-dependencies";
import { cloudCommand, cloudInputDigest, AppServerCloudTransport, type CloudRpc } from "./cloud-checks";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "cloud-dependencies-"));
  const source = path.join(root, "setup"), target = path.join(root, "candidate");
  mkdirSync(source); mkdirSync(target);
  const manifest = { dependencies: { probe: "1.0.0" }, devDependencies: { compiler: "2.0.0" }, patchedDependencies: { "probe@1.0.0": "patches/probe.patch" } };
  const patch = "diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = 1\n+module.exports = 2\n";
  const lock = { workspaces: { "": { dependencies: manifest.dependencies, devDependencies: manifest.devDependencies } },
    packages: { probe: ["probe@1.0.0", "", { dependencies: { nested: "1" } }], compiler: ["compiler@2.0.0", "", {}],
      "probe/nested": ["nested@1.0.0", "", {}], optional: ["optional@1.0.0", "", {}] }, patchedDependencies: manifest.patchedDependencies };
  for (const directory of [source, target]) {
    writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
    writeFileSync(path.join(directory, "bun.lock"), JSON.stringify(lock));
    writeFileSync(path.join(directory, "bunfig.toml"), "");
    mkdirSync(path.join(directory, "patches")); writeFileSync(path.join(directory, "patches/probe.patch"), patch);
  }
  for (const [name, version] of [["probe", "1.0.0"], ["compiler", "2.0.0"], ["probe/node_modules/nested", "1.0.0"]]) {
    const dir = path.join(source, "node_modules", name!); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: name!.split("/").at(-1), version }));
  }
  writeFileSync(path.join(source, "node_modules/probe/index.js"), "module.exports = 2\n");
  return { root, source, target, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("setup dependencies include dev and nested packages, omit optional platforms, and are copied independently", () => {
  const f = fixture();
  try {
    reuseCloudDependencies(f.source, f.target);
    const file = "node_modules/probe/package.json";
    expect(readFileSync(path.join(f.target, file), "utf8")).toBe(readFileSync(path.join(f.source, file), "utf8"));
    writeFileSync(path.join(f.target, file), "changed by check");
    expect(JSON.parse(readFileSync(path.join(f.source, file), "utf8")).version).toBe("1.0.0");
  } finally { f.cleanup(); }
});

test("a retained Cloud workspace refreshes ignored dependencies on retry", () => {
  const f = fixture();
  try {
    reuseCloudDependencies(f.source, f.target);
    writeFileSync(path.join(f.target, "node_modules/probe/package.json"), '{"name":"probe","version":"stale"}');
    reuseCloudDependencies(f.source, f.target);
    expect(readFileSync(path.join(f.target, "node_modules/probe/package.json"), "utf8"))
      .toBe(readFileSync(path.join(f.source, "node_modules/probe/package.json"), "utf8"));
  } finally { f.cleanup(); }
});

test("copied executable symlinks keep resolving inside the candidate installation", () => {
  const f = fixture();
  try {
    const bin = path.join(f.source, "node_modules/.bin"), target = path.join(f.target, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(path.join(f.source, "node_modules/compiler/bin"), { recursive: true });
    mkdirSync(path.join(f.source, "node_modules/compiler/lib"), { recursive: true });
    writeFileSync(path.join(f.source, "node_modules/compiler/package.json"), JSON.stringify({ name: "compiler", version: "2.0.0", bin: { tsc: "./bin/tsc" } }));
    writeFileSync(path.join(f.source, "node_modules/compiler/bin/tsc"), 'require("../lib/tsc.js"); console.log("TSC_OK");\n');
    writeFileSync(path.join(f.source, "node_modules/compiler/lib/tsc.js"), 'process.stdout.write("TSC_OK\\n");\n');
    symlinkSync("../compiler/bin/tsc", path.join(bin, "tsc"));
    reuseCloudDependencies(f.source, f.target);
    const result = spawnSync(process.execPath, [path.join(target, "tsc")], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("TSC_OK");
    expect(existsSync(path.join(target, "tsc"))).toBe(true);
    expect(readlinkSync(path.join(target, "tsc"))).toBe("../compiler/bin/tsc");
    expect(readFileSync(path.join(f.source, "node_modules/compiler/lib/tsc.js"), "utf8")).toContain("TSC_OK");
  } finally { f.cleanup(); }
});

test("a .bin executable redirected to an undeclared package file is refused", () => {
  const f = fixture();
  try {
    const bin = path.join(f.source, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(path.join(f.source, "node_modules/compiler/bin"), { recursive: true });
    writeFileSync(path.join(f.source, "node_modules/compiler/package.json"), JSON.stringify({ name: "compiler", version: "2.0.0", bin: { tsc: "./bin/tsc" } }));
    writeFileSync(path.join(f.source, "node_modules/compiler/bin/tsc"), 'process.exit(42);\n');
    writeFileSync(path.join(f.source, "node_modules/probe/noop.js"), 'process.exit(0);\n');
    symlinkSync("../probe/noop.js", path.join(bin, "tsc"));
    expect(() => reuseCloudDependencies(f.source, f.target)).toThrow("DELEGATUS_ENVIRONMENT:");
    expect(existsSync(path.join(f.target, "node_modules"))).toBe(false);
  } finally { f.cleanup(); }
});

test("a regular .bin replacement is refused", () => {
  const f = fixture();
  try {
    const bin = path.join(f.source, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "tsc"), 'process.exit(0);\n');
    expect(() => reuseCloudDependencies(f.source, f.target)).toThrow("DELEGATUS_ENVIRONMENT:");
  } finally { f.cleanup(); }
});

for (const mismatch of ["lock", "manifest", "patch", "stale installed patch", "git skipped patch", "bunfig", "missing modules", "missing dev", "missing nested", "stale version", "stale optional", "unlisted nested package", "root module shadow file", "scoped module shadow file", "nested module shadow file", "external executable link"]) {
  test(`dependency reuse refuses ${mismatch} before copying`, () => {
    const f = fixture();
    try {
      const file = (name: string) => path.join(f.source, name);
      if (mismatch === "lock") writeFileSync(file("bun.lock"), "{}");
      if (mismatch === "manifest") writeFileSync(file("package.json"), "{}");
      if (mismatch === "patch") writeFileSync(file("patches/probe.patch"), "stale");
      if (mismatch === "stale installed patch") writeFileSync(file("node_modules/probe/index.js"), "module.exports = 1\n");
      if (mismatch === "git skipped patch") {
        writeFileSync(file("node_modules/probe/index.js"), "module.exports = 1\n");
        execFileSync("git", ["init", "-q"], { cwd: f.source });
        writeFileSync(file(".gitignore"), "node_modules/\n");
      }
      if (mismatch === "bunfig") writeFileSync(file("bunfig.toml"), "stale");
      if (mismatch === "missing modules") rmSync(file("node_modules"), { recursive: true });
      if (mismatch === "missing dev") rmSync(file("node_modules/compiler"), { recursive: true });
      if (mismatch === "missing nested") rmSync(file("node_modules/probe/node_modules/nested"), { recursive: true });
      if (mismatch === "stale version") writeFileSync(file("node_modules/probe/package.json"), JSON.stringify({ name: "probe", version: "0.9.0" }));
      if (mismatch === "stale optional") {
        mkdirSync(file("node_modules/optional"));
        writeFileSync(file("node_modules/optional/package.json"), JSON.stringify({ name: "optional", version: "0.9.0" }));
      }
      if (mismatch === "unlisted nested package") {
        const nested = file("node_modules/probe/node_modules/compiler");
        mkdirSync(nested, { recursive: true });
        writeFileSync(path.join(nested, "package.json"), JSON.stringify({ name: "compiler", version: "9.0.0" }));
      }
      if (mismatch === "root module shadow file") writeFileSync(file("node_modules/compiler.js"), 'module.exports = "SHADOWED";\n');
      if (mismatch === "scoped module shadow file") {
        mkdirSync(file("node_modules/@types"), { recursive: true });
        writeFileSync(file("node_modules/@types/compiler.js"), 'module.exports = "SHADOWED";\n');
      }
      if (mismatch === "nested module shadow file") writeFileSync(file("node_modules/probe/node_modules/compiler.js"), 'module.exports = "SHADOWED";\n');
      if (mismatch === "external executable link") {
        const bin = file("node_modules/.bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(path.join(f.root, "outside.js"), "module.exports = 1\n");
        symlinkSync(path.join(f.root, "outside.js"), path.join(bin, "probe"));
      }
      expect(() => reuseCloudDependencies(f.source, f.target)).toThrow("DELEGATUS_ENVIRONMENT:");
      expect(existsSync(path.join(f.target, "node_modules"))).toBe(false);
    } finally { f.cleanup(); }
  });
}

for (const upload of [false, true]) for (const mismatch of [false, true]) test(`real Cloud command reuses setup without install: upload ${upload}, mismatch ${mismatch}`, () => {
  const f = fixture();
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "noreply@example.invalid", GIT_AUTHOR_DATE: "2026-10-24T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-24T00:00:00Z" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: f.source, env, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git("init", "-q"); mkdirSync(path.join(f.source, "scripts"));
    cpSync("scripts/cloud-check-dependencies.ts", path.join(f.source, "scripts/cloud-check-dependencies.ts"));
    writeFileSync(path.join(f.source, ".gitignore"), "node_modules\n");
    writeFileSync(path.join(f.source, "scripts/local-gate.ts"), 'import {readFileSync} from "node:fs"; if(JSON.parse(readFileSync("node_modules/compiler/package.json", "utf8")).version !== "2.0.0") process.exit(9); console.log("GATE_REACHED");');
    git("add", "."); git("commit", "-qm", "Fixture");
    const head = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
    const bundle = path.join(f.root, "source.bundle"); git("bundle", "create", bundle, "HEAD");
    if (mismatch) writeFileSync(path.join(f.source, "bun.lock"), "{}");
    const bin = path.join(f.root, "bin"); mkdirSync(bin);
    writeFileSync(path.join(bin, "bun"), `#!/bin/sh\nif [ "$1" = install ]; then echo NETWORK_INSTALL >&2; exit 99; fi\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    const job = { head, tree, base: head, inputs: {}, bundle: readFileSync(bundle).toString("base64"), timeoutMs: 1000 };
    const directory = path.join(f.root, "upload"); mkdirSync(directory);
    writeFileSync(path.join(directory, "bundle"), job.bundle);
    const result = spawnSync("bash", ["-c", cloudCommand(job, upload ? { directory, source: f.source } : undefined)], { cwd: f.source, env: { ...env, PATH: `${bin}:${env.PATH}` }, encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toContain("NETWORK_INSTALL");
    expect(result.status, result.stderr).toBe(mismatch ? 78 : 0);
    if (mismatch) {
      expect(result.stderr).toContain("DELEGATUS_ENVIRONMENT:");
      expect(result.stdout).not.toContain("GATE_REACHED");
      expect(result.stdout).not.toContain("DELEGATUS_GATE");
    } else {
      expect(result.stdout).toContain("GATE_REACHED");
      expect(result.stdout).toContain(`DELEGATUS_GATE ${head} ${tree} ${head} ${cloudInputDigest({})} 0`);
    }
  } finally { f.cleanup(); }
});

test("a same-tree Cloud retry refreshes its retained dependency directory and reaches the gate twice", () => {
  const f = fixture();
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "noreply@example.invalid" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: f.source, env, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git("init", "-q"); mkdirSync(path.join(f.source, "scripts"));
    cpSync("scripts/cloud-check-dependencies.ts", path.join(f.source, "scripts/cloud-check-dependencies.ts"));
    writeFileSync(path.join(f.source, ".gitignore"), "node_modules\n");
    writeFileSync(path.join(f.source, "scripts/local-gate.ts"), 'console.log("GATE_REACHED");');
    git("add", "."); git("commit", "-qm", "Fixture");
    const head = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD^{tree}");
    const bundle = path.join(f.root, "source.bundle"); git("bundle", "create", bundle, "HEAD");
    const bin = path.join(f.root, "bin"); mkdirSync(bin);
    writeFileSync(path.join(bin, "bun"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    const job = { head, tree, base: head, inputs: {}, bundle: readFileSync(bundle).toString("base64"), timeoutMs: 10_000 };
    const command = cloudCommand(job);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync("bash", ["-c", command], { cwd: f.source, env: { ...env, PATH: `${bin}:${env.PATH}` }, encoding: "utf8", timeout: 15_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`DELEGATUS_GATE ${head} ${tree} ${head} ${cloudInputDigest({})} 0`);
    }
  } finally { f.cleanup(); }
});

test("exact command environment refusal stays environment and cannot supply a receipt", async () => {
  let command = "";
  const rpc: CloudRpc = { cwd: "/workspace/repository", close() {}, async call(method, params) {
    if (method === "thread/start") return { model: "gpt-6.1-sol", thread: { id: "fixture", environments: [{ environmentId: "ccarenv_fixture", cwd: this.cwd }] } };
    if (method === "command/exec") return { exitCode: 0 };
    if (method === "turn/start") { command = (params.input as { text: string }[])[0]!.text.split("\n").slice(1).join("\n"); return { turn: { id: "turn" } }; }
    if (method === "thread/items/list") return { data: [{ turnId: "turn", item: { type: "commandExecution", status: "failed", command, exitCode: 78,
      aggregatedOutput: "DELEGATUS_ENVIRONMENT: installed dependencies do not match setup; rerun environment setup\n" } }] };
    throw new Error("unexpected method");
  } };
  const config = { account: { engine: "codex" as const, accountId: "fixture", kind: "managed" as const, home: "/fixture", transcriptRoot: "/fixture", env: { NODE_ENV: "test" as const } }, environmentId: "asenvcfg_fixture" };
  const job = { head: "a".repeat(40), tree: "b".repeat(40), base: "c".repeat(40), inputs: {}, bundle: "bundle", timeoutMs: 1000 };
  expect(await new AppServerCloudTransport(config, async () => rpc, () => {}).run(job)).toMatchObject({ kind: "invalid", code: 78, diagnostic: { category: "environment" } });
});
