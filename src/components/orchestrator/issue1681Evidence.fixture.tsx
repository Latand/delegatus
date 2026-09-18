"use client";

import { useState } from "react";
import { createRoot } from "react-dom/client";

import type { SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";
import { ORCHESTRATOR_PROMPT_VERSION } from "@/lib/orchestrator/prompt";
import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import type { FileEntry } from "@/lib/types";

import { Bot, Lock } from "lucide-react";

import { MobileOrchestratorSheet } from "../mobile/MobileOrchestratorSheet";
import { IncumbentHeader } from "./IncumbentHeader";
import type { OrchestratorPanelState } from "./seatState";
import "../kanban/kanbanBoard.css";

/*
 * The real seat tick controls, in the real surfaces, for the rendered checks
 * #1681 asks for (`issue1681Evidence.browser.test.tsx`).
 *
 * Nothing here is a mock of the control: the desktop mounts the actual
 * `IncumbentHeader` — which is where the chip lives — inside a container of
 * the dock's own width, beside the rail and the board it is pushed between, so
 * the row wraps exactly as it does in the Viewer. The phone mounts the actual
 * `MobileOrchestratorSheet`. Only the SERVER is fixed: one settings answer, so
 * a measurement is of the layout rather than of whatever the operator's tick
 * happened to be doing.
 */

const PROJECT = "atlas";
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
/** `?surface=` picks the host, `?dock=` its width, `?tick=` which reading. */
const params = new URLSearchParams(window.location.search);

/** Off the default and stale, so the chip carries its longest face («every 30
    min») beside a warning dot, and the popover shows every section at once. */
function answer(): SeatTickSettingsAnswer {
  return {
    project: PROJECT,
    changed: false,
    at: new Date().toISOString(),
    actor: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
    settings: {
      project: PROJECT,
      enabled: true,
      wakeIntervalMinutes: 30,
      reason: "a release afternoon, so the seat is woken twice an hour",
      monitorPrompt: null,
      until: ago(-120),
      updatedAt: ago(45),
      setBy: { kind: "gateway", conversationId: null, project: null, seatEpoch: null },
    },
    effective: {
      enabled: true,
      wakeIntervalMinutes: 30,
      reason: "a release afternoon, so the seat is woken twice an hour",
      monitorPrompt: null,
      until: ago(-120),
      isDefault: false,
      configured: true,
      lapsed: false,
      updatedAt: ago(45),
    },
    defaults: { project: PROJECT, enabled: true, wakeIntervalMinutes: null, reason: null, monitorPrompt: null, until: null, updatedAt: null, setBy: null },
    defaultWakeIntervalMinutes: 60,
    monitorPromptLength: 0,
    cardText: "This project's seat tick is not on its default settings\n\nwakes for this project are set to one every 30 minute(s).",
    policy: { checkIntervalMinutes: 5, staleAfterMinutes: 15, retryGuardWakes: 2 },
    state: {
      lastCheckAt: ago(23),
      lastWakeAt: ago(95),
      lastWakeReasons: ["interval", "stalled"],
      outstandingWake: null,
      retryGuard: [],
      sourceGap: null,
      accountingGap: null,
    },
    stateError: null,
    lastRun: { at: ago(23), verdict: "quiet", reasons: [], delivery: null, detail: "nothing owed" },
    lastDelivery: { at: ago(95), outcome: "landed" },
    journalError: null,
  };
}

/** Blocked by an unresolved wake — the longest trailing clause the phone's row
    ever carries, and the case the critique measured clipped at 390 px. */
function blockedAnswer(): SeatTickSettingsAnswer {
  const base = answer();
  return {
    ...base,
    state: { ...base.state!, outstandingWake: { preparedAt: ago(120), dispatch: "refused" } },
  };
}

const accounts = {
  claude: { active: "primary", accounts: [{ id: "primary", label: "primary", authPresent: true, auth: { state: "ok", plan: "max" } }] },
  codex: { active: "codex-primary", accounts: [{ id: "codex-primary", label: "codex-primary", authPresent: true }] },
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.startsWith("/api/monitor/seat-tick/settings")) {
    const body = params.get("tick") === "blocked" ? blockedAnswer() : answer();
    return json({ ...body, changed: init?.method === "PUT" });
  }
  if (url.startsWith("/api/accounts")) return json(accounts);
  if (url.startsWith("/api")) return json({});
  return realFetch(input, init);
}) as typeof fetch;

const seat: OrchestratorSeat = {
  project: PROJECT,
  seatEpoch: 4,
  conversationId: "conversation_orchestrator",
  path: "/transcripts/orchestrator.jsonl",
  mandate: "You run the Atlas board.",
  promptVersion: ORCHESTRATOR_PROMPT_VERSION,
  predecessorConversationId: "conversation_predecessor",
  state: "active",
  intent: { clientRequestId: "req-11111111", mode: "spawn", launchId: "launch-1", error: null },
  designatedAt: ago(300),
  activatedAt: ago(299),
} as OrchestratorSeat;

const live = {
  kind: "live",
  seat,
  conversationId: seat.conversationId!,
  liveness: "live",
  attention: null,
  bindFailure: null,
  rotation: null,
  transition: null,
} as Extract<OrchestratorPanelState, { kind: "live" }>;

const file = {
  path: "/transcripts/orchestrator.jsonl", root: "claude-projects", name: "orchestrator.jsonl", project: PROJECT,
  title: "Run the Atlas board", engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: Date.now() / 1000,
  size: 1, activity: "live", proc: "running", pid: 3, conversationId: "conversation_orchestrator", model: "claude-opus-5",
  cwd: "/repo/atlas", projectRoot: "/repo/atlas", pendingQuestion: null, waitingInput: null,
  ctx: { usedTokens: 240_000, windowTokens: 1_000_000, pct: 24, confidence: "exact" },
} as unknown as FileEntry;

/**
 * The dock as the Viewer lays it out: the project rail at its fixed width, the
 * dock at the width under test, the board taking the rest. The incumbent row
 * is the dock's own header, so what is measured is the row inside the width it
 * really has.
 */
function Desktop({ dock }: { dock: number }) {
  return (
    <div className="flex h-full min-h-0 w-full bg-canvas text-primary">
      <div className="shrink-0 border-r border-border bg-sunken" style={{ width: 248 }} data-fixture-rail />
      <section
        className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-card"
        /* The dock's own expression, verbatim (`OrchestratorDock`): the
           operator's width, floored at 360 px and clamped by what the rail,
           the board's minimum and the preview sheet's minimum reserve. */
        style={{ width: `max(360px, min(${dock}px, calc(100vw - 948px)))` }}
        data-fixture-dock={String(dock)}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="min-w-0 flex-1 truncate text-body font-semibold">Orchestrator</span>
        </header>
        <IncumbentHeader
          project={PROJECT}
          projectName="Atlas"
          incumbent={null}
          file={file}
          catalog={null}
          predecessorConversationId="conversation_predecessor"
          promptVersion={ORCHESTRATOR_PROMPT_VERSION}
          rotating={false}
          opening={false}
          onRotate={() => undefined}
        />
        <div className="min-h-0 flex-1 overflow-y-auto p-3 text-ui text-muted">The seat conversation goes here.</div>
      </section>
      <div className="min-w-0 flex-1 bg-canvas p-3 text-ui text-muted" data-fixture-board>The board takes the rest.</div>
    </div>
  );
}

/**
 * The KANBAN SEAT's header, the incumbent row's other host — and the one the
 * dock's measurements say nothing about.
 *
 * It is a different layout problem, not a narrower version of the same one:
 * `.kb .seat-head` is a single flex row that does NOT wrap above 767 px, it
 * already carries four other children (the mark, the seat title, the «stays on
 * the board» pill, the host controls and Collapse), and the seat's width is
 * `calc(100% - 32px)` capped at 1040 px. So the row has to be measured in its
 * own host, at the widths where the board is still a desktop.
 */
function Seat() {
  return (
    <div className="kb" style={{ height: "100%" }}>
      <div className="kb-page" style={{ height: "100%" }}>
        <section className="seat" data-kanban-seat={PROJECT} data-collapsed="0">
          <section
            className="flex h-full min-h-0 min-w-0 flex-col bg-card"
            data-orchestrator-panel={PROJECT}
            data-orchestrator-state="live"
          >
            <header className="seat-head">
              <span className="av claude" aria-hidden><Bot /></span>
              <span className="seat-title">
                <strong>Orchestrator</strong>
                <span className="proj" title="Atlas">Atlas</span>
                <span className="state working" data-fixture-state><i />working</span>
              </span>
              <span className="lock" data-fixture-lock><Lock aria-hidden /><span>Stays on the board</span></span>
              <IncumbentHeader
                inline
                project={PROJECT}
                projectName="Atlas"
                incumbent={null}
                file={file}
                catalog={null}
                predecessorConversationId="conversation_predecessor"
                promptVersion={ORCHESTRATOR_PROMPT_VERSION}
                rotating={false}
                opening={false}
                onRotate={() => undefined}
              />
              {/* The host controls and Collapse, as the seat renders them: the
                  two siblings the controls group must not be drawn over. */}
              <span className="lock" data-fixture-host-controls><Bot aria-hidden /><span>running</span></span>
              <button type="button" className="icon-btn" data-fixture-collapse aria-label="Collapse">▾</button>
            </header>
            <div className="min-h-0 flex-1 p-3 text-ui text-muted">The seat conversation goes here.</div>
          </section>
        </section>
      </div>
    </div>
  );
}

/** The phone's seat sheet over a dimmed board, and the tick sheet its row
    opens — the card's own wiring, verbatim. */
function Phone() {
  const [sheet, setSheet] = useState<"seat" | "tick">("seat");
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-canvas text-primary">
      <div className="min-h-0 flex-1 p-3 text-ui text-muted">The board is behind the sheet.</div>
      <MobileOrchestratorSheet
        project={PROJECT}
        projectName="Atlas"
        sheet={sheet}
        now={Date.now() / 1000}
        state={live}
        status={{ seat, pending: null, exists: true, viewerMcpRegistered: true }}
        file={file}
        incumbent={null}
        pendingMandate=""
        viewerMcpRegistered
        submitting={false}
        rotate={{ open: false, seat: null, vacated: false, opening: false, submitting: false, failure: null, onOpen() {}, onCancel() {}, onConfirm() {} }}
        tick={{ onOpen: () => setSheet("tick"), onClose: () => setSheet("seat") }}
        onConfirm={() => undefined}
        onRecheck={() => undefined}
        onOpenConversation={() => undefined}
        onClose={() => undefined}
      />
    </div>
  );
}

const dock = Number(params.get("dock")) || 440;
const surface = params.get("surface");
createRoot(document.getElementById("root")!).render(
  surface === "phone" ? <Phone /> : surface === "seat" ? <Seat /> : <Desktop dock={dock} />,
);
