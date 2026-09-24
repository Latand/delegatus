import { describe, expect, test } from "bun:test";

import type { AgentSourceRead } from "./agentSource";
import type { HostReport, HostSourceRead, HumanInputRead } from "./hostSources";
import type { HumanInput } from "./humanInput";
import type { AgentConversation, HostCoverage, Interval } from "./method";
import { activityResponse, distinctNames, type ActivityResponse, type ActivityResponseDependencies } from "./report";

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
  return { ids: [`${host}:${date}:${hhmm}:${project}`], at: at(date, hhmm), host, source: host === "workstation" ? "ingest" : "pull", project, kind: "message", surface: "desktop", hash: null };
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
      { host: "workstation", label: "Workstation", local: true, configured: true, projects: "all", since: null, sources: local },
      { host: "stage", label: "Stage host", local: false, configured: true, projects: [CLIENT_OLD], since: null, sources: stage },
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
