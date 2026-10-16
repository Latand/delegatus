import { describe, expect, test } from "bun:test";

import type { ActivityResponse } from "@/lib/activity/report";
import { translate, type TFunction } from "@/lib/i18n";

import { agentParts, agentText, approxAtLeast, approxText, browserZone, clockText, dateTimeText, hoursText, nothingRead, partsRound, trustState } from "./format";

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

describe("a card prints its times without building a formatter each time (2026-10-16)", () => {
  const AT = Date.UTC(2026, 9, 16, 12, 5);
  /* Counts the formatters built while `run` goes, by wrapping the constructor the way the page's own calls reach it. */
  const built = (run: () => void): number => {
    const Real = Intl.DateTimeFormat;
    let count = 0;
    /* A proxy counts a call with `new` and one without, which is how the zone is asked for. */
    Intl.DateTimeFormat = new Proxy(Real, {
      apply(target, thisArg, args) { count += 1; return Reflect.apply(target, thisArg, args); },
      construct(target, args, newTarget) { count += 1; return Reflect.construct(target, args, newTarget); },
    });
    try { run(); } finally { Intl.DateTimeFormat = Real; }
    return count;
  };

  test("the first print of a shape builds one formatter and the next hundred build none, with the same words", () => {
    const first = built(() => { expect(clockText(AT, "en", "Pacific/Kiritimati")).toBe("02:05"); });
    expect(first).toBe(1);
    const again = built(() => { for (let index = 0; index < 100; index += 1) expect(clockText(AT, "en", "Pacific/Kiritimati")).toBe("02:05"); });
    expect(again).toBe(0);
  });

  test("another zone, another locale and another shape are their own formatters and print their own words", () => {
    expect(clockText(AT, "en", "UTC")).toBe("12:05");
    expect(clockText(AT, "en", "Asia/Tokyo")).toBe("21:05");
    expect(dateTimeText(AT, "en", "UTC")).toBe("16 Oct, 12:05");
    expect(dateTimeText(AT, "uk", "UTC")).not.toBe(dateTimeText(AT, "en", "UTC"));
    expect(dateTimeText(AT, "uk", "UTC")).toContain("12:05");
  });

  test("the browser's zone is asked for once in half a minute, whatever time earlier files left in its cache", () => {
    const realNow = Date.now;
    /* Past anything an earlier file in this process could have read at, so a cached read is always stale at the start. */
    let now = realNow() + 10 * 365 * 24 * 60 * 60 * 1000;
    Date.now = () => now;
    try {
      const first = built(() => { browserZone(); });
      const second = built(() => { now += 29_000; browserZone(); });
      const third = built(() => { now += 2_000; browserZone(); });
      expect([second, third]).toEqual([0, 1]);
      expect(first).toBeLessThanOrEqual(1);
      expect(browserZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    } finally { Date.now = realNow; }
  });

  test("a clock that went back past the last read is asked again, not served the old zone until it catches up", () => {
    const realNow = Date.now;
    let now = realNow() + 20 * 365 * 24 * 60 * 60 * 1000;
    Date.now = () => now;
    try {
      built(() => { browserZone(); });
      expect(built(() => { now += 5_000; browserZone(); })).toBe(0);
      expect(built(() => { now -= 3_600_000; browserZone(); })).toBe(1);
      expect(built(() => { now += 5_000; browserZone(); })).toBe(0);
    } finally { Date.now = realNow; }
  });
});
