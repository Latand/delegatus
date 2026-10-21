import { afterEach, expect, test } from "bun:test";
import { act, useEffect } from "react";
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

const DecisionColumn = await import("./DecisionColumn");
const { DecisionList, DecisionStripLine } = DecisionColumn;
const { DecisionPointer, decisionPointerOf, setDecisionRecordPollForTests } = await import("./DecisionPointer");
const { openOperatorDecisions, resetDecisionSurfacesForTests, useDecisionSheet, useDecisionSurface } = await import("./decisionSurface");
const { resetDecisionDraftsForTests, reloadDecisionDraftsForTests } = await import("@/components/prototypeReview/decisionDrafts");
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
  resetDecisionDraftsForTests();
  resetPrototypeReviewStoreForTests();
  setDecisionRecordPollForTests(null);
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

test("rejecting variants in a decision form requires corrections and keeps the rejected draft after a refused write", async () => {
  const posts: unknown[] = [];
  let refuse = true;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(refuse ? { error: "try again" } : { project: "project-a", decisions: [] }), { status: refuse ? 409 : 200 });
  }) as typeof fetch;
  const host = await render(<DecisionList project="project-a" initial={[taskDecision()]} />);
  await click(host.querySelector("[data-decision-reject]"));
  expect(host.querySelector<HTMLButtonElement>("[data-decision-send]")!.disabled).toBe(true);
  const field = host.querySelector<HTMLTextAreaElement>("[data-decision-comment]")!;
  const props = (field as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[Object.keys(field).find(key => key.startsWith("__reactProps$"))!]!;
  await act(async () => { props.onChange({ target: { value: "Simplify every frame." } }); });
  await click(host.querySelector("[data-decision-send]"));
  expect(host.querySelector("[data-decision-error]")?.textContent).toContain("try again");
  expect(host.querySelector("[data-decision-reject]")?.getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector<HTMLTextAreaElement>("[data-decision-comment]")!.value).toBe("Simplify every frame.");
  refuse = false;
  await click(host.querySelector("[data-decision-send]"));
  expect(posts).toHaveLength(2);
  expect(posts[0]).toEqual(posts[1]);
  expect(posts[1]).toMatchObject({ reject: true, chosen: [], comment: "Simplify every frame." });
});

test("a refusal under the button is brought into the visible area of its scroller", async () => {
  const shown: unknown[] = [];
  const proto = (globalThis as unknown as { Element: { prototype: { scrollIntoView?: unknown } } }).Element.prototype;
  const before = proto.scrollIntoView;
  proto.scrollIntoView = function (this: Element, options: unknown) { shown.push([this.hasAttribute("data-decision-error"), options]); };
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "try again" }), { status: 409 })) as unknown as typeof fetch;
    const host = await render(<DecisionList project="project-a" initial={[taskDecision()]} />);
    await click(host.querySelector("[data-decision-reject]"));
    const field = host.querySelector<HTMLTextAreaElement>("[data-decision-comment]")!;
    const props = (field as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[Object.keys(field).find(key => key.startsWith("__reactProps$"))!]!;
    await act(async () => { props.onChange({ target: { value: "Simplify every frame." } }); });
    shown.length = 0;
    await click(host.querySelector("[data-decision-send]"));
    expect(host.querySelector("[data-decision-error]")).not.toBeNull();
    expect(shown).toContainEqual([true, { block: "nearest" }]);
  } finally { proto.scrollIntoView = before; }
});

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

for (const touch of [false, true]) {
  test(`a seat's round with prototypes opens its full frames in the viewer over the form, and the form keeps its draft${touch ? " (phone)" : ""}`, async () => {
    const seatRound = seatDecision({ variants: taskDecision().variants.map((variant, at) => ({ ...variant, frames: [{ image: media(String(at + 1), `/api/image?prototype=seat&media=${at + 1}`), caption: "Wide" }] })) });
    const host = await render(<DecisionList project="project-a" initial={[seatRound]} touch={touch} />);
    const card = host.querySelector(`[data-decision-card="open"][data-decision-review="${SEAT}"]`)!;
    expect(card.querySelectorAll("[data-decision-thumb-open]")).toHaveLength(2);
    expect(card.querySelectorAll("[data-decision-open-prototypes]")).toHaveLength(touch ? 0 : 1);
    await click(card.querySelector('[data-prototype-option="when:1"]'));
    await click(card.querySelector('[data-decision-thumb-open="2"]'));
    const viewer = host.ownerDocument.body.querySelector('[role="dialog"][aria-modal="true"]')!;
    expect(viewer).not.toBeNull();
    expect(viewer.getAttribute("aria-label")).toBe("2 · Summary — Wide");
    expect(viewer.querySelector('img[src="/api/image?prototype=seat&media=2"]')).not.toBeNull();
    expect(viewer.querySelector("[data-lightbox-position]")?.textContent).toBe("2 / 2");
    await click(viewer.querySelector('[data-lightbox-step="previous"]'));
    expect(host.ownerDocument.body.querySelector('[role="dialog"][aria-modal="true"]')!.getAttribute("aria-label")).toBe("1 · List — Wide");
    await click(host.ownerDocument.body.querySelector(`[role="dialog"][aria-modal="true"] button[aria-label="Close"]`));
    expect(host.ownerDocument.body.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
    const form = host.querySelector(`[data-decision-card="open"][data-decision-review="${SEAT}"]`)!;
    expect(form.querySelector('[data-prototype-option="when:1"]')!.getAttribute("aria-checked")).toBe("true");
    if (!touch) {
      await click(form.querySelector("[data-decision-open-prototypes]"));
      expect(host.ownerDocument.body.querySelector('[role="dialog"][aria-modal="true"]')!.getAttribute("aria-label")).toBe("1 · List — Wide");
    }
  });
}

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

/** What the operator typed into the comment, through the field's own change handler. */
async function typeComment(host: HTMLElement, value: string) {
  const field = host.querySelector<HTMLTextAreaElement>("[data-decision-comment]")!;
  const props = (field as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[Object.keys(field).find((key) => key.startsWith("__reactProps$"))!]!;
  await act(async () => { props.onChange({ target: { value } }); });
}
const checked = (host: HTMLElement, selector: string) => host.querySelector(selector)?.getAttribute("aria-checked");

for (const refusal of ["409", "network"] as const) {
  test(`a ${refusal} refusal that lands after the form left brings it back as the operator left it, and the second press sends the same answer`, async () => {
    const posts: unknown[] = [];
    let release: (() => void) | null = null;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      /* The refusal waits past React's next render, so the form is gone when it lands. */
      await new Promise<void>((resolve) => { release = resolve; });
      if (refusal === "network") throw new TypeError("network down");
      return new Response(JSON.stringify({ error: "the seat is busy" }), { status: 409 });
    }) as typeof fetch;
    const host = await render(<DecisionList project="project-a" initial={[seatDecision()]} />);
    await click(host.querySelector('[data-prototype-option="when:1"]'));
    await click(host.querySelector('[data-prototype-other="why"]'));
    await typeComment(host, "After the batch");
    await click(host.querySelector("[data-decision-send]"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.querySelector(`[data-decision-review="${SEAT}"]`)).toBeNull();
    await act(async () => { release!(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.querySelector(`[data-decision-card="open"][data-decision-review="${SEAT}"]`)).not.toBeNull();
    expect(checked(host, '[data-prototype-option="when:1"]')).toBe("true");
    expect(checked(host, '[data-prototype-option="when:0"]')).toBe("false");
    expect(checked(host, '[data-prototype-other="why"]')).toBe("true");
    expect(host.querySelector<HTMLTextAreaElement>("[data-decision-comment]")!.value).toBe("After the batch");
    expect(host.querySelector("[data-decision-error]")?.textContent).toContain(refusal === "network" ? "network down" : "the seat is busy");
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ project: "project-a", decisions: [] }), { status: 200 });
    }) as typeof fetch;
    await click(host.querySelector("[data-decision-send]"));
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(posts[0]).toEqual({ project: "project-a", reviewId: SEAT, chosen: [], comment: "After the batch", answers: [{ questionId: "when", options: [1] }, { questionId: "why", options: [], other: true }] });
    expect(host.querySelector("[data-decision-list-empty]")).not.toBeNull();
  });
}

const KEY = (id: string) => `llv.prototypeReview.draft:${id}`;
const stored = (id: string) => dom.localStorage.getItem(KEY(id));

test("a refused answer survives a reload: the form comes back from this browser's storage with the choice and the exact words", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "prototype review is unavailable" }), { status: 503 })) as unknown as typeof fetch;
  let host = await render(<DecisionList project="project-a" initial={[seatDecision()]} />);
  await click(host.querySelector('[data-prototype-option="when:1"]'));
  await click(host.querySelector('[data-prototype-other="why"]'));
  await typeComment(host, "  After the\nbatch ");
  await click(host.querySelector("[data-decision-send]"));
  expect(host.querySelector("[data-decision-error]")?.textContent).toContain("prototype review is unavailable");
  expect(JSON.parse(stored(SEAT)!)).toMatchObject({ comment: "  After the\nbatch ", taskId: null, project: "project-a" });
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  /* A new page: module memory is gone, storage stays. */
  reloadDecisionDraftsForTests();
  host = await render(<DecisionList project="project-a" initial={[seatDecision()]} />);
  expect(host.querySelector<HTMLTextAreaElement>("[data-decision-comment]")!.value).toBe("  After the\nbatch ");
  expect(checked(host, '[data-prototype-option="when:1"]')).toBe("true");
  expect(checked(host, '[data-prototype-other="why"]')).toBe("true");
  expect(host.querySelector("[data-decision-error]")).toBeNull();
});

test("words typed in the open form survive opening another row and coming back, with no press on «Відповісти»", async () => {
  const host = await render(<DecisionList project="project-a" initial={[seatDecision(), taskDecision()]} />);
  await click(host.querySelector('[data-prototype-option="when:1"]'));
  await typeComment(host, "Not before CI.");
  await click(host.querySelector(`[data-decision-row="${TASK}"]`));
  expect(host.querySelector(`[data-decision-card="open"][data-decision-review="${TASK}"]`)).not.toBeNull();
  expect(host.querySelector(`[data-decision-row="${SEAT}"]`)).not.toBeNull();
  /* The task's own form starts clean: the seat's words are not applied to another round. */
  expect(host.querySelector<HTMLTextAreaElement>("[data-decision-comment]")!.value).toBe("");
  expect(checked(host, '[data-prototype-option="variant:0"]')).toBe("true");
  await click(host.querySelector(`[data-decision-row="${SEAT}"]`));
  expect(host.querySelector<HTMLTextAreaElement>("[data-decision-comment]")!.value).toBe("Not before CI.");
  expect(checked(host, '[data-prototype-option="when:1"]')).toBe("true");
});

const LATE = `pr_${"c".repeat(32)}`;
const lateDecision = () => seatDecision({ id: LATE, title: "Which account tonight?", createdAt: "2026-10-11T15:05:00.000Z" });
const listed = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-decision-row], [data-decision-card]")].map((node) => node.dataset.decisionRow ?? node.dataset.decisionReview);

test("the newest decision is listed first and stands open; the read's oldest-first order and equal times are turned over", () => {
  const { newestDecisionsFirst } = DecisionColumn;
  const early = taskDecision(); const late = seatDecision();
  expect(newestDecisionsFirst([early, late]).map((decision) => decision.id)).toEqual([SEAT, TASK]);
  expect(newestDecisionsFirst([late, early]).map((decision) => decision.id)).toEqual([SEAT, TASK]);
  const twin = seatDecision({ id: LATE, createdAt: late.createdAt });
  expect(newestDecisionsFirst([early, late, twin]).map((decision) => decision.id)).toEqual([LATE, SEAT, TASK]);
  /* The two clocks the server writes compare as moments, whatever their spelling. */
  expect(newestDecisionsFirst([seatDecision({ createdAt: "2026-10-11T14:42:00Z" }), lateDecision()]).map((decision) => decision.id)).toEqual([LATE, SEAT]);
});

for (const touch of [false, true]) test(`the column and the phone's sheet list the newest first and open it when nothing is picked${touch ? " (phone)" : ""}`, async () => {
  const host = await render(<DecisionList project="project-a" touch={touch} initial={[taskDecision(), seatDecision(), lateDecision()]} />);
  expect(listed(host)).toEqual([LATE, SEAT, TASK]);
  expect(host.querySelector('[data-decision-card="open"]')?.getAttribute("data-decision-review")).toBe(LATE);
  expect(host.querySelector("[data-decision-list]")?.getAttribute("data-decision-expanded")).toBe(LATE);
});

test("the open form's header folds it back to its row, answers nothing, keeps its words, and the row opens it again", async () => {
  const posts: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { posts.push(init?.body ?? null); return new Response("{}", { status: 500 }); }) as typeof fetch;
  const host = await render(<DecisionList project="project-a" initial={[seatDecision(), taskDecision()]} />);
  await click(host.querySelector('[data-prototype-option="when:1"]'));
  await typeComment(host, "Not before CI.");
  const fold = host.querySelector<HTMLButtonElement>(`[data-decision-review="${SEAT}"] header > [data-decision-collapse]`)!;
  expect(fold.tagName).toBe("BUTTON");
  expect(fold.getAttribute("type")).toBe("button");
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(fold.getAttribute("aria-label")).toBe("Collapse «Deploy tonight?»");
  expect(fold.querySelector("[data-decision-title]")?.textContent).toBe("Deploy tonight?");
  await click(fold);
  expect(host.querySelector("[data-decision-card]")).toBeNull();
  expect(listed(host)).toEqual([SEAT, TASK]);
  expect(host.querySelector("[data-decision-list]")?.getAttribute("data-decision-expanded")).toBe("");
  const row = host.querySelector<HTMLElement>(`[data-decision-row="${SEAT}"]`)!;
  expect(row.getAttribute("aria-expanded")).toBe("false");
  /* The keyboard stays on the decision it folded. */
  expect(dom.document.activeElement as unknown).toBe(row);
  expect(posts).toEqual([]);
  await click(row);
  const back = host.querySelector(`[data-decision-card="open"][data-decision-review="${SEAT}"]`)!;
  expect(back).not.toBeNull();
  expect(dom.document.activeElement as unknown).toBe(back.querySelector("[data-decision-collapse]"));
  expect(host.querySelector<HTMLTextAreaElement>("[data-decision-comment]")!.value).toBe("Not before CI.");
  expect(checked(host, '[data-prototype-option="when:1"]')).toBe("true");
  expect(posts).toEqual([]);
});

test("a folded column stays folded while reads add and keep decisions, until the operator opens one", async () => {
  let decisions = [taskDecision(), seatDecision()];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") throw new Error("folding never answers");
    return new Response(JSON.stringify({ project: "project-a", decisions }), { status: 200 });
  }) as typeof fetch;
  const read = async () => { await act(async () => { window.dispatchEvent(new dom.Event("llv:tasks-changed") as unknown as Event); await new Promise((resolve) => setTimeout(resolve, 10)); }); };
  const host = await render(<DecisionList project="project-a" />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(host.querySelector('[data-decision-card="open"]')?.getAttribute("data-decision-review")).toBe(SEAT);
  await click(host.querySelector(`[data-decision-review="${SEAT}"] [data-decision-collapse]`));
  decisions = [taskDecision(), seatDecision(), lateDecision()];
  await read();
  expect(listed(host)).toEqual([LATE, SEAT, TASK]);
  expect(host.querySelector("[data-decision-card]")).toBeNull();
  await click(host.querySelector(`[data-decision-row="${TASK}"]`));
  expect(host.querySelector('[data-decision-card="open"]')?.getAttribute("data-decision-review")).toBe(TASK);
});

test("a newer decision read while the default form is being answered lists first as a row; the form stays open and focused until it leaves", async () => {
  let decisions = [seatDecision()];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") throw new Error("a read never answers");
    return new Response(JSON.stringify({ project: "project-a", decisions }), { status: 200 });
  }) as typeof fetch;
  const read = async () => { await act(async () => { window.dispatchEvent(new dom.Event("llv:tasks-changed") as unknown as Event); await new Promise((resolve) => setTimeout(resolve, 10)); }); };
  const host = await render(<DecisionList project="project-a" />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(host.querySelector('[data-decision-card="open"]')?.getAttribute("data-decision-review")).toBe(SEAT);
  await typeComment(host, "Not before CI.");
  const field = host.querySelector<HTMLTextAreaElement>("[data-decision-comment]")!;
  field.focus();
  expect(dom.document.activeElement as unknown).toBe(field);
  decisions = [seatDecision(), lateDecision()];
  await read();
  expect(listed(host)).toEqual([LATE, SEAT]);
  expect(host.querySelector(`[data-decision-row="${LATE}"]`)).not.toBeNull();
  expect(host.querySelector('[data-decision-card="open"]')?.getAttribute("data-decision-review")).toBe(SEAT);
  expect(field.isConnected).toBe(true);
  expect(field.value).toBe("Not before CI.");
  expect(dom.document.activeElement as unknown).toBe(field);
  /* A form the operator opened from its row holds the same way. */
  decisions = [taskDecision(), seatDecision(), lateDecision()];
  await read();
  await click(host.querySelector(`[data-decision-row="${TASK}"]`));
  decisions = [taskDecision(), seatDecision(), lateDecision(), seatDecision({ id: `pr_${"f".repeat(32)}`, createdAt: "2026-10-11T15:30:00.000Z" })];
  await read();
  expect(host.querySelector('[data-decision-card="open"]')?.getAttribute("data-decision-review")).toBe(TASK);
  /* Once the shown form leaves the read, the newest opens. */
  decisions = [seatDecision(), lateDecision(), seatDecision({ id: `pr_${"f".repeat(32)}`, createdAt: "2026-10-11T15:30:00.000Z" })];
  await read();
  expect(host.querySelector('[data-decision-card="open"]')?.getAttribute("data-decision-review")).toBe(`pr_${"f".repeat(32)}`);
});

test("a request for a form opens it again after the operator folded the column", async () => {
  const draw = (focus: { reviewId?: string; nonce: number } | null) => <DecisionList project="project-a" focus={focus} initial={[seatDecision(), taskDecision(), lateDecision()]} />;
  const host = await render(draw({ reviewId: TASK, nonce: 1 }));
  expect(host.querySelector('[data-decision-card="open"]')?.getAttribute("data-decision-review")).toBe(TASK);
  await click(host.querySelector(`[data-decision-review="${TASK}"] [data-decision-collapse]`));
  expect(host.querySelector("[data-decision-card]")).toBeNull();
  /* The same request drawn again is not a new one. */
  await act(async () => root!.render(draw({ reviewId: TASK, nonce: 1 })));
  expect(host.querySelector("[data-decision-card]")).toBeNull();
  await act(async () => root!.render(draw({ reviewId: TASK, nonce: 2 })));
  expect(host.querySelector('[data-decision-card="open"]')?.getAttribute("data-decision-review")).toBe(TASK);
  await click(host.querySelector(`[data-decision-review="${TASK}"] [data-decision-collapse]`));
  await act(async () => root!.render(draw({ reviewId: SEAT, nonce: 3 })));
  expect(host.querySelector('[data-decision-card="open"]')?.getAttribute("data-decision-review")).toBe(SEAT);
});

test("an answer's record in the column folds to its row as well; the feed's record has nothing to fold", async () => {
  const held = seatDecision({ decision: { chosen: [], comment: "Keep the recommendation.", answers: [{ questionId: "when", options: [0] }, { questionId: "why", options: [0] }], at: "2026-10-16T08:00:00Z", delivery: { state: "failed", retryable: true } } });
  globalThis.fetch = (async () => new Response(JSON.stringify({ project: "project-a", decisions: [] }))) as unknown as typeof fetch;
  const host = await render(<DecisionList project="project-a" initial={[held]} />);
  const fold = host.querySelector('[data-decision-card="answered"] header > [data-decision-collapse]')!;
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(fold.getAttribute("aria-label")).toBe("Collapse «Deploy tonight?»");
  await click(fold);
  expect(host.querySelector("[data-decision-card]")).toBeNull();
  expect(host.querySelector(`[data-decision-row="${SEAT}"] [data-decision-delivery="failed"]`)).not.toBeNull();
  await click(host.querySelector(`[data-decision-row="${SEAT}"]`));
  expect(host.querySelector('[data-decision-card="answered"]')).not.toBeNull();
  const { DecisionRecord } = await import("./DecisionCard");
  await act(async () => root!.render(<DecisionRecord decision={held} />));
  expect(host.querySelector('[data-decision-card="answered"]')).not.toBeNull();
  expect(host.querySelector("[data-decision-collapse]")).toBeNull();
});

test("a form unmounted before «Відповісти» comes back from storage, and a form left as it opened stores nothing", async () => {
  let host = await render(<DecisionList project="project-a" initial={[seatDecision()]} />);
  expect(stored(SEAT)).toBeNull();
  await typeComment(host, "Later.");
  expect(stored(SEAT)).not.toBeNull();
  await typeComment(host, "");
  expect(stored(SEAT)).toBeNull();
  await typeComment(host, "Later.");
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  host = await render(<DecisionList project="project-a" initial={[seatDecision()]} />);
  expect(host.querySelector<HTMLTextAreaElement>("[data-decision-comment]")!.value).toBe("Later.");
});

test("a saved answer removes the stored draft, and the same round opens clean next time", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ project: "project-a", decisions: [] }), { status: 200 })) as unknown as typeof fetch;
  const host = await render(<DecisionList project="project-a" initial={[seatDecision()]} />);
  await typeComment(host, "Go ahead.");
  expect(stored(SEAT)).not.toBeNull();
  await click(host.querySelector("[data-decision-send]"));
  expect(host.querySelector("[data-decision-list-empty]")).not.toBeNull();
  expect(stored(SEAT)).toBeNull();
});

test("a stored draft whose questions do not match the round falls back to the recommended answers and keeps the words", async () => {
  dom.localStorage.setItem(KEY(SEAT), JSON.stringify({ v: 1, reviewId: SEAT, taskId: null, project: "project-a", updatedAt: Date.now(), reject: false, chosen: [], comment: "Old words",
    answers: [{ questionId: "another", options: [1] }, { questionId: "why", options: [1] }] }));
  const host = await render(<DecisionList project="project-a" initial={[seatDecision()]} />);
  expect(checked(host, '[data-prototype-option="when:0"]')).toBe("true");
  expect(checked(host, '[data-prototype-option="why:0"]')).toBe("true");
  expect(host.querySelector<HTMLTextAreaElement>("[data-decision-comment]")!.value).toBe("Old words");
});

test("a read that shows the seat's round gone drops its draft; a failed read never does", async () => {
  dom.localStorage.setItem(KEY(SEAT), JSON.stringify({ v: 1, reviewId: SEAT, taskId: null, project: "project-a", updatedAt: Date.now(), reject: false, chosen: [], comment: "Words", answers: [{ questionId: "when", options: [1] }, { questionId: "why", options: [0] }] }));
  let mode: "down" | "gone" | "waiting" = "down";
  globalThis.fetch = (async () => {
    if (mode === "down") return new Response(JSON.stringify({ error: "prototype review is unavailable" }), { status: 503 });
    return new Response(JSON.stringify({ project: "project-a", decisions: mode === "waiting" ? [seatDecision()] : [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const read = async () => { await act(async () => { window.dispatchEvent(new dom.Event("llv:tasks-changed") as unknown as Event); await new Promise((resolve) => setTimeout(resolve, 10)); }); };
  await render(<DecisionList project="project-a" />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(stored(SEAT)).not.toBeNull();
  mode = "waiting"; await read();
  expect(stored(SEAT)).not.toBeNull();
  mode = "down"; await read();
  expect(stored(SEAT)).not.toBeNull();
  mode = "gone"; await read();
  expect(stored(SEAT)).toBeNull();
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
    const opened = useDecisionSheet();
    useEffect(() => { sheet = opened; });
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

for (const state of ["failed", "uncertain", "no-orchestrator"] as const) {
  test(`a ${state} answer's record sends the saved answer again from the feed, once, and the action leaves once it is delivered`, async () => {
    const answered = (delivery: { state: "sent" | typeof state; retryable: boolean }) => seatDecision({ decision: { chosen: [], answers: [{ questionId: "when", options: [1] }, { questionId: "why", options: [0] }], comment: "", at: "2026-10-11T14:46:00.000Z", delivery } });
    let round = answered({ state, retryable: true });
    const calls: Array<{ url: string; body?: unknown }> = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (init?.method === "POST") {
        round = answered({ state: "sent", retryable: false });
        return new Response(JSON.stringify({ project: "project-a", decisions: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ project: "project-a", decisions: [], round }), { status: 200 });
    }) as typeof fetch;
    const host = await render(<DecisionPointer target={{ reviewId: SEAT, project: "project-a", title: "Deploy tonight?" }} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.querySelector(`[data-decision-delivery="${state}"]`)).not.toBeNull();
    const retry = host.querySelectorAll("[data-decision-retry]");
    expect(retry).toHaveLength(1);
    expect(retry[0]!.textContent).toBe(state === "no-orchestrator" ? "Send now" : "Send again");
    await click(retry[0]!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(calls.filter((call) => call.body)).toEqual([{ url: "/api/projects/decisions", body: { project: "project-a", reviewId: SEAT, retry: true } }]);
    expect(host.querySelector('[data-decision-delivery="sent"]')).not.toBeNull();
    expect(host.querySelector("[data-decision-retry]")).toBeNull();
  });
}

const settle = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const recordAt = (state: "pending" | "uncertain" | "failed" | "no-orchestrator" | "sent") => seatDecision({ decision: { chosen: [], answers: [{ questionId: "when", options: [0] }, { questionId: "why", options: [0] }], comment: "", at: "2026-10-11T14:46:00.000Z", delivery: { state, retryable: state !== "sent" } } });

for (const [name, answers] of [
  ["a failed answer that the worker recovers", [{ state: "failed" }, { state: "uncertain" }, { state: "sent" }]],
  ["an answer waiting for a seat that the worker finds", [{ state: "no-orchestrator" }, { state: "pending" }, { state: "sent" }]],
  ["a pending answer that turns uncertain", [{ state: "pending" }, { state: "uncertain" }, { state: "sent" }]],
  ["a read the server could not answer, or one that never arrived,", [{ status: 503 }, { thrown: true }, { status: 409 }, { state: "sent" }]],
] as const) {
  test(`${name} keeps the record reading until the receipt says sent, and the retry leaves without a second send`, async () => {
    setDecisionRecordPollForTests(1);
    const calls: Array<{ method: string }> = [];
    let at = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET" });
      const answer: { state?: "pending" | "uncertain" | "failed" | "no-orchestrator" | "sent"; status?: number; thrown?: true } = answers[Math.min(at++, answers.length - 1)]!;
      if (answer.thrown) throw new TypeError("offline");
      if (answer.status) return new Response(JSON.stringify({ error: "prototype decision is busy" }), { status: answer.status });
      return new Response(JSON.stringify({ project: "project-a", decisions: [], round: recordAt(answer.state!) }), { status: 200 });
    }) as typeof fetch;
    const host = await render(<DecisionPointer target={{ reviewId: SEAT, project: "project-a", title: "Deploy tonight?" }} />);
    for (let wait = 0; wait < 40 && !host.querySelector('[data-decision-delivery="sent"]'); wait++) await settle(5);
    expect(host.querySelector('[data-decision-delivery="sent"]')).not.toBeNull();
    expect(host.querySelector("[data-decision-retry]")).toBeNull();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls).toHaveLength(answers.length);
    await settle(20);
    expect(calls).toHaveLength(answers.length);
  });
}

test("an uncertain answer offers the retry while the record keeps reading", async () => {
  setDecisionRecordPollForTests(1);
  let reads = 0;
  globalThis.fetch = (async () => { reads++; return new Response(JSON.stringify({ project: "project-a", decisions: [], round: recordAt("uncertain") }), { status: 200 }); }) as unknown as typeof fetch;
  const host = await render(<DecisionPointer target={{ reviewId: SEAT, project: "project-a", title: "Deploy tonight?" }} />);
  await settle(30);
  expect(host.querySelector('[data-decision-delivery="uncertain"]')).not.toBeNull();
  expect(host.querySelector("[data-decision-retry]")).not.toBeNull();
  expect(reads).toBeGreaterThan(2);
});

test("a read refused for good stops reading", async () => {
  setDecisionRecordPollForTests(1);
  let reads = 0;
  globalThis.fetch = (async () => { reads++; return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }); }) as unknown as typeof fetch;
  await render(<DecisionPointer target={{ reviewId: SEAT, project: "project-a", title: "Deploy tonight?" }} />);
  await settle(30);
  expect(reads).toBe(1);
});

test("a refused retry says why and keeps the action", async () => {
  const round = seatDecision({ decision: { chosen: [], answers: [{ questionId: "when", options: [0] }, { questionId: "why", options: [0] }], comment: "", at: "2026-10-11T14:46:00.000Z", delivery: { state: "failed", retryable: true } } });
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => init?.method === "POST"
    ? new Response(JSON.stringify({ error: "prototype decision is busy" }), { status: 409 })
    : new Response(JSON.stringify({ project: "project-a", decisions: [], round }), { status: 200 })) as typeof fetch;
  const host = await render(<DecisionPointer target={{ reviewId: SEAT, project: "project-a", title: "Deploy tonight?" }} />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await click(host.querySelector("[data-decision-retry]"));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(host.querySelector("[data-decision-retry-error]")?.textContent).toContain("prototype decision is busy");
  expect(host.querySelector("[data-decision-retry]")).not.toBeNull();
});


test("an undelivered notice keeps the feed's saved answer and follows background recovery", async () => {
  setDecisionRecordPollForTests(1);
  publishPrototypeNotices([{ id: `prototype-delivery:${TASK}`, project: "project-a", taskId: "task-1", reviewId: TASK, title: "Self-update window", undelivered: true,
    createdAt: "2026-10-11T14:46:00.000Z", target: { kind: "prototype-review", taskId: "task-1", reviewId: TASK } }]);
  let state: "failed" | "sent" = "failed";
  const methods: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    const round = { ...recordAt(state), id: TASK, taskId: "task-1", taskTitle: "Self-update window" };
    return new Response(JSON.stringify({ project: "project-a", decisions: [], round }), { status: 200 });
  }) as typeof fetch;
  const host = await render(<DecisionPointer target={{ reviewId: TASK, project: "project-a", title: "Deploy tonight?" }} />);
  await settle(5);
  expect(host.querySelector('[data-decision-card="answered"]')).not.toBeNull();
  expect(host.querySelector("[data-decision-retry]")).not.toBeNull();
  expect(host.querySelector("[data-decision-pointer-open]")).toBeNull();
  state = "sent";
  for (let wait = 0; wait < 40 && !host.querySelector('[data-decision-delivery="sent"]'); wait++) await settle(5);
  expect(host.querySelector('[data-decision-delivery="sent"]')).not.toBeNull();
  expect(host.querySelector("[data-decision-retry]")).toBeNull();
  expect(methods.every(method => method === "GET")).toBe(true);
  const settled = methods.length;
  await settle(20);
  expect(methods).toHaveLength(settled);
});

test("the inline card submits a skipped question and its feed record reads Skipped", async () => {
  const posts: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); posts.push(body);
    return new Response(JSON.stringify({ project: "project-a", decisions: [] }), { status: 200 });
  }) as typeof fetch;
  const host = await render(<DecisionList project="project-a" initial={[seatDecision()]} />);
  await click(host.querySelector('[data-prototype-question-skip="why"]'));
  await click(host.querySelector("[data-decision-send]"));
  const answers = [{ questionId: "when", options: [0] }, { questionId: "why", options: [], skipped: true as const }];
  expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ answers });
  await act(async () => root!.unmount()); root = null;
  const { DecisionRecord } = await import("./DecisionCard");
  const record = await render(<DecisionRecord decision={seatDecision({ decision: { chosen: [], answers, comment: "", at: "2026-10-11T14:46:00.000Z", delivery: { state: "sent", retryable: false } } })} />);
  expect(record.querySelector('[data-decision-record-skipped="why"]')?.textContent).toBe("Skipped");
});

for (const touch of [false, true]) test(`a native association can be revoked in the existing ${touch ? "phone" : "desktop"} decision list and retries a refused write`, async () => {
  const active = seatDecision({ nativeAssociationState: "approved", title: "Approve external Claude session", source: { conversationId: null },
    questions: ["identity", "evidence"].map(id => ({ id, text: id, options: [{ label: "Refuse", recommended: true }, { label: "Approve" }] })),
    decision: { chosen: [], answers: ["identity", "evidence"].map(questionId => ({ questionId, options: [1] })), comment: "", at: "2026-10-15T09:00:00Z", delivery: { state: "no-orchestrator", retryable: true } } });
  const posts: unknown[] = []; let refuse = true;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(refuse ? { error: "association store busy" } : { project: "project-a", decisions: [] }), { status: refuse ? 409 : 200 });
  }) as typeof fetch;
  const host = await render(<DecisionList project="project-a" touch={touch} initial={[active]} />);
  expect(host.textContent).toContain("Access approved"); expect(host.textContent).not.toContain("waiting for an orchestrator");
  await click(host.querySelector("[data-native-association-revoke]"));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("association store busy");
  expect(host.querySelector("[data-native-association-revoke]")).not.toBeNull();
  refuse = false; await click(host.querySelector("[data-native-association-revoke]"));
  expect(host.querySelector("[data-native-association-revoke]")).toBeNull();
  const expected = { project: "project-a", reviewId: SEAT, chosen: [], comment: "", answers: [{ questionId: "identity", options: [0] }, { questionId: "evidence", options: [0] }] };
  expect(posts).toEqual([expected, expected]);
});


test("C: an undelivered answer is shown as a record and retry uses the saved answer", async () => {
  const held = seatDecision({ decision: { chosen: [], comment: "Keep the recommendation.", answers: [{ questionId: "when", options: [0] }, { questionId: "why", options: [0] }], at: "2026-10-16T08:00:00Z", delivery: { state: "pending", phase: "attention", retryable: true } } });
  const posts: unknown[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") posts.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ project: "project-a", decisions: [] }));
  }) as typeof fetch;
  const host = await render(<DecisionList project="project-a" initial={[held]} />);
  expect(host.querySelector('[data-decision-card="answered"]')).not.toBeNull();
  expect(host.querySelector("[data-decision-send]")).toBeNull();
  expect(host.textContent).toContain("Keep the recommendation.");
  expect(host.querySelector("[data-decision-delivery]")?.textContent).toContain("not delivered");
  await click(host.querySelector("[data-decision-retry]"));
  expect(posts).toEqual([{ project: "project-a", reviewId: SEAT, retry: true }]);
});

/* Audit B13/B14: a decided record's Retry and Revoke stay in place and draw their result at once. */
function heldPosts(answer: () => Response, read?: () => Response) {
  const posts: unknown[] = [];
  let release: () => void = () => {};
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method !== "POST") return read ? read() : new Response(JSON.stringify({ project: "project-a", decisions: [] }), { status: 200 });
    posts.push(JSON.parse(String(init.body)));
    await new Promise<void>((resolve) => { release = resolve; });
    return answer();
  }) as typeof fetch;
  return { posts, release: () => act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 0)); }) };
}
const failedRecord = () => seatDecision({ decision: { chosen: [], answers: [{ questionId: "when", options: [0] }, { questionId: "why", options: [0] }], comment: "", at: "2026-10-11T14:46:00.000Z", delivery: { state: "failed", retryable: true } } });

test("the column's Retry keeps the record in place as sending while the request is held, sends once, and a refusal restores it with the reason", async () => {
  const server = heldPosts(() => new Response(JSON.stringify({ error: "prototype decision is busy" }), { status: 409 }));
  const host = await render(<DecisionList project="project-a" initial={[failedRecord()]} />);
  await click(host.querySelector("[data-decision-retry]"));
  expect(host.querySelector('[data-decision-card="answered"]')).not.toBeNull();
  expect(host.querySelector("[data-decision-delivery]")?.getAttribute("data-decision-delivery")).toBe("pending");
  expect(host.querySelector("[data-decision-retry]")).toBeNull();
  await server.release();
  expect(server.posts).toEqual([{ project: "project-a", reviewId: SEAT, retry: true }]);
  expect(host.querySelector("[data-decision-delivery]")?.getAttribute("data-decision-delivery")).toBe("failed");
  expect(host.querySelector("[data-decision-retry]")).not.toBeNull();
  expect(host.querySelector("[data-decision-retry-error]")?.textContent).toContain("prototype decision is busy");
  expect(host.textContent).not.toContain("Access could not be revoked");
});

test("the column's Revoke reads as refused at once and a refusal brings the approval and its button back with the reason", async () => {
  const active = seatDecision({ nativeAssociationState: "approved", source: { conversationId: null },
    decision: { chosen: [], answers: [{ questionId: "when", options: [1] }, { questionId: "why", options: [1] }], comment: "", at: "2026-10-15T09:00:00Z", delivery: { state: "no-orchestrator", retryable: true } } });
  const server = heldPosts(() => new Response(JSON.stringify({ error: "association store busy" }), { status: 409 }));
  const host = await render(<DecisionList project="project-a" initial={[active]} />);
  await click(host.querySelector("[data-native-association-revoke]"));
  expect(host.textContent).toContain("Access refused");
  expect(host.querySelector("[data-native-association-revoke]")).toBeNull();
  await server.release();
  expect(server.posts).toHaveLength(1);
  expect(host.textContent).toContain("Access approved");
  expect(host.querySelector("[data-native-association-revoke]")).not.toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("association store busy");
  expect(host.querySelector("[data-decision-retry-error]")).toBeNull();
});

test("the pointer's Retry draws the message on its way at once, sends once, and a refusal restores the record with the reason", async () => {
  const round = failedRecord();
  const server = heldPosts(() => new Response(JSON.stringify({ error: "prototype decision is busy" }), { status: 409 }),
    () => new Response(JSON.stringify({ project: "project-a", decisions: [], round }), { status: 200 }));
  const host = await render(<DecisionPointer target={{ reviewId: SEAT, project: "project-a", title: "Deploy tonight?" }} />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await click(host.querySelector("[data-decision-retry]"));
  expect(host.querySelector("[data-decision-delivery]")?.getAttribute("data-decision-delivery")).toBe("pending");
  expect(host.querySelector("[data-decision-retry]")).toBeNull();
  await server.release();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(server.posts).toHaveLength(1);
  expect(host.querySelector("[data-decision-delivery]")?.getAttribute("data-decision-delivery")).toBe("failed");
  expect(host.querySelector("[data-decision-retry-error]")?.textContent).toContain("prototype decision is busy");
});
