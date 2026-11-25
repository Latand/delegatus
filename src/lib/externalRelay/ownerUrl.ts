import { decodeSensitiveText } from "@/lib/privacy/canonicalText";
import { containsSensitiveAssignment, sensitiveKey } from "@/lib/reviewHistory/redaction";

// Common signed-link, OAuth and session query names outside the shared
// credential vocabulary. Signed links can carry access without a password.
const PRIVATE_PARAMETER = /^(?:auth|code|key|access_key|client_assertion|jwt|oauth_verifier|session(?:_?id)?|sig(?:nature)?|x_(?:amz|goog)_signature)$/i;

export function redactOwnerUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"'\\]+/gi, raw => {
    const decoded = decodeSensitiveText(raw, false, undefined, true);
    if (!decoded.error && !hasUrlCredentials(raw, decoded.text)) return raw;
    // Keep any Markdown link delimiter or prose punctuation that the scanner
    // included. Balanced parentheses can be part of the destination itself.
    let depth = 0;
    let closing = raw.length;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "(") depth++;
      else if (raw[i] === ")") {
        if (depth) depth--;
        else { closing = i; break; }
      }
    }
    const suffix = raw.slice(closing).match(/^\)+[.,;!?]*/)?.[0] ?? "";
    return "[redacted-url]" + suffix;
  });
}

function hasUrlCredentials(raw: string, decoded: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return true;
  } catch { return true; }
  if (/https?:\/\/[^/?#\s]*@/i.test(decoded) || containsSensitiveAssignment(decoded)) return true;
  for (const [, name] of decoded.matchAll(/[?&#;]([^?&#;=]+)=/g)) {
    const key = name.replace(/\+/g, " ").trim().split("[", 1)[0]!;
    if (sensitiveKey(key) || PRIVATE_PARAMETER.test(key.replace(/[ .-]+/g, "_"))) return true;
  }
  return false;
}
