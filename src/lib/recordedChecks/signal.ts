type Wake = (id?: string) => void;
// The process owner spans the Viewer's separately compiled route realms.
const shared = process as typeof process & { __delegatusRecordedWake?: Wake };
export function setRecordedCheckWake(wake: Wake | undefined) {
  const previous = shared.__delegatusRecordedWake;
  shared.__delegatusRecordedWake = wake;
  return () => { if (shared.__delegatusRecordedWake === wake) shared.__delegatusRecordedWake = previous; };
}
export function wakeRecordedChecks(id?: string) { if (shared.__delegatusRecordedWake) setImmediate(() => shared.__delegatusRecordedWake?.(id)); }
