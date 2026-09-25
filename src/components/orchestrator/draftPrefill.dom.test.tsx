import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse } from "@/test-helpers/onboardingDom";

/*
 * The tour's hand-off into a create draft (#1876 slice 3): a draft already on
 * screen for the project takes the prefill at once, and one that mounts later
 * starts on it, through the storage the dock and the phone sheet share. The
 * draft's defaults for everyone else stay at ORCHESTRATOR_SPAWN_CONFIG.
 */

const harness = installOnboardingDom();
installActEnv();
harness.setRoute((url) => url.includes("/api/accounts") ? jsonResponse({ claude: { active: "", accounts: [] }, codex: { active: "", accounts: [] } }) : undefined);
const { createRoot } = await import("react-dom/client");
const { useAgentLaunchDraft } = await import("@/components/draft/AgentLaunchControls");
const { readSeatDraftField, writeSeatDraftField } = await import("@/components/mobile/orchestratorDraftStorage");
const { ORCHESTRATOR_SPAWN_CONFIG } = await import("@/lib/orchestrator/prompt");
const { requestOrchestratorDraft, takePendingSeatOpen, useOrchestratorDraftPrefill, useOrchestratorDraftReveal } = await import("./draftPrefill");
const { useRef } = await import("react");

function Draft({ project, seen }: { project: string; seen: (value: string) => void }) {
  const launch = useAgentLaunchDraft({
    storage: { read: (name) => readSeatDraftField(project, name), write: (name, value) => writeSeatDraftField(project, name, value) },
    catalog: null,
    initialEngine: ORCHESTRATOR_SPAWN_CONFIG.engine,
    initialModel: ORCHESTRATOR_SPAWN_CONFIG.model,
    initialEffort: ORCHESTRATOR_SPAWN_CONFIG.effort,
  });
  useOrchestratorDraftPrefill(project, launch);
  seen(`${launch.engine}/${launch.model}/${launch.effort}`);
  return null;
}

let mounted: Root | null = null;
afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount());
  mounted = null;
  window.sessionStorage.clear();
});

async function mount(project: string): Promise<string[]> {
  const seen: string[] = [];
  mounted = createRoot(document.createElement("div"));
  await act(async () => mounted!.render(<Draft project={project} seen={(value) => seen.push(value)} />));
  return seen;
}

test("a draft on screen takes Opus and the tour's effort, and only for its own project", async () => {
  writeSeatDraftField("repo-alpha", "engine", "codex");
  writeSeatDraftField("repo-alpha", "model", "gpt-6-astra");
  /* Stored, so the request's effort is a change: the draft's own default is
     the orchestrator role's, high (#2166). */
  writeSeatDraftField("repo-alpha", "effort", "low");
  const seen = await mount("repo-alpha");
  expect(seen.at(-1)).toBe("codex/gpt-6-astra/low");
  await act(async () => requestOrchestratorDraft({ project: "repo-other", launch: { engine: "claude", model: "opus", effort: "high" } }));
  expect(seen.at(-1)).toBe("codex/gpt-6-astra/low");
  await act(async () => requestOrchestratorDraft({ project: "repo-alpha", launch: { engine: "claude", model: "opus", effort: "high" } }));
  expect(seen.at(-1)).toBe("claude/opus/high");
});

test("a draft that mounts after the request starts on it, and the seat opening is owed once", async () => {
  requestOrchestratorDraft({ project: "repo-beta", launch: { engine: "claude", model: "opus", effort: "medium" } });
  const seen = await mount("repo-beta");
  expect(seen[0]).toBe("claude/opus/medium");
  expect(takePendingSeatOpen("repo-beta")).toBe("draft");
  expect(takePendingSeatOpen("repo-beta")).toBeNull();
  requestOrchestratorDraft({ project: "repo-beta", launch: null });
  expect(takePendingSeatOpen("repo-other")).toBeNull();
  expect(takePendingSeatOpen("repo-beta")).toBe("seat");
});

test("an untouched draft still opens at the shipped default effort", async () => {
  const seen = await mount("repo-gamma");
  expect(seen[0]).toBe(`claude/opus/${ORCHESTRATOR_SPAWN_CONFIG.effort}`);
});

function Revealed({ project, scrolled }: { project: string; scrolled: (block: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useOrchestratorDraftReveal(project, ref);
  return (
    <div
      ref={(node) => {
        ref.current = node;
        if (node) node.scrollIntoView = ((options?: ScrollIntoViewOptions) => scrolled(String(options?.block))) as typeof node.scrollIntoView;
      }}
    />
  );
}

async function mountRevealed(project: string): Promise<string[]> {
  const scrolled: string[] = [];
  mounted = createRoot(document.createElement("div"));
  await act(async () => mounted!.render(<Revealed project={project} scrolled={(block) => scrolled.push(block)} />));
  return scrolled;
}

test("the tour's hand-off scrolls the draft's launch choices into view, once and only for its project", async () => {
  requestOrchestratorDraft({ project: "repo-delta", launch: { engine: "claude", model: "opus", effort: "high" } });
  const scrolled = await mountRevealed("repo-delta");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(scrolled).toEqual(["end"]);
  await act(async () => requestOrchestratorDraft({ project: "repo-other", launch: { engine: "claude", model: "opus", effort: "high" } }));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(scrolled).toEqual(["end"]);
  await act(async () => requestOrchestratorDraft({ project: "repo-delta", launch: { engine: "claude", model: "opus", effort: "medium" } }));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(scrolled).toEqual(["end", "end"]);
});

test("a draft opened without a hand-off does not scroll", async () => {
  const scrolled = await mountRevealed("repo-epsilon");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(scrolled).toEqual([]);
});

/* A dock that opens the draft and then settles its own height moves the rows
   after the first scroll; one attempt leaves the row below the fold. */
test("the reveal repeats until the row is in view, and stops once it is", async () => {
  const scrolled: string[] = [];
  let visible = false;
  const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  function Settling({ project }: { project: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useOrchestratorDraftReveal(project, ref);
    return (
      <div
        ref={(node) => {
          ref.current = node;
          if (!node) return;
          node.getBoundingClientRect = () => visible ? rect(10, 20) : rect(200, 300);
          node.scrollIntoView = ((options?: ScrollIntoViewOptions) => {
            scrolled.push(String(options?.block));
            if (scrolled.length >= 3) visible = true;
          }) as typeof node.scrollIntoView;
          const parent = node.parentElement;
          if (parent) parent.getBoundingClientRect = () => rect(0, 100);
        }}
      />
    );
  }
  requestOrchestratorDraft({ project: "repo-zeta", launch: { engine: "claude", model: "opus", effort: "high" } });
  mounted = createRoot(document.createElement("div"));
  await act(async () => mounted!.render(<Settling project="repo-zeta" />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 400)));
  expect(scrolled.length).toBeGreaterThanOrEqual(3);
  expect(new Set(scrolled)).toEqual(new Set(["end"]));
  const settled = scrolled.length;
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(scrolled.length).toBe(settled);
});
