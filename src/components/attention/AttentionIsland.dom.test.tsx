import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  Event: dom.Event,
  localStorage: dom.localStorage,
});

const { AttentionIsland } = await import("./AttentionIsland");
const { advanceAttentionCycle, buildAttentionQueue } = await import("../attention");
type FileEntry = import("@/lib/types").FileEntry;
type AttentionItem = import("../attention").AttentionItem;

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(node);
  });
  return host;
}

function island(overrides: Partial<Parameters<typeof AttentionIsland>[0]> = {}) {
  return (
    <AttentionIsland
      count={3}
      panelOpen={false}
      filterActive={false}
      onTogglePanel={() => {}}
      onToggleFilter={() => {}}
      {...overrides}
    />
  );
}

const click = (element: Element, init: { shiftKey?: boolean } = {}) =>
  act(async () => {
    element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true, ...init }) as never);
  });

test("the control reads «● Waiting N» in the bar's own outlined style, and opens the panel", async () => {
  const toggles: string[] = [];
  const host = await render(island({ count: 6, onTogglePanel: () => toggles.push("panel") }));
  const count = host.querySelector("[data-attention-count]")!;
  expect(count.textContent).toBe("Waiting6");
  expect(count.querySelector("[data-attention-dot]")).not.toBeNull();
  expect(count.getAttribute("aria-label")).toBe("6 waiting");
  expect(count.getAttribute("aria-expanded")).toBe("false");
  /* The bar's control, not the amber uppercase pill. */
  expect(count.className).toContain("h-8");
  expect(count.className).toContain("border-border");
  expect(count.className).not.toContain("uppercase");
  expect(count.className).not.toContain("bg-warning-soft");
  await click(count);
  expect(toggles).toEqual(["panel"]);
});

test("there is no Next: nothing in the header walks the operator from project to project", async () => {
  const host = await render(island({ count: 5 }));
  expect(host.querySelector("[data-attention-next]")).toBeNull();
  expect(host.querySelector("[aria-keyshortcuts]")).toBeNull();
  expect(host.textContent).not.toContain("Next");
});

test("open, the control is pressed in the accent tone", async () => {
  const host = await render(island({ panelOpen: true }));
  const count = host.querySelector("[data-attention-count]")!;
  expect(count.getAttribute("aria-expanded")).toBe("true");
  expect(count.className).toContain("text-accent");
});

test("the filter toggle keeps its pressed state and accessible labels", async () => {
  const toggles: string[] = [];
  let host = await render(island({ onToggleFilter: () => toggles.push("filter") }));
  const filter = host.querySelector("[data-attention-filter]")!;
  expect(filter.getAttribute("aria-pressed")).toBe("false");
  expect(filter.getAttribute("aria-label")).toContain("(F)");
  await click(filter);
  expect(toggles).toEqual(["filter"]);
  await act(async () => { root?.unmount(); });
  document.body.replaceChildren();

  host = await render(island({ filterActive: true }));
  expect(host.querySelector("[data-attention-filter]")!.getAttribute("aria-pressed")).toBe("true");
});

test("with no toggle handed in, the island offers no filter and keeps its count", async () => {
  const host = await render(island({ count: 1, onToggleFilter: undefined }));
  expect(host.querySelector("[data-attention-filter]")).toBeNull();
  expect(host.querySelector("[data-attention-count]")!.textContent).toContain("1");
});

test("the zero state stays on screen, muted and without the dot, still opening the panel", async () => {
  const toggles: string[] = [];
  const host = await render(island({ count: 0, onToggleFilter: undefined, onTogglePanel: () => toggles.push("panel") }));
  const zero = host.querySelector("[data-attention-island]")!;
  expect(zero.hasAttribute("data-attention-zero")).toBeTrue();
  const count = host.querySelector("[data-attention-count]")!;
  expect(count.textContent).toBe("Waiting0");
  expect(count.getAttribute("aria-label")).toBe("0 waiting");
  expect(count.querySelector("[data-attention-dot]")).toBeNull();
  expect(count.className).toContain("text-muted");
  expect(count.className).not.toContain("animate");
  await click(count);
  expect(toggles).toEqual(["panel"]);
});

/* ------------------------------------------------------------------------- *
 * The N key still walks, and only the project on screen (D4): the one route
 * the Viewer wires, over its project queue.
 * ------------------------------------------------------------------------- */

/* The wall clock: a row re-derives its decision line on render, and the stalled
   tier only counts while a process is behind the transcript and the signal is
   fresh — so its fixtures age against the same clock the render reads. */
const NOW = Math.floor(Date.now() / 1000);

function entry(path: string, project: string, since: number): FileEntry {
  return {
    root: "claude-projects",
    name: path,
    path,
    project,
    title: path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: NOW - 60,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: { since, screenTail: "❯ 1. Yes", target: "llv:0.0", menu: null },
  } as FileEntry;
}

test("N walks the project on screen and never leaves it, surviving queue mutation mid-flight", () => {
  const files = [
    entry("/alpha-old", "alpha", NOW - 400),
    entry("/beta-mid", "beta", NOW - 300),
    entry("/alpha-new", "alpha", NOW - 200),
  ];
  const projectQueue: AttentionItem[] = buildAttentionQueue(files, NOW, "alpha");
  const pointer: { current: string | null } = { current: null };
  const served = [1, 1, 1].map((dir) => advanceAttentionCycle(pointer, projectQueue, dir as 1)!.file.path);
  expect(served).toEqual(["/alpha-old", "/alpha-new", "/alpha-old"]);
  /* The pointed-at item is answered elsewhere: the next press serves the
     next-oldest remaining item of this project. */
  pointer.current = projectQueue[0]!.id;
  const rebuilt = buildAttentionQueue([files[1]!, files[2]!], NOW, "alpha");
  expect(advanceAttentionCycle(pointer, rebuilt, 1)!.file.path).toBe("/alpha-new");
});
