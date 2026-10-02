import { en } from "./en";
import { uk } from "./uk";

export type Locale = "en" | "uk";
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>;
export type Message = string | PluralForms;
export type Dictionary = Record<string, Message>;
export type MessageKey = keyof typeof en;
export type TFunction = (key: MessageKey, params?: Record<string, string | number>) => string;

const DICTS: Record<Locale, Dictionary> = { en, uk };

function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

const pluralRulesByLocale = new Map<Locale, Intl.PluralRules>();

/** One rule set per locale: constructing it is the expensive part, and a feed
    translates a plural for most rows it draws. */
function pluralRules(locale: Locale): Intl.PluralRules {
  let rules = pluralRulesByLocale.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale === "uk" ? "uk-UA" : "en-US");
    pluralRulesByLocale.set(locale, rules);
  }
  return rules;
}

/** Pure lookup shared by server callers and the client locale hook. */
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
    const form = pluralRules(locale).select(count);
    text = entry[form] ?? entry.other ?? entry.one ?? "";
  }
  return interpolate(text, params);
}
