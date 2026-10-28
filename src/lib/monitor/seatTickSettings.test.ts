import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-tick-settings-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const {
  applySeatTickSettingsChange,
  defaultSeatTickSettings,
  effectiveSeatTickSettings,
  readSeatTickSettings,
  SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES,
  SEAT_TICK_PROMPT_LIMIT,
  seatTickSettingsAfterLapse,
  seatTickSettingsAreDefault,
  writeSeatTickSettings,
} = await import("./seatTickSettings");
import type { SeatTickSettings, SeatTickSettingsActor } from "./seatTickSettings";

/**
 * The per-project tick settings (#1275): what a project may decide about its
 * own wakes, and what the record has to carry afterwards.
 */

const PROJECT = "viewer";
const HOUR_MS = 60 * 60_000;
const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const AT = new Date(NOW).toISOString();
const NEXT_AT = new Date(NOW + 60_000).toISOString();
const SEAT: SeatTickSettingsActor = {
  kind: "manager",
  conversationId: ["conversation", "0f4c21b7729fbc9e"].join("_"),
  project: PROJECT,
  seatEpoch: 7,
};

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/* One directory per case: the settings live in the `state.sqlite` beside the
   legacy path (#1870 slice 5), so two cases never share a database. */
const settingsFile = () => {
  const directory = path.join(SANDBOX, "settings", crypto.randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, "seat-tick-settings.json");
};

test("Turbo persists its original tier and finite credit approval; expiry clears approval and off preserves restoration work", () => {
  const actor: SeatTickSettingsActor = { kind: "gateway", conversationId: null, project: null, seatEpoch: null };
  const result = applySeatTickSettingsChange(defaultSeatTickSettings(PROJECT), {
    turbo: { enabled: true, hours: 1, credits: true, creditAccounts: ["acct-a"] },
  }, { at: AT, actor, turbo: { allowedAccounts: ["acct-a"], plan: [
    { accountId: "acct-a", label: "Account A", plan: "pro", tiers: { "gpt-6.1-sol": "priority" }, hadCredits: true },
  ] } });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  result.settings.turbo!.switches = [{ conversationId: "conversation_turbo", accountId: "acct-a", model: "gpt-6.1-sol", from: "default", to: "priority", state: "switched", at: AT }];
  const file = settingsFile();
  writeSeatTickSettings(PROJECT, result.settings, file);
  const stored = readSeatTickSettings(PROJECT, file);
  expect(stored.turbo!.switches[0]!.from).toBe("default");
  expect(effectiveSeatTickSettings(stored, NOW + HOUR_MS, HOUR_MS).turbo).toMatchObject({ enabled: false, endReason: "expired", credits: { approved: false } });
  const off = applySeatTickSettingsChange(stored, { turbo: { enabled: false } }, { at: NEXT_AT, actor });
  expect(off.ok).toBe(true);
  if (!off.ok) throw new Error(off.error);
  expect(off.settings.turbo).toMatchObject({ enabled: false, credits: { approved: false }, switches: [{ from: "default", state: "switched" }] });
});

test("legacy imports default invention off even when an imported actor claims a grant", () => {
  const file = settingsFile();
  const actor: SeatTickSettingsActor = { kind: "gateway", project: null, conversationId: null, seatEpoch: null };
  const changed = applySeatTickSettingsChange(defaultSeatTickSettings(PROJECT), { autonomy: { enabled: true, proactive: { enabled: true } } }, { at: AT, actor });
  if (!changed.ok) throw new Error(changed.error);
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects: { [PROJECT]: changed.settings } }));
  const imported = readSeatTickSettings(PROJECT, file);
  expect(imported.autonomy?.enabled).toBe(true);
  expect(imported.autonomy?.proactive?.enabled).toBe(false);
});

test("a persisted child grant survives a fresh process while expiry and a new episode remove it", async () => {
  const file = settingsFile();
  const actor: SeatTickSettingsActor = { kind: "gateway", project: null, conversationId: null, seatEpoch: null };
  const changed = applySeatTickSettingsChange(defaultSeatTickSettings(PROJECT), { autonomy: { enabled: true, proactive: { enabled: true } } }, { at: AT, actor });
  if (!changed.ok) throw new Error(changed.error);
  writeSeatTickSettings(PROJECT, changed.settings, file);
  const script = `import { readSeatTickSettings, effectiveSeatTickSettings } from './src/lib/monitor/seatTickSettings';
    const row = readSeatTickSettings(process.argv[1], process.argv[2]);
    console.log(JSON.stringify([row.autonomy?.proactive, effectiveSeatTickSettings(row, Number(process.argv[3]), 3600000).autonomy?.proactive]));`;
  const child = Bun.spawn([process.execPath, "--eval", script, PROJECT, file, String(NOW + 8 * HOUR_MS)], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const watchdog = setTimeout(() => child.kill(), 15_000);
  try {
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(err).toBe("");
    expect(exit).toBe(0);
    expect(JSON.parse(out)).toEqual([{ enabled: true }, { enabled: false }]);
  } finally { clearTimeout(watchdog); if (child.exitCode === null) child.kill(); await child.exited; }
  const next = applySeatTickSettingsChange(readSeatTickSettings(PROJECT, file), { autonomy: { enabled: true } }, { at: new Date(NOW + 9 * HOUR_MS).toISOString(), actor });
  if (!next.ok) throw new Error(next.error);
  expect(next.settings.autonomy?.proactive?.enabled).toBe(false);
  expect(next.settings.autonomyHistory?.[0]?.proactive?.enabled).toBe(false);
});

function change(current: SeatTickSettings, input: Parameters<typeof applySeatTickSettingsChange>[1]) {
  return applySeatTickSettingsChange(current, input, { at: AT, actor: SEAT });
}

test("a project nobody configured reads the defaults, which are the tick as it shipped", () => {
  const settings = readSeatTickSettings(PROJECT, settingsFile());
  expect(settings).toEqual(defaultSeatTickSettings(PROJECT));
  expect(seatTickSettingsAreDefault(settings)).toBe(true);
  const effective = effectiveSeatTickSettings(settings, NOW, HOUR_MS);
  expect(effective).toMatchObject({ enabled: true, wakeIntervalMs: HOUR_MS, isDefault: true, configured: false, lapsed: false });
});

test("a seat can turn its own project's tick off with no expiry, and it stays off", () => {
  const applied = change(defaultSeatTickSettings(PROJECT), {
    enabled: false,
    reason: "the only open lane is a draft nothing can discharge",
  });
  expect(applied.ok).toBe(true);
  const settings = (applied as { settings: SeatTickSettings }).settings;
  expect(settings).toMatchObject({ enabled: false, until: null, updatedAt: AT, setBy: SEAT });
  /* Two weeks later it is still off: nothing expires a setting that named no
     expiry, which is the point — a bound is a convenience, never a leash. */
  const later = effectiveSeatTickSettings(settings, NOW + 14 * 24 * HOUR_MS, HOUR_MS);
  expect(later).toMatchObject({ enabled: false, isDefault: false, lapsed: false });
  expect(later.reason).toBe("the only open lane is a draft nothing can discharge");
});

test("an expiry lapses back to the default, and the lapse is visible to the caller", () => {
  const applied = change(defaultSeatTickSettings(PROJECT), {
    enabled: false,
    reason: "quiet while the release runs",
    until: new Date(NOW + 30 * 60_000).toISOString(),
  });
  const settings = (applied as { settings: SeatTickSettings }).settings;
  expect(effectiveSeatTickSettings(settings, NOW + 29 * 60_000, HOUR_MS)).toMatchObject({ enabled: false, lapsed: false });
  const after = effectiveSeatTickSettings(settings, NOW + 31 * 60_000, HOUR_MS);
  expect(after).toMatchObject({ enabled: true, wakeIntervalMs: HOUR_MS, isDefault: true, lapsed: true });
  /* Who set the setting that just lapsed survives the lapse, so the board card
     the tick resolves can still say whose decision ended. */
  expect(after.setBy).toEqual(SEAT);
});

test("a cadence is a setting like any other: faster, slower, or back to the default", () => {
  const faster = change(defaultSeatTickSettings(PROJECT), { wakeIntervalMinutes: 15, reason: "a release is going out" });
  expect(effectiveSeatTickSettings((faster as { settings: SeatTickSettings }).settings, NOW, HOUR_MS).wakeIntervalMs).toBe(15 * 60_000);

  const slower = change(defaultSeatTickSettings(PROJECT), { wakeIntervalMinutes: 12 * 60, reason: "nothing moves here faster than half a day" });
  const slowSettings = (slower as { settings: SeatTickSettings }).settings;
  expect(effectiveSeatTickSettings(slowSettings, NOW, HOUR_MS).wakeIntervalMs).toBe(12 * HOUR_MS);

  const restored = change(slowSettings, { wakeIntervalMinutes: null });
  const restoredSettings = (restored as { settings: SeatTickSettings }).settings;
  expect(seatTickSettingsAreDefault(restoredSettings)).toBe(true);
  expect(effectiveSeatTickSettings(restoredSettings, NOW, HOUR_MS)).toMatchObject({ wakeIntervalMs: HOUR_MS, isDefault: true, configured: true });
});

test("operator instructions survive default cadence, schedule restore and expiry alongside the seat note", () => {
  const reason = "Prioritize incoming tasks; stop after the inbox is empty.";
  const monitorPrompt = "Keep the current lane ledger.";
  const initial = settingsOf(change(defaultSeatTickSettings(PROJECT), { reason, monitorPrompt }));
  expect(initial.reason).toBe(reason);
  expect(effectiveSeatTickSettings(initial, NOW, HOUR_MS).reason).toBe(reason);
  const temporary = settingsOf(change(initial, { wakeIntervalMinutes: 30, until: new Date(NOW + 60_000).toISOString() }));
  const restored = settingsOf(change(temporary, { wakeIntervalMinutes: null }));
  expect(restored).toMatchObject({ reason, monitorPrompt, until: null });
  const lapsed = seatTickSettingsAfterLapse(PROJECT, effectiveSeatTickSettings(temporary, NOW + 60_001, HOUR_MS));
  expect(lapsed).toMatchObject({ reason, monitorPrompt, wakeIntervalMinutes: null, until: null });
  const file = settingsFile();
  writeSeatTickSettings(PROJECT, lapsed, file);
  expect(readSeatTickSettings(PROJECT, file)).toMatchObject({ reason, monitorPrompt });
  expect(settingsOf(change(lapsed, { reason: null }))).toMatchObject({ reason: null, monitorPrompt });
});

test("operator instructions over the storage limit are refused without dropping their tail", () => {
  const current = { ...defaultSeatTickSettings(PROJECT), reason: "Keep these instructions." };
  const result = change(current, { reason: "x".repeat(501) });
  /* Named as the total that would be stored: the unattributed line, a newline and the 501 sent. */
  expect(result).toEqual({ ok: false, error: "instructions (reason) are 526 characters; the limit is 500. Nothing was stored — shorten the instructions and send them again" });
  expect(current.reason).toBe("Keep these instructions.");
});

test("a change that leaves the default without a reason is refused; restoring it needs none", () => {
  expect(change(defaultSeatTickSettings(PROJECT), { enabled: false })).toEqual({
    ok: false,
    error: "instructions (reason) are required when the tick is disabled or its wake interval changes. Write what the seat should do and when it should stop; a quiet tick without instructions is indistinguishable from a broken one",
  });
  const off = (change(defaultSeatTickSettings(PROJECT), { enabled: false, reason: "nothing here for me" }) as { settings: SeatTickSettings }).settings;
  const back = change(off, { enabled: true });
  expect(back.ok).toBe(true);
  /* Restoring the schedule preserves the standing panel instructions. */
  expect((back as { settings: SeatTickSettings }).settings).toMatchObject({
    enabled: true,
    wakeIntervalMinutes: null,
    reason: "nothing here for me",
    until: null,
    setBy: SEAT,
  });
});

test("an empty change, a nonsense interval and a nonsense expiry are each named", () => {
  expect(change(defaultSeatTickSettings(PROJECT), {})).toEqual({ ok: false, error: "a tick settings change needs at least one field" });
  expect(change(defaultSeatTickSettings(PROJECT), { wakeIntervalMinutes: 0, reason: "x" }).ok).toBe(false);
  expect(change(defaultSeatTickSettings(PROJECT), { wakeIntervalMinutes: SEAT_TICK_MAX_WAKE_INTERVAL_MINUTES + 1, reason: "x" }).ok).toBe(false);
  expect(change(defaultSeatTickSettings(PROJECT), { until: "not a time", reason: "x", enabled: false }).ok).toBe(false);
});

test("a change made by another project's seat records whose decision it was", () => {
  const foreign: SeatTickSettingsActor = { kind: "manager", conversationId: SEAT.conversationId, project: "another-project", seatEpoch: 3 };
  const applied = applySeatTickSettingsChange(
    defaultSeatTickSettings(PROJECT),
    { enabled: false, reason: "this board is mine to quiet while the migration runs" },
    { at: AT, actor: foreign },
  );
  expect((applied as { settings: SeatTickSettings }).settings.setBy).toEqual(foreign);
});

test("the reason is redacted and bounded before it is stored anywhere", () => {
  const applied = change(defaultSeatTickSettings(PROJECT), {
    enabled: false,
    reason: `nothing to do; see ${["", "home", "someone", "notes.md"].join("/")}`,
  });
  const stored = (applied as { settings: SeatTickSettings }).settings.reason ?? "";
  expect(stored).toContain("nothing to do");
  expect(stored).not.toContain("someone");
});

test("the row survives a write and a read, and one project's write leaves the others alone", () => {
  const file = settingsFile();
  const off = (change(defaultSeatTickSettings(PROJECT), { enabled: false, reason: "nothing here for me" }) as { settings: SeatTickSettings }).settings;
  writeSeatTickSettings(PROJECT, off, file);
  writeSeatTickSettings("other", (change(defaultSeatTickSettings("other"), { wakeIntervalMinutes: 30, reason: "busy board" }) as { settings: SeatTickSettings }).settings, file);
  expect(readSeatTickSettings(PROJECT, file)).toEqual(off);
  expect(readSeatTickSettings("other", file)).toMatchObject({ project: "other", enabled: true, wakeIntervalMinutes: 30 });
  expect(readSeatTickSettings("never-configured", file)).toEqual(defaultSeatTickSettings("never-configured"));
});

test("an unreadable settings file reads as an unconfigured project rather than stopping every tick", () => {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ this is not json", "utf8");
  expect(readSeatTickSettings(PROJECT, file)).toEqual(defaultSeatTickSettings(PROJECT));
});

/* ------------------------------------------------------------------------- *
 * The seat's own additional prompt for its monitor (#1280).
 *
 * The field the requester asked for by name: a seat can say what its monitor
 * should look at, and those words ride the wakes the Viewer's scheduler fires
 * afterwards. Every case here is about the record, because the record is what
 * a later check reads — the echo of the call that wrote it proves nothing.
 * ------------------------------------------------------------------------- */

function settingsOf(result: ReturnType<typeof change>): SeatTickSettings {
  expect(result.ok).toBe(true);
  return (result as { settings: SeatTickSettings }).settings;
}

test("a prompt is set, replaced and cleared through the same record", () => {
  const set = settingsOf(change(defaultSeatTickSettings(PROJECT), { monitorPrompt: "watch the deploy ledger before anything else" }));
  expect(set.monitorPrompt).toBe("watch the deploy ledger before anything else");

  const replaced = settingsOf(change(set, { monitorPrompt: "the ledger is settled; watch the review rounds instead" }));
  expect(replaced.monitorPrompt).toBe("the ledger is settled; watch the review rounds instead");

  const cleared = settingsOf(change(replaced, { monitorPrompt: null }));
  expect(cleared.monitorPrompt).toBeNull();
  /* Cleared is the state a project that never wrote one is in, so the wake it
     gets afterwards is the wake it got before any of this. */
  expect(effectiveSeatTickSettings(cleared, NOW, HOUR_MS).monitorPrompt).toBeNull();
});

test("a prompt needs no reason and leaves the project on the default tick", () => {
  const settings = settingsOf(change(defaultSeatTickSettings(PROJECT), { monitorPrompt: "check whether the nightly digest actually sent" }));
  /* No reason was given and none is owed: a prompt cannot quiet a tick, so
     there is no quiet tick here for a reason to explain. */
  expect(settings.reason).toBeNull();
  expect(seatTickSettingsAreDefault(settings)).toBe(true);
  const effective = effectiveSeatTickSettings(settings, NOW, HOUR_MS);
  expect(effective).toMatchObject({ enabled: true, wakeIntervalMs: HOUR_MS, isDefault: true, lapsed: false });
  expect(effective.monitorPrompt).toBe("check whether the nightly digest actually sent");
});

test("a prompt is redacted and bounded before it is stored anywhere", () => {
  const leaky = settingsOf(change(defaultSeatTickSettings(PROJECT), {
    monitorPrompt: `read the notes at ${["", "home", "someone", "monitor.md"].join("/")} each wake`,
  }));
  expect(leaky.monitorPrompt).toContain("read the notes at");
  expect(leaky.monitorPrompt).not.toContain("someone");

  /* A note that fills the whole allowance is stored whole: the first cap cut
     silently at a thousand characters and a seat lost the tail of every state
     note it wrote (#1450). */
  const full = settingsOf(change(defaultSeatTickSettings(PROJECT), { monitorPrompt: "w".repeat(SEAT_TICK_PROMPT_LIMIT) }));
  expect(full.monitorPrompt).toHaveLength(SEAT_TICK_PROMPT_LIMIT);
  expect(full.monitorPrompt!.endsWith("…")).toBe(false);
});

test("a prompt over the limit is refused with the limit and its own length, and nothing is stored (#1450)", () => {
  const kept = settingsOf(change(defaultSeatTickSettings(PROJECT), { monitorPrompt: "the note that stands" }));
  expect(SEAT_TICK_PROMPT_LIMIT).toBe(16_000);
  const result = change(kept, { monitorPrompt: "w".repeat(SEAT_TICK_PROMPT_LIMIT + 500) });
  expect(result).toEqual({
    ok: false,
    error: `monitorPrompt is ${SEAT_TICK_PROMPT_LIMIT + 500} characters; the limit is ${SEAT_TICK_PROMPT_LIMIT}. Nothing was stored — shorten the note and send it again`,
  });
  /* The refusal is a refusal of the whole change: the record it was applied to
     is untouched, there is no truncated version of the note anywhere. */
  expect(kept.monitorPrompt).toBe("the note that stands");
});

test("an over-long prompt already on disk still loads, clamped, so an old file never stops a check (#1450)", () => {
  const file = settingsFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    projects: { [PROJECT]: { ...defaultSeatTickSettings(PROJECT), monitorPrompt: "n".repeat(SEAT_TICK_PROMPT_LIMIT + 5), updatedAt: new Date(NOW).toISOString() } },
  }));
  const loaded = readSeatTickSettings(PROJECT, file);
  expect(loaded.monitorPrompt).toHaveLength(SEAT_TICK_PROMPT_LIMIT);
  expect(loaded.updatedAt).toBe(new Date(NOW).toISOString());
});

test("the prompt is untouched by the settings around it: quieting, restoring, and the expiry", () => {
  const withPrompt = settingsOf(change(defaultSeatTickSettings(PROJECT), { monitorPrompt: "the release is the only thing that matters here" }));

  const off = settingsOf(change(withPrompt, { enabled: false, reason: "nothing here for me until the release lands" }));
  expect(off).toMatchObject({ enabled: false, monitorPrompt: "the release is the only thing that matters here" });

  /* Restoring the schedule keeps both instruction fields. */
  const back = settingsOf(change(off, { enabled: true }));
  expect(back).toMatchObject({ enabled: true, reason: off.reason, until: null, monitorPrompt: "the release is the only thing that matters here" });

  /* Nor does an expiry set for the schedule take the prompt with it: the row
     the lapse writes back is the default tick, still carrying the words. */
  const expiring = settingsOf(change(withPrompt, {
    enabled: false,
    reason: "quiet while the release runs",
    until: new Date(NOW + 30 * 60_000).toISOString(),
  }));
  const lapsed = effectiveSeatTickSettings(expiring, NOW + 31 * 60_000, HOUR_MS);
  expect(lapsed).toMatchObject({ enabled: true, isDefault: true, lapsed: true });
  expect(lapsed.monitorPrompt).toBe("the release is the only thing that matters here");
  expect(seatTickSettingsAfterLapse(PROJECT, lapsed)).toMatchObject({
    enabled: true,
    wakeIntervalMinutes: null,
    reason: expiring.reason,
    until: null,
    monitorPrompt: "the release is the only thing that matters here",
  });
});

test("a lapse with no seat note keeps the operator instructions on the default schedule", () => {
  const expiring = settingsOf(change(defaultSeatTickSettings(PROJECT), {
    enabled: false,
    reason: "quiet while the release runs",
    until: new Date(NOW + 30 * 60_000).toISOString(),
  }));
  const lapsed = effectiveSeatTickSettings(expiring, NOW + 31 * 60_000, HOUR_MS);
  expect(seatTickSettingsAfterLapse(PROJECT, lapsed)).toEqual({ ...defaultSeatTickSettings(PROJECT), reason: expiring.reason, instructionLines: expiring.instructionLines, updatedAt: expiring.updatedAt, setBy: expiring.setBy });
});

test("a prompt survives the write and the read a later check does", () => {
  const file = settingsFile();
  const settings = settingsOf(change(defaultSeatTickSettings(PROJECT), { monitorPrompt: "start from the oldest blocked card" }));
  writeSeatTickSettings(PROJECT, settings, file);
  expect(readSeatTickSettings(PROJECT, file).monitorPrompt).toBe("start from the oldest blocked card");
  /* And it is one project's, like every other field on the row. */
  expect(readSeatTickSettings("other", file).monitorPrompt).toBeNull();
});

test("a prompt that is neither a string nor null is named rather than stored", () => {
  expect(change(defaultSeatTickSettings(PROJECT), { monitorPrompt: 7 as never })).toEqual({
    ok: false,
    error: "monitorPrompt must be a string, or null to clear it",
  });
});


test("maintenance needs no reason, clamps hours and survives tick expiry", () => {
  const actor = { kind: "gateway" as const, conversationId: null, project: null, seatEpoch: null };
  const at = "2026-09-30T12:00:00Z";
  const current = defaultSeatTickSettings("fixture-maintenance");
  const result = applySeatTickSettingsChange(current, { maintenance: { enabled: true, intervalHours: "0.5" } }, { at, actor });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.settings.maintenance?.intervalHours).toBe(1); expect(result.notes?.length).toBeGreaterThan(0);
  expect(seatTickSettingsAreDefault(result.settings)).toBe(true);
  const expiry = effectiveSeatTickSettings({ ...result.settings, enabled: false, reason: "fixture wait", until: at }, Date.parse(at) + 1, 3600000);
  expect(expiry.maintenance.enabled).toBe(true);
  expect(seatTickSettingsAfterLapse("fixture-maintenance", expiry).maintenance?.enabled).toBe(true);
  const reset = applySeatTickSettingsChange(result.settings, { maintenance: { intervalHours: null } }, { at, actor });
  if (!reset.ok) throw new Error(reset.error); expect(reset.settings.maintenance?.intervalHours).toBe(3);
  const invalid = applySeatTickSettingsChange(current, { maintenance: { enabled: "yes" as never } }, { at, actor }); expect(invalid.ok).toBe(false);
});

test("auto-rotation requires a reason from every agent, attributes changes and survives schedule lapse", () => {
  const current = defaultSeatTickSettings(PROJECT);
  expect(current.autoRotate).toBeUndefined();
  expect(change(current, { autoRotate: { enabled: true } })).toMatchObject({ ok: false, error: expect.stringContaining("autoRotate.why is required") });
  const armed = settingsOf(change(current, { autoRotate: { enabled: true, thresholdPercent: 95, why: "operator requested in chat" } }));
  expect(armed.autoRotate).toEqual({ enabled: true, thresholdPercent: 90, updatedAt: AT, setBy: SEAT, why: "operator requested in chat" });
  const reset = settingsOf(change(armed, { autoRotate: { thresholdPercent: null, why: "operator requested default" } }));
  expect(reset.autoRotate?.thresholdPercent).toBe(50);
  const temporary = settingsOf(change(armed, { wakeIntervalMinutes: 30, reason: "pause routine wakes", until: new Date(NOW + 60_000).toISOString() }));
  expect(seatTickSettingsAfterLapse(PROJECT, effectiveSeatTickSettings(temporary, NOW + 60_001, HOUR_MS)).autoRotate).toEqual(armed.autoRotate);
  expect(settingsOf(change(temporary, { wakeIntervalMinutes: null })).autoRotate).toEqual(armed.autoRotate);
  const gateway = applySeatTickSettingsChange(current, { autoRotate: { enabled: true } }, { at: AT, actor: { ...SEAT, kind: "gateway" } });
  expect(gateway.ok).toBe(true);
  const file = settingsFile(); writeSeatTickSettings(PROJECT, armed, file);
  expect(readSeatTickSettings(PROJECT, file).autoRotate).toEqual(armed.autoRotate);
});


test("seat edits preserve operator lines verbatim with their original write dates", () => {
  const operator: SeatTickSettingsActor = { kind: "gateway", conversationId: null, project: null, seatEpoch: null };
  const initial = settingsOf(applySeatTickSettingsChange(defaultSeatTickSettings(PROJECT), { reason: "Keep  this line.\nSecond instruction." }, { at: AT, actor: operator }));
  const later = "2026-08-29T12:00:00.000Z";
  const noted = settingsOf(applySeatTickSettingsChange(initial, { reason: "Release paused." }, { at: later, actor: SEAT }));
  expect(noted.reason).toBe("Keep  this line.\nSecond instruction.\nRelease paused.");
  expect(noted.instructionLines).toEqual([
    { text: "Keep  this line.", at: AT, author: operator },
    { text: "Second instruction.", at: AT, author: operator },
    { text: "Release paused.", at: later, author: SEAT },
  ]);
  const edited = settingsOf(applySeatTickSettingsChange(noted, { reason: "Release resumed." }, { at: later, actor: SEAT }));
  expect(edited.instructionLines?.slice(0, 2)).toEqual(initial.instructionLines);
  expect(edited.reason).toBe("Keep  this line.\nSecond instruction.\nRelease resumed.");
  const cleared = settingsOf(applySeatTickSettingsChange(edited, { reason: null }, { at: later, actor: SEAT }));
  expect(cleared.reason).toBe(initial.reason);
});

test("the operator can remove migrated unknown text and save a replacement within the full field limit", () => {
  const legacy = { ...defaultSeatTickSettings(PROJECT), reason: "u".repeat(500) };
  const result = applySeatTickSettingsChange(legacy, {
    reason: "New operator instruction.",
    clearUnknownInstructions: true,
  }, { at: AT, actor: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } });
  expect(result.ok).toBe(true);
  expect(settingsOf(result).reason).toBe("New operator instruction.");
  expect(settingsOf(result).instructionLines).toEqual([
    { text: "New operator instruction.", author: { kind: "gateway", conversationId: null, project: null, seatEpoch: null }, at: AT },
  ]);
});

test("a seat cannot clear migrated unknown instructions", () => {
  const legacy = { ...defaultSeatTickSettings(PROJECT), reason: "u".repeat(500) };
  const result = applySeatTickSettingsChange(legacy, { clearUnknownInstructions: true }, {
    at: AT, actor: SEAT, instructionActor: SEAT,
  });
  expect(result).toEqual({ ok: false, error: "only an operator can remove instructions with unknown authors" });
  expect(legacy.reason).toBe("u".repeat(500));
});

test("the operator can replace full seat-authored instructions without changing the schedule", () => {
  const operator: SeatTickSettingsActor = { kind: "gateway", conversationId: null, project: null, seatEpoch: null };
  const seat: SeatTickSettingsActor = { kind: "manager", conversationId: "seat-full-field", project: PROJECT, seatEpoch: 4 };
  const current = {
    ...defaultSeatTickSettings(PROJECT), enabled: false, wakeIntervalMinutes: 30,
    reason: "s".repeat(500), instructionLines: [{ text: "s".repeat(500), author: seat, at: AT }],
  };
  const result = applySeatTickSettingsChange(current, { replaceOtherInstructions: true, reason: "Replacement from operator." }, { at: NEXT_AT, actor: operator });
  expect(result.ok).toBe(true);
  expect(settingsOf(result)).toMatchObject({
    enabled: false, wakeIntervalMinutes: 30, reason: "Replacement from operator.",
    instructionLines: [{ text: "Replacement from operator.", author: operator, at: NEXT_AT }],
  });
});

test("replacing other instructions requires an operator and a non-empty replacement", () => {
  const seat: SeatTickSettingsActor = { kind: "manager", conversationId: "seat-full-field", project: PROJECT, seatEpoch: 4 };
  const current = { ...defaultSeatTickSettings(PROJECT), reason: "Seat note.", instructionLines: [{ text: "Seat note.", author: seat, at: AT }] };
  expect(applySeatTickSettingsChange(current, { replaceOtherInstructions: true, reason: "Replacement." }, { at: NEXT_AT, actor: seat })).toEqual({ ok: false, error: "only an operator can replace other authors’ instructions" });
  expect(applySeatTickSettingsChange(current, { replaceOtherInstructions: true }, { at: NEXT_AT, actor: { kind: "gateway", conversationId: null, project: null, seatEpoch: null } })).toEqual({ ok: false, error: "an operator replacement is required when replacing other authors’ instructions" });
  expect(current.reason).toBe("Seat note.");
});


/* The panel's field holds the operator's lines and the lines with no known
   author; seat notes stay out of it. These records are built the way they
   arise: an older reason with no attribution, then a seat writing its note. */
const OPERATOR: SeatTickSettingsActor = { kind: "gateway", conversationId: null, project: null, seatEpoch: null };
const LEGACY = "Синтетичний старий рядок без автора, щоб перевірити ліміт поля. ".repeat(7).slice(0, 495).trimEnd().padEnd(495, ".");
const asOperator = (current: SeatTickSettings, change: Parameters<typeof applySeatTickSettingsChange>[1]) =>
  applySeatTickSettingsChange(current, change, { at: NEXT_AT, actor: OPERATOR });
const legacyWithNote = () => settingsOf(applySeatTickSettingsChange({ ...defaultSeatTickSettings(PROJECT), reason: "Older line one.\nOlder line two." }, { reason: "Seat note." }, { at: AT, actor: SEAT }));

test("the operator's field claims lines with no known author: 495 + «читай» is refused, a shortened line is stored as the operator's", () => {
  const legacy = { ...defaultSeatTickSettings(PROJECT), reason: LEGACY };
  expect(LEGACY.length).toBe(495);
  const over = asOperator(legacy, { reason: `${LEGACY}\nчитай`, clearUnknownInstructions: true });
  expect(over).toEqual({ ok: false, error: "instructions (reason) are 501 characters; the limit is 500. Nothing was stored — shorten the instructions and send them again" });
  expect(legacy.reason).toBe(LEGACY);
  const shortened = settingsOf(asOperator(legacy, { reason: `${LEGACY.slice(0, 200)}\nчитай`, clearUnknownInstructions: true }));
  expect(shortened.reason).toBe(`${LEGACY.slice(0, 200)}\nчитай`);
  expect(shortened.instructionLines).toEqual([
    { text: LEGACY.slice(0, 200), author: OPERATOR, at: NEXT_AT },
    { text: "читай", author: OPERATOR, at: NEXT_AT },
  ]);
  const deleted = settingsOf(asOperator(legacy, { reason: "читай", clearUnknownInstructions: true }));
  expect(deleted.instructionLines).toEqual([{ text: "читай", author: OPERATOR, at: NEXT_AT }]);
  const file = settingsFile();
  writeSeatTickSettings(PROJECT, shortened, file);
  expect(readSeatTickSettings(PROJECT, file).instructionLines).toEqual(shortened.instructionLines!);
});

test("an unchanged line with no known author keeps its entry, and the seat note stays byte-identical", () => {
  const current = legacyWithNote();
  expect(current.instructionLines).toEqual([
    { text: "Older line one.", author: null, at: null },
    { text: "Older line two.", author: null, at: null },
    { text: "Seat note.", author: SEAT, at: AT },
  ]);
  const edited = settingsOf(asOperator(current, { reason: "Older line one.\nNew operator line.", clearUnknownInstructions: true }));
  expect(edited.instructionLines).toEqual([
    { text: "Older line one.", author: null, at: null },
    { text: "New operator line.", author: OPERATOR, at: NEXT_AT },
    current.instructionLines![2]!,
  ]);
  expect(edited.reason).toBe("Older line one.\nNew operator line.\nSeat note.");
  const emptied = settingsOf(asOperator(current, { reason: null, clearUnknownInstructions: true }));
  expect(emptied.instructionLines).toEqual([current.instructionLines![2]!]);
});

test("without the claim, an operator reason leaves lines with no known author alone, and a seat cannot claim them", () => {
  const current = legacyWithNote();
  const plain = settingsOf(asOperator(current, { reason: "Operator line." }));
  expect(plain.instructionLines).toEqual([...current.instructionLines!, { text: "Operator line.", author: OPERATOR, at: NEXT_AT }]);
  expect(applySeatTickSettingsChange(current, { reason: "Seat rewrite.", clearUnknownInstructions: true }, { at: NEXT_AT, actor: SEAT, instructionActor: SEAT }))
    .toEqual({ ok: false, error: "only an operator can remove instructions with unknown authors" });
});

const AGENT: SeatTickSettingsActor = { kind: "agent", conversationId: "conversation_agent", project: "other", seatEpoch: null };
const twoNotes = () => settingsOf(applySeatTickSettingsChange(legacyWithNote(), { reason: "Agent note." }, { at: NEXT_AT, actor: AGENT }));
const removal = (line: { text: string; at: string | null }, index: number) => ({ index, text: line.text, at: line.at });

test("the operator removes seat notes by index, text and date in one change; every other line keeps its entry", () => {
  const current = twoNotes();
  const lines = current.instructionLines!;
  expect(lines.map(line => line.text)).toEqual(["Older line one.", "Older line two.", "Seat note.", "Agent note."]);
  const one = settingsOf(asOperator(current, { removeSeatNotes: [removal(lines[2]!, 2)] }));
  expect(one.instructionLines).toEqual([lines[0]!, lines[1]!, lines[3]!]);
  expect(one.reason).toBe("Older line one.\nOlder line two.\nAgent note.");
  const both = settingsOf(asOperator(current, { removeSeatNotes: [removal(lines[3]!, 3), removal(lines[2]!, 2)] }));
  expect(both.instructionLines).toEqual([lines[0]!, lines[1]!]);
  /* With the field's edit in the same change: indexes name the stored lines. */
  const edited = settingsOf(asOperator(current, { reason: "Older line one.\nRewritten.", clearUnknownInstructions: true, removeSeatNotes: [removal(lines[2]!, 2)] }));
  expect(edited.instructionLines).toEqual([lines[0]!, { text: "Rewritten.", author: OPERATOR, at: NEXT_AT }, lines[3]!]);
  const only = settingsOf(asOperator({ ...defaultSeatTickSettings(PROJECT), reason: "Seat note.", instructionLines: [lines[2]!] }, { removeSeatNotes: [removal(lines[2]!, 0)] }));
  expect(only.reason).toBeNull();
  expect(only.instructionLines).toEqual([]);
});

test("a removal that does not match the stored seat note refuses the whole change and stores nothing", () => {
  const current = twoNotes();
  const lines = current.instructionLines!;
  const stale = { ok: false as const, error: "a seat note to remove is no longer stored as the panel read it. Nothing was stored — check the notes and save again" };
  const cases: unknown[][] = [
    [{ index: 3, text: "Seat note.", at: AT }],
    [{ index: 2, text: "Seat note, rewritten.", at: AT }],
    [{ index: 2, text: "Seat note.", at: NEXT_AT }],
    [{ index: 4, text: "Seat note.", at: AT }],
    [removal(lines[2]!, 2), removal(lines[2]!, 2)],
    [removal(lines[0]!, 0)],
    [removal(lines[3]!, 3), { index: 2, text: "Gone.", at: AT }],
  ];
  for (const removeSeatNotes of cases) {
    expect(asOperator(current, { reason: "Older line one.", clearUnknownInstructions: true, removeSeatNotes: removeSeatNotes as never })).toEqual(stale);
  }
  const operatorLine = settingsOf(asOperator(current, { reason: "Operator line." }));
  const operatorIndex = operatorLine.instructionLines!.findIndex(line => line.author?.kind === "gateway");
  expect(asOperator(operatorLine, { removeSeatNotes: [removal(operatorLine.instructionLines![operatorIndex]!, operatorIndex)] })).toEqual(stale);
  for (const malformed of [{}, [{ index: "2", text: "Seat note.", at: AT }], [{ index: -1, text: "Seat note.", at: AT }], [{ index: 2, text: "Seat note." }], [null]]) {
    expect(asOperator(current, { removeSeatNotes: malformed as never })).toEqual({ ok: false, error: "removeSeatNotes must be a list of { index, text, at } naming stored seat notes" });
  }
  expect(current.instructionLines).toEqual(lines);
});

test("only an operator removes seat notes, and never beside a change that rewrites the lines first", () => {
  const current = twoNotes();
  const note = [removal(current.instructionLines![2]!, 2)];
  expect(applySeatTickSettingsChange(current, { removeSeatNotes: note }, { at: NEXT_AT, actor: SEAT, instructionActor: SEAT })).toEqual({ ok: false, error: "only an operator can remove seat notes" });
  expect(applySeatTickSettingsChange(current, { removeSeatNotes: note }, { at: NEXT_AT, actor: OPERATOR, instructionActor: { ...OPERATOR, kind: "unidentified" } })).toEqual({ ok: false, error: "only an operator can remove seat notes" });
  const refusal = { ok: false as const, error: "removeSeatNotes goes with the operator's own reason only, not with replaceOtherInstructions or a clearUnknownInstructions without reason" };
  expect(asOperator(current, { removeSeatNotes: note, replaceOtherInstructions: true, reason: "Replacement." })).toEqual(refusal);
  expect(asOperator(current, { removeSeatNotes: note, clearUnknownInstructions: true })).toEqual(refusal);
});

test("the panel's preview of an edit is what the server stores, and the limit counts that", async () => {
  const { previewSeatTickInstructions } = await import("./seatTickInstructions");
  const current = twoNotes();
  const lines = current.instructionLines!;
  const edit = { text: `Older line one.\n${"x".repeat(450)}`, claimUnknown: true, removeSeatNotes: [removal(lines[3]!, 3)] };
  const preview = previewSeatTickInstructions(current, edit, OPERATOR, NEXT_AT);
  const stored = settingsOf(asOperator(current, { reason: edit.text, clearUnknownInstructions: true, removeSeatNotes: edit.removeSeatNotes }));
  expect(preview).toEqual({ ok: true, lines: stored.instructionLines! });
  const length = stored.reason!.length;
  expect(length).toBe(edit.text.length + 1 + "Seat note.".length);
  /* One more character than the limit allows, counted the same way, is refused. */
  const over = `${edit.text}${"x".repeat(500 - length + 1)}`;
  const overPreview = previewSeatTickInstructions(current, { ...edit, text: over }, OPERATOR, NEXT_AT);
  expect(overPreview.ok && overPreview.lines.map(line => line.text).join("\n").length).toBe(501);
  expect(asOperator(current, { reason: over, clearUnknownInstructions: true, removeSeatNotes: edit.removeSeatNotes }))
    .toEqual({ ok: false, error: "instructions (reason) are 501 characters; the limit is 500. Nothing was stored — shorten the instructions and send them again" });
});

test("a field alone over the limit is refused with the total the panel previews, seat notes included", async () => {
  const { previewSeatTickInstructions } = await import("./seatTickInstructions");
  const refusal = (count: number) => ({ ok: false as const, error: `instructions (reason) are ${count} characters; the limit is 500. Nothing was stored — shorten the instructions and send them again` });
  const previewed = (current: SeatTickSettings, text: string, claimUnknown = false) => {
    const preview = previewSeatTickInstructions(current, { text, claimUnknown }, OPERATOR, NEXT_AT);
    return preview.ok ? preview.lines.map(line => line.text).join("\n").length : null;
  };
  const noted = settingsOf(applySeatTickSettingsChange(defaultSeatTickSettings(PROJECT), { reason: "Note." }, { at: AT, actor: SEAT }));
  const field = "x".repeat(501);
  expect(previewed(noted, field)).toBe(507);
  expect(asOperator(noted, { reason: field })).toEqual(refusal(507));
  /* Stored before the limit counted seat notes: already 501 together. */
  const legacy = { ...defaultSeatTickSettings(PROJECT), reason: `${LEGACY}\nNote.`, instructionLines: [{ text: LEGACY, author: null, at: null }, { text: "Note.", author: SEAT, at: AT }] };
  expect(previewed(legacy, `${LEGACY}\nчитай`, true)).toBe(507);
  expect(asOperator(legacy, { reason: `${LEGACY}\nчитай`, clearUnknownInstructions: true })).toEqual(refusal(507));
  /* A removal that no longer matches leaves nothing to preview; the length sent is named. */
  expect(asOperator(noted, { reason: field, removeSeatNotes: [{ index: 0, text: "Other.", at: AT }] })).toEqual(refusal(501));
  expect(noted.reason).toBe("Note.");
});


test("a new seat epoch preserves its predecessor, unchanged dates and the operator's lines", () => {
  const nextAt = "2026-08-29T12:00:00.000Z";
  const initial = settingsOf(change(defaultSeatTickSettings(PROJECT), { reason: "Unchanged note.\nOld note." }));
  const edited = settingsOf(applySeatTickSettingsChange(initial, { reason: "Unchanged note.\nNew note." }, { at: nextAt, actor: SEAT }));
  expect(edited.instructionLines?.map(line => line.at)).toEqual([AT, nextAt]);
  const successor = { ...SEAT, seatEpoch: 8, conversationId: "conversation_successor" };
  const next = settingsOf(applySeatTickSettingsChange(edited, { reason: "Successor note." }, { at: nextAt, actor: successor }));
  expect(next.instructionLines?.slice(0, 2)).toEqual(edited.instructionLines!);
  expect(next.instructionLines?.at(-1)?.author?.seatEpoch).toBe(8);
  expect(settingsOf(applySeatTickSettingsChange(next, { reason: null }, { at: nextAt, actor: successor })).reason).toBe(edited.reason);
});

test("a reason write cannot supply attribution and a refused write preserves the complete record", () => {
  const operator: SeatTickSettingsActor = { kind: "gateway", conversationId: null, project: null, seatEpoch: null };
  const current = settingsOf(applySeatTickSettingsChange(defaultSeatTickSettings(PROJECT), { reason: "o".repeat(490) }, { at: AT, actor: operator }));
  const before = structuredClone(current);
  const refused = change(current, { reason: "s".repeat(20) });
  expect(refused.ok).toBe(false);
  expect(current).toEqual(before);
  expect(applySeatTickSettingsChange(current, { reason: "unknown writer" }, { at: AT, actor: { kind: "unidentified", conversationId: null, project: null, seatEpoch: null } })).toEqual({ ok: false, error: "instruction writes need an identified author" });
  const written = settingsOf(change(current, { reason: "Seat", instructionLines: [{ text: "Seat", author: operator, at: AT }] } as never));
  expect(written.instructionLines?.at(-1)?.author).toEqual(SEAT);
  const effective = effectiveSeatTickSettings({ ...written, enabled: false, until: AT }, NOW, HOUR_MS);
  expect(seatTickSettingsAfterLapse(PROJECT, effective).instructionLines).toEqual(written.instructionLines!);
});

test("maintenance window is optional, validated, preserved on partial edits and explicitly removable", () => {
  const initial = defaultSeatTickSettings(PROJECT);
  expect(effectiveSeatTickSettings(initial, NOW, HOUR_MS).maintenance).toMatchObject({ enabled: false, window: null });
  const window = { timeZone: "Europe/Paris", weekdays: [1, 3, 5], startHour: 9, endHour: 17 };
  const enabled = change(initial, { maintenance: { enabled: true, window } });
  expect(enabled.ok).toBe(true);
  if (!enabled.ok) return;
  const edited = change(enabled.settings, { maintenance: { intervalHours: 12 } });
  expect(edited.ok && edited.settings.maintenance?.window).toEqual(window);
  const file = settingsFile();
  writeSeatTickSettings(PROJECT, enabled.settings, file);
  expect(readSeatTickSettings(PROJECT, file).maintenance?.window).toEqual(window);
  const lapsed = effectiveSeatTickSettings({ ...enabled.settings, enabled: false, until: AT }, NOW, HOUR_MS);
  expect(seatTickSettingsAfterLapse(PROJECT, lapsed).maintenance?.window).toEqual(window);
  const removed = change(enabled.settings, { maintenance: { window: null } });
  expect(removed.ok && removed.settings.maintenance?.window).toBeNull();
  expect(change(initial, { maintenance: { window: { ...window, timeZone: "Invalid/Zone" } } }).ok).toBe(false);
});

test("malformed persisted windows turn maintenance off without changing curation or another writer's rows", async () => {
  const window = { timeZone: "Invalid/Zone", weekdays: [1], startHour: 9, endHour: 17 };
  const timer = { enabled: true, intervalHours: 3, updatedAt: AT, setBy: SEAT, window };
  const file = settingsFile();
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects: { [PROJECT]: { ...defaultSeatTickSettings(PROJECT), maintenance: timer, curation: timer } } }));
  const effective = effectiveSeatTickSettings(readSeatTickSettings(PROJECT, file), NOW, HOUR_MS);
  expect(effective.maintenance).toMatchObject({ enabled: false, window: null });
  expect(effective.curation).toMatchObject({ enabled: true, intervalHours: 3 });
  const sqliteFile = settingsFile();
  writeSeatTickSettings(PROJECT, { ...defaultSeatTickSettings(PROJECT), maintenance: timer, curation: { ...timer, window: undefined } }, sqliteFile);
  const sqlite = effectiveSeatTickSettings(readSeatTickSettings(PROJECT, sqliteFile), NOW, HOUR_MS);
  expect(sqlite.maintenance).toMatchObject({ enabled: false, window: null });
  expect(sqlite.curation).toMatchObject({ enabled: true, intervalHours: 3 });
  const { Database } = await import("bun:sqlite");
  const database = new Database(path.join(path.dirname(sqliteFile), "state.sqlite"));
  try {
    const row = () => database.query("SELECT value_json FROM state_rows WHERE collection = ? AND row_key = ?").get("seat_tick_settings", `p:${PROJECT}`);
    const before = row();
    writeSeatTickSettings("other-project", defaultSeatTickSettings("other-project"), sqliteFile);
    expect(row()).toEqual(before);
  } finally { database.close(); }
});
