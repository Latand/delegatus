import crypto from "node:crypto";
import type { McpRequestBinding } from "./server";

export const CONTROL_REQUEST_HEADER = "x-delegatus-mcp-request";
export const CONTROL_RECOVERY_PATH = "/api/internal/mcp-request";
export const EVIDENCE_LIMIT = 2048;
export const EVIDENCE_TTL_MS = 24 * 60 * 60_000;
export const OUTCOME_LIMIT = 16_384;

/** The saved binding reconstructs this id after a process restart. Every
 * component is server-derived; the header exposes only a timestamp and hash. */
export function controlRequestId(binding?: McpRequestBinding, pathname = ""): string {
  const at = binding ? Date.parse(binding.claimedAt) : Date.now();
  const identity = binding ? JSON.stringify([binding.toolName, binding.clientRequestId, binding.downstreamKey,
    binding.claimedAt, binding.claimGeneration ?? null, binding.owner?.pid, binding.owner?.startIdentity,
    binding.owner?.bootEpoch ?? null, binding.caller?.kind, binding.caller?.conversationId, binding.caller?.project, pathname]) : crypto.randomUUID();
  return `${at}-${crypto.createHash("sha256").update(identity).digest("hex")}`;
}

export function requestTime(id: string): number | null {
  const match = /^(\d{13})-([a-f0-9]{64})$/.exec(id);
  return match ? Number(match[1]) : null;
}
