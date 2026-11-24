import type { EngineLimits } from "@/lib/types";

/** Antigravity CLI (`agy`) enforces a 5-hour (300-minute) rolling quota window. */
export const ANTIGRAVITY_QUOTA_WINDOW_MINUTES = 300;
const ANTIGRAVITY_QUOTA_WINDOW_SECONDS = ANTIGRAVITY_QUOTA_WINDOW_MINUTES * 60;
const MAX_RESET_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 300;

export interface AntigravityQuotaExhaustion {
  exhausted: true;
  /** Unix seconds when the quota window resets, or null if no duration/timestamp was present. */
  resetsAt: number | null;
  /** Quota window length in minutes (300 = 5 hours). */
  windowMinutes: number;
  usedPercent: 100;
  /** Unix seconds when the quota error was observed. */
  observedAt: number;
  /** Redacted single-line diagnostic summary suitable for transcripts and cards. */
  message: string;
}

export interface AntigravityLimitsMapping {
  limits: EngineLimits | null;
  active: boolean;
  expired: boolean;
}

const QUOTA_ERROR_PATTERNS: readonly RegExp[] = [
  /\bRESOURCE_EXHAUSTED\b/i,
  /\bIndividual quota reached\b/i,
  /\bquota\s+(?:has\s+been\s+)?(?:exhausted|reached|exceeded)\b/i,
  /\bexhausted\s+your\s+capacity\b/i,
];

const RESET_DURATION_PHRASE = /\b(?:resets?|try again|available)\s+in\s+([^.\n,;]+)/i;
const DURATION_TOKEN = /(\d+)\s*(?:(h(?:ours?|rs?)?)|(m(?:in(?:ute)?s?)?)|(s(?:ec(?:ond)?s?)?))\b/gi;
const ISO_TIMESTAMP_PATTERN = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\b/;

const EMAIL_REDACTION_PATTERN = new RegExp("\\b[A-Za-z0-9._%+-]+" + "@" + "[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b", "g");

/** Strips emails, tokens, and home-directory paths so persisted quota errors carry no PII. */
export function redactAntigravityQuotaMessage(raw: string): string {
  const cleaned = raw
    .replace(EMAIL_REDACTION_PATTERN, "[redacted-email]")
    .replace(/\b(?:Bearer|ya29\.[A-Za-z0-9._-]+|AIza[A-Za-z0-9_-]{20,})\b/g, "[redacted-token]")
    .replace(/(?:\/(?:home|Users)\/[^\s"'`]+|[A-Za-z]:\\Users\\[^\s"'`]+)/g, "[redacted-path]")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Antigravity quota reached";
  return cleaned.length > MAX_MESSAGE_CHARS ? `${cleaned.slice(0, MAX_MESSAGE_CHARS - 1)}…` : cleaned;
}

function parseDurationMs(segment: string): number | null {
  let totalMs = 0;
  let matchedAny = false;
  DURATION_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DURATION_TOKEN.exec(segment)) !== null) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    matchedAny = true;
    if (match[2]) totalMs += amount * 60 * 60 * 1000;
    else if (match[3]) totalMs += amount * 60 * 1000;
    else if (match[4]) totalMs += amount * 1000;
  }
  if (!matchedAny || totalMs <= 0 || totalMs > MAX_RESET_DURATION_MS) return null;
  return totalMs;
}

function parseResetSeconds(message: string, observedAtMs: number): number | null {
  const phraseMatch = RESET_DURATION_PHRASE.exec(message);
  if (phraseMatch?.[1]) {
    const durationMs = parseDurationMs(phraseMatch[1]);
    if (durationMs !== null) {
      return Math.floor((observedAtMs + durationMs) / 1000);
    }
  }
  const isoMatch = ISO_TIMESTAMP_PATTERN.exec(message);
  if (isoMatch?.[1]) {
    const parsedMs = Date.parse(isoMatch[1]);
    if (Number.isFinite(parsedMs) && parsedMs >= observedAtMs - 60_000 && parsedMs <= observedAtMs + MAX_RESET_DURATION_MS) {
      return Math.floor(parsedMs / 1000);
    }
  }
  return null;
}

/**
 * Pure parser for Antigravity CLI `RESOURCE_EXHAUSTED` / `"Individual quota reached"` errors.
 * Returns null for non-quota errors so transient network/RPC errors are never misclassified.
 */
export function parseAntigravityQuotaError(
  message: string,
  observedAtMs = Date.now(),
): AntigravityQuotaExhaustion | null {
  if (typeof message !== "string" || !message.trim()) return null;
  if (!QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return null;
  const safeObservedMs = Number.isFinite(observedAtMs) && observedAtMs > 0 ? observedAtMs : Date.now();
  return {
    exhausted: true,
    resetsAt: parseResetSeconds(message, safeObservedMs),
    windowMinutes: ANTIGRAVITY_QUOTA_WINDOW_MINUTES,
    usedPercent: 100,
    observedAt: Math.floor(safeObservedMs / 1000),
    message: redactAntigravityQuotaMessage(message),
  };
}

/**
 * Maps an observed Antigravity quota exhaustion onto {@link EngineLimits}.
 * Once `now >= resetsAt` (or one 5-hour window past `observedAt` when `resetsAt`
 * is unknown), the exhaustion expires and `limits` returns `null` rather than
 * continuing to report 100% exhausted.
 */
export function antigravityLimitsFromExhaustion(
  exhaustion: AntigravityQuotaExhaustion,
  options: { nowMs?: number; tierName?: string | null } = {},
): AntigravityLimitsMapping {
  const nowMs = options.nowMs ?? Date.now();
  const nowSec = Math.floor((Number.isFinite(nowMs) ? nowMs : Date.now()) / 1000);
  const windowMinutes = Number.isFinite(exhaustion.windowMinutes) && exhaustion.windowMinutes > 0
    ? Math.round(exhaustion.windowMinutes)
    : ANTIGRAVITY_QUOTA_WINDOW_MINUTES;
  const observedAt = Number.isFinite(exhaustion.observedAt) ? Math.floor(exhaustion.observedAt) : nowSec;
  const resetsAt = exhaustion.resetsAt !== null && Number.isFinite(exhaustion.resetsAt)
    ? Math.floor(exhaustion.resetsAt)
    : null;
  const expirySec = resetsAt !== null ? resetsAt : observedAt + ANTIGRAVITY_QUOTA_WINDOW_SECONDS;
  if (nowSec >= expirySec) {
    return { limits: null, active: false, expired: true };
  }
  return {
    active: true,
    expired: false,
    limits: {
      session: {
        usedPercent: 100,
        resetsAt,
        windowMinutes,
        observedAt,
        source: "account",
      },
      weekly: null,
      tiers: [],
      plan: options.tierName?.trim() || null,
      capturedAt: observedAt,
    },
  };
}
