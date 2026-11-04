import { readEvidenceWithin } from "./evidence";
import { createHash } from "node:crypto";
import type { AgentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { initializeStateCollections, SqliteStateCollection, stateCollectionsInitialized } from "@/lib/state/sqliteStateStore";
import type { SendReceipt } from "./sendSettlement";

/** One obligation per failed operation. The sender comes only from admitted
 * authorship; neither message text nor a receipt caller chooses it. */
export interface SendFailureNotice {
  operationId: string;
  senderConversationId: string;
  targetConversationId: string;
  reason: string;
  resend: "safe" | "verify-first";
  createdAt: string;
  state: "pending" | "sent" | "failed" | "cancelled";
  recipientConversationId: string | null;
  clientMessageId: string;
  text: string;
  settledAt: string | null;
  attemptedAt?: string;
}
const COLLECTION = "send_failure_notices";
const key = (row: SendFailureNotice) => row.operationId;
const controllerActive = (row: SendFailureNotice) => row.state === "pending" || row.state === "failed";
const seed = { collection: COLLECTION, schemaVersion: 1, migrationId: "send-failure-notices-v1", key, controllerActive,
  loadRecords: (): SendFailureNotice[] => [] };
let cached: { file: string; store: SqliteStateCollection<SendFailureNotice> } | null = null;
let pruneAfter = "";

export function decodeSendFailureNotice(value: unknown): SendFailureNotice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<SendFailureNotice>;
  return typeof row.operationId === "string" && !!row.operationId
    && typeof row.senderConversationId === "string" && row.senderConversationId.startsWith("conversation_")
    && typeof row.targetConversationId === "string" && row.targetConversationId.startsWith("conversation_")
    && typeof row.reason === "string" && typeof row.text === "string"
    && typeof row.clientMessageId === "string" && typeof row.createdAt === "string" && Number.isFinite(Date.parse(row.createdAt))
    && ["safe", "verify-first"].includes(row.resend ?? "")
    && ["pending", "sent", "failed", "cancelled"].includes(row.state ?? "")
    && (row.recipientConversationId === null || typeof row.recipientConversationId === "string")
    && (row.attemptedAt === undefined || (typeof row.attemptedAt === "string" && Number.isFinite(Date.parse(row.attemptedAt))))
    && (row.settledAt === null || (typeof row.settledAt === "string" && Number.isFinite(Date.parse(row.settledAt))))
    ? row as SendFailureNotice : null;
}

function collection(create: boolean): SqliteStateCollection<SendFailureNotice> | null {
  const file = statePath("state.sqlite");
  if (cached?.file === file) return cached.store;
  if (!create && !stateCollectionsInitialized(file, [seed])) return null;
  if (create) initializeStateCollections(file, [seed]);
  const store = new SqliteStateCollection<SendFailureNotice>(file, {
    collection: COLLECTION, schemaVersion: 1, busyMessage: "send failure notices busy", key,
    decode: decodeSendFailureNotice, clone: structuredClone, strictDecode: true, controllerActive,
  });
  // One state root per serving process. Test roots evict the previous wrapper.
  cached?.store.close();
  cached = { file, store }; pruneAfter = "";
  return store;
}

export function recordSendFailureNotice(registry: AgentRegistry, operationId: string,
  state: "failed" | "uncertain", reason: string | null): void {
  const file = registry.deliverySnapshotForOperation(operationId);
  const owner = file.deliveryOperationOwners[operationId];
  const delivery = owner ? file.heldDeliveries[owner.deliveryId] : undefined;
  const origin = owner?.command?.origin ?? delivery?.command.origin;
  if (!owner || (owner.command.kind !== "send" && owner.command.kind !== "steer") || origin?.kind !== "agent" || !origin.conversationId?.startsWith("conversation_")
    || origin.conversationId === owner.conversationId) return;
  const resend = state === "failed" && owner.terminalDisposition === "lost" ? "safe" : "verify-first";
  const detail = (reason ?? "delivery could not be confirmed").slice(0, 500);
  const text = [`Message delivery ${state === "uncertain" ? "unconfirmed" : "failed"}: ${operationId} → ${owner.conversationId}.`, detail,
    resend === "safe" ? "The original operation is fenced and will not be resent automatically. A new send is safe."
      : "Arrival is unconfirmed. Verify the recipient before sending again; a second send could duplicate it."].join("\n");
  collection(true)!.boundedPatch(2, tx => {
    if (tx.get(operationId)) return;
    tx.put({ operationId, senderConversationId: origin.conversationId!, targetConversationId: owner.conversationId,
      reason: detail, resend, createdAt: new Date().toISOString(), state: "pending", recipientConversationId: null,
      clientMessageId: `send_failure_${createHash("sha256").update(operationId).digest("hex")}`, text, settledAt: null });
  });
}

/** The Viewer's release owner initializes this before receipt readers arrive. */
export function initializeSendFailureNotices(): void { collection(true); }

export function readSendFailureNotice(operationId: string): SendFailureNotice | null {
  return collection(false)?.get(operationId) ?? null;
}

/** A canonical arrival retires only this operation's alarm. No input is written. */
export function cancelSendFailureNotice(operationId: string): void {
  const store = collection(false);
  const row = store?.get(operationId);
  if (!row || (row.state !== "pending" && row.state !== "failed")) return;
  update(row, { state: "cancelled", settledAt: new Date().toISOString() });
}

export function pendingSendFailureNotices(): SendFailureNotice[] {
  return (collection(false)?.snapshotForController() ?? []).filter(row => row.state === "pending");
}

/** Stable actionable items are harvested by the seat's existing wake ledger. */
export function sendFailureSignals(sender: string | null | undefined): Array<{ id: string; label: string; actionable: true }> {
  if (!sender) return [];
  return (collection(false)?.snapshotForController() ?? []).filter(row => row.senderConversationId === sender)
    .map(row => ({ id: `send-failed:${row.operationId}`, label: `Message ${row.operationId} to ${row.targetConversationId} failed: ${row.reason}`, actionable: true }));
}

export interface SendFailureNoticePorts {
  registry: AgentRegistry;
  receipt(operationId: string): Promise<SendReceipt | null>;
  recipient(sender: string): { kind: "deliver"; conversationId: string; path: string } | { kind: "skip"; reason: string };
  deliver(request: { pid: null; path: string; conversationId: string; clientMessageId: string; text: string;
    images: []; policy: "steer-or-queue"; origin: { kind: "agent"; role: string } }): Promise<{ ok: boolean }>;
  assertActive(): void;
  readMs?: number;
}

function update(row: SendFailureNotice, patch: Partial<SendFailureNotice>): void {
  collection(true)!.boundedPatch(2, tx => {
    const current = tx.get(row.operationId);
    if (!current || (current.state !== "pending" && !(current.state === "failed"
      && (patch.state === "cancelled" || patch.attemptedAt !== undefined)))) return;
    tx.put({ ...current, ...patch });
  });
}

/** Bounded work over open obligations. Same key and exact text survive crashes
 * and lost acknowledgements. A fenced notice is terminal and is never resent. */
export async function sweepSendFailureNotices(ports: SendFailureNoticePorts): Promise<void> {
  ports.assertActive();
  const { lookupOriginalSend, sendReceiptFor } = await import("./sendSettlement");
  ports.assertActive();
  const store = collection(false);
  if (store) {
    const page = store.keyRange(pruneAfter, "\uffff", 64);
    const cutoff = Date.now() - 14 * 24 * 60 * 60_000;
    const stale = page.filter(row => row.state !== "pending" && Date.parse(row.settledAt ?? row.createdAt) < cutoff);
    if (stale.length) store.boundedPatch(stale.length * 2, tx => {
      for (const row of stale) {
        const current = tx.get(row.operationId);
        if (current && current.state !== "pending" && Date.parse(current.settledAt ?? current.createdAt) < cutoff) tx.delete(row.operationId);
      }
    });
    pruneAfter = page.length === 64 ? page.at(-1)!.operationId : "";
  }
  const step = async <T>(work: () => Promise<T>): Promise<T> => {
    const answer = await readEvidenceWithin(work, ports.readMs ?? 10_000, "delivery notice transport is unavailable");
    ports.assertActive();
    if (!answer.readable) throw new Error(answer.reason);
    return answer.value;
  };
  const pending = (collection(false)?.snapshotForController() ?? []).sort((a, b) =>
    (a.attemptedAt ?? a.createdAt).localeCompare(b.attemptedAt ?? b.createdAt) || a.operationId.localeCompare(b.operationId));
  const outcomes = await Promise.allSettled(pending.slice(0, 32).map(async row => {
    ports.assertActive();
    update(row, { attemptedAt: new Date().toISOString() });
    // Retained failed alarms need only the keyed durable projection. They
    // never reopen dispatch or repeatedly scan an unchanged transcript.
    const projected = sendReceiptFor(ports.registry.deliverySnapshotForOperation(row.operationId), row.operationId);
    if (projected?.state === "delivered") { update(row, { state: "cancelled", settledAt: new Date().toISOString() }); return; }
    if (row.state === "failed") return;
    const receipt = await step(() => ports.receipt(row.operationId));
    ports.assertActive();
    if (receipt?.state === "delivered") { update(row, { state: "cancelled", settledAt: new Date().toISOString() }); return; }
    if (!receipt || receipt.state !== "failed" || row.state === "failed") return;
    const latest = sendReceiptFor(ports.registry.deliverySnapshotForOperation(row.operationId), row.operationId);
    if (latest?.state === "delivered") { update(row, { state: "cancelled", settledAt: new Date().toISOString() }); return; }
    const recipient = ports.recipient(row.recipientConversationId ?? row.senderConversationId);
    if (recipient.kind !== "deliver") {
      update(row, { state: "failed", settledAt: new Date().toISOString() }); return;
    }
    if (row.recipientConversationId && row.recipientConversationId !== recipient.conversationId) {
      // A new seat cannot receive a second copy of an already admitted notice.
      update(row, { state: "failed", settledAt: new Date().toISOString() }); return;
    }
    const original = lookupOriginalSend(ports.registry.deliverySnapshotForMessageKey(recipient.conversationId, row.clientMessageId),
      { conversationId: recipient.conversationId, clientMessageId: row.clientMessageId });
    if (original.kind === "found") {
      const answer = await step(() => ports.receipt(original.operationId));
      ports.assertActive();
      if (answer?.state !== "in-flight" && answer) update(row, { state: answer.state === "delivered" ? "sent" : "failed", settledAt: new Date().toISOString() });
      return;
    }
    if (original.kind !== "absent") return;
    update(row, { recipientConversationId: recipient.conversationId });
    await step(() => ports.deliver({ pid: null, path: recipient.path, conversationId: recipient.conversationId,
      clientMessageId: row.clientMessageId, text: row.text, images: [], policy: "steer-or-queue", origin: { kind: "agent", role: "delivery" } }));
    ports.assertActive();
  }));
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (failures.length) throw new Error(failures.map(outcome => outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)).join("; "));
}
