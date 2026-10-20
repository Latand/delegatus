import { stateDir } from "@/lib/configDir";
import { endLeasedHelper, leasedHelperInput, spawnLeasedHelper } from "@/lib/helperLease";
import { performanceSpans } from "@/lib/performanceSpans";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { memoryImportLaunch } from "./importJob";
import type { MemoryRoots } from "./sources";

export type MemoryRefreshCounts = { filesRead: number; filesSkipped: number; entriesIndexed: number; filesFailed: number };
const host = globalThis as typeof globalThis & {
  __delegatusMemoryRefresh?: { directory: string; request: string; done: Promise<MemoryRefreshCounts> };
};

/** One leased scan at a time, shared across server bundles. A refusal or helper
 * exit evicts the promise so the existing scanner cadence can retry. */
export function refreshMemoryInHelper(roots?: MemoryRoots): Promise<MemoryRefreshCounts> {
  if (roots?.projectForSlug) return Promise.reject(Error("memory helper requires serializable roots"));
  const directory = stateDir(), frame = JSON.stringify({ kind: "refresh-index", roots }) + "\n";
  if (Buffer.byteLength(frame) > 64 * 1024) return Promise.reject(Error("memory refresh request exceeds its bound"));
  const active = host.__delegatusMemoryRefresh;
  if (active) return active.directory === directory && active.request === frame ? active.done
    : Promise.reject(Error("memory refresh already running"));
  const done = withViewerOperation("memory.refresh", () => performanceSpans.wait("memory.refresh", async () => {
    const launch = await memoryImportLaunch();
    return new Promise<MemoryRefreshCounts>((resolve, reject) => {
      const child = spawnLeasedHelper("memory.refresh", {
        command: launch.executable, args: [launch.entry], cwd: process.cwd(),
        env: { ...process.env, LLV_STATE_DIR: directory, LLV_STATE_OWNER: "viewer" },
      }, directory, { input: true, stdout: "pipe", stderr: "ignore" });
      let output = "", failure: Error | undefined;
      const fail = (message: string) => { failure ??= Error(message); endLeasedHelper(child); };
      const timer = setTimeout(() => fail("memory refresh helper deadline"), 5 * 60_000);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        if (failure) return;
        output += chunk;
        if (Buffer.byteLength(output) > 1024) fail("memory refresh helper reply exceeds its bound");
      });
      child.once("error", () => fail("could not start memory refresh helper"));
      const input = leasedHelperInput(child);
      input.on("error", () => fail("memory refresh helper input closed"));
      input.end(frame);
      child.once("close", code => {
        clearTimeout(timer);
        if (failure) { reject(failure); return; }
        try {
          const result = JSON.parse(output).refresh as MemoryRefreshCounts;
          if (code !== 0 || !result || Object.keys(result).length !== 4
            || ![result.filesRead, result.filesSkipped, result.entriesIndexed, result.filesFailed]
              .every(value => Number.isSafeInteger(value) && value >= 0)) throw Error();
          resolve(result);
        } catch { reject(Error("memory refresh helper refused")); }
      });
    });
  })).finally(() => {
    if (host.__delegatusMemoryRefresh?.done === done) host.__delegatusMemoryRefresh = undefined;
  });
  host.__delegatusMemoryRefresh = { directory, request: frame, done };
  return done;
}
