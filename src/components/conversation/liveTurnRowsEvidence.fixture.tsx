import { createRoot } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import { createFeedSession } from "@/components/feed/parse";
import { normalizeRuntimeLiveTurn } from "@/lib/runtime/liveTurn";
import type { FileEntry } from "@/lib/types";

import { FeedItem } from "../feed/FeedItem";
import type { ToolEvent } from "../feed/parse";
import { McpCallCard } from "../runtime/McpCallCard";
import { LiveTurnRows } from "./LiveTurnRows";
import { visibleRuntimeLiveTurnItems } from "./liveTurnHandoff";
import {
  longTurnLiveItems,
  longTurnTranscriptLines,
  staleTranscriptLines,
} from "./liveTurnLongTurn.fixture";

/* The rendered subject of the live-row evidence: one long Claude turn — sixty
   tool calls, long Viewer MCP names, failures, calls whose arguments the live
   window shed, one still running — under the two transcript states that decide
   what the overlay paints.

     stale  — the pane's transcript window is not current (its tail is paused
              because the pane is dormant or offscreen) so nothing claims a live
              row. This is the state the operator photographed.
     current — the same turn with a transcript window that carries every call,
              beside the canonical rows themselves: the overlay must paint
              nothing, because the cards below already say it.

   A third section, `states`, is the same Viewer MCP call in each of the four
   outcomes a live row can hold — including `unknown`, the call whose result the
   runtime journal's bound dropped, which must not be painted as a success.

   The driver (`kanbanBoard.browser.test.tsx`, "live turn rows on a phone")
   measures every section at 390 px in both languages.

   A fourth section, `languages` (#2250), comes first so it is on the first
   screen: canonical Viewer MCP cards for a delivery check in each receipt state
   the server names, beside a canonical send and spawn, and the live rows of the
   same calls. The driver ("MCP rows in the interface language") reads their
   titles in both languages and themes from phone to desktop width. */

setLocale(localStorage.getItem("llv_lang") === "uk" ? "uk" : "en");

const FILE = {
  path: "/workspace/demo/viewer/manager.jsonl",
  engine: "claude",
  fmt: "claude",
  cwd: "/workspace/demo/viewer",
} as FileEntry;

const feedOf = (lines: string[]) =>
  createFeedSession({ engine: "claude", fmt: "claude", cwd: FILE.cwd, showSvc: false, lineFilter: "" })
    .feed(lines, 0, true).items;

const live = normalizeRuntimeLiveTurn({ turnId: "turn-long", text: "", items: longTurnLiveItems() });
const staleFeed = feedOf(staleTranscriptLines());
const currentFeed = feedOf(longTurnTranscriptLines());

const sections = [
  { key: "stale", feed: staleFeed, items: visibleRuntimeLiveTurnItems(live, staleFeed, undefined, "running") },
  { key: "current", feed: currentFeed, items: visibleRuntimeLiveTurnItems(live, currentFeed, undefined, "running") },
] as const;

/* One Viewer MCP call in every outcome a live row can hold. It is the
   two-chip call on purpose: the chips are what used to squeeze the action
   title out of its own line at phone width. `unknown` is the call whose result
   the journal's bound dropped — it is finished, and what it did is not
   known. */
const STATES = ["run", "ok", "err", "unknown"] as const;
const stateItems = STATES.map((status) => ({
  itemId: `toolu_state_${status}`,
  text: "",
  phase: "awaiting-echo" as const,
  startedAt: "2026-09-20T09:19:00.000Z",
  completedAt: status === "run" ? null : "2026-09-20T09:19:04.000Z",
  tool: {
    name: "mcp__viewer__link_task_to_pipeline",
    engine: "claude" as const,
    status,
    args: { taskId: "task-demo-4417", pipelineId: "pipeline-demo-2208" },
  },
}));

/* An operation id as the server writes it (`newOperationId`). */
const RECEIPT_OPERATION = "op_3f2c9a71-5b8e-4d0a-9c61-2e7f4b8d1a05";
const RECEIPT_STATES = ["delivered", "failed", "in-flight"] as const;
const RECEIPT_CONVERSATION = "conversation-demo-7781";

const canonicalCall = (id: string, toolName: string, args: Record<string, unknown>, result: Record<string, unknown> | null, status: ToolEvent["status"] = "ok"): ToolEvent => ({
  kind: "tool",
  id,
  ts: "2026-09-20T09:21:00.000Z",
  srcCall: 0,
  family: "mcp",
  tool: toolName,
  icon: "tool",
  summary: toolName,
  chips: [],
  status,
  statusLabel: status,
  outputPreview: "",
  outputTruncated: false,
  open: false,
  mcp: { serverName: "viewer", toolName, args, result },
});

const languageCards = [
  ...RECEIPT_STATES.map((state) => canonicalCall(
    `receipt-${state}`,
    "message_receipt",
    { operationId: RECEIPT_OPERATION },
    { operationId: RECEIPT_OPERATION, state, conversationId: RECEIPT_CONVERSATION },
  )),
  canonicalCall("send", "send_message", { conversationId: RECEIPT_CONVERSATION, text: "Rebase on main and rerun the board driver" }, { operationId: RECEIPT_OPERATION, conversationId: RECEIPT_CONVERSATION }),
  canonicalCall("spawn", "spawn_agent", { engine: "codex", effort: "high", role: "reviewer", prompt: "Review the receipt titles" }, null, "run"),
];

const languageLiveItems = ([
  ["message_receipt", "run", { operationId: RECEIPT_OPERATION }],
  ["send_message", "ok", { conversationId: RECEIPT_CONVERSATION, text: "Rebase on main and rerun the board driver" }],
  ["spawn_agent", "ok", { engine: "codex", effort: "high", role: "reviewer", prompt: "Review the receipt titles" }],
] as const).map(([name, status, args]) => ({
  itemId: `toolu_language_${name}`,
  text: "",
  phase: "awaiting-echo" as const,
  startedAt: "2026-09-20T09:21:00.000Z",
  completedAt: status === "run" ? null : "2026-09-20T09:21:03.000Z",
  tool: { name: `mcp__viewer__${name}`, engine: "claude" as const, status, args },
}));

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto w-full max-w-4xl p-3 text-primary" data-live-turn-evidence>
    <section data-mcp-language-case className="mb-6">
      <h2 className="mb-1 text-caption font-semibold uppercase tracking-wide text-muted">languages</h2>
      <div data-mcp-language-canonical>
        {languageCards.map((event) => <McpCallCard key={event.id} event={event} availableConversationIds={new Set([RECEIPT_CONVERSATION])} />)}
      </div>
      <div data-mcp-language-live>
        <LiveTurnRows items={languageLiveItems} />
      </div>
    </section>
    {sections.map(({ key, feed, items }) => (
      <section key={key} data-live-rows-case={key} className="mb-6">
        <h2 className="mb-1 text-caption font-semibold uppercase tracking-wide text-muted">{key}</h2>
        <div data-live-rows-transcript>
          {feed.map((entry, index) => <FeedItem key={index} item={entry.item} />)}
        </div>
        <div data-live-rows-overlay>
          <LiveTurnRows items={items} />
        </div>
      </section>
    ))}
    <section data-live-rows-case="states" className="mb-6">
      <h2 className="mb-1 text-caption font-semibold uppercase tracking-wide text-muted">states</h2>
      <div data-live-rows-overlay>
        <LiveTurnRows items={stateItems} />
      </div>
    </section>
  </main>,
);
