"use client";

import { LogIn } from "lucide-react";
import { useEffect, useState } from "react";

import { Z } from "@/components/layers";
import { useLocale } from "@/lib/i18n";

import { useSignInRequired } from "./teamClient";
import { BUTTON } from "./ui";

/**
 * "Sign in to continue" (sign-in-and-team §4.4). Mounted once for the whole
 * app: when any request answers 401 member_required — the session was revoked,
 * expired, or signed out on another tab — the page is covered by one panel
 * whose button goes to /sign-in and brings the person back here. Nothing is
 * retried behind it; the composer keeps an unsent draft as the "not sent" row
 * it already shows.
 */
export function TeamSessionGuard() {
  const required = useSignInRequired();
  const { t } = useLocale();
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    setPath(window.location.pathname);
  }, []);
  if (!required || path === null || path.startsWith("/sign-in") || path.startsWith("/join/")) return null;
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return (
    <div className={`fixed inset-0 ${Z.overlay} flex items-center justify-center bg-canvas/80 p-4 backdrop-blur-[2px]`} data-team-sign-in-required="">
      <div role="alertdialog" aria-modal="true" aria-labelledby="team-sign-in-required" className="w-full max-w-[360px] rounded-surface border border-border bg-card px-6 py-6 text-center shadow-2">
        <h2 id="team-sign-in-required" className="text-title font-bold text-primary">{t("team.signIn.required")}</h2>
        <p className="mt-1.5 text-balance text-ui leading-relaxed text-secondary">{t("team.signIn.requiredBody")}</p>
        <a href={`/sign-in?next=${encodeURIComponent(next)}`} className={`${BUTTON.primary} mt-5 w-full`} data-team-sign-in-again="">
          <LogIn className="h-4 w-4" aria-hidden />{t("team.signIn.again")}
        </a>
      </div>
    </div>
  );
}
