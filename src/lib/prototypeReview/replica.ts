import { z } from "zod";
import type { PrototypeReviewReplica } from "./types";

const id = z.string().regex(/^pr_[0-9a-f]{32}$/);
const instant = z.string().datetime({ offset: true });
const state = z.enum(["pending", "sent", "failed", "uncertain", "no-orchestrator"]);
const chosen = z.array(z.number().int().min(1).max(9)).min(1).max(9);
const media = z.object({ id: z.string().regex(/^[0-9a-f]{64}$/), mime: z.enum(["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"]),
  bytes: z.number().int().min(1).max(64 * 1024 * 1024), available: z.literal(false), url: z.null() }).strict();
const caption = z.string().max(200);
const schema = z.object({
  historyTruncated: z.literal(true).optional(),
  summary: z.object({ latestReviewId: id, waitingReviewId: id.nullable(), title: z.string().min(1).max(120), rounds: z.number().int().positive(), createdAt: instant,
    decision: z.object({ chosen: z.array(z.object({ number: z.number().int().min(1).max(9), name: z.string().min(1).max(60) }).strict()).min(1).max(9),
      comment: z.string().max(20000), at: instant, delivery: state }).strict().optional() }).strict(),
  rounds: z.array(z.object({ id, title: z.string().min(1).max(120), taskId: z.string().min(1).max(200), project: z.string().min(1).max(200), createdAt: instant,
    source: z.object({ conversationId: z.string().max(200).nullable(), pipelineId: z.string().max(200).optional(), stageId: z.string().max(200).optional(), attempt: z.number().int().positive().optional() }).strict(),
    mediaRemovedAt: instant.optional(),
    variants: z.array(z.object({ number: z.number().int().min(1).max(9), name: z.string().min(1).max(60), description: z.string().max(300),
      frames: z.array(z.object({ image: media, original: media.optional(), caption, width: z.number().int().min(240).max(3840).optional(), lang: z.enum(["en", "uk"]).optional() }).strict()).max(240),
      videos: z.array(z.object({ media, caption }).strict()).max(240) }).strict()).min(1).max(9),
    decision: z.object({ chosen, comment: z.string().max(20000), at: instant, delivery: z.object({ state, retryable: z.boolean() }).strict() }).strict().optional(),
  }).strict()).max(1000),
}).strict();

/** Validate the public wire form, including ownership and absent local URLs. */
export function isPrototypeReplica(value: unknown, taskId: string, project: string): value is PrototypeReviewReplica {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return false;
  const replica = parsed.data;
  return (replica.historyTruncated ? replica.summary.rounds >= replica.rounds.length : replica.summary.rounds === replica.rounds.length && replica.summary.latestReviewId === replica.rounds.at(-1)?.id)
    && (replica.historyTruncated || !replica.summary.waitingReviewId || replica.rounds.some(r => r.id === replica.summary.waitingReviewId && !r.decision))
    && new Set(replica.rounds.map(r => r.id)).size === replica.rounds.length
    && replica.rounds.every(round => round.taskId === taskId && round.project === project
      && new Set(round.variants.map(v => v.number)).size === round.variants.length
      && round.variants.reduce((n, v) => n + v.frames.reduce((n, f) => n + (f.original ? 2 : 1), 0) + v.videos.length, 0) <= 240
      && (!round.decision || (new Set(round.decision.chosen).size === round.decision.chosen.length
        && round.decision.chosen.every(n => round.variants.some(v => v.number === n)))));
}
