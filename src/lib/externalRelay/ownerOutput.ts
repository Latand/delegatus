import { hardenedRedact } from "@/lib/view/compactText";
import { redactArchive } from "@/lib/reviewHistory/redaction";
import { decodeSensitiveText } from "@/lib/privacy/canonicalText";
import { knownProviderSecretOffset } from "@/lib/accounts/providerSecretRedaction";
import { currentOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { existingInternalServiceHeaders, INTERNAL_SERVICES } from "@/lib/agent/callerClaims";
import { readRelayStore } from "./store";
import { viewerBootGateKey } from "../../../bin/viewerGateKey.mjs";

/** Owner-only egress boundary. Never log its input or a redaction failure. */
export function scrubOwnerOutput(text: string, credentials: readonly string[] = []): string {
  const store = readRelayStore();
  const known = [currentOperatorSpawnCapability(), viewerBootGateKey(process.env), process.env.LLV_SPAWN_CAPABILITY, ...credentials,
    ...store.relays.map(r => r.credential), ...store.pending.flatMap(p => [p.poll_secret, p.code]),
    ...INTERNAL_SERVICES.flatMap(service => Object.values(existingInternalServiceHeaders(service)).flatMap(value => [value, value.slice(value.indexOf(".") + 1)])),
  ].filter((value): value is string => !!value).sort((a, b) => b.length - a.length);
  // Replace exact values first: generic filters must not leave a fragment of one.
  let clean = text;
  for (const value of known) clean = clean.split(value).join("[redacted]");
  // Check known values before any pattern can cut an encoded value into parts.
  const decoded = decodeSensitiveText(clean, false, undefined, true);
  if (decoded.error || known.some(value => decoded.text.includes(value))
    || knownProviderSecretOffset(decoded.text) >= 0) return "[redacted]";
  // A raw pattern may match only a suffix of an encoded credential. Require
  // its result to agree with redacting the original decoded input in full.
  const expectedCredentials = scrubOwnerCredentials(decoded.text);
  clean = scrubOwnerCredentials(clean);
  // Credential checks precede path replacement: an encoded suffix can look
  // like a path while leaving most of an opaque token visible.
  const decodedCredentials = decodeSensitiveText(clean, false, undefined, true);
  if (decodedCredentials.error || decodedCredentials.text !== expectedCredentials
    || scrubOwnerCredentials(decodedCredentials.text) !== decodedCredentials.text) return "[redacted]";
  // The shared structured sanitizer recognizes credential field names, decodes
  // JSON inside quoted strings, and refuses incomplete sensitive values. It
  // also shapes paths, so all credential checks must precede this call.
  clean = scrubOwnerText(redactArchive(clean) as string);
  // Inspect the shared decoded view without rewriting the answer's formatting.
  // Apply every egress rule, including retained provider fingerprints, to that
  // view. A recoverable secret or undecidable encoding withholds the output.
  const decodedOutput = decodeSensitiveText(clean, false, undefined, true);
  if (decodedOutput.error || scrubOwnerText(decodedOutput.text) !== decodedOutput.text) return "[redacted]";
  return clean;
}

function scrubOwnerCredentials(text: string): string {
  return hardenedRedact(text
    // Spawn capabilities and pairing credentials are opaque base64url values.
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, "[redacted]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted]"))
    // Cover armor whose header or footer was cut by an upstream length limit.
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-{0,5}[\s\S]*(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, "[redacted]")
    // A bounded error can embed an unfinished opener in JSON or an Error stack.
    .replace(/-----BEGIN(?: [A-Z ]*)?-{0,4}(?=$|[\r\n"'\\])/g, "[redacted]");
}

function scrubOwnerText(text: string): string {
  return scrubOwnerCredentials(text)
    // Absolute POSIX, home-relative, file URI, drive and UNC paths, including
    // escaped spaces. Ordinary web URLs keep their paths.
    .replace(/file:\/\/[^\s<>"'`]+/gi, "[path]")
    .replace(/(?<![\w:])(?:[A-Za-z]:[\\/]|\\\\)[^\r\n<>"'`]+/g, "[path]")
    .replace(/(?<![\w:/])(?:~(?:[A-Za-z0-9_-]+)?\/|\/)(?:\\ |[^\s<>"'`])+/g, "[path]");
}
