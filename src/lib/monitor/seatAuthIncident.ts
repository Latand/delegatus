import fs from "node:fs";
import path from "node:path";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { accountManager } from "@/lib/accounts/manager";
import { durableStageTurnEvidence } from "@/lib/pipelines/durableEvidence";
import { classifyProviderCondition } from "@/lib/pipelines/providerConditions";
import type { SeatTickSeatInput } from "./types";
import { redactBounded } from "./redact";

export interface SeatTurnOutcome {
  engine: "claude" | "codex";
  accountId: string | null;
  path: string;
  auth: { ts: number; text: string } | null;
  normalTurnTs: number | null;
}

export interface SeatAuthIncident {
  id: string;
  seatEpoch: number;
  conversationId: string;
  engine: "claude" | "codex";
  accountId: string | null;
  firstFailedAt: string;
  lastFailedTs: number;
  credentialStamp: string | null;
  /** Retain the first failure for a notice retried after a lost state write. */
  text: string;
  rotation: {
    state: "pending" | "held" | "rotated" | "none-allowed" | "refused";
    toAccountId?: string;
    successorConversationId?: string;
    error?: string;
  };
  notice: { bridgeSeq?: number; telegram?: "sent" | "failed" | "skipped"; card: boolean } | null;
}

export function seatAuthAccounts(engine: SeatTurnOutcome["engine"]) {
  return engine === "claude" ? listClaudeAccounts() : listCodexAccounts();
}

export function seatAuthCredentialStamp(engine: SeatTurnOutcome["engine"], accountId: string | null): string | null {
  if (!accountId) return null;
  const account = seatAuthAccounts(engine).find((row) => row.id === accountId);
  if (!account) return null;
  try {
    const stat = fs.statSync(path.join(account.home, engine === "claude" ? ".credentials.json" : "auth.json"));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The same transcript and provider classification authority stages use. */
export async function readSeatTurnOutcome(engine: SeatTurnOutcome["engine"], transcript: string): Promise<SeatTurnOutcome> {
  const owner = accountManager.resolveTranscriptOwner(engine, transcript);
  const evidence = await durableStageTurnEvidence(engine, transcript);
  const message = evidence?.turn === "terminal" ? evidence.terminalProviderMessage : null;
  const auth = message && classifyProviderCondition(engine, message.errorClass, message.text)?.kind === "auth_required"
    ? { ts: message.ts, text: message.text } : null;
  return {
    engine, accountId: owner?.accountId ?? null, path: transcript, auth,
    normalTurnTs: evidence?.turn === "terminal" && !auth ? evidence.lastRecordAt ?? evidence.message?.ts ?? null : null,
  };
}

export function openSeatAuthIncident(project: string, seat: SeatTickSeatInput, outcome: SeatTurnOutcome, ignoredThrough = 0): SeatAuthIncident | null {
  if (!outcome.auth || outcome.auth.ts <= Math.max(Date.parse(seat.designatedAt ?? "") || 0, ignoredThrough)) return null;
  return {
    id: `seat-auth:${project}:${seat.seatEpoch}:${outcome.auth.ts}`,
    seatEpoch: seat.seatEpoch, conversationId: seat.conversationId,
    engine: outcome.engine, accountId: outcome.accountId,
    firstFailedAt: new Date(outcome.auth.ts).toISOString(), lastFailedTs: outcome.auth.ts,
    credentialStamp: seatAuthCredentialStamp(outcome.engine, outcome.accountId), text: outcome.auth.text,
    rotation: { state: "pending" }, notice: null,
  };
}

export function seatAuthIncidentRecovered(incident: SeatAuthIncident, seatEpoch: number | null, outcome: SeatTurnOutcome | null, stamp: string | null): boolean {
  return incident.seatEpoch !== seatEpoch
    || (outcome?.normalTurnTs ?? 0) > incident.lastFailedTs
    || stamp !== incident.credentialStamp;
}

const WORDS = {
  uk: {
    failed: "не зміг автентифікуватися", account: "акаунт", since: "з",
    login: "Виправлення: увійдіть в акаунт ще раз.",
    rotated: "Сесію автоматично перенесено з передачею на акаунт",
    parked: "Іншого дозволеного акаунта з вільним лімітом немає. Пробудження оркестратора призупинено.",
    refused: "Перенесення відхилено; пробудження оркестратора призупинено",
    outside: "Поза прив'язкою проєкту є акаунти", choice: "Додати один із них — ваше рішення; Delegatus нічого не додає.",
  },
  en: {
    failed: "could not authenticate", account: "account", since: "since",
    login: "Fix: log in to the account again.",
    rotated: "The seat was automatically moved with handoff to account",
    parked: "No other allowed account has capacity. Orchestrator wakes are paused.",
    refused: "The move was refused; orchestrator wakes are paused",
    outside: "Accounts outside the project binding", choice: "Adding one is your decision; Delegatus adds nothing.",
  },
};

export function seatAuthNotice(incident: SeatAuthIncident, labels: Map<string, string>, outside: string[], locale: "uk" | "en", projectName?: string) {
  const words = WORDS[locale];
  const label = (id: string | null | undefined) => id ? labels.get(id) ?? "?" : "?";
  const engine = incident.engine === "claude" ? "Claude" : "Codex";
  const summary = `Delegatus: ${projectName ? `«${projectName.slice(0, 36)}» · ` : ""}${engine} ${words.failed}`;
  const failure = `${engine}, ${words.account} «${label(incident.accountId)}»: «${redactBounded(incident.text, 160)}» (${words.since} ${incident.firstFailedAt}).`;
  const action = incident.rotation.state === "rotated"
    ? `${words.rotated} «${label(incident.rotation.toAccountId)}». ${words.login}`
    : incident.rotation.state === "refused"
      ? `${words.refused}: ${redactBounded(incident.rotation.error ?? "?", 160)}. ${words.login}`
      : `${words.parked} ${words.login}`;
  const pool = outside.length && incident.rotation.state !== "rotated"
    ? `${words.outside}: ${outside.map((id) => `«${label(id)}»`).join(", ")}. ${words.choice}` : "";
  return { summary, failure, action, pool, body: [summary, failure, action, pool].filter(Boolean).join("\n") };
}

/** Invalid persisted data cannot acquire a wake fence. */
export function normalizeSeatAuthIncident(value: unknown): SeatAuthIncident | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as SeatAuthIncident;
  if (typeof row.id !== "string" || !row.id.startsWith("seat-auth:") || !Number.isSafeInteger(row.seatEpoch)
    || typeof row.conversationId !== "string" || !["claude", "codex"].includes(row.engine)
    || (row.accountId !== null && typeof row.accountId !== "string")
    || !Number.isFinite(row.lastFailedTs) || !Number.isFinite(Date.parse(row.firstFailedAt))
    || (row.credentialStamp !== null && typeof row.credentialStamp !== "string")
    || typeof row.text !== "string" || !row.rotation
    || !["pending", "held", "rotated", "none-allowed", "refused"].includes(row.rotation.state)
    || (row.notice !== null && (!row.notice || typeof row.notice.card !== "boolean"))) return undefined;
  return row;
}
