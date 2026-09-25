import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { MOBILE_LAYOUT_QUERY, mobileLayoutViewport } from "@/lib/attention/eligibility";
import { en } from "@/lib/i18n/en";
import { setLocale, translate } from "@/lib/i18n";

import { FeedItem } from "./FeedItem";
import { buildFeed, type Item, type ToolEvent } from "./parse";
import { karaokeRoots } from "./ttsKaraoke";
import type { FileEntry } from "@/lib/types";

/*
 * Mobile v2 (#1439, lane 4; README §2.6, §4.2, §8 row 4): on the phone the
 * feed spends no column on avatars and message content reads at 15 px. A
 * message reads content first (#2148): a one-line caption, the prose, then its
 * 44 px controls in one row after the text, never over it. The desktop keeps
 * its layout and sets prose at the reading measure.
 *
 * Phone-ness is the viewport query `useIsMobile` consults; the pointer axis is
 * held at fine so the copy control's own sizing does not enter the picture.
 */

const VIEWPORTS = {
  narrowPhone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
  shortLandscape: { width: 844, height: 390 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;
let viewport: { width: number; height: number } = VIEWPORTS.desktop;

const setViewport = (name: ViewportName) => { viewport = VIEWPORTS[name]; };

const normalize = (query: string) => String(query).replace(/\s+/g, "");
const matchMediaStub = (query: string) => ({
  matches: normalize(query) === normalize(MOBILE_LAYOUT_QUERY) ? mobileLayoutViewport(viewport) : false,
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
  setViewport("desktop");
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
  setViewport("narrowPhone");
  const host = mount(<FeedItem item={prose()} />);
  const message = host.querySelector('[data-mobile-message="agent"]');
  expect(message).toBeTruthy();
  /* The 26 px engine avatar and its flex column are gone. */
  expect(host.querySelector(".bg-claude")).toBeNull();
  expect(classOf(message)).not.toContain("flex");
  expect(classOf(message)).not.toContain("gap-2.5");
  /* The prose is the full width at the title size (15 px) and 1.45 leading. */
  const body = host.querySelector("[data-mobile-message-header]")!.nextElementSibling;
  expect(classOf(body)).toContain("w-full");
  expect(classOf(body)).toContain("text-title");
  expect(classOf(body)).toContain("leading-[1.45]");
  expect(classOf(body)).not.toContain("flex-1");
  /* The read-aloud anchors survive the layout change (#1022): the answer's
     identity on the message, the rendered body inside it. */
  expect(message!.getAttribute("data-tts-message")).toBe("claude:2026-09-02T13:43:00Z");
  expect(body!.querySelector("[data-tts-body]")).toBeTruthy();
});

test("phone: a message reads caption, text, then its controls; the controls' row follows the text and never covers it (#2148)", () => {
  setViewport("narrowPhone");
  const host = mount(<FeedItem item={prose()} speakText="The projection lives in one module." />);
  const message = host.querySelector('[data-mobile-message="agent"]')!;
  const header = host.querySelector("[data-mobile-message-header]")!;
  const actions = host.querySelector("[data-mobile-message-actions]")!;
  /* Three rows in reading order: the caption, the prose, the controls. */
  expect([...message.children]).toEqual([header, header.nextElementSibling!, actions]);
  const body = header.nextElementSibling!;
  expect(body.querySelector("[data-tts-body]")).toBeTruthy();
  /* The caption is one 20 px line with no control on it. */
  expect(classOf(header)).toContain("h-5");
  expect(classOf(header)).toContain("w-full");
  expect(header.querySelector("button")).toBeNull();
  /* Nothing is pulled over the text: no negative margin or absolute position
     on the message, the caption or the prose. */
  for (const el of [message, header, body]) {
    expect(classOf(el)).not.toMatch(/(^|\s)-m[tby]?-/);
    expect(classOf(el)).not.toContain("absolute");
  }
  expect(classOf(message)).not.toContain("my-3");
  /* The engine mark is the one avatar left: a 16 px glyph beside the name. */
  const glyph = header.querySelector('[data-engine-mark="claude"]');
  expect(glyph).toBeTruthy();
  expect(classOf(glyph)).toContain("h-4");
  expect(header.textContent).toContain("Claude");
  /* The phone's clock is HH:MM (README §5): no seconds anywhere on the line. */
  expect(header.textContent).toContain("13:43");
  expect(header.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  /* The controls' row is 44 px tall, after the text; the copy control is in
     it, and the read-aloud control joins it once the speech backend reports
     itself (it renders nothing without one, as here). */
  expect(classOf(actions)).toContain("h-11");
  const copy = actions.querySelector(`button[aria-label="${en["feed.copyMd"]}"]`)!;
  expect(copy).toBeTruthy();
  expect(host.querySelector("[data-tts-trigger]")).toBeNull();
  /* A control in that row still finds the text it reads: the read-aloud
     anchor wraps the whole message. */
  expect(karaokeRoots(copy)).toEqual([body.querySelector<HTMLElement>("[data-tts-body]")!]);
});

test("phone: the user keeps the bubble at 86% and 15 px, and its copy control sits under it (#2148)", () => {
  setViewport("narrowPhone");
  const host = mount(<FeedItem item={user()} />);
  const bubble = host.querySelector(".bg-user")!;
  expect(classOf(bubble)).toContain("max-w-[86%]");
  expect(classOf(bubble)).toContain("text-title");
  expect(classOf(bubble)).not.toContain("max-w-[75%]");
  /* Nothing floats beside the bubble; the control follows it. */
  expect(bubble.parentElement!.querySelector("button")).toBeNull();
  const actions = host.querySelector("[data-mobile-message-actions]")!;
  expect(actions.previousElementSibling).toBe(bubble.parentElement);
  expect(actions.querySelector(`button[aria-label="${en["feed.copyMd"]}"]`)).toBeTruthy();
});

test("phone: a lone tool call is one 44 px line with no chrome indent, and says when it runs", () => {
  setViewport("narrowPhone");
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
  setViewport("narrowPhone");
  const phone = mount(<FeedItem item={asking()} />);
  expect(phone.querySelector("details")).toBeNull();
  expect(phone.textContent).toBe("");
  flushSync(() => root!.unmount());
  root = null;
  setViewport("desktop");
  const desktop = mount(<FeedItem item={asking()} />);
  expect(desktop.querySelector("details")).toBeTruthy();
  expect(desktop.textContent).toContain("Which format");
});

test("phone: internal relay cards drop the avatar-column indent too", () => {
  setViewport("narrowPhone");
  const host = mount(<FeedItem item={tmsg()} />);
  expect(classOf(host.firstElementChild)).not.toContain("ml-9");
});

test("desktop: every message keeps its avatar column, indent and margins, and prose is set at the agent's measure, wider than the bubble (#2179)", () => {
  setViewport("desktop");
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
  expect(classOf(host.querySelector("[data-tts-message]"))).toBe("min-w-0 flex-1 max-w-[clamp(68ch,85%,100ch)] whitespace-pre-wrap break-words");
  /* The operator's bubble: three quarters of the reader, up to the measure,
     with its copy control beside it as before. */
  expect(classOf(host.querySelector(".bg-user"))).toContain("max-w-[min(75%,68ch)]");
  expect(host.querySelector("[data-mobile-message-actions]")).toBeNull();
  expect(host.querySelector(".bg-user")!.parentElement!.querySelector(`button[aria-label="${en["feed.copyMd"]}"]`)).toBeTruthy();
  expect(classOf(host.querySelector("details"))).toContain("ml-9");
  expect(classOf(host.querySelector(".bg-accent-soft"))).toContain("my-3 ml-9 overflow-hidden");
});

test("short landscape: the height side of the production query selects the phone layout", () => {
  setViewport("shortLandscape");
  const host = mount(<FeedItem item={prose()} />);
  expect(host.querySelector('[data-mobile-message="agent"]')).toBeTruthy();
  expect(host.querySelector(".bg-claude")).toBeNull();
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

for (const [surface, viewportName] of [["phone", "narrowPhone"], ["desktop", "desktop"]] as const) {
  test(`${surface}: an unauthorized first turn reads as a failure, not as a completion`, () => {
    setViewport(viewportName);
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
    /* The Viewer's own explanation and the action the operator can take —
       the provider's sentence is withheld, never echoed. */
    expect(row.textContent).toContain(en["render.turnFailedAuthBody"]);
    expect(row.textContent).toContain(en["render.turnFailedAuthHint"]);
    expect(row.textContent).not.toContain(EXPIRED);
    /* The feed's own clock: HH:MM on the phone, the full time on the desktop. */
    expect(row.textContent).toContain("02:49");
    expect(/\d{2}:\d{2}:\d{2}/.test(row.textContent ?? "")).toBe(surface === "desktop");
    /* The phone spends no column on the avatar indent; the desktop keeps it. */
    expect(classOf(row).includes("ml-9")).toBe(surface === "desktop");
  });
}

test("a turn that really completed keeps its quiet completion note", () => {
  const line = JSON.stringify({ type: "event_msg", timestamp: "2026-09-20T02:50:00.000Z", payload: { type: "task_complete" } });
  const note = buildFeed(codexFile, [line], false, "").items.find((item) => item.kind === "note")!;
  const host = mount(<FeedItem item={note} />);
  expect(host.querySelector("[data-turn-error]")).toBeNull();
  expect(host.textContent).toContain(en["render.taskComplete"]);
});

/*
 * Rendered sentinels, review round 2. Round 1 answered a leak with more
 * patterns and more shapes kept arriving, so the row stopped echoing the
 * provider's text at all. These mount the row and read what is actually
 * painted: for every shape that got through before, and for a shape nobody
 * has classified, nothing of the record's bytes is on screen and the
 * explanation is still there to read.
 *
 * Sentinels are assembled from parts, so no credential-shaped literal is
 * committed.
 */
const SENTINEL = ["sk", "live", "9f4c2ab77d31e05c86f0"].join("_");
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dBjftJeZ4CVPmB92K27u"].join(".");
const secretKey = (...parts: string[]) => parts.join("_");

const PAINT_PROBES: Array<{ name: string; sentinel: string; payload: Record<string, unknown> }> = [
  {
    name: "a token in single quotes",
    sentinel: SENTINEL,
    payload: { error: { message: `rejected {'${secretKey("refresh", "token")}': '${SENTINEL}'}`, codex_error_info: "unauthorized" } },
  },
  {
    name: "a JSON body that arrived escaped",
    sentinel: SENTINEL,
    payload: { error: { message: `rejected {\\"${secretKey("access", "token")}\\": \\"${SENTINEL}\\"}`, codex_error_info: "unauthorized" } },
  },
  {
    name: "a credential nested three levels down",
    sentinel: SENTINEL,
    payload: { error: { message: `rejected {"a": {"b": {"${secretKey("refresh", "token")}": "${SENTINEL}"}}}`, codex_error_info: "unauthorized" } },
  },
  {
    name: "an id_token no pattern list knows",
    sentinel: JWT,
    payload: { error: { message: `rejected {"id_token": "${JWT}"}`, codex_error_info: "unauthorized" } },
  },
  {
    name: "a payload behind the error code the row falls back to",
    sentinel: JWT,
    payload: { error: undefined, last_agent_message: null, codex_error_info: `unauthorized {'id_token': '${JWT}'}` },
  },
  {
    name: "an unrecognized failure with a credential in its prose",
    sentinel: SENTINEL,
    payload: { error: { message: `quantum flux ${SENTINEL}`, codex_error_info: "quantum_flux" } },
  },
];

for (const probe of PAINT_PROBES) {
  test(`${probe.name} is never painted onto the row`, () => {
    const host = mount(<FeedItem item={authTerminalRow(probe.payload)} />);
    const row = host.querySelector("[data-turn-error]")!;
    expect(row).toBeTruthy();
    expect(row.textContent).not.toContain(probe.sentinel);
    /* A sanitized row is not a blank row: it still says what happened and
       says the provider's own words are being withheld. */
    expect(row.textContent).toContain(en["render.turnFailedWithheld"]);
    const reason = row.getAttribute("data-turn-error");
    expect(row.textContent).toContain(en[reason === "auth" ? "render.turnFailedAuthBody" : "render.turnFailedBody"]);
  });
}

test("only a recognized code is printed, and it is the Viewer's constant", () => {
  const known = mount(<FeedItem item={authTerminalRow()} />);
  expect(known.querySelector("[data-turn-error-code]")?.textContent).toBe("unauthorized");
  flushSync(() => root!.unmount());
  root = null;
  const unknown = mount(<FeedItem item={authTerminalRow({ error: { message: "sideways", codex_error_info: `quantum_flux_${SENTINEL}` } })} />);
  expect(unknown.querySelector("[data-turn-error-code]")).toBeNull();
  expect(unknown.textContent).not.toContain(SENTINEL);
});

test("the expired-sign-in guidance reads in both languages", () => {
  const host = mount(<FeedItem item={authTerminalRow()} />);
  const row = host.querySelector('[data-turn-error="auth"]')!;
  expect(row.textContent).toContain(en["render.turnFailedAuthBody"]);
  expect(row.textContent).toContain(en["render.turnFailedAuthHint"]);
  flushSync(() => root!.unmount());
  root = null;
  setLocale("uk");
  try {
    const ukRow = mount(<FeedItem item={authTerminalRow()} />).querySelector('[data-turn-error="auth"]')!;
    expect(ukRow.textContent).toContain(translate("uk", "render.turnFailedAuthBody"));
    expect(ukRow.textContent).toContain(translate("uk", "render.turnFailedAuthHint"));
  } finally {
    setLocale("en");
  }
});
