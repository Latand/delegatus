import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { captureProcessIdentity, processIdentityMayRun, sameRecordedProcessIdentity } from "@/lib/processIdentity";
import { readHotStateAuthority, hotStateSqliteWriterReady } from "@/lib/state/hotStateAuthority";
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
import { digest, custodyClock, CUSTODY_CLEANUP_MS } from "./wire";
import { setRecordedCheckWake } from "./signal";

export type ObserverPorts = {
  active(): boolean;
  recipient(project: string): { conversation: string; path: string; seatEpoch?: number | null } | null;
  deliver(row: CheckRow): Promise<{ operation: string | null; state: "reserved" | "uncertain" | "delivered" | "failed"; reason: string | null; noDispatch?: boolean }>;
};
type Watch = { watcher?: fs.FSWatcher; timer?: ReturnType<typeof setTimeout> };
function servingObservation() {
  const owner = captureProcessIdentity(process.pid);
  if (!owner.startIdentity || !owner.bootEpoch) throw new Error("recorded observer process identity is unavailable");
  const authority = readHotStateAuthority(path.dirname(statePath("state.sqlite")));
  return { owner: { pid: owner.pid, startIdentity: owner.startIdentity, bootEpoch: owner.bootEpoch },
    epoch: authority?.epoch ?? null, releaseRevision: authority?.releaseRevision ?? null };
}
function servingRecordedChecks() {
  return viewerReleaseOwnsTraffic() && hotStateSqliteWriterReady(path.dirname(statePath("state.sqlite")));
}
/** Filesystem and delivery events drive keyed reconciliation. No progress clock. */
export class RecordedCheckObserver {
  private watches = new Map<string, Watch>();
  private pending = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private resultRequested = new Set<string>();
  private faults = new Map<string, string>();
  private directoryWatcher?: fs.FSWatcher;
  private stopWake?: () => void;
  private stopped = false;
  private eventCursor = 0;
  private eventWork?: Promise<void>;
  private eventsDirty = false;
  constructor(private ports: ObserverPorts, readonly filename = statePath("state.sqlite")) {}
  private active() { return !this.stopped && this.ports.active() && statePath("state.sqlite") === this.filename; }
  private store() { return openRecordedChecks(this.filename); }
  async start() {
    if (this.stopped) return;
    this.stopWake = setRecordedCheckWake(id => this.receiptsChanged(id));
    // Observe receipt events before loading pending delivery operations.
    this.directoryWatcher = fs.watch(path.dirname(this.filename), (_event, name) => {
      if (name?.toString() === `${path.basename(this.filename)}.recorded-check-event`) {
        this.changedReceipts();
      }
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
        if (this.stopped) return;
        const page = store.page(cursor);
        if (!page.length) break;
        for (const row of page) {
          cursor = row.id;
          this.install(row);
          setImmediate(() => { void this.observe(row.id).catch(() => console.error("[recorded checks] startup reconciliation retained")); });
        }
        if (page.length < 32) break;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally { store.close(); }
  }
  private changedReceipts() {
    this.eventsDirty = true;
    if (this.eventWork) return;
    this.eventWork = (async () => {
      const store = await this.store();
      try {
        do {
          this.eventsDirty = false;
          for (;;) {
            const page = store.changed(this.eventCursor);
            for (const event of page) {
              if (!this.active()) return;
              try { await this.observe(event.id, false); }
              catch (error) { await this.recordFault(event.id, error); }
              this.eventCursor = event.revision;
            }
            if (page.length < 32) break;
          }
        } while (this.eventsDirty && this.active());
      } finally { store.close(); }
    })().catch(() => console.error("[recorded checks] receipt events retained for reconciliation"))
      .finally(() => { this.eventWork = undefined; });
  }
  receiptsChanged(changed?: string) {
    for (const id of changed ? this.watches.has(changed) ? [changed] : [] : this.watches.keys()) void this.observe(id, false).catch(() => {});
  }
  private async recordFault(id: string, error: unknown) {
    if (!this.active()) return;
    const reason = (error instanceof Error ? error.message : "recorded observation failed").slice(0, 1024);
    console.error("[recorded checks] observation failed; original custody retained");
    try {
      const observation = servingObservation(), store = await this.store();
      try {
        const row = store.get(id);
        if (row && row.observerFault !== reason
          && (row.observation === null || digest(row.observation) === digest(observation)))
          await store.write({ ...row, revision: row.revision + 1, observerFault: reason }, row.revision, () => {
            if (!this.active() || digest(servingObservation()) !== digest(observation)) throw new Error("recorded observation fault lost serving authority");
          });
      } finally { store.close(); }
    } catch { console.error("[recorded checks] observation fault awaits durable reconciliation"); }
  }
  async observe(id: string, refreshResult = true): Promise<void> {
    if (!this.active()) return;
    if (refreshResult) this.resultRequested.add(id);
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
    catch (error) { await this.recordFault(id, error); throw error; }
    finally { this.pending.delete(id); }
  }
  private install(row: CheckRow) {
    if (this.stopped) return;
    const existing = this.watches.get(row.id);
    if (existing) {
      if (row.acknowledgement) {
        existing.watcher?.close(); existing.watcher = undefined;
        clearTimeout(existing.timer); existing.timer = undefined;
        this.faults.delete(row.id);
      }
      return;
    }
    if (this.watches.size >= 128) throw new Error("recorded check observer capacity is full");
    const watch: Watch = {};
    this.watches.set(row.id, watch);
    if (row.acknowledgement) return;
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
      const remaining = row.descriptor.deadlineUptimeMs + CUSTODY_CLEANUP_MS - custodyClock();
      if (remaining <= 0) wake();
      else { watch.timer = setTimeout(arm, Math.min(remaining, 2_147_483_647)); watch.timer.unref(); }
    };
    arm();
  }
  private async reconcile(id: string) {
    const refreshResult = this.resultRequested.delete(id);
    const store = await this.store();
    try {
      let row = store.get(id);
      if (!row || !this.active() || row.acknowledgement && (row.notification?.state === "delivered" || row.notification?.state === "failed")) { this.release(id); return; }
      this.install(row); // subscribe before the first receipt read
      const observation = servingObservation();
      const authority = () => {
        if (!this.active()) throw new Error("recorded check observer lost serving authority");
        if (digest(servingObservation()) !== digest(observation)) throw new Error("recorded check observer epoch changed");
      };
      if (digest(row.observation) !== digest(observation)) {
        const updated: CheckRow = { ...row, revision: row.revision + 1, observation };
        await store.write(updated, row.revision, authority); row = updated;
      }
      const fault = this.faults.get(id);
      if (fault && row.observerFault !== fault) {
        const updated: CheckRow = { ...row, revision: row.revision + 1, observerFault: fault };
        await store.write(updated, row.revision, authority); row = updated;
      }
      if (!row.acknowledgement && row.admission === "preparing") {
        try {
          row = await handoffRecordedCheck(row.binding.conversation, "reconcile-preparation", row.log,
            { binding: callingAttempt, verify: verifyLiveCustody, observe: async () => {} }, row.id);
        } catch (error) {
          const fresh = store.get(id)!;
          if (fresh.admission !== "preparing") { row = fresh; }
          else {
          const updated: CheckRow = { ...fresh, revision: fresh.revision + 1, admission: "refused",
            reason: (error instanceof Error ? error.message : "original preparation custody is unknown").slice(0, 1024) };
          await store.write(updated, fresh.revision, authority); row = updated;
          }
        }
      }
      if (!row.acknowledgement && row.admission === "accepted" && !row.result?.terminal) {
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
      const terminal = !row.acknowledgement && fs.existsSync(path.join(`${row.log}.gate`, "result.json"));
      const ownerAlive = !!row.acknowledgement || processIdentityMayRun(row.descriptor.recorder) && processIdentityMayRun(row.binding.host);
      if (!row.acknowledgement && (refreshResult || !row.result) && (terminal || !ownerAlive || row.admission === "refused" || custodyClock() >= row.descriptor.deadlineUptimeMs + CUSTODY_CLEANUP_MS)) {
        const retained = await retainResult(row), result = retained.result;
        if (row.result?.digest !== result.digest) {
          const updated: CheckRow = { ...row, revision: row.revision + 1, result, observerFault: fault ?? null };
          await store.write(updated, row.revision, () => { authority(); retained.assertUnchanged(); }); row = updated;
        }
      }
      if (!row.result || row.notification?.state === "delivered" || row.notification?.state === "failed") return;
      if (!row.notification) {
        const target = this.ports.recipient(row.binding.project);
        if (!target) return;
        const result = row.result;
        const notification: NonNullable<CheckRow["notification"]> = { key: `${seatMessageKeys.recordedCheck}${row.id}`, ...target,
          text: `[Delegatus] Recorded check ${row.id}: ${result.state}; command exit ${result.terminal?.report?.commandExit ?? "unknown"}; cleanup ${result.terminal?.report?.cleanup ?? "unknown"}; selection ${result.complete ? "complete" : "incomplete"}, ${result.completed}/${row.descriptor.manifest.selection.length} reported, ${result.failed} failing. Durable receipt: ${row.id}. Read its current revision before acknowledging evidence.`,
          operation: null, state: "reserved", reason: null, noDispatch: false };
        const updated: CheckRow = { ...row, revision: row.revision + 1, notification };
        await store.write(updated, row.revision, authority); row = updated;
      }
      if (row.notification!.noDispatch) {
        const target = this.ports.recipient(row.binding.project), notice = row.notification!;
        if (!target || digest([target.conversation, target.path, target.seatEpoch]) === digest([notice.conversation, notice.path, notice.seatEpoch])) return;
        // The last attempt explicitly refused before dispatch. Clear that proof
        // durably before the successor can receive this same completion key.
        const updated: CheckRow = { ...row, revision: row.revision + 1,
          notification: { ...notice, ...target, noDispatch: false, reason: null } };
        await store.write(updated, row.revision, () => {
          authority();
          if (digest(this.ports.recipient(row!.binding.project)) !== digest(target)) throw new Error("recorded completion recipient changed");
        });
        row = updated;
      }
      authority();
      const outcome = await this.ports.deliver(row);
      const delivered = { ...outcome, noDispatch: outcome.noDispatch === true };
      if (digest(delivered) !== digest({ operation: row.notification!.operation, state: row.notification!.state, reason: row.notification!.reason, noDispatch: row.notification!.noDispatch })) {
        const updated: CheckRow = { ...row, revision: row.revision + 1, notification: { ...row.notification!, ...delivered }, observerFault: fault ?? null };
        await store.write(updated, row.revision, authority);
        if (updated.acknowledgement && (delivered.state === "delivered" || delivered.state === "failed")) this.release(id);
      }
    } finally { store.close(); }
  }
  private release(id: string) { const watch = this.watches.get(id); watch?.watcher?.close(); clearTimeout(watch?.timer); this.watches.delete(id); this.faults.delete(id); this.resultRequested.delete(id); }
  stop() { this.stopped = true; this.stopWake?.(); this.directoryWatcher?.close(); for (const id of this.watches.keys()) this.release(id); }
}

export const productionObserverPorts: ObserverPorts = {
  active: servingRecordedChecks,
  recipient(project) {
    const seat = currentSeat(project);
    const generation = seat?.conversationId ? agentRegistry().conversation(seat.conversationId as ViewerConversationId)?.generations.at(-1) : null;
    return generation && seat?.conversationId ? { conversation: seat.conversationId, path: generation.path, seatEpoch: seat.seatEpoch } : null;
  },
  async deliver(row) {
    const observation = row.observation;
    const authority = () => {
      if (!servingRecordedChecks() || !observation || !sameRecordedProcessIdentity(observation.owner, captureProcessIdentity(process.pid))
        || digest(servingObservation()) !== digest(observation)) throw new Error("recorded completion lost serving authority or epoch");
    };
    authority();
    const notification = row.notification!;
    const original = lookupOriginalSend(agentRegistry().readOnlySnapshot(), { conversationId: notification.conversation, clientMessageId: notification.key });
    if (original.kind === "found") {
      const receipt = await resolveSendReceipt(original.operationId);
      return { operation: original.operationId, state: receipt?.state === "delivered" ? "delivered"
        : receipt?.state === "failed" ? "failed" : "uncertain", reason: receipt?.reason ?? null };
    }
    if (original.kind !== "absent") return { operation: notification.operation, state: "uncertain", reason: `original completion proof is ${original.kind}` };
    if (notification.state === "uncertain" || notification.operation) return { operation: notification.operation, state: "uncertain", reason: "original completion send awaits reconciliation" };
    const outcome = await deliverConversationMessage({ path: notification.path, conversationId: notification.conversation,
      pid: null, images: [],
      admissionGuard: authority, recoveryAuthorityGuard: authority,
      text: notification.text, clientMessageId: notification.key,
      origin: agentMessageOrigin(agentRegistry().conversationDeliverySnapshot({ conversationId: row.binding.conversation }), row.binding.conversation) });
    const operation = outcome.operationId ?? null;
    const receipt = operation ? await resolveSendReceipt(operation) : null;
    const refused = !outcome.ok && outcome.admission === "refused" && !operation && !outcome.actuation && !outcome.resend;
    return { operation, state: receipt?.state === "delivered" ? "delivered" : receipt?.state === "failed" ? "failed" : refused ? "reserved" : "uncertain",
      noDispatch: refused, reason: receipt ? receipt.reason : outcome.ok ? null : outcome.error.slice(0, 1024) };
  },
};
const shared = process as typeof process & { __delegatusRecordedObserver?: { filename: string; value: RecordedCheckObserver; ready: Promise<void> } };
export async function startRecordedCheckObserver() {
  const filename = statePath("state.sqlite");
  const existing = shared.__delegatusRecordedObserver;
  if (existing?.filename === filename) { await existing.ready; return existing.value; }
  shared.__delegatusRecordedObserver?.value.stop();
  const value = new RecordedCheckObserver(productionObserverPorts, filename);
  const entry = { filename, value, ready: Promise.resolve() };
  shared.__delegatusRecordedObserver = entry;
  entry.ready = value.start().catch(error => {
    value.stop();
    if (shared.__delegatusRecordedObserver === entry) shared.__delegatusRecordedObserver = undefined;
    throw error;
  });
  await entry.ready;
  return value;
}
export function notifyRecordedCheckObservers() { shared.__delegatusRecordedObserver?.value.receiptsChanged(); }
export function stopRecordedCheckObserver() { shared.__delegatusRecordedObserver?.value.stop(); shared.__delegatusRecordedObserver = undefined; }
export async function observeRecordedCheck(id: string) { const observer = await startRecordedCheckObserver(); await observer.observe(id); }
