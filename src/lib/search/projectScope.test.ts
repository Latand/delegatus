import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { projectForCwd } from "@/lib/scanner/describe";
import { resolveProjectScope } from "./projectScope";

const previous = process.env.LLV_STATE_DIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-project-scope-"));
process.env.LLV_STATE_DIR = sandbox;
afterAll(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("keys, aliases, repository names, owner/name and encoded directories resolve indexed identities", () => {
  fs.writeFileSync(path.join(sandbox, "project-aliases.json"), JSON.stringify({ schemaVersion: 1, aliases: { old: "project-orion" }, displayNames: { "project-orion": "Orion Console" } }));
  fs.writeFileSync(path.join(sandbox, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { "project-orion": "github.com/example/orion-console" } }));
  const indexed = new Set(["project-orion"]);
  for (const query of ["project-orion", "old", "orion-console", "example/orion-console", "repo-github.com/example/orion-console", "-home-fixture-Projects-orion-console", "Orion Console"]) {
    expect(resolveProjectScope(query, indexed).resolved).toBe("project-orion");
  }
  expect(resolveProjectScope("unknown", indexed)).toMatchObject({ resolved: null, note: expect.stringContaining("searched every project") });
});

test("a deleted conventional worktree path follows the scanner parent identity", () => {
  const root = path.join(sandbox, "orion");
  fs.mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/example/orion.git"], { cwd: root });
  const key = projectForCwd(root)!;
  expect(resolveProjectScope(path.join(root, ".worktrees", "patch", "src"), new Set([key])).resolved).toBe(key);
});

test("ambiguous repository names widen explicitly", () => {
  fs.writeFileSync(path.join(sandbox, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { a: "github.com/example/orion", b: "github.com/another/orion" } }));
  expect(resolveProjectScope("orion", new Set(["a", "b"])).resolved).toBeNull();
  expect(resolveProjectScope("example/orion", new Set(["a", "b"])).resolved).toBe("a");
});
