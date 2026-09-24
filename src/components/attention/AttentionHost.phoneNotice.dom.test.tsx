import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { closeAgentRegistryForTests } from "@/lib/agent/registry";
import { attentionRecordsForSurface, raiseAttentionRequest } from "@/lib/attention/service";
import type { AttentionNotice } from "@/lib/attention/types";
import { emptyStore, type ConnectionState } from "@/components/runtime/runtimeModel";

/*
 * An agent's request_attention on the phone (docs/design/needs-attention.md
 * §6), end to end on a phone-sized document: the real record, the real
 * rows-only poll the phone's attention host makes, the real bar and the real
 * ⚠ sheet. The operator is reading a conversation when the request arrives.
 * Nothing about that screen may change: the same screen on top of the stack,
 * the same scroll offset, no banner pushing it down. What changes is a dot on
 * the ⚠ badge, and a row in its sheet that goes where the request points.
 */

const runtime = {
  enabled: false,
  connection: "live" as ConnectionState,
  lastEventAt: null as number | null,
  resyncedAt: null,
  store: emptyStore(),
  structuredHostsEnabled: false,
};
const actualRuntimeHooks = await import("@/hooks/useRuntime");
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => runtime,
  useRuntime: () => runtime,
  useRuntimeSelector: (selector: (state: typeof runtime) => unknown) => selector(runtime),
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const { MobileBarTitle, MobileShell } = await import("@/components/mobile/MobileShell");
const { createMobileNav, MobileNavContext, topScreen, useMobileNav } = await import("@/components/mobile/mobileNav");
const { fakeHistory } = await import("@/components/mobile/mobileNavTestHistory");
const { MobileAttentionSheet } = await import("./MobileAttentionSheet");
const { AttentionHost } = await import("./AttentionHost");
const { clearNotice, markNoticesSeen, resetPhoneNoticesForTests, usePhoneNotices } = await import("./phoneNotices");
type MobileNav = ReturnType<typeof createMobileNav>;
type MobileNavHost = Parameters<typeof createMobileNav>[0];

const dom = new Window({ url: "http://localhost/#p=atlas", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => { for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; } });
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); };

let sandbox = "";
let previousStateDir: string | undefined;
let roots: Root[] = [];
const now = new Date("2026-09-24T10:00:00.000Z");
const NOW_S = now.getTime() / 1000;

beforeEach(() => {
  dom.document.body.replaceChildren();
  dom.localStorage.clear();
  roots = [];
  previousStateDir = process.env.LLV_STATE_DIR;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-phone-notice-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetPhoneNoticesForTests();
});
afterEach(async () => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  await settle();
  closeAgentRegistryForTests();
  if (previousStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const READING = "/tmp/what-i-am-reading.jsonl";
const TARGET = "/tmp/reviewer.jsonl";

/** The browser's same-document history, as the shell's own tests model it. */
function browser(): MobileNavHost {
  return fakeHistory("http://localhost/#p=atlas").host;
}

/** The rows-only read, answered as `/api/attention?records=only` answers it. */
const reads: string[] = [];
const transport = (async (url: string) => {
  reads.push(url);
  return { ok: true, status: 200, json: async () => ({ ok: true, ...attentionRecordsForSurface({ now, records: { pipelines: () => [], tasks: () => [] } }) }) };
}) as unknown as typeof fetch;

/** The operator's phone: a conversation open on top of the board, its feed
    scrolled, the bar's ⚠ badge fed by the notice store, the ⚠ sheet listing
    the notices the way the Viewer lists them. */
function Phone({ opened }: { opened: AttentionNotice[] }) {
  const state = useMobileNav();
  const notices = usePhoneNotices();
  const top = topScreen(state);
  const host = {
    attentionCount: 0,
    noticeDot: notices.unseen,
    arrival: null,
    renderSheet: (name: string, close: () => void) => name === "attention" ? (
      <MobileAttentionSheet
        entries={[]}
        now={NOW_S + 60}
        onOpenConversation={() => {}}
        onClose={close}
        notices={notices.notices.map((notice) => ({ notice, target: "Reviewer — login fix", by: "orchestrator" }))}
        onOpenNotice={(notice) => { opened.push(notice); close(); }}
        onClearNotice={clearNotice}
        onNoticesSeen={markNoticesSeen}
      />
    ) : null,
  };
  return (
    <>
      <AttentionHost mobile fetchFn={transport} pollMs={100_000} timing={{ timeoutMs: 0, pollMs: 0 }} />
      <MobileShell screen={top.kind === "chat" ? "chat" : "board"} screenId={top.kind === "chat" ? top.id : undefined} back={top.kind === "chat"} title={<MobileBarTitle>Reading</MobileBarTitle>} host={host}>
        <div data-testid="feed" className="overflow-y-auto">{Array.from({ length: 40 }, (_, i) => <p key={i}>line {i}</p>)}</div>
      </MobileShell>
    </>
  );
}

function mount(): { nav: MobileNav; opened: AttentionNotice[] } {
  const nav = createMobileNav(browser());
  nav.push({ kind: "chat", id: READING });
  const opened: AttentionNotice[] = [];
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  flushSync(() => root.render(<MobileNavContext.Provider value={nav}><Phone opened={opened} /></MobileNavContext.Provider>));
  roots.push(root);
  return { nav, opened };
}

const one = (selector: string) => dom.document.querySelector(selector) as unknown as HTMLElement | null;
const click = (element: HTMLElement | null) => { expect(element).not.toBeNull(); flushSync(() => element!.click()); };
async function poll() {
  dom.document.dispatchEvent(new dom.Event("visibilitychange"));
  await settle();
}

function raiseNotice() {
  return raiseAttentionRequest({
    origin: "root-agent",
    raisedBy: { kind: "manager", conversationId: "conversation_seat", role: "orchestrator" },
    target: { kind: "conversation", path: TARGET },
    frameAtCreation: { project: "atlas", rect: { x: 0, y: 0, w: 0, h: 0 }, boardRevision: null },
    intent: "open",
    reason: "The reviewer finished with request-changes.",
    offeredTo: [],
    delivery: "notice",
  }, { now, id: "attention_notice" }).request;
}

test("a request on the phone leaves the screen in place and lights only the badge's dot", async () => {
  const { nav, opened } = mount();
  await poll();
  const feed = one("[data-testid='feed']")!;
  feed.scrollTop = 240;
  expect(one("[data-mobile2-open='attention']")).toBeNull();
  expect(topScreen(nav.getState())).toEqual({ kind: "chat", id: READING });

  raiseNotice();
  await poll();

  /* The read the phone makes is the rows-only one: it names no device, posts
     nothing, and so can never take the request from a desktop. */
  expect(reads.every((url) => url.startsWith("/api/attention?records=only"))).toBe(true);
  /* The screen the operator was reading is still the screen on top, scrolled
     where they left it, and nothing was put in the flow above it. */
  expect(topScreen(nav.getState())).toEqual({ kind: "chat", id: READING });
  expect(nav.getState().stack).toHaveLength(2);
  expect(one("[data-testid='feed']")).toBe(feed);
  expect(feed.scrollTop).toBe(240);
  expect(one("[data-mobile2-banner]")).toBeNull();
  expect(one(`[data-mobile2-screen="chat"][data-mobile2-conversation="${READING}"]`)).not.toBeNull();
  /* The one change: a dot on the ⚠ badge, the dot alone since nothing else
     needs the operator. */
  const badge = one("[data-mobile2-open='attention']")!;
  expect(badge.hasAttribute("data-mobile2-notice")).toBe(true);
  expect(badge.querySelector("[data-mobile2-notice-dot]")).not.toBeNull();
  expect(badge.getAttribute("aria-label")).toBe("a notice from your agents");

  /* The sheet lists it; opening it marks it seen, and the dot goes out. */
  click(badge);
  await settle();
  const row = one("[data-mobile2-notice-row='attention_notice']")!;
  expect(row.textContent).toContain("The reviewer finished with request-changes.");
  expect(row.textContent).toContain("Reviewer — login fix");
  expect(one("[data-mobile2-open='attention'] [data-mobile2-notice-dot]")).toBeNull();

  /* A tap goes where it points. */
  click(row.querySelector("[data-mobile2-notice-open]") as HTMLElement | null);
  expect(opened.map((notice) => notice.target)).toEqual([{ kind: "conversation", path: TARGET }]);
  expect(opened[0]!.raisedBy).toEqual({ kind: "manager", role: "orchestrator" });
});

test("× clears a notice on this phone, and it stays cleared across reads", async () => {
  mount();
  raiseNotice();
  await poll();
  click(one("[data-mobile2-open='attention']"));
  await settle();
  click(one("[data-mobile2-notice-clear='attention_notice']"));
  await poll();
  expect(one("[data-mobile2-notice-row='attention_notice']")).toBeNull();
  expect(JSON.parse(dom.localStorage.getItem("llv.attentionNotices.v1") ?? "{}").cleared).toEqual(["attention_notice"]);
});
