import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { processIdentityMayRun } from "@/lib/processIdentity";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { agentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { currentSeat } from "@/lib/orchestrator/seatChannel";
import { seatMessageKeys } from "@/lib/orchestrator/seatDeliveryKeys";
import { deliverConversationMessage } from "@/lib/delivery";
import { agentMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import { lookupOriginalSend, resolveSendReceipt } from "@/lib/runtime/sendSettlement";
import { openRecordedChecks, type CheckRow } from "./store";
import { callingAttempt, verifyLiveCustody, retainResult, handoffRecordedCheck } from "./service";
import { digest, custodyClock } from "./wire";
import { setRecordedCheckWake } from "./signal";

export type ObserverPorts = {
  active(): boolean;
  recipient(project: string): { conversation: string; path: string; seatEpoch?: number | null } | null;
  deliver(row: CheckRow): Promise<{ operation: string | null; state: "reserved" | "uncertain" | "delivered" | "failed"; reason: string | null }>;
};
type Watch = { watcher?: fs.FSWatcher; timer?: ReturnType<typeof setTimeout> };
/** Filesystem and delivery events drive keyed reconciliation. No progress clock. */
export class RecordedCheckObserver {
  private watches = new Map<string, Watch>();
  private pending = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private faults = new Map<string, string>();
  private directoryWatcher?: fs.FSWatcher;
  private stopped = false;
  constructor(private ports: ObserverPorts, readonly filename = statePath("state.sqlite")) {}
  private active() { return !this.stopped && this.ports.active() && statePath("state.sqlite") === this.filename; }
  private store() { return openRecordedChecks(this.filename); }
  async start() {
    // Observe receipt events before loading pending delivery operations.
    this.directoryWatcher = fs.watch(path.dirname(this.filename), (_event, name) => {
      if (name?.toString().startsWith("delivery-progress.sqlite")) this.receiptsChanged();
    });
    this.directoryWatcher.on("error", () => {
      for (const id of this.watches.keys()) this.faults.set(id, "delivery event observation unavailable");
      console.error("[recorded checks] delivery observation unavailable");
      this.receiptsChanged();
    });
    const store = await this.store();
    try {
      let cursor = "";
      for (;;) {
        const page = store.page(cursor);
        if (!page.length) break;
        for (const row of page) { cursor = row.id; await this.observe(row.id); }
        if (page.length < 32) break;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally { store.close(); }
  }
  receiptsChanged() { for (const id of this.watches.keys()) void this.observe(id).catch(() => {}); }
  async observe(id: string): Promise<void> {
    if (!this.active()) return;
    const prior = this.pending.get(id);
    if (prior) { this.dirty.add(id); return prior; }
    const pending = withViewerOperation("recorded-check.observe", async () => {
      do {
        this.dirty.delete(id);
        const slot = parseInt(id.slice(0, 8), 16) % 128;
        await withFileTransactionAsync(path.join(path.dirname(this.filename), "recorded-check-observers", String(slot)), "recorded-check observation", () => this.reconcile(id));
      } while (this.dirty.has(id) && this.active());
    });
    this.pending.set(id, pending);
    try { await pending; }
    finally { this.pending.delete(id); }
  }
  private install(row: CheckRow) {
    if (this.watches.has(row.id)) return;
    if (this.watches.size >= 128) throw new Error("recorded check observer capacity is full");
    const watch: Watch = {};
    this.watches.set(row.id, watch);
    const wake = () => { void this.observe(row.id).catch(() => console.error("[recorded checks] observation retained for reconciliation")); };
    try {
      watch.watcher = fs.watch(`${row.log}.gate`, (_event, name) => {
        if (!name || ["result.json", "exit", "supervisor.json", "cancellation.json"].includes(name.toString())) wake();
      });
      watch.watcher.on("error", () => {
        this.faults.set(row.id, "recorded sidecar observation failed");
        watch.watcher?.close(); watch.watcher = undefined; wake();
      });
    } catch { this.faults.set(row.id, "recorded sidecar observation unavailable"); }
    const arm = () => {
      const remaining = row.descriptor.deadlineUptimeMs + 10_000 - custodyClock();
      if (remaining <= 0) wake();
      else { watch.timer = setTimeout(arm, Math.min(remaining, 2_147_483_647)); watch.timer.unref(); }
    };
    arm();
  }
  private async reconcile(id: string) {
    const store = await this.store();
    try {
      let row = store.get(id);
      if (!row || row.acknowledgement || !this.active()) { this.release(id); return; }
      this.install(row); // subscribe before the first receipt read
      const authority = () => {
        if (!this.active()) throw new Error("recorded check observer lost serving authority");
      };
      const fault = this.faults.get(id);
      if (fault && row.observerFault !== fault) {
        const updated: CheckRow = { ...row, revision: row.revision + 1, observerFault: fault };
        await store.write(updated, row.revision, authority); row = updated;
      }
      if (row.admission === "preparing") {
        try {
          row = await handoffRecordedCheck(row.binding.conversation, "reconcile-preparation", row.log,
            { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} }, row.id);
        } catch (error) {
          const fresh = store.get(id)!;
          const updated: CheckRow = { ...fresh, revision: fresh.revision + 1, admission: "refused",
            reason: (error instanceof Error ? error.message : "original preparation custody is unknown").slice(0, 1024) };
          await store.write(updated, fresh.revision, authority); row = updated;
        }
      }
      if (row.admission === "accepted" && !row.result?.terminal) {
        // A queued admission has no service yet. Persist its eventual native
        // dispatch identity outside scratch when the producer event arrives.
        try {
          const proof = verifyLiveCustody(row.binding, row.descriptor, `${row.log}.gate`);
          if (proof) {
            const identity = (entry: typeof proof) => digest([entry.kind, entry.supervisor, entry.service]);
            const custody = [...row.custody.filter(entry => identity(entry) !== identity(proof)), proof];
            if (digest(custody) !== digest(row.custody)) {
              const updated: CheckRow = { ...row, revision: row.revision + 1, custody };
              await store.write(updated, row.revision, authority); row = updated;
            }
          }
        } catch { /* Close and lost ownership below retain actual partial receipts. */ }
      }
      const terminal = fs.existsSync(path.join(`${row.log}.gate`, "result.json"));
      const ownerAlive = processIdentityMayRun(row.descriptor.recorder) && processIdentityMayRun(row.binding.host);
      if (terminal || !ownerAlive || row.admission === "refused" || custodyClock() >= row.descriptor.deadlineUptimeMs + 10_000) {
        const result = await retainResult(row);
        if (row.result?.digest !== result.digest) {
          const updated: CheckRow = { ...row, revision: row.revision + 1, result };
          await store.write(updated, row.revision, authority); row = updated;
        }
      }
      if (!row.result || row.notification?.state === "delivered" || row.notification?.state === "failed") return;
      if (!row.notification) {
        const target = this.ports.recipient(row.binding.project);
        if (!target) return;
        const result = row.result;
        const notification: NonNullable<CheckRow["notification"]> = { key: `${seatMessageKeys.recordedCheck}${row.id}`, ...target,
          text: `[Delegatus] Recorded check ${row.id}: ${result.state}; ${result.completed}/${row.descriptor.manifest.selection.length} completed; ${result.reason}. Durable receipt: ${row.id}. Read its current revision before acknowledging evidence.`,
          operation: null, state: "reserved", reason: null };
        const updated: CheckRow = { ...row, revision: row.revision + 1, notification };
        await store.write(updated, row.revision, authority); row = updated;
      }
      authority();
      const delivered = await this.ports.deliver(row);
      if (digest(delivered) !== digest({ operation: row.notification!.operation, state: row.notification!.state, reason: row.notification!.reason })) {
        const updated: CheckRow = { ...row, revision: row.revision + 1, notification: { ...row.notification!, ...delivered } };
        await store.write(updated, row.revision, authority);
      }
    } finally { store.close(); }
  }
  private release(id: string) { const watch = this.watches.get(id); watch?.watcher?.close(); clearTimeout(watch?.timer); this.watches.delete(id); this.faults.delete(id); }
  stop() { this.stopped = true; this.directoryWatcher?.close(); for (const id of this.watches.keys()) this.release(id); }
}

export const productionObserverPorts: ObserverPorts = {
  active: viewerReleaseOwnsTraffic,
  recipient(project) {
    const seat = currentSeat(project);
    const generation = seat?.conversationId ? agentRegistry().conversation(seat.conversationId as ViewerConversationId)?.generations.at(-1) : null;
    return generation && seat?.conversationId ? { conversation: seat.conversationId, path: generation.path, seatEpoch: seat.seatEpoch } : null;
  },
  async deliver(row) {
    const authority = () => { if (!viewerReleaseOwnsTraffic()) throw new Error("recorded completion lost serving authority"); };
    authority();
    const notification = row.notification!;
    const original = lookupOriginalSend(agentRegistry().readOnlySnapshot(), { conversationId: notification.conversation, clientMessageId: notification.key });
    if (original.kind === "found") {
      const receipt = await resolveSendReceipt(original.operationId);
      return { operation: original.operationId, state: receipt?.state === "delivered" ? "delivered"
        : receipt?.state === "failed" ? "failed" : "uncertain", reason: receipt?.reason ?? null };
    }
    if (notification.state === "uncertain" || notification.operation) return { operation: notification.operation, state: "uncertain", reason: "original completion send awaits reconciliation" };
    const outcome = await deliverConversationMessage({ path: notification.path, conversationId: notification.conversation,
      pid: null, images: [],
      admissionGuard: authority, recoveryAuthorityGuard: authority,
      text: notification.text, clientMessageId: notification.key,
      origin: agentMessageOrigin(agentRegistry().conversationDeliverySnapshot({ conversationId: row.binding.conversation }), row.binding.conversation) });
    const operation = outcome.ok ? outcome.operationId ?? null : null;
    const receipt = operation ? await resolveSendReceipt(operation) : null;
    return { operation, state: receipt?.state === "delivered" ? "delivered" : "uncertain", reason: outcome.ok ? receipt?.reason ?? null : outcome.error.slice(0, 1024) };
  },
};
const shared = globalThis as typeof globalThis & { __delegatusRecordedObserver?: { filename: string; value: RecordedCheckObserver } };
export async function startRecordedCheckObserver() {
  const filename = statePath("state.sqlite");
  if (shared.__delegatusRecordedObserver?.filename === filename) return shared.__delegatusRecordedObserver.value;
  shared.__delegatusRecordedObserver?.value.stop();
  const value = new RecordedCheckObserver(productionObserverPorts, filename);
  shared.__delegatusRecordedObserver = { filename, value };
  setRecordedCheckWake(() => value.receiptsChanged());
  await value.start();
  return value;
}
export function notifyRecordedCheckObservers() { shared.__delegatusRecordedObserver?.value.receiptsChanged(); }
export function stopRecordedCheckObserver() { shared.__delegatusRecordedObserver?.value.stop(); shared.__delegatusRecordedObserver = undefined; setRecordedCheckWake(undefined); }
export async function observeRecordedCheck(id: string) { const observer = await startRecordedCheckObserver(); await observer.observe(id); }
