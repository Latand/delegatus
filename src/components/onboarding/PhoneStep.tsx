"use client";

import { AlertTriangle, Check, Smartphone } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AccessQrImage, AccessQrLink } from "@/components/AccessQrButton";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { AccessResponse, PhoneFailureCode, PhoneState } from "@/lib/access/phoneAccess";
import { useLocale, type TFunction } from "@/lib/i18n";

/**
 * Step 3, Phone (#1876 slice 3, design §2.3): the state Tailscale is in on
 * this computer and ONE button that turns phone access on from the running
 * Viewer. `POST /api/access/phone` remembers the choice, publishes the Viewer
 * in the tailnet, verifies it and re-binds the gate; the reply comes back with
 * the link, and the QR is drawn here. A Tailscale that is missing, signed out
 * or without MagicDNS gets one sentence and one link, and is re-read by
 * itself while the step is on screen.
 */

/** What the step ended on, for Continue to mark it done or skipped. */
export type PhoneStepOutcome = PhoneState | "on-phone" | "unreadable";

const PENDING_STATES: ReadonlySet<PhoneState> = new Set(["missing", "needs-login", "no-dns"]);
const OPERATOR_COMMAND = "sudo tailscale set --operator=$USER";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const SENTENCE: Record<"missing" | "needs-login" | "no-dns", { text: Parameters<TFunction>[0]; link: Parameters<TFunction>[0]; href: string }> = {
  missing: { text: "onboarding.phone.missing", link: "onboarding.phone.missingLink", href: "https://tailscale.com/download" },
  "needs-login": { text: "onboarding.phone.needsLogin", link: "onboarding.phone.needsLoginLink", href: "https://tailscale.com/kb/1017/install" },
  "no-dns": { text: "onboarding.phone.noDns", link: "onboarding.phone.noDnsLink", href: "https://login.tailscale.com/admin/dns" },
};

type Failure = { code: PhoneFailureCode; detail: string };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ready"; access: AccessResponse };

function isAccess(value: unknown): value is AccessResponse {
  return Boolean(value) && typeof value === "object" && "phone" in (value as object);
}

function failureSentence(t: TFunction, failure: Failure): string {
  const key = `onboarding.phone.code.${failure.code}` as Parameters<TFunction>[0];
  return t(key, { detail: failure.detail || failure.code });
}

const BUTTON = "inline-flex h-8 items-center justify-center gap-1.5 rounded-[8px] px-3.5 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:w-full";

export function PhoneStep({ onSkip, onState, pollMs = 5_000 }: {
  /** "Not now": marks the step skipped and moves on. */
  onSkip?: () => void;
  onState?: (state: PhoneStepOutcome) => void;
  pollMs?: number;
}) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState<"enable" | "disable" | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const onStateRef = useRef(onState);
  useEffect(() => { onStateRef.current = onState; });

  /* Opened on a phone that reached the Viewer over the network: it is
     already here, so there is nothing to turn on. */
  const [onPhone] = useState(() => isMobile && typeof window !== "undefined" && !LOOPBACK.has(window.location.hostname));

  const read = useCallback(async (quiet: boolean) => {
    if (!quiet) setLoad({ kind: "loading" });
    try {
      const response = await fetch("/api/access", { cache: "no-store" });
      const body: unknown = response.ok ? await response.json() : null;
      if (!isAccess(body)) throw new Error(`HTTP ${response.status}`);
      setLoad({ kind: "ready", access: body });
    } catch {
      if (!quiet) setLoad({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    if (onPhone) return;
    void read(false);
  }, [onPhone, read]);

  const state = load.kind === "ready" ? load.access.phone?.state ?? null : null;
  /* A Tailscale that is being installed or signed in shows up by itself. */
  useEffect(() => {
    if (!state || !PENDING_STATES.has(state) || busy) return;
    const id = window.setInterval(() => void read(true), pollMs);
    return () => window.clearInterval(id);
  }, [state, busy, pollMs, read]);

  const outcome: PhoneStepOutcome | null = onPhone ? "on-phone" : load.kind === "ready" ? load.access.phone?.state ?? "unreadable" : load.kind === "error" ? "unreadable" : null;
  useEffect(() => {
    if (outcome) onStateRef.current?.(outcome);
  }, [outcome]);

  const act = async (action: "enable" | "disable") => {
    if (busy) return;
    setBusy(action);
    setFailure(null);
    try {
      const response = await fetch("/api/access/phone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (isAccess(body)) setLoad({ kind: "ready", access: body });
      if (!response.ok) {
        const record = (body ?? {}) as { code?: unknown; detail?: unknown };
        const code = typeof record.code === "string" ? record.code as PhoneFailureCode : "STATUS_UNREADABLE";
        setFailure({ code, detail: typeof record.detail === "string" ? record.detail : "" });
      }
    } catch {
      setFailure({ code: action === "enable" ? "STATUS_UNREADABLE" : "DISABLE_FAILED", detail: "" });
    } finally {
      setBusy(null);
    }
  };

  if (onPhone) {
    return (
      <p data-phone-state="on-phone" className="flex items-center gap-2 text-body text-secondary">
        <Smartphone className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        {t("onboarding.phone.onPhone")}
      </p>
    );
  }

  if (load.kind === "loading") {
    return <div className="h-24 max-w-[480px] animate-pulse rounded-[12px] bg-sunken motion-reduce:animate-none" aria-busy />;
  }

  const retryLine = (text: string) => (
    <div data-phone-state="unreadable" className="flex max-w-[480px] items-center gap-3 text-body text-secondary max-sm:flex-col max-sm:items-stretch">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full bg-warning" aria-hidden />
        {text}
      </span>
      <button type="button" onClick={() => void read(false)} className={`${BUTTON} shrink-0 border border-border bg-card text-primary hover:bg-sunken`}>
        {t("onboarding.phone.retry")}
      </button>
    </div>
  );
  if (load.kind === "error") return retryLine(t("onboarding.phone.readError"));
  const { access } = load;
  if (!access.phone) return retryLine(t("onboarding.phone.code.STATUS_UNREADABLE"));
  const phone = access.phone;

  if (phone.state === "missing" || phone.state === "needs-login" || phone.state === "no-dns") {
    const copy = SENTENCE[phone.state];
    return (
      <div data-phone-state={phone.state} className="flex max-w-[480px] flex-col gap-2">
        <p className="text-body leading-[1.45] text-primary">{t(copy.text)}</p>
        <a href={copy.href} target="_blank" rel="noreferrer" className="self-start rounded-[6px] text-ui font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center">
          {t(copy.link)} →
        </a>
      </div>
    );
  }

  const failureBlock = failure ? (
    <div data-phone-failure={failure.code} role="alert" className="flex flex-col gap-2 rounded-[8px] bg-danger-soft p-3 text-body text-danger">
      <p className="leading-[1.45]">{failureSentence(t, failure)}</p>
      {failure.code === "OPERATOR_RIGHTS" ? (
        <code className="self-start break-all rounded-[6px] bg-sunken px-2 py-1 font-mono text-ui text-primary">{OPERATOR_COMMAND}</code>
      ) : null}
      <details className="text-ui text-secondary">
        <summary className="cursor-pointer select-none font-semibold">{t("onboarding.phone.details")}</summary>
        <pre className="mt-1.5 whitespace-pre-wrap break-all rounded-[6px] bg-sunken px-2 py-1.5 font-mono text-[11px] text-primary">{failure.code}{failure.detail ? `\n${failure.detail}` : ""}</pre>
      </details>
    </div>
  ) : null;

  if (phone.state === "serving" && access.tailnetUrl) {
    return (
      <div data-phone-state="serving" className="flex gap-5 max-sm:flex-col max-sm:gap-4">
        <div className="flex h-[240px] w-[240px] shrink-0 items-center justify-center rounded-[12px] bg-white max-sm:mx-auto">
          <AccessQrImage url={access.tailnetUrl} size={220} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <p className="flex items-center gap-1.5 text-title font-bold text-primary">
            <Check className="h-4 w-4 shrink-0 text-success" aria-hidden />
            {t("onboarding.phone.servingTitle")}
          </p>
          <p className="text-body leading-[1.45] text-secondary">{t("onboarding.phone.servingNote")}</p>
          <AccessQrLink url={access.tailnetUrl} copyLabel={t("onboarding.phone.copy")} />
          <p className="text-ui leading-[1.45] text-secondary">{t("onboarding.phone.gateLine")}</p>
          {phone.persisted ? <p className="text-ui leading-[1.45] text-secondary">{t("onboarding.phone.persistedLine")}</p> : null}
          <button
            type="button"
            data-phone-disable=""
            disabled={busy !== null}
            onClick={() => void act("disable")}
            className={`${BUTTON} self-start border border-border bg-card text-primary hover:bg-sunken disabled:opacity-60`}
          >
            {busy === "disable" ? t("onboarding.phone.disabling") : t("onboarding.phone.disable")}
          </button>
          {failureBlock}
        </div>
      </div>
    );
  }

  const other = phone.state === "serving-other";
  return (
    <div data-phone-state={phone.state} className="flex max-w-[480px] flex-col gap-3" aria-busy={busy === "enable" || undefined}>
      <p className="text-title font-bold text-primary">
        {other
          ? phone.servingPort ? t("onboarding.phone.otherTitle", { port: phone.servingPort }) : t("onboarding.phone.otherTitleNoPort")
          : t("onboarding.phone.readyTitle")}
      </p>
      {other ? (
        <p className="flex items-start gap-2 text-ui leading-[1.45] text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t("onboarding.phone.otherWarning")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 max-sm:flex-col max-sm:items-stretch">
        <button
          type="button"
          data-phone-enable=""
          disabled={busy !== null}
          onClick={() => void act("enable")}
          className={`${BUTTON} bg-accent text-white hover:opacity-90 disabled:opacity-70`}
        >
          {busy === "enable" ? t("onboarding.phone.busy") : failure ? t("onboarding.phone.retry") : other ? t("onboarding.phone.otherButton") : t("onboarding.phone.enable")}
        </button>
        {onSkip && busy === null ? (
          <button type="button" data-phone-skip="" onClick={onSkip} className={`${BUTTON} text-secondary hover:bg-sunken hover:text-primary`}>
            {t("onboarding.phone.skip")}
          </button>
        ) : null}
      </div>
      <p className="text-ui leading-[1.45] text-secondary">{busy === "enable" ? t("onboarding.phone.busyLine") : t("onboarding.phone.enableNote")}</p>
      {failureBlock}
    </div>
  );
}
