import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolateWorktreeDependencies, prepareWorktreeDependencies } from "./worktreeDependencies";
import type { Pipeline } from "./types";

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
const unavailable: typeof fs.promises.copyFile = async () => { throw Object.assign(new Error("clone unavailable"), { code: "ENOTSUP" }); };

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

test.each(["darwin", "linux", "win32"] as const)("%s fallback links a read-only lane and detaches before a writer installs", async platform => {
  const f = fixture();
  try {
    expect(await prepareWorktreeDependencies(f.pipeline, { platform, copyFile: unavailable })).toBe("symlink");
    expect(fs.realpathSync(f.local)).toBe(fs.realpathSync(f.source));
    await isolateWorktreeDependencies(f.pipeline);
    expect(fs.existsSync(f.local)).toBe(false);
    fs.writeFileSync(path.join(f.pipeline.worktreeDir, "package-lock.json"), "new lock\n");
    fs.mkdirSync(f.local); fs.writeFileSync(path.join(f.local, "new.js"), "installed\n");
    expect(fs.existsSync(path.join(f.source, "new.js"))).toBe(false);
    expect(fs.readFileSync(path.join(f.source, "fixture/index.js"), "utf8")).toBe("original\n");
  } finally { f.close(); }
});

test.each(["darwin", "linux", "win32"] as const)("%s gives a writable lane a private install when CoW is unavailable", async platform => {
  const f = fixture(true);
  try {
    expect(await prepareWorktreeDependencies(f.pipeline, { platform, copyFile: unavailable })).toBe("private-install");
    expect(fs.existsSync(f.local)).toBe(false);
    expect(fs.readdirSync(f.pipeline.worktreeDir).sort()).toEqual(["package-lock.json", "package.json"]);
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
    expect(["clone", "private-install"]).toContain(result);
    if (result === "clone") {
      fs.writeFileSync(path.join(f.local, "fixture/index.js"), "new\n");
      expect(fs.readFileSync(path.join(f.source, "fixture/index.js"), "utf8")).toBe("original\n");
    } else expect(fs.existsSync(f.local)).toBe(false);
  } finally { f.close(); }
});
