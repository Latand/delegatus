import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { TaskNote, TaskSummary } from "@/lib/tasks/types";

import { noteShownBesideSummary, TaskSummaryPanel } from "./TaskSummaryPanel";

/*
 * The task's «Summary» panel (variant 3 «Панеллю», 2026-10-26): its writer
 * and time, a headline, the text and what is left; nothing while nobody
 * wrote one. An agent note older than the summary steps aside.
 */

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event, localStorage: dom.localStorage });

const NOW = Date.parse("2026-10-24T13:30:00Z");
const deployLane = { id: "p-deploy", stages: [{ id: "deploy", kind: "run", role: { roleId: "deployer" }, next: null, onFail: null }], runs: [] } as unknown as Pipeline;
const summary = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  headline: "Експорт CSV витримує великі проєкти",
  text: "Файл пишеться потоком частинами по 5 000 рядків. 80 тис. рядків проходять за 6 с.",
  author: { kind: "stage", pipelineId: "p-deploy", stageId: "deploy", attempt: 1, conversationId: null },
  updatedAt: "2026-10-24T12:07:00Z",
  ...over,
});

let mounted: Root | null = null;
afterEach(() => {
  if (mounted) flushSync(() => mounted!.unmount());
  mounted = null;
  document.body.innerHTML = "";
  setLocale("en");
});

function render(node: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  flushSync(() => mounted!.render(node));
  return host;
}
const text = (host: HTMLElement, selector: string) => host.querySelector(selector)?.textContent ?? null;

test("nothing renders while no summary was written", () => {
  const host = render(<TaskSummaryPanel pipelines={[deployLane]} nowMs={NOW} />);
  expect(host.innerHTML).toBe("");
});

test("a stage's summary names the stage and its time, the headline, the text and what is left", () => {
  setLocale("uk");
  const host = render(<TaskSummaryPanel summary={summary({ left: "нічого обов’язкового" })} pipelines={[deployLane]} nowMs={NOW} />);
  expect(host.querySelector("section[data-task-summary]")?.getAttribute("aria-label")).toBe("Підсумок");
  expect(text(host, ".chronology-head")).toBe("Підсумок");
  expect(text(host, "[data-task-summary-by]")).toMatch(/^від Deploy · \d{2}:\d{2}$/);
  expect(text(host, "[data-task-summary-headline]")).toBe("Експорт CSV витримує великі проєкти");
  expect(text(host, "[data-task-summary-text]")).toBe("Файл пишеться потоком частинами по 5 000 рядків. 80 тис. рядків проходять за 6 с.");
  expect(text(host, "[data-task-summary-left]")).toBe("Лишилось нічого обов’язкового");
});

test("without «left» there is no left line; a lane off the board, the orchestrator and the operator read as their own writers", () => {
  setLocale("uk");
  const offBoard = render(<TaskSummaryPanel summary={summary()} pipelines={[]} nowMs={NOW} />);
  expect(offBoard.querySelector("[data-task-summary-left]")).toBeNull();
  expect(text(offBoard, "[data-task-summary-by]")).toMatch(/^від агента · /);
  flushSync(() => mounted!.render(<TaskSummaryPanel summary={summary({ author: { kind: "orchestrator", conversationId: "c" } })} pipelines={[]} nowMs={NOW} />));
  expect(text(offBoard, "[data-task-summary-by]")).toMatch(/^від оркестратора · /);
  flushSync(() => mounted!.render(<TaskSummaryPanel summary={summary({ author: { kind: "operator" } })} pipelines={[]} nowMs={NOW} />));
  expect(text(offBoard, "[data-task-summary-by]")).toMatch(/^від вас · /);
  setLocale("en");
  flushSync(() => mounted!.render(<TaskSummaryPanel summary={summary({ author: { kind: "orchestrator" } })} pipelines={[]} nowMs={NOW} />));
  expect(text(offBoard, "[data-task-summary-by]")).toMatch(/^by the orchestrator · /);
});

test("a summary from an earlier day carries its date as well as its time", () => {
  const host = render(<TaskSummaryPanel summary={summary({ updatedAt: "2026-10-20T09:00:00Z" })} pipelines={[deployLane]} nowMs={NOW} />);
  expect(text(host, "[data-task-summary-by]")).not.toMatch(/^by Deploy · \d{2}:\d{2}$/);
  expect(text(host, "[data-task-summary-by]")).toMatch(/^by Deploy · /);
});

test("an agent note older than the summary steps aside; a newer one, or one with no summary, still shows", () => {
  const note = (updatedAt: string): TaskNote => ({ text: "Розгорнуто 2.14.1", author: { kind: "agent", conversationId: null }, updatedAt });
  const older = note("2026-10-24T12:00:00Z");
  const same = note("2026-10-24T12:07:00Z");
  const newer = note("2026-10-24T12:30:00Z");
  expect(noteShownBesideSummary(older, summary())).toBeUndefined();
  expect(noteShownBesideSummary(same, summary())).toBeUndefined();
  expect(noteShownBesideSummary(newer, summary())).toBe(newer);
  expect(noteShownBesideSummary(older, undefined)).toBe(older);
  expect(noteShownBesideSummary(undefined, summary())).toBeUndefined();
});
