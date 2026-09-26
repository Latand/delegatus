"use client";

import { Monitor, Smartphone, Tablet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useLocale, type MessageKey } from "@/lib/i18n";
import type { TeamView } from "@/lib/team/contract";

import { MemberAvatar } from "./MemberAvatar";
import { surfaceName } from "./MembersTab";
import { BUTTON, relativeTime, teamRequest } from "./ui";

/*
 * Sessions (sign-in-and-team §6.9): a member's own devices, and every
 * member's for the owner, grouped by member. Only this device's row says
 * "Sign out"; every other row says "End session", so ending someone else's
 * browser never reads as signing yourself out. "Sign out everywhere else"
 * ends every other session of the caller.
 */

interface SessionRow {
  id: string;
  memberId: string;
  surface: string;
  browser: string;
  method: string;
  createdAt: string;
  lastSeenAt: string;
  online: boolean;
  current: boolean;
}

function SurfaceIcon({ surface }: { surface: string }) {
  const Icon = surface === "phone" ? Smartphone : surface === "tablet" ? Tablet : Monitor;
  return <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />;
}

export function SessionsTab({ view }: { view: TeamView }) {
  const { t, locale } = useLocale();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const load = useCallback(async () => {
    const answer = await teamRequest<{ sessions: SessionRow[] }>("/api/team/sessions");
    if (answer.ok) setSessions(answer.body.sessions);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const signOut = async (session: SessionRow) => {
    if (session.current) {
      await teamRequest("/api/team/session/sign-out", { body: {} });
      window.location.replace("/sign-in");
      return;
    }
    await teamRequest("/api/team/sessions", { method: "DELETE", body: { id: session.id } });
    await load();
  };
  const signOutElsewhere = async () => {
    await teamRequest("/api/team/sessions", { method: "DELETE", body: { all: true } });
    await load();
  };

  const groups = useMemo(() => {
    const byMember = new Map<string, SessionRow[]>();
    for (const session of sessions ?? []) byMember.set(session.memberId, [...(byMember.get(session.memberId) ?? []), session]);
    const order = [view.me?.id, ...view.members.map((member) => member.id)].filter((id): id is string => Boolean(id));
    return [...new Set(order)].flatMap((id) => {
      const rows = byMember.get(id);
      const member = view.members.find((entry) => entry.id === id);
      return rows && member ? [{ member, rows }] : [];
    });
  }, [sessions, view]);

  const others = (sessions ?? []).filter((session) => session.memberId === view.me?.id && !session.current).length;
  return (
    <div className="flex flex-col gap-4" data-team-sessions={sessions ? sessions.length : "loading"}>
      {others ? (
        <div className="flex justify-end">
          <button type="button" className={BUTTON.small} onClick={() => void signOutElsewhere()} data-team-sign-out-all="">{t("team.sessions.signOutAll")}</button>
        </div>
      ) : null}
      {!sessions ? <div className="py-10 text-center text-ui text-muted">{t("common.loadingCap")}</div> : null}
      {groups.map(({ member, rows }) => (
        <section key={member.id} aria-label={member.name}>
          <h2 className="mb-1.5 flex items-center gap-2 px-1 text-label font-semibold text-secondary">
            <MemberAvatar name={member.name} initials={member.initials} color={member.color} size={16} />
            {member.name}
          </h2>
          <ul className="overflow-hidden rounded-surface border border-border bg-card">
            {rows.map((session) => (
              <li key={session.id} data-team-session={session.current ? "current" : "other"} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 max-sm:px-3">
                <SurfaceIcon surface={session.surface} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-ui font-semibold text-primary">
                    {t(`team.browser.${["chrome", "safari", "firefox", "edge"].includes(session.browser) ? session.browser : "other"}` as MessageKey)} · {surfaceName(t, session.surface)}
                    {session.current ? <span className="ml-2 rounded-full bg-accent-soft px-1.5 py-px text-caption font-semibold text-accent">{t("team.sessions.thisDevice")}</span> : null}
                  </p>
                  <p className="text-label text-muted">
                    {session.online ? <span className="text-success">{t("team.sessions.active")}</span> : t("team.sessions.lastSeen", { age: relativeTime(session.lastSeenAt, locale) })}
                    {" · "}
                    {t(`team.via.${session.method}` as MessageKey)}
                  </p>
                </div>
                <button type="button" className={BUTTON.text} onClick={() => void signOut(session)} data-team-session-end="">
                  {t(session.current ? "team.sessions.signOut" : "team.sessions.end")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
