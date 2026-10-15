import { canonicalProject } from "@/lib/projects/aliases";
import { runsElsewhere } from "@/lib/links/linked";
import type { BoardTask } from "@/lib/tasks/types";
import type { SeatTickSignalInput } from "@/lib/monitor/types";
import type { PrototypeReviewRound } from "./types";

/** Failure obligations join the seat's existing wake agenda as durable items. */
export function telegramPostSignals(project: string, tasks: readonly BoardTask[], seatRounds: readonly PrototypeReviewRound[]): SeatTickSignalInput[] {
  const rounds = [...tasks.filter(t => !runsElsewhere(t)).flatMap(t => t.prototypeReviews ?? []), ...seatRounds]
    .filter(r => canonicalProject(r.project) === canonicalProject(project));
  return [...rounds
    .filter(r => canonicalProject(r.project) === canonicalProject(project) && r.telegramPost && ["failed", "uncertain"].includes(r.telegramPost.state))
    .map(r => ({ id: `prototype-telegram:${r.id}:${r.telegramPost!.key}`, actionable: true,
      label: `Prototype Telegram post ${r.telegramPost!.state}: ${r.telegramPost!.reason ?? "unavailable"}; reviewId ${r.id}. Read the review and resend with resend_prototype_review_telegram and a fresh clientRequestId.` })),
    ...rounds.filter(r => r.telegramPolls?.questions.some(q => q.state === "failed" || q.state === "uncertain"))
      .map(r => ({ id: `prototype-telegram-polls:${r.id}:${r.telegramPolls!.key}`, actionable: true,
        label: `Prototype Telegram polls incomplete: ${r.telegramPolls!.questions.filter(q => q.reason).map(q => `${q.questionId}: ${q.reason}`).join(", ")}; reviewId ${r.id}. The form remains published; read the review for poll outcomes.` }))];
}
