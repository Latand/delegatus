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

/** Only the trusted default-branch push entry point obtains this evidence. */
export async function landedPushEvidence(env: NodeJS.ProcessEnv, gitIdentity: string, token: string | undefined, lookup: Lookup = fetch): Promise<LandedPushEvidence | undefined> {
  const fields = gitIdentity.split("\0");
  const repository = env.GITHUB_REPOSITORY ?? "";
  const repo = /^([\w.-]+)\/([\w.-]+)$/.exec(repository);
  if (!repo || !token || env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF_PROTECTED !== "true" ||
      !env.PRIVACY_DEFAULT_BRANCH || env.GITHUB_REF !== "refs/heads/" + env.PRIVACY_DEFAULT_BRANCH ||
      fields.length !== 3 || !/^[0-9a-f]{40}$/.test(fields[0]!) || fields[0] !== env.GITHUB_SHA ||
      fields[1] !== "GitHub" || fields[2] !== ["noreply", "github.com"].join("@")) return undefined;
  const tip = fields[0]!;
  const signal = AbortSignal.timeout(10_000);
  const request = async (query: string, page?: { after: string | null }) => {
    const response = await lookup("https://api.github.com/graphql", {
      method: "POST", redirect: "error", signal,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { owner: repo[1], name: repo[2], oid: tip, ...page } }),
    });
    if (!response.ok) return undefined;
    const result = await response.json();
    const commit = result?.data?.repository?.object;
    return !result?.errors && commit?.oid === tip ? commit : undefined;
  };

  const signed = await request(signatureQuery).catch(() => undefined);
  if (signed?.signature?.isValid !== true || signed.signature.wasSignedByGitHub !== true) {
    console.warn("GitHub signature could not be confirmed for the landed committer");
    return undefined;
  }

  /* A signature proves GitHub signed these bytes; the squash message can still
     be edited before signing. So a trailer is exempt only when its address is
     one GitHub recorded on a commit of the exact pull request this squash
     landed. A matching handwritten line discloses nothing GitHub's own
     composition would not. Rebase-and-merge leaves unsigned commits and a
     merge commit has two parents, so both stop here. */
  if (signed.parents?.totalCount !== 1) return { tip };
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
          pull.baseRepository?.nameWithOwner !== repository || pull.mergeCommit?.oid !== tip ||
          typeof pull.headRefOid !== "string" || !/^[0-9a-f]{40}$/.test(pull.headRefOid) || pull.headRefOid === tip) break;
      pullId = pull.id;
      if (!Array.isArray(pull.commits?.nodes)) break;
      for (const node of pull.commits.nodes) {
        for (const person of [node?.commit?.author, node?.commit?.committer]) {
          if (typeof person?.email === "string" && person.email) addresses.add(person.email);
        }
      }
      const page = pull.commits.pageInfo;
      if (page?.hasNextPage === false) return { tip, squashAddresses: [...addresses] };
      if (page?.hasNextPage !== true || typeof page.endCursor !== "string" ||
          !page.endCursor || cursors.has(page.endCursor)) break;
      after = page.endCursor;
      cursors.add(page.endCursor);
    }
  } catch { /* Unavailable pull request evidence leaves every trailer attributable. */ }
  return { tip };
}

if (import.meta.main) {
  const token = process.env.PRIVACY_PUSH_TOKEN;
  delete process.env.PRIVACY_PUSH_TOKEN;
  const repository = resolve("../candidate");
  const base = process.env.PRIVACY_BASE_SHA;
  if (!base || !/^[0-9a-f]{40}$/.test(base)) throw new Error("protected push base unavailable");
  const identity = execFileSync("git", ["--no-replace-objects", "-C", repository, "log", "-1", "--format=%H%x00%cn%x00%ce"], { encoding: "utf8" }).trimEnd();
  const verified = await landedPushEvidence(process.env, identity, token);
  const { runPublicationGate } = await import("./privacy-publication-gate");
  runPublicationGate(["--repository", repository, "--require-known-values", "--check-commits", "--base", base], verified);
}
