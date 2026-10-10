import { isReviewGate } from "@/lib/roles/sizing";

/* Which conversations receive automatic memory: role memory's learned rules
   and the lessons it asks for, the shared-memory hook on operator turns, and
   the engines' own memory (Claude's auto memory, Codex's memories feature).
   One decision serves every path. Explicit evidence searches (search_memory,
   search_transcripts) are tools a stage calls itself and stay available. */

/** Roles that stay clean: they read no memory and leave none (operator,
    2026-10-07: «ревьюер всегда чистый»). */
export const CLEAN_ROLE_IDS = ["reviewer", "verifier", "issue-reporter"] as const;

const CLEAN: ReadonlySet<string> = new Set(CLEAN_ROLE_IDS);

export function roleIsClean(roleId: string | null | undefined): boolean {
  return typeof roleId === "string" && CLEAN.has(roleId);
}

/** A reviewer, a verifier, the issue reporter, and any stage the engine
    classifies as a review gate whatever role it names. */
export function automaticMemoryExcluded(input: { roleId: string | null | undefined; stage: { kind: string; onFail?: unknown } | null }): boolean {
  if (roleIsClean(input.roleId)) return true;
  return input.stage ? isReviewGate(input.stage) : false;
}

/** The same decision for a launched conversation, as its registry records hold
    it: the launch profile's mark, set at spawn and kept on every resume, or a
    clean role on a conversation launched before the mark existed. */
export function conversationMemoryExcluded(input: { agentRole?: string | null; launchProfile?: { cleanMemory?: boolean } | null }): boolean {
  return input.launchProfile?.cleanMemory === true || roleIsClean(input.agentRole);
}
