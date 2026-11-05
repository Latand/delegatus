import net from "node:net";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Covers load preflight, child retirement, host startup (5m), and Viewer
// readiness (90s + 90s). Build time is outside the switch budget.
export const SWITCH_TIMEOUT_MS = 10 * 60_000;
export const ROLLBACK_TIMEOUT_MS = 10 * 60_000;
export const PROBE_TIMEOUT_MS = 2_000;
export const STOP_TIMEOUT_MS = 10_000;
export const RUNTIME_HOST_STARTUP_CEILING_MS = 300_000;
export const TERMINAL_BOOTSTRAP_TIMEOUT_MS = 2 * (RUNTIME_HOST_STARTUP_CEILING_MS + 90_000 + 90_000) + 30_000;
export const SWITCH_OVERRUN = "The launcher switch exceeded its 10 minute deadline";

/** Shared by the launcher and its guard, which can outlive an exec to an old entry. */
export function writeLauncherRefusal(paths, trial, detail) {
  if (trial.switchOverrun && !detail.includes(trial.switchOverrun)) detail = `${trial.switchOverrun}; ${detail}`;
  const refused = { ...trial, detail, refused: true };
  const read = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
  const atomic = (file, value) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 }); renameSync(temporary, file);
  };
  const directory = dirname(paths.request), applyFile = join(directory, "apply.json"), apply = read(applyFile);
  if (apply?.requestId === trial.requestId && apply.target === trial.target && ["switching", "done"].includes(apply.state)) {
    atomic(applyFile, { ...apply, state: "failed", rolledBack: false, switchOverrun: trial.switchOverrun, detail });
    const ledgerFile = join(directory, "deployments.json"), rows = read(ledgerFile);
    if (Array.isArray(rows)) {
      const row = rows.find(row => row.deploymentId === apply.deploymentId);
      if (row) {
        Object.assign(row, { phase: "failed", terminal: true, error: detail,
          updatedAt: new Date().toISOString(), revisionNumber: row.revisionNumber + 1 });
        atomic(ledgerFile, rows);
      }
    }
    for (const [file, id] of [[join(directory, "auto-drain.json"), apply.requestId],
      [join(directory, "auto-admission.json"), apply.autoGateId]]) {
      if (id && read(file)?.id === id) rmSync(file, { force: true });
    }
    if (read(paths.request)?.requestId === apply.requestId) rmSync(paths.request, { force: true });
  }
  // A cold start discards this marker only after the apply carries its reason.
  // The Viewer's existing recovery reader repairs an interrupted ledger write.
  atomic(paths.trial, refused);
  return refused;
}

export function switchDeadline(intent, now = Date.now()) {
  if (Number.isFinite(intent?.switchDeadlineAt)) return intent.switchDeadlineAt;
  const started = Date.parse(intent?.switchedAt ?? intent?.at ?? "");
  return (Number.isFinite(started) ? started : now) + SWITCH_TIMEOUT_MS;
}

export async function boundedWait(pending, milliseconds, detail) {
  let timer;
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(detail)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** A temporary listener owns only its own sockets, including late accepts. */
export function probeBind(options, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const abort = new AbortController();
    let settled = false;
    const server = net.createServer(socket => {
      socket.on("error", () => {});
      socket.destroy();
    });
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort.abort();
      server.close(() => {});
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(Object.assign(new Error("Launcher port probe timed out"), { code: "ETIMEDOUT" })), timeoutMs);
    server.on("error", finish);
    // close also runs if a delayed DNS/listen callback arrives after expiry.
    server.on("listening", () => server.close(error => finish(error)));
    try { server.listen({ ...options, signal: abort.signal }); }
    catch (error) { finish(error); }
  });
}
