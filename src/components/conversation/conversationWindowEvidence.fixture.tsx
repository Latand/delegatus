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

export type ConversationWindowCase = "queued" | "receipt-delivered" | "retired-on-transcript";

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

function Fixture({ id }: { id: ConversationWindowCase }) {
  const { t } = useLocale();
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
