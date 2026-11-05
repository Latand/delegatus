import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bootstrapReleaseTools } from "./bootstrap-release-tools";

test("a frozen release cut replaces existing verifier and hook with current main copies", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-tool-bootstrap-"));
  const main = path.join(root, "main");
  const cut = path.join(root, "cut");
  const remote = path.join(root, "origin.git");
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, "no-global-config"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete env[key];
  const checkout = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const tools = ["scripts/release-verify.ts", "scripts/local-gate.ts"] as const;
  try {
    fs.mkdirSync(main);
    fs.mkdirSync(path.join(main, "scripts"));
    fs.mkdirSync(cut);
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { env, stdio: "ignore" });
    checkout(main, "init", "-b", "main");
    checkout(main, "config", "user.name", "Fixture");
    checkout(main, "config", "user.email", "noreply@example.invalid");
    const current = new Map(tools.map(relative => [relative, fs.readFileSync(path.join(import.meta.dir, relative.slice("scripts/".length)), "utf8")]));
    for (const relative of tools) fs.writeFileSync(path.join(main, relative), current.get(relative)!);
    fs.writeFileSync(path.join(main, "package.json"), JSON.stringify({ name: "release-fixture", version: "1.1.0" }));
    checkout(main, "add", ...tools, "package.json");
    checkout(main, "commit", "-m", "current release tools");
    checkout(main, "remote", "add", "origin", remote);
    checkout(main, "push", "origin", "main");

    checkout(cut, "clone", remote, ".");
    // Repository-local identity settings are not copied by clone.
    checkout(cut, "config", "user.name", "Fixture");
    checkout(cut, "config", "user.email", "noreply@example.invalid");
    checkout(cut, "checkout", "-b", "release");
    for (const relative of tools) fs.writeFileSync(path.join(cut, relative), `old cut copy of ${relative}\n`);
    checkout(cut, "add", ...tools);
    checkout(cut, "commit", "-m", "frozen cut has older tools");

    bootstrapReleaseTools(cut);
    // Execute the refreshed verifier from the old checkout, using real Git.
    const { verifyRelease } = await import(pathToFileURL(path.join(cut, "scripts/release-verify.ts")).href);
    const cutSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: cut, env, encoding: "utf8" }).trim();
    const ports = { command: async (file: string, args: string[]) => file === "git"
      ? execFileSync(file, args, { cwd: cut, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
      : JSON.stringify({ state: "OPEN", headRefOid: cutSha, baseRefName: "main", mergeCommit: null }),
      registry: async () => null, now: () => 0, wait: async () => {}, provenance: () => true };
    expect((await verifyRelease("v1.1.0", cutSha, ports, "7")).errors.join("\n")).toContain("release PR is unmerged");
    expect((await verifyRelease("v1.1.0", cutSha, ports)).errors.join("\n")).toContain("not on origin/main");

    for (const relative of tools) expect(fs.readFileSync(path.join(cut, relative), "utf8")).toBe(current.get(relative)!);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: cut, env, encoding: "utf8" }).trim())
      .not.toBe(execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: cut, env, encoding: "utf8" }).trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
