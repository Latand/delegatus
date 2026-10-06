"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { OpenRouterKeySetting } from "@/components/asks/OpenRouterKeySetting";
import { ProjectSettingRow } from "@/components/ProjectSettingRow";
import { useLocale } from "@/lib/i18n";
import type { MemorySettingView } from "@/lib/memory/viewTypes";

import type { Words } from "./compactMenus.family.prototype";

/* Design prototype (docs/design/compact-card-menu.md, "Shared memory's
   home"): shared memory and the OpenRouter key as rows of the header's menu.
   A row carries its state as a word with a dot; one step in is a page of the
   menu with the per-project switch (the product's own `ProjectSettingRow`),
   the reason and its action when memory is blocked, three numbers and the
   rest behind "More". It reads and writes the product's own endpoints,
   `/api/memory/settings` and `/api/asks-you/key`, and adds no capability. The
   dialog behind the old Settings entry keeps the ping alone. */

export const MEMORY_STATES = ["working", "off", "noKey", "capped"] as const;
export type MemoryState = (typeof MEMORY_STATES)[number];

type KeyView = { present: boolean; source: "env" | "file" | null; staging?: boolean };

/** A synthetic answer of `/api/memory/settings` for the evidence fixture. */
export function memoryFixtureView(state: MemoryState, enabled = state !== "off"): MemorySettingView {
  const blocked = state === "noKey" || state === "capped" ? [state] as const : [];
  return {
    enabled,
    reasons: [...(enabled ? [] : ["projectOff" as const]), ...blocked],
    keySource: state === "noKey" ? null : "file",
    capUsd: 5,
    spentUsd: state === "capped" ? 4.996 : state === "noKey" ? 0 : 1.214,
    month: "2026-10",
    counts: state === "noKey"
      ? { decisions: 0, delivered: 0, skipped: 0, failed: 0, noCandidates: 0, noMatches: 0, prepared: 0 }
      : { decisions: 214, delivered: 61, skipped: 12, failed: 5, noCandidates: 48, noMatches: 97, prepared: 69 },
  };
}

/** The fixture's two endpoints: a flipped switch and a saved key answer as the product's would. */
export function memoryFixtureServer(initial: MemoryState): (method: string, pathname: string, body: unknown) => unknown {
  let state = initial;
  let enabled = initial !== "off";
  return (method, pathname, body) => {
    const sent = (body ?? {}) as { enabled?: boolean; key?: string };
    if (pathname === "/api/memory/settings") {
      if (method === "PUT" && typeof sent.enabled === "boolean") { enabled = sent.enabled; if (state === "off" || state === "working") state = enabled ? "working" : "off"; }
      return memoryFixtureView(state, enabled);
    }
    if (pathname === "/api/asks-you/key") {
      if (method === "PUT" && sent.key && state === "noKey") state = enabled ? "working" : "off";
      return { present: state !== "noKey", source: state === "noKey" ? null : "file" } satisfies KeyView;
    }
    return undefined;
  };
}

type View = Partial<MemorySettingView> & { enabled: boolean; status?: "unavailable" };
export type MemoryTone = "working" | "off" | "noKey" | "capped" | "notOwner" | "unknown";

/** The one state a person needs at a glance, from the reasons the product reports: what blocks first, then the switch. */
export function memoryTone(view: View | null): MemoryTone {
  if (!view || view.status === "unavailable" || !view.reasons) return "unknown";
  for (const reason of ["notOwner", "noKey", "capped"] as const) if (view.reasons.includes(reason)) return reason;
  return view.reasons.includes("projectOff") || !view.enabled ? "off" : "working";
}

type Lang = "en" | "uk";
const month = (value: string | undefined, lang: Lang) => {
  const [year, index] = (value ?? "").split("-").map(Number);
  return year && index ? new Date(Date.UTC(year, index - 1, 1)).toLocaleDateString(lang, { month: "long", timeZone: "UTC" }) : "";
};
/** The first day of the month after `value`, as "1 листопада" / "November 1". */
const resets = (value: string | undefined, lang: Lang) => {
  const [year, index] = (value ?? "").split("-").map(Number);
  return year && index ? new Date(Date.UTC(year, index, 1)).toLocaleDateString(lang, { day: "numeric", month: "long", timeZone: "UTC" }) : "";
};
/** Two decimals, and none on a whole amount. */
export const money = (value: number) => `$${Number.isInteger(value) ? value : value.toFixed(2)}`;

const COLOUR: Record<MemoryTone, string> = { working: "var(--color-success)", off: "var(--color-muted)", noKey: "var(--color-warning)", capped: "var(--color-warning)", notOwner: "var(--color-warning)", unknown: "var(--color-muted)" };

/** The state as a word: on the memory row, and shorter on the row of a group that holds it. */
export function memoryWord(view: View | null, lang: Lang, short = false): string {
  const tone = memoryTone(view);
  const uk = lang === "uk";
  if (tone === "working") {
    const count = view?.counts?.delivered;
    if (short) return uk ? "працює" : "working";
    return count === undefined ? (uk ? "Працює" : "Working") : uk ? `Працює · ${count} цього місяця` : `Working · ${count} this month`;
  }
  if (tone === "off") return short ? (uk ? "вимкнено" : "off") : uk ? "Вимкнено" : "Off";
  if (tone === "noKey") return short ? (uk ? "потрібен ключ" : "key needed") : uk ? "Потрібен ключ" : "Key needed";
  if (tone === "capped") return short ? (uk ? "ліміт" : "capped") : uk ? `Ліміт до ${resets(view?.month, lang)}` : `Cap until ${resets(view?.month, lang)}`;
  if (tone === "notOwner") return short ? (uk ? "інший реліз" : "other release") : uk ? "Інший реліз" : "Other release";
  return short ? (uk ? "невідомо" : "unknown") : uk ? "Стан невідомий" : "State unknown";
}

/* One reading shared by the rows and the pages. */
let project = "";
let memory: View | null = null;
let key: KeyView | null = null;
const listeners = new Set<() => void>();
const tell = () => { for (const listener of listeners) listener(); };
async function read<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "no-store", ...init });
    return response.ok ? await response.json() as T : null;
  } catch { return null; }
}
async function refresh(): Promise<void> {
  const [nextMemory, nextKey] = await Promise.all([read<View>(`/api/memory/settings?project=${encodeURIComponent(project)}`), read<KeyView>("/api/asks-you/key")]);
  memory = nextMemory ?? { enabled: false, status: "unavailable" };
  key = nextKey;
  tell();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const useMemoryView = () => useSyncExternalStore(subscribe, () => memory, () => null);
const useKeyView = () => useSyncExternalStore(subscribe, () => key, () => null);
const useLang = (): Lang => (useLocale().locale === "uk" ? "uk" : "en");

const STATE_STYLE = { display: "inline-flex", minWidth: 0, flexShrink: 0, alignItems: "center", gap: 5, fontSize: 11, fontWeight: 500, color: "var(--color-muted)", whiteSpace: "nowrap" } as const;
const Dot = ({ colour }: { colour: string }) => <span aria-hidden style={{ width: 7, height: 7, flexShrink: 0, borderRadius: 999, background: colour }} />;

/** On the memory row: a dot and the state in words. */
export function MemoryPill() {
  const lang = useLang();
  const view = useMemoryView();
  return <span data-hm-memory={memoryTone(view)} className="cmf-state" style={STATE_STYLE}><Dot colour={COLOUR[memoryTone(view)]} />{memoryWord(view, lang)}</span>;
}

/** On the row of a group that holds memory: the same state, named, in a word. */
export function MemoryDot() {
  const lang = useLang();
  const view = useMemoryView();
  return <span data-hm-memory={memoryTone(view)} className="cmf-state" style={STATE_STYLE}><Dot colour={COLOUR[memoryTone(view)]} />{lang === "uk" ? "пам’ять" : "memory"}: {memoryWord(view, lang, true)}</span>;
}

const keyWord = (view: KeyView | null, lang: Lang) => (view === null ? (lang === "uk" ? "Стан невідомий" : "State unknown") : view.present ? (lang === "uk" ? "Збережено" : "Saved") : lang === "uk" ? "Немає" : "Missing");

/** On the key row: Saved or Missing. */
export function KeyPill() {
  const lang = useLang();
  const view = useKeyView();
  return <span data-hm-key={view?.present ? "saved" : view ? "missing" : "unknown"} className="cmf-state" style={STATE_STYLE}><Dot colour={view?.present ? "var(--color-success)" : view ? "var(--color-warning)" : "var(--color-muted)"} />{keyWord(view, lang)}</span>;
}

const PANEL_CSS = `
[data-hm-panel] { display: flex; flex-direction: column; gap: 6px; padding: 2px 0 6px; font-size: 12px; }
[data-hm-panel] .hm-pad { padding: 0 8px; }
[data-cmf="phone-board"] [data-hm-panel] .hm-pad { padding: 0 16px; }
[data-cmf="phone-board"] [data-hm-panel] { font-size: 14px; gap: 10px; padding-bottom: 16px; }
/* On and blocked: the switch stays on and loses the colour that says it works. */
[data-hm-panel] [data-hm-blocked] [role="switch"] > span { border-color: var(--color-warning); background: var(--color-warning); }
[data-hm-panel] .hm-line { color: var(--color-muted); font-size: 11px; line-height: 1.4; }
[data-cmf="phone-board"] [data-hm-panel] .hm-line { font-size: 12.5px; }
[data-hm-panel] .hm-reason { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 7px 8px; border-radius: 8px; background: var(--color-warning-soft); line-height: 1.35; }
[data-hm-panel] .hm-act { padding: 3px 9px; border: 1px solid var(--border-default); border-radius: 7px; background: var(--surface-card); font-size: 11.5px; font-weight: 600; }
[data-cmf="phone-board"] [data-hm-panel] .hm-act { min-height: 44px; padding: 0 14px; font-size: 14px; }
[data-hm-panel] .hm-nums { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
[data-hm-panel] .hm-num { min-width: 0; padding: 5px 6px; border-radius: 7px; background: var(--surface-sunken); }
[data-hm-panel] .hm-num > b { display: block; font-size: 15px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; white-space: nowrap; }
[data-hm-panel] .hm-num > span { display: block; color: var(--color-muted); font-size: 10.5px; line-height: 1.25; }
[data-cmf="phone-board"] [data-hm-panel] .hm-num > b { font-size: 20px; }
[data-cmf="phone-board"] [data-hm-panel] .hm-num > span { font-size: 12px; }
[data-hm-panel] .hm-more { align-self: flex-start; color: inherit; font-size: 11.5px; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
[data-cmf="phone-board"] [data-hm-panel] .hm-more { min-height: 44px; font-size: 14px; }
[data-hm-panel] .hm-table { display: grid; grid-template-columns: 1fr auto 1fr auto; gap: 2px 6px; margin: 0; color: var(--color-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
[data-cmf="phone-board"] [data-hm-panel] .hm-table { font-size: 13px; gap: 6px 12px; }
[data-hm-panel] .hm-table dt { white-space: nowrap; }
[data-hm-panel] .hm-table dd { margin: 0 6px 0 0; text-align: right; color: inherit; font-weight: 600; }
[data-hm-panel] .hm-keyfield { width: 100%; }
[data-hm-panel] .hm-keyfield [data-provider-key] { margin: 0; padding: 0; border: 0; }
[data-hm-panel] .hm-keyfield [data-provider-key] > label, [data-hm-panel] .hm-keyfield [data-provider-key] > p:not([role="alert"]) { display: none; }
[data-hm-panel] .hm-keyfield form { margin: 0; flex-wrap: nowrap; gap: 4px; }
[data-hm-panel] .hm-keyfield form > input { min-height: 28px; height: 28px; padding: 0 6px; border-radius: 7px; }
[data-hm-panel] .hm-keyfield form > button { min-height: 28px; height: 28px; padding: 0 9px; border-radius: 7px; background: var(--surface-card); font-size: 11.5px; font-weight: 600; white-space: nowrap; }
[data-cmf="phone-board"] [data-hm-panel] .hm-keyfield form > input, [data-cmf="phone-board"] [data-hm-panel] .hm-keyfield form > button { min-height: 44px; height: 44px; font-size: 14px; }
[data-hm-panel] .hm-state { display: flex; align-items: center; gap: 6px; font-weight: 600; }
[data-hm-panel] .hm-state > .hm-act { margin-left: auto; }
`;

/** The key's field, opened where it was asked for: the product's own key row, of which only the field and its errors are drawn here. */
function KeyField() {
  return <div className="hm-keyfield" data-hm-key-field=""><OpenRouterKeySetting /></div>;
}

const WORDS = {
  forProject: { en: "For this project", uk: "Для цього проєкту" },
  explains: { en: "A small model through OpenRouter picks memories to add to your messages.", uk: "Невелика модель через OpenRouter добирає спогади до ваших повідомлень." },
  added: { en: "added", uk: "підставлено" },
  checked: { en: "checked", uk: "перевірено" },
  spent: { en: "spent", uk: "витрачено" },
  more: { en: "More", uk: "Докладніше" },
  picked: { en: "picked", uk: "дібрано" },
  noCandidates: { en: "no candidates", uk: "без кандидатів" },
  noMatches: { en: "no match", uk: "без збігу" },
  skipped: { en: "skipped", uk: "пропущено" },
  failed: { en: "failed", uk: "невдалих" },
  enterKey: { en: "Enter the key", uk: "Ввести ключ" },
  keyFor: { en: "For Asks you and shared memory", uk: "Для «Питає вас» і спільної пам’яті" },
  replace: { en: "Replace", uk: "Замінити" },
  env: { en: "Set in the environment (OPENROUTER_API_KEY); change it there.", uk: "Задано в середовищі (OPENROUTER_API_KEY); змінюється там." },
} satisfies Record<string, Words>;

/** One step in from the memory row: the switch, what blocks it and how to lift that, the month in three numbers. */
export function MemoryPanel() {
  const lang = useLang();
  const uk = lang === "uk";
  const view = useMemoryView();
  const [busy, setBusy] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [more, setMore] = useState(false);
  const tone = memoryTone(view);
  const blocked = tone === "noKey" || tone === "capped" || tone === "notOwner";
  const counts = view?.counts;
  const toggle = async () => {
    if (!view) return;
    setBusy(true);
    await read("/api/memory/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, enabled: !view.enabled }) });
    await refresh();
    setBusy(false);
  };
  const reason = tone === "noKey" ? (uk ? "Щоб пам’ять підставлялась, потрібен ключ OpenRouter." : "Memory is added only with an OpenRouter key.")
    : tone === "capped" ? (uk ? `Ліміт ${money(view?.capUsd ?? 0)} на місяць використано, відновиться ${resets(view?.month, lang)}.` : `The ${money(view?.capUsd ?? 0)} monthly cap is used up; it resets on ${resets(view?.month, lang)}.`)
    : tone === "notOwner" ? (uk ? "Запити обслуговує інший реліз; пам’ять підставляє він." : "Another release serves traffic and adds memory there.")
    : tone === "unknown" ? (uk ? "Не вдалося прочитати стан пам’яті. Відкрийте меню ще раз." : "Could not read the state of memory. Open the menu again.") : null;
  /* While memory is blocked, a month of zeros says nothing. */
  const numbers = counts && view?.spentUsd !== undefined && view.capUsd !== undefined && !(blocked && counts.decisions === 0 && counts.delivered === 0);
  return (
    <div data-hm-panel="memory" data-hm-tone={tone}>
      <style>{PANEL_CSS}</style>
      <ProjectSettingRow
        label={WORDS.forProject[lang]}
        hint={blocked ? "" : WORDS.explains[lang]}
        enabled={Boolean(view?.enabled)}
        disabled={busy || !view || view.status === "unavailable"}
        failed={false}
        variant="menu"
        rowProps={{ "data-hm-blocked": view?.enabled && blocked ? "" : undefined }}
        switchProps={{ "data-hm-switch": "", onClick: () => void toggle() }}
      />
      {reason ? (
        <div className="hm-pad">
          <div className="hm-reason" role="status" data-hm-reason={tone}>
            <span>{reason}</span>
            {tone === "noKey" && !keyOpen ? <button type="button" className="hm-act" data-hm-enter-key="" onClick={() => setKeyOpen(true)}>{WORDS.enterKey[lang]}</button> : null}
            {tone === "noKey" && keyOpen ? <KeyField /> : null}
          </div>
        </div>
      ) : null}
      {numbers ? (
        <div className="hm-pad" style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <div className="hm-nums" data-hm-numbers="">
            <div className="hm-num"><b>{counts.delivered}</b><span>{WORDS.added[lang]}</span></div>
            <div className="hm-num"><b>{counts.decisions}</b><span>{WORDS.checked[lang]}</span></div>
            <div className="hm-num"><b>{money(view.spentUsd!)}</b><span>{WORDS.spent[lang]} {uk ? "із" : "of"} {money(view.capUsd!)}</span></div>
          </div>
          <span className="hm-line" data-hm-scope="">{uk ? `Повідомлення всієї інсталяції, не лише цього проєкту · ${month(view.month, lang)}` : `Messages of this whole installation, every project · ${month(view.month, lang)}`}</span>
          <button type="button" className="hm-more" aria-expanded={more} data-hm-more="" onClick={() => setMore((was) => !was)}>{WORDS.more[lang]}</button>
          {more ? (
            <dl className="hm-table" data-hm-table="">
              {([["picked", counts.prepared], ["noCandidates", counts.noCandidates], ["noMatches", counts.noMatches], ["skipped", counts.skipped], ["failed", counts.failed]] as const).map(([name, value]) => (
                <div key={name} style={{ display: "contents" }}><dt>{WORDS[name][lang]}</dt><dd>{value}</dd></div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One step in from the key row: what uses the key, whether it is saved, and the field behind Replace. */
export function KeyPanel() {
  const lang = useLang();
  const view = useKeyView();
  const [open, setOpen] = useState(false);
  const env = view?.source === "env";
  /* A saved key closes the field again. */
  useEffect(() => {
    const saved = () => setOpen(false);
    window.addEventListener("delegatus:provider-key-changed", saved);
    return () => window.removeEventListener("delegatus:provider-key-changed", saved);
  }, []);
  const field = view !== null && !env && !view.staging && (open || !view.present);
  return (
    <div data-hm-panel="key">
      <style>{PANEL_CSS}</style>
      <div className="hm-pad" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="hm-line" data-hm-key-for="">{WORDS.keyFor[lang]}</span>
        <div className="hm-state" data-hm-key-state={view?.present ? "saved" : view ? "missing" : "unknown"}>
          <Dot colour={view?.present ? "var(--color-success)" : view ? "var(--color-warning)" : "var(--color-muted)"} />
          {keyWord(view, lang)}
          {view?.present && !env && !view.staging && !open ? <button type="button" className="hm-act" data-hm-replace="" onClick={() => setOpen(true)}>{WORDS.replace[lang]}</button> : null}
        </div>
        {env ? <span className="hm-line">{WORDS.env[lang]}</span> : null}
        {field ? <KeyField /> : null}
      </div>
    </div>
  );
}

const DIALOG_CSS = `
/* Memory and the key have their own rows in the menu; the dialog keeps the ping. */
[data-telemetry-settings][data-hm] [data-memory-setting], [data-telemetry-settings][data-hm] [data-provider-key] { display: none; }
[data-telemetry-settings][data-hm] #telemetry-title { font-size: 0; }
[data-telemetry-settings][data-hm] #telemetry-title::after { content: attr(data-hm-title); font-size: 18px; }
`;

/** Mounted beside the Viewer under `?header=N`: keeps the reading fresh, and leaves the dialog to the ping under the name its entry carries. */
export function HeaderMemory({ project: of, pingName }: { project: string; pingName: Words }) {
  const lang = useLang();
  useEffect(() => {
    project = of;
    void refresh();
    const changed = () => void refresh();
    window.addEventListener("delegatus:provider-key-changed", changed);
    const dress = () => {
      const dialog = document.querySelector<HTMLElement>("[data-telemetry-settings]");
      if (!dialog) return;
      dialog.setAttribute("data-hm", "ping");
      dialog.querySelector("#telemetry-title")?.setAttribute("data-hm-title", pingName[lang]);
    };
    const observer = new MutationObserver(dress);
    observer.observe(document.body, { childList: true });
    return () => { observer.disconnect(); window.removeEventListener("delegatus:provider-key-changed", changed); };
  }, [of, pingName, lang]);
  return <style>{DIALOG_CSS}</style>;
}
