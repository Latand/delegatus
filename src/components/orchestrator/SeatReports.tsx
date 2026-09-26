"use client";

import { ChevronRight, LoaderCircle, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useAnchoredBox } from "@/components/feed/SpeakMenu";
import { Z } from "@/components/layers";
import { useModalLayer } from "@/components/modalLayer";
import { AddChatForm, ERROR_KEYS, TokenForm } from "@/components/TelegramBot";
import { useTelegramBot } from "@/hooks/useTelegramBot";
import { useLocale, type TFunction } from "@/lib/i18n";

/*
 * The orchestrator's Reports section (docs/design/orchestrator-reports.md
 * §5.6): whether this project's reports also go to Telegram, and to which
 * group. Every project is set on its own seat, so different projects report to
 * different groups; the stored choice is the project's `reportTelegram` in
 * project-settings.json, written through PUT /api/projects/settings, which
 * holds the operator-only and allowlist checks.
 *
 * The opt-in stays explicit: a project that never chose reports to the log
 * only, and switching Telegram on writes nothing until a group is picked and
 * saved. Switching it off on a project that posts stores "Log only". The group
 * picker lists the chats the bot may post in, and a chat can be added by its
 * id or @username right there, for a post-only bot that never hears of the
 * groups it joins. The desktop opens it from a chip in the seat's own row, the
 * phone from a row in the seat sheet.
 */

export type ProjectReportSettings = {
  /** A chat, "Log only" (`chat: null`), or null when never chosen. */
  reportTelegram: { chat: string | null; name?: string } | null;
  /** The chosen chat's title, which names it on the closed chip. */
  reportChatTitle: string | null;
  reportNameSuggestion: string | null;
};

export type ProjectReportsRead = {
  settings: ProjectReportSettings | null;
  saving: boolean;
  failed: boolean;
  /** Writes the choice; null stores "Log only". True once stored. */
  save(outcome: { chat: string; name: string } | null): Promise<boolean>;
  /** Reads the stored choice again: the overview may have moved it. */
  reload(): void;
};

function settingsOf(body: Partial<ProjectReportSettings>): ProjectReportSettings {
  return { reportTelegram: body.reportTelegram ?? null, reportChatTitle: body.reportChatTitle ?? null, reportNameSuggestion: body.reportNameSuggestion ?? null };
}

export function useProjectReports(project: string): ProjectReportsRead {
  /* Keyed by project, so a project switch never shows the previous one's. */
  const [read, setRead] = useState<{ project: string; settings: ProjectReportSettings } | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/projects/settings?project=${encodeURIComponent(project)}`, { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const settings = settingsOf(await response.json() as Partial<ProjectReportSettings>);
        if (!cancelled) setRead({ project, settings });
      } catch {
        // The chip keeps its last face; the next open reads again.
      }
    })();
    return () => { cancelled = true; };
  }, [project, generation]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  const save = useCallback(async (outcome: { chat: string; name: string } | null) => {
    setSaving(true);
    setFailed(false);
    try {
      const response = await fetch("/api/projects/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, reportTelegram: outcome }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setRead({ project, settings: settingsOf(await response.json().catch(() => ({})) as Partial<ProjectReportSettings>) });
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setSaving(false);
    }
  }, [project]);
  return { settings: read?.project === project ? read.settings : null, saving, failed, save, reload };
}

/** The chat the project posts to, or null for the log only. */
function chosenChat(settings: ProjectReportSettings | null): string | null {
  return settings?.reportTelegram?.chat ?? null;
}

/** The closed chip's value and its one-line reading. A chat is named by its
    title, as the picker and the overview name it: aliases that share a
    prefix truncate alike. */
export function seatReportsReading(settings: ProjectReportSettings | null, t: TFunction): { face: string; line: string; chat: string | null } {
  const chat = chosenChat(settings);
  const title = settings?.reportChatTitle || chat;
  return chat && title
    ? { face: title, line: t("seatReports.toChat", { chat: title }), chat }
    : { face: t("seatReports.faceLog"), line: t("seatReports.logOnly"), chat: null };
}

export function SeatReportsBody({ project, projectName, reports, surface }: {
  project: string;
  projectName: string;
  reports: ProjectReportsRead;
  surface: "desktop" | "mobile";
}) {
  const { t } = useLocale();
  const bot = useTelegramBot(true);
  const phone = surface === "mobile";
  const settings = reports.settings;
  const stored = chosenChat(settings);
  /* What the operator did here; until then the section shows what is stored. */
  const [draftOn, setDraftOn] = useState<boolean | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [typedName, setTypedName] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const status = bot.status;
  const connected = status?.connected === true;
  const postable = status?.chats.filter((chat) => chat.member && chat.postable && chat.alias) ?? [];
  const on = draftOn ?? stored !== null;
  /* The chosen chat when agents may not post in it now: it stays listed as
     chosen, so the section says where the Viewer addresses reports. */
  const refused = stored && status && !postable.some((chat) => chat.alias === stored) ? stored : null;
  const pickedLive = picked !== null && postable.some((chat) => chat.alias === picked) ? picked : null;
  const choice = pickedLive ?? stored;
  const storedName = settings?.reportTelegram?.name ?? "";
  const name = typedName ?? (storedName || settings?.reportNameSuggestion || "");
  const nameMissing = choice !== null && name.trim() === "";
  const dirty = choice !== null && choice !== refused && (choice !== stored || name.trim() !== storedName);
  const canSave = on && dirty && !nameMissing && !reports.saving;
  const title = (alias: string) => status?.chats.find((chat) => chat.alias === alias || chat.chatId === alias)?.title ?? alias;

  const reset = () => { setDraftOn(null); setPicked(null); setTypedName(null); };
  const toggle = async () => {
    setSaved(false);
    if (!on) { setDraftOn(true); return; }
    /* Off: a project that posts stores "Log only"; one that never chose, or
       already chose the log, keeps its record untouched. */
    if (stored !== null) {
      if (await reports.save(null)) { reset(); setSaved(true); }
      return;
    }
    reset();
  };
  const save = async () => {
    if (!canSave || choice === null) return;
    if (await reports.save({ chat: choice, name: name.trim() })) { reset(); setSaved(true); }
  };

  const control = phone
    ? "h-11 rounded-control border bg-card px-2.5 text-body text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    : "h-7 rounded-control border bg-card px-2 text-ui text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
  const button = phone
    ? "inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-control px-3 text-body font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
    : "inline-flex h-7 items-center justify-center gap-1.5 self-start rounded-control px-3 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50";

  const radio = (value: string, disabled: boolean) => {
    const checked = choice === value;
    return (
      <button
        key={value}
        type="button"
        role="radio"
        aria-checked={checked}
        disabled={disabled || reports.saving}
        data-seat-reports-chat={value}
        onClick={() => { setPicked(value); setSaved(false); }}
        className={`flex w-full min-w-0 items-center gap-2.5 rounded-control border px-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed ${phone ? "min-h-11 py-2" : "min-h-8 py-1.5"} ${checked ? "border-accent/50 bg-accent-soft/50" : "border-border bg-card hover:bg-sunken"}`}
      >
        <span aria-hidden className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 ${checked ? "border-accent" : "border-strong"}`}>
          {checked ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={`truncate font-semibold text-primary ${phone ? "text-body" : "text-ui"}`}>{title(value)}</span>
          <span className="truncate font-mono text-caption text-muted">{value}</span>
          {value === refused ? <span data-seat-reports-refused="" className="text-caption leading-snug text-warning">{t("onboarding.telegram.refused")}</span> : null}
        </span>
      </button>
    );
  };

  return (
    <div data-seat-reports-body={project} data-seat-reports-state={stored ? "chat" : "log"} className={`flex min-w-0 flex-col gap-3 ${phone ? "px-4 pb-3" : "p-3"}`}>
      {phone ? null : (
        <p className="min-w-0 truncate text-label font-semibold text-secondary" title={projectName}>
          {t("seatReports.sheetTitle", { project: projectName })}
        </p>
      )}
      <div className={`flex min-w-0 items-center gap-2 ${phone ? "min-h-11" : "min-h-7"}`}>
        <span className="min-w-0 flex-1 text-ui font-semibold text-primary">{t("seatReports.telegram")}</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t("seatReports.telegram")}
          data-seat-reports-switch={on ? "on" : "off"}
          disabled={reports.saving || settings === null}
          onClick={() => void toggle()}
          /* The phone's hit area is 44 px around the tick sheet's own track. */
          className={`inline-flex shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 ${phone ? "-mr-1 h-11 w-14" : "h-5 w-9"}`}
        >
          <span aria-hidden className={`relative ${phone ? "h-7 w-12" : "h-5 w-9"} shrink-0 rounded-full border transition-colors ${on ? "border-accent bg-accent" : "border-border bg-sunken"}`}>
            <span className={`absolute top-0.5 ${phone ? "h-5 w-5" : "h-3.5 w-3.5"} rounded-full bg-card shadow-1 transition-all ${on ? (phone ? "left-6" : "left-[18px]") : "left-0.5"}`} />
          </span>
        </button>
      </div>
      <p role="status" data-seat-reports-line="" className="-mt-2 text-ui leading-snug text-secondary">
        {stored ? t("seatReports.toChat", { chat: title(stored) }) : on ? t("seatReports.pick") : t("seatReports.logOnly")}
      </p>

      {bot.failure ? (
        <p role="alert" className="rounded-control border border-danger/40 bg-danger/10 px-2 py-1.5 text-ui leading-4 text-danger">
          {t(ERROR_KEYS[bot.failure.code] ?? "telegram.actionFailed")}
        </p>
      ) : null}

      {on && status && !connected ? (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-ui leading-snug text-secondary">{t("seatReports.noBot")}</p>
          <TokenForm busy={bot.busy} onConnect={(token) => void bot.connect(token)} />
        </div>
      ) : null}

      {on && connected ? (
        <>
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-label font-semibold uppercase tracking-wide text-muted">{t("seatReports.group")}</p>
            {postable.length === 0 && !refused ? <p className="text-ui leading-snug text-muted">{t("seatReports.noChats")}</p> : null}
            <div role="radiogroup" aria-label={t("seatReports.group")} className="flex min-w-0 flex-col gap-1.5">
              {refused ? radio(refused, true) : null}
              {postable.map((chat) => radio(chat.alias!, false))}
            </div>
          </div>
          <details data-seat-reports-add="" open={postable.length === 0 ? true : undefined} className="group min-w-0">
            <summary className={`flex cursor-pointer list-none items-center gap-1 text-ui font-semibold text-secondary [&::-webkit-details-marker]:hidden ${phone ? "min-h-11" : "min-h-7"}`}>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
              {t("telegram.bot.addTitle")}
            </summary>
            <div className="pt-1">
              <AddChatForm state={bot} onAdded={(alias) => { setPicked(alias); setSaved(false); }} />
            </div>
          </details>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-label font-semibold uppercase tracking-wide text-muted">{t("onboarding.telegram.name")}</span>
            <input
              type="text"
              value={name}
              maxLength={60}
              autoComplete="off"
              data-seat-reports-name=""
              aria-invalid={nameMissing}
              onChange={(event) => { setTypedName(event.target.value); setSaved(false); }}
              className={`${control} w-full ${nameMissing ? "border-danger" : "border-border"}`}
            />
            <span className={`text-caption leading-snug ${nameMissing ? "text-danger" : "text-muted"}`}>{t("onboarding.telegram.nameHint")}</span>
          </label>
          <p data-seat-reports-warning="" className="text-caption leading-snug text-warning">{t("onboarding.telegram.rule")}</p>
          <button
            type="button"
            data-seat-reports-save=""
            disabled={!canSave}
            onClick={() => void save()}
            className={`${button} min-w-0 border border-brand bg-brand text-on-brand shadow-1 active:opacity-90`}
          >
            {reports.saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            <span className="truncate">{t("seatReports.save")}</span>
          </button>
        </>
      ) : null}

      {reports.failed ? <p role="alert" className="text-ui font-semibold text-danger">{t("seatReports.failed")}</p> : null}
      {saved && !reports.failed ? (
        <p data-seat-reports-saved="" className="text-ui font-semibold text-success">
          {stored ? t("onboarding.telegram.savedChat", { chat: title(stored) }) : t("onboarding.telegram.savedLog")}
        </p>
      ) : null}
    </div>
  );
}

const POPOVER_WIDTH = 340;

/**
 * The Reports chip in the seat's own row, beside the tick (#1681's pattern):
 * a send glyph, the setting's name and where reports go, the chat's title or
 * "Log", as the phone's seat-sheet row reads it. Without the name a closed
 * "Log" read as a way to open the report log. Where the row is tight the value
 * gives way first and the name stays (globals.css, `incumbent-host`).
 * Its popover is portalled for the same reason the tick's is: both hosts of
 * the row clip an in-flow popover.
 */
export function SeatReportsChip({ project, projectName }: { project: string; projectName: string }) {
  const { t } = useLocale();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === project;
  const anchorRef = useRef<HTMLButtonElement>(null);
  const reports = useProjectReports(project);
  const reading = seatReportsReading(reports.settings, t);
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-seat-reports-chip={reading.chat ? "chat" : "log"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("seatReports.chipAria", { line: reading.line })}
        title={reading.line}
        onClick={() => setOpenFor((previous) => (previous === project ? null : project))}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-control border border-border bg-card px-2 text-caption font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <Send className={`h-3 w-3 shrink-0 ${reading.chat ? "text-accent" : ""}`} aria-hidden />
        <span data-seat-reports-label>{t("seatReports.label")}</span>
        <span data-seat-reports-value className="inline-flex min-w-0 items-center gap-1 font-normal">
          <span aria-hidden className="text-muted">·</span>
          <span data-seat-reports-face className="max-w-[112px] truncate">{reading.face}</span>
        </span>
      </button>
      {open ? (
        <SeatReportsPopover anchorRef={anchorRef} project={project} projectName={projectName} reports={reports} onClose={() => setOpenFor(null)} />
      ) : null}
    </>
  );
}

function SeatReportsPopover({ anchorRef, project, projectName, reports, onClose }: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  project: string;
  projectName: string;
  reports: ProjectReportsRead;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const { style, onScreen } = useAnchoredBox(anchorRef, rootRef, POPOVER_WIDTH);
  useModalLayer({ containerRef: rootRef, onClose, lockScroll: false });
  /* A fresh read on open, as the tick's popover does. */
  useEffect(() => {
    reports.reload();
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const away = (event: Event) => {
      const target = event.target as Node | null;
      if (rootRef.current?.contains(target ?? null) || anchorRef.current?.contains(target ?? null)) return;
      onClose();
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [anchorRef, onClose]);
  useEffect(() => {
    if (!onScreen) onClose();
  }, [onScreen, onClose]);

  if (typeof document === "undefined" || !onScreen) return null;
  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="false"
      aria-label={t("seatReports.dialogAria", { project: projectName })}
      tabIndex={-1}
      data-seat-reports-popover={project}
      style={style}
      className={`fixed ${Z.popover} flex max-h-[80vh] w-[340px] max-w-[calc(100vw-16px)] flex-col overflow-y-auto rounded-surface border border-border bg-card shadow-2 outline-none`}
    >
      <SeatReportsBody project={project} projectName={projectName} reports={reports} surface="desktop" />
    </div>,
    document.body,
  );
}
