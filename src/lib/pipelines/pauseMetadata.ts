import { z } from "zod";
import type { PauseResumeActor } from "@/lib/pauseResumeActor";

export const pipelineResumeConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("date"), at: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal("account-usage"), engine: z.enum(["claude", "codex", "copilot"]),
    accountId: z.string().trim().min(1).max(200), window: z.enum(["session", "weekly"]),
    belowPercent: z.number().min(0).max(100) }).strict(),
]);

export const pipelinePauseInputSchema = z.object({
  reason: z.string().trim().min(1).max(2000).default("No pause reason supplied"),
  resumeCondition: pipelineResumeConditionSchema.optional(),
});

export type PipelineResumeCondition = z.infer<typeof pipelineResumeConditionSchema>;
export type PipelinePause = z.infer<typeof pipelinePauseInputSchema> & { actor?: PauseResumeActor | null };
