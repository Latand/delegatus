import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

import { PipelineEditor } from "./PipelineEditor";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLSelectElement: dom.HTMLSelectElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
});

/* Synthetic drafts in the stored legacy shape: architect → builder → review-loop. */
const role = (roleId: string, access: "read-only" | "read-write") => ({ roleId, engine: "codex", model: null, effort: null, access, promptScaffold: `${roleId} guidance` }) as PipelineStage["effectiveRole"];
const run = (id: string, next: string | null, roleId = "builder", access: "read-only" | "read-write" = "read-write") =>
  ({ id, kind: "run", role: { roleId }, "prompt": id, next, onFail: null, effectiveRole: role(roleId, access) }) as PipelineStage;
const review = (id: string, next: string | null) =>
  ({ id, kind: "review-loop", role: { roleId: "reviewer" }, "prompt": id, next, onFail: null, effectiveRole: role("reviewer", "read-only") }) as PipelineStage;

function legacyDraft(over: Partial<Pipeline> = {}): Pipeline {
  const stages = [run("architect", "builder", "architect", "read-only"), run("builder", "reviewer"), review("reviewer", null)];
  return {
    id: "p1", task: "Legacy draft", taskIds: [], project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b", baseBranch: "", baseRef: "", lastPassedCommit: "",
    stages, runs: stages.map((stage) => ({ stageId: stage.id, attempts: [] })),
    cursor: { stageId: "architect", state: "pending", input: null, activatedBy: null },
    state: "draft", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: "1970", closedAt: null, ...over,
  } as Pipeline;
}

const PLAN = {
  ok: true, stageId: "reviewer", implementerStageId: "builder", fixerStageId: "reviewer-fix", reviewLimit: 5, reviewLimitSource: "default",
  reviewerActivations: 5, legacyAttempts: 0, stages: [],
};

type Call = { method: string; body: Record<string, unknown> | null };

function serve(answer: (call: Call) => { ok?: boolean; status?: number; json: Record<string, unknown> }): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (_url: string, init?: { method?: string; body?: string }) => {
    const call = { method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) as Record<string, unknown> : null };
    calls.push(call);
    const reply = answer(call);
    return { ok: reply.ok ?? true, status: reply.status ?? 200, json: async () => reply.json };
  }) as unknown as typeof fetch;
  return calls;
}

function mount(pipeline: Pipeline): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<PipelineEditor pipeline={pipeline} onClose={() => {}} />));
  return { host, root };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Bun.sleep(0);
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`no button ${label}`);
  return found as unknown as HTMLButtonElement;
}

/* react-dom decides once per process whether `input` events are supported,
   so a controlled input is typed into in the order-independent way: focus,
   the prototype setter, `input`, then a `keydown`. */
function setValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const select = input.tagName === "SELECT";
  const proto = select ? dom.HTMLSelectElement.prototype : dom.HTMLInputElement.prototype;
  flushSync(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.Event(select ? "change" : "input", { bubbles: true }) as unknown as Event);
    if (!select) input.dispatchEvent(new dom.KeyboardEvent("keydown", { bubbles: true, key: "3" }) as unknown as Event);
  });
}

test("a legacy draft shows the conversion preview and converts only on the explicit button", async () => {
  const calls = serve((call) => call.body?.action === "preview-legacy-review"
    ? { json: { ok: true, pipeline: legacyDraft(), revision: "r".repeat(64), legacyReviewPreview: { ...PLAN, reviewLimit: 3, reviewerActivations: 3, reviewLimitSource: "request" } } }
    : { json: { ok: true, pipeline: legacyDraft(), revision: "s".repeat(64) } });
  const { host, root } = mount(legacyDraft());
  const panel = host.querySelector("[data-legacy-review]") as HTMLElement;
  expect(panel).not.toBeNull();
  expect(panel.textContent).toContain("Legacy review loop");
  /* Nothing is requested until the operator asks for a preview. */
  expect(calls).toEqual([]);
  /* Empty keeps the limit recorded on the stage's review flow. */
  const limit = panel.querySelector("input[type=number]") as HTMLInputElement;
  expect(limit.value).toBe("");
  setValue(limit, "3");
  flushSync(() => button(host, "Preview conversion").click());
  await settle();
  expect(calls[0]!.body).toEqual({ action: "preview-legacy-review", stageId: "reviewer", reviewLimit: 3 });
  expect(panel.textContent).toContain("Review limit for reviewer: 3, the final review included");
  expect(panel.textContent).toContain("New fix stage reviewer-fix takes the role of builder");
  /* Converting sends the revision the preview was read at, once. */
  flushSync(() => button(host, "Convert").click());
  await settle();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.method).toBe("PATCH");
  expect(calls[1]!.body).toMatchObject({ action: "convert-legacy-review", stageId: "reviewer", reviewLimit: 3, expectedRevision: "r".repeat(64) });
  expect(typeof calls[1]!.body!.clientRequestId).toBe("string");
  expect(host.textContent).toContain("Converted");
  flushSync(() => root.unmount());
});

test("a refused preview lists why, offers the recommended finite limit and no convert button", async () => {
  const refusal = { ok: false, stageId: "reviewer", reviewLimit: null, recommendedReviewLimit: 5, implementerCandidates: ["plan", "builder"], refusals: [
    { code: "unlimited-limit", message: "the review limit is unlimited; choose a finite limit (recommended 5)" },
    { code: "ambiguous-implementer", message: "more than one run stage passes into reviewer" },
  ] };
  const calls = serve(() => ({ json: { ok: true, pipeline: legacyDraft(), revision: "r".repeat(64), legacyReviewPreview: refusal } }));
  const { host, root } = mount(legacyDraft());
  flushSync(() => button(host, "Preview conversion").click());
  await settle();
  expect(calls[0]!.body).toEqual({ action: "preview-legacy-review", stageId: "reviewer" });
  const panel = host.querySelector("[data-legacy-review]") as HTMLElement;
  expect(panel.textContent).toContain("cannot be converted yet");
  expect(panel.textContent).toContain("the review limit is unlimited");
  expect([...panel.querySelectorAll("button")].some((item) => item.textContent === "Convert")).toBe(false);
  /* The implementer choice appears once the preview names candidates. */
  const select = panel.querySelector("select[data-legacy-implementer]") as HTMLSelectElement;
  expect([...select.options].map((option) => option.value)).toEqual(["", "plan", "builder"]);
  setValue(select, "builder");
  flushSync(() => button(host, "Use 5 rounds").click());
  expect((panel.querySelector("input[type=number]") as HTMLInputElement).value).toBe("5");
  flushSync(() => button(host, "Preview conversion").click());
  await settle();
  expect(calls[1]!.body).toEqual({ action: "preview-legacy-review", stageId: "reviewer", reviewLimit: 5, implementerStageId: "builder" });
  flushSync(() => root.unmount());
});

test("an unreverted conversion offers revert, read against the current revision", async () => {
  const converted = legacyDraft({
    stages: [run("architect", "builder", "architect", "read-only"), run("builder", "reviewer"), { ...run("reviewer", null, "reviewer", "read-only"), onFail: { to: "reviewer-fix", maxRounds: 5, onExhausted: "advance" } }, run("reviewer-fix", "reviewer")],
    legacyReviewConversions: [{ clientRequestId: "c1", expectedRevision: "a".repeat(64), stageId: "reviewer", fixerStageId: "reviewer-fix", implementerStageId: "builder", reviewLimit: 5, reviewLimitSource: "default", original: { stages: [], run: { stageId: "reviewer", attempts: [] }, cursor: null }, convertedGraphDigest: "d", actor: { kind: "operator" }, at: "t" }],
  });
  converted.runs = converted.stages.map((stage) => ({ stageId: stage.id, attempts: [] }));
  const calls = serve((call) => ({ json: { ok: true, pipeline: converted, revision: call.method === "GET" ? "g".repeat(64) : "h".repeat(64) } }));
  const { host, root } = mount(converted);
  const panel = host.querySelector("[data-legacy-review]") as HTMLElement;
  expect(panel.textContent).not.toContain("Preview conversion");
  flushSync(() => button(host, "Revert conversion of reviewer").click());
  await settle();
  expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
  expect(calls[1]!.body).toMatchObject({ action: "revert-legacy-review", stageId: "reviewer", expectedRevision: "g".repeat(64) });
  expect(host.textContent).toContain("Conversion reverted");
  flushSync(() => root.unmount());
});

test("run-only and closed pipelines show no conversion controls", () => {
  const runOnly = legacyDraft({ stages: [run("build", null)], runs: [{ stageId: "build", attempts: [] }], cursor: { stageId: "build", state: "pending", input: null, activatedBy: null } });
  const closed = legacyDraft({ state: "closed", closedAt: "t", cursor: null });
  for (const pipeline of [runOnly, closed]) {
    const { host, root } = mount(pipeline);
    expect(host.querySelector("[data-legacy-review]")).toBeNull();
    flushSync(() => root.unmount());
  }
});
