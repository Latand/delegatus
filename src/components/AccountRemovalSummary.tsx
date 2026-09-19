"use client";

import { TriangleAlert } from "lucide-react";
import { useState } from "react";

import type { AccountCleanupReport, AccountRemovalSummary as Summary } from "@/hooks/useEngineAccounts";
import { type Locale, type TFunction, useLocale } from "@/lib/i18n";

import { copyText } from "./feed/CopyButton";
import { Check, CircleCheck, Copy, Loader2, X } from "./icons";

/** Decimal units (1 GB = 10⁹ bytes), one decimal from MB up: `812 KB`,
    `14.2 MB`, `2.1 GB`. */
export function formatArchiveBytes(bytes: number, t: TFunction, locale: Locale): string {
  const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const tenth = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (bytes < 1_000) return t("accounts.size.b", { n: whole.format(bytes) });
  if (bytes < 1_000_000) return t("accounts.size.kb", { n: whole.format(Math.round(bytes / 1_000)) });
  if (bytes < 1_000_000_000) return t("accounts.size.mb", { n: tenth.format(bytes / 1_000_000) });
  return t("accounts.size.gb", { n: tenth.format(bytes / 1_000_000_000) });
}

export function formatFileCount(files: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(files);
}

/** The home directory reads as `~`; the client never learns the home, so the
    usual home roots stand in for it. */
export function displayArchivePath(pathname: string): string {
  return pathname.replace(/^(?:\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/, "~");
}

/** A path cut at its front: the head shrinks from the left behind an
    ellipsis, so the folders nearest the account (`…/shared/claude/retired/`)
    stay readable, and the last segment, the account id, always stays visible. */
export function ArchivePath({ path, copyLabel, phone = false }: { path: string; copyLabel: string; phone?: boolean }) {
  const [copied, setCopied] = useState(false);
  const shown = displayArchivePath(path);
  const cut = shown.lastIndexOf("/");
  const head = cut >= 0 ? shown.slice(0, cut + 1) : "";
  const tail = cut >= 0 ? shown.slice(cut + 1) : shown;
  return (
    <span className="flex min-w-0 items-center gap-1" data-archive-path={path}>
      <span className="flex min-w-0 font-mono text-[10.5px] text-secondary" title={path}>
        <span dir="rtl" className="min-w-0 truncate text-left"><bdi dir="ltr">{head}</bdi></span>
        <span className="shrink-0" data-archive-path-id>{tail}</span>
      </span>
      <button
        type="button"
        aria-label={copyLabel}
        onClick={() => void copyText(path).then((ok) => setCopied(ok))}
        className={`inline-flex shrink-0 items-center justify-center rounded-[5px] text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "h-11 w-11" : "h-11 w-11 sm:h-5 sm:w-5"}`}
      >
        {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
      </button>
    </span>
  );
}

function Card({ title, icon, dismissLabel, onDismiss, phone, children, testId }: {
  title: string;
  icon: "done" | "warning";
  dismissLabel: string;
  onDismiss: () => void;
  phone: boolean;
  children?: React.ReactNode;
  testId: string;
}) {
  return (
    <section
      role="status"
      aria-live="polite"
      data-account-removal-card={testId}
      className={phone
        ? "mx-3 mb-1.5 rounded-[12px] bg-card px-3.5 py-3 shadow-1"
        : "border-t border-border bg-card px-3.5 py-3"}
    >
      <div className="flex items-start gap-2">
        {icon === "done"
          ? <CircleCheck className="mt-[1px] h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
          : <TriangleAlert className="mt-[1px] h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />}
        <h3 className="min-w-0 flex-1 break-words text-[12.5px] font-bold leading-tight text-primary">{title}</h3>
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className={`-mt-0.5 inline-flex shrink-0 items-center justify-center rounded-[6px] text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "-my-3 -mr-2 h-11 w-11" : "h-11 w-11 sm:h-5 sm:w-5"}`}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
      <div className="pl-[22px]">{children}</div>
    </section>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[10.5px] font-semibold leading-[1.45] text-secondary">{label}</dt>
      <dd className="min-w-0 break-words text-[11px] leading-[1.45] tabular-nums text-primary">{children}</dd>
    </>
  );
}

const LIST = "mt-2 grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1";

/**
 * What a removal moved (#1857 §5.3). `Moved` and `Archive` always draw; the
 * four counts draw only above zero. A sign-in file left in the archive adds a
 * warning line whose button runs the clean-up. No timer: it stays until the
 * operator closes it or the panel.
 */
export function AccountRemovalSummary({ summary, phone = false, busy, onDismiss, onFinishCleanup }: {
  summary: Summary;
  phone?: boolean;
  busy: boolean;
  onDismiss: () => void;
  onFinishCleanup: () => void;
}) {
  const { t, locale } = useLocale();
  return (
    <Card testId="removed" title={t("accounts.removed.title", { label: summary.label })} icon="done" dismissLabel={t("accounts.removed.dismiss")} onDismiss={onDismiss} phone={phone}>
      <p className="mt-0.5 text-[11px] leading-[1.45] text-secondary">{t("accounts.removed.readable")}</p>
      <dl className={LIST}>
        <Line label={t("accounts.removed.moved")}>
          {t("accounts.removed.movedValue", { count: summary.files, files: formatFileCount(summary.files, locale), size: formatArchiveBytes(summary.bytes, t, locale) })}
        </Line>
        <Line label={t("accounts.removed.archive")}>
          {summary.archive
            ? <ArchivePath path={summary.archive} copyLabel={t("accounts.removed.copyPath")} phone={phone} />
            : <span className="text-secondary">{t("accounts.removed.noArchive")}</span>}
        </Line>
        {summary.conversations > 0 ? <Line label={t("accounts.removed.conversations")}>{t("accounts.removed.conversationsValue", { count: summary.conversations })}</Line> : null}
        {summary.pins > 0 ? <Line label={t("accounts.removed.pins")}>{summary.pins}</Line> : null}
        {summary.deliveries > 0 ? <Line label={t("accounts.removed.deliveries")}>{t("accounts.removed.deliveriesValue", { count: summary.deliveries })}</Line> : null}
        {summary.migrations > 0 ? <Line label={t("accounts.removed.migrations")}>{t("accounts.removed.migrationsValue", { count: summary.migrations })}</Line> : null}
      </dl>
      {summary.credential === "pending" ? (
        <div data-account-removal-credential="pending" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-[1.45] text-warning">
          <span className="min-w-0 flex-1 basis-[180px]">{t("accounts.removed.credentialLeft")}</span>
          <button
            type="button"
            disabled={busy}
            onClick={onFinishCleanup}
            className={`inline-flex shrink-0 items-center gap-1 rounded-[6px] border border-border bg-canvas px-2 text-[10.5px] font-semibold text-primary hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "min-h-[44px]" : "min-h-[44px] sm:min-h-[24px]"}`}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
            {t("accounts.removed.credentialAction")}
          </button>
        </div>
      ) : null}
      {summary.credential === "deleted" ? (
        <p data-account-removal-credential="deleted" className="mt-2 text-[11px] leading-[1.45] text-secondary">{t("accounts.removed.credentialDone")}</p>
      ) : null}
    </Card>
  );
}

const UNRESOLVED_SHOWN = 5;

/** The clean-up answer (#1857 §5.4), in the same card as the summary. */
export function AccountCleanupResult({ report, phone = false, onDismiss }: {
  report: AccountCleanupReport;
  phone?: boolean;
  onDismiss: () => void;
}) {
  const { t, locale } = useLocale();
  const nothing = report.removed.length === 0 && report.archived.length === 0 && report.unresolved.length === 0;
  const title = report.unresolved.length > 0
    ? t("accounts.cleanup.titlePartial")
    : nothing ? t("accounts.cleanup.titleNothing") : t("accounts.cleanup.title");
  const archivedFiles = report.archived.reduce((sum, item) => sum + item.files, 0);
  const archivedBytes = report.archived.reduce((sum, item) => sum + item.bytes, 0);
  const shown = report.unresolved.slice(0, UNRESOLVED_SHOWN);
  const more = report.unresolved.length - shown.length;
  return (
    <Card testId="cleanup" title={title} icon={report.unresolved.length > 0 ? "warning" : "done"} dismissLabel={t("accounts.removed.dismiss")} onDismiss={onDismiss} phone={phone}>
      {nothing ? null : (
        <dl className={LIST}>
          {report.removed.length > 0 ? <Line label={t("accounts.cleanup.deleted")}>{t("accounts.cleanup.deletedValue", { count: report.removed.length })}</Line> : null}
          {report.archived.length > 0 ? (
            <Line label={t("accounts.cleanup.archived")}>
              {t("accounts.cleanup.archivedValue", { count: report.archived.length, files: formatFileCount(archivedFiles, locale), size: formatArchiveBytes(archivedBytes, t, locale) })}
            </Line>
          ) : null}
          {report.unresolved.length > 0 ? (
            <Line label={t("accounts.cleanup.unresolved")}>
              <span className="flex flex-col">
                {shown.map((name) => <span key={name} className="break-all font-mono text-[10.5px]">{name}</span>)}
                {more > 0 ? <span className="text-secondary">{t("accounts.cleanup.more", { count: more })}</span> : null}
              </span>
            </Line>
          ) : null}
        </dl>
      )}
      {report.unresolved.length > 0 ? <p className="mt-1.5 text-[11px] leading-[1.45] text-secondary">{t("accounts.cleanup.unresolvedHint")}</p> : null}
    </Card>
  );
}

/** A clean-up that did not answer: one line and Try again. */
export function AccountCleanupFailed({ phone = false, busy, onDismiss, onRetry }: { phone?: boolean; busy: boolean; onDismiss: () => void; onRetry: () => void }) {
  const { t } = useLocale();
  return (
    <div
      role="alert"
      data-account-removal-card="cleanupFailed"
      className={phone
        ? "mx-3 mb-1.5 flex items-center gap-2 rounded-[12px] bg-danger-soft py-1 pl-3 pr-1 text-[11px] text-danger"
        : "flex items-center gap-2 border-t border-border px-3 py-1.5 text-[11px] text-danger"}
    >
      <span className="min-w-0 flex-1 leading-snug">{t("accounts.cleanup.failed")}</span>
      <button
        type="button"
        disabled={busy}
        onClick={onRetry}
        className={`inline-flex shrink-0 items-center rounded-[7px] border border-border bg-canvas px-2 text-[11px] font-semibold text-primary hover:bg-sunken disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "min-h-[44px]" : "min-h-[44px] sm:min-h-[24px]"}`}
      >
        {t("accounts.cleanup.retry")}
      </button>
      <button
        type="button"
        aria-label={t("accounts.refusal.dismiss")}
        onClick={onDismiss}
        className={`inline-flex shrink-0 items-center justify-center rounded-[6px] text-muted hover:bg-canvas hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${phone ? "h-11 w-11" : "h-11 w-11 sm:h-5 sm:w-5"}`}
      >
        <X className="h-3 w-3" aria-hidden />
      </button>
    </div>
  );
}
