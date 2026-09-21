import type { promises as fsp } from "node:fs";
import path from "node:path";

import { homeDirectory } from "@/lib/platformHome";

/*
 * Local-file plumbing shared by the artifact routes (/api/artifact and the
 * report frame beneath it): the allowed root, lexical containment and the
 * bounded, abortable stream over one pinned descriptor.
 */

/** One streamed read; also the natural rhythm the deadline is checked at. */
const STREAM_CHUNK = 64 * 1024;

/* $HOME first: it is what the isolated demo/evidence runtimes (and tests)
   repoint, and Bun's os.homedir() ignores the env override. On Windows HOME is
   not a Windows variable and a Git Bash value would resolve to nothing — see
   `homeDirectory`. */
export function homeRoot(): string {
  return homeDirectory();
}

export function resolveLocal(raw: string): string {
  let p = raw.replace(/^file:\/\//, "");
  if (p === "~" || p.startsWith("~/")) p = path.join(homeRoot(), p.slice(1));
  return path.resolve(p);
}

export function underRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Streams `[start, end]` from the pinned descriptor, honouring the request's
 * AbortSignal (the preview closing cancels the fetch) and the configured time
 * budget. The descriptor is closed on completion, cancellation and error —
 * exactly once.
 */
export function streamWindow(
  handle: fsp.FileHandle,
  start: number,
  end: number,
  signal: AbortSignal,
  timeBudgetMs: number,
): ReadableStream<Uint8Array> {
  let position = start;
  const deadline = Date.now() + timeBudgetMs;
  let done = false;
  const finish = async () => {
    if (done) return;
    done = true;
    await handle.close().catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal.aborted || Date.now() > deadline) {
        await finish();
        controller.error(new Error(signal.aborted ? "client aborted" : "artifact time budget exceeded"));
        return;
      }
      const want = Math.min(STREAM_CHUNK, end - position + 1);
      if (want <= 0) {
        await finish();
        controller.close();
        return;
      }
      const buffer = Buffer.alloc(want);
      try {
        const { bytesRead } = await handle.read(buffer, 0, want, position);
        if (bytesRead <= 0) {
          /* The pinned inode ended early (truncated in place): end the body
             rather than hang — the client's validator round-trip reports it. */
          await finish();
          controller.close();
          return;
        }
        position += bytesRead;
        controller.enqueue(new Uint8Array(buffer.subarray(0, bytesRead)));
      } catch (error) {
        await finish();
        controller.error(error);
      }
    },
    async cancel() {
      await finish();
    },
  });
}
