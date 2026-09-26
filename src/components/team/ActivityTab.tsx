"use client";

import { Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { isOpaqueProjectKey, projectDisplayName } from "@/lib/displayNames";
import { useLocale, type MessageKey, type TFunction } from "@/lib/i18n";
import type { MemberSummary, TeamEvent, TeamView } from "@/lib/team/contract";

import { MemberAvatar } from "./MemberAvatar";
import { surfaceName } from "./MembersTab";
import { clockTime, dayHeading, teamRequest } from "./ui";

/*
 * Who did what (sign-in-and-team §6.8): one row per audit record — the person,
 * a verb phrase from a closed map, the subject (a task's first line, an
 * agent's role and title) and the time. No message text ever reaches this
 * page; the audit does not hold any. A row about a conversation or a task
 * opens it.
 */

interface EventsAnswer {
  events: TeamEvent[];
  members: MemberSummary[];
  projects: string[];
  projectNames?: Record<string, string>;
  nextBefore: string | null;
}

const STATUS_KEYS = new Set(["inbox", "assigned", "blocked", "done"]);

function phrase(t: TFunction, event: TeamEvent, members: Map<string, MemberSummary>): string {
  const detail = event.detail ?? {};
  switch (event.action) {
    case "agent.started":
      return typeof detail.role === "string" && detail.role ? t("team.action.agentStartedRole", { role: detail.role }) : t("team.action.agentStarted");
    case "task.changed": {
      const to = typeof detail.to === "string" ? detail.to : null;
      if (to && STATUS_KEYS.has(to)) return t("team.action.taskMoved", { to: t(`kanban.status.${to}` as MessageKey) });
      return t("team.action.taskChanged");
    }
    case "member.revoked":
    case "member.restored":
    case "member.renamed":
    case "join.approved": {
      const name = event.subject?.id ? members.get(event.subject.id)?.name ?? event.subject.title ?? "" : "";
      return t(`team.action.${event.action}` as MessageKey, { name });
    }
    case "session.signed_in":
      return t("team.action.signedIn", { method: t(`team.method.${typeof detail.method === "string" ? detail.method : "invite"}` as MessageKey), surface: surfaceName(t, typeof detail.surface === "string" ? detail.surface : null) });
    case "session.revoked":
    case "session.signed_out":
    case "device.approved":
      return t(`team.action.${event.action}` as MessageKey, { surface: surfaceName(t, typeof detail.surface === "string" ? detail.surface : null) });
    case "join.requested":
      return t("team.action.join.requested", { name: event.subject?.title ?? "Telegram" });
    default:
      return t(`team.action.${event.action}` as MessageKey);
  }
}

function subjectText(event: TeamEvent, t: TFunction): string | null {
  if (!event.subject || event.subject.kind === "member" || event.subject.kind === "session" || event.subject.kind === "passkey") return null;
  const role = typeof event.detail?.role === "string" && event.action !== "agent.started" ? event.detail.role : null;
  const title = event.subject.title ?? (event.subject.kind === "task" ? t("team.activity.untitledTask") : t("team.activity.untitledAgent"));
  return role ? `${role} · ${title}` : title;
}

function subjectHref(event: TeamEvent): string | null {
  if (event.subject?.kind === "conversation") return `/#c=${encodeURIComponent(event.subject.id)}`;
  if (event.subject?.kind === "task" && event.project) return `/#p=${encodeURIComponent(event.project)}`;
  return null;
}

function projectName(project: string, t: TFunction, names?: Record<string, string>): string {
  if (names?.[project]) return names[project]!;
  return isOpaqueProjectKey(project) ? t("activity.unnamedProject") : projectDisplayName(project);
}

export function ActivityTab({ view }: { view: TeamView }) {
  const { t, locale } = useLocale();
  const [member, setMember] = useState("");
  const [project, setProject] = useState("");
  const [scope, setScope] = useState<"work" | "all">("work");
  const [data, setData] = useState<EventsAnswer | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (before: string | null) => {
    const params = new URLSearchParams();
    if (member) params.set("member", member);
    if (project) params.set("project", project);
    params.set("scope", scope);
    if (before) params.set("before", before);
    const answer = await teamRequest<EventsAnswer>(`/api/team/events?${params}`);
    if (!answer.ok) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setData((current) => (before && current ? { ...answer.body, events: [...current.events, ...answer.body.events] } : answer.body));
  }, [member, project, scope]);

  useEffect(() => {
    void load(null);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(null); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const members = useMemo(() => new Map((data?.members ?? view.members).map((entry) => [entry.id, entry])), [data, view.members]);
  const groups = useMemo(() => {
    const result: Array<{ heading: string; events: TeamEvent[] }> = [];
    for (const event of data?.events ?? []) {
      const heading = dayHeading(event.at, locale, t("team.activity.today"), t("team.activity.yesterday"));
      const last = result.at(-1);
      if (last?.heading === heading) last.events.push(event);
      else result.push({ heading, events: [event] });
    }
    return result;
  }, [data, locale, t]);

  const select = "h-8 min-w-0 rounded-control border border-border bg-card px-2 text-ui font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:flex-1";
  return (
    <div className="flex flex-col gap-3" data-team-activity={data ? data.events.length : "loading"}>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={t("team.activity.what")} className={select} value={scope} onChange={(event) => setScope(event.target.value === "all" ? "all" : "work")} data-team-activity-scope="">
          <option value="work">{t("team.activity.work")}</option>
          <option value="all">{t("team.activity.all")}</option>
        </select>
        <select aria-label={t("team.activity.who")} className={select} value={member} onChange={(event) => setMember(event.target.value)} data-team-activity-member="">
          <option value="">{t("team.activity.everyone")}</option>
          {view.members.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
        <select aria-label={t("team.activity.where")} className={select} value={project} onChange={(event) => setProject(event.target.value)} data-team-activity-project="">
          <option value="">{t("team.activity.allProjects")}</option>
          {(data?.projects ?? []).map((entry) => <option key={entry} value={entry}>{projectName(entry, t, data?.projectNames)}</option>)}
        </select>
      </div>

      {failed && !data ? <div role="alert" className="rounded-surface border border-border bg-warning-soft px-4 py-3 text-ui text-warning">{t("team.activity.failed")}</div> : null}
      {!data && !failed ? <div className="py-10 text-center text-ui text-muted">{t("common.loadingCap")}</div> : null}
      {data && !data.events.length ? <p className="rounded-surface border border-border bg-card px-4 py-8 text-center text-ui text-muted" data-team-activity-empty="">{t("team.activity.empty")}</p> : null}

      {groups.map((group) => (
        <section key={group.heading} aria-label={group.heading}>
          <h2 className="mb-1.5 px-1 text-label font-semibold text-secondary">{group.heading}</h2>
          <ul className="overflow-hidden rounded-surface border border-border bg-card">
            {group.events.map((event) => {
              const actor = event.actor.kind === "member" ? members.get(event.actor.memberId) ?? null : null;
              const subject = subjectText(event, t);
              const href = subjectHref(event);
              const where = event.project ? projectName(event.project, t, data?.projectNames) : null;
              const content = (
                <>
                  {actor ? (
                    <MemberAvatar name={actor.name} initials={actor.initials} color={actor.color} size={24} />
                  ) : (
                    <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sunken text-muted"><Send className="h-3 w-3" /></span>
                  )}
                  <div className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-2">
                    <p className="min-w-0 truncate text-ui text-primary">
                      <span className="font-semibold">{actor?.name ?? t("team.activity.delegatus")}</span>{" "}
                      <span className="text-secondary">{phrase(t, event, members)}</span>
                    </p>
                    {subject || where ? (
                      <p className="min-w-0 truncate text-label text-muted sm:ml-auto sm:max-w-[45%] sm:text-right">
                        {[subject, where].filter(Boolean).join(" · ")}
                      </p>
                    ) : null}
                  </div>
                  <time dateTime={event.at} className="shrink-0 text-label tabular-nums text-muted">{clockTime(event.at, locale)}</time>
                </>
              );
              const row = "flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 max-sm:px-3 max-sm:py-3";
              return (
                <li key={event.id} data-team-event={event.action}>
                  {href ? (
                    <a href={href} className={`${row} hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40`}>{content}</a>
                  ) : (
                    <div className={row}>{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {data?.nextBefore ? (
        <button
          type="button"
          disabled={loadingMore}
          className="self-center rounded-control px-3 py-1.5 text-ui font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-11"
          onClick={() => { setLoadingMore(true); void load(data.nextBefore).finally(() => setLoadingMore(false)); }}
        >
          {t("team.activity.loadMore")}
        </button>
      ) : null}
    </div>
  );
}
