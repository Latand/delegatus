"use client";

import { AudioLines, Brain, ChevronRight, ListChecks, Lock, MessageCircleQuestion, Mic, Volume2, type LucideIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { SettingSwitch } from "@/components/ProjectSettingRow";
import { KEYS_CHANGED_EVENT, openKeys, serviceSettled } from "@/components/keys/openKeys";
import { useVoiceCompanionSettings } from "@/hooks/useVoiceCompanionSettings";
import { invalidateLiveToken } from "@/hooks/useDictation";
import { useLocale, type MessageKey } from "@/lib/i18n";
import { KEY_PROVIDER_NAME, type KeyId, type KeySource } from "@/lib/keys/shared";

/*
 * What a saved OpenAI key serves (docs/design/openai-key-services.md, variant 3):
 * under the OpenAI row of «Keys», the six features naming the provider each
 * one runs on now, and for each its own page, where OpenAI is one more choice
 * in that feature's list. Both read `GET /api/openai-services`, the same
 * resolution the dispatching routes use, so what a row names is what the next
 * request goes to. Saving a key moves nothing; only a choice here does.
 */

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
/* A row inside a group opened in place hangs from one rule at its left (HeaderMenu's WITHIN). */
const WITHIN = "shadow-[inset_2px_0_0_var(--border-default)]";

type Size = "menu" | "sheet";
type T = ReturnType<typeof useLocale>["t"];

export const SERVICE_FEATURES = ["asks", "memory", "rules", "dictation", "read", "voice"] as const;
export type ServiceFeature = typeof SERVICE_FEATURES[number];
export interface ServiceOption { id: string; available: boolean }
/** One feature as the route answers it: the policy's resolution without its credential, and the feature's choices. */
export interface ServiceState {
  feature: ServiceFeature;
  requested: string;
  effective: string;
  held: boolean;
  available: boolean;
  lockedBy: string | null;
  options: ServiceOption[];
}
export interface ServicesView { openaiKey: KeySource; features: ServiceState[] }

const ICON: Record<ServiceFeature, LucideIcon> = { asks: MessageCircleQuestion, memory: Brain, rules: ListChecks, dictation: Mic, read: Volume2, voice: AudioLines };
const NAME: Record<ServiceFeature, MessageKey> = {
  asks: "asksYou.label", memory: "openaiServices.feature.memory", rules: "roleMemory.row",
  dictation: "onboarding.voiceTitle", read: "openaiServices.feature.read", voice: "voiceCompanion.settings.label",
};
const WHAT: Record<ServiceFeature, MessageKey> = {
  asks: "openaiServices.what.asks", memory: "openaiServices.what.memory", rules: "openaiServices.what.rules",
  dictation: "openaiServices.what.dictation", read: "openaiServices.what.read", voice: "openaiServices.what.voice",
};
/* The sentence each feature's own menu shows when its variable fixes the choice. */
const LOCKED: Partial<Record<ServiceFeature, MessageKey>> = { dictation: "onboarding.voice.locked", read: "tts.menuLocked" };

export const featureName = (t: T, feature: ServiceFeature) => t(NAME[feature]);
const openaiId = (feature: ServiceFeature) => feature === "voice" ? "api" : "openai";
const keyProvider = (id: string): id is Exclude<KeyId, "telegram"> => Object.hasOwn(KEY_PROVIDER_NAME, id);

/** A provider's own name, as a row names the one serving a feature now. */
export function providerName(t: T, id: string): string {
  if (id === "api") return KEY_PROVIDER_NAME.openai;
  if (id === "codex") return "Codex V3";
  if (id === "local") return t("stt.local.name");
  if (id === "chatgpt") return t("stt.chatgpt.name");
  return keyProvider(id) ? KEY_PROVIDER_NAME[id] : id;
}

function isView(value: unknown): value is ServicesView {
  const view = value as ServicesView | null;
  return Boolean(view) && typeof view!.openaiKey === "string" && Array.isArray(view!.features)
    && view!.features.every((state) => (SERVICE_FEATURES as readonly string[]).includes(state?.feature) && typeof state.effective === "string" && Array.isArray(state.options));
}

/*
 * The route's answer, kept once for the whole page so it outlives the feature
 * page that made a choice: «Back» unmounts that page, and the Keys list or the
 * page opened again reads the same choices, pending ones included. A choice
 * shows at once; the server's answer replaces it, and a refusal puts back the
 * last state the server confirmed while newer choices still show. Choices are
 * sent one after another from one queue, whichever page pressed them, so the
 * server keeps the last one pressed. A read is adopted only when no choice was
 * sent or settled since it began and none is on its way; one skipped for that
 * reason runs again once the queue empties. Each settled choice is announced,
 * so the readers outside this store that name a provider read again.
 */
interface Pending { feature: ServiceFeature; provider: string }
interface Snapshot { view: ServicesView | null; failed: boolean }
const store = {
  snapshot: { view: null, failed: false } as Snapshot,
  confirmed: null as ServicesView | null,
  pending: [] as Pending[],
  /* Bumped by every choice sent and every one settled: a read that saw another value is older than the screen. */
  epoch: 0,
  reads: 0,
  adopted: 0,
  stale: false,
  queue: Promise.resolve() as Promise<unknown>,
  listeners: new Set<() => void>(),
};

function publish(next: Partial<Snapshot>) {
  store.snapshot = { ...store.snapshot, ...next };
  for (const listener of store.listeners) listener();
}
const chosen = (view: ServicesView, { feature, provider }: Pending): ServicesView => ({
  ...view, features: view.features.map((state) => state.feature === feature ? { ...state, requested: provider, effective: provider, held: false, available: true } : state),
});
/** The confirmed state with every choice still on its way laid over it, in the order pressed. */
const shown = () => store.confirmed && store.pending.reduce(chosen, store.confirmed);

async function loadServices(): Promise<void> {
  if (store.pending.length) { store.stale = true; return; }
  const began = store.epoch;
  const mine = ++store.reads;
  try {
    const response = await fetch("/api/openai-services", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isView(body)) throw new Error("unreadable answer");
    if (store.epoch !== began || store.pending.length || mine < store.adopted) return;
    store.adopted = mine;
    store.confirmed = body;
    publish({ view: body, failed: false });
  } catch {
    if (store.epoch === began && !store.pending.length && mine >= store.adopted) publish({ failed: true });
  }
}

/** Moves one feature to `provider`; true once the server kept it. */
function chooseService(feature: ServiceFeature, provider: string): Promise<boolean> {
  if (feature === "dictation") invalidateLiveToken();
  const mine: Pending = { feature, provider };
  store.epoch++;
  store.pending.push(mine);
  publish({ view: shown() });
  const write = store.queue.then(async () => {
    let kept = false;
    try {
      const response = await fetch("/api/openai-services", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ feature, provider }), cache: "no-store" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isView(body)) throw new Error(`HTTP ${response.status}`);
      store.confirmed = body;
      kept = true;
    } catch { /* the confirmed state stays */ }
    store.pending = store.pending.filter((entry) => entry !== mine);
    store.epoch++;
    publish({ view: shown(), failed: false });
    if (feature === "dictation") invalidateLiveToken();
    /* The memory page and «Asks you» stay mounted across the menu's pages and name their provider themselves. */
    serviceSettled(feature);
    if (!store.pending.length && store.stale) { store.stale = false; void loadServices(); }
    return kept;
  });
  store.queue = write;
  return write;
}

function onKeysChanged() { void loadServices(); }
function subscribe(listener: () => void) {
  if (store.listeners.size === 0) window.addEventListener(KEYS_CHANGED_EVENT, onKeysChanged);
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0) window.removeEventListener(KEYS_CHANGED_EVENT, onKeysChanged);
  };
}
const read = () => store.snapshot;
const SERVER_SNAPSHOT: Snapshot = { view: null, failed: false };

/** Forgets every answer and choice; a test's next page starts as a fresh load would. */
export function resetOpenAiServicesForTests() {
  Object.assign(store, { snapshot: SERVER_SNAPSHOT, confirmed: null, pending: [], epoch: 0, reads: 0, adopted: 0, stale: false, queue: Promise.resolve() });
}

/** The shared answer and the way to change it; every mount reads the route again, as a page that opens always has. */
export function useOpenAiServices() {
  const { view, failed } = useSyncExternalStore(subscribe, read, () => SERVER_SNAPSHOT);
  useEffect(() => { void loadServices(); }, []);
  return { view, failed, choose: chooseService };
}

/* ---- The list under the OpenAI row ------------------------------------- */

/** The six features under the OpenAI key; absent when the route refuses (a team member) or cannot be read. */
export function OpenAiServicesList({ size = "menu", onOpen }: { size?: Size; onOpen: (feature: ServiceFeature) => void }) {
  const { t } = useLocale();
  const { view } = useOpenAiServices();
  if (!view) return null;
  const sheet = size === "sheet";
  const small = sheet ? "text-label leading-4" : "text-[11px] leading-[14px]";
  const row = sheet
    ? "flex min-h-11 w-full items-center gap-3 px-4 py-1 text-left text-body font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
    : `flex w-full min-h-[30px] items-center gap-2 rounded-[8px] px-2 py-1 text-left text-[12px] font-semibold text-primary hover:bg-sunken ${FOCUS}`;
  const keySaved = view.openaiKey === "file" || view.openaiKey === "env";
  return (
    /* On the phone the list hangs from the OpenAI row's name column; its chevrons end on the ⋯ glyph's edge. */
    <div data-openai-services="" role="group" aria-label={t("openaiServices.group")} className={`${sheet ? "mb-2 ml-[52px] mr-4" : "mb-1 ml-2 mr-1"} ${WITHIN} flex flex-col`}>
      <p className={`font-semibold text-secondary ${sheet ? "px-4 pt-1 text-label" : "px-2 pt-0.5 text-[11px] leading-[14px]"}`}>{t("openaiServices.group")}</p>
      {view.features.map((state) => {
        const Icon = ICON[state.feature];
        const now = providerName(t, state.effective);
        return (
          <button key={state.feature} type="button" data-openai-service={state.feature} data-held={state.held ? "" : undefined} className={row} onClick={() => onOpen(state.feature)}>
            <Icon className={sheet ? "h-[18px] w-[18px] shrink-0 text-secondary" : "h-4 w-4 shrink-0 text-secondary"} aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="truncate leading-4">{featureName(t, state.feature)}</span>
              <span data-openai-service-now="" className={`font-medium ${state.held ? "text-warning" : "truncate text-muted"} ${small}`}>
                {state.held ? t("openaiServices.noKey", { name: now }) : now}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          </button>
        );
      })}
      {keySaved ? (
        <div data-openai-services-codex="" className={`mt-1 border-t border-border ${sheet ? "mx-4 pb-1 pt-2" : "mx-2 pb-0.5 pt-1.5"}`}>
          <p className={`font-medium text-muted ${small}`}>{t("openaiServices.codex")}</p>
        </div>
      ) : null}
    </div>
  );
}

/* ---- One feature's page ------------------------------------------------- */

interface OptionWords { name: string; note: string }

function optionWords(t: T, feature: ServiceFeature, id: string): OptionWords {
  if (feature === "dictation") {
    if (id === "local" || id === "chatgpt" || id === "elevenlabs" || id === "soniox") return { name: t(`onboarding.voice.name.${id}`), note: t(`onboarding.voice.note.${id}`) };
    return { name: providerName(t, id), note: t("openaiServices.note.dictation") };
  }
  if (feature === "voice") {
    return id === "codex"
      ? { name: t("voiceCompanion.settings.backend.codex"), note: t("openaiServices.note.codex") }
      : { name: t("voiceCompanion.settings.backend.api"), note: t("openaiServices.note.voiceApi") };
  }
  const name = providerName(t, id);
  return { name, note: t("openaiServices.keyNote", { name }) };
}

/** Why an option cannot be taken now, or null when it can. */
function unavailableReason(t: T, feature: ServiceFeature, option: ServiceOption): string | null {
  if (option.available) return null;
  if (option.id === "local") return t("onboarding.voice.localMissing");
  if (option.id === "chatgpt" || option.id === "codex") return t("openaiServices.noCodex");
  return t("openaiServices.noKeyYet", { name: providerName(t, option.id === "api" ? "openai" : option.id) });
}

function OptionRow({ feature, state, option, size, locked, onChoose }: {
  feature: ServiceFeature; state: ServiceState; option: ServiceOption; size: Size; locked: boolean; onChoose: (id: string) => void;
}) {
  const { t } = useLocale();
  const sheet = size === "sheet";
  const words = optionWords(t, feature, option.id);
  const selected = state.effective === option.id;
  const openai = option.id === openaiId(feature);
  /* The one OpenAI choice the operator made before the key went: it waits, amber, for a key. */
  const held = openai && state.held;
  const reason = held ? t("openaiServices.held") : unavailableReason(t, feature, option);
  const disabled = locked || !option.available;
  const small = sheet ? "text-label leading-4" : "text-[11px] leading-[14px]";
  /* «Add the key» sits beside the radio's label on the phone, under it in the 232 px panel, never inside the label. */
  const addKey = openai && !option.available ? (
    <button type="button" data-openai-add-key="" onClick={() => openKeys("openai")}
      className={`shrink-0 self-start rounded-[6px] font-semibold text-accent hover:underline ${FOCUS} ${sheet ? "min-h-11 px-1 text-label" : "ml-6 min-h-6 text-[11px]"}`}>
      {t("openaiServices.addKey")}
    </button>
  ) : null;
  return (
    <div data-openai-option={option.id} data-selected={selected ? "" : undefined}
      className={`flex border-b border-border last:border-b-0 ${sheet ? "items-center gap-1 px-3 py-1.5" : "flex-col px-2 py-1.5"} ${selected ? "bg-accent-soft/40" : "bg-card"}`}>
      <label className={`flex min-w-0 flex-1 gap-2 ${sheet ? "min-h-11 items-center" : "min-h-6 items-start"} ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
        <input type="radio" name={`openai-service-${feature}`} value={option.id} checked={selected} disabled={disabled}
          onChange={() => onChoose(option.id)}
          onClick={() => { if (selected && state.held) onChoose(option.id); }}
          className={`shrink-0 accent-[var(--color-accent)] ${sheet ? "h-5 w-5" : "mt-0.5 h-4 w-4"} ${disabled ? "opacity-50" : ""}`} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={`font-semibold ${disabled ? "text-muted" : "text-primary"} ${sheet ? "text-body leading-5" : "text-[12px] leading-4"}`}>{words.name}</span>
          <span className={`text-secondary ${small}`}>{words.note}</span>
          {reason ? <span data-openai-option-reason={held ? "held" : "unavailable"} className={`font-medium ${held ? "text-warning" : "text-muted"} ${small}`}>{reason}</span> : null}
        </span>
      </label>
      {addKey}
    </div>
  );
}

/** Voice Delegatus's own «Show the voice» switch, through the voice settings' route. */
function VoiceEnable({ size }: { size: Size }) {
  const { t } = useLocale();
  const { settings, update } = useVoiceCompanionSettings(true);
  const sheet = size === "sheet";
  return (
    <div className={`flex items-center gap-2 ${sheet ? "min-h-11" : "min-h-8"}`}>
      <span className={`min-w-0 flex-1 font-semibold text-primary ${sheet ? "text-body" : "text-[12px]"}`}>{t("voiceCompanion.settings.enable")}</span>
      <SettingSwitch enabled={settings?.enabled ?? false} disabled={!settings} size={sheet ? "sheet" : "row"} aria-label={t("voiceCompanion.settings.enable")} data-openai-voice-enable=""
        onClick={() => { if (settings) void update({ enabled: !settings.enabled }); }} />
    </div>
  );
}

/** One feature's page under «Keys»: what it does, what serves it now, and its choices with OpenAI last. */
export function OpenAiFeaturePage({ feature, size = "menu" }: { feature: ServiceFeature; size?: Size }) {
  const { t } = useLocale();
  const { view, failed, choose } = useOpenAiServices();
  const [error, setError] = useState(false);
  const sheet = size === "sheet";
  const state = view?.features.find((candidate) => candidate.feature === feature) ?? null;
  const line = sheet ? "text-body" : "text-[12px] leading-4";
  const groupLabel = feature === "dictation" ? t("onboarding.voice.heading") : feature === "voice" ? t("voiceCompanion.settings.backend") : t("openaiServices.whoServes");
  const pick = async (id: string) => {
    if (!state || state.lockedBy || (id === state.effective && !state.held)) return;
    setError(false);
    if (!await choose(feature, id)) setError(true);
  };
  const locked = Boolean(state?.lockedBy);
  const lockSentence = LOCKED[feature];
  return (
    <div data-openai-feature-page={feature} className={`flex flex-col font-normal ${sheet ? "gap-2 px-4 pb-4 pt-2" : "gap-1.5 px-2 pb-1.5 pt-2"}`}>
      <p className={`font-medium text-muted ${sheet ? "text-label leading-4" : "text-[11px] leading-[14px]"}`}>{t(WHAT[feature])}</p>
      {failed && !view ? <p role="alert" data-openai-feature-failed="" className={`leading-snug text-danger ${sheet ? "text-label" : "text-[11px]"}`}>{t("keys.loadFailed")}</p> : null}
      {state ? (
        <>
          <p data-openai-feature-now="" className={`font-semibold text-primary ${line}`}>{t("openaiServices.now", { name: providerName(t, state.effective) })}</p>
          {locked && lockSentence ? (
            <p data-openai-feature-locked="" className={`flex items-center gap-2 rounded-[8px] bg-sunken text-secondary ${sheet ? "px-3 py-2 text-label" : "px-2 py-1.5 text-[11px] leading-[14px]"}`}>
              <Lock className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
              {t(lockSentence)}
            </p>
          ) : null}
          {feature === "voice" ? <VoiceEnable size={size} /> : null}
          <p className={`font-semibold text-primary ${line}`}>{groupLabel}</p>
          <div role="radiogroup" aria-label={groupLabel} className="flex flex-col overflow-hidden rounded-[12px] border border-border">
            {state.options.map((option) => <OptionRow key={option.id} feature={feature} state={state} option={option} size={size} locked={locked} onChoose={(id) => void pick(id)} />)}
          </div>
          {error ? <p role="alert" data-openai-feature-error="" className={`w-full leading-snug text-danger ${sheet ? "text-label" : "text-[11px]"}`}>{t("openaiServices.saveFailed")}</p> : null}
        </>
      ) : null}
    </div>
  );
}
