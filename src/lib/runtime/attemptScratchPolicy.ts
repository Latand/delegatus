/** Scratch only. Evidence and other retained classes keep their own clocks.
 * Millisecond event clocks admit a root strictly after the 24-hour boundary. */
export const ATTEMPT_SCRATCH_RETENTION_MS = 24 * 60 * 60_000;
export const ATTEMPT_SCRATCH_EXPIRY_OFFSET_MS = ATTEMPT_SCRATCH_RETENTION_MS + 1;
