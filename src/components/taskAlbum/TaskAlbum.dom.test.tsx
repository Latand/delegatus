import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { AlbumItem, AlbumPage } from "@/lib/taskAlbum/album";
import type { Pipeline } from "@/lib/pipelines/types";

/*
 * The album button on a task card shows the task's picture count and a dot
 * while some are new; opening the album lists every picture newest first,
 * grouped by the stage or conversation it came from, marks the new ones, and
 * clears the card's dot. A picture opens in the feed's full-screen viewer,
 * whose arrows step through the album in the order it is drawn.
 */

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent,
  CustomEvent: dom.CustomEvent, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  matchMedia: dom.matchMedia.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const previousFetch = globalThis.fetch;
const calls: Array<{ url: string; method: string }> = [];
let summary = { count: 3, newCount: 2, newestAt: 3 };
let opened = false;

const source = (key: string, stage?: AlbumItem["source"]["stage"]) => ({ key, conversationId: key, path: `/fixture/${key}.jsonl`, ...(stage ? { stage } : {}) });
const item = (id: string, ts: number, isNew: boolean, src: AlbumItem["source"]): AlbumItem => ({ id, src: `/api/artifact?path=%2Fvar%2Ftmp%2F${id}.png`, name: `${id}.png`, ts, via: "named", source: src, isNew });
const STAGE = source("conversation_stage", { pipelineId: "pipe-1", stageId: "implement", attempt: 1 });
const OTHER = source("conversation_other");
const PAGE: AlbumPage = {
  items: [item("newest", 3_000, true, STAGE), item("middle", 2_000, true, OTHER), item("oldest", 1_000, false, STAGE)],
  total: 3,
  nextCursor: null,
  indexing: false,
  lastOpenedAt: 1_500,
  newCount: 2,
};
let albumPage: AlbumPage = PAGE;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  calls.push({ url, method });
  if (url.startsWith("/api/task-album?")) return Response.json({ tasks: { "task-1": opened ? { ...summary, newCount: 0 } : summary } });
  if (url.startsWith("/api/tasks/task-1/album") && method === "POST") {
    opened = true;
    return Response.json({ ok: true, lastOpenedAt: 4_000 });
  }
  if (url.startsWith("/api/tasks/task-1/album")) return Response.json(albumPage);
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;

const { CardAlbumButton } = await import("./AlbumButton");
const { resetAlbumSummaries } = await import("./albumSummaries");
const { albumSourceLabel } = await import("./TaskAlbum");
const { translate } = await import("@/lib/i18n");

const PIPELINE = { id: "pipe-1", stages: [{ id: "implement", role: { roleId: "builder" } }, { id: "review", role: { roleId: "reviewer" } }] } as unknown as Pipeline;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  resetAlbumSummaries();
  calls.length = 0;
  opened = false;
  albumPage = PAGE;
  summary = { count: 3, newCount: 2, newestAt: 3 };
});
afterAll(() => {
  globalThis.fetch = previousFetch;
});

const settle = async (ms = 320) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

async function mountButton(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<CardAlbumButton taskId="task-1" title="Card redesign" pipelines={[PIPELINE]} files={[]} />));
  await settle();
  return host;
}

test("the card shows the picture count and a dot while some are new", async () => {
  const host = await mountButton();
  const button = host.querySelector<HTMLButtonElement>("[data-album-button='task-1']");
  expect(button).not.toBeNull();
  expect(button!.textContent).toContain("3");
  expect(button!.getAttribute("data-album-fresh")).toBe("1");
  expect(button!.querySelector(".album-dot")).not.toBeNull();
  /* One request for the board's summaries, none per picture. */
  expect(calls.filter((call) => call.url.startsWith("/api/task-album?")).length).toBe(1);
});

test("a task with no pictures draws no album button", async () => {
  summary = { count: 0, newCount: 0, newestAt: 0 };
  const host = await mountButton();
  expect(host.querySelector("[data-album-button]")).toBeNull();
});

test("opening the album groups newest first, marks the new pictures and clears the card's dot", async () => {
  const host = await mountButton();
  await act(async () => host.querySelector<HTMLButtonElement>("[data-album-button='task-1']")!.click());
  await settle(60);

  const album = document.querySelector("[data-task-album='task-1']")!;
  expect(album).not.toBeNull();
  const groups = [...album.querySelectorAll("[data-album-group]")].map((group) => group.getAttribute("data-album-group"));
  expect(groups).toEqual(["conversation_stage", "conversation_other"]);
  const order = [...album.querySelectorAll("[data-album-item]")].map((tile) => tile.getAttribute("data-album-item"));
  expect(order).toEqual(["newest", "oldest", "middle"]);
  const fresh = [...album.querySelectorAll("[data-album-item-new='1']")].map((tile) => tile.getAttribute("data-album-item"));
  expect(fresh).toEqual(["newest", "middle"]);
  expect(album.querySelector("[data-album-group='conversation_stage'] h3")!.textContent).toBe("Implement");
  expect(album.querySelector("[data-album-source='conversation_other']")!.getAttribute("href")).toBe("#c=conversation_other");
  expect(album.querySelector("[data-album-new-count]")!.textContent).toContain("2 new");
  /* A new picture is marked on its thumbnail, not only in its caption. */
  const marks = [...album.querySelectorAll("[data-album-item] > button [data-album-new-mark]")].map((mark) => mark.closest("[data-album-item]")!.getAttribute("data-album-item"));
  expect(marks).toEqual(["newest", "middle"]);
  expect(album.querySelector("[data-album-item='newest'] > button")!.className).toContain("border-accent");
  expect(album.querySelector("[data-album-item='oldest'] > button")!.className).not.toContain("border-accent");

  /* The album told the Viewer it was opened, and the card's dot is gone. */
  expect(calls.some((call) => call.url === "/api/tasks/task-1/album" && call.method === "POST")).toBe(true);
  const button = host.querySelector("[data-album-button='task-1']")!;
  expect(button.getAttribute("data-album-fresh")).toBe("0");
  expect(button.querySelector(".album-dot")).toBeNull();
});

test("a picture opens in the full-screen viewer, and its arrows follow the album's order", async () => {
  const host = await mountButton();
  await act(async () => host.querySelector<HTMLButtonElement>("[data-album-button='task-1']")!.click());
  await settle(60);
  await act(async () => document.querySelector<HTMLButtonElement>("[data-album-item='newest'] button")!.click());

  const viewer = () => document.querySelector("[role='dialog'][aria-modal='true'] [data-lightbox-position]");
  expect(viewer()!.textContent).toBe("1 / 3");
  const shown = () => document.querySelector<HTMLImageElement>("img:not([hidden])[draggable='false']")!.getAttribute("src");
  expect(shown()).toBe(PAGE.items[0]!.src);
  await act(async () => document.querySelector<HTMLButtonElement>("[data-lightbox-step='next']")!.click());
  /* After the newest comes the older picture of the same stage, as drawn. */
  expect(shown()).toBe(PAGE.items[2]!.src);
  await act(async () => document.querySelector<HTMLButtonElement>("[data-lightbox-step='next']")!.click());
  expect(shown()).toBe(PAGE.items[1]!.src);
  expect(document.querySelector("[data-lightbox-step='next']")).toBeNull();

  /* Escape closes the viewer first and leaves the album open. */
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(document.querySelector("[data-lightbox-position]")).toBeNull();
  expect(document.querySelector("[data-task-album='task-1']")).not.toBeNull();
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(document.querySelector("[data-task-album='task-1']")).toBeNull();
});

test("the header's «N new» brings the first new picture into view and focus", async () => {
  albumPage = { ...PAGE, items: [item("seen", 3_000, false, STAGE), item("fresh", 2_000, true, OTHER)], newCount: 1 };
  const host = await mountButton();
  await act(async () => host.querySelector<HTMLButtonElement>("[data-album-button='task-1']")!.click());
  await settle(60);
  const tile = document.querySelector<HTMLElement>("[data-album-item='fresh'] > button")!;
  let scrolled = 0;
  tile.scrollIntoView = () => { scrolled += 1; };
  await act(async () => document.querySelector<HTMLButtonElement>("button[data-album-new-count]")!.click());
  expect(scrolled).toBe(1);
  expect(document.activeElement).toBe(tile);
});

test("a stage's attempt is spelled out, never a bare number beside the group", async () => {
  const stage = (attempt: number, round?: number) => source("s", { pipelineId: "pipe-1", stageId: round ? "review" : "implement", attempt, ...(round ? { round } : {}) });
  const en = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("en", key, params);
  const uk = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("uk", key, params);
  expect(albumSourceLabel(en, stage(1), [PIPELINE], [])).toBe("Implement");
  expect(albumSourceLabel(en, stage(2), [PIPELINE], [])).toBe("Implement · attempt 2");
  expect(albumSourceLabel(en, stage(1, 2), [PIPELINE], [])).toMatch(/ · attempt 1 · round 2$/);
  expect(albumSourceLabel(uk, stage(2), [PIPELINE], [])).toMatch(/ · спроба 2$/);

  /* The heading and the viewer's caption both carry it. */
  const retried = source("conversation_retry", { pipelineId: "pipe-1", stageId: "implement", attempt: 2 });
  albumPage = { ...PAGE, items: [item("again", 3_000, false, retried)], total: 1, newCount: 0 };
  const host = await mountButton();
  await act(async () => host.querySelector<HTMLButtonElement>("[data-album-button='task-1']")!.click());
  await settle(60);
  expect(document.querySelector("[data-album-group='conversation_retry'] h3")!.textContent).toBe("Implement · attempt 2");
  await act(async () => document.querySelector<HTMLButtonElement>("[data-album-item='again'] > button")!.click());
  expect(document.querySelector("[data-lightbox-caption]")!.textContent).toContain("again.png");
  expect(document.querySelector("[data-lightbox-detail]")!.textContent).toContain("Implement · attempt 2 · ");
});
