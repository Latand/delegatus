import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolateWorktreeDependencies, prepareWorktreeDependencies } from "./worktreeDependencies";
import type { Pipeline } from "./types";
import { lockedFixture } from "./fixtures/lockedDependencies";
import { buildPipeline } from "./store";
import { provisionPipelineWorktree, provisionPipelineWorktreeAsync, publishPipelineBranch, publicationFailureCause } from "./git";
import { findPipelineRecord, savePipelines } from "./store";
import { dependencyInstallFailure } from "./lockedDependencies";
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
    expect(fs.readdirSync(path.join(f.repoDir, ".git/delegatus-dependencies/v2")).some(name => name.startsWith("building-"))).toBe(false);
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

test.each(["cache-hit", "stale-link", "invalid-lock", "ENOSPC", "EEXIST", "hook-install", "hook-privacy"])("publication retains the dependency contract for %s", async shape => {
  const f = await lockedFixture();
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
    if (shape === "hook-install") fs.writeFileSync(path.join(f.repoDir, ".git/hooks/pre-push"),
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
    if (shape === "cache-hit" || shape === "stale-link" || shape === "hook-install" && published.ok) {
      expect(published).toMatchObject({ ok: true, sha: head, remote: "published" });
      expect(installs).toBe(0);
      expect(pushes).toBe(1);
      if (shape !== "hook-install") {
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
    const cache = path.join(f.repoDir, ".git/delegatus-dependencies/v2");
    expect(fs.readdirSync(cache).filter(name => /^[a-f0-9]{64}$/.test(name))).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(f.worktreeDir, "node_modules/fixture-tool/package.json"), "utf8")).version).toBe("2.0.0");
  } finally { f.close(); }
}, 30_000);

test.skipIf(process.platform === "win32").each(["realExec", "worktreeDependencyExec"])("%s keeps the cache fence with an installer after its controller dies", async executor => {
  const f = await lockedFixture();
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
    const cacheFile = path.join(f.repoDir, ".git/delegatus-dependencies/v2/owner.lock");
    for (const filename of [controllerFile, cacheFile]) descriptors.push({ filename, fd: fs.openSync(filename, "a+") });
    // Both production executors have started a real child with both owners.
    for (const target of descriptors) { const lock = tryLockFenceExclusive(target); lock?.release(); expect(lock).toBeNull(); }
    worker.kill("SIGKILL"); await bounded(worker.exited);
    for (const target of descriptors) { const lock = tryLockFenceExclusive(target); lock?.release(); expect(lock).toBeNull(); }
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
    expect(fs.existsSync(path.join(f.repoDir, ".git/delegatus-dependencies/v2/building.json"))).toBe(false);
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
    const cache = path.join(f.repoDir, ".git/delegatus-dependencies/v2");
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
    const cache = path.join(f.repoDir, ".git/delegatus-dependencies/v2");
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


test.each(["final-prune", "reused-link", "final-pointer"])("dependency changes during %s refuse the obsolete shared graph", async phase => {
  const f = await lockedFixture();
  let restore: (() => void) | undefined;
  try {
    const { prepareLockedDependencies } = await import("./lockedDependencies");
    const local = path.join(f.worktreeDir, "node_modules");
    let changed = false, scans = 0;
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
    }
    await expect(prepareLockedDependencies(f.worktreeDir, { exec: async (command, args, cwd, env, options) => {
      const result = await realExec(command, args, cwd, env, options);
      if (phase !== "reused-link" && command === "git" && args[0] === "worktree" && ++scans === 2) {
        if (phase === "final-pointer") {
          await f.makeLagging();
          fs.unlinkSync(local);
          fs.symlinkSync(path.join(f.repoDir, "node_modules"), local, "dir");
          changed = true;
        } else await changeInputs();
      }
      return result;
    } })).rejects.toThrow("stage environment: dependency preparation failed");
    restore?.(); restore = undefined;
    expect(changed).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(local, "fixture-tool/package.json"), "utf8")).version).toBe(phase === "final-pointer" ? "1.0.0" : "2.0.0");
    await prepareWorktreeDependencies(f.pipeline);
    expect(JSON.parse(fs.readFileSync(path.join(local, "fixture-tool/package.json"), "utf8")).version).toBe(phase === "final-pointer" ? "2.0.0" : "3.0.0");
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
