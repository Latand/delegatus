import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { TaskSpendAccount, TaskSpendProvider, TaskSpendSummary } from "@/lib/activity/taskLimitSpendTypes";

/*
 * Task limit spend on the card (docs/design/task-limit-spend.md §7.2): each
 * provider's engine mark and a four-cell scale with no digits, read for the
 * whole board in one request; the popover's estimates read as estimates (≈,
 * ≥, <1%, ±30%), a provider with no limit readings shows its tokens only, and
 * a member who is not the owner gets no account detail.
 */

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, PointerEvent: dom.PointerEvent,
  CustomEvent: dom.CustomEvent, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  matchMedia: dom.matchMedia.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const account = (key: string, label: string, plan: string, weeklyPp: number | null, tokens: number, used: number | null, sessionPp: number | null = null): TaskSpendAccount =>
  ({ key, label, plan, weeklyPp, tokens, week: used === null ? null : { usedPercent: used, taskPp: weeklyPp }, sessionPp });
const provider = (engine: "claude" | "codex", accounts: TaskSpendAccount[], bound: TaskSpendProvider["bound"] = "approx", floor: TaskSpendProvider["floor"] = null): TaskSpendProvider =>
  ({ engine, bound, floor, accounts, weeklyPp: accounts.reduce((sum, a) => sum + (a.weeklyPp ?? 0), 0), tokens: accounts.reduce((sum, a) => sum + a.tokens, 0) });

const TASKS: Record<string, TaskSpendSummary> = {
  two: { providers: [
    provider("claude", [account("claude:a", "A", "max", 2.1, 132e6, 53, 12), account("claude:b", "B", "max", 1, 61e6, 31)]),
    provider("codex", [account("codex:a", "A", "pro", 1.2, 24e6, 47), account("codex:b", "B", "pro", 0.4, 9e6, 22)]),
  ] },
  large: { providers: [
    provider("claude", [account("claude:a", "A", "max", 12.4, 610e6, 66)], "floor", "before-counting"),
    provider("codex", [account("codex:a", "A", "pro", 21.3, 402e6, 74), account("codex:d", "D", "pro", 12.9, 250e6, 40)]),
  ] },
  norate: { providers: [
    provider("claude", [account("claude:c", "C", "max", null, 41e6, null)], "norate"),
    provider("codex", [account("codex:a", "A", "pro", 1, 21e6, 47)]),
  ] },
  counting: { providers: [] },
  /* Lower bounds just under a band's edge: the scale fills by the floored figure. */
  floor46: { providers: [provider("claude", [account("claude:a", "A", "max", 4.6, 200e6, 50)], "floor", "before-counting")] },
  floor146: { providers: [provider("claude", [account("claude:a", "A", "max", 14.6, 600e6, 60)], "floor", "before-counting")] },
  long: { providers: [provider("claude", [account("claude:a", "Research workstation in the second office, shared by the whole data team on site", "max", 2, 90e6, 40)])] },
};

const previousFetch = globalThis.fetch;
const calls: string[] = [];
let guest = false;
let refuse = false;
/* Set by a test to hold the next answer open until it says so. */
let hold: Promise<void> | null = null;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  calls.push(url);
  if (hold) { const wait = hold; hold = null; await wait; }
  if (refuse) return new Response("{}", { status: 500 });
  if (url.startsWith("/api/task-spend?")) {
    const ids = new URL(url, "http://localhost").searchParams.get("ids")!.split(",");
    const tasks = Object.fromEntries(ids.filter((id) => TASKS[id]).map((id) => [id, guest
      ? { providers: TASKS[id]!.providers.map((p) => ({ ...p, accounts: null })) }
      : TASKS[id]!]));
    return Response.json({ generatedAt: 1, tasks });
  }
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;

const { TaskSpendMarks, PhoneTaskSpend, spendCells } = await import("./TaskSpend");
const { resetTaskSpend, flushTaskSpend, pendingTaskSpendRefresh, setTaskSpendClock } = await import("./taskSpendSummaries");
/* A clock that never fires: each read runs when a test flushes it. */
setTaskSpendClock({ set: () => ({}), clear: () => {} });
const { setLocale } = await import("@/lib/i18n");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  resetTaskSpend();
  calls.length = 0;
  guest = false;
  refuse = false;
  hold = null;
  setLocale("en");
});
afterAll(() => {
  globalThis.fetch = previousFetch;
  setTaskSpendClock(null);
});

/* The store's pending read, run now. */
const settle = async () => {
  await act(async () => {
    await flushTaskSpend();
  });
};

function render(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const host = render(node);
  await settle();
  return host;
}

const spendCalls = () => calls.filter((url) => url.startsWith("/api/task-spend?")).map((url) => new URL(url, "http://localhost").searchParams.get("ids")!.split(","));

const marks = (host: Element, id: string) => [...host.querySelectorAll(`[data-spend='${id}'] .spend-p`)].map((p) => [
  p.getAttribute("data-engine"), p.getAttribute("data-kind"),
  p.querySelector("svg.scale") ? p.querySelectorAll("svg.scale rect.on").length : null,
]);

async function open(id: string): Promise<HTMLElement> {
  const trigger = document.querySelector<HTMLElement>(`[data-spend='${id}']`)!;
  await act(async () => trigger.dispatchEvent(new dom.FocusEvent("focus") as unknown as Event));
  /* React listens for focusin. */
  await act(async () => trigger.dispatchEvent(new dom.FocusEvent("focusin", { bubbles: true }) as unknown as Event));
  return document.querySelector<HTMLElement>(`[data-spend-pop='${id}']`)!;
}

test("the scale fills by the figure the popover prints: none below 1 %, then 1–4, 5–14, 15–29, 30 and over", () => {
  expect([0, 0.99, 1, 4.4, 4.6, 14.4, 14.6, 29.4, 29.6, 80].map(spendCells)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
});

test("the board's cards ask once for every task, and each provider draws its mark and its scale with no digits", async () => {
  const host = await mount(<>
    <TaskSpendMarks taskId="two" interactive />
    <TaskSpendMarks taskId="large" interactive />
    <TaskSpendMarks taskId="norate" interactive />
    <TaskSpendMarks taskId="counting" interactive />
  </>);
  expect(spendCalls()).toEqual([["two", "large", "norate", "counting"]]);
  expect(marks(host, "two")).toEqual([["claude", "num", 1], ["codex", "num", 1]]);
  expect(marks(host, "large")).toEqual([["claude", "floor", 2], ["codex", "num", 4]]);
  expect(marks(host, "norate")).toEqual([["claude", "norate", null], ["codex", "num", 1]]);
  /* Still being counted: nothing at all. */
  expect(host.querySelector("[data-spend='counting']")).toBeNull();
  for (const id of ["two", "large"]) expect(/\d/.test(host.querySelector(`[data-spend='${id}']`)!.textContent!)).toBe(false);
  expect(host.querySelector("[data-spend='large'] .scale-floor")!.textContent).toBe("≥");
  expect(host.querySelector("[data-spend='norate'] .spend-n")!.textContent).toBe("unknown");
  expect(host.querySelector("[data-spend='large']")!.getAttribute("aria-label")).toBe("Limit spent: Claude at least 12% of the week, Codex about 34% of the week");
  expect(host.querySelector("[data-spend='two']")!.getAttribute("role")).toBe("button");
});

test("a card that mounts while a read is out is asked for after the settle delay, not the next beat", async () => {
  let answer!: () => void;
  hold = new Promise<void>((resolve) => { answer = resolve; });
  render(<TaskSpendMarks taskId="two" interactive />);
  expect(pendingTaskSpendRefresh()).toBe(250);
  let first!: Promise<void>;
  act(() => { first = flushTaskSpend(); });
  /* The first read is out for «two»; «large» mounts before it answers. */
  const host = render(<TaskSpendMarks taskId="large" interactive />);
  expect(spendCalls()).toEqual([["two"]]);
  await act(async () => { answer(); await first; });
  expect(host.querySelector("[data-spend='large']")).toBeNull();
  /* The answer did not ask for it, so the next read is the settle delay away. */
  expect(pendingTaskSpendRefresh()).toBe(250);
  await settle();
  expect(spendCalls()).toEqual([["two"], ["two", "large"]]);
  expect(marks(host, "large")).toEqual([["claude", "floor", 2], ["codex", "num", 4]]);
  /* Everything asked for: back to the slow beat. */
  expect(pendingTaskSpendRefresh()).toBe(45_000);
});

test("a lower bound's scale fills by its printed, floored figure", async () => {
  const host = await mount(<><TaskSpendMarks taskId="floor46" interactive /><TaskSpendMarks taskId="floor146" interactive /></>);
  expect(marks(host, "floor46")).toEqual([["claude", "floor", 1]]);
  expect(marks(host, "floor146")).toEqual([["claude", "floor", 2]]);
  expect((await open("floor46")).textContent).toContain("Claude ≥4%");
  expect((await open("floor146")).textContent).toContain("Claude ≥14%");
});

test("an account's label is printed whole, with no title standing in for a cut", async () => {
  await mount(<><TaskSpendMarks taskId="long" interactive /><PhoneTaskSpend taskId="long" headingClass="h" /></>);
  const name = "Research workstation in the second office, shared by the whole data team on site · Max";
  const pop = await open("long");
  for (const label of [pop.querySelector(".meter-label")!, document.querySelector("[data-phone-task-spend='long'] .meter-label")!]) {
    expect(label.textContent).toBe(name);
    expect(label.hasAttribute("title")).toBe(false);
  }
});

test("a screen reader reaches the popover's lines: the open marks are described by the bubble", async () => {
  await mount(<TaskSpendMarks taskId="two" interactive />);
  const trigger = document.querySelector<HTMLElement>("[data-spend='two']")!;
  expect(trigger.hasAttribute("aria-describedby")).toBe(false);
  await open("two");
  const described = document.getElementById(trigger.getAttribute("aria-describedby")!)!;
  expect(described.getAttribute("role")).toBe("tooltip");
  const text = described.textContent!;
  for (const line of ["A · Max", "B · Max", "A · Pro", "B · Pro", "week 53%", "Now 12% of A's 5-hour window", "±30%"]) expect(text).toContain(line);
  await act(async () => trigger.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
  expect(trigger.hasAttribute("aria-describedby")).toBe(false);
});

test("a tap opens the popover and the next tap closes it: a touch pointer neither hovers it open nor focuses it open", async () => {
  await mount(<TaskSpendMarks taskId="two" interactive />);
  const trigger = document.querySelector<HTMLElement>("[data-spend='two']")!;
  const pointer = (type: string) => new dom.PointerEvent(type, { bubbles: type !== "pointerenter", pointerType: "touch" }) as unknown as Event;
  const tap = async (focus: boolean) => {
    await act(async () => trigger.dispatchEvent(pointer("pointerover")));
    await act(async () => trigger.dispatchEvent(pointer("pointerenter")));
    await act(async () => trigger.dispatchEvent(pointer("pointerdown")));
    if (focus) await act(async () => trigger.dispatchEvent(new dom.FocusEvent("focusin", { bubbles: true }) as unknown as Event));
    await act(async () => trigger.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  };
  await tap(true);
  expect(document.querySelector("[data-spend-pop='two']")).not.toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await tap(false);
  expect(document.querySelector("[data-spend-pop='two']")).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("the popover reads as an estimate: ≈ per provider, each account beside its week, the 5-hour share, ±30 %", async () => {
  await mount(<TaskSpendMarks taskId="two" interactive />);
  const pop = await open("two");
  expect(pop).not.toBeNull();
  const text = pop.textContent!;
  expect(text).toContain("Claude ≈3%");
  expect(text).toContain("Codex ≈2%");
  expect([...pop.querySelectorAll(".meter-label")].map((el) => el.textContent)).toEqual(["A · Max", "B · Max", "A · Pro", "B · Pro"]);
  expect([...pop.querySelectorAll(".meter-num")].map((el) => el.textContent)).toEqual(["2%", "1%", "1%", "0.4%"]);
  expect(pop.querySelector("[data-spend-session='claude:a']")!.textContent).toBe("Now 12% of A's 5-hour window");
  expect(pop.querySelector(".pop-note")!.textContent).toBe("Estimate, ±30%");
  const trigger = document.querySelector<HTMLElement>("[data-spend='two']")!;
  await act(async () => trigger.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
  expect(document.querySelector("[data-spend-pop='two']")).toBeNull();
});

test("a lower bound says so; an account with no limit readings shows tokens and no percent — in Ukrainian too", async () => {
  setLocale("uk");
  await mount(<><TaskSpendMarks taskId="large" interactive /><TaskSpendMarks taskId="norate" interactive /></>);
  const large = await open("large");
  expect(large.textContent).toContain("Claude ≥12%");
  expect(large.querySelector("[data-spend-provider='claude'] .meter-sign")!.textContent).toBe("≥");
  expect(large.querySelector(".pop-warn")!.textContent).toBe("Нижня межа: роботу до початку обліку не пораховано");
  const norate = await open("norate");
  const claude = norate.querySelector("[data-spend-provider='claude']")!;
  expect(claude.textContent!.replace(/\s/g, " ")).toBe("Claude — ліміт акаунта невідомийC · Max: 41 млн токенів, показано лише токени");
  expect(/%/.test(claude.textContent!)).toBe(false);
  expect(norate.querySelector(".pop-note")!.textContent).toBe("Оцінка, ±30%. Для Claude C ще немає показів ліміту");
});

test("a member who is not the owner sees each provider's figure and no account", async () => {
  guest = true;
  await mount(<TaskSpendMarks taskId="two" interactive />);
  const pop = await open("two");
  expect(pop.querySelectorAll(".meter").length).toBe(0);
  expect(pop.textContent).toBe("Limit spent by this taskClaude ≈3% of the weekCodex ≈2% of the weekEstimate, ±30%");
});

test("the phone's face is passive, and its task screen lists the numbers; a refused read draws nothing", async () => {
  const host = await mount(<><TaskSpendMarks taskId="two" interactive={false} /><PhoneTaskSpend taskId="two" headingClass="h" /></>);
  const face = host.querySelector("[data-spend='two']")!;
  expect(face.getAttribute("role")).toBeNull();
  expect(face.getAttribute("aria-hidden")).toBe("true");
  expect(host.querySelector("[data-phone-task-spend='two'] h2")!.textContent).toBe("Limits");
  expect(host.querySelectorAll("[data-phone-task-spend='two'] .meter").length).toBe(4);

  for (const root of roots.splice(0)) act(() => root.unmount());
  resetTaskSpend();
  refuse = true;
  const refused = await mount(<TaskSpendMarks taskId="two" interactive />);
  expect(refused.querySelector("[data-spend]")).toBeNull();
});
