import type { LaunchProfile } from "@/lib/accounts/migration/contracts";

/** Disk inventory runs in an empty workspace, with no approval escape. */
export function guardedDiskCleanerProfile(profile: LaunchProfile): boolean {
  return profile.agentMemoryRoleParams?.mode === "disk"
    && profile.readOnly === true
    && profile.sandbox === "restricted"
    && profile.allowSubagents === false
    && profile.permissionMode === "never";
}
