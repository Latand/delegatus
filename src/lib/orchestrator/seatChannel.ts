import { seatMessageKeys as keys } from "./seatDeliveryKeys";
import { orchestratorSeatFor, orchestratorRecipientRefusal, orchestratorRecipientRefusalAsync } from "./seats";

import crypto from "node:crypto";
import { statePath } from "@/lib/configDir";
import { initializeStateCollectionsAsync, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { canonicalOrchestratorProject, orchestratorRevocations, type OrchestratorRevocation } from "./seats";
import { registryRowsMatching } from "@/lib/agent/sqliteRegistryStore";
import { deliveryMayHaveArrived, type AgentRegistry } from "@/lib/agent/registry";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { isInterruptionObligationId } from "@/lib/runtime/interruptionObligations";
import { isInterruptedCodexContinuationId } from "@/lib/runtime/recoveryNotices";
import type { StructuredMessageRequest, StructuredMessageResult } from "@/lib/runtime/structuredMessageDelivery";
import { existingTeamStore } from "@/lib/team/store";
import { settleMessageAuthor } from "@/lib/team/authorship";
import { onSeatChannelChange } from "./seatChannelSignal";


export const SEND_SEAT_REVOKED_REASON = "the orchestrator seat was replaced before this reached it; it was not delivered there";
export type SeatRecipientVerdict = { kind: "open" } | { kind: "unknown"; reason: string }
  | { kind: "revoked"; reason: string; successorConversationId?: string; project?: string; revokedAt?: string; revokedSeatEpoch?: number };
export function currentSeat(project: string, evidence?: ReturnType<typeof orchestratorSeatFor>) {
  const seat = (evidence ?? orchestratorSeatFor(project)).active;
  return seat?.state === "active" && seat.conversationId ? seat : null;
}
function verdict(refusal: ReturnType<typeof orchestratorRecipientRefusal>): SeatRecipientVerdict {
  return !refusal ? { kind: "open" } : refusal.status === 503 ? { kind: "unknown", reason: refusal.error }
    : { kind: "revoked", reason: SEND_SEAT_REVOKED_REASON, successorConversationId: refusal.successorConversationId, project: refusal.project, revokedAt: refusal.revokedAt, revokedSeatEpoch: refusal.revokedSeatEpoch };
}
export function seatRecipientVerdict(ids: readonly string[], resolveAlias?: (id: string) => string): SeatRecipientVerdict {
  return verdict(orchestratorRecipientRefusal(ids, resolveAlias));
}
export async function seatRecipientVerdictAsync(ids: readonly string[], resolveAlias?: (id: string) => string): Promise<SeatRecipientVerdict> {
  return verdict(await orchestratorRecipientRefusalAsync(ids, resolveAlias));
}


export type SeatDeliveryClass = "owner" | "epoch" | "channel";
/** Producers own these namespaces. Unknown producers preserve the operator's words. */
export function seatDeliveryDisposition(operation: { clientMessageId: string | null }): SeatDeliveryClass {
  const key = operation.clientMessageId ?? "";
  if (key.startsWith(keys.decision) || key.startsWith(keys.telegram)
    || key.startsWith(keys.voice) || key.startsWith(keys.spawn)) return "owner";
  if (key.startsWith(keys.tick) || key.startsWith(keys.boardReport) || key.startsWith(keys.nudge)
    || key.startsWith(keys.deputy) || key.startsWith(keys.mandate)
    || isInterruptionObligationId(key) || isInterruptedCodexContinuationId(key)) return "epoch";
  return "channel";
}
export const seatRedirectKey = (id: string) => `seat-redirect:${crypto.createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
export function seatRedirectNote(sentAt: string, revokedAt: string): string {
  const time = (value: string) => new Date(value).toISOString().slice(11, 16);
  return `[Delegatus] Redirected to you, the current orchestrator: sent to the previous orchestrator at ${time(sentAt)} UTC, which was replaced at ${time(revokedAt)} UTC before this reached it. Check it is still needed before acting.`;
}
export interface SeatChannelRecord {
  fromOperationId: string;
  fromConversationId: string;
  project: string;
  revokedSeatEpoch: number;
  class: SeatDeliveryClass;
  outcome: "redirected" | "dropped" | "owner" | "too-late" | "awaiting-seat" | "unknown";
  toOperationId?: string;
  toConversationId?: string;
  at: string;
  revokedAt: string;
  sentAt?: string;
  /** Kept until admission settles; recovery must never reconstruct scrubbed text. */
  payload?: Pick<StructuredMessageRequest, "text" | "imageRefs" | "origin" | "selectedContext" | "runtime">;
  clientMessageId: string | null;
  revision?: number;
}
const active = (row: SeatChannelRecord) => row.outcome === "unknown" || row.outcome === "too-late" || row.outcome === "awaiting-seat";
const seed = { collection: "seat-channel", schemaVersion: 1, migrationId: "seat-channel-v1",
  key: (row: SeatChannelRecord) => row.fromOperationId, controllerActive: active, loadRecords: (): SeatChannelRecord[] => [] };
const SHARED = Symbol.for("delegatus.seat-channel");
interface ChannelState {
  stores: Map<string, SqliteStateCollection<SeatChannelRecord>>;
  pending: Map<string, OrchestratorRevocation>;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
  started: boolean;
  withdrawNative?: (conversationId: string, operationId: string) => Promise<boolean>;
}
function state(): ChannelState {
  const host = globalThis as typeof globalThis & { [SHARED]?: ChannelState };
  return host[SHARED] ??= { stores: new Map(), pending: new Map(), started: false };
}
function collection(): SqliteStateCollection<SeatChannelRecord> | null {
  const filename = statePath("state.sqlite");
  const held = state().stores.get(filename);
  if (held) return held;
  if (!stateCollectionsInitialized(filename, [seed])) return null;
  const opened = new SqliteStateCollection<SeatChannelRecord>(filename, { ...seed, busyMessage: "seat channel busy",
    decode: value => value && typeof value === "object" && typeof (value as SeatChannelRecord).fromOperationId === "string" ? value as SeatChannelRecord : null,
    clone: structuredClone, strictDecode: true, readCacheKey: "seat-channel-v1" });
  // Only the serving state directory is retained across Next bundle copies.
  state().stores.clear();
  state().stores.set(filename, opened);
  return opened;
}
async function store(): Promise<SqliteStateCollection<SeatChannelRecord>> {
  await initializeStateCollectionsAsync(statePath("state.sqlite"), [seed]);
  return collection()!;
}
export function seatChannelRecord(operationId: string): SeatChannelRecord | null {
  return collection()?.get(operationId) ?? null;
}
async function save(row: SeatChannelRecord, registry: AgentRegistry): Promise<SeatChannelRecord> {
  const records = await store();
  const existing = records.get(row.fromOperationId);
  const rows = existing ? [] : await records.snapshotAsync();
  const overflow = rows.length + (existing ? 0 : 1) - 2000;
  const victims = overflow > 0 ? rows.filter(item => {
    if (active(item)) return false;
    if (item.outcome !== "redirected") return true;
    // A redirect remains the receipt's authority while its source is queryable.
    const source = registry.deliverySnapshotForOperation(item.fromOperationId);
    return !source.deliveryOperationOwners[item.fromOperationId]
      && !Object.values(source.heldDeliveries).some(delivery => delivery.command.operationId === item.fromOperationId);
  }).sort((a, b) => a.at.localeCompare(b.at)).slice(0, overflow) : [];
  if (overflow > victims.length) throw new Error("seat channel record capacity reached");
  return records.boundedPatchAsync(victims.length + 2, tx => {
    const current = tx.get(row.fromOperationId);
    if (current && ((current.revision ?? 0) !== (row.revision ?? 0) || !active(current))) return current;
    for (const victim of victims) tx.delete(victim.fromOperationId);
    const written = { ...row, revision: (row.revision ?? 0) + 1 };
    tx.put(written);
    return written;
  });
}
function stampRedirectAuthor(row: SeatChannelRecord): void {
  if (!row.toConversationId || !row.payload) return;
  const author = row.clientMessageId ? existingTeamStore()?.messageAuthors([row.clientMessageId]).get(row.clientMessageId) : null;
  if (!author) return;
  settleMessageAuthor({ actor: { kind: "member", memberId: author.memberId }, clientMessageId: seatRedirectKey(row.fromOperationId),
    conversationId: row.toConversationId, path: null,
    text: `${seatRedirectNote(row.sentAt ?? row.at, row.revokedAt)}\n${row.payload.text}` });
  const recorded = existingTeamStore()?.messageAuthors([seatRedirectKey(row.fromOperationId)]).get(seatRedirectKey(row.fromOperationId));
  if (!recorded || recorded.memberId !== author.memberId || recorded.conversationId !== row.toConversationId)
    throw new Error("redirect authorship awaits durable confirmation");
}
export type SeatWithdrawal = "withdrawn" | "too-late" | "unknown";
/** Journal withdrawal is atomic with removal of the effect, never a mirror-only write. */
export async function withdrawRuntimeWake(operationId: string, reason: string, client: RuntimeHostClient): Promise<SeatWithdrawal> {
  const current = await client.operationStatus(operationId, { currentRetryLeaf: true });
  if (!current) return "unknown";
  if (["delivering", "applying", "delivered", "applied", "answered", "turn-started", "steered", "uncertain"].includes(current.receipt.status)) return "too-late";
  if (["failed", "rejected"].includes(current.receipt.status)) return "withdrawn";
  if (!["queued", "pending"].includes(current.receipt.status)) return "unknown";
  try {
    const settled = await client.transitionOperation(current.operationId, "failed", { reason }, { fromStatuses: ["pending", "queued"] });
    return settled.receipt.status === "failed" ? "withdrawn" : "too-late";
  } catch {
    const after = await client.operationStatus(current.operationId, { currentRetryLeaf: true });
    if (after && ["failed", "rejected"].includes(after.receipt.status) && after.receipt.reason === reason) return "withdrawn";
    return after && ["delivering", "applying", "delivered", "applied", "answered"].includes(after.receipt.status) ? "too-late" : "unknown";
  }
}
export interface SeatChannelPorts {
  registry: AgentRegistry;
  client: RuntimeHostClient;
  enqueue(request: StructuredMessageRequest): Promise<StructuredMessageResult | null>;
  ownsTraffic(): boolean;
  now(): number;
  withdrawNative?(conversationId: string, operationId: string): Promise<boolean>;
}
/** One rotation's narrow registry projection, also used at boot after a missed write. */
export async function reconcileSeatChannel(revocation: OrchestratorRevocation, ports: SeatChannelPorts): Promise<boolean> {
  return withViewerOperation("orchestrator.seat-channel", async () => {
    if (!ports.ownsTraffic()) return false;
    const { registry, client } = ports;
    const snapshot = registry.readOnlySnapshot();
    const { conversationIdsResolvingTo, readOnlyConversationLookupFromSnapshot } = await import("@/lib/agent/registry");
    const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
    const canonical = lookup.canonicalConversationId(revocation.conversationId as ViewerConversationId);
    const ids = conversationIdsResolvingTo(snapshot, canonical);
    const owners = registryRowsMatching(snapshot, "deliveryOperationOwners", "conversationId", ids);
    const held = registryRowsMatching(snapshot, "heldDeliveries", "conversationId", ids);
    const records = await store();
    const candidates = new Map<string, SeatChannelRecord>();
    for (const owner of owners) {
      const previous = records.get(owner.command.operationId);
      if (previous && !active(previous)) continue;
      if (owner.terminalState && owner.terminalReason !== SEND_SEAT_REVOKED_REASON) continue;
      const delivery = snapshot.heldDeliveries[owner.deliveryId];
      candidates.set(owner.command.operationId, previous ?? {
        fromOperationId: owner.command.operationId, fromConversationId: owner.conversationId,
        project: revocation.project, revokedSeatEpoch: revocation.seatEpoch,
        class: seatDeliveryDisposition(owner), outcome: "unknown", at: new Date(ports.now()).toISOString(),
        revokedAt: revocation.revokedAt, sentAt: owner.createdAt, clientMessageId: owner.clientMessageId,
        payload: delivery ? { text: delivery.text, imageRefs: delivery.runtimeImages, origin: owner.command.origin } : undefined,
      });
    }
    for (const delivery of held) {
      if (delivery.state === "delivered" || delivery.state === "failed" && delivery.error !== SEND_SEAT_REVOKED_REASON) continue;
      if (candidates.has(delivery.command.operationId)) continue;
      const previous = records.get(delivery.command.operationId);
      if (previous && !active(previous)) continue;
      candidates.set(delivery.command.operationId, previous ?? {
        fromOperationId: delivery.command.operationId, fromConversationId: delivery.conversationId,
        project: revocation.project, revokedSeatEpoch: revocation.seatEpoch,
        class: seatDeliveryDisposition(delivery), outcome: "unknown", at: new Date(ports.now()).toISOString(),
        revokedAt: revocation.revokedAt, sentAt: delivery.createdAt, clientMessageId: delivery.clientMessageId,
        payload: { text: delivery.text, imageRefs: delivery.runtimeImages, origin: delivery.command.origin },
      });
    }
    for (const row of records.snapshotForController()) {
      if (canonicalOrchestratorProject(row.project) === canonicalOrchestratorProject(revocation.project)
        && row.fromConversationId === revocation.conversationId) candidates.set(row.fromOperationId, row);
    }
    const activeSeat = currentSeat(revocation.project);
    if (activeSeat?.conversationId === revocation.conversationId && activeSeat.seatEpoch > revocation.seatEpoch) {
      const reactivatedAt = activeSeat.activatedAt ? Date.parse(activeSeat.activatedAt) : Number.NaN;
      if (Number.isFinite(reactivatedAt)) for (const [operationId] of candidates) {
        // A persisted row belongs to the revocation that first captured it.
        // For uncaptured work, the owner timestamp distinguishes new traffic
        // for this re-designation from work left by the historical epoch.
        if (records.get(operationId)) continue;
        const owner = owners.find(item => item.command.operationId === operationId);
        const delivery = held.find(item => item.command.operationId === operationId);
        const createdAt = Date.parse(owner?.createdAt ?? delivery?.createdAt ?? "");
        if (Number.isFinite(createdAt) && createdAt >= reactivatedAt) candidates.delete(operationId);
      }
    }
    let complete = true;
    for (let row of candidates.values()) {
      if (!ports.ownsTraffic()) return false;
      const sourceOwner = owners.find(item => item.command.operationId === row.fromOperationId);
      const mayOwnNativeEntry = sourceOwner?.directAdmission === "native-queue-add"
        || sourceOwner?.command.kind === "send" && sourceOwner.command.policy === "queue";
      const nativeEntry = mayOwnNativeEntry && client.nativeQueueRead
        ? (await client.nativeQueueRead(row.fromConversationId)).find(item => item.entryId === row.fromOperationId)
        : undefined;
      if (sourceOwner?.directAdmission === "native-queue-add" || nativeEntry) {
        if (nativeEntry?.mutationOperationId && nativeEntry.mutationOperationId !== row.fromOperationId) { complete = false; continue; }
        const version = nativeEntry?.versions.find(item => item.revision === nativeEntry.revision);
        if (version) row = { ...row, payload: { text: version.text, imageRefs: version.images, origin: version.origin,
          selectedContext: version.selectedContext, runtime: version.requestedRuntime } };
      } else if (!row.payload && sourceOwner?.evidenceText && !sourceOwner.evidenceImageCount) {
        row = { ...row, payload: { text: sourceOwner.evidenceText, origin: sourceOwner.command.origin } };
      }
      row = await save(row, registry); // Capture
      if (!active(row)) continue; // Another serving generation already settled this source.
      // the complete payload before withdrawal can scrub it.
      const original = await client.operationStatus(row.fromOperationId);
      const delivery = registry.readOnlySnapshot().heldDeliveries[owners.find(owner => owner.command.operationId === row.fromOperationId)?.deliveryId
        ?? held.find(item => item.command.operationId === row.fromOperationId)?.id ?? ""];
      const native = owners.find(owner => owner.command.operationId === row.fromOperationId)?.directAdmission === "native-queue-add"
        || Boolean(nativeEntry);
      let withdrawal: SeatWithdrawal;
      if (native && !await ports.withdrawNative?.(row.fromConversationId, row.fromOperationId)) { complete = false; continue; }
      if (row.outcome === "awaiting-seat") withdrawal = "withdrawn";
      else if (original) {
        if (original.receipt.status === "failed" && original.receipt.reason !== SEND_SEAT_REVOKED_REASON && !native) {
          row = await save({ ...row, outcome: "dropped", payload: undefined }, registry); continue;
        }
        withdrawal = await withdrawRuntimeWake(row.fromOperationId, SEND_SEAT_REVOKED_REASON, client);
      } else if (delivery?.state === "held") withdrawal = "withdrawn";
      else if (delivery?.state === "failed" && delivery.error === SEND_SEAT_REVOKED_REASON) withdrawal = "withdrawn";
      else { complete = false; continue; }
      if (withdrawal !== "withdrawn") {
        const after = await client.operationStatus(row.fromOperationId);
        const landed = after && ["delivered", "turn-started", "steered"].includes(after.receipt.status);
        row = await save({ ...row, outcome: landed ? "dropped" : withdrawal === "too-late" ? "too-late" : "unknown", ...(landed ? { payload: undefined } : {}) }, registry);
        if (!landed) complete = false;
        continue;
      }
      if (delivery && delivery.state !== "failed" && delivery.state !== "delivered") {
        const ended = original
          ? await registry.deliveryWrite({ label: "delivery.seat-channel", operationId: row.fromOperationId },
            () => registry.recordDeliveryOutcome(delivery.id, "failed", SEND_SEAT_REVOKED_REASON, "lost"))
          : await registry.deliveryWrite({ label: "delivery.seat-channel", operationId: row.fromOperationId },
            () => registry.withdrawHeldDelivery(delivery.id, row.fromOperationId, SEND_SEAT_REVOKED_REASON));
        if (!ended.acquired) { complete = false; continue; }
        if (original) {
          const settled = ended.value;
          if (typeof settled === "string") {
            row = await save({ ...row, outcome: "unknown" }, registry);
            complete = false;
            continue;
          }
          if (settled.state === "delivered" || deliveryMayHaveArrived(registry.readOnlySnapshot(), settled)) {
            row = await save({ ...row, outcome: "dropped", payload: undefined }, registry);
            continue;
          }
          if (settled.state !== "failed" || settled.error !== SEND_SEAT_REVOKED_REASON) {
            row = await save({ ...row, outcome: settled.state === "delivery-uncertain" ? "too-late" : "unknown" }, registry);
            complete = false;
            continue;
          }
        } else if (typeof ended.value !== "string" || ended.value !== "withdrawn") {
          row = await save({ ...row, outcome: ended.value === "too-late" ? "too-late" : "unknown" }, registry);
          complete = false;
          continue;
        }
      }
      const operationOwner = registry.readOnlySnapshot().deliveryOperationOwners[row.fromOperationId];
      if (operationOwner?.directAdmission || operationOwner?.retryOfOperationId) {
        const settled = await registry.deliveryWrite({ label: "delivery.seat-channel", operationId: row.fromOperationId },
          () => registry.settleDirectAdmission(row.fromOperationId, "failed", SEND_SEAT_REVOKED_REASON, "lost"));
        if (!settled.acquired) { complete = false; continue; }
      }
      if (row.class !== "channel") {
        if (row.clientMessageId?.startsWith(keys.spawn) && row.payload?.origin?.kind === "agent" && row.payload.origin.conversationId) {
          const { reopenRevokedSpawnNotice } = await import("@/lib/spawnNotice/store");
          await reopenRevokedSpawnNotice(row.payload.origin.conversationId, row.fromOperationId);
        }
        row = await save({ ...row, outcome: row.class === "owner" ? "owner" : "dropped", payload: undefined }, registry); continue;
      }
      if (!row.payload) { complete = false; continue; }
      const clientMessageId = seatRedirectKey(row.fromOperationId);
      if (row.toConversationId && row.toOperationId) {
        const admission = registry.deliveryAdmissionForKey(row.toConversationId, clientMessageId);
        const journal = await client.operationStatus(row.toOperationId);
        if (admission.outcome === "admitted" || journal?.receipt.conversationId === row.toConversationId) {
          stampRedirectAuthor(row);
          row = await save({ ...row, outcome: "redirected", payload: undefined }, registry);
          continue;
        }
        if (admission.outcome !== "not-executed") { complete = false; continue; }
      }
      const seat = currentSeat(row.project);
      if (!seat) {
        const expired = ports.now() - Date.parse(row.at) >= 24 * 60 * 60_000;
        row = await save({ ...row, outcome: expired ? "dropped" : "awaiting-seat", ...(expired ? { payload: undefined } : {}) }, registry);
        complete &&= expired;
        continue;
      }
      if (!ports.ownsTraffic()) return false;
      row = { ...row, toConversationId: seat.conversationId!, toOperationId: clientMessageId.replace("seat-redirect:", "seat_redirect_") };
      row = await save(row, registry);
      if (!active(row) || row.toConversationId !== seat.conversationId) { complete = false; continue; }
      const text = `${seatRedirectNote(row.sentAt ?? row.at, row.revokedAt)}\n${row.payload!.text}`;
      const result = await ports.enqueue({ ...row.payload!, text, path: seat.path ?? "", conversationId: seat.conversationId!,
        clientMessageId, operationId: row.toOperationId, policy: "steer-or-queue",
        admissionGuard: () => { if (!ports.ownsTraffic()) throw new Error("seat channel release no longer owns traffic"); } });
      if (result?.ok && result.operationId) {
        stampRedirectAuthor(row);
        row = { ...row, outcome: "redirected", toOperationId: result.operationId, toConversationId: seat.conversationId!, payload: undefined };
        row = await save(row, registry);
      } else complete = false;
    }
    return complete;
  });
}
export function setSeatChannelNativeWithdrawal(next: ChannelState["withdrawNative"]): void { state().withdrawNative = next; }
function schedule(): void {
  const shared = state();
  if (shared.timer || shared.running || !shared.started) return;
  shared.timer = setTimeout(() => {
    shared.timer = undefined;
    shared.running = run().catch(error => console.error("[seat channel] reconcile failed", error instanceof Error ? error.message : String(error)))
      .finally(() => { shared.running = undefined; if (shared.pending.size) schedule(); });
  }, 1000);
  shared.timer.unref?.();
}
async function run(): Promise<void> {
  if (!viewerReleaseOwnsTraffic()) return;
  const [{ agentRegistry }, { runtimeHostClient }, { enqueueStructuredMessage }] = await Promise.all([
    import("@/lib/agent/registry"), import("@/lib/runtime/client"), import("@/lib/runtime/structuredMessageDelivery"),
  ]);
  const client = runtimeHostClient();
  if (!client) return;
  for (const [key, revocation] of [...state().pending].slice(0, 8)) {
    try {
      if (await reconcileSeatChannel(revocation, { registry: agentRegistry(), client, enqueue: enqueueStructuredMessage,
        ownsTraffic: viewerReleaseOwnsTraffic, now: Date.now, withdrawNative: state().withdrawNative })) state().pending.delete(key);
    } finally {
      if (state().pending.get(key) === revocation) { state().pending.delete(key); state().pending.set(key, revocation); }
    }
  }
}
function queueRevocations(revocations: readonly OrchestratorRevocation[]): void {
  for (const row of revocations) state().pending.set(`${row.project}:${row.seatEpoch}`, row);
  schedule();
}
export function startSeatChannel(): void {
  withViewerOperation("orchestrator.seat-channel", () => {
    if (state().started) return;
    state().started = true;
    onSeatChannelChange(queueRevocations);
    queueRevocations(orchestratorRevocations().filter(row => Date.now() - Date.parse(row.revokedAt) < 24 * 60 * 60_000));
    // Persisted open rows are also resumed after their revocation ages out of the boot window.
    for (const row of collection()?.snapshotForController() ?? []) queueRevocations([{
      project: row.project, conversationId: row.fromConversationId, seatEpoch: row.revokedSeatEpoch, revokedAt: row.revokedAt,
    }]);
  });
}
