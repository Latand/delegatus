"use client";

import { useRef, useState } from "react";
import { useLocale } from "@/lib/i18n";
import type { PrototypeRoundView, PrototypeTelegramPost } from "@/lib/prototypeReview/types";

/** Shared action area for the task review and the seat's taskless form. */
export function PrototypeTelegramActions({ round, disabled = false, onResend, stacked = false }: {
  round: PrototypeRoundView; disabled?: boolean; onResend?: () => Promise<unknown>; stacked?: boolean;
}) {
  const { t } = useLocale();
  const [local, setLocal] = useState<{ id: string; post: PrototypeTelegramPost } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<{ id: string; key: string } | null>(null);
  const post = local?.id === round.id && local.post.at > (round.telegramPost?.at ?? "") ? local.post : round.telegramPost;
  const reason = post?.reason ?? "unavailable";
  const reasonCode = (["forbidden", "no_relay", "paused", "no_target", "not_configured", "bot_not_connected", "send_uncertain"] as const).find(code => code === reason);
  const described = reasonCode ? `${t(`proto.telegram.reason.${reasonCode}`)} (${reason})` : reason;
  const resend = async () => {
    if (busy || disabled) return;
    if (onResend) { await onResend(); return; }
    setBusy(true); setError(null);
    if (key.current?.id !== round.id) key.current = { id: round.id, key: crypto.randomUUID() };
    try {
      const response = await fetch("/api/prototype-reviews/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewId: round.id, clientRequestId: key.current.key }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Telegram post could not be resent");
      setLocal({ id: round.id, post: result.telegramPost }); key.current = null;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Telegram post could not be resent"); }
    finally { setBusy(false); }
  };
  return <div className={`grid min-w-0 grid-cols-1 items-start gap-2 ${stacked ? "" : "sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"}`} data-prototype-telegram-actions="">
    <span role="status" data-prototype-telegram-state={post?.state ?? "unknown"} className={`min-h-[2lh] min-w-0 text-label [overflow-wrap:anywhere] ${stacked ? "" : "sm:min-h-0"} ${post?.state === "failed" || post?.state === "uncertain" ? "text-warning" : "text-secondary"}`}>
      {t(`proto.telegram.${post?.state ?? "unknown"}`, { reason: described })}
    </span>
    <button type="button" className="inline-flex min-h-8 max-w-full items-center justify-center justify-self-start rounded-control border border-border bg-card px-3 text-left text-ui font-semibold text-primary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 [@media(pointer:coarse)]:min-h-11" data-prototype-telegram-resend="" disabled={disabled || busy} onClick={() => void resend()}>{t("proto.telegram.resend")}</button>
    {error ? <p role="alert" className="col-span-full m-0 w-full text-label text-danger [overflow-wrap:anywhere]">{error}</p> : null}
  </div>;
}
