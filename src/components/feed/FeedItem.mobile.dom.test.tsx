import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import { en } from "@/lib/i18n/en";
import { setLocale, translate } from "@/lib/i18n";

import { FeedItem } from "./FeedItem";
import { buildFeed, type Item, type ToolEvent } from "./parse";
import type { FileEntry } from "@/lib/types";

/*
 * Mobile v2 (#1439, lane 4; README §2.6, §4.2, §8 row 4): on the phone the
 * feed spends no column on avatars, message content reads at 15 px, and the
 * message header is a 44 px target of its own that sits above the prose
 * instead of over it. The desktop keeps every class it had.
 *
 * Phone-ness is the viewport query `useIsMobile` consults; the pointer axis is
 * held at fine so the copy control's own sizing does not enter the picture.
 */

let narrowViewport = false;

const normalize = (query: string) => String(query).replace(/\s+/g, "");
const matchMediaStub = (query: string) => ({
  matches: normalize(query) === "(max-width:767px)" ? narrowViewport : false,
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
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  matchMedia: matchMediaStub,
});

const tr = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate("en", key, params);

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  narrowViewport = false;
  dom.document.body.replaceChildren();
});

function mount(node: ReactElement): Element {
  const el = dom.document.createElement("div");
  dom.document.body.append(el);
  root = createRoot(el as unknown as HTMLElement);
  flushSync(() => root!.render(node));
  return el as unknown as Element;
}

const classOf = (el: Element | null) => el?.getAttribute("class") ?? "";

function prose(): Item {
  return { kind: "prose", ts: "2026-09-02T13:43:00Z", engine: "claude", text: "The projection lives in one module." } as Item;
}

function user(): Item {
  return { kind: "user", ts: "2026-09-02T13:41:00Z", text: "Read the issue and tell me which file owns it." } as Item;
}

function tool(over: Partial<ToolEvent> = {}): ToolEvent {
  return {
    kind: "tool",
    id: "call-1",
    ts: "2026-09-02T13:57:00Z",
    srcCall: 0,
    family: "shell",
    tool: "Bash",
    icon: "shell",
    summary: "bun test src/lib/board",
    chips: [],
    status: "ok",
    statusLabel: "ok",
    outputPreview: "",
    outputTruncated: false,
    open: false,
    ...over,
  };
}

function tmsg(): Item {
  return { kind: "tmsg", ts: "2026-09-02T13:44:00Z", dir: "in", peer: "reviewer", summary: "", text: "APPROVE" } as Item;
}

test("phone: an agent message has no avatar column and its content reads at 15 px", () => {
  narrowViewport = true;
  const host = mount(<FeedItem item={prose()} />);
  const message = host.querySelector('[data-mobile-message="agent"]');
  expect(message).toBeTruthy();
  /* The 26 px engine avatar and its flex column are gone. */
  expect(host.querySelector(".bg-claude")).toBeNull();
  expect(classOf(message)).not.toContain("flex");
  expect(classOf(message)).not.toContain("gap-2.5");
  /* The prose is the full width at the title size (15 px) and 1.45 leading. */
  const body = host.querySelector("[data-tts-message]");
  expect(classOf(body)).toContain("w-full");
  expect(classOf(body)).toContain("text-title");
  expect(classOf(body)).toContain("leading-[1.45]");
  expect(classOf(body)).not.toContain("flex-1");
  /* The read-aloud anchors survive the layout change (#1022). */
  expect(body!.getAttribute("data-tts-message")).toBe("claude:2026-09-02T13:43:00Z");
  expect(host.querySelector("[data-tts-body]")).toBeTruthy();
});

test("phone: the message header is a 44 px target above the prose, never over it", () => {
  narrowViewport = true;
  const host = mount(<FeedItem item={prose()} speakText="The projection lives in one module." />);
  const message = host.querySelector('[data-mobile-message="agent"]')!;
  const header = host.querySelector("[data-mobile-message-header]")!;
  /* 44 px tall, the whole width, and the first thing in the message. */
  expect(classOf(header)).toContain("h-11");
  expect(classOf(header)).toContain("w-full");
  expect(message.firstElementChild).toBe(header);
  /* The prose starts under it: next sibling, in flow, no negative margin
     anywhere on the message that could pull the text up into the header. */
  expect(header.nextElementSibling).toBe(host.querySelector("[data-tts-message]"));
  for (const el of [message, header, host.querySelector("[data-tts-message]")!]) {
    expect(classOf(el)).not.toMatch(/(^|\s)-m[tby]?-/);
    expect(classOf(el)).not.toContain("absolute");
  }
  /* No vertical margin of its own: the header's height is the gap. */
  expect(classOf(message)).not.toContain("my-3");
  /* The engine mark is the one avatar left: a 16 px glyph beside the name. */
  const glyph = header.querySelector("svg");
  expect(classOf(glyph)).toContain("h-4");
  expect(header.textContent).toContain("Claude");
  /* The phone's clock is HH:MM (README §5): no seconds anywhere on the line. */
  expect(header.textContent).toContain("13:43");
  expect(header.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  /* The message actions live in the header row: the copy control is there,
     and the read-aloud control shares the same cluster once the speech
     backend reports itself (it renders nothing without one, as here). */
  const actions = header.querySelector(`button[aria-label="${en["feed.copyMd"]}"]`)!;
  expect(actions).toBeTruthy();
  expect(classOf(actions.parentElement)).toContain("ml-auto");
  expect(host.querySelector("[data-tts-trigger]")).toBeNull();
});

test("phone: the user keeps the bubble at 86% and 15 px", () => {
  narrowViewport = true;
  const host = mount(<FeedItem item={user()} />);
  const bubble = host.querySelector(".bg-user")!;
  expect(classOf(bubble)).toContain("max-w-[86%]");
  expect(classOf(bubble)).toContain("text-title");
  expect(classOf(bubble)).not.toContain("max-w-[75%]");
});

test("phone: a lone tool call is one 44 px line with no chrome indent, and says when it runs", () => {
  narrowViewport = true;
  const host = mount(
    <>
      <FeedItem item={tool()} />
      <FeedItem item={tool({ id: "call-2", status: "run", statusLabel: "executing…", summary: "bun test src/lib/accounts" })} />
    </>,
  );
  const lines = host.querySelectorAll("[data-mobile-tool-line]");
  expect(lines).toHaveLength(2);
  for (const line of lines) expect(classOf(line)).toContain("min-h-11");
  for (const details of host.querySelectorAll("details")) expect(classOf(details)).not.toContain("ml-9");
  expect(lines[0]!.getAttribute("data-mobile-tool-line")).toBe("done");
  /* HH:MM, never seconds, on the phone's line. */
  expect(lines[0]!.textContent).toContain("13:57");
  expect(lines[0]!.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  expect(lines[1]!.getAttribute("data-mobile-tool-line")).toBe("running");
  expect(lines[1]!.textContent).toContain(tr("mobile2.feed.running", { summary: "bun test src/lib/accounts" }));
  /* One spinner and one state word: the status chip ("executing…" with its
     own spinner) stays off the phone's running line. */
  expect(lines[1]!.querySelectorAll(".animate-spin")).toHaveLength(1);
  expect(lines[1]!.textContent).not.toContain("executing…");
});

test("phone: the running question tool renders no line, the card under it is that line; the desktop keeps it", () => {
  const asking = () => tool({ id: "call-q", tool: "AskUserQuestion", family: "other", icon: "note", status: "run", statusLabel: "running", summary: "Which format should the export endpoint default to?" });
  narrowViewport = true;
  const phone = mount(<FeedItem item={asking()} />);
  expect(phone.querySelector("details")).toBeNull();
  expect(phone.textContent).toBe("");
  flushSync(() => root!.unmount());
  root = null;
  narrowViewport = false;
  const desktop = mount(<FeedItem item={asking()} />);
  expect(desktop.querySelector("details")).toBeTruthy();
  expect(desktop.textContent).toContain("Which format");
});

test("phone: internal relay cards drop the avatar-column indent too", () => {
  narrowViewport = true;
  const host = mount(<FeedItem item={tmsg()} />);
  expect(classOf(host.firstElementChild)).not.toContain("ml-9");
});

test("desktop: every message keeps its avatar column, indent, 75% bubble and margins", () => {
  narrowViewport = false;
  const host = mount(
    <>
      <FeedItem item={prose()} />
      <FeedItem item={user()} />
      <FeedItem item={tool()} />
      <FeedItem item={tmsg()} />
    </>,
  );
  expect(host.querySelector("[data-mobile-message]")).toBeNull();
  expect(host.querySelector("[data-mobile-message-header]")).toBeNull();
  expect(host.querySelector("[data-mobile-tool-line]")).toBeNull();
  expect(host.querySelector(".bg-claude")).toBeTruthy();
  expect(classOf(host.querySelector(".group\\/msg"))).toContain("my-3 flex gap-2.5");
  expect(classOf(host.querySelector("[data-tts-message]"))).toBe("min-w-0 flex-1 whitespace-pre-wrap break-words");
  expect(classOf(host.querySelector(".bg-user"))).toContain("max-w-[75%]");
  expect(classOf(host.querySelector("details"))).toContain("ml-9");
  expect(classOf(host.querySelector(".bg-accent-soft"))).toContain("my-3 ml-9 overflow-hidden");
});

/*
 * A first turn that died unauthorized (#1846 recurrence). The engine wrote one
 * record and no answer, so the failed terminal is the only thing the operator
 * has to read — it must read as a failure on the phone and on the desktop
 * alike, in both languages, and it must never carry a credential.
 */
const codexFile = { path: "/tmp/auth-terminal.jsonl", engine: "codex", fmt: "codex", activity: "recent" } as FileEntry;
const EXPIRED = "Your access token could not be refreshed because your "
  + "refresh token has expired. Please log out and sign in again.";

function authTerminalRow(overrides: Record<string, unknown> = {}): Item {
  const line = JSON.stringify({
    type: "event_msg",
    timestamp: "2026-09-20T02:49:12.136Z",
    payload: {
      type: "task_complete",
      last_agent_message: null,
      error: { message: EXPIRED, codex_error_info: "unauthorized" },
      duration_ms: 1352,
      ...overrides,
    },
  });
  const row = buildFeed(codexFile, [line], false, "").items.find((item) => item.kind === "turn-error");
  if (!row) throw new Error("the parser produced no failed-turn row");
  return row;
}

/**
 * Phone-ness for these cases comes from the PRODUCTION media query rather than
 * from the stub above, which still keys on a width this layout stopped using;
 * that staleness is why the file's older phone cases are red at the merge base
 * too, and it is not this increment's to repair.
 */
function withViewport<T>(phone: boolean, body: () => T): T {
  const stub = (query: string) => ({
    ...matchMediaStub(query),
    matches: normalize(query) === normalize(MOBILE_LAYOUT_QUERY) ? phone : false,
  });
  (dom as unknown as { matchMedia: unknown }).matchMedia = stub;
  Object.assign(globalThis, { matchMedia: stub });
  try {
    return body();
  } finally {
    (dom as unknown as { matchMedia: unknown }).matchMedia = matchMediaStub;
    Object.assign(globalThis, { matchMedia: matchMediaStub });
  }
}

for (const phone of [true, false]) {
  const surface = phone ? "phone" : "desktop";
  test(`${surface}: an unauthorized first turn reads as a failure, not as a completion`, () => {
    withViewport(phone, () => {
      const host = mount(<FeedItem item={authTerminalRow()} />);
      const row = host.querySelector('[data-turn-error="auth"]')!;
      expect(row).toBeTruthy();
      /* Danger hue, and the title says what happened with no assistant prose
         to lean on. */
      expect(classOf(row)).toContain("border-danger/40");
      expect(classOf(row)).toContain("bg-danger-soft");
      expect(row.querySelector(".text-danger")).toBeTruthy();
      expect(row.textContent).toContain(en["render.turnFailedAuth"]);
      expect(row.textContent).not.toContain(en["render.taskComplete"]);
      /* The provider's sentence and the action the operator can take. */
      expect(row.textContent).toContain(EXPIRED);
      expect(row.textContent).toContain(en["render.turnFailedAuthHint"]);
      /* The feed's own clock: HH:MM on the phone, the full time on the desktop. */
      expect(row.textContent).toContain("02:49");
      expect(/\d{2}:\d{2}:\d{2}/.test(row.textContent ?? "")).toBe(!phone);
      /* The phone spends no column on the avatar indent; the desktop keeps it. */
      expect(classOf(row).includes("ml-9")).toBe(!phone);
    });
  });
}

test("the failed terminal speaks Ukrainian too", () => {
  setLocale("uk");
  try {
    const host = mount(<FeedItem item={authTerminalRow()} />);
    const row = host.querySelector('[data-turn-error="auth"]')!;
    expect(row.textContent).toContain(translate("uk", "render.turnFailedAuth"));
    expect(row.textContent).toContain(translate("uk", "render.turnFailedAuthHint"));
  } finally {
    setLocale("en");
  }
});

test("a credential quoted by the provider never reaches the screen", () => {
  const leak = `${["refresh", "token"].join("_")}=${"a1b2c3d4e5f6".repeat(2)}`;
  const host = mount(<FeedItem item={authTerminalRow({ error: { message: `unauthorized (${leak})`, codex_error_info: "unauthorized" } })} />);
  const row = host.querySelector('[data-turn-error="auth"]')!;
  expect(row.textContent).not.toContain("a1b2c3d4e5f6");
  expect(row.textContent).toContain("[redacted]");
});

test("a turn that really completed keeps its quiet completion note", () => {
  const line = JSON.stringify({ type: "event_msg", timestamp: "2026-09-20T02:50:00.000Z", payload: { type: "task_complete" } });
  const note = buildFeed(codexFile, [line], false, "").items.find((item) => item.kind === "note")!;
  const host = mount(<FeedItem item={note} />);
  expect(host.querySelector("[data-turn-error]")).toBeNull();
  expect(host.textContent).toContain(en["render.taskComplete"]);
});
