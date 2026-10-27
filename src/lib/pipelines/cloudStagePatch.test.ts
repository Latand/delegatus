import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { prepareCloudPatch, applyCloudPatch } from "./cloudStagePatch";

const diff = ["diff --git a/file.txt b/file.txt", "--- a/file.txt", "+++ b/file.txt", "@@ -1 +1 @@", "-before", "+after", ""].join("\n");
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-patch-"));
  const cwd = path.join(root, "repo"), directory = path.join(root, "patches");
  await fs.mkdir(cwd);
  const git = async (...args: string[]) => {
    const result = await realExec("git", args, cwd);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Fixture"); await git("config", "user.email", "noreply@example.com");
    await git("config", "commit.gpgSign", "false");
    await fs.writeFile(path.join(cwd, "file.txt"), "before\n");
    await git("add", "."); await git("commit", "-m", "base");
    const head = await git("rev-parse", "HEAD");
    return { root, cwd, directory, git, head };
  } catch (error) { await fs.rm(root, { recursive: true, force: true }); throw error; }
}

test("an interrupted patch application is reconciled in a fresh process without applying twice", async () => {
  const f = await fixture();
  try {
    const patch = await prepareCloudPatch(f.directory, diff, f.head, f.cwd, realExec, () => {});
    const input = { ...f, git: undefined, patch }, file = path.join(f.root, "receipt.json");
    const persist = () => fs.writeFile(file, JSON.stringify(input));
    let applied = false;
    await expect(applyCloudPatch(f.directory, patch, f.head, f.cwd, async (command, args, ...rest) => {
      const result = await realExec(command, args, ...rest);
      if (args[0] === "apply" && result.code === 0) { applied = true; throw new Error("controller stopped after apply"); }
      return result;
    }, () => {}, persist)).rejects.toThrow("controller stopped after apply");
    expect(applied).toBe(true);
    expect(JSON.parse(await fs.readFile(file, "utf8")).patch).toEqual({ ...patch, applying: true });
    const child = spawnSync(process.execPath, [path.join(process.cwd(), "src/lib/pipelines/fixtures/cloudPatchRestart.ts"), file], {
      env: { ...process.env, LLV_CLOUD_PATCH_RESTART: "1" }, encoding: "utf8" });
    expect({ code: child.status, error: child.stderr }).toEqual({ code: 0, error: "" });
    expect(JSON.parse(child.stdout)).toEqual({ patch: { ...patch, applied: true }, applications: 0 });
    expect(await f.git("write-tree")).toBe(patch.tree);
    expect(await fs.readFile(path.join(f.cwd, "file.txt"), "utf8")).toBe("after\n");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test.each(["dirty-worktree", "dirty-index", "untracked", "moved-head", "tampered-patch", "authority"] as const)("patch application refuses %s without discarding local work", async failure => {
  const f = await fixture();
  try {
    const patch = await prepareCloudPatch(f.directory, diff, f.head, f.cwd, realExec, () => {});
    if (failure === "dirty-worktree" || failure === "dirty-index") {
      await fs.writeFile(path.join(f.cwd, "file.txt"), "local edit\n");
      if (failure === "dirty-index") await f.git("add", "file.txt");
    }
    if (failure === "untracked") await fs.writeFile(path.join(f.cwd, "untracked.txt"), "local edit\n");
    if (failure === "moved-head") await f.git("commit", "--allow-empty", "-m", "moved");
    if (failure === "tampered-patch") await fs.writeFile(path.join(f.directory, `${patch.digest}.patch`), "tampered");
    let effects = 0;
    await expect(applyCloudPatch(f.directory, patch, f.head, f.cwd, (command, args, ...rest) => {
      if (args[0] === "apply") effects++;
      return realExec(command, args, ...rest);
    }, () => { if (failure === "authority") throw new Error("authority withdrawn"); }, () => {})).rejects.toThrow();
    expect(effects).toBe(0);
    expect(await fs.readFile(path.join(f.cwd, "file.txt"), "utf8")).toBe(failure.startsWith("dirty") ? "local edit\n" : "before\n");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("invalid and oversized patches cannot prepare a lane mutation", async () => {
  const f = await fixture();
  try {
    for (const patch of [diff.replace("-before", "-wrong"), "x".repeat(16 * 1024 * 1024 + 1)]) {
      await expect(prepareCloudPatch(f.directory, patch, f.head, f.cwd, realExec, () => {})).rejects.toThrow();
    }
    expect(await f.git("status", "--porcelain")).toBe("");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});


test.each([1, 2, 3, 4, 5])("authority withdrawal after Git read %i prevents patch application", async seam => {
  const f = await fixture();
  try {
    const patch = await prepareCloudPatch(f.directory, diff, f.head, f.cwd, realExec, () => {});
    let current = true, calls = 0, effects = 0;
    await expect(applyCloudPatch(f.directory, patch, f.head, f.cwd, async (command, args, ...rest) => {
      if (args[0] === "apply") effects++;
      const result = await realExec(command, args, ...rest);
      if (++calls === seam) current = false;
      return result;
    }, () => { if (!current) throw new Error("authority withdrawn"); }, () => {})).rejects.toThrow("authority withdrawn");
    expect(calls).toBe(seam); expect(effects).toBe(0);
    expect(await f.git("status", "--porcelain")).toBe("");
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
