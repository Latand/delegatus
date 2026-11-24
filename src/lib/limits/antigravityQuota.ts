import type { EngineLimits, LimitWindow } from "@/lib/types";

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

/** Transient burst/throughput throttles (e.g. RPM/TPM 429s and per-minute metric
 * limits) that can be retried after seconds and MUST NOT be misclassified as
 * 5-hour account quota exhaustion. Checked BEFORE any positive quota match. */
const TRANSIENT_RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\bper[\s_-]?(?:minute|min|second|sec)\b/i,
  /(?:requests?|tokens?|queries|input|output|generatecontent\w*)per(?:minute|second)/i,
  /\b(?:requests?|tokens?|queries)\s+per\s+(?:minute|second)\b/i,
  /\b(?:rpm|tpm|qpm|qps|rps)\b/i,
  /\brate[\s_-]*limit(?:ed|ing|s)?\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\b(?:burst|throttl(?:ed|ing))\b/i,
  /\bper[\s_-]?project\b/i,
];

/** Explicit individual/account quota exhaustion messages from Antigravity (`agy`).
 * Bare `RESOURCE_EXHAUSTED` or generic `quota exceeded` alone is insufficient
 * because Google APIs also use those strings for short-lived per-minute/project
 * request limits. */
const QUOTA_ERROR_PATTERNS: readonly RegExp[] = [
  /\bIndividual\s+quota\s+(?:reached|exhausted|exceeded)\b/i,
  /\b(?:your|account|user|personal|usage|antigravity)\s+quota\s+(?:has\s+been\s+)?(?:exhausted|reached|exceeded)\b/i,
  /\bquota\s+(?:has\s+been\s+)?(?:exhausted|reached|exceeded)\s+for\s+(?:your\s+)?(?:account|user|plan|tier)\b/i,
  /\bexhausted\s+your\s+(?:capacity|quota)\b/i,
  /\byour\s+quota\s+will\s+reset\b/i,
  /\bquota\s+(?:has\s+been\s+)?(?:exhausted|reached|exceeded)\b(?=.*(?:\bresets?\s+(?:in|after|at)\b|\buntil\s+\d{4}-\d{2}-\d{2}T|\b(?:5[\s-]?hour|five[\s-]?hour)\b))/i,
];

const RESET_DURATION_PHRASE = /\b(?:(?:resets?|try\s+again|available)\s+in|reset\s+after)\s+([^.\n,;]+)/i;
const DURATION_SEQUENCE = /^(?:(?:about|approximately)\s+)?((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])(?:\s*(?:and\s+)?)?)+)(.*)$/i;
const DURATION_UNIT_TOKEN = /(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;
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

/** Parses a complete reset duration (`2h 15m 30s`, `2h15m30s`, `1 hour 5 minutes`).
 * Rejects malformed or partially parsed intervals instead of returning only a tail component. */
function parseDurationMs(segment: string): number | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;
  const seq = DURATION_SEQUENCE.exec(trimmed);
  if (!seq?.[1]) return null;
  const matchedSpan = seq[1];
  const remainder = seq[2] ?? "";
  // Trailing text must either be empty or whitespace-separated prose containing no digits
  // (e.g. " for gemini-4-neon"), never an unparsed duration chunk like "15x30s".
  if (remainder.length > 0 && (!/^[\s)\]]/.test(remainder) || /\d/.test(remainder))) {
    return null;
  }

  let totalMs = 0;
  let matchedAny = false;
  let lastIndex = 0;
  const seenUnits = new Set<string>();
  DURATION_UNIT_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DURATION_UNIT_TOKEN.exec(matchedSpan)) !== null) {
    const gap = matchedSpan.slice(lastIndex, match.index);
    if (gap.length > 0 && !/^\s*(?:and\s+)?$/i.test(gap)) return null;
    const amount = Number(match[1]);
    const unitRaw = match[2]!.toLowerCase();
    const unit = unitRaw.startsWith("d") ? "d"
      : unitRaw.startsWith("h") ? "h"
        : unitRaw.startsWith("m") ? "m"
          : "s";
    if (!Number.isFinite(amount) || amount < 0 || seenUnits.has(unit)) return null;
    seenUnits.add(unit);
    matchedAny = true;
    if (unit === "d") totalMs += amount * 24 * 60 * 60 * 1000;
    else if (unit === "h") totalMs += amount * 60 * 60 * 1000;
    else if (unit === "m") totalMs += amount * 60 * 1000;
    else totalMs += amount * 1000;
    lastIndex = match.index + match[0].length;
  }
  const trailingInSpan = matchedSpan.slice(lastIndex);
  if (trailingInSpan.length > 0 && !/^\s*$/.test(trailingInSpan)) return null;
  if (!matchedAny || totalMs <= 0 || totalMs > MAX_RESET_DURATION_MS) return null;
  return totalMs;
}

export function parseAntigravityResetSeconds(message: string, observedAtMs: number): number | null {
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
 * Pure parser for explicit Antigravity CLI individual/account quota exhaustion errors.
 * Returns null for transient per-minute/burst rate limits and non-quota RPC/network errors.
 */
export function parseAntigravityQuotaError(
  message: string,
  observedAtMs = Date.now(),
): AntigravityQuotaExhaustion | null {
  if (typeof message !== "string" || !message.trim()) return null;
  if (TRANSIENT_RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) return null;
  if (!QUOTA_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return null;
  const safeObservedMs = Number.isFinite(observedAtMs) && observedAtMs > 0 ? observedAtMs : Date.now();
  return {
    exhausted: true,
    resetsAt: parseAntigravityResetSeconds(message, safeObservedMs),
    windowMinutes: ANTIGRAVITY_QUOTA_WINDOW_MINUTES,
    usedPercent: 100,
    observedAt: Math.floor(safeObservedMs / 1000),
    message: redactAntigravityQuotaMessage(message),
  };
}

/** Unix-second expiry cutoff for an Antigravity session quota window.
 * Uses explicit `resetsAt` when available; otherwise `observedAt + windowMinutes * 60`
 * (defaulting to the 5-hour / 300-minute window). */
export function antigravitySessionWindowExpiresAt(
  session: Pick<LimitWindow, "resetsAt" | "observedAt" | "windowMinutes">,
): number | null {
  if (session.resetsAt !== null && Number.isFinite(session.resetsAt)) {
    return Math.floor(session.resetsAt);
  }
  if (session.observedAt != null && Number.isFinite(session.observedAt)) {
    const windowMinutes = typeof session.windowMinutes === "number"
      && Number.isFinite(session.windowMinutes)
      && session.windowMinutes > 0
      ? Math.round(session.windowMinutes)
      : ANTIGRAVITY_QUOTA_WINDOW_MINUTES;
    return Math.floor(session.observedAt) + windowMinutes * 60;
  }
  return null;
}

/** Shared active-window check across `/api/limits`, `QuotaController`, `accountManager.status`,
 * MCP `account_limits`, and `AntigravityFooterRow` so every surface expires identically. */
export function isAntigravitySessionWindowActive(
  session: Pick<LimitWindow, "resetsAt" | "observedAt" | "windowMinutes"> | null | undefined,
  nowSec: number,
): boolean {
  if (!session) return false;
  const expiresAt = antigravitySessionWindowExpiresAt(session);
  if (expiresAt === null) return false;
  return nowSec < expiresAt;
}

/** Unix-second high-water mark of the newest actual Antigravity quota exhaustion
 * event recorded on an observation. Keeps the event clock (`lastQuotaEventAt` /
 * `limits.capturedAt` / `limits.session.observedAt`) strictly separate from the
 * poll clock (`observedAt`) so an empty poll or reset decision can never advance
 * the event clock and hide a genuine exhaustion that occurred before that poll. */
export function antigravityObservationEventSec(obs: {
  lastQuotaEventAt?: number;
  limits: { capturedAt?: number | null; session?: { observedAt?: number | null } | null } | null;
  observedAt?: string | number;
  provenance?: { reason?: string | null };
} | null | undefined): number | null {
  if (!obs) return null;
  let best = -Infinity;
  if (typeof obs.lastQuotaEventAt === "number" && Number.isFinite(obs.lastQuotaEventAt) && obs.lastQuotaEventAt > 0) {
    best = Math.max(best, Math.floor(obs.lastQuotaEventAt));
  }
  if (obs.limits) {
    if (typeof obs.limits.capturedAt === "number" && Number.isFinite(obs.limits.capturedAt) && obs.limits.capturedAt > 0) {
      best = Math.max(best, Math.floor(obs.limits.capturedAt));
    }
    if (typeof obs.limits.session?.observedAt === "number" && Number.isFinite(obs.limits.session.observedAt) && obs.limits.session.observedAt > 0) {
      best = Math.max(best, Math.floor(obs.limits.session.observedAt));
    }
    // Legacy fallback only when neither `lastQuotaEventAt` nor `limits` event timestamps exist.
    if (!Number.isFinite(best) && obs.observedAt !== undefined) {
      const ms = typeof obs.observedAt === "number" ? obs.observedAt : Date.parse(obs.observedAt);
      if (Number.isFinite(ms) && ms > 0) best = Math.floor(ms / 1000);
    }
  } else if (!Number.isFinite(best) && obs.provenance?.reason === "antigravity quota reset window elapsed" && obs.observedAt !== undefined) {
    // Legacy fallback only for pre-`lastQuotaEventAt` reset rows.
    const ms = typeof obs.observedAt === "number" ? obs.observedAt : Date.parse(obs.observedAt);
    if (Number.isFinite(ms) && ms > 0) best = Math.floor(ms / 1000);
  }
  return Number.isFinite(best) && best > 0 ? best : null;
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
  const expirySec = resetsAt !== null ? resetsAt : observedAt + (windowMinutes > 0 ? windowMinutes * 60 : ANTIGRAVITY_QUOTA_WINDOW_SECONDS);
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
