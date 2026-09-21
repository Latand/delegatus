import { redactMonitorText } from "@/lib/monitor/redact";
import { ArchiveReadError } from "./reader";

// Classify credential names and credential suffixes at word boundaries. Counts,
// flags and ordinary words (tokenCount, passwordChanged, secretary) stay data.
const SECRET_FIELD = /(?:^|_)(?:tokens?|secrets?|passwords?|passwd|pwd|api_?keys?|authorization|bearer|cookies?|credentials?|private_?keys?|secret_?key|access_?token|refresh_?token|client_?secret)(?:_?(?:value|hash))?$/i;
function sensitiveKey(key: string): boolean {
  const separated = key.replace(/[\s.-]+/g, "_");
  return SECRET_FIELD.test(separated) || SECRET_FIELD.test(separated.replace(/([a-z0-9])([A-Z])/g, "$1_$2"));
}
// Recognize the key before asking for its value: a truncated value must not
// make a sensitive field invisible. Standalone strings can also encode JSON.
const JSON_STRING = /("(?:\\[\s\S]|[^"\\])*(?:"|\\?$))(\s*:\s*)?/g;
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

/** Redact only decoded text or the gaps between quoted tokens. Running this
 * over re-encoded strings would treat JSON escapes as URL/header content. */
function redactPlainText(text: string): string {
  return redactMonitorText(text).replace(/https?:\/\/[^\s<>"'\\]+/g, match => {
    try {
      const url = new URL(match);
      url.username = ""; url.password = "";
      if (url.search) url.search = "?redacted";
      url.hash = "";
      return url.toString();
    } catch { return "[redacted-url]"; }
  });
}

/** Artifact bodies can contain JSON/JSONL inside prose or fenced code. Decode
 * each quoted token before applying all secret rules, then keep its serialized
 * representation opaque to the enclosing pass. Malformed encoded tokens cannot
 * be safely inspected, including a token truncated after its embedded secret. */
function redactStructuredText(text: string, depth = 0): string {
  if (depth > MAX_ENCODED_DEPTH) throw new ArchiveReadError("ARCHIVE_TOO_LARGE", 413);
  // A raw header owns its whole physical line, even when its value has quotes.
  // This also runs on every decoded message before splitting quoted tokens.
  text = text.replace(/(^|\n)([ \t]*(?:(?:proxy-)?authorization|(?:set-)?cookie)[ \t]*:[^\r\n]*)/gi,
    (_match, newline: string, header: string) => newline + redactMonitorText(header));
  const fields = new RegExp(JSON_STRING);
  const parts: string[] = [];
  let copied = 0;
  for (let match; (match = fields.exec(text));) {
    const [, token, separator] = match;
    const prefix = text.slice(copied, match.index);
    // Keep quoted log assignments covered when the outer pass no longer sees
    // the quoted value. Refuse truncation just as for a sensitive JSON field.
    const assignment = /(?:^|[\s{,])([\w.-]+)\s*[:=]\s*$/.exec(prefix);
    if (assignment && sensitiveKey(assignment[1])) {
      quotedValueEnd(text, match.index);
      parts.push(redactPlainText(prefix), '"[redacted]"', separator ?? "");
      copied = fields.lastIndex;
      continue;
    }
    let decoded: string;
    try { decoded = JSON.parse(token); } catch {
      // Simple unmatched/multiline quotation in prose is still ordinary text.
      // Escapes, structured delimiters or a key separator make it ambiguous:
      // never skip a failed decode and export the uninspected encoded contents.
      if (separator || /[\\{\[]/.test(token)) throw new ArchiveReadError("ARCHIVE_UNAVAILABLE", 503);
      parts.push(redactPlainText(prefix), redactPlainText(token));
      copied = fields.lastIndex;
      continue;
    }
    let replacement: string;
    if (separator && sensitiveKey(decoded)) {
      fields.lastIndex = sensitiveValueEnd(text, fields.lastIndex);
      replacement = `${token}${separator}"[redacted]"`;
    } else {
      const redacted = redactStructuredText(decoded, depth + 1);
      replacement = (redacted === decoded ? token : JSON.stringify(redacted)) + (separator ?? "");
    }
    parts.push(redactPlainText(prefix), replacement);
    copied = fields.lastIndex;
  }
  parts.push(redactPlainText(text.slice(copied)));
  return parts.join("");
}

/** The export is private even after best-effort redaction. Preserve original
 * fields and receipt identities; never advertise arbitrary prose as public. */
export function redactArchive(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new ArchiveReadError("ARCHIVE_TOO_LARGE", 413);
  if (typeof value === "string") return redactStructuredText(value);
  if (Array.isArray(value)) return value.map(item => redactArchive(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey(key) ? "[redacted]" : redactArchive(item, depth + 1)]));
  return value;
}
