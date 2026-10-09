"use client";

import { useLocale } from "@/lib/i18n";
import type { BoardTask } from "@/lib/tasks/types";
import type { TaskMotion } from "@/lib/tasks/motion";
import { fmtAgeSeconds } from "@/components/utils";

/** The reason stays above the collapsed contents. A needs-you question has
    its own slot immediately below this line in the sibling card design. */
export function TaskMotionLine({ motion, working, nowMs, plain = false, full = false, taskTitle, onOpenTask, referenceUrl, finding }: { finding?: BoardTask["finding"]; motion: TaskMotion; working: number; nowMs: number; plain?: boolean; full?: boolean; taskTitle?: string; onOpenTask?: () => void; referenceUrl?: string | null }) {
  const { t, locale } = useLocale();
  const recurred = finding && finding.count > 1 ? finding : null;
  const quiet = motion.key === "not-started" || motion.key === "done";
  if (quiet && !recurred) return null;
  const hold = typeof motion.reason === "object" ? motion.reason : null;
  const date = hold?.until ? new Date(hold.until).toLocaleString(locale === "uk" ? "uk-UA" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const label = motion.key === "not-started" || motion.key === "done" ? "" : hold ? t(`kanban.hold.${hold.kind}`, { note: hold.note, ref: taskTitle ?? hold.ref?.match(/\/(?:pull|issues)\/(\d+)/)?.[1] ?? hold.ref ?? "?", date })
    : motion.reason === "paused" ? t("kanban.motion.paused")
      : motion.key === "working" && working ? t("kanban.motion.workingN", { count: working }) : t(`kanban.motion.${motion.key}`);
  const note = hold && !["operator", "external", "postponed", "unstated"].includes(hold.kind) ? hold.note : "";
  const refUrl = referenceUrl ?? (hold?.ref && /^https?:\/\//i.test(hold.ref) ? hold.ref : null);
  const age = !quiet && motion.since ? fmtAgeSeconds(Math.max(0, (nowMs - Date.parse(motion.since)) / 1000)) : "";
  const lastSeen = recurred ? new Date(recurred.lastSeenAt).toLocaleString(locale === "uk" ? "uk-UA" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  const recurrence = recurred ? `${t("kanban.finding.count", { count: recurred.count })} · ${t("kanban.finding.lastSeen")} ${lastSeen}` : "";
  const fullText = [recurrence, label, note, motion.due ? t("kanban.motion.due") : "", age, motion.holdStillSet ? t("kanban.motion.holdStillSet") : ""].filter(Boolean).join(" · ");
  const content = <>
    {recurred ? <span data-finding-recurrence="">{t("kanban.finding.count", { count: recurred.count })} · {t("kanban.finding.lastSeen")} <time dateTime={recurred.lastSeenAt} title={recurred.lastSeenAt}>{lastSeen}</time></span> : null}
    {!quiet ? <span>{recurred ? " · " : ""}{label}</span> : null}
    {note ? <span> · {note}</span> : null}
    {motion.due ? <span> · {t("kanban.motion.due")}</span> : null}
    {age ? <span className="motion-age"> · {age}</span> : null}
    {motion.holdStillSet ? <span className="motion-age"> · {t("kanban.motion.holdStillSet")}</span> : null}
  </>;
  return <span className="motion-line block text-label leading-snug text-muted [overflow-wrap:anywhere]" data-motion={motion.key} data-motion-full={full || undefined} title={hold ? `${fullText}\n${t(`kanban.hold.by.${hold.by}`)}` : undefined}>
    {!plain && onOpenTask ? <button type="button" onClick={onOpenTask}>{content}</button> : !plain && refUrl ? <a href={refUrl} target="_blank" rel="noreferrer">{content}</a> : content}
  </span>;
}
