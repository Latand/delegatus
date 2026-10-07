import { canonicalProject } from "@/lib/projects/aliases";
import { isReviewGate } from "@/lib/roles/sizing";

import { MACHINE_SCOPE } from "./scopes";
import { CLEAN_ROLE_IDS } from "./types";

const CLEAN: ReadonlySet<string> = new Set(CLEAN_ROLE_IDS);

/** «ревьюер всегда чистый»: a reviewer, a verifier, the issue reporter, and any
    stage the engine classifies as a review gate whatever role it names, read
    no learned rules and leave none. */
export function learnedMemoryExcluded(input: { roleId: string | null | undefined; stage: { kind: string; onFail?: unknown } | null }): boolean {
  if (input.roleId && CLEAN.has(input.roleId)) return true;
  return input.stage ? isReviewGate(input.stage) : false;
}

export function roleIsClean(roleId: string): boolean {
  return CLEAN.has(roleId);
}

export function roleScope(project: string, roleId: string): string {
  return `role:${canonicalProject(project)}:${roleId}`;
}

export function projectScope(project: string): string {
  return `project:${canonicalProject(project)}`;
}

/** The scopes a stage reads, in the order they are injected: its role, its project, the machine. */
export function readableScopes(project: string, roleId: string | null): string[] {
  return [...(roleId ? [roleScope(project, roleId)] : []), projectScope(project), MACHINE_SCOPE];
}
