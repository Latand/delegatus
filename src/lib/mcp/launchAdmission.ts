import { statePath } from "@/lib/configDir";
import fs from "node:fs";
import { withAccountMutationLockAsync } from "@/lib/accounts/accountMutation";
import { agentRegistry } from "@/lib/agent/registry";
import { recordSpawnAdmissionRejection, readSpawnAdmissionFence } from "@/lib/agent/spawnAdmission";
import { internalServiceClaim } from "@/lib/agent/callerClaims";
import { spawnAdmissionBodyDigest } from "@/lib/agent/spawnIdentity";
import { SqliteMcpReceiptStore, type McpRequestBinding } from "./server";

/** A missing or restored registry cannot prove absence of a past admission. */
export async function expireSpawnAdmission(binding: McpRequestBinding, assertInvocation: () => void, deadlineAt = Date.now() + 5000) {
  const assertAuthority = () => { assertInvocation(); if (Date.now() >= deadlineAt) throw new Error("spawn recovery budget elapsed"); };
  const admission = binding.launchAdmission;
  if (!admission || Date.now() < admission.settleAfter || !admission.registryIdentity) return null;
  return withAccountMutationLockAsync(() => {
    assertAuthority();
    const registry = agentRegistry();
    if (registry.launchAdmissionIdentity() !== admission.registryIdentity) throw new Error("launch admission continuity changed");
    const receipt = registry.spawnReceiptForClientAttempt(binding.downstreamKey) ?? registry.retainedSpawnAdmission(binding.downstreamKey);
    if (receipt) return { kind: "existing-receipt" as const, receipt };
    const result = recordSpawnAdmissionRejection({ clientAttemptId: binding.downstreamKey,
      requestDigest: admission.envelopeDigest, status: 409, error: "launch admission deadline elapsed before reservation" }, () =>
      registry.spawnReceiptForClientAttempt(binding.downstreamKey) ?? registry.retainedSpawnAdmission(binding.downstreamKey), assertAuthority);
    assertAuthority();
    if (result.kind === "fenced") {
      const persisted = readSpawnAdmissionFence(binding.downstreamKey);
      if (!persisted || persisted.requestDigest !== admission.envelopeDigest) throw new Error("launch admission fence could not be verified");
    }
    return result;
  }, { caller: "mcp admission expiry", waitMs: Math.max(0, Math.min(4000, deadlineAt - Date.now())) });
}

/** Resolve the durable binding, never an asserted launcher/header identity.
 * The returned callback is synchronous at reservation and every later effect. */
export async function receivingSpawnAdmission(request: Request, body: Record<string, unknown>): Promise<() => void> {
  // In-process report and relay producers supply headers/json without a URL.
  const required = typeof request.url === "string" && new URL(request.url).pathname === "/api/spawn/admission";
  if (typeof body.clientAttemptId !== "string" || !body.clientAttemptId.startsWith("mcp_spawn_")) {
    if (required) throw new Error("guarded launch requires a durable binding");
    return () => {};
  }
  const filename = statePath("mcp-receipts.sqlite");
  if (!required && !fs.existsSync(filename)) return () => {};
  const store = new SqliteMcpReceiptStore(filename, { busyTimeoutMs: 0, preparedOnly: true });
  let binding: McpRequestBinding | null;
  try { binding = store.lookupLaunch(body.clientAttemptId)?.binding ?? null; }
  finally { store.close(); }
  if (!binding?.launchAdmission) {
    if (required) throw new Error("guarded launch binding is unavailable");
    return () => {}; // Older dispatchers have no expiry eligibility.
  }
  if (!required) throw new Error("guarded launch requires its admission receiver");
  const service = internalServiceClaim(request, { readOnly: true });
  if (service.claim !== "valid" || service.service !== "mcp") throw new Error("launch admission transport refused");
  if (spawnAdmissionBodyDigest(body) !== binding.launchAdmission.envelopeDigest) throw new Error("launch admission envelope changed");
  const { assertLaunchAdmissionCaller } = await import("./bindings");
  const pinned = binding;
  return () => {
    assertLaunchAdmissionCaller(pinned);
    const current = new SqliteMcpReceiptStore(statePath("mcp-receipts.sqlite"), { busyTimeoutMs: 0, preparedOnly: true });
    try {
      const row = current.lookupLaunch(pinned.downstreamKey);
      if (!row?.binding || JSON.stringify(row.binding) !== JSON.stringify(pinned) || row.stage === "not-executed") throw new Error("launch admission claim changed");
    } finally { current.close(); }
    // A prior reservation remains concrete work. The cutoff bounds admission.
    const registry = agentRegistry();
    const receipt = registry.spawnReceiptForClientAttempt(pinned.downstreamKey);
    const retained = registry.retainedSpawnAdmission(pinned.downstreamKey);
    if (retained && (!receipt || receipt.launchId !== retained.launchId)) throw new Error("launch admission is already retained; recover the original key");
    if (!receipt) {
      if (Date.now() >= pinned.launchAdmission!.settleAfter) throw new Error("launch admission deadline elapsed");
    }
  };
}
