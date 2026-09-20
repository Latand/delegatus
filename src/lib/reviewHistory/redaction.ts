import { redactMonitorText } from "@/lib/monitor/redact";
import { ArchiveReadError } from "./reader";

const SECRET_FIELD = /(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i;

/** The export is private even after best-effort redaction. Preserve original
 * fields and receipt identities; never advertise arbitrary prose as public. */
export function redactArchive(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new ArchiveReadError("ARCHIVE_TOO_LARGE", 413);
  if (typeof value === "string") return redactMonitorText(value).replace(/https?:\/\/[^\s<>"']+/g, match => {
    try {
      const url = new URL(match);
      url.username = ""; url.password = "";
      if (url.search) url.search = "?redacted";
      url.hash = "";
      return url.toString();
    } catch { return "[redacted-url]"; }
  });
  if (Array.isArray(value)) return value.map(item => redactArchive(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_FIELD.test(key) ? "[redacted]" : redactArchive(item, depth + 1)]));
  return value;
}
