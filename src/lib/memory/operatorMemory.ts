import type { LaunchProfile } from "@/lib/accounts/migration/contracts";
import { engineMemoryOff } from "./source";

/* The operator's own root conversations in Delegatus mode
   (docs/design/memory-source-switch.md §2 item 7, §3.3): with the engines'
   memory off they read the project and machine rules at start and leave
   lessons at those levels. Outside Delegatus mode they keep today's output. */

export interface OperatorRootEvidence {
  /** Admission saw an `operator` origin: the request's own origin for a new
      launch, the conversation's durable birth stamp for everything later. An
      `external` launch has depth zero and no parent too, so shape alone proves
      nothing. */
  operatorOrigin: boolean;
  agentRole: string | null | undefined;
  parentConversationId: string | null | undefined;
  /** Admission stamps 0 on every root; a stored row without it proves nothing. */
  delegationDepth: number | null | undefined;
  /** Any pipeline, flow or seat membership makes it another kind of conversation. */
  memberships: readonly unknown[];
}

/** A root conversation the operator launched: operator origin, no role, no parent, depth zero, no membership. */
export function operatorRootConversation(input: OperatorRootEvidence): boolean {
  return input.operatorOrigin === true && !input.agentRole && !input.parentConversationId && input.delegationDepth === 0 && input.memberships.length === 0;
}

/** The selector is set and re-derived only while the engines' own memory is off. */
export function operatorMemoryEnabled(): boolean {
  return engineMemoryOff();
}

/** Add or retire the operator's text-free selector on a profile, in place.
    Only a selector this function owns (reader "operator") is ever retired. */
export function applyOperatorMemorySelector(profile: Pick<LaunchProfile, "cleanMemory" | "learnedRules">, project: string | null | undefined, operatorRoot: boolean): void {
  const owned = profile.learnedRules?.reader === "operator";
  const wanted = operatorRoot && !profile.cleanMemory && !!project && project !== "*" && operatorMemoryEnabled();
  if (wanted && (!profile.learnedRules || owned)) profile.learnedRules = { project: project!, roleId: null, reader: "operator" };
  else if (!wanted && owned) delete profile.learnedRules;
}

/** The same proof read from a stored conversation, for resume, restart
    adoption, account migration and lesson admission. A conversation born
    before the stamp existed cannot prove it and stays excluded. */
export function storedOperatorRoot(conversation: { operatorOrigin?: true; agentRole: string | null; delegationDepth: number | null; generations: readonly { launchProfile: { parentConversationId: string | null } }[] } | null | undefined, memberships: readonly unknown[] | undefined): boolean {
  if (!conversation) return false;
  return operatorRootConversation({ operatorOrigin: conversation.operatorOrigin === true, agentRole: conversation.agentRole, delegationDepth: conversation.delegationDepth,
    parentConversationId: conversation.generations.at(-1)?.launchProfile.parentConversationId ?? null, memberships: memberships ?? [] });
}
