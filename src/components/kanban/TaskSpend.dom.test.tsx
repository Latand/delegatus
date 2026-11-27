import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { TaskSpendAccount, TaskSpendProvider, TaskSpendSummary } from "@/lib/activity/taskLimitSpendTypes";

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

const account = (key: string, label: string, plan: string | null, weeklyPp: number | null, tokens: number, used: number | null, sessionPp: number | null = null): TaskSpendAccount =>
  ({ key, label, plan, planTier: null, weeklyPp, tokens, basis: weeklyPp === null ? null : "measured", range: weeklyPp === null ? null : { low: weeklyPp * 0.7, high: weeklyPp * 1.3 }, budget: null,
    apiUsd: tokens / 10e6, apiPricedTokens: tokens, week: used === null ? null : { usedPercent: used, taskPp: weeklyPp }, sessionPp });
const provider = (engine: "claude" | "codex", accounts: TaskSpendAccount[], bound: TaskSpendProvider["bound"] = "approx", floor: TaskSpendProvider["floor"] = null): TaskSpendProvider => {
  const weeklyPp = accounts.reduce((sum, a) => sum + (a.weeklyPp ?? 0), 0);
  const tokens = accounts.reduce((sum, a) => sum + a.tokens, 0);
  return { engine, bound, floor, accounts, weeklyPp, tokens, basis: bound === "tokens" ? null : "measured",
    range: bound === "tokens" ? null : { low: weeklyPp * 0.7, high: weeklyPp * 1.3 }, budgets: [], outsideBudget: false,
    apiUsd: tokens / 10e6, apiPricedTokens: tokens, unpricedModels: [], unpricedTokens: 0, issues: [] };
};

const TASKS: Record<string, TaskSpendSummary> = {
  two: { providers: [
    provider("claude", [account("claude:a", "A", "max", 2.1, 132e6, 53, 12), account("claude:b", "B", "max", 1, 61e6, 31)]),
    provider("codex", [account("codex:a", "A", "pro", 1.2, 24e6, 47), account("codex:b", "B", "pro", 0.4, 9e6, 22)]),
  ] },
  large: { providers: [
    provider("claude", [account("claude:a", "A", "max", 12.4, 610e6, 66, 12)], "floor", "before-counting"),
    provider("codex", [account("codex:a", "A", "pro", 21.3, 402e6, 74), account("codex:d", "D", "pro", 12.9, 250e6, 40)]),
  ] },
  norate: { providers: [
    { ...provider("claude", [account("unknown", "unknown", null, null, 41e6, null)], "tokens"), issues: ["planMissing"] },
    provider("codex", [account("codex:a", "A", "pro", 1, 21e6, 47)]),
  ] },
  single: { providers: [provider("codex", [{ ...account("codex:a", "Workstation", "pro", 1.4, 45e6, 61), range: { low: 1, high: 1.8 }, budget: { low: 900, mid: 1600, high: 2300, grade: "inferred" } }])] },
  counting: { providers: [] },
  noFixedLimit: { providers: [
    { ...provider("claude", [account("claude:enterprise", "C", "enterprise", null, 100e6, null)], "tokens"), issues: ["noFixedLimit"] },
  ] },
  unpriced: { providers: [
    { ...provider("claude", [], "tokens"), tokens: 100e6, apiUsd: null, unpricedTokens: 100e6, unpricedModels: ["fixture-model"] },
  ] },
  partial: { providers: [
    { ...provider("claude", [{ ...account("claude:history", "History", "max", 1.2, 200e6, null),
      apiUsd: 10, apiPricedTokens: 100e6, basis: "plan", range: { low: 0.8, high: 2 },
      budget: { low: 900, mid: 1600, high: 2300, grade: "measured" } }], "approx"),
      tokens: 200e6, apiUsd: 10, apiPricedTokens: 100e6, weeklyPp: 1.2,
      basis: "plan", range: { low: 0.8, high: 2 }, budgets: [{ low: 900, mid: 1600, high: 2300, grade: "measured" }],
      unpricedTokens: 100e6, unpricedModels: ["fixture-model"], issues: ["historicalPriceCoverage"] },
  ] },
  /* Lower bounds just under a band's edge: the scale fills by the floored figure. */
  floor46: { providers: [provider("claude", [account("claude:a", "A", "max", 4.6, 200e6, 50)], "floor", "before-counting")] },
  floor146: { providers: [provider("claude", [account("claude:a", "A", "max", 14.6, 600e6, 60)], "floor", "before-counting")] },
  long: { providers: [provider("claude", [account("claude:a", "Research workstation in the second office, shared by the whole data team on site", "max", 2, 90e6, 40)])] },
  tiny: { providers: [provider("claude", [account("claude:a", "A", "max", 0.3, 17e6, null, 0.3)])] },
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
  expect(marks(host, "norate")).toEqual([["claude", "tokens", null], ["codex", "num", 1]]);
  /* Still being counted: nothing at all. */
  expect(host.querySelector("[data-spend='counting']")).toBeNull();
  for (const id of ["two", "large"]) expect(/\d/.test(host.querySelector(`[data-spend='${id}']`)!.textContent!)).toBe(false);
  expect(host.querySelector("[data-spend='large'] .scale-floor")).toBeNull();
  expect(host.querySelector("[data-spend='norate'] .spend-n")!.textContent).toBe("41m");
  expect(host.querySelector("[data-spend='large']")!.getAttribute("aria-label")).toBe("Task usage: Claude 610m tokens, Codex 652m tokens");
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

test("a lower bound's scale fills from the displayed estimate", async () => {
  const host = await mount(<><TaskSpendMarks taskId="floor46" interactive /><TaskSpendMarks taskId="floor146" interactive /></>);
  expect(marks(host, "floor46")).toEqual([["claude", "floor", 1]]);
  expect(marks(host, "floor146")).toEqual([["claude", "floor", 2]]);
  expect((await open("floor46")).textContent).toContain("≥4.6% of week");
  expect((await open("floor146")).textContent).toContain("≥14.6% of week");
});

test("the compact card popover shows a separate estimate for each subscription", async () => {
  await mount(<><TaskSpendMarks taskId="long" interactive /><PhoneTaskSpend taskId="long" headingClass="h" /></>);
  const pop = await open("long");
  expect(pop.textContent).toContain("Research workstation");
  expect(pop.textContent).toContain("≈2% of week");
  expect(pop.querySelectorAll(".pop-row")).toHaveLength(1);
});

test("a screen reader reaches the popover's lines: the open marks are described by the bubble", async () => {
  await mount(<TaskSpendMarks taskId="two" interactive />);
  const trigger = document.querySelector<HTMLElement>("[data-spend='two']")!;
  expect(trigger.hasAttribute("aria-describedby")).toBe(false);
  await open("two");
  const described = document.getElementById(trigger.getAttribute("aria-describedby")!)!;
  expect(described.getAttribute("role")).toBe("tooltip");
  const text = described.textContent!;
  for (const line of ["193m tokens", "33m tokens", "±30%"] ) expect(text).toContain(line);
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

test("the compact popover marks estimates and shows one total token line", async () => {
  await mount(<TaskSpendMarks taskId="two" interactive />);
  const pop = await open("two");
  expect(pop).not.toBeNull();
  const text = pop.textContent!;
  expect(text).toContain("≈2.1% of week");
  expect(text).toContain("≈1% of week");
  expect(text).toContain("≈1.2% of week");
  expect(pop.querySelectorAll(".pop-row")).toHaveLength(2);
  /* The total sits in the title, once, with no footer row. */
  expect(pop.querySelector(".pop-title")!.textContent).toBe("Task usage · 226m tokens");
  expect(pop.querySelector(".pop-note")).toBeNull();
  expect(pop.textContent).not.toContain("Now 12%");
  const trigger = document.querySelector<HTMLElement>("[data-spend='two']")!;
  await act(async () => trigger.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
  expect(document.querySelector("[data-spend-pop='two']")).toBeNull();
});

test("small weekly shares keep a decimal on desktop and phone, and their range rounds to the same decimal", async () => {
  await mount(<><TaskSpendMarks taskId="tiny" interactive /><PhoneTaskSpend taskId="tiny" headingClass="h" /></>);
  const pop = await open("tiny");
  expect(pop.textContent).toContain("≈0.3% of week (0.2–0.4%)");
  let phone = document.querySelector("[data-phone-task-spend='tiny']")!.textContent!;
  expect(phone).toContain("≈0.3% of week (0.2–0.4%)");
  expect(phone).not.toContain("5-hour");
  setLocale("uk");
  await mount(<><TaskSpendMarks taskId="tiny" interactive /><PhoneTaskSpend taskId="tiny" headingClass="h" /></>);
  expect((await open("tiny")).textContent).toContain("≈0,3% тижня (0,2–0,4%)");
  phone = document.querySelector("[data-phone-task-spend='tiny']")!.textContent!;
  expect(phone).not.toContain("5 годин");
});

test("a lower bound and an unreported plan have distinct explanations in Ukrainian", async () => {
  await mount(<PhoneTaskSpend taskId="norate" headingClass="h" />);
  const englishPhone = document.querySelector('[data-phone-task-spend="norate"] [data-spend-provider="claude"]')!.textContent!;
  expect(englishPhone).toContain("Claude 41m tokens");
  expect(englishPhone).toContain("A reported account plan is needed to estimate the share");
  /* One account without a share adds nothing to its provider's line. */
  expect(englishPhone).not.toContain("Unattributed account");
  expect(englishPhone).not.toMatch(/of week|%/);
  setLocale("uk");
  await mount(<><TaskSpendMarks taskId="large" interactive /><PhoneTaskSpend taskId="large" headingClass="h" />
    <TaskSpendMarks taskId="norate" interactive /><PhoneTaskSpend taskId="norate" headingClass="h" /></>);
  const large = await open("large");
  expect(large.textContent).toContain("≥12,4% тижня");
  expect(large.querySelector("[data-spend-provider='claude'] [data-spend-account]")!.textContent).not.toMatch(/≈|\(/);
  expect(large.querySelector(".pop-warn")!.textContent).toContain("Нижня межа: роботу до початку обліку не пораховано");
  const phone = document.querySelector("[data-phone-task-spend='large']")!.textContent!;
  expect(phone).toContain("≥12,4% тижня");
  expect(phone).not.toContain("5 годин");
  const norate = await open("norate");
  const claude = norate.querySelector("[data-spend-provider='claude']")!;
  expect(claude.textContent!.replace(/\s/g, " ")).toContain("Claude 41 млн токенів");
  expect(claude.textContent).toContain("Для оцінки частки потрібен план акаунта");
  expect(claude.textContent).not.toMatch(/невідом|unknown/);
  expect(/%/.test(claude.textContent!)).toBe(false);
  expect(claude.querySelector(".pop-row")!.textContent).toContain("за цінами API");
  const ukrainianPhone = document.querySelector('[data-phone-task-spend="norate"] [data-spend-provider="claude"]')!.textContent!;
  expect(ukrainianPhone).not.toContain("Акаунт не визначено");
  expect(ukrainianPhone).not.toMatch(/тижн|%/);
});

test("a member who is not the owner sees each provider's share and basis and no account", async () => {
  guest = true;
  await mount(<><TaskSpendMarks taskId="two" interactive /><PhoneTaskSpend taskId="two" headingClass="h" /></>);
  const pop = await open("two");
  expect(pop.querySelectorAll(".pop-row").length).toBe(2);
  expect(pop.querySelector("[data-spend-account]")).toBeNull();
  expect(pop.textContent).not.toContain("account week");
  expect(pop.textContent).toContain("Claude 193m tokens");
  expect(pop.textContent).toContain("Codex 33m tokens");
  /* Every provider whose face draws cells prints its share, its range and its basis. */
  expect(pop.querySelector("[data-spend-provider='claude'] .pop-basis")!.textContent).toBe("≈3.1% of week (2.2–4%) · Estimate from 7-day usage rate (±30%)");
  expect(pop.querySelector("[data-spend-provider='codex'] .pop-basis")!.textContent).toBe("≈1.6% of week (1.1–2.1%) · Estimate from 7-day usage rate (±30%)");
  expect(pop.querySelector(".pop-title")!.textContent).toBe("Task usage · 226m tokens");
  const phone = document.querySelector("[data-phone-task-spend='two']")!;
  expect(phone.querySelector("[data-spend-account]")).toBeNull();
  expect([...phone.querySelectorAll(".pop-basis")].map((line) => line.textContent)).toEqual([...pop.querySelectorAll(".pop-basis")].map((line) => line.textContent));
});

test("each figure prints once per provider, with no pricing assumption on the card", async () => {
  await mount(<><TaskSpendMarks taskId="two" interactive /><TaskSpendMarks taskId="single" interactive /><PhoneTaskSpend taskId="single" headingClass="h" /></>);
  for (const text of [(await open("single")).textContent!, document.querySelector("[data-phone-task-spend='single']")!.textContent!]) {
    expect(text.match(/45m tokens/g)).toHaveLength(1);
    expect(text.match(/≈\$/g)).toHaveLength(1);
    expect(text.match(/Estimate/g)).toHaveLength(1);
    expect(text).toContain("Workstation · Pro · ≈1.4% of week (1–1.8%)");
    expect(text).not.toMatch(/cache|30m|account week/);
  }
  /* Several accounts of one provider give each its own dollars and share, and Codex's line carries no cache note. */
  const two = (await open("two")).textContent!;
  expect(two).not.toMatch(/cache|30m/);
  expect(two).toContain("A · Max · ≈2.1% of week (1.5–2.7%) · ≈$13");
  expect(two).toContain("B · Max · ≈1% of week (0.7–1.3%) · ≈$6.1");
});

test("the phone's face is passive, and its task screen lists the numbers; a refused read draws nothing", async () => {
  const host = await mount(<><TaskSpendMarks taskId="two" interactive={false} /><PhoneTaskSpend taskId="two" headingClass="h" /></>);
  const face = host.querySelector("[data-spend='two']")!;
  expect(face.getAttribute("role")).toBeNull();
  expect(face.getAttribute("aria-hidden")).toBe("true");
  expect(host.querySelector("[data-phone-task-spend='two'] h2")!.textContent).toBe("Task usage");
  expect(host.querySelectorAll("[data-phone-task-spend='two'] .pop-row").length).toBe(2);

  for (const root of roots.splice(0)) act(() => root.unmount());
  resetTaskSpend();
  refuse = true;
  const refused = await mount(<TaskSpendMarks taskId="two" interactive />);
  expect(refused.querySelector("[data-spend]")).toBeNull();
});

test("unpriced models and plans without a fixed limit keep the tokens and explain the missing estimate", async () => {
  await mount(<><TaskSpendMarks taskId="noFixedLimit" interactive /><TaskSpendMarks taskId="unpriced" interactive /><TaskSpendMarks taskId="partial" interactive /></>);
  const noLimit = (await open("noFixedLimit")).textContent!;
  expect(noLimit).toContain("100m tokens");
  expect(noLimit).toContain("plan has no fixed limit");
  expect(noLimit).toContain("≈$10 at API prices");
  /* With no price at all the provider's line says so once, with the model, and nothing repeats it. */
  const unpriced = (await open("unpriced")).textContent!;
  expect(unpriced).toContain("Claude 100m tokens · No API price (fixture-model)");
  expect(unpriced.match(/100m tokens/g)).toHaveLength(1);
  expect(unpriced).not.toMatch(/API price unavailable|No API price for/);
  /* Tokens with no share say why, once, and a model id stays whole. */
  expect(unpriced).toContain("No share: the model has no price to weigh it");
  expect(document.querySelectorAll("[data-spend-pop='unpriced'] [data-spend-reason]")).toHaveLength(1);
  expect(document.querySelector("[data-spend-pop='unpriced'] .model-id")!.textContent).toBe("fixture-model");
  const partial = (await open("partial")).textContent!;
  expect(partial).toContain("≈1.2% of week (0.8–2%)");
  expect(partial).toContain("Plan week ≈$900–$2,300 at API prices (measured)");
  expect(partial).toContain("≈$10 at API prices for priced tokens");
  expect(partial).toContain("No API price for 100m tokens (fixture-model)");
  expect(partial).toContain("Some expired tokens lack a separable API price history");
  for (const text of [noLimit, unpriced, partial]) {
    expect(text).not.toMatch(/unknown|≥/);
  }
});
