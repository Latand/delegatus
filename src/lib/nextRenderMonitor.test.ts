import { expect, test } from "bun:test";
import { getTracer } from "next/dist/server/lib/trace/tracer";
import { BaseServerSpan, RenderSpan } from "next/dist/server/lib/trace/constants";
import { installServingNextRenderMonitor } from "./nextRenderMonitor";
import { createPerformanceSpans, performanceSites } from "./performanceSpans";
import { createViewerLoopMonitor } from "./viewerLoopMonitor";

test("serving Next tracer retains render phase, static site and failure semantics", async () => {
  let at = 0;
  const lines: string[] = [], sites: number[] = [];
  const spans = createPerformanceSpans(() => at);
  spans.observeSite(site => sites.push(site));
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at, spans);
  const tracer = getTracer();
  const original = tracer.trace;
  const restore = await installServingNextRenderMonitor(monitor, spans);
  try {
    const wrapped = tracer.trace;
    (await installServingNextRenderMonitor(monitor, spans))();
    expect(tracer.trace).toBe(wrapped);
    expect(tracer.trace(BaseServerSpan.handleRequest, () => 42)).toBe(42);
    expect(spans.snapshot().records).toHaveLength(0);
    const sentinel = new Error("private render arguments");
    expect(() => tracer.trace(RenderSpan.renderDocument, { spanName: "private route" }, () => {
      expect(monitor.current()).toBe("http.render");
      at = 1300;
      throw sentinel;
    })).toThrow(sentinel);
    monitor.tick();
    const failure = JSON.parse(lines[0].slice("[viewer loop-gap] ".length));
    expect(failure.operations).toContainEqual(expect.objectContaining({ name: "http.render", completed: true }));
    expect(failure.attribution.slices).toContainEqual(expect.objectContaining({ site: "http.render", failed: true }));
    expect(lines[0]).not.toContain("private");
    expect(sites).toEqual([performanceSites.indexOf("http.render"), -1]);

    let resolve!: (value: number) => void;
    const pending = tracer.trace(BaseServerSpan.renderToResponseWithComponents, async () => {
      expect(monitor.current()).toBe("http.render");
      return await new Promise<number>(done => { resolve = done; });
    });
    at = 2600; monitor.tick();
    const active = JSON.parse(lines[1].slice("[viewer loop-gap] ".length));
    expect(active.operations).toContainEqual(expect.objectContaining({ name: "http.render", completed: false }));
    resolve(73);
    expect(await pending).toBe(73);
    await expect(tracer.trace(RenderSpan.renderDocument, async () => { throw sentinel; })).rejects.toBe(sentinel);
  } finally { restore(); monitor.stop(); }
  expect(tracer.trace).toBe(original);
});

test("a response still being sent after the bound is counted as a stream", async () => {
  let at = 0;
  const lines: string[] = [];
  const spans = createPerformanceSpans(() => at);
  const monitor = createViewerLoopMonitor(line => lines.push(line), () => at, spans);
  const restore = await installServingNextRenderMonitor(monitor, spans, 20);
  const operations = () => {
    at += 1300; monitor.tick();
    return (JSON.parse(lines.at(-1)!.slice("[viewer loop-gap] ".length)).operations as Array<{ name: string; completed: boolean }>);
  };
  try {
    const tracer = getTracer();
    let close!: (value: string) => void;
    const stream = tracer.trace(BaseServerSpan.renderToResponseWithComponents, async () => await new Promise<string>(done => { close = done; }));
    const quick = tracer.trace(BaseServerSpan.renderToResponseWithComponents, async () => "page");
    expect(await quick).toBe("page");
    expect(operations().filter(operation => !operation.completed).map(operation => operation.name)).toEqual(["http.render"]);
    await Bun.sleep(60);
    // The open response no longer reads as a render that never finished.
    const open = operations();
    expect(open.filter(operation => !operation.completed).map(operation => operation.name)).toEqual(["http.stream"]);
    expect(open).toContainEqual(expect.objectContaining({ name: "http.render", completed: true }));
    close("closed");
    expect(await stream).toBe("closed");
    await Bun.sleep(0);
    expect(operations().filter(operation => !operation.completed)).toEqual([]);
  } finally { restore(); monitor.stop(); }
});
