import { AsyncLocalStorage } from "node:async_hooks";

export class OperationLeaseExpiredError extends Error {
  constructor() { super("controller pass deadline exceeded"); this.name = "OperationLeaseExpiredError"; }
}

const host = globalThis as typeof globalThis & { __delegatusOperationLease?: AsyncLocalStorage<OperationLease> };
const context = host.__delegatusOperationLease ??= new AsyncLocalStorage<OperationLease>();

/** Async descendants retain the same revocable authority after abandonment.
 * Only independent executors with durable custody may leave this context. */
export class OperationLease {
  readonly abort = new AbortController();
  private readonly pending = new Map<object, { name: string; start: number }>();
  private omitted = 0;
  run<T>(work: () => T): T { return context.run(this, work); }
  expire() { this.abort.abort(new OperationLeaseExpiredError()); }
  snapshot() {
    const now = performance.now();
    return { operations: [...this.pending.values()].map(op => ({ name: op.name, durationMs: Math.round(now - op.start) })), omitted: this.omitted };
  }
  track<T>(name: string, work: () => T): T {
    this.abort.signal.throwIfAborted();
    const key = {};
    const recorded = this.pending.size < 256;
    if (recorded) this.pending.set(key, { name, start: performance.now() }); else this.omitted++;
    const finish = () => { if (recorded) this.pending.delete(key); else this.omitted--; };
    try {
      const value = work();
      if (value && typeof (value as unknown as Promise<unknown>).then === "function") {
        return Promise.resolve(value).finally(finish) as T;
      }
      finish();
      return value;
    } catch (error) { finish(); throw error; }
  }
}

export const currentOperationLease = () => context.getStore();
export const assertOperationLease = () => context.getStore()?.abort.signal.throwIfAborted();
export const withoutOperationLease = <T>(work: () => T): T => context.exit(work);
export const trackLeasedOperation = <T>(name: string, work: () => T): T => {
  const lease = context.getStore();
  return lease ? lease.track(name, work) : work();
};

/** Release the awaiting frame and its finally blocks even for a lost callback.
 * The original work keeps its revoked context and cannot commit on return. */
export async function awaitLeasedOperation<T>(name: string, work: () => Promise<T> | T): Promise<T> {
  const lease = context.getStore();
  if (!lease) return work();
  lease.abort.signal.throwIfAborted();
  let cancel!: () => void;
  const expired = new Promise<never>((_, reject) => {
    cancel = () => reject(lease.abort.signal.reason);
    lease.abort.signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    const result = await Promise.race([lease.track(name, work), expired]);
    lease.abort.signal.throwIfAborted();
    return result;
  } finally { lease.abort.signal.removeEventListener("abort", cancel); }
}

const portMethodIdentities = new WeakMap<object, object>();
/** Identity for caches and executor selection; dispatch still uses the guarded port. */
export const operationPortIdentity = (method: object): object => portMethodIdentities.get(method) ?? method;

/** Preserve synchronous ports and stable function identities on each proxy. */
export function leasedOperationPorts<T extends object>(ports: T): T {
  if (!context.getStore()) return ports;
  const methods = new Map<PropertyKey, { value: unknown; method: (...args: unknown[]) => unknown }>();
  return new Proxy(ports, { set(target, property, value, receiver) {
    assertOperationLease();
    return Reflect.set(target, property, value, receiver);
  }, get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== "function") return value;
    if (methods.get(property)?.value === value) return methods.get(property)!.method;
    const method = (...args: unknown[]) => {
      assertOperationLease();
      const lease = context.getStore();
      if (lease && property === "exec") {
        const options = args[4] as { signal?: AbortSignal } | undefined;
        args[4] = { ...options, signal: options?.signal ? AbortSignal.any([options.signal, lease.abort.signal]) : lease.abort.signal };
      } else if (lease && property === "provisionExec") {
        const signal = args[3] as AbortSignal | undefined;
        args[3] = signal ? AbortSignal.any([signal, lease.abort.signal]) : lease.abort.signal;
      }
      const result = trackLeasedOperation(`port.${String(property)}`, () => Reflect.apply(value, target, args));
      if (result && typeof result.then === "function") return awaitLeasedOperation(`port.${String(property)}`, () => result);
      assertOperationLease();
      return result;
    };
    portMethodIdentities.set(method, operationPortIdentity(value));
    methods.set(property, { value, method });
    return method;
  } });
}
