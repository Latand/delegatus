import { agentRegistry, readOnlyConversationLookupFromSnapshot } from "@/lib/agent/registry";
import { UNRESOLVED_PROJECT } from "@/lib/projects/identity";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";

import type { TeamActor, TeamEventAction, TeamEventDetail } from "./contract";
import { recordTeamEvent } from "./events";

/*
 * The conversation an audit row is about, named the way the board names it:
 * its launch title and its project, resolved with the same precedence the
 * activity ledger uses. Read only for a person's action, so an agent's own
 * traffic costs nothing here.
 */

export interface ConversationSubject {
  id: string;
  title: string | null;
  role: string | null;
  project: string | null;
}

export function conversationSubject(reference: { conversationId?: string | null; path?: string | null }): ConversationSubject | null {
  try {
    const lookup = readOnlyConversationLookupFromSnapshot(agentRegistry().readOnlySnapshot());
    const id = reference.conversationId?.trim() ?? "";
    const byId = id.startsWith("conversation_") ? lookup.conversation(id as `conversation_${string}`) : null;
    const conversation = byId ?? (reference.path ? lookup.conversationForPath(reference.path) : null);
    if (!conversation) return null;
    const generation = conversation.generations.at(-1);
    const profile = generation?.launchProfile as { title?: unknown; role?: unknown; cwd?: string; project?: string } | undefined;
    const project = resolveProjectAttribution({
      projectOwnership: conversation.projectOwnership,
      cwd: profile?.cwd || undefined,
      launchProfileProject: profile?.project,
    }).project;
    return {
      id: conversation.id,
      title: typeof profile?.title === "string" && profile.title.trim() ? profile.title.trim() : null,
      role: typeof profile?.role === "string" && profile.role.trim() ? profile.role.trim() : null,
      project: project && project !== UNRESOLVED_PROJECT ? project : null,
    };
  } catch {
    return null;
  }
}

/** Records a person's action on a conversation. Never throws. */
export function recordConversationEvent(input: {
  actor: TeamActor;
  action: TeamEventAction;
  conversationId?: string | null;
  path?: string | null;
  detail?: TeamEventDetail | null;
}): void {
  if (input.actor.kind !== "member") return;
  const subject = conversationSubject(input);
  if (!subject && !input.conversationId) return;
  recordTeamEvent({
    actor: input.actor,
    action: input.action,
    project: subject?.project ?? null,
    subject: { kind: "conversation", id: subject?.id ?? input.conversationId!, title: subject?.title ?? null },
    detail: { ...(subject?.role ? { role: subject.role } : {}), ...(input.detail ?? {}) },
  });
}
