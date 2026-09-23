/**
 * Loading placeholders in the shape of what replaces them (#2071,
 * docs/design/skeletons-and-transitions.md D3), and the motion rules around
 * them (D8).
 *
 * The phone board's skeleton used to be six identical three-bar cards in a
 * grid, the shape of neither board. Each surface now draws its own content's
 * geometry: sections and rows on the phone, the kanban's seat and four named
 * columns on the desktop, a bottom-anchored feed in a conversation.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale, translate } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  localStorage: dom.localStorage,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
};
const SAVED: Record<string, unknown> = {};
const HAS: Record<string, boolean> = {};
beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = OVERRIDES[key];
  }
});
afterAll(async () => {
  /* Let React finish its scheduled work before the DOM globals go away. */
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  for (const key of Object.keys(OVERRIDES)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
  setLocale("en");
});

const { AccountRowsSkeleton, BoardRowsSkeleton, FeedSkeleton, KanbanSkeleton, PhoneKanbanSkeleton } = await import("./skeletons");
const { SEAT_HEIGHT_VERSION, SEAT_STORAGE_KEY } = await import("./kanban/kanbanSeatStore");

let roots: Root[] = [];
beforeEach(() => {
  roots = [];
  dom.localStorage.clear();
  setLocale("en");
});
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  dom.document.body.replaceChildren();
});

function render(node: React.ReactNode): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  flushSync(() => root.render(node));
  return host as unknown as HTMLElement;
}

test("the phone board skeleton draws the board's sections, a seat and its rows", () => {
  const host = render(<BoardRowsSkeleton />);
  const sections = [...host.querySelectorAll("[data-skeleton-section]")].map((node) => node.textContent);
  expect(sections).toEqual([en["mobile2.board.orchestrator"], en["mobile2.board.working"]]);
  /* The section header is MobileBoard's own: 34 px, the label's type. */
  expect(host.querySelector("[data-skeleton-section]")!.className).toContain("min-h-[34px]");
  expect(host.querySelector("[data-skeleton-seat]")!.className).toContain("min-h-14");
  const rows = [...host.querySelectorAll("[data-skeleton-row]")];
  expect(rows.length).toBeGreaterThanOrEqual(8);
  for (const row of rows) {
    /* The board's card: 56 px, 12 px radius, the 8 px state dot, then a title
       bar and a meta bar. No chevron. */
    expect(row.className).toContain("min-h-14");
    expect(row.className).toContain("rounded-[12px]");
    expect(row.querySelector(".h-2.w-2.rounded-full")).not.toBeNull();
    expect(row.querySelectorAll(".skeleton-pulse").length).toBe(2);
    expect(row.querySelector("svg")).toBeNull();
  }
  /* The widths vary by row, so a column of placeholders is not one bar. */
  const widths = new Set(rows.map((row) => (row.querySelector(".skeleton-pulse") as HTMLElement).style.width));
  expect(widths.size).toBeGreaterThan(3);
});

test("the phone's columns skeleton draws the seat, the real column tabs with Assigned open, and cards in the card's anatomy, in en and uk (#2072 slice 4)", () => {
  const host = render(<PhoneKanbanSkeleton />);
  const labels = () => [...host.querySelectorAll("[data-skeleton-tabs] > span > span:first-child")].map((node) => node.textContent);
  expect(labels()).toEqual([en["kanban.status.inbox"], en["kanban.status.assigned"], en["kanban.status.blocked"], en["kanban.status.done"]]);
  /* Counts are not known yet: a dimmed bar where each will be. */
  for (const tab of host.querySelectorAll("[data-skeleton-tabs] > span")) expect(tab.querySelectorAll(".skeleton-pulse").length).toBe(1);
  /* The board opens on Assigned: its tab is the selected surface with the underline. */
  const tabs = [...host.querySelectorAll("[data-skeleton-tabs] > span")];
  expect(tabs.map((tab) => tab.className.includes("bg-card"))).toEqual([false, true, false, false]);
  expect(tabs[1]!.querySelector(".bg-accent")).not.toBeNull();
  expect(host.querySelector("[data-skeleton-seat]")).not.toBeNull();
  const cards = [...host.querySelectorAll("[data-skeleton-card]")];
  expect(cards.length).toBeGreaterThanOrEqual(5);
  for (const card of cards) {
    expect(card.className).toContain("rounded-[12px]");
    expect(card.className).toContain("min-h-14");
  }
  /* Pill shapes where a stage chain will be, on most cards. */
  expect(cards.filter((card) => card.querySelector(".rounded-full[style*='height: 22px']")).length).toBeGreaterThanOrEqual(3);
  flushSync(() => setLocale("uk"));
  expect(labels()).toEqual([translate("uk", "kanban.status.inbox"), translate("uk", "kanban.status.assigned"), translate("uk", "kanban.status.blocked"), translate("uk", "kanban.status.done")]);
  flushSync(() => setLocale("en"));
});

test("the list and rail variants keep the row and drop what their content lacks", () => {
  const list = render(<BoardRowsSkeleton variant="list" rows={3} />);
  expect(list.querySelector("[data-skeleton-section]")).toBeNull();
  expect(list.querySelectorAll("[data-skeleton-row]").length).toBe(3);
  expect(list.querySelector("[data-skeleton-row]")!.className).toContain("bg-quiet");
  const rail = render(<BoardRowsSkeleton variant="rail" rows={2} />);
  const railRow = rail.querySelector("[data-skeleton-row]")!;
  expect(railRow.className).toContain("min-h-11");
  expect(railRow.querySelector(".rounded-full")).toBeNull();
});

test("the desktop board skeleton is the kanban frame with the four real column heads, in en and uk", () => {
  const host = render(<KanbanSkeleton project="atlas" />);
  const root = host.querySelector("[data-kanban-skeleton]")!;
  expect(root.classList.contains("kb")).toBe(true);
  const heads = () => [...host.querySelectorAll(".column .col-head h2")].map((node) => node.textContent);
  expect(heads()).toEqual([en["kanban.status.inbox"], en["kanban.status.assigned"], en["kanban.status.blocked"], en["kanban.status.done"]]);
  /* Two waiting, one assigned, none elsewhere. */
  expect([...host.querySelectorAll(".column")].map((column) => column.querySelectorAll("[data-skeleton-card]").length)).toEqual([2, 1, 0, 0]);
  expect(host.querySelector(".seat")).not.toBeNull();
  flushSync(() => setLocale("uk"));
  expect(heads()).toEqual([translate("uk", "kanban.status.inbox"), translate("uk", "kanban.status.assigned"), translate("uk", "kanban.status.blocked"), translate("uk", "kanban.status.done")]);
});

test("the desktop board skeleton sizes and folds the seat as this browser keeps it", () => {
  dom.localStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify({ height: 420, heightV: SEAT_HEIGHT_VERSION, collapsed: { atlas: false, folded: true }, placement: "top", width: null }));
  const open = render(<KanbanSkeleton project="atlas" />);
  const seat = open.querySelector<HTMLElement>(".seat")!;
  expect(seat.style.getPropertyValue("--seat-h")).toBe("420px");
  expect(seat.classList.contains("folded")).toBe(false);
  const folded = render(<KanbanSkeleton project="folded" />);
  expect(folded.querySelector(".seat")!.classList.contains("folded")).toBe(true);
  /* The cross-project board has no seat. */
  expect(render(<KanbanSkeleton overview />).querySelector(".seat")).toBeNull();
});

test("the feed skeleton is anchored to the bottom, like the feed", () => {
  const host = render(<FeedSkeleton />);
  const root = host.querySelector<HTMLElement>('[data-skeleton="feed"]')!;
  expect(root.className).toContain("justify-end");
  expect(host.querySelector("[data-skeleton-bubble]")!.className).toContain("ml-auto");
});

test("every skeleton root is a busy status with a translated label, and its bars stop under reduced motion", () => {
  const hosts = [
    render(<BoardRowsSkeleton />),
    render(<PhoneKanbanSkeleton />),
    render(<KanbanSkeleton project="atlas" />),
    render(<FeedSkeleton />),
    render(<AccountRowsSkeleton />),
  ];
  for (const host of hosts) {
    const root = host.querySelector('[aria-busy="true"]');
    expect(root).not.toBeNull();
    expect(root!.getAttribute("role")).toBe("status");
    expect(root!.querySelector(".sr-only")!.textContent!.length).toBeGreaterThan(0);
    const bars = [...host.querySelectorAll(".skeleton-pulse")];
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) expect(bar.className).toContain("motion-reduce:animate-none");
  }
});

test("the old grid of identical cards is gone", () => {
  expect(fs.existsSync(path.join(import.meta.dir, "scheme/SchemeSkeleton.tsx"))).toBe(false);
  const dashboard = fs.readFileSync(path.join(import.meta.dir, "ProjectDashboard.tsx"), "utf8");
  expect(dashboard).not.toContain("SchemeSkeleton");
});

test("the pulse waits 400 ms and yields to reduced motion in the stylesheet too", () => {
  const css = fs.readFileSync(path.join(import.meta.dir, "../app/globals.css"), "utf8");
  expect(css).toMatch(/\.skeleton-pulse\s*\{\s*animation: skeleton-pulse 1\.6s ease-in-out 400ms infinite;/);
  expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.skeleton-pulse\s*\{\s*animation: none;/);
});

test("a phone screen change slides without starting from a blank frame, and a project switch does not move", () => {
  const shell = fs.readFileSync(path.join(import.meta.dir, "mobile/MobileShell.tsx"), "utf8");
  const motion = /const MOTION: Record<string, string> = \{([^}]*)\};/.exec(shell)?.[1] ?? "";
  expect(motion).toContain("push:");
  expect(motion).toContain("pop:");
  expect(motion).not.toContain("opacity");
  expect(motion).not.toContain("switch:");
  expect(shell).toContain("motion-reduce:transition-none");
});
