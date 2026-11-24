import { startupDiagnostic } from "@/lib/startupDiagnostics";

/**
 * Severity of a diagnostic line that reports a limit of the platform itself.
 * macOS and Windows have no cgroups and no Linux namespaces, so a line saying
 * CPU placement or the signal boundary is off describes the platform and no
 * fault. Linux keeps the warning: there the same state means a missing
 * mechanism or a misconfigured host.
 */
export type PlatformLimitSeverity = "info" | "warn";

export function platformLimitSeverity(platform: NodeJS.Platform = process.platform): PlatformLimitSeverity {
  return platform === "darwin" || platform === "win32" ? "info" : "warn";
}

/** Writes a platform-limit line at its severity: information is quiet in a quiet launch, a warning always prints. */
export function platformLimitDiagnostic(message: string, platform: NodeJS.Platform = process.platform): void {
  if (platformLimitSeverity(platform) === "info") startupDiagnostic("info", message);
  else console.warn(message);
}
