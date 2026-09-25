import { describe, expect, test } from "bun:test";

import type { ActivityResponse } from "@/lib/activity/report";
import { translate, type TFunction } from "@/lib/i18n";

import { agentParts, agentText, approxAtLeast, approxText, hoursText, nothingRead, partsRound, trustState } from "./format";

const MIN = 60_000;
const HOUR = 60 * MIN;
const t: TFunction = (key, params) => translate("en", key, params);
const tUk: TFunction = (key, params) => translate("uk", key, params);

describe("agent time is an estimate and is printed as one", () => {
  test("five-minute steps below 10 h, whole hours from 10 h, a dash for none", () => {
    expect(agentText(2 * MIN, t)).toBeNull();
    expect(approxText(2 * MIN, t)).toBe("–");
    expect(agentText(8 * HOUR + 52 * MIN, t)).toBe("8 h 50 m");
    expect(agentText(49 * HOUR + 40 * MIN, t)).toBe("50 h");
    expect(approxText(35 * MIN, tUk)).toBe("≈ 35 хв");
  });

  test("reported hours use the locale's decimal mark", () => {
    expect(hoursText(27.5, "en", t)).toBe("27.5 h");
    expect(hoursText(27.5, "uk", tUk)).toBe("27,5 год");
  });

  test("a split's rounded parts add up to the total shown beside it", () => {
    for (const [total, parts] of [
      [50 * HOUR, [17.4 * HOUR, 27.9 * HOUR, 4.7 * HOUR]],
      [8 * HOUR + 20 * MIN, [3 * HOUR + 5 * MIN, 3 * HOUR + 42 * MIN, HOUR + 33 * MIN]],
      [47 * MIN, [16 * MIN, 16 * MIN, 15 * MIN]],
    ] as const) {
      const rounded = partsRound(total, parts);
      const step = total / MIN >= 600 ? HOUR : 5 * MIN;
      expect(rounded.reduce((sum, value) => sum + value, 0)).toBe(Math.round(total / step) * step);
      for (const value of rounded) expect(value % step).toBe(0);
    }
  });

  test("the unclear part is carved out of unattended, never added to it", () => {
    const [supervised, unattended, unclear] = agentParts({ wallMs: 10 * HOUR, supervisedMs: 4 * HOUR, unattendedMs: 6 * HOUR, unattendedUnreadMs: 2 * HOUR });
    expect([supervised, unattended, unclear]).toEqual([4 * HOUR, 4 * HOUR, 2 * HOUR]);
  });
});

describe("the trust chip names what was not read", () => {
  const window = { start: Date.parse("2026-09-18T00:00:00Z"), end: Date.parse("2026-09-25T00:00:00Z"), now: Date.parse("2026-09-24T12:00:00Z") };
  const readFor = window.now - window.start;
  const response = (overrides: { humanMs?: number; requests?: number; complete?: boolean; agentsComplete?: boolean; missingSourceDays?: number; unread?: number[] }): ActivityResponse => ({
    range: { key: "7d", ...window },
    totals: {
      humanMs: overrides.humanMs ?? 0,
      requests: overrides.requests ?? 0,
      coverage: { complete: overrides.complete ?? false, missingHosts: [] },
      agentCoverage: { complete: overrides.agentsComplete ?? true, missingHosts: overrides.agentsComplete === false ? ["stage"] : [] },
      missingSourceDays: overrides.missingSourceDays ?? 0,
    },
    coverage: { hosts: (overrides.unread ?? [readFor]).map((ms, index) => ({ host: `host-${index}`, unread: ms ? [{ start: window.start, end: window.start + ms }] : [] })) },
  }) as unknown as ActivityResponse;

  test("every host unread for the whole range and nothing counted: your time was not read", () => {
    const data = response({ unread: [readFor, readFor] });
    expect(nothingRead(data)).toBe(true);
    expect(trustState(data)).toBe("none");
    expect(t("activity.trust.none")).toBe("Your time not read");
    expect(tUk("activity.trust.none")).toBe("Ваш час не прочитано");
  });

  test("a ledger read while no export covers the host: a lower bound, not nothing", () => {
    expect(trustState(response({ humanMs: 40 * MIN, requests: 3, unread: [readFor] }))).toBe("lower");
  });

  test("one host unread for a day, or a flagged day: a lower bound; everything read: all sources", () => {
    expect(trustState(response({ humanMs: HOUR, requests: 5, unread: [0, 24 * HOUR] }))).toBe("lower");
    expect(trustState(response({ humanMs: HOUR, requests: 5, complete: true, missingSourceDays: 1, unread: [0] }))).toBe("lower");
    expect(trustState(response({ humanMs: HOUR, requests: 5, complete: true, unread: [0] }))).toBe("ok");
  });

  test("a host whose agent turns were never pulled: the agent figures are a lower bound, and so is the chip", () => {
    /* Your time is complete (an export read the host), its agents are not:
       nothing else would say the agent figures miss that host. */
    expect(trustState(response({ humanMs: HOUR, requests: 5, complete: true, agentsComplete: false, unread: [0, 0] }))).toBe("lower");
    expect(approxAtLeast(17 * HOUR, true, t)).toBe("≥ ≈ 17 h");
    expect(approxAtLeast(0, true, t)).toBe("?");
    expect(approxAtLeast(17 * HOUR, false, t)).toBe("≈ 17 h");
  });

  test("the Rhythm legend names whose hours the indigo swatches are", () => {
    expect(`${t("activity.rhythm.you")} ${t("activity.rhythm.full")} ${t("activity.rhythm.half")}`).toBe("You: 1 h ½ h");
    expect(`${tUk("activity.rhythm.you")} ${tUk("activity.rhythm.full")} ${tUk("activity.rhythm.half")}`).toBe("Ви: 1 год ½ год");
  });
});
