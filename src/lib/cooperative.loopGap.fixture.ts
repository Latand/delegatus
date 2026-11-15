import { yieldToRuntime } from "./cooperative";

/*
 * The measurement of docs/design/viewer-stalls-root-cause.md, section 3.3, in a
 * process of its own: N jobs each burn a slice and yield, and a 10 ms timer
 * measures the gaps the way the loop monitor does. Prints one JSON line.
 *
 * argv: jobs, sliceMs, durationMs
 */
const [jobs, sliceMs, durationMs] = process.argv.slice(2).map(Number) as [number, number, number];
const startedAt = performance.now();
const deadline = startedAt + durationMs;
let slices = 0;
let firstSlices = 0;
/** When every job has had its first slice: those run back to back before any yield can spread them. */
let commonStartEndedAt = Number.POSITIVE_INFINITY;

async function job(): Promise<void> {
  let first = true;
  while (performance.now() < deadline) {
    const sliceEndsAt = performance.now() + sliceMs;
    while (performance.now() < sliceEndsAt) { /* a synchronous slice of work */ }
    slices += 1;
    if (first) {
      first = false;
      firstSlices += 1;
      if (firstSlices === jobs) commonStartEndedAt = performance.now();
    }
    await yieldToRuntime();
  }
}

const gaps: number[] = [];
let ticks = 0;
let lastTick = startedAt;
let timer: ReturnType<typeof setTimeout>;
const poll = () => {
  const at = performance.now();
  ticks += 1;
  if (lastTick >= commonStartEndedAt) gaps.push(Math.max(0, at - lastTick - 10));
  lastTick = at;
  timer = setTimeout(poll, 10);
};
timer = setTimeout(poll, 10);

await Promise.all(Array.from({ length: jobs }, job));
clearTimeout(timer);
const elapsedMs = performance.now() - startedAt;
gaps.sort((left, right) => left - right);
const at = (share: number) => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * share))]! : null;
console.log(JSON.stringify({
  jobs, sliceMs, elapsedMs: Math.round(elapsedMs), slices, slicesPerSecond: Math.round(slices / (elapsedMs / 1_000)),
  ticks, gapsAfterCommonStart: gaps.length,
  longestGapMs: gaps.length ? Math.round(gaps.at(-1)!) : null, p95GapMs: at(0.95) === null ? null : Math.round(at(0.95)!),
  stalledMs: Math.round(gaps.filter(gap => gap > 500).reduce((sum, gap) => sum + gap, 0)),
}));
