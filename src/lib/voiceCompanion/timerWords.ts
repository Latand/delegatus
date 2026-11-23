import type { Locale } from "./contract";
import { clockText } from "./timerTime";

/** What a fired timer's sentence needs. A null label is the unnamed form, and the private form outside its own call. */
export interface FiredTimerFacts { label: string | null; minutes: number; createdAt: number; dueAt: number; timeZone: string | null }
/** `due` as it comes up; `late` when the Viewer was down at its time; `away` when the operator hears of it afterwards. */
export type FiredWording = "due" | "late" | "away";

const plural = (count: number, one: string, few: string, many: string) => {
  if (!Number.isInteger(count)) return few;
  const form = new Intl.PluralRules("uk").select(count);
  return form === "one" ? one : form === "few" ? few : many;
};
const seconds = (minutes: number) => Math.round(minutes * 60);
function englishLength(minutes: number): string {
  return minutes < 1 ? `${seconds(minutes)}-second` : `${minutes}-minute`;
}
function ukrainianLength(minutes: number): string {
  if (minutes < 1) return `${seconds(minutes)} ${plural(seconds(minutes), "секунду", "секунди", "секунд")}`;
  return `${String(minutes).replace(".", ",")} ${plural(minutes, "хвилину", "хвилини", "хвилин")}`;
}

/** The one sentence a fired timer is said or shown with, on every channel. */
export function firedSentence(timer: FiredTimerFacts, locale: Locale, wording: FiredWording): string {
  const due = clockText(timer.dueAt, timer.timeZone);
  const set = clockText(timer.createdAt, timer.timeZone);
  if (locale === "uk") {
    const name = `таймер${timer.label ? ` «${timer.label}»` : ""} на ${ukrainianLength(timer.minutes)}`;
    if (wording === "away") return `Поки вас не було, о ${due} сплив ${name}.`;
    if (wording === "late") return `${name[0]!.toUpperCase()}${name.slice(1)} мав спливти о ${due} і вже сплив.`;
    return `${name[0]!.toUpperCase()}${name.slice(1)}, поставлений о ${set}, сплив.`;
  }
  const name = `the ${englishLength(timer.minutes)} timer${timer.label ? ` «${timer.label}»` : ""}`;
  if (wording === "away") return `While you were away, ${name} came up at ${due}.`;
  if (wording === "late") return `${name[0]!.toUpperCase()}${name.slice(1)} was due at ${due} and is up.`;
  return `${name[0]!.toUpperCase()}${name.slice(1)}, set at ${set}, is up.`;
}

export const firedTitle = (locale: Locale) => locale === "uk" ? "Таймер сплив" : "Timer is up";
