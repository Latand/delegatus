import { controllerCommitIdentityEnv } from "./controllerCommitIdentity";
import { agentHistoryGuardEnv, type AgentEnvironment } from "./agentHistoryGuard";
import { agentForgeWriteEnv } from "./agentForgeCredentials";
import { agentLessonPublicationEnv } from "@/lib/memory/roleStore";

/** Publication settings belong to the launching process, before child-env
    filtering. Git identity variables from that process never choose an agent's
    identity. Invalid settings refuse the launch without logging their values. */
export function agentPublicationIdentityEnv(source: AgentEnvironment): Record<string, string | undefined> {
  const defaults = controllerCommitIdentityEnv();
  const configuredName = source.DELEGATUS_PUBLICATION_NAME ?? source.LLV_PUBLICATION_NAME ?? defaults.GIT_AUTHOR_NAME!;
  const name = configuredName.trim();
  const email = source.DELEGATUS_PUBLICATION_EMAIL ?? source.LLV_PUBLICATION_EMAIL ?? defaults.GIT_AUTHOR_EMAIL!;
  if (!name || configuredName.length > 80 || /[\x00-\x1f\x7f<>@/\\]/.test(configuredName)
    || !/^(?:noreply|no-reply)@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(email)
    // The publication gate requires graph proof for the forge merge composer.
    || email.toLowerCase() === ["noreply", "github.com"].join("@")) {
    throw new Error("Invalid agent publication identity: use a machine name and a no-reply role mailbox");
  }
  /* Writes to a declared App repository go out as the App. Its Git entries
     come first: the history guard appends its own after them and has to stay
     the last one. */
  const forge = agentForgeWriteEnv(source);
  return {
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
    /* The pre-push privacy gate refuses a push that carries a stored
       role-memory lesson (src/lib/memory/roleStore.ts). */
    ...agentLessonPublicationEnv(),
    ...forge,
    ...agentHistoryGuardEnv({ ...source, ...forge }, name, email),
  };
}

export function agentCodexPublicationPolicy(policy: unknown, source: AgentEnvironment): Record<string, unknown> {
  const identity = agentPublicationIdentityEnv(source);
  const configured = policy && typeof policy === "object" && !Array.isArray(policy)
    ? policy as Record<string, unknown> : {};
  const override: Record<string, unknown> = { set: identity };
  const included = configured.include_only;
  const filters = configured.filters;
  if (included != null && (!Array.isArray(included) || included.some((name) => typeof name !== "string"))) {
    throw new Error("Codex shell policy could not be read safely");
  }
  if (filters != null) {
    if (typeof filters !== "object" || Array.isArray(filters)
      || Object.values(filters).some((value) => value !== "include" && value !== "exclude")
      || included != null || configured.exclude != null) throw new Error("Codex shell policy could not be read safely");
    // Includes filter after `set`; add only the Git fields to an existing
    // inclusion bound. Exclusions run before `set` and remain untouched.
    if (Object.values(filters).includes("include")) {
      override.filters = Object.fromEntries(Object.keys(identity).map((key) => [key, "include"]));
    }
  } else if (Array.isArray(included) && included.length) {
    override.include_only = [...new Set([...included, ...Object.keys(identity)])];
  }
  return override;
}

export function agentCodexPublicationArgs(policy: unknown, source: AgentEnvironment): string[] {
  return Object.entries(agentCodexPublicationPolicy(policy, source)).flatMap(([field, value]) =>
    Array.isArray(value) ? ["-c", `shell_environment_policy.${field}=${JSON.stringify(value)}`]
      : Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
        ["-c", `shell_environment_policy.${field}.${key}=${JSON.stringify(item)}`]));
}
