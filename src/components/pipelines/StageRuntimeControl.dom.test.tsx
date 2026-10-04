import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { Pipeline, PatchPipelineRequest } from "@/lib/pipelines/types";
import { StageRuntimeControl } from "./StageRuntimeControl";
const dom = new Window({ url: "http://localhost" });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Event: dom.Event });
const roots: Root[] = [];
afterEach(() => { for (const root of roots.splice(0)) flushSync(() => root.unmount()); document.body.replaceChildren(); });
const role = { engine: "codex", model: "gpt-6.1-sol", effort: "high", access: "read-write", roleId: "builder", promptScaffold: null };
const stage = { id: "build", kind: "run", effectiveRole: role, engine: "codex", model: role.model, effort: role.effort };
const pipeline = { id: "p-runtime", project: "fixture", state: "running", stages: [stage], runs: [{ stageId: "build", attempts: [{ n: 1, state: "running", conversationId: "conversation_worker", effectiveRole: role, accountId: "default" }] }] } as unknown as Pipeline;
async function mounted() {
  const bodies: PatchPipelineRequest[] = [];
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  const ports = { read: async () => ({ pipeline, stageDigests: { build: "a".repeat(64) } }), patch: async (_id: string, body: PatchPipelineRequest) => { bodies.push(body); return { ok: true as const, pipeline }; }, refresh() {} };
  flushSync(() => root.render(<StageRuntimeControl pipeline={pipeline} stage={pipeline.stages[0]!} ports={ports} />));
  return { host, bodies, root };
}
test("apply now and next attempt carry only runtime changes and the fresh digest", async () => {
  const { host, bodies } = await mounted();
  const model = host.querySelector<HTMLSelectElement>("select")!;
  flushSync(() => { model.value = "gpt-6-astra"; model.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event); });
  host.querySelector<HTMLButtonElement>('[data-stage-runtime-action="now"]')!.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(bodies[0]).toMatchObject({ action: "override-stage", stageId: "build", model: "gpt-6-astra", applyNow: true, expectedStageDigest: "a".repeat(64) });
  expect(bodies[0]).not.toHaveProperty("prompt");
  host.querySelector<HTMLButtonElement>('[data-stage-runtime-action="next"]')!.click();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(bodies[1]?.applyNow).toBeUndefined();
});
test("a pending switch disables both actions with a visible reason", async () => {
  const { host, root } = await mounted();
  const switched = structuredClone(pipeline);
  switched.runs[0]!.attempts[0]!.runtimeSwitches = [{ phase: "switching", to: { engine: "codex", model: "gpt-6-astra" } }] as never;
  flushSync(() => root.render(<StageRuntimeControl pipeline={switched} stage={switched.stages[0]!} />));
  expect([...host.querySelectorAll<HTMLButtonElement>("[data-stage-runtime-action]")].every(button => button.disabled)).toBe(true);
  expect(host.textContent).toContain("Switching");
});
