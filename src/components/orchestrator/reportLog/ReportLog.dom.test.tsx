import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { ReportLogEntry, ReportLogPage } from "@/lib/bridge/reportLog";

/* The orchestrator's report log (#2146) as the operator sees it: each entry is
   a local time, a class word and the body as written with its references
   linked; an empty log says so in one line; a new report appears on the
   board's live transport without a reload; what arrived since the last look
   is marked «new»; and a project whose bridge reports are off shows one line
   with the switch that turns them back on. */

const dom = new HappyWindow({ url: "http://127.0.0.1:8899/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
});

const { setRuntimeBusForTests } = await import("@/hooks/runtimeBus");
const { ReportLog } = await import("./ReportLog");
const { resetBridgeReportsSettingForTests } = await import("./bridgeReportsSetting");

const PROJECT = "repo-widgets";
const realFetch = globalThis.fetch;
let root: Root | null = null;
let filesListener: ((revision: number) => void) | null = null;
let pages: ReportLogPage[] = [];
let requests: string[] = [];
let settingWrites: unknown[] = [];

function entry(seq: number, overrides: Partial<ReportLogEntry> = {}): ReportLogEntry {
  return { seq, at: new Date(Date.UTC(2026, 8, 24, 9, seq)).toISOString(), class: "completed", body: `report ${seq}`, cards: [], ...overrides };
}

function page(entries: ReportLogEntry[], overrides: Partial<ReportLogPage> = {}): ReportLogPage {
  return { ok: true, project: PROJECT, bridgeReports: true, github: "acme/widgets", revision: `r${entries[0]?.seq ?? 0}`, entries, nextBefore: null, ...overrides };
}

beforeEach(() => {
  requests = [];
  settingWrites = [];
  pages = [];
  dom.localStorage.clear();
  /* A live runtime bus whose `files.revision` the test fires by hand. */
  setRuntimeBusForTests({
    getState: () => ({ connection: "live", enabled: true, structuredHostsEnabled: false, resyncedAt: null, lastEventAt: null, store: {} as never }),
    subscribe: () => () => {},
    subscribeFilesRevision: (listener) => {
      filesListener = listener;
      return () => { filesListener = null; };
    },
    start: () => {},
    stop: () => {},
    refresh: async () => true,
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/orchestrator/reports")) {
      requests.push(url);
      const next = pages.length > 1 ? pages.shift()! : pages[0]!;
      return new Response(JSON.stringify(next));
    }
    if (url.startsWith("/api/projects/settings")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { bridgeReports: boolean };
        settingWrites.push(body);
        return new Response(JSON.stringify({ ok: true, project: PROJECT, bridgeReports: { enabled: body.bridgeReports } }));
      }
      return new Response(JSON.stringify({ ok: true, project: PROJECT, bridgeReports: { enabled: pages[0]?.bridgeReports !== false } }));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  setRuntimeBusForTests(null);
  resetBridgeReportsSettingForTests();
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
});

function mount(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<ReportLog project={PROJECT} variant="column" now={new Date(Date.UTC(2026, 8, 24, 12))} />));
  return host;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Bun.sleep(5);
}

test("each entry is its time, its class word and its body as written, newest first, with #refs and card ids linked", async () => {
  pages = [page([
    entry(3, { class: "review_verdict", body: "Lane 9612c532 review: APPROVE on #2146, see acme/tools#7.\nSecond line kept." , cards: [{ id: "9612c532", kind: "pipeline" }] }),
    entry(2, { class: "blocked", body: "Waiting on task fix-login-banner." , cards: [{ id: "fix-login-banner", kind: "task" }] }),
    entry(1, { class: "failed", body: "Deploy failed" }),
  ])];
  const host = mount();
  await settle();

  const rows = [...host.querySelectorAll("[data-report-entry]")];
  expect(rows.map((row) => row.getAttribute("data-report-entry"))).toEqual(["3", "2", "1"]);
  expect(rows.map((row) => row.querySelector("[data-report-class-label]")!.textContent)).toEqual(["review verdict", "blocked", "failed"]);
  expect(rows[0]!.querySelector("time")!.getAttribute("datetime")).toBe(entry(3).at);
  expect(rows[0]!.querySelector("time")!.textContent).toMatch(/^\d{2}:\d{2}$/);
  expect(rows[0]!.querySelector("p")!.textContent).toBe("Lane 9612c532 review: APPROVE on #2146, see acme/tools#7.\nSecond line kept.");

  const github = [...rows[0]!.querySelectorAll("a[data-report-link=github]")].map((link) => [link.textContent, link.getAttribute("href")]);
  expect(github).toEqual([
    ["#2146", "https://github.com/acme/widgets/issues/2146"],
    ["acme/tools#7", "https://github.com/acme/tools/issues/7"],
  ]);

  const navigations: unknown[] = [];
  const listen = (event: Event) => navigations.push((event as CustomEvent).detail);
  window.addEventListener("llv:mcp-navigate", listen);
  (rows[0]!.querySelector("[data-report-card='9612c532']") as HTMLElement).click();
  (rows[1]!.querySelector("[data-report-card='fix-login-banner']") as HTMLElement).click();
  window.removeEventListener("llv:mcp-navigate", listen);
  expect(navigations).toEqual([{ kind: "pipeline", id: "9612c532" }, { kind: "task", id: "fix-login-banner" }]);

  /* Nothing else in the panel: no lanes, no deploys, no counts, no groups. */
  expect(host.querySelectorAll("section h2")).toHaveLength(1);
  expect(host.querySelectorAll("ol")).toHaveLength(1);
});

test("an empty log says in one line that the orchestrator has not reported anything yet", async () => {
  pages = [page([])];
  const host = mount();
  await settle();
  expect(host.querySelector("[data-report-log-empty]")!.textContent).toBe("The orchestrator has not reported anything yet.");
  expect(host.querySelectorAll("[data-report-entry]")).toHaveLength(0);
});

test("a new report appears on a files revision without a reload, and older ones load on request", async () => {
  pages = [page([entry(40), entry(39)], { nextBefore: 39 }), page([entry(41, { class: "question", body: "Merge #12 now?" }), entry(40), entry(39)], { nextBefore: 39 })];
  const host = mount();
  await settle();
  expect([...host.querySelectorAll("[data-report-entry]")].map((row) => row.getAttribute("data-report-entry"))).toEqual(["40", "39"]);

  filesListener!(7);
  await Bun.sleep(450);
  await settle();
  expect([...host.querySelectorAll("[data-report-entry]")].map((row) => row.getAttribute("data-report-entry"))).toEqual(["41", "40", "39"]);
  expect(requests[1]).toContain("since=r40");

  pages = [page([entry(38), entry(37)], { nextBefore: null })];
  (host.querySelector("[data-report-log-older]") as HTMLElement).click();
  await settle();
  expect([...host.querySelectorAll("[data-report-entry]")].map((row) => row.getAttribute("data-report-entry"))).toEqual(["41", "40", "39", "38", "37"]);
  expect(requests.at(-1)).toContain("before=39");
  expect(host.querySelector("[data-report-log-older]")).toBeNull();
});

test("entries that arrived since the last look carry a quiet new mark, and looking moves the mark", async () => {
  dom.localStorage.setItem(`llvReportLogSeen:${PROJECT}`, "5");
  pages = [page([entry(7), entry(6), entry(5), entry(4)])];
  const host = mount();
  await settle();
  const marked = [...host.querySelectorAll("[data-report-new]")].map((row) => row.getAttribute("data-report-entry"));
  expect(marked).toEqual(["7", "6"]);
  expect(host.querySelector("[data-report-entry='7'] [data-report-new-mark]")!.textContent).toBe("new");
  expect(dom.localStorage.getItem(`llvReportLogSeen:${PROJECT}`)).toBe("7");

  flushSync(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  const again = mount();
  await settle();
  expect(again.querySelectorAll("[data-report-new]")).toHaveLength(0);
});

test("with bridge reports off the panel is one line and the switch, which turns them back on", async () => {
  pages = [page([entry(2), entry(1)], { bridgeReports: false })];
  const host = mount();
  await settle();
  const off = host.querySelector("[data-report-log-off]")!;
  expect(off.querySelector("p")!.textContent).toBe("Bridge reports are off");
  expect(host.querySelectorAll("[data-report-entry]")).toHaveLength(0);
  const toggle = off.querySelector("[data-bridge-reports-switch]") as HTMLButtonElement;
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  toggle.click();
  await settle();
  expect(settingWrites).toEqual([{ project: PROJECT, bridgeReports: true }]);
  expect(host.querySelector("[data-report-log-off]")).toBeNull();
  expect([...host.querySelectorAll("[data-report-entry]")].map((row) => row.getAttribute("data-report-entry"))).toEqual(["2", "1"]);
});

test("an agent that asked the operator is one line by time among the reports, and its name opens that conversation", async () => {
  const ask = {
    id: "ask:conv-builder-1:claude:msg-1",
    at: new Date(Date.UTC(2026, 8, 24, 9, 2, 30)).toISOString(),
    conversationId: "conv-builder-1",
    path: "/transcripts/builder.jsonl",
    role: "builder",
    title: "Migrate the ledger",
    gist: "Should I merge it now, or wait for the review round?",
  };
  pages = [page([entry(3), entry(2), entry(1)], { asks: [ask] })];
  const host = mount();
  await settle();

  const rows = [...host.querySelectorAll("[data-report-log-entries] > li")];
  expect(rows.map((row) => row.getAttribute("data-report-entry") ?? `ask:${row.getAttribute("data-report-ask")}`)).toEqual(["3", `ask:${ask.id}`, "2", "1"]);
  const line = host.querySelector(`[data-report-ask='${ask.id}']`)!;
  expect(line.querySelector("[data-report-class-label]")!.textContent).toBe("needs you");
  expect(line.querySelector("p")!.textContent).toBe("Builder asks you: Should I merge it now, or wait for the review round?");
  const link = line.querySelector("a[data-report-link=conversation]")!;
  expect(link.textContent).toBe("Builder");
  expect(link.getAttribute("href")).toBe("#c=conv-builder-1");

  /* The link is the Viewer's own deep link: following it opens the conversation. */
  (link as HTMLAnchorElement).click();
  expect(window.location.hash).toBe("#c=conv-builder-1");
});

test("ask lines stay when the orchestrator's bridge reports are off: they are the Viewer's, not its", async () => {
  const ask = { id: "ask:conv-2:claude:m", at: entry(2).at, conversationId: null, path: "/transcripts/two.jsonl", role: null, title: "Logo variants", gist: "" };
  pages = [page([entry(2)], { bridgeReports: false, asks: [ask] })];
  const host = mount();
  await settle();
  expect(host.querySelector("[data-report-log-off]")).not.toBeNull();
  const line = host.querySelector(`[data-report-ask='${ask.id}']`)!;
  expect(line.querySelector("p")!.textContent).toBe("Logo variants asks you");
  expect(line.querySelector("a")!.getAttribute("href")).toBe("#f=%2Ftranscripts%2Ftwo.jsonl");
});
