import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import type { OperatorDecisionView, PrototypeReviewNotice } from "@/lib/prototypeReview/types";
import type { ToolEvent } from "@/components/feed/parse";

const dom = new Window({ url: "http://localhost/" });
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  MouseEvent: dom.MouseEvent,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MutationObserver: dom.MutationObserver,
  localStorage: dom.localStorage,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (run: FrameRequestCallback) => setTimeout(() => run(0), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

const { DecisionList, DecisionStripLine } = await import("./DecisionColumn");
const { DecisionPointer, decisionPointerOf } = await import("./DecisionPointer");
const { openOperatorDecisions, resetDecisionSurfacesForTests, useDecisionSheet, useDecisionSurface } = await import("./decisionSurface");
const { publishPrototypeNotices, resetPrototypeReviewStoreForTests } = await import("@/components/prototypeReview/prototypeReviewStore");

const SEAT = `pr_${"a".repeat(32)}`;
const TASK = `pr_${"b".repeat(32)}`;
const media = (id: string, url: string | null) => ({ id: id.repeat(64), mime: "image/png" as const, bytes: 8, available: url !== null, url });
function seatDecision(extra: Partial<OperatorDecisionView> = {}): OperatorDecisionView {
  return { id: SEAT, title: "Deploy tonight?", taskId: null, project: "project-a", createdAt: "2026-10-11T14:42:00.000Z", source: { conversationId: "conversation_seat" }, variants: [],
    questions: [
      { id: "when", text: "When do we deploy?", options: [{ label: "Now", recommended: true }, { label: "Tonight" }] },
      { id: "why", text: "Anything else?", other: true, options: [{ label: "No", recommended: true }, { label: "Wait for CI" }] },
    ], ...extra };
}
function taskDecision(): OperatorDecisionView {
  return { id: TASK, title: "Update window", taskId: "task-1", taskTitle: "Self-update window", project: "project-a", createdAt: "2026-10-11T14:20:00.000Z", source: { conversationId: "conversation_lane" },
    variants: [{ number: 1, name: "List", description: "By project.", frames: [{ image: media("1", "/api/image?taskId=task-1&prototype=x&media=1"), caption: "" }], videos: [] },
      { number: 2, name: "Summary", description: "Short.", frames: [{ image: media("2", null), caption: "" }], videos: [] }],
    questions: [{ id: "variant", text: "Which variant?", options: [{ label: "1 — List", recommended: true }, { label: "2 — Summary" }] }] };
}

let root: Root | null = null;
const realFetch = globalThis.fetch;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  globalThis.fetch = realFetch;
  resetDecisionSurfacesForTests();
  resetPrototypeReviewStoreForTests();
  dom.document.body.innerHTML = "";
});
async function render(node: React.ReactNode) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
  await act(async () => root!.render(node));
  return host as unknown as HTMLElement;
}
const click = async (element: Element | null) => { expect(element).not.toBeNull(); await act(async () => (element as HTMLElement).click()); };

test("one decision stands open as its form with the recommended answers chosen; one click and «Відповісти» answer it, and it leaves the column", async () => {
  const posts: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ project: "project-a", decisions: [taskDecision()] }), { status: 200 });
  }) as typeof fetch;
  const host = await render(<DecisionList project="project-a" initial={[seatDecision(), taskDecision()]} />);
  const card = host.querySelector(`[data-decision-card="open"][data-decision-review="${SEAT}"]`)!;
  expect(card).not.toBeNull();
  expect(host.querySelector(`[data-decision-row="${TASK}"]`)).not.toBeNull();
  expect(card.querySelector('[data-prototype-option="when:0"]')!.getAttribute("aria-checked")).toBe("true");
  expect(card.querySelector('[data-prototype-option="why:0"]')!.getAttribute("aria-checked")).toBe("true");
  await click(card.querySelector('[data-prototype-option="when:1"]'));
  expect(card.querySelector('[data-prototype-option="when:1"]')!.getAttribute("aria-checked")).toBe("true");
  await click(card.querySelector("[data-decision-send]"));
  expect(posts).toEqual([{ project: "project-a", reviewId: SEAT, chosen: [], comment: "", answers: [{ questionId: "when", options: [1] }, { questionId: "why", options: [0] }] }]);
  expect(host.querySelector(`[data-decision-review="${SEAT}"]`)).toBeNull();
  /* The next decision opens as the form, with its numbered frames. */
  const next = host.querySelector(`[data-decision-card="open"][data-decision-review="${TASK}"]`)!;
  expect(next.querySelector('[data-decision-thumb="1"]')).not.toBeNull();
  expect(next.querySelectorAll("[data-decision-thumbs] figure")).toHaveLength(2);
});

test("«Інше» asks for the comment before the answer can go, and a refusal brings the form back with the reason", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "the seat is busy" }), { status: 409 })) as unknown as typeof fetch;
  const host = await render(<DecisionList project="project-a" initial={[seatDecision()]} />);
  await click(host.querySelector('[data-prototype-other="why"]'));
  const send = host.querySelector<HTMLButtonElement>("[data-decision-send]")!;
  expect(send.disabled).toBe(true);
  const field = host.querySelector<HTMLTextAreaElement>("[data-decision-comment]")!;
  /* happy-dom's textarea does not feed React's value tracker, so the field's
     own change handler is called with what the operator typed. */
  const props = (field as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[Object.keys(field).find((key) => key.startsWith("__reactProps$"))!]!;
  await act(async () => { props.onChange({ target: { value: "After the batch" } }); });
  expect(send.disabled).toBe(false);
  await click(send);
  expect(host.querySelector(`[data-decision-review="${SEAT}"]`)).not.toBeNull();
  expect(host.querySelector("[data-decision-error]")?.textContent).toContain("the seat is busy");
});

test("an empty column says nothing waits", async () => {
  const host = await render(<DecisionList project="project-a" initial={[]} />);
  expect(host.querySelector("[data-decision-list-empty]")).not.toBeNull();
});

test("the strip line counts the waiting decisions and is absent with none", async () => {
  let opened = 0;
  const host = await render(<><DecisionStripLine count={3} onOpen={() => opened++} /><DecisionStripLine count={0} onOpen={() => opened++} /></>);
  expect(host.querySelectorAll("[data-decision-strip]")).toHaveLength(1);
  await click(host.querySelector('[data-decision-strip="3"]'));
  expect(opened).toBe(1);
});

test("a request opens the project's column where one stands, else the sheet", async () => {
  const seen: unknown[] = [];
  let sheet: unknown = null;
  function Panel({ active }: { active: boolean }) {
    useDecisionSurface("project-a", active, (request) => seen.push(request));
    sheet = useDecisionSheet();
    return null;
  }
  await render(<Panel active />);
  await act(async () => openOperatorDecisions({ project: "project-a", reviewId: SEAT }));
  expect(seen).toEqual([{ project: "project-a", reviewId: SEAT }]);
  expect(sheet).toBeNull();
  await act(async () => openOperatorDecisions({ project: "project-b" }));
  expect(sheet).toEqual({ project: "project-b" });
});

function publishCall(result: Record<string, unknown> | null, status: ToolEvent["status"] = "ok"): ToolEvent {
  return { kind: "tool", id: "call", ts: "2026-10-11T14:42:00.000Z", srcCall: 0, family: "mcp", tool: "mcp__viewer__publish_prototype_review", icon: "plug", summary: "", chips: [], status, statusLabel: "", outputPreview: "", outputTruncated: false, open: false,
    mcp: { serverName: "viewer", toolName: "publish_prototype_review", args: { title: "Deploy tonight?" }, result } } as unknown as ToolEvent;
}

test("the seat's publication draws a pointer only when its result names the round and the project", () => {
  expect(decisionPointerOf(publishCall({ reviewId: SEAT, taskId: null, project: "project-a" }))).toEqual({ reviewId: SEAT, project: "project-a", title: "Deploy tonight?" });
  expect(decisionPointerOf(publishCall({ reviewId: SEAT, taskId: null }))).toBeNull();
  expect(decisionPointerOf(publishCall({ error: "refused" }, "err"))).toBeNull();
  expect(decisionPointerOf(publishCall(null))).toBeNull();
});

test("the pointer points at the column while the decision waits, and becomes the answer's record once answered", async () => {
  const notice: PrototypeReviewNotice = { id: `prototype:${SEAT}`, project: "project-a", taskId: null, reviewId: SEAT, title: "Deploy tonight?", asks: "questions", createdAt: "2026-10-11T14:42:00.000Z", target: { kind: "seat-decision", project: "project-a", reviewId: SEAT } };
  publishPrototypeNotices([notice]);
  const reads: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    reads.push(String(url));
    return new Response(JSON.stringify({ project: "project-a", decisions: [], round: seatDecision({ decision: { chosen: [], answers: [{ questionId: "when", options: [1] }, { questionId: "why", options: [], other: true }], comment: "After the batch", at: "2026-10-11T14:46:00.000Z", delivery: { state: "sent", retryable: false } } }) }), { status: 200 });
  }) as typeof fetch;
  const opened: unknown[] = [];
  function Seat() { useDecisionSurface("project-a", true, (request) => opened.push(request)); return null; }
  const host = await render(<><Seat /><DecisionPointer target={{ reviewId: SEAT, project: "project-a", title: "Deploy tonight?" }} /></>);
  expect(reads).toEqual([]);
  await click(host.querySelector("[data-decision-pointer-open]"));
  expect(opened).toEqual([{ project: "project-a", reviewId: SEAT }]);
  await act(async () => { publishPrototypeNotices([]); await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(reads).toEqual([`/api/projects/decisions?project=project-a&review=${SEAT}`]);
  const record = host.querySelector('[data-decision-card="answered"]')!;
  expect(record).not.toBeNull();
  expect(record.querySelector('[data-decision-delivery="sent"]')).not.toBeNull();
  expect(record.textContent).toContain("Tonight");
  expect(record.querySelector("[data-decision-record-comment]")?.textContent).toBe("After the batch");
});
