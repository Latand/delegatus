import fs from "node:fs";
import os from "node:os";

const MAX_ERRORS = 5;
const MAX_ERROR_LENGTH = 240;

/** The report keeps full diagnostics; terminal output stays bounded and local. */
export function retentionErrorDetails(errors: readonly string[]): string {
  if (!errors.length) return "";
  const homes = new Set([os.homedir(), process.env.HOME].filter((home): home is string => !!home));
  for (const home of homes) {
    try { homes.add(fs.realpathSync(home)); } catch { /* The home can be absent. */ }
  }
  const details = errors.slice(0, MAX_ERRORS).map(error => {
    let text = error;
    for (const home of [...homes].sort((a, b) => b.length - a.length)) {
      const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(`${escaped}(?=$|[\\\\/\\s'\":,;)])`, "g"), "~");
    }
    // Keep home-relative paths; hide paths outside this home, including procfs.
    text = text.replace(/(?:~[\\/]|[A-Za-z]:[\\/]|\\\\|\/)[^\s'"<>;,)]*/g,
      entry => entry.startsWith("~/") || entry.startsWith("~\\") ? entry.replaceAll("\\", "/") : "<path>");
    text = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim();
    return text.length > MAX_ERROR_LENGTH ? text.slice(0, MAX_ERROR_LENGTH - 1) + "…" : text;
  });
  if (errors.length > MAX_ERRORS) details.push(`… ${errors.length - MAX_ERRORS} more`);
  return `: ${details.join("; ")}`;
}
