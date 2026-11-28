import { missingSetupProcess, REGISTRY_WRITER_BUSY, resolveConversationAlias, setupProcessMayOwn,
  type RegistryFile, type SpawnReceipt } from "@/lib/agent/registry";
import { registryKeysMatching } from "@/lib/agent/sqliteRegistryStore";
import { processIdentityStatus } from "@/lib/processIdentity";
import { readRuntimeSnapshot } from "@/lib/runtime/snapshotReads";
import { readRuntimeSession, type RuntimeHostClient } from "@/lib/runtime/client";

const BEFORE_ADMISSION = "structured spawn interrupted before runtime admission: ";
const SETUP_WRITER_BUSY = `${REGISTRY_WRITER_BUSY} (spawn.setup-custody)`;

export function interruptedStageLaunch(failure: string): "before-admission" | "setup" | null {
  if (failure.includes(BEFORE_ADMISSION)) return "before-admission";
  if (failure.includes(SETUP_WRITER_BUSY) && failure.includes("; exit: signal SIGKILL")) return "setup";
  return null;
}

export function interruptedStageLaunchFailure(attemptError?: string | null, laneDetail?: string | null): string | null {
  if (attemptError && interruptedStageLaunch(attemptError)) return attemptError;
  return laneDetail && interruptedStageLaunch(laneDetail) ? laneDetail : null;
}

/** A setup that got as far as native exec needs confirmed cleanup of the
 * recorded processes. The disappearance of the Viewer alone proves nothing. */
function unstartedStageProcessRefusal(receipt: SpawnReceipt, cut: "before-admission" | "setup",
  failure: string, reconcileCleanup: boolean): string | null {
  if (receipt.admissionOwner && processIdentityStatus(receipt.admissionOwner) !== "dead") {
    return "the original launch still has an admission owner";
  }
  const setup = receipt.hostSetup;
  if (cut === "before-admission") {
    return setup || receipt.hostSetupStartedAt ? "the original launch reached native setup" : null;
  }
  if (!receipt.hostSetupStartedAt || !setup || setup.adoptionClaimEpoch !== undefined) {
    return "native setup custody is unavailable";
  }
  if (setup.execPermitGranted) return "the original setup granted the engine permission to start";
  if (setup.processes.some(setupProcessMayOwn)
    || setup.phase === "executing" && (!setup.processes.length
      || !setup.cleanupConfirmed && (missingSetupProcess(setup) || !(reconcileCleanup && receipt.admissionOwner)))) {
    return "native setup process cleanup is unconfirmed";
  }
  // A retained waiter counts as executing even before it starts the engine.
  // UID mapping is a sandbox setup failure before the engine can write a transcript.
  if (setup.phase === "executing" && !failure.includes("bwrap: setting up uid map")) {
    return "the original setup may have started a native session before it stopped";
  }
  return null;
}

export function unstartedStageLaunchRefusal(file: RegistryFile, receipt: SpawnReceipt, failure: string,
  reconcileCleanup = false): string | null {
  const cut = interruptedStageLaunch(failure);
  if (!cut || receipt.transport !== "structured" || receipt.purpose !== "launch" || receipt.rejection
    || receipt.queuedPinnedSpawn || !["starting", "failed"].includes(receipt.state)
    || cut === "before-admission" && !failure.includes(`${BEFORE_ADMISSION}${receipt.launchId}`)) {
    return "the receipt does not identify an interrupted structured launch";
  }
  if (receipt.key || receipt.artifactPath || receipt.artifactLifecycle === "materialized" || receipt.pane || receipt.verifiedHost
    || resolveConversationAlias(file, receipt.conversationId) !== receipt.conversationId
    || registryKeysMatching(file, "conversationAliases", "alias", receipt.conversationId).length
    || file.conversations[receipt.conversationId]
    || Object.values(file.entries).some(entry => entry.structuredHostOperationId === receipt.launchId)) {
    return "the original launch has session, transcript or host evidence";
  }
  const messageId = `spawn_message_${receipt.launchId}`;
  if (file.deliveryOperationOwners[messageId] || file.deliveryEvidenceCompactions[receipt.conversationId]
    || registryKeysMatching(file, "heldDeliveries", "command.operationId", messageId).length
    || registryKeysMatching(file, "heldDeliveries", "conversationId", receipt.conversationId).length
    || registryKeysMatching(file, "deliveryOperationOwners", "conversationId", receipt.conversationId).length) {
    return "the original launch has durable delivery evidence";
  }
  return unstartedStageProcessRefusal(receipt, cut, failure, reconcileCleanup);
}

/** Absence of a receipt can also mean compaction. Cover the original admission
 * (or the time before it could have happened) in a contiguous retained tail. */
export async function prepublicationStageJournalProof(
  client: RuntimeHostClient, receipt: SpawnReceipt, failure: string, signal: AbortSignal,
): Promise<boolean> {
  const id = receipt.launchId;
  const messageId = `spawn_message_${id}`;
  const cut = interruptedStageLaunch(failure);
  if (!cut) return false;
  const readTarget = () => Promise.all([
    client.operationStatus(id), client.operationStatus(messageId),
    readRuntimeSession(client, { conversationId: receipt.conversationId }),
  ]);
  const [launch, message, session] = await readTarget();
  if (signal.aborted || message !== null) return false;
  if (cut === "before-admission") {
    if (launch !== null || session !== null) return false;
  } else if (!launch || launch.operationId !== id || launch.receipt.operationId !== id
    || launch.receipt.kind !== "spawn" || launch.receipt.conversationId !== receipt.conversationId
    || !["failed", "rejected"].includes(launch.receipt.status)) return false;
  if (cut === "setup" && (interruptedStageLaunch(launch?.receipt.reason ?? "") !== "setup"
    || receipt.hostSetup?.phase === "executing" && !launch?.receipt.reason?.includes("bwrap: setting up uid map"))) return false;
  // Runtime admission files its own placeholder before the native process
  // can provide a session identity. A real session or writer always wins.
  if (session && (session.sessionKey?.engine !== receipt.engine || session.sessionKey?.sessionId !== receipt.conversationId
    || session.artifactPath || session.activeTurnId || session.writerClaim || session.writerStatus
    || session.host !== "dead" || session.turn !== "idle")) return false;

  const snapshot = await readRuntimeSnapshot(client, "metadata");
  let cursor = Math.max(snapshot.retentionFloorSeq, snapshot.snapshotSeq - 4_096);
  let beforeAdmission = cursor === 0;
  let admitted = false;
  let first = true;
  for (let page = 0; page < 64 && cursor < snapshot.snapshotSeq; page++) {
    const previous = cursor;
    const replay = await client.events(cursor, signal);
    if (replay.reset || !replay.events.length || signal.aborted) return false;
    for (const event of replay.events) {
      if (event.seq > snapshot.snapshotSeq) break;
      if (event.seq !== cursor + 1) return false;
      cursor = event.seq;
      if (first) {
        beforeAdmission ||= Date.parse(event.recordedAt) < Date.parse(receipt.createdAt);
        first = false;
      }
      const placeholder = !!launch && event.kind === "session-status" && (
        event.producer.kind === "runtime-host" && event.producer.eventKey === `operation:${id}:session-placeholder`
        || event.producer.kind === "runtime-effect" && event.producer.eventKey === `operation:${id}:spawn-${launch.receipt.status}-session-dead`);
      const sessionEvent = event.scope.type === "session" && event.scope.id === receipt.conversationId;
      if (sessionEvent && !placeholder
        || (event.kind === "turn-started" || event.kind === "turn-ended") && event.payload.conversationId === receipt.conversationId
        || event.scope.type === "operation" && event.scope.id === messageId) return false;
      if (event.scope.type === "operation" && event.scope.id === id) {
        if (!launch) return false;
        if (event.producer.kind === "viewer-command"
          && event.producer.eventKey === `operation:${receipt.conversationId}:${launch.receipt.idempotencyKey}`) admitted = true;
      }
    }
    if (cursor === previous) return false;
  }
  if (signal.aborted || cursor !== snapshot.snapshotSeq || !(launch ? admitted : beforeAdmission)) return false;
  // Replay may yield while a first message or native session is recorded past
  // its watermark. Recheck the original identities before returning proof.
  const [currentLaunch, currentMessage, currentSession] = await readTarget();
  return !signal.aborted && currentMessage === null
    && JSON.stringify(currentLaunch?.receipt) === JSON.stringify(launch?.receipt)
    && JSON.stringify(currentSession) === JSON.stringify(session);
}
