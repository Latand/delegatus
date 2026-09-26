"use client";

import { Send } from "lucide-react";
import { useEffect, useState } from "react";

import { ChatRow, ERROR_KEYS, TokenForm } from "@/components/TelegramBot";
import { useTelegramBot } from "@/hooks/useTelegramBot";
import { useLocale } from "@/lib/i18n";

import type { GuideProject } from "./ProjectStep";

/**
 * The setup guide's optional step (docs/design/orchestrator-reports.md §5.6):
 * choose the Telegram chat the project's orchestrator reports also go to. It
 * is built from the bot panel's own pieces over the same operator-only routes,
 * so there is no second path to the bot: the token form when no bot is
 * connected, the chats that accept posts as choices, and the panel's own
 * switch for a chat the bot is in but may not post to yet. "Log only" is
 * always a choice, and Skip writes nothing. The choice where reports go now
 * is preselected and marked in use: for a project that never chose, that is
 * the bot's one allowed chat, since the operator already picked it in the
 * bot panel; with several such chats nothing is preselected and the step asks.
 */

const LOG_ONLY = "\u0000log-only";

export type TelegramReportsOutcome = { chat: string; name: string } | null;

type ProjectReportSettings = {
  /** The operator's choice: a chat, "Log only" (`chat: null`), or null when never chosen. */
  reportTelegram: { chat: string | null; name?: string } | null;
  /** Where reports go now besides the log, null for the log only. */
  reportDestination: { chat: string; name: string; source: "chosen" | "only-allowed-chat" } | null;
  reportNameSuggestion: string | null;
  postableChats: number;
};

function settingsOf(body: Partial<ProjectReportSettings>): ProjectReportSettings {
  return {
    reportTelegram: body.reportTelegram ?? null,
    reportDestination: body.reportDestination ?? null,
    reportNameSuggestion: body.reportNameSuggestion ?? null,
    postableChats: typeof body.postableChats === "number" ? body.postableChats : 0,
  };
}

async function readSettings(project: string): Promise<ProjectReportSettings | null> {
  try {
    const response = await fetch(`/api/projects/settings?project=${encodeURIComponent(project)}`, { cache: "no-store" });
    if (!response.ok) return null;
    return settingsOf(await response.json() as Partial<ProjectReportSettings>);
  } catch {
    return null;
  }
}

/** The radio that stands for where reports go now. */
function inUseChoice(settings: ProjectReportSettings): string {
  return settings.reportDestination?.chat ?? LOG_ONLY;
}

export function TelegramReportsStep({ project, onSaved, onSkip }: {
  project: GuideProject | null;
  /** The destination was written; null is "log only". */
  onSaved: (outcome: TelegramReportsOutcome) => void;
  onSkip: () => void;
}) {
  const { t } = useLocale();
  const bot = useTelegramBot(project !== null);
  const [choice, setChoice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<TelegramReportsOutcome | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [settings, setSettings] = useState<ProjectReportSettings | null>(null);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    void readSettings(project.project).then((settings) => {
      if (cancelled || !settings) return;
      setSettings(settings);
      /* A project that never chose starts on where its reports go now, which
         is nothing when several chats accept posts: the operator picks. */
      const chosen = settings.reportTelegram ? settings.reportTelegram.chat ?? LOG_ONLY : settings.reportDestination?.chat ?? null;
      setChoice((value) => value ?? chosen);
      setName((value) => value || settings.reportTelegram?.name || settings.reportNameSuggestion || "");
    });
    return () => { cancelled = true; };
  }, [project]);

  if (!project) return <p data-onboarding-telegram="no-project" className="text-body text-secondary">{t("onboarding.telegram.noProject")}</p>;

  const status = bot.status;
  const connected = status?.connected === true;
  const members = status?.chats.filter((chat) => chat.member) ?? [];
  const postable = members.filter((chat) => chat.postable && chat.alias);
  const notYet = members.filter((chat) => !(chat.postable && chat.alias));
  const chatChosen = choice !== null && choice !== LOG_ONLY;
  const nameMissing = chatChosen && name.trim() === "";
  const canSave = choice !== null && !nameMissing && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setFailed(false);
    const outcome: TelegramReportsOutcome = chatChosen ? { chat: choice!, name: name.trim() } : null;
    try {
      const response = await fetch("/api/projects/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: project.project, reportTelegram: outcome }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setSettings(settingsOf(await response.json().catch(() => ({})) as Partial<ProjectReportSettings>));
      setSaved(outcome);
      onSaved(outcome);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const inUse = settings ? inUseChoice(settings) : null;
  const onlyAllowedChat = settings?.reportDestination?.source === "only-allowed-chat";
  const asking = settings !== null && settings.reportTelegram === null && settings.reportDestination === null && settings.postableChats > 1;

  const radio = (value: string, label: string, detail: string | null) => {
    const on = choice === value;
    const used = inUse === value;
    return (
      <button
        key={value}
        type="button"
        role="radio"
        aria-checked={on}
        data-onboarding-report-chat={value === LOG_ONLY ? "log-only" : value}
        onClick={() => { setChoice(value); setSaved(undefined); }}
        className={`flex w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:py-3 ${on ? "border-accent/50 bg-accent-soft/50" : "border-border bg-card hover:bg-sunken"}`}
      >
        <span aria-hidden className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 ${on ? "border-accent" : "border-strong"}`}>
          {on ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-semibold text-primary">{label}</span>
          {detail ? <span className="truncate font-mono text-[11px] text-muted">{detail}</span> : null}
          {used ? (
            <span data-onboarding-report-in-use={onlyAllowedChat && value !== LOG_ONLY ? "only-allowed-chat" : "chosen"} className="text-caption font-semibold leading-snug text-accent">
              {onlyAllowedChat && value !== LOG_ONLY ? t("onboarding.telegram.inUseOnly") : t("onboarding.telegram.inUse")}
            </span>
          ) : null}
        </span>
      </button>
    );
  };

  const action = "inline-flex h-8 items-center justify-center rounded-[8px] px-4 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45 max-sm:h-11 max-sm:flex-1";

  return (
    <div data-onboarding-telegram="" className="flex flex-col gap-4">
      {bot.failure ? (
        <p role="alert" className="rounded-[6px] bg-danger-soft px-2 py-1 text-ui font-semibold leading-snug text-danger">
          {t(ERROR_KEYS[bot.failure.code] ?? "telegram.actionFailed")}
        </p>
      ) : null}

      {!connected ? (
        <div className="flex max-w-[420px] flex-col gap-2">
          <p className="text-body leading-[1.45] text-secondary">{t("onboarding.telegram.connectLead")}</p>
          <TokenForm busy={bot.busy} onConnect={(token) => void bot.connect(token)} />
        </div>
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-2 text-ui font-semibold text-secondary">
            <Send className="h-4 w-4 shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 truncate">{t("onboarding.telegram.bot", { name: status?.bot?.name ?? "" })}</span>
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-label font-semibold uppercase tracking-[0.06em] text-muted">{t("onboarding.telegram.choose")}</div>
            {asking ? <p data-onboarding-report-asking="" className="text-ui leading-snug text-secondary">{t("onboarding.telegram.pickOne")}</p> : null}
            <div role="radiogroup" aria-label={t("onboarding.telegram.choose")} className="flex flex-col gap-2">
              {postable.map((chat) => radio(chat.alias!, chat.title, chat.alias))}
              {radio(LOG_ONLY, t("onboarding.telegram.logOnly"), null)}
            </div>
          </div>
          {members.length === 0 ? <p className="text-ui text-muted">{t("onboarding.telegram.noChats")}</p> : null}
          {notYet.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <div className="text-label font-semibold uppercase tracking-[0.06em] text-muted">{t("onboarding.telegram.allowMore")}</div>
              <ul className="flex max-w-[480px] flex-col gap-1">
                {notYet.map((chat) => (
                  <ChatRow key={chat.chatId} chat={chat} botSeesAll={status?.bot?.canReadAllGroupMessages === true} busy={bot.busy} onSave={(chatId, alias, postAllowed) => void bot.setChat(chatId, alias, postAllowed)} />
                ))}
              </ul>
            </div>
          ) : null}
          <label className="flex max-w-[420px] flex-col gap-1">
            <span className="text-label font-semibold uppercase tracking-[0.06em] text-muted">{t("onboarding.telegram.name")}</span>
            <input
              type="text"
              value={name}
              maxLength={60}
              autoComplete="off"
              data-onboarding-report-name=""
              aria-invalid={nameMissing}
              onChange={(event) => { setName(event.target.value); setSaved(undefined); }}
              className={`h-11 rounded-[8px] border bg-canvas px-2.5 text-body outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-9 ${nameMissing ? "border-danger" : "border-border"}`}
            />
            {chatChosen ? <span className={`text-caption leading-snug ${nameMissing ? "text-danger" : "text-muted"}`}>{t("onboarding.telegram.nameHint")}</span> : null}
          </label>
        </>
      )}

      <p className="max-w-[520px] text-ui leading-[1.45] text-secondary">{t("onboarding.telegram.rule")}</p>

      {failed ? <p role="alert" className="text-ui font-semibold text-danger">{t("onboarding.telegram.failed")}</p> : null}
      {saved !== undefined ? (
        <p role="status" data-onboarding-report-saved="" className="text-ui font-semibold text-success">
          {saved ? t("onboarding.telegram.savedChat", { chat: saved.chat }) : t("onboarding.telegram.savedLog")}
        </p>
      ) : null}

      <div className="flex gap-2">
        {/* With no bot there is nothing to choose yet: connecting is the step's
            action, and Skip leaves reports in the log. */}
        {connected ? (
          <button type="button" data-onboarding-telegram-save="" disabled={!canSave} onClick={() => void save()} className={`${action} bg-brand text-on-brand hover:opacity-90`}>
            {t("onboarding.telegram.save")}
          </button>
        ) : null}
        <button type="button" data-onboarding-telegram-skip="" onClick={onSkip} className={`${action} border border-border bg-card text-primary hover:bg-sunken`}>
          {t("onboarding.telegram.skip")}
        </button>
      </div>
    </div>
  );
}
