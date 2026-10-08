import { createHash } from "node:crypto";
import { operatorLocale, operatorTimeZone } from "@/lib/operator/settings";
import { bridgeReportsEnabled, reportHeaderName } from "@/lib/projects/settings";
import { activeDrain } from "@/lib/selfUpdate/drain";
import { delegatusMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import type { deliverConversationMessage } from "@/lib/delivery";
import type { executeOrchestratorRotation } from "@/lib/orchestrator/seatCommand";
import { AUTO_ROTATE_COOLDOWN_MS, AUTO_ROTATE_NUDGE_AFTER_MS, seatTurnProgressing } from "./seatTick";
import { redactMonitorText } from "./redact";
import type { EffectiveSeatTickSettings } from "./seatTickSettings";
import type { readSeatTickState, writeSeatTickState } from "./seatTickState";
import type { SeatTickSources } from "./seatTickSources";
import type { SeatTickCard, SeatTickCheckInput, SeatTickProjectState, SeatTickSeatInput } from "./types";

export interface SeatContextUsage {
  engine: "claude" | "codex";
  model: string | null;
  tokens: number | null;
  windowTokens: number | null;
  estimated: boolean;
}
export interface AutoRotationAttempt {
  id: string;
  seatEpoch: number;
  conversationId: string;
  startedAt: string;
  tokens: number;
  windowTokens: number;
  thresholdPercent: number;
  state: "pending" | "rotated" | "failed" | "superseded";
  successorConversationId?: string;
  error?: string;
  told: { report: boolean; card: boolean };
}
export interface SeatAutoRotationState {
  overSince?: { seatEpoch: number; at: string };
  nudged?: { seatEpoch: number; at: string };
  lastAttempt?: AutoRotationAttempt;
  failureTold?: { seatEpoch: number; id: string; resolved: boolean };
}
export interface SeatAutoRotationPorts { rotate?: typeof executeOrchestratorRotation }

/** Old rows have no field. Refuse malformed attempts rather than invent a clock. */
export function normalizeSeatAutoRotation(value: unknown): SeatAutoRotationState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<SeatAutoRotationState>;
  const epochTime = (v: SeatAutoRotationState["overSince"]) => v && Number.isSafeInteger(v.seatEpoch)
    && typeof v.at === "string" && Number.isFinite(Date.parse(v.at)) ? { seatEpoch: v.seatEpoch, at: v.at } : undefined;
  const a = raw.lastAttempt;
  const lastAttempt = a && typeof a.id === "string" && a.id.length <= 600 && typeof a.conversationId === "string"
    && Number.isSafeInteger(a.seatEpoch) && typeof a.startedAt === "string" && Number.isFinite(Date.parse(a.startedAt))
    && Number.isFinite(a.tokens) && a.tokens >= 0 && Number.isFinite(a.windowTokens) && a.windowTokens > 0
    && Number.isInteger(a.thresholdPercent) && a.thresholdPercent >= 50 && a.thresholdPercent <= 90
    && ["pending", "rotated", "failed", "superseded"].includes(a.state)
    ? { id: a.id, seatEpoch: a.seatEpoch, conversationId: a.conversationId, startedAt: a.startedAt,
      tokens: a.tokens, windowTokens: a.windowTokens, thresholdPercent: a.thresholdPercent, state: a.state,
      ...(typeof a.successorConversationId === "string" ? { successorConversationId: a.successorConversationId } : {}),
      ...(typeof a.error === "string" ? { error: redactMonitorText(a.error).slice(0, 500) } : {}),
      told: { report: a.told?.report === true, card: a.told?.card === true } } : undefined;
  const f = raw.failureTold;
  return { overSince: epochTime(raw.overSince), nudged: epochTime(raw.nudged), lastAttempt,
    ...(f && Number.isSafeInteger(f.seatEpoch) && typeof f.id === "string" && typeof f.resolved === "boolean"
      ? { failureTold: { seatEpoch: f.seatEpoch, id: f.id, resolved: f.resolved } } : {}) };
}

export function seatAutoRotationKey(id: string): string {
  return `seat-autorotate-${createHash("sha256").update(id).digest("hex")}`;
}

type AutoRotationDecision = { kind: "none" | "wait" | "nudge" | "rotate"; detail: string | null; next: SeatAutoRotationState | undefined };

/** Only the controller's observations enter this decision; no store, clock or transport. */
export function autoRotationStep(input: {
  settings: EffectiveSeatTickSettings;
  seat: SeatTickSeatInput | null;
  pendingSeat: boolean;
  state: SeatTickProjectState;
  usage: SeatContextUsage | null;
  now: number;
  drainHeld: boolean;
  authIncidentOpen: boolean;
}): AutoRotationDecision {
  const { settings, seat, usage, now } = input;
  let next = input.state.autoRotation;
  const answer = (kind: AutoRotationDecision["kind"], detail: string | null): AutoRotationDecision => ({ kind, detail, next });
  if (settings.autoRotate?.enabled !== true) return answer("none", null);
  if (!seat || seat.path === null || input.pendingSeat) return answer("wait", "a rotation is already pending or the seat is not readable");
  if (input.authIncidentOpen) return answer("wait", "authentication recovery owns this seat");
  if (!usage?.windowTokens || !Number.isFinite(usage.windowTokens)) return answer("none", `no context window is known for ${usage?.engine ?? "unknown"} ${usage?.model ?? "unknown"}`);
  if (usage.estimated || usage.tokens === null || !Number.isFinite(usage.tokens)) return answer("wait", "usage is an estimate; waiting for a provider-reported figure");
  if (usage.tokens < usage.windowTokens * settings.autoRotate.thresholdPercent / 100) {
    next = next ? { ...next, overSince: undefined, nudged: undefined } : next;
    return answer("none", null);
  }
  if (next?.overSince?.seatEpoch !== seat.seatEpoch) next = { ...next, overSince: { seatEpoch: seat.seatEpoch, at: new Date(now).toISOString() } };
  const attempt = next?.lastAttempt;
  if (attempt && Date.parse(attempt.startedAt) + AUTO_ROTATE_COOLDOWN_MS > now) return answer("wait", `cooldown until ${new Date(Date.parse(attempt.startedAt) + AUTO_ROTATE_COOLDOWN_MS).toISOString()}`);
  if (input.drainHeld) return answer("wait", "held for the automatic update");
  const progressing = seatTurnProgressing(seat);
  const settled = seat.turn === "idle" || seat.turn === "terminal" || (seat.turn === "busy" && seat.activity !== null && !progressing);
  if (settled && input.state.outstandingWake?.conversationId !== seat.conversationId) return answer("rotate", "context threshold reached at an idle point");
  if (progressing && settings.enabled && next?.nudged?.seatEpoch !== seat.seatEpoch
    && now - Date.parse(next!.overSince!.at) >= AUTO_ROTATE_NUDGE_AFTER_MS) {
    next = { ...next, nudged: { seatEpoch: seat.seatEpoch, at: new Date(now).toISOString() } };
    return answer("nudge", "seat is mid-turn; asking it to finish and hand off");
  }
  return answer("wait", progressing ? "seat is mid-turn" : "turn state is unknown or a wake is in flight");
}

/** Persist intent before effects. The normal rotation command owns handoff and authority. */
export async function runSeatAutoRotation(
  input: SeatTickCheckInput, sources: SeatTickSources,
  readState: typeof readSeatTickState, writeState: typeof writeSeatTickState,
  ensureCard: (project: string, card: SeatTickCard, at: string) => boolean,
  deliver: typeof deliverConversationMessage, ports: SeatAutoRotationPorts,
): Promise<string | null> {
  let auto = input.state.autoRotation;
  const at = new Date(input.now).toISOString();
  const persist = () => {
    input.state = { ...input.state, autoRotation: auto };
    writeState(input.project, input.state);
    input.state = { ...input.state, accounting: readState(input.project).accounting };
  };
  const card = (id: string, detail: string, state: "open" | "resolved") => {
    try { return ensureCard(input.project, { ref: "seat-auto-rotation", kind: "auto-rotation", instance: id, detail, state }, at); }
    catch (error) { console.error("[seat auto-rotation] card write failed", error instanceof Error ? error.name : "unknown"); return false; }
  };
  const closeFailure = () => {
    const failure = auto?.failureTold;
    if (failure && !failure.resolved && card(failure.id, "", "resolved")) { auto = { ...auto, failureTold: { ...failure, resolved: true } }; persist(); }
  };
  if (!input.settings.autoRotate?.enabled) { closeFailure(); return null; }
  let current = sources.seatFor(input.project).active;
  if (auto?.failureTold && auto.failureTold.seatEpoch !== current?.seatEpoch) closeFailure();
  const attempt = auto?.lastAttempt;
  // A restored predecessor proves the accepted successor failed even when
  // bounded seat history no longer contains that launch's diagnostic.
  if ((attempt?.state === "pending" || attempt?.state === "rotated") && current?.conversationId === attempt.conversationId && current.seatEpoch !== attempt.seatEpoch) {
    attempt.state = "failed";
    attempt.error = sources.seatFor(input.project).history?.find(row => row.seat.intent.clientRequestId === seatAutoRotationKey(attempt.id))?.seat.intent.error ?? "successor launch failed; the predecessor was restored";
    attempt.told = { report: false, card: false }; persist();
  } else if (attempt?.state === "pending" && current?.intent.clientRequestId === seatAutoRotationKey(attempt.id) && current.seatEpoch !== attempt.seatEpoch) {
    // Recover a lost result write from the seat's accepted idempotency key.
    attempt.state = "rotated"; attempt.successorConversationId = current.conversationId ?? undefined; persist();
  } else if (attempt?.state === "pending" && current?.seatEpoch !== attempt.seatEpoch) {
    attempt.state = "superseded"; persist();
  }
  const tell = async (): Promise<boolean> => {
    const a = auto?.lastAttempt;
    if (!a || (a.state !== "rotated" && a.state !== "failed")) return true;
    if (a.state === "failed" && auto?.failureTold?.seatEpoch === a.seatEpoch && auto.failureTold.id !== a.id) return true;
    const locale = operatorLocale() === "en" ? "en" : "uk";
    const percent = Math.round(a.tokens / a.windowTokens * 100);
    const name = reportHeaderName(input.project, locale);
    const usage = `${percent}% (${a.tokens.toLocaleString(locale)} / ${a.windowTokens.toLocaleString(locale)})`;
    const retry = new Date(Date.parse(a.startedAt) + AUTO_ROTATE_COOLDOWN_MS).toISOString();
    const detail = a.state === "rotated"
      ? locale === "en" ? `Orchestrator for “${name}” automatically rotated at the context threshold: ${usage} tokens, provider-reported; threshold ${a.thresholdPercent}%. Previous: ${a.conversationId}. New: ${a.successorConversationId ?? "pending"}.`
        : `Оркестратора проєкту «${name}» автоматично ротовано за порогом контексту: ${usage} токенів, за даними провайдера; поріг ${a.thresholdPercent}%. Попередній: ${a.conversationId}. Новий: ${a.successorConversationId ?? "очікується"}.`
      : locale === "en" ? `Automatic rotation for “${name}” failed: ${a.error}. Context ${usage}, threshold ${a.thresholdPercent}%. Current orchestrator ${a.conversationId} stays in charge. Next attempt after ${retry}.`
        : `Автоматична ротація оркестратора проєкту «${name}» не вдалася: ${a.error}. Контекст ${usage}, поріг ${a.thresholdPercent}%. Поточний оркестратор ${a.conversationId} лишається на місці. Наступна спроба після ${retry}.`;
    if (!a.told.report) {
      try {
        if (bridgeReportsEnabled(input.project)) {
          const { renderReport, renderPlain } = await import("@/lib/bridge/reportRender");
          const { recordManagerReport } = await import("@/lib/bridge/service");
          const { findBridgeReport, scopedReportId } = await import("@/lib/bridge/store");
          const reportClass = a.state === "rotated" ? "status" : "failed";
          const rendered = renderReport({ class: reportClass, name: "Delegatus", at: new Date(a.startedAt), locale, timeZone: operatorTimeZone(), summary: locale === "en" ? "Automatic orchestrator rotation" : "Автоматична ротація оркестратора" });
          // A provisional success can later roll back. Retain that accepted
          // status and append its one failure under a separate stable receipt.
          const previous = findBridgeReport(scopedReportId(input.project, a.id));
          const reportKey = reportClass === "failed" && previous?.class === "status" ? `${a.id}:failed` : a.id;
          const recorded = recordManagerReport({ key: reportKey, origin: { kind: "agent", role: "seat-tick", conversationId: null }, project: input.project,
            targetSeatConversationId: a.conversationId, class: reportClass, at,
            // This controller notice stays in the local bridge. The public
            // report renderer drops context figures and conversation ids;
            // its header precedes the operator's required local audit sentence.
            body: `${renderPlain(rendered.cut)}\n${detail}` }) ?? findBridgeReport(scopedReportId(input.project, reportKey));
          if (!recorded) return false;
        }
        a.told.report = true; persist();
      } catch (error) { console.error("[seat auto-rotation] report write failed", error instanceof Error ? error.name : "unknown"); }
    }
    if (!a.told.card && card(a.id, detail, "open") && (a.state === "failed" || card(a.id, detail, "resolved"))) { a.told.card = true; persist(); }
    if (a.state === "failed" && a.told.report && a.told.card && auto?.failureTold?.id !== a.id) {
      auto = { ...auto, failureTold: { seatEpoch: current?.conversationId === a.conversationId ? current.seatEpoch : a.seatEpoch, id: a.id, resolved: false } }; persist();
    }
    if (a.state === "rotated") closeFailure();
    return a.told.report && a.told.card;
  };
  // Complete unfinished notices before replacing their attempt with a retry.
  if (!await tell()) return "auto-rotation: operator notice write is pending";
  const usage = input.seat ? sources.seatContextUsage?.(input.seat.conversationId) ?? null : null;
  const decision = autoRotationStep({ settings: input.settings, seat: input.seat,
    pendingSeat: !!sources.seatFor(input.project).pending, state: input.state, usage, now: input.now,
    drainHeld: !!activeDrain(), authIncidentOpen: !!input.state.authIncident && input.state.authIncident.recoveredThrough === undefined });
  if (JSON.stringify(auto) !== JSON.stringify(decision.next)) { auto = decision.next; persist(); }
  if (decision.kind === "nudge" && input.seat && usage) {
    await deliver({ conversationId: input.seat.conversationId, path: input.seat.path ?? "", pid: null,
      clientMessageId: `seat-autorotate-nudge-${createHash("sha256").update(`${input.project}:${input.seat.seatEpoch}`).digest("hex")}`,
      text: `Delegatus auto-rotation: your context is at ${Math.round(usage.tokens! / usage.windowTokens! * 100)}% of the window (provider-reported), over this project's auto-rotation threshold of ${input.settings.autoRotate!.thresholdPercent}%. Delegatus rotates this seat through the normal rotation at your next idle point. Finish or park the current step, record what your successor must know in your monitor note (seat_tick_settings appendLine), and end your turn. If you prefer to write the handoff yourself, call rotate_orchestrator with handoffNotes as your last action. Start no new long work.`,
      images: [], origin: delegatusMessageOrigin("seat-tick", input.project), policy: "steer-or-queue" });
  }
  const pending = auto?.lastAttempt?.state === "pending" ? auto.lastAttempt : undefined;
  const pendingSeat = sources.seatFor(input.project).pending;
  // A held admission replays its key once the same safe point is available;
  // it consumes no second attempt, even inside the persisted cooldown.
  const replaySafe = pending && input.seat?.seatEpoch === pending.seatEpoch && input.seat.path !== null
    && (!pendingSeat || pendingSeat.intent.clientRequestId === seatAutoRotationKey(pending.id)) && !activeDrain()
    && (!input.state.authIncident || input.state.authIncident.recoveredThrough !== undefined)
    && (input.seat.turn === "idle" || input.seat.turn === "terminal" || (input.seat.turn === "busy" && input.seat.activity !== null && !seatTurnProgressing(input.seat)))
    && input.state.outstandingWake?.conversationId !== input.seat.conversationId;
  if ((decision.kind === "rotate" || replaySafe) && input.seat && usage) {
    const a: AutoRotationAttempt = pending ?? {
      id: `seat-autorotate:${input.project}:${input.seat.seatEpoch}:${at}`, seatEpoch: input.seat.seatEpoch,
      conversationId: input.seat.conversationId, startedAt: at, tokens: usage.tokens!, windowTokens: usage.windowTokens!,
      thresholdPercent: input.settings.autoRotate!.thresholdPercent, state: "pending", told: { report: false, card: false },
    };
    auto = { ...auto, lastAttempt: a }; persist();
    try {
      const rotate = ports.rotate ?? (await import("@/lib/orchestrator/seatCommand")).executeOrchestratorRotation;
      const result = await rotate({ project: input.project, clientRequestId: seatAutoRotationKey(a.id), expectedIncumbentSeatEpoch: a.seatEpoch,
        handoffNotes: `Automatic rotation at the context threshold: ${a.tokens} of ${a.windowTokens} tokens (${Math.round(a.tokens / a.windowTokens * 100)}%, provider-reported); threshold ${a.thresholdPercent}%.` }, undefined, null, { autonomous: true });
      current = sources.seatFor(input.project).active;
      if (result.body.code === "launch_held_for_update" || result.body.code === "AUTO_UPDATE_DRAIN") return "auto-rotation: held for the automatic update";
      if (current?.intent.clientRequestId === seatAutoRotationKey(a.id) && current.seatEpoch !== a.seatEpoch && result.status >= 200 && result.status < 300 && result.body.ok !== false) {
        a.state = "rotated"; a.successorConversationId = current.conversationId ?? undefined;
      } else if (result.body.code === "incumbent_changed" || current?.seatEpoch !== a.seatEpoch) a.state = "superseded";
      else { a.state = "failed"; a.error = redactMonitorText(String(result.body.error ?? "rotation failed")).slice(0, 500); }
    } catch (error) { a.state = "failed"; a.error = redactMonitorText(error instanceof Error ? error.message : "rotation failed").slice(0, 500); }
    persist(); await tell();
    return `auto-rotation: ${a.state} ${a.id}${a.error ? `: ${a.error}` : ""}${a.successorConversationId ? ` → ${a.successorConversationId}` : ""}`;
  }
  return decision.detail ? `auto-rotation: ${decision.detail}` : null;
}
