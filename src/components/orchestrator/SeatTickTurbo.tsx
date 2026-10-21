"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { Z } from "@/components/layers";
import { useModalLayer } from "@/components/modalLayer";
import { useLocale } from "@/lib/i18n";
import { ENGINE_MODELS } from "@/lib/agent/models";
import type { TurboAnswer, TurboPreviewAccount } from "@/lib/monitor/turboRuntime";
import { seatTickLocalTime } from "./seatTickView";
import type { SeatTickSettingsRead } from "./useSeatTickSettings";

/*
 * Turbo's control, variant 1 «Форсаж» (docs/design/turbo-mode.md §6,
 * docs/prototypes/turbo-mode/variant-1.html): a wide switch whose thumb is a
 * jet nozzle and whose track fills with an afterburner flame when it is on.
 * Turning it on opens the confirmation (§2.3); turning it off is immediate.
 * Both save at once, apart from the panel's Save, and roll back in place on
 * a refusal.
 */

const SETTINGS_URL = "/api/monitor/seat-tick/settings";
const ENDING_MS = 10 * 60_000;
const SWITCHING_POLL_MS = 3_000;
type Hours = "1" | "2" | "4" | "8" | "off";

export type TurboControlState = "off" | "dialog" | "switching" | "on" | "ending" | "disabled";

export interface TurboControl {
  answer: TurboAnswer | null;
  /** What the control shows, the optimistic choice included. */
  on: boolean;
  state: TurboControlState;
  saving: boolean;
  error: string | null;
  dialogOpen: boolean;
  open: () => void;
  close: () => void;
  confirm: (choice: { hours: Hours; credits: boolean; creditAccounts: string[] }) => Promise<void>;
  turnOff: () => Promise<void>;
  preview: { state: "loading" | "ready" | "failed"; value: TurboAnswer["preview"] | null };
}

export function useTurboControl(read: SeatTickSettingsRead, now: number): TurboControl {
  const answer = read.record?.turbo ?? null;
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<TurboControl["preview"]>({ state: "loading", value: null });
  const on = optimistic ?? answer?.active === true;
  const progress = answer?.progress;
  const until = answer?.episode?.until ? Date.parse(answer.episode.until) : null;
  const state: TurboControlState = !on && answer && !answer.available ? "disabled"
    : dialogOpen ? "dialog"
      : !on ? "off"
        : progress && progress.pending > 0 ? "switching"
          : until !== null && until - now <= ENDING_MS ? "ending" : "on";

  /* While the sweep runs, re-read every few seconds so the count moves. */
  const refresh = read.refresh;
  useEffect(() => {
    if (state !== "switching") return;
    const timer = setInterval(() => { void refresh(); }, SWITCHING_POLL_MS);
    return () => clearInterval(timer);
  }, [state, refresh]);

  const project = read.project;
  const open = useCallback(() => {
    read.clearError();
    setDialogOpen(true);
    setPreview({ state: "loading", value: null });
    void fetch(`${SETTINGS_URL}?project=${encodeURIComponent(project)}&turboPreview=1`, { cache: "no-store" })
      .then(async response => {
        const body = response.ok ? await response.json().catch(() => null) as { turbo?: TurboAnswer } | null : null;
        setPreview(body?.turbo?.preview ? { state: "ready", value: body.turbo.preview } : { state: "failed", value: null });
      })
      .catch(() => setPreview({ state: "failed", value: null }));
  }, [project, read]);

  const save = useCallback(async (next: boolean, change: Record<string, unknown>) => {
    /* Shown at once; a refusal rolls back here and its words appear under the control. */
    setOptimistic(next);
    setSaving(true);
    await read.saveAfter(() => ({ turbo: change }));
    setSaving(false);
    setOptimistic(null);
  }, [read]);

  return {
    answer, on, state, saving, error: read.errorScope === "turbo" ? read.error : null, dialogOpen,
    open, close: () => setDialogOpen(false),
    confirm: async ({ hours, credits, creditAccounts }) => {
      setDialogOpen(false);
      await save(true, { enabled: true, hours: hours === "off" ? null : Number(hours), ...(credits ? { credits: true, creditAccounts } : {}) });
    },
    turnOff: () => save(false, { enabled: false }),
    preview,
  };
}

/* ── Glyphs ──────────────────────────────────────────────────────────────── */

export function TurboFlame({ className }: { className: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className={className} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={`turbo-flame-${id}`} x1="1" x2="0" y1="0" y2="0">
          <stop offset="0" style={{ stopColor: "var(--color-codex)" }} />
          <stop offset=".35" style={{ stopColor: "var(--color-caution)" }} />
          <stop offset="1" style={{ stopColor: "var(--color-danger)" }} />
        </linearGradient>
      </defs>
      <path fill={`url(#turbo-flame-${id})`} d="M100,2 C86,1 74,3 62,4 C54,5 48,2 40,4 C34,6 30,3 22,6 C16,8 10,7 2,11 C10,12 10,12 2,13 C10,17 16,16 22,18 C30,21 34,18 40,20 C48,22 54,19 62,20 C74,21 86,23 100,22 Z" />
      <path style={{ fill: "var(--color-crown)" }} d="M100,5.5 C84,5.5 70,7.5 56,8.5 C48,9 40,7.5 30,10.5 C36,12 36,12 30,13.5 C40,16.5 48,15 56,15.5 C70,16.5 84,18.5 100,18.5 Z" />
      <path style={{ fill: "var(--glyph-astra-core)" }} d="M100,8.5 C88,8.5 78,10 66,11 L56,12 L66,13 C78,14 88,15.5 100,15.5 Z" />
      <path style={{ fill: "var(--color-codex)" }} d="M92,12 L88,10 L84,12 L88,14 Z M78,12 L75,10.6 L72,12 L75,13.4 Z" />
    </svg>
  );
}

export function TurboNozzle({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden>
      <circle className="turbo-nz-1" cx="10" cy="10" r="8.2" />
      <circle className="turbo-nz-2" cx="10" cy="10" r="5.4" />
      <circle className="turbo-nz-3" cx="10" cy="10" r="2.6" />
    </svg>
  );
}

/** The small mark in the status line and on the dock chip: a flame leaving a nozzle. */
export function TurboMark({ attr }: { attr?: Record<`data-${string}`, string> }) {
  return (
    <span aria-hidden {...attr} className="turbo-mark">
      <TurboFlame className="turbo-mark-flame" />
      <TurboNozzle className="turbo-mark-nozzle" />
    </span>
  );
}

/* ── The control ─────────────────────────────────────────────────────────── */

export function TurboSwitch({ control, phone, describedBy }: { control: TurboControl; phone: boolean; describedBy: string }) {
  const { t } = useLocale();
  const disabled = control.state === "disabled" || control.saving;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={control.on}
      aria-label={t("seatTick.turbo.aria")}
      aria-describedby={describedBy}
      {...(control.on ? {} : { "aria-haspopup": "dialog" as const })}
      aria-busy={control.saving || undefined}
      disabled={disabled}
      data-turbo={control.state}
      data-turbo-control
      data-turbo-surface={phone ? "mobile" : "desktop"}
      onClick={() => { if (control.on) void control.turnOff(); else control.open(); }}
      className="turbo-switch"
    >
      <span className="turbo-track">
        <TurboFlame className="turbo-flame" />
        <span className="turbo-pilot" />
        <span className="turbo-sparks"><i /><i /><i /></span>
        <span className="turbo-thumb"><TurboNozzle className="turbo-nozzle" /></span>
      </span>
    </button>
  );
}

/** The caption under the autonomy section: what Turbo does, what it is doing, or why it cannot. */
export function TurboCaption({ control, id }: { control: TurboControl; id: string }) {
  const { t } = useLocale();
  const episode = control.answer?.episode;
  const paid = control.on && episode?.credits.approved === true;
  const labels = (ids: string[]) => ids.map(accountId => episode?.plan.find(item => item.accountId === accountId)?.label ?? accountId).join(", ");
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {control.state === "disabled" ? (
        <p id={id} data-turbo-about className="text-caption leading-4 text-muted">
          <b className="font-semibold text-secondary">{t("seatTick.turbo.disabledHead")}</b>{" "}
          {t(`seatTick.turbo.disabled.${control.answer?.unavailableReason ?? "no-account"}`)}
        </p>
      ) : control.on ? (
        <p id={id} data-turbo-about data-turbo-credits-outcome={paid ? "on" : "off"} className="text-caption leading-4 text-secondary">
          <b className={`font-semibold ${paid ? "text-danger" : "text-primary"}`}>{t(paid ? "seatTick.turbo.onPaidHead" : "seatTick.turbo.onFreeHead")}</b>{" "}
          {paid ? t("seatTick.turbo.onPaid", { accounts: labels(episode!.credits.accounts) }) : t("seatTick.turbo.onFree")}{" "}
          {t("seatTick.turbo.onTail")}
        </p>
      ) : (
        <p id={id} data-turbo-about className="text-caption leading-4 text-secondary">
          <b className="font-semibold text-primary">{t("seatTick.turbo.aboutHead")}</b> {t("seatTick.turbo.about")}
        </p>
      )}
      {control.error ? <p role="alert" data-turbo-error className="text-caption font-semibold leading-4 text-danger">{control.error}</p> : null}
    </div>
  );
}

/** The status block's one Turbo line: the end time always, the sweep's count while it runs, the minutes left at the end. */
export function TurboStatus({ control, now, locale }: { control: TurboControl; now: number; locale: string }) {
  const { t } = useLocale();
  const episode = control.answer?.episode;
  if (!control.on || !episode) return null;
  const time = episode.until ? seatTickLocalTime(episode.until, now, locale) : null;
  const progress = control.answer?.progress;
  const done = progress ? progress.switched + progress.armed + progress.skipped + progress.failed : 0;
  const total = progress ? done + progress.pending : 0;
  const left = episode.until ? Math.max(0, Date.parse(episode.until) - now) : null;
  const line = `${time ? t("seatTick.turbo.status", { time }) : t("seatTick.turbo.statusUnlimited")}${
    control.state === "switching" ? t("seatTick.turbo.statusSwitching", { done, total }) : ""}${
    control.state === "ending" && left !== null ? t("seatTick.turbo.statusLeft", { m: Math.ceil(left / 60_000) }) : ""}`;
  return (
    <div data-turbo-status className="flex min-w-0 items-start gap-2">
      <TurboMark />
      <p className="min-w-0 text-ui text-primary">{line}</p>
    </div>
  );
}

/** Per-conversation refusals stay in the panel's existing Details section. */
export function TurboSwitchDetails({ answer }: { answer: TurboAnswer | undefined }) {
  const { t } = useLocale();
  const episodes = [...(answer?.history ?? []), ...(answer?.episode ? [answer.episode] : [])];
  const rows = episodes.flatMap(episode => episode.switches.filter(row => row.reason).map(row => ({ episode, row })));
  if (!rows.length) return null;
  return <section data-turbo-switch-details className="flex min-w-0 flex-col gap-1">
    <h3 className="text-caption font-semibold text-muted">{t("seatTick.turbo.switchDetails")}</h3>
    <ul className="max-h-40 min-w-0 overflow-y-auto rounded-control border border-border bg-sunken p-2">
      {rows.map(({ episode, row }) => <li key={`${episode.startedAt}:${row.conversationId}`} className="min-w-0 break-words text-caption leading-4 text-secondary">
        <p className="font-semibold text-primary">{episode.plan.find(account => account.accountId === row.accountId)?.label ?? row.accountId} · {row.model} · {row.from ?? "default"} → {row.appliedTier ?? row.to}</p>
        <p>{row.reason}</p>
      </li>)}
    </ul>
  </section>;
}

/* ── The confirmation (§2.3) ─────────────────────────────────────────────── */

function tierSummary(account: TurboPreviewAccount, t: ReturnType<typeof useLocale>["t"]): string {
  const ultra = Object.entries(account.tiers).filter(([, tier]) => tier === "ultrafast").map(([model]) => ENGINE_MODELS.codex.find(option => option.id === model)?.label ?? model);
  const fast = Object.values(account.tiers).some(tier => tier === "priority");
  if (ultra.length) {
    const models = ultra.join(", ");
    return fast ? t("seatTick.turbo.dialog.tierUltraAndFast", { models }) : t("seatTick.turbo.dialog.tierUltra", { models });
  }
  return fast ? t("seatTick.turbo.dialog.tierFast") : t("seatTick.turbo.dialog.tierNone");
}

function paidTiers(account: TurboPreviewAccount, t: ReturnType<typeof useLocale>["t"]): string {
  const tiers = new Set(Object.values(account.tiers));
  return tiers.has("ultrafast") && tiers.has("priority") ? t("seatTick.turbo.dialog.paidUltraAndFast")
    : tiers.has("ultrafast") ? t("seatTick.turbo.dialog.paidUltra") : t("seatTick.turbo.dialog.paidFast");
}

export function TurboDialog({ control, phone, locale }: { control: TurboControl; phone: boolean; locale: string }) {
  /* Mounted per opening, so every opening starts unticked on the default
     duration: cancelling clears the approval. */
  if (!control.dialogOpen || typeof document === "undefined") return null;
  return <OpenTurboDialog control={control} phone={phone} locale={locale} />;
}

function OpenTurboDialog({ control, phone, locale }: { control: TurboControl; phone: boolean; locale: string }) {
  const { t } = useLocale();
  const [hours, setHours] = useState<Hours>("2");
  const [credits, setCredits] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const leadId = useId();
  const creditsAboutId = useId();
  const close = control.close;
  /* The topmost layer owns Escape and Tab, above the seat tick popover or sheet it opened from. */
  useModalLayer({ containerRef: dialogRef, onClose: close, lockScroll: true });
  useEffect(() => { cancelRef.current?.focus(); }, []);
  const preview = control.preview.value;
  const accounts = preview?.accounts ?? [];
  const payers = accounts.filter(account => account.holdsCredits && !account.unavailable && Object.keys(account.tiers).length > 0);
  const block = (head: string, body: ReactNode, attr?: Record<`data-${string}`, string>) => (
    <section {...attr} className="flex min-w-0 flex-col gap-1">
      <h3 className="text-label font-semibold uppercase tracking-wide text-muted">{head}</h3>
      {body}
    </section>
  );
  const now_ = preview
    ? preview.conversations.total > 0
      ? t("seatTick.turbo.dialog.now", { count: preview.conversations.total, stages: preview.conversations.stages, agents: preview.conversations.agents })
      : t("seatTick.turbo.dialog.nowNone")
    : control.preview.state === "failed" ? t("seatTick.turbo.dialog.previewFailed") : t("seatTick.turbo.dialog.nowLoading");
  const left = (
    <div className="flex min-w-0 flex-col gap-3">
      {block(t("seatTick.turbo.dialog.nowHead"), <p data-turbo-now className="text-ui leading-5 text-primary">{now_}</p>)}
      {block(t("seatTick.turbo.dialog.nextHead"), <p className="text-ui leading-5 text-primary">{t("seatTick.turbo.dialog.next")}</p>)}
      {block(t("seatTick.turbo.dialog.accountsHead"), (
        <ul data-turbo-accounts className="flex min-w-0 flex-col gap-2">
          {accounts.map(account => {
            const week = account.weeklyPercent === null ? t("seatTick.turbo.dialog.weekUnknown")
              : account.weeklyResetsAt ? t("seatTick.turbo.dialog.week", { percent: Math.round(account.weeklyPercent), date: new Date(account.weeklyResetsAt * 1000).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" }) })
                : t("seatTick.turbo.dialog.weekNoReset", { percent: Math.round(account.weeklyPercent) });
            const outcome = !account.holdsCredits ? "none" : credits ? "paid" : "free";
            return (
              <li key={account.accountId} data-turbo-account={account.accountId} className="flex min-w-0 flex-col gap-0.5 rounded-control border border-border bg-sunken/40 px-2 py-1.5">
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2">
                  <span className="min-w-0 truncate text-ui font-semibold text-primary">{account.label}{account.plan ? <span className="font-normal text-muted"> · {account.plan}</span> : null}</span>
                  <span className="text-caption tabular-nums text-muted">{week}</span>
                </div>
                <span className="text-caption leading-4 text-secondary">{tierSummary(account, t)}</span>
                <span data-account-credit={outcome} className={`text-caption leading-4 ${outcome === "paid" ? "font-semibold text-danger" : "text-secondary"}`}>
                  {t(outcome === "paid" ? "seatTick.turbo.dialog.creditPaid" : outcome === "free" ? "seatTick.turbo.dialog.creditFree" : "seatTick.turbo.dialog.creditNone")}
                </span>
                {account.otherProjects > 0 ? <span className="text-caption leading-4 text-muted">{t("seatTick.turbo.dialog.shared", { count: account.otherProjects })}</span> : null}
                {account.unavailable ? <span className="text-caption leading-4 text-warning">{t(`seatTick.turbo.dialog.unavailable.${account.unavailable as "signed-out" | "removed"}`)}</span> : null}
              </li>
            );
          })}
        </ul>
      ))}
    </div>
  );
  const right = (
    <div className="flex min-w-0 flex-col gap-3">
      {block(t("seatTick.turbo.dialog.creditsHead"), payers.length ? (
        <div data-turbo-credits={credits ? "on" : "off"} className={`flex min-w-0 flex-col gap-1.5 rounded-control border px-2.5 py-2 ${credits
          ? "border-danger bg-[color-mix(in_oklab,var(--color-danger)_10%,var(--color-card))]"
          : "border-warning bg-[color-mix(in_oklab,var(--color-warning)_8%,var(--color-card))]"}`}>
          <label className={`flex cursor-pointer items-center gap-2 ${phone ? "min-h-11" : ""}`}>
            <input type="checkbox" data-turbo-credits-toggle aria-describedby={creditsAboutId} checked={credits}
              onChange={event => { setCredits(event.target.checked); if (event.target.checked && hours === "off") setHours("2"); }}
              className={phone ? "size-6" : "size-4"} />
            <span className={`text-ui font-semibold ${credits ? "text-danger" : "text-primary"}`}>{t("seatTick.turbo.dialog.creditsToggle")}</span>
          </label>
          <p id={creditsAboutId} className="text-caption leading-4 text-secondary">{t("seatTick.turbo.dialog.creditsText")}</p>
          <ul data-turbo-payers className="flex flex-col gap-0.5">
            {payers.map(account => (
              <li key={account.accountId} className="text-caption leading-4 text-primary">
                {t("seatTick.turbo.dialog.creditsRow", { account: account.label, tiers: paidTiers(account, t), balance: account.balance ?? t("seatTick.turbo.dialog.creditsBalanceUnknown") })}
              </li>
            ))}
          </ul>
          <p className="text-caption leading-4 text-muted">{t("seatTick.turbo.dialog.creditsFoot")}</p>
        </div>
      ) : (
        <p data-turbo-credits="none" className="text-caption leading-4 text-muted">{t("seatTick.turbo.dialog.creditsNone")}</p>
      ))}
      <p data-turbo-claude className="text-caption leading-4 text-secondary">{t("seatTick.turbo.dialog.claude")}</p>
      <label className="flex min-w-0 flex-col gap-1">
        <span className="text-ui text-primary">{t("seatTick.turbo.dialog.duration")}</span>
        <select data-turbo-duration value={hours} onChange={event => setHours(event.target.value as Hours)}
          className={`rounded-control border border-border bg-card px-2 ${phone ? "h-11 text-body" : "h-8 text-ui"} text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}>
          {(["1", "2", "4", "8"] as const).map(value => <option key={value} value={value}>{t("seatTick.turbo.dialog.hours", { n: Number(value) })}</option>)}
          <option value="off" disabled={credits}>{t("seatTick.turbo.dialog.untilOff")}</option>
        </select>
        {credits ? <span data-turbo-duration-note className="text-caption leading-4 text-muted">{t("seatTick.turbo.dialog.durationNote")}</span> : null}
      </label>
    </div>
  );
  const buttons = (
    <div className={`flex shrink-0 items-center justify-end gap-2 border-t border-border bg-card ${phone ? "px-4 py-3" : "px-4 py-2.5"}`}>
      <button ref={cancelRef} type="button" data-turbo-cancel onClick={close}
        className={`inline-flex items-center rounded-control border border-border bg-canvas px-3 font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "min-h-11 text-body" : "h-8 text-ui"}`}>
        {t("seatTick.turbo.dialog.cancel")}
      </button>
      <button type="button" data-turbo-confirm disabled={control.preview.state !== "ready"}
        onClick={() => void control.confirm({ hours, credits, creditAccounts: credits ? payers.map(account => account.accountId) : [] })}
        className={`inline-flex items-center gap-1.5 rounded-control bg-accent px-3 font-semibold text-on-brand hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 ${phone ? "min-h-11 text-body" : "h-8 text-ui"}`}>
        <TurboFlame className="turbo-btn-flame" />
        <span>{t("seatTick.turbo.dialog.confirm")}</span>
      </button>
    </div>
  );
  const title = (
    <div className={`flex shrink-0 items-center gap-2 border-b border-border ${phone ? "px-4 py-2" : "px-4 py-3"}`}>
      <span aria-hidden className="turbo-dlg-icon"><TurboFlame className="turbo-dlg-flame" /><TurboNozzle className="turbo-dlg-nozzle" /></span>
      <h2 id={titleId} className="min-w-0 flex-1 text-body font-bold text-primary">{t("seatTick.turbo.dialog.title")}</h2>
      {phone ? (
        <button type="button" data-turbo-close aria-label={t("seatTick.turbo.dialog.cancel")} onClick={close}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-secondary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
          <X className="h-5 w-5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
  return createPortal(
    <div role="presentation" data-turbo-scrim onClick={event => { if (event.target === event.currentTarget) close(); }}
      className={`fixed inset-0 ${Z.overlay} flex bg-black/40 ${phone ? "items-end" : "items-center justify-center p-4"}`}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={leadId} tabIndex={-1}
        data-turbo-dialog data-turbo-surface={phone ? "mobile" : "desktop"}
        className={phone
          ? "flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[16px] border border-border bg-card shadow-2"
          : "flex max-h-[min(660px,calc(100vh-32px))] w-full max-w-[860px] flex-col overflow-hidden rounded-surface border border-border bg-card shadow-2"}>
        {title}
        <div data-turbo-dialog-body className={`min-h-0 flex-1 overflow-y-auto ${phone ? "px-4 py-3" : "px-4 py-3"}`}>
          <p id={leadId} className="mb-3 text-ui leading-5 text-primary">{t("seatTick.turbo.dialog.lead")}</p>
          <div className={phone ? "flex flex-col gap-4" : "grid grid-cols-2 gap-5"}>{left}{right}</div>
        </div>
        {buttons}
      </div>
    </div>,
    document.body,
  );
}
