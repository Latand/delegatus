import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GithubRunner } from "@/lib/monitor/githubEvidence";
import { realExec } from "@/lib/workflows/provision";

/** Compare exact changed lines, paths, modes and binary payloads across a
 * rebase, then reverse-merge it from the base tree and compare the whole
 * resulting change. Already reverted hunks become no-ops and cannot pass.
 * Git writes only objects; the checkout, index and branch refs stay untouched. */
async function patchPresent(repoDir: string, head: string, landing: string, base: string): Promise<boolean> {
  if (![head, landing, base].every((sha) => /^[0-9a-f]{40}$/i.test(sha))) return false;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "llv-batch-patch-"));
  const env = { GIT_NO_REPLACE_OBJECTS: "1" };
  const git = (args: string[]) => realExec("git", args, repoDir, env, { timeoutMs: 30_000 });
  const checked = async (args: string[]) => {
    const result = await git(args);
    if (result.code !== 0) throw new Error("batch landing Git evidence is unavailable");
    return result.stdout.trim();
  };
  try {
    const missing: string[] = [];
    for (const sha of new Set([head, landing, base])) {
      if ((await git(["cat-file", "-e", `${sha}^{commit}`])).code !== 0) missing.push(sha);
    }
    if (missing.length) await checked(["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin", ...missing]);
    const parents = (await checked(["rev-list", "--parents", "-n", "1", landing])).split(" ");
    if (parents.length !== 2) return false;
    const fork = await checked(["merge-base", parents[1]!, head]);
    const patch = async (from: string, to: string, name: string, context = 3) => {
      const file = path.join(scratch, name);
      await checked(["diff", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color",
        "--no-indent-heuristic", "--ignore-submodules=none", "--binary", "--full-index", `--unified=${context}`, `--output=${file}`, from, to, "--"]);
      return { file, signature: fs.readFileSync(file, "latin1").split("\n")
        .filter((line) => !line.startsWith("index "))
        .map((line) => line.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, "@@")).join("\n") };
    };
    const reviewed = await patch(fork, head, "reviewed.diff");
    const landed = await patch(parents[1]!, landing, "landed.diff");
    if (!reviewed.signature.trim() || reviewed.signature !== landed.signature) return false;
    const reversed = await git(["-c", "merge.renames=false", "merge-tree", "--write-tree", "--no-messages", `--merge-base=${landing}`, base, parents[1]!]);
    if (reversed.code !== 0) return false;
    const tree = reversed.stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(tree)) return false;
    const expectedReverse = await patch(landing, parents[1]!, "expected-reverse.diff", 0);
    return (await patch(base, tree, "current-reverse.diff", 0)).signature === expectedReverse.signature;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The batch merger verifies each rebased patch before closing its original
 * PR with this receipt. Only a repository collaborator's receipt is accepted;
 * the watcher independently verifies the reviewed patch and its presence on
 * the base, as well as the named batch and both ancestry links. */
export async function readBatchLanding(repository: string, number: number, base: string, reviewed: { head: string; repoDir: string }, run: GithubRunner): Promise<{ commit: string; mergedAt: string | null } | null> {
  const raw = await run(["api", `repos/${repository}/issues/${number}/comments?per_page=100`, "--paginate", "--jq", ".[] | {body, author_association} | @json"]);
  const receipts = raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as { body?: unknown; author_association?: unknown });
  for (const receipt of receipts.reverse()) {
    if (!["OWNER", "MEMBER", "COLLABORATOR"].includes(String(receipt.author_association)) || typeof receipt.body !== "string") continue;
    const match = /^Landed on (\S+) as ([0-9a-f]{40}) through #([1-9]\d*)\.(?:\s|$)/i.exec(receipt.body);
    if (!match || match[1] !== base || Number(match[3]) === number) continue;
    const commit = match[2]!.toLowerCase();
    const batch = JSON.parse(await run(["pr", "view", match[3]!, "--repo", repository, "--json", "state,baseRefName,mergeCommit,mergedAt"])) as {
      state?: string; baseRefName?: string; mergeCommit?: { oid?: string }; mergedAt?: string;
    };
    const tip = batch.mergeCommit?.oid;
    if (batch.state !== "MERGED" || batch.baseRefName !== base || !tip || !/^[0-9a-f]{40}$/i.test(tip)) continue;
    const ancestor = async (sha: string, target: string): Promise<boolean> => {
      if (sha === target) return true;
      const comparison = JSON.parse(await run(["api", `repos/${repository}/compare/${sha}...${encodeURIComponent(target)}`, "--jq", "{status, merge_base_commit: {sha: .merge_base_commit.sha}}"]));
      return (comparison.status === "ahead" || comparison.status === "identical") && comparison.merge_base_commit?.sha === sha;
    };
    const baseTip = (await run(["api", `repos/${repository}/branches/${encodeURIComponent(base)}`, "--jq", ".commit.sha"])).trim();
    if (!/^[0-9a-f]{40}$/i.test(baseTip)) throw new Error("batch landing base tip is unavailable");
    // A rebased batch contains one commit per lane. Ancestry alone also
    // admits a reverted patch or a receipt for an older PR head.
    if (await ancestor(commit, tip) && await ancestor(tip, baseTip)
      && await patchPresent(reviewed.repoDir, reviewed.head, commit, baseTip)) {
      const current = (await run(["api", `repos/${repository}/branches/${encodeURIComponent(base)}`, "--jq", ".commit.sha"])).trim();
      if (current === baseTip) return { commit, mergedAt: batch.mergedAt ?? null };
    }
  }
  return null;
}
