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

export function setLocale(next: Locale) {
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
