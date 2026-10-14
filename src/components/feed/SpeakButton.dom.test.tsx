import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { Profiler } from "react";

import { MAX_TTS_MESSAGE_LENGTH } from "@/lib/tts";
import { chunkSpeech, MAX_CHUNK_CHARS } from "@/lib/ttsChunks";

import { SpeakButton } from "./SpeakButton";
import { chunksCached, clearTtsCache, evictTtsAudio, voiceKey } from "./ttsSession";

test("a scoped speech header server-renders before its client snapshot exists", () => {
  const html = renderToStaticMarkup(<SpeakButton scope="ssr-speech-header" header />);
  expect(html).toContain("<button");
  expect(html).toContain("disabled");
});

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  Text: dom.Text,
  Range: dom.Range,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
});

/** The CSS Custom Highlight API, which happy-dom does not ship. */
class FakeHighlight {
  ranges: Range[] = [];
  add(range: Range) { this.ranges.push(range); }
  clear() { this.ranges = []; }
}
const highlights = new Map<string, FakeHighlight>();
Object.assign(globalThis, { Highlight: FakeHighlight, CSS: { highlights } });

const originalFetch = globalThis.fetch;
const originalAudio = globalThis.Audio;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const backendInfo = {
  backend: "openai",
  lockedByEnv: false,
  options: [
    { id: "openai", available: true, keyPath: "/keys/openai", model: "gpt-4o-mini-tts", voice: "alloy", cap: 4000 },
    { id: "elevenlabs", available: false, keyPath: "/keys/elevenlabs", model: "eleven_v4_turbo", voice: "Rachel", cap: 4000 },
  ],
};

/**
 * Audio that refuses to play until a muted silent clip has carried the user
 * gesture into it — the autoplay policy the Speak control works around, now
 * across a whole sequence of chunks instead of one clip.
 */
class FakeAudio {
  static instances: FakeAudio[] = [];
  muted = false;
  src = "";
  currentTime = 0;
  duration = 10;
  paused = true;
  private unlocked = false;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(src = "") {
    this.src = src;
    FakeAudio.instances.push(this);
  }
  load() {}
  pause() { this.paused = true; }
  async play() {
    if (this.muted && this.src.startsWith("data:audio/wav")) this.unlocked = true;
    if (!this.unlocked) throw new DOMException("blocked", "NotAllowedError");
    this.paused = false;
    this.onloadedmetadata?.();
  }
  tick(time: number) { this.currentTime = time; this.ontimeupdate?.(); }
  finish() { this.currentTime = this.duration; this.paused = true; this.onended?.(); }
}

function useFakeAudio(): void {
  FakeAudio.instances = [];
  globalThis.Audio = FakeAudio as unknown as typeof Audio;
}

/** The element a chunk is playing on, if any. */
function playing(): FakeAudio | undefined {
  return FakeAudio.instances.find((element) => !element.paused && element.src.startsWith("blob:"));
}

async function drainUpdates(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function mount(text: string): Promise<{ button: HTMLButtonElement; root: Root; host: HTMLDivElement }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => { root.render(<SpeakButton text={text} />); });
  await drainUpdates();
  return { button: host.querySelector("button")!, root, host };
}

/** The Speak control inside the feed markup that carries the rendered answer. */
async function mountInFeed(text: string): Promise<{ button: HTMLButtonElement; root: Root; host: HTMLDivElement; body: HTMLElement }> {
  const host = document.createElement("div");
  host.setAttribute("data-feed-kind", "prose");
  document.body.append(host);
  const controls = document.createElement("div");
  controls.setAttribute("data-tts-message", "");
  const slot = document.createElement("span");
  const body = document.createElement("div");
  body.setAttribute("data-tts-body", "");
  body.append(document.createTextNode(text));
  controls.append(slot, body);
  host.append(controls);
  const root = createRoot(slot);
  flushSync(() => { root.render(<SpeakButton text={text} />); });
  await drainUpdates();
  return { button: slot.querySelector("button")!, root, host, body };
}

/** Ends every chunk in turn, the way the browser would, until nothing plays. */
async function playToEnd(): Promise<void> {
  for (let guard = 0; guard < 200; guard += 1) {
    const element = playing();
    if (!element) return;
    element.finish();
    await drainUpdates();
  }
  throw new Error("playback never finished");
}

/** The left click: the whole play path since #1024. */
async function speak(view: { button: HTMLButtonElement }): Promise<void> {
  flushSync(() => { view.button.click(); });
  await drainUpdates();
}

/** The right click, and the menu it opens. */
async function openMenu(view: { button: HTMLButtonElement }): Promise<HTMLElement> {
  flushSync(() => {
    view.button.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  await drainUpdates();
  return document.querySelector("[data-tts-menu]") as HTMLElement;
}

function menuOpen(): boolean {
  return document.querySelector("[data-tts-menu]") !== null;
}

/* The refusal/error popover. Portalled to the body like the menu (#1024): an
   inline `absolute` alert is clipped by the message row's paint containment
   and painted over by the next message, and since the left click speaks it is
   the only feedback a refused click gives. */
function alertNode(): HTMLElement | null {
  return document.querySelector("[data-tts-alert]") as HTMLElement | null;
}

/* Where the trigger sits on screen. happy-dom lays nothing out — every rect is
   zeros — so the tests that care where the anchored popovers land, and whether
   their trigger is still on screen at all, say so themselves. */
function placeTrigger(button: HTMLButtonElement, top: number): void {
  button.getBoundingClientRect = () =>
    ({ top, bottom: top + 24, left: 400, right: 500, width: 100, height: 24, x: 400, y: top, toJSON: () => ({}) }) as DOMRect;
}

/** A scroll anywhere in the page, which every anchored popover re-measures on. */
async function scrollPage(): Promise<void> {
  flushSync(() => {
    document.body.dispatchEvent(new dom.Event("scroll", { bubbles: true }) as unknown as Event);
  });
  await drainUpdates();
}

/** Escape, from wherever the focus happens to be. */
async function pressEscape(): Promise<void> {
  flushSync(() => {
    document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  });
  await drainUpdates();
}

/* The TTS configuration is one module-level singleton shared by every control
   on the page (one fetch, all controls in step), and only a right-click menu
   re-reads it. So the two tests that change the active provider come LAST in
   this file: a test that left `elevenlabs` behind would refuse to speak in
   every test declared after it. */
const LONG = Array.from({ length: 40 }, (_, index) => `Sentence number ${index} of a long agent answer that must be voiced in full.`).join(" ");

beforeEach(() => {
  clearTtsCache();
  highlights.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.Audio = originalAudio;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  document.body.replaceChildren();
});

/* The operator's complaint in #1024: the left click opened a confirm popover
   instead of speaking. Nothing may stand between the click and the audio. */
test("a left click starts synthesis at once, with no dialog in between", async () => {
  const sent: string[] = [];
  let configRequests = 0;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) { configRequests += 1; return Response.json(backendInfo); }
    sent.push(String(input));
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  useFakeAudio();

  const view = await mount("Read me at once");
  const other = await mount("Another answer");
  /* One configuration load for every control on the page, and it is the mount
     that pays for it — the click path never waits on the network twice. */
  expect(configRequests).toBe(1);
  await speak(view);

  expect(sent).toEqual(["/api/tts"]);
  expect(playing()).toBeDefined();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(menuOpen()).toBe(false);
  expect(view.button.getAttribute("aria-label")).toContain("Stop");

  /* Clicking again stops, and nothing else was bought on the way. */
  await speak(view);
  expect(playing()).toBeUndefined();
  expect(sent).toEqual(["/api/tts"]);
  expect(view.button.getAttribute("aria-label")).not.toContain("Stop");
  flushSync(() => { view.root.unmount(); });
  flushSync(() => { other.root.unmount(); });
  view.host.remove();
  other.host.remove();
});

test("a second click cancels pending synthesis and ignores its stale response", async () => {
  let resolvePost!: (response: Response) => void;
  let postSignal: AbortSignal | undefined;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    postSignal = init.signal as AbortSignal;
    return new Promise<Response>((resolve) => { resolvePost = resolve; });
  }) as unknown as typeof fetch;
  const createObjectURL = mock(() => "blob:tts");
  URL.createObjectURL = createObjectURL;
  useFakeAudio();

  const view = await mount("Read me");
  const other = await mount("Another answer");
  await speak(view);
  expect(view.button.getAttribute("aria-label")).toContain("Stop");
  flushSync(() => { view.button.click(); });
  await drainUpdates();
  expect(postSignal?.aborted).toBe(true);

  resolvePost(new Response(new Blob(["late"])));
  await drainUpdates();
  expect(createObjectURL).not.toHaveBeenCalled();
  flushSync(() => { view.root.unmount(); });
  flushSync(() => { other.root.unmount(); });
  view.host.remove();
  other.host.remove();
});

test("a long answer is chunked, synthesized in parallel and played from the first chunk", async () => {
  const sent: string[] = [];
  const pending = new Map<string, (response: Response) => void>();
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    const text = (JSON.parse(String(init.body)) as { text: string }).text;
    sent.push(text);
    return new Promise<Response>((resolve) => pending.set(text, resolve));
  }) as unknown as typeof fetch;
  URL.createObjectURL = mock((blob: Blob) => `blob:${(blob as Blob & { id?: string }).id ?? "chunk"}`);
  useFakeAudio();

  const view = await mount(LONG);
  await speak(view);

  /* Two chunks are in flight at once, and neither covers the whole message. */
  expect(sent.length).toBe(2);
  for (const text of sent) expect(text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  expect(playing()).toBeUndefined();

  /* The first chunk alone starts the voice; the rest are still synthesizing. */
  pending.get(sent[0]!)!(new Response(new Blob(["audio-0"])));
  await drainUpdates();
  expect(playing()).toBeDefined();
  expect(view.button.getAttribute("aria-label")).toContain("Stop");
  expect(pending.has(sent[1]!)).toBe(true);

  for (const [text, resolve] of [...pending]) {
    resolve(new Response(new Blob([`audio-${text.length}`])));
    await drainUpdates();
  }

  /* Nothing was truncated: the chunks reassemble the whole answer. */
  expect(sent.join(" ")).toBe(LONG);
  expect(sent.length).toBeGreaterThan(2);
  expect(alertNode()).toBeNull();
  flushSync(() => { view.button.click(); view.root.unmount(); });
  view.host.remove();
});

test("a message read to the end replays free, and an evicted one says it costs again", async () => {
  let posts = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    posts += 1;
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  URL.revokeObjectURL = mock(() => {});
  useFakeAudio();

  const view = await mount(LONG);
  await speak(view);
  await playToEnd();
  const synthesized = posts;
  expect(synthesized).toBeGreaterThan(1);

  /* Read to the end with every chunk cached: the replay is genuinely free, and
     both the tooltip and the menu say exactly that. */
  expect(view.button.getAttribute("title")).toBe("Replay aloud (free) · right-click: voice & billing");
  const menu = await openMenu(view);
  expect(menu.textContent).toContain("Next click: free replay from the cache");
  expect(menu.textContent).not.toContain("Next click: paid");
  flushSync(() => { view.button.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event); });
  await drainUpdates();

  await speak(view);
  expect(posts).toBe(synthesized);
  expect(view.button.getAttribute("aria-label")).toContain("Stop");
  expect(alertNode()).toBeNull();
  await speak(view);

  /* Evicted between the render that promised a free replay and the click that
     took it: the audio still starts, and the control says out loud that this
     one is paid instead of letting the stale label pass for free. */
  evictTtsAudio();
  await speak(view);
  expect(posts).toBeGreaterThan(synthesized);
  expect(alertNode()!.textContent).toBe("Cached audio expired — this replay is a paid synthesis.");
  flushSync(() => { view.button.click(); view.root.unmount(); });
  view.host.remove();
});

/* The operator paid for ONE read-aloud. Stopping it after the first of two
   dozen chunks must not turn the control into a free-replay button that
   silently buys the other twenty-three. */
test("a message stopped after the first chunk never advertises a free replay", async () => {
  let posts = 0;
  const pending = new Map<string, (response: Response) => void>();
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    posts += 1;
    const text = (JSON.parse(String(init.body)) as { text: string }).text;
    return new Promise<Response>((resolve) => pending.set(text, resolve));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  useFakeAudio();

  const view = await mount(LONG);
  await speak(view);
  const [first] = [...pending.keys()];
  pending.get(first!)!(new Response(new Blob(["audio"])));
  await drainUpdates();
  expect(playing()).toBeDefined();

  await speak(view);
  const paidForFirstChunk = posts;

  expect(view.button.getAttribute("title")).toBe("Read aloud (paid) · right-click: voice & billing");
  expect(view.button.getAttribute("aria-label")).toBe("Read answer aloud");
  const menu = await openMenu(view);
  expect(menu.textContent).toContain("Next click: paid synthesis of this answer");
  expect(menu.textContent).toContain("Billed to your OpenAI account per character");
  expect(menu.textContent).toContain("AI-generated voice");
  expect(menu.textContent).not.toContain("free replay");

  /* And the next click does pay — immediately, without asking. */
  await speak(view);
  expect(posts).toBeGreaterThan(paidForFirstChunk);
  flushSync(() => { view.button.click(); view.root.unmount(); });
  view.host.remove();
});

/* The menu is where the paid/cached truth lives since #1024, so it may not
   state what the next click costs from a snapshot taken before playback began
   or before another card evicted these chunks. */
test("the menu's cost line follows playback and cache eviction while it is open", async () => {
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  URL.revokeObjectURL = mock(() => {});
  useFakeAudio();

  const view = await mount(LONG);
  await speak(view);
  await playToEnd();

  const cached = await openMenu(view);
  expect(cached.textContent).toContain("Next click: free replay from the cache");

  /* Evicted from under an OPEN menu — nothing re-renders the control, so the
     menu has to hear it from the cache itself. */
  flushSync(() => { evictTtsAudio(); });
  await drainUpdates();
  expect(cached.textContent).toContain("Next click: paid synthesis of this answer");
  expect(cached.textContent).not.toContain("free replay");

  flushSync(() => {
    document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  });
  await drainUpdates();

  /* Right-click while it is reading: the next left click stops, and costs
     nothing either way. */
  await speak(view);
  expect(playing()).toBeDefined();
  const reading = await openMenu(view);
  expect(reading.textContent).toContain("Next click: stop reading this answer");
  expect(reading.textContent).not.toContain("paid synthesis");
  expect(reading.textContent).not.toContain("free replay");

  flushSync(() => { view.button.click(); view.root.unmount(); });
  view.host.remove();
});

test("a message past the ceiling refuses out loud instead of being cut short", async () => {
  let posts = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    posts += 1;
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  useFakeAudio();

  const view = await mount("word ".repeat(MAX_TTS_MESSAGE_LENGTH / 4));
  await speak(view);

  const alert = alertNode()!;
  expect(alert.textContent).toContain(`Too long to read aloud (${MAX_TTS_MESSAGE_LENGTH.toLocaleString()} character limit)`);
  expect(posts).toBe(0);
  expect(playing()).toBeUndefined();
  /* And it is a popover on the body, not a box inside the message: the feed row
     carries `content-visibility: auto`, whose paint containment clips an inline
     `absolute` alert and lets the next message paint over what survives. A key
     path wider than the box still breaks, but words wrap at spaces. */
  expect(alert.parentElement).toBe(document.body as unknown as HTMLElement);
  expect(view.host.contains(alert)).toBe(false);
  expect(alert.className).toContain("fixed");
  expect(alert.className).toContain("break-words");
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

/* #1030: portalling the refusal to `fixed` coordinates took away the only exit
   it had — scrolling out of sight with its message — and the placement math
   clamps a scrolled-away anchor back on screen, so the red box parked itself at
   the top of the viewport for the rest of the session. The only thing that
   cleared it was clicking Speak again, i.e. buying another synthesis. */
test("a refusal is dismissed by Escape or a click away, with nothing bought", async () => {
  let posts = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    posts += 1;
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  useFakeAudio();

  const view = await mount("word ".repeat(MAX_TTS_MESSAGE_LENGTH / 4));
  await speak(view);
  expect(alertNode()).not.toBeNull();

  await pressEscape();
  expect(alertNode()).toBeNull();

  /* Refused again, and this time dismissed by a click elsewhere — but not by a
     pointerdown inside the alert itself, which is how the key path it names
     stays selectable. */
  await speak(view);
  const alert = alertNode()!;
  flushSync(() => {
    alert.dispatchEvent(new dom.MouseEvent("pointerdown", { bubbles: true }) as unknown as Event);
  });
  await drainUpdates();
  expect(alertNode()).not.toBeNull();
  flushSync(() => {
    document.body.dispatchEvent(new dom.MouseEvent("pointerdown", { bubbles: true }) as unknown as Event);
  });
  await drainUpdates();
  expect(alertNode()).toBeNull();

  /* Nothing above was a synthesis: a refusal now ends for free. */
  expect(posts).toBe(0);
  expect(playing()).toBeUndefined();

  /* And the menu still owns Escape while it is open: the first press closes the
     menu and hands focus back — the refusal it was carrying as its notice is
     untouched, and reappears as its own popover — and only the next press
     dismisses that. */
  await speak(view);
  expect(alertNode()).not.toBeNull();
  await openMenu(view);
  expect(alertNode()).toBeNull();
  await pressEscape();
  expect(menuOpen()).toBe(false);
  expect(document.activeElement).toBe(view.button);
  expect(alertNode()!.textContent).toContain("Too long to read aloud");
  await pressEscape();
  expect(alertNode()).toBeNull();

  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

/* The other half of #1030: the alert is anchored to the trigger, so it follows
   the trigger while the feed scrolls and leaves with it — rather than being
   clamped back onto the viewport edge over whatever the operator scrolls to. */
test("the refusal alert tracks its trigger on scroll and leaves the screen with it", async () => {
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    throw new Error("unexpected synthesis");
  }) as unknown as typeof fetch;
  useFakeAudio();

  const view = await mount("word ".repeat(MAX_TTS_MESSAGE_LENGTH / 4));
  placeTrigger(view.button, 300);
  await speak(view);
  await scrollPage();
  /* Under the trigger, right edges aligned: the same placement as the menu. */
  expect(alertNode()!.style.top).toBe("332px");
  expect(alertNode()!.style.left).toBe("276px");

  /* Scrolled 2000px above the fold, the anchor is gone — and so is the alert,
     instead of clamping to `top: 8`. */
  placeTrigger(view.button, -2000);
  await scrollPage();
  expect(alertNode()).toBeNull();

  /* Scrolled back to it, the refusal is still there to read. */
  placeTrigger(view.button, 200);
  await scrollPage();
  expect(alertNode()!.textContent).toContain("Too long to read aloud");
  expect(alertNode()!.style.top).toBe("232px");

  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

test("a chunk failure mid-sequence surfaces the provider error and stops cleanly", async () => {
  let posts = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    posts += 1;
    if (posts === 1) return new Response(new Blob(["audio"]));
    return Response.json({ error: "openai TTS failed (HTTP 401)" }, { status: 502 });
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  useFakeAudio();

  const view = await mount(LONG);
  await speak(view);

  const alert = alertNode()!;
  expect(alert.textContent).toBe("openai TTS failed (HTTP 401)");
  expect(view.button.getAttribute("aria-label")).not.toContain("Stop");
  expect(FakeAudio.instances.every((element) => element.paused)).toBe(true);
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

test("audio the browser refuses to play reports that, not a provider failure", async () => {
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  FakeAudio.instances = [];
  globalThis.Audio = class extends FakeAudio {
    override async play() {
      await super.play();
      /* Unlocked on the silent clip, blocked on the real one. */
      if (this.src.startsWith("blob:")) throw new DOMException("blocked", "NotAllowedError");
    }
  } as unknown as typeof Audio;

  const view = await mount("A short answer to read.");
  await speak(view);

  expect(alertNode()!.textContent).toBe("The browser blocked audio playback. Try again.");
  expect(view.button.getAttribute("aria-label")).not.toContain("Stop");
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

test("the spoken word is highlighted in the rendered answer and a click in it seeks", async () => {
  const sent: string[] = [];
  const pending = new Map<string, (response: Response) => void>();
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    const text = (JSON.parse(String(init.body)) as { text: string }).text;
    sent.push(text);
    if (sent.length === 1) return new Response(new Blob(["audio"]));
    return new Promise<Response>((resolve) => pending.set(text, resolve));
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  useFakeAudio();

  const view = await mountInFeed(LONG);
  await speak(view);
  const element = playing()!;
  expect(element).toBeDefined();

  /* Halfway through the first chunk's audio, halfway through its words. */
  element.tick(5);
  await drainUpdates();
  const paint = highlights.get("tts-karaoke")!;
  expect(paint.ranges).toHaveLength(1);
  const spoken = paint.ranges[0]!.toString();
  expect(spoken.trim()).not.toBe("");
  expect(LONG.slice(0, sent[0]!.length)).toContain(spoken);

  /* A click deep in the answer seeks there — that chunk is queued for it. */
  const node = view.body.firstChild!;
  const target = LONG.lastIndexOf("Sentence number 39");
  Object.assign(document, { caretPositionFromPoint: () => ({ offsetNode: node, offset: target }) });
  flushSync(() => {
    view.body.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as MouseEvent);
  });
  await drainUpdates();
  const seeked = sent.at(-1)!;
  expect(seeked).toContain("Sentence number 39");
  expect(element.paused).toBe(true);

  /* Stopping takes the highlight and the seek affordance away again. */
  flushSync(() => { view.button.click(); });
  await drainUpdates();
  expect(highlights.has("tts-karaoke")).toBe(false);
  expect(view.body.hasAttribute("data-tts-seekable")).toBe(false);
  Object.assign(document, { caretPositionFromPoint: undefined });
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

test("the right-click menu opens outside the message, and Escape closes it back onto the trigger", async () => {
  let posts = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    posts += 1;
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  useFakeAudio();

  const view = await mount("Menu answer");
  const menu = await openMenu(view);

  /* Portalled to the body, so no feed overflow and no later message can clip
     it — the message's own subtree does not contain it. */
  expect(menu).not.toBeNull();
  expect(menu.parentElement).toBe(document.body as unknown as HTMLElement);
  expect(view.host.contains(menu)).toBe(false);
  expect(menu.className).toContain("fixed");
  expect(view.button.getAttribute("aria-expanded")).toBe("true");
  expect(menu.contains(document.activeElement as Node)).toBe(true);
  expect(menu.textContent).toContain("Voice & billing");
  expect(menu.textContent).toContain("11 characters");
  expect([...menu.querySelectorAll('[role="menuitemradio"]')].map((row) => row.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  /* Opening the menu buys nothing. */
  expect(posts).toBe(0);

  flushSync(() => {
    document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  });
  await drainUpdates();
  expect(menuOpen()).toBe(false);
  expect(document.activeElement).toBe(view.button);
  expect(view.button.getAttribute("aria-expanded")).toBe("false");
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

test("an outside pointerdown closes the menu, and a second right-click toggles it shut", async () => {
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(backendInfo);
    throw new Error("unexpected synthesis");
  }) as unknown as typeof fetch;
  useFakeAudio();

  const view = await mount("Dismissal answer");
  await openMenu(view);
  flushSync(() => {
    document.body.dispatchEvent(new dom.MouseEvent("pointerdown", { bubbles: true }) as unknown as Event);
  });
  await drainUpdates();
  expect(menuOpen()).toBe(false);

  await openMenu(view);
  expect(menuOpen()).toBe(true);
  /* The right-click's own pointerdown lands on the trigger and must not close
     the menu out from under the contextmenu that follows it. */
  flushSync(() => {
    view.button.dispatchEvent(new dom.MouseEvent("pointerdown", { bubbles: true }) as unknown as Event);
  });
  await drainUpdates();
  expect(menuOpen()).toBe(true);
  await openMenu(view);
  expect(menuOpen()).toBe(false);
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

test("the menu switches provider, and every answer control follows", async () => {
  const elevenInfo = {
    ...backendInfo,
    backend: "elevenlabs",
    options: backendInfo.options.map((option) => option.id === "elevenlabs" ? { ...option, available: true } : option),
  };
  let current = backendInfo;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/tts/backend" && init?.method === "POST") {
      current = elevenInfo;
      return Response.json(current);
    }
    if (url === "/api/tts/backend") return Response.json(current);
    throw new Error("unexpected synthesis");
  }) as unknown as typeof fetch;

  const first = await mount("Provider first");
  const second = await mount("Provider second");
  const menu = await openMenu(first);
  const eleven = [...menu.querySelectorAll("button")].find((button) => button.textContent?.startsWith("ElevenLabs"))!;
  flushSync(() => { eleven.click(); });
  await drainUpdates();
  expect(menuOpen()).toBe(false);

  const other = await openMenu(second);
  expect(other.textContent).toContain("ElevenLabs · eleven_v4_turbo · Rachel");
  expect(first.button.getAttribute("title")).toBe("Read aloud (paid) · right-click: voice & billing");
  flushSync(() => { first.root.unmount(); second.root.unmount(); });
  first.host.remove();
  second.host.remove();
});

test("a provider with no key refuses out loud and names the file to drop it into", async () => {
  const noKey = { ...backendInfo, backend: "elevenlabs" };
  let posts = 0;
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Response.json(noKey);
    posts += 1;
    return new Response(new Blob(["audio"]));
  }) as unknown as typeof fetch;
  useFakeAudio();

  const view = await mount("Nothing can read this");
  /* Opening the menu is what re-reads the configuration, so the control learns
     the provider changed under it without a round trip on the play path. */
  const menu = await openMenu(view);
  expect(menu.textContent).toContain("Add the ElevenLabs API key at /keys/elevenlabs");
  /* And the tooltip, the surface that has to be right BEFORE the click, names
     the missing key instead of promising a paid read it cannot perform
     (#1030). */
  expect(view.button.getAttribute("title")).toBe("Add the ElevenLabs API key at /keys/elevenlabs");
  flushSync(() => {
    document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  });
  await drainUpdates();
  await speak(view);

  expect(posts).toBe(0);
  expect(alertNode()!.textContent).toBe("Add the ElevenLabs API key at /keys/elevenlabs");
  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

/* Declared LAST: it leaves `elevenlabs` behind in the module-level singleton.

   The tab's copy of the configuration is fetched once per page load, so an
   operator who switches provider in a second tab leaves this one asking for a
   provider the server no longer uses. The route says who it actually billed,
   and the answer — not the belief — decides the cache key and the name on the
   surface (#1024). */
test("a provider switched under a stale tab is keyed and named by what the route billed", async () => {
  const TEXT = "Billed somewhere else entirely.";
  const elevenActive = {
    ...backendInfo,
    backend: "elevenlabs",
    options: backendInfo.options.map((option) => (option.id === "elevenlabs" ? { ...option, available: true } : option)),
  };
  let served = backendInfo;
  let posts = 0;
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    if (String(input) === "/api/tts/backend") return Response.json(served);
    posts += 1;
    /* The server is on ElevenLabs now, whatever this tab believes. */
    return new Response(new Blob(["audio"]), {
      headers: { "x-tts-backend": "elevenlabs", "x-tts-model": "eleven_v4_turbo", "x-tts-voice": "Rachel" },
    });
  }) as unknown as typeof fetch;
  URL.createObjectURL = () => "blob:tts";
  useFakeAudio();

  const view = await mount(TEXT);
  /* This tab last read the configuration while openai was active. */
  const before = await openMenu(view);
  expect(before.textContent).toContain("OpenAI · gpt-4o-mini-tts · alloy");
  flushSync(() => {
    document.body.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event);
  });
  await drainUpdates();

  served = elevenActive;
  await speak(view);
  await playToEnd();
  expect(posts).toBeGreaterThan(0);

  /* Nothing was filed under the voice this tab named on its way out... */
  const texts = chunkSpeech(TEXT).map((chunk) => chunk.text);
  expect(chunksCached(texts.map((text) => voiceKey({ id: "openai", model: "gpt-4o-mini-tts", voice: "alloy" }, text)))).toBe(false);
  /* ...and everything under the one that answered. */
  expect(chunksCached(texts.map((text) => voiceKey({ id: "elevenlabs", model: "eleven_v4_turbo", voice: "Rachel" }, text)))).toBe(true);

  /* And the surface names the provider that was charged, without the click
     having waited on /api/tts/backend to find out. */
  expect(alertNode()!.textContent).toBe("The voice provider changed — this read is billed to ElevenLabs.");
  const after = await openMenu(view);
  expect(after.textContent).toContain("ElevenLabs · eleven_v4_turbo · Rachel");
  expect(after.textContent).toContain("Billed to your ElevenLabs account per character");
  // A legacy MP3 response cannot be replayed by the new ElevenLabs PCM player.
  expect(after.textContent).toContain("Next click: paid synthesis of this answer");

  flushSync(() => { view.root.unmount(); });
  view.host.remove();
});

test("Soniox header freezes its target, shares Stop with the row, and cancels while loading", async () => {
  const { conversationSpeech } = await import("./conversationSpeech");
  const originalContext = globalThis.AudioContext;
  const priorRaf = globalThis.requestAnimationFrame, priorCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 16) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  const resumes: (() => void)[] = [];
  let closed = 0;
  globalThis.AudioContext = class {
    state = "running";
    resume() { return new Promise<void>((resolve) => resumes.push(resolve)); }
    async close() { closed++; }
  } as unknown as typeof AudioContext;
  const info = { backend: "soniox", lockedByEnv: false, options: [{ id: "soniox", available: true, keyPath: "$CONFIG/soniox-api-key", model: "tts-rt-v2", voice: "Adrian", language: "en", cap: 4000 }] };
  const requests: string[] = [];
  globalThis.fetch = mock(async (_input, init) => {
    if (!init?.method) return Response.json(info);
    requests.push(JSON.parse(String(init.body)).text);
    return new Promise<Response>(() => undefined);
  }) as unknown as typeof fetch;
  const scope = "header-test";
  const speech = conversationSpeech(scope);
  speech.select({ id: "old", text: "Frozen answer.", roots: () => [] });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  flushSync(() => root.render(<><SpeakButton scope={scope} header /><SpeakButton scope={scope} text="Frozen answer." answerId="old" /></>));
  await drainUpdates();
  const header = host.querySelector<HTMLButtonElement>("[data-tts-header]")!;
  header.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true })); await drainUpdates(); // fresh authoritative config
  try {
    flushSync(() => header.click()); await drainUpdates();
    expect(header.dataset.ttsPhase).toBe("loading"); expect(header.getAttribute("aria-busy")).toBe("true");
    expect(host.querySelectorAll('[data-tts-phase="loading"]')).toHaveLength(2);
    speech.select({ id: "new", text: "Newly visible answer.", roots: () => [] }); await drainUpdates();
    expect(speech.getSnapshot().activeText).toBe("Frozen answer.");
    flushSync(() => root.render(<><SpeakButton scope={scope} header /><SpeakButton scope={scope} text="Frozen answer grows." answerId="old" /></>));
    await drainUpdates();
    const row = host.querySelector<HTMLButtonElement>("[data-tts-trigger]:not([data-tts-header])")!;
    expect(row.dataset.ttsPhase).toBe("loading");
    flushSync(() => row.click()); await drainUpdates();
    expect(header.dataset.ttsPhase).toBe("idle"); expect(closed).toBe(1);
    resumes[0]!(); await drainUpdates(); expect(requests).toEqual([]);
    flushSync(() => header.click()); resumes[1]!(); await drainUpdates();
    expect(requests).toEqual(["Newly visible answer."]);
    root.unmount();
    // A control remount cannot kill the conversation-owned read.
    expect(speech.getSnapshot().phase).toBe("loading"); speech.stop?.();
    expect(speech.getSnapshot().phase).toBe("idle");
  } finally { speech.stop?.(); globalThis.AudioContext = originalContext; globalThis.requestAnimationFrame = priorRaf; globalThis.cancelAnimationFrame = priorCancel; root.unmount(); }
});

test("feed lifetime stops navigation and preserves an explicit full-window transfer", async () => {
  const { conversationSpeech, ownConversationFeed } = await import("./conversationSpeech");
  const speech = conversationSpeech("transfer-test");
  let stops = 0;
  const stop = () => { stops++; speech.releaseStop(stop); };
  const release = ownConversationFeed("transfer-test"); speech.claimStop(stop); release();
  await Promise.resolve(); expect(stops).toBe(1);
  const releaseCard = ownConversationFeed("transfer-test"); speech.claimStop(stop); speech.beginTransfer(); releaseCard();
  await Promise.resolve(); expect(stops).toBe(1);
  const releaseWindow = ownConversationFeed("transfer-test");
  releaseWindow(); await Promise.resolve(); expect(stops).toBe(2);
});

/* While the feed scrolls the visible answer changes about six times a second.
   Every row's button used to subscribe to the whole snapshot, so each change
   re-rendered every prose row of the expanded history. */
test("a change of the visible answer re-renders the header only, never a row's button", async () => {
  globalThis.fetch = mock(async () => Response.json(backendInfo)) as unknown as typeof fetch;
  const { conversationSpeech } = await import("./conversationSpeech");
  const scope = "row-fanout-test";
  const speech = conversationSpeech(scope);
  const renders = { header: 0, first: 0, second: 0 };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  flushSync(() => root.render(<>
    <Profiler id="header" onRender={() => { renders.header += 1; }}><SpeakButton scope={scope} header /></Profiler>
    <Profiler id="first" onRender={() => { renders.first += 1; }}><SpeakButton scope={scope} text="First answer." answerId="a" /></Profiler>
    <Profiler id="second" onRender={() => { renders.second += 1; }}><SpeakButton scope={scope} text="Second answer." answerId="b" /></Profiler>
  </>));
  await drainUpdates();
  const before = { ...renders };
  const header = host.querySelector<HTMLButtonElement>("[data-tts-header]")!;
  const [first, second] = Array.from(host.querySelectorAll<HTMLButtonElement>("[data-tts-trigger]:not([data-tts-header])"));

  for (const [id, text] of [["a", "First answer."], ["b", "Second answer."], ["a", "First answer."]] as const) {
    flushSync(() => speech.select({ id, text, roots: () => [] }));
    await drainUpdates();
  }
  expect(renders.first).toBe(before.first);
  expect(renders.second).toBe(before.second);
  expect(renders.header).toBeGreaterThan(before.header);
  expect(header.getAttribute("title")).toContain("First answer.");

  /* A row still follows its own playback: it, and only it, re-renders when it
     becomes the active answer, and the header shares its phase. */
  flushSync(() => speech.update({ phase: "playing", activeId: "b", activeText: "Second answer." }));
  await drainUpdates();
  expect(second!.dataset.ttsPhase).toBe("playing");
  expect(first!.dataset.ttsPhase).toBe("idle");
  expect(renders.first).toBe(before.first);
  expect(renders.second).toBeGreaterThan(before.second);
  flushSync(() => speech.update({ phase: "idle", activeId: null, activeText: null }));
  await drainUpdates();
  expect(second!.dataset.ttsPhase).toBe("idle");
  root.unmount();
});


describe("Fish Audio UI before the free-model expiry", () => {
let clock: ReturnType<typeof spyOn>;
beforeEach(() => { clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-14T00:00:00Z")); });
afterEach(() => clock.mockRestore());

test("menu chooses a persisted model and states free and paid billing", async () => {
  const fish = { id: "fishaudio", available: true, keyPath: "$CONFIG/fishaudio-api-key", model: "s2.1-pro-free", voice: "default", cap: 4000, freeUntil: "2026-11-30", freeEnded: false, modelLockedByEnv: false };
  let info = { backend: "fishaudio", lockedByEnv: false, options: [...backendInfo.options, fish] };
  const posts: unknown[] = [];
  globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)); posts.push(body);
      info = { ...info, backend: body.backend, options: info.options.map((option) => option.id === "fishaudio" ? { ...option, model: body.model } : option) };
    }
    return Response.json(info);
  }) as unknown as typeof fetch;
  const view = await mount("Fish Audio choice");
  try {
    let menu = await openMenu(view);
    expect(menu.textContent).toContain("Fish Audio");
    expect(menu.textContent).toContain("free until November\u00a030,\u00a02026");
    expect(menu.textContent).toContain("Next click: free synthesis of this answer");
    expect(menu.textContent).toContain("may use the text");
    expect(menu.textContent).not.toContain("left click");
    const rows = [...menu.querySelectorAll<HTMLButtonElement>(':scope > div > button[role="menuitemradio"]')];
    expect(rows.map((row) => row.querySelector(".min-w-0 > span")?.textContent)).toEqual(["OpenAI", "ElevenLabsnot set up", "Fish Audio"]);
    expect(rows[2]!.textContent).toBe("Fish Audio");
    expect(view.button.title).toContain("Read aloud (free model)");
    const group = menu.querySelector('[role="group"]')!;
    const paid = group.querySelectorAll<HTMLButtonElement>("button")[1]!;
    expect(paid.textContent).toContain("S2.1 Pro — paid");
    flushSync(() => paid.click()); await drainUpdates();
    expect(posts).toEqual([{ backend: "fishaudio", model: "s2.1-pro" }]);
    menu = await openMenu(view);
    expect(menu.querySelector('[role="group"] button[aria-checked="true"]')?.textContent).toContain("S2.1 Pro — paid");
    expect(menu.textContent).toContain("Cyrillic letters cost about twice as much");
    expect(menu.textContent).not.toContain("UTF-8");
    expect(view.button.title).toContain("Read aloud (paid)");
  } finally { flushSync(() => view.root.unmount()); view.host.remove(); }
});

test.each(["model", "provider"])("%s lock disables both model rows", async (lock) => {
  const info = { backend: lock === "provider" ? "openai" : "fishaudio", lockedByEnv: lock === "provider", options: [...backendInfo.options, { id: "fishaudio", available: true, keyPath: "$CONFIG/fishaudio-api-key", model: "s2.1-pro-free", voice: "default", cap: 4000, modelLockedByEnv: lock === "model" }] };
  globalThis.fetch = mock(async () => Response.json(info)) as unknown as typeof fetch;
  const view = await mount("Fish Audio lock");
  try {
    const menu = await openMenu(view);
    const models = menu.querySelectorAll<HTMLButtonElement>('[role="group"]:not([data-tts-voice-group]) button');
    expect(models.length).toBe(2); expect([...models].every((button) => button.disabled)).toBe(true);
  } finally { flushSync(() => view.root.unmount()); view.host.remove(); }
});

test("expired free model refuses in Ukrainian without synthesis", async () => {
  const { setLocale } = await import("@/lib/i18n");
  setLocale("uk");
  const info = { backend: "fishaudio", lockedByEnv: false, options: [{ id: "fishaudio", available: true, keyPath: "$CONFIG/fishaudio-api-key", model: "s2.1-pro-free", voice: "default", cap: 4000, freeEnded: true }] };
  let posts = 0;
  globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => { if (init?.method === "POST") posts++; return Response.json(info); }) as unknown as typeof fetch;
  const view = await mount("Привіт світе");
  try {
    const menu = await openMenu(view);
    expect(menu.textContent).toContain("безкоштовний період закінчився 30\u00a0листопада\u00a02026");
    expect(menu.textContent).not.toContain("р.");
    expect(menu.textContent).not.toContain("..");
    expect(menu.textContent).not.toContain("Без оплати");
    expect(menu.textContent).toContain("Оберіть нижче S2.1 Pro (платно)");
    expect(menu.textContent).not.toContain("правою кнопкою");
    await speak(view);
    expect(posts).toBe(0);
    expect(alertNode()?.textContent).toContain("Безкоштовна модель Fish Audio закінчилася");
    expect(alertNode()?.textContent).toContain("S2.1 Pro (платно)");
    expect(alertNode()?.textContent).toContain("правою кнопкою");
    expect(alertNode()?.className).not.toContain("break-all");
  } finally { flushSync(() => view.root.unmount()); view.host.remove(); setLocale("en"); }
});


test("provider refusal explains the paid choice without retrying", async () => {
  const prior = { context: globalThis.AudioContext, frame: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  class Context {
    state = "running"; currentTime = 0;
    async resume() {} async close() { this.state = "closed"; }
  }
  Object.assign(globalThis, { AudioContext: Context, requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined });
  const info = { backend: "fishaudio", lockedByEnv: false, options: [{ id: "fishaudio", available: true, keyPath: "$CONFIG/fishaudio-api-key", model: "s2.1-pro-free", voice: "default", cap: 4000, freeEnded: false }] };
  let calls = 0;
  globalThis.fetch = mock(async (input: unknown) => {
    if (String(input) === "/api/tts/backend") return Response.json(info);
    if (String(input).startsWith("/api/tts/voices")) return Response.json({ backend: "fishaudio", voices: [], selected: { id: "default", name: null, known: true }, truncated: false });
    calls++; return Response.json({ error: "provider refused", code: "fishaudio-free-refused" }, { status: 403 });
  }) as unknown as typeof fetch;
  const view = await mount("Fish refusal");
  try {
    await openMenu(view); await speak(view);
    expect(calls).toBe(1);
    expect(alertNode()?.textContent).toContain("Fish Audio refused its free model;");
    expect(alertNode()?.textContent).not.toContain("HTTP");
    expect(alertNode()?.textContent).toContain("S2.1 Pro (paid)");
    expect(view.button.dataset.ttsPhase).toBe("idle");
  } finally {
    flushSync(() => view.root.unmount()); view.host.remove();
    Object.assign(globalThis, { AudioContext: prior.context, requestAnimationFrame: prior.frame, cancelAnimationFrame: prior.cancel });
  }
});
test("the ended free model never promises a charge-free read and names the provider one way", async () => {
  const info = { backend: "fishaudio", lockedByEnv: false, options: [{ id: "fishaudio", available: false, keyPath: "$CONFIG/fishaudio-api-key", model: "s2.1-pro-free", voice: "default", cap: 4000, freeEnded: true }] };
  globalThis.fetch = mock(async () => Response.json(info)) as unknown as typeof fetch;
  const view = await mount("Ended copy");
  try {
    const menu = await openMenu(view);
    expect(menu.textContent).not.toContain("No charge");
    expect(menu.textContent).toContain("Choose S2.1 Pro (paid) below");
    expect(menu.textContent).not.toContain("Right-click");
    expect(menu.textContent).not.toContain("fishaudio ·");
    expect(menu.textContent).toContain("Add the Fish Audio API key at $CONFIG/fishaudio-api-key");
    expect(menu.textContent).not.toContain("..");
    const parent = menu.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!;
    expect(parent.className).not.toContain("bg-accent/10");
    expect(parent.textContent).not.toContain("s2.1-pro-free");
  } finally { flushSync(() => view.root.unmount()); view.host.remove(); }
});

test("a phone refusal says press and hold instead of right-click", async () => {
  const original = (dom as unknown as { matchMedia: unknown }).matchMedia;
  (dom as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({ matches: true, media: String(query), addEventListener() {}, removeEventListener() {} });
  const info = { backend: "fishaudio", lockedByEnv: false, options: [{ id: "fishaudio", available: true, keyPath: "$CONFIG/fishaudio-api-key", model: "s2.1-pro-free", voice: "default", cap: 4000, freeEnded: true }] };
  globalThis.fetch = mock(async () => Response.json(info)) as unknown as typeof fetch;
  const view = await mount("Phone refusal");
  try {
    await openMenu(view); await speak(view);
    expect(alertNode()?.textContent).toContain("Press and hold this button");
    expect(alertNode()?.textContent).not.toContain("Right-click");
  } finally { flushSync(() => view.root.unmount()); view.host.remove(); (dom as unknown as { matchMedia: unknown }).matchMedia = original; }
});

test.each(["header", "row"])("a refusal raised from the %s shows one alert, not one per control", async (origin) => {
  const { conversationSpeech } = await import("./conversationSpeech");
  const prior = { context: globalThis.AudioContext, frame: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  Object.assign(globalThis, { AudioContext: class { state = "running"; async resume() {} async close() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined });
  const info = { backend: "fishaudio", lockedByEnv: false, options: [{ id: "fishaudio", available: true, keyPath: "$CONFIG/fishaudio-api-key", model: "s2.1-pro-free", voice: "default", cap: 4000, freeEnded: false }] };
  globalThis.fetch = mock(async (input: unknown) => String(input) === "/api/tts/backend"
    ? Response.json(info)
    : Response.json({ error: "provider refused", code: "fishaudio-free-refused" }, { status: 403 })) as unknown as typeof fetch;
  const scope = `single-alert-${origin}`;
  const speech = conversationSpeech(scope);
  speech.select({ id: "a", text: "Refused answer.", roots: () => [] });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  flushSync(() => root.render(<><SpeakButton scope={scope} header /><SpeakButton scope={scope} text="Refused answer." answerId="a" /><SpeakButton scope={scope} text="Other answer." answerId="b" /></>));
  await drainUpdates();
  try {
    const header = host.querySelector<HTMLButtonElement>("[data-tts-header]")!;
    header.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true })); await drainUpdates(); // fresh authoritative config
    const clicked = origin === "header" ? header : host.querySelector<HTMLButtonElement>("[data-tts-trigger]:not([data-tts-header])")!;
    flushSync(() => clicked.click()); await drainUpdates();
    expect(document.querySelectorAll("[data-tts-alert]")).toHaveLength(1);
  } finally {
    speech.stop?.(); flushSync(() => root.unmount()); host.remove();
    Object.assign(globalThis, { AudioContext: prior.context, requestAnimationFrame: prior.frame, cancelAnimationFrame: prior.cancel });
  }
});
});


describe("per-provider voice menu", () => {
  let current: typeof backendInfo & { options: Array<typeof backendInfo.options[number] & { voiceLockedByEnv?: boolean; voiceList?: boolean }> };
  let saves: unknown[];
  let lists: number;
  let state: "loaded" | "failed" | "loading" | "unknown";
  beforeEach(() => {
    current = { ...backendInfo, backend: "elevenlabs", options: backendInfo.options.map((o) => ({ ...o, available: true, model: o.id === "elevenlabs" ? "eleven_v4_turbo" : o.model, voice: o.id === "elevenlabs" ? "voice-menu-selected" : o.voice })) };
    saves = []; lists = 0; state = "loaded";
    globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
      if (String(url).startsWith("/api/tts/voices")) {
        lists++;
        if (state === "loading") return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        if (state === "failed") return Response.json({ error: "voices_read permission required" }, { status: 502 });
        return Response.json({ backend: "elevenlabs", voices: [{ id: "voice-menu-selected", name: "Current narrator", own: true }, { id: "voice-menu-other", name: "Other narrator", own: false }], truncated: false, selected: { id: current.options[1]!.voice, name: "Current narrator", known: state !== "unknown" } });
      }
      if (String(url) === "/api/tts" && init?.method === "POST") return Response.json({ error: "voice missing", code: "voice-not-found" }, { status: 422 });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)); saves.push(body);
        current = { ...current, options: current.options.map((o) => o.id === body.backend ? { ...o, voice: body.voice } : o) };
      }
      return Response.json(current);
    }) as unknown as typeof fetch;
  });
  test("list pick and typed Enter persist voices and update every control", async () => {
    const first = await mount("Voice first"); const second = await mount("Voice second");
    let menu = await openMenu(first);
    expect(menu.querySelectorAll("[data-tts-voice-group]").length).toBe(1);
    expect(document.activeElement?.hasAttribute("data-tts-provider")).toBe(true);
    const row = [...menu.querySelectorAll<HTMLButtonElement>("[data-tts-voice]")].find((node) => node.title === "voice-menu-other")!;
    flushSync(() => row.click()); await drainUpdates();
    expect(saves).toEqual([{ backend: "elevenlabs", voice: "voice-menu-other" }]);
    menu = await openMenu(second); expect(menu.textContent).toContain("Other narrator");
    const input = menu.querySelector("input")!;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
    flushSync(() => { setter.call(input, "custom-id"); input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event); });
    await drainUpdates();
    expect(menu.querySelector("[data-tts-typed]")).not.toBeNull();
    flushSync(() => input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event)); await drainUpdates();
    expect(saves.at(-1)).toEqual({ backend: "elevenlabs", voice: "custom-id" });
    flushSync(() => { first.root.unmount(); second.root.unmount(); });
  });
  test.each(["loading", "failed", "unknown"] as const)("shows the %s voice state", async (value) => {
    state = value; current.options[1]!.voice = `state-${value}`;
    const view = await mount("Voice state"); const menu = await openMenu(view);
    expect(menu.textContent).toContain(value === "loading" ? "Loading voices" : value === "failed" ? "voices_read" : "has no voice");
    expect(menu.querySelector("input")!.placeholder).toBe("Voice name or id");
    expect(menu.querySelector("[data-tts-provider][aria-checked=true] [data-tts-provider-voice]")!.textContent).toBe("eleven_v4_turbo");
    if (value === "failed") {
      state = "loaded";
      const retry = [...menu.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Retry")!;
      flushSync(() => retry.click()); await drainUpdates(); expect(menu.querySelectorAll("[data-tts-voice]").length).toBe(2);
    }
    flushSync(() => view.root.unmount());
  });
  test("unconfigured skips list fetch, env lock disables, OpenAI is typed only", async () => {
    current.options[1]!.available = false;
    const view = await mount("Unconfigured voice"); let menu = await openMenu(view);
    expect(lists).toBe(0); expect(menu.querySelectorAll("[data-tts-voice]").length).toBe(0); expect(menu.textContent).toContain("/keys/elevenlabs");
    await pressEscape(); current.options[1]!.voiceLockedByEnv = true; menu = await openMenu(view);
    expect(menu.querySelector("input")).toBeNull(); expect(menu.querySelectorAll("[data-tts-voice]").length).toBe(0); expect(menu.querySelector("[data-tts-voice-locked]")).not.toBeNull(); expect(menu.textContent).not.toContain("type to narrow"); expect(menu.textContent).toContain("LLV_TTS_ELEVENLABS_VOICE");
    await pressEscape(); current.backend = "openai"; menu = await openMenu(view);
    expect(menu.textContent).toContain("OpenAI has no voice list"); expect(lists).toBe(0);
    flushSync(() => view.root.unmount());
  });
});


test.each([['en', false], ['uk', false], ['en', true], ['uk', true]] as const)("bad voice alert in %s (phone %s) stops with one PCM request", async (locale, mobile) => {
  const { setLocale } = await import("@/lib/i18n");
  const prior = { context: globalThis.AudioContext, frame: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame, media: dom.matchMedia };
  class Context { state = "running"; currentTime = 0; async resume() {} async close() {} }
  Object.assign(globalThis, { AudioContext: Context, requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined });
  dom.matchMedia = ((query: string) => ({ matches: mobile, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof dom.matchMedia;
  setLocale(locale);
  const info = { backend: "elevenlabs", lockedByEnv: false, options: [{ id: "elevenlabs", available: true, keyPath: "$CONFIG/elevenlabs-api-key", model: "eleven_v4_turbo", voice: "unknown-voice", cap: 4000 }] };
  let calls = 0;
  globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
    if (String(url) === "/api/tts/backend") return Response.json(info);
    if (String(url).startsWith("/api/tts/voices")) return Response.json({ backend: "elevenlabs", voices: [], truncated: false, selected: { id: "unknown-voice", name: null, known: false } });
    calls++; expect(JSON.parse(String(init?.body)).mode).toBe("pcm");
    return Response.json({ error: "voice missing", code: "voice-not-found", voice: "server-unknown-voice" }, { status: 422 });
  }) as unknown as typeof fetch;
  const view = await mount("Unknown voice alert");
  try {
    await openMenu(view); await pressEscape(); await speak(view);
    expect(calls).toBe(1); expect(view.button.dataset.ttsPhase).toBe("idle");
    expect(alertNode()?.textContent).toContain("server-unknown-voice");
    expect(alertNode()?.textContent).toContain(locale === "uk" ? mobile ? "Затисніть" : "правою кнопкою" : mobile ? "Press and hold" : "Right-click");
  } finally { flushSync(() => view.root.unmount()); setLocale("en"); dom.matchMedia = prior.media; Object.assign(globalThis, { AudioContext: prior.context, requestAnimationFrame: prior.frame, cancelAnimationFrame: prior.cancel }); }
});
