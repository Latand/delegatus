import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import { laneRowsFor, type LaneRow } from "@/lib/links/laneFeed";
import { buildPipeline } from "@/lib/pipelines/store";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

/*
 * The receiver's half of a lane row (docs/design/synced-task-card.md §6, §7):
 * `remoteLaneSummary` turns what a peer published into the summary the one
 * pipeline block draws, and the block draws it without a control. A real
 * pipeline is encoded by the sender's code first, so the chips the receiver
 * draws are compared with the chips the owner's own board draws.
 */

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  localStorage: dom.localStorage, ResizeObserver: undefined,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => { for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; } });
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { PipelineBlock } = await import("./PipelineBlock");
const { remoteLaneNote, remoteLaneSummary } = await import("./remoteLaneSummary");
const { summarizePipeline } = await import("@/components/kanban/kanbanModel");
const { WorkLinksProvider } = await import("@/components/workLinks/workLinksContext");
const { setLocale, translate } = await import("@/lib/i18n");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  setLocale("en");
});

const NOW_MS = Date.parse("2026-09-30T12:00:00Z");
const project = `repo-${"a".repeat(32)}`;
const TASK = "00000000-0000-0000-0000-000000000001";
const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("en", key, params);

type Spec = { id: string; role: "builder" | "reviewer"; kind?: "run" | "review-loop"; next: string | null; onFail?: { to: string; maxRounds: number }; state?: string; attempts?: number; findings?: string[] };
function pipeline(state: Pipeline["state"], specs: Spec[], current?: string): Pipeline {
  const stages = specs.map((spec) => ({
    id: spec.id, kind: spec.kind ?? "run", role: { roleId: spec.role }, prompt: "", next: spec.next, onFail: spec.onFail ?? null,
    effectiveRole: { roleId: spec.role, engine: spec.role === "reviewer" ? "claude" : "codex", model: spec.role === "reviewer" ? "opus" : "gpt-6.1-sol", effort: "medium", access: "read-write", promptScaffold: null },
  })) as unknown as PipelineStage[];
  const at = new Date(NOW_MS - 600_000).toISOString();
  const built = buildPipeline({ id: "5e0a41c2", task: "Ship the synced card", taskIds: [TASK], project: "p", repoDir: "/repo", stages, srcPath: null, srcConversationId: null, now: at });
  built.state = state;
  built.cursor = current ? { stageId: current, state: "running", input: null, activatedBy: null } : null;
  built.runs = specs.map((spec) => ({ stageId: spec.id, attempts: spec.state ? Array.from({ length: spec.attempts ?? 1 }, (_v, index) => ({
    n: index + 1, state: index + 1 === (spec.attempts ?? 1) ? spec.state! : "passed", effectiveRole: built.stages.find((stage) => stage.id === spec.id)!.effectiveRole,
    launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null, startedAt: at, completedAt: null, input: null, activatedBy: null, output: null,
    verdict: spec.findings ? { status: "fail", findings: spec.findings } : null, error: null,
  })) : [] })) as unknown as Pipeline["runs"];
  return built;
}
const SPECS: Spec[] = [
  { id: "build", role: "builder", next: "review", state: "passed" },
  { id: "review", role: "reviewer", next: "fix", onFail: { to: "fix", maxRounds: 2 }, state: "failed", attempts: 2, findings: ["one", "two"] },
  { id: "fix", role: "builder", next: null },
];
const task = { id: TASK, project, text: "Ship the synced card" } as unknown as BoardTask;
const encode = (source: Pipeline): LaneRow => laneRowsFor(() => [source], [task], new Set([project]), () => true)[0]!;

function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(<WorkLinksProvider value={{ pipelines: {}, tasks: {} } as never}>{node}</WorkLinksProvider>));
  return host;
}

const STATES: Array<[Pipeline["state"], string | undefined, string | null]> = [
  ["provisioning", undefined, null],
  ["running", "fix", null],
  ["needs_decision", "review", "Waiting for a decision on Review · 2 findings · answer it on Stage"],
  ["needs_review", undefined, "Review rounds used up on Review · decide on Stage"],
  ["paused", "fix", "Paused on Review · resume it on Stage"],
  ["completed", undefined, null],
  ["closed", undefined, null],
];

test("what the receiver draws is what the owner's board draws: the chips' order, states, branches and loops round-trip the wire", () => {
  for (const [state, current] of STATES) {
    const source = pipeline(state, SPECS, current);
    const owner = summarizePipeline(source);
    const received = remoteLaneSummary(JSON.parse(JSON.stringify(encode(source))), "Ship the synced card");
    expect(received.chips.map((chip) => [chip.stage.id, chip.state, chip.branch, chip.rounds])).toEqual(owner.chips.map((chip) => [chip.stage.id, chip.state, chip.branch, chip.rounds]));
    expect(received.loops.map((loop) => [loop.from.id, loop.to.id, loop.fired, loop.max])).toEqual(owner.loops.map((loop) => [loop.from.id, loop.to.id, loop.fired, loop.max]));
    expect(received.waiting).toBe(owner.waiting);
    expect(received.pipeline.state).toBe(state);
  }
});

test("each state of the lane draws in both densities: one pill per stage with the owner's states, no control, and the note where a person is waited on", () => {
  for (const [state, current, sentence] of STATES) {
    const row = encode(pipeline(state, SPECS, current));
    const summary = remoteLaneSummary(row, "Ship the synced card");
    const managedOn = remoteLaneNote(t, row, "Stage", null);
    expect(managedOn.note).toBe(sentence);
    for (const density of ["task", "card"] as const) {
      const host = mount(<PipelineBlock summary={summary} density={density} nowMs={NOW_MS} taskTitle="Ship the synced card" managedOn={managedOn} />);
      const pills = [...host.querySelectorAll<HTMLElement>(".pb-pill[data-stage]")];
      /* A finished lane is one muted line on the card, as it is at home. */
      if (density === "card" && (state === "completed" || state === "closed")) expect(host.querySelector(".pb-ended")?.textContent).toContain(t(`pipelineState.${state}`));
      else expect(pills.length).toBeGreaterThan(0);
      /* The card line folds a long chain to fit; the task row draws every stage. */
      if (density === "task") expect(pills.map((pill) => pill.dataset.stage)).toEqual(["build", "review", "fix"]);
      for (const pill of pills) {
        const chip = summary.chips.find((entry) => entry.stage.id === pill.dataset.stage)!;
        expect(pill.classList.contains(`st-${chip.state}`)).toBe(true);
      }
      expect(host.querySelectorAll("button, a, input")).toHaveLength(0);
      expect(host.querySelector("[data-managed]")).not.toBeNull();
      if (density === "task") expect(host.querySelector("[data-managed-on]")?.textContent ?? null).toBe(sentence);
      if (density === "card") {
        const reason = host.querySelector("[data-pipeline-reason]")?.textContent ?? null;
        if (sentence) expect(reason).toMatch(new RegExp(`^${sentence.replace(/ · (answer it|decide|resume it) on Stage$/, "")} · \\d+[smh]$`));
        else expect(reason).toBeNull();
      }
      document.body.replaceChildren();
    }
  }
});

test("a stale lane ends its note with when it was last current, and a lane that waits on nobody gets that note alone", () => {
  const stale = { asOf: Date.UTC(2026, 8, 30, 10, 31), locale: "en" };
  const parked = remoteLaneNote(t, encode(pipeline("needs_decision", SPECS, "review")), "Stage", stale);
  expect(parked.note).toMatch(/answer it on Stage · as of \d{1,2}:\d{2}/);
  const running = remoteLaneNote(t, encode(pipeline("running", SPECS, "fix")), "Stage", stale);
  expect(running.note).toMatch(/^as of \d{1,2}:\d{2}/);
  expect(running.reason).toBeNull();
});

test("the owner's model and role reach the pill's glyph and name, and Ukrainian words follow the locale", () => {
  setLocale("uk");
  const row = encode(pipeline("needs_decision", SPECS, "review"));
  const ukT = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate("uk", key, params);
  const managedOn = remoteLaneNote(ukT, row, "Stage", null);
  expect(managedOn.note).toContain("відповісти можна на Stage");
  const host = mount(<PipelineBlock summary={remoteLaneSummary(row, "Ship the synced card")} density="task" nowMs={NOW_MS} taskTitle="Ship the synced card" managedOn={managedOn} />);
  expect(host.querySelector(".pstate-word")?.textContent).toBe(translate("uk", "pipelineState.needs_decision"));
  const review = host.querySelector<HTMLElement>('.pb-pill[data-stage="review"]')!;
  expect(review.title).toContain(translate("uk", "kanban.graphState.failed"));
  /* The stage ran on the owner, so the pill says what it ran on, not that it is only configured. */
  expect(review.title).not.toContain(translate("uk", "kanban.identity.configured"));
});
