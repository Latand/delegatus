import { redactMonitorText } from "@/lib/monitor/redact";
import { ArchiveReadError } from "./reader";

const SECRET_FIELD = /(?:token|secret|password|passwd|pwd|api[_-]?key|authorization|bearer|cookie|credential|private[_-]?key)/i;
const JSON_FIELD = /("(?:\\.|[^"\\])*")(\s*:\s*)("(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[\[{])/g;

/** Find the whole compound value, ignoring delimiters inside JSON strings.
 * Refuse a truncated or mismatched sensitive value rather than export its tail. */
function compoundValueEnd(text: string, start: number): number {
  const stack: string[] = [];
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === "\\") i++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) break;
      if (!stack.length) return i + 1;
    }
  }
  throw new ArchiveReadError("ARCHIVE_UNAVAILABLE", 503);
}

/** Artifact bodies can contain JSON/JSONL inside prose or fenced code. Match
 * complete values, including nested objects/arrays and escaped quotes, so no
 * credential suffix survives. Keep unrelated text byte-for-byte. */
function redactStructuredText(text: string): string {
  const fields = new RegExp(JSON_FIELD);
  const parts: string[] = [];
  let copied = 0;
  for (let match; (match = fields.exec(text));) {
    const [, key, separator, value] = match;
    let field = key;
    try { field = JSON.parse(key); } catch { /* Malformed keys still get the literal field check. */ }
    if (!SECRET_FIELD.test(field)) continue;
    if (value === "{" || value === "[") fields.lastIndex = compoundValueEnd(text, fields.lastIndex - 1);
    parts.push(text.slice(copied, match.index), `${key}${separator}"[redacted]"`);
    copied = fields.lastIndex;
  }
  parts.push(text.slice(copied));
  return parts.join("");
}

/** The export is private even after best-effort redaction. Preserve original
 * fields and receipt identities; never advertise arbitrary prose as public. */
export function redactArchive(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new ArchiveReadError("ARCHIVE_TOO_LARGE", 413);
  if (typeof value === "string") return redactMonitorText(redactStructuredText(value)).replace(/https?:\/\/[^\s<>"']+/g, match => {
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
