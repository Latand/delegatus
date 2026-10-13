/**
 * The order the board's projection builds run in (#2761).
 *
 * Builds run one at a time, in arrival order: the resident worker holds one
 * projection's heap while it builds. Eight scopes once queued behind each
 * other for 98 s, and every waiting caller kept its request open while the
 * worker's own timeout only started at dispatch. The queue is bounded twice:
 * a build arriving while `maxDepth` builds already wait is refused, and a
 * build still waiting `maxWaitMs` after it arrived leaves the queue then,
 * freeing its slot; it never runs.
 * The caller serves the scope's last representation when either happens.
 * Each scope has at most one build in flight (the caller joins the rest), so
 * the depth bound counts distinct scopes. The wait is reported apart from the
 * build, as `files-worker-queue` beside `files-worker-build`.
 */

export class FilesProjectionQueueError extends Error {
  constructor(readonly reason: "full" | "expired", readonly waitedMs: number, limit: number) {
    super(reason === "full"
      ? `files projection queue is full (${limit} builds waiting)`
      : `files projection waited ${Math.round(waitedMs)}ms in the queue, past ${limit}ms, and was discarded`);
    this.name = "FilesProjectionQueueError";
  }
}

/** Queue counters since this process started, for diagnosis and the candidate gate. */
export interface FilesProjectionQueueDiagnostics {
  waiting: number;
  maxWaiting: number;
  started: number;
  refused: number;
  expired: number;
  maxWaitMs: number;
  /** The most recent builds, newest last: their queue wait and build time. */
  recent: Array<{ waitMs: number; buildMs: number }>;
}

const RECENT_BUILDS_KEPT = 64;

/** One finished build: its place in this process's build order, its queue
    wait and its build time. Every build reaches every observer, however many
    the bounded `recent` history has already let go. */
export interface FilesProjectionBuildSample {
  sequence: number;
  waitMs: number;
  buildMs: number;
}

export interface FilesProjectionQueue {
  run<T extends { timing: string }>(build: () => Promise<T>): Promise<T>;
  diagnostics(): FilesProjectionQueueDiagnostics;
  observe(observer: (sample: FilesProjectionBuildSample) => void): () => void;
}

export function createFilesProjectionQueue(options: {
  maxDepth: number;
  maxWaitMs: number;
  now?: () => number;
  /** Arms the wait bound of one queued build; tests pass their own clock. */
  timer?: (callback: () => void, delayMs: number) => { cancel(): void };
  /** Where the last queued build is kept; a process keeps it on globalThis. */
  tail?: { get(): Promise<unknown> | undefined; set(tail: Promise<void>): void };
}): FilesProjectionQueue {
  const now = options.now ?? (() => performance.now());
  const timer = options.timer ?? ((callback: () => void, delayMs: number) => {
    const handle = setTimeout(callback, delayMs);
    (handle as { unref?: () => void }).unref?.();
    return { cancel: () => clearTimeout(handle) };
  });
  const state: FilesProjectionQueueDiagnostics = { waiting: 0, maxWaiting: 0, started: 0, refused: 0, expired: 0, maxWaitMs: 0, recent: [] };
  const observers = new Set<(sample: FilesProjectionBuildSample) => void>();
  let local: Promise<unknown> | undefined;
  const tail = options.tail ?? { get: () => local, set: (next: Promise<void>) => { local = next; } };
  interface Job {
    build: () => Promise<{ timing: string }>;
    resolve: (value: { timing: string }) => void;
    reject: (error: unknown) => void;
    enqueuedAt: number;
    deadline: { cancel(): void } | null;
  }
  const queued: Job[] = [];
  let active = false;
  /* A queued build leaves at its deadline, freeing its slot and answering its
     caller then, never later when the build ahead of it happens to finish. */
  const expire = (job: Job) => {
    const index = queued.indexOf(job);
    if (index < 0) return;
    queued.splice(index, 1);
    job.deadline?.cancel();
    state.waiting -= 1;
    state.expired += 1;
    const waitMs = now() - job.enqueuedAt;
    state.maxWaitMs = Math.max(state.maxWaitMs, waitMs);
    job.reject(new FilesProjectionQueueError("expired", waitMs, options.maxWaitMs));
  };
  const pump = () => {
    if (active) return;
    let job = queued[0];
    /* A clock that moved past a deadline its timer has not reported yet. */
    while (job && now() - job.enqueuedAt > options.maxWaitMs) {
      expire(job);
      job = queued[0];
    }
    if (!job) return;
    queued.shift();
    job.deadline?.cancel();
    active = true;
    state.waiting -= 1;
    const waitMs = now() - job.enqueuedAt;
    state.maxWaitMs = Math.max(state.maxWaitMs, waitMs);
    state.started += 1;
    const sequence = state.started;
    const startedAt = now();
    void (async () => {
      try {
        const representation = await job.build();
        const buildMs = now() - startedAt;
        state.recent.push({ waitMs, buildMs });
        if (state.recent.length > RECENT_BUILDS_KEPT) state.recent.shift();
        for (const observer of observers) observer({ sequence, waitMs, buildMs });
        const timing = `files-worker-queue;dur=${waitMs.toFixed(1)}, files-worker-build;dur=${buildMs.toFixed(1)}`;
        job.resolve({ ...representation, timing: representation.timing ? `${timing}, ${representation.timing}` : timing });
      } catch (error) {
        job.reject(error);
      } finally {
        active = false;
        pump();
      }
    })();
  };
  return {
    run<T extends { timing: string }>(build: () => Promise<T>): Promise<T> {
      if (state.waiting >= options.maxDepth) {
        state.refused += 1;
        return Promise.reject(new FilesProjectionQueueError("full", 0, options.maxDepth));
      }
      state.waiting += 1;
      state.maxWaiting = Math.max(state.maxWaiting, state.waiting);
      const current = new Promise<T>((resolve, reject) => {
        const job: Job = {
          build,
          resolve: resolve as (value: { timing: string }) => void,
          reject,
          enqueuedAt: now(),
          deadline: null,
        };
        queued.push(job);
        job.deadline = timer(() => expire(job), options.maxWaitMs);
        /* As a chained promise did: the caller finishes its turn first. */
        queueMicrotask(pump);
      });
      const previous = tail.get() ?? Promise.resolve();
      tail.set(Promise.all([previous.catch(() => undefined), current.catch(() => undefined)]).then(() => undefined));
      return current;
    },
    diagnostics: () => ({ ...state, recent: [...state.recent] }),
    observe(observer) {
      observers.add(observer);
      return () => { observers.delete(observer); };
    },
  };
}
