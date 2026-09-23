import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { MOBILE_LAYOUT_QUERY } from "@/lib/attention/eligibility";
import { setLocale, translate } from "@/lib/i18n";
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
  setLocale("en");
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
    /* Both surfaces name their action title, and both give it a flex basis of
       its own so chips wrap rather than squeeze it (#1955). */
    const cardTitleNode = card.querySelector<HTMLElement>("[data-testid=mcp-call-card] summary > [data-mcp-title]")!;
    const cardTitle = cardTitleNode.textContent;
    expect(cardTitleNode.className).toContain("basis-[10rem]");

    const live = mount([{
      itemId: `toolu_${tool}`, text: "", phase: "awaiting-echo", startedAt: AT, completedAt: null,
      tool: { name: `mcp__viewer__${tool}`, engine: "claude", status: "run", args },
    }]);
    const row = live.querySelector<HTMLElement>("[data-live-mcp]")!;
    expect(row.dataset.liveMcp).toBe(tool);
    expect(row.querySelector("[data-live-mcp-title]")!.textContent).toBe(cardTitle);
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

/* Round-2 P1: the MCP row's own outcome vocabulary. `unknown` means the
   runtime journal's bound dropped this call's result — the call may well have
   FAILED — so the row must assert nothing about it: no check, no alert, no
   spinner, and none of the tones that carry those meanings. It says what it
   knows instead, in the reader's language, and keeps the summary and the
   entity chips that make the row worth showing at all. */
const MCP_STATES = [
  /* `aria` is what the mark announces, `text` what the row actually prints. */
  { status: "run", state: "pending", spinner: true, aria: "Linking…", text: null, tone: "text-accent" },
  { status: "ok", state: "success", spinner: false, aria: "success", text: null, tone: "text-success" },
  { status: "err", state: "error", spinner: false, aria: "error", text: null, tone: "text-danger" },
  { status: "unknown", state: "outcome-omitted", spinner: false, aria: null, text: "outcome omitted", tone: "text-muted" },
] as const;

const LINK_ARGS = { taskId: "task-demo-4417", pipelineId: "pipeline-demo-2208" };

function mcpRow(status: "run" | "ok" | "err" | "unknown"): HTMLElement {
  const host = mount([{
    itemId: `toolu_state_${status}`, text: "", phase: "awaiting-echo", startedAt: AT,
    completedAt: status === "run" ? null : AT,
    tool: { name: "mcp__viewer__link_task_to_pipeline", engine: "claude", status, args: LINK_ARGS },
  }]);
  return host.querySelector<HTMLElement>("[data-live-mcp]")!;
}

for (const lang of ["en", "uk"] as const) {
  for (const { status, state, spinner, aria, text, tone } of MCP_STATES) {
    test(`[${lang}] a live MCP row with status ${status} carries only the ${state} indicator`, () => {
      setLocale(lang);
      const row = mcpRow(status);
      expect(row.dataset.liveToolStatus).toBe(status);
      expect(row.dataset.liveMcpState).toBe(state);

      /* Exactly one outcome mark, and it is this state's own. */
      const marks = {
        success: row.querySelector("[aria-label=success]"),
        error: row.querySelector("[aria-label=error]"),
        pending: row.querySelector("[role=status]"),
        omitted: row.querySelector("[data-live-mcp-outcome=omitted]"),
      };
      const shown = Object.entries(marks).flatMap(([name, node]) => (node ? [name] : []));
      expect(shown).toEqual([
        state === "outcome-omitted" ? "omitted" : state === "pending" ? "pending" : state,
      ]);
      expect(Boolean(row.querySelector(".animate-spin"))).toBe(spinner);
      /* An outcome nobody knows is announced by no assistive label at all —
         the row prints the word instead, so the reader sees it too. */
      const announced = row.querySelector("[aria-label]:not([aria-hidden])");
      expect(announced?.getAttribute("aria-label") ?? "").toBe(aria ?? "");
      if (text) {
        expect(row.textContent).toContain(lang === "en" ? text : translate("uk", "feed.liveToolOutcomeOmitted"));
      }

      /* The tones are meanings too: success green and danger red are claims
         about an outcome nobody knows, so an unknown row wears neither. */
      expect(row.innerHTML).toContain(tone);
      for (const other of ["text-success", "text-danger"]) {
        if (other !== tone) expect(row.innerHTML).not.toContain(other);
      }

      /* And the row is still an MCP row: the card's summary and both chips.
         The title's tooltip carries it in full, as the canonical card's does. */
      const title = row.querySelector("[data-live-mcp-title]")!;
      expect(title.textContent ?? "").toBe(title.getAttribute("title") ?? "");
      expect((title.textContent ?? "").length).toBeGreaterThan(0);
      expect(chipsOf(row, "[data-live-mcp-link]")).toHaveLength(2);
      expect(row.textContent).toContain("MCP · viewer");
    });
  }
}

test("an MCP call whose outcome was dropped says so in the reader's language, and never 'success'", () => {
  for (const lang of ["en", "uk"] as const) {
    setLocale(lang);
    const row = mcpRow("unknown");
    expect(row.textContent).toContain(translate(lang, "feed.liveToolOutcomeOmitted"));
    expect(row.querySelector("[aria-label=success]")).toBeNull();
    /* The generic row and the MCP row agree on the word, so a call does not
       change its story when it is routed to the other grammar. */
    const generic = mount([{
      itemId: "toolu_generic_unknown", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: AT,
      tool: { name: "Bash", engine: "claude", status: "unknown", args: { command: "bun run build" } },
    }]).querySelector<HTMLElement>("[data-live-tool]")!;
    expect(generic.textContent).toContain(translate(lang, "feed.liveToolOutcomeOmitted"));
  }
});

/* #2075: a live row that opened a picture file draws it under the line from
   disk, the same card the settled row draws from the transcript's bytes. */
test("a live view_image or image Read draws the file under its line; a text Read or a failed view draws none", () => {
  const host = mount([
    {
      itemId: "exec-view-1", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: AT,
      tool: { name: "view_image", engine: "codex", status: "ok", args: { path: "/w/shot.png" } },
    },
    {
      itemId: "toolu_png", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: null,
      tool: { name: "Read", engine: "claude", status: "run", args: { file_path: "~/w/frame.jpg" } },
    },
    {
      itemId: "toolu_ts", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: AT,
      tool: { name: "Read", engine: "claude", status: "ok", args: { file_path: "/w/src/app.ts" } },
    },
    {
      itemId: "toolu_err", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: AT,
      tool: { name: "Read", engine: "claude", status: "err", args: { file_path: "/w/missing.png" } },
    },
  ]);
  const pictures = [...host.querySelectorAll<HTMLElement>("[data-live-tool-image] img")];
  expect(pictures.map((img) => img.getAttribute("src"))).toEqual([
    "/api/artifact?path=%2Fw%2Fshot.png",
    "/api/artifact?path=%7E%2Fw%2Fframe.jpg",
  ]);
  /* Each picture sits right under the line that opened it. */
  const rows = [...host.querySelectorAll<HTMLElement>("[data-live-turn]")];
  expect(rows[0]!.nextElementSibling?.hasAttribute("data-live-tool-image")).toBe(true);
  expect(rows[1]!.nextElementSibling?.hasAttribute("data-live-tool-image")).toBe(true);
  expect(rows[2]!.nextElementSibling?.hasAttribute("data-live-tool-image")).toBe(false);
  expect(rows[3]!.nextElementSibling).toBeNull();
});

test("on the phone the live line and its picture run edge to edge, where the settled line sits", () => {
  const original = dom.matchMedia.bind(dom);
  const phone = (query: string) => ({
    matches: query.replace(/\s+/g, "") === MOBILE_LAYOUT_QUERY.replace(/\s+/g, ""),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  });
  (dom as unknown as { matchMedia: unknown }).matchMedia = phone;
  try {
    const host = mount([{
      itemId: "exec-view-phone", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: null,
      tool: { name: "view_image", engine: "codex", status: "run", args: { path: "/w/shot.png" } },
    }]);
    const row = host.querySelector<HTMLElement>("[data-live-turn]")!;
    const picture = host.querySelector<HTMLElement>("[data-live-tool-image]")!;
    expect(row.className).not.toContain("ml-9");
    expect(picture.className).not.toContain("ml-9");
    expect(picture.className).toContain("pl-[22px]");
  } finally {
    (dom as unknown as { matchMedia: unknown }).matchMedia = original;
  }
});

test("a live picture the route's fence refuses draws nothing, since its settled echo shows the transcript's bytes", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "fixture", code: "access-denied" }),
    { status: 403, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  try {
    const host = mount([{
      itemId: "toolu_tmp", text: "", phase: "awaiting-echo", startedAt: AT, completedAt: null,
      tool: { name: "Read", engine: "claude", status: "run", args: { file_path: "/tmp/capture.png" } },
    }]);
    const img = host.querySelector("[data-live-tool-image] img")!;
    flushSync(() => img.dispatchEvent(new dom.Event("error") as unknown as Event));
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
    expect(host.querySelector("[data-live-tool-image] img")).toBeNull();
    expect(host.querySelector("[data-image-unavailable]")).toBeNull();
    /* The line itself stays. */
    expect(host.querySelector("[data-live-tool=Read]")).toBeTruthy();
  } finally {
    globalThis.fetch = realFetch;
  }
});
