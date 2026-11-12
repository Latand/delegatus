import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GithubRunner } from "@/lib/monitor/githubEvidence";
import { realExec } from "@/lib/workflows/provision";

/** Replay the reviewed change onto the landing parent and compare trees,
 * then reverse-merge it from the base tree and compare the whole resulting
 * change. Already reverted hunks become no-ops and cannot pass.
 * Closed-PR hints may name a batch tip with companion changes; that mode
 * verifies the reviewed diff itself, leaving the native exact-patch rule intact.
 * Git writes only objects; the checkout, index and branch refs stay untouched. */
async function patchPresent(repoDir: string, head: string, landing: string, base: string, allowCompanions = false): Promise<boolean> {
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
    if (allowCompanions ? parents.length < 2 : parents.length !== 2) return false;
    const fork = await checked(["merge-base", allowCompanions ? landing : parents[1]!, head]);
    // Git's three-way replay preserves which occurrence was reviewed while
    // incorporating nearby edits and line shifts from the landing parent.
    const replayed = await git(["-c", "merge.renames=false", "merge-tree", "--write-tree", "--no-messages", `--merge-base=${fork}`, allowCompanions ? landing : parents[1]!, head]);
    if (replayed.code !== 0 || replayed.stdout.trim() !== await checked(["rev-parse", `${landing}^{tree}`])) return false;
    const patch = async (from: string, to: string, name: string) => {
      const file = path.join(scratch, name);
      await checked(["diff", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color",
        "--no-indent-heuristic", "--ignore-submodules=none", "--binary", "--full-index", "--unified=0", `--output=${file}`, from, to, "--"]);
      return { file, signature: fs.readFileSync(file, "latin1").split("\n")
        .filter((line) => !line.startsWith("index "))
        .map((line) => line.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, "@@")).join("\n") };
    };
    const reverseBase = allowCompanions ? head : landing;
    const reverseParent = allowCompanions ? fork : parents[1]!;
    const expectedReverse = await patch(reverseBase, reverseParent, "expected-reverse.diff");
    if (!expectedReverse.signature.trim()) return false;
    const reversed = await git(["-c", "merge.renames=false", "merge-tree", "--write-tree", "--no-messages", `--merge-base=${reverseBase}`, base, reverseParent]);
    if (reversed.code !== 0) return false;
    const tree = reversed.stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(tree)) return false;
    return (await patch(base, tree, "current-reverse.diff")).signature === expectedReverse.signature;
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

export type CarriedBranchLanding = { state: "waiting"; batch?: number; commit?: string; after?: string; unproven?: true }
  | { state: "landed"; batch: number; mergedAt: string; commit: string };

/** A locally squashed work PR is closed rather than GitHub-merged. A
 * comment's commit reference is only a hint: replay the reviewed patch,
 * verify its carrier and default-branch ancestry, then recheck the base tip.
 * The separate reader carries contents-read permission, never issue writes. */
export async function readCarriedBranchLanding(repository: string, number: number, base: string,
  reviewed: { head: string; repoDir: string; commit?: string; after?: string }, issueRead: GithubRunner, contentsRead: GithubRunner): Promise<CarriedBranchLanding> {
  if (!/^[0-9a-f]{40}$/i.test(reviewed.head)) throw new Error("Reviewed batch head is unavailable");
  if (typeof base !== "string" || !base) throw new Error("Batch default branch is unavailable");
  const raw = await issueRead(["api", `repos/${repository}/issues/${number}/comments?per_page=100`, "--paginate", "--jq", ".[] | {body} | @json"]);
  const comments = raw.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as { body?: unknown });
  const all = [...new Set(comments.reverse().flatMap(comment => {
    if (typeof comment.body !== "string") return [];
    return [...comment.body.matchAll(/\b[0-9a-f]{40}\b/gi)].map(match => match[0].toLowerCase());
  }))];
  const preferred = reviewed.commit && /^[0-9a-f]{40}$/i.test(reviewed.commit) ? reviewed.commit.toLowerCase() : undefined;
  const cursor = reviewed.after ? all.indexOf(reviewed.after) + 1 : 0;
  const start = cursor >= all.length ? 0 : cursor;
  const page = all.slice(start, start + (preferred ? 4 : 5));
  const candidates = [...new Set([...(preferred ? [preferred] : []), ...page])];
  const after = start + page.length < all.length ? page.at(-1) : undefined;
  const baseTip = async () => {
    const value = (await contentsRead(["api", `repos/${repository}/branches/${encodeURIComponent(base)}`, "--jq", ".commit.sha"])).trim();
    if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error("Batch default tip is unavailable");
    return value;
  };
  const ancestor = async (sha: string, target: string) => {
    if (sha === target) return true;
    const value = JSON.parse(await contentsRead(["api", `repos/${repository}/compare/${sha}...${target}?per_page=1`, "--jq", "{status, merge_base_commit:{sha:.merge_base_commit.sha}}"]));
    return ["ahead", "identical"].includes(value.status) && value.merge_base_commit?.sha === sha;
  };
  if (!candidates.length) return { state: "waiting" };
  // Establish App read authority before Git may fetch a missing object.
  const current = await baseTip();
  let waitingBatch: number | undefined;
  let provenCommit: string | undefined;
  let unproven = false;
  let openCarrier: { batch: number; commit: string } | undefined;
  for (const commit of candidates) {
    if (!await patchPresent(reviewed.repoDir, reviewed.head, commit, commit, true)) continue;
    provenCommit ??= commit;
    const carriers = JSON.parse(await issueRead(["api", `repos/${repository}/commits/${commit}/pulls?per_page=100`])) as Array<{
      number?: number; state?: string; merged_at?: string | null; merge_commit_sha?: string | null;
      base?: { ref?: string }; head?: { ref?: string };
    }>;
    if (!Array.isArray(carriers)) throw new Error("Batch carrier list is unavailable");
    for (const carrier of carriers) {
      const batch = carrier.number;
      if (typeof batch !== "number" || !Number.isSafeInteger(batch) || batch <= 0 || batch === number
        || carrier.base?.ref !== base) continue;
      if (!carrier.merged_at) {
        if (carrier.state === "open") openCarrier ??= { batch, commit };
        continue;
      }
      const tip = carrier.merge_commit_sha;
      if (carrier.state !== "closed" || !Number.isFinite(Date.parse(carrier.merged_at)) || !tip || !/^[0-9a-f]{40}$/i.test(tip)) throw new Error("Batch carrier is invalid");
      unproven = true;
      waitingBatch = batch; provenCommit = commit;
      if (await ancestor(commit, tip) && await ancestor(tip, current)
        && await patchPresent(reviewed.repoDir, reviewed.head, commit, current, true)
        && await baseTip() === current) return { state: "landed", batch, mergedAt: carrier.merged_at, commit };
    }
  }
  if (openCarrier) return { state: "waiting", ...openCarrier, ...(after ? { after } : {}) };
  return { state: "waiting", ...(waitingBatch ? { batch: waitingBatch } : {}), ...(provenCommit ? { commit: provenCommit } : {}), ...(after ? { after } : {}), ...(unproven ? { unproven: true } : {}) };
}
