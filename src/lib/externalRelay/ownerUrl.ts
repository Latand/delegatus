import { decodeSensitiveText } from "@/lib/privacy/canonicalText";
import { containsSensitiveAssignment, sensitiveKey } from "@/lib/reviewHistory/redaction";

// Common signed-link, OAuth and session query names outside the shared
// credential vocabulary. Signed links can carry access without a password.
const PRIVATE_PARAMETER = /^(?:auth|code|key|access_key|client_assertion|jwt|oauth_verifier|session(?:_?id)?|sig(?:nature)?|x_(?:amz|goog)_signature)$/i;

export function redactOwnerUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"'\\]+/gi, raw => {
    const suffix = markdownLinkSuffix(raw);
    const destination = raw.slice(0, raw.length - suffix.length);
    const decoded = decodeSensitiveText(destination, false, undefined, true);
    return decoded.error || hasUrlCredentials(destination, decoded.text) ? "[redacted-url]" + suffix : raw;
  });
}

/** A closing Markdown delimiter can follow a bare port or IPv6 address.
 * Balanced parentheses belong to the destination. */
function markdownLinkSuffix(raw: string): string {
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "(") depth++;
    else if (raw[i] === ")") {
      if (depth) depth--;
      else return /^\)+[.,;!?]*$/.test(raw.slice(i)) ? raw.slice(i) : "";
    }
  }
  return "";
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
