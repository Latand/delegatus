import { witnessAdmissions, type AdmissionWitness } from "@/lib/state/admissionWitness";
import { stateLockDeferral, type StateLockDeferredError } from "@/lib/state/lockWait";

/*
 * A binding that was refused the state lock before it wrote anything used to
 * have that refusal stored as the answer of its clientRequestId: the retry the
 * answer invited replayed the refusal for ever, and the caller needed a new
 * key (docs/design/viewer-stalls-root-cause.md, section 4.3).
 *
 * Every binding runs under a witness of the writers this process's stores
 * admitted for it. A refusal that is the typed pre-admission deferral, raised
 * while that count was still zero, changed nothing here.
 */

const writersBefore = new WeakMap<object, number>();

type Binding = (...args: never[]) => unknown;

/** The same bindings, each call witnessed. Properties a binding carries beside its call pass through. */
export function witnessStoreWriters<B extends object>(bindings: B): B {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(bindings, {
    get(target, property, receiver) {
      const binding = Reflect.get(target, property, receiver) as unknown;
      if (typeof binding !== "function") return binding;
      const known = wrapped.get(property) as { binding: unknown; proxy: unknown } | undefined;
      if (known?.binding === binding) return known.proxy;
      const proxy = new Proxy(binding as Binding, {
        apply(call, self, args) {
          const witness: AdmissionWitness = { entered: 0 };
          const remember = (error: unknown) => {
            if (error && typeof error === "object") writersBefore.set(error, witness.entered);
            throw error;
          };
          try {
            const result = witnessAdmissions(witness, () => Reflect.apply(call, self, args)) as unknown;
            return result instanceof Promise ? result.catch(remember) : result;
          } catch (error) { return remember(error); }
        },
      });
      wrapped.set(property, { binding, proxy });
      return proxy;
    },
  });
}

/**
 * The deferral a witnessed binding raised before any store of this process
 * admitted a writer for it, or null: the error is something else, a writer had
 * already entered, or the binding was not witnessed.
 */
export function deferredBeforeAnyWriter(error: unknown): StateLockDeferredError | null {
  if (!error || typeof error !== "object" || writersBefore.get(error) !== 0) return null;
  return stateLockDeferral(error);
}
