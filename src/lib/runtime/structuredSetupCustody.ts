import { AsyncLocalStorage } from "node:async_hooks";
import { captureProcessIdentity, type ProcessIdentity } from "@/lib/processIdentity";

/** The launch owner retains native evidence before protocol setup can await.
 * Nested adapters (including socket launches and namespace fallbacks) inherit
 * the same custody; they cannot silently create an unrecorded replacement. */
interface SetupCustody {
  enabled?(): boolean;
  beforeExec(): void;
  /** Asynchronous launch boundaries may wait for a writer. Final exec
   * fences still run synchronously before granting a native permit. */
  beforeExecOffLoop?(): Promise<void>;
  record(process: ProcessIdentity): void;
  /** An adapter that already awaits readiness retains the same process while
   * a writer is busy; synchronous exec fences still use record(). */
  recordOffLoop?(process: ProcessIdentity): Promise<void>;
}
const custody = new AsyncLocalStorage<SetupCustody>();
function activeCustody(): SetupCustody | undefined {
  const current = custody.getStore();
  return current?.enabled?.() === false ? undefined : current;
}

export function withStructuredSetupCustody<T>(ports: SetupCustody | null, work: () => T): T {
  return ports ? custody.run(ports, work) : work();
}

export function beforeStructuredSetupExec(): void { activeCustody()?.beforeExec(); }

export async function beforeStructuredSetupExecOffLoop(): Promise<void> {
  const current = activeCustody();
  if (current?.beforeExecOffLoop) await current.beforeExecOffLoop();
  else current?.beforeExec();
}

export function structuredSetupCustodyActive(): boolean { return activeCustody() !== undefined; }

export function retainStructuredSetupProcess(pid: number | undefined): void {
  if (pid && pid > 1) activeCustody()?.record(captureProcessIdentity(pid));
}

export async function retainStructuredSetupProcessOffLoop(pid: number | undefined): Promise<void> {
  const current = activeCustody();
  if (!current || !pid || pid <= 1) return;
  const identity = captureProcessIdentity(pid);
  if (current.recordOffLoop) await current.recordOffLoop(identity);
  else current.record(identity);
}
