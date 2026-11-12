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
