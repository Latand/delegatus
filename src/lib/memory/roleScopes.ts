import type { ScopeKind } from "./roleTypes";

/* Scope keys as text, with nothing that touches the disk, so the renderer and
   a browser fixture can read them: `role:<project>:<roleId>`, `role:*:<roleId>`, `project:<project>`
   `swarm:<roleId>` and `machine`. Swarm is public release text and has no
   project identity or writable local scope. */

export const MACHINE_SCOPE = "machine";

export const crossProjectRoleScope = (roleId: string) => `role:*:${roleId}`;
export const isCrossProjectRoleScope = (scope: string) => scope.startsWith("role:*:");

export function scopeKind(scope: string): ScopeKind {
  return scope === MACHINE_SCOPE ? "machine" : scope.startsWith("swarm:") ? "swarm" : scope.startsWith("role:") ? "role" : "project";
}

export function scopeRole(scope: string): string | null {
  return scope.startsWith("role:") || scope.startsWith("swarm:") ? scope.slice(scope.lastIndexOf(":") + 1) : null;
}

/** The project part; null for machine, swarm and a role on every project. */
export function scopeProject(scope: string): string | null {
  if (isCrossProjectRoleScope(scope)) return null;
  if (scope.startsWith("project:")) return scope.slice("project:".length);
  if (scope.startsWith("role:")) return scope.slice("role:".length, scope.lastIndexOf(":"));
  return null;
}
