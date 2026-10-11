/**
 * The order the board's projection builds run in (#2761).
 *
 * Builds run one at a time, in arrival order: the resident worker holds one
 * projection's heap while it builds. Eight scopes once queued behind each
 * other for 98 s, and every waiting caller kept its request open while the
 * worker's own timeout only started at dispatch. The queue is bounded twice:
 * a build arriving while `maxDepth` builds already wait is refused, and a
 * build that waited longer than `maxWaitMs` is discarded when its turn comes.
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

export interface FilesProjectionQueue {
  run<T extends { timing: string }>(build: () => Promise<T>): Promise<T>;
  diagnostics(): FilesProjectionQueueDiagnostics;
}

export function createFilesProjectionQueue(options: {
  maxDepth: number;
  maxWaitMs: number;
  now?: () => number;
  /** Where the last queued build is kept; a process keeps it on globalThis. */
  tail?: { get(): Promise<unknown> | undefined; set(tail: Promise<void>): void };
}): FilesProjectionQueue {
  const now = options.now ?? (() => performance.now());
  const state: FilesProjectionQueueDiagnostics = { waiting: 0, maxWaiting: 0, started: 0, refused: 0, expired: 0, maxWaitMs: 0, recent: [] };
  let local: Promise<unknown> | undefined;
  const tail = options.tail ?? { get: () => local, set: (next: Promise<void>) => { local = next; } };
  return {
    run(build) {
      if (state.waiting >= options.maxDepth) {
        state.refused += 1;
        return Promise.reject(new FilesProjectionQueueError("full", 0, options.maxDepth));
      }
      state.waiting += 1;
      state.maxWaiting = Math.max(state.maxWaiting, state.waiting);
      const enqueuedAt = now();
      const current = (tail.get() ?? Promise.resolve()).catch(() => undefined).then(async () => {
        state.waiting -= 1;
        const waitMs = now() - enqueuedAt;
        state.maxWaitMs = Math.max(state.maxWaitMs, waitMs);
        if (waitMs > options.maxWaitMs) {
          state.expired += 1;
          throw new FilesProjectionQueueError("expired", waitMs, options.maxWaitMs);
        }
        state.started += 1;
        const startedAt = now();
        const representation = await build();
        const buildMs = now() - startedAt;
        state.recent.push({ waitMs, buildMs });
        if (state.recent.length > RECENT_BUILDS_KEPT) state.recent.shift();
        const timing = `files-worker-queue;dur=${waitMs.toFixed(1)}, files-worker-build;dur=${buildMs.toFixed(1)}`;
        return { ...representation, timing: representation.timing ? `${timing}, ${representation.timing}` : timing };
      });
      tail.set(current.then(() => undefined, () => undefined));
      return current;
    },
    diagnostics: () => ({ ...state, recent: [...state.recent] }),
  };
}
