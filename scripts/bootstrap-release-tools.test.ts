import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapReleaseTools } from "./bootstrap-release-tools";

test("a frozen release cut replaces existing verifier and hook with current main copies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-tool-bootstrap-"));
  const main = path.join(root, "main");
  const cut = path.join(root, "cut");
  const remote = path.join(root, "origin.git");
  const checkout = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  const tools = ["scripts/release-verify.ts", "scripts/local-gate.ts"] as const;
  try {
    fs.mkdirSync(main);
    fs.mkdirSync(path.join(main, "scripts"));
    fs.mkdirSync(cut);
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    checkout(main, "init", "-b", "main");
    checkout(main, "config", "user.name", "Fixture");
    checkout(main, "config", "user.email", "noreply@example.invalid");
    const current = new Map(tools.map(relative => [relative, fs.readFileSync(path.join(import.meta.dir, relative.slice("scripts/".length)), "utf8")]));
    for (const relative of tools) fs.writeFileSync(path.join(main, relative), current.get(relative)!);
    checkout(main, "add", ...tools);
    checkout(main, "commit", "-m", "current release tools");
    checkout(main, "remote", "add", "origin", remote);
    checkout(main, "push", "origin", "main");

    checkout(cut, "clone", remote, ".");
    checkout(cut, "checkout", "-b", "release");
    for (const relative of tools) fs.writeFileSync(path.join(cut, relative), `old cut copy of ${relative}\n`);
    checkout(cut, "add", ...tools);
    checkout(cut, "commit", "-m", "frozen cut has older tools");

    bootstrapReleaseTools(cut);

    for (const relative of tools) expect(fs.readFileSync(path.join(cut, relative), "utf8")).toBe(current.get(relative)!);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: cut, encoding: "utf8" }).trim())
      .not.toBe(execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: cut, encoding: "utf8" }).trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
