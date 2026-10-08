import { createHash } from "node:crypto";
import { accountManager } from "@/lib/accounts/manager";
import { allowedAccountIdsForProject } from "@/lib/accounts/projectBindings";
import { operatorLocale, operatorTimeZone } from "@/lib/operator/settings";
import { bridgeReportsEnabled, effectiveReportTelegram, reportHeaderName } from "@/lib/projects/settings";
import { activeDrain } from "@/lib/selfUpdate/drain";
import { seatTurnProgressing } from "./seatTick";
import { openSeatAuthIncident, seatAuthAccounts, seatAuthCredentialStamp, seatAuthIncidentRecovered, seatAuthNotice } from "./seatAuthIncident";
import type { SeatTickCheckInput, SeatTickCard } from "./types";
import type { SeatTickSources } from "./seatTickSources";
import type { readSeatTickState, writeSeatTickState } from "./seatTickState";
import type { executeOrchestratorRotation } from "@/lib/orchestrator/seatCommand";
import type { TelegramBotService } from "@/lib/telegram/bot/service";

export interface SeatAuthRecoveryPorts {
  rotate?: typeof executeOrchestratorRotation;
  telegram?: TelegramBotService["send"];
}

export function seatAuthRotationKey(id: string): string {
  return `seat-auth-${createHash("sha256").update(id).digest("hex")}`;
}

/** Owns no clock: the ordinary seat check drives detection, recovery and telling. */
export async function recoverSeatAuthentication(
  input: SeatTickCheckInput,
  sources: SeatTickSources,
  readState: typeof readSeatTickState,
  writeState: typeof writeSeatTickState,
  ensureCard: (project: string, card: SeatTickCard, at: string) => boolean,
  ports: SeatAuthRecoveryPorts,
): Promise<string | null> {
  let incident = input.state.authIncident;
  const seat = input.seat;
  const at = new Date(input.now).toISOString();
  const persist = () => {
    writeState(input.project, input.state);
    // Accounting writes advance the conditional revision. Continue from the
    // revision just committed before the next phase attempts its own write.
    input.state = { ...input.state, accounting: readState(input.project).accounting };
  };
  const outcome = seat && !seatTurnProgressing(seat) ? await sources.seatTurnOutcome?.(seat.conversationId) ?? null : null;
  const close = () => {
    if (!incident) return;
    if (!ensureCard(input.project, { ref: "seat-auth-failed", kind: "auth-failed", instance: incident.id, state: "resolved", detail: "" }, at)) return;
    input.state = { ...input.state, authIncident: undefined, authRecoveredThrough: incident.lastFailedTs };
    incident = undefined;
  };
  if (incident && incident.seatEpoch !== (seat?.seatEpoch ?? null)) {
    // A rotation can have landed before its caller's next write. Its durable
    // request identity proves ours, so finish telling before closing the row.
    const current = sources.seatFor(input.project).active;
    if (!incident.notice && current?.intent.clientRequestId === seatAuthRotationKey(incident.id)) {
      incident.rotation = { ...incident.rotation, state: "rotated", successorConversationId: current.conversationId ?? undefined };
    } else if (incident.rotation.state !== "rotated" || incident.notice?.card) close();
  } else if (incident && seatAuthIncidentRecovered(incident, seat?.seatEpoch ?? null, outcome,
    seatAuthCredentialStamp(incident.engine, incident.accountId))) {
    close();
  }
  if (!incident && seat && outcome) {
    incident = openSeatAuthIncident(input.project, seat, outcome, input.state.authRecoveredThrough) ?? undefined;
    if (incident) input.state = { ...input.state, authIncident: incident };
  }
  if (!incident) return null;
  if (outcome?.auth && outcome.auth.ts > incident.lastFailedTs) incident.lastFailedTs = outcome.auth.ts;
  if (incident.rotation.state === "pending" || incident.rotation.state === "held") {
    if (activeDrain()) {
      incident.rotation.state = "held";
      return `${incident.id}: held`;
    }
    const current = sources.seatFor(input.project).active;
    if (!current || current.seatEpoch !== incident.seatEpoch) { close(); return null; }
    // Persist identity before any external effect. Failed persistence must
    // prevent the effect; a retry has the original first-failure key.
    persist();
    let choice: ReturnType<typeof accountManager.resolveProjectSpawn> | null = null;
    let choiceFailed = false;
    const refused = (error: unknown) => {
      incident!.rotation = { ...incident!.rotation, state: "refused", error: error instanceof Error ? error.message : "rotation failed" };
    };
    try {
      choice = incident.accountId ? accountManager.resolveProjectSpawn(incident.engine, {
        project: input.project, model: current.model ?? undefined, unavailableIds: [incident.accountId],
      }) : null;
    } catch (error) { refused(error); choiceFailed = true; }
    if (choice?.kind === "available" && choice.account.accountId !== incident.accountId) {
      incident.rotation.toAccountId = choice.account.accountId;
      // Propagate checkpoint errors so a later check can retry persistence.
      persist();
      try {
        const rotate = ports.rotate ?? (await import("@/lib/orchestrator/seatCommand")).executeOrchestratorRotation;
        if (activeDrain()) { incident.rotation.state = "held"; return `${incident.id}: held`; }
        const failedLabel = seatAuthAccounts(incident.engine).find((row) => row.id === incident!.accountId)?.label ?? "?";
        const result = await rotate({
          project: input.project, clientRequestId: seatAuthRotationKey(incident.id),
          expectedIncumbentSeatEpoch: incident.seatEpoch, accountId: choice.account.accountId,
          handoffNotes: `Automatic rotation after authentication failure on ${incident.engine} account ${failedLabel}`,
        }, undefined, null);
        if (result.status === 409 && (result.body.code === "incumbent_changed" || sources.seatFor(input.project).active?.seatEpoch !== incident.seatEpoch)) {
          close(); return null;
        }
        incident.rotation = result.status >= 200 && result.status < 300
          ? { ...incident.rotation, state: "rotated", successorConversationId: sources.seatFor(input.project).active?.conversationId ?? undefined }
          : { ...incident.rotation, state: "refused", error: String(result.body.error ?? "rotation failed") };
      } catch (error) { refused(error); }
    } else if (!choiceFailed) incident.rotation.state = "none-allowed";
    persist();
  }
  if (!incident.notice?.card) {
    const accounts = seatAuthAccounts(incident.engine);
    const allowed = allowedAccountIdsForProject(input.project, incident.engine);
    const locale = operatorLocale() === "en" ? "en" : "uk";
    const notice = seatAuthNotice(incident, new Map(accounts.map((row) => [row.id, row.label])),
      allowed ? accounts.filter((row) => !allowed.includes(row.id)).map((row) => row.id) : [], locale, reportHeaderName(input.project, locale));
    const { renderReport, renderPlain, REPORT_ITEM_MAX_CHARS } = await import("@/lib/bridge/reportRender");
    const { renderTelegram } = await import("@/lib/bridge/telegramReport");
    const { recordManagerReport } = await import("@/lib/bridge/service");
    const { findBridgeReport, scopedReportId, recordBridgeReportTelegram } = await import("@/lib/bridge/store");
    const reportClass = incident.rotation.state === "rotated" ? "status" : "blocked";
    const items = (paragraph: string): string[] => {
      const chunks: string[] = [];
      let chunk = "";
      for (const word of paragraph.split(/\s+/)) {
        if (chunk && chunk.length + word.length + 1 > REPORT_ITEM_MAX_CHARS) { chunks.push(chunk); chunk = ""; }
        chunk += `${chunk ? " " : ""}${word.slice(0, REPORT_ITEM_MAX_CHARS)}`;
      }
      if (chunk) chunks.push(chunk);
      return chunks;
    };
    const rendered = renderReport({ class: reportClass, name: "Delegatus", at: new Date(incident.firstFailedAt), locale,
      timeZone: operatorTimeZone(), summary: notice.summary,
      // The renderer preserves the decision section when it cuts for size.
      // Keep the login action there so a long diagnostic cannot crowd it out.
      sections: { decision: items(notice.action), inProgress: [notice.failure, ...(notice.pool ? [notice.pool] : [])].flatMap(items) } });
    const destination = effectiveReportTelegram(input.project);
    const html = renderTelegram(rendered.cut);
    const report = bridgeReportsEnabled(input.project)
      ? recordManagerReport({ key: incident.id, origin: { kind: "agent", role: "seat-tick", conversationId: null },
        project: input.project, targetSeatConversationId: incident.conversationId, class: reportClass, at,
        body: renderPlain(rendered.cut), ...(destination ? { telegram: { chat: destination.chat, html, ...(destination.topicId ? { topicId: destination.topicId } : {}) } } : {}) })
        ?? findBridgeReport(scopedReportId(input.project, incident.id)) : null;
    let telegram: "sent" | "failed" | "skipped" = "skipped";
    if (destination) {
      try {
        let send = ports.telegram;
        if (!send) {
          const service = (await import("@/lib/telegram/bot/service")).telegramBotService();
          send = service.send.bind(service);
        }
        const sent = await send({ conversationId: null, clientRequestId: incident.id, chat: destination.chat,
          ...(destination.topicId ? { topicId: destination.topicId } : {}), text: html, format: "html", silent: false });
        telegram = "sent";
        if (report) recordBridgeReportTelegram(report.id, { state: "sent", at, messageIds: sent.messageIds });
      } catch (error) {
        telegram = "failed";
        if (report) recordBridgeReportTelegram(report.id, { state: "failed", at, code: error instanceof Error && "code" in error ? String(error.code) : "telegram_failed" });
      }
    }
    // Create then resolve a rotated notice: a resolved write alone creates no
    // card, and would erase the board's only evidence that this happened.
    let card = ensureCard(input.project, { ref: "seat-auth-failed", kind: "auth-failed", instance: incident.id, state: "open", detail: notice.body }, at);
    if (card && incident.rotation.state === "rotated") card = ensureCard(input.project, { ref: "seat-auth-failed", kind: "auth-failed", instance: incident.id, state: "resolved", detail: notice.body }, at);
    incident.notice = { ...(report ? { bridgeSeq: report.seq } : {}), telegram, card };
  }
  return `${incident.id}: ${incident.rotation.state}`;
}
