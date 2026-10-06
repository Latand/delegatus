"use client";

import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { useLocale } from "@/lib/i18n";
import type { MemorySettingView } from "@/lib/memory/viewTypes";

import type { Words } from "./compactMenus.family.prototype";
import { HEADER_MEMORY_EVENT, headerName, type HeaderVariant } from "./headerMenu.prototype";

/* Design prototype (docs/design/compact-card-menu.md, "Shared memory in the
   header's menu"): where the shared memory block of the Settings dialog lives
   in each header variant. Nothing here is a new capability: the menu shows the
   state the dialog's status line already reports, and the dialog shows the
   product's own switch, status line, key row and counters, laid out as one
   card. The counters are drawn from the same `/api/memory/settings` answer the
   product's block reads. */

export const MEMORY_STATES = ["working", "off", "noKey", "capped"] as const;
export type MemoryState = (typeof MEMORY_STATES)[number];

/** A synthetic answer of `/api/memory/settings` for the evidence fixture. */
export function memoryFixtureView(state: MemoryState): MemorySettingView {
  return {
    enabled: state !== "off",
    reasons: state === "working" ? [] : state === "off" ? ["projectOff"] : [state],
    keySource: state === "noKey" ? null : "file",
    capUsd: 5,
    spentUsd: state === "capped" ? 4.996 : state === "noKey" ? 0 : 1.214,
    month: "2026-10",
    counts: state === "noKey"
      ? { decisions: 0, delivered: 0, skipped: 0, failed: 0, noCandidates: 0, noMatches: 0, prepared: 0 }
      : { decisions: 128, delivered: 41, skipped: 9, failed: 2, noCandidates: 30, noMatches: 44, prepared: 52 },
  };
}

type View = Partial<MemorySettingView> & { enabled: boolean; status?: "unavailable" };
export type MemoryTone = "working" | "off" | "noKey" | "capped" | "notOwner" | "unknown";

/** The one state a person needs at a glance, from the reasons the product reports. */
export function memoryTone(view: View | null): MemoryTone {
  if (!view || view.status === "unavailable" || !view.reasons) return "unknown";
  for (const reason of ["notOwner", "noKey", "capped"] as const) if (view.reasons.includes(reason)) return reason;
  return view.reasons.includes("projectOff") || !view.enabled ? "off" : "working";
}

const TONE_WORDS: Record<MemoryTone, { short: Words; full: Words; colour: string }> = {
  working: { short: { en: "working", uk: "працює" }, full: { en: "Working", uk: "Працює" }, colour: "var(--color-success)" },
  off: { short: { en: "off", uk: "вимкнено" }, full: { en: "Off for this project", uk: "Вимкнено для цього проєкту" }, colour: "var(--color-muted)" },
  noKey: { short: { en: "no key", uk: "без ключа" }, full: { en: "Needs an OpenRouter key", uk: "Потрібен ключ OpenRouter" }, colour: "var(--color-warning)" },
  capped: { short: { en: "capped", uk: "ліміт" }, full: { en: "Paused: the monthly cap is reached", uk: "Пауза: місячний ліміт вичерпано" }, colour: "var(--color-warning)" },
  notOwner: { short: { en: "other release", uk: "інший реліз" }, full: { en: "Another release serves traffic", uk: "Запити обслуговує інший реліз" }, colour: "var(--color-warning)" },
  unknown: { short: { en: "unknown", uk: "невідомо" }, full: { en: "State unknown", uk: "Стан невідомий" }, colour: "var(--color-muted)" },
};

/* One reading shared by the menu's marks and the dialog's card. */
let project = "";
let current: View | null = null;
const listeners = new Set<() => void>();
async function refresh(): Promise<void> {
  try {
    const response = await fetch(`/api/memory/settings?project=${encodeURIComponent(project)}`, { cache: "no-store" });
    current = response.ok ? await response.json() as View : { enabled: false, status: "unavailable" };
  } catch { current = { enabled: false, status: "unavailable" }; }
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const useMemoryView = () => useSyncExternalStore(subscribe, () => current, () => null);

/** The state of shared memory beside its entry in the menu: a dot and one word. */
export function MemoryPill() {
  const { locale } = useLocale();
  const tone = memoryTone(useMemoryView());
  const words = TONE_WORDS[tone];
  return (
    <span data-hm-memory={tone} className="cmf-trail" title={words.full[locale === "uk" ? "uk" : "en"]} style={{ display: "inline-flex", flexShrink: 0, alignItems: "center", gap: 5, marginLeft: 8, fontSize: 11, fontWeight: 500, color: "var(--color-muted)", whiteSpace: "nowrap" }}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: words.colour }} />
      {words.short[locale === "uk" ? "uk" : "en"]}
    </span>
  );
}

/** On the row of a group that holds memory: the dot alone, and only its colour changes. */
export function MemoryDot() {
  const { locale } = useLocale();
  const tone = memoryTone(useMemoryView());
  const words = TONE_WORDS[tone];
  const lang = locale === "uk" ? "uk" : "en";
  return <span data-hm-memory={tone} role="img" aria-label={`${lang === "uk" ? "Спільна пам’ять" : "Shared memory"}: ${words.short[lang]}`} title={`${lang === "uk" ? "Спільна пам’ять" : "Shared memory"}: ${words.short[lang]}`} style={{ width: 7, height: 7, flexShrink: 0, marginRight: 8, borderRadius: 999, background: words.colour }} />;
}

const CARD_CSS = `
[data-telemetry-settings][data-hm] { display: flex; flex-direction: column; }
[data-telemetry-settings][data-hm] > [data-hm-chrome] { display: contents; }
[data-telemetry-settings][data-hm] #telemetry-title { font-size: 0; }
[data-telemetry-settings][data-hm] #telemetry-title::after { content: attr(data-hm-title); font-size: 18px; }
[data-telemetry-settings][data-hm] > p.my-4 { margin: 6px 0 4px; font-size: 12.5px; color: var(--color-muted); }
[data-hm] .hm-head { margin-top: 14px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-muted); }
[data-hm] [data-memory-setting] { display: flex; flex-direction: column; margin-top: 8px; padding: 6px 14px 12px; border: 1px solid var(--border-default); border-bottom: 0; border-radius: 12px 12px 0 0; background: var(--surface-card); }
[data-hm] [data-memory-setting] > [data-hm-chrome] { display: contents; }
[data-hm] [data-memory-setting] > label { order: 0; }
[data-hm] [data-memory-setting] > [role="alert"] { order: 2; }
[data-hm] [data-memory-setting] > [data-memory-status] { order: 2; margin-top: 4px; }
[data-hm] [data-memory-setting] > p:not([role]):not([data-memory-counts]):not([data-memory-status]) { order: 6; margin-top: 10px; font-size: 12px; }
/* The counters and the spend are drawn as tiles from the same reading; the product's two sentences stand down. */
[data-hm] [data-memory-setting] > [data-memory-counts], [data-hm] [data-memory-setting] > [data-memory-counts] + p { display: none; }
[data-hm] .hm-state { order: 1; display: inline-flex; align-self: flex-start; align-items: center; gap: 6px; padding: 2px 9px 2px 8px; border: 1px solid var(--border-default); border-radius: 999px; font-size: 12px; font-weight: 600; }
[data-hm] .hm-state > i { width: 8px; height: 8px; border-radius: 999px; }
[data-hm] .hm-tiles { order: 3; display: grid; grid-template-columns: 1fr 1fr 1.5fr; gap: 8px; margin-top: 12px; }
[data-hm] .hm-tile { min-width: 0; padding: 8px 10px; border-radius: 8px; background: var(--surface-sunken); }
[data-hm] .hm-tile > b { display: block; font-size: 18px; font-weight: 700; line-height: 1.2; font-variant-numeric: tabular-nums; }
[data-hm] .hm-tile > span { display: block; font-size: 11px; color: var(--color-muted); }
[data-hm] .hm-bar { height: 4px; margin: 5px 0 4px; border-radius: 999px; background: var(--border-default); overflow: hidden; }
[data-hm] .hm-bar > i { display: block; height: 100%; border-radius: 999px; }
[data-hm] .hm-rest { order: 4; margin-top: 8px; font-size: 11.5px; line-height: 1.45; color: var(--color-muted); font-variant-numeric: tabular-nums; }
[data-hm] [data-provider-key] { margin-top: 0; padding: 12px 14px; border: 1px solid var(--border-default); border-radius: 0 0 12px 12px; background: var(--surface-sunken); }
[data-hm] [data-provider-key] p { font-size: 12px; }
`;

const COUNT_WORDS = {
  decisions: { en: "decisions", uk: "рішень" },
  delivered: { en: "turns with memory", uk: "ходів із пам’яттю" },
  budget: { en: "of the month's cap", uk: "місячного ліміту" },
  scope: { en: "Installation", uk: "Уся інсталяція" },
  prepared: { en: "prepared", uk: "підготовлено" },
  noCandidates: { en: "no candidates", uk: "без кандидатів" },
  noMatches: { en: "no match", uk: "без збігу" },
  skipped: { en: "skipped", uk: "пропущено" },
  failed: { en: "failed", uk: "збоїв" },
  memory: { en: "Shared memory", uk: "Спільна пам’ять" },
  privacy: { en: "Privacy", uk: "Приватність" },
} satisfies Record<string, Words>;

/** The dialog behind the entry: memory, its state, its counters and the key as one card; the ping under its own heading. */
function MemoryCard({ dialog, variant, first }: { dialog: HTMLElement; variant: HeaderVariant; first: "memory" | "settings" }) {
  const { locale } = useLocale();
  const lang = locale === "uk" ? "uk" : "en";
  const view = useMemoryView();
  const [block, setBlock] = useState<HTMLElement | null>(null);
  const hosts = useMemo(() => [0, 1].map(() => { const host = document.createElement("div"); host.setAttribute("data-hm-chrome", ""); return host; }), []);
  useLayoutEffect(() => {
    dialog.setAttribute("data-hm", first);
    dialog.querySelector("#telemetry-title")?.setAttribute("data-hm-title", headerName(variant, first)[lang]);
    const memory = dialog.querySelector<HTMLElement>("[data-memory-setting]");
    const key = dialog.querySelector<HTMLElement>("[data-provider-key]");
    const privacy = [...dialog.querySelectorAll<HTMLElement>(":scope > p, :scope > label")];
    const base = first === "memory" ? { memory: 10, privacy: 30 } : { memory: 30, privacy: 10 };
    if (memory) memory.style.order = String(base.memory + 1);
    if (key) key.style.order = String(base.memory + 2);
    privacy.forEach((element, index) => { element.style.order = String(base.privacy + 1 + index); });
    hosts[0]!.style.setProperty("--hm-memory", String(base.memory));
    hosts[0]!.style.setProperty("--hm-privacy", String(base.privacy));
    if (!hosts[0]!.isConnected) dialog.appendChild(hosts[0]!);
    if (memory && !hosts[1]!.isConnected) memory.appendChild(hosts[1]!);
    /* The block mounts with the dialog; its card is drawn once it is there. */
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setBlock(memory);
    void refresh();
  }, [dialog, variant, first, lang, hosts]);
  /* A flipped switch or a saved key changes what the card reports. */
  useEffect(() => {
    const later = () => { setTimeout(() => void refresh(), 250); };
    dialog.addEventListener("change", later);
    window.addEventListener("delegatus:provider-key-changed", later);
    return () => { dialog.removeEventListener("change", later); window.removeEventListener("delegatus:provider-key-changed", later); };
  }, [dialog]);
  useEffect(() => () => { for (const host of hosts) host.remove(); }, [hosts]);
  const tone = memoryTone(view);
  const words = TONE_WORDS[tone];
  const counts = view?.counts;
  const share = view?.capUsd ? Math.min(1, (view.spentUsd ?? 0) / view.capUsd) : 0;
  const order = first === "memory" ? { memory: 10, privacy: 30 } : { memory: 30, privacy: 10 };
  return (
    <>
      {createPortal(
        <>
          <style>{CARD_CSS}</style>
          <div className="hm-head" style={{ order: order.memory }}>{COUNT_WORDS.memory[lang]}</div>
          <div className="hm-head" style={{ order: order.privacy }}>{COUNT_WORDS.privacy[lang]}</div>
        </>,
        hosts[0]!,
      )}
      {block ? createPortal(
        <>
          <span className="hm-state" data-hm-state={tone}><i style={{ background: words.colour }} />{words.full[lang]}</span>
          {counts && view?.capUsd !== undefined && view.spentUsd !== undefined ? (
            <>
              <div className="hm-tiles" data-hm-tiles="">
                <div className="hm-tile"><b>{counts.decisions}</b><span>{COUNT_WORDS.decisions[lang]}</span></div>
                <div className="hm-tile"><b>{counts.delivered}</b><span>{COUNT_WORDS.delivered[lang]}</span></div>
                <div className="hm-tile">
                  <b>${view.spentUsd.toFixed(3)} / ${view.capUsd.toFixed(2)}</b>
                  <div className="hm-bar"><i style={{ width: `${Math.round(share * 100)}%`, background: share >= 0.99 ? "var(--color-warning)" : "var(--color-success)" }} /></div>
                  <span>{COUNT_WORDS.budget[lang]}</span>
                </div>
              </div>
              <p className="hm-rest" data-hm-rest="">
                {COUNT_WORDS.scope[lang]}, {view.month} (UTC) · {COUNT_WORDS.prepared[lang]} {counts.prepared} · {COUNT_WORDS.noCandidates[lang]} {counts.noCandidates} · {COUNT_WORDS.noMatches[lang]} {counts.noMatches} · {COUNT_WORDS.skipped[lang]} {counts.skipped} · {COUNT_WORDS.failed[lang]} {counts.failed}
              </p>
            </>
          ) : null}
        </>,
        hosts[1]!,
      ) : null}
    </>
  );
}

let opening = 0;

/** Mounted beside the Viewer under `?header=N`: keeps the reading fresh and dresses the dialog whenever it opens. */
export function HeaderMemory({ variant, project: of }: { variant: HeaderVariant; project: string }) {
  const [dialog, setDialog] = useState<{ element: HTMLElement; first: "memory" | "settings"; key: number } | null>(null);
  useEffect(() => {
    project = of;
    void refresh();
    let first: "memory" | "settings" = "settings";
    const pressed = () => { first = "memory"; };
    window.addEventListener(HEADER_MEMORY_EVENT, pressed);
    const scan = () => {
      const element = document.querySelector<HTMLElement>("[data-telemetry-settings]");
      setDialog((was) => (element === (was?.element ?? null) ? was : element ? { element, first, key: ++opening } : null));
      if (!element) first = "settings";
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true });
    return () => { observer.disconnect(); window.removeEventListener(HEADER_MEMORY_EVENT, pressed); };
  }, [of]);
  return dialog ? <MemoryCard key={dialog.key} dialog={dialog.element} variant={variant} first={dialog.first} /> : null;
}
