import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";
import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import { setLocale, translate } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";

/*
 * The Overview before its first answer (#2071, docs/design/skeletons-and-
 * transitions.md D6). It used to show the first-run panel («No projects yet»,
 * create a project) and «nothing is running right now» for as long as
 * `/api/files` was in flight: a claim that nothing exists, made before
 * anything was known. Until an answer is certified it draws the board's shape
 * and says it is loading; the first run needs a certified empty answer.
 */

const dom = new Window({ url: "http://localhost/" });
let phone = false;
const matchMediaStub = (query: string) => ({
  matches: phone && query === MOBILE_LAYOUT_QUERY,
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});
(dom as unknown as { matchMedia: typeof matchMediaStub }).matchMedia = matchMediaStub;
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: matchMediaStub,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: (t: number) => void) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
setRuntimeUiEnabledForTests(false);

const { OverviewBoard } = await import("./OverviewBoard");

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = null;
  phone = false;
  dom.document.body.replaceChildren();
  setLocale("en");
});
afterAll(() => setRuntimeUiEnabledForTests(null));

function render(loaded: boolean): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  root = createRoot(host as unknown as Element);
  flushSync(() => root!.render(
    <OverviewBoard files={[]} projectCatalog={[]} pipelines={[]} workflows={[]} archivedProjects={new Set()} loaded={loaded} now={1_000} onSelectProject={() => {}} />,
  ));
  return host as unknown as HTMLElement;
}

for (const surface of ["desktop", "phone"] as const) {
  test(`${surface}: before the first answer the overview draws the board's shape, never the first run`, () => {
    phone = surface === "phone";
    const host = render(false);
    expect(host.querySelector('[data-testid="overview-first-run"]')).toBeNull();
    expect(host.textContent).not.toContain(en["overview.firstRunTitle"]);
    expect(host.textContent).not.toContain(en["common.nothingRunning"]);
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(host.querySelector(phone ? '[data-skeleton="rows-list"]' : "[data-kanban-skeleton]")).not.toBeNull();
  });
}

test("desktop: the subtitle says loading, in en and uk, and the first run waits for a certified empty answer", () => {
  const host = render(false);
  expect(host.textContent).toContain(en["common.loadingCap"]);
  flushSync(() => setLocale("uk"));
  expect(host.textContent).toContain(translate("uk", "common.loadingCap"));
  flushSync(() => root!.unmount());
  root = null;
  const answered = render(true);
  expect(answered.querySelector('[data-testid="overview-first-run"]')).not.toBeNull();
});
