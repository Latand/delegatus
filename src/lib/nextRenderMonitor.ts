import path from "node:path";
import type { NextTracer } from "next/dist/server/lib/trace/tracer";
import { performanceSpans } from "./performanceSpans";
import { viewerLoopMonitor } from "./viewerLoopMonitor";

// Load the serving Next instance, outside the instrumentation webpack bundle.
// Only static span types cross the diagnostic boundary; route names, headers,
// render arguments and errors never enter the retained ring.
const shared = globalThis as typeof globalThis & { __delegatusRenderTracers?: WeakSet<object> };
const installed = shared.__delegatusRenderTracers ??= new WeakSet<object>();
const renderTypes = new Set([
  "BaseServer.renderToResponseWithComponents", "BaseServer.renderToHTML",
  "NextNodeServer.renderHTML", "AppRender.renderToString",
  "AppRender.renderToReadableStream", "AppRender.renderToNodeFizzStream",
  "Render.renderToString", "Render.renderDocument",
]);

/** A response still being sent after this long is a stream: an event stream
    or an MCP session stays inside the render span until its client leaves. */
export const HTTP_STREAM_AFTER_MS = 30_000;
const STILL_OPEN = Symbol("still open");

export function installNextRenderMonitor(
  tracer: Pick<NextTracer, "trace">,
  monitor = viewerLoopMonitor, spans = performanceSpans,
  streamAfterMs = HTTP_STREAM_AFTER_MS,
) {
  if (installed.has(tracer)) return () => {};
  const original = tracer.trace;
  const wrapped = function (this: typeof tracer, ...args: Parameters<NextTracer["trace"]>) {
    const run = () => original.apply(this, args);
    if (!renderTypes.has(args[0])) return run();
    // The synchronous prefix sets the watchdog site. The operation encloses
    // the returned promise too; overlapping awaits alone do not prove CPU use.
    let result: unknown;
    const tracked = monitor.run("http.render", () => {
      result = spans.sync("http.render", run);
      if (!result || typeof (result as PromiseLike<unknown>).then !== "function") return result;
      /* Route handlers answer inside the same span and it stays open while
         the body is sent. An open stream then read as a render that never
         finished; after the bound it is counted under its own name. */
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = Promise.resolve(result).then(() => undefined, () => undefined);
      const bound = new Promise<typeof STILL_OPEN>((resolve) => {
        timer = setTimeout(() => resolve(STILL_OPEN), streamAfterMs);
        timer.unref?.();
      });
      return Promise.race([settled, bound]).finally(() => clearTimeout(timer)).then((outcome) => {
        if (outcome === STILL_OPEN) void Promise.resolve(monitor.run("http.stream", () => settled)).catch(() => undefined);
      });
    });
    if (tracked && typeof (tracked as PromiseLike<unknown>).then === "function") void Promise.resolve(tracked).catch(() => undefined);
    return result;
  } as NextTracer["trace"];
  tracer.trace = wrapped;
  installed.add(tracer);
  return () => {
    if (tracer.trace !== wrapped) return;
    tracer.trace = original;
    installed.delete(tracer);
  };
}

export async function installServingNextRenderMonitor(monitor = viewerLoopMonitor, spans = performanceSpans, streamAfterMs = HTTP_STREAM_AFTER_MS) {
  // A static createRequire call with a computed path becomes an undefined
  // webpack context. Match the native import used for the generated route.
  const { createRequire } = await import(/* webpackIgnore: true */ "node:module");
  const tracer = createRequire(path.join(process.cwd(), "package.json"))("next/dist/server/lib/trace/tracer").getTracer();
  return installNextRenderMonitor(tracer, monitor, spans, streamAfterMs);
}
