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
 * always a choice, and Skip writes nothing. The operator's stored choice is
 * preselected and marked in use. A project that never chose posts to no chat,
 * however many chats the bot may post in (`effectiveReportTelegram`): the step
 * says it is not reporting to Telegram, and nothing is preselected or marked
 * in use until the operator picks. A chosen chat that agents may not post in
 * now is still where the Viewer addresses reports, so it stays in the list,
 * chosen and in use, but it cannot be picked or saved again until the
 * operator allows it or picks another.
 */

const LOG_ONLY = "\u0000log-only";

export type TelegramReportsOutcome = { chat: string; name: string } | null;

type ProjectReportSettings = {
  /** The operator's choice: a chat, "Log only" (`chat: null`), or null when never chosen. */
  reportTelegram: { chat: string | null; name?: string } | null;
  /** Where reports go now besides the log: the chosen chat, else null. */
  reportDestination: { chat: string; name: string; source: "chosen" } | null;
  reportNameSuggestion: string | null;
};

function settingsOf(body: Partial<ProjectReportSettings>): ProjectReportSettings {
  return {
    reportTelegram: body.reportTelegram ?? null,
    reportDestination: body.reportDestination ?? null,
    reportNameSuggestion: body.reportNameSuggestion ?? null,
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

/** The operator's stored choice as a radio value, null when they never chose. */
function destinationInUse(settings: ProjectReportSettings): string | null {
  const choice = settings.reportTelegram;
  return choice ? choice.chat ?? LOG_ONLY : null;
}

export function TelegramReportsStep({ project, onSaved, onSkip }: {
  project: GuideProject | null;
  /** The destination was written; null is "log only". */
  onSaved: (outcome: TelegramReportsOutcome) => void;
  onSkip: () => void;
}) {
  const { t } = useLocale();
  const bot = useTelegramBot(project !== null);
  /* What the operator clicked or typed here; until then the step shows what
     is in use now. */
  const [picked, setPicked] = useState<string | null>(null);
  const [typedName, setTypedName] = useState<string | null>(null);
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
    });
    return () => { cancelled = true; };
  }, [project]);

  if (!project) return <p data-onboarding-telegram="no-project" className="text-body text-secondary">{t("onboarding.telegram.noProject")}</p>;

  const status = bot.status;
  const connected = status?.connected === true;
  const members = status?.chats.filter((chat) => chat.member) ?? [];
  const postable = members.filter((chat) => chat.postable && chat.alias);
  const notYet = members.filter((chat) => !(chat.postable && chat.alias));
  const inUse = settings && status ? destinationInUse(settings) : null;
  /* Settings read and nothing chosen: no chat receives reports yet. */
  const notReporting = settings !== null && status !== null && inUse === null;
  /* The chosen chat when it refuses posts now: the switch was turned off, the
     alias changed, or the bot left. */
  const refused = inUse && inUse !== LOG_ONLY && !postable.some((chat) => chat.alias === inUse) ? inUse : null;
  const refusedChat = refused ? status?.chats.find((chat) => chat.alias === refused || chat.chatId === refused) ?? null : null;
  /* The step starts on the stored choice; a project that never chose starts
     on nothing, and the operator picks. A pick of a chat that no longer
     accepts posts is gone with its radio. */
  const pickedLive = picked === LOG_ONLY || postable.some((chat) => chat.alias === picked) ? picked : null;
  const choice = pickedLive ?? inUse;
  /* The name in the field is the chosen chat's, else GitHub's to suggest. */
  const name = typedName ?? (settings?.reportTelegram?.name || settings?.reportNameSuggestion || "");
  const chatChosen = choice !== null && choice !== LOG_ONLY;
  const nameMissing = chatChosen && name.trim() === "";
  const canSave = choice !== null && choice !== refused && !nameMissing && !saving;

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
      setPicked(chatChosen ? choice : LOG_ONLY);
      setSaved(outcome);
      onSaved(outcome);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const radio = (value: string, label: string, detail: string | null) => {
    const on = choice === value;
    const used = inUse === value;
    const refusing = value === refused;
    return (
      <button
        key={value}
        type="button"
        role="radio"
        aria-checked={on}
        disabled={refusing}
        data-onboarding-report-chat={value === LOG_ONLY ? "log-only" : value}
        onClick={() => { setPicked(value); setSaved(undefined); }}
        className={`flex w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed max-sm:py-3 ${on ? "border-accent/50 bg-accent-soft/50" : "border-border bg-card hover:bg-sunken"}`}
      >
        <span aria-hidden className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 ${on ? "border-accent" : "border-strong"}`}>
          {on ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-semibold text-primary">{label}</span>
          {detail ? <span className="truncate font-mono text-[11px] text-muted">{detail}</span> : null}
          {used ? (
            <span data-onboarding-report-in-use="chosen" className="text-caption font-semibold leading-snug text-accent">
              {t("onboarding.telegram.inUse")}
            </span>
          ) : null}
          {refusing ? (
            <span data-onboarding-report-refused="" className="text-caption leading-snug text-warning">{t("onboarding.telegram.refused")}</span>
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
            {notReporting ? <p data-onboarding-report-not-reporting="" className="text-ui leading-snug text-secondary">{t("onboarding.telegram.notReporting")}</p> : null}
            <div role="radiogroup" aria-label={t("onboarding.telegram.choose")} className="flex flex-col gap-2">
              {refused ? radio(refused, refusedChat?.title ?? refused, refused) : null}
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
              onChange={(event) => { setTypedName(event.target.value); setSaved(undefined); }}
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
