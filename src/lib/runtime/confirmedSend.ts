import { MIGRATION_DELIVERY_CANCELLATION_PREFIX } from "@/lib/accounts/migration/intentLiveness";
import type { RegistryFile } from "@/lib/agent/registry";

/** Positive recipient evidence for one admitted operation. Canonical UUIDs are
 * durably allocated before reporting delivery unless only observing an existing
 * allocation. Absence, unreadable history and a different key prove nothing;
 * this function never writes input. */
export async function confirmedSend(file: RegistryFile, operationId: string, consumeCanonicalTurn = true): Promise<boolean> {
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
      const text = owner.evidenceText ?? delivery?.text;
      if (text === undefined || text === null) return false;
      const { readCodexConfirmedDelivery } = await import("./codexAppServerHost");
      return Boolean(await readCodexConfirmedDelivery(generation.path, {
        id: operationId, text, contentDigest: owner.contentDigest ?? undefined,
      }));
    }
    if (conversation.engine !== "claude") return false;
    const { FileClaudeDeliveryLedger, readClaudeTranscriptUsers } = await import("./claudeStreamBrokerHost");
    const ledger = new FileClaudeDeliveryLedger();
    let states = ledger.load(generation.id);
    let target = states.find((state) => state.entry.id === operationId);
    if (!target || target.entry.contentDigest !== owner.contentDigest) return false;
    // A durable echo names the exact operation and payload, even if its runtime
    // transition timed out before that echo arrived.
    if (target.delivered && target.confirmation === "operation-bound" && target.engineMessageId) return true;
    const users = readClaudeTranscriptUsers(generation.path);
    // MCP and Viewer read in separate processes. The transcript read may have
    // overlapped another send's durable echo; allocate from the current ledger.
    states = ledger.load(generation.id);
    target = states.find((state) => state.entry.id === operationId);
    if (!target || target.entry.contentDigest !== owner.contentDigest) return false;
    if (target.delivered && target.confirmation === "operation-bound" && target.engineMessageId) return true;
    const consumed = new Set(states.filter((state) => state.delivered && state.entry.id !== operationId && state.engineMessageId)
      .map((state) => state.engineMessageId));
    const candidates = users.filter((user) => user.uuid && !consumed.has(user.uuid));
    const matchesState = (user: typeof users[number], state: typeof states[number]): boolean => {
      const timestamp = Date.parse(user.timestamp ?? "");
      const queuedAt = Date.parse(state.queuedAt ?? "");
      return Number.isFinite(timestamp) && Number.isFinite(queuedAt) && timestamp >= queuedAt
        && (user.contentDigest === state.entry.contentDigest
          || (state.entry.content.images.length > 0
            && user.imageCount === state.entry.content.images.length
            && user.text === state.entry.content.text));
    };
    const targetCandidates = candidates.filter((user) => {
      if (target.engineMessageId && target.engineMessageId !== user.uuid) return false;
      const timestamp = Date.parse(user.timestamp ?? "");
      const queuedAt = Date.parse(target.queuedAt ?? "");
      return Number.isFinite(timestamp) && Number.isFinite(queuedAt) && timestamp >= queuedAt
        && (user.contentDigest === owner.contentDigest
          || ((owner.evidenceImageCount ?? 0) > 0
            && user.imageCount === owner.evidenceImageCount
            && user.text === (owner.evidenceText ?? target.entry.content.text)));
    });
    // Once a verified UUID is allocated, matching copies of that exact turn
    // keep their authority despite later pending sends or transcript replays.
    const allocated = target.delivered && target.confirmation === "inferred" && Boolean(target.engineMessageId);
    if (targetCandidates.length === 0 || (!allocated && targetCandidates.length !== 1)) return false;
    const user = targetCandidates[0]!;
    const matchingStates = states.filter((state) => (!state.delivered || state.entry.id === operationId || state.confirmation === "unverified")
      && (!state.engineMessageId || state.engineMessageId === user.uuid)
      && matchesState(user, state));
    if (allocated || (matchingStates.length === 1 && matchingStates[0]?.entry.id === operationId)) {
      if (consumeCanonicalTurn) {
        if (ledger.confirmDelivered(generation.id, operationId, user.uuid, "inferred") === "refused") return false;
        const current = ledger.load(generation.id);
        const allocation = current.find((state) => state.entry.id === operationId);
        return Boolean(allocation?.delivered && allocation.engineMessageId === user.uuid
          && allocation.confirmation !== "unverified"
          && !current.some((state) => state.entry.id !== operationId && state.delivered && state.engineMessageId === user.uuid));
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
