import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

export function appLogs(caseHome, pid) {
  const directory = join(caseHome, "Library/Logs/Delegatus");
  try {
    return readdirSync(directory).filter(name => name.startsWith("app-") && name.endsWith(pid === undefined ? ".log" : `-${Number(pid)}.log`)).sort()
      .map(name => readFileSync(join(directory, name), "utf8")).join("");
  } catch { return ""; }
}

// Ready captures can precede the web page's first paint. Reuse evidence must
// include the capture scheduled after navigation, in that case's directory.
export function hasRenderedEvidence(frameNames, label) {
  const prefix = `${label}/`.toLowerCase();
  return frameNames.some(name => name.toLowerCase().startsWith(prefix) &&
    (label.startsWith("reuse-") ? /^\d+-page\.png$/.test(name.slice(prefix.length)) : name.endsWith(".png")));
}

export function exited(child) { return child.exitCode !== null || child.signalCode !== null; }
export function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

export function processCensus(pids) {
  return [...pids].sort((a, b) => a - b).map(pid => ({ pid, running: alive(pid) }));
}

// A window can exit while its launcher still writes through the filter. Keep
// that reader alive until the recorded writer exits, including across reuse.
export async function reapEvidenceFilters({ evidenceFilters, until, run, requireStopped = false }) {
  for (const [filterPID, launcherPID] of evidenceFilters) {
    if (!alive(filterPID)) { evidenceFilters.delete(filterPID); continue; }
    if (launcherPID && alive(launcherPID)) {
      assert(!requireStopped, `recorded launcher PID ${launcherPID} must exit before evidence filter cleanup`);
      continue;
    }
    let command;
    try { command = run("/bin/ps", ["-ww", "-p", String(filterPID), "-o", "command="]).trim(); }
    catch (error) { if (alive(filterPID)) throw error; }
    if (alive(filterPID)) {
      assert(/^(?:\/\S*\/)?sed(?:\s|$)/.test(command ?? "") && command.includes(" -l "), `recorded evidence filter PID ${filterPID} belongs to this app fixture`);
      try { process.kill(filterPID, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await until("owned evidence filter exit", () => !alive(filterPID));
    }
    evidenceFilters.delete(filterPID);
  }
}

export async function end(entry, { owned, until, run, cleanupPIDs, evidenceFilters }) {
  const child = owned.get(entry?.pid);
  if (!child) return;
  if (!exited(child)) child.kill("SIGTERM");
  await until("owned process exit", () => exited(child));
  owned.delete(entry.pid);
  // Read the settled app log: the launcher may have started just before exit.
  if (entry.process === child) {
    const log = appLogs(entry.home, entry.pid);
    const filterPID = Number(log.match(/EVIDENCE-FILTER pid (\d+)/)?.[1]);
    const launcherPID = Number(log.match(/APP-LAUNCHER pid (\d+)/)?.[1]);
    if (Number.isSafeInteger(filterPID) && filterPID > 1) {
      cleanupPIDs?.add(filterPID);
      evidenceFilters.set(filterPID, Number.isSafeInteger(launcherPID) && launcherPID > 1 ? launcherPID : undefined);
    }
  }
  await reapEvidenceFilters({ evidenceFilters, until, run });
}

export function intelIsTranslated({ status, stdout = "", stderr = "" }) {
  if (status === 0) {
    const value = String(stdout).trim();
    if (value === "0") return false;
    if (value === "1") return true;
    throw new Error(`Unexpected sysctl.proc_translated value: ${value || "(empty)"}`);
  }
  const message = String(stderr).trim();
  const namesTranslationKey = /sysctl\.proc_translated/i.test(message);
  const missingKey = /unknown oid|no such (?:file|oid)|not found/i.test(message);
  if (status === 1 && namesTranslationKey && missingKey) return false;
  throw new Error(`sysctl.proc_translated failed (${status}): ${message || "(no diagnostic)"}`);
}

/** @returns {["ignore" | "pipe", "pipe", "pipe"]} */
export function smokeStdio(input) {
  return [input === undefined ? "ignore" : "pipe", "pipe", "pipe"];
}

// Every process the smoke starts runs as the runner user, inside the runner's
// one graphical session, so the app reaches the window server. Isolation is
// the data: each case names its own fresh home and inherits nothing else.
/** @returns {Record<string, string>} */
export function smokeEnvironment({ user, home }, settings = {}) {
  if (!user || typeof home !== "string" || !home.startsWith("/")) throw new Error("Invalid smoke session context");
  return {
    ...settings,
    HOME: home, USER: user, LOGNAME: user,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", DELEGATUS_TELEMETRY: "0",
  };
}

// AppKit and WebKit keep these under the session user's own home, whatever
// HOME says. The smoke removes them before each launch so no case reads
// preferences, restored windows or web data an earlier case left.
export function appSessionData(runnerHome, bundle) {
  if (typeof runnerHome !== "string" || !runnerHome.startsWith("/") || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundle ?? "")) {
    throw new Error("Invalid app session data owner");
  }
  return [
    `Library/Preferences/${bundle}.plist`,
    `Library/Saved Application State/${bundle}.savedState`,
    `Library/WebKit/${bundle}`,
    `Library/Caches/${bundle}`,
    `Library/HTTPStorages/${bundle}`,
    `Library/HTTPStorages/${bundle}.binarycookies`,
  ].map(path => join(runnerHome, path));
}

// macOS spells one file /tmp/... and /private/tmp/... (also /var and /etc).
// Process rows and expected paths compare in one spelling.
/** @param {string} text */
export function comparablePath(text) {
  return String(text).replace(/(^|\s)\/private\/(tmp|var|etc)\//g, "$1/$2/");
}

// A failed command keeps everything it said: exit, signal, Node's error code
// (ENOBUFS when output outgrew the buffer) and both streams.
/** @param {string} command @param {{ status?: number | null, signal?: string | null, code?: unknown, stdout?: unknown, stderr?: unknown, message?: string }} error */
export function commandFailure(command, error) {
  const head = [`${command} exited ${error?.status ?? 1}`];
  if (error?.signal) head.push(`signal ${error.signal}`);
  if (typeof error?.code === "string") head.push(`(${error.code})`);
  const stderr = String(error?.stderr ?? "").trim();
  const stdout = String(error?.stdout ?? "").trim();
  const message = !stderr && !stdout && error?.message ? `; ${error.message}` : "";
  return `${head.join(" ")}: stderr: ${stderr || "(empty)"}; stdout tail: ${stdout ? stdout.slice(-4000) : "(empty)"}${message}`;
}

// Runs a command while the driver's event loop keeps turning. `stop --all`
// waits until the launcher it signalled is gone; when that launcher is the
// driver's own child, only the driver's event loop can reap it, and a
// synchronous call would leave it a zombie that still answers as running.
// Resolves with stdout; rejects with the exit status, signal, Node code and
// both streams that commandFailure reports.
/** @param {string} command @param {string[]} args @param {{ env?: Record<string, string>, timeout?: number, maxBuffer?: number }} [options] @returns {Promise<string>} */
export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (!error) { resolve(stdout); return; }
      const exitCode = /** @type {{ code?: unknown }} */ (error).code;
      reject(Object.assign(error, {
        status: typeof exitCode === "number" ? exitCode : null,
        code: typeof exitCode === "string" ? exitCode : undefined,
        stdout, stderr,
      }));
    });
    child.stdin?.end();
  });
}

// Returns the window message independently of earlier diagnostic observations.
export function plainFailureMessage(log) {
  if (!log.includes("STATE failed")) throw new Error("Missing failure state");
  const message = log.split("STATE failed").at(-1).split("CAPTURED")[0].trim();
  if (!message) throw new Error("Missing failure message");
  if (/HEAD \d|PROBE |LISTENER |START timed out/.test(message)) throw new Error("Technical failure message");
  return message;
}
