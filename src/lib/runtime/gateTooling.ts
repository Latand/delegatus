/** Files opened beside a bundled owned runner. Keep build and host cache in sync. */
export const gateToolingFiles = [
  "gate-slot.sh", "owned-runner.ts", "cpu-admission.ts", "test-child-guardian.ts", "gate-wait.ts",
  "check-test-preload.ts", "check-worker-client.mjs", "check-worker-entry.py",
] as const;
