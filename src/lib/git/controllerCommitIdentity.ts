import type { ExecPort } from "@/lib/workflows/provision";

/** Keep Git's resolved identity; supply the controller's identity for this command only when needed. */
export function controllerCommitIdentityArgs(exec: ExecPort, cwd: string): string[] {
  const author = exec("git", ["var", "GIT_AUTHOR_IDENT"], cwd);
  const committer = exec("git", ["var", "GIT_COMMITTER_IDENT"], cwd);
  return author.code === 0 && committer.code === 0
    ? []
    : ["-c", "user.name=Delegatus", "-c", `user.email=${["noreply", "delegatus.invalid"].join("@")}`];
}
