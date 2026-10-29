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
