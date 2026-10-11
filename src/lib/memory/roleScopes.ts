import type { ScopeKind } from "./roleTypes";

/* Scope keys as text, with nothing that touches the disk, so the renderer and
   a browser fixture can read them: `role:<project>:<roleId>`, `role:*:<roleId>`, `project:<project>`
   and `machine`. */

export const MACHINE_SCOPE = "machine";

export const crossProjectRoleScope = (roleId: string) => `role:*:${roleId}`;
export const isCrossProjectRoleScope = (scope: string) => scope.startsWith("role:*:");

export function scopeKind(scope: string): ScopeKind {
  return scope === MACHINE_SCOPE ? "machine" : scope.startsWith("role:") ? "role" : "project";
}

export function scopeRole(scope: string): string | null {
  return scope.startsWith("role:") ? scope.slice(scope.lastIndexOf(":") + 1) : null;
}

/** The project part; null for machine and a role on every project. */
export function scopeProject(scope: string): string | null {
  if (isCrossProjectRoleScope(scope)) return null;
  if (scope.startsWith("project:")) return scope.slice("project:".length);
  if (scope.startsWith("role:")) return scope.slice("role:".length, scope.lastIndexOf(":"));
  return null;
}
