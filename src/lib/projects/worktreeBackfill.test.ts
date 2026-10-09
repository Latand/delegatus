import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { canonicalProject, resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { directoryProjectId, projectIdentityFromRepositoryRoot } from "@/lib/projects/identity";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { backfillWorktreeProjects, planWorktreeBackfill } from "./worktreeBackfill";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-recovery-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let serial = 0;
function fixture() {
  const disk = path.join(root, String(++serial));
  const state = path.join(disk, "state");
  const repo = path.join(disk, "widgets");
  fs.mkdirSync(path.join(repo, ".git", "refs", "heads", "lane"), { recursive: true });
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repo, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/team/widgets.git\n');
  fs.writeFileSync(path.join(repo, ".git", "refs", "heads", "lane", "7"), "a".repeat(40));
  const identity = projectIdentityFromRepositoryRoot(repo)!;
  process.env.LLV_STATE_DIR = state;
  resetProjectAliasesForTests();
  const files: Record<string, { project: string; cwd: string; projectRoot: string | null }> = {};
  const transcript = (cwd: string, hint: Record<string, unknown> = {}, source = directoryProjectId(cwd)) => {
    const filename = path.join(disk, `session-${Object.keys(files).length}.jsonl`);
    fs.writeFileSync(filename, JSON.stringify({ type: "session_meta", payload: { cwd, git: hint } }) + "\n");
    files[filename] = { project: source, cwd, projectRoot: source === identity.project ? repo : null };
  };
  transcript(repo, {}, identity.project);
  const write = () => fs.writeFileSync(path.join(state, "project-catalog.json"), JSON.stringify({ version: 2, files }));
  return { state, repo, identity, files, transcript, write, disk };
}

test("dry-run plans supported removed siblings, uses native hints and changes no bytes", async () => {
  const f = fixture();
  for (const suffix of ["lane-7", "pipeline-deadbeef", "review", "v1.2.3-fix"]) f.transcript(f.repo + "-" + suffix, { branch: "lane/7" });
  f.transcript(f.repo + "-lane-8", { repository_url: "https://example.invalid/team/foreign.git" });
  f.transcript(f.repo + "-notes");
  f.transcript(path.join(f.disk, "elsewhere", "widgets-lane-9"));
  fs.mkdirSync(f.repo + "-lane-10"); f.transcript(f.repo + "-lane-10");
  f.write();
  const before = fs.readFileSync(path.join(f.state, "project-catalog.json"));
  let rescans = 0;
  const plan = await backfillWorktreeProjects({}, async () => { rescans++; });
  expect(plan.folded).toHaveLength(4);
  expect(plan.folded.every(item => item.reason === "sibling-name-and-branch-hint")).toBe(true);
  expect(plan.leftAlone.map(item => item.reason).sort()).toEqual(["checkout-present-or-unreadable", "conflicting-repository-hint", "no-known-sibling-repository", "no-known-sibling-repository"].sort());
  expect(rescans).toBe(0);
  expect(fs.readdirSync(f.state)).toEqual(["project-catalog.json"]);
  expect(fs.readFileSync(path.join(f.state, "project-catalog.json"))).toEqual(before);
});

test("apply records checkout roots, folds directory keys, rescans and can be repeated", async () => {
  const f = fixture();
  const checkout = f.repo + "-pipeline-abcdef";
  const cwd = path.join(checkout, "src");
  f.transcript(cwd, { repository_url: "https://example.invalid/team/widgets.git" }); f.write();
  let scans = 0;
  const result = await backfillWorktreeProjects({ dryRun: false }, async () => { scans++; });
  expect(result).toMatchObject({ dryRun: false, rescanned: true });
  expect(scans).toBe(1);
  expect(JSON.parse(fs.readFileSync(path.join(f.state, "worktree-map.json"), "utf8"))[checkout]).toEqual({ repo: f.repo, worktree: path.basename(checkout) });
  expect(canonicalProject(directoryProjectId(cwd))).toBe(f.identity.project);
  expect(projectInfoFromCwd(cwd)).toMatchObject({ project: f.identity.project, displayName: f.identity.displayName });
  await backfillWorktreeProjects({ dryRun: false }, async () => { scans++; });
  expect(scans).toBe(2);
});

test("wrong directory keys and existing competing mappings stay untouched", () => {
  const f = fixture();
  const cwd = f.repo + "-lane-7";
  f.transcript(cwd, {}, directoryProjectId(f.repo + "-other"));
  expect(planWorktreeBackfill(f.files, {}).leftAlone[0]?.reason).toBe("directory-identity-mismatch");
  f.transcript(f.repo + "-review");
  const map = { [f.repo + "-review"]: { repo: path.join(f.disk, "foreign"), worktree: "review" } };
  const plan = planWorktreeBackfill(f.files, map);
  expect(plan.folded).toHaveLength(0);
  expect(plan.leftAlone[1]?.reason).toBe("recorded-repository-not-known");
});

test("corrupt maps refuse apply without replacing state", async () => {
  const f = fixture(); f.transcript(f.repo + "-review"); f.write();
  const file = path.join(f.state, "worktree-map.json"); fs.writeFileSync(file, "broken");
  await expect(backfillWorktreeProjects({ dryRun: false })).rejects.toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe("broken");
});

test("incomplete rescan is reported and a retry retains the mapping", async () => {
  const f = fixture(); f.transcript(f.repo + "-review"); f.write();
  await expect(backfillWorktreeProjects({ dryRun: false }, async () => { throw Error("rescan failed"); })).rejects.toThrow("rescan failed");
  expect(fs.existsSync(path.join(f.state, "worktree-map.json"))).toBe(true);
  expect((await backfillWorktreeProjects({ dryRun: false }, async () => {})).rescanned).toBe(true);
});

test("an overlapping version suffix and sibling repository are ambiguous", () => {
  const f = fixture();
  const other = f.repo + "-v1";
  fs.mkdirSync(path.join(other, ".git"), { recursive: true });
  fs.writeFileSync(path.join(other, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(other, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/team/other.git\n');
  const identity = projectIdentityFromRepositoryRoot(other)!;
  f.files["other.jsonl"] = { cwd: other, project: identity.project, projectRoot: other };
  f.transcript(other + "-review");
  const plan = planWorktreeBackfill(f.files, {});
  expect(plan.folded).toHaveLength(0);
  expect(plan.leftAlone[0]?.reason).toBe("ambiguous-repository");
});

test("repositories known through curation or a durable worktree map need no main-checkout transcript", () => {
  const f = fixture();
  delete f.files[Object.keys(f.files)[0]!];
  const cwd = f.repo + "-lane-7";
  f.transcript(cwd);
  const manual = [{ project: f.identity.project, root: f.repo, displayName: f.identity.displayName, createdAt: 0 }];
  expect(planWorktreeBackfill(f.files, {}, undefined, manual).folded[0]?.target).toBe(f.identity.project);
  const map = { [f.repo + "-old"]: { repo: f.repo, worktree: "old" } };
  expect(planWorktreeBackfill(f.files, map).folded[0]?.target).toBe(f.identity.project);
});
