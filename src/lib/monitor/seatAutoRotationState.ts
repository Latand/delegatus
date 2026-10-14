import { redactMonitorText } from "./redact";
import type { SeatAutoRotationState } from "./seatAutoRotation";

/** Old rows have no field. Refuse malformed attempts rather than invent a clock. */
export function normalizeSeatAutoRotation(value: unknown): SeatAutoRotationState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<SeatAutoRotationState>;
  const epochTime = (v: SeatAutoRotationState["overSince"]) => v && Number.isSafeInteger(v.seatEpoch)
    && typeof v.at === "string" && Number.isFinite(Date.parse(v.at)) ? { seatEpoch: v.seatEpoch, at: v.at } : undefined;
  const a = raw.lastAttempt;
  const lastAttempt = a && typeof a.id === "string" && a.id.length <= 600 && typeof a.conversationId === "string"
    && Number.isSafeInteger(a.seatEpoch) && typeof a.startedAt === "string" && Number.isFinite(Date.parse(a.startedAt))
    && Number.isFinite(a.tokens) && a.tokens >= 0 && Number.isFinite(a.windowTokens) && a.windowTokens > 0
    && Number.isInteger(a.thresholdPercent) && a.thresholdPercent >= 50 && a.thresholdPercent <= 90
    && ["pending", "rotated", "failed", "superseded"].includes(a.state)
    ? { id: a.id, seatEpoch: a.seatEpoch, conversationId: a.conversationId, startedAt: a.startedAt,
      ...(typeof a.cooldownAt === "string" && Number.isFinite(Date.parse(a.cooldownAt)) ? { cooldownAt: a.cooldownAt } : {}),
      tokens: a.tokens, windowTokens: a.windowTokens, thresholdPercent: a.thresholdPercent, state: a.state,
      ...(typeof a.successorConversationId === "string" ? { successorConversationId: a.successorConversationId } : {}),
      ...(typeof a.error === "string" ? { error: redactMonitorText(a.error).slice(0, 500) } : {}),
      told: { report: a.told?.report === true, card: a.told?.card === true } } : undefined;
  const f = raw.failureTold;
  return { overSince: epochTime(raw.overSince), nudged: epochTime(raw.nudged), lastAttempt,
    ...(f && Number.isSafeInteger(f.seatEpoch) && typeof f.id === "string" && typeof f.resolved === "boolean"
      ? { failureTold: { seatEpoch: f.seatEpoch, id: f.id, resolved: f.resolved } } : {}) };
}
