import { prototypeDeliveryExhausted } from "./deliveryPolicy";
import { prototypeDeliveryPhase } from "./model";
import { canonicalProject } from "@/lib/projects/aliases";
import { linkedContext, runsElsewhere } from "@/lib/links/linked";
import type { BoardTask } from "@/lib/tasks/types";
import type { SeatTickSignalInput } from "@/lib/monitor/types";
import type { OwnerDestinationReason } from "@/lib/externalRelay/ownerDestination";
import type { PrototypeReviewRound } from "./types";

// Configuration refusals cannot improve on resend. Keep their durable receipts
// readable without creating a new wake obligation for every form and post key.
const destinationConfigurationReasons = {
  no_relay: true, paused: true, no_target: true, not_configured: true, invalid_owner: true,
} satisfies Record<OwnerDestinationReason, true>;

export function isTelegramDestinationConfigurationReason(reason: string | undefined): boolean {
  return Object.hasOwn(destinationConfigurationReasons, reason ?? "");
}

/** Failure obligations join the seat's existing wake agenda as durable items. */
export function telegramPostSignals(project: string, tasks: readonly BoardTask[], seatRounds: readonly PrototypeReviewRound[]): SeatTickSignalInput[] {
  const context = linkedContext();
  const rounds = [...tasks.filter(t => !runsElsewhere(t, context)).flatMap(t => t.prototypeReviews ?? []), ...seatRounds]
    .filter(r => canonicalProject(r.project) === canonicalProject(project));
  return [...rounds.filter(round => round.decision && round.decision.delivery.state !== "sent" && (["failed", "uncertain", "no-orchestrator"].includes(round.decision.delivery.state)
      || (round.decision.delivery.failures ?? 0) > 0 || prototypeDeliveryExhausted(round.decision, Date.now())
      || prototypeDeliveryPhase(round.decision.delivery, Date.now()) === "attention"))
    .map(round => ({ id: `prototype-answer:${round.id}:${round.decision!.delivery.clientMessageId}`, actionable: true,
      label: `Saved operator answer needs delivery verification; reviewId ${round.id}${round.taskId ? `; taskId ${round.taskId}` : ""}. The operator already answered. Verify operation ${round.decision!.delivery.operationId ?? "not admitted"} before acting; never resend an uncertain execution. Read read_prototype_review${round.taskId ? ` with taskId ${round.taskId}` : " without taskId"} for the full record. Saved answer follows:\n${round.decision!.delivery.text}` })), ...rounds
    .filter(r => canonicalProject(r.project) === canonicalProject(project) && r.telegramPost && ["failed", "uncertain"].includes(r.telegramPost.state)
      && !isTelegramDestinationConfigurationReason(r.telegramPost.reason))
    .map(r => ({ id: `prototype-telegram:${r.id}:${r.telegramPost!.key}`, actionable: true,
      label: `Prototype Telegram post ${r.telegramPost!.state}: ${r.telegramPost!.reason ?? "unavailable"}; reviewId ${r.id}. Read the review and resend with resend_prototype_review_telegram and a fresh clientRequestId.` })),
    ...rounds.filter(r => r.telegramPolls?.questions.some(q => q.state === "failed" || q.state === "uncertain"))
      .map(r => ({ id: `prototype-telegram-polls:${r.id}:${r.telegramPolls!.key}`, actionable: true,
        label: `Prototype Telegram polls incomplete: ${r.telegramPolls!.questions.filter(q => q.reason).map(q => `${q.questionId}: ${q.reason}`).join(", ")}; reviewId ${r.id}. The form remains published; read the review for poll outcomes.` }))];
}
