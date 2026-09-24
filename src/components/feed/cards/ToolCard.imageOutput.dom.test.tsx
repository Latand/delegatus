import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import { setLocale, translate } from "@/lib/i18n";

import { toolEvent } from "../__fixtures__/readableTools";
import type { CmdGroupItem, ToolEvent, ToolOutputBlock } from "../parse";
import { CmdGroupCard } from "./CmdGroupCard";
import { ToolCard } from "./ToolCard";

/*
 * #1498, #2075: an image an agent looks at is a block of its tool result, and
 * the tool line draws it with the feed's ImageCard, the card that draws an
 * operator's attachment: a thumbnail under the line, outside its disclosure,
 * so it shows while the line is closed on the phone (390 × 844) and on the
 * desktop alike. A tap opens the full-screen viewer. A picture the transcript
 * references by path loads through the artifact route, and a file that cannot
 * be drawn becomes a pill naming it and why.
 */

let narrowViewport = false;

const normalize = (query: string) => String(query).replace(/\s+/g, "");
/* The phone is whatever `useIsMobile` asks for — the shared layout query, so a
   future pin change cannot leave this stub matching a query nobody consults. */
const matchMediaStub = (query: string) => ({
  matches: normalize(query) === normalize(MOBILE_LAYOUT_QUERY) ? narrowViewport : false,
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});

const dom = new Window({ url: "http://localhost/" });
(dom as unknown as { matchMedia: unknown }).matchMedia = matchMediaStub;
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDetailsElement: dom.HTMLDetailsElement,
  HTMLImageElement: dom.HTMLImageElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  matchMedia: matchMediaStub,
});

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

let root: Root | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  narrowViewport = false;
  globalThis.fetch = realFetch;
  setLocale("en");
  dom.document.body.replaceChildren();
});

function mount(node: ReactElement): Element {
  const el = dom.document.createElement("div");
  dom.document.body.append(el);
  root = createRoot(el as unknown as HTMLElement);
  flushSync(() => root!.render(node));
  return el as unknown as Element;
}

function toggle(details: Element, open: boolean): void {
  (details as unknown as { open: boolean }).open = open;
  flushSync(() => details.dispatchEvent(new dom.Event("toggle") as unknown as Event));
}

function click(el: Element): void {
  flushSync(() => el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event));
}

const FRAME_DATA = "c3ludGhldGljLWZyYW1l";
const FRAME_URI = `data:image/jpeg;base64,${FRAME_DATA}`;
const frame: ToolOutputBlock = { type: "image", media: "image/jpeg", data: FRAME_DATA, w: 1999, h: 1161, bytes: 304134 };

/** A Read of a rendered frame whose result carried text around the picture. */
function frameRead(over: Partial<ToolEvent> = {}): ToolEvent {
  return toolEvent({
    id: "read-frame",
    family: "read",
    tool: "Read",
    icon: "file",
    summary: "Read op-image-1.jpg",
    outputPreview: `before the frame\n[${en("render.imageOutput")}]\nafter the frame`,
    outputBlocks: [{ type: "text", text: "before the frame" }, frame, { type: "text", text: "after the frame" }],
    open: true,
    ...over,
  });
}

const chipOf = (host: Element) => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(en("common.show"))) ?? null;
const order = (text: string, ...needles: string[]) => needles.map((needle) => text.indexOf(needle));
const images = (host: Element) => [...host.querySelectorAll("img")];

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

test("desktop: the picture is a thumbnail under the line, the body keeps the text in order, and a click opens the viewer", () => {
  const host = mount(<ToolCard event={frameRead()} />);
  const body = host.querySelector("details > div")!;
  expect(body).toBeTruthy();
  const [before, after] = order(body.textContent ?? "", "before the frame", "after the frame");
  expect(before).toBeGreaterThanOrEqual(0);
  expect(after).toBeGreaterThan(before);
  expect(body.textContent).not.toContain(`[${en("render.imageOutput")}]`);
  /* One thumbnail, outside the disclosure, and no "show" chip in front of it. */
  const [img, ...rest] = images(host);
  expect(rest).toHaveLength(0);
  expect(img!.getAttribute("src")).toBe(FRAME_URI);
  expect(img!.closest("details")).toBeNull();
  expect(img!.closest("[data-tool-images]")).toBeTruthy();
  expect(chipOf(host)).toBeNull();
  /* Dimensions and size, quietly. */
  expect(host.querySelector("[data-image-caption]")!.textContent).toBe(`1999×1161 · 297 ${en("common.kb")}`);
  /* Under a tool line there is no second feed-gutter indent. */
  expect(img!.parentElement!.getAttribute("class")).not.toContain("ml-9");
  click(img!);
  const viewer = dom.document.querySelector("[role=dialog]")!;
  expect(viewer).toBeTruthy();
  expect(viewer.querySelector("img")!.getAttribute("src")).toBe(FRAME_URI);
});

test("phone at 390 px: the line stays one closed line and the thumbnail shows under it without a tap", () => {
  narrowViewport = true;
  const host = mount(<ToolCard event={frameRead()} />);
  const details = host.querySelector("details")!;
  expect((details as unknown as { open: boolean }).open).toBe(false);
  expect(host.querySelector("details > div")).toBeNull();
  const [img] = images(host);
  expect(img!.getAttribute("src")).toBe(FRAME_URI);
  expect(chipOf(host)).toBeNull();
  /* The thumbnail never forces the 390 px document sideways. */
  expect(img!.getAttribute("class")).toContain("max-w-full");
  /* Opening the line adds the text and never a second picture. */
  toggle(details, true);
  expect(host.querySelector("details > div")!.textContent).toContain("before the frame");
  expect(images(host)).toHaveLength(1);
  /* "Collapse" is the operator's choice, and it folds to the chip. */
  const collapse = [...host.querySelectorAll("button")].find((button) => button.textContent === en("common.collapse"))!;
  expect(collapse.getAttribute("class")).toContain("[@media(pointer:coarse)]:min-h-11");
  click(collapse);
  expect(images(host)).toHaveLength(0);
  expect(chipOf(host)!.getAttribute("class")).toContain("min-h-11");
});

test("several pictures on one call all show, wrapping under the line", () => {
  const host = mount(<ToolCard event={frameRead({ outputPreview: "", outputBlocks: [frame, frame, frame] })} />);
  expect(images(host)).toHaveLength(3);
  const row = host.querySelector("[data-tool-images]")!;
  expect(row.getAttribute("class")).toContain("flex-wrap");
  expect(row.getAttribute("class")).toContain("max-w-full");
});

test("a readable block inside an opened run draws its pictures too", () => {
  const calls = [1, 2].map((n) => frameRead({ id: `read-frame-${n}`, summary: `Read op-image-${n}.jpg`, outputPreview: "", outputBlocks: [frame] }));
  const group: CmdGroupItem = {
    kind: "cmd-group",
    ids: calls.map((call) => call.id),
    calls,
    t0: calls[0]!.ts,
    t1: calls[1]!.ts,
    byTool: { Read: 2 },
    okCount: 2,
    errCount: 0,
    hasErr: false,
    active: true,
  };
  const host = mount(<CmdGroupCard item={group} />);
  expect(images(host)).toHaveLength(2);
});

test("a picture block without data falls back to the text placeholder and never blanks the card", () => {
  const event = frameRead({
    outputPreview: `captured\n[${en("render.imageOutput")}]`,
    outputBlocks: [{ type: "text", text: "captured" }, { type: "image", media: "image/png", data: "" }],
  });
  const host = mount(<ToolCard event={event} />);
  const body = host.querySelector("details > div")!;
  expect(body.textContent).toContain("captured");
  expect(body.textContent).toContain(en("render.imageOutput"));
  expect(chipOf(host)).toBeNull();
  expect(images(host)).toHaveLength(0);
});

const pathView = () => frameRead({ id: "view-path", tool: "imageView", summary: "imageView · /w/shot.png", outputPreview: `[${en("render.imageOutput")}]`, outputBlocks: [{ type: "image", path: "/w/shot.png" }] });

test("a picture referenced by path loads lazily through the artifact route", () => {
  const host = mount(<ToolCard event={pathView()} />);
  const [img] = images(host);
  expect(img!.getAttribute("src")).toBe("/api/artifact?path=%2Fw%2Fshot.png");
  expect(img!.getAttribute("loading")).toBe("lazy");
  expect(img!.getAttribute("decoding")).toBe("async");
  expect(host.innerHTML).not.toContain("base64");
});

for (const [status, code, key] of [
  [404, "not-found", "render.imageGone"],
  [403, "access-denied", "render.imageOutsideRoots"],
  [415, "unsupported", "render.imageUnavailable"],
] as const) {
  for (const locale of ["en", "uk"] as const) {
    test(`a file that cannot be drawn (${code}) becomes a pill naming it and why, in ${locale}`, async () => {
      setLocale(locale);
      const asked: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        asked.push(String(input));
        return new Response(JSON.stringify({ error: "fixture", code }), { status, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const host = mount(<ToolCard event={pathView()} />);
      const [img] = images(host);
      flushSync(() => img!.dispatchEvent(new dom.Event("error") as unknown as Event));
      await settle();
      expect(asked).toEqual(["/api/artifact?path=%2Fw%2Fshot.png&mode=meta"]);
      const pill = host.querySelector("[data-image-unavailable]")!;
      expect(pill).toBeTruthy();
      expect(pill.textContent).toContain("shot.png");
      expect(pill.textContent).toContain(translate(locale, key));
      /* The full path lives only in the tooltip, never in the row's text. */
      expect(pill.textContent).not.toContain("/w/");
      expect(pill.getAttribute("title")).toBe("/w/shot.png");
      expect(images(host)).toHaveLength(0);
    });
  }
}
