import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { projectForCwd } from "@/lib/scanner/describe";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { namedProjectDirectory, resolveNamedProject, ProjectNameRefusal } from "@/lib/projects/nameResolution";
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
  const projectRoot = path.join(sandbox, "Projects", "orion-console");
  const sources = { lastCompletedCatalog: () => ({ files: [], projectCatalog: [
    { project: "project-orion", displayName: "Orion Console", projectRoot },
  ] }) };
  const encodedDirectory = projectRoot.replaceAll(path.sep, "-").toLowerCase();
  for (const query of ["project-orion", "old", "orion-console", "example/orion-console", encodedDirectory, "Orion Console"]) {
    expect([query, resolveProjectScope(query, indexed, sources).resolved]).toEqual([query, "project-orion"]);
  }
  expect(resolveProjectScope("unknown", indexed)).toMatchObject({ resolved: null, note: expect.stringContaining("searched every project") });
});

test("unknown qualified owners refuse while catalog-verified encoded directories resolve", () => {
  fs.writeFileSync(path.join(sandbox, "project-aliases.json"), JSON.stringify({ schemaVersion: 1, aliases: {}, displayNames: { "known-orion": "Orion" } }));
  fs.writeFileSync(path.join(sandbox, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { "known-orion": "github.com/acme/orion" } }));
  const projectRoot = path.join(sandbox, "Projects", "orion");
  const directory = namedProjectDirectory({ lastCompletedCatalog: () => ({ files: [], projectCatalog: [
    { project: "known-orion", displayName: "Orion", projectRoot },
  ] }) });

  expect(resolveNamedProject("acme/orion", directory)).toBe("known-orion");
  expect(resolveNamedProject(projectRoot.replaceAll(path.sep, "-"), directory)).toBe("known-orion");
  expect(() => resolveNamedProject("other-owner/orion", directory)).toThrow(ProjectNameRefusal);
  expect(() => resolveNamedProject("repo-unknown/acme/orion", directory)).toThrow(ProjectNameRefusal);
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

test("search retains the shared resolver's two-seat candidates instead of picking an alias suffix", () => {
  persistProjectAliases([{ source: "orion-old", target: "project-orion-a", displayName: "Orion" }]);
  for (const [project, requestId] of [["project-orion-a", "seat-orion-a"], ["project-orion-b", "seat-orion-b"]]) {
    beginOrchestratorSeatIntent({ project, mandate: "Own this board", clientRequestId: requestId, mode: "spawn", promptVersion: null });
    completeOrchestratorSeatIntent({ project, clientRequestId: requestId, conversationId: `conversation_${project}`, path: null });
  }
  const sources = { lastCompletedCatalog: () => ({ files: [], projectCatalog: [
    { project: "project-orion-b", displayName: "Orion", projectRoot: null },
  ] }) };
  expect(resolveProjectScope("Orion", new Set(["project-orion-a", "project-orion-b"]), sources)).toMatchObject({
    requested: "Orion", resolved: null, candidates: [
      { project: "project-orion-a", name: "Orion" }, { project: "project-orion-b", name: "Orion" },
    ],
  });
});

test("search folds a seated catalog worktree into its indexed parent known through another source", () => {
  const root = path.join(sandbox, "parent");
  fs.mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/example/parent.git"], { cwd: root });
  const parent = projectForCwd(root)!;
  beginOrchestratorSeatIntent({ project: "worktree-child", mandate: "Own this board", clientRequestId: "seat-worktree-child", mode: "spawn", promptVersion: null });
  completeOrchestratorSeatIntent({ project: "worktree-child", clientRequestId: "seat-worktree-child", conversationId: "conversation_worktree_child", path: null });
  const sources = { lastCompletedCatalog: () => ({ files: [], projectCatalog: [
    { project: "worktree-child", displayName: "Parent lane", projectRoot: path.join(root, ".worktrees", "gone") },
  ] }) };
  expect(resolveProjectScope("Parent lane", new Set([parent, "worktree-child"]), sources).resolved).toBe(parent);
});
