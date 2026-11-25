"use client";

import { Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";

import { errorText, TelegramCodeForm, type TelegramState } from "./SignInCard";
import { BUTTON, teamRequest } from "./ui";

/*
 * One Telegram step for a browser that is already open: link the signed-in
 * member's Telegram account, or sign in with it. The member dialog and the
 * file confirmation page both use it, so the two read and behave the same.
 * It opens the bot, waits for Start, takes the code the bot sent, and (for a
 * sign-in) shows the name for a beat before taking the cookie, exactly as the
 * sign-in page does (§5.3). A forwarded link finds the request and binds
 * nothing without that code.
 */

export type TelegramStepPurpose = "link" | "sign-in";
/** `not-linked`: some other Telegram account pressed Start, so no session was minted and no join request was left behind. */
export type TelegramStepOutcome = "linked" | "signed-in" | "not-linked";

type Stage = "waiting" | "code" | "confirmed";
interface Request { id: string; proof: string; url: string; stage: Stage; name?: string }

const POLL_MS = 3_000;
const CONFIRM_MS = 1_600;

export function TelegramStep({ purpose, onDone, onMessage, buttonClassName }: {
  purpose: TelegramStepPurpose;
  /** The step reached its goal; the host reads the new state. */
  onDone: (outcome: TelegramStepOutcome) => void;
  /** A refusal or expiry to show beside the step, or null to clear it. */
  onMessage: (message: string | null) => void;
  buttonClassName?: string;
}) {
  const { t } = useLocale();
  const [request, setRequest] = useState<Request | null>(null);
  const [busy, setBusy] = useState(false);
  const host = useRef({ onDone, onMessage, t });
  useEffect(() => { host.current = { onDone, onMessage, t }; });

  const end = (message?: string) => {
    setRequest(null);
    if (message) host.current.onMessage(message);
  };

  const settle = async (current: Request, state: TelegramState, message?: string) => {
    if (state.state === "waiting" || state.state === "code_sent") return;
    const text = host.current.t;
    if (message) return end(message);
    if (purpose === "link") {
      if (state.state === "linked") { end(); return host.current.onDone("linked"); }
      return end(state.state === "taken" ? text("team.error.telegramTaken") : text("team.signIn.expired"));
    }
    if (state.state === "confirmed") {
      const name = state.name;
      return setRequest((now) => (now?.id === current.id ? { ...now, stage: "confirmed", name } : now));
    }
    if (state.state === "needs_approval") {
      await teamRequest(`/api/team/session/telegram/${current.id}`, { body: { proof: current.proof, action: "not-me" } });
      end();
      return host.current.onDone("not-linked");
    }
    return end(text(state.state === "denied" ? "team.signIn.denied" : "team.signIn.expired"));
  };

  const start = async () => {
    setBusy(true);
    onMessage(null);
    const answer = await teamRequest<{ id: string; proof: string; url: string }>("/api/team/session/telegram", { body: { purpose } });
    setBusy(false);
    if (!answer.ok) return onMessage(answer.code === "telegram_unavailable" ? t("team.telegram.unavailable") : errorText(t, answer));
    setRequest({ ...answer.body, stage: "waiting" });
    window.open(answer.body.url, "_blank", "noopener");
  };

  /* Waiting for the bot to hear Start; the person types the code only after it is sent, so nothing polls then. */
  const waiting = request?.stage === "waiting" ? request : null;
  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      const answer = await teamRequest<TelegramState>(`/api/team/session/telegram/${waiting.id}`, { body: { proof: waiting.proof } });
      if (!alive) return;
      if (answer.ok && answer.body.state === "code_sent") {
        setRequest((now) => (now?.id === waiting.id ? { ...now, stage: "code" } : now));
        return;
      }
      if (answer.ok && answer.body.state !== "waiting") return void settle(waiting, answer.body);
      timer = window.setTimeout(poll, POLL_MS);
    };
    timer = window.setTimeout(poll, POLL_MS);
    return () => { alive = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the request id
  }, [waiting?.id]);

  /* Confirmed: the name shows for a beat so a person who sees someone else's can say so, then the cookie is taken. */
  const confirmed = request?.stage === "confirmed" ? request : null;
  useEffect(() => {
    if (!confirmed) return;
    const timer = window.setTimeout(async () => {
      const done = await teamRequest(`/api/team/session/telegram/${confirmed.id}`, { body: { proof: confirmed.proof, action: "complete" } });
      if (done.ok) { end(); host.current.onDone("signed-in"); }
      else end(errorText(host.current.t, done));
    }, CONFIRM_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per confirmation
  }, [confirmed?.id]);

  const notMe = async () => {
    if (!confirmed) return;
    const current = confirmed;
    end();
    await teamRequest(`/api/team/session/telegram/${current.id}`, { body: { proof: current.proof, action: "not-me" } });
  };

  if (request?.stage === "confirmed") {
    return (
      <div className="flex flex-col items-start gap-1" data-telegram-step-stage="confirmed">
        <p className="text-ui font-semibold text-primary" aria-live="polite">{t("team.signIn.signingInAs", { name: request.name ?? "" })}</p>
        <button type="button" className={BUTTON.text} onClick={() => void notMe()} data-telegram-step-not-me="">{t("team.signIn.notMe")}</button>
      </div>
    );
  }
  if (request?.stage === "code") {
    return (
      <div data-telegram-step-stage="code">
        <TelegramCodeForm id={request.id} proof={request.proof} onError={onMessage} onState={(state, message) => void settle(request, state, message)} />
      </div>
    );
  }
  if (request) {
    return (
      <div className="flex flex-col items-start gap-2" data-telegram-step-stage="waiting">
        <p className="flex items-center gap-2 text-ui text-secondary" aria-live="polite">
          <span className="h-1.5 w-1.5 rounded-full bg-accent motion-safe:animate-pulse" aria-hidden />{t("team.telegram.waiting")}
        </p>
        <a href={request.url} target="_blank" rel="noreferrer" className={BUTTON.text} data-telegram-step-open="">
          <Send className="h-3.5 w-3.5" aria-hidden />{t("team.signIn.openTelegram")}
        </a>
      </div>
    );
  }
  return (
    <button type="button" disabled={busy} className={buttonClassName ?? `${BUTTON.small} self-start`} onClick={() => void start()}
      data-telegram-step={purpose} data-team-link-telegram={purpose === "link" ? "" : undefined}>
      <Send className="h-3.5 w-3.5" aria-hidden />{t(purpose === "link" ? "team.telegram.link" : "team.signIn.telegram")}
    </button>
  );
}
