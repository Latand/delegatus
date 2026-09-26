"use client";

import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";

import { useLocale } from "@/lib/i18n";
import type { TeamPublicInfo } from "@/lib/team/contract";

import { AuthError, AuthShell, AuthTitle } from "./AuthShell";
import { errorText, goNext } from "./SignInCard";
import { BUTTON, Field, INPUT, teamRequest } from "./ui";

/*
 * `/join/<code>` (sign-in-and-team §6.4): one page for the three links a
 * person can be handed — an invite from the owner, the phone hand-off QR, and
 * the host's recovery link. After joining through an invite on a host that can
 * keep a passkey, it offers one, once, with "Not now" beside it.
 */

type Preview =
  | { valid: false }
  | { valid: true; kind: "invite"; inviterName: string | null; invitedName: string | null }
  | { valid: true; kind: "handoff"; memberName: string }
  | { valid: true; kind: "recovery"; ownerName: string | null };

type Screen =
  | { kind: "loading" }
  | { kind: "form"; preview: Preview }
  | { kind: "passkey"; name: string }
  | { kind: "done"; name: string };

export function JoinCard({ code }: { code: string }) {
  const { t } = useLocale();
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeyHere, setPasskeyHere] = useState(false);

  useEffect(() => {
    void Promise.all([
      teamRequest<Preview>(`/api/team/join/${encodeURIComponent(code)}`),
      teamRequest<TeamPublicInfo>("/api/team/public"),
    ]).then(([preview, info]) => {
      const answer: Preview = preview.ok ? preview.body : { valid: false };
      if (answer.valid && answer.kind === "invite" && answer.invitedName) setName(answer.invitedName);
      setPasskeyHere(Boolean(info.ok && info.body.methods.passkey.available && typeof window.PublicKeyCredential === "function"));
      setScreen({ kind: "form", preview: answer });
    });
  }, [code]);

  const needsName = screen.kind === "form" && screen.preview.valid
    && (screen.preview.kind === "invite" || (screen.preview.kind === "recovery" && !screen.preview.ownerName));

  const join = async () => {
    if (screen.kind !== "form" || !screen.preview.valid) return;
    if (needsName && !name.trim()) return setError(t("team.error.nameRequired"));
    setBusy(true);
    setError(null);
    const answer = await teamRequest<{ me: { name: string } }>(`/api/team/join/${encodeURIComponent(code)}`, { body: needsName ? { name } : {} });
    setBusy(false);
    if (!answer.ok) return setError(errorText(t, answer));
    if (screen.preview.kind === "invite" && passkeyHere) setScreen({ kind: "passkey", name: answer.body.me.name });
    else {
      setScreen({ kind: "done", name: answer.body.me.name });
      window.setTimeout(() => goNext("/"), 700);
    }
  };

  const addPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await teamRequest<{ id: string; options: unknown }>("/api/team/passkeys", { body: { step: "options" } });
      if (!options.ok) return setError(errorText(t, options));
      const { startRegistration } = await import("@simplewebauthn/browser");
      let response;
      try {
        response = await startRegistration({ optionsJSON: options.body.options as never });
      } catch {
        return;
      }
      const saved = await teamRequest("/api/team/passkeys", { body: { step: "verify", id: options.body.id, response } });
      if (!saved.ok) return setError(errorText(t, saved));
      goNext("/");
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (screen.kind === "loading") {
    body = <p className="py-8 text-center text-ui text-muted">{t("common.loadingCap")}</p>;
  } else if (screen.kind === "done") {
    body = <AuthTitle title={t("team.signIn.signedInAs", { name: screen.name })} />;
  } else if (screen.kind === "passkey") {
    body = (
      <div data-join-screen="passkey">
        <AuthTitle title={t("team.signIn.signedInAs", { name: screen.name })} />
        <p className="text-balance text-center text-body font-semibold text-primary">{t("team.join.passkeyOffer")}</p>
        <p className="mt-1 text-balance text-center text-ui text-secondary">{t("team.join.passkeyWhy")}</p>
        <div className="mt-5 flex flex-col gap-2">
          <button type="button" disabled={busy} className={BUTTON.primary} onClick={() => void addPasskey()} data-join-add-passkey="">
            <KeyRound className="h-4 w-4" aria-hidden />{t("team.join.addPasskey")}
          </button>
          <button type="button" className={BUTTON.text} onClick={() => goNext("/")} data-join-not-now="">{t("team.join.notNow")}</button>
        </div>
      </div>
    );
  } else if (!screen.preview.valid) {
    body = (
      <div data-join-screen="invalid">
        <AuthTitle title={t("team.join.invalidTitle")} />
        <p className="text-balance text-center text-ui leading-relaxed text-secondary">{t("team.join.invalid")}</p>
        <a href="/sign-in" className={`${BUTTON.secondary} mt-5 w-full`} data-join-sign-in="">{t("team.join.signIn")}</a>
      </div>
    );
  } else {
    const preview = screen.preview;
    const title = preview.kind === "invite"
      ? (preview.inviterName ? t("team.join.title", { inviter: preview.inviterName }) : t("team.join.titleAnonymous"))
      : preview.kind === "handoff"
        ? t("team.join.handoffTitle", { name: preview.memberName })
        : preview.ownerName ? t("team.join.recoveryTitle", { name: preview.ownerName }) : t("team.join.recoveryOwnerTitle");
    const subtitle = preview.kind === "invite" ? t("team.join.inviteBody") : preview.kind === "handoff" ? t("team.join.handoffBody") : t("team.join.recoveryBody");
    body = (
      <form data-join-screen={preview.kind} onSubmit={(event) => { event.preventDefault(); void join(); }}>
        <AuthTitle title={title} subtitle={subtitle} />
        {needsName ? (
          <Field label={t("team.join.name")}>
            <input
              className={INPUT}
              value={name}
              maxLength={60}
              autoComplete="name"
              autoFocus
              onChange={(event) => setName(event.target.value)}
              data-join-name=""
            />
          </Field>
        ) : null}
        <button type="submit" disabled={busy} className={`${BUTTON.primary} mt-4 w-full`} data-join-submit="">
          {preview.kind === "invite" ? t("team.join.join") : t("team.join.continue")}
        </button>
      </form>
    );
  }

  return (
    <AuthShell testId="join">
      {body}
      <AuthError text={error} />
    </AuthShell>
  );
}
