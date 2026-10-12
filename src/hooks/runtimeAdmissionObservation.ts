import type { RuntimeAdmissionLookup } from "./useRuntime";

type Lookup = (conversationId: string, key: string, signal?: AbortSignal) => Promise<RuntimeAdmissionLookup>;
const unknown: RuntimeAdmissionLookup = { outcome: "unknown" };
const reads = new Map<string, { result: Promise<RuntimeAdmissionLookup>; controller: AbortController; holders: number }>();

/** Automatic observation, Re-check and Retry share one bounded original-key
 * read. Each view releases its share on hide or unmount. */
export function observeRuntimeAdmission(
  conversationId: string, key: string, lookup: Lookup, signal?: AbortSignal,
): Promise<RuntimeAdmissionLookup> {
  if (signal?.aborted) return Promise.resolve(unknown);
  const identity = JSON.stringify([conversationId, key]);
  let read = reads.get(identity);
  if (!read || read.controller.signal.aborted) {
    const controller = new AbortController();
    // Race the abort as well: a transport seam may ignore its AbortSignal.
    const aborted = new Promise<RuntimeAdmissionLookup>(resolve => {
      controller.signal.addEventListener("abort", () => resolve(unknown), { once: true });
    });
    const timer = setTimeout(() => controller.abort(), 10_000);
    const result = Promise.race([Promise.resolve().then(() => lookup(conversationId, key, controller.signal)).catch(() => unknown), aborted]);
    read = { result, controller, holders: 0 };
    reads.set(identity, read);
    const owned = read;
    void result.finally(() => {
      clearTimeout(timer);
      if (reads.get(identity) === owned) reads.delete(identity);
    });
  }
  const owned = read;
  owned.holders += 1;
  return new Promise(resolve => {
    let finished = false;
    const finish = (answer: RuntimeAdmissionLookup) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", cancel);
      if (--owned.holders === 0) owned.controller.abort();
      resolve(answer);
    };
    const cancel = () => finish(unknown);
    signal?.addEventListener("abort", cancel, { once: true });
    void owned.result.then(finish);
  });
}
