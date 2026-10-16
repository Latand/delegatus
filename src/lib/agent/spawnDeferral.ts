import { after } from "next/server";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { bindSpawnDiagnostics, spawnDiagnosticError } from "./spawnDiagnostics";

/** Keep request launches on Next's response lifetime. In-process controllers
 * have no request; the pinned Next runtime refuses them before registering work
 * with E468. Every other registration failure must still reach the caller.
 */
export function deferSpawnWork(work: () => Promise<void>): void {
  try {
    after(work);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !("__NEXT_ERROR_CODE" in error) || error.__NEXT_ERROR_CODE !== "E468") throw error;
  }
  startDeferredSpawnWork(work);
}

/** Timer-owned launches yield before starting and report escaped failures. */
export function startDeferredSpawnWork(work: () => Promise<void>): void {
  setImmediate(bindSpawnDiagnostics(() => {
    void withViewerOperation("agent.deferred-spawn", async () => {
      try { await work(); }
      catch {
        // Launch work owns receipt diagnostics. Connector/account error text
        // must not escape through the shared timer hook.
        spawnDiagnosticError("[spawn] deferred work failed");
      }
    });
  }));
}
