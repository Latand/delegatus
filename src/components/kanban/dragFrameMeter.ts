import fs from "node:fs";
import path from "node:path";
import type { CDPSession, Page } from "playwright-core";

/*
 * What the whole-card drag is measured with: a recorded Chromium trace plus an
 * in-page frame clock, taken around one scripted pointer path. Shared by the
 * desktop (`kanbanBoard.browser.test.tsx`) and phone
 * (`issue1671Evidence.browser.test.tsx`) drivers, so a number for one is read
 * the same way as a number for the other.
 *
 *   frames      requestAnimationFrame deltas while the path runs: a display that
 *               is kept up with delivers 16.7 ms apart (60 Hz), and the p95 of
 *               them is the smoothness gate.
 *   longTasks   main-thread tasks over 50 ms, from the trace's RunTask events.
 *   moveCost    what the page spent in `pointermove` handlers, from the trace.
 *   layouts     Layout and UpdateLayoutTree events: a drag that moves by
 *               transform needs none per move.
 *   inputLagMs  how late a pointermove reached the page after the device made it:
 *               what the operator feels as the card trailing the hand.
 *   mutations   DOM mutations the page made, from a MutationObserver. A drag
 *               that moves by `transform` writes one attribute per frame; a
 *               React commit shows as many more.
 */

export interface DragReading {
  moves: number;
  frames: number;
  frameMs: { p50: number; p95: number; max: number };
  longTasks: { count: number; longestMs: number };
  moveCost: { events: number; totalMs: number; maxMs: number };
  layouts: { count: number; totalMs: number };
  recalcs: { count: number; totalMs: number };
  inputLagMs: { p95: number; max: number };
  mutations: number;
  /** The page's busiest mutations, by kind and target: what a frame wrote. */
  mutationKinds: Record<string, number>;
  trace: string;
}

interface TraceEvent { name: string; ph: string; ts: number; dur?: number; tid: number; pid: number; args?: { data?: { type?: string }; name?: string } }

export const percentile = (values: number[], share: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * share) - 1)]!;
};

const round = (value: number) => Math.round(value * 100) / 100;

async function readStream(cdp: CDPSession, handle: string): Promise<string> {
  let text = "";
  for (;;) {
    const chunk = await cdp.send("IO.read", { handle });
    text += chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send("IO.close", { handle });
  return text;
}

/** Records `run` and returns the reading; the full trace is kept at `out/<name>.trace.json`. */
export async function recordDrag(page: Page, cdp: CDPSession, out: string, name: string, run: () => Promise<number>): Promise<DragReading> {
  fs.mkdirSync(out, { recursive: true });
  await page.evaluate(() => {
    const meter = { stamps: [] as number[], lag: [] as number[], mutations: 0, kinds: {} as Record<string, number>, on: true };
    (window as unknown as { __meter: typeof meter }).__meter = meter;
    const tick = (now: number) => { if (meter.on) { meter.stamps.push(now); requestAnimationFrame(tick); } };
    requestAnimationFrame(tick);
    window.addEventListener("pointermove", (event) => { if (meter.on) meter.lag.push(performance.now() - event.timeStamp); }, { capture: true, passive: true });
    new MutationObserver((records) => {
      if (!meter.on) return;
      meter.mutations += records.length;
      for (const record of records) {
        const target = record.target as HTMLElement;
        const key = `${record.type}:${record.attributeName ?? ""} on ${(target.tagName ?? "#text").toLowerCase()}.${String(target.getAttribute?.("class") ?? "").split(" ")[0]}`;
        meter.kinds[key] = (meter.kinds[key] ?? 0) + 1;
      }
    }).observe(document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true });
  });
  await cdp.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    categories: "devtools.timeline,disabled-by-default-devtools.timeline,toplevel",
  });
  const moves = await run();
  const done = new Promise<{ stream?: string }>((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  const { stream } = await done;
  const raw = stream ? await readStream(cdp, stream) : "{\"traceEvents\":[]}";
  const meter = await page.evaluate(() => {
    const m = (window as unknown as { __meter: { stamps: number[]; lag: number[]; mutations: number; kinds: Record<string, number>; on: boolean } }).__meter;
    m.on = false;
    return { stamps: m.stamps, lag: m.lag, mutations: m.mutations, kinds: m.kinds };
  });
  const trace = path.join(out, `${name}.trace.json`);
  fs.writeFileSync(trace, raw);

  const events = (JSON.parse(raw) as { traceEvents: TraceEvent[] }).traceEvents;
  /* The renderer's main thread: the one named CrRendererMain with the most RunTask events. */
  const mains = new Set(events.filter((event) => event.name === "thread_name" && event.args?.name === "CrRendererMain").map((event) => `${event.pid}:${event.tid}`));
  const onMain = events.filter((event) => event.ph === "X" && mains.has(`${event.pid}:${event.tid}`));
  const total = (list: TraceEvent[]) => list.reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000;
  const tasks = onMain.filter((event) => event.name === "RunTask");
  const handlers = onMain.filter((event) => event.name === "EventDispatch" && event.args?.data?.type === "pointermove");
  const layouts = onMain.filter((event) => event.name === "Layout");
  const recalcs = onMain.filter((event) => event.name === "UpdateLayoutTree");
  const deltas = meter.stamps.slice(1).map((stamp, index) => stamp - meter.stamps[index]!);
  return {
    moves,
    frames: meter.stamps.length,
    frameMs: { p50: round(percentile(deltas, 0.5)), p95: round(percentile(deltas, 0.95)), max: round(Math.max(0, ...deltas)) },
    longTasks: { count: tasks.filter((event) => (event.dur ?? 0) > 50_000).length, longestMs: round(Math.max(0, ...tasks.map((event) => (event.dur ?? 0) / 1000))) },
    moveCost: { events: handlers.length, totalMs: round(total(handlers)), maxMs: round(Math.max(0, ...handlers.map((event) => (event.dur ?? 0) / 1000))) },
    layouts: { count: layouts.length, totalMs: round(total(layouts)) },
    recalcs: { count: recalcs.length, totalMs: round(total(recalcs)) },
    inputLagMs: { p95: round(percentile(meter.lag, 0.95)), max: round(Math.max(0, ...meter.lag)) },
    mutations: meter.mutations,
    mutationKinds: Object.fromEntries(Object.entries(meter.kinds).sort((a, b) => b[1] - a[1]).slice(0, 6)),
    trace,
  };
}

/** A scripted pointer path: `legs` straight segments through `points`, taking `ms` in all, one move every `everyMs`. */
export function* pointerPath(points: ReadonlyArray<readonly [number, number]>, ms: number, everyMs: number): Generator<[number, number]> {
  const steps = Math.max(1, Math.round(ms / everyMs));
  const legs = points.length - 1;
  for (let step = 1; step <= steps; step += 1) {
    const at = (step / steps) * legs;
    const leg = Math.min(legs - 1, Math.floor(at));
    const local = at - leg;
    const [x0, y0] = points[leg]!;
    const [x1, y1] = points[leg + 1]!;
    yield [x0 + (x1 - x0) * local, y0 + (y1 - y0) * local];
  }
}

/** Plays a pointer path on the wall clock, the way a mouse polls: one move every `everyMs` whether or not the page has caught up with the last. Resolves with the number of moves once the page has answered them all. */
export async function playPath(cdp: CDPSession, points: ReadonlyArray<readonly [number, number]>, ms: number, everyMs: number, touch = false): Promise<number> {
  const sent: Promise<unknown>[] = [];
  const started = performance.now();
  let index = 0;
  for (const [x, y] of pointerPath(points, ms, everyMs)) {
    index += 1;
    const wait = started + index * everyMs - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    sent.push(touch
      ? cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] })
      : cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 }));
  }
  await Promise.all(sent);
  return index;
}
