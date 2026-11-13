import { open } from "node:fs/promises";
import { readSqliteMemory } from "./sqliteMemoryDiagnostics";

export const HEAP_SERIES_PROC_MAX_BYTES = 16 * 1024;
export const HEAP_SERIES_PROC_WAIT_MS = 250;
type ProcFile = "/proc/self/status" | "/proc/self/smaps_rollup";
type Reader = (file: ProcFile) => Promise<string | null>;

/** One bounded read; procfs reports size zero, so stat cannot bound this. */
async function readProc(file: ProcFile): Promise<string | null> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(HEAP_SERIES_PROC_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead <= HEAP_SERIES_PROC_MAX_BYTES ? buffer.toString("utf8", 0, bytesRead) : null;
  } finally { await handle.close(); }
}

function bytes(text: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m").exec(text);
  const value = match ? Number(match[1]) * 1024 : NaN;
  return Number.isSafeInteger(value) ? value : null;
}

/** Only one outstanding native read per source, even after a deadline. */
export function createHeapSeriesProcReader(read: Reader = readProc, platform = process.platform,
  waitMs = HEAP_SERIES_PROC_WAIT_MS) {
  const pending = new Map<ProcFile, Promise<string | null>>();
  const bounded = async (file: ProcFile) => {
    if (platform !== "linux" || pending.has(file)) return null;
    const work = Promise.resolve().then(() => read(file)).catch(() => null).then(text =>
      text !== null && Buffer.byteLength(text) <= HEAP_SERIES_PROC_MAX_BYTES ? text : null);
    pending.set(file, work);
    void work.finally(() => { pending.delete(file); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs); })]); }
    finally { clearTimeout(timer); }
  };
  return async () => {
    const [status, rollup] = await Promise.all([bounded("/proc/self/status"), bounded("/proc/self/smaps_rollup")]);
    return {
      procStatus: status === null ? null : { vmRssBytes: bytes(status, "VmRSS"), rssAnonBytes: bytes(status, "RssAnon"),
        rssFileBytes: bytes(status, "RssFile"), rssShmemBytes: bytes(status, "RssShmem") },
      smapsRollup: rollup === null ? null : { anonymousBytes: bytes(rollup, "Anonymous"), privateDirtyBytes: bytes(rollup, "Private_Dirty") },
    };
  };
}

const procOwner = process as typeof process & { __delegatusHeapSeriesProc?: ReturnType<typeof createHeapSeriesProcReader> };
export async function readHeapSeriesMemory() {
  const started = performance.now();
  const proc = procOwner.__delegatusHeapSeriesProc ??= createHeapSeriesProcReader();
  const [resident, sqlite] = await Promise.all([proc(), readSqliteMemory().catch(() => null)]);
  return { ...resident, sqlite, memorySampleMs: performance.now() - started };
}
