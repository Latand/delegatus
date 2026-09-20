"use client";

/**
 * The rendered-evidence fixture for the conversation window's launch-prompt
 * bubble. It drives the PRODUCTION outbox store — `seedLaunchOutbox`,
 * `retireLaunchOutboxOnTranscriptTurn`, `visibleOutbox` — and renders the
 * production `OutboxBubblesView` over whatever that store leaves visible, so a
 * frame shows exactly the chip the operator reads, beside the transcript's own
 * record of the same message.
 *
 * The case and the language come from the query string (`?case=`, `?lang=`);
 * the driver is `conversationWindow.browser.test.tsx`.
 */

import { createRoot } from "react-dom/client";

import { setLocale, useLocale, type Locale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { FeedItem } from "@/components/feed/FeedItem";
import { buildFeed, type Item } from "@/components/feed/parse";

import { OutboxBubblesView } from "./OutboxBubbles";
import {
  readOutbox,
  resetOutboxForTests,
  retireLaunchOutboxOnTranscriptTurn,
  seedLaunchOutbox,
  visibleOutbox,
  type OutboxEntry,
  type OutboxOwner,
} from "./outbox";

const ADMITTED_AT = Date.parse("2026-09-19T03:02:09.021Z");
const DELIVERED_AT = ADMITTED_AT + 19_000;
const TRANSCRIPT_STARTED_AT = ADMITTED_AT + 16_000;
const ASSISTANT_TURN_AT = DELIVERED_AT + 60_000;

const CARD = "conversation_rotation_successor";
const OWNER: OutboxOwner = { conversationId: CARD, generation: 1 };
const LAUNCH_ID = "launch_rotation_successor";

/** A rotation mandate, at the length one really has. */
const MANDATE = [
  "You are the viewer's built-in Manager: the agent that owns the board and runs the whole",
  "conveyor through the viewer's own HTTP API and MCP tools. You never act outside them.",
  "",
  "Your first turn after receiving this mandate must produce a visible status in this window.",
].join("\n");

/** What the launch DELIVERS: the mandate inside the rotation's scaffold, which
    is why the bubble's echo identity is never the text it displays. */
const ECHO = `You are the Orchestrator. Drive work through the production Viewer MCP tools.\n\n${MANDATE}\n\n## Handoff\nSupersedes the predecessor seat.`;

export type ConversationWindowCase =
  | "queued"
  | "receipt-delivered"
  | "retired-on-transcript"
  | "auth-terminal"
  | "clean-terminal";

/* #1846 recurrence: a first turn that died unauthorized produced no assistant
   message at all, so the row the parser makes out of the turn-end record is
   the whole of what the operator has to read. The record below is the observed
   shape with an invented turn id. */
const CODEX_FILE = { path: "/tmp/auth-terminal.jsonl", engine: "codex", fmt: "codex", activity: "recent" } as FileEntry;
const EXPIRED = "Your access token could not be refreshed because your "
  + "refresh token has expired. Please log out and sign in again.";
const TURN_ID = ["6f2c41d8", "5b07", "4a19", "9e33", "0c7a51d64b28"].join("-");

function terminalRow(failed: boolean): Item {
  const line = JSON.stringify({
    type: "event_msg",
    timestamp: "2026-09-20T02:49:12.136Z",
    payload: {
      type: "task_complete",
      turn_id: TURN_ID,
      ...(failed
        ? { last_agent_message: null, error: { message: EXPIRED, codex_error_info: "unauthorized" }, duration_ms: 1352 }
        : { last_agent_message: "Ready in this project.", duration_ms: 42_100 }),
    },
  });
  const row = buildFeed(CODEX_FILE, [line], false, "").items.at(-1);
  if (!row) throw new Error("the parser produced no terminal row");
  return row;
}

function visibleEntries(id: ConversationWindowCase): OutboxEntry[] {
  resetOutboxForTests();
  const delivered = id !== "queued";
  seedLaunchOutbox(CARD, {
    id: LAUNCH_ID,
    text: MANDATE,
    images: 0,
    at: ADMITTED_AT,
    echoText: ECHO,
    owner: OWNER,
    state: delivered ? "delivered" : "delivering",
    ...(delivered ? { settledAt: DELIVERED_AT } : {}),
  });
  if (id === "retired-on-transcript") {
    retireLaunchOutboxOnTranscriptTurn(CARD, {
      owner: OWNER,
      startedAt: TRANSCRIPT_STARTED_AT,
      assistantTurnAt: ASSISTANT_TURN_AT,
    });
  }
  const at = id === "queued" ? ADMITTED_AT + 5_000 : DELIVERED_AT + 1_000;
  return visibleOutbox(readOutbox(CARD), new Map(), at, OWNER);
}

function TerminalFixture({ id }: { id: "auth-terminal" | "clean-terminal" }) {
  return (
    <div data-evidence-case={id} className="min-h-dvh bg-canvas px-4 py-6 text-primary">
      {/* The mandate the operator sent: the only other row in the window. */}
      <div data-evidence-transcript className="my-3 flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-surface bg-user px-4 py-2.5">
          You are the Orchestrator. Drive work through the Viewer MCP tools.
        </div>
      </div>
      <FeedItem item={terminalRow(id === "auth-terminal")} />
    </div>
  );
}

function Fixture({ id }: { id: ConversationWindowCase }) {
  const { t } = useLocale();
  if (id === "auth-terminal" || id === "clean-terminal") return <TerminalFixture id={id} />;
  const entries = visibleEntries(id);
  return (
    <div data-evidence-case={id} className="min-h-dvh bg-canvas px-4 py-6 text-primary">
      {/* The transcript's own first user record of this launch — the record the
          bubble must never double, and the one it retires against. */}
      <div data-evidence-transcript className="my-3 flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-surface bg-user px-4 py-2.5">{ECHO}</div>
      </div>
      <OutboxBubblesView
        entries={entries}
        t={t}
        nowMs={id === "queued" ? ADMITTED_AT + 5_000 : DELIVERED_AT + 1_000}
        onCancel={() => undefined}
        onRetry={() => undefined}
      />
    </div>
  );
}

const params = new URLSearchParams(window.location.search);
setLocale((params.get("lang") as Locale | null) ?? "en");
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture id={(params.get("case") as ConversationWindowCase | null) ?? "receipt-delivered"} />);
