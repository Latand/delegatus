import fs from "node:fs/promises";
import path from "node:path";
import { realExec, type ExecPort } from "@/lib/workflows/provision";
import { readOperatorSettings } from "@/lib/operator/settings";
import { canonicalSensitiveText } from "@/lib/privacy/canonicalText";
import { mailboxPattern } from "@/lib/privacy/mailbox";
import { COMMIT_ACCOUNT_REFUSAL, ownerNoreplyAddress, resolveForgeCommitAccount } from "./forgeCommitAccount";
import { controllerCommitIdentityEnv } from "./controllerCommitIdentity";

export const DELEGATUS_COAUTHOR = "Co-Authored-By: Delegatus <" + ["noreply", "delegatus.invalid"].join("@") + ">";
export const REPOSITORY_IDENTITY = "LLV_REPOSITORY_PUBLICATION_IDENTITY";

/** The checked-in publication configuration opts a project into the machine
 * identity policy. Neither the checkout name nor its remote chooses policy. */
export async function repositoryHasPrivacyPolicy(cwd: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
    if (!manifest.scripts?.["privacy:check"]?.includes("privacy-publication-gate")) return false;
    await fs.access(path.join(cwd, "scripts/privacy-known-value-fingerprints.json"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("Repository publication configuration could not be read (values withheld)");
  }
}

export type RepositoryCommitIdentity = {
  policy: "repository" | "machine";
  env: Partial<NodeJS.ProcessEnv>;
  coauthor?: string;
  refusal?: typeof COMMIT_ACCOUNT_REFUSAL;
};

const machineIdentity = (): RepositoryCommitIdentity => ({ policy: "machine", env: controllerCommitIdentityEnv() });

export function validRepositoryAuthorName(name: string): boolean {
  if (!name.trim() || name.length > 1024 || /[\x00-\x1f\x7f<>]/.test(name)) return false;
  const decoded = canonicalSensitiveText(name, true);
  return !decoded.error && !mailboxPattern(true).test(decoded.text.normalize("NFKC"));
}

/** Verify the literal author and committer mailboxes of every commit a direct
 * workflow push would introduce. Git's mailmap and display names are ignored. */
export async function verifyRepositoryCommitRange(cwd: string, range: string, email: string, exec: ExecPort = realExec): Promise<string | null> {
  // A stale local base can leave already-published main commits in this range.
  // Filter those commits by reachability from the delivery remote's tracking refs.
  const list = await exec("git", ["rev-list", range], cwd, { GIT_NO_REPLACE_OBJECTS: "1" }, { timeoutMs: 10_000 });
  if (list.code !== 0 || list.stdout && !list.stdout.trim().split(/\r?\n/).every(sha => /^[0-9a-f]{40}$/i.test(sha))) {
    return "publication refused because new commit identities could not be verified (values withheld)";
  }
  for (const sha of list.stdout.trim().split(/\r?\n/).filter(Boolean)) {
    const published = await exec("git", ["for-each-ref", `--contains=${sha}`, "--count=1", "--format=%(refname)", "refs/remotes/origin/"], cwd,
      { GIT_NO_REPLACE_OBJECTS: "1" }, { timeoutMs: 5_000 });
    if (published.code !== 0) return "publication refused because new commit identities could not be verified (values withheld)";
    if (published.stdout.trim()) continue;
    const identity = await exec("git", ["show", "-s", "--no-use-mailmap", "--format=%ae%n%ce", sha], cwd,
      { GIT_NO_REPLACE_OBJECTS: "1" }, { timeoutMs: 5_000 });
    if (identity.code !== 0 || identity.stdout.replace(/\r?\n$/, "") !== `${email}\n${email}`) {
      return `publication refused for ${sha.slice(0, 12)} identity; new commits require the installation owner's noreply mailbox (values withheld)`;
    }
  }
  return null;
}

/** Git supplies the display name, including worktree and global config.
 * The email comes exclusively from the installation's GitHub account. */
export async function repositoryCommitIdentity(cwd: string, exec: ExecPort = realExec,
  source?: NodeJS.ProcessEnv, purpose: "launch" | "lane" = "launch"): Promise<RepositoryCommitIdentity> {
  try { await fs.stat(cwd); }
  catch (error) {
    // A synthetic/nonexistent launch directory has no repository identity.
    // The launcher still owns its normal directory/start error.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return machineIdentity();
    throw new Error("Repository directory could not be read (values withheld)");
  }
  const readEnv: Partial<NodeJS.ProcessEnv> = { ...source, LC_ALL: "C", GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CONFIG"]) readEnv[key] = undefined;
  const root = await exec("git", ["rev-parse", "--show-toplevel"], cwd, readEnv, { timeoutMs: 5_000 });
  if (root.code === 128 && /^fatal: not a git repository(?:[ (]|$)/.test(root.stderr)) return machineIdentity();
  if (root.code !== 0) throw new Error("Repository Git identity could not be read (values withheld)");
  const reportedRoot = root.stdout.replace(/\r?\n$/, "");
  const directory = path.isAbsolute(reportedRoot) ? reportedRoot : cwd;
  // Standalone tools such as the batch merger can retain the repository's
  // machine policy. A pipeline stage always binds the installation's owner.
  if (purpose === "launch" && !source?.LLV_STAGE_GIT_RECEIPT && await repositoryHasPrivacyPolicy(directory)) return machineIdentity();
  const account = await resolveForgeCommitAccount({ forceRefresh: purpose === "lane" });
  if (!account) return { policy: "repository", env: controllerCommitIdentityEnv(), refusal: COMMIT_ACCOUNT_REFUSAL };
  const configured = await exec("git", ["config", "--null", "--get", "user.name"], cwd, readEnv,
    { timeoutMs: 5_000, maxOutputBytes: 16_384 });
  if (configured.code !== 0 && configured.code !== 1) throw new Error("Repository Git identity could not be read (values withheld)");
  const candidate = configured.stdout.replace(/\0$/, "").trim();
  const name = configured.code === 0 && validRepositoryAuthorName(candidate) ? candidate : account.login;
  const email = ownerNoreplyAddress(account);
  const { commitAttribution } = readOperatorSettings();
  return {
    policy: "repository",
    env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
    ...(commitAttribution?.value !== false ? { coauthor: DELEGATUS_COAUTHOR } : {}),
  };
}

/** Bind once before child filtering; both engine settings and the shell's
 * history guard consume the same selection. Rebind at each launch/resume. */
export async function repositoryPublicationSource(cwd: string, source: NodeJS.ProcessEnv,
  exec: ExecPort = realExec, purpose: "launch" | "lane" = "launch"): Promise<NodeJS.ProcessEnv> {
  const identity = await repositoryCommitIdentity(cwd, exec, source, purpose);
  const bound = { ...source };
  if (identity.policy === "repository") bound[REPOSITORY_IDENTITY] = JSON.stringify(identity);
  else delete bound[REPOSITORY_IDENTITY];
  return bound;
}
