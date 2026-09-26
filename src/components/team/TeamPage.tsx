"use client";

import { ArrowLeft, LogOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { DelegatusBadge } from "@/components/brand/BrandMark";
import { useLocale } from "@/lib/i18n";
import type { TeamView } from "@/lib/team/contract";

import { ActivityTab } from "./ActivityTab";
import { MembersTab } from "./MembersTab";
import { SessionsTab } from "./SessionsTab";
import { refreshTeamView, useTeamView } from "./teamClient";
import { BUTTON, Field, INPUT, teamRequest } from "./ui";
import { errorText } from "./SignInCard";

/*
 * `/team` (sign-in-and-team §6.2, §6.8, §6.9). Inside the app like
 * `/activity`: the same back link and header, three tabs. On a solo install
 * it is one card that sets up a team, and nothing else.
 */

export type TeamTab = "members" | "activity" | "sessions";

export function TeamPage({ initialTab }: { initialTab: TeamTab }) {
  const { t } = useLocale();
  const view = useTeamView();
  const [tab, setTab] = useState<TeamTab>(initialTab);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [tab]);

  const signOut = useCallback(async () => {
    await teamRequest("/api/team/session/sign-out", { body: {} });
    window.location.replace("/sign-in");
  }, []);

  const team = view?.mode === "team" ? view : null;
  return (
    <div className="h-full overflow-y-auto bg-canvas" data-team-page={view ? view.mode : "loading"}>
      <div className="mx-auto flex max-w-[960px] flex-col gap-4 px-6 py-5 max-sm:px-3 max-sm:py-3">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <a
            href="/"
            data-team-back=""
            className="flex h-8 items-center gap-1.5 rounded-control border border-border bg-card px-2.5 text-ui font-semibold text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            {t("activity.back")}
          </a>
          <div className="min-w-0 flex-1">
            <h1 className="text-title font-bold text-primary">{t("team.title")}</h1>
            <p className="text-[11.5px] text-muted max-sm:hidden">{team ? t("team.subtitle") : t("team.soloSubtitle")}</p>
          </div>
          {team?.me ? (
            <button type="button" className={BUTTON.text} onClick={() => void signOut()} data-team-sign-out="" aria-label={t("team.signOut", { name: team.me.name })}>
              <LogOut className="h-3.5 w-3.5 max-sm:h-4 max-sm:w-4" aria-hidden />
              <span className="max-sm:hidden">{t("team.signOut", { name: team.me.name })}</span>
            </button>
          ) : null}
        </header>

        {!view ? (
          <div className="py-10 text-center text-ui text-muted">{t("common.loadingCap")}</div>
        ) : !team ? (
          <ClaimCard />
        ) : (
          <>
            <div role="tablist" aria-label={t("team.title")} className="flex gap-1 border-b border-border">
              {(["members", "activity", "sessions"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  data-team-tab={key}
                  onClick={() => setTab(key)}
                  className={`-mb-px min-h-9 border-b-2 px-3 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:min-h-11 max-sm:flex-1 ${tab === key ? "border-accent text-primary" : "border-transparent text-muted hover:text-primary"}`}
                >
                  {t(`team.tabs.${key}`)}
                </button>
              ))}
            </div>
            {tab === "members" ? <MembersTab view={team} /> : tab === "activity" ? <ActivityTab view={team} /> : <SessionsTab view={team} />}
          </>
        )}
      </div>
    </div>
  );
}

/** Solo mode's one card (§6.2): the person at this Delegatus becomes its
    owner, and from then on everyone else signs in. */
function ClaimCard() {
  const { t } = useLocale();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claim = async () => {
    if (!name.trim()) return setError(t("team.error.nameRequired"));
    setBusy(true);
    setError(null);
    const answer = await teamRequest("/api/team/claim", { body: { name } });
    setBusy(false);
    if (!answer.ok) return setError(errorText(t, answer));
    await refreshTeamView();
  };
  return (
    <form
      data-team-claim=""
      onSubmit={(event) => { event.preventDefault(); void claim(); }}
      className="mx-auto mt-4 w-full max-w-[440px] rounded-surface border border-border bg-card px-6 pb-6 pt-6 shadow-1 max-sm:px-4"
    >
      {/* Centred like the sign-in and join cards, so the page balances
          under the left-aligned header. */}
      <div className="flex justify-center">
        <DelegatusBadge size={48} />
      </div>
      <h2 className="mt-3 text-balance text-center text-title font-bold text-primary">{t("team.claim.title")}</h2>
      <p className="mt-1 text-balance text-center text-ui leading-relaxed text-secondary">{t("team.claim.body")}</p>
      <div className="mt-4">
        <Field label={t("team.claim.name")}>
          <input className={INPUT} value={name} maxLength={60} autoComplete="name" onChange={(event) => setName(event.target.value)} data-team-claim-name="" />
        </Field>
      </div>
      <button type="submit" disabled={busy} className={`${BUTTON.primary} mt-4 w-full`} data-team-claim-submit="">{t("team.claim.submit")}</button>
      <p className="mt-3 text-balance text-center text-label leading-snug text-muted">{t("team.claim.consequence")}</p>
      {error ? <p role="alert" className="mt-3 rounded-control bg-danger-soft px-3 py-2 text-ui text-danger">{error}</p> : null}
    </form>
  );
}

export type TeamViewTeam = TeamView & { mode: "team" };
