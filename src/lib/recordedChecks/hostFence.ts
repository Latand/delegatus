import { AsyncLocalStorage } from "node:async_hooks";
import { statePath } from "@/lib/configDir";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { digest } from "./wire";

type Owner = { pid: number; startIdentity?: string | null; bootEpoch?: string | null };
type Admission = { file: string; active: boolean; exited?: boolean; observers?: PromiseWithResolvers<void> };
const shared = process as typeof process & { __delegatusRecordedHostFence?: AsyncLocalStorage<Admission> };
const context = shared.__delegatusRecordedHostFence ??= new AsyncLocalStorage<Admission>();

/** A background release outlives its caller. Make it acquire its own ticket
 * even when its callback was registered inside another reservation. */
export function outsideRecordedHostFence<T>(operation: () => T): T {
  return context.exit(operation);
}

/** Capture the outer reservation while an effect is admitted. A detached
 * observer can await its exit without requesting permission for another
 * effect. A caller already inside that reservation remains reentrant. */
export function currentRecordedHostFenceExit(): (() => Promise<void> | undefined) | undefined {
  const held = context.getStore();
  if (!held?.active || held.exited === undefined) return undefined;
  return () => {
    if (held.exited || (held.active && context.getStore() === held)) return undefined;
    return (held.observers ??= Promise.withResolvers<void>()).promise;
  };
}
/** Shared by registration and the complete signal ladder. A nested native
 * release retains the outer reservation until its last possible signal. */
export async function withRecordedHostFence<T>(owner: Owner, operation: () => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
  // A fixed set bounds lock artifacts after old hosts leave. Collisions only
  // serialize admission; they never substitute one host's identity proof.
  const slot = parseInt(digest([owner.pid, owner.startIdentity, owner.bootEpoch]).slice(0, 8), 16) % 128;
  const file = statePath("recorded-check-host-fences", String(slot));
  const held = context.getStore();
  if (held?.active && held.file === file) return operation();
  const admission: Admission = { file, active: false, exited: false };
  try {
    return await withFileTransactionAsync(file, "recorded check host custody", async () => {
      admission.active = true;
      try { return await context.run(admission, operation); }
      finally { admission.active = false; }
    }, options);
  } finally {
    admission.exited = true;
    admission.observers?.resolve();
  }
}
