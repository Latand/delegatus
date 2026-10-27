import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";

import { pastAttempts } from "./pipelineGraph";
import { TaskChronology } from "./TaskChronology";
import { taskChronology } from "./taskChronologyModel";

/*
 * The timeline's result lines and answer links (variant 3 «Панеллю»,
 * 2026-10-26): a stage's line under its entry, and an entry that answers
 * another names it as a link beside its open button, never inside it; the
 * link opens the «Earlier · N» fold when its target is under it, and focuses
 * the target.
 */

const dom = new Window();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event, localStorage: dom.localStorage,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
});

const T0 = Date.parse("2026-10-24T08:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const run = (n: number, start: number, end: number, extra: Record<string, unknown> = {}) => ({
  n, state: "passed", startedAt: at(start), completedAt: at(end), error: null, verdict: { status: "pass", findings: [] }, report: null,
  agentPath: `/fixture/${n}-${start}.jsonl`, conversationId: `conversation_${n}_${start}`, flowId: null, ...extra,
});
const RESULT = "Повтор продовжує з останньої підтвердженої частини";

/* Lane A: a review that fails, and the fix that answers it, finished long
   after; lane B's eight stages pass between them, so the review falls under the fold. */
const laneA = {
  id: "a", task: "Lane A", taskIds: ["t"], project: "p", state: "completed", createdAt: at(0), closedAt: null, stateDetail: null, cursor: null,
  stages: [{ id: "review", kind: "run", role: { roleId: "reviewer" }, next: null, onFail: { to: "fix", maxRounds: 2 } }, { id: "fix", kind: "run", role: { roleId: "builder" }, next: "review", onFail: null }],
  runs: [
    { stageId: "review", attempts: [run(1, 1, 5, { state: "failed", verdict: { status: "fail", findings: ["P1 — one"] }, report: { verdict: { status: "fail", findings: ["P1 — one"] }, result: "Три зауваження" } })] },
    { stageId: "fix", attempts: [run(1, 6, 100, { activatedBy: { stageId: "review", attempt: 1, edge: "fail" }, report: { verdict: { status: "pass", findings: [] }, result: RESULT } })] },
  ],
} as unknown as Pipeline;
const laneB = {
  id: "b", task: "Lane B", taskIds: ["t"], project: "p", state: "completed", createdAt: at(2), closedAt: null, stateDetail: null, cursor: null,
  stages: Array.from({ length: 8 }, (_, index) => ({ id: `step-${index + 1}`, kind: "run", next: null, onFail: null })),
  runs: Array.from({ length: 8 }, (_, index) => ({ stageId: `step-${index + 1}`, attempts: [run(1, 10 + index * 10, 15 + index * 10)] })),
} as unknown as Pipeline;
const PIPELINES = [laneA, laneB];
const ENTRIES = taskChronology({ taskCreatedAt: at(-1), pipelines: PIPELINES, past: pastAttempts(PIPELINES, new Map()), cleared: [], seatConversationIds: [] });

let mounted: Root | null = null;
afterEach(() => {
  if (mounted) flushSync(() => mounted!.unmount());
  mounted = null;
  document.body.innerHTML = "";
  setLocale("en");
});

function render(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  flushSync(() => mounted!.render(<TaskChronology entries={ENTRIES} pipelines={PIPELINES} nowMs={T0 + 200 * 60_000} onOpen={() => undefined} />));
  return host;
}
const entry = (host: HTMLElement, key: string) => [...host.querySelectorAll<HTMLElement>("[data-chronology-entry]")].find((element) => element.dataset.chronologyEntry === key) ?? null;
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("an answering entry carries the rule, the reason with its link beside the open button, and its result, lowercased after the colon in uk", () => {
  setLocale("uk");
  const host = render();
  const fix = entry(host, "a:fix:attempt:1")!;
  expect(fix.classList.contains("answers")).toBe(true);
  const line = fix.querySelector("[data-chronology-result]")!;
  expect(line.textContent).toBe(`Відповідь на Review: ${RESULT[0]!.toLowerCase()}${RESULT.slice(1)}`);
  /* The link is a sibling of the open button, never inside it. */
  const link = fix.querySelector<HTMLButtonElement>("[data-chronology-answers]")!;
  expect(link.textContent).toBe("Review");
  expect(link.getAttribute("aria-label")).toBe("Перейти до Review у хронології");
  expect(link.closest(".chronology-open")).toBeNull();
  expect(fix.querySelector(".chronology-open")?.textContent).toBe("Fix: пройдено");
  /* An entry with no result line and no answer is drawn as before. */
  const step = entry(host, "b:step-8:attempt:1")!;
  expect(step.querySelector("[data-chronology-result]")).toBeNull();
  expect(step.classList.contains("answers")).toBe(false);
});

test("in en the result keeps its capital after the reason", () => {
  const host = render();
  expect(entry(host, "a:fix:attempt:1")!.querySelector("[data-chronology-result]")!.textContent).toBe(`Answers Review: ${RESULT}`);
});

test("the link opens the fold over its target, brings it to the middle, focuses its open button and marks it until focus leaves", async () => {
  const scrolled: { key: string | undefined; options: unknown }[] = [];
  const original = dom.HTMLElement.prototype.scrollIntoView;
  dom.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, options?: unknown) { scrolled.push({ key: this.dataset.chronologyEntry, options }); } as typeof original;
  try {
    const host = render();
    const section = host.querySelector<HTMLElement>("section.chronology")!;
    expect(Number(section.dataset.chronologyHidden)).toBeGreaterThan(0);
    expect(entry(host, "a:review:attempt:1")).toBeNull();
    const link = host.querySelector<HTMLButtonElement>("[data-chronology-answers]")!;
    link.click();
    await settle();
    expect(section.dataset.chronologyHidden).toBe("0");
    const review = entry(host, "a:review:attempt:1")!;
    expect(review.querySelector("[data-chronology-result]")?.textContent).toBe("Три зауваження");
    expect(document.activeElement).toBe(review.querySelector(".chronology-open"));
    expect(scrolled).toEqual([{ key: "a:review:attempt:1", options: { block: "center", inline: "nearest" } }]);
    expect(review.hasAttribute("data-chronology-landed")).toBe(true);
    expect(review.classList.contains("landed")).toBe(true);
    expect(host.querySelectorAll("[data-chronology-landed]").length).toBe(1);
    /* Focus moves on: the mark goes with it. */
    flushSync(() => link.focus());
    expect(host.querySelectorAll("[data-chronology-landed]").length).toBe(0);
    expect(review.classList.contains("landed")).toBe(false);
  } finally { dom.HTMLElement.prototype.scrollIntoView = original; }
});
