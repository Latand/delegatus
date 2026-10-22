import type { EngineLimits } from "@/lib/types";
import type { TurboTier } from "@/lib/accounts/codexServiceTiers";
import type { SeatTickSettingsActor } from "./seatTickSettings";

/**
 * Turbo mode (docs/design/turbo-mode.md): a per-project switch beside Full
 * autonomy that moves this project's live Codex conversations to the fastest
 * tier their own account offers, for a bounded time.
 *
 * This module is pure. It owns the setting, who may change it, the paid-credit
 * approval, the wake overlay, the seat notices and the credit rule. The
 * switching itself is `turboSweep.ts`; the store is `seatTickSettings.ts`.
 */

/** One allowed Codex account as the confirmation showed it. */
export interface TurboPlanAccount {
  accountId: string;
  label: string;
  plan: string | null;
  /** The tier each catalog model gets on this account; models with no faster tier are absent. */
  tiers: Record<string, TurboTier>;
  /** Whether the account held paid credits (or had no reading) when the dialog was shown. */
  hadCredits: boolean;
}

export interface TurboCredits {
  approved: boolean;
  /** The accounts the dialog named as paying. Only these may spend credits. */
  accounts: string[];
  approvedAt: string | null;
  withdrawnAt: string | null;
  withdrawnBy: SeatTickSettingsActor | null;
  withdrawnWhy: string | null;
}

export type TurboSwitchState = "queued" | "applying" | "armed" | "switched" | "skipped" | "failed" | "reverting" | "reverted";

/** One conversation Turbo touched. `from` is what off restores. */
export interface TurboSwitch {
  conversationId: string;
  stage?: { pipelineId: string; stageId: string; attempt: number; definitionFrom?: string | null };
  accountId: string;
  model: string;
  from: string | null;
  to: TurboTier;
  /** The native echo, when it differed from the requested tier. */
  appliedTier?: string | null;
  /** Native dispatch may have landed before its acknowledgement was stored. */
  uncertain?: boolean;
  state: TurboSwitchState;
  reason?: string;
  at: string;
  /** When the current step started, for its deadline. */
  startedAt?: string;
  /** Native turn persisted before an interruption may happen. */
  cutTurnId?: string;
  /** The boundary cut and its continuation (or turn end) already settled. */
  cutSettled?: boolean;
}

/** A seat notice's delivery; tried at most {@link TURBO_NOTICE_ATTEMPTS} times. */
export interface TurboNotice { key: string; deliveredAt?: string; error?: string; attempts?: number }
export const TURBO_NOTICE_ATTEMPTS = 20;

export interface TurboSetting {
  enabled: boolean;
  /** Episode key: `turbo:<startedAt>`. */
  startedAt: string;
  until: string | null;
  endedAt: string | null;
  endReason: "expired" | "turned-off" | null;
  updatedAt: string;
  setBy: SeatTickSettingsActor;
  why: string | null;
  plan: TurboPlanAccount[];
  credits: TurboCredits;
  switches: TurboSwitch[];
  /** Accounts whose Turbo the 90 % rule ended in this episode, with when. */
  held?: Record<string, string>;
  noticeOn?: TurboNotice;
  noticeOff?: TurboNotice;
  /** Set once the sweep has returned every switched conversation after the end. */
  revertedAt?: string;
}

export interface TurboChange {
  enabled?: boolean;
  /** 1, 2, 4 or 8 hours from now, or null for «until turned off». */
  hours?: number | null;
  /** The separate paid-credit approval. True only with an enable or extension. */
  credits?: boolean;
  /** The accounts the dialog listed as paying. */
  creditAccounts?: string[];
  why?: string | null;
}

/** What the server knows when a change arrives: the plan to store and the allowed accounts. */
export interface TurboChangeContext {
  plan: TurboPlanAccount[];
  /** null: the project is unbound, so every Codex account is allowed. */
  allowedAccounts: string[] | null;
}

export const TURBO_HOURS = [1, 2, 4, 8] as const;
export const TURBO_DEFAULT_HOURS = 2;
export const TURBO_HISTORY_LIMIT = 5;
/** Completed switch history only; unfinished work is always retained. */
export const TURBO_SWITCH_LIMIT = 200;

/** Revoking acceleration never depends on discovering accounts or their catalogs. */
export function turboNeedsPlan(change: unknown): boolean {
  if (!change || typeof change !== "object" || Array.isArray(change)) return false;
  const fields = change as TurboChange;
  return fields.enabled === true || fields.credits === true;
}

/** Without the approval, a credit-holding account stops at this share of a window. */
export const TURBO_CREDIT_MARGIN_PERCENT = 90;
const HOUR = 3_600_000;

export function turboActive(setting: TurboSetting | null | undefined, now: number): boolean {
  return !!setting?.enabled && (setting.until === null || Date.parse(setting.until) > now);
}

/** Expiry is evaluated on every read, so a stopped Viewer cannot keep a past deadline alive. */
export function endedTurbo(setting: TurboSetting | null | undefined, now: number): TurboSetting | null {
  if (!setting) return null;
  if (!setting.enabled || setting.until === null || Date.parse(setting.until) > now) return setting;
  return { ...setting, enabled: false, endedAt: setting.until, endReason: "expired", credits: endCredits(setting.credits, setting.until, null, null) };
}

function endCredits(credits: TurboCredits, at: string, by: SeatTickSettingsActor | null, why: string | null): TurboCredits {
  return credits.approved ? { ...credits, approved: false, withdrawnAt: at, withdrawnBy: by, withdrawnWhy: why } : credits;
}

const NO_CREDITS: TurboCredits = { approved: false, accounts: [], approvedAt: null, withdrawnAt: null, withdrawnBy: null, withdrawnWhy: null };

/**
 * Apply one change. Only the operator (`gateway`) enables, extends or approves
 * credits; the project's seat may shorten, turn off or withdraw the approval,
 * always with a why. Everyone else is refused.
 */
export function changeTurbo(current: TurboSetting | null | undefined, raw: TurboChange,
  context: { at: string; actor: SeatTickSettingsActor; turbo?: TurboChangeContext }, project: string): TurboSetting | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("turbo must be an object");
  const { actor, at } = context;
  const operator = actor.kind === "gateway";
  if (!operator && !(actor.kind === "manager" && actor.project === project)) throw new Error("only the operator or this project's seat may change Turbo");
  const why = typeof raw.why === "string" ? raw.why.trim() || null : null;
  if (!operator && !why) throw new Error("turbo.why is required: say why Turbo is being changed");
  if (why && why.length > 500) throw new Error("turbo.why exceeds 500 characters");
  const now = Date.parse(at);
  const previous = endedTurbo(current, now);
  const enabled = Object.hasOwn(raw, "enabled") ? raw.enabled : previous?.enabled ?? false;
  if (typeof enabled !== "boolean") throw new Error("turbo.enabled must be a boolean");
  const starting = enabled && !previous?.enabled;
  let until = previous?.enabled ? previous.until : new Date(now + TURBO_DEFAULT_HOURS * HOUR).toISOString();
  const timed = Object.hasOwn(raw, "hours");
  if (timed) {
    if (raw.hours === null) until = null;
    else if (typeof raw.hours !== "number" || !(TURBO_HOURS as readonly number[]).includes(raw.hours)) throw new Error("turbo.hours must be 1, 2, 4 or 8, or null for until turned off");
    else until = new Date(now + raw.hours * HOUR).toISOString();
  }
  const extending = enabled && !!previous?.enabled && timed
    && (previous.until !== null && (until === null || Date.parse(until) > Date.parse(previous.until)));
  if (!operator && (starting || extending)) throw new Error("only the operator may turn Turbo on or extend it; the seat may only shorten or turn it off");

  if (Object.hasOwn(raw, "credits") && typeof raw.credits !== "boolean") throw new Error("turbo.credits must be a boolean");
  if (raw.credits === true) {
    if (!operator) throw new Error("only the operator may approve paid credits");
    if (!(starting || (enabled && timed))) throw new Error("paid credits are approved only when the operator enables or extends Turbo");
    if (until === null) throw new Error("paid credits need a finite Turbo of 1–8 h; «until turned off» is not offered with credits");
    const accounts = Array.isArray(raw.creditAccounts) ? [...new Set(raw.creditAccounts.filter((id): id is string => typeof id === "string" && !!id.trim()).map(id => id.trim()))] : [];
    if (!accounts.length) throw new Error("turbo.creditAccounts must name the accounts that would spend credits");
    const allowed = context.turbo?.allowedAccounts;
    const outside = allowed ? accounts.filter(id => !allowed.includes(id)) : [];
    if (outside.length) throw new Error(`accounts ${outside.join(", ")} are not allowed on this project`);
    if (!Array.isArray(raw.creditAccounts) || raw.creditAccounts.some(id => typeof id !== "string" || !id.trim())) throw new Error("turbo.creditAccounts must contain account ids");
    if (accounts.some(id => !context.turbo?.plan.some(account => account.accountId === id && account.hadCredits && Object.keys(account.tiers).length))) {
      throw new Error("paid-credit approval must name paying accounts in the current confirmation plan");
    }
  }

  if (!enabled) {
    if (!previous) return null;
    const endedAt = previous.enabled ? at : previous.endedAt ?? at;
    return { ...previous, enabled: false, endedAt, endReason: previous.enabled ? "turned-off" : previous.endReason ?? "turned-off", updatedAt: at, setBy: actor, why,
      credits: endCredits(previous.credits, endedAt, actor, why) };
  }

  let credits = starting ? NO_CREDITS : previous!.credits;
  if (raw.credits === true) {
    credits = { approved: true, accounts: [...new Set(raw.creditAccounts!.map(id => id.trim()))], approvedAt: at, withdrawnAt: null, withdrawnBy: null, withdrawnWhy: null };
  } else if (raw.credits === false) {
    credits = endCredits(credits, at, actor, why);
  } else if (extending || (timed && until === null)) {
    /* An extension asks for the approval again. */
    credits = endCredits(credits, at, actor, why ?? "extended without paid-credit approval");
  }
  if (starting) {
    const startedAt = previous && Date.parse(previous.startedAt) >= now ? new Date(Date.parse(previous.startedAt) + 1).toISOString() : at;
    return { enabled: true, startedAt, until, endedAt: null, endReason: null, updatedAt: at, setBy: actor, why,
      plan: context.turbo?.plan ?? [], credits, switches: [] };
  }
  return { ...previous!, until, updatedAt: at, setBy: actor, why, credits };
}

/** The episode's key, also the prefix of its notice keys. */
export function turboEpisodeKey(setting: Pick<TurboSetting, "startedAt">): string { return `turbo:${setting.startedAt}`; }

/** Whether the guard should let this account spend credits for this project's conversations now. */
export function turboCreditExempt(setting: TurboSetting | null | undefined, accountId: string | null | undefined, now: number): boolean {
  if (!accountId || !turboActive(setting, now) || !setting?.credits.approved || !setting.until || !setting.credits.approvedAt) return false;
  const approvedAt = Date.parse(setting.credits.approvedAt);
  const until = Date.parse(setting.until);
  return approvedAt <= now && until > approvedAt && until - approvedAt <= 8 * HOUR && setting.credits.accounts.includes(accountId);
}

export type TurboAccountReading = { limits: EngineLimits | null; stale: boolean } | null;

/**
 * The credit rule for one account (§2.2). `raise`: Turbo may give it the fast
 * tier. `hold`: no new raise, and its Turbo conversations go back. `spend`: the
 * approval lets it continue on credits.
 */
export function turboAccountVerdict(setting: TurboSetting | null | undefined, accountId: string, reading: TurboAccountReading, now: number): { verdict: "raise" | "hold" | "spend"; reason?: string } {
  const limits = reading?.limits ?? null;
  const credits = limits?.credits;
  const holdsCredits = !limits || !credits || credits.hasCredits || credits.unlimited || reading!.stale;
  if (holdsCredits && turboCreditExempt(setting, accountId, now)) return { verdict: "spend" };
  if (!limits) return { verdict: "hold", reason: "no usage reading for this account" };
  if (reading?.stale) return { verdict: "hold", reason: "no fresh usage reading for this account" };
  if (credits && !credits.hasCredits && !credits.unlimited && !reading!.stale) return { verdict: "raise" };
  const used = Math.max(limits.session?.usedPercent ?? 0, limits.weekly?.usedPercent ?? 0);
  if (!limits.session && !limits.weekly) return { verdict: "hold", reason: "no usage window for this account" };
  return used >= TURBO_CREDIT_MARGIN_PERCENT
    ? { verdict: "hold", reason: `usage reached ${Math.floor(used)} % without paid-credit approval` }
    : { verdict: "raise" };
}

/** Keep every unfinished switch and the newest {@link TURBO_SWITCH_LIMIT} completed rows. */
export function upsertTurboSwitches(rows: readonly TurboSwitch[], updates: readonly TurboSwitch[]): TurboSwitch[] {
  const next = [...rows];
  for (const update of updates) {
    const index = next.findIndex(row => row.conversationId === update.conversationId);
    if (index >= 0) next[index] = update; else next.push(update);
  }
  const pending = (row: TurboSwitch) => !["skipped", "reverted", "failed"].includes(row.state) || row.state === "failed" && !!row.startedAt;
  let completed = next.reduce((count, row) => count + Number(!pending(row)), 0);
  return next.filter(row => pending(row) || completed-- <= TURBO_SWITCH_LIMIT);
}

export function turboProgress(rows: readonly TurboSwitch[]) {
  const count = (...states: TurboSwitchState[]) => rows.filter(row => states.includes(row.state)).length;
  return { total: rows.length, switched: count("switched"), armed: count("armed"), skipped: count("skipped"), failed: count("failed"),
    pending: count("queued", "applying", "reverting"), reverted: count("reverted") };
}

/** Account labels as the confirmation named them. */
export function planLabel(plan: readonly TurboPlanAccount[]): (id: string) => string {
  return id => plan.find(account => account.accountId === id)?.label ?? id;
}

function tierSummary(plan: readonly TurboPlanAccount[], label: (id: string) => string): string {
  return plan.filter(account => Object.keys(account.tiers).length).map(account => {
    const ultra = Object.entries(account.tiers).filter(([, tier]) => tier === "ultrafast").map(([model]) => model);
    const rest = Object.values(account.tiers).some(tier => tier === "priority");
    return ultra.length ? `${label(account.accountId)}: ultrafast on ${ultra.join("/")}${rest ? ", priority otherwise" : ""}` : `${label(account.accountId)}: priority`;
  }).join("; ") || "none";
}

/** The overlay every wake carries while Turbo is on (§2.4). `unchanged`: the seat already saw this revision. */
export function turboMandate(setting: TurboSetting | null | undefined, now: number, unchanged = false, label?: (id: string) => string): string[] {
  if (!turboActive(setting, now)) return [];
  label ??= planLabel(setting!.plan);
  const until = setting!.until ?? "turned off";
  const approved = setting!.credits.approved ? setting!.credits.accounts.map(label) : [];
  if (unchanged) {
    return ["", `Turbo on until ${until}, ${approved.length ? `paid credits approved (${approved.join(", ")})` : "no paid credits"}; fastest tier per allowed Codex account; seat_tick_settings turbo has the table and progress.`];
  }
  const credits = approved.length
    ? `Paid credits: approved for ${approved.join(", ")} on this project until ${until}.`
    : `Paid credits: not approved; Delegatus ends Turbo on a credit-holding account at ${TURBO_CREDIT_MARGIN_PERCENT} %.`;
  return ["", `Turbo on until ${until} (operator). Allowed Codex accounts may spend included limits faster: each runs its fastest catalog tier (${tierSummary(setting!.plan, label)}). ${credits} Delegatus switches live Codex conversations itself. You decide upcoming Codex stages and new Codex launches: set serviceTier (override-stage, no applyNow; spawn/create). Accounts, bindings, worker limits and Claude unchanged.`];
}

/** Revision of the overlay the seat holds; a change shows the full text again. */
export function turboShownRevision(setting: TurboSetting | null | undefined, now: number): string | undefined {
  return turboActive(setting, now) ? `${setting!.startedAt}:${setting!.updatedAt}` : undefined;
}

/** The one notice to the seat on, and the one on off (§2.5). Agent-facing, English. */
export function turboNotice(setting: TurboSetting, phase: "on" | "off", facts: { conversations: number }, label: (id: string) => string = planLabel(setting.plan)): { key: string; text: string } {
  const key = `${turboEpisodeKey(setting)}:${phase}`;
  if (phase === "on") {
    const overlay = turboMandate({ ...setting, enabled: true, until: setting.until }, Date.parse(setting.startedAt), false, label).filter(Boolean).join(" ");
    return { key, text: `Turbo is on: the limits of this project's allowed Codex accounts may now be spent faster. ${overlay} Switching ${facts.conversations} live Codex conversation(s) now; progress: seat_tick_settings → turbo. Decide which upcoming pipeline stages to speed up and record each choice.` };
  }
  return { key, text: `Turbo ended (${setting.endReason ?? "turned-off"}, ${setting.endedAt ?? setting.updatedAt}). Paid-credit approval, if any, has ended. Delegatus is returning every conversation it switched to its previous speed from its next turn; nothing is interrupted. Please put back any upcoming stages you sped up for Turbo, as listed in your own decisions.` };
}
