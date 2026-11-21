import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import type { BigIntStats, StatOptions, Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolateWorktreeDependencies, prepareWorktreeDependencies } from "./worktreeDependencies";
import type { Pipeline } from "./types";
import { lockedFixture } from "./fixtures/lockedDependencies";
import { buildPipeline } from "./store";
import { provisionPipelineWorktree, provisionPipelineWorktreeAsync, publishPipelineBranch, publicationFailureCause } from "./git";
import { findPipelineRecord, savePipelines } from "./store";
import { dependencyInstallFailure, prepareLockedDependencies } from "./lockedDependencies";
import { realExec, type ExecPort } from "../workflows/provision";

function fixture(writable = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-dependencies-"));
  const repoDir = path.join(root, "source"), worktreeDir = path.join(root, "lane");
  for (const dir of [repoDir, worktreeDir]) {
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.writeFileSync(path.join(dir, "package-lock.json"), "original lock\n");
  }
  const source = path.join(repoDir, "node_modules"), local = path.join(worktreeDir, "node_modules");
  fs.mkdirSync(path.join(source, ".bin"), { recursive: true });
  fs.mkdirSync(path.join(source, "fixture"));
  fs.writeFileSync(path.join(source, "fixture/index.js"), "original\n", { mode: 0o755 });
  fs.symlinkSync(path.join("..", "fixture/index.js"), path.join(source, ".bin/fixture"));
  const pipeline = { repoDir, worktreeDir, stages: [{ kind: "run", access: writable ? "read-write" : "read-only" }] } as Pipeline;
  return { root, source, local, pipeline, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const unavailable: typeof fs.promises.copyFile = async (source, target, mode) => {
  if (mode === fs.constants.COPYFILE_FICLONE_FORCE) throw Object.assign(new Error("clone unavailable"), { code: "ENOTSUP" });
  await fs.promises.copyFile(source, target);
};

test.each(["darwin", "linux"] as const)("%s requires CoW and preserves private writes, modes and internal executable links", async platform => {
  const f = fixture(true);
  const flags: number[] = [];
  try {
    // A portable clone seam checks the native flag while exercising the full
    // recursive publication path. Real filesystem capability is tested below.
    expect(await prepareWorktreeDependencies(f.pipeline, { platform, copyFile: async (a, b, mode) => {
      flags.push(mode!); await fs.promises.copyFile(a, b);
    } })).toBe("clone");
    expect(flags).toEqual([fs.constants.COPYFILE_FICLONE_FORCE]);
    expect(fs.lstatSync(f.local).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(f.local, ".bin/fixture"), "utf8")).toBe("original\n");
    expect(fs.statSync(path.join(f.local, "fixture/index.js")).mode & 0o111).toBe(0o111);
    fs.writeFileSync(path.join(f.pipeline.worktreeDir, "package-lock.json"), "new lock\n");
    fs.writeFileSync(path.join(f.local, "fixture/index.js"), "installed new dependency\n");
    expect(fs.readFileSync(path.join(f.source, "fixture/index.js"), "utf8")).toBe("original\n");
    expect(fs.readFileSync(path.join(f.pipeline.repoDir, "package-lock.json"), "utf8")).toBe("original lock\n");
  } finally { f.close(); }
});

test.each(["darwin", "linux", "win32"] as const)("%s fallback gives a read-only lane a private writable dependency copy", async platform => {
  const f = fixture();
  try {
    expect(await prepareWorktreeDependencies(f.pipeline, { platform, copyFile: unavailable })).toBe("copy");
    expect(fs.realpathSync(f.local)).not.toBe(fs.realpathSync(f.source));
    const generated = path.join(f.local, "fixture/generated.js");
    const command = Bun.spawnSync([process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(generated)}, "generated\\n")`], {
      cwd: f.pipeline.worktreeDir, stdout: "pipe", stderr: "pipe",
    });
    expect(command.exitCode, command.stderr.toString()).toBe(0);
    expect(fs.readFileSync(generated, "utf8")).toBe("generated\n");
    expect(fs.existsSync(path.join(f.source, "fixture/generated.js"))).toBe(false);
    expect(fs.readFileSync(path.join(f.source, "fixture/index.js"), "utf8")).toBe("original\n");
    await isolateWorktreeDependencies(f.pipeline);
    expect(fs.existsSync(generated)).toBe(true);
  } finally { f.close(); }
});

test("a resumed read-only lane releases an old source link before package code runs", async () => {
  const f = fixture();
  try {
    fs.symlinkSync(f.source, f.local, "dir");
    isolateWorktreeDependencies(f.pipeline);
    expect(fs.existsSync(f.local)).toBe(false);
    expect(await prepareWorktreeDependencies(f.pipeline, { platform: "win32", copyFile: unavailable })).toBe("copy");
    fs.mkdirSync(path.join(f.local, "fixture"), { recursive: true });
    fs.writeFileSync(path.join(f.local, "fixture/existing-link.js"), "generated\n");
    expect(fs.existsSync(path.join(f.source, "fixture/existing-link.js"))).toBe(false);
  } finally { f.close(); }
});

test.each(["darwin", "linux", "win32"] as const)("%s keeps a writable lane private when CoW is unavailable", async platform => {
  const f = fixture(true);
  try {
    expect(await prepareWorktreeDependencies(f.pipeline, { platform, copyFile: unavailable })).toBe("copy");
    expect(fs.realpathSync(f.local)).not.toBe(fs.realpathSync(f.source));
    fs.writeFileSync(path.join(f.local, "fixture/generated.js"), "generated\n");
    expect(fs.existsSync(path.join(f.source, "fixture/generated.js"))).toBe(false);
  } finally { f.close(); }
});

test.each(["ENOSPC", "EACCES"])("a %s clone failure preserves the source and reports failure without linking", async code => {
  const f = fixture();
  try {
    await expect(prepareWorktreeDependencies(f.pipeline, { platform: "linux", copyFile: async () => {
      throw Object.assign(new Error(code), { code });
    } })).rejects.toThrow(code);
    expect(fs.existsSync(f.local)).toBe(false);
    expect(fs.readFileSync(path.join(f.source, "fixture/index.js"), "utf8")).toBe("original\n");
    expect(fs.readdirSync(f.pipeline.worktreeDir).sort()).toEqual(["package-lock.json", "package.json"]);
  } finally { f.close(); }
});

test.each(["manifest", "lock", "workspace", "external-link", "existing", "abort"])("sharing handles %s without exposing writable source dependencies", async shape => {
  const f = fixture(true);
  try {
    if (shape === "manifest") fs.writeFileSync(path.join(f.pipeline.worktreeDir, "package.json"), JSON.stringify({ dependencies: {} }));
    if (shape === "lock") fs.writeFileSync(path.join(f.pipeline.worktreeDir, "package-lock.json"), "changed");
    if (shape === "workspace") for (const dir of [f.pipeline.repoDir, f.pipeline.worktreeDir]) fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    if (shape === "external-link") fs.symlinkSync(f.root, path.join(f.source, "outside"));
    if (shape === "existing") fs.mkdirSync(f.local);
    const abort = new AbortController(); if (shape === "abort") abort.abort();
    const operation = prepareWorktreeDependencies(f.pipeline, { platform: "linux", copyFile: async (a, b) => fs.promises.copyFile(a, b), signal: abort.signal });
    if (shape === "abort") await expect(operation).rejects.toThrow();
    else expect(await operation).toBe(shape === "existing" ? "unchanged" : "private-install");
    expect(fs.lstatSync(f.source).isDirectory()).toBe(true);
  } finally { f.close(); }
});

test("the native filesystem either produces an independent CoW tree or takes the explicit fallback", async () => {
  const f = fixture(true);
  try {
    const result = await prepareWorktreeDependencies(f.pipeline);
    expect(["clone", "copy"]).toContain(result);
    if (result === "clone") {
      fs.writeFileSync(path.join(f.local, "fixture/index.js"), "new\n");
      expect(fs.readFileSync(path.join(f.source, "fixture/index.js"), "utf8")).toBe("original\n");
    } else {
      expect(fs.realpathSync(f.local)).not.toBe(fs.realpathSync(f.source));
      fs.writeFileSync(path.join(f.local, "fixture/generated.js"), "generated\n");
      expect(fs.existsSync(path.join(f.source, "fixture/generated.js"))).toBe(false);
    }
  } finally { f.close(); }
});

test.each(["missing", "lagging-link", "lagging-directory", "matching"].flatMap(shape => ["sync", "async"].map(mode => [shape, mode])))("lockfile cache repairs %s dependencies during %s provisioning", async (shape, mode) => {
  const f = await lockedFixture();
  try {
    const source = path.join(f.repoDir, "node_modules"), local = path.join(f.worktreeDir, "node_modules");
    if (shape === "missing") fs.rmSync(source, { recursive: true });
    if (shape === "lagging-link" || shape === "lagging-directory") {
      await f.makeLagging();
      expect(JSON.parse(fs.readFileSync(path.join(source, "fixture-tool/package.json"), "utf8")).version).toBe("1.0.0");
      if (shape === "lagging-link") fs.symlinkSync(source, local, "dir");
      else fs.cpSync(source, local, { recursive: true });
    }
    const provisioned = mode === "sync" ? await provisionPipelineWorktree(f.pipeline, realExec)
      : await provisionPipelineWorktreeAsync(f.pipeline, (command, args, cwd, signal, options) =>
        Promise.resolve(realExec(command, args, cwd, options?.env, { ...options, signal })));
    expect(provisioned).toMatchObject({ ok: true });
    expect(JSON.parse(fs.readFileSync(path.join(local, "fixture-tool/package.json"), "utf8")).version).toBe("2.0.0");
    expect(fs.lstatSync(local).isSymbolicLink()).toBe(true);
    const resolved = fs.realpathSync(local);
    expect(resolved).not.toBe(source);
    expect(fs.existsSync(path.join(f.worktreeDir, "lifecycle-ran"))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(resolved), "lifecycle-ran"))).toBe(false);
    await prepareWorktreeDependencies(f.pipeline);
    expect(fs.realpathSync(local)).toBe(resolved);
    fs.writeFileSync(path.join(f.repoDir, ".git/hooks/pre-commit"), "#!/bin/sh\nnode_modules/.bin/fixture-tool || exit $?\nprintf checked > \"$(git rev-parse --git-common-dir)/commit-hook-ran\"\n", { mode: 0o755 });
    fs.writeFileSync(path.join(f.worktreeDir, "change.txt"), "stage output\n");
    await f.run(["git", "add", "change.txt"], f.worktreeDir);
    await f.run(["git", "-c", "user.name=Fixture", "-c", `user.email=${["noreply", "example.invalid"].join("@")}`, "commit", "-m", "hooked stage output"], f.worktreeDir);
    expect(fs.readFileSync(path.join(f.repoDir, ".git/commit-hook-ran"), "utf8")).toBe("checked");
    if (shape === "lagging-link") expect(JSON.parse(fs.readFileSync(path.join(source, "fixture-tool/package.json"), "utf8")).version).toBe("1.0.0");
  } finally { f.close(); }
}, 30_000);


test("a real post-merge hook switches to the merged lockfile and a new process reuses it", async () => {
  const f = await lockedFixture();
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules");
    const original = fs.realpathSync(local);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.repoDir, "package.json"), "utf8"));
    manifest.devDependencies["fixture-tool"] = `http://127.0.0.1:${f.server.port}/next.tgz`;
    fs.writeFileSync(path.join(f.repoDir, "package.json"), JSON.stringify(manifest));
    await f.run(["bun", "install", "--ignore-scripts", "--backend=copyfile"]);
    await f.run(["git", "add", "."]);
    await f.run(["git", "-c", "user.name=Fixture", "-c", `user.email=${["noreply", "example.invalid"].join("@")}`, "commit", "-m", "next dependency"]);
    fs.symlinkSync(path.resolve("scripts"), path.join(f.worktreeDir, "scripts"), "dir");
    fs.copyFileSync(path.resolve(".githooks/post-merge"), path.join(f.repoDir, ".git/hooks/post-merge"));
    await f.run(["git", "-c", "user.name=Fixture", "-c", `user.email=${["noreply", "example.invalid"].join("@")}`, "merge", "--no-ff", "main", "-m", "merge dependencies"], f.worktreeDir);
    expect(fs.realpathSync(local)).not.toBe(original);
    expect(JSON.parse(fs.readFileSync(path.join(local, "fixture-tool/package.json"), "utf8")).version).toBe("3.0.0");
    f.server.stop(true);
    await f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir);
    expect(fs.existsSync(path.join(f.worktreeDir, "lifecycle-ran"))).toBe(false);
  } finally { f.close(); }
}, 30_000);

test("an unrepaired lockfile is an environment refusal and preserves the installed link", async () => {
  const f = await lockedFixture();
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules"), before = fs.realpathSync(local);
    fs.writeFileSync(path.join(f.worktreeDir, "bun.lock"), "invalid lockfile");
    await expect(prepareWorktreeDependencies(f.pipeline)).rejects.toThrow("stage environment: dependency preparation failed: frozen dependency installation failed");
    await expect(prepareWorktreeDependencies(f.pipeline)).rejects.toThrow(/ParserError.*bun.lock:1:1/);
    const hook = await realExec("bun", [path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir);
    expect(hook.code).toBe(1);
    expect(hook.stderr).toContain("stage environment: dependency preparation failed");
    expect(hook.stderr).toContain("ParserError");
    expect(hook.stderr).toContain("bun.lock:1:1");
    const provisioned = await provisionPipelineWorktree(f.pipeline, realExec);
    expect(provisioned).toMatchObject({ ok: false, error: expect.stringMatching(/ParserError.*bun.lock:1:1/) });
    expect(fs.realpathSync(local)).toBe(before);
    expect(fs.readdirSync(path.join(f.repoDir, ".git/delegatus-dependencies/v4")).some(name => name.startsWith("building-"))).toBe(false);
  } finally { f.close(); }
}, 30_000);

test("a malformed manifest is an environment refusal and preserves the installed tools", async () => {
  const f = await lockedFixture();
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules"), before = fs.realpathSync(local);
    expect(JSON.parse(fs.readFileSync(path.join(local, "fixture-tool/package.json"), "utf8")).version).toBe("2.0.0");
    fs.writeFileSync(path.join(f.worktreeDir, "package.json"), '{"name":"delegatus-cli",');
    await expect(prepareWorktreeDependencies(f.pipeline)).rejects.toThrow("stage environment: dependency preparation failed: invalid dependency manifest");
    expect(fs.realpathSync(local)).toBe(before);
  } finally { f.close(); }
}, 30_000);

test.each(["cache-hit", "stale-link", "invalid-lock", "ENOSPC", "EEXIST", "hook-install", "hook-registry", "hook-privacy"])("publication retains the dependency contract for %s", async shape => {
  const f = await lockedFixture({ registry: shape === "hook-registry" });
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules"), before = fs.realpathSync(local);
    if (shape === "stale-link") {
      await f.makeLagging();
      fs.unlinkSync(local);
      fs.symlinkSync(path.join(f.repoDir, "node_modules"), local, "dir");
      expect(JSON.parse(fs.readFileSync(path.join(local, "fixture-tool/package.json"), "utf8")).version).toBe("1.0.0");
    }
    const origin = path.join(f.root, "origin.git");
    await f.run(["git", "init", "--bare", "--initial-branch=main", origin]);
    await f.run(["git", "remote", "add", "origin", origin]);
    if (shape === "hook-install" || shape === "hook-registry") fs.writeFileSync(path.join(f.repoDir, ".git/hooks/pre-push"),
      "#!/bin/sh\necho 'pre-push: frozen install' >&2\nexec bun install --frozen-lockfile\n", { mode: 0o755 });
    if (shape === "hook-privacy") fs.writeFileSync(path.join(f.repoDir, ".git/hooks/pre-push"),
      "#!/bin/sh\necho 'PRIVACY GATE: FAIL' >&2\necho 'pre-push: frozen install' >&2\necho EEXIST >&2\nexit 1\n", { mode: 0o755 });
    if (shape === "invalid-lock") fs.writeFileSync(path.join(f.worktreeDir, "bun.lock"), "invalid lockfile");
    const installerRefusal = shape === "ENOSPC" || shape === "EEXIST";
    if (installerRefusal) {
      const manifest = JSON.parse(fs.readFileSync(path.join(f.worktreeDir, "package.json"), "utf8"));
      manifest.description = "new dependency cache input";
      fs.writeFileSync(path.join(f.worktreeDir, "package.json"), JSON.stringify(manifest));
    }
    await f.run(["git", "add", "."], f.worktreeDir);
    await f.run(["git", "-c", "user.name=Fixture", "-c", `user.email=${["noreply", "example.invalid"].join("@")}`, "commit", "--allow-empty", "-m", "accepted stage"], f.worktreeDir);
    const head = (await realExec("git", ["rev-parse", "HEAD"], f.worktreeDir)).stdout.trim();
    f.pipeline.lastPassedCommit = head;
    f.pipeline.delivery = { target: { repository: "fixture", remote: origin, branch: `refs/heads/${f.pipeline.branch}` },
      ownerId: f.pipeline.id, epoch: 1, active: true, disposition: "owner", publish: "enabled", journal: [] };
    savePipelines([f.pipeline]);
    let installs = 0, pushes = 0;
    const exec: ExecPort = async (command, args, cwd, env, options) => {
      if (command === "bun" && args[0] === "install") {
        installs++;
        if (installerRefusal) return { code: 1, stdout: "", stderr: `error: ${shape}` };
      }
      if (command === "git" && args[0] === "push") pushes++;
      return realExec(command, args, cwd, env, options);
    };
    const published = await publishPipelineBranch(f.pipeline, exec, { acceptedSha: head });
    if (shape === "cache-hit" || shape === "stale-link" || shape === "hook-registry" || shape === "hook-install" && published.ok) {
      expect(published).toMatchObject({ ok: true, sha: head, remote: "published" });
      expect(installs).toBe(0);
      expect(pushes).toBe(1);
      if (shape !== "hook-install" && shape !== "hook-registry") {
        // A second accepted revision runs preparation again instead of replaying
        // the first publication receipt. The sealed graph needs no installer.
        f.server.stop(true);
        fs.writeFileSync(path.join(f.worktreeDir, "second-stage.txt"), "second accepted stage\n");
        await f.run(["git", "add", "second-stage.txt"], f.worktreeDir);
        await f.run(["git", "-c", "user.name=Fixture", "-c", `user.email=${["noreply", "example.invalid"].join("@")}`, "commit", "-m", "second accepted stage"], f.worktreeDir);
        const next = (await realExec("git", ["rev-parse", "HEAD"], f.worktreeDir)).stdout.trim();
        const current = findPipelineRecord(f.pipeline.id)!;
        current.lastPassedCommit = next;
        savePipelines([current]);
        expect(await publishPipelineBranch(current, exec, { acceptedSha: next })).toMatchObject({ ok: true, sha: next, remote: "published" });
        expect(installs).toBe(0);
        expect(pushes).toBe(2);
        expect(fs.realpathSync(local)).toBe(before);
      }
    } else if (shape === "hook-privacy") {
      expect(published.ok).toBe(false);
      if (published.ok) throw new Error("expected privacy refusal");
      expect(published.error).toContain("PRIVACY GATE: FAIL");
      expect(published.error).not.toContain("stage environment:");
      expect(published.failure?.step).toBe("publishing the pipeline branch");
      expect(installs).toBe(0);
      expect(pushes).toBe(1);
    } else {
      expect(published.ok).toBe(false);
      if (published.ok) throw new Error("expected environment refusal");
      const cause = shape === "invalid-lock" ? "ParserError" : shape === "hook-install"
        ? /\b(?:EEXIST|EACCES|EPERM|EROFS)\b/.exec(published.failure?.outputTail ?? "")?.[0] : shape;
      expect(cause).toBeDefined();
      expect(published.error).toContain("stage environment: dependency preparation failed");
      expect(published.error).toContain(cause!);
      expect(published.failure?.step).toBe("preparing publication dependencies");
      expect(publicationFailureCause(published.failure!)).toContain(cause!);
      if (shape === "invalid-lock") expect(published.error).toContain("bun.lock:1:1");
      expect(installs).toBe(shape === "hook-install" ? 0 : 1);
      expect(pushes).toBe(shape === "hook-install" ? 1 : 0);
      // Reading the settled receipt preserves the classified refusal.
      expect(findPipelineRecord(f.pipeline.id)!.delivery!.operation!.result).toEqual(published);
      expect(installs).toBe(shape === "hook-install" ? 0 : 1);
    }
    expect(fs.realpathSync(local)).toBe(before);
    expect(JSON.parse(fs.readFileSync(path.join(local, "fixture-tool/package.json"), "utf8")).version).toBe("2.0.0");
  } finally { savePipelines([]); f.close(); }
}, 30_000);

test("installer causes exclude secret and path bytes from both streams before bounding", () => {
  const credential = "fixture-" + "sensitive".repeat(2000);
  const result = { code: 1, stdout: `ENOSPC\nhttps://registry.invalid/?credential=${credential}`,
    stderr: `EACCES\nParserError at bun.lock:1:1\n${credential}\n` + path.join(os.homedir(), "private-source") };
  expect(dependencyInstallFailure(result)).toBe("stage environment: dependency preparation failed: frozen dependency installation failed (exit 1): ParserError; ENOSPC; EACCES; bun.lock:1:1");
  expect(dependencyInstallFailure({ code: null, stdout: "", stderr: "dependency command timed out" })).toContain("interrupted): dependency command timed out");
  expect(dependencyInstallFailure({ code: 1, stdout: credential, stderr: "" })).toContain("installer diagnostic withheld (unrecognized cause)");
  const mismatch = dependencyInstallFailure({ code: 1, stdout: "", stderr: "error: lockfile had changes, but lockfile is frozen" });
  expect(publicationFailureCause({ step: "preparing publication dependencies", code: 1,
    signal: null, durationMs: 0, outputTail: mismatch })).toContain("frozen lockfile does not match the manifest");
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable manifest is an environment refusal and preserves the installed tools", async () => {
  const f = await lockedFixture();
  const manifest = path.join(f.worktreeDir, "package.json");
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules"), before = fs.realpathSync(local);
    fs.chmodSync(manifest, 0o000);
    await expect(prepareWorktreeDependencies(f.pipeline)).rejects.toThrow("stage environment: dependency preparation failed");
    const hook = await realExec("bun", [path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir);
    expect(hook.code).toBe(1);
    expect(hook.stderr).toContain("stage environment: dependency preparation failed");
    expect(fs.realpathSync(local)).toBe(before);
    expect(JSON.parse(fs.readFileSync(path.join(local, "fixture-tool/package.json"), "utf8")).version).toBe("2.0.0");
  } finally { fs.chmodSync(manifest, 0o600); f.close(); }
}, 30_000);

test("a plain frozen registry install refreshes root and nested CLI links without changing shared packages", async () => {
  const f = await lockedFixture({ registry: true });
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules"), shared = fs.realpathSync(local);
    const snapshot = (directory: string, modes = true): string[] => fs.readdirSync(directory).sort().flatMap(name => {
      const filename = path.join(directory, name), entry = fs.lstatSync(filename);
      const row = `${path.relative(shared, filename)}:${modes ? entry.mode : entry.isDirectory() ? "directory" : "file"}`;
      if (entry.isSymbolicLink()) return [`${row}>${fs.readlinkSync(filename)}`];
      return entry.isDirectory() ? [row, ...snapshot(filename, modes)] : [`${row}=${fs.readFileSync(filename, "base64")}`];
    });
    const before = snapshot(shared), bytes = snapshot(shared, false);
    for (const prefix of ["", "fixture-parent/node_modules/"]) {
      expect(fs.readlinkSync(path.join(local, prefix, ".bin/fixture-tool"))).toBe("../fixture-tool/cli.js");
    }
    // This is the serving publisher's command, including scripts and its
    // default backend, rather than this branch's cache-reuse optimization.
    for (let attempt = 0; attempt < 2; attempt++) {
      const installed = await realExec("bun", ["install", "--frozen-lockfile"], f.worktreeDir,
        { NODE_ENV: "development" }, { timeoutMs: 20_000 });
      expect(installed.code, installed.stderr).toBe(0);
      expect(snapshot(shared, false)).toEqual(bytes);
      // The next real bootstrap runs in a fresh process and re-seals the CLI
      // modes Bun changes, using the bounded executable list in the receipt.
      await f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir);
      expect(snapshot(shared)).toEqual(before);
    }
    expect(fs.existsSync(path.join(f.worktreeDir, "lifecycle-ran"))).toBe(true);
    expect(() => fs.writeFileSync(path.join(local, "fixture-tool/index.js"), "tampered\n")).toThrow();
    expect(() => fs.rmSync(path.join(local, "fixture-tool"), { recursive: true, force: true })).toThrow();
    expect(snapshot(shared)).toEqual(before);
  } finally { f.close(); }
}, 30_000);

test.skipIf(process.platform !== "linux" || !Bun.which("strace"))("a frozen reinstall interrupted by ENOSPC cannot admit a broken CLI cache", async () => {
  const f = await lockedFixture({ registry: true });
  try {
    expect(await provisionPipelineWorktree(f.pipeline, realExec)).toMatchObject({ ok: true });
    const local = path.join(f.worktreeDir, "node_modules"), shared = fs.realpathSync(local);
    const payload = path.join(shared, "fixture-tool/cli.js"), bytes = fs.readFileSync(payload), inode = fs.statSync(payload).ino;
    const interrupted = await realExec("strace", ["-f", "-e", "inject=symlink:error=ENOSPC:when=2",
      "bun", "install", "--frozen-lockfile", "--ignore-scripts"], f.worktreeDir,
    { NODE_ENV: "development" }, { timeoutMs: 20_000 });
    expect(interrupted.code, interrupted.stderr).not.toBe(0);
    expect(interrupted.stderr).toContain("ENOSPC");
    expect([".bin/fixture-tool", "fixture-parent/node_modules/.bin/fixture-tool"]
      .some(file => !fs.existsSync(path.join(shared, file)))).toBe(true);
    const second = buildPipeline({ id: "87654321", task: f.pipeline.task, project: f.pipeline.project,
      repoDir: f.repoDir, stages: f.pipeline.stages, srcPath: null, srcConversationId: null, now: "2026-10-29T00:00:00.000Z" });
    second.baseBranch = f.pipeline.baseBranch;
    second.baseRef = f.pipeline.baseRef;
    const refused = await provisionPipelineWorktree(second, realExec);
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) {
      expect(refused.error).toContain("stage environment: dependency preparation failed");
      expect(refused.error).toContain("ENOENT");
    }
    expect(fs.existsSync(path.join(second.worktreeDir, "node_modules"))).toBe(false);
    await expect(f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir)).rejects.toThrow("ENOENT");
    expect(fs.realpathSync(local)).toBe(shared);
    // An ordinary reinstall can recover the writable links in place.
    await f.run(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], f.worktreeDir);
    expect(await provisionPipelineWorktree(second, realExec)).toMatchObject({ ok: true });
    expect(fs.realpathSync(path.join(second.worktreeDir, "node_modules"))).toBe(shared);
    await f.run(["node_modules/.bin/fixture-tool"], second.worktreeDir);
    expect(fs.readFileSync(payload)).toEqual(bytes);
    expect(fs.statSync(payload).ino).toBe(inode);
  } finally { f.close(); }
}, 30_000);

test.each(["production = true", "dev = false"])("committed bunfig %s retains development tools through cache reuse", async setting => {
  const f = await lockedFixture();
  try {
    expect(await provisionPipelineWorktree(f.pipeline, realExec)).toMatchObject({ ok: true });
    const local = path.join(f.worktreeDir, "node_modules"), previous = fs.realpathSync(local);
    const config = `[install]\n${setting}\n[install.cache]\ndisable = true\n`;
    fs.writeFileSync(path.join(f.repoDir, "bunfig.toml"), config);
    await f.run(["git", "add", "bunfig.toml"]);
    await f.run(["git", "-c", "user.name=Fixture", "-c", `user.email=${["noreply", "example.invalid"].join("@")}`,
      "commit", "-m", "application install options"]);
    await f.run(["git", "merge", "--ff-only", "main"], f.worktreeDir);
    f.pipeline.baseRef = (await realExec("git", ["rev-parse", "HEAD"], f.worktreeDir)).stdout.trim();
    expect(await provisionPipelineWorktree(f.pipeline, realExec)).toMatchObject({ ok: true });
    await f.run(["node_modules/.bin/fixture-tool"], f.worktreeDir);
    const shared = fs.realpathSync(local);
    expect(shared).not.toBe(previous);
    expect(fs.readFileSync(path.join(f.worktreeDir, "bunfig.toml"), "utf8")).toBe(config);
    expect(fs.readFileSync(path.join(path.dirname(shared), "bunfig.toml"), "utf8")).toBe(config);
    expect(fs.existsSync(path.join(path.dirname(shared), "lifecycle-ran"))).toBe(false);
    f.server.stop(true);
    await f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir);
    expect(fs.realpathSync(local)).toBe(shared);
    await f.run(["node_modules/.bin/fixture-tool"], f.worktreeDir);
    expect(fs.existsSync(path.join(previous, "fixture-tool/cli.js"))).toBe(true);
  } finally { f.close(); }
}, 30_000);

test.each(["root", "nested", "replaced"])("a %s CLI link defect refuses preparation in a fresh process", async shape => {
  const f = await lockedFixture({ registry: true });
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules"), shared = fs.realpathSync(local);
    const link = path.join(shared, shape === "nested" ? "fixture-parent/node_modules/.bin/fixture-tool" : ".bin/fixture-tool");
    fs.unlinkSync(link);
    if (shape === "replaced") fs.mkdirSync(link);
    await expect(f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir))
      .rejects.toThrow(shape === "replaced" ? "dependency CLI link changed" : "dependency CLI link unavailable (ENOENT)");
    expect(fs.realpathSync(local)).toBe(shared);
    expect(fs.existsSync(path.join(shared, "fixture-tool/cli.js"))).toBe(true);
  } finally { f.close(); }
}, 30_000);

test("an invalid bunfig refuses installation before replacing working tools", async () => {
  const f = await lockedFixture();
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules"), previous = fs.realpathSync(local);
    fs.writeFileSync(path.join(f.worktreeDir, "bunfig.toml"), "[install]\nproduction = [\n");
    // Call the real provisioner with the same persisted base, as on retry.
    const refused = await provisionPipelineWorktree(f.pipeline, realExec);
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) expect(refused.error).toContain("stage environment: dependency preparation failed");
    expect(fs.realpathSync(local)).toBe(previous);
    await f.run(["node_modules/.bin/fixture-tool"], f.worktreeDir);
    const cache = path.dirname(path.dirname(previous));
    expect(fs.readdirSync(cache).filter(name => /^[a-f0-9]{64}$/.test(name))).toHaveLength(1);
  } finally { f.close(); }
}, 30_000);

test("a receipt with a missing required package refuses reuse in a fresh process", async () => {
  const f = await lockedFixture();
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules"), shared = fs.realpathSync(local);
    const packageDir = path.join(shared, "fixture-tool");
    fs.chmodSync(packageDir, 0o755);
    fs.unlinkSync(path.join(packageDir, "package.json"));
    await expect(f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir))
      .rejects.toThrow("required dependency unavailable (ENOENT)");
    expect(fs.realpathSync(local)).toBe(shared);
  } finally { f.close(); }
}, 30_000);

test("a worktree install preserves an already shared input graph", async () => {
  const f = await lockedFixture();
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules"), shared = fs.realpathSync(local);
    expect(fs.lstatSync(local).isSymbolicLink()).toBe(true);
    const version = (directory: string) => JSON.parse(fs.readFileSync(path.join(directory, "fixture-tool/package.json"), "utf8")).version;
    const exportedVersion = async (directory: string) => {
      const result = await realExec("node", ["-p", "require(process.argv[1])", path.join(directory, "fixture-tool")], f.worktreeDir,
        undefined, { timeoutMs: 20_000 });
      expect(result.code).toBe(0);
      return result.stdout.trim();
    };
    // Every entry's path, mode and bytes: a write anywhere in the graph shows.
    const tree = (directory: string): string[] => fs.readdirSync(directory).sort().flatMap(name => {
      const file = path.join(directory, name), entry = fs.lstatSync(file);
      const row = `${path.relative(shared, file)}:${entry.mode}`;
      if (entry.isSymbolicLink()) return [`${row}>${fs.readlinkSync(file)}`];
      return entry.isDirectory() ? [row, ...tree(file)] : [`${row}=${fs.readFileSync(file, "base64")}`];
    });
    const sealed = tree(shared);
    expect(version(shared)).toBe("2.0.0");
    expect(await exportedVersion(shared)).toBe("2.0.0");
    // The serving publisher can still use a plain frozen install. Its refusal
    // must identify the environment and retain the installer's cause.
    const unchanged = await realExec("bun", ["install", "--frozen-lockfile"], f.worktreeDir,
      { NODE_ENV: "development" }, { timeoutMs: 20_000 });
    if (unchanged.code !== 0) {
      expect(dependencyInstallFailure(unchanged)).toContain("stage environment: dependency preparation failed");
      expect(dependencyInstallFailure(unchanged)).toContain("EEXIST");
      expect(publicationFailureCause({ step: "preparing publication dependencies", code: unchanged.code,
        signal: null, durationMs: 0, outputTail: unchanged.stderr })).toContain("EEXIST");
    } else expect(unchanged.code).toBe(0);
    expect(tree(shared)).toEqual(sealed);
    expect(() => fs.writeFileSync(path.join(local, "fixture-tool/index.js"), "tampered\n")).toThrow();
    expect(() => fs.rmSync(path.join(local, "fixture-tool"), { recursive: true, force: true })).toThrow();
    expect(tree(shared)).toEqual(sealed);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.worktreeDir, "package.json"), "utf8"));
    manifest.devDependencies["fixture-tool"] = `http://127.0.0.1:${f.server.port}/next.tgz`;
    fs.writeFileSync(path.join(f.worktreeDir, "package.json"), JSON.stringify(manifest));
    const reflex = await realExec("bun", ["install"], f.worktreeDir, { NODE_ENV: "development" }, { timeoutMs: 20_000 });
    expect([0, 1].includes(reflex.code ?? -1), reflex.stderr).toBe(true);
    expect(tree(shared)).toEqual(sealed);
    await f.run(["bun", "install", "--lockfile-only", "--ignore-scripts"], f.worktreeDir);
    const installed = await realExec("bun", ["install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile"], f.worktreeDir,
      { NODE_ENV: "development" }, { timeoutMs: 20_000 });
    expect([0, 1].includes(installed.code ?? -1)).toBe(true);
    if (installed.code === 0) expect(version(local)).toBe("3.0.0");
    expect(tree(shared)).toEqual(sealed);
    expect(await exportedVersion(shared)).toBe("2.0.0");
    await prepareWorktreeDependencies(f.pipeline);
    expect(version(local)).toBe("3.0.0");
    expect(await exportedVersion(local)).toBe("3.0.0");
    expect(version(shared)).toBe("2.0.0");
    expect(await exportedVersion(shared)).toBe("2.0.0");
  } finally { f.close(); }
}, 30_000);

test.each(["clone", "copy"])("a %s from a sealed shared graph gives another repository writable private dependencies", async mode => {
  const f = await lockedFixture();
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const shared = fs.realpathSync(path.join(f.worktreeDir, "node_modules"));
    const repoDir = path.join(f.root, "other");
    const pipeline = buildPipeline({ id: "87654321", task: "private dependency fixture", project: "fixture", repoDir,
      stages: [], srcPath: null, srcConversationId: null, now: "2026-10-29T00:00:00.000Z" });
    for (const directory of [repoDir, pipeline.worktreeDir]) {
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "another-project" }));
    }
    fs.symlinkSync(shared, path.join(repoDir, "node_modules"), "dir");
    const sourceFile = path.join(shared, "fixture-tool/index.js");
    const before = fs.readFileSync(sourceFile), sourceMode = fs.statSync(sourceFile).mode;
    const copied = await prepareWorktreeDependencies(pipeline, { platform: "linux", copyFile: mode === "copy" ? unavailable
      : async (source, target) => fs.promises.copyFile(source, target) });
    expect(copied).toBe(mode);
    const local = path.join(pipeline.worktreeDir, "node_modules");
    expect(fs.lstatSync(local).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(local, "fixture-tool/index.js"))).toEqual(before);
    expect(fs.statSync(path.join(local, ".bin/fixture-tool")).mode & 0o111).not.toBe(0);
    fs.writeFileSync(path.join(local, "fixture-tool/index.js"), "private replacement\n");
    fs.writeFileSync(path.join(local, "fixture-tool/generated.js"), "private cache\n");
    expect(fs.readFileSync(sourceFile)).toEqual(before);
    expect(fs.statSync(sourceFile).mode).toBe(sourceMode);
    expect(fs.existsSync(path.join(shared, "fixture-tool/generated.js"))).toBe(false);
  } finally { f.close(); }
}, 30_000);

test("two fresh processes share one completed installation", async () => {
  const f = await lockedFixture();
  try {
    await Promise.all([0, 1].map(() => f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir)));
    const cache = path.join(f.repoDir, ".git/delegatus-dependencies/v4");
    expect(fs.readdirSync(cache).filter(name => /^[a-f0-9]{64}$/.test(name))).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(f.worktreeDir, "node_modules/fixture-tool/package.json"), "utf8")).version).toBe("2.0.0");
  } finally { f.close(); }
}, 30_000);

// The timeout covers fixture migration under the gate's I/O limits. Each
// warm child independently refuses any attempt to walk the payload.
test("a real-sized sealed inventory skips the walk in fresh linked and provisioning processes", async () => {
  const f = await lockedFixture();
  try {
    await prepareLockedDependencies(f.worktreeDir);
    const modules = fs.realpathSync(path.join(f.worktreeDir, "node_modules"));
    // Populate read-only payload separately from the cold installer, which
    // chmods each entry serially. The changed root makes the real writer
    // validate the complete inventory and refresh the fingerprint.
    const payload = path.join(modules, "large-payload");
    fs.chmodSync(modules, 0o755);
    fs.mkdirSync(payload);
    for (let directory = 0; directory < 407; directory++) {
      const fixture = path.join(payload, `group-${directory}`);
      fs.mkdirSync(fixture);
      for (let entry = 0; entry < 100; entry++) {
        fs.writeFileSync(path.join(fixture, `file-${entry}.js`), "", { mode: 0o444 });
      }
      fs.chmodSync(fixture, 0o555);
    }
    fs.chmodSync(payload, 0o555);
    fs.chmodSync(modules, 0o555);
    await expect(prepareLockedDependencies(f.worktreeDir)).resolves.toBe(true);
    const newcomer = await f.addWorktree("large-graph-new-link");
    const check = `
      import fs from "node:fs";
      const lstat = fs.promises.lstat, readdir = fs.promises.readdir;
      fs.promises.lstat = (file, ...args) => {
        if (String(file).startsWith(${JSON.stringify(payload)}))
          throw new Error("warm validation statted a payload entry");
        return lstat(file, ...args);
      };
      fs.promises.readdir = (file, ...args) => {
        if (String(file).startsWith(${JSON.stringify(modules)})) throw new Error("warm validation walked the sealed graph");
        return readdir(file, ...args);
      };
      await import(${JSON.stringify(path.resolve("scripts/prepare-stage-dependencies.ts"))});`;
    for (const cwd of [f.worktreeDir, newcomer]) {
      await f.run([process.execPath, "-e", check], cwd);
      expect(fs.realpathSync(path.join(cwd, "node_modules"))).toBe(modules);
    }
  } finally { f.close(); }
}, 150_000);

test.each(["missing", "malformed", "stale"] as const)("a %s validation receipt walks and refreshes the fenced inventory", async shape => {
  const f = await lockedFixture();
  try {
    await prepareLockedDependencies(f.worktreeDir);
    const modules = fs.realpathSync(path.join(f.worktreeDir, "node_modules"));
    const receipt = path.join(path.dirname(modules), "validated.sha256");
    const original = fs.readFileSync(receipt, "ascii");
    if (shape === "missing") fs.unlinkSync(receipt);
    if (shape === "malformed") fs.writeFileSync(receipt, "{");
    if (shape === "stale") fs.chmodSync(modules, 0o755);
    const readdir = fs.promises.readdir;
    let walks = 0;
    const hook = spyOn(fs.promises, "readdir").mockImplementation((...args) => {
      if (args[0] === modules) walks++;
      return Reflect.apply(readdir, fs.promises, args);
    });
    try {
      await expect(prepareLockedDependencies(f.worktreeDir)).resolves.toBe(true);
      expect(walks).toBeGreaterThan(0);
      const refreshed = fs.readFileSync(receipt, "ascii");
      expect(refreshed).toMatch(/^[a-f0-9]{64}$/);
      if (shape !== "stale") expect(refreshed).toBe(original);
      expect(fs.statSync(modules).mode & 0o222).toBe(0);
      walks = 0;
      await expect(prepareLockedDependencies(f.worktreeDir)).resolves.toBe(true);
      expect(walks).toBe(0);
    } finally { hook.mockRestore(); }
  } finally { f.close(); }
}, 30_000);

test("a partly written installation stays unpublished while the writer is active and after validation refuses it", async () => {
  const f = await lockedFixture();
  const partial = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let writing: Promise<boolean> | undefined;
  try {
    const peer = await f.addWorktree("partial-graph-peer");
    writing = prepareLockedDependencies(f.worktreeDir, { exec: async (...args) => {
      const result = await realExec(...args);
      if (args[0] === "bun" && result.code === 0) {
        fs.unlinkSync(path.join(args[2]!, "node_modules", "fixture-tool", "package.json"));
        partial.resolve();
        await finish.promise;
      }
      return result;
    } });
    void writing.catch(partial.reject);
    await partial.promise;
    const controller = new AbortController();
    await expect(prepareLockedDependencies(peer, {
      signal: controller.signal, onWriterWait: () => controller.abort(),
    })).rejects.toThrow(/\[wait: repository writer fence/);
    expect(fs.existsSync(path.join(peer, "node_modules"))).toBe(false);
    expect(fs.readdirSync(f.cache).filter(name => /^[a-f0-9]{64}$/.test(name))).toEqual([]);
    finish.resolve();
    await expect(writing).rejects.toThrow("required dependency unavailable (ENOENT)");
    expect(fs.readdirSync(f.cache)).toEqual(["owner.lock"]);
    expect(fs.existsSync(path.join(f.worktreeDir, "node_modules"))).toBe(false);
    await expect(prepareLockedDependencies(peer)).resolves.toBe(true);
  } finally { finish.resolve(); await writing?.catch(() => {}); f.close(); }
}, 30_000);

test.each([1, 2])("full validation notices a CLI link removed after graph read %i", async removeAfterRead => {
  const f = await lockedFixture({ registry: true });
  let restore: (() => void) | undefined;
  try {
    await prepareLockedDependencies(f.worktreeDir);
    const local = path.join(f.worktreeDir, "node_modules"), modules = fs.realpathSync(local);
    fs.unlinkSync(path.join(path.dirname(modules), "validated.sha256"));
    const cli = path.join(modules, ".bin/fixture-tool"), lstat = fs.promises.lstat;
    let reads = 0;
    function intercept(filename: fs.PathLike, options: StatOptions & { bigint: true }): Promise<BigIntStats>;
    function intercept(filename: fs.PathLike, options?: StatOptions): Promise<Stats>;
    function intercept(filename: fs.PathLike, options?: StatOptions): Promise<Stats | BigIntStats> {
      const value = options?.bigint ? lstat(filename, { bigint: true }) : lstat(filename);
      return value.then(result => {
        if (filename === cli && ++reads === removeAfterRead) fs.unlinkSync(cli);
        return result;
      });
    }
    const hook = spyOn(fs.promises, "lstat").mockImplementation(intercept);
    restore = () => hook.mockRestore();
    await expect(prepareLockedDependencies(f.worktreeDir)).rejects.toThrow(/ENOENT|changed during (validation|preparation)/);
    expect(reads).toBeGreaterThanOrEqual(removeAfterRead);
    expect(fs.realpathSync(local)).toBe(modules);
    expect(fs.existsSync(cli)).toBe(false);
  } finally { restore?.(); f.close(); }
}, 30_000);

test("receipt inventory omissions refuse, and permission drift is repaired under the writer fence", async () => {
  const f = await lockedFixture({ registry: true });
  try {
    await prepareLockedDependencies(f.worktreeDir);
    const local = path.join(f.worktreeDir, "node_modules"), modules = fs.realpathSync(local);
    const receipt = path.join(path.dirname(modules), "installed.json");
    const original = JSON.parse(fs.readFileSync(receipt, "utf8"));
    fs.writeFileSync(receipt, JSON.stringify({ ...original, cliLinks: [] }));
    await expect(prepareLockedDependencies(f.worktreeDir)).rejects.toThrow("dependency receipt inventory does not match the installed graph");
    fs.writeFileSync(receipt, JSON.stringify(original));
    const payload = path.join(modules, "fixture-tool/index.js"), bin = path.join(modules, ".bin");
    fs.chmodSync(payload, 0o644);
    fs.chmodSync(bin, 0o777);
    expect(await prepareLockedDependencies(f.worktreeDir)).toBe(true);
    expect(fs.statSync(payload).mode & 0o222).toBe(0);
    expect(fs.statSync(bin).mode & 0o222).toBe(0o200);
    await f.run(["node_modules/.bin/fixture-tool"], f.worktreeDir);
  } finally { f.close(); }
}, 30_000);

test("a sealed graph with no CLI links admits from its complete empty inventory", async () => {
  const f = await lockedFixture({ registry: true, cli: false });
  try {
    await prepareLockedDependencies(f.worktreeDir);
    const modules = fs.realpathSync(path.join(f.worktreeDir, "node_modules"));
    const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(modules), "installed.json"), "utf8"));
    expect(receipt.cliLinks).toEqual([]);
    expect(await prepareLockedDependencies(f.worktreeDir)).toBe(true);
    expect(fs.realpathSync(path.join(f.worktreeDir, "node_modules"))).toBe(modules);
  } finally { f.close(); }
}, 30_000);

test("two linked hooks pass a held writer while a first link waits and performs no warm prune", async () => {
  const f = await lockedFixture();
  const hook = path.resolve("scripts/prepare-stage-dependencies.ts");
  let release: (() => void) | undefined;
  try {
    const other = await f.addWorktree("second-linked");
    const newcomer = await f.addWorktree("first-link");
    await Promise.all([f.worktreeDir, other].map(cwd => f.run(["bun", hook], cwd)));
    const modules = fs.realpathSync(path.join(other, "node_modules"));
    const receipt = path.join(path.dirname(modules), "installed.json");
    const before = fs.readFileSync(receipt);
    release = f.holdWriter();
    await Promise.all([f.worktreeDir, other].map(cwd => f.run(["bun", hook], cwd)));

    const source = `import {prepareLockedDependencies} from ${JSON.stringify(path.resolve("src/lib/pipelines/lockedDependencies.ts"))};
      let contended=false;
      try { await prepareLockedDependencies(${JSON.stringify(newcomer)}, {budgetMs:250,onWriterWait(){contended=true;}}); process.stdout.write(JSON.stringify({contended,result:"admitted"})); }
      catch (error) { process.stdout.write(JSON.stringify({contended,error:String(error)})); }`;
    const contender = Bun.spawn([process.execPath, "-e", source], { cwd: path.resolve("."), stdout: "pipe", stderr: "pipe" });
    try {
      const [code, output] = await Promise.all([contender.exited, new Response(contender.stdout).text()]);
      expect(code).toBe(0);
      const result = JSON.parse(output);
      expect(result.contended).toBe(true);
      expect(result.error).toMatch(/deadline exceeded \[wait: repository writer fence, wait \d+ ms, validation \d+ ms, commit 0 ms\]/);
      expect(fs.existsSync(path.join(newcomer, "node_modules"))).toBe(false);
    } finally { if (contender.exitCode === null) contender.kill("SIGKILL"); }

    release();
    const commands: string[] = [];
    await expect(prepareLockedDependencies(newcomer, { exec: (...args) => {
      commands.push(args[1][0]!);
      return realExec(...args);
    } })).resolves.toBe(true);
    expect(commands).toEqual(["rev-parse", "check-ignore"]);
    expect(fs.realpathSync(path.join(newcomer, "node_modules"))).toBe(modules);
    expect(fs.readFileSync(receipt)).toEqual(before);
  } finally { release?.(); f.close(); }
}, 30_000);

test("a linked graph admits while a different key installs and seals under the real writer fence", async () => {
  const f = await lockedFixture();
  const installed = Promise.withResolvers<void>(), finishInstall = Promise.withResolvers<void>();
  let cold: Promise<boolean> | undefined;
  try {
    await prepareLockedDependencies(f.worktreeDir);
    const peer = await f.addWorktree("new-key");
    fs.appendFileSync(path.join(peer, "package.json"), "\n");
    cold = prepareLockedDependencies(peer, { exec: async (...args) => {
      const result = await realExec(...args);
      if (args[0] === "bun") { installed.resolve(); await finishInstall.promise; }
      return result;
    } });
    void cold.catch(installed.reject);
    await installed.promise;
    expect(fs.existsSync(path.join(f.cache, "building.json"))).toBe(true);
    await f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir);
    expect(fs.existsSync(path.join(peer, "node_modules"))).toBe(false);
    finishInstall.resolve();
    await expect(cold).resolves.toBe(true);
    expect(fs.realpathSync(path.join(peer, "node_modules"))).not.toBe(fs.realpathSync(path.join(f.worktreeDir, "node_modules")));
  } finally { finishInstall.resolve(); await cold?.catch(() => {}); f.close(); }
}, 30_000);

test("an equal key in a peer namespace cannot admit a foreign link or a copied worktree registration", async () => {
  const f = await lockedFixture();
  let release: (() => void) | undefined;
  try {
    await prepareLockedDependencies(f.worktreeDir);
    const repo = path.join(f.root, "foreign-repo"), peer = path.join(f.root, "foreign-lane");
    await f.run(["git", "clone", f.repoDir, repo]);
    await f.run(["git", "worktree", "add", "--detach", peer], repo);
    await prepareLockedDependencies(peer);
    const local = path.join(f.worktreeDir, "node_modules");
    const expected = fs.realpathSync(local), foreign = fs.realpathSync(path.join(peer, "node_modules"));
    expect(path.basename(path.dirname(expected))).toBe(path.basename(path.dirname(foreign)));
    expect(expected).not.toBe(foreign);
    fs.unlinkSync(local);
    fs.symlinkSync(foreign, local, "dir");
    release = f.holdWriter();
    const abort = new AbortController();
    await expect(prepareLockedDependencies(f.worktreeDir, { signal: abort.signal, assertCurrent() { abort.abort(); } }))
      .rejects.toThrow(/\[wait: repository writer fence/);
    expect(fs.realpathSync(local)).toBe(foreign);
    release();
    await expect(prepareLockedDependencies(f.worktreeDir)).resolves.toBe(true);
    expect(fs.realpathSync(local)).toBe(expected);
    const redirect = path.join(f.root, "redirect");
    fs.symlinkSync(expected, redirect, "dir");
    fs.unlinkSync(local);
    fs.symlinkSync(redirect, local, "dir");
    expect(fs.realpathSync(local)).toBe(expected);
    await expect(prepareLockedDependencies(f.worktreeDir)).resolves.toBe(true);
    expect(fs.readlinkSync(local)).not.toContain("redirect");
    fs.copyFileSync(path.join(peer, ".git"), path.join(f.worktreeDir, ".git"));
    await expect(prepareLockedDependencies(f.worktreeDir)).rejects.toThrow("dependency worktree is no longer registered");
    expect(fs.realpathSync(local)).toBe(expected);
  } finally { release?.(); f.close(); }
}, 30_000);

test("a Git worktree registration inside a newline path prepares successfully", async () => {
  const f = await lockedFixture();
  try {
    const parent = path.join(f.root, "parent\nwith newline");
    fs.mkdirSync(parent);
    const moved = path.join(parent, "checkout");
    await f.run(["git", "worktree", "move", f.worktreeDir, moved]);
    f.worktreeDir = moved;
    f.pipeline.worktreeDir = moved;
    expect(await prepareLockedDependencies(moved)).toBe(true);
    expect(fs.lstatSync(path.join(moved, "node_modules")).isSymbolicLink()).toBe(true);
  } finally { f.close(); }
}, 30_000);

test.each(["receipt", "installed manifest", "CLI link"] as const)("validation detects a replaced %s behind an asynchronous read", async shape => {
  const f = await lockedFixture();
  let restore: (() => void) | undefined;
  try {
    await prepareLockedDependencies(f.worktreeDir);
    const local = path.join(f.worktreeDir, "node_modules");
    const modules = fs.realpathSync(local), target = path.dirname(modules);
    const cli = path.join(modules, ".bin", "fixture-tool");
    const realpath = fs.promises.realpath;
    let changed = false;
    const hook = spyOn(fs.promises, "realpath").mockImplementation(async (...args) => {
      const result = await Reflect.apply(realpath, fs.promises, args);
      if (args[0] === cli && !changed) {
        if (shape === "receipt") fs.unlinkSync(path.join(target, "installed.json"));
        if (shape === "installed manifest") fs.appendFileSync(path.join(target, "package.json"), "\n");
        if (shape === "CLI link") fs.unlinkSync(cli);
        changed = true;
      }
      return result;
    });
    restore = () => hook.mockRestore();
    await expect(prepareLockedDependencies(f.worktreeDir)).rejects.toThrow(/changed during (validation|preparation)/);
    expect(changed).toBe(true);
    expect(fs.realpathSync(local)).toBe(modules);
  } finally { restore?.(); f.close(); }
}, 30_000);

test.each(["root", "executable"] as const)("a writable %s needs the writer fence before it can be sealed", async shape => {
  const f = await lockedFixture();
  let release: (() => void) | undefined;
  try {
    await prepareLockedDependencies(f.worktreeDir);
    const local = path.join(f.worktreeDir, "node_modules"), modules = fs.realpathSync(local);
    const stat = fs.lstatSync(local);
    const filename = shape === "root" ? modules : path.join(modules, "fixture-tool", "cli.js");
    fs.chmodSync(filename, 0o755);
    release = f.holdWriter();
    const abort = new AbortController();
    await expect(prepareLockedDependencies(f.worktreeDir, { signal: abort.signal, assertCurrent() { abort.abort(); } }))
      .rejects.toThrow(/\[wait: repository writer fence/);
    expect(fs.statSync(filename).mode & 0o222).toBe(0o200);
    release();
    await expect(prepareLockedDependencies(f.worktreeDir)).resolves.toBe(true);
    expect(fs.statSync(filename).mode & 0o222).toBe(0);
    expect(fs.lstatSync(local).ino).toBe(stat.ino);
    await f.run(["node_modules/.bin/fixture-tool"], f.worktreeDir);
  } finally { release?.(); f.close(); }
}, 30_000);

test.skipIf(process.platform === "win32")("a fresh hook reconciles a link when its first process dies after rename", async () => {
  const f = await lockedFixture();
  try {
    const local = path.join(f.worktreeDir, "node_modules"), hook = path.resolve("scripts/prepare-stage-dependencies.ts");
    const crashed = await realExec(process.execPath, ["-e", `
      import fs from "node:fs";
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        rename(from, to);
        if (to === ${JSON.stringify(local)}) process.kill(process.pid, "SIGKILL");
      };
      await import(${JSON.stringify(hook)});`], f.worktreeDir);
    expect(crashed.signal).toBe("SIGKILL");
    const first = fs.lstatSync(local), destination = fs.readlinkSync(local);
    const release = f.holdWriter();
    try { await f.run(["bun", hook], f.worktreeDir); }
    finally { release(); }
    expect(fs.readlinkSync(local)).toBe(destination);
    expect(fs.lstatSync(local).ino).toBe(first.ino);
    expect(fs.readdirSync(f.cache).filter(name => /^[a-f0-9]{64}$/.test(name))).toHaveLength(1);
  } finally { f.close(); }
}, 30_000);

test("a matching replacement symlink cannot acknowledge a lost commit for another inode", async () => {
  const f = await lockedFixture();
  let restore: (() => void) | undefined;
  try {
    const local = path.join(f.worktreeDir, "node_modules");
    const rename = fs.renameSync;
    let replaced: number | undefined;
    const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (to === local) {
        const owned = local + ".previous";
        rename(local, owned);
        fs.symlinkSync(fs.readlinkSync(owned), local, "dir");
        replaced = fs.lstatSync(local).ino;
        throw new Error("link outcome unknown");
      }
    });
    restore = () => hook.mockRestore();
    await expect(prepareLockedDependencies(f.worktreeDir)).rejects.toThrow(/link outcome unknown \[commit: worktree link/);
    expect(replaced).toBeDefined();
    expect(fs.lstatSync(local).ino).toBe(replaced!);
    expect(fs.lstatSync(local + ".previous").ino).not.toBe(replaced!);
  } finally { restore?.(); f.close(); }
}, 30_000);

test.each(["validation", "before commit", "after commit"] as const)("a deadline at %s identifies the failing phase or retains the committed link", async phase => {
  const f = await lockedFixture();
  let restore: (() => void) | undefined;
  let now = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const local = path.join(f.worktreeDir, "node_modules");
    if (phase === "validation") {
      await prepareLockedDependencies(f.worktreeDir);
      const realpath = fs.promises.realpath;
      const hook = spyOn(fs.promises, "realpath").mockImplementation(async (...args) => {
        const result = await Reflect.apply(realpath, fs.promises, args);
        if (args[0] === local) now += 180_001;
        return result;
      });
      restore = () => hook.mockRestore();
      await expect(prepareLockedDependencies(f.worktreeDir)).rejects.toThrow(/deadline exceeded \[validation: existing link and seal/);
      expect(fs.lstatSync(local).isSymbolicLink()).toBe(true);
    } else if (phase === "before commit") {
      const symlink = fs.promises.symlink;
      const hook = spyOn(fs.promises, "symlink").mockImplementation(async (...args) => {
        await symlink(...args);
        now += 180_001;
      });
      restore = () => hook.mockRestore();
      await expect(prepareLockedDependencies(f.worktreeDir)).rejects.toThrow(/deadline exceeded \[commit: worktree link/);
      expect(fs.existsSync(local)).toBe(false);
    } else {
      const rename = fs.renameSync;
      const hook = spyOn(fs, "renameSync").mockImplementation((from, to) => {
        rename(from, to);
        if (to === local) now += 180_001;
      });
      restore = () => hook.mockRestore();
      await expect(prepareLockedDependencies(f.worktreeDir)).resolves.toBe(true);
      const inode = fs.lstatSync(local).ino;
      await expect(prepareLockedDependencies(f.worktreeDir)).resolves.toBe(true);
      expect(fs.lstatSync(local).ino).toBe(inode);
    }
  } finally { restore?.(); clock.mockRestore(); f.close(); }
}, 30_000);

test.each([1, 2])("a fenced validation timing out %i time(s) gets one retry in a fresh process", async failures => {
  const f = await lockedFixture();
  try {
    await prepareLockedDependencies(f.worktreeDir);
    const modules = fs.realpathSync(path.join(f.worktreeDir, "node_modules"));
    const newcomer = await f.addWorktree("validation-retry");
    const local = path.join(newcomer, "node_modules");
    const cli = path.join(modules, ".bin", "fixture-tool");
    const source = `
      import fs from "node:fs";
      import { prepareLockedDependencies } from ${JSON.stringify(path.resolve("src/lib/pipelines/lockedDependencies.ts"))};
      let now = 1800000000000, attempts = 0;
      Date.now = () => now;
      const realpath = fs.promises.realpath;
      fs.promises.realpath = async (file, ...args) => {
        const resolved = await realpath(file, ...args);
        if (file === ${JSON.stringify(cli)}) {
          if (fs.existsSync(${JSON.stringify(local)})) throw new Error("an unvalidated link was published");
          if (++attempts <= ${failures}) now += 180001;
        }
        return resolved;
      };
      let error = null;
      try { await prepareLockedDependencies(process.cwd()); } catch (failure) { error = failure.message; }
      process.stdout.write(JSON.stringify({ attempts, error }));`;
    const result = await realExec(process.execPath, ["-e", source], newcomer, undefined, { timeoutMs: 10_000 });
    expect(result.code, result.stderr).toBe(0);
    const { attempts, error } = JSON.parse(result.stdout);
    expect(attempts).toBe(2);
    expect(result.stderr.match(/retrying validation in 100 ms/g)).toHaveLength(1);
    if (failures === 1) {
      expect(error).toBeNull();
      expect(fs.realpathSync(local)).toBe(modules);
    } else {
      expect(error).toMatch(/deadline exceeded \[validation: fenced graph/);
      expect(fs.existsSync(local)).toBe(false);
    }
    f.holdWriter()();
  } finally { f.close(); }
}, 30_000);

test.skipIf(process.platform === "win32").each(["realExec", "worktreeDependencyExec"])("%s keeps the cache fence with an installer after its controller dies", async executor => {
  const f = await lockedFixture();
  const linked = await f.addWorktree("linked-during-recovery");
  await prepareLockedDependencies(linked);
  fs.appendFileSync(path.join(f.worktreeDir, "package.json"), "\n");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let ready!: (pid: number) => void;
  const started = new Promise<number>(resolve => { ready = resolve; });
  let finished!: (code: number) => void;
  const completed = new Promise<number>(resolve => { finished = resolve; });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (new URL(request.url).pathname === "/ready") { ready(Number(await request.text())); await held; }
    else finished(Number(await request.text()));
    return new Response("continue");
  } });
  const controllerFile = path.join(f.root, "controller.lock");
  const log = fs.openSync(path.join(f.root, "worker.log"), "w");
  const wrapper = `await fetch(${JSON.stringify(`http://127.0.0.1:${server.port}/ready`)}, {method:"POST",body:String(process.pid),signal:AbortSignal.timeout(20000)});
    const child = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile"], {stdin:"ignore",stdout:"ignore",stderr:"ignore"});
    const code = await child.exited;
    await fetch(${JSON.stringify(`http://127.0.0.1:${server.port}/done`)}, {method:"POST",body:String(code),signal:AbortSignal.timeout(20000)});`;
  const source = `import fs from "node:fs";
    import {prepareLockedDependencies,worktreeDependencyExec} from ${JSON.stringify(path.resolve("src/lib/pipelines/lockedDependencies.ts"))};
    import {realExec} from ${JSON.stringify(path.resolve("src/lib/workflows/provision.ts"))};
    import {tryLockFenceExclusive} from ${JSON.stringify(path.resolve("src/runtime-host/fenceLock.ts"))};
    const filename=${JSON.stringify(controllerFile)}, fd=fs.openSync(filename,"a+");
    if(!tryLockFenceExclusive({fd,filename}))throw new Error("controller fence unavailable");
    await prepareLockedDependencies(${JSON.stringify(f.worktreeDir)}, {exec:(command,args,cwd,env,options)=>${executor}(command==="bun"?process.execPath:command,command==="bun"?["-e",${JSON.stringify(wrapper)}]:args,cwd,env,{...options,inheritFd:fd})});`;
  const worker = Bun.spawn([process.execPath, "-e", source], { cwd: path.resolve("."), stdin: "ignore", stdout: log, stderr: log });
  const { tryLockFenceExclusive } = await import("../../runtime-host/fenceLock");
  const descriptors: { fd: number; filename: string }[] = [];
  let installer: number | undefined;
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("installer barrier deadline exceeded")), 20_000); })]); }
    finally { clearTimeout(timer!); }
  };
  try {
    installer = await bounded(started);
    const cacheFile = path.join(f.repoDir, ".git/delegatus-dependencies/v4/owner.lock");
    for (const filename of [controllerFile, cacheFile]) descriptors.push({ filename, fd: fs.openSync(filename, "a+") });
    // Both production executors have started a real child with both owners.
    for (const target of descriptors) { const lock = tryLockFenceExclusive(target); lock?.release(); expect(lock).toBeNull(); }
    worker.kill("SIGKILL"); await bounded(worker.exited);
    for (const target of descriptors) { const lock = tryLockFenceExclusive(target); lock?.release(); expect(lock).toBeNull(); }
    await bounded(f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], linked));
    expect(fs.existsSync(path.join(f.worktreeDir, "node_modules"))).toBe(false);
    release();
    expect(await bounded(completed)).toBe(0);
    await bounded((async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const locks = descriptors.map(tryLockFenceExclusive);
        locks.forEach(lock => lock?.release());
        if (locks.every(Boolean)) return;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      throw new Error("installer did not release its fences");
    })());
    installer = undefined;
    await f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir);
    expect(JSON.parse(fs.readFileSync(path.join(f.worktreeDir, "node_modules/fixture-tool/package.json"), "utf8")).version).toBe("2.0.0");
    expect(fs.existsSync(path.join(f.repoDir, ".git/delegatus-dependencies/v4/building.json"))).toBe(false);
  } finally {
    release(); worker.kill("SIGKILL"); await worker.exited;
    if (installer) { try { process.kill(-installer, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
    descriptors.forEach(target => fs.closeSync(target.fd)); fs.closeSync(log); server.stop(true); f.close();
  }
}, 60_000);


test("cache eviction retains registered worktrees and four unused input graphs", async () => {
  const f = await lockedFixture();
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const pinned = fs.realpathSync(path.join(f.worktreeDir, "node_modules"));
    const other = path.join(f.root, "other");
    await f.run(["git", "worktree", "add", "-b", "other", other]);
    await f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], other);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.worktreeDir, "package.json"), "utf8"));
    for (let revision = 0; revision < 7; revision++) {
      fs.writeFileSync(path.join(f.worktreeDir, "package.json"), JSON.stringify({ ...manifest, description: `fixture revision ${revision}` }));
      await prepareWorktreeDependencies(f.pipeline);
    }
    const cache = path.join(f.repoDir, ".git/delegatus-dependencies/v4");
    expect(fs.readdirSync(cache).filter(name => /^[a-f0-9]{64}$/.test(name))).toHaveLength(6);
    expect(fs.realpathSync(path.join(other, "node_modules"))).toBe(pinned);
    expect(fs.existsSync(path.join(pinned, "fixture-tool/package.json"))).toBe(true);
  } finally { f.close(); }
}, 30_000);

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable worktree reference refuses eviction and preserves its graph", async () => {
  const f = await lockedFixture();
  const other = path.join(f.root, "other");
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const shared = fs.realpathSync(path.join(f.worktreeDir, "node_modules"));
    await f.run(["git", "worktree", "add", "-b", "other", other]);
    await f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], other);
    expect(fs.realpathSync(path.join(other, "node_modules"))).toBe(shared);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.worktreeDir, "package.json"), "utf8"));
    for (let revision = 0; revision < 6; revision++) {
      fs.writeFileSync(path.join(f.worktreeDir, "package.json"), JSON.stringify({ ...manifest, description: `fixture revision ${revision}` }));
      await prepareWorktreeDependencies(f.pipeline);
    }
    fs.chmodSync(other, 0o000);
    expect(() => fs.realpathSync(path.join(other, "node_modules"))).toThrow();
    fs.writeFileSync(path.join(f.worktreeDir, "package.json"), JSON.stringify({ ...manifest, description: "next fixture revision" }));
    await expect(prepareWorktreeDependencies(f.pipeline)).rejects.toThrow("stage environment: dependency preparation failed");
    expect(JSON.parse(fs.readFileSync(path.join(shared, "fixture-tool/package.json"), "utf8")).version).toBe("2.0.0");
  } finally { if (fs.existsSync(other)) fs.chmodSync(other, 0o700); f.close(); }
}, 30_000);

test("cancelled setup leaves the old dependency link available", async () => {
  const f = await lockedFixture();
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules"), before = fs.realpathSync(local);
    const abort = new AbortController(); abort.abort();
    await expect(prepareWorktreeDependencies(f.pipeline, { signal: abort.signal })).rejects.toThrow("stage environment:");
    expect(fs.realpathSync(local)).toBe(before);
  } finally { f.close(); }
}, 30_000);

test("a lockfile-only change selects a new completed installation", async () => {
  const f = await lockedFixture();
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules"), before = fs.realpathSync(local);
    const manifest = fs.readFileSync(path.join(f.worktreeDir, "package.json"));
    fs.appendFileSync(path.join(f.worktreeDir, "bun.lock"), "\n");
    await prepareWorktreeDependencies(f.pipeline);
    expect(fs.realpathSync(local)).not.toBe(before);
    expect(fs.readFileSync(path.join(f.worktreeDir, "package.json")).equals(manifest)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(local, "fixture-tool/package.json"), "utf8")).version).toBe("2.0.0");
  } finally { f.close(); }
}, 30_000);

test("a production caller gets development tools without installation scripts", async () => {
  const f = await lockedFixture();
  const previous = process.env.NODE_ENV;
  try {
    Reflect.set(process.env, "NODE_ENV", "production");
    try { await prepareWorktreeDependencies(f.pipeline); }
    finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Reflect.set(process.env, "NODE_ENV", previous);
    }
    const modules = fs.realpathSync(path.join(f.worktreeDir, "node_modules"));
    const installedRoot = path.dirname(modules);
    expect(JSON.parse(fs.readFileSync(path.join(modules, "fixture-tool/package.json"), "utf8")).version).toBe("2.0.0");
    expect(fs.existsSync(path.join(installedRoot, "lifecycle-ran"))).toBe(false);
    // The same real installer and root script reach the observer when scripts
    // are enabled, in another owned directory that no worktree shares.
    const control = path.join(f.root, "script-control"); fs.mkdirSync(control);
    for (const file of ["package.json", "bun.lock"]) fs.copyFileSync(path.join(f.repoDir, file), path.join(control, file));
    await f.run(["bun", "install", "--frozen-lockfile", "--backend=copyfile"], control);
    expect(fs.existsSync(path.join(control, "lifecycle-ran"))).toBe(true);
    expect(fs.existsSync(path.join(installedRoot, "lifecycle-ran"))).toBe(false);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "NODE_ENV"); else Reflect.set(process.env, "NODE_ENV", previous);
    f.close();
  }
}, 30_000);

test("a mismatched completion receipt refuses reuse in a fresh process", async () => {
  const f = await lockedFixture();
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules"), before = fs.readlinkSync(local);
    const receipt = path.join(path.dirname(fs.realpathSync(local)), "installed.json");
    fs.writeFileSync(receipt, JSON.stringify({ key: "0".repeat(64) }));
    await expect(f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir))
      .rejects.toThrow("stage environment: dependency preparation failed: incomplete shared dependency entry");
    expect(fs.readlinkSync(local)).toBe(before);
  } finally { f.close(); }
}, 30_000);

test.each(["missing", "absolute", "parent", "absolute-target"])("a %s CLI link receipt refuses reuse in a fresh process", async shape => {
  const f = await lockedFixture();
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules"), shared = fs.realpathSync(local);
    const receipt = path.join(path.dirname(shared), "installed.json"), record = JSON.parse(fs.readFileSync(receipt, "utf8"));
    if (shape === "missing") delete record.cliLinks;
    else if (shape === "absolute-target") record.cliLinks[0].target = path.join(shared, "fixture-tool/cli.js");
    else record.cliLinks[0].file = shape === "absolute" ? path.join(shared, ".bin/fixture-tool") : "../.bin/fixture-tool";
    fs.writeFileSync(receipt, JSON.stringify(record));
    await expect(f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir))
      .rejects.toThrow("stage environment: dependency preparation failed: invalid dependency CLI link receipt");
    expect(fs.realpathSync(local)).toBe(shared);
    await f.run(["node_modules/.bin/fixture-tool"], f.worktreeDir);
  } finally { f.close(); }
}, 30_000);

test.each(["absolute", "parent", "symlink"])("an %s executable receipt cannot chmod outside the shared graph", async shape => {
  const f = await lockedFixture();
  try {
    await prepareWorktreeDependencies(f.pipeline);
    const modules = fs.realpathSync(path.join(f.worktreeDir, "node_modules"));
    const outside = path.join(f.root, "outside.js");
    fs.writeFileSync(outside, "outside bytes\n", { mode: 0o755 });
    const before = fs.statSync(outside).mode;
    const receipt = path.join(path.dirname(modules), "installed.json");
    const record = JSON.parse(fs.readFileSync(receipt, "utf8"));
    if (shape === "symlink") {
      const executable = path.join(modules, record.executables[0]);
      fs.chmodSync(path.dirname(executable), 0o755);
      fs.unlinkSync(executable);
      fs.symlinkSync(outside, executable);
    } else {
      record.executables = [shape === "absolute" ? outside : path.relative(modules, outside)];
      fs.writeFileSync(receipt, JSON.stringify(record));
    }
    await expect(f.run(["bun", path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir))
      .rejects.toThrow(shape === "symlink" ? "dependency executable leaves the installation" : "invalid dependency executable receipt");
    expect(fs.statSync(outside).mode).toBe(before);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside bytes\n");
  } finally { f.close(); }
}, 30_000);

test("preparation replaces an earlier cache generation without changing its graph", async () => {
  const f = await lockedFixture();
  try {
    const earlier = path.join(f.repoDir, ".git/delegatus-dependencies/v3/earlier/node_modules");
    fs.mkdirSync(path.dirname(earlier), { recursive: true });
    fs.cpSync(path.join(f.repoDir, "node_modules"), earlier, { recursive: true });
    fs.chmodSync(path.join(earlier, ".bin"), 0o555);
    const before = fs.readFileSync(path.join(earlier, "fixture-tool/package.json"));
    fs.symlinkSync(earlier, path.join(f.worktreeDir, "node_modules"), "dir");
    await prepareWorktreeDependencies(f.pipeline);
    expect(fs.realpathSync(path.join(f.worktreeDir, "node_modules"))).not.toBe(earlier);
    expect(fs.readFileSync(path.join(earlier, "fixture-tool/package.json"))).toEqual(before);
    expect(fs.statSync(path.join(earlier, ".bin")).mode & 0o777).toBe(0o555);
  } finally { f.close(); }
}, 30_000);

test("input changes during real installs refuse linking and bound unused completed entries", async () => {
  const f = await lockedFixture();
  try {
    const { prepareLockedDependencies } = await import("./lockedDependencies");
    const execute: ExecPort = async (command, args, cwd, env, options) => {
      const result = await realExec(command, args, cwd, env, options);
      if (command === "bun") fs.appendFileSync(path.join(f.worktreeDir, "bun.lock"), "\n");
      return result;
    };
    for (let revision = 0; revision < 7; revision++) {
      await expect(prepareLockedDependencies(f.worktreeDir, { exec: execute })).rejects.toThrow("dependency inputs changed");
      expect(fs.existsSync(path.join(f.worktreeDir, "node_modules"))).toBe(false);
    }
    const cache = path.join(f.repoDir, ".git/delegatus-dependencies/v4");
    expect(fs.readdirSync(cache).filter(name => /^[a-f0-9]{64}$/.test(name)).length).toBeLessThanOrEqual(4);
  } finally { f.close(); }
}, 30_000);

test("dependency command capture preserves multibyte output across pipe chunks", async () => {
  const f = await lockedFixture();
  try {
    const { worktreeDependencyExec } = await import("./lockedDependencies");
    const result = await worktreeDependencyExec("bun", ["-e", 'process.stdout.write("a" + "🙂".repeat(80_000)); process.stderr.write("b" + "ї".repeat(140_000));'], f.worktreeDir);
    expect(result.code).toBe(0);
    expect(result.stdout === "a" + "🙂".repeat(80_000)).toBe(true);
    expect(result.stderr === "b" + "ї".repeat(140_000)).toBe(true);
  } finally { f.close(); }
}, 30_000);


test.each(["before-link", "reused-link", "competing-link"] as const)("dependency changes during %s refuse the obsolete shared graph", async phase => {
  const f = await lockedFixture();
  let restore: (() => void) | undefined;
  try {
    const { prepareLockedDependencies } = await import("./lockedDependencies");
    const local = path.join(f.worktreeDir, "node_modules");
    let changed = false;
    const changeInputs = async () => {
      const filename = path.join(f.worktreeDir, "package.json");
      const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
      manifest.devDependencies["fixture-tool"] = `http://127.0.0.1:${f.server.port}/next.tgz`;
      fs.writeFileSync(filename, JSON.stringify(manifest));
      await f.run(["bun", "install", "--lockfile-only", "--ignore-scripts"], f.worktreeDir);
      changed = true;
    };
    if (phase === "reused-link") {
      await prepareWorktreeDependencies(f.pipeline);
      const original = fs.promises.realpath;
      const spy = spyOn(fs.promises, "realpath").mockImplementation(async (...args) => {
        const resolved = await Reflect.apply(original, fs.promises, args);
        if (args[0] === local && !changed) await changeInputs();
        return resolved;
      });
      restore = () => spy.mockRestore();
    } else {
      const original = fs.promises.symlink;
      const spy = spyOn(fs.promises, "symlink").mockImplementation(async (...args) => {
        await original(...args);
        if (phase === "competing-link") {
          await f.makeLagging();
          fs.symlinkSync(path.join(f.repoDir, "node_modules"), local, "dir");
          changed = true;
        } else await changeInputs();
      });
      restore = () => spy.mockRestore();
    }
    await expect(prepareLockedDependencies(f.worktreeDir)).rejects.toThrow("stage environment: dependency preparation failed");
    restore?.(); restore = undefined;
    expect(changed).toBe(true);
    if (phase === "before-link") expect(fs.existsSync(local)).toBe(false);
    else expect(JSON.parse(fs.readFileSync(path.join(local, "fixture-tool/package.json"), "utf8")).version).toBe(phase === "competing-link" ? "1.0.0" : "2.0.0");
    await prepareWorktreeDependencies(f.pipeline);
    expect(JSON.parse(fs.readFileSync(path.join(local, "fixture-tool/package.json"), "utf8")).version).toBe(phase === "competing-link" ? "2.0.0" : "3.0.0");
  } finally { restore?.(); f.close(); }
}, 30_000);

test.skipIf(process.platform === "win32").each([1_048_575, 1_048_576, 1_048_577])("capture after root exit respects the %i byte boundary", async bytes => {
  const { worktreeDependencyExec } = await import("./lockedDependencies");
  // A descendant inherits the output pipe and waits for root death.
  // A successful root exit leaves the capture limit in force.
  const writer = `for(;;){try{process.kill(__PARENT__,0);}catch(error){if(error.code==="ESRCH")break;throw error;}await Bun.sleep(1);}
    await Bun.write(Bun.stdout,"x".repeat(${bytes}));`;
  const source = `Bun.spawn([process.execPath, "-e", ${JSON.stringify(writer)}.replace("__PARENT__", String(process.pid))],
    {stdin:"ignore",stdout:"inherit",stderr:"inherit"});process.exit(0);`;
  const result = await worktreeDependencyExec(process.execPath, ["-e", source], path.resolve("."), undefined, { timeoutMs: 5_000 });
  if (bytes > 1_048_576) {
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("output exceeded");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1_048_576);
  } else {
    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBe(bytes);
    expect(result.stderr).toBe("");
  }
}, 10_000);

test.skipIf(process.platform === "win32")("a partial eviction cannot retain its completion receipt across a restart", async () => {
  const f = await lockedFixture();
  try {
    const filename = path.join(f.worktreeDir, "package.json"), original = fs.readFileSync(filename);
    await prepareWorktreeDependencies(f.pipeline);
    const local = path.join(f.worktreeDir, "node_modules"), modules = fs.realpathSync(local), entry = path.dirname(modules);
    for (let revision = 1; revision <= 4; revision++) {
      fs.writeFileSync(filename, JSON.stringify({ ...JSON.parse(original.toString()), description: `revision ${revision}` }));
      await prepareWorktreeDependencies(f.pipeline);
    }
    const healthy = fs.realpathSync(local);
    fs.writeFileSync(filename, JSON.stringify({ ...JSON.parse(original.toString()), description: "next revision" }));
    const source = `import fs from "node:fs";
      import {prepareLockedDependencies} from ${JSON.stringify(path.resolve("src/lib/pipelines/lockedDependencies.ts"))};
      const remove=fs.promises.rm;
      fs.promises.rm=async(...args)=>{if(args[0]===${JSON.stringify(entry)}){
        fs.unlinkSync(${JSON.stringify(path.join(modules, "fixture-tool/index.js"))});process.kill(process.pid,"SIGKILL");
      }return remove(...args);};
      await prepareLockedDependencies(${JSON.stringify(f.worktreeDir)});`;
    const stopped = await realExec(process.execPath, ["-e", source], f.worktreeDir);
    expect(stopped.signal).toBe("SIGKILL");
    expect(fs.existsSync(path.join(modules, "fixture-tool/index.js"))).toBe(false);
    fs.writeFileSync(filename, original);
    const resumed = await realExec(process.execPath, [path.resolve("scripts/prepare-stage-dependencies.ts")], f.worktreeDir);
    expect(resumed.code).not.toBe(0);
    expect(resumed.stderr).toContain("stage environment: dependency preparation failed");
    expect(fs.realpathSync(local)).toBe(healthy);
  } finally { f.close(); }
}, 30_000);

test.each(["missing-lock", "local-dependency", "absolute-dependency", "windows-dependency", "windows-relative-dependency", "home-dependency", "windows-home-dependency", "peer-local-dependency", "workspace", "escaping-patch", "symlink-patch"])("%s refuses setup before linking an unproved installation", async shape => {
  const f = await lockedFixture();
  try {
    const manifestPath = path.join(f.worktreeDir, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (shape === "missing-lock") fs.unlinkSync(path.join(f.worktreeDir, "bun.lock"));
    if (shape === "local-dependency") manifest.devDependencies["fixture-tool"] = "file:../package";
    if (shape === "absolute-dependency") manifest.devDependencies["fixture-tool"] = "/package";
    if (shape === "windows-dependency") manifest.devDependencies["fixture-tool"] = "C:\\package";
    if (shape === "windows-relative-dependency") manifest.devDependencies["fixture-tool"] = "..\\package";
    if (shape === "home-dependency") manifest.devDependencies["fixture-tool"] = "~/package";
    if (shape === "windows-home-dependency") manifest.devDependencies["fixture-tool"] = "~\\package";
    if (shape === "peer-local-dependency") manifest.peerDependencies = { "fixture-peer": "file:../package" };
    if (shape === "workspace") manifest.workspaces = ["packages/*"];
    if (shape === "escaping-patch") manifest.patchedDependencies = { "fixture-tool@2.0.0": "../outside.patch" };
    if (shape === "symlink-patch") {
      fs.writeFileSync(path.join(f.root, "outside.patch"), "outside input");
      fs.symlinkSync(path.join(f.root, "outside.patch"), path.join(f.worktreeDir, "linked.patch"));
      manifest.patchedDependencies = { "fixture-tool@2.0.0": "linked.patch" };
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const { prepareLockedDependencies } = await import("./lockedDependencies");
    let installs = 0;
    await expect(prepareLockedDependencies(f.worktreeDir, { exec: async (command, args, cwd, env, options) => {
      if (command === "bun") installs++;
      return realExec(command, args, cwd, env, options);
    } })).rejects.toThrow("stage environment:");
    expect(installs).toBe(0);
    expect(fs.existsSync(path.join(f.worktreeDir, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(f.repoDir, "node_modules/fixture-tool/package.json"))).toBe(true);
  } finally { f.close(); }
}, 30_000);
