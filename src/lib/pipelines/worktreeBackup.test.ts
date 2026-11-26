import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { statePath } from "@/lib/configDir";
import { backupWorktree } from "./worktreeBackup";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(statePath("evidence"), { recursive: true, force: true });
});

/** A committed checkout with `captures` ignored screenshots under `results/`. */
function checkout(captures: number) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llv-backup-test-")));
  roots.push(directory);
  const address = ["noreply", "example.invalid"].join("@");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: address, GIT_COMMITTER_EMAIL: address } }).trim();
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(directory, ".gitignore"), "results/\n");
  fs.writeFileSync(path.join(directory, "source.txt"), "tracked\n");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");
  fs.mkdirSync(path.join(directory, "results"));
  for (let n = 0; n < captures; n++) fs.writeFileSync(path.join(directory, "results", `capture-${n}.png`), `capture ${n}`);
  return { directory, head: git("rev-parse", "HEAD") };
}

const options = (pipelineId: string, captures: number, guard: () => boolean) => {
  const { directory, head } = checkout(captures);
  return { directory, pipelineId, head, branch: "main", ignored: ["results/"], disposable: () => false, guard };
};

test("the number of guard reads does not grow with the number of evidence files", async () => {
  let few = 0, many = 0;
  // An unbounded reuse keeps a slow disk from adding a guard read.
  (await backupWorktree({ ...options("guard-few", 3, () => { few++; return true; }), guardReuseMs: Number.POSITIVE_INFINITY })).close();
  (await backupWorktree({ ...options("guard-many", 60, () => { many++; return true; }), guardReuseMs: Number.POSITIVE_INFINITY })).close();
  expect(fs.readdirSync(statePath("evidence", "guard-many", "worktree", "results"))).toHaveLength(60);
  expect(fs.readFileSync(statePath("evidence", "guard-many", "worktree", "results", "capture-59.png"), "utf8")).toBe("capture 59");
  expect(many).toBe(few);
});

test("ownership lost while evidence is copied refuses the backup at its verification", async () => {
  const saved = statePath("evidence", "guard-lost", "worktree", "results", "capture-0.png");
  await expect(backupWorktree(options("guard-lost", 8, () => !fs.existsSync(saved)))).rejects.toThrow("worktree changed after backup");
});

test("ownership lost at a Git step refuses the backup there", async () => {
  let reads = 0;
  await expect(backupWorktree(options("guard-git", 2, () => ++reads < 2))).rejects.toThrow(/^backup ownership changed$/);
});

test("with no reuse every evidence read asks the guard", async () => {
  const saved = statePath("evidence", "guard-each", "worktree", "results", "capture-0.png");
  await expect(backupWorktree({ ...options("guard-each", 4, () => !fs.existsSync(saved)), guardReuseMs: 0 }))
    .rejects.toThrow("backup ownership changed while reading evidence");
});

test("the returned verification asks the guard itself, however recently it held", async () => {
  let held = true, reads = 0;
  const backup = await backupWorktree(options("verify-first", 5, () => { reads++; return held; }));
  try {
    held = false;
    const before = reads;
    expect(await backup.verify()).toBeFalse();
    expect(reads - before).toBe(1);
  } finally { backup.close(); }
});

test("ownership lost while the verification reads evidence stops the verification", async () => {
  let held = true, armed = false, streams = 0;
  const read = fs.createReadStream;
  const stream = spyOn(fs, "createReadStream").mockImplementation(((file: fs.PathLike, settings?: unknown) => {
    if (armed && ++streams === 3) held = false;
    return (read as (file: fs.PathLike, settings?: unknown) => fs.ReadStream)(file, settings);
  }) as typeof fs.createReadStream);
  try {
    const backup = await backupWorktree(options("verify-middle", 5, () => held));
    try {
      armed = true;
      // The reads reuse the guard that held; the Git step after them asks it.
      await expect(backup.verify()).rejects.toThrow(/^backup ownership changed$/);
      expect(streams).toBeGreaterThanOrEqual(3);
    } finally { backup.close(); }
  } finally { stream.mockRestore(); }
});
