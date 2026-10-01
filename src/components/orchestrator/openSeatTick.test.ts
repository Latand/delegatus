import { expect, test } from "bun:test";

import { seatTickSettingsCardText } from "@/lib/monitor/cards";

import { isSeatTickNotice, requestSeatTickPanel, resetPendingSeatTickPanel, takePendingSeatTickPanel } from "./openSeatTick";

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

test("a request is held for the chip that mounts after it, once, and only for its own project", () => {
  resetPendingSeatTickPanel();
  requestSeatTickPanel("atlas");
  expect(takePendingSeatTickPanel("another-project")).toBe(false);
  expect(takePendingSeatTickPanel("atlas")).toBe(true);
  expect(takePendingSeatTickPanel("atlas")).toBe(false);
});

test("a request nobody answered goes stale", () => {
  resetPendingSeatTickPanel();
  const now = Date.now;
  try {
    Date.now = () => 1_000_000;
    requestSeatTickPanel("atlas");
    Date.now = () => 1_000_000 + 5_001;
    expect(takePendingSeatTickPanel("atlas")).toBe(false);
  } finally {
    Date.now = now;
  }
});
