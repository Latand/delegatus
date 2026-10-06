import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
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
