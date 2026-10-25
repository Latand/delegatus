/** A failed launch may wake its launcher for ten minutes after failure. */
export const LAUNCH_FAILURE_NOTICE_WINDOW_MS = 10 * 60_000;

/** Written at reservation, then advanced independently of retained reports. */
export interface LaunchFailureReporting {
  failedAt: string | null;
  lifecycle: boolean;
  notice: boolean;
  task: boolean;
  /** Admitted targets, including retained proactive authority from related work. */
  taskIds?: string[];
}

export function freshLaunchFailure(at: string | null, now = Date.now()): boolean {
  const failed = at ? Date.parse(at) : NaN;
  return Number.isFinite(failed) && failed <= now && now - failed <= LAUNCH_FAILURE_NOTICE_WINDOW_MS;
}
