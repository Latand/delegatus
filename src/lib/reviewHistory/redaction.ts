import { redactMonitorText } from "@/lib/monitor/redact";
import { ArchiveReadError } from "./reader";

// Classify credential names and credential suffixes at word boundaries. Counts,
// flags and ordinary words (tokenCount, passwordChanged, secretary) stay data.
const SECRET_FIELD = /(?:^|_)(?:tokens?|secrets?|passwords?|passwd|pwd|api_?keys?|authorization|bearer|cookies?|credentials?|private_?keys?|secret_?key|access_?token|refresh_?token|client_?secret)(?:_?(?:value|hash))?$/i;
export function sensitiveKey(key: string): boolean {
  const raw = key.replace(/[\s.-]+/g, "_");
  const separated = raw
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  // These credential-adjacent suffixes describe harmless counts and flags.
  if (/(?:^|_)(?:token_count|password_changed)$/i.test(separated)) return false;
  return SECRET_FIELD.test(raw) || SECRET_FIELD.test(separated);
}
// Recognize the key before asking for its value: a truncated value must not
// make a sensitive field invisible. Standalone strings can also encode JSON.
// Apostrophes within words are prose, rather than opening string delimiters.
const FIELD_OR_STRING = /(https?:\/\/[^\s<>"'\\]+)|("(?:\\[\s\S]|[^"\\])*(?:"|\\?$)|(?<![\w])'(?:\\[\s\S]|[^'\\])*(?:'|\\?$))(\s*[:=]\s*)?|\b([\w.-]+(?:[ \t]+[\w.-]+)*)(\s*(?:=|:(?!\/\/))\s*)/g;
const MAX_ENCODED_DEPTH = 8;

function decodeQuoted(token: string): string {
  if (token[0] === '"') return JSON.parse(token);
  if (token.length < 2 || token.at(-1) !== "'") throw new Error("Incomplete quoted text");
  // Convert the single-quoted log convention to JSON without interpreting an
  // escaped apostrophe as the delimiter or losing escaped backslashes.
  const body = token.slice(1, -1).replace(/\\[\s\S]|"/g, part => part === "\\'" ? "'" : part === '"' ? '\\"' : part);
  return JSON.parse(`"${body}"`);
}

function encodeQuoted(text: string, quote: string): string {
  const json = JSON.stringify(text);
  if (quote === '"') return json;
  return "'" + json.slice(1, -1).replace(/\\[\s\S]|'/g, part => part === '\\"' ? '"' : part === "'" ? "\\'" : part) + "'";
}

/** An invalid quoted token can still carry a raw log assignment or a mapping
 * with the opposite quote style. Never send those through the prose fallback. */
function containsSensitiveAssignment(text: string): boolean {
  for (let depth = 0; depth <= MAX_ENCODED_DEPTH; depth++) {
    // Credential suffixes have at most three words, including value/hash.
    // Keep raw prefixes bounded and start at an identifier's edge.
    const keys = /(["'])([^"']+)\1\s*[:=]|(?<![\w.-])([\w.-]+(?:[ \t]+[\w.-]+){0,2})\s*[:=]/g;
    for (let match; (match = keys.exec(text));) {
      if (sensitiveKey(match[2] ?? match[3])) return true;
    }
    const decoded = text.replace(/\\(?:u([a-f\d]{4})|(["'\\]))/gi, (_match, code: string | undefined, escaped: string) => code ? String.fromCharCode(parseInt(code, 16)) : escaped);
    if (decoded === text) return false;
    text = decoded;
  }
  return false;
}

function quotedValueEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    // A physical newline cannot close a log/JSON scalar. Otherwise the opening
    // quote on the next JSONL record could hide this record's truncation.
    if (/[\r\n]/.test(text[i])) return i;
    if (text[i] === "\\") {
      if (/[\r\n]/.test(text[i + 1] ?? "")) return i;
      i++;
    }
    else if (text[i] === text[start]) return i + 1;
  }
  return text.length;
}

function sensitiveValueEnd(text: string, start: number): number {
  if (text[start] === '"' || text[start] === "'") return quotedValueEnd(text, start);
  if (text[start] === "{" || text[start] === "[") return compoundValueEnd(text, start);
  const scalar = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=[ \t]*(?:[,}\]\r\n]|$))/.exec(text.slice(start));
  if (scalar) return start + scalar[0].length;
  // Unknown scalar syntax has no provable value boundary. Discard the rest
  // of its physical line; spaces cannot turn a secret tail back into prose.
  const newline = text.slice(start).search(/[\r\n]/);
  return newline < 0 ? text.length : start + newline;
}

/** Find a complete compound boundary while ignoring quoted delimiters. An
 * incomplete or mismatched credential compound owns the remaining text. */
function compoundValueEnd(text: string, start: number): number {
  const stack: string[] = [];
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === '"' || char === "'") {
      const end = quotedValueEnd(text, i);
      if (text[end - 1] !== char) return text.length;
      i = end - 1;
    }
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) break;
      if (!stack.length) return i + 1;
    }
  }
  // An incomplete compound owns its whole remaining tail, including lines
  // whose nested values no longer carry the outer credential key.
  return text.length;
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
 * representation opaque to the enclosing pass. Discard ambiguous encoded
 * credential tokens, including a token truncated after its embedded secret. */
function redactStructuredText(text: string, depth = 0): string {
  if (depth > MAX_ENCODED_DEPTH) throw new ArchiveReadError("ARCHIVE_TOO_LARGE", 413);
  if (text.includes("\0")) throw new ArchiveReadError("ARCHIVE_UNAVAILABLE", 503);
  // A raw header owns its whole physical line, even when its value has quotes.
  // This also runs on every decoded message before splitting quoted tokens.
  text = text.replace(/(^|\n)([ \t]*(?:(?:proxy-)?authorization|(?:set-)?cookie)[ \t]*:[^\r\n]*)/gi,
    (_match, newline: string, header: string) => newline + redactMonitorText(header));
  const fields = new RegExp(FIELD_OR_STRING);
  const parts: string[] = [];
  let copied = 0;
  for (let match; (match = fields.exec(text));) {
    const [, url, token, separator, plainKey, plainSeparator] = match;
    const prefix = text.slice(copied, match.index);
    if (url) {
      parts.push(redactPlainText(prefix), redactPlainText(url));
      copied = fields.lastIndex;
      continue;
    }
    if (plainKey) {
      let replacement = match[0];
      if (sensitiveKey(plainKey)) {
        const start = fields.lastIndex;
        const quote = text[start] === "'" ? "'" : '"';
        fields.lastIndex = sensitiveValueEnd(text, start);
        const header = /^(?:(?:proxy-)?authorization|(?:set-)?cookie)$/i.test(plainKey)
          && /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", match.index - 1) + 1, match.index));
        replacement = plainKey + plainSeparator + (header ? "[redacted]" : encodeQuoted("[redacted]", quote));
      }
      parts.push(redactPlainText(prefix), sensitiveKey(plainKey) ? replacement : redactPlainText(replacement));
      copied = fields.lastIndex;
      continue;
    }
    let decoded: string;
    try { decoded = decodeQuoted(token); } catch {
      // Simple unmatched/multiline quotation in prose is still ordinary text.
      // Credential assignments or a key separator are ambiguous: discard their
      // uninspected contents. Ordinary escaped quotation stays prose.
      // A lone backslash in quoted prose (for example a regex) does not make
      // that prose JSON. Credential values were already handled above.
      const ambiguous = separator || containsSensitiveAssignment(token);
      parts.push(redactPlainText(prefix), ambiguous ? '"[redacted]"' : redactPlainText(token));
      // An ambiguous token can end at the opening quote of a credential value,
      // even without a key separator. Its same-line remainder has no proven
      // boundary, so discard it along with the invalid token.
      if (ambiguous) {
        const newline = text.slice(fields.lastIndex).search(/[\r\n]/);
        fields.lastIndex = newline < 0 ? text.length : fields.lastIndex + newline;
      }
      copied = fields.lastIndex;
      continue;
    }
    let replacement: string;
    if (separator && sensitiveKey(decoded)) {
      fields.lastIndex = sensitiveValueEnd(text, fields.lastIndex);
      replacement = `${token}${separator}"[redacted]"`;
    } else {
      const redacted = redactStructuredText(decoded, depth + 1);
      replacement = (redacted === decoded ? token : encodeQuoted(redacted, token[0])) + (separator ?? "");
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
