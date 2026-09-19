import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

/*
 * The desktop rail header put in order (issue #1819).
 *
 * The complaint was six unexplained things in 240px: a pulsing count, a paused
 * badge, `EN`, a QR square and a bell. What stays is the title, the control
 * that puts the rail away and ONE menu — and every entry inside that menu says
 * in words what it is. The counts leave the header only: the rows below keep
 * their own marks, so this asserts on the header element, not on the rail.
 */

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installActEnv();
const matchMediaStub = (query: string) => ({
  matches: false, media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  dispatchEvent() { return false; },
});
(dom as unknown as { matchMedia: typeof matchMediaStub }).matchMedia = matchMediaStub;
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: matchMediaStub,
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as unknown as typeof fetch;

const { ProjectRail } = await import("./ProjectRail");

/* A live agent and one waiting on the operator, so the counters the header
   used to carry are genuinely there to be counted. */
const base = {
  root: "claude-projects",
  project: "atlas",
  engine: "claude",
  kind: "session",
  fmt: "claude",
  parent: null,
  mtime: 1_000,
  size: 1,
  proc: null,
  pid: null,
  model: null,
  waitingInput: null,
} as unknown as FileEntry;
const files = [
  { ...base, path: "/sessions/a.jsonl", name: "a.jsonl", title: "Live one", activity: "live", pendingQuestion: null },
  { ...base, path: "/sessions/b.jsonl", name: "b.jsonl", title: "Waiting one", activity: "idle", pendingQuestion: { text: "?", at: 1_000 } },
] as unknown as FileEntry[];

let root: Root | null = null;
beforeEach(() => {
  dom.localStorage.clear();
});
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  dom.document.body.replaceChildren();
  setLocale("en");
});

async function renderRail(): Promise<HTMLElement> {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host as unknown as Element);
    root.render(
      <ProjectRail
        files={files}
        projectCatalog={[]}
        pipelines={[]}
        workflows={[]}
        archivedProjects={new Set()}
        selected="atlas"
        loaded
        now={2_000}
        onHide={() => {}}
        onSelect={() => {}}
      />,
    );
  });
  return host as unknown as HTMLElement;
}

const headerIn = (host: HTMLElement) => host.querySelector("header") as HTMLElement;
const click = async (element: HTMLElement) => {
  await act(async () => { element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
};

test("the desktop header carries no counters — only the title, the hide control and one menu", async () => {
  const host = await renderRail();
  const header = headerIn(host);

  expect(header.textContent ?? "").toBe(translate("en", "rail.title"));
  expect(header.textContent ?? "").not.toMatch(/\d/);
  expect(header.textContent ?? "").not.toContain("⏸");
  /* Exactly two controls: put the rail away, and the menu. */
  const buttons = [...header.querySelectorAll("button")];
  expect(buttons.length).toBe(2);
  expect(header.querySelector("[data-rail-hide]")).not.toBeNull();
  expect(header.querySelector("[data-rail-menu]")).not.toBeNull();

  /* The rows below still carry the marks the header gave up. */
  const rows = host.querySelector("nav")?.textContent ?? "";
  expect(rows).toMatch(/\d/);
});

test("the menu holds language, QR and notifications, each said in words", async () => {
  const host = await renderRail();
  const trigger = headerIn(host).querySelector("[data-rail-menu]") as HTMLButtonElement;
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("[data-rail-menu-panel]")).toBeNull();

  await click(trigger);

  const panel = host.querySelector("[data-rail-menu-panel]") as HTMLElement;
  expect(panel).not.toBeNull();
  const text = panel.textContent ?? "";
  expect(text).toContain(translate("en", "rail.menuLanguage"));
  expect(text).toContain("English");
  expect(text).toContain(translate("en", "rail.menuQr"));
  /* The bell reports its own state to the label. Under happy-dom there is no
     PushManager, so the honest state is «unavailable» — which is the point: the
     row says what it is and where it stands instead of being a bare icon. */
  expect(text).toContain(translate("en", "rail.menuNotificationsUnavailable"));

  /* The behaviour is the existing controls', not a rewrite: the language
     button still switches the locale, from inside the menu. */
  const language = [...panel.querySelectorAll("button")].find((button) => (button.textContent ?? "").trim() === "EN") as HTMLElement;
  expect(language).not.toBeUndefined();
  await click(language);
  expect((host.querySelector("[data-rail-menu-panel]")?.textContent ?? "")).toContain(translate("uk", "rail.menuQr"));
});

test("Escape closes the menu", async () => {
  const host = await renderRail();
  await click(headerIn(host).querySelector("[data-rail-menu]") as HTMLElement);
  expect(host.querySelector("[data-rail-menu-panel]")).not.toBeNull();

  await act(async () => {
    dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(host.querySelector("[data-rail-menu-panel]")).toBeNull();
});
