"use client";

import { useCallback, useState } from "react";

import { ExternalRelaySection, type RelayEngine, type RelayView } from "@/components/externalRelay/ExternalRelaySection";
import type { EngineAccountsState } from "@/hooks/useEngineAccounts";
import { useLocale } from "@/lib/i18n";

import { engineConnected } from "./EnginesStep";

/**
 * "Answer for a relay service" (docs/design/relay.md §B.9), optional, under
 * "Later, any time": pick the engine that answers, then pair. The step checks
 * one thing before it lets a pairing start: that an account of that engine is
 * signed in. It runs nothing; a request that finds the account without
 * capacity is declined to the relay service, which falls back.
 *
 * `onHasRelay` reports whether the install holds a paired relay, whenever and
 * however it was paired, so the guide records the step from that rather than
 * from this visit. Like the Phone step once serving, it offers no Skip then.
 */
export function RelayStep({ claude, codex, onGoEngines, onPaired, onHasRelay, onSkip }: {
  claude: EngineAccountsState;
  codex: EngineAccountsState;
  onGoEngines: () => void;
  onPaired: () => void;
  onHasRelay: (paired: boolean) => void;
  onSkip: () => void;
}) {
  const { t } = useLocale();
  const [engine, setEngine] = useState<RelayEngine>(() => engineConnected(claude) || !engineConnected(codex) ? "claude" : "codex");
  const [paired, setPaired] = useState<RelayView | null>(null);
  const [hasRelay, setHasRelay] = useState(false);
  const relays = useCallback((count: number) => { setHasRelay(count > 0); onHasRelay(count > 0); }, [onHasRelay]);
  const state = engine === "claude" ? claude : codex;
  const loading = state.status === "loading" && state.accounts.length === 0;
  const signedIn = engineConnected(state);
  const name = engine === "claude" ? "Claude" : "Codex";
  const action = "inline-flex h-8 items-center justify-center rounded-[8px] px-4 text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11 max-sm:flex-1";
  const radio = (value: RelayEngine, label: string) => {
    const on = engine === value;
    return (
      <button
        key={value}
        type="button"
        role="radio"
        aria-checked={on}
        data-onboarding-relay-engine={value}
        onClick={() => setEngine(value)}
        className={`flex w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:py-3 ${on ? "border-accent/50 bg-accent-soft/50" : "border-border bg-card hover:bg-sunken"}`}
      >
        <span aria-hidden className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 ${on ? "border-accent" : "border-strong"}`}>
          {on ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
        </span>
        <span className="truncate text-body font-semibold text-primary">{label}</span>
      </button>
    );
  };
  return (
    <div data-onboarding-relay="" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="text-label font-semibold uppercase tracking-[0.06em] text-muted">{t("onboarding.relay.engine")}</div>
        <div role="radiogroup" aria-label={t("onboarding.relay.engine")} className="flex max-w-[420px] flex-col gap-2">
          {radio("claude", "Claude")}
          {radio("codex", "Codex")}
        </div>
        {loading ? null : signedIn ? (
          <p role="status" data-onboarding-relay-account="signed-in" className="text-ui font-semibold text-success">{t("onboarding.relay.signedIn", { engine: name })}</p>
        ) : (
          <div data-onboarding-relay-account="signed-out" className="flex max-w-[520px] flex-col items-start gap-2">
            <p role="alert" className="rounded-[8px] bg-warning-soft px-3 py-2 text-ui text-warning">{t("externalRelay.noAccount", { engine: name })}</p>
            <button type="button" onClick={onGoEngines} className="inline-flex h-8 items-center justify-center rounded-[8px] border border-border bg-card px-4 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 max-sm:h-11">{t("onboarding.relay.goEngines")}</button>
          </div>
        )}
      </div>
      <ExternalRelaySection pairEngine={engine} pairDisabled={!signedIn} onPaired={(relay) => { setPaired(relay); onPaired(); }} onRelays={relays} />
      {paired ? <p role="status" data-onboarding-relay-paired="" className="text-ui font-semibold text-success">{t("onboarding.relay.paired", { name: paired.name, engine: name })}</p> : null}
      {hasRelay ? null : (
        <div className="flex gap-2">
          <button type="button" data-onboarding-relay-skip="" onClick={onSkip} className={`${action} border border-border bg-card text-primary hover:bg-sunken`}>{t("onboarding.relay.skip")}</button>
        </div>
      )}
    </div>
  );
}
