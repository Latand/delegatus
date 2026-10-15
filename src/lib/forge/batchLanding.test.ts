import { expect, test } from "bun:test";
import { readBatchLanding } from "./batchLanding";

const REPO = "acme/widgets";
const LANDING = "c".repeat(40);
const TIP = "d".repeat(40);
const BODY = `Landed on main as ${LANDING} through #9. https://github.com/${REPO}/pull/9`;

function github(options: {
  body?: string; association?: string; batchState?: string; base?: string;
  landingStatus?: string; mainStatus?: string; mergeBase?: string; failAt?: "comments" | "batch" | "comparison";
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
  expect(await readBatchLanding(REPO, 7, "main", gh.run)).toEqual({ commit: LANDING, mergedAt: "2026-10-11T04:18:00Z" });
  expect(gh.calls.filter((args) => args[1]?.includes("/compare/")).map((args) => args[1])).toEqual([
    `repos/${REPO}/compare/${LANDING}...${TIP}`, `repos/${REPO}/compare/${TIP}...main`,
  ]);
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
] as const) test(`${name} cannot prove a landing`, async () => {
  const gh = github(options);
  expect(await readBatchLanding(REPO, 7, "main", gh.run)).toBeNull();
});

for (const failAt of ["comments", "batch", "comparison"] as const) test(`a failed ${failAt} read remains a read failure`, async () => {
  const gh = github({ failAt });
  await expect(readBatchLanding(REPO, 7, "main", gh.run)).rejects.toThrow("unavailable");
});
