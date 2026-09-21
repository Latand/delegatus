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

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { setLocale, useLocale, type Locale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { useComposer } from "@/hooks/useComposer";

import { ComposerBar, composerSlotKind, type ComposerSlotKind } from "@/components/ComposerBar";
import { attachModeFor, capabilitiesFor } from "@/components/agentCapabilities";

import { FeedItem } from "@/components/feed/FeedItem";
import { buildFeed, type Item } from "@/components/feed/parse";
import { LogFeed } from "@/components/LogFeed";
import { TmuxComposer } from "@/components/TmuxComposer";
import { setLogFeedDependenciesForTests } from "@/components/logFeedDependencies";
import { setTmuxComposerRuntimeDependenciesForTests } from "@/components/tmuxComposerRuntime";
import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";
import { OVERVIEW_CONTEXT, OVERVIEW_SLICE, viewBus } from "@/hooks/viewPresenceBus";
import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";

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

const params = new URLSearchParams(window.location.search);

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
  | "lifecycle"
  | "queued"
  | "receipt-delivered"
  | "retired-on-transcript"
  | "auth-terminal"
  | "clean-terminal"
  | "dead-host-composer"
  | "dead-host-not-resumable"
  | "dead-host-queued"
  | "dead-host-resuming"
  | "dead-host-delivering"
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

/** A subagent transcript on a dead host whose ROOT transcript is gone: the one
    permanently non-resumable state, where Send cannot help and the reason has
    to name the action that can. */
const ORPHANED_FILE = {
  ...DEAD_FILE,
  root: "claude-projects",
  kind: "subagent",
  parent: null,
  parentRemoved: { conversationId: "conversation_root_gone", path: null },
} as unknown as FileEntry;

/**
 * The composer on a conversation whose host is gone: text in the field, an
 * image staged beside it, Send live. Every prop the old gates worked through —
 * `showImage`, `imageDisabled`, `sendDisabledReason`, and the phone's
 * `sendSlot` — is derived here exactly as `TmuxComposer` derives it, from the
 * matrix's verdict and `composerSlotKind`.
 *
 * The slot matters most and was the piece a standalone `ComposerBar` used to
 * skip. On a phone the one control under the field IS the send, and a stopped
 * host used to turn it into «Respawn» — the restore-first button this work
 * removes. A frame that mounted the bar without a slot could never show that,
 * so it is wired from the same inputs the pane uses: killed, offline, working,
 * and whether a draft is in the field.
 */
function DeadComposerFixture({ file, id }: { file: FileEntry; id: ConversationWindowCase }) {
  const { t } = useLocale();
  const caps = capabilitiesFor(file, DEAD_VIEW, { runtimeEnabled: true });
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
  /* The pane's own inputs: the host is killed, the bus is up, no turn is
     running, and the operator has written something. */
  const slotKind: ComposerSlotKind = composerSlotKind({
    killed: true,
    offline: false,
    working: false,
    hasDraft: composer.text.trim().length > 0 || composer.attachments.images.length > 0,
  });
  const SLOT: Record<ComposerSlotKind, { label: string; text?: string }> = {
    send: { label: t("composer.sendToAgent") },
    stop: { label: t("mobile2.composer.stop") },
    queue: { label: t("mobile2.composer.queueAria"), text: t("mobile2.composer.queue") },
    respawn: { label: t("mobile2.composer.respawnAria"), text: t("mobile2.composer.respawn") },
  };
  return (
    <div data-evidence-case={id} className="min-h-dvh bg-canvas px-4 py-6 text-primary">
      <div data-evidence-transcript className="my-3 flex justify-end">
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-surface bg-user px-4 py-2.5">{DEAD_SENT}</div>
      </div>
      <ComposerBar
        composer={composer}
        placeholder={t("composer.placeholderSend")}
        textareaAriaLabel={t("composer.sendStructuredAria")}
        imageAriaLabel={t("composer.addAttachments")}
        leftSlot={null}
        sendSlot={{ kind: slotKind, ...SLOT[slotKind] }}
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
  /* The host came back and the message is on the wire to it — the step between
     "starting" and "delivered", and the one the queue's own vocabulary calls
     `delivering`. */
  "dead-host-delivering": { host: "hosted", turn: "idle" },
  "dead-host-delivered": { host: "hosted", turn: "idle" },
  "dead-host-resume-failed": { host: "unhosted", turn: "unknown" },
};

const RESUME_FAILURE = "structured host recovery failed after 12 contended attempts: account is busy";

function deadEntry(id: ConversationWindowCase): OutboxEntry {
  const base = { id: "evidence-dead-key", text: DEAD_SENT, images: 1, at: ADMITTED_AT } as const;
  if (id === "dead-host-queued") return { ...base, state: "queued" } as OutboxEntry;
  if (id === "dead-host-resuming") return { ...base, state: "delivering", acceptedHeld: true } as OutboxEntry;
  /* Not `acceptedHeld`: the admission is no longer parked, it is being handed
     over, which is what separates this chip from the resuming one above. */
  if (id === "dead-host-delivering") return { ...base, state: "delivering", dispatchedAt: ADMITTED_AT } as OutboxEntry;
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



/* ── One message, one row: the whole LIFE of an ordinary send ────────────────
   Not a gallery of reconstructed states — a conversation the driver actually
   uses. The production `LogFeed` and `TmuxComposer` are mounted together over
   the production outbox store, and behind them a configurable fake host
   answers `/api/runtime/send` and publishes receipts. The driver types into
   the real field, submits through the path it is exercising, and advances the
   host; every frame it photographs is a frame that submission really reached.

   An earlier version of this fixture handed each state to a fresh browser
   context with the store pre-arranged — which is exactly why it could not see
   that the transcript's own record REPLACED the row instead of being adopted
   into it. A lifecycle that never transitions cannot observe a transition.

   The scenarios are the five an ordinary message meets: it simply arrives; it
   is parked behind a turn that is running; it waits for a host that is coming
   back; its acknowledgement is lost; and it fails safely. */

const LIFE_CARD = "conversation_message_lifecycle";
const LIFE_PATH = "/codex-message-lifecycle.jsonl";
const LIFE_TEXT = "Check what is blocking the release and tell me which lane owns it.";
/* What the runtime writes when a contended resume gives up: English prose,
   from the server, which the row must not print at a Ukrainian operator. */
const LIFE_FAILURE = "structured host recovery failed after 12 contended attempts: account is busy";

export type LifecycleScenario =
  | "success"
  | "queued-behind-turn"
  | "held-for-host"
  | "lost-acknowledgement"
  | "safe-failure"
  /* The send that carries more than words. The transport behaves like an
     ordinary admitted send; what the scenario exercises is the row. */
  | "attachment-and-context"
  /* A document, and a send that is nothing but a picture. Both reach the
     engine in a shape the row's own words cannot be recognised in — see
     `echo` below — which is the whole reason they are separate frames. */
  | "document-attachment"
  | "image-only";

/** What the fake host does with the next admission, and what it has published. */
interface FakeHost {
  scenario: LifecycleScenario;
  host: string;
  turn: string;
  receipts: RuntimeReceipt[];
  lines: string[];
  /** Resolves the durable-preparation gate, when the driver has closed it. */
  release: (() => void) | null;
}

const fakeHost: FakeHost = {
  scenario: "success",
  host: "hosted",
  turn: "idle",
  receipts: [],
  lines: [],
  release: null,
};

const hostListeners = new Set<() => void>();
let hostRevision = 0;
function announceHost(): void {
  hostRevision += 1;
  for (const listener of hostListeners) listener();
}
function useFakeHost(): number {
  return useSyncExternalStore(
    (listener) => { hostListeners.add(listener); return () => { hostListeners.delete(listener); }; },
    () => hostRevision,
    () => hostRevision,
  );
}

const LIFE_SESSION = () => ({
  session: {
    conversationId: LIFE_CARD,
    sessionKey: { engine: "codex", sessionId: "codex-session-lifecycle" },
    hostKind: "codex-app-server",
    host: fakeHost.host,
    turn: fakeHost.turn,
    provenance: "structured",
    revision: 1 + hostRevision,
    attentionIds: [],
    recentReceipts: fakeHost.receipts,
    accountId: null,
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: "viewer",
    artifactPath: LIFE_PATH,
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
  receipts: fakeHost.receipts,
  legacy: false,
  structuredControlsEnabled: true,
} as unknown as RuntimeSessionView);

const LIFE_FILE = {
  path: LIFE_PATH,
  root: "codex-sessions",
  name: "message-lifecycle.jsonl",
  project: "viewer",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  proc: "running",
  pid: 4242,
  conversationId: LIFE_CARD,
  generation: 1,
  activity: "live",
  mtime: 1,
  size: 1,
} as unknown as FileEntry;

/** The agent's last turn, so the row is photographed where it really sits. */
const LIFE_OPENING = JSON.stringify({
  type: "event_msg",
  timestamp: "2026-09-19T09:14:00.000Z",
  payload: { type: "agent_message", message: "The release branch is green again. Anything else you want me to look at?" },
});

/* Where the agent's own copy of a pasted image lands. The transcript carries
   that path inside the message it journals, and the feed renders it as the
   conversation's own attachment card — which is what makes the caption on the
   bubble a caption rather than a second copy of the picture. Repo-neutral by
   construction: nothing here names anyone's home. */
const LIFE_INBOX_IMAGE = "/var/tmp/llv-evidence-home/.claude/viewer-inbox/stack-trace.png";

/* Where a NON-image attachment lands, and the shape the route folds into the
   delivered text: `inbox/files/<batch>/<name>`, one path per line after the
   operator's words (`inboxFileText`). The engine therefore journals a message
   the row's own words do not match — which is exactly why the row cannot be
   recognised by its text and must be recognised by the delivery's identity. */
const LIFE_INBOX_FILE = "/var/tmp/llv-evidence-home/.claude/viewer-inbox/files/4d2a1f7c9b03/release-notes.pdf";

/* The delivery identity the Codex host stamps onto the canonical
   structured-user record (`dedup=sha256(<operation id>)`), and which
   `/api/log/provenance` resolves back to the client message id the delivery
   was admitted under. The fake server below answers that join for whichever
   submission is live, exactly as the registry does from the moment it admits
   one. */
const LIFE_DEDUP = "7c".repeat(32);

/** The production record shape: one marker line, then the delivered text. */
const structuredUserText = (text: string) => `<!-- llv:structured-user dedup=${LIFE_DEDUP} -->\n${text}`;

/* A 48x48 two-tone PNG — the same bytes the driver stages through the
   composer, so the engine's own inline copy of an image-only send is a real
   picture rather than a placeholder chip. */
const LIFE_TILE_PNG = "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAX0lEQVR42u3XsQkAIAwEQCcRR3AVW6d3E90g"
  + "FhYKXpHyIVc9n3obM7pcani38wkAAAAA4Ajw+oO7PAAAAADAGUATAwAAANgDmhgAAADAHtDEAAAAAPaAJgYAAAD4DrAAlLbY"
  + "gOGW5kkAAAAASUVORK5CYII=";

/* The bytes behind that path are a browser resource load, not a `fetch`, so
   the fake transport below cannot serve them: the driver routes `/api/inbox`
   in the page itself. */

/* Monotonic: the production projection refuses a receipt that does not
   advance the journal's own revision, so a fake host that reuses one publishes
   evidence the row is right to ignore. */
let lifecycleRevision = 0;

function lifecycleReceipt(key: string, status: string, extra: Record<string, unknown> = {}): RuntimeReceipt {
  lifecycleRevision += 1;
  return {
    operationId: `operation-${key}`,
    idempotencyKey: key,
    conversationId: LIFE_CARD,
    kind: "send",
    status,
    text: LIFE_TEXT,
    at: new Date().toISOString(),
    admittedAt: new Date(Date.now() - 45_000).toISOString(),
    revision: lifecycleRevision,
    ...extra,
  } as unknown as RuntimeReceipt;
}

/**
 * The transport, wired once. `/api/runtime/send` answers the way the scenario
 * says the server behaved; everything the composer needs beside it answers
 * plausibly and nothing else is reachable.
 */
function installFakeTransport(): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url === "/api/tmux/targets") return Response.json({ targets: {} });
    if (url.startsWith("/api/log/provenance")) {
      /* The registry writes a delivery's owner row when it ADMITS the send,
         so this join is answerable from that moment — including for the send
         whose acknowledgement never reached the browser. Answering it early
         is what lets the record be bound in the render it first appears in,
         instead of a second copy of the message being painted for as long as
         a round trip takes. */
      const live = readOutbox(LIFE_CARD)[0]?.id;
      return Response.json({ messages: {}, occurrences: [], submissions: live ? { [LIFE_DEDUP]: live } : {} });
    }
    if (url.startsWith("/api/runtime/send?")) {
      /* The original-key admission query. Nothing was journaled under the key
         in the lost-acknowledgement scenario, and saying so would settle it —
         the frame is about a delivery nobody can settle yet, so the lookup
         answers what a lookup that could not read the record answers. */
      return Response.json({ outcome: "unknown" });
    }
    if (url === "/api/runtime/send") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { idempotencyKey: string };
      if (fakeHost.release) await new Promise<void>((resolve) => { fakeHost.release = resolve; });
      if (fakeHost.scenario === "lost-acknowledgement") throw new TypeError("Network disconnected");
      if (fakeHost.scenario === "safe-failure") {
        /* A refusal ABOVE the delivery attempt: nothing journaled, no
           operation minted, nothing on any wire. A 4xx says that; the 503 the
           route reserves for a genuinely unknown outcome does not, which is
           what keeps this frame a proven failure rather than an unknown one. */
        return Response.json({ error: LIFE_FAILURE }, { status: 400 });
      }
      const status = fakeHost.scenario === "success" ? "pending" : "queued";
      const receipt = lifecycleReceipt(body.idempotencyKey, status);
      fakeHost.receipts = [receipt];
      queueMicrotask(announceHost);
      return Response.json({ operationId: receipt.operationId, receipt }, { status: 202 });
    }
    if (url.startsWith("/api/")) return new Response("{}", { status: 404 });
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

/**
 * What the driver can do to the host, from the page.
 *
 * Deliberately small: choose a scenario, hold or release the durable
 * preparation, publish the receipt the scenario's next step would produce, and
 * let the transcript carry the message. Everything else the driver does it
 * does through the interface, like an operator.
 */
interface LifecycleControls {
  scenario(next: LifecycleScenario): void;
  axes(host: string, turn: string): void;
  /** Hold the durable preparation open until `release()`. */
  hold(): void;
  release(): void;
  /** Publish the receipt that moves this send on. */
  settle(status: "delivered" | "queued" | "uncertain"): void;
  /** The transcript's own record of the message arrives. */
  echo(): void;
  /** Point the view at a card, so the next submission captures a reference to
      it exactly as the operator's own selection would (#844). */
  select(label: string): void;
  reset(): void;
  /** The durable queue behind the rows, so a frame that reads oddly can be
      traced to the state the store was really in. */
  queue(): { id: string; state: string; error?: string; deliveryUncertain?: true }[];
}

function lifecycleControls(): LifecycleControls {
  return {
    scenario: (next) => { fakeHost.scenario = next; announceHost(); },
    axes: (host, turn) => { fakeHost.host = host; fakeHost.turn = turn; announceHost(); },
    hold: () => { fakeHost.release = () => undefined; },
    release: () => { const release = fakeHost.release; fakeHost.release = null; release?.(); announceHost(); },
    settle: (status) => {
      const key = readOutbox(LIFE_CARD)[0]?.id ?? "unknown-key";
      fakeHost.receipts = [lifecycleReceipt(key, status === "uncertain" ? "uncertain" : status,
        status === "uncertain" ? { resend: "verify-first", reason: "recipient evidence unavailable" } : {})];
      announceHost();
    },
    select: (label) => {
      viewBus.reportContext({ ...OVERVIEW_CONTEXT, project: "viewer" });
      viewBus.reportCards([{ path: "/codex-selected-card.jsonl", conversationId: "conversation_selected_card", project: "viewer", label }]);
      viewBus.reportSlice({
        ...OVERVIEW_SLICE,
        focusedPath: "/codex-selected-card.jsonl",
        selectedPaths: ["/codex-selected-card.jsonl"],
      });
      announceHost();
    },
    echo: () => {
      const entry = readOutbox(LIFE_CARD)[0];
      const timestamp = new Date().toISOString();
      /* THE PRODUCTION PAYLOAD, not a convenient one.
       *
       * A send that carried nothing but a picture reaches the rollout as a
       * persisted user item whose content is the image and a text part that
       * is only the marker: there are no words in it at all. The feed used
       * to drop such a record — no text, nothing to recognise — and paint
       * the picture as a row of its own ABOVE the message the operator
       * already had, pushing it down the conversation.
       *
       * Everything else arrives as the event the engine journals, and what
       * it journals is what it RECEIVED: the operator's words, plus one line
       * per attachment path the route folded in (`inboxFileText`). The
       * parser lifts an image path out into the conversation's own
       * attachment card; a document's path is not a picture and stays in the
       * text, so the record and the row genuinely do not share their words.
       * Both carry the delivery's own identity on the marker, which is what
       * the row is recognised by. */
      if ((entry?.images ?? 0) > 0 && !entry?.text.trim()) {
        fakeHost.lines = [LIFE_OPENING, JSON.stringify({
          type: "response_item",
          timestamp,
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_image", image_url: `data:image/png;base64,${LIFE_TILE_PNG}` },
              { type: "text", text: structuredUserText("") },
            ],
          },
        })];
        announceHost();
        return;
      }
      const carried = [
        ...((entry?.images ?? 0) > 0 ? [LIFE_INBOX_IMAGE] : []),
        ...((entry?.files ?? 0) > 0 ? [LIFE_INBOX_FILE] : []),
      ];
      const delivered = [entry?.text ?? LIFE_TEXT, ...carried].filter(Boolean).join("\n");
      fakeHost.lines = [LIFE_OPENING, JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: { type: "user_message", message: structuredUserText(delivered) },
      })];
      announceHost();
    },
    queue: () => readOutbox(LIFE_CARD).map((entry) => ({
      id: entry.id, state: entry.state,
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.deliveryUncertain ? { deliveryUncertain: true as const } : {}),
    })),
    /* Only the fake host's own state. The queue store is reset at MOUNT,
       before anything subscribes to it: `resetOutboxForTests` drops every
       listener, so calling it on a live page silently detaches the feed from
       the store and freezes every row at whatever it last painted. */
    reset: () => {
      fakeHost.receipts = [];
      fakeHost.lines = [LIFE_OPENING];
      fakeHost.host = "hosted";
      fakeHost.turn = "idle";
      fakeHost.release = null;
      sessionStorage.clear();
      announceHost();
    },
  };
}

function LifecycleFixture() {
  /* Re-renders whenever the fake host publishes anything. */
  useFakeHost();
  return (
    <div data-evidence-case="lifecycle" className="flex min-h-dvh flex-col bg-canvas text-primary">
      <div className="flex min-h-0 flex-1 flex-col">
        <LogFeed file={LIFE_FILE} showSvc={false} lineFilter="" onStatus={() => undefined}
          paused={false} follow setFollow={() => undefined} />
      </div>
      <TmuxComposer file={LIFE_FILE} />
    </div>
  );
}

function mountLifecycle(root: HTMLElement): void {
  setRuntimeUiEnabledForTests(false);
  setLogFeedDependenciesForTests({
    useLogTail: () => ({
      lines: fakeHost.lines, linesStart: 0, size: fakeHost.lines.length, loading: false, error: null,
      tickTime: null, paused: false, setPaused() {}, clear() {}, hasMore: false, loadingOlder: false,
      loadOlder: async () => 0, prependGen: 0,
    }),
  });
  setTmuxComposerRuntimeDependenciesForTests({
    useAgentCapabilities: (candidate) => {
      const view = LIFE_SESSION();
      const options = { runtimeEnabled: true };
      return {
        caps: capabilitiesFor(candidate, view, options),
        runtime: view,
        structuredSession: view,
        runtimeEnabled: true,
        attachMode: attachModeFor(candidate, view, options),
      };
    },
    useRuntimeReceiptsForArtifact: () => {
      useFakeHost();
      return fakeHost.receipts;
    },
    refreshRuntime: async () => { announceHost(); return true; },
  });
  installFakeTransport();
  /* Each scenario gets a fresh window, and a window restored mid-flight from
     the previous one would refuse the next submission before it started. The
     composer's durable records live in sessionStorage, so the page starts by
     forgetting them — the language seeded into localStorage stays. */
  try { sessionStorage.clear(); } catch { /* opaque origin */ }
  resetOutboxForTests();
  fakeHost.lines = [LIFE_OPENING];
  (window as unknown as { llvHost: LifecycleControls }).llvHost = lifecycleControls();
  createRoot(root).render(<LifecycleFixture />);
}

function Fixture({ id }: { id: ConversationWindowCase }) {
  const { t } = useLocale();
  if (id === "auth-terminal" || id === "clean-terminal") return <TerminalFixture id={id} />;
  if (id === "dead-host-composer") return <DeadComposerFixture file={DEAD_FILE} id={id} />;
  if (id === "dead-host-not-resumable") return <DeadComposerFixture file={ORPHANED_FILE} id={id} />;
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

setLocale((params.get("lang") as Locale | null) ?? "en");
const root = document.getElementById("root");
const requested = (params.get("case") as ConversationWindowCase | null) ?? "receipt-delivered";
/* The lifecycle case mounts the production window itself — the feed, the
   composer and a fake host behind them — so it takes over the root rather than
   rendering one arranged frame. */
if (root && requested === "lifecycle") mountLifecycle(root);
else if (root) createRoot(root).render(<Fixture id={requested} />);
