import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

/* The task icon and its picker (#2102), rendered by React against a scripted
   icon route: what a task is drawn with, how the drawings load, and how the
   picker searches and picks. No route, store or state directory is touched. */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  FocusEvent: dom.FocusEvent,
});

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { TaskIcon } = await import("./TaskIcon");
const { TaskIconPicker } = await import("./TaskIconPicker");
const { resetTaskIconLoaderForTests } = await import("./taskIconLoader");

/* The drawing the scripted route answers for each name it knows. */
const KNOWN: Record<string, string> = { bug: "M1 1h2", rocket: "M2 2h3", smartphone: "M3 3h4", "search-check": "M4 4h5", palette: "M5 5h6" };
let requests: string[][] = [];

beforeEach(() => {
  requests = [];
  resetTaskIconLoaderForTests(async (names) => {
    requests.push(names);
    return Object.fromEntries(names.map((name) => [name, KNOWN[name] ? [["path", { d: KNOWN[name], key: name }]] : null]));
  });
});

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
});

function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(node));
  return host;
}

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const drawn = (element: Element | null) => element?.querySelector("svg path")?.getAttribute("d") ?? null;

test("a stored icon draws once its drawing arrives, holding its box empty until then", async () => {
  const host = mount(<TaskIcon icon="rocket" title="Fix the crash" />);
  const icon = host.querySelector("[data-task-icon]")!;
  expect(icon.getAttribute("data-task-icon")).toBe("rocket");
  expect(icon.getAttribute("data-icon-source")).toBe("stored");
  expect(icon.getAttribute("aria-hidden")).toBe("true");
  expect(icon.querySelector("svg")).toBeNull();
  await settle();
  expect(drawn(host.querySelector("[data-task-icon]"))).toBe("M2 2h3");
  expect(requests).toEqual([["rocket"]]);
});

test("no icon draws the title's suggestion, muted; no suggestion draws the quiet default without asking the route", async () => {
  const host = mount(
    <>
      <TaskIcon icon={null} title="Fix the crash" />
      <TaskIcon title="Quiet evening" />
    </>,
  );
  await settle();
  const [suggested, fallback] = [...host.querySelectorAll("[data-task-icon]")];
  expect(suggested!.getAttribute("data-task-icon")).toBe("bug");
  expect(suggested!.getAttribute("data-icon-source")).toBe("suggested");
  expect(suggested!.className).toContain("text-muted");
  expect(drawn(suggested!)).toBe("M1 1h2");
  expect(fallback!.getAttribute("data-task-icon")).toBe("circle-dashed");
  expect(fallback!.getAttribute("data-icon-source")).toBe("default");
  expect(fallback!.querySelector("svg")).toBeTruthy();
  expect(requests.flat()).toEqual(["bug"]);
});

test("a stored name the route cannot draw falls back to the suggestion", async () => {
  const host = mount(<TaskIcon icon="retired-icon" title="Deploy the host" />);
  await settle();
  const icon = host.querySelector("[data-task-icon]")!;
  expect(icon.getAttribute("data-task-icon")).toBe("rocket");
  expect(icon.getAttribute("data-icon-source")).toBe("suggested");
  expect(drawn(icon)).toBe("M2 2h3");
});

test("every icon a render draws is asked for in one request, and a drawing already held is never asked for again", async () => {
  const host = mount(
    <>
      <TaskIcon icon="smartphone" title="a" />
      <TaskIcon icon="rocket" title="b" />
      <TaskIcon icon="bug" title="c" />
      <TaskIcon icon="rocket" title="d" />
    </>,
  );
  await settle();
  expect(requests).toEqual([["bug", "rocket", "smartphone"]]);
  mount(<TaskIcon icon="bug" title="again" />);
  await settle();
  expect(requests).toHaveLength(1);
  expect([...host.querySelectorAll("[data-task-icon] svg path")].map((path) => path.getAttribute("d"))).toEqual(["M3 3h4", "M2 2h3", "M1 1h2", "M2 2h3"]);
});

test("a route that never answers ends in a drawn fallback, after a bounded number of asks", async () => {
  let asks = 0;
  resetTaskIconLoaderForTests(async () => {
    asks += 1;
    throw new TypeError("Failed to fetch");
  }, 1);
  const host = mount(
    <>
      <TaskIcon icon="rocket" title="Fix the crash" />
      <TaskIcon title="Deploy the host" />
    </>,
  );
  /* Each failed ask is retried a few times, then the icon is held as missing. */
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const icons = [...host.querySelectorAll("[data-task-icon]")];
  expect(icons.map((element) => [element.getAttribute("data-task-icon"), element.getAttribute("data-icon-source")])).toEqual([["circle-dashed", "default"], ["circle-dashed", "default"]]);
  expect(icons.every((element) => element.querySelector("svg"))).toBe(true);
  const settled = asks;
  expect(settled).toBeLessThanOrEqual(12);
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(asks).toBe(settled);
});

test("a drawing whose shape is not lucide's is dropped", async () => {
  resetTaskIconLoaderForTests(async () => ({ bug: [["script", { src: "x" }], ["path", { d: "M9 9", onload: 1 }]] }));
  const host = mount(<TaskIcon icon="bug" title="x" />);
  await settle();
  expect(host.querySelector("script")).toBeNull();
  const path = host.querySelector("svg path")!;
  expect(path.getAttribute("d")).toBe("M9 9");
  expect(path.getAttribute("onload")).toBeNull();
});

const type = (field: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(field, value);
    field.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
};

test("the picker offers the task's icon and suggestion first, searches lucide by name, and picks by click or Enter", async () => {
  const picks: Array<string | null> = [];
  const host = mount(<TaskIconPicker value="rocket" suggestion="bug" onPick={(icon) => picks.push(icon)} />);
  const cells = () => [...host.querySelectorAll<HTMLElement>("[data-icon-choice]")].map((cell) => cell.dataset.iconChoice);
  expect(cells().slice(0, 2)).toEqual(["rocket", "bug"]);
  expect(host.querySelector('[data-icon-choice="rocket"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector("[data-icon-choice-none]")?.getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector(".tip-caption")?.textContent).toBe("Common");

  /* The name list loads on open; typing narrows to it. */
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 50));
  type(host.querySelector<HTMLInputElement>("[data-task-icon-search]")!, "rock");
  expect(cells()[0]).toBe("rocket");
  expect(cells()).toContain("rocking-chair");
  expect(host.querySelector(".tip-caption")?.textContent).toMatch(/^\d+ icons?$/);

  flushSync(() => host.querySelector<HTMLElement>('[data-icon-choice="rocking-chair"]')!.click());
  flushSync(() => host.querySelector<HTMLInputElement>("[data-task-icon-search]")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event));
  flushSync(() => host.querySelector<HTMLElement>("[data-icon-choice-none]")!.click());
  expect(picks).toEqual(["rocking-chair", "rocket", null]);

  type(host.querySelector<HTMLInputElement>("[data-task-icon-search]")!, "zzzzqqq");
  expect(cells()).toEqual([]);
  expect(host.querySelector(".tip-caption")?.textContent).toBe("No lucide icon has that in its name");
});
