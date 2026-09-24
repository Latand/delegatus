import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { FileEntry } from "@/lib/types";
import type { LogTailState } from "@/hooks/useLogTail";

/*
 * The full-screen image viewer steps through every picture of the conversation
 * it was opened from, in feed order: a pasted picture, markdown images in an
 * answer, an inbox attachment and a picture a tool showed its agent. The list
 * comes from the feed's records, so a picture whose row is not mounted is
 * reached all the same. A click on the dimmed area around the picture closes
 * the viewer; a click on the picture or a pan does not.
 */

/* A base URL, or a relative picture source cannot parse and fires `error`. */
const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  CustomEvent: dom.CustomEvent, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
});
const previousFetch = globalThis.fetch;
/* What the provenance read answers for the conversation under test; every
   other request finds nothing. */
let provenance: Record<string, unknown> | null = null;
globalThis.fetch = (async (input: RequestInfo | URL) => provenance && String(input).startsWith("/api/log/provenance")
  ? Response.json(provenance)
  : new Response("{}", { status: 404 })) as unknown as typeof fetch;
const { LogFeed } = await import("./LogFeed");
const { setLogFeedDependenciesForTests } = await import("./logFeedDependencies");

/* Invented pictures: the bytes are placeholders nobody decodes. */
const PASTED = "data:image/png;base64,cGFzdGVkLW1vY2t1cA==";
const FRAME = "data:image/jpeg;base64,dG9vbC1mcmFtZQ==";
const BEFORE = "/api/image?path=%2Fwork%2Fbefore.png";
const AFTER = "/api/image?path=%2Fwork%2Fafter.png";
const INBOX = "/api/inbox?name=shot-01.png";
const FINAL = "/api/image?path=%2Fwork%2Ffinal.png";
const ORDER = [PASTED, BEFORE, AFTER, INBOX, FRAME, FINAL];

const at = (second: number) => `2026-09-24T08:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`;
const line = (record: Record<string, unknown>) => JSON.stringify(record);
const answer = (uuid: string, second: number, text: string) =>
  line({ type: "assistant", uuid, timestamp: at(second), message: { role: "assistant", content: [{ type: "text", text }] } });

/* One conversation drawing a picture from each of the feed's three image
   renderers, interleaved with ordinary rows. */
const GALLERY = [
  line({ type: "user", uuid: "u-paste", timestamp: at(1), message: { role: "user", content: [
    { type: "text", text: "Here is the mockup" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PASTED.split(",")[1] } },
  ] } }),
  answer("a-compare", 2, "Compare the two:\n![before](/work/before.png)\n![after](/work/after.png)\n```\n![not drawn](/work/in-code.png)\n```"),
  line({ type: "user", uuid: "u-inbox", timestamp: at(3), message: { role: "user", content: "and the screenshot\n/srv/fixture/delegatus/inbox/shot-01.png" } }),
  line({ type: "assistant", uuid: "a-read", timestamp: at(4), message: { role: "assistant", content: [
    { type: "tool_use", id: "toolu_frame", name: "Read", input: { file_path: "/work/frame.jpg" } },
  ] } }),
  line({ type: "user", uuid: "r-read", timestamp: at(5), message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_frame", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: FRAME.split(",")[1] } }] },
  ] } }),
  answer("a-final", 6, "Done: ![final](/work/final.png)"),
];

const roots: Root[] = [];
const hosts: HTMLElement[] = [];
let renders = 0;
const tails = new Map<string, LogTailState>();
const tailFor = (lines: string[]): LogTailState => ({ lines, linesStart: 0, size: 1000, loading: false, error: null,
  tickTime: null, paused: false, setPaused() {}, clear() {}, hasMore: false, loadingOlder: false,
  loadOlder: async () => 0, prependGen: 0 });
const fileFor = (path: string) => ({ path, name: "fixture", root: "fixture", engine: "claude", fmt: "claude",
  kind: "session", size: 1000, mtime: 0, activity: "idle" }) as unknown as FileEntry;
const wait = () => new Promise((resolve) => setTimeout(resolve, 30));

async function mount(panes: { path: string; lines: string[]; compact?: boolean }[]): Promise<HTMLElement[]> {
  setLogFeedDependenciesForTests({ useLogTail: (file: FileEntry | null) => {
    renders += 1;
    return tails.get(file?.path ?? "") ?? tailFor([]);
  } });
  const mounted: HTMLElement[] = [];
  for (const pane of panes) {
    tails.set(pane.path, tailFor(pane.lines));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const draw = () => flushSync(() => root.render(<LogFeed file={fileFor(pane.path)} showSvc={false} lineFilter=""
      onStatus={() => {}} paused={false} follow={false} setFollow={() => {}} compact={pane.compact} />));
    draw(); await wait(); draw(); await wait();
    roots.push(root); hosts.push(host); mounted.push(host);
  }
  return mounted;
}

afterEach(async () => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  for (const host of hosts.splice(0)) host.remove();
  tails.clear();
  renders = 0;
  provenance = null;
  setLogFeedDependenciesForTests(null);
  document.body.replaceChildren();
  await dom.happyDOM.abort();
});
afterAll(() => { globalThis.fetch = previousFetch; });

const viewer = () => document.querySelector<HTMLElement>("[role=dialog]");
const isOpen = () => viewer() !== null;
const shown = () => viewer()!.querySelector<HTMLImageElement>("img:not([hidden])")!;
const position = () => viewer()!.querySelector("[data-lightbox-position]")?.textContent ?? null;
const step = (which: "previous" | "next") => viewer()!.querySelector<HTMLButtonElement>(`[data-lightbox-step=${which}]`);
const thumb = (host: Element, src: string) => host.querySelector<HTMLImageElement>(`[data-log-feed-scroller] img[src="${src}"]`);

function fire(target: Element, event: Event): void {
  flushSync(() => target.dispatchEvent(event));
}
function press(target: Element, key: string): void {
  fire(target, new dom.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }) as unknown as Event);
}
const pointer = (type: string, x: number, y: number, pointerType = "mouse") =>
  new dom.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType }) as unknown as Event;
const clickAt = (x: number, y: number) => new dom.MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y }) as unknown as Event;

/* A press and its click, as the browser delivers them. `release` is where the
   click lands: the viewer captures the pointer on its picture area, so a click
   after a press on the picture reaches that area rather than the picture. */
function tap(pressed: Element, x: number, y: number, release: Element = pressed, pointerType = "mouse"): void {
  fire(pressed, pointer("pointerdown", x, y, pointerType));
  fire(pressed, pointer("pointerup", x, y, pointerType));
  fire(release, clickAt(x, y));
}

async function open(host: Element, src: string): Promise<void> {
  fire(thumb(host, src)!, clickAt(0, 0));
  await wait();
  expect(isOpen()).toBe(true);
}

test("arrows walk every picture of the conversation in feed order across the three renderers and stop at both ends", async () => {
  const [host] = await mount([{ path: "/fixture/gallery", lines: GALLERY }]);
  await open(host!, BEFORE);
  expect(position()).toBe("2 / 6");
  expect(shown().getAttribute("src")).toBe(BEFORE);

  press(document.body, "ArrowLeft");
  expect([position(), shown().getAttribute("src")]).toEqual(["1 / 6", PASTED]);
  /* The start is a stop: no wrap to the last picture, and no previous button. */
  press(document.body, "ArrowLeft");
  expect([position(), shown().getAttribute("src")]).toEqual(["1 / 6", PASTED]);
  expect(step("previous")).toBeNull();

  const walked = [shown().getAttribute("src")];
  for (let i = 0; i < 5; i += 1) {
    press(document.body, "ArrowRight");
    walked.push(shown().getAttribute("src"));
  }
  expect(walked).toEqual(ORDER);
  expect(position()).toBe("6 / 6");
  press(document.body, "ArrowRight");
  expect([position(), shown().getAttribute("src")]).toEqual(["6 / 6", FINAL]);
  expect(step("next")).toBeNull();

  /* Each picture keeps the caption its own card gives it. */
  press(document.body, "ArrowLeft");
  press(document.body, "ArrowLeft");
  expect(viewer()!.textContent).toContain("shot-01.png");

  press(document.body, "Escape");
  expect(isOpen()).toBe(false);
});

test("the edge buttons step like the arrows, and every move resets zoom and pan", async () => {
  const [host] = await mount([{ path: "/fixture/gallery", lines: GALLERY }]);
  await open(host!, INBOX);
  expect(position()).toBe("4 / 6");
  const zoomIn = viewer()!.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;
  fire(zoomIn, clickAt(0, 0));
  expect(shown().getAttribute("style")).toContain("scale(1.4)");

  tap(step("next")!, 1400, 450, step("next")!, "touch");
  expect([position(), shown().getAttribute("src")]).toEqual(["5 / 6", FRAME]);
  expect(shown().getAttribute("style")).toContain("translate(0px, 0px) scale(1)");
  expect(viewer()!.querySelector('[aria-label="Reset zoom"]')!.textContent).toBe("100%");

  tap(step("previous")!, 40, 450);
  expect([position(), shown().getAttribute("src")]).toEqual(["4 / 6", INBOX]);

  /* The arrows reset the same way, after a zoom and after a pan. */
  const zoomed = () => [shown().getAttribute("style"), viewer()!.querySelector('[aria-label="Reset zoom"]')!.textContent];
  fire(zoomIn, clickAt(0, 0));
  expect(zoomed()).toEqual(["transform: translate(0px, 0px) scale(1.4);", "140%"]);
  press(document.body, "ArrowRight");
  expect([position(), ...zoomed()]).toEqual(["5 / 6", "transform: translate(0px, 0px) scale(1);", "100%"]);
  const area = shown().parentElement!;
  fire(shown(), pointer("pointerdown", 720, 450));
  fire(area, pointer("pointermove", 760, 480));
  fire(area, pointer("pointerup", 760, 480));
  fire(zoomIn, clickAt(0, 0));
  expect(zoomed()).toEqual(["transform: translate(56px, 42px) scale(1.4);", "140%"]);
  press(document.body, "ArrowLeft");
  expect([position(), ...zoomed()]).toEqual(["4 / 6", "transform: translate(0px, 0px) scale(1);", "100%"]);
});

test("a picture an answer shows twice opens at the copy that was clicked", async () => {
  const SAME = "/api/image?path=%2Fwork%2Fsame.png";
  const [host] = await mount([{ path: "/fixture/repeat", lines: [
    answer("a-repeat", 1, "First ![a](/work/same.png) then ![b](/work/other.png) and again ![c](/work/same.png)"),
  ] }]);
  const copies = () => [...host!.querySelectorAll(`[data-log-feed-scroller] img[src="${SAME}"]`)];
  expect(copies()).toHaveLength(2);

  fire(copies()[1]!, clickAt(0, 0));
  await wait();
  expect([position(), viewer()!.getAttribute("aria-label")]).toEqual(["3 / 3", "c"]);
  press(document.body, "ArrowRight");
  expect([position(), shown().getAttribute("alt")]).toEqual(["3 / 3", "c"]);
  expect(step("next")).toBeNull();
  press(document.body, "ArrowLeft");
  expect([position(), shown().getAttribute("alt")]).toEqual(["2 / 3", "b"]);
  press(document.body, "Escape");

  fire(copies()[0]!, clickAt(0, 0));
  await wait();
  expect([position(), viewer()!.getAttribute("aria-label")]).toEqual(["1 / 3", "a"]);
});

test("every copy opens at its own place, in bold, a table, a picture row, a tool's output and a teammate's summary", async () => {
  const SAME = "/api/image?path=%2Fwork%2Fsame.png";
  const frame = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: FRAME.split(",")[1] } };
  const [host] = await mount([{ path: "/fixture/copies", lines: [
    answer("a-copies", 1, "Inline ![one](/work/same.png) and **bold ![two](/work/same.png)**\n| shot | note |\n|---|---|\n| ![three](/work/same.png) | cell |\n![four](/work/same.png)\n![five](/work/same.png)"),
    line({ type: "assistant", uuid: "a-frames", timestamp: at(2), message: { role: "assistant", content: [
      { type: "tool_use", id: "toolu_frames", name: "Read", input: { file_path: "/work/frames.jpg" } },
    ] } }),
    line({ type: "user", uuid: "r-frames", timestamp: at(3), message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_frames", content: [frame, frame] },
    ] } }),
    line({ type: "user", uuid: "u-teammate", timestamp: at(4), message: { role: "user", content:
      '<teammate-message teammate_id="lead" summary="See ![six](/work/same.png)">and again ![seven](/work/same.png)</teammate-message>' } }),
  ] }]);
  const opened: (string | null)[][] = [];
  for (const src of [SAME, FRAME]) {
    const copies = [...host!.querySelectorAll(`[data-log-feed-scroller] img[src="${src}"]`)];
    for (const copy of copies) {
      fire(copy, clickAt(0, 0));
      await wait();
      opened.push([position(), shown().getAttribute("alt")]);
      press(document.body, "Escape");
    }
  }
  expect(opened.map(([place, alt]) => `${place} ${alt}`)).toEqual([
    "1 / 9 one", "2 / 9 two", "3 / 9 three", "4 / 9 four", "5 / 9 five", "8 / 9 six", "9 / 9 seven", "6 / 9 image", "7 / 9 image",
  ]);
});

/* Two answers around rows whose pictures the feed draws only after reading
   more than the row: `x` before them, `y` after them. */
const X = "/api/image?path=%2Fwork%2Fx.png";
const around = (...rows: string[]) => [answer("a-x", 1, "First ![x](/work/x.png)"), ...rows, answer("a-y", 9, "Then ![y](/work/y.png)")];
const sdkDelivery = (uuid: string, text: string) => line({ type: "user", uuid, timestamp: at(2), promptSource: "sdk",
  sessionId: "fixture-delivered", message: { role: "user", content: text } });
/* The pictures a feed draws, by alt; the product's own mark is no picture. */
const drawn = (host: Element) => [...host.querySelectorAll("[data-log-feed-scroller] img:not([data-brand-mark])")].map((img) => img.getAttribute("alt"));

/* Opens `x`, walks right to the end, and names each stop by place and alt. */
async function walkFromX(host: Element): Promise<string[]> {
  await open(host, X);
  const stops = [`${position()} ${shown().getAttribute("alt")}`];
  while (step("next")) {
    press(document.body, "ArrowRight");
    stops.push(`${position()} ${shown().getAttribute("alt")}`);
  }
  press(document.body, "Escape");
  return stops;
}

test("a delivered message the provenance read gives back to the operator is walked in its place", async () => {
  /* A structured Claude delivery parses as a system row; the feed draws it as
     the operator's bubble, pictures and all, once the provenance read names
     its author. */
  const MOCK = "/api/image?path=%2Fwork%2Fmock.png";
  provenance = { messages: { "sdk-delivered-1": { origin: "operator" } } };
  const [host] = await mount([{ path: "/fixture/delivered", lines: around(sdkDelivery("sdk-delivered-1", "compare with ![mock](/work/mock.png)")) }]);
  expect(host!.querySelector("[data-user-bubble]")?.textContent).toContain("compare with");
  expect(thumb(host!, MOCK)).not.toBeNull();

  expect(await walkFromX(host!)).toEqual(["1 / 3 x", "2 / 3 mock", "3 / 3 y"]);
  await open(host!, MOCK);
  expect(position()).toBe("2 / 3");
});

test("a review card's pictures are walked in the order the card draws them, each copy at its own place", async () => {
  const SAME = "/api/image?path=%2Fwork%2Fsame.png";
  const review = [
    "VERDICT: REQUEST_CHANGES",
    "The header overlaps ![summary](/work/same.png)",
    "1. P1 the button is cut off, per [the spec](/work/spec.md): ![title](/work/same.png)",
    "2. P2 the footer drifts ![shot](/work/shot.png)",
  ].join("\n");
  const [host] = await mount([{ path: "/fixture/review", lines: around(line({ type: "user", uuid: "u-review", timestamp: at(2), message: { role: "user", content:
    `<teammate-message teammate_id="reviewer" summary="Round one">${review}</teammate-message>` } })) }]);
  /* The summary, the first finding's title and its details, then the second
     finding's details: a title drops the first link it holds. */
  expect(drawn(host!)).toEqual(["x", "summary", "title", "title", "shot", "y"]);

  expect(await walkFromX(host!)).toEqual(["1 / 6 x", "2 / 6 summary", "3 / 6 title", "4 / 6 title", "5 / 6 shot", "6 / 6 y"]);
  const opened: (string | null)[] = [];
  for (const copy of host!.querySelectorAll(`[data-log-feed-scroller] img[src="${SAME}"]`)) {
    fire(copy, clickAt(0, 0));
    await wait();
    opened.push(position());
    press(document.body, "Escape");
  }
  expect(opened).toEqual(["2 / 6", "3 / 6", "4 / 6"]);
});

test("a delivered mandate is walked section by section, in the order its card draws them", async () => {
  const SAME = "/api/image?path=%2Fwork%2Fsame.png";
  provenance = { messages: { "sdk-mandate-1": { origin: "operator", mandate: { kind: "custom" } } } };
  const mandate = [
    "# Mandate", "Keep to ![rule](/work/rule.png)",
    "## Handoff from your predecessor", "Stopped at ![handoff](/work/same.png)",
    "## Initial status", "Report like ![status](/work/same.png)",
  ].join("\n");
  const [host] = await mount([{ path: "/fixture/mandate", lines: around(sdkDelivery("sdk-mandate-1", mandate)) }]);
  /* Both sections mount their text once opened; the list holds their pictures
     before that. */
  expect(drawn(host!)).toEqual(["x", "y"]);
  expect(await walkFromX(host!)).toEqual(["1 / 5 x", "2 / 5 rule", "3 / 5 status", "4 / 5 handoff", "5 / 5 y"]);

  for (const section of host!.querySelectorAll<HTMLDetailsElement>("[data-mandate-card] details")) {
    section.open = true;
    fire(section, new dom.Event("toggle") as unknown as Event);
  }
  expect(drawn(host!)).toEqual(["x", "rule", "status", "handoff", "y"]);
  const opened: (string | null)[] = [];
  for (const copy of host!.querySelectorAll(`[data-log-feed-scroller] img[src="${SAME}"]`)) {
    fire(copy, clickAt(0, 0));
    await wait();
    opened.push(`${position()} ${shown().getAttribute("alt")}`);
    press(document.body, "Escape");
  }
  expect(opened).toEqual(["3 / 5 status", "4 / 5 handoff"]);
});

test("a teammate's handshake is walked by the prose its card draws, never its summary or raw JSON", async () => {
  const plan = JSON.stringify({ type: "plan_approval_response", approve: false, feedback: "Redo it like ![plan](/work/plan.png)" });
  const unknown = JSON.stringify({ type: "custom_ping", note: "![raw](/work/raw.png)" });
  const teammate = (uuid: string, summary: string, body: string) => line({ type: "user", uuid, timestamp: at(2), message: { role: "user", content:
    `<teammate-message teammate_id="lead" summary="${summary}">${body}</teammate-message>` } });
  const [host] = await mount([{ path: "/fixture/protocol", lines: around(
    teammate("u-plan", "Plan ![summary](/work/summary.png)", plan),
    teammate("u-ping", "Ping", unknown),
  ) }]);
  expect(drawn(host!)).toEqual(["x", "plan", "y"]);
  expect(await walkFromX(host!)).toEqual(["1 / 3 x", "2 / 3 plan", "3 / 3 y"]);
});

test("a click on the dimmed area around the picture closes the viewer, and a click on the picture does not", async () => {
  const [host] = await mount([{ path: "/fixture/gallery", lines: GALLERY }]);
  await open(host!, AFTER);
  const area = shown().parentElement!;
  tap(shown(), 720, 450, area);
  expect(isOpen()).toBe(true);
  tap(viewer()!.querySelector('[aria-label="Zoom out"]')!, 1300, 20);
  expect(isOpen()).toBe(true);

  tap(area, 60, 450);
  expect(isOpen()).toBe(false);

  /* A tap on a phone closes it the same way. */
  await open(host!, AFTER);
  tap(shown().parentElement!, 20, 800, shown().parentElement!, "touch");
  expect(isOpen()).toBe(false);
});

test("a pan that ends off the picture keeps the viewer open, and a still click there then closes it", async () => {
  const [host] = await mount([{ path: "/fixture/gallery", lines: GALLERY }]);
  await open(host!, FRAME);
  const area = shown().parentElement!;
  fire(shown(), pointer("pointerdown", 720, 450));
  fire(area, pointer("pointermove", 900, 700));
  fire(area, pointer("pointerup", 1300, 860));
  fire(area, clickAt(1300, 860));
  expect(isOpen()).toBe(true);
  expect(shown().getAttribute("style")).toContain("translate(180px, 250px)");

  fire(area, pointer("pointerdown", 40, 60));
  fire(area, pointer("pointermove", 180, 60));
  fire(area, pointer("pointerup", 180, 60));
  fire(area, clickAt(180, 60));
  expect(isOpen()).toBe(true);

  tap(area, 40, 60);
  expect(isOpen()).toBe(false);
});

test("arrows typed in a text field stay in the field, and step once focus leaves it", async () => {
  const [host] = await mount([{ path: "/fixture/gallery", lines: GALLERY }]);
  const field = document.createElement("textarea");
  document.body.append(field);
  await open(host!, BEFORE);
  field.focus();
  press(field, "ArrowRight");
  press(field, "ArrowLeft");
  press(field, "ArrowRight");
  expect([position(), shown().getAttribute("src")]).toEqual(["2 / 6", BEFORE]);

  field.blur();
  press(document.body, "ArrowRight");
  expect([position(), shown().getAttribute("src")]).toEqual(["3 / 6", AFTER]);
});

test("only the shown picture and its two neighbours load, and a move shows the neighbour already loaded", async () => {
  const [host] = await mount([{ path: "/fixture/gallery", lines: GALLERY }]);
  /* The viewer asks for the very URL the thumbnail loaded, so the browser
     hands back the picture it already has. */
  const thumbnail = thumb(host!, AFTER)!.getAttribute("src");
  await open(host!, AFTER);
  const mounted = () => [...viewer()!.querySelectorAll("img")].map((img) => [img.getAttribute("src"), img.hasAttribute("hidden")]);
  expect(shown().getAttribute("src")).toBe(thumbnail);
  expect(mounted()).toEqual([[BEFORE, true], [AFTER, false], [INBOX, true]]);

  /* Walk to the end and back, recording every image element the viewer ever
     created: one per picture, and each one reused when its turn comes. */
  const created = new Map<string, Set<Element>>();
  const record = () => {
    for (const img of viewer()!.querySelectorAll("img")) {
      const src = img.getAttribute("src")!;
      created.set(src, (created.get(src) ?? new Set()).add(img));
    }
  };
  record();
  const next = viewer()!.querySelector(`img[src="${INBOX}"]`)!;
  press(document.body, "ArrowRight");
  expect(shown()).toBe(next as HTMLImageElement);
  expect(mounted()).toEqual([[AFTER, true], [INBOX, false], [FRAME, true]]);
  record();
  for (let i = 0; i < 2; i += 1) { press(document.body, "ArrowRight"); record(); }
  expect(mounted()).toEqual([[FRAME, true], [FINAL, false]]);
  for (const [src, elements] of created) expect([src, elements.size]).toEqual([src, 1]);
  expect([...created.keys()].sort()).toEqual([BEFORE, AFTER, INBOX, FRAME, FINAL].sort());
  expect(created.has(PASTED)).toBe(false);
});

test("a picture whose row the feed has not mounted is still reached", async () => {
  /* A compact pane mounts its last 300 rows; the pasted picture sits above
     them, so no element of the page holds it. */
  const filler = Array.from({ length: 320 }, (_, i) => answer(`a-fill-${i}`, 10 + i, `step ${i}`));
  const lines = [GALLERY[0]!, ...filler, ...GALLERY.slice(1)];
  const [host] = await mount([{ path: "/fixture/long", lines, compact: true }]);
  expect(thumb(host!, PASTED)).toBeNull();
  expect(thumb(host!, BEFORE)).not.toBeNull();
  await open(host!, BEFORE);
  expect(position()).toBe("2 / 6");
  press(document.body, "ArrowLeft");
  expect([position(), shown().getAttribute("src")]).toEqual(["1 / 6", PASTED]);
});

test("two conversations side by side keep separate lists", async () => {
  const other = [
    answer("b-one", 1, "First: ![one](/work/other-one.png)"),
    answer("b-two", 2, "Second: ![two](/work/other-two.png)"),
  ];
  const [left, right] = await mount([{ path: "/fixture/gallery", lines: GALLERY }, { path: "/fixture/other", lines: other }]);
  await open(right!, "/api/image?path=%2Fwork%2Fother-one.png");
  expect(position()).toBe("1 / 2");
  press(document.body, "ArrowRight");
  expect(shown().getAttribute("src")).toBe("/api/image?path=%2Fwork%2Fother-two.png");
  press(document.body, "ArrowRight");
  expect(position()).toBe("2 / 2");
  press(document.body, "Escape");

  await open(left!, FINAL);
  expect(position()).toBe("6 / 6");
});

test("opening the viewer and stepping re-render no feed and remount no row", async () => {
  const [host] = await mount([{ path: "/fixture/gallery", lines: GALLERY }]);
  const rows = [...host!.querySelectorAll("[data-feed-key]")];
  const before = renders;
  await open(host!, PASTED);
  press(document.body, "ArrowRight");
  press(document.body, "ArrowRight");
  expect(position()).toBe("3 / 6");
  expect(renders).toBe(before);
  expect([...host!.querySelectorAll("[data-feed-key]")]).toEqual(rows);
});
