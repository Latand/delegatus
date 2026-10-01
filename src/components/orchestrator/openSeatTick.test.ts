import { expect, test } from "bun:test";

import { seatTickSettingsCardText } from "@/lib/monitor/cards";

import { isSeatTickNotice } from "./openSeatTick";

const input = {
  project: "atlas",
  detail: "wakes for this project are set to one every 30 minute(s)",
  reason: "a release afternoon",
  until: null,
  setBy: null,
  updatedAt: "2026-10-01T07:00:00.000Z",
  schedule: { enabled: true, wakeIntervalMinutes: 30 },
} as const;

test("the card the server writes for a tick off its defaults is the notice, in either language", () => {
  for (const locale of ["en", "uk"] as const) {
    expect(isSeatTickNotice(seatTickSettingsCardText({ ...input, locale }))).toBe(true);
  }
});

test("other text is not the notice", () => {
  expect(isSeatTickNotice("Remove the unused tmux helpers")).toBe(false);
  expect(isSeatTickNotice("monitor-ref: seat-tick-stuck-interval")).toBe(false);
  expect(isSeatTickNotice(null)).toBe(false);
  expect(isSeatTickNotice(undefined)).toBe(false);
});
