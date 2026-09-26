"use client";

import { useCallback, useSyncExternalStore } from "react";

import { en } from "./en";
import { uk } from "./uk";

export type Locale = "en" | "uk";

export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>;
export type Message = string | PluralForms;
export type Dictionary = Record<string, Message>;
export type MessageKey = keyof typeof en;

const DICTS: Record<Locale, Dictionary> = { en, uk };
const STORAGE_KEY = "llv_lang";

function detectLocale(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "uk") return saved;
  } catch {
    /* private mode / disabled storage: fall through to navigator */
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  return nav.toLowerCase().startsWith("uk") ? "uk" : "en";
}

let current: Locale = "en";
let hydrated = false;
const listeners = new Set<() => void>();

function ensureHydrated() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  current = detectLocale();
  document.documentElement.lang = current;
}

export function getLocale(): Locale {
  ensureHydrated();
  return current;
}

/** Show `next` in this browser and keep it as the boot cache. Tells nobody. */
function applyLocale(next: Locale) {
  hydrated = true;
  if (next === current) return;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore storage failures — the choice still applies for this session */
  }
  if (typeof document !== "undefined") document.documentElement.lang = next;
  for (const listener of listeners) listener();
}

/**
 * The operator's choice from the language toggle. Besides this browser it is
 * written to the server (docs/design/orchestrator-reports.md §4.2), because
 * agents write reports and board task text in the interface language and the
 * server is the only place they can read it from.
 */
export function setLocale(next: Locale) {
  applyLocale(next);
  void writeOperatorSettings({ locale: next, source: "chosen", ...clientTimeZone() });
}

const OPERATOR_SETTINGS_URL = "/api/operator/settings";

function clientTimeZone(): { timeZone?: string } {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? { timeZone: zone } : {};
  } catch {
    return {};
  }
}

async function writeOperatorSettings(body: Record<string, unknown>): Promise<void> {
  if (typeof fetch !== "function") return;
  try {
    await fetch(OPERATOR_SETTINGS_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    /* The next toggle, or the next page load, writes it again. */
  }
}

let operatorLocaleSynced = false;

/** Forget this page's language state, as a fresh page load would. */
export function resetLocaleForTests(): void {
  operatorLocaleSynced = false;
  hydrated = false;
  current = "en";
}

/**
 * Once per page load, after the app has mounted: adopt the server's language
 * when it differs from what this browser shows (another device chose it), or,
 * when the server has none yet, report what this browser shows as `detected`.
 * The time zone is reported either way. Storage stays the boot cache, so the
 * first paint never waits on this.
 */
export async function syncOperatorLocale(): Promise<void> {
  if (operatorLocaleSynced || typeof window === "undefined" || typeof fetch !== "function") return;
  operatorLocaleSynced = true;
  const shown = getLocale();
  let server: Locale | null = null;
  let serverTimeZone: string | null = null;
  try {
    const response = await fetch(OPERATOR_SETTINGS_URL, { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json() as { locale?: { value?: unknown } | null; timeZone?: { value?: unknown } | null };
    const value = body.locale?.value;
    server = value === "en" || value === "uk" ? value : null;
    serverTimeZone = typeof body.timeZone?.value === "string" ? body.timeZone.value : null;
  } catch {
    return;
  }
  const zone = clientTimeZone();
  const zoneChanged = zone.timeZone !== undefined && zone.timeZone !== serverTimeZone;
  if (server && server !== shown) applyLocale(server);
  if (!server) {
    await writeOperatorSettings({ locale: shown, source: "detected", ...zone });
  } else if (zoneChanged) {
    await writeOperatorSettings(zone);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** Pure lookup: pick locale message, resolve plural form, interpolate params. */
export function translate(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const entry = (DICTS[locale][key] ?? DICTS.en[key] ?? key) as Message;
  let text: string;
  if (typeof entry === "string") {
    text = entry;
  } else {
    const count = typeof params?.count === "number" ? params.count : 0;
    const form = new Intl.PluralRules(locale === "uk" ? "uk-UA" : "en-US").select(count);
    text = entry[form] ?? entry.other ?? entry.one ?? "";
  }
  return interpolate(text, params);
}

export type TFunction = (key: MessageKey, params?: Record<string, string | number>) => string;

/** Reactive locale + translator. Components re-render when the locale flips. */
export function useLocale(): { locale: Locale; t: TFunction; setLocale: (l: Locale) => void } {
  const locale = useSyncExternalStore(subscribe, getLocale, () => "en" as Locale);
  /* One function per locale: a component that lists `t` among a memo's inputs rebuilds only when the language
     changes, never on every render. */
  const t = useCallback<TFunction>((key, params) => translate(locale, key, params), [locale]);
  return { locale, t, setLocale };
}
