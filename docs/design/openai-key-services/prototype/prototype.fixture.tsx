"use client";

/*
 * Prototype: what a saved OpenAI key serves (docs/design/openai-key-services.md,
 * «Prototype handoff» and «Prototype summary»). Three numbered variants of
 * where the per-feature provider choice lives, drawn on the real Settings →
 * Keys page: the product's `KeysMenuPage` (its rows, dots, notes, field and
 * optimistic save), `SettingSwitch` / `ProjectSettingRow`, the header menu's
 * 232 px panel recipe on the desktop and the real `MobileMenuSheet` on the
 * phone. The variant's own pieces are rendered next to the real rows through
 * a portal, so the Keys page itself is the product's, unchanged.
 *
 * The query string picks what is drawn:
 *   ?variant=1|2|3&lang=uk|en&theme=light|dark&state=none|saved|switched|removed&page=keys|who|<feature>
 * Every control on the page works: a switch or a choice moves that feature,
 * «Add» on the OpenAI row saves a typed key, «Add the key» goes back to the
 * Keys page with the OpenAI field open. Invented fixture data; no product code
 * changes; nothing leaves the page (`/api/keys` is answered here).
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { ArrowLeftRight, AudioLines, Brain, ChevronLeft, ChevronRight, ListChecks, MessageCircleQuestion, Mic, Volume2, type LucideIcon } from "lucide-react";

import { KeysMenuPage } from "@/components/keys/KeysSection";
import { MobileMenuSheet, type MobileMenuEntry } from "@/components/mobile/MobileMenuSheet";
import { ProjectSettingRow, SettingSwitch } from "@/components/ProjectSettingRow";
import { useCoarsePointer } from "@/hooks/useCoarsePointer";
import { setLocale, useLocale, type Locale } from "@/lib/i18n";
import { KEY_IDS, KEY_VARIABLE, maskKey, type KeyEntry, type KeyId, type KeysAnswer } from "@/lib/keys/shared";

/* ---------- what is drawn ---------- */

const params = new URLSearchParams(location.search);
const LANG: Locale = params.get("lang") === "en" ? "en" : "uk";
const THEME = params.get("theme") === "dark" ? "dark" : "light";
const VARIANT = ([1, 2, 3] as const).find((n) => String(n) === params.get("variant")) ?? 1;
type State = "none" | "saved" | "switched" | "removed";
const STATE: State = (["none", "saved", "switched", "removed"] as const).find((name) => name === params.get("state")) ?? "saved";

document.documentElement.dataset.theme = THEME;
document.documentElement.lang = LANG;
try { localStorage.setItem("llv_lang", LANG); } catch { /* opaque origin */ }
setLocale(LANG);

/* A one-letter word never ends a line: it is glued to the word after it. */
const glue = (text: string) => text.replace(/(^|[\s(«])([A-Za-zА-ЩЬЮЯЄІЇҐа-щьюяєіїґ])\s/g, "$1$2 ");
const L = (en: string, uk: string) => glue(LANG === "uk" ? uk : en);

/* ---------- the invented installation ---------- */

type FeatureId = "asks" | "memory" | "rules" | "dictation" | "read" | "voice";

interface Option { id: string; name: string; note: string; disabled?: string }
interface Feature {
  id: FeatureId;
  icon: LucideIcon;
  name: string;
  /** One muted line about what it does, shown on its own settings page. */
  what: string;
  /** The provider choices its own settings have today, OpenAI last. */
  options: Option[];
}

const OPENAI = "OpenAI";
const keyNote = (name: string) => L(`${name} key`, `ключ ${name}`);

const FEATURES: Feature[] = [
  {
    id: "asks", icon: MessageCircleQuestion, name: L("Asks you", "Питає вас"),
    what: L("Spots the moment an agent waits for your answer.", "Помічає, коли агент чекає на вашу відповідь."),
    options: [{ id: "OpenRouter", name: "OpenRouter", note: keyNote("OpenRouter") }, { id: OPENAI, name: OPENAI, note: keyNote(OPENAI) }],
  },
  {
    id: "memory", icon: Brain, name: L("Memory in chats", "Пам’ять у розмовах"),
    what: L("Picks memories to add to your messages.", "Добирає спогади до ваших повідомлень."),
    options: [{ id: "OpenRouter", name: "OpenRouter", note: keyNote("OpenRouter") }, { id: OPENAI, name: OPENAI, note: keyNote(OPENAI) }],
  },
  {
    id: "rules", icon: ListChecks, name: L("Learned rules", "Вивчені правила"),
    what: L("Scores rules for new agents. A trial for now: agents still get every rule.", "Оцінює правила для нових агентів. Поки пробно: агенти отримують усі правила."),
    options: [{ id: "OpenRouter", name: "OpenRouter", note: keyNote("OpenRouter") }, { id: OPENAI, name: OPENAI, note: keyNote(OPENAI) }],
  },
  {
    id: "dictation", icon: Mic, name: L("Dictation", "Диктування"),
    what: L("The microphone in the message field: a recording and live text.", "Мікрофон у полі вводу: запис і живий текст."),
    options: [], // the onboarding step's names, read through the product's own messages below
  },
  {
    id: "read", icon: Volume2, name: L("Read aloud", "Читання вголос"),
    what: L("Reads an agent's answer out loud.", "Читає відповідь агента вголос."),
    options: [
      { id: "ElevenLabs", name: "ElevenLabs", note: keyNote("ElevenLabs") },
      { id: "Soniox", name: "Soniox", note: keyNote("Soniox") },
      { id: "Fish Audio", name: "Fish Audio", note: keyNote("Fish Audio"), disabled: L("No Fish Audio key yet", "Ключа Fish Audio ще немає") },
      { id: OPENAI, name: OPENAI, note: keyNote(OPENAI) },
    ],
  },
  {
    id: "voice", icon: AudioLines, name: L("Voice Delegatus", "Голосовий Delegatus"),
    what: L("Calls with Delegatus and the tools it uses in them.", "Дзвінки з Delegatus та інструменти, якими він у них користується."),
    options: [], // the voice settings' own two backends, read through the product's messages below
  },
];

/* What each feature uses on this installation before OpenAI: read aloud and dictation have non-default choices. */
const BASE: Record<FeatureId, string> = { asks: "OpenRouter", memory: "OpenRouter", rules: "OpenRouter", dictation: "Soniox", read: "ElevenLabs", voice: "Codex V3" };

/* ---------- the prototype's state: one store the variants and the stubbed routes share ---------- */

type Page = "keys" | "who" | FeatureId;
interface Proto {
  keySaved: boolean;
  /** Features the operator moved to OpenAI; kept while the key is gone, so a saved key brings them back. */
  chosen: ReadonlySet<FeatureId>;
  base: Record<FeatureId, string>;
  page: Page;
  focus: { key: KeyId | null; seq: number };
  openDot: FeatureId | null;
}

const isFeature = (value: string | null): value is FeatureId => FEATURES.some((feature) => feature.id === value);
const pageParam = params.get("page");
let proto: Proto = {
  keySaved: STATE === "saved" || STATE === "switched",
  chosen: new Set<FeatureId>(STATE === "switched" || STATE === "removed" ? ["asks", "dictation", "voice"] : []),
  base: { ...BASE },
  page: pageParam === "who" || isFeature(pageParam) ? pageParam : "keys",
  focus: { key: null, seq: 0 },
  openDot: null,
};
const listeners = new Set<() => void>();
const update = (next: Partial<Proto>) => { proto = { ...proto, ...next }; for (const listener of listeners) listener(); };
const useProto = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => proto);

const effective = (state: Proto, id: FeatureId) => state.keySaved && state.chosen.has(id) ? OPENAI : state.base[id];
/** Chosen for OpenAI while the key is gone: the feature runs on its previous provider until the key is back. */
const waiting = (state: Proto, id: FeatureId) => !state.keySaved && state.chosen.has(id);
const choose = (id: FeatureId, provider: string) => {
  const chosen = new Set(proto.chosen);
  if (provider === OPENAI) chosen.add(id);
  else { chosen.delete(id); }
  update({ chosen, base: provider === OPENAI ? proto.base : { ...proto.base, [id]: provider }, openDot: null });
};
const openKeyField = () => update({ page: "keys", focus: { key: "openai", seq: proto.focus.seq + 1 }, openDot: null });

/* Placeholder keys, runs of one digit with an invented tail, built at run time: a row shows only the masked tail. */
const VALUES: Partial<Record<KeyId, string>> = {
  openrouter: ["sk", "or", "v1", `${"0".repeat(60)}7f3c`].join("-"),
  openai: ["sk", "proj", `${"2".repeat(44)}a91e`].join("-"),
  elevenlabs: `sk_${"1".repeat(44)}5d20`,
  soniox: `${"4".repeat(60)}c3b8`,
  telegram: `${"7".repeat(9)}:${"6".repeat(31)}Qm4x`,
};
const keysAnswer = (): KeysAnswer => ({
  staging: false,
  owner: true,
  keys: KEY_IDS.map((id): KeyEntry => {
    const value = id === "openai" ? (proto.keySaved ? VALUES.openai : undefined) : VALUES[id];
    return { id, variable: KEY_VARIABLE[id], source: value ? "file" : "missing", masked: value ? maskKey(id, value) : null };
  }),
});

const nativeFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.pathname === "/api/keys") return Response.json(keysAnswer());
  if (url.pathname === "/api/keys/openai" && init?.method === "PUT") {
    update({ keySaved: true });
    return Response.json(keysAnswer());
  }
  /* Revealing or copying a value is the real page's own business; the prototype holds none. */
  if (url.pathname.startsWith("/api/keys/")) return Response.json({ error: "prototype" }, { status: 403 });
  return nativeFetch(input, init);
}) as typeof window.fetch;

/* ---------- placing a variant's piece beside the real rows ---------- */

/** A node of the prototype's own placed next to an element of the real page, found again whenever the page redraws it. */
function useSlot(name: string, find: () => Element | null, place: (target: Element, slot: HTMLElement) => void) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const element = document.createElement("div");
    element.dataset.protoSlot = name;
    let target: Element | null = null;
    const check = () => {
      const found = find();
      if (!found) { target = null; element.remove(); return; }
      if (found !== target || !element.isConnected) { target = found; place(found, element); setSlot(element); }
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); element.remove(); };
  }, [name, find, place]);
  return slot;
}

const afterOpenAiRow = { find: () => document.querySelector('[data-keys-row="openai"]'), place: (target: Element, slot: HTMLElement) => target.after(slot) };
const afterImportRow = { find: () => document.querySelector("[data-keys-open-import]"), place: (target: Element, slot: HTMLElement) => target.after(slot) };

/* ---------- shared pieces, on the product's recipes ---------- */

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
/* A row inside a group opened in place hangs from one rule at its left (HeaderMenu's WITHIN). */
const WITHIN = "shadow-[inset_2px_0_0_var(--border-default)]";

function useSheet() {
  return useCoarsePointer();
}

/** The Keys page's own small muted line. */
function Muted({ children, data }: { children: ReactNode; data?: Record<string, string> }) {
  const sheet = useSheet();
  return <p {...data} className={`font-medium text-muted ${sheet ? "text-label leading-4" : "text-[11px] leading-[14px]"}`}>{children}</p>;
}

/** The Keys page's notice box (its staging and member notices), with one action under the words. */
function Notice({ text, action }: { text: string; action?: { label: string; run: () => void } }) {
  const sheet = useSheet();
  const state = useProto();
  /* With a dot's note open, the note is what the frame is about. */
  return (
    <div data-proto-notice="" data-proto-defining={state.openDot ? undefined : ""} className={`flex flex-col items-start gap-1.5 rounded-control bg-sunken text-secondary ${sheet ? "px-3 py-2.5 text-body" : "px-2 py-1.5 text-[11.5px] leading-snug"}`}>
      <span>{text}</span>
      {action ? (
        <button type="button" data-proto-add-key="" onClick={action.run}
          className={`rounded-control border border-border bg-card px-2.5 font-semibold text-primary hover:bg-sunken ${FOCUS} ${sheet ? "min-h-11 text-body" : "h-7 text-[11.5px]"}`}>{action.label}</button>
      ) : null}
    </div>
  );
}

/** The Keys row's dot (KeysSection's StatusDot): a dot whose short note opens in the row's flow, under its line. */
function Dot({ id, tone, label }: { id: FeatureId; tone: "ok" | "waiting"; label: string }) {
  const sheet = useSheet();
  const state = useProto();
  const open = state.openDot === id;
  return (
    <button type="button" data-proto-dot={id} aria-label={label} aria-expanded={open} onClick={() => update({ openDot: open ? null : id })}
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full ${FOCUS} ${sheet ? "-ml-3 h-11 w-11" : "-ml-1 h-6 w-6"}`}>
      <span aria-hidden className={`h-[7px] w-[7px] rounded-full ${tone === "ok" ? "bg-success" : "bg-warning"}`} />
    </button>
  );
}

function DotNote({ id, text }: { id: FeatureId; text: string }) {
  const state = useProto();
  if (state.openDot !== id) return null;
  return <span role="tooltip" data-proto-popover="" data-proto-defining="" className="block rounded-control border border-border bg-raised px-2.5 py-1.5 text-label leading-4 text-primary shadow-1">{text}</span>;
}

/** The back row of a page of the menu, the panel's or the sheet's recipe (HeaderMenu's backRow). */
function BackRow({ title, onBack }: { title: string; onBack: () => void }) {
  const { t } = useLocale();
  const sheet = useSheet();
  return sheet ? (
    <button type="button" role="menuitem" data-mobile2-menu-row="back" onClick={onBack}
      className="flex min-h-11 w-full items-center gap-3 border-b border-border px-4 text-left text-body font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40">
      <ChevronLeft className="h-[18px] w-[18px] shrink-0 text-secondary" aria-hidden />
      <span className="shrink-0 text-secondary">{t("headerMenu.back")}</span>
      <span aria-hidden className="shrink-0 font-normal text-muted">·</span>
      <span data-proto-page-title="" className="min-w-0 flex-1 truncate font-bold">{title}</span>
    </button>
  ) : (
    <button type="button" data-rail-menu-back="" onClick={onBack}
      className={`mb-1 flex w-full min-h-[30px] items-center gap-1.5 rounded-t-[8px] border-b border-border px-2 py-1.5 text-left text-[12px] hover:bg-sunken ${FOCUS}`}>
      <ChevronLeft className="h-4 w-4 shrink-0 text-secondary" aria-hidden />
      <span className="shrink-0 font-semibold text-secondary">{t("headerMenu.back")}</span>
      <span aria-hidden className="shrink-0 text-muted">·</span>
      <span data-proto-page-title="" className="min-w-0 flex-1 truncate font-bold text-primary">{title}</span>
    </button>
  );
}

const CODEX_LINE = () => L("Codex agents keep signing in with their subscription.", "Агенти Codex і далі входять за підпискою.");

/* ---------- variant 1: switches under the OpenAI row ---------- */

function UnderOpenAiRow() {
  const sheet = useSheet();
  const state = useProto();
  const slot = useSlot("variant-1", afterOpenAiRow.find, afterOpenAiRow.place);
  if (!slot) return null;
  const rows = state.keySaved ? FEATURES : FEATURES.filter((feature) => waiting(state, feature.id));
  const box = sheet ? "ml-4 mr-4 mb-2" : "ml-2 mr-1 mb-1";
  const body = !state.keySaved && rows.length === 0 ? (
    <div className={`${box} ${WITHIN} ${sheet ? "px-4 py-1" : "px-2 py-0.5"}`}>
      <Muted data={{ "data-proto-defining": "" }}>{L("Add the key to choose what OpenAI serves.", "Додайте ключ, щоб вибрати, що обслуговує OpenAI.")}</Muted>
    </div>
  ) : (
    <div data-proto-group="" className={`${box} ${WITHIN} flex flex-col`}>
      <p data-proto-defining={state.keySaved ? undefined : ""} className={`font-semibold text-secondary ${sheet ? "px-4 pt-1 text-label" : "px-2 pt-0.5 text-[11px] leading-[14px]"}`}>
        {state.keySaved ? L("OpenAI serves", "Що обслуговує OpenAI") : L("Back to OpenAI with the key", "З ключем повернеться OpenAI")}
      </p>
      {rows.map((feature, index) => {
        const on = state.chosen.has(feature.id);
        const base = state.base[feature.id];
        const hint = !state.keySaved ? L(`No key, so ${base} serves it`, `Без ключа працює ${base}`)
          : on ? L(`Instead of ${base}`, `Замість ${base}`) : L(`Now ${base}`, `Зараз ${base}`);
        return (
          <ProjectSettingRow key={feature.id} label={feature.name} hint={hint} enabled={on} blocked={!state.keySaved} disabled={false} failed={false} variant={sheet ? "sheet" : "menu"}
            rowProps={{ "data-proto-feature": feature.id, ...(state.keySaved && (STATE === "switched" ? on && index === 0 : index === 0) ? { "data-proto-defining": "" } : {}) }}
            switchProps={{ "data-proto-switch": feature.id, onClick: () => choose(feature.id, on ? base : OPENAI) }} />
        );
      })}
      {state.keySaved ? <div className={sheet ? "px-4 pb-1" : "px-2 pb-0.5"}><Muted>{CODEX_LINE()}</Muted></div> : null}
    </div>
  );
  return createPortal(body, slot);
}

/* ---------- variant 2: one «who serves what» page ---------- */

const servedLine = (state: Proto) => {
  const served = FEATURES.filter((feature) => effective(state, feature.id) === OPENAI).length;
  return L(`OpenAI serves ${served} of ${FEATURES.length}`, `OpenAI обслуговує ${served} із ${FEATURES.length}`);
};

function WhoEntry() {
  const sheet = useSheet();
  const state = useProto();
  const slot = useSlot("variant-2", afterImportRow.find, afterImportRow.place);
  if (!slot) return null;
  const line = state.keySaved ? servedLine(state)
    : state.chosen.size ? L("The OpenAI key is gone", "Ключа OpenAI немає") : L("No OpenAI key yet", "Ключа OpenAI ще немає");
  const row = sheet
    ? "flex min-h-11 w-full items-center gap-3 px-4 py-1 text-left text-body font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
    : `flex w-full min-h-[30px] items-center gap-2 rounded-control px-2 py-1 text-left text-[12px] font-semibold text-primary hover:bg-sunken ${FOCUS}`;
  return createPortal(
    <button type="button" data-proto-who-entry="" data-proto-defining="" className={row} onClick={() => update({ page: "who" })}>
      <ArrowLeftRight className={sheet ? "h-[18px] w-[18px] shrink-0 text-secondary" : "h-4 w-4 shrink-0 text-secondary"} aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate leading-4">{L("Who serves what", "Хто що обслуговує")}</span>
        <span className={`truncate font-medium text-muted ${sheet ? "text-label leading-4" : "text-[11px] leading-[14px]"}`}>{line}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
    </button>,
    slot,
  );
}

/** Two choices as one segmented control (the agent mapping's EngineSegments recipe), the row's whole width. */
function Segments({ feature }: { feature: Feature }) {
  const sheet = useSheet();
  const state = useProto();
  const now = effective(state, feature.id);
  const base = state.base[feature.id];
  return (
    <div role="radiogroup" aria-label={feature.name} data-proto-segments={feature.id} className={`flex w-full rounded-[8px] border border-border bg-sunken p-0.5 ${sheet ? "" : "h-8"}`}>
      {[base, OPENAI].map((provider) => {
        const checked = now === provider;
        const refused = provider === OPENAI && !state.keySaved;
        return (
          <button key={provider} type="button" role="radio" aria-checked={checked} disabled={refused} data-proto-choice={provider}
            title={refused ? L("Add the OpenAI key first", "Спершу додайте ключ OpenAI") : provider}
            onClick={() => { if (!checked && !refused) choose(feature.id, provider); }}
            className={`inline-flex min-w-0 flex-1 items-center justify-center rounded-[6px] px-1.5 font-semibold ${FOCUS} ${sheet ? "min-h-11 text-body" : "text-ui"} ${checked ? "bg-card text-primary shadow-1 ring-1 ring-inset ring-strong" : refused ? "cursor-not-allowed text-muted opacity-50" : "text-muted hover:text-primary"}`}>
            {provider}
          </button>
        );
      })}
    </div>
  );
}

function WhoPage() {
  const sheet = useSheet();
  const state = useProto();
  return (
    <div data-proto-who="" className={`flex flex-col ${sheet ? "gap-1 pb-4" : "gap-0.5 pb-1"}`}>
      {!state.keySaved ? (
        <div className={sheet ? "px-4 pb-1 pt-2" : "px-2 pb-1"}>
          <Notice text={state.chosen.size ? L("The OpenAI key was removed.", "Ключ OpenAI прибрано.") : L("There is no OpenAI key yet.", "Ключа OpenAI ще немає.")}
            action={{ label: L("Add the key", "Додати ключ"), run: openKeyField }} />
        </div>
      ) : (
        <div className={sheet ? "px-4 pt-2" : "px-2 pt-0.5"}><Muted data={{ "data-proto-served": "" }}>{servedLine(state)}</Muted></div>
      )}
      {FEATURES.map((feature, index) => {
        const now = effective(state, feature.id);
        const held = waiting(state, feature.id);
        const note = held ? L(`No OpenAI key, so ${now} serves it.`, `Ключа OpenAI немає, тому працює ${now}.`)
          : L(`${now} serves it.`, `Обслуговує ${now}.`);
        const defining = STATE === "switched" ? feature.id === "asks" : state.keySaved && index === 0;
        return (
          <div key={feature.id} data-proto-feature={feature.id} data-proto-defining={defining ? "" : undefined} className={`flex flex-col ${sheet ? "gap-1.5 px-4 py-1.5" : "gap-1 px-2 py-1"}`}>
            {/* On the phone the two choices stand beside the name; the 232 px panel puts them under it. */}
            <div className={`flex items-center gap-1 ${sheet ? "min-h-11" : "min-h-6"}`}>
              <Dot id={feature.id} tone={held ? "waiting" : "ok"} label={`${feature.name}: ${note}`} />
              <span className={`min-w-0 flex-1 font-semibold text-primary ${sheet ? "text-body leading-5" : "text-[12px] leading-4"}`}>{feature.name}</span>
              {sheet ? <div className="w-[196px] shrink-0"><Segments feature={feature} /></div> : null}
            </div>
            {sheet ? null : <Segments feature={feature} />}
            {feature.id === "dictation" ? <Muted>{L("Recording and live text", "Запис і живий текст")}</Muted> : null}
            {held ? <Muted>{L("OpenAI returns with the key", "З ключем повернеться OpenAI")}</Muted> : null}
            <DotNote id={feature.id} text={note} />
          </div>
        );
      })}
      <div className={`mt-1 border-t border-border ${sheet ? "px-4 pt-2" : "px-2 pt-1"}`}><Muted>{CODEX_LINE()}</Muted></div>
    </div>
  );
}

/* ---------- variant 3: the choice inside each feature's own settings ---------- */

function FeatureLinks() {
  const sheet = useSheet();
  const state = useProto();
  const slot = useSlot("variant-3", afterOpenAiRow.find, afterOpenAiRow.place);
  if (!slot) return null;
  const row = sheet
    ? "flex min-h-11 w-full items-center gap-3 px-4 py-1 text-left text-body font-semibold text-primary active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
    : `flex w-full min-h-[30px] items-center gap-2 rounded-[8px] px-2 py-1 text-left text-[12px] font-semibold text-primary hover:bg-sunken ${FOCUS}`;
  return createPortal(
    <div data-proto-group="" className={`${sheet ? "mx-4 mb-2" : "ml-2 mr-1 mb-1"} ${WITHIN} flex flex-col`}>
      <p data-proto-defining={STATE === "removed" ? undefined : ""} className={`font-semibold text-secondary ${sheet ? "px-4 pt-1 text-label" : "px-2 pt-0.5 text-[11px] leading-[14px]"}`}>
        {L("Choose OpenAI in each setting", "OpenAI вибирається в налаштуваннях")}
      </p>
      {FEATURES.map((feature) => {
        const now = effective(state, feature.id);
        const held = waiting(state, feature.id);
        const Icon = feature.icon;
        return (
          <button key={feature.id} type="button" data-proto-open={feature.id} data-proto-defining={STATE === "removed" && feature.id === "asks" ? "" : undefined} className={row} onClick={() => update({ page: feature.id })}>
            <Icon className={sheet ? "h-[18px] w-[18px] shrink-0 text-secondary" : "h-4 w-4 shrink-0 text-secondary"} aria-hidden />
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="truncate leading-4">{feature.name}</span>
              <span className={`font-medium ${held ? "text-warning" : "truncate text-muted"} ${sheet ? "text-label leading-4" : "text-[11px] leading-[14px]"}`}>
                {held ? L(`${now}, no key`, `${now}, без ключа`) : now}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          </button>
        );
      })}
    </div>,
    slot,
  );
}

/** One provider row of a feature's own settings: the onboarding dictation step's radio list recipe. */
function OptionRow({ feature, option, name }: { feature: Feature; option: Option; name: string }) {
  const sheet = useSheet();
  const state = useProto();
  const now = effective(state, feature.id);
  const selected = now === option.id;
  const openai = option.id === OPENAI;
  const refused = openai && !state.keySaved ? (state.chosen.has(feature.id) ? "removed" : "none") : null;
  const disabled = Boolean(refused) || Boolean(option.disabled);
  return (
    <div data-proto-option={option.id} data-proto-defining={openai ? "" : undefined} data-selected={selected ? "" : undefined}
      className={`flex flex-col gap-1.5 border-b border-border last:border-b-0 ${sheet ? "px-3 py-1.5" : "px-2 py-1.5"} ${selected ? "bg-accent-soft/40" : "bg-card"}`}>
      <label className={`flex items-start gap-2 ${sheet ? "min-h-11 items-center" : "min-h-6"} ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
        <input type="radio" name={name} value={option.id} checked={selected} disabled={disabled} onChange={() => choose(feature.id, option.id)}
          className={`shrink-0 accent-[var(--color-accent)] ${sheet ? "h-5 w-5" : "mt-0.5 h-4 w-4"} ${disabled ? "opacity-50" : ""}`} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={`font-semibold ${disabled ? "text-muted" : "text-primary"} ${sheet ? "text-body" : "text-[12px] leading-4"}`}>{option.name}</span>
          <span className={`text-secondary ${sheet ? "text-label" : "text-[11px] leading-[14px]"}`}>{option.note}</span>
        </span>
      </label>
      {refused === "none" ? (
        <button type="button" data-proto-add-key="" onClick={openKeyField}
          className={`self-start rounded-[6px] text-left font-semibold text-warning hover:underline ${FOCUS} ${sheet ? "-mt-2 ml-7 min-h-11 text-label" : "ml-6 min-h-6 text-[11px]"}`}>
          {L("Add the OpenAI key first", "Спершу додайте ключ OpenAI")}
        </button>
      ) : refused === "removed" ? (
        <div className={`flex flex-col items-start ${sheet ? "ml-7 text-label" : "ml-6 text-[11px] leading-[14px]"}`}>
          <span className="text-warning">{L(`The key was removed, so ${state.base[feature.id]} serves it. With the key, this choice returns.`, `Ключ прибрано, тому працює ${state.base[feature.id]}. З ключем цей вибір повернеться.`)}</span>
          <button type="button" data-proto-add-key="" onClick={openKeyField}
            className={`rounded-[6px] font-semibold text-accent hover:underline ${FOCUS} ${sheet ? "min-h-11" : "min-h-6"}`}>{L("Add the key", "Додати ключ")}</button>
        </div>
      ) : option.disabled ? (
        <span className={`text-muted ${sheet ? "ml-7 text-label" : "ml-6 text-[11px] leading-[14px]"}`}>{option.disabled}</span>
      ) : null}
    </div>
  );
}

function FeaturePage({ feature }: { feature: Feature }) {
  const { t } = useLocale();
  const sheet = useSheet();
  const state = useProto();
  /* Dictation and voice name their choices with the product's own messages (the onboarding step, the voice settings). */
  const options: Option[] = feature.id === "dictation" ? [
    ...(["local", "chatgpt", "elevenlabs", "soniox"] as const).map((id) => ({
      id: id === "elevenlabs" ? "ElevenLabs" : id === "soniox" ? "Soniox" : id === "local" ? "Faster Whisper" : "ChatGPT Voice",
      name: t(`onboarding.voice.name.${id}`), note: t(`onboarding.voice.note.${id}`),
    })),
    { id: OPENAI, name: OPENAI, note: L("recording and live, with the key", "запис і наживо, за ключем") },
  ] : feature.id === "voice" ? [
    { id: "Codex V3", name: t("voiceCompanion.settings.backend.codex"), note: L("your Codex sign-in", "ваш вхід у Codex") },
    { id: OPENAI, name: t("voiceCompanion.settings.backend.api"), note: L("OpenAI key · its own monthly cap", "ключ OpenAI · свій місячний ліміт") },
  ] : feature.options;
  const groupLabel = feature.id === "dictation" ? t("onboarding.voice.heading") : feature.id === "voice" ? t("voiceCompanion.settings.backend") : L("Who serves it", "Хто це обслуговує");
  const [voiceOn, setVoiceOn] = useState(true);
  return (
    <div data-proto-feature-page={feature.id} className={`flex flex-col ${sheet ? "gap-2 px-4 pb-4 pt-1" : "gap-1.5 px-2 pb-1.5"}`}>
      <Muted>{feature.what}</Muted>
      {feature.id === "voice" ? (
        <div className={`flex items-center gap-2 ${sheet ? "min-h-11" : "min-h-8"}`}>
          <span className={`min-w-0 flex-1 font-semibold text-primary ${sheet ? "text-body" : "text-[12px]"}`}>{t("voiceCompanion.settings.enable")}</span>
          <SettingSwitch enabled={voiceOn} size={sheet ? "sheet" : "row"} aria-label={t("voiceCompanion.settings.enable")} data-proto-voice-enable="" onClick={() => setVoiceOn(!voiceOn)} />
        </div>
      ) : null}
      <p className={`font-semibold text-primary ${sheet ? "text-body" : "text-[12px] leading-4"}`}>{groupLabel}</p>
      <div role="radiogroup" aria-label={groupLabel} className="flex flex-col overflow-hidden rounded-[12px] border border-border">
        {options.map((option) => <OptionRow key={option.id} feature={feature} option={option} name={`proto-${feature.id}`} />)}
      </div>
      {state.keySaved && effective(state, feature.id) === OPENAI ? <Muted>{CODEX_LINE()}</Muted> : null}
    </div>
  );
}

/* ---------- the page: the real Keys page in the panel or the sheet ---------- */

function Pages() {
  const { t } = useLocale();
  const sheet = useSheet();
  const state = useProto();
  const feature = FEATURES.find((candidate) => candidate.id === state.page);
  const title = state.page === "keys" ? t("keys.title") : state.page === "who" ? L("Who serves what", "Хто що обслуговує") : feature!.name;
  const back = () => update({ page: "keys", openDot: null });
  const page = state.page === "keys" ? (
    <>
      <KeysMenuPage size={sheet ? "sheet" : "menu"} focusKey={state.focus.key} focusSeq={state.focus.seq} onImport={() => undefined} />
      {VARIANT === 1 ? <UnderOpenAiRow /> : VARIANT === 2 ? <WhoEntry /> : <FeatureLinks />}
    </>
  ) : state.page === "who" ? <WhoPage /> : <FeaturePage feature={feature!} />;
  return (
    <div data-header-menu="" data-header-menu-page={state.page}>
      <BackRow title={title} onBack={state.page === "keys" ? () => undefined : back} />
      {page}
    </div>
  );
}

const CAPTION: Record<1 | 2 | 3, string> = {
  1: L("Variant 1 · Switches under the OpenAI row", "Варіант 1 · Перемикачі під рядком OpenAI"),
  2: L("Variant 2 · Who serves what", "Варіант 2 · Хто що обслуговує"),
  3: L("Variant 3 · In each feature’s settings", "Варіант 3 · У налаштуваннях кожної функції"),
};
const STATE_WORDS: Record<State, string> = {
  none: L("no OpenAI key", "ключа OpenAI немає"),
  saved: L("key saved", "ключ збережено"),
  switched: L("three features on OpenAI", "три функції на OpenAI"),
  removed: L("key removed", "ключ прибрано"),
};

function Prototype() {
  const { t } = useLocale();
  const sheet = useSheet();
  useEffect(() => { document.body.dataset.protoReady = ""; }, []);
  const caption = (
    <p data-proto-caption="" className={`text-label font-semibold text-secondary ${sheet ? "relative z-[61] px-4 pt-3 !text-primary" : "absolute left-[260px] top-[40px]"}`}>
      {CAPTION[VARIANT]} · {STATE_WORDS[STATE]}
    </p>
  );
  if (sheet) {
    const entries: MobileMenuEntry[] = [{ kind: "custom", key: "proto-pages", node: <Pages /> }];
    return (
      <main className="relative min-h-dvh bg-canvas text-primary">
        {caption}
        <MobileMenuSheet title={t("rail.overview")} entries={entries} onClose={() => undefined} />
      </main>
    );
  }
  return (
    <main className="relative min-h-dvh bg-canvas text-primary">
      {caption}
      <div data-rail-menu-panel="" className="absolute left-[7px] top-[37px] w-[232px] rounded-[10px] border border-border bg-card p-1 shadow-2">
        <Pages />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Prototype />);
