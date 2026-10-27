import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore, type ConnectionState } from "@/components/runtime/runtimeModel";
import type { PatchPipelineRequest, Pipeline } from "@/lib/pipelines/types";
import type { PipelinePorts, PipelineWriteResult } from "@/components/kanban/pipelinePorts";
import { stageDigests } from "@/lib/pipelines/stageDigest";

/* A draft drawn from a conversation on the phone's pipeline screen
   (docs/design/start-pipeline-from-conversation/implementation.md, variant 3):
   the stages, «+ Stage» appending after the chain's last over `add-stage`,
   the Builder's first message in the board's own editor and store, and
   «Start pipeline» at the foot, held while an edit is open. The pipeline
   route is a stub; no state directory is touched. */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const runtime = { enabled: false, connection: "live" as ConnectionState, lastEventAt: null as number | null, resyncedAt: null, store: emptyStore(), structuredHostsEnabled: false };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => runtime,
  useRuntime: () => runtime,
  useRuntimeSelector: (selector: (state: typeof runtime) => unknown) => selector(runtime),
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const { MobilePipelineScreen } = await import("@/components/mobile/MobilePipelineScreen");
const { createMobileNav, MobileNavContext } = await import("@/components/mobile/mobileNav");
const { fakeHistory } = await import("@/components/mobile/mobileNavTestHistory");
const { StageDrafts } = await import("@/components/kanban/stageDrafts");
const { ConversationDrafts } = await import("./conversationDraftClient");
const { appendStageRequest, passTail } = await import("./DraftStageControls");

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => { for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; } });
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});
let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; });
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; });

const NOW = 1_800_000_000;
const at = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1_000).toISOString();
const role = (roleId: string) => ({ roleId, engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null });
function draft(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p-export", task: "CSV export fails on large projects", taskIds: ["t-export"], project: "atlas", repoDir: "/repo", worktreeDir: null,
    branch: "pipeline/csv-export-p-export", baseBranch: "fix/csv-export-retry", baseRef: "c".repeat(40), lastPassedCommit: "c".repeat(40),
    stages: [
      { id: "builder", kind: "run", role: { roleId: "builder" }, prompt: "{{task}}\n\nCSV export fails past 50k rows.", next: "reviewer", onFail: null, effectiveRole: role("builder") },
      { id: "reviewer", kind: "run", role: { roleId: "reviewer" }, prompt: "{{prev.output}}", next: null, onFail: { to: "builder", maxRounds: 2, onExhausted: "advance" }, effectiveRole: role("reviewer") },
    ],
    runs: [], cursor: null, state: "draft", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: at(30), closedAt: null,
    conversationSource: { conversationId: "conversation_export", branch: "fix/csv-export-retry", head: "c".repeat(40), capturedAt: at(30) },
    ...over,
  } as unknown as Pipeline;
}

const q = (host: HTMLElement, selector: string) => host.querySelector(selector) as unknown as HTMLElement | null;
const click = (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  flushSync(() => el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function mount(pipeline: Pipeline, options: { conversationDrafts?: boolean } = {}) {
  let record = pipeline;
  const patches: PatchPipelineRequest[] = [];
  const answers: PipelineWriteResult[] = [];
  const ports: PipelinePorts = {
    read: async () => ({ pipeline: record, stageDigests: stageDigests(record.stages), graphDigest: "graph-1" }),
    patch: async (_id, body) => { patches.push(body); return answers.shift() ?? { ok: true, pipeline: record }; },
    refresh: () => {},
  };
  const drafts = new StageDrafts();
  const store = new ConversationDrafts({ post: async () => ({ kind: "unknown", error: "unused" }), preview: async () => ({ kind: "failed", refusal: null }), apply: () => {}, newKey: () => "k" });
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  roots.push(root);
  const render = () => flushSync(() => root.render(
    <MobileNavContext.Provider value={createMobileNav(fakeHistory("http://localhost/#p=atlas").host)}>
      <MobilePipelineScreen pipeline={record} files={[]} now={NOW} onOpenConversation={() => {}} ports={ports} drafts={drafts} conversationDrafts={options.conversationDrafts === false ? undefined : store} />
    </MobileNavContext.Provider>,
  ));
  render();
  return { host: host as unknown as HTMLElement, patches, answers, drafts, update: (next: Pipeline) => { record = next; render(); } };
}

test("the append goes after the chain's last stage, named from its role, guarded by the plan's digest", () => {
  const pipeline = draft();
  expect(passTail(pipeline)?.id).toBe("reviewer");
  expect(appendStageRequest(pipeline, "verifier", "graph-1")).toEqual({
    action: "add-stage",
    stage: { id: "verifier", kind: "run", role: { roleId: "verifier" }, "prompt": "{{prev.output}}", next: null },
    after: "reviewer",
    expectedStageDigest: "graph-1",
  });
  /* A second stage of a role the lane holds takes the next free id. */
  expect(appendStageRequest(pipeline, "builder", "graph-1")?.stage?.id).toBe("builder-2");
  /* A cycle in the pass chain still ends. */
  const looped = draft({ stages: [{ ...draft().stages[0]!, next: "reviewer" }, { ...draft().stages[1]!, next: "builder" }] as Pipeline["stages"] });
  expect(passTail(looped)?.id).toBe("reviewer");
});

test("the phone's draft screen shows the Builder's first message under the stages, and Start pipeline at its foot", async () => {
  const { host, patches } = mount(draft());
  expect(q(host, "[data-phone-draft-first-message] h3")?.textContent).toBe("Builder's first message");
  expect(q(host, '[data-phone-draft-first-message] [data-draft-message="p-export:builder"] .btext')?.textContent).toBe("CSV export fails past 50k rows.");
  const start = q(host, '[data-mobile2-dock] [data-draft-start="p-export"]') as HTMLButtonElement;
  expect([start.textContent, start.disabled]).toEqual(["Start pipeline", false]);

  /* An open edit holds Start with its reason; the same store the board saves through. */
  click(q(host, '[data-draft-edit="p-export:builder"]'));
  expect((q(host, '[data-draft-start="p-export"]') as HTMLButtonElement).disabled).toBe(true);
  expect(q(host, '[data-mobile2-dock] [data-draft-start-note="blocked"]')?.textContent).toBe("Save or cancel the first message to start");
  click(q(host, '[data-draft-cancel="p-export:builder"]'));
  expect((q(host, '[data-draft-start="p-export"]') as HTMLButtonElement).disabled).toBe(false);

  click(q(host, '[data-draft-start="p-export"]'));
  await settle();
  expect(patches).toEqual([{ action: "start" }]);
});

test("«+ Stage» offers the roles and appends the chosen one after the last stage; a refusal is said in place", async () => {
  const { host, patches, answers } = mount(draft());
  const toggle = q(host, "[data-draft-add-stage-toggle]")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  click(toggle);
  expect(q(host, '[data-draft-add-role="deployer"]')).toBeNull();
  click(q(host, '[data-draft-add-role="verifier"]'));
  await settle();
  expect(patches).toEqual([{ action: "add-stage", stage: { id: "verifier", kind: "run", role: { roleId: "verifier" }, "prompt": "{{prev.output}}", next: null }, after: "reviewer", expectedStageDigest: "graph-1" }]);
  expect(q(host, "[data-draft-add-stage-roles]")).toBeNull();

  click(q(host, "[data-draft-add-stage-toggle]"));
  answers.push({ ok: false, status: 409, error: "the pipeline's stages changed since they were read", code: "STAGE_CHANGED" });
  click(q(host, '[data-draft-add-role="architect"]'));
  await settle();
  expect(q(host, "[data-draft-add-stage-error]")?.textContent).toBe("The stage was not added: the pipeline's stages changed since they were read");
});

test("a started lane, or a draft no conversation made, carries none of these controls", () => {
  const started = mount(draft({ state: "running", cursor: { stageId: "builder", state: "running", input: null, activatedBy: null } } as Partial<Pipeline>));
  expect(q(started.host, "[data-draft-start]")).toBeNull();
  expect(q(started.host, "[data-phone-draft-first-message]")).toBeNull();
  expect(q(started.host, "[data-draft-add-stage]")).toBeNull();
  const plain = mount(draft({ conversationSource: undefined }));
  expect(q(plain.host, "[data-draft-start]")).toBeNull();
  expect(q(plain.host, "[data-mobile2-dock]")).toBeNull();
});
