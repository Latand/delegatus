"use client";

import { useCallback, useEffect, useState } from "react";

import type { TelegramBotState } from "@/hooks/useTelegramBot";
import { useLocale } from "@/lib/i18n";
import type { ProjectReportLine } from "@/lib/projects/reportDestination";

import { BlockRow, ChoiceRow, RefusalLine, RowButton, RowField, SectionHead, TextRow } from "./settings/settingsRows";

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
/* Not a destination: the choice that opens the field for a pasted link. */
const BY_LINK = "\u0000by-link";

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
    <div data-telegram-project-reports="" role="group" aria-label={t("telegram.bot.projectsTitle")}>
      <SectionHead title={t("telegram.bot.projectsTitle")} />
      <TextRow tone="muted">{lines.length ? t("telegram.bot.projectsHint") : t("telegram.bot.projectsNone")}</TextRow>
      {/* One select moves a project into a group that may be public, so the
          seat section's warning stands over the lines here too. */}
      {lines.length ? <TextRow tone="warning" attrs={{ "data-telegram-project-reports-warning": "" }}>{t("onboarding.telegram.rule")}</TextRow> : null}
      {lines.map((line) => <ProjectLine key={line.project} line={line} postable={postable} onSaved={async () => { await load(); await bot.refresh(); }} />)}
    </div>
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
  const [link, setLink] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const value = picked ?? stored;
  /* A chosen chat agents may not post in now stays listed, so the line still
     says where the project reports. */
  const refused = stored !== LOG_ONLY && !postable.some((chat) => chat.alias === stored) ? stored : null;
  const needsName = picked !== null && picked !== LOG_ONLY && !line.reportName;

  /* A listed chat or «Log only» is stored without a Telegram request: the
     select shows it at once and stays usable, and a refusal shows the stored
     one again beside the reason (audit B30, B42). A pasted link waits. */
  const write = async (chat: string, reportName: string | null, pastedLink?: string): Promise<boolean> => {
    if (pastedLink) setSaving(true);
    setFailed(null);
    try {
      const response = await fetch("/api/projects/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: line.project, reportTelegram: pastedLink ? { link: pastedLink, name: reportName } : chat === LOG_ONLY ? null : { chat, name: reportName } }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { message?: unknown };
        throw new Error(pastedLink && typeof body.message === "string" ? body.message : "");
      }
      setName("");
      setLink("");
      await onSaved();
      setPicked(null);
      return true;
    } catch (error) {
      if (!pastedLink) setPicked(null);
      setFailed(error instanceof Error ? error.message : "");
      return false;
    } finally {
      if (pastedLink) setSaving(false);
    }
  };

  const [byLink, setByLink] = useState(false);
  const choose = (next: string) => {
    setFailed(null);
    if (next === BY_LINK) { setByLink(true); setPicked(null); return; }
    setByLink(false);
    if (next === stored) { setPicked(null); return; }
    setPicked(next);
    if (next === LOG_ONLY || line.reportName) void write(next, line.reportName);
  };
  const topic = line.reportTelegram?.chat && line.reportTelegram.topicId ? ` · ${t("telegram.reportTopic", { id: line.reportTelegram.topicId })}` : "";

  return (
    <div data-telegram-project-report={line.project}>
      <ChoiceRow
        label={line.label}
        value={byLink ? BY_LINK : value}
        disabled={saving}
        onChange={choose}
        selectAttrs={{ "data-telegram-project-report-select": "" }}
        ariaLabel={t("telegram.bot.projectSelectAria", { project: line.label })}
        options={[
          { value: LOG_ONLY, label: t("telegram.bot.projectLogOnly") },
          ...(refused ? [{ value: refused, label: `${refused}${topic}`, disabled: true }] : []),
          ...postable.map((chat) => ({ value: chat.alias!, label: `${chat.title}${stored === chat.alias ? topic : ""}` })),
          { value: BY_LINK, label: t("settings.telegram.reportByLink") },
        ]}
      />
      {byLink ? (
        <BlockRow>
          <form className="flex min-w-0 flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); if (link.trim() && (line.reportName || name.trim())) void write(stored, (name.trim() || line.reportName), link.trim()).then((done) => { if (done) setByLink(false); }); }}>
            <span className="min-w-0 flex-1 basis-[180px]"><RowField type="text" value={link} onChange={(event) => setLink(event.target.value)} aria-label={t("telegram.reportLink")} placeholder={t("telegram.reportLink")} /></span>
            {link.trim() && !line.reportName ? <span className="min-w-0 flex-1 basis-[120px]"><RowField type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder={t("onboarding.telegram.name")}
              aria-label={t("telegram.bot.projectNameAria", { project: line.label })} maxLength={60} /></span> : null}
            <RowButton type="submit" disabled={saving || !link.trim() || !(line.reportName || name.trim())} className="shrink-0">{t("telegram.bot.projectSave")}</RowButton>
          </form>
        </BlockRow>
      ) : null}
      {needsName ? (
        <BlockRow>
          <form
            className="flex min-w-0 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (picked && name.trim()) void write(picked, name.trim());
            }}
          >
            <span className="min-w-0 flex-1">
              <RowField
                type="text"
                value={name}
                maxLength={60}
                autoComplete="off"
                aria-label={t("telegram.bot.projectNameAria", { project: line.label })}
                placeholder={t("onboarding.telegram.name")}
                onChange={(event) => setName(event.target.value)}
              />
            </span>
            <RowButton type="submit" disabled={saving || name.trim() === ""} className="shrink-0">{t("telegram.bot.projectSave")}</RowButton>
          </form>
        </BlockRow>
      ) : null}
      {needsName ? <TextRow tone="muted">{t("onboarding.telegram.nameHint")}</TextRow> : null}
      {failed !== null ? <RefusalLine>{failed || t("telegram.bot.projectFailed")}</RefusalLine> : null}
    </div>
  );
}
