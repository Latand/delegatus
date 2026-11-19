import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const query = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit {
    oid signature { isValid wasSignedByGitHub }
  } } }
}`;

type Lookup = (url: string, init: RequestInit) => Promise<Response>;

/** The ordinary scanner has no switch for a single-parent forge identity.
 * Only the trusted main-push entry point obtains this evidence from GitHub. */
export async function signedLandedTip(env: NodeJS.ProcessEnv, gitIdentity: string, token: string | undefined, lookup: Lookup = fetch): Promise<string | undefined> {
  const fields = gitIdentity.split("\0");
  const repo = /^([\w.-]+)\/([\w.-]+)$/.exec(env.GITHUB_REPOSITORY ?? "");
  if (!repo || !token || env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF_PROTECTED !== "true" ||
      !env.PRIVACY_DEFAULT_BRANCH || env.GITHUB_REF !== "refs/heads/" + env.PRIVACY_DEFAULT_BRANCH ||
      fields.length !== 3 || !/^[0-9a-f]{40}$/.test(fields[0]!) || fields[0] !== env.GITHUB_SHA ||
      fields[1] !== "GitHub" || fields[2] !== ["noreply", "github.com"].join("@")) return undefined;
  try {
    const response = await lookup("https://api.github.com/graphql", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { owner: repo[1], name: repo[2], oid: fields[0] } }),
    });
    if (response.ok) {
      const result = await response.json();
      const commit = result.data?.repository?.object;
      if (!result.errors && commit?.oid === fields[0] && commit.signature?.isValid === true &&
          commit.signature.wasSignedByGitHub === true) return commit.oid;
    }
  } catch { /* Missing signature evidence leaves the ordinary identity checks in force. */ }
  console.warn("GitHub signature could not be confirmed for the landed committer");
  return undefined;
}

if (import.meta.main) {
  const token = process.env.PRIVACY_PUSH_TOKEN;
  delete process.env.PRIVACY_PUSH_TOKEN;
  const repository = resolve("../candidate");
  const base = process.env.PRIVACY_BASE_SHA;
  if (!base || !/^[0-9a-f]{40}$/.test(base)) throw new Error("protected push base unavailable");
  const identity = execFileSync("git", ["--no-replace-objects", "-C", repository, "log", "-1", "--format=%H%x00%cn%x00%ce"], { encoding: "utf8" }).trimEnd();
  const verified = await signedLandedTip(process.env, identity, token);
  const { runPublicationGate } = await import("./privacy-publication-gate");
  runPublicationGate(["--repository", repository, "--require-known-values", "--check-commits", "--base", base], verified);
}
