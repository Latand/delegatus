/**
 * The first frame (#2071, docs/design/skeletons-and-transitions.md D1).
 *
 * The server used to render the desktop Overview with no data, so a phone's
 * first paint was a desktop layout claiming "No projects yet" until the bundle
 * ran. The server and hydration renders now draw the boot shell: both form
 * factors, one shown by `useIsMobile`'s own media query, named before first
 * paint by its inline script.
 */
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import { translate } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";

import { BOOT_SHELL_SCRIPT, BootShell } from "./BootShell";

const KEY = "repo-0123456789abcdef0123456789abcdef";

test("the server renders the boot shell for both form factors, and no false empty state", async () => {
  const { Viewer } = await import("./Viewer");
  const html = renderToString(<Viewer />);
  expect(html).toContain("data-boot-shell");
  expect(html).toContain("data-boot-phone");
  expect(html).toContain("data-boot-desk");
  expect(html).toContain(`@media ${MOBILE_LAYOUT_QUERY}`);
  expect(html).not.toContain("overview-first-run");
  expect(html).not.toContain(en["overview.firstRunTitle"]);
  expect(html).not.toContain(en["common.nothingRunning"]);
  /* The shape of the board: the phone's sections and the kanban's heads. */
  expect(html).toContain(en["mobile2.board.working"]);
  expect(html).toContain(en["kanban.status.assigned"]);
  expect(html).toContain('aria-busy="true"');
});

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
const saved = { window: G.window, document: G.document, localStorage: G.localStorage, location: G.location, navigator: G.navigator, Node: G.Node, HTMLElement: G.HTMLElement, Event: G.Event, IS_REACT_ACT_ENVIRONMENT: G.IS_REACT_ACT_ENVIRONMENT };
beforeAll(() => {
  Object.assign(G, { window: dom, document: dom.document, localStorage: dom.localStorage, location: dom.location, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true });
});
afterAll(() => {
  Object.assign(G, saved);
});
beforeEach(() => {
  dom.localStorage.clear();
  dom.location.hash = "";
});

/** The shell as the server sent it, then its script, as the browser runs it
    before the first paint. */
function boot(): HTMLElement {
  dom.document.body.innerHTML = `<div id="app">${renderToString(<BootShell />)}</div>`;
  new Function(BOOT_SHELL_SCRIPT).call(dom);
  return dom.document.querySelector("[data-boot-shell]") as unknown as HTMLElement;
}
/** The name the stylesheet draws into every title (`::before` content). */
const drawnName = (root: HTMLElement) => root.style.getPropertyValue("--boot-name");

test("the stored project is named from the remembered name before the first paint", () => {
  dom.localStorage.setItem("llvProject", KEY);
  dom.localStorage.setItem("llvProjectNames", JSON.stringify({ [KEY]: "atlas" }));
  const root = boot();
  expect(root.getAttribute("data-boot-view")).toBe("project");
  expect(drawnName(root)).toBe('"atlas"');
  expect(root.hasAttribute("data-boot-named")).toBe(true);
  /* The titles themselves stay as the server rendered them: React owns them. */
  for (const title of root.querySelectorAll("[data-boot-title]")) expect(title.textContent).toBe("");
});

test("an opaque key with no remembered name stays a placeholder bar; the key is never written", () => {
  dom.localStorage.setItem("llvProject", KEY);
  const root = boot();
  expect(drawnName(root)).toBe("");
  expect(root.hasAttribute("data-boot-named")).toBe(false);
  expect(root.textContent ?? "").not.toContain(KEY);
  expect(root.getAttribute("style") ?? "").not.toContain(KEY);
  expect(root.querySelectorAll("[data-boot-title-bar]").length).toBeGreaterThan(0);
});

test("a readable key names itself, and the hash outranks storage", () => {
  dom.localStorage.setItem("llvProject", KEY);
  dom.location.hash = "#p=" + encodeURIComponent("-agents-tools-atlas");
  const root = boot();
  expect(drawnName(root)).toBe('"atlas"');
});

test("no stored project is the overview, and the language comes from storage", () => {
  dom.localStorage.setItem("llv_lang", "uk");
  const root = boot();
  expect(root.getAttribute("data-boot-view")).toBe("overview");
  expect(root.getAttribute("data-boot-locale")).toBe("uk");
  expect(dom.document.documentElement.lang).toBe("uk");
  /* Both languages are in the markup; the stylesheet shows the chosen one. */
  expect(root.innerHTML).toContain(translate("uk", "mobile2.board.working"));
  expect(root.innerHTML).toContain(en["mobile2.board.working"]);
});

/* The script runs between the server's HTML and React's hydration, so it
   must leave nothing React would call a mismatch: a mismatch throws the
   server DOM away and renders the whole root again on the client. */
async function hydrateAfterBoot(): Promise<{ recoverable: unknown[]; logged: unknown[][] }> {
  const root = boot();
  const recoverable: unknown[] = [];
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await act(async () => {
      hydrateRoot(dom.document.getElementById("app") as unknown as Element, <BootShell />, { onRecoverableError: (error) => recoverable.push(error) });
    });
    /* The same node survived: hydration adopted the server DOM. */
    expect(dom.document.querySelector("[data-boot-shell]") as unknown).toBe(root as unknown);
    return { recoverable, logged: [...errors.mock.calls, ...warnings.mock.calls] };
  } finally {
    errors.mockRestore();
    warnings.mockRestore();
  }
}

test("the script carries no `<`, so its own text hydrates equal in every parser", () => {
  expect(BOOT_SHELL_SCRIPT).not.toContain("<");
});

test("hydration adopts the shell after the script named it from a remembered name", async () => {
  dom.localStorage.setItem("llvProject", KEY);
  dom.localStorage.setItem("llvProjectNames", JSON.stringify({ [KEY]: "atlas" }));
  const { recoverable, logged } = await hydrateAfterBoot();
  expect(recoverable).toEqual([]);
  expect(logged).toEqual([]);
});

test("hydration adopts the shell for an opaque key with no name", async () => {
  dom.localStorage.setItem("llvProject", KEY);
  const { recoverable, logged } = await hydrateAfterBoot();
  expect(recoverable).toEqual([]);
  expect(logged).toEqual([]);
});

test("hydration adopts the shell with a hidden rail, a #p= hash and a folded seat", async () => {
  dom.localStorage.setItem("llv:rail-hidden:v1", "hidden");
  dom.localStorage.setItem("llv:kanban-seat:v2", JSON.stringify({ height: 420, heightV: 2, collapsed: { atlas: true }, placement: "top", width: null }));
  dom.location.hash = "#p=atlas";
  const { recoverable, logged } = await hydrateAfterBoot();
  expect(recoverable).toEqual([]);
  expect(logged).toEqual([]);
});
