import { createHash } from "node:crypto";
import type { executeOrchestratorRotation } from "@/lib/orchestrator/seatCommand";
import type { SeatTickCard } from "./types";
import { redactMonitorText } from "./redact";

export interface SeatHostRecovery {
  id: string;
  conversationId: string;
  seatEpoch: number;
  at: string;
  state: "revived" | "pending" | "rotated" | "failed" | "superseded";
  detail: string;
  told: boolean;
}

export interface SeatHostRecoveryPorts { rotate?: typeof executeOrchestratorRotation }

export function seatHostRecoveryKey(project: string, epoch: number, conversationId: string): string {
  return `seat-host-recovery-${createHash("sha256").update(JSON.stringify([project, epoch, conversationId])).digest("hex")}`;
}

export function normalizeSeatHostRecovery(value: unknown): SeatHostRecovery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Partial<SeatHostRecovery>;
  if (typeof v.id !== "string" || v.id.length > 200 || typeof v.conversationId !== "string"
    || !Number.isSafeInteger(v.seatEpoch) || typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))
    || !["revived", "pending", "rotated", "failed", "superseded"].includes(v.state ?? "") || typeof v.detail !== "string") return undefined;
  return { id: v.id, conversationId: v.conversationId, seatEpoch: v.seatEpoch!, at: v.at,
    state: v.state!, detail: redactMonitorText(v.detail).slice(0, 500), told: v.told === true };
}

export function seatHostRecoveryCard(record: SeatHostRecovery, locale: "uk" | "en"): SeatTickCard {
  const title = locale === "uk" ? "Відновлення оркестратора" : "Orchestrator recovery";
  const states = locale === "uk"
    ? { revived: "Сесію відновлено. Стан MCP перевірено повторно; повідомлення зберігає початковий ключ.",
      pending: "Сесію не вдалося відновити. Ротацію розпочато; недоставлена робота залишається в обліку.",
      rotated: "Сесію не вдалося відновити. Оркестратора замінено; недоставлена робота залишається заборгованою.",
      failed: "Відновлення та ротація не вдалися. Потрібна допомога оператора; недоставлена робота збережена.",
      superseded: "Під час відновлення оркестратора вже замінено. Недоставлена робота збережена." }
    : { revived: "The session was revived. MCP health was checked again; delivery keeps its original key.",
      pending: "Revival failed. Rotation started; undelivered work remains accounted for.",
      rotated: "Revival failed. The orchestrator was replaced; undelivered work remains owed.",
      failed: "Revival and rotation failed. Operator help is needed; undelivered work is preserved.",
      superseded: "The orchestrator changed during recovery. Undelivered work is preserved." };
  // A successful revival is already recorded in seat state. Resolving its
  // notice creates no task; failures still need an actionable board card.
  // Success has already been persisted in the seat state. Give its resolved
  // acknowledgement a separate key so replay cannot close a legacy notice
  // found by the old recovery key; resolved cards with no match create nothing.
  return { ref: record.state === "revived" ? "seat-host-recovery-success" : "seat-host-recovery", kind: "host-recovery", instance: record.id, state: record.state === "revived" ? "resolved" : "open",
    detail: `${title}\n${states[record.state]}`, record: `${record.at}: ${record.state}; ${record.detail}` };
}
