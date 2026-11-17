import { createHash } from "node:crypto";
import type { executeOrchestratorRotation } from "@/lib/orchestrator/seatCommand";
import type { recoverDeadStructuredConversation } from "@/lib/runtime/structuredRecovery";
import type { SeatTickCard } from "./types";
import { redactMonitorText } from "./redact";

export interface SeatHostRecovery {
  id: string;
  conversationId: string;
  seatEpoch: number;
  at: string;
  /** `unrevived`: the seat tick found the host gone and could not start a
      fresh one; nothing was rotated and the next attempt waits for `retryAt`. */
  state: "revived" | "pending" | "rotated" | "failed" | "superseded" | "unrevived";
  detail: string;
  told: boolean;
  /** Host-loss revivals in the current episode, counting this one. Absent on
      records written by the wake recovery paths. */
  attempts?: number;
  /** The earliest instant the seat tick may attempt the next host-loss revival. */
  retryAt?: string;
}

export interface SeatHostRecoveryPorts { rotate?: typeof executeOrchestratorRotation }

/** The host-only revival the seat tick runs when a designated seat's host is
    gone: the shared structured recovery with an empty prompt, so no model turn. */
export type SeatHostRevival = typeof recoverDeadStructuredConversation;

/** Stop origins (`HostExitRecord.stop.path`) that sever a seat rather than
    stop it on purpose: the release handover's cut, and the new release's
    cleanup of a host it could not adopt or checkpoint. An exit with no stop
    record (stdin closed, crash) is a severance too. Every other recorded stop
    is a deliberate control (kill, reconfigure, recovery hand-off, process
    reaping) whose owner decides what comes next. */
export const SEVERING_HOST_STOPS: ReadonlySet<string> = new Set(["deploy-cut", "startup-adoption-cleanup", "host-checkpoint-failure"]);

/** The wait before the next host-loss revival: one check interval, doubling
    with each attempt in the episode, never more than an hour. */
export function seatHostRevivalBackoffMs(attempts: number, checkIntervalMs: number): number {
  return Math.min(checkIntervalMs * 2 ** Math.max(0, Math.min(attempts, 20) - 1), 60 * 60_000);
}

/** A revived host that is lost again within this window continues the same
    episode, so its attempts keep backing off instead of starting over. */
export const SEAT_HOST_REVIVAL_SETTLE_MS = 30 * 60_000;

export function seatHostRecoveryKey(project: string, epoch: number, conversationId: string): string {
  return `seat-host-recovery-${createHash("sha256").update(JSON.stringify([project, epoch, conversationId])).digest("hex")}`;
}

export function normalizeSeatHostRecovery(value: unknown): SeatHostRecovery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<SeatHostRecovery>;
  if (typeof v.id !== "string" || v.id.length > 200 || typeof v.conversationId !== "string"
    || !Number.isSafeInteger(v.seatEpoch) || typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))
    || !["revived", "pending", "rotated", "failed", "superseded", "unrevived"].includes(v.state ?? "") || typeof v.detail !== "string") return undefined;
  const attempts = Number.isSafeInteger(v.attempts) && v.attempts! > 0 ? v.attempts! : undefined;
  const retryAt = typeof v.retryAt === "string" && Number.isFinite(Date.parse(v.retryAt)) ? v.retryAt : undefined;
  return { id: v.id, conversationId: v.conversationId, seatEpoch: v.seatEpoch!, at: v.at,
    state: v.state!, detail: redactMonitorText(v.detail).slice(0, 500), told: v.told === true,
    ...(attempts ? { attempts } : {}), ...(retryAt ? { retryAt } : {}) };
}

export function seatHostRecoveryCard(record: SeatHostRecovery, locale: "uk" | "en"): SeatTickCard {
  const title = locale === "uk" ? "Відновлення оркестратора" : "Orchestrator recovery";
  const states = locale === "uk"
    ? { revived: "Сесію відновлено. Стан MCP перевірено повторно; повідомлення зберігає початковий ключ.",
      pending: "Сесію не вдалося відновити. Ротацію розпочато; недоставлена робота залишається в обліку.",
      rotated: "Сесію не вдалося відновити. Оркестратора замінено; недоставлена робота залишається заборгованою.",
      failed: "Відновлення та ротація не вдалися. Потрібна допомога оператора; недоставлена робота збережена.",
      superseded: "Під час відновлення оркестратора вже замінено. Недоставлена робота збережена.",
      unrevived: "Хост оркестратора зник, і запустити новий не вдалося. Наступна спроба буде автоматичною; можна також відновити або ротувати вручну." }
    : { revived: "The session was revived. MCP health was checked again; delivery keeps its original key.",
      pending: "Revival failed. Rotation started; undelivered work remains accounted for.",
      rotated: "Revival failed. The orchestrator was replaced; undelivered work remains owed.",
      failed: "Revival and rotation failed. Operator help is needed; undelivered work is preserved.",
      superseded: "The orchestrator changed during recovery. Undelivered work is preserved.",
      unrevived: "The orchestrator's host is gone and a fresh one could not be started. The next attempt is automatic; it can also be resumed or rotated by hand." };
  // A successful revival is already recorded in seat state. Resolving its
  // notice creates no task; failures still need an actionable board card.
  // Success has already been persisted in the seat state. Give its resolved
  // acknowledgement a separate key so replay cannot close a legacy notice
  // found by the old recovery key; resolved cards with no match create nothing.
  return { ref: record.state === "revived" ? "seat-host-recovery-success" : "seat-host-recovery", kind: "host-recovery", instance: record.id, state: record.state === "revived" ? "resolved" : "open",
    detail: `${title}\n${states[record.state]}`, record: `${record.at}: ${record.state}; ${record.detail}${record.retryAt && record.state === "unrevived" ? `; next attempt ${record.retryAt}` : ""}` };
}
