import { execFile } from "node:child_process";
import { join } from "node:path";

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
