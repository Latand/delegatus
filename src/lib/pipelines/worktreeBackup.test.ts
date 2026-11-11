import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
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

async function backup(captures: number, pipelineId: string, guard: () => boolean) {
  const { directory, head } = checkout(captures);
  const result = await backupWorktree({ directory, pipelineId, head, branch: "main", ignored: ["results/"], disposable: () => false, guard });
  result.close();
  return result;
}

test("the number of guard reads does not grow with the number of evidence files", async () => {
  let few = 0, many = 0;
  await backup(3, "guard-few", () => { few++; return true; });
  await backup(60, "guard-many", () => { many++; return true; });
  expect(fs.readdirSync(statePath("evidence", "guard-many", "worktree", "results"))).toHaveLength(60);
  expect(fs.readFileSync(statePath("evidence", "guard-many", "worktree", "results", "capture-59.png"), "utf8")).toBe("capture 59");
  expect(many).toBe(few);
});

test("ownership lost while evidence is copied still refuses the backup", async () => {
  const saved = statePath("evidence", "guard-lost", "worktree", "results", "capture-0.png");
  await expect(backup(8, "guard-lost", () => !fs.existsSync(saved))).rejects.toThrow();
});

test("with no reuse every evidence read asks the guard", async () => {
  const { directory, head } = checkout(4);
  const saved = statePath("evidence", "guard-each", "worktree", "results", "capture-0.png");
  await expect(backupWorktree({ directory, pipelineId: "guard-each", head, branch: "main", ignored: ["results/"],
    disposable: () => false, guard: () => !fs.existsSync(saved), guardReuseMs: 0 })).rejects.toThrow("while reading evidence");
});
