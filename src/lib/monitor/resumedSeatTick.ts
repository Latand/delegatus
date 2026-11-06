type ResumeCheck = (conversationId: string) => Promise<void>;
type ResumeSignal = { check?: ResumeCheck; pending: Map<string, Promise<void>> };
const globals = globalThis as typeof globalThis & { __llvResumedSeatSignal?: ResumeSignal };
const signal = globals.__llvResumedSeatSignal ??= { pending: new Map() };

/** The running controller owns this port; engine routes import no controller graph. */
export function bindResumedSeatTick(check: ResumeCheck | null): void {
  signal.check = check ?? undefined;
  signal.pending.clear();
}

/** Without a running clock, startup's immediate sweep will read any owed work. */
export function requestResumedSeatTick(conversationId: string): Promise<void> {
  const check = signal.check;
  if (!check) return Promise.resolve();
  const existing = signal.pending.get(conversationId);
  if (existing) return existing;
  const work = Promise.resolve().then(() => signal.check === check ? check(conversationId) : undefined);
  signal.pending.set(conversationId, work);
  void work.finally(() => { if (signal.pending.get(conversationId) === work) signal.pending.delete(conversationId); }).catch(() => {});
  return work;
}
