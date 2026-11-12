import { isDeepStrictEqual } from "node:util";
import type { AgentRegistry } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { processIdentityStatus } from "@/lib/processIdentity";
import { assertMemberLaunchAllowed, MEMBER_REVOCATION_HOLD } from "@/lib/team/memberLaunchAuthority";
import { terminateStructuredHostTree } from "./structuredHostControl";

/** Recover only proven-dead setup owners. Keep the original claim and every
 * captured identity until Stop confirms the predecessor's entire tree ended. */
export async function recoverMemberAdoption(registry: AgentRegistry, key: SessionKey,
  assertActive: () => void = () => {}): Promise<boolean> {
  let receipt = registry.spawnReceiptForHost(key);
  if (receipt?.hostSetup?.adoptionClaimEpoch === undefined || receipt.hostSetup.cleanupConfirmed) return true;
  try { assertMemberLaunchAllowed(receipt); }
  catch (error) {
    if (error instanceof Error && error.message === MEMBER_REVOCATION_HOLD) return false;
    throw error;
  }
  const owner = receipt.admissionOwner;
  if (!owner || processIdentityStatus(owner) !== "dead") return false;
  const entry = registry.hostEntry(key);
  const claimEpoch = receipt.hostSetup.adoptionClaimEpoch;
  const check = () => {
    assertActive();
    const current = registry.spawnReceiptForHost(key);
    const bound = registry.hostEntry(key);
    if (!isDeepStrictEqual(current, receipt) || !entry || bound?.claimEpoch !== claimEpoch
      || bound.claimOwner !== entry.claimOwner || !isDeepStrictEqual(bound.structuredHost, entry.structuredHost)
      || processIdentityStatus(owner) !== "dead") throw new Error("member adoption recovery custody changed");
    assertMemberLaunchAllowed(current!);
  };
  check();
  if (receipt.hostSetup.phase === "executing") {
    if (!receipt.hostSetup.processes.length) return false;
    for (const native of [...receipt.hostSetup.processes]) {
      check();
      if (processIdentityStatus(native) === "dead") continue;
      if (!native.startIdentity) return false;
      const stopped = await terminateStructuredHostTree({ kind: "structured", ...native, startIdentity: native.startIdentity,
        bootEpoch: native.bootEpoch ?? null, engine: receipt.engine, sessionId: null, conversationId: receipt.conversationId,
        seat: false, turnBusy: null, owned: false, lastActiveAt: receipt.hostSetupStartedAt ?? null }, {
        stopOrigin: { path: "startup-adoption-cleanup", operationId: sessionKeyId(key) },
        retainedSurvivors: receipt.hostSetup.processes,
        authorize: () => { check(); return null; },
        persistCapturedTree: identities => registry.deliveryWriteOrBusy({ label: "adoption.recovery-tree", operationId: receipt!.launchId }, () => {
          check();
          for (const identity of identities) registry.recordStructuredHostSetup(receipt!.launchId, owner, identity);
          receipt = registry.spawnReceipt(receipt!.launchId)!;
          return true;
        }),
      });
      check();
      if (!stopped.ok) throw new Error(stopped.error);
    }
  }
  await registry.deliveryWriteOrBusy({ label: "adoption.recovery-cleanup", operationId: receipt.launchId }, () => {
    check();
    registry.confirmStructuredHostSetupCleanup(receipt!.launchId, owner);
    if (!registry.releaseStructuredSpawnAdmissionOwner(receipt!.launchId, owner).released)
      throw new Error("member adoption cleanup release is not confirmed");
  });
  assertActive();
  const settled = registry.spawnReceiptForHost(key);
  const bound = registry.hostEntry(key);
  if (!isDeepStrictEqual(settled, { ...receipt, admissionOwner: null,
    hostSetup: { ...receipt.hostSetup, cleanupConfirmed: true } })
    || bound?.claimEpoch !== claimEpoch || bound.claimOwner !== entry!.claimOwner
    || !isDeepStrictEqual(bound.structuredHost, entry!.structuredHost)
    || settled!.hostSetup!.processes.some(native => processIdentityStatus(native) !== "dead"))
    throw new Error("member adoption cleanup is not confirmed");
  return true;
}
