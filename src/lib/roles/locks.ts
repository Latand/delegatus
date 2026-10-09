/**
 * Role contracts no stored mapping row or launch override can widen. Like
 * SPAWN_DENIED_ROLE_IDS these are hardcoded: role overrides carry config and
 * promptScaffold only, so a persisted preset cannot move a locked role off its
 * engine or make a read-only-locked role writable. Client-safe.
 */

import type { RoleEngine, RoleId } from "./types";

/** The one engine a role runs on. Visual judgement runs on Claude, never Codex
    (the operator, 2026-10-06). */
export const ROLE_ENGINE_LOCKS: Readonly<Partial<Record<RoleId, RoleEngine>>> = Object.freeze({ "visual-critic": "claude" });

/** Roles whose read-only capability is the contract itself: a stage may not
    ask for read-write access, where other read-only roles take it as a default. */
export const READ_ONLY_LOCKED_ROLE_IDS: readonly RoleId[] = Object.freeze(["visual-critic"]);

/** The engine `roleId` is locked to, or null when it may run on either. */
export function lockedEngine(roleId: string | null | undefined): RoleEngine | null {
  return roleId ? ROLE_ENGINE_LOCKS[roleId as RoleId] ?? null : null;
}

/** The refusal for running `roleId` on `engine`, or null when it may. */
export function roleEngineRefusal(roleId: string | null | undefined, engine: string): string | null {
  const locked = lockedEngine(roleId);
  return locked && engine !== locked ? `${roleId} runs on ${locked} only` : null;
}

export function isReadOnlyLockedRole(roleId: string | null | undefined): boolean {
  return typeof roleId === "string" && (READ_ONLY_LOCKED_ROLE_IDS as readonly string[]).includes(roleId);
}
