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
