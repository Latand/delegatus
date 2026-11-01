import { isTimeZone, operatorTimeZone } from "@/lib/operator/settings";
import type { TranscriptEntry } from "./transcriptRecord";

/*
 * The one clock every time a voice model reads comes from (docs/design/voice-mode-explained.md, "Time").
 *
 * The zone has one source, resolved once when a call starts: the browser's Intl zone sent with the start, else the
 * installation's operator setting. With neither, times stay in UTC and say so, and the call's context line tells the
 * model the zone is unknown. Elapsed time is computed here from epoch milliseconds, so a daylight-saving change
 * inside a span counts as the hours that really passed; no model does the arithmetic.
 */

export interface VoiceClock {
  /** The IANA name the model reads. */
  timeZone: string;
  /** False when neither the browser nor the setting named a zone, and the times are plain UTC. */
  known: boolean;
  /** How a clock time names its zone: "Kyiv time", "UTC". */
  name: string;
  /** The same instant as ISO with the zone's offset: `2026-11-01T11:30:05+02:00`. Milliseconds stay when present,
   * so the value read back as a tool's `at` or `since` selects the same row. */
  iso(ms: number): string;
  offset(ms: number): string;
  /** `11:30 Kyiv time`, or `11:30:05 Kyiv time`. */
  clock(ms: number, seconds?: boolean): string;
  /** The clock time, with its date when `now` is on another local day. */
  when(ms: number, now: number): string;
  /** `Sunday, November 1, 2026, 11:30:05 Kyiv time (Europe/Kyiv, UTC+2)`. */
  full(ms: number): string;
}

const UTC_NAMES = new Set(["UTC", "Etc/UTC", "UCT", "Etc/UCT", "GMT", "Etc/GMT", "Zulu", "Etc/Zulu", "Universal", "Etc/Universal", "Greenwich", "Etc/Greenwich"]);
const two = (value: number) => String(value).padStart(2, "0");
/** Older browsers still report the old spelling, which the voice would otherwise say aloud. */
const displayZone = (zone: string) => zone === "Europe/Kiev" ? "Europe/Kyiv" : zone;
function zoneName(zone: string): string {
  if (UTC_NAMES.has(zone)) return "UTC";
  // POSIX signs: Etc/GMT+3 is three hours behind UTC.
  const fixed = /^Etc\/GMT([+-])(\d{1,2})$/u.exec(zone);
  if (fixed) return `UTC${fixed[1] === "+" ? "-" : "+"}${fixed[2]}`;
  return `${displayZone(zone).split("/").at(-1)!.replaceAll("_", " ")} time`;
}

export function voiceClock(zone: string, known = true): VoiceClock {
  const timeZone = displayZone(zone);
  const name = zoneName(zone);
  const fields = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const longDay = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const shortDay = new Intl.DateTimeFormat("en-US", { timeZone: zone, month: "short", day: "numeric" });
  const parts = (ms: number) => {
    const read = Object.fromEntries(fields.formatToParts(ms).map(part => [part.type, part.value]));
    return { year: Number(read.year), month: Number(read.month), day: Number(read.day), hour: Number(read.hour) % 24, minute: Number(read.minute), second: Number(read.second) };
  };
  const offsetMinutes = (ms: number) => {
    const at = parts(ms);
    return (Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute, at.second) - Math.floor(ms / 1000) * 1000) / 60_000;
  };
  const offset = (ms: number) => {
    const minutes = offsetMinutes(ms);
    if (minutes === 0) return "UTC";
    const whole = Math.abs(minutes);
    return `UTC${minutes < 0 ? "-" : "+"}${Math.floor(whole / 60)}${whole % 60 ? `:${two(whole % 60)}` : ""}`;
  };
  const clock = (ms: number, seconds = false) => {
    const at = parts(ms);
    return `${two(at.hour)}:${two(at.minute)}${seconds ? `:${two(at.second)}` : ""} ${name}`;
  };
  return { timeZone, known, name, offset, clock,
    iso(ms) {
      const at = parts(ms);
      const minutes = offsetMinutes(ms);
      const whole = Math.abs(minutes);
      const fraction = ((ms % 1000) + 1000) % 1000;
      return `${String(at.year).padStart(4, "0")}-${two(at.month)}-${two(at.day)}T${two(at.hour)}:${two(at.minute)}:${two(at.second)}${fraction ? `.${String(fraction).padStart(3, "0")}` : ""}${minutes < 0 ? "-" : "+"}${two(Math.floor(whole / 60))}:${two(whole % 60)}`;
    },
    when(ms, now) {
      const at = parts(ms), today = parts(now);
      if (at.year === today.year && at.month === today.month && at.day === today.day) return clock(ms);
      return `${shortDay.format(ms)}${at.year === today.year ? "" : `, ${at.year}`}, ${clock(ms)}`;
    },
    full(ms) { return `${longDay.format(ms)}, ${clock(ms, true)}${name === "UTC" ? "" : ` (${timeZone}, ${offset(ms)})`}`; },
  };
}

/** The call's clock: the browser's zone, else the installation's setting, else labelled UTC. A zone that does not parse is
 * ignored, so a bad browser value can never refuse a call. */
export function resolveVoiceClock(browserZone?: unknown, setting: () => string | null = operatorTimeZone): VoiceClock {
  const zone = isTimeZone(browserZone) ? browserZone : setting();
  return isTimeZone(zone) ? voiceClock(zone) : voiceClock("UTC", false);
}

/** `40 seconds`, `1 minute 30 seconds`, `12 minutes`, `1 hour 5 minutes`, `2 days 3 hours`. */
export function elapsedText(ms: number): string {
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const pair = (big: number, bigWord: string, small: number, smallWord: string) => small ? `${unit(big, bigWord)} ${unit(small, smallWord)}` : unit(big, bigWord);
  const seconds = Math.floor(Math.abs(ms) / 1000);
  if (seconds < 60) return unit(seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 10) return pair(minutes, "minute", seconds % 60, "second");
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return pair(hours, "hour", minutes % 60, "minute");
  return pair(Math.floor(hours / 24), "day", hours % 24, "hour");
}
/** `12 minutes ago`, `in 2 hours`, `just now`. */
export function relativeText(at: number, now: number): string {
  const gap = now - at;
  if (Math.abs(gap) < 1000) return "just now";
  return gap > 0 ? `${elapsedText(gap)} ago` : `in ${elapsedText(gap)}`;
}

const INSTANT = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})`;
const WHOLE_INSTANT = new RegExp(`^${INSTANT}$`, "u");
const INSTANTS = new RegExp(`\\b${INSTANT}`, "gu");
const instantOf = (value: unknown) => typeof value === "string" && WHOLE_INSTANT.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
/** Opaque handles keep their exact value, and written text stays as its author wrote it. */
const UNTOUCHED_KEYS = new Set(["nextCursor", "cursor", "before", "handle", "message", "rest", "text", "excerpt", "snippet", "note", "summary", "ask", "instruction"]);

/** Instants inside a sentence this server composed, as clock times. */
export function localizeSpeech(text: string, clock: VoiceClock, now: number): string {
  return text.replace(INSTANTS, match => {
    const at = Date.parse(match);
    return Number.isFinite(at) ? clock.when(at, now) : match;
  });
}

/** A tool's answer as the model reads it: every whole-value instant becomes local ISO with its offset and gains a sibling
 * `<key>Relative` computed here, and `timesIn` names the zone. An array's instants, such as a quota's `[usedPercent, resetsAt]`,
 * keep their places and share one sibling listing theirs in order. Symbol-keyed attachments stay on the object. */
export function localizeTimes<T>(value: T, clock: VoiceClock, now: number): T {
  let found = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(row => {
      const at = instantOf(row);
      if (at === null) return walk(row);
      found = true;
      return clock.iso(at);
    });
    if (!node || typeof node !== "object") return node;
    const copy: Record<string | symbol, unknown> = { ...node as Record<string | symbol, unknown> };
    for (const [name, row] of Object.entries(node)) {
      if (name === "speech" && typeof row === "string") { copy[name] = localizeSpeech(row, clock, now); continue; }
      if (UNTOUCHED_KEYS.has(name)) continue;
      const at = instantOf(row);
      if (at !== null) {
        found = true;
        copy[name] = clock.iso(at);
        copy[`${name}Relative`] = relativeText(at, now);
      } else if (row && typeof row === "object") {
        copy[name] = walk(row);
        const spans = Array.isArray(row) ? row.flatMap(item => instantOf(item) ?? []).map(item => relativeText(item, now)) : [];
        if (spans.length) copy[`${name}Relative`] = spans;
      }
    }
    return copy;
  };
  const result = walk(value);
  if (!found || !result || typeof result !== "object" || Array.isArray(result)) return result as T;
  return { ...result, timesIn: `${clock.name}${clock.known && clock.name !== "UTC" ? ` (${clock.timeZone})` : ""}; each time here carries its UTC offset` } as T;
}

/** Said once in a call's start context. It stops being now as soon as the call goes on. */
export function callClockContext(clock: VoiceClock, now: number): string {
  return `${zoneSentence(clock)} This call started on ${clock.full(now)}. That moment stays fixed, so it is no answer to what time it is now.`;
}
/** Fresh on every delegation. */
export function delegationClockLine(clock: VoiceClock, now: number, startedAt: number): string {
  return `${zoneSentence(clock)} Now: ${clock.full(now)}. This call has run for ${elapsedText(now - startedAt)}.`;
}
function zoneSentence(clock: VoiceClock): string {
  return clock.known ? `The operator's time zone is ${clock.timeZone}.` : "The operator's time zone is not known, so these times are in UTC; say so when you give one.";
}

export interface ClockRow { at: number; who: "operator" | "voice" | "request" | "report" | "tool" | "reconnected"; status?: string; tool?: string; said?: string }
const CLOCK_TOOL = "call_clock";
const GIST_CHARS = 60;
const gist = (text: unknown) => typeof text === "string" && text.trim() ? [...text.replace(/\s+/gu, " ").trim()].slice(0, GIST_CHARS).join("") : undefined;
/** The call's journal as moments, in order. A row at or past `cut` read or followed private history: it keeps its time
 * and kind, and none of its words or its tool's name. */
export function clockRows(entries: readonly TranscriptEntry[], cut: number, startedAt: number): ClockRow[] {
  let starts = 0;
  return entries.flatMap((entry, index): ClockRow[] => {
    const at = startedAt + entry.atMs, open = index < cut, data = entry.data;
    if (entry.kind === "session_start") return starts++ ? [{ at, who: "reconnected" }] : [];
    if (entry.kind === "utterance" || entry.kind === "reply") {
      const said = gist(data.text);
      return said ? [{ at, who: entry.kind === "utterance" ? "operator" : "voice", ...(open ? { said } : {}) }] : [];
    }
    if (entry.kind === "request") return [{ at, who: "request", ...(typeof data.status === "string" ? { status: data.status } : {}), ...(open && gist(data.instruction) ? { said: gist(data.instruction) } : {}) }];
    if (entry.kind === "report") return [{ at, who: "report", ...(typeof data.status === "string" ? { status: data.status } : {}), ...(open && gist(data.text) ? { said: gist(data.text) } : {}) }];
    if (entry.kind === "tool" && data.name !== CLOCK_TOOL) return [{ at, who: "tool", ...(typeof data.status === "string" ? { status: data.status } : {}), ...(open && typeof data.name === "string" ? { tool: data.name } : {}) }];
    return [];
  });
}

const CLOCK_BYTES = 3_000;
/** Each row grows by about this much when its time gains an offset and a relative sibling. */
const ROW_GROWTH_BYTES = 40;
/** The answer to `call_clock`. Instants here stay ISO: `localizeTimes` renders them on the way to the model like every
 * other tool's. Turn handles number the whole call, so a handle stays good after its row leaves the bounded list. A
 * moment that cannot be read still answers with now and the turns, and says which moment it could not read. */
export function clockAnswer(rows: readonly ClockRow[], startedAt: number, clock: VoiceClock, now: number, args: Record<string, unknown>, unavailable = false) {
  const moments = rows.map((row, index) => ({ handle: `t${index + 1}`, time: new Date(row.at).toISOString(), who: row.who, ...(row.status ? { status: row.status } : {}), ...(row.tool ? { tool: row.tool } : {}), ...(row.said ? { said: row.said } : {}) }));
  const turns: typeof moments = [];
  let bytes = 0;
  for (const row of [...moments].reverse()) {
    bytes += Buffer.byteLength(JSON.stringify(row)) + ROW_GROWTH_BYTES;
    if (bytes > CLOCK_BYTES) break;
    turns.unshift(row);
  }
  const moment = (value: unknown, fallback: number): number | null => {
    if (typeof value !== "string" || !value.trim()) return fallback;
    const handled = /^t(\d+)$/u.exec(value.trim());
    if (handled) return rows[Number(handled[1]) - 1]?.at ?? null;
    return instantOf(value.trim());
  };
  const asked = (typeof args.from === "string" && !!args.from.trim()) || (typeof args.to === "string" && !!args.to.trim());
  const from = moment(args.from, startedAt), to = moment(args.to, now);
  const elapsed = asked && from !== null && to !== null ? { text: elapsedText(to - from), seconds: Math.floor(Math.abs(to - from) / 1000), fromTime: new Date(from).toISOString(), toTime: new Date(to).toISOString() } : null;
  const unread = asked && !elapsed;
  return { status: unread ? "partial" : "done", timeZone: clock.timeZone, now: clock.full(now), callStarted: new Date(startedAt).toISOString(), callLength: elapsedText(now - startedAt),
    turns, ...(moments.length > turns.length ? { earlierTurns: moments.length - turns.length } : {}), ...(unavailable ? { turnsUnavailable: true } : {}), ...(elapsed ? { elapsed } : {}),
    speech: unread ? `It is ${clock.when(now, now)}. One of the two moments could not be read: pass a handle from turns, or a time with its UTC offset.`
      : elapsed ? `${elapsed.text} between the two moments. It is ${clock.when(now, now)}.` : `Now: ${clock.full(now)}.` };
}
