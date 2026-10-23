import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Window as HappyWindow } from "happy-dom";
import { NextRequest } from "next/server";
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
const { setLocale } = await import("@/lib/i18n");
const { resetBridgeReportsSettingForTests } = await import("./bridgeReportsSetting");
const { GET } = await import("@/app/api/orchestrator/reports/route");
const { mutateOperatorAsks } = await import("@/lib/asks/store");
const { appendBridgeReports, readBridgeReportLog, readBridgeChannel } = await import("@/lib/bridge/store");
const { setBridgeReports } = await import("@/lib/projects/settings");
const { resetDismissalOverlayForTests, useDismissalOverlay } = await import("@/components/attention/dismissalOverlay");
const { buildNeedsYouQueue } = await import("@/components/attention/attentionQueue");
const { resetDoneItemsForTests } = await import("@/components/attention/doneItems");

const PROJECT = "repo-widgets";
const realFetch = globalThis.fetch;
let root: Root | null = null;
let filesListener: ((revision: number) => void) | null = null;
let pages: ReportLogPage[] = [];
let reportsResponse: Promise<void> | null = null;
let requests: string[] = [];
let settingWrites: unknown[] = [];
let dismissals: Array<{ target: unknown; undo: boolean; surface: string }> = [];
/* When set, the dismissal route refuses with this error, as a held 400 would. */
let dismissalRefusal: string | null = null;
type DoneItemV1 = import("@/lib/done/types").DoneItemV1;
let doneServer: DoneItemV1[] = [];
let doneWrites: Array<{ keys: string[]; undo: boolean; surface: string }> = [];

function entry(seq: number, overrides: Partial<ReportLogEntry> = {}): ReportLogEntry {
  return { seq, at: new Date(Date.UTC(2026, 8, 24, 9, seq)).toISOString(), class: "completed", body: `report ${seq}`, cards: [], ...overrides };
}

function page(entries: ReportLogEntry[], overrides: Partial<ReportLogPage> = {}): ReportLogPage {
  return { ok: true, project: PROJECT, bridgeReports: true, github: "acme/widgets", revision: `r${entries[0]?.seq ?? 0}`, entries, nextBefore: null, questions: { open: [], resolved: [] }, ...overrides };
}

beforeEach(() => {
  setLocale("en");
  doneServer = [];
  doneWrites = [];
  resetDoneItemsForTests();
  requests = [];
  settingWrites = [];
  dismissals = [];
  dismissalRefusal = null;
  resetDismissalOverlayForTests();
  pages = [];
  reportsResponse = null;
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
      if (reportsResponse) await reportsResponse;
      const next = pages.length > 1 ? pages.shift()! : pages[0]!;
      return new Response(JSON.stringify(next));
    }
    if (url.startsWith("/api/attention/dismissals")) {
      const body = JSON.parse(String(init!.body)) as { target: { subjects: Array<{ kind: "report"; seq: number }> }; undo: boolean; surface: string };
      dismissals.push(body);
      if (dismissalRefusal) return new Response(JSON.stringify({ error: dismissalRefusal }), { status: 400 });
      return new Response(JSON.stringify({ ok: true, dismissed: body.target.subjects, alreadyClear: [], changed: [], at: "2026-09-24T12:00:00.000Z", by: { kind: "operator", surface: body.surface }, undo: body.undo }));
    }
    if (url.startsWith("/api/attention/done")) {
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ ok: true, items: doneServer.filter((item) => !item.acknowledgedAt), revision: 1 }));
      const body = JSON.parse(String(init!.body)) as { keys: string[]; undo: boolean; surface: string };
      doneWrites.push(body);
      const changed = doneServer.filter((item) => body.keys.includes(item.key));
      for (const item of changed) item.acknowledgedAt = body.undo ? null : "2026-09-24T12:00:00.000Z";
      return new Response(JSON.stringify({ ok: true, changed }));
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

async function mountWithDeferredReports(): Promise<HTMLElement> {
  const response = Promise.withResolvers<void>();
  reportsResponse = response.promise;
  const expectedRows = pages[0]!.entries.length;
  const host = mount();
  expect(requests).toHaveLength(1);
  expect(host.querySelectorAll("[data-report-entry]")).toHaveLength(0);
  const committed = new Promise<void>((resolve, reject) => {
    const observer = new dom.MutationObserver(() => {
      if (host.querySelectorAll("[data-report-entry]").length !== expectedRows) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve();
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error("Report rows did not render after releasing the response"));
    }, 5_000);
    observer.observe(host, { childList: true, subtree: true });
  });
  response.resolve();
  await committed;
  return host;
}

for (const locale of ["en", "uk"] as const) {
  test(`recorded authors and conversation links in ${locale}, with no invented legacy or unidentified link`, async () => {
    setLocale(locale);
    pages = [page([
      entry(6, { author: { kind: "manager", conversationId: "conversation_old_seat", role: "orchestrator" } }),
      entry(5, { author: { kind: "agent", conversationId: "conversation_builder", role: "builder" } }),
      entry(4, { author: { kind: "gateway", conversationId: "conversation_voice", role: null } }),
      entry(3, { author: { kind: "unidentified", conversationId: "javascript:alert(1)", role: null } }),
      entry(2, { author: { kind: "agent", conversationId: null, role: null } }),
      entry(1),
    ])];
    const host = await mountWithDeferredReports();
    expect([...host.querySelectorAll("[data-report-author]")].map(node => node.textContent)).toEqual(locale === "en"
      ? ["Orchestrator", "Builder", "Gateway", "an unidentified caller", "Agent"]
      : ["Оркестратор", "Білдер", "Шлюз", "невідомий виклик", "Агент"]);
    expect([...host.querySelectorAll('[data-report-link="author"]')].map(node => node.getAttribute("href"))).toEqual([
      "#c=conversation_old_seat", "#c=conversation_builder", "#c=conversation_voice",
    ]);
    expect(host.querySelector('[data-report-entry="1"] [data-report-author]')).toBeNull();
    expect(host.textContent).not.toContain("javascript:");
    expect(settingWrites).toEqual([]);
    expect(dismissals).toEqual([]);
  });
}

test("an author id stays an encoded conversation hash and a custom role renders as text", async () => {
  const id = "conversation_odd&x=<script>";
  pages = [page([entry(1, { author: { kind: "agent", conversationId: id, role: "<img src=x onerror=alert(1)>" } })])];
  const host = await mountWithDeferredReports();
  expect(host.querySelector('[data-report-link="author"]')?.getAttribute("href")).toBe(`#c=${encodeURIComponent(id)}`);
  expect(host.querySelector("img, script")).toBeNull();
  expect(host.querySelector("[data-report-author]")?.textContent).toBe("<img src=x onerror=alert(1)>");
});

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

/* Paging through the real route: the ask lines page on their own cursor, so a
   reader who keeps asking for older lines sees every ask and every report
   once, newest first, and never a line out of its place on the way. */
describe("paging back through the real route", () => {
  const FROM = Date.UTC(2026, 8, 24, 6, 0);
  const originalStateDir = process.env.LLV_STATE_DIR;
  let sandbox = "";

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-report-log-paging-"));
    process.env.LLV_STATE_DIR = path.join(sandbox, "state");
    const served = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("/api/orchestrator/reports")) return served(input, init);
      requests.push(url);
      return GET(new NextRequest(new URL(url, "http://127.0.0.1:8899")));
    }) as typeof fetch;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = originalStateDir;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /** `count` asks, two to each minute so the cursor has ties to break. */
  function seedAsks(count: number): { at: number; key: string }[] {
    const asks = Array.from({ length: count }, (_, index) => ({
      id: `ask:conv-${index}:claude:msg-${index}`,
      subject: `conv-${index}`,
      conversationId: `conv-${index}`,
      path: `/transcripts/${index}.jsonl`,
      project: PROJECT,
      role: "builder",
      title: null,
      messageId: `claude:msg-${index}`,
      messageAt: FROM + Math.floor(index / 2) * 60_000,
      gist: `question ${index}`,
      score: 0.9,
      recordedAt: new Date(FROM).toISOString(),
    }));
    mutateOperatorAsks((file) => { file.asks.push(...asks); }, new Date(FROM + 3_600_000));
    return asks
      .sort((left, right) => right.messageAt - left.messageAt || left.id.localeCompare(right.id))
      .map((ask) => ({ at: ask.messageAt, key: `ask:${ask.id}` }));
  }

  /** `count` reports, one each 50 s from 25 s past, never on an ask's minute. */
  function seedReports(count: number): { at: number; key: string }[] {
    // Complete first-boot imports before the fixture's write transaction.
    readBridgeReportLog();
    readBridgeChannel();
    const inputs = Array.from({ length: count }, (_, index) => ({
      key: `report-${index}`,
      class: "completed" as const,
      at: new Date(FROM + index * 50_000 + 25_000).toISOString(),
      body: `report ${index}`,
      project: PROJECT,
      targetSeatConversationId: "conversation_seat",
    }));
    const { appended } = appendBridgeReports(inputs);
    return appended.map((report) => ({ at: Date.parse(report.at), key: String(report.seq) }));
  }

  const shown = (host: HTMLElement, list = "[data-report-log-entries]") => [...host.querySelectorAll(`${list} > li`)]
    .map((row) => row.getAttribute("data-report-entry") ?? `ask:${row.getAttribute("data-report-ask")}`);

  /** Every view on the way back, until no older control is left. */
  async function pageBack(host: HTMLElement, list?: string): Promise<string[][]> {
    const views = [shown(host, list)];
    for (let round = 0; round < 20; round += 1) {
      const older = host.querySelector<HTMLButtonElement>("[data-report-log-older]");
      if (!older) return views;
      older.click();
      await settle();
      views.push(shown(host, list));
    }
    throw new Error("the older control never went away");
  }

  test("a project with no reports shows every one of its 60 asks, once each, newest first", async () => {
    const asks = seedAsks(60).map((ask) => ask.key);
    const host = mount();
    await settle();
    const views = await pageBack(host);
    expect(views.length).toBeGreaterThan(1);
    expect(views.at(-1)).toEqual(asks);
    for (const view of views) expect(view).toEqual(asks.slice(0, view.length));
    expect(requests.some((url) => new URL(url, "http://x").searchParams.has("asksBefore"))).toBe(true);
  });

  test("asks and reports interleaved by time page back together, every line once and in its place", async () => {
    const asks = seedAsks(130);
    const reports = seedReports(70);
    const expected = [
      ...reports.map((report) => ({ ...report, order: 0 })),
      ...asks.map((ask, order) => ({ ...ask, order })),
    ].sort((left, right) => right.at - left.at || left.order - right.order).map((row) => row.key);
    const host = mount();
    await settle();
    const views = await pageBack(host);
    expect(views.length).toBeGreaterThanOrEqual(3);
    expect(views.at(-1)).toEqual(expected);
    for (const view of views) expect(view).toEqual(expected.slice(0, view.length));
  });

  test("with bridge reports off, the ask lines still page back to the oldest", async () => {
    const asks = seedAsks(60).map((ask) => ask.key);
    seedReports(5);
    setBridgeReports(PROJECT, false, "operator");
    /* The settings read answers off as well. */
    pages = [page([], { bridgeReports: false })];
    const host = mount();
    await settle();
    expect(host.querySelector("[data-report-log-off]")).not.toBeNull();
    const views = await pageBack(host, "[data-report-log-asks]");
    expect(views.at(-1)).toEqual(asks);
  });
});

/* ── The orchestrator's questions: one record with the needs-you panel ── */

function questionPage(): ReportLogPage {
  return page([
    entry(6, { class: "question", body: "Raise the attachment limit to 100 MB or keep 25?" }),
    entry(5, { class: "status", body: "Two lanes running." }),
    entry(4, { class: "blocked", body: "Cannot merge #88 until the base is picked." }),
    entry(3, { class: "question", body: "Ship the digest on weekends too?" }),
    entry(2, { class: "question", body: "An older question the operator answered in chat." }),
  ], { questions: { open: [6, 4, 3], resolved: [{ seq: 1, at: "2026-09-24T09:30:00.000Z" }] } });
}

test("every open question carries an unticked box, a resolved one a ticked box, dimmed, with its check; other rows carry none", async () => {
  pages = [page([
    entry(3, { class: "question", body: "Open question" }),
    entry(2, { class: "status", body: "Status" }),
    entry(1, { class: "question", body: "Resolved question" }),
  ], { questions: { open: [3], resolved: [{ seq: 1, at: "2026-09-24T09:30:00.000Z" }] } })];
  const host = mount();
  await settle();
  const box = (seq: number) => host.querySelector<HTMLInputElement>(`[data-report-resolve="${seq}"]`);
  expect(box(3)!.checked).toBe(false);
  expect(box(2)).toBeNull();
  expect(box(1)!.checked).toBe(true);
  const resolved = host.querySelector('[data-report-entry="1"]')!;
  expect(resolved.getAttribute("data-report-question")).toBe("resolved");
  expect(resolved.querySelector("[data-report-resolved-mark]")).not.toBeNull();
  expect(resolved.querySelector("p")!.className).toContain("text-muted");
  expect(host.querySelector("[data-report-open-count]")!.getAttribute("data-report-open-count")).toBe("1");
});

test("ticking a question resolves it through the needs-you dismissal, and the needs-you queue loses the same question on the same click", async () => {
  pages = [questionPage()];
  const host = mount();
  await settle();
  /* The seat as the files poll carries it: three open questions. */
  const seat = {
    path: "/sessions/seat.jsonl", root: "claude-projects", name: "seat.jsonl", project: PROJECT, title: "Orchestrator", engine: "claude", kind: "session", fmt: "claude",
    parent: null, mtime: 0, size: 0, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null, conversationId: "conversation_seat",
    bridgeAsks: [3, 4, 6].map((seq) => ({ id: `ask-${seq}`, at: new Date().toISOString(), seq, body: `question ${seq}` })),
  } as const;
  let queueLength = -1;
  function Probe() {
    const { files, pipelines } = useDismissalOverlay([seat as never], []);
    queueLength = buildNeedsYouQueue(files, pipelines, Date.now() / 1000, []).length;
    return null;
  }
  const probeHost = document.createElement("div");
  document.body.append(probeHost);
  const probeRoot = createRoot(probeHost);
  flushSync(() => probeRoot.render(<Probe />));
  expect(queueLength).toBe(3);

  flushSync(() => host.querySelector<HTMLInputElement>('[data-report-resolve="4"]')!.click());
  await settle();
  expect(dismissals).toEqual([{ target: { kind: "subjects", subjects: [{ kind: "report", seq: 4 }] }, undo: false, surface: "desktop" }]);
  expect(host.querySelector<HTMLInputElement>('[data-report-resolve="4"]')!.checked).toBe(true);
  expect(host.querySelector('[data-report-entry="4"]')!.getAttribute("data-report-question")).toBe("resolved");
  expect(host.querySelector("[data-report-open-count]")!.getAttribute("data-report-open-count")).toBe("2");
  expect(queueLength).toBe(2);

  /* Unticking is the undo of the same record. */
  flushSync(() => host.querySelector<HTMLInputElement>('[data-report-resolve="4"]')!.click());
  await settle();
  expect(dismissals.at(-1)).toEqual({ target: { kind: "subjects", subjects: [{ kind: "report", seq: 4 }] }, undo: true, surface: "desktop" });
  expect(host.querySelector<HTMLInputElement>('[data-report-resolve="4"]')!.checked).toBe(false);
  expect(queueLength).toBe(3);
  flushSync(() => probeRoot.unmount());
});

test("«Resolve all» resolves exactly the open set in one request", async () => {
  pages = [questionPage()];
  const host = mount();
  await settle();
  flushSync(() => host.querySelector<HTMLButtonElement>("[data-report-resolve-all]")!.click());
  await settle();
  expect(dismissals).toHaveLength(1);
  const subjects = (dismissals[0]!.target as { subjects: Array<{ seq: number }> }).subjects.map((subject) => subject.seq).sort();
  expect(subjects).toEqual([3, 4, 6]);
  expect([...host.querySelectorAll('[data-report-question="open"]')]).toHaveLength(0);
  expect(host.querySelector<HTMLButtonElement>("[data-report-resolve-all]")!.disabled).toBe(true);
});

test("prev and next walk the open questions only, wrapping, and mark the one they land on", async () => {
  pages = [questionPage()];
  const host = mount();
  await settle();
  const current = () => host.querySelector("[data-report-current]")?.getAttribute("data-report-entry") ?? null;
  const next = () => flushSync(() => host.querySelector<HTMLButtonElement>("[data-report-question-next]")!.click());
  const prev = () => flushSync(() => host.querySelector<HTMLButtonElement>("[data-report-question-prev]")!.click());
  next();
  expect(current()).toBe("6");
  next();
  expect(current()).toBe("4");
  next();
  expect(current()).toBe("3");
  next();
  expect(current()).toBe("6");
  prev();
  expect(current()).toBe("3");
});

test("«Clear resolved» takes resolved questions out of the view on this device and «Show resolved» brings them back", async () => {
  pages = [page([
    entry(3, { class: "question", body: "Open" }),
    entry(1, { class: "question", body: "Resolved" }),
  ], { questions: { open: [3], resolved: [{ seq: 1, at: "2026-09-24T09:30:00.000Z" }] } })];
  const host = mount();
  await settle();
  flushSync(() => host.querySelector<HTMLButtonElement>('[data-report-hide-resolved="shown"]')!.click());
  expect(host.querySelector('[data-report-entry="1"]')).toBeNull();
  expect(host.querySelector('[data-report-entry="3"]')).not.toBeNull();
  expect(dom.localStorage.getItem(`llvReportLogHideResolved:${PROJECT}`)).toBe("1");
  flushSync(() => host.querySelector<HTMLButtonElement>('[data-report-hide-resolved="hidden"]')!.click());
  expect(host.querySelector('[data-report-entry="1"]')).not.toBeNull();
});

/* «Готово» (docs/design/done-section.md) is pinned at the top of the log: the
   same list «Чекають на вас» opens with, cut to this project and to what
   belongs to no board, newest first, folding to its head with the count. */
function doneItem(key: string, over: Partial<DoneItemV1> = {}): DoneItemV1 {
  const at = new Date(Date.UTC(2026, 8, 24, 11)).toISOString();
  return { key, kind: "task", look: "closed", project: PROJECT, at, createdAt: at, title: `Closed ${key}`, icon: null, refs: {}, frame: null, frameCheckedAt: at, acknowledgedAt: null, acknowledgedBy: null, ...over };
}

test("«Готово» is pinned above the log for this project, newest first, and «Seen all» accepts what it shows", async () => {
  doneServer = [
    doneItem("report:r-incident", { kind: "report", look: "incident", at: new Date(Date.UTC(2026, 8, 24, 11, 50)).toISOString(), title: "A lane stalled and was restarted" }),
    doneItem("deploy:d1", { kind: "deploy", look: "deploy", project: null, at: new Date(Date.UTC(2026, 8, 24, 11, 55)).toISOString(), refs: { phase: "succeeded" } }),
    doneItem("task:t-other", { project: "repo-other", title: "Another board's work" }),
    doneItem("task:t-mine", { title: "This board's work" }),
  ];
  pages = [page([entry(3), entry(2)])];
  const host = mount();
  await settle();
  const log = host.querySelector("[data-report-log]")!;
  const section = log.querySelector<HTMLElement>('[data-done-section="desktop"]')!;
  expect(section.getAttribute("data-done-place")).toBe("reports");
  /* Under the log's heading, before the entries, outside their scroller. */
  const scroller = log.querySelector("[data-report-log-entries]")!.parentElement!;
  expect(scroller.contains(section)).toBe(false);
  expect(section.compareDocumentPosition(scroller as unknown as Node) & 4).toBe(4);
  expect(section.querySelector("[data-done-count]")!.textContent).toBe("3");
  expect([...section.querySelectorAll("[data-done-row], [data-done-group]")].map((row) => row.getAttribute("data-done-row") ?? row.getAttribute("data-done-group")))
    .toEqual(["deploy:d1", "report:r-incident", "closed"]);
  expect(section.textContent).not.toContain("Another board's work");

  /* Folded to its head, the count stays. */
  (section.querySelector("[data-done-fold]") as HTMLElement).click();
  await settle();
  expect(section.querySelector("[data-done-list]")).toBeNull();
  expect(section.querySelector("[data-done-count]")!.textContent).toBe("3");
  expect(localStorage.getItem("llvDoneFolded:reports:desktop")).toBe("1");
  (section.querySelector("[data-done-fold]") as HTMLElement).click();
  await settle();

  (section.querySelector("[data-done-accept-all]") as HTMLElement).click();
  await settle();
  expect(doneWrites).toEqual([{ keys: ["deploy:d1", "report:r-incident", "task:t-mine"], undo: false, surface: "desktop" }]);
  expect(section.querySelector("[data-done-all-accepted]")).not.toBeNull();
  expect(section.querySelector("[data-done-count]")!.textContent).toBe("0");
});

/* Audit B43: a refused Resolve or Undo is taken back and says why beside the question. */
test("a refused Resolve and a refused Undo each come back with the server's words beside the question, cleared by the next press", async () => {
  pages = [questionPage()];
  const host = mount();
  await settle();
  dismissalRefusal = "INVALID_REQUEST";
  flushSync(() => host.querySelector<HTMLInputElement>('[data-report-resolve="4"]')!.click());
  await settle();
  expect(dismissals).toHaveLength(1);
  expect(host.querySelector<HTMLInputElement>('[data-report-resolve="4"]')!.checked).toBe(false);
  expect(host.querySelector('[data-report-resolve-error="4"]')?.textContent).toBe("Could not mark it resolved: INVALID_REQUEST");
  /* The next press clears it, and this one lands. */
  dismissalRefusal = null;
  flushSync(() => host.querySelector<HTMLInputElement>('[data-report-resolve="4"]')!.click());
  expect(host.querySelector('[data-report-resolve-error="4"]')).toBeNull();
  await settle();
  expect(host.querySelector<HTMLInputElement>('[data-report-resolve="4"]')!.checked).toBe(true);
  dismissalRefusal = "INVALID_REQUEST";
  flushSync(() => host.querySelector<HTMLInputElement>('[data-report-resolve="4"]')!.click());
  await settle();
  /* The layer is taken back (the box reads what the server last said); the refusal says why. */
  expect(host.querySelector('[data-report-resolve-error="4"]')?.textContent).toBe("Could not mark it open again: INVALID_REQUEST");
  expect(dismissals).toHaveLength(3);
});

/* Audit F1: an «Older» page that does not come says so beside the button, which retries. */
test("a failed «Show older» says so under the button, and the next press clears it and loads the page", async () => {
  pages = [page([entry(40), entry(39)], { nextBefore: 39 })];
  const served = globalThis.fetch;
  let refuseOlder = true;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (refuseOlder && String(input).includes("before=39")) return new Response("{}", { status: 503 });
    return served(input, init);
  }) as typeof fetch;
  const host = mount();
  await settle();
  (host.querySelector("[data-report-log-older]") as HTMLElement).click();
  await settle();
  expect(host.querySelector("[data-report-log-older-failed]")?.textContent).toBe("Could not load older reports. Press Show older to try again.");
  expect(host.querySelector("[data-report-log-older]")).not.toBeNull();

  refuseOlder = false;
  pages = [page([entry(38), entry(37)], { nextBefore: null })];
  (host.querySelector("[data-report-log-older]") as HTMLElement).click();
  await settle();
  expect(host.querySelector("[data-report-log-older-failed]")).toBeNull();
  expect([...host.querySelectorAll("[data-report-entry]")].map((row) => row.getAttribute("data-report-entry"))).toEqual(["40", "39", "38", "37"]);
});
