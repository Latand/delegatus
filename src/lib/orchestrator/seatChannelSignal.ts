import type { OrchestratorRevocation } from "./seats";
import { wakeRecordedChecks } from "@/lib/recordedChecks/signal";
const shared = globalThis as typeof globalThis & { __delegatusSeatChannelListener?: (rows: readonly OrchestratorRevocation[]) => void };
export function onSeatChannelChange(listener: (rows: readonly OrchestratorRevocation[]) => void): void {
  shared.__delegatusSeatChannelListener = listener;
}
export function notifySeatChannel(rows: readonly OrchestratorRevocation[]): void {
  wakeRecordedChecks();
  if (!shared.__delegatusSeatChannelListener) return;
  setImmediate(() => shared.__delegatusSeatChannelListener?.(rows));
}
