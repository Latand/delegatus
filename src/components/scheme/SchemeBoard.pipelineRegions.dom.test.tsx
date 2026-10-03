import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Pipeline } from "@/lib/pipelines/types";
import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { directReviewFlows } from "@/components/flows/directReviewGroups";
import { compactPipelineArtifactPaths, excludeCompactPipelineArtifacts } from "@/components/pipelines/pipelineModel";
import { buildBranchGroups } from "@/components/projectModel";

import { SchemeBoard } from "./SchemeBoard";

/*
 * DOM regressions for issue #531: on the rendered production board every
 * pipeline's colored region (the dashed halo) contains ALL of its conversation
 * surfaces — live panes, placeholder/completed stage shells, and attached review
 * decks — and two regions never intersect. Fit All changes the board to its
 * overview chips; returning to the intermediate view restores every surface
 * inside the same owning region.
 */

const dom = new Window();
class TestResizeObserver {
  constructor(private callback: (entries: Array<{ target: HTMLElement; contentRect: DOMRect }>) => void) {}
  observe(element: HTMLElement) {
    Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 2400, bottom: 1600, width: 2400, height: 1600, toJSON() {} }) });
    queueMicrotask(() => this.callback([{ target: element, contentRect: element.getBoundingClientRect() }]));
  }
  unobserve() {}
  disconnect() {}
}
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = () => ({
  matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
});
Object.assign(globalThis, {
  window: dom,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDivElement: dom.HTMLDivElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: undefined,
});

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
  dom.sessionStorage.clear();
  dom.localStorage.clear();
});

function entry(over: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects", name: over.path, project: "demo", title: over.path,
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1000,
    size: 10, activity: "live", proc: null, pid: null, model: null,
    pendingQuestion: null, waitingInput: null, ...over,
  };
}

const stageRole = (access: "read-write" | "read-only") =>
  ({ roleId: null, engine: "codex" as const, model: null, effort: null, access, promptScaffold: null });

const stages = [
  { id: "build", kind: "run", prompt: "", next: "review", effectiveRole: stageRole("read-write") },
  { id: "review", kind: "review-loop", prompt: "", next: "polish", onFail: { to: "build", maxRounds: 5 }, effectiveRole: stageRole("read-only") },
  { id: "polish", kind: "run", prompt: "", next: null, effectiveRole: stageRole("read-write") },
];

const pipe = (id: string, agentPath: string, attemptState = "running", taskIds: string[] = []): Pipeline =>
  ({
    id, task: `Region ${id}`, project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b",
    baseBranch: "main", baseRef: "a", lastPassedCommit: "a", stages, taskIds,
    runs: [{ stageId: "build", attempts: [{ n: 1, effectiveRole: stageRole("read-write"), state: attemptState, agentPath, flowId: null }] }],
    cursor: { stageId: "build", state: attemptState, input: null, activatedBy: null },
    state: attemptState === "needs_decision" ? "needs_decision" : "running",
    pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: new Date(0).toISOString(), closedAt: null,
  }) as unknown as Pipeline;

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

interface DomRect { x: number; y: number; w: number; h: number }

/* World rect of a halo region (positioned via left/top) or a board card
   (positioned via translate()). Both are world-space px, zoom-independent. */
function rectOf(element: HTMLElement): DomRect {
  const style = element.style;
  const translated = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(style.transform ?? "");
  const x = translated ? Number.parseFloat(translated[1]!) : Number.parseFloat(style.left || "0");
  const y = translated ? Number.parseFloat(translated[2]!) : Number.parseFloat(style.top || "0");
  return { x, y, w: Number.parseFloat(style.width || "0"), h: Number.parseFloat(style.height || "0") };
}

const disjointWithGap = (a: DomRect, b: DomRect, gap: number): boolean =>
  a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y;

const contains = (outer: DomRect, inner: DomRect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

function haloRects(host: HTMLElement): Map<string, DomRect> {
  const rects = new Map<string, DomRect>();
  for (const header of host.querySelectorAll("[data-pipeline-group-header]")) {
    const region = (header as HTMLElement).closest('[data-scheme-group="pipeline"]') as HTMLElement | null;
    expect(region).toBeTruthy();
    rects.set(header.getAttribute("data-pipeline-group-header")!, rectOf(region!));
  }
  return rects;
}

function cardRect(host: HTMLElement, key: string): DomRect {
  const cards = host.querySelectorAll<HTMLElement>(`[data-scheme-node="${key}"]`);
  expect(cards, `board card ${key} must render exactly once`).toHaveLength(1);
  return rectOf(cards[0]!);
}

function expectSceneGeometry(host: HTMLElement, surfacesByPipeline: Map<string, string[]>) {
  const halos = haloRects(host);
  const ids = [...surfacesByPipeline.keys()];
  for (const id of ids) expect(halos.has(id), `pipeline ${id} must own a rendered colored region`).toBe(true);
  /* Region non-intersection: every pair keeps a stable visible corridor. */
  const entries = [...halos.entries()];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [aId, a] = entries[i]!;
      const [bId, b] = entries[j]!;
      expect(
        disjointWithGap(a, b, 24),
        `regions ${aId} ${JSON.stringify(a)} and ${bId} ${JSON.stringify(b)} intersect`,
      ).toBe(true);
    }
  }
  /* Complete child-bounds containment inside the owning region. */
  for (const [id, keys] of surfacesByPipeline) {
    const halo = halos.get(id)!;
    for (const key of keys) {
      const rect = cardRect(host, key);
      expect(
        contains(halo, rect),
        `surface ${key} ${JSON.stringify(rect)} escapes region ${id} ${JSON.stringify(halo)}`,
      ).toBe(true);
    }
  }
}

/** Fit All deliberately changes presentation: slots and decks leave the
    overview, while each conversation remains a chip in its pipeline section.
    Re-entering the intermediate view must restore the complete scene. */
async function expectFitRoundTrip(host: HTMLElement, surfaces: Map<string, string[]>, task?: { value: BoardTask; pipeline: string; neighbor: string }) {
  expect(host.querySelector("[data-scheme-bands]")?.getAttribute("data-scheme-bands")).toBe("intermediate");
  expectSceneGeometry(host, surfaces);
  const before = new Map([...surfaces].flatMap(([, keys]) => keys.map(key => [key, cardRect(host, key)] as const)));
  const beforeHalos = haloRects(host);
  const bandBefore = task ? linkedTaskBandRect(host, task.value) : null;
  const fit = host.querySelector<HTMLButtonElement>('button[title^="Fit all content"]');
  expect(fit).toBeTruthy();
  flushSync(() => fit!.click());
  await settle();

  expect(host.querySelector("[data-scheme-bands]")?.getAttribute("data-scheme-bands")).toBe("overview");
  const overview = new Map([...surfaces].map(([id, keys]) => [id, keys.filter(key => !key.startsWith("slot::") && !key.startsWith("deck::"))]));
  expectSceneGeometry(host, overview);
  for (const keys of surfaces.values()) {
    for (const key of keys) {
      const card = host.querySelector(`[data-scheme-node="${key}"]`);
      if (key.startsWith("slot::") || key.startsWith("deck::")) expect(card).toBeNull();
      else expect(card?.getAttribute("data-scheme-node-presentation")).toBe("chip");
    }
  }
  if (task) expectTaskBandOwnership(host, task.value, task.pipeline, task.neighbor);

  const current = host.querySelector<HTMLButtonElement>('button[title="Fit current work (0)"]');
  expect(current).toBeTruthy();
  flushSync(() => current!.click());
  await settle();
  expect(host.querySelector("[data-scheme-bands]")?.getAttribute("data-scheme-bands")).toBe("intermediate");
  expectSceneGeometry(host, surfaces);
  for (const [key, rect] of before) expect(cardRect(host, key)).toEqual(rect);
  expect(haloRects(host)).toEqual(beforeHalos);
  if (task) {
    expectTaskBandOwnership(host, task.value, task.pipeline, task.neighbor);
    expect(linkedTaskBandRect(host, task.value)).toEqual(bandBefore!);
  }
}

function mountScene(
  files: FileEntry[],
  pipelines: Pipeline[],
  tasks: BoardTask[] = [],
  flows: Flow[] = [],
  manual: FileEntry[] = [],
  sceneFiles: FileEntry[] = files,
  isolatedManualPaths: ReadonlySet<string> = new Set(),
): HTMLElement {
  const groups = buildBranchGroups(sceneFiles, "demo");
  const reviewGroups = directReviewFlows({ files, flows, tasks: [] });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(
    <SchemeBoard
      project="demo"
      groups={groups}
      manual={manual}
      files={files}
      flows={flows}
      reviewGroups={reviewGroups}
      pipelines={pipelines}
      surfacePipelines={pipelines}
      isolatedManualPaths={isolatedManualPaths}
      tasks={tasks}
      drafts={[]}
      focus={null}
      onSelect={() => {}}
      onClose={() => {}}
      onDraftClose={() => {}}
      onDraftSpawned={() => {}}
    />,
  ));
  return host;
}

/* Production scene: one origin conversation spawned two pipeline builders. Both
   pipelines still have future stages, so each grows a placeholder row wider than
   its builder card. Builder A also carries a direct one-shot review deck. */
const origin = entry({ path: "/origin" });
const builderA = entry({ path: "/origin/a", parent: "/origin", kind: "subagent", conversationId: "c-a" });
const builderB = entry({ path: "/origin/b", parent: "/origin", kind: "subagent", conversationId: "c-b" });
const directReviewer = entry({
  path: "/origin/a/review-1",
  parent: "/origin/a",
  conversationId: "c-r1",
  durableLineage: {
    kind: "review",
    role: "reviewer",
    parentConversationId: "c-a",
    reviewsConversationId: "c-a",
    memberships: [],
  },
});

/* The task's old authored pin is far outside the scene. The current board
   projects that task as a band enclosing its pipeline section. */
const linkedTask = (id: string): BoardTask =>
  ({
    id,
    project: "demo",
    status: "assigned",
    text: `Deliver ${id}`,
    placement: "pinned",
    pos: { x: 4200, y: 4200 },
    assignments: [],
    createdAt: "2026-07-05T00:00:00Z",
    updatedAt: "2026-07-05T00:00:00Z",
  }) as unknown as BoardTask;

function linkedTaskBandRect(host: HTMLElement, task: BoardTask): DomRect {
  const bands = host.querySelectorAll<HTMLElement>(`[data-scheme-band-task="${task.id}"]`);
  expect(bands, `task ${task.id} must own exactly one band`).toHaveLength(1);
  expect(bands[0]!.querySelector("[data-scheme-band-title]")?.textContent).toBe(task.text);
  expect(host.querySelector(`[data-scheme-task="${task.id}"]`)).toBeNull();
  return rectOf(bands[0]!);
}

function expectTaskBandOwnership(host: HTMLElement, task: BoardTask, pipeline: string, neighbor: string) {
  const halos = haloRects(host);
  const band = linkedTaskBandRect(host, task);
  expect(halos.has(pipeline)).toBe(true);
  expect(halos.has(neighbor)).toBe(true);
  expect(contains(band, halos.get(pipeline)!), `pipeline ${pipeline} escapes task ${task.id}'s band`).toBe(true);
  expect(disjointWithGap(halos.get(neighbor)!, band, 0), `task ${task.id}'s band overlaps pipeline ${neighbor}`).toBe(true);
}

test("at 62% intermediate zoom every pipeline surface stays inside its region and neighboring regions keep their gap", async () => {
  /* The camera starts at the reported 62% zoom. Every intermediate surface
     stays contained; Fit All also checks the overview's smaller projections. */
  dom.sessionStorage.setItem("llvCam:demo", JSON.stringify({ x: 0, y: 0, z: 0.62 }));
  const files = [origin, builderA, builderB, directReviewer];
  const taskA = linkedTask("t-a");
  const host = mountScene(files, [pipe("pa", "/origin/a", "running", ["t-a"]), pipe("pb", "/origin/b")], [taskA]);
  await settle();

  const viewport = host.querySelector('[aria-label^="Agent board"]') as HTMLElement;
  const world = Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale(")) as HTMLElement;
  expect(world.style.transform).toContain("scale(0.62)");

  const directDeck = host.querySelector('[data-scheme-node^="deck::"]');
  expect(directDeck, "the direct one-shot review deck must render on the board").toBeTruthy();
  const surfaces = new Map<string, string[]>([
    ["pa", ["/origin/a", "slot::pa::review", "slot::pa::polish", directDeck!.getAttribute("data-scheme-node")!]],
    ["pb", ["/origin/b", "slot::pb::review", "slot::pb::polish"]],
  ]);
  expectSceneGeometry(host, surfaces);
  expectTaskBandOwnership(host, taskA, "pa", "pb");
  await expectFitRoundTrip(host, surfaces, { value: taskA, pipeline: "pa", neighbor: "pb" });
});

test("host loss / delayed materialization: unscanned published transcripts keep two separated shell regions", async () => {
  /* Both builders published transcripts, then the runtime host died before the
     scanner surfaced them (the publish-to-place gap). Every stage rides a
     conversation-shaped shell; the two pipelines still own disjoint regions and
     every shell stays inside its own. */
  const files = [origin];
  const taskA = linkedTask("t-lost");
  const host = mountScene(files, [pipe("pa", "/lost/a", "running", ["t-lost"]), pipe("pb", "/lost/b")], [taskA]);
  await settle();

  expectSceneGeometry(host, new Map([
    ["pa", ["slot::pa::build", "slot::pa::review", "slot::pa::polish"]],
    ["pb", ["slot::pb::build", "slot::pb::review", "slot::pb::polish"]],
  ]));
  /* The origin conversation belongs to no pipeline: neither region may cover it. */
  const originRect = cardRect(host, "/origin");
  for (const halo of haloRects(host).values()) {
    expect(disjointWithGap(halo, originRect, 0), "a pipeline region covers a foreign conversation").toBe(true);
  }
  /* The linked task still owns the shell region through the publish-to-scan gap. */
  expectTaskBandOwnership(host, taskA, "pa", "pb");
});

test("a live pipeline beside a delayed-materialization pipeline keeps 24px of visible halo separation", async () => {
  /* Production transition: pa already materialized under its source conversation
     while pb has published a stage transcript that the scanner has not surfaced.
     The memberless row docks below all live content and must leave the same
     visible corridor as two materialized pipeline regions. */
  dom.sessionStorage.setItem("llvCam:demo", JSON.stringify({ x: 0, y: 0, z: 0.62 }));
  const host = mountScene(
    [origin, builderA],
    [pipe("pa", "/origin/a"), pipe("pb", "/lost/b")],
  );
  await settle();

  const viewport = host.querySelector('[aria-label^="Agent board"]') as HTMLElement;
  const world = Array.from(viewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale(")) as HTMLElement;
  expect(world.style.transform).toContain("scale(0.62)");

  const surfaces = new Map<string, string[]>([
    ["pa", ["/origin/a", "slot::pa::review", "slot::pa::polish"]],
    ["pb", ["slot::pb::build", "slot::pb::review", "slot::pb::polish"]],
  ]);
  expectSceneGeometry(host, surfaces);

  await expectFitRoundTrip(host, surfaces);
});

test("parked and completed stage cards stay inside their regions beside a live neighbor", async () => {
  /* pa parked in needs_decision on its builder; pb kept running. The parked
     pipeline's placeholder row and the live neighbor's row keep both regions
     separated, and each pipeline's surfaces stay contained. */
  const files = [origin, builderA, builderB];
  const host = mountScene(files, [pipe("pa", "/origin/a", "needs_decision"), pipe("pb", "/origin/b")]);
  await settle();

  expectSceneGeometry(host, new Map([
    ["pa", ["/origin/a", "slot::pa::review", "slot::pa::polish"]],
    ["pb", ["/origin/b", "slot::pb::review", "slot::pb::polish"]],
  ]));
});

test("managed fixing and closed-hidden/restored lifecycle panes stay inside their pipeline region", async () => {
  const fixingBuilder = entry({ path: "/fix/build", conversationId: "fix-build" });
  const fixingReviewer = entry({
    path: "/fix/review",
    parent: "/fix/build",
    kind: "subagent",
    conversationId: "fix-review",
  });
  const fixingFlow: Flow = {
    id: "fix-flow",
    template: "implement-review-loop",
    project: "demo",
    cwd: "/r",
    implementerPath: fixingBuilder.path,
    implementerConversationId: fixingBuilder.conversationId,
    roles: { implementer: { engine: "codex", model: null, effort: "low" }, reviewer: { engine: "codex", model: null, effort: "high" } },
    baseRef: "a",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "fixing",
    stateDetail: null,
    rounds: [{
      n: 1,
      reviewerPath: fixingReviewer.path,
      reviewerConversationId: fixingReviewer.conversationId,
      findingsPath: null,
      triggeredBy: "marker",
      readyNote: null,
      verdict: "REQUEST_CHANGES",
      findingsCount: 2,
      startedAt: "2026-07-22T00:00:00Z",
      reviewedAt: "2026-07-22T00:01:00Z",
      relayedAt: "2026-07-22T00:02:00Z",
      error: null,
    }],
    createdAt: "2026-07-22T00:00:00Z",
    closedAt: null,
  };
  const fixingPipeline = {
    ...pipe("fix-pipeline", fixingBuilder.path),
    stages: [
      { id: "build", kind: "run", prompt: "", next: "review", effectiveRole: stageRole("read-write") },
      { id: "review", kind: "review-loop", prompt: "", next: null, onFail: { to: "build", maxRounds: 5 }, effectiveRole: stageRole("read-only") },
    ],
    runs: [
      { stageId: "build", attempts: [{ n: 1, effectiveRole: stageRole("read-write"), state: "passed", agentPath: fixingBuilder.path, conversationId: fixingBuilder.conversationId, flowId: null }] },
      { stageId: "review", attempts: [{ n: 1, effectiveRole: stageRole("read-only"), state: "reviewing", agentPath: fixingReviewer.path, conversationId: fixingReviewer.conversationId, flowId: fixingFlow.id }] },
    ],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
  } as unknown as Pipeline;

  dom.sessionStorage.setItem("llvCam:demo", JSON.stringify({ x: 0, y: 0, z: 0.62 }));
  const activeHost = mountScene([fixingBuilder, fixingReviewer], [fixingPipeline], [], [fixingFlow]);
  await settle();
  expectSceneGeometry(activeHost, new Map([["fix-pipeline", [fixingBuilder.path, fixingReviewer.path]]]));
  expect(activeHost.querySelectorAll('[data-scheme-group="pipeline"]')).toHaveLength(1);
  expect(activeHost.querySelectorAll('[data-scheme-group="flow"]')).toHaveLength(0);
  expect(activeHost.querySelectorAll("[data-scheme-node]")).toHaveLength(2);
  expect(activeHost.querySelectorAll('[data-scheme-node="/fix/build"]')).toHaveLength(1);
  expect(activeHost.querySelectorAll('[data-scheme-node="/fix/review"]')).toHaveLength(1);
  const activeViewport = activeHost.querySelector('[aria-label^="Agent board"]') as HTMLElement;
  const activeWorld = Array.from(activeViewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale(")) as HTMLElement;
  expect(activeWorld.style.transform).toContain("scale(0.62)");

  const closedFlow = { ...fixingFlow, state: "closed", closedAt: "2026-07-22T00:03:00Z" } as Flow;
  const closed = {
    ...fixingPipeline,
    state: "closed",
    cursor: null,
    hiddenAt: "2026-07-22T00:03:00Z",
    closedAt: "2026-07-22T00:03:00Z",
  } as unknown as Pipeline;
  const fullCatalog = [
    { ...fixingBuilder, activity: "idle" as const },
    { ...fixingReviewer, activity: "idle" as const },
  ];
  const compact = compactPipelineArtifactPaths([closed], [closedFlow], fullCatalog);
  const hiddenSceneFiles = excludeCompactPipelineArtifacts(fullCatalog, compact);
  expect(hiddenSceneFiles).toEqual([]);
  const hiddenHost = mountScene(fullCatalog, [], [], [closedFlow], [], hiddenSceneFiles);
  await settle();
  expect(hiddenHost.querySelectorAll("[data-scheme-node]")).toHaveLength(0);
  expect(hiddenHost.querySelectorAll('[data-scheme-group="pipeline"]')).toHaveLength(0);

  // Restore into the single board that owns window-level keyboard navigation.
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  const restored = { ...closed, restored: true } as Pipeline;
  const restoredFlow = { ...closedFlow, restored: true } as Flow;
  const restoredReviewer = fullCatalog[1]!;
  dom.sessionStorage.setItem("llvCam:demo", JSON.stringify({ x: 0, y: 0, z: 0.62 }));
  const restoredHost = mountScene(
    fullCatalog,
    [restored],
    [],
    [restoredFlow],
    [restoredReviewer],
    hiddenSceneFiles,
    new Set([restoredReviewer.path]),
  );
  await settle();
  expectSceneGeometry(restoredHost, new Map([["fix-pipeline", [fixingReviewer.path]]]));
  expect(restoredHost.querySelectorAll('[data-scheme-node="/fix/review"]')).toHaveLength(1);
  const restoredViewport = restoredHost.querySelector('[aria-label^="Agent board"]') as HTMLElement;
  const restoredWorld = Array.from(restoredViewport.children).find((child) => (child as HTMLElement).style.transform.includes("scale(")) as HTMLElement;
  expect(restoredWorld.style.transform).toContain("scale(0.62)");

  await expectFitRoundTrip(restoredHost, new Map([["fix-pipeline", [fixingReviewer.path]]]));
  restoredViewport.focus();
  flushSync(() => window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event));
  await settle();
  expect(restoredHost.querySelector('[role="status"]')?.textContent).toBe("group::pipeline::fix-pipeline");
  flushSync(() => window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event));
  await settle();
  expect(restoredHost.querySelector('[data-scheme-node="/fix/review"] .ring-2')).toBeTruthy();
  expectSceneGeometry(restoredHost, new Map([["fix-pipeline", [fixingReviewer.path]]]));
});
