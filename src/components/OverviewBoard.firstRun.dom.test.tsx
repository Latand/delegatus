import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale, translate } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";
import type { FileEntry } from "@/lib/types";

import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";
import { MOBILE_LAYOUT_QUERY, mobileLayoutViewport } from "@/lib/attention/eligibility";

import { getMobileNav } from "./mobile/mobileNav";
import { OverviewBoard } from "./OverviewBoard";

/*
 * Issue #1162, the zero-project overview. A first run used to answer with one
 * dead sentence («No logs yet») and no way forward. It now names where sessions
 * come from, offers the create button the rail's form already backs, and says
 * that running an agent in any repo works too — in both locales, and without
 * inventing a second creation path. The pairing with the rail itself is proven
 * end to end in ProjectRail.firstRun.dom.test.tsx.
 */

const dom = new Window({ url: "http://localhost/" });

let viewportWidth = 1280;
const matchMediaStub = (query: string) => ({
  matches: query === MOBILE_LAYOUT_QUERY && mobileLayoutViewport({ width: viewportWidth, height: 844 }),
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() {
    return false;
  },
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
  /* The board the Overview mounts measures card presence on a frame (#1820). */
  requestAnimationFrame: (callback: (t: number) => void) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});

function fileEntry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/sessions/a.jsonl",
    root: "claude-projects",
    name: "a.jsonl",
    project: "atlas",
    title: "Session",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    ...overrides,
  } as FileEntry;
}

/* The phone shell reads the runtime bus for its banner slot; keep it inert. */
setRuntimeUiEnabledForTests(false);

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = null;
  dom.document.body.replaceChildren();
  setLocale("en");
  viewportWidth = 1280;
});
afterAll(() => setRuntimeUiEnabledForTests(null));

function renderBoard(extra: Partial<React.ComponentProps<typeof OverviewBoard>> = {}): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  flushSync(() =>
    root!.render(
      <OverviewBoard
        files={[]}
        projectCatalog={[]}
        pipelines={[]}
        workflows={[]}
        archivedProjects={new Set()}
        now={2_000}
        onSelectProject={() => {}}
        {...extra}
      />,
    ),
  );
  return container as unknown as HTMLElement;
}

const panel = (host: HTMLElement) => host.querySelector('[data-testid="overview-first-run"]') as unknown as HTMLElement | null;
const createButton = (host: HTMLElement) => host.querySelector('[data-testid="overview-create-project"]') as unknown as HTMLElement | null;
const click = () => new dom.MouseEvent("click", { bubbles: true }) as unknown as Event;

test("zero projects: a title, where sessions come from, a labelled create button and the secondary route", () => {
  const host = renderBoard();
  const first = panel(host);
  expect(first).not.toBeNull();
  expect(first!.textContent).toContain(en["overview.firstRunTitle"]);
  expect(first!.textContent).toContain(en["overview.firstRunBody"]);
  expect(first!.textContent).toContain(en["overview.firstRunElsewhere"]);
  /* The button is labelled in text, not by an icon alone, and is a real 44px
     target on a finger. */
  const button = createButton(host)!;
  expect(button).not.toBeNull();
  expect(button.textContent).toContain(en["overview.firstRunCreate"]);
  expect(button.className).toContain("min-h-11");
  /* Both scanner roots are named, so the operator can tell whether the viewer
     is looking where their sessions actually land. */
  expect(first!.textContent).toContain("~/.claude/projects");
  expect(first!.textContent).toContain("~/.codex/sessions");
});

test("the retired «No logs yet» copy is gone from the dictionaries and the board", () => {
  const host = renderBoard();
  expect(host.textContent).not.toContain("No logs yet");
  expect(Object.keys(en)).not.toContain("overview.empty");
  expect(Object.keys(uk)).not.toContain("overview.empty");
});

/* #2166 §3.5: the create button opens the setup guide on its Project step,
   whose form is the rail's own, desktop and phone alike, so the path goes on
   to the project's orchestrator instead of stopping at a new project. */
for (const width of [1440, 390]) {
  test(`the create button opens the setup guide on its Project step at ${width}`, () => {
    viewportWidth = width;
    const opened: unknown[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent).detail);
    dom.addEventListener("llv:open-onboarding", listener as never);
    /* The guide opens on a window event: this window's own CustomEvent. */
    const G = globalThis as { CustomEvent: unknown };
    const savedCustomEvent = G.CustomEvent;
    G.CustomEvent = dom.CustomEvent;
    try {
      const host = renderBoard();
      flushSync(() => createButton(host)!.dispatchEvent(click()));
    } finally {
      G.CustomEvent = savedCustomEvent;
      dom.removeEventListener("llv:open-onboarding", listener as never);
    }
    expect(opened).toEqual([{ mode: "guide", step: "project" }]);
    getMobileNav().home();
  });
}

test("a board with projects on it renders the kanban, never the first-run panel", () => {
  const host = renderBoard({ files: [fileEntry()] });
  expect(panel(host)).toBeNull();
  expect(createButton(host)).toBeNull();
  /* #1820: the Overview's board IS the project board, over every project. */
  expect(host.querySelector("[data-kanban-board]")).not.toBeNull();
});

test("an installation whose only project is archived is not a first run", () => {
  /* The header says «1 archived» two rows up: a panel titled «No projects yet»
     under it would contradict the same screen. Archived projects are still
     projects — the first-run panel waits for an installation with none. */
  const host = renderBoard({ files: [fileEntry()], archivedProjects: new Set(["atlas"]) });
  expect(panel(host)).toBeNull();
  expect(createButton(host)).toBeNull();
  expect(host.textContent).not.toContain(en["overview.firstRunTitle"]);
  expect(host.textContent).toContain(en["overview.archived"].replace("{count}", "1"));
  expect(host.querySelector("[data-kanban-board]")).toBeNull();
});

test("an unreachable catalog keeps its failure notice instead of the first-run panel", () => {
  const host = renderBoard({ catalogFailures: 2 });
  expect(panel(host)).toBeNull();
  expect(host.querySelector('[data-catalog-error="true"]')).not.toBeNull();
});

test("Ukrainian carries the same four lines", () => {
  setLocale("uk");
  const host = renderBoard();
  const first = panel(host)!;
  expect(first.textContent).toContain(translate("uk", "overview.firstRunTitle"));
  expect(first.textContent).toContain(translate("uk", "overview.firstRunBody"));
  expect(first.textContent).toContain(translate("uk", "overview.firstRunElsewhere"));
  expect(createButton(host)!.textContent).toContain(translate("uk", "overview.firstRunCreate"));
});
