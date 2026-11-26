import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { LandedPushEvidence } from "./privacy-publication-gate";

const signatureQuery = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit {
    oid signature { isValid wasSignedByGitHub } parents(first: 1) { totalCount }
  } } }
}`;

/* GitHub composes a squash's Co-authored-by trailers from the identities of the
   pull request's commits, so those identities are the only addresses a landed
   trailer may carry. Both the author and the committer address are read. */
const identitiesQuery = `query($owner: String!, $name: String!, $oid: GitObjectID!, $after: String) {
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit {
    oid
    associatedPullRequests(first: 1) {
      pageInfo { hasNextPage }
      nodes {
        id merged baseRefName baseRepository { nameWithOwner } headRefOid mergeCommit { oid }
        commits(first: 100, after: $after) {
          nodes { commit { author { email } committer { email } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  } } }
}`;

type Lookup = (url: string, init: RequestInit) => Promise<Response>;

/* A stack can land as one push, one squash per pull request, so each commit the
   forge committed is verified on its own. The bound keeps the request count
   finite; a commit past it keeps its committer and trailers attributable. */
const MAX_VERIFIED_COMMITS = 20;
const FORGE_COMMITTER = ["noreply", "github.com"].join("@");

type FirstParentCommit = { commit: string; committerAddress: string; committerName: string; parents: number };

/* `git log --first-parent --format=%H%x00%P%x00%cn%x00%ce base..tip`, newest
   first. Any line that does not parse voids the whole range. */
function firstParentCommits(range: string): FirstParentCommit[] | undefined {
  const commits: FirstParentCommit[] = [];
  for (const line of range.split("\n")) {
    if (line === "") continue;
    const fields = line.split("\0");
    if (fields.length !== 4 || !/^[0-9a-f]{40}$/.test(fields[0]!)) return undefined;
    const parents = fields[1] === "" ? [] : fields[1]!.split(" ");
    if (!parents.every((parent) => /^[0-9a-f]{40}$/.test(parent))) return undefined;
    commits.push({ commit: fields[0]!, committerAddress: fields[3]!, committerName: fields[2]!, parents: parents.length });
  }
  return commits;
}

/** Only the trusted default-branch push entry point obtains this evidence.
 * `range` lists the pushed range's first-parent commits, newest first. */
export async function landedPushEvidence(env: NodeJS.ProcessEnv, range: string, token: string | undefined, lookup: Lookup = fetch): Promise<LandedPushEvidence | undefined> {
  const repository = env.GITHUB_REPOSITORY ?? "";
  const repo = /^([\w.-]+)\/([\w.-]+)$/.exec(repository);
  const commits = firstParentCommits(range);
  if (!repo || !token || env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF_PROTECTED !== "true" ||
      !env.PRIVACY_DEFAULT_BRANCH || env.GITHUB_REF !== "refs/heads/" + env.PRIVACY_DEFAULT_BRANCH ||
      !commits?.length || commits[0]!.commit !== env.GITHUB_SHA) return undefined;

  const verify = async (landed: FirstParentCommit) => {
    const signal = AbortSignal.timeout(10_000);
    const request = async (query: string, page?: { after: string | null }) => {
      const response = await lookup("https://api.github.com/graphql", {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { owner: repo[1], name: repo[2], oid: landed.commit, ...page } }),
      });
      if (!response.ok) return undefined;
      const result = await response.json();
      const commit = result?.data?.repository?.object;
      return !result?.errors && commit?.oid === landed.commit ? commit : undefined;
    };

    const signed = await request(signatureQuery).catch(() => undefined);
    if (signed?.signature?.isValid !== true || signed.signature.wasSignedByGitHub !== true) return { signed: false };

    /* A signature proves GitHub signed these bytes; the squash message can still
       be edited before signing. So a trailer is exempt only when its address is
       one GitHub recorded on a commit of the exact pull request this squash
       landed. A matching handwritten line discloses nothing GitHub's own
       composition would not. Rebase-and-merge leaves unsigned commits and a
       merge commit has two parents, so both stop here. */
    if (landed.parents !== 1 || signed.parents?.totalCount !== 1) return { signed: true };
    try {
      const addresses = new Set<string>();
      const cursors = new Set<string>();
      let after: string | null = null;
      let pullId: string | undefined;
      while (!signal.aborted) {
        const commit = await request(identitiesQuery, { after });
        const associated = commit?.associatedPullRequests;
        if (associated?.pageInfo?.hasNextPage !== false || !Array.isArray(associated.nodes) || associated.nodes.length !== 1) break;
        const pull = associated.nodes[0];
        if (typeof pull?.id !== "string" || (pullId !== undefined && pullId !== pull.id) ||
            pull.merged !== true || pull.baseRefName !== env.PRIVACY_DEFAULT_BRANCH ||
            pull.baseRepository?.nameWithOwner !== repository || pull.mergeCommit?.oid !== landed.commit ||
            typeof pull.headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(pull.headRefOid) || pull.headRefOid === landed.commit) break;
        pullId = pull.id;
        if (!Array.isArray(pull.commits?.nodes)) break;
        for (const node of pull.commits.nodes) {
          for (const person of [node?.commit?.author, node?.commit?.committer]) {
            if (typeof person?.email === "string" && person.email) addresses.add(person.email);
          }
        }
        const page = pull.commits.pageInfo;
        if (page?.hasNextPage === false) return { signed: true, squashAddresses: [...addresses] };
        if (page?.hasNextPage !== true || typeof page.endCursor !== "string" ||
            !page.endCursor || cursors.has(page.endCursor)) break;
        after = page.endCursor;
        cursors.add(page.endCursor);
      }
    } catch { /* Unavailable pull request evidence leaves every trailer attributable. */ }
    return { signed: true };
  };

  const signedCommits: string[] = [];
  const squashAddresses: Record<string, readonly string[]> = {};
  /* Only a commit git records as committed by the forge can be its squash. */
  const forgeCommitted = commits.filter(({ committerAddress, committerName }) =>
    committerName === "GitHub" && committerAddress === FORGE_COMMITTER).slice(0, MAX_VERIFIED_COMMITS);
  for (const landed of forgeCommitted) {
    const result = await verify(landed);
    if (!result.signed) {
      console.warn(`GitHub signature could not be confirmed for the landed committer of ${landed.commit.slice(0, 12)}`);
      continue;
    }
    signedCommits.push(landed.commit);
    if (result.squashAddresses) squashAddresses[landed.commit] = result.squashAddresses;
  }
  if (signedCommits.length === 0) return undefined;
  return Object.keys(squashAddresses).length > 0 ? { signedCommits, squashAddresses } : { signedCommits };
}

if (import.meta.main) {
  const token = process.env.PRIVACY_PUSH_TOKEN;
  delete process.env.PRIVACY_PUSH_TOKEN;
  const repository = resolve("../candidate");
  const base = process.env.PRIVACY_BASE_SHA;
  if (!base || !/^[0-9a-f]{40}$/.test(base)) throw new Error("protected push base unavailable");
  const range = execFileSync("git", ["--no-replace-objects", "-C", repository, "log", "--first-parent", "--no-abbrev-commit",
    "--format=%H%x00%P%x00%cn%x00%ce", `${base}..HEAD`], { encoding: "utf8" });
  const verified = await landedPushEvidence(process.env, range, token);
  const { runPublicationGate } = await import("./privacy-publication-gate");
  runPublicationGate(["--repository", repository, "--require-known-values", "--check-commits", "--base", base], verified);
}
