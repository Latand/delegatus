import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { canonicalProject, persistProjectAliases, resetProjectAliasesForTests } from "@/lib/projects/aliases";
import { directoryProjectId, projectIdentityFromRepositoryRoot } from "@/lib/projects/identity";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { projectCatalogSnapshotFromRaw } from "@/lib/scanner/projectCatalog";
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
    return filename;
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
  const f = fixture(); f.transcript(f.repo + "-review", { branch: "lane/7" }); f.write();
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
  f.transcript(cwd, { branch: "lane/7" });
  const manual = [{ project: f.identity.project, root: f.repo, displayName: f.identity.displayName, createdAt: 0 }];
  expect(planWorktreeBackfill(f.files, {}, undefined, manual).folded[0]?.target).toBe(f.identity.project);
  const map = { [f.repo + "-old"]: { repo: f.repo, worktree: "old" } };
  expect(planWorktreeBackfill(f.files, map).folded[0]?.target).toBe(f.identity.project);
});

test("name-only, unproven and unreadable evidence remains separate in preview and apply", async () => {
  const f = fixture();
  const unsupported = f.repo + "-review";
  fs.mkdirSync(unsupported);
  f.transcript(unsupported);
  fs.rmdirSync(unsupported);
  f.transcript(f.repo + "-lane-8", { branch: "missing" });
  f.transcript(f.repo + "-lane-9", { branch: "lane" }); // A ref directory is no branch proof.
  const unreadable = f.transcript(f.repo + "-pipeline-dead", { branch: "lane/7" });
  fs.unlinkSync(unreadable);
  // One readable session cannot hide an unreadable peer at the same cwd.
  f.transcript(f.repo + "-pipeline-dead", { repository_url: "https://example.invalid/team/widgets.git" });
  f.write();
  const preview = await backfillWorktreeProjects();
  expect(preview.folded).toEqual([]);
  expect(preview.leftAlone.map(item => item.reason)).toEqual([
    "missing-native-evidence", "unproven-branch-hint", "unproven-branch-hint", "unreadable-transcript",
  ]);
  const applied = await backfillWorktreeProjects({ dryRun: false }, async () => {});
  expect(applied.leftAlone).toEqual(preview.leftAlone);
  expect(applied.folded).toEqual([]);
  expect(fs.existsSync(path.join(f.state, "worktree-map.json"))).toBe(false);
  for (const item of applied.leftAlone) {
    expect(canonicalProject(item.source)).toBe(item.source);
    expect(projectInfoFromCwd(item.cwd)?.project).toBe(item.source);
  }
});

test("conflicting descendants veto the whole checkout and remain separate after a real catalog rescan", async () => {
  const f = fixture();
  const checkout = f.repo + "-lane-7";
  const mainFile = f.transcript(checkout, { repository_url: "https://example.invalid/team/widgets.git" });
  const foreignCwd = path.join(checkout, "foreign");
  const foreignFile = f.transcript(foreignCwd, { repository_url: "https://example.invalid/team/foreign.git" });
  const raw = Object.keys(f.files).map(filename => ({
    rootName: "codex-sessions" as const, root: f.disk, path: filename, st: fs.statSync(filename),
  }));
  await projectCatalogSnapshotFromRaw(raw);
  const preview = await backfillWorktreeProjects();
  expect(preview.folded).toEqual([]);
  expect(preview.leftAlone).toHaveLength(2);
  expect(preview.leftAlone.every(item => item.reason === "conflicting-repository-hint")).toBe(true);
  let rescanned: Awaited<ReturnType<typeof projectCatalogSnapshotFromRaw>> | undefined;
  const applied = await backfillWorktreeProjects({ dryRun: false }, async () => {
    rescanned = await projectCatalogSnapshotFromRaw(raw);
  });
  expect(applied.folded).toEqual([]);
  expect(applied.leftAlone).toEqual(preview.leftAlone);
  expect(rescanned!.projectByPath.get(mainFile)).toBe(directoryProjectId(checkout));
  expect(rescanned!.projectByPath.get(foreignFile)).toBe(directoryProjectId(foreignCwd));
  expect(canonicalProject(directoryProjectId(foreignCwd))).toBe(directoryProjectId(foreignCwd));
  expect(fs.existsSync(path.join(f.state, "worktree-map.json"))).toBe(false);
});

test("descendant evidence is checked even when only another subdirectory needs recovery", () => {
  const f = fixture();
  const checkout = f.repo + "-lane-7";
  const cwd = path.join(checkout, "src");
  f.transcript(cwd, { branch: "lane/7" });
  const foreign = f.transcript(path.join(checkout, "foreign"), { repository_url: "https://example.invalid/team/foreign.git" });
  expect(planWorktreeBackfill(f.files, {}).folded).toEqual([]);
  // Records already on a repo- project are affected by the root mapping too.
  f.files[foreign]!.project = "repo-" + "f".repeat(32);
  expect(planWorktreeBackfill(f.files, {}).leftAlone[0]?.reason).toBe("conflicting-repository-hint");
  fs.unlinkSync(foreign);
  expect(planWorktreeBackfill(f.files, {}).leftAlone[0]?.reason).toBe("unreadable-transcript");
});

test("conflicting descendant identities and recorded mappings veto ancestor recovery", () => {
  const f = fixture();
  const checkout = f.repo + "-lane-7";
  f.transcript(checkout, { branch: "lane/7" });
  const child = path.join(checkout, "child");
  const childFile = f.transcript(child);
  const map = { [child]: { repo: path.join(f.disk, "foreign"), worktree: "foreign" } };
  expect(planWorktreeBackfill(f.files, map).folded).toEqual([]);
  expect(planWorktreeBackfill(f.files, map).leftAlone[0]?.reason).toBe("conflicting-recorded-worktree");
  f.files[childFile]!.project = "repo-" + "f".repeat(32);
  expect(planWorktreeBackfill(f.files, {}).leftAlone[0]?.reason).toBe("conflicting-project-identity");
  f.files[childFile]!.project = directoryProjectId(child);
  expect(persistProjectAliases([{ source: directoryProjectId(child), target: "repo-" + "f".repeat(32), displayName: "foreign" }])).toBe(true);
  const conflicted = planWorktreeBackfill(f.files, {});
  expect(conflicted.folded).toEqual([]);
  expect(conflicted.leftAlone.every(item => item.reason === "project-alias-conflict")).toBe(true);
});

test("a project filter cannot resolve globally ambiguous siblings in preview or apply", async () => {
  const f = fixture();
  const other = f.repo + "-v1";
  fs.mkdirSync(path.join(other, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(other, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(other, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/team/other.git\n');
  for (const repo of [f.repo, other]) fs.writeFileSync(path.join(repo, ".git", "refs", "heads", "main"), "a".repeat(40));
  const identity = projectIdentityFromRepositoryRoot(other)!;
  f.files["other.jsonl"] = { cwd: other, project: identity.project, projectRoot: other };
  const cwd = other + "-review";
  f.transcript(cwd, { branch: "main" }); f.write();
  const unscoped = await backfillWorktreeProjects();
  expect(unscoped.folded).toEqual([]);
  expect(unscoped.leftAlone[0]?.reason).toBe("ambiguous-repository");
  for (const project of [f.identity.project, identity.project]) {
    const preview = await backfillWorktreeProjects({ project });
    expect(preview).toEqual(unscoped);
    const applied = await backfillWorktreeProjects({ project, dryRun: false }, async () => {});
    expect(applied.folded).toEqual([]);
    expect(applied.leftAlone).toEqual(unscoped.leftAlone);
  }
  expect(fs.existsSync(path.join(f.state, "worktree-map.json"))).toBe(false);
  expect(canonicalProject(directoryProjectId(cwd))).toBe(directoryProjectId(cwd));
});

test("corroborated checkout evidence folds every compatible descendant after catalog rescan", async () => {
  const f = fixture();
  const checkout = f.repo + "-lane-7";
  f.transcript(checkout, { branch: "lane/7" });
  f.transcript(path.join(checkout, "src"));
  const raw = Object.keys(f.files).map(filename => ({
    rootName: "codex-sessions" as const, root: f.disk, path: filename, st: fs.statSync(filename),
  }));
  await projectCatalogSnapshotFromRaw(raw);
  const preview = await backfillWorktreeProjects({ project: f.identity.project });
  expect(preview.folded).toHaveLength(2);
  expect(preview.leftAlone).toEqual([]);
  let rescanned: Awaited<ReturnType<typeof projectCatalogSnapshotFromRaw>> | undefined;
  const applied = await backfillWorktreeProjects({ project: f.identity.project, dryRun: false }, async () => {
    rescanned = await projectCatalogSnapshotFromRaw(raw);
  });
  expect(applied.folded).toEqual(preview.folded);
  expect([...rescanned!.projectByPath.values()].every(project => project === f.identity.project)).toBe(true);
  for (const item of applied.folded) expect(canonicalProject(item.source)).toBe(f.identity.project);
});

test("matching recorded mappings and packed branches supply affirmative evidence", () => {
  const f = fixture();
  const cwd = f.repo + "-review";
  f.transcript(cwd);
  const map = { [cwd]: { repo: f.repo, worktree: "review" } };
  expect(planWorktreeBackfill(f.files, map).folded[0]?.reason).toBe("recorded-worktree");
  fs.writeFileSync(path.join(f.repo, ".git", "packed-refs"), "a".repeat(40) + " refs/heads/retained\n");
  f.transcript(cwd, { branch: "retained" });
  expect(planWorktreeBackfill(f.files, {}).folded[0]?.reason).toBe("sibling-name-and-branch-hint");
  expect(planWorktreeBackfill(f.files, {}, "repo-" + "f".repeat(32)).leftAlone[0]?.reason).toBe("target-outside-project");
});

test("branch corroboration follows a known repository's git pointer and common refs", () => {
  const f = fixture();
  const common = path.join(f.disk, "git-data");
  fs.renameSync(path.join(f.repo, ".git"), common);
  const metadata = path.join(common, "worktrees", "known");
  fs.mkdirSync(metadata, { recursive: true });
  fs.writeFileSync(path.join(metadata, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(metadata, "commondir"), "../..\n");
  fs.writeFileSync(path.join(f.repo, ".git"), `gitdir: ${path.relative(f.repo, metadata)}\n`);
  f.transcript(f.repo + "-review", { branch: "lane/7" });
  expect(planWorktreeBackfill(f.files, {}).folded[0]?.reason).toBe("sibling-name-and-branch-hint");
});
