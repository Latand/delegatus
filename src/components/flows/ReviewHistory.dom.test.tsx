import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { ReviewHistoryDialog, ReviewHistoryHost, openReviewHistory, openProjectReviewHistory } from "./ReviewHistory";
import { FlowStrip } from "./FlowStrip";
import { FlowHub } from "./FlowHub";
import { flowPresentation, patchFlow } from "./flowModel";
import { useEffectiveFlows } from "./useEffectiveFlows";
import type { FileEntry } from "@/lib/types";
import type { Flow } from "@/lib/reviewHistory/types";
import { setLocale, translate } from "@/lib/i18n";

const dom = new Window({ url: "http://viewer.local/" });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node,
  HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, Event: dom.Event, CustomEvent: dom.CustomEvent });
const realFetch = globalThis.fetch;
const roots: Root[] = [];
afterEach(() => { for (const root of roots.splice(0)) flushSync(() => root.unmount()); globalThis.fetch = realFetch; document.body.replaceChildren(); setLocale("en"); });
async function until(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  expect(predicate()).toBe(true);
}
function mount(element: React.ReactNode) { const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root); flushSync(() => root.render(element)); return { root, host }; }
function recorded(id = "archive-one"): Flow {
  return { id, project: "demo", implementerPath: "/builder.jsonl", state: "paused", stateDetail: "Original unresolved delivery",
    roles: { reviewer: { engine: "codex", model: null, effort: null } },
    rounds: Array.from({ length: 9 }, (_, index) => ({ n: index + 1, reviewerPath: "/review-" + (index + 1) + ".jsonl",
      verdict: index === 8 ? "APPROVE" : "REQUEST_CHANGES", reviewHeadSha: "a".repeat(40), reviewedAt: "2026-09-20T00:00:00Z",
      startedAt: "2026-09-19T00:00:00Z", error: null, findingsCount: 1 })),
  } as Flow;
}
function detail(flow = recorded()) { return { row: flow, currentHead: "unknown", artifacts: flow.rounds.map(round => ({ round: round.n, artifacts: { findings: round.n === 1 ? { status: "available", text: "Recorded finding" } : { status: "missing" } } })) }; }

test.each(["en", "uk"] as const)("archive controls and all rounds are read-only in %s", async locale => {
  setLocale(locale);
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => { calls.push({ url, method: init?.method ?? "GET" }); return Response.json(detail()); }) as unknown as typeof fetch;
  const flow = recorded(); const before = JSON.stringify(flow);
  mount(<><ReviewHistoryHost /><FlowStrip flow={flow} /><FlowHub flow={flow} x={0} y={0} interactive moveTransition="" /></>);
  flushSync(() => openReviewHistory(flow.id, 1));
  await until(() => document.body.textContent!.includes("Recorded finding"));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain(translate(locale, "reviewHistory.unresolved"));
  expect(dialog.textContent).toContain("a".repeat(40));
  expect(dialog.querySelectorAll("nav button").length).toBe(9);
  flushSync(() => (dialog.querySelectorAll("nav button")[8] as HTMLButtonElement).click());
  expect(dialog.textContent).toContain("APPROVE");
  expect(dialog.textContent).toContain(translate(locale, "reviewHistory.artifactMissing"));
  expect(dialog.querySelector("textarea")).toBeNull();
  expect(calls.every(call => call.method === "GET" && call.url.startsWith("/api/review-history/"))).toBe(true);
  expect(JSON.stringify(flow)).toBe(before);
  expect(await patchFlow(flow.id, { action: "resume" })).toBe(translate(locale, "reviewHistory.retired"));
  expect(calls).toHaveLength(1);
});

test("a late archive response never replaces the new target", async () => {
  let finish!: (value: Response) => void;
  globalThis.fetch = ((url: string) => url.endsWith("old") ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(Response.json(detail(recorded("new"))))) as unknown as typeof fetch;
  const { root } = mount(<ReviewHistoryDialog target={{ id: "old" }} onClose={() => {}} />);
  flushSync(() => root.render(<ReviewHistoryDialog key="new" target={{ id: "new" }} onClose={() => {}} />));
  await until(() => document.body.textContent!.includes("Original unresolved"));
  finish(Response.json(detail({ ...recorded("old"), stateDetail: "STALE ANSWER" })));
  await new Promise(resolve => setTimeout(resolve, 1));
  expect(document.body.textContent).not.toContain("STALE ANSWER");
});

test.each([404, 500])("a %s archive read is visible and retry recovers without a write", async status => {
  let failed = true;
  globalThis.fetch = (async () => failed ? new Response(null, { status }) : Response.json(detail())) as unknown as typeof fetch;
  mount(<ReviewHistoryDialog target={{ id: "archive-one" }} onClose={() => {}} />);
  await until(() => document.body.textContent!.includes(status === 404 ? "unavailable" : "could not"));
  expect(document.body.textContent).not.toContain("APPROVE");
  if (status === 500) {
    failed = false;
    flushSync(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Retry")!.click());
    await until(() => document.body.textContent!.includes("APPROVE"));
  }
});

test("project history follows cursor pages and opens detail without placing members", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    if (!url.includes("?")) return Response.json(detail());
    const last = url.includes("cursor=");
    return Response.json({ rows: [{ id: last ? "second" : "first", title: last ? "Second" : "First", state: "closed", roundCount: 9, createdAt: "2026-09-20" }], nextCursor: last ? null : "next-page" });
  }) as unknown as typeof fetch;
  mount(<ReviewHistoryHost />);
  flushSync(() => openProjectReviewHistory("demo"));
  await until(() => document.body.textContent!.includes("First"));
  flushSync(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Load more")!.click());
  await until(() => document.body.textContent!.includes("Second"));
  expect(document.body.textContent).toContain("First");
  flushSync(() => [...document.querySelectorAll("button")].find(button => button.textContent!.includes("Second"))!.click());
  await until(() => document.body.textContent!.includes("APPROVE"));
  expect(urls[0]).toContain("project=demo");
  expect(urls.every(url => url.startsWith("/api/review-history"))).toBe(true);
});

test("cached snapshots preserve recorded states and cannot revive flow activity", () => {
  const archived = recorded();
  let observed: Flow[] | null = null;
  function Read() { observed = useEffectiveFlows([archived]) as Flow[]; return null; }
  mount(<Read />);
  expect(observed![0]).toBe(archived);
  expect(observed![0]!.state).toBe("paused");
  expect(flowPresentation(((key: string) => key) as never, archived, "en")).toMatchObject({ attention: false, pending: null, label: "reviewHistory.unresolved" });
});

test("archive transcript links resolve aliases and every same-round binding without a stale generation", async () => {
  const row = recorded();
  row.rounds = [{ ...row.rounds[0]!, reviewerPath: "/old.jsonl", reviewerConversationId: "old-conversation", reviewerBindingId: "current" }];
  const payload = { ...detail(row), conversations: { reviewers: [{ round: 1, conversationId: "canonical-reviewer" }] } };
  globalThis.fetch = (async () => Response.json(payload)) as unknown as typeof fetch;
  const membership = (slot: string) => ({ kind: "flow", containerId: row.id, round: 1, role: "reviewer", slot });
  const files = [
    { path: "/old.jsonl", conversationId: "canonical-reviewer", migratedTo: "/current.jsonl" },
    { path: "/failed.jsonl", conversationId: "failed-reviewer", durableLineage: { memberships: [membership("reviewer:1:earlier")] } },
    { path: "/current.jsonl", conversationId: "canonical-reviewer", predecessorPath: "/old.jsonl", durableLineage: { memberships: [membership("reviewer:1:current")] } },
  ] as unknown as FileEntry[];
  mount(<ReviewHistoryDialog target={{ id: row.id, round: 1 }} files={files} onClose={() => {}} />);
  await until(() => document.querySelectorAll('a[href^="#f="]').length === 2);
  const targets = [...document.querySelectorAll('a[href^="#f="]')].map(link => decodeURIComponent(link.getAttribute("href")!.slice(3)));
  expect(targets).toEqual(["/failed.jsonl", "/current.jsonl"]);
});


test("returning from a missing detail restores the project list", async () => {
  globalThis.fetch = (async (url: string) => url.includes("?")
    ? Response.json({ rows: [{ id: "gone", title: "Missing archive entry", state: "closed", roundCount: 1, createdAt: "2026-09-20" }], nextCursor: null })
    : new Response(null, { status: 404 })) as unknown as typeof fetch;
  mount(<ReviewHistoryDialog target={{ project: "demo" }} onClose={() => {}} />);
  await until(() => document.body.textContent!.includes("Missing archive entry"));
  flushSync(() => [...document.querySelectorAll("button")].find(button => button.textContent!.includes("Missing archive entry"))!.click());
  await until(() => document.body.textContent!.includes("This review is unavailable"));
  flushSync(() => [...document.querySelectorAll("button")].find(button => button.textContent === "All reviews")!.click());
  await until(() => document.body.textContent!.includes("Missing archive entry"));
  expect(document.body.textContent).not.toContain("This review is unavailable");
});


test("archive reserves global keys and restores the opener", async () => {
  globalThis.fetch = (async () => Response.json(detail())) as unknown as typeof fetch;
  const opener = document.createElement("button");
  document.body.append(opener); opener.focus();
  const { root } = mount(<ReviewHistoryHost />);
  flushSync(() => openReviewHistory("archive-one", 1));
  await until(() => document.body.textContent!.includes("Recorded finding"));
  const dialog = document.querySelector<HTMLElement>("[data-review-history]")!;
  expect(dialog.hasAttribute("open")).toBe(true);
  let backgroundKeys = 0;
  const shortcut = () => { backgroundKeys++; };
  window.addEventListener("keydown", shortcut);
  try {
    for (const key of ["/", "n", "f", "b", "ArrowRight", "F2", "j"]) {
      dialog.dispatchEvent(new dom.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
    }
    expect(backgroundKeys).toBe(0);
  } finally { window.removeEventListener("keydown", shortcut); }
  flushSync(() => root.unmount());
  roots.splice(roots.indexOf(root), 1);
  expect(document.activeElement).toBe(opener);
});

test("a requested absent round is explicit and never substitutes the latest verdict", async () => {
  globalThis.fetch = (async () => Response.json(detail())) as unknown as typeof fetch;
  mount(<ReviewHistoryDialog target={{ id: "archive-one", round: 42 }} onClose={() => {}} />);
  await until(() => document.body.textContent!.includes("This review is unavailable"));
  expect(document.querySelector("section")).toBeNull();
});
