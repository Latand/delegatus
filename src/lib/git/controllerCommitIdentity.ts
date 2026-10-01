/** Apply only to controller-authored commits. Git's identity environment
    overrides user.*, author.* and committer.* config without changing the
    repository or the environment inherited by subsequent agent commands. */
export function controllerCommitIdentityEnv(): Partial<NodeJS.ProcessEnv> {
  const email = ["noreply", "delegatus.invalid"].join("@");
  return {
    GIT_AUTHOR_NAME: "Delegatus",
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: "Delegatus",
    GIT_COMMITTER_EMAIL: email,
  };
}
