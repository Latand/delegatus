import { execFile, spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { githubRepositoryOfRemote } from "@/lib/forge/workLinks";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { latestOperationalStageAttempt } from "@/lib/pipelines/attemptSelection";
import type { Pipeline } from "@/lib/pipelines/types";

const exec = promisify(execFile);
const maxBuffer = 4 * 1024 * 1024;
const commitSha = /^[a-f0-9]{40}$/;

export type MergedReleasePr = {
  commit: string;
  pr: number;
  head?: string;
  branch?: string;
  body?: string;
  sameRepository: boolean;
};

async function bodyMatchesReleaseCut(body: string, cut: string, git: (...args: string[]) => Promise<string>): Promise<boolean> {
  const fields = [...body.matchAll(/^Release-Cut:[ \t]*(.*)$/gim)].map(match => match[1]!.trim().toLowerCase());
  // Older release PRs named the production cut in prose, sometimes abbreviated.
  const prose = [...body.matchAll(/\bproduction cut `?([a-f0-9]{10,40})\b/gi)].map(match => match[1]!.toLowerCase());
  const declaredCuts = new Set([...fields, ...prose]);
  if (!declaredCuts.size) return false;
  for (const sha of declaredCuts) {
    if (!/^[a-f0-9]{10,40}$/.test(sha) || !cut.startsWith(sha)
      || (sha !== cut && await git("rev-parse", "--verify", `${sha}^{commit}`) !== cut)) return false;
  }
  return true;
}

async function releasePatchId(repoDir: string, base: string, head: string, signal: AbortSignal): Promise<string | null> {
  const diff = spawn("git", ["--no-replace-objects", "diff", "--binary", "--full-index", "--no-renames",
    "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--ignore-submodules=none",
    "--src-prefix=a/", "--dst-prefix=b/", "--unified=0", base, head, "--"],
    { cwd: repoDir, stdio: ["ignore", "pipe", "ignore"], signal });
  const diffExit = new Promise<number | null>(resolve => {
    diff.on("error", () => {});
    diff.on("close", resolve);
  });
  const hash = exec("git", ["patch-id", "--verbatim"], { cwd: repoDir, signal, maxBuffer });
  const [exit, copied, result] = await Promise.allSettled([diffExit, pipeline(diff.stdout, hash.child.stdin!, { signal }), hash]);
  if (exit.status !== "fulfilled" || exit.value !== 0 || copied.status !== "fulfilled" || result.status !== "fulfilled") return null;
  const id = result.value.stdout.split(" ")[0] ?? "";
  return commitSha.test(id) ? id : null;
}

export async function proveForgeRelease(repoDir: string, repo: string, main: string, pr: MergedReleasePr, cut: string,
  project: string, preparation: Pipeline, lane: Pipeline): Promise<boolean> {
  const targetsPr = (target: NonNullable<Pipeline["delivery"]>["target"]) =>
    canonicalOrchestratorProject(target.repository) === project
      && githubRepositoryOfRemote(target.remote)?.toLowerCase() === repo.toLowerCase() && target.branch === `refs/heads/${pr.branch}`
      && (target.pr == null || target.pr === pr.pr) && !target.prRepository;
  const delivery = lane.delivery;
  const terminalOwner = lane.state === "completed" || (lane.id === preparation.id && lane.state === "closed");
  if (!pr.sameRepository || typeof pr.branch !== "string" || !pr.branch || typeof pr.body !== "string"
    || !pr.head || !commitSha.test(pr.head) || !preparation.delivery || !targetsPr(preparation.delivery.target)
    || !delivery || !targetsPr(delivery.target) || delivery.disposition !== "owner" || delivery.ownerId !== lane.id
    || delivery.active || !terminalOwner) return false;
  const review = latestOperationalStageAttempt(lane, "review");
  const reviewed = review?.state === "passed" ? review.reviewHeadSha ?? review.outputBaseHead ?? review.report?.provenance.head : null;
  // A fix-only owner supplies its completed head. The publisher still
  // independently reviews the integrated commit before it can tag.
  const fixOnlySuccessor = lane.id !== preparation.id && lane.stages.length === 1 && lane.stages[0]?.id === "fix";
  const reviewedHead = reviewed ?? (fixOnlySuccessor ? lane.lastPassedCommit : null);
  if (!reviewedHead || !commitSha.test(reviewedHead)) return false;

  const signal = AbortSignal.timeout(30_000);
  const git = async (...args: string[]) => (await exec("git", ["--no-replace-objects", ...args], { cwd: repoDir, signal, maxBuffer })).stdout.trim();
  try {
    if (!await bodyMatchesReleaseCut(pr.body, cut, git)) return false;
    await git("merge-base", "--is-ancestor", pr.commit, main);
    await git("merge-base", "--is-ancestor", cut, pr.commit);
    const differentHeads = [...new Set([reviewedHead, pr.head])].filter(head => head !== pr.commit);
    if (!differentHeads.length) return true;
    const tree = await git("rev-parse", `${pr.commit}^{tree}`);
    const landingBases = (await git("rev-list", "--first-parent", pr.commit)).split("\n").filter(Boolean);
    for (const head of differentHeads) {
      try { await git("cat-file", "-e", `${head}^{commit}`); }
      catch { await git("fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin", head); }
      await git("merge-base", "--is-ancestor", cut, head);
      let rangeMatched = false;
      // GitHub's rebase mergeCommit is the new base tip and may have several
      // rebased commits behind it. Find the first-parent boundary whose whole
      // landed suffix matches the reviewed PR contribution and replays to the
      // recorded integrated tree. This also handles a batch landing after a
      // companion PR already advanced main.
      for (const base of landingBases) {
        if (base === pr.commit) continue;
        try { await git("merge-base", "--is-ancestor", cut, base); }
        catch { continue; }
        const landedPatch = await releasePatchId(repoDir, base, pr.commit, signal);
        const reviewedBase = await git("merge-base", base, head);
        const reviewedPatch = await releasePatchId(repoDir, reviewedBase, head, signal);
        if (!landedPatch || !reviewedPatch || landedPatch !== reviewedPatch) continue;
        if (await git("merge-tree", "--write-tree", "--no-messages", base, head) !== tree) continue;
        rangeMatched = true;
        break;
      }
      if (!rangeMatched) return false;
    }
    return true;
  } catch { return false; }
}
