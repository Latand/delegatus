import { hardenedRedact } from "@/lib/view/compactText";
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
  return hardenedRedact(clean)
    // Spawn capabilities and pairing credentials are opaque base64url values.
    .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, "[redacted]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")
    // Cover armor whose header or footer was cut by an upstream length limit.
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-{0,5}[\s\S]*(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, "[redacted]")
    // A bounded error can embed an unfinished opener in JSON or an Error stack.
    .replace(/-----BEGIN(?: [A-Z ]*)?-{0,4}(?=$|[\r\n"'\\])/g, "[redacted]")
    // Absolute POSIX, home-relative, file URI, drive and UNC paths, including
    // escaped spaces. Ordinary web URLs keep their paths.
    .replace(/file:\/\/[^\s<>"'`]+/gi, "[path]")
    .replace(/(?<![\w:])(?:[A-Za-z]:[\\/]|\\\\)[^\r\n<>"'`]+/g, "[path]")
    .replace(/(?<![\w:/])(?:~(?:[A-Za-z0-9_-]+)?\/|\/)(?:\\ |[^\s<>"'`])+/g, "[path]");
}
