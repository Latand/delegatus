"use client";

import { useCallback, useEffect, useState } from "react";

import type { TelegramBotState } from "@/hooks/useTelegramBot";
import { useLocale } from "@/lib/i18n";
import type { ProjectReportLine } from "@/lib/projects/reportDestination";

/**
 * The reports overview in the bot panel (docs/design/orchestrator-reports.md
 * §5.6): every project with an orchestrator and the chat its reports also go
 * to, switchable in place. Each line writes its own project's choice through
 * the settings route, so one project's group never moves another's. Picking a
 * chat for a project with no name to post under asks for one first, as the
 * seat's Reports section does; a project that never chose reads "Log only",
 * which is what it does.
 */

const LOG_ONLY = "\u0000log-only";

async function readOverview(): Promise<ProjectReportLine[] | null> {
  try {
    const response = await fetch("/api/projects/reports", { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json() as { projects?: ProjectReportLine[] };
    return Array.isArray(body.projects) ? body.projects : null;
  } catch {
    return null;
  }
}

export function ProjectReportsOverview({ bot }: { bot: TelegramBotState }) {
  const { t } = useLocale();
  const [lines, setLines] = useState<ProjectReportLine[] | null>(null);
  const load = useCallback(async () => {
    const read = await readOverview();
    if (read) setLines(read);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void readOverview().then((read) => { if (!cancelled && read) setLines(read); });
    return () => { cancelled = true; };
  }, []);

  if (lines === null) return null;
  const postable = bot.status?.chats.filter((chat) => chat.member && chat.postable && chat.alias) ?? [];
  return (
    <section data-telegram-project-reports="" aria-label={t("telegram.bot.projectsTitle")} className="flex flex-col gap-1.5">
      <h4 className="text-[10.5px] font-bold uppercase tracking-wide text-muted">{t("telegram.bot.projectsTitle")}</h4>
      <p className="text-[10.5px] leading-snug text-muted">{lines.length ? t("telegram.bot.projectsHint") : t("telegram.bot.projectsNone")}</p>
      {/* One select moves a project into a group that may be public, so the
          seat section's warning stands over the lines here too. */}
      {lines.length ? <p data-telegram-project-reports-warning="" className="text-[10.5px] leading-snug text-warning">{t("onboarding.telegram.rule")}</p> : null}
      {lines.length ? (
        <ul className="flex flex-col gap-1">
          {lines.map((line) => <ProjectLine key={line.project} line={line} postable={postable} onSaved={async () => { await load(); await bot.refresh(); }} />)}
        </ul>
      ) : null}
    </section>
  );
}

function ProjectLine({ line, postable, onSaved }: {
  line: ProjectReportLine;
  postable: { alias: string | null; title: string }[];
  onSaved: () => Promise<void>;
}) {
  const { t } = useLocale();
  const stored = line.reportTelegram?.chat ?? LOG_ONLY;
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const value = picked ?? stored;
  /* A chosen chat agents may not post in now stays listed, so the line still
     says where the project reports. */
  const refused = stored !== LOG_ONLY && !postable.some((chat) => chat.alias === stored) ? stored : null;
  const needsName = picked !== null && picked !== LOG_ONLY && !line.reportName;

  const write = async (chat: string, reportName: string | null) => {
    setSaving(true);
    setFailed(false);
    try {
      const response = await fetch("/api/projects/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: line.project, reportTelegram: chat === LOG_ONLY ? null : { chat, name: reportName } }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setPicked(null);
      setName("");
      await onSaved();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const choose = (next: string) => {
    if (next === stored) { setPicked(null); return; }
    setPicked(next);
    if (next === LOG_ONLY || line.reportName) void write(next, line.reportName);
  };

  return (
    <li data-telegram-project-report={line.project} className="flex flex-col gap-1 rounded-[9px] border border-border px-2 py-1">
      <div className="flex min-h-[44px] min-w-0 items-center gap-2 sm:min-h-[28px]">
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-primary" title={line.label}>{line.label}</span>
        <select
          value={value}
          disabled={saving}
          data-telegram-project-report-select=""
          aria-label={t("telegram.bot.projectSelectAria", { project: line.label })}
          onChange={(event) => choose(event.target.value)}
          className="h-11 min-w-0 max-w-[55%] rounded-[8px] border border-border bg-canvas px-1.5 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
        >
          <option value={LOG_ONLY}>{t("telegram.bot.projectLogOnly")}</option>
          {refused ? <option value={refused} disabled>{refused}</option> : null}
          {postable.map((chat) => <option key={chat.alias} value={chat.alias!}>{chat.title}</option>)}
        </select>
      </div>
      {needsName ? (
        <form
          className="flex min-w-0 items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (picked && name.trim()) void write(picked, name.trim());
          }}
        >
          <input
            type="text"
            value={name}
            maxLength={60}
            autoComplete="off"
            aria-label={t("telegram.bot.projectNameAria", { project: line.label })}
            placeholder={t("onboarding.telegram.name")}
            onChange={(event) => setName(event.target.value)}
            className="h-11 min-w-0 flex-1 rounded-[8px] border border-border bg-canvas px-2 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
          />
          <button
            type="submit"
            disabled={saving || name.trim() === ""}
            className="h-11 shrink-0 rounded-[8px] border border-border bg-canvas px-2.5 text-[11px] font-semibold hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
          >
            {t("telegram.bot.projectSave")}
          </button>
        </form>
      ) : null}
      {needsName ? <p className="text-[10px] leading-snug text-muted">{t("onboarding.telegram.nameHint")}</p> : null}
      {failed ? <p role="alert" className="text-[10px] font-semibold leading-snug text-danger">{t("telegram.bot.projectFailed")}</p> : null}
    </li>
  );
}
