"use client";

import { useEffect, useRef, useState } from "react";

import { useLocale } from "@/lib/i18n";

import { telemetryNotice } from "../../../bin/telemetry-notice.mjs";
import { DetailsRow, markLiterals, Prose, RefusalLine, Rows, SectionHead, SwitchRow, TextRow } from "./settingsRows";

type Status = { enabled: boolean; locked: boolean; noticeDismissed: boolean; swarmRules: boolean };

async function readConsent(): Promise<boolean> {
  const response = await fetch("/api/subscription-api-consent", { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error();
  const body = await response.json();
  if (typeof body.enabled !== "boolean") throw Error();
  return body.enabled;
}

/**
 * «Privacy»: the install ping, direct Anthropic requests with the subscription
 * and the swarm rules, each a switch with one plain sentence, and what leaves
 * this computer in one line. Variables, endpoints and models stay in «Details».
 * Every switch shows at once and a refusal puts the stored value back beside its
 * reason.
 */
export function PrivacySection() {
  const { t, locale } = useLocale();
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState<false | "read" | "ping" | "swarm">(false);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [consentFailed, setConsentFailed] = useState(false);
  const saving = useRef(false);
  const consentSaving = useRef(false);

  useEffect(() => {
    let disposed = false;
    fetch("/api/telemetry", { cache: "no-store" }).then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then((next) => { if (!disposed) setStatus(next); })
      .catch(() => { if (!disposed) setFailed("read"); });
    readConsent().then((value) => { if (!disposed) setConsent(value); }).catch(() => { if (!disposed) setConsentFailed(true); });
    return () => { disposed = true; };
  }, []);

  /* One write at a time, as the notice's own; a refusal restores what was stored. */
  const save = async (update: Partial<Status>, control: "ping" | "swarm") => {
    if (saving.current || !status) return;
    saving.current = true;
    const before = status;
    setStatus({ ...before, ...update });
    setFailed(false);
    try {
      const response = await fetch("/api/telemetry", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update) });
      if (!response.ok) throw new Error();
      setStatus(await response.json());
    } catch {
      setStatus(before);
      setFailed(control);
    } finally { saving.current = false; }
  };

  /* The switch moves at once. A lost answer can follow a durable write, so on any failure the choice is read back before
     another change is offered, including a later revocation: the switch shows what the server holds, or nothing. */
  const saveConsent = async (next: boolean) => {
    if (consentSaving.current || consent === null) return;
    consentSaving.current = true;
    setConsent(next);
    setConsentFailed(false);
    try {
      const response = await fetch("/api/subscription-api-consent", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }), signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw Error();
      const body = await response.json();
      if (typeof body.enabled !== "boolean") throw Error();
      setConsent(body.enabled);
    } catch {
      setConsentFailed(true);
      setConsent(null);
      try { setConsent(await readConsent()); } catch { setConsent(null); }
    } finally { consentSaving.current = false; }
  };

  return (
    <div data-telemetry-settings="">
      <Rows>
        {status ? (
          <SwitchRow
            label={t("telemetry.label")}
            hint={status.locked ? t("telemetry.locked") : t("settings.privacy.pingHint")}
            enabled={status.enabled}
            disabled={status.locked}
            onToggle={() => void save({ enabled: !status.enabled }, "ping")}
            switchAttrs={{ "data-telemetry-ping": "" }}
          >
            {failed === "ping" ? <RefusalLine>{t("telemetry.error")}</RefusalLine> : null}
          </SwitchRow>
        ) : failed === "read" ? <RefusalLine>{t("telemetry.error")}</RefusalLine> : null}
        <SwitchRow
          attrs={{ "data-subscription-api": "" }}
          label={t("subscriptionApi.label")}
          hint={t("settings.privacy.directHint")}
          enabled={consent === true}
          disabled={consent === null}
          onToggle={() => void saveConsent(!consent)}
        >
          {consentFailed ? <RefusalLine>{t("telemetry.error")}</RefusalLine> : null}
        </SwitchRow>
        {status ? (
          <SwitchRow
            attrs={{ "data-swarm-setting": "" }}
            label={t("telemetry.swarm.label")}
            hint={t("settings.privacy.swarmHint")}
            enabled={status.swarmRules ?? false}
            onToggle={() => void save({ swarmRules: !status.swarmRules }, "swarm")}
          >
            {failed === "swarm" ? <RefusalLine>{t("telemetry.error")}</RefusalLine> : null}
          </SwitchRow>
        ) : null}
        <SectionHead title={t("settings.privacy.leaves")} />
        <TextRow>{t("settings.privacy.leavesLine")}</TextRow>
        <DetailsRow lines={[
          status && !status.locked ? { label: t("settings.privacy.detail.ping"), value: <Prose text={markLiterals(telemetryNotice[locale])} /> } : null,
          { label: t("settings.privacy.detail.limits"), value: <Prose text={t("subscriptionApi.usage")} /> },
          { label: t("settings.privacy.detail.summaries"), value: <Prose text={t("subscriptionApi.memory")} /> },
          { label: t("settings.privacy.detail.newInstalls"), value: t("subscriptionApi.default") },
          { label: t("telemetry.swarm.label"), value: t("telemetry.swarm.description") },
        ]} />
      </Rows>
    </div>
  );
}
