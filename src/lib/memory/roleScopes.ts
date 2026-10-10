import type { ScopeKind } from "./roleTypes";

/* Scope keys as text, with nothing that touches the disk, so the renderer and
   a browser fixture can read them: `role:<project>:<roleId>`, `project:<project>`
   and `machine`. */

export const MACHINE_SCOPE = "machine";

export function scopeKind(scope: string): ScopeKind {
  return scope === MACHINE_SCOPE ? "machine" : scope.startsWith("role:") ? "role" : "project";
}

export function scopeRole(scope: string): string | null {
  return scope.startsWith("role:") ? scope.slice(scope.lastIndexOf(":") + 1) : null;
}

/** The project a role or project scope belongs to; null for the machine. */
export function scopeProject(scope: string): string | null {
  if (scope.startsWith("project:")) return scope.slice("project:".length);
  if (scope.startsWith("role:")) return scope.slice("role:".length, scope.lastIndexOf(":"));
  return null;
}
