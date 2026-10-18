import { clampMethodParams, zonedDate, zonedDays, type ZonedDay } from "./method";
export const TOKEN_PRESETS = { today: 1, "7d": 7, "30d": 30, "90d": 90, "365d": 365 } as const;
export type TokenPreset = keyof typeof TOKEN_PRESETS;
export interface ActivityDates { from: string; to: string }
export function shiftDay(date: string, amount: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + amount * 86_400_000).toISOString().slice(0, 10);
}
export function weekOfDay(date: string): string {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return shiftDay(date, -(day + 6) % 7);
}
function validDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(at) && at >= 0 && new Date(at).toISOString().slice(0, 10) === value;
}
export function dateRangeDays(dates: ActivityDates, tz: string): ZonedDay[] {
  const out: ZonedDay[] = [];
  for (let date = dates.from; date <= dates.to && out.length < 366; date = shiftDay(date, 1)) out.push(zonedDate(date, tz)!);
  return out;
}
export function parseActivityDates(search: URLSearchParams, now: number, fallbackTz: string) {
  const tz = clampMethodParams({ tz: search.get("tz") ?? fallbackTz }, fallbackTz).tz;
  const today = zonedDays(now, 1, tz)[0]!.date;
  const rawPreset = search.get("range") ?? "7d";
  let preset: TokenPreset | null = Object.hasOwn(TOKEN_PRESETS, rawPreset) ? rawPreset as TokenPreset : "7d";
  let from = shiftDay(today, 1 - TOKEN_PRESETS[preset]), to = today;
  const rawFrom = search.get("from"), rawTo = search.get("to");
  if ((rawFrom === null || validDate(rawFrom)) && (rawTo === null || validDate(rawTo)) && (rawFrom !== null || rawTo !== null)) {
    preset = null; from = rawFrom ?? shiftDay(rawTo!, -6); to = rawTo ?? today;
    if (from > to) [from, to] = [to, from];
    if (to > today) to = today;
    if (from > to) from = to;
    if (from < shiftDay(to, -365)) from = shiftDay(to, -365);
  }
  const days = dateRangeDays({ from, to }, tz);
  return { from, to, tz, preset, days };
}
