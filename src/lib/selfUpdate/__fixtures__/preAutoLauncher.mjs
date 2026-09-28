/* Frozen restart watcher from origin/main before automatic admission existed.
   It intentionally ignores autoGateId, as an already-running launcher does
   after its web child has been updated. Keep this small fixture independent
   of the current launcher's implementation. */
import { existsSync, readFileSync, rmSync } from "node:fs";

const REQUEST_ROLES = new Set(["web", "runtime-host"]);

export function watchRestartRequests(requestFile, handle, { intervalMs = 500 } = {}) {
  let busy = false;
  const poll = async () => {
    if (busy || !existsSync(requestFile)) return;
    let request = null;
    try { request = JSON.parse(readFileSync(requestFile, "utf8")); }
    catch { request = null; }
    rmSync(requestFile, { force: true });
    if (!request || typeof request.requestId !== "string" || !REQUEST_ROLES.has(request.role)) return;
    busy = true;
    try { await handle({ requestId: request.requestId, role: request.role }); }
    finally { busy = false; }
  };
  const timer = setInterval(() => { void poll(); }, intervalMs);
  timer.unref?.();
  return { poll, stop() { clearInterval(timer); } };
}
