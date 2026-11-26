import net from "node:net";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Covers load preflight, child retirement, host startup (5m), and Viewer
// readiness (startup progress plus a 90-second page/chunk reserve). Build time is outside the switch budget.
export const SWITCH_TIMEOUT_MS = 10 * 60_000;
export const ROLLBACK_TIMEOUT_MS = 10 * 60_000;
export const PROBE_TIMEOUT_MS = 2_000;
export const STOP_TIMEOUT_MS = 10_000;
export const RUNTIME_HOST_STARTUP_CEILING_MS = 300_000;
export const VIEWER_PAGE_CHECK_TIMEOUT_MS = 90_000;
export const TERMINAL_BOOTSTRAP_TIMEOUT_MS = SWITCH_TIMEOUT_MS + ROLLBACK_TIMEOUT_MS + 4 * STOP_TIMEOUT_MS + 30_000;
export const SWITCH_OVERRUN = "The launcher switch exceeded its 10 minute deadline";

export function terminalHealthPublishedBefore(record, switchExpiry) {
  const publishedAt = Date.parse(record?.updatedAt ?? "");
  return Number.isFinite(publishedAt) && publishedAt < switchExpiry;
}

export function rollbackSelectionMatches(selected, rollbackPointer) {
  return rollbackPointer === null ? selected === null
    : typeof rollbackPointer === "string" && selected === rollbackPointer;
}

export function launcherStartupDeadline({ active, switchDeadline, trial, requestId, target, bootstrapDeadline,
  teardownGraceMs, now = Date.now() }) {
  const matches = active && trial?.requestId === requestId && trial.target === target;
  const matchingRollback = matches && trial.state === "rolled-back" && Number.isFinite(trial.rollbackDeadlineAt);
  const phase = matches && trial.refused ? "refused" : matchingRollback ? "rollback" : active ? "switch" : "startup";
  const expiry = phase === "refused" ? now : phase === "rollback" ? trial.rollbackDeadlineAt
    : phase === "switch" ? switchDeadline + teardownGraceMs : bootstrapDeadline;
  const deadline = Math.min(expiry, bootstrapDeadline);
  return { phase, deadline, expired: now >= deadline };
}

function startupSleep(ms, signal) {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      done();
    }
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}

/** @typedef {(ms: number, signal?: AbortSignal) => Promise<void>} StartupSleep */

/** Poll readiness until the child answers, stops advancing or exhausts the
 * absolute monotonic deadline. File evidence may be slow, so let the host
 * check for child exit while its evidence read is pending. The Viewer reports
 * evidence already received on stderr as part of its check. */
/** @param {{ check: (remaining: (at?: number) => number, record: (key: string, value: number, detail: unknown, observedAt?: number) => void) => boolean | { ready: boolean, observedAt: number } | Promise<boolean | { ready: boolean, observedAt: number }>, progress?: () => Array<[string, number, unknown, number?]> | Promise<Array<[string, number, unknown, number?]>>, onTimeout: (detail: { elapsed: number, lastProgress: unknown, silent: number, ceiling: boolean }) => void, deadline: number, silenceMs: number, intervalMs: number, signal?: AbortSignal, now?: () => number, sleep?: StartupSleep, readyMayFinishAfterSilence?: boolean }} options */
export async function waitForStartupProgress({
  check, progress, onTimeout, deadline, silenceMs, intervalMs, signal, readyMayFinishAfterSilence = false,
  now = () => performance.now(), sleep = startupSleep,
}) {
  const started = now();
  let lastProgressAt = started;
  let lastProgress = null;
  const highWater = new Map();
  let pendingProgress = null;
  const remaining = (at = now()) => Math.min(deadline, lastProgressAt + silenceMs) - at;
  const record = (key, value, detail, observedAt = now()) => {
    if (value <= (highWater.get(key) ?? -1)
      || observedAt >= deadline || observedAt > lastProgressAt + silenceMs) return;
    highWater.set(key, value);
    lastProgressAt = Math.max(lastProgressAt, observedAt);
    lastProgress = detail;
  };
  const expired = () => {
    const current = now();
    const ceiling = current >= deadline;
    const silent = current - lastProgressAt;
    if (!ceiling && silent < silenceMs) return false;
    onTimeout({ elapsed: Math.round(current - started), lastProgress, silent: Math.round(silent), ceiling });
    return true;
  };

  while (true) {
    const checked = await check(remaining, record);
    const ready = typeof checked === "boolean" ? checked : checked.ready;
    const readyObservedAt = typeof checked === "boolean" ? now() : checked.observedAt;
    if (ready && readyObservedAt < deadline
      && (readyMayFinishAfterSilence || readyObservedAt <= lastProgressAt + silenceMs)) return true;
    if (now() >= deadline) { expired(); return false; }
    if (!progress) {
      if (expired()) return false;
      await sleep(Math.min(intervalMs, remaining()), signal);
      continue;
    }
    const progressRequestedAt = now();
    pendingProgress ??= Promise.resolve()
      .then(progress)
      .then(observed => ({ observed, progressRequestedAt }), () => ({ observed: [], progressRequestedAt }));
    const sleepController = new AbortController();
    const sleepMs = Math.max(0, Math.min(intervalMs, remaining()));
    let result = await Promise.race([
      pendingProgress,
      sleep(sleepMs, sleepController.signal).then(() => null),
    ]);
    if (result === null) {
      const current = now();
      // A file snapshot requested before the silence edge can finish just
      // after the socket probe's poll timer. Give that owned read one bounded
      // polling interval to report; the absolute ceiling remains strict.
      if (current < deadline && current >= lastProgressAt + silenceMs && pendingProgress) {
        result = await Promise.race([
          pendingProgress,
          sleep(intervalMs, signal).then(() => null),
        ]);
      }
      if (result === null) {
        if (expired()) return false;
        continue;
      }
    }
    sleepController.abort();
    pendingProgress = null;
    // File evidence that completed while the socket check was pending must
    // extend the window before that socket is checked again.
    for (const [key, value, detail, observedAt] of await result.observed) {
      record(key, value, detail, observedAt ?? result.progressRequestedAt);
    }
    // A child may exit during either asynchronous read/probe.
    const readyAfterRead = await check(remaining, record);
    const readyAfterReadAt = typeof readyAfterRead === "boolean" ? now() : readyAfterRead.observedAt;
    const readyAfterReadValue = typeof readyAfterRead === "boolean" ? readyAfterRead : readyAfterRead.ready;
    if (readyAfterReadValue && readyAfterReadAt < deadline
      && (readyMayFinishAfterSilence || readyAfterReadAt <= lastProgressAt + silenceMs)) return true;
    if (now() >= deadline) { expired(); return false; }
    if (expired()) return false;
    await sleep(Math.min(intervalMs, remaining()), signal);
  }
}

export function startupHandoffSucceeded(childPid, childRunning, forwarded, record) {
  return !forwarded && childRunning && Number.isInteger(childPid) && childPid > 0
    && record?.launcher?.pid === childPid
    && typeof record.launcher.startIdentity === "string"
    && record.launcher.startIdentity.length > 0
    && record.launcher.state === "healthy"
    && record.web?.state === "healthy"
    && record.runtimeHost?.state === "healthy";
}

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
