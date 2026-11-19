/** Standalone observer. Controller work and its phase timers run in the parent. */
const deadlineMs = 15_000;
let acceptedAt: number | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let callbacks = 0, children = 0, deadlineReached = false;
let callbackMs: number | null = null, childMs: number | null = null, tickExitMs: number | null = null;

process.on("message", phase => {
  if (phase === "accepted" && acceptedAt === undefined) {
    acceptedAt = performance.now();
    timer = setTimeout(() => { deadlineReached = true; }, deadlineMs);
    return;
  }
  if (acceptedAt === undefined) throw new Error("cold launch observer received a phase before acceptance");
  const elapsed = performance.now() - acceptedAt;
  if (phase === "callback") {
    callbacks++;
    callbackMs ??= elapsed;
  } else if (phase === "child") {
    children++;
    childMs ??= elapsed;
    deadlineReached ||= elapsed >= deadlineMs;
    clearTimeout(timer);
  } else if (phase === "tick-exit") {
    tickExitMs ??= elapsed;
  } else if (phase === "finished") {
    clearTimeout(timer);
    process.send?.({ callbacks, children, deadlineReached, callbackMs, childMs, tickExitMs });
    process.disconnect?.();
  }
});
process.send?.("ready");

export {};
