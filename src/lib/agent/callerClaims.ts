import crypto from "node:crypto";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { currentOperatorSpawnCapability, ensureOperatorSpawnCapability, matchesOperatorSpawnCapability } from "@/lib/agent/operatorCapability";

import { INTERNAL_SERVICE_HEADER, internalServiceTagFor } from "../../../bin/internalService.mjs";

/*
 * The two ways a first-party caller names itself, verified (sign-in-and-team
 * §4.2): an agent by its spawn capability, a Viewer process by its internal
 * service tag. Kept free of the agent registry so the proxy can import it
 * without pulling the server graph into its bundle; the registry lookup is
 * installed by the serving Viewer at startup (`installSpawnCapabilityResolver`).
 */

const AGENT_CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const INTERNAL_SERVICE_TAG = /^[a-f0-9]{64}$/;

/** `probe` reads only: the identity gate lets it through for GET and HEAD. */
export const INTERNAL_SERVICES = ["monitor", "mcp", "orchestrator", "controller", "probe"] as const;
export type InternalViewerService = typeof INTERNAL_SERVICES[number];
export { INTERNAL_SERVICE_HEADER };

type Headers = Pick<Request, "headers">;
type CapabilityResolver = (digest: string) => string | null;

const resolverSlot = globalThis as typeof globalThis & { __llvSpawnCapabilityResolver?: CapabilityResolver | null };

/** The serving Viewer installs the registry lookup here once, at startup; tests
    install a stub and `null` removes it. Shared through `globalThis` because the
    proxy is its own bundle. */
export function installSpawnCapabilityResolver(resolver: CapabilityResolver | null): void {
  resolverSlot.__llvSpawnCapabilityResolver = resolver;
}

export function spawnCapabilityDigest(capability: string): string {
  return crypto.createHash("sha256").update(capability).digest("hex");
}

/**
 * Whether the presented spawn capability is a real one: the operator's own
 * (the Viewer's internal spawns carry it) or one the registry issued to a
 * conversation. A value merely shaped like one is `invalid`, and so is every
 * value while no resolver is installed: an unverifiable claim is no claim.
 */
export function agentCapabilityClaim(request: Headers): "absent" | "valid" | "invalid" {
  const capability = request.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim() ?? "";
  if (!capability) return "absent";
  if (!AGENT_CAPABILITY.test(capability)) return "invalid";
  try {
    if (matchesOperatorSpawnCapability(capability)) return "valid";
  } catch {
    /* an unreadable operator key proves nothing either way; the registry may still know it */
  }
  const resolve = resolverSlot.__llvSpawnCapabilityResolver;
  if (!resolve) return "invalid";
  try {
    return resolve(spawnCapabilityDigest(capability)) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

function internalServiceTag(service: InternalViewerService, key: string): string {
  return internalServiceTagFor(key, service);
}

/** A server-verifiable lane marker for Viewer-owned HTTP producers. */
export function internalServiceHeaders(service: InternalViewerService): Record<string, string> {
  return { [INTERNAL_SERVICE_HEADER]: `${service}.${internalServiceTag(service, ensureOperatorSpawnCapability())}` };
}

/** The same marker when the operator key already exists, and none otherwise:
    for a caller that must not create the key, such as a read. Without the key
    no tag could be verified anyway. */
export function existingInternalServiceHeaders(service: InternalViewerService): Record<string, string> {
  const key = currentOperatorSpawnCapability();
  return key ? { [INTERNAL_SERVICE_HEADER]: `${service}.${internalServiceTag(service, key)}` } : {};
}

export type InternalServiceClaim =
  | { claim: "absent" }
  | { claim: "invalid" }
  | { claim: "valid"; service: InternalViewerService };

/**
 * Checks the tag against the key on disk. `readOnly` never creates the key —
 * the proxy's mode, where a missing key simply means no tag can be valid.
 */
export function internalServiceClaim(request: Headers, options: { readOnly?: boolean } = {}): InternalServiceClaim {
  const value = request.headers.get(INTERNAL_SERVICE_HEADER)?.trim() ?? "";
  if (!value) return { claim: "absent" };
  const separator = value.indexOf(".");
  const service = value.slice(0, separator) as InternalViewerService;
  const tag = value.slice(separator + 1);
  if (separator < 0 || !(INTERNAL_SERVICES as readonly string[]).includes(service) || !INTERNAL_SERVICE_TAG.test(tag)) {
    return { claim: "invalid" };
  }
  try {
    const key = options.readOnly ? currentOperatorSpawnCapability() : ensureOperatorSpawnCapability();
    if (!key) return { claim: "invalid" };
    const expected = internalServiceTag(service, key);
    return crypto.timingSafeEqual(Buffer.from(tag), Buffer.from(expected)) ? { claim: "valid", service } : { claim: "invalid" };
  } catch {
    return { claim: "invalid" };
  }
}
