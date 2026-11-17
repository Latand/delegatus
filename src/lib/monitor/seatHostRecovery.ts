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
      fresh one; nothing was rotated and the next attempt waits for `retryAt`.
      `unstable`: the seat tick started a fresh host, but the hosts of
      `SEAT_HOST_REVIVAL_LOST_BOUND` earlier revivals in this episode were lost
      again before a check confirmed them, so its card stays open. */
  state: "revived" | "pending" | "rotated" | "failed" | "superseded" | "unrevived" | "unstable";
  detail: string;
  told: boolean;
  /** Host-loss revivals in the current episode, counting this one. Absent on
      records written by the wake recovery paths. */
  attempts?: number;
  /** The earliest instant the seat tick may attempt the next host-loss revival. */
  retryAt?: string;
  /** Revivals in the current episode whose host was lost again before a check
      confirmed it. */
  lost?: number;
  /** When a check saw the revived host still alive a settle window after the
      revival. Only a confirmed revival ends its episode. */
  confirmedAt?: string;
}

export interface SeatHostRecoveryPorts { rotate?: typeof executeOrchestratorRotation }

/** The host-only revival the seat tick runs when a designated seat's host is
    gone: the shared structured recovery with an empty prompt, so no model turn. */
export type SeatHostRevival = typeof recoverDeadStructuredConversation;

/** Stop origins (`HostExitRecord.stop.path`) that sever a seat rather than
    stop it on purpose: the release handover's cut; the new release's cleanup
    of a host it could not adopt or checkpoint; a host that cleaned itself up
    after its own stream or protocol failed (`*-host-fault`); and the reaping
    of an orphan whose stream is already gone, which the new release's startup
    demotion does to a predecessor's host it could not adopt. An exit with no
    stop record (stdin closed, crash) is a severance too. Every other recorded
    stop is a deliberate control (kill, reconfigure, recovery hand-off, idle
    retirement, migration release, memory enforcement) whose owner decides
    what comes next. A host that faults soon after every start keeps one
    episode, because only a check that finds a revived host alive a settle
    window later confirms it: its backoff keeps doubling to the hour cap, and
    from the `SEAT_HOST_REVIVAL_LOST_BOUND`-th lost revival on, its record is
    `unstable` and its card stays open. */
export const SEVERING_HOST_STOPS: ReadonlySet<string> = new Set(["deploy-cut", "startup-adoption-cleanup", "host-checkpoint-failure",
  "claude-host-fault", "codex-host-fault", "structured-orphan-stop"]);

/** The wait before the next host-loss revival: one check interval, doubling
    with each attempt in the episode, never more than an hour. */
export function seatHostRevivalBackoffMs(attempts: number, checkIntervalMs: number): number {
  return Math.min(checkIntervalMs * 2 ** Math.max(0, Math.min(attempts, 20) - 1), 60 * 60_000);
}

/** A revived host is confirmed by the first check that finds it alive at
    least this long after its revival. A host lost before that continues the
    same episode, so its attempts keep backing off instead of starting over. */
export const SEAT_HOST_REVIVAL_SETTLE_MS = 30 * 60_000;

/** Lost revivals in one episode before the next revival is carded `unstable`. */
export const SEAT_HOST_REVIVAL_LOST_BOUND = 3;

/** States whose host-loss card is open: a revival that could not start a host,
    or one whose hosts keep getting lost. */
export function hostLossNoticeOpen(state: SeatHostRecovery["state"]): boolean {
  return state === "unrevived" || state === "unstable";
}

export function seatHostRecoveryKey(project: string, epoch: number, conversationId: string): string {
  return `seat-host-recovery-${createHash("sha256").update(JSON.stringify([project, epoch, conversationId])).digest("hex")}`;
}

export function normalizeSeatHostRecovery(value: unknown): SeatHostRecovery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<SeatHostRecovery>;
  if (typeof v.id !== "string" || v.id.length > 200 || typeof v.conversationId !== "string"
    || !Number.isSafeInteger(v.seatEpoch) || typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))
    || !["revived", "pending", "rotated", "failed", "superseded", "unrevived", "unstable"].includes(v.state ?? "") || typeof v.detail !== "string") return undefined;
  const attempts = Number.isSafeInteger(v.attempts) && v.attempts! > 0 ? v.attempts! : undefined;
  const retryAt = typeof v.retryAt === "string" && Number.isFinite(Date.parse(v.retryAt)) ? v.retryAt : undefined;
  const lost = Number.isSafeInteger(v.lost) && v.lost! > 0 ? v.lost! : undefined;
  const confirmedAt = typeof v.confirmedAt === "string" && Number.isFinite(Date.parse(v.confirmedAt)) ? v.confirmedAt : undefined;
  return { id: v.id, conversationId: v.conversationId, seatEpoch: v.seatEpoch!, at: v.at,
    state: v.state!, detail: redactMonitorText(v.detail).slice(0, 500), told: v.told === true,
    ...(attempts ? { attempts } : {}), ...(retryAt ? { retryAt } : {}), ...(lost ? { lost } : {}), ...(confirmedAt ? { confirmedAt } : {}) };
}

export function seatHostRecoveryCard(record: SeatHostRecovery, locale: "uk" | "en"): SeatTickCard {
  const title = locale === "uk" ? "Відновлення оркестратора" : "Orchestrator recovery";
  const states = locale === "uk"
    ? { revived: "Сесію відновлено. Стан MCP перевірено повторно; повідомлення зберігає початковий ключ.",
      pending: "Сесію не вдалося відновити. Ротацію розпочато; недоставлена робота залишається в обліку.",
      rotated: "Сесію не вдалося відновити. Оркестратора замінено; недоставлена робота залишається заборгованою.",
      failed: "Відновлення та ротація не вдалися. Потрібна допомога оператора; недоставлена робота збережена.",
      superseded: "Під час відновлення оркестратора вже замінено. Недоставлена робота збережена.",
      unrevived: "Хост оркестратора зник, і запустити новий не вдалося. Наступна спроба буде автоматичною; можна також відновити або ротувати вручну.",
      unstable: "Хост оркестратора знову зникає після кожного відновлення. Спроби тривають автоматично з дедалі довшою паузою; варто перевірити сесію або ротувати її." }
    : { revived: "The session was revived. MCP health was checked again; delivery keeps its original key.",
      pending: "Revival failed. Rotation started; undelivered work remains accounted for.",
      rotated: "Revival failed. The orchestrator was replaced; undelivered work remains owed.",
      failed: "Revival and rotation failed. Operator help is needed; undelivered work is preserved.",
      superseded: "The orchestrator changed during recovery. Undelivered work is preserved.",
      unrevived: "The orchestrator's host is gone and a fresh one could not be started. The next attempt is automatic; it can also be resumed or rotated by hand.",
      unstable: "The orchestrator's host is lost again after every revival. Attempts continue automatically with a growing pause; check the session or rotate it." };
  // A successful revival is already recorded in seat state. Resolving its
  // notice creates no task; failures still need an actionable board card.
  // Success has already been persisted in the seat state. Give its resolved
  // acknowledgement a separate key so replay cannot close a legacy notice
  // found by the old recovery key; resolved cards with no match create nothing.
  return { ref: record.state === "revived" ? "seat-host-recovery-success" : "seat-host-recovery", kind: "host-recovery", instance: record.id, state: record.state === "revived" ? "resolved" : "open",
    detail: `${title}\n${states[record.state]}`, record: `${record.at}: ${record.state}; ${record.detail}${record.retryAt && hostLossNoticeOpen(record.state) ? `; next attempt ${record.retryAt}` : ""}` };
}
