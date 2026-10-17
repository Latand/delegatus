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

export function installNextRenderMonitor(
  tracer: Pick<NextTracer, "trace">,
  monitor = viewerLoopMonitor, spans = performanceSpans,
) {
  if (installed.has(tracer)) return () => {};
  const original = tracer.trace;
  const wrapped = function (this: typeof tracer, ...args: Parameters<NextTracer["trace"]>) {
    const run = () => original.apply(this, args);
    if (!renderTypes.has(args[0])) return run();
    // The synchronous prefix sets the watchdog site. The operation encloses
    // the returned promise too; overlapping awaits alone do not prove CPU use.
    return monitor.run("http.render", () => spans.sync("http.render", run));
  } as NextTracer["trace"];
  tracer.trace = wrapped;
  installed.add(tracer);
  return () => {
    if (tracer.trace !== wrapped) return;
    tracer.trace = original;
    installed.delete(tracer);
  };
}

export async function installServingNextRenderMonitor(monitor = viewerLoopMonitor, spans = performanceSpans) {
  // A static createRequire call with a computed path becomes an undefined
  // webpack context. Match the native import used for the generated route.
  const { createRequire } = await import(/* webpackIgnore: true */ "node:module");
  const tracer = createRequire(path.join(process.cwd(), "package.json"))("next/dist/server/lib/trace/tracer").getTracer();
  return installNextRenderMonitor(tracer, monitor, spans);
}
