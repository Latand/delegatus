import type { DecidePrototypeInput } from "@/lib/prototypeReview/types";
import type { SeatTickSettingsActor } from "./seatTickSettings";

export interface AutonomyDecision {
  id: string;
  at: string;
  decision: string;
  why: string;
  undo: string;
  taskId?: string;
  by: SeatTickSettingsActor;
  review?: DecidePrototypeInput;
  reviewState?: "pending" | "decided" | "refused";
}

export interface AutonomySetting {
  /** Episode-local permission. Legacy episodes have no invention authority. */
  proactive?: { enabled: boolean };
  enabled: boolean;
  startedAt: string;
  until: string | null;
  endedAt: string | null;
  endReason: "expired" | "turned-off" | null;
  updatedAt: string;
  setBy: SeatTickSettingsActor;
  why: string | null;
  decisions: AutonomyDecision[];
  reportAt?: string;
}

export interface AutonomyChange { enabled?: boolean; hours?: number | null; why?: string | null; proactive?: { enabled: boolean } }
export type AutonomyDecisionInput = Pick<AutonomyDecision, "id" | "decision" | "why" | "undo" | "taskId"> & { startedAt: string; review?: DecidePrototypeInput };

export function autonomyActive(setting: AutonomySetting | null | undefined, now: number): boolean {
  return !!setting?.enabled && (setting.until === null || Date.parse(setting.until) > now);
}

export function proactiveActive(setting: AutonomySetting | null | undefined, now: number): boolean {
  return autonomyActive(setting, now) && setting?.proactive?.enabled === true;
}

/** An expiry is evaluated on every read, including after a stopped Viewer. */
export function endedAutonomy(setting: AutonomySetting | null | undefined, now: number): AutonomySetting | null {
  if (!setting) return null;
  return setting.enabled && setting.until !== null && Date.parse(setting.until) <= now
    ? { ...setting, proactive: { enabled: false }, enabled: false, endedAt: setting.until, endReason: "expired" } : setting;
}

export function changeAutonomy(current: AutonomySetting | null | undefined, raw: AutonomyChange,
  context: { at: string; actor: SeatTickSettingsActor }, project: string, wakesEnabled: boolean): AutonomySetting | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("autonomy must be an object");
  const { at } = context;
  // Root agent sessions can carry gateway attribution for older controls.
  // That attribution cannot extend an episode carrying invention authority.
  const guarded = current?.proactive?.enabled === true || Object.hasOwn(raw, "proactive");
  const actor: SeatTickSettingsActor = guarded && context.actor.kind === "gateway" && context.actor.conversationId !== null
    ? { ...context.actor, kind: context.actor.project === project && context.actor.seatEpoch !== null ? "manager" : "agent" }
    : context.actor;
  if (actor.kind !== "gateway" && !(actor.kind === "manager" && actor.project === project)) throw new Error("only the operator or this project's seat may change autonomy");
  const why = typeof raw.why === "string" ? raw.why.trim() : null;
  if (actor.kind !== "gateway" && !why) throw new Error("autonomy.why is required");
  if (why && why.length > 500) throw new Error("autonomy.why exceeds 500 characters");
  const previous = endedAutonomy(current, Date.parse(at));
  const enabled = Object.hasOwn(raw, "enabled") ? raw.enabled : previous?.enabled ?? false;
  if (typeof enabled !== "boolean") throw new Error("autonomy.enabled must be a boolean");
  if (enabled && !wakesEnabled) throw new Error("enable orchestrator wakes before enabling autonomy");
  let until = previous?.enabled ? previous.until : new Date(Date.parse(at) + 8 * 3_600_000).toISOString();
  if (Object.hasOwn(raw, "hours")) {
    if (raw.hours === null) until = null;
    else if (typeof raw.hours !== "number" || !Number.isFinite(raw.hours)) throw new Error("autonomy.hours must be finite, or null for unlimited");
    else until = new Date(Date.parse(at) + Math.max(1, Math.min(8760, raw.hours)) * 3_600_000).toISOString();
  }
  if (actor.kind !== "gateway" && enabled && (!previous?.enabled || (previous.until !== null && (until === null || Date.parse(until) > Date.parse(previous.until))))) {
    throw new Error("the seat may only shorten or turn off autonomy; only the operator may enable or extend it");
  }
  let proactive = { enabled: enabled && previous?.enabled ? previous.proactive?.enabled === true : false };
  if (Object.hasOwn(raw, "proactive")) {
    const value = raw.proactive;
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.enabled !== "boolean"
      || Object.keys(value).some(key => key !== "enabled")) throw new Error("autonomy.proactive must contain only enabled, a boolean");
    if (value.enabled && (actor.kind !== "gateway" || actor.conversationId !== null)) throw new Error("only the operator may enable proactive autonomy");
    if (value.enabled && !enabled) throw new Error("proactive autonomy requires active full autonomy");
    proactive = { enabled: value.enabled };
  }
  if (!enabled && !previous) return null;
  if (!enabled) return { ...previous!, proactive: { enabled: false }, enabled: false, endedAt: previous!.endedAt ?? at, endReason: previous!.endReason ?? "turned-off", updatedAt: at, setBy: actor, why };
  return { enabled: true, startedAt: previous?.enabled ? previous.startedAt : previous && Date.parse(previous.startedAt) >= Date.parse(at) ? new Date(Date.parse(previous.startedAt) + 1).toISOString() : at, until, endedAt: null, endReason: null,
    proactive, updatedAt: at, setBy: actor, why, decisions: previous?.enabled ? previous.decisions : [] };
}

export function autonomyReportKey(episode: Pick<AutonomySetting, "startedAt">): string { return `autonomy:${episode.startedAt}`; }

/** The full overlay, delivered again after an edit or a seat rotation. */
export function autonomyMandate(setting: AutonomySetting | null | undefined, now: number, unchanged = false): string[] {
  if (!autonomyActive(setting, now)) return [];
  if (unchanged) return ["", `Full autonomy on until ${setting!.until ?? "turned off"}; rules from episode ${setting!.startedAt} govern. Recheck seat_tick_settings before deciding; verbose:true reads the rules and undo log. Expiry/off ends this overlay.`];
  return ["", `Full autonomy until ${setting!.until ?? "turned off"}; episode ${setting!.startedAt}. Recheck seat_tick_settings; expiry/off ends these rules.`,
    "Replace mandate asking rules: decide all questions, open forms and variants. Log each: autonomyDecision {decision, why, undo}; review settles forms. Resolve parked lanes; keep work moving. In free slots prioritize autonomous-marked work: Inbox, GitHub issues, board-maintenance suggestions, own findings. Mark new tasks autonomous; keep them small, reversible, reviewed.",
    "Forbidden: other projects; accounts/spend/worker limits/role mappings; operator settings or sessions (only shorten autonomy); destruction/history rewrites/data deletion/closing others' work; public issues/outside comments/Telegram/posts; other machines/SSH outside this project's deploy path. Keep credit/merge/deploy gates. Release flow alone may skip askBeforePublish only while autonomy is on: keep enabled/gap/change-count/hold gates; no hand tags/package publishes. Forbidden choices wait as forms; otherwise no asks/reply drafts/attention moves. Operator instructions win. End: one Done report, same chat text."];

}

export function pendingAutonomyReports(settings: { autonomy?: AutonomySetting | null; autonomyHistory?: AutonomySetting[] }, now: number): AutonomySetting[] {
  return [...(settings.autonomyHistory ?? []), ...(settings.autonomy ? [settings.autonomy] : [])]
    .map(episode => endedAutonomy(episode, now)!).filter(episode => !episode.enabled && !episode.reportAt);
}

export function autonomyEndInstructions(episode: AutonomySetting): string {
  return `Autonomy ended (${episode.endReason}, ${episode.endedAt}). Read seat_tick_settings verbose:true for episode ${episode.startedAt} and its decisions. File ONE bridge_report, class status, outcome autonomy, key ${autonomyReportKey(episode)}. Cover completed work with links, every decision and undo path, new autonomous tasks and their state, forbidden decisions waiting for the operator, and problems. Then repeat the returned chatText exactly in this conversation. The report stays owed until stored; reuse its key.`;
}
