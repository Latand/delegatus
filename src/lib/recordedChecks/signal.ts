const shared = globalThis as typeof globalThis & { __delegatusRecordedWake?: () => void };
export function setRecordedCheckWake(wake: (() => void) | undefined) { shared.__delegatusRecordedWake = wake; }
export function wakeRecordedChecks() { if (shared.__delegatusRecordedWake) setImmediate(() => shared.__delegatusRecordedWake?.()); }
