import { expect, test } from "bun:test";
import { VOICE_IMAGES } from "./boardReads";
import type { TranscriptEntry } from "./transcriptRecord";
import { callClockContext, clockAnswer, clockRows, delegationClockLine, elapsedText, localizeSpeech, localizeTimes, relativeText, resolveVoiceClock, voiceClock } from "./voiceClock";

const KYIV = voiceClock("Europe/Kyiv");
const YORK = voiceClock("America/New_York");
/** Kyiv left summer time at 01:00 UTC on 2026-10-25, so 03:30 happened twice that night. */
const KYIV_SUMMER = Date.parse("2026-10-25T00:30:00Z"), KYIV_WINTER = Date.parse("2026-10-25T01:30:00Z");
/** New York left summer time at 06:00 UTC on 2026-11-01, so 01:30 happened twice. */
const YORK_SUMMER = Date.parse("2026-11-01T05:30:00Z"), YORK_WINTER = Date.parse("2026-11-01T06:30:00Z");

test("a clock time is local to the operator's zone and names it", () => {
  const at = Date.parse("2026-11-01T09:30:05Z");
  expect(KYIV.clock(at)).toBe("11:30 Kyiv time");
  expect(KYIV.clock(at, true)).toBe("11:30:05 Kyiv time");
  expect(KYIV.full(at)).toBe("Sunday, November 1, 2026, 11:30:05 Kyiv time (Europe/Kyiv, UTC+2)");
  expect(voiceClock("America/Argentina/Buenos_Aires").clock(at)).toBe("06:30 Buenos Aires time");
  expect(voiceClock("Asia/Kolkata").full(at)).toBe("Sunday, November 1, 2026, 15:00:05 Kolkata time (Asia/Kolkata, UTC+5:30)");
});

test("the zone's old spelling and UTC's aliases read as one name", () => {
  const at = Date.parse("2026-11-01T09:30:00Z");
  expect(voiceClock("Europe/Kiev").clock(at)).toBe("11:30 Kyiv time");
  expect(voiceClock("Europe/Kiev").timeZone).toBe("Europe/Kyiv");
  expect(voiceClock("Etc/UTC").clock(at)).toBe("09:30 UTC");
  expect(voiceClock("UTC").full(at)).toBe("Sunday, November 1, 2026, 09:30:00 UTC");
  // POSIX signs: this zone is three hours behind UTC.
  expect(voiceClock("Etc/GMT+3").clock(at)).toBe("06:30 UTC-3");
});

test("both sides of a daylight-saving change show the same clock, different offsets and the hour that really passed", () => {
  expect(KYIV.clock(KYIV_SUMMER)).toBe(KYIV.clock(KYIV_WINTER));
  expect(KYIV.iso(KYIV_SUMMER)).toBe("2026-10-25T03:30:00+03:00");
  expect(KYIV.iso(KYIV_WINTER)).toBe("2026-10-25T03:30:00+02:00");
  expect(KYIV.offset(KYIV_SUMMER)).toBe("UTC+3");
  expect(KYIV.offset(KYIV_WINTER)).toBe("UTC+2");
  expect(elapsedText(KYIV_WINTER - KYIV_SUMMER)).toBe("1 hour");
  expect(YORK.iso(YORK_SUMMER)).toBe("2026-11-01T01:30:00-04:00");
  expect(YORK.iso(YORK_WINTER)).toBe("2026-11-01T01:30:00-05:00");
  expect(elapsedText(YORK_WINTER - YORK_SUMMER)).toBe("1 hour");
});

test("local ISO reads back as the exact instant, milliseconds included, around each change and over a year", () => {
  const instants = [KYIV_SUMMER, KYIV_WINTER, YORK_SUMMER, YORK_WINTER, Date.parse("2026-10-12T06:37:02.123Z"), Date.parse("2026-03-29T00:59:59.999Z"), Date.parse("2026-03-29T01:00:00.001Z"), 0];
  for (let day = 0; day < 366; day += 1) instants.push(Date.UTC(2026, 0, 1 + day, day % 24, day % 60, day % 60, day * 2 % 1000));
  for (const clock of [KYIV, YORK, voiceClock("Asia/Kolkata"), voiceClock("UTC"), voiceClock("Pacific/Chatham")])
    for (const at of instants) expect(Date.parse(clock.iso(at))).toBe(at);
});

test("a time on another local day names that day, and the operator's calendar decides which day it is", () => {
  const now = Date.parse("2026-11-01T09:30:00Z");
  expect(KYIV.when(Date.parse("2026-11-01T08:00:00Z"), now)).toBe("10:00 Kyiv time");
  // 22:30 UTC on the 31st is already the 1st in Kyiv.
  expect(KYIV.when(Date.parse("2026-10-31T22:30:00Z"), now)).toBe("00:30 Kyiv time");
  expect(KYIV.when(Date.parse("2026-10-31T21:30:00Z"), now)).toBe("Oct 31, 23:30 Kyiv time");
  expect(KYIV.when(Date.parse("2025-10-31T21:30:00Z"), now)).toBe("Oct 31, 2025, 23:30 Kyiv time");
});

test("elapsed time is computed from the two instants, in either order", () => {
  expect(elapsedText(0)).toBe("0 seconds");
  expect(elapsedText(1_000)).toBe("1 second");
  expect(elapsedText(40_000)).toBe("40 seconds");
  expect(elapsedText(90_000)).toBe("1 minute 30 seconds");
  expect(elapsedText(12 * 60_000)).toBe("12 minutes");
  expect(elapsedText(65 * 60_000)).toBe("1 hour 5 minutes");
  expect(elapsedText(2 * 3_600_000)).toBe("2 hours");
  expect(elapsedText(51 * 3_600_000)).toBe("2 days 3 hours");
  expect(elapsedText(-40_000)).toBe("40 seconds");
  const now = Date.parse("2026-11-01T09:30:00Z");
  expect(relativeText(now - 720_000, now)).toBe("12 minutes ago");
  expect(relativeText(now + 7_200_000, now)).toBe("in 2 hours");
  expect(relativeText(now - 400, now)).toBe("just now");
});

test("the zone comes from the browser, else the installation's setting, else labelled UTC", () => {
  expect(resolveVoiceClock("Asia/Tokyo", () => "Europe/Kyiv")).toMatchObject({ timeZone: "Asia/Tokyo", known: true });
  expect(resolveVoiceClock(undefined, () => "Europe/Kyiv")).toMatchObject({ timeZone: "Europe/Kyiv", known: true });
  for (const junk of ["Not/AZone", "", 7, null, "x".repeat(65)]) expect(resolveVoiceClock(junk, () => "Europe/Kyiv")).toMatchObject({ timeZone: "Europe/Kyiv", known: true });
  const unknown = resolveVoiceClock("Not/AZone", () => null);
  expect(unknown).toMatchObject({ timeZone: "UTC", known: false, name: "UTC" });
  expect(resolveVoiceClock(undefined, () => "Not/AZone").known).toBe(false);
  // Real UTC, as chosen, is a known zone.
  expect(resolveVoiceClock("UTC", () => null)).toMatchObject({ timeZone: "UTC", known: true });
});

test("the context lines carry the zone and the local time, and an unknown zone says its times are UTC", () => {
  const now = Date.parse("2026-11-01T09:30:05Z");
  const line = callClockContext(KYIV, now);
  expect(line).toContain("Europe/Kyiv");
  expect(line).toContain("Sunday, November 1, 2026, 11:30:05 Kyiv time");
  expect(delegationClockLine(KYIV, now, now - 720_000)).toContain("Now: Sunday, November 1, 2026, 11:30:05 Kyiv time (Europe/Kyiv, UTC+2). This call has run for 12 minutes.");
  const unknown = voiceClock("UTC", false);
  expect(callClockContext(unknown, now)).toContain("09:30:05 UTC");
  expect(callClockContext(unknown, now)).toContain("not known");
  expect(callClockContext(voiceClock("UTC"), now)).not.toContain("not known");
});

test("a tool's answer reads local: whole-value instants convert, handles and written text stay, attachments survive", () => {
  const now = Date.parse("2026-10-12T07:00:00Z");
  const image = [{ mime: "image/png", data: "AA" }];
  const answer = localizeTimes({ speech: "1 message. Newest at 2026-10-12T06:37:02.000Z, after voice.", before: "2026-10-12T06:37:02.000Z", nextCursor: "2026-10-12T06:37:02Z",
    rows: [{ handle: "m1.0.abc", time: "2026-10-12T06:37:02.000Z", text: "2026-10-12T06:37:02.000Z", after: "voice" }, { time: null, count: 3 }],
    item: { nested: { resetsAt: "2026-10-12T08:00:00Z", start: "2026-10-12T00:00:00+03:00" } }, day: "2026-10-12", naive: "2026-10-12T06:37:02", [VOICE_IMAGES]: image }, KYIV, now);
  expect<unknown>(answer.rows[0]).toEqual({ handle: "m1.0.abc", time: "2026-10-12T09:37:02+03:00", timeRelative: "22 minutes ago", text: "2026-10-12T06:37:02.000Z", after: "voice" });
  expect(answer.rows[1]).toEqual({ time: null, count: 3 });
  expect(answer.item.nested).toMatchObject({ resetsAt: "2026-10-12T11:00:00+03:00", resetsAtRelative: "in 1 hour", start: "2026-10-12T00:00:00+03:00" });
  expect(answer.speech).toBe("1 message. Newest at 09:37 Kyiv time, after voice.");
  expect([answer.before, answer.nextCursor, answer.day, answer.naive]).toEqual(["2026-10-12T06:37:02.000Z", "2026-10-12T06:37:02Z", "2026-10-12", "2026-10-12T06:37:02"]);
  expect(answer[VOICE_IMAGES]).toBe(image);
  expect((answer as unknown as { timesIn: string }).timesIn).toContain("Europe/Kyiv");
});

test("an answer with no time gains nothing, and a sentence with an unparsable instant stays", () => {
  const plain = { status: "done", speech: "No times here.", rows: [{ title: "A task" }] };
  expect(localizeTimes(plain, KYIV, 0)).toEqual(plain);
  expect(localizeTimes(null, KYIV, 0)).toBeNull();
  expect(localizeTimes("text", KYIV, 0)).toBe("text");
  expect(localizeSpeech("At 2026-13-45T99:99:99Z.", KYIV, 0)).toBe("At 2026-13-45T99:99:99Z.");
});

const entry = (kind: TranscriptEntry["kind"], atMs: number, data: Record<string, unknown>): TranscriptEntry => ({ id: `${kind}-${atMs}`, kind, atMs, data });
const JOURNAL: TranscriptEntry[] = [entry("session_start", 0, {}), entry("utterance", 1_000, { text: "What is open?", final: true }), entry("delegation", 1_500, {}),
  entry("tool", 2_000, { name: "list_tasks", status: "done" }), entry("tool", 2_100, { name: "call_clock", status: "done" }), entry("reply", 3_000, { text: "Two tasks.", final: true }),
  entry("request", 4_000, { status: "sent", instruction: "Merge the lane." }), entry("report", 60_000, { status: "result", text: "Merged." }), entry("utterance", 61_000, { text: "   ", final: true }),
  entry("session_end", 62_000, {}), entry("session_start", 70_000, {})];

test("a call's moments cover both speakers, requests, reports and tools; the clock's own calls and empty speech stay out", () => {
  const start = Date.parse("2026-11-01T09:00:00Z");
  expect(clockRows(JOURNAL, JOURNAL.length, start)).toEqual([
    { at: start + 1_000, who: "operator", said: "What is open?" }, { at: start + 2_000, who: "tool", status: "done", tool: "list_tasks" }, { at: start + 3_000, who: "voice", said: "Two tasks." },
    { at: start + 4_000, who: "request", status: "sent", said: "Merge the lane." }, { at: start + 60_000, who: "report", status: "result", said: "Merged." }, { at: start + 70_000, who: "reconnected" },
  ]);
});

test("past the private cut a moment keeps its time and kind, with none of its words or its tool's name", () => {
  const start = Date.parse("2026-11-01T09:00:00Z");
  const rows = clockRows(JOURNAL, 2, start);
  expect(rows[0]).toEqual({ at: start + 1_000, who: "operator", said: "What is open?" });
  expect(rows.slice(1, 5)).toEqual([{ at: start + 2_000, who: "tool", status: "done" }, { at: start + 3_000, who: "voice" }, { at: start + 4_000, who: "request", status: "sent" }, { at: start + 60_000, who: "report", status: "result" }]);
  expect(JSON.stringify(clockRows(JOURNAL, 0, start))).not.toMatch(/list_tasks|Two tasks|Merge the lane|Merged|What is open/u);
});

test("the clock answers now and computes the span between handles and offset times", () => {
  const start = Date.parse("2026-10-25T00:30:00Z"), now = Date.parse("2026-10-25T01:30:00Z");
  const rows = [{ at: start + 1_000, who: "operator" as const, said: "Hello" }, { at: start + 121_000, who: "voice" as const, said: "Hi" }];
  const plain = clockAnswer(rows, start, KYIV, now, { from: null, to: null });
  expect(plain).toMatchObject({ status: "done", timeZone: "Europe/Kyiv", now: "Sunday, October 25, 2026, 03:30:00 Kyiv time (Europe/Kyiv, UTC+2)", callLength: "1 hour" });
  expect(plain.turns.map(row => row.handle)).toEqual(["t1", "t2"]);
  expect(plain).not.toHaveProperty("elapsed");
  expect(clockAnswer(rows, start, KYIV, now, { from: "t1", to: "t2" }).elapsed).toMatchObject({ text: "2 minutes", seconds: 120 });
  expect(clockAnswer(rows, start, KYIV, now, { from: "t2", to: "t1" }).elapsed).toMatchObject({ text: "2 minutes", seconds: 120 });
  // A null end is now, a null start is the call's start.
  expect(clockAnswer(rows, start, KYIV, now, { from: "t1", to: null }).elapsed).toMatchObject({ text: "59 minutes" });
  expect(clockAnswer(rows, start, KYIV, now, { from: null, to: "t2" }).elapsed).toMatchObject({ text: "2 minutes 1 second" });
  // Across the change: a local value read back from another tool counts the hour that passed.
  expect(clockAnswer(rows, start, KYIV, now, { from: KYIV.iso(start), to: KYIV.iso(now) }).elapsed).toMatchObject({ text: "1 hour", seconds: 3_600 });
});

test("a moment the clock cannot read still answers now and the turns, and says so", () => {
  const start = Date.parse("2026-11-01T09:00:00Z"), now = start + 60_000;
  const rows = [{ at: start, who: "operator" as const }];
  for (const from of ["t9", "yesterday", "2026-11-01T11:00:00", "11:30"]) {
    const answer = clockAnswer(rows, start, KYIV, now, { from, to: null });
    expect(answer).toMatchObject({ status: "partial", now: KYIV.full(now) });
    expect(answer).not.toHaveProperty("elapsed");
    expect(answer.turns).toHaveLength(1);
    expect(answer.speech).toContain("could not be read");
  }
  expect(clockAnswer([], start, KYIV, now, {}, true)).toMatchObject({ status: "done", turnsUnavailable: true, turns: [] });
});

test("a long call keeps its newest moments within the bound, and an elided handle still answers", () => {
  const start = Date.parse("2026-11-01T09:00:00Z"), now = start + 3_600_000;
  const rows = Array.from({ length: 500 }, (_, index) => ({ at: start + index * 1_000, who: "operator" as const, said: "x".repeat(60) }));
  const answer = clockAnswer(rows, start, KYIV, now, { from: "t1", to: "t500" });
  expect(Buffer.byteLength(JSON.stringify(localizeTimes(answer, KYIV, now)))).toBeLessThan(4_000);
  expect(answer.turns.at(-1)!.handle).toBe("t500");
  expect(answer.turns[0]!.handle).toBe(`t${500 - answer.turns.length + 1}`);
  expect(answer.earlierTurns).toBe(500 - answer.turns.length);
  expect(answer.elapsed).toMatchObject({ seconds: 499 });
});
