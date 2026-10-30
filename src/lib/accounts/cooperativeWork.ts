import { yieldToRuntime } from "@/lib/cooperative";

/** Share the same checked filesystem algorithm between compatibility callers
 * and request handlers, which must release the event loop during bulk work. */
export function finishSteps<T>(steps: Generator<void, T>): T {
  try {
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  } finally { steps.return(undefined as never); }
}

export async function finishStepsCooperatively<T>(steps: Generator<void, T>): Promise<T> {
  let slice = performance.now();
  try {
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
      if (performance.now() - slice >= 8) {
        await yieldToRuntime();
        slice = performance.now();
      }
    }
  } finally { steps.return(undefined as never); }
}
