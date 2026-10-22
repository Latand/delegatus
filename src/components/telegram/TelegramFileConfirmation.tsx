"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n";
import { fileConfirmationText, fileConfirmationReason, type FileConfirmationView } from "@/lib/telegram/bot/fileConfirmationContract";

export function TelegramFileConfirmationView({ view, busy, onDecide }: {
  view: FileConfirmationView; busy: boolean; onDecide(approve: boolean): void;
}) {
  const { locale } = useLocale();
  const words = fileConfirmationText[locale];
  const main = useRef<HTMLElement>(null);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), Math.max(0, Date.parse(view.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [view.expiresAt]);
  const state = view.state === "pending" && expired ? "expired" : view.state;
  const awaitingDecision = state === "pending" && !busy;
  useEffect(() => { main.current?.scrollTo({ top: 0 }); }, [state, busy]);
  return <main ref={main} data-file-confirmation className="h-dvh overflow-y-auto bg-canvas p-4 text-primary sm:p-8">
    <article className="mx-auto max-w-2xl space-y-5 rounded-xl border border-border bg-card p-5 sm:p-8">
      <h1 className="text-xl font-semibold">{awaitingDecision ? words.title : <span role="status">{busy ? words.approved : words[state]}</span>}</h1>
      {awaitingDecision && <><p role="status">{words.pending}</p><p>{words.intro}</p></>}
      <dl className="space-y-2 break-words">
        <dt className="font-semibold">{words.chat}</dt><dd>{view.chatTitle} · <code>{view.chatId}</code></dd>
        <dt className="font-semibold">{words.topic}</dt><dd>{view.topicId ?? "—"}</dd>
        <dt className="font-semibold">{words.expires}</dt><dd>{view.expiresAt}</dd>
      </dl>
      <section aria-label={words.files} className="space-y-3">
        <h2 className="font-semibold">{words.files}</h2>
        {view.files.map((file, index) => <div key={index} className="space-y-1 rounded-lg border border-border p-3">
          <p className="break-all font-medium">{file.filename}</p>
          <p className="break-all text-sm">{file.path}</p>
          <p className="break-all text-sm"><code>SHA-256: {file.sha256}</code></p>
          <p className="text-sm">{file.bytes} B</p>
          <p className="whitespace-pre-wrap break-words">{words.caption}: {view.options.document?.caption ?? view.options.images?.[index]?.caption ?? "—"}</p>
        </div>)}
      </section>
      <section aria-label={words.reasons} className="space-y-2">
        <h2 className="font-semibold">{words.reasons}</h2>
        <ul className="list-disc space-y-2 pl-5">{view.reasons.map((reason, index) => <li key={index} className="break-words"><code>{reason.code}</code>: {fileConfirmationReason(reason, locale)}</li>)}</ul>
      </section>
      {state === "pending" && <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy} className="min-h-11 rounded-lg bg-primary px-4 py-3 text-canvas disabled:opacity-50" onClick={() => onDecide(true)}>{words.approve}</button>
        <button type="button" disabled={busy} className="min-h-11 rounded-lg border border-border px-4 py-3 disabled:opacity-50" onClick={() => onDecide(false)}>{words.reject}</button>
      </div>}
    </article>
  </main>;
}

export function TelegramFileConfirmation() {
  const { locale } = useLocale();
  const words = fileConfirmationText[locale];
  const [view, setView] = useState<FileConfirmationView | null>(null);
  const [error, setError] = useState<"owner" | "unavailable" | "failed" | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const id = new URLSearchParams(window.location.search).get("id") ?? "";
    void fetch(`/api/telegram/bot/confirmation?id=${encodeURIComponent(id)}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) { if (!controller.signal.aborted) setError(response.status === 401 || response.status === 403 ? "owner" : "unavailable"); return; }
      const loaded = await response.json() as FileConfirmationView;
      if (!controller.signal.aborted) setView(loaded);
    }).catch(() => { if (!controller.signal.aborted) setError("unavailable"); });
    return () => controller.abort();
  }, []);
  async function decide(approve: boolean) {
    if (!view || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/telegram/bot/confirmation", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: view.id, digest: view.digest, approve }) });
      const result = await response.json() as { code?: string };
      if (!response.ok) {
        setView({ ...view, state: result.code === "send_uncertain" || result.code === "action_failed" ? "uncertain" : "failed" });
        setError(response.status === 401 || response.status === 403 ? "owner" : null);
      } else setView({ ...view, state: approve ? "sent" : "rejected" });
    } catch { setView({ ...view, state: "uncertain" }); }
    finally { setBusy(false); }
  }
  if (error || !view) return <main className="h-dvh overflow-y-auto bg-canvas p-8 text-primary"><p role="status">{error ? words[error] : words.loading}</p>{error === "owner" && <a className="mt-4 inline-block underline" href={`/sign-in?next=${encodeURIComponent(typeof window === "undefined" ? "/telegram-file-confirmation" : window.location.pathname + window.location.search)}`}>{words.signIn}</a>}</main>;
  return <TelegramFileConfirmationView view={view} busy={busy} onDecide={approve => { void decide(approve); }} />;
}
