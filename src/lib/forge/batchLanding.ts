import type { GithubRunner } from "@/lib/monitor/githubEvidence";

/** The batch merger verifies each rebased patch before closing its original
 * PR with this receipt. Only a repository collaborator's receipt is accepted;
 * the named batch and both ancestry links are read again from GitHub. */
export async function readBatchLanding(repository: string, number: number, base: string, run: GithubRunner): Promise<{ commit: string; mergedAt: string | null } | null> {
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
    // A rebased batch contains one commit per lane; this lane's receipt can
    // name an earlier commit than the batch PR's mergeCommit.
    if (await ancestor(commit, tip) && await ancestor(tip, base)) return { commit, mergedAt: batch.mergedAt ?? null };
  }
  return null;
}
