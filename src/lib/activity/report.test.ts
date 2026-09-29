import { describe, expect, test } from "bun:test";

import type { AgentSourceRead } from "./agentSource";
import type { HostReport, HostSourceRead, HumanInputRead } from "./hostSources";
import type { HumanInput } from "./humanInput";
import type { AgentConversation, HostCoverage, Interval } from "./method";
import { ActivityMemberForbidden, activityResponse, distinctNames, type ActivityResponse, type ActivityResponseDependencies } from "./report";

test("one project never reads twice: rows that share a display name take a piece of their key", () => {
  /* The shape of a real 7-day page: two scratch directories both named
     `work`, each its own project, beside a repository and an unattributed row. */
  const rows = distinctNames([
    { project: "repo-1111aaaa2222bbbb3333cccc4444dddd", name: "harbor" },
    { project: "dir-2a51da3c6f5a75e60546c35beb3cfebd", name: "work" },
    { project: "dir-92b4f8dcfa88eb3e179fb3a3355125ec", name: "work" },
    { project: "dir-0d83e166d2268dc0e7bdf7cc5210fa0d", name: "Handoff digests" },
    { project: null, name: null },
  ]);
  expect(rows.map((row) => row.name)).toEqual(["harbor", "work · 2a51da", "work · 92b4f8", "Handoff digests", null]);
  const named = rows.flatMap((row) => (row.name ? [row.name] : []));
  expect(new Set(named).size).toBe(named.length);
});

/* GET /api/activity as the route answers it, over invented hosts, projects
   and agents: this workstation reads everything; a stage host holds the
   client project only. */
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-09-24T15:00:00Z");
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`);
const HARBOR = "repo-1111aaaa2222bbbb3333cccc4444dddd";
const CLIENT = "repo-5555eeee6666ffff7777aaaa8888bbbb";
/** An older key of the client project, before its remote moved. */
const CLIENT_OLD = "repo-local-client";
const ALWAYS: Interval = { start: 0, end: Number.MAX_SAFE_INTEGER };

function input(date: string, hhmm: string, project: string, host = "workstation"): HumanInput {
  return { ids: [`${host}:${date}:${hhmm}:${project}`], at: at(date, hhmm), host, source: "transcripts", project, kind: "message", surface: "desktop", hash: null };
}

function source(kind: HostSourceRead["source"], state: HostSourceRead["state"], covered: Interval[], error: string | null = null): HostReport["sources"][number] {
  return { source: kind, state, scope: kind === "ledger" ? "delegatus" : "all", covered, inputs: 0, excluded: {}, exportedAt: null, readAt: state === "read" ? NOW : null, error };
}

function run(key: string, project: string, date: string, from: string, to: string): AgentConversation {
  return { key, project, engine: "codex", role: "builder", pipelineId: null, stageId: null, activity: [{ start: at(date, from), end: at(date, to) }] };
}

/** The stage host's sources: its pull, and an export when one was copied. */
function human(stage: HostReport["sources"], inputs: HumanInput[]): HumanInputRead {
  const covered = (sources: HostReport["sources"]) => sources.filter((entry) => entry.scope === "all").flatMap((entry) => entry.covered);
  const local = [source("ledger", "read", [{ start: at("2026-09-01", "00:00"), end: NOW }]), source("ingest", "read", [ALWAYS])];
  const coverage: HostCoverage[] = [
    { host: "workstation", projects: "all", since: null, covered: covered(local) },
    { host: "stage", projects: [CLIENT_OLD], since: null, covered: covered(stage) },
  ];
  return {
    inputs,
    coverage,
    hosts: [
      { host: "workstation", label: "Workstation", local: true, configured: true, projects: "all", since: null, sources: local, unknownAuthors: 0, configurationGap: false },
      { host: "stage", label: "Stage host", local: false, configured: true, projects: [CLIENT_OLD], since: null, sources: stage, unknownAuthors: 0, configurationGap: false },
    ],
    config: "ok",
  };
}

function dependencies(stage: HostReport["sources"], inputs: HumanInput[], agents: AgentConversation[]): Partial<ActivityResponseDependencies> {
  return {
    now: () => NOW,
    settings: () => ({ tz: "UTC", billable: [CLIENT_OLD], workdays: [1, 2, 3, 4, 5] }),
    humanInputs: () => human(stage, inputs),
    agents: (): AgentSourceRead => ({ agents, index: { available: true, indexedAtMs: NOW }, local: "ingest" }),
    canonicalProject: (project) => (project === CLIENT_OLD ? CLIENT : project),
    projectNames: async () => new Map([[HARBOR, "harbor"], [CLIENT, "client-portal"]]),
    roster: () => [],
  };
}

const INPUTS = [
  input("2026-09-22", "09:02", HARBOR), input("2026-09-22", "09:09", HARBOR), input("2026-09-22", "09:30", CLIENT_OLD, "stage"),
  input("2026-09-22", "09:36", HARBOR), input("2026-09-23", "13:05", CLIENT_OLD, "stage"), input("2026-09-24", "10:00", HARBOR),
];
const AGENTS = [
  run("h1", HARBOR, "2026-09-22", "08:00", "11:00"), run("h2", HARBOR, "2026-09-22", "09:30", "10:30"),
  run("stage:c1", CLIENT, "2026-09-23", "12:00", "16:00"), run("c2", CLIENT, "2026-09-24", "01:00", "03:00"),
];
/** The stage host pulled up to Wednesday noon, and never since. */
const PULLED_TO_WEDNESDAY = [source("pull", "read", [{ start: at("2026-09-01", "00:00"), end: at("2026-09-23", "12:00") }])];

const get = (query: string, overrides: Partial<ActivityResponseDependencies>) => activityResponse(new URLSearchParams(query), overrides);
const row = (body: ActivityResponse, project: string) => body.projects.find((entry) => entry.project === project)!;

describe("GET /api/activity?project=: the page filtered to one project", () => {
  test("the scoped totals are that project's row in the unscoped answer, for every project and range", async () => {
    const deps = dependencies(PULLED_TO_WEDNESDAY, INPUTS, AGENTS);
    for (const range of ["today", "7d", "30d"]) {
      const all = await get(`range=${range}`, deps);
      expect(all.scope).toBeNull();
      for (const project of [HARBOR, CLIENT]) {
        const scoped = await get(`range=${range}&project=${project}`, deps);
        const unscoped = row(all, project);
        expect(scoped.scope).toEqual({ project, name: unscoped.name });
        const pick = (figures: ActivityResponse["totals"] | ActivityResponse["projects"][number]) => ({
          humanMs: figures.humanMs, humanHours: figures.humanHours, requests: figures.requests, wallMs: figures.wallMs,
          supervisedMs: figures.supervisedMs, unattendedMs: figures.unattendedMs, unattendedUnreadMs: figures.unattendedUnreadMs,
          agentHoursMs: figures.agentHoursMs, coverage: figures.coverage, agentCoverage: figures.agentCoverage,
        });
        expect(pick(scoped.totals)).toEqual(pick(unscoped));
        /* The Projects list keeps every project, the same rows. */
        expect(scoped.projects).toEqual(all.projects);
        expect(scoped.days.map((day) => day.date)).toEqual(all.days.map((day) => day.date));
      }
    }
    /* Something was counted on both, or the equality above proves little. */
    const week = await get("range=7d", deps);
    expect(row(week, HARBOR).humanMs).toBeGreaterThan(0);
    expect(row(week, CLIENT).humanMs).toBeGreaterThan(0);
    expect(row(week, HARBOR).agentHoursMs).toBeGreaterThan(row(week, HARBOR).wallMs);
  });

  test("an older key of a project names it; an empty or malformed key scopes nothing", async () => {
    const deps = dependencies(PULLED_TO_WEDNESDAY, INPUTS, AGENTS);
    const older = await get(`range=7d&project=${CLIENT_OLD}`, deps);
    expect(older.scope).toEqual({ project: CLIENT, name: "client-portal" });
    expect(older.totals.humanMs).toBe(row(older, CLIENT).humanMs);
    expect((await get("range=7d&project=", deps)).scope).toBeNull();
    expect((await get(`range=7d&project=${"x".repeat(301)}`, deps)).scope).toBeNull();
    expect((await get("range=7d&project=a%00b", deps)).scope).toBeNull();
  });

  test("only the hosts that can hold the project bear on its page", async () => {
    const deps = dependencies(PULLED_TO_WEDNESDAY, INPUTS, AGENTS);
    const harbor = await get(`range=7d&project=${HARBOR}`, deps);
    expect(harbor.coverage.hosts.map((host) => [host.host, host.inScope])).toEqual([["workstation", true], ["stage", false]]);
    expect(harbor.totals.coverage).toEqual({ complete: true, missingHosts: [] });
    const client = await get(`range=7d&project=${CLIENT}`, deps);
    expect(client.coverage.hosts.map((host) => [host.host, host.inScope])).toEqual([["workstation", true], ["stage", true]]);
    expect(client.totals.coverage).toEqual({ complete: false, missingHosts: ["stage"] });
  });
});

describe("GET /api/activity: projects worked in parallel each count their own hours", () => {
  test("a project's page and row read its own hours; the page's total reads the hour once", async () => {
    /* The client asks every ten minutes from 10:00 and harbor five minutes
       after each: each covers 40 minutes of the hour on its own. */
    const inputs = [
      ...["10:00", "10:10", "10:20", "10:30"].map((hhmm) => input("2026-09-22", hhmm, CLIENT_OLD, "stage")),
      ...["10:05", "10:15", "10:25", "10:35"].map((hhmm) => input("2026-09-22", hhmm, HARBOR)),
    ];
    const deps = dependencies([source("pull", "read", [ALWAYS])], inputs, []);
    const all = await get("range=7d", deps);
    expect(row(all, CLIENT).humanHours).toBe(1);
    expect(row(all, HARBOR).humanHours).toBe(1);
    expect(all.totals.humanHours).toBe(1);
    for (const project of [CLIENT, HARBOR]) {
      const scoped = await get(`range=7d&project=${project}`, deps);
      expect(scoped.totals.humanHours).toBe(1);
      expect(scoped.days.find((day) => day.date === "2026-09-22")!.humanHours).toBe(1);
    }
  });
});

describe("a listed host whose agent turns never arrived", () => {
  const client = (body: ActivityResponse) => row(body, CLIENT);

  for (const [name, stage] of [
    ["its pull never answered yet", [source("pull", "pending", [])]],
    ["its pull answers that the host records no activity", [source("pull", "unreadable", [], "no-ingest")]],
    ["it has no pull entry, only an export copied by hand", [source("transcripts", "read", [ALWAYS])]],
  ] as const) {
    test(`${name}: every agent total that misses it is a lower bound naming it`, async () => {
      const body = await get("range=7d", dependencies([...stage], INPUTS.filter((entry) => entry.host === "workstation"), AGENTS.filter((agent) => !agent.key.startsWith("stage:"))));
      expect(body.totals.agentCoverage).toEqual({ complete: false, missingHosts: ["stage"] });
      expect(client(body).agentCoverage).toEqual({ complete: false, missingHosts: ["stage"] });
      expect(row(body, HARBOR).agentCoverage).toEqual({ complete: true, missingHosts: [] });
      expect(body.days.every((day) => !day.agentCoverage.complete)).toBe(true);
      const host = body.coverage.hosts.find((entry) => entry.host === "stage")!;
      expect(host.agentsComplete).toBe(false);
      expect(host.agentsUnread.length).toBeGreaterThan(0);
      expect(body.coverage.hosts.find((entry) => entry.host === "workstation")!.agentsComplete).toBe(true);
      /* A project's own page says the same. */
      const scoped = await get(`range=7d&project=${CLIENT}`, dependencies([...stage], [], []));
      expect(scoped.totals.agentCoverage).toEqual({ complete: false, missingHosts: ["stage"] });
    });
  }

  test("once its pull reads the whole range, the agent totals are exact", async () => {
    const body = await get("range=7d", dependencies([source("pull", "read", [ALWAYS])], INPUTS, AGENTS));
    expect(body.totals.agentCoverage).toEqual({ complete: true, missingHosts: [] });
    expect(body.coverage.hosts.every((host) => host.agentsComplete)).toBe(true);
    expect(client(body).wallMs).toBe(6 * HOUR);
  });
});

/* The owner's view of every member (docs/design/activity-dashboard.md, "The
   owner's view of every member"): an invented team of three on this
   workstation, and the stage host pulled for the owner alone. */
describe("GET /api/activity?member=: the owner's view of every member", () => {
  const OWNER = "m_owner0000000000000000000000000";
  const BO = "m_bo000000000000000000000000000000";
  const CY = "m_cy000000000000000000000000000000";
  const ROSTER = [
    { id: OWNER, name: "Ada Quill", color: "teal" as const, initials: "AQ", status: "active" as const },
    { id: BO, name: "Bo Tern", color: "sky" as const, initials: "BT", status: "active" as const },
    { id: CY, name: "Cy Marsh", color: "pink" as const, initials: "CM", status: "active" as const },
  ];
  const by = (author: string, entry: HumanInput): HumanInput => ({ ...entry, author, ids: entry.ids.map((id) => `${author}:${id}`) });
  /* The owner and Bo both work harbor 09:00-09:30 on Tuesday; Bo alone on
     Wednesday; the owner on the stage host (the client) on Tuesday. A removed
     member's input stays theirs, under their id. */
  const TEAM_INPUTS = [
    ...["09:00", "09:10", "09:20"].map((hhmm) => by(OWNER, input("2026-09-22", hhmm, HARBOR))),
    ...["09:00", "09:10", "09:20"].map((hhmm) => by(BO, input("2026-09-22", hhmm, HARBOR))),
    ...["14:00", "14:10"].map((hhmm) => by(BO, input("2026-09-23", hhmm, HARBOR))),
    by(OWNER, input("2026-09-22", "11:00", CLIENT_OLD, "stage")),
    by("m_gone00000000000000000000000000", input("2026-09-24", "08:00", HARBOR)),
  ];
  function team(read: Partial<HumanInputRead> = {}): Partial<ActivityResponseDependencies> {
    const base = dependencies([source("pull", "read", [ALWAYS])], TEAM_INPUTS, AGENTS);
    return {
      ...base,
      roster: () => ROSTER,
      humanInputs: (_window, _now, viewer) => {
        const whole = human([source("pull", "read", [ALWAYS])], TEAM_INPUTS);
        const hosts = whole.hosts.map((host) => (host.local ? host : { ...host, memberScoped: true }));
        /* A read that is not the owner's holds the viewer's input alone. */
        if (!viewer?.everyone) return { ...whole, hosts, inputs: TEAM_INPUTS.filter((entry) => entry.author === viewer?.memberId), unknownAuthors: 2 };
        return { ...whole, hosts, operator: OWNER, unknownAuthors: 2, ...read };
      },
    };
  }
  const OWNER_VIEW = { mode: "team" as const, memberId: OWNER, canChoose: true };
  const view = (query: string, viewer: Parameters<typeof activityResponse>[2] = OWNER_VIEW) => activityResponse(new URLSearchParams(query), team(), viewer);
  const member = (body: ActivityResponse, id: string) => body.member.members.find((entry) => entry.id === id)!;

  test("absent, the owner reads their own figures as before, with every member listed beside them", async () => {
    const own = await view("range=7d");
    expect(own.member).toMatchObject({ selection: "self", memberId: OWNER, canChoose: true, notSplit: ["agents", "unknownAuthorInputs"] });
    /* The same count a member-blind read of the owner's input gives. */
    const blind = await activityResponse(new URLSearchParams("range=7d"), dependencies([source("pull", "read", [ALWAYS])], TEAM_INPUTS.filter((entry) => entry.author === OWNER), AGENTS));
    expect(own.totals).toEqual(blind.totals);
    expect(own.projects).toEqual(blind.projects);
    expect(own.member.members.map((entry) => [entry.id, entry.name, entry.initials, entry.self])).toEqual([
      [BO, "Bo Tern", "BT", false],
      [OWNER, "Ada Quill", "AQ", true],
      ["m_gone00000000000000000000000000", null, null, false],
      [CY, "Cy Marsh", "CM", false],
    ]);
    expect(member(own, OWNER).humanMs).toBe(own.totals.humanMs);
    /* Nothing leaks from the roster beyond a name, a colour and initials. */
    expect(Object.keys(member(own, BO)).sort()).toEqual(["billableHours", "color", "coverage", "humanHours", "humanMs", "id", "initials", "missingSourceDays", "name", "projects", "requests", "self"]);
    /* A card reads what that member's own page reads. */
    const boPage = await view(`range=7d&member=${BO}`);
    expect(member(own, BO)).toMatchObject({ humanMs: boPage.totals.humanMs, humanHours: boPage.totals.humanHours, coverage: boPage.totals.coverage, missingSourceDays: boPage.totals.missingSourceDays });
  });

  test("all: every member counted alone, then added, so two people in one hour are two hours", async () => {
    const all = await view("range=7d&member=all");
    expect(all.member).toMatchObject({ selection: "all", memberId: null });
    const rows = all.member.members;
    const add = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((sum, row) => sum + pick(row), 0);
    expect(all.totals.humanMs).toBe(add((row) => row.humanMs));
    expect(all.totals.humanHours).toBe(add((row) => row.humanHours));
    expect(all.totals.requests).toBe(add((row) => row.requests));
    expect(all.totals.requests).toBe(TEAM_INPUTS.length);
    const tuesday = all.days.find((day) => day.date === "2026-09-22")!;
    /* 09:00-09:30 each, harbor, for two people; the owner's stage hour beside. */
    expect(tuesday.projects.find((entry) => entry.project === HARBOR)!.humanMs).toBe(2 * 30 * MIN);
    expect(row(all, HARBOR).humanMs).toBe(add((entry) => entry.projects.find((p) => p.project === HARBOR)?.humanMs ?? 0));
    expect(member(all, BO).projects.map((entry) => [entry.name, entry.humanMs])).toEqual([["harbor", 30 * MIN + 20 * MIN]]);
    /* Agent time is one axis: the same figures as any member's page. */
    const own = await view("range=7d");
    expect(all.totals.wallMs).toBe(own.totals.wallMs);
    expect(all.totals.agentHoursMs).toBe(own.totals.agentHoursMs);
  });

  test("a member whose input may live on a host pulled for the owner reads not covered, never zero", async () => {
    const all = await view("range=7d&member=all");
    expect(member(all, CY)).toMatchObject({ humanMs: 0, requests: 0, coverage: { complete: false, missingHosts: ["stage"] } });
    expect(member(all, BO).coverage).toEqual({ complete: false, missingHosts: ["stage"] });
    expect(member(all, OWNER).coverage).toEqual({ complete: true, missingHosts: [] });
    /* Every member together misses the others' stage input too. */
    expect(all.totals.coverage).toEqual({ complete: false, missingHosts: ["stage"] });
    const cy = await view(`range=7d&member=${CY}`);
    expect(cy.member).toMatchObject({ selection: "member", memberId: CY });
    expect(cy.totals.humanMs).toBe(0);
    expect(cy.totals.coverage).toEqual({ complete: false, missingHosts: ["stage"] });
    expect(cy.coverage.hosts.find((host) => host.host === "stage")).toMatchObject({ complete: false, memberScoped: true });
    /* A project the stage host cannot hold stays exact for them. */
    const harbor = await view(`range=7d&member=${CY}&project=${HARBOR}`);
    expect(harbor.totals.coverage).toEqual({ complete: true, missingHosts: [] });
  });

  test("one member's page counts that member alone; the unknown-author count stays beside it", async () => {
    const bo = await view(`range=7d&member=${BO}`);
    expect(bo.totals.humanMs).toBe(member(bo, BO).humanMs);
    expect(bo.totals.requests).toBe(5);
    expect(bo.unknownAuthorInputs).toBe(2);
    const own = await view(`range=7d&member=${OWNER}`);
    expect(own.member.selection).toBe("self");
    expect(own.totals).toEqual((await view("range=7d")).totals);
  });

  test("only the owner names someone else; anyone may name themselves", async () => {
    const bo = { mode: "team" as const, memberId: BO, canChoose: false };
    for (const query of ["range=7d&member=all", `range=7d&member=${OWNER}`, `range=7d&member=${CY}`]) {
      const failure = await view(query, bo).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(ActivityMemberForbidden);
      expect((failure as ActivityMemberForbidden).code).toBe("activity_member_forbidden");
    }
    for (const query of ["range=7d", `range=7d&member=${BO}`, "range=7d&member=%20"]) {
      const own = await view(query, bo);
      expect(own.member).toEqual({ selection: "self", memberId: BO, canChoose: false, members: [], notSplit: [] });
      expect(own.totals.requests).toBe(5);
    }
    /* A solo host's operator may read every member. */
    const solo = await activityResponse(new URLSearchParams("range=7d&member=all"), team({ operator: "operator" }), { mode: "solo", memberId: null, canChoose: true });
    expect(solo.member.canChoose).toBe(true);
  });
});
