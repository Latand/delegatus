import type { OrchestratorRevocation } from "./seats";
const shared = globalThis as typeof globalThis & { __delegatusSeatChannelListener?: (rows: readonly OrchestratorRevocation[]) => void };
export function onSeatChannelChange(listener: (rows: readonly OrchestratorRevocation[]) => void): void {
  shared.__delegatusSeatChannelListener = listener;
}
export function notifySeatChannel(rows: readonly OrchestratorRevocation[]): void {
  if (!shared.__delegatusSeatChannelListener) return;
  setImmediate(() => shared.__delegatusSeatChannelListener?.(rows));
}
