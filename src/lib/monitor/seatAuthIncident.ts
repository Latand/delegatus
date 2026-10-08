import { seatAuthCredentialStamp, seatAuthCredentialsChanged } from "@/lib/accounts/seatAuthCredentials";
export { seatAuthCredentialStamp, seatAuthCredentialChangedAt, seatAuthCredentialsChanged } from "@/lib/accounts/seatAuthCredentials";
import { listClaudeAccounts, claudeHomeOwningTranscript } from "@/lib/accounts/claude";
import { listCodexAccounts, codexHomeOwningSessionPath } from "@/lib/accounts/codex";
import { agentRegistry } from "@/lib/agent/registry";
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

export interface SeatAuthCardNotice {
  id: string;
  detail: string;
  state: "open" | "resolved";
}

export function normalizeSeatAuthCardNotice(value: unknown): SeatAuthCardNotice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<SeatAuthCardNotice>;
  return typeof row.id === "string" && row.id.startsWith("seat-auth:") && typeof row.detail === "string"
    && (row.state === "open" || row.state === "resolved") ? { id: row.id, detail: row.detail, state: row.state } : null;
}

export interface SeatAuthTelegramNotice {
  id: string;
  chat: string;
  html: string;
  topicId?: number;
}

export function normalizeSeatAuthTelegramNotice(value: unknown): SeatAuthTelegramNotice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.startsWith("seat-auth:") || row.id.length > 512
    || typeof row.chat !== "string" || !row.chat || typeof row.html !== "string" || !row.html) return null;
  if (row.topicId !== undefined && (typeof row.topicId !== "number" || !Number.isSafeInteger(row.topicId) || row.topicId <= 0)) return null;
  return { id: row.id, chat: row.chat, html: row.html, ...(typeof row.topicId === "number" ? { topicId: row.topicId } : {}) };
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
  /** Authentication is recovered while its drain-held notice remains owed. */
  recoveredThrough?: number;
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

/** The same transcript and provider classification authority stages use. */
export async function readSeatTurnOutcome(engine: SeatTurnOutcome["engine"], transcript: string): Promise<SeatTurnOutcome> {
  const evidence = await durableStageTurnEvidence(engine, transcript);
  // Attribution is a transcript read, independent of whether the account's
  // current credentials may launch a process. Preserve registry ownership
  // and the existing path fallback without constructing a spawn context.
  const recorded = agentRegistry().transcriptAccountId(engine, transcript);
  const home = recorded ? null : engine === "claude" ? claudeHomeOwningTranscript(transcript) : codexHomeOwningSessionPath(transcript);
  const accountId = recorded ?? (home ? seatAuthAccounts(engine).find((account) => account.home === home)?.id : null) ?? null;
  const message = evidence?.turn === "terminal" ? evidence.terminalProviderMessage : null;
  const auth = message && classifyProviderCondition(engine, message.errorClass, message.text)?.kind === "auth_required"
    ? { ts: message.ts, text: message.text } : null;
  return {
    engine, accountId, path: transcript, auth,
    normalTurnTs: evidence?.turn === "terminal" && evidence.message && !message ? evidence.message.ts : null,
  };
}

export function openSeatAuthIncident(project: string, seat: SeatTickSeatInput, outcome: SeatTurnOutcome, ignoredThrough = 0, stamp?: string | null): SeatAuthIncident | null {
  if (!outcome.auth || outcome.auth.ts <= Math.max(Date.parse(seat.designatedAt ?? "") || 0, ignoredThrough)) return null;
  const id = `seat-auth:${project}:${seat.seatEpoch}:${outcome.auth.ts}`;
  const credentialStamp = stamp === undefined ? seatAuthCredentialStamp(outcome.engine, outcome.accountId, id) : stamp;
  return {
    id,
    seatEpoch: seat.seatEpoch, conversationId: seat.conversationId,
    engine: outcome.engine, accountId: outcome.accountId,
    firstFailedAt: new Date(outcome.auth.ts).toISOString(), lastFailedTs: outcome.auth.ts,
    credentialStamp, text: outcome.auth.text,
    rotation: { state: "pending" }, notice: null,
  };
}

export function seatAuthIncidentRecovered(incident: SeatAuthIncident, seatEpoch: number | null, outcome: SeatTurnOutcome | null, stamp: string | null): boolean {
  return incident.seatEpoch !== seatEpoch
    || (outcome?.normalTurnTs ?? 0) > incident.lastFailedTs
    || seatAuthCredentialsChanged(incident.credentialStamp, stamp);
}

const WORDS = {
  uk: {
    failed: "не зміг автентифікуватися", account: "акаунт", since: "з",
    login: "Виправлення: увійдіть в акаунт ще раз.",
    rotated: "Сесію автоматично перенесено з передачею на акаунт",
    recovered: "Автентифікацію відновлено; пробудження оркестратора поновлено.",
    parked: "Іншого дозволеного акаунта з вільним лімітом немає. Пробудження оркестратора призупинено.",
    refused: "Перенесення відхилено; пробудження оркестратора призупинено",
    outside: "Поза прив'язкою проєкту є акаунти", choice: "Додати один із них — ваше рішення; Delegatus нічого не додає.",
  },
  en: {
    failed: "could not authenticate", account: "account", since: "since",
    login: "Fix: log in to the account again.",
    rotated: "The seat was automatically moved with handoff to account",
    recovered: "Authentication recovered; orchestrator wakes resumed.",
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
  const action = incident.recoveredThrough !== undefined
    ? `${words.recovered} ${words.login}`
    : incident.rotation.state === "rotated"
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
    || (row.recoveredThrough !== undefined && (!Number.isFinite(row.recoveredThrough) || row.recoveredThrough < row.lastFailedTs))
    || typeof row.text !== "string" || !row.rotation
    || !["pending", "held", "rotated", "none-allowed", "refused"].includes(row.rotation.state)
    || (row.notice !== null && (!row.notice || typeof row.notice.card !== "boolean"))) return undefined;
  return row;
}
