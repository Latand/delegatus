import { redactMonitorText } from "@/lib/monitor/redact";
import { ArchiveReadError } from "./reader";

const SECRET_FIELD = /(?:token|secret|password|passwd|pwd|api[_-]?key|authorization|bearer|cookie|credential|private[_-]?key)/i;
// Recognize the key before asking for its value: a truncated value must not
// make a sensitive field invisible. Standalone strings can also encode JSON.
const JSON_STRING = /("(?:\\[\s\S]|[^"\\])*")(\s*:\s*)?/g;
const MAX_ENCODED_DEPTH = 8;

function quotedValueEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  throw new ArchiveReadError("ARCHIVE_UNAVAILABLE", 503);
}

function sensitiveValueEnd(text: string, start: number): number {
  if (text[start] === '"') return quotedValueEnd(text, start);
  if (text[start] === "{" || text[start] === "[") return compoundValueEnd(text, start);
  const scalar = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=[\s,}\]]|$)/.exec(text.slice(start));
  if (scalar) return start + scalar[0].length;
  throw new ArchiveReadError("ARCHIVE_UNAVAILABLE", 503);
}

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
 * credential suffix survives. Decode strings at a bounded depth to inspect
 * serialized log messages; only re-encode strings whose contents changed. */
function redactStructuredText(text: string, depth = 0): string {
  if (depth > MAX_ENCODED_DEPTH) throw new ArchiveReadError("ARCHIVE_TOO_LARGE", 413);
  const fields = new RegExp(JSON_STRING);
  const parts: string[] = [];
  let copied = 0;
  for (let match; (match = fields.exec(text));) {
    const [, token, separator] = match;
    let decoded: string;
    try { decoded = JSON.parse(token); } catch {
      // Ordinary quoted prose need not be JSON; still check a malformed key.
      if (!separator || !SECRET_FIELD.test(token)) continue;
      decoded = token;
    }
    let replacement: string;
    if (separator && SECRET_FIELD.test(decoded)) {
      fields.lastIndex = sensitiveValueEnd(text, fields.lastIndex);
      replacement = `${token}${separator}"[redacted]"`;
    } else {
      const redacted = redactStructuredText(decoded, depth + 1);
      if (redacted === decoded) continue;
      replacement = JSON.stringify(redacted) + (separator ?? "");
    }
    parts.push(text.slice(copied, match.index), replacement);
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
