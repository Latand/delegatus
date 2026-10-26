import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";

import type { TaskProgress } from "@/lib/tasks/types";

/* The agent's estimate beside the card's status dot (docs/design/card-progress-estimate.md,
   variant 3), rendered by React on an invented state: nothing for an estimate
   nobody set, the bar's value and words for one that was, the sweep only while
   work runs, and the dot's popover carrying the estimate's second line. */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  FocusEvent: dom.FocusEvent,
  PointerEvent: dom.PointerEvent ?? dom.MouseEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { CardStateLine } = await import("./CardStateLine");
const { PROGRESS_STALE_MS, progressLine } = await import("./TaskProgressBar");
const { setLocale, translate } = await import("@/lib/i18n");
type CardStateModel = import("./cardState").CardState;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  setLocale("en");
});

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const estimate = (value: number, setAt: string, by: TaskProgress["by"] = { kind: "agent", role: "builder", conversationId: "conversation_a" }): TaskProgress => ({ value, setAt, by });
const WORKING = { owner: "working", subject: { kind: "motion" }, lanes: [], sinceMs: NOW - 5 * 60_000 } as unknown as CardStateModel;

function mount(progress: ComponentProps<typeof CardStateLine>["progress"], phone = false): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(<CardStateLine state={WORKING} nowMs={NOW} title="Import contacts" motion={<span>Working</span>} phone={phone} progress={progress} />));
  return host;
}

test("an estimate nobody set draws no bar", () => {
  const host = mount(undefined);
  expect(host.querySelector(".task-progress")).toBeNull();
  expect(host.querySelector(".card-state-dot")).not.toBeNull();
});

test("a reported estimate is a progress bar with its value, age and author", () => {
  const host = mount({ progress: estimate(35, minutesAgo(18)), running: false, color: null });
  const bar = host.querySelector<HTMLElement>(".task-progress")!;
  expect(bar.getAttribute("role")).toBe("progressbar");
  expect(bar.getAttribute("aria-valuenow")).toBe("35");
  expect(bar.getAttribute("aria-valuetext")).toBe("Agent estimate ≈35% · 18m ago · Builder");
  expect(bar.getAttribute("aria-label")).toBe("Agent estimate for «Import contacts»");
  expect(bar.style.getPropertyValue("--task-progress-value")).toBe("35%");
  expect(bar.dataset.taskProgress).toBe("fresh");
  /* Beside the dot: the dot first, then the bar, then the words. */
  const line = host.querySelector(".card-state")!;
  const order = [...line.children].map((child) => child.className.split(" ")[0]);
  expect(order.indexOf("card-state-dot")).toBeLessThan(order.indexOf("task-progress"));
  expect(order.indexOf("task-progress")).toBeLessThan(order.indexOf("card-state-words"));
});

test("0 % is a bar with an empty fill, not an absent one", () => {
  const host = mount({ progress: estimate(0, minutesAgo(6)), running: false, color: null });
  expect(host.querySelector(".task-progress")!.getAttribute("aria-valuenow")).toBe("0");
});

test("the task's colour fills the bar", () => {
  const host = mount({ progress: estimate(65, minutesAgo(12)), running: false, color: "#3d7fd6" });
  const bar = host.querySelector<HTMLElement>(".task-progress")!;
  expect(bar.style.getPropertyValue("--task-progress-colour")).toBe("#3d7fd6");
  expect(bar.hasAttribute("data-coloured")).toBe(true);
  expect(mount({ progress: estimate(65, minutesAgo(12)), running: false, color: null }).querySelector(".task-progress[data-coloured]")).toBeNull();
});

test("the sweep exists only while work runs and only on the unfilled part", () => {
  expect(mount({ progress: estimate(35, minutesAgo(18)), running: true, color: null }).querySelector(".task-progress-glow")).not.toBeNull();
  expect(mount({ progress: estimate(35, minutesAgo(18)), running: false, color: null }).querySelector(".task-progress-glow")).toBeNull();
  expect(mount({ progress: estimate(100, minutesAgo(18)), running: true, color: null }).querySelector(".task-progress-glow")).toBeNull();
});

test("an estimate older than a day is drawn striped and called the last one", () => {
  const old = estimate(50, new Date(NOW - PROGRESS_STALE_MS - 3 * 3_600_000).toISOString(), { kind: "agent", role: null, conversationId: null });
  const host = mount({ progress: old, running: false, color: null });
  expect(host.querySelector<HTMLElement>(".task-progress")!.dataset.taskProgress).toBe("stale");
  expect(host.querySelector(".task-progress")!.getAttribute("aria-valuetext")?.replace(/\u00a0/g, " ")).toBe("Last agent estimate ≈50% · 27h ago · agent");
});

test("the words are Ukrainian under the Ukrainian interface", () => {
  setLocale("uk");
  const t = (key: string, vars?: Record<string, string | number>) => translate("uk", key as never, vars as never);
  expect(progressLine(t as never, estimate(35, minutesAgo(18), { kind: "operator" }), NOW)).toBe("Оцінка агента ≈35% · 18 хв тому · оператор");
});

test("the dot's popover carries the estimate on a second line; the phone's passive dot has none", () => {
  const host = mount({ progress: estimate(65, minutesAgo(12)), running: false, color: null });
  const dot = host.querySelector<HTMLElement>("[data-card-state-dot]")!;
  flushSync(() => dot.dispatchEvent(new (globalThis as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", { bubbles: true })));
  const pop = document.querySelector("[data-card-state-pop]")!;
  expect(pop.textContent).toBe("Working for 5m");
  expect(document.querySelector("[data-card-progress-line]")!.textContent).toBe("Agent estimate ≈65% · 12m ago · Builder");
  expect(dot.getAttribute("aria-label")).toContain("Agent estimate ≈65%");
  const phone = mount({ progress: estimate(65, minutesAgo(12)), running: false, color: null }, true);
  expect(phone.querySelector("[data-card-state-dot]")).toBeNull();
  expect(phone.querySelector(".task-progress")!.getAttribute("aria-valuetext")).toContain("65%");
});
