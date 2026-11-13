import { authorizedManagerSeats } from "@/lib/orchestrator/authority";
import { productionManagerAuthoritySources } from "@/lib/orchestrator/managerAuthoritySources";
import { productionDeputyPrincipal } from "@/lib/orchestrator/deputies";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { bridgeReportsEnabled, effectiveReportTelegram } from "@/lib/projects/settings";
import { RETRYABLE_TELEGRAM_BOT_CODES, type TelegramBotErrorCode } from "@/lib/telegram/bot/contracts";
import { TelegramBotError, telegramBotService } from "@/lib/telegram/bot/service";
import { findBridgeReport } from "./store";

/** These fences run before the bot can claim or send anything. */
export class BridgeReportTelegramAdmissionRefusal extends TelegramBotError {}

/** Recover the original bot receipt across seat succession. All delivery
 * arguments come from the stored report; the request grants no sender identity. */
export async function sendBridgeReportTelegram(reportId: unknown, callerId: string | null, requestId: unknown) {
  const report = typeof reportId === "string" ? findBridgeReport(reportId) : null;
  const project = report?.project ? canonicalOrchestratorProject(report.project) : null;
  const deputy = callerId ? productionDeputyPrincipal(callerId) : null;
  if (!callerId || !project || report?.origin?.kind !== "manager" || !report.origin.conversationId
    || !authorizedManagerSeats(productionManagerAuthoritySources()).some(seat => seat.project === project && (seat.conversationId === callerId
      || deputy?.seatConversationId === seat.conversationId && canonicalOrchestratorProject(deputy.project) === project))) {
    throw new BridgeReportTelegramAdmissionRefusal("forbidden", "only the project's current manager may deliver its stored report");
  }
  const copy = report.telegram;
  const destination = bridgeReportsEnabled(project) ? effectiveReportTelegram(project) : null;
  if (!copy || !destination || destination.chat !== copy.chat || destination.topicId !== copy.topicId) {
    throw new BridgeReportTelegramAdmissionRefusal("chat_not_allowed", "the project no longer reports to this destination");
  }
  if (copy.state === "sent") return { messageIds: copy.messageIds ?? [] };
  const key = `bridge-report:${report.id}${copy.attempts ? `:r${copy.attempts}` : ""}`;
  if (requestId !== key || copy.state === "uncertain" || copy.state === "failed"
    && !RETRYABLE_TELEGRAM_BOT_CODES.has(copy.code as TelegramBotErrorCode)) {
    throw new TelegramBotError("send_uncertain", "the stored report does not admit this delivery attempt");
  }
  return telegramBotService().send({
    conversationId: report.origin.via?.deputy ?? report.origin.conversationId,
    clientRequestId: key,
    chat: copy.chat,
    text: copy.html,
    topicId: copy.topicId,
    format: "html",
    silent: true,
  });
}
