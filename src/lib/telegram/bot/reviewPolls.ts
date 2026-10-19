import { shortenHashesInText } from "@/lib/shortIds";
import path from "node:path";
import { waitForStateLock } from "@/lib/state/lockWait";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { prototypeRoot } from "@/lib/prototypeReview/store";
import { findSeatRound, mutateSeatRound } from "@/lib/prototypeReview/seatRounds";
import { mutateTaskTelegramPolls, taskFeedSource } from "@/lib/tasks/store";
import { prototypeReference } from "@/lib/prototypeReview/telegramAnswer";
import type { PrototypeQuestion, PrototypeReviewRound, PrototypeTelegramPoll } from "@/lib/prototypeReview/types";
import type { BotCallResult, BotTransport } from "./transport";

export interface ReviewPollInput { id: string; taskId: string | null; questions: PrototypeQuestion[] }
type Sent = { message_id: number; date: number };
interface PollJob {
  review: ReviewPollInput; key: string; chatId: string; messageId: number;
  transport: BotTransport; authorize(): void;
  publish(message: Sent, text: string): void | Promise<void>;
}

const shorten = (value: string, limit: number) => {
  const points = Array.from(value.replace(/\s+/g, " ").trim());
  return points.length <= limit ? points.join("") : points.slice(0, limit - 1).join("") + "…";
};

/** Bot API 10.3: 300 question characters, 100 per option, 1–12 options.
 * Full wording stays in the form; letters remain stable after shortening. */
export function reviewPollPayload(review: Pick<ReviewPollInput, "id">, question: PrototypeQuestion, index: number) {
  if (!question.text.trim() || question.options.length < 1 || question.options.length > 12
    || question.options.some(option => !option.label.trim())) return null;
  const prefix = `${index + 1}. `;
  const suffix = ` · ${prototypeReference(review)}${question.other ? " · Свій варіант — текстовим reply" : ""}`;
  return {
    question: prefix + shorten(question.text, 300 - prefix.length - suffix.length) + suffix,
    options: question.options.map((option, i) => {
      const label = `${index + 1}${String.fromCharCode(97 + i)}) `;
      const mark = option.recommended ? " ✅" : "";
      return { text: label + shorten(shortenHashesInText(option.label), 100 - label.length - mark.length) + mark };
    }),
    type: "regular", is_anonymous: true, allows_multiple_answers: question.multiple === true,
    shuffle_options: false,
  };
}

function failure(result: Exclude<BotCallResult, { ok: true }>): string {
  if (result.kind === "network_failed" || result.kind === "timed_out") return "send_uncertain";
  if (result.kind === "unreachable") return "network_failed";
  if (result.status === 429) return "rate_limited";
  if (result.status === 403) return "forbidden";
  if (result.status === 400) return "bad_request";
  if (result.status === 401 || result.status === 404) return "token_rejected";
  return "telegram_failed";
}
const state = <T>(work: () => T) => waitForStateLock("telegram.review-polls.state", work, { waitMs: 5000 });
const findRound = (review: Pick<ReviewPollInput, "id" | "taskId">) => review.taskId === null ? findSeatRound(review.id)
  : taskFeedSource()?.get(review.taskId)?.prototypeReviews?.find(round => round.id === review.id);
function mutatePolls(review: Pick<ReviewPollInput, "id" | "taskId">, change: (held: PrototypeReviewRound["telegramPolls"]) => PrototypeReviewRound["telegramPolls"]) {
  if (review.taskId !== null) mutateTaskTelegramPolls(review.taskId, review.id, change);
  else mutateSeatRound(review.id, round => { round.telegramPolls = change(round.telegramPolls); });
}

/** Only a persisted poll schedule for this publication can need recovery.
 * Older sent forms have no schedule, so absence does not imply interruption. */
export function reviewPollsNeedRecovery(round: PrototypeReviewRound): boolean {
  if (round.telegramPost?.state !== "sent" || !round.questions?.length || round.questions.length > 7) return false;
  if (round.telegramPolls?.key !== round.telegramPost.key) return false;
  const polls = round.telegramPolls.questions;
  return round.questions.some(question => {
    const poll = polls.find(p => p.questionId === question.id);
    return !poll || poll.state === "pending";
  });
}

/** Shares the sender's lock so an active send settles before reconciliation.
 * The delivery sweep admits at most 16 rounds, each under the existing finite
 * file-lock wait and five-second async state admission. No API call is made. */
export async function reconcileReviewPolls(review: Pick<ReviewPollInput, "id" | "taskId">): Promise<void> {
  await withViewerOperation("telegram.review-polls", () =>
    withFileTransaction(path.join(prototypeRoot(), `${review.id}.polls.lock`), "Telegram review polls are busy", () => state(() => {
      const round = findRound(review);
      if (!round || !reviewPollsNeedRecovery(round)) return;
      const key = round.telegramPost!.key;
      const questions = round.questions!;
      mutatePolls(review, held => ({ key, questions: questions.map((question, index) => {
        const previous = held?.key === key ? held.questions.find(p => p.questionId === question.id) : undefined;
        if (previous && previous.state !== "pending") return previous;
        if (previous) return { questionId: question.id, state: "uncertain", reason: "interrupted" };
        return reviewPollPayload(review, question, index)
          ? { questionId: question.id, state: "failed", reason: "interrupted_before_send" }
          : { questionId: question.id, state: "text-only", reason: "poll_limits" };
      }) }));
    })));
}

/** One owner (the shared bot service), at most 16 retained jobs, serial sends.
 * Each form sends at most seven polls, each with a five-second deadline.
 * Pending sends surviving interruption are uncertain and never reissued. */
export class ReviewPollQueue {
  private jobs = new Map<string, Promise<void>>();
  private tail: Promise<void> = Promise.resolve();

  owns(reviewId: string, key: string): boolean { return this.jobs.has(`${reviewId}:${key}`); }

  enqueue(job: PollJob): void {
    if (!job.review.questions.length || job.review.questions.length > 7) return;
    const identity = `${job.review.id}:${job.key}`;
    if (this.jobs.has(identity)) return;
    if (this.jobs.size >= 16) {
      void this.recordOverflow(job).catch(() => console.warn("Telegram review polls unavailable", "storage_unavailable"));
      return;
    }
    // Persist the schedule at admission, including jobs waiting behind another
    // form. Publication does not await this state write or any poll sends.
    const scheduled = withViewerOperation("telegram.review-polls", () => state(() => {
      if (!findRound(job.review)) return;
      mutatePolls(job.review, held => held?.key === job.key ? held : { key: job.key, questions: [] });
    }));
    const next = Promise.allSettled([this.tail, scheduled]).then(([, schedule]) => {
      if (schedule.status === "rejected") throw schedule.reason;
      return new Promise<void>(resolve => setImmediate(resolve));
    })
      .then(() => withViewerOperation("telegram.review-polls", () => this.post(job)))
      .catch(() => { console.warn("Telegram review polls unavailable", "storage_unavailable"); })
      .finally(() => { this.jobs.delete(identity); });
    this.jobs.set(identity, next);
    this.tail = next;
  }

  /** Tests and owned shutdowns can await all work admitted so far. */
  async idle(): Promise<void> { await this.tail; }

  private async recordOverflow(job: PollJob): Promise<void> {
    await withViewerOperation("telegram.review-polls", () => state(() => {
      if (!findRound(job.review)) return;
      mutatePolls(job.review, held => held?.key === job.key ? held
        : { key: job.key, questions: job.review.questions.map(q => ({ questionId: q.id, state: "failed", reason: "queue_full" })) });
    }));
    console.warn("Telegram review polls unavailable", "queue_full");
  }

  private async post(job: PollJob): Promise<void> {
    const { review } = job;
    await withFileTransaction(path.join(prototypeRoot(), `${review.id}.polls.lock`), "Telegram review polls are busy", async () => {
      const round = await state(() => findRound(review));
      if (!round) return;
      const held = round.telegramPolls?.key === job.key ? round.telegramPolls.questions : [];
      for (const [index, question] of review.questions.entries()) {
        const previous = held.find(q => q.questionId === question.id);
        if (previous && previous.state !== "pending") continue;
        const save = (poll: PrototypeTelegramPoll) => state(() => mutatePolls(review, current => ({ key: job.key,
          questions: [...(current?.key === job.key ? current.questions.filter(q => q.questionId !== question.id) : []), poll] })));
        if (previous) { await save({ questionId: question.id, state: "uncertain", reason: "interrupted" }); continue; }
        const payload = reviewPollPayload(review, question, index);
        if (!payload) { await save({ questionId: question.id, state: "text-only", reason: "poll_limits" }); continue; }
        await save({ questionId: question.id, state: "pending" });
        let outcome: PrototypeTelegramPoll;
        try {
          job.authorize();
          const result = await job.transport.call<Sent>("sendPoll", {
            chat_id: Number(job.chatId), reply_parameters: { message_id: job.messageId }, ...payload,
          }, { signal: AbortSignal.timeout(5000), timeoutMs: 5000 });
          if (!result.ok) {
            const reason = failure(result);
            outcome = { questionId: question.id, state: reason === "send_uncertain" ? "uncertain" : "failed", reason };
          } else if (!result.result || !Number.isSafeInteger(result.result.message_id) || result.result.message_id <= 0 || !Number.isSafeInteger(result.result.date)) {
            outcome = { questionId: question.id, state: "uncertain", reason: "send_uncertain" };
          } else {
            outcome = { questionId: question.id, state: "sent", messageId: result.result.message_id };
            await job.publish(result.result, [payload.question, ...payload.options.map(o => o.text), "Рішення записує лише текстовий reply власника."].join("\n"));
          }
        } catch {
          outcome = { questionId: question.id, state: "uncertain", reason: "send_unconfirmed" };
        }
        await save(outcome);
        if (outcome.reason) console.warn("Telegram review poll unavailable", outcome.reason);
      }
    });
  }
}
