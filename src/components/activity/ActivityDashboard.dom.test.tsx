import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { AgentSourceRead } from "@/lib/activity/agentSource";
import type { HostReport, HostSourceRead, HumanInputRead } from "@/lib/activity/hostSources";
import type { HumanInput } from "@/lib/activity/humanInput";
import type { AgentConversation, HostCoverage, Interval } from "@/lib/activity/method";
import { activityResponse, type ActivityResponseDependencies } from "@/lib/activity/report";
import { setLocale, translate } from "@/lib/i18n";
import { installActEnv } from "@/test-helpers/actEnv";

import { ActivityDashboard } from "./ActivityDashboard";
import { hoursText, projectFromSearch } from "./format";

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
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: query === "(min-width: 1024px)",
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
function deps(stagePull: HostReport["sources"][number], inputs: HumanInput[], agents: AgentConversation[]): Partial<ActivityResponseDependencies> {
  const local = [source("ingest", "read", [ALWAYS])];
  const coverage: HostCoverage[] = [
    { host: "workstation", projects: "all", since: null, covered: [ALWAYS] },
    { host: "stage", projects: [CLIENT], since: null, covered: stagePull.covered },
  ];
  const human: HumanInputRead = {
    inputs,
    coverage,
    hosts: [
      { host: "workstation", label: "Workstation", local: true, configured: true, projects: "all", since: null, sources: local },
      { host: "stage", label: "Stage host", local: false, configured: true, projects: [CLIENT], since: null, sources: [stagePull] },
    ],
    config: "ok",
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
const requests: URLSearchParams[] = [];
globalThis.fetch = (async (resource: string | URL | Request) => {
  const url = new URL(String(resource), "http://localhost");
  if (url.pathname !== "/api/activity") throw new Error(`unexpected request ${url.pathname}`);
  requests.push(url.searchParams);
  return new Response(JSON.stringify(await activityResponse(url.searchParams, current)), { status: 200 });
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
  await act(async () => root!.render(<ActivityDashboard initialRange="7d" initialView="days" initialProject={projectFromSearch(dom.location.search)} />));
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
  requests.length = 0;
});
afterEach(unmount);

describe("the page filtered to one project", () => {
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

  test("a project with only agent time whose host was not read: You reads Unknown, never 0; its agent time is a lower bound", async () => {
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
