import { expect, test } from "bun:test";
import { applySeatTickSettingsChange, defaultSeatTickSettings, effectiveSeatTickSettings, readSeatTickSettings, writeSeatTickSettings, seatTickSettingsAfterLapse } from "@/lib/monitor/seatTickSettings";
const at = "2026-10-12T00:00:00Z";
const actor = { kind: "manager" as const, conversationId: "seat", project: "release-project", seatEpoch: 1 };
test("enabling releases persists 30 changes, twelve hours and approval every time", () => {
  const changed = applySeatTickSettingsChange(defaultSeatTickSettings(actor.project), { release: { enabled: true, why: "operator request" } }, { at, actor });
  expect(changed.ok).toBe(true);
  if (!changed.ok) return;
  writeSeatTickSettings(actor.project, changed.settings);
  const loaded = readSeatTickSettings(actor.project);
  expect(loaded.release).toMatchObject({ enabled: true, minChanges: 30, minGapHours: 12, askBeforePublish: true });
  const effective = effectiveSeatTickSettings(loaded, Date.parse(at), 60_000);
  expect(effective.release?.enabled).toBe(true);
  expect(seatTickSettingsAfterLapse(actor.project, effective).release).toEqual(loaded.release);
});
test("release and stop asking is explicit, and asking can be switched back on", () => {
  let row = defaultSeatTickSettings(actor.project);
  for (const askBeforePublish of [false, true]) {
    const changed = applySeatTickSettingsChange(row, { release: { askBeforePublish, why: "Випустити й більше не питати" } }, { at, actor });
    expect(changed.ok).toBe(true); if (!changed.ok) return;
    row = changed.settings;
    expect(row.release?.askBeforePublish).toBe(askBeforePublish);
  }
  expect(applySeatTickSettingsChange(row, { release: { askBeforePublish: false, why: "request" } }, { at, actor: { ...actor, kind: "agent" } }).ok).toBe(false);
});
test("release changes require attribution and valid thresholds", () => {
  const row = defaultSeatTickSettings(actor.project);
  for (const release of [{ enabled: true }, { minChanges: 0, why: "request" }, { minGapHours: 721, why: "request" }]) {
    expect(applySeatTickSettingsChange(row, { release }, { at, actor }).ok).toBe(false);
  }
  expect(applySeatTickSettingsChange(row, { release: { enabled: true } }, { at, actor: { ...actor, kind: "gateway" } }).ok).toBe(true);
});

test("changing a threshold retains the operator approval that turned asking off", () => {
  const approved = applySeatTickSettingsChange(defaultSeatTickSettings(actor.project), { release: { askBeforePublish: false, why: "Випустити й більше не питати" } }, { at, actor });
  if (!approved.ok) throw new Error(approved.error);
  const changed = applySeatTickSettingsChange(approved.settings, { release: { minChanges: 31, why: "threshold adjustment" } }, { at: "2026-10-12T01:00:00Z", actor: { ...actor, kind: "agent" } });
  if (!changed.ok) throw new Error(changed.error);
  expect(changed.settings.release?.publishApproval).toEqual({ at, by: actor, why: "Випустити й більше не питати" });
});
