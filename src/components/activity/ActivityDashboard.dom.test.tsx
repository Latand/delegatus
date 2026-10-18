import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { AgentSourceRead } from "@/lib/activity/agentSource";
import type { HostReport, HostSourceRead, HumanInputRead } from "@/lib/activity/hostSources";
import type { HumanInput } from "@/lib/activity/humanInput";
import type { AgentConversation, HostCoverage, Interval } from "@/lib/activity/method";
import { ACTIVITY_MEMBER_FORBIDDEN, ActivityMemberForbidden, activityResponse, type ActivityRequestViewer, type ActivityResponseDependencies } from "@/lib/activity/report";
import { ActivityStore } from "@/lib/activity/store";
import { activityTokensResponse } from "@/lib/activity/tokenReport";
import { commitUsage } from "@/lib/activity/tokenStore";
import type { TokenCounts } from "@/lib/activity/tokenUsage";
import { setLocale, translate } from "@/lib/i18n";
import { installActEnv } from "@/test-helpers/actEnv";

import { ActivityDashboard } from "./ActivityDashboard";
import { memberFromSearch } from "./ActivityMembers";
import { hoursText, projectFromSearch } from "./format";
import { byFromSearch, rangeFromSearch, viewFromSearch } from "./pageParams";
import { compact, datesLabel, percent } from "./tokenParts";

/* The desktop /activity page scoped to one project, driven the way the
   operator drives it, over the real API function with invented hosts,
   projects and agents. The page is mounted as the route mounts it: the
   project comes from the address. */

const dom = new Window({ url: "http://localhost/activity?range=7d", width: 1440, height: 900 });
class NoResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  location: dom.location,
  history: dom.history,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  SVGElement: dom.SVGElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  PopStateEvent: dom.PopStateEvent,
  ResizeObserver: NoResizeObserver,
});
/* The desktop page unless a case draws the narrow one. */
let wide = true;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: wide && query === "(min-width: 1024px)",
  media: query,
  addEventListener() {},
  removeEventListener() {},
});
(dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
installActEnv();

const MIN = 60_000;
const NOW = Date.parse("2026-09-24T15:00:00Z");
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`);
const HARBOR = "repo-1111aaaa2222bbbb3333cccc4444dddd";
const CLIENT = "repo-5555eeee6666ffff7777aaaa8888bbbb";
const ALWAYS: Interval = { start: 0, end: Number.MAX_SAFE_INTEGER };

function input(date: string, hhmm: string, project: string, host = "workstation"): HumanInput {
  return { ids: [`${host}:${date}:${hhmm}`], at: at(date, hhmm), host, source: "transcripts", project, kind: "message", surface: "desktop", hash: null };
}
function source(kind: HostSourceRead["source"], state: HostSourceRead["state"], covered: Interval[]): HostReport["sources"][number] {
  return { source: kind, state, scope: "all", covered, inputs: 0, excluded: {}, exportedAt: null, readAt: state === "read" ? NOW : null, error: null };
}
function run(key: string, project: string, date: string, from: string, to: string): AgentConversation {
  return { key, project, engine: "codex", role: "builder", pipelineId: null, stageId: null, activity: [{ start: at(date, from), end: at(date, to) }] };
}

/** This workstation reads everything; a stage host holds the client project. */
function deps(stagePull: HostReport["sources"][number], inputs: HumanInput[], agents: AgentConversation[], memberGap = false): Partial<ActivityResponseDependencies> {
  const local = [source("ingest", "read", [ALWAYS])];
  const coverage: HostCoverage[] = [
    { host: "workstation", projects: "all", since: null, covered: [ALWAYS] },
    { host: "stage", projects: [CLIENT], since: null, covered: stagePull.covered },
  ];
  const human: HumanInputRead = {
    inputs,
    coverage,
    hosts: [
      { host: "workstation", label: "Workstation", local: true, configured: true, projects: "all", since: null, sources: local, unknownAuthors: 2, configurationGap: false },
      { host: "stage", label: "Stage host", local: false, configured: true, projects: [CLIENT], since: null, sources: [stagePull], unknownAuthors: 0, configurationGap: memberGap },
    ],
    config: "ok",
    unknownAuthors: 2,
  };
  return {
    now: () => NOW,
    settings: () => ({ tz: "UTC", billable: [], workdays: [1, 2, 3, 4, 5] }),
    humanInputs: () => human,
    agents: (): AgentSourceRead => ({ agents, index: { available: true, indexedAtMs: NOW }, local: "ingest" }),
    canonicalProject: (project) => project,
    projectNames: async () => new Map([[HARBOR, "harbor"], [CLIENT, "client-portal"]]),
  };
}

const READ = deps(source("pull", "read", [ALWAYS]), [
  input("2026-09-22", "09:02", HARBOR), input("2026-09-22", "09:30", HARBOR), input("2026-09-22", "09:55", HARBOR),
  input("2026-09-23", "13:05", CLIENT, "stage"), input("2026-09-23", "13:40", CLIENT, "stage"), input("2026-09-24", "10:00", HARBOR),
], [run("h", HARBOR, "2026-09-22", "08:00", "11:00"), run("c", CLIENT, "2026-09-23", "12:00", "16:00")]);

let current = READ;
/* Who asks: nobody in particular (a member-blind read) unless a case signs in. */
let viewer: ActivityRequestViewer | undefined;
const requests: URLSearchParams[] = [];

/* The Tokens tab reads the real token report over a store seeded through the
   ingest's own write: three responses a day before NOW, in two projects. */
const tokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "activity-tokens-dom-"));
const tokenFile = path.join(tokenRoot, "records.sqlite");
afterAll(() => fs.rmSync(tokenRoot, { recursive: true, force: true }));
const TOKEN_OWNER = "m_owner0000000000000000000000000";
const counts = (partial: Partial<TokenCounts>): TokenCounts => ({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, requests: 1, ...partial });
function seedTokens(id: string, project: string, role: string, engine: "claude" | "codex", model: string, tier: string, usage: TokenCounts) {
  const store = ActivityStore.open(tokenFile);
  try {
    store.transaction(() => commitUsage(store.db, {
      owner: { conversation: id, project, engine, role, pipelineId: null, stageId: null },
      /* A Codex response carries its thread's running total, as a rollout's record does. */
      records: [{ engine, id, at: NOW - 86_400_000, model, tier, counts: usage, ...(engine === "codex" ? { cumulative: {
        total: usage.input + usage.cacheRead + usage.cacheWrite + usage.output, input: usage.input + usage.cacheRead + usage.cacheWrite,
        cached: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output, reasoning: usage.reasoning,
      } } : {}) }],
      attribution: () => ({ member: TOKEN_OWNER, account: "account-a", model: null, tier: null }),
      malformed: 0,
      now: NOW,
    }));
  } finally {
    store.close();
  }
}
function markTokensRead() {
  const store = ActivityStore.open(tokenFile);
  try { store.db.exec("UPDATE usage_meta SET complete=1, pending_bytes=0"); } finally { store.close(); }
}
seedTokens("opus", HARBOR, "builder", "claude", "claude-opus-5-5", "standard", counts({ input: 1e6, cacheRead: 40e6, cacheWrite: 2e6, cacheWrite1h: 1e6, output: 5e5, reasoning: 2e5 }));
seedTokens("sol", CLIENT, "reviewer", "codex", "gpt-6.1-sol", "default", counts({ input: 2e6, cacheRead: 20e6, output: 1e6, reasoning: 5e5 }));
seedTokens("mystery", HARBOR, "builder", "claude", "fixture-model", "standard", counts({ input: 1e5 }));
markTokensRead();
const TOKEN_TOTAL = 43.5e6 + 23e6 + 1e5;
const tokenRequests: URLSearchParams[] = [];
const lastTokens = () => tokenRequests.at(-1)!;
const SOLO: ActivityRequestViewer = { mode: "solo", memberId: null, canChoose: true };
const tokenDeps = {
  now: () => NOW,
  file: () => tokenFile,
  tz: () => "UTC",
  aliases: () => ({}),
  canonical: (project: string) => project,
  projectNames: async () => new Map([[HARBOR, "harbor"], [CLIENT, "client-portal"]]),
  roster: () => [{ id: TOKEN_OWNER, name: "Ada Quill", color: "teal", initials: "AQ", self: false }],
  accounts: () => new Map([["account-a", "Claude · A"]]),
};

globalThis.fetch = (async (resource: string | URL | Request) => {
  const url = new URL(String(resource), "http://localhost");
  if (url.pathname === "/api/activity/tokens") {
    tokenRequests.push(url.searchParams);
    try {
      return new Response(JSON.stringify(await activityTokensResponse(url.searchParams, viewer ?? SOLO, tokenDeps)), { status: 200 });
    } catch (error) {
      if (error instanceof ActivityMemberForbidden) return new Response(JSON.stringify({ error: error.message, code: ACTIVITY_MEMBER_FORBIDDEN }), { status: 403 });
      throw error;
    }
  }
  if (url.pathname !== "/api/activity") throw new Error(`unexpected request ${url.pathname}`);
  requests.push(url.searchParams);
  try {
    return new Response(JSON.stringify(await activityResponse(url.searchParams, current, viewer)), { status: 200 });
  } catch (error) {
    /* As the route answers it. */
    if (error instanceof ActivityMemberForbidden) return new Response(JSON.stringify({ error: error.message, code: ACTIVITY_MEMBER_FORBIDDEN }), { status: 403 });
    throw error;
  }
}) as typeof fetch;

let root: Root | null = null;
let host: ReturnType<typeof dom.document.createElement> | null = null;

async function settle() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Mount the page as the route does: the project from the address. */
async function open(address: string) {
  dom.history.replaceState(null, "", address);
  host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as Element);
  const search = new URLSearchParams(dom.location.search);
  await act(async () => root!.render(<ActivityDashboard initialRange={rangeFromSearch(search)} initialView={viewFromSearch(search)} initialBy={byFromSearch(search)} initialProject={projectFromSearch(dom.location.search)} initialMember={memberFromSearch(dom.location.search)} />));
  await settle();
}
async function unmount() {
  if (root) await act(async () => root!.unmount());
  root = null;
  host = null;
  dom.document.body.replaceChildren();
}
async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => { element!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  await settle();
}

const $ = (selector: string) => dom.document.querySelector(selector) as unknown as HTMLElement | null;
const address = () => new URLSearchParams(dom.location.search);
const lastRequest = () => requests.at(-1)!;
const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);
const rowOf = async (project: string, range = "7d") => (await activityResponse(new URLSearchParams({ range }), current)).projects.find((row) => row.project === project)!;

beforeEach(() => {
  setLocale("en");
  current = READ;
  viewer = undefined;
  wide = true;
  requests.length = 0;
  tokenRequests.length = 0;
});
afterEach(unmount);

describe("the page filtered to one project", () => {
  test("unknown-author input has its own visible count outside the personal figure", async () => {
    await open("/activity?range=7d");
    expect($("[data-activity-unknown-author-total]")?.getAttribute("data-activity-unknown-author-total")).toBe("2");
    expect($("[data-activity-unknown-author-total]")?.textContent).toContain("Unknown author: 2");
    await click($("[data-activity-how]"));
    expect($("[data-activity-host=workstation] [data-activity-unknown-author]")?.textContent).toContain("Unknown author: 2");
  });

  test("a team host without member selection names the configuration gap", async () => {
    current = deps({ ...source("pull", "read", []), error: "member-unconfigured" }, [], [], true);
    await open("/activity?range=7d");
    await click($("[data-activity-how]"));
    expect($("[data-activity-host=stage] [data-activity-member-gap]")?.textContent).toContain("member ID");
  });

  test("?project= round-trips: it opens scoped, a row click pushes a step, Back restores it, the range keeps it, a reload keeps it", async () => {
    await open(`/activity?range=7d&project=${HARBOR}`);
    expect(lastRequest().get("project")).toBe(HARBOR);
    expect($("[data-activity-scope-chip]")!.textContent).toBe("harbor");
    const harbor = await rowOf(HARBOR);
    expect(harbor.humanHours).toBeGreaterThan(0);
    expect($("[data-activity-hero]")!.textContent).toBe(hoursText(harbor.humanHours, "en", t));
    expect($(`[data-activity-project="${HARBOR}"]`)!.getAttribute("data-selected")).toBe("true");
    /* The list still holds every project. */
    expect($(`[data-activity-project="${CLIENT}"]`)).not.toBeNull();

    const before = dom.history.length;
    await click($(`[data-activity-project="${CLIENT}"] button`));
    expect(address().get("project")).toBe(CLIENT);
    expect(dom.history.length).toBe(before + 1);
    expect(lastRequest().get("project")).toBe(CLIENT);
    expect($("[data-activity-scope-chip]")!.textContent).toBe("client-portal");
    expect($(`[data-activity-project="${CLIENT}"]`)!.getAttribute("data-selected")).toBe("true");
    expect($(`[data-activity-project="${HARBOR}"]`)!.getAttribute("data-selected")).toBeNull();

    await act(async () => dom.history.back());
    await settle();
    expect(address().get("project")).toBe(HARBOR);
    expect($("[data-activity-scope-chip]")!.textContent).toBe("harbor");
    expect(lastRequest().get("project")).toBe(HARBOR);

    await click($('[data-activity-option="30d"]'));
    expect(address().get("range")).toBe("30d");
    expect(address().get("project")).toBe(HARBOR);
    expect(lastRequest().get("range")).toBe("30d");
    expect(lastRequest().get("project")).toBe(HARBOR);
    expect($("[data-activity-hero]")!.textContent).toBe(hoursText((await rowOf(HARBOR, "30d")).humanHours, "en", t));

    await unmount();
    await open(`/activity${dom.location.search}`);
    expect(lastRequest().get("project")).toBe(HARBOR);
    expect($("[data-activity-scope-chip]")!.textContent).toBe("harbor");
  });

  test("clearing the chip returns to every project", async () => {
    await open(`/activity?range=7d&project=${CLIENT}`);
    expect($("[data-activity-scope-chip]")).not.toBeNull();
    await click($("[data-activity-scope-clear]"));
    expect(address().has("project")).toBe(false);
    expect(lastRequest().has("project")).toBe(false);
    expect($("[data-activity-scope-chip]")).toBeNull();
    const all = await activityResponse(new URLSearchParams({ range: "7d" }), current);
    expect($("[data-activity-hero]")!.textContent).toBe(hoursText(all.totals.humanHours, "en", t));
    expect(dom.document.querySelectorAll('[data-selected="true"]').length).toBe(0);
    /* Clicking the chosen row again clears it too. */
    await click($(`[data-activity-project="${HARBOR}"] button`));
    expect(address().get("project")).toBe(HARBOR);
    await click($(`[data-activity-project="${HARBOR}"] button`));
    expect(address().has("project")).toBe(false);
  });

  test("the header's picker finds a project the list folds away, by name", async () => {
    await open("/activity?range=7d");
    await click($("[data-activity-picker-trigger]"));
    /* The field's own handlers, read afresh after each render. */
    const props = () => {
      const search = $("[data-activity-picker-search]")!;
      return (search as unknown as Record<string, { onChange: (event: unknown) => void; onKeyDown: (event: unknown) => void }>)[Object.keys(search).find((key) => key.startsWith("__reactProps$"))!]!;
    };
    await act(async () => props().onChange({ target: { value: "client" } }));
    const options = dom.document.querySelectorAll("[data-activity-picker-option]");
    expect(options.length).toBe(1);
    expect(options[0]!.getAttribute("data-activity-picker-option")).toBe(CLIENT);
    await act(async () => props().onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation() {} }));
    await settle();
    expect(address().get("project")).toBe(CLIENT);
    expect($("[data-activity-picker]")!.getAttribute("data-activity-picker")).toBe("closed");
    expect($("[data-activity-scope-chip]")!.textContent).toBe("client-portal");
  });

  test("a project with only agent time whose host was not read: You reads Unknown and its agent time is a lower bound", async () => {
    /* The stage host is listed and its pull never answered: nothing of the
       client project's input was read, and its agents there never arrived. */
    current = deps(source("pull", "pending", []), [input("2026-09-22", "09:02", HARBOR)], [run("c", CLIENT, "2026-09-23", "12:00", "14:00")]);
    await open(`/activity?range=7d&project=${CLIENT}`);
    const hero = $("[data-activity-hero]")!;
    expect(hero.getAttribute("data-activity-hero")).toBe("unknown");
    expect(hero.textContent).toBe("Unknown");
    expect($('[data-activity-figure="you"]')!.textContent).not.toContain("0 h");
    expect($('[data-activity-figure="you"]')!.textContent).toContain("Stage host");
    expect($("[data-activity-agents-value]")!.textContent).toContain("≥");
    expect($("[data-activity-trust]")!.getAttribute("data-activity-trust")).toBe("lower");
    expect($(`[data-activity-project="${CLIENT}"] [data-activity-project-you]`)!.textContent).toBe("?");
    expect($(`[data-activity-project="${CLIENT}"] [data-activity-project-agents]`)!.textContent).toBe(`≥ ≈ 2 h`);
    expect(2 * 60 * MIN).toBe((await rowOf(CLIENT)).wallMs);
  });
});

/* The owner of an invented team of three: the owner and Bo on this
   workstation, Cy with nothing read here, and the stage host pulled for the
   owner alone. */
const OWNER = "m_owner0000000000000000000000000";
const BO = "m_bo000000000000000000000000000000";
const CY = "m_cy000000000000000000000000000000";
function teamDeps(): Partial<ActivityResponseDependencies> {
  const by = (author: string, entry: HumanInput): HumanInput => ({ ...entry, author, ids: entry.ids.map((id) => `${author}:${id}`) });
  const inputs = [
    ...["09:00", "09:10", "09:20"].map((hhmm) => by(OWNER, input("2026-09-22", hhmm, HARBOR))),
    by(OWNER, input("2026-09-23", "13:05", CLIENT, "stage")),
    ...["09:00", "09:10", "09:20", "09:40", "09:50"].map((hhmm) => by(BO, input("2026-09-22", hhmm, HARBOR))),
  ];
  const base = deps(source("pull", "read", [ALWAYS]), inputs, [run("h", HARBOR, "2026-09-22", "08:00", "11:00")]);
  return {
    ...base,
    roster: () => [
      { id: OWNER, name: "Ada Quill", color: "teal", initials: "AQ", status: "active" },
      { id: BO, name: "Bo Tern", color: "sky", initials: "BT", status: "active" },
      { id: CY, name: "Cy Marsh", color: "pink", initials: "CM", status: "active" },
    ],
    humanInputs: (window, now, read) => {
      const whole = base.humanInputs!(window, now, read);
      /* Bounded spans, as a real source reports them: the narrow page prints them. */
      const hosts = whole.hosts.map((host) => ({
        ...host,
        sources: host.sources.map((entry) => ({ ...entry, covered: [{ start: at("2026-09-01", "00:00"), end: NOW }] })),
        ...(host.local ? {} : { memberScoped: true }),
      }));
      return read?.everyone ? { ...whole, hosts, operator: OWNER } : { ...whole, hosts, inputs: inputs.filter((entry) => entry.author === read?.memberId) };
    },
  };
}
const OWNER_VIEWER: ActivityRequestViewer = { mode: "team", memberId: OWNER, canChoose: true };

describe("the owner's member filter", () => {
  test("a member who is not the owner sees no filter and no breakdown", async () => {
    current = teamDeps();
    viewer = { mode: "team", memberId: BO, canChoose: false };
    await open("/activity?range=7d");
    expect($("[data-activity-hero]")).not.toBeNull();
    expect($("[data-activity-members-trigger]")).toBeNull();
    expect($("[data-activity-member-breakdown]")).toBeNull();
    expect($('[data-activity-figure="you"]')!.textContent).toContain("You");
  });

  test("the owner opens on their own figures, chooses All, reads each member's hours and projects, and opens one member", async () => {
    current = teamDeps();
    viewer = OWNER_VIEWER;
    await open("/activity?range=7d");
    expect(lastRequest().has("member")).toBe(false);
    expect($("[data-activity-members-trigger]")!.textContent).toContain("Ada Quill");
    expect($('[data-activity-figure="you"]')!.textContent).toContain("You");
    expect($("[data-activity-member-breakdown]")).toBeNull();

    await click($("[data-activity-members-trigger]"));
    const options = [...dom.document.querySelectorAll("[data-activity-member-option]")].map((option) => option.getAttribute("data-activity-member-option"));
    expect(options).toEqual(["all", BO, OWNER, CY]);
    expect($(`[data-activity-member-option="${OWNER}"]`)!.getAttribute("aria-selected")).toBe("true");
    expect($(`[data-activity-member-option="${OWNER}"]`)!.textContent).toContain("Ada Quill (you)");
    expect($(`[data-activity-member-option="${CY}"]`)!.textContent).toContain("Not covered");

    const before = dom.history.length;
    await click($('[data-activity-member-option="all"]'));
    expect(address().get("member")).toBe("all");
    expect(dom.history.length).toBe(before + 1);
    expect(lastRequest().get("member")).toBe("all");
    expect($('[data-activity-figure="you"]')!.textContent).toContain("All members");
    const all = await activityResponse(new URLSearchParams("range=7d&member=all"), current, viewer);
    expect($("[data-activity-hero]")!.textContent).toContain(hoursText(all.totals.humanHours, "en", t));
    const cards = [...dom.document.querySelectorAll("[data-activity-member-row]")].map((card) => card.getAttribute("data-activity-member-row"));
    expect(cards).toEqual([BO, OWNER, CY]);
    const bo = all.member.members.find((row) => row.id === BO)!;
    expect($(`[data-activity-member-row="${BO}"] [data-activity-member-hours]`)!.textContent).toBe(`≥ ${hoursText(bo.humanHours, "en", t)}`);
    expect($(`[data-activity-member-row="${BO}"]`)!.textContent).toContain("harbor");
    expect($(`[data-activity-member-row="${OWNER}"]`)!.textContent).toContain("client-portal");
    expect($(`[data-activity-member-row="${CY}"] [data-activity-member-hours]`)!.textContent).toBe("Not covered");
    expect($(`[data-activity-member-row="${CY}"] [data-activity-member-gap]`)!.textContent).toContain("Stage host");
    expect($("[data-activity-member-not-split]")!.textContent).toContain("not split per member");

    await click($(`[data-activity-member-row="${BO}"] button`));
    expect(address().get("member")).toBe(BO);
    expect(lastRequest().get("member")).toBe(BO);
    expect($('[data-activity-figure="you"]')!.textContent).toContain("Bo Tern");
    expect($("[data-activity-member-breakdown]")).toBeNull();

    await act(async () => dom.history.back());
    await settle();
    expect(address().get("member")).toBe("all");
    expect($("[data-activity-member-breakdown]")).not.toBeNull();
  });

  test("the narrow page carries the same filter and breakdown, in Ukrainian too", async () => {
    current = teamDeps();
    viewer = OWNER_VIEWER;
    wide = false;
    setLocale("uk");
    await open("/activity?range=7d&member=all");
    expect(lastRequest().get("member")).toBe("all");
    expect($("[data-activity-members-trigger]")!.textContent).toContain("Усі учасники");
    expect($('[data-activity-tile="human"]')!.textContent).toContain("Усі учасники");
    expect($("[data-activity-member-breakdown]")!.textContent).toContain("За учасниками");
    expect($(`[data-activity-member-row="${CY}"] [data-activity-member-hours]`)!.textContent).toBe("Не охоплено");
    await click($(`[data-activity-member-row="${OWNER}"] button`));
    /* The owner's own card returns to the default view. */
    expect(address().has("member")).toBe(false);
    expect(lastRequest().has("member")).toBe(false);
  });

  /* Everything the page says about the human axis: its text, and the labels
     a screen reader or a hover reads. The filter and the cards name the
     owner's own entry "(you)" on purpose, and the surface table describes
     each surface in general, so they are left out. */
  const humanAxisText = () => {
    const skipped = "[data-activity-members], [data-activity-member-breakdown], [data-activity-coverage]";
    const parts: string[] = [];
    for (const element of dom.document.querySelectorAll("body *")) {
      if (element.closest(skipped)) continue;
      for (const attribute of ["aria-label", "title"]) {
        const value = element.getAttribute(attribute);
        if (value) parts.push(value);
      }
      for (const node of element.childNodes) if (node.nodeType === 3) parts.push(node.textContent ?? "");
    }
    return parts.join("\n");
  };
  const VIEWER = { en: /\b(you|your|yours)\b/i, uk: /(?<!\p{L})(ви|вас|вам|вами|ваш\p{L}*)(?!\p{L})/iu };

  for (const locale of ["en", "uk"] as const) {
    for (const choice of ["member", "all"] as const) {
      test(`another member's and every member's figures never read as the viewer's own: desktop, ${choice}, ${locale}`, async () => {
        current = teamDeps();
        viewer = OWNER_VIEWER;
        setLocale(locale);
        await open(`/activity?range=7d&member=${choice === "all" ? "all" : BO}`);
        expect($("[data-activity-hero]")).not.toBeNull();
        expect($('[data-activity-figure="you"]')!.textContent).toContain(choice === "all" ? translate(locale, "activity.member.everyone") : "Bo Tern");
        /* The drawer's method and host notes too. */
        await click($("[data-activity-how]"));
        const text = humanAxisText();
        expect(text).toContain(translate(locale, "activity.others.col.you"));
        expect(text).toContain(translate(locale, "activity.others.rhythm.you", { person: choice === "all" ? translate(locale, "activity.member.everyone") : "Bo Tern" }));
        expect(text.match(VIEWER[locale])).toBeNull();
      });

      test(`another member's and every member's figures never read as the viewer's own: narrow, ${choice}, ${locale}`, async () => {
        current = teamDeps();
        viewer = OWNER_VIEWER;
        wide = false;
        setLocale(locale);
        await open(`/activity?range=7d&member=${choice === "all" ? "all" : BO}`);
        expect($('[data-activity-tile="human"]')).not.toBeNull();
        const days = humanAxisText();
        expect(days).toContain(translate(locale, "activity.others.legend.human"));
        expect(days).toContain(translate(locale, "activity.others.gap.incompleteTitle"));
        expect(days.match(VIEWER[locale])).toBeNull();
        await click($(`[data-activity-option="projects"]`));
        const projects = humanAxisText();
        expect(projects).toContain(translate(locale, "activity.others.sort.human"));
        expect(projects.match(VIEWER[locale])).toBeNull();
      });
    }
  }

  test("the owner's own figures still read as theirs", async () => {
    current = teamDeps();
    viewer = OWNER_VIEWER;
    wide = false;
    await open("/activity?range=7d");
    expect(humanAxisText()).toContain(t("activity.legend.human"));
    expect(humanAxisText()).toContain(t("activity.tile.splitSub", { unattended: "≈ 2 h 30 m" }));
  });

  for (const asked of ["all", OWNER]) {
    test(`a member opening the owner's link (member=${asked === "all" ? "all" : "the owner"}) lands on their own figures`, async () => {
      current = teamDeps();
      viewer = { mode: "team", memberId: BO, canChoose: false };
      await open(`/activity?range=7d&member=${asked}`);
      expect(requests.some((request) => request.get("member") === asked)).toBe(true);
      expect(lastRequest().has("member")).toBe(false);
      expect(address().has("member")).toBe(false);
      expect(dom.document.body.textContent).not.toContain(t("activity.failed"));
      const own = await activityResponse(new URLSearchParams("range=7d"), current, viewer);
      expect(own.totals.humanHours).toBeGreaterThan(0);
      expect($("[data-activity-hero]")!.textContent).toContain(hoursText(own.totals.humanHours, "en", t));
      expect($('[data-activity-figure="you"]')!.textContent).toContain("You");
      expect($("[data-activity-members-trigger]")).toBeNull();
    });
  }
});

/* happy-dom does not feed React's value tracker, so a date field is typed
   through its own change handler, as the project's other dialogs are. */
async function typeDate(side: "from" | "to", value: string) {
  const input = $(`[data-activity-range-input="${side}"]`) as unknown as HTMLInputElement;
  expect(input).not.toBeNull();
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
  const props = (input as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
  await act(async () => props.onChange({ target: { value } }));
  await settle();
}

describe("the Tokens tab", () => {
  test("reads tokens alone and prints the figure, the kinds and the three optional extras", async () => {
    await open("/activity?view=tokens&range=7d");
    expect(requests).toHaveLength(0);
    expect(lastTokens().get("range")).toBe("7d");
    expect(lastTokens().get("stack")).toBe("model");
    expect(lastTokens().get("list")).toBe("model");
    expect(lastTokens().has("member")).toBe(false);
    expect($("[data-activity-tab]")!.getAttribute("data-activity-tab")).toBe("tokens");
    expect($("[data-token-hero]")!.textContent).toBe(compact(TOKEN_TOTAL, "en"));
    for (const kind of ["cacheRead", "input", "cacheWrite", "output"]) expect($(`[data-token-meter] [data-token-kind="${kind}"]`)!.textContent).toMatch(/\d/);
    const optional = t("activity.tokens.optional");
    const input = 3.1e6 + 60e6 + 2e6;
    expect($('[data-token-extra="cache"]')!.textContent).toBe(`${optional}${t("activity.tokens.extra.cache", { share: percent(60e6 / input, "en") })}`);
    expect($('[data-token-extra="reasoning"]')!.textContent).toBe(`${optional}${t("activity.tokens.extra.reasoning", { share: percent(0.7e6 / 1.5e6, "en") })}`);
    /* Opus 5.5: 4 + 8 + 5 + 8 + 10; GPT-6.1 Sol at its default tier: 4 + 2 + 10. The fixture model has no price. */
    expect($('[data-token-extra="cost"]')!.textContent).toBe(`${optional}${t("activity.tokens.extra.cost", { value: "≈ $51" })}`);
    expect($('[data-token-extra="cost"]')!.getAttribute("title")).toContain("fixture-model");
    expect($('[data-token-row="claude-opus-5-5"] [data-token-row-cost]')!.textContent).toBe("≈ $35");
    expect($('[data-token-row="gpt-6.1-sol"] [data-token-row-cost]')!.textContent).toBe("≈ $16");
    expect($('[data-token-row="fixture-model"] [data-token-row-cost]')!.textContent).toBe("—");
    expect($('[data-token-row="gpt-6.1-sol"]')!.textContent).toContain("GPT-6.1 Sol");
    expect(address().get("view")).toBe("tokens");
    expect(address().get("stack")).toBe("model");
  });

  test("«Break down by» stacks and lists the choice; a row filters the page and its chip clears it", async () => {
    await open("/activity?view=tokens&range=7d");
    await click($('[data-token-by] [data-activity-option="role"]'));
    expect(lastTokens().get("stack")).toBe("role");
    expect(lastTokens().get("list")).toBe("role");
    expect(address().get("stack")).toBe("role");
    await click($('[data-token-row="reviewer"] button'));
    expect(lastTokens().get("role")).toBe("reviewer");
    expect($("[data-activity-scope-chip]")!.textContent).toBe(`${t("activity.tokens.by.role")}: reviewer`);
    expect($("[data-token-hero]")!.textContent).toBe(compact(23e6, "en"));
    await click($("[data-activity-scope-clear]"));
    expect(lastTokens().has("role")).toBe(false);
    expect($("[data-activity-scope-chip]")).toBeNull();
    /* A project row scopes the whole page, the Time tab included. */
    await click($('[data-token-by] [data-activity-option="project"]'));
    await click($(`[data-token-row="${HARBOR}"] button`));
    expect(lastTokens().get("project")).toBe(HARBOR);
    expect(address().get("project")).toBe(HARBOR);
    expect($("[data-activity-scope-chip]")!.textContent).toBe("harbor");
    await click($('[data-activity-tabs] [data-activity-option="time"]'));
    expect(lastRequest().get("project")).toBe(HARBOR);
    expect(address().get("view")).toBe("days");
    expect(address().has("stack")).toBe(false);
  });

  test("one free range serves both tabs, applies once both dates are valid and keeps at most a year", async () => {
    await open("/activity?view=tokens&range=7d");
    await click($('[data-activity-option="custom"]'));
    expect($("[data-activity-range-popover]")).not.toBeNull();
    const before = tokenRequests.length;
    await typeDate("from", "");
    await typeDate("from", "2026-09-10");
    expect((($('[data-activity-range-input="to"]') as unknown) as HTMLInputElement).value).toBe("2026-09-24");
    expect(tokenRequests.length).toBeGreaterThan(before);
    await typeDate("to", "2026-09-20");
    expect(lastTokens().get("from")).toBe("2026-09-10");
    expect(lastTokens().get("to")).toBe("2026-09-20");
    expect(lastTokens().has("range")).toBe(false);
    expect(address().get("from")).toBe("2026-09-10");
    expect(address().has("range")).toBe(false);
    expect($('[data-activity-option="custom"]')!.getAttribute("aria-pressed")).toBe("true");
    expect($('[data-activity-option="custom"]')!.textContent).toBe(datesLabel("2026-09-10", "2026-09-20", "en"));
    /* The fields close with Escape and hand focus back to their segment. */
    await act(async () => { $("[data-activity-range-popover]")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event); });
    expect($("[data-activity-range-popover]")).toBeNull();
    expect(dom.document.activeElement?.getAttribute("data-activity-option")).toBe("custom");
    await click($('[data-activity-tabs] [data-activity-option="time"]'));
    expect(lastRequest().get("from")).toBe("2026-09-10");
    expect(lastRequest().get("to")).toBe("2026-09-20");
    expect($("[data-activity-range-label]")!.textContent).toBe(datesLabel("2026-09-10", "2026-09-20", "en"));
    await click($('[data-activity-option="custom"]'));
    expect((($('[data-activity-range-input="to"]') as unknown) as HTMLInputElement).value).toBe("2026-09-20");
    await typeDate("from", "2024-01-01");
    expect(lastRequest().get("from")).toBe("2025-09-20");
    expect((($('[data-activity-range-input="from"]') as unknown) as HTMLInputElement).value).toBe("2025-09-20");
    await click($('[data-activity-option="90d"]'));
    expect(lastRequest().get("range")).toBe("90d");
    expect(lastRequest().has("from")).toBe(false);
    expect($("[data-activity-range-popover]")).toBeNull();
  });

  test("a member who is not the owner gets no member or account breakdown, and a shared owner link drops to models", async () => {
    viewer = { mode: "team", memberId: "m_bo000000000000000000000000000000", canChoose: false };
    await open("/activity?view=tokens&range=7d&member=all&stack=member&list=member");
    expect(tokenRequests[0]!.get("member")).toBe("all");
    expect(lastTokens().has("member")).toBe(false);
    expect(lastTokens().get("stack")).toBe("model");
    expect(address().has("member")).toBe(false);
    expect($('[data-token-by] [data-activity-option="member"]')).toBeNull();
    expect($('[data-token-by] [data-activity-option="account"]')).toBeNull();
    expect($("[data-token-members]")).toBeNull();
    expect($("[data-token-hero]")!.textContent).toBe(compact(TOKEN_TOTAL, "en"));
  });

  test("the owner chooses members and accounts as separate breakdowns", async () => {
    await open("/activity?view=tokens&range=7d&stack=member&list=member");
    expect($('[data-token-row="m_owner0000000000000000000000000"]')!.textContent).toContain("Ada Quill");
    await click($('[data-token-by] [data-activity-option="account"]'));
    expect(lastTokens().get("list")).toBe("account");
    expect($('[data-token-row="account-a"]')!.textContent).toContain("Claude · A");
    await click($("[data-token-members]"));
    await click($('[data-token-member-menu] button:last-child'));
    expect(lastTokens().get("member")).toBe("m_owner0000000000000000000000000");
    expect($("[data-token-members]")!.textContent).toContain("Ada Quill");
  });

  test("the drawer explains the count and the dated price table", async () => {
    await open("/activity?view=tokens&range=7d");
    await click($("[data-activity-how]"));
    expect($("[data-token-drawer-trust]")).not.toBeNull();
    expect($("[data-token-drawer-lines]")!.textContent).toContain(t("activity.tokens.coverage.members"));
    expect($("[data-token-drawer-cost]")!.textContent).toContain(t("activity.tokens.drawer.cost", { date: "2026-10-18" }));
  });

  test("the phone adds «Tokens» to its view switch and draws the tab full width", async () => {
    wide = false;
    await open("/activity?view=tokens&range=7d");
    const views = [...dom.document.querySelectorAll('[aria-label="View"] [data-activity-option]')].map((button) => button.getAttribute("data-activity-option"));
    expect(views).toEqual(["days", "projects", "tokens"]);
    expect($('[aria-label="View"] [data-activity-option="tokens"]')!.getAttribute("aria-selected")).toBe("true");
    expect($('[data-token-tab="phone"]')).not.toBeNull();
    expect(address().get("view")).toBe("tokens");
    expect($("[data-token-hero]")!.textContent).toBe(compact(TOKEN_TOTAL, "en"));
  });
});
