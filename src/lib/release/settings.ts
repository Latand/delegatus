import type { SeatTickSettingsActor } from "@/lib/monitor/seatTickSettings";
import { redactMonitorText } from "@/lib/monitor/redact";
export interface ReleaseSetting {
  enabled: boolean; askBeforePublish: boolean; minChanges: number; minGapHours: number;
  updatedAt: string; setBy: SeatTickSettingsActor; why: string | null;
  /** Retained when another field changes; cleared when asking is restored. */
  publishApproval?: { at: string; by: SeatTickSettingsActor; why: string | null } | null;
}
export interface ReleaseSettingChange {
  enabled?: boolean; askBeforePublish?: boolean; minChanges?: number | string | null;
  minGapHours?: number | string | null; why?: string | null;
  requestNow?: boolean; taskId?: string; hold?: string | null;
}
export const RELEASE_DEFAULTS = { enabled: false, askBeforePublish: true, minChanges: 30, minGapHours: 12 };
export function normalizeRelease(value: unknown): ReleaseSetting | null {
  if (!value || typeof value !== "object") return null;
  const r = value as ReleaseSetting;
  return typeof r.enabled === "boolean" && typeof r.askBeforePublish === "boolean"
    && Number.isInteger(r.minChanges) && r.minChanges >= 1 && r.minChanges <= 500
    && Number.isInteger(r.minGapHours) && r.minGapHours >= 1 && r.minGapHours <= 720
    && Number.isFinite(Date.parse(r.updatedAt)) && !!r.setBy && ["manager", "agent", "gateway", "unidentified"].includes(r.setBy.kind)
    ? { ...r, why: typeof r.why === "string" ? redactMonitorText(r.why).slice(0, 500) : null } : null;
}
export function changeRelease(current: ReleaseSetting | null | undefined, raw: ReleaseSettingChange, context: { at: string; actor: SeatTickSettingsActor }, project: string): ReleaseSetting {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("release must be an object");
  const why = typeof raw.why === "string" ? redactMonitorText(raw.why).trim().slice(0, 500) || null : null;
  if (context.actor.kind !== "gateway" && !why) throw new Error("release.why is required: name the operator request or incident");
  if (raw.askBeforePublish === false && !(context.actor.kind === "gateway" || context.actor.kind === "manager" && context.actor.project === project)) throw new Error("only this project's seat or the operator may stop asking before publication");
  const result = { ...RELEASE_DEFAULTS, ...current, updatedAt: context.at, setBy: context.actor, why };
  for (const field of ["enabled", "askBeforePublish"] as const) {
    if (Object.hasOwn(raw, field)) {
      if (typeof raw[field] !== "boolean") throw new Error(`release.${field} must be a boolean`);
      result[field] = raw[field]!;
    }
  }
  for (const field of ["minChanges", "minGapHours"] as const) {
    if (!Object.hasOwn(raw, field)) continue;
    const value = raw[field] === null ? RELEASE_DEFAULTS[field] : typeof raw[field] === "string" && raw[field]!.trim() ? Number(raw[field]) : raw[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > (field === "minChanges" ? 500 : 720)) throw new Error(`release.${field} must be an integer in range`);
    result[field] = value;
  }
  if (Object.hasOwn(raw, "askBeforePublish")) result.publishApproval = result.askBeforePublish
    ? null : { at: context.at, by: context.actor, why };
  else if (!result.askBeforePublish && !result.publishApproval && current
    && ["gateway", "manager"].includes(current.setBy.kind)) {
    result.publishApproval = { at: current.updatedAt, by: current.setBy, why: current.why };
  }
  if (Object.hasOwn(raw, "requestNow") && typeof raw.requestNow !== "boolean") throw new Error("release.requestNow must be a boolean");
  if (Object.hasOwn(raw, "hold") && raw.hold !== null && (typeof raw.hold !== "string" || !raw.hold.trim())) throw new Error("release.hold must be a reason or null");
  return result;
}
