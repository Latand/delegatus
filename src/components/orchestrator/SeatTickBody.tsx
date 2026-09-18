"use client";

import { LoaderCircle, RotateCcw } from "lucide-react";
import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

import { Select } from "@/components/ui/Select";
import { useLocale } from "@/lib/i18n";
import type { SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";

import { seatTickAge, seatTickLocalTime, seatTickReading, type SeatTickReading } from "./seatTickView";
import type { SeatTickChange, SeatTickSettingsRead } from "./useSeatTickSettings";

/*
 * What is inside the seat tick popover and inside the seat tick sheet — the
 * same content in the same order on both surfaces (#1681), because the desktop
 * and the phone are showing one record and there is no second thing to say
 * about it on a smaller screen:
 *
 *   1. the head: the project, and the closed summary with its dot;
 *   2. CONFIGURED, editable, bound to the stored record;
 *   3. ACTUAL, read only, ages and honest unknowns;
 *   4. Details, closed — the board card, who set it, the monitor prompt.
 *
 * Two things differ by surface and nothing else does. Control sizing: the
 * phone gives every hit target 44 px (mobile v2 §5), which the incumbent row
 * on the desktop cannot spend. And WHERE the actions go: the popover renders
 * them under the form, the sheet parks them in its footer at the thumb — which
 * is why the draft lives in `useSeatTickDraft`, above both, rather than inside
 * this component where a footer could not reach it.
 *
 * Nothing here validates. Every rule about what a tick setting may be lives in
 * `applySeatTickSettingsChange`, and its refusal is shown verbatim under the
 * form — a copy of the rule in this file is exactly how the two would drift.
 */

/** The expiries offered, in minutes. `""` is the setting that stands until
    someone changes it; `keep` appears only while the record already carries
    one, and sends nothing. */
const UNTIL_CHOICES = [
  { value: "", key: "seatTick.untilStands" },
  { value: "60", key: "seatTick.until1h" },
  { value: "240", key: "seatTick.until4h" },
  { value: "1440", key: "seatTick.until24h" },
  { value: "10080", key: "seatTick.until7d" },
] as const;

export interface SeatTickDraft {
  enabled: boolean;
  /** Minutes as typed. Empty means the default interval. */
  interval: string;
  until: string;
  reason: string;
}

function draftOf(record: SeatTickSettingsAnswer | null): SeatTickDraft {
  const settings = record?.settings;
  return {
    enabled: settings ? settings.enabled : true,
    interval: settings == null || settings.wakeIntervalMinutes === null ? "" : String(settings.wakeIntervalMinutes),
    until: settings?.until ? "keep" : "",
    reason: settings?.reason ?? "",
  };
}

/** The record the draft was adopted from. A new one means the record moved —
    a save landed, or another caller changed this project's tick — and the
    fields follow it. An optimistic overlay is NOT one of these, so a refused
    save rolls the display back without emptying the field being corrected. */
function signatureOf(record: SeatTickSettingsAnswer | null): string {
  const settings = record?.settings;
  if (!settings) return "";
  return [record?.project, settings.enabled, settings.wakeIntervalMinutes, settings.reason, settings.until, settings.updatedAt].join("");
}

/** Only what CHANGED, so a save touches the fields the operator touched and
    the module's «a change needs at least one field» stays meaningful. */
function changeOf(draft: SeatTickDraft, record: SeatTickSettingsAnswer | null): SeatTickChange {
  const current = draftOf(record);
  const change: SeatTickChange = {};
  if (draft.enabled !== current.enabled) change.enabled = draft.enabled;
  if (draft.interval.trim() !== current.interval) {
    const raw = draft.interval.trim();
    const parsed = Number(raw);
    /* Empty is the DEFAULT interval, which the module spells `null`.
       Everything else is handed over for the module to judge — and a
       non-finite entry («abc», «1e400») is handed over AS TYPED rather than as
       `Number(raw)`: NaN and Infinity both serialise to JSON `null`, which the
       module reads as «restore the default», so coercing here would silently
       discard the operator's interval instead of showing them the refusal that
       names it. */
    change.wakeIntervalMinutes = raw === "" ? null : Number.isFinite(parsed) ? parsed : raw;
  }
  if (draft.reason.trim() !== current.reason.trim()) change.reason = draft.reason.trim() || null;
  if (draft.until !== current.until) change.untilMinutes = draft.until === "" ? null : Number(draft.until);
  return change;
}

export interface SeatTickDraftState {
  draft: SeatTickDraft;
  setDraft: Dispatch<SetStateAction<SeatTickDraft>>;
  change: SeatTickChange;
  dirty: boolean;
}

/**
 * The form's draft, bound to the STORED record (the issue: «a form bound to
 * the stored record, never to the echo of a send»).
 *
 * Held above the body so the phone can put Save in its sheet footer and the
 * desktop can put it under the form, without either surface holding a second
 * draft.
 */
export function useSeatTickDraft(record: SeatTickSettingsAnswer | null): SeatTickDraftState {
  const [draft, setDraft] = useState<SeatTickDraft>(() => draftOf(record));
  const [adopted, setAdopted] = useState<string>(() => signatureOf(record));
  const signature = signatureOf(record);
  if (signature !== adopted) {
    /* Render-phase adoption: the record moved, so the fields move with it
       before this commit paints a form bound to a record nobody holds. */
    setAdopted(signature);
    setDraft(draftOf(record));
  }
  const change = changeOf(draft, record);
  return { draft, setDraft, change, dirty: Object.keys(change).length > 0 };
}

const DOT: Record<SeatTickReading["tone"], string> = {
  ok: "bg-success",
  warn: "bg-warning",
  muted: "bg-muted",
  unknown: "border border-strong bg-transparent",
};

/** The tone dot: the ACTUAL state, and never the schedule. */
export function SeatTickDot({ tone, className = "" }: { tone: SeatTickReading["tone"]; className?: string }) {
  return <span aria-hidden data-seat-tick-dot={tone} className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]} ${className}`} />;
}

/** Save, and Restore default while there is a setting to restore. Rendered by
    the popover under the form and by the sheet in its footer. */
export function SeatTickActions({ read, state, offDefault, surface }: {
  read: SeatTickSettingsRead;
  state: SeatTickDraftState;
  offDefault: boolean;
  surface: "desktop" | "mobile";
}) {
  const { t } = useLocale();
  const phone = surface === "mobile";
  /* Written out rather than interpolated: a Tailwind class assembled from a
     variable is a class Tailwind never sees and never emits. */
  const button = phone
    ? "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-control px-3 text-body font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
    : "inline-flex h-7 items-center justify-center gap-1.5 rounded-control px-3 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50";
  return (
    <div className={`flex min-w-0 gap-2 ${phone ? "flex-1" : ""}`}>
      <button
        type="button"
        data-seat-tick-save
        disabled={!state.dirty || read.saving}
        onClick={() => {
          if (!state.dirty || read.saving) return;
          void read.save(state.change);
        }}
        className={`${button} ${phone ? "flex-1" : ""} min-w-0 border border-accent bg-accent text-white shadow-1 active:opacity-90`}
      >
        {read.saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
        <span className="truncate">{t(read.saving ? "seatTick.saving" : "seatTick.save")}</span>
      </button>
      {offDefault ? (
        <button
          type="button"
          data-seat-tick-restore
          disabled={read.saving}
          onClick={() => {
            if (read.saving) return;
            /* Restoring the default needs no reason, exactly as the tool's
               restore does: the record it clears already said why. */
            void read.save({ enabled: true, wakeIntervalMinutes: null, untilMinutes: null });
          }}
          className={`${button} shrink-0 border border-border bg-card text-secondary hover:border-accent/45 hover:text-accent`}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          <span className="truncate">{t("seatTick.restore")}</span>
        </button>
      ) : null}
    </div>
  );
}

export function SeatTickBody({ project, projectName, read, state, surface, actions }: {
  project: string;
  projectName: string;
  read: SeatTickSettingsRead;
  state: SeatTickDraftState;
  surface: "desktop" | "mobile";
  /** Where this surface puts Save. Null on the phone, whose sheet footer
      renders the same node at the thumb. */
  actions: ReactNode;
}) {
  const { t, locale } = useLocale();
  const now = Date.now();
  const reading = seatTickReading(read, now, t);
  const record = read.record;
  const { draft, setDraft } = state;

  const phone = surface === "mobile";
  const storedUntil = record?.settings.until ?? null;
  const row = phone ? "min-h-11" : "min-h-7";
  const control = phone
    ? "h-11 rounded-control border border-border bg-card px-2.5 text-body text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    : "h-7 rounded-control border border-border bg-card px-2 text-ui text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";

  return (
    <div
      data-seat-tick-body={project}
      data-seat-tick-state={reading.state}
      className={`flex min-w-0 flex-col gap-3 ${phone ? "px-4 pb-3" : "p-3"}`}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {/* The phone's sheet header already says «Seat tick · <project>», so
            repeating it here is the same line twice in 44 px of vertical room.
            The desktop popover has no header of its own, so it keeps it. */}
        {phone ? null : (
          <p className="min-w-0 truncate text-label font-semibold text-secondary" title={projectName}>
            {t("seatTick.head", { project: projectName })}
          </p>
        )}
        <p className="flex min-w-0 items-center gap-1.5 text-ui text-primary" data-seat-tick-summary>
          <SeatTickDot tone={reading.tone} />
          <span className="min-w-0 break-words">{reading.line}</span>
        </p>
      </div>

      {/* CONFIGURED — the only editable half. */}
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-label font-semibold uppercase tracking-wide text-muted">{t("seatTick.configuredHead")}</p>
        <div className={`flex min-w-0 items-center gap-2 ${row}`}>
          <span className="min-w-0 flex-1 text-ui text-primary">{t("seatTick.enabledLabel")}</span>
          <button
            type="button"
            role="switch"
            data-seat-tick-enabled={String(draft.enabled)}
            aria-checked={draft.enabled}
            aria-label={t(draft.enabled ? "seatTick.disableAria" : "seatTick.enableAria")}
            disabled={read.saving}
            onClick={() => setDraft((previous) => ({ ...previous, enabled: !previous.enabled }))}
            className={`relative ${phone ? "h-7 w-12" : "h-5 w-9"} shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 ${
              draft.enabled ? "border-accent bg-accent" : "border-border bg-sunken"
            }`}
          >
            <span
              aria-hidden
              className={`absolute top-0.5 ${phone ? "h-5 w-5" : "h-3.5 w-3.5"} rounded-full bg-card shadow-1 transition-all ${
                draft.enabled ? (phone ? "left-6" : "left-[18px]") : "left-0.5"
              }`}
            />
          </button>
        </div>

        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-ui text-primary">{t("seatTick.intervalLabel")}</span>
          <input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            data-seat-tick-interval
            value={draft.interval}
            disabled={read.saving}
            placeholder={t("seatTick.intervalPlaceholder", { minutes: record?.defaultWakeIntervalMinutes ?? 60 })}
            onChange={(event) => setDraft((previous) => ({ ...previous, interval: event.target.value }))}
            className={`${control} w-full tabular-nums disabled:opacity-50`}
          />
          <span className="text-caption leading-4 text-muted">
            {record && record.policy.checkIntervalMinutes === null
              ? t("seatTick.intervalHintChecksOff")
              : t("seatTick.intervalHint", { every: record?.policy.checkIntervalMinutes ?? 5 })}
          </span>
        </label>

        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-ui text-primary">{t("seatTick.untilLabel")}</span>
          <Select
            roomy={phone}
            data-seat-tick-until
            value={draft.until}
            disabled={read.saving}
            onChange={(event) => setDraft((previous) => ({ ...previous, until: event.target.value }))}
            className={phone ? "h-11 w-full" : "w-full"}
          >
            {/* The expiry the record already carries, as a local time: every
                choice below is «from now», and picking one of them would move
                an expiry the operator never touched. */}
            {storedUntil ? (
              <option value="keep">
                {t("seatTick.untilKeep", { time: seatTickLocalTime(storedUntil, now, locale) ?? storedUntil })}
              </option>
            ) : null}
            {UNTIL_CHOICES.map((choice) => (
              <option key={choice.value || "stands"} value={choice.value}>{t(choice.key)}</option>
            ))}
          </Select>
        </label>

        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-ui text-primary">{t("seatTick.reasonLabel")}</span>
          <textarea
            rows={2}
            data-seat-tick-reason
            value={draft.reason}
            disabled={read.saving}
            onChange={(event) => setDraft((previous) => ({ ...previous, reason: event.target.value }))}
            className={`min-h-0 w-full resize-y rounded-control border border-border bg-card px-2 py-1.5 ${phone ? "text-body" : "text-ui"} text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50`}
          />
          <span className="text-caption leading-4 text-muted">{t("seatTick.reasonHint")}</span>
        </label>

        {read.error ? (
          <p role="alert" data-seat-tick-error className="rounded-control border border-danger/40 bg-danger/10 px-2 py-1.5 text-ui leading-4 text-danger">
            {read.error}
          </p>
        ) : null}

        {actions}
      </div>

      {/* ACTUAL — read only, and never folded into the switch above. */}
      <div className="flex min-w-0 flex-col gap-1.5 border-t border-border pt-2.5">
        <p className="text-label font-semibold uppercase tracking-wide text-muted">{t("seatTick.actualHead")}</p>
        <p data-seat-tick-sentence className="text-ui leading-4 text-secondary">{reading.sentence}</p>
        <dl className="flex min-w-0 flex-col gap-1">
          {reading.rows.map((entry) => (
            <div key={entry.label} className={`flex min-w-0 items-baseline gap-2 ${phone ? "min-h-6" : ""}`}>
              <dt className="shrink-0 text-caption text-muted">{entry.label}</dt>
              <dd className="min-w-0 flex-1 break-words text-right text-ui text-primary">{entry.value}</dd>
            </div>
          ))}
        </dl>
        {/* THAT a store failed belongs here; WHAT it said does not. An
            `Error.message` off the state store carries the absolute path it
            failed to open, and the primary view is the one place this control
            promises to keep ids, keys and paths out of (#1681 acceptance 6).
            The message itself is in Details, with the rest of the raw record. */}
        {read.answer?.stateError ? (
          <p role="status" data-seat-tick-state-unreadable className="text-caption leading-4 text-warning">{t("seatTick.stateUnreadable")}</p>
        ) : null}
        {read.answer?.journalError ? (
          <p role="status" data-seat-tick-journal-unreadable className="text-caption leading-4 text-warning">{t("seatTick.journalUnreadable")}</p>
        ) : null}
      </div>

      {/* DETAILS — the only place an id, a path or journal text may appear. */}
      {record ? <SeatTickDetails record={record} now={now} locale={locale} phone={phone} /> : null}
    </div>
  );
}

const ACTORS = {
  gateway: "seatTick.actor.gateway",
  manager: "seatTick.actor.manager",
  agent: "seatTick.actor.agent",
  unidentified: "seatTick.actor.unidentified",
} as const;

function SeatTickDetails({ record, now, locale, phone }: {
  record: SeatTickSettingsAnswer;
  now: number;
  locale: string;
  phone: boolean;
}) {
  const { t } = useLocale();
  const setBy = record.settings.setBy;
  const stamp = seatTickLocalTime(record.settings.updatedAt, now, locale);
  const prompt = record.settings.monitorPrompt;
  return (
    <details data-seat-tick-details className="min-w-0 border-t border-border pt-2">
      <summary className={`cursor-pointer list-none ${phone ? "min-h-11 py-2.5" : ""} text-ui font-semibold text-secondary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}>
        {t("seatTick.details")}
      </summary>
      <div className="flex min-w-0 flex-col gap-2 pt-2">
        {record.cardText ? (
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-caption font-semibold text-muted">{t("seatTick.cardHead")}</p>
            <pre className="max-h-40 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-sunken p-2 font-mono text-caption leading-4 text-secondary">{record.cardText}</pre>
          </div>
        ) : (
          <p className="text-caption leading-4 text-muted">{t("seatTick.cardNone")}</p>
        )}
        <p className="min-w-0 break-words text-caption leading-4 text-muted">
          {setBy
            ? t("seatTick.setBy", {
              who: t(ACTORS[setBy.kind]),
              at: stamp ?? t("seatTick.unknown"),
              conversation: setBy.conversationId ?? t("seatTick.noConversation"),
            })
            : t("seatTick.setByNobody")}
        </p>
        {prompt ? (
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-caption font-semibold text-muted">{t("seatTick.promptHead", { chars: record.monitorPromptLength })}</p>
            {/* The seat's own words, read only: editing them from the browser
                is a stated non-goal — they are the agent's record (#1280). */}
            <pre className="max-h-40 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-sunken p-2 font-mono text-caption leading-4 text-secondary">{prompt}</pre>
          </div>
        ) : (
          <p className="text-caption leading-4 text-muted">{t("seatTick.promptNone")}</p>
        )}
        {record.lastRun ? (
          <p className="min-w-0 break-words text-caption leading-4 text-muted">
            {t("seatTick.lastRun", {
              verdict: record.lastRun.verdict,
              age: seatTickAge(record.lastRun.at, now, t) ?? t("seatTick.unknown"),
              detail: record.lastRun.detail ?? t("seatTick.none"),
            })}
          </p>
        ) : null}
        {/* Why a store could not be read, in its own words. It lands here
            because a filesystem error names the path it failed on. */}
        {record.stateError ? (
          <p data-seat-tick-state-error className="min-w-0 break-words text-caption leading-4 text-warning">
            {t("seatTick.stateErrorDetail", { error: record.stateError })}
          </p>
        ) : null}
        {record.journalError ? (
          <p data-seat-tick-journal-error className="min-w-0 break-words text-caption leading-4 text-warning">
            {t("seatTick.journalErrorDetail", { error: record.journalError })}
          </p>
        ) : null}
        <a
          href={`/api/monitor/seat-tick?project=${encodeURIComponent(record.project)}`}
          target="_blank"
          rel="noreferrer"
          data-seat-tick-diagnostics
          className={`inline-flex ${phone ? "min-h-11" : ""} items-center text-ui font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
        >
          {t("seatTick.diagnostics")}
        </a>
      </div>
    </details>
  );
}
