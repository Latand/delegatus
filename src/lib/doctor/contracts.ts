export const CAPABILITY_IDS = [
  "engine.claude", "engine.codex", "auth.codex", "transcripts.claude",
  "transcripts.codex", "transcription.local", "viewer.server",
] as const;
export type CapabilityId = typeof CAPABILITY_IDS[number];
export type CapabilityState = "available" | "degraded" | "blocked" | "unknown";
export type ReasonCode = "CLI_MISSING" | "AUTH_ABSENT" | "TRANSCRIPT_ROOT_MISSING"
  | "WHISPER_VENV_MISSING" | "WHISPER_RUNTIME_UNCHECKED" | "VIEWER_UNREACHABLE"
  | "VIEWER_AUTH_REQUIRED" | "VIEWER_UNRECOGNIZED" | "PROBE_TIMEOUT" | "PROBE_ERROR";

export interface CapabilityStatus {
  id: CapabilityId;
  state: CapabilityState;
  reason: ReasonCode | null;
  probedAt: string;
  durationMs: number;
  timedOut: boolean;
}

/** Presence checks describe prerequisites; they never prove login validity or a launch. */
export interface CapabilityReport {
  schemaVersion: 1;
  generatedAt: string;
  platform: { os: string; arch: string };
  capabilities: CapabilityStatus[];
}

export type Inspection = "present" | "absent" | "unreadable";
export type ViewerInspection = "reachable" | "auth-required" | "unreachable" | "unrecognized";
export interface DoctorHost {
  home: string;
  platform: NodeJS.Platform;
  arch: string;
  env: Record<string, string | undefined>;
  now(): number;
  inspect(file: string, kind: "directory" | "real-directory" | "credential" | "executable", signal?: AbortSignal): Promise<Inspection>;
  viewer(port: number, signal: AbortSignal): Promise<ViewerInspection>;
}
export interface DoctorOptions { host?: DoctorHost; port?: number }
