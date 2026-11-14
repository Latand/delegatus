import type { LaunchProfile } from "@/lib/accounts/migration/contracts";

export type CleanerSandboxObservation = { mode: "restricted"; reason: null } | { mode: "unsandboxed"; reason: string };

export function normalizeCleanerSandboxObservation(value: unknown): CleanerSandboxObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { mode?: unknown; reason?: unknown };
  if (candidate.mode === "restricted" && candidate.reason === null) return { mode: "restricted", reason: null };
  if (candidate.mode === "unsandboxed" && typeof candidate.reason === "string" && candidate.reason.trim()) {
    return { mode: "unsandboxed", reason: candidate.reason.slice(0, 4096) };
  }
  return undefined;
}

/** Disk inventory runs in an empty workspace, with no approval escape. */
export function guardedDiskCleanerProfile(profile: LaunchProfile): boolean {
  return profile.agentMemoryRoleParams?.mode === "disk"
    && profile.readOnly === true
    && profile.sandbox === "restricted"
    && profile.allowSubagents === false
    && profile.permissionMode === "never";
}
