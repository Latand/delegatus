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

// asuser selects the bootstrap/audit context; sudo separately drops credentials.
// Keep both steps for the fresh standard account, including its child servers.
export function smokeUserArguments({ uid, user, home }, command, args = [], environment = {}) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !user || !home.startsWith("/")) {
    throw new Error("Invalid smoke account context");
  }
  return ["-n", "/bin/launchctl", "asuser", String(uid), "/usr/bin/sudo", "-n", "-u", user, "-H",
    "/usr/bin/env", "-i", ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    `HOME=${home}`, `USER=${user}`, `LOGNAME=${user}`,
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "DELEGATUS_TELEMETRY=0",
    command, ...args];
}
