import { describe, expect, test } from "bun:test";

import { translate } from "@/lib/i18n";
import type { OrchestratorSeat } from "@/lib/orchestrator/seats";
import type { FileEntry } from "@/lib/types";

import type { OrchestratorIncumbent } from "./incumbent";
import {
  classifySeatFailure,
  deriveOrchestratorPanelState,
  deriveRotateDraftState,
  newSeatRequestId,
  orchestratorQuietBannerEligible,
  parseSeatStatus,
  seatConversationsOf,
  resolveSeatFile,
  ROTATION_CONTEXT_PERCENT,
  rotationBannerLines,
  telegramActionLine,
  SEAT_BIND_TIMEOUT_MS,
  seatBadgeOf,
  seatDeputyPaths,
  seatFailureCauseOf,
  seatFailureCopy,
  seatRefsOf,
  seatRequestSettled,
  seatVacated,
  vacatedSeatReplacement,
  type OrchestratorPanelState,
  type OrchestratorSeatStatus,
  type RotationHint,
} from "./seatState";

function seat(overrides: Partial<OrchestratorSeat> = {}): OrchestratorSeat {
  return {
    project: "atlas",
    seatEpoch: 4,
    conversationId: "conversation_orchestrator",
    path: "/transcripts/orchestrator.jsonl",
    mandate: "run the board",
    promptVersion: 3,
    predecessorConversationId: null,
    state: "active",
    intent: { clientRequestId: "req-11111111", mode: "spawn", launchId: "launch-1", error: null },
    designatedAt: "2026-08-13T09:00:00.000Z",
    activatedAt: "2026-08-13T09:00:02.000Z",
    ...overrides,
  };
}

function status(overrides: Partial<OrchestratorSeatStatus> = {}): OrchestratorSeatStatus {
  return { seat: null, pending: null, exists: true, viewerMcpRegistered: false, ...overrides };
}

function file(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/transcripts/orchestrator.jsonl",
    root: "claude-projects",
    name: "orchestrator.jsonl",
    project: "atlas",
    title: "Orchestrator",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_760_000_000,
    size: 10,
    activity: "live",
    proc: null,
    pid: null,
    model: "opus",
    pendingQuestion: null,
    waitingInput: null,
    conversationId: "conversation_orchestrator",
    ...overrides,
  } as FileEntry;
}

const base = { statusFailed: false, submitting: false, submitFailure: null, file: null, surface: null };

/** A fixed «now» for the one derivation that reads a clock: the attention
    queue's stalled tier, which ages out (`STALLED_ATTENTION_TTL`). */
const NOW = 1_760_000_100;

describe("the panel names every state in the map (#977)", () => {
  test("no answer yet is loading, and a failed read says so instead of inviting a second orchestrator", () => {
    expect(deriveOrchestratorPanelState({ ...base, status: null }).kind).toBe("loading");
    expect(deriveOrchestratorPanelState({ ...base, status: null, statusFailed: true }).kind).toBe("unavailable");
  });

  test("no seat is the draft; a seat whose transcript is gone returns to the draft, marked vacated", () => {
    expect(deriveOrchestratorPanelState({ ...base, status: status() })).toEqual({ kind: "draft", vacated: false });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat(), exists: false }) }))
      .toEqual({ kind: "draft", vacated: true });
  });

  test("a seat is vacated only when its record stands and its conversation is gone — one predicate for both create forms", () => {
    expect(seatVacated(null)).toBe(false);
    expect(seatVacated(status())).toBe(false);
    expect(seatVacated(status({ seat: seat(), exists: true }))).toBe(false);
    expect(seatVacated(status({ seat: seat(), exists: false }))).toBe(true);
    expect(seatVacated(status({ seat: null, exists: false }))).toBe(false);
    expect(vacatedSeatReplacement(status({ seat: seat(), exists: false }))).toEqual({
      replaceIncumbent: true,
      expectedIncumbentSeatEpoch: 4,
    });
    expect(vacatedSeatReplacement(status({ seat: seat(), exists: true }))).toEqual({});
    expect(vacatedSeatReplacement(status())).toEqual({});
    expect(vacatedSeatReplacement(null)).toEqual({});
  });

  test("a POST on the wire and a durable pending intent are both creating", () => {
    expect(deriveOrchestratorPanelState({ ...base, status: status(), submitting: true }).kind).toBe("creating");
    const pending = seat({ state: "pending", conversationId: null, path: null, intent: { clientRequestId: "req-22222222", mode: "spawn", launchId: "launch-9", error: null } });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ pending }) }))
      .toEqual({ kind: "creating", launchId: "launch-9", clientRequestId: "req-22222222", designatedAt: pending.designatedAt });
  });

  test("a pending intent nothing is driving carries its own key, so the panel can finish it instead of spinning", () => {
    const pending = seat({ state: "pending", conversationId: null, path: null, intent: { clientRequestId: "req-55555555", mode: "spawn", launchId: "launch-x", error: null } });
    const state = deriveOrchestratorPanelState({ ...base, status: status({ pending }) });
    expect(state).toMatchObject({ kind: "creating", clientRequestId: "req-55555555" });
  });

  test("a stored terminal error is the intent-error state, with a fresh-key retry", () => {
    const pending = seat({ state: "pending", conversationId: null, path: null, intent: { clientRequestId: "req-33333333", mode: "spawn", launchId: null, error: "spawn was rejected with HTTP status 400" } });
    const state = deriveOrchestratorPanelState({ ...base, status: status({ pending }) });
    expect(state).toEqual({
      kind: "intent-error",
      error: "spawn was rejected with HTTP status 400",
      retry: "fresh",
      designatedAt: pending.designatedAt,
    });
  });

  test("REGRESSION (#1757): a TERMINALIZED failure keeps its reason on the panel after it leaves the pending position", () => {
    /* The failure is durable history the moment it happens, so `pending` is
       empty by the time the panel reads the seat — and the operator is still
       owed the reason, especially for a rotation this browser never submitted. */
    const state = deriveOrchestratorPanelState({
      ...base,
      status: status({
        lastFailure: {
          error: "the accepted launch failed before its conversation became readable: runtime host timed out",
          clientRequestId: "req-77777777",
          seatEpoch: 172,
          designatedAt: "2026-09-18T09:46:49.000Z",
          terminalizedAt: "2026-09-18T09:47:31.000Z",
        },
      }),
    });
    expect(state).toEqual({
      kind: "intent-error",
      error: "the accepted launch failed before its conversation became readable: runtime host timed out",
      retry: "fresh",
      designatedAt: "2026-09-18T09:46:49.000Z",
    });
  });

  test("REGRESSION (#1757): a rollback's failure rides ALONGSIDE the seat it restored, and an older one does not", () => {
    const restored = seat({ activatedAt: "2026-09-18T09:47:31.000Z" });
    const standing = {
      error: "the accepted launch failed before its conversation became readable: runtime host timed out",
      clientRequestId: "req-77777777",
      seatEpoch: 172,
      designatedAt: "2026-09-18T09:46:49.000Z",
      terminalizedAt: "2026-09-18T09:47:31.000Z",
    };
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: restored, lastFailure: standing }) }))
      .toMatchObject({ kind: "live", transition: { kind: "error", error: standing.error } });
    /* ...and a failure the seat outlived is history, not a banner: a permanent
       record must not hang a dead reason over a healthy orchestrator. */
    expect(deriveOrchestratorPanelState({
      ...base,
      status: status({ seat: restored, lastFailure: { ...standing, terminalizedAt: "2026-09-10T00:00:00.000Z" } }),
    })).toMatchObject({ kind: "live", transition: null });
  });

  test("a lost reply is an intent-error whose retry replays the SAME key", () => {
    const state = deriveOrchestratorPanelState({
      ...base,
      status: status(),
      submitFailure: { kind: "ambiguous", error: "the reply never arrived", clientRequestId: "req-99999999" },
    });
    expect(state).toEqual({ kind: "intent-error", error: "the reply never arrived", retry: "same", designatedAt: "" });
  });

  test("an active seat is live, and its liveness follows the CAPABILITY SURFACE, not just activity", () => {
    const live = deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), surface: "live-root" });
    expect(live).toMatchObject({ kind: "live", conversationId: "conversation_orchestrator", liveness: "live", rotation: null, transition: null });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), surface: "structured" }))
      .toMatchObject({ kind: "live", liveness: "live" });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: null }))
      .toMatchObject({ kind: "live", liveness: "resolving" });
    /* The plane is authoritative and has not resolved the host: neither claim. */
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), surface: "unresolved" }))
      .toMatchObject({ kind: "live", liveness: "resolving" });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file({ activity: "stalled" }), surface: "live-root" }))
      .toMatchObject({ kind: "live", liveness: "stalled" });
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), surface: "dead" }))
      .toMatchObject({ kind: "live", liveness: "dead" });
  });

  test("a finished but resumable seat is NOT live — on either engine, and never a duplicate spawn", () => {
    /* The matrix classifies a completed Claude session and a completed Codex
       thread alike: `resume`, meaning THIS conversation continues. The panel
       used to call both «live» because neither is stalled. */
    const claude = deriveOrchestratorPanelState({
      ...base,
      status: status({ seat: seat() }),
      file: file({ root: "claude-projects", engine: "claude", kind: "session", proc: null, activity: "idle" as FileEntry["activity"] }),
      surface: "resume",
    });
    expect(claude).toMatchObject({ kind: "live", liveness: "resumable" });

    const codex = deriveOrchestratorPanelState({
      ...base,
      status: status({ seat: seat() }),
      file: file({ root: "codex-sessions", engine: "codex", proc: "killed" as FileEntry["proc"] }),
      surface: "resume",
    });
    expect(codex).toMatchObject({ kind: "live", liveness: "resumable" });
    /* Resumable in place is not a reason to rotate — only a gone host is. */
    expect(codex).toMatchObject({ rotation: null });

    /* Finished and NOT resumable, or retired behind a successor: nothing to
       pick back up, so it reads as gone rather than as running. */
    for (const surface of ["inert", "superseded"] as const) {
      expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), surface }))
        .toMatchObject({ kind: "live", liveness: "dead", rotation: { reasons: ["dead"] } });
    }
  });

  test("rotation is recommended at the server's own threshold, and for a gone host", () => {
    const under = deriveOrchestratorPanelState({
      ...base,
      status: status({ seat: seat() }),
      file: file({ ctx: { usedTokens: 49, windowTokens: 100, pct: ROTATION_CONTEXT_PERCENT - 1, source: "transcript", confidence: "high", observedAt: "" } as unknown as FileEntry["ctx"] }),
    });
    expect(under).toMatchObject({ kind: "live", rotation: null });

    const at = deriveOrchestratorPanelState({
      ...base,
      status: status({ seat: seat() }),
      file: file({ ctx: { usedTokens: 50, windowTokens: 100, pct: ROTATION_CONTEXT_PERCENT, source: "transcript", confidence: "high", observedAt: "" } as unknown as FileEntry["ctx"] }),
    });
    expect(at).toMatchObject({ kind: "live", rotation: { level: "strongly_recommend", contextPercent: ROTATION_CONTEXT_PERCENT, reasons: ["context"] } });

    const dead = deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), surface: "dead" });
    expect(dead).toMatchObject({ kind: "live", rotation: { level: "recommend", reasons: ["dead"] } });
  });

  test("a failed transition over a live incumbent is shown ALONGSIDE it, never instead of it", () => {
    const pending = seat({ state: "pending", conversationId: null, path: null, intent: { clientRequestId: "req-44444444", mode: "spawn", launchId: null, error: "spawn did not report an accepted launch" } });
    const state = deriveOrchestratorPanelState({ ...base, status: status({ seat: seat(), pending }), file: file() });
    expect(state).toMatchObject({
      kind: "live",
      transition: { kind: "error", error: "spawn did not report an accepted launch" },
    });
  });
});

describe("the gone-quiet banner waits for the mandate's first visible acknowledgement (#1118)", () => {
  const active = seat({
    designatedAt: "2026-08-24T09:00:00.000Z",
    activatedAt: "2026-08-24T09:00:02.000Z",
  });
  const stalled = (overrides: Partial<FileEntry> = {}) => file({
    activity: "stalled",
    lastTurn: { startedAt: Date.parse("2026-08-24T09:00:01.000Z"), endedAt: null },
    lastAssistantMessageAt: null,
    ...overrides,
  });

  test("a fresh seat's first mandate turn stays in flight before any visible assistant status", () => {
    const state = deriveOrchestratorPanelState({ ...base, status: status({ seat: active }), file: stalled(), surface: "live-root" });
    expect(orchestratorQuietBannerEligible(state, stalled())).toBe(false);
  });

  test("an assistant status in the current mandate turn acknowledges it and keeps the banner retired", () => {
    const acknowledged = stalled({ lastAssistantMessageAt: Date.parse("2026-08-24T09:00:03.000Z") });
    const state = deriveOrchestratorPanelState({ ...base, status: status({ seat: active }), file: acknowledged, surface: "live-root" });
    expect(orchestratorQuietBannerEligible(state, acknowledged)).toBe(false);
  });

  test("a later turn that goes quiet after the mandate acknowledgement remains eligible", () => {
    const later = stalled({
      lastTurn: { startedAt: Date.parse("2026-08-24T09:30:00.000Z"), endedAt: null },
      lastAssistantMessageAt: Date.parse("2026-08-24T09:00:03.000Z"),
    });
    const state = deriveOrchestratorPanelState({ ...base, status: status({ seat: active }), file: later, surface: "live-root" });
    expect(orchestratorQuietBannerEligible(state, later)).toBe(true);
  });

  test("unknown assistant history fails closed and preserves the warning", () => {
    const unknown = stalled({ lastAssistantMessageAt: undefined });
    const state = deriveOrchestratorPanelState({ ...base, status: status({ seat: active }), file: unknown, surface: "live-root" });
    expect(orchestratorQuietBannerEligible(state, unknown)).toBe(true);
  });
});

describe("the server's own rotation recommendation is what the panel says (#978)", () => {
  const incumbent = (overrides: Partial<OrchestratorIncumbent> = {}): OrchestratorIncumbent => ({
    project: "atlas",
    designated: true,
    conversationId: "conversation_orchestrator",
    predecessorConversationId: null,
    engine: "claude",
    model: "opus",
    effort: null,
    accountId: "work",
    cwd: "/repos/atlas",
    transcriptPath: "/transcripts/orchestrator.jsonl",
    liveness: { lifecycle: "running", hostState: "alive", silentForMs: 0 },
    context: { tokens: 620_000, limit: 1_000_000, percent: 62, estimated: false, basis: "provider-reported usage" },
    transcriptFacts: { bytes: 1024, messageCount: 10, toolCount: 4, compactionCount: 0 },
    rotation: { recommended: false, level: "none", reasons: [], causes: [], thresholdUnknown: false },
    ...overrides,
  });
  const live = (over: Partial<Parameters<typeof deriveOrchestratorPanelState>[0]>) =>
    deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), file: file(), surface: "live-root", ...over });

  const contextCause = { kind: "context" as const, tokens: 620_000, estimated: false, thresholdTokens: 500_000, windowTokens: 1_000_000 };

  test("its causes ride along as data, with the percentage it measured", () => {
    const state = live({
      incumbent: incumbent({
        rotation: {
          recommended: true,
          level: "strongly_recommend",
          reasons: ["context usage 620,000 tokens has reached the rotation threshold of 500,000 tokens (claude-opus-1m: 50% of a 1,000,000-token window)"],
          causes: [contextCause],
          thresholdUnknown: false,
        },
      }),
    });
    expect(state).toMatchObject({
      kind: "live",
      rotation: { level: "strongly_recommend", contextPercent: 62, reasons: ["context"], causes: [contextCause], source: "server" },
    });
  });

  test("the banner says each cause once, in the interface language, with what to do and no tool name", () => {
    const hint: RotationHint = {
      level: "strongly_recommend",
      contextPercent: 62,
      /* The client's own two readings name the same causes the server did. */
      reasons: ["context", "dead"],
      causes: [contextCause, { kind: "compactions", count: 3, threshold: 2 }, { kind: "transcript", megabytes: 9.4, thresholdMegabytes: 8 }, { kind: "host_gone" }],
      source: "server",
    };
    for (const lang of ["en", "uk"] as const) {
      const lines = rotationBannerLines((key, params) => translate(lang, key, params), lang, hint);
      expect(lines).toHaveLength(4);
      expect(new Set(lines).size).toBe(4);
      expect(lines.at(-1)).toBe(translate(lang, "orchPanel.rotationDead"));
      for (const line of lines) expect(line).not.toMatch(/send_message|rotate_orchestrator|_to_|designated conversation/);
    }
    const uk = rotationBannerLines((key, params) => translate("uk", key, params), "uk", hint);
    expect(uk.join(" ")).not.toMatch(/[a-z]{4,}/);
    expect(uk[0]).toContain("620\u00a0000");
    const en = rotationBannerLines((key, params) => translate("en", key, params), "en", hint);
    expect(en[0]).toContain("620,000");
    expect(en[0]).toContain("500,000");
  });

  test("an estimate is said to be one, and a client reading fills in only what the server did not name", () => {
    const en = (hint: RotationHint) => rotationBannerLines((key, params) => translate("en", key, params), "en", hint);
    expect(en({ level: "recommend", contextPercent: 62, reasons: [], causes: [{ ...contextCause, estimated: true }], source: "server" }))
      .toEqual([translate("en", "orchPanel.rotationContextTokensEstimated", { tokens: "620,000", threshold: "500,000" })]);
    /* The board saw a gone host the server's reading had not caught up with. */
    expect(en({ level: "recommend", contextPercent: null, reasons: ["dead"], causes: [], source: "server" }))
      .toEqual([translate("en", "orchPanel.rotationDead")]);
    expect(en({ level: "strongly_recommend", contextPercent: 71, reasons: ["context", "dead"], source: "client" }))
      .toEqual([translate("en", "orchPanel.rotationContext", { percent: "71" }), translate("en", "orchPanel.rotationDead")]);
  });

  test("a recommendation the coded reasons cannot express still shows, carried by the server's cause", () => {
    const state = live({
      incumbent: incumbent({
        rotation: {
          recommended: true, level: "recommend", reasons: ["3 compaction(s) recorded in the transcript, threshold 2"],
          causes: [{ kind: "compactions", count: 3, threshold: 2 }], thresholdUnknown: false,
        },
      }),
    });
    expect(state).toMatchObject({ kind: "live", rotation: { level: "recommend", reasons: [], source: "server" } });
  });

  test("the server standing the advisory down beats a client guess about the same seat", () => {
    /* The board's own context read says 62% — over slice A's flat threshold —
       but the model's real window makes that well under the policy line. */
    const over = file({ ctx: { usedTokens: 620_000, windowTokens: 1_000_000, pct: 62, source: "transcript", confidence: "high", observedAt: "" } as unknown as FileEntry["ctx"] });
    expect(live({ file: over })).toMatchObject({ rotation: { level: "strongly_recommend", source: "client" } });
    expect(live({ file: over, incumbent: incumbent() })).toMatchObject({ rotation: null });
  });

  test("a gone host is ADDED to the server's reading, never subtracted from it", () => {
    expect(live({ surface: "dead", incumbent: incumbent() }))
      .toMatchObject({ rotation: { level: "recommend", reasons: ["dead"], source: "server" } });
  });

  test("a reading about a vacant seat is ignored — the client derivation still holds the state up", () => {
    const vacantReading = incumbent({ designated: false, rotation: null });
    expect(live({ surface: "dead", incumbent: vacantReading }))
      .toMatchObject({ rotation: { level: "recommend", reasons: ["dead"], source: "client" } });
  });

  /**
   * AN IDLE PROCESS IS NOT AN ACTIVELY WORKING TURN (operator directive,
   * 2026-09-10).
   *
   * The board's catalog cannot tell them apart — a hosted agent sitting on a
   * finished turn is exactly as quiet as one mid-tool-call — so a green «live»
   * over the first is a claim nobody made. The status read's lifecycle says
   * which it is, in the shared vocabulary where `waiting` is "a host is alive
   * and idle".
   */
  test("a hosted seat whose TURN is idle reads waiting, and one whose turn is running reads live", () => {
    const hosted = { hostLive: true };
    const idleTail = file({ lastTurn: { startedAt: 1_000, endedAt: 2_000 } });
    const openTail = file({ lastTurn: { startedAt: 1_000, endedAt: null } });
    expect(live({ ...hosted, file: idleTail })).toMatchObject({ kind: "live", liveness: "waiting" });
    expect(live({ ...hosted, file: openTail })).toMatchObject({ kind: "live", liveness: "live" });
  });

  /**
   * THE TURN'S OWN BOUNDARY OUTRANKS THE MINUTE-OLD READING, in both
   * directions. `liveness.lifecycle` rides the incumbent poll, whose cadence is
   * set by context-window wear — a minute — while `lastTurn` arrives on the
   * file poll. Reading the slow one first holds "waiting" over an agent that
   * started working a message ago, and "live" over one that finished: the
   * original complaint, time-boxed rather than fixed.
   */
  test("the catalog's fresh turn boundary outranks a minute-old lifecycle, both ways", () => {
    const stillIdle = incumbent({ liveness: { lifecycle: "waiting", hostState: "alive", silentForMs: 211_916 } });
    const stillRunning = incumbent({ liveness: { lifecycle: "running", hostState: "alive", silentForMs: 0 } });
    /* The operator just sent a message: the turn is open in the catalog while
       the status read still remembers an idle seat. */
    expect(live({ hostLive: true, incumbent: stillIdle, file: file({ lastTurn: { startedAt: 1_000, endedAt: null } }) }))
      .toMatchObject({ liveness: "live" });
    /* And the turn just ended, while the status read still remembers a running
       one — the green badge the operator read as "it is working". */
    expect(live({ hostLive: true, incumbent: stillRunning, file: file({ lastTurn: { startedAt: 1_000, endedAt: 2_000 } }) }))
      .toMatchObject({ liveness: "waiting" });
  });

  test("with no turn boundary in the tail, only an AFFIRMED reading may downgrade — and only from live", () => {
    const idle = incumbent({ liveness: { lifecycle: "waiting", hostState: "alive", silentForMs: 1_000 } });
    /* No boundary derivable from the tail (#231), so the slow reading is the
       only reading there is. */
    expect(live({ hostLive: true, incumbent: idle })).toMatchObject({ liveness: "waiting" });
    /* No affirmation: the reading may be a memory from before a restart, and
       accusing the seat of idling on one is the same fault `hostLive` already
       fences for the bind bound (#1182). */
    expect(live({ hostLive: false, incumbent: idle })).toMatchObject({ liveness: "live" });
    /* A tail that carries a boundary needs no such gate — it is this poll's own
       answer about this transcript, not a claim held over. */
    expect(live({ hostLive: false, incumbent: idle, file: file({ lastTurn: { startedAt: 1_000, endedAt: 2_000 } }) }))
      .toMatchObject({ liveness: "waiting" });
    /* Stronger statements about the HOST are never softened by an idle turn. */
    const idleTail = { lastTurn: { startedAt: 1_000, endedAt: 2_000 } };
    expect(live({ hostLive: true, surface: "dead", incumbent: idle, file: file(idleTail) })).toMatchObject({ liveness: "dead" });
    expect(live({ hostLive: true, surface: "resume", incumbent: idle, file: file(idleTail) })).toMatchObject({ liveness: "resumable" });
    expect(live({ hostLive: true, incumbent: idle, file: file({ ...idleTail, activity: "stalled" }) })).toMatchObject({ liveness: "stalled" });
  });
});

describe("the rotate draft renders the same two states the create draft does (#978)", () => {
  test("with nothing wrong it is just the form", () => {
    expect(deriveRotateDraftState({ status: status({ seat: seat() }), submitFailure: null }))
      .toEqual({ kind: "draft", vacated: false });
  });

  test("a rotation the server refused is shown with retry, and the retry needs a fresh key", () => {
    const pending = seat({
      state: "pending",
      conversationId: null,
      intent: { clientRequestId: "req-99999999", mode: "spawn", launchId: null, error: "spawn was rejected with HTTP status 500" },
    });
    expect(deriveRotateDraftState({ status: status({ seat: seat(), pending }), submitFailure: null }))
      .toMatchObject({ kind: "intent-error", error: "spawn was rejected with HTTP status 500", retry: "fresh" });
  });

  test("a lost reply is shown as unknown, and its retry replays the SAME key", () => {
    const failure = { kind: "ambiguous" as const, error: "the reply never arrived", clientRequestId: "req-88888888" };
    expect(deriveRotateDraftState({ status: status({ seat: seat() }), submitFailure: failure }))
      .toMatchObject({ kind: "intent-error", retry: "same" });
  });

  test("once the read shows where that rotation landed, the banner retires with it", () => {
    const key = "req-88888888";
    const successor = seat({ conversationId: "conversation_successor", intent: { clientRequestId: key, mode: "spawn", launchId: "launch-2", error: null } });
    expect(deriveRotateDraftState({ status: status({ seat: successor }), submitFailure: { kind: "ambiguous", error: "lost", clientRequestId: key } }))
      .toEqual({ kind: "draft", vacated: false });
  });
});

describe("seat status parsing", () => {
  test("a malformed body reads as no seat rather than throwing", () => {
    expect(parseSeatStatus(null)).toEqual({ seat: null, pending: null, lastFailure: null, exists: true, viewerMcpRegistered: false, previous: [], currentTask: null, all: null });
    expect(parseSeatStatus({ seat: { project: 7 }, pending: [], exists: false }))
      .toEqual({ seat: null, pending: null, lastFailure: null, exists: false, viewerMcpRegistered: false, previous: [], currentTask: null, all: null });
  });

  /* The seat's notes task comes off the answer, so a surface with no task list
     can name the live seat and tell whether it has notes to offer at all. */
  test("the current seat's task, its title and whether it has notes are read from the answer (#1841)", () => {
    expect(parseSeatStatus({ currentTask: { taskId: "task-seat", title: "Manager seat, release week", hasNotes: true } }).currentTask)
      .toEqual({ taskId: "task-seat", title: "Manager seat, release week", hasNotes: true });
    /* No notes, and an unnamed task: neither is guessed into something else. */
    expect(parseSeatStatus({ currentTask: { taskId: "task-seat" } }).currentTask).toEqual({ taskId: "task-seat", title: null, hasNotes: false });
    expect(parseSeatStatus({ currentTask: { title: "no id" } }).currentTask).toBeNull();
    expect(parseSeatStatus({ currentTask: "task-seat" }).currentTask).toBeNull();
    /* Retired seats answer the same question the same way. */
    const previous = parseSeatStatus({ previous: [
      { conversationId: "conversation_a", heldTo: "2026-09-18T14:02:00.000Z", taskId: "task-a", hasNotes: true },
      { conversationId: "conversation_b", heldTo: "2026-09-17T09:40:00.000Z", taskId: "task-b" },
    ] }).previous;
    expect(previous?.map((row) => [row.conversationId, row.hasNotes])).toEqual([["conversation_a", true], ["conversation_b", false]]);
  });

  /* The surfaces that span projects hide seat rows on this field, so an answer
     that cannot supply it has to read as «unknown», never as «no seats». */
  test("the cross-project seat conversations are read whole or not at all (#1841)", () => {
    expect(parseSeatStatus({
      all: { conversationIds: ["conversation_a", 7, ""], paths: ["/seats/a.jsonl"], previous: { conversationIds: ["conversation_b"], paths: [] } },
    }).all).toEqual({
      conversationIds: ["conversation_a"],
      paths: ["/seats/a.jsonl"],
      previous: { conversationIds: ["conversation_b"], paths: [] },
    });
    /* An empty record is still a record that was read. */
    expect(parseSeatStatus({ all: { conversationIds: [], paths: [], previous: {} } }).all)
      .toEqual({ conversationIds: [], paths: [], previous: { conversationIds: [], paths: [] } });
    /* Unreadable, absent, or an answer from before the field existed. */
    expect(parseSeatStatus({ all: null }).all).toBeNull();
    expect(parseSeatStatus({}).all).toBeNull();
    expect(parseSeatStatus({ all: { conversationIds: ["conversation_a"], paths: [] } }).all).toBeNull();
    expect(seatConversationsOf("all of them")).toBeNull();
  });

  test("a well-formed seat keeps the fields the panel renders from", () => {
    const parsed = parseSeatStatus({ seat: seat(), pending: null, exists: true, viewerMcpRegistered: true });
    expect(parsed.seat?.conversationId).toBe("conversation_orchestrator");
    expect(parsed.seat?.intent.clientRequestId).toBe("req-11111111");
    expect(parsed.viewerMcpRegistered).toBe(true);
  });
});

describe("confirm outcomes decide whether the next attempt reuses its key", () => {
  const key = "req-77777777";

  test("a refusal is terminal — the corrected mandate needs a new key", () => {
    expect(classifySeatFailure(400, { error: "mandate is required" }, key))
      .toEqual({ kind: "terminal", error: "mandate is required", clientRequestId: key });
    expect(classifySeatFailure(409, { error: "already designated", code: "already_designated" }, key))
      .toEqual({ kind: "terminal", error: "already designated", clientRequestId: key });
  });

  test("an in-flight transition owned by another request is neither — the poll reports it", () => {
    expect(classifySeatFailure(409, { error: "in progress", code: "seat_intent_in_progress" }, key)).toBeNull();
  });

  test("a 5xx leaves worker existence unknown, so the retry replays the same key", () => {
    expect(classifySeatFailure(502, { error: "mandate delivery failed" }, key))
      .toEqual({ kind: "ambiguous", error: "mandate delivery failed", clientRequestId: key });
    expect(classifySeatFailure(500, null, key))
      .toEqual({ kind: "ambiguous", error: "the seat route answered HTTP 500", clientRequestId: key });
  });
});

describe("a kept key is released once the server says where it landed (#977 round 2)", () => {
  const key = "req-66666666";

  test("unknown stays unknown: a key the read cannot place may still be in flight", () => {
    expect(seatRequestSettled(null, key)).toBe(false);
    expect(seatRequestSettled(status(), key)).toBe(false);
    /* Someone else's designation says nothing about this one. */
    expect(seatRequestSettled(status({ seat: seat() }), key)).toBe(false);
    expect(seatRequestSettled(status({ pending: seat({ state: "pending" }) }), key)).toBe(false);
  });

  test("a pending intent under this key is settled only once it carries a terminal error", () => {
    const pending = (error: string | null) => seat({
      state: "pending",
      conversationId: null,
      intent: { clientRequestId: key, mode: "spawn", launchId: null, error },
    });
    expect(seatRequestSettled(status({ pending: pending(null) }), key)).toBe(false);
    expect(seatRequestSettled(status({ pending: pending("spawn was rejected") }), key)).toBe(true);
  });

  test("reaching an active seat settles it — including after that conversation is closed", () => {
    const active = seat({ intent: { clientRequestId: key, mode: "spawn", launchId: "launch-1", error: null } });
    expect(seatRequestSettled(status({ seat: active }), key)).toBe(true);
    /* The vacancy the NEXT draft creates into: replaying this key there would be
       answered with the completed intent and create nothing at all. */
    expect(seatRequestSettled(status({ seat: active, exists: false }), key)).toBe(true);
  });

  test("a lost-reply banner retires when the read shows that submission landed", () => {
    const active = seat({ intent: { clientRequestId: key, mode: "spawn", launchId: "launch-1", error: null } });
    const failure = { kind: "ambiguous" as const, error: "the reply never arrived", clientRequestId: key };
    /* Before the read catches up it is the panel's whole state… */
    expect(deriveOrchestratorPanelState({ ...base, status: status(), submitFailure: failure }))
      .toMatchObject({ kind: "intent-error", retry: "same" });
    /* …and once the seat it created is visible, it stops riding along. */
    expect(deriveOrchestratorPanelState({ ...base, status: status({ seat: active }), file: file(), surface: "live-root", submitFailure: failure }))
      .toMatchObject({ kind: "live", transition: null });
  });
});

test("a minted request id satisfies the seat route's own gate", () => {
  for (let index = 0; index < 20; index += 1) {
    expect(newSeatRequestId()).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  }
});

describe("the dock binds the seat by its durable conversation id (#1182)", () => {
  const successorPath = "/transcripts/orchestrator.successor.jsonl";

  test("a recorded path the catalog no longer carries still binds, because the id does", () => {
    /* The seat froze the path it was activated at; the conversation has since
       been re-hosted onto a new transcript under the SAME durable id. */
    const successor = file({ path: successorPath, name: "orchestrator.successor.jsonl" });
    expect(resolveSeatFile({
      files: [successor],
      conversationId: "conversation_orchestrator",
      seatPath: "/transcripts/orchestrator.jsonl",
      currentPath: null,
    })).toBe(successor);
  });

  test("a successor generation the catalog knows under another id binds through the status read's current path", () => {
    /* The re-hosted generation entered the catalog keyed by the native session
       it is now written under, so nothing about the seat's recorded id or path
       matches it. `GET /api/orchestrator/seat/status` resolves the durable id
       to exactly this path through the registry, which is the bridge. */
    const successor = file({ path: successorPath, name: "orchestrator.successor.jsonl", conversationId: "conversation_successor" });
    expect(resolveSeatFile({
      files: [successor],
      conversationId: "conversation_orchestrator",
      seatPath: "/transcripts/orchestrator.jsonl",
      currentPath: successorPath,
    })).toBe(successor);
  });

  test("the recorded path is a hint: it binds when nothing better answers, and never outranks the id", () => {
    const recorded = file();
    const successor = file({ path: successorPath, name: "orchestrator.successor.jsonl" });
    /* Only the hint is left. */
    expect(resolveSeatFile({ files: [recorded], conversationId: "conversation_orchestrator", seatPath: recorded.path, currentPath: null })).toBe(recorded);
    /* The recorded path is an archived predecessor of the live generation, so
       the id's current entry wins over the entry the path names. */
    const archived = file({ migratedTo: successorPath } as Partial<FileEntry>);
    expect(resolveSeatFile({ files: [archived, successor], conversationId: "conversation_orchestrator", seatPath: archived.path, currentPath: null })).toBe(successor);
    /* No seat at all binds nothing, whatever the catalog holds. */
    expect(resolveSeatFile({ files: [successor], conversationId: null, seatPath: successorPath, currentPath: successorPath })).toBeNull();
  });
});

describe("«opening» is bounded once the status read says the host is alive (#1182)", () => {
  const stuck = { ...base, status: status({ seat: seat() }), hostLive: true };

  test("under the bound it is still opening; over it, the panel names what is missing", () => {
    expect(deriveOrchestratorPanelState({ ...stuck, unboundForMs: SEAT_BIND_TIMEOUT_MS - 1 }))
      .toMatchObject({ kind: "live", liveness: "resolving", bindFailure: null });
    expect(deriveOrchestratorPanelState({ ...stuck, unboundForMs: SEAT_BIND_TIMEOUT_MS }))
      .toMatchObject({ kind: "live", liveness: "resolving", bindFailure: "catalog" });
  });

  test("a bound transcript whose host the runtime plane has not resolved names THAT instead", () => {
    expect(deriveOrchestratorPanelState({ ...stuck, file: file(), surface: "unresolved", unboundForMs: SEAT_BIND_TIMEOUT_MS }))
      .toMatchObject({ kind: "live", liveness: "resolving", bindFailure: "surface" });
  });

  test("nothing is claimed while the wait is legitimate: no live host, or the seat already bound", () => {
    /* The status read has not reported a live host, so «opening» is honest. */
    expect(deriveOrchestratorPanelState({ ...stuck, hostLive: false, unboundForMs: 10 * SEAT_BIND_TIMEOUT_MS }))
      .toMatchObject({ bindFailure: null });
    /* Bound and classified — there is no wait to bound. */
    expect(deriveOrchestratorPanelState({ ...stuck, file: file(), surface: "live-root", unboundForMs: 10 * SEAT_BIND_TIMEOUT_MS }))
      .toMatchObject({ liveness: "live", bindFailure: null });
  });
});

describe("a decision the operator owes outranks every word for «it is running» (#1167)", () => {
  const asked = {
    kind: "question" as const,
    toolUseId: "tool-use-orch",
    transcriptPath: "/transcripts/orchestrator.jsonl",
    pid: 4242,
    paneTarget: null,
    askedAt: "2026-08-25T10:00:00.000Z",
    questions: [{ header: "Rollout window", question: "Approve the proposed rollout window", multiSelect: false, options: [] }],
  };
  const seated = { ...base, status: status({ seat: seat() }), now: NOW };
  const badgeOf = (state: OrchestratorPanelState) => seatBadgeOf(state as Extract<OrchestratorPanelState, { kind: "live" }>);

  /* EVERY liveness `livenessOf` can produce, with the surface and the file that
     produce it — the badge is asserted over all five, both ways, so no state can
     quietly opt out of naming a decision the island is already counting. */
  const LIVENESSES = [
    ["live-root", {}, "live"],
    ["live-root", { activity: "stalled" }, "stalled"],
    ["resume", {}, "resumable"],
    ["dead", {}, "dead"],
    ["unresolved", {}, "resolving"],
  ] as const;

  test("a hosted seat with a question on screen carries the attention id and badges «needs you»", () => {
    const state = deriveOrchestratorPanelState({ ...seated, file: file({ pendingQuestion: asked }), surface: "live-root" });
    expect(state).toMatchObject({ kind: "live", liveness: "live", attention: "tool-use-orch" });
    expect(badgeOf(state)).toBe("needs-you");
  });

  test("a pending decision is the badge at every liveness, «finished» and «host gone» included", () => {
    for (const [surface, overrides, liveness] of LIVENESSES) {
      const state = deriveOrchestratorPanelState({ ...seated, file: file({ ...overrides, pendingQuestion: asked }), surface });
      expect(state).toMatchObject({ liveness, attention: "tool-use-orch" });
      expect(badgeOf(state)).toBe("needs-you");
    }
  });

  test("with nothing owed, every liveness keeps its own word", () => {
    for (const [surface, overrides, liveness] of LIVENESSES) {
      const state = deriveOrchestratorPanelState({ ...seated, file: file(overrides), surface });
      expect(state).toMatchObject({ liveness, attention: null });
      expect(badgeOf(state)).toBe(liveness === "live" ? "working" : liveness);
    }
  });

  test("a terminal prompt is a decision too — the badge follows the queue, not the signal's shape", () => {
    const waiting = file({
      activity: "stalled",
      waitingInput: { since: NOW - 120, screenTail: "> 1. Yes", target: "llv:0.0", menu: null },
    });
    const state = deriveOrchestratorPanelState({ ...seated, file: waiting, surface: "live-root" });
    expect(state).toMatchObject({ liveness: "stalled" });
    expect(badgeOf(state)).toBe("needs-you");
  });

  test("the attention read follows the queue: stalled turns owe nothing", () => {
    const abandoned = file({ activity: "stalled", proc: "done", mtime: NOW - 60 });
    expect(deriveOrchestratorPanelState({ ...seated, file: abandoned, surface: "live-root" })).toMatchObject({ attention: null });
    const held = file({ activity: "stalled", proc: "running", mtime: NOW - 60 });
    expect(deriveOrchestratorPanelState({ ...seated, file: held, surface: "live-root" })).toMatchObject({ attention: null });
  });
});

/* docs/design/ghost-seat.md §5: a seat's deputies leave the bands and the
   phone's rows with the seat. */
test("the seat refs carry every deputy the record names, and the phone hides their transcripts", () => {
  const status = {
    seat: null,
    pending: null,
    exists: true,
    viewerMcpRegistered: false,
    previous: [],
    all: {
      conversationIds: ["conversation_seat"],
      paths: ["/t/seat.jsonl"],
      previous: { conversationIds: [], paths: [] },
      deputies: { conversationIds: ["conversation_ghost"], paths: ["/t/ghost.jsonl"] },
    },
  } as unknown as OrchestratorSeatStatus;
  expect(seatRefsOf(status)?.deputies).toEqual({ conversationIds: ["conversation_ghost"], paths: ["/t/ghost.jsonl"] });
  expect(seatRefsOf(status, true)?.deputies).toBeUndefined();
  expect(seatDeputyPaths(status, [{ path: "/t/ghost-moved.jsonl", conversationId: "conversation_ghost" }, { path: "/t/w.jsonl", conversationId: "conversation_worker" }]).sort())
    .toEqual(["/t/ghost-moved.jsonl", "/t/ghost.jsonl"]);
  expect(seatDeputyPaths(null, [])).toEqual([]);
});

test("the seat's Telegram line says what happened and what to do, once, in the interface language", () => {
  for (const lang of ["en", "uk"] as const) {
    const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(lang, key, params);
    const signIn = telegramActionLine(t, "sign_in")!;
    const check = telegramActionLine(t, "check")!;
    expect(signIn).toBe(translate(lang, "orchPanel.telegramSignIn"));
    expect(check).toBe(translate(lang, "orchPanel.telegramCheck"));
    const restart = telegramActionLine(t, "restart")!;
    expect(restart).toBe(translate(lang, "orchPanel.telegramRestart"));
    expect(new Set([signIn, check, restart]).size).toBe(3);
    for (const line of [signIn, check, restart]) {
      expect(line.split("\n")).toHaveLength(1);
      expect(line).not.toMatch(/MCP|connector|launch|grant|mcp__|_to_/i);
    }
    expect(telegramActionLine(t, null)).toBeNull();
    expect(telegramActionLine(t, undefined)).toBeNull();
  }
  expect(translate("uk", "orchPanel.telegramSignIn").replace(/Telegram/g, "")).not.toMatch(/[a-z]{4,}/);
  expect(translate("uk", "orchPanel.telegramCheck").replace(/Telegram/g, "")).not.toMatch(/[a-z]{4,}/);
  expect(translate("uk", "orchPanel.telegramRestart").replace(/Telegram/g, "")).not.toMatch(/[a-z]{4,}/);
});

describe("a designation failure in the operator's words", () => {
  test("the lock's diagnostic, old and new wording, is one cause", () => {
    expect(seatFailureCauseOf("account mutation is busy; held by Codex login commit (pid 9559, age 2 ms); retry shortly")).toBe("store-busy");
    expect(seatFailureCauseOf("the account store stayed busy, so the designation could not be recorded; try again")).toBe("store-busy");
  });

  test("the safe store sentence is localized when direct or wrapped", () => {
    const message = "The account store is temporarily busy; try again shortly.";
    for (const error of [message, `the accepted launch failed before its conversation became readable: ${message}`]) {
      expect(seatFailureCauseOf(error)).toBe("store-busy");
      expect(seatFailureCopy(error, "same")).toEqual({ text: "orchPanel.failureStoreBusy", hint: "orchPanel.failureRetrySameHint" });
    }
  });

  test("a launch that timed out or found no runtime host is named, wherever the layer put the words", () => {
    expect(seatFailureCauseOf("structured spawn transport failed: runtime host request timed out")).toBe("launch-timeout");
    expect(seatFailureCauseOf("the accepted launch failed before its conversation became readable: structured spawn transport failed: runtime host timed out")).toBe("launch-timeout");
    expect(seatFailureCauseOf("structured spawn runtime host is unavailable")).toBe("host-unavailable");
  });

  test("anything else keeps its recorded text", () => {
    expect(seatFailureCauseOf("mandate is required")).toBeNull();
    expect(seatFailureCopy("mandate is required", "fresh")).toBeNull();
  });

  test("a busy store whose outcome is unknown promises the replay; a recorded one only asks for a retry", () => {
    const busy = "account mutation is busy; held by Codex login commit (pid 9559, age 2 ms); retry shortly";
    expect(seatFailureCopy(busy, "same")).toEqual({ text: "orchPanel.failureStoreBusy", hint: "orchPanel.failureRetrySameHint" });
    expect(seatFailureCopy(busy, "fresh")).toEqual({ text: "orchPanel.failureStoreBusy", hint: "orchPanel.failureRetryHint" });
  });

  test("a launch that failed after the reply was lost derives one error state with a fresh retry, never «creating»", () => {
    const state = deriveOrchestratorPanelState({
      status: parseSeatStatus({
        seat: null,
        pending: null,
        exists: true,
        lastFailure: {
          error: "structured spawn transport failed: runtime host request timed out",
          clientRequestId: "req-aaaaaaaa",
          seatEpoch: 5,
          designatedAt: "2026-10-05T09:00:00.000Z",
          terminalizedAt: "2026-10-05T09:01:18.000Z",
        },
      }),
      statusFailed: false,
      submitting: false,
      submitFailure: null,
      file: null,
      surface: null,
    });
    expect(state).toMatchObject({ kind: "intent-error", retry: "fresh" });
  });
});

test("panel fallback uses raw usage at 49/50/51 percent and never gives Codex a threshold", () => {
  for (const engine of ["claude", "codex"] as const) for (const capacity of [200_000, 1_000_000]) for (const percent of [49, 50, 51]) {
    const state = deriveOrchestratorPanelState({
      ...base, status: status({ seat: seat() }), file: file({ engine, model: "opus[1m]",
        ctx: { usedTokens: capacity * percent / 100, windowTokens: capacity, pct: percent, source: "runtime", confidence: "exact", observedAt: "" } }),
      surface: "live-root",
    });
    expect(state.kind).toBe("live");
    if (state.kind === "live") expect(state.rotation?.level ?? "none").toBe(engine === "claude" && percent >= 50 ? "strongly_recommend" : "none");
  }
});

test("panel fallback keeps unknown capacity unknown even for a registered model", () => {
  const state = deriveOrchestratorPanelState({ ...base, status: status({ seat: seat() }), surface: "live-root",
    file: file({ ctx: { usedTokens: 900_000, windowTokens: null, pct: null, source: "unknown", confidence: "unknown", observedAt: "" } }),
  });
  expect(state).toMatchObject({ kind: "live", rotation: null });
});
