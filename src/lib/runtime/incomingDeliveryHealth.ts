/** Constant-size recipient health, committed with each changed terminal owner.
 * Unknown outcomes break a strict failure streak; they never authorize replay.
 */
export interface IncomingDeliveryHealth {
  failures: number;
  uncertain?: number;
  firstFailedAt: string | null;
  /** Previous failure in the current streak, allowing epoch-bounded recovery. */
  penultimateFailedAt?: string | null;
  lastFailedAt?: string | null;
  lastOutcomeAt: string;
  lastDeliveredAt: string | null;
  /** Failure episode that the most recent successful delivery cleared. */
  lastDeliveredEpisodeId?: string;
  lastDeliveredAdmissionSeq?: number;
  lastOutcomeAdmissionSeq?: number;
  episodeAdmissionSeq?: number;
  cause: string | null;
  lastOperationId?: string;
  episodeId?: string;
}
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
export function normalizeIncomingDeliveryHealth(value: unknown): IncomingDeliveryHealth | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as IncomingDeliveryHealth;
  if (!Number.isSafeInteger(v.failures) || v.failures < 0 || v.failures > 1_000_000 || !date(v.lastOutcomeAt)
    || v.firstFailedAt !== null && !date(v.firstFailedAt) || v.lastDeliveredAt !== null && !date(v.lastDeliveredAt)
    || v.penultimateFailedAt !== undefined && v.penultimateFailedAt !== null && !date(v.penultimateFailedAt)
    || v.lastFailedAt !== undefined && v.lastFailedAt !== null && !date(v.lastFailedAt)
    || v.cause !== null && typeof v.cause !== "string"
    || v.lastDeliveredEpisodeId !== undefined && (typeof v.lastDeliveredEpisodeId !== "string" || v.lastDeliveredEpisodeId.length > 200)
    || v.lastDeliveredAdmissionSeq !== undefined && (!Number.isSafeInteger(v.lastDeliveredAdmissionSeq) || v.lastDeliveredAdmissionSeq < 1)
    || v.lastOutcomeAdmissionSeq !== undefined && (!Number.isSafeInteger(v.lastOutcomeAdmissionSeq) || v.lastOutcomeAdmissionSeq < 1)
    || v.episodeAdmissionSeq !== undefined && (!Number.isSafeInteger(v.episodeAdmissionSeq) || v.episodeAdmissionSeq < 1)
    || v.uncertain !== undefined && (!Number.isSafeInteger(v.uncertain) || v.uncertain < 0)) return;
  return { failures: v.failures, uncertain: Number.isSafeInteger(v.uncertain) && v.uncertain! >= 0 ? v.uncertain : 0, firstFailedAt: v.firstFailedAt,
    ...(v.penultimateFailedAt !== undefined ? { penultimateFailedAt: v.penultimateFailedAt } : {}),
    ...(v.lastFailedAt !== undefined ? { lastFailedAt: v.lastFailedAt } : {}), lastOutcomeAt: v.lastOutcomeAt,
    lastDeliveredAt: v.lastDeliveredAt, cause: v.cause?.slice(0, 240) ?? null,
    ...(typeof v.lastDeliveredEpisodeId === "string" ? { lastDeliveredEpisodeId: v.lastDeliveredEpisodeId } : {}),
    ...(Number.isSafeInteger(v.lastDeliveredAdmissionSeq) && v.lastDeliveredAdmissionSeq! > 0 ? { lastDeliveredAdmissionSeq: v.lastDeliveredAdmissionSeq } : {}),
    ...(Number.isSafeInteger(v.lastOutcomeAdmissionSeq) && v.lastOutcomeAdmissionSeq! > 0 ? { lastOutcomeAdmissionSeq: v.lastOutcomeAdmissionSeq } : {}),
    ...(Number.isSafeInteger(v.episodeAdmissionSeq) && v.episodeAdmissionSeq! > 0 ? { episodeAdmissionSeq: v.episodeAdmissionSeq } : {}),
    ...(typeof v.lastOperationId === "string" && v.lastOperationId.length <= 200 ? { lastOperationId: v.lastOperationId } : {}),
    ...(typeof v.episodeId === "string" && v.episodeId.length <= 200 ? { episodeId: v.episodeId } : {}) };
}
export function incomingDeliveryOutcome(previous: IncomingDeliveryHealth | undefined,
  state: "delivered" | "failed" | "unverified", at: string, cause: string | null, admissionSeq?: number): IncomingDeliveryHealth {
  const ordered = admissionSeq === undefined || previous?.lastOutcomeAdmissionSeq === undefined
    || admissionSeq >= previous.lastOutcomeAdmissionSeq;
  const deliveryAdvances = state === "delivered" && admissionSeq !== undefined
    && admissionSeq > (previous?.lastDeliveredAdmissionSeq ?? 0);
  const clearsEpisode = ordered && deliveryAdvances && previous?.episodeId
    && admissionSeq > (previous.episodeAdmissionSeq ?? 0);
  if (!ordered) return {
    ...previous!,
    ...(deliveryAdvances ? { lastDeliveredAdmissionSeq: admissionSeq, lastDeliveredAt: at,
      ...(clearsEpisode ? { lastDeliveredEpisodeId: previous!.episodeId } : {}) } : {}),
  };
  const startsEpisode = state === "failed" && (previous?.failures ?? 0) === 0;
  return {
    uncertain: previous?.uncertain ?? 0,
    failures: state === "failed" ? Math.min(1_000_000, (previous?.failures ?? 0) + 1) : 0,
    firstFailedAt: state === "failed" ? previous?.firstFailedAt ?? at : null,
    ...(state === "failed" ? { penultimateFailedAt: previous?.failures ? previous.lastFailedAt ?? previous.firstFailedAt ?? at : null,
      lastFailedAt: at } : {}),
    lastOutcomeAt: at,
    lastDeliveredAt: deliveryAdvances ? at : previous?.lastDeliveredAt ?? null,
    ...(deliveryAdvances ? { lastDeliveredAdmissionSeq: admissionSeq } : previous?.lastDeliveredAdmissionSeq
      ? { lastDeliveredAdmissionSeq: previous.lastDeliveredAdmissionSeq } : {}),
    ...(clearsEpisode ? { lastDeliveredEpisodeId: previous!.episodeId }
      : previous?.lastDeliveredEpisodeId ? { lastDeliveredEpisodeId: previous.lastDeliveredEpisodeId } : {}),
    ...(admissionSeq !== undefined ? { lastOutcomeAdmissionSeq: admissionSeq }
      : previous?.lastOutcomeAdmissionSeq ? { lastOutcomeAdmissionSeq: previous.lastOutcomeAdmissionSeq } : {}),
    ...(state === "failed" ? { ...(startsEpisode && admissionSeq !== undefined ? { episodeAdmissionSeq: admissionSeq }
      : previous?.episodeAdmissionSeq ? { episodeAdmissionSeq: previous.episodeAdmissionSeq } : {}) }
      : previous?.episodeAdmissionSeq ? { episodeAdmissionSeq: previous.episodeAdmissionSeq } : {}),
    cause: state === "failed" ? cause?.slice(0, 240) ?? "delivery-settlement: failed" : null,
  };
}
