import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBatchLanding, readCarriedBranchLanding } from "./batchLanding";
import { batchLandingFixture } from "./batchLanding.fixture";

const REPO = "acme/widgets";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "batch-landing-test-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));
const graph = batchLandingFixture(scratch);
const LANDING = graph.landing;
const TIP = graph.tip;
const reviewed = { head: graph.head, repoDir: graph.directory };
const BODY = `Landed on main as ${LANDING} through #9. https://github.com/${REPO}/pull/9`;

function github(options: {
  body?: string; association?: string; batchState?: string; base?: string;
  landingStatus?: string; mainStatus?: string; mergeBase?: string; failAt?: "comments" | "batch" | "comparison";
  movingBase?: boolean;
} = {}) {
  const calls: string[][] = [];
  return { calls, run: async (args: string[]) => {
    calls.push(args);
    if (args[1] === `repos/${REPO}/issues/7/comments?per_page=100`) {
      if (options.failAt === "comments") throw new Error("comments unavailable");
      // --paginate --jq yields one JSON line per comment, across all pages.
      return [JSON.stringify({ body: "Earlier discussion", author_association: "OWNER" }),
        JSON.stringify({ body: options.body ?? BODY, author_association: options.association ?? "OWNER" })].join("\n");
    }
    if (args[0] === "pr" && args[1] === "view" && args[2] === "9") {
      if (options.failAt === "batch") throw new Error("batch unavailable");
      return JSON.stringify({ state: options.batchState ?? "MERGED", baseRefName: options.base ?? "main", mergeCommit: { oid: TIP }, mergedAt: "2026-10-11T04:18:00Z" });
    }
    if (args[1] === `repos/${REPO}/branches/main`) return options.movingBase
      && calls.filter((call) => call[1] === args[1]).length > 1 ? "f".repeat(40) : graph.base;
    if (args[1]?.startsWith(`repos/${REPO}/compare/`)) {
      if (options.failAt === "comparison") throw new Error("comparison unavailable");
      const sha = args[1].split("/compare/")[1]!.split("...")[0]!;
      return JSON.stringify({ status: (sha === LANDING ? options.landingStatus : options.mainStatus) ?? "ahead", merge_base_commit: { sha: options.mergeBase ?? sha } });
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  } };
}

test("a collaborator's rebased batch receipt resolves the individual landing SHA", async () => {
  const gh = github();
  expect(await readBatchLanding(REPO, 7, "main", reviewed, gh.run)).toEqual({ commit: LANDING, mergedAt: "2026-10-11T04:18:00Z" });
  expect(gh.calls.filter((args) => args[1]?.includes("/compare/")).map((args) => args[1])).toEqual([
    `repos/${REPO}/compare/${LANDING}...${TIP}`, `repos/${REPO}/compare/${TIP}...${graph.base}`,
  ]);
});

test("missing landing objects are fetched without moving refs or the index", async () => {
  const clone = path.join(scratch, "lane-clone");
  graph.git("clone", "--no-local", "--single-branch", "--branch", "lane", graph.directory, clone);
  const { execFileSync } = await import("node:child_process");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: clone, encoding: "utf8" });
  const before = { refs: git("show-ref"), index: fs.readFileSync(path.join(clone, ".git", "index")) };
  const gh = github();
  expect(await readBatchLanding(REPO, 7, "main", { head: graph.head, repoDir: clone }, gh.run))
    .toEqual({ commit: LANDING, mergedAt: "2026-10-11T04:18:00Z" });
  expect(git("show-ref")).toBe(before.refs);
  expect(fs.readFileSync(path.join(clone, ".git", "index"))).toEqual(before.index);
  expect(git("status", "--porcelain")).toBe("");
  expect(fs.existsSync(path.join(clone, ".git", "FETCH_HEAD"))).toBe(false);
});

test("unavailable Git evidence never settles a receipt", async () => {
  const gh = github();
  await expect(readBatchLanding(REPO, 7, "main", { ...reviewed, repoDir: path.join(scratch, "gone") }, gh.run))
    .rejects.toThrow("Git evidence is unavailable");
});

for (const [name, options] of [
  ["ordinary closure", { body: "Closing because the change was declined." }],
  ["untrusted receipt", { association: "NONE" }],
  ["quoted receipt", { body: `> ${BODY}` }],
  ["different receipt base", { body: BODY.replace("on main", "on release") }],
  ["unmerged batch", { batchState: "CLOSED" }],
  ["batch targeting another base", { base: "release" }],
  ["landing outside the batch", { landingStatus: "diverged" }],
  ["batch outside main", { mainStatus: "behind" }],
  ["comparison naming another ancestor", { mergeBase: "e".repeat(40) }],
  ["base moving during verification", { movingBase: true }],
] as const) test(`${name} cannot prove a landing`, async () => {
  const gh = github(options);
  expect(await readBatchLanding(REPO, 7, "main", reviewed, gh.run)).toBeNull();
});

for (const failAt of ["comments", "batch", "comparison"] as const) test(`a failed ${failAt} read remains a read failure`, async () => {
  const gh = github({ failAt });
  await expect(readBatchLanding(REPO, 7, "main", reviewed, gh.run)).rejects.toThrow("unavailable");
});

function carriedGithub(g = graph, options: {
  association?: string; quoted?: boolean; open?: boolean; declined?: boolean; wrongBase?: boolean;
  outsideMain?: boolean; wrongAncestor?: boolean; movingBase?: boolean;
  failAt?: "comments" | "carriers" | "base" | "comparison";
} = {}) {
  const calls: Array<{ scope: "issues" | "contents"; args: string[] }> = [];
  const issueRead = async (args: string[]) => {
    calls.push({ scope: "issues", args });
    if (args[1] === `repos/${REPO}/issues/7/comments?per_page=100`) {
      if (options.failAt === "comments") throw new Error("comments unavailable");
      return JSON.stringify({ body: `${options.quoted ? "> " : ""}Landed in batch/widgets as ${g.landing}.`, author_association: options.association ?? "COLLABORATOR" });
    }
    if (args[1] === `repos/${REPO}/commits/${g.landing}/pulls?per_page=100`) {
      if (options.failAt === "carriers") throw new Error("carriers unavailable");
      return JSON.stringify([{ number: 9, state: options.open ? "open" : "closed", merged_at: options.open || options.declined ? null : "2026-10-11T04:18:00Z",
        merge_commit_sha: g.tip, base: { ref: options.wrongBase ? "release" : "main" }, head: { ref: "batch/widgets" } }]);
    }
    throw new Error("unexpected issue read");
  };
  const contentsRead = async (args: string[]) => {
    calls.push({ scope: "contents", args });
    if (args[1] === `repos/${REPO}/branches/main`) {
      if (options.failAt === "base") throw new Error("base unavailable");
      return options.movingBase && calls.filter(call => call.args[1] === args[1]).length > 1 ? "f".repeat(40) : g.base;
    }
    if (args[1]?.includes("/compare/")) {
      if (options.failAt === "comparison") throw new Error("comparison unavailable");
      const sha = args[1].split("/compare/")[1]!.split("...")[0]!;
      return JSON.stringify({ status: options.outsideMain ? "diverged" : "ahead", merge_base_commit: { sha: options.wrongAncestor ? "e".repeat(40) : sha } });
    }
    throw new Error("unexpected contents read");
  };
  return { calls, issueRead, contentsRead };
}

test("a closed work PR's commit reference is verified against its reviewed patch and default branch", async () => {
  const gh = carriedGithub();
  expect(await readCarriedBranchLanding(REPO, 7, "main", reviewed, gh.issueRead, gh.contentsRead))
    .toEqual({ state: "landed", batch: 9, mergedAt: "2026-10-11T04:18:00Z", commit: graph.landing });
  expect(gh.calls.every(call => call.scope === (call.args[1]!.includes("/issues/") || call.args[1]!.includes("/commits/") ? "issues" : "contents"))).toBe(true);
});

test("an open carrier records its identity while preserving the waiting state", async () => {
  const gh = carriedGithub(graph, { open: true });
  expect(await readCarriedBranchLanding(REPO, 7, "main", reviewed, gh.issueRead, gh.contentsRead))
    .toEqual({ state: "waiting", batch: 9, commit: graph.landing });
});

for (const [name, options] of [
  ["declined carrier", { declined: true }], ["carrier on another base", { wrongBase: true }],
  ["carrier outside main", { outsideMain: true }], ["different ancestor", { wrongAncestor: true }],
  ["default branch moving during verification", { movingBase: true }],
] as const) test(`a closed PR with ${name} cannot prove delivery`, async () => {
  const gh = carriedGithub(graph, options);
  expect(await readCarriedBranchLanding(REPO, 7, "main", reviewed, gh.issueRead, gh.contentsRead)).toMatchObject({ state: "waiting" });
});

test.each([{ association: "NONE" }, { quoted: true }])("a comment is only a hint; Git and forge proof authorize delivery %j", async options => {
  const gh = carriedGithub(graph, options);
  expect(await readCarriedBranchLanding(REPO, 7, "main", reviewed, gh.issueRead, gh.contentsRead))
    .toMatchObject({ state: "landed", commit: graph.landing });
  const wrong = batchLandingFixture(scratch, "wrong-sha"), bad = carriedGithub(wrong, options);
  expect(await readCarriedBranchLanding(REPO, 7, "main", { head: wrong.head, repoDir: wrong.directory }, bad.issueRead, bad.contentsRead))
    .toMatchObject({ state: "waiting" });
});

for (const kind of ["wrong-sha", "wrong-occurrence", "reverted", "new-head", "partial-revert"] as const) {
  test(`a collaborator hint with ${kind} Git evidence cannot close an issue`, async () => {
    const g = batchLandingFixture(scratch, kind), gh = carriedGithub(g);
    expect(await readCarriedBranchLanding(REPO, 7, "main", { head: g.head, repoDir: g.directory }, gh.issueRead, gh.contentsRead))
      .toMatchObject({ state: "waiting" });
  });
}

test("App contents refusal wins before an unavailable Git directory can be read", async () => {
  const gh = carriedGithub(graph, { failAt: "base" });
  await expect(readCarriedBranchLanding(REPO, 7, "main", { ...reviewed, repoDir: path.join(scratch, "unavailable-git") }, gh.issueRead, gh.contentsRead))
    .rejects.toThrow("base unavailable");
});

for (const failAt of ["comments", "carriers", "comparison"] as const) test(`a closed-PR ${failAt} read failure retains its cause`, async () => {
  const gh = carriedGithub(graph, { failAt });
  await expect(readCarriedBranchLanding(REPO, 7, "main", reviewed, gh.issueRead, gh.contentsRead)).rejects.toThrow(`${failAt} unavailable`);
});

test("a bounded receipt page continues past unrelated commit references", async () => {
  const g = batchLandingFixture(scratch), gh = carriedGithub(g);
  const root = g.git("rev-list", "--max-parents=0", "HEAD");
  g.git("checkout", "-b", "noise", root);
  const references: string[] = [];
  let extra = root;
  for (let index = 0; index < 5; index++) {
    fs.writeFileSync(path.join(g.directory, "unrelated"), `unrelated update ${index}\n`);
    g.git("add", "unrelated"); g.git("commit", "-m", "Unrelated update");
    extra = g.git("rev-parse", "HEAD"); references.push(extra);
  }
  g.git("checkout", "main"); references.push(g.landing);
  const read = async (args: string[]) => args[1]!.includes("/issues/7/comments")
    ? JSON.stringify({ body: `Landed in batch/widgets; references ${references.join(" ")}`, author_association: "OWNER" })
    : references.slice(0, 5).some(sha => args[1]!.includes(`/commits/${sha}/`)) ? "[]" : gh.issueRead(args);
  const first = await readCarriedBranchLanding(REPO, 7, "main", { head: g.head, repoDir: g.directory }, read, gh.contentsRead);
  expect(first.state).toBe("waiting");
  if (first.state !== "waiting") throw new Error("Expected a bounded first page");
  expect(first.after).toBe(extra);
  expect(await readCarriedBranchLanding(REPO, 7, "main", { head: g.head, repoDir: g.directory, after: first.after }, read, gh.contentsRead))
    .toEqual({ state: "landed", batch: 9, mergedAt: "2026-10-11T04:18:00Z", commit: g.landing });
});

test("a language-neutral batch-tip hint may contain other reviewed work", async () => {
  const gh = carriedGithub();
  const read = async (args: string[]) => {
    if (args[1]!.includes("/issues/7/comments")) return JSON.stringify({ body: `Включено комітом ${graph.tip}.` });
    if (args[1] === `repos/${REPO}/commits/${graph.tip}/pulls?per_page=100`) {
      return gh.issueRead(["api", `repos/${REPO}/commits/${graph.landing}/pulls?per_page=100`]);
    }
    return gh.issueRead(args);
  };
  expect(await readCarriedBranchLanding(REPO, 7, "main", reviewed, read, gh.contentsRead))
    .toEqual({ state: "landed", batch: 9, mergedAt: "2026-10-11T04:18:00Z", commit: graph.tip });
});


test("a nonexistent untrusted hint cannot hide a later verified delivery", async () => {
  const gh = carriedGithub(), missing = "0".repeat(40);
  const read = async (args: string[]) => {
    if (args[1]!.includes("/issues/7/comments")) return JSON.stringify({ body: `${missing} ${graph.landing}` });
    if (args[1]!.includes(`/commits/${missing}/`)) throw new Error("HTTP 404: commit not found");
    return gh.issueRead(args);
  };
  expect(await readCarriedBranchLanding(REPO, 7, "main", reviewed, read, gh.contentsRead))
    .toMatchObject({ state: "landed", commit: graph.landing });
});
