import fs from "node:fs/promises";
import path from "node:path";
import { realExec, type ExecPort } from "@/lib/workflows/provision";
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

export type RepositoryCommitIdentity = { env: Partial<NodeJS.ProcessEnv>; coauthor?: string };

/** Read user.* through Git, including includes, worktree and global config.
 * Inherited author variables and role-specific overrides cannot choose it.
 * An absent/incomplete identity retains the existing machine fallback. */
export async function repositoryCommitIdentity(cwd: string, exec: ExecPort = realExec,
  source?: NodeJS.ProcessEnv): Promise<RepositoryCommitIdentity> {
  try { await fs.stat(cwd); }
  catch (error) {
    // A synthetic/nonexistent launch directory has no repository identity.
    // The launcher still owns its normal directory/start error.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { env: controllerCommitIdentityEnv() };
    throw new Error("Repository directory could not be read (values withheld)");
  }
  const readEnv: Partial<NodeJS.ProcessEnv> = { ...source, LC_ALL: "C", GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CONFIG"]) readEnv[key] = undefined;
  const root = await exec("git", ["rev-parse", "--show-toplevel"], cwd, readEnv, { timeoutMs: 5_000 });
  if (root.code === 128 && /^fatal: not a git repository(?:[ (]|$)/.test(root.stderr)) return { env: controllerCommitIdentityEnv() };
  if (root.code !== 0) throw new Error("Repository Git identity could not be read (values withheld)");
  const reportedRoot = root.stdout.replace(/\r?\n$/, "");
  const directory = path.isAbsolute(reportedRoot) ? reportedRoot : cwd;
  if (await repositoryHasPrivacyPolicy(directory)) return { env: controllerCommitIdentityEnv() };
  // One Git process reads both fields, avoiding a mixed identity if config
  // changes between separate name/email probes. Last definition wins, as Git
  // applies local, worktree, global and included configuration.
  const configured = await exec("git", ["config", "--null", "--get-regexp", "^user\\.(name|email)$"], cwd, readEnv,
    { timeoutMs: 5_000, maxOutputBytes: 16_384 });
  if (configured.code === 1) return { env: controllerCommitIdentityEnv(), coauthor: DELEGATUS_COAUTHOR };
  if (configured.code !== 0) throw new Error("Repository Git identity could not be read (values withheld)");
  const values = new Map<string, string>();
  for (const record of configured.stdout.split("\0").filter(Boolean)) {
    const boundary = record.indexOf("\n");
    if (boundary < 0) throw new Error("Repository Git identity could not be read (values withheld)");
    values.set(record.slice(0, boundary), record.slice(boundary + 1).trim());
  }
  const name = values.get("user.name"), email = values.get("user.email");
  if (!name || !email) return { env: controllerCommitIdentityEnv(), coauthor: DELEGATUS_COAUTHOR };
  if ([name, email].some(value => value.length > 1024 || /[\x00-\x1f\x7f<>]/.test(value))) {
    throw new Error("Invalid repository Git identity (values withheld)");
  }
  return { env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email }, coauthor: DELEGATUS_COAUTHOR };
}

/** Bind once before child filtering; both engine settings and the shell's
 * history guard consume the same selection. Rebind at each launch/resume. */
export async function repositoryPublicationSource(cwd: string, source: NodeJS.ProcessEnv,
  exec: ExecPort = realExec): Promise<NodeJS.ProcessEnv> {
  const identity = await repositoryCommitIdentity(cwd, exec, source);
  const bound = { ...source };
  if (identity.coauthor) bound[REPOSITORY_IDENTITY] = JSON.stringify(identity);
  else delete bound[REPOSITORY_IDENTITY];
  return bound;
}
