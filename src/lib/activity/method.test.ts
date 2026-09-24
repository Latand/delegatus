import { describe, expect, test } from "bun:test";

import {
  activityReport,
  agentTurns,
  clampMethodParams,
  clockHourWeight,
  dayReportHours,
  humanEpisodes,
  humanSegments,
  MINUTE_MS,
  roundHalfHour,
  totalMs,
  unionIntervals,
  zonedDays,
  type AgentConversation,
  type Anchor,
  type MethodParams,
  type RequestKind,
  type Surface,
} from "./method";

const MIN = MINUTE_MS;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-09-21T09:00:00Z");

const PARAMS: MethodParams = { windowMs: 10 * MIN, breakMs: 30 * MIN, rounding: "half-hour", tz: "UTC" };

function anchor(minute: number, project: string | null = "harbor", surface: Surface = "desktop", kind: RequestKind = "message"): Anchor {
  return { at: T0 + minute * MIN, project, surface, kind };
}

function humanMs(anchors: Anchor[], params: MethodParams = PARAMS, now = T0 + 24 * HOUR): number {
  return totalMs(humanSegments(humanEpisodes(anchors, params, now)));
}

function agent(key: string, project: string | null, from: number, to: number, extra: Partial<AgentConversation> = {}): AgentConversation {
  return {
    key,
    project,
    engine: "claude",
    role: "builder",
    pipelineId: null,
    stageId: null,
    activity: [{ start: T0 + from * MIN, end: T0 + to * MIN }],
    ...extra,
  };
}

/** A report over the day of T0, at the end of that day. */
function dayReport(anchors: Anchor[], agents: AgentConversation[] = [], params: MethodParams = PARAMS) {
  return activityReport({
    params,
    range: "today",
    nowMs: Date.parse("2026-09-21T23:59:00Z"),
    anchors,
    ledgerStartMs: Date.parse("2026-09-01T00:00:00Z"),
    agents,
  });
}

describe("episodes: the engagement window W and the break threshold T", () => {
  test("a lone request covers exactly W", () => {
    const episodes = humanEpisodes([anchor(0)], PARAMS, T0 + HOUR);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.end - episodes[0]!.start).toBe(10 * MIN);
    expect(humanMs([anchor(0)])).toBe(10 * MIN);
  });

  test("a gap of 29 minutes stays one episode and 31 minutes breaks it (T = 30)", () => {
    expect(humanEpisodes([anchor(0), anchor(29)], PARAMS, T0 + HOUR)).toHaveLength(1);
    expect(humanMs([anchor(0), anchor(29)])).toBe(39 * MIN);
    expect(humanEpisodes([anchor(0), anchor(31)], PARAMS, T0 + HOUR)).toHaveLength(2);
    expect(humanMs([anchor(0), anchor(31)])).toBe(20 * MIN);
    /* Exactly T is still inside the episode. */
    expect(humanMs([anchor(0), anchor(30)])).toBe(40 * MIN);
  });

  test("an episode ends at the last request plus W, so the last request keeps its window", () => {
    const [episode] = humanEpisodes([anchor(0), anchor(20), anchor(40)], PARAMS, T0 + 2 * HOUR);
    expect(episode!.start).toBe(T0);
    expect(episode!.end).toBe(T0 + 50 * MIN);
  });

  test("an episode is clipped at now", () => {
    const now = T0 + 3 * MIN;
    expect(humanMs([anchor(0)], PARAMS, now)).toBe(3 * MIN);
    /* A request after now is not counted at all. */
    expect(humanMs([anchor(0), anchor(5)], PARAMS, now)).toBe(3 * MIN);
  });

  test("T = W reproduces the original method: the union of per-request windows", () => {
    const original = { ...PARAMS, breakMs: PARAMS.windowMs };
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let round = 0; round < 50; round += 1) {
      const anchors = Array.from({ length: 12 }, () => anchor(Math.floor(next() * 300)));
      const windows = unionIntervals(anchors.map((item) => ({ start: item.at, end: item.at + original.windowMs })));
      expect(humanMs(anchors, original)).toBe(totalMs(windows));
    }
  });

  test("the refinement's supervised span counts whole while an agent works in it", () => {
    /* Requests at 0 and 25: the 25 minutes between them are human time even
       though nobody typed, and the agent's work in them is supervised. */
    const report = dayReport([anchor(0), anchor(25)], [agent("c1", "harbor", 0, 40)]);
    expect(report.totals.humanMs).toBe(35 * MIN);
    expect(report.totals.wallMs).toBe(40 * MIN);
    expect(report.totals.supervisedMs).toBe(35 * MIN);
    expect(report.totals.unattendedMs).toBe(5 * MIN);
  });
});

describe("one minute is counted once across projects", () => {
  test("overlapping episodes of two projects: the total is their union and the rows sum to it", () => {
    const anchors = [anchor(0, "harbor"), anchor(5, "lantern")];
    const segments = humanSegments(humanEpisodes(anchors, PARAMS, T0 + HOUR));
    expect(totalMs(segments)).toBe(15 * MIN);
    /* The overlapping minutes go to the more recently asked project. */
    expect(segments.map((segment) => [segment.project, (segment.end - segment.start) / MIN])).toEqual([["harbor", 5], ["lantern", 10]]);

    const report = dayReport(anchors);
    expect(report.totals.humanMs).toBe(15 * MIN);
    const harbor = report.projects.find((row) => row.project === "harbor")!;
    const lantern = report.projects.find((row) => row.project === "lantern")!;
    expect(harbor.humanOwnMs).toBe(10 * MIN);
    expect(harbor.humanMs).toBe(5 * MIN);
    expect(harbor.humanReassignedMs).toBe(5 * MIN);
    expect(lantern.humanMs).toBe(10 * MIN);
    expect(report.projects.reduce((sum, row) => sum + row.humanMs, 0)).toBe(report.totals.humanMs);
  });

  test("a request with no project is kept as unattributed time", () => {
    const report = dayReport([anchor(0, null)]);
    expect(report.totals.humanMs).toBe(10 * MIN);
    expect(report.projects).toHaveLength(1);
    expect(report.projects[0]!.project).toBeNull();
  });

  test("surface and kind breakdowns partition the same total", () => {
    const anchors = [
      anchor(0, "harbor", "desktop", "message"),
      anchor(12, "harbor", "phone", "voice"),
      anchor(20, "lantern", "tablet", "decision"),
      anchor(95, "harbor", "other", "task"),
    ];
    const report = dayReport(anchors);
    let bySurface = 0;
    let byKind = 0;
    for (const row of report.projects) {
      const surfaces = Object.values(row.bySurface).reduce((sum, ms) => sum + ms, 0);
      const kinds = Object.values(row.byKind).reduce((sum, ms) => sum + ms, 0);
      expect(surfaces).toBe(row.humanMs);
      expect(kinds).toBe(row.humanMs);
      bySurface += surfaces;
      byKind += kinds;
    }
    expect(bySurface).toBe(report.totals.humanMs);
    expect(byKind).toBe(report.totals.humanMs);
    const harbor = report.projects.find((row) => row.project === "harbor")!;
    /* Each minute belongs to the most recent request before it: 0-12 desktop,
       12-20 phone (then lantern's 20-30), and 95-105 from a script. */
    expect(harbor.bySurface.desktop).toBe(12 * MIN);
    expect(harbor.bySurface.phone).toBe(8 * MIN);
    expect(harbor.bySurface.other).toBe(10 * MIN);
    expect(harbor.byKind.voice).toBe(8 * MIN);
  });

  test("fan-out: a request recorded once or repeated at the same instant adds the same human time", () => {
    const once = dayReport([anchor(0)], [
      agent("c1", "harbor", 0, 30),
      agent("c2", "harbor", 0, 30),
      agent("c3", "harbor", 0, 30),
    ]);
    const repeated = dayReport([anchor(0), anchor(0), anchor(0)], [
      agent("c1", "harbor", 0, 30),
      agent("c2", "harbor", 0, 30),
      agent("c3", "harbor", 0, 30),
    ]);
    expect(once.totals.humanMs).toBe(10 * MIN);
    expect(repeated.totals.humanMs).toBe(10 * MIN);
    expect(once.totals.humanHours).toBe(repeated.totals.humanHours);
    /* Three agents working in parallel: wall-clock once, agent-hours three times. */
    expect(once.totals.wallMs).toBe(30 * MIN);
    expect(once.totals.agentHoursMs).toBe(90 * MIN);
    expect(once.totals.agentHoursSupervisedMs).toBe(30 * MIN);
    expect(once.totals.agentHoursUnattendedMs).toBe(60 * MIN);
  });
});

describe("agent work never opens or extends human time", () => {
  test("agent-only hours add zero human time", () => {
    const report = dayReport([], [agent("c1", "harbor", 0, 180)]);
    expect(report.totals.humanMs).toBe(0);
    expect(report.totals.humanHours).toBe(0);
    expect(report.totals.wallMs).toBe(180 * MIN);
    expect(report.totals.unattendedMs).toBe(180 * MIN);
    expect(report.totals.supervisedMs).toBe(0);
  });

  test("a long unattended run after one request counts only the window", () => {
    const report = dayReport([anchor(0)], [agent("c1", "harbor", 0, 240)]);
    expect(report.totals.humanMs).toBe(10 * MIN);
    expect(report.totals.humanHours).toBe(0.5);
    expect(report.totals.supervisedMs).toBe(10 * MIN);
    expect(report.totals.unattendedMs).toBe(230 * MIN);
    const day = report.days[0]!;
    expect(day.agent).toEqual([
      { start: T0, end: T0 + 10 * MIN, supervised: true },
      { start: T0 + 10 * MIN, end: T0 + 240 * MIN, supervised: false },
    ]);
  });

  test("supervision is per project: another project's episode does not supervise an agent", () => {
    const report = dayReport([anchor(0, "lantern")], [agent("c1", "harbor", 0, 30)]);
    const harbor = report.projects.find((row) => row.project === "harbor")!;
    expect(harbor.humanMs).toBe(0);
    expect(harbor.supervisedMs).toBe(0);
    expect(harbor.unattendedMs).toBe(30 * MIN);
  });

  test("the supervised and unattended split, per project and by provenance", () => {
    const report = dayReport([anchor(0), anchor(20)], [
      agent("c1", "harbor", 0, 60, { pipelineId: "pipe-a", stageId: "build" }),
      agent("c2", "harbor", 100, 130, { engine: "codex", role: "reviewer", pipelineId: "pipe-a", stageId: "review" }),
      agent("c3", "harbor", 25, 35, { role: "unregistered" }),
    ]);
    const harbor = report.projects[0]!;
    expect(harbor.humanMs).toBe(30 * MIN);
    expect(harbor.wallMs).toBe(90 * MIN);
    expect(harbor.supervisedMs).toBe(30 * MIN);
    expect(harbor.unattendedMs).toBe(60 * MIN);
    expect(harbor.agentHoursMs).toBe(100 * MIN);
    expect(harbor.agentHoursSupervisedMs).toBe(35 * MIN);
    expect(harbor.byEngine).toEqual({ claude: 70 * MIN, codex: 30 * MIN });
    expect(harbor.byRole).toEqual({ builder: 60 * MIN, reviewer: 30 * MIN, unregistered: 10 * MIN });
    expect(harbor.pipelines).toEqual([{ id: "pipe-a", stages: ["build", "review"], agentHoursMs: 90 * MIN }]);
    expect(harbor.conversations).toBe(3);
    expect(report.totals.unregisteredConversations).toBe(1);
  });
});

describe("report hours", () => {
  test("half-hour: nearest half hour, ties up, any non-zero time at least 0.5 h", () => {
    expect(roundHalfHour(0)).toBe(0);
    expect(roundHalfHour(1 * MIN)).toBe(0.5);
    expect(roundHalfHour(10 * MIN)).toBe(0.5);
    expect(roundHalfHour(44 * MIN)).toBe(0.5);
    expect(roundHalfHour(45 * MIN)).toBe(1);
    expect(roundHalfHour(74 * MIN)).toBe(1);
    expect(roundHalfHour(75 * MIN)).toBe(1.5);
  });

  test("half-hour rounds per project per day", () => {
    /* 10 min of harbor and 10 min of lantern: each project rounds up to 0.5 h. */
    const report = dayReport([anchor(0, "harbor"), anchor(60, "lantern")]);
    expect(report.totals.humanMs).toBe(20 * MIN);
    expect(report.totals.humanHours).toBe(1);
    expect(report.days[0]!.humanHours).toBe(1);
  });

  test("clock-hour: the original weights 10-39 min = 0.5 h and 40+ min = 1 h", () => {
    expect(clockHourWeight(9 * MIN + 59_000)).toBe(0);
    expect(clockHourWeight(10 * MIN)).toBe(0.5);
    expect(clockHourWeight(39 * MIN)).toBe(0.5);
    expect(clockHourWeight(40 * MIN)).toBe(1);
    const clock = { ...PARAMS, rounding: "clock-hour" as const };
    const day = { start: T0, end: T0 + 24 * HOUR };
    /* A request 9 minutes before now: 9 covered minutes weigh nothing yet. */
    const nine = humanSegments(humanEpisodes([anchor(0)], clock, T0 + 9 * MIN));
    expect(dayReportHours(nine, day, "clock-hour").size).toBe(0);
    const report = dayReport([anchor(0), anchor(60), anchor(80), anchor(90)], [], clock);
    /* Hour 09: 10 min → 0.5; hour 10: 10:00-10:40 = 40 min → 1. */
    expect(report.totals.humanHours).toBe(1.5);
  });

  test("clock-hour gives an hour to one project, the one with the most minutes, ties to the more recent request", () => {
    const clock = { ...PARAMS, rounding: "clock-hour" as const, windowMs: 10 * MIN, breakMs: 10 * MIN };
    const day = { start: T0, end: T0 + 24 * HOUR };
    /* harbor 09:00-09:25 (25 min), lantern 09:40-09:55 (15 min): harbor takes the hour at 0.5 h. */
    const most = humanSegments(humanEpisodes([anchor(0, "harbor"), anchor(10, "harbor"), anchor(15, "harbor"), anchor(40, "lantern"), anchor(45, "lantern")], clock, T0 + HOUR));
    expect(Object.fromEntries(dayReportHours(most, day, "clock-hour"))).toEqual({ harbor: 0.5 });
    /* 20 minutes each: the more recently asked project takes the hour. */
    const tied = humanSegments(humanEpisodes([anchor(0, "harbor"), anchor(10, "harbor"), anchor(30, "lantern"), anchor(40, "lantern")], clock, T0 + HOUR));
    expect(Object.fromEntries(dayReportHours(tied, day, "clock-hour"))).toEqual({ lantern: 0.5 });
  });
});

describe("days in the operator's zone", () => {
  const kyiv: MethodParams = { ...PARAMS, tz: "Europe/Kyiv" };

  test("an episode crossing local midnight is split at the zone's midnight, not UTC's", () => {
    /* 23:55 in Kyiv (EEST, UTC+3) on 2026-09-20 is 20:55 UTC. */
    const at = Date.parse("2026-09-20T20:55:00Z");
    const report = activityReport({
      params: kyiv,
      range: "7d",
      nowMs: Date.parse("2026-09-21T12:00:00Z"),
      anchors: [{ at, project: "harbor", surface: "phone", kind: "voice" }],
      ledgerStartMs: Date.parse("2026-09-01T00:00:00Z"),
      agents: [],
    });
    const byDate = Object.fromEntries(report.days.map((day) => [day.date, day.humanMs / MIN]));
    expect(byDate["2026-09-20"]).toBe(5);
    expect(byDate["2026-09-21"]).toBe(5);
    expect(report.days.find((day) => day.date === "2026-09-20")!.humanHours).toBe(0.5);
    expect(report.days.find((day) => day.date === "2026-09-21")!.humanHours).toBe(0.5);
  });

  test("the 2026-10-25 change back to winter time makes a 25-hour day", () => {
    const days = zonedDays(Date.parse("2026-10-26T10:00:00Z"), 3, "Europe/Kyiv");
    expect(days.map((day) => day.date)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
    expect(days[0]!.start).toBe(Date.parse("2026-10-23T21:00:00Z"));
    expect(days[1]!.start).toBe(Date.parse("2026-10-24T21:00:00Z"));
    expect(days[1]!.end - days[1]!.start).toBe(25 * HOUR);
    expect(days[2]!.start).toBe(Date.parse("2026-10-25T22:00:00Z"));
    /* Clock hours of that day: 25 of them, each one hour. */
    const segments = humanSegments(humanEpisodes([
      { at: Date.parse("2026-10-25T00:30:00Z"), project: "harbor", surface: "desktop", kind: "message" },
      { at: Date.parse("2026-10-25T01:10:00Z"), project: "harbor", surface: "desktop", kind: "message" },
    ], { ...kyiv, breakMs: 10 * MIN }, Date.parse("2026-10-26T00:00:00Z")));
    /* 03:30-03:40 EEST and 03:10-03:20 EET: two different clock hours. */
    expect(Object.fromEntries(dayReportHours(segments, days[1]!, "clock-hour"))).toEqual({ harbor: 1 });
  });

  test("days before the ledger's first request are not recorded, which is not zero", () => {
    const report = activityReport({
      params: PARAMS,
      range: "7d",
      nowMs: Date.parse("2026-09-21T12:00:00Z"),
      anchors: [],
      ledgerStartMs: Date.parse("2026-09-19T15:00:00Z"),
      agents: [],
    });
    expect(report.days.map((day) => day.recorded)).toEqual([false, false, false, false, true, true, true]);
    expect(report.days[4]!.recordedFrom).toBe(Date.parse("2026-09-19T15:00:00Z"));
    expect(report.days[5]!.recordedFrom).toBeNull();
    const empty = activityReport({ params: PARAMS, range: "today", nowMs: T0, anchors: [], ledgerStartMs: null, agents: [] });
    expect(empty.days[0]!.recorded).toBe(false);
  });

  test("an episode that began before the range counts only its part inside it", () => {
    const report = activityReport({
      params: PARAMS,
      range: "today",
      nowMs: Date.parse("2026-09-21T12:00:00Z"),
      anchors: [
        { at: Date.parse("2026-09-20T23:40:00Z"), project: "harbor", surface: "desktop", kind: "message" },
        { at: Date.parse("2026-09-20T23:58:00Z"), project: "harbor", surface: "desktop", kind: "message" },
      ],
      ledgerStartMs: Date.parse("2026-09-01T00:00:00Z"),
      agents: [],
    });
    expect(report.totals.humanMs).toBe(8 * MIN);
    /* The requests themselves were made yesterday. */
    expect(report.totals.requests).toBe(0);
  });
});

describe("agent turns from message rows", () => {
  const row = (minute: number, speaker: "user" | "assistant", seq?: number) => ({ transcriptPath: "/t/a.jsonl", speaker, atMs: T0 + minute * MIN, ...(seq === undefined ? {} : { seq }) });

  test("leading assistant rows, dropped turns and clipping", () => {
    const turns = agentTurns([
      row(0, "assistant"),
      row(5, "assistant"),
      row(10, "user"),
      row(20, "assistant"),
      row(30, "assistant"),
      row(40, "user"),
      row(50, "user"),
      row(50, "assistant"),
      row(60, "user"),
      row(70, "assistant"),
    ], { start: T0, end: T0 + 65 * MIN }, T0 + 24 * HOUR).get("/t/a.jsonl")!;
    expect(turns.map((turn) => [(turn.start - T0) / MIN, (turn.end - T0) / MIN])).toEqual([[0, 5], [10, 30], [60, 65]]);
  });

  test("rows sharing a timestamp keep the index's order, and turns clip at now", () => {
    const turns = agentTurns([
      row(0, "assistant", 2),
      row(0, "user", 1),
      row(20, "assistant", 3),
    ], { start: T0 - HOUR, end: T0 + HOUR }, T0 + 15 * MIN).get("/t/a.jsonl")!;
    expect(turns).toEqual([{ start: T0, end: T0 + 15 * MIN }]);
  });
});

describe("parameters are clamped, never refused", () => {
  test("defaults", () => {
    expect(clampMethodParams({}, "Europe/Kyiv")).toEqual({ windowMs: 10 * MIN, breakMs: 30 * MIN, rounding: "half-hour", tz: "Europe/Kyiv" });
  });

  test("bounds, strings, T below W, rounding and zone", () => {
    expect(clampMethodParams({ windowMs: 5 * MIN }, "UTC").windowMs).toBe(10 * MIN);
    expect(clampMethodParams({ windowMs: 20 * MIN }, "UTC").windowMs).toBe(15 * MIN);
    expect(clampMethodParams({ windowMs: String(12 * MIN) }, "UTC").windowMs).toBe(12 * MIN);
    expect(clampMethodParams({ windowMs: "soon" }, "UTC").windowMs).toBe(10 * MIN);
    expect(clampMethodParams({ windowMs: 15 * MIN, breakMs: 5 * MIN }, "UTC").breakMs).toBe(15 * MIN);
    expect(clampMethodParams({ breakMs: 500 * MIN }, "UTC").breakMs).toBe(120 * MIN);
    expect(clampMethodParams({ breakMs: Number.NaN }, "UTC").breakMs).toBe(30 * MIN);
    expect(clampMethodParams({ rounding: "clock-hour" }, "UTC").rounding).toBe("clock-hour");
    expect(clampMethodParams({ rounding: "weekly" }, "UTC").rounding).toBe("half-hour");
    expect(clampMethodParams({ tz: "Not/AZone" }, "Europe/Kyiv").tz).toBe("Europe/Kyiv");
    expect(clampMethodParams({ tz: "America/New_York" }, "UTC").tz).toBe("America/New_York");
    expect(clampMethodParams({ tz: "Not/AZone" }, "Also/Invalid").tz).toBe("UTC");
  });
});
