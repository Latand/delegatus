import type { TokenDimension } from "@/lib/activity/tokenReport";
import { shiftDay } from "@/lib/activity/range";

/*
 * What the Activity page's address says (docs/design/activity-token-usage.md
 * §9.1): `range` or `from`/`to`, `view`, and the Tokens tab's breakdown in
 * `stack`/`list`. Plain functions, so the server page and the client read
 * the address the same way.
 */

export type ActivityView = "days" | "projects" | "tokens";

/** What «Розбити за» offers; `kind` stacks the chart by kind and lists the kinds. */
export type TokenBy = Exclude<TokenDimension, "engine">;
export const TOKEN_BY: readonly TokenBy[] = ["kind", "model", "role", "project", "member", "account"];

export type RangePreset = "today" | "7d" | "30d" | "90d";
export const RANGE_PRESETS: readonly RangePreset[] = ["today", "7d", "30d", "90d"];

/** A preset, or free dates (`YYYY-MM-DD`, inclusive). */
export type PageRange = { preset: RangePreset } | { preset: null; from: string; to: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validDate(value: string | null | undefined): value is string {
  if (!value || !DATE.test(value)) return false;
  const at = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}

/** Free dates in order and at most 366 days long. */
export function clampDates(from: string, to: string): { from: string; to: string } {
  const [a, b] = from <= to ? [from, to] : [to, from];
  const earliest = shiftDay(b, -365);
  return { from: a < earliest ? earliest : a, to: b };
}

/** The page's range from the address: `range=…`, or `from`/`to`. */
export function rangeFromSearch(search: string | URLSearchParams): PageRange {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const from = params.get("from");
  const to = params.get("to");
  if (validDate(from) && validDate(to)) return { preset: null, ...clampDates(from, to) };
  const preset = params.get("range");
  return { preset: RANGE_PRESETS.includes(preset as RangePreset) ? preset as RangePreset : "7d" };
}

/** Writes the range into a query: `range=7d`, or `from=…&to=…`. */
export function writeRange(params: URLSearchParams, range: PageRange): void {
  if (range.preset !== null) {
    params.set("range", range.preset);
    params.delete("from");
    params.delete("to");
  } else {
    params.delete("range");
    params.set("from", range.from);
    params.set("to", range.to);
  }
}

/** Today's date in a zone, `YYYY-MM-DD`. */
export function todayIn(tz: string, now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}

/** The view an address names: `days`, `projects` or `tokens`. */
export function viewFromSearch(search: string | URLSearchParams): ActivityView {
  const view = (typeof search === "string" ? new URLSearchParams(search) : search).get("view");
  return view === "projects" || view === "tokens" ? view : "days";
}

/** «Розбити за» from the address: `stack`, which is `kind` for «Тип», else `list`; models by default. */
export function byFromSearch(search: string | URLSearchParams): TokenBy {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  for (const value of [params.get("stack"), params.get("list")]) if (TOKEN_BY.includes(value as TokenBy)) return value as TokenBy;
  return "model";
}
