import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";

import { GroupsLayer } from "./nodes";
import { GroupOverridePanel } from "./GroupOverridePanel";
import type { SchemeGroup } from "./layout";
import { Z } from "@/components/layers";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLSelectElement: dom.HTMLSelectElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
});

/* Capture every PATCH so the note/action a click submits can be asserted. */
const calls: Array<{ url: string; body: unknown }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: { body?: string }) => {
  calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
  return { ok: true, json: async () => ({}) };
}) as unknown as typeof fetch;

afterEach(() => {
  document.body.replaceChildren();
  calls.length = 0;
});
/* Restore fetch as soon as THIS file finishes: a process-exit restore left the
   answer-everything mock live for every later test file in the run, poisoning
   any component that fetches real JSON shapes (SpeakButton's backend info). */
afterAll(() => { globalThis.fetch = realFetch; });

function mount(node: React.ReactElement): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  return { host, root };
}

const flowGroup: SchemeGroup = {
  key: "group::flow::f1", kind: "flow", id: "f1", hue: 210, members: ["/impl"],
  label: "Flow one", x: 100, y: 80, w: 900, h: 780,
  flow: {
    id: "f1",
    roles: { implementer: { engine: "codex", model: null, effort: null }, reviewer: { engine: "codex", model: null, effort: null } },
    roundLimit: 5,
    state: "waiting_ready",
    rounds: [],
  } as unknown as Flow,
};

test("the override panel opens in a foreground layer, not nested in a halo stacking context (issue #118 review F1)", () => {
  const { host, root } = mount(<GroupsLayer groups={[flowGroup]} interactive />);
  const chip = host.querySelector("[data-scheme-group] button") as HTMLButtonElement;
  expect(chip).toBeTruthy();
  flushSync(() => chip.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));

  const panel = host.querySelector("[data-group-override]") as HTMLElement;
  expect(panel).toBeTruthy();
  /* The panel must NOT live inside a [data-scheme-group] halo wrapper — that
     wrapper's positioning context would paint it beneath the scheme cards. */
  expect(panel.closest("[data-scheme-group]")).toBeNull();
  /* It sits in a foreground container on the popover layer, so it paints above the cards. */
  expect(panel.closest(`[class~="${Z.popover}"]`)).toBeTruthy();

  flushSync(() => root.unmount());
  host.remove();
});

test.each(["waiting_ready", "reviewing", "relaying", "needs_decision", "paused", "approved"] as const)("a recorded %s group cannot send any flow mutation", state => {
  const group = { ...flowGroup, flow: { ...flowGroup.flow!, state } };
  const { host, root } = mount(<GroupOverridePanel group={group} onClose={() => undefined} />);
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.querySelector("input")).toBeNull();
  expect(host.querySelector("select")).toBeNull();
  expect(host.textContent).toContain("Review history");
  const button = [...host.querySelectorAll("button")].find(item => item.textContent === "Review history")!;
  flushSync(() => button.click());
  expect(calls.filter(call => call.url.includes("/api/flows"))).toEqual([]);
  flushSync(() => root.unmount()); host.remove();
});

const pipelineGroup: SchemeGroup = {
  key: "group::pipeline::p1", kind: "pipeline", id: "p1", hue: 24, members: ["/plan"],
  label: "Pipe one", x: 0, y: 0, w: 10, h: 10,
  pipeline: {
    id: "p1",
    task: "Ship it",
    state: "running",
    stages: [
      { id: "plan", kind: "run", role: { roleId: "architect" }, prompt: "Plan", next: "build", effectiveRole: { engine: "claude", model: "fable", effort: "high", access: "read-only", roleId: "architect", promptScaffold: null } },
      { id: "build", kind: "run", role: { roleId: "architect" }, prompt: "Build it", next: null, effectiveRole: { engine: "claude", model: "fable", effort: "high", access: "read-write", roleId: "architect", promptScaffold: null } },
    ],
    runs: [
      { stageId: "plan", attempts: [{ agentPath: "/plan", state: "running" }] },
      { stageId: "build", attempts: [] },
    ],
  } as unknown as Pipeline,
};

function draftFixture(): SchemeGroup {
  return {
    ...pipelineGroup,
    pipeline: {
      ...pipelineGroup.pipeline!,
      state: "draft",
      repoDir: "/repo",
      cursor: { stageId: "plan", state: "pending", input: null, activatedBy: null },
      runs: pipelineGroup.pipeline!.stages.map((stage) => ({ stageId: stage.id, attempts: [] })),
    } as Pipeline,
  };
}

function emptyDraftFixture(): SchemeGroup {
  return {
    ...pipelineGroup,
    pipeline: {
      ...pipelineGroup.pipeline!,
      state: "draft",
      repoDir: "/repo",
      stages: [],
      runs: [],
      cursor: null,
    } as unknown as Pipeline,
  };
}

/* Stage editing moved entirely onto the canvas conversation/placeholder cards
   (#507 review F1): the override panel is now pipeline-scoped only. These tests
   pin that contract — no nested stage form, no nested scroller — and that the
   pipeline-level actions the panel alone owns still fire. Per-stage editing is
   covered on its new home in StagePlaceholderPane.dom.test.tsx. */

test("the override panel keeps only pipeline-level controls and points stage edits to the canvas (#507 F1)", () => {
  const { host, root } = mount(<GroupOverridePanel group={draftFixture()} onClose={() => undefined} />);
  /* No per-stage editor: no draggable stage cards, no nested scroller, and no
     stage role/engine/effort <select> (the draft form uses inputs + textarea only). */
  expect(host.querySelectorAll("[data-stage-card]").length).toBe(0);
  expect(host.querySelectorAll("select").length).toBe(0);
  /* No nested stage scroller — the removed DraftStageCards used a max-h-[46vh]
     overflow-y-auto list; only the panel's own outer scroll remains. */
  expect(host.querySelector(".max-h-\\[46vh\\]")).toBeNull();
  /* The operator is pointed at the canvas cards instead. */
  const hint = host.querySelector("[data-pipeline-editor-canvas-hint]");
  expect(hint?.textContent ?? "").toContain("Edit stages on their cards");
  /* Pipeline-level controls remain: draft details, Start, Discard. */
  expect(host.querySelector('input')).toBeTruthy();
  expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.includes("Start pipeline"))).toBe(true);
  expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.includes("Discard"))).toBe(true);
  flushSync(() => root.unmount());
  host.remove();
});

test("a draft's Start action posts start (#507 F1)", async () => {
  const { host, root } = mount(<GroupOverridePanel group={draftFixture()} onClose={() => undefined} />);
  const start = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Start pipeline")) as HTMLButtonElement;
  expect(start.disabled).toBe(false);
  flushSync(() => start.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await Promise.resolve();
  expect(calls.at(-1)?.body).toEqual({ action: "start" });
  flushSync(() => root.unmount());
  host.remove();
});

test("an empty draft has no stages, no canvas hint, and disables Start (#507 F1)", () => {
  const { host, root } = mount(<GroupOverridePanel group={emptyDraftFixture()} onClose={() => undefined} />);
  expect(host.querySelectorAll("[data-stage-card]").length).toBe(0);
  /* No editable stage yet → no pointer to the canvas, and Start is blocked until
     the first stage is added on the canvas. */
  expect(host.querySelector("[data-pipeline-editor-canvas-hint]")).toBeNull();
  const start = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Start pipeline")) as HTMLButtonElement;
  expect(start.disabled).toBe(true);
  flushSync(() => root.unmount());
  host.remove();
});

test("Discard posts delete on the draft (#507 F1)", async () => {
  const { host, root } = mount(<GroupOverridePanel group={draftFixture()} onClose={() => undefined} />);
  const discard = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Discard")) as HTMLButtonElement;
  expect(discard).toBeTruthy();
  flushSync(() => discard.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await Promise.resolve();
  expect(calls.at(-1)?.body).toEqual({ action: "delete" });
  flushSync(() => root.unmount());
  host.remove();
});

test("a running pipeline shows the canvas hint for its unrun stages and posts pause (#507 F1)", async () => {
  const { host, root } = mount(<GroupOverridePanel group={pipelineGroup} onClose={() => undefined} />);
  /* The build stage has never run, so an on-canvas edit is still possible — the
     panel points there rather than mounting a nested next-stage form. */
  expect(host.querySelector("[data-pipeline-editor-canvas-hint]")).toBeTruthy();
  expect(host.querySelectorAll("select").length).toBe(0);
  const pause = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Pause")) as HTMLButtonElement;
  flushSync(() => pause.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await Promise.resolve();
  expect(calls.at(-1)?.body).toEqual({ action: "pause" });
  flushSync(() => root.unmount());
  host.remove();
});

test("a parked pipeline offers retry and skip", async () => {
  const parked: SchemeGroup = {
    ...pipelineGroup,
    pipeline: { ...pipelineGroup.pipeline!, state: "needs_decision" } as Pipeline,
  };
  const { host, root } = mount(<GroupOverridePanel group={parked} onClose={() => undefined} />);
  const retry = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Retry")) as HTMLButtonElement;
  const skip = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Skip")) as HTMLButtonElement;
  expect(retry).toBeTruthy();
  expect(skip).toBeTruthy();
  flushSync(() => retry.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await Promise.resolve();
  expect((calls.at(-1)?.body as { action?: string })?.action).toBe("retry-stage");
  flushSync(() => root.unmount());
  host.remove();
});
