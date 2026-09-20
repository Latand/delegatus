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

import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

import { setLocale, useLocale, type Locale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { useComposer } from "@/hooks/useComposer";

import { ComposerBar } from "@/components/ComposerBar";
import { capabilitiesFor } from "@/components/agentCapabilities";

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
  | "clean-terminal"
  | "dead-host-composer"
  | "dead-host-queued"
  | "dead-host-resuming"
  | "dead-host-delivered"
  | "dead-host-resume-failed";

/* #1846 recurrence: a first turn that died unauthorized produced no assistant
   message at all, so the row the parser makes out of the turn-end record is
   the whole of what the operator has to read. The record below is the observed
   shape with an invented turn id. */
const CODEX_FILE = { path: "/tmp/auth-terminal.jsonl", engine: "codex", fmt: "codex", activity: "recent" } as FileEntry;
/* What the provider actually wrote, quoting the body it rejected — the frame's
   whole point is that none of this is painted. Assembled from parts so no
   credential-shaped literal is committed. */
const SENTINEL = ["sk", "live", "9f4c2ab77d31e05c86f0"].join("_");
const EXPIRED = "Your access token could not be refreshed because your "
  + `refresh token has expired. Please log out and sign in again. {'${["refresh", "token"].join("_")}': '${SENTINEL}'}`;
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


/* ── Sending with a host that is gone ────────────────────────────────────────
   The operator writes, attaches a photo and presses Send once; the Viewer
   raises the agent on its way to delivering. These cases are the frames that
   claim is made in: the composer with a real draft and a real staged image on
   a dead conversation, and the message's own bubble in each state the send
   passes through.

   The composer's capability props come from the PRODUCTION matrix — the same
   `capabilitiesFor` the pane calls — so a frame here cannot show an open
   picker that the shipped matrix would have closed. */

const DEAD_CARD = "conversation_reclaimed_evidence";
const DEAD_DRAFT = "Look at this stack trace before you continue — same file as yesterday.";
const DEAD_SENT = "Look at this stack trace before you continue.";

/** The registry-derived row for a conversation whose host was reclaimed: no
    structured host record survives, so kind and axis both read `unhosted`. */
const DEAD_VIEW = {
  session: {
    conversationId: DEAD_CARD,
    sessionKey: { engine: "codex", sessionId: "codex-session-evidence" },
    hostKind: "unhosted",
    host: "unhosted",
    turn: "unknown",
    provenance: "derived",
    revision: 3,
    attentionIds: [],
    recentReceipts: [],
    accountId: null,
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: "viewer",
    artifactPath: null,
    capabilities: {
      steer: false,
      structuredAttention: false,
      imageInput: { supported: true },
      runtimeSettings: { perTurnEffort: true, perTurnModel: false },
    },
    activeTurnId: null,
  },
  uiState: {},
  attentions: [],
  receipts: [],
  legacy: false,
  structuredControlsEnabled: true,
} as unknown as RuntimeSessionView;

const DEAD_FILE = {
  path: "/codex-reclaimed-evidence.jsonl",
  root: "codex-sessions",
  name: "codex-reclaimed-evidence.jsonl",
  project: "viewer",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  proc: null,
  pid: null,
  conversationId: DEAD_CARD,
} as unknown as FileEntry;

/** A 48x48 PNG — a plain two-tone check — decoded at runtime, so the staged
    tile in the frame is a real image that came through the production
    attachment intake rather than a mock standing in for one. */
const TILE_PNG = "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAX0lEQVR42u3XsQkAIAwEQCcRR3AVW6d3E90g"
  + "FhYKXpHyIVc9n3obM7pcani38wkAAAAA4Ajw+oO7PAAAAADAGUATAwAAANgDmhgAAADAHtDEAAAAAPaAJgYAAAD4DrAAlLbY"
  + "gOGW5kkAAAAASUVORK5CYII=";

function pngFile(): File {
  const binary = atob(TILE_PNG);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], "stack-trace.png", { type: "image/png" });
}

/**
 * The composer on a conversation whose host is gone: text in the field, an
 * image staged beside it, Send live. The three props the old gates worked
 * through — `showImage`, `imageDisabled`, `sendDisabledReason` — are derived
 * here exactly as the pane derives them, from the matrix's verdict.
 */
function DeadComposerFixture() {
  const { t } = useLocale();
  const caps = capabilitiesFor(DEAD_FILE, DEAD_VIEW, { runtimeEnabled: true });
  const sendCap = caps.controls.send;
  const imageCap = caps.controls.images;
  const composer = useComposer({
    initialText: () => DEAD_DRAFT,
    persistText: () => undefined,
    submit: () => undefined,
    acceptFiles: true,
    holdInputWhileBusy: false,
  });
  /* One staged tile, added once through the production intake. */
  const staged = useRef(false);
  const addFiles = composer.attachments.addFiles;
  useEffect(() => {
    if (staged.current) return;
    staged.current = true;
    addFiles([pngFile()]);
  }, [addFiles]);
  return (
    <div data-evidence-case="dead-host-composer" className="min-h-dvh bg-canvas px-4 py-6 text-primary">
      <div data-evidence-transcript className="my-3 flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-surface bg-user px-4 py-2.5">{DEAD_SENT}</div>
      </div>
      <ComposerBar
        composer={composer}
        placeholder={t("composer.placeholderSend")}
        textareaAriaLabel={t("composer.sendStructuredAria")}
        imageAriaLabel={t("composer.addAttachments")}
        leftSlot={null}
        sendLabelIdle={t("composer.sendToAgent")}
        sendLabelRecording={t("composer.sendToAgent")}
        sendIdleClassName="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-accent text-canvas"
        showImage={sendCap.state !== "hidden"}
        imageDisabled={imageCap.state !== "enabled"}
        imageDisabledReason={imageCap.state === "disabled" ? t(imageCap.reason) : undefined}
        sendDisabledReason={sendCap.state === "disabled" ? t(sendCap.reason) : undefined}
      />
    </div>
  );
}

/** The conversation's own host axis in each state the send passes through. */
const DEAD_SESSION: Record<string, { host: string; turn: string }> = {
  "dead-host-queued": { host: "unhosted", turn: "unknown" },
  "dead-host-resuming": { host: "recovering", turn: "unknown" },
  "dead-host-delivered": { host: "hosted", turn: "idle" },
  "dead-host-resume-failed": { host: "unhosted", turn: "unknown" },
};

const RESUME_FAILURE = "structured host recovery failed after 12 contended attempts: account is busy";

function deadEntry(id: ConversationWindowCase): OutboxEntry {
  const base = { id: "evidence-dead-key", text: DEAD_SENT, images: 1, at: ADMITTED_AT } as const;
  if (id === "dead-host-queued") return { ...base, state: "queued" } as OutboxEntry;
  if (id === "dead-host-resuming") return { ...base, state: "delivering", acceptedHeld: true } as OutboxEntry;
  if (id === "dead-host-delivered") return { ...base, state: "delivered", settledAt: DELIVERED_AT } as OutboxEntry;
  return { ...base, state: "failed", error: RESUME_FAILURE } as OutboxEntry;
}

function DeadQueueFixture({ id }: { id: ConversationWindowCase }) {
  const { t } = useLocale();
  return (
    <div data-evidence-case={id} className="min-h-dvh bg-canvas px-4 py-6 text-primary">
      <div data-evidence-transcript className="my-3 flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-surface bg-user px-4 py-2.5">{DEAD_SENT}</div>
      </div>
      <OutboxBubblesView
        entries={[deadEntry(id)]}
        t={t}
        nowMs={ADMITTED_AT + 60_000}
        onCancel={() => undefined}
        onRetry={() => undefined}
        session={DEAD_SESSION[id] as Parameters<typeof OutboxBubblesView>[0]["session"]}
      />
    </div>
  );
}

function Fixture({ id }: { id: ConversationWindowCase }) {
  const { t } = useLocale();
  if (id === "auth-terminal" || id === "clean-terminal") return <TerminalFixture id={id} />;
  if (id === "dead-host-composer") return <DeadComposerFixture />;
  if (id.startsWith("dead-host-")) return <DeadQueueFixture id={id} />;
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
