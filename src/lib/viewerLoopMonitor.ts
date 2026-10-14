import { AsyncLocalStorage } from "node:async_hooks";

export type ViewerOperation = "pipelines.startup-admission" | "pipelines.mutation" | "pipelines.controller-mutation" | "pipelines.evidence" | "pipelines.get" | "files.get" | "files.health" | "controller.scan" | "controller.pipelines" | "controller.flows" | "activity.ingest";
type Operation = { name: ViewerOperation; start: number; end?: number };
const shared = globalThis as typeof globalThis & { __delegatusLoopMonitor?: ReturnType<typeof createViewerLoopMonitor> };

/** Completed operations survive until the next timer: their synchronous work
    can have returned before that timer is allowed to run. */
export function createViewerLoopMonitor(log: (line: string) => void = console.warn, now = () => performance.now()) {
  let writeLog = log;
  const context = new AsyncLocalStorage<ViewerOperation>();
  const active = new Set<Operation>();
  let completed: Operation[] = [];
  let last = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const at = now();
    const gapMs = Math.max(0, at - last - 10);
    if (gapMs > 500) {
      const named = new Map<ViewerOperation, { name: ViewerOperation; durationMs: number; completed: boolean; count: number }>();
      for (const op of [...completed, ...active]) {
        if ((op.end ?? at) < last) continue;
        const durationMs = Math.round((op.end ?? at) - op.start);
        const entry = named.get(op.name);
        if (entry) {
          entry.durationMs = Math.max(entry.durationMs, durationMs);
          entry.completed ||= op.end !== undefined;
          entry.count++;
        } else named.set(op.name, { name: op.name, durationMs, completed: op.end !== undefined, count: 1 });
      }
      const operations = [...named.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, 16);
      writeLog(`[viewer loop-gap] ${JSON.stringify({ gapMs: Math.round(gapMs), operations })}`);
    }
    completed = [];
    last = at;
  };
  return {
    current: () => context.getStore(),
    setLogSink(sink: (line: string) => void) {
      const previous = writeLog;
      writeLog = sink;
      return () => { writeLog = previous; };
    },
    run<T>(name: ViewerOperation, work: () => T): T {
      const op: Operation = { name, start: now() };
      if (active.size < 128) active.add(op);
      const finish = () => {
        active.delete(op);
        op.end = now();
        completed.push(op);
        if (completed.length <= 128) return;
        let shortest = 0;
        for (let i = 1; i < completed.length; i++) {
          if (completed[i]!.end! - completed[i]!.start < completed[shortest]!.end! - completed[shortest]!.start) shortest = i;
        }
        completed.splice(shortest, 1);
      };
      return context.run(name, () => {
        try {
          const result = work();
          if (result && typeof (result as unknown as Promise<unknown>).then === "function") {
            return Promise.resolve(result).finally(finish) as T;
          }
          finish();
          return result;
        } catch (error) { finish(); throw error; }
      });
    },
    tick,
    start() {
      if (timer) return;
      last = now();
      const poll = () => { tick(); timer = setTimeout(poll, 10); timer.unref(); };
      timer = setTimeout(poll, 10); timer.unref();
    },
    stop() { if (timer) clearTimeout(timer); timer = undefined; completed = []; },
  };
}
export const viewerLoopMonitor = shared.__delegatusLoopMonitor ??= createViewerLoopMonitor();
export const withViewerOperation = <T>(name: ViewerOperation, work: () => T): T => viewerLoopMonitor.run(name, work);
