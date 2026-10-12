import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { BranchGroup } from "@/components/projectModel";
import type { FileEntry } from "@/lib/types";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import type { MobileScreen } from "@/components/mobile/mobileNav";

/*
 * Role avatars on the phone (docs/design/role-avatars.md §10): a review deck's
 * bar wears the reviewer's costume, and so must every answer under it. The deck
 * body is replaced by a stand-in that draws one real FeedItem answer, so what
 * this checks is the role scope MobileFocusView hands the deck.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const normalize = (query: string) => String(query).replace(/\s+/g, "");
const { FeedItem } = await import("@/components/feed/FeedItem");
mock.module("@/components/flows/RoundDeck", () => ({
  RoundDeck: () => (
    <FeedItem item={{ kind: "prose", ts: "2026-09-02T13:43:07Z", engine: "claude", text: "Round one reads clean." } as never} />
  ),
}));

const { MobileFocusView } = await import("@/components/mobile/MobileFocusView");
const { directReviewFlows } = await import("@/components/flows/directReviewGroups");
const { getMobileNav, topScreen } = await import("@/components/mobile/mobileNav");

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: (q: string) => ({ matches: normalize(q) === normalize(MOBILE_LAYOUT_QUERY) || /max-width/.test(String(q)), media: String(q), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" })) as unknown as typeof fetch,
};
/* `useIsMobile` asks `window.matchMedia`, and `window` is this document. */
(dom as unknown as { matchMedia: unknown }).matchMedia = OVERRIDES.matchMedia;
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; });
afterEach(async () => { for (const r of roots) flushSync(() => r.unmount()); roots = []; await settle(); dom.sessionStorage.clear(); });

function mount(node: React.ReactElement): Root {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  return root;
}

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

/** Mobile v2 lane 3: the chip strip is gone. Everything the strip could pin
    is a switcher row now — the review-round decks among them, named for the
    work they review — so this is the phone's route to a deck. */
function openDeck(): void {
  const cell = dom.document.querySelector('[data-mobile2-open="switch"]') as unknown as HTMLButtonElement;
  expect(cell).not.toBeNull();
  flushSync(() => cell.click());
  const row = [...dom.document.querySelectorAll('[data-mobile2-sheet="switch"] [data-mobile2-go="chat"]')]
    .find((node) => (node.textContent ?? "").includes("Review · ")) as unknown as HTMLButtonElement | undefined;
  expect(row).toBeDefined();
  flushSync(() => row!.click());
}

test("the review deck's answers wear the reviewer's costume under the bar's (role scope on the deck branch)", async () => {
  const builder = entry({ path: "/builder", title: "Builder session", conversationId: "conversation-builder", activity: "live", mtime: 9_000 });
  const done = entry({
    path: "/reviewer-1",
    parent: "/builder",
    conversationId: "conversation-r1",
    mtime: 1_000,
    review: { verdict: "REQUEST_CHANGES", findingsCount: 2, observedAt: "2026-07-10T02:00:00.000Z" },
    durableLineage: { kind: "review", role: "reviewer", parentConversationId: "conversation-builder", reviewsConversationId: "conversation-builder", memberships: [] },
  });
  const live = entry({
    path: "/reviewer-2",
    parent: "/builder",
    conversationId: "conversation-r2",
    mtime: 2_000,
    activity: "live",
    durableLineage: { kind: "review", role: "reviewer", parentConversationId: "conversation-builder", reviewsConversationId: "conversation-builder", memberships: [] },
  });
  const files = [builder, done, live];
  const reviewGroups = directReviewFlows({ files, flows: [], tasks: [] });
  expect(reviewGroups).toHaveLength(1);
  const group: BranchGroup = { key: builder.path, columns: [{ file: builder, tasks: [] }], returnable: [], finished: [], smt: builder.mtime };

  roots.push(
    mount(
      <MobileFocusView
        project="demo"
        groups={[group]}
        manual={[]}
        files={files}
        flows={[]}
        reviewGroups={reviewGroups}
        pipelines={[]}
        surfacePipelines={[]}
        tasks={[]}
        drafts={[]}
        loaded
        focus={null}
        onSelect={() => {}}
        onClose={() => {}}
        onDraftClose={() => {}}
        onDraftSpawned={() => {}}
      />,
    ),
  );
  await settle();
  openDeck();
  await settle();

  expect(dom.document.querySelector('[data-mobile2-open="switch"] [data-role-avatar="reviewer"]')).not.toBeNull();
  const answers = [...dom.document.querySelectorAll("[data-mobile-message-header]")];
  expect(answers.length).toBeGreaterThan(0);
  for (const header of answers) {
    const avatar = header.querySelector('[data-role-avatar="reviewer"]');
    expect(avatar).not.toBeNull();
    expect(avatar!.getAttribute("width")).toBe("20");
  }
});
