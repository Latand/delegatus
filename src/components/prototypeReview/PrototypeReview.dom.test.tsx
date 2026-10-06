import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import type { DictationPhase, UseDictationOptions } from "@/hooks/useDictation";
import type { PrototypeReviewRead } from "@/lib/prototypeReview/types";

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

/* The real dictation hook with its phase held where a case puts it: a
   recording needs a microphone this DOM has none of. With no phase held the
   hook answers as it does everywhere else. */
const realDictation = { ...await import("@/hooks/useDictation") };
let heldPhase: DictationPhase | null = null;
let dictationOptions: UseDictationOptions | null = null;
mock.module("@/hooks/useDictation", () => ({
  ...realDictation,
  useDictation: (options: UseDictationOptions) => {
    dictationOptions = options;
    const held = realDictation.useDictation(options);
    return heldPhase ? { ...held, phase: heldPhase } : held;
  },
}));

const { PrototypeReview } = await import("./PrototypeReview");

const media = (id: string) => ({ id: id.repeat(64), mime: "image/png" as const, bytes: 8, available: false, url: null });
const variant = (number: number, name: string) => ({ number, name, description: `${name} layout.`, frames: [{ image: media(String(number)), caption: "Board" }], videos: [] });
function reviewRead(decision?: { chosen: number[]; comment: string }): PrototypeReviewRead {
  return { taskId: "task-1", waitingReviewId: decision ? null : `pr_${"a".repeat(32)}`, rounds: [{
    id: `pr_${"a".repeat(32)}`, title: "Layout", taskId: "task-1", project: "project-a", createdAt: "2026-10-06T10:00:00.000Z", source: { conversationId: null },
    variants: [variant(1, "Compact"), variant(2, "Roomy")],
    ...(decision ? { decision: { ...decision, at: "2026-10-06T11:00:00.000Z", delivery: { state: "sent" as const, retryable: false } } } : {}),
  }] };
}

let root: Root | null = null;
const realFetch = globalThis.fetch;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  heldPhase = null;
  globalThis.fetch = realFetch;
  dom.document.body.innerHTML = "";
});

test("the comment is saved as it was written: edge spaces and line breaks reach the save request", async () => {
  const written = "  Keep the spacing.\nAdd a button.  \n";
  const posted: Array<{ reviewId: string; chosen: number[]; comment: string }> = [];
  let saved: { chosen: number[]; comment: string } | undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      saved = { chosen: body.chosen, comment: body.comment };
    }
    return new Response(JSON.stringify(reviewRead(saved)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  root = createRoot(host);
  await act(async () => { root!.render(<PrototypeReview taskId="task-1" reviewId={null} taskTitle="Layout task" onClose={() => {}} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => { document.querySelector<HTMLElement>('[data-prototype-choose="2"]')!.click(); });
  const field = document.querySelector<HTMLTextAreaElement>("[data-prototype-comment-field]")!;
  expect(field).not.toBeNull();
  /* happy-dom's textarea does not feed React's value tracker, so the field's
     own change handler is called with what the operator typed. */
  const props = (field as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[Object.keys(field).find((key) => key.startsWith("__reactProps$"))!]!;
  await act(async () => { props.onChange({ target: { value: written } }); });
  expect(field.value).toBe(written);
  await act(async () => { document.querySelector<HTMLElement>("[data-prototype-save]")!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(posted).toEqual([{ reviewId: `pr_${"a".repeat(32)}`, chosen: [2], comment: written }]);
  expect(document.querySelector("[data-prototype-comment]")?.textContent).toBe(written);
});

test("nothing saves while speech is recorded or transcribed, by the button or by Ctrl+Enter; afterwards the whole comment saves once", async () => {
  const posted: Array<{ reviewId: string; chosen: number[]; comment: string }> = [];
  let saved: { chosen: number[]; comment: string } | undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      saved = { chosen: body.chosen, comment: body.comment };
    }
    return new Response(JSON.stringify(reviewRead(saved)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  root = createRoot(host);
  await act(async () => { root!.render(<PrototypeReview taskId="task-1" reviewId={null} taskTitle="Layout task" onClose={() => {}} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => { document.querySelector<HTMLElement>('[data-prototype-choose="1"]')!.click(); });
  type FieldProps = { onChange: (event: { target: { value: string } }) => void; onKeyDown: (event: { key: string; ctrlKey: boolean; metaKey: boolean; preventDefault: () => void }) => void };
  const fieldProps = () => {
    const field = document.querySelector<HTMLTextAreaElement>("[data-prototype-comment-field]")!;
    return (field as unknown as Record<string, FieldProps>)[Object.keys(field).find((key) => key.startsWith("__reactProps$"))!]!;
  };
  const shortcut = async (meta: boolean) => act(async () => {
    fieldProps().onKeyDown({ key: "Enter", ctrlKey: !meta, metaKey: meta, preventDefault: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  for (const phase of ["starting", "rec", "busy"] as const) {
    heldPhase = phase;
    await act(async () => { fieldProps().onChange({ target: { value: "Typed prefix" } }); });
    expect(document.querySelector<HTMLButtonElement>("[data-prototype-save]")!.disabled).toBe(true);
    await shortcut(false);
    await shortcut(true);
    await act(async () => { document.querySelector<HTMLElement>("[data-prototype-save]")!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(posted).toEqual([]);
  }
  /* The recording ends and its words land in the field. */
  heldPhase = null;
  await act(async () => { dictationOptions!.onLiveCommit("and the spoken rest."); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(document.querySelector<HTMLButtonElement>("[data-prototype-save]")!.disabled).toBe(false);
  /* Pressed twice before the first answer is back. */
  await act(async () => {
    const props = fieldProps();
    for (let press = 0; press < 2; press += 1) props.onKeyDown({ key: "Enter", ctrlKey: true, metaKey: false, preventDefault: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(posted).toEqual([{ reviewId: `pr_${"a".repeat(32)}`, chosen: [1], comment: "Typed prefix and the spoken rest." }]);
  expect(document.querySelector("[data-prototype-comment]")?.textContent).toBe("Typed prefix and the spoken rest.");
});

test("closing while speech is starting or transcribed asks first, with nothing typed: keeping receives the late words and saves them once, only discarding closes", async () => {
  const posted: Array<{ reviewId: string; chosen: number[]; comment: string }> = [];
  let saved: { chosen: number[]; comment: string } | undefined;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      saved = { chosen: body.chosen, comment: body.comment };
    }
    return new Response(JSON.stringify(reviewRead(saved)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  let closed = 0;
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  root = createRoot(host);
  await act(async () => { root!.render(<PrototypeReview taskId="task-1" reviewId={null} taskTitle="Layout task" onClose={() => { closed += 1; }} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const guard = () => document.querySelector("[data-prototype-guard]");
  const dismissals: Array<[string, () => void]> = [
    ["Escape", () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }],
    ["the close button", () => { document.querySelector<HTMLElement>("[data-prototype-close]")!.click(); }],
    ["the backdrop", () => { document.querySelector<HTMLElement>("[data-prototype-review]")!.click(); }],
  ];
  /* Idle and empty, each of them closes: the guard below is about speech. */
  for (const [, dismiss] of dismissals) await act(async () => { dismiss(); });
  expect(closed).toBe(dismissals.length);
  closed = 0;
  for (const phase of ["starting", "busy"] as const) {
    for (const [name, dismiss] of dismissals) {
      heldPhase = phase;
      await act(async () => { root!.render(<PrototypeReview taskId="task-1" reviewId={null} taskTitle={`Layout task ${phase} ${name}`} onClose={() => { closed += 1; }} />); });
      expect(guard()).toBeNull();
      await act(async () => { dismiss(); });
      expect([phase, name, closed, guard() !== null]).toEqual([phase, name, 0, true]);
      await act(async () => { document.querySelector<HTMLElement>("[data-prototype-guard-keep]")!.click(); });
      expect(guard()).toBeNull();
    }
  }
  /* The answer comes back while the question is still up. */
  await act(async () => { document.querySelector<HTMLElement>("[data-prototype-close]")!.click(); });
  expect(guard()).not.toBeNull();
  heldPhase = null;
  await act(async () => { dictationOptions!.onUnclaimedText("Move the caption under the picture."); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(closed).toBe(0);
  await act(async () => { document.querySelector<HTMLElement>("[data-prototype-guard-keep]")!.click(); });
  expect(document.querySelector<HTMLTextAreaElement>("[data-prototype-comment-field]")!.value).toBe("Move the caption under the picture.");
  await act(async () => { document.querySelector<HTMLElement>('[data-prototype-choose="2"]')!.click(); });
  await act(async () => { document.querySelector<HTMLElement>("[data-prototype-save]")!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => { document.querySelector<HTMLElement>("[data-prototype-save]")?.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(posted).toEqual([{ reviewId: `pr_${"a".repeat(32)}`, chosen: [2], comment: "Move the caption under the picture." }]);
  expect(closed).toBe(0);
});

test("discarding in the guard is what drops speech still being transcribed", async () => {
  globalThis.fetch = (async (_url: unknown) => new Response(JSON.stringify(reviewRead()), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  let closed = 0;
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  root = createRoot(host);
  heldPhase = "busy";
  await act(async () => { root!.render(<PrototypeReview taskId="task-1" reviewId={null} taskTitle="Layout task" onClose={() => { closed += 1; }} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => { document.querySelector<HTMLElement>("[data-prototype-close]")!.click(); });
  expect(closed).toBe(0);
  await act(async () => { document.querySelector<HTMLElement>("[data-prototype-guard-discard]")!.click(); });
  expect(closed).toBe(1);
});

async function mountReview(read: PrototypeReviewRead) {
  globalThis.fetch = (async () => new Response(JSON.stringify(read), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  root = createRoot(host);
  await act(async () => { root!.render(<PrototypeReview taskId="task-1" reviewId={null} taskTitle="Layout task" onClose={() => {}} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

test("the line over the picture parts the variant's name from the picture's caption with the viewer's dash", async () => {
  await mountReview(reviewRead());
  const line = document.querySelector<HTMLElement>("[data-prototype-caption]")!;
  expect(line.querySelector("[data-prototype-caption-name]")?.textContent).toBe("Compact");
  expect(line.querySelector("[data-prototype-caption-text]")?.textContent).toBe("Board");
  expect(line.textContent).toBe("1Compact — Board");
});

test("in the slider comparison the two labels stand outside the box that draws the pictures", async () => {
  const shownMedia = (id: string) => ({ ...media(id), available: true, url: `/media/${id}.png` });
  const read = reviewRead();
  read.rounds[0]!.variants[0]!.frames = [{ image: shownMedia("c"), original: shownMedia("o"), caption: "Board" }];
  await mountReview(read);
  await act(async () => { document.querySelector<HTMLElement>('[data-prototype-pair-mode="slider"]')!.click(); });
  const pair = document.querySelector<HTMLElement>('[data-prototype-pair="slider"]')!;
  const labels = [...pair.querySelectorAll<HTMLElement>("[data-prototype-pair-label]")];
  expect(labels.map((label) => [label.dataset.prototypePairLabel, label.textContent])).toEqual([["original", "Original"], ["changed", "Changed"]]);
  const pictures = [...pair.querySelectorAll("img")];
  expect(pictures).toHaveLength(2);
  for (const label of labels) for (const picture of pictures) expect(picture.parentElement!.contains(label)).toBe(false);
});

for (const state of ["no-orchestrator", "failed", "uncertain"] as const) {
  test(`a ${state} delivery keeps its mark and its words in one group, and only the retry stands beside it`, async () => {
    const read = reviewRead({ chosen: [1], comment: "" });
    read.rounds[0]!.decision!.delivery = { state, retryable: true };
    await mountReview(read);
    const line = document.querySelector<HTMLElement>("[data-prototype-delivery]")!;
    expect([...line.children].map((child) => child.tagName)).toEqual(["SPAN", "BUTTON"]);
    const said = line.querySelector<HTMLElement>("[data-prototype-delivery-said]")!;
    expect(said.className).not.toContain("flex-wrap");
    expect(said.querySelector("svg")).not.toBeNull();
    expect(said.textContent?.startsWith("Saved.")).toBe(true);
    expect(said.contains(line.querySelector("[data-prototype-retry]"))).toBe(false);
  });
}
