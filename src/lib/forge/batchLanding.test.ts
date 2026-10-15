import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBatchLanding } from "./batchLanding";
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
