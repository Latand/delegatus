import type { RegistryFile } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import { isOpaqueProjectKey, projectDisplayName } from "@/lib/displayNames";
import { projectAliasSnapshot, recordedProjectRemote } from "@/lib/projects/aliases";
import { projectInfoFromCwd } from "@/lib/scanner/describe";

import { messageOriginConversationId, messageOriginRole, type MessageOrigin } from "./messageOrigin";

function senderProjectName(project: string | null, cwd?: string | null): string | null {
  const info = cwd ? projectInfoFromCwd(cwd) : null;
  if (!project) return info?.displayName ?? null;
  try {
    const named = projectAliasSnapshot().displayNames[project];
    if (named) return named;
  } catch { /* use the source cwd or recorded remote */ }
  if (info?.project === project) return info.displayName;
  try {
    const remote = recordedProjectRemote(project);
    const name = remote?.replace(/\.git$/, "").split(/[/:]/).at(-1);
    if (name && name.length <= 120) return name;
  } catch { /* the remote is optional presentation evidence */ }
  return isOpaqueProjectKey(project) ? null : projectDisplayName(project);
}

/** Capture the sender while the server still knows its registry identity.
 * The resulting origin is persisted with the delivery and survives retries,
 * seat rotation and a later change to the project's display name. */
export function agentMessageOrigin(
  snapshot: RegistryFile,
  conversationId: string | null,
  role?: string | null,
): MessageOrigin {
  const conversation = conversationId?.startsWith("conversation_")
    ? snapshot.conversations[conversationId as ViewerConversationId] : undefined;
  const receipt = !conversation && conversationId
    ? Object.values(snapshot.receipts).find((row) => row.conversationId === conversationId)
    : undefined;
  const profile = conversation?.generations.at(-1)?.launchProfile ?? receipt?.launchProfile;
  const cwd = profile?.cwd ?? receipt?.cwd;
  const project = conversationProjectKey(conversation?.projectOwnership, profile, { project: receipt?.explicitProject, cwd });
  const projectName = senderProjectName(project, cwd);
  const senderRole = messageOriginRole(role ?? conversation?.agentRole ?? receipt?.agentRole ?? "agent");
  const sourceId = messageOriginConversationId(conversation?.id ?? receipt?.conversationId ?? conversationId);
  return {
    kind: "agent",
    ...(senderRole ? { role: senderRole } : {}),
    ...(projectName ? { project: projectName } : {}),
    ...(sourceId ? { conversationId: sourceId } : {}),
  };
}

/** First-party controller messages have a role and known project, but no
 * conversation of their own to link. */
export function delegatusMessageOrigin(role: string, project?: string | null, cwd?: string | null): MessageOrigin {
  const senderRole = messageOriginRole(role);
  const projectName = senderProjectName(project ?? null, cwd);
  return { kind: "agent", ...(senderRole ? { role: senderRole } : {}), ...(projectName ? { project: projectName } : {}) };
}

export function delegatusOriginForRecipient(snapshot: RegistryFile, conversationId: string, role: string): MessageOrigin {
  const conversation = snapshot.conversations[conversationId as ViewerConversationId];
  const profile = conversation?.generations.at(-1)?.launchProfile;
  return delegatusMessageOrigin(role, conversationProjectKey(conversation?.projectOwnership, profile), profile?.cwd);
}
