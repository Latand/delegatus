import { AsyncLocalStorage } from "node:async_hooks";
import { statePath } from "@/lib/configDir";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { digest } from "./wire";

type Owner = { pid: number; startIdentity?: string | null; bootEpoch?: string | null };
type Admission = { file: string; active: boolean };
const shared = process as typeof process & { __delegatusRecordedHostFence?: AsyncLocalStorage<Admission> };
const context = shared.__delegatusRecordedHostFence ??= new AsyncLocalStorage<Admission>();
/** Shared by registration and the complete signal ladder. A nested native
 * release retains the outer reservation until its last possible signal. */
export async function withRecordedHostFence<T>(owner: Owner, operation: () => Promise<T>): Promise<T> {
  // A fixed set bounds lock artifacts after old hosts leave. Collisions only
  // serialize admission; they never substitute one host's identity proof.
  const slot = parseInt(digest([owner.pid, owner.startIdentity, owner.bootEpoch]).slice(0, 8), 16) % 128;
  const file = statePath("recorded-check-host-fences", String(slot));
  const held = context.getStore();
  if (held?.active && held.file === file) return operation();
  return withFileTransactionAsync(file, "recorded check host custody", async () => {
    const admission: Admission = { file, active: true };
    try { return await context.run(admission, operation); }
    finally { admission.active = false; }
  });
}
