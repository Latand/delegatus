import { createRoot } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import { createFeedSession } from "@/components/feed/parse";
import { normalizeRuntimeLiveTurn } from "@/lib/runtime/liveTurn";
import type { FileEntry } from "@/lib/types";

import { FeedItem } from "../feed/FeedItem";
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

   The driver (`kanbanBoard.browser.test.tsx`, "live turn rows on a phone")
   measures both sections at 390 px in both languages. */

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

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto w-full max-w-4xl p-3 text-primary" data-live-turn-evidence>
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
  </main>,
);
