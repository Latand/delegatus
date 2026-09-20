import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import type { RuntimeLiveTurnItem } from "@/lib/runtime/liveTurn";
import { hhmm } from "@/components/utils";
import { formatDuration } from "@/components/feed/duration";

import { createFeedSession, type ToolEvent } from "@/components/feed/parse";
import { McpCallCard } from "@/components/runtime/McpCallCard";

import { LiveTurnRows } from "./LiveTurnRows";

/**
 * Issue #1100: tool calls projected from the structured host render as compact
 * rows inside the live turn, interleaved with prose in response order, in the
 * same quiet ToolLine grammar the canonical transcript row uses (glyph ·
 * summary · non-ok status) — so the row does not change appearance when
 * the transcript echo replaces it.
 */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
});
setLocale("en");

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
});

function mount(items: RuntimeLiveTurnItem[]): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => { root.render(<LiveTurnRows items={items} />); });
  return host;
}

const AT = "2026-08-23T08:30:01.000Z";
const SKEWED_END = "2026-08-23T20:30:01.000Z";

test("tool rows interleave with prose in response order and carry the call's status", () => {
  const host = mount([
    { itemId: "uuid-1", text: "Checking the tree first.", phase: "awaiting-echo", startedAt: AT, completedAt: AT },
    {
      itemId: "toolu_status", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: null,
      tool: { name: "Bash", engine: "claude", status: "run", args: { command: "git status --short", description: "tree" } },
    },
    {
      itemId: "toolu_read", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: AT,
      tool: { name: "Read", engine: "claude", status: "err", args: { file_path: "/repo/src/missing.ts" } },
    },
    {
      itemId: "call_ls", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: SKEWED_END,
      tool: { name: "shell", engine: "codex", status: "ok", args: { cmd: "ls -la", workdir: "/repo" } },
    },
    { itemId: null, text: "Now the fix", phase: "streaming", startedAt: AT, completedAt: null },
  ]);
  const rows = [...host.querySelectorAll<HTMLElement>("[data-live-turn]")];
  expect(rows.map((row) => row.dataset.liveTool ?? "prose")).toEqual(["prose", "Bash", "Read", "shell", "prose"]);
  expect(rows.map((row) => row.dataset.liveTurnItemId)).toEqual(["uuid-1", "toolu_status", "toolu_read", "call_ls", undefined]);

  const running = rows[1]!;
  expect(running.dataset.liveToolStatus).toBe("run");
  expect(running.textContent).toContain("git status --short");
  expect(running.textContent).toContain("executing…");
  expect(running.className).not.toContain("border-danger");

  const failed = rows[2]!;
  expect(failed.dataset.liveToolStatus).toBe("err");
  expect(failed.textContent).toContain("missing.ts");
  expect(failed.textContent).toContain("error");
  expect(failed.className).toContain("border-danger");

  /* A settled call reads quietly: summary and no status label or envelope time. */
  const settled = rows[3]!;
  expect(settled.dataset.liveToolStatus).toBe("ok");
  expect(settled.textContent).toContain("ls -la");
  expect(settled.textContent).not.toContain("executing");
  expect(settled.textContent).not.toContain("error");
  expect(settled.textContent).not.toContain(formatDuration(12 * 60 * 60 * 1000));
  expect(settled.textContent).not.toContain(hhmm(AT));

  /* Prose still streams with its caret at the very end of the turn. */
  expect(rows[4]!.textContent).toContain("Now the fix");
  expect(rows[4]!.querySelector(".animate-pulse")).not.toBeNull();
  /* Tool rows sit at the feed's shared chrome indent, like the canonical ToolCard. */
  for (const row of rows.slice(1, 4)) expect(row.className).toContain("ml-9");
});

test("a Codex file change reads like its canonical apply_patch row: the touched files", () => {
  const host = mount([
    {
      itemId: "call_patch", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: AT,
      tool: { name: "apply_patch", engine: "codex", status: "ok", args: { input: "*** Begin Patch\n*** Update File: src/lib/a.ts\n*** End Patch" } },
    },
  ]);
  const row = host.querySelector<HTMLElement>("[data-live-tool]")!;
  expect(row.textContent).toContain("a.ts");
});

test("a tool row whose arguments were bounded away is counted, never listed", () => {
  /* It has nothing left but its own name, and a list of those is the wall the
     operator photographed. The collapsed line is where such a call belongs. */
  const host = mount([
    {
      itemId: "toolu_old", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: AT,
      tool: { name: "Grep", engine: "claude", status: "ok", args: {}, argsOmitted: true },
    },
  ]);
  expect(host.querySelector("[data-live-tool]")).toBeNull();
  expect(host.textContent).not.toContain("arguments omitted");
  expect(host.querySelector("[data-live-turn-earlier]")?.getAttribute("data-live-turn-earlier")).toBe("1");
});

/* Issue #1959, acceptance 3: a Viewer MCP call's canonical row is an
   McpCallCard, not a ToolLine, so the live row has to read like that card and
   not like "viewer · create_pipeline". Both surfaces are rendered here over the
   SAME call, in the state the card is in while the call is still out (no result
   yet), and compared line for line. */
const MCP_CASES = [
  /* A call whose entity ids only the RESULT will carry: neither surface can
     link one yet, and both show none. */
  { tool: "create_pipeline", args: { task: "Bound the live overlay to its tail", repoDir: "/workspace/demo/viewer" }, chips: 0 },
  /* Calls whose arguments already name the entities: both surfaces link them. */
  { tool: "link_task_to_pipeline", args: { taskId: "task-demo-4417", pipelineId: "pipeline-demo-2208" }, chips: 2 },
  { tool: "update_task", args: { taskId: "task-demo-4417", status: "assigned" }, chips: 1 },
] as const;

function canonicalMcpEvent(tool: string, args: Record<string, unknown>): ToolEvent {
  const line = JSON.stringify({
    type: "assistant",
    timestamp: AT,
    message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${tool}`, name: `mcp__viewer__${tool}`, input: args }] },
  });
  const items = createFeedSession({ engine: "claude", fmt: "claude", showSvc: false, lineFilter: "" }).feed([line], 0, true).items;
  const event = items.map(({ item }) => item).find((item): item is ToolEvent => item.kind === "tool");
  if (!event?.mcp) throw new Error(`the parser produced no MCP row for ${tool}`);
  return event;
}

const chipsOf = (host: HTMLElement, selector: string) => {
  const found = host.querySelectorAll(selector);
  const out: string[] = [];
  for (let index = 0; index < found.length; index += 1) {
    const chip = found[index] as unknown as HTMLElement;
    out.push(`${chip.textContent}@${chip.getAttribute("href") ?? ""}`);
  }
  return out;
};

for (const { tool, args, chips } of MCP_CASES) {
  test(`a live ${tool} row carries the canonical card's own summary and entity chips`, () => {
    const event = canonicalMcpEvent(tool, args);
    const card = document.createElement("div");
    document.body.append(card);
    const cardRoot = createRoot(card);
    roots.add(cardRoot);
    flushSync(() => { cardRoot.render(<McpCallCard event={event} availableConversationIds={new Set()} />); });
    const cardTitle = card.querySelector("[data-testid=mcp-call-card] summary > span.flex-1")!.textContent;

    const live = mount([{
      itemId: `toolu_${tool}`, text: "", phase: "awaiting-echo", startedAt: AT, completedAt: null,
      tool: { name: `mcp__viewer__${tool}`, engine: "claude", status: "run", args },
    }]);
    const row = live.querySelector<HTMLElement>("[data-live-mcp]")!;
    expect(row.dataset.liveMcp).toBe(tool);
    expect(row.querySelector("span.flex-1")!.textContent).toBe(cardTitle);
    expect(row.textContent).toContain("MCP · viewer");
    /* The same entity chips, with the same labels and the same targets. */
    expect(chipsOf(live, "[data-live-mcp-link]")).toEqual(chipsOf(card, "[data-testid^=mcp-link-]"));
    expect(chipsOf(live, "[data-live-mcp-link]")).toHaveLength(chips);
    /* And never the generic summarizer's line, which is what it used to read. */
    expect(row.textContent).not.toContain(`viewer · ${tool}`);
  });
}

test("a call whose result the journal's bound dropped reads as finished with its outcome omitted: no spinner, no check, no error styling", () => {
  const host = mount([
    {
      itemId: "toolu_dropped", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: AT,
      tool: { name: "Bash", engine: "claude", status: "unknown", args: { command: "bun run build" } },
    },
  ]);
  const row = host.querySelector<HTMLElement>("[data-live-tool]")!;
  expect(row.dataset.liveToolStatus).toBe("unknown");
  expect(row.textContent).toContain("bun run build");
  expect(row.textContent).toContain("outcome omitted");
  expect(row.textContent).not.toContain("executing");
  expect(row.textContent).not.toContain("error");
  expect(row.querySelector(".animate-spin")).toBeNull();
  expect(row.className).not.toContain("border-danger");
});
