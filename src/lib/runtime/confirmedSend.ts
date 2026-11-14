import { MIGRATION_DELIVERY_CANCELLATION_PREFIX } from "@/lib/accounts/migration/intentLiveness";
import { verifyBatchMembership } from "./inboxBatch";
import type { RegistryFile } from "@/lib/agent/registry";

/** Positive recipient evidence for one admitted operation. Canonical UUIDs are
 * durably allocated before reporting delivery unless only observing an existing
 * allocation. Absence, unreadable history and a different key prove nothing;
 * this function never writes input. */
async function legacyConfirmedSend(file: RegistryFile, operationId: string, consumeCanonicalTurn = true,
  preloaded?: { ledger: import("./claudeStreamBrokerHost").FileClaudeDeliveryLedger; states: import("./claudeStreamBrokerHost").ClaudeDeliveryState[] }): Promise<boolean> {
  const owner = file.deliveryOperationOwners[operationId];
  if (!owner || (owner.command?.kind !== "send" && owner.command?.kind !== "steer")) return false;
  if (owner.terminalReason === "delivery-discarded"
    || owner.terminalReason?.startsWith(MIGRATION_DELIVERY_CANCELLATION_PREFIX)) return false;
  const delivery = file.heldDeliveries[owner.deliveryId];
  const conversation = file.conversations[owner.conversationId];
  // The operation owner survives reservation retention and records the
  // generation this attempt targeted, including after a successor is committed.
  const targetGenerationId = owner.targetGenerationId ?? delivery?.generationId;
  const generation = targetGenerationId
    ? conversation?.generations.find((candidate) => candidate.id === targetGenerationId)
    : null;
  if (!conversation || !generation) return false;
  try {
    if (conversation.engine === "codex") {
      if (owner.batchId) return false;
      const text = owner.evidenceText ?? delivery?.text;
      if (text === undefined || text === null) return false;
      const { readCodexConfirmedDelivery } = await import("./codexAppServerHost");
      return Boolean(await readCodexConfirmedDelivery(generation.path, {
        id: operationId, text, contentDigest: owner.contentDigest ?? undefined,
      }));
    }
    if (conversation.engine !== "claude") return false;
    const { FileClaudeDeliveryLedger, readClaudeTranscriptUsers } = await import("./claudeStreamBrokerHost");
    const ledger = preloaded?.ledger ?? new FileClaudeDeliveryLedger();
    let states = preloaded?.states ?? ledger.load(generation.id);
    const entryId = owner.batchId ?? operationId;
    const matches = (state: typeof states[number]) => state.entry.id === entryId
      && (owner.batchId ? verifyBatchMembership(state.entry, operationId, owner.contentDigest)
        : state.entry.contentDigest === owner.contentDigest);
    let target = states.find(matches);
    if (!target) return false;
    const entryDigest = target.entry.contentDigest;
    // A durable echo names the exact operation and payload, even if its runtime
    // transition timed out before that echo arrived.
    if (target.delivered && target.confirmation === "operation-bound" && target.engineMessageId) return true;
    const users = readClaudeTranscriptUsers(generation.path);
    // MCP and Viewer read in separate processes. The transcript read may have
    // overlapped another send's durable echo; allocate from the current ledger.
    states = ledger.load(generation.id);
    target = states.find(matches);
    if (!target || target.entry.contentDigest !== entryDigest) return false;
    if (target.delivered && target.confirmation === "operation-bound" && target.engineMessageId) return true;
    if (states.some(state => state.nativeUnverified)) return false;
    const reserved = new Set(states.flatMap(state => state.native ? [state.native.inputUuid] : []));
    const consumed = new Set(states.filter((state) => state.delivered && state.entry.id !== entryId && state.engineMessageId)
      .map((state) => state.engineMessageId));
    const candidates = users.filter((user) => user.uuid && !user.nativeIdentityInvalid && !consumed.has(user.uuid) && !reserved.has(user.uuid)
      && !user.mergedSendUuids?.some(uuid => reserved.has(uuid)));
    const matchesState = (user: typeof users[number], state: typeof states[number]): boolean => {
      const timestamp = Date.parse(user.timestamp ?? "");
      const queuedAt = Date.parse(state.queuedAt ?? "");
      return Number.isFinite(timestamp) && Number.isFinite(queuedAt) && timestamp >= queuedAt
        && (user.contentDigest === state.entry.contentDigest
          || (state.entry.content.images.length > 0
            && user.imageCount === state.entry.content.images.length
            && user.text === state.entry.content.text));
    };
    const evidenceImageCount = owner.batchId ? target.entry.content.images.length : owner.evidenceImageCount ?? 0;
    const evidenceText = owner.batchId ? target.entry.content.text : owner.evidenceText ?? target.entry.content.text;
    const targetCandidates = candidates.filter((user) => {
      if (target.engineMessageId && target.engineMessageId !== user.uuid) return false;
      const timestamp = Date.parse(user.timestamp ?? "");
      const queuedAt = Date.parse(target.queuedAt ?? "");
      return Number.isFinite(timestamp) && Number.isFinite(queuedAt) && timestamp >= queuedAt
        && (user.contentDigest === entryDigest
          || (evidenceImageCount > 0
            && user.imageCount === evidenceImageCount
            && user.text === evidenceText));
    });
    // Once a verified UUID is allocated, matching copies of that exact turn
    // keep their authority despite later pending sends or transcript replays.
    const allocated = target.delivered && target.confirmation === "inferred" && Boolean(target.engineMessageId);
    if (targetCandidates.length === 0 || (!allocated && targetCandidates.length !== 1)) return false;
    const user = targetCandidates[0]!;
    const matchingStates = states.filter((state) => (!state.delivered || state.entry.id === entryId || state.confirmation === "unverified")
      && (!state.engineMessageId || state.engineMessageId === user.uuid)
      && matchesState(user, state));
    if (allocated || (matchingStates.length === 1 && matchingStates[0]?.entry.id === entryId)) {
      if (consumeCanonicalTurn) {
        if (ledger.confirmDelivered(generation.id, entryId, user.uuid, "inferred") === "refused") return false;
        const current = ledger.load(generation.id);
        const allocation = current.find((state) => state.entry.id === entryId);
        return Boolean(allocation?.delivered && allocation.engineMessageId === user.uuid
          && allocation.confirmation !== "unverified"
          && !current.some((state) => state.entry.id !== entryId && state.delivered && state.engineMessageId === user.uuid));
      }
      return Boolean(target.delivered && target.engineMessageId === user.uuid && target.confirmation !== "unverified");
    }
    // A canonical Claude user turn has no operation key. Content and time
    // cannot distinguish competing sends or duplicate transcript turns.
  } catch {
    // A failed evidence read never becomes a safe resend or a delivered claim.
  }
  return false;
}

/** One reader owns both arrival evidence and its terminal turn association. */
export interface ConfirmedSendEvidence {
  source: "canonical" | "claude-native-result" | "claude-native-input";
  turnId: string | null;
  sessionId?: string;
  inputUuid?: string;
  resultUuid?: string;
}

export async function readConfirmedSendEvidence(file: RegistryFile, operationId: string,
  consumeCanonicalTurn = true): Promise<ConfirmedSendEvidence | null> {
  const owner = file.deliveryOperationOwners[operationId];
  if (!owner || (owner.command?.kind !== "send" && owner.command?.kind !== "steer")
    || owner.terminalReason === "delivery-discarded"
    || owner.terminalReason?.startsWith(MIGRATION_DELIVERY_CANCELLATION_PREFIX)) return null;
  const conversation = file.conversations[owner.conversationId];
  const generationId = owner.targetGenerationId ?? file.heldDeliveries[owner.deliveryId]?.generationId;
  const generation = conversation?.generations.find(candidate => candidate.id === generationId);
  if (!generation) return null;
  if (conversation.engine === "claude") {
    try {
      const { FileClaudeDeliveryLedger } = await import("./claudeStreamBrokerHost");
      const ledger = new FileClaudeDeliveryLedger();
      const states = ledger.load(generation.id);
      let target = states.find(state => state.entry.id === (owner.batchId ?? operationId));
      if (target?.nativeUnverified) return null;
      if (target?.native) {
        if (!target.nativeResult && !(target.delivered && target.nativeAdmissionRestored && target.nativeConsumed?.turnId)) return null;
        const durable = await ledger.loadDurable(generation.id);
        target = durable.find(state => state.entry.id === (owner.batchId ?? operationId));
        if (!target?.native || target.nativeUnverified) return null;
        if (owner.batchId ? !verifyBatchMembership(target.entry, operationId, owner.contentDigest)
          : target.entry.contentDigest !== owner.contentDigest) return null;
        const proof = target.nativeResult;
        if (!proof && target.delivered && target.nativeAdmissionRestored && target.nativeConsumed?.turnId) return {
          source: "claude-native-input", turnId: target.nativeConsumed.turnId,
          sessionId: generation.id, inputUuid: target.native.inputUuid,
        };
        // load() validates session, writer, process and ordered input membership
        // against the persisted intent. A transcript echo alone has no owner.
        return target.delivered && proof && proof.sessionId === generation.id && proof.inputUuids.includes(target.native.inputUuid)
          ? { source: "claude-native-result", turnId: proof.turnId, sessionId: proof.sessionId,
            inputUuid: target.native.inputUuid, resultUuid: proof.resultUuid } : null;
      }
      return await legacyConfirmedSend(file, operationId, consumeCanonicalTurn, { ledger, states }) ? { source: "canonical", turnId: null } : null;
    } catch { return null; }
  }
  return await legacyConfirmedSend(file, operationId, consumeCanonicalTurn) ? { source: "canonical", turnId: null } : null;
}

/** Compatibility for arrival-only observers. This never admits a send. */
export async function confirmedSend(file: RegistryFile, operationId: string, consumeCanonicalTurn = true): Promise<boolean> {
  return Boolean(await readConfirmedSendEvidence(file, operationId, consumeCanonicalTurn));
}
