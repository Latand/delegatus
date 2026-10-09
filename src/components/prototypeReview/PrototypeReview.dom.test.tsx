import { afterEach, describe, expect, mock, test } from "bun:test";
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

/* The phone's layout query answers as a case sets it; every other query is the window's own. */
const { MOBILE_LAYOUT_QUERY } = await import("@/lib/attention/eligibility");
let phoneLayout = false;
const ownMatchMedia = dom.matchMedia.bind(dom);
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => (query === MOBILE_LAYOUT_QUERY
  ? { matches: phoneLayout, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }
  : ownMatchMedia(query));

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
  phoneLayout = false;
  globalThis.fetch = realFetch;
  dom.document.body.innerHTML = "";
});

test.each([false, true])("Hide and history Undo share dismissal identity and keep a real choice available (phone: %s)", async (phone) => {
  phoneLayout = phone;
  const calls: unknown[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url) === "/api/attention/dismissals") {
      const body = JSON.parse(String(init?.body)); calls.push(body);
      return new Response(JSON.stringify({ ok: true, dismissed: [body.target], alreadyClear: [], changed: [], undo: body.undo,
        at: "2026-10-09T12:00:00Z", by: { kind: "operator", surface: phone ? "phone" : "desktop" } }));
    }
    return new Response(JSON.stringify(reviewRead()));
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<PrototypeReview taskId="task-1" reviewId={null} taskTitle="Layout task" onClose={() => {}} />); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(document.querySelector("[data-prototype-hide]")).not.toBeNull();
  expect(document.querySelector("[data-prototype-save]")).not.toBeNull();
  await act(async () => { document.querySelector<HTMLElement>("[data-prototype-hide]")!.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(document.querySelector("[data-prototype-hidden]")).not.toBeNull();
  expect(document.querySelector("[data-prototype-save]")).toBeNull();
  await act(async () => { document.querySelector<HTMLElement>("[data-prototype-undo-hide]")!.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(document.querySelector("[data-prototype-save]")).not.toBeNull();
  expect(calls).toEqual([false, true].map(undo => ({ target: { kind: "prototype", taskId: "task-1", reviewId: `pr_${"a".repeat(32)}` }, undo, surface: phone ? "phone" : "desktop" })));
});

test.each(["rec", "busy"] as const)("Hide keeps the voice controls available while dictation is %s", async phase => {
  heldPhase = phase;
  const writes: unknown[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") writes.push(url);
    return new Response(JSON.stringify(reviewRead()));
  }) as typeof fetch;
  const host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<PrototypeReview taskId="task-1" reviewId={null} taskTitle="Layout" onClose={() => {}} />); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const hide = document.querySelector<HTMLButtonElement>("[data-prototype-hide]")!;
  expect(hide.disabled).toBe(true);
  await act(async () => { hide.click(); });
  expect(writes).toEqual([]);
  expect(document.querySelector("[data-prototype-hidden]")).toBeNull();
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

/* Two rounds of one task that both wait, the older first. */
function twoRounds(): PrototypeReviewRead {
  const read = reviewRead();
  const older = { ...read.rounds[0]!, id: `pr_${"b".repeat(32)}`, title: "Older layout", createdAt: "2026-10-06T09:00:00.000Z" };
  return { ...read, rounds: [older, read.rounds[0]!] };
}
const commentField = () => document.querySelector<HTMLTextAreaElement>("[data-prototype-comment-field]")!;
const shownRound = () => document.querySelector<HTMLElement>("[data-prototype-round][aria-pressed=true]")?.dataset.prototypeRound ?? null;

test("speech belongs to the round it was started in: another round cannot be opened until the words land, and they land in that round only", async () => {
  const [older, newer] = twoRounds().rounds.map((entry) => entry.id) as [string, string];
  const posted: Array<{ reviewId: string; chosen: number[]; comment: string }> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(twoRounds()), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  root = createRoot(host);
  await act(async () => { root!.render(<PrototypeReview taskId="task-1" reviewId={null} taskTitle="Layout task" onClose={() => {}} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => { document.querySelector<HTMLElement>(`[data-prototype-round="${older}"]`)!.click(); });
  expect(shownRound()).toBe(older);
  for (const phase of ["starting", "rec", "busy"] as const) {
    heldPhase = phase;
    await act(async () => { root!.render(<PrototypeReview taskId="task-1" reviewId={null} taskTitle={`Layout task ${phase}`} onClose={() => {}} />); });
    const other = document.querySelector<HTMLButtonElement>(`[data-prototype-round="${newer}"]`)!;
    await act(async () => { other.click(); });
    expect([phase, shownRound(), other.disabled]).toEqual([phase, older, true]);
  }
  /* The recording ends and its words come back. */
  heldPhase = null;
  await act(async () => { dictationOptions!.onUnclaimedText("Keep the older header."); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(shownRound()).toBe(older);
  expect(commentField().value).toBe("Keep the older header.");
  await act(async () => { document.querySelector<HTMLElement>(`[data-prototype-round="${newer}"]`)!.click(); });
  expect(shownRound()).toBe(newer);
  expect(commentField().value).toBe("");
  await act(async () => { document.querySelector<HTMLElement>('[data-prototype-choose="2"]')!.click(); });
  await act(async () => { document.querySelector<HTMLElement>("[data-prototype-save]")!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(posted).toEqual([{ reviewId: newer, chosen: [2], comment: "" }]);
  await act(async () => { document.querySelector<HTMLElement>(`[data-prototype-round="${older}"]`)!.click(); });
  expect(commentField().value).toBe("Keep the older header.");
});

test("a round published while speech is recorded leaves the speech, and the stage, in the round where it started", async () => {
  const read = twoRounds();
  const [older, newer] = read.rounds.map((entry) => entry.id) as [string, string];
  let answer: PrototypeReviewRead = { ...read, rounds: [read.rounds[0]!], waitingReviewId: older };
  globalThis.fetch = (async () => new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  root = createRoot(host);
  await act(async () => { root!.render(<PrototypeReview taskId="task-1" reviewId={null} taskTitle="Layout task" onClose={() => {}} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  /* The press on the microphone: this DOM has no microphone, so the phase is held from here. */
  await act(async () => { document.querySelector<HTMLElement>('[aria-label="Dictate"]')!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  heldPhase = "rec";
  await act(async () => { root!.render(<PrototypeReview taskId="task-1" reviewId={null} taskTitle="Layout task rec" onClose={() => {}} />); });
  answer = read;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_200)); });
  expect(document.querySelector(`[data-prototype-round="${newer}"]`)).not.toBeNull();
  expect(shownRound()).toBe(older);
  await act(async () => { dictationOptions!.onLiveCommit("Older words."); await new Promise((resolve) => setTimeout(resolve, 20)); });
  heldPhase = null;
  await act(async () => { root!.render(<PrototypeReview taskId="task-1" reviewId={null} taskTitle="Layout task idle" onClose={() => {}} />); });
  expect(shownRound()).toBe(older);
  expect(commentField().value).toBe("Older words.");
  await act(async () => { document.querySelector<HTMLElement>(`[data-prototype-round="${newer}"]`)!.click(); });
  expect(commentField().value).toBe("");
});

test("a round a later decision retired says so where a waiting round asks for a choice, and opens its choice only when the operator asks", async () => {
  const read = twoRounds();
  const [older, newer] = read.rounds.map((entry) => entry.id) as [string, string];
  read.rounds[1] = { ...read.rounds[1]!, decision: { chosen: [2], comment: "", at: "2026-08-30T11:00:00.000Z", delivery: { state: "sent", retryable: false } } };
  read.rounds[0] = { ...read.rounds[0]!, supersededBy: newer };
  read.waitingReviewId = null;
  await mountReview(read);
  await act(async () => { document.querySelector<HTMLElement>(`[data-prototype-round="${older}"]`)!.click(); });
  expect(shownRound()).toBe(older);
  /* The tab's mark is as large as the decided check, and its words show on hover. */
  const mark = document.querySelector<SVGElement>(`[data-prototype-round="${older}"] [data-prototype-superseded]`)!;
  expect([mark.tagName.toLowerCase(), mark.getAttribute("aria-label"), mark.getAttribute("class")?.includes("h-3 w-3")]).toEqual(["svg", "superseded by round 2", true]);
  expect(document.querySelector<HTMLElement>(`[data-prototype-round="${older}"]`)!.title).toEndWith(" · superseded by round 2");
  const footer = () => document.querySelector<HTMLElement>("footer")!;
  expect(footer().querySelector("[data-prototype-superseded-line]")?.textContent).toContain("Superseded by round 2, decided on 30 Aug 2026.");
  expect(footer().textContent).not.toContain("nothing yet");
  expect(document.querySelector("[data-prototype-save]")).toBeNull();
  expect(document.querySelector("[data-prototype-comment-field]")).toBeNull();
  expect(document.querySelector<HTMLButtonElement>('[data-prototype-choose="1"]')!.disabled).toBe(true);
  /* The link opens the round that decided. */
  await act(async () => { document.querySelector<HTMLElement>(`[data-prototype-open-round="${newer}"]`)!.click(); });
  expect(shownRound()).toBe(newer);
  /* Deciding the retired round is still the operator's to ask for. */
  await act(async () => { document.querySelector<HTMLElement>(`[data-prototype-round="${older}"]`)!.click(); });
  await act(async () => { document.querySelector<HTMLElement>("[data-prototype-decide-anyway]")!.click(); });
  expect(document.querySelector("[data-prototype-decide-anyway]")).toBeNull();
  expect(footer().querySelector("[data-prototype-superseded-line]")).not.toBeNull();
  expect(document.querySelector<HTMLButtonElement>('[data-prototype-choose="1"]')!.disabled).toBe(false);
  expect(document.querySelector("[data-prototype-save]")).not.toBeNull();
});

test("a decided round opens on its first chosen variant, and the accent marks the chosen rows only, never the row merely on the stage", async () => {
  const read = reviewRead({ chosen: [2], comment: "" });
  read.rounds[0]!.variants.push(variant(3, "Wide"));
  await mountReview(read);
  expect(document.querySelector<HTMLElement>("[data-prototype-stage]")?.dataset.prototypeStage).toBe("2:f0");
  const row = (number: number) => document.querySelector<HTMLElement>(`li[data-prototype-variant="${number}"]`)!;
  const tinted = (number: number) => row(number).className.split(/\s+/).includes("bg-accent-soft") || /\bborder-accent/.test(row(number).className);
  expect([1, 2, 3].map(tinted)).toEqual([false, true, false]);
  /* Stepping onto an unchosen variant frames it, in no accent. */
  await act(async () => { document.querySelector<HTMLElement>('[data-prototype-show="1"]')!.click(); });
  expect(document.querySelector<HTMLElement>("[data-prototype-stage]")?.dataset.prototypeStage).toBe("1:f0");
  expect([1, 2, 3].map(tinted)).toEqual([false, true, false]);
  expect(row(1).className).toContain("border-strong");
});

test("the phone seat card's prototype chip says the word with the count", async () => {
  const { PrototypeNoticeChip } = await import("./PrototypeNoticeRow");
  const { publishPrototypeNotices } = await import("./prototypeReviewStore");
  const notice = (taskId: string) => ({ id: `n-${taskId}`, project: "project-a", taskId, reviewId: `r-${taskId}`, title: `Task ${taskId}`, createdAt: "2026-10-06T10:00:00.000Z", target: { kind: "prototype-review" as const, taskId, reviewId: `r-${taskId}` } });
  publishPrototypeNotices([notice("a"), notice("b"), notice("c")]);
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  root = createRoot(host);
  try {
    await act(async () => root!.render(<PrototypeNoticeChip project="project-a" compact />));
    const chip = host.querySelector<HTMLElement>("[data-prototype-notice-chip]")!;
    expect(chip.textContent).toBe("Prototype3");
    expect(chip.querySelector("[data-prototype-notice-chip-word]")?.textContent).toBe("Prototype");
    expect(chip.className).toContain("h-11");
  } finally {
    publishPrototypeNotices([]);
  }
});

/* The full-screen viewer over a review: the picture pressed, the frames of its
   variant to step through, a pair as one picture with its original switched in
   place, and the hand's swipes. happy-dom lays nothing out, so a pointer is
   read from the frame's corner; the browser drivers measure the rest. */
describe("the full-screen viewer", () => {
  const available = (id: string) => ({ ...media(id), available: true, url: `/media/${id}.png` });
  const video = (id: string) => ({ media: { ...media(id), mime: "video/webm" as const, available: true, url: `/media/${id}.webm` }, caption: "Walk" });
  /* Variant 1: a pair, a plain frame and a video; variant 2: one frame. */
  function pairRead(): PrototypeReviewRead {
    const read = reviewRead();
    read.rounds[0]!.variants[0]!.frames = [{ image: available("c"), original: available("o"), caption: "Board" }, { image: available("p"), caption: "Phone" }];
    read.rounds[0]!.variants[0]!.videos = [video("v")];
    read.rounds[0]!.variants[1]!.frames = [{ image: available("r"), caption: "Roomy board" }];
    return read;
  }
  const lightbox = () => document.querySelector<HTMLElement>("[role=dialog] [data-lightbox-position]")?.closest<HTMLElement>("[role=dialog]") ?? null;
  const place = () => lightbox()?.querySelector("[data-lightbox-position]")?.textContent ?? null;
  const caption = () => lightbox()?.querySelector("[data-lightbox-caption]")?.textContent ?? null;
  const visible = () => [...lightbox()!.querySelectorAll<HTMLImageElement>("img")].filter((image) => !image.hidden);
  const scale = () => lightbox()!.querySelector(`button[aria-label="Reset zoom"]`)!.textContent;
  const press = (selector: string) => act(async () => { document.querySelector<HTMLElement>(selector)!.click(); });
  const key = (name: string) => act(async () => { dom.document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
  const stage = () => document.querySelector<HTMLElement>("[data-prototype-stage]")?.dataset.prototypeStage;
  /* One finger at fit, from one point to another, as the phone sends it. */
  const swipe = async (from: [number, number], to: [number, number]) => {
    const target = visible()[0]!;
    const fire = (type: string, [x, y]: [number, number]) => target.dispatchEvent(new dom.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y }) as unknown as Event);
    await act(async () => { fire("pointerdown", from); });
    await act(async () => { fire("pointermove", [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]); });
    await act(async () => { fire("pointermove", to); });
    await act(async () => { fire("pointerup", to); });
  };

  test("a press on a frame opens it with its caption and its place, steps only through its variant's pictures, and closing leaves the stage on the picture stepped to", async () => {
    await mountReview(pairRead());
    /* The plain frame is the variant's second slide: the stage walks to it first. */
    await press('[data-prototype-step="next"]');
    await press(`[data-prototype-zoom="${"p".repeat(64)}"]`);
    expect(place()).toBe("2 / 3");
    expect(caption()).toContain("1 · Compact — Phone");
    expect(visible().map((image) => image.getAttribute("src"))).toEqual(["/media/p.png"]);
    /* The video is not a picture and the next variant is not this one: the walk stops here. */
    await key("ArrowRight");
    expect(place()).toBe("2 / 3");
    await key("ArrowLeft");
    expect(place()).toBe("1 / 3");
    await key("ArrowLeft");
    expect(place()).toBe("1 / 3");
    expect(stage()).toBe("1:f0");
    /* The close is a button of its own; the review stays open under it. */
    await act(async () => { lightbox()!.querySelector<HTMLElement>('button[aria-label="Close"]')!.click(); });
    expect(lightbox()).toBeNull();
    expect(document.querySelector("[data-prototype-review]")).not.toBeNull();
    expect(stage()).toBe("1:f0");
  });

  test("a pair is one picture: the switch puts the original in its place at the same zoom, and a step returns to the changed side unzoomed", async () => {
    await mountReview(pairRead());
    /* The desktop draws the pair side by side; a press on the original opens the pair showing it. */
    await press(`[data-prototype-zoom="${"o".repeat(64)}"]`);
    expect(place()).toBe("1 / 3");
    expect(visible().map((image) => image.getAttribute("src"))).toEqual(["/media/o.png"]);
    expect(caption()).toContain("Board · Original");
    const side = (name: "before" | "after") => lightbox()!.querySelector<HTMLElement>(`[data-lightbox-compare-side="${name}"]`)!;
    expect([side("before").getAttribute("aria-pressed"), side("after").getAttribute("aria-pressed")]).toEqual(["true", "false"]);
    /* Both sides are loaded with the pair, so the switch shows the other at once. */
    expect(lightbox()!.querySelectorAll("img[data-lightbox-side]")).toHaveLength(2);
    await act(async () => { side("after").click(); });
    expect(visible().map((image) => image.getAttribute("src"))).toEqual(["/media/c.png"]);
    expect(caption()).toContain("Board · Changed");
    await act(async () => { lightbox()!.querySelector<HTMLElement>(`button[aria-label="Zoom in"]`)!.click(); });
    expect(scale()).toBe("140%");
    await act(async () => { side("before").click(); });
    expect(visible().map((image) => image.getAttribute("src"))).toEqual(["/media/o.png"]);
    expect(scale()).toBe("140%");
    expect(lightbox()).not.toBeNull();
    await key("ArrowRight");
    expect(place()).toBe("2 / 3");
    expect(scale()).toBe("100%");
    expect(lightbox()!.querySelector("[data-lightbox-compare]")).toBeNull();
    expect(stage()).toBe("1:f1");
  });

  test("a finger swipes to the neighbouring picture and back, and a drag down closes the viewer and nothing else", async () => {
    await mountReview(pairRead());
    await press('[data-prototype-fullsize]');
    expect(place()).toBe("1 / 3");
    await swipe([300, 400], [180, 404]);
    expect(place()).toBe("2 / 3");
    expect(stage()).toBe("1:f1");
    /* The last picture of the variant: a further swipe stays. */
    await swipe([300, 400], [180, 400]);
    expect(place()).toBe("2 / 3");
    await swipe([180, 400], [300, 400]);
    expect(place()).toBe("1 / 3");
    await swipe([300, 200], [300, 360]);
    expect(lightbox()).toBeNull();
    expect(document.querySelector("[data-prototype-review]")).not.toBeNull();
  });

  test("on the phone the sheet takes the screen, a frame takes the stage's width at its own height, a pair is compared on one frame, and a press on it opens the viewer", async () => {
    phoneLayout = true;
    await mountReview(pairRead());
    const sheet = document.querySelector<HTMLElement>("[data-mobile2-sheet=prototype-review]")!;
    expect(sheet.className).toContain("h-full");
    expect(document.querySelector("[data-prototype-pair-mode]")).toBeNull();
    expect(document.querySelector('[data-prototype-pair="slider"]')).not.toBeNull();
    /* The canvas is as tall as what it draws: no height of its own, no inset. */
    const canvas = document.querySelector<HTMLElement>("[data-prototype-canvas]")!;
    expect(canvas.className).not.toMatch(/\bh-\[/);
    expect(canvas.querySelector('[data-prototype-pair="slider"]')!.className).not.toContain("absolute");
    await press("[data-prototype-pair-frame]");
    expect(place()).toBe("1 / 3");
    expect(visible().map((image) => image.getAttribute("src"))).toEqual(["/media/c.png"]);
    await key("Escape");
    expect(lightbox()).toBeNull();
    await press('[data-prototype-step="next"]');
    const plain = document.querySelector<HTMLImageElement>("[data-prototype-canvas] img")!;
    expect(plain.className.split(/\s+/)).toEqual(expect.arrayContaining(["w-full", "h-auto"]));
    /* The choice and the comment stay in the sheet's footer, outside what scrolls. */
    expect(sheet.querySelector("[data-mobile2-sheet-body] [data-prototype-save]")).toBeNull();
    expect(sheet.querySelector("[data-prototype-save]")).not.toBeNull();
    /* A video plays in the stage at its whole width. */
    await press('[data-prototype-step="next"]');
    expect(document.querySelector<HTMLElement>("[data-prototype-video]")!.className).toContain("w-full");
  });
});
