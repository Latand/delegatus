"use client";

import { ChevronLeft, KeyRound, Send, Smartphone } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AccessQrImage } from "@/components/AccessQrButton";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale, type TFunction } from "@/lib/i18n";
import { safeNextPath, type TeamPublicInfo } from "@/lib/team/contract";

import { AuthError, AuthShell, AuthTitle } from "./AuthShell";
import { BUTTON, Field, INPUT, teamRequest, type ApiAnswer } from "./ui";

/*
 * The sign-in page (sign-in-and-team §6.6). At most four ways in, drawn only
 * where they apply here — never a disabled button: Telegram when the install's
 * bot is connected, a passkey where this host can use one, approval from a
 * device already signed in, and the hint that an invite link opens directly.
 * The one brand-filled button is the first method that applies.
 */

type Screen =
  | { kind: "loading" }
  | { kind: "choose" }
  | { kind: "approval"; id: string; proof: string; code: string; expiresAt: string }
  | { kind: "telegram"; id: string; proof: string; url: string; expiresAt: string; state: TelegramState }
  | { kind: "done"; name: string };

export type TelegramState =
  | { state: "waiting" }
  | { state: "code_sent" }
  | { state: "confirmed"; name: string }
  | { state: "needs_approval"; firstName: string | null; ownerName: string | null }
  | { state: "linked"; name: string }
  | { state: "taken" }
  | { state: "denied" }
  | { state: "expired" };

const POLL_MS = 3_000;

export function errorText(t: TFunction, answer: Extract<ApiAnswer<unknown>, { ok: false }>): string {
  switch (answer.code) {
    case "network": return t("team.error.network");
    case "too_many_attempts": return t("team.error.tooMany");
    case "code_wrong": return t("team.approve.wrong");
    case "link_invalid": return t("team.join.invalid");
    case "passkey_unknown": return t("team.error.passkeyUnknown");
    case "passkey_rejected":
    case "passkey_expired": return t("team.error.passkeyFailed");
    case "telegram_taken": return t("team.error.telegramTaken");
    case "name_required": return t("team.error.nameRequired");
    case "name_taken": return t("team.error.nameTaken");
    default: return t("team.error.generic");
  }
}

function useCountdown(expiresAt: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return "";
  const left = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
}

/**
 * The code the bot sent to whoever pressed Start, typed back on the device
 * that asked (§5.3). Start alone grants nothing, so a forwarded link is worth
 * nothing without this. `onState` gets the request's next state, and a
 * message when the wrong codes spent it.
 */
export function TelegramCodeForm({ id, proof, onState, onError }: {
  id: string;
  proof: string;
  onState: (state: TelegramState, message?: string) => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useLocale();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    onError(null);
    const answer = await teamRequest<TelegramState>(`/api/team/session/telegram/${id}`, { body: { proof, action: "confirm", code } });
    setBusy(false);
    if (answer.ok) return onState(answer.body);
    setCode("");
    if (answer.code === "too_many_attempts") return onState({ state: "expired" }, t("team.signIn.telegramTooMany"));
    onError(errorText(t, answer));
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }} data-telegram-code-form="">
      <Field label={t("team.signIn.telegramCode")} hint={t("team.signIn.telegramCodeHint")}>
        <input
          className={`${INPUT} font-mono text-[18px] tracking-[0.2em] tabular-nums`}
          value={code}
          maxLength={7}
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          spellCheck={false}
          placeholder="123 456"
          onChange={(event) => setCode(event.target.value)}
          data-telegram-code=""
        />
      </Field>
      <button type="submit" disabled={busy || code.replace(/\D/g, "").length !== 6} className={BUTTON.primary} data-telegram-code-submit="">
        {t("team.signIn.continue")}
      </button>
    </form>
  );
}

export function goNext(next: string): void {
  window.location.replace(safeNextPath(next));
}

export function SignInCard({ next }: { next: string }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [info, setInfo] = useState<TeamPublicInfo | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [supportsPasskeys, setSupportsPasskeys] = useState(false);

  useEffect(() => {
    setSupportsPasskeys(passkeysSupported());
    void teamRequest<TeamPublicInfo>("/api/team/public").then((answer) => {
      if (!answer.ok) {
        setError(errorText(t, answer));
        setScreen({ kind: "choose" });
        return;
      }
      /* A solo install has nobody to sign in as. */
      if (answer.body.mode === "solo") {
        goNext(next);
        return;
      }
      setInfo(answer.body);
      setScreen({ kind: "choose" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page
  }, []);

  const finish = useCallback((name: string) => {
    setScreen({ kind: "done", name });
    window.setTimeout(() => goNext(next), 700);
  }, [next]);

  const startApproval = async () => {
    setBusy(true);
    setError(null);
    const answer = await teamRequest<{ id: string; proof: string; code: string; expiresAt: string }>("/api/team/session/approval", { body: {} });
    setBusy(false);
    if (!answer.ok) return setError(errorText(t, answer));
    setScreen({ kind: "approval", ...answer.body });
  };

  const startTelegram = async () => {
    setBusy(true);
    setError(null);
    const answer = await teamRequest<{ id: string; proof: string; url: string; expiresAt: string }>("/api/team/session/telegram", { body: { purpose: "sign-in" } });
    setBusy(false);
    if (!answer.ok) return setError(errorText(t, answer));
    setScreen({ kind: "telegram", ...answer.body, state: { state: "waiting" } });
    if (isMobile) window.location.href = answer.body.url;
  };

  const usePasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const options = await teamRequest<{ id: string; options: unknown }>("/api/team/session/passkey", { body: { step: "options" } });
      if (!options.ok) return setError(errorText(t, options));
      const { startAuthentication } = await import("@simplewebauthn/browser");
      let response;
      try {
        response = await startAuthentication({ optionsJSON: options.body.options as never });
      } catch {
        /* The person closed the browser's passkey sheet: nothing to say. */
        return;
      }
      const verified = await teamRequest<{ me: { name: string } }>("/api/team/session/passkey", { body: { step: "verify", id: options.body.id, response } });
      if (!verified.ok) return setError(errorText(t, verified));
      finish(verified.body.me.name);
    } finally {
      setBusy(false);
    }
  };

  /* The approval screen waits for the other device. */
  const approval = screen.kind === "approval" ? screen : null;
  useEffect(() => {
    if (!approval) return;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      const answer = await teamRequest<{ state: string; name?: string }>(`/api/team/session/approval/${approval.id}`, { body: { proof: approval.proof } });
      if (!alive) return;
      if (answer.ok && answer.body.state === "approved") {
        const done = await teamRequest<{ me: { name: string } }>(`/api/team/session/approval/${approval.id}`, { body: { proof: approval.proof, complete: true } });
        if (!alive) return;
        if (done.ok) return finish(done.body.me.name);
        setError(errorText(t, done));
        return;
      }
      if (answer.ok && (answer.body.state === "expired" || answer.body.state === "denied")) {
        setError(t(answer.body.state === "denied" ? "team.signIn.denied" : "team.signIn.expired"));
        setScreen({ kind: "choose" });
        return;
      }
      timer = window.setTimeout(poll, POLL_MS);
    };
    timer = window.setTimeout(poll, POLL_MS);
    return () => { alive = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the request id
  }, [approval?.id]);

  /* The Telegram screen waits for the bot to hear Start, then for the code
     the person types (no polling while they type), then for the owner. */
  const telegram = screen.kind === "telegram" ? screen : null;
  const telegramState = telegram?.state.state;
  const confirmTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!telegram || (telegramState !== "waiting" && telegramState !== "needs_approval")) return;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      const answer = await teamRequest<TelegramState & { state: string }>(`/api/team/session/telegram/${telegram.id}`, { body: { proof: telegram.proof } });
      if (!alive) return;
      if (answer.ok && answer.body.state !== telegramState) {
        setScreen((current) => (current.kind === "telegram" && current.id === telegram.id ? { ...current, state: answer.body } : current));
        if (answer.body.state !== "waiting" && answer.body.state !== "needs_approval") return;
      }
      timer = window.setTimeout(poll, POLL_MS);
    };
    timer = window.setTimeout(poll, POLL_MS);
    return () => { alive = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the request and its state
  }, [telegram?.id, telegramState]);

  /* Confirmed: show the name for a beat, so a person who sees someone else's
     can say so, then take the cookie. */
  useEffect(() => {
    if (!telegram || telegram.state.state !== "confirmed") return;
    confirmTimer.current = window.setTimeout(async () => {
      const done = await teamRequest<{ me: { name: string } }>(`/api/team/session/telegram/${telegram.id}`, { body: { proof: telegram.proof, action: "complete" } });
      if (done.ok) finish(done.body.me.name);
      else setError(errorText(t, done));
    }, 1_600);
    return () => window.clearTimeout(confirmTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per confirmation
  }, [telegram?.id, telegramState]);

  const notMe = async () => {
    if (!telegram) return;
    window.clearTimeout(confirmTimer.current);
    await teamRequest(`/api/team/session/telegram/${telegram.id}`, { body: { proof: telegram.proof, action: "not-me" } });
    setScreen({ kind: "choose" });
  };

  const back = () => {
    setError(null);
    setScreen({ kind: "choose" });
  };

  const countdown = useCountdown(approval?.expiresAt ?? telegram?.expiresAt ?? null);
  const hostName = info?.hostName ?? "";
  const telegramAvailable = Boolean(info?.methods.telegram.available);
  const passkeyAvailable = Boolean(info?.methods.passkey.available) && supportsPasskeys;
  const primary: "telegram" | "passkey" | "approval" = telegramAvailable ? "telegram" : passkeyAvailable ? "passkey" : "approval";

  return (
    <AuthShell testId="sign-in">
      {screen.kind === "loading" ? (
        <p className="py-8 text-center text-ui text-muted">{t("common.loadingCap")}</p>
      ) : screen.kind === "done" ? (
        <AuthTitle title={t("team.signIn.signedInAs", { name: screen.name })} subtitle={hostName} />
      ) : screen.kind === "approval" ? (
        <div data-sign-in-screen="approval">
          <AuthTitle title={t("team.signIn.approval")} subtitle={hostName} />
          <p className="select-all text-center font-mono text-[28px] font-bold tracking-[0.18em] tabular-nums text-primary" data-approval-code="">
            {screen.code}
          </p>
          <p className="mt-4 text-balance text-center text-ui leading-relaxed text-secondary">{t("team.signIn.approvalHint")}</p>
          <div className="mt-5 flex items-center justify-between">
            <span className="text-label tabular-nums text-muted" aria-live="polite">{t("team.signIn.expiresIn", { time: countdown })}</span>
            <button type="button" className={BUTTON.text} onClick={back}><ChevronLeft className="h-3.5 w-3.5" aria-hidden />{t("team.signIn.back")}</button>
          </div>
        </div>
      ) : screen.kind === "telegram" ? (
        <div data-sign-in-screen={`telegram-${screen.state.state}`}>
          <AuthTitle title={t("team.signIn.telegram")} subtitle={hostName} />
          {screen.state.state === "confirmed" ? (
            <div className="text-center">
              <p className="text-body font-semibold text-primary">{t("team.signIn.signingInAs", { name: screen.state.name })}</p>
              <button type="button" className={`${BUTTON.text} mt-3`} onClick={() => void notMe()} data-sign-in-not-me="">{t("team.signIn.notMe")}</button>
            </div>
          ) : screen.state.state === "code_sent" ? (
            <TelegramCodeForm
              id={screen.id}
              proof={screen.proof}
              onError={setError}
              onState={(state, message) => {
                setScreen((current) => (current.kind === "telegram" && current.id === screen.id ? { ...current, state } : current));
                if (message) setError(message);
              }}
            />
          ) : screen.state.state === "needs_approval" ? (
            <p className="text-balance text-center text-ui leading-relaxed text-secondary" aria-live="polite">
              {t("team.signIn.needsApproval", { owner: screen.state.ownerName ?? t("team.role.owner") })}
            </p>
          ) : screen.state.state === "waiting" ? (
            <>
              {/* Each layout says one whole sentence, and no sentence runs
                  around the button: the phone opens the app on this device,
                  the desktop offers the QR (captioned) or the app here. */}
              {isMobile ? (
                <div className="flex flex-col items-stretch gap-3">
                  <p className="text-balance text-center text-ui leading-relaxed text-secondary">{t("team.signIn.telegramPhone")}</p>
                  <a href={screen.url} target="_blank" rel="noreferrer" className={BUTTON.primary} data-sign-in-open-telegram="">
                    <Send className="h-4 w-4" aria-hidden />{t("team.signIn.openTelegram")}
                  </a>
                </div>
              ) : (
                <div className="flex items-center gap-5">
                  <figure className="flex shrink-0 flex-col items-center gap-1.5">
                    <div className="rounded-control border border-border bg-card p-1.5">
                      <AccessQrImage url={screen.url} size={132} />
                    </div>
                    <figcaption className="text-label text-muted">{t("team.signIn.telegramScan")}</figcaption>
                  </figure>
                  <div className="flex min-w-0 flex-col gap-3">
                    <p className="text-pretty text-ui leading-relaxed text-secondary">{t("team.signIn.telegramDesktop")}</p>
                    <a href={screen.url} target="_blank" rel="noreferrer" className={BUTTON.secondary} data-sign-in-open-telegram="">
                      <Send className="h-4 w-4" aria-hidden />{t("team.signIn.openTelegram")}
                    </a>
                  </div>
                </div>
              )}
              <p className="mt-4 flex items-center gap-2 text-label text-muted" aria-live="polite">
                <span className="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse" aria-hidden />
                {t("team.signIn.waiting")}
              </p>
            </>
          ) : (
            <p className="text-balance text-center text-ui text-secondary">{t(screen.state.state === "denied" ? "team.signIn.denied" : "team.signIn.expired")}</p>
          )}
          <div className="mt-5 flex justify-end">
            <button type="button" className={BUTTON.text} onClick={back}><ChevronLeft className="h-3.5 w-3.5" aria-hidden />{t("team.signIn.back")}</button>
          </div>
        </div>
      ) : (
        <div data-sign-in-screen="choose">
          <AuthTitle title={t("team.signIn.title")} subtitle={hostName} />
          <div className="flex flex-col gap-2.5">
            {telegramAvailable ? (
              <button type="button" disabled={busy} onClick={() => void startTelegram()} className={primary === "telegram" ? BUTTON.primary : BUTTON.secondary} data-sign-in-method="telegram">
                <Send className="h-4 w-4" aria-hidden />{t("team.signIn.telegram")}
              </button>
            ) : null}
            {passkeyAvailable ? (
              <button type="button" disabled={busy} onClick={() => void usePasskey()} className={primary === "passkey" ? BUTTON.primary : BUTTON.secondary} data-sign-in-method="passkey">
                <KeyRound className="h-4 w-4" aria-hidden />{t("team.signIn.passkey")}
              </button>
            ) : null}
            {telegramAvailable || passkeyAvailable ? (
              <div className="my-1.5 flex items-center gap-3 text-label text-muted" aria-hidden>
                <span className="h-px flex-1 bg-border" />{t("team.signIn.or")}<span className="h-px flex-1 bg-border" />
              </div>
            ) : null}
            <button type="button" disabled={busy} onClick={() => void startApproval()} className={primary === "approval" ? BUTTON.primary : BUTTON.secondary} data-sign-in-method="approval">
              <Smartphone className="h-4 w-4" aria-hidden />{t("team.signIn.approval")}
            </button>
          </div>
          <p className="mt-5 text-balance text-center text-label leading-snug text-muted">{t("team.signIn.inviteHint")}</p>
        </div>
      )}
      <AuthError text={error} />
    </AuthShell>
  );
}
