import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { LandedPushEvidence } from "./privacy-publication-gate";

const signatureQuery = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit {
    oid signature { isValid wasSignedByGitHub } parents(first: 1) { totalCount }
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

  // A signature proves GitHub signed these bytes, not that GitHub generated
  // any particular trailer. The squash message can be edited before signing,
  // and the API exposes no trailer-level provenance. Keep the tip evidence
  // for the separately scoped committer exemption; trailers remain attributable.
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
