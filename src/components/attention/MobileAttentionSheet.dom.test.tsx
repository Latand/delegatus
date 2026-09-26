import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { needsDecisionPipelineRows } from "@/components/mobile/mobileBoardModel";
import { translate, type TFunction } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { buildAttentionQueue } from "../attention";
import { buildMobileAttentionQueue } from "./attentionQueue";
import { MobileAttentionSheet } from "./MobileAttentionSheet";
import { needsYouLaneLine } from "./needsYouPanel";

const t: TFunction = (key, params) => translate("en", key, params);

/*
 * The Needs-you sheet (mobile v2 lane 8, #1439; README §4.1, §4.6): one list
 * of conversations and `needs_decision` pipelines, «Waiting for you · n» in the
 * header with «Dismiss all n» beside it and no «Next ›»
 * (docs/design/needs-you-options.md, option B), rows that name the agent's
 * role and the decision and carry «Dismiss», a section per project when the
 * sheet lists more than one, and nothing at zero but the empty line.
 */

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
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
  await new Promise((r) => setTimeout(r, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); dom.document.body.style.overflow = ""; roots = []; });
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; });

function mount(node: React.ReactNode): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  roots.push(root);
  return host as unknown as HTMLElement;
}

const click = (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never);
};
const q = (host: HTMLElement, selector: string) => host.querySelector(selector) as unknown as HTMLElement | null;
const qa = (host: HTMLElement, selector: string) => Array.from(host.querySelectorAll(selector)) as unknown as HTMLElement[];

const NOW = 1_800_000_000;
const PROJECT = "atlas";

function conversation(path: string, title: string, since: number, over: Partial<FileEntry> = {}): FileEntry {
  return {
    root: "claude-projects", name: path, path, project: PROJECT, title, engine: "codex", kind: "session", fmt: "codex",
    parent: null, mtime: NOW - 60, size: 10, activity: "idle", proc: null, pid: null, model: "gpt-5.6", waitingInput: null,
    pendingQuestion: {
      kind: "question", toolUseId: `tool-${path}`, transcriptPath: path, pid: 4242, paneTarget: null, askedAt: new Date(since * 1000).toISOString(),
      questions: [{ header: "", question: "Which endpoint first?", multiSelect: false, options: [] }],
    },
    ...over,
  } as FileEntry;
}

function pipeline(id: string, task: string, state: Pipeline["state"], completedAt: number): Pipeline {
  return {
    id, task, taskIds: [], project: PROJECT, repoDir: "/repo", worktreeDir: "/repo-lane", branch: "lane/1", baseBranch: "main", baseRef: "main",
    lastPassedCommit: "", stages: [{ id: "design", kind: "run" }, { id: "implement", kind: "run", role: { roleId: "builder" } }, { id: "review", kind: "review-loop" }, { id: "merge", kind: "run" }, { id: "deploy", kind: "run" }],
    runs: [{ stageId: "review", attempts: [{ n: 2, state: "failed", verdict: { status: "fail", findings: ["remount drops the feed cache", "the switch is 640 ms"] }, completedAt: new Date(completedAt * 1000).toISOString() }] }],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    state, pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: new Date((NOW - 7_200) * 1000).toISOString(), closedAt: null,
  } as unknown as Pipeline;
}

const FILES = [
  conversation("/p/export.jsonl", "Implement the export endpoint", NOW - 540),
  conversation("/p/migrate.jsonl", "Migrate accounts to the new binding", NOW - 120, {
    engine: "claude", fmt: "claude", model: "opus",
    pendingQuestion: { kind: "plan", toolUseId: "tool-plan", transcriptPath: "/p/migrate.jsonl", pid: 1, paneTarget: null, askedAt: new Date((NOW - 120) * 1000).toISOString(), questions: [], plan: "1. read" },
  } as Partial<FileEntry>),
];
const PIPELINES = [pipeline("pipeline_atlas_p2", "Fast conversation switching", "needs_decision", NOW - 3_600), pipeline("pipeline_atlas_p1", "Board status projection", "running", NOW - 60)];
const entries = () => buildMobileAttentionQueue(buildAttentionQueue(FILES, NOW, PROJECT), needsDecisionPipelineRows(PIPELINES, PROJECT, NOW));

test("the sheet lists conversations and needs_decision pipelines as one list under «Waiting for you · n», rows naming the decision", () => {
  const host = mount(<MobileAttentionSheet entries={entries()} now={NOW} onOpenConversation={() => {}} onClose={() => {}} screen={{ kind: "board" }} />);
  const sheet = q(host, '[data-mobile2-sheet="attention"]')!;
  expect(sheet).not.toBeNull();
  expect(sheet.getAttribute("aria-label")).toBe("Waiting for you · 3");
  expect(q(host, "h2")!.textContent).toBe("Waiting for you · 3");

  /* Oldest wait first, the lane among the conversations: it parked an hour ago. */
  const rows = qa(host, "[data-attention-row]");
  expect(rows.map((row) => row.getAttribute("data-mobile2-go"))).toEqual([null, "chat", "chat"]);
  expect(rows[1]!.textContent).toContain("Implement the export endpoint");
  expect(rows[1]!.querySelector("[data-attention-decision]")!.textContent).toBe("a question");
  expect(rows[1]!.textContent).toContain("9m");
  expect(rows[1]!.textContent).toContain("gpt-5.6");
  expect(rows[1]!.querySelector('[data-mobile2-engine="codex"]')).not.toBeNull();
  expect(rows[2]!.querySelector("[data-attention-decision]")!.textContent).toBe("plan approval");
  /* The lane row reads the desktop panel's words for the same lane
     (`needsYouLaneLine`); its wait gives way to an ellipsis, its age never does. */
  expect(rows[0]!.getAttribute("data-mobile2-pipeline-row")).toBe("pipeline_atlas_p2");
  expect(rows[0]!.textContent).toContain("Fast conversation switching");
  const laneLine = rows[0]!.querySelector("[data-attention-decision]")!;
  expect(laneLine.textContent).toBe(needsYouLaneLine(t, PIPELINES.find((pipeline) => pipeline.id === "pipeline_atlas_p2")!));
  expect(laneLine.className).toContain("truncate");
  expect(laneLine.className).not.toContain("shrink-0");
  const laneAge = rows[0]!.querySelector("[data-attention-age]")!;
  expect(laneAge.textContent).toBe("1h");
  expect(laneAge.className).toContain("shrink-0");
  /* Every row is a 44 px target. */
  for (const row of rows) expect(row.className).toContain("min-h-11");
});

test("a conversation row opens through the host; a pipeline row is inert until the pipeline screen supplies an opener, then it is a door", () => {
  const opened: string[] = [];
  let host = mount(<MobileAttentionSheet entries={entries()} now={NOW} onOpenConversation={(item) => opened.push(item.file.path)} onClose={() => {}} screen={{ kind: "board" }} />);
  click(q(host, '[data-mobile2-conversation="/p/migrate.jsonl"]'));
  expect(opened).toEqual(["/p/migrate.jsonl"]);
  const inert = q(host, '[data-mobile2-pipeline-row="pipeline_atlas_p2"]')!;
  expect(inert.tagName).toBe("DIV");
  expect(inert.getAttribute("data-mobile2-go")).toBeNull();
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];

  const pipelines: string[] = [];
  host = mount(<MobileAttentionSheet entries={entries()} now={NOW} onOpenConversation={() => {}} onOpenPipeline={(row) => pipelines.push(row.id)} onClose={() => {}} screen={{ kind: "board" }} />);
  const door = q(host, '[data-mobile2-pipeline-row="pipeline_atlas_p2"]')!;
  expect(door.tagName).toBe("BUTTON");
  expect(door.getAttribute("data-mobile2-go")).toBe("pipeline");
  expect(door.getAttribute("aria-label")).toBe("Open the pipeline Fast conversation switching");
  click(door);
  expect(pipelines).toEqual(["pipeline_atlas_p2"]);
});

test("there is no «Next ›»: the header carries «Dismiss all» instead, and the row on screen is marked current", () => {
  const calls: Array<{ subjects: unknown; undo: boolean }> = [];
  const dismiss = (async (_target: unknown, subjects: unknown, options: { undo?: boolean }) => {
    calls.push({ subjects, undo: options.undo === true });
    return { ok: true, outcome: { dismissed: [], alreadyClear: [], changed: [], at: "", by: { kind: "operator" }, undo: false } };
  }) as never;
  const host = mount(<MobileAttentionSheet entries={entries()} now={NOW} onOpenConversation={() => {}} onClose={() => {}} screen={{ kind: "chat", id: "/p/migrate.jsonl" }} dismiss={dismiss} />);
  expect(q(host, "[data-attention-next]")).toBeNull();
  expect(q(host, '[data-mobile2-conversation="/p/migrate.jsonl"]')!.getAttribute("aria-current")).toBe("true");
  expect(q(host, '[data-mobile2-conversation="/p/export.jsonl"]')!.getAttribute("aria-current")).toBeNull();
  const all = q(host, "[data-needs-you-dismiss-all]")!;
  expect(all.className).toContain("min-h-11");
  click(all);
  expect(calls).toHaveLength(1);
  expect((calls[0]!.subjects as Array<{ kind: string }>).map((subject) => subject.kind)).toEqual(["conversation", "conversation", "pipeline"]);
});

test("every row names its agent's role with the role's emblem, and «Dismiss» clears that row alone", () => {
  const calls: Array<{ subjects: unknown }> = [];
  const dismiss = (async (_target: unknown, subjects: unknown) => {
    calls.push({ subjects });
    return { ok: true, outcome: { dismissed: [], alreadyClear: [], changed: [], at: "", by: { kind: "operator" }, undo: false } };
  }) as never;
  const files = [
    { ...FILES[0]!, durableLineage: { kind: "spawn", role: "builder", parentConversationId: null, reviewsConversationId: null, memberships: [] } } as FileEntry,
    FILES[1]!,
  ];
  const list = buildMobileAttentionQueue(buildAttentionQueue(files, NOW, PROJECT), needsDecisionPipelineRows(PIPELINES, PROJECT, NOW));
  const host = mount(<MobileAttentionSheet entries={list} now={NOW} onOpenConversation={() => {}} onClose={() => {}} screen={{ kind: "board" }} pipelines={PIPELINES} dismiss={dismiss} />);
  const roles = qa(host, "[data-needs-you-row]").map((row) => row.querySelector("[data-role-tag]")?.getAttribute("data-role"));
  expect(roles).toEqual(["reviewer", "builder", "neutral"]);
  expect(q(host, '[data-role-tag="builder"]')!.textContent).toBe("Builder");
  click(q(host, '[data-needs-you-dismiss="pipeline_atlas_p2"]'));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.subjects).toEqual([{ kind: "pipeline", pipelineId: "pipeline_atlas_p2", laneMovedAt: expect.any(Number) }]);
});

test("across projects the sheet is sectioned, the project on screen first, each section with its own «Dismiss n»", () => {
  const calls: Array<{ subjects: unknown }> = [];
  const dismiss = (async (_target: unknown, subjects: unknown) => {
    calls.push({ subjects });
    return { ok: true, outcome: { dismissed: [], alreadyClear: [], changed: [], at: "", by: { kind: "operator" }, undo: false } };
  }) as never;
  const other = conversation("/q/other.jsonl", "Another project's question", NOW - 30, { project: "borealis" });
  const list = buildMobileAttentionQueue(buildAttentionQueue([other, ...FILES], NOW), []);
  const host = mount(<MobileAttentionSheet entries={list} now={NOW} onOpenConversation={() => {}} onClose={() => {}} screen={{ kind: "board" }} current={PROJECT} projectNames={{ borealis: "Borealis" }} dismiss={dismiss} />);
  const sections = qa(host, "[data-needs-you-section]");
  expect(sections.map((section) => section.getAttribute("data-needs-you-section"))).toEqual([PROJECT, "borealis"]);
  expect(sections[1]!.textContent).toContain("Borealis");
  /* The sheet's «Dismiss all n» and a section's «Dismiss n» never read alike. */
  const head = q(host, "[data-needs-you-dismiss-all]")!.textContent;
  const own = q(host, '[data-needs-you-dismiss-section="borealis"]')!.textContent;
  expect(head).toBe(`Dismiss all ${list.length}`);
  expect(own).toBe("Dismiss 1");
  click(q(host, '[data-needs-you-dismiss-section="borealis"]'));
  expect((calls[0]!.subjects as Array<{ path: string }>).map((subject) => subject.path)).toEqual(["/q/other.jsonl"]);
  /* A section folds under its header. */
  flushSync(() => click(q(host, `[data-needs-you-fold="${PROJECT}"]`)));
  expect(q(host, `[data-needs-you-section="${PROJECT}"] [data-needs-you-row]`) === null).toBe(true);
});

test("one item counts one, and zero items show the empty line under a bare «Waiting for you» with nothing to dismiss", () => {
  const one = buildMobileAttentionQueue(buildAttentionQueue([FILES[0]!], NOW, PROJECT), []);
  let host = mount(<MobileAttentionSheet entries={one} now={NOW} onOpenConversation={() => {}} onClose={() => {}} screen={{ kind: "board" }} />);
  expect(q(host, "h2")!.textContent).toBe("Waiting for you · 1");
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];

  host = mount(<MobileAttentionSheet entries={[]} now={NOW} onOpenConversation={() => {}} onClose={() => {}} screen={{ kind: "board" }} />);
  expect(q(host, "h2")!.textContent).toBe("Waiting for you");
  expect(q(host, "[data-needs-you-dismiss-all]")).toBeNull();
  expect(q(host, "[data-mobile2-attention-empty]")!.textContent).toBe("Nothing needs you.");
  expect(qa(host, "[data-attention-row]")).toHaveLength(0);
});

test("the × closes through the host", () => {
  let closed = 0;
  const host = mount(<MobileAttentionSheet entries={entries()} now={NOW} onOpenConversation={() => {}} onClose={() => { closed += 1; }} screen={{ kind: "board" }} />);
  click(q(host, "[data-mobile2-close]"));
  expect(closed).toBe(1);
});

test("a permission row puts its long headline on a truncated line of its own and keeps the age on the meta line (#2215)", () => {
  const command = "rm -rf $R/home $R/*.json";
  const reason = "Dangerous rm operation on possibly-empty variable path: $R/*.json in `rm -rf $R/home $R/*.json` (rewrite it as \"${R:?}\"/*.json or use a literal path)";
  const file = conversation("/p/scratch.jsonl", "Clear the scratch tree", NOW - 180, {
    engine: "claude", fmt: "claude", model: "opus", pendingQuestion: null, conversationId: "conversation_scratch",
    pendingPermission: { id: "request-1", tool: "Bash", command, reason, reasonType: "safetyCheck", since: new Date((NOW - 180) * 1000).toISOString() },
  } as Partial<FileEntry>);
  const host = mount(<MobileAttentionSheet entries={buildMobileAttentionQueue(buildAttentionQueue([file], NOW, PROJECT), [])} now={NOW} onOpenConversation={() => {}} onClose={() => {}} screen={{ kind: "board" }} />);
  const row = q(host, "[data-attention-row]")!;
  const decision = row.querySelector("[data-attention-decision]")!;
  expect(decision.textContent).toBe(`permission: Bash: ${command} — ${reason}`);
  /* Its own line, allowed to shrink and ending in an ellipsis, beside no meta. */
  expect(decision.className).toContain("truncate");
  expect(decision.className).toContain("min-w-0");
  expect(decision.className).not.toContain("shrink-0");
  const age = row.querySelector("[data-attention-age]")!;
  expect(age.textContent).toBe("3m");
  expect(age.parentElement!.contains(decision)).toBe(false);
  expect(age.parentElement!.textContent).toContain("opus");
  expect(q(host, "[data-permission-allow]")).not.toBeNull();
  expect(q(host, "[data-permission-deny]")).not.toBeNull();
});
