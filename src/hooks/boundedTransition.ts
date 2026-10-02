import { startTransition } from "react";

/**
 * How long a background publish may stay a transition. A transition render is
 * interruptible, and a stream of urgent renders (each live event) interrupts
 * it again and again until React expires the starved lane, about five seconds
 * later. The catalog is the freshness the operator reads, so a publish that
 * has not committed by this deadline is applied as an urgent update.
 */
export const BACKGROUND_PUBLISH_DEADLINE_MS = 300;

interface BoundedPublisherOptions<T> {
  /** Applies a value to the state; called inside a transition or, past the deadline, plainly. */
  apply: (value: T) => void;
  /** The value React last committed. */
  committed: () => T;
  deadlineMs?: number;
  defer?: (run: () => void) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface BoundedPublisher<T> {
  publish: (value: T) => void;
  /** Call after every commit: a publish that landed in time needs no deadline. */
  settled: () => void;
  dispose: () => void;
}

/**
 * Publishes in a transition, with a deadline from the first publish that has
 * not yet committed. Publishes that arrive meanwhile ride the same deadline, so
 * a continuous stream of them still commits at most one deadline apart.
 */
export function createBoundedPublisher<T>(options: BoundedPublisherOptions<T>): BoundedPublisher<T> {
  const {
    apply,
    committed,
    deadlineMs = BACKGROUND_PUBLISH_DEADLINE_MS,
    defer = startTransition,
    setTimer = (run, ms) => setTimeout(run, ms),
    clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options;
  let latest: { value: T } | null = null;
  let timer: unknown = null;
  const disarm = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };
  return {
    publish(value) {
      latest = { value };
      defer(() => apply(value));
      if (timer === null) {
        timer = setTimer(() => {
          timer = null;
          if (latest && latest.value !== committed()) apply(latest.value);
        }, deadlineMs);
      }
    },
    settled() {
      if (latest && latest.value === committed()) disarm();
    },
    dispose() {
      latest = null;
      disarm();
    },
  };
}
