import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { explicitLaunchProfileSandbox, type LaunchProfile } from "@/lib/accounts/migration/contracts";
import { guardedDiskCleanerProfile } from "@/lib/agent/cleanerLaunchPolicy";
import type { AgentRegistry, AgentRegistryEntry } from "@/lib/agent/registry";

export type StructuredHostAccessPolicy = boolean | { readOnly: boolean; sandbox: "full" | "restricted" };

/** Explicit pipeline sandboxes are independent of repository write policy.
    Older profiles express the sandbox through readOnly alone. */
export function structuredHostAccessPolicy(profile: Pick<LaunchProfile, "readOnly" | "sandbox"> | null | undefined): StructuredHostAccessPolicy {
  const sandbox = explicitLaunchProfileSandbox(profile);
  return sandbox ? { readOnly: profile?.readOnly === true, sandbox } : profile?.readOnly === true;
}

export const READ_ONLY_STAGE_PERMISSION_PROFILE = "llv-read-only-stage";

export function codexSandboxSelection(policy: StructuredHostAccessPolicy) {
  if (policy === true) return { permissionProfile: READ_ONLY_STAGE_PERMISSION_PROFILE, parent: ":read-only" } as const;
  if (policy !== false && policy.sandbox === "restricted") {
    return { sandbox: "workspace-write", permissionProfile: "llv-stage", parent: ":workspace" } as const;
  }
  return { sandbox: "danger-full-access", parent: null } as const;
}

export type CodexReconnectAccess = {
  cwd: string;
  approvalPolicy: string;
  approvalsReviewer?: "user";
} & (
  | { sandbox: "danger-full-access" | "workspace-write" | "read-only"; cleaner?: true }
  | { permissionProfile: string; parent: ":workspace" | ":read-only"; cleaner?: true }
);

export function codexReconnectAccess(registry: AgentRegistry, entry: AgentRegistryEntry): CodexReconnectAccess {
  // The transcript inventory can materialize a generation profile from its
  // observed cwd while leaving every access field empty. Only the retained
  // launch receipt records policy that was actually authorized at launch.
  const receipt = registry.spawnReceiptForHost(entry.key);
  const profile = receipt?.launchProfile;
  if (!receipt || !profile || !path.isAbsolute(profile.cwd) || profile.cwd !== entry.cwd
    || (profile.sandbox != null && explicitLaunchProfileSandbox(profile) === null)
    || (profile.readOnly != null && typeof profile.readOnly !== "boolean")
    || (profile.permissionMode != null && !["never", "on-request", "untrusted"].includes(profile.permissionMode))) {
    throw new CodexReconnectPolicyError("Codex reconnect launch access authorization is unavailable");
  }
  const access = {
    cwd: profile.cwd,
    approvalPolicy: profile.permissionMode ?? "never",
    ...(profile.allowSubagents === true ? {} : { approvalsReviewer: "user" as const }),
  };
  if (profile.agentMemoryRoleParams?.mode === "disk") {
    const conversation = registry.conversationForPath(entry.artifactPath);
    const receipt = (conversation && registry.diskCleanerReceiptForConversation(conversation.id))
      ?? registry.spawnReceiptForHost(entry.key);
    if (!guardedDiskCleanerProfile(profile) || receipt?.agentRole !== "cleaner" || !receipt.cleanerSandbox) {
      throw new CodexReconnectPolicyError("Codex reconnect cleaner launch access authorization is unavailable");
    }
    return receipt.cleanerSandbox.mode === "unsandboxed"
      ? { ...access, sandbox: "danger-full-access", cleaner: true }
      : { ...access, permissionProfile: "llv-cleaner-", parent: ":read-only", cleaner: true };
  }
  const selection = codexSandboxSelection(structuredHostAccessPolicy(profile));
  return selection.parent === null
    ? { ...access, sandbox: selection.sandbox }
    : { ...access, permissionProfile: selection.permissionProfile, parent: selection.parent };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class CodexReconnectPolicyError extends Error {
  constructor(message = "Codex reconnect effective launch policy could not be verified") {
    super(message);
    this.name = "CodexReconnectPolicyError";
  }
}

/** The surviving app-server still holds the CLI flags produced by launch
    materialization, including the original scratch and evidence paths.
    A verified flags layer without a named profile preserves legacy sandboxes. */
export function retainedCodexLaunchAccess(access: CodexReconnectAccess, configRead: unknown, launchTempRoot?: string) {
  if (access.cleaner && !launchTempRoot) throw new CodexReconnectPolicyError();
  const cwd = access.cleaner ? path.join(path.dirname(launchTempRoot!), "cwd") : path.resolve(access.cwd);
  const base = { cwd, approvalPolicy: access.approvalPolicy, approvalsReviewer: access.approvalsReviewer, cleaner: access.cleaner };
  if ("sandbox" in access) return { ...base, sandbox: access.sandbox };

  const reply = object(configRead);
  const layers = reply?.layers;
  if (!reply || !Array.isArray(layers) || layers.length === 0) throw new CodexReconnectPolicyError();
  const flags = layers.filter(layer => object(object(layer)?.name)?.type === "sessionFlags");
  if (flags.length !== 1) throw new CodexReconnectPolicyError();
  const cli = object(object(flags[0])?.config);
  if (!cli) throw new CodexReconnectPolicyError();
  const id = cli.default_permissions;
  if (id === undefined && cli.permissions === undefined && !access.cleaner) {
    const config = object(reply.config);
    const workspace = object(config?.sandbox_workspace_write);
    if (!config || (access.parent === ":workspace" && workspace && (workspace.network_access === true
      || (Array.isArray(workspace.writable_roots) && workspace.writable_roots.length > 0)))) {
      throw new CodexReconnectPolicyError();
    }
    return { ...base, sandbox: access.parent === ":workspace" ? "workspace-write" as const : "read-only" as const };
  }
  if (typeof id !== "string" || (access.cleaner
    ? !/^llv-cleaner-[0-9a-f-]{36}$/.test(id)
    : id !== access.permissionProfile)) throw new CodexReconnectPolicyError();

  const launchProfile = object(object(cli.permissions)?.[id]);
  const effectiveProfile = object(object(object(reply.config)?.permissions)?.[id]);
  const filesystem = object(launchProfile?.filesystem);
  // A profile with the expected name can still receive extra filesystem or
  // network rules through Codex's recursive config merge. Codex also adds
  // nullable filesystem metadata such as glob_scan_max_depth; null means the
  // setting is absent and must not be interpreted as a writable root.
  const withoutNullFilesystemMetadata = (value: unknown) => Object.fromEntries(
    Object.entries(object(value) ?? {}).filter(([, item]) => item != null),
  );
  const launchFilesystem = withoutNullFilesystemMetadata(filesystem);
  const effectiveFilesystem = object(effectiveProfile?.filesystem);
  const effectiveFilesystemWithoutNulls = withoutNullFilesystemMetadata(effectiveFilesystem);
  const roots = Object.keys(launchFilesystem).sort();
  if (!launchProfile || !effectiveProfile || !filesystem || !effectiveFilesystem
    || !roots.length || roots.length > 2
    || roots.some(root => !path.isAbsolute(root) || launchFilesystem[root] !== "write")
    || !isDeepStrictEqual({ ...launchProfile, filesystem: launchFilesystem }, { extends: access.parent, filesystem: launchFilesystem })
    || !isDeepStrictEqual({ ...effectiveProfile, filesystem: effectiveFilesystemWithoutNulls }, { extends: access.parent, filesystem: effectiveFilesystemWithoutNulls })
    || !isDeepStrictEqual(effectiveFilesystemWithoutNulls, launchFilesystem)) throw new CodexReconnectPolicyError();
  return { ...base, permissions: id, parent: access.parent, roots };
}

type RetainedAccess = ReturnType<typeof retainedCodexLaunchAccess>;

export function assertResumedCodexAccess(access: RetainedAccess, result: unknown): void {
  const response = object(result);
  const sandbox = object(response?.sandbox);
  const profile = object(response?.activePermissionProfile);
  const named = "permissions" in access;
  const workspace = named || access.sandbox === "workspace-write";
  const unrestricted = !named && access.sandbox === "danger-full-access";
  const excludeSlashTmp = named && access.parent === ":read-only";
  if (!response || !sandbox || response.approvalPolicy !== access.approvalPolicy
    || (access.approvalsReviewer && response.approvalsReviewer !== access.approvalsReviewer)
    || (named ? !profile || profile.id !== access.permissions || profile.extends !== access.parent : response.activePermissionProfile != null)
    || sandbox.type !== (unrestricted ? "dangerFullAccess" : workspace ? "workspaceWrite" : "readOnly")
    || (!unrestricted && sandbox.networkAccess !== false)
    || (workspace && (sandbox.excludeTmpdirEnvVar !== false || sandbox.excludeSlashTmp !== excludeSlashTmp
      || !Array.isArray(sandbox.writableRoots) || sandbox.writableRoots.some(root => typeof root !== "string")
      || !isDeepStrictEqual([...sandbox.writableRoots].sort(), named ? access.roots : [])))
    || ((!unrestricted || access.cleaner) && (response.cwd !== access.cwd || !isDeepStrictEqual(response.runtimeWorkspaceRoots, [access.cwd])))) {
    throw new CodexReconnectPolicyError();
  }
}
