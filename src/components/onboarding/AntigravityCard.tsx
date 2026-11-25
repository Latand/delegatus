"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { EngineMark } from "@/components/EngineMark";
import { engineTintOf } from "@/components/utils";
import { CopyButton } from "@/components/feed/CopyButton";
import { InstallCommand, RecheckButton } from "@/components/onboarding/EngineCardParts";
import { useLocale } from "@/lib/i18n";
import { ANTIGRAVITY_INSTALL_COMMAND } from "@/lib/onboarding/agentInstallCommands";

/**
 * Antigravity's sign-in (the third engine card). `agy` has no login or status
 * command: Google OAuth runs in its own terminal screen. So the card shows the
 * one command to run, and a "Check sign-in" that starts `agy` on the server
 * and asks it to open a session (`POST /api/accounts/antigravity`). The Engines
 * step, the sidebar footer's popover and the phone accounts screen render the
 * same body from the same hook.
 */

/** A probe tells the other mounts of the hook (the footer row, the guide) to re-read the record it just wrote. */
const AUTH_CHANGED_EVENT = "llv:antigravity-auth";

export type AntigravityCliPresence = "found" | "missing" | null;
export type AntigravityAuth = "signed_in" | "signed_out" | "unknown";

export type AntigravityAccount = {
  /** Whether `agy` resolves, as the last read said; null before the first answer. */
  cli: AntigravityCliPresence;
  auth: AntigravityAuth;
  plan: string | null;
  /** The first read is out. */
  loaded: boolean;
  probing: boolean;
  /** The last check reached no answer, so the state shown is the one recorded before it. */
  inconclusive: boolean;
  probe: () => Promise<void>;
  reload: () => Promise<void>;
};

type Section = { cli?: unknown; accounts?: { auth?: unknown; plan?: unknown }[] };

function readSection(body: unknown): { cli: AntigravityCliPresence; auth: AntigravityAuth; plan: string | null } | null {
  if (!body || typeof body !== "object") return null;
  const section = body as Section;
  const account = Array.isArray(section.accounts) ? section.accounts[0] : undefined;
  const auth = account?.auth === "signed_in" || account?.auth === "signed_out" ? account.auth : "unknown";
  return {
    cli: section.cli === "found" || section.cli === "missing" ? section.cli : null,
    auth,
    plan: typeof account?.plan === "string" && account.plan.trim() ? account.plan.trim() : null,
  };
}

/**
 * Reads the recorded state from `GET /api/accounts/antigravity` (it starts no
 * `agy`). With `autoProbe`, one check runs after the first read when `agy`
 * is installed and nothing has recorded its sign-in yet.
 */
export function useAntigravityAccount({ autoProbe = false }: { autoProbe?: boolean } = {}): AntigravityAccount {
  const [state, setState] = useState<{ cli: AntigravityCliPresence; auth: AntigravityAuth; plan: string | null; loaded: boolean }>({ cli: null, auth: "unknown", plan: null, loaded: false });
  const [probing, setProbing] = useState(false);
  const [inconclusive, setInconclusive] = useState(false);
  const probeBusy = useRef(false);
  const autoProbed = useRef(false);

  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/accounts/antigravity");
      if (!response.ok) return;
      const next = readSection(await response.json());
      if (next) setState({ ...next, loaded: true });
    } catch { /* the card stays as it was */ }
  }, []);

  const probe = useCallback(async () => {
    if (probeBusy.current) return;
    probeBusy.current = true;
    setProbing(true);
    try {
      const response = await fetch("/api/accounts/antigravity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "probe" }),
      });
      const body: unknown = response.ok ? await response.json().catch(() => null) : null;
      const next = readSection(body);
      if (next) {
        setState({ ...next, loaded: true });
        setInconclusive((body as { probe?: { inconclusive?: unknown } }).probe?.inconclusive === true);
      } else {
        setInconclusive(true);
      }
    } catch {
      setInconclusive(true);
    } finally {
      probeBusy.current = false;
      setProbing(false);
      window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
    }
  }, []);

  useEffect(() => {
    const onChanged = () => { void reload(); };
    window.addEventListener(AUTH_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, onChanged);
  }, [reload]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- reads the recorded state once on mount; the answer lands after the fetch.
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    if (!autoProbe || autoProbed.current || !state.loaded) return;
    if (state.cli === "found" && state.auth === "unknown") {
      autoProbed.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the one automatic check starts here; its state changes follow the request.
      void probe();
    }
  }, [autoProbe, state, probe]);

  return { ...state, probing, inconclusive, probe, reload };
}

/** The state `data-engine-state` carries, from the same facts every surface reads. */
export function antigravityCardState(agy: Pick<AntigravityAccount, "cli" | "auth" | "loaded">, cli: AntigravityCliPresence = agy.cli): "loading" | "missing" | "connected" | "signed-out" | "unknown" {
  if (cli === "missing") return "missing";
  if (!agy.loaded && cli === null) return "loading";
  if (cli === "found" && agy.auth === "signed_in") return "connected";
  return agy.auth === "signed_out" ? "signed-out" : "unknown";
}

/** The sign-in block of a card whose `agy` is installed: the sentence, the command with its copy control, and the check. */
export function AntigravitySignIn({ agy }: { agy: AntigravityAccount }) {
  const { t } = useLocale();
  return (
    <div data-antigravity-signin="" className="flex min-w-0 flex-col gap-1.5">
      <p className="text-ui text-secondary">{t("onboarding.engines.agySignin")}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1">
          <code data-antigravity-command="" className="rounded-[6px] bg-sunken px-2 py-1 font-mono text-ui text-primary">agy</code>
          <CopyButton text="agy" label={t("tools.copyCommand")} />
        </span>
        <button
          type="button"
          data-antigravity-check=""
          disabled={agy.probing}
          onClick={() => void agy.probe()}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[8px] border border-border bg-canvas px-2.5 text-ui font-semibold text-primary hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-70 max-sm:h-11"
        >
          {agy.probing ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {agy.probing ? t("onboarding.engines.checking") : t("onboarding.engines.checkSignin")}
        </button>
      </div>
      {agy.inconclusive && !agy.probing ? <p role="status" data-antigravity-inconclusive="" className="text-ui text-warning">{t("onboarding.engines.checkInconclusive")}</p> : null}
    </div>
  );
}

/** The state line a card or a row reads: Not installed, Connected · tier, Installed signed out, Could not check. */
export function antigravityStateLine(t: ReturnType<typeof useLocale>["t"], state: ReturnType<typeof antigravityCardState>, plan: string | null): string | null {
  if (state === "loading") return null;
  if (state === "missing") return t("onboarding.engines.missing");
  if (state === "connected") return plan ? t("onboarding.engines.connected", { plan }) : t("onboarding.engines.connectedNoPlan");
  return state === "signed-out" ? t("onboarding.engines.signedOut") : t("onboarding.engines.authUnknown");
}

/** The body shared by the footer popover and the phone accounts screen: state line and the action it calls for. */
export function AntigravityBody({ agy }: { agy: AntigravityAccount }) {
  const state = antigravityCardState(agy);
  const { t } = useLocale();
  const line = antigravityStateLine(t, state, agy.plan);
  const tone = state === "connected" ? "text-success" : state === "missing" ? "text-danger" : "text-warning";
  return (
    <div data-antigravity-body="" data-engine-state={state} className="flex min-w-0 flex-col gap-2">
      <span data-onboarding-engine-header="" className={`text-ui ${tone}`}>{line}</span>
      {state === "missing" ? (
        <>
          <InstallCommand engine="antigravity" install={ANTIGRAVITY_INSTALL_COMMAND} />
          <div><RecheckButton onClick={() => void agy.reload()} /></div>
        </>
      ) : state === "signed-out" || state === "unknown" ? <AntigravitySignIn agy={agy} /> : null}
    </div>
  );
}

export function AntigravityCard({ agy, cli, recheck }: { agy: AntigravityAccount; cli: AntigravityCliPresence; recheck: (() => void) | null }) {
  const { t } = useLocale();
  const state = antigravityCardState(agy, cli);
  const loading = state === "loading";
  const missing = state === "missing";
  const stateLine = antigravityStateLine(t, state, agy.plan);
  const tone = state === "connected" ? "text-success" : missing ? "text-danger" : "text-warning";
  return (
    <div
      data-onboarding-engine="antigravity"
      data-engine-state={state}
      /* A card that still needs an action goes first in one column, as the other cards do. */
      className={`flex min-w-0 flex-col gap-2 rounded-[12px] border border-border bg-card p-3${loading || state === "connected" ? "" : " max-[859px]:order-first"}`}
      style={{ borderLeft: `3px solid ${engineTintOf("antigravity").color}` }}
    >
      {loading ? (
        <div className="h-14 animate-pulse rounded-[8px] bg-sunken motion-reduce:animate-none" aria-busy />
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2">
          <EngineMark engine="antigravity" size={18} />
          <span className="flex min-w-0 flex-[1_1_9rem] flex-col">
            <span className="text-body font-semibold text-primary">Antigravity</span>
            <span data-onboarding-engine-header="" className={`text-ui ${tone}`}>{stateLine}</span>
          </span>
          {recheck ? <RecheckButton onClick={recheck} /> : null}
        </div>
      )}
      {missing ? <InstallCommand engine="antigravity" install={ANTIGRAVITY_INSTALL_COMMAND} /> : null}
      {state === "signed-out" || state === "unknown" ? <AntigravitySignIn agy={agy} /> : null}
    </div>
  );
}
