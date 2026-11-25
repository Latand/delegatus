"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { OperatorSettingsResponse } from "@/app/api/operator/settings/route";
import { useLocale } from "@/lib/i18n";

import { telemetryNotice } from "../../../bin/telemetry-notice.mjs";
import { BlockRow, BUTTON, DetailsRow, markLiterals, Prose, RefusalLine, Rows, SectionHead, SwitchRow, TextRow } from "./settingsRows";

type Status = { enabled: boolean; locked: boolean; noticeDismissed: boolean; swarmRules: boolean };

async function readConsent(): Promise<boolean> {
  const response = await fetch("/api/subscription-api-consent", { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error();
  const body = await response.json();
  if (typeof body.enabled !== "boolean") throw Error();
  return body.enabled;
}

type AttributionStatus = Pick<OperatorSettingsResponse, "commitAttribution" | "commitAccount">;

async function attributionStatus(signal: AbortSignal, enabled?: boolean): Promise<AttributionStatus> {
  const response = await fetch("/api/operator/settings", {
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    ...(enabled === undefined ? {} : {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commitAttribution: enabled }),
    }),
  });
  if (!response.ok) throw new Error();
  const value = await response.json() as AttributionStatus;
  if ((value.commitAttribution !== null && typeof value.commitAttribution?.value !== "boolean")
    || (value.commitAccount?.state !== "unresolved"
      && !(value.commitAccount?.state === "resolved" && typeof value.commitAccount.login === "string"))) throw new Error();
  return value;
}

function CommitAttributionRow() {
  const { t } = useLocale();
  const [status, setStatus] = useState<AttributionStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(true);
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef(false);

  const load = useCallback(async (signal: AbortSignal, enabled?: boolean) => {
    if (pending.current || signal.aborted) return;
    pending.current = true;
    try {
      const next = await attributionStatus(signal, enabled);
      if (!signal.aborted) setStatus(next);
    } catch {
      if (signal.aborted) return;
      setFailed(true);
      // A write may have persisted before its reply was lost.
      try {
        const stored = enabled === undefined ? null : await attributionStatus(signal);
        if (!signal.aborted) setStatus(stored);
      } catch { if (!signal.aborted) setStatus(null); }
    } finally {
      if (!signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    pending.current = true;
    void attributionStatus(controller.signal).then(
      next => { if (!controller.signal.aborted) setStatus(next); },
      () => { if (!controller.signal.aborted) setFailed(true); },
    ).finally(() => {
      if (!controller.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    });
    return () => controller.abort();
  }, []);

  const request = (enabled?: boolean) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pending.current) return;
    setBusy(true);
    setFailed(false);
    void load(signal, enabled);
  };
  const enabled = status?.commitAttribution?.value !== false;
  const account = status?.commitAccount;
  return (
    <SwitchRow
      attrs={{ "data-commit-attribution": "" }}
      label={t("settings.privacy.commitAttribution")}
      hint={t("settings.privacy.commitAttributionHint")}
      enabled={status !== null && enabled}
      disabled={busy || status === null}
      onToggle={() => request(!enabled)}
    >
      {account ? (
        <TextRow tone="muted" attrs={{ "data-commit-account": account.state }}>
          {account.state === "resolved"
            ? t("settings.privacy.commitAccountResolved", { login: account.login })
            : t("settings.privacy.commitAccountUnresolved")}
        </TextRow>
      ) : null}
      {failed ? <RefusalLine>{t("settings.privacy.commitAttributionError")}</RefusalLine> : null}
      {(!status && failed) || account?.state === "unresolved" ? (
        <BlockRow><button type="button" className={BUTTON} disabled={busy} onClick={() => request()}>{t("settings.privacy.retry")}</button></BlockRow>
      ) : null}
    </SwitchRow>
  );
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

  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  /* A read that failed leaves a control to read it again: a disabled switch under a refusal is no dead end. */
  const loadStatus = useCallback(() => {
    fetch("/api/telemetry", { cache: "no-store" }).then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then((next) => { if (mounted.current) setStatus(next); })
      .catch(() => { if (mounted.current) setFailed("read"); });
  }, []);
  const loadConsent = useCallback(() => {
    readConsent().then((value) => { if (mounted.current) setConsent(value); }).catch(() => { if (mounted.current) setConsentFailed(true); });
  }, []);
  useEffect(() => { loadStatus(); loadConsent(); }, [loadStatus, loadConsent]);

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
        ) : failed === "read" ? (
          <div data-settings-unit="" data-telemetry-read-failed="">
            <RefusalLine>{t("telemetry.error")}</RefusalLine>
            <BlockRow><button type="button" data-telemetry-retry="" className={BUTTON} onClick={() => { setFailed(false); loadStatus(); }}>{t("settings.privacy.retry")}</button></BlockRow>
          </div>
        ) : null}
        <SwitchRow
          attrs={{ "data-subscription-api": "" }}
          label={t("subscriptionApi.label")}
          hint={t("settings.privacy.directHint")}
          enabled={consent === true}
          disabled={consent === null}
          onToggle={() => void saveConsent(!consent)}
        >
          {consentFailed ? <RefusalLine>{t("telemetry.error")}</RefusalLine> : null}
          {consentFailed && consent === null ? <BlockRow><button type="button" data-subscription-api-retry="" className={BUTTON} onClick={() => { setConsentFailed(false); loadConsent(); }}>{t("settings.privacy.retry")}</button></BlockRow> : null}
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
        <CommitAttributionRow />
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
