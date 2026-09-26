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
  type HostCoverage,
  type MethodParams,
  type RequestKind,
  type Surface,
} from "./method";
import { REPLAY_DAY, REPLAY_DAY_INPUTS } from "./replayDay.fixture";

const MIN = MINUTE_MS;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-09-21T09:00:00Z");

/* The 2026-07-29 refinement (T = 30, half-hour), in UTC: most cases below
   exercise the episode mechanics, which the refinement makes visible. The
   defaults have their own cases. */
const PARAMS: MethodParams = { windowMs: 10 * MIN, breakMs: 30 * MIN, rounding: "half-hour", tz: "UTC" };

/** A host read for all time: coverage is complete. */
function readHost(host: string, projects: HostCoverage["projects"] = "all", covered = [{ start: 0, end: Number.MAX_SAFE_INTEGER }]): HostCoverage {
  return { host, projects, since: null, covered };
}
const LOCAL = readHost("local");

function anchor(minute: number, project: string | null = "harbor", surface: Surface = "desktop", kind: RequestKind = "message", host = "local"): Anchor {
  return { at: T0 + minute * MIN, project, surface, kind, host };
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
    hosts: [LOCAL],
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

  test("half-hour rounds each project's own day, and the day rounds every project's time together", () => {
    /* 10 min of harbor and 10 min of lantern: each project rounds up to 0.5 h,
       and the day's 20 minutes round to 0.5 h. */
    const report = dayReport([anchor(0, "harbor"), anchor(60, "lantern")]);
    expect(report.totals.humanMs).toBe(20 * MIN);
    expect(report.totals.humanHours).toBe(0.5);
    expect(report.days[0]!.humanHours).toBe(0.5);
    expect(report.projects.map((row) => row.humanHours)).toEqual([0.5, 0.5]);
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

  test("clock-hour combines every window in the hour and gives the hour to the project with the most minutes", () => {
    const clock = { ...PARAMS, rounding: "clock-hour" as const, windowMs: 10 * MIN, breakMs: 10 * MIN };
    const day = { start: T0, end: T0 + 24 * HOUR };
    /* harbor 09:00-09:25 (25 min) and lantern 09:40-09:55 (15 min): the hour
       holds 40 covered minutes, weighs 1 h, and goes to harbor. */
    const most = humanSegments(humanEpisodes([anchor(0, "harbor"), anchor(10, "harbor"), anchor(15, "harbor"), anchor(40, "lantern"), anchor(45, "lantern")], clock, T0 + HOUR));
    expect(Object.fromEntries(dayReportHours(most, day, "clock-hour"))).toEqual({ harbor: 1 });
    /* 20 minutes each: the more recently asked project takes the hour. */
    const tied = humanSegments(humanEpisodes([anchor(0, "harbor"), anchor(10, "harbor"), anchor(30, "lantern"), anchor(40, "lantern")], clock, T0 + HOUR));
    expect(Object.fromEntries(dayReportHours(tied, day, "clock-hour"))).toEqual({ lantern: 1 });
    /* One hour is never split between projects: harbor's 5 minutes and
       lantern's 5 weigh as 10 together, and the hour goes to lantern, asked
       last. Lantern's 5 minutes past 10:00 weigh nothing in their own hour. */
    const split = humanSegments(humanEpisodes([anchor(50, "harbor"), anchor(55, "lantern")], clock, T0 + 2 * HOUR));
    expect(Object.fromEntries(dayReportHours(split, day, "clock-hour"))).toEqual({ lantern: 0.5 });
  });
});

describe("each project counts its own hours; the day counts every project's time together", () => {
  test("three projects worked in parallel each take the hour their own input covers", () => {
    const clock = { ...PARAMS, rounding: "clock-hour" as const, breakMs: 10 * MIN };
    /* 09:00-09:40 each: harbor, lantern and orchard interleave their requests. */
    const anchors = [0, 10, 20, 30].flatMap((minute) => [anchor(minute, "harbor"), anchor(minute + 3, "lantern"), anchor(minute + 6, "orchard")]);
    const report = dayReport(anchors, [], clock);
    expect(Object.fromEntries(report.projects.map((row) => [row.project, row.humanHours]))).toEqual({ harbor: 1, lantern: 1, orchard: 1 });
    expect(report.days[0]!.projects.map((entry) => entry.humanHours)).toEqual([1, 1, 1]);
    /* The hour is one hour of the operator's: the union of every window. */
    expect(report.totals.humanHours).toBe(1);
    expect(report.days[0]!.humanHours).toBe(1);
    /* Its minutes are still counted once. */
    expect(report.totals.humanMs).toBe(46 * MIN);
    expect(report.projects.reduce((sum, row) => sum + row.humanMs, 0)).toBe(46 * MIN);
  });

  test("another project's minutes neither take a project's hour nor raise its weight", () => {
    const clock = { ...PARAMS, rounding: "clock-hour" as const, breakMs: 10 * MIN };
    /* harbor 09:00-09:20 (20 min), lantern 09:20-09:50 (30 min): the hour
       holds 50 minutes, 1 h in the day's total; harbor 0.5 h, lantern 0.5 h. */
    const report = dayReport([anchor(0, "harbor"), anchor(10, "harbor"), anchor(20, "lantern"), anchor(30, "lantern"), anchor(40, "lantern")], [], clock);
    expect(Object.fromEntries(report.projects.map((row) => [row.project, row.humanHours]))).toEqual({ harbor: 0.5, lantern: 0.5 });
    expect(report.totals.humanHours).toBe(1);
    const harbor = activityReport({
      params: clock, range: "today", nowMs: Date.parse("2026-09-21T23:59:00Z"),
      anchors: [anchor(0, "harbor"), anchor(10, "harbor"), anchor(20, "lantern"), anchor(30, "lantern"), anchor(40, "lantern")],
      hosts: [LOCAL], agents: [], scope: { project: "harbor" },
    });
    expect(harbor.totals.humanHours).toBe(0.5);
    expect(harbor.days[0]!.hours[9]!.weight).toBe(0.5);
  });
});

describe("a replayed real day reads the daily report's hours", () => {
  /* The day the page read 5.5 h for paid-a and the daily report 8.5 h. */
  const params = clampMethodParams({}, REPLAY_DAY.tz);
  const anchors: Anchor[] = REPLAY_DAY_INPUTS.map(([offset, project, host, surface, kind]) => ({ at: REPLAY_DAY.start + offset * 1000, project, surface, kind, host }));
  const report = (project?: string) => activityReport({
    params, range: "7d", nowMs: REPLAY_DAY.start + 36 * HOUR, anchors, hosts: [readHost("host-a"), readHost("host-b")], agents: [],
    ...(project === undefined ? {} : { scope: { project } }),
  });
  const replayDay = (result: ReturnType<typeof report>) => result.days.find((day) => day.date === REPLAY_DAY.date)!;

  test("paid-a reads 8.5 h on its row, its day entry and its own view, with 01:00 and 02:00 a full hour each", () => {
    const all = report();
    expect(all.projects.find((row) => row.project === "paid-a")!.humanHours).toBe(8.5);
    expect(replayDay(all).projects.find((entry) => entry.project === "paid-a")!.humanHours).toBe(8.5);
    const view = report("paid-a");
    expect(view.totals.humanHours).toBe(8.5);
    const day = replayDay(view);
    expect(day.humanHours).toBe(8.5);
    /* Its own inputs cover 01:00 and 02:00 for 40 minutes and more: other
       projects' minutes used to win both. */
    expect(day.hours[1]!.weight).toBe(1);
    expect(day.hours[2]!.weight).toBe(1);
    expect(day.hours.reduce((sum, hour) => sum + (hour.weight ?? 0), 0)).toBe(8.5);
  });

  test("the day's total is the union of every project's windows, and the projects add up to more", () => {
    const day = replayDay(report());
    expect(day.humanHours).toBe(11.5);
    expect(day.projects.reduce((sum, entry) => sum + entry.humanHours, 0)).toBeGreaterThan(11.5);
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
      anchors: [{ at, project: "harbor", surface: "phone", kind: "voice", host: "local" }],
      hosts: [LOCAL],
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
      { at: Date.parse("2026-10-25T00:30:00Z"), project: "harbor", surface: "desktop", kind: "message", host: "local" },
      { at: Date.parse("2026-10-25T01:10:00Z"), project: "harbor", surface: "desktop", kind: "message", host: "local" },
    ], { ...kyiv, breakMs: 10 * MIN }, Date.parse("2026-10-26T00:00:00Z")));
    /* 03:30-03:40 EEST and 03:10-03:20 EET: two different clock hours. */
    expect(Object.fromEntries(dayReportHours(segments, days[1]!, "clock-hour"))).toEqual({ harbor: 1 });
  });

  test("time before a host's sources begin is unknown, which is not zero", () => {
    const report = activityReport({
      params: PARAMS,
      range: "7d",
      nowMs: Date.parse("2026-09-21T12:00:00Z"),
      anchors: [],
      hosts: [readHost("local", "all", [{ start: Date.parse("2026-09-19T15:00:00Z"), end: Date.parse("2026-09-21T12:00:00Z") }])],
      agents: [],
    });
    expect(report.days.map((day) => day.coverage.complete)).toEqual([false, false, false, false, false, true, true]);
    expect(report.days[4]!.unknown).toEqual([{ start: Date.parse("2026-09-19T00:00:00Z"), end: Date.parse("2026-09-19T15:00:00Z") }]);
    expect(report.days[4]!.coverage.missingHosts).toEqual(["local"]);
    expect(report.totals.coverage).toEqual({ complete: false, missingHosts: ["local"] });
    const empty = activityReport({ params: PARAMS, range: "today", nowMs: T0, anchors: [], hosts: [readHost("local", "all", [])], agents: [] });
    expect(empty.days[0]!.coverage.complete).toBe(false);
  });

  test("an episode that began before the range counts only its part inside it", () => {
    const report = activityReport({
      params: PARAMS,
      range: "today",
      nowMs: Date.parse("2026-09-21T12:00:00Z"),
      anchors: [
        { at: Date.parse("2026-09-20T23:40:00Z"), project: "harbor", surface: "desktop", kind: "message", host: "local" },
        { at: Date.parse("2026-09-20T23:58:00Z"), project: "harbor", surface: "desktop", kind: "message", host: "local" },
      ],
      hosts: [LOCAL],
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
  test("defaults: the restated method, W = T = 10 minutes, clock-hour weights, Europe/Kyiv", () => {
    expect(clampMethodParams({})).toEqual({ windowMs: 10 * MIN, breakMs: 10 * MIN, rounding: "clock-hour", tz: "Europe/Kyiv" });
    /* A longer window keeps T at least W. */
    expect(clampMethodParams({ windowMs: 15 * MIN })).toMatchObject({ windowMs: 15 * MIN, breakMs: 15 * MIN });
  });

  test("bounds, strings, T below W, rounding and zone", () => {
    expect(clampMethodParams({ windowMs: 5 * MIN }, "UTC").windowMs).toBe(10 * MIN);
    expect(clampMethodParams({ windowMs: 20 * MIN }, "UTC").windowMs).toBe(15 * MIN);
    expect(clampMethodParams({ windowMs: String(12 * MIN) }, "UTC").windowMs).toBe(12 * MIN);
    expect(clampMethodParams({ windowMs: "soon" }, "UTC").windowMs).toBe(10 * MIN);
    expect(clampMethodParams({ windowMs: 15 * MIN, breakMs: 5 * MIN }, "UTC").breakMs).toBe(15 * MIN);
    expect(clampMethodParams({ breakMs: 500 * MIN }, "UTC").breakMs).toBe(120 * MIN);
    expect(clampMethodParams({ breakMs: Number.NaN }, "UTC").breakMs).toBe(10 * MIN);
    expect(clampMethodParams({ breakMs: 30 * MIN }, "UTC").breakMs).toBe(30 * MIN);
    expect(clampMethodParams({ rounding: "clock-hour" }, "UTC").rounding).toBe("clock-hour");
    expect(clampMethodParams({ rounding: "weekly" }, "UTC").rounding).toBe("clock-hour");
    expect(clampMethodParams({ tz: "Not/AZone" }, "Europe/Kyiv").tz).toBe("Europe/Kyiv");
    expect(clampMethodParams({ tz: "America/New_York" }, "UTC").tz).toBe("America/New_York");
    expect(clampMethodParams({ tz: "Not/AZone" }, "Also/Invalid").tz).toBe("UTC");
  });
});

describe("human input from more than one host", () => {
  const DEFAULTS = clampMethodParams({}, "UTC");
  const report = (anchors: Anchor[], hosts: HostCoverage[], agents: AgentConversation[] = []) => activityReport({
    params: DEFAULTS,
    range: "today",
    nowMs: Date.parse("2026-09-21T23:59:00Z"),
    anchors,
    hosts,
    agents,
  });
  const stageInput = [anchor(0, "client-a", "unknown", "message", "stage"), anchor(5, "client-a", "unknown", "message", "stage"), anchor(35, "client-a", "unknown", "message", "stage")];

  test("the local host read and empty, the remote host with input: the hours come from the remote host and coverage is complete", () => {
    const result = report(stageInput, [LOCAL, readHost("stage")]);
    /* 09:00-09:15 and 09:35-09:45: 25 minutes in the 09:00 hour. */
    expect(result.totals.humanMs).toBe(25 * MIN);
    expect(result.totals.humanHours).toBe(0.5);
    expect(result.totals.coverage).toEqual({ complete: true, missingHosts: [] });
    expect(result.days[0]!.missingSource).toBeNull();
    const client = result.projects.find((row) => row.project === "client-a")!;
    expect(client.byHost).toEqual({ stage: 25 * MIN });
    expect(client.coverage.complete).toBe(true);
  });

  test("the same with the remote host unread: coverage is unknown and the zero is flagged, never a clean zero", () => {
    const result = report([], [LOCAL, readHost("stage", "all", [])]);
    expect(result.totals.humanMs).toBe(0);
    expect(result.totals.coverage).toEqual({ complete: false, missingHosts: ["stage"] });
    expect(result.days[0]!.coverage).toEqual({ complete: false, missingHosts: ["stage"] });
    expect(result.days[0]!.missingSource).toEqual(["unread-source"]);
    expect(result.totals.missingSourceDays).toBe(1);
  });

  test("a host that holds only some projects leaves only those unknown, and lists them even with nothing read", () => {
    const result = report([anchor(0, "harbor")], [LOCAL, readHost("stage", ["client-a"], [])]);
    const harbor = result.projects.find((row) => row.project === "harbor")!;
    const client = result.projects.find((row) => row.project === "client-a")!;
    expect(harbor.coverage.complete).toBe(true);
    expect(client.humanMs).toBe(0);
    expect(client.coverage).toEqual({ complete: false, missingHosts: ["stage"] });
    expect(result.days[0]!.coverage.complete).toBe(false);
  });

  test("a host is not expected before the day it started holding work", () => {
    const stage: HostCoverage = { host: "stage", projects: "all", since: Date.parse("2026-09-22T00:00:00Z"), covered: [] };
    expect(report([anchor(0)], [LOCAL, stage]).totals.coverage.complete).toBe(true);
  });
});

describe("every message is bucketed by its own time in Europe/Kyiv", () => {
  test("a session crossing midnight in Kyiv puts each message on its own day", () => {
    const kyiv = clampMethodParams({});
    const session = [
      /* 23:50 and 00:20 in Kyiv (EEST, UTC+3): one conversation, two days. */
      { at: Date.parse("2026-09-22T20:50:00Z"), project: "client-a", surface: "unknown" as const, kind: "message" as const, host: "stage" },
      { at: Date.parse("2026-09-22T21:20:00Z"), project: "client-a", surface: "unknown" as const, kind: "message" as const, host: "stage" },
    ];
    const result = activityReport({ params: kyiv, range: "7d", nowMs: Date.parse("2026-09-23T12:00:00Z"), anchors: session, hosts: [LOCAL, readHost("stage")], agents: [] });
    const byDate = Object.fromEntries(result.days.map((day) => [day.date, [day.humanMs / MIN, day.humanHours]]));
    expect(byDate["2026-09-22"]).toEqual([10, 0.5]);
    expect(byDate["2026-09-23"]).toEqual([10, 0.5]);
    /* In UTC both messages fall on the 22nd. */
    const utc = activityReport({ params: { ...kyiv, tz: "UTC" }, range: "7d", nowMs: Date.parse("2026-09-23T12:00:00Z"), anchors: session, hosts: [LOCAL, readHost("stage")], agents: [] });
    expect(utc.days.find((day) => day.date === "2026-09-22")!.humanMs).toBe(20 * MIN);
  });
});

describe("a zero-hour workday is flagged as a probable missing source", () => {
  const DEFAULTS = clampMethodParams({}, "UTC");
  const week = (anchors: Anchor[], agents: AgentConversation[], hosts: HostCoverage[] = [LOCAL]) => activityReport({
    params: DEFAULTS,
    range: "7d",
    nowMs: Date.parse("2026-09-21T23:59:00Z"),
    anchors,
    hosts,
    agents,
  });
  const onDay = (date: string, fromMin: number, toMin: number): AgentConversation => ({
    key: `agent-${date}`, project: "harbor", engine: "codex", role: "builder", pipelineId: null, stageId: null,
    activity: [{ start: Date.parse(`${date}T09:00:00Z`) + fromMin * MIN, end: Date.parse(`${date}T09:00:00Z`) + toMin * MIN }],
  });

  test("agents busy for an hour on a Friday nobody asked anything: flagged", () => {
    const result = week([], [onDay("2026-09-18", 0, 60)]);
    expect(result.days.find((day) => day.date === "2026-09-18")!.missingSource).toEqual(["agent-activity"]);
    expect(result.totals.missingSourceDays).toBe(1);
  });

  test("the same on a Sunday, a short agent run, or a day with input: not flagged", () => {
    const result = week([anchor(0)], [onDay("2026-09-20", 0, 60), onDay("2026-09-17", 0, 20), onDay("2026-09-21", 0, 60)]);
    expect(result.days.find((day) => day.date === "2026-09-20")!.missingSource).toBeNull();
    expect(result.days.find((day) => day.date === "2026-09-17")!.missingSource).toBeNull();
    expect(result.days.find((day) => day.date === "2026-09-21")!.missingSource).toBeNull();
  });
});

describe("billable projects are counted on their own", () => {
  test("another project's request never takes a billable minute", () => {
    const result = activityReport({
      params: clampMethodParams({}, "UTC"),
      range: "today",
      nowMs: Date.parse("2026-09-21T23:59:00Z"),
      /* harbor (billable) at 09:00, lantern at 09:05: lantern owns 09:05-09:15. */
      anchors: [anchor(0, "harbor"), anchor(5, "lantern")],
      hosts: [LOCAL],
      agents: [],
      billable: ["harbor"],
    });
    /* All projects: 15 minutes in the hour, 0.5 h to lantern. Billable alone:
       harbor's own 10 minutes, 0.5 h. */
    expect(result.totals.humanHours).toBe(0.5);
    expect(result.projects.find((row) => row.project === "lantern")!.humanHours).toBe(0.5);
    expect(result.totals.billableHours).toBe(0.5);
    expect(result.projects.find((row) => row.project === "harbor")!.billable).toBe(true);
    expect(result.projects.find((row) => row.project === "lantern")!.billable).toBe(false);
  });
});

describe("presentation fields: the unclear part of unattended time and the clock hours", () => {
  const DEFAULTS = clampMethodParams({}, "UTC");
  const NOW = Date.parse("2026-09-24T20:00:00Z");
  const WED = { start: Date.parse("2026-09-23T00:00:00Z"), end: Date.parse("2026-09-24T00:00:00Z") };
  const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`);
  const input = (date: string, hhmm: string, project: string, host = "local"): Anchor => ({ at: at(date, hhmm), project, surface: "desktop", kind: "message", host });
  const run = (key: string, project: string, date: string, from: string, to: string): AgentConversation => ({
    key, project, engine: "claude", role: "builder", pipelineId: null, stageId: null, activity: [{ start: at(date, from), end: at(date, to) }],
  });
  /** A host read for all time except Wednesday. */
  const unreadWed = (host: string, projects: HostCoverage["projects"]) => readHost(host, projects, [{ start: 0, end: WED.start }, { start: WED.end, end: Number.MAX_SAFE_INTEGER }]);
  const week = (anchors: Anchor[], agents: AgentConversation[], hosts: HostCoverage[], params: MethodParams = DEFAULTS) =>
    activityReport({ params, range: "7d", nowMs: NOW, anchors, hosts, agents });
  const day = (result: ReturnType<typeof week>, date: string) => result.days.find((row) => row.date === date)!;
  const project = (result: ReturnType<typeof week>, name: string) => result.projects.find((row) => row.project === name)!;

  test("a host holding only A unread for a day: A's time there is unclear, B's read time never is (the Wed 23 case)", () => {
    const result = week(
      [input("2026-09-23", "10:00", "B")],
      [run("a", "A", "2026-09-23", "02:00", "04:00"), run("b", "B", "2026-09-23", "14:00", "15:00")],
      [LOCAL, unreadWed("stage", ["A"])],
    );
    expect(project(result, "A").unattendedMs).toBe(2 * HOUR);
    expect(project(result, "A").unattendedUnreadMs).toBe(2 * HOUR);
    expect(project(result, "A").unclearDays).toEqual(["2026-09-23"]);
    expect(project(result, "B").unattendedMs).toBe(HOUR);
    expect(project(result, "B").unattendedUnreadMs).toBe(0);
    expect(project(result, "B").unclearDays).toEqual([]);
    expect(day(result, "2026-09-23").missingSource).toBeNull();
    expect(day(result, "2026-09-23").unattendedMs).toBe(3 * HOUR);
    expect(day(result, "2026-09-23").unattendedUnreadMs).toBe(2 * HOUR);
    expect(result.totals.unattendedUnreadMs).toBe(2 * HOUR);
  });

  test("a host holding every project unread makes every project's time there unclear", () => {
    const result = week(
      [input("2026-09-23", "10:00", "B")],
      [run("a", "A", "2026-09-23", "02:00", "04:00"), run("b", "B", "2026-09-23", "14:00", "15:00")],
      [LOCAL, unreadWed("stage", "all")],
    );
    expect(project(result, "A").unattendedUnreadMs).toBe(2 * HOUR);
    expect(project(result, "B").unattendedUnreadMs).toBe(HOUR);
    expect(day(result, "2026-09-23").unattendedUnreadMs).toBe(3 * HOUR);
  });

  test("a flagged day makes all its unattended time unclear, for the day and for each project", () => {
    const result = week([], [run("a", "A", "2026-09-22", "09:00", "10:00"), run("b", "B", "2026-09-22", "13:00", "13:40")], [LOCAL]);
    const tuesday = day(result, "2026-09-22");
    expect(tuesday.missingSource).toEqual(["agent-activity"]);
    expect(tuesday.unattendedUnreadMs).toBe(tuesday.unattendedMs);
    expect(tuesday.unattendedUnreadMs).toBe(100 * MIN);
    for (const name of ["A", "B"]) {
      expect(project(result, name).unattendedUnreadMs).toBe(project(result, name).unattendedMs);
      expect(project(result, name).unclearDays).toEqual(["2026-09-22"]);
    }
  });

  test("a minute counts once: supervised before unclear before unattended", () => {
    const result = week(
      [input("2026-09-23", "10:00", "A")],
      [
        /* A supervised 10:00-10:10 while B, unread, works 10:00-10:30. */
        run("a", "A", "2026-09-23", "10:00", "10:10"),
        run("b1", "B", "2026-09-23", "10:00", "10:30"),
        /* B unread and C read and unwatched, 12:00-12:20. */
        run("b2", "B", "2026-09-23", "12:00", "12:20"),
        run("c", "C", "2026-09-23", "12:00", "12:20"),
      ],
      [LOCAL, unreadWed("stage", ["B"])],
    );
    const wednesday = day(result, "2026-09-23");
    expect(wednesday.wallMs).toBe(50 * MIN);
    expect(wednesday.supervisedMs).toBe(10 * MIN);
    expect(wednesday.unattendedMs).toBe(40 * MIN);
    /* 10:10-10:30 and 12:00-12:20: the union of the projects' unclear
       stretches outside every supervised one. */
    expect(wednesday.unattendedUnreadMs).toBe(40 * MIN);
    expect(project(result, "B").unattendedUnreadMs).toBe(50 * MIN);
    expect(project(result, "C").unattendedUnreadMs).toBe(0);
    const ten = wednesday.hours.find((hour) => hour.start === at("2026-09-23", "10:00"))!;
    expect([ten.supervisedMs, ten.unattendedMs, ten.unattendedUnreadMs]).toEqual([10 * MIN, 20 * MIN, 20 * MIN]);
  });

  test("with nothing read, nothing is supervised and all agent time is unclear", () => {
    const result = week([], [run("a", "A", "2026-09-23", "02:00", "04:00"), run("b", "B", "2026-09-20", "14:00", "15:00")], [readHost("local", "all", [])]);
    expect(result.totals.supervisedMs).toBe(0);
    expect(result.totals.unattendedUnreadMs).toBe(result.totals.wallMs);
    expect(result.totals.wallMs).toBe(3 * HOUR);
    for (const row of result.days) expect(row.unattendedUnreadMs).toBe(row.wallMs);
    for (const row of result.projects) expect(row.unattendedUnreadMs).toBe(row.wallMs);
  });

  test("every day's hours and projects add up to the day's own figures", () => {
    const anchors = [
      input("2026-09-21", "09:02", "A"), input("2026-09-21", "09:09", "A"), input("2026-09-21", "09:30", "B"), input("2026-09-21", "09:44", "A"),
      input("2026-09-21", "13:05", "B"), input("2026-09-21", "13:12", "B"), input("2026-09-23", "10:00", "B"), input("2026-09-24", "08:55", "A"),
    ];
    const agents = [run("a", "A", "2026-09-21", "08:00", "11:00"), run("b", "B", "2026-09-21", "12:30", "16:00"), run("c", "A", "2026-09-23", "01:00", "03:00")];
    const hosts = [LOCAL, unreadWed("stage", ["A"])];
    for (const params of [DEFAULTS, { ...DEFAULTS, breakMs: 30 * MIN, rounding: "half-hour" as const }]) {
      const result = week(anchors, agents, hosts, params);
      for (const row of result.days) {
        const sum = (pick: (hour: typeof row.hours[number]) => number) => row.hours.reduce((total, hour) => total + pick(hour), 0);
        expect(row.hours).toHaveLength(24);
        expect(sum((hour) => hour.humanMs)).toBe(row.humanMs);
        expect(sum((hour) => hour.supervisedMs)).toBe(row.supervisedMs);
        expect(sum((hour) => hour.unattendedMs)).toBe(row.unattendedMs);
        expect(sum((hour) => hour.unattendedUnreadMs)).toBe(row.unattendedUnreadMs);
        if (params.rounding === "clock-hour") expect(sum((hour) => hour.weight ?? 0)).toBe(row.humanHours);
        else for (const hour of row.hours) expect(hour.weight).toBeNull();
        /* Projects count their hours alone, so theirs add up to at least the
           day's; their minutes, counted once, add up to the day's. */
        expect(row.projects.reduce((total, entry) => total + entry.humanHours, 0)).toBeGreaterThanOrEqual(row.humanHours);
        expect(row.projects.reduce((total, entry) => total + entry.humanMs, 0)).toBe(row.humanMs);
      }
      expect(result.days.reduce((total, row) => total + row.unattendedUnreadMs, 0)).toBe(result.totals.unattendedUnreadMs);
    }
    const monday = day(week(anchors, agents, hosts), "2026-09-21");
    const nine = monday.hours.find((hour) => hour.start === at("2026-09-21", "09:00"))!;
    expect(nine.project).toBe("A");
    expect(nine.agentProject).toBe("A");
    expect(monday.workday).toBe(true);
    expect(day(week(anchors, agents, hosts), "2026-09-20").workday).toBe(false);
    const wednesday = day(week(anchors, agents, hosts), "2026-09-23");
    expect(wednesday.hours[0]!.unreadHosts).toEqual(["stage"]);
    expect(day(week(anchors, agents, hosts), "2026-09-22").hours[0]!.unreadHosts).toEqual([]);
  });
});

describe("one project's view: the page filtered to a project", () => {
  const DEFAULTS = clampMethodParams({}, "UTC");
  const NOW = Date.parse("2026-09-24T20:00:00Z");
  const WED = { start: Date.parse("2026-09-23T00:00:00Z"), end: Date.parse("2026-09-24T00:00:00Z") };
  const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`);
  const input = (date: string, hhmm: string, project: string, host = "local"): Anchor => ({ at: at(date, hhmm), project, surface: "desktop", kind: "message", host });
  const run = (key: string, project: string, date: string, from: string, to: string, role = "builder"): AgentConversation => ({
    key, project, engine: "claude", role, pipelineId: null, stageId: null, activity: [{ start: at(date, from), end: at(date, to) }],
  });
  /* Minutes that move to a later input's project, an hour two projects share,
     parallel agents, a flagged Tuesday, a host holding only A unread on
     Wednesday, and a billable project. */
  const anchors = [
    input("2026-09-21", "09:02", "A"), input("2026-09-21", "09:09", "A"), input("2026-09-21", "09:30", "B"), input("2026-09-21", "09:36", "A"),
    input("2026-09-21", "13:05", "B"), input("2026-09-21", "13:12", "B"), input("2026-09-23", "10:00", "B"), input("2026-09-24", "08:55", "A"),
  ];
  const agents = [
    run("a1", "A", "2026-09-21", "08:00", "11:00"), run("a2", "A", "2026-09-21", "09:30", "10:30", "reviewer"),
    run("b1", "B", "2026-09-21", "12:30", "16:00"), run("b2", "B", "2026-09-22", "01:00", "02:00"), run("c", "A", "2026-09-23", "01:00", "03:00"),
  ];
  const hosts = [LOCAL, readHost("stage", ["A"], [{ start: 0, end: WED.start }, { start: WED.end, end: Number.MAX_SAFE_INTEGER }])];
  const week = (params: MethodParams, project?: string) => activityReport({
    params, range: "7d", nowMs: NOW, anchors, hosts, agents, billable: ["A"],
    ...(project === undefined ? {} : { scope: { project } }),
  });

  test("each figure of the view is the number the project's row carries, and the list still holds every project", () => {
    for (const params of [DEFAULTS, { ...DEFAULTS, breakMs: 30 * MIN, rounding: "half-hour" as const }]) {
      const all = week(params);
      expect(all.scope).toBeNull();
      for (const project of ["A", "B"]) {
        const view = week(params, project);
        const row = all.projects.find((entry) => entry.project === project)!;
        expect(view.scope).toEqual({ project });
        expect(view.projects).toEqual(all.projects);
        const { humanMs, humanHours, requests, wallMs, supervisedMs, unattendedMs, unattendedUnreadMs, agentHoursMs, agentHoursSupervisedMs, agentHoursUnattendedMs, coverage, agentCoverage } = view.totals;
        expect({ humanMs, humanHours, requests, wallMs, supervisedMs, unattendedMs, unattendedUnreadMs, agentHoursMs, agentHoursSupervisedMs, agentHoursUnattendedMs, coverage, agentCoverage }).toEqual({
          humanMs: row.humanMs, humanHours: row.humanHours, requests: row.requests, wallMs: row.wallMs, supervisedMs: row.supervisedMs,
          unattendedMs: row.unattendedMs, unattendedUnreadMs: row.unattendedUnreadMs, agentHoursMs: row.agentHoursMs,
          agentHoursSupervisedMs: row.agentHoursSupervisedMs, agentHoursUnattendedMs: row.agentHoursUnattendedMs,
          coverage: row.coverage, agentCoverage: row.agentCoverage,
        });
        /* A is the only billable project, so its billable hours are the page's. */
        expect(view.totals.billableHours).toBe(project === "A" ? all.totals.billableHours : 0);
        /* A flag is a fact of the whole day: the view keeps it. */
        expect(view.days.map((day) => day.missingSource)).toEqual(all.days.map((day) => day.missingSource));
        expect(view.totals.missingSourceDays).toBe(all.totals.missingSourceDays);
        for (const day of view.days) {
          expect(day.projects.every((entry) => entry.project === project)).toBe(true);
          expect(day.human.every((segment) => segment.project === project)).toBe(true);
          const sum = (pick: (hour: typeof day.hours[number]) => number) => day.hours.reduce((total, hour) => total + pick(hour), 0);
          expect(sum((hour) => hour.humanMs)).toBe(day.humanMs);
          expect(sum((hour) => hour.supervisedMs)).toBe(day.supervisedMs);
          expect(sum((hour) => hour.unattendedMs)).toBe(day.unattendedMs);
          expect(sum((hour) => hour.unattendedUnreadMs)).toBe(day.unattendedUnreadMs);
          if (params.rounding === "clock-hour") expect(sum((hour) => hour.weight ?? 0)).toBe(day.humanHours);
          const whole = all.days.find((entry) => entry.date === day.date)!;
          expect(day.humanHours).toBe(whole.projects.find((entry) => entry.project === project)?.humanHours ?? 0);
        }
      }
      /* The projects' views partition the page's minutes; their report hours,
         each counted alone, add up to at least the page's. */
      const views = ["A", "B"].map((project) => week(params, project).totals);
      expect(views.reduce((sum, totals) => sum + totals.humanMs, 0)).toBe(all.totals.humanMs);
      expect(views.reduce((sum, totals) => sum + totals.humanHours, 0)).toBeGreaterThanOrEqual(all.totals.humanHours);
      expect(views.reduce((sum, totals) => sum + totals.agentHoursMs, 0)).toBe(all.totals.agentHoursMs);
    }
  });

  test("the view of a project whose host was unread on Wednesday reads a lower bound there; the other project's does not", () => {
    const a = week(DEFAULTS, "A");
    const b = week(DEFAULTS, "B");
    expect(a.totals.coverage).toEqual({ complete: false, missingHosts: ["stage"] });
    expect(a.days.find((day) => day.date === "2026-09-23")!.coverage).toEqual({ complete: false, missingHosts: ["stage"] });
    expect(a.days.find((day) => day.date === "2026-09-23")!.hours[1]!.unreadHosts).toEqual(["stage"]);
    expect(b.totals.coverage).toEqual({ complete: true, missingHosts: [] });
    expect(b.days.find((day) => day.date === "2026-09-23")!.unknown).toEqual([]);
    /* A's night run on Wednesday is unclear; all of B's time was read. */
    expect(a.days.find((day) => day.date === "2026-09-23")!.unattendedUnreadMs).toBe(2 * HOUR);
    expect(b.days.find((day) => day.date === "2026-09-23")!.unattendedUnreadMs).toBe(0);
  });

  test("a project with only agent time whose host was not read: its time is a zero with incomplete coverage", () => {
    const view = activityReport({
      params: DEFAULTS, range: "7d", nowMs: NOW,
      anchors: [input("2026-09-22", "10:00", "harbor")],
      hosts: [LOCAL, readHost("stage", ["client-a"], [])],
      agents: [run("k", "client-a", "2026-09-22", "11:00", "13:00")],
      scope: { project: "client-a" },
    });
    expect(view.totals.humanMs).toBe(0);
    expect(view.totals.humanHours).toBe(0);
    expect(view.totals.requests).toBe(0);
    expect(view.totals.coverage).toEqual({ complete: false, missingHosts: ["stage"] });
    expect(view.totals.wallMs).toBe(2 * HOUR);
    expect(view.days.every((day) => !day.coverage.complete)).toBe(true);
    /* Its agents ran while its input was not read: all of it is unclear. */
    expect(view.totals.unattendedUnreadMs).toBe(2 * HOUR);
  });
});

describe("agent turns a host did not send make the agent figures a lower bound", () => {
  const DEFAULTS = clampMethodParams({}, "UTC");
  const NOW = Date.parse("2026-09-21T23:59:00Z");
  const report = (hosts: HostCoverage[]) => activityReport({
    params: DEFAULTS, range: "today", nowMs: NOW,
    anchors: [anchor(0, "harbor"), anchor(60, "client-a", "unknown", "message", "stage")],
    hosts,
    agents: [agent("h", "harbor", 0, 90), agent("c", "client-a", 60, 180)],
  });

  test("a listed host whose pull never answered: every total missing it is a lower bound, and names it", () => {
    const result = report([LOCAL, { ...readHost("stage", ["client-a"], []), agents: [] }]);
    expect(result.totals.agentCoverage).toEqual({ complete: false, missingHosts: ["stage"] });
    expect(result.days[0]!.agentCoverage).toEqual({ complete: false, missingHosts: ["stage"] });
    expect(result.projects.find((row) => row.project === "client-a")!.agentCoverage).toEqual({ complete: false, missingHosts: ["stage"] });
    /* A project the host does not hold is exact. */
    expect(result.projects.find((row) => row.project === "harbor")!.agentCoverage).toEqual({ complete: true, missingHosts: [] });
  });

  test("a host whose export read your input but whose agent turns nothing pulled: your time is complete, agent time is not", () => {
    const result = report([LOCAL, { ...readHost("stage", ["client-a"]), agents: [] }]);
    expect(result.totals.coverage).toEqual({ complete: true, missingHosts: [] });
    expect(result.totals.agentCoverage).toEqual({ complete: false, missingHosts: ["stage"] });
    const scoped = activityReport({
      params: DEFAULTS, range: "today", nowMs: NOW, anchors: [anchor(60, "client-a", "unknown", "message", "stage")],
      hosts: [LOCAL, { ...readHost("stage", ["client-a"]), agents: [] }], agents: [agent("c", "client-a", 60, 180)], scope: { project: "client-a" },
    });
    expect(scoped.totals.agentCoverage).toEqual({ complete: false, missingHosts: ["stage"] });
  });

  test("a host whose pull read it all: exact", () => {
    const result = report([LOCAL, readHost("stage", ["client-a"])]);
    expect(result.totals.agentCoverage).toEqual({ complete: true, missingHosts: [] });
    expect(result.days[0]!.agentCoverage.complete).toBe(true);
  });
});
