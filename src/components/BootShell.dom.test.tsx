/**
 * The first frame (#2071, docs/design/skeletons-and-transitions.md D1).
 *
 * The server used to render the desktop Overview with no data, so a phone's
 * first paint was a desktop layout claiming "No projects yet" until the bundle
 * ran. The server and hydration renders now draw the boot shell: both form
 * factors, one shown by `useIsMobile`'s own media query, named before first
 * paint by its inline script.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
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
const saved = { window: G.window, document: G.document, localStorage: G.localStorage, location: G.location, navigator: G.navigator };
beforeAll(() => {
  Object.assign(G, { window: dom, document: dom.document, localStorage: dom.localStorage, location: dom.location, navigator: dom.navigator });
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
  dom.document.body.innerHTML = renderToString(<BootShell />);
  new Function(BOOT_SHELL_SCRIPT).call(dom);
  return dom.document.querySelector("[data-boot-shell]") as unknown as HTMLElement;
}
const titles = (root: HTMLElement) => [...root.querySelectorAll("[data-boot-title]")];

test("the stored project is named from the remembered name before the first paint", () => {
  dom.localStorage.setItem("llvProject", KEY);
  dom.localStorage.setItem("llvProjectNames", JSON.stringify({ [KEY]: "atlas" }));
  const root = boot();
  expect(root.getAttribute("data-boot-view")).toBe("project");
  for (const title of titles(root)) {
    expect(title.textContent).toBe("atlas");
    expect(title.hasAttribute("data-boot-named")).toBe(true);
  }
});

test("an opaque key with no remembered name stays a placeholder bar; the key is never written", () => {
  dom.localStorage.setItem("llvProject", KEY);
  const root = boot();
  for (const title of titles(root)) {
    expect(title.textContent).toBe("");
    expect(title.hasAttribute("data-boot-named")).toBe(false);
  }
  expect(root.textContent ?? "").not.toContain(KEY);
  expect(root.querySelectorAll("[data-boot-title-bar]").length).toBeGreaterThan(0);
});

test("a readable key names itself, and the hash outranks storage", () => {
  dom.localStorage.setItem("llvProject", KEY);
  dom.location.hash = "#p=" + encodeURIComponent("-agents-tools-atlas");
  const root = boot();
  expect(titles(root)[0]!.textContent).toBe("atlas");
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
