"use client";

import { useEffect, useState } from "react";

import { Check, Copy, Loader2, SquareTerminal, X } from "@/components/icons";
import { AlertTriangle } from "lucide-react";
import { useLocale, type TFunction } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { AttachCommand } from "@/lib/agent/attachCommand";
import { Z } from "@/components/layers";

async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* clipboard blocked (plain HTTP / permissions) — the field stays selectable */
  }
  return false;
}

/** One labelled command block with its own copy button and copied confirmation. */
function CopyRow({ t, label, value }: { t: TFunction; label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <div className="flex items-stretch gap-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-control border border-border bg-sunken px-2 py-1.5 font-mono text-[11.5px] leading-relaxed text-primary">
        {value}
      </code>
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => void copyText(value).then((ok) => ok && setCopied(true))}
        className="inline-flex min-h-11 shrink-0 items-center gap-1 self-stretch rounded-control border border-border bg-canvas px-2.5 text-label font-semibold text-secondary hover:border-accent/45 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-0 sm:py-1"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
        {copied ? t("attach.copied") : t("attach.copy")}
      </button>
    </div>
  );
}

export interface AttachTerminalDialogViewProps {
  t: TFunction;
  loading: boolean;
  error: string | null;
  /** The command that reopens the conversation in the operator's own terminal. */
  command: AttachCommand | null;
  onClose: () => void;
}

/** Presentational attach dialog — instant, copyable, no waiting (issue #247
    item 2). Pure so its copy payloads are DOM-tested. */
export function AttachTerminalDialogView({
  t,
  loading,
  error,
  command,
  onClose,
}: AttachTerminalDialogViewProps) {
  return (
    <div
      className={`fixed inset-0 ${Z.overlay} flex items-center justify-center bg-black/40 p-3`}
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("attach.dialogTitle")}
        className="flex max-h-[85vh] w-full max-w-[560px] flex-col gap-3 overflow-y-auto rounded-surface border border-border bg-card p-4 shadow-2"
      >
        <div className="flex items-start gap-2">
          <SquareTerminal className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="text-body font-bold text-primary">{t("attach.dialogTitle")}</h2>
            {command ? (
              <p className="mt-0.5 text-label text-muted">
                {t("attach.dialogIntro", { account: command.accountLabel })}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border bg-canvas text-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8 sm:w-8"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {loading ? (
          <div role="status" aria-live="polite" className="flex items-center gap-2 py-4 text-label font-semibold text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t("attach.loading")}
          </div>
        ) : error ? (
          <div role="alert" className="rounded-control border border-danger/45 bg-danger-soft px-3 py-2 text-label font-semibold text-danger">
            {error}
          </div>
        ) : command ? (
          <>
            <CopyRow t={t} label={t("attach.copyCwd")} value={command.cdCommand} />
            <CopyRow t={t} label={t("attach.copyCommand")} value={command.command} />
            {command.note === "subagent-root" ? (
              <p className="text-caption text-muted">{t("attach.subagentNote")}</p>
            ) : null}
            <div className="flex items-start gap-1.5 text-caption font-semibold text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{t("attach.takeoverWarning")}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => void copyText(command.fullCommand)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-control border border-brand bg-brand px-3 text-label font-bold text-on-brand hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-9"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden /> {t("attach.copyFull")}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Container: fetches the composed command from `/api/attach-command` the moment
 * it mounts (all data is already in the registry — no spawn, no wait) and drives
 * the presentational view.
 */
export function AttachTerminalDialog({ file, onClose }: { file: FileEntry; onClose: () => void }) {
  const { t } = useLocale();
  const [command, setCommand] = useState<AttachCommand | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // The dialog mounts fresh each open, so `loading`/`error` already start at
    // their initial values — no synchronous reset needed in the effect body.
    let cancelled = false;
    fetch(`/api/attach-command?path=${encodeURIComponent(file.path)}`).then(async (response) => {
      const body = (await response.json().catch(() => ({}))) as AttachCommand & { error?: string };
      if (cancelled) return;
      if (!response.ok) setError(body.error ?? t("attach.unavailable"));
      else setCommand(body);
    })
      .catch(() => { if (!cancelled) setError(t("attach.network")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // `t` is intentionally excluded: it changes identity every render, and
    // re-running this effect on each render would re-fetch the command in a loop.
    // The command depends only on the transcript path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);

  return <AttachTerminalDialogView t={t} loading={loading} error={error} command={command} onClose={onClose} />;
}
